import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { spawnHidden, waitForChildProcess } from "../utils/child-process.js";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.js";

export interface AgentAutonomousConfig {
	enabled?: boolean;
	maxContinuations?: number;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	continuationPrompt?: string;
	gates?: AgentAutonomousGateConfig;
	/**
	 * While subagents run, timer-driven continuations are held (child messages
	 * and exit notices are the real wake-up signals). This window allows one
	 * keep-alive continuation of continuous subagent activity so the parent
	 * can still check for hung children. `0` disables the keep-alive valve.
	 */
	subagentKeepAliveMs?: number;
}

export interface AgentAutonomousGateConfig {
	commands?: string[];
	maxRetries?: number;
	timeoutMs?: number;
}

export interface AgentAutonomousGateFailure {
	command: string;
	attempt: number;
	exitText: string;
	output: string;
}

export interface AgentAutonomousStatus {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: Required<Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt" | "gates" | "subagentKeepAliveMs">>;
	gates: Required<AgentAutonomousGateConfig>;
	gateAttempts: Record<string, number>;
	lastGateFailure?: AgentAutonomousGateFailure;
	/** Configured subagent keep-alive window; 0 disables the keep-alive valve. */
	subagentKeepAliveMs?: number;
}

export const DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT =
	"No human input is available in autonomous mode. Continue working until the host evaluator, verifier, or configured autonomous limits stop the run. If you were asking the user a question, make a reasonable assumption and verify it. If you believe you are blocked, prove it with host-observable evidence, preserve that evidence, and keep looking for safe progress while budget remains. Do not end the session yourself; the verifier/evaluator decides completion when configured gates pass.";

export const DEFAULT_AUTONOMOUS_LIMITS: Required<
	Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt" | "gates" | "subagentKeepAliveMs">
> = {
	maxContinuations: 3,
	maxTurns: 12,
	maxTokens: 80_000,
	timeoutMs: 30 * 60 * 1000,
};

export const DEFAULT_AUTONOMOUS_GATES: Required<AgentAutonomousGateConfig> = {
	commands: [],
	maxRetries: 3,
	timeoutMs: 5 * 60 * 1000,
};

/**
 * Default subagent keep-alive window: while subagents run, one continuation
 * per 25 minutes of continuous activity still fires so the parent can check
 * for hung or stopped children instead of sleeping until they finish. Kept
 * strictly below the default wall-clock budget (30 minutes) so the valve
 * fires before the run's timeout caps it; keep custom windows below any
 * configured --timeout-ms for the same reason.
 */
export const DEFAULT_AUTONOMOUS_SUBAGENT_KEEP_ALIVE_MS = 25 * 60 * 1000;

/**
 * Largest keep-alive window `setTimeout` accepts: Node clamps larger delays
 * to 1 ms, which would turn a huge window into a keep-alive storm.
 */
export const MAX_SUBAGENT_KEEP_ALIVE_MS = 2_147_483_647;

/**
 * JSON-safe sentinel meaning "no cap". Limit checks compare usage against the
 * configured value, so this stays finite and serializes to JSON while no
 * realistic run can ever reach it.
 */
export const UNLIMITED_AUTONOMOUS_LIMIT = Number.MAX_SAFE_INTEGER;

export function isUnlimitedAutonomousLimit(value: number): boolean {
	return value >= UNLIMITED_AUTONOMOUS_LIMIT;
}

const MAX_GATE_OUTPUT_CHARS = 6000;
const MAX_CHILD_PROCESS_OUTPUT_CHARS = 1024 * 1024;

export interface AutonomousRuntimeState {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: Required<Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt" | "gates" | "subagentKeepAliveMs">>;
	continuationPrompt: string;
	gates: Required<AgentAutonomousGateConfig>;
	gateAttempts: Record<string, number>;
	lastGateFailure?: GateFailure;
	lastGateFailureSnapshot?: GitWorktreeSnapshot;
	/** Configured subagent keep-alive window; 0 disables the keep-alive valve. */
	subagentKeepAliveMs: number;
}

export type AutonomousLimitReason = "maxContinuations" | "maxTurns" | "maxTokens" | "timeoutMs";
export type AutonomousGateResult = "passed" | "failed" | "retry_exhausted";

