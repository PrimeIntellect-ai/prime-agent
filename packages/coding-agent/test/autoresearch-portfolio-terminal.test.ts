import { describe, expect, it } from "vitest";
import {
	type AutoResearchPortfolioContract,
	type AutoResearchPortfolioMeasurement,
	type AutoResearchPortfolioSplitClosureRoots,
	parseAutoResearchPortfolioContract,
} from "../src/core/autoresearch/portfolio-contracts.js";
import {
	evaluatePortfolioTerminal,
	type PortfolioHostAcquisitionEvidence,
	type PortfolioHostArtifactEvidence,
	type PortfolioHostBoundaryEvidence,
	type PortfolioHostCompletionEvidence,
	type PortfolioHostFrontierEvidence,
	type PortfolioHostGoalDecisionEvidence,
	type PortfolioHostInfeasibilityEvidence,
	type PortfolioHostMeasurementEvidence,
	type PortfolioHostTradeoffEvidence,
	type PortfolioTerminalCapabilityRole,
	type PortfolioTerminalEvaluation,
	type PortfolioTerminalInput,
	portfolioAcquisitionBindingDigest,
	portfolioBoundaryBindingDigest,
	portfolioCompletionBindingDigest,
	portfolioDefaultCompletionOperationDigest,
	portfolioDefaultCompletionResourceDigest,
	portfolioFrontierBindingDigest,
	portfolioGoalDecisionBindingDigest,
	portfolioInfeasibilityAdjudicationBindingDigest,
	portfolioInfeasibilityProofBindingDigest,
	portfolioMeasurementBindingDigest,
	portfolioStopBindingDigest,
	portfolioTradeoffBindingDigest,
} from "../src/core/autoresearch/portfolio-terminal.js";
import {
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	type WorkflowArtifactRef,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";

const DIGEST = "a".repeat(64);
const PORTFOLIO_ROOT = "b".repeat(64);
const TRAINING_ROOT = "c".repeat(64);
const VALIDATION_ROOT = "d".repeat(64);
const HOLDOUT_ROOT = "e".repeat(64);
const MANIFEST = "f".repeat(64);
const VERIFICATION = "9".repeat(64);
const WORKFLOW_ID = "workflow-portfolio";
const STATE_DIGEST = "state-portfolio";
const REVISION = 7;
const TRUSTED_NOW = "2026-08-17T12:00:00.000Z";

function splitRoots(): AutoResearchPortfolioSplitClosureRoots {
	return { training: TRAINING_ROOT, validation: VALIDATION_ROOT, holdout: HOLDOUT_ROOT };
}

function datasetArtifact(
	split: "training" | "validation" | "holdout",
	start: string,
	end: string,
	authority: "training_workers_training_only" | "validation_evaluator_host_only" | "holdout_host_aggregate_only",
): Record<string, unknown> {
	return {
		split,
		objectUri: `gs://portfolio-${split}/manifest.json`,
		generation: split === "training" ? 11 : split === "validation" ? 12 : 13,
		sha256: DIGEST,
		bytes: 128,
		schemaVersion: "observations-v1",
		modality: "time_series",
		instrumentSet: ["EUR_USD"],
		sourceTimeStart: start,
		sourceTimeEnd: end,
		validationResult: "passed",
		coverage: "complete",
		gapClassification: "none",
		lifecycle: "sealed",
		restoreVerification: {
			locked: true,
			independentlyRestored: true,
			independentlyRehashed: true,
			verificationEvidenceDigest: VERIFICATION,
		},
		provenance: {
			sourceSystem: "fixture-source",
			sourceDataset: `dataset-${split}`,
			ingestDigest: DIGEST,
			lineageDigest: DIGEST,
			provenanceReceiptDigest: DIGEST,
		},
		closureRootDigest: split === "training" ? TRAINING_ROOT : split === "validation" ? VALIDATION_ROOT : HOLDOUT_ROOT,
		accessAuthority: authority,
	};
}

function digestWithoutField(value: Record<string, unknown>, field: string): string {
	const payload = { ...value };
	delete payload[field];
	return digestObject(payload);
}

function manifestDigestFor(manifest: Record<string, unknown>): string {
	const canonicalManifest: Record<string, unknown> = {
		...manifest,
		training: {
			...(manifest.training as Record<string, unknown>),
			artifacts: [
				...((manifest.training as Record<string, unknown>).artifacts as Array<Record<string, unknown>>),
			].sort((left, right) => String(left.objectUri).localeCompare(String(right.objectUri))),
		},
		validation: {
			...(manifest.validation as Record<string, unknown>),
			artifacts: [
				...((manifest.validation as Record<string, unknown>).artifacts as Array<Record<string, unknown>>),
			].sort((left, right) => String(left.objectUri).localeCompare(String(right.objectUri))),
		},
		holdout: {
			...(manifest.holdout as Record<string, unknown>),
			artifacts: [
				...((manifest.holdout as Record<string, unknown>).artifacts as Array<Record<string, unknown>>),
			].sort((left, right) => String(left.objectUri).localeCompare(String(right.objectUri))),
		},
	};
	return digestWithoutField(canonicalManifest, "manifestDigest");
}

function inputManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const splitBoundaryPolicy: Record<string, unknown> = {
		locked: true,
		trainingEndExclusive: "2025-01-01T00:00:00.000Z",
		validationStartInclusive: "2025-01-01T00:00:00.000Z",
		validationEndExclusive: "2026-01-01T00:00:00.000Z",
		holdoutStartInclusive: "2026-01-01T00:00:00.000Z",
		holdoutEndExclusive: "2027-01-01T00:00:00.000Z",
		policyDigest: "",
	};
	splitBoundaryPolicy.policyDigest = digestWithoutField(splitBoundaryPolicy, "policyDigest");
	const manifest: Record<string, unknown> = {
		locked: true,
		evaluationEpoch: 1,
		manifestRevision: 1,
		closureRootDigest: PORTFOLIO_ROOT,
		manifestDigest: "",
		splitClosureRoots: splitRoots(),
		splitBoundaryPolicy,
		training: {
			locked: true,
			split: "training",
			closureRootDigest: TRAINING_ROOT,
			artifacts: [
				datasetArtifact(
					"training",
					"2024-01-01T00:00:00.000Z",
					"2025-01-01T00:00:00.000Z",
					"training_workers_training_only",
				),
			],
		},
		validation: {
			locked: true,
			split: "validation",
			closureRootDigest: VALIDATION_ROOT,
			artifacts: [
				datasetArtifact(
					"validation",
					"2025-01-01T00:00:00.000Z",
					"2026-01-01T00:00:00.000Z",
					"validation_evaluator_host_only",
				),
			],
		},
		holdout: {
			locked: true,
			split: "holdout",
			closureRootDigest: HOLDOUT_ROOT,
			artifacts: [
				datasetArtifact(
					"holdout",
					"2026-01-01T00:00:00.000Z",
					"2027-01-01T00:00:00.000Z",
					"holdout_host_aggregate_only",
				),
			],
		},
		modelAccess: {
			training: "training_workers_training_only",
			validation: "validation_evaluator_host_only",
			holdout: "holdout_host_aggregate_only",
			holdoutRowsVisible: false,
			holdoutPerCaseFeedback: false,
			holdoutReturns: "aggregate_signed_evidence_only",
			signedAggregateEvidence: true,
		},
		...overrides,
	};
	manifest.manifestDigest = manifestDigestFor(manifest);
	return manifest;
}

