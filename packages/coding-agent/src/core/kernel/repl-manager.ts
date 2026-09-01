// Kernel client for the REPL runtime: the kernel is a JSON-lines subprocess
// (`python -m rlm.repl`) — requests on stdin, events on stdout, stderr kept as
// a diagnostics tail. The protocol is documented in prime-agent-runtime/src/rlm/repl.md.
import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { v4 as uuid } from "uuid";
import { reapKernelOrphanProcesses, recordOrphanProcessState } from "../orphan-process-journal.js";
import { ensureKernelPython } from "./bootstrap.js";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	ATTACHMENT_DISPLAY_MIME,
	createDeferred,
	createKernelStartupAbortError,
	DEFAULT_MAX_OUTPUT_CHARS,
	DEFAULT_SNAPSHOT_DEBOUNCE_MS,
	DIFF_DISPLAY_MIME,
	type ExecuteOptions,
	type ExecuteResult,
	errorMessage,
	HOST_REQUEST_SHUTDOWN_TIMEOUT_MS,
	installSignalHandlersOnce,
	isRecord,
	KERNEL_ABORT_GRACE_MS,
	KERNEL_BUSY_INTERRUPT_INTERVAL_MS,
	KERNEL_BUSY_REUSE_WAIT_MS,
	KERNEL_SHUTDOWN_TIMEOUT_MS,
	type KernelAttachment,
	KernelBusyAfterInterruptError,
	type KernelDiffDisplay,
	type KernelManagerOptions,
	type KernelSentAgentMessage,
	type KernelShutdownOptions,
	type KernelStartOptions,
	liveKernels,
	MAX_ATTACHMENT_DATA_CHARS,
	MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS,
	parseAttachmentDisplay,
	parseDiffDisplay,
	parseSentAgentMessage,
	raceStartupWithAbort,
	SNAPSHOT_EXECUTION_TIMEOUT_MS,
} from "./shared.js";
import {
	DEFAULT_SNAPSHOT_MAX_BYTES,
	DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
	type RestoreResult,
	type SnapshotResult,
} from "./state-snapshot.js";

const REPL_PROTOCOL_VERSION = 3;
const READY_TIMEOUT_MS = 30_000;
const REPAIR_STEP_TIMEOUT_MS = 30_000;
// Runtime-minted host-request ids never repeat; the bound only guards a
// misbehaving runtime from growing the dedup set forever.
const MAX_HANDLED_HOST_REQUEST_IDS = 1024;
// Cap for unattributed background output buffered between and during cells.
const MAX_BACKGROUND_OUTPUT_CHARS = 64 * 1024;

/** ExecuteResult plus the raw fields of the request's `done` event (state ops). */
interface InternalExecuteResult extends ExecuteResult {
	doneFields?: Record<string, unknown>;
}

interface ActiveExecution {
	requestId: string;
	/** Source of the cell currently executing; surfaced to rlm.run spawns. */
	code: string;
	started: number;
	maxChars: number;
	opts: ExecuteOptions;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	result?: string;
	diffs: KernelDiffDisplay[];
	attachments: KernelAttachment[];
	sentAgentMessages: KernelSentAgentMessage[];
	/** Stream text without this execution's id: user threads, other cells' leftovers, raw fd writes. */
	backgroundOutput: string;
	backgroundOutputTruncated: boolean;
	error?: ExecuteResult["error"];
	status: ExecuteResult["status"];
	doneFields?: Record<string, unknown>;
	settled: boolean;
	resolve: (result: InternalExecuteResult) => void;
	reject: (error: Error) => void;
}

// Complete event vocabulary of protocol version 2 (see prime-agent-runtime/src/rlm/repl.md).
// The version handshake is exact, so an unknown kind is corruption, not a newer runtime.
const PROTOCOL_EVENT_KINDS = new Set([
	"ready",
	"stdout",
	"stderr",
	"result",
	"display",
	"host_request",
	"error",
	"done",
]);

/**
 * Reason a JSON object still isn't a valid protocol frame, or undefined.
 * `done` and `host_request` route strictly by non-empty string id (the runtime
 * mints uuid hex ids and echoes the host's uuids); silently dropping an id-less
 * one would leave the awaiting request unsettled forever.
 */
function invalidProtocolFrameReason(event: Record<string, unknown>): string | undefined {
	if (typeof event.event !== "string" || !PROTOCOL_EVENT_KINDS.has(event.event)) {
		return "unknown protocol event";
	}
	if (
		(event.event === "done" || event.event === "host_request") &&
		(typeof event.id !== "string" || event.id === "")
	) {
		return `${event.event} frame without id`;
	}
	return undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asReasonArray(value: unknown): { name: string; reason: string }[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (isRecord(entry) && typeof entry.name === "string") {
			return [{ name: entry.name, reason: typeof entry.reason === "string" ? entry.reason : "" }];
		}
		return [];
	});
}

export class ReplKernelManager {
	private readonly options: Pick<
		KernelManagerOptions,
		"python" | "cwd" | "env" | "sessionId" | "hostHandlers" | "pythonSkills" | "snapshot" | "bootstrapCode"
	>;
	private readonly handledHostRequestIds = new Set<string>();
	private child?: ChildProcess;
	private readyDeferred?: ReturnType<typeof createDeferred<number>>;
	private kernelStderr = "";
	/** Serializes execute() calls — the runtime runs one request at a time. */
	private executionQueue: Promise<unknown> = Promise.resolve();
	private activeExecution?: ActiveExecution;
	private readonly activeExecutionIdleWaiters = new Set<() => void>();
	private readonly lateSentAgentMessageHandlers = new Map<string, (message: KernelSentAgentMessage) => void>();
	/** Resolvers for done events outside the active execution (the shutdown reply). */
	private readonly pendingDoneWaiters = new Map<string, () => void>();
	// Source of the most recently started cell, retained after it finishes so
	// rlm.run spawns from detached asyncio tasks (cell already idle) can still
	// attribute their spawning program.
	private lastCellCode?: string;
	/** Unattributed stream text that arrived between cells; surfaced on the next execution. */
	private pendingBackgroundOutput = "";
	private pendingBackgroundOutputTruncated = false;
	private readonly inFlightHostRequests = new Set<Promise<void>>();
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	/** Bumped by every teardown so a stale in-flight doStart can never touch a newer kernel. */
	private startGeneration = 0;
	/** Generation whose graceful shutdown() owns the teardown, so the exit handler must not run it. */
	private gracefulShutdownGeneration?: number;
	private gracefulShutdownPromise?: Promise<boolean>;
	/** Memoized so concurrent callers all await the same in-flight startup. */
	private startPromise?: Promise<void>;
	/** Pending debounced auto-snapshot, if one has been scheduled. */
	private snapshotTimer?: ReturnType<typeof globalThis.setTimeout>;
	/** While the final dispose snapshot is flushing, new external executions are rejected. */
	private flushingSnapshotForDispose = false;
	/** In-flight final snapshot flush; concurrent teardowns join it instead of re-flushing. */
	private snapshotFlushForDispose?: Promise<void>;
	/** Repairs a child whose dedicated protocol stream emitted an invalid frame. */
	private protocolRepairPromise?: Promise<void>;
	private protocolRepairOwner?: { superseded: boolean };
	/** Corruption seen while still "starting" (e.g. ready and garbage in one chunk) fails that start. */
	private startupProtocolError?: Error;
	/** A repair discarded its kernel: the next fresh start must re-run the runtime bootstrap. */
	private pendingRebootstrap = false;
	/** Restore the saved namespace on that fresh start too (false when the snapshot itself is the declared culprit). */
	private pendingRestore = false;
	private rebootstrapPromise?: Promise<boolean>;
	private teardownInFlight = 0;

