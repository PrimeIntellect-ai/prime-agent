/**
 * Sandbox lifecycle — high-level adapter wrapping a SandboxProvider (B06/B12).
 *
 * Uses fixed per-step codes, default classifier returns `internal` with
 * DELETE_FAIL (never inspects err.message), and LifecycleError for throw-type
 * discrimination. Observer callbacks are isolated.
 *
 * Ownership integration:
 * - create(): cleanup timer created only immediately before compensation
 *   delete, never before provider.create.
 * - waitForReady(): cleanup timer created only in catch, kept alive through
 *   provider.delete, cleared in finally. On cleanup failure, leaves
 *   PROVISIONING record for stale reaper — never claims terminated.
 * - delete(): ownership read/transition errors fail closed as
 *   RECOVERY_REQUIRED before provider.delete, retain identity and record.
 *   Only classifier not_found from provider delete is DELETE_GONE.
 */

import { createHash, randomUUID } from "node:crypto";
import { type DeletionFacade, lifecycleKeyDto } from "./sandbox-lifecycle-resolver.js";
import type {
	OwnershipClaim,
	SandboxOwnershipRecord,
	SandboxOwnershipState,
	SandboxOwnershipStore,
} from "./sandbox-ownership.js";
import { createClaim, OwnershipError } from "./sandbox-ownership.js";
import type { BackgroundJobStatus, SandboxProvider } from "./sandbox-provider.js";
import type { SandboxApiStatus, SandboxCreateOptions, SandboxIdentity } from "./sandbox-types.js";

export const SANDBOX_READY_STATUSES: SandboxApiStatus[] = ["RUNNING"];

export const LIFECYCLE_STEPS = [
	"preflight",
	"create",
	"wait-ready",
	"upload",
	"download",
	"run-command",
	"logs",
	"delete",
	"start-background-job",
	"background-job-status",
	"background-job-logs",
	"kill-background-job",
] as const;

export type LifecycleStep = (typeof LIFECYCLE_STEPS)[number];

export interface LifecycleEvent {
	step: LifecycleStep;
	status: "start" | "success" | "error";
	code: string;
	durationMs?: number;
}

export type LifecycleObserver = (event: LifecycleEvent) => void;

// -------------------------------------------------------------------------
// LifecycleError
// -------------------------------------------------------------------------

export class LifecycleError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "LifecycleError";
		this.code = code;
	}
}

// -------------------------------------------------------------------------
// Fixed codes
// -------------------------------------------------------------------------

export const LIFECYCLE_CODES = {
	PREFLIGHT_OK: "preflight_ok",
	PREFLIGHT_FAIL: "preflight_fail",
	CREATE_OK: "create_ok",
	CREATE_FAIL: "create_fail",
	CREATE_SESSION_REQUIRED: "create_session_required",
	WAIT_OK: "wait_ok",
	WAIT_TIMEOUT: "wait_timeout",
	WAIT_FAIL: "wait_fail",
	UPLOAD_OK: "upload_ok",
	UPLOAD_FAIL: "upload_fail",
	DOWNLOAD_OK: "download_ok",
	DOWNLOAD_FAIL: "download_fail",
	RUN_OK: "run_ok",
	RUN_FAIL: "run_fail",
	LOGS_OK: "logs_ok",
	LOGS_FAIL: "logs_fail",
	DELETE_OK: "delete_ok",
	DELETE_GONE: "delete_gone",
	DELETE_FAIL: "delete_fail",
	BG_START_OK: "bg_start_ok",
	BG_START_FAIL: "bg_start_fail",
	BG_STATUS_OK: "bg_status_ok",
	BG_STATUS_FAIL: "bg_status_fail",
	BG_LOGS_OK: "bg_logs_ok",
	BG_LOGS_FAIL: "bg_logs_fail",
	BG_KILL_OK: "bg_kill_ok",
	BG_KILL_FAIL: "bg_kill_fail",
	RECOVERY_REQUIRED: "recovery_required",
} as const;

// -------------------------------------------------------------------------
// Provider error classifier — default is pure internal, never err.message
// -------------------------------------------------------------------------

