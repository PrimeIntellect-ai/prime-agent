// TODO: reconsider whether the persistent kernel is needed once RLM-1 weights land.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { withKernelBootPermit } from "../kernel/boot-gate.js";
import type { KernelBootstrapProgressHandler } from "../kernel/bootstrap.js";
import {
	type ExecuteResult,
	type HostRequestHandlers,
	type KernelAttachment,
	KernelBusyAfterInterruptError,
	KernelContainerCleanupError,
	type KernelDiffDisplay,
	KernelManager,
	type KernelSentAgentMessage,
	type KernelSnapshotConfig,
} from "../kernel/index.js";
import {
	createKernelOutputScratch,
	kernelOutputPathIsProtected,
	removeKernelOutputScratch,
	type KernelContainerIsolationOptions,
	type KernelContainerIsolationResolver,
} from "../kernel/isolation.js";
import { manifestPathIn, type RestoreResult, snapshotPathIn } from "../kernel/state-snapshot.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import { parseIpythonBashCell } from "./ipython-cell-code.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const MAX_IPYTHON_TOOL_OUTPUT_CHARS = 1_000_000;
const IPYTHON_OUTPUT_TRUNCATION_MARKER = "\n[... output truncated ...]";

function truncateIpythonOutput(value: string, maxChars = MAX_IPYTHON_TOOL_OUTPUT_CHARS): string {
	if (value.length <= maxChars) return value;
	if (maxChars <= IPYTHON_OUTPUT_TRUNCATION_MARKER.length) return IPYTHON_OUTPUT_TRUNCATION_MARKER.slice(0, maxChars);
	return `${value.slice(0, maxChars - IPYTHON_OUTPUT_TRUNCATION_MARKER.length)}${IPYTHON_OUTPUT_TRUNCATION_MARKER}`;
}

function appendIpythonOutput(current: string, next: string): string {
	if (!next) return current;
	return truncateIpythonOutput(`${current}${current ? "\n" : ""}${next}`);
}

function isKernelContainerCleanupFailure(error: unknown): boolean {
	return error instanceof KernelContainerCleanupError || (
		error instanceof Error &&
		typeof (error as { readonly code?: unknown }).code === "string" &&
		(error as { readonly code: string }).code.startsWith("KERNEL_CONTAINER_")
	);
}

function truncateIpythonTraceback(traceback: readonly string[]): string[] {
	const bounded = truncateIpythonOutput(traceback.join("\n"));
	return bounded ? bounded.split("\n") : [];
}

const RLM_BOOTSTRAP_BASE_CODE = `
import asyncio
import os as _prime_agent_os

_prime_agent_os.environ["NO_COLOR"] = "1"
get_ipython().colors = "nocolor"

try:
    import nest_asyncio as _prime_agent_nest_asyncio
    _prime_agent_nest_asyncio.apply()
except Exception:
    pass

try:
    import rlm as _prime_agent_rlm_module
    rlm = _prime_agent_rlm_module.rlm
except Exception as _prime_agent_rlm_error:
    _PRIME_AGENT_RLM_IMPORT_ERROR = str(_prime_agent_rlm_error)

    class _PrimeAgentMissingRlm:
        def _raise_missing(self):
            raise RuntimeError(
                "prime-agent-runtime is not installed in this IPython kernel. "
                "Remove ~/.prime/agent/kernel-venv so prime-agent can rebuild it, or set "
                "PRIME_AGENT_KERNEL_PYTHON to a kernel environment with prime-agent-runtime installed. "
                f"Import error: {_PRIME_AGENT_RLM_IMPORT_ERROR}"
            )

        async def run(self, prompt, **kwargs):
            self._raise_missing()

        async def find_models(self, query="", limit=8):
            self._raise_missing()

        async def list_subagents(self):
            self._raise_missing()

        async def delete_subagent(self, target):
            self._raise_missing()

        async def __call__(self, prompt, **kwargs):
            return await self.run(prompt, **kwargs)

    rlm = _PrimeAgentMissingRlm()
`.trim();