type AutonomousLimitState = Pick<
	AgentAutonomousStatus,
	"continuationsUsed" | "turnsUsed" | "tokensUsed" | "startedAt" | "limits"
>;

export interface AutonomousDecision {
	shouldContinue: boolean;
	reason: "missing_terminal_evidence" | "gate_failed" | "not_needed" | "limit_reached";
}

interface GitWorktreeSnapshot {
	status: string;
	diff: string;
	untrackedHash: string;
}

interface AutonomousOperationOptions {
	cwd?: string;
	signal?: AbortSignal;
}

type GateFailure = AgentAutonomousGateFailure;

export type AutonomousLimitDefaults = Pick<
	AgentAutonomousConfig,
	"maxContinuations" | "maxTurns" | "maxTokens" | "timeoutMs"
>;

export function createAutonomousRuntimeState(
	config?: AgentAutonomousConfig,
	options: { cwd?: string; defaultLimits?: AutonomousLimitDefaults } = {},
): AutonomousRuntimeState {
	// Settings-derived defaults sit between the built-in limits and the explicit
	// config: explicit CLI/slash flags win, then persisted settings, then the
	// built-in defaults.
	const defaults: Required<AutonomousLimitDefaults> = {
		maxContinuations: options.defaultLimits?.maxContinuations ?? DEFAULT_AUTONOMOUS_LIMITS.maxContinuations,
		maxTurns: options.defaultLimits?.maxTurns ?? DEFAULT_AUTONOMOUS_LIMITS.maxTurns,
		maxTokens: options.defaultLimits?.maxTokens ?? DEFAULT_AUTONOMOUS_LIMITS.maxTokens,
		timeoutMs: options.defaultLimits?.timeoutMs ?? DEFAULT_AUTONOMOUS_LIMITS.timeoutMs,
	};
	const enabled = config?.enabled === true;
	return {
		enabled,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		startedAt: enabled ? Date.now() : undefined,
		limits: {
			maxContinuations: normalizeLimit(config?.maxContinuations, defaults.maxContinuations),
			maxTurns: normalizeLimit(config?.maxTurns, defaults.maxTurns),
			maxTokens: normalizeLimit(config?.maxTokens, defaults.maxTokens),
			timeoutMs: normalizeLimit(config?.timeoutMs, defaults.timeoutMs),
		},
		continuationPrompt: config?.continuationPrompt?.trim() || DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
		gates: {
			commands: [...(config?.gates?.commands ?? DEFAULT_AUTONOMOUS_GATES.commands)],
			maxRetries: normalizeLimit(config?.gates?.maxRetries, DEFAULT_AUTONOMOUS_GATES.maxRetries),
			timeoutMs: normalizeLimit(config?.gates?.timeoutMs, DEFAULT_AUTONOMOUS_GATES.timeoutMs),
		},
		gateAttempts: {},
		lastGateFailure: undefined,
		lastGateFailureSnapshot: undefined,
		subagentKeepAliveMs: normalizeSubagentKeepAliveMs(config?.subagentKeepAliveMs),
	};
}

/**
 * `undefined` (and invalid values) fall back to the default window; an
 * explicit `0` disables the subagent keep-alive valve entirely.
 */
function normalizeSubagentKeepAliveMs(value: number | undefined): number {
	if (value === 0) {
		return 0;
	}
	return Math.min(normalizeLimit(value, DEFAULT_AUTONOMOUS_SUBAGENT_KEEP_ALIVE_MS), MAX_SUBAGENT_KEEP_ALIVE_MS);
}

export function setAutonomousEnabled(
	state: AutonomousRuntimeState,
	enabled: boolean,
	_options: { cwd?: string } = {},
): void {
	state.enabled = enabled;
	if (enabled) {
		state.continuationsUsed = 0;
		state.turnsUsed = 0;
		state.tokensUsed = 0;
		state.startedAt = Date.now();
		state.gateAttempts = {};
		state.lastGateFailure = undefined;
		state.lastGateFailureSnapshot = undefined;
	} else {
		state.startedAt = undefined;
		state.gateAttempts = {};
		state.lastGateFailure = undefined;
		state.lastGateFailureSnapshot = undefined;
	}
}

/**
 * Apply user-provided budget and gate options to a live runtime state.
 * Only fields present in `config` change; unspecified fields keep the state's
 * current values, which come from the session/CLI configuration or defaults.
 */
