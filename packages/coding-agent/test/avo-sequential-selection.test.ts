import { describe, expect, test } from "vitest";
import {
	AVO_EXPERIMENT_FAMILYWISE_ALPHA,
	type AvoExperiment,
	type AvoExperimentPlan,
	type AvoTrial,
	avoStudentTUpperTailProbability,
	deriveAvoExperimentAllocatedAlpha,
	deriveAvoExperimentCumulativeAlpha,
	deriveAvoExperimentOutcome,
	digestAvoExperimentSelectionBinding,
	digestAvoExperimentValue,
} from "../src/core/avo/index.js";

function seededUniform(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return (state + 0.5) / 4_294_967_296;
	};
}

function standardNormal(uniform: () => number): number {
	const first = Math.max(Number.MIN_VALUE, uniform());
	return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * uniform());
}

function oneSidedMeanPValue(values: readonly number[]): number {
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
	const standardError = Math.sqrt(variance / values.length);
	return avoStudentTUpperTailProbability(mean / standardError, values.length - 1);
}

function confirmationExperiment(attemptIndex: number): AvoExperiment {
	const plan: AvoExperimentPlan = {
		stage: "confirmation",
		mode: "prospective",
		candidateIds: ["baseline", "challenger"],
		conditions: [
			{
				conditionId: "suite",
				label: "suite",
				parameters: {},
				commandTemplate: "node benchmark.cjs --candidate {{candidate_id}} --seed {{seed}}",
			},
		],
		seeds: ["1", "2", "3", "4", "5"],
		pairing: "paired",
		primaryMetric: "score",
		metricDirection: "maximize",
		baselineCandidateId: "baseline",
		confirmationOfExperimentId: "screening",
		promotion: {
			minimumPairedObservations: 5,
			minimumAbsoluteEffect: 1,
			minimumRelativeEffect: 0,
		},
		expectedTrials: 10,
	};
	const experiment: AvoExperiment = {
		experimentId: `confirmation-${attemptIndex}`,
		title: "Marginal challenger confirmation",
		hypothesis: "The challenger improves score by more than one point.",
		design: "Five paired observations.",
		plan,
		status: "completed",
		trialIds: [],
		tags: [],
		createdAt: "2026-08-28T00:00:00.000Z",
		updatedAt: "2026-08-28T00:00:01.000Z",
	};
	const bindingDigest = digestAvoExperimentSelectionBinding(experiment.experimentId, plan);
	plan.selectionReservation = {
		policyVersion: "project_fwer_online_bonferroni_v1",
		familyId: "f".repeat(64),
		reservationId: digestAvoExperimentValue({ bindingDigest, attemptIndex }),
		bindingDigest,
		attemptIndex,
		familywiseAlpha: AVO_EXPERIMENT_FAMILYWISE_ALPHA,
		allocatedAlpha: deriveAvoExperimentAllocatedAlpha(attemptIndex),
		cumulativeAlpha: deriveAvoExperimentCumulativeAlpha(attemptIndex),
		reservedAt: "2026-08-28T00:00:00.000Z",
	};
	return experiment;
}

function marginalTrials(experimentId: string): AvoTrial[] {
	const challengerScores = [6, 5, 3, 2, 2];
	return ["baseline", "challenger"].flatMap((candidateId) =>
		["1", "2", "3", "4", "5"].map((seed, index) => ({
			trialId: `${experimentId}-${candidateId}-${seed}`,
			experimentId,
			candidateId,
			evaluationId: `evaluation-${experimentId}-${candidateId}-${seed}`,
			label: `${candidateId} seed ${seed}`,
			seed,
			conditionId: "suite",
			status: "pass" as const,
			metrics: { score: candidateId === "challenger" ? challengerScores[index]! : 0 },
			evidenceRefs: [`host:test:${candidateId}:${seed}`],
			recordedAt: "2026-08-28T00:00:01.000Z",
		})),
	);
}

describe("AVO project-wide sequential selection", () => {
	test("matches known one-sided Student-t probabilities and spends at most five percent", () => {
		expect(avoStudentTUpperTailProbability(0, 4)).toBe(0.5);
		expect(avoStudentTUpperTailProbability(2.7764451051977987, 4)).toBeCloseTo(0.025, 12);
		expect(avoStudentTUpperTailProbability(-2.7764451051977987, 4)).toBeCloseTo(0.975, 12);
		expect(deriveAvoExperimentAllocatedAlpha(1)).toBe(0.025);
		expect(deriveAvoExperimentAllocatedAlpha(2)).toBeCloseTo(0.008333333333333333, 15);
		expect(deriveAvoExperimentCumulativeAlpha(10_000)).toBeLessThan(AVO_EXPERIMENT_FAMILYWISE_ALPHA);
		expect(deriveAvoExperimentCumulativeAlpha(10_000)).toBeCloseTo(
			Array.from({ length: 10_000 }, (_, index) => deriveAvoExperimentAllocatedAlpha(index + 1)).reduce(
				(sum, alpha) => sum + alpha,
				0,
			),
			14,
		);
	});

	test("retains a marginal challenger once the project allocation becomes stricter", () => {
		const first = confirmationExperiment(1);
		const later = confirmationExperiment(2);
		const firstOutcome = deriveAvoExperimentOutcome(first, marginalTrials(first.experimentId));
		const laterOutcome = deriveAvoExperimentOutcome(later, marginalTrials(later.experimentId));
		expect(firstOutcome).toMatchObject({
			decision: "promote",
			championCandidateId: "challenger",
			selectionEvidence: {
				attemptIndex: 1,
				passed: true,
			},
		});
		expect(firstOutcome.selectionEvidence!.oneSidedPValue).toBeLessThan(0.025);
		expect(firstOutcome.selectionEvidence!.oneSidedPValue).toBeGreaterThan(0.05 / 6);
		expect(laterOutcome).toMatchObject({
			decision: "retain",
			championCandidateId: "baseline",
			selectionEvidence: {
				attemptIndex: 2,
				passed: false,
			},
		});
	});

	test("keeps deterministic 100-generation null false-promotion families near the prespecified budget", () => {
		const uniform = seededUniform(0xa70f2026);
		const familyCount = 2_000;
		const attemptsPerFamily = 100;
		const observationsPerAttempt = 10;
		let sequentialFalsePromotionFamilies = 0;
		let repeatedFixed95FalsePromotionFamilies = 0;
		for (let family = 0; family < familyCount; family++) {
			let sequentialPromoted = false;
			let repeatedFixed95Promoted = false;
			for (let attempt = 1; attempt <= attemptsPerFamily; attempt++) {
				const values = Array.from({ length: observationsPerAttempt }, () => standardNormal(uniform));
				const pValue = oneSidedMeanPValue(values);
				if (pValue <= deriveAvoExperimentAllocatedAlpha(attempt)) sequentialPromoted = true;
				if (pValue <= 0.025) repeatedFixed95Promoted = true;
			}
			if (sequentialPromoted) sequentialFalsePromotionFamilies += 1;
			if (repeatedFixed95Promoted) repeatedFixed95FalsePromotionFamilies += 1;
		}
		const sequentialRate = sequentialFalsePromotionFamilies / familyCount;
		const repeatedFixed95Rate = repeatedFixed95FalsePromotionFamilies / familyCount;
		expect(sequentialRate).toBeLessThan(0.075);
		expect(repeatedFixed95Rate).toBeGreaterThan(0.85);
	});
});
