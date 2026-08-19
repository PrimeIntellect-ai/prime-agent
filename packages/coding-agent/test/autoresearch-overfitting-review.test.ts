import { describe, expect, it } from "vitest";
import {
	AUTO_RESEARCH_OVERFITTING_CHECKS,
	type AutoResearchOverfittingInput,
	type AutoResearchOverfittingReview,
	canProceedWithOverfittingReview,
	reviewOverfitting,
} from "../src/core/autoresearch/overfitting-review.js";
import type { AutoResearchExperimentRegistration, AutoResearchObservation } from "../src/core/autoresearch/types.js";
import type {
	WorkflowArtifactRef,
	WorkflowResourceVector,
	WorkflowRevisionResolution,
} from "../src/core/workflow/contracts.js";
import { digestObject } from "../src/core/workflow/contracts.js";

function ref(id: string): WorkflowArtifactRef {
	return {
		artifactId: id,
		relativePath: `evidence/${id}`,
		digest: `${id}-digest`,
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
}

function resource(): WorkflowResourceVector {
	return {
		cpuMilliCores: 1,
		memoryBytes: 1,
		diskBytes: 1,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 1,
		monetaryMicrounits: 1,
	};
}

function commandInputBinding() {
	const commandDigest = "command";
	const inputDigests = ["eval", "train"];
	return { commandDigest, inputDigests, bindingDigest: digestObject({ commandDigest, inputDigests }) };
}

function registration(): AutoResearchExperimentRegistration {
	return {
		runId: "run-1",
		workflowId: "workflow-1",
		revisionResolution: {
			registryEntryRef: ref("registry"),
			registryEntryId: "registry",
			registryEpoch: 1,
			revisionKind: "methodology",
			scope: "workflow",
			scopeBinding: { scope: "workflow", workflowId: "workflow-1" },
			registryStatus: "approved",
			compatibilityClosureDigest: "closure",
			expectedRegistryEpoch: 1,
			observedRegistryEpoch: 1,
			revocationEpoch: null,
			revocationEventSequence: null,
			rollbackOfRevisionId: null,
			rollbackEventSequence: null,
			casExecutionKey: "cas",
			hostReceipt: {} as WorkflowRevisionResolution["hostReceipt"],
			resolutionDigest: "resolution",
		},
		metric: { metricId: "metric", name: "score", direction: "lower", target: 0, tolerance: 0 },
		evaluator: { evaluatorDigest: "evaluator", parserDigest: "parser", commandDigest: "command" },
		commandInputBinding: commandInputBinding(),
		seed: { seedId: "seed", seedDigest: "seed" },
		fixtures: [
			{
				fixtureId: "train",
				partition: "train",
				inputDigest: "train",
				manifestDigest: "train-manifest",
				hidden: false,
			},
			{ fixtureId: "eval", partition: "eval", inputDigest: "eval", manifestDigest: "eval-manifest", hidden: false },
			{
				fixtureId: "holdout",
				partition: "holdout",
				inputDigest: "holdout",
				manifestDigest: "holdout-manifest",
				hidden: true,
			},
			{
				fixtureId: "adversarial",
				partition: "adversarial",
				inputDigest: "adversarial",
				manifestDigest: "adversarial-manifest",
				hidden: true,
			},
		],
		guard: { guardDigest: "guard" },
		requiredSampleSize: 2,
		maxCandidates: 2,
		maxVariance: 1,
		maxCostMicrounits: 10,
		maxLatencyMilliseconds: 10,
		resourceCeiling: resource(),
		hiddenHoldout: {
			handleId: "opaque",
			manifestDigest: "holdout-manifest",
			caseCount: 2,
			owner: "host",
			hidden: true,
			opaque: true,
			hostResolverOnly: true,
			bytesAccessibleToProposer: false,
			bytesAccessibleToWorker: false,
		},
	};
}

function observation(overrides: Partial<AutoResearchObservation> = {}): AutoResearchObservation {
	const value: Omit<AutoResearchObservation, "measurementDigest"> = {
		source: "host",
		observationId: "observation",
		candidateId: "candidate",
		attemptId: "attempt",
		phase: "exploration",
		status: "complete",
		commandInputBinding: commandInputBinding(),
		metricDirection: "lower",
		metricTarget: 0,
		metricTolerance: 0,
		sampleCount: 2,
		metricValue: 5,
		baselineMetricValue: 7,
		variance: 0,
		costMicrounits: 1,
		latencyMilliseconds: 1,
		resourceUsage: resource(),
		evaluatorDigest: "evaluator",
		parserDigest: "parser",
		guardDigest: "guard",
		seedDigest: "seed",
		fixtureManifestDigest: "train-manifest|eval-manifest",
		trainInputDigest: "train",
		evalInputDigest: "eval",
		heldOutInputDigest: null,
		proxySignals: [],
		hiddenMetricValue: null,
		adversarialMetricValue: null,
		candidateClaimedCompletion: false,
		candidateClaimedPromotion: false,
		rawResultRefsDigest: digestObject([]),
		...overrides,
	};
	const { source: _source, ...preimage } = value;
	const canDigest = [value.sampleCount, value.metricValue, value.baselineMetricValue, value.variance].every((entry) =>
		Number.isFinite(entry),
	);
	return { ...value, measurementDigest: canDigest ? digestObject({ source: "host", ...preimage }) : "invalid" };
}

function review(overrides: Partial<AutoResearchOverfittingInput> = {}): AutoResearchOverfittingReview {
	return reviewOverfitting({
		registration: registration(),
		observations: [observation()],
		evidenceRefs: [ref("observation")],
		hostHiddenHoldoutHandles: [
			{
				handleId: "opaque",
				manifestDigest: "holdout-manifest",
				caseCount: 2,
				owner: "host",
				hidden: true,
				opaque: true,
				hostResolverOnly: true,
				bytesAccessibleToProposer: false,
				bytesAccessibleToWorker: false,
			},
		],
		hiddenHoldoutEvidenceRefs: [ref("hidden")],
		adversarialEvidenceRefs: [ref("adversarial")],
		...overrides,
	});
}

describe("native AutoResearch overfitting review", () => {
	it("contains exactly the eight host checks and no authority", () => {
		expect(AUTO_RESEARCH_OVERFITTING_CHECKS).toEqual([
			"metric_preregistration_lock",
			"sample_adequacy",
			"train_eval_separation",
			"test_contamination",
			"repeated_holdout_peeking",
			"proxy_exploitation",
			"variance_replicate_stability",
			"hidden_adversarial_generalization",
		]);
		const result = review();
		expect(result.checkResults).toHaveLength(8);
		expect(result.emitsEvidenceOnly).toBe(true);
		expect(result.canAuthorize).toBe(false);
		expect(result.authorityCapabilities).toEqual([]);
	});

	it("is advisory during exploration but blocks holdout, canary, promotion, and completion", () => {
		const failing = review({ observations: [observation({ variance: 2 })] });
		expect(failing.disposition).toBe("advisory");
		expect(failing.accepted).toBe(false);
		const blocking = review({ phase: "completion" });
		expect(blocking.disposition).toBe("blocking");
		expect(blocking.accepted).toBe(false);
		const blocked = review({ phase: "holdout_passed", observations: [observation({ variance: 2 })] });
		expect(blocked.disposition).toBe("blocking");
		expect(blocked.accepted).toBe(false);
	});

	it("rejects hidden holdout bytes and accepts only opaque host handles", () => {
		expect(() =>
			review({ hiddenHoldoutBytes: "secret" } as unknown as Partial<AutoResearchOverfittingInput>),
		).toThrow(/hidden|bytes/i);
		const result = review();
		expect(result.proposerSeesHiddenHoldoutBytes).toBe(false);
		for (const check of result.checkResults) expect(check.hiddenHoldoutBytesExposed).toBe(false);
	});

	it("fails a blocking review when holdout and adversarial evidence alias", () => {
		const sameEvidence = [ref("same")];
		const result = review({
			phase: "completion",
			hiddenHoldoutEvidenceRefs: sameEvidence,
			adversarialEvidenceRefs: sameEvidence,
		});
		expect(result.accepted).toBe(false);
		expect(
			result.checkResults.find((check) => check.checkKind === "hidden_adversarial_generalization")?.disposition,
		).toBe("fail");
	});

	it("requires finite positive host samples and registered train/eval digests", () => {
		const insufficient = review({ observations: [observation({ sampleCount: Number.NaN })] });
		expect(insufficient.checkResults.find((check) => check.checkKind === "sample_adequacy")?.disposition).toBe(
			"fail",
		);
		const unregistered = review({
			observations: [observation({ trainInputDigest: "unknown-train", evalInputDigest: "unknown-eval" })],
		});
		expect(unregistered.checkResults.find((check) => check.checkKind === "train_eval_separation")?.disposition).toBe(
			"fail",
		);
	});

	it("never treats null hidden or adversarial measurements as generalization", () => {
		const result = review({ phase: "completion" });
		expect(
			result.checkResults.find((check) => check.checkKind === "hidden_adversarial_generalization")?.disposition,
		).toBe("fail");
		expect(result.accepted).toBe(false);
	});

	it("deep-freezes the review and does not accept a forged review-shaped object", () => {
		const result = review({ phase: "completion" });
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.checkResults)).toBe(true);
		expect(
			canProceedWithOverfittingReview(
				{
					...result,
					accepted: true,
					checkResults: result.checkResults.map((check) => ({ ...check, disposition: "pass" as const })),
				},
				"completion",
			),
		).toBe(false);
	});
});
