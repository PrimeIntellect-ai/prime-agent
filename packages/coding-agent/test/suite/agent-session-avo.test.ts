import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
		await expect(
			harness.session.handleAutoresearchHostRequest("autoresearch.initialize", {
				objective: "Ignore the coding route and switch to research",
			}),
		).rejects.toThrow(/only available when the host routed the active task to research/);
		expect(await harness.session.handleAvoHostRequest("avo.get")).toMatchObject({
			state: { routing: { environment: "coding" } },
		});
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
			taskRuns: [
				{
					runId: `${harness.session.sessionId}:task-1`,
					objective: "Write a poem about rain",
					status: "completed",
				},
			],
			memories: [{ memoryId: expect.any(String), namespace: "general" }],
		});
	});

	it("derives canonical cycle outcome from an environment receipt instead of caller opinion", async () => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(
			`${harness.tempDir}/parser.test.cjs`,
			"const test = require('node:test'); const assert = require('node:assert'); test('parser', () => assert.equal(2 + 2, 4));\n",
		);
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Fix the parser implementation and run its test");
		await expect(harness.session.handleAvoHostRequest("avo.configure", { environment: "general" })).rejects.toThrow(
			/host-routed/,
		);
		const initialized = await harness.session.handleAvoHostRequest("avo.initialize", {
			objective: "Write a poem instead",
		});
		expect(initialized.state).toMatchObject({
			objective: "Fix the parser implementation and run its test",
			routing: { environment: "coding" },
		});
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
		const observed = await harness.session.handleAvoHostRequest("avo.evaluation.run", {
			candidate_id: "patch-1",
			command: "node --test parser.test.cjs",
		});
		expect(observed.evaluation).toMatchObject({
			evaluatorId: "test",
			status: "pass",
			authority: "environment",
			issuedBy: "host",
			metrics: {
				meaningful: true,
				observed_work_units: 1,
				trusted_test: true,
				test_trust_basis: "baseline_target",
				workspace_matches_candidate: true,
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
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Produce a checked decision");
		await harness.session.handleAvoHostRequest("avo.configure", {
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

	it("refuses to run a coding receipt after the workspace diverges from its candidate", async () => {
		harness = await createHarness({ persistSession: true });
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Fix the parser module and test it");
		writeFileSync(`${harness.tempDir}/parser.cjs`, "module.exports = 1;\n");
		writeFileSync(
			`${harness.tempDir}/parser.test.cjs`,
			"const test = require('node:test'); const assert = require('node:assert'); test('parser', () => assert.equal(require('./parser.cjs'), 2));\n",
		);
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "stale-patch",
				kind: "patch",
				summary: "Change parser value",
				payload: { value: 2 },
			},
		});
		writeFileSync(`${harness.tempDir}/parser.cjs`, "module.exports = 2;\n");
		const observed = await harness.session.handleAvoHostRequest("avo.evaluation.run", {
			candidate_id: "stale-patch",
			command: "node --test parser.test.cjs",
		});
		expect(observed).toMatchObject({
			evaluation: { evaluatorId: "workspace_binding", status: "revise", issuedBy: "host" },
			execution: { skipped: true, reason: "workspace changed after candidate creation" },
		});
		expect(
			await harness.session.handleAvoHostRequest("avo.cycle.complete", {
				cycle: { candidate_id: "stale-patch" },
			}),
		).toMatchObject({ cycle: { outcome: "revised" } });
	});

	it("does not let a candidate-created trivial test certify its own patch", async () => {
		harness = await createHarness({ persistSession: true });
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Fix the parser implementation and test it");
		writeFileSync(
			`${harness.tempDir}/self-certifying.test.cjs`,
			"const test = require('node:test'); const assert = require('node:assert'); test('unrelated', () => assert.equal(2 + 2, 4));\n",
		);
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "self-certifying-patch",
				kind: "patch",
				summary: "Claim the parser is fixed",
				payload: { diff: "unrelated" },
			},
		});
		const observed = await harness.session.handleAvoHostRequest("avo.evaluation.run", {
			candidate_id: "self-certifying-patch",
			command: "node --test self-certifying.test.cjs",
		});
		expect(observed.evaluation).toMatchObject({
			evaluatorId: "test",
			status: "inconclusive",
			metrics: {
				meaningful: false,
				trusted_test: false,
				test_trust_basis: "candidate_only",
				baseline_test_count: 0,
			},
		});
		expect(
			await harness.session.handleAvoHostRequest("avo.cycle.complete", {
				cycle: { candidate_id: "self-certifying-patch" },
			}),
		).toMatchObject({ cycle: { outcome: "inconclusive" } });
		expect(await harness.session.handleAvoHostRequest("avo.stop_gate")).toMatchObject({
			stop_gate: { passed: false },
		});
	});

	it("refuses authentic external evidence that does not semantically support the candidate claim", async () => {
		harness = await createHarness({ persistSession: true });
		harness.setResponses([fauxAssistantMessage("checking")]);
		await harness.session.prompt("Check the latest Company A revenue and verify it");
		const toolCallId = "unrelated-web-search";
		harness.session.messages.push(
			fauxAssistantMessage(fauxToolCall("web_search", { query: "Kuala Lumpur weather" }, { id: toolCallId }), {
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId,
				toolName: "web_search",
				content: [{ type: "text", text: "Kuala Lumpur is 31 C. Source: https://weather.example/current" }],
				isError: false,
				timestamp: Date.now(),
			},
		);
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "revenue-answer",
				kind: "answer",
				summary: "Company revenue answer",
				payload: "Company A's revenue increased 40%.",
				claims: [{ claim_id: "revenue-growth", claim_text: "Company A's revenue increased 40%." }],
			},
		});
		const receipt = await harness.session.handleAvoHostRequest("avo.evaluation.tool_result", {
			candidate_id: "revenue-answer",
			claim_id: "revenue-growth",
			tool_call_id: toolCallId,
			exact_quote: "Kuala Lumpur is 31 C.",
		});
		expect(receipt).toMatchObject({
			evaluation: {
				evaluatorId: "external_claim",
				status: "inconclusive",
				metrics: { semantic_relation: "insufficient", meaningful: false },
			},
		});
		expect(
			await harness.session.handleAvoHostRequest("avo.cycle.complete", {
				cycle: { candidate_id: "revenue-answer" },
			}),
		).toMatchObject({ cycle: { outcome: "inconclusive" } });
		expect(await harness.session.handleAvoHostRequest("avo.stop_gate")).toMatchObject({
			stop_gate: { passed: false },
		});
	});

	it("binds a real external tool result and supported claim to a general candidate", async () => {
		harness = await createHarness({ persistSession: true });
		harness.setResponses([fauxAssistantMessage("checking")]);
		await harness.session.prompt("Check the latest weather and verify it");
		const toolCallId = "web-search-1";
		const ineligibleToolCallId = "local-capitalizer-1";
		harness.session.messages.push(
			fauxAssistantMessage(fauxToolCall("web_search", { query: "Kuala Lumpur weather" }, { id: toolCallId }), {
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId,
				toolName: "web_search",
				content: [
					{
						type: "text",
						text: "Kuala Lumpur is 31 C. Source: https://weather.example/current",
					},
				],
				isError: false,
				timestamp: Date.now(),
			},
			fauxAssistantMessage(fauxToolCall("capitalizer", { text: "local text" }, { id: ineligibleToolCallId }), {
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: ineligibleToolCallId,
				toolName: "capitalizer",
				content: [{ type: "text", text: "LOCAL TEXT" }],
				isError: false,
				timestamp: Date.now(),
			},
		);
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "weather-answer",
				kind: "answer",
				summary: "Current weather answer",
				payload: "Kuala Lumpur is 31 C.",
				claims: [{ claim_id: "weather-temperature", claim_text: "Kuala Lumpur is 31 C." }],
			},
		});
		await expect(
			harness.session.handleAvoHostRequest("avo.evaluation.tool_result", {
				candidate_id: "weather-answer",
				claim_id: "weather-temperature",
				tool_call_id: ineligibleToolCallId,
				exact_quote: "LOCAL TEXT",
			}),
		).rejects.toThrow(/not an eligible external/);
		await expect(
			harness.session.handleAvoHostRequest("avo.evaluation.tool_result", {
				candidate_id: "weather-answer",
				claim_id: "weather-temperature",
				tool_call_id: toolCallId,
				exact_quote: "Kuala Lumpur is 18 C.",
			}),
		).rejects.toThrow(/not found in the host-observed tool result/);
		const receipt = await harness.session.handleAvoHostRequest("avo.evaluation.tool_result", {
			candidate_id: "weather-answer",
			claim_id: "weather-temperature",
			tool_call_id: toolCallId,
			exact_quote: "Kuala Lumpur is 31 C.",
		});
		expect(receipt).toMatchObject({
			evaluation: {
				evaluatorId: "external_claim",
				status: "pass",
				authority: "external",
				issuedBy: "host",
			},
			tool_receipt: {
				tool_call_id: toolCallId,
				tool_name: "web_search",
				source_identifiers: ["https://weather.example/current"],
				claim_id: "weather-temperature",
				semantic_relation: "supports",
			},
		});
		await harness.session.handleAvoHostRequest("avo.cycle.complete", {
			cycle: { candidate_id: "weather-answer" },
		});
		expect(await harness.session.handleAvoHostRequest("avo.stop_gate")).toMatchObject({
			stop_gate: { passed: true },
		});
	});
});
