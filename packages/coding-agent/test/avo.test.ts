import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AutoresearchState, AutoresearchStopGate } from "../src/core/autoresearch.js";
import {
	AvoSessionRuntime,
	AvoStore,
	CodingAvoAdapter,
	deriveAvoEvaluation,
	GeneralAvoAdapter,
	inferAvoEnvironment,
	inferAvoHorizon,
	parseAvoSupervisorMessage,
	ResearchAvoAdapter,
	shouldActivateAvoSupervisor,
} from "../src/core/avo/index.js";

function artifactDir(): string {
	return mkdtempSync(join(tmpdir(), "prime-avo-test-"));
}

function clock(): () => string {
	let tick = 0;
	return () => `2026-08-26T00:00:${String(tick++).padStart(2, "0")}.000Z`;
}

describe("generic AVO core", () => {
	test("persists a host-authoritative accepted lineage across restart", () => {
		const dir = artifactDir();
		const runtime = new AvoSessionRuntime(dir, "run-1", clock(), "/workspace/repo");
		runtime.configure({ environment: "coding", horizon: "iterative", source: "user" });
		runtime.store.initialize("Fix the failing parser");
		const candidate = runtime.recordCandidate({
			candidateId: "patch-1",
			kind: "patch",
			summary: "Validate the parser boundary",
			payload: { diff: "sha256:abc" },
		});
		runtime.recordEvaluation({
			evaluationId: "test-1",
			candidateId: candidate.candidateId,
			evaluatorId: "test",
			status: "pass",
			authority: "environment",
			evidenceRefs: ["test:parser:exit=0"],
			metrics: { passed: 18 },
		});
		const completed = runtime.completeCycle({ candidateId: candidate.candidateId });
		expect(completed.cycle.outcome).toBe("accepted");
		expect(runtime.store.evaluateStopGate().passed).toBe(true);

		const reopened = new AvoStore(dir, "run-1", clock());
		expect(reopened.getState().cycles).toHaveLength(1);
		expect(reopened.getState().lineage.some((entry) => entry.kind === "candidate_accepted")).toBe(true);
		expect(reopened.evaluateStopGate().passed).toBe(true);
	});

	test("does not promote model opinion into canonical progress", () => {
		const store = new AvoStore(undefined, "run-opinion", clock());
		store.initialize("Write a pleasing answer");
		const candidate = store.recordCandidate({ kind: "answer", summary: "Draft answer", payload: "draft" });
		store.recordEvaluation({
			candidateId: candidate.candidateId,
			evaluatorId: "self_review",
			status: "pass",
			authority: "model_opinion",
			evidenceRefs: [],
			metrics: { confidence: 0.99 },
		});
		expect(store.completeCycle({ candidateId: candidate.candidateId }).cycle.outcome).toBe("inconclusive");
		expect(store.evaluateStopGate().passed).toBe(false);
	});

	test("requires executable feedback before a coding candidate becomes canonical", () => {
		const runtime = new AvoSessionRuntime(undefined, "run-coding-boundary", clock());
		runtime.configure({ environment: "coding", horizon: "direct", source: "user" });
		runtime.store.initialize("Implement the parser fix");
		const candidate = runtime.recordCandidate({
			kind: "patch",
			summary: "Parser patch",
			payload: { diff: "candidate" },
		});
		runtime.recordEvaluation({
			candidateId: candidate.candidateId,
			evaluatorId: "self_review",
			status: "pass",
			authority: "external",
			evidenceRefs: ["review:looks-good"],
			metrics: {},
		});
		expect(runtime.completeCycle({ candidateId: candidate.candidateId }).cycle.outcome).toBe("inconclusive");
		expect(runtime.evaluateStopGate().passed).toBe(false);
	});

	test("rejects an invalid coding candidate before it reaches durable lineage", () => {
		const runtime = new AvoSessionRuntime(undefined, "run-invalid-kind", clock());
		runtime.configure({ environment: "coding", source: "user" });
		expect(() =>
			runtime.recordCandidate({ kind: "answer", summary: "Only an answer", payload: { text: "done" } }),
		).toThrow(/coding candidates/);
		expect(runtime.getState().candidates).toHaveLength(0);
	});

	test("mirrors research reviewers, experiments, and claim promotion idempotently", () => {
		const runtime = new AvoSessionRuntime(undefined, "run-research-adapter", clock());
		const researchState = {
			schemaVersion: 1,
			objective: "Find a publication-grade gap",
			updatedAt: "2026-08-26T00:00:00.000Z",
			cycles: [
				{
					cycleId: "research-cycle-1",
					candidate: {
						candidateId: "research-candidate-1",
						statement: "Authority calibration remains unresolved",
						motivation: "Verified evidence",
						mechanisticMotivation: "Authority drift",
						closestPriorArt: "Paper A",
						unresolvedQuestions: ["Does calibration help?"],
						falsifier: "No effect",
						experimentDesign: "Controlled intervention",
						baselinePlan: "No calibration",
						broaderRelevance: "Long-horizon agents",
						requirements: [],
					},
					outcome: "promoted",
					reviewers: [
						{
							role: "literature_auditor",
							verdict: "pass",
							summary: "Evidence is bound",
							objections: [],
							queries: ["authority calibration"],
							inspectedPaperIds: ["doi:10.1000/example"],
							evidenceBindings: [
								{ paperId: "doi:10.1000/example", exactPointer: "Section 3", finding: "Gap remains" },
							],
							collisionPaperIds: [],
						},
					],
					searchReceiptIds: ["search-1"],
					preliminaryEvidenceExperimentIds: ["experiment-1"],
					canonicalPromotionIds: ["claim-1"],
					papersAdded: 1,
					fieldMapChanged: true,
				},
			],
			experiments: [
				{
					experimentId: "experiment-1",
					status: "completed",
					artifactReceipts: [{ path: "results.json", sha256: "a".repeat(64), size: 42, verifiedAt: "now" }],
					metrics: { score: 0.9 },
				},
			],
		} as unknown as AutoresearchState;
		const stopGate = { passed: true, checks: {}, reasons: [] } as unknown as AutoresearchStopGate;

		runtime.syncResearchState(researchState, stopGate, "/tmp/autoresearch/state.json");
		runtime.syncResearchState(researchState, stopGate, "/tmp/autoresearch/state.json");
		const state = runtime.getState();
		expect(state.cycles).toHaveLength(1);
		expect(state.evaluations.map((item) => item.evaluationId)).toEqual([
			"research-cycle:research-cycle-1",
			"research-review:research-cycle-1:literature_auditor",
			"research-experiment:experiment-1",
		]);
		expect(state.lineage.filter((item) => item.referenceId === "autoresearch:claim:claim-1")).toHaveLength(1);
	});

	test("lets authoritative failure override an apparent pass", () => {
		const derived = deriveAvoEvaluation([
			{
				evaluationId: "opinion",
				candidateId: "candidate",
				evaluatorId: "self",
				status: "pass",
				authority: "model_opinion",
				evidenceRefs: [],
				metrics: {},
				createdAt: "now",
			},
			{
				evaluationId: "test",
				candidateId: "candidate",
				evaluatorId: "test",
				status: "fail",
				authority: "environment",
				evidenceRefs: ["test:exit=1"],
				metrics: {},
				createdAt: "now",
			},
		]);
		expect(derived.status).toBe("fail");
		expect(derived.canonical).toBe(false);
	});

	test("escalates direct to iterative and repeated stagnation to long", () => {
		const store = new AvoStore(undefined, "run-escalate", clock());
		store.initialize("Investigate a recurring failure");
		store.setEnvironment("general");
		store.setHorizon("auto");
		for (let index = 0; index < 3; index++) {
			const candidate = store.recordCandidate({
				candidateId: `candidate-${index}`,
				kind: "approach",
				summary: `Attempt ${index}`,
				payload: { index },
			});
			store.recordEvaluation({
				candidateId: candidate.candidateId,
				evaluatorId: "external_check",
				status: "fail",
				authority: "external",
				evidenceRefs: [`external:failure:${index}`],
				metrics: {},
			});
			store.completeCycle({
				candidateId: candidate.candidateId,
				failureSignature: "same failure",
				trajectoryFingerprint: "same approach",
			});
			if (index === 0) expect(store.getState().routing.horizon).toBe("iterative");
		}
		expect(store.getState().routing.horizon).toBe("long");
		expect(store.getState().checkpoints.at(-1)?.status).toBe("intervene");
	});

	test("never lowers an explicit long horizon automatically", () => {
		const store = new AvoStore(undefined, "run-long", clock());
		store.initialize("Audit everything");
		store.setHorizon("long");
		const candidate = store.recordCandidate({ kind: "answer", summary: "Result", payload: "ok" });
		store.recordEvaluation({
			candidateId: candidate.candidateId,
			evaluatorId: "external",
			status: "pass",
			authority: "external",
			evidenceRefs: ["receipt:1"],
			metrics: {},
		});
		store.completeCycle({ candidateId: candidate.candidateId });
		expect(store.getState().routing.horizon).toBe("long");
	});

	test("requires the retained verifier to clear the latest long-horizon cycle", () => {
		const runtime = new AvoSessionRuntime(undefined, "run-long-verifier", clock());
		runtime.configure({ environment: "general", horizon: "long", source: "user" });
		runtime.store.initialize("Make a verified decision");
		const candidate = runtime.recordCandidate({ kind: "answer", summary: "Decision", payload: "grounded" });
		runtime.recordEvaluation({
			candidateId: candidate.candidateId,
			evaluatorId: "external_check",
			status: "pass",
			authority: "external",
			evidenceRefs: ["external:verified"],
			metrics: {},
		});
		const result = runtime.completeCycle({ candidateId: candidate.candidateId });
		const pendingGate = runtime.evaluateStopGate();
		expect(pendingGate.passed).toBe(false);
		expect(pendingGate.checks).toContainEqual(expect.objectContaining({ id: "trajectory_verifier", passed: false }));
		runtime.store.recordSupervision({
			cycleId: result.cycle.cycleId,
			status: "progressing",
			reason: "The evidence changed and the candidate passed an external check.",
			detectedPatterns: [],
			recommendedActions: [],
			source: "retained_supervisor",
		});
		expect(runtime.evaluateStopGate().passed).toBe(true);
	});

	test("keeps corrupt state untouched and fails closed", () => {
		const dir = artifactDir();
		const statePath = join(dir, "avo", "state.json");
		const initial = new AvoStore(dir, "run-corrupt", clock());
		expect(initial.getState().runId).toBe("run-corrupt");
		writeFileSync(statePath, "{not-json\n", "utf8");
		const reopened = new AvoStore(dir, "run-corrupt", clock());
		expect(() => reopened.getState()).toThrow(/existing file was preserved/);
		expect(readFileSync(statePath, "utf8")).toBe("{not-json\n");
	});

	test("enforces memory namespaces and shared-memory provenance", () => {
		const store = new AvoStore(undefined, "run-memory", clock());
		store.remember({
			namespace: "coding",
			type: "FAILED_DIRECTION",
			title: "Timeout was irrelevant",
			content: "Changing the timeout did not fix the parser race.",
			tags: ["parser", "timeout"],
			importance: 8,
			sourceIds: ["cycle-1"],
		});
		expect(store.recall("parser timeout", ["coding", "shared"])).toHaveLength(1);
		expect(() =>
			store.remember({
				namespace: "shared",
				type: "PROCEDURE",
				title: "Unproven cross-domain rule",
				content: "Apply everywhere.",
				tags: [],
				importance: 5,
				sourceIds: [],
			}),
		).toThrow(/shared memories require source_ids/);
	});

	test("reopens namespaced memory without losing its canonical provenance", () => {
		const dir = artifactDir();
		const store = new AvoStore(dir, "run-memory-reopen", clock());
		store.remember({
			memoryId: "memory-1",
			namespace: "coding",
			type: "FAILED_DIRECTION",
			title: "Timeout change failed",
			content: "The parser race remained after increasing the timeout.",
			tags: ["parser", "timeout"],
			importance: 8,
			sourceIds: ["cycle-1"],
		});
		const reopened = new AvoStore(dir, "run-memory-reopen", clock());
		expect(reopened.recall("parser timeout", ["coding", "shared"])).toMatchObject([
			{ memoryId: "memory-1", namespace: "coding", sourceIds: ["cycle-1"] },
		]);
	});
});

