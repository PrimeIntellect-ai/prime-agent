import { existsSync } from "node:fs";
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
	type KernelDiffDisplay,
	KernelManager,
	type KernelRecoveryResult,
	type KernelSentAgentMessage,
} from "../kernel/index.js";
import { manifestPathIn, type RestoreResult, snapshotPathIn } from "../kernel/state-snapshot.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import { parseIpythonBashCell } from "./ipython-cell-code.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

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
    import rlm.mcp as mcp
    mcp.install_shutdown_hook()
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

export function buildRlmBootstrapCode(pythonSkills: readonly PythonSkillRuntimeInfo[] = []): string {
	const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
	if (importNames.length === 0) {
		return RLM_BOOTSTRAP_BASE_CODE;
	}

	return `
${RLM_BOOTSTRAP_BASE_CODE}

import importlib as _prime_agent_importlib
import inspect as _prime_agent_inspect
import sys as _prime_agent_sys
import types as _prime_agent_types

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
`.trim();
}

const ipythonSchema = Type.Object({
	code: Type.String({
		description:
			"Python scratchpad code or `%%bash` shell cells to execute in the agent kernel. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
	}),
});

// Cap for the streamed-output tail retained for backgrounded notices,
// mirroring the kernel's own retained-output cap.
const STREAMED_OUTPUT_MAX_CHARS = 65_536;

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
	status?: "ok" | "error" | "aborted" | "starting" | "backgrounded";
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
	/** Outcome of the stuck-cell recovery ladder, when it fired on this poll. */
	recovery?: KernelRecoveryResult | "no-kernel";
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
}

export interface IpythonToolOptions {
	/** Python override. Must have `ipykernel` installed. */
	python?: string;
	env?: Record<string, string>;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
	/** Optional explicit shell path for bare %%bash cells. */
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
	private startedManager?: KernelManager;
	private readonly startupListeners = new Set<KernelBootstrapProgressHandler>();
	private lastStartupMessage?: string;
	private _lastRestore?: RestoreResult;
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

