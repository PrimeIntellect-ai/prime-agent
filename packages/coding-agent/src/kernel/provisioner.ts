import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PythonSkillRuntimeInfo } from "../core/skills.js";
import { resolveKernelBashShell } from "../utils/shell.js";
import { withKernelBootPermit } from "./boot-gate.js";
import type { KernelBootstrapProgressHandler } from "./bootstrap.js";
import type { HostRequestHandlers, KernelClient, KernelSentAgentMessage } from "./contracts.js";
import { ReplKernelManager } from "./repl-manager.js";
import { buildRlmBootstrapCode } from "./skill-bootstrap.js";
import { manifestPathIn, type RestoreResult, snapshotPathIn } from "./state-snapshot.js";

export interface IpythonKernelOptions {
	/** Python override. Must have prime-agent-runtime installed. */
	python?: string;
	env?: Record<string, string>;
	/** Command prefix prepended to every bash() command. */
	commandPrefix?: string;
	/** Shell used by bash(). */
	shellPath?: string;
	sessionId?: string;
	/** Typed host request handlers for the kernel↔host bridge (rlm.run, goal.*, …). */
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly PythonSkillRuntimeInfo[];
	/** Per-session artifact dir where the kernel namespace snapshot is stored. Omit to disable snapshots. */
	snapshotDir?: string;
	/** Resolves before this kernel starts — e.g. the previous provisioner's dispose, so a
	 * /reload's old-kernel snapshot flush can't race the new kernel's restore. */
	readyGate?: Promise<unknown>;
	/**
	 * Fires once per kernel start when a previous session's namespace was revived
	 * (some names restored or some failed), so the session can tell the model.
	 */
	onRestore?: (result: RestoreResult) => void;
	onLateSentAgentMessage?: (toolCallId: string, message: KernelSentAgentMessage) => void;
}

function createAbortError(): Error {
	return new Error("Python execution aborted");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		onAbort?.();
		return Promise.reject(createAbortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", abort);
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			onAbort?.();
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function createLinkedAbortSignal(sources: readonly (AbortSignal | undefined)[]): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const cleanups: Array<() => void> = [];
	const abort = () => controller.abort();
	for (const source of sources) {
		if (!source) {
			continue;
		}
		if (source.aborted) {
			controller.abort();
			continue;
		}
		const listener = () => abort();
		source.addEventListener("abort", listener, { once: true });
		cleanups.push(() => source.removeEventListener("abort", listener));
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		},
	};
}

/**
 * Owns the lazy create+start+runtime-bootstrap of one session's Python kernel.
 *
 * Concurrent ensure() calls await the same in-flight startup, a failed startup
 * clears the memo so the next call retries fresh, and progress listeners can
 * attach mid-flight (a tool call racing a background prewarm()).
 */
export class IpythonKernelProvisioner {
	private managerPromise?: Promise<KernelClient>;
	private startedManager?: KernelClient;
	private readonly startupListeners = new Set<KernelBootstrapProgressHandler>();
	private lastStartupMessage?: string;
	private _lastRestore?: RestoreResult;
	private readonly disposeController = new AbortController();
	/** Snapshot policy of the dispose that aborted a startup, honored by startKernel's failure teardown. */
	private disposeSnapshot = true;

	constructor(
		private readonly cwd: string,
		private readonly options?: IpythonKernelOptions,
	) {}

	/** The kernel manager, once a startup has completed successfully. */
	get manager(): KernelClient | undefined {
		return this.startedManager;
	}

	/** Result of reviving a prior session's namespace on the last kernel start, if any. */
	get lastRestore(): RestoreResult | undefined {
		return this._lastRestore;
	}

	/** Start the kernel in the background. Failures are swallowed here and surface on the next ensure(). */
	prewarm(): void {
		void this.ensure().catch(() => {});
	}

