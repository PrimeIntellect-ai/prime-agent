/**
 * Sandbox ownership record, state machine, and filesystem store (B12).
 *
 * Every mutating operation requires an explicit OwnershipClaim validated
 * under a per-directory proper-lockfile lock. The store uses write-to-temp
 * + fsync + close + rename for crash-safe atomicity, with files at 0600
 * and store directory at 0700.
 *
 * Sandbox IDs are SHA-256 hashed into filenames. All opaque IDs are
 * validated on write; on read every field in the full schema is re-validated.
 * Corrupt records throw `record_corrupt`. Free-form `note` is replaced
 * with fixed reason codes. No credentials, secrets, or raw host paths
 * appear in records or error messages.
 *
 * DELETED tombstones store a SHA-256 hash of the owner token, never the
 * raw token. Corrupt-record descriptors expose only opaque filenames and
 * fixed error codes, never raw paths or error text.
 *
 * ## Lifecycle key vs provider sandbox ID
 *
 * The ownership record uses a Home-generated opaque lifecycleKey (a UUID)
 * as its identity.  No raw provider sandbox ID, region, URL, or host path
 * is ever persisted in the record or tombstone.
 *
 * Physical provider deletion requires a live provider sandbox identity.
 * Same-process lifecycle retains the raw provider sandbox ID in its
 * private `identity` field for the required CLI argv operations.  After
 * restart the in-memory identity is lost and deletion is unavailable;
 * durable persistence stores only the lifecycleKey.
 *
 * When hosted orchestration is wired, a Home-private injected resolver
 * capability must translate a lifecycleKey to a provider sandbox ID for
 * restart- durable deletion.  Without that resolver, deletion of an
 * already-persisted sandbox record fails closed.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const RECORD_SUFFIX = ".sandbox-ownership.json";
const TOMBSTONE_SUFFIX = ".sandbox-tombstone.json";
const STALE_LEASE_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 5000;
const LOCK_UPDATE_MS = 1000;
const LOCK_RETRIES = 100;
const LOCK_RETRY_MS = 10;

// -------------------------------------------------------------------------
// Opaque ID validation
// -------------------------------------------------------------------------

const SESSION_ID_RE = /^[!-~]{1,128}$/;
const LIFECYCLE_KEY_RE = /^[0-9a-zA-Z._-]{1,64}$/;
const GENERATION_RE = /^[0-9a-zA-Z._-]{1,64}$/;
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHECKPOINT_RE = /^[a-zA-Z0-9._-]{1,256}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function validateId(value: unknown, label: string, re: RegExp): string {
	if (typeof value !== "string" || !re.test(value)) throw new Error(`sandbox-ownership: invalid ${label}`);
	return value;
}

function validateOptionalId(value: unknown, label: string, re: RegExp): string | null {
	if (value === null || value === undefined) return null;
	return validateId(value, label, re);
}

function validateIsoWithRoundtrip(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`sandbox-ownership: invalid ${label}`);
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`sandbox-ownership: invalid ${label}`);
	const rt = new Date(parsed).toISOString();
	if (rt !== value) throw new Error(`sandbox-ownership: ${label} date round-trip mismatch`);
	return value;
}

function validateBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`sandbox-ownership: ${label} must be boolean`);
	return value;
}

function validateWakeOutcome(value: unknown): SandboxWakeOutcome {
	if (typeof value !== "string") throw new Error("sandbox-ownership: invalid wakeOutcome");
	switch (value) {
		case "unknown":
		case "alive":
		case "terminated_by_platform":
		case "timeout":
			return value;
		default:
			throw new Error("sandbox-ownership: invalid wakeOutcome");
	}
}

function validatePositiveInt(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`sandbox-ownership: ${label} must be positive integer`);
	}
	return value;
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

// -------------------------------------------------------------------------
// Fixed reason codes
// -------------------------------------------------------------------------

export type SandboxTerminationReason =
	| "user_deleted"
	| "provisioning_abandoned"
	| "provisioning_failed"
	| "platform_deleted"
	| "wake_terminated"
	| "wake_timeout"
	| "orphan_cleanup"
	| "expired";

export type SandboxWakeOutcome = "unknown" | "alive" | "terminated_by_platform" | "timeout";

const TERMINATION_REASONS: ReadonlySet<string> = new Set<SandboxTerminationReason>([
	"user_deleted",
	"provisioning_abandoned",
	"provisioning_failed",
	"platform_deleted",
	"wake_terminated",
	"wake_timeout",
	"orphan_cleanup",
	"expired",
]);

function validateTerminationReason(value: unknown): SandboxTerminationReason {
	if (typeof value !== "string" || !TERMINATION_REASONS.has(value))
		throw new Error("sandbox-ownership: invalid termination reason");
	return value as SandboxTerminationReason;
}

function validateOptionalTerminationReason(value: unknown): SandboxTerminationReason | null {
	if (value === null || value === undefined) return null;
	return validateTerminationReason(value);
}

// -------------------------------------------------------------------------
// State machine
// -------------------------------------------------------------------------

export type SandboxOwnershipState =
	| "provisioning"
	| "active"
	| "passivated"
	| "rehydrating"
	| "terminating"
	| "terminated"
	| "deleted";

export type SandboxOwnershipEpoch = 0 | 1 | null;

const VALID_TRANSITIONS: Record<SandboxOwnershipState, SandboxOwnershipState[]> = {
	provisioning: ["active", "terminated"],
	active: ["passivated", "terminating"],
	passivated: ["rehydrating", "terminated"],
	rehydrating: ["active", "terminated"],
	terminating: ["terminated"],
	terminated: ["deleted"],
	deleted: [],
};

export function isValidTransition(from: SandboxOwnershipState, to: SandboxOwnershipState): boolean {
	return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function epochForState(state: SandboxOwnershipState): SandboxOwnershipEpoch {
	switch (state) {
		case "provisioning":
			return 0;
		case "active":
		case "rehydrating":
		case "terminating":
			return 1;
		case "passivated":
		case "terminated":
		case "deleted":
			return null;
	}
}

const VALID_STATES = new Set<SandboxOwnershipState>([
	"provisioning",
	"active",
	"passivated",
	"rehydrating",
	"terminating",
	"terminated",
	"deleted",
]);

function assertValidState(s: unknown): asserts s is SandboxOwnershipState {
	if (!VALID_STATES.has(s as SandboxOwnershipState)) throw new Error("sandbox-ownership: invalid state");
}

// -------------------------------------------------------------------------
// Ownership claim
// -------------------------------------------------------------------------

export interface OwnershipClaim {
	ownerGeneration: string;
	ownerToken: string;
	expectedState: SandboxOwnershipState;
	expectedEpoch: SandboxOwnershipEpoch;
}

export function createClaim(generation: string, token: string, state: SandboxOwnershipState): OwnershipClaim {
	assertValidState(state);
	return {
		ownerGeneration: validateId(generation, "generation", GENERATION_RE),
		ownerToken: validateId(token, "token", TOKEN_RE),
		expectedState: state,
		expectedEpoch: epochForState(state),
	};
}

// -------------------------------------------------------------------------
// Ownership record — full schema
// -------------------------------------------------------------------------

export interface SandboxOwnershipRecord {
	version: 1;
	/** Home-generated opaque lifecycle key — UUID. Never a raw provider sandbox ID. */
	lifecycleKey: string;
	sessionId: string;
	state: SandboxOwnershipState;
	epoch: SandboxOwnershipEpoch;
	ownerGeneration: string;
	/** SHA-256 hex hash of the ownership token — raw token never persisted. */
	ownerTokenHash: string;
	createdAt: string;
	updatedAt: string;
	lastHeartbeatAt: string;
	softReservationExpiresAt: string | null;
	checkpointId: string | null;
	platformDeleted: boolean;
	cleanupDeferred: boolean;
	wakeOutcome: SandboxWakeOutcome;
	terminationReason: SandboxTerminationReason | null;
}

