/**
 * C04's sole authority for bounded terminal child results and opaque, owner-local
 * artifacts.  This module deliberately has no daemon/protocol dependency.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
	createRlmSafeTerminalResultTerminalMessage,
	MAX_RLM_SAFE_TERMINAL_MESSAGE_BYTES,
} from "./rlm-durable-operations.js";
import { getProcessStartId } from "./session-lease.js";

export const CHILD_RESULT_SCHEMA_VERSION = 1 as const;
/** C04's opaque projection must still fit C03's 64 KiB full envelope.
 * 60 KiB leaves 4 KiB for the fixed C03 JSON/message fields and presentation. */
export const MAX_CHILD_RESULT_JSON_BYTES = 60 * 1024;
export const MAX_SUMMARY_CHARS = 4_096;
export const MAX_SUMMARY_BYTES = 16 * 1024;
export const MAX_PREVIEW_CHARS = 2_048;
export const MAX_PREVIEW_BYTES = 8 * 1024;
export const MAX_FACTS = 32;
export const MAX_NEXT_ACTIONS = 16;
export const MAX_ARTIFACTS_PER_RESULT = 16;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES_PER_CHILD_SESSION = 2 * 1024 * 1024 * 1024;
export const MAX_STREAM_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_CHILD_RESULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Result and object handles are random UUIDv4. Authority-issued session and
 * operation identities accept the canonical UUID versions used by C01/C03. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const statuses = new Set(["completed", "failed", "cancelled", "timed_out", "stalled", "unknown_after_crash"]);
const kinds = new Set(["terminal_output", "diagnostic", "trajectory", "attachment"]);
const contentTypes = new Set(["text/plain", "application/json", "application/octet-stream"]);
const retentionStates = new Set(["retained", "expired", "deleted", "unavailable", "uncertain"]);
const errorCodes = new Set([
	"invalid_result",
	"result_too_large",
	"artifact_too_large",
	"artifact_quota_exceeded",
	"artifact_unavailable",
	"artifact_integrity_failed",
	"artifact_expired",
	"terminal_storage_failed",
	"cancelled",
	"timed_out",
	"stalled",
	"unknown_after_crash",
]);

export type C04ChildResultStatus =
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "stalled"
	| "unknown_after_crash";
export type C04RetentionState = "retained" | "expired" | "deleted" | "unavailable" | "uncertain";
export type C04ArtifactKind = "terminal_output" | "diagnostic" | "trajectory" | "attachment";
export type C04ErrorCode =
	| "invalid_result"
	| "result_too_large"
	| "artifact_too_large"
	| "artifact_quota_exceeded"
	| "artifact_unavailable"
	| "artifact_integrity_failed"
	| "artifact_expired"
	| "terminal_storage_failed"
	| "cancelled"
	| "timed_out"
	| "stalled"
	| "unknown_after_crash";

/** Every component is required: matching a selector or only one ID is never authority. */
export interface C04ChildResultOwner {
	parentSessionId: string;
	childSessionId: string;
	childSessionFile: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
}
export interface C04OpaqueArtifactReference {
	version: 1;
	handleId: string;
	resultId: string;
	kind: C04ArtifactKind;
	contentType: "text/plain" | "application/json" | "application/octet-stream";
	byteLength: number;
	sha256: string;
	creatorAssignmentId: string;
	ownerSessionId: string;
	retentionState: C04RetentionState;
}
export interface C04ChildResultReference {
	version: 1;
	resultId: string;
	status: C04ChildResultStatus;
	summary: string;
	preview: string;
	error?: { code: C04ErrorCode; message: string; diagnosticRef?: string };
	model: C04ModelMetadata;
	artifacts: C04OpaqueArtifactReference[];
	retentionState: C04RetentionState;
}
/** C05 receives only this same bounded shape, never correlation data or bytes. */
export type C04PublicChildResult = C04ChildResultReference;
export interface C04ModelMetadata {
	requestedSelector?: string;
	initialResolvedSelector: string;
	terminalResolvedSelector: string;
	fallbackHistory?: string[];
}
export interface C04TerminalCandidate {
	status: C04ChildResultStatus;
	summary: string;
	preview: string;
	facts?: Array<{ claim: string; evidenceRef?: string }>;
	nextActions?: string[];
	error?: { code?: string; message?: string; diagnostic?: C04ArtifactInput };
	model?: Partial<C04ModelMetadata>;
	/** Raw material is never returned or placed in the result record. */
	artifacts?: C04ArtifactInput[];
}
export interface C04ArtifactInput {
	kind: C04ArtifactKind;
	contentType: "text/plain" | "application/json" | "application/octet-stream";
	/** Payloads are stream-only. Inline strings/Uint8Arrays are deliberately
	 * rejected so a terminal can never accidentally retain an unbounded reply. */
	data: AsyncIterable<Uint8Array>;
}
/** SessionManager issues this private authority for a parent before C04 can write.
 * It deliberately names no key bytes, so it can never enter a C04 projection. */
export interface C04ParentRecoveryAuthority {
	parentSessionFile: string;
	parentArtifactRoot: string;
	recoveryKeyPath: string;
}
export interface C04CreateTerminalChildResultInput {
	owner: C04ChildResultOwner;
	candidate: C04TerminalCandidate;
	/** Trusted SessionManager child artifact directory; callers never pass a relative object path. */
	childArtifactRoot: string;
	/** SessionManager-owned, parent-bound private recovery authority. */
	parentRecoveryAuthority: C04ParentRecoveryAuthority;
	/** Captured runtime/assignment capability, rechecked before durable publication. */
	isCurrent?: () => boolean;
	now?: () => Date;
}
interface StoredChildResult extends C04ChildResultReference {
	schemaVersion: 1;
	owner: C04ChildResultOwner;
	facts: Array<{ claim: string; evidenceRef?: string }>;
	nextActions: string[];
	committedAt: string;
	retention: { disposition: "retain_until"; expiresAt: string };
	requestDigest: string;
	/** Increments for every retention disposition and fences a resolved read. */
	generation: number;
}
type AuditAction = "created" | "linked" | "read_allowed" | "read_denied" | "expired" | "deleted" | "uncertain";
const capabilities = new WeakMap<
	object,
	{ root: string; owner: C04ChildResultOwner; handleId: string; resultId: string; generation: number }
>();

/**
 * Validate, stream and commit one immutable operation result.  An exact retry
 * returns its already committed reference; a different request is a conflict.
 */
