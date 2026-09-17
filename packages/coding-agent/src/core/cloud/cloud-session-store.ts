import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../../utils/atomic-file.js";
import { PRIME_SANDBOX_STATUSES, type PrimeSandboxStatus } from "./prime-sandbox-client.js";
import {
	CLOUD_MAX_ERROR_CHARS,
	CLOUD_MAX_ID_CHARS,
	CLOUD_MAX_PATH_CHARS,
	CLOUD_MAX_TIMESTAMP_CHARS,
	type CloudCursor,
	type CloudSessionId,
	cloudCursor,
	isCloudDigest,
	newCloudSessionId,
} from "./protocol.js";

/**
 * Durable local cloud-session records for the direct cloud execution model.
 *
 * The local daemon is the only record owner: it allocates the logical session
 * identity before any compute, persists the record before creating a
 * sandbox, and keeps it current as provisioning, attachment, mirroring,
 * result import, and cleanup progress. The record is the direct-model
 * replacement for a platform session record.
 *
 * - One JSON file per session under the store directory, written atomically
 *   (temp file + rename) with fsync and mode 0600.
 * - Every field is validated before it is written and again when it is read;
 *   a malformed record is quarantined beside its file (bytes preserved) and
 *   the operation fails closed instead of returning untrusted state.
 * - Mutators are idempotent: applying the same update again is a no-op that
 *   does not rewrite the file and does not bump `updatedAt`.
 * - The record `generation` fences stale writers: it names the current
 *   execution incarnation and the event-log epoch, so both cursors must
 *   carry it and a cursor from an older generation is rejected.
 */

export const CLOUD_SESSION_RECORD_VERSION = 1;
export const CLOUD_SESSION_RECORD_SUFFIX = ".json";
export const CLOUD_SESSION_RECORD_MAX_BYTES = 1_048_576;

/** Preallocated session identity: `sess_` plus a URL/filename-safe body. */
const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Resident and attachment process identities are lower-case UUIDs. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Platform sandbox ids and create idempotency keys share this shape. */
const PLATFORM_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEAD_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export const CLOUD_DESIRED_LIFECYCLE_STATES = ["provisioning", "running", "stopping", "deleted"] as const;
export type CloudDesiredLifecycle = (typeof CLOUD_DESIRED_LIFECYCLE_STATES)[number];

export const CLOUD_OBSERVED_LIFECYCLE_STATES = ["provisioning", "running", "stopped", "lost", "deleted"] as const;
export type CloudObservedLifecycle = (typeof CLOUD_OBSERVED_LIFECYCLE_STATES)[number];

export const CLOUD_CLEANUP_STATES = [
	"none",
	"pending",
	"importing",
	"imported",
	"releasing",
	"released",
	"failed",
] as const;
export type CloudCleanupState = (typeof CLOUD_CLEANUP_STATES)[number];

export const CLOUD_RESULT_IMPORT_STATES = [
	"pending",
	"available",
	"reviewed",
	"imported",
	"skipped",
	"failed",
] as const;
export type CloudResultImportState = (typeof CLOUD_RESULT_IMPORT_STATES)[number];

/** Submitted workspace-snapshot provenance; immutable once set. */
export interface CloudSessionBaseline {
	/** Absolute real path of the captured repository or worktree root. */
	repoRoot: string;
	/** HEAD commit hex digest when HEAD exists; null on an unborn branch. */
	headCommit: string | null;
	/** SHA-256 digest of the canonical workspace manifest. */
	manifestDigest: string;
}

/** Prime Tunnel registration attached to a delegation; non-secret fields only. */
export interface CloudSessionTunnel {
	/** Platform tunnel id; also the frpc subdomain. */
	tunnelId: string;
	/** Public HTTPS origin the local daemon attaches over. */
	url: string;
	/** Public hostname of the tunnel edge. */
	hostname: string;
	/** Edge basic-auth username; the password lives only in the secret store. */
	httpUser: string;
	/** ISO-8601 registration expiry; reconnects must survive until cleanup. */
	expiresAt: string;
	/** Registration timestamp. */
	registeredAt: string;
}

export const CLOUD_TUNNEL_STATES = ["registered", "released"] as const;
export type CloudTunnelState = (typeof CLOUD_TUNNEL_STATES)[number];

