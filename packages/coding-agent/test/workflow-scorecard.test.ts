import { describe, expect, it } from "vitest";
import type {
	WorkflowArtifactRef,
	WorkflowGoalContract,
	WorkflowMetricEvaluationContext,
	WorkflowMetricRunRecord,
	WorkflowScorecard,
	WorkflowScorecardMetric,
	WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	evaluateWorkflowMetric,
	sha256Hex,
	workflowMetricRunBindingDigest,
} from "../src/core/workflow/contracts.js";
import type { WorkflowScorecardValidationContext } from "../src/core/workflow/scorecard.js";
import { validateWorkflowScorecard } from "../src/core/workflow/scorecard.js";

function artifactRef(id: string, sourceEventSequence = 1): WorkflowArtifactRef {
	return {
		artifactId: id,
		relativePath: `evidence/${id}`,
		digest: `${id}-digest`,
		sizeBytes: 1,
		sourceEventSequence,
	};
}

function createGoalContract(): WorkflowGoalContract {
	const withoutDigest: Omit<WorkflowGoalContract, "contractDigest"> = {
		goalId: "goal-1",
		revision: 1,
		originalObjective: "ship the verified result",
		requirements: [
			{
				requirementId: "requirement-1",
				outcome: "the result is observable",
				acceptanceCheckIds: ["check-1"],
				requiredEvidenceKinds: ["integration"],
				adversarialTestArtifactRefs: [artifactRef("goal-attack")],
			},
		],
		constraints: [],
		nonGoals: [],
		authorityCapabilities: ["read_workspace"],
	};
	return { ...withoutDigest, contractDigest: digestObject(withoutDigest) };
}

function createScorecardValidationContext(): WorkflowScorecardValidationContext {
	const bytes = canonicalJsonBytes({ closure: "current-approved" });
	const ref: WorkflowArtifactRef = {
		artifactId: "approved-closure",
		relativePath: "evidence/approved-closure",
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: 1,
	};
	return {
		currentApprovedClosureDigest: ref.digest,
		currentApprovedClosureRef: ref,
		approvedClosureResolver: {
			resolve: async (resolvedRef) => ({
				envelope: { ref: resolvedRef, payloadKind: "evidence", codec: "canonical_json", immutable: true },
				exists: true,
				bytes,
				verifiedDigest: sha256Hex(bytes),
				verifiedSizeBytes: bytes.byteLength,
			}),
		},
	};
}

function createScorecard(overrides: Partial<Omit<WorkflowScorecard, "scorecardDigest">> = {}): WorkflowScorecard {
	const withoutDigest: Omit<WorkflowScorecard, "scorecardDigest"> = {
		scorecardId: "scorecard-1",
		revision: 1,
		metrics: [
			{
				metricId: "metric-1",
				requirementId: "requirement-1",
				direction: "maximize",
				baseline: 0,
				target: 1,
				tolerance: 0,
				parserDigest: "parser-1",
				measurementCommandDigest: "command-1",
				evaluatorDigest: "evaluator-1",
				repeatability: { kind: "repeated", runs: 2, aggregation: "mean", maxVariance: 0 },
			},
		],
		acceptanceChecks: [
			{
				checkId: "check-1",
				description: "independent integration evidence",
				evaluatorDigest: "evaluator-1",
				requiredEvidenceKinds: ["integration"],
				freshnessMilliseconds: 60_000,
				reproducibilityDigest: "reproducible-1",
			},
		],
		protectedInvariants: [
			{
				invariantId: "invariant-1",
				description: "the protected behavior remains intact",
				evaluatorDigest: "evaluator-1",
				falsificationArtifactRefs: [artifactRef("invariant-attack")],
			},
		],
		guardMetricIds: [],
		resourceConstraintDigest: "resources-1",
		proxyAttackArtifactRefs: [artifactRef("proxy-attack")],
		evidenceRuleDigest: "evidence-1",
		...overrides,
	};
	return { ...withoutDigest, scorecardDigest: digestObject(withoutDigest) };
}