function metric(metricId: string, requirementId = "requirement-quality"): Record<string, unknown> {
	return {
		metricId,
		name: metricId,
		requirementId,
		direction: "higher",
		target: 0.8,
		unit: "ratio",
		locked: true,
		evaluationEpoch: 1,
		metricRevision: 1,
		closureRootDigest: PORTFOLIO_ROOT,
		inputManifestDigest: MANIFEST,
		splitClosureRoots: splitRoots(),
	};
}

function goal(
	goalId = "goal-quality",
	metricId = "quality",
	requirementId = "requirement-quality",
): Record<string, unknown> {
	return {
		goalId,
		domainId: "domain-quality",
		title: goalId,
		description: `Improve the ${metricId} metric.`,
		scope: "terminal",
		metrics: [metric(metricId, requirementId)],
		baseline: {
			locked: true,
			measurementId: `measurement-baseline-${goalId}`,
			metricValues: [{ metricId, value: 0.5 }],
			evidenceDigest: DIGEST,
			evaluationEpoch: 1,
			closureRootDigest: PORTFOLIO_ROOT,
			inputManifestDigest: MANIFEST,
			splitClosureRoots: splitRoots(),
		},
		evaluator: {
			locked: true,
			evaluatorId: `evaluator-${goalId}`,
			sourceDigest: DIGEST,
			inputDigest: DIGEST,
			environmentDigest: DIGEST,
			evaluatorDigest: DIGEST,
			evaluationEpoch: 1,
			evaluatorRevision: 1,
			closureRootDigest: PORTFOLIO_ROOT,
			inputManifestDigest: MANIFEST,
			splitClosureRoots: splitRoots(),
		},
		parser: {
			locked: true,
			parserId: `parser-${goalId}`,
			kind: "json_object",
			metricKeys: [metricId],
			parserDigest: DIGEST,
			evaluationEpoch: 1,
			inputManifestRevision: 1,
			closureRootDigest: PORTFOLIO_ROOT,
			inputManifestDigest: MANIFEST,
			splitClosureRoots: splitRoots(),
		},
		command: {
			locked: true,
			argv: ["node", "evaluate.mjs"],
			shell: false,
			cwd: "isolated_candidate",
			commandDigest: DIGEST,
		},
		repeatability: { locked: true, runs: 3, aggregation: "median", seed: "seed-1", maxVariance: 0.01 },
		uncertainty: { locked: true, method: "bootstrap", confidence: 0.95, maxWidth: 0.2, maxVariance: 0.01 },
		opaqueHoldout: {
			locked: true,
			policy: "host_only",
			candidateVisible: false,
			handleDigest: DIGEST,
			inputDigest: DIGEST,
			resolverDigest: DIGEST,
			evaluationEpoch: 1,
			closureRootDigest: PORTFOLIO_ROOT,
			splitClosureRoots: splitRoots(),
		},
		falsification: { locked: true, criteria: [`${metricId} fails`], manifestDigest: DIGEST },
		adversarial: { locked: true, checks: ["metric omission"], manifestDigest: DIGEST },
	};
}

function measurement(
	value: number,
	measurementId = "measurement-candidate",
	metricEntries: readonly { metricId: string; value: number }[] = [{ metricId: "quality", value }],
	goalId = "goal-quality",
): AutoResearchPortfolioMeasurement {
	return {
		measurementId,
		goalId,
		candidateId: measurementId.startsWith("measurement-baseline") ? null : "candidate-1",
		scope: "terminal",
		kind: measurementId.startsWith("measurement-baseline") ? "baseline" : "candidate",
		vector: metricEntries,
		repeatIndex: 1,
		sampleCount: 3,
		inputDigest: MANIFEST,
		inputManifestDigest: MANIFEST,
		evaluatorDigest: DIGEST,
		parserDigest: DIGEST,
		commandDigest: DIGEST,
		workspaceDigest: DIGEST,
		evidenceDigests: [DIGEST],
		measuredAt: TRUSTED_NOW,
		measurementDigest: DIGEST,
		evaluationEpoch: 1,
		splitClosureRoots: splitRoots(),
		confidenceInterval: { lower: 0.8, upper: 1, level: 0.95 },
		variance: 0.01,
		runCount: 3,
		aggregation: "median",
	};
}

function acceptanceRequirement(requirementId: string, statement: string): Record<string, unknown> {
	const value: Record<string, unknown> = { requirementId, statement, locked: true, requirementDigest: "" };
	value.requirementDigest = digestWithoutField(value, "requirementDigest");
	return value;
}

function refreshGoalBindings(goals: readonly Record<string, unknown>[], manifest: Record<string, unknown>): void {
	const manifestDigest = String(manifest.manifestDigest);
	for (const goalRecord of goals) {
		for (const metricRecord of goalRecord.metrics as Array<Record<string, unknown>>) {
			metricRecord.inputManifestDigest = manifestDigest;
		}
		for (const key of ["baseline", "evaluator", "parser"] as const) {
			(goalRecord[key] as Record<string, unknown>).inputManifestDigest = manifestDigest;
		}
		const evaluator = goalRecord.evaluator as Record<string, unknown>;
		evaluator.evaluatorDigest = digestWithoutField(evaluator, "evaluatorDigest");
		const parser = goalRecord.parser as Record<string, unknown>;
		parser.parserDigest = digestWithoutField(parser, "parserDigest");
		const command = goalRecord.command as Record<string, unknown>;
		command.commandDigest = digestWithoutField(command, "commandDigest");
		const falsification = goalRecord.falsification as Record<string, unknown>;
		falsification.manifestDigest = digestWithoutField(falsification, "manifestDigest");
		const adversarial = goalRecord.adversarial as Record<string, unknown>;
		adversarial.manifestDigest = digestWithoutField(adversarial, "manifestDigest");
	}
}

