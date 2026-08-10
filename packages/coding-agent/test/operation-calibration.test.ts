import { describe, expect, it } from "vitest";
import { buildOperationCalibrationReport } from "../src/modes/daemon/operation-calibration.js";
import type { OperationLedgerSnapshot, OperationRecord } from "../src/modes/daemon/operation-ledger.js";

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