// -------------------------------------------------------------------------
// Corrupt record descriptor — opaque only
// -------------------------------------------------------------------------

export interface CorruptRecordDescriptor {
	/** Opaque filename (hash + suffix), never a raw path. */
	filename: string;
	/** Fixed error code, never raw error message. */
	code: string;
}

// -------------------------------------------------------------------------
// DELETED tombstone — owner token stored as SHA-256 hash only
// -------------------------------------------------------------------------

export interface DeletedTombstone {
	version: 1;
	/** Home-generated opaque lifecycle key — UUID. Never a raw provider sandbox ID. */
	lifecycleKey: string;
	sessionId: string;
	terminationReason: SandboxTerminationReason;
	ownerGeneration: string;
	/** SHA-256 hex hash of the ownerToken at deletion time. */
	ownerTokenHash: string;
	deletedAt: string;
}

function validateTombstone(data: unknown): DeletedTombstone {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("sandbox-ownership: invalid tombstone");
	}
	const keys = new Set([
		"version",
		"lifecycleKey",
		"sessionId",
		"terminationReason",
		"ownerGeneration",
		"ownerTokenHash",
		"deletedAt",
	]);
	let descriptors: PropertyDescriptorMap;
	try {
		if (Object.getPrototypeOf(data) !== Object.prototype || Object.getOwnPropertySymbols(data).length !== 0) {
			throw new Error("sandbox-ownership: invalid tombstone");
		}
		const names = Object.getOwnPropertyNames(data);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) {
			throw new Error("sandbox-ownership: invalid tombstone");
		}
		descriptors = Object.getOwnPropertyDescriptors(data);
		for (const name of names) {
			const descriptor = descriptors[name];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new Error("sandbox-ownership: invalid tombstone");
			}
		}
	} catch {
		throw new Error("sandbox-ownership: invalid tombstone");
	}
	const version = descriptors.version.value;
	const lifecycleKey = descriptors.lifecycleKey.value;
	const sessionId = descriptors.sessionId.value;
	const terminationReason = descriptors.terminationReason.value;
	const ownerGeneration = descriptors.ownerGeneration.value;
	const ownerTokenHash = descriptors.ownerTokenHash.value;
	const deletedAt = descriptors.deletedAt.value;
	if (version !== 1) throw new Error("sandbox-ownership: invalid tombstone version");
	if (typeof lifecycleKey !== "string" || !LIFECYCLE_KEY_RE.test(lifecycleKey))
		throw new Error("sandbox-ownership: invalid tombstone lifecycleKey");
	if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId))
		throw new Error("sandbox-ownership: invalid tombstone sessionId");
	if (typeof ownerGeneration !== "string" || !GENERATION_RE.test(ownerGeneration))
		throw new Error("sandbox-ownership: invalid tombstone ownerGeneration");
	if (typeof ownerTokenHash !== "string" || !HASH_RE.test(ownerTokenHash))
		throw new Error("sandbox-ownership: invalid tombstone ownerTokenHash");
	if (typeof deletedAt !== "string" || !ISO_RE.test(deletedAt))
		throw new Error("sandbox-ownership: invalid tombstone deletedAt");
	let validatedReason: SandboxTerminationReason;
	switch (terminationReason) {
		case "user_deleted":
		case "idle_ttl":
		case "hard_ttl":
		case "daemon_shutdown":
		case "provisioning_failed":
		case "wake_timeout":
		case "platform_deleted":
			validatedReason = terminationReason;
			break;
		default:
			throw new Error("sandbox-ownership: invalid tombstone terminationReason");
	}
	return Object.freeze({
		version: 1,
		lifecycleKey,
		sessionId,
		terminationReason: validatedReason,
		ownerGeneration,
		ownerTokenHash,
		deletedAt,
	});
}

