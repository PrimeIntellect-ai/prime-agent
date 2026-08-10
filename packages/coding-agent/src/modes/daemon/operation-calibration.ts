import type { OperationKind, OperationLedgerSnapshot, OperationRecord } from "./operation-ledger.js";

export interface OperationCalibrationGroup {
	key: string;
	kind: OperationKind;
	timeoutClass: string;
	sampleCount: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
	uncertainOutcomeCount: number;
	cleanupUncertainCount: number;
	advisoryHardCapMs: number;
	hardEnforcementEligible: boolean;
}

export interface OperationCalibrationReport {
	schemaVersion: 1;
	generatedAt: string;
	minimumCanarySamples: number;
	terminalSampleCount: number;
	groups: OperationCalibrationGroup[];
	hardEnforcementEligible: boolean;
	verdict: "telemetry_insufficient" | "canary_ready";
}

function percentile(sorted: number[], percentileValue: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.max(1, Math.ceil(percentileValue * sorted.length));
	return sorted[Math.min(sorted.length - 1, rank - 1)]!;
}

function terminalDuration(record: OperationRecord): number | undefined {
	if (record.status !== "terminal") return undefined;
	const started = Date.parse(record.startedAt);
	const terminal = Date.parse(record.updatedAt);
	if (!Number.isFinite(started) || !Number.isFinite(terminal) || terminal < started) return undefined;
	return terminal - started;
}

export function buildOperationCalibrationReport(
	snapshots: OperationLedgerSnapshot[],
	options: { minimumCanarySamples?: number; now?: number } = {},
): OperationCalibrationReport {
	const minimumCanarySamples = options.minimumCanarySamples ?? 100;
	const records = new Map<string, OperationRecord>();
	for (const snapshot of snapshots) {
		for (const operation of snapshot.operations ?? []) {
			const prior = records.get(operation.operationId);
			if (!prior || prior.updatedAt < operation.updatedAt) records.set(operation.operationId, operation);
		}
	}
	const terminalRecords = [...records.values()].filter((record) => terminalDuration(record) !== undefined);
	const grouped = new Map<string, OperationRecord[]>();
	for (const record of terminalRecords) {
		const key = `${record.kind}:${record.timeoutClass ?? "unclassified"}`;
		const values = grouped.get(key) ?? [];
		values.push(record);
		grouped.set(key, values);
	}
	const groups = [...grouped.entries()]
		.map(([key, values]): OperationCalibrationGroup => {
			const durations = values.map((record) => terminalDuration(record)!).sort((left, right) => left - right);
			const p99Ms = percentile(durations, 0.99);
			const uncertainOutcomeCount = values.filter((record) => record.outcome === "uncertain").length;
			const cleanupUncertainCount = values.filter((record) => record.cleanupStatus === "cleanup_uncertain").length;
			const hardEnforcementEligible =
				values.length >= minimumCanarySamples && uncertainOutcomeCount === 0 && cleanupUncertainCount === 0;
			return {
				key,
				kind: values[0]!.kind,
				timeoutClass: values[0]!.timeoutClass ?? "unclassified",
				sampleCount: values.length,
				p50Ms: percentile(durations, 0.5),
				p95Ms: percentile(durations, 0.95),
				p99Ms,
				maxMs: durations.at(-1) ?? 0,
				uncertainOutcomeCount,
				cleanupUncertainCount,
				advisoryHardCapMs: Math.ceil(p99Ms * 1.5),
				hardEnforcementEligible,
			};
		})
		.sort((left, right) => left.key.localeCompare(right.key));
	const hardEnforcementEligible = groups.length > 0 && groups.every((group) => group.hardEnforcementEligible);
	return {
		schemaVersion: 1,
		generatedAt: new Date(options.now ?? Date.now()).toISOString(),
		minimumCanarySamples,
		terminalSampleCount: terminalRecords.length,
		groups,
		hardEnforcementEligible,
		verdict: hardEnforcementEligible ? "canary_ready" : "telemetry_insufficient",
	};
}
