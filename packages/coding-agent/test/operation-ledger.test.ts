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
		const tracker = new OperationTracker(ledger, { activeSessionId: "active-2", sessionId: "session-2" });

		tracker.handleSessionEvent({ type: "agent_start" });
		tracker.handleSessionEvent({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" });
		now.value += 30_000;
		tracker.handleSessionEvent({ type: "message_update" });
		const summary = tracker.summary();
		expect(summary.openOperationCount).toBe(2);
		expect(summary.operations.map((operation) => operation.kind)).toEqual(["turn", "tool"]);

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
});
