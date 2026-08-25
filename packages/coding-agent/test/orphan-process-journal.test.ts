import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearOrphanProcessJournal,
	isOrphanProcessIdentityCurrent,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
	reapKernelOrphanProcesses,
	recordOrphanProcessState,
	shouldReapOrphanProcess,
} from "../src/core/orphan-process-journal.js";
import { getProcessStartId } from "../src/core/session-lease.js";

const tempDirs: string[] = [];
const originalJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];

afterEach(() => {
	if (originalJournalPath === undefined) {
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	} else {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = originalJournalPath;
	}
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("orphan process journal", () => {
	it("retains only detached processes still active for the crashed owner", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		recordOrphanProcessState(process.pid, true);

		const active = readActiveOrphanProcesses(path, process.pid);
		expect(active).toHaveLength(1);
		expect(active[0]?.pid).toBe(process.pid);
		expect(active[0] && isOrphanProcessIdentityCurrent(active[0])).toBe(true);
		expect(readActiveOrphanProcesses(path, process.pid + 1)).toEqual([]);

		recordOrphanProcessState(process.pid, false);
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
		clearOrphanProcessJournal(path);
		expect(existsSync(path)).toBe(false);
	});

	it("reaps only the given kernel's still-active bash children", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		// Stands in for a detached bash() child: own session so SIGKILL of the group is observable.
		const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		child.unref();
		const childPid = child.pid;
		expect(childPid).toBeTypeOf("number");
		const kernelPid = 999_999;
		const appendRecord = (pid: number, recordKernelPid: number) => {
			appendFileSync(
				path,
				`${JSON.stringify({
					version: 1,
					pid,
					ownerPid: process.pid,
					kernelPid: recordKernelPid,
					processStartId: getProcessStartId(pid),
					active: true,
					recordedAt: new Date().toISOString(),
				})}\n`,
			);
		};
		appendRecord(childPid!, kernelPid);
		// A sibling kernel's record and the kernel's own pid record must be untouched.
		appendRecord(process.pid, kernelPid + 1);
		appendRecord(kernelPid, kernelPid);

		reapKernelOrphanProcesses(kernelPid);
		// Double reaping an already-dead pid must be a no-op.
		reapKernelOrphanProcesses(kernelPid);

		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await exited;
		expect(child.signalCode).toBe("SIGKILL");
		const remaining = readActiveOrphanProcesses(path, process.pid).map((orphan) => orphan.pid);
		expect(remaining).not.toContain(childPid);
		expect(remaining).toContain(process.pid);
	});

	it("accepts pid-only active records and lets enriched records supersede them", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const appendRecord = (record: Record<string, unknown>) => {
			appendFileSync(path, `${JSON.stringify(record)}\n`);
		};
		const base = { version: 1, pid: process.pid, ownerPid: process.pid, recordedAt: new Date().toISOString() };

		// Pid-only pre-record (Windows pre-enrollment window): returned, never identity-current.
		appendRecord({ ...base, active: true });
		let active = readActiveOrphanProcesses(path, process.pid);
		expect(active).toHaveLength(1);
		expect(active[0]?.processStartId).toBeUndefined();
		expect(active[0] && isOrphanProcessIdentityCurrent(active[0])).toBe(false);

		// The enriched record supersedes the pid-only one (last record per pid wins).
		appendRecord({ ...base, active: true, processStartId: getProcessStartId(process.pid) });
		active = readActiveOrphanProcesses(path, process.pid);
		expect(active).toHaveLength(1);
		expect(active[0]?.processStartId).toBeTypeOf("string");
		expect(active[0] && isOrphanProcessIdentityCurrent(active[0])).toBe(true);

		// An inactive record supersedes both.
		appendRecord({ ...base, active: false });
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
	});

	// POSIX behavior: CI runs Ubuntu, so this exercises the real kill path.
	it("best-effort kills pid-only records in the kernel crash-reap path", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		child.unref();
		const childPid = child.pid;
		expect(childPid).toBeTypeOf("number");
		const kernelPid = 999_999;
		// Pid-only record: the kernel crashed before the start-id query landed.
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				pid: childPid,
				ownerPid: process.pid,
				kernelPid,
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		reapKernelOrphanProcesses(kernelPid);

		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await exited;
		expect(child.signalCode).toBe("SIGKILL");
	});

	it("win32 reapers ignore identity-free records", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		child.unref();
		const childPid = child.pid;
		expect(childPid).toBeTypeOf("number");
		const kernelPid = 999_999;
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				pid: childPid,
				ownerPid: process.pid,
				kernelPid,
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { value: "win32" });
			expect(shouldReapOrphanProcess({ pid: childPid!, kernelPid })).toBe(false);
			// The kernel's kill-on-close job already reaped the tree; a bare-pid
			// taskkill could only hit a reused pid, so the reaper must skip it.
			reapKernelOrphanProcesses(kernelPid);
		} finally {
			if (originalPlatform) {
				Object.defineProperty(process, "platform", originalPlatform);
			}
		}

		expect(child.exitCode).toBeNull();
		expect(child.signalCode).toBeNull();
		process.kill(childPid!, "SIGKILL");
	});
});
