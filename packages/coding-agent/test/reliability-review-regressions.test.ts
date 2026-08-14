import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOperationCalibrationReport } from "../src/modes/daemon/operation-calibration.js";
import { OperationExtensionInbox } from "../src/modes/daemon/operation-extension-inbox.js";
import {
	OperationLedger,
	type OperationLedgerSnapshot,
	OperationTracker,
} from "../src/modes/daemon/operation-ledger.js";
import * as reliabilityMonitor from "../src/modes/daemon/reliability-monitor.js";

// Regressions for the defects found by independent adversarial review of the elite reliability
// mission. Each test fails against the pre-remediation implementation.

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "reliability-review-"));
	roots.push(value);
	return value;
}

type LedgerOptionsWithJournalCaps = ConstructorParameters<typeof OperationLedger>[0] & {
	maxJournalBytes: number;
	maxJournalRecords: number;
};

const { evaluateReliabilitySnapshot, NotificationOutbox } = reliabilityMonitor;

describe("closeAll never fabricates a completed outcome", () => {
	it("terminalizes a still-open operation as uncertain even when the session completed", () => {
		const ledger = new OperationLedger({ rootDir: root(), heartbeatIntervalMs: 0 });
		const tracker = new OperationTracker(ledger, { activeSessionId: "as1" });
		// A tool starts and never ends — the end event was lost, or the stream aborted.
		tracker.handleSessionEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" });
		expect(tracker.summary().openOperationCount).toBe(1);

		tracker.closeAll("completed", "session completed");

		const operation = tracker.summary().operations.find((record) => record.kind === "tool");
		expect(operation?.outcome, "an unfinished operation must never be recorded as completed").toBe("uncertain");
		expect(operation?.phase).toBe("uncertain");
		ledger.dispose();
	});
});

describe("calibration eligibility survives terminal-record trimming", () => {
	it("stays ineligible after an uncertain sample ages out of the retained window", () => {
		const ledger = new OperationLedger({ rootDir: root(), heartbeatIntervalMs: 0 });
		const close = (outcome: "completed" | "uncertain") => {
			const record = ledger.open({ activeSessionId: "as1", kind: "tool", timeoutClass: "owned-tool-hard-cap" });
			ledger.close(record.operationId, { phase: outcome, outcome });
		};

		close("uncertain");
		const before = buildOperationCalibrationReport([ledger.snapshot()], { minimumCanarySamples: 100 });
		expect(before.hardEnforcementEligible).toBe(false);

		// Enough clean operations to push the uncertain record past MAX_RETAINED_TERMINAL_OPERATIONS.
		for (let index = 0; index < 600; index += 1) close("completed");

		const after = buildOperationCalibrationReport([ledger.snapshot()], { minimumCanarySamples: 100 });
		expect(after.groups[0]?.sampleCount, "the window is bounded, so records really were trimmed").toBeLessThan(601);
		expect(after.groups[0]?.uncertainOutcomeCount, "lifetime evidence must not be forgotten").toBe(1);
		expect(after.hardEnforcementEligible, "a trimmed uncertain outcome must not create eligibility").toBe(false);
		expect(after.verdict).toBe("telemetry_insufficient");
		ledger.dispose();
	});

	it("does not launder lifetime uncertainty through checkpoint journal compaction", () => {
		const dir = root();
		const now = { value: Date.parse("2026-08-10T09:00:00.000Z") };
		const options: LedgerOptionsWithJournalCaps = {
			rootDir: dir,
			instanceId: "uncertainty-capped",
			pid: 1234,
			processStartId: "uncertainty-start",
			now: () => now.value,
			heartbeatIntervalMs: 0,
			maxJournalBytes: 8 * 1_024,
			maxJournalRecords: 4,
		};
		const ledger = new OperationLedger(options);
		const close = (outcome: "completed" | "uncertain") => {
			const record = ledger.open({
				activeSessionId: "as1",
				kind: "tool",
				timeoutClass: "owned-tool-hard-cap",
			});
			now.value += 1_000;
			ledger.close(record.operationId, { phase: outcome, outcome });
		};

		close("uncertain");
		for (let index = 0; index < 600; index += 1) close("completed");
		rmSync(ledger.snapshotPath);

		const evidence = reliabilityMonitor.readOperationSnapshotEvidence(dir);
		const report = buildOperationCalibrationReport(evidence.snapshots, { minimumCanarySamples: 100 });
		expect(evidence.warnings).toEqual([]);
		expect(report.groups[0]?.sampleCount).toBeLessThan(601);
		expect(report.groups[0]?.uncertainOutcomeCount).toBe(1);
		expect(report.hardEnforcementEligible).toBe(false);
		expect(report.verdict).toBe("telemetry_insufficient");
		ledger.dispose();
	});
});