function contract(includeUnresolvedGoal = false, includeConflictRelation = false): AutoResearchPortfolioContract {
	const goals = includeUnresolvedGoal ? [goal(), goal("goal-safety", "safety", "requirement-safety")] : [goal()];
	const manifest = inputManifest();
	const acceptanceRequirements = [
		acceptanceRequirement("requirement-quality", "Quality meets the locked target."),
		...(includeUnresolvedGoal
			? [acceptanceRequirement("requirement-safety", "Safety meets the locked target.")]
			: []),
	];
	refreshGoalBindings(goals, manifest);
	return parseAutoResearchPortfolioContract({
		schemaVersion: 3,
		contractId: "portfolio-1",
		objective: "Improve quality under fixed host boundaries.",
		acceptanceRequirements,
		goals,
		goalRelations:
			includeUnresolvedGoal && includeConflictRelation
				? [
						{
							fromGoalId: "goal-quality",
							toGoalId: "goal-safety",
							relation: "conflict",
							rationale: "The locked frontier cannot satisfy both terminal requirements at once.",
						},
					]
				: [],
		lexicographicTiers: includeUnresolvedGoal
			? [
					{ tier: 1, goalIds: ["goal-quality"] },
					{ tier: 2, goalIds: ["goal-safety"] },
				]
			: [{ tier: 1, goalIds: ["goal-quality"] }],
		hardBoundaries: [
			{ boundaryId: "boundary-safety", statement: "No unsafe effects.", scope: "terminal", locked: true },
		],
		invariants: [
			{
				invariantId: "invariant-safety",
				statement: "The sealed evaluator is unchanged.",
				scope: "terminal",
				locked: true,
				checkDigest: DIGEST,
			},
		],
		nonGoals: [],
		budgets: {
			maxCandidates: 12,
			maxMeasurements: 96,
			maxWallSeconds: 3600,
			maxCostMicrounits: 100000,
			maxParallelCandidates: 2,
			maxTokens: 50000,
		},
		safety: {
			locked: true,
			network: "disabled",
			externalEffects: "none",
			requireOpaqueHoldout: true,
			requireAdversarialReview: true,
			maxUncertainty: 0.2,
		},
		inputManifest: manifest,
		scopePartitions: [
			{
				partitionId: "terminal-code",
				scope: "terminal",
				paths: ["src/"],
				dataDigests: [DIGEST],
				mutableBy: "candidate",
			},
		],
		terminalScope: "terminal",
		learningScope: "learning",
	});
}

function artifactRef(id: string): WorkflowArtifactRef {
	return { artifactId: id, relativePath: `evidence/${id}.json`, digest: DIGEST, sizeBytes: 0, sourceEventSequence: 1 };
}

type FixtureReceiptInput = Pick<
	WorkflowVerifiedHostReceipt,
	"receiptKind" | "receiptId" | "issuerId" | "payloadDigest" | "bindingDigest"
> &
	Partial<Pick<WorkflowVerifiedHostReceipt, "oneUse" | "keyId" | "capabilityBinding">>;

function receipt(
	context: ReturnType<typeof createFixtureHostReceiptConsumerContext>,
	input: FixtureReceiptInput,
): WorkflowVerifiedHostReceipt {
	void context;
	return createFixtureHostReceipt({
		...input,
		issuerId: input.issuerId === "worker" ? input.issuerId : "fixture-host",
		workflowId: WORKFLOW_ID,
		artifactRef: artifactRef(input.receiptId),
		issuedAt: "2026-08-17T00:00:00.000Z",
		validUntil: "2026-08-18T00:00:00.000Z",
		keyId: input.keyId ?? "fixture-key",
		stateDigest: STATE_DIGEST,
		revision: REVISION,
		capabilityBinding: {
			capability: "portfolio_default_completion",
			resourceDigest: input.capabilityBinding?.resourceDigest ?? DIGEST,
			operationDigest: input.capabilityBinding?.operationDigest ?? DIGEST,
			executionIdentity: "completion-fixture-writer",
			sessionId: null,
			...(input.capabilityBinding === undefined ? {} : input.capabilityBinding),
		},
	});
}

function terminalCapabilityBinding(
	input: PortfolioTerminalInput,
	role: PortfolioTerminalCapabilityRole,
	bindingDigest: string,
): NonNullable<WorkflowVerifiedHostReceipt["capabilityBinding"]> {
	const measurements = input.measurements.map((entry) => entry.measurement);
	return {
		capability: "portfolio_default_completion",
		resourceDigest: portfolioDefaultCompletionResourceDigest(input.contract, input, measurements),
		operationDigest: portfolioDefaultCompletionOperationDigest(
			input.contract,
			input,
			measurements,
			role,
			bindingDigest,
		),
		executionIdentity: "completion-fixture-writer",
		sessionId: null,
	};
}

function rebindReceipt(
	input: PortfolioTerminalInput,
	receiptValue: WorkflowVerifiedHostReceipt,
	role: PortfolioTerminalCapabilityRole,
): WorkflowVerifiedHostReceipt {
	return receipt(input.receiptContext, {
		receiptKind: receiptValue.receiptKind,
		receiptId: receiptValue.receiptId,
		issuerId: receiptValue.issuerId,
		payloadDigest: receiptValue.payloadDigest,
		bindingDigest: receiptValue.bindingDigest,
		oneUse: receiptValue.oneUse,
		keyId: receiptValue.keyId,
		capabilityBinding: terminalCapabilityBinding(input, role, receiptValue.bindingDigest),
	});
}

function bindTerminalCapabilities(input: PortfolioTerminalInput): PortfolioTerminalInput {
	const measurements = input.measurements.map((entry) => ({
		...entry,
		receipt: rebindReceipt(input, entry.receipt, "measurement"),
	}));
	return {
		...input,
		measurements,
		frontier: {
			...input.frontier,
			receipt: rebindReceipt(input, input.frontier.receipt, "frontier"),
		},
		boundaries: input.boundaries.map((entry) => ({
			...entry,
			receipt: rebindReceipt(input, entry.receipt, "boundary"),
		})),
		acquisition: {
			splits: input.acquisition.splits.map((entry) => ({
				...entry,
				receipt: rebindReceipt(input, entry.receipt, "acquisition"),
			})),
		},
		completion: {
			...input.completion,
			receipt: rebindReceipt(input, input.completion.receipt, "completion"),
		},
		tradeoff:
			input.tradeoff === null
				? null
				: { ...input.tradeoff, receipt: rebindReceipt(input, input.tradeoff.receipt, "tradeoff") },
		infeasibility: input.infeasibility.map((entry) => ({
			...entry,
			evaluatorProofReceipt: rebindReceipt(input, entry.evaluatorProofReceipt, "infeasibility_evaluator"),
			adjudicationReceipt: rebindReceipt(input, entry.adjudicationReceipt, "infeasibility_adjudicator"),
		})),
		goalDecisions: input.goalDecisions.map((entry) => ({
			...entry,
			receipt: rebindReceipt(input, entry.receipt, "goal_decision"),
		})),
		stop: input.stop === null ? null : { ...input.stop, receipt: rebindReceipt(input, input.stop.receipt, "stop") },
	};
}