export function setAutonomousLimits(state: AutonomousRuntimeState, config?: AgentAutonomousConfig): void {
	if (!config) {
		return;
	}
	state.limits.maxContinuations = normalizeLimit(config.maxContinuations, state.limits.maxContinuations);
	state.limits.maxTurns = normalizeLimit(config.maxTurns, state.limits.maxTurns);
	state.limits.maxTokens = normalizeLimit(config.maxTokens, state.limits.maxTokens);
	state.limits.timeoutMs = normalizeLimit(config.timeoutMs, state.limits.timeoutMs);
	if (config.continuationPrompt?.trim()) {
		state.continuationPrompt = config.continuationPrompt.trim();
	}
	if (config.gates) {
		if (config.gates.commands !== undefined) {
			state.gates.commands = [...config.gates.commands];
		}
		state.gates.maxRetries = normalizeLimit(config.gates.maxRetries, state.gates.maxRetries);
		state.gates.timeoutMs = normalizeLimit(config.gates.timeoutMs, state.gates.timeoutMs);
	}
	if (config.subagentKeepAliveMs !== undefined) {
		state.subagentKeepAliveMs = normalizeSubagentKeepAliveMs(config.subagentKeepAliveMs);
	}
}

export function autonomousStatus(state: AutonomousRuntimeState): AgentAutonomousStatus {
	return {
		enabled: state.enabled,
		continuationsUsed: state.continuationsUsed,
		turnsUsed: state.turnsUsed,
		tokensUsed: state.tokensUsed,
		startedAt: state.startedAt,
		limits: { ...state.limits },
		gates: { ...state.gates, commands: [...state.gates.commands] },
		gateAttempts: { ...state.gateAttempts },
		lastGateFailure: state.lastGateFailure ? { ...state.lastGateFailure } : undefined,
		subagentKeepAliveMs: state.subagentKeepAliveMs,
	};
}

export function addAutonomousUsage(state: AutonomousRuntimeState, usage: Usage | undefined): void {
	if (!state.enabled) {
		return;
	}
	state.turnsUsed++;
	state.tokensUsed += autonomousTokenDelta(usage);
}

/** Spend from discarded empty-turn attempts: tokens count, but no turn is consumed. */
export function addAutonomousDiscardedUsage(state: AutonomousRuntimeState, usage: Usage[] | undefined): void {
	if (!state.enabled) {
		return;
	}
	for (const attempt of usage ?? []) {
		state.tokensUsed += autonomousTokenDelta(attempt);
	}
}

export function addAutonomousContinuation(state: AutonomousRuntimeState): void {
	if (!state.enabled) {
		return;
	}
	state.continuationsUsed++;
}

function autonomousTokenDelta(usage: Usage | undefined): number {
	if (!usage) {
		return 0;
	}
	// Cache-read tokens are repeated context served from provider cache. Counting them
	// cumulatively makes long autonomous verifier loops exhaust their host-side token
	// budget far before the non-cached work reaches the configured cap.
	return usage.input + usage.output + usage.cacheWrite;
}

export async function nextAutonomousContinuation(
	state: AutonomousRuntimeState,
	message: AssistantMessage,
	options: AutonomousOperationOptions = {},
	now = Date.now(),
): Promise<UserMessage | undefined> {
	options.signal?.throwIfAborted();
	if (!state.enabled) {
		return undefined;
	}
	const decision = await shouldAutonomouslyContinue(state, message, options, now);
	options.signal?.throwIfAborted();
	if (!decision.shouldContinue) {
		return undefined;
	}
	state.continuationsUsed++;
	const gateFailureText = decision.reason === "gate_failed" ? buildGateFailureContinuation(state, now) : undefined;
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: gateFailureText ?? `[autonomous-continuation]\n\n${state.continuationPrompt}`,
			},
		],
		timestamp: now,
	};
}

/**
 * Build the continuation message for a held autonomous continuation that is
 * now being delivered (subagents settled, or the keep-alive window elapsed).
 * Budget accounting is the caller's job so a failed admission can roll it
 * back, mirroring how goal continuations account at delivery.
 */
export function createAutonomousContinuationMessage(
	state: AutonomousRuntimeState,
	timestamp = Date.now(),
): UserMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `[autonomous-continuation]\n\n${state.continuationPrompt}`,
			},
		],
		timestamp,
	};
}