export async function createOrGetTerminalChildResult(
	input: C04CreateTerminalChildResultInput,
): Promise<C04ChildResultReference> {
	const owner = validateOwner(input.owner);
	if (input.isCurrent && !input.isCurrent()) throw new Error("stale C04 child result capability");
	// Bind before creating C04 state: an untrusted sibling/renamed root never gets
	// a durable directory merely because it was supplied by a caller.
	validateChildBinding(owner, input.childArtifactRoot);
	const recoveryKey = readParentRecoveryKey(owner, input.childArtifactRoot, input.parentRecoveryAuthority);
	const root = prepareBoundRoot(owner, input.childArtifactRoot);
	const now = input.now?.() ?? new Date();
	if (!Number.isFinite(now.getTime())) throw new Error("C04 time is invalid");
	const candidate = validateCandidate(input.candidate);
	const indexPath = safePath(root, "operation-index", `${owner.operationId}.json`);
	reconcileAbandonedReservation(root, owner, indexPath, recoveryKey);
	const existing = readIndex(indexPath);
	// A committed operation is immutable.  We do not touch a retry stream until its
	// operation identity has been resolved, avoiding a concurrent writer consuming it.
	if (existing) {
		if (!sameOwner(existing.owner, owner)) throw immutableConflict(root, owner.operationId);
		// A retry supplies a fresh stream; hash its bytes incrementally rather than
		// collapsing all streams to a literal. Different raw output is a conflict.
		if (existing.requestDigest !== (await digestCandidateStreams(owner, candidate)))
			throw immutableConflict(root, owner.operationId);
		return projection(readStored(root, existing.resultId));
	}
	const reservation = reserveOperationAndQuota(root, owner, indexPath, recoveryKey);
	const release = reservation.release;
	const resultId = reservation.resultId;
	const artifacts: C04OpaqueArtifactReference[] = [];
	let committed = false;
	let reservedBytes = aggregateBytes(root, owner);
	try {
		for (const artifact of [
			...(candidate.artifacts ?? []),
			...(candidate.error?.diagnostic ? [candidate.error.diagnostic] : []),
		]) {
			if (artifacts.length >= MAX_ARTIFACTS_PER_RESULT) throw new Error("artifact count exceeds C04 limit");
			const written = await writeArtifact(root, owner, resultId, artifact, reservedBytes, reservation.recordHandle);
			reservedBytes += written.byteLength;
			artifacts.push(written);
		}
		// Stream waits may have yielded while the parent/runtime was replaced. Never
		// publish such an attempt; catch cleanup is restricted to its random names.
		if (input.isCurrent && !input.isCurrent()) throw new Error("stale C04 child result capability");
		const diagnostic = candidate.error?.diagnostic ? artifacts.at(-1) : undefined;
		const requestDigest = digestableCandidateDigest(owner, candidate, artifacts);
		const facts = candidate.facts.map((fact) => ({
			claim: fact.claim,
			...(fact.evidenceRef && artifacts.some((ref) => ref.handleId === fact.evidenceRef)
				? { evidenceRef: fact.evidenceRef }
				: {}),
		}));
		const stored: StoredChildResult = {
			schemaVersion: 1,
			version: 1,
			resultId,
			owner,
			status: candidate.status,
			summary: candidate.summary,
			preview: candidate.preview,
			facts,
			nextActions: candidate.nextActions,
			...(candidate.error
				? {
						error: {
							code: candidate.error.code as C04ErrorCode,
							message: candidate.error.message as string,
							...(diagnostic ? { diagnosticRef: diagnostic.handleId } : {}),
						},
					}
				: {}),
			model: candidate.model as C04ModelMetadata,
			artifacts,
			retentionState: "retained",
			committedAt: now.toISOString(),
			retention: {
				disposition: "retain_until",
				expiresAt: new Date(now.getTime() + DEFAULT_CHILD_RESULT_RETENTION_MS).toISOString(),
			},
			requestDigest,
			generation: 0,
		};
		assertStored(stored);
		// C03's cap applies to its stable serialized envelope, not merely this
		// projection. Check the actual C03 constructor before publishing any C04
		// authority record; escaped quotes/backslashes are therefore charged.
		assertC03EnvelopeFits(projection(stored));
		// Fence both sides of the durable publication cuts. A stream await may have
		// handed the assignment to a newer owner; neither an old result nor its
		// operation index may become authoritative afterwards.
		if (input.isCurrent && !input.isCurrent()) throw new Error("stale C04 child result capability");
		// Initial result publication is immutable: a final name is never rename-overwritten.
		atomicExclusiveJson(safePath(root, "results", `${resultId}.json`), stored);
		for (const artifact of artifacts)
			atomicExclusiveJson(safePath(root, "handle-index", `${artifact.handleId}.json`), {
				version: 1,
				resultId,
				owner,
				handleId: artifact.handleId,
			});
		const index = { version: 1, resultId, owner, requestDigest };
		if (input.isCurrent && !input.isCurrent()) throw new Error("stale C04 child result capability");
		try {
			atomicExclusiveJson(indexPath, index);
		} catch (error) {
			const raced = readIndex(indexPath);
			if (raced && sameOwner(raced.owner, owner) && raced.requestDigest === requestDigest)
				return projection(readStored(root, raced.resultId));
			appendAudit(root, "uncertain", "immutable_conflict", owner.operationId);
			throw error;
		}
		committed = true;
		appendAudit(root, "created", "committed", resultId);
		appendAudit(root, "linked", "operation_indexed", resultId);
		return projection(stored);
	} catch (error) {
		// Before an operation index exists these files have no public authority.
		// They were created under this random result/handle identity only, so an
		// unsuccessful producer may clean them without ever touching a winner.
		if (!committed) cleanUnindexedOwnedAttempt(root, owner, resultId, artifacts);
		if (!(error instanceof Error && error.message === "C04 immutable operation conflict"))
			appendAudit(root, "uncertain", "storage_failed", owner.operationId);
		throw error;
	} finally {
		release();
	}
}

export function getChildResultProjection(
	owner: C04ChildResultOwner,
	resultId: string,
	childArtifactRoot: string,
	now = new Date(),
): C04ChildResultReference | undefined {
	try {
		const verified = validateOwner(owner);
		const root = prepareBoundRoot(verified, childArtifactRoot, false);
		const result = readStored(root, resultId);
		if (!sameOwner(result.owner, verified)) return denied(root, "owner_mismatch");
		const reduced = expireIfElapsed(root, result, now);
		return projection(reduced);
	} catch {
		return undefined;
	}
}

/** Exact owner + opaque handle resolver.  It is deliberately not a generic get(handle). */
export function resolveOwnedChildResult(
	owner: C04ChildResultOwner,
	handleId: string,
	childArtifactRoot: string,
	now = new Date(),
): { result: C04PublicChildResult; capability: object } | undefined {
	try {
		const verified = validateOwner(owner);
		const root = prepareBoundRoot(verified, childArtifactRoot, false);
		const indexed = readHandleIndex(root, handleId);
		const result = readStored(root, indexed.resultId);
		if (
			!sameOwner(indexed.owner, verified) ||
			!sameOwner(result.owner, verified) ||
			!result.artifacts.some((a) => a.handleId === handleId)
		)
			return denied(root, "owner_mismatch");
		const current = expireIfElapsed(root, result, now);
		const artifact = current.artifacts.find((value) => value.handleId === handleId);
		if (!artifact || artifact.retentionState !== "retained") return denied(root, "unavailable");
		const capability = Object.freeze({});
		capabilities.set(capability, {
			root,
			owner: current.owner,
			handleId,
			resultId: current.resultId,
			generation: current.generation,
		});
		appendAudit(root, "read_allowed", "resolved", handleId);
		return { result: projection(current), capability };
	} catch {
		return undefined;
	}
}

