/**
 * Sandbox lifecycle — high-level adapter wrapping a SandboxProvider.
 *
 * Adds lifecycle events, cancellation (AbortSignal), and stable
 * error messages that never leak raw CLI output.
 */

import type { BackgroundJobStatus, SandboxProvider } from "./sandbox-provider.js";
import type { SandboxApiStatus, SandboxCreateOptions, SandboxIdentity } from "./sandbox-types.js";

export const SANDBOX_READY_STATUSES: SandboxApiStatus[] = ["RUNNING"];

export const LIFECYCLE_STEPS = {
	PREFLIGHT: "preflight",
	CREATE: "create",
	WAIT_READY: "wait-ready",
	UPLOAD: "upload",
	DOWNLOAD: "download",
	RUN_COMMAND: "run-command",
	LOGS: "logs",
	DELETE: "delete",
	START_BG_JOB: "start-background-job",
	BG_JOB_STATUS: "background-job-status",
	BG_JOB_LOGS: "background-job-logs",
	KILL_BG_JOB: "kill-background-job",
} as const;

export type LifecycleStep = (typeof LIFECYCLE_STEPS)[keyof typeof LIFECYCLE_STEPS];

export interface LifecycleEvent {
	step: LifecycleStep;
	status: "start" | "success" | "error";
	message: string;
	durationMs?: number;
}

export type LifecycleObserver = (event: LifecycleEvent) => void;

export interface SandboxLifecycleOptions {
	onEvent?: LifecycleObserver;
	signal?: AbortSignal;
	provisionTimeoutMs?: number;
	commandTimeoutMs?: number;
	pollMs?: number;
}

export class SandboxLifecycle {
	private readonly provider: SandboxProvider;
	private readonly options: Required<SandboxLifecycleOptions>;
	private identity: SandboxIdentity | null = null;
	private readonly events_: LifecycleEvent[] = [];

