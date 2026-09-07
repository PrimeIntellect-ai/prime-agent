/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { signalProcessGroupOrProcess, spawnHidden, waitForChildProcess } from "../utils/child-process.js";

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
		const proc = spawnHidden(command, args, {
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
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillTimeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				if (process.platform === "win32" && proc.pid) {
					signalProcessGroupOrProcess(proc.pid, "SIGTERM");
				} else {
					proc.kill("SIGTERM");
				}
				forceKillTimeoutId = setTimeout(() => {
					forceKillTimeoutId = undefined;
					if (proc.exitCode === null && proc.signalCode === null) {
						if (proc.pid) {
							signalProcessGroupOrProcess(proc.pid, "SIGKILL", (error) => {
								if (proc.exitCode !== null || proc.signalCode !== null) return;
								finish({
									stdout,
									stderr: `${stderr}\nCould not terminate owned process ${proc.pid}; it may still be running: ${error.message}`,
									code: 1,
									killed: false,
								});
							});
						}
					}
				}, 5000);
			}
		};

		proc.stdout?.on("data", (data) => {
			if (!settled) stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			if (!settled) stderr += data.toString();
		});

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			if (forceKillTimeoutId) clearTimeout(forceKillTimeoutId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
		};

		const finish = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
			stdout = "";
			stderr = "";
		};

		// Failed cancellation settles the result, not ownership: keep draining and waiting for real exit.
		waitForChildProcess(proc)
			.then((code) => {
				finish({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch((_err) => {
				finish({ stdout, stderr, code: 1, killed });
			});

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
	});
}
