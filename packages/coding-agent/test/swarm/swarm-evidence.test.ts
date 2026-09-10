import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	canonicalJson,
	createFixedFanoutScenario,
	createSwarmManifest,
	type ProcessSampler,
	redactEvidence,
	runSwarmBenchmark,
	type SwarmEvidenceCapability,
	verifySwarmEvidence,
	writeSwarmEvidence,
} from "./swarm-evidence.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const capabilities = new Map<string, SwarmEvidenceCapability>();
const fixedProcessSampler: ProcessSampler = {
	source: "test process sampler",
	sample: () => [{ pid: 1, rssBytes: 1, label: "fixture" }],
};
async function evidenceDirectory(fanout = 4): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "prime-agent-b00a-"));
	directories.push(directory);
	const evidence = await runSwarmBenchmark({
		...createFixedFanoutScenario(fanout as 1 | 4 | 16 | 64),
		processSampler: fixedProcessSampler,
	});
	capabilities.set(directory, await writeSwarmEvidence(directory, evidence));
	return directory;
}
function hash(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}
function capability(directory: string): SwarmEvidenceCapability {
	const issued = capabilities.get(directory);
	if (!issued) throw new Error(`missing test capability: ${directory}`);
	return issued;
}
async function verify(directory: string): Promise<void> {
	return verifySwarmEvidence(directory, capability(directory));
}
async function rehashArtifact(directory: string, path: string, raw: string): Promise<void> {
	await writeFile(join(directory, path), raw);
	const manifestPath = join(directory, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const artifact = manifest.artifacts.find((item: { path: string }) => item.path === path);
	artifact.bytes = Buffer.byteLength(raw);
	artifact.sha256 = hash(raw);
	manifest.artifactBundleId = hash(canonicalJson(manifest.artifacts));
	await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
}
describe("PR-B00A deterministic local swarm evidence", () => {
	test("has a stable public manifest fingerprint independent of host runtime", () => {
		const config = createFixedFanoutScenario(4);
		expect(createSwarmManifest(config).fingerprint).toBe(createSwarmManifest(config).fingerprint);
		expect(JSON.stringify(createSwarmManifest(config))).not.toContain("local-fake");
	});
	test("canonical serialization rejects lossy values and orders object keys", () => {
		expect(canonicalJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
		expect(() => canonicalJson({ value: undefined })).toThrow("undefined");
		expect(() => canonicalJson(NaN)).toThrow("non-finite");
	});
	test("writes a byte-identical logical oracle while timing remains separate", async () => {
		const first = await evidenceDirectory(),
			second = await evidenceDirectory();
		expect(await readFile(join(first, "oracle.jsonl"), "utf8")).toBe(
			await readFile(join(second, "oracle.jsonl"), "utf8"),
		);
		const oracle = await readFile(join(first, "oracle.jsonl"), "utf8");
		expect(oracle).toContain('"requestId":"request-0001"');
		expect(oracle).not.toContain("elapsedMilliseconds");
	});
	test.each([1, 4, 16, 64])("immediately dispatches every fixed fanout assignment (%i)", async (fanout) => {
		const evidence = await runSwarmBenchmark(createFixedFanoutScenario(fanout as 1 | 4 | 16 | 64));
		expect(evidence.summary).toMatchObject({
			admitted: fanout,
			started: fanout,
			completed: fanout,
			delivered: fanout,
			cleanedUp: fanout,
			independentDispatch: true,
		});
		const firstTerminal = evidence.events.findIndex((event) => event.type === "provider_completed");
		expect(
			evidence.events.slice(0, firstTerminal).filter((event) => event.type === "provider_request_started"),
		).toHaveLength(fanout);
	});
	test("retains only content-free facts, stable IDs, exact economics, and nested tree totals", async () => {
		const sampler: ProcessSampler = {
			sample: () => [
				{ pid: 11, rssBytes: 100, label: "root" },
				{ pid: 12, rssBytes: 250, label: "child" },
			],
		};
		const base = createFixedFanoutScenario(4);
		const evidence = await runSwarmBenchmark({
			...base,
			assignments: [
				{ ...base.assignments[0]!, parentNodeId: undefined, role: "lead" },
				{ ...base.assignments[1]!, parentNodeId: "child-1", role: "worker" },
				...base.assignments.slice(2),
			],
			processSampler: sampler,
			faultSchedule: [
				{
					nodeId: "child-1",
					actions: [
						{ type: "progress", message: "real-secret" },
						{ type: "delay", milliseconds: 1 },
						{ type: "restart", reason: "real-secret" },
						{ type: "completion", outputTokens: 7 },
					],
				},
				{ nodeId: "child-2", actions: [{ type: "failure", code: "offline", message: "Bearer top-secret" }] },
			],
		});
		expect(evidence.events.map((event) => event.type)).toContain("restart");
		expect(
			evidence.events.every(
				(event) => /^worker-\d{4}$/.test(event.nodeId) && /^request-\d{4}$/.test(event.requestId),
			),
		).toBe(true);
		expect(evidence.summary).toMatchObject({ completed: 3, failed: 1, delivered: 3, cleanedUp: 4 });
		expect(evidence.manifest.faultSchedule.map((schedule) => schedule.actions.map((action) => action.type))).toEqual([
			["progress", "delay", "restart", "completion"],
			["failure"],
		]);
		expect(evidence.processSamples.every((sample) => sample.totalRssBytes === 350)).toBe(true);
		const lead = evidence.costAttribution.find((cost) => cost.id === "role-0001");
		const run = evidence.costAttribution.find((cost) => cost.id === "run");
		expect(lead?.downstreamInputTokens).toBe(64);
		expect(run).toMatchObject({ kind: "run", directCost: 0 });
		expect(run?.downstreamCost).toBeGreaterThan(0);
	});
	test("accepts an empty process sample when the platform sampler has no visible processes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-agent-b00a-empty-processes-"));
		directories.push(directory);
		const evidence = await runSwarmBenchmark({
			...createFixedFanoutScenario(1),
			processSampler: { source: "unavailable platform sampler", sample: () => [] },
		});
		capabilities.set(directory, await writeSwarmEvidence(directory, evidence));
		const samples = JSON.parse(await readFile(join(directory, "process-samples.json"), "utf8"));
		expect(samples).toHaveLength(4);
		expect(
			samples.every(
				(sample: { processes: unknown[]; totalRssBytes: number }) =>
					sample.processes.length === 0 && sample.totalRssBytes === 0,
			),
		).toBe(true);
		await expect(verify(directory)).resolves.toBeUndefined();
	});
	test("whole artifacts are canary-safe even for unicode, chunks, paths, and ordinary fields", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-agent-b00a-canary-"));
		directories.push(directory);
		const canaries = [
			"absolutely-not-on-disk",
			"sk-should-not-survive",
			"S\u00c9CR\u00c8T-\ud83d\udd12",
			"split-canary-A",
			"split-canary-B",
			"/private/canary.txt",
		];
		const evidence = await runSwarmBenchmark({
			...createFixedFanoutScenario(1),
			metadata: {
				authorization: `Bearer ${canaries[0]}`,
				ordinary: canaries[2],
				chunks: [canaries[3], canaries[4]],
				path: canaries[5],
			},
			faultSchedule: [
				{
					nodeId: "child-1",
					actions: [
						{ type: "progress", message: canaries.join("") },
						{ type: "failure", code: canaries[0], message: canaries[1] },
					],
				},
			],
		});
		capabilities.set(directory, await writeSwarmEvidence(directory, evidence));
		const all = (
			await Promise.all(
				[
					"manifest.json",
					"events.jsonl",
					"oracle.jsonl",
					"process-samples.json",
					"cost-attribution.json",
					"summary.json",
				].map((name) => readFile(join(directory, name), "utf8")),
			)
		).join("\n");
		for (const canary of canaries) expect(all).not.toContain(canary);
		expect(all).toContain("[REDACTED]");
		await expect(verify(directory)).resolves.toBeUndefined();
		expect(redactEvidence({ apiKey: "x", normal: "safe" })).toEqual({ "[REDACTED]": "[REDACTED]" });
	});
	test("fails closed on tampering, missing, extra, symlink, duplicate index, reordering, and noncanonical evidence", async () => {
		const directory = await evidenceDirectory(1);
		await writeFile(join(directory, "summary.json"), "{}\n");
		await expect(verify(directory)).rejects.toThrow("hash mismatch");
		await rm(join(directory, "summary.json"));
		await expect(verify(directory)).rejects.toThrow("unexpected or missing");
		const extra = await evidenceDirectory(1);
		await writeFile(join(extra, "unindexed.json"), "{}\n");
		await expect(verify(extra)).rejects.toThrow("unexpected or missing");
		const link = await evidenceDirectory(1);
		await rm(join(link, "summary.json"));
		await symlink(join(link, "events.jsonl"), join(link, "summary.json"));
		await expect(verify(link)).rejects.toThrow("unsafe");
		const duplicate = await evidenceDirectory(1);
		const manifest = JSON.parse(await readFile(join(duplicate, "manifest.json"), "utf8"));
		manifest.artifacts[1] = manifest.artifacts[0];
		await writeFile(join(duplicate, "manifest.json"), `${canonicalJson(manifest)}\n`);
		await expect(verify(duplicate)).rejects.toThrow("invalid or duplicate");
		const reorder = await evidenceDirectory(1);
		const eventPath = join(reorder, "events.jsonl");
		const [a, b] = (await readFile(eventPath, "utf8")).trim().split("\n");
		await writeFile(eventPath, `${b}\n${a}\n`);
		await expect(verify(reorder)).rejects.toThrow("hash mismatch");
	});
	test("rejects a manifest whose valid hashes cover semantically invalid summary", async () => {
		const directory = await evidenceDirectory(1);
		const summaryPath = join(directory, "summary.json");
		const summary = JSON.parse(await readFile(summaryPath, "utf8"));
		summary.completed = 99;
		const summaryRaw = `${canonicalJson(summary)}\n`;
		await writeFile(summaryPath, summaryRaw);
		const manifestPath = join(directory, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const artifact = manifest.artifacts.find((item: { path: string }) => item.path === "summary.json");
		artifact.bytes = Buffer.byteLength(summaryRaw);
		const { createHash } = await import("node:crypto");
		artifact.sha256 = createHash("sha256").update(summaryRaw).digest("hex");
		manifest.artifactBundleId = createHash("sha256").update(canonicalJson(manifest.artifacts)).digest("hex");
		await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
		await expect(verify(directory)).rejects.toThrow("summary/event mismatch");
	});
	test("rejects recomputed hashes that hide broken exact economics", async () => {
		const directory = await evidenceDirectory(1);
		const costsPath = join(directory, "cost-attribution.json");
		const costs = JSON.parse(await readFile(costsPath, "utf8"));
		costs.find((cost: { kind: string }) => cost.kind === "node").directCost = 7;
		const costsRaw = `${canonicalJson(costs)}
`;
		await writeFile(costsPath, costsRaw);
		const manifestPath = join(directory, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const artifact = manifest.artifacts.find((item: { path: string }) => item.path === "cost-attribution.json");
		const { createHash } = await import("node:crypto");
		artifact.bytes = Buffer.byteLength(costsRaw);
		artifact.sha256 = createHash("sha256").update(costsRaw).digest("hex");
		manifest.artifactBundleId = createHash("sha256").update(canonicalJson(manifest.artifacts)).digest("hex");
		await writeFile(
			manifestPath,
			`${canonicalJson(manifest)}
`,
		);
		await expect(verify(directory)).rejects.toThrow("direct economics mismatch");
	});
	test("redacts arbitrary metadata keys as well as values throughout the written tree", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-agent-b00a-key-canary-"));
		directories.push(directory);
		const keyCanary = "ARBITRARY_METADATA_KEY_CANARY";
		const structuralKeyCanary = "provider";
		const evidence = await runSwarmBenchmark({
			...createFixedFanoutScenario(1),
			metadata: { [keyCanary]: "ordinary", [structuralKeyCanary]: "ordinary" },
		});
		capabilities.set(directory, await writeSwarmEvidence(directory, evidence));
		const tree = (
			await Promise.all(
				[
					"manifest.json",
					"events.jsonl",
					"oracle.jsonl",
					"process-samples.json",
					"cost-attribution.json",
					"summary.json",
				].map((name) => readFile(join(directory, name), "utf8")),
			)
		).join("\n");
		expect(tree).not.toContain(keyCanary);
		const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
		expect(manifest.metadata).not.toHaveProperty(structuralKeyCanary);
		expect(manifest.metadata).toEqual({ "[REDACTED]": "[REDACTED]" });
		await expect(verify(directory)).resolves.toBeUndefined();
	});
	test("rejects rehashed malformed process samples", async () => {
		const directory = await evidenceDirectory(1);
		await rehashArtifact(directory, "process-samples.json", "[]\n");
		await expect(verify(directory)).rejects.toThrow("process sample count");
	});
	test("rejects rehashed non-content-free event and oracle data", async () => {
		const directory = await evidenceDirectory(1);
		const eventsPath = join(directory, "events.jsonl");
		const events = (await readFile(eventsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		events[0].detail = { message: "ADVERSARIAL_EVENT_CANARY" };
		const raw = `${events.map(canonicalJson).join("\n")}\n`;
		await rehashArtifact(directory, "events.jsonl", raw);
		const oracle = events.map(({ elapsedMilliseconds: _elapsed, ...logical }) => logical);
		await rehashArtifact(directory, "oracle.jsonl", `${oracle.map(canonicalJson).join("\n")}\n`);
		await expect(verify(directory)).rejects.toThrow(/non-content-free|invalid event detail/);
	});
	test("binds direct cost usage to manifest assignments and terminal completion evidence", async () => {
		const directory = await evidenceDirectory(1);
		const costsPath = join(directory, "cost-attribution.json");
		const costs = JSON.parse(await readFile(costsPath, "utf8"));
		const node = costs.find((cost: { kind: string }) => cost.kind === "node");
		node.directInputTokens = 999;
		node.directCost = (999 + node.directOutputTokens * 2) / 1_000_000;
		node.downstreamInputTokens = 999;
		node.downstreamCost = node.directCost;
		const role = costs.find((cost: { kind: string }) => cost.kind === "role");
		role.directInputTokens = 999;
		role.downstreamInputTokens = 999;
		role.directCost = node.directCost;
		role.downstreamCost = node.directCost;
		const run = costs.find((cost: { kind: string }) => cost.kind === "run");
		run.downstreamInputTokens = 999;
		run.downstreamCost = node.directCost;
		await rehashArtifact(directory, "cost-attribution.json", `${canonicalJson(costs)}\n`);
		await expect(verify(directory)).rejects.toThrow("assignment input usage mismatch");
	});
	test("uses a stable deterministic subset plus an opaque issued artifact capability", async () => {
		const first = await evidenceDirectory(1),
			second = await evidenceDirectory(1);
		const firstManifest = JSON.parse(await readFile(join(first, "manifest.json"), "utf8"));
		const secondManifest = JSON.parse(await readFile(join(second, "manifest.json"), "utf8"));
		expect(firstManifest.deterministicBundleId).toBe(secondManifest.deterministicBundleId);
		expect(firstManifest.artifactBundleId).toBeDefined();
		const samples = JSON.parse(await readFile(join(first, "process-samples.json"), "utf8"));
		samples[0].processes[0].pid += 1;
		await rehashArtifact(first, "process-samples.json", `${canonicalJson(samples)}\n`);
		await expect(verify(first)).rejects.toThrow("issued swarm evidence capability bundle mismatch");
	});

	test("rejects a capability issued for a different evidence directory", async () => {
		const first = await evidenceDirectory(1);
		const second = await evidenceDirectory(1);
		await expect(verifySwarmEvidence(first, capability(second))).rejects.toThrow(
			"swarm evidence capability directory mismatch",
		);
	});

	test("rejects a manifest read-back value and a coherent forged bundle without its issued capability", async () => {
		const directory = await evidenceDirectory(1);
		const manifestPath = join(directory, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const costsPath = join(directory, "cost-attribution.json");
		const costs = JSON.parse(await readFile(costsPath, "utf8"));
		const node = costs.find((cost: { kind: string }) => cost.kind === "node");
		const role = costs.find((cost: { kind: string }) => cost.kind === "role");
		const run = costs.find((cost: { kind: string }) => cost.kind === "run");
		const eventsPath = join(directory, "events.jsonl");
		const events = (await readFile(eventsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		manifest.assignments[0].inputTokens = 999;
		await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
		const completion = events.find((event: { type: string }) => event.type === "provider_completed");
		completion.detail.outputTokens = 999;
		for (const row of [node, role, run]) {
			row.directInputTokens = row.kind === "run" ? 0 : 999;
			row.directOutputTokens = row.kind === "run" ? 0 : 999;
			row.downstreamInputTokens = 999;
			row.downstreamOutputTokens = 999;
			row.directCost = row.kind === "run" ? 0 : 999 / 1_000_000 + (999 * 2) / 1_000_000;
			row.downstreamCost = 999 / 1_000_000 + (999 * 2) / 1_000_000;
		}
		await rehashArtifact(directory, "events.jsonl", `${events.map(canonicalJson).join("\n")}\n`);
		await rehashArtifact(
			directory,
			"oracle.jsonl",
			`${events.map(({ elapsedMilliseconds: _elapsed, ...event }) => canonicalJson(event)).join("\n")}\n`,
		);
		await rehashArtifact(directory, "cost-attribution.json", `${canonicalJson(costs)}\n`);
		const forged = JSON.parse(await readFile(manifestPath, "utf8"));
		forged.fingerprint = hash(
			canonicalJson({
				schemaVersion: forged.schemaVersion,
				benchmarkVersion: forged.benchmarkVersion,
				scenario: forged.scenario,
				assignments: forged.assignments,
				faultSchedule: forged.faultSchedule,
				priceCard: forged.priceCard,
				metadata: forged.metadata,
			}),
		);
		forged.deterministicBundleId = hash(
			canonicalJson({
				oracle: await readFile(join(directory, "oracle.jsonl"), "utf8"),
				costAttribution: await readFile(costsPath, "utf8"),
				summary: await readFile(join(directory, "summary.json"), "utf8"),
			}),
		);
		forged.artifactBundleId = hash(canonicalJson(forged.artifacts));
		await writeFile(manifestPath, `${canonicalJson(forged)}\n`);
		const readBack = JSON.parse(await readFile(manifestPath, "utf8")).artifactBundleId;
		expect(typeof readBack).toBe("string");
		await expect(verifySwarmEvidence(directory, readBack)).rejects.toThrow(
			"issued swarm evidence capability is required",
		);
		await expect(verify(directory)).rejects.toThrow("issued swarm evidence capability bundle mismatch");
	});

	test("binds direct output usage to provider_completed terminal evidence", async () => {
		const directory = await evidenceDirectory(1);
		const costsPath = join(directory, "cost-attribution.json");
		const costs = JSON.parse(await readFile(costsPath, "utf8"));
		const node = costs.find((cost: { kind: string }) => cost.kind === "node");
		node.directOutputTokens = 999;
		node.directCost = (node.directInputTokens + 999 * 2) / 1_000_000;
		node.downstreamOutputTokens = 999;
		node.downstreamCost = node.directCost;
		const role = costs.find((cost: { kind: string }) => cost.kind === "role");
		role.directOutputTokens = 999;
		role.downstreamOutputTokens = 999;
		role.directCost = node.directCost;
		role.downstreamCost = node.directCost;
		const run = costs.find((cost: { kind: string }) => cost.kind === "run");
		run.downstreamOutputTokens = 999;
		run.downstreamCost = node.directCost;
		await rehashArtifact(directory, "cost-attribution.json", `${canonicalJson(costs)}\n`);
		await expect(verify(directory)).rejects.toThrow("terminal output usage mismatch");
	});
});