function validInput(
	includeUnresolvedGoal = false,
	overrides: Partial<PortfolioTerminalInput> = {},
	includeConflictRelation = false,
): PortfolioTerminalInput {
	const parsedContract = contract(includeUnresolvedGoal, includeConflictRelation);
	const metricEntries: readonly { metricId: string; value: number }[] = parsedContract.goals[0]!.metrics.map(
		(metricEntry) => ({ metricId: metricEntry.metricId, value: 0.9 }),
	);
	const goalRecord = parsedContract.goals[0]!;
	const parsedMeasurementValue = {
		...measurement(0.9, "measurement-candidate", metricEntries),
		inputDigest: parsedContract.inputManifest.manifestDigest,
		inputManifestDigest: parsedContract.inputManifest.manifestDigest,
		evaluationEpoch: parsedContract.inputManifest.evaluationEpoch,
		splitClosureRoots: parsedContract.inputManifest.splitClosureRoots,
		evaluatorDigest: goalRecord.evaluator.evaluatorDigest,
		parserDigest: goalRecord.parser.parserDigest,
		commandDigest: goalRecord.command.commandDigest,
		measurementDigest: "",
	};
	parsedMeasurementValue.measurementDigest = digestWithoutField(parsedMeasurementValue, "measurementDigest");
	const parsedMeasurement: AutoResearchPortfolioMeasurement = parsedMeasurementValue;
	const { revokeReceipt: _revokeReceipt, ...context } = createFixtureHostReceiptConsumerContext();
	const measurementEvidence: PortfolioHostMeasurementEvidence = {
		measurement: parsedMeasurement,
		receipt: receipt(context, {
			receiptKind: "capability",
			receiptId: "receipt-measurement",
			issuerId: "host-evaluator",
			oneUse: true,
			payloadDigest: DIGEST,
			bindingDigest: portfolioMeasurementBindingDigest(parsedContract, parsedMeasurement),
		}),
	};
	const additionalMeasurements: readonly PortfolioHostMeasurementEvidence[] = (
		["holdout", "adversarial"] as const
	).map((kind) => {
		const measurementValue = {
			...parsedMeasurement,
			measurementId: `measurement-${kind}`,
			kind,
			measurementDigest: "",
		};
		measurementValue.measurementDigest = digestWithoutField(measurementValue, "measurementDigest");
		return {
			measurement: measurementValue,
			receipt: receipt(context, {
				receiptKind: "capability",
				receiptId: `receipt-measurement-${kind}`,
				issuerId: "host-evaluator",
				oneUse: true,
				payloadDigest: DIGEST,
				bindingDigest: portfolioMeasurementBindingDigest(parsedContract, measurementValue),
			}),
		};
	});
	const frontierEntries = [
		{
			entryId: "frontier-1",
			candidateId: "candidate-1",
			domainId: "domain-quality",
			goalIds: parsedContract.goals.map((entry) => entry.goalId),
		},
	];
	const frontier: PortfolioHostFrontierEvidence = {
		entries: frontierEntries,
		selectedEntryIds: ["frontier-1"],
		receipt: receipt(context, {
			receiptKind: "capability",
			receiptId: "receipt-frontier",
			issuerId: "host-frontier",
			oneUse: true,
			payloadDigest: DIGEST,
			bindingDigest: portfolioFrontierBindingDigest(parsedContract, frontierEntries, ["frontier-1"]),
		}),
	};
	const boundaries: readonly PortfolioHostBoundaryEvidence[] = [
		{
			boundaryId: "boundary-safety",
			passed: true,
			receipt: receipt(context, {
				receiptKind: "capability",
				receiptId: "receipt-boundary",
				issuerId: "host-safety",
				oneUse: true,
				payloadDigest: DIGEST,
				bindingDigest: portfolioBoundaryBindingDigest(parsedContract, "boundary-safety", true),
			}),
		},
	];
	const acquisition: PortfolioHostAcquisitionEvidence = {
		splits: [
			...(["training", "validation", "holdout"] as const).map((split) => {
				const artifact = parsedContract.inputManifest[split].artifacts[0]!;
				const hostArtifact: PortfolioHostArtifactEvidence = {
					split,
					objectUri: artifact.objectUri,
					generation: artifact.generation,
					sha256: artifact.sha256,
					bytes: artifact.bytes,
					closureRootDigest: artifact.closureRootDigest,
					coverage: artifact.coverage,
					gapClassification: artifact.gapClassification,
					lifecycle: artifact.lifecycle,
					independentlyRestored: artifact.restoreVerification.independentlyRestored,
					independentlyRehashed: artifact.restoreVerification.independentlyRehashed,
					verificationEvidenceDigest: artifact.restoreVerification.verificationEvidenceDigest,
				};
				return {
					split,
					artifacts: [hostArtifact],
					receipt: receipt(context, {
						receiptKind: "capability",
						receiptId: `receipt-${split}`,
						issuerId: "host-acquisition",
						oneUse: true,
						payloadDigest: DIGEST,
						bindingDigest: portfolioAcquisitionBindingDigest(parsedContract, split, [hostArtifact]),
					}),
				};
			}),
		],
	};
	const completion: PortfolioHostCompletionEvidence = {
		manifestGeneration: parsedContract.inputManifest.evaluationEpoch,
		manifestRevision: parsedContract.inputManifest.manifestRevision,
		manifestDigest: parsedContract.inputManifest.manifestDigest,
		closureRootDigest: parsedContract.inputManifest.closureRootDigest,
		artifacts: ["training", "validation", "holdout"].map((split) => {
			const artifact = parsedContract.inputManifest[split as "training" | "validation" | "holdout"].artifacts[0]!;
			return {
				split: artifact.split,
				objectUri: artifact.objectUri,
				generation: artifact.generation,
				sha256: artifact.sha256,
				bytes: artifact.bytes,
				closureRootDigest: artifact.closureRootDigest,
				coverage: artifact.coverage,
				gapClassification: artifact.gapClassification,
				lifecycle: artifact.lifecycle,
				independentlyRestored: artifact.restoreVerification.independentlyRestored,
				independentlyRehashed: artifact.restoreVerification.independentlyRehashed,
				verificationEvidenceDigest: artifact.restoreVerification.verificationEvidenceDigest,
			} satisfies PortfolioHostArtifactEvidence;
		}),
		receipt: receipt(context, {
			receiptKind: "capability",
			receiptId: "receipt-completion",
			issuerId: "host-completion",
			oneUse: true,
			payloadDigest: DIGEST,
			bindingDigest: portfolioCompletionBindingDigest(parsedContract, {
				manifestGeneration: parsedContract.inputManifest.evaluationEpoch,
				manifestRevision: parsedContract.inputManifest.manifestRevision,
				manifestDigest: parsedContract.inputManifest.manifestDigest,
				closureRootDigest: parsedContract.inputManifest.closureRootDigest,
				artifacts: ["training", "validation", "holdout"].map((split) => {
					const artifact =
						parsedContract.inputManifest[split as "training" | "validation" | "holdout"].artifacts[0]!;
					return {
						split: artifact.split,
						objectUri: artifact.objectUri,
						generation: artifact.generation,
						sha256: artifact.sha256,
						bytes: artifact.bytes,
						closureRootDigest: artifact.closureRootDigest,
						coverage: artifact.coverage,
						gapClassification: artifact.gapClassification,
						lifecycle: artifact.lifecycle,
						independentlyRestored: artifact.restoreVerification.independentlyRestored,
						independentlyRehashed: artifact.restoreVerification.independentlyRehashed,
						verificationEvidenceDigest: artifact.restoreVerification.verificationEvidenceDigest,
					} satisfies PortfolioHostArtifactEvidence;
				}),
			}),
		}),
	};
	const baseInput: PortfolioTerminalInput = {
		contract: parsedContract,
		workflowId: WORKFLOW_ID,
		currentStateDigest: STATE_DIGEST,
		currentRevision: REVISION,
		trustedNow: TRUSTED_NOW,
		receiptContext: context,
		measurements: [measurementEvidence, ...additionalMeasurements],
		frontier,
		boundaries,
		acquisition,
		completion,
		tradeoff: null,
		infeasibility: [],
		goalDecisions: [],
		stop: null,
		...overrides,
	};
	return bindTerminalCapabilities(baseInput);
}