/** Reads at most one C04 chunk and checks owner, retention and digest before returning bytes. */
export function readOwnedArtifact(
	capability: object,
	range: { offset: number; length: number },
): Uint8Array | undefined {
	const grant = capabilities.get(capability);
	if (
		!grant ||
		!Number.isSafeInteger(range.offset) ||
		!Number.isSafeInteger(range.length) ||
		range.offset < 0 ||
		range.length < 0 ||
		range.length > MAX_STREAM_CHUNK_BYTES
	)
		return undefined;
	try {
		// Capabilities are bearer objects, not a substitute for the SessionManager
		// binding: revalidate the parent/runtime-owned child root on every read.
		if (prepareBoundRoot(grant.owner, dirname(grant.root), false) !== grant.root) return undefined;
		// Retention is evaluated for every capability read, not merely resolution.
		const result = expireIfElapsed(grant.root, readStored(grant.root, grant.resultId), new Date());
		if (!sameOwner(result.owner, grant.owner)) return denied(grant.root, "owner_mismatch");
		const artifact = result.artifacts.find((a) => a.handleId === grant.handleId);
		if (!artifact || artifact.retentionState !== "retained" || range.offset > artifact.byteLength)
			return denied(grant.root, "unavailable");
		const file = safePath(grant.root, "objects", `${artifact.handleId}.blob`);
		const fd = openSyncNoFollow(file, "r");
		try {
			const before = fstatSync(fd);
			if (!before.isFile() || before.size !== artifact.byteLength) return denied(grant.root, "integrity");
			const hash = hashOpenFile(fd, artifact.byteLength);
			const after = fstatSync(fd);
			if (
				hash !== artifact.sha256 ||
				after.dev !== before.dev ||
				after.ino !== before.ino ||
				after.size !== artifact.byteLength
			)
				return denied(grant.root, "integrity");
			const bytes = Buffer.allocUnsafe(Math.min(range.length, artifact.byteLength - range.offset));
			const read = readSync(fd, bytes, 0, bytes.length, range.offset);
			const final = fstatSync(fd);
			// The disposition record is authoritative over a prior capability. Re-read
			// it after the range read and require its generation, retained state,
			// digest and inode to be unchanged before exposing any bytes.
			const finalResult = readStored(grant.root, grant.resultId);
			const finalArtifact = finalResult.artifacts.find((a) => a.handleId === grant.handleId);
			if (
				final.size !== artifact.byteLength ||
				final.dev !== before.dev ||
				final.ino !== before.ino ||
				hashOpenFile(fd, artifact.byteLength) !== artifact.sha256 ||
				!sameOwner(finalResult.owner, grant.owner) ||
				finalResult.generation !== grant.generation ||
				finalResult.retentionState !== "retained" ||
				!finalArtifact ||
				finalArtifact.retentionState !== "retained" ||
				finalArtifact.sha256 !== artifact.sha256 ||
				finalArtifact.byteLength !== artifact.byteLength
			)
				return denied(grant.root, "integrity");
			appendAudit(grant.root, "read_allowed", "read", artifact.handleId);
			return bytes.subarray(0, read);
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/** Idempotently records an explicit retention/delete disposition for an exact owner/result/handle. */
export function recordChildResultDisposition(
	owner: C04ChildResultOwner,
	input: { resultId: string; handleId?: string; disposition: "expired" | "deleted" },
	childArtifactRoot: string,
): boolean {
	try {
		const verified = validateOwner(owner);
		const root = prepareBoundRoot(verified, childArtifactRoot, false);
		return withDispositionLock(root, verified, input.resultId, () => {
			// Re-read *under* the inter-process lock. This is a generation-CAS
			// equivalent: no contender can base its transition on an older record.
			const result = readStored(root, input.resultId);
			if (!sameOwner(result.owner, verified)) return false;
			if (input.handleId && !result.artifacts.some((a) => a.handleId === input.handleId)) return false;
			const changed = result.artifacts.map((artifact) =>
				artifact.handleId === input.handleId || !input.handleId
					? { ...artifact, retentionState: input.disposition }
					: artifact,
			);
			const anyRetained = changed.some((artifact) => artifact.retentionState === "retained");
			const resultState = anyRetained ? "retained" : input.disposition;
			const stateChanged =
				canonicalJson(changed) !== canonicalJson(result.artifacts) || result.retentionState !== resultState;
			if (!stateChanged) return true;
			// The replacement is durable before any corresponding blob is unlinked.
			atomicJson(safePath(root, "results", `${result.resultId}.json`), {
				...result,
				artifacts: changed,
				retentionState: resultState,
				generation: result.generation + 1,
			});
			appendAudit(root, input.disposition, input.disposition, input.handleId ?? input.resultId);
			for (const artifact of changed)
				if (artifact.retentionState !== "retained")
					safeUnlink(safePath(root, "objects", `${artifact.handleId}.blob`));
			return true;
		});
	} catch {
		return false;
	}
}

/** An authenticated result-scoped lock directory serializes retention writers.
 * A bare O_EXCL file is unrecoverable after a crash.  The lease binds exact
 * owner/result, random nonce, PID and PID-start identity under the parent HMAC.
 * Live or unreadable leases fail closed. Only dead/reused identities are moved
 * atomically to quarantine; contenders then race mkdir for the vacant name. */
interface DispositionLeasePayload {
	version: 1;
	owner: C04ChildResultOwner;
	resultId: string;
	nonce: string;
	pid: number;
	processStartId: string;
}
interface DispositionLease extends DispositionLeasePayload {
	mac: string;
}
function withDispositionLock<T>(root: string, owner: C04ChildResultOwner, resultId: string, action: () => T): T {
	if (!isUuid(resultId)) throw new Error("invalid result ID");
	const recoveryKey = readDispositionRecoveryKey(root, owner);
	const lock = safePath(root, "operation-index", `.disposition.${resultId}.lock`);
	const identity = processIdentitySeam.captureCurrent();
	if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || !identity.processStartId)
		throw new Error("C04 exact process identity is unavailable");
	const payload: DispositionLeasePayload = {
		version: 1,
		owner,
		resultId,
		nonce: randomUuid(),
		pid: identity.pid,
		processStartId: identity.processStartId,
	};
	const lease: DispositionLease = { ...payload, mac: dispositionLeaseMac(recoveryKey, payload) };
	const token = canonicalJson(lease);
	let acquired = false;
	for (let attempt = 0; attempt < 32 && !acquired; attempt++) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			const leasePath = join(lock, "lease.json");
			let fd: number | undefined;
			try {
				fd = openSyncNoFollow(leasePath, "wx", 0o600);
				writeAll(fd, Buffer.from(token));
				fsyncSync(fd);
			} finally {
				if (fd !== undefined) closeSync(fd);
			}
			fsyncDirectory(lock);
			fsyncDirectory(dirname(lock));
			acquired = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let previous: DispositionLease;
			try {
				previous = readDispositionLease(lock, recoveryKey);
				if (!sameOwner(previous.owner, owner) || previous.resultId !== resultId) throw new Error("foreign");
			} catch (readError) {
				// The stale directory may have been renamed by another contender
				// after our mkdir lost. Race mkdir again; all other unreadable
				// lease states fail closed.
				if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw new Error("C04 disposition lock is uncertain");
			}
			const state = processIdentitySeam.observe(previous);
			if (state === "live" || state === "unreadable") throw new Error("C04 disposition lock is uncertain");
			// Atomic rename is the stale-owner CAS. Keep quarantine as evidence;
			// never unlink, steal, or clean a foreign/live lease.
			const quarantine = safePath(
				root,
				"operation-index",
				`.disposition.${resultId}.dead.${previous.nonce}.${randomUuid()}.lock`,
			);
			try {
				renameSync(lock, quarantine);
				fsyncDirectory(dirname(lock));
			} catch (renameError) {
				if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
			}
		}
	}
	if (!acquired) throw new Error("C04 disposition lock unavailable");
	try {
		return action();
	} finally {
		// Cleanup is bound to this exact nonce/token, never a replacement lease.
		try {
			const leasePath = join(lock, "lease.json");
			if (readFileSync(leasePath, "utf8") === token) {
				unlinkSync(leasePath);
				rmdirSync(lock);
				fsyncDirectory(dirname(lock));
			}
		} catch {
			/* failed cleanup remains an authenticated recoverable lease */
		}
	}
}
function dispositionLeaseMac(key: Buffer, payload: DispositionLeasePayload): string {
	return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
}
function readDispositionLease(lock: string, key: Buffer): DispositionLease {
	const leasePath = join(lock, "lease.json");
	const stat = lstatSync(leasePath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error("invalid disposition lease");
	const value: unknown = JSON.parse(readFileSync(leasePath, "utf8"));
	if (
		!isObject(value) ||
		!exactKeys(value, ["version", "owner", "resultId", "nonce", "pid", "processStartId", "mac"]) ||
		value.version !== 1 ||
		!isUuid(value.resultId) ||
		!isUuid(value.nonce) ||
		!Number.isSafeInteger(value.pid) ||
		value.pid < 1 ||
		typeof value.processStartId !== "string" ||
		!value.processStartId ||
		typeof value.mac !== "string" ||
		!SHA256.test(value.mac)
	)
		throw new Error("invalid disposition lease");
	const payload: DispositionLeasePayload = {
		version: 1,
		owner: validateOwner(value.owner as C04ChildResultOwner),
		resultId: value.resultId,
		nonce: value.nonce,
		pid: value.pid,
		processStartId: value.processStartId,
	};
	const expected = Buffer.from(dispositionLeaseMac(key, payload), "hex");
	const actual = Buffer.from(value.mac, "hex");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
		throw new Error("invalid disposition lease");
	return { ...payload, mac: value.mac };
}
function readDispositionRecoveryKey(root: string, owner: C04ChildResultOwner): Buffer {
	const childRoot = dirname(root);
	let state = dirname(dirname(childRoot));
	for (;;) {
		const parentArtifactRoot = join(state, "session-artifacts", owner.parentSessionId);
		try {
			return readParentRecoveryKey(owner, childRoot, {
				parentSessionFile: join(state, "sessions", `${owner.parentSessionId}.jsonl`),
				parentArtifactRoot,
				recoveryKeyPath: join(parentArtifactRoot, ".c04-recovery-key"),
			});
		} catch {
			/* candidate parent must pass exact binding */
		}
		const next = dirname(state);
		if (next === state) break;
		state = next;
	}
	throw new Error("C04 disposition recovery authority is unavailable");
}

export function canonicalChildResultBytes(value: C04ChildResultReference): Uint8Array {
	assertReference(value);
	return Buffer.from(canonicalJson(value));
}

/** A bounded C04-shaped terminal used when durable storage itself is unavailable. */
export function terminalStorageFailedProjection(
	input: { status?: Exclude<C04ChildResultStatus, "completed">; model?: Partial<C04ModelMetadata> } = {},
): C04ChildResultReference {
	const status = input.status ?? "failed";
	const model = validateModel(input.model);
	const result: C04ChildResultReference = {
		version: 1,
		resultId: randomUuid(),
		status,
		summary: "Child terminal storage failed.",
		preview: "A bounded terminal result could not be persisted.",
		error: { code: "terminal_storage_failed", message: "Terminal result storage failed." },
		model,
		artifacts: [],
		retentionState: "unavailable",
	};
	assertReference(result);
	return result;
}

function validateOwner(value: C04ChildResultOwner): C04ChildResultOwner {
	if (
		!isObject(value) ||
		!exactKeys(value as unknown as Record<string, unknown>, [
			"parentSessionId",
			"childSessionId",
			"childSessionFile",
			"assignmentId",
			"operationId",
			"deliveryId",
		])
	)
		throw new Error("invalid C04 owner");
	for (const key of ["parentSessionId", "childSessionId", "assignmentId", "operationId", "deliveryId"] as const)
		if (!isCanonicalUuid(value[key])) throw new Error(`invalid C04 owner ${key}`);
	if (typeof value.childSessionFile !== "string" || !value.childSessionFile || !isAbsolute(value.childSessionFile))
		throw new Error("invalid C04 child session file");
	return { ...value, childSessionFile: resolve(value.childSessionFile) };
}
function validateCandidate(
	value: C04TerminalCandidate,
): Required<Pick<C04TerminalCandidate, "status" | "summary" | "preview" | "facts" | "nextActions" | "model">> &
	Pick<C04TerminalCandidate, "error" | "artifacts"> {
	if (
		!isObject(value) ||
		!exactKeys(value as unknown as Record<string, unknown>, [
			"status",
			"summary",
			"preview",
			...optionalKeys(value as unknown as Record<string, unknown>, [
				"facts",
				"nextActions",
				"error",
				"model",
				"artifacts",
			]),
		])
	)
		throw new Error("invalid C04 terminal candidate");
	if (!statuses.has(value.status)) throw new Error("invalid C04 terminal status");
	const status = value.status as C04ChildResultStatus;
	const summary = safeText(value.summary, MAX_SUMMARY_CHARS, MAX_SUMMARY_BYTES, "summary");
	const preview = safeText(value.preview, MAX_PREVIEW_CHARS, MAX_PREVIEW_BYTES, "preview");
	const facts = Array.isArray(value.facts) ? value.facts : [];
	if (
		facts.length > MAX_FACTS ||
		!facts.every((f) => isObject(f) && exactKeys(f, ["claim", ...optionalKeys(f, ["evidenceRef"])]))
	)
		throw new Error("invalid C04 facts");
	const normalizedFacts = facts.map((f) => ({
		claim: safeText(f.claim, 1024, 4096, "fact"),
		...(typeof f.evidenceRef === "string" && isUuid(f.evidenceRef) ? { evidenceRef: f.evidenceRef } : {}),
	}));
	const nextActions = Array.isArray(value.nextActions) ? value.nextActions : [];
	if (nextActions.length > MAX_NEXT_ACTIONS) throw new Error("too many next actions");
	const normalizedNext = nextActions.map((a) => safeText(a, 512, 2048, "next action"));
	let error: { code: C04ErrorCode; message: string; diagnostic?: C04ArtifactInput } | undefined;
	if (status === "completed") {
		if (value.error !== undefined) throw new Error("completed C04 result has error");
	} else {
		if (!isObject(value.error)) throw new Error("failed C04 result requires error");
		const rawCode =
			typeof value.error.code === "string" && errorCodes.has(value.error.code)
				? (value.error.code as C04ErrorCode)
				: status === "cancelled"
					? "cancelled"
					: status === "timed_out"
						? "timed_out"
						: status === "stalled"
							? "stalled"
							: status === "unknown_after_crash"
								? "unknown_after_crash"
								: "invalid_result";
		error = {
			code: rawCode,
			message: safeText(value.error.message ?? "Terminal result unavailable", 1024, 4096, "error"),
		};
		if (value.error.diagnostic) error.diagnostic = validateArtifact(value.error.diagnostic);
	}
	const model = validateModel(value.model);
	// A diagnostic is materialized as an artifact. Validate the complete set before
	// consuming any producer so a 17th artifact can never fail halfway through a stream.
	const rawArtifacts = value.artifacts === undefined ? [] : value.artifacts;
	if (!Array.isArray(rawArtifacts) || rawArtifacts.length > MAX_ARTIFACTS_PER_RESULT)
		throw new Error("invalid C04 artifacts");
	if (rawArtifacts.length + (error?.diagnostic ? 1 : 0) > MAX_ARTIFACTS_PER_RESULT)
		throw new Error("C04 artifact count reserves a diagnostic slot");
	const artifacts = rawArtifacts.map(validateArtifact);
	return { status, summary, preview, facts: normalizedFacts, nextActions: normalizedNext, error, model, artifacts };
}
function validateModel(value: unknown): C04ModelMetadata {
	const source = isObject(value) ? value : {};
	if (
		Object.keys(source).some(
			(key) =>
				!["requestedSelector", "initialResolvedSelector", "terminalResolvedSelector", "fallbackHistory"].includes(
					key,
				),
		)
	)
		throw new Error("invalid C04 model");
	const initialResolvedSelector = safeText(source.initialResolvedSelector ?? "unknown", 256, 1024, "model");
	const terminalResolvedSelector = safeText(
		source.terminalResolvedSelector ?? initialResolvedSelector,
		256,
		1024,
		"model",
	);
	const history =
		source.fallbackHistory === undefined
			? undefined
			: Array.isArray(source.fallbackHistory) && source.fallbackHistory.length <= 16
				? source.fallbackHistory.map((v) => safeText(v, 256, 1024, "model fallback"))
				: (() => {
						throw new Error("invalid model fallback");
					})();
	return {
		...(source.requestedSelector === undefined
			? {}
			: { requestedSelector: safeText(source.requestedSelector, 256, 1024, "requested model") }),
		initialResolvedSelector,
		terminalResolvedSelector,
		...(history ? { fallbackHistory: history } : {}),
	};
}
function validateArtifact(value: unknown): C04ArtifactInput {
	if (
		!isObject(value) ||
		!exactKeys(value, ["kind", "contentType", "data"]) ||
		!kinds.has(value.kind) ||
		!contentTypes.has(value.contentType) ||
		!isAsyncIterable(value.data)
	)
		throw new Error("invalid C04 artifact: payload must be an AsyncIterable<Uint8Array>");
	return value as C04ArtifactInput;
}
async function writeArtifact(
	root: string,
	owner: C04ChildResultOwner,
	resultId: string,
	artifact: C04ArtifactInput,
	used = aggregateBytes(root, owner),
	recordHandle?: (handleId: string) => void,
): Promise<C04OpaqueArtifactReference> {
	const handleId = randomUuid();
	recordHandle?.(handleId);
	const finalPath = safePath(root, "objects", `${handleId}.blob`);
	const temp = safePath(root, "objects", `.${handleId}.${randomUuid()}.tmp`);
	let fd: number | undefined;
	const hash = createHash("sha256");
	let count = 0;
	try {
		fd = openSyncNoFollow(temp, "wx", 0o600);
		for await (const chunk of chunks(artifact.data)) {
			if (chunk.length > MAX_STREAM_CHUNK_BYTES) throw new Error("C04 stream chunk exceeds limit");
			count += chunk.length;
			if (count > MAX_ARTIFACT_BYTES) throw new Error("C04 artifact exceeds limit");
			if (used + count > MAX_ARTIFACT_BYTES_PER_CHILD_SESSION)
				throw new Error("C04 session artifact quota exceeded");
			hash.update(chunk);
			writeAll(fd, chunk);
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		publishExclusive(temp, finalPath);
		return {
			version: 1,
			handleId,
			resultId,
			kind: artifact.kind,
			contentType: artifact.contentType,
			byteLength: count,
			sha256: hash.digest("hex"),
			creatorAssignmentId: owner.assignmentId,
			ownerSessionId: owner.childSessionId,
			retentionState: "retained",
		};
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		safeUnlink(temp);
		throw error;
	}
}
async function* chunks(data: C04ArtifactInput["data"]): AsyncGenerator<Uint8Array> {
	for await (const chunk of data) {
		if (!(chunk instanceof Uint8Array)) throw new Error("C04 stream yielded non-bytes");
		yield chunk;
	}
}

function aggregateBytes(root: string, owner: C04ChildResultOwner): number {
	let total = 0;
	for (const name of readdirSync(safePath(root, "results"))) {
		if (!name.endsWith(".json")) continue;
		try {
			const r = readStored(root, name.slice(0, -5));
			if (
				r.owner.parentSessionId === owner.parentSessionId &&
				r.owner.childSessionId === owner.childSessionId &&
				r.owner.childSessionFile === owner.childSessionFile
			)
				total += r.artifacts.reduce((n, a) => n + (a.retentionState === "retained" ? a.byteLength : 0), 0);
		} catch {
			throw new Error("uncertain C04 result store");
		}
	}
	return total;
}
const operationReservations = new Set<string>();
/** A reservation is a durable, authenticated ownership journal. Its nonce, PID
 * and start time make restart reconciliation distinguish a live writer from a
 * dead attempt; its result ID makes every publish cut recoverable. */
interface ReservationJournalPayload {
	version: 1;
	owner: C04ChildResultOwner;
	indexPath: string;
	nonce: string;
	pid: number;
	/** Exact PID incarnation captured at reservation creation. */
	processStartId: string;
	progress: "reserved" | "publishing";
	resultId: string;
	/** Every generated blob handle is journaled before its destination exists. */
	handleIds?: string[];
}
interface ReservationJournal extends ReservationJournalPayload {
	/** HMAC-SHA256 over the canonical payload. Never project this or the key. */
	mac: string;
}
export interface C04ProcessIdentitySeam {
	captureCurrent(): { pid: number; processStartId: string } | undefined;
	observe(identity: { pid: number; processStartId: string }): "live" | "dead" | "mismatch" | "unreadable";
}
const productionProcessIdentitySeam: C04ProcessIdentitySeam = {
	captureCurrent() {
		const processStartId = getProcessStartId(process.pid);
		return processStartId ? { pid: process.pid, processStartId } : undefined;
	},
	observe(identity) {
		try {
			process.kill(identity.pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
			return "unreadable";
		}
		const observed = getProcessStartId(identity.pid);
		if (!observed) return "unreadable";
		return observed === identity.processStartId ? "live" : "mismatch";
	},
};
let processIdentitySeam = productionProcessIdentitySeam;
/** Test-only identity seam. Production always captures PID plus its start token. */
export function setC04ProcessIdentitySeamForTest(seam: C04ProcessIdentitySeam): () => void {
	const previous = processIdentitySeam;
	processIdentitySeam = seam;
	return () => {
		processIdentitySeam = previous;
	};
}
function reserveOperationAndQuota(
	root: string,
	owner: C04ChildResultOwner,
	indexPath: string,
	recoveryKey: Buffer,
): { release: () => void; resultId: string; recordHandle: (handleId: string) => void } {
	const key = `${root}:${owner.parentSessionId}:${owner.childSessionId}:${owner.assignmentId}`;
	if (operationReservations.has(key)) throw immutableConflict(root, owner.operationId);
	const reservation = safePath(root, "operation-index", `.${owner.operationId}.reserve`);
	const quotaReservation = safePath(root, "operation-index", `.quota.${owner.childSessionId}.reserve`);
	const identity = processIdentitySeam.captureCurrent();
	if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || !identity.processStartId)
		throw new Error("C04 exact process identity is unavailable");
	const payload: ReservationJournalPayload = {
		version: 1,
		owner,
		indexPath,
		nonce: randomUuid(),
		pid: identity.pid,
		processStartId: identity.processStartId,
		progress: "reserved",
		resultId: randomUuid(),
		handleIds: [],
	};
	let journal: ReservationJournal = { ...payload, mac: reservationMac(recoveryKey, payload) };
	const token = canonicalJson(journal);
	let operationFd: number | undefined;
	let quotaFd: number | undefined;
	try {
		operationFd = openSyncNoFollow(reservation, "wx", 0o600);
		writeAll(operationFd, Buffer.from(token));
		fsyncSync(operationFd);
		quotaFd = openSyncNoFollow(quotaReservation, "wx", 0o600);
		writeAll(quotaFd, Buffer.from(token));
		fsyncSync(quotaFd);
		closeSync(operationFd);
		closeSync(quotaFd);
		operationFd = quotaFd = undefined;
		fsyncDirectory(dirname(reservation));
		operationReservations.add(key);
	} catch {
		if (operationFd !== undefined) closeSync(operationFd);
		if (quotaFd !== undefined) closeSync(quotaFd);
		unlinkReservationIfOwned(reservation, token);
		unlinkReservationIfOwned(quotaReservation, token);
		throw immutableConflict(root, owner.operationId);
	}
	let currentToken = token;
	let currentQuotaToken = token;
	return {
		resultId: journal.resultId,
		recordHandle: (handleId: string) => {
			if (!isUuid(handleId) || (journal.handleIds ?? []).includes(handleId))
				throw new Error("invalid C04 journal handle");
			journal = { ...journal, progress: "publishing", handleIds: [...(journal.handleIds ?? []), handleId] };
			journal.mac = reservationMac(recoveryKey, journal);
			const next = canonicalJson(journal);
			// Reservation ownership is still protected by the O_EXCL name. Update it
			// durably before publishing the random blob name, so crash recovery owns
			// the same-attempt orphan even if no result record was written.
			// A crash observes either the old complete HMAC journal or the new
			// complete HMAC journal, never an in-place truncated intermediate.
			if (readFileSync(reservation, "utf8") !== currentToken) throw new Error("C04 reservation ownership changed");
			if (readFileSync(quotaReservation, "utf8") !== currentQuotaToken)
				throw new Error("C04 quota reservation ownership changed");
			atomicJson(reservation, journal);
			// A cut between these two replacements leaves two independently valid
			// journals for the same nonce/result; recovery accepts either version.
			atomicJson(quotaReservation, journal);
			currentToken = next;
			currentQuotaToken = next;
		},
		release: () => {
			operationReservations.delete(key);
			unlinkReservationIfOwned(reservation, currentToken);
			unlinkReservationIfOwned(quotaReservation, currentQuotaToken);
			fsyncDirectory(dirname(reservation));
		},
	};
}
/** Restart recovery never deletes a competing result. A dead attempt is either
 * completed from its exact durable cross-indexes or tombstoned after removing
 * only names authenticated by that attempt's random result/handle identities. */
function reconcileAbandonedReservation(
	root: string,
	owner: C04ChildResultOwner,
	indexPath: string,
	recoveryKey: Buffer,
): void {
	const path = safePath(root, "operation-index", `.${owner.operationId}.reserve`);
	let journal: ReservationJournal;
	let token: string;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw immutableConflict(root, owner.operationId);
		token = readFileSync(path, "utf8");
		journal = parseAuthenticatedReservation(token, recoveryKey);
		if (
			!sameOwner(journal.owner, owner) ||
			realpathSync(dirname(journal.indexPath)) !== realpathSync(dirname(indexPath)) ||
			basename(journal.indexPath) !== basename(indexPath)
		)
			throw immutableConflict(root, owner.operationId);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		if (error instanceof Error && error.message === "C04 immutable operation conflict") throw error;
		// Missing/corrupt/foreign journals are live uncertainty, never stale cleanup.
		throw immutableConflict(root, owner.operationId);
	}
	const identity = processIdentitySeam.observe(journal);
	if (identity === "live" || identity === "unreadable") throw immutableConflict(root, owner.operationId);
	// Only a proven dead PID or a same-PID different-start-token can be reclaimed.
	try {
		const result = readStored(root, journal.resultId);
		if (!sameOwner(result.owner, owner)) throw new Error("foreign result");
		// A durable result is sufficient to reconstruct every missing cross-index.
		for (const artifact of result.artifacts) {
			const blob = safePath(root, "objects", `${artifact.handleId}.blob`);
			const st = statSync(blob);
			if (!st.isFile() || st.size !== artifact.byteLength) throw new Error("missing blob");
			const handle = safePath(root, "handle-index", `${artifact.handleId}.json`);
			if (!readHandleIndexIfMatching(root, artifact.handleId, result.resultId, owner))
				atomicExclusiveJson(handle, { version: 1, resultId: result.resultId, owner, handleId: artifact.handleId });
		}
		if (!readIndex(indexPath))
			atomicExclusiveJson(indexPath, {
				version: 1,
				resultId: result.resultId,
				owner,
				requestDigest: result.requestDigest,
			});
		appendAudit(root, "linked", "restart_reconciled", result.resultId);
	} catch {
		cleanUnindexedOwnedAttempt(
			root,
			owner,
			journal.resultId,
			(journal.handleIds ?? []).map((handleId) => ({ handleId }) as C04OpaqueArtifactReference),
		);
		appendAudit(root, "uncertain", "restart_tombstoned", journal.resultId);
	}
	unlinkReservationIfOwned(path, token);
	// A cut between journal replacements can leave quota at the prior complete
	// version. Delete it only after independently authenticating the same attempt.
	unlinkQuotaReservationForAttempt(
		safePath(root, "operation-index", `.quota.${owner.childSessionId}.reserve`),
		recoveryKey,
		journal,
	);
	fsyncDirectory(dirname(path));
}
function reservationMac(key: Buffer, payload: ReservationJournalPayload): string {
	return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
}
function parseAuthenticatedReservation(token: string, key: Buffer): ReservationJournal {
	const value: unknown = JSON.parse(token);
	if (
		!isObject(value) ||
		!exactKeys(value, [
			"version",
			"owner",
			"indexPath",
			"nonce",
			"pid",
			"processStartId",
			"progress",
			"resultId",
			...optionalKeys(value, ["handleIds"]),
			"mac",
		]) ||
		value.version !== 1 ||
		!isUuid(value.nonce) ||
		!isUuid(value.resultId) ||
		(value.handleIds !== undefined &&
			(!Array.isArray(value.handleIds) || value.handleIds.some((handleId) => !isUuid(handleId)))) ||
		!Number.isSafeInteger(value.pid) ||
		value.pid < 1 ||
		typeof value.processStartId !== "string" ||
		!value.processStartId ||
		(value.progress !== "reserved" && value.progress !== "publishing") ||
		typeof value.mac !== "string" ||
		!SHA256.test(value.mac)
	)
		throw new Error("invalid C04 reservation journal");
	// Do not validate/normalize owner, result, index, or nonce until the MAC
	// authenticates the exact canonical disk payload.
	const payload: ReservationJournalPayload = {
		version: value.version,
		owner: value.owner as C04ChildResultOwner,
		indexPath: value.indexPath as string,
		nonce: value.nonce,
		pid: value.pid,
		processStartId: value.processStartId,
		progress: value.progress,
		resultId: value.resultId,
		...(value.handleIds === undefined ? {} : { handleIds: value.handleIds as string[] }),
	};
	if (typeof payload.indexPath !== "string") throw new Error("invalid C04 reservation journal");
	const expected = Buffer.from(reservationMac(key, payload), "hex");
	const actual = Buffer.from(value.mac, "hex");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
		throw new Error("invalid C04 reservation MAC");
	return { ...payload, owner: validateOwner(payload.owner), mac: value.mac };
}
function readHandleIndexIfMatching(
	root: string,
	handleId: string,
	resultId: string,
	owner: C04ChildResultOwner,
): boolean {
	try {
		const value = readHandleIndex(root, handleId);
		return value.resultId === resultId && sameOwner(value.owner, owner);
	} catch {
		return false;
	}
}
function unlinkQuotaReservationForAttempt(path: string, key: Buffer, attempt: ReservationJournal): void {
	try {
		const token = readFileSync(path, "utf8");
		const quota = parseAuthenticatedReservation(token, key);
		if (sameOwner(quota.owner, attempt.owner) && quota.nonce === attempt.nonce && quota.resultId === attempt.resultId)
			unlinkReservationIfOwned(path, token);
	} catch {
		// Never remove an unreadable, foreign, or unauthenticated quota lease.
	}
}
function unlinkReservationIfOwned(path: string, token: string): void {
	try {
		const stat = lstatSync(path);
		if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192 && readFileSync(path, "utf8") === token)
			unlinkSync(path);
	} catch {}
}
function immutableConflict(root: string, operationId: string): Error {
	appendAudit(root, "uncertain", "immutable_conflict", operationId);
	return new Error("C04 immutable operation conflict");
}
/** Reads a SessionManager-owned recovery key only after proving it belongs to
 * the parent whose ID is in the C04 owner. Missing, corrupt or redirected keys
 * are fail-closed: recovery must not trust an unauthenticated journal. */