/** Versioned cloud-session record persisted at `<directory>/<sessionId>.json`. */
export interface CloudSessionRecord {
	version: 1;
	/** Preallocated local session identity; allocated before any compute. Immutable. */
	sessionId: CloudSessionId;
	/** Owning local session when the delegation is a child of one. Immutable. */
	parentSessionId?: string;
	/** Execution incarnation; fences stale writers and names the event-log epoch. */
	generation: number;
	/** Resident cloud-daemon process UUID for this incarnation. */
	residentProcessUuid: string;
	/** Latest bridge attachment UUID; replaced on every reconnect. */
	attachmentUuid?: string;
	/** Registered Prime Tunnel for this incarnation; non-secret fields only. */
	tunnel?: CloudSessionTunnel;
	/** Tunnel release state; `released` is terminal. */
	tunnelState?: CloudTunnelState;
	/** Sandbox create idempotency key for this incarnation. */
	createIdempotencyKey?: string;
	/** Platform sandbox id once allocated. */
	sandboxId?: string;
	/** Last observed platform sandbox status. */
	sandboxStatus?: PrimeSandboxStatus;
	/** Submitted workspace snapshot provenance. Immutable once set. */
	baseline?: CloudSessionBaseline;
	/** Intent for the session lifecycle. */
	desiredLifecycle: CloudDesiredLifecycle;
	/** Locally observed execution state of the current incarnation. */
	observedLifecycle: CloudObservedLifecycle;
	/** Sandbox lifetime deadline; reconnects never extend it. Immutable once set. */
	deadlineAt?: string;
	/** Highest event position mirrored locally from the ordered outbox. */
	eventCursor: CloudCursor;
	/** Highest event position durably mirrored and acknowledged locally. */
	ackCursor: CloudCursor;
	/** Cleanup sequencing state: results before sandbox delete. */
	cleanupState: CloudCleanupState;
	/** Result-review and import state. */
	resultImportState: CloudResultImportState;
	/** Last operational failure, bounded; cleared with undefined. */
	lastError?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CloudSessionCreateInput {
	/** Preallocated session identity; allocated by the store when omitted. */
	sessionId?: string;
	/** Owning local session when the delegation is a child of one. */
	parentSessionId?: string;
	/** Resident cloud-daemon process UUID; must be allocated before compute. */
	residentProcessUuid: string;
}

export type CloudSessionStoreErrorCode = "invalid" | "not_found" | "conflict" | "corrupt";

export class CloudSessionStoreError extends Error {
	readonly code: CloudSessionStoreErrorCode;

	constructor(code: CloudSessionStoreErrorCode, message: string, properties: { cause?: unknown } = {}) {
		super(message, properties.cause === undefined ? undefined : { cause: properties.cause });
		this.name = "CloudSessionStoreError";
		this.code = code;
	}
}

const RECORD_FIELDS = [
	"version",
	"sessionId",
	"parentSessionId",
	"generation",
	"residentProcessUuid",
	"attachmentUuid",
	"tunnel",
	"tunnelState",
	"createIdempotencyKey",
	"sandboxId",
	"sandboxStatus",
	"baseline",
	"desiredLifecycle",
	"observedLifecycle",
	"deadlineAt",
	"eventCursor",
	"ackCursor",
	"cleanupState",
	"resultImportState",
	"lastError",
	"createdAt",
	"updatedAt",
] as const;

const DESIRED_ORDER: readonly CloudDesiredLifecycle[] = CLOUD_DESIRED_LIFECYCLE_STATES;
const CLEANUP_PIPELINE: readonly CloudCleanupState[] = [
	"none",
	"pending",
	"importing",
	"imported",
	"releasing",
	"released",
];
const RESULT_IMPORT_PIPELINE: readonly CloudResultImportState[] = [
	"pending",
	"available",
	"reviewed",
	"imported",
	"skipped",
];

/** Runtime validation for a persisted cloud-session record; undefined means valid. */
export function cloudSessionRecordProblem(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return "cloud session record must be a JSON object";
	}
	const base = firstProblem(
		expectFields(value, RECORD_FIELDS),
		value.version === CLOUD_SESSION_RECORD_VERSION
			? undefined
			: `record.version must be ${CLOUD_SESSION_RECORD_VERSION}`,
		expectSessionId(value.sessionId, "record.sessionId"),
		value.parentSessionId === undefined
			? undefined
			: expectString(value.parentSessionId, "record.parentSessionId", CLOUD_MAX_ID_CHARS),
		expectInteger(value.generation, "record.generation", 1),
		expectUuid(value.residentProcessUuid, "record.residentProcessUuid"),
		value.attachmentUuid === undefined ? undefined : expectUuid(value.attachmentUuid, "record.attachmentUuid"),
		value.tunnel === undefined ? undefined : tunnelProblem(value.tunnel, "record.tunnel"),
		value.tunnelState === undefined
			? undefined
			: expectOneOf(value.tunnelState, "record.tunnelState", CLOUD_TUNNEL_STATES),
		value.createIdempotencyKey === undefined
			? undefined
			: expectSegment(value.createIdempotencyKey, "record.createIdempotencyKey"),
		value.sandboxId === undefined ? undefined : expectSegment(value.sandboxId, "record.sandboxId"),
		value.sandboxStatus === undefined
			? undefined
			: expectOneOf(value.sandboxStatus, "record.sandboxStatus", PRIME_SANDBOX_STATUSES),
		value.baseline === undefined ? undefined : baselineProblem(value.baseline, "record.baseline"),
		expectOneOf(value.desiredLifecycle, "record.desiredLifecycle", CLOUD_DESIRED_LIFECYCLE_STATES),
		expectOneOf(value.observedLifecycle, "record.observedLifecycle", CLOUD_OBSERVED_LIFECYCLE_STATES),
		value.deadlineAt === undefined ? undefined : expectTimestamp(value.deadlineAt, "record.deadlineAt"),
		expectCursor(value.eventCursor, "record.eventCursor"),
		expectCursor(value.ackCursor, "record.ackCursor"),
		expectOneOf(value.cleanupState, "record.cleanupState", CLOUD_CLEANUP_STATES),
		expectOneOf(value.resultImportState, "record.resultImportState", CLOUD_RESULT_IMPORT_STATES),
		value.lastError === undefined
			? undefined
			: expectString(value.lastError, "record.lastError", CLOUD_MAX_ERROR_CHARS),
		expectTimestamp(value.createdAt, "record.createdAt"),
		expectTimestamp(value.updatedAt, "record.updatedAt"),
	);
	if (base !== undefined) {
		return base;
	}
	const generation = value.generation as number;
	const eventCursor = value.eventCursor as CloudCursor;
	const ackCursor = value.ackCursor as CloudCursor;
	if (eventCursor.generation !== generation) {
		return "record.eventCursor.generation must match record.generation";
	}
	if (ackCursor.generation !== generation) {
		return "record.ackCursor.generation must match record.generation";
	}
	if (ackCursor.sequence > eventCursor.sequence) {
		return "record.ackCursor.sequence must not pass record.eventCursor.sequence";
	}
	if (Date.parse(value.updatedAt as string) < Date.parse(value.createdAt as string)) {
		return "record.updatedAt must not predate record.createdAt";
	}
	if (
		value.deadlineAt !== undefined &&
		Date.parse(value.deadlineAt as string) < Date.parse(value.createdAt as string)
	) {
		return "record.deadlineAt must not predate record.createdAt";
	}
	return undefined;
}