// -------------------------------------------------------------------------
// OwnershipError
// -------------------------------------------------------------------------

export class OwnershipError extends Error {
	readonly code: string;
	constructor(code: string, message?: string) {
		super(message ?? `sandbox-ownership: ${code}`);
		this.name = "OwnershipError";
		this.code = code;
	}
}

// -------------------------------------------------------------------------
// Store
// -------------------------------------------------------------------------

export interface SandboxOwnershipStoreOptions {
	baseDir?: string;
	now?: () => string;
}

export class SandboxOwnershipStore {
	private readonly baseDir: string;
	private readonly now: () => string;

	constructor(options: SandboxOwnershipStoreOptions = {}) {
		this.baseDir = resolve(options.baseDir ?? process.cwd());
		this.now = options.now ?? (() => new Date().toISOString());
		mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
	}

	private lockDir(): string {
		return resolve(this.baseDir, ".ownership-lock");
	}

	private async withLock<T>(action: () => T | Promise<T>): Promise<T> {
		mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
		const release = await lockfile.lock(this.baseDir, {
			realpath: false,
			lockfilePath: this.lockDir(),
			stale: LOCK_STALE_MS,
			update: LOCK_UPDATE_MS,
			retries: { retries: LOCK_RETRIES, factor: 1, minTimeout: LOCK_RETRY_MS, maxTimeout: LOCK_RETRY_MS },
		});
		try {
			return await action();
		} finally {
			await release();
		}
	}

	private filename(lifecycleKey: string): string {
		return `${createHash("sha256").update(lifecycleKey).digest("hex")}${RECORD_SUFFIX}`;
	}
	private tombstoneFilename(lifecycleKey: string): string {
		return `${createHash("sha256").update(lifecycleKey).digest("hex")}${TOMBSTONE_SUFFIX}`;
	}
	private recordPath(lifecycleKey: string): string {
		return join(this.baseDir, this.filename(lifecycleKey));
	}
	private tombstonePath(lifecycleKey: string): string {
		return join(this.baseDir, this.tombstoneFilename(lifecycleKey));
	}