function readParentRecoveryKey(
	owner: C04ChildResultOwner,
	childArtifactRoot: string,
	authority: C04ParentRecoveryAuthority,
): Buffer {
	if (
		!isObject(authority) ||
		typeof authority.parentSessionFile !== "string" ||
		typeof authority.parentArtifactRoot !== "string" ||
		typeof authority.recoveryKeyPath !== "string"
	)
		throw new Error("invalid C04 parent recovery authority");
	const parentFile = canonicalExistingRegularFile(authority.parentSessionFile);
	if (!parentFile) throw new Error("C04 parent recovery authority is unavailable");
	let header: unknown;
	try {
		header = JSON.parse(readFileSync(parentFile, "utf8").split(/\r?\n/, 1)[0] ?? "");
	} catch {
		throw new Error("C04 parent recovery authority is corrupt");
	}
	if (!isObject(header) || header.type !== "session" || header.id !== owner.parentSessionId)
		throw new Error("C04 parent recovery authority does not match owner");
	const parentRoot = canonicalDirectoryNoSymlinks(authority.parentArtifactRoot);
	const expectedParentRoot = join(dirname(dirname(parentFile)), "session-artifacts", owner.parentSessionId);
	if (parentRoot !== expectedParentRoot) throw new Error("C04 parent recovery artifact binding is invalid");
	// A nested RLM child keeps its session and artifact root below the parent
	// artifact directory. Both roots must be bound to the same parent state,
	// rather than merely being siblings (which is true only for top-level
	// SessionManager sessions).
	const childRoot = canonicalDirectoryNoSymlinks(childArtifactRoot);
	const childStateRoot = dirname(dirname(canonicalExistingRegularFile(owner.childSessionFile)!));
	const topLevelSibling = dirname(parentRoot) === dirname(childRoot);
	const nestedChild = parentRoot === childStateRoot && childRoot.startsWith(`${parentRoot}${sep}`);
	if (!topLevelSibling && !nestedChild) throw new Error("C04 parent recovery authority is foreign");
	let keyPath = resolve(authority.recoveryKeyPath);
	try {
		if (basename(keyPath) !== ".c04-recovery-key" || realpathSync(dirname(keyPath)) !== parentRoot)
			throw new Error("C04 recovery key path is invalid");
		keyPath = join(parentRoot, ".c04-recovery-key");
	} catch {
		throw new Error("C04 recovery key path is invalid");
	}
	let fd: number | undefined;
	try {
		const st = lstatSync(keyPath);
		if (!st.isFile() || st.isSymbolicLink() || st.size !== 32 || (st.mode & 0o777) !== 0o600)
			throw new Error("C04 recovery key is invalid");
		fd = openSyncNoFollow(keyPath, "r");
		const bytes = Buffer.alloc(32);
		if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || readSync(fd, Buffer.alloc(1), 0, 1, 32) !== 0)
			throw new Error("C04 recovery key is truncated");
		const after = fstatSync(fd);
		if (after.dev !== st.dev || after.ino !== st.ino || after.size !== 32)
			throw new Error("C04 recovery key changed");
		return bytes;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
/** The C04 root belongs below, not beside, the validated child artifact dir. */
function validateChildBinding(owner: C04ChildResultOwner, childArtifactRoot: string): void {
	const file = canonicalExistingRegularFile(owner.childSessionFile);
	if (!file) throw new Error("C04 child session file is not a stable regular file");
	// Re-read the SessionManager-issued header, rather than trusting a pathname.
	try {
		const header = JSON.parse(readFileSync(file, "utf8").split(/\r?\n/, 1)[0] ?? "");
		if (!isObject(header) || header.type !== "session" || header.id !== owner.childSessionId)
			throw new Error("invalid session header");
	} catch {
		throw new Error("C04 child session header binding is invalid");
	}
	const root = canonicalDirectoryNoSymlinks(childArtifactRoot);
	const sessionId = owner.childSessionId;
	// This is the one layout SessionManager publishes. IDs and paths are all
	// checked together so a sibling session's root cannot be substituted.
	const sessionDir = dirname(file);
	// RLM children use a private per-child session directory below their
	// parent's artifact root, while top-level sessions use `sessions/`. Both
	// are SessionManager layouts: in either case its artifact root is the
	// sibling `session-artifacts/<sessionId>` of that exact session directory.
	if (basename(file) !== `${sessionId}.jsonl`)
		throw new Error("C04 child session file is not the exact SessionManager child binding");
	const expected = join(dirname(sessionDir), "session-artifacts", sessionId);
	if (root !== expected) throw new Error("C04 child artifact root is not the exact SessionManager child binding");
}
function canonicalExistingRegularFile(path: string): string | undefined {
	try {
		const st = lstatSync(path);
		return st.isFile() && !st.isSymbolicLink() ? realpathSync(path) : undefined;
	} catch {
		return undefined;
	}
}
function canonicalDirectoryNoSymlinks(path: string): string {
	const requested = resolve(path);
	const requestedStat = lstatSync(requested);
	if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink())
		throw new Error("C04 rejects symlink/non-directory root");
	// Normalize OS-owned aliases (/var -> /private/var on macOS), then reject every
	// application-visible ancestor from the canonical path downward.
	const absolute = realpathSync(requested);
	const { root } = parse(absolute);
	let current = root;
	for (const part of relative(root, absolute).split(/[/\\]/).filter(Boolean)) {
		current = join(current, part);
		const st = lstatSync(current);
		if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("C04 rejects symlink/non-directory ancestor");
	}
	return absolute;
}
/** Re-check the SessionManager-shaped child binding before every C04 operation.
 * SessionManager owns `<state>/sessions/<id>.jsonl` and
 * `<state>/session-artifacts/<id>`; accepting merely a common ancestor would
 * let a sibling child supply its artifact directory. */