function validateScorecard(
	scorecard: WorkflowScorecard,
	goal: WorkflowGoalContract = createGoalContract(),
	context: WorkflowScorecardValidationContext = createScorecardValidationContext(),
) {
	return validateWorkflowScorecard(scorecard, goal, context);
}

const currentMetricEvaluationContext: WorkflowMetricEvaluationContext = {
	currentWorkflowId: "wf-1",
	currentApprovedClosureDigest: "closure",
	currentScorecardDigest: "scorecard",
};

describe("workflow scorecard validation", () => {
	it("accepts a complete scorecard and keeps approval mandatory", async () => {
		const scorecard = createScorecard();
		const result = await validateScorecard(scorecard);

		expect(result.scorecard).toEqual(scorecard);
		expect(result.scorecardDigest).toBe(scorecard.scorecardDigest);
		expect(result.requiresUserApproval).toBe(true);
	});

	it.each([
		["acceptance check", { acceptanceChecks: [] }],
		["protected invariant", { protectedInvariants: [] }],
		["proxy attack evidence", { proxyAttackArtifactRefs: [] }],
		[
			"invariant falsification evidence",
			{ protectedInvariants: [{ ...createScorecard().protectedInvariants[0]!, falsificationArtifactRefs: [] }] },
		],
	])("rejects a scorecard without %s", async (_name, overrides) => {
		await expect(validateScorecard(createScorecard(overrides))).rejects.toThrow(
			/acceptance|invariant|proxy|attack|falsif/i,
		);
	});

	it("rejects a scorecard that leaves a hardened requirement or evidence kind unbound", async () => {
		const missingCheck = createScorecard({
			acceptanceChecks: [{ ...createScorecard().acceptanceChecks[0]!, checkId: "other-check" }],
		});
		await expect(validateScorecard(missingCheck)).rejects.toThrow(/acceptance/i);

		const missingEvidenceKind = createGoalContract();
		const requirement = missingEvidenceKind.requirements[0]!;
		const goalContent = {
			...missingEvidenceKind,
			requirements: [{ ...requirement, requiredEvidenceKinds: [""] }],
		};
		const { contractDigest: _contractDigest, ...withoutDigest } = goalContent;
		const goal: WorkflowGoalContract = { ...withoutDigest, contractDigest: digestObject(withoutDigest) };
		await expect(validateScorecard(createScorecard(), goal)).rejects.toThrow(/evidence|incomplete/i);
	});

	it.each([
		["duplicate metric ids", { metrics: [createScorecard().metrics[0]!, createScorecard().metrics[0]!] }],
		["missing parser digest", { metrics: [{ ...createScorecard().metrics[0]!, parserDigest: "" }] }],
		["negative target", { metrics: [{ ...createScorecard().metrics[0]!, target: -1 }] }],
		["negative tolerance", { metrics: [{ ...createScorecard().metrics[0]!, tolerance: -1 }] }],
		["unknown guard metric", { guardMetricIds: ["unknown-metric"] }],
	])("rejects %s before progress can be authorized", async (_name, overrides) => {
		await expect(validateScorecard(createScorecard(overrides))).rejects.toThrow(/metric|guard|target|tolerance/i);
	});

	it("requires a zero-variance determinism attestation for a single run", async () => {
		const metric = createScorecard().metrics[0]!;
		const single = createScorecard({
			metrics: [
				{
					...metric,
					repeatability: {
						kind: "single",
						hostDeterminismAttestationRef: artifactRef("determinism"),
						deterministicInputClosureDigest: "closure-1",
						allowedVariance: 0,
					},
				},
			],
		});
		expect((await validateScorecard(single)).scorecardDigest).toBe(single.scorecardDigest);

		const missingAttestation = createScorecard({
			metrics: [
				{
					...metric,
					repeatability: {
						kind: "single",
						hostDeterminismAttestationRef: artifactRef(""),
						deterministicInputClosureDigest: "closure-1",
						allowedVariance: 0,
					},
				},
			],
		});
		await expect(validateScorecard(missingAttestation)).rejects.toThrow(/determinism|variance/i);
	});

	it.each([
		["too few runs", { kind: "repeated", runs: 1, aggregation: "mean", maxVariance: 0 }],
		["negative variance", { kind: "repeated", runs: 2, aggregation: "mean", maxVariance: -1 }],
		[
			"missing held-out input",
			{ kind: "held_out", runs: 2, heldOutInputDigest: "", aggregation: "median", maxVariance: 0 },
		],
	] as const)("rejects %s repeatability policies", async (_name, repeatability) => {
		const metric = createScorecard().metrics[0]!;
		const scorecard = createScorecard({ metrics: [{ ...metric, repeatability }] });
		await expect(validateScorecard(scorecard)).rejects.toThrow(/repeat|variance|held.?out/i);
	});

	it("rejects a changed self-digest rather than trusting a caller-authored metric binding", async () => {
		const scorecard = createScorecard();
		await expect(validateScorecard({ ...scorecard, scorecardDigest: "changed" })).rejects.toThrow(/digest/i);
	});

	it("rejects a changed goal-contract digest", async () => {
		const goal = createGoalContract();
		await expect(validateScorecard(createScorecard(), { ...goal, contractDigest: "changed" })).rejects.toThrow(
			/contract|digest/i,
		);
	});

	it("rejects a goal contract without an authority capability", async () => {
		const goal = createGoalContract();
		const withoutAuthority = { ...goal, authorityCapabilities: [] };
		const { contractDigest: _contractDigest, ...goalContent } = withoutAuthority;
		const unauthorizedGoal: WorkflowGoalContract = {
			...goalContent,
			contractDigest: digestObject(goalContent),
		};

		await expect(validateScorecard(createScorecard(), unauthorizedGoal)).rejects.toThrow(/authorit/i);
	});

	it("rejects a scorecard that narrows the evidence required by a goal requirement", async () => {
		const scorecard = createScorecard({
			acceptanceChecks: [{ ...createScorecard().acceptanceChecks[0]!, requiredEvidenceKinds: ["unit"] }],
		});

		await expect(validateScorecard(scorecard)).rejects.toThrow(/evidence/i);
	});

	it("rejects a metric that is unrelated to every hardened requirement", async () => {
		const metric = createScorecard().metrics[0]!;
		const unrelated = createScorecard({ metrics: [{ ...metric, requirementId: "unrelated-requirement" }] });

		await expect(validateScorecard(unrelated)).rejects.toThrow(/requirement|metric/i);
	});

	it("rejects stale approved-closure evidence from the scorecard resolver", async () => {
		const context = createScorecardValidationContext();
		const staleBytes = canonicalJsonBytes({ closure: "stale" });
		const staleContext: WorkflowScorecardValidationContext = {
			...context,
			approvedClosureResolver: {
				resolve: async (resolvedRef) => ({
					envelope: { ref: resolvedRef, payloadKind: "evidence", codec: "canonical_json", immutable: true },
					exists: true,
					bytes: staleBytes,
					verifiedDigest: sha256Hex(staleBytes),
					verifiedSizeBytes: staleBytes.byteLength,
				}),
			},
		};

		await expect(validateScorecard(createScorecard(), createGoalContract(), staleContext)).rejects.toThrow(
			/stale|resolver/i,
		);
	});
});

