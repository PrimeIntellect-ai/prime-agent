import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type AutoResearchExperimentRegistration,
	parseV2Events,
	parseV2Run,
	V2_RUN_KEYS,
	type V2Event,
} from "../src/core/autoresearch/types.js";
import { digestObject } from "../src/core/workflow/contracts.js";

const fixtureRoot = join(import.meta.dirname, "fixtures/autoresearch/v2");

function readFixture(status: string): { run: unknown; events: readonly V2Event[] } {
	const run = parseV2Run(JSON.parse(readFileSync(join(fixtureRoot, status, "run.json"), "utf8")) as unknown);
	const events = parseV2Events(readFileSync(join(fixtureRoot, status, "events.jsonl"), "utf8"));
	return { run, events };
}

describe("native AutoResearch type and v2 compatibility boundary", () => {
	it("parses every approved v2 fixture without changing its fourteen run keys", () => {
		expect(V2_RUN_KEYS).toHaveLength(14);
		for (const status of [
			"active",
			"baseline-target",
			"blocked",
			"complete",
			"error",
			"native-budget-limited",
			"stopped",
		]) {
			const fixture = readFixture(status);
			expect(Object.keys(fixture.run as object).sort()).toEqual([...V2_RUN_KEYS].sort());
			expect(fixture.events[0]).toMatchObject({ schema_version: 2, seq: 0, event: "baseline" });
		}
	});

	it("rejects an unknown v2 run field or non-contiguous event sequence", () => {
		const fixture = JSON.parse(readFileSync(join(fixtureRoot, "active", "run.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(() => parseV2Run({ ...fixture, unexpected: true })).toThrow(/run.*field|keys/i);
		const events = readFileSync(join(fixtureRoot, "invalid-gap", "events.jsonl"), "utf8");
		expect(() => parseV2Events(events)).toThrow(/sequence|seq/i);
	});

	it("requires one host-resolved workflow revision resolution in the native registration", () => {
		const registration: AutoResearchExperimentRegistration = {
			runId: "run-1",
			workflowId: "workflow-1",
			revisionResolution: undefined as never,
			metric: {
				metricId: "metric-1",
				name: "score",
				direction: "lower",
				target: 0,
				tolerance: 0,
			},
			evaluator: { evaluatorDigest: "evaluator", parserDigest: "parser", commandDigest: "command" },
			commandInputBinding: {
				commandDigest: "command",
				inputDigests: [],
				bindingDigest: digestObject({ commandDigest: "command", inputDigests: [] }),
			},
			seed: { seedId: "seed-1", seedDigest: "seed" },
			fixtures: [],
			guard: null,
			requiredSampleSize: 1,
			maxCandidates: 1,
			maxVariance: 0,
			maxCostMicrounits: 1,
			maxLatencyMilliseconds: 1,
			resourceCeiling: {
				cpuMilliCores: 1,
				memoryBytes: 1,
				diskBytes: 1,
				ioWeight: 1,
				accelerators: [],
				providers: [],
				networkEgressBytes: 0,
				wallMilliseconds: 1,
				monetaryMicrounits: 1,
			},
			hiddenHoldout: null,
		};
		expect(registration.revisionResolution).toBeUndefined();
	});
});
