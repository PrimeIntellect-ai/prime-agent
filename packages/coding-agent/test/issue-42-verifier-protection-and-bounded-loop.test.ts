import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AvoStore,
	captureAvoCodingVerificationBaseline,
	isTestFile,
	restoreAvoBaselineTestFiles,
	shouldActivateAvoSupervisor,
} from "../src/core/avo/index.js";
import { createHarness } from "./suite/harness.js";

describe("Issue #42: Verifier Protection, Equivalent Candidate Rejection & Bounded Loops", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `avo-issue42-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("1. recognizes verification, certification, and benchmark scripts as protected test files", () => {
		expect(isTestFile("verify_top_level_certification.py")).toBe(true);
		expect(isTestFile("check_solution.py")).toBe(true);
		expect(isTestFile("certify_performance.py")).toBe(true);
		expect(isTestFile("validate_output.py")).toBe(true);
		expect(isTestFile("grader_benchmark.py")).toBe(true);
		expect(isTestFile("tests/public/test_smoke.py")).toBe(true);
		expect(isTestFile("src/model_verifier.py")).toBe(true);
		expect(isTestFile("src/agent_certification.py")).toBe(true);

		// Regular source code should not be classified as test files
		expect(isTestFile("solution.py")).toBe(false);
		expect(isTestFile("agent.py")).toBe(false);
		expect(isTestFile("src/index.ts")).toBe(false);
	});

	it("2. denies candidate writes to protected verification files during candidate admission", () => {
		const verifierScript = "def verify():\n    return True\n";
		writeFileSync(join(tempDir, "verify_top_level_certification.py"), verifierScript, "utf8");
		writeFileSync(join(tempDir, "solution.py"), "def solve(): pass\n", "utf8");

		const baseline = captureAvoCodingVerificationBaseline(
			tempDir,
			"Implement solver and verify with top-level certification",
		);

		expect(baseline.testFiles.some((f) => f.path.includes("verify_top_level_certification.py"))).toBe(true);

		const store = new AvoStore(tempDir, "run-issue-42-test-1");
		store.setEnvironment("coding");
		store.setVerificationBaseline(baseline);

		// A candidate that modifies verify_top_level_certification.py MUST be rejected
		expect(() =>
			store.recordCandidate({
				candidateId: "cand-tampered-1",
				kind: "coding",
				summary: "Attempted tampering with verifier",
				payload: { solution: "tampered" },
				workspaceChangedPaths: ["verify_top_level_certification.py", "solution.py"],
			}),
		).toThrow(/candidate modified protected verification file.*verify_top_level_certification\.py/);
	});

	it("3. rejects equivalent / no-op successor candidates with matching payload and workspace digests", () => {
		const store = new AvoStore(tempDir, "run-issue-42-test-2");

		// Record Candidate 0
		const cand0 = store.recordCandidate({
			candidateId: "cand-0",
			kind: "claim_verification",
			summary: "Lanctot et al. (2017) quotation",
			payload: { quote: "Deep reinforcement learning from human preferences (Lanctot et al., 2017)" },
			workspaceDigest: "a".repeat(64),
		});
		expect(cand0.candidateId).toBe("cand-0");

		// Candidate 0 fails evaluation
		store.recordEvaluation(
			{
				candidateId: "cand-0",
				evaluatorId: "objective_verifier",
				status: "fail",
				authority: "host",
				evidenceRefs: ["host:ref-0"],
				metrics: { meaningful: false, objective_relation: "unrelated" },
			},
			"host",
		);

		// Complete cycle 0 as revised
		store.completeCycle({
			candidateId: "cand-0",
			failureSignature: "unrelated_quote",
		});

		// Candidate 1 has IDENTICAL payload and workspace digest as candidate 0
		expect(() =>
			store.recordCandidate({
				candidateId: "cand-1",
				kind: "claim_verification",
				summary: "Repeat of identical quote",
				payload: { quote: "Deep reinforcement learning from human preferences (Lanctot et al., 2017)" },
				workspaceDigest: "a".repeat(64),
			}),
		).toThrow(/equivalent successor candidate rejected.*candidate payload and workspace digests are identical/);

		// Candidate 2 has a DIFFERENT payload and must be accepted
		const cand2 = store.recordCandidate({
			candidateId: "cand-2",
			kind: "claim_verification",
			summary: "Materially changed quote addressing actual objective",
			payload: { quote: "Autonomous multi-agent coordination (Smith et al., 2024)" },
			workspaceDigest: "a".repeat(64),
		});
		expect(cand2.candidateId).toBe("cand-2");
	});

	it("4. restores candidate-tampered verifier files so execute callback never observes candidate-modified content", () => {
		const originalVerifier = "print('AUTHORITATIVE_VERIFIER_RUN')\n";
		writeFileSync(join(tempDir, "verify_top_level_certification.py"), originalVerifier, "utf8");

		const baseline = captureAvoCodingVerificationBaseline(
			tempDir,
			"Implement solver and verify with top-level certification",
		);

		const testFileEntry = baseline.testFiles.find((f) => f.path.includes("verify_top_level_certification.py"));
		expect(testFileEntry).toBeDefined();
		expect(testFileEntry?.content).toBe(originalVerifier);

		// Candidate corrupts the verifier file on disk (just like session 01a060bd)
		const corruptedVerifier = "print('FAKE_GRANDMASTER_PASS')\n";
		writeFileSync(join(tempDir, "verify_top_level_certification.py"), corruptedVerifier, "utf8");
		expect(readFileSync(join(tempDir, "verify_top_level_certification.py"), "utf8")).toBe(corruptedVerifier);

		// restoreAvoBaselineTestFiles runs before execution
		const { restored, tampered } = restoreAvoBaselineTestFiles(tempDir, baseline);
		expect(tampered).toBe(true);
		expect(restored.some((p) => p.includes("verify_top_level_certification.py"))).toBe(true);

		// Content on disk is guaranteed restored to pre-run baseline
		const postRestorationContent = readFileSync(join(tempDir, "verify_top_level_certification.py"), "utf8");
		expect(postRestorationContent).toBe(originalVerifier);
		expect(postRestorationContent).not.toContain("FAKE_GRANDMASTER_PASS");
	});

	it("5. treats 3 consecutive objective_relation=unrelated|insufficient cycles as bounded terminal recovery", () => {
		const store = new AvoStore(tempDir, "run-issue-42-test-3");

		// Cycle 1
		store.recordCandidate({
			candidateId: "cand-quote-1",
			kind: "claim_verification",
			summary: "Quote attempt 1",
			payload: { quote: "Irrelevant quote 1" },
		});
		store.recordEvaluation(
			{
				candidateId: "cand-quote-1",
				evaluatorId: "external_claim",
				status: "revise",
				authority: "external",
				evidenceRefs: ["host:evidence-ref"],
				metrics: { meaningful: false, objective_relation: "unrelated" },
			},
			"host",
		);
		store.completeCycle({ candidateId: "cand-quote-1" });
		expect(store.getState().status).toBe("active");

		// Cycle 2
		store.recordCandidate({
			candidateId: "cand-quote-2",
			kind: "claim_verification",
			summary: "Quote attempt 2",
			payload: { quote: "Irrelevant quote 2" },
		});
		store.recordEvaluation(
			{
				candidateId: "cand-quote-2",
				evaluatorId: "external_claim",
				status: "revise",
				authority: "external",
				evidenceRefs: ["host:evidence-ref"],
				metrics: { meaningful: false, objective_relation: "insufficient" },
			},
			"host",
		);
		store.completeCycle({ candidateId: "cand-quote-2" });
		expect(store.getState().status).toBe("active");

		// Cycle 3: 3rd consecutive unrelated objective relation
		store.recordCandidate({
			candidateId: "cand-quote-3",
			kind: "claim_verification",
			summary: "Quote attempt 3",
			payload: { quote: "Irrelevant quote 3" },
		});
		store.recordEvaluation(
			{
				candidateId: "cand-quote-3",
				evaluatorId: "external_claim",
				status: "revise",
				authority: "external",
				evidenceRefs: ["host:evidence-ref"],
				metrics: { meaningful: false, objective_relation: "unrelated" },
			},
			"host",
		);
		store.completeCycle({ candidateId: "cand-quote-3" });

		// Terminal recovery MUST have triggered
		const state = store.getState();
		expect(state.status).toBe("failed");
		expect(state.delivery.phase).toBe("failed");
		expect(state.delivery.failureCode).toBe("repeated_unrelated_objective");
		expect(state.delivery.failureReason).toContain("repeated objective-verifier rejections");

		// Supervisor activation MUST be prevented
		expect(shouldActivateAvoSupervisor(state)).toBe(false);

		// Candidate mutation MUST be blocked
		expect(() =>
			store.recordCandidate({
				candidateId: "cand-quote-4",
				kind: "claim_verification",
				summary: "Blocked attempt",
				payload: { quote: "Should not be recorded" },
			}),
		).toThrow(/AVO candidate mutation is blocked while canonical delivery phase=failed/);
	});

	it("6. live canary: delivers complete requested payload with stop-gate PASS and zero post-gate calls", async () => {
		let executions = 0;
		let candidateAdded = false;
		let cycleCompleted = false;

		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "Python",
			description: "Executes Python verification script and completes AVO cycle",
			parameters: Type.Object({ code: Type.String() }),
			execute: async (_toolCallId, params) => {
				executions += 1;
				const code = (params as { code: string }).code;

				if (code.includes("add_candidate")) {
					try {
						candidateAdded = true;
						await harness.session.handleAvoHostRequest("avo.candidate.add", {
							candidate: {
								candidate_id: "canary-cand-1",
								kind: "answer",
								summary: "Rain poem",
								payload: "Rain falls quietly from the clouds.",
							},
						});
						await harness.session.handleAvoHostRequest("avo.evaluation.record", {
							evaluation: {
								candidate_id: "canary-cand-1",
								evaluator_id: "subjective_review",
								status: "pass",
								authority: "model_opinion",
								evidence_refs: [],
								metrics: { reviewed: true },
							},
						});
						await harness.session.handleAvoHostRequest("avo.cycle.complete", {
							cycle: {
								candidate_id: "canary-cand-1",
							},
						});
						cycleCompleted = true;
					} catch (e) {
						console.error("DEBUG_ERROR_IN_TEST_6:", e);
					}
				}
				return { content: [{ type: "text", text: `ok:${code.slice(0, 30)}` }], details: {} };
			},
		};

		const harness = await createHarness({
			persistSession: true,
			enforceAvoCompletion: true,
			tools: [ipythonTool],
		});

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ipython", { code: 'await avo.add_candidate("canary-cand-1")' })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Rain falls quietly from the clouds.", { stopReason: "stop" }),
		]);

		await harness.session.prompt("Write a short poem about rain");

		expect(executions).toBe(1);
		expect(candidateAdded).toBe(true);
		expect(cycleCompleted).toBe(true);

		const getRes = await harness.session.handleAvoHostRequest("avo.get");
		const finalState = getRes.state as unknown as {
			cycles: Array<{ outcome: string }>;
			delivery: { phase: string };
		};
		expect(finalState?.cycles[0]?.outcome).toBe("accepted");
		expect(finalState?.delivery.phase).toBe("delivered");
	});
});
