import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MontySession } from "@pydantic/monty/node";
import { getNativeMonty } from "./monty-loader.js";
import { normalizeMontyValue, type ParsedPythonWorkflow, parsePythonWorkflow } from "./python-source.js";

export interface WorkflowMetaPhase {
	title: string;
	detail?: string;
	model?: string;
}

export interface WorkflowMeta {
	name: string;
	description: string;
	title?: string;
	whenToUse?: string;
	phases?: WorkflowMetaPhase[];
}

export interface WorkflowAgentRunOptions {
	label: string;
	phase?: string;
	schema?: unknown;
	model?: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	isolation?: "worktree" | "remote";
	agentType?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface WorkflowUsage {
	input: number;
	output: number;
	totalTokens: number;
	cost: number;
}

export interface WorkflowAgentRunResult {
	result: unknown;
	usage?: Partial<WorkflowUsage>;
	model?: string;
	effort?: ThinkingLevel;
}

export interface WorkflowAgentRunner {
	run(prompt: string, options: WorkflowAgentRunOptions): Promise<WorkflowAgentRunResult>;
}

export interface WorkflowJournalStart {
	sequence: number;
	key: string;
	occurrence: number;
}

export interface WorkflowJournalEntry extends WorkflowJournalStart {
	result: unknown;
	usage?: Partial<WorkflowUsage>;
}

export interface WorkflowJournal {
	start(entry: WorkflowJournalStart): void | Promise<void>;
	replay(entry: WorkflowJournalStart): WorkflowJournalEntry | undefined;
	record(entry: WorkflowJournalEntry): void | Promise<void>;
}

export interface WorkflowRunOptions {
	runner: WorkflowAgentRunner;
	cwd?: string;
	args?: unknown;
	concurrency?: number;
	maxAgents?: number;
	tokenBudget?: number;
	agentTimeoutMs?: number;
	scriptTimeoutMs?: number;
	coordinatorCpuSeconds?: number;
	memoryLimitBytes?: number;
	signal?: AbortSignal;
	journal?: WorkflowJournal;
	/** Host policy identity included in replay keys (model, tools, repository state, and so on). */
	replayIdentity?: unknown;
	onLog?: (message: string) => void;
	onPhase?: (title: string) => void;
	onAgentStart?: (event: {
		id: number;
		label: string;
		phase?: string;
		prompt: string;
		model?: string;
		effort?: ThinkingLevel;
	}) => void;
	onAgentEnd?: (event: {
		id: number;
		label: string;
		phase?: string;
		status: "completed" | "failed" | "replayed";
		result: unknown;
		usage?: Partial<WorkflowUsage>;
		model?: string;
		effort?: ThinkingLevel;
		error?: string;
	}) => void;
}

export interface WorkflowRunResult<T = unknown> {
	meta: WorkflowMeta;
	result: T;
	logs: string[];
	phases: string[];
	agentCount: number;
	replayedCount: number;
	usage: WorkflowUsage;
	durationMs: number;
}

interface WorkflowAgentOptions {
	label?: string;
	phase?: string;
	schema?: unknown;
	model?: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	isolation?: "worktree" | "remote";
	agentType?: string;
	timeoutMs?: number;
}

interface RuntimeState {
	currentPhase?: string;
	logs: string[];
	phases: string[];
	agentCount: number;
	replayedCount: number;
	usage: WorkflowUsage;
}

const DEFAULT_CONCURRENCY = Math.max(1, Math.min(16, availableParallelism() - 2));
const MAX_CONCURRENCY = 16;
const DEFAULT_MAX_AGENTS = 1000;
const HARD_MAX_AGENTS = 1000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_COORDINATOR_CPU_SECONDS = 15;
const MAX_COORDINATOR_CPU_SECONDS = 60;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const MIN_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_ARGS_BYTES = 1024 * 1024;
const MAX_LABEL_BYTES = 1024;
const MAX_PHASE_BYTES = 1024;
const MAX_LOG_MESSAGE_BYTES = 16 * 1024;
const MAX_PHASE_COUNT = 1024;
const MAX_EXTERNAL_CALLS = 100_000;
const MAX_OPTION_STRING_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_AGENT_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;

export async function parseWorkflowScript(script: string): Promise<ParsedPythonWorkflow> {
	return parsePythonWorkflow(script);
}

export async function runWorkflow<T = unknown>(
	script: string,
	options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
	const startedAt = Date.now();
	const parsed = await parsePythonWorkflow(script);
	if (options.tokenBudget !== undefined && (!Number.isSafeInteger(options.tokenBudget) || options.tokenBudget <= 0)) {
		throw new Error("workflow token budget must be a positive safe integer");
	}
	if (
		options.agentTimeoutMs !== undefined &&
		(!Number.isSafeInteger(options.agentTimeoutMs) || options.agentTimeoutMs <= 0)
	) {
		throw new Error("workflow agent timeout must be a positive safe integer");
	}
	const concurrency = boundedPolicyInteger(
		options.concurrency,
		DEFAULT_CONCURRENCY,
		1,
		MAX_CONCURRENCY,
		"concurrency",
	);
	const maxAgents = boundedPolicyInteger(options.maxAgents, DEFAULT_MAX_AGENTS, 1, HARD_MAX_AGENTS, "max agents");
	const scriptTimeoutMs = boundedPolicyInteger(
		options.scriptTimeoutMs,
		DEFAULT_SCRIPT_TIMEOUT_MS,
		1,
		60 * 60 * 1000,
		"script timeout",
	);
	const coordinatorCpuSeconds = boundedPolicyInteger(
		options.coordinatorCpuSeconds,
		DEFAULT_COORDINATOR_CPU_SECONDS,
		1,
		MAX_COORDINATOR_CPU_SECONDS,
		"coordinator CPU seconds",
	);
	const memoryLimitBytes = boundedPolicyInteger(
		options.memoryLimitBytes,
		DEFAULT_MEMORY_LIMIT_BYTES,
		MIN_MEMORY_LIMIT_BYTES,
		MAX_MEMORY_LIMIT_BYTES,
		"memory limit",
	);
	const state: RuntimeState = {
		logs: [],
		phases: [],
		agentCount: 0,
		replayedCount: 0,
		usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
	};
	const args = normalizeMontyValue(options.args ?? null);
	if (jsonBytes(args) > MAX_ARGS_BYTES) throw new Error(`workflow args exceed ${MAX_ARGS_BYTES} bytes`);
	const deadline = startedAt + scriptTimeoutMs;
	const occurrences = new Map<string, number>();
	const controller = new AbortController();
	const limiter = createLimiter(concurrency, controller.signal);
	let removeExternalAbortListener: (() => void) | undefined;
	let totalLogBytes = 0;
	let totalAgentResultBytes = 0;
	let externalCallCount = 0;
	const phaseSet = new Set<string>();
	let fatalError: Error | undefined;
	let session: MontySession | undefined;
	let workerPid: number | undefined;
	let removeWorkerAbortListener: (() => void) | undefined;

	const fail = (error: Error): never => {
		fatalError ??= error;
		controller.abort(error);
		throw error;
	};

	const countExternalCall = (): void => {
		externalCallCount++;
		if (externalCallCount > MAX_EXTERNAL_CALLS) {
			fail(new Error(`workflow external call cap reached (${MAX_EXTERNAL_CALLS})`));
		}
	};

	const log = (message: string) => {
		countExternalCall();
		const messageBytes = Buffer.byteLength(message, "utf8");
		if (messageBytes > MAX_LOG_MESSAGE_BYTES) {
			fail(new Error(`workflow log message exceeds ${MAX_LOG_MESSAGE_BYTES} bytes`));
		}
		totalLogBytes += messageBytes;
		if (totalLogBytes > MAX_LOG_BYTES) fail(new Error(`workflow logs exceed ${MAX_LOG_BYTES} bytes`));
		state.logs.push(message);
		try {
			options.onLog?.(message);
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	};

	const runAgent = async (rawPrompt: unknown, rawOptions: unknown): Promise<unknown> => {
		countExternalCall();
		const prompt = requiredString(rawPrompt, "agent prompt");
		if (!prompt.trim()) throw new Error("agent prompt must be a non-empty string");
		if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
			return fail(new Error(`agent prompt exceeds ${MAX_PROMPT_BYTES} bytes`));
		}
		const agentOptions = normalizeAgentOptions(rawOptions);
		if (agentOptions.schema !== undefined && jsonBytes(agentOptions.schema) > MAX_SCHEMA_BYTES) {
			return fail(new Error(`agent schema exceeds ${MAX_SCHEMA_BYTES} bytes`));
		}
		if (state.agentCount >= maxAgents) return fail(new Error(`workflow agent cap reached (${maxAgents})`));
		if (options.tokenBudget !== undefined && state.usage.totalTokens >= options.tokenBudget) {
			return fail(new Error(`workflow token budget exhausted (${options.tokenBudget})`));
		}
		if (controller.signal.aborted) return fail(abortError(controller.signal.reason));

		const id = ++state.agentCount;
		const assignedPhase = agentOptions.phase ?? state.currentPhase;
		if (assignedPhase && Buffer.byteLength(assignedPhase, "utf8") > MAX_PHASE_BYTES) {
			return fail(new Error(`agent phase exceeds ${MAX_PHASE_BYTES} bytes`));
		}
		const label = agentOptions.label?.trim() || `${assignedPhase ?? "agent"} #${id}`;
		if (Buffer.byteLength(label, "utf8") > MAX_LABEL_BYTES)
			return fail(new Error(`agent label exceeds ${MAX_LABEL_BYTES} bytes`));
		const key = createAgentCallKey(prompt, { ...agentOptions, phase: assignedPhase }, args, options.replayIdentity);
		const occurrence = occurrences.get(key) ?? 0;
		occurrences.set(key, occurrence + 1);
		const journalStart = { sequence: id, key, occurrence };
		try {
			await options.journal?.start(journalStart);
		} catch (error) {
			return fail(error instanceof Error ? error : new Error(String(error)));
		}
		let replayed: WorkflowAgentRunResult | undefined;
		try {
			replayed = options.journal?.replay(journalStart);
		} catch (error) {
			return fail(error instanceof Error ? error : new Error(String(error)));
		}
		if (replayed) {
			const replayedResult = normalizeMontyValue(replayed.result);
			const replayedBytes = jsonBytes(replayedResult);
			if (replayedBytes > MAX_RESULT_BYTES)
				return fail(new Error(`replayed agent result exceeds ${MAX_RESULT_BYTES} bytes`));
			totalAgentResultBytes += replayedBytes;
			if (totalAgentResultBytes > MAX_TOTAL_AGENT_RESULT_BYTES) {
				return fail(new Error(`workflow agent results exceed ${MAX_TOTAL_AGENT_RESULT_BYTES} bytes`));
			}
			state.replayedCount++;
			try {
				options.onAgentEnd?.({ id, label, phase: assignedPhase, status: "replayed", result: replayedResult });
			} catch (error) {
				return fail(error instanceof Error ? error : new Error(String(error)));
			}
			return replayedResult;
		}

		return limiter(async () => {
			if (controller.signal.aborted) return fail(abortError(controller.signal.reason));
			if (options.tokenBudget !== undefined && state.usage.totalTokens >= options.tokenBudget) {
				return fail(new Error(`workflow token budget exhausted (${options.tokenBudget})`));
			}
			try {
				options.onAgentStart?.({
					id,
					label,
					phase: assignedPhase,
					prompt,
					model: agentOptions.model,
					effort: agentOptions.effort,
				});
			} catch (error) {
				return fail(error instanceof Error ? error : new Error(String(error)));
			}
			let agentTimedOut = false;
			try {
				const agentTimeoutMs = boundedAgentTimeout(agentOptions.timeoutMs ?? options.agentTimeoutMs, deadline);
				const agentController = new AbortController();
				const removeAgentAbort = forwardAbort(controller.signal, agentController);
				let response: WorkflowAgentRunResult;
				try {
					response = await raceWithAbortAndTimeout(
						options.runner.run(prompt, {
							label,
							phase: assignedPhase,
							schema: agentOptions.schema,
							model: agentOptions.model,
							effort: agentOptions.effort,
							isolation: agentOptions.isolation,
							agentType: agentOptions.agentType,
							timeoutMs: agentTimeoutMs,
							signal: agentController.signal,
						}),
						agentController.signal,
						agentTimeoutMs,
						() => {
							agentTimedOut = true;
							agentController.abort(new Error(`workflow agent timed out after ${agentTimeoutMs}ms`));
						},
					);
				} finally {
					removeAgentAbort?.();
				}
				if (controller.signal.aborted) return fail(abortError(controller.signal.reason));
				let result: unknown;
				try {
					result = normalizeMontyValue(response.result);
				} catch (error) {
					return fail(error instanceof Error ? error : new Error(String(error)));
				}
				const resultBytes = jsonBytes(result);
				if (resultBytes > MAX_RESULT_BYTES)
					return fail(new Error(`agent result exceeds ${MAX_RESULT_BYTES} bytes`));
				totalAgentResultBytes += resultBytes;
				if (totalAgentResultBytes > MAX_TOTAL_AGENT_RESULT_BYTES) {
					return fail(new Error(`workflow agent results exceed ${MAX_TOTAL_AGENT_RESULT_BYTES} bytes`));
				}
				if (options.tokenBudget !== undefined && response.usage?.totalTokens === undefined) {
					return fail(new Error("workflow token budget requires authoritative agent token usage"));
				}
				try {
					addUsage(state.usage, response.usage);
				} catch (error) {
					return fail(error instanceof Error ? error : new Error(String(error)));
				}
				if (options.tokenBudget !== undefined && state.usage.totalTokens > options.tokenBudget) {
					return fail(new Error(`workflow token budget exceeded (${options.tokenBudget})`));
				}
				try {
					await options.journal?.record({ sequence: id, key, occurrence, result, usage: response.usage });
				} catch (error) {
					return fail(error instanceof Error ? error : new Error(String(error)));
				}
				try {
					options.onAgentEnd?.({
						id,
						label,
						phase: assignedPhase,
						status: "completed",
						result,
						usage: response.usage,
						model: response.model,
						effort: response.effort,
					});
				} catch (error) {
					return fail(error instanceof Error ? error : new Error(String(error)));
				}
				return result;
			} catch (error) {
				if (controller.signal.aborted) return fail(abortError(controller.signal.reason));
				if (agentTimedOut) return fail(new Error(`workflow agent timed out: ${label}`));
				const message = errorMessage(error);
				log(`agent "${label}" failed: ${message}`);
				try {
					options.onAgentEnd?.({
						id,
						label,
						phase: assignedPhase,
						status: "failed",
						result: null,
						error: message,
					});
				} catch (callbackError) {
					return fail(callbackError instanceof Error ? callbackError : new Error(String(callbackError)));
				}
				return null;
			}
		});
	};

	const pool = await getNativeMonty().create({
		minProcesses: 1,
		maxProcesses: 1,
		requestTimeout: coordinatorCpuSeconds + 2,
		durationLimitGrace: 1,
		maxCheckoutsPerWorker: 1,
	});
	removeExternalAbortListener = forwardAbort(options.signal, controller);
	try {
		session = await pool.checkout({
			scriptName: `${parsed.meta.name}.workflow.py`,
			limits: {
				maxDurationSecs: coordinatorCpuSeconds,
				maxMemory: memoryLimitBytes,
				maxRecursionDepth: 200,
			},
		});
		workerPid = session.workerPid;
		if (typeof workerPid !== "number" || !Number.isSafeInteger(workerPid) || workerPid <= 0) {
			throw new Error("Prime Agent workflows require Monty's native subprocess backend");
		}
		const abortWorker = () => {
			if (workerPid === undefined) return;
			const pid = workerPid;
			workerPid = undefined;
			killWorker(pid);
		};
		if (controller.signal.aborted) {
			abortWorker();
		} else {
			controller.signal.addEventListener("abort", abortWorker, { once: true });
			removeWorkerAbortListener = () => controller.signal.removeEventListener("abort", abortWorker);
		}

		const execution = session.feedRun(parsed.wrappedSource, {
			inputs: {
				args: structuredClone(args),
				cwd: options.cwd ?? process.cwd(),
				workflow_token_budget: options.tokenBudget ?? null,
			},
			externalLookup: {
				workflow_agent: runAgent,
				workflow_phase: (rawTitle: unknown) => {
					countExternalCall();
					const title = requiredString(rawTitle, "phase title");
					if (!title.trim()) throw new Error("phase title must be a non-empty string");
					if (Buffer.byteLength(title, "utf8") > MAX_PHASE_BYTES)
						throw new Error(`phase title exceeds ${MAX_PHASE_BYTES} bytes`);
					const changed = state.currentPhase !== title;
					state.currentPhase = title;
					if (!phaseSet.has(title)) {
						if (phaseSet.size >= MAX_PHASE_COUNT)
							fail(new Error(`workflow phase cap reached (${MAX_PHASE_COUNT})`));
						phaseSet.add(title);
						state.phases.push(title);
					}
					if (changed) {
						try {
							options.onPhase?.(title);
						} catch (error) {
							return fail(error instanceof Error ? error : new Error(String(error)));
						}
					}
					return null;
				},
				workflow_log: (rawMessage: unknown) => {
					log(requiredString(rawMessage, "log message"));
					return null;
				},
				workflow_spent: () => {
					countExternalCall();
					return state.usage.totalTokens;
				},
			},
			printCallback: () => {
				throw new Error("workflow code must use log() instead of print()");
			},
		});
		let rawResult: unknown;
		try {
			rawResult = await raceWithAbortAndTimeout(execution, controller.signal, scriptTimeoutMs, () => {
				fatalError ??= new Error(`workflow script interrupted after ${scriptTimeoutMs}ms`);
				controller.abort(fatalError);
			});
		} catch (error) {
			if (fatalError) throw fatalError;
			if (controller.signal.aborted) throw abortError(controller.signal.reason);
			throw error;
		}

		if (fatalError) throw fatalError;
		if (controller.signal.aborted) throw abortError(controller.signal.reason);
		if (state.agentCount === 0) throw new Error("workflow must launch at least one native agent");
		const result = normalizeMontyValue(rawResult);
		if (jsonBytes(result) > MAX_RESULT_BYTES) throw new Error(`workflow result exceeds ${MAX_RESULT_BYTES} bytes`);
		return {
			meta: parsed.meta,
			result: result as T,
			logs: state.logs,
			phases: state.phases,
			agentCount: state.agentCount,
			replayedCount: state.replayedCount,
			usage: state.usage,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		removeWorkerAbortListener?.();
		removeExternalAbortListener?.();
		await session?.close().catch(() => undefined);
		await pool.close().catch(() => undefined);
	}
}

function normalizeAgentOptions(value: unknown): WorkflowAgentOptions {
	const normalized = normalizeMontyValue(value);
	if (!isRecord(normalized)) throw new TypeError("agent options must be a dictionary");
	const allowedKeys = new Set(["label", "phase", "schema", "model", "effort", "isolation", "agentType", "timeoutMs"]);
	for (const key of Object.keys(normalized)) {
		if (!allowedKeys.has(key)) throw new TypeError(`unknown workflow agent option: ${key}`);
	}
	for (const key of ["label", "phase", "model", "agentType"] as const) {
		const value = normalized[key];
		if (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_OPTION_STRING_BYTES) {
			throw new Error(`agent ${key} exceeds ${MAX_OPTION_STRING_BYTES} bytes`);
		}
	}
	return {
		label: optionalString(normalized.label, "agent label"),
		phase: optionalString(normalized.phase, "agent phase"),
		schema: normalized.schema === null ? undefined : normalized.schema,
		model: optionalString(normalized.model, "agent model"),
		effort: optionalEnum(normalized.effort, "agent effort", ["low", "medium", "high", "xhigh", "max"]),
		isolation: optionalEnum(normalized.isolation, "agent isolation", ["worktree", "remote"]),
		agentType: optionalString(normalized.agentType, "agent type"),
		timeoutMs: optionalPositiveInteger(normalized.timeoutMs, "agent timeout_ms"),
	};
}

function createAgentCallKey(
	prompt: string,
	options: WorkflowAgentOptions,
	args: unknown,
	replayIdentity: unknown,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				prompt,
				phase: options.phase ?? null,
				schema: options.schema ?? null,
				model: options.model ?? null,
				effort: options.effort ?? null,
				isolation: options.isolation ?? null,
				agentType: options.agentType ?? null,
				timeoutMs: options.timeoutMs ?? null,
				args: args ?? null,
				replayIdentity: replayIdentity ?? null,
			}),
		)
		.digest("hex");
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	return value;
}