describe("AVO routing and adapters", () => {
	test.each([
		["Explain TCP", "general", "direct"],
		["Fix and test this parser bug", "coding", "iterative"],
		["Run autoresearch for a publication-grade research gap", "research", "long"],
	] as const)("routes %s to %s + %s", (prompt, environment, horizon) => {
		const routedEnvironment = inferAvoEnvironment(prompt);
		expect(routedEnvironment.environment).toBe(environment);
		expect(inferAvoHorizon(prompt, routedEnvironment.environment).horizon).toBe(horizon);
	});

	test.each([
		["general", new GeneralAvoAdapter()],
		["coding", new CodingAvoAdapter()],
		["research", new ResearchAvoAdapter()],
	] as const)("provides a %s dashboard adapter", (environment, adapter) => {
		const store = new AvoStore(undefined, `run-${environment}`, clock());
		store.initialize("Adapter test");
		store.setEnvironment(environment);
		const projection = adapter.dashboardProjection(store.getState());
		expect(projection.environment).toBe(environment);
		expect(projection.phases.length).toBeGreaterThanOrEqual(4);
		if (environment === "general")
			expect(projection.sections.some((section) => section.id === "general_evidence")).toBe(true);
		if (environment === "coding")
			expect(projection.sections.some((section) => section.id === "coding_feedback")).toBe(true);
	});

	test.each(["general", "coding", "research"] as const)(
		"supports all explicit horizons for the %s environment",
		(environment) => {
			for (const horizon of ["direct", "iterative", "long"] as const) {
				const runtime = new AvoSessionRuntime(undefined, `matrix-${environment}-${horizon}`, clock());
				runtime.configure({ environment, horizon, source: "user" });
				expect(runtime.getState().routing).toMatchObject({ environment, horizon });
				expect(runtime.dashboardProjection()).toMatchObject({ environment, horizon });
			}
		},
	);

	test("parses only the bound generic supervisor cycle", () => {
		const parsed = parseAvoSupervisorMessage(
			'AVO_SUPERVISION_JSON:cycle-1\n{"cycle_id":"cycle-1","status":"watch","reason":"repetition","detected_patterns":["same failure"],"recommended_actions":["change approach"]}',
			"cycle-1",
		);
		expect(parsed.status).toBe("watch");
		expect(() =>
			parseAvoSupervisorMessage(
				'AVO_SUPERVISION_JSON:cycle-2\n{"cycle_id":"cycle-2","status":"watch","reason":"x","detected_patterns":[],"recommended_actions":[]}',
				"cycle-1",
			),
		).toThrow(/omitted/);
	});

	test("activates retained supervision only for long work or an iterative intervention", () => {
		const store = new AvoStore(undefined, "run-supervision", clock());
		store.initialize("Check activation rules");
		expect(shouldActivateAvoSupervisor(store.getState())).toBe(false);
		store.setHorizon("iterative");
		expect(shouldActivateAvoSupervisor(store.getState())).toBe(false);
		store.setHorizon("long");
		expect(shouldActivateAvoSupervisor(store.getState())).toBe(true);
	});
});
