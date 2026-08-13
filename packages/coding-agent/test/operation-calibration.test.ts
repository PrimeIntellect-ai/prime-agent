import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOperationCalibrationReport } from "../src/modes/daemon/operation-calibration.js";
import {
	OperationLedger,
	type OperationLedgerSnapshot,
	type OperationRecord,
	OperationTracker,
} from "../src/modes/daemon/operation-ledger.js";
import { readOperationSnapshots } from "../src/modes/daemon/reliability-monitor.js";

function operation(index: number, overrides: Partial<OperationRecord> = {}): OperationRecord {
	const started = Date.parse("2026-08-10T10:00:00.000Z");
	return {
		schemaVersion: 1,
		operationId: `op-${index}`,
		activeSessionId: "active",
		kind: "provider",
		phase: "completed",
		status: "terminal",
		startedAt: new Date(started).toISOString(),
		updatedAt: new Date(started + index * 1_000).toISOString(),
		lastMeaningfulProgressAt: new Date(started).toISOString(),
		timeoutClass: "provider-advisory",
		outcome: "completed",
		...overrides,
	};
}

function snapshot(operations: OperationRecord[]): OperationLedgerSnapshot {
	return {
		schemaVersion: 1,
		instanceId: "instance",
		pid: 1,
		role: "daemon",
		processState: "closed",
		persistenceState: "durable",
		startedAt: "2026-08-10T10:00:00.000Z",
		heartbeatAt: "2026-08-10T11:00:00.000Z",
		operations,
	};
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-calibration-"));
	roots.push(root);
	return root;
}

function advance(clock: { value: number }, durationMs: number): void {
	clock.value += durationMs;
}

function driveCleanTrackerSession(tracker: OperationTracker, clock: { value: number }, suffix: string): void {
	tracker.handleSessionEvent({ type: "agent_start" });

	advance(clock, 1_000);
	tracker.handleSessionEvent({
		type: "message_start",
		id: `message-${suffix}`,
		message: { role: "assistant" },
	});
	advance(clock, 2_000);
	tracker.handleSessionEvent({
		type: "message_end",
		id: `message-${suffix}`,
		message: { role: "assistant" },
	});

	advance(clock, 1_000);
	tracker.handleSessionEvent({ type: "tool_execution_start", toolCallId: `tool-${suffix}`, toolName: "bash" });
	advance(clock, 1_000);
	tracker.handleSessionEvent({
		type: "process_ownership_update",
		status: "owned",
		pid: 7_001,
		processStartId: `start-${suffix}`,
		cleanupStatus: "verified",
	});
	advance(clock, 2_000);
	tracker.handleSessionEvent({ type: "tool_execution_end", toolCallId: `tool-${suffix}` });

	advance(clock, 1_000);
	tracker.handleSessionEvent({ type: "compaction_start", runId: `compaction-${suffix}` });
	advance(clock, 4_000);
	tracker.handleSessionEvent({ type: "compaction_end", runId: `compaction-${suffix}` });

	advance(clock, 1_000);
	tracker.handleSessionEvent({ type: "auto_retry_start", runId: `retry-${suffix}` });
	advance(clock, 5_000);
	tracker.handleSessionEvent({ type: "auto_retry_end", runId: `retry-${suffix}` });

	advance(clock, 1_000);
	tracker.handleSessionEvent({ type: "bash_start", callId: `bash-${suffix}` });
	advance(clock, 6_000);
	tracker.handleSessionEvent({ type: "bash_end", callId: `bash-${suffix}` });

	advance(clock, 1_000);
	tracker.handleSessionEvent({ type: "agent_end" });
}

describe("operation calibration", () => {
	it("requires a clean minimum sample before recommending hard enforcement", () => {
		const report = buildOperationCalibrationReport([snapshot([operation(1), operation(2), operation(3)])], {
			minimumCanarySamples: 3,
			now: Date.parse("2026-08-10T12:00:00.000Z"),
		});
		expect(report).toMatchObject({
			terminalSampleCount: 3,
			verdict: "canary_ready",
			hardEnforcementEligible: true,
		});
		expect(report.groups[0]).toMatchObject({
			sampleCount: 3,
			p50Ms: 2_000,
			p95Ms: 3_000,
			p99Ms: 3_000,
			advisoryHardCapMs: 4_500,
			hardEnforcementEligible: true,
		});
	});

	it("stays advisory when cleanup is uncertain or samples are sparse", () => {
		const report = buildOperationCalibrationReport(
			[snapshot([operation(1), operation(2, { cleanupStatus: "cleanup_uncertain", outcome: "uncertain" })])],
			{ minimumCanarySamples: 3 },
		);
		expect(report.verdict).toBe("telemetry_insufficient");
		expect(report.groups[0]).toMatchObject({
			uncertainOutcomeCount: 1,
			cleanupUncertainCount: 1,
			hardEnforcementEligible: false,
		});
	});
});