function prepareBoundRoot(owner: C04ChildResultOwner, childArtifactRoot: string, create = true): string {
	validateChildBinding(owner, childArtifactRoot);
	const base = assertPrivateDirectory(childArtifactRoot);
	const root = join(base, "rlm-child-results");
	if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
	assertPrivateDirectory(root);
	for (const dir of ["operation-index", "results", "objects", "handle-index"]) {
		const path = join(root, dir);
		if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
		assertPrivateDirectory(path);
	}
	return root;
}
function assertPrivateDirectory(path: string): string {
	const canonical = canonicalDirectoryNoSymlinks(path);
	const stat = lstatSync(canonical);
	if ((stat.mode & 0o077) !== 0) {
		chmodSync(canonical, 0o700);
		if ((lstatSync(canonical).mode & 0o077) !== 0) throw new Error("C04 directory is not owner-private");
	}
	return canonical;
}
function safePath(root: string, directory: string, name?: string): string {
	if (
		!/^[a-z-]+$/.test(directory) ||
		(name !== undefined && (!/^[a-z0-9.-]+(?:\.(?:json|blob|tmp|reserve|lock))?$/.test(name) || name.includes("..")))
	)
		throw new Error("invalid C04 generated path");
	const target = name === undefined ? join(root, directory) : join(root, directory, name);
	if (relative(root, target).startsWith("..") || resolve(target) === root)
		throw new Error("C04 containment violation");
	return target;
}
function readStored(root: string, resultId: string): StoredChildResult {
	if (!isUuid(resultId)) throw new Error("invalid result ID");
	const path = safePath(root, "results", `${resultId}.json`);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHILD_RESULT_JSON_BYTES)
		throw new Error("unavailable C04 result");
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	assertStored(parsed);
	return parsed;
}
function readIndex(
	path: string,
): { version: 1; resultId: string; owner: C04ChildResultOwner; requestDigest: string } | undefined {
	try {
		const st = lstatSync(path);
		if (!st.isFile() || st.isSymbolicLink() || st.size > 8192) return undefined;
		const x = JSON.parse(readFileSync(path, "utf8"));
		if (
			!isObject(x) ||
			!exactKeys(x, ["version", "resultId", "owner", "requestDigest"]) ||
			x.version !== 1 ||
			!isUuid(x.resultId) ||
			!SHA256.test(x.requestDigest)
		)
			return undefined;
		return {
			version: 1,
			resultId: x.resultId,
			owner: validateOwner(x.owner as C04ChildResultOwner),
			requestDigest: x.requestDigest,
		};
	} catch {
		return undefined;
	}
}
function readHandleIndex(
	root: string,
	handleId: string,
): { resultId: string; owner: C04ChildResultOwner; handleId: string } {
	if (!isUuid(handleId)) throw new Error("invalid handle");
	const path = safePath(root, "handle-index", `${handleId}.json`);
	const st = lstatSync(path);
	if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) throw new Error("not found");
	const index = JSON.parse(readFileSync(path, "utf8"));
	if (
		!isObject(index) ||
		!exactKeys(index, ["version", "resultId", "owner", "handleId"]) ||
		index.version !== 1 ||
		index.handleId !== handleId ||
		!isUuid(index.resultId)
	)
		throw new Error("not found");
	return { resultId: index.resultId, owner: validateOwner(index.owner as C04ChildResultOwner), handleId };
}