	private listRecordFiles(): string[] {
		try {
			return readdirSync(this.baseDir)
				.filter((f) => f.endsWith(RECORD_SUFFIX))
				.map((f) => join(this.baseDir, f));
		} catch {
			return [];
		}
	}
	private listTombstoneFiles(): string[] {
		try {
			return readdirSync(this.baseDir)
				.filter((f) => f.endsWith(TOMBSTONE_SUFFIX))
				.map((f) => join(this.baseDir, f));
		} catch {
			return [];
		}
	}

	// ------------------------------------------------------------------
	// CRUD
	// ------------------------------------------------------------------

	async create(claim: OwnershipClaim, lifecycleKey: string, sessionId: string): Promise<SandboxOwnershipRecord> {
		validateId(lifecycleKey, "lifecycleKey", LIFECYCLE_KEY_RE);
		validateId(sessionId, "sessionId", SESSION_ID_RE);
		if (claim.expectedState !== "provisioning") throw new OwnershipError("create_requires_provisioning");
		if (claim.expectedEpoch !== 0) throw new OwnershipError("create_requires_epoch_0");
		const path = this.recordPath(lifecycleKey);
		const now = this.now();
		const record: SandboxOwnershipRecord = {
			version: 1,
			lifecycleKey,
			sessionId,
			state: "provisioning",
			epoch: 0,
			ownerGeneration: claim.ownerGeneration,
			ownerTokenHash: hashToken(claim.ownerToken),
			createdAt: now,
			updatedAt: now,
			lastHeartbeatAt: now,
			softReservationExpiresAt: null,
			checkpointId: null,
			platformDeleted: false,
			cleanupDeferred: false,
			wakeOutcome: "unknown",
			terminationReason: null,
		};
		this.validateRecordFields(record);
		await this.withLock(() => {
			if (existsSync(path)) throw new OwnershipError("duplicate", "sandbox-ownership: record already exists");
			this.writeAtomic(path, record);
		});
		return record;
	}

	async read(lifecycleKey: string): Promise<SandboxOwnershipRecord | undefined> {
		try {
			return parseAndValidateFull(readFileSync(this.recordPath(lifecycleKey), "utf8"));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			if ((err as Error).message.startsWith("sandbox-ownership: record_corrupt")) throw err;
			throw new OwnershipError("record_corrupt", (err as Error).message);
		}
	}

	private readSync(lifecycleKey: string): SandboxOwnershipRecord | undefined {
		try {
			return parseAndValidateFull(readFileSync(this.recordPath(lifecycleKey), "utf8"));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			if ((err as Error).message.startsWith("sandbox-ownership: record_corrupt")) throw err;
			throw new OwnershipError("record_corrupt", (err as Error).message);
		}
	}

	private assertClaimMatches(claim: OwnershipClaim, record: SandboxOwnershipRecord): void {
		if (record.ownerGeneration !== claim.ownerGeneration) throw new OwnershipError("claim_generation_mismatch");
		if (record.ownerTokenHash !== hashToken(claim.ownerToken)) throw new OwnershipError("claim_token_mismatch");
		if (record.state !== claim.expectedState) throw new OwnershipError("claim_state_mismatch");
		if (record.epoch !== claim.expectedEpoch) throw new OwnershipError("claim_epoch_mismatch");
	}

	async update(
		claim: OwnershipClaim,
		lifecycleKey: string,
		mutator: (r: SandboxOwnershipRecord) => SandboxOwnershipRecord,
	): Promise<SandboxOwnershipRecord> {
		let updated: SandboxOwnershipRecord;
		await this.withLock(() => {
			const record = this.readSync(lifecycleKey);
			if (!record) throw new OwnershipError("record_not_found");
			this.assertClaimMatches(claim, record);
			updated = mutator({ ...record });
			updated.updatedAt = this.now();
			updated.lifecycleKey = record.lifecycleKey;
			updated.sessionId = record.sessionId;
			updated.ownerGeneration = record.ownerGeneration;
			updated.ownerTokenHash = record.ownerTokenHash;
			updated.createdAt = record.createdAt;
			if (updated.state !== record.state) {
				if (!isValidTransition(record.state, updated.state)) {
					throw new OwnershipError(
						"invalid_transition",
						`sandbox-ownership: invalid transition ${record.state} -> ${updated.state}`,
					);
				}
				updated.epoch = epochForState(updated.state);
			}
			this.validateRecordFields(updated);
			this.writeAtomic(this.recordPath(lifecycleKey), updated);
		});
		return updated!;
	}

	// ------------------------------------------------------------------
	// Deletion — durable DELETED tombstone + fenced purge + fsync removals
	// ------------------------------------------------------------------

