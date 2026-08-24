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
	HOST_REQUEST_DISPOSE_TIMEOUT_MS,
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
	type KernelStartOptions,
	liveKernels,
	MAX_ATTACHMENT_DATA_CHARS,
	MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS,
	parseAttachmentDisplay,
	parseDiffDisplay,
	parseSentAgentMessage,
	raceStartupWithAbort,
	SNAPSHOT_DISPOSE_TIMEOUT_MS,
	SNAPSHOT_EXECUTION_TIMEOUT_MS,
} from "./shared.js";
import {
	DEFAULT_SNAPSHOT_MAX_BYTES,
	DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
	type RestoreResult,
	type SnapshotResult,
} from "./state-snapshot.js";

const REPL_PROTOCOL_VERSION = 2;
const READY_TIMEOUT_MS = 30_000;
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
		"python" | "cwd" | "env" | "sessionId" | "hostHandlers" | "pythonSkills" | "snapshot"
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
	/** Memoized so concurrent callers all await the same in-flight startup. */
	private startPromise?: Promise<void>;
	/** Pending debounced auto-snapshot, if one has been scheduled. */
	private snapshotTimer?: ReturnType<typeof globalThis.setTimeout>;

	constructor(options: KernelManagerOptions) {
		this.options = {
			python: options.python,
			cwd: options.cwd,
			env: options.env,
			sessionId: options.sessionId,
			hostHandlers: options.hostHandlers,
			pythonSkills: options.pythonSkills,
			snapshot: options.snapshot,
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
		this.wireChild(child);

		try {
			const protocol = await this.waitForReady(child);
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
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
					this.appendKernelDiagnostic(`unparseable protocol line: ${line.slice(0, 200)}`);
					continue;
				}
				if (isRecord(event)) this.handleEvent(event);
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
					await this.writeLine({ type: "host_reply", id: requestId, data: { status: "ok", ...result } });
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
				`timed out waiting ${timeoutMs}ms for ${tasks.length} host request task(s) during dispose`,
			);
		}
	}

	/** Resolves true when this call performed the cleanup (false: a concurrent teardown won). */
	async shutdown(opts: { snapshot?: boolean } = {}): Promise<boolean> {
		if (this.state === "shutdown") {
			liveKernels.delete(this);
			this.cleanupResources();
			return true;
		}
		// Captured before any await: teardowns and newer starts bump the counter.
		const generation = this.startGeneration;
		// Best-effort final flush (bounded) before teardown — used by signal handlers
		// so a SIGINT/SIGTERM exit doesn't lose work the debounced snapshot hasn't saved.
		if (opts.snapshot) {
			await this.flushSnapshotForDispose();
			if (this.startStale(generation)) return false; // superseded mid-flush: the newer owner already cleaned this kernel
		}
		this.state = "shutdown";
		liveKernels.delete(this);
		// Claim the teardown: our own child's exit handler must not run cleanupResources
		// (which bumps the generation and would misread this call as superseded). A
		// concurrent kill()/dispose() still bumps the generation and supersedes us.
		this.gracefulShutdownGeneration = generation;

		let shutdownTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
		let doneWaiterId: string | undefined;
		let performedCleanup = false;
		const shutdownDeadline = new Promise<never>((_resolve, reject) => {
			shutdownTimer = globalThis.setTimeout(
				() => reject(new Error(`Kernel did not shut down within ${KERNEL_SHUTDOWN_TIMEOUT_MS}ms`)),
				KERNEL_SHUTDOWN_TIMEOUT_MS,
			);
			shutdownTimer.unref?.();
		});
		try {
			if (this.child?.stdin && !this.child.stdin.destroyed) {
				const requestId = uuid();
				doneWaiterId = requestId;
				const doneReply = new Promise<void>((resolve) => {
					this.pendingDoneWaiters.set(requestId, resolve);
				});
				const send = this.writeLine({ type: "shutdown", id: requestId });
				send.catch(() => undefined);
				// A kernel that exits without delivering its shutdown done must not stall the deadline.
				const kernelExit = this.waitForKernelExit();
				const gracefulReply = Promise.all([send, doneReply]);
				// Abandoned by the race, a late send failure must not reject unhandled.
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
			// A superseded shutdown must not tear down the newer start's kernel. Ownership is decided
			// here, before cleanupResources bumps the generation and would misread this call as superseded.
			if (!this.startStale(generation)) {
				this.cleanupResources();
				performedCleanup = true;
			}
		}

		return performedCleanup;
	}

	async restart(): Promise<void> {
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
		const cfg = this.options.snapshot;
		if (!cfg) return null;
		try {
			const r = await this.enqueueRequest({ type: "restore", path: cfg.path }, "", { internal: true });
			if (r.status !== "ok" || !r.doneFields) {
				this.appendKernelDiagnostic(`state restore failed: ${r.error?.evalue ?? r.stderr}`);
				return null;
			}
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

	/** Best-effort final snapshot before a graceful dispose, bounded by a timeout. */
	private async flushSnapshotForDispose(): Promise<void> {
		if (!this.options.snapshot || !this.isRunning) return;
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		const guard = new Promise<void>((resolve) => {
			timeout = globalThis.setTimeout(resolve, SNAPSHOT_DISPOSE_TIMEOUT_MS);
			if (timeout && typeof timeout === "object" && "unref" in timeout) timeout.unref();
		});
		try {
			await Promise.race([this.snapshotState().then(() => undefined), guard]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	/** Graceful cleanup. Waits briefly for in-flight host request handlers before killing the child. */
	dispose(): Promise<void> {
		return (async () => {
			// Captured before any await: teardowns and newer starts bump the counter.
			const generation = this.startGeneration;
			// Final namespace flush while the kernel is still live (session end / reload).
			await this.flushSnapshotForDispose();
			if (this.startStale(generation)) return; // superseded mid-flush: the newer owner already cleaned this kernel
			this.state = "shutdown";
			liveKernels.delete(this);
			// Claim the teardown so the child's exit handler does not run
			// cleanupResources mid-dispose (same contract as shutdown()).
			this.gracefulShutdownGeneration = generation;
			const inFlightHostRequests = [...this.inFlightHostRequests];
			try {
				if (inFlightHostRequests.length > 0) {
					await this.waitForHostRequestsToSettle(inFlightHostRequests, HOST_REQUEST_DISPOSE_TIMEOUT_MS);
				}
				if (!this.startStale(generation)) {
					// Bounded protocol shutdown first: the runtime's shutdown branch
					// closes MCP servers and kills live bash() process groups, which
					// a bare hard-kill would leak until the orphan reaper runs.
					await this.requestProtocolShutdown(KERNEL_SHUTDOWN_TIMEOUT_MS);
				}
			} finally {
				if (this.gracefulShutdownGeneration === generation) this.gracefulShutdownGeneration = undefined;
				if (!this.startStale(generation)) this.cleanupResources(); // else: superseded, the newer owner already cleaned
			}
		})();
	}

	/** Best-effort bounded protocol shutdown; the caller's hard kill remains the backstop. */
	private async requestProtocolShutdown(timeoutMs: number): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed) return;
		const requestId = uuid();
		let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
		try {
			const doneReply = new Promise<void>((resolve) => {
				this.pendingDoneWaiters.set(requestId, resolve);
			});
			const send = this.writeLine({ type: "shutdown", id: requestId });
			send.catch(() => undefined);
			const kernelExit = this.waitForKernelExit();
			const deadline = new Promise<void>((resolve) => {
				timer = globalThis.setTimeout(resolve, timeoutMs);
				timer.unref?.();
			});
			const gracefulReply = Promise.all([send, doneReply]).then(() => undefined);
			gracefulReply.catch(() => undefined);
			await Promise.race([gracefulReply, kernelExit, deadline]);
			await Promise.race([kernelExit, deadline]);
		} catch {
			// Best-effort: cleanupResources still hard-kills the child.
		} finally {
			if (timer) globalThis.clearTimeout(timer);
			this.pendingDoneWaiters.delete(requestId);
		}
	}

	/** Synchronous best-effort cleanup. Safe to call from `process.on('exit')`. */
	disposeSync(): void {
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources();
	}

	get isRunning(): boolean {
		return this.state === "running";
	}
}