function expireIfElapsed(root: string, result: StoredChildResult, now: Date): StoredChildResult {
	// Time is an input to a destructive retention transition. Invalid clocks and
	// malformed timestamps fail closed: preserve bytes and authority rather than
	// treating NaN as already expired.
	const expiresAt = Date.parse(result.retention.expiresAt);
	const current = now.getTime();
	if (!Number.isFinite(expiresAt) || !Number.isFinite(current) || expiresAt > current) return result;
	if (result.retentionState !== "retained") return result;
	return setExpired(root, result);
}
function setExpired(root: string, result: StoredChildResult): StoredChildResult {
	return withDispositionLock(root, result.owner, result.resultId, () => {
		const current = readStored(root, result.resultId);
		if (current.retentionState !== "retained") return current;
		const expired = {
			...current,
			retentionState: "expired" as const,
			artifacts: current.artifacts.map((a) => ({ ...a, retentionState: "expired" as const })),
			generation: current.generation + 1,
		};
		atomicJson(safePath(root, "results", `${current.resultId}.json`), expired);
		appendAudit(root, "expired", "retention_elapsed", current.resultId);
		for (const a of expired.artifacts) safeUnlink(safePath(root, "objects", `${a.handleId}.blob`));
		return expired;
	});
}
function assertC03EnvelopeFits(reference: C04ChildResultReference): void {
	const projection = Buffer.from(canonicalChildResultBytes(reference)).toString("utf8");
	// This invokes C03's own stable serializer and byte accounting. The fixed
	// content/timestamp are deliberately the producer's canonical envelope.
	const envelope = createRlmSafeTerminalResultTerminalMessage(
		"Child completed; bounded result available.",
		projection,
		0,
	);
	if (Buffer.byteLength(canonicalJson(envelope), "utf8") > MAX_RLM_SAFE_TERMINAL_MESSAGE_BYTES)
		throw new Error("C04 projection exceeds C03 safe-terminal envelope");
}
function cleanUnindexedOwnedAttempt(
	root: string,
	owner: C04ChildResultOwner,
	resultId: string,
	artifacts: readonly C04OpaqueArtifactReference[],
): void {
	try {
		const index = readIndex(safePath(root, "operation-index", `${owner.operationId}.json`));
		if (index) return; // A winner was published; never clean around it.
		for (const artifact of artifacts) {
			const handlePath = safePath(root, "handle-index", `${artifact.handleId}.json`);
			let ours = false;
			try {
				const handle = readHandleIndex(root, artifact.handleId);
				ours = handle.resultId === resultId && sameOwner(handle.owner, owner);
				if (ours) safeUnlink(handlePath);
			} catch {
				// A handle named in the authenticated dead-attempt journal has never
				// had a public index, and its random UUID belongs exclusively to it.
				ours = true;
			}
			if (ours) safeUnlink(safePath(root, "objects", `${artifact.handleId}.blob`));
		}
		try {
			const stored = readStored(root, resultId);
			if (sameOwner(stored.owner, owner)) safeUnlink(safePath(root, "results", `${resultId}.json`));
		} catch {}
	} catch {}
}

