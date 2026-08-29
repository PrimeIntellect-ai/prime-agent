import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	AVO_INTERNAL_ABLATIONS_ENV,
	AvoSessionRuntime,
	activeAvoAblations,
	buildAvoRuntimePrompt,
	deriveAvoCandidateImpactSurfaces,
	deriveAvoCriticalAssumptionChecks,
	deriveAvoObjectiveObligations,
	parseAvoAblations,
} from "../src/core/avo/index.js";
import type { AvoCandidate, AvoRunState } from "../src/core/avo/types.js";

describe.sequential("AVO benchmark ablations", () => {
	afterEach(() => vi.unstubAllEnvs());

	test("rejects unknown internal feature names", () => {
		expect(() => parseAvoAblations("obligations,unknown")).toThrow("unknown internal AVO ablation feature");
	});

	test("disables only the selected obligation and impact gates", () => {
		vi.stubEnv(AVO_INTERNAL_ABLATIONS_ENV, "obligations,impact_verification");
		expect(activeAvoAblations()).toEqual(new Set(["obligations", "impact_verification"]));
		expect(deriveAvoObjectiveObligations("Implement A\n- Implement B", "coding", "required", "now")).toEqual([]);
		const candidate = {
			workspaceChangedPaths: ["src/api.ts", "README.md"],
		} as AvoCandidate;
		expect(deriveAvoCandidateImpactSurfaces(candidate)).toEqual([]);
	});

	test("removes only the critical-assumption gate", () => {
		vi.stubEnv(AVO_INTERNAL_ABLATIONS_ENV, "critical_assumptions");
		const state = {
			criticalAssumptions: [{ critical: true, status: "open" }],
		} as unknown as AvoRunState;
		expect(deriveAvoCriticalAssumptionChecks(state)).toEqual([]);
	});

	test("does not disclose the active condition in the model prompt", () => {
		vi.stubEnv(AVO_INTERNAL_ABLATIONS_ENV, "obligations,nooa");
		const state = {
			runId: "run",
			routing: { environment: "coding", horizon: "iterative", reasons: [], source: "host_auto", decidedAt: "now" },
			verificationClass: "coding",
			verificationPolicy: "required",
			verificationReasons: [],
		} as unknown as AvoRunState;
		const prompt = buildAvoRuntimePrompt(state, "secret recalled memory");
		expect(prompt).not.toContain("Benchmark ablation");
		expect(prompt).not.toContain("secret recalled memory");
		expect(prompt).not.toContain("explicit obligation ledger");
	});

	test("gives Gemini one explicit pre-completion obligation coverage action", () => {
		const state = {
			runId: "run",
			routing: { environment: "coding", horizon: "iterative", reasons: [], source: "host_auto", decidedAt: "now" },
			verificationClass: "coding",
			verificationPolicy: "required",
			verificationReasons: [],
			obligations: [{ obligationId: "requirement-1" }, { obligationId: "requirement-2" }],
		} as unknown as AvoRunState;
		const prompt = buildAvoRuntimePrompt(state);
		expect(prompt).toContain("AVO_OBLIGATIONS=required (2 host-derived requirements)");
		expect(prompt).toContain("await avo.cover_obligations");
		expect(prompt).toContain("Do not call complete_cycle or stop_gate until");
	});

	test("disables both NOOA and host-fallback recall", async () => {
		vi.stubEnv(AVO_INTERNAL_ABLATIONS_ENV, "nooa");
		const root = mkdtempSync(join(tmpdir(), "avo-nooa-ablation-"));
		const runtime = new AvoSessionRuntime(join(root, "artifacts"), "run", undefined, root, join(root, "agent"));
		expect(runtime.memoryBridge).toBeUndefined();
		expect(await runtime.recallMemory("prior result", { spontaneous: true })).toMatchObject({
			memories: [],
			context: "",
			reason: "NOOA retrieval disabled by an internal benchmark ablation",
		});
		runtime.dispose();
	});
});