/** Durable store for local cloud-session records. One daemon process owns a directory. */
export class CloudSessionStore {
	private readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
	}

	/**
	 * Persist a new record before any compute is allocated. The session
	 * identity is preallocated (caller-provided or generated here), the
	 * desired lifecycle starts at `provisioning`, and both cursors start at
	 * `{generation: 1, sequence: 0}`. Creating an existing session is a
	 * conflict; a create is never an update.
	 */
	create(input: CloudSessionCreateInput): CloudSessionRecord {
		const sessionId = input.sessionId ?? newCloudSessionId();
		const sessionIdProblem = expectSessionId(sessionId, "sessionId");
		if (sessionIdProblem !== undefined) {
			throw new CloudSessionStoreError("invalid", sessionIdProblem);
		}
		if (input.parentSessionId !== undefined) {
			const parentProblem = expectString(input.parentSessionId, "parentSessionId", CLOUD_MAX_ID_CHARS);
			if (parentProblem !== undefined) {
				throw new CloudSessionStoreError("invalid", parentProblem);
			}
		}
		const residentProblem = expectUuid(input.residentProcessUuid, "residentProcessUuid");
		if (residentProblem !== undefined) {
			throw new CloudSessionStoreError("invalid", residentProblem);
		}
		const now = new Date().toISOString();
		const record: CloudSessionRecord = {
			version: CLOUD_SESSION_RECORD_VERSION,
			sessionId,
			...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
			generation: 1,
			residentProcessUuid: input.residentProcessUuid,
			desiredLifecycle: "provisioning",
			observedLifecycle: "provisioning",
			eventCursor: cloudCursor(1, 0),
			ackCursor: cloudCursor(1, 0),
			cleanupState: "none",
			resultImportState: "pending",
			createdAt: now,
			updatedAt: now,
		};
		if (this.readRecord(this.recordPath(sessionId)) !== undefined) {
			throw new CloudSessionStoreError("conflict", `cloud session already exists: ${sessionId}`);
		}
		this.persist(record);
		return cloneRecord(record);
	}

	/** Read one record. Unknown sessions are undefined; malformed records fail closed. */
	get(sessionId: string): CloudSessionRecord | undefined {
		requireSessionId(sessionId);
		return this.readRecord(this.recordPath(sessionId));
	}

	/** Read every record, ordered by creation then session id. Malformed records fail closed. */
	list(): CloudSessionRecord[] {
		const records: CloudSessionRecord[] = [];
		for (const entry of readdirSync(this.directory)) {
			if (!entry.endsWith(CLOUD_SESSION_RECORD_SUFFIX)) {
				continue;
			}
			const record = this.readRecord(join(this.directory, entry));
			if (record !== undefined) {
				records.push(record);
			}
		}
		records.sort((a, b) => {
			const byCreated = a.createdAt.localeCompare(b.createdAt);
			return byCreated !== 0 ? byCreated : a.sessionId.localeCompare(b.sessionId);
		});
		return records;
	}

	/**
	 * Record the allocated sandbox and its latest observed status. The id is
	 * set once per incarnation; a different id is a conflict.
	 */
	setSandbox(sessionId: string, sandboxId: string, sandboxStatus?: PrimeSandboxStatus): CloudSessionRecord {
		const idProblem = expectSegment(sandboxId, "sandboxId");
		if (idProblem !== undefined) {
			throw new CloudSessionStoreError("invalid", idProblem);
		}
		if (sandboxStatus !== undefined && !(PRIME_SANDBOX_STATUSES as readonly string[]).includes(sandboxStatus)) {
			throw new CloudSessionStoreError(
				"invalid",
				`sandboxStatus must be one of ${PRIME_SANDBOX_STATUSES.join(", ")}`,
			);
		}
		return this.mutate(sessionId, (record) => {
			if (record.sandboxId !== undefined && record.sandboxId !== sandboxId) {
				throw new CloudSessionStoreError(
					"conflict",
					`cloud session ${sessionId} already holds sandbox ${record.sandboxId}`,
				);
			}
			if (record.sandboxId === sandboxId && record.sandboxStatus === sandboxStatus) {
				return false;
			}
			record.sandboxId = sandboxId;
			record.sandboxStatus = sandboxStatus ?? record.sandboxStatus;
			return true;
		});
	}

	/** Record the sandbox create idempotency key; set once per incarnation. */
	setCreateIdempotencyKey(sessionId: string, idempotencyKey: string): CloudSessionRecord {
		const keyProblem = expectSegment(idempotencyKey, "idempotencyKey");
		if (keyProblem !== undefined) {
			throw new CloudSessionStoreError("invalid", keyProblem);
		}
		return this.mutate(sessionId, (record) => {
			if (record.createIdempotencyKey === idempotencyKey) {
				return false;
			}
			if (record.createIdempotencyKey !== undefined) {
				throw new CloudSessionStoreError(
					"conflict",
					`cloud session ${sessionId} already holds create idempotency key ${record.createIdempotencyKey}`,
				);
			}
			record.createIdempotencyKey = idempotencyKey;
			return true;
		});
	}

	/** Record the submitted workspace-snapshot provenance; immutable once set. */
	setBaseline(sessionId: string, baseline: CloudSessionBaseline): CloudSessionRecord {
		const problem = baselineProblem(baseline, "baseline");
		if (problem !== undefined) {
			throw new CloudSessionStoreError("invalid", problem);
		}
		return this.mutate(sessionId, (record) => {
			if (record.baseline !== undefined) {
				if (
					record.baseline.repoRoot === baseline.repoRoot &&
					record.baseline.headCommit === baseline.headCommit &&
					record.baseline.manifestDigest === baseline.manifestDigest
				) {
					return false;
				}
				throw new CloudSessionStoreError(
					"conflict",
					`cloud session ${sessionId} already holds a baseline; a baseline is immutable`,
				);
			}
			record.baseline = { ...baseline };
			return true;
		});
	}

	/** Record the sandbox lifetime deadline; immutable once set, reconnects never extend it. */
	setDeadline(sessionId: string, deadlineAt: string): CloudSessionRecord {
		const problem = expectTimestamp(deadlineAt, "deadlineAt");
		if (problem !== undefined) {
			throw new CloudSessionStoreError("invalid", problem);
		}
		return this.mutate(sessionId, (record) => {
			if (record.deadlineAt === deadlineAt) {
				return false;
			}
			if (record.deadlineAt !== undefined) {
				throw new CloudSessionStoreError(
					"conflict",
					`cloud session ${sessionId} already holds deadline ${record.deadlineAt}; a deadline is immutable`,
				);
			}
			if (Date.parse(deadlineAt) < Date.parse(record.createdAt)) {
				throw new CloudSessionStoreError("invalid", "deadlineAt must not predate the record's createdAt");
			}
			record.deadlineAt = deadlineAt;
			return true;
		});
	}

	/** Advance the desired lifecycle; monotonic, `deleted` is terminal. */
	setDesiredLifecycle(sessionId: string, desired: CloudDesiredLifecycle): CloudSessionRecord {
		if (!isDesiredLifecycle(desired)) {
			throw new CloudSessionStoreError(
				"invalid",
				`desiredLifecycle must be one of ${CLOUD_DESIRED_LIFECYCLE_STATES.join(", ")}`,
			);
		}
		return this.mutate(sessionId, (record) => {
			if (record.desiredLifecycle === desired) {
				return false;
			}
			if (record.desiredLifecycle === "deleted") {
				throw new CloudSessionStoreError("invalid", `desired lifecycle is terminal: ${record.desiredLifecycle}`);
			}
			if (DESIRED_ORDER.indexOf(desired) < DESIRED_ORDER.indexOf(record.desiredLifecycle)) {
				throw new CloudSessionStoreError(
					"invalid",
					`desired lifecycle cannot regress from ${record.desiredLifecycle} to ${desired}`,
				);
			}
			record.desiredLifecycle = desired;
			return true;
		});
	}

	/** Update the observed lifecycle; never regresses to provisioning, `deleted` is terminal. */
	setObservedLifecycle(sessionId: string, observed: CloudObservedLifecycle): CloudSessionRecord {
		if (!isObservedLifecycle(observed)) {
			throw new CloudSessionStoreError(
				"invalid",
				`observedLifecycle must be one of ${CLOUD_OBSERVED_LIFECYCLE_STATES.join(", ")}`,
			);
		}
		return this.mutate(sessionId, (record) => {
			if (record.observedLifecycle === observed) {
				return false;
			}
			if (record.observedLifecycle === "deleted") {
				throw new CloudSessionStoreError("invalid", `observed lifecycle is terminal: ${record.observedLifecycle}`);
			}
			if (observed === "provisioning") {
				throw new CloudSessionStoreError("invalid", "observed lifecycle never regresses to provisioning");
			}
			record.observedLifecycle = observed;
			return true;
		});
	}

	/** Record the latest bridge attachment UUID; replaced on every reconnect. */
	recordAttachment(sessionId: string, attachmentUuid: string): CloudSessionRecord {
		const problem = expectUuid(attachmentUuid, "attachmentUuid");
		if (problem !== undefined) {
			throw new CloudSessionStoreError("invalid", problem);
		}
		return this.mutate(sessionId, (record) => {
			if (record.attachmentUuid === attachmentUuid) {
				return false;
			}
			record.attachmentUuid = attachmentUuid;
			return true;
		});
	}

	/**
	 * Record the registered Prime Tunnel for this incarnation. Set once; a
	 * re-registration replaces it only after the previous tunnel was released.
	 */
	setTunnel(sessionId: string, tunnel: CloudSessionTunnel): CloudSessionRecord {
		const problem = tunnelProblem(tunnel, "tunnel");
		if (problem !== undefined) {
			throw new CloudSessionStoreError("invalid", problem);
		}
		return this.mutate(sessionId, (record) => {
			if (record.tunnel?.tunnelId === tunnel.tunnelId) {
				if (record.tunnelState === "registered") return false;
				record.tunnelState = "registered";
				return true;
			}
			if (record.tunnel !== undefined && record.tunnelState !== "released") {
				throw new CloudSessionStoreError(
					"conflict",
					`cloud session ${sessionId} already holds tunnel ${record.tunnel.tunnelId}; release it first`,
				);
			}
			record.tunnel = { ...tunnel };
			record.tunnelState = "registered";
			return true;
		});
	}

	/** Mark the tunnel released; terminal for this incarnation. */
	setTunnelState(sessionId: string, state: CloudTunnelState): CloudSessionRecord {
		if (!CLOUD_TUNNEL_STATES.includes(state)) {
			throw new CloudSessionStoreError("invalid", `tunnelState must be one of ${CLOUD_TUNNEL_STATES.join(", ")}`);
		}
		return this.mutate(sessionId, (record) => {
			if (record.tunnelState === state) {
				return false;
			}
			if (record.tunnelState === "released") {
				throw new CloudSessionStoreError("conflict", `tunnel state is terminal: ${record.tunnelState}`);
			}
			record.tunnelState = state;
			return true;
		});
	}

	/**
	 * Fence a new execution incarnation: bump the generation, install a new
	 * resident process UUID, clear per-incarnation sandbox identity (sandbox
	 * id/status, create idempotency key, deadline, attachment, last error),
	 * and restart both cursors at the new generation. Baseline provenance,
	 * cleanup, and result-import state belong to the logical session and are
	 * kept. This is the one sanctioned reset of the desired/observed
	 * lifecycle back to `provisioning`.
	 */
	nextGeneration(sessionId: string, residentProcessUuid: string): CloudSessionRecord {
		const problem = expectUuid(residentProcessUuid, "residentProcessUuid");
		if (problem !== undefined) {
			throw new CloudSessionStoreError("invalid", problem);
		}
		return this.mutate(sessionId, (record) => {
			if (record.generation >= Number.MAX_SAFE_INTEGER) {
				throw new CloudSessionStoreError("invalid", "generation is exhausted");
			}
			record.generation += 1;
			record.residentProcessUuid = residentProcessUuid;
			record.attachmentUuid = undefined;
			record.createIdempotencyKey = undefined;
			record.sandboxId = undefined;
			record.sandboxStatus = undefined;
			record.deadlineAt = undefined;
			record.lastError = undefined;
			record.eventCursor = cloudCursor(record.generation, 0);
			record.ackCursor = cloudCursor(record.generation, 0);
			record.desiredLifecycle = "provisioning";
			record.observedLifecycle = "provisioning";
			return true;
		});
	}

	/**
	 * Advance the mirrored event cursor. The cursor's generation must equal
	 * the record's current generation; a cursor from a stale generation is
	 * rejected, never folded in. Sequences move forward only.
	 */
	advanceEventCursor(sessionId: string, cursor: CloudCursor): CloudSessionRecord {
		const normalized = normalizeCursor(cursor);
		return this.mutate(sessionId, (record) => {
			if (normalized.generation !== record.generation) {
				throw new CloudSessionStoreError(
					"conflict",
					`stale cursor generation ${normalized.generation}; session ${sessionId} is at generation ${record.generation}`,
				);
			}
			if (normalized.sequence === record.eventCursor.sequence) {
				return false;
			}
			if (normalized.sequence < record.eventCursor.sequence) {
				throw new CloudSessionStoreError("invalid", "event cursor cannot move backwards");
			}
			record.eventCursor = normalized;
			return true;
		});
	}

	/**
	 * Advance the acknowledged cursor; call only after the mirrored range is
	 * fsynced locally. Monotonic, and never passes the event cursor.
	 */
	advanceAckCursor(sessionId: string, cursor: CloudCursor): CloudSessionRecord {
		const normalized = normalizeCursor(cursor);
		return this.mutate(sessionId, (record) => {
			if (normalized.generation !== record.generation) {
				throw new CloudSessionStoreError(
					"conflict",
					`stale cursor generation ${normalized.generation}; session ${sessionId} is at generation ${record.generation}`,
				);
			}
			if (normalized.sequence === record.ackCursor.sequence) {
				return false;
			}
			if (normalized.sequence < record.ackCursor.sequence) {
				throw new CloudSessionStoreError("invalid", "ack cursor cannot move backwards");
			}
			if (normalized.sequence > record.eventCursor.sequence) {
				throw new CloudSessionStoreError("invalid", "ack cursor cannot pass the event cursor");
			}
			record.ackCursor = normalized;
			return true;
		});
	}

	/** Advance the cleanup sequence: results are imported before the sandbox is released. */
	setCleanupState(sessionId: string, state: CloudCleanupState): CloudSessionRecord {
		if (!isCleanupState(state)) {
			throw new CloudSessionStoreError("invalid", `cleanupState must be one of ${CLOUD_CLEANUP_STATES.join(", ")}`);
		}
		return this.mutate(sessionId, (record) => {
			if (record.cleanupState === state) {
				return false;
			}
			const current = record.cleanupState;
			if (current === "released") {
				throw new CloudSessionStoreError("invalid", "cleanup already released");
			}
			if (state === "failed") {
				if (current === "none") {
					throw new CloudSessionStoreError("invalid", "cleanup cannot fail before it is pending");
				}
				record.cleanupState = "failed";
				return true;
			}
			if (current === "failed") {
				if (CLEANUP_PIPELINE.indexOf(state) < CLEANUP_PIPELINE.indexOf("importing")) {
					throw new CloudSessionStoreError(
						"invalid",
						`cleanup retry must resume at importing or later, not ${state}`,
					);
				}
				record.cleanupState = state;
				return true;
			}
			if (CLEANUP_PIPELINE.indexOf(state) < CLEANUP_PIPELINE.indexOf(current)) {
				throw new CloudSessionStoreError("invalid", `cleanup state cannot regress from ${current} to ${state}`);
			}
			record.cleanupState = state;
			return true;
		});
	}

	/** Advance the result-review and import state; `imported` and `skipped` are terminal. */
	setResultImportState(sessionId: string, state: CloudResultImportState): CloudSessionRecord {
		if (!isResultImportState(state)) {
			throw new CloudSessionStoreError(
				"invalid",
				`resultImportState must be one of ${CLOUD_RESULT_IMPORT_STATES.join(", ")}`,
			);
		}
		return this.mutate(sessionId, (record) => {
			if (record.resultImportState === state) {
				return false;
			}
			const current = record.resultImportState;
			if (current === "imported" || current === "skipped") {
				throw new CloudSessionStoreError("invalid", `result import is terminal: ${current}`);
			}
			if (state === "failed") {
				record.resultImportState = "failed";
				return true;
			}
			if (current === "failed") {
				if (RESULT_IMPORT_PIPELINE.indexOf(state) < RESULT_IMPORT_PIPELINE.indexOf("available")) {
					throw new CloudSessionStoreError(
						"invalid",
						`result import retry must resume at available or later, not ${state}`,
					);
				}
				record.resultImportState = state;
				return true;
			}
			if (RESULT_IMPORT_PIPELINE.indexOf(state) < RESULT_IMPORT_PIPELINE.indexOf(current)) {
				throw new CloudSessionStoreError(
					"invalid",
					`result import state cannot regress from ${current} to ${state}`,
				);
			}
			record.resultImportState = state;
			return true;
		});
	}

	/** Record or clear the last operational error; bounded, always overwritable. */
	setLastError(sessionId: string, error?: string): CloudSessionRecord {
		if (
			error !== undefined &&
			(typeof error !== "string" || error.length < 1 || error.length > CLOUD_MAX_ERROR_CHARS)
		) {
			throw new CloudSessionStoreError(
				"invalid",
				`last error must be a string of at most ${CLOUD_MAX_ERROR_CHARS} characters`,
			);
		}
		return this.mutate(sessionId, (record) => {
			if (record.lastError === error) {
				return false;
			}
			record.lastError = error;
			return true;
		});
	}

	/** Remove the record file; intended after cleanup is released. Returns whether a record was removed. */
	delete(sessionId: string): boolean {
		requireSessionId(sessionId);
		const path = this.recordPath(sessionId);
		try {
			statSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return false;
			}
			throw error;
		}
		rmSync(path);
		return true;
	}

	private recordPath(sessionId: string): string {
		return join(this.directory, `${sessionId}${CLOUD_SESSION_RECORD_SUFFIX}`);
	}

	/**
	 * Load, mutate, persist. `apply` returns true when the record changed; a
	 * no-op never rewrites the file and never bumps `updatedAt`.
	 */
	private mutate(sessionId: string, apply: (record: CloudSessionRecord) => boolean): CloudSessionRecord {
		requireSessionId(sessionId);
		const record = this.readRecord(this.recordPath(sessionId));
		if (record === undefined) {
			throw new CloudSessionStoreError("not_found", `unknown cloud session: ${sessionId}`);
		}
		if (apply(record)) {
			record.updatedAt = new Date().toISOString();
			this.persist(record);
		}
		return cloneRecord(record);
	}

	/** Read and strictly validate one record file; malformed records are quarantined and fail closed. */
	private readRecord(path: string): CloudSessionRecord | undefined {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return undefined;
			}
			throw error;
		}
		if (Buffer.byteLength(raw) > CLOUD_SESSION_RECORD_MAX_BYTES) {
			throw this.quarantine(path, `record exceeds ${CLOUD_SESSION_RECORD_MAX_BYTES} bytes`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw this.quarantine(path, "record is not valid JSON", error);
		}
		const problem = cloudSessionRecordProblem(parsed);
		if (problem !== undefined) {
			throw this.quarantine(path, problem);
		}
		return cloneRecord(parsed as CloudSessionRecord);
	}

	/** Validate and durably persist; called only after a state change. */
	private persist(record: CloudSessionRecord): void {
		const problem = cloudSessionRecordProblem(record);
		if (problem !== undefined) {
			throw new CloudSessionStoreError("invalid", `refusing to persist an invalid cloud session record: ${problem}`);
		}
		const serialized = `${JSON.stringify(record)}\n`;
		if (Buffer.byteLength(serialized) > CLOUD_SESSION_RECORD_MAX_BYTES) {
			throw new CloudSessionStoreError(
				"invalid",
				`serialized cloud session record exceeds ${CLOUD_SESSION_RECORD_MAX_BYTES} bytes`,
			);
		}
		writeFileAtomicSync(this.recordPath(record.sessionId), serialized, {
			mode: 0o600,
			fsync: true,
			fsyncDir: true,
		});
	}

	/**
	 * Quarantine a malformed record: rename it beside its file (bytes
	 * preserved, mode 0600) so the next read does not trip over it, and
	 * return the fail-closed error the caller throws.
	 */
	private quarantine(path: string, reason: string, cause?: unknown): CloudSessionStoreError {
		const quarantinePath = `${path}.${Date.now()}.${randomUUID().slice(0, 8)}.quarantine`;
		let renamed = false;
		try {
			renameSync(path, quarantinePath);
			chmodSync(quarantinePath, 0o600);
			renamed = true;
		} catch {
			// The file is left in place; the failure is still surfaced.
		}
		const suffix = renamed ? `quarantined as ${quarantinePath}` : "quarantine failed; the file was left in place";
		return new CloudSessionStoreError("corrupt", `cloud session record ${path} is malformed (${reason}); ${suffix}`, {
			cause,
		});
	}
}