	async markDeleted(claim: OwnershipClaim, lifecycleKey: string): Promise<void> {
		await this.withLock(() => {
			const record = this.readSync(lifecycleKey);
			if (!record) return;
			this.assertClaimMatches(claim, record);
			if (record.state !== "terminated") throw new OwnershipError("markDeleted_requires_terminated");
			const tombstone: DeletedTombstone = {
				version: 1,
				lifecycleKey: record.lifecycleKey,
				sessionId: record.sessionId,
				terminationReason: record.terminationReason ?? "user_deleted",
				ownerGeneration: record.ownerGeneration,
				ownerTokenHash: record.ownerTokenHash,
				deletedAt: this.now(),
			};
			this.writeAtomic(this.tombstonePath(lifecycleKey), tombstone);
			try {
				rmSync(this.recordPath(lifecycleKey), { force: true });
			} catch {
				/* best-effort */
			}
			const parentFd = openSync(resolve(this.recordPath(lifecycleKey), ".."), "r");
			try {
				fsyncSync(parentFd);
			} finally {
				closeSync(parentFd);
			}
		});
	}

	async purge(claim: OwnershipClaim, lifecycleKey: string): Promise<void> {
		await this.withLock(() => {
			const tPath = this.tombstonePath(lifecycleKey);
			if (!existsSync(tPath)) return;
			const raw = readFileSync(tPath, "utf8");
			const tombstone = validateTombstone(JSON.parse(raw));
			if (tombstone.ownerGeneration !== claim.ownerGeneration) throw new OwnershipError("claim_generation_mismatch");
			const tokenHash = createHash("sha256").update(claim.ownerToken).digest("hex");
			if (tombstone.ownerTokenHash !== tokenHash) throw new OwnershipError("claim_token_mismatch");
			try {
				rmSync(tPath, { force: true });
			} catch {
				/* best-effort */
			}
			const parentFd = openSync(resolve(tPath, ".."), "r");
			try {
				fsyncSync(parentFd);
			} finally {
				closeSync(parentFd);
			}
		});
	}

	async deleteRecord(claim: OwnershipClaim, lifecycleKey: string): Promise<void> {
		await this.withLock(() => {
			const record = this.readSync(lifecycleKey);
			if (!record) {
				const tPath = this.tombstonePath(lifecycleKey);
				if (existsSync(tPath)) {
					const raw = readFileSync(tPath, "utf8");
					const tombstone = validateTombstone(JSON.parse(raw));
					if (tombstone.ownerGeneration !== claim.ownerGeneration)
						throw new OwnershipError("claim_generation_mismatch");
					const tokenHash = createHash("sha256").update(claim.ownerToken).digest("hex");
					if (tombstone.ownerTokenHash !== tokenHash) throw new OwnershipError("claim_token_mismatch");
					try {
						rmSync(tPath, { force: true });
					} catch {
						/* best-effort */
					}
					const parentFd = openSync(resolve(tPath, ".."), "r");
					try {
						fsyncSync(parentFd);
					} finally {
						closeSync(parentFd);
					}
				}
				return;
			}
			this.assertClaimMatches(claim, record);
			try {
				rmSync(this.recordPath(lifecycleKey), { force: true });
			} catch {
				/* idempotent */
			}
			const parentFd = openSync(resolve(this.recordPath(lifecycleKey), ".."), "r");
			try {
				fsyncSync(parentFd);
			} finally {
				closeSync(parentFd);
			}
		});
	}

	async list(): Promise<{ records: SandboxOwnershipRecord[]; corrupt: CorruptRecordDescriptor[] }> {
		const files = this.listRecordFiles();
		const records: SandboxOwnershipRecord[] = [];
		const corrupt: CorruptRecordDescriptor[] = [];
		for (const f of files) {
			try {
				const parsed = parseAndValidateFull(readFileSync(f, "utf8"));
				if (parsed) records.push(parsed);
			} catch {
				corrupt.push({ filename: basename(f), code: "record_corrupt" });
			}
		}
		records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return { records, corrupt };
	}

	async listTombstones(): Promise<DeletedTombstone[]> {
		const tombstones: DeletedTombstone[] = [];
		for (const f of this.listTombstoneFiles()) {
			try {
				tombstones.push(validateTombstone(JSON.parse(readFileSync(f, "utf8"))));
			} catch {
				/* skip */
			}
		}
		return tombstones;
	}

	// ------------------------------------------------------------------
	// State helpers
	// ------------------------------------------------------------------

	async markActive(claim: OwnershipClaim, lifecycleKey: string): Promise<SandboxOwnershipRecord> {
		return this.update(claim, lifecycleKey, (r) => ({
			...r,
			state: "active",
			lastHeartbeatAt: this.now(),
			wakeOutcome: r.state === "rehydrating" ? "alive" : r.wakeOutcome,
		}));
	}