function metricRun(
	metric: WorkflowScorecardMetric,
	runIndex: number,
	observedValue: number,
	inputPartition: "declared" | "held_out" = "declared",
	inputDigest = "declared-input",
	approvedClosureDigest = "closure",
	workflowId = "wf-1",
	scorecardDigest = "scorecard",
	trustedClockReceiptKind: "clock" | "usage" = "clock",
): WorkflowMetricRunRecord {
	const evidenceWithoutDigest = {
		artifactId: `run-${runIndex}`,
		relativePath: `evidence/run-${runIndex}`,
		sourceEventSequence: runIndex,
		payloadDigest: "fixture",
	};
	const evidenceBytes = canonicalJsonBytes(evidenceWithoutDigest);
	const evidenceRef: WorkflowArtifactRef = {
		artifactId: evidenceWithoutDigest.artifactId,
		relativePath: evidenceWithoutDigest.relativePath,
		digest: sha256Hex(evidenceBytes),
		sizeBytes: evidenceBytes.byteLength,
		sourceEventSequence: runIndex,
	};
	const evidenceRefs = [evidenceRef];
	const run = {
		workflowId,
		evaluationId: "evaluation-1",
		hostExecutionId: `host-execution-${runIndex}`,
		metricId: metric.metricId,
		runIndex,
		inputPartition,
		inputDigest,
		approvedClosureDigest,
		scorecardDigest,
		baselineDigest: digestObject(metric.baseline),
		evidenceRef,
		determinismEvidenceRefs: evidenceRefs,
		falsificationEvidenceRefs: evidenceRefs,
		attackEvidenceRefs: evidenceRefs,
		guardEvidenceRefs: evidenceRefs,
		observedValue,
		measurementCommandDigest: metric.measurementCommandDigest,
		parserDigest: metric.parserDigest,
		evaluatorDigest: metric.evaluatorDigest,
	};
	const bindingDigest = workflowMetricRunBindingDigest(run, metric);
	const hostReceipt: WorkflowVerifiedHostReceipt = createFixtureHostReceipt({
		receiptKind: "usage",
		receiptId: `metric-run-${runIndex}`,
		issuerId: "metric-host",
		workflowId: run.workflowId,
		bindingDigest,
		payloadDigest: `metric-payload-${runIndex}`,
		artifactRef: evidenceRef,
		issuedAt: "2026-08-13T00:00:00.000Z",
		validUntil: "2026-08-13T00:05:00.000Z",
		keyId: "metric-key",
		signature: "metric-signature",
	});
	const trustedClockReceipt: WorkflowVerifiedHostReceipt = createFixtureHostReceipt({
		receiptKind: trustedClockReceiptKind,
		receiptId: `metric-clock-${runIndex}`,
		issuerId: "metric-clock",
		workflowId: run.workflowId,
		bindingDigest: digestObject({ runBindingDigest: bindingDigest, trustedNow: "2026-08-13T00:01:00.000Z" }),
		payloadDigest: `metric-clock-payload-${runIndex}`,
		artifactRef: evidenceRef,
		issuedAt: "2026-08-13T00:00:00.000Z",
		validUntil: "2026-08-13T00:05:00.000Z",
		keyId: "metric-clock-key",
		signature: "metric-clock-signature",
	});
	return {
		...run,
		hostReceipt,
		trustedClockReceipt,
	};
}

