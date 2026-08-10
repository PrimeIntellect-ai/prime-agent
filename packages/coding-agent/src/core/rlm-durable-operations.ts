/**
 * Durable, owner-local facts for daemon RLM terminal delivery.
 *
 * The JSONL files are the authority.  The index deliberately is not read by
 * this module when making a decision: it is merely a crash-safe, body-free
 * summary for an operator that already has permission to inspect artifacts.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

export type RlmChildTerminalStatus = "done" | "error" | "cancelled";
export const RLM_DURABLE_VERSION = 1 as const;

export type RlmTerminalMessage =
	| {
			role: "custom";
			customType: "rlm_child_failure";
			content: string;
			display: true;
			details: { childId: string; sessionName: string; error: string };
			timestamp: number;
	  }
	| {
			role: "custom";
			customType: "rlm_child_terminal_notice";
			content: string;
			display: true;
			details:
				| { kind: "cancelled"; childId: string; sessionName: string; reason?: string }
				| {
						kind: "completed_without_reply";
						childId: string;
						sessionName: string;
						lastAssistantTextPreview?: string;
				  };
			timestamp: number;
	  }
	| {
			role: "custom";
			customType: "rlm_safe_terminal_result";
			content: string;
			display: true;
			details: { kind: "safe_terminal_result_v1"; projection: string };
			timestamp: number;
	  };

export interface RlmOperationAdmittedRecord {
	version: 1;
	type: "admitted";
	parentSessionId: string;
	parentSessionFile: string;
	childId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	childSessionDir: string;
	requestedModel: { provider: string; modelId: string };
	rlmDepth: number;
	rlmMaxDepth: number;
	recordedAt: string;
}
export interface RlmOperationMaterializedRecord {
	version: 1;
	type: "materialized";
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	childSessionId: string;
	childSessionFile: string;
	/** Immutable roots captured from the trusted materialization call. */
	childSessionRoot: string;
	childArtifactDir: string;
	childArtifactRoot: string;
	recordedAt: string;
}
export interface RlmOperationTerminalRecordedRecord {
	version: 1;
	type: "terminal_recorded";
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	terminal: RlmChildTerminalStatus;
	recordedAt: string;
}
export interface RlmOperationReleasedRecord {
	version: 1;
	type: "delete_intent" | "released" | "deleted";
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	recordedAt: string;
}
export type RlmOperationLedgerRecord =
	| RlmOperationAdmittedRecord
	| RlmOperationMaterializedRecord
	| RlmOperationTerminalRecordedRecord
	| RlmOperationReleasedRecord;

export interface RlmTerminalOutboxRecord {
	version: 1;
	type: "terminal";
	parentSessionId: string;
	parentSessionFile: string;
	childSessionId: string;
	childSessionFile: string;
	childId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	terminal: RlmChildTerminalStatus;
	message: RlmTerminalMessage;
	recordedAt: string;
}
export interface RlmTerminalInboxRecord extends Omit<RlmTerminalOutboxRecord, "type" | "recordedAt"> {
	version: 1;
	type: "received";
	receivedAt: string;
}
export interface RlmTerminalConsumedRecord {
	version: 1;
	type: "materialized" | "discarded";
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	sessionMessageId?: string;
	reason?: "parent_mismatch" | "superseded_assignment" | "deleted";
	recordedAt: string;
}

export interface RlmOperationAdmission {
	parentSessionId: string;
	parentSessionFile: string;
	/** Trusted root containing the parent session file, not its artifact dir. */
	parentSessionRoot: string;
	/** Trusted root containing the parent artifact dir, which may be a sibling of the session dir. */
	parentArtifactRoot: string;
	childId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	childSessionDir: string;
	requestedModel: { provider: string; modelId: string };
	rlmDepth: number;
	rlmMaxDepth: number;
}
export interface RlmOperationMaterialization {
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	childSessionId: string;
	childSessionFile: string;
	childSessionRoot: string;
	childArtifactDir: string;
	childArtifactRoot: string;
}
export interface RlmOperationTerminal {
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	terminal: RlmChildTerminalStatus;
}
export interface RlmTerminalOutbox extends Omit<RlmTerminalOutboxRecord, "version" | "type" | "recordedAt"> {
	/** Required trusted roots. They are validation inputs and are never persisted. */
	parentSessionRoot: string;
	parentArtifactRoot: string;
	childSessionRoot: string;
	childArtifactDir: string;
	childArtifactRoot: string;
}
export interface RlmDeliveryMaterialization {
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	sessionMessageId: string;
}
export interface RlmDeliveryDiscard {
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	reason: "parent_mismatch" | "superseded_assignment" | "deleted";
}

export interface RlmDurableOperation {
	key: string;
	parentSessionId: string;
	parentSessionFile: string;
	childId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	childSessionDir: string;
	requestedModel: { provider: string; modelId: string };
	rlmDepth: number;
	rlmMaxDepth: number;
	childSessionId?: string;
	childSessionFile?: string;
	/** These are immutable, trusted roots captured at materialization. */
	childSessionRoot?: string;
	childArtifactDir?: string;
	childArtifactRoot?: string;
	terminal?: RlmChildTerminalStatus;
	lifecycle: "admitted" | "materialized" | "delete_intent" | "terminal_recorded" | "released" | "deleted";
	/** A live explicit deletion is durably retained until its terminal hand-off can be deleted. */
	deleteIntent: boolean;
	uncertain: boolean;
}
export interface RlmDurableDelivery {
	key: string;
	operationKey: string;
	deliveryId: string;
	terminal?: RlmChildTerminalStatus;
	outboxed: boolean;
	received: boolean;
	consumed?: "materialized" | "discarded";
	uncertain: boolean;
	/** Internal reducer projection; never cached or sent on a public surface. */
	inboxRecord?: RlmTerminalInboxRecord;
	outboxRecord?: RlmTerminalOutboxRecord;
}
export interface RlmDurableOperationRegistry {
	operations: Map<string, RlmDurableOperation>;
	deliveries: Map<string, RlmDurableDelivery>;
	/** Any reducer corruption, including exact-key corruption. */
	hasUncertainRecords: boolean;
	/** A complete record without an attributable operation key quarantines all operations. */
	hasGlobalUncertainty: boolean;
	diagnostics: readonly string[];
}

export interface RlmDurableOperationStore {
	admit(input: RlmOperationAdmission): RlmDurableOperation;
	markMaterialized(input: RlmOperationMaterialization): boolean;
	recordTerminal(input: RlmOperationTerminal): boolean;
	appendOutbox(input: RlmTerminalOutbox): "new" | "already_recorded";
	importOutbox(input: RlmTerminalOutbox): "new" | "already_received";
	markMaterializedDelivery(input: RlmDeliveryMaterialization): "new" | "already_materialized";
	markDiscardedDelivery(input: RlmDeliveryDiscard): "new" | "already_discarded";
	/** Owner-only recovery join: append eligible authenticated outboxes to the inbox. */
	importPendingOutboxes(): number;
	/** Owner-only pending bodies, after durable inbox reduction. */
	pendingInbox(): readonly RlmTerminalInboxRecord[];
	/** Exact-key live-delete fence, retained through cancellation until terminal hand-off. */
	recordDeleteIntent(input: Pick<RlmOperationTerminal, "parentSessionId" | "assignmentId" | "operationId">): boolean;
	/** Exact-key terminal-only lifecycle transition for daemon adapters. */
	recordRelease(
		input: Pick<RlmOperationTerminal, "parentSessionId" | "assignmentId" | "operationId">,
		type: "released" | "deleted",
	): boolean;
	rebuild(): RlmDurableOperationRegistry;
}

