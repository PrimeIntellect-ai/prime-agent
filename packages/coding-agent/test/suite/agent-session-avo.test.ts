import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("AgentSession universal AVO runtime", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("persists one AVO substrate for every root session and handles explicit overrides without a model call", async () => {
		harness = await createHarness({ persistSession: true });
		const initial = await harness.session.handleAvoHostRequest("avo.get");
		expect(initial.state).toMatchObject({
			runId: harness.session.sessionId,
			environmentSelection: "auto",
			horizonSelection: "auto",
		});

		await harness.session.prompt("/mode coding");
		await harness.session.prompt("/horizon long");
		const configured = await harness.session.handleAvoHostRequest("avo.get");
		expect(configured.state).toMatchObject({
			environmentSelection: "coding",
			horizonSelection: "long",
			routing: { environment: "coding", horizon: "long", source: "user" },
		});
		expect(harness.session.systemPrompt).toContain("environment=coding; horizon=long");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("derives canonical cycle outcome from an environment receipt instead of caller opinion", async () => {
		harness = await createHarness({ persistSession: true });
		await harness.session.handleAvoHostRequest("avo.configure", {
			environment: "coding",
			horizon: "direct",
		});
		await harness.session.handleAvoHostRequest("avo.initialize", { objective: "Fix parser" });
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "patch-1",
				kind: "patch",
				summary: "Fix parser boundary",
				payload: { diff: "host-hashes-this" },
			},
		});
		await harness.session.handleAvoHostRequest("avo.evaluation.record", {
			evaluation: {
				candidate_id: "patch-1",
				evaluator_id: "test",
				status: "pass",
				authority: "environment",
				evidence_refs: ["vitest:parser:exit=0"],
				metrics: { passed: 7 },
			},
		});
		const completed = await harness.session.handleAvoHostRequest("avo.cycle.complete", {
			cycle: { candidate_id: "patch-1", claimed_outcome: "rejected" },
		});
		expect(completed).toMatchObject({ cycle: { outcome: "accepted" }, activateSupervisor: false });
		expect(await harness.session.handleAvoHostRequest("avo.stop_gate")).toMatchObject({
			stop_gate: { passed: true },
		});
	});

	it("keeps a completed long-horizon cycle durable when supervisor startup is unavailable", async () => {
		harness = await createHarness({ persistSession: true });
		await harness.session.handleAvoHostRequest("avo.configure", {
			environment: "general",
			horizon: "long",
		});
		await harness.session.handleAvoHostRequest("avo.initialize", { objective: "Produce a checked decision" });
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "decision-1",
				kind: "answer",
				summary: "Checked decision",
				payload: { result: "grounded" },
			},
		});
		await harness.session.handleAvoHostRequest("avo.evaluation.record", {
			evaluation: {
				candidate_id: "decision-1",
				evaluator_id: "external_check",
				status: "pass",
				authority: "external",
				evidence_refs: ["external:decision:verified"],
				metrics: {},
			},
		});
		const result = await harness.session.handleAvoHostRequest("avo.cycle.complete", {
			cycle: { candidate_id: "decision-1" },
		});
		expect(result).toMatchObject({
			cycle: { candidateId: "decision-1", outcome: "accepted" },
			activateSupervisor: true,
			supervisor: null,
		});
		expect((result.delivery as { error: string }).error).toContain("retained-child messaging");
		expect(await harness.session.handleAvoHostRequest("avo.stop_gate")).toMatchObject({
			stop_gate: { passed: false },
		});
		expect((await harness.session.handleAvoHostRequest("avo.get")).state).toMatchObject({
			cycles: [{ candidateId: "decision-1", outcome: "accepted" }],
		});
	});
});