export type ProviderErrorKind = "not_found" | "timeout" | "auth" | "internal" | "unknown";

export interface ClassifiedError {
	kind: ProviderErrorKind;
	code: string;
}

export type ProviderErrorClassifier = (err: unknown, step: string) => ClassifiedError;

const defaultClassifier: ProviderErrorClassifier = (_err, _step) => ({
	kind: "internal",
	code: LIFECYCLE_CODES.DELETE_FAIL,
});

// -------------------------------------------------------------------------
// Resolved options
// -------------------------------------------------------------------------

export interface ResolvedLifecycleOptions {
	onEvent: LifecycleObserver;
	signal: AbortSignal;
	provisionTimeoutMs: number;
	commandTimeoutMs: number;
	pollMs: number;
	ownershipStore: SandboxOwnershipStore | undefined;
	ownerGeneration: string;
	ownerToken: string;
	classifyError: ProviderErrorClassifier;
	deletionFacade: DeletionFacade | undefined;
}

export interface SandboxLifecycleOptions {
	onEvent?: LifecycleObserver;
	signal?: AbortSignal;
	provisionTimeoutMs?: number;
	commandTimeoutMs?: number;
	pollMs?: number;
	ownershipStore?: SandboxOwnershipStore;
	ownerGeneration?: string;
	ownerToken?: string;
	classifyError?: ProviderErrorClassifier;
	deletionFacade?: DeletionFacade;
}

export class SandboxLifecycle {
	private readonly provider: SandboxProvider;
	private readonly options: ResolvedLifecycleOptions;
	private identity: SandboxIdentity | null = null;
	private lifecycleKey_: string | null = null;
	private readonly events_: LifecycleEvent[] = [];
	private sessionId_: string | null = null;

	constructor(provider: SandboxProvider, options: SandboxLifecycleOptions = {}) {
		this.provider = provider;
		this.options = {
			onEvent: options.onEvent ?? (() => {}),
			signal: options.signal ?? new AbortController().signal,
			provisionTimeoutMs: options.provisionTimeoutMs ?? 300_000,
			commandTimeoutMs: options.commandTimeoutMs ?? 60_000,
			pollMs: options.pollMs ?? 5_000,
			ownershipStore: options.ownershipStore,
			ownerGeneration: options.ownerGeneration ?? "",
			ownerToken: options.ownerToken ?? "",
			classifyError: options.classifyError ?? defaultClassifier,
			deletionFacade: options.deletionFacade,
		};
		if (this.options.ownershipStore) {
			if (!this.options.ownerGeneration)
				throw new LifecycleError("ownerGeneration required when ownershipStore is set");
			if (!this.options.ownerToken) throw new LifecycleError("ownerToken required when ownershipStore is set");
		}
	}

	get events(): readonly LifecycleEvent[] {
		return this.events_;
	}
	private get sandboxId(): string | null {
		return this.identity?.id ?? null;
	}
	get lifecycleKey(): string | null {
		return this.lifecycleKey_;
	}

	get ownershipStore(): SandboxOwnershipStore | undefined {
		return this.options.ownershipStore;
	}
	set sessionId(value: string | null) {
		this.sessionId_ = value;
	}
	get sessionId(): string | null {
		return this.sessionId_;
	}

	private claimFor(state: SandboxOwnershipState): OwnershipClaim {
		return createClaim(this.options.ownerGeneration, this.options.ownerToken, state);
	}

	private requireSandboxId(): string {
		if (!this.identity) throw new LifecycleError("no active sandbox");
		return this.identity.id;
	}

	private emit(step: LifecycleStep, status: "start" | "success" | "error", code: string, durationMs?: number): void {
		const event: LifecycleEvent = { step, status, code, durationMs };
		this.events_.push(event);
		try {
			this.options.onEvent(event);
		} catch {
			/* isolated */
		}
	}

	private lcError(code: string): LifecycleError {
		return new LifecycleError(`sandbox-lifecycle: ${code}`);
	}

