import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function createPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
	tempDirs.push(directory);
	return join(directory, "orphans.jsonl");
}

function record(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		version: 1,
		pid: process.pid,
		ownerPid: process.pid,
		processStartId: "start-1",
		active: true,
		recordedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("orphan process journal", () => {
	it("retains only detached processes still active for the crashed owner", () => {
		const path = createPath();
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		recordOrphanProcessState(process.pid, true);

		const active = readActiveOrphanProcesses(path, process.pid);
		expect(active).toHaveLength(1);
		expect(active[0]?.pid).toBe(process.pid);
		expect(active[0] && isOrphanProcessIdentityCurrent(active[0])).toBe(true);
		expect(readActiveOrphanProcesses(path, process.pid + 1)).toEqual([]);
		expect(statSync(path).mode & 0o777).toBe(0o600);

		recordOrphanProcessState(process.pid, false);
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
		clearOrphanProcessJournal(path);
		expect(existsSync(path)).toBe(false);
	});

	it("ignores one truncated final append and skips damaged records without hiding later state", () => {
		const path = createPath();
		writeFileSync(path, `${JSON.stringify(record())}\n{truncated`);
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([
			expect.objectContaining({ pid: process.pid, processStartId: "start-1" }),
		]);

		writeFileSync(
			path,
			`${JSON.stringify(record())}\n{malformed}\n${JSON.stringify(record({ active: false, processStartId: undefined }))}\n`,
		);
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
	});

	it("repairs a truncated tail before the next best-effort append", () => {
		const path = createPath();
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		writeFileSync(path, `${JSON.stringify(record())}\n{truncated`);

		recordOrphanProcessState(process.pid, false);

		const contents = readFileSync(path, "utf8");
		expect(contents).not.toContain("{truncated");
		expect(contents.endsWith("\n")).toBe(true);
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
	});

	it("keeps a complete final record without a line feed and separates the next append", () => {
		const path = createPath();
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		writeFileSync(path, JSON.stringify(record()));

		recordOrphanProcessState(process.pid, false);

		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
	});

	it("does not let an incomplete tail swallow a later active record", () => {
		const path = createPath();
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		appendFileSync(path, "{partial");

		recordOrphanProcessState(process.pid, true);

		expect(readFileSync(path, "utf8")).not.toContain("{partial");
		expect(readActiveOrphanProcesses(path, process.pid)).toHaveLength(1);
	});
});
