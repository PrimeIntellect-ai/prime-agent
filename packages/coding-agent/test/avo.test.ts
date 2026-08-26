import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AutoresearchState, AutoresearchStopGate } from "../src/core/autoresearch.js";
import {
	AvoSessionRuntime,
	AvoStore,
	assessAvoHostCommand,
	CodingAvoAdapter,
	captureAvoWorkspaceSnapshot,
	classifyAvoHostEvaluationCommand,
	deriveAvoEvaluation,
	GeneralAvoAdapter,
	inferAvoEnvironment,
	inferAvoHorizon,
	inferAvoVerificationPolicy,
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
			workspaceDigest: "a".repeat(64),
			workspaceHead: "head-1",
			workspaceMode: "git",
		});
		runtime.recordHostEvaluation({
			evaluationId: "test-1",
			candidateId: candidate.candidateId,
			evaluatorId: "test",
			status: "pass",
			authority: "environment",
			evidenceRefs: ["test:parser:exit=0"],
			metrics: {
				passed: 18,
				meaningful: true,
				workspace_matches_candidate: true,
				candidate_payload_digest: candidate.payloadDigest,
			},
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
		store.recordEvaluation(
			{
				candidateId: candidate.candidateId,
				evaluatorId: "self_review",
				status: "pass",
				authority: "model_opinion",
				evidenceRefs: [],
				metrics: { confidence: 0.99 },
			},
			"model",
		);
		expect(store.completeCycle({ candidateId: candidate.candidateId }).cycle.outcome).toBe("inconclusive");
		expect(store.evaluateStopGate().passed).toBe(false);
	});

	test("rejects model-minted authority and allows transparent subjective policy completion", () => {
		const runtime = new AvoSessionRuntime(undefined, "run-subjective", clock());
		runtime.observeRootPrompt("Write a poem about rain");
		const candidate = runtime.recordCandidate({ kind: "answer", summary: "Rain poem", payload: "Rain sings." });
		expect(() =>
			runtime.recordEvaluation({
				candidateId: candidate.candidateId,
				evaluatorId: "claimed_external",
				status: "pass",
				authority: "external",
				evidenceRefs: ["claimed:external"],
				metrics: {},
			}),
		).toThrow(/model-issued evaluations must use authority=model_opinion/);
		runtime.recordEvaluation({
			candidateId: candidate.candidateId,
			evaluatorId: "subjective_review",
			status: "pass",
			authority: "model_opinion",
			evidenceRefs: [],
			metrics: { reviewed: true },
		});
		expect(runtime.completeCycle({ candidateId: candidate.candidateId }).cycle.outcome).toBe("accepted");
		expect(runtime.getState().verificationPolicy).toBe("not_applicable");
		expect(runtime.evaluateStopGate().passed).toBe(true);
	});

	test("requires executable feedback before a coding candidate becomes canonical", () => {
		const runtime = new AvoSessionRuntime(undefined, "run-coding-boundary", clock());
		runtime.configure({ environment: "coding", horizon: "direct", source: "user" });
		runtime.store.initialize("Implement the parser fix");
		const candidate = runtime.recordCandidate({
			kind: "patch",
			summary: "Parser patch",
			payload: { diff: "candidate" },
			workspaceDigest: "b".repeat(64),
			workspaceHead: "head-2",
			workspaceMode: "git",
		});
		runtime.recordHostEvaluation({
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

	test("does not let a successful runtime script certify a patch", () => {
		const runtime = new AvoSessionRuntime(undefined, "run-runtime-boundary", clock());
		runtime.configure({ environment: "coding", horizon: "direct", source: "user" });
		runtime.store.initialize("Implement the parser fix");
		const candidate = runtime.recordCandidate({
			kind: "patch",
			summary: "Parser patch",
			payload: { diff: "candidate" },
			workspaceDigest: "c".repeat(64),
			workspaceHead: "head-3",
			workspaceMode: "git",
		});
		runtime.recordHostEvaluation({
			candidateId: candidate.candidateId,
			evaluatorId: "runtime",
			status: "pass",
			authority: "environment",
			evidenceRefs: ["host:runtime:exit=0"],
			metrics: {
				meaningful: true,
				workspace_matches_candidate: true,
				candidate_payload_digest: candidate.payloadDigest,
			},
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
				issuedBy: "model",
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
				issuedBy: "host",
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
			store.recordEvaluation(
				{
					candidateId: candidate.candidateId,
					evaluatorId: "external_check",
					status: "fail",
					authority: "external",
					evidenceRefs: [`external:failure:${index}`],
					metrics: {},
				},
				"host",
			);
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
		store.recordEvaluation(
			{
				candidateId: candidate.candidateId,
				evaluatorId: "external",
				status: "pass",
				authority: "external",
				evidenceRefs: ["receipt:1"],
				metrics: {},
			},
			"host",
		);
		store.completeCycle({ candidateId: candidate.candidateId });
		expect(store.getState().routing.horizon).toBe("long");
	});

	test("requires the retained verifier to clear the latest long-horizon cycle", () => {
		const runtime = new AvoSessionRuntime(undefined, "run-long-verifier", clock());
		runtime.configure({ environment: "general", horizon: "long", source: "user" });
		runtime.store.initialize("Make a verified decision");
		const candidate = runtime.recordCandidate({ kind: "answer", summary: "Decision", payload: "grounded" });
		runtime.recordHostEvaluation({
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
		expect(initial.getState()).toMatchObject({ sessionId: "run-corrupt", runId: "run-corrupt:task-1" });
		writeFileSync(statePath, "{not-json\n", "utf8");
		const reopened = new AvoStore(dir, "run-corrupt", clock());
		expect(() => reopened.getState()).toThrow(/existing file was preserved/);
		expect(readFileSync(statePath, "utf8")).toBe("{not-json\n");
	});

	test("migrates the v1 session-level state into the first task run", () => {
		const dir = artifactDir();
		const statePath = join(dir, "avo", "state.json");
		const store = new AvoStore(dir, "legacy-session", clock());
		store.initialize("Legacy objective");
		const candidate = store.recordCandidate({ kind: "answer", summary: "Legacy answer", payload: "answer" });
		store.recordEvaluation(
			{
				evaluationId: "legacy-evaluation",
				candidateId: candidate.candidateId,
				evaluatorId: "legacy_host",
				status: "pass",
				authority: "environment",
				evidenceRefs: ["legacy:evidence"],
				metrics: {},
			},
			"host",
		);
		const legacy = structuredClone(store.getState()) as unknown as Record<string, unknown>;
		delete legacy.sessionId;
		delete legacy.taskRuns;
		delete legacy.verificationPolicy;
		delete legacy.verificationReasons;
		writeFileSync(statePath, JSON.stringify({ ...legacy, schemaVersion: 1, runId: "legacy-session" }), "utf8");
		const migratedStore = new AvoStore(dir, "legacy-session", clock());
		const migrated = migratedStore.getState();
		expect(migrated).toMatchObject({
			schemaVersion: 2,
			sessionId: "legacy-session",
			runId: "legacy-session:task-1",
			objective: "Legacy objective",
			taskRuns: [],
		});
		expect(migrated.evaluations).toContainEqual(
			expect.objectContaining({ evaluationId: "legacy-evaluation", issuedBy: "legacy_unverified" }),
		);
		migratedStore.recordEvaluation(
			{
				evaluationId: "legacy-evaluation",
				candidateId: candidate.candidateId,
				evaluatorId: "fresh_host",
				status: "pass",
				authority: "environment",
				evidenceRefs: ["host:fresh-evidence"],
				metrics: {},
			},
			"host",
		);
		expect(migratedStore.getState().evaluations).toContainEqual(
			expect.objectContaining({ evaluationId: "legacy-evaluation", issuedBy: "host", evaluatorId: "fresh_host" }),
		);
	});

	test("enforces memory namespaces and shared-memory provenance", () => {
		const store = new AvoStore(undefined, "run-memory", clock());
		store.initialize("Fix parser code");
		store.setEnvironment("coding");
		const codingCandidate = store.recordCandidate({
			candidateId: "coding-candidate",
			kind: "patch",
			summary: "Parser fix",
			payload: "diff",
		});
		store.recordEvaluation(
			{
				evaluationId: "coding-evaluation",
				candidateId: codingCandidate.candidateId,
				evaluatorId: "test",
				status: "pass",
				authority: "environment",
				evidenceRefs: ["host:test"],
				metrics: {},
			},
			"host",
		);
		store.completeCycle({ candidateId: codingCandidate.candidateId });
		store.complete();
		store.startTask("Find a research gap");
		store.setEnvironment("research");
		const researchCandidate = store.recordCandidate({
			candidateId: "research-candidate",
			kind: "research_problem",
			summary: "Verified gap",
			payload: "gap",
		});
		store.recordEvaluation(
			{
				evaluationId: "research-evaluation",
				candidateId: researchCandidate.candidateId,
				evaluatorId: "research_adapter",
				status: "pass",
				authority: "host",
				evidenceRefs: ["host:research"],
				metrics: {},
			},
			"host",
		);
		store.completeCycle({ candidateId: researchCandidate.candidateId });
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
		expect(
			store.remember({
				namespace: "shared",
				type: "PROCEDURE",
				title: "Cross-domain verification",
				content: "Bind conclusions to observed evidence.",
				tags: ["verification"],
				importance: 7,
				sourceIds: ["coding:coding-evaluation", "research:research-evaluation"],
			}),
		).toMatchObject({ namespace: "shared" });
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
		).toThrow(/shared memories require at least two resolved source_ids/);
		expect(() =>
			store.remember({
				namespace: "shared",
				type: "PROCEDURE",
				title: "Syntactic fake",
				content: "Fake references must not pass.",
				tags: [],
				importance: 5,
				sourceIds: ["coding:fake1", "research:fake2"],
			}),
		).toThrow(/does not resolve to accepted host-owned lineage/);
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

	test("treats a Git workspace as weak context for a non-coding prompt", () => {
		const dir = artifactDir();
		mkdirSync(join(dir, ".git"));
		const route = inferAvoEnvironment("Explain Bayesian inference", dir);
		expect(route).toMatchObject({ environment: "general" });
		expect(route.reasons).toContain("Git workspace treated as context only, not a routing decision");
		expect(inferAvoVerificationPolicy("Brainstorm name ideas", "general").policy).toBe("not_applicable");
	});

	test.each([
		["Check the latest weather", "general"],
		["Look up the latest version of package X", "general"],
		["Implement the school policy", "general"],
		["Fix the parser module", "coding"],
		["Test the API implementation", "coding"],
	] as const)("routes boundary-sensitive prompt %s to %s", (prompt, environment) => {
		expect(inferAvoEnvironment(prompt).environment).toBe(environment);
	});

	test("classifies only direct host-verifiable evaluation commands", () => {
		expect(classifyAvoHostEvaluationCommand("python -m pytest -q tests/test_parser.py")).toBe("test");
		expect(classifyAvoHostEvaluationCommand("npm run build")).toBe("build");
		expect(() => classifyAvoHostEvaluationCommand("true")).toThrow(/not a recognized host-verifiable/);
		expect(() => classifyAvoHostEvaluationCommand("pytest -q || true")).toThrow(/one direct command/);
		expect(() => classifyAvoHostEvaluationCommand("node verify.js & true")).toThrow(/one direct command/);
		expect(() => classifyAvoHostEvaluationCommand("pytest --collect-only")).toThrow(/discovery-only/);
		expect(() => classifyAvoHostEvaluationCommand("npx --yes node -e process.exit(0) vitest")).toThrow(
			/not a recognized host-verifiable/,
		);
	});

	test("requires observed test execution instead of exit zero alone", () => {
		expect(
			assessAvoHostCommand("test", {
				exitCode: 0,
				cancelled: false,
				truncated: false,
				output: "TAP version 13\n1..0\n# tests 0\n# pass 0\n",
			}),
		).toMatchObject({ status: "inconclusive", metrics: { meaningful: false, observed_work_units: 0 } });
		expect(
			assessAvoHostCommand("test", {
				exitCode: 0,
				cancelled: false,
				truncated: false,
				output: "# tests 2\n# pass 2\n# fail 0\n",
			}),
		).toMatchObject({ status: "pass", metrics: { meaningful: true, observed_work_units: 2 } });
	});

	test("changes the host workspace digest when a candidate file changes", () => {
		const dir = artifactDir();
		writeFileSync(join(dir, "parser.ts"), "export const value = 1;\n", "utf8");
		const first = captureAvoWorkspaceSnapshot(dir);
		writeFileSync(join(dir, "parser.ts"), "export const value = 2;\n", "utf8");
		const second = captureAvoWorkspaceSnapshot(dir);
		expect(first.mode).toBe("tree");
		expect(second.digest).not.toBe(first.digest);
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
