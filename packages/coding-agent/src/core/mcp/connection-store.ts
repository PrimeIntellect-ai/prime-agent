// Local connection records for MCP services. Separate from credentials (auth.json):
// a record captures the verified connection state for a connectionId — the stable
// alias the kernel dispatches through — plus the catalog serviceId it connects and
// the endpoint the verification ran against. Tokens never live here.
//
// Writes use the same file-lock + read-modify-write pattern as auth storage: the
// interactive client and the daemon both mutate this file, so every flush re-reads
// the latest on-disk state under a proper-lockfile lock and applies only this
// instance's pending operations. Verification results apply under a guard so a
// stale probe can never mark a newer grant (or a logged-out connection) verified.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { realpathIfPresentSync, writeFileAtomicSync } from "../../utils/atomic-file.js";

export type McpConnectionRecordStatus = "connected" | "pending" | "error";

export interface McpConnectionRecord {
	/** Auth.json key suffix (`mcp:<connectionId>`) and the kernel dispatch id. */
	connectionId: string;
	/** Catalog service id; deliberately distinct from connectionId (aliases remain possible). */
	serviceId: string;
	/** Endpoint the record's verification ran against. */
	endpoint: string;
	label: string;
	status: McpConnectionRecordStatus;
	createdAt: number;
	updatedAt: number;
	/** Epoch ms of the last successful handshake + tools/list. */
	verifiedAt?: number;
	toolCount?: number;
	/** Fixed, safe failure category (never URLs or server-controlled text). */
	lastError?: string;
	/** Opaque one-time ownership nonce for a pending reservation/login attempt. */
	attemptId?: string;
}

interface McpConnectionsFile {
	version: 1;
	connections: Record<string, McpConnectionRecord>;
}

type PendingOp =
	| { kind: "upsert"; record: McpConnectionRecord }
	| { kind: "remove"; connectionId: string }
	| {
			kind: "verify";
			record: McpConnectionRecord;
			/** Evaluated at flush time under the lock; a failed guard discards the result. */
			isStillCurrent: () => boolean;
	  }
	| {
			kind: "reserve";
			record: McpConnectionRecord;
			/** Cross-process atomic allocation: true when this store won the id. */
			resolve: (won: boolean) => void;
	  }
	| {
			kind: "removeReservation";
			connectionId: string;
			/** Opaque ownership nonce: only OUR pending reservation is removed. */
			attemptId: string;
			resolve: (removed: boolean) => void;
	  }
	| {
			kind: "finalizeAttempt";
			connectionId: string;
			/** Opaque ownership nonce: the credential commit lands only for ours. */
			attemptId: string;
			/**
			 * Runs under the file lock ONLY when ownership holds; returns the
			 * committed record. Caller-side effects (credential moves) belong here
			 * so they share the store's lock ordering with cancel/remove.
			 */
			commit: (record: McpConnectionRecord) => McpConnectionRecord;
			/**
			 * Runs under the SAME lock when the record write fails after commit
			 * ran, restoring caller-side effects (credential moves) so a failed
			 * finalize leaves the account exactly as before — all-or-nothing.
			 * Closures capture whatever they need to restore.
			 */
			compensate?: () => void;
			resolve: (result: McpFinalizeResult) => void;
	  }
	| {
			kind: "removeAccount";
			connectionId: string;
			/**
			 * Credential cleanup under the SAME file lock as the record removal —
			 * disconnects share the store->auth ordering with finalizeAttempt, so
			 * a concurrent finalize can never leave an orphan credential behind.
			 * Runs even when no record exists (credential-only logouts); returns
			 * whether a credential was actually removed.
			 */
			authCleanup: (connectionId: string) => boolean;
			resolve: (result: McpRemoveAccountResult) => void;
	  };

const MAX_LAST_ERROR_LENGTH = 500;

