import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { getShellConfig } from "./shell.js";

export const WORKTREE_SETUP_ENV_VAR = "PRIME_AGENT_WORKTREE_SETUP";
export const WORKTREE_SETUP_TIMEOUT_ENV_VAR = "PRIME_AGENT_WORKTREE_SETUP_TIMEOUT_MS";
export const DEFAULT_WORKTREE_SETUP_TIMEOUT_MS = 600_000;
const ERROR_OUTPUT_LINES = 5;

export interface WorktreeSetupCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
}

export interface WorktreeSetupCommand {
	command: string;
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	shellPath?: string;
}

export type WorktreeSetupRunner = (command: WorktreeSetupCommand) => Promise<WorktreeSetupCommandResult>;

export interface RunWorktreeSetupOptions {
	/** Script path (absolute, or relative to the repo root) or an inline shell command. */
	script: string;
	worktreePath: string;
	branch: string;
	repoRoot: string;
	timeoutMs?: number;
	shellPath?: string;
	/** Full stdout and stderr are written here; the path is reported on failure. */
	logPath?: string;
	runSetup?: WorktreeSetupRunner;
	fileExists?: (path: string) => boolean;
	writeLog?: (path: string, contents: string) => void;
}

export interface WorktreeSetupResult {
	command: string;
	output: string;
	logPath?: string;
}

export class WorktreeSetupError extends Error {
	constructor(
		message: string,
		readonly logPath: string | undefined,
		readonly timedOut: boolean,
	) {
		super(message);
		this.name = "WorktreeSetupError";
	}
}

export const runWorktreeSetupCommand: WorktreeSetupRunner = async (command) => {
	const shell = getShellConfig(command.shellPath);
	try {
		const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
			execFile(
				shell.shell,
				[...shell.args, command.command],
				{
					cwd: command.cwd,
					env: command.env,
					encoding: "utf-8",
					timeout: command.timeoutMs,
					maxBuffer: 16 * 1024 * 1024,
				},
				(error, stdout, stderr) => {
					if (error) {
						reject(Object.assign(error, { stdout, stderr }));
						return;
					}
					resolvePromise({ stdout, stderr });
				},
			);
		});
		return { stdout, stderr, exitCode: 0, timedOut: false };
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message ?? "",
			exitCode: typeof failure.code === "number" ? failure.code : 1,
			timedOut: failure.killed === true,
		};
	}
};

/** Env var wins over the settings value so a single run can override the configured script. */
export function resolveWorktreeSetupScript(configured?: string): string | undefined {
	const script = process.env[WORKTREE_SETUP_ENV_VAR]?.trim() || configured?.trim();
	return script ? script : undefined;
}

export function resolveWorktreeSetupTimeoutMs(configured?: number): number {
	const fromEnv = Number.parseInt(process.env[WORKTREE_SETUP_TIMEOUT_ENV_VAR] ?? "", 10);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
	if (configured !== undefined && Number.isFinite(configured) && configured > 0) return configured;
	return DEFAULT_WORKTREE_SETUP_TIMEOUT_MS;
}

/**
 * A value that names an existing file runs as that script; anything else runs
 * verbatim as a shell command. Relative paths resolve against the repo root.
 */
export function buildWorktreeSetupCommand(
	script: string,
	repoRoot: string,
	fileExists: (path: string) => boolean = existsSync,
): string {
	const trimmed = script.trim();
	const candidate = isAbsolute(trimmed) ? trimmed : resolve(repoRoot, trimmed);
	return fileExists(candidate) ? `"${candidate}"` : trimmed;
}

export function createWorktreeSetupEnv(context: {
	worktreePath: string;
	branch: string;
	repoRoot: string;
}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env.PRIME_AGENT_WORKTREE_PATH = context.worktreePath;
	env.PRIME_AGENT_WORKTREE_BRANCH = context.branch;
	env.PRIME_AGENT_WORKTREE_REPO_ROOT = context.repoRoot;
	return env;
}

function lastOutputLines(result: WorktreeSetupCommandResult): string {
	const source = result.stderr.trim() || result.stdout.trim();
	return source.split("\n").slice(-ERROR_OUTPUT_LINES).join(" ").trim();
}

function defaultWriteLog(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, "utf-8");
}

/**
 * Run the configured setup script inside a freshly created worktree.
 * Throws WorktreeSetupError on timeout or non-zero exit; the worktree is kept.
 */
export async function runWorktreeSetup(options: RunWorktreeSetupOptions): Promise<WorktreeSetupResult> {
	const runSetup = options.runSetup ?? runWorktreeSetupCommand;
	const writeLog = options.writeLog ?? defaultWriteLog;
	const timeoutMs = resolveWorktreeSetupTimeoutMs(options.timeoutMs);
	const command = buildWorktreeSetupCommand(options.script, options.repoRoot, options.fileExists);
	const result = await runSetup({
		command,
		cwd: options.worktreePath,
		env: createWorktreeSetupEnv(options),
		timeoutMs,
		shellPath: options.shellPath,
	});

	const output = `$ ${command}\n${result.stdout}${result.stderr}`;
	let logPath = options.logPath;
	if (logPath) {
		try {
			writeLog(logPath, output);
		} catch {
			// A missing log must not mask the setup outcome.
			logPath = undefined;
		}
	}
	if (result.timedOut) {
		throw new WorktreeSetupError(
			`Worktree setup timed out after ${timeoutMs}ms${logPath ? `; log: ${logPath}` : ""}`,
			logPath,
			true,
		);
	}
	if (result.exitCode !== 0) {
		const detail = lastOutputLines(result);
		throw new WorktreeSetupError(
			`Worktree setup exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}${
				logPath ? `; log: ${logPath}` : ""
			}`,
			logPath,
			false,
		);
	}
	return { command, output, logPath };
}