function projection(result: StoredChildResult): C04ChildResultReference {
	const {
		schemaVersion: _schemaVersion,
		owner: _owner,
		facts: _facts,
		nextActions: _nextActions,
		committedAt: _committedAt,
		retention: _retention,
		requestDigest: _requestDigest,
		generation: _generation,
		...reference
	} = result;
	assertReference(reference);
	return reference;
}
function assertStored(value: unknown): asserts value is StoredChildResult {
	if (
		!isObject(value) ||
		value.schemaVersion !== 1 ||
		!exactKeys(value, [
			"schemaVersion",
			"version",
			"resultId",
			"owner",
			"status",
			"summary",
			"preview",
			"facts",
			"nextActions",
			"model",
			"artifacts",
			"retentionState",
			"committedAt",
			"retention",
			"requestDigest",
			"generation",
			...optionalKeys(value, ["error"]),
		])
	)
		throw new Error("invalid C04 result record");
	assertReference({
		version: value.version,
		resultId: value.resultId,
		status: value.status,
		summary: value.summary,
		preview: value.preview,
		...(value.error === undefined ? {} : { error: value.error }),
		model: value.model,
		artifacts: value.artifacts,
		retentionState: value.retentionState,
	});
	const storedOwner = validateOwner(value.owner as C04ChildResultOwner);
	if (!Number.isSafeInteger(value.generation) || value.generation < 0)
		throw new Error("invalid C04 result generation");
	for (const artifact of value.artifacts as C04OpaqueArtifactReference[]) {
		if (
			artifact.creatorAssignmentId !== storedOwner.assignmentId ||
			artifact.ownerSessionId !== storedOwner.childSessionId
		)
			throw new Error("C04 artifact owner cross-reference mismatch");
	}
	if (
		value.error?.diagnosticRef &&
		!(value.artifacts as C04OpaqueArtifactReference[]).some((a) => a.handleId === value.error?.diagnosticRef)
	)
		throw new Error("C04 diagnostic cross-reference mismatch");
	if (
		!Array.isArray(value.facts) ||
		value.facts.length > MAX_FACTS ||
		!value.facts.every(
			(fact) =>
				isObject(fact) &&
				exactKeys(fact, ["claim", ...optionalKeys(fact, ["evidenceRef"])]) &&
				typeof fact.claim === "string" &&
				(fact.evidenceRef === undefined || isUuid(fact.evidenceRef)),
		) ||
		!Array.isArray(value.nextActions) ||
		value.nextActions.length > MAX_NEXT_ACTIONS ||
		!value.nextActions.every((action) => typeof action === "string") ||
		!isObject(value.retention) ||
		value.retention.disposition !== "retain_until" ||
		typeof value.retention.expiresAt !== "string" ||
		Number.isNaN(Date.parse(value.retention.expiresAt)) ||
		typeof value.committedAt !== "string" ||
		Number.isNaN(Date.parse(value.committedAt)) ||
		typeof value.requestDigest !== "string" ||
		!SHA256.test(value.requestDigest)
	)
		throw new Error("invalid C04 result record");
	// A result remains retained while at least one artifact is retained. This
	// permits an exact-handle disposition without falsely expiring its siblings.
	const storedArtifacts = value.artifacts as C04OpaqueArtifactReference[];
	const hasRetainedArtifact = storedArtifacts.some((a) => a.retentionState === "retained");
	if ((value.retentionState === "retained") !== hasRetainedArtifact && storedArtifacts.length > 0)
		throw new Error("C04 retention consistency mismatch");
}
function assertReference(value: unknown): asserts value is C04ChildResultReference {
	if (
		!isObject(value) ||
		value.version !== 1 ||
		!exactKeys(value, [
			"version",
			"resultId",
			"status",
			"summary",
			"preview",
			"model",
			"artifacts",
			"retentionState",
			...optionalKeys(value, ["error"]),
		]) ||
		!isUuid(value.resultId) ||
		!statuses.has(value.status) ||
		!retentionStates.has(value.retentionState)
	)
		throw new Error("invalid C04 projection");
	safeText(value.summary, MAX_SUMMARY_CHARS, MAX_SUMMARY_BYTES, "summary");
	safeText(value.preview, MAX_PREVIEW_CHARS, MAX_PREVIEW_BYTES, "preview");
	validateModel(value.model);
	if (!Array.isArray(value.artifacts) || value.artifacts.length > MAX_ARTIFACTS_PER_RESULT)
		throw new Error("invalid artifacts");
	for (const a of value.artifacts) assertArtifactRef(a, value.resultId);
	if (
		value.status === "completed"
			? value.error !== undefined
			: !isObject(value.error) || !errorCodes.has(value.error.code) || typeof value.error.message !== "string"
	)
		throw new Error("invalid error");
	if (value.error) {
		if (!exactKeys(value.error, ["code", "message", ...optionalKeys(value.error, ["diagnosticRef"])]))
			throw new Error("invalid error");
		safeText(value.error.message, 1024, 4096, "error");
		if (value.error.diagnosticRef !== undefined && !isUuid(value.error.diagnosticRef))
			throw new Error("invalid diagnostic reference");
	}
	if (Buffer.byteLength(canonicalJson(value)) > MAX_CHILD_RESULT_JSON_BYTES)
		throw new Error("C04 projection too large");
}
function assertArtifactRef(value: unknown, resultId: string): asserts value is C04OpaqueArtifactReference {
	if (
		!isObject(value) ||
		!exactKeys(value, [
			"version",
			"handleId",
			"resultId",
			"kind",
			"contentType",
			"byteLength",
			"sha256",
			"creatorAssignmentId",
			"ownerSessionId",
			"retentionState",
		]) ||
		value.version !== 1 ||
		!isUuid(value.handleId) ||
		value.resultId !== resultId ||
		!kinds.has(value.kind) ||
		!contentTypes.has(value.contentType) ||
		!Number.isSafeInteger(value.byteLength) ||
		value.byteLength < 0 ||
		value.byteLength > MAX_ARTIFACT_BYTES ||
		typeof value.sha256 !== "string" ||
		!SHA256.test(value.sha256) ||
		!isUuid(value.creatorAssignmentId) ||
		!isCanonicalUuid(value.ownerSessionId) ||
		!retentionStates.has(value.retentionState)
	)
		throw new Error("invalid C04 artifact reference");
}
function publishExclusive(temp: string, path: string): void {
	// Destination is opened O_EXCL. If copy/fsync fails, remove precisely that
	// newly-created inode; an EEXIST winner is never opened or unlinked.
	const source = openSyncNoFollow(temp, "r");
	let destination: number | undefined;
	let created = false;
	try {
		destination = openSyncNoFollow(path, "wx", 0o600);
		created = true;
		const buffer = Buffer.allocUnsafe(MAX_STREAM_CHUNK_BYTES);
		for (;;) {
			const count = readSync(source, buffer, 0, buffer.length, null);
			if (count === 0) break;
			writeAll(destination, buffer.subarray(0, count));
		}
		fsyncSync(destination);
		fsyncDirectory(dirname(path));
	} catch (error) {
		if (destination !== undefined) closeSync(destination);
		destination = undefined;
		if (created) safeUnlink(path);
		throw error;
	} finally {
		closeSync(source);
		if (destination !== undefined) closeSync(destination);
	}
	safeUnlink(temp);
}