/** Injectable only for focused durability fault tests. */
export interface RlmDurableIo {
	mkdirSync: typeof mkdirSync;
	chmodSync: typeof chmodSync;
	openSync: typeof openSync;
	closeSync: typeof closeSync;
	writeSync: typeof writeSync;
	fsyncSync: typeof fsyncSync;
	ftruncateSync: typeof ftruncateSync;
	readFileSync: typeof readFileSync;
	realpathSync: typeof realpathSync;
	renameSync: typeof renameSync;
}
/**
 * An owner/session-manager binding for one exact child assignment. Every
 * value here is authority supplied by the manager, never an identity inferred
 * from the materialized ledger record being checked.
 */
export interface RlmTrustedChildRecoveryBinding {
	childSessionId: string;
	childSessionFile: string;
	childSessionRoot: string;
	childArtifactDir: string;
	childArtifactRoot: string;
}
/**
 * Recovery bindings come from the owning session manager, never from JSONL.
 * A passive read without an exact binding deliberately leaves child outboxes
 * unopened and their operations uncertain.
 */
export type RlmChildRecoveryTrust = (
	operation: Readonly<RlmDurableOperation>,
) => RlmTrustedChildRecoveryBinding | undefined;
export interface RlmDurableOperationStoreOptions {
	io?: RlmDurableIo;
	now?: () => string;
	trustedChildRecoveryRoots?: RlmChildRecoveryTrust;
}

