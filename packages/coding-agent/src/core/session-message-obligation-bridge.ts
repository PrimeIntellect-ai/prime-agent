import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSessionMessage,
	type AgentSessionMessageEndpoint,
	type AgentSessionMessagePayload,
	type AgentSessionMessageSender,
	createAgentSessionMessage,
	isAgentSessionMessageBlockedError,
} from "./agent-messages.js";
import type { AgentSession } from "./agent-session.js";
import {
	type SessionMessageDeliveryRecord,
	type SessionMessageLane,
	type SessionMessageObligationFence,
	type SessionMessageObligationOutcome,
	type SessionMessageObligationOwnerContinuityHandoff,
	type SessionMessageObligationOwnerContinuitySettlement,
	SessionMessageObligationStore,
	type SessionMessageObligationStoreOptions,
	sessionMessageContentDigest,
} from "./session-message-obligation-store.js";

const MANIFEST_FILE = "message-obligations.manifest.json";
const DEFAULT_RECOVERY_LIMIT = 32;
const MAX_RECOVERY_PAGES = 32;

export const SESSION_MESSAGE_OBLIGATION_ENVELOPE_VERSION = 1 as const;

export interface SessionMessageObligationEnvelope {
	readonly version: typeof SESSION_MESSAGE_OBLIGATION_ENVELOPE_VERSION;
	readonly messageId: string;
	readonly observationId: string;
	readonly source: "agent_message";
	readonly message: string;
	readonly from?: AgentSessionMessageSender;
	readonly fromRelationship?: AgentSessionMessagePayload["fromRelationship"];
	readonly target: AgentSessionMessageEndpoint;
}

export interface SessionMessageObligationBridgeOptions {
	readonly rootDir: string;
	readonly targetSessionId: string;
	readonly ownerId: string;
	readonly session?: AgentSession;
	readonly recoveryLimit?: number;
	readonly ownerContinuityHandoff?: SessionMessageObligationOwnerContinuityHandoff;
	readonly store?: Omit<SessionMessageObligationStoreOptions, "rootDir" | "fence">;
}

export interface SessionMessageObligationAcceptInput {
	readonly payload: AgentSessionMessagePayload;
	readonly lane: SessionMessageLane;
	readonly observationId?: string;
}

export interface SessionMessageObligationBridgeAcceptResult {
	readonly accepted: true;
	readonly replayed: boolean;
	readonly messageId: string;
	readonly observationId: string;
	readonly obligations: readonly SessionMessageDeliveryRecord[];
}

export interface SessionMessageObligationBridgeHandoffInput {
	readonly message: AgentSessionMessage;
	readonly successorOwnerId: string;
	readonly successorFence: SessionMessageObligationFence;
}

export type SessionMessageObligationDispatchResult = "dispatch" | "quarantine";

export interface SessionMessageObligationBridge {
	readonly targetSessionId: string;
	readonly ownerId: string;
	accept(input: SessionMessageObligationAcceptInput): Promise<SessionMessageObligationBridgeAcceptResult>;
	issueOwnerContinuityHandoff(
		input: SessionMessageObligationBridgeHandoffInput,
	): Promise<SessionMessageObligationOwnerContinuityHandoff>;
	bindSession(session: AgentSession): Promise<void>;
	beforeAgentMessageDispatch(message: AgentSessionMessage): Promise<SessionMessageObligationDispatchResult>;
	afterAgentMessageTranscriptAppend(message: AgentSessionMessage): Promise<void>;
	settleAgentMessage(
		message: AgentSessionMessage,
		outcome: Exclude<SessionMessageObligationOutcome, "pending" | "expired">,
		reason?: string,
	): Promise<void>;
	close(): Promise<void>;
}

export class SessionMessageObligationContractChangeError extends Error {
	readonly code = "CONTRACT_CHANGE" as const;

	constructor(message: string) {
		super(message);
		this.name = "SessionMessageObligationContractChangeError";
	}
}

function assertNonEmpty(value: string, label: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new SessionMessageObligationContractChangeError(`${label} is required`);
	}
}

function canonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
			.join(",")}}`;
	}
	throw new SessionMessageObligationContractChangeError("Canonical envelope contains an unsupported value");
}

function cloneEndpoint(endpoint: AgentSessionMessageEndpoint): AgentSessionMessageEndpoint {
	return {
		activeSessionId: endpoint.activeSessionId,
		sessionId: endpoint.sessionId,
		...(endpoint.sessionName === undefined ? {} : { sessionName: endpoint.sessionName }),
		...(endpoint.runtimeKind === undefined ? {} : { runtimeKind: endpoint.runtimeKind }),
	};
}

function cloneSender(sender: AgentSessionMessageSender): AgentSessionMessageSender {
	return {
		...(sender.activeSessionId === undefined ? {} : { activeSessionId: sender.activeSessionId }),
		...(sender.sessionId === undefined ? {} : { sessionId: sender.sessionId }),
		...(sender.sessionName === undefined ? {} : { sessionName: sender.sessionName }),
		...(sender.runtimeKind === undefined ? {} : { runtimeKind: sender.runtimeKind }),
		...(sender.clientId === undefined ? {} : { clientId: sender.clientId }),
	};
}

function createEnvelope(payload: AgentSessionMessagePayload, observationId: string): SessionMessageObligationEnvelope {
	assertNonEmpty(payload.id, "Agent message id");
	assertNonEmpty(observationId, "Agent message observation id");
	assertNonEmpty(payload.message, "Agent message content");
	assertNonEmpty(payload.target.sessionId, "Agent message target session id");
	return {
		version: SESSION_MESSAGE_OBLIGATION_ENVELOPE_VERSION,
		messageId: payload.id,
		observationId,
		source: payload.source,
		message: payload.message,
		...(payload.from === undefined ? {} : { from: cloneSender(payload.from) }),
		...(payload.fromRelationship === undefined ? {} : { fromRelationship: payload.fromRelationship }),
		target: cloneEndpoint(payload.target),
	};
}

export function serializeSessionMessageObligationEnvelope(envelope: SessionMessageObligationEnvelope): string {
	return canonicalize(envelope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEndpoint(
	value: unknown,
	label: string,
	sender: boolean,
): AgentSessionMessageEndpoint | AgentSessionMessageSender {
	if (!isRecord(value)) throw new SessionMessageObligationContractChangeError(`${label} is invalid`);
	if (sender) {
		const candidate = value as Record<string, unknown>;
		for (const key of ["activeSessionId", "sessionId", "sessionName", "runtimeKind", "clientId"]) {
			if (candidate[key] !== undefined && typeof candidate[key] !== "string")
				throw new SessionMessageObligationContractChangeError(`${label}.${key} is invalid`);
		}
		return {
			...(typeof candidate.activeSessionId === "string" ? { activeSessionId: candidate.activeSessionId } : {}),
			...(typeof candidate.sessionId === "string" ? { sessionId: candidate.sessionId } : {}),
			...(typeof candidate.sessionName === "string" ? { sessionName: candidate.sessionName } : {}),
			...(candidate.runtimeKind === "top-level" || candidate.runtimeKind === "subagent"
				? { runtimeKind: candidate.runtimeKind }
				: {}),
			...(typeof candidate.clientId === "string" ? { clientId: candidate.clientId } : {}),
		};
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.activeSessionId !== "string" || typeof candidate.sessionId !== "string")
		throw new SessionMessageObligationContractChangeError(`${label} ids are invalid`);
	if (
		(candidate.sessionName !== undefined && typeof candidate.sessionName !== "string") ||
		(candidate.runtimeKind !== undefined &&
			candidate.runtimeKind !== "top-level" &&
			candidate.runtimeKind !== "subagent")
	)
		throw new SessionMessageObligationContractChangeError(`${label} metadata is invalid`);
	return {
		activeSessionId: candidate.activeSessionId,
		sessionId: candidate.sessionId,
		...(typeof candidate.sessionName === "string" ? { sessionName: candidate.sessionName } : {}),
		...(candidate.runtimeKind === "top-level" || candidate.runtimeKind === "subagent"
			? { runtimeKind: candidate.runtimeKind }
			: {}),
	};
}

export function parseSessionMessageObligationEnvelope(content: string): SessionMessageObligationEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new SessionMessageObligationContractChangeError(`Cannot parse obligation envelope: ${String(error)}`);
	}
	if (!isRecord(value) || value.version !== SESSION_MESSAGE_OBLIGATION_ENVELOPE_VERSION)
		throw new SessionMessageObligationContractChangeError("Unsupported obligation envelope version");
	if (
		typeof value.messageId !== "string" ||
		typeof value.observationId !== "string" ||
		value.source !== "agent_message" ||
		typeof value.message !== "string"
	)
		throw new SessionMessageObligationContractChangeError("Obligation envelope identity or content is invalid");
	assertNonEmpty(value.messageId, "Obligation message id");
	assertNonEmpty(value.observationId, "Obligation observation id");
	assertNonEmpty(value.message, "Obligation message content");
	const target = parseEndpoint(value.target, "Obligation target", false) as AgentSessionMessageEndpoint;
	const from =
		value.from === undefined
			? undefined
			: (parseEndpoint(value.from, "Obligation sender", true) as AgentSessionMessageSender);
	if (
		value.fromRelationship !== undefined &&
		value.fromRelationship !== "parent" &&
		value.fromRelationship !== "sibling" &&
		value.fromRelationship !== "child"
	)
		throw new SessionMessageObligationContractChangeError("Obligation sender relationship is invalid");
	const envelope: SessionMessageObligationEnvelope = {
		version: SESSION_MESSAGE_OBLIGATION_ENVELOPE_VERSION,
		messageId: value.messageId,
		observationId: value.observationId,
		source: "agent_message",
		message: value.message,
		...(from === undefined ? {} : { from }),
		...(value.fromRelationship === undefined ? {} : { fromRelationship: value.fromRelationship }),
		target,
	};
	if (
		serializeSessionMessageObligationEnvelope(envelope) !==
		serializeSessionMessageObligationEnvelope(value as unknown as SessionMessageObligationEnvelope)
	)
		throw new SessionMessageObligationContractChangeError("Obligation envelope is not canonical");
	return envelope;
}

export function sessionMessageObligationDeliveryId(messageId: string, targetSessionId: string): string {
	assertNonEmpty(messageId, "Agent message id");
	assertNonEmpty(targetSessionId, "Agent message target session id");
	return `${messageId}:${sessionMessageContentDigest(targetSessionId).slice(0, 16)}`;
}

function readPersistedFence(rootDir: string): SessionMessageObligationFence | undefined {
	const path = join(rootDir, MANIFEST_FILE);
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as { currentFence?: SessionMessageObligationFence };
		if (
			value.currentFence === undefined ||
			typeof value.currentFence.processGeneration !== "string" ||
			!Number.isSafeInteger(value.currentFence.fencingEpoch) ||
			value.currentFence.fencingEpoch <= 0
		)
			throw new Error("invalid persisted fence");
		return {
			processGeneration: value.currentFence.processGeneration,
			fencingEpoch: value.currentFence.fencingEpoch,
		};
	} catch (error) {
		throw new SessionMessageObligationContractChangeError(`Cannot read persisted obligation fence: ${String(error)}`);
	}
}

function nextFence(current: SessionMessageObligationFence): SessionMessageObligationFence {
	return { processGeneration: randomUUID(), fencingEpoch: current.fencingEpoch + 1 };
}

function sameFence(left: SessionMessageObligationFence, right: SessionMessageObligationFence): boolean {
	return left.processGeneration === right.processGeneration && left.fencingEpoch === right.fencingEpoch;
}

function envelopePayload(envelope: SessionMessageObligationEnvelope): AgentSessionMessagePayload {
	return {
		id: envelope.messageId,
		observationId: envelope.observationId,
		source: envelope.source,
		message: envelope.message,
		...(envelope.from === undefined ? {} : { from: envelope.from }),
		...(envelope.fromRelationship === undefined ? {} : { fromRelationship: envelope.fromRelationship }),
		target: envelope.target,
	};
}

class DurableSessionMessageObligationBridge implements SessionMessageObligationBridge {
	readonly targetSessionId: string;
	readonly ownerId: string;
	private readonly store: SessionMessageObligationStore;
	private readonly recoveryLimit: number;
	private ownerContinuityHandoff: SessionMessageObligationOwnerContinuityHandoff | undefined;
	private session: AgentSession | undefined;
	private recoveryStarted = false;
	private readonly ownerContinuitySettlements = new Map<string, SessionMessageObligationOwnerContinuitySettlement>();

	constructor(
		store: SessionMessageObligationStore,
		targetSessionId: string,
		ownerId: string,
		recoveryLimit: number,
		session: AgentSession | undefined,
		ownerContinuityHandoff: SessionMessageObligationOwnerContinuityHandoff | undefined,
	) {
		this.store = store;
		this.targetSessionId = targetSessionId;
		this.ownerId = ownerId;
		this.recoveryLimit = recoveryLimit;
		this.session = session;
		this.ownerContinuityHandoff = ownerContinuityHandoff;
	}

	async accept(input: SessionMessageObligationAcceptInput): Promise<SessionMessageObligationBridgeAcceptResult> {
		if (input.payload.target.sessionId !== this.targetSessionId) {
			throw new SessionMessageObligationContractChangeError(
				`Obligation target ${input.payload.target.sessionId} does not match ${this.targetSessionId}`,
			);
		}
		const observationId = input.observationId ?? input.payload.observationId ?? `agentobs_${randomUUID()}`;
		const envelope = createEnvelope(input.payload, observationId);
		const content = serializeSessionMessageObligationEnvelope(envelope);
		const result = await this.store.accept({
			messageId: envelope.messageId,
			observationId: envelope.observationId,
			content,
			contentDigest: sessionMessageContentDigest(content),
			recipients: [
				{
					deliveryId: sessionMessageObligationDeliveryId(envelope.messageId, this.targetSessionId),
					recipient: this.targetSessionId,
					lane: input.lane,
				},
			],
		});
		if (!result.accepted) {
			throw new SessionMessageObligationContractChangeError(
				`Durable session message obligation was not accepted: ${result.reason ?? result.status}`,
			);
		}
		return {
			accepted: true,
			replayed: result.replayed,
			messageId: result.messageId,
			observationId: result.observationId,
			obligations: result.obligations,
		};
	}

	/**
	 * Issue a store-authenticated successor credential for a delivered message.
	 * Args:
	 * input: Delivered message and successor owner/fence binding.
	 * Return: The durable owner continuity credential.
	 */
	async issueOwnerContinuityHandoff(
		input: SessionMessageObligationBridgeHandoffInput,
	): Promise<SessionMessageObligationOwnerContinuityHandoff> {
		if (input.message.details.target?.sessionId !== this.targetSessionId)
			throw new SessionMessageObligationContractChangeError(
				`Obligation target ${input.message.details.target?.sessionId ?? "missing"} does not match ${this.targetSessionId}`,
			);
		if (input.successorOwnerId.trim().length === 0)
			throw new SessionMessageObligationContractChangeError("Successor obligation owner id is required");
		const deliveryId = sessionMessageObligationDeliveryId(input.message.details.id, this.targetSessionId);
		return this.store.issueOwnerContinuityHandoff({
			deliveryId,
			ownerId: this.ownerId,
			successorOwnerId: input.successorOwnerId,
			successorFence: input.successorFence,
		});
	}

	async bindSession(session: AgentSession): Promise<void> {
		this.session = session;
		await this.recover();
	}

	async beforeAgentMessageDispatch(message: AgentSessionMessage): Promise<SessionMessageObligationDispatchResult> {
		const deliveryId = sessionMessageObligationDeliveryId(message.details.id, this.targetSessionId);
		const existing = await this.store.getObligation(deliveryId);
		if (existing === undefined)
			throw new SessionMessageObligationContractChangeError(`Missing obligation ${deliveryId}`);
		if (existing.outcome === "failed" && existing.failureReason?.startsWith("quarantine:")) return "quarantine";
		let wake = await this.store.claimWake({ deliveryId, ownerId: this.ownerId });
		if (wake.outcome !== "pending" && wake.outcome !== "failed") return "quarantine";
		if (wake.outcome === "failed") {
			wake = await this.store.retry({ deliveryId, ownerId: this.ownerId });
		}
		if (this.session?.hasPersistedAgentMessage(message.details.id) === true) return "quarantine";
		if (wake.contextDelivery.status === "delivered") return "quarantine";
		if (wake.contextDelivery.status === "claimed") return "quarantine";
		await this.store.claimContextDelivery({
			deliveryId,
			ownerId: this.ownerId,
		});
		return "dispatch";
	}

	async afterAgentMessageTranscriptAppend(message: AgentSessionMessage): Promise<void> {
		const deliveryId = sessionMessageObligationDeliveryId(message.details.id, this.targetSessionId);
		await this.store.markContextDelivered({ deliveryId, ownerId: this.ownerId });
	}

	async settleAgentMessage(
		message: AgentSessionMessage,
		outcome: Exclude<SessionMessageObligationOutcome, "pending" | "expired">,
		reason?: string,
	): Promise<void> {
		const deliveryId = sessionMessageObligationDeliveryId(message.details.id, this.targetSessionId);
		const existing = await this.store.getObligation(deliveryId);
		if (existing?.outcome === outcome) return;
		const alreadyQuarantined = existing?.failureReason?.startsWith("quarantine:") === true;
		const transcriptReconciliationFailure = reason?.includes("was quarantined") === true;
		const durableReason =
			outcome === "failed" && reason?.startsWith("quarantine:") === true
				? reason
				: existing !== undefined &&
						(alreadyQuarantined ||
							transcriptReconciliationFailure ||
							existing.contextDelivery.status === "claimed" ||
							existing.contextDelivery.status === "delivered")
					? `quarantine:${reason ?? "model execution was not reconciled"}`
					: reason;
		const historicalSettlement =
			existing?.contextDelivery.status === "delivered" ? existing.contextDelivery : undefined;
		let ownerContinuityHandoff = historicalSettlement === undefined ? undefined : this.ownerContinuityHandoff;
		let ownerContinuitySettlement = this.ownerContinuitySettlements.get(deliveryId);
		if (ownerContinuityHandoff !== undefined) {
			if (
				ownerContinuityHandoff.deliveryId !== deliveryId ||
				ownerContinuityHandoff.successorOwnerId !== this.ownerId
			)
				throw new SessionMessageObligationContractChangeError(
					`Owner continuity handoff does not authorize delivery ${deliveryId}`,
				);
			const status = await this.store.getOwnerContinuityHandoff(ownerContinuityHandoff);
			if (status === undefined)
				throw new SessionMessageObligationContractChangeError("Owner continuity handoff is not durable");
			if (ownerContinuitySettlement === undefined) {
				if (status.consumed) {
					ownerContinuityHandoff = await this.store.reissueOwnerContinuityHandoff({
						consumedHandoff: ownerContinuityHandoff,
						successorOwnerId: this.ownerId,
						successorFence: ownerContinuityHandoff.successorFence,
					});
					this.ownerContinuityHandoff = ownerContinuityHandoff;
				}
				ownerContinuitySettlement = await this.store.consumeOwnerContinuityHandoff({
					handoff: ownerContinuityHandoff,
					ownerId: this.ownerId,
				});
				this.ownerContinuitySettlements.set(deliveryId, ownerContinuitySettlement);
			}
		}
		const input = {
			deliveryId,
			ownerId: this.ownerId,
			// The claim that proves this owner delivered the context. Omitting it sent the store down its
			// lease-expiry fallback, which requires the 30s wake lease to still be live - and a model turn
			// routinely outlives that, so settlement was lost on every long turn. A live ledger read
			// accepted 24, context_delivered 24, processed 12. Passing the recorded claim is also stricter
			// than the fallback: the store verifies it equals the durable proof rather than trusting a
			// timing window.
			...(historicalSettlement === undefined ? {} : { claimId: historicalSettlement.claimId }),
			...(ownerContinuitySettlement === undefined ? {} : { ownerContinuitySettlement }),
			...(durableReason === undefined ? {} : { reason: durableReason }),
		};
		try {
			if (outcome === "processed") await this.store.markProcessed(input);
			else if (outcome === "failed") await this.store.markFailure(input);
			else await this.store.cancel(input);
		} finally {
			if (ownerContinuitySettlement !== undefined) this.ownerContinuitySettlements.delete(deliveryId);
		}
	}

	async close(): Promise<void> {
		await this.store.close();
	}

	private async recover(): Promise<void> {
		if (this.recoveryStarted || this.session === undefined) return;
		this.recoveryStarted = true;
		let cursor: { acceptedSequence: number; deliveryId: string } | undefined;
		for (let page = 0; page < MAX_RECOVERY_PAGES; page++) {
			const records = await this.store.recoverPending({ limit: this.recoveryLimit, after: cursor });
			if (records.length === 0) return;
			for (const record of records) {
				if (record.recipient !== this.targetSessionId) continue;
				const envelope = parseSessionMessageObligationEnvelope(record.content);
				if (envelope.target.sessionId !== this.targetSessionId) {
					throw new SessionMessageObligationContractChangeError(
						`Obligation ${record.deliveryId} targets ${envelope.target.sessionId}, not ${this.targetSessionId}`,
					);
				}
				if (this.session.hasAgentMessageAction(envelope.messageId)) continue;
				const message = createAgentSessionMessage(envelopePayload(envelope));
				try {
					await this.session.queueAgentMessagePrompt(
						createAgentSessionMessagePromptFromEnvelope(envelope),
						record.lane === "followUp" ? "followUp" : "steer",
						message,
					);
				} catch (error) {
					if (!isAgentSessionMessageBlockedError(error)) throw error;
					if (!error.obligationSettled) {
						await this.beforeAgentMessageDispatch(message);
						await this.settleAgentMessage(message, "failed", `quarantine:${error.reason}`);
						error.obligationSettled = true;
					}
				}
			}
			const last = records.at(-1);
			if (last === undefined) return;
			cursor = { acceptedSequence: last.acceptedSequence, deliveryId: last.deliveryId };
			if (records.length < this.recoveryLimit) return;
		}
	}
}

function createAgentSessionMessagePromptFromEnvelope(envelope: SessionMessageObligationEnvelope): string {
	return createAgentSessionMessage(envelopePayload(envelope)).content;
}

export async function createSessionMessageObligationBridge(
	options: SessionMessageObligationBridgeOptions,
): Promise<SessionMessageObligationBridge> {
	assertNonEmpty(options.rootDir, "Durable obligation root");
	assertNonEmpty(options.targetSessionId, "Target session id");
	assertNonEmpty(options.ownerId, "Obligation owner id");
	const recoveryLimit = options.recoveryLimit ?? DEFAULT_RECOVERY_LIMIT;
	if (!Number.isSafeInteger(recoveryLimit) || recoveryLimit <= 0)
		throw new SessionMessageObligationContractChangeError("Obligation recovery limit must be positive");
	const persistedFence = readPersistedFence(options.rootDir);
	if (
		options.ownerContinuityHandoff !== undefined &&
		(persistedFence === undefined ||
			options.ownerContinuityHandoff.successorOwnerId !== options.ownerId ||
			(!sameFence(options.ownerContinuityHandoff.predecessorFence, persistedFence) &&
				!sameFence(options.ownerContinuityHandoff.successorFence, persistedFence)))
	)
		throw new SessionMessageObligationContractChangeError("Owner continuity handoff is not bound to this bridge");
	const initialFence = persistedFence ?? { processGeneration: randomUUID(), fencingEpoch: 1 };
	const storeOptions = options.store ?? {};
	let store = new SessionMessageObligationStore({
		...storeOptions,
		rootDir: options.rootDir,
		fence: initialFence,
	});
	if (options.ownerContinuityHandoff !== undefined) {
		const persistedHandoff = await store.getOwnerContinuityHandoff(options.ownerContinuityHandoff);
		if (persistedHandoff === undefined) {
			await store.close();
			throw new SessionMessageObligationContractChangeError("Owner continuity handoff is not durable");
		}
	}
	if (persistedFence !== undefined) {
		const successor = options.ownerContinuityHandoff?.successorFence ?? nextFence(persistedFence);
		try {
			await store.prepareBridgeFence({
				nextFence: successor,
				ownerId: options.ownerId,
				expectedFence: persistedFence,
				...(options.ownerContinuityHandoff === undefined
					? {}
					: { ownerContinuityHandoff: options.ownerContinuityHandoff }),
			});
		} catch (error) {
			await store.close();
			if (error instanceof SessionMessageObligationContractChangeError) throw error;
			throw new SessionMessageObligationContractChangeError(error instanceof Error ? error.message : String(error));
		}
		await store.close();
		store = new SessionMessageObligationStore({
			...storeOptions,
			rootDir: options.rootDir,
			fence: successor,
		});
	}
	const bridge = new DurableSessionMessageObligationBridge(
		store,
		options.targetSessionId,
		options.ownerId,
		recoveryLimit,
		options.session,
		options.ownerContinuityHandoff,
	);
	if (options.session !== undefined) {
		try {
			await bridge.bindSession(options.session);
		} catch (error) {
			await bridge.close().catch(() => undefined);
			throw error;
		}
	}
	return bridge;
}