/**
 * Build the gate-failure continuation message for a resume whose quality
 * gates failed, mirroring the hook's gate-failure continuation text.
 */
export function createAutonomousGateFailureContinuationMessage(
	state: AutonomousRuntimeState,
	timestamp = Date.now(),
): UserMessage | undefined {
	const failure = state.lastGateFailure;
	if (!failure) {
		return undefined;
	}
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: buildAutonomousGateFailureContinuation(failure, state.gates.maxRetries, timestamp),
			},
		],
		timestamp,
	};
}

/**
 * Keep-alive continuation delivered while subagents are still active: the
 * parent gets a bounded chance to inspect and unblock hung children (for
 * example, SIGTTIN-stopped processes) instead of sleeping until they finish.
 */
export function createAutonomousSubagentKeepAliveMessage(
	state: AutonomousRuntimeState,
	timestamp = Date.now(),
): UserMessage {
	const minutes = Math.max(1, Math.round(state.subagentKeepAliveMs / 60_000));
	return {
		role: "user",
		content: [
			{
				type: "text",
				text:
					`[autonomous-continuation: subagent-keep-alive]\n\n` +
					`Subagents have been running for at least ${minutes} minute${minutes === 1 ? "" : "s"} ` +
					`without a reply or exit being delivered. Check their status (for example agent_observe, ` +
					`rlm.list_subagents, or process inspection) and cancel or unblock any that are hung; ` +
					`then continue working.`,
			},
		],
		timestamp,
	};
}

export async function shouldAutonomouslyContinue(
	state: AutonomousRuntimeState,
	message: AssistantMessage,
	options: AutonomousOperationOptions = {},
	now = Date.now(),
): Promise<AutonomousDecision> {
	options.signal?.throwIfAborted();
	if (!state.enabled || message.stopReason === "error" || message.stopReason === "aborted") {
		return { shouldContinue: false, reason: "not_needed" };
	}
	const gateResult = await refreshAutonomousQualityGates(state, options);
	options.signal?.throwIfAborted();
	if (gateResult) {
		if (gateResult === "passed") {
			return { shouldContinue: false, reason: "not_needed" };
		}
		if (gateResult === "retry_exhausted" || autonomousLimitReason(state, now)) {
			return { shouldContinue: false, reason: "limit_reached" };
		}
		return { shouldContinue: true, reason: "gate_failed" };
	}
	if (autonomousLimitReason(state, now)) {
		return { shouldContinue: false, reason: "limit_reached" };
	}
	return { shouldContinue: true, reason: "missing_terminal_evidence" };
}

export function autonomousLimitReason(
	state: AutonomousLimitState,
	now = Date.now(),
): AutonomousLimitReason | undefined {
	if (state.continuationsUsed >= state.limits.maxContinuations) {
		return "maxContinuations";
	}
	if (state.turnsUsed >= state.limits.maxTurns) {
		return "maxTurns";
	}
	if (state.tokensUsed >= state.limits.maxTokens) {
		return "maxTokens";
	}
	if (state.startedAt !== undefined && now - state.startedAt >= state.limits.timeoutMs) {
		return "timeoutMs";
	}
	return undefined;
}

export async function refreshAutonomousQualityGates(
	state: AutonomousRuntimeState,
	options: AutonomousOperationOptions = {},
): Promise<AutonomousGateResult | undefined> {
	options.signal?.throwIfAborted();
	if (!state.enabled || state.gates.commands.length === 0) {
		return undefined;
	}
	return await runAutonomousQualityGates(state, options.cwd, options.signal);
}

