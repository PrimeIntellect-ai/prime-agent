/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.js";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/**
	 * Extra env vars merged over the parent process env for this command.
	 * A key with an undefined value is unset in the child.
	 */
	env?: Record<string, string | undefined>;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

function mergeExecEnv(env?: Record<string, string | undefined>): NodeJS.ProcessEnv | undefined {
	if (!env) {
		return undefined;
	}
	const merged: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete merged[key];
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			// Merge per-call env over the parent env so callers can scope vars
			// (e.g. herdr pane identity) without mutating the shared process.env.
			env: mergeExecEnv(options?.env),
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillTimeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				forceKillTimeoutId = setTimeout(() => {
					forceKillTimeoutId = undefined;
					if (proc.exitCode === null && proc.signalCode === null) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			if (forceKillTimeoutId) clearTimeout(forceKillTimeoutId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
		};

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				cleanup();
				resolve({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch((_err) => {
				cleanup();
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
