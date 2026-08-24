import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { lock, lockSync } from "proper-lockfile";

const STORE_VERSION = 1 as const;
const JOURNAL_FILE = "message-obligations.jsonl";
const MANIFEST_FILE = "message-obligations.manifest.json";
const GUARD_FILE = "message-obligations.guard";
const DEFAULT_RECOVERY_LIMIT = 32;
const DEFAULT_MAX_ITEMS = 256;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FANOUT = 16;
const DEFAULT_MAX_RETRIES = 7;
const DEFAULT_WAKE_LEASE_MS = 30_000;
const COMPACTION_EVENT_THRESHOLD = 128;
const CHECKPOINT_FILE = "message-obligations.checkpoint.json";

export type SessionMessageLane = "steering" | "followUp";

export interface SessionMessageObligationFence {
	readonly processGeneration: string;
	readonly fencingEpoch: number;
}

export interface SessionMessageRecipientInput {
	readonly deliveryId?: string;
	readonly recipient: string;
	readonly lane: SessionMessageLane;
}

export interface SessionMessageObligationCrashHook {
	readonly beforeDurableCommit?: (input: {
		readonly mutationId: string;
		readonly kind: SessionMessageObligationEventKind;
	}) => void | Promise<void>;
	readonly afterDurableCommit?: (input: {
		readonly mutationId: string;
		readonly kind: SessionMessageObligationEventKind;
		readonly sequence: number;
		readonly eventDigest: string;
	}) => void | Promise<void>;
	readonly afterCheckpointPublication?: (input: {
		readonly mutationId: string;
		readonly kind: SessionMessageObligationEventKind;
		readonly sequence: number;
		readonly eventDigest: string;
	}) => void | Promise<void>;
}

export interface SessionMessageObligationCapacity {
	readonly maxItems?: number;
	readonly maxBytes?: number;
	readonly maxFanout?: number;
	readonly maxRetries?: number;
}

export interface SessionMessageObligationStoreOptions {
	readonly rootDir: string;
	readonly fence: SessionMessageObligationFence;
	readonly capacity?: SessionMessageObligationCapacity;
	readonly now?: () => string;
	readonly wakeLeaseMs?: number;
}

export interface SessionMessageObligationAcceptInput {
	readonly messageId: string;
	readonly observationId: string;
	readonly contentDigest: string;
	readonly content: string;
	readonly recipients: readonly SessionMessageRecipientInput[];
	readonly fence?: SessionMessageObligationFence;
	readonly crashHook?: SessionMessageObligationCrashHook;
	readonly deferOnCapacity?: boolean;
}

export interface SessionMessageDeliveryRecord {
	readonly messageId: string;
	readonly observationId: string;
	readonly contentDigest: string;
	readonly content: string;
	readonly deliveryId: string;
	readonly fence: SessionMessageObligationFence;
	readonly recipient: string;
	readonly lane: SessionMessageLane;
	readonly acceptedState: "accepted";
	readonly accepted: true;
	readonly acceptedAt: string;
	readonly acceptedSequence: number;
	readonly wake: SessionMessageWakeState;
	readonly wakeOwner: SessionMessageWakeOwner | null;
	readonly contextDelivery: SessionMessageContextDeliveryState;
	readonly outcome: SessionMessageObligationOutcome;
	readonly outcomeAt: string | null;
	readonly failureReason: string | null;
	readonly attemptCount: number;
}

export type SessionMessageObligationOutcome = "pending" | "processed" | "failed" | "cancelled" | "expired";
export type SessionMessageWakeState = "unclaimed" | "claimed";

export interface SessionMessageWakeOwner {
	readonly ownerId: string;
	readonly fence: SessionMessageObligationFence;
	readonly claimedAt: string;
}

export type SessionMessageContextDeliveryState =
	| { readonly status: "pending"; readonly claimId: null; readonly deliveredAt: null }
	| {
			readonly status: "claimed";
			readonly claimId: string;
			readonly claimedAt: string;
			readonly deliveredAt: null;
	  }
	| {
			readonly status: "delivered";
			readonly ownerId: string;
			readonly claimId: string;
			readonly claimedAt: string;
			readonly deliveredAt: string;
	  };

export interface SessionMessageObligationAcceptResult {
	readonly status: "accepted" | "idempotent" | "rejected" | "deferred";
	readonly accepted: boolean;
	readonly replayed: boolean;
	readonly messageId: string;
	readonly observationId: string;
	readonly contentDigest: string;
	readonly reservation?: SessionMessageCapacityReservation;
	readonly reason?: SessionMessageObligationCapacityReason;
	readonly obligations: readonly SessionMessageDeliveryRecord[];
}

export interface SessionMessageCapacityReservation {
	readonly itemCount: number;
	readonly byteCount: number;
	readonly fanoutCount: number;
	readonly retryCapacity: number;
}

export type SessionMessageObligationCapacityReason =
	| "capacity_items"
	| "capacity_bytes"
	| "capacity_fanout"
	| "capacity_retries";

export interface SessionMessageObligationMutationInput {
	readonly deliveryId: string;
	readonly ownerId?: string;
	readonly claimId?: string;
	readonly ownerContinuityHandoff?: SessionMessageObligationOwnerContinuityHandoff;
	readonly ownerContinuitySettlement?: SessionMessageObligationOwnerContinuitySettlement;
	readonly reason?: string;
	readonly fence?: SessionMessageObligationFence;
	readonly crashHook?: SessionMessageObligationCrashHook;
}

export interface SessionMessageObligationOwnerContinuityHandoff {
	readonly credential: string;
	readonly deliveryId: string;
	readonly claimId: string;
	readonly predecessorOwnerId: string;
	readonly predecessorFence: SessionMessageObligationFence;
	readonly successorOwnerId: string;
	readonly successorFence: SessionMessageObligationFence;
}

export interface SessionMessageObligationOwnerContinuityHandoffIssueInput {
	readonly deliveryId: string;
	readonly ownerId: string;
	readonly claimId?: string;
	readonly successorOwnerId: string;
	readonly successorFence: SessionMessageObligationFence;
	readonly fence?: SessionMessageObligationFence;
	readonly crashHook?: SessionMessageObligationCrashHook;
}

export interface SessionMessageObligationOwnerContinuityHandoffConsumeInput {
	readonly handoff: SessionMessageObligationOwnerContinuityHandoff;
	readonly ownerId: string;
	readonly fence?: SessionMessageObligationFence;
	readonly crashHook?: SessionMessageObligationCrashHook;
}

export interface SessionMessageObligationOwnerContinuitySettlement {
	readonly handoff: SessionMessageObligationOwnerContinuityHandoff;
	readonly settlementId: string;
}

export interface SessionMessageObligationOwnerContinuityHandoffReissueInput {
	readonly consumedHandoff: SessionMessageObligationOwnerContinuityHandoff;
	readonly successorOwnerId: string;
	readonly successorFence: SessionMessageObligationFence;
	readonly fence?: SessionMessageObligationFence;
	readonly crashHook?: SessionMessageObligationCrashHook;
}

export interface SessionMessageObligationOwnerContinuityHandoffStatus {
	readonly handoff: SessionMessageObligationOwnerContinuityHandoff;
	readonly consumed: boolean;
}

export interface SessionMessageObligationRecoveryOptions {
	readonly limit?: number;
	readonly after?: SessionMessageObligationRecoveryCursor;
}

export interface SessionMessageObligationRecoveryCursor {
	readonly acceptedSequence: number;
	readonly deliveryId: string;
}

export interface SessionMessageObligationSnapshot {
	readonly currentFence: SessionMessageObligationFence;
	readonly messages: readonly SessionMessageRecord[];
	readonly obligations: readonly SessionMessageDeliveryRecord[];
}

export interface SessionMessageRecord {
	readonly messageId: string;
	readonly observationId: string;
	readonly contentDigest: string;
	readonly content: string;
	readonly acceptedAt: string;
	readonly acceptedSequence: number;
	readonly deliveryIds: readonly string[];
}

export interface SessionMessageObligationRotationInput {
	readonly nextFence: SessionMessageObligationFence;
	readonly expectedFence?: SessionMessageObligationFence;
	readonly crashHook?: SessionMessageObligationCrashHook;
}

export interface SessionMessageObligationBridgeFenceInput {
	readonly nextFence: SessionMessageObligationFence;
	readonly ownerId: string;
	readonly ownerContinuityHandoff?: SessionMessageObligationOwnerContinuityHandoff;
	readonly expectedFence?: SessionMessageObligationFence;
}

export type SessionMessageObligationEventKind =
	| "accepted"
	| "fanout_extended"
	| "wake_claimed"
	| "context_claimed"
	| "context_delivered"
	| "owner_handoff_issued"
	| "owner_handoff_consumed"
	| "processed"
	| "failed"
	| "retried"
	| "cancelled"
	| "expired"
	| "generation_rotated";

interface StoredMessage {
	messageId: string;
	observationId: string;
	contentDigest: string;
	content: string;
	acceptedAt: string;
	acceptedSequence: number;
	deliveryIds: string[];
}

interface StoredWakeOwner {
	ownerId: string;
	processGeneration: string;
	fencingEpoch: number;
	claimedAt: string;
}

interface StoredContextPending {
	status: "pending";
	claimId: null;
	claimedAt: null;
	deliveredAt: null;
}

interface StoredContextClaimed {
	status: "claimed";
	claimId: string;
	claimedAt: string;
	deliveredAt: null;
}

interface StoredContextDelivered {
	status: "delivered";
	claimId: string;
	claimedAt: string;
	deliveredAt: string;
}

type StoredContext = StoredContextPending | StoredContextClaimed | StoredContextDelivered;

interface StoredContextDeliveryProof {
	deliveryId: string;
	ownerId: string;
	claimId: string;
	fence: SessionMessageObligationFence;
	deliveredAt: string;
}

interface StoredOwnerContinuityHandoff extends SessionMessageObligationOwnerContinuityHandoff {
	consumed: boolean;
}

interface StoredDelivery {
	messageId: string;
	observationId: string;
	contentDigest: string;
	content: string;
	deliveryId: string;
	processGeneration: string;
	fencingEpoch: number;
	recipient: string;
	lane: SessionMessageLane;
	acceptedAt: string;
	acceptedSequence: number;
	wakeOwner: StoredWakeOwner | null;
	context: StoredContext;
	contextDeliveryProof: StoredContextDeliveryProof | null;
	outcome: SessionMessageObligationOutcome;
	outcomeAt: string | null;
	failureReason: string | null;
	attemptCount: number;
}

interface StoreState {
	currentFence: SessionMessageObligationFence;
	nextSequence: number;
	messages: Map<string, StoredMessage>;
	deliveries: Map<string, StoredDelivery>;
	handoffs: Map<string, StoredOwnerContinuityHandoff>;
}

interface JournalEnvelope {
	readonly version: typeof STORE_VERSION;
	readonly sequence: number;
	readonly mutationId: string;
	readonly kind: SessionMessageObligationEventKind;
	readonly fence: SessionMessageObligationFence;
	readonly data: Record<string, unknown>;
	readonly eventDigest: string;
}

interface Manifest {
	readonly version: typeof STORE_VERSION;
	readonly storeId: string;
	readonly currentFence: SessionMessageObligationFence;
	readonly createdAt: string;
}