	/** Whether a kernel has finished starting and is currently running. */
	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	/** Escalate a stuck execution through the recovery ladder (see kernel/recovery.ts). */
	async recoverStuckExecution(): Promise<KernelRecoveryResult | "no-kernel"> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		if (!m) return "no-kernel";
		return m.recoverStuckExecution();
	}

	/** Identity/output of the in-flight execution, for cross-call stuckness tracking. */
	get activeExecutionInfo(): { requestMsgId: string; outputChars: number } | undefined {
		return this.startedManager?.activeExecutionInfo;
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
		if (!pending) return;
		try {
			const m = await pending;
			await m.dispose();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	async kill(): Promise<void> {
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) {
			this.options.kernelManagerRef.current = undefined;
		}
		if (!pending) return;
		try {
			const m = await pending;
			await m.kill();
		} catch {
			// a failed startup already cleaned up after itself
		}
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

	private async startKernel(signal?: AbortSignal): Promise<KernelManager> {
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
			const m = new KernelManager({
				python: this.options?.python,
				cwd: this.cwd,
				env: this.options?.env,
				sessionId: this.options?.sessionId,
				hostHandlers: this.options?.hostHandlers,
				pythonSkills: this.options?.pythonSkills,
				// Only persistent sessions (which have an artifact dir) get a revivable snapshot.
				snapshot: snapshotDir
					? { path: snapshotPathIn(snapshotDir), manifestPath: manifestPathIn(snapshotDir) }
					: undefined,
			});
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
						pendingRestore = restore ?? { restored: [], failed: [], path: snapshotPathIn(snapshotDir) };
					}
				}
				this.emitStartupProgress("Preparing IPython runtime...");
				const bootstrap = await m.execute(buildRlmBootstrapCode(this.options?.pythonSkills), {
					signal: startupSignal,
				});
				if (bootstrap.status !== "ok") {
					const details = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize rlm runtime in the IPython kernel:\n${details}`);
				}
			} catch (error) {
				// Never leak the kernel's ZMQ sockets / temp dir if startup fails after spawn.
				void m.dispose();
				throw error;
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

function ipythonToolTimeoutMs(): number {
	const raw = process.env.PRIME_AGENT_IPYTHON_TOOL_TIMEOUT_MS;
	if (raw === undefined) {
		return 900_000;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 900_000;
}

/** Once a cell is backgrounded, follow-up calls queued behind it re-poll on a
 *  short budget instead of the full tool timeout, so stuckness is established
 *  (and recovery fires) in minutes, not multiples of the full timeout. */
function ipythonRepollTimeoutMs(): number {
	const raw = process.env.PRIME_AGENT_IPYTHON_REPOLL_TIMEOUT_MS;
	if (raw === undefined) {
		return 30_000;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

/** Silent backgrounded polls (no output growth) before the destructive
 *  recovery ladder fires on the stuck cell. */
function ipythonStuckCellPolls(): number {
	const raw = process.env.PRIME_AGENT_IPYTHON_STUCK_CELL_POLLS;
	if (raw === undefined) {
		return 3;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
}

/** Cross-call stuckness tracking for one provisioner's kernel: a cell counts
 *  as stuck only after N consecutive backgrounded polls with zero output
 *  growth. Output growth resets the count (slow-but-healthy cells are never
 *  fired upon). */
interface StuckTracker {
	requestMsgId?: string;
	outputChars: number;
	silentPolls: number;
}

function updateStuckTracker(
	tracker: StuckTracker,
	info: { requestMsgId: string; outputChars: number } | undefined,
): number {
	if (!info) {
		tracker.requestMsgId = undefined;
		tracker.silentPolls = 0;
		return 0;
	}
	if (tracker.requestMsgId !== info.requestMsgId) {
		tracker.requestMsgId = info.requestMsgId;
		tracker.outputChars = info.outputChars;
		tracker.silentPolls = 1;
		return 1;
	}
	if (info.outputChars > tracker.outputChars) {
		tracker.outputChars = info.outputChars;
		tracker.silentPolls = 0;
		return 0;
	}
	tracker.silentPolls += 1;
	return tracker.silentPolls;
}

function backgroundedNotice(
	timeoutMs: number,
	outputSoFar: string,
	recovery?: KernelRecoveryResult | "no-kernel",
	silentPolls?: number,
): string {
	const head =
		`Cell still executing after ${Math.round(timeoutMs / 1000)}s; it continues in the background. ` +
		"The kernel runs cells serially, so your next ipython call waits for this cell to finish " +
		"before it runs (and reports again if the cell is still going). Variables the cell assigns " +
		"stay in the kernel; after it finishes, inspect them with a cheap follow-up cell. " +
		"Long-running work should print progress; a cell that keeps running with no new output " +
		"across repeated polls is treated as stuck and automatically recovered.";
	const parts = [head];
	if (recovery && recovery !== "no-kernel") {
		if (recovery.outcome === "recovered") {
			parts.push(
				`The stuck cell was just auto-recovered (${recovery.weapon}); it ends with an interrupt/cancel ` +
					"error, variables assigned before the hang remain, and your queued cell should run now — " +
					"issue a follow-up call to see its result.",
			);
		} else if (recovery.outcome === "recovery-lane-only") {
			parts.push(
				"Auto-recovery could not stop the stuck cell (it swallows interrupts), but the kernel is " +
					"otherwise healthy. Follow-up calls keep queueing behind it; if this persists the kernel " +
					"will need a restart to regain the main lane.",
			);
		} else if (recovery.outcome === "kernel-unresponsive" || recovery.outcome === "kernel-wedged") {
			parts.push(
				"Warning: the kernel did not respond to recovery probes — it is likely wedged " +
					"(e.g. a C extension holding the GIL) and will be restarted.",
			);
		}
	} else if (silentPolls !== undefined && silentPolls > 0) {
		parts.push(
			`No new output for ${silentPolls} consecutive poll(s); automatic recovery fires after ` +
				`${ipythonStuckCellPolls()} silent polls.`,
		);
	}
	if (outputSoFar) parts.push(`Output so far:\n${outputSoFar}`);
	return parts.join("\n\n");
}

const WEDGED_KERNEL_RESTART_NOTICE =
	"A previous cell was stuck and the kernel was unresponsive to recovery probes, so the IPython " +
	"kernel was killed; a fresh kernel starts on the next call. Variables, imports, async tasks, and " +
	"open resources are gone; recreate what you need, then resubmit this cell.";

const BACKGROUNDED = Symbol("ipython-backgrounded");

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
	// One tracker per tool definition (= per kernel): counts silent backgrounded
	// polls so destructive recovery only fires on established stuckness.
	const stuckTracker: StuckTracker = { outputChars: 0, silentPolls: 0 };

	return {
		name: "ipython",
		label: "ipython",
		description:
			"Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed (objects that cannot be serialized are dropped and reported). Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
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
				// Only surfaced in the backgrounded notice, so keep the most recent
				// tail; unbounded accumulation from a verbose long-running cell would
				// grow host memory for the life of the call.
				let streamedOutput = "";
				const executePromise = executeWithBusyKernelChoice(
					provisioner,
					reportStartupProgress,
					toolCallId,
					code,
					signal,
					(chunk) => {
						streamedOutput = (streamedOutput + chunk).slice(-STREAMED_OUTPUT_MAX_CHARS);
						onUpdate?.({
							content: [{ type: "text", text: chunk }],
							details: { status: "ok" },
						});
					},
					setToolWorkingMessage,
					options?.onLateSentAgentMessage,
					ctx,
				);
				// Adaptive budget: a call queued behind a backgrounded cell re-polls on a
				// short budget instead of the full tool timeout, so stuckness is
				// established (and recovery fires) in minutes rather than multiples of
				// the full timeout.
				const fullTimeoutMs = ipythonToolTimeoutMs();
				const timeoutMs =
					fullTimeoutMs > 0 && stuckTracker.requestMsgId !== undefined
						? Math.min(fullTimeoutMs, ipythonRepollTimeoutMs())
						: fullTimeoutMs;
				let raced: Awaited<typeof executePromise> | typeof BACKGROUNDED;
				if (timeoutMs > 0) {
					let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
					const timeout = new Promise<typeof BACKGROUNDED>((resolve) => {
						timer = globalThis.setTimeout(() => resolve(BACKGROUNDED), timeoutMs);
						if (timer && typeof timer === "object" && "unref" in timer) {
							timer.unref();
						}
					});
					raced = await Promise.race([executePromise, timeout]);
					if (timer) {
						globalThis.clearTimeout(timer);
					}
				} else {
					raced = await executePromise;
				}
				if (raced === BACKGROUNDED) {
					// The cell keeps running; the kernel's serial queue makes the next
					// ipython call wait behind it, which doubles as the poll mechanism.
					// Late completion is intentionally not delivered as a message — the
					// kernel namespace carries the results forward.
					executePromise.catch(() => undefined);
					// Phase 1 (safe): count this poll against the in-flight execution.
					// Output growth resets the count, so slow-but-healthy cells are
					// never fired upon.
					const silentPolls = updateStuckTracker(stuckTracker, provisioner.activeExecutionInfo);
					// Phase 2 (destructive, gated): stuckness established -> escalate
					// through the recovery ladder (interrupt -> task-cancel -> gated
					// async-exc; see kernel/recovery.ts).
					let recovery: KernelRecoveryResult | "no-kernel" | undefined;
					if (silentPolls >= ipythonStuckCellPolls()) {
						recovery = await provisioner.recoverStuckExecution().catch(() => "no-kernel" as const);
						if (recovery !== "no-kernel" && recovery.outcome === "recovered") {
							// Recovery may let this call's own execute settle; prefer the
							// real result over a "still executing" notice.
							const settled = await Promise.race([
								executePromise,
								new Promise<typeof BACKGROUNDED>((resolve) => {
									const settleTimer = globalThis.setTimeout(() => resolve(BACKGROUNDED), 3000);
									if (settleTimer && typeof settleTimer === "object" && "unref" in settleTimer) {
										settleTimer.unref();
									}
								}),
							]);
							if (settled !== BACKGROUNDED) {
								raced = settled;
							}
						} else if (
							recovery !== "no-kernel" &&
							recovery !== undefined &&
							(recovery.outcome === "kernel-unresponsive" || recovery.outcome === "kernel-wedged")
						) {
							// Provably unrecoverable: restart so the session regains a
							// working kernel instead of stalling until the rollout dies.
							setToolWorkingMessage("Restarting IPython kernel...");
							await provisioner.kill();
							stuckTracker.requestMsgId = undefined;
							stuckTracker.silentPolls = 0;
							return {
								content: [{ type: "text", text: WEDGED_KERNEL_RESTART_NOTICE }],
								details: {
									status: "backgrounded",
									stdout: streamedOutput,
									recovery,
									kernelRestarted: true,
								},
								isError: false,
							};
						}
					}
					if (raced === BACKGROUNDED) {
						// Re-seed if the in-flight execution changed during this call
						// (a recovery drained the queue and this call's own cell is now
						// running): the next call must keep the short re-poll cadence.
						// Same-execution polls were already counted at entry — updating
						// again here would double-count them.
						const liveInfo = provisioner.activeExecutionInfo;
						if (liveInfo && liveInfo.requestMsgId !== stuckTracker.requestMsgId) {
							updateStuckTracker(stuckTracker, liveInfo);
						}
						return {
							content: [
								{ type: "text", text: backgroundedNotice(timeoutMs, streamedOutput, recovery, silentPolls) },
							],
							details: { status: "backgrounded", stdout: streamedOutput, recovery },
							isError: false,
						};
					}
				}
				const { result: r, kernelRestarted } = raced;
				// A real result means nothing is backgrounded anymore: reset stuckness
				// tracking so later independent calls get the full timeout again
				// instead of the short re-poll budget.
				stuckTracker.requestMsgId = undefined;
				stuckTracker.silentPolls = 0;

				let text = r.stdout;
				if (r.stderr) text += (text ? "\n" : "") + r.stderr;
				if (r.result) text += (text ? "\n" : "") + r.result;
				if (r.status === "error" && r.error) {
					text += (text ? "\n" : "") + r.error.traceback.join("\n");
				}
				if (kernelRestarted) {
					text = text ? `${KERNEL_RESTART_NOTICE}\n\n${text}` : KERNEL_RESTART_NOTICE;
				}

				const imageBlocks = imageBlocksFromAttachments(r.attachments);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: text || "" }, ...imageBlocks];

				return {
					content,
					details: {
						durationMs: r.durationMs,
						status: r.status,
						errorEname: r.error?.ename,
						stdout: r.stdout,
						stderr: r.stderr,
						result: r.result,
						diffs: r.diffs,
						attachments: r.attachments,
						sentAgentMessages: r.sentAgentMessages,
						kernelRestarted,
						error: r.error,
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