function atomicJson(path: string, value: unknown): void {
	const temp = `${path}.${randomUuid()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSyncNoFollow(temp, "wx", 0o600);
		writeAll(fd, Buffer.from(canonicalJson(value)));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
		fsyncDirectory(dirname(path));
	} catch (e) {
		if (fd !== undefined) closeSync(fd);
		safeUnlink(temp);
		throw e;
	}
}
function atomicExclusiveJson(path: string, value: unknown): void {
	let fd: number | undefined;
	let created = false;
	try {
		fd = openSyncNoFollow(path, "wx", 0o600);
		created = true;
		writeAll(fd, Buffer.from(canonicalJson(value)));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		fsyncDirectory(dirname(path));
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		if (created) safeUnlink(path);
		throw error;
	}
}

function appendAudit(root: string, action: AuditAction, reason: string, id: string): void {
	try {
		const path = join(root, "audit.jsonl");
		const fd = openSyncNoFollow(path, "a", 0o600);
		try {
			const rec = {
				version: 1,
				timestamp: new Date().toISOString(),
				action,
				reason: id ? reason : "unknown",
				idFingerprint: sha256(id).slice(0, 16),
			};
			writeAll(fd, Buffer.from(`${canonicalJson(rec)}\n`));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		/* Audit must not turn an already durable terminal fact into a raw exception path. */
	}
}
function denied<T>(root: string, reason: string): T | undefined {
	appendAudit(root, "read_denied", reason, reason);
	return undefined;
}
function hashOpenFile(fd: number, length: number): string {
	const h = createHash("sha256");
	const buffer = Buffer.allocUnsafe(MAX_STREAM_CHUNK_BYTES);
	let off = 0;
	while (off < length) {
		const n = readSync(fd, buffer, 0, Math.min(buffer.length, length - off), off);
		if (n <= 0) throw new Error("short object");
		h.update(buffer.subarray(0, n));
		off += n;
	}
	// A byte after declared length detects a trailing append without a second path/FD.
	if (readSync(fd, buffer, 0, 1, length) !== 0) throw new Error("trailing object bytes");
	return h.digest("hex");
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function openSyncNoFollow(path: string, flags: string, mode?: number): number {
	const numeric =
		flags === "r"
			? constants.O_RDONLY
			: flags === "r+"
				? constants.O_RDWR
				: flags === "a"
					? constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY
					: flags === "wx"
						? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
						: (() => {
								throw new Error("invalid C04 open mode");
							})();
	// O_NOFOLLOW closes the lstat/open race on platforms that support it.
	return openSync(path, numeric | (constants.O_NOFOLLOW ?? 0), mode);
}
function writeAll(fd: number, bytes: Uint8Array): void {
	let at = 0;
	while (at < bytes.length) {
		const n = writeSync(fd, bytes, at, bytes.length - at);
		if (n <= 0) throw new Error("short C04 write");
		at += n;
	}
}
function safeUnlink(path: string): void {
	try {
		const st = lstatSync(path);
		if (st.isFile() && !st.isSymbolicLink()) unlinkSync(path);
	} catch {}
}
function safeText(value: unknown, chars: number, bytes: number, label: string): string {
	if (typeof value !== "string") throw new Error(`invalid C04 ${label}`);
	const cleaned = value
		.normalize("NFC")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.replace(/(?:[A-Za-z]:\\|\/)[^\s]{2,}/g, "[redacted]")
		.replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
		.trim();
	if (!cleaned || [...cleaned].length > chars || Buffer.byteLength(cleaned) > bytes || hasUnpairedSurrogate(cleaned))
		throw new Error(`invalid C04 ${label}`);
	return cleaned;
}
function hasUnpairedSurrogate(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const n = value.charCodeAt(i);
		if (n >= 0xd800 && n <= 0xdbff) {
			if (++i >= value.length || value.charCodeAt(i) < 0xdc00 || value.charCodeAt(i) > 0xdfff) return true;
		} else if (n >= 0xdc00 && n <= 0xdfff) return true;
	}
	return false;
}
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const o = value as Record<string, unknown>;
	return `{${Object.keys(o)
		.sort()
		.filter((k) => o[k] !== undefined)
		.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
		.join(",")}}`;
}
function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function randomUuid(): string {
	return randomUUID();
}
function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_V4.test(value);
}
function isCanonicalUuid(value: unknown): value is string {
	return typeof value === "string" && CANONICAL_UUID.test(value);
}
function isObject(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const a = Object.keys(value).sort(),
		b = [...keys].sort();
	return a.length === b.length && a.every((x, i) => x === b[i]);
}
function optionalKeys(value: Record<string, unknown>, keys: string[]): string[] {
	return keys.filter((k) => value[k] !== undefined);
}
function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
	return !!value && typeof (value as any)[Symbol.asyncIterator] === "function";
}
function sameOwner(a: C04ChildResultOwner, b: C04ChildResultOwner): boolean {
	return (
		a.parentSessionId === b.parentSessionId &&
		a.childSessionId === b.childSessionId &&
		a.childSessionFile === b.childSessionFile &&
		a.assignmentId === b.assignmentId &&
		a.operationId === b.operationId &&
		a.deliveryId === b.deliveryId
	);
}
function digestableCandidateDigest(
	owner: C04ChildResultOwner,
	candidate: C04TerminalCandidate,
	artifacts: readonly C04OpaqueArtifactReference[],
): string {
	return sha256(canonicalJson({ owner, candidate: digestableCandidate(candidate, artifacts) }));
}
async function digestCandidateStreams(
	owner: C04ChildResultOwner,
	candidate: ReturnType<typeof validateCandidate>,
): Promise<string> {
	const descriptors: Array<{
		kind: C04ArtifactKind;
		contentType: C04ArtifactInput["contentType"];
		byteLength: number;
		sha256: string;
	}> = [];
	for (const artifact of [
		...(candidate.artifacts ?? []),
		...(candidate.error?.diagnostic ? [candidate.error.diagnostic] : []),
	]) {
		const hash = createHash("sha256");
		let count = 0;
		for await (const chunk of chunks(artifact.data)) {
			if (chunk.length > MAX_STREAM_CHUNK_BYTES) throw new Error("C04 stream chunk exceeds limit");
			count += chunk.length;
			if (count > MAX_ARTIFACT_BYTES) throw new Error("C04 artifact exceeds limit");
			hash.update(chunk);
		}
		descriptors.push({
			kind: artifact.kind,
			contentType: artifact.contentType,
			byteLength: count,
			sha256: hash.digest("hex"),
		});
	}
	const surrogate = descriptors.map((d) => ({
		version: 1 as const,
		handleId: randomUuid(),
		resultId: randomUuid(),
		...d,
		creatorAssignmentId: owner.assignmentId,
		ownerSessionId: owner.childSessionId,
		retentionState: "retained" as const,
	}));
	// digestableCandidate uses only kind/type/length/hash and no generated IDs.
	return digestableCandidateDigest(owner, candidate, surrogate);
}
function digestableCandidate(candidate: any, artifacts: readonly C04OpaqueArtifactReference[]): unknown {
	let cursor = 0;
	const artifactDigest = (a: C04ArtifactInput) => {
		const written = artifacts[cursor++];
		if (!written || written.kind !== a.kind || written.contentType !== a.contentType)
			throw new Error("C04 artifact digest mismatch");
		return { kind: a.kind, contentType: a.contentType, byteLength: written.byteLength, sha256: written.sha256 };
	};
	const output = {
		...candidate,
		artifacts: (candidate.artifacts ?? []).map(artifactDigest),
		error: candidate.error
			? {
					code: candidate.error.code,
					message: candidate.error.message,
					diagnostic: candidate.error.diagnostic ? artifactDigest(candidate.error.diagnostic) : undefined,
				}
			: undefined,
	};
	if (cursor !== artifacts.length) throw new Error("C04 artifact digest mismatch");
	return output;
}