	async markPassivated(
		claim: OwnershipClaim,
		lifecycleKey: string,
		softReservationTtlMs?: number,
	): Promise<SandboxOwnershipRecord> {
		let softReservationExpiresAt: string | null = null;
		if (softReservationTtlMs !== undefined) {
			validatePositiveInt(softReservationTtlMs, "softReservationTtlMs");
			softReservationExpiresAt = new Date(Date.parse(this.now()) + softReservationTtlMs).toISOString();
		}
		return this.update(claim, lifecycleKey, (r) => ({
			...r,
			state: "passivated",
			softReservationExpiresAt,
			terminationReason: null,
		}));
	}

	async markRehydrating(claim: OwnershipClaim, lifecycleKey: string): Promise<SandboxOwnershipRecord> {
		return this.update(claim, lifecycleKey, (r) => ({ ...r, state: "rehydrating" }));
	}
	async markTerminating(claim: OwnershipClaim, lifecycleKey: string): Promise<SandboxOwnershipRecord> {
		return this.update(claim, lifecycleKey, (r) => ({ ...r, state: "terminating" }));
	}
	async markTerminated(
		claim: OwnershipClaim,
		lifecycleKey: string,
		reason: SandboxTerminationReason,
	): Promise<SandboxOwnershipRecord> {
		return this.update(claim, lifecycleKey, (r) => ({ ...r, state: "terminated", terminationReason: reason }));
	}
	async setCheckpoint(
		claim: OwnershipClaim,
		lifecycleKey: string,
		checkpointId: string,
	): Promise<SandboxOwnershipRecord> {
		validateOptionalId(checkpointId, "checkpointId", CHECKPOINT_RE);
		return this.update(claim, lifecycleKey, (r) => ({ ...r, checkpointId }));
	}
	async heartbeat(claim: OwnershipClaim, lifecycleKey: string): Promise<SandboxOwnershipRecord> {
		return this.update(claim, lifecycleKey, (r) => ({ ...r, lastHeartbeatAt: this.now() }));
	}

	async markPlatformDeleted(claim: OwnershipClaim, lifecycleKey: string): Promise<SandboxOwnershipRecord> {
		await this.update(claim, lifecycleKey, (r) => ({ ...r, state: "terminating" }));
		const record = await this.read(lifecycleKey);
		if (!record) throw new OwnershipError("record_vanished");
		return this.update({ ...claim, expectedState: "terminating", expectedEpoch: 1 }, lifecycleKey, (r) => ({
			...r,
			state: "terminated",
			platformDeleted: true,
			terminationReason: "platform_deleted",
		}));
	}

	async tryWake(claim: OwnershipClaim, lifecycleKey: string): Promise<SandboxOwnershipRecord | undefined> {
		const record = await this.read(lifecycleKey);
		if (!record || record.state !== "passivated") return undefined;
		return this.markRehydrating(createClaim(claim.ownerGeneration, claim.ownerToken, record.state), lifecycleKey);
	}

	async resolveWake(
		claim: OwnershipClaim,
		lifecycleKey: string,
		outcome: SandboxWakeOutcome,
		checkpointId?: string,
	): Promise<SandboxOwnershipRecord | undefined> {
		const record = await this.read(lifecycleKey);
		if (!record) return undefined;
		const cc = createClaim(claim.ownerGeneration, claim.ownerToken, record.state);
		if (outcome === "alive") {
			const updated = await this.markActive(cc, lifecycleKey);
			if (checkpointId)
				return this.setCheckpoint(
					createClaim(claim.ownerGeneration, claim.ownerToken, "active"),
					lifecycleKey,
					checkpointId,
				);
			return updated;
		}
		return this.markTerminated(
			cc,
			lifecycleKey,
			outcome === "terminated_by_platform" ? "platform_deleted" : "wake_timeout",
		);
	}

	// ------------------------------------------------------------------
	// Fenced stale-claim reclaim
	// ------------------------------------------------------------------