export function buildRlmBootstrapCode(
	pythonSkills: readonly PythonSkillRuntimeInfo[] = [],
	requiredPythonSkillImports: readonly string[] = [],
): string {
	const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
	if (importNames.length === 0) {
		return RLM_BOOTSTRAP_BASE_CODE;
	}
	const sourcePaths = [...new Set(pythonSkills.map((skill) => join(skill.packagePath, "src")))];

	return `
${RLM_BOOTSTRAP_BASE_CODE}

import importlib as _prime_agent_importlib
import inspect as _prime_agent_inspect
import sys as _prime_agent_sys
import types as _prime_agent_types

for _prime_agent_skill_source in ${JSON.stringify(sourcePaths)}:
    if _prime_agent_skill_source not in _prime_agent_sys.path:
        _prime_agent_sys.path.insert(0, _prime_agent_skill_source)

class _PrimeAgentCallableSkillModule(_prime_agent_types.ModuleType):
    async def __call__(self, *args, **kwargs):
        result = self.run(*args, **kwargs)
        if _prime_agent_inspect.isawaitable(result):
            return await result
        return result

class _PrimeAgentUnavailableSkill:
    def __init__(self, name, error):
        self.__name__ = name
        self._prime_agent_import_error = error
        self.__doc__ = f"Python skill {name} is unavailable: {error}"

    async def run(self, *args, **kwargs):
        raise RuntimeError(
            f"Python skill {self.__name__} is unavailable in this IPython kernel. "
            f"Import error: {self._prime_agent_import_error}"
        )

    async def __call__(self, *args, **kwargs):
        return await self.run(*args, **kwargs)

    def __repr__(self):
        return f"<unavailable Python skill {self.__name__!r}: {self._prime_agent_import_error}>"

def _prime_agent_wrap_skill_module(module):
    run = getattr(module, "run", None)
    if not callable(run):
        return module
    if isinstance(module, _PrimeAgentCallableSkillModule):
        return module
    wrapped = _PrimeAgentCallableSkillModule(module.__name__)
    wrapped.__dict__.update(module.__dict__)
    try:
        wrapped.__signature__ = _prime_agent_inspect.signature(run)
    except Exception:
        pass
    doc = getattr(run, "__doc__", None)
    if doc:
        wrapped.__doc__ = doc
    _prime_agent_sys.modules[module.__name__] = wrapped
    return wrapped

_PRIME_AGENT_SKILL_IMPORT_ERRORS = {}

for _prime_agent_skill_name in ${JSON.stringify(importNames)}:
    try:
        globals()[_prime_agent_skill_name] = _prime_agent_wrap_skill_module(
            _prime_agent_importlib.import_module(_prime_agent_skill_name)
        )
    except Exception as _prime_agent_skill_error:
        _PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_agent_skill_name] = str(_prime_agent_skill_error)
        globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill(
            _prime_agent_skill_name,
            str(_prime_agent_skill_error),
        )

for _prime_agent_required_skill_name in ${JSON.stringify([...new Set(requiredPythonSkillImports)])}:
    if (
        _prime_agent_required_skill_name in _PRIME_AGENT_SKILL_IMPORT_ERRORS
        or _prime_agent_required_skill_name not in globals()
    ):
        _prime_agent_required_skill_error = _PRIME_AGENT_SKILL_IMPORT_ERRORS.get(
            _prime_agent_required_skill_name,
            "skill was not included in the admitted runtime",
        )
        raise RuntimeError(
            f"required Python skill {_prime_agent_required_skill_name} is unavailable: "
            f"{_prime_agent_required_skill_error}"
        )
`.trim();
}

const ipythonSchema = Type.Object({
	code: Type.String({
		description:
			"Python scratchpad code or `%%bash` shell cells to execute in the agent kernel. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
	}),
});

const BUSY_KERNEL_WAIT_CHOICE = "Wait and preserve state";
const BUSY_KERNEL_KILL_CHOICE = "Kill kernel and restart";
const BUSY_KERNEL_PROMPT = [
	"Interrupted IPython cell is still running",
	"Ctrl+C sent an interrupt, but the previous cell has not stopped yet. A new IPython command cannot start until it finishes.",
	"Waiting preserves the current kernel state. Killing restarts IPython and loses in-memory variables, imports, and running tasks.",
].join("\n");
const KERNEL_RESTART_NOTICE = [
	"<ipython_kernel_reset>",
	"The IPython kernel was restarted after a previous interrupted cell kept running. Variables, imports, async tasks, and open resources from before the restart are no longer available; recreate them before using them.",
	"</ipython_kernel_reset>",
].join("\n");

