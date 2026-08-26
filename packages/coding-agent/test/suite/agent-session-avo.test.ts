import { writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("AgentSession universal AVO runtime", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("uses one default AVO substrate and automatically selects its internal adapter", async () => {
		harness = await createHarness({ persistSession: true });
		const initial = await harness.session.handleAvoHostRequest("avo.get");
		expect(initial.state).toMatchObject({
			sessionId: harness.session.sessionId,
			runId: `${harness.session.sessionId}:task-1`,
			environmentSelection: "auto",
			horizonSelection: "auto",
		});

		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Fix and test the parser implementation");
		const routed = await harness.session.handleAvoHostRequest("avo.get");
		expect(routed.state).toMatchObject({
			environmentSelection: "auto",
			horizonSelection: "auto",
			routing: { environment: "coding", horizon: "iterative", source: "host_auto" },
		});
		expect(harness.session.systemPrompt).toContain("AVO is Prime's default operating architecture");
		expect(harness.session.systemPrompt).toContain(
			"adapter=coding, horizon=iterative, and verification_policy=required",
		);
		expect(harness.session.systemPrompt).toContain("not separate modes");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("starts a clean task run after a policy-complete subjective task while retaining memory", async () => {
		harness = await createHarness({ persistSession: true });
		harness.setResponses([fauxAssistantMessage("draft")]);
		await harness.session.prompt("Write a poem about rain");
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: { candidate_id: "poem-1", kind: "answer", summary: "Rain poem", payload: "Rain sings." },
		});
		await harness.session.handleAvoHostRequest("avo.evaluation.record", {
			evaluation: {
				candidate_id: "poem-1",
				evaluator_id: "subjective_review",
				status: "pass",
				authority: "model_opinion",
				evidence_refs: [],
				metrics: { reviewed: true },
			},
		});
		await harness.session.handleAvoHostRequest("avo.cycle.complete", {
			cycle: { candidate_id: "poem-1" },
		});
		expect(await harness.session.handleAvoHostRequest("avo.stop_gate")).toMatchObject({
			stop_gate: { passed: true },
		});
		await harness.session.handleAvoHostRequest("avo.memory.remember", {
			memory: {
				namespace: "general",
				type: "STYLE",
				title: "Rain imagery",
				content: "The user accepted concise natural imagery.",
				importance: 5,
				source_ids: ["poem-1"],
			},
		});

		harness.setResponses([fauxAssistantMessage("explanation")]);
		await harness.session.prompt("Explain photosynthesis");
		const state = (await harness.session.handleAvoHostRequest("avo.get")).state;
		expect(state).toMatchObject({
			runId: `${harness.session.sessionId}:task-2`,
			objective: "Explain photosynthesis",
			verificationPolicy: "best_effort",
			routing: { environment: "general", horizon: "direct" },
			candidates: [],
			taskRuns: [{ runId: `${harness.session.sessionId}:task-1`, objective: "Write a poem about rain" }],
			memories: [{ memoryId: expect.any(String), namespace: "general" }],
		});
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
		await expect(
			harness.session.handleAvoHostRequest("avo.evaluation.record", {
				evaluation: {
					candidate_id: "patch-1",
					evaluator_id: "test",
					status: "pass",
					authority: "environment",
					evidence_refs: ["claimed:test:passed"],
					metrics: { passed: 7 },
				},
			}),
		).rejects.toThrow(/model-submitted evaluations must use authority=model_opinion/);
		writeFileSync(
			`${harness.tempDir}/parser.test.cjs`,
			"const test = require('node:test'); const assert = require('node:assert'); test('parser', () => assert.equal(2 + 2, 4));\n",
		);
		const observed = await harness.session.handleAvoHostRequest("avo.evaluation.run", {
			candidate_id: "patch-1",
			command: "node --test parser.test.cjs",
		});
		expect(observed.evaluation).toMatchObject({
			evaluatorId: "test",
			status: "pass",
			authority: "environment",
			issuedBy: "host",
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
		writeFileSync(`${harness.tempDir}/verify-decision.js`, "process.exit(0);\n");
		await harness.session.handleAvoHostRequest("avo.evaluation.run", {
			candidate_id: "decision-1",
			command: "node verify-decision.js",
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
