import { type ChildProcess, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { basename } from "node:path";

const EXIT_STDIO_GRACE_MS = 100;

const WINDOWS_SHELL_COMMANDS = new Set(["npm", "npx", "pnpm", "yarn", "yarnpkg", "corepack"]);

export function shouldUseWindowsShell(command: string): boolean {
	if (process.platform !== "win32") return false;
	const commandName = basename(command).toLowerCase();
	return commandName.endsWith(".cmd") || commandName.endsWith(".bat") || WINDOWS_SHELL_COMMANDS.has(commandName);
}

/** Cheap kill(0) existence probe; counts zombies as existing. */
export function processIdExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A zombie has already exited; it only lingers until its parent reaps it. */
export function isZombieProcess(pid: number): boolean {
	if (process.platform === "win32") {
		return false;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trimStart()
			.charAt(0);
		return state === "Z";
	} catch {
		// Fall through to the portable process listing used on macOS and BSD.
	}
	try {
		const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
		return state.startsWith("Z");
	} catch {
		return false;
	}
}

/** True only for a process that is actually running: zombies do not count. */
export function isProcessAlive(pid: number): boolean {
	return processIdExists(pid) && !isZombieProcess(pid);
}

export function signalProcessGroupOrProcess(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
		return;
	} catch {
		// Fall back when process groups are unavailable or the group already exited.
	}
	try {
		process.kill(pid, signal);
	} catch {
		// The process may already be fully reaped.
	}
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * On Windows, daemonized descendants can inherit the child's stdout/stderr pipe
 * handles. In that case the child emits `exit`, but `close` can hang forever even
 * though the original process is already gone. We wait briefly for stdio to end,
 * then forcibly stop tracking the inherited handles.
 */
function signalExitCode(signal: NodeJS.Signals | null): number | null {
	if (!signal) return null;
	const signalNumber = constants.signals[signal];
	return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function normalizedExitCode(code: number | null, signal: NodeJS.Signals | null): number | null {
	return code ?? signalExitCode(signal);
}

export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null || child.stdout.readableEnded;
		let stderrEnded = child.stderr === null || child.stderr.readableEnded;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(normalizedExitCode(exitCode, exitSignal));
			}
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalizeAfterExit();
			if (!settled) {
				postExitTimer = setTimeout(() => finalize(normalizedExitCode(code, signal)), EXIT_STDIO_GRACE_MS);
			}
		};

		const onClose = (code: number | null, signal: NodeJS.Signals | null = null) => {
			finalize(normalizedExitCode(code, signal));
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);

		if (child.exitCode !== null || child.signalCode !== null) {
			onExit(child.exitCode, child.signalCode);
		}
	});
}