describe("operation calibration production telemetry", () => {
	it("builds a canary-ready report only from sufficient clean tracker telemetry reconstructed from durable state", () => {
		const rootDir = temporaryRoot();
		const clock = { value: Date.parse("2026-08-10T13:00:00.000Z") };
		const ledger = new OperationLedger({
			rootDir,
			instanceId: "calibration-clean",
			pid: process.pid,
			processStartId: "calibration-clean-start",
			now: () => clock.value,
			heartbeatIntervalMs: 0,
		});
		const tracker = new OperationTracker(ledger, {
			activeSessionId: "active-clean",
			sessionId: "session-clean",
			now: () => clock.value,
		});

		for (const suffix of ["one", "two", "three"]) driveCleanTrackerSession(tracker, clock, suffix);
		ledger.dispose();
		unlinkSync(ledger.snapshotPath);

		const snapshots = readOperationSnapshots(rootDir);
		expect(snapshots).toHaveLength(1);
		const operations = snapshots[0]!.operations;
		const turnId = "op_active-clean_turn_1";
		expect(operations.map((record) => record.operationId).sort()).toEqual(
			expect.arrayContaining([
				turnId,
				"op_active-clean_provider_message-one",
				"op_active-clean_tool_tool-one",
				"op_active-clean_compaction_compaction-one",
				"op_active-clean_retry_retry-one",
				"op_active-clean_bash_bash-one",
			]),
		);
		expect(
			new Set(
				operations
					.filter((record) => record.operationId.endsWith("-one") && record.kind !== "turn")
					.map((record) => record.parentOperationId),
			),
		).toEqual(new Set([turnId]));
		expect(operations.every((record) => record.status === "terminal" && record.outcome === "completed")).toBe(true);
		expect(operations.find((record) => record.operationId === "op_active-clean_tool_tool-one")).toMatchObject({
			parentOperationId: turnId,
			ownershipStatus: "owned",
			cleanupStatus: "verified",
			phase: "completed",
			status: "terminal",
			outcome: "completed",
		});

		const insufficient = buildOperationCalibrationReport(snapshots, {
			minimumCanarySamples: 4,
			now: clock.value,
		});
		expect(insufficient).toMatchObject({
			terminalSampleCount: 18,
			hardEnforcementEligible: false,
			verdict: "telemetry_insufficient",
		});

		const report = buildOperationCalibrationReport(snapshots, {
			minimumCanarySamples: 3,
			now: clock.value,
		});
		expect(report).toMatchObject({
			terminalSampleCount: 18,
			hardEnforcementEligible: true,
			verdict: "canary_ready",
		});
		expect(report.groups.map((group) => group.key)).toEqual([
			"bash:owned-bash-hard-cap",
			"compaction:compaction-advisory-cap",
			"provider:provider-advisory-cap",
			"retry:retry-advisory-cap",
			"tool:owned-tool-hard-cap",
			"turn:turn-advisory-cap",
		]);
		expect(
			report.groups.map((group) => ({
				key: group.key,
				p50Ms: group.p50Ms,
				p95Ms: group.p95Ms,
				p99Ms: group.p99Ms,
				maxMs: group.maxMs,
				advisoryHardCapMs: group.advisoryHardCapMs,
			})),
		).toEqual([
			{
				key: "bash:owned-bash-hard-cap",
				p50Ms: 6_000,
				p95Ms: 6_000,
				p99Ms: 6_000,
				maxMs: 6_000,
				advisoryHardCapMs: 9_000,
			},
			{
				key: "compaction:compaction-advisory-cap",
				p50Ms: 4_000,
				p95Ms: 4_000,
				p99Ms: 4_000,
				maxMs: 4_000,
				advisoryHardCapMs: 6_000,
			},
			{
				key: "provider:provider-advisory-cap",
				p50Ms: 2_000,
				p95Ms: 2_000,
				p99Ms: 2_000,
				maxMs: 2_000,
				advisoryHardCapMs: 3_000,
			},
			{
				key: "retry:retry-advisory-cap",
				p50Ms: 5_000,
				p95Ms: 5_000,
				p99Ms: 5_000,
				maxMs: 5_000,
				advisoryHardCapMs: 7_500,
			},
			{
				key: "tool:owned-tool-hard-cap",
				p50Ms: 3_000,
				p95Ms: 3_000,
				p99Ms: 3_000,
				maxMs: 3_000,
				advisoryHardCapMs: 4_500,
			},
			{
				key: "turn:turn-advisory-cap",
				p50Ms: 26_000,
				p95Ms: 26_000,
				p99Ms: 26_000,
				maxMs: 26_000,
				advisoryHardCapMs: 39_000,
			},
		]);
		for (const group of report.groups) {
			expect(group).toMatchObject({
				sampleCount: 3,
				lifetimeTerminalCount: 3,
				uncertainOutcomeCount: 0,
				cleanupUncertainCount: 0,
				hardEnforcementEligible: true,
			});
		}
	});

	it("does not launder an uncertain tracker close after terminal trimming and journal compaction", () => {
		const rootDir = temporaryRoot();
		const clock = { value: Date.parse("2026-08-10T14:00:00.000Z") };
		const maxJournalRecords = 16;
		const ledgerOptions = {
			rootDir,
			instanceId: "calibration-uncertain",
			pid: process.pid,
			processStartId: "calibration-uncertain-start",
			now: () => clock.value,
			heartbeatIntervalMs: 0,
			maxJournalRecords,
		};
		const ledger = new OperationLedger(ledgerOptions);
		const tracker = new OperationTracker(ledger, {
			activeSessionId: "active-uncertain",
			sessionId: "session-uncertain",
			now: () => clock.value,
		});

		tracker.handleSessionEvent({ type: "tool_execution_start", toolCallId: "uncertain-tool", toolName: "bash" });
		advance(clock, 1);
		tracker.handleSessionEvent({
			type: "process_ownership_update",
			status: "owned",
			pid: 8_001,
			processStartId: "uncertain-start",
			cleanupStatus: "uncertain",
		});
		advance(clock, 1);
		tracker.handleSessionEvent({
			type: "tool_execution_end",
			toolCallId: "uncertain-tool",
			isError: true,
			result: {
				details: {
					status: "aborted",
					cleanupStatus: "uncertain",
					survivingProcessIds: [8_002],
				},
			},
		});

		for (let index = 0; index < 600; index += 1) {
			const toolCallId = `clean-tool-${index}`;
			advance(clock, 1);
			tracker.handleSessionEvent({ type: "tool_execution_start", toolCallId, toolName: "bash" });
			advance(clock, 1);
			tracker.handleSessionEvent({ type: "tool_execution_end", toolCallId });
		}
		ledger.dispose();

		const compactedJournalRecords = readFileSync(ledger.journalPath, "utf8").trim().split("\n").filter(Boolean);
		expect(compactedJournalRecords.length).toBeLessThanOrEqual(maxJournalRecords);

		unlinkSync(ledger.snapshotPath);
		const snapshots = readOperationSnapshots(rootDir);
		expect(snapshots).toHaveLength(1);
		const report = buildOperationCalibrationReport(snapshots, {
			minimumCanarySamples: 100,
			now: clock.value,
		});
		const toolGroup = report.groups.find((group) => group.key === "tool:owned-tool-hard-cap");
		expect(report.terminalSampleCount).toBeLessThan(601);
		expect(toolGroup).toMatchObject({
			sampleCount: expect.any(Number),
			lifetimeTerminalCount: 601,
			uncertainOutcomeCount: 1,
			cleanupUncertainCount: 1,
			hardEnforcementEligible: false,
		});
		expect(toolGroup?.sampleCount).toBeLessThan(601);
		expect(toolGroup?.uncertaintyRate).toBeCloseTo(2 / 601);
		expect(report).toMatchObject({
			hardEnforcementEligible: false,
			verdict: "telemetry_insufficient",
		});
	});
});
