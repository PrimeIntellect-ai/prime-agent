import {
	type OperationKind,
	type OperationLedgerSnapshot,
	type OperationLifetimeCounts,
	type OperationRecord,
	operationGroupKey,
} from "./operation-ledger.js";

// A group must be clean, not merely unremembered. Zero-over-all-history is unreachable by design —
// this mission deliberately produces `uncertain` outcomes rather than guessing — so eligibility is a
// rate over lifetime totals. Set to 0 for a literal zero-tolerance posture.
export const DEFAULT_MAXIMUM_UNCERTAINTY_RATE = 0;

export interface OperationCalibrationGroup {
	key: string;
	kind: OperationKind;
	timeoutClass: string;
	sampleCount: number;
	lifetimeTerminalCount: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
	uncertainOutcomeCount: number;
	cleanupUncertainCount: number;
	uncertaintyRate: number;
	advisoryHardCapMs: number;
	hardEnforcementEligible: boolean;
}

export interface OperationCalibrationReport {
	schemaVersion: 1;
	generatedAt: string;
	minimumCanarySamples: number;
	maximumUncertaintyRate: number;
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
	options: { minimumCanarySamples?: number; maximumUncertaintyRate?: number; now?: number } = {},
): OperationCalibrationReport {
	const minimumCanarySamples = options.minimumCanarySamples ?? 100;
	const maximumUncertaintyRate = options.maximumUncertaintyRate ?? DEFAULT_MAXIMUM_UNCERTAINTY_RATE;
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
		const key = operationGroupKey(record);
		const values = grouped.get(key) ?? [];
		values.push(record);
		grouped.set(key, values);
	}
	// Lifetime totals are merged across snapshots and never decrease, unlike anything derived from
	// `operations`, which is trimmed to a bounded window.
	const lifetimeByGroup = new Map<string, OperationLifetimeCounts>();
	for (const snapshot of snapshots) {
		for (const [key, counts] of Object.entries(snapshot.lifetimeByGroup ?? {})) {
			const total = lifetimeByGroup.get(key) ?? {
				terminalCount: 0,
				uncertainOutcomeCount: 0,
				cleanupUncertainCount: 0,
			};
			total.terminalCount += counts.terminalCount;
			total.uncertainOutcomeCount += counts.uncertainOutcomeCount;
			total.cleanupUncertainCount += counts.cleanupUncertainCount;
			lifetimeByGroup.set(key, total);
		}
	}

	// A group whose retained records have all aged out must still be considered. Dropping it would let
	// a group with known lifetime uncertainty disappear from the eligibility check entirely.
	for (const key of lifetimeByGroup.keys()) {
		if (!grouped.has(key)) grouped.set(key, []);
	}

	const groups = [...grouped.entries()]
		.map(([key, values]): OperationCalibrationGroup => {
			const durations = values.map((record) => terminalDuration(record)!).sort((left, right) => left - right);
			const p99Ms = percentile(durations, 0.99);
			// Percentiles stay windowed — recent latency is what an advisory cap should track. The
			// uncertainty evidence that gates enforcement does not, because forgetting it is exactly
			// how a dirty group would otherwise become eligible.
			const lifetime = lifetimeByGroup.get(key);
			const lifetimeTerminalCount = lifetime?.terminalCount ?? values.length;
			const uncertainOutcomeCount =
				lifetime?.uncertainOutcomeCount ?? values.filter((r) => r.outcome === "uncertain").length;
			const cleanupUncertainCount =
				lifetime?.cleanupUncertainCount ?? values.filter((r) => r.cleanupStatus === "cleanup_uncertain").length;
			const uncertaintyRate =
				lifetimeTerminalCount > 0 ? (uncertainOutcomeCount + cleanupUncertainCount) / lifetimeTerminalCount : 1;
			const hardEnforcementEligible =
				lifetimeTerminalCount >= minimumCanarySamples && uncertaintyRate <= maximumUncertaintyRate;
			// A lifetime-only group has no retained records to read kind/class from; recover them from
			// the key, which is exactly `${kind}:${timeoutClass}`.
			const separator = key.indexOf(":");
			return {
				key,
				kind: values[0]?.kind ?? (key.slice(0, separator) as OperationKind),
				timeoutClass: values[0]?.timeoutClass ?? key.slice(separator + 1),
				sampleCount: values.length,
				lifetimeTerminalCount,
				p50Ms: percentile(durations, 0.5),
				p95Ms: percentile(durations, 0.95),
				p99Ms,
				maxMs: durations.at(-1) ?? 0,
				uncertainOutcomeCount,
				cleanupUncertainCount,
				uncertaintyRate,
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
		maximumUncertaintyRate,
		terminalSampleCount: terminalRecords.length,
		groups,
		hardEnforcementEligible,
		verdict: hardEnforcementEligible ? "canary_ready" : "telemetry_insufficient",
	};
}
