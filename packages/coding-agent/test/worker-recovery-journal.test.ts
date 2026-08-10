import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";

describe("WorkerRecoveryJournal", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-worker-recovery-"));
		roots.push(root);
		return join(root, "worker.recovery.jsonl");
	}

	it("restores the latest operation state per session", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			busy: true,
			operation: "prompt_accepted",
		});
		journal.record({
			activeSessionId: "active-2",
			sessionId: "session-2",
			busy: false,
			operation: "ready",
		});

		expect(WorkerRecoveryJournal.readLatest(path)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ activeSessionId: "active-1", busy: true, operation: "prompt_accepted" }),
				expect.objectContaining({ activeSessionId: "active-2", busy: false, operation: "ready" }),
			]),
		);
	});

	it("repairs a truncated final append before accepting another record", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: true,
			operation: "bash_start",
		});
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: false,
			operation: "bash_end",
		});
		appendFileSync(path, "{truncated");

		const recovered = new WorkerRecoveryJournal(path);
		recovered.record({
			activeSessionId: "active-2",
			sessionId: "session-2",
			busy: true,
			operation: "prompt_accepted",
		});

		expect(readFileSync(path, "utf8")).not.toContain("{truncated");
		expect(WorkerRecoveryJournal.readLatest(path)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ activeSessionId: "active-1", busy: false, operation: "bash_end" }),
				expect.objectContaining({ activeSessionId: "active-2", busy: true, operation: "prompt_accepted" }),
			]),
		);
	});

	it("accepts a complete final record without a line feed and restores the append boundary", () => {
		const path = createPath();
		const record = {
			version: 1,
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: true,
			operation: "tool_execution_start",
			recordedAt: new Date().toISOString(),
		};
		writeFileSync(path, JSON.stringify(record));

		const journal = new WorkerRecoveryJournal(path);
		expect(journal.getLatest()).toEqual([expect.objectContaining(record)]);
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
	});

	it("fails closed on malformed complete records", () => {
		const path = createPath();
		const valid = JSON.stringify({
			version: 1,
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: true,
			operation: "prompt_accepted",
			recordedAt: new Date().toISOString(),
		});
		writeFileSync(path, `${valid}\n{malformed}\n`);

		expect(() => new WorkerRecoveryJournal(path)).toThrow("line 2");
		expect(() => WorkerRecoveryJournal.readLatest(path)).toThrow("line 2");
	});

	it("does not deduplicate a reused active id with a different stable session id", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: true,
			operation: "prompt_accepted",
		});
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-2",
			busy: true,
			operation: "prompt_accepted",
		});

		expect(WorkerRecoveryJournal.readLatest(path)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", sessionId: "session-2" }),
		]);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
	});
});