function optionalEnum<const T extends string>(value: unknown, label: string, allowed: readonly T[]): T | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new TypeError(`${label} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) <= 0)
		throw new TypeError(`${label} must be a positive integer`);
	return value as number;
}

function jsonBytes(value: unknown): number {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("workflow values must be JSON-serializable");
	return Buffer.byteLength(serialized, "utf8");
}

function addUsage(target: WorkflowUsage, usage: Partial<WorkflowUsage> | undefined): void {
	if (!usage) return;
	const prototype = Object.getPrototypeOf(usage) as object | null;
	if (prototype !== Object.prototype && prototype !== null) throw new Error("workflow usage must be a plain object");
	const allowedKeys = new Set(["input", "output", "totalTokens", "cost"]);
	for (const key of Object.keys(usage)) {
		if (!allowedKeys.has(key)) throw new Error(`unknown workflow usage field: ${key}`);
	}
	const values = {
		input: Object.hasOwn(usage, "input") ? usage.input : undefined,
		output: Object.hasOwn(usage, "output") ? usage.output : undefined,
		totalTokens: Object.hasOwn(usage, "totalTokens") ? usage.totalTokens : undefined,
		cost: Object.hasOwn(usage, "cost") ? usage.cost : undefined,
	};
	for (const name of ["input", "output", "totalTokens"] as const) {
		const value = values[name];
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			throw new Error(`workflow usage ${name} must be a non-negative safe integer`);
		}
	}
	if (values.cost !== undefined && (!Number.isFinite(values.cost) || values.cost < 0)) {
		throw new Error("workflow usage cost must be finite and non-negative");
	}
	const next = {
		input: target.input + (values.input ?? 0),
		output: target.output + (values.output ?? 0),
		totalTokens: target.totalTokens + (values.totalTokens ?? 0),
		cost: target.cost + (values.cost ?? 0),
	};
	if (!Object.values(next).every(Number.isFinite)) throw new Error("workflow usage totals exceed numeric limits");
	Object.assign(target, next);
}

function createLimiter(limit: number, signal: AbortSignal): <T>(task: () => Promise<T>) => Promise<T> {
	let active = 0;
	const queue: Array<() => void> = [];
	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (active >= limit) {
			await raceWithAbort(new Promise<void>((resolve) => queue.push(resolve)), signal);
		}
		if (signal.aborted) throw abortError(signal.reason);
		active++;
		try {
			return await task();
		} finally {
			active--;
			queue.shift()?.();
		}
	};
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw abortError(signal.reason);
	let removeListener: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		const onAbort = () => reject(abortError(signal.reason));
		signal.addEventListener("abort", onAbort, { once: true });
		removeListener = () => signal.removeEventListener("abort", onAbort);
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		removeListener?.();
	}
}

async function raceWithAbortAndTimeout<T>(
	promise: Promise<T>,
	signal: AbortSignal,
	timeoutMs: number,
	onTimeout: () => void,
): Promise<T> {
	if (signal.aborted) throw abortError(signal.reason);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let removeListener: (() => void) | undefined;
	const interrupted = new Promise<never>((_resolve, reject) => {
		const onAbort = () => reject(abortError(signal.reason));
		signal.addEventListener("abort", onAbort, { once: true });
		removeListener = () => signal.removeEventListener("abort", onAbort);
		timeout = setTimeout(() => {
			onTimeout();
			reject(new Error(`workflow script interrupted after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, interrupted]);
	} finally {
		removeListener?.();
		if (timeout) clearTimeout(timeout);
	}
}

function killWorker(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// The worker already exited; Monty will surface the feed result.
	}
}

function boundedAgentTimeout(requested: number | undefined, deadline: number): number {
	const remaining = Math.max(1, deadline - Date.now());
	return requested === undefined ? remaining : Math.min(requested, remaining);
}

function boundedPolicyInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`workflow ${name} must be a safe integer between ${minimum} and ${maximum}`);
	}
	return value;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): (() => void) | undefined {
	if (!signal) return undefined;
	const forward = () => controller.abort(signal.reason);
	if (signal.aborted) forward();
	else signal.addEventListener("abort", forward, { once: true });
	return () => signal.removeEventListener("abort", forward);
}

function abortError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error("workflow aborted");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
