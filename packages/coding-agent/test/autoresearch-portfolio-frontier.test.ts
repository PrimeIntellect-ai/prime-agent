import { describe, expect, it } from "vitest";
import type {
	AutoResearchPortfolioCandidate,
	AutoResearchPortfolioContract,
	AutoResearchPortfolioMeasurement,
} from "../src/core/autoresearch/portfolio-contracts.js";
import {
	parseAutoResearchPortfolioCandidate,
	parseAutoResearchPortfolioContract,
	parseAutoResearchPortfolioMeasurement,
} from "../src/core/autoresearch/portfolio-contracts.js";
import {
	type AutoResearchPortfolioAdmissionInput,
	type AutoResearchPortfolioBoundaryEvidence,
	type AutoResearchPortfolioInvariantEvidence,
	type AutoResearchPortfolioTradeoffAuthorization,
	deriveAutoResearchPortfolioImpactClosure,
	evaluateAutoResearchPortfolioAdmission,
	preflightAutoResearchPortfolioCandidate,
} from "../src/core/autoresearch/portfolio-frontier.js";
import {
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	type WorkflowArtifactRef,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";

const DIGEST = "a".repeat(64);
const ROOTS = {
	training: "b".repeat(64),
	validation: "c".repeat(64),
	holdout: "d".repeat(64),
} as const;
const WORKFLOW_ID = "portfolio-frontier-workflow";
const STATE_DIGEST = "state-frontier";
const TRUSTED_NOW = "2026-08-17T23:00:00.000Z";
const VALID_UNTIL = "2026-08-18T12:00:00.000Z";

function splitRoots(): typeof ROOTS {
	return { ...ROOTS };
}

function artifact(
	split: "training" | "validation" | "holdout",
	authority: "training_workers_training_only" | "validation_evaluator_host_only" | "holdout_host_aggregate_only",
): Record<string, unknown> {
	const ranges = {
		training: ["2024-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"],
		validation: ["2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
		holdout: ["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
	} as const;
	return {
		split,
		objectUri: `gs://portfolio/${split}`,
		generation: 1,
		sha256: DIGEST,
		bytes: 1,
		schemaVersion: "v1",
		modality: "text",
		instrumentSet: ["instrument-1"],
		sourceTimeStart: ranges[split][0],
		sourceTimeEnd: ranges[split][1],
		validationResult: "passed",
		coverage: "complete",
		gapClassification: "none",
		lifecycle: "sealed",
		restoreVerification: {
			locked: true,
			independentlyRestored: true,
			independentlyRehashed: true,
			verificationEvidenceDigest: DIGEST,
		},
		provenance: {
			sourceSystem: "fixture",
			sourceDataset: split,
			ingestDigest: DIGEST,
			lineageDigest: DIGEST,
			provenanceReceiptDigest: DIGEST,
		},
		closureRootDigest: ROOTS[split],
		accessAuthority: authority,
	};
}

function inputManifest(): Record<string, unknown> {
	return {
		locked: true,
		evaluationEpoch: 1,
		manifestRevision: 1,
		closureRootDigest: DIGEST,
		manifestDigest: DIGEST,
		splitClosureRoots: splitRoots(),
		splitBoundaryPolicy: {
			locked: true,
			trainingEndExclusive: "2025-01-01T00:00:00.000Z",
			validationStartInclusive: "2025-01-01T00:00:00.000Z",
			validationEndExclusive: "2026-01-01T00:00:00.000Z",
			holdoutStartInclusive: "2026-01-01T00:00:00.000Z",
			holdoutEndExclusive: "2027-01-01T00:00:00.000Z",
			policyDigest: DIGEST,
		},
		training: {
			locked: true,
			split: "training",
			closureRootDigest: ROOTS.training,
			artifacts: [artifact("training", "training_workers_training_only")],
		},
		validation: {
			locked: true,
			split: "validation",
			closureRootDigest: ROOTS.validation,
			artifacts: [artifact("validation", "validation_evaluator_host_only")],
		},
		holdout: {
			locked: true,
			split: "holdout",
			closureRootDigest: ROOTS.holdout,
			artifacts: [artifact("holdout", "holdout_host_aggregate_only")],
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
	};
}

const metricTargets: Readonly<
	Record<
		string,
		{
			readonly goalId: string;
			readonly direction: "lower" | "higher";
			readonly target: number;
			readonly baseline: number;
		}
	>
> = {
	"latency.p50": { goalId: "latency", direction: "lower", target: 95, baseline: 100 },
	"cost.total": { goalId: "cost", direction: "lower", target: 9, baseline: 10 },
	"quality.score": { goalId: "quality", direction: "higher", target: 0.82, baseline: 0.8 },
	"safety.errors": { goalId: "safety", direction: "lower", target: 0, baseline: 0 },
	"memory.bytes": { goalId: "memory", direction: "lower", target: 975, baseline: 1000 },
	"explore.metric": { goalId: "explore", direction: "higher", target: 1, baseline: 0 },
	"explore.secondary": { goalId: "explore-secondary", direction: "higher", target: 1, baseline: 0 },
};

function metric(metricId: string): Record<string, unknown> {
	const definition = metricTargets[metricId];
	return {
		metricId,
		name: metricId,
		requirementId: `requirement-${metricId}`,
		direction: definition.direction,
		target: definition.target,
		unit: "unit",
		locked: true,
		evaluationEpoch: 1,
		metricRevision: 1,
		closureRootDigest: DIGEST,
		inputManifestDigest: DIGEST,
		splitClosureRoots: splitRoots(),
	};
}

function goal(goalId: string, metricIds: readonly string[]): Record<string, unknown> {
	const metricDefinitions = metricIds.map(metric);
	return {
		goalId,
		domainId: `domain-${goalId}`,
		title: goalId,
		description: goalId,
		scope: "terminal",
		metrics: metricDefinitions,
		baseline: {
			locked: true,
			measurementId: `baseline-${goalId}`,
			metricValues: metricIds.map((metricId) => ({ metricId, value: metricTargets[metricId].baseline })),
			evidenceDigest: DIGEST,
			evaluationEpoch: 1,
			closureRootDigest: DIGEST,
			inputManifestDigest: DIGEST,
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
			closureRootDigest: DIGEST,
			inputManifestDigest: DIGEST,
			splitClosureRoots: splitRoots(),
		},
		parser: {
			locked: true,
			parserId: `parser-${goalId}`,
			kind: "json_object",
			metricKeys: metricIds,
			parserDigest: DIGEST,
			evaluationEpoch: 1,
			inputManifestRevision: 1,
			closureRootDigest: DIGEST,
			inputManifestDigest: DIGEST,
			splitClosureRoots: splitRoots(),
		},
		command: { locked: true, argv: ["node", "evaluate.mjs"], shell: false, cwd: ".", commandDigest: DIGEST },
		repeatability: { locked: true, runs: 3, aggregation: "median", seed: "seed", maxVariance: 4 },
		uncertainty: { locked: true, method: "deterministic", confidence: 1, maxWidth: 0, maxVariance: 4 },
		opaqueHoldout: {
			locked: true,
			policy: "host_only",
			candidateVisible: false,
			handleDigest: DIGEST,
			inputDigest: DIGEST,
			resolverDigest: DIGEST,
			evaluationEpoch: 1,
			closureRootDigest: DIGEST,
			splitClosureRoots: splitRoots(),
		},
		falsification: { locked: true, criteria: ["falsify"], manifestDigest: DIGEST },
		adversarial: { locked: true, checks: ["mutation"] },
	};
}

function digestWithoutField(value: Record<string, unknown>, field: string): string {
	const payload = { ...value };
	delete payload[field];
	return digestObject(payload);
}

function canonicalContractRecord(value: Record<string, unknown>): AutoResearchPortfolioContract {
	const acceptanceRequirements = Object.keys(metricTargets)
		.map((metricId) => {
			const requirement: Record<string, unknown> = {
				requirementId: `requirement-${metricId}`,
				statement: `Requirement for ${metricId}`,
				locked: true,
				requirementDigest: "",
			};
			requirement.requirementDigest = digestWithoutField(requirement, "requirementDigest");
			return requirement;
		})
		.sort((left, right) => String(left.requirementId).localeCompare(String(right.requirementId)));
	value.acceptanceRequirements = acceptanceRequirements;
	const manifest = value.inputManifest as Record<string, unknown>;
	const policy = manifest.splitBoundaryPolicy as Record<string, unknown>;
	policy.policyDigest = digestWithoutField(policy, "policyDigest");
	manifest.manifestDigest = digestWithoutField(manifest, "manifestDigest");
	for (const goalRecord of value.goals as Array<Record<string, unknown>>) {
		for (const metricRecord of goalRecord.metrics as Array<Record<string, unknown>>)
			metricRecord.inputManifestDigest = manifest.manifestDigest;
		for (const key of ["baseline", "evaluator", "parser"] as const)
			(goalRecord[key] as Record<string, unknown>).inputManifestDigest = manifest.manifestDigest;
		(goalRecord.opaqueHoldout as Record<string, unknown>).inputDigest = manifest.manifestDigest;
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
	return parseAutoResearchPortfolioContract(value);
}

const contract = canonicalContractRecord({
	schemaVersion: 3,
	contractId: "portfolio-1",
	objective: "Improve the portfolio vector",
	goals: [
		goal("latency", ["latency.p50"]),
		goal("cost", ["cost.total"]),
		goal("quality", ["quality.score"]),
		goal("safety", ["safety.errors"]),
		goal("memory", ["memory.bytes"]),
		goal("explore", ["explore.metric"]),
		goal("explore-secondary", ["explore.secondary"]),
	],
	goalRelations: [
		{ fromGoalId: "latency", toGoalId: "cost", relation: "prerequisite", rationale: "cost" },
		{ fromGoalId: "latency", toGoalId: "quality", relation: "competing", rationale: "quality" },
		{ fromGoalId: "latency", toGoalId: "safety", relation: "conflict", rationale: "safety" },
		{ fromGoalId: "latency", toGoalId: "memory", relation: "complementary", rationale: "memory" },
	],
	lexicographicTiers: [
		{ tier: 1, goalIds: ["latency", "safety"] },
		{ tier: 2, goalIds: ["cost", "memory"] },
		{ tier: 3, goalIds: ["quality", "explore", "explore-secondary"] },
	],
	hardBoundaries: [
		{ boundaryId: "scope", statement: "scope", scope: "terminal", locked: true },
		{ boundaryId: "safety-reviewed", statement: "safety", scope: "terminal", locked: true },
	],
	invariants: [
		{ invariantId: "safety-invariant", statement: "safe", scope: "terminal", locked: true, checkDigest: DIGEST },
	],
	nonGoals: [],
	budgets: {
		maxCandidates: 10,
		maxMeasurements: 100,
		maxWallSeconds: 100,
		maxCostMicrounits: 1,
		maxParallelCandidates: 1,
		maxTokens: 100,
	},
	safety: {
		locked: true,
		network: "disabled",
		externalEffects: "none",
		requireOpaqueHoldout: true,
		requireAdversarialReview: true,
		maxUncertainty: 0,
	},
	inputManifest: inputManifest(),
	scopePartitions: [
		{ partitionId: "source", scope: "terminal", paths: ["src"], dataDigests: [DIGEST], mutableBy: "candidate" },
	],
	terminalScope: "terminal",
	learningScope: "learning",
});

function candidate(
	candidateId = "candidate-good",
	familyId = "cache-family-new",
	mechanismDigest = DIGEST,
): AutoResearchPortfolioCandidate {
	return parseAutoResearchPortfolioCandidate({
		candidateId,
		goalIds: ["latency"],
		solutionFamily: { familyId, name: "cache", mechanismClass: "representation" },
		ancestry: { parentCandidateIds: [], baseDigest: DIGEST, lineageDigest: DIGEST },
		causalMechanism: {
			hypothesis: "cache improves latency",
			intervention: "replace representation",
			expectedObservation: "latency improves",
			falsificationCondition: "latency does not improve",
			mechanismDigest: /^[0-9a-f]{64}$/u.test(mechanismDigest) ? mechanismDigest : digestObject({ mechanismDigest }),
		},
		change: { kind: "mechanism", changedPaths: ["src/cache.ts"], parameterChanges: [], changeDigest: DIGEST },
		scope: "terminal",
	});
}

function measurement(
	metricId: string,
	value: number,
	options: Partial<AutoResearchPortfolioMeasurement> & {
		readonly confidenceInterval?: { readonly lower: number; readonly upper: number; readonly level: number };
		readonly repeatIndex?: number;
	} = {},
): AutoResearchPortfolioMeasurement {
	const definition = metricTargets[metricId];
	const goalRecord = contract.goals.find((goalEntry) => goalEntry.goalId === definition.goalId)!;
	const record: Record<string, unknown> = {
		measurementId: `${metricId}-${options.repeatIndex ?? 1}`,
		goalId: definition.goalId,
		candidateId: "candidate-good",
		scope: "terminal",
		kind: "candidate",
		vector: [{ metricId, value }],
		repeatIndex: options.repeatIndex ?? 1,
		sampleCount: 5,
		evaluationEpoch: 1,
		inputManifestDigest: DIGEST,
		splitClosureRoots: splitRoots(),
		confidenceInterval: { lower: value, upper: value, level: 1 },
		variance: 0,
		runCount: 3,
		aggregation: "median",
		inputDigest: contract.inputManifest.manifestDigest,
		evaluatorDigest: goalRecord.evaluator.evaluatorDigest,
		parserDigest: goalRecord.parser.parserDigest,
		commandDigest: goalRecord.command.commandDigest,
		workspaceDigest: DIGEST,
		evidenceDigests: [DIGEST],
		measuredAt: "2026-08-17T12:00:00.000Z",
		measurementDigest: "",
		...options,
	};
	record.inputManifestDigest = contract.inputManifest.manifestDigest;
	record.splitClosureRoots = splitRoots();
	record.measurementDigest = digestWithoutField(record, "measurementDigest");
	return parseAutoResearchPortfolioMeasurement(record, {
		confidenceLevel: goalRecord.uncertainty.confidence,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		inputManifestDigest: contract.inputManifest.manifestDigest,
		splitClosureRoots: contract.inputManifest.splitClosureRoots,
	});
}

type HostContext = Pick<
	AutoResearchPortfolioAdmissionInput,
	"receiptContext" | "workflowId" | "currentStateDigest" | "currentRevision" | "currentEpochRef" | "trustedNow"
>;

function hostContext(): HostContext {
	return {
		receiptContext: createFixtureHostReceiptConsumerContext(),
		workflowId: WORKFLOW_ID,
		currentStateDigest: STATE_DIGEST,
		currentRevision: 1,
		currentEpochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
		trustedNow: TRUSTED_NOW,
	};
}

function receiptArtifactRef(id: string): WorkflowArtifactRef {
	return {
		artifactId: id,
		relativePath: `frontier/${id}`,
		digest: DIGEST,
		sizeBytes: 0,
		sourceEventSequence: 1,
	};
}

function candidateReviewBindingDigestForTest(candidateValue: AutoResearchPortfolioCandidate): string {
	return digestObject({
		candidateId: candidateValue.candidateId,
		goalIds: [...candidateValue.goalIds].sort((left, right) => left.localeCompare(right)),
		solutionFamily: candidateValue.solutionFamily,
		ancestry: candidateValue.ancestry,
		causalMechanism: candidateValue.causalMechanism,
		change: {
			kind: candidateValue.change.kind,
			changedPaths: [...candidateValue.change.changedPaths].sort((left, right) => left.localeCompare(right)),
			parameterChanges: [...candidateValue.change.parameterChanges].sort((left, right) => left.localeCompare(right)),
			changeDigest: candidateValue.change.changeDigest,
		},
		scope: candidateValue.scope,
	});
}

function candidateHistoryDigestForTest(candidates: readonly AutoResearchPortfolioCandidate[]): string {
	return digestObject(
		candidates
			.map((candidateValue) => ({
				candidateId: candidateValue.candidateId,
				reviewBindingDigest: candidateReviewBindingDigestForTest(candidateValue),
			}))
			.sort(
				(left, right) =>
					left.candidateId.localeCompare(right.candidateId) ||
					left.reviewBindingDigest.localeCompare(right.reviewBindingDigest),
			),
	);
}

function hostEvidenceReceipt(
	receiptKind: "capability",
	receiptId: string,
	bindingDigest: string,
	oneUse = false,
	issuedAt = TRUSTED_NOW,
	payloadDigest = DIGEST,
	resourceDigest = digestObject(contract),
): WorkflowVerifiedHostReceipt {
	return createFixtureHostReceipt({
		receiptKind,
		receiptId,
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest,
		payloadDigest,
		artifactRef: receiptArtifactRef(receiptId),
		issuedAt,
		validUntil: VALID_UNTIL,
		keyId: "fixture-receipt-key",
		stateDigest: STATE_DIGEST,
		revision: 1,
		oneUse,
		capabilityBinding: {
			capability: "autoresearch_portfolio_frontier_admission",
			resourceDigest,
			operationDigest: bindingDigest,
			executionIdentity: null,
			sessionId: null,
		},
	});
}

function decisionRefForTest(
	inputValue: Pick<AutoResearchPortfolioAdmissionInput, "workflowId" | "currentEpochRef">,
	id: string,
) {
	return {
		decisionScope: { kind: "workflow" as const, workflowId: inputValue.workflowId, rootSessionId: "portfolio-root" },
		decisionId: id,
		revision: 1,
		storeEpoch: inputValue.currentEpochRef.storeEpoch,
		coordinatorEpoch: inputValue.currentEpochRef.coordinatorEpoch,
		decisionDigest: DIGEST,
	};
}

function userAuthorityForTest(
	purpose: "tradeoff" | "preregistration",
	bindingDigest: string,
	inputValue: Pick<AutoResearchPortfolioAdmissionInput, "workflowId" | "currentStateDigest" | "currentEpochRef"> = {
		workflowId: WORKFLOW_ID,
		currentStateDigest: STATE_DIGEST,
		currentEpochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
	},
): AutoResearchPortfolioTradeoffAuthorization["userAuthority"] {
	const clockBindingDigest = digestObject({
		kind: "portfolio.user-authority.clock.v1",
		purpose,
		workflowId: inputValue.workflowId,
		stateDigest: inputValue.currentStateDigest,
		bindingDigest,
	});
	const trustedClockReceipt = createFixtureHostReceipt({
		receiptKind: "clock",
		receiptId: `clock-${purpose}`,
		issuerId: "fixture-host",
		workflowId: inputValue.workflowId,
		bindingDigest: clockBindingDigest,
		payloadDigest: bindingDigest,
		artifactRef: receiptArtifactRef(`clock-${purpose}`),
		issuedAt: TRUSTED_NOW,
		validUntil: VALID_UNTIL,
		keyId: "fixture-receipt-key",
		stateDigest: inputValue.currentStateDigest,
		revision: 1,
		oneUse: false,
	});
	const decisionRef = decisionRefForTest(inputValue, `decision-${purpose}`);
	const decisionRoles = { goal: decisionRef, scorecard: decisionRef, resource: decisionRef };
	const decisionRefs = [decisionRef];
	const approval = {
		approvalRequestId: `approval-${purpose}`,
		workflowId: inputValue.workflowId,
		decisionRef,
		decisionRefs,
		headDigest: inputValue.currentStateDigest,
		stateDigest: inputValue.currentStateDigest,
		configDigest: DIGEST,
		profileDigest: DIGEST,
		artifactDigest: DIGEST,
		storeEpoch: inputValue.currentEpochRef.storeEpoch,
		coordinatorEpoch: inputValue.currentEpochRef.coordinatorEpoch,
		clientSessionId: "user-session",
		trustedPrincipal: { kind: "headless_signer" as const, principalId: "user", credentialDigest: DIGEST },
		responseSequence: 1,
		optionId: purpose,
		decisionRoles,
		effectDigest: bindingDigest,
		mode: "signed_headless" as const,
		responseDigest: DIGEST,
		consumedAt: TRUSTED_NOW,
		consumptionEventSequence: 1,
		trustedClockReceipt,
	};
	const decisionContextBindingDigest = digestObject({
		kind: "portfolio.user-authority.decision-context.v1",
		purpose,
		bindingDigest,
		workflowId: inputValue.workflowId,
		stateDigest: inputValue.currentStateDigest,
		currentRevision: 1,
		currentEpochRef: inputValue.currentEpochRef,
		approvalRequestId: approval.approvalRequestId,
		decisionRef,
		decisionRefs,
		decisionRoles,
	});
	const decisionContextPayloadDigest = digestObject({
		kind: "portfolio.user-authority.decision-context-payload.v1",
		approvalDigest: digestObject(approval),
		decisionRef,
		decisionRefs,
		decisionRoles,
	});
	const decisionContext = {
		decisionRef,
		decisionRefs,
		decisionRoles,
		hostReceipt: createFixtureHostReceipt({
			receiptKind: "decision",
			receiptId: `decision-context-${purpose}`,
			issuerId: "fixture-host",
			workflowId: inputValue.workflowId,
			bindingDigest: decisionContextBindingDigest,
			payloadDigest: decisionContextPayloadDigest,
			artifactRef: receiptArtifactRef(`decision-context-${purpose}`),
			issuedAt: TRUSTED_NOW,
			validUntil: VALID_UNTIL,
			keyId: "fixture-receipt-key",
			stateDigest: inputValue.currentStateDigest,
			revision: 1,
			oneUse: false,
		}),
	};
	return {
		approval: approval as never,
		decisionContext,
		authorityDigest: digestObject({
			kind: "portfolio.user-authority.v1",
			purpose,
			bindingDigest,
			approvalDigest: digestObject(approval),
			principal: approval.trustedPrincipal,
			optionId: approval.optionId,
			workflowId: inputValue.workflowId,
			stateDigest: inputValue.currentStateDigest,
			currentEpochRef: inputValue.currentEpochRef,
			decisionContextDigest: digestObject(decisionContext),
		}),
	};
}

function immutableRunArtifactRefForTest(id: string): WorkflowArtifactRef {
	return createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: `run-artifact-${id}`,
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: DIGEST,
		payloadDigest: DIGEST,
		artifactRef: receiptArtifactRef(`run-artifact-${id}`),
		issuedAt: TRUSTED_NOW,
		validUntil: VALID_UNTIL,
		keyId: "fixture-receipt-key",
		stateDigest: STATE_DIGEST,
		revision: 1,
		oneUse: false,
	}).artifactRef;
}

function manifestBindingDigestForTest(contractValue: AutoResearchPortfolioContract): string {
	return digestObject({
		kind: "portfolio.input-manifest.v1",
		contractDigest: digestObject(contractValue),
		payload: {
			manifestDigest: contractValue.inputManifest.manifestDigest,
			evaluationEpoch: contractValue.inputManifest.evaluationEpoch,
			manifestRevision: contractValue.inputManifest.manifestRevision,
			closureRootDigest: contractValue.inputManifest.closureRootDigest,
			splitClosureRoots: contractValue.inputManifest.splitClosureRoots,
			splitBoundaryPolicyDigest: contractValue.inputManifest.splitBoundaryPolicy.policyDigest,
		},
	});
}

function manifestArtifactBindingDigestForTest(
	contractValue: AutoResearchPortfolioContract,
	split: "training" | "validation" | "holdout",
	objectUri: string,
): string {
	const artifactValue = contractValue.inputManifest[split].artifacts.find((entry) => entry.objectUri === objectUri)!;
	return digestObject({
		kind: "portfolio.input-artifact.v1",
		contractDigest: digestObject(contractValue),
		payload: {
			split,
			objectUri,
			generation: artifactValue.generation,
			schemaVersion: artifactValue.schemaVersion,
			bytes: artifactValue.bytes,
			sha256: artifactValue.sha256,
			closureRootDigest: artifactValue.closureRootDigest,
			modality: artifactValue.modality,
			instrumentSet: artifactValue.instrumentSet,
			validationResult: artifactValue.validationResult,
			coverage: artifactValue.coverage,
			gapClassification: artifactValue.gapClassification,
			lifecycle: artifactValue.lifecycle,
			sourceTimeStart: artifactValue.sourceTimeStart,
			sourceTimeEnd: artifactValue.sourceTimeEnd,
			provenance: artifactValue.provenance,
			restoreVerification: artifactValue.restoreVerification,
			accessAuthority: artifactValue.accessAuthority,
		},
	});
}

function manifestArtifactPayloadDigestForTest(
	contractValue: AutoResearchPortfolioContract,
	split: "training" | "validation" | "holdout",
	objectUri: string,
): string {
	const artifactValue = contractValue.inputManifest[split].artifacts.find((entry) => entry.objectUri === objectUri)!;
	return digestObject({
		kind: "portfolio.input-artifact-evidence.v1",
		bindingDigest: manifestArtifactBindingDigestForTest(contractValue, split, objectUri),
		artifact: artifactValue,
	});
}

function measurementBindingDigestForTest(
	contractValue: AutoResearchPortfolioContract,
	row: AutoResearchPortfolioMeasurement,
	run: {
		readonly runIndex: number;
		readonly artifactRef: WorkflowArtifactRef;
		readonly seedDigest: string;
		readonly contentDigest: string;
		readonly metricValues: readonly { readonly metricId: string; readonly value: number }[];
	},
): string {
	return digestObject({
		kind: "portfolio.measurement.v1",
		contractDigest: digestObject(contractValue),
		payload: {
			measurementId: row.measurementId,
			measurementDigest: row.measurementDigest,
			candidateId: row.candidateId,
			repeatIndex: row.repeatIndex,
			runIndex: run.runIndex,
			artifactRef: run.artifactRef,
			seedDigest: run.seedDigest,
			contentDigest: run.contentDigest,
			metricValues: [...run.metricValues].sort((left, right) => left.metricId.localeCompare(right.metricId)),
			evaluationEpoch: row.evaluationEpoch,
			inputManifestDigest: row.inputManifestDigest,
			splitClosureRoots: row.splitClosureRoots,
		},
	});
}

function tradeoffAuthorization(
	candidateId: string,
	competingGoalIds: readonly string[],
	receiptId: string,
	floorValues: ReadonlyMap<string, number> = new Map(),
): AutoResearchPortfolioTradeoffAuthorization {
	const body = {
		concessions: [...competingGoalIds],
		floors: competingGoalIds.map((goalId) => ({ goalId, value: floorValues.get(goalId) ?? 0 })),
		evidenceIds: ["quality.score-1"],
		selectedFrontierEntryIds: [] as string[],
	};
	const bindingDigest = digestObject({
		kind: "portfolio.frontier.tradeoff.v1",
		contractDigest: digestObject(contract),
		impactClosureDigest: deriveAutoResearchPortfolioImpactClosure(contract, candidate()).impactClosureDigest,
		candidateId,
		competingGoalIds: [...competingGoalIds].sort((left, right) => left.localeCompare(right)),
		concessions: [...body.concessions].sort((left, right) => left.localeCompare(right)),
		floors: [...body.floors].sort((left, right) => left.goalId.localeCompare(right.goalId)),
		evidenceIds: [...body.evidenceIds].sort((left, right) => left.localeCompare(right)),
		evidence: [
			{
				measurementId: "quality.score-1",
				measurementDigest: measurement("quality.score", 0.7).measurementDigest,
			},
		],
		candidateMeasurements: [
			...goodMeasurements()
				.map((row) => (row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row))
				.map((row) => ({ measurementId: row.measurementId, measurementDigest: row.measurementDigest }))
				.sort((left, right) => left.measurementId.localeCompare(right.measurementId)),
		],
		selectedFrontierEntryIds: [...body.selectedFrontierEntryIds].sort((left, right) => left.localeCompare(right)),
		selectedFrontierEntries: [],
	});
	const receipt = createFixtureHostReceipt({
		receiptKind: "capability",
		receiptId,
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest,
		payloadDigest: DIGEST,
		artifactRef: receiptArtifactRef(receiptId),
		issuedAt: TRUSTED_NOW,
		validUntil: VALID_UNTIL,
		keyId: "fixture-receipt-key",
		stateDigest: STATE_DIGEST,
		revision: 1,
		oneUse: true,
		capabilityBinding: {
			capability: "autoresearch_portfolio_frontier_admission",
			resourceDigest: digestObject(contract),
			operationDigest: bindingDigest,
			executionIdentity: null,
			sessionId: null,
		},
	});
	return {
		candidateId,
		competingGoalIds,
		...body,
		userAuthority: userAuthorityForTest("tradeoff", bindingDigest),
		receipt,
	};
}

function input(
	candidateValue: AutoResearchPortfolioCandidate,
	measurements: readonly AutoResearchPortfolioMeasurement[],
	frontier: readonly AutoResearchPortfolioCandidate[] = [],
	decision?: AutoResearchPortfolioTradeoffAuthorization,
	priorCandidates: readonly AutoResearchPortfolioCandidate[] = [],
	host: HostContext = hostContext(),
	contractValue: AutoResearchPortfolioContract = contract,
): AutoResearchPortfolioAdmissionInput {
	const historyCandidates = [...priorCandidates, ...frontier];
	const historyDigest = candidateHistoryDigestForTest(historyCandidates);
	const historyBindingDigest = digestObject({
		kind: "portfolio.candidate-history.v1",
		contractDigest: digestObject(contractValue),
		payload: {
			historyDigest,
			evaluationEpoch: contractValue.inputManifest.evaluationEpoch,
			manifestRevision: contractValue.inputManifest.manifestRevision,
			closureRootDigest: contractValue.inputManifest.closureRootDigest,
		},
	});
	const boundaryEvidence: AutoResearchPortfolioBoundaryEvidence[] = contractValue.hardBoundaries.map((boundary) => ({
		boundaryId: boundary.boundaryId,
		receipt: hostEvidenceReceipt(
			"capability",
			`boundary-${boundary.boundaryId}`,
			digestObject({
				kind: "portfolio.boundary.v1",
				contractDigest: digestObject(contractValue),
				payload: { boundaryId: boundary.boundaryId, passed: true },
			}),
			false,
			TRUSTED_NOW,
			DIGEST,
			digestObject(contractValue),
		),
	}));
	const invariantEvidence: AutoResearchPortfolioInvariantEvidence[] = contractValue.invariants
		.filter((invariant) => invariant.scope === "terminal")
		.map((invariant) => ({
			invariantId: invariant.invariantId,
			receipt: hostEvidenceReceipt(
				"capability",
				`invariant-${invariant.invariantId}`,
				digestObject({
					kind: "portfolio.invariant.v1",
					contractDigest: digestObject(contractValue),
					payload: { invariantId: invariant.invariantId, checkDigest: invariant.checkDigest, passed: true },
				}),
				false,
				TRUSTED_NOW,
				DIGEST,
				digestObject(contractValue),
			),
		}));
	const manifestEvidence = {
		manifestReceipt: hostEvidenceReceipt(
			"capability",
			"input-manifest",
			manifestBindingDigestForTest(contractValue),
			false,
			TRUSTED_NOW,
			contractValue.inputManifest.manifestDigest,
			digestObject(contractValue),
		),
		artifactReceipts: (["training", "validation", "holdout"] as const).flatMap((split) =>
			contractValue.inputManifest[split].artifacts.map((artifactValue) => ({
				split,
				objectUri: artifactValue.objectUri,
				receipt: hostEvidenceReceipt(
					"capability",
					`input-${split}-${artifactValue.objectUri}`,
					manifestArtifactBindingDigestForTest(contractValue, split, artifactValue.objectUri),
					false,
					TRUSTED_NOW,
					manifestArtifactPayloadDigestForTest(contractValue, split, artifactValue.objectUri),
					digestObject(contractValue),
				),
			})),
		),
	};
	const measurementEvidence = measurements.map((row) => ({
		measurementId: row.measurementId,
		runs: Array.from({ length: row.runCount }, (_, index) => {
			const runIndex = index + 1;
			const artifactRef = immutableRunArtifactRefForTest(`${row.measurementId}-${runIndex}`);
			const run = {
				runIndex,
				artifactRef,
				seedDigest: digestObject({ measurementId: row.measurementId, runIndex, seed: "fixture" }),
				contentDigest: artifactRef.digest,
				metricValues: row.vector.map((value) => ({ metricId: value.metricId, value: value.value })),
			};
			const receipt = hostEvidenceReceipt(
				"capability",
				`measurement-${row.measurementId}-${runIndex}`,
				measurementBindingDigestForTest(contractValue, row, run),
				false,
				TRUSTED_NOW,
				digestObject({
					measurementDigest: row.measurementDigest,
					runIndex,
					artifactRef,
					seedDigest: run.seedDigest,
					contentDigest: run.contentDigest,
					metricValues: [...run.metricValues].sort((left, right) => left.metricId.localeCompare(right.metricId)),
				}),
				digestObject(contractValue),
			);
			return { ...run, receipt };
		}),
	}));
	const preflight = preflightAutoResearchPortfolioCandidate({
		contract: contractValue,
		candidate: candidateValue,
		priorCandidates: historyCandidates,
	});
	return {
		contract: contractValue,
		candidate: candidateValue,
		measurements,
		frontier,
		candidateHistory: {
			candidates: historyCandidates,
			historyDigest,
			receipt: hostEvidenceReceipt(
				"capability",
				"candidate-history",
				historyBindingDigest,
				false,
				TRUSTED_NOW,
				historyDigest,
				digestObject(contractValue),
			),
		},
		preflight,
		boundaryEvidence,
		invariantEvidence,
		manifestEvidence,
		measurementEvidence,
		selectedFrontierEntryIds: frontier.map((entry) => entry.candidateId),
		...host,
		tradeoffAuthorization: decision,
	};
}

function preregistrationFor(
	inputValue: AutoResearchPortfolioAdmissionInput,
	metricIds: readonly string[],
	receiptId: string,
	registeredAt = "2026-08-17T11:00:00.000Z",
): AutoResearchPortfolioAdmissionInput["preregistration"] {
	const observationHeadDigest = digestObject({
		kind: "portfolio.preregistration-head.v1",
		contractDigest: digestObject(inputValue.contract),
		candidateId: inputValue.candidate.candidateId,
		historyDigest: candidateHistoryDigestForTest(inputValue.candidateHistory.candidates),
		frontierCandidateIds: [...new Set(inputValue.frontier.map((entry) => entry.candidateId))].sort((left, right) =>
			left.localeCompare(right),
		),
		evaluationEpoch: inputValue.contract.inputManifest.evaluationEpoch,
		manifestRevision: inputValue.contract.inputManifest.manifestRevision,
		closureRootDigest: inputValue.contract.inputManifest.closureRootDigest,
	});
	const preregistration = {
		candidateId: inputValue.candidate.candidateId,
		metricIds,
		evaluationEpoch: inputValue.contract.inputManifest.evaluationEpoch,
		observationHeadDigest,
		registeredAt,
		receipt: undefined as unknown as WorkflowVerifiedHostReceipt,
	};
	const bindingDigest = digestObject({
		kind: "portfolio.preregistration.v1",
		contractDigest: digestObject(inputValue.contract),
		payload: {
			candidateId: preregistration.candidateId,
			metricIds: [...metricIds].sort((left, right) => left.localeCompare(right)),
			evaluationEpoch: preregistration.evaluationEpoch,
			observationHeadDigest,
			registeredAt,
		},
	});
	const receipt = hostEvidenceReceipt(
		"capability",
		receiptId,
		bindingDigest,
		true,
		registeredAt,
		observationHeadDigest,
	);
	return {
		...preregistration,
		userAuthority: userAuthorityForTest("preregistration", bindingDigest, inputValue),
		receipt: createFixtureHostReceipt({
			...receipt,
			capabilityBinding: {
				capability: "autoresearch_portfolio_frontier_admission",
				resourceDigest: digestObject(inputValue.contract),
				operationDigest: bindingDigest,
				executionIdentity: null,
				sessionId: null,
			},
		}),
	};
}

function goodMeasurements(): readonly AutoResearchPortfolioMeasurement[] {
	return [
		measurement("latency.p50", 90),
		measurement("cost.total", 8),
		measurement("quality.score", 0.84),
		measurement("safety.errors", 0),
		measurement("memory.bytes", 950),
	];
}

describe("schema-v3 portfolio frontier admission", () => {
	it("derives every host-owned impact category and stable digest", () => {
		const closure = deriveAutoResearchPortfolioImpactClosure(contract, candidate());
		expect(closure.intendedGoalIds).toEqual(["latency"]);
		expect(closure.dependentGoalIds).toEqual(["cost", "memory"]);
		expect(closure.competingGoalIds).toEqual(["quality"]);
		expect(closure.conflictRelatedGoalIds).toEqual(["safety"]);
		expect(closure.goalIds).toEqual(["cost", "latency", "memory", "quality", "safety"]);
		expect(closure.metricIds).toEqual([
			"cost.total",
			"latency.p50",
			"memory.bytes",
			"quality.score",
			"safety.errors",
		]);
		expect(closure.impactClosureDigest).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("includes reverse relation impact in the host closure", () => {
		const reverseCandidate = { ...candidate(), goalIds: ["cost"] };
		const closure = deriveAutoResearchPortfolioImpactClosure(contract, reverseCandidate);
		expect(closure.goalIds).toContain("latency");
		expect(closure.dependentGoalIds).toContain("latency");
	});

	it("rejects contradictory relations regardless of direction", async () => {
		expect(() =>
			canonicalContractRecord({
				...(structuredClone(contract) as AutoResearchPortfolioContract),
				goalRelations: [
					...contract.goalRelations,
					{ fromGoalId: "quality", toGoalId: "latency", relation: "complementary", rationale: "contradiction" },
				],
			}),
		).toThrow(/reverse dependency and tradeoff relations are contradictory/u);
	});

	it("rejects non-canonical candidate and measurement records before admission", async () => {
		const uncanonicalCandidate = { ...candidate(), extra: "caller-field" } as never;
		const candidateResult = await evaluateAutoResearchPortfolioAdmission(
			input(uncanonicalCandidate, goodMeasurements()),
		);
		expect(candidateResult.accepted).toBe(false);
		expect(candidateResult.reasons).toContain("candidate_not_canonical");
		const uncanonicalMeasurements = goodMeasurements().map((row, index) =>
			index === 0 ? ({ ...row, extra: "caller-field" } as never) : row,
		);
		const measurementResult = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), uncanonicalMeasurements),
		);
		expect(measurementResult.accepted).toBe(false);
		expect(measurementResult.reasons).toContain("measurement_not_canonical");
	});

	it("rejects stitched repeat rows instead of assembling a false vector", async () => {
		const stitched = goodMeasurements().map((row) =>
			row.vector[0].metricId === "cost.total" ? measurement("cost.total", 8, { repeatIndex: 2 }) : row,
		);
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), stitched));
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("candidate_measurement_stitching");
	});

	it("rejects dependent-goal regressions even when the prerequisite improves", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "cost.total" ? measurement("cost.total", 12) : row,
		);
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), rows));
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("dependent_regression");
	});

	it("rejects intervals wider than the locked global uncertainty budget", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "latency.p50"
				? measurement("latency.p50", 90, {
						confidenceInterval: { lower: 89, upper: 91, level: 1 },
						variance: 0,
						runCount: 5,
						sampleCount: 5,
					})
				: row,
		);
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), rows));
		expect(result.accepted).toBe(false);
		expect(
			result.reasons.some((reason) =>
				["host_measurement_uncertainty_invalid", "host_measurement_repeatability_invalid"].includes(reason),
			),
		).toBe(true);
	});

	it("rejects a row aggregation that differs from the locked repeatability rule", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "latency.p50" ? measurement("latency.p50", 90, { aggregation: "mean" }) : row,
		);
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), rows));
		let executorCalls = 0;
		if (result.executorAllowed) executorCalls += 1;
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("host_measurement_repeatability_invalid");
		expect(executorCalls).toBe(0);
	});

	it("admits a conservative dominant candidate without a weighted score", async () => {
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), goodMeasurements()));
		expect(result.accepted).toBe(true);
		expect(result.automaticPromotion).toBe(true);
		expect(result.frontierMembership).toBe("retained");
		expect(result.executorAllowed).toBe(true);
		expect(Object.keys(result)).not.toContain("score");
		expect(result.vector).toEqual(["latency.p50", "safety.errors", "cost.total", "memory.bytes", "quality.score"]);
	});

	it("rejects unfavorable metric omission before the executor", async () => {
		const rows = goodMeasurements().filter((row) => row.vector[0].metricId !== "cost.total");
		let executorCalls = 0;
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), rows));
		if (result.executorAllowed) executorCalls += 1;
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("candidate_metric_omission");
		expect(executorCalls).toBe(0);
	});

	it("gates hard-boundary success bypasses before any metric", async () => {
		const result = await evaluateAutoResearchPortfolioAdmission({
			...input(candidate(), goodMeasurements()),
			boundaryEvidence: [],
		});
		expect(result.accepted).toBe(false);
		expect(result.executorAllowed).toBe(false);
		expect(result.reasons.some((reason) => reason.startsWith("hard_boundary_"))).toBe(true);
		const callerBoolean = await evaluateAutoResearchPortfolioAdmission({
			...input(candidate(), goodMeasurements()),
			boundaryEvidence: [{ boundaryId: "scope", passed: true } as never],
		});
		expect(callerBoolean.accepted).toBe(false);
		expect(callerBoolean.reasons).toContain("boundary_evidence_invalid");
		expect(callerBoolean.executorAllowed).toBe(false);
	});

	it("requires resolver-verified invariant evidence before the executor", async () => {
		const base = input(candidate(), goodMeasurements());
		const missing = await evaluateAutoResearchPortfolioAdmission({ ...base, invariantEvidence: [] });
		let executorCalls = 0;
		if (missing.executorAllowed) executorCalls += 1;
		expect(missing.accepted).toBe(false);
		expect(missing.reasons).toContain("invariant_evidence_missing:safety-invariant");
		expect(executorCalls).toBe(0);
		const forgedReceipt = {
			...base.invariantEvidence[0]!.receipt,
			signature: "forged-signature",
		};
		const forged = await evaluateAutoResearchPortfolioAdmission({
			...base,
			invariantEvidence: [{ invariantId: "safety-invariant", receipt: forgedReceipt }],
		});
		expect(forged.accepted).toBe(false);
		expect(forged.reasons).toContain("invariant_evidence_failed:safety-invariant");
		expect(forged.executorAllowed).toBe(false);
	});

	it("rejects a caller-rewritten history digest before any executor", async () => {
		const base = input(candidate(), goodMeasurements());
		const result = await evaluateAutoResearchPortfolioAdmission({
			...base,
			candidateHistory: { ...base.candidateHistory, historyDigest: "f".repeat(64) },
		});
		let executorCalls = 0;
		if (result.executorAllowed) executorCalls += 1;
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("history_digest_mismatch");
		expect(result.executorAllowed).toBe(false);
		expect(executorCalls).toBe(0);
	});

	it("rejects split, provenance, holdout, epoch, and host-binding mutations", async () => {
		const manifest = contract.inputManifest;
		const mutations: readonly { readonly mutated: AutoResearchPortfolioContract; readonly reason: string }[] = [
			{
				mutated: {
					...contract,
					inputManifest: {
						...manifest,
						training: {
							...manifest.training,
							artifacts: [{ ...manifest.training.artifacts[0], coverage: "provider_empty" }],
						},
					},
				} as AutoResearchPortfolioContract,
				reason: "provider_empty",
			},
			{
				mutated: {
					...contract,
					inputManifest: {
						...manifest,
						validation: {
							...manifest.validation,
							artifacts: [{ ...manifest.validation.artifacts[0], coverage: "partial_coverage" }],
						},
					},
				} as AutoResearchPortfolioContract,
				reason: "partial_coverage",
			},
			{
				mutated: {
					...contract,
					inputManifest: {
						...manifest,
						holdout: {
							...manifest.holdout,
							artifacts: [{ ...manifest.holdout.artifacts[0], coverage: "unknown" }],
						},
					},
				} as AutoResearchPortfolioContract,
				reason: "unknown_or_missing",
			},
			{
				mutated: {
					...contract,
					inputManifest: {
						...manifest,
						modelAccess: { ...manifest.modelAccess, holdoutRowsVisible: true },
					},
				} as unknown as AutoResearchPortfolioContract,
				reason: "holdout_evidence_exposed",
			},
			{
				mutated: {
					...contract,
					inputManifest: {
						...manifest,
						splitClosureRoots: { ...manifest.splitClosureRoots, validation: "e".repeat(64) },
					},
				} as AutoResearchPortfolioContract,
				reason: "closure_root_binding_mismatch",
			},
			{
				mutated: {
					...contract,
					inputManifest: { ...manifest, evaluationEpoch: 2, manifestRevision: 2 },
				} as AutoResearchPortfolioContract,
				reason: "evaluation_epoch_mismatch",
			},
		];
		for (const mutation of mutations) {
			const candidateValue = candidate();
			const result = await evaluateAutoResearchPortfolioAdmission({
				...input(candidateValue, goodMeasurements(), [], undefined, [], hostContext(), mutation.mutated),
			});
			expect(result.accepted, mutation.reason).toBe(false);
			expect(result.executorAllowed, mutation.reason).toBe(false);
			expect(
				result.reasons.includes(mutation.reason) || result.reasons.includes("contract_not_canonical"),
				mutation.reason,
			).toBe(true);
		}
		const unboundMeasurement = goodMeasurements().map((row) =>
			row.vector[0].metricId === "latency.p50" ? { ...row, inputDigest: "f".repeat(64) } : row,
		);
		const unbound = await evaluateAutoResearchPortfolioAdmission(input(candidate(), unboundMeasurement));
		expect(unbound.accepted).toBe(false);
		expect(
			unbound.reasons.includes("input_manifest_binding_mismatch") ||
				unbound.reasons.includes("measurement_not_canonical"),
		).toBe(true);
	});

	it("rejects repeated families, parameter sweeps, and mechanism aliases", async () => {
		const prior = candidate("prior", "family-used", "mechanism-used");
		const cases = [
			{ candidate: candidate("candidate-good", "family-used"), reason: "repeated_family" },
			{ candidate: candidate("candidate-good", "family-renamed", "mechanism-new"), reason: "repeated_family" },
			{
				candidate: { ...candidate(), change: { ...candidate().change, parameterChanges: ["threshold"] } },
				reason: "parameter_sweep",
			},
			{
				candidate: {
					...candidate(),
					causalMechanism: {
						...candidate().causalMechanism,
						hypothesis: "parameter sweep disguised as mechanism",
					},
				},
				reason: "parameter_sweep",
			},
			{ candidate: candidate("candidate-good", "new-family", "mechanism-used"), reason: "mechanism_alias" },
		] as const;
		for (const current of cases) {
			let executorCalls = 0;
			const result = await evaluateAutoResearchPortfolioAdmission({
				...input(current.candidate, goodMeasurements(), [], undefined, [prior]),
			});
			if (result.executorAllowed) executorCalls += 1;
			expect(result.accepted).toBe(false);
			expect(result.reasons.includes(current.reason) || result.reasons.includes("candidate_not_canonical")).toBe(
				true,
			);
			expect(executorCalls).toBe(0);
		}
	});

	it("requires the exact host preflight digest before measurement admission", async () => {
		const base = input(candidate(), goodMeasurements());
		const forgedPreflight = {
			...base.preflight,
			reviewBindingDigest: "f".repeat(64),
		};
		const result = await evaluateAutoResearchPortfolioAdmission({
			...base,
			preflight: forgedPreflight,
		});
		expect(result.accepted).toBe(false);
		expect(result.executorAllowed).toBe(false);
		expect(result.reasons).toContain("preflight_digest_mismatch");
	});

	it("rejects lucky runs, overlapping intervals, and excess variance", async () => {
		const noisy = goodMeasurements().map((row) =>
			row.vector[0].metricId === "latency.p50"
				? measurement("latency.p50", 90, {
						confidenceInterval: { lower: 80, upper: 100, level: 1 },
						variance: 50,
						runCount: 1,
						sampleCount: 1,
					})
				: row,
		);
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), noisy));
		expect(result.accepted).toBe(false);
		expect(
			result.reasons.some((reason) =>
				[
					"host_measurement_uncertainty_invalid",
					"host_measurement_repeatability_invalid",
					"measurement_run_set_invalid",
					"interval_not_separated",
					"variance_exceeds_limit",
					"repeatability_insufficient",
				].includes(reason),
			),
		).toBe(true);
	});

	it("aggregates distinct repeat rows but rejects same-repeat duplication", async () => {
		const repeated = goodMeasurements().flatMap((row) =>
			[1, 2, 3].map((repeatIndex) => {
				const vector = row.vector[0];
				return measurement(vector.metricId, vector.value, { repeatIndex });
			}),
		);
		const admitted = await evaluateAutoResearchPortfolioAdmission(input(candidate(), repeated));
		expect(admitted.accepted).toBe(true);
		const duplicate = await evaluateAutoResearchPortfolioAdmission(input(candidate(), [...repeated, repeated[0]]));
		expect(duplicate.accepted).toBe(false);
		expect(duplicate.reasons).toContain("duplicate_metric_measurement");
	});

	it("never regresses a higher lexicographic tier", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "latency.p50" ? measurement("latency.p50", 110) : row,
		);
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), rows));
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("lexicographic_regression");
	});

	it("requires a verified consumed host receipt for competing tradeoffs", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const unsigned = await evaluateAutoResearchPortfolioAdmission(input(candidate(), rows));
		expect(unsigned.accepted).toBe(false);
		expect(unsigned.reasons).toContain("unsigned_tradeoff");
		const host = hostContext();
		const authorized = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], tradeoffAuthorization("candidate-good", ["quality"], "receipt-1"), [], host),
		);
		console.log("frontier-debug-result", authorized.reasons);
		expect(authorized.accepted).toBe(true);
		expect(authorized.automaticPromotion).toBe(false);
		expect(authorized.executorAllowed).toBe(false);
	});

	it("binds tradeoff authority to signed floors and relation-scoped evidence", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const authorization = tradeoffAuthorization("candidate-good", ["quality"], "floor-receipt");
		const forgedFloor = {
			...authorization,
			floors: [{ goalId: "quality", value: 0.8 }],
		};
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), rows, [], forgedFloor));
		let executorCalls = 0;
		if (result.executorAllowed) executorCalls += 1;
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("needs_authority");
		expect(executorCalls).toBe(0);
		const changedMeasurementRows = rows.map((row) =>
			row.vector[0].metricId === "latency.p50" ? measurement("latency.p50", 91) : row,
		);
		const changedMeasurement = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), changedMeasurementRows, [], authorization),
		);
		expect(changedMeasurement.accepted).toBe(false);
		expect(changedMeasurement.reasons).toContain("needs_authority");
	});

	it("rejects a tradeoff floor below the competing goal baseline", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const authorization = tradeoffAuthorization(
			"candidate-good",
			["quality"],
			"below-baseline-floor",
			new Map([["quality", 0.7]]),
		);
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), rows, [], authorization));
		expect(result.accepted).toBe(false);
		expect(result.executorAllowed).toBe(false);
		expect(result.reasons).toContain("needs_authority");
	});

	it("requires durable approval decision context instead of caller-recomputed fields", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const authorization = tradeoffAuthorization("candidate-good", ["quality"], "forged-decision-context");
		const approval = authorization.userAuthority.approval;
		const forgedApproval = { ...approval, decisionRef: { forged: true } };
		const forgedAuthority = {
			approval: forgedApproval,
			authorityDigest: digestObject({
				kind: "portfolio.user-authority.v1",
				purpose: "tradeoff",
				bindingDigest: authorization.receipt.bindingDigest,
				approvalDigest: digestObject(forgedApproval),
				principal: forgedApproval.trustedPrincipal,
				optionId: forgedApproval.optionId,
				workflowId: forgedApproval.workflowId,
				stateDigest: forgedApproval.stateDigest,
				currentEpochRef: {
					storeEpoch: forgedApproval.storeEpoch,
					coordinatorEpoch: forgedApproval.coordinatorEpoch,
				},
			}),
		};
		const result = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], { ...authorization, userAuthority: forgedAuthority as never }),
		);
		expect(result.accepted).toBe(false);
		expect(result.executorAllowed).toBe(false);
		expect(result.reasons).toContain("needs_authority");
	});

	it("does not consume tradeoff authority before final dominance checks", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const priorBase = candidate("prior", "prior-family", "prior-mechanism");
		const prior = parseAutoResearchPortfolioCandidate({
			...(structuredClone(priorBase) as AutoResearchPortfolioCandidate),
			solutionFamily: { ...priorBase.solutionFamily, name: "prior-cache", mechanismClass: "other-representation" },
			causalMechanism: {
				...priorBase.causalMechanism,
				hypothesis: "prior mechanism improves latency",
				intervention: "replace prior representation",
				expectedObservation: "prior latency improves",
				falsificationCondition: "prior latency does not improve",
			},
		});
		const priorRows = goodMeasurements().map((row) => {
			const metricId = row.vector[0].metricId;
			const priorValue =
				metricId === "latency.p50"
					? 90
					: metricId === "cost.total"
						? 8
						: metricId === "quality.score"
							? 0.8
							: metricId === "safety.errors"
								? 0
								: 950;
			return measurement(metricId, priorValue, {
				measurementId: `prior-${row.measurementId}`,
				candidateId: "prior",
				confidenceInterval: { lower: priorValue, upper: priorValue, level: 1 },
			});
		});
		const host = hostContext();
		const authorization = tradeoffAuthorization("candidate-good", ["quality"], "late-consume-receipt");
		const dominated = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), [...rows, ...priorRows], [prior], authorization, [], host),
		);
		expect(dominated.accepted).toBe(false);
		expect(dominated.reasons).toContain("dominated_by_frontier");
		const admitted = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], authorization, [], host),
		);
		expect(admitted.accepted).toBe(true);
	});

	it("rejects a forged tradeoff receipt before the executor", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const forged = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], {
				...tradeoffAuthorization("candidate-good", ["quality"], "forged-receipt"),
				receipt: {
					...tradeoffAuthorization("candidate-good", ["quality"], "forged-receipt").receipt,
					signature: "forged-signature",
				},
			}),
		);
		let executorCalls = 0;
		if (forged.executorAllowed) executorCalls += 1;
		expect(forged.accepted).toBe(false);
		expect(forged.executorAllowed).toBe(false);
		expect(forged.reasons).toContain("needs_authority");
		expect(executorCalls).toBe(0);
	});

	it("rejects forged, stale, or replayable user authority before the executor", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const authorization = tradeoffAuthorization("candidate-good", ["quality"], "user-authority-receipt");
		const forgedAuthority = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], {
				...authorization,
				userAuthority: { ...authorization.userAuthority, authorityDigest: "f".repeat(64) },
			}),
		);
		const staleClock = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], {
				...authorization,
				userAuthority: {
					...authorization.userAuthority,
					approval: {
						...authorization.userAuthority.approval,
						trustedClockReceipt: {
							...authorization.userAuthority.approval.trustedClockReceipt,
							validUntil: "2026-08-17T11:00:00.000Z",
						},
					},
				},
			}),
		);
		for (const result of [forgedAuthority, staleClock]) {
			expect(result.accepted).toBe(false);
			expect(result.executorAllowed).toBe(false);
			expect(result.reasons).toContain("needs_authority");
		}
	});

	it("rejects stale and replayed one-use tradeoff receipts", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const replayHost = hostContext();
		const decision = tradeoffAuthorization("candidate-good", ["quality"], "replay-receipt");
		const first = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], decision, [], replayHost),
		);
		expect(first.accepted).toBe(true);
		const replay = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], decision, [], replayHost),
		);
		expect(replay.accepted).toBe(false);
		expect(replay.reasons).toContain("needs_authority");
		const stale = tradeoffAuthorization("candidate-good", ["quality"], "stale-receipt");
		const staleDecision = {
			...stale,
			receipt: { ...stale.receipt, validUntil: "2026-08-17T11:00:00.000Z" },
		};
		const staleResult = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], staleDecision, [], hostContext()),
		);
		expect(staleResult.accepted).toBe(false);
		expect(staleResult.reasons).toContain("needs_authority");
	});

	it("keeps post-hoc gains exploratory until fresh preregistration", async () => {
		const rows = [...goodMeasurements(), measurement("explore.metric", 1)];
		const result = await evaluateAutoResearchPortfolioAdmission(input(candidate(), rows));
		let executorCalls = 0;
		if (result.executorAllowed) executorCalls += 1;
		expect(result.accepted).toBe(true);
		expect(result.exploratory).toBe(true);
		expect(result.automaticPromotion).toBe(false);
		expect(result.executorAllowed).toBe(false);
		expect(executorCalls).toBe(0);
		expect(result.reasons).toContain("posthoc_cross_goal_gain");
		const confirmed = await evaluateAutoResearchPortfolioAdmission({
			...(() => {
				const preregistered = input(candidate(), [...rows, measurement("explore.secondary", 1)]);
				return {
					...preregistered,
					preregistration: preregistrationFor(
						preregistered,
						["explore.metric", "explore.secondary"],
						"preregistration-1",
					),
				};
			})(),
		});
		expect(confirmed.exploratory).toBe(false);
		expect(confirmed.automaticPromotion).toBe(true);
	});

	it("does not promote a preregistration that omits a contract post-hoc metric", async () => {
		const rows = [...goodMeasurements(), measurement("explore.metric", 1)];
		const base = input(candidate(), rows);
		const result = await evaluateAutoResearchPortfolioAdmission({
			...base,
			preregistration: preregistrationFor(base, ["explore.metric"], "omitted-posthoc-metric"),
		});
		expect(result.accepted).toBe(true);
		expect(result.exploratory).toBe(true);
		expect(result.automaticPromotion).toBe(false);
		expect(result.executorAllowed).toBe(false);
		expect(result.reasons).toContain("posthoc_cross_goal_gain");
	});

	it("requires set-like preregistration evidence arrays to be canonical", async () => {
		const rows = [...goodMeasurements(), measurement("explore.metric", 1), measurement("explore.secondary", 1)];
		const base = input(candidate(), rows);
		const result = await evaluateAutoResearchPortfolioAdmission({
			...base,
			preregistration: preregistrationFor(base, ["explore.secondary", "explore.metric"], "unsorted-posthoc-metrics"),
		});
		expect(result.accepted).toBe(false);
		expect(result.automaticPromotion).toBe(false);
		expect(result.executorAllowed).toBe(false);
		expect(result.reasons).toContain("needs_authority");
	});

	it("retains an incomparable candidate without promoting it", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const host = hostContext();
		const result = await evaluateAutoResearchPortfolioAdmission(
			input(
				candidate(),
				rows,
				[],
				tradeoffAuthorization("candidate-good", ["quality"], "incomparable-receipt"),
				[],
				host,
			),
		);
		let executorCalls = 0;
		if (result.executorAllowed) executorCalls += 1;
		expect(result.accepted).toBe(true);
		expect(result.frontierMembership).toBe("none");
		expect(result.automaticPromotion).toBe(false);
		expect(result.executorAllowed).toBe(false);
		expect(executorCalls).toBe(0);
		expect(result.reasons).toContain("authorized_tradeoff_exploration");
	});

	it("promotes only when the candidate dominates an existing frontier point", async () => {
		const priorBase = candidate("prior", "prior-family", "prior-mechanism");
		const prior = parseAutoResearchPortfolioCandidate({
			...(structuredClone(priorBase) as AutoResearchPortfolioCandidate),
			solutionFamily: { ...priorBase.solutionFamily, name: "prior-cache", mechanismClass: "other-representation" },
			causalMechanism: {
				...priorBase.causalMechanism,
				hypothesis: "prior mechanism improves latency",
				intervention: "replace prior representation",
				expectedObservation: "prior latency improves",
				falsificationCondition: "prior latency does not improve",
			},
		});
		const priorRows = goodMeasurements().map((row) => {
			const metricId = row.vector[0].metricId;
			const baseline = metricTargets[metricId].baseline;
			return measurement(metricId, baseline, {
				measurementId: `prior-${row.measurementId}`,
				candidateId: "prior",
				confidenceInterval: { lower: baseline, upper: baseline, level: 1 },
			});
		});
		const result = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), [...goodMeasurements(), ...priorRows], [prior]),
		);
		expect(result.accepted).toBe(true);
		expect(result.automaticPromotion).toBe(true);
	});

	it("keeps frontier digest invariant under candidate reordering", async () => {
		const firstBase = candidate("a", "family-a", "mechanism-a");
		const first = parseAutoResearchPortfolioCandidate({
			...(structuredClone(firstBase) as AutoResearchPortfolioCandidate),
			solutionFamily: { ...firstBase.solutionFamily, name: "first-family", mechanismClass: "first-representation" },
		});
		const secondBase = candidate("b", "family-b", "mechanism-b");
		const second = parseAutoResearchPortfolioCandidate({
			...(structuredClone(secondBase) as AutoResearchPortfolioCandidate),
			solutionFamily: {
				...secondBase.solutionFamily,
				name: "second-family",
				mechanismClass: "second-representation",
			},
		});
		const forward = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), goodMeasurements(), [first, second]),
		);
		const reverse = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), goodMeasurements(), [second, first]),
		);
		expect(forward.frontierDigest).toBe(reverse.frontierDigest);
	});

	it("changes the frontier digest when a retained candidate binding changes", async () => {
		const first = candidate("a", "family-a", "mechanism-a");
		const changed = parseAutoResearchPortfolioCandidate({
			...(structuredClone(first) as AutoResearchPortfolioCandidate),
			solutionFamily: { ...first.solutionFamily, familyId: "family-a-changed" },
		});
		const original = await evaluateAutoResearchPortfolioAdmission(input(candidate(), goodMeasurements(), [first]));
		const mutated = await evaluateAutoResearchPortfolioAdmission(input(candidate(), goodMeasurements(), [changed]));
		expect(original.frontierDigest).not.toBe(mutated.frontierDigest);
	});

	it("rejects candidate paths that overlap host or immutable scope partitions", async () => {
		const hostPartitionContract = canonicalContractRecord({
			...(structuredClone(contract) as AutoResearchPortfolioContract),
			scopePartitions: [
				{ partitionId: "source", scope: "terminal", paths: ["src"], dataDigests: [DIGEST], mutableBy: "host" },
			],
		});
		const hostResult = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), goodMeasurements(), [], undefined, [], hostContext(), hostPartitionContract),
		);
		expect(hostResult.accepted).toBe(false);
		expect(hostResult.reasons).toContain("scope_partition_authority_violation");

		const immutablePartitionContract = canonicalContractRecord({
			...(structuredClone(contract) as AutoResearchPortfolioContract),
			scopePartitions: [
				{
					partitionId: "source",
					scope: "terminal",
					paths: ["src"],
					dataDigests: [DIGEST],
					mutableBy: "immutable",
				},
			],
		});
		const immutableResult = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), goodMeasurements(), [], undefined, [], hostContext(), immutablePartitionContract),
		);
		expect(immutableResult.accepted).toBe(false);
		expect(immutableResult.reasons).toContain("scope_partition_authority_violation");
	});

	it("rejects overlapping partition paths before evaluating metrics", async () => {
		const overlappingContract = canonicalContractRecord({
			...(structuredClone(contract) as AutoResearchPortfolioContract),
			scopePartitions: [
				{ partitionId: "source", scope: "terminal", paths: ["src"], dataDigests: [DIGEST], mutableBy: "candidate" },
				{
					partitionId: "nested-source",
					scope: "terminal",
					paths: ["src/cache.ts"],
					dataDigests: [DIGEST],
					mutableBy: "candidate",
				},
			],
		});
		const result = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), goodMeasurements(), [], undefined, [], hostContext(), overlappingContract),
		);
		let executorCalls = 0;
		if (result.executorAllowed) executorCalls += 1;
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("scope_partition_overlap");
		expect(executorCalls).toBe(0);
	});

	it("requires the exact frontier capability instead of trusting a signed issuer label", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const decision = tradeoffAuthorization("candidate-good", ["quality"], "wrong-capability-receipt");
		const capabilityMutated = {
			...decision.receipt,
			capabilityBinding: {
				capability: "portfolio_default_completion",
				resourceDigest: DIGEST,
				operationDigest: DIGEST,
				executionIdentity: null,
				sessionId: null,
			},
		};
		const result = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], { ...decision, receipt: capabilityMutated } as never),
		);
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("needs_authority");
		const missingAuthorizer = await evaluateAutoResearchPortfolioAdmission({
			...input(candidate(), goodMeasurements()),
			receiptContext: {
				...hostContext().receiptContext,
				principalAuthorizer: undefined,
			} as never,
		} as never);
		expect(missingAuthorizer.accepted).toBe(false);
		expect(missingAuthorizer.reasons).toContain("host_authorizer_unavailable");
	});

	it("returns a host-committable intent after atomically consuming one-use authority", async () => {
		const rows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const baseContext = hostContext();
		let consumeCalls = 0;
		const resolver = baseContext.receiptContext.receiptResolver;
		const receiptContext = {
			...baseContext.receiptContext,
			receiptResolver: {
				...resolver,
				consumeIfOneUse: async (...args: Parameters<typeof resolver.consumeIfOneUse>): Promise<void> => {
					consumeCalls += 1;
					await resolver.consumeIfOneUse(...args);
				},
			},
		};
		const result = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), rows, [], tradeoffAuthorization("candidate-good", ["quality"], "intent-only-receipt"), [], {
				...baseContext,
				receiptContext,
			} as never),
		);
		expect(result.accepted).toBe(true);
		expect(result.executorAllowed).toBe(false);
		expect(result.admissionIntent).toMatchObject({
			productionOrphaned: true,
			candidateId: "candidate-good",
		});
		expect(result.admissionIntent?.consumptionWitnesses).toHaveLength(1);
		expect(consumeCalls).toBe(1);
	});

	it("labels exploratory and authorized tradeoff retention as evidence-only", async () => {
		const postHoc = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), [...goodMeasurements(), measurement("explore.metric", 1)]),
		);
		expect(postHoc.accepted).toBe(true);
		expect(postHoc.retention).toBe("evidence_only_exploratory");
		expect(postHoc.executorAllowed).toBe(false);

		const tradeoffRows = goodMeasurements().map((row) =>
			row.vector[0].metricId === "quality.score" ? measurement("quality.score", 0.7) : row,
		);
		const tradeoff = await evaluateAutoResearchPortfolioAdmission(
			input(
				candidate(),
				tradeoffRows,
				[],
				tradeoffAuthorization("candidate-good", ["quality"], "retention-receipt"),
			),
		);
		expect(tradeoff.accepted).toBe(true);
		expect(tradeoff.retention).toBe("evidence_only_tradeoff");
		expect(tradeoff.executorAllowed).toBe(false);
	});

	it("requires resolver-verified measurement evidence for every unique run", async () => {
		const base = input(candidate(), goodMeasurements());
		const missing = await evaluateAutoResearchPortfolioAdmission({
			...base,
			measurementEvidence: [] as never,
		} as never);
		expect(missing.accepted).toBe(false);
		expect(missing.reasons).toContain("measurement_evidence_missing");
	});

	it("requires per-run metric values and recomputes each measurement aggregate", async () => {
		const rows = goodMeasurements();
		const base = input(candidate(), rows);
		const withRunValues = {
			...base,
			measurementEvidence: base.measurementEvidence.map((entry, entryIndex) => ({
				...entry,
				runs: entry.runs.map((run) => ({
					...run,
					metricValues: [rows[entryIndex]!.vector[0]!],
				})),
			})),
		};
		const result = await evaluateAutoResearchPortfolioAdmission(withRunValues as never);
		expect(result.accepted).toBe(true);
		expect(result.automaticPromotion).toBe(true);
	});

	it("rejects reused verified run receipts instead of accepting stitched evidence", async () => {
		const base = input(candidate(), goodMeasurements());
		const first = base.measurementEvidence[0]!;
		const reused = {
			...base,
			measurementEvidence: base.measurementEvidence.map((entry, index) =>
				index === 1 ? { ...entry, runs: first.runs } : entry,
			),
		};
		const result = await evaluateAutoResearchPortfolioAdmission(reused);
		let executorCalls = 0;
		if (result.executorAllowed) executorCalls += 1;
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("measurement_run_set_duplicate");
		expect(executorCalls).toBe(0);
	});

	it("rejects a forged manifest evidence receipt through the artifact resolver", async () => {
		const base = input(candidate(), goodMeasurements());
		const forged = await evaluateAutoResearchPortfolioAdmission({
			...base,
			manifestEvidence: {
				...base.manifestEvidence,
				manifestReceipt: { ...base.manifestEvidence.manifestReceipt, signature: "forged-signature" },
			},
		});
		expect(forged.accepted).toBe(false);
		expect(forged.reasons).toContain("manifest_evidence_failed");
		expect(forged.executorAllowed).toBe(false);
	});

	it("uses preregistered mechanism bindings instead of caller text labels", async () => {
		const candidateValue = candidate();
		const bindingDigest = digestObject({
			kind: "portfolio.mechanism-family.v1",
			contractDigest: digestObject(contract),
			payload: {
				familyId: candidateValue.solutionFamily.familyId,
				mechanismClass: candidateValue.solutionFamily.mechanismClass,
				mechanismDigest: candidateValue.causalMechanism.mechanismDigest,
				changeDigest: candidateValue.change.changeDigest,
			},
		});
		const registrationDigest = digestObject({
			familyId: candidateValue.solutionFamily.familyId,
			mechanismClass: candidateValue.solutionFamily.mechanismClass,
			mechanismDigest: candidateValue.causalMechanism.mechanismDigest,
			changeDigest: candidateValue.change.changeDigest,
			receiptId: "registered-family-receipt",
			receiptBindingDigest: bindingDigest,
		});
		const registration = {
			familyId: candidateValue.solutionFamily.familyId,
			mechanismClass: candidateValue.solutionFamily.mechanismClass,
			mechanismDigest: candidateValue.causalMechanism.mechanismDigest,
			changeDigest: candidateValue.change.changeDigest,
			receipt: hostEvidenceReceipt(
				"capability",
				"registered-family-receipt",
				bindingDigest,
				false,
				TRUSTED_NOW,
				registrationDigest,
			),
		};
		const result = preflightAutoResearchPortfolioCandidate({
			contract,
			candidate: candidateValue,
			priorCandidates: [],
			preregisteredFamilies: [registration],
		});
		expect(result.allowed).toBe(false);
		expect(result.reasons).toContain("preregistered_mechanism_family_reuse");
	});

	it("rejects a family registration that reuses mechanism and change digests", () => {
		const candidateValue = candidate();
		const registration = {
			familyId: "historic-family",
			mechanismClass: candidateValue.solutionFamily.mechanismClass,
			mechanismDigest: candidateValue.causalMechanism.mechanismDigest,
			changeDigest: candidateValue.change.changeDigest,
			receipt: hostEvidenceReceipt("capability", "historic-family-reuse", DIGEST),
		};
		const result = preflightAutoResearchPortfolioCandidate({
			contract,
			candidate: candidateValue,
			priorCandidates: [],
			preregisteredFamilies: [registration],
		});
		expect(result.allowed).toBe(false);
		expect(result.reasons).toContain("mechanism_alias");
	});

	it("dominates a frontier point without reusing the baseline minimum effect", async () => {
		const priorBase = candidate("frontier-reference", "reference-family", "e".repeat(64));
		const prior = parseAutoResearchPortfolioCandidate({
			...(structuredClone(priorBase) as AutoResearchPortfolioCandidate),
			solutionFamily: { ...priorBase.solutionFamily, name: "reference", mechanismClass: "other" },
			causalMechanism: {
				...priorBase.causalMechanism,
				hypothesis: "reference mechanism improves latency",
				intervention: "replace reference representation",
				expectedObservation: "reference latency improves",
				falsificationCondition: "reference latency does not improve",
			},
		});
		const priorValues: Readonly<Record<string, number>> = {
			"latency.p50": 92,
			"cost.total": 8.5,
			"quality.score": 0.83,
			"safety.errors": 0,
			"memory.bytes": 960,
		};
		const priorRows = goodMeasurements().map((row) => {
			const metricId = row.vector[0].metricId;
			const value = priorValues[metricId];
			return measurement(metricId, value, {
				measurementId: `frontier-${row.measurementId}`,
				candidateId: prior.candidateId,
			});
		});
		const result = await evaluateAutoResearchPortfolioAdmission(
			input(candidate(), [...goodMeasurements(), ...priorRows], [prior]),
		);
		expect(result.accepted).toBe(true);
		expect(result.automaticPromotion).toBe(true);
	});

	it("rejects every changed path that is not bound to one candidate partition", async () => {
		const mutatedCandidate = parseAutoResearchPortfolioCandidate({
			...(structuredClone(candidate()) as AutoResearchPortfolioCandidate),
			change: {
				...candidate().change,
				changedPaths: ["src/cache.ts", "docs/README.md"],
			},
		});
		const result = preflightAutoResearchPortfolioCandidate({
			contract,
			candidate: mutatedCandidate,
			priorCandidates: [],
		});
		expect(result.allowed).toBe(false);
		expect(result.reasons).toContain("scope_partition_unbound");
	});

	it("normalizes partition paths and rejects overlap within one partition", async () => {
		const overlappingContract = canonicalContractRecord({
			...(structuredClone(contract) as AutoResearchPortfolioContract),
			scopePartitions: [
				{
					partitionId: "source",
					scope: "terminal",
					paths: ["src/", "src/cache.ts"],
					dataDigests: [DIGEST],
					mutableBy: "candidate",
				},
			],
		});
		const preflight = preflightAutoResearchPortfolioCandidate({
			contract: overlappingContract,
			candidate: candidate(),
			priorCandidates: [],
		});
		expect(preflight.allowed).toBe(false);
		expect(preflight.reasons).toContain("scope_partition_overlap");

		const unnormalizedCandidate = parseAutoResearchPortfolioCandidate({
			...(structuredClone(candidate()) as AutoResearchPortfolioCandidate),
			change: { ...candidate().change, changedPaths: ["./src/cache.ts/"] },
		});
		const normalized = preflightAutoResearchPortfolioCandidate({
			contract,
			candidate: unnormalizedCandidate,
			priorCandidates: [],
		});
		expect(normalized.allowed).toBe(true);
	});

	it("requires principal authorization for ordinary boundary evidence", async () => {
		const base = hostContext();
		const unauthorized = await evaluateAutoResearchPortfolioAdmission({
			...input(candidate(), goodMeasurements()),
			receiptContext: {
				...base.receiptContext,
				principalAuthorizer: {
					authorize: async () => {
						throw new Error("ordinary evidence denied");
					},
				},
			},
		});
		expect(unauthorized.accepted).toBe(false);
		expect(unauthorized.reasons.some((reason) => reason.startsWith("hard_boundary_failed:"))).toBe(true);
	});

	it("rejects frontier candidates whose impact closure or selected entry set is not bound", async () => {
		const prior = candidate("frontier", "frontier-family", "f".repeat(64));
		const priorRows = goodMeasurements().map((row) =>
			measurement(row.vector[0]!.metricId, metricTargets[row.vector[0]!.metricId].baseline, {
				measurementId: `frontier-${row.measurementId}`,
				candidateId: "frontier",
			}),
		);
		const mismatched = parseAutoResearchPortfolioCandidate({
			...(structuredClone(prior) as AutoResearchPortfolioCandidate),
			goalIds: ["quality"],
			solutionFamily: {
				...prior.solutionFamily,
				name: "frontier-quality",
				mechanismClass: "quality-representation",
			},
			causalMechanism: {
				...prior.causalMechanism,
				hypothesis: "frontier quality mechanism improves latency",
				intervention: "replace frontier quality representation",
				expectedObservation: "frontier quality latency improves",
				falsificationCondition: "frontier quality latency does not improve",
			},
		});
		const base = input(candidate(), [...goodMeasurements(), ...priorRows], [mismatched]);
		const result = await evaluateAutoResearchPortfolioAdmission(base);
		expect(result.accepted).toBe(false);
		expect(result.reasons).toContain("frontier_closure_mismatch");

		const missingSelection = await evaluateAutoResearchPortfolioAdmission({
			...base,
			selectedFrontierEntryIds: [],
		} as never);
		expect(missingSelection.accepted).toBe(false);
		expect(missingSelection.reasons).toContain("frontier_selection_mismatch");
	});

	it("rejects a run set that reuses an immutable run artifact", async () => {
		const base = input(candidate(), goodMeasurements());
		const reusedArtifact = await evaluateAutoResearchPortfolioAdmission({
			...base,
			measurementEvidence: base.measurementEvidence.map((entry, index) =>
				index === 1
					? {
							...entry,
							runs: entry.runs.map((run, runIndex) =>
								runIndex === 0
									? { ...run, artifactRef: base.measurementEvidence[0]!.runs[0]!.artifactRef }
									: run,
							),
						}
					: entry,
			),
		});
		expect(reusedArtifact.accepted).toBe(false);
		expect(reusedArtifact.reasons).toContain("measurement_run_artifact_duplicate");
	});

	it("uses verified measurement receipt issuance, not measuredAt, for preregistration timing", async () => {
		const base = input(candidate(), [...goodMeasurements(), measurement("explore.metric", 1)]);
		const preregistration = preregistrationFor(base, ["explore.metric"], "early-measurement-receipt");
		const beforeRegistrationEvidence = base.measurementEvidence.map((entry) => ({
			...entry,
			runs: entry.runs.map((run) => ({
				...run,
				receipt: hostEvidenceReceipt(
					"capability",
					run.receipt.receiptId,
					run.receipt.bindingDigest,
					run.receipt.oneUse,
					"2026-08-17T10:00:00.000Z",
					run.receipt.payloadDigest,
				),
			})),
		}));
		const result = await evaluateAutoResearchPortfolioAdmission({
			...base,
			measurementEvidence: beforeRegistrationEvidence,
			preregistration,
		});
		expect(result.accepted).toBe(true);
		expect(result.exploratory).toBe(true);
		expect(result.reasons).toContain("posthoc_cross_goal_gain");
	});
});