function sanitizeRecord(raw: unknown, connectionId: string): McpConnectionRecord | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Partial<McpConnectionRecord>;
	const string = (input: unknown): string | undefined => (typeof input === "string" ? input : undefined);
	const status = value.status;
	if (
		!string(value.connectionId) ||
		!string(value.serviceId) ||
		!string(value.endpoint) ||
		!string(value.label) ||
		(status !== "connected" && status !== "pending" && status !== "error")
	) {
		return undefined;
	}
	const record: McpConnectionRecord = {
		connectionId: string(value.connectionId) ?? connectionId,
		serviceId: string(value.serviceId) ?? "",
		endpoint: string(value.endpoint) ?? "",
		label: string(value.label) ?? string(value.connectionId) ?? connectionId,
		status,
		createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
	};
	if (typeof value.verifiedAt === "number") record.verifiedAt = value.verifiedAt;
	if (typeof value.toolCount === "number") record.toolCount = value.toolCount;
	const lastError = string(value.lastError);
	if (lastError) record.lastError = lastError.slice(0, MAX_LAST_ERROR_LENGTH);
	const attemptId = string(value.attemptId);
	if (attemptId) record.attemptId = attemptId.slice(0, 100);
	return record;
}

function parseRecords(raw: string | undefined): Map<string, McpConnectionRecord> {
	const records = new Map<string, McpConnectionRecord>();
	if (!raw) return records;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return records;
	}
	const file = parsed as Partial<McpConnectionsFile>;
	if (!file || file.version !== 1 || typeof file.connections !== "object" || file.connections === null) {
		return records;
	}
	for (const [connectionId, value] of Object.entries(file.connections)) {
		const record = sanitizeRecord(value, connectionId);
		if (record && record.connectionId === connectionId) {
			records.set(connectionId, record);
		}
	}
	return records;
}

function serializeRecords(records: ReadonlyMap<string, McpConnectionRecord>): string {
	const file: McpConnectionsFile = {
		version: 1,
		connections: Object.fromEntries([...records.entries()].sort(([left], [right]) => left.localeCompare(right))),
	};
	return `${JSON.stringify(file, null, "\t")}\n`;
}

/** File-backed store of MCP connection records; corrupt or missing files reset to empty. */

/** One-shot attempt operations: they carry a resolver and never requeue. */
type OneShotOperation = Extract<
	PendingOp,
	{ kind: "reserve" | "removeReservation" | "finalizeAttempt" | "removeAccount" }
>;

function isOneShotOperation(operation: PendingOp): operation is OneShotOperation {
	return (
		operation.kind === "reserve" ||
		operation.kind === "removeReservation" ||
		operation.kind === "finalizeAttempt" ||
		operation.kind === "removeAccount"
	);
}

export class McpConnectionStore {
	private recordsById = new Map<string, McpConnectionRecord>();
	private pendingOps: PendingOp[] = [];
	private flushChain: Promise<void> = Promise.resolve();

	private constructor(private readonly path: string) {}

	static open(path: string): McpConnectionStore {
		const store = new McpConnectionStore(path);
		store.load();
		return store;
	}

	/** Re-read the file. Tolerates a missing or corrupt file by resetting to empty. */
	load(): void {
		this.recordsById = parseRecords(
			existsSync(this.path) ? safeReadFileSync(realpathIfPresentSync(this.path)) : undefined,
		);
	}

	get(connectionId: string): McpConnectionRecord | undefined {
		return this.recordsById.get(connectionId);
	}

	records(): readonly McpConnectionRecord[] {
		return [...this.recordsById.values()];
	}

	/** Queue an unconditional upsert; applied in memory immediately and on disk at flush. */
	upsert(record: McpConnectionRecord): void {
		this.applyUpsert(this.recordsById, record);
		this.pendingOps.push({ kind: "upsert", record: { ...record } });
	}

	/** Queue an unconditional removal; applied in memory immediately and on disk at flush. */
	remove(connectionId: string): void {
		this.recordsById.delete(connectionId);
		this.pendingOps.push({ kind: "remove", connectionId });
	}