const defaultIo: RlmDurableIo = {
	mkdirSync,
	chmodSync,
	openSync,
	closeSync,
	writeSync,
	fsyncSync,
	ftruncateSync,
	readFileSync,
	realpathSync,
	renameSync,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINALS = new Set<RlmChildTerminalStatus>(["done", "error", "cancelled"]);
const MAX_MESSAGE_CHARS = 16_384;
const MAX_MESSAGE_BYTES = 24 * 1024;
/** Fixed C03 bounds for the generic public safe-terminal envelope. */
export const MAX_RLM_SAFE_TERMINAL_MESSAGE_BYTES = 64 * 1024;
export const MAX_RLM_SAFE_TERMINAL_CONTENT_CHARS = 16_384;

const LEDGER = "rlm-operation-ledger.jsonl";
const INBOX = "rlm-terminal-inbox.jsonl";
const CONSUMED = "rlm-terminal-consumed.jsonl";
const INDEX = "rlm-active-index.json";
const OUTBOX = "rlm-terminal-outbox.jsonl";

export function materializedTerminalMessageId(deliveryId: string): string {
	assertUuid(deliveryId, "deliveryId");
	return `rlm-terminal-${deliveryId}`;
}

/** Open is an owner action and creates its supplied artifact directory with owner-only permissions. */
export function openRlmDurableOperationStore(
	parentArtifactDir: string,
	options: RlmDurableOperationStoreOptions = {},
): RlmDurableOperationStore {
	return new Store(parentArtifactDir, options);
}

/** Passive: this does not create, chmod, repair, or write an artifact/cache. */
export function readRlmDurableOperationRegistry(
	parentArtifactDir: string,
	trustedChildRecoveryRoots?: RlmChildRecoveryTrust,
): RlmDurableOperationRegistry {
	return reduceArtifact(parentArtifactDir, defaultIo, trustedChildRecoveryRoots);
}

class Store implements RlmDurableOperationStore {
	private readonly io: RlmDurableIo;
	private readonly now: () => string;
	private readonly parentArtifactDir: string;
	private readonly trustedChildRecoveryRoots?: RlmChildRecoveryTrust;
	private readonly inProcessChildBindings = new Map<string, RlmTrustedChildRecoveryBinding>();

	constructor(parentArtifactDir: string, options: RlmDurableOperationStoreOptions) {
		this.io = options.io ?? defaultIo;
		this.now = options.now ?? (() => new Date().toISOString());
		this.trustedChildRecoveryRoots = options.trustedChildRecoveryRoots;
		this.io.mkdirSync(parentArtifactDir, { recursive: true, mode: 0o700 });
		this.io.chmodSync(parentArtifactDir, 0o700);
		this.parentArtifactDir = this.io.realpathSync(parentArtifactDir);
	}

	admit(input: RlmOperationAdmission): RlmDurableOperation {
		this.assertAdmission(input);
		const registry = this.reduce();
		assertGloballyCertain(registry);
		const key = operationKey(input.parentSessionId, input.assignmentId, input.operationId);
		const existing = registry.operations.get(key);
		const record: RlmOperationAdmittedRecord = {
			version: 1,
			type: "admitted",
			parentSessionId: input.parentSessionId,
			parentSessionFile: canonicalExistingFile(input.parentSessionFile, input.parentSessionRoot, this.io),
			childId: boundedText(input.childId, "childId", 256),
			assignmentId: canonicalUuid(input.assignmentId, "assignmentId"),
			operationId: canonicalUuid(input.operationId, "operationId"),
			deliveryId: canonicalUuid(input.deliveryId, "deliveryId"),
			childSessionDir: canonicalDirectory(input.childSessionDir, input.childSessionDir, this.io),
			requestedModel: validateModel(input.requestedModel),
			rlmDepth: boundedInteger(input.rlmDepth, "rlmDepth"),
			rlmMaxDepth: boundedInteger(input.rlmMaxDepth, "rlmMaxDepth"),
			recordedAt: this.now(),
		};
		if (record.rlmDepth > record.rlmMaxDepth) throw new Error("rlmDepth cannot exceed rlmMaxDepth");
		if (existing) {
			if (existing.uncertain || !sameAdmitted(existing, record))
				throw new Error(`Conflicting durable admission: ${key}`);
			return existing;
		}
		this.append(this.path(LEDGER), record);
		return this.afterAppend().operations.get(key)!;
	}

	markMaterialized(input: RlmOperationMaterialization): boolean {
		assertOperationInput(input);
		const registry = this.reduce();
		if (registry.hasGlobalUncertainty) return false;
		const operation = registry.operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		if (
			!operation ||
			operation.uncertain ||
			(operation.lifecycle !== "admitted" && operation.lifecycle !== "materialized")
		)
			return false;
		const childFile = canonicalExistingFile(input.childSessionFile, input.childSessionRoot, this.io);
		try {
			assertSessionIdentity(input.childSessionId, childFile, this.io);
			assertContainedDirectory(input.childArtifactDir, input.childArtifactRoot, this.io, true);
		} catch {
			return false;
		}
		const record: RlmOperationMaterializedRecord = {
			version: 1,
			type: "materialized",
			parentSessionId: input.parentSessionId,
			assignmentId: input.assignmentId,
			operationId: input.operationId,
			childSessionId: input.childSessionId,
			childSessionFile: childFile,
			childSessionRoot: canonicalDirectory(input.childSessionRoot, input.childSessionRoot, this.io),
			childArtifactDir: assertContainedDirectory(input.childArtifactDir, input.childArtifactRoot, this.io, true),
			childArtifactRoot: canonicalDirectory(input.childArtifactRoot, input.childArtifactRoot, this.io),
			recordedAt: this.now(),
		};
		if (operation.childSessionFile) {
			if (
				operation.childSessionId === record.childSessionId &&
				operation.childSessionFile === record.childSessionFile &&
				operation.childSessionRoot === record.childSessionRoot &&
				operation.childArtifactDir === record.childArtifactDir &&
				operation.childArtifactRoot === record.childArtifactRoot
			)
				return true;
			return false;
		}
		this.inProcessChildBindings.set(operation.key, {
			childSessionId: record.childSessionId,
			childSessionFile: record.childSessionFile,
			childSessionRoot: record.childSessionRoot,
			childArtifactDir: record.childArtifactDir,
			childArtifactRoot: record.childArtifactRoot,
		});
		this.append(this.path(LEDGER), record);
		this.afterAppend();
		return true;
	}

	recordTerminal(input: RlmOperationTerminal): boolean {
		assertOperationInput(input);
		assertUuid(input.deliveryId, "deliveryId");
		assertTerminal(input.terminal);
		const registry = this.reduce();
		if (registry.hasGlobalUncertainty) return false;
		const operation = registry.operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		if (
			!operation ||
			operation.uncertain ||
			(operation.lifecycle !== "materialized" && operation.lifecycle !== "delete_intent") ||
			!operation.childSessionFile ||
			operation.deliveryId !== input.deliveryId
		)
			return false;
		if (operation.terminal) return operation.terminal === input.terminal;
		const delivery = registry.deliveries.get(deliveryKey(operation.key, input.deliveryId));
		if (!delivery?.outboxed || delivery.terminal !== input.terminal || delivery.uncertain) return false;
		this.append(this.path(LEDGER), { version: 1, type: "terminal_recorded", ...input, recordedAt: this.now() });
		this.afterAppend();
		return true;
	}

	appendOutbox(input: RlmTerminalOutbox): "new" | "already_recorded" {
		const { operation, record } = this.validateOutboxInput(input, false);
		const registry = this.reduce();
		const prior = registry.deliveries.get(deliveryKey(operation.key, record.deliveryId));
		if (prior?.outboxed) {
			if (
				prior.uncertain ||
				prior.terminal !== record.terminal ||
				deliveryDigest(prior as DeliveryFact, record) !== digestMessage(record.message)
			) {
				throw new Error("Conflicting durable outbox record");
			}
			return "already_recorded";
		}
		this.append(joinArtifact(operation.childArtifactDir!, OUTBOX, this.io), record);
		this.afterAppend();
		return "new";
	}

	importOutbox(input: RlmTerminalOutbox): "new" | "already_received" {
		const { operation, record } = this.validateOutboxInput(input, true);
		const registry = this.reduce();
		const delivery = registry.deliveries.get(deliveryKey(operation.key, record.deliveryId));
		if (
			!delivery?.outboxed ||
			delivery.uncertain ||
			operation.terminal !== record.terminal ||
			outboxDigest(delivery) !== digestOutbox(record)
		) {
			throw new Error("Outbox is not a durable terminal hand-off");
		}
		if (delivery.received) return "already_received";
		const { recordedAt: _recordedAt, ...outboxFact } = record;
		const inbox: RlmTerminalInboxRecord = { ...outboxFact, type: "received", receivedAt: this.now() };
		this.append(this.path(INBOX), inbox);
		this.afterAppend();
		return "new";
	}

	markMaterializedDelivery(input: RlmDeliveryMaterialization): "new" | "already_materialized" {
		assertOperationInput(input);
		assertUuid(input.deliveryId, "deliveryId");
		if (
			boundedText(input.sessionMessageId, "sessionMessageId", 128) !==
			materializedTerminalMessageId(input.deliveryId)
		) {
			throw new Error("sessionMessageId must be the deterministic durable delivery id");
		}
		const registry = this.reduce();
		assertGloballyCertain(registry);
		const delivery = registry.deliveries.get(
			deliveryKey(operationKey(input.parentSessionId, input.assignmentId, input.operationId), input.deliveryId),
		);
		if (!delivery || delivery.uncertain || !delivery.received)
			throw new Error("Cannot consume a missing or uncertain inbox record");
		if (delivery.consumed === "materialized") return "already_materialized";
		if (delivery.consumed) throw new Error("Delivery was discarded");
		this.append(this.path(CONSUMED), { version: 1, type: "materialized", ...input, recordedAt: this.now() });
		this.afterAppend();
		return "new";
	}

	markDiscardedDelivery(input: RlmDeliveryDiscard): "new" | "already_discarded" {
		assertOperationInput(input);
		assertUuid(input.deliveryId, "deliveryId");
		const registry = this.reduce();
		assertGloballyCertain(registry);
		const operation = registry.operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		const delivery = registry.deliveries.get(deliveryKey(operation?.key ?? "", input.deliveryId));
		if (
			!operation ||
			operation.uncertain ||
			operation.lifecycle !== "deleted" ||
			!delivery?.received ||
			delivery.uncertain
		) {
			throw new Error("Only an exact deleted operation may discard an inbox delivery");
		}
		if (delivery.consumed === "discarded") return "already_discarded";
		if (delivery.consumed) throw new Error("Delivery was materialized");
		this.append(this.path(CONSUMED), { version: 1, type: "discarded", ...input, recordedAt: this.now() });
		this.afterAppend();
		return "new";
	}

	importPendingOutboxes(): number {
		const registry = this.reduce();
		if (registry.hasGlobalUncertainty) return 0;
		let imported = 0;
		for (const delivery of registry.deliveries.values()) {
			const operation = registry.operations.get(delivery.operationKey);
			const record = delivery.outboxRecord;
			if (
				!operation ||
				operation.uncertain ||
				delivery.uncertain ||
				delivery.received ||
				!record ||
				operation.terminal !== record.terminal ||
				!delivery.outboxed
			)
				continue;
			const { recordedAt: _recordedAt, ...outboxFact } = record;
			this.append(this.path(INBOX), { ...outboxFact, type: "received", receivedAt: this.now() });
			imported++;
		}
		if (imported) this.afterAppend();
		return imported;
	}

	pendingInbox(): readonly RlmTerminalInboxRecord[] {
		const registry = this.reduce();
		if (registry.hasGlobalUncertainty) return [];
		return [...registry.deliveries.values()]
			.filter((delivery) => delivery.received && !delivery.consumed && !delivery.uncertain && delivery.inboxRecord)
			.map((delivery) => delivery.inboxRecord!);
	}

	rebuild(): RlmDurableOperationRegistry {
		const registry = this.reduce();
		// A global quarantine is read-only, including its non-authoritative cache:
		// recovery must not make any durable write before an operator repairs the
		// complete corrupt record.
		if (!registry.hasGlobalUncertainty) this.writeIndex(registry);
		return registry;
	}

	/** Durable exact-key delete request for a live operation. It is not completion. */
	recordDeleteIntent(input: Pick<RlmOperationTerminal, "parentSessionId" | "assignmentId" | "operationId">): boolean {
		assertOperationInput(input);
		const registry = this.reduce();
		if (registry.hasGlobalUncertainty) return false;
		const operation = registry.operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		if (!operation || operation.uncertain) return false;
		if (operation.lifecycle === "deleted") return true;
		if (operation.deleteIntent) return true;
		if (
			operation.lifecycle !== "admitted" &&
			operation.lifecycle !== "materialized" &&
			operation.lifecycle !== "terminal_recorded"
		)
			return false;
		this.append(this.path(LEDGER), { version: 1, type: "delete_intent", ...input, recordedAt: this.now() });
		this.afterAppend();
		return true;
	}

	/** Releases/deletes are deliberately internal helpers for later host integration. */
	recordRelease(
		input: Pick<RlmOperationTerminal, "parentSessionId" | "assignmentId" | "operationId">,
		type: "released" | "deleted",
	): boolean {
		assertOperationInput(input);
		const registry = this.reduce();
		if (registry.hasGlobalUncertainty) return false;
		const operation = registry.operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		if (!operation || operation.uncertain || operation.lifecycle !== "terminal_recorded") return false;
		this.append(this.path(LEDGER), { version: 1, type, ...input, recordedAt: this.now() });
		this.afterAppend();
		return true;
	}

	private validateOutboxInput(
		input: RlmTerminalOutbox,
		requireTerminal: boolean,
	): { operation: RlmDurableOperation; record: RlmTerminalOutboxRecord } {
		assertOperationInput(input);
		assertUuid(input.deliveryId, "deliveryId");
		assertTerminal(input.terminal);
		assertTerminalMessage(input.message);
		const registry = this.reduce();
		assertGloballyCertain(registry);
		const operation = registry.operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		if (
			!operation ||
			operation.uncertain ||
			!operation.childSessionFile ||
			!operation.childSessionId ||
			operation.deliveryId !== input.deliveryId
		) {
			throw new Error("Outbox does not match an exact materialized operation");
		}
		if (requireTerminal && operation.terminal !== input.terminal)
			throw new Error("Outbox terminal is not ledger-recorded");
		const parentFile = canonicalExistingFile(input.parentSessionFile, input.parentSessionRoot, this.io);
		const childSessionRoot = canonicalDirectory(input.childSessionRoot, input.childSessionRoot, this.io);
		const childFile = canonicalExistingFile(input.childSessionFile, childSessionRoot, this.io);
		const childArtifactRoot = canonicalDirectory(input.childArtifactRoot, input.childArtifactRoot, this.io);
		const childArtifactDir = assertContainedDirectory(input.childArtifactDir, childArtifactRoot, this.io, false);
		assertSessionIdentity(input.parentSessionId, parentFile, this.io);
		assertSessionIdentity(input.childSessionId, childFile, this.io);
		assertContainedDirectory(this.parentArtifactDir, input.parentArtifactRoot, this.io, false);
		if (
			operation.parentSessionFile !== parentFile ||
			operation.childSessionFile !== childFile ||
			operation.childSessionId !== input.childSessionId ||
			operation.childSessionRoot !== childSessionRoot ||
			operation.childArtifactDir !== childArtifactDir ||
			operation.childArtifactRoot !== childArtifactRoot ||
			operation.childId !== input.childId
		) {
			throw new Error("Outbox session identity/path conflicts with admission");
		}
		return {
			operation,
			record: {
				version: 1,
				type: "terminal",
				parentSessionId: input.parentSessionId,
				parentSessionFile: parentFile,
				childSessionId: input.childSessionId,
				childSessionFile: childFile,
				childId: boundedText(input.childId, "childId", 256),
				assignmentId: input.assignmentId,
				operationId: input.operationId,
				deliveryId: input.deliveryId,
				terminal: input.terminal,
				message: input.message,
				recordedAt: this.now(),
			},
		};
	}

	private assertAdmission(input: RlmOperationAdmission): void {
		assertUuid(input.parentSessionId, "parentSessionId");
		assertUuid(input.assignmentId, "assignmentId");
		assertUuid(input.operationId, "operationId");
		assertUuid(input.deliveryId, "deliveryId");
		const parentFile = canonicalExistingFile(input.parentSessionFile, input.parentSessionRoot, this.io);
		assertSessionIdentity(input.parentSessionId, parentFile, this.io);
		assertContainedDirectory(this.parentArtifactDir, input.parentArtifactRoot, this.io, false);
		canonicalDirectory(input.childSessionDir, input.childSessionDir, this.io);
	}
	private reduce(): RlmDurableOperationRegistry {
		return reduceArtifact(
			this.parentArtifactDir,
			this.io,
			(operation) => this.inProcessChildBindings.get(operation.key) ?? this.trustedChildRecoveryRoots?.(operation),
		);
	}
	private afterAppend(): RlmDurableOperationRegistry {
		const registry = this.reduce();
		this.writeIndex(registry);
		return registry;
	}
	private path(name: string): string {
		return joinArtifact(this.parentArtifactDir, name, this.io);
	}
	private append(path: string, record: unknown): void {
		appendJsonl(path, record, this.io);
	}
	private writeIndex(registry: RlmDurableOperationRegistry): void {
		try {
			const body = JSON.stringify(bodylessIndex(registry));
			atomicCache(this.path(INDEX), body, this.io);
		} catch {
			// Cache is deliberately non-authoritative. The next owner rebuild may retry.
		}
	}
}

function reduceArtifact(
	parentArtifactDir: string,
	io: RlmDurableIo,
	trustedChildRecoveryRoots?: RlmChildRecoveryTrust,
): RlmDurableOperationRegistry {
	const registry: RlmDurableOperationRegistry = {
		operations: new Map(),
		deliveries: new Map(),
		hasUncertainRecords: false,
		hasGlobalUncertainty: false,
		diagnostics: [],
	};
	let canonicalParent: string;
	try {
		canonicalParent = io.realpathSync(parentArtifactDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return registry;
		throw error;
	}
	for (const parsed of readJsonl(joinArtifact(canonicalParent, LEDGER, io), io, registry, "ledger"))
		reduceLedger(parsed, registry);
	// Child paths in JSONL are data, not authority. Only a live session-manager
	// trust resolver can authorize opening a child artifact.
	for (const operation of registry.operations.values()) {
		if (
			!operation.childSessionId ||
			!operation.childSessionFile ||
			!operation.childArtifactDir ||
			operation.uncertain
		)
			continue;
		const binding = trustedChildRecoveryRoots?.(operation);
		if (!binding) {
			markOperationUncertain(operation, registry, "child recovery binding unavailable");
			continue;
		}
		try {
			// Validate manager authority first. In particular, do not use a ledger
			// path or ID as the expected value for validating that same ledger fact.
			const trustedSessionRoot = canonicalDirectory(binding.childSessionRoot, binding.childSessionRoot, io);
			const trustedArtifactRoot = canonicalDirectory(binding.childArtifactRoot, binding.childArtifactRoot, io);
			const trustedChildFile = canonicalExistingFile(binding.childSessionFile, trustedSessionRoot, io);
			assertSessionIdentity(binding.childSessionId, trustedChildFile, io);
			const trustedArtifact = assertContainedDirectory(binding.childArtifactDir, trustedArtifactRoot, io, false);
			if (
				operation.childSessionId !== binding.childSessionId ||
				operation.childSessionFile !== trustedChildFile ||
				operation.childSessionRoot !== trustedSessionRoot ||
				operation.childArtifactDir !== trustedArtifact ||
				operation.childArtifactRoot !== trustedArtifactRoot
			)
				throw new Error("persisted child binding does not match session-manager authority");
			for (const parsed of readJsonl(joinArtifact(trustedArtifact, OUTBOX, io), io, registry, "outbox"))
				reduceOutbox(parsed, registry);
		} catch {
			markOperationUncertain(operation, registry, "untrusted or unreadable child recovery binding");
		}
	}
	// Ledger and child outbox files are independently durable, so recovery can
	// observe a raw cut between their appends. Reconcile only after every
	// authorized outbox has been reduced; a terminal fact without its immutable
	// hand-off is never delivery authority.
	reconcileTerminalOutboxes(registry);
	for (const parsed of readJsonl(joinArtifact(canonicalParent, INBOX, io), io, registry, "inbox"))
		reduceInbox(parsed, registry);
	for (const parsed of readJsonl(joinArtifact(canonicalParent, CONSUMED, io), io, registry, "consumed"))
		reduceConsumed(parsed, registry);
	return registry;
}

function readJsonl(path: string, io: RlmDurableIo, registry: RlmDurableOperationRegistry, kind: string): unknown[] {
	let source: string;
	try {
		source = io.readFileSync(path, "utf8") as string;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!source) return [];
	const lines = source.split("\n");
	const hasFinalNewline = source.endsWith("\n");
	const count = hasFinalNewline ? lines.length - 1 : lines.length;
	const parsed: unknown[] = [];
	for (let i = 0; i < count; i++) {
		const line = lines[i]!;
		if (!line) {
			globalUncertain(registry, `${kind}: empty complete line ${i + 1}`);
			continue;
		}
		// A final record becomes authoritative only with its newline delimiter. A
		// crash may leave valid JSON without that delimiter; ignore the whole tail
		// so a later append can truncate it instead of concatenating two records.
		if (!hasFinalNewline && i === count - 1) continue;
		try {
			parsed.push(JSON.parse(line));
		} catch {
			globalUncertain(registry, `${kind}: malformed complete line ${i + 1}`);
		}
	}
	return parsed;
}

function reduceLedger(raw: unknown, registry: RlmDurableOperationRegistry): void {
	if (!isObject(raw) || raw.version !== 1 || typeof raw.type !== "string") {
		markInvalidRecord(raw, registry, "invalid ledger record");
		return;
	}
	if (raw.type === "admitted") {
		if (!validAdmitted(raw)) {
			markInvalidRecord(raw, registry, "invalid admitted record");
			return;
		}
		const record = raw as unknown as RlmOperationAdmittedRecord;
		const key = operationKey(record.parentSessionId, record.assignmentId, record.operationId);
		const existing = registry.operations.get(key);
		if (!existing) {
			registry.operations.set(key, {
				key,
				parentSessionId: record.parentSessionId,
				parentSessionFile: record.parentSessionFile,
				childId: record.childId,
				assignmentId: record.assignmentId,
				operationId: record.operationId,
				deliveryId: record.deliveryId,
				childSessionDir: record.childSessionDir,
				requestedModel: record.requestedModel,
				rlmDepth: record.rlmDepth,
				rlmMaxDepth: record.rlmMaxDepth,
				lifecycle: "admitted",
				deleteIntent: false,
				// An unattributable complete record quarantines every later reduction too.
				uncertain: registry.hasGlobalUncertainty,
			});
		} else if (!sameAdmitted(existing, record)) markOperationUncertain(existing, registry, "conflicting admission");
		return;
	}
	if (!hasOperationIdentity(raw)) {
		globalUncertain(registry, "invalid ledger identity");
		return;
	}
	const operation = registry.operations.get(operationKey(raw.parentSessionId, raw.assignmentId, raw.operationId));
	if (!operation) {
		globalUncertain(registry, "ledger event without admission");
		return;
	}
	if (raw.type === "materialized") {
		if (!validMaterialized(raw)) {
			globalUncertain(registry, "invalid materialization");
			return;
		}
		if (!operation.childSessionFile) {
			operation.childSessionId = raw.childSessionId;
			operation.childSessionFile = raw.childSessionFile;
			operation.childSessionRoot = raw.childSessionRoot;
			operation.childArtifactDir = raw.childArtifactDir;
			operation.childArtifactRoot = raw.childArtifactRoot;
			operation.lifecycle = "materialized";
		} else if (
			operation.childSessionId !== raw.childSessionId ||
			operation.childSessionFile !== raw.childSessionFile ||
			operation.childSessionRoot !== raw.childSessionRoot ||
			operation.childArtifactDir !== raw.childArtifactDir ||
			operation.childArtifactRoot !== raw.childArtifactRoot
		)
			markOperationUncertain(operation, registry, "conflicting materialization");
		return;
	}
	if (raw.type === "terminal_recorded") {
		if (!validTerminalRecorded(raw)) {
			globalUncertain(registry, "invalid terminal record");
			return;
		}
		if (
			(operation.lifecycle !== "materialized" && operation.lifecycle !== "delete_intent") ||
			!operation.childSessionFile ||
			raw.deliveryId !== operation.deliveryId
		) {
			markOperationUncertain(operation, registry, "invalid terminal transition");
			return;
		}
		if (!operation.terminal) {
			operation.terminal = raw.terminal as RlmChildTerminalStatus;
			operation.lifecycle = "terminal_recorded";
		} else if (operation.terminal !== raw.terminal)
			markOperationUncertain(operation, registry, "conflicting terminal");
		return;
	}
	if (raw.type === "delete_intent") {
		if (!validDeleteIntent(raw)) {
			globalUncertain(registry, "invalid delete intent record");
			return;
		}
		if (operation.lifecycle === "deleted") return;
		if (operation.deleteIntent) return;
		if (
			operation.lifecycle !== "admitted" &&
			operation.lifecycle !== "materialized" &&
			operation.lifecycle !== "terminal_recorded"
		) {
			markOperationUncertain(operation, registry, "delete intent after release");
			return;
		}
		operation.deleteIntent = true;
		if (operation.lifecycle !== "terminal_recorded") operation.lifecycle = "delete_intent";
		return;
	}
	if (raw.type === "released" || raw.type === "deleted") {
		if (!validReleased(raw)) {
			globalUncertain(registry, "invalid release record");
			return;
		}
		if (operation.lifecycle === raw.type) return;
		if (operation.lifecycle !== "terminal_recorded") {
			markOperationUncertain(operation, registry, "release/deletion before terminal");
			return;
		}
		operation.lifecycle = raw.type;
		return;
	}
	globalUncertain(registry, "unknown ledger event");
}

function reduceOutbox(raw: unknown, registry: RlmDurableOperationRegistry): void {
	if (!validOutbox(raw, "terminal")) {
		markInvalidRecord(raw, registry, "invalid outbox record");
		return;
	}
	const record = raw as RlmTerminalOutboxRecord;
	const operation = registry.operations.get(
		operationKey(record.parentSessionId, record.assignmentId, record.operationId),
	);
	if (!operation) {
		globalUncertain(registry, "outbox without operation");
		return;
	}
	const delivery = deliveryFor(operation, record.deliveryId, registry);
	if (
		operation.uncertain ||
		record.deliveryId !== operation.deliveryId ||
		operation.parentSessionFile !== record.parentSessionFile ||
		operation.childSessionId !== record.childSessionId ||
		operation.childSessionFile !== record.childSessionFile ||
		operation.childId !== record.childId
	) {
		markDeliveryUncertain(delivery, operation, registry, "outbox identity mismatch");
		return;
	}
	if (!delivery.outboxed) {
		delivery.outboxed = true;
		delivery.terminal = record.terminal;
		delivery.outboxRecord = record;
		defineDeliveryDigest(delivery, record);
	} else if (
		delivery.terminal !== record.terminal ||
		deliveryDigest(delivery, record) !== digestMessage(record.message)
	)
		markDeliveryUncertain(delivery, operation, registry, "conflicting outbox");
	else defineDeliveryDigest(delivery, record);
}

function reconcileTerminalOutboxes(registry: RlmDurableOperationRegistry): void {
	for (const operation of registry.operations.values()) {
		if (!operation.terminal) continue;
		const delivery = deliveryFor(operation, operation.deliveryId, registry);
		if (
			operation.uncertain ||
			!delivery.outboxed ||
			delivery.uncertain ||
			delivery.terminal !== operation.terminal ||
			!outboxDigest(delivery)
		) {
			markDeliveryUncertain(delivery, operation, registry, "terminal without matching durable outbox");
		}
	}
}

function reduceInbox(raw: unknown, registry: RlmDurableOperationRegistry): void {
	if (!validOutbox(raw, "received")) {
		markInvalidRecord(raw, registry, "invalid inbox record");
		return;
	}
	const record = raw as RlmTerminalInboxRecord;
	const operation = registry.operations.get(
		operationKey(record.parentSessionId, record.assignmentId, record.operationId),
	);
	if (!operation) {
		globalUncertain(registry, "inbox without operation");
		return;
	}
	const delivery = deliveryFor(operation, record.deliveryId, registry);
	if (
		!delivery.outboxed ||
		delivery.uncertain ||
		!operation.terminal ||
		operation.terminal !== record.terminal ||
		delivery.terminal !== record.terminal ||
		outboxDigest(delivery) !== digestOutbox(record)
	) {
		markDeliveryUncertain(delivery, operation, registry, "inbox without matching outbox/terminal");
		return;
	}
	if (!delivery.received) {
		delivery.received = true;
		delivery.inboxRecord = record;
		defineDeliveryDigest(delivery, record);
	} else if (deliveryDigest(delivery, record) !== digestMessage(record.message))
		markDeliveryUncertain(delivery, operation, registry, "conflicting inbox");
}

function reduceConsumed(raw: unknown, registry: RlmDurableOperationRegistry): void {
	if (!validConsumed(raw)) {
		markInvalidRecord(raw, registry, "invalid consumed record");
		return;
	}
	const record = raw as RlmTerminalConsumedRecord;
	const operation = registry.operations.get(
		operationKey(record.parentSessionId, record.assignmentId, record.operationId),
	);
	if (!operation) {
		globalUncertain(registry, "consumed without operation");
		return;
	}
	const delivery = deliveryFor(operation, record.deliveryId, registry);
	if (!delivery.received || delivery.uncertain) {
		markDeliveryUncertain(delivery, operation, registry, "consumed before inbox");
		return;
	}
	if (record.type === "materialized" && record.sessionMessageId !== materializedTerminalMessageId(record.deliveryId)) {
		markDeliveryUncertain(delivery, operation, registry, "forged materialized message id");
		return;
	}
	if (record.type === "discarded" && operation.lifecycle !== "deleted") {
		markDeliveryUncertain(delivery, operation, registry, "discard without deletion");
		return;
	}
	if (!delivery.consumed) delivery.consumed = record.type;
	else if (delivery.consumed !== record.type)
		markDeliveryUncertain(delivery, operation, registry, "conflicting consumption");
}

function deliveryFor(
	operation: RlmDurableOperation,
	deliveryId: string,
	registry: RlmDurableOperationRegistry,
): RlmDurableDelivery {
	const key = deliveryKey(operation.key, deliveryId);
	let delivery = registry.deliveries.get(key);
	if (!delivery) {
		delivery = {
			key,
			operationKey: operation.key,
			deliveryId,
			outboxed: false,
			received: false,
			uncertain: registry.hasGlobalUncertainty,
		};
		registry.deliveries.set(key, delivery);
	}
	return delivery;
}
type DeliveryFact = RlmDurableDelivery & { _messageDigest?: string; _outboxDigest?: string };
function defineDeliveryDigest(delivery: DeliveryFact, record: RlmTerminalOutboxRecord | RlmTerminalInboxRecord): void {
	delivery._messageDigest = digestMessage(record.message);
	if (record.type === "terminal") delivery._outboxDigest = digestOutbox(record);
}
function deliveryDigest(delivery: DeliveryFact, record: { message: RlmTerminalMessage }): string {
	return delivery._messageDigest ?? digestMessage(record.message);
}
function outboxDigest(delivery: DeliveryFact): string | undefined {
	return delivery._outboxDigest;
}
/** Immutable parent/child identity and bounded body are a single hand-off fact. */
function digestOutbox(record: RlmTerminalOutboxRecord | RlmTerminalInboxRecord): string {
	return createHash("sha256")
		.update(
			stableJson({
				version: 1,
				type: "terminal",
				parentSessionId: record.parentSessionId,
				parentSessionFile: record.parentSessionFile,
				childSessionId: record.childSessionId,
				childSessionFile: record.childSessionFile,
				childId: record.childId,
				assignmentId: record.assignmentId,
				operationId: record.operationId,
				deliveryId: record.deliveryId,
				terminal: record.terminal,
				message: record.message,
			}),
		)
		.digest("hex");
}
/**
 * A complete malformed record has no safely attributable meaning, even if it
 * happens to contain fields that look like an operation key.  In particular,
 * accepting the apparent key would let an attacker or a torn serializer hide
 * a conflicting lifecycle fact behind it.  Complete malformed records are
 * therefore global corruption; only a torn final tail is explicitly repaired
 * and ignored by readJsonl/appendJsonl.
 */
function markInvalidRecord(_raw: unknown, registry: RlmDurableOperationRegistry, message: string): void {
	globalUncertain(registry, message);
}

function markOperationUncertain(
	operation: RlmDurableOperation,
	registry: RlmDurableOperationRegistry,
	message: string,
): void {
	operation.uncertain = true;
	registry.hasUncertainRecords = true;
	registry.diagnostics = [...registry.diagnostics, `${operation.key}: ${message}`];
}
function markDeliveryUncertain(
	delivery: RlmDurableDelivery,
	operation: RlmDurableOperation,
	registry: RlmDurableOperationRegistry,
	message: string,
): void {
	delivery.uncertain = true;
	markOperationUncertain(operation, registry, message);
}
/**
 * A complete record with no trustworthy compound identity cannot be scoped to
 * one operation. It therefore taints the entire authoritative history, rather
 * than allowing a reducer order or a later valid record to re-enable work.
 */
function globalUncertain(registry: RlmDurableOperationRegistry, message: string): void {
	registry.hasUncertainRecords = true;
	registry.hasGlobalUncertainty = true;
	for (const operation of registry.operations.values()) operation.uncertain = true;
	for (const delivery of registry.deliveries.values()) delivery.uncertain = true;
	registry.diagnostics = [...registry.diagnostics, message];
}
function assertGloballyCertain(registry: RlmDurableOperationRegistry): void {
	if (registry.hasGlobalUncertainty) throw new Error("Durable history is globally uncertain");
}

function appendJsonl(path: string, record: unknown, io: RlmDurableIo): void {
	// Never append after a crash-torn physical record. It is not authority until
	// its newline landed, and retaining it would merge two JSON values into one
	// malformed line. Read before opening so ENOENT remains the normal first-write path.
	let retainedBytes: number | undefined;
	try {
		const existing = io.readFileSync(path, "utf8") as string;
		if (existing && !existing.endsWith("\n")) {
			const newline = existing.lastIndexOf("\n");
			retainedBytes = Buffer.byteLength(newline < 0 ? "" : existing.slice(0, newline + 1));
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const fd = io.openSync(path, "a", 0o600);
	try {
		if (retainedBytes !== undefined) io.ftruncateSync(fd, retainedBytes);
		writeAll(fd, Buffer.from(`${JSON.stringify(record)}\n`), io);
		io.fsyncSync(fd);
	} finally {
		io.closeSync(fd);
	}
	io.chmodSync(path, 0o600);
	// File fsync alone cannot persist a newly-created directory entry.
	const directory = io.openSync(dirname(path), "r");
	try {
		io.fsyncSync(directory);
	} finally {
		io.closeSync(directory);
	}
}
function writeAll(fd: number, data: Buffer, io: RlmDurableIo): void {
	let offset = 0;
	while (offset < data.length) {
		const written = io.writeSync(fd, data, offset, data.length - offset);
		if (!Number.isSafeInteger(written) || written <= 0 || written > data.length - offset)
			throw new Error("Durable write made no forward progress");
		offset += written;
	}
}
function atomicCache(path: string, body: string, io: RlmDurableIo): void {
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	const fd = io.openSync(temp, "wx", 0o600);
	try {
		writeAll(fd, Buffer.from(body), io);
		io.fsyncSync(fd);
	} finally {
		io.closeSync(fd);
	}
	io.chmodSync(temp, 0o600);
	io.renameSync(temp, path);
	const directory = io.openSync(dirname(path), "r");
	try {
		io.fsyncSync(directory);
	} finally {
		io.closeSync(directory);
	}
}

/**
 * Replaceable operator cache, deliberately narrower than the JSONL authority.
 * Never spread reducer records here: deliveries retain outbox/inbox records for
 * authenticated recovery, and those records contain terminal message bodies.
 */
function bodylessIndex(registry: RlmDurableOperationRegistry): unknown {
	return {
		version: 1,
		operations: [...registry.operations.values()].map((operation) => ({
			parentSessionId: operation.parentSessionId,
			childId: operation.childId,
			assignmentId: operation.assignmentId,
			operationId: operation.operationId,
			deliveryId: operation.deliveryId,
			lifecycle: operation.lifecycle,
			terminal: operation.terminal,
			uncertain: operation.uncertain,
		})),
		deliveries: [...registry.deliveries.values()].map((delivery) => ({
			operationKey: delivery.operationKey,
			deliveryId: delivery.deliveryId,
			terminal: delivery.terminal,
			outboxed: delivery.outboxed,
			received: delivery.received,
			consumed: delivery.consumed,
			uncertain: delivery.uncertain,
		})),
		uncertain: registry.hasUncertainRecords,
		globallyUncertain: registry.hasGlobalUncertainty,
	};
}
function operationKey(parentSessionId: string, assignmentId: string, operationId: string): string {
	return JSON.stringify([parentSessionId, assignmentId, operationId]);
}
function deliveryKey(operation: string, deliveryId: string): string {
	return JSON.stringify([operation, deliveryId]);
}
function joinArtifact(directory: string, file: string, io: RlmDurableIo): string {
	return `${canonicalDirectory(directory, directory, io)}/${file}`;
}
function canonicalDirectory(path: string, root: string, io: RlmDurableIo): string {
	return assertContainedDirectory(path, root, io, false);
}
function canonicalExistingFile(path: string, root: string, io: RlmDurableIo): string {
	const canonicalRoot = io.realpathSync(root);
	const file = io.realpathSync(path);
	if (!inside(canonicalRoot, file)) throw new Error("Path escapes trusted session root");
	return file;
}
function assertContainedDirectory(path: string, root: string, io: RlmDurableIo, create: boolean): string {
	if (create) {
		io.mkdirSync(path, { recursive: true, mode: 0o700 });
		io.chmodSync(path, 0o700);
	}
	const canonicalRoot = io.realpathSync(root);
	const target = io.realpathSync(path);
	if (!inside(canonicalRoot, target)) throw new Error("Path escapes trusted artifact root");
	return target;
}
function inside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("../") && !rel.startsWith("..\\") && rel !== ".." && !isAbsolute(rel));
}
function assertSessionIdentity(id: string, file: string, io: RlmDurableIo): void {
	assertUuid(id, "sessionId");
	const first = (io.readFileSync(file, "utf8") as string).split("\n", 1)[0];
	try {
		const header = JSON.parse(first) as unknown;
		if (!isObject(header) || header.type !== "session" || header.id !== id) throw new Error();
	} catch {
		throw new Error("Session file does not match claimed session id");
	}
}
function assertUuid(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${name} must be a canonical UUID`);
}
function canonicalUuid(value: string, name: string): string {
	assertUuid(value, name);
	return value;
}
function boundedText(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum)
		throw new Error(`${name} is invalid or too large`);
	return value;
}
function boundedInteger(value: unknown, name: string): number {
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1024)
		throw new Error(`${name} is not a bounded integer`);
	return value as number;
}
function assertTerminal(value: unknown): asserts value is RlmChildTerminalStatus {
	if (typeof value !== "string" || !TERMINALS.has(value as RlmChildTerminalStatus))
		throw new Error("Unknown terminal projection");
}
function validateModel(value: unknown): { provider: string; modelId: string } {
	if (!isObject(value)) throw new Error("requestedModel is invalid");
	return {
		provider: boundedText(value.provider, "provider", 256),
		modelId: boundedText(value.modelId, "modelId", 256),
	};
}
function assertOperationInput(value: { parentSessionId: string; assignmentId: string; operationId: string }): void {
	assertUuid(value.parentSessionId, "parentSessionId");
	assertUuid(value.assignmentId, "assignmentId");
	assertUuid(value.operationId, "operationId");
}
function assertTerminalMessage(value: unknown): asserts value is RlmTerminalMessage {
	if (
		!isObject(value) ||
		!exactKeys(value, ["role", "customType", "content", "display", "details", "timestamp"]) ||
		value.role !== "custom" ||
		value.display !== true ||
		typeof value.content !== "string" ||
		!Number.isFinite(value.timestamp)
	)
		throw new Error("Terminal message is not a bounded approved custom projection");
	if (value.customType === "rlm_child_failure") {
		if (
			!isObject(value.details) ||
			!exactKeys(value.details, ["childId", "sessionName", "error"]) ||
			!isBoundedText(value.details.childId, 256) ||
			!isBoundedText(value.details.sessionName, 256) ||
			!isBoundedText(value.details.error, 4096)
		)
			throw new Error("Failure message details are not approved");
	} else if (value.customType === "rlm_child_terminal_notice") {
		if (
			!isObject(value.details) ||
			!isBoundedText(value.details.childId, 256) ||
			!isBoundedText(value.details.sessionName, 256)
		)
			throw new Error("Terminal notice details are not approved");
		if (value.details.kind === "cancelled") {
			if (
				!exactKeys(
					value.details,
					value.details.reason === undefined
						? ["kind", "childId", "sessionName"]
						: ["kind", "childId", "sessionName", "reason"],
				) ||
				(value.details.reason !== undefined && !isBoundedText(value.details.reason, 4096))
			)
				throw new Error("Cancelled notice details are not approved");
		} else if (value.details.kind === "completed_without_reply") {
			if (
				!exactKeys(
					value.details,
					value.details.lastAssistantTextPreview === undefined
						? ["kind", "childId", "sessionName"]
						: ["kind", "childId", "sessionName", "lastAssistantTextPreview"],
				) ||
				(value.details.lastAssistantTextPreview !== undefined &&
					!isBoundedText(value.details.lastAssistantTextPreview, 4096))
			)
				throw new Error("Completed notice details are not approved");
		} else throw new Error("Unknown terminal notice kind");
	} else if (value.customType === "rlm_safe_terminal_result") {
		if (
			!isObject(value.details) ||
			!exactKeys(value.details, ["kind", "projection"]) ||
			value.details.kind !== "safe_terminal_result_v1" ||
			!isUtf8String(value.details.projection)
		)
			throw new Error("Safe-terminal result details are not approved");
		if (!isBoundedText(value.content, MAX_RLM_SAFE_TERMINAL_CONTENT_CHARS))
			throw new Error("Safe-terminal human content is invalid or too large");
		// The string is deliberately opaque; only the full envelope byte cap is checked.
		if (Buffer.byteLength(stableJson(value), "utf8") > MAX_RLM_SAFE_TERMINAL_MESSAGE_BYTES)
			throw new Error("Safe-terminal terminal message is too large");
	} else throw new Error("Terminal message custom type is not approved");
	if (value.customType !== "rlm_safe_terminal_result") {
		if (!isBoundedText(value.content, MAX_MESSAGE_CHARS) || Buffer.byteLength(stableJson(value)) > MAX_MESSAGE_BYTES)
			throw new Error("Terminal message is too large");
	}
}

/**
 * Creates the generic safe-terminal envelope from already-sanitized caller
 * inputs. It deliberately makes no interpretation of `projection`.
 */
export function createRlmSafeTerminalResultTerminalMessage(
	content: string,
	projection: string,
	timestamp: number,
): Extract<RlmTerminalMessage, { customType: "rlm_safe_terminal_result" }> {
	if (!Number.isFinite(timestamp)) throw new Error("Terminal timestamp must be finite");
	const message = {
		role: "custom" as const,
		customType: "rlm_safe_terminal_result" as const,
		content,
		display: true as const,
		details: { kind: "safe_terminal_result_v1" as const, projection },
		timestamp,
	};
	assertTerminalMessage(message);
	return message;
}

/** Verifies that the JavaScript string contains Unicode scalar values only. */
function isUtf8String(value: unknown): value is string {
	if (typeof value !== "string") return false;
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(++index);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function digestMessage(message: RlmTerminalMessage): string {
	return createHash("sha256").update(stableJson(message)).digest("hex");
}
function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
		.join(",")}}`;
}
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOperationIdentity(value: Record<string, unknown>): value is Record<string, string> {
	return (
		typeof value.parentSessionId === "string" &&
		typeof value.assignmentId === "string" &&
		typeof value.operationId === "string" &&
		UUID.test(value.parentSessionId) &&
		UUID.test(value.assignmentId) &&
		UUID.test(value.operationId)
	);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}
function validStamped(value: Record<string, unknown>): boolean {
	return (
		typeof value.recordedAt === "string" &&
		value.recordedAt.length <= 64 &&
		!Number.isNaN(Date.parse(value.recordedAt))
	);
}
function validAdmitted(value: Record<string, unknown>): boolean {
	return (
		exactKeys(value, [
			"version",
			"type",
			"parentSessionId",
			"parentSessionFile",
			"childId",
			"assignmentId",
			"operationId",
			"deliveryId",
			"childSessionDir",
			"requestedModel",
			"rlmDepth",
			"rlmMaxDepth",
			"recordedAt",
		]) &&
		hasOperationIdentity(value) &&
		typeof value.deliveryId === "string" &&
		UUID.test(value.deliveryId) &&
		typeof value.parentSessionFile === "string" &&
		isAbsolute(value.parentSessionFile) &&
		isBoundedText(value.childId, 256) &&
		typeof value.childSessionDir === "string" &&
		isAbsolute(value.childSessionDir) &&
		isValidModel(value.requestedModel) &&
		isBoundedInteger(value.rlmDepth) &&
		isBoundedInteger(value.rlmMaxDepth) &&
		value.rlmDepth <= value.rlmMaxDepth &&
		validStamped(value)
	);
}
function validMaterialized(value: Record<string, unknown>): value is Record<string, string> {
	return (
		exactKeys(value, [
			"version",
			"type",
			"parentSessionId",
			"assignmentId",
			"operationId",
			"childSessionId",
			"childSessionFile",
			"childSessionRoot",
			"childArtifactDir",
			"childArtifactRoot",
			"recordedAt",
		]) &&
		hasOperationIdentity(value) &&
		typeof value.childSessionId === "string" &&
		UUID.test(value.childSessionId) &&
		["childSessionFile", "childSessionRoot", "childArtifactDir", "childArtifactRoot"].every(
			(key) => typeof value[key] === "string" && isAbsolute(value[key] as string),
		) &&
		validStamped(value)
	);
}
function validDeleteIntent(value: Record<string, unknown>): boolean {
	return (
		exactKeys(value, ["version", "type", "parentSessionId", "assignmentId", "operationId", "recordedAt"]) &&
		hasOperationIdentity(value) &&
		value.type === "delete_intent" &&
		validStamped(value)
	);
}
function validReleased(value: Record<string, unknown>): boolean {
	return (
		exactKeys(value, ["version", "type", "parentSessionId", "assignmentId", "operationId", "recordedAt"]) &&
		hasOperationIdentity(value) &&
		(value.type === "released" || value.type === "deleted") &&
		validStamped(value)
	);
}
function validTerminalRecorded(value: Record<string, unknown>): value is Record<string, string> {
	return (
		exactKeys(value, [
			"version",
			"type",
			"parentSessionId",
			"assignmentId",
			"operationId",
			"deliveryId",
			"terminal",
			"recordedAt",
		]) &&
		hasOperationIdentity(value) &&
		typeof value.deliveryId === "string" &&
		UUID.test(value.deliveryId) &&
		typeof value.terminal === "string" &&
		TERMINALS.has(value.terminal as RlmChildTerminalStatus) &&
		validStamped(value)
	);
}
function validOutbox(value: unknown, type: "terminal" | "received"): boolean {
	if (
		!isObject(value) ||
		value.version !== 1 ||
		value.type !== type ||
		!exactKeys(
			value,
			type === "terminal"
				? [
						"version",
						"type",
						"parentSessionId",
						"parentSessionFile",
						"childSessionId",
						"childSessionFile",
						"childId",
						"assignmentId",
						"operationId",
						"deliveryId",
						"terminal",
						"message",
						"recordedAt",
					]
				: [
						"version",
						"type",
						"parentSessionId",
						"parentSessionFile",
						"childSessionId",
						"childSessionFile",
						"childId",
						"assignmentId",
						"operationId",
						"deliveryId",
						"terminal",
						"message",
						"receivedAt",
					],
		) ||
		!hasOperationIdentity(value) ||
		typeof value.deliveryId !== "string" ||
		!UUID.test(value.deliveryId) ||
		typeof value.parentSessionFile !== "string" ||
		!isAbsolute(value.parentSessionFile) ||
		typeof value.childSessionId !== "string" ||
		!UUID.test(value.childSessionId) ||
		typeof value.childSessionFile !== "string" ||
		!isAbsolute(value.childSessionFile) ||
		!isBoundedText(value.childId, 256) ||
		typeof value.terminal !== "string" ||
		!TERMINALS.has(value.terminal as RlmChildTerminalStatus)
	)
		return false;
	try {
		assertTerminalMessage(value.message);
	} catch {
		return false;
	}
	return type === "terminal"
		? validStamped(value)
		: typeof value.receivedAt === "string" &&
				value.receivedAt.length <= 64 &&
				!Number.isNaN(Date.parse(value.receivedAt));
}
function validConsumed(value: unknown): boolean {
	if (
		!isObject(value) ||
		value.version !== 1 ||
		!hasOperationIdentity(value) ||
		typeof value.deliveryId !== "string" ||
		!UUID.test(value.deliveryId) ||
		!validStamped(value)
	)
		return false;
	if (value.type === "materialized")
		return (
			exactKeys(value, [
				"version",
				"type",
				"parentSessionId",
				"assignmentId",
				"operationId",
				"deliveryId",
				"sessionMessageId",
				"recordedAt",
			]) &&
			typeof value.sessionMessageId === "string" &&
			value.sessionMessageId === `rlm-terminal-${value.deliveryId}`
		);
	return (
		value.type === "discarded" &&
		exactKeys(value, [
			"version",
			"type",
			"parentSessionId",
			"assignmentId",
			"operationId",
			"deliveryId",
			"reason",
			"recordedAt",
		]) &&
		(value.reason === "parent_mismatch" || value.reason === "superseded_assignment" || value.reason === "deleted")
	);
}
function isBoundedText(value: unknown, maximum: number): value is string {
	return typeof value === "string" && !!value.trim() && value.length <= maximum;
}
function isBoundedInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1024;
}
function isValidModel(value: unknown): boolean {
	return (
		isObject(value) &&
		exactKeys(value, ["provider", "modelId"]) &&
		isBoundedText(value.provider, 256) &&
		isBoundedText(value.modelId, 256)
	);
}
function sameAdmitted(operation: RlmDurableOperation, record: RlmOperationAdmittedRecord): boolean {
	return (
		operation.parentSessionId === record.parentSessionId &&
		operation.parentSessionFile === record.parentSessionFile &&
		operation.childId === record.childId &&
		operation.assignmentId === record.assignmentId &&
		operation.operationId === record.operationId &&
		operation.deliveryId === record.deliveryId &&
		operation.childSessionDir === record.childSessionDir &&
		operation.requestedModel.provider === record.requestedModel.provider &&
		operation.requestedModel.modelId === record.requestedModel.modelId &&
		operation.rlmDepth === record.rlmDepth &&
		operation.rlmMaxDepth === record.rlmMaxDepth
	);
}