	/** Whether a kernel has finished starting and is currently running. */
	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	/** Remove live variables above the snapshot's per-variable size limit. */
	async pruneOversizedVariables(): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		const result = await m?.pruneOversizedVariables();
		return result ? (result.pruned ?? []) : null;
	}

	/** Live user-defined names in the kernel namespace, or null if listing failed / no kernel. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.listNamespaceNames(signal)) ?? null;
	}

	/** Dispose the kernel owned by this provisioner, including one still starting up. */
	async dispose(options?: { snapshot?: boolean }): Promise<void> {
		this.disposeSnapshot = options?.snapshot ?? true;
		// Drops a still-queued boot out of the semaphore and short-circuits an
		// in-flight startKernel before it spawns, so a disposed session's boot
		// doesn't waste a slot during a fan-out.
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.shutdown({ snapshot: this.disposeSnapshot, drainHostRequests: true });
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	async kill(): Promise<void> {
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.kill();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	ensure(onProgress?: KernelBootstrapProgressHandler, signal?: AbortSignal): Promise<KernelClient> {
		if (signal?.aborted) {
			return Promise.reject(createAbortError());
		}
		// Only a terminally dead kernel drops the memo; a repairing manager (idle/starting) recovers itself.
		if (this.startedManager?.isDefunct) {
			this.managerPromise = undefined;
			this.startedManager = undefined;
		}
		let cleanupProgressListener: (() => void) | undefined;
		if (onProgress && !this.startedManager) {
			this.startupListeners.add(onProgress);
			cleanupProgressListener = () => {
				this.startupListeners.delete(onProgress);
				signal?.removeEventListener("abort", cleanupProgressListener!);
			};
			signal?.addEventListener("abort", cleanupProgressListener, { once: true });
			// Joining an in-flight startup: replay the current stage.
			if (this.managerPromise && this.lastStartupMessage) {
				onProgress(this.lastStartupMessage);
			}
		}
		if (!this.managerPromise) {
			const startup = this.startKernel(signal);
			this.managerPromise = startup;
			startup.then(
				(m) => {
					if (this.managerPromise === startup) {
						this.startedManager = m;
					}
					this.settleStartup();
				},
				() => {
					// Clear the memo so the next ensure() retries instead of
					// rethrowing a cached rejection forever.
					if (this.managerPromise === startup) {
						this.managerPromise = undefined;
					}
					this.settleStartup();
				},
			);
		}
		return raceWithAbort(this.managerPromise, signal).finally(() => {
			cleanupProgressListener?.();
		});
	}

	private settleStartup(): void {
		this.startupListeners.clear();
		this.lastStartupMessage = undefined;
	}

	private emitStartupProgress(message: string): void {
		this.lastStartupMessage = message;
		for (const listener of [...this.startupListeners]) {
			listener(message);
		}
	}

	private async startKernel(signal?: AbortSignal): Promise<KernelClient> {
		const startupAbort = createLinkedAbortSignal([this.disposeController.signal, signal]);
		const startupSignal = startupAbort.signal;
		// Wait for a previous provisioner (e.g. on /reload) to finish disposing — and
		// flushing its final snapshot — before we read that snapshot back, so the two
		// kernels can't race over the same on-disk file. Guarded so the common
		// no-gate path stays synchronous (callers rely on prompt startup progress).
		try {
			if (this.options?.readyGate) {
				await raceWithAbort(
					this.options.readyGate.catch(() => {}),
					startupSignal,
				);
			}
			const snapshotDir = this.options?.snapshotDir;
			// Always inject an absolute trusted shell (undefined only on win32
			// without bash, where the runtime's teaching error fires instead).
			const shellPath = resolveKernelBashShell(this.options?.shellPath);
			const commandPrefix = this.options?.commandPrefix;
			const bootstrapCode = buildRlmBootstrapCode(this.options?.pythonSkills);
			const m = new ReplKernelManager({
				python: this.options?.python,
				cwd: this.cwd,
				// bash() reads these to pick its shell and command prefix.
				env: {
					...this.options?.env,
					...(shellPath ? { PRIME_AGENT_BASH_SHELL: shellPath } : {}),
					...(commandPrefix ? { PRIME_AGENT_BASH_COMMAND_PREFIX: commandPrefix } : {}),
				},
				sessionId: this.options?.sessionId,
				hostHandlers: this.options?.hostHandlers,
				pythonSkills: this.options?.pythonSkills,
				// Only persistent sessions (which have an artifact dir) get a revivable snapshot.
				snapshot: snapshotDir
					? { path: snapshotPathIn(snapshotDir), manifestPath: manifestPathIn(snapshotDir) }
					: undefined,
				stderrLogPath: snapshotDir ? join(snapshotDir, "kernel-stderr.log") : undefined,
				bootstrapCode,
			});
			let pendingRestore: RestoreResult | undefined;
			try {
				// Emitted synchronously (before the permit await) so a listener attaching
				// mid-flight can replay the current stage.
				this.emitStartupProgress("Starting Python kernel...");
				// Only the process spawn + port resolve contends for OS resources under a
				// fan-out, and it is bounded by start()'s own timeouts — so the permit
				// covers only start(). Restore/bootstrap run per-kernel afterwards and are
				// unbounded execute()s; holding the global permit across them could pin it
				// forever on a wedged bootstrap and starve every other session's boot.
				await withKernelBootPermit(() => {
					// Disposed while queued for the permit — don't spawn a kernel nobody wants.
					if (startupSignal.aborted) throw new Error("Kernel provisioner disposed before start");
					return m.start({
						onBootstrapProgress: (message) => this.emitStartupProgress(message),
						signal: startupSignal,
					});
				}, startupSignal);
				// Revive a prior session's namespace before the bootstrap, so the bootstrap
				// then overwrites live handles (rlm, skills) on top of anything restored.
				if (snapshotDir) {
					const snapshotExisted = existsSync(snapshotPathIn(snapshotDir));
					this.emitStartupProgress("Restoring Python state...");
					const restore = await raceWithAbort(m.restoreState(), startupSignal);
					if (snapshotExisted) {
						pendingRestore = restore ?? { restored: [], failed: [], path: snapshotPathIn(snapshotDir) };
					}
				}
				this.emitStartupProgress("Preparing Python runtime...");
				const bootstrap = await m.execute(bootstrapCode, {
					signal: startupSignal,
				});
				if (bootstrap.status !== "ok") {
					const details = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize rlm runtime in the Python kernel:\n${details}`);
				}
			} catch (error) {
				// Never leak the kernel process if startup fails after spawn — and never
				// surface the failure before the teardown (final snapshot flush included)
				// finished, or a replacement provisioner gated on this dispose could
				// race the still-flushing kernel over the same snapshot files.
				await m.shutdown({ snapshot: this.disposeSnapshot, drainHostRequests: true }).catch(() => undefined);
				throw error;
			}
			// Only tell the model what was revived once the kernel is actually usable —
			// a notice claiming restored state must never outlive a failed bootstrap.
			if (pendingRestore) {
				this._lastRestore = pendingRestore;
				this.options?.onRestore?.(pendingRestore);
			}
			return m;
		} finally {
			startupAbort.cleanup();
		}
	}
}
