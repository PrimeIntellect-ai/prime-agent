import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
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
	processStartId: string;
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
	return [...latest.values()]
		.filter(
			(record): record is OrphanProcessRecord & { processStartId: string } =>
				record.active && typeof record.processStartId === "string",
		)
		.map((record) => ({
			pid: record.pid,
			...(Number.isInteger(record.kernelPid) ? { kernelPid: record.kernelPid } : {}),
			processStartId: record.processStartId,
		}));
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	return getProcessStartId(orphan.pid) === orphan.processStartId;
}

export function clearOrphanProcessJournal(path: string): void {
	rmSync(path, { force: true });
}

// Kills still-active bash() children journaled by the given kernel pid; sibling kernels' records are untouched.
export function reapKernelOrphanProcesses(kernelPid: number): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(kernelPid) || kernelPid <= 0) {
		return;
	}
	let orphans: ActiveOrphanProcess[];
	try {
		orphans = readActiveOrphanProcesses(path, process.pid);
	} catch {
		return;
	}
	for (const orphan of orphans) {
		if (orphan.kernelPid !== kernelPid || orphan.pid === kernelPid) {
			continue;
		}
		if (!isOrphanProcessIdentityCurrent(orphan)) {
			continue;
		}
		let signaled = false;
		if (process.platform === "win32") {
			// In-kernel bash() kill paths use taskkill /T; the reaper must kill the same tree, not just the shell pid.
			const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(orphan.pid)], {
				stdio: "ignore",
				timeout: 10_000,
			});
			signaled = result.status === 0;
		} else {
			try {
				process.kill(-orphan.pid, "SIGKILL");
				signaled = true;
			} catch {
				try {
					process.kill(orphan.pid, "SIGKILL");
					signaled = true;
				} catch {
					// The bash child may already have exited.
				}
			}
		}
		// Inactive only after a delivered signal; a stale record is neutralized by the startId check.
		if (signaled) {
			recordOrphanProcessState(orphan.pid, false);
		}
	}
}