	constructor(provider: SandboxProvider, options: SandboxLifecycleOptions = {}) {
		this.provider = provider;
		this.options = {
			onEvent: options.onEvent ?? (() => {}),
			signal: options.signal ?? new AbortController().signal,
			provisionTimeoutMs: options.provisionTimeoutMs ?? 300_000,
			commandTimeoutMs: options.commandTimeoutMs ?? 60_000,
			pollMs: options.pollMs ?? 5_000,
		};
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

	async preflight(): Promise<{ available: boolean; version: string; error: string }> {
		this.emit("preflight", "start", "");
		const start = Date.now();
		try {
			const result = await this.provider.preflight({ signal: this.options.signal });
			this.emit("preflight", result.available ? "success" : "error", result.error, Date.now() - start);
			return result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("preflight", "error", msg, Date.now() - start);
			throw new Error(`sandbox-lifecycle: preflight ${msg}`);
		}
	}

	async create(options: SandboxCreateOptions): Promise<SandboxIdentity> {
		this.emit("create", "start", "");
		const start = Date.now();
		try {
			this.options.signal.throwIfAborted();
			const identity = await this.provider.create(options, this.options.signal);
			this.identity = identity;
			this.emit("create", "success", identity.id, Date.now() - start);
			return identity;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("create", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: create ${msg}`);
		}
	}

	async waitForReady(): Promise<SandboxIdentity> {
		const id = this.requireSandboxId();
		this.emit("wait-ready", "start", "");
		const start = Date.now();
		try {
			const identity = await this.provider.waitForStatus(id, SANDBOX_READY_STATUSES, {
				timeoutMs: this.options.provisionTimeoutMs,
				pollMs: this.options.pollMs,
				signal: this.options.signal,
			});
			this.identity = identity;
			this.emit("wait-ready", "success", identity.status, Date.now() - start);
			return identity;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("wait-ready", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: wait-ready ${msg}`);
		}
	}

	async upload(localPath: string, remotePath: string): Promise<void> {
		const id = this.requireSandboxId();
		this.emit("upload", "start", "");
		const start = Date.now();
		try {
			await this.provider.upload(id, localPath, remotePath, this.options.signal);
			this.emit("upload", "success", "", Date.now() - start);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("upload", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: upload ${msg}`);
		}
	}

	async runCommand(command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const id = this.requireSandboxId();
		this.emit("run-command", "start", "");
		const start = Date.now();
		try {
			const result = await this.provider.runCommand(id, command, {
				timeout: this.options.commandTimeoutMs / 1000,
				signal: this.options.signal,
			});
			this.emit("run-command", "success", `exit=${result.exitCode}`, Date.now() - start);
			return result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("run-command", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: run-command ${msg}`);
		}
	}

	async download(remotePath: string, localPath: string): Promise<void> {
		const id = this.requireSandboxId();
		this.emit("download", "start", "");
		const start = Date.now();
		try {
			await this.provider.download(id, remotePath, localPath, this.options.signal);
			this.emit("download", "success", "", Date.now() - start);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("download", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: download ${msg}`);
		}
	}

	async getLogs(): Promise<string> {
		const id = this.requireSandboxId();
		this.emit("logs", "start", "");
		const start = Date.now();
		try {
			const logs = await this.provider.getLogs(id, this.options.signal);
			this.emit("logs", "success", "", Date.now() - start);
			return logs;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("logs", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: logs ${msg}`);
		}
	}

	async delete(): Promise<void> {
		const id = this.sandboxId;
		if (!id) return;
		this.emit("delete", "start", "");
		const start = Date.now();
		try {
			await this.provider.delete(id, this.options.signal);
			this.identity = null;
			this.emit("delete", "success", "", Date.now() - start);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("delete", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: delete ${msg}`);
		}
	}

	// ---- Background job operations ----

	async startBackgroundJob(command: string[]): Promise<string> {
		const id = this.requireSandboxId();
		this.emit("start-background-job", "start", "");
		const start = Date.now();
		try {
			const jobId = await this.provider.startBackgroundJob(id, command, this.options.signal);
			this.emit("start-background-job", "success", jobId, Date.now() - start);
			return jobId;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("start-background-job", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: start-background-job ${msg}`);
		}
	}

	async getBackgroundJobStatus(jobId: string): Promise<BackgroundJobStatus> {
		const id = this.requireSandboxId();
		this.emit("background-job-status", "start", "");
		const start = Date.now();
		try {
			const status = await this.provider.getBackgroundJobStatus(id, jobId, this.options.signal);
			this.emit(
				"background-job-status",
				"success",
				`pid=${status.pid} running=${status.running}`,
				Date.now() - start,
			);
			return status;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("background-job-status", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: background-job-status ${msg}`);
		}
	}

	async getBackgroundJobLogs(jobId: string): Promise<{ stdout: string; stderr: string }> {
		const id = this.requireSandboxId();
		this.emit("background-job-logs", "start", "");
		const start = Date.now();
		try {
			const logs = await this.provider.getBackgroundJobLogs(id, jobId, this.options.signal);
			this.emit("background-job-logs", "success", "", Date.now() - start);
			return logs;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("background-job-logs", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: background-job-logs ${msg}`);
		}
	}

	async killBackgroundJob(jobId: string): Promise<void> {
		const id = this.requireSandboxId();
		this.emit("kill-background-job", "start", "");
		const start = Date.now();
		try {
			await this.provider.killBackgroundJob(id, jobId, this.options.signal);
			this.emit("kill-background-job", "success", "", Date.now() - start);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unexpected error";
			this.emit("kill-background-job", "error", msg, Date.now() - start);
			throw err instanceof Error ? err : new Error(`sandbox-lifecycle: kill-background-job ${msg}`);
		}
	}

	private emit(
		step: LifecycleStep,
		status: "start" | "success" | "error",
		message: string,
		durationMs?: number,
	): void {
		const event: LifecycleEvent = { step, status, message, durationMs };
		this.events_.push(event);
		this.options.onEvent(event);
	}

	private requireSandboxId(): string {
		if (!this.identity) {
			throw new Error("sandbox-lifecycle: no active sandbox");
		}
		return this.identity.id;
	}
}
