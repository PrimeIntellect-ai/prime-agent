import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	OperationLedger,
	type OperationLedgerSnapshot,
	OperationTracker,
} from "../src/modes/daemon/operation-ledger.js";

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

		const persisted = JSON.parse(readFileSync(ledger.snapshotPath, "utf8")) as OperationLedgerSnapshot;
		expect(persisted.operations[0]).toMatchObject({ operationId: "op-1", status: "terminal" });
		expect(readFileSync(ledger.journalPath, "utf8").trim().split("\n")).toHaveLength(4);
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
		});

		tracker.handleBookkeeping("classifier_poll");
		now.value += 1_000;
		tracker.handleSessionEvent({ type: "tool_execution_end", toolCallId: "tool-1" });
		tracker.handleSessionEvent({ type: "agent_end" });
		expect(tracker.summary().openOperationCount).toBe(0);
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