interface CheckpointEnvelope {
	readonly version: typeof STORE_VERSION;
	readonly sequence: number;
	readonly fence: SessionMessageObligationFence;
	readonly messages: readonly StoredMessage[];
	readonly deliveries: readonly StoredDelivery[];
	readonly handoffs: readonly StoredOwnerContinuityHandoff[];
	readonly checkpointDigest: string;
}

export class SessionMessageObligationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SessionMessageObligationError";
		this.code = code;
	}
}

export class SessionMessageObligationFenceError extends SessionMessageObligationError {
	constructor(message = "Session message obligation generation or fencing epoch is stale") {
		super("stale_generation", message);
	}
}

export class SessionMessageObligationIntegrityError extends SessionMessageObligationError {
	constructor(message = "Session message obligation has an integrity conflict") {
		super("integrity_conflict", message);
	}
}

export class SessionMessageObligationCapacityError extends SessionMessageObligationError {}

export function sessionMessageContentDigest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
			.join(",")}}`;
	}
	throw new Error("Unsupported canonical journal value");
}

function digestJournalBody(body: unknown): string {
	return createHash("sha256").update(canonicalize(body), "utf8").digest("hex");
}

function cloneFence(fence: SessionMessageObligationFence): SessionMessageObligationFence {
	return { processGeneration: fence.processGeneration, fencingEpoch: fence.fencingEpoch };
}

function cloneStored<T>(value: T): T {
	return structuredClone(value);
}

function freezeDeep<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
	}
	return value;
}

function assertFence(fence: SessionMessageObligationFence, label: string): void {
	if (
		typeof fence.processGeneration !== "string" ||
		fence.processGeneration.trim().length === 0 ||
		!Number.isSafeInteger(fence.fencingEpoch) ||
		fence.fencingEpoch <= 0
	)
		throw new SessionMessageObligationError("invalid_fence", `${label} is invalid`);
}

function assertLane(lane: unknown, label: string): asserts lane is SessionMessageLane {
	if (lane !== "steering" && lane !== "followUp")
		throw new SessionMessageObligationError("invalid_fanout", `${label} is invalid`);
}

function sameFence(left: SessionMessageObligationFence, right: SessionMessageObligationFence): boolean {
	return left.processGeneration === right.processGeneration && left.fencingEpoch === right.fencingEpoch;
}

function cloneOwnerContinuityHandoff(
	handoff: SessionMessageObligationOwnerContinuityHandoff,
): SessionMessageObligationOwnerContinuityHandoff {
	return {
		credential: handoff.credential,
		deliveryId: handoff.deliveryId,
		claimId: handoff.claimId,
		predecessorOwnerId: handoff.predecessorOwnerId,
		predecessorFence: cloneFence(handoff.predecessorFence),
		successorOwnerId: handoff.successorOwnerId,
		successorFence: cloneFence(handoff.successorFence),
	};
}

function sameOwnerContinuityHandoff(
	left: SessionMessageObligationOwnerContinuityHandoff,
	right: SessionMessageObligationOwnerContinuityHandoff,
): boolean {
	return (
		left.credential === right.credential &&
		left.deliveryId === right.deliveryId &&
		left.claimId === right.claimId &&
		left.predecessorOwnerId === right.predecessorOwnerId &&
		sameFence(left.predecessorFence, right.predecessorFence) &&
		left.successorOwnerId === right.successorOwnerId &&
		sameFence(left.successorFence, right.successorFence)
	);
}

function toOwnerContinuityHandoffStatus(
	handoff: StoredOwnerContinuityHandoff,
): SessionMessageObligationOwnerContinuityHandoffStatus {
	return freezeDeep({
		handoff: cloneOwnerContinuityHandoff(handoff),
		consumed: handoff.consumed,
	});
}

function assertOwnerContinuityHandoff(handoff: SessionMessageObligationOwnerContinuityHandoff, label: string): void {
	if (
		handoff === null ||
		typeof handoff !== "object" ||
		typeof handoff.credential !== "string" ||
		handoff.credential.trim().length === 0 ||
		typeof handoff.deliveryId !== "string" ||
		handoff.deliveryId.trim().length === 0 ||
		typeof handoff.claimId !== "string" ||
		handoff.claimId.trim().length === 0 ||
		typeof handoff.predecessorOwnerId !== "string" ||
		handoff.predecessorOwnerId.trim().length === 0 ||
		typeof handoff.successorOwnerId !== "string" ||
		handoff.successorOwnerId.trim().length === 0
	)
		throw new SessionMessageObligationError("owner_continuity_invalid", `${label} is invalid`);
	assertFence(handoff.predecessorFence, `${label} predecessor fence`);
	assertFence(handoff.successorFence, `${label} successor fence`);
	if (
		handoff.successorFence.fencingEpoch <= handoff.predecessorFence.fencingEpoch ||
		handoff.successorFence.processGeneration === handoff.predecessorFence.processGeneration
	)
		throw new SessionMessageObligationError(
			"owner_continuity_invalid",
			`${label} successor fence must advance to a new process generation`,
		);
}

function normalizeCapacity(options: SessionMessageObligationStoreOptions): Required<SessionMessageObligationCapacity> {
	const candidate = options.capacity ?? {};
	const result = {
		maxItems: candidate.maxItems ?? DEFAULT_MAX_ITEMS,
		maxBytes: candidate.maxBytes ?? DEFAULT_MAX_BYTES,
		maxFanout: candidate.maxFanout ?? DEFAULT_MAX_FANOUT,
		maxRetries: candidate.maxRetries ?? DEFAULT_MAX_RETRIES,
	};
	for (const [name, value] of Object.entries(result)) {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new SessionMessageObligationError("invalid_capacity", `${name} is invalid`);
	}
	return result;
}

function normalizeRoot(rootDir: string): string {
	if (rootDir.trim().length === 0 || rootDir.includes("\0"))
		throw new SessionMessageObligationError("invalid_root", "A durable session artifact root is required");
	return resolve(rootDir);
}

function normalizeIdentity(input: SessionMessageObligationAcceptInput): { messageId: string; observationId: string } {
	if (input.messageId.trim().length === 0 || input.observationId.trim().length === 0)
		throw new SessionMessageObligationError("invalid_message", "A stable message or observation id is required");
	return { messageId: input.messageId, observationId: input.observationId };
}

function normalizeContent(content: string): string {
	if (content.length === 0) throw new SessionMessageObligationError("invalid_message", "Message content is required");
	return content;
}

function normalizeDigest(contentDigest: string, content: string): string {
	if (contentDigest.trim().length === 0)
		throw new SessionMessageObligationError("invalid_message", "Message content digest is required");
	if (contentDigest !== sessionMessageContentDigest(content))
		throw new SessionMessageObligationIntegrityError("Message content digest does not match content");
	return contentDigest;
}

function normalizeRecipients(
	recipients: readonly SessionMessageRecipientInput[],
	messageId: string,
): SessionMessageRecipientInput[] {
	if (recipients.length === 0)
		throw new SessionMessageObligationError("invalid_fanout", "At least one recipient is required");
	const ids = new Set<string>();
	return recipients.map((recipient) => {
		assertLane(recipient.lane, "Recipient lane");
		if (
			recipient.recipient.trim().length === 0 ||
			(recipient.deliveryId !== undefined && recipient.deliveryId.trim().length === 0)
		)
			throw new SessionMessageObligationError("invalid_fanout", "Recipient and lane are required");
		const deliveryId =
			recipient.deliveryId ??
			`${messageId}:${sessionMessageContentDigest(`${recipient.recipient}\0${recipient.lane}`).slice(0, 16)}`;
		if (ids.has(deliveryId))
			throw new SessionMessageObligationError("invalid_fanout", `Duplicate delivery id: ${deliveryId}`);
		ids.add(deliveryId);
		return { deliveryId, recipient: recipient.recipient, lane: recipient.lane };
	});
}

function nowString(now: (() => string) | undefined): string {
	return now?.() ?? new Date().toISOString();
}

function messageIdentityMatches(message: StoredMessage, messageId: string, observationId: string): boolean {
	return message.messageId === messageId || message.observationId === observationId;
}

type RecoveryTuple = Pick<SessionMessageDeliveryRecord, "acceptedSequence" | "deliveryId">;

function compareRecoveryTuple(left: RecoveryTuple, right: RecoveryTuple): number {
	if (left.acceptedSequence !== right.acceptedSequence) return left.acceptedSequence < right.acceptedSequence ? -1 : 1;
	if (left.deliveryId === right.deliveryId) return 0;
	return left.deliveryId < right.deliveryId ? -1 : 1;
}

function sameRoute(
	left: Pick<SessionMessageRecipientInput, "deliveryId" | "recipient" | "lane">,
	right: StoredDelivery,
): boolean {
	return left.deliveryId === right.deliveryId && left.recipient === right.recipient && left.lane === right.lane;
}

function isTerminal(outcome: SessionMessageObligationOutcome): boolean {
	return outcome !== "pending";
}

function toContextRecord(
	context: StoredContext,
	proof: StoredContextDeliveryProof | null,
): SessionMessageContextDeliveryState {
	if (context.status === "delivered") return { ...cloneStored(context), ownerId: proof!.ownerId };
	return cloneStored(context) as SessionMessageContextDeliveryState;
}

function toDeliveryRecord(delivery: StoredDelivery): SessionMessageDeliveryRecord {
	return freezeDeep({
		messageId: delivery.messageId,
		observationId: delivery.observationId,
		contentDigest: delivery.contentDigest,
		content: delivery.content,
		deliveryId: delivery.deliveryId,
		fence: { processGeneration: delivery.processGeneration, fencingEpoch: delivery.fencingEpoch },
		recipient: delivery.recipient,
		lane: delivery.lane,
		acceptedState: "accepted" as const,
		accepted: true as const,
		acceptedAt: delivery.acceptedAt,
		acceptedSequence: delivery.acceptedSequence,
		wake: delivery.wakeOwner === null ? "unclaimed" : "claimed",
		wakeOwner:
			delivery.wakeOwner === null
				? null
				: {
						ownerId: delivery.wakeOwner.ownerId,
						fence: {
							processGeneration: delivery.wakeOwner.processGeneration,
							fencingEpoch: delivery.wakeOwner.fencingEpoch,
						},
						claimedAt: delivery.wakeOwner.claimedAt,
					},
		contextDelivery: toContextRecord(delivery.context, delivery.contextDeliveryProof),
		outcome: delivery.outcome,
		outcomeAt: delivery.outcomeAt,
		failureReason: delivery.failureReason,
		attemptCount: delivery.attemptCount,
	});
}

function assertContextDeliveryProof(delivery: StoredDelivery, label: string): void {
	if (delivery.context.status !== "delivered") {
		if (delivery.contextDeliveryProof !== null)
			throw new SessionMessageObligationError(
				"corrupt_store",
				`${label} has a delivery proof before context delivery`,
			);
		return;
	}
	const proof = delivery.contextDeliveryProof;
	if (
		proof === null ||
		typeof proof !== "object" ||
		typeof proof.ownerId !== "string" ||
		proof.ownerId.trim().length === 0 ||
		proof.fence === undefined ||
		proof.deliveryId !== delivery.deliveryId ||
		proof.claimId !== delivery.context.claimId ||
		proof.deliveredAt !== delivery.context.deliveredAt
	)
		throw new SessionMessageObligationError(
			"corrupt_store",
			`${label} does not match its durable context delivery history`,
		);
	assertFence(proof.fence, `${label} fence`);
}

function toMessageRecord(message: StoredMessage): SessionMessageRecord {
	return freezeDeep(cloneStored(message));
}

function emptyState(fence: SessionMessageObligationFence): StoreState {
	return {
		currentFence: cloneFence(fence),
		nextSequence: 0,
		messages: new Map(),
		deliveries: new Map(),
		handoffs: new Map(),
	};
}

function parseManifest(path: string): Manifest | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Manifest>;
		if (
			value.version !== STORE_VERSION ||
			typeof value.storeId !== "string" ||
			typeof value.createdAt !== "string" ||
			value.currentFence === undefined
		)
			throw new Error("invalid manifest");
		assertFence(value.currentFence, "manifest current fence");
		return value as Manifest;
	} catch (error) {
		throw new SessionMessageObligationError(
			"corrupt_store",
			`Cannot read durable obligation manifest: ${String(error)}`,
		);
	}
}

function writeManifest(rootDir: string, manifest: Manifest): void {
	const path = join(rootDir, MANIFEST_FILE);
	const tempPath = join(rootDir, `.${MANIFEST_FILE}.${process.pid}.${randomUUID()}.tmp`);
	const descriptor = openSync(tempPath, "w", 0o600);
	try {
		const bytes = Buffer.from(`${canonicalize(manifest)}\n`, "utf8");
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	try {
		renameSync(tempPath, path);
	} finally {
		rmSync(tempPath, { force: true });
	}
	syncDirectory(rootDir);
}

function writeCheckpoint(rootDir: string, state: StoreState): void {
	const body = {
		version: STORE_VERSION,
		sequence: state.nextSequence,
		fence: cloneFence(state.currentFence),
		messages: [...state.messages.values()].map(cloneStored),
		deliveries: [...state.deliveries.values()].map(cloneStored),
		handoffs: [...state.handoffs.values()].map(cloneStored),
	};
	const checkpoint: CheckpointEnvelope = { ...body, checkpointDigest: digestJournalBody(body) };
	const path = join(rootDir, CHECKPOINT_FILE);
	const tempPath = join(rootDir, `.${CHECKPOINT_FILE}.${process.pid}.${randomUUID()}.tmp`);
	const descriptor = openSync(tempPath, "w", 0o600);
	try {
		writeFileSync(descriptor, `${canonicalize(checkpoint)}\n`, { encoding: "utf8" });
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	try {
		renameSync(tempPath, path);
	} finally {
		rmSync(tempPath, { force: true });
	}
	syncDirectory(rootDir);
}

function compactJournal(rootDir: string): void {
	const path = join(rootDir, JOURNAL_FILE);
	const tempPath = join(rootDir, `.${JOURNAL_FILE}.${process.pid}.${randomUUID()}.tmp`);
	const descriptor = openSync(tempPath, "w", 0o600);
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	try {
		renameSync(tempPath, path);
	} finally {
		rmSync(tempPath, { force: true });
	}
	syncDirectory(rootDir);
}

function parseCheckpoint(path: string): CheckpointEnvelope | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CheckpointEnvelope>;
		if (
			value.version !== STORE_VERSION ||
			!Number.isSafeInteger(value.sequence) ||
			(value.sequence as number) < 0 ||
			value.fence === undefined ||
			!Array.isArray(value.messages) ||
			!Array.isArray(value.deliveries) ||
			typeof value.checkpointDigest !== "string"
		)
			throw new Error("invalid checkpoint");
		assertFence(value.fence, "checkpoint fence");
		const body = {
			version: value.version,
			sequence: value.sequence,
			fence: value.fence,
			messages: value.messages,
			deliveries: value.deliveries,
			handoffs: value.handoffs ?? [],
		};
		if (digestJournalBody(body) !== value.checkpointDigest) throw new Error("checkpoint digest mismatch");
		return { ...value, handoffs: value.handoffs ?? [] } as CheckpointEnvelope;
	} catch (error) {
		throw new SessionMessageObligationError(
			"corrupt_store",
			`Cannot read durable obligation checkpoint: ${String(error)}`,
		);
	}
}

function loadCheckpoint(rootDir: string, state: StoreState): void {
	const checkpoint = parseCheckpoint(join(rootDir, CHECKPOINT_FILE));
	if (checkpoint === undefined) return;
	state.currentFence = cloneFence(checkpoint.fence);
	state.nextSequence = checkpoint.sequence;
	for (const message of checkpoint.messages) {
		if (
			typeof message.messageId !== "string" ||
			typeof message.observationId !== "string" ||
			typeof message.content !== "string" ||
			typeof message.contentDigest !== "string" ||
			message.contentDigest !== sessionMessageContentDigest(message.content) ||
			!Array.isArray(message.deliveryIds) ||
			state.messages.has(message.messageId)
		)
			throw new SessionMessageObligationError("corrupt_store", "Checkpoint message payload is invalid");
		state.messages.set(message.messageId, cloneStored(message));
	}
	for (const candidate of checkpoint.deliveries) {
		if (
			typeof candidate.deliveryId !== "string" ||
			typeof candidate.messageId !== "string" ||
			typeof candidate.observationId !== "string" ||
			typeof candidate.content !== "string" ||
			candidate.contentDigest !== sessionMessageContentDigest(candidate.content) ||
			state.deliveries.has(candidate.deliveryId)
		)
			throw new SessionMessageObligationError("corrupt_store", "Checkpoint delivery payload is invalid");
		assertLane(candidate.lane, "Checkpoint delivery lane");
		const delivery = cloneStored(candidate);
		assertContextDeliveryProof(delivery, "Checkpoint delivery context");
		state.deliveries.set(candidate.deliveryId, delivery);
	}
	for (const candidate of checkpoint.handoffs) {
		assertOwnerContinuityHandoff(candidate, "Checkpoint owner continuity handoff");
		if (typeof candidate.consumed !== "boolean" || state.handoffs.has(candidate.credential))
			throw new SessionMessageObligationError("corrupt_store", "Checkpoint owner continuity handoff is invalid");
		state.handoffs.set(candidate.credential, cloneStored(candidate));
	}
	for (const message of state.messages.values())
		for (const deliveryId of message.deliveryIds) {
			const delivery = state.deliveries.get(deliveryId);
			if (delivery === undefined || delivery.messageId !== message.messageId)
				throw new SessionMessageObligationError("corrupt_store", "Checkpoint message route is invalid");
		}
}

function syncDirectory(rootDir: string): void {
	try {
		const directoryDescriptor = openSync(rootDir, "r");
		try {
			fsyncSync(directoryDescriptor);
		} finally {
			closeSync(directoryDescriptor);
		}
	} catch {
		// Some platforms do not permit fsync on directory descriptors.
	}
}

function parseEventLine(line: string, path: string): JournalEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new SessionMessageObligationError(
			"corrupt_store",
			`Cannot parse durable obligation event in ${path}: ${String(error)}`,
		);
	}
	if (value === null || typeof value !== "object")
		throw new SessionMessageObligationError("corrupt_store", "Durable obligation event is not an object");
	const event = value as Partial<JournalEnvelope>;
	if (
		event.version !== STORE_VERSION ||
		typeof event.sequence !== "number" ||
		!Number.isSafeInteger(event.sequence) ||
		event.sequence <= 0 ||
		typeof event.mutationId !== "string" ||
		typeof event.kind !== "string" ||
		event.fence === undefined ||
		event.data === undefined ||
		typeof event.eventDigest !== "string"
	)
		throw new SessionMessageObligationError("corrupt_store", "Durable obligation event shape is invalid");
	assertFence(event.fence, "event fence");
	const sequence = event.sequence as number;
	const eventDigest = event.eventDigest as string;
	const data = event.data as Record<string, unknown>;
	const body = {
		version: event.version,
		sequence,
		mutationId: event.mutationId,
		kind: event.kind as SessionMessageObligationEventKind,
		fence: event.fence,
		data,
	};
	if (digestJournalBody(body) !== eventDigest)
		throw new SessionMessageObligationError("corrupt_store", "Durable obligation event digest mismatch");
	return event as JournalEnvelope;
}

function buildEvent(
	sequence: number,
	mutationId: string,
	kind: SessionMessageObligationEventKind,
	fence: SessionMessageObligationFence,
	data: Record<string, unknown>,
): JournalEnvelope {
	const body = { version: STORE_VERSION, sequence, mutationId, kind, fence: cloneFence(fence), data };
	return { ...body, eventDigest: digestJournalBody(body) };
}

function appendEvent(rootDir: string, event: JournalEnvelope): void {
	const path = join(rootDir, JOURNAL_FILE);
	const descriptor = openSync(path, "a", 0o600);
	try {
		writeFileSync(descriptor, `${canonicalize(event)}\n`, { encoding: "utf8" });
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	syncDirectory(rootDir);
}

function readJournal(rootDir: string, state: StoreState): void {
	const path = join(rootDir, JOURNAL_FILE);
	if (!existsSync(path)) return;
	const contents = readFileSync(path, "utf8");
	const lines = contents.split("\n");
	const hasFinalNewline = contents.endsWith("\n");
	const checkpointSequence = state.nextSequence;
	let byteOffset = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const lineStart = byteOffset;
		const hasNewline = index < lines.length - 1;
		byteOffset += Buffer.byteLength(line, "utf8") + (hasNewline ? 1 : 0);
		const isLastPartialLine = !hasFinalNewline && index === lines.length - 1;
		if (line.trim().length === 0) {
			if (isLastPartialLine) repairJournalTail(path, false, lineStart);
			continue;
		}
		try {
			const event = parseEventLine(line, path);
			if (event.sequence <= checkpointSequence) {
				if (!isLastPartialLine) continue;
				repairJournalTail(path, true, lineStart);
				return;
			}
			if (event.sequence !== state.nextSequence + 1)
				throw new SessionMessageObligationError("corrupt_store", "Durable obligation sequence is not monotonic");
			if (state.nextSequence === 0) state.currentFence = cloneFence(event.fence);
			if (!sameFence(event.fence, state.currentFence))
				throw new SessionMessageObligationError("corrupt_store", "Durable obligation event fence is stale");
			applyEvent(state, event);
			state.nextSequence = event.sequence;
			if (isLastPartialLine) {
				repairJournalTail(path, true, lineStart);
				return;
			}
		} catch (error) {
			if (
				isLastPartialLine &&
				error instanceof SessionMessageObligationError &&
				error.code === "corrupt_store" &&
				error.message.startsWith("Cannot parse durable obligation event")
			) {
				repairJournalTail(path, false, lineStart);
				return;
			}
			throw error;
		}
	}
}

function repairJournalTail(path: string, appendNewline: boolean, truncateOffset: number): void {
	const descriptor = openSync(path, appendNewline ? "a" : "r+");
	try {
		if (appendNewline) writeFileSync(descriptor, "\n", { encoding: "utf8" });
		else ftruncateSync(descriptor, truncateOffset);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function requiredString(data: Record<string, unknown>, key: string): string {
	const value = data[key];
	if (typeof value !== "string" || value.length === 0)
		throw new SessionMessageObligationError("corrupt_store", `Event field ${key} is invalid`);
	return value;
}

function requiredNumber(data: Record<string, unknown>, key: string): number {
	const value = data[key];
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new SessionMessageObligationError("corrupt_store", `Event field ${key} is invalid`);
	return value as number;
}

function requiredDelivery(state: StoreState, data: Record<string, unknown>): StoredDelivery {
	const deliveryId = requiredString(data, "deliveryId");
	const delivery = state.deliveries.get(deliveryId);
	if (delivery === undefined)
		throw new SessionMessageObligationError("corrupt_store", `Unknown delivery ${deliveryId}`);
	return delivery;
}

function requiredOwner(data: Record<string, unknown>): StoredWakeOwner {
	const owner = data.owner;
	if (owner === null || typeof owner !== "object")
		throw new SessionMessageObligationError("corrupt_store", "Event wake owner is invalid");
	const candidate = owner as Partial<StoredWakeOwner>;
	if (
		typeof candidate.ownerId !== "string" ||
		typeof candidate.processGeneration !== "string" ||
		!Number.isSafeInteger(candidate.fencingEpoch) ||
		typeof candidate.claimedAt !== "string" ||
		!Number.isFinite(Date.parse(candidate.claimedAt))
	)
		throw new SessionMessageObligationError("corrupt_store", "Event wake owner is invalid");
	const ownerValue = candidate as StoredWakeOwner;
	assertFence(
		{ processGeneration: ownerValue.processGeneration, fencingEpoch: ownerValue.fencingEpoch },
		"event wake owner fence",
	);
	return ownerValue;
}

function applyEvent(state: StoreState, event: JournalEnvelope): void {
	const data = event.data;
	switch (event.kind) {
		case "accepted": {
			const message = data.message;
			const deliveries = data.deliveries;
			if (message === null || typeof message !== "object" || !Array.isArray(deliveries))
				throw new SessionMessageObligationError("corrupt_store", "Accepted event payload is invalid");
			const value = message as StoredMessage;
			if (
				typeof value.messageId !== "string" ||
				typeof value.observationId !== "string" ||
				typeof value.contentDigest !== "string" ||
				typeof value.content !== "string" ||
				value.contentDigest !== sessionMessageContentDigest(value.content) ||
				!Array.isArray(value.deliveryIds)
			)
				throw new SessionMessageObligationError("corrupt_store", "Accepted message payload is invalid");
			if (state.messages.has(value.messageId))
				throw new SessionMessageObligationError("corrupt_store", "Accepted message is duplicated");
			for (const candidate of deliveries) {
				if (candidate === null || typeof candidate !== "object")
					throw new SessionMessageObligationError("corrupt_store", "Accepted delivery payload is invalid");
				const delivery = candidate as StoredDelivery;
				if (
					typeof delivery.deliveryId !== "string" ||
					state.deliveries.has(delivery.deliveryId) ||
					delivery.messageId !== value.messageId ||
					delivery.observationId !== value.observationId ||
					delivery.content !== value.content ||
					delivery.contentDigest !== value.contentDigest
				)
					throw new SessionMessageObligationError("corrupt_store", "Accepted delivery is duplicated");
				assertLane(delivery.lane, "Accepted delivery lane");
				const storedDelivery = cloneStored(delivery);
				assertContextDeliveryProof(storedDelivery, "Accepted delivery context");
				state.deliveries.set(delivery.deliveryId, storedDelivery);
			}
			state.messages.set(value.messageId, cloneStored(value));
			return;
		}
		case "fanout_extended": {
			const messageId = requiredString(data, "messageId");
			const message = state.messages.get(messageId);
			const deliveries = data.deliveries;
			if (message === undefined || !Array.isArray(deliveries))
				throw new SessionMessageObligationError("corrupt_store", "Fanout extension payload is invalid");
			for (const candidate of deliveries) {
				if (candidate === null || typeof candidate !== "object")
					throw new SessionMessageObligationError("corrupt_store", "Fanout delivery payload is invalid");
				const delivery = candidate as StoredDelivery;
				if (
					typeof delivery.deliveryId !== "string" ||
					state.deliveries.has(delivery.deliveryId) ||
					delivery.messageId !== message.messageId ||
					delivery.observationId !== message.observationId ||
					delivery.content !== message.content ||
					delivery.contentDigest !== message.contentDigest
				)
					throw new SessionMessageObligationError("corrupt_store", "Fanout delivery is duplicated or invalid");
				assertLane(delivery.lane, "Fanout delivery lane");
				const storedDelivery = cloneStored(delivery);
				assertContextDeliveryProof(storedDelivery, "Fanout delivery context");
				state.deliveries.set(delivery.deliveryId, storedDelivery);
				message.deliveryIds.push(delivery.deliveryId);
			}
			return;
		}
		case "wake_claimed": {
			const delivery = requiredDelivery(state, data);
			if (delivery.outcome !== "pending" && delivery.outcome !== "failed")
				throw new SessionMessageObligationError("corrupt_store", "Wake claim transition is not monotonic");
			const attemptCount = requiredNumber(data, "attemptCount");
			if (attemptCount < delivery.attemptCount)
				throw new SessionMessageObligationError("corrupt_store", "Wake attempt count regressed");
			const wakeOwner = requiredOwner(data);
			if (!sameFence(wakeOwner, event.fence))
				throw new SessionMessageObligationError(
					"corrupt_store",
					"Wake claim owner fence does not match event fence",
				);
			delivery.wakeOwner = wakeOwner;
			delivery.attemptCount = attemptCount;
			if (data.reclaim === true && delivery.context.status === "claimed") {
				delivery.context = { status: "pending", claimId: null, claimedAt: null, deliveredAt: null };
				delivery.contextDeliveryProof = null;
			}
			return;
		}
		case "context_claimed": {
			const delivery = requiredDelivery(state, data);
			if (delivery.context.status !== "pending")
				throw new SessionMessageObligationError("corrupt_store", "Context claim transition is not monotonic");
			if (delivery.wakeOwner === null || !sameFence(delivery.wakeOwner, event.fence))
				throw new SessionMessageObligationError("corrupt_store", "Context claim has no matching wake owner");
			const claimId = requiredString(data, "claimId");
			const claimedAt = requiredString(data, "claimedAt");
			delivery.context = { status: "claimed", claimId, claimedAt, deliveredAt: null };
			delivery.contextDeliveryProof = null;
			return;
		}
		case "context_delivered": {
			const delivery = requiredDelivery(state, data);
			const deliveredAt = requiredString(data, "deliveredAt");
			if (delivery.context.status !== "claimed")
				throw new SessionMessageObligationError("corrupt_store", "Context delivery transition is not monotonic");
			const claimId = requiredString(data, "claimId");
			const claimedAt = requiredString(data, "claimedAt");
			const ownerId = requiredString(data, "ownerId");
			if (
				claimId !== delivery.context.claimId ||
				claimedAt !== delivery.context.claimedAt ||
				delivery.wakeOwner === null ||
				delivery.wakeOwner.ownerId !== ownerId ||
				!sameFence(delivery.wakeOwner, event.fence)
			)
				throw new SessionMessageObligationError("corrupt_store", "Context delivery claim does not match");
			delivery.context = { ...delivery.context, status: "delivered", deliveredAt };
			delivery.contextDeliveryProof = {
				deliveryId: requiredString(data, "deliveryId"),
				ownerId,
				claimId,
				fence: cloneFence(event.fence),
				deliveredAt,
			};
			assertContextDeliveryProof(delivery, "Context delivery");
			return;
		}
		case "owner_handoff_issued": {
			const delivery = requiredDelivery(state, data);
			const value = data.handoff;
			if (value === null || typeof value !== "object")
				throw new SessionMessageObligationError("corrupt_store", "Owner continuity handoff payload is invalid");
			const handoff = value as StoredOwnerContinuityHandoff;
			assertOwnerContinuityHandoff(handoff, "Owner continuity handoff event");
			const recovery = data.recovery === true;
			if (
				handoff.deliveryId !== delivery.deliveryId ||
				handoff.predecessorOwnerId !== requiredString(data, "predecessorOwnerId") ||
				(recovery
					? !sameFence(handoff.successorFence, event.fence)
					: !sameFence(handoff.predecessorFence, event.fence)) ||
				(!recovery && handoff.successorFence.fencingEpoch <= event.fence.fencingEpoch) ||
				(recovery && !sameFence(handoff.predecessorFence, delivery.contextDeliveryProof?.fence ?? event.fence)) ||
				handoff.consumed !== false ||
				state.handoffs.has(handoff.credential)
			)
				throw new SessionMessageObligationError("corrupt_store", "Owner continuity handoff binding is invalid");
			if (delivery.context.status !== "delivered")
				throw new SessionMessageObligationError(
					"corrupt_store",
					"Owner continuity handoff has no context delivery",
				);
			assertContextDeliveryProof(delivery, "Owner continuity handoff context");
			if (
				delivery.contextDeliveryProof!.ownerId !== handoff.predecessorOwnerId ||
				delivery.contextDeliveryProof!.claimId !== handoff.claimId ||
				delivery.contextDeliveryProof!.fence.processGeneration !== handoff.predecessorFence.processGeneration ||
				delivery.contextDeliveryProof!.fence.fencingEpoch !== handoff.predecessorFence.fencingEpoch
			)
				throw new SessionMessageObligationError("corrupt_store", "Owner continuity handoff claim is invalid");
			state.handoffs.set(handoff.credential, cloneStored(handoff));
			return;
		}
		case "owner_handoff_consumed": {
			const credential = requiredString(data, "credential");
			const handoff = state.handoffs.get(credential);
			if (handoff === undefined || handoff.consumed)
				throw new SessionMessageObligationError("corrupt_store", "Owner continuity handoff was consumed twice");
			const ownerId = requiredString(data, "ownerId");
			if (ownerId !== handoff.successorOwnerId || !sameFence(handoff.successorFence, event.fence))
				throw new SessionMessageObligationError("corrupt_store", "Owner continuity handoff successor is invalid");
			handoff.consumed = true;
			return;
		}
		case "processed":
		case "failed":
		case "cancelled":
		case "expired": {
			const delivery = requiredDelivery(state, data);
			if (delivery.outcome !== "pending")
				throw new SessionMessageObligationError("corrupt_store", "Outcome transition is not monotonic");
			if (event.kind === "processed" && delivery.context.status !== "delivered")
				throw new SessionMessageObligationError("corrupt_store", "Processed delivery has no context delivery");
			if (delivery.context.status === "delivered") assertContextDeliveryProof(delivery, "Outcome delivery context");
			delivery.outcome = event.kind === "processed" ? "processed" : event.kind;
			delivery.outcomeAt = requiredString(data, "outcomeAt");
			delivery.failureReason = typeof data.reason === "string" ? data.reason : null;
			return;
		}
		case "retried": {
			const delivery = requiredDelivery(state, data);
			if (delivery.outcome !== "failed")
				throw new SessionMessageObligationError("corrupt_store", "Retry transition is not monotonic");
			delivery.outcome = "pending";
			delivery.outcomeAt = null;
			delivery.failureReason = typeof data.reason === "string" ? data.reason : null;
			delivery.wakeOwner = null;
			delivery.context = { status: "pending", claimId: null, claimedAt: null, deliveredAt: null };
			delivery.contextDeliveryProof = null;
			return;
		}
		case "generation_rotated": {
			const nextFence = data.nextFence;
			if (nextFence === null || typeof nextFence !== "object")
				throw new SessionMessageObligationError("corrupt_store", "Generation rotation fence is invalid");
			assertFence(nextFence as SessionMessageObligationFence, "generation rotation fence");
			if (
				(nextFence as SessionMessageObligationFence).fencingEpoch <= state.currentFence.fencingEpoch ||
				(nextFence as SessionMessageObligationFence).processGeneration === state.currentFence.processGeneration
			)
				throw new SessionMessageObligationError("corrupt_store", "Generation rotation is not monotonic");
			state.currentFence = cloneFence(nextFence as SessionMessageObligationFence);
			return;
		}
		default:
			throw new SessionMessageObligationError("corrupt_store", `Unknown durable obligation event: ${event.kind}`);
	}
}

export class SessionMessageObligationStore {
	readonly rootDir: string;
	private readonly expectedFence: SessionMessageObligationFence;
	private readonly capacity: Required<SessionMessageObligationCapacity>;
	private readonly now: () => string;
	private readonly wakeLeaseMs: number;
	private readonly ownerContinuitySettlements = new Map<string, string>();
	private closed = false;

	constructor(options: SessionMessageObligationStoreOptions) {
		assertFence(options.fence, "fence");
		this.rootDir = normalizeRoot(options.rootDir);
		const wakeLeaseMs = options.wakeLeaseMs ?? DEFAULT_WAKE_LEASE_MS;
		if (!Number.isSafeInteger(wakeLeaseMs) || wakeLeaseMs <= 0)
			throw new SessionMessageObligationError("invalid_wake_lease", "wakeLeaseMs must be positive");
		mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
		const release = lockSync(this.rootDir, {
			realpath: false,
			lockfilePath: join(this.rootDir, GUARD_FILE),
			stale: 5_000,
		});
		try {
			const existing = parseManifest(join(this.rootDir, MANIFEST_FILE));
			const configuredFence = cloneFence(options.fence);
			const recoveredState = emptyState(existing?.currentFence ?? configuredFence);
			loadCheckpoint(this.rootDir, recoveredState);
			readJournal(this.rootDir, recoveredState);
			const currentFence = recoveredState.currentFence;
			if (existing === undefined || !sameFence(existing.currentFence, currentFence))
				writeManifest(this.rootDir, {
					version: STORE_VERSION,
					storeId: sessionMessageContentDigest(this.rootDir).slice(0, 24),
					currentFence,
					createdAt: existing?.createdAt ?? new Date().toISOString(),
				});
			this.expectedFence = configuredFence;
		} finally {
			release();
		}
		this.capacity = normalizeCapacity(options);
		this.now = options.now ?? (() => new Date().toISOString());
		this.wakeLeaseMs = wakeLeaseMs;
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	async read(): Promise<SessionMessageObligationSnapshot> {
		return this.withGuard(async (state) => this.snapshot(state));
	}

	async getMessage(messageId: string): Promise<SessionMessageRecord | undefined> {
		return this.withGuard(async (state) => {
			const message = state.messages.get(messageId);
			return message === undefined ? undefined : toMessageRecord(message);
		});
	}

	async getObligation(deliveryId: string): Promise<SessionMessageDeliveryRecord | undefined> {
		return this.withGuard(async (state) => {
			const delivery = state.deliveries.get(deliveryId);
			return delivery === undefined ? undefined : toDeliveryRecord(delivery);
		});
	}

	async getOwnerContinuityHandoff(
		handoff: SessionMessageObligationOwnerContinuityHandoff,
	): Promise<SessionMessageObligationOwnerContinuityHandoffStatus | undefined> {
		assertOwnerContinuityHandoff(handoff, "Owner continuity handoff");
		return this.withGuard(async (state) => {
			const stored = state.handoffs.get(handoff.credential);
			if (stored === undefined) return undefined;
			if (!sameOwnerContinuityHandoff(stored, handoff))
				throw new SessionMessageObligationError(
					"owner_continuity_invalid",
					"Owner continuity handoff binding differs",
				);
			return toOwnerContinuityHandoffStatus(stored);
		});
	}

	/**
	 * Report whether an active delivered obligation is waiting on owner continuity.
	 * Return: True when a pending delivery has a matching durable handoff.
	 */
	async hasPendingOwnerContinuityHandoff(): Promise<boolean> {
		return this.withGuard(async (state) => this.pendingOwnerContinuityHandoffs(state).length > 0);
	}

	/**
	 * Validate bridge startup ownership and rotate the durable fence atomically.
	 * Args:
	 * input: Expected successor fence and optional store-issued successor handoff.
	 * Return: The fence that the bridge must reopen with.
	 */
	async prepareBridgeFence(input: SessionMessageObligationBridgeFenceInput): Promise<SessionMessageObligationFence> {
		assertFence(input.nextFence, "next fence");
		if (input.ownerId.trim().length === 0)
			throw new SessionMessageObligationError("invalid_owner", "Bridge owner id is required");
		if (input.ownerContinuityHandoff !== undefined)
			assertOwnerContinuityHandoff(input.ownerContinuityHandoff, "Bridge owner continuity handoff");
		return this.withGuard(async (state) => {
			const pending = this.pendingOwnerContinuityHandoffs(state);
			const handoff = input.ownerContinuityHandoff;
			if (handoff !== undefined) {
				const stored = state.handoffs.get(handoff.credential);
				if (stored === undefined || !sameOwnerContinuityHandoff(stored, handoff))
					throw new SessionMessageObligationError(
						"owner_continuity_invalid",
						"Bridge owner continuity handoff is not authentic",
					);
				if (stored.successorOwnerId !== input.ownerId)
					throw new SessionMessageObligationError(
						"owner_continuity_invalid",
						"Bridge owner continuity handoff successor owner is not authorized",
					);
				if (stored.consumed)
					throw new SessionMessageObligationError(
						"owner_continuity_used",
						"Bridge owner continuity handoff was already consumed",
					);
				if (pending.some((candidate) => candidate.credential !== stored.credential))
					throw new SessionMessageObligationError(
						"owner_continuity_required",
						"Another pending owner continuity handoff must be resumed first",
					);
				if (sameFence(state.currentFence, stored.successorFence)) {
					if (!sameFence(input.nextFence, stored.successorFence))
						throw new SessionMessageObligationFenceError(
							"Bridge successor fence does not match its owner continuity handoff",
						);
					return cloneFence(state.currentFence);
				}
				this.assertMutationFence(state, input.expectedFence);
				if (
					!sameFence(state.currentFence, stored.predecessorFence) ||
					!sameFence(input.nextFence, stored.successorFence)
				)
					throw new SessionMessageObligationFenceError(
						"Bridge successor fence does not match its owner continuity handoff",
					);
			} else {
				this.assertMutationFence(state, input.expectedFence);
				if (pending.length > 0)
					throw new SessionMessageObligationError(
						"owner_continuity_required",
						"Owner continuity successor intent is required before rotating the obligation fence",
					);
				if (sameFence(state.currentFence, input.nextFence)) return cloneFence(state.currentFence);
			}
			if (
				input.nextFence.fencingEpoch <= state.currentFence.fencingEpoch ||
				input.nextFence.processGeneration === state.currentFence.processGeneration
			)
				throw new SessionMessageObligationFenceError(
					"Successor fencing epoch and process generation must advance monotonically",
				);
			await this.commitEvent(state, {
				mutationId: randomUUID(),
				kind: "generation_rotated",
				fence: state.currentFence,
				data: { nextFence: cloneFence(input.nextFence) },
			});
			writeManifest(this.rootDir, {
				version: STORE_VERSION,
				storeId: sessionMessageContentDigest(this.rootDir).slice(0, 24),
				currentFence: cloneFence(input.nextFence),
				createdAt: new Date().toISOString(),
			});
			return cloneFence(input.nextFence);
		});
	}

	/**
	 * Issue a one-use owner continuity credential for a delivered obligation.
	 * Args:
	 * input: Predecessor ownership and successor fence binding for the delivery.
	 * Return: The durable opaque owner continuity credential.
	 */
	async issueOwnerContinuityHandoff(
		input: SessionMessageObligationOwnerContinuityHandoffIssueInput,
	): Promise<SessionMessageObligationOwnerContinuityHandoff> {
		if (input.ownerId.trim().length === 0 || input.successorOwnerId.trim().length === 0)
			throw new SessionMessageObligationError("invalid_owner", "Owner continuity handoff owners are required");
		assertFence(input.successorFence, "successor fence");
		return this.withGuard(async (state) => {
			this.assertMutationFence(state, input.fence);
			if (
				input.successorFence.fencingEpoch <= state.currentFence.fencingEpoch ||
				input.successorFence.processGeneration === state.currentFence.processGeneration
			)
				throw new SessionMessageObligationFenceError(
					"Successor handoff fencing epoch and process generation must advance monotonically",
				);
			const delivery = this.requiredPending(state, input.deliveryId);
			if (delivery.context.status !== "delivered")
				throw new SessionMessageObligationError(
					"context_not_delivered",
					`Delivery ${input.deliveryId} has not reached context`,
				);
			const claimId = input.claimId ?? delivery.context.claimId;
			this.assertTerminalSettlementOwner(delivery, input.ownerId, claimId, state.currentFence);
			assertContextDeliveryProof(delivery, "Owner continuity handoff context");
			if (!sameFence(delivery.contextDeliveryProof!.fence, state.currentFence))
				throw new SessionMessageObligationFenceError("Owner continuity predecessor is not current");
			const existing = this.handoffForDelivery(state, input.deliveryId);
			if (existing !== undefined) {
				if (existing.consumed)
					throw new SessionMessageObligationError(
						"owner_continuity_used",
						`Delivery ${input.deliveryId} already consumed its owner continuity handoff`,
					);
				const requested: SessionMessageObligationOwnerContinuityHandoff = {
					credential: existing.credential,
					deliveryId: input.deliveryId,
					claimId,
					predecessorOwnerId: input.ownerId,
					predecessorFence: state.currentFence,
					successorOwnerId: input.successorOwnerId,
					successorFence: input.successorFence,
				};
				if (!sameOwnerContinuityHandoff(existing, requested))
					throw new SessionMessageObligationError(
						"owner_continuity_owned",
						`Delivery ${input.deliveryId} already has an owner continuity handoff`,
					);
				return cloneOwnerContinuityHandoff(existing);
			}
			const handoff: StoredOwnerContinuityHandoff = {
				credential: randomUUID(),
				deliveryId: input.deliveryId,
				claimId,
				predecessorOwnerId: input.ownerId,
				predecessorFence: cloneFence(state.currentFence),
				successorOwnerId: input.successorOwnerId,
				successorFence: cloneFence(input.successorFence),
				consumed: false,
			};
			await this.commitEvent(state, {
				mutationId: randomUUID(),
				kind: "owner_handoff_issued",
				fence: state.currentFence,
				data: {
					deliveryId: input.deliveryId,
					predecessorOwnerId: input.ownerId,
					handoff,
				},
				crashHook: input.crashHook,
			});
			return cloneOwnerContinuityHandoff(handoff);
		});
	}

	/**
	 * Reissue a one-use credential after an authenticated successor consumed the prior credential.
	 * Args:
	 * input: The consumed store-issued credential and the same successor binding.
	 * Return: A fresh durable opaque owner continuity credential.
	 */
	async reissueOwnerContinuityHandoff(
		input: SessionMessageObligationOwnerContinuityHandoffReissueInput,
	): Promise<SessionMessageObligationOwnerContinuityHandoff> {
		assertOwnerContinuityHandoff(input.consumedHandoff, "Consumed owner continuity handoff");
		if (input.successorOwnerId.trim().length === 0)
			throw new SessionMessageObligationError("invalid_owner", "Owner continuity successor owner is required");
		assertFence(input.successorFence, "successor fence");
		return this.withGuard(async (state) => {
			this.assertMutationFence(state, input.fence);
			const consumed = state.handoffs.get(input.consumedHandoff.credential);
			if (
				consumed === undefined ||
				!sameOwnerContinuityHandoff(consumed, input.consumedHandoff) ||
				!consumed.consumed
			)
				throw new SessionMessageObligationError(
					"owner_continuity_required",
					"Owner continuity reissue requires a consumed store-issued handoff",
				);
			if (
				input.successorOwnerId !== consumed.successorOwnerId ||
				!sameFence(input.successorFence, consumed.successorFence) ||
				!sameFence(state.currentFence, consumed.successorFence)
			)
				throw new SessionMessageObligationError(
					"owner_continuity_invalid",
					"Owner continuity reissue successor is not authorized",
				);
			const delivery = this.requiredPending(state, consumed.deliveryId);
			if (delivery.context.status !== "delivered")
				throw new SessionMessageObligationError(
					"context_not_delivered",
					`Delivery ${consumed.deliveryId} has not reached context`,
				);
			assertContextDeliveryProof(delivery, "Owner continuity reissue context");
			if (
				delivery.context.claimId !== consumed.claimId ||
				delivery.contextDeliveryProof!.ownerId !== consumed.predecessorOwnerId ||
				!sameFence(delivery.contextDeliveryProof!.fence, consumed.predecessorFence)
			)
				throw new SessionMessageObligationError(
					"owner_continuity_invalid",
					"Owner continuity reissue context does not match its consumed handoff",
				);
			const latest = this.handoffForDelivery(state, consumed.deliveryId);
			if (latest !== undefined && !latest.consumed) {
				if (
					latest.predecessorOwnerId !== consumed.predecessorOwnerId ||
					!sameFence(latest.predecessorFence, consumed.predecessorFence) ||
					latest.successorOwnerId !== consumed.successorOwnerId ||
					!sameFence(latest.successorFence, consumed.successorFence)
				)
					throw new SessionMessageObligationError(
						"owner_continuity_owned",
						"Delivery already has a different owner continuity successor",
					);
				return cloneOwnerContinuityHandoff(latest);
			}
			const handoff: StoredOwnerContinuityHandoff = {
				credential: randomUUID(),
				deliveryId: consumed.deliveryId,
				claimId: consumed.claimId,
				predecessorOwnerId: consumed.predecessorOwnerId,
				predecessorFence: cloneFence(consumed.predecessorFence),
				successorOwnerId: consumed.successorOwnerId,
				successorFence: cloneFence(consumed.successorFence),
				consumed: false,
			};
			await this.commitEvent(state, {
				mutationId: randomUUID(),
				kind: "owner_handoff_issued",
				fence: state.currentFence,
				data: {
					deliveryId: consumed.deliveryId,
					predecessorOwnerId: consumed.predecessorOwnerId,
					handoff,
					recovery: true,
				},
				crashHook: input.crashHook,
			});
			return cloneOwnerContinuityHandoff(handoff);
		});
	}

	/**
	 * Consume a durable owner continuity credential exactly once.
	 * Args:
	 * input: Store-issued credential and successor owner identity.
	 * Return: An ephemeral settlement capability for the consumed credential.
	 */
	async consumeOwnerContinuityHandoff(
		input: SessionMessageObligationOwnerContinuityHandoffConsumeInput,
	): Promise<SessionMessageObligationOwnerContinuitySettlement> {
		assertOwnerContinuityHandoff(input.handoff, "Owner continuity handoff");
		if (input.ownerId.trim().length === 0)
			throw new SessionMessageObligationError("invalid_owner", "Owner continuity successor owner is required");
		return this.withGuard(async (state) => {
			this.assertMutationFence(state, input.fence);
			const stored = state.handoffs.get(input.handoff.credential);
			if (stored === undefined || !sameOwnerContinuityHandoff(stored, input.handoff))
				throw new SessionMessageObligationError(
					"owner_continuity_invalid",
					"Owner continuity handoff is not authentic",
				);
			if (stored.consumed)
				throw new SessionMessageObligationError(
					"owner_continuity_used",
					"Owner continuity handoff was already consumed",
				);
			if (input.ownerId !== stored.successorOwnerId)
				throw new SessionMessageObligationError(
					"owner_continuity_invalid",
					"Owner continuity handoff successor owner is not authorized",
				);
			if (
				!sameFence(state.currentFence, stored.successorFence) ||
				!sameFence(input.handoff.successorFence, state.currentFence)
			)
				throw new SessionMessageObligationFenceError("Owner continuity handoff successor is not current");
			const delivery = this.requiredPending(state, stored.deliveryId);
			if (delivery.context.status !== "delivered")
				throw new SessionMessageObligationError(
					"owner_continuity_invalid",
					"Owner continuity handoff no longer matches delivered context",
				);
			assertContextDeliveryProof(delivery, "Owner continuity handoff context");
			if (
				delivery.context.claimId !== stored.claimId ||
				delivery.contextDeliveryProof!.ownerId !== stored.predecessorOwnerId ||
				!sameFence(delivery.contextDeliveryProof!.fence, stored.predecessorFence)
			)
				throw new SessionMessageObligationError(
					"owner_continuity_invalid",
					"Owner continuity handoff no longer matches its context claim",
				);
			await this.commitEvent(state, {
				mutationId: randomUUID(),
				kind: "owner_handoff_consumed",
				fence: state.currentFence,
				data: { credential: stored.credential, ownerId: input.ownerId },
				crashHook: input.crashHook,
			});
			const settlement = {
				handoff: cloneOwnerContinuityHandoff(stored),
				settlementId: randomUUID(),
			};
			this.ownerContinuitySettlements.set(stored.credential, settlement.settlementId);
			return settlement;
		});
	}

	async listAll(): Promise<readonly SessionMessageDeliveryRecord[]> {
		return this.withGuard(async (state) => this.records(state));
	}

	async recoverPending(
		options: SessionMessageObligationRecoveryOptions = {},
	): Promise<readonly SessionMessageDeliveryRecord[]> {
		const limit = options.limit ?? DEFAULT_RECOVERY_LIMIT;
		if (!Number.isSafeInteger(limit) || limit <= 0)
			throw new SessionMessageObligationError(
				"invalid_recovery_limit",
				"recoverPending requires a positive finite limit",
			);
		if (
			options.after !== undefined &&
			(!Number.isSafeInteger(options.after.acceptedSequence) ||
				options.after.acceptedSequence < 0 ||
				options.after.deliveryId.trim().length === 0)
		)
			throw new SessionMessageObligationError("invalid_recovery_cursor", "recoverPending cursor is invalid");
		return this.withGuard(async (state) => {
			const seen = new Set<string>();
			const records = this.records(state)
				.filter((record) => !isTerminal(record.outcome))
				.filter((record) => options.after === undefined || compareRecoveryTuple(record, options.after) > 0)
				.filter((record) => {
					if (seen.has(record.deliveryId)) return false;
					seen.add(record.deliveryId);
					return true;
				});
			return records.slice(0, limit);
		});
	}

	async accept(input: SessionMessageObligationAcceptInput): Promise<SessionMessageObligationAcceptResult> {
		const identity = normalizeIdentity(input);
		const content = normalizeContent(input.content);
		const contentDigest = normalizeDigest(input.contentDigest, content);
		const recipients = normalizeRecipients(input.recipients, identity.messageId);
		return this.withGuard(async (state) => {
			this.assertMutationFence(state, input.fence);
			const existing = [...state.messages.values()].find((message) =>
				messageIdentityMatches(message, identity.messageId, identity.observationId),
			);
			if (existing !== undefined) {
				if (
					existing.messageId !== identity.messageId ||
					existing.observationId !== identity.observationId ||
					existing.content !== content ||
					existing.contentDigest !== contentDigest
				)
					throw new SessionMessageObligationIntegrityError(
						`Message ${identity.messageId} was accepted with different immutable content`,
					);
				const missingRecipients: SessionMessageRecipientInput[] = [];
				for (const recipient of recipients) {
					const delivery = state.deliveries.get(recipient.deliveryId!);
					if (delivery === undefined) {
						missingRecipients.push(recipient);
						continue;
					}
					if (!sameRoute(recipient, delivery) || delivery.messageId !== existing.messageId)
						throw new SessionMessageObligationIntegrityError(
							`Delivery ${recipient.deliveryId} has a different immutable recipient route`,
						);
				}
				const finalFanout = existing.deliveryIds.length + missingRecipients.length;
				if (missingRecipients.length > 0) {
					if (finalFanout > this.capacity.maxFanout)
						return this.capacityResult(
							identity,
							contentDigest,
							"capacity_fanout",
							input.deferOnCapacity === true,
						);
					const active = this.activeCapacity(state);
					if (active.items + missingRecipients.length > this.capacity.maxItems)
						return this.capacityResult(identity, contentDigest, "capacity_items", input.deferOnCapacity === true);
					const existingIsActive = existing.deliveryIds.some((deliveryId) => {
						const delivery = state.deliveries.get(deliveryId);
						return delivery !== undefined && !isTerminal(delivery.outcome);
					});
					const bytes = existingIsActive ? 0 : Buffer.byteLength(content, "utf8");
					if (active.bytes + bytes > this.capacity.maxBytes)
						return this.capacityResult(identity, contentDigest, "capacity_bytes", input.deferOnCapacity === true);
					const acceptedAt = nowString(this.now);
					const sequence = state.nextSequence + 1;
					const deliveries = this.buildDeliveries(state, existing, missingRecipients, acceptedAt, sequence);
					const reservation: SessionMessageCapacityReservation = {
						itemCount: missingRecipients.length,
						byteCount: bytes,
						fanoutCount: finalFanout,
						retryCapacity: missingRecipients.length * this.capacity.maxRetries,
					};
					await this.commitEvent(state, {
						mutationId: randomUUID(),
						kind: "fanout_extended",
						fence: state.currentFence,
						data: { messageId: existing.messageId, deliveries, reservation },
						crashHook: input.crashHook,
					});
				}
				const obligations = existing.deliveryIds.map((deliveryId) =>
					toDeliveryRecord(state.deliveries.get(deliveryId)!),
				);
				return {
					status: "idempotent" as const,
					accepted: true,
					replayed: true,
					messageId: existing.messageId,
					observationId: existing.observationId,
					contentDigest: existing.contentDigest,
					reservation: {
						itemCount: obligations.length,
						byteCount: Buffer.byteLength(existing.content, "utf8"),
						fanoutCount: obligations.length,
						retryCapacity: obligations.length * this.capacity.maxRetries,
					},
					obligations,
				};
			}
			for (const recipient of recipients) {
				if (state.deliveries.has(recipient.deliveryId!))
					throw new SessionMessageObligationIntegrityError(
						`Delivery ${recipient.deliveryId} is already assigned to another message`,
					);
			}
			if (recipients.length > this.capacity.maxFanout)
				return this.capacityResult(identity, contentDigest, "capacity_fanout", input.deferOnCapacity === true);
			const active = this.activeCapacity(state);
			if (active.items + recipients.length > this.capacity.maxItems)
				return this.capacityResult(identity, contentDigest, "capacity_items", input.deferOnCapacity === true);
			const bytes = Buffer.byteLength(content, "utf8");
			if (active.bytes + bytes > this.capacity.maxBytes)
				return this.capacityResult(identity, contentDigest, "capacity_bytes", input.deferOnCapacity === true);
			const reservation: SessionMessageCapacityReservation = {
				itemCount: recipients.length,
				byteCount: bytes,
				fanoutCount: recipients.length,
				retryCapacity: recipients.length * this.capacity.maxRetries,
			};
			const acceptedAt = nowString(this.now);
			const sequence = state.nextSequence + 1;
			const message: StoredMessage = {
				messageId: identity.messageId,
				observationId: identity.observationId,
				contentDigest,
				content,
				acceptedAt,
				acceptedSequence: sequence,
				deliveryIds: recipients.map((recipient) => recipient.deliveryId!),
			};
			const deliveries = this.buildDeliveries(state, message, recipients, acceptedAt, sequence);
			const mutationId = randomUUID();
			await this.commitEvent(state, {
				mutationId,
				kind: "accepted",
				fence: state.currentFence,
				data: { message, deliveries, reservation },
				crashHook: input.crashHook,
			});
			return {
				status: "accepted" as const,
				accepted: true,
				replayed: false,
				messageId: message.messageId,
				observationId: message.observationId,
				contentDigest: message.contentDigest,
				reservation,
				obligations: deliveries.map(toDeliveryRecord),
			};
		});
	}

	async claimWake(input: SessionMessageObligationMutationInput): Promise<SessionMessageDeliveryRecord> {
		if (input.ownerId === undefined || input.ownerId.trim().length === 0)
			throw new SessionMessageObligationError("invalid_owner", "Wake ownership requires an owner id");
		const ownerIdentity = input.ownerId;
		return this.withGuard(async (state) => {
			this.assertMutationFence(state, input.fence);
			const delivery = this.requiredWakeCandidate(state, input.deliveryId);
			const handoff = this.handoffForDelivery(state, input.deliveryId);
			if (handoff !== undefined && sameFence(state.currentFence, handoff.predecessorFence))
				throw new SessionMessageObligationError(
					"owner_continuity_required",
					`Delivery ${input.deliveryId} has been handed off to its successor owner`,
				);
			let reclaim = false;
			if (delivery.wakeOwner !== null) {
				const sameCurrentOwner =
					delivery.wakeOwner.ownerId === ownerIdentity && sameFence(delivery.wakeOwner, state.currentFence);
				if (sameCurrentOwner && !this.wakeLeaseExpired(delivery.wakeOwner)) return toDeliveryRecord(delivery);
				if (sameFence(delivery.wakeOwner, state.currentFence) && !this.wakeLeaseExpired(delivery.wakeOwner))
					throw new SessionMessageObligationError(
						"wake_owned",
						`Delivery ${input.deliveryId} is owned by another wake worker`,
					);
				reclaim = true;
			}
			if (!reclaim && delivery.attemptCount >= this.capacity.maxRetries + 1)
				throw new SessionMessageObligationCapacityError(
					"capacity_retries",
					`Delivery ${input.deliveryId} has exhausted retry capacity`,
				);
			const owner: StoredWakeOwner = {
				ownerId: ownerIdentity,
				...cloneFence(state.currentFence),
				claimedAt: nowString(this.now),
			};
			await this.commitEvent(state, {
				mutationId: randomUUID(),
				kind: "wake_claimed",
				fence: state.currentFence,
				data: {
					deliveryId: input.deliveryId,
					owner,
					attemptCount: reclaim ? delivery.attemptCount : delivery.attemptCount + 1,
					reclaim,
				},
				crashHook: input.crashHook,
			});
			return toDeliveryRecord(state.deliveries.get(input.deliveryId)!);
		});
	}

	async claimContextDelivery(input: SessionMessageObligationMutationInput): Promise<SessionMessageDeliveryRecord> {
		return this.withGuard(async (state) => {
			this.assertMutationFence(state, input.fence);
			const delivery = this.requiredPending(state, input.deliveryId);
			const handoff = this.handoffForDelivery(state, input.deliveryId);
			if (handoff !== undefined && sameFence(state.currentFence, handoff.predecessorFence))
				throw new SessionMessageObligationError(
					"owner_continuity_required",
					`Delivery ${input.deliveryId} has been handed off to its successor owner`,
				);
			this.assertActiveWakeOwner(delivery, input.ownerId, state.currentFence);
			if (delivery.context.status === "delivered") return toDeliveryRecord(delivery);
			if (delivery.context.status === "claimed") {
				if (input.claimId !== undefined && input.claimId !== delivery.context.claimId)
					throw new SessionMessageObligationError(
						"context_owned",
						`Delivery ${input.deliveryId} is claimed by another context worker`,
					);
				return toDeliveryRecord(delivery);
			}
			const claimId = input.claimId ?? randomUUID();
			await this.commitEvent(state, {
				mutationId: randomUUID(),
				kind: "context_claimed",
				fence: state.currentFence,
				data: { deliveryId: input.deliveryId, claimId, claimedAt: nowString(this.now) },
				crashHook: input.crashHook,
			});
			return toDeliveryRecord(state.deliveries.get(input.deliveryId)!);
		});
	}

	async markContextDelivered(input: SessionMessageObligationMutationInput): Promise<SessionMessageDeliveryRecord> {
		return this.withGuard(async (state) => {
			this.assertMutationFence(state, input.fence);
			const delivery = this.requiredPending(state, input.deliveryId);
			const handoff = this.handoffForDelivery(state, input.deliveryId);
			if (handoff !== undefined && sameFence(state.currentFence, handoff.predecessorFence))
				throw new SessionMessageObligationError(
					"owner_continuity_required",
					`Delivery ${input.deliveryId} has been handed off to its successor owner`,
				);
			this.assertActiveWakeOwner(delivery, input.ownerId, state.currentFence);
			if (delivery.context.status === "delivered") {
				if (input.claimId !== undefined && input.claimId !== delivery.context.claimId)
					throw new SessionMessageObligationError(
						"context_owned",
						`Delivery ${input.deliveryId} has a different context claim`,
					);
				return toDeliveryRecord(delivery);
			}
			if (delivery.context.status !== "claimed")
				throw new SessionMessageObligationError(
					"context_unclaimed",
					`Delivery ${input.deliveryId} has no context claim`,
				);
			const claimId = input.claimId ?? delivery.context.claimId;
			if (claimId !== delivery.context.claimId)
				throw new SessionMessageObligationError(
					"context_owned",
					`Delivery ${input.deliveryId} has a different context claim`,
				);
			const claimedAt = delivery.context.claimedAt;
			await this.commitEvent(state, {
				mutationId: randomUUID(),
				kind: "context_delivered",
				fence: state.currentFence,
				data: {
					deliveryId: input.deliveryId,
					claimId,
					claimedAt,
					ownerId: delivery.wakeOwner!.ownerId,
					deliveredAt: nowString(this.now),
				},
				crashHook: input.crashHook,
			});
			return toDeliveryRecord(state.deliveries.get(input.deliveryId)!);
		});
	}

	async markProcessed(input: SessionMessageObligationMutationInput): Promise<SessionMessageDeliveryRecord> {
		return this.finish(input, "processed");
	}

	async markFailure(input: SessionMessageObligationMutationInput): Promise<SessionMessageDeliveryRecord> {
		return this.finish(input, "failed");
	}

	async cancel(input: SessionMessageObligationMutationInput): Promise<SessionMessageDeliveryRecord> {
		return this.finish(input, "cancelled");
	}

	async expire(input: SessionMessageObligationMutationInput): Promise<SessionMessageDeliveryRecord> {
		return this.finish(input, "expired");
	}

	async retry(input: SessionMessageObligationMutationInput): Promise<SessionMessageDeliveryRecord> {
		return this.withGuard(async (state) => {
			this.assertMutationFence(state, input.fence);
			const delivery = this.requiredDelivery(state, input.deliveryId);
			this.assertActiveWakeOwner(delivery, input.ownerId, state.currentFence);
			if (delivery.outcome === "pending") return toDeliveryRecord(delivery);
			if (delivery.outcome !== "failed")
				throw new SessionMessageObligationError(
					"invalid_transition",
					`Delivery ${input.deliveryId} cannot retry from ${delivery.outcome}`,
				);
			if (delivery.attemptCount >= this.capacity.maxRetries + 1)
				throw new SessionMessageObligationCapacityError(
					"capacity_retries",
					`Delivery ${input.deliveryId} has exhausted retry capacity`,
				);
			await this.commitEvent(state, {
				mutationId: randomUUID(),
				kind: "retried",
				fence: state.currentFence,
				data: { deliveryId: input.deliveryId, reason: input.reason ?? null },
				crashHook: input.crashHook,
			});
			return toDeliveryRecord(state.deliveries.get(input.deliveryId)!);
		});
	}

	async rotateGeneration(input: SessionMessageObligationRotationInput): Promise<SessionMessageObligationFence> {
		const nextFence = input.nextFence;
		assertFence(nextFence, "next fence");
		return this.withGuard(async (state) => {
			this.assertMutationFence(state, input.expectedFence);
			if (
				nextFence.fencingEpoch <= state.currentFence.fencingEpoch ||
				nextFence.processGeneration === state.currentFence.processGeneration
			)
				throw new SessionMessageObligationFenceError(
					"Successor fencing epoch and process generation must advance monotonically",
				);
			await this.commitEvent(state, {
				mutationId: randomUUID(),
				kind: "generation_rotated",
				fence: state.currentFence,
				data: { nextFence: cloneFence(nextFence) },
				crashHook: input.crashHook,
			});
			writeManifest(this.rootDir, {
				version: STORE_VERSION,
				storeId: sessionMessageContentDigest(this.rootDir).slice(0, 24),
				currentFence: cloneFence(nextFence),
				createdAt: new Date().toISOString(),
			});
			return cloneFence(nextFence);
		});
	}

	private async finish(
		input: SessionMessageObligationMutationInput,
		outcome: "processed" | "failed" | "cancelled" | "expired",
	): Promise<SessionMessageDeliveryRecord> {
		return this.withGuard(async (state) => {
			this.assertMutationFence(state, input.fence);
			const delivery = this.requiredDelivery(state, input.deliveryId);
			if (delivery.outcome === outcome) return toDeliveryRecord(delivery);
			if (isTerminal(delivery.outcome))
				throw new SessionMessageObligationError(
					"invalid_transition",
					`Delivery ${input.deliveryId} is already ${delivery.outcome}`,
				);
			const handoff = this.handoffForDelivery(state, delivery.deliveryId);
			if (handoff !== undefined) {
				this.assertConsumedOwnerContinuityHandoff(delivery, input, handoff, state.currentFence);
			} else {
				if (input.ownerContinuityHandoff !== undefined || input.ownerContinuitySettlement !== undefined)
					throw new SessionMessageObligationError(
						"owner_continuity_invalid",
						`Delivery ${delivery.deliveryId} has no matching owner continuity handoff`,
					);
				if (outcome === "processed" || outcome === "failed") {
					if (delivery.context.status === "delivered")
						this.assertTerminalSettlementOwner(delivery, input.ownerId, input.claimId, state.currentFence);
					else this.assertActiveWakeOwner(delivery, input.ownerId, state.currentFence);
				} else this.assertActiveWakeOwner(delivery, input.ownerId, state.currentFence);
			}
			if (outcome === "processed" && delivery.context.status !== "delivered")
				throw new SessionMessageObligationError(
					"context_not_delivered",
					`Delivery ${input.deliveryId} has not reached context`,
				);
			await this.commitEvent(state, {
				mutationId: randomUUID(),
				kind: outcome,
				fence: state.currentFence,
				data: { deliveryId: input.deliveryId, outcomeAt: nowString(this.now), reason: input.reason ?? null },
				crashHook: input.crashHook,
			});
			return toDeliveryRecord(state.deliveries.get(input.deliveryId)!);
		});
	}

	private async withGuard<T>(operation: (state: StoreState) => Promise<T>): Promise<T> {
		if (this.closed)
			throw new SessionMessageObligationError("store_closed", "Session message obligation store is closed");
		const release = await lock(this.rootDir, {
			realpath: false,
			lockfilePath: join(this.rootDir, GUARD_FILE),
			stale: 5_000,
			retries: { retries: 100, minTimeout: 5, maxTimeout: 25 },
		});
		try {
			const manifest = parseManifest(join(this.rootDir, MANIFEST_FILE));
			if (manifest === undefined)
				throw new SessionMessageObligationError("corrupt_store", "Durable obligation manifest is missing");
			const state = emptyState(manifest.currentFence);
			loadCheckpoint(this.rootDir, state);
			readJournal(this.rootDir, state);
			return await operation(state);
		} finally {
			await release();
		}
	}

	private async commitEvent(
		state: StoreState,
		input: {
			readonly mutationId: string;
			readonly kind: SessionMessageObligationEventKind;
			readonly fence: SessionMessageObligationFence;
			readonly data: Record<string, unknown>;
			readonly crashHook?: SessionMessageObligationCrashHook;
		},
	): Promise<JournalEnvelope> {
		const event = buildEvent(state.nextSequence + 1, input.mutationId, input.kind, input.fence, input.data);
		await input.crashHook?.beforeDurableCommit?.({ mutationId: input.mutationId, kind: input.kind });
		appendEvent(this.rootDir, event);
		applyEvent(state, event);
		state.nextSequence = event.sequence;
		await input.crashHook?.afterDurableCommit?.({
			mutationId: input.mutationId,
			kind: input.kind,
			sequence: event.sequence,
			eventDigest: event.eventDigest,
		});
		if (state.nextSequence % COMPACTION_EVENT_THRESHOLD === 0) {
			writeCheckpoint(this.rootDir, state);
			await input.crashHook?.afterCheckpointPublication?.({
				mutationId: input.mutationId,
				kind: input.kind,
				sequence: event.sequence,
				eventDigest: event.eventDigest,
			});
			compactJournal(this.rootDir);
		}
		return event;
	}

	private assertMutationFence(state: StoreState, supplied: SessionMessageObligationFence | undefined): void {
		const expected = supplied ?? this.expectedFence;
		assertFence(expected, "mutation fence");
		if (!sameFence(expected, this.expectedFence) || !sameFence(expected, state.currentFence))
			throw new SessionMessageObligationFenceError();
	}

	private requiredDelivery(state: StoreState, deliveryId: string): StoredDelivery {
		const delivery = state.deliveries.get(deliveryId);
		if (delivery === undefined)
			throw new SessionMessageObligationError("not_found", `Unknown delivery ${deliveryId}`);
		return delivery;
	}

	private requiredPending(state: StoreState, deliveryId: string): StoredDelivery {
		const delivery = this.requiredDelivery(state, deliveryId);
		if (isTerminal(delivery.outcome))
			throw new SessionMessageObligationError(
				"invalid_transition",
				`Delivery ${deliveryId} is already ${delivery.outcome}`,
			);
		return delivery;
	}

	private requiredWakeCandidate(state: StoreState, deliveryId: string): StoredDelivery {
		const delivery = this.requiredDelivery(state, deliveryId);
		if (delivery.outcome === "processed" || delivery.outcome === "cancelled" || delivery.outcome === "expired")
			throw new SessionMessageObligationError(
				"invalid_transition",
				`Delivery ${deliveryId} cannot be claimed from ${delivery.outcome}`,
			);
		return delivery;
	}

	private wakeLeaseExpired(owner: StoredWakeOwner): boolean {
		const now = Date.parse(nowString(this.now));
		const claimedAt = Date.parse(owner.claimedAt);
		if (!Number.isFinite(now) || !Number.isFinite(claimedAt))
			throw new SessionMessageObligationError("invalid_timestamp", "Wake ownership timestamps are invalid");
		return now - claimedAt >= this.wakeLeaseMs;
	}

	private assertActiveWakeOwner(
		delivery: StoredDelivery,
		ownerId: string | undefined,
		currentFence: SessionMessageObligationFence,
	): void {
		if (
			ownerId === undefined ||
			ownerId.trim().length === 0 ||
			delivery.wakeOwner === null ||
			delivery.wakeOwner.ownerId !== ownerId ||
			!sameFence(delivery.wakeOwner, currentFence) ||
			this.wakeLeaseExpired(delivery.wakeOwner)
		)
			throw new SessionMessageObligationError(
				"wake_owned",
				`Delivery ${delivery.deliveryId} has no matching active wake owner`,
			);
	}

	private assertTerminalSettlementOwner(
		delivery: StoredDelivery,
		ownerId: string | undefined,
		claimId: string | undefined,
		currentFence: SessionMessageObligationFence,
	): void {
		if (ownerId === undefined || ownerId.trim().length === 0)
			throw new SessionMessageObligationError(
				"wake_owned",
				`Delivery ${delivery.deliveryId} has no terminal settlement owner`,
			);
		assertContextDeliveryProof(delivery, "Terminal settlement context");
		const proof = delivery.contextDeliveryProof!;
		if (ownerId !== proof.ownerId)
			throw new SessionMessageObligationError(
				"wake_owned",
				`Delivery ${delivery.deliveryId} has no matching historical wake owner`,
			);
		if (claimId === undefined) {
			const activeHistoricalOwner =
				delivery.wakeOwner !== null &&
				delivery.wakeOwner.ownerId === ownerId &&
				sameFence(delivery.wakeOwner, currentFence) &&
				!this.wakeLeaseExpired(delivery.wakeOwner);
			if (activeHistoricalOwner) return;
			throw new SessionMessageObligationError(
				"context_owned",
				`Delivery ${delivery.deliveryId} requires its historical context claim`,
			);
		}
		if (claimId !== proof.claimId)
			throw new SessionMessageObligationError(
				"context_owned",
				`Delivery ${delivery.deliveryId} has a different context claim`,
			);
		if (
			proof.fence.fencingEpoch > currentFence.fencingEpoch ||
			(proof.fence.fencingEpoch === currentFence.fencingEpoch &&
				proof.fence.processGeneration !== currentFence.processGeneration)
		)
			throw new SessionMessageObligationFenceError("Terminal settlement context is fenced to a future generation");
	}

	private handoffForDelivery(state: StoreState, deliveryId: string): StoredOwnerContinuityHandoff | undefined {
		const delivery = state.deliveries.get(deliveryId);
		if (delivery === undefined || delivery.context.status !== "delivered") return undefined;
		return [...state.handoffs.values()]
			.reverse()
			.find((handoff) => handoff.deliveryId === deliveryId && handoff.claimId === delivery.context.claimId);
	}

	private pendingOwnerContinuityHandoffs(state: StoreState): StoredOwnerContinuityHandoff[] {
		return [...state.handoffs.values()].filter((handoff) => {
			const delivery = state.deliveries.get(handoff.deliveryId);
			return (
				!handoff.consumed &&
				delivery !== undefined &&
				!isTerminal(delivery.outcome) &&
				delivery.context.status === "delivered" &&
				delivery.context.claimId === handoff.claimId
			);
		});
	}

	private assertConsumedOwnerContinuityHandoff(
		delivery: StoredDelivery,
		input: SessionMessageObligationMutationInput,
		handoff: StoredOwnerContinuityHandoff,
		currentFence: SessionMessageObligationFence,
	): void {
		const settlement = input.ownerContinuitySettlement;
		if (
			settlement === undefined ||
			!sameOwnerContinuityHandoff(handoff, settlement.handoff) ||
			this.ownerContinuitySettlements.get(handoff.credential) !== settlement.settlementId
		)
			throw new SessionMessageObligationError(
				"owner_continuity_required",
				`Delivery ${delivery.deliveryId} requires its current store-issued settlement capability`,
			);
		if (
			!handoff.consumed ||
			input.ownerId !== handoff.successorOwnerId ||
			!sameFence(currentFence, handoff.successorFence) ||
			!sameFence(currentFence, this.expectedFence)
		)
			throw new SessionMessageObligationError(
				"owner_continuity_required",
				`Delivery ${delivery.deliveryId} has no consumed owner continuity handoff for this owner`,
			);
		this.ownerContinuitySettlements.delete(handoff.credential);
	}

	private activeCapacity(state: StoreState): { items: number; bytes: number } {
		const activeMessageIds = new Set<string>();
		for (const delivery of state.deliveries.values())
			if (!isTerminal(delivery.outcome)) activeMessageIds.add(delivery.messageId);
		let bytes = 0;
		for (const messageId of activeMessageIds) {
			const message = state.messages.get(messageId);
			if (message !== undefined) bytes += Buffer.byteLength(message.content, "utf8");
		}
		return {
			items: [...state.deliveries.values()].filter((delivery) => !isTerminal(delivery.outcome)).length,
			bytes,
		};
	}

	private buildDeliveries(
		state: StoreState,
		message: StoredMessage,
		recipients: readonly SessionMessageRecipientInput[],
		acceptedAt: string,
		acceptedSequence: number,
	): StoredDelivery[] {
		return recipients.map((recipient) => ({
			messageId: message.messageId,
			observationId: message.observationId,
			contentDigest: message.contentDigest,
			content: message.content,
			deliveryId: recipient.deliveryId!,
			processGeneration: state.currentFence.processGeneration,
			fencingEpoch: state.currentFence.fencingEpoch,
			recipient: recipient.recipient,
			lane: recipient.lane,
			acceptedAt,
			acceptedSequence,
			wakeOwner: null,
			context: { status: "pending", claimId: null, claimedAt: null, deliveredAt: null },
			contextDeliveryProof: null,
			outcome: "pending",
			outcomeAt: null,
			failureReason: null,
			attemptCount: 0,
		}));
	}

	private capacityResult(
		identity: { messageId: string; observationId: string },
		contentDigest: string,
		reason: SessionMessageObligationCapacityReason,
		deferred: boolean,
	): SessionMessageObligationAcceptResult {
		return {
			status: deferred ? "deferred" : "rejected",
			accepted: false,
			replayed: false,
			messageId: identity.messageId,
			observationId: identity.observationId,
			contentDigest,
			reason,
			obligations: [],
		};
	}

	private records(state: StoreState): readonly SessionMessageDeliveryRecord[] {
		return [...state.deliveries.values()].sort(compareRecoveryTuple).map(toDeliveryRecord);
	}

	private snapshot(state: StoreState): SessionMessageObligationSnapshot {
		return freezeDeep({
			currentFence: cloneFence(state.currentFence),
			messages: [...state.messages.values()].map(toMessageRecord),
			obligations: this.records(state),
		});
	}
}

export function createSessionMessageObligationStore(
	options: SessionMessageObligationStoreOptions,
): SessionMessageObligationStore {
	return new SessionMessageObligationStore(options);
}
