/**
 * Local no-cost PR-B00 rehearsal. This is test infrastructure, not a product CLI.
 *
 * (cd packages/coding-agent && npx tsx test/swarm/rehearsal-bench.ts -- --fanout 1,4,16,64 --output /tmp/swarm-evidence)
 * Add --faults to apply a fixed delay/progress/restart/failure schedule.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	createFixedFanoutScenario,
	type FakeProviderFaultSchedule,
	runSwarmBenchmark,
	SUPPORTED_SWARM_FANOUTS,
	writeSwarmEvidence,
} from "./swarm-evidence.js";

function readOption(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function parseFanouts(value: string | undefined): readonly (typeof SUPPORTED_SWARM_FANOUTS)[number][] {
	if (!value) return SUPPORTED_SWARM_FANOUTS;
	const fanouts = value.split(",").map(Number);
	if (
		fanouts.some((fanout) => !SUPPORTED_SWARM_FANOUTS.includes(fanout as (typeof SUPPORTED_SWARM_FANOUTS)[number]))
	) {
		throw new Error(`--fanout must contain only ${SUPPORTED_SWARM_FANOUTS.join(", ")}`);
	}
	return fanouts as (typeof SUPPORTED_SWARM_FANOUTS)[number][];
}

function fixedFaults(fanout: number): readonly FakeProviderFaultSchedule[] {
	const schedules: FakeProviderFaultSchedule[] = [
		{
			nodeId: "child-1",
			actions: [
				{ type: "progress", message: "local fake provider started" },
				{ type: "delay", milliseconds: 1 },
				{ type: "restart", reason: "scheduled fixture restart" },
				{ type: "completion", outputTokens: 16 },
			],
		},
	];
	if (fanout > 1)
		schedules.push({
			nodeId: "child-2",
			actions: [{ type: "failure", code: "fixture_failure", message: "deterministic local failure" }],
		});
	return schedules;
}

async function main(): Promise<void> {
	const output = readOption("--output") ?? "swarm-evidence";
	const withFaults = process.argv.includes("--faults");
	for (const fanout of parseFanouts(readOption("--fanout"))) {
		const config = createFixedFanoutScenario(fanout);
		const evidence = await runSwarmBenchmark({
			...config,
			faultSchedule: withFaults ? fixedFaults(fanout) : undefined,
		});
		const directory = join(output, config.scenario);
		await mkdir(directory, { recursive: true });
		await writeSwarmEvidence(directory, evidence);
		console.log(
			`${config.scenario}: ${evidence.summary.completed} completed, ${evidence.summary.failed} failed, independent dispatch=${evidence.summary.independentDispatch}`,
		);
	}
}

await main();