	/**
	 * Create a bounded cleanup signal (10s timeout).
	 * Only call immediately before the compensation delete — never before
	 * a long-running provider.create or waitForStatus call.
	 */
	private boundedCleanup(): { signal: AbortSignal; clear: () => void } {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10_000);
		timer.unref();
		return {
			signal: controller.signal,
			clear: () => clearTimeout(timer),
		};
	}

	// ------------------------------------------------------------------
	// Lifecycle operations
	// ------------------------------------------------------------------

	async preflight(): Promise<{ available: boolean; version: string; error: string }> {
		this.emit("preflight", "start", LIFECYCLE_CODES.PREFLIGHT_FAIL);
		const start = Date.now();
		try {
			const result = await this.provider.preflight({ signal: this.options.signal });
			const code = result.available ? LIFECYCLE_CODES.PREFLIGHT_OK : LIFECYCLE_CODES.PREFLIGHT_FAIL;
			this.emit("preflight", result.available ? "success" : "error", code, Date.now() - start);
			return result;
		} catch {
			this.emit("preflight", "error", LIFECYCLE_CODES.PREFLIGHT_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.PREFLIGHT_FAIL);
		}
	}

	async create(options: SandboxCreateOptions, sessionId?: string): Promise<SandboxIdentity> {
		this.emit("create", "start", LIFECYCLE_CODES.CREATE_FAIL);
		const start = Date.now();
		const sid = sessionId ?? this.sessionId_;

		this.options.signal.throwIfAborted();

		// Generate lifecycle key BEFORE provider contact when ownership is enabled.
		// Derive a deterministic provider label for create.
		let lifecycleKey: string | null = null;
		let resolvedCreateOptions: SandboxCreateOptions;
		if (this.options.ownershipStore) {
			lifecycleKey = randomUUID();
			this.lifecycleKey_ = lifecycleKey;
			const derivedLabel = `ovn-${lifecycleKey}`;
			resolvedCreateOptions = { ...options, sessionLabel: derivedLabel };
		} else {
			resolvedCreateOptions = options;
		}

		let identity: SandboxIdentity;
		try {
			identity = await this.provider.create(resolvedCreateOptions, this.options.signal);
		} catch {
			this.emit("create", "error", LIFECYCLE_CODES.CREATE_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.CREATE_FAIL);
		}
		this.identity = identity;

		if (this.options.ownershipStore) {
			// lifecycleKey was already generated before provider.create above
			if (!lifecycleKey) {
				throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
			}
			if (!sid) {
				const c = this.boundedCleanup();
				let cleanupSucceeded = false;
				try {
					await this.provider.delete(identity.id, c.signal);
					cleanupSucceeded = true;
				} catch {
					/* cleanup failed — retain identity for orphan audit */
				}
				c.clear();
				if (cleanupSucceeded) {
					this.identity = null;
					this.emit("create", "error", LIFECYCLE_CODES.CREATE_SESSION_REQUIRED, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.CREATE_SESSION_REQUIRED);
				}
				// Cleanup failed — the sandbox may still exist. Retain identity,
				// signal recovery so the caller can audit the orphan.
				this.emit("create", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
				throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
			}
			try {
				const claim = this.claimFor("provisioning");
				await this.options.ownershipStore.create(claim, lifecycleKey, sid);
				this.sessionId_ = sid;
			} catch {
				const c = this.boundedCleanup();
				let cleanupSucceeded = false;
				try {
					await this.provider.delete(identity.id, c.signal);
					cleanupSucceeded = true;
				} catch {
					/* best-effort */
				}
				c.clear();
				if (cleanupSucceeded) {
					this.identity = null;
					this.emit("create", "error", LIFECYCLE_CODES.CREATE_FAIL, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.CREATE_FAIL);
				}
				// Cleanup failed — retain identity so the orphan can be audited.
				this.emit("create", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
				throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
			}
		}

		this.emit("create", "success", LIFECYCLE_CODES.CREATE_OK, Date.now() - start);
		return identity;
	}

	async waitForReady(): Promise<SandboxIdentity> {
		const id = this.requireSandboxId();
		this.emit("wait-ready", "start", LIFECYCLE_CODES.WAIT_FAIL);
		const start = Date.now();

		try {
			const identity = await this.provider.waitForStatus(id, SANDBOX_READY_STATUSES, {
				timeoutMs: this.options.provisionTimeoutMs,
				pollMs: this.options.pollMs,
				signal: this.options.signal,
			});
			this.identity = identity;

			if (this.options.ownershipStore && this.lifecycleKey_) {
				try {
					const claim = this.claimFor("provisioning");
					await this.options.ownershipStore.markActive(claim, this.lifecycleKey_);
				} catch {
					this.emit("wait-ready", "success", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}
			}

			this.emit("wait-ready", "success", LIFECYCLE_CODES.WAIT_OK, Date.now() - start);
			return identity;
		} catch (err) {
			if (err instanceof LifecycleError) throw err;

			// Attempt bounded platform cleanup always. Track success.
			// If cleanup succeeds and store exists: markTerminated.
			// If cleanup fails: keep identity, leave PROVISIONING record for stale reaper.
			// Never mark terminated on failed cleanup.
			let cleanupSucceeded = false;
			const c = this.boundedCleanup();
			try {
				await this.provider.delete(id, c.signal);
				cleanupSucceeded = true;
				this.identity = null;
			} catch {
				/* cleanup failure — stale reaper handles */
			} finally {
				c.clear();
			}
			if (cleanupSucceeded && this.options.ownershipStore && this.lifecycleKey_) {
				try {
					const claim = this.claimFor("provisioning");
					await this.options.ownershipStore.markTerminated(claim, this.lifecycleKey_, "provisioning_failed");
				} catch {
					/* best-effort */
				}
			}
			this.emit("wait-ready", "error", LIFECYCLE_CODES.WAIT_TIMEOUT, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.WAIT_TIMEOUT);
		}
	}

	async delete(): Promise<void> {
		this.emit("delete", "start", LIFECYCLE_CODES.DELETE_FAIL);
		const start = Date.now();

		// --- Restart recovery via deletion facade ---
		// If we have a lifecycleKey and ownershipStore but no in-memory identity
		// (restart scenario), use the deletion facade to resolve and delete.
		//
		// Rules:
		//  - Owner token/generation validated durably BEFORE provider contact
		//  - All ownership state transitions are explicit and valid
		//  - Confirmed provider delete/absent -> platformDeleted=true -> terminated -> tombstone
		//  - No record found -> check tombstone; no tombstone -> fail closed
		//  - Terminated records tombstone only with prior physical-delete evidence
		//  - Ownership errors fail closed — never swallowed
		if (!this.sandboxId && this.options.ownershipStore && this.lifecycleKey_ && this.options.deletionFacade) {
			const dtoResult = lifecycleKeyDto(this.lifecycleKey_);
			if (!("lifecycleKey" in dtoResult)) {
				this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
				throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
			}

			// Read ownership record
			const record = await this.options.ownershipStore.read(this.lifecycleKey_);

			// If no record exists, check for exact tombstone evidence
			if (!record) {
				// Read exact tombstone and validate lifecycleKey, ownerGeneration,
				// and ownerTokenHash before accepting idempotent success.
				const tombEvidence = await this.options.ownershipStore.readTombstone(this.lifecycleKey_);
				const expectedHash = createHash("sha256").update(this.options.ownerToken).digest("hex");
				const sidOk = this.sessionId !== null && tombEvidence?.sessionId === this.sessionId;
				if (
					tombEvidence &&
					tombEvidence.lifecycleKey === this.lifecycleKey_ &&
					tombEvidence.ownerGeneration === this.options.ownerGeneration &&
					tombEvidence.ownerTokenHash === expectedHash &&
					sidOk
				) {
					this.emit("delete", "success", LIFECYCLE_CODES.DELETE_OK, Date.now() - start);
					return;
				}
				// No record and no valid tombstone — cannot succeed without evidence
				this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
				throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
			}

			// Already tombstoned -- idempotent success
			if (record.state === "deleted") {
				this.emit("delete", "success", LIFECYCLE_CODES.DELETE_OK, Date.now() - start);
				return;
			}

			// Terminated records: tombstone only with prior physical-delete evidence
			if (record.state === "terminated") {
				if (!record.platformDeleted) {
					// No physical-delete evidence — cannot tombstone
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}
				// Has platformDeleted evidence — proceed to tombstone without facade call
				try {
					const stateClaim = this.claimFor("terminated");
					await this.options.ownershipStore.markDeleted(stateClaim, this.lifecycleKey_);
					// Validate actual durable tombstone evidence for the exact record identity.
					const tombEvidence = await this.options.ownershipStore.readTombstone(this.lifecycleKey_);
					if (
						!tombEvidence ||
						tombEvidence.lifecycleKey !== this.lifecycleKey_ ||
						tombEvidence.ownerGeneration !== this.options.ownerGeneration ||
						tombEvidence.ownerTokenHash !== createHash("sha256").update(this.options.ownerToken).digest("hex") ||
						tombEvidence.sessionId !== record.sessionId
					) {
						this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
						throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
					}
					this.emit("delete", "success", LIFECYCLE_CODES.DELETE_OK, Date.now() - start);
					return;
				} catch {
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}
			}

			// Validate owner token/generation BEFORE any provider contact
			const expectedHash = createHash("sha256").update(this.options.ownerToken).digest("hex");
			if (record.ownerTokenHash !== expectedHash || record.ownerGeneration !== this.options.ownerGeneration) {
				this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
				throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
			}

			// Live states: validate ownership BEFORE facade contact
			// Ownership validation happens via createClaim which asserts valid state.
			// We read the record state and validate token/generation by attempting
			// state transition.  If claim mismatches, this throws OwnershipError
			// and we fail closed.
			try {
				const currentState = record.state;
				// All live states atomically markTerminating before provider contact.
				// provisioning/passivated/rehydrating now have terminating as valid transition.
				if (
					currentState === "active" ||
					currentState === "provisioning" ||
					currentState === "passivated" ||
					currentState === "rehydrating"
				) {
					await this.options.ownershipStore.markTerminating(this.claimFor(currentState), this.lifecycleKey_);
				} else if (currentState === "terminating") {
					// Already transitioning — proceed to facade call
				} else {
					// Unknown state — fail closed
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}
			} catch (err) {
				if (err instanceof OwnershipError) {
					// Generation/token/state mismatch — fail closed
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}
				if (err instanceof LifecycleError) throw err;
				// No String() coercion of raw error values
				this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
				throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
			}

			// Run the deletion facade (provider contact)
			const result = await this.options.deletionFacade.deleteByLifecycleKey(dtoResult);

			if (result.status === "deleted" || result.status === "absent") {
				// After confirmed provider delete/absence, persist durable state.
				// Flow: set platformDeleted=true, transition to terminated, then tombstone.
				// Every confirmed provider delete/absence sets platformDeleted=true
				// for durable tombstone evidence.
				const reason: "user_deleted" | "platform_deleted" =
					result.status === "deleted" ? "user_deleted" : "platform_deleted";

				const freshRecord = await this.options.ownershipStore.read(this.lifecycleKey_);
				if (!freshRecord) {
					// Record vanished — cannot persist state, fail closed
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}

				// Already tombstoned — idempotent success
				if (freshRecord.state === "deleted") {
					this.emit("delete", "success", LIFECYCLE_CODES.DELETE_OK, Date.now() - start);
					return;
				}

				// Transition to terminated with platformDeleted and termination reason.
				// Use update() directly for exact state + platformDeleted control.
				// Preserve type narrowing — never widen to string for cast
				const afterState = freshRecord.state;
				// Valid transitions for each live state to terminated:
				//   provisioning -> terminated (valid)
				//   passivated -> terminated (valid)
				//   rehydrating -> terminated (valid)
				//   terminating -> terminated (valid)
				//   active -> should have been transitioned to terminating above
				try {
					// Use createClaim which validates the state string — never 'as' cast
					const afterClaim = createClaim(this.options.ownerGeneration, this.options.ownerToken, afterState);
					await this.options.ownershipStore.update(
						afterClaim,
						this.lifecycleKey_,
						(r: SandboxOwnershipRecord) => ({
							...r,
							state: "terminated",
							platformDeleted: true,
							terminationReason: reason,
						}),
					);
				} catch {
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}

				// Require exact terminated+platformDeleted, then markDeleted.
				// Missing/unexpected state/state!=terminated or !platformDeleted is RECOVERY_REQUIRED.
				const tombRecord = await this.options.ownershipStore.read(this.lifecycleKey_);
				if (!tombRecord || tombRecord.state !== "terminated" || !tombRecord.platformDeleted) {
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}
				try {
					const tombClaim = this.claimFor("terminated");
					await this.options.ownershipStore.markDeleted(tombClaim, this.lifecycleKey_);
					// Validate actual durable tombstone evidence for exact identity
					const tombEvidence = await this.options.ownershipStore.readTombstone(this.lifecycleKey_);
					if (
						!tombEvidence ||
						tombEvidence.lifecycleKey !== this.lifecycleKey_ ||
						tombEvidence.ownerGeneration !== this.options.ownerGeneration ||
						tombEvidence.ownerTokenHash !== createHash("sha256").update(this.options.ownerToken).digest("hex") ||
						(freshRecord && tombEvidence.sessionId !== freshRecord.sessionId)
					) {
						this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
						throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
					}
				} catch {
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}

				this.emit("delete", "success", LIFECYCLE_CODES.DELETE_OK, Date.now() - start);
				return;
			}

			// Facade returned error — fail closed
			this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
		}

		// === In-process delete path (has in-memory identity) ===
		const id = this.sandboxId;
		if (!id) return;
		const c = this.boundedCleanup();
		let deletionSessionId = this.sessionId_;

		try {
			// OWNERSHIP READ: fail closed — corrupt/error is RECOVERY_REQUIRED,
			// retaining identity and record. Missing record also fails before provider contact.
			// Validate generation+token BEFORE any state branch or provider contact.
			if (this.options.ownershipStore && this.lifecycleKey_) {
				const record = await this.options.ownershipStore.read(this.lifecycleKey_);
				if (!record) {
					// Missing record — cannot proceed without ownership evidence
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					c.clear();
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}
				const expectedHash = createHash("sha256").update(this.options.ownerToken).digest("hex");
				if (
					record.ownerGeneration !== this.options.ownerGeneration ||
					record.ownerTokenHash !== expectedHash ||
					(deletionSessionId !== null && deletionSessionId !== record.sessionId)
				) {
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					c.clear();
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}
				deletionSessionId = record.sessionId;
				this.sessionId_ = record.sessionId;
				if (record.state === "terminating") {
					// Already durably fenced — skip invalid same-state markTerminating
				} else {
					const claim = this.claimFor(record.state);
					await this.options.ownershipStore.markTerminating(claim, this.lifecycleKey_);
				}
			}

			// PROVIDER DELETE: only "not_found" from classifier is DELETE_GONE.
			try {
				await this.provider.delete(id, c.signal);
				this.identity = null;
			} catch (err) {
				const classified = this.options.classifyError(err, "delete");
				if (classified.kind !== "not_found") {
					this.emit("delete", "error", LIFECYCLE_CODES.DELETE_FAIL, Date.now() - start);
					c.clear();
					throw this.lcError(LIFECYCLE_CODES.DELETE_FAIL);
				}
				// not_found — sandbox already gone, clear identity
				this.identity = null;
			}

			// OWNERSHIP PERSIST: after platform delete succeeded.
			// Transition to terminated with platformDeleted=true for all confirmed deletions.
			if (this.options.ownershipStore && this.lifecycleKey_) {
				try {
					const claim = this.claimFor("terminating");
					await this.options.ownershipStore.update(claim, this.lifecycleKey_, (r: SandboxOwnershipRecord) => ({
						...r,
						state: "terminated",
						platformDeleted: true,
						terminationReason: "user_deleted",
					}));
					// Durable final tombstone: markDeleted requires terminated+platformDeleted
					const tombClaim = this.claimFor("terminated");
					await this.options.ownershipStore.markDeleted(tombClaim, this.lifecycleKey_);
					// Validate actual durable tombstone evidence for exact identity
					const tombEvidence = await this.options.ownershipStore.readTombstone(this.lifecycleKey_);
					if (
						!tombEvidence ||
						tombEvidence.lifecycleKey !== this.lifecycleKey_ ||
						tombEvidence.ownerGeneration !== this.options.ownerGeneration ||
						tombEvidence.ownerTokenHash !== createHash("sha256").update(this.options.ownerToken).digest("hex") ||
						deletionSessionId === null ||
						tombEvidence.sessionId !== deletionSessionId
					) {
						this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
						c.clear();
						throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
					}
				} catch {
					this.emit("delete", "error", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
					c.clear();
					throw this.lcError(LIFECYCLE_CODES.RECOVERY_REQUIRED);
				}
			}

			c.clear();
			this.emit("delete", "success", LIFECYCLE_CODES.DELETE_OK, Date.now() - start);
		} catch (err) {
			c.clear();
			if (err instanceof LifecycleError || err instanceof OwnershipError) throw err;
			// Non-lifecycle errors in catch are unexpected — never clear identity
			// or delete record as already gone.
			this.emit("delete", "error", LIFECYCLE_CODES.DELETE_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.DELETE_FAIL);
		}
	}
	async upload(localPath: string, remotePath: string): Promise<void> {
		const id = this.requireSandboxId();
		this.emit("upload", "start", LIFECYCLE_CODES.UPLOAD_FAIL);
		const start = Date.now();
		try {
			await this.provider.upload(id, localPath, remotePath, this.options.signal);
			this.emit("upload", "success", LIFECYCLE_CODES.UPLOAD_OK, Date.now() - start);
		} catch {
			this.emit("upload", "error", LIFECYCLE_CODES.UPLOAD_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.UPLOAD_FAIL);
		}
	}

	async runCommand(command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const id = this.requireSandboxId();
		this.emit("run-command", "start", LIFECYCLE_CODES.RUN_FAIL);
		const start = Date.now();
		try {
			const result = await this.provider.runCommand(id, command, {
				timeout: this.options.commandTimeoutMs / 1000,
				signal: this.options.signal,
			});
			this.emit("run-command", "success", LIFECYCLE_CODES.RUN_OK, Date.now() - start);
			return result;
		} catch {
			this.emit("run-command", "error", LIFECYCLE_CODES.RUN_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.RUN_FAIL);
		}
	}

	async download(remotePath: string, localPath: string): Promise<void> {
		const id = this.requireSandboxId();
		this.emit("download", "start", LIFECYCLE_CODES.DOWNLOAD_FAIL);
		const start = Date.now();
		try {
			await this.provider.download(id, remotePath, localPath, this.options.signal);
			this.emit("download", "success", LIFECYCLE_CODES.DOWNLOAD_OK, Date.now() - start);
		} catch {
			this.emit("download", "error", LIFECYCLE_CODES.DOWNLOAD_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.DOWNLOAD_FAIL);
		}
	}

	async getLogs(): Promise<string> {
		const id = this.requireSandboxId();
		this.emit("logs", "start", LIFECYCLE_CODES.LOGS_FAIL);
		const start = Date.now();
		try {
			const logs = await this.provider.getLogs(id, this.options.signal);
			this.emit("logs", "success", LIFECYCLE_CODES.LOGS_OK, Date.now() - start);
			return logs;
		} catch {
			this.emit("logs", "error", LIFECYCLE_CODES.LOGS_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.LOGS_FAIL);
		}
	}

	async startBackgroundJob(command: string[]): Promise<string> {
		const id = this.requireSandboxId();
		this.emit("start-background-job", "start", LIFECYCLE_CODES.BG_START_FAIL);
		const start = Date.now();
		try {
			const jobId = await this.provider.startBackgroundJob(id, command, this.options.signal);
			this.emit("start-background-job", "success", LIFECYCLE_CODES.BG_START_OK, Date.now() - start);
			return jobId;
		} catch {
			this.emit("start-background-job", "error", LIFECYCLE_CODES.BG_START_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.BG_START_FAIL);
		}
	}

	async getBackgroundJobStatus(jobId: string): Promise<BackgroundJobStatus> {
		const id = this.requireSandboxId();
		this.emit("background-job-status", "start", LIFECYCLE_CODES.BG_STATUS_FAIL);
		const start = Date.now();
		try {
			const status = await this.provider.getBackgroundJobStatus(id, jobId, this.options.signal);
			this.emit("background-job-status", "success", LIFECYCLE_CODES.BG_STATUS_OK, Date.now() - start);
			return status;
		} catch {
			this.emit("background-job-status", "error", LIFECYCLE_CODES.BG_STATUS_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.BG_STATUS_FAIL);
		}
	}

	async getBackgroundJobLogs(jobId: string): Promise<{ stdout: string; stderr: string }> {
		const id = this.requireSandboxId();
		this.emit("background-job-logs", "start", LIFECYCLE_CODES.BG_LOGS_FAIL);
		const start = Date.now();
		try {
			const logs = await this.provider.getBackgroundJobLogs(id, jobId, this.options.signal);
			this.emit("background-job-logs", "success", LIFECYCLE_CODES.BG_LOGS_OK, Date.now() - start);
			return logs;
		} catch {
			this.emit("background-job-logs", "error", LIFECYCLE_CODES.BG_LOGS_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.BG_LOGS_FAIL);
		}
	}

	async killBackgroundJob(jobId: string): Promise<void> {
		const id = this.requireSandboxId();
		this.emit("kill-background-job", "start", LIFECYCLE_CODES.BG_KILL_FAIL);
		const start = Date.now();
		try {
			await this.provider.killBackgroundJob(id, jobId, this.options.signal);
			this.emit("kill-background-job", "success", LIFECYCLE_CODES.BG_KILL_OK, Date.now() - start);
		} catch {
			this.emit("kill-background-job", "error", LIFECYCLE_CODES.BG_KILL_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.BG_KILL_FAIL);
		}
	}
	/**
	 * Recover a deletion-capable lifecycle instance from a validated ownership record.
	 * Intended for restart scenarios where the in-memory identity was lost.
	 *
	 * Accepts lifecycleKey from a validated ownership record (never public raw identity).
	 * The returned instance has lifecycleKey set and deletionFacade wired, but no
	 * in-memory identity.  Calling delete() on the recovered instance goes through
	 * the facade path.
	 *
	 * Throws if the ownership record is not found or does not belong to this owner.
	 */
	static async recover(options: {
		provider: SandboxProvider;
		ownershipStore: SandboxOwnershipStore;
		ownerGeneration: string;
		ownerToken: string;
		lifecycleKey: string;
		deletionFacade: DeletionFacade;
		signal?: AbortSignal;
		onEvent?: LifecycleObserver;
		classifyError?: ProviderErrorClassifier;
	}): Promise<SandboxLifecycle> {
		const record = await options.ownershipStore.read(options.lifecycleKey);
		if (!record) {
			throw new LifecycleError("sandbox-lifecycle: ownership record not found for recovery");
		}
		// Validate ownership -- checks generation AND token hash
		if (record.ownerGeneration !== options.ownerGeneration) {
			throw new LifecycleError("sandbox-lifecycle: owner generation mismatch for recovery");
		}
		// Verify token hash matches persisted hash
		const expectedHash = createHash("sha256").update(options.ownerToken).digest("hex");
		if (record.ownerTokenHash !== expectedHash) {
			throw new LifecycleError("sandbox-lifecycle: ownership token mismatch for recovery");
		}
		// Build a lifecycle with both lifecycleKey and deletionFacade set
		const life = new SandboxLifecycle(options.provider, {
			ownershipStore: options.ownershipStore,
			ownerGeneration: options.ownerGeneration,
			ownerToken: options.ownerToken,
			deletionFacade: options.deletionFacade,
			signal: options.signal,
			onEvent: options.onEvent,
			classifyError: options.classifyError,
		});
		// Retain the exact durable identity so tombstone-only retries remain bound.
		life.lifecycleKey_ = options.lifecycleKey;
		life.sessionId_ = record.sessionId;
		return life;
	}
}