describe("reconciliation is exact once across owner lifetimes", () => {
	it("counts one dead open operation once after three owner generations", () => {
		const dir = root();
		const now = { value: Date.parse("2026-08-10T09:30:00.000Z") };
		const operationId = "operation-across-three-generations";
		const first = new OperationLedger({
			rootDir: dir,
			instanceId: "reconcile-generation-1",
			pid: 12_341,
			processStartId: "generation-1-start",
			now: () => now.value,
			heartbeatIntervalMs: 0,
		});
		first.open({
			operationId,
			activeSessionId: "shared-active-session",
			sessionId: "shared-session",
			kind: "tool",
			timeoutClass: "owned-tool-hard-cap",
			ownershipStatus: "owned",
		});
		first.dispose();

		now.value += 1_000;
		const second = new OperationLedger({
			rootDir: dir,
			instanceId: "reconcile-generation-2",
			pid: 12_342,
			processStartId: "generation-2-start",
			now: () => now.value,
			heartbeatIntervalMs: 0,
		});
		const secondTracker = new OperationTracker(second, {
			activeSessionId: "shared-active-session",
			sessionId: "shared-session",
			now: () => now.value,
		});
		expect(secondTracker.summary().operations).toMatchObject([
			{
				operationId,
				status: "terminal",
				phase: "uncertain",
				outcome: "uncertain",
				cleanupStatus: "cleanup_uncertain",
			},
		]);
		second.dispose();

		now.value += 1_000;
		const third = new OperationLedger({
			rootDir: dir,
			instanceId: "reconcile-generation-3",
			pid: 12_343,
			processStartId: "generation-3-start",
			now: () => now.value,
			heartbeatIntervalMs: 0,
		});
		const thirdTracker = new OperationTracker(third, {
			activeSessionId: "shared-active-session",
			sessionId: "shared-session",
			now: () => now.value,
		});
		expect(thirdTracker.summary().openOperationCount).toBe(0);

		const snapshots = reliabilityMonitor.readOperationSnapshots(dir);
		const reconciledTerminalRecords = snapshots.flatMap((snapshot) =>
			snapshot.operations.filter(
				(operation) => operation.operationId === operationId && operation.status === "terminal",
			),
		);
		const report = buildOperationCalibrationReport(snapshots, { minimumCanarySamples: 100, now: now.value });
		const group = report.groups.find((candidate) => candidate.key === "tool:owned-tool-hard-cap");
		expect(reconciledTerminalRecords).toHaveLength(1);
		expect(group).toMatchObject({
			lifetimeTerminalCount: 1,
			uncertainOutcomeCount: 1,
			cleanupUncertainCount: 1,
		});
		third.dispose();
	});
});

