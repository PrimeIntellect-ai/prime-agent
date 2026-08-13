import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isV2WorkerRecoveryRecord,
	WorkerRecoveryJournal,
	type WorkerRecoveryRecordV2,
} from "../src/modes/daemon/worker-recovery-journal.js";

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

	/** Raw persisted lines; readLatest collapses to one record per session. */
	function fileLines(path: string): string[] {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
	}

	const v2Authority = {
		agentDir: "/custom/agent/dir",
		sessionFile: "/tmp/session-1.jsonl",
		headEntryId: "entry-9",
		assistantEntryId: "entry-8",
		toolCalls: [{ id: "tool_call_42", name: "bash" }],
		lineageDigest: "a".repeat(64),
	};

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

	it("compacts stable checkpoints and ignores a truncated final record", () => {
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

		expect(WorkerRecoveryJournal.readLatest(path)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: false, operation: "bash_end" }),
		]);
	});

	it("records a validated v2 authority checkpoint and preserves tool event identity", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			...v2Authority,
			busy: true,
			operation: "tool_execution_start",
		});

		const latest = WorkerRecoveryJournal.readLatest(path);
		expect(latest).toHaveLength(1);
		const record = latest[0]!;
		expect(record.version).toBe(2);
		expect(isV2WorkerRecoveryRecord(record)).toBe(true);
		expect(record).toMatchObject({
			activeSessionId: "active-1",
			sessionId: "session-1",
			agentDir: "/custom/agent/dir",
			sessionFile: "/tmp/session-1.jsonl",
			busy: true,
			operation: "tool_execution_start",
			headEntryId: "entry-9",
			assistantEntryId: "entry-8",
			toolCalls: [{ id: "tool_call_42", name: "bash" }],
			lineageDigest: "a".repeat(64),
		});
		expect(record.recordedAt).toEqual(expect.any(String));
		if (isV2WorkerRecoveryRecord(record)) {
			expect(record.operationId).toMatch(/^[0-9a-f-]{36}$/);
		}
	});

	it("keeps one stable operationId per busy epoch and allocates a new one after idle", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		const base = { activeSessionId: "active-1", sessionId: "session-1", ...v2Authority };
		journal.record({ ...base, busy: true, operation: "turn_start" });
		journal.record({ ...base, busy: true, operation: "tool_execution_start" });
		journal.record({ ...base, busy: true, operation: "tool_execution_end" });

		expect(fileLines(path)).toHaveLength(3);
		const checkpoints = fileLines(path).map((line) => JSON.parse(line) as WorkerRecoveryRecordV2);
		expect(checkpoints[0]!.operationId).toMatch(/^[0-9a-f-]{36}$/);
		expect(checkpoints[1]!.operationId).toBe(checkpoints[0]!.operationId);
		expect(checkpoints[2]!.operationId).toBe(checkpoints[0]!.operationId);

		// The session becomes idle; the idle record closes the same epoch (the
		// journal compacts the stable all-idle history, keeping just the idle
		// checkpoint)...
		journal.record({ ...base, busy: false, operation: "turn_end" });
		expect(fileLines(path)).toHaveLength(1);
		const idle = (WorkerRecoveryJournal.readLatest(path)[0] as WorkerRecoveryRecordV2 | undefined)!;
		expect(idle.busy).toBe(false);
		expect(idle.operationId).toBe(checkpoints[0]!.operationId);

		// ...and the next busy transition receives a brand new operation id.
		journal.record({ ...base, busy: true, operation: "turn_start" });
		const resumed = (WorkerRecoveryJournal.readLatest(path).at(-1) as WorkerRecoveryRecordV2 | undefined)!;
		expect(resumed.operationId).not.toBe(checkpoints[0]!.operationId);
	});

	it("deduplicates identical busy checkpoints within one epoch", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		const checkpoint = {
			activeSessionId: "active-1",
			sessionId: "session-1",
			...v2Authority,
			busy: true,
			operation: "turn_end",
		};
		journal.record(checkpoint);
		journal.record(checkpoint);
		journal.record(checkpoint);

		expect(WorkerRecoveryJournal.readLatest(path)).toHaveLength(1);
	});

	it("starts a new operation epoch when any busy authority field changes", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		const base = {
			activeSessionId: "active-1",
			sessionId: "session-1",
			...v2Authority,
			busy: true,
			operation: "turn_end",
		};
		journal.record(base);
		let previous = WorkerRecoveryJournal.readLatest(path)[0] as WorkerRecoveryRecordV2;

		const mutations: Array<[string, Partial<typeof base>]> = [
			["session generation", { sessionId: "session-2" }],
			["agentDir", { agentDir: "/other/agent" }],
			["sessionFile", { sessionFile: "/tmp/session-2.jsonl" }],
			["headEntryId", { headEntryId: "entry-10" }],
			["assistantEntryId", { assistantEntryId: "entry-11" }],
			["toolCalls", { toolCalls: [{ id: "other", name: "edit" }] }],
			["lineageDigest", { lineageDigest: "b".repeat(64) }],
		];
		for (const [, mutation] of mutations) {
			journal.record({ ...base, ...mutation });
			const latest = WorkerRecoveryJournal.readLatest(path);
			expect(latest).toHaveLength(1);
			expect(latest[0]).toMatchObject(mutation);
			expect(latest[0]?.operation).toBe("turn_end");
			const current = latest[0] as WorkerRecoveryRecordV2;
			expect(current.operationId).not.toBe(previous.operationId);
			previous = current;
		}
		expect(fileLines(path)).toHaveLength(1 + mutations.length);
	});

	it("completes only the matching busy epoch and cannot clobber a newer one", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		const base = { activeSessionId: "active-1", sessionId: "session-1", ...v2Authority };
		journal.record({ ...base, busy: true, operation: "turn_start" });
		const first = WorkerRecoveryJournal.readLatest(path)[0] as WorkerRecoveryRecordV2;

		// The session goes idle and a resumed worker starts a newer busy epoch.
		journal.record({ ...base, busy: false, operation: "turn_end" });
		journal.record({ ...base, busy: true, operation: "turn_start" });
		const resumed = WorkerRecoveryJournal.readLatest(path).at(-1) as WorkerRecoveryRecordV2;
		expect(resumed.operationId).not.toBe(first.operationId);

		// Completing the superseded epoch must not overwrite the newer one.
		expect(journal.complete("active-1", first.operationId)).toBe(false);
		expect((WorkerRecoveryJournal.readLatest(path).at(-1) as WorkerRecoveryRecordV2).operationId).toBe(
			resumed.operationId,
		);

		// Completing the current epoch closes it and stays idempotent.
		expect(journal.complete("active-1", resumed.operationId)).toBe(true);
		const closed = WorkerRecoveryJournal.readLatest(path).at(-1) as WorkerRecoveryRecordV2;
		expect(closed.busy).toBe(false);
		expect(closed.operationId).toBe(resumed.operationId);
		expect(journal.complete("active-1", resumed.operationId)).toBe(true);
	});

	it("refreshes a stale journal instance under the cross-process guard before writing", () => {
		const path = createPath();
		const journalA = new WorkerRecoveryJournal(path);
		const journalB = new WorkerRecoveryJournal(path);
		journalA.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			...v2Authority,
			busy: true,
			operation: "turn_start",
		});
		journalB.record({
			activeSessionId: "active-2",
			sessionId: "session-2",
			...v2Authority,
			sessionFile: "/tmp/session-2.jsonl",
			busy: true,
			operation: "turn_start",
		});

		expect(journalB.getLatest()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ activeSessionId: "active-1", busy: true }),
				expect.objectContaining({ activeSessionId: "active-2", busy: true }),
			]),
		);
	});

	it("completion re-reads the latest record from disk before comparing", () => {
		const path = createPath();
		const journalA = new WorkerRecoveryJournal(path);
		const base = { activeSessionId: "active-1", sessionId: "session-1", ...v2Authority };
		journalA.record({ ...base, busy: true, operation: "turn_start" });
		const operationId = (WorkerRecoveryJournal.readLatest(path)[0] as WorkerRecoveryRecordV2).operationId;

		// Another process resumes the session and opens a newer busy epoch.
		const journalB = new WorkerRecoveryJournal(path);
		journalB.record({ ...base, busy: false, operation: "turn_end" });
		journalB.record({ ...base, busy: true, operation: "turn_start" });

		// journalA still holds the stale in-memory view but must observe the newer
		// epoch through the persisted file.
		expect(journalA.complete("active-1", operationId)).toBe(false);
	});

	it("upgrades a v1-style idle hold after a v2 checkpoint by inheriting its authority", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			...v2Authority,
			busy: true,
			operation: "tool_execution_start",
		});
		const first = WorkerRecoveryJournal.readLatest(path)[0] as WorkerRecoveryRecordV2;

		// The supervisor marks the session recovered with the legacy v1-style
		// record call; the journal must keep the epoch authority and operation id.
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: false,
			operation: "recovery_hold",
		});
		const closed = WorkerRecoveryJournal.readLatest(path).at(-1)!;
		expect(closed.version).toBe(2);
		if (closed.version === 2) {
			expect(closed.busy).toBe(false);
			expect(closed.operation).toBe("recovery_hold");
			expect(closed.operationId).toBe(first.operationId);
			expect(closed.agentDir).toBe(v2Authority.agentDir);
			expect(closed.sessionFile).toBe(v2Authority.sessionFile);
			expect(closed.headEntryId).toBe(v2Authority.headEntryId);
			expect(closed.toolCalls).toEqual(v2Authority.toolCalls);
			expect(closed.lineageDigest).toBe(v2Authority.lineageDigest);
		}
		// Completion of that closed epoch stays idempotent.
		expect(journal.complete("active-1", first.operationId)).toBe(true);
	});

	it("refuses to complete legacy v1 busy records, unknown sessions, and empty journals", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "legacy-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			busy: true,
			operation: "model_stream",
		});

		expect(WorkerRecoveryJournal.readLatest(path)).toHaveLength(1);
		expect(WorkerRecoveryJournal.readLatest(path)[0]?.version).toBe(1);
		expect(journal.complete("legacy-1", "any-operation-id")).toBe(false);
		expect(journal.complete("unknown-session", "any-operation-id")).toBe(false);
		expect(journal.complete("legacy-1", "")).toBe(false);
	});

	it("does not fall back to an older busy v2 authority after a torn checkpoint", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			...v2Authority,
			busy: true,
			operation: "tool_execution_start",
		});
		appendFileSync(path, '{"version":2,"activeSessionId":"active-1"');

		expect(WorkerRecoveryJournal.readLatest(path)).toEqual([]);

		// A later complete checkpoint supersedes the corrupt line and becomes the
		// only usable authority.
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			...v2Authority,
			headEntryId: "entry-10",
			busy: true,
			operation: "tool_execution_start",
		});
		expect(WorkerRecoveryJournal.readLatest(path)).toEqual([
			expect.objectContaining({ version: 2, headEntryId: "entry-10", busy: true }),
		]);
	});

	it("skips malformed v2 records while keeping valid ones", () => {
		const path = createPath();
		writeFileSync(path, '{"version":2,"activeSessionId":"bad"}\n');
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "good-1",
			sessionId: "session-1",
			agentDir: "/agent",
			sessionFile: "/tmp/good-session.jsonl",
			busy: true,
			operation: "turn_start",
			headEntryId: null,
			assistantEntryId: null,
			toolCalls: [],
			lineageDigest: "c".repeat(64),
		});

		const latest = WorkerRecoveryJournal.readLatest(path);
		expect(latest).toHaveLength(1);
		expect(latest[0]?.activeSessionId).toBe("good-1");
		expect(latest[0]).toMatchObject({ headEntryId: null, assistantEntryId: null, toolCalls: [] });
	});
});