	constructor(options: KernelManagerOptions) {
		this.options = {
			python: options.python,
			cwd: options.cwd,
			env: options.env,
			sessionId: options.sessionId,
			hostHandlers: options.hostHandlers,
			pythonSkills: options.pythonSkills,
			snapshot: options.snapshot,
			bootstrapCode: options.bootstrapCode,
		};
	}

	get ownerSessionId(): string | undefined {
		return this.options.sessionId;
	}

	private appendKernelDiagnostic(message: string): void {
		this.kernelStderr += `[kernel] ${message.endsWith("\n") ? message : `${message}\n`}`;
	}

	async start(options: KernelStartOptions = {}): Promise<void> {
		if (options.signal?.aborted) {
			throw createKernelStartupAbortError();
		}
		if (!this.startPromise) {
			const startPromise = this.doStart({ onBootstrapProgress: options.onBootstrapProgress }).catch((error) => {
				// Only clear our own memoization: a stale start must not evict a newer one.
				if (this.startPromise === startPromise) this.startPromise = undefined;
				throw error;
			});
			this.startPromise = startPromise;
		}
		return raceStartupWithAbort(this.startPromise, options.signal);
	}

	private async doStart(startOptions: KernelStartOptions): Promise<void> {
		if (this.state !== "idle") return;
		const generation = ++this.startGeneration;
		this.state = "starting";
		installSignalHandlersOnce();
		// Tracked from the moment startup begins so session cleanup and signal
		// handlers can dispose a kernel that is still booting.
		liveKernels.add(this);

		let python: string;
		try {
			python =
				this.options.python ??
				(await ensureKernelPython({
					pythonSkills: this.options.pythonSkills,
					onProgress: startOptions.onBootstrapProgress,
				}));
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
			this.options.python = python;
		} catch (error) {
			if (this.startStale(generation)) throw error; // never touch a newer start's state
			liveKernels.delete(this);
			if ((this.state as string) !== "shutdown") this.state = "idle";
			throw error;
		}

		if ((this.state as string) === "shutdown") {
			throw new Error("Kernel was disposed during startup");
		}

		const child = spawn(python, ["-m", "rlm.repl"], {
			cwd: this.options.cwd,
			// bash.py journals its process groups under this pid so the host can
			// reap them if the runtime dies without running its shutdown hook.
			env: {
				...process.env,
				...this.options.env,
				PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		if (child.pid !== undefined) recordOrphanProcessState(child.pid, true);
		this.readyDeferred = createDeferred<number>();
		this.startupProtocolError = undefined;
		this.wireChild(child);

		try {
			const protocol = await this.waitForReady(child);
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
			// Ready and a corrupt frame can share one stdout chunk: ready resolved the
			// deferred synchronously before the corruption was parsed, so the rejection
			// in failProtocolFrame was a no-op. Never mark such a child running.
			if (this.startupProtocolError) throw this.startupProtocolError;
			if (protocol !== REPL_PROTOCOL_VERSION) {
				throw new Error(
					`Kernel runtime speaks protocol ${protocol}, expected ${REPL_PROTOCOL_VERSION}. ` +
						"Update prime-agent-runtime in the kernel Python (PRIME_AGENT_KERNEL_PYTHON) to match this prime-agent.",
				);
			}
		} catch (e) {
			if (this.startStale(generation)) throw e; // never tear down a newer start's kernel
			const canRetryStartup = (this.state as string) !== "shutdown";
			// Only the call that performed the cleanup may resurrect to idle; a
			// concurrent kill()/teardown owns the state otherwise.
			if ((await this.shutdown()) && canRetryStartup) this.state = "idle";
			throw e;
		}

		this.state = "running";
	}

	/** True when a teardown (or newer start) superseded the start that captured `generation`. */
	private startStale(generation: number): boolean {
		return generation !== this.startGeneration;
	}

	private wireChild(child: ChildProcess): void {
		const decoder = new StringDecoder("utf8");
		let buffered = "";
		child.stdout?.on("data", (buf: Buffer) => {
			if (this.child !== child) return;
			buffered += decoder.write(buf);
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				if (!line.trim()) continue;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					this.failProtocolFrame(child, `unparseable protocol line: ${line.slice(0, 200)}`);
					return;
				}
				if (!isRecord(event)) {
					this.failProtocolFrame(child, `non-object protocol line: ${line.slice(0, 200)}`);
					return;
				}
				const invalidReason = invalidProtocolFrameReason(event);
				if (invalidReason) {
					this.failProtocolFrame(child, `${invalidReason}: ${line.slice(0, 200)}`);
					return;
				}
				this.handleEvent(event);
			}
		});

		child.stderr?.on("data", (buf: Buffer) => {
			this.kernelStderr += buf.toString();
		});

		child.on("error", (err) => {
			if (this.child !== child) return;
			this.appendKernelDiagnostic(`spawn error: ${err.message}`);
			this.state = "shutdown";
			liveKernels.delete(this);
			// Fail a pending start() promptly instead of letting it ride out the
			// ready timeout. cleanupResources clears readyDeferred, so reject first;
			// a late error after ready resolved is a no-op on the settled promise.
			this.readyDeferred?.reject(err);
			this.cleanupResources();
		});

		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			if (this.state !== "shutdown") {
				this.appendKernelDiagnostic(`unexpected exit code=${code} signal=${signal}`);
			}
			this.state = "shutdown";
			liveKernels.delete(this);
			// This exit is part of an in-flight graceful shutdown(): that call owns the
			// teardown and runs cleanupResources itself. Cleaning up here would bump the
			// generation and misread the owning shutdown as superseded.
			if (this.gracefulShutdownGeneration === this.startGeneration) return;
			this.cleanupResources();
		});
	}

	private failProtocolFrame(child: ChildProcess, diagnostic: string): void {
		if (this.child !== child) return;
		this.appendKernelDiagnostic(diagnostic);
		const error = new Error(`Kernel protocol error: ${diagnostic}`);
		if (this.state === "starting") this.startupProtocolError = error;
		this.readyDeferred?.reject(error);
		this.rejectActiveExecution(error);
		if (this.teardownInFlight > 0 || this.state !== "running") return;

		if (this.protocolRepairOwner) {
			// A repair's own replacement child corrupted: discard it instead of respawn-looping.
			this.appendKernelDiagnostic("replacement kernel corrupted during protocol repair; giving up");
			this.protocolRepairOwner.superseded = true;
			// performRestore clears pendingRestore, so it still being set means the
			// corruption struck at or before the restore phase: the snapshot stays
			// the prime suspect (ambiguous attribution, loop-safe — retrying it
			// would re-trigger the corruption). Corruption strictly after a
			// successful restore never implicates the snapshot; keeping the flag
			// costs at most one bounded restore per later attempt.
			const snapshotSuspect = this.pendingRestore;
			this.killChildToIdle();
			if (snapshotSuspect) this.pendingRestore = false;
			return;
		}
		const owner = { superseded: false };
		this.protocolRepairOwner = owner;
		const repair = this.repairProtocolChild(child, owner);
		this.protocolRepairPromise = repair;
		void repair.then(
			() => {
				if (this.protocolRepairPromise === repair) this.protocolRepairPromise = undefined;
				if (this.protocolRepairOwner === owner) this.protocolRepairOwner = undefined;
			},
			(repairError) => {
				this.appendKernelDiagnostic(`protocol repair failed: ${errorMessage(repairError)}`);
				if (this.protocolRepairPromise === repair) this.protocolRepairPromise = undefined;
				if (this.protocolRepairOwner === owner) this.protocolRepairOwner = undefined;
			},
		);
	}

	private async repairProtocolChild(child: ChildProcess, owner: { superseded: boolean }): Promise<void> {
		if (this.child !== child || this.state === "shutdown") return;
		this.killChildToIdle();

		const start = this.start();
		const generation = this.startGeneration;
		try {
			await start;
		} catch (error) {
			this.finishFailedProtocolRepair(owner, error);
			return;
		}
		if (this.startStale(generation) || (this.state as string) !== "running") {
			this.finishFailedProtocolRepair(owner);
			return;
		}

		const restored = await this.performRestore(true);
		if (this.startStale(generation) || (this.state as string) !== "running") {
			this.finishFailedProtocolRepair(owner);
			return;
		}
		if (this.options.snapshot && restored === null) {
			if (owner.superseded || this.protocolRepairOwner !== owner) return;
			this.appendKernelDiagnostic("protocol repair restore failed; discarding replacement kernel");
			this.killChildToIdle();
			// The snapshot is the declared culprit; the lazy path must not retry it.
			this.pendingRestore = false;
			return;
		}

		// Restore revives only the user namespace; live handles (rlm, bash, skills)
		// come from the runtime bootstrap, so a repaired kernel must re-run it.
		if (!this.options.bootstrapCode) return;
		const bootstrapped = await this.bootstrapRepairedKernel(this.options.bootstrapCode);
		if (this.startStale(generation) || (this.state as string) !== "running") {
			this.finishFailedProtocolRepair(owner);
			return;
		}
		if (!bootstrapped) {
			if (owner.superseded || this.protocolRepairOwner !== owner) return;
			this.appendKernelDiagnostic("protocol repair bootstrap failed; discarding replacement kernel");
			this.killChildToIdle();
		}
	}

	/** Bounded bootstrap of a repaired kernel; false when it failed. Never throws. */
	private async bootstrapRepairedKernel(code: string): Promise<boolean> {
		try {
			const r = await this.enqueueRequest(
				{ type: "execute", code },
				code,
				{ internal: true, protocolRepair: true },
				REPAIR_STEP_TIMEOUT_MS,
			);
			if (r.status !== "ok") {
				this.appendKernelDiagnostic(
					`protocol repair bootstrap ${r.status === "aborted" ? "timed out" : "failed"}: ${r.error?.evalue ?? r.stderr}`,
				);
				return false;
			}
			this.pendingRebootstrap = false;
			return true;
		} catch (error) {
			this.appendKernelDiagnostic(`protocol repair bootstrap error: ${errorMessage(error)}`);
			return false;
		}
	}

	/**
	 * A fresh kernel started after a discarded repair has none of the runtime
	 * bootstrap's live handles (rlm, bash, skills) and an empty namespace:
	 * reprovision (restore, then bootstrap) before any user request. A failed
	 * re-bootstrap discards the kernel again instead of serving user code on an
	 * unprovisioned namespace.
	 */
	private async ensureKernelRebootstrapped(signal?: AbortSignal): Promise<void> {
		const code = this.options.bootstrapCode;
		const needsRestore = Boolean(this.options.snapshot) && this.pendingRestore;
		const needsBootstrap = Boolean(code) && this.pendingRebootstrap;
		// An in-flight repair owns its kernel's restore/bootstrap sequence, and
		// a teardown's final snapshot must never trigger reprovisioning.
		if (
			(!needsRestore && !needsBootstrap) ||
			this.protocolRepairPromise ||
			this.teardownInFlight > 0 ||
			this.state !== "running"
		) {
			return;
		}
		let task = this.rebootstrapPromise;
		if (!task) {
			const started = this.reprovisionFreshKernel(code);
			task = started;
			this.rebootstrapPromise = started;
			void started.finally(() => {
				if (this.rebootstrapPromise === started) this.rebootstrapPromise = undefined;
			});
		}
		// An aborted request never executes, so it may skip the wait; race the
		// signal like waitForProtocolRepair does instead of riding out the
		// bootstrap bound after a mid-wait abort.
		if (signal) {
			if (signal.aborted) return;
			let onAbort: () => void = () => {};
			const aborted = new Promise<void>((resolve) => {
				onAbort = resolve;
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				await Promise.race([task, aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
			if (signal.aborted) return;
		}
		const ok = await task; // bounded by REPAIR_STEP_TIMEOUT_MS
		if (!ok) throw new Error("Kernel bootstrap failed after protocol repair");
	}

	/** Restore (one-shot, best-effort) then bootstrap the lazily started fresh kernel. */
	private async reprovisionFreshKernel(code: string | undefined): Promise<boolean> {
		if (this.options.snapshot && this.pendingRestore) {
			await this.performRestore(true); // clears pendingRestore on success
			// Corrupted during the restore: the spawned repair owns the kernel now.
			if (this.protocolRepairPromise || this.state !== "running") return false;
			// One attempt per discard: a clean restore failure falls back to an
			// empty namespace (ordinary startup semantics), never a retry loop.
			this.pendingRestore = false;
		}
		if (!code || !this.pendingRebootstrap) return true;
		const ok = await this.bootstrapRepairedKernel(code);
		if (!ok && this.state === "running") this.killChildToIdle();
		return ok;
	}

	/** Kill the current child and settle at clean idle, so the next start spawns fresh. */
	private killChildToIdle(): void {
		// The discarded kernel carried the runtime bootstrap and (possibly) the
		// restored namespace; a lazily started replacement must reprovision both.
		this.pendingRebootstrap = true;
		this.pendingRestore = true;
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources("SIGKILL");
		this.state = "idle";
	}

	private finishFailedProtocolRepair(owner: { superseded: boolean }, error?: unknown): void {
		if (error) this.appendKernelDiagnostic(`protocol repair start failed: ${errorMessage(error)}`);
		if (owner.superseded || this.protocolRepairOwner !== owner) return;
		if (this.state === "shutdown") this.state = "idle";
	}

	private supersedeProtocolRepair(): void {
		if (this.protocolRepairOwner) this.protocolRepairOwner.superseded = true;
	}

	/** Wait until no protocol repair is pending; resolves early when the signal aborts. */
	private async waitForProtocolRepair(signal?: AbortSignal): Promise<void> {
		while (this.protocolRepairPromise && !signal?.aborted) {
			const repair = this.protocolRepairPromise;
			if (!signal) {
				await repair;
				continue;
			}
			let onAbort: () => void = () => {};
			const aborted = new Promise<void>((resolve) => {
				onAbort = resolve;
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				await Promise.race([repair, aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	private async waitForReady(child: ChildProcess): Promise<number> {
		const ready = this.readyDeferred;
		if (!ready) throw new Error("Kernel ready state is missing");
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		let onExit: (() => void) | undefined;
		try {
			return await new Promise<number>((resolve, reject) => {
				ready.promise.then(resolve, reject);
				onExit = () => {
					const tail = this.kernelStderr.slice(-1024);
					reject(new Error(`Kernel exited before ready. stderr:\n${tail || "(empty)"}`));
				};
				if (child.exitCode !== null || child.signalCode !== null) {
					onExit();
					return;
				}
				child.once("exit", onExit);
				timeout = globalThis.setTimeout(() => {
					const tail = this.kernelStderr.slice(-1024);
					reject(
						new Error(
							`Kernel did not become ready within ${READY_TIMEOUT_MS}ms. stderr tail:\n${tail || "(empty)"}`,
						),
					);
				}, READY_TIMEOUT_MS);
				timeout.unref?.();
			});
		} finally {
			if (timeout) globalThis.clearTimeout(timeout);
			if (onExit) child.removeListener("exit", onExit);
		}
	}

	/** Write one JSON-lines request frame; resolves when the OS accepted the bytes. */
	private writeLine(request: Record<string, unknown>): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed) {
			return Promise.reject(new Error("Kernel stdin is not connected"));
		}
		return new Promise<void>((resolve, reject) => {
			stdin.write(`${JSON.stringify(request)}\n`, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	private handleEvent(event: Record<string, unknown>): void {
		const type = event.event;
		if (type === "ready") {
			this.readyDeferred?.resolve(typeof event.protocol === "number" ? event.protocol : -1);
			return;
		}
		if (type === "host_request") {
			if (typeof event.id === "string") this.startHostRequest(event.id, event.data);
			return;
		}

		const id = typeof event.id === "string" ? event.id : undefined;
		const execution = this.activeExecution;
		if (!execution || id !== execution.requestId) {
			if (type === "display" && isRecord(event.data)) {
				this.dispatchLateSentAgentMessage(id, event.data[AGENT_MESSAGE_DISPLAY_MIME]);
			} else if (type === "stdout" || type === "stderr") {
				// Unowned output (null id, or another cell's id): never merge it into
				// the active cell's streams; buffer it as background output instead.
				this.appendBackgroundOutput(typeof event.text === "string" ? event.text : "");
			} else if (type === "done" && id) {
				const waiter = this.pendingDoneWaiters.get(id);
				this.pendingDoneWaiters.delete(id);
				waiter?.();
			} else if (type === "error" && id === undefined) {
				this.appendKernelDiagnostic(`protocol error: ${String(event.evalue ?? "")}`);
			}
			return;
		}

		if (execution.settled && type === "display" && isRecord(event.data)) {
			if (this.dispatchLateSentAgentMessage(id, event.data[AGENT_MESSAGE_DISPLAY_MIME])) {
				return;
			}
		}
		if (type === "stdout" || type === "stderr") {
			const text = typeof event.text === "string" ? event.text : "";
			if (type === "stdout") {
				if (execution.stdout.length < execution.maxChars) {
					execution.stdout += text;
					if (execution.stdout.length > execution.maxChars) {
						execution.stdout = execution.stdout.slice(0, execution.maxChars);
						execution.stdoutTruncated = true;
					}
				}
			} else {
				if (execution.stderr.length < execution.maxChars) {
					execution.stderr += text;
					if (execution.stderr.length > execution.maxChars) {
						execution.stderr = execution.stderr.slice(0, execution.maxChars);
						execution.stderrTruncated = true;
					}
				}
			}
			execution.opts.onStream?.(text, type);
		} else if (type === "result") {
			if (typeof event.text === "string") execution.result = event.text;
		} else if (type === "display") {
			const data = isRecord(event.data) ? event.data : {};
			const diff = parseDiffDisplay(data[DIFF_DISPLAY_MIME]);
			if (diff) execution.diffs.push(diff);
			const attachment = parseAttachmentDisplay(data[ATTACHMENT_DISPLAY_MIME]);
			if (attachment === "oversized") {
				execution.stderr += `${execution.stderr ? "\n" : ""}attachment dropped: exceeds ${MAX_ATTACHMENT_DATA_CHARS} base64 chars`;
				execution.status = "error";
			} else if (attachment) {
				execution.attachments.push(attachment);
			}
			const sentAgentMessage = parseSentAgentMessage(data[AGENT_MESSAGE_DISPLAY_MIME]);
			if (sentAgentMessage) execution.sentAgentMessages.push(sentAgentMessage);
		} else if (type === "error") {
			execution.error = {
				ename: typeof event.ename === "string" ? event.ename : "Error",
				evalue: typeof event.evalue === "string" ? event.evalue : "",
				traceback: asStringArray(event.traceback),
			};
			execution.status = "error";
		} else if (type === "done") {
			execution.doneFields = event;
			if (event.status !== "ok" && execution.status === "ok") {
				execution.status = "error";
				// State requests report failures as a done reason without an error event.
				if (!execution.error && typeof event.reason === "string") {
					execution.error = { ename: "KernelError", evalue: event.reason, traceback: [] };
				}
			}
			this.finishActiveExecution(execution);
		}
	}

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		await this.waitForProtocolRepair(opts.signal);
		const result = await this.enqueueExecute(code, opts);
		// Refresh the on-disk snapshot after real work so a later resume (or a
		// crash before graceful shutdown) revives the most recent namespace.
		if (result.status === "ok") {
			this.scheduleSnapshot();
		}
		return result;
	}

	/** Queue and run a cell, serializing against all other executions. */
	private async enqueueExecute(
		code: string,
		opts: ExecuteOptions,
		executionTimeoutMs?: number,
	): Promise<InternalExecuteResult> {
		return this.enqueueRequest({ type: "execute", code }, code, opts, executionTimeoutMs);
	}

	/** Queue one protocol request (execute or state op) behind every other request. */
	private async enqueueRequest(
		requestFields: Record<string, unknown> & { type: string },
		code: string,
		opts: ExecuteOptions,
		executionTimeoutMs?: number,
	): Promise<InternalExecuteResult> {
		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
		}
		await this.start({ signal: opts.signal });
		if ((this.state as string) === "shutdown") {
			throw new Error("Kernel has been shut down");
		}
		if (this.flushingSnapshotForDispose && !opts.internal) {
			throw new Error("Kernel is shutting down");
		}
		if (!opts.protocolRepair) await this.ensureKernelRebootstrapped(opts.signal);
		// Aborted while waiting on the re-bootstrap: settle now instead of parking
		// on the queue slot behind the still-running bootstrap.
		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
		}
		// Re-check: a final flush may have started while this request awaited the
		// lazy re-bootstrap; admitting it now would splice it between the flush's
		// captured queue and the final snapshot, unbounding the teardown.
		if (this.flushingSnapshotForDispose && !opts.internal) {
			throw new Error("Kernel is shutting down");
		}

		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		const started = Date.now();
		let executionTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		try {
			await this.waitForActiveExecutionToClearForReuse(opts.signal);
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
			}
			if ((this.state as string) === "shutdown") {
				throw new Error("Kernel has been shut down");
			}
			// A repair started while this request was queued or busy-waiting: release
			// the slot so the repair's own restore can run, then requeue behind it.
			if (this.protocolRepairPromise && !opts.protocolRepair) {
				resolveNext();
				await this.waitForProtocolRepair(opts.signal);
				return this.enqueueRequest(requestFields, code, opts, executionTimeoutMs);
			}
			if (executionTimeoutMs === undefined) {
				return await this.executeInner(requestFields, code, opts, started);
			}

			const controller = new AbortController();
			executionTimeout = globalThis.setTimeout(() => controller.abort(), executionTimeoutMs);
			executionTimeout.unref?.();
			const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
			return await this.executeInner(requestFields, code, { ...opts, signal }, started);
		} finally {
			if (executionTimeout) globalThis.clearTimeout(executionTimeout);
			resolveNext();
		}
	}

	private async executeInner(
		requestFields: Record<string, unknown> & { type: string },
		code: string,
		opts: ExecuteOptions,
		started: number,
	): Promise<InternalExecuteResult> {
		const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
		const requestId = uuid();

		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
		}
		if (this.activeExecution) {
			throw new Error("Kernel already has an active execution");
		}

		const result = createDeferred<InternalExecuteResult>();
		const execution: ActiveExecution = {
			requestId,
			code,
			started,
			maxChars,
			opts,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			diffs: [],
			attachments: [],
			sentAgentMessages: [],
			backgroundOutput: this.pendingBackgroundOutput,
			backgroundOutputTruncated: this.pendingBackgroundOutputTruncated,
			status: "ok",
			settled: false,
			resolve: result.resolve,
			reject: result.reject,
		};
		this.pendingBackgroundOutput = "";
		this.pendingBackgroundOutputTruncated = false;
		let abortTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
		const clearAbortTimer = () => {
			if (abortTimer) {
				globalThis.clearTimeout(abortTimer);
				abortTimer = undefined;
			}
		};
		const forceAbort = () => {
			if (this.activeExecution !== execution) {
				return;
			}
			execution.status = "aborted";
			// The execution stays active until its done event arrives; clearing it
			// early would let a new cell race the interrupted one (see busy-after-interrupt).
			this.resolveExecution(execution, { clearActive: false });
		};
		const onAbort = () => {
			void this.interrupt().catch(() => undefined);
			clearAbortTimer();
			abortTimer = globalThis.setTimeout(forceAbort, KERNEL_ABORT_GRACE_MS);
			if (abortTimer && typeof abortTimer === "object" && "unref" in abortTimer) {
				abortTimer.unref();
			}
		};

		try {
			this.activeExecution = execution;
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts.signal?.aborted) {
				onAbort();
			}
			if (!opts.internal) {
				this.lastCellCode = code;
			}
			try {
				const sendPromise = this.writeLine({ ...requestFields, id: requestId });
				sendPromise.catch(() => undefined);
				await Promise.race([sendPromise, result.promise.then(() => undefined)]);
				if (this.activeExecution === execution && execution.status !== "aborted") {
					await sendPromise;
				}
			} catch (error) {
				if (this.activeExecution === execution) {
					this.activeExecution = undefined;
				}
				throw error instanceof Error ? error : new Error(String(error));
			}
			return await result.promise;
		} finally {
			clearAbortTimer();
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}

	private appendBackgroundOutput(text: string): void {
		if (!text) return;
		const execution = this.activeExecution;
		if (execution) {
			if (execution.backgroundOutput.length >= MAX_BACKGROUND_OUTPUT_CHARS) {
				execution.backgroundOutputTruncated = true;
				return;
			}
			execution.backgroundOutput += text;
			if (execution.backgroundOutput.length > MAX_BACKGROUND_OUTPUT_CHARS) {
				execution.backgroundOutput = execution.backgroundOutput.slice(0, MAX_BACKGROUND_OUTPUT_CHARS);
				execution.backgroundOutputTruncated = true;
			}
			return;
		}
		if (this.pendingBackgroundOutput.length >= MAX_BACKGROUND_OUTPUT_CHARS) {
			this.pendingBackgroundOutputTruncated = true;
			return;
		}
		this.pendingBackgroundOutput += text;
		if (this.pendingBackgroundOutput.length > MAX_BACKGROUND_OUTPUT_CHARS) {
			this.pendingBackgroundOutput = this.pendingBackgroundOutput.slice(0, MAX_BACKGROUND_OUTPUT_CHARS);
			this.pendingBackgroundOutputTruncated = true;
		}
	}

	private finishActiveExecution(execution: ActiveExecution): void {
		if (this.activeExecution !== execution) {
			return;
		}
		this.resolveExecution(execution, { clearActive: true });
	}

	private resolveExecution(execution: ActiveExecution, options: { clearActive: boolean }): void {
		const didClearActive = options.clearActive && this.activeExecution === execution;
		if (options.clearActive && this.activeExecution === execution) {
			this.activeExecution = undefined;
		}
		if (!execution.settled) {
			execution.settled = true;
			if (execution.opts.onLateSentAgentMessage) {
				this.registerLateSentAgentMessageHandler(execution.requestId, execution.opts.onLateSentAgentMessage);
			}

			let stdout = execution.stdout;
			let stderr = execution.stderr;
			let result = execution.result;
			let status = execution.status;
			if (execution.stdoutTruncated) stdout += `\n[... output truncated at ${execution.maxChars} chars ...]`;
			if (execution.stderrTruncated) stderr += `\n[... output truncated at ${execution.maxChars} chars ...]`;
			if (result !== undefined && result.length > execution.maxChars) {
				result = `${result.slice(0, execution.maxChars)}\n[... output truncated at ${execution.maxChars} chars ...]`;
			}

			if (execution.opts.signal?.aborted) status = "aborted";

			let backgroundOutput = execution.backgroundOutput;
			if (execution.backgroundOutputTruncated) {
				backgroundOutput += `\n[... background output truncated at ${MAX_BACKGROUND_OUTPUT_CHARS} chars ...]`;
			}

			execution.resolve({
				stdout,
				stderr,
				result,
				diffs: execution.diffs.length > 0 ? execution.diffs : undefined,
				attachments: execution.attachments.length > 0 ? execution.attachments : undefined,
				sentAgentMessages: execution.sentAgentMessages.length > 0 ? execution.sentAgentMessages : undefined,
				backgroundOutput: backgroundOutput.length > 0 ? backgroundOutput : undefined,
				error: execution.error,
				status,
				durationMs: Date.now() - execution.started,
				doneFields: execution.doneFields,
			});
		}
		if (didClearActive) {
			this.notifyActiveExecutionIdle();
		}
	}

	private dispatchLateSentAgentMessage(requestId: string | undefined, value: unknown): boolean {
		const sentAgentMessage = parseSentAgentMessage(value);
		if (!sentAgentMessage || !requestId) {
			return false;
		}
		const handler = this.lateSentAgentMessageHandlers.get(requestId);
		if (!handler) {
			return false;
		}
		this.lateSentAgentMessageHandlers.delete(requestId);
		this.lateSentAgentMessageHandlers.set(requestId, handler);
		handler(sentAgentMessage);
		return true;
	}

	private registerLateSentAgentMessageHandler(
		requestId: string,
		handler: (message: KernelSentAgentMessage) => void,
	): void {
		this.lateSentAgentMessageHandlers.set(requestId, handler);
		while (this.lateSentAgentMessageHandlers.size > MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS) {
			const oldestRequestId = this.lateSentAgentMessageHandlers.keys().next().value;
			if (oldestRequestId === undefined) {
				break;
			}
			this.lateSentAgentMessageHandlers.delete(oldestRequestId);
		}
	}

	private rejectActiveExecution(error: Error): void {
		const execution = this.activeExecution;
		if (!execution) {
			return;
		}
		this.activeExecution = undefined;
		execution.reject(error);
		this.notifyActiveExecutionIdle();
	}

	private notifyActiveExecutionIdle(): void {
		for (const resolve of this.activeExecutionIdleWaiters) {
			resolve();
		}
		this.activeExecutionIdleWaiters.clear();
	}

	private waitForActiveExecutionToClear(signal: AbortSignal | undefined, timeoutMs: number): Promise<boolean> {
		if (!this.activeExecution) {
			return Promise.resolve(true);
		}
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
			const finish = (cleared: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timeout) {
					globalThis.clearTimeout(timeout);
				}
				this.activeExecutionIdleWaiters.delete(onIdle);
				signal?.removeEventListener("abort", onAbort);
				resolve(cleared);
			};
			const onIdle = () => finish(true);
			const onAbort = () => finish(false);
			this.activeExecutionIdleWaiters.add(onIdle);
			signal?.addEventListener("abort", onAbort, { once: true });
			timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) {
				timeout.unref();
			}
		});
	}

	private async waitForActiveExecutionToClearForReuse(signal?: AbortSignal): Promise<void> {
		const started = Date.now();
		while (this.activeExecution && Date.now() - started < KERNEL_BUSY_REUSE_WAIT_MS) {
			if ((this.state as string) === "shutdown") {
				throw new Error("Kernel has been shut down");
			}
			void this.interrupt().catch(() => undefined);
			const remaining = KERNEL_BUSY_REUSE_WAIT_MS - (Date.now() - started);
			const cleared = await this.waitForActiveExecutionToClear(
				signal,
				Math.max(1, Math.min(KERNEL_BUSY_INTERRUPT_INTERVAL_MS, remaining)),
			);
			if (cleared || signal?.aborted) {
				return;
			}
		}
		if (this.activeExecution) {
			throw new KernelBusyAfterInterruptError();
		}
	}

	private startHostRequest(requestId: string, data: unknown): void {
		if (this.handledHostRequestIds.has(requestId)) {
			return;
		}
		this.handledHostRequestIds.add(requestId);
		while (this.handledHostRequestIds.size > MAX_HANDLED_HOST_REQUEST_IDS) {
			const oldest = this.handledHostRequestIds.values().next().value;
			if (oldest === undefined) break;
			this.handledHostRequestIds.delete(oldest);
		}

		const task = (async () => {
			try {
				const result = await this.handleHostRequest(data);
				try {
					await this.writeLine({ type: "host_reply", id: requestId, data: { status: "ok", result } });
				} catch (replyError) {
					this.appendKernelDiagnostic(
						`failed to send host request ok reply for ${requestId}: ${errorMessage(replyError)}`,
					);
				}
			} catch (error) {
				this.appendKernelDiagnostic(`host request failed for ${requestId}: ${errorMessage(error)}`);
				try {
					await this.writeLine({
						type: "host_reply",
						id: requestId,
						data: { status: "error", error: errorMessage(error) },
					});
				} catch (replyError) {
					this.appendKernelDiagnostic(
						`failed to send host request error reply for ${requestId}: ${errorMessage(replyError)}`,
					);
				}
			}
		})();
		this.inFlightHostRequests.add(task);
		void task.finally(() => {
			this.inFlightHostRequests.delete(task);
		});
	}

	private async handleHostRequest(data: unknown): Promise<Record<string, unknown>> {
		if (!isRecord(data)) {
			throw new Error("host request payload must be an object");
		}
		if (typeof data.type !== "string" || data.type.length === 0) {
			throw new Error("host request payload must have a string type");
		}

		const handler = this.options.hostHandlers?.[data.type];
		if (!handler) {
			throw new Error(`host request type "${data.type}" is not available in this session`);
		}
		// Tag the request with the cell that triggered it. A blocking call is still
		// the in-flight execution; detached spawns (asyncio.create_task) fire after
		// the scheduling cell goes idle, so fall back to that last cell's source.
		const cellSourceCode = this.activeExecution?.code ?? this.lastCellCode;
		return handler({ ...data, cellSourceCode });
	}

	private async interrupt(): Promise<void> {
		const requestId = this.activeExecution?.requestId;
		if (!requestId) return;
		await this.writeLine({ type: "interrupt", id: requestId });
	}

	private cleanupResources(killSignal: NodeJS.Signals = "SIGTERM"): void {
		this.startGeneration++; // any teardown invalidates in-flight starts
		this.clearSnapshotTimer();
		this.lateSentAgentMessageHandlers.clear();
		this.pendingDoneWaiters.clear();
		// Stale pre-teardown background output must not surface after a restart.
		this.pendingBackgroundOutput = "";
		this.pendingBackgroundOutputTruncated = false;
		this.rejectActiveExecution(new Error("Kernel has been shut down"));
		const child = this.child;
		this.child = undefined;
		this.readyDeferred = undefined;
		if (child) {
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			const pid = child.pid;
			let signaled = false;
			try {
				signaled = child.kill(killSignal);
			} catch {
				// The kernel has already exited.
			}
			// Inactive only when the signal proved the pid still named our un-reaped child.
			if (pid !== undefined && signaled) recordOrphanProcessState(pid, false);
			// A killed/crashed kernel cannot run its own shutdown hook, so the host
			// reaps the bash() process groups it journaled under this kernel pid.
			if (pid !== undefined) reapKernelOrphanProcesses(pid);
		}
		this.startPromise = undefined;
	}

	private async waitForKernelExit(): Promise<void> {
		const child = this.child;
		if (!child) return;
		if (child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	}

	private async waitForHostRequestsToSettle(tasks: Promise<void>[], timeoutMs: number): Promise<void> {
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		const timeoutPromise = new Promise<"timeout">((resolve) => {
			timeout = globalThis.setTimeout(() => resolve("timeout"), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) {
				timeout.unref();
			}
		});

		const result = await Promise.race([Promise.allSettled(tasks).then(() => "settled" as const), timeoutPromise]);
		if (timeout) {
			globalThis.clearTimeout(timeout);
		}
		if (result === "timeout") {
			this.appendKernelDiagnostic(
				`timed out waiting ${timeoutMs}ms for ${tasks.length} host request task(s) during shutdown`,
			);
		}
	}

	/** Resolves true when this call performed the cleanup (false: a concurrent teardown won; a joiner's options are ignored - the first caller's policy wins). */
	async shutdown(opts: KernelShutdownOptions = {}): Promise<boolean> {
		const inFlightShutdown = this.gracefulShutdownPromise;
		if (inFlightShutdown) {
			await inFlightShutdown;
			return false;
		}

		this.teardownInFlight++;
		this.supersedeProtocolRepair();
		const operation = this.performShutdown(opts);
		this.gracefulShutdownPromise = operation;
		try {
			return await operation;
		} finally {
			this.teardownInFlight--;
			if (this.gracefulShutdownPromise === operation) this.gracefulShutdownPromise = undefined;
		}
	}

	private async performShutdown(opts: KernelShutdownOptions): Promise<boolean> {
		if (this.state === "shutdown") {
			liveKernels.delete(this);
			if (this.gracefulShutdownGeneration === this.startGeneration) return false;
			this.cleanupResources();
			return true;
		}
		// Captured before any await: teardowns and newer starts bump the counter.
		const generation = this.startGeneration;
		if (opts.snapshot) {
			await this.flushSnapshotForDispose();
			if (this.startStale(generation)) return false;
		}
		// Protocol shutdown first: the runtime closes MCP servers and kills live bash() process groups a bare hard-kill would leak.
		const protocolShutdownAvailable = this.state === "running";
		this.state = "shutdown";
		liveKernels.delete(this);
		this.gracefulShutdownGeneration = generation;

		let shutdownTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
		let doneWaiterId: string | undefined;
		let performedCleanup = false;
		try {
			if (opts.drainHostRequests) {
				const inFlightHostRequests = [...this.inFlightHostRequests];
				if (inFlightHostRequests.length > 0) {
					await this.waitForHostRequestsToSettle(inFlightHostRequests, HOST_REQUEST_SHUTDOWN_TIMEOUT_MS);
				}
			}
			if (
				protocolShutdownAvailable &&
				!this.startStale(generation) &&
				this.child?.stdin &&
				!this.child.stdin.destroyed
			) {
				const requestId = uuid();
				doneWaiterId = requestId;
				const doneReply = new Promise<void>((resolve) => {
					this.pendingDoneWaiters.set(requestId, resolve);
				});
				const shutdownDeadline = new Promise<never>((_resolve, reject) => {
					shutdownTimer = globalThis.setTimeout(
						() => reject(new Error(`Kernel did not shut down within ${KERNEL_SHUTDOWN_TIMEOUT_MS}ms`)),
						KERNEL_SHUTDOWN_TIMEOUT_MS,
					);
					shutdownTimer.unref?.();
				});
				const send = this.writeLine({ type: "shutdown", id: requestId });
				send.catch(() => undefined);
				const kernelExit = this.waitForKernelExit();
				const gracefulReply = Promise.all([send, doneReply]);
				gracefulReply.catch(() => undefined);
				await Promise.race([gracefulReply, kernelExit, shutdownDeadline]);
				await Promise.race([kernelExit, shutdownDeadline]);
			}
		} catch (error) {
			this.appendKernelDiagnostic(
				`graceful shutdown failed (killing instead): ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (shutdownTimer) globalThis.clearTimeout(shutdownTimer);
			if (doneWaiterId) this.pendingDoneWaiters.delete(doneWaiterId);
			if (this.gracefulShutdownGeneration === generation) this.gracefulShutdownGeneration = undefined;
			if (!this.startStale(generation)) {
				this.cleanupResources();
				performedCleanup = true;
			}
		}

		return performedCleanup;
	}

	async restart(): Promise<void> {
		// A final dispose flush owns the queue tail. Taking a slot now and joining
		// the in-flight shutdown would deadlock: the flush's snapshot waits on our
		// slot while we wait on the flush's shutdown.
		if (this.flushingSnapshotForDispose) {
			throw new Error("Kernel is shutting down");
		}
		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		try {
			const performedCleanup = await this.shutdown();
			if (!performedCleanup) return;
			this.state = "idle";
			this.kernelStderr = "";
			await this.start();
		} finally {
			resolveNext();
		}
	}

	async kill(): Promise<void> {
		this.supersedeProtocolRepair();
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources("SIGKILL");
	}

	/**
	 * Serialize the user namespace to disk (best-effort, per-variable). No-op when
	 * the kernel isn't running or no snapshot target was configured. Never throws.
	 */
	async snapshotState(): Promise<SnapshotResult | null> {
		return this.captureSnapshot();
	}

	/** Persist the namespace, then remove variables above the per-variable cap. */
	async pruneOversizedVariables(): Promise<SnapshotResult | null> {
		return this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS, pruneOversized: true });
	}

	private async captureSnapshot(
		options: { executionTimeoutMs?: number; pruneOversized?: boolean } = {},
	): Promise<SnapshotResult | null> {
		const cfg = this.options.snapshot;
		if (!cfg || !this.isRunning) return null;
		try {
			const r = await this.enqueueRequest(
				{
					type: "snapshot",
					path: cfg.path,
					manifest_path: cfg.manifestPath,
					max_bytes: cfg.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
					max_variable_bytes: cfg.maxVariableBytes ?? DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
					prune_oversized: options.pruneOversized ?? false,
				},
				"",
				{ internal: true },
				options.executionTimeoutMs,
			);
			if (r.status !== "ok" || !r.doneFields) {
				this.appendKernelDiagnostic(
					`state snapshot ${r.status === "aborted" ? "timed out" : "failed"}: ${r.error?.evalue ?? r.stderr}`,
				);
				return null;
			}
			const pruned = asStringArray(r.doneFields.pruned);
			return {
				saved: asStringArray(r.doneFields.saved),
				skipped: asReasonArray(r.doneFields.skipped),
				pruned: pruned.length > 0 ? pruned : undefined,
				bytes: typeof r.doneFields.bytes === "number" ? r.doneFields.bytes : 0,
				path: cfg.path,
			};
		} catch (error) {
			this.appendKernelDiagnostic(`state snapshot error: ${errorMessage(error)}`);
			return null;
		}
	}

	/**
	 * Revive a previously snapshotted namespace into the kernel. Call right after
	 * start() and before the runtime bootstrap, which then refreshes live handles
	 * (rlm, skills) over anything restored. Never throws.
	 */
	async restoreState(): Promise<RestoreResult | null> {
		return this.performRestore(false);
	}

	/** Repair restores bypass the repair gate and are bounded so a stalled kernel cannot wedge it. */
	private async performRestore(protocolRepair: boolean): Promise<RestoreResult | null> {
		const cfg = this.options.snapshot;
		if (!cfg) return null;
		try {
			const r = await this.enqueueRequest(
				{ type: "restore", path: cfg.path },
				"",
				{ internal: true, protocolRepair },
				protocolRepair ? REPAIR_STEP_TIMEOUT_MS : undefined,
			);
			if (r.status !== "ok" || !r.doneFields) {
				this.appendKernelDiagnostic(
					`state restore ${r.status === "aborted" ? "timed out" : "failed"}: ${r.error?.evalue ?? r.stderr}`,
				);
				return null;
			}
			this.pendingRestore = false;
			return {
				restored: asStringArray(r.doneFields.restored),
				failed: asReasonArray(r.doneFields.failed),
				path: cfg.path,
			};
		} catch (error) {
			this.appendKernelDiagnostic(`state restore error: ${errorMessage(error)}`);
			return null;
		}
	}

	/** Live user-defined top-level names, or null if the kernel isn't running. Never throws. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		if (!this.isRunning) return null;
		try {
			const r = await this.enqueueRequest({ type: "list_names" }, "", { internal: true, signal });
			if (r.status !== "ok" || !r.doneFields) {
				this.appendKernelDiagnostic(`namespace listing failed: ${r.error?.evalue ?? r.stderr}`);
				return null;
			}
			return asStringArray(r.doneFields.names);
		} catch (error) {
			this.appendKernelDiagnostic(`namespace listing error: ${errorMessage(error)}`);
			return null;
		}
	}

	private scheduleSnapshot(): void {
		const cfg = this.options.snapshot;
		if (!cfg) return;
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.snapshotTimer = globalThis.setTimeout(() => {
			this.snapshotTimer = undefined;
			void this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS });
		}, cfg.debounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS);
		if (this.snapshotTimer && typeof this.snapshotTimer === "object" && "unref" in this.snapshotTimer) {
			this.snapshotTimer.unref();
		}
	}

	private clearSnapshotTimer(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
	}

	private flushSnapshotForDispose(): Promise<void> {
		// Concurrent teardowns (dispose vs a signal-handler shutdown) join one flush:
		// a second flusher would clear the execution guard while the first is still
		// snapshotting and enqueue a duplicate final snapshot behind it.
		this.snapshotFlushForDispose ??= this.runSnapshotFlushForDispose().finally(() => {
			this.snapshotFlushForDispose = undefined;
		});
		return this.snapshotFlushForDispose;
	}

	private async runSnapshotFlushForDispose(): Promise<void> {
		if (!this.options.snapshot || !this.isRunning) return;
		// A kernel that never restored the saved namespace must not overwrite it:
		// the on-disk snapshot is strictly fresher than this namespace.
		if (this.pendingRestore) return;
		// Block new external executions so none can splice ahead of the final snapshot and stall dispose.
		this.flushingSnapshotForDispose = true;
		try {
			const pendingExecutions = this.executionQueue;
			if (this.activeExecution) void this.interrupt().catch(() => undefined);
			let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
			const queueSettled = await Promise.race([
				pendingExecutions.then(() => true),
				new Promise<false>((resolve) => {
					timeout = globalThis.setTimeout(() => resolve(false), SNAPSHOT_EXECUTION_TIMEOUT_MS);
					timeout.unref?.();
				}),
			]);
			if (timeout) globalThis.clearTimeout(timeout);
			if (!queueSettled) return;
			await this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS });
		} finally {
			// Reset: a superseding start() can revive this kernel for new work.
			this.flushingSnapshotForDispose = false;
		}
	}

	/** Synchronous best-effort cleanup. Safe to call from `process.on('exit')`. */
	disposeSync(): void {
		this.supersedeProtocolRepair();
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources();
	}

	get isRunning(): boolean {
		return this.state === "running";
	}
}