async function runAutonomousQualityGates(
	state: AutonomousRuntimeState,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<AutonomousGateResult> {
	signal?.throwIfAborted();
	if (!cwd) {
		return "failed";
	}
	for (const command of state.gates.commands) {
		const currentSnapshot = await captureGitWorktreeSnapshot(cwd, signal);
		signal?.throwIfAborted();
		if (
			state.lastGateFailure?.command === command &&
			state.lastGateFailureSnapshot &&
			gitWorktreeSnapshotsEqual(currentSnapshot, state.lastGateFailureSnapshot)
		) {
			const attempt = (state.gateAttempts[command] ?? state.lastGateFailure.attempt) + 1;
			state.gateAttempts[command] = attempt;
			state.lastGateFailure = {
				...state.lastGateFailure,
				attempt,
				exitText: "not rerun: workspace unchanged since previous failed gate",
				output:
					"The autonomous gate was not rerun because the workspace has not changed since this failure. Edit source files, tests, or a blocker artifact before attempting to finish again.",
			};
			return attempt > state.gates.maxRetries ? "retry_exhausted" : "failed";
		}
		const result = await runChildProcess(command, [], {
			cwd,
			shell: true,
			timeoutMs: state.gates.timeoutMs,
			maxOutputChars: MAX_GATE_OUTPUT_CHARS,
			signal,
		});
		signal?.throwIfAborted();
		const postRunSnapshot = await captureGitWorktreeSnapshot(cwd, signal);
		signal?.throwIfAborted();
		if (result.status === 0 && !result.error && !result.timedOut) {
			state.gateAttempts[command] = 0;
			if (state.lastGateFailure?.command === command) {
				state.lastGateFailure = undefined;
				state.lastGateFailureSnapshot = undefined;
			}
			continue;
		}
		const attempt = (state.gateAttempts[command] ?? 0) + 1;
		state.gateAttempts[command] = attempt;
		const exitText = formatProcessExit(result);
		state.lastGateFailure = {
			command,
			attempt,
			exitText,
			output: truncateGateOutput(
				[result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
				result.outputTruncated,
			),
		};
		state.lastGateFailureSnapshot = postRunSnapshot;
		return attempt > state.gates.maxRetries ? "retry_exhausted" : "failed";
	}
	state.lastGateFailure = undefined;
	state.lastGateFailureSnapshot = undefined;
	return "passed";
}

export function buildAutonomousGateFailureContinuation(
	failure: AgentAutonomousGateFailure,
	maxRetries: number,
	timestamp = Date.now(),
): string {
	return (
		`[autonomous-continuation: gate-failed]\n\n` +
		`Autonomous quality gate failed (attempt ${failure.attempt}/${maxRetries}): \`${failure.command}\` ${failure.exitText}.\n` +
		(failure.output ? `\nOutput:\n${failure.output}\n` : "\n") +
		`\nContinue working. Fix the failure, then produce terminal evidence. Timestamp: ${new Date(timestamp).toISOString()}.`
	);
}

function buildGateFailureContinuation(state: AutonomousRuntimeState, timestamp: number): string | undefined {
	const failure = state.lastGateFailure;
	if (!failure) {
		return undefined;
	}
	return buildAutonomousGateFailureContinuation(failure, state.gates.maxRetries, timestamp);
}

function gitWorktreeSnapshotsEqual(a: GitWorktreeSnapshot | undefined, b: GitWorktreeSnapshot | undefined): boolean {
	return !!a && !!b && a.status === b.status && a.diff === b.diff && a.untrackedHash === b.untrackedHash;
}

async function captureGitWorktreeSnapshot(
	cwd: string | undefined,
	signal?: AbortSignal,
): Promise<GitWorktreeSnapshot | undefined> {
	signal?.throwIfAborted();
	if (!cwd) {
		return undefined;
	}
	const pathspec = [
		"--",
		".",
		":(exclude)verification",
		":(exclude)target",
		":(exclude).vf-prime-agent",
		":(exclude)Cargo.lock",
		":(exclude)submission.tar.gz",
		":(exclude)runner_args.log",
	];
	const status = await runChildProcess(
		"git",
		["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall", "--no-renames", ...pathspec],
		{
			cwd,
			timeoutMs: 10_000,
			signal,
		},
	);
	signal?.throwIfAborted();
	if (status.status !== 0 || status.error || status.timedOut || status.outputTruncated) {
		return undefined;
	}
	const diff = await runChildProcess(
		"git",
		["--no-optional-locks", "diff", "--no-ext-diff", "--binary", "HEAD", ...pathspec],
		{
			cwd,
			timeoutMs: 10_000,
			signal,
		},
	);
	signal?.throwIfAborted();
	if (diff.status !== 0 || diff.error || diff.timedOut || diff.outputTruncated) {
		return undefined;
	}
	return {
		status: status.stdout,
		diff: diff.stdout,
		untrackedHash: await hashUntrackedFiles(cwd, status.stdout, signal),
	};
}

function untrackedPathsFromStatus(status: string): string[] {
	return status
		.split("\0")
		.filter((entry) => entry.startsWith("?? "))
		.map((entry) => entry.slice(3))
		.sort();
}

async function hashUntrackedFiles(cwd: string, status: string, signal?: AbortSignal): Promise<string> {
	const aggregate = createHash("sha256");
	for (const path of untrackedPathsFromStatus(status)) {
		signal?.throwIfAborted();
		aggregate.update(path);
		aggregate.update("\0");
		aggregate.update(await hashUntrackedPath(resolve(cwd, path), signal));
		aggregate.update("\0");
	}
	signal?.throwIfAborted();
	return aggregate.digest("hex");
}

async function hashUntrackedPath(path: string, signal?: AbortSignal): Promise<string> {
	try {
		signal?.throwIfAborted();
		const stat = await lstat(path);
		signal?.throwIfAborted();
		if (stat.isSymbolicLink()) {
			const target = await readlink(path);
			signal?.throwIfAborted();
			return `symlink:${target}`;
		}
		if (!stat.isFile()) {
			return `other:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
		}
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path, { signal })) {
			hash.update(chunk);
		}
		signal?.throwIfAborted();
		return `file:${hash.digest("hex")}`;
	} catch (error) {
		signal?.throwIfAborted();
		return `error:${error instanceof Error ? error.message : String(error)}`;
	}
}

interface ChildProcessResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: Error;
	timedOut?: boolean;
	outputTruncated: boolean;
}

function runChildProcess(
	command: string,
	args: string[],
	options: {
		cwd?: string;
		shell?: boolean;
		timeoutMs?: number;
		maxOutputChars?: number;
		signal?: AbortSignal;
	} = {},
): Promise<ChildProcessResult> {
	options.signal?.throwIfAborted();
	return new Promise((resolve) => {
		const child = spawnHidden(command, args, {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			shell: options.shell === true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (child.pid) {
			trackDetachedChildPid(child.pid);
		}
		let stdout = "";
		let stderr = "";
		let error: Error | undefined;
		let timedOut = false;
		let outputTruncated = false;
		let settled = false;
		const maxOutputChars = options.maxOutputChars ?? MAX_CHILD_PROCESS_OUTPUT_CHARS;
		const finish = (result: Pick<ChildProcessResult, "status" | "signal">) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			options.signal?.removeEventListener("abort", abort);
			if (child.pid) {
				untrackDetachedChildPid(child.pid);
			}
			resolve({ ...result, stdout, stderr, error, timedOut, outputTruncated });
		};
		const timer = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					if (child.pid) {
						killProcessTree(child.pid);
					} else {
						child.kill("SIGKILL");
					}
				}, options.timeoutMs)
			: undefined;
		const abort = () => {
			if (child.pid) {
				killProcessTree(child.pid);
			} else {
				child.kill("SIGKILL");
			}
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) {
			abort();
		}
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			const remaining = maxOutputChars - stdout.length;
			if (remaining > 0) {
				stdout += chunk.slice(0, remaining);
			}
			outputTruncated ||= chunk.length > remaining;
		});
		child.stderr?.on("data", (chunk: string) => {
			const remaining = maxOutputChars - stderr.length;
			if (remaining > 0) {
				stderr += chunk.slice(0, remaining);
			}
			outputTruncated ||= chunk.length > remaining;
		});
		void waitForChildProcess(child).then(
			(status) => finish({ status, signal: child.signalCode }),
			(err: Error) => {
				error = err;
				finish({ status: child.exitCode, signal: child.signalCode });
			},
		);
	});
}

function formatProcessExit(result: ChildProcessResult): string {
	if (result.timedOut) {
		return "timed out";
	}
	if (result.error) {
		return result.error.message;
	}
	return result.signal ? `terminated by ${result.signal}` : `exited ${result.status ?? "unknown"}`;
}

function truncateGateOutput(output: string, outputAlreadyTruncated = false, maxChars = MAX_GATE_OUTPUT_CHARS): string {
	if (output.length <= maxChars && !outputAlreadyTruncated) {
		return output;
	}
	return `${output.slice(0, maxChars)}\n... [truncated]`;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) {
		return fallback;
	}
	return Math.trunc(value);
}
