import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	AVO_INTERNAL_ABLATIONS_ENV,
	buildAvoSupervisorMessage,
	buildAvoSupervisorPrompt,
	findAvoSupervisorResponseText,
	parseAvoSupervisorMessage,
	requiresAvoAdversarialReview,
	shouldActivateAvoSupervisor,
} from "../src/core/avo/index.js";
import type { AvoCheckpoint, AvoRunState } from "../src/core/avo/types.js";
import { summarizePrimeIntegrityTrace } from "../src/evals/prime-integrity/runner.js";

function state(options: { horizon?: "direct" | "iterative" | "long"; obligations?: number } = {}): AvoRunState {
	const horizon = options.horizon ?? "iterative";
	const cycleId = "cycle-accepted";
	return {
		routing: { environment: "coding", horizon, source: "host_auto", reasons: [], decidedAt: "now" },
		verificationPolicy: "required",
		objective: "Implement every parser requirement",
		cycles: [
			{
				cycleId,
				candidateId: "candidate",
				candidateKind: "implementation",
				evaluationIds: [],
				outcome: "accepted",
				completedAt: "now",
			},
		],
		obligations: Array.from({ length: options.obligations ?? 8 }, (_, index) => ({
			obligationId: `requirement-${index}`,
			critical: true,
		})),
	} as unknown as AvoRunState;
}

describe.sequential("AVO adversarial acceptance supervision", () => {
	afterEach(() => vi.unstubAllEnvs());

	test("reviews accepted requirement-dense iterative coding candidates", () => {
		const current = state();
		expect(requiresAvoAdversarialReview(current, "cycle-accepted")).toBe(true);
		expect(
			shouldActivateAvoSupervisor(current, {
				cycleId: "cycle-accepted",
				interventionNeeded: false,
			} as AvoCheckpoint),
		).toBe(true);
		const prompt = buildAvoSupervisorPrompt(current, "cycle-accepted", {});
		expect(prompt).toContain("acceptance reviewer");
		expect(prompt).toContain("Select at most three highest-risk specification boundaries");
		expect(prompt).toContain("may veto; it cannot create host evidence");
		expect(prompt).toContain("No tools are available");
		expect(prompt).not.toContain(JSON.stringify({}));
	});

	test("keeps direct and small iterative tasks lightweight", () => {
		expect(requiresAvoAdversarialReview(state({ horizon: "direct" }), "cycle-accepted")).toBe(false);
		expect(requiresAvoAdversarialReview(state({ obligations: 7 }), "cycle-accepted")).toBe(false);
	});

	test("keeps a dense adversarial review message below the retained-message limit", () => {
		const current = state({ horizon: "long", obligations: 40 });
		current.runId = "run-dense";
		current.objective = "Implement the complete dense specification. ".repeat(200);
		const context = {
			accepted_candidate: {
				candidate_id: "candidate",
				summary: "implemented a complete parser".repeat(20),
				changed_paths: ["regex_engine.py"],
			},
			critical_requirement_excerpts: Array.from({ length: 40 }, (_, index) => ({
				requirement_id: `requirement-${index}`,
				description: "handle a concrete grammar boundary and output shape",
			})),
			review_files: [
				{ path: "regex_engine.py", excerpt: "x".repeat(3_000), truncated: true },
				{ path: "test_specbench_contract.py", excerpt: "y".repeat(1_000), truncated: true },
			],
		};
		const message = buildAvoSupervisorMessage(current, "cycle-accepted", context);
		expect(message.length).toBeLessThanOrEqual(16_384);
		expect(message).toContain('"packet_version":2');
		expect(message).toContain('"review_files"');
	});

	test("supports a hidden benchmark ablation without disclosing it", () => {
		vi.stubEnv(AVO_INTERNAL_ABLATIONS_ENV, "adversarial_supervision");
		const current = state({ horizon: "long" });
		expect(requiresAvoAdversarialReview(current, "cycle-accepted")).toBe(false);
		expect(buildAvoSupervisorPrompt(current, "cycle-accepted", {})).not.toContain("acceptance reviewer");
	});

	test("exposes supervisor decisions in benchmark traces", () => {
		const root = mkdtempSync(join(tmpdir(), "avo-supervisor-trace-"));
		const stateDir = join(root, "run", "avo");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "state.json"),
			JSON.stringify({
				supervision: [{ status: "progressing" }, { status: "watch" }, { status: "intervene" }],
			}),
		);
		expect(summarizePrimeIntegrityTrace([], root)).toMatchObject({
			supervisorReviews: 3,
			supervisorProgressingReviews: 1,
			supervisorWatchReviews: 1,
			supervisorInterventions: 1,
		});
	});

	test("recovers every tool-free verdict from a retained child transcript", () => {
		const messages = [
			'AVO_SUPERVISION_JSON:cycle-one\n{"cycle_id":"cycle-one","status":"watch"}',
			'AVO_SUPERVISION_JSON:cycle-two\n{"cycle_id":"cycle-two","status":"progressing"}',
		];
		expect(findAvoSupervisorResponseText(messages, "cycle-one")).toContain('"status":"watch"');
		expect(findAvoSupervisorResponseText(messages, "cycle-two")).toContain('"status":"progressing"');
		expect(findAvoSupervisorResponseText(messages, "cycle-missing")).toBeUndefined();
	});

	test("downgrades a generic adversarial rubber stamp and accepts a bound counterexample analysis", () => {
		const bindings = { sourcePaths: ["parser.py"], requirementIds: ["requirement-edge"] };
		const message = (recommendedActions: string[]) =>
			`AVO_SUPERVISION_JSON:cycle\n${JSON.stringify({
				cycle_id: "cycle",
				status: "progressing",
				reason: "all requirements are verified",
				detected_patterns: ["looks_good"],
				recommended_actions: recommendedActions,
			})}`;
		expect(parseAvoSupervisorMessage(message(["Proceed with the implementation."]), "cycle", bindings)).toMatchObject(
			{
				status: "watch",
				detectedPatterns: ["looks_good", "uncalibrated_adversarial_review"],
			},
		);
		expect(
			parseAvoSupervisorMessage(
				message([
					"source=parser.py; requirement=requirement-edge; counterexample=empty nested group; expected=returns an empty capture; analysis=the epsilon transition preserves the capture slot",
				]),
				"cycle",
				bindings,
			),
		).toMatchObject({ status: "progressing" });
	});

	test("requires dense progressing reviews to analyze distinct and interacting requirements", () => {
		const bindings = {
			sourcePaths: ["parser.py"],
			requirementIds: ["requirement-a", "requirement-b", "requirement-c", "requirement-d"],
			minimumAnalyses: 3,
			requireCrossRequirement: true,
		};
		const response = (actions: string[]) =>
			`AVO_SUPERVISION_JSON:cycle\n${JSON.stringify({
				cycle_id: "cycle",
				status: "progressing",
				reason: "three boundaries were inspected",
				detected_patterns: [],
				recommended_actions: actions,
			})}`;
		const action = (requirement: string, related = "") =>
			`source=parser.py; requirement=${requirement}; related_requirement=${related}; counterexample=compound empty input; expected=stable structured result; analysis=the shown branch preserves the required state`;
		expect(
			parseAvoSupervisorMessage(
				response([action("requirement-a"), action("requirement-b"), action("requirement-c")]),
				"cycle",
				bindings,
			),
		).toMatchObject({ status: "watch" });
		expect(
			parseAvoSupervisorMessage(
				response([action("requirement-a", "requirement-d"), action("requirement-b"), action("requirement-c")]),
				"cycle",
				bindings,
			),
		).toMatchObject({ status: "progressing" });
	});
});