	async reclaimStale(
		claim: OwnershipClaim,
		lifecycleKey: string,
		staleState: "provisioning" | "active",
		staleLeaseMs: number = STALE_LEASE_MS,
	): Promise<SandboxOwnershipRecord> {
		validateId(claim.ownerGeneration, "generation", GENERATION_RE);
		validateId(claim.ownerToken, "token", TOKEN_RE);
		assertValidState(claim.expectedState);
		if (claim.expectedEpoch !== epochForState(claim.expectedState)) throw new OwnershipError("claim_epoch_mismatch");
		return this.withLock(() => {
			const record = this.readSync(lifecycleKey);
			if (!record) throw new OwnershipError("record_not_found", "sandbox-ownership: record not found for reclaim");
			const now = Date.parse(this.now());
			if (staleState === "provisioning") {
				if (record.state !== "provisioning") throw new OwnershipError("reclaim_state_mismatch");
				if (now - Date.parse(record.createdAt) < staleLeaseMs) throw new OwnershipError("reclaim_too_early");
			} else if (staleState === "active") {
				if (record.state !== "active" && record.state !== "rehydrating")
					throw new OwnershipError("reclaim_state_mismatch");
				if (now - Date.parse(record.lastHeartbeatAt) < staleLeaseMs) throw new OwnershipError("reclaim_too_early");
			}
			const updated: SandboxOwnershipRecord = {
				...record,
				ownerGeneration: claim.ownerGeneration,
				ownerTokenHash: hashToken(claim.ownerToken),
				updatedAt: this.now(),
				terminationReason: null,
			};
			this.writeAtomic(this.recordPath(lifecycleKey), updated);
			return updated;
		});
	}

	async transferOwnership(
		claim: OwnershipClaim,
		lifecycleKey: string,
		newGeneration: string,
		newToken: string,
	): Promise<SandboxOwnershipRecord> {
		validateId(newGeneration, "new generation", GENERATION_RE);
		validateId(newToken, "new token", TOKEN_RE);
		return this.withLock(() => {
			const record = this.readSync(lifecycleKey);
			if (!record) throw new OwnershipError("record_not_found", "sandbox-ownership: record not found for transfer");
			this.assertClaimMatches(claim, record);
			const updated: SandboxOwnershipRecord = {
				...record,
				ownerGeneration: newGeneration,
				ownerTokenHash: hashToken(newToken),
				updatedAt: this.now(),
			};
			this.writeAtomic(this.recordPath(lifecycleKey), updated);
			return updated;
		});
	}

	// ------------------------------------------------------------------
	// Orphan enumeration
	// ------------------------------------------------------------------

	async enumerateOrphans(staleLeaseMs: number = STALE_LEASE_MS): Promise<{
		staleProvisioning: SandboxOwnershipRecord[];
		activeWithoutHeartbeat: SandboxOwnershipRecord[];
		terminatedNotDeleted: SandboxOwnershipRecord[];
		passivatedExpired: SandboxOwnershipRecord[];
		corruptRecords: CorruptRecordDescriptor[];
	}> {
		const now = Date.parse(this.now());
		const { records, corrupt } = await this.list();
		const result = {
			staleProvisioning: [] as SandboxOwnershipRecord[],
			activeWithoutHeartbeat: [] as SandboxOwnershipRecord[],
			terminatedNotDeleted: [] as SandboxOwnershipRecord[],
			passivatedExpired: [] as SandboxOwnershipRecord[],
			corruptRecords: corrupt,
		};
		for (const record of records) {
			const heartbeatAge = now - Date.parse(record.lastHeartbeatAt);
			switch (record.state) {
				case "provisioning":
					if (now - Date.parse(record.createdAt) >= staleLeaseMs) result.staleProvisioning.push(record);
					break;
				case "active":
				case "rehydrating":
					if (heartbeatAge >= staleLeaseMs) result.activeWithoutHeartbeat.push(record);
					break;
				case "terminated":
					result.terminatedNotDeleted.push(record);
					break;
				case "passivated":
					if (record.softReservationExpiresAt && now >= Date.parse(record.softReservationExpiresAt))
						result.passivatedExpired.push(record);
					break;
			}
		}
		return result;
	}

	// ------------------------------------------------------------------
	// Atomic write with fsync + close
	// ------------------------------------------------------------------

	private writeAtomic(path: string, record: object): void {
		const tmpPath = `${path}.${randomUUID()}.tmp`;
		const serialized = `${JSON.stringify(record, null, 2)}\n`;
		let fd: number | undefined;
		try {
			fd = openSync(tmpPath, "wx", 0o600);
			writeFileSync(fd, serialized);
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			renameSync(tmpPath, path);
			const parentFd = openSync(resolve(path, ".."), "r");
			try {
				fsyncSync(parentFd);
			} finally {
				closeSync(parentFd);
			}
		} catch (err) {
			if (fd !== undefined)
				try {
					closeSync(fd);
				} catch {}
			try {
				rmSync(tmpPath, { force: true });
			} catch {}
			throw err;
		}
	}