	/**
	 * Atomically reserve a NEW connection id across processes, under the store's
	 * file lock, as a durable pending record written before any login starts.
	 * The record must carry a fresh opaque attemptId nonce (the ownership token
	 * for cancel and finalize). Resolves true only after the record write
	 * COMMITS; false when the id already exists on disk or the write failed —
	 * no ghost reservation is queued. The pending marker makes the id visible
	 * to every other process's allocations and to reconnect flows.
	 */
	reserveConnectionId(record: McpConnectionRecord): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const settle = (won: boolean): void => {
				if (settled) return;
				settled = true;
				resolve(won);
			};
			this.pendingOps.push({ kind: "reserve", record: { ...record }, resolve: settle });
			void this.flush().catch(() => settle(false));
		});
	}

	/**
	 * Remove OUR pending reservation after a cancelled or failed login. Ownership
	 * is the opaque attempt nonce (same id, still pending, same attempt), so a
	 * late callback can never remove — or resurrect — another account's record.
	 */
	removeReservation(connectionId: string, attemptId: string): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const settle = (removed: boolean): void => {
				if (settled) return;
				settled = true;
				resolve(removed);
			};
			this.pendingOps.push({ kind: "removeReservation", connectionId, attemptId, resolve: settle });
			void this.flush().catch(() => settle(false));
		});
	}

	/**
	 * Remove an account ENTIRELY under the store's file lock: the record is
	 * deleted and `authCleanup` (credential logout) runs inside the SAME locked
	 * critical section, so disconnects share the store->auth lock ordering with
	 * finalizeAttempt — a concurrent finalize can never re-add an orphan
	 * credential after a disconnect removed the account.
	 *
	 * Outcomes: "removed" (record gone, write committed), "credential-only"
	 * (no record existed; a credential-only integration logged out),
	 * "logged-out" (the logout committed durably but the RECORD write failed —
	 * the partial state is reported honestly and the logout is never restored),
	 * "missing" (nothing existed), "failed" (nothing committed: the cleanup
	 * threw or never ran).
	 */
	removeAccount(options: {
		connectionId: string;
		/** Returns whether a credential was actually removed. */
		authCleanup: (connectionId: string) => boolean;
	}): Promise<McpRemoveAccountResult> {
		return new Promise<McpRemoveAccountResult>((resolve) => {
			let settled = false;
			const settle = (result: McpRemoveAccountResult): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			this.pendingOps.push({
				kind: "removeAccount",
				connectionId: options.connectionId,
				authCleanup: options.authCleanup,
				resolve: settle,
			});
			void this.flush().catch(() => settle("failed"));
		});
	}

	/**
	 * Guarded credential commit for a successful login attempt. `commit` runs
	 * under the store's file lock ONLY when the reservation is still ours
	 * (same id, still pending, same attempt nonce) — the caller moves staged
	 * credentials there, sharing this lock's ordering with cancel/remove.
	 * Resolves true only after the record write commits; false when ownership
	 * was lost or the write failed, in which case the staged credential stays
	 * under the attempt key for the caller to discard.
	 */
	finalizeAttempt(options: {
		connectionId: string;
		attemptId: string;
		commit: (record: McpConnectionRecord) => McpConnectionRecord;
		/** Rolls caller-side effects back under the lock when the write fails. */
		compensate?: () => void;
	}): Promise<McpFinalizeResult> {
		return new Promise<McpFinalizeResult>((resolve) => {
			let settled = false;
			const settle = (result: McpFinalizeResult): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			this.pendingOps.push({
				kind: "finalizeAttempt",
				connectionId: options.connectionId,
				attemptId: options.attemptId,
				commit: options.commit,
				...(options.compensate ? { compensate: options.compensate } : {}),
				resolve: settle,
			});
			void this.flush().catch(() => settle("denied"));
		});
	}

	/**
	 * Queue a verification result behind a guard. The guard is re-evaluated at flush
	 * time under the file lock, so a result computed against an old grant (or a
	 * connection that has since been disconnected) is discarded instead of
	 * resurrecting a stale record.
	 */
	queueVerifyResult(record: McpConnectionRecord, isStillCurrent: () => boolean): void {
		this.pendingOps.push({ kind: "verify", record: { ...record }, isStillCurrent });
	}

	/**
	 * Persist pending mutations. Serialized within this instance; the file lock
	 * orders us against other processes. Each flush re-reads the latest on-disk
	 * state and applies only this instance's pending operations, so concurrent
	 * writers cannot lose each other's records.
	 */
	flush(): Promise<void> {
		const run = async (): Promise<void> => {
			mkdirSync(dirname(this.path), { recursive: true });
			// Exclusive, non-truncating create. The previous exists-then-write-empty
			// could rename an empty file over records another process had just
			// written; "wx" only ever creates a brand-new inode, so a first writer
			// can never wipe anything. Content always comes from the locked
			// read-modify-write below, so the winner writes nothing here.
			try {
				closeSync(openSync(this.path, "wx", 0o600));
				chmodSync(this.path, 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			let lockCompromised = false;
			let lockCompromisedError: Error | undefined;
			// Splice THIS run's batch BEFORE acquiring the lock: a lock-acquisition
			// failure can then resolve one-shot attempt ops false and drop them —
			// no denied reservation or finalize can materialize on a later flush.
			// Ops queued while we wait for the lock stay in pendingOps and belong
			// to the NEXT flush; the requeue below keeps this batch ahead of them.
			const operations = this.pendingOps.splice(0);
			let release: Awaited<ReturnType<typeof lockfile.lock>>;
			try {
				release = await lockfile.lock(realpathIfPresentSync(this.path), {
					retries: {
						retries: 10,
						factor: 2,
						minTimeout: 100,
						maxTimeout: 10000,
						randomize: true,
					},
					stale: 30000,
					onCompromised: (error) => {
						lockCompromised = true;
						lockCompromisedError = error as Error;
					},
				});
			} catch (lockError) {
				// The lock never acquired: durable (idempotent) ops retry on the
				// next flush; one-shot attempt ops settle false and are dropped —
				// the caller already learned "no", so a later materialization
				// would be a ghost.
				this.pendingOps.unshift(...operations.filter((operation) => !isOneShotOperation(operation)));
				for (const operation of operations) {
					if (isOneShotOperation(operation)) {
						if (operation.kind === "finalizeAttempt") operation.resolve("denied");
						else if (operation.kind === "removeAccount") operation.resolve("failed");
						else operation.resolve(false);
					}
				}
				throw lockError;
			}
			let committed = false;
			try {
				if (lockCompromised) throw lockCompromisedError ?? new Error("MCP connection store lock was compromised");
				const records = parseRecords(safeReadFileSync(realpathIfPresentSync(this.path)));
				// One-shot attempt operations (reserve/remove/finalize/removeAccount)
				// resolve only AFTER the atomic write commits: a failed write means
				// no durable reservation/removal/finalize happened, so the caller
				// must NOT act on a ghost. Losing branches resolve false
				// immediately. Every one-shot op settles EXACTLY once — a throwing
				// callback, a failed write, or trailing ops in a failed batch can
				// never leave a promise hanging or a one-shot requeued.
				const deferred: Array<(committed: boolean) => void> = [];
				const oneShot = new Set<PendingOp>();
				const appliedFinalizes: Array<{
					operation: Extract<PendingOp, { kind: "finalizeAttempt" }>;
					rollback: () => void;
				}> = [];
				const committedFinalizes = new Set<PendingOp>();
				try {
					for (const operation of operations) {
						if (operation.kind === "remove") {
							records.delete(operation.connectionId);
						} else if (operation.kind === "upsert") {
							this.applyUpsert(records, operation.record);
						} else if (operation.kind === "reserve") {
							oneShot.add(operation);
							try {
								// Atomic under the file lock: exactly one cross-process
								// contender wins the id; the loser allocates another.
								if (records.has(operation.record.connectionId)) {
									operation.resolve(false);
								} else {
									this.applyUpsert(records, operation.record);
									deferred.push((didCommit) => operation.resolve(didCommit));
								}
							} catch {
								operation.resolve(false);
							}
						} else if (operation.kind === "removeReservation") {
							oneShot.add(operation);
							try {
								const existing = records.get(operation.connectionId);
								if (
									existing?.status === "pending" &&
									existing.attemptId !== undefined &&
									existing.attemptId === operation.attemptId
								) {
									records.delete(operation.connectionId);
									deferred.push((didCommit) => operation.resolve(didCommit));
								} else {
									// Not ours (completed, replaced, or gone): a late
									// callback never removes another account's record.
									operation.resolve(false);
								}
							} catch {
								operation.resolve(false);
							}
						} else if (operation.kind === "removeAccount") {
							oneShot.add(operation);
							try {
								// Cleanup runs under the lock even when no record
								// exists: credential-only integrations (legacy
								// grants, failed record saves) must still log out.
								const existed = records.delete(operation.connectionId);
								const credentialRemoved = operation.authCleanup(operation.connectionId);
								const outcome: McpRemoveAccountResult = existed
									? "removed"
									: credentialRemoved
										? "credential-only"
										: "missing";
								deferred.push((didCommit) =>
									didCommit
										? operation.resolve(outcome)
										: // The credential logout already committed durably: never claim
											// plain failure. "logged-out" reports the honest partial
											// state (credential gone, record save failed, retry to
											// finish); the logout is PRESERVED, never restored.
											operation.resolve(credentialRemoved ? "logged-out" : "failed"),
								);
							} catch {
								operation.resolve("failed");
							}
						} else if (operation.kind === "finalizeAttempt") {
							oneShot.add(operation);
							try {
								const existing = records.get(operation.connectionId);
								if (
									existing?.status === "pending" &&
									existing.attemptId !== undefined &&
									existing.attemptId === operation.attemptId
								) {
									// Recovery is registered BEFORE any side effect:
									// a throwing or partial commit callback still
									// gets its rollback attempt under this lock.
									const rollback = operation.compensate ?? (() => {});
									try {
										const committedRecord = operation.commit(existing);
										appliedFinalizes.push({ operation, rollback });
										this.applyUpsert(records, committedRecord);
										committedFinalizes.add(operation);
									} catch {
										// Partial commit: roll back immediately.
										try {
											rollback();
											operation.resolve("compensated");
										} catch {
											operation.resolve("recovery-required");
										}
									}
								} else {
									// Ownership lost (removed, replaced by another
									// attempt, or completed elsewhere): the credential
									// commit must NOT land on this account.
									operation.resolve("denied");
								}
							} catch {
								operation.resolve("recovery-required");
							}
						} else if (operation.isStillCurrent()) {
							this.applyUpsert(records, operation.record);
						}
					}
					writeFileAtomicSync(realpathIfPresentSync(this.path), serializeRecords(records), {
						mode: 0o600,
					});
					if (lockCompromised)
						throw lockCompromisedError ?? new Error("MCP connection store lock was compromised");
					this.recordsById = records;
					committed = true;
					for (const operation of committedFinalizes) {
						(operation as unknown as { resolve: (result: McpFinalizeResult) => void }).resolve("committed");
					}
					for (const settle of deferred) settle(true);
				} finally {
					if (!committed) {
						// The write failed (or the lock was compromised): durable
						// records put the batch back at the FRONT — idempotent ops
						// retry cleanly — but one-shot attempt ops resolve false and
						// are dropped: no ghost reservation, no surprise finalize.
						this.pendingOps.unshift(...operations.filter((operation) => !oneShot.has(operation)));
						// Finalizes whose commit callback ran get their rollback
						// under the SAME lock before release. A successful rollback
						// is honest all-or-nothing; a FAILING rollback surfaces
						// recovery-required instead of claiming the account is
						// unchanged.
						for (const applied of appliedFinalizes) {
							try {
								applied.rollback();
								applied.operation.resolve("compensated");
							} catch {
								applied.operation.resolve("recovery-required");
							}
						}
						for (const settle of deferred) settle(false);
					}
				}
			} finally {
				if (lockCompromised) await release().catch(() => undefined);
				else await release();
			}
		};
		this.flushChain = this.flushChain.then(run, run);
		return this.flushChain;
	}

	private applyUpsert(records: Map<string, McpConnectionRecord>, record: McpConnectionRecord): void {
		const now = Date.now();
		const previous = records.get(record.connectionId);
		const next: McpConnectionRecord = {
			...record,
			createdAt: previous?.createdAt ?? record.createdAt ?? now,
			updatedAt: now,
			lastError: record.lastError ? record.lastError.slice(0, MAX_LAST_ERROR_LENGTH) : undefined,
		};
		if (next.status !== "connected") {
			delete next.verifiedAt;
			delete next.toolCount;
		}
		records.set(record.connectionId, next);
	}
}

function safeReadFileSync(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export type { McpConnectionsFile, PendingOp };

/**
 * Outcome of an account-removal transaction. "removed": record + credential
 * both cleared under the lock. "credential-only": no record existed (legacy
 * grants, failed record saves) but the credential logout ran. "missing":
 * nothing to remove. "failed": the durable write failed — nothing committed.
 */
export type McpRemoveAccountResult = "removed" | "credential-only" | "logged-out" | "missing" | "failed";

/**
 * Outcome of a guarded finalize. "committed": record write landed. "denied":
 * ownership lost, no side effects. "compensated": the write failed and the
 * rollback restored every side effect — honest all-or-nothing. "recovery-
 * required": the commit callback or the rollback itself threw; partial state
 * may remain and the caller must surface recovery, not claim success.
 */
export type McpFinalizeResult = "committed" | "denied" | "compensated" | "recovery-required";