function createAbortError(): Error {
	return new Error("IPython execution aborted");
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

function setWorkingMessage(ctx: ExtensionContext | undefined, message?: string): void {
	try {
		ctx?.ui.setWorkingMessage(message);
	} catch {
		// Stale UI context; cosmetic only.
	}
}

export type IpythonToolInput = Static<typeof ipythonSchema>;

export interface IpythonToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	/** Diffs streamed from file edits, rendered by the IPython cell. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments loaded into context (e.g. by the attach-image skill). */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell. */
	sentAgentMessages?: KernelSentAgentMessage[];
	/** True when this result came after killing and restarting a busy kernel. */
	kernelRestarted?: boolean;
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
}

export interface IpythonToolOptions {
	/** Python override. Must have `ipykernel` installed. */
	python?: string;
	/** Optional physical Docker boundary for worker/coordinator kernels. */
	isolation?: KernelContainerIsolationOptions | KernelContainerIsolationResolver;
	/** Host-owned agent directory used for the default bootstrapped Python runtime. */
	agentDir?: string;
	env?: Record<string, string>;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
	/** Optional explicit shell path for bare %%bash cells. */
	shellPath?: string;
	sessionId?: string;
	/** Typed host request handlers for the kernel↔host bridge (rlm.run, goal.*, …). */
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly PythonSkillRuntimeInfo[];
	/** Python skill imports that must be functional before the kernel is admitted. */
	requiredPythonSkillImports?: readonly string[];
	/** Per-session artifact dir where the kernel namespace snapshot is stored. Omit to disable snapshots. */
	snapshotDir?: string;
	/** Durable-state policy applied to the session snapshot. */
	snapshot?: Omit<KernelSnapshotConfig, "path" | "manifestPath">;
	/** Resolves before this kernel starts — e.g. the previous provisioner's dispose, so a
	 * /reload's old-kernel snapshot flush can't race the new kernel's restore. */
	readyGate?: Promise<unknown>;
	/** Filled with the live KernelManager after the first kernel start; cleared on construction. */
	kernelManagerRef?: { current?: KernelManager };
	/**
	 * Fires once per kernel start when a previous session's namespace was revived
	 * (some names restored or some failed), so the session can tell the model.
	 */
	onRestore?: (result: RestoreResult) => void;
	onLateSentAgentMessage?: (toolCallId: string, message: KernelSentAgentMessage) => void;
	/** Shared provisioner owning the kernel lifecycle. When provided, the remaining options are ignored. */
	provisioner?: IpythonKernelProvisioner;
}

