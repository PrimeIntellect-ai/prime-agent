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

import type { OwnershipClaim, SandboxOwnershipState, SandboxOwnershipStore } from "./sandbox-ownership.js";
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
}

export class SandboxLifecycle {
	private readonly provider: SandboxProvider;
	private readonly options: ResolvedLifecycleOptions;
	private identity: SandboxIdentity | null = null;
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
	get sandboxId(): string | null {
		return this.identity?.id ?? null;
	}
	get sandboxIdentity(): SandboxIdentity | null {
		return this.identity;
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

		let identity: SandboxIdentity;
		try {
			identity = await this.provider.create(options, this.options.signal);
		} catch {
			this.emit("create", "error", LIFECYCLE_CODES.CREATE_FAIL, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.CREATE_FAIL);
		}
		this.identity = identity;

		if (this.options.ownershipStore) {
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
				await this.options.ownershipStore.create(claim, identity.id, sid);
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
		return this.identity!;
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

			if (this.options.ownershipStore) {
				try {
					const claim = this.claimFor("provisioning");
					await this.options.ownershipStore.markActive(claim, id);
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
			if (cleanupSucceeded && this.options.ownershipStore) {
				try {
					const claim = this.claimFor("provisioning");
					await this.options.ownershipStore.markTerminated(claim, id, "provisioning_failed");
				} catch {
					/* best-effort */
				}
			}
			this.emit("wait-ready", "error", LIFECYCLE_CODES.WAIT_TIMEOUT, Date.now() - start);
			throw this.lcError(LIFECYCLE_CODES.WAIT_TIMEOUT);
		}
	}

	async delete(): Promise<void> {
		const id = this.sandboxId;
		if (!id) return;
		this.emit("delete", "start", LIFECYCLE_CODES.DELETE_FAIL);
		const start = Date.now();
		const c = this.boundedCleanup();

		try {
			// OWNERSHIP READ: fail closed — corrupt/error is RECOVERY_REQUIRED,
			// retaining identity and record.
			if (this.options.ownershipStore) {
				const record = await this.options.ownershipStore.read(id);
				if (record) {
					const claim = this.claimFor(record.state);
					await this.options.ownershipStore.markTerminating(claim, id);
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
			if (this.options.ownershipStore) {
				try {
					const claim = this.claimFor("terminating");
					await this.options.ownershipStore.markTerminated(claim, id, "user_deleted");
				} catch {
					this.emit("delete", "success", LIFECYCLE_CODES.RECOVERY_REQUIRED, Date.now() - start);
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
}