async function evaluate(input: PortfolioTerminalInput): Promise<PortfolioTerminalEvaluation> {
	return evaluatePortfolioTerminal(input);
}

function measurementEvidence(
	input: PortfolioTerminalInput,
	measurementValue: AutoResearchPortfolioMeasurement,
	receiptId: string,
	receiptKind: "artifact" | "decision" = "artifact",
): PortfolioHostMeasurementEvidence {
	return {
		measurement: measurementValue,
		receipt: receipt(input.receiptContext, {
			receiptKind,
			receiptId,
			issuerId: "host-evaluator",
			payloadDigest: DIGEST,
			bindingDigest: portfolioMeasurementBindingDigest(input.contract, measurementValue),
		}),
	};
}

describe("schema-v3 portfolio terminal evaluator", () => {
	it("derives complete from exact host vectors and the host-selected frontier", async () => {
		const result = await evaluate(validInput());

		expect(result.outcome).toBe("complete");
		expect(result.goalDispositions).toEqual([{ goalId: "goal-quality", disposition: "achieved" }]);
		expect(result.commitIntent).toMatchObject({
			capability: "portfolio_default_completion",
			outcome: "complete",
			workflowId: WORKFLOW_ID,
			currentStateDigest: STATE_DIGEST,
			currentRevision: REVISION,
			evaluationEpoch: 1,
			witnessRequired: true,
		});
		expect(result.commitIntent?.receiptIds).toEqual([
			"receipt-boundary",
			"receipt-completion",
			"receipt-frontier",
			"receipt-holdout",
			"receipt-measurement",
			"receipt-measurement-adversarial",
			"receipt-measurement-holdout",
			"receipt-training",
			"receipt-validation",
		]);
	});

	it("rejects terminal-local measurement fields and exposes only the canonical outcome", async () => {
		const input = validInput();
		const terminalLocalMeasurement = {
			...input.measurements[0]!.measurement,
			domainId: "domain-quality",
			closureRootDigest: PORTFOLIO_ROOT,
		} as AutoResearchPortfolioMeasurement;
		const result = await evaluate({
			...input,
			measurements: [
				{
					measurement: terminalLocalMeasurement,
					receipt: receipt(input.receiptContext, {
						receiptKind: "artifact",
						receiptId: "receipt-terminal-local-measurement",
						issuerId: "host-evaluator",
						payloadDigest: DIGEST,
						bindingDigest: portfolioMeasurementBindingDigest(input.contract, terminalLocalMeasurement),
					}),
				},
			],
		});

		expect(result.outcome).not.toBe("complete");
		expect("terminalOutcome" in result).toBe(false);
		expect("terminalDisposition" in result).toBe(false);
	});

	it("recomputes canonical measurement digests instead of trusting a valid-looking digest", async () => {
		const input = validInput();
		const forgedMeasurement = {
			...input.measurements[0]!.measurement,
			measurementDigest: "b".repeat(64),
		} as AutoResearchPortfolioMeasurement;

		const result = await evaluate({
			...input,
			measurements: [measurementEvidence(input, forgedMeasurement, "receipt-forged-measurement-digest")],
		});

		expect(result.outcome).toBe("failed");
		expect(result.accepted).toBe(false);
	});

	it("rejects measurements whose sample count is below their repeat count", async () => {
		const input = validInput();
		const forgedMeasurement = {
			...input.measurements[0]!.measurement,
			sampleCount: 1,
		} as AutoResearchPortfolioMeasurement;

		const result = await evaluate({
			...input,
			measurements: [measurementEvidence(input, forgedMeasurement, "receipt-forged-sample-count")],
		});

		expect(result.outcome).toBe("failed");
		expect(result.accepted).toBe(false);
	});

	it("enforces locked repeatability aggregation and uncertainty width", async () => {
		const input = validInput();
		const aggregationMismatch = {
			...input.measurements[0]!.measurement,
			aggregation: "mean" as const,
			measurementDigest: "",
		};
		aggregationMismatch.measurementDigest = digestWithoutField(aggregationMismatch, "measurementDigest");
		const widthMismatch = {
			...input.measurements[0]!.measurement,
			confidenceInterval: { lower: 0.7, upper: 1, level: 0.95 },
			measurementDigest: "",
		};
		widthMismatch.measurementDigest = digestWithoutField(widthMismatch, "measurementDigest");
		for (const measurementValue of [aggregationMismatch, widthMismatch]) {
			const result = await evaluate({
				...input,
				measurements: [
					measurementEvidence(input, measurementValue, `receipt-policy-${measurementValue.measurementId}`),
				],
			});
			expect(result.outcome).toBe("failed");
			expect(result.accepted).toBe(false);
		}
	});

	it("requires candidate, opaque holdout, and adversarial evidence for every terminal goal", async () => {
		const input = validInput();
		const candidateOnly = {
			...input,
			measurements: input.measurements.filter((entry) => entry.measurement.kind === "candidate"),
		};

		const result = await evaluate(candidateOnly);

		expect(result.outcome).not.toBe("complete");
		expect(result.accepted).toBe(false);
	});

	it("requires the exact receipt kind for each signed evidence role", async () => {
		const input = validInput();
		const wrongKind = measurementEvidence(
			input,
			input.measurements[0]!.measurement,
			"receipt-measurement-wrong-kind",
			"decision",
		);

		const result = await evaluate({
			...input,
			measurements: [wrongKind, ...input.measurements.slice(1)],
		});

		expect(result.outcome).toBe("failed");
		expect(result.accepted).toBe(false);
	});

	it("rejects a runtime goal decision that claims achieved", async () => {
		const input = validInput();
		const invalidDecision = {
			goalId: "goal-quality",
			disposition: "achieved",
			receipt: receipt(input.receiptContext, {
				receiptKind: "decision",
				receiptId: "receipt-achieved-decision",
				issuerId: "host-coordinator",
				payloadDigest: DIGEST,
				bindingDigest: portfolioGoalDecisionBindingDigest(input.contract, "goal-quality", "blocked"),
			}),
		} as unknown as PortfolioHostGoalDecisionEvidence;
		const result = await evaluate({ ...input, goalDecisions: [invalidDecision] });

		expect(result.outcome).toBe("boundary_violation");
		expect(result.accepted).toBe(false);
	});

	it("keeps explicit provider-empty and partial coverage per goal", async () => {
		const input = validInput(true);
		const withCoverage = (coverage: "provider_empty" | "partial_coverage"): PortfolioTerminalInput => ({
			...input,
			acquisition: {
				splits: input.acquisition.splits.map((split) => {
					const artifacts = split.artifacts.map((artifact) => ({
						...artifact,
						coverage,
						gapClassification: coverage,
					}));
					return {
						...split,
						artifacts,
						receipt: receipt(input.receiptContext, {
							receiptKind: "capability",
							receiptId: `receipt-${split.split}-${coverage}`,
							issuerId: "host-acquisition",
							oneUse: true,
							payloadDigest: DIGEST,
							bindingDigest: portfolioAcquisitionBindingDigest(input.contract, split.split, artifacts),
						}),
					};
				}),
			},
		});
		const providerEmpty = await evaluate(bindTerminalCapabilities(withCoverage("provider_empty")));
		const partialCoverage = await evaluate(bindTerminalCapabilities(withCoverage("partial_coverage")));

		expect(providerEmpty.outcome).toBe("partial_success");
		expect(providerEmpty.goalDispositions).toContainEqual({ goalId: "goal-safety", disposition: "search_exhausted" });
		expect(providerEmpty.outcome).not.toBe("search_exhausted");
		expect(partialCoverage.outcome).toBe("partial_success");
		expect(partialCoverage.outcome).not.toBe("search_exhausted");
	});

	it("rejects extra fields on frontier and artifact evidence even with a matching receipt", async () => {
		const input = validInput();
		const entries = input.frontier.entries.map((entry) => ({ ...entry, terminalStatus: "complete" }));
		const frontier = {
			...input.frontier,
			entries,
			receipt: receipt(input.receiptContext, {
				receiptKind: "decision",
				receiptId: "receipt-frontier-extra-field",
				issuerId: "host-frontier",
				payloadDigest: DIGEST,
				bindingDigest: portfolioFrontierBindingDigest(input.contract, entries, input.frontier.selectedEntryIds),
			}),
		};
		const result = await evaluate({ ...input, frontier: frontier as PortfolioHostFrontierEvidence });

		expect(result.outcome).not.toBe("complete");
		expect(result.accepted).toBe(false);
		const artifact = { ...input.acquisition.splits[0]!.artifacts[0]!, terminalStatus: "complete" };
		const acquisition = {
			...input.acquisition,
			splits: input.acquisition.splits.map((split, index) =>
				index === 0
					? {
							...split,
							artifacts: [artifact],
							receipt: receipt(input.receiptContext, {
								receiptKind: "artifact",
								receiptId: "receipt-acquisition-extra-field",
								issuerId: "host-acquisition",
								oneUse: true,
								payloadDigest: DIGEST,
								bindingDigest: portfolioAcquisitionBindingDigest(input.contract, split.split, [artifact]),
							}),
						}
					: split,
			),
		};
		const artifactResult = await evaluate({ ...input, acquisition: acquisition as PortfolioHostAcquisitionEvidence });
		expect(artifactResult.outcome).toBe("failed");
		expect(artifactResult.accepted).toBe(false);
	});

	it("does not trust target booleans, worker terminal status, or worker frontier selection", async () => {
		const input = validInput();
		const untrusted = {
			...input,
			targetReached: true,
			worker: { terminalStatus: "complete" },
			frontier: { ...input.frontier, selectedEntryIds: [] },
		} as unknown as PortfolioTerminalInput;

		const result = await evaluate(untrusted);

		expect(result.outcome).not.toBe("complete");
		expect(result.goalDispositions[0]?.disposition).not.toBe("achieved");

		const workerSelected = {
			...input,
			receiptContext: {
				...input.receiptContext,
				keyResolver: {
					resolve: async (keyId: string) => {
						if (keyId === "worker-key") throw new Error("worker key is not host-authorized");
						return input.receiptContext.keyResolver.resolve(keyId);
					},
				},
			},
			frontier: {
				...input.frontier,
				receipt: receipt(input.receiptContext, {
					receiptKind: "decision",
					receiptId: "receipt-frontier-worker",
					issuerId: "worker-frontier",
					keyId: "worker-key",
					payloadDigest: DIGEST,
					bindingDigest: portfolioFrontierBindingDigest(
						input.contract,
						input.frontier.entries,
						input.frontier.selectedEntryIds,
					),
				}),
			},
		};

		const workerResult = await evaluate(workerSelected);

		expect(workerResult.outcome).not.toBe("complete");
	});

	it("rejects worker, self, forged, and substituted capability receipts", async () => {
		const input = validInput();
		const frontierBinding = portfolioFrontierBindingDigest(
			input.contract,
			input.frontier.entries,
			input.frontier.selectedEntryIds,
		);
		const workerReceipt = receipt(input.receiptContext, {
			receiptKind: "decision",
			receiptId: "receipt-frontier-worker-capability",
			issuerId: "worker",
			keyId: "worker-key",
			payloadDigest: DIGEST,
			bindingDigest: frontierBinding,
			capabilityBinding: terminalCapabilityBinding(input, "frontier", frontierBinding),
		});
		const workerInput = {
			...input,
			receiptContext: {
				...input.receiptContext,
				keyResolver: {
					resolve: async (keyId: string) => {
						if (keyId === "worker-key") throw new Error("worker capability is not host-authorized");
						return input.receiptContext.keyResolver.resolve(keyId);
					},
				},
			},
			frontier: { ...input.frontier, receipt: workerReceipt },
		};
		const selfCapability = {
			...terminalCapabilityBinding(input, "frontier", frontierBinding),
			executionIdentity: "candidate-self",
		};
		const selfInput = {
			...input,
			receiptContext: {
				...input.receiptContext,
				principalAuthorizer: {
					authorize: async (
						authorizationInput: Parameters<typeof input.receiptContext.principalAuthorizer.authorize>[0],
					) => {
						if (authorizationInput.executionIdentity === "candidate-self")
							throw new Error("candidate self-authority is not host-authorized");
						return input.receiptContext.principalAuthorizer.authorize(authorizationInput);
					},
				},
			},
			frontier: {
				...input.frontier,
				receipt: receipt(input.receiptContext, {
					receiptKind: "decision",
					receiptId: "receipt-frontier-self-capability",
					issuerId: "fixture-host",
					payloadDigest: DIGEST,
					bindingDigest: frontierBinding,
					capabilityBinding: selfCapability,
				}),
			},
		};
		const forgedInput = {
			...input,
			frontier: {
				...input.frontier,
				receipt: {
					...input.frontier.receipt,
					capabilityBinding: {
						...input.frontier.receipt.capabilityBinding!,
						resourceDigest: "1".repeat(64),
					},
				},
			},
		};
		const alternateInput = { ...input, frontier: { ...input.frontier, selectedEntryIds: [] } };
		const alternateBinding = portfolioFrontierBindingDigest(
			input.contract,
			input.frontier.entries,
			alternateInput.frontier.selectedEntryIds,
		);
		const substitutedInput = {
			...input,
			frontier: {
				...input.frontier,
				receipt: receipt(input.receiptContext, {
					receiptKind: "decision",
					receiptId: "receipt-frontier-substituted-capability",
					issuerId: "fixture-host",
					payloadDigest: DIGEST,
					bindingDigest: frontierBinding,
					capabilityBinding: terminalCapabilityBinding(alternateInput, "frontier", alternateBinding),
				}),
			},
		};

		for (const candidate of [workerInput, selfInput, forgedInput, substitutedInput]) {
			const result = await evaluate(candidate);
			expect(result.accepted).toBe(false);
			expect(result.outcome).not.toBe("complete");
		}
	});

	it("returns partial_success for mixed achieved and unresolved host goals", async () => {
		const result = await evaluate(validInput(true));

		expect(result.outcome).toBe("partial_success");
		expect(result.goalDispositions).toEqual([
			{ goalId: "goal-quality", disposition: "achieved" },
			{ goalId: "goal-safety", disposition: "active" },
		]);
		expect(result.outcome).not.toBe("complete");
	});

	it("makes a valid hard-boundary violation dominate metric success", async () => {
		const input = validInput();
		const boundary: PortfolioHostBoundaryEvidence = {
			...input.boundaries[0]!,
			passed: false,
			receipt: receipt(input.receiptContext, {
				receiptKind: "adjudication",
				receiptId: "receipt-boundary-fail",
				issuerId: "host-safety",
				payloadDigest: DIGEST,
				bindingDigest: portfolioBoundaryBindingDigest(input.contract, "boundary-safety", false),
			}),
		};

		const result = await evaluate(bindTerminalCapabilities({ ...input, boundaries: [boundary] }));

		expect(result.outcome).toBe("boundary_violation");
		expect(result.accepted).toBe(false);
	});

	it("rejects forged, stale, and evaluator/input-epoch-mismatched receipts", async () => {
		const input = validInput();
		const forged = {
			...input,
			measurements: input.measurements.map((entry, index) =>
				index === 0 ? { ...entry, receipt: { ...entry.receipt, signature: "forged" } } : entry,
			),
		};
		const stale = validInput(false, { currentStateDigest: "different-state" });
		const mismatched = {
			...input,
			measurements: input.measurements.map((entry, index) =>
				index === 0 ? { ...entry, measurement: { ...entry.measurement, evaluatorDigest: "b".repeat(64) } } : entry,
			),
		};
		const epochMismatched = {
			...input,
			measurements: input.measurements.map((entry, index) =>
				index === 0 ? { ...entry, measurement: { ...entry.measurement, evaluationEpoch: 99 } } : entry,
			),
		};
		const splitMismatched = {
			...input,
			measurements: input.measurements.map((entry, index) =>
				index === 0
					? {
							...entry,
							measurement: {
								...entry.measurement,
								splitClosureRoots: {
									...input.contract.inputManifest.splitClosureRoots,
									training: "8".repeat(64),
								},
							},
						}
					: entry,
			),
		};

		await expect(evaluate(forged)).resolves.toMatchObject({ outcome: "failed", accepted: false });
		await expect(evaluate(stale)).resolves.toMatchObject({ accepted: false });
		expect((await evaluate(stale)).outcome).not.toBe("complete");
		await expect(evaluate(mismatched)).resolves.toMatchObject({ outcome: "failed", accepted: false });
		await expect(evaluate(epochMismatched)).resolves.toMatchObject({ outcome: "failed", accepted: false });
		await expect(evaluate(splitMismatched)).resolves.toMatchObject({
			outcome: "boundary_violation",
			accepted: false,
		});
	});

	it("rejects omitted metric evidence instead of letting a favorable vector complete", async () => {
		const input = validInput();
		const omittedMeasurement = {
			...input.measurements[0]!.measurement,
			vector: [],
		} as AutoResearchPortfolioMeasurement;

		const result = await evaluate({
			...input,
			measurements: [{ measurement: omittedMeasurement, receipt: input.measurements[0]!.receipt }],
		});

		expect(result.outcome).toBe("failed");
		expect(result.outcome).not.toBe("complete");
	});

	it("requires independent completion over exact distinct split generations and closure roots", async () => {
		const input = validInput();
		const forged = {
			...input,
			completion: {
				...input.completion,
				artifacts: input.completion.artifacts.map((artifact, index) =>
					index === 0 ? { ...artifact, generation: 99 } : artifact,
				),
			},
		};

		const result = await evaluate(forged);

		expect(result.outcome).toBe("boundary_violation");

		const splitForged = {
			...input,
			acquisition: {
				splits: input.acquisition.splits.map((split, index) =>
					index === 0
						? {
								...split,
								artifacts: split.artifacts.map((artifact) => ({
									...artifact,
									closureRootDigest: "8".repeat(64),
								})),
							}
						: split,
				),
			},
		};
		expect((await evaluate(splitForged)).outcome).toBe("boundary_violation");
	});

	it("is invariant to host evidence ordering", async () => {
		const input = validInput();
		const reordered = validInput(false, {
			boundaries: [...input.boundaries].reverse(),
			acquisition: { splits: [...input.acquisition.splits].reverse() },
			measurements: [...input.measurements].reverse(),
		});

		expect(await evaluate(reordered)).toEqual(await evaluate(input));
	});

	it("does not treat unknown acquisition as search exhaustion", async () => {
		const input = validInput();
		const unknownSplits = input.acquisition.splits.map((split, index) =>
			index === 0
				? {
						...split,
						artifacts: split.artifacts.map((artifact) => ({ ...artifact, coverage: "unknown" as const })),
					}
				: split,
		);
		const result = await evaluate({ ...input, acquisition: { splits: unknownSplits } });

		expect(result.outcome).not.toBe("search_exhausted");
	});

	it("requires independent infeasibility proof and keeps it distinct from host search exhaustion", async () => {
		const input = validInput();
		const unresolvedFrontier: PortfolioHostFrontierEvidence = {
			...input.frontier,
			selectedEntryIds: [],
			receipt: receipt(input.receiptContext, {
				receiptKind: "decision",
				receiptId: "receipt-frontier-unresolved-infeasible",
				issuerId: "host-frontier",
				payloadDigest: DIGEST,
				bindingDigest: portfolioFrontierBindingDigest(input.contract, input.frontier.entries, []),
			}),
		};
		const proof: PortfolioHostInfeasibilityEvidence = {
			goalId: "goal-quality",
			evaluatorProofDigest: DIGEST,
			adjudicationDigest: VERIFICATION,
			evaluatorProofReceipt: receipt(input.receiptContext, {
				receiptKind: "adjudication",
				receiptId: "receipt-proof",
				issuerId: "host-evaluator",
				payloadDigest: DIGEST,
				bindingDigest: portfolioInfeasibilityProofBindingDigest(input.contract, "goal-quality", DIGEST),
			}),
			adjudicationReceipt: receipt(input.receiptContext, {
				receiptKind: "adjudication",
				receiptId: "receipt-adjudication",
				issuerId: "host-adjudicator",
				payloadDigest: DIGEST,
				bindingDigest: portfolioInfeasibilityAdjudicationBindingDigest(
					input.contract,
					"goal-quality",
					DIGEST,
					VERIFICATION,
				),
			}),
		};
		const infeasible = await evaluate(
			bindTerminalCapabilities({ ...input, frontier: unresolvedFrontier, infeasibility: [proof] }),
		);
		const decision: PortfolioHostGoalDecisionEvidence = {
			goalId: "goal-quality",
			disposition: "search_exhausted",
			receipt: receipt(input.receiptContext, {
				receiptKind: "decision",
				receiptId: "receipt-search-exhausted",
				issuerId: "host-coordinator",
				payloadDigest: DIGEST,
				bindingDigest: portfolioGoalDecisionBindingDigest(input.contract, "goal-quality", "search_exhausted"),
			}),
		};
		const exhausted = await evaluate(
			bindTerminalCapabilities({
				...input,
				frontier: unresolvedFrontier,
				infeasibility: [],
				goalDecisions: [decision],
			}),
		);

		expect(infeasible.outcome).toBe("infeasible");
		expect(exhausted.outcome).toBe("search_exhausted");
		expect(exhausted.outcome).not.toBe("infeasible");
	});

	it("requires a real one-use user receipt naming every tradeoff concession, floor, evidence, and frontier entry", async () => {
		const input = validInput(true, {}, true);
		const unresolvedMeasurements = input.measurements.map((evidence) => {
			const measurementValue = {
				...evidence.measurement,
				vector: evidence.measurement.vector.map((entry) => ({ ...entry, value: 0.6 })),
				confidenceInterval: { lower: 0.5, upper: 0.7, level: evidence.measurement.confidenceInterval.level },
				measurementDigest: "",
			};
			measurementValue.measurementDigest = digestWithoutField(measurementValue, "measurementDigest");
			return measurementEvidence(input, measurementValue, `${evidence.receipt.receiptId}-unresolved`);
		});
		const unresolvedInputBase = { ...input, measurements: unresolvedMeasurements };
		const tradeoffBody = {
			concessions: ["goal-quality", "goal-safety"],
			floors: [
				{ goalId: "goal-quality", value: 0.5 },
				{ goalId: "goal-safety", value: 0.5 },
			],
			evidenceIds: unresolvedMeasurements.map((entry) => entry.measurement.measurementId),
			selectedFrontierEntryIds: ["frontier-1"],
		};
		const tradeoff: PortfolioHostTradeoffEvidence = {
			...tradeoffBody,
			receipt: receipt(input.receiptContext, {
				receiptKind: "decision",
				receiptId: "receipt-tradeoff",
				issuerId: "user",
				oneUse: true,
				payloadDigest: DIGEST,
				bindingDigest: portfolioTradeoffBindingDigest(input.contract, tradeoffBody),
			}),
		};
		const unresolvedFrontier: PortfolioHostFrontierEvidence = {
			...input.frontier,
			selectedEntryIds: ["frontier-1"],
			receipt: receipt(input.receiptContext, {
				receiptKind: "decision",
				receiptId: "receipt-frontier-unresolved",
				issuerId: "host-frontier",
				payloadDigest: DIGEST,
				bindingDigest: portfolioFrontierBindingDigest(input.contract, input.frontier.entries, ["frontier-1"]),
			}),
		};
		const unresolvedInput = bindTerminalCapabilities({
			...unresolvedInputBase,
			frontier: unresolvedFrontier,
			tradeoff,
		});
		const forgedTradeoff = {
			...unresolvedInput,
			tradeoff: { ...tradeoff, receipt: { ...tradeoff.receipt, signature: "forged" } },
		};

		expect((await evaluate(forgedTradeoff)).outcome).toBe("partial_success");
		expect((await evaluate(forgedTradeoff)).accepted).toBe(false);
		const first = await evaluate(bindTerminalCapabilities(unresolvedInput));
		const second = await evaluate(bindTerminalCapabilities(unresolvedInput));

		expect(first.outcome).toBe("complete_with_tradeoff");
		expect(first.commitIntent).toMatchObject({
			capability: "portfolio_default_completion",
			witnessRequired: true,
			receiptIds: ["receipt-tradeoff"],
		});
		expect(second).toEqual(first);
	});

	it("returns one-use stop and withdrawal witnesses without consuming during evaluation", async () => {
		const stopInput = validInput();
		const stopBody = { reason: "user ended the run" };
		const stop = {
			...stopBody,
			receipt: receipt(stopInput.receiptContext, {
				receiptKind: "decision",
				receiptId: "receipt-stop",
				issuerId: "user",
				oneUse: true,
				payloadDigest: DIGEST,
				bindingDigest: portfolioStopBindingDigest(stopInput.contract, stopBody.reason),
			}),
		};
		const stopped = await evaluate(bindTerminalCapabilities({ ...stopInput, stop }));
		const stoppedAgain = await evaluate(bindTerminalCapabilities({ ...stopInput, stop }));
		expect(stopped).toMatchObject({ outcome: "stopped", accepted: true });
		expect(stopped.commitIntent).toMatchObject({
			capability: "portfolio_default_completion",
			witnessRequired: true,
			receiptIds: ["receipt-stop"],
		});
		expect(stoppedAgain).toEqual(stopped);

		const withdrawalInput = validInput(true);
		const withdrawal = {
			goalId: "goal-safety",
			disposition: "withdrawn_by_user" as const,
			receipt: receipt(withdrawalInput.receiptContext, {
				receiptKind: "decision",
				receiptId: "receipt-withdrawal",
				issuerId: "user",
				oneUse: true,
				payloadDigest: DIGEST,
				bindingDigest: portfolioGoalDecisionBindingDigest(
					withdrawalInput.contract,
					"goal-safety",
					"withdrawn_by_user",
				),
			}),
		};
		const withdrawn = await evaluate(bindTerminalCapabilities({ ...withdrawalInput, goalDecisions: [withdrawal] }));
		const withdrawnAgain = await evaluate(
			bindTerminalCapabilities({ ...withdrawalInput, goalDecisions: [withdrawal] }),
		);
		expect(withdrawn).toMatchObject({ outcome: "partial_success", accepted: true });
		expect(withdrawn.goalDispositions).toContainEqual({ goalId: "goal-safety", disposition: "withdrawn_by_user" });
		expect(withdrawn.commitIntent).toMatchObject({
			capability: "portfolio_default_completion",
			witnessRequired: true,
			receiptIds: ["receipt-withdrawal"],
		});
		expect(withdrawnAgain).toEqual(withdrawn);
	});

	it("keeps invalid outcomes non-mutating", async () => {
		const input = validInput();
		const forged = {
			...input,
			frontier: { ...input.frontier, receipt: { ...input.frontier.receipt, signature: "forged" } },
		};

		await evaluate(forged);

		expect(input.frontier.receipt.signature).not.toBe("forged");
	});
});