function quoteScriptMagicArgument(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function applyShellSettingsToBashMagicCell(
	code: string,
	options: Pick<IpythonToolOptions, "commandPrefix" | "shellPath"> | undefined,
): string {
	const commandPrefix = options?.commandPrefix;
	const shellPath = options?.shellPath?.trim();
	if (!commandPrefix && !shellPath) return code;

	const bashCell = parseIpythonBashCell(code);
	if (!bashCell) return code;

	const firstLine =
		shellPath && bashCell.magicArguments.trim().length === 0
			? `${bashCell.indent}%%script ${quoteScriptMagicArgument(shellPath)}`
			: `${bashCell.indent}%%bash${bashCell.magicArguments}`;
	const nextBody = commandPrefix ? `${commandPrefix}${bashCell.body ? `\n${bashCell.body}` : ""}` : bashCell.body;
	return `${bashCell.leadingWhitespace}${firstLine}${bashCell.lineBreak || "\n"}${nextBody}`;
}

/**
 * Owns the lazy create+start+runtime-bootstrap of one session's IPython kernel.
 *
 * Concurrent ensure() calls await the same in-flight startup, a failed startup
 * clears the memo so the next call retries fresh, and progress listeners can
 * attach mid-flight (a tool call racing a background prewarm()).
 */
export class IpythonKernelProvisioner {
	private managerPromise?: Promise<KernelManager>;
	private startingManager?: KernelManager;
	private startedManager?: KernelManager;
	private runtimeFence?: Promise<void>;
	private readonly startupListeners = new Set<KernelBootstrapProgressHandler>();
	private lastStartupMessage?: string;
	private _lastRestore?: RestoreResult;
	private isolationOutputScratch?: string;
	private readonly disposeController = new AbortController();

	constructor(
		private readonly cwd: string,
		private readonly options?: Omit<IpythonToolOptions, "provisioner">,
	) {
		if (options?.kernelManagerRef) {
			options.kernelManagerRef.current = undefined;
		}
	}

	/** The kernel manager, once a startup has completed successfully. */
	get manager(): KernelManager | undefined {
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

	private removeIsolationOutputScratch(): void {
		const scratch = this.isolationOutputScratch;
		this.isolationOutputScratch = undefined;
		if (scratch !== undefined) removeKernelOutputScratch(scratch);
	}

	/** Whether a kernel has finished starting and is currently running. */
	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	/** Live user-defined names in the kernel namespace, or null if listing failed / no kernel. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.listNamespaceNames(signal)) ?? null;
	}

	/** Dispose the kernel owned by this provisioner, including one still starting up. */
	async dispose(): Promise<void> {
		// Drops a still-queued boot out of the semaphore and short-circuits an
		// in-flight startKernel before it spawns, so a disposed session's boot
		// doesn't waste a slot during a fan-out.
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) {
			this.options.kernelManagerRef.current = undefined;
		}
		let cleanupError: unknown;
		if (pending) {
			try {
				const manager = await pending;
				await manager.dispose();
			} catch (error) {
				if (!this.disposeController.signal.aborted || isKernelContainerCleanupFailure(error)) cleanupError = error;
			}
		}
		try {
			this.removeIsolationOutputScratch();
		} catch (error) {
			cleanupError ??= error;
		}
		if (cleanupError !== undefined) throw cleanupError;
	}

	async kill(): Promise<void> {
		let fenceError: unknown;
		if (this.runtimeFence) {
			try {
				await this.runtimeFence;
			} catch (error) {
				fenceError = error;
			}
			try {
				this.removeIsolationOutputScratch();
			} catch (error) {
				fenceError ??= error;
			}
			if (fenceError !== undefined) throw fenceError;
			return;
		}
		const pending = this.managerPromise;
		const startingManager = this.startingManager;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) {
			this.options.kernelManagerRef.current = undefined;
		}
		const fence = (async () => {
			let cleanupError: unknown;
			try {
				await startingManager?.kill();
			} catch (error) {
				cleanupError = error;
			}
			if (!pending) {
				if (cleanupError !== undefined) throw cleanupError;
				return;
			}
			try {
				const manager = await pending;
				if (manager !== startingManager) await manager.kill();
			} catch (error) {
				if (isKernelContainerCleanupFailure(error)) cleanupError ??= error;
			}
			if (cleanupError !== undefined) throw cleanupError;
		})();
		this.runtimeFence = fence;
		try {
			await fence;
		} catch (error) {
			fenceError = error;
		} finally {
			if (this.runtimeFence === fence) this.runtimeFence = undefined;
		}
		try {
			this.removeIsolationOutputScratch();
		} catch (error) {
			fenceError ??= error;
		}
		if (fenceError !== undefined) throw fenceError;
	}

	ensure(onProgress?: KernelBootstrapProgressHandler, signal?: AbortSignal): Promise<KernelManager> {
		if (signal?.aborted) {
			return Promise.reject(createAbortError());
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
			const startup = this.runtimeFence
				? this.runtimeFence.then(() => this.startKernel(signal))
				: this.startKernel(signal);
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

	private async startKernel(signal?: AbortSignal): Promise<KernelManager> {
		const startupAbort = createLinkedAbortSignal([this.disposeController.signal, signal]);
		const startupSignal = startupAbort.signal;
		let startingManager: KernelManager | undefined;
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
			const configuredIsolation = this.options?.isolation;
			const isolation = typeof configuredIsolation === "function" ? configuredIsolation() : configuredIsolation;
			let snapshotDir = this.options?.snapshotDir;
			let isolationOutputPaths: readonly string[] | undefined;
			if (isolation) {
				const outputScratch = createKernelOutputScratch(isolation);
				this.isolationOutputScratch = outputScratch;
				if (snapshotDir === undefined || kernelOutputPathIsProtected(snapshotDir, isolation.protectedPaths)) {
					snapshotDir = outputScratch;
					isolationOutputPaths = [outputScratch];
				}
			}
			const m = new KernelManager({
				python: this.options?.python,
				agentDir: this.options?.agentDir,
				cwd: this.cwd,
				env: this.options?.env,
				sessionId: this.options?.sessionId,
				hostHandlers: this.options?.hostHandlers,
				pythonSkills: this.options?.pythonSkills,
				isolation,
				isolationOutputPaths,
				// Only persistent sessions (which have an artifact dir) get a revivable snapshot.
				snapshot: snapshotDir
					? {
							...this.options?.snapshot,
							path: snapshotPathIn(snapshotDir),
							manifestPath: manifestPathIn(snapshotDir),
							artifactRoot: isolation ? snapshotDir : this.options?.snapshot?.artifactRoot,
						}
					: undefined,
			});
			startingManager = m;
			this.startingManager = m;
			let pendingRestore: RestoreResult | undefined;
			try {
				// Emitted synchronously (before the permit await) so a listener attaching
				// mid-flight can replay the current stage.
				this.emitStartupProgress("Starting IPython kernel...");
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
					this.emitStartupProgress("Restoring IPython state...");
					const restore = await raceWithAbort(m.restoreState(), startupSignal);
					if (snapshotExisted) {
						if (!restore) throw new Error("Snapshot restore did not return a result for a configured checkpoint");
						pendingRestore = restore;
					}
				}
				this.emitStartupProgress("Preparing IPython runtime...");
				const bootstrap = await m.execute(
					buildRlmBootstrapCode(this.options?.pythonSkills, this.options?.requiredPythonSkillImports),
					{
						signal: startupSignal,
					},
				);
				if (bootstrap.status !== "ok") {
					const details = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize rlm runtime in the IPython kernel:\n${details}`);
				}
			} catch (error) {
				// Never leak the kernel's ZMQ sockets / temp dir if startup fails after spawn.
				let cleanupError: unknown;
				try {
					await m.kill();
				} catch (killError) {
					cleanupError = killError;
				}
				try {
					this.removeIsolationOutputScratch();
				} catch (scratchError) {
					cleanupError ??= scratchError;
				}
				throw cleanupError ?? error;
			}
			// Only tell the model what was revived once the kernel is actually usable —
			// a notice claiming restored state must never outlive a failed bootstrap.
			if (pendingRestore) {
				this._lastRestore = pendingRestore;
				this.options?.onRestore?.(pendingRestore);
			}
			if (this.options?.kernelManagerRef) {
				this.options.kernelManagerRef.current = m;
			}
			return m;
		} finally {
			if (this.startingManager === startingManager) this.startingManager = undefined;
			startupAbort.cleanup();
		}
	}
}

async function chooseBusyKernelAction(
	ctx: ExtensionContext | undefined,
	signal: AbortSignal | undefined,
): Promise<"wait" | "kill" | "cancel"> {
	if (!ctx?.hasUI) {
		return "cancel";
	}
	const choice = await ctx.ui.select(BUSY_KERNEL_PROMPT, [BUSY_KERNEL_WAIT_CHOICE, BUSY_KERNEL_KILL_CHOICE], {
		signal,
	});
	if (choice === BUSY_KERNEL_WAIT_CHOICE) {
		return "wait";
	}
	if (choice === BUSY_KERNEL_KILL_CHOICE) {
		return "kill";
	}
	return "cancel";
}

async function executeWithBusyKernelChoice(
	provisioner: IpythonKernelProvisioner,
	reportStartupProgress: KernelBootstrapProgressHandler,
	toolCallId: string,
	code: string,
	signal: AbortSignal | undefined,
	onStream: (chunk: string, name: "stdout" | "stderr") => void,
	onWorkingMessage: (message?: string) => void,
	onLateSentAgentMessage: ((toolCallId: string, message: KernelSentAgentMessage) => void) | undefined,
	ctx: ExtensionContext | undefined,
): Promise<{ result: ExecuteResult; kernelRestarted: boolean }> {
	let kernelRestarted = false;
	while (true) {
		const m = await provisioner.ensure(reportStartupProgress, signal);
		try {
			return {
				result: await m.execute(code, {
					signal,
					onStream,
					onLateSentAgentMessage: onLateSentAgentMessage
						? (message) => onLateSentAgentMessage(toolCallId, message)
						: undefined,
				}),
				kernelRestarted,
			};
		} catch (error) {
			if (!(error instanceof KernelBusyAfterInterruptError) || signal?.aborted) {
				throw error;
			}
			const action = await chooseBusyKernelAction(ctx, signal);
			if (action === "wait") {
				onWorkingMessage("Waiting for IPython kernel...");
				continue;
			}
			if (action === "kill") {
				onWorkingMessage("Restarting IPython kernel...");
				await provisioner.kill();
				kernelRestarted = true;
				continue;
			}
			throw error;
		}
	}
}

/** Turn kernel image attachments into `ImageContent` blocks; non-image types are dropped. */
export function imageBlocksFromAttachments(attachments: readonly KernelAttachment[] | undefined): ImageContent[] {
	if (!attachments) return [];
	return attachments
		.filter((a) => IMAGE_MIME_TYPES.has(a.mimeType))
		.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
}

export function createIpythonToolDefinition(
	cwd: string,
	options?: IpythonToolOptions,
): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	const provisioner = options?.provisioner ?? new IpythonKernelProvisioner(cwd, options);

	return {
		name: "ipython",
		label: "ipython",
		description:
			"Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls, and durable state is verified when a session is resumed; declared transient values are omitted and required state failures stop the resume. Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
		promptSnippet: "ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration",
		// The kernel is single-threaded — pi must not run two ipython calls in parallel within a batch.
		executionMode: "sequential",
		parameters: ipythonSchema,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			let hasWorkingMessage = false;
			const setToolWorkingMessage = (message?: string) => {
				setWorkingMessage(ctx, message);
				hasWorkingMessage = message !== undefined;
			};
			const reportStartupProgress: KernelBootstrapProgressHandler = (message) => {
				setToolWorkingMessage(message);
				onUpdate?.({
					content: [{ type: "text", text: message }],
					details: { status: "starting" },
				});
			};

			try {
				const code = applyShellSettingsToBashMagicCell(params.code, options);
				const { result: r, kernelRestarted } = await executeWithBusyKernelChoice(
					provisioner,
					reportStartupProgress,
					toolCallId,
					code,
					signal,
					(chunk) => {
						onUpdate?.({
							content: [{ type: "text", text: chunk }],
							details: { status: "ok" },
						});
					},
					setToolWorkingMessage,
					options?.onLateSentAgentMessage,
					ctx,
				);

				const stdout = truncateIpythonOutput(r.stdout);
				const stderr = truncateIpythonOutput(r.stderr);
				const result = r.result === undefined ? undefined : truncateIpythonOutput(r.result);
				const error = r.error
					? {
							...r.error,
							evalue: truncateIpythonOutput(r.error.evalue),
							traceback: truncateIpythonTraceback(r.error.traceback),
						}
					: undefined;
				let text = "";
				text = appendIpythonOutput(text, stdout);
				text = appendIpythonOutput(text, stderr);
				text = appendIpythonOutput(text, result ?? "");
				if (r.status === "error" && error) text = appendIpythonOutput(text, error.traceback.join("\n"));
				if (kernelRestarted) {
					text = truncateIpythonOutput(text ? `${KERNEL_RESTART_NOTICE}\n\n${text}` : KERNEL_RESTART_NOTICE);
				}

				const imageBlocks = imageBlocksFromAttachments(r.attachments);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: text || "" }, ...imageBlocks];

				return {
					content,
					details: {
						durationMs: r.durationMs,
						status: r.status,
						errorEname: error?.ename,
						stdout,
						stderr,
						result,
						diffs: r.diffs,
						attachments: r.attachments,
						sentAgentMessages: r.sentAgentMessages,
						kernelRestarted,
						error,
					},
					isError: r.status === "error" || r.status === "aborted",
				};
			} finally {
				if (hasWorkingMessage) {
					setToolWorkingMessage();
				}
			}
		},
	};
}

export function createIpythonTool(cwd: string, options?: IpythonToolOptions): AgentTool<typeof ipythonSchema> {
	return wrapToolDefinition(createIpythonToolDefinition(cwd, options));
}