function requireSessionId(sessionId: string): void {
	if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
		throw new CloudSessionStoreError(
			"invalid",
			`sessionId must match ${SESSION_ID_PATTERN.source}: ${JSON.stringify(String(sessionId))}`,
		);
	}
}

function normalizeCursor(value: CloudCursor): CloudCursor {
	try {
		return cloudCursor(value.generation, value.sequence);
	} catch (error) {
		throw new CloudSessionStoreError(
			"invalid",
			`invalid cursor: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

function cloneRecord(record: CloudSessionRecord): CloudSessionRecord {
	return JSON.parse(JSON.stringify(record)) as CloudSessionRecord;
}

function isDesiredLifecycle(value: unknown): value is CloudDesiredLifecycle {
	return typeof value === "string" && (CLOUD_DESIRED_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function isObservedLifecycle(value: unknown): value is CloudObservedLifecycle {
	return typeof value === "string" && (CLOUD_OBSERVED_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function isCleanupState(value: unknown): value is CloudCleanupState {
	return typeof value === "string" && (CLOUD_CLEANUP_STATES as readonly string[]).includes(value);
}

function isResultImportState(value: unknown): value is CloudResultImportState {
	return typeof value === "string" && (CLOUD_RESULT_IMPORT_STATES as readonly string[]).includes(value);
}

function baselineProblem(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) {
		return `${label} must be an object`;
	}
	return firstProblem(
		expectFields(value, ["repoRoot", "headCommit", "manifestDigest"]),
		expectString(value.repoRoot, `${label}.repoRoot`, CLOUD_MAX_PATH_CHARS),
		value.headCommit === null
			? undefined
			: typeof value.headCommit === "string" && HEAD_COMMIT_PATTERN.test(value.headCommit)
				? undefined
				: `${label}.headCommit must be a 40 hex-char commit id or null`,
		typeof value.manifestDigest === "string" && isCloudDigest(value.manifestDigest)
			? undefined
			: `${label}.manifestDigest must be a sha256:<64 hex> digest`,
	);
}

function tunnelProblem(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) {
		return `${label} must be an object`;
	}
	return firstProblem(
		expectFields(value, ["tunnelId", "url", "hostname", "httpUser", "expiresAt", "registeredAt"]),
		typeof value.tunnelId === "string" && PLATFORM_SEGMENT_PATTERN.test(value.tunnelId)
			? undefined
			: `${label}.tunnelId must be a URL-safe segment`,
		expectString(value.url, `${label}.url`, 2048),
		expectString(value.hostname, `${label}.hostname`, 255),
		expectString(value.httpUser, `${label}.httpUser`, 128),
		expectString(value.expiresAt, `${label}.expiresAt`, CLOUD_MAX_TIMESTAMP_CHARS),
		expectString(value.registeredAt, `${label}.registeredAt`, CLOUD_MAX_TIMESTAMP_CHARS),
	);
}

type Problem = string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstProblem(...problems: Problem[]): Problem {
	return problems.find((problem) => problem !== undefined);
}

function expectFields(record: Record<string, unknown>, fields: readonly string[]): Problem {
	for (const key of Object.keys(record)) {
		if (!fields.includes(key)) {
			return `unexpected field: ${key}`;
		}
	}
	return undefined;
}

function expectString(value: unknown, label: string, maxLength: number, minLength = 1): Problem {
	if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
		return `${label} must be a string of ${minLength}-${maxLength} characters`;
	}
	return undefined;
}

function expectInteger(value: unknown, label: string, minimum: number): Problem {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
		return `${label} must be an integer of at least ${minimum}`;
	}
	return undefined;
}

function expectOneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): Problem {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		return `${label} must be one of ${allowed.join(", ")}`;
	}
	return undefined;
}

function expectTimestamp(value: unknown, label: string): Problem {
	const base = expectString(value, label, CLOUD_MAX_TIMESTAMP_CHARS);
	if (base !== undefined) {
		return base;
	}
	if (Number.isNaN(Date.parse(value as string))) {
		return `${label} must be an ISO-8601 timestamp`;
	}
	return undefined;
}

function expectSessionId(value: unknown, label: string): Problem {
	if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
		return `${label} must match ${SESSION_ID_PATTERN.source}`;
	}
	return undefined;
}

function expectUuid(value: unknown, label: string): Problem {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		return `${label} must be a lower-case UUID`;
	}
	return undefined;
}

function expectSegment(value: unknown, label: string): Problem {
	if (typeof value !== "string" || !PLATFORM_SEGMENT_PATTERN.test(value)) {
		return `${label} must be 1-128 characters of letters, digits, dots, underscores, or dashes, starting with a letter or digit`;
	}
	return undefined;
}

function expectCursor(value: unknown, label: string): Problem {
	if (!isRecord(value)) {
		return `${label} must be an object`;
	}
	return firstProblem(
		expectFields(value, ["generation", "sequence"]),
		expectInteger(value.generation, `${label}.generation`, 1),
		expectInteger(value.sequence, `${label}.sequence`, 0),
	);
}