describe("workflow metric repeatability", () => {
	it("rejects a trusted receipt that is not a clock receipt", async () => {
		const metric = createScorecard().metrics[0]!;
		const result = await evaluateWorkflowMetric(
			metric,
			[
				metricRun(metric, 1, 1, "declared", "declared-input", "closure", "wf-1", "scorecard", "usage"),
				metricRun(metric, 2, 1),
			],
			createFixtureHostReceiptConsumerContext(),
			"fixture-state",
			1,
			"2026-08-13T00:01:00.000Z",
			currentMetricEvaluationContext,
		);

		expect(result.accepted).toBe(false);
		expect(result.rejectionReasons).toContain("evidence_missing");
	});

	it("rejects repeated runs with changed input partition or digest", async () => {
		const metric = createScorecard().metrics[0]!;
		const inputVariants = [
			[metricRun(metric, 1, 1, "declared", "input-a"), metricRun(metric, 2, 1, "held_out", "input-a")],
			[metricRun(metric, 1, 1, "declared", "input-a"), metricRun(metric, 2, 1, "declared", "input-b")],
		] as const;

		for (const runs of inputVariants) {
			const result = await evaluateWorkflowMetric(
				metric,
				runs,
				createFixtureHostReceiptConsumerContext(),
				"fixture-state",
				1,
				"2026-08-13T00:01:00.000Z",
				currentMetricEvaluationContext,
			);

			expect(result.accepted).toBe(false);
			expect(result.rejectionReasons).toContain("digest_mismatch");
		}
	});

	it("rejects lucky runs, missing repetitions, variance excess, and held-out substitution", async () => {
		const receiptContext = createFixtureHostReceiptConsumerContext();
		const metric = createScorecard().metrics[0]!;
		const repeated: WorkflowScorecardMetric = {
			...metric,
			target: 50,
			repeatability: { kind: "repeated", runs: 3, aggregation: "mean", maxVariance: 1 },
		};
		const lucky = await evaluateWorkflowMetric(
			repeated,
			[metricRun(repeated, 1, 100), metricRun(repeated, 2, 0), metricRun(repeated, 3, 0)],
			receiptContext,
			"fixture-state",
			1,
			"2026-08-13T00:01:00.000Z",
			currentMetricEvaluationContext,
		);
		expect(lucky.accepted).toBe(false);
		expect(lucky.rejectionReasons).toContain("variance_exceeded");

		const missing = await evaluateWorkflowMetric(
			repeated,
			[metricRun(repeated, 1, 100)],
			receiptContext,
			"fixture-state",
			1,
			"2026-08-13T00:01:00.000Z",
			currentMetricEvaluationContext,
		);
		expect(missing.rejectionReasons).toContain("missing_run");

		const heldOut: WorkflowScorecardMetric = {
			...metric,
			repeatability: {
				kind: "held_out",
				runs: 2,
				heldOutInputDigest: "held-out-input",
				aggregation: "median",
				maxVariance: 0,
			},
		};
		const substituted = await evaluateWorkflowMetric(
			heldOut,
			[metricRun(heldOut, 1, 1), metricRun(heldOut, 2, 1)],
			receiptContext,
			"fixture-state",
			1,
			"2026-08-13T00:01:00.000Z",
			currentMetricEvaluationContext,
		);
		expect(substituted.accepted).toBe(false);
		expect(substituted.rejectionReasons).toContain("held_out_mismatch");
	});

	it("rejects observed-value and measurement-input substitution", async () => {
		const receiptContext = createFixtureHostReceiptConsumerContext();
		const metric: WorkflowScorecardMetric = {
			...createScorecard().metrics[0]!,
			target: 1,
			tolerance: 10,
			repeatability: { kind: "repeated", runs: 2, aggregation: "mean", maxVariance: 100 },
		};
		const runs = [metricRun(metric, 1, 1), metricRun(metric, 2, 1)];
		const accepted = await evaluateWorkflowMetric(
			metric,
			runs,
			receiptContext,
			"fixture-state",
			1,
			"2026-08-13T00:01:00.000Z",
			currentMetricEvaluationContext,
		);
		expect(accepted.accepted).toBe(true);

		await expect(
			evaluateWorkflowMetric(
				metric,
				[{ ...runs[0]!, observedValue: 2, inputPartition: "held_out", inputDigest: "substituted-input" }, runs[1]!],
				receiptContext,
				"fixture-state",
				1,
				"2026-08-13T00:01:00.000Z",
				currentMetricEvaluationContext,
			),
		).rejects.toThrow(/receipt|binding|cryptographically|trusted/i);
	});

	it("rejects internally consistent foreign workflow, closure, and scorecard bindings", async () => {
		const metric = createScorecard().metrics[0]!;
		const cases = [
			["workflow", "closure", "scorecard", "foreign-workflow"],
			["closure", "foreign-closure", "scorecard", "wf-1"],
			["scorecard", "closure", "foreign-scorecard", "wf-1"],
		] as const;

		for (const [label, closureDigest, scorecardDigest, workflowId] of cases) {
			const receiptContext = createFixtureHostReceiptConsumerContext();
			await expect(
				evaluateWorkflowMetric(
					metric,
					[
						metricRun(metric, 1, 1, "declared", "declared-input", closureDigest, workflowId, scorecardDigest),
						metricRun(metric, 2, 1, "declared", "declared-input", closureDigest, workflowId, scorecardDigest),
					],
					receiptContext,
					"fixture-state",
					1,
					"2026-08-13T00:01:00.000Z",
					currentMetricEvaluationContext,
				),
			).rejects.toThrow(new RegExp(label));
		}
	});
});
