import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { spawnSync } from "child_process";
import { getBinDir } from "../config.js";
import { recordOrphanProcessState } from "../core/orphan-process-journal.js";
import { signalProcessGroupOrProcess } from "./child-process.js";

export interface ShellConfig {
	shell: string;
	args: string[];
}

/** Canonical Git for Windows locations. PATH is not trusted for shell selection. */
const WINDOWS_GIT_BASH_PATHS = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];

function findBashOnPath(): string | null {
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			return result.stdout.trim().split(/\r?\n/)[0] || null;
		}
	} catch {
		// Fall through to sh.
	}
	return null;
}

/** Resolve the configured shell without selecting WSL, Cygwin, or MSYS2 implicitly. */
export function getShellConfig(customShellPath?: string): ShellConfig {
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		for (const shellPath of WINDOWS_GIT_BASH_PATHS) {
			if (existsSync(shellPath)) {
				return { shell: shellPath, args: ["-c"] };
			}
		}
		throw new Error(
			`Git Bash not found. Install Git for Windows from https://git-scm.com/download/win. ` +
				`Set shellPath in settings.json for a nonstandard installation.\n\n` +
				`Searched:\n${WINDOWS_GIT_BASH_PATHS.map((shellPath) => `  ${shellPath}`).join("\n")}`,
		);
	}

	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}
	const bashOnPath = findBashOnPath();
	return bashOnPath ? { shell: bashOnPath, args: ["-c"] } : { shell: "sh", args: ["-c"] };
}

/**
 * Absolute default shell for the persistent kernel. An explicit shellPath wins.
 * Windows defaults only to canonical Git for Windows locations.
 */
export function resolveKernelBashShell(customShellPath?: string): string | undefined {
	const explicit = customShellPath?.trim();
	if (explicit) {
		return explicit;
	}
	if (process.platform !== "win32") {
		return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
	}
	return WINDOWS_GIT_BASH_PATHS.find((shellPath) => existsSync(shellPath));
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
	recordOrphanProcessState(pid, true);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
	recordOrphanProcessState(pid, false);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
		recordOrphanProcessState(pid, false);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	signalProcessGroupOrProcess(pid, "SIGKILL");
}
