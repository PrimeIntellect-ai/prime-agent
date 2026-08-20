import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { waitForChildProcess } from "../utils/child-process.js";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.js";

export interface AgentAutonomousConfig {
	enabled?: boolean;
	maxContinuations?: number;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	continuationPrompt?: string;
	gates?: AgentAutonomousGateConfig;
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
	limits: Required<Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt" | "gates">>;
	gates: Required<AgentAutonomousGateConfig>;
	gateAttempts: Record<string, number>;
	lastGateFailure?: AgentAutonomousGateFailure;
}

export const DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT =
	"No human input is available in autonomous mode. Continue working until the host evaluator, verifier, or configured autonomous limits stop the run. If you were asking the user a question, make a reasonable assumption and verify it. If you believe you are blocked, prove it with host-observable evidence, preserve that evidence, and keep looking for safe progress while budget remains. Do not end the session yourself; the verifier/evaluator decides completion when configured gates pass.";

export const DEFAULT_AUTONOMOUS_LIMITS: Required<
	Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt" | "gates">
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

const MAX_GATE_OUTPUT_CHARS = 6000;
const MAX_CHILD_PROCESS_OUTPUT_CHARS = 1024 * 1024;

export interface AutonomousRuntimeState {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: Required<Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt" | "gates">>;
	continuationPrompt: string;
	gates: Required<AgentAutonomousGateConfig>;
	gateAttempts: Record<string, number>;
	lastGateFailure?: GateFailure;
	lastGateFailureSnapshot?: GitWorktreeSnapshot;
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

export function createAutonomousRuntimeState(
	config?: AgentAutonomousConfig,
	_options: { cwd?: string } = {},
): AutonomousRuntimeState {
	const enabled = config?.enabled === true;
	return {
		enabled,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		startedAt: enabled ? Date.now() : undefined,
		limits: {
			maxContinuations: normalizeLimit(config?.maxContinuations, DEFAULT_AUTONOMOUS_LIMITS.maxContinuations),
			maxTurns: normalizeLimit(config?.maxTurns, DEFAULT_AUTONOMOUS_LIMITS.maxTurns),
			maxTokens: normalizeLimit(config?.maxTokens, DEFAULT_AUTONOMOUS_LIMITS.maxTokens),
			timeoutMs: normalizeLimit(config?.timeoutMs, DEFAULT_AUTONOMOUS_LIMITS.timeoutMs),
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
	};
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
	};
}

export function addAutonomousUsage(state: AutonomousRuntimeState, usage: Usage | undefined): void {
	if (!state.enabled) {
		return;
	}
	state.turnsUsed++;
	state.tokensUsed += autonomousTokenDelta(usage);
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
	return {
		role: "user",
		content: [
			{
				type: "text",
				text:
					decision.reason === "gate_failed"
						? (buildGateFailureContinuation(state, now) ?? state.continuationPrompt)
						: state.continuationPrompt,
			},
		],
		timestamp: now,
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
		const child = spawn(command, args, {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			shell: options.shell === true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: process.platform === "win32",
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