	private validateRecordFields(record: SandboxOwnershipRecord): void {
		validateId(record.lifecycleKey, "lifecycleKey", LIFECYCLE_KEY_RE);
		validateId(record.sessionId, "sessionId", SESSION_ID_RE);
		validateId(record.ownerGeneration, "ownerGeneration", GENERATION_RE);
		validateId(record.ownerTokenHash, "ownerTokenHash", HASH_RE);
		validateIsoWithRoundtrip(record.createdAt, "createdAt");
		validateIsoWithRoundtrip(record.updatedAt, "updatedAt");
		validateIsoWithRoundtrip(record.lastHeartbeatAt, "lastHeartbeatAt");
		validateOptionalId(record.checkpointId, "checkpointId", CHECKPOINT_RE);
		validateBoolean(record.platformDeleted, "platformDeleted");
		validateBoolean(record.cleanupDeferred, "cleanupDeferred");
		validateWakeOutcome(record.wakeOutcome);
		validateOptionalTerminationReason(record.terminationReason);
		assertValidState(record.state);
		if (record.epoch !== epochForState(record.state)) throw new OwnershipError("epoch_state_mismatch");
		if (record.version !== 1) throw new OwnershipError("invalid_version");
	}
}

// -------------------------------------------------------------------------
// Full-schema parse+validate — throws `record_corrupt` on ANY violation
// -------------------------------------------------------------------------

export function parseAndValidateFull(raw: string): SandboxOwnershipRecord {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		throw new Error("sandbox-ownership: record_corrupt malformed JSON");
	}

	const KEYS = new Set([
		"version",
		"lifecycleKey",
		"sessionId",
		"state",
		"epoch",
		"ownerGeneration",
		"ownerTokenHash",
		"createdAt",
		"updatedAt",
		"lastHeartbeatAt",
		"softReservationExpiresAt",
		"checkpointId",
		"platformDeleted",
		"cleanupDeferred",
		"wakeOutcome",
		"terminationReason",
	]);
	for (const k of Object.keys(data)) {
		if (!KEYS.has(k)) throw new Error(`sandbox-ownership: record_corrupt unknown key ${k}`);
	}
	for (const k of KEYS) {
		if (!(k in data)) throw new Error(`sandbox-ownership: record_corrupt missing key ${k}`);
	}

	if (data.version !== 1) throw new Error("sandbox-ownership: record_corrupt version");
	if (typeof data.lifecycleKey !== "string" || !LIFECYCLE_KEY_RE.test(data.lifecycleKey))
		throw new Error("sandbox-ownership: record_corrupt lifecycleKey");
	if (typeof data.sessionId !== "string" || !SESSION_ID_RE.test(data.sessionId))
		throw new Error("sandbox-ownership: record_corrupt sessionId");
	assertValidState(data.state);
	if (typeof data.ownerGeneration !== "string" || !GENERATION_RE.test(data.ownerGeneration))
		throw new Error("sandbox-ownership: record_corrupt ownerGeneration");
	if (typeof data.ownerTokenHash !== "string" || !HASH_RE.test(data.ownerTokenHash))
		throw new Error("sandbox-ownership: record_corrupt ownerTokenHash");
	validateIsoWithRoundtrip(data.createdAt, "createdAt");
	validateIsoWithRoundtrip(data.updatedAt, "updatedAt");
	validateIsoWithRoundtrip(data.lastHeartbeatAt, "lastHeartbeatAt");
	if (data.softReservationExpiresAt !== null) {
		if (typeof data.softReservationExpiresAt !== "string")
			throw new Error("sandbox-ownership: record_corrupt softReservationExpiresAt type");
		validateIsoWithRoundtrip(data.softReservationExpiresAt, "softReservationExpiresAt");
	}
	if (data.checkpointId !== null) {
		if (typeof data.checkpointId !== "string") throw new Error("sandbox-ownership: record_corrupt checkpointId type");
		if (!CHECKPOINT_RE.test(data.checkpointId))
			throw new Error("sandbox-ownership: record_corrupt checkpointId format");
	}
	if (typeof data.platformDeleted !== "boolean") throw new Error("sandbox-ownership: record_corrupt platformDeleted");
	if (typeof data.cleanupDeferred !== "boolean") throw new Error("sandbox-ownership: record_corrupt cleanupDeferred");
	if (typeof data.wakeOutcome !== "string") throw new Error("sandbox-ownership: record_corrupt wakeOutcome");
	switch (data.wakeOutcome) {
		case "unknown":
		case "alive":
		case "terminated_by_platform":
		case "timeout":
			break;
		default:
			throw new Error("sandbox-ownership: record_corrupt wakeOutcome");
	}
	if (data.terminationReason !== null) {
		if (typeof data.terminationReason !== "string" || !TERMINATION_REASONS.has(data.terminationReason)) {
			throw new Error("sandbox-ownership: record_corrupt terminationReason");
		}
	}
	const state = data.state as SandboxOwnershipState;
	if (data.epoch !== epochForState(state)) throw new Error("sandbox-ownership: record_corrupt epoch/state mismatch");
	return data as unknown as SandboxOwnershipRecord;
}
