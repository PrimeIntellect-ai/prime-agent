import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { win32 } from "node:path";
import { execFileHidden, execFileSyncHidden, spawnSyncHidden } from "../utils/child-process.js";
import { getProcessStartId } from "./session-lease.js";

export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	/** Set on records written by a kernel (e.g. bash() children) so the host can reap per kernel. */
	kernelPid?: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

export interface ActiveOrphanProcess {
	pid: number;
	kernelPid?: number;
	/** Missing on identity-free records: old journals or host writes whose start-id query failed (kernels no longer write pid-only records). */
	processStartId?: string;
}

export function recordOrphanProcessState(pid: number, active: boolean): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(pid) || pid <= 0) {
		return;
	}
	const processStartId = active ? getProcessStartId(pid) : undefined;
	const record: OrphanProcessRecord = {
		version: 1,
		pid,
		ownerPid: process.pid,
		...(processStartId ? { processStartId } : {}),
		active,
		recordedAt: new Date().toISOString(),
	};
	try {
		const descriptor = openSync(path, "a", 0o600);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	} catch {
		// Process tracking must not make a successfully spawned command fail.
	}
}

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const latest = new Map<number, OrphanProcessRecord>();
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		try {
			const record = JSON.parse(line) as Partial<OrphanProcessRecord>;
			if (
				record.version === 1 &&
				Number.isInteger(record.pid) &&
				(record.pid ?? 0) > 0 &&
				record.ownerPid === ownerPid &&
				typeof record.active === "boolean" &&
				typeof record.recordedAt === "string"
			) {
				latest.set(record.pid!, record as OrphanProcessRecord);
			}
		} catch {
			// A crash can truncate only the final append.
		}
	}
	// Pid-only actives (no processStartId) still surface from old journals or
	// host writes whose start-id query failed; reapers decide per-platform.
	return [...latest.values()]
		.filter(
			(record) =>
				record.active && (record.processStartId === undefined || typeof record.processStartId === "string"),
		)
		.map((record) => ({
			pid: record.pid,
			...(Number.isInteger(record.kernelPid) ? { kernelPid: record.kernelPid } : {}),
			...(typeof record.processStartId === "string" ? { processStartId: record.processStartId } : {}),
		}));
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	// Pid-only records can never claim identity (undefined === undefined must not match).
	return orphan.processStartId !== undefined && getProcessStartId(orphan.pid) === orphan.processStartId;
}

/**
 * Identity-free records cannot prove the pid still names the journaled process.
 * On win32 the kernel's kill-on-close job already reaped its tree when it died,
 * so a bare-pid taskkill only risks killing a reused pid. POSIX keeps the
 * best-effort kill (group-scoped, and the spawn gate makes pid-only actives
 * host-written rarities there).
 */
export function shouldReapOrphanProcess(orphan: ActiveOrphanProcess): boolean {
	if (orphan.processStartId === undefined) {
		return process.platform !== "win32";
	}
	return isOrphanProcessIdentityCurrent(orphan);
}

export function clearOrphanProcessJournal(path: string): void {
	rmSync(path, { force: true });
}

function readKernelOrphanProcesses(kernelPid: number): ActiveOrphanProcess[] {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(kernelPid) || kernelPid <= 0) {
		return [];
	}
	let orphans: ActiveOrphanProcess[];
	try {
		orphans = readActiveOrphanProcesses(path, process.pid);
	} catch {
		return [];
	}
	return orphans.filter((orphan) => orphan.kernelPid === kernelPid && orphan.pid !== kernelPid);
}

// Kills still-active bash() children journaled by the given kernel pid; sibling kernels' records are untouched.
export async function reapKernelOrphanProcesses(kernelPid: number): Promise<void> {
	for (const orphan of readKernelOrphanProcesses(kernelPid)) {
		if (process.platform === "win32") {
			// Both the identity query and taskkill can be slow. Keep them off the
			// daemon event loop while preserving the start-id guard against pid reuse.
			if (await reapWindowsOrphanProcess(orphan)) recordOrphanProcessState(orphan.pid, false);
			continue;
		}
		if (!shouldReapOrphanProcess(orphan)) {
			continue;
		}
		// Inactive only after a delivered signal; a stale record is neutralized by the startId check.
		if (killOrphanProcess(orphan.pid)) {
			recordOrphanProcessState(orphan.pid, false);
		}
	}
}

/** Synchronous variant for process.on("exit"), where async work cannot finish. */
export function reapKernelOrphanProcessesSync(kernelPid: number): void {
	for (const orphan of readKernelOrphanProcesses(kernelPid)) {
		const reaped =
			process.platform === "win32"
				? reapWindowsOrphanProcessSync(orphan)
				: shouldReapOrphanProcess(orphan) && killOrphanProcess(orphan.pid);
		if (reaped) recordOrphanProcessState(orphan.pid, false);
	}
}

function runWindowsReaperCommand(executable: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			execFileHidden(
				executable,
				args,
				{
					encoding: "utf8",
					timeout: 10_000,
					env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
				},
				(error, stdout) => resolve(error ? undefined : stdout),
			);
		} catch {
			resolve(undefined);
		}
	});
}

async function reapWindowsOrphanProcess(orphan: ActiveOrphanProcess): Promise<boolean> {
	if (!orphan.processStartId?.match(/^win:\d+$/)) return false;
	const system32 = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
	const ticks = await runWindowsReaperCommand(win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"), [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`([System.Diagnostics.Process]::GetProcessById(${orphan.pid})).StartTime.ToUniversalTime().Ticks`,
	]);
	if (ticks === undefined || `win:${ticks.trim()}` !== orphan.processStartId) return false;
	return (
		(await runWindowsReaperCommand(win32.join(system32, "taskkill.exe"), [
			"/F",
			"/T",
			"/PID",
			String(orphan.pid),
		])) !== undefined
	);
}

function reapWindowsOrphanProcessSync(orphan: ActiveOrphanProcess): boolean {
	if (!orphan.processStartId?.match(/^win:\d+$/)) return false;
	const system32 = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
	let ticks: string;
	try {
		ticks = execFileSyncHidden(
			win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`([System.Diagnostics.Process]::GetProcessById(${orphan.pid})).StartTime.ToUniversalTime().Ticks`,
			],
			{
				encoding: "utf8",
				timeout: 10_000,
				env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
			},
		);
	} catch {
		return false;
	}
	return `win:${ticks.trim()}` === orphan.processStartId && killOrphanProcess(orphan.pid);
}

// Hardened cross-platform tree kill for journaled orphans: absolute System32
// taskkill /T on win32 (a bare name could resolve a planted CWD taskkill.exe),
// process-group then pid SIGKILL elsewhere.
export function killOrphanProcess(pid: number): boolean {
	if (process.platform === "win32") {
		// In-kernel bash() kill paths use taskkill /T; the reaper must kill the same tree, not just the shell pid.
		const result = spawnSyncHidden(
			win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
			["/F", "/T", "/PID", String(pid)],
			{
				stdio: "ignore",
				timeout: 10_000,
				env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
			},
		);
		return result.status === 0;
	}
	try {
		process.kill(-pid, "SIGKILL");
		return true;
	} catch {
		try {
			process.kill(pid, "SIGKILL");
			return true;
		} catch {
			// The orphan may already have exited.
		}
	}
	return false;
}
