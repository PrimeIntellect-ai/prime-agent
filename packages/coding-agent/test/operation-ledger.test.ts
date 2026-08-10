import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type OperationKind, OperationLedger, OperationTracker } from "../src/modes/daemon/operation-ledger.js";
import { resolveOperationTimeoutPolicy } from "../src/modes/daemon/operation-timeout-policy.js";
import { readOperationSnapshotEvidence } from "../src/modes/daemon/reliability-monitor.js";

describe("OperationLedger", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function makeLedger(nowRef: { value: number }): OperationLedger {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-operations-"));
		roots.push(root);
		return new OperationLedger({
			rootDir: root,
			instanceId: "worker-test",
			pid: 1234,
			processStartId: "start-1",
			now: () => nowRef.value,
			heartbeatIntervalMs: 0,
		});
	}

	type LedgerOptionsWithJournalCaps = ConstructorParameters<typeof OperationLedger>[0] & {
		maxJournalBytes: number;
		maxJournalRecords: number;
	};

	type LegacyProgressInput = Parameters<OperationLedger["progress"]>[1] & {
		deadlineAt: string;
	};

	function parseJournalLine(line: string): Record<string, unknown> {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Expected a JSON object journal entry");
		}
		return parsed as Record<string, unknown>;
	}

	function journalTransition(entry: Record<string, unknown>): string | undefined {
		const transition = entry.transition;
		return typeof transition === "string" ? transition : undefined;
	}

	it("persists open, meaningful-progress, and terminal transitions with separate clocks", () => {
		const now = { value: Date.parse("2026-08-10T08:00:00.000Z") };
		const ledger = makeLedger(now);
		ledger.open({
			operationId: "op-1",
			activeSessionId: "active-1",
			sessionId: "session-1",
			kind: "provider",
			phase: "active",
		});
		now.value += 60_000;
		ledger.progress("op-1", { progressKind: "bookkeeping", phase: "waiting_external" });
		now.value += 60_000;
		ledger.progress("op-1", { progressKind: "semantic", detail: "received model output" });

		const open = ledger.snapshot().operations[0]!;
		expect(open.status).toBe("open");
		expect(open.updatedAt).toBe("2026-08-10T08:02:00.000Z");
		expect(open.lastMeaningfulProgressAt).toBe("2026-08-10T08:02:00.000Z");
		now.value += 1_000;
		ledger.close("op-1", { phase: "completed", outcome: "completed" });
		expect(ledger.snapshot().operations[0]).toMatchObject({ status: "terminal", phase: "completed" });

		const persisted = parseJournalLine(readFileSync(ledger.snapshotPath, "utf8"));
		expect(persisted).toMatchObject({ operations: [{ operationId: "op-1", status: "terminal" }] });
		const journalEntries = readFileSync(ledger.journalPath, "utf8").trim().split("\n").map(parseJournalLine);
		expect(journalEntries).toHaveLength(5);
		expect(journalEntries.map(journalTransition)).toEqual(["checkpoint", "open", "progress", "progress", "close"]);
		expect(journalEntries[0]).toMatchObject({
			transition: "checkpoint",
			snapshot: { schemaVersion: 1, instanceId: "worker-test", processState: "active", operations: [] },
		});
		ledger.dispose();
	});

	it("tracks nested runtime phases from session events without treating status polling as progress", () => {
		const now = { value: Date.parse("2026-08-10T09:00:00.000Z") };
		const ledger = makeLedger(now);
		const tracker = new OperationTracker(ledger, {
			activeSessionId: "active-2",
			sessionId: "session-2",
			now: () => now.value,
		});

		tracker.handleSessionEvent({ type: "agent_start" });
		tracker.handleSessionEvent({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" });
		now.value += 30_000;
		tracker.handleSessionEvent({ type: "message_update" });
		const summary = tracker.summary();
		expect(summary.openOperationCount).toBe(2);
		expect(summary.operations.map((operation) => operation.kind)).toEqual(["turn", "tool"]);
		expect(summary.operations[1]).toMatchObject({
			deadlineAt: "2026-08-10T11:00:00.000Z",
			timeoutClass: "owned-tool-hard-cap",
			timeoutPolicySource: "prime-agent-default-v1",
			parentOperationId: summary.operations[0]!.operationId,
		});

		const beforeClassifierPoll = summary.operations[1]?.lastMeaningfulProgressAt;
		now.value += 1_000;
		tracker.handleSessionEvent({ type: "classifier_poll" });
		expect(tracker.summary().operations[1]?.lastMeaningfulProgressAt).toBe(beforeClassifierPoll);
		tracker.handleSessionEvent({ type: "tool_execution_end", toolCallId: "tool-1" });
		tracker.handleSessionEvent({ type: "agent_end" });
		expect(tracker.summary().openOperationCount).toBe(0);
		ledger.dispose();
	});

	it("appends heartbeat and shutdown state entries after the initial checkpoint", () => {
		const now = { value: Date.parse("2026-08-10T09:30:00.000Z") };
		const ledger = makeLedger(now);
		now.value += 1_000;
		ledger.heartbeat();
		now.value += 1_000;
		ledger.dispose();

		const entries = readFileSync(ledger.journalPath, "utf8").trim().split("\n").map(parseJournalLine);
		expect(entries[0]).toMatchObject({
			transition: "checkpoint",
			snapshot: { instanceId: "worker-test", processState: "active" },
		});
		expect(entries.filter((entry) => journalTransition(entry) === "state")).toHaveLength(2);
	});

	it("does not let progress override a deadline established at admission", () => {
		const now = { value: Date.parse("2026-08-10T09:45:00.000Z") };
		const ledger = makeLedger(now);
		const deadlineAt = "2026-08-10T10:45:00.000Z";
		ledger.open({
			operationId: "deadline-owned-by-open",
			activeSessionId: "active-deadline",
			kind: "tool",
			deadlineAt,
		});

		const legacyProgress: LegacyProgressInput = {
			progressKind: "semantic",
			deadlineAt: "2026-08-10T12:45:00.000Z",
		};
		ledger.progress("deadline-owned-by-open", legacyProgress);

		expect(ledger.snapshot().operations[0]?.deadlineAt).toBe(deadlineAt);
		ledger.dispose();
	});

	it("has no timeout policy for removed operation kinds", () => {
		const startedAt = Date.parse("2026-08-10T09:50:00.000Z");
		for (const kind of ["child", "session", "unknown"] as const) {
			expect(() => resolveOperationTimeoutPolicy(kind as unknown as OperationKind, undefined, startedAt)).toThrow();
		}
	});

	it("replays a newer valid journal tail over a valid stale snapshot", () => {
		const now = { value: Date.parse("2026-08-10T10:00:00.000Z") };
		const ledger = makeLedger(now);
		ledger.open({
			operationId: "journal-tail",
			activeSessionId: "active-tail",
			kind: "tool",
		});
		const staleSnapshot = readFileSync(ledger.snapshotPath, "utf8");
		now.value += 60_000;
		ledger.progress("journal-tail", { progressKind: "semantic", detail: "newer journal tail" });
		writeFileSync(ledger.snapshotPath, staleSnapshot);

		const evidence = readOperationSnapshotEvidence(join(ledger.snapshotPath, "..", ".."));
		const recovered = evidence.snapshots.find((snapshot) => snapshot.instanceId === "worker-test");
		expect(evidence.warnings).toEqual([]);
		expect(recovered?.operations).toMatchObject([
			{
				operationId: "journal-tail",
				detail: "newer journal tail",
				lastMeaningfulProgressAt: "2026-08-10T10:01:00.000Z",
			},
		]);
		ledger.dispose();
	});

	it("recovers a missing or corrupt snapshot from a journal checkpoint and its transitions", () => {
		const now = { value: Date.parse("2026-08-10T10:10:00.000Z") };
		const ledger = makeLedger(now);
		ledger.open({
			operationId: "checkpoint-recovery",
			activeSessionId: "active-checkpoint",
			kind: "tool",
		});
		now.value += 1_000;
		ledger.close("checkpoint-recovery", { phase: "completed", outcome: "completed" });
		const rootDir = join(ledger.snapshotPath, "..", "..");

		rmSync(ledger.snapshotPath);
		let evidence = readOperationSnapshotEvidence(rootDir);
		expect(evidence.warnings).toEqual([]);
		expect(evidence.snapshots[0]?.operations).toMatchObject([
			{ operationId: "checkpoint-recovery", status: "terminal", outcome: "completed" },
		]);

		writeFileSync(ledger.snapshotPath, "{not valid JSON");
		evidence = readOperationSnapshotEvidence(rootDir);
		expect(evidence.warnings).toEqual([]);
		expect(evidence.snapshots[0]?.operations).toMatchObject([
			{ operationId: "checkpoint-recovery", status: "terminal", outcome: "completed" },
		]);
		ledger.dispose();
	});

	it("tolerates only a torn final journal line while preserving prior transitions", () => {
		const now = { value: Date.parse("2026-08-10T10:20:00.000Z") };
		const ledger = makeLedger(now);
		ledger.open({
			operationId: "torn-final",
			activeSessionId: "active-torn",
			kind: "tool",
		});
		appendFileSync(ledger.journalPath, '{"transition":"progress"');

		const evidence = readOperationSnapshotEvidence(join(ledger.snapshotPath, "..", ".."));
		expect(evidence.warnings).toEqual([]);
		expect(evidence.snapshots[0]?.operations).toMatchObject([{ operationId: "torn-final", status: "open" }]);
		ledger.dispose();
	});

	it("keeps a valid snapshot but records evidence when an interior journal line is corrupt", () => {
		const now = { value: Date.parse("2026-08-10T10:30:00.000Z") };
		const ledger = makeLedger(now);
		ledger.open({
			operationId: "invalid-interior",
			activeSessionId: "active-invalid",
			kind: "tool",
		});
		now.value += 1_000;
		ledger.progress("invalid-interior", { progressKind: "semantic", detail: "keep snapshot truth" });
		const lines = readFileSync(ledger.journalPath, "utf8").trim().split("\n");
		lines.splice(1, 0, '{"transition":');
		writeFileSync(ledger.journalPath, `${lines.join("\n")}\n`);

		const evidence = readOperationSnapshotEvidence(join(ledger.snapshotPath, "..", ".."));
		expect(evidence.snapshots[0]?.operations).toMatchObject([
			{ operationId: "invalid-interior", detail: "keep snapshot truth" },
		]);
		expect(evidence.warnings).toEqual([
			expect.objectContaining({
				type: "operation_journal_corrupt",
				path: ledger.journalPath,
				error: expect.any(String),
			}),
		]);
		ledger.dispose();
	});

	it("rejects semantically invalid closes and lifetime counters as corrupt journal evidence", () => {
		const invalidCases = [
			{ name: "terminal uncertain close without outcome", kind: "close" },
			{
				name: "negative lifetime counter",
				kind: "checkpoint",
				counts: { terminalCount: -1, uncertainOutcomeCount: 0, cleanupUncertainCount: 0 },
			},
			{
				name: "fractional lifetime counters",
				kind: "checkpoint",
				counts: { terminalCount: 1, uncertainOutcomeCount: 0.5, cleanupUncertainCount: 0.25 },
			},
		] as const;

		const observations = invalidCases.map((invalidCase, index) => {
			const root = mkdtempSync(join(tmpdir(), `prime-agent-semantic-journal-${index}-`));
			roots.push(root);
			const now = { value: Date.parse("2026-08-10T10:35:00.000Z") };
			const instanceId = `semantic-worker-${index}`;
			const operationId = `semantic-operation-${index}`;
			const ledger = new OperationLedger({
				rootDir: root,
				instanceId,
				pid: 1234,
				processStartId: `semantic-start-${index}`,
				now: () => now.value,
				heartbeatIntervalMs: 0,
			});
			ledger.open({ operationId, activeSessionId: "active-semantic", kind: "tool" });
			const baseSnapshot = ledger.snapshot();
			now.value += 1_000;
			const recordedAt = new Date(now.value).toISOString();
			const sequence = (baseSnapshot.journalSequence ?? 0) + 1;
			const event =
				invalidCase.kind === "close"
					? {
							schemaVersion: 1,
							transition: "close",
							recordedAt,
							sequence,
							record: {
								...baseSnapshot.operations[0]!,
								phase: "uncertain",
								status: "terminal",
								updatedAt: recordedAt,
							},
						}
					: {
							schemaVersion: 1,
							transition: "checkpoint",
							recordedAt,
							sequence,
							snapshot: {
								...baseSnapshot,
								journalSequence: sequence,
								lifetimeByGroup: { "tool:unclassified": invalidCase.counts },
							},
						};
			appendFileSync(ledger.journalPath, `${JSON.stringify(event)}\n`);

			const evidence = readOperationSnapshotEvidence(root);
			const recovered = evidence.snapshots.find((snapshot) => snapshot.instanceId === instanceId);
			return {
				name: invalidCase.name,
				warningTypes: evidence.warnings.map((warning) => warning.type),
				operationStatus: recovered?.operations.find((operation) => operation.operationId === operationId)?.status,
				lifetimeCounts: recovered?.lifetimeByGroup?.["tool:unclassified"],
			};
		});

		expect(observations).toEqual(
			invalidCases.map((invalidCase) => ({
				name: invalidCase.name,
				warningTypes: ["operation_journal_corrupt"],
				operationStatus: "open",
				lifetimeCounts: undefined,
			})),
		);
	});

	it("replays a terminal close once when the snapshot already contains that close", () => {
		const now = { value: Date.parse("2026-08-10T10:40:00.000Z") };
		const ledger = makeLedger(now);
		ledger.open({
			operationId: "close-once",
			activeSessionId: "active-close-once",
			kind: "tool",
		});
		now.value += 1_000;
		ledger.close("close-once", { phase: "completed", outcome: "completed" });

		const evidence = readOperationSnapshotEvidence(join(ledger.snapshotPath, "..", ".."));
		const recovered = evidence.snapshots.find((snapshot) => snapshot.instanceId === "worker-test");
		expect(recovered?.operations).toMatchObject([{ operationId: "close-once", status: "terminal" }]);
		expect(recovered?.lifetimeByGroup?.["tool:unclassified"]).toMatchObject({
			terminalCount: 1,
			uncertainOutcomeCount: 0,
			cleanupUncertainCount: 0,
		});
		ledger.dispose();
	});

	it("compacts the active journal within both byte and record caps without losing current state", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-operation-journal-cap-"));
		roots.push(root);
		const now = { value: Date.parse("2026-08-10T10:50:00.000Z") };
		const maxJournalBytes = 4_096;
		const maxJournalRecords = 3;
		const options: LedgerOptionsWithJournalCaps = {
			rootDir: root,
			instanceId: "capped-worker",
			pid: 1234,
			processStartId: "start-capped",
			now: () => now.value,
			heartbeatIntervalMs: 0,
			maxJournalBytes,
			maxJournalRecords,
		};
		const ledger = new OperationLedger(options);
		ledger.open({
			operationId: "capped-operation",
			activeSessionId: "active-capped",
			kind: "tool",
		});
		for (let index = 0; index < 9; index += 1) {
			now.value += 1_000;
			ledger.progress("capped-operation", {
				progressKind: "semantic",
				detail: `progress-${index}:${"x".repeat(1_000)}`,
			});
		}

		const entries = readFileSync(ledger.journalPath, "utf8").trim().split("\n");
		expect(entries.length).toBeLessThanOrEqual(maxJournalRecords);
		expect(statSync(ledger.journalPath).size).toBeLessThanOrEqual(maxJournalBytes);
		expect(entries.map(parseJournalLine).map(journalTransition)).toContain("checkpoint");
		expect(ledger.snapshot().operations[0]).toMatchObject({
			operationId: "capped-operation",
			detail: `progress-8:${"x".repeat(1_000)}`,
		});
		ledger.dispose();
	});

	it("keeps an oversized checkpoint within its byte cap without losing open or uncertain evidence", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-operation-oversized-checkpoint-"));
		roots.push(root);
		const now = { value: Date.parse("2026-08-10T10:55:00.000Z") };
		const maxJournalBytes = 4_096;
		const ledger = new OperationLedger({
			rootDir: root,
			instanceId: "oversized-checkpoint-worker",
			pid: 1234,
			processStartId: "start-oversized-checkpoint",
			now: () => now.value,
			heartbeatIntervalMs: 0,
			maxJournalBytes,
			maxJournalRecords: 100,
		});
		const oversizedDetail = "oversized-checkpoint-detail:".repeat(1_000);
		ledger.open({
			operationId: "oversized-uncertain",
			activeSessionId: "active-oversized",
			kind: "tool",
			detail: oversizedDetail,
		});
		now.value += 1_000;
		ledger.close("oversized-uncertain", {
			phase: "uncertain",
			outcome: "uncertain",
			cleanupStatus: "cleanup_uncertain",
			detail: oversizedDetail,
		});
		now.value += 1_000;
		ledger.open({
			operationId: "oversized-open",
			activeSessionId: "active-oversized",
			kind: "tool",
			detail: oversizedDetail,
		});

		expect(statSync(ledger.journalPath).size).toBeLessThanOrEqual(maxJournalBytes);
		rmSync(ledger.snapshotPath);
		const evidence = readOperationSnapshotEvidence(root);
		const recovered = evidence.snapshots.find((snapshot) => snapshot.instanceId === "oversized-checkpoint-worker");
		expect(evidence.warnings).toEqual([]);
		expect(recovered?.operations.find((operation) => operation.operationId === "oversized-open")).toMatchObject({
			status: "open",
		});
		expect(recovered?.operations.find((operation) => operation.operationId === "oversized-uncertain")).toMatchObject({
			status: "terminal",
			phase: "uncertain",
			outcome: "uncertain",
			cleanupStatus: "cleanup_uncertain",
		});
		expect(recovered?.lifetimeByGroup?.["tool:unclassified"]).toMatchObject({
			terminalCount: 1,
			uncertainOutcomeCount: 1,
			cleanupUncertainCount: 1,
		});
		ledger.dispose();
	});

	it("degrades persistence failures to explicit memory-only truth instead of blocking the daemon", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-operations-blocked-"));
		roots.push(root);
		const blocker = join(root, "not-a-directory");
		writeFileSync(blocker, "block");
		const ledger = new OperationLedger({ rootDir: blocker, instanceId: "memory-only", heartbeatIntervalMs: 0 });
		const operation = ledger.open({ activeSessionId: "active-3", kind: "provider" });
		expect(operation.status).toBe("open");
		expect(ledger.snapshot()).toMatchObject({ persistenceState: "memory_only" });
		expect(ledger.snapshot().persistenceError).toBeTruthy();
	});

	it("makes aborted tool cleanup uncertainty terminal and durable", () => {
		const now = { value: Date.parse("2026-08-10T10:00:00.000Z") };
		const ledger = makeLedger(now);
		const tracker = new OperationTracker(ledger, {
			activeSessionId: "active-4",
			sessionId: "session-4",
			now: () => now.value,
		});
		tracker.handleSessionEvent({ type: "tool_execution_start", toolCallId: "tool-4", toolName: "ipython" });
		tracker.handleSessionEvent({
			type: "process_ownership_update",
			resource: "kernel",
			status: "owned",
			pid: 44,
			processStartId: "start-44",
			cleanupStatus: "not_attempted",
		});
		tracker.handleSessionEvent({
			type: "tool_execution_end",
			toolCallId: "tool-4",
			isError: true,
			result: {
				details: { status: "aborted", cleanupStatus: "uncertain", survivingProcessIds: [45] },
			},
		});
		expect(tracker.summary().operations[0]).toMatchObject({
			status: "terminal",
			phase: "uncertain",
			outcome: "uncertain",
			ownershipStatus: "owned",
			cleanupStatus: "cleanup_uncertain",
		});
		expect(tracker.summary().operations[0]?.detail).toContain("45");
	});

	it("claims an expired operation once and only when the owned-cancellation canary is enabled", () => {
		const now = { value: Date.parse("2026-08-10T10:00:00.000Z") };
		const ledger = makeLedger(now);
		const tracker = new OperationTracker(ledger, { activeSessionId: "active-5", now: () => now.value });
		tracker.handleSessionEvent({ type: "tool_execution_start", toolCallId: "tool-5", toolName: "ipython" });
		tracker.handleSessionEvent({
			type: "process_ownership_update",
			status: "owned",
			pid: 55,
			processStartId: "start-55",
		});
		now.value += 2 * 60 * 60_000 + 1;
		expect(tracker.claimExpiredCancellations(now.value, false)).toEqual([]);
		expect(tracker.claimExpiredCancellations(now.value, true)).toHaveLength(1);
		expect(tracker.claimExpiredCancellations(now.value, true)).toEqual([]);
		expect(tracker.summary().operations[0]).toMatchObject({ phase: "cancelling", cleanupStatus: "not_started" });
	});

	it("reconciles a dead worker's open operation as uncertain without replaying or resetting its deadline", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-operation-reconcile-"));
		roots.push(root);
		const now = { value: Date.parse("2026-08-10T10:00:00.000Z") };
		const previous = new OperationLedger({
			rootDir: root,
			instanceId: "dead-worker",
			pid: 999_999,
			processStartId: "ps2:dead",
			now: () => now.value,
			heartbeatIntervalMs: 0,
		});
		previous.open({
			operationId: "op-before-restart",
			activeSessionId: "active-recovered",
			sessionId: "session-recovered",
			kind: "tool",
			deadlineAt: "2026-08-10T12:00:00.000Z",
			timeoutClass: "owned-tool-hard-cap",
			timeoutPolicySource: "prime-agent-default-v1",
			ownershipStatus: "owned",
		});
		now.value += 60_000;
		const current = new OperationLedger({
			rootDir: root,
			instanceId: "new-worker",
			pid: process.pid,
			now: () => now.value,
			heartbeatIntervalMs: 0,
		});
		const tracker = new OperationTracker(current, {
			activeSessionId: "active-recovered",
			sessionId: "session-recovered",
			now: () => now.value,
		});
		expect(tracker.summary()).toMatchObject({ openOperationCount: 0 });
		expect(tracker.summary().operations[0]).toMatchObject({
			operationId: "op-before-restart",
			status: "terminal",
			phase: "uncertain",
			outcome: "uncertain",
			cleanupStatus: "cleanup_uncertain",
			deadlineAt: "2026-08-10T12:00:00.000Z",
		});
		expect(tracker.summary().operations[0]?.detail).toContain("was not replayed");
	});
});
