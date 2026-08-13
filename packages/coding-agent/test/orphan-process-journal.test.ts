import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearOrphanProcessJournal,
	isOrphanProcessIdentityCurrent,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
	recordOrphanProcessState,
} from "../src/core/orphan-process-journal.js";

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

		expect(recordOrphanProcessState(process.pid, true)).toMatchObject({ status: "owned", pid: process.pid });

		const active = readActiveOrphanProcesses(path, process.pid);
		expect(active).toHaveLength(1);
		expect(active[0]?.pid).toBe(process.pid);
		expect(active[0] && isOrphanProcessIdentityCurrent(active[0])).toBe(true);
		expect(readActiveOrphanProcesses(path, process.pid + 1)).toEqual([]);

		expect(recordOrphanProcessState(process.pid, false)).toMatchObject({ status: "released", pid: process.pid });
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
		clearOrphanProcessJournal(path);
		expect(existsSync(path)).toBe(false);
	});

	it("reports untracked and uncertain ownership instead of silently pretending cleanup is safe", () => {
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		expect(recordOrphanProcessState(process.pid, true)).toMatchObject({ status: "untracked" });

		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-broken-"));
		tempDirs.push(directory);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = directory;
		expect(recordOrphanProcessState(process.pid, true)).toMatchObject({ status: "uncertain" });
	});
});