describe("a human deadline extension applies at most once", () => {
	it("does not re-apply across sweeps when the receipt cannot be written", () => {
		const dir = root();
		const ledger = new OperationLedger({ rootDir: dir, heartbeatIntervalMs: 0 });
		const record = ledger.open({
			activeSessionId: "as1",
			kind: "tool",
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const inbox = new OperationExtensionInbox(dir);
		inbox.request(record.operationId, 10 * 60_000);
		// The inbox becomes unwritable after the request lands.
		chmodSync(inbox.path, 0o444);

		const applications: string[] = [];
		for (let sweep = 0; sweep < 5; sweep += 1) {
			for (const pending of inbox.pending()) {
				try {
					inbox.claim(pending);
				} catch {
					break;
				}
				const result = ledger.extendDeadline(pending.operationId, pending.extensionMs);
				if (result.status === "applied") applications.push(result.record.deadlineAt!);
				try {
					inbox.record(pending, result);
				} catch {
					// Receipt loss must not resurrect the request; the claim already settled it.
				}
			}
		}

		expect(applications.length, "an unwritable inbox must grant zero extensions, never one per sweep").toBe(0);
		chmodSync(inbox.path, 0o644);
		ledger.dispose();
	});

	it("settles a request exactly once when the inbox is writable", () => {
		const dir = root();
		const ledger = new OperationLedger({ rootDir: dir, heartbeatIntervalMs: 0 });
		const record = ledger.open({
			activeSessionId: "as1",
			kind: "tool",
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const inbox = new OperationExtensionInbox(dir);
		inbox.request(record.operationId, 10 * 60_000);

		let applications = 0;
		for (let sweep = 0; sweep < 5; sweep += 1) {
			for (const pending of inbox.pending()) {
				inbox.claim(pending);
				const result = ledger.extendDeadline(pending.operationId, pending.extensionMs);
				if (result.status === "applied") applications += 1;
				inbox.record(pending, result);
			}
		}
		expect(applications).toBe(1);
		expect(inbox.pending()).toEqual([]);
		ledger.dispose();
	});
});

describe("monitor liveness agrees with the ledger across start-id formats", () => {
	function snapshot(processStartId: string | undefined): OperationLedgerSnapshot {
		return {
			schemaVersion: 1,
			instanceId: "inst-1",
			pid: process.pid,
			processStartId,
			role: "daemon",
			processState: "active",
			persistenceState: "durable",
			startedAt: new Date(Date.now() - 600_000).toISOString(),
			// Stale enough to raise a real alert.
			heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
			operations: [],
		};
	}

	it("does not report a live process missing when the recorded token predates the current format", () => {
		// A legacy `ps:` token cannot be compared against the current `ps2:` rendering. That is
		// unverifiable, not a mismatch, and must not be reported as a dead process.
		const alerts = evaluateReliabilitySnapshot(snapshot("ps:Sun Aug 10 08:00:00 2026"));
		expect(alerts.map((alert) => alert.kind)).not.toContain("process_missing");
	});

	it("still surfaces the snapshot's real alerts rather than suppressing them", () => {
		const alerts = evaluateReliabilitySnapshot(snapshot("ps:Sun Aug 10 08:00:00 2026"));
		expect(alerts.map((alert) => alert.kind)).toContain("heartbeat_stale");
	});

	it("reports a genuinely missing process alongside its deadline alerts, not instead of them", () => {
		const dead = snapshot(undefined);
		dead.pid = 999_999; // No such process: process.kill(pid, 0) throws.
		dead.operations = [
			{
				schemaVersion: 1,
				operationId: "op-overdue",
				activeSessionId: "as1",
				kind: "tool",
				phase: "active",
				status: "open",
				startedAt: new Date(Date.now() - 600_000).toISOString(),
				updatedAt: new Date(Date.now() - 600_000).toISOString(),
				lastMeaningfulProgressAt: new Date(Date.now() - 600_000).toISOString(),
				deadlineAt: new Date(Date.now() - 1_000).toISOString(),
			},
		];

		const kinds = evaluateReliabilitySnapshot(dead).map((alert) => alert.kind);
		expect(kinds).toContain("process_missing");
		expect(kinds, "a liveness verdict must not discard the snapshot's other alerts").toContain(
			"operation_deadline_exceeded",
		);
	});
});

describe("the notification outbox does not lose concurrent writes", () => {
	it("preserves an alert enqueued by one process and an acknowledgement from another", () => {
		const path = join(root(), "notification-outbox.json");
		const monitor = new NotificationOutbox(path);
		const first = monitor.enqueue({
			alertKey: "k1",
			kind: "heartbeat_stale",
			severity: "warning",
			message: "m1",
			instanceId: "i1",
		});

		// A second process (`prime-agent monitor --ack`) loaded the file before the next enqueue.
		const acker = new NotificationOutbox(path);
		monitor.enqueue({
			alertKey: "k2",
			kind: "heartbeat_stale",
			severity: "warning",
			message: "m2",
			instanceId: "i1",
		});
		acker.acknowledge(first.id);

		const onDisk = new NotificationOutbox(path).list();
		const keys = onDisk.map((entry) => entry.alertKey);
		expect(keys, "the alert enqueued by the monitor must survive a concurrent ack").toContain("k2");
		expect(keys).toContain("k1");
		expect(onDisk.find((entry) => entry.alertKey === "k1")?.status).toBe("acknowledged");
	});
});
