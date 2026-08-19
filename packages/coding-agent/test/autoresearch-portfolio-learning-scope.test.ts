import { describe, expect, it } from "vitest";
import {
	type AutoResearchPortfolioCandidate,
	type AutoResearchPortfolioContract,
	type AutoResearchPortfolioMeasurement,
	type AutoResearchPortfolioSplitClosureRoots,
	parseAutoResearchPortfolioCandidate,
	parseAutoResearchPortfolioContract,
	parseAutoResearchPortfolioMeasurement,
} from "../src/core/autoresearch/portfolio-contracts.js";
import {
	admitPortfolioLearningScope,
	type PortfolioLearningHostEvidence,
	type PortfolioLearningScopeAdmissionInput,
} from "../src/core/autoresearch/portfolio-learning-scope.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowDecisionRecord,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import type { WorkflowLearningHostWitness } from "../src/core/workflow/learning-controller.js";

const DIGEST = "a".repeat(64);
const ROOT_DIGEST = "b".repeat(64);
const TRAINING_ROOT = "c".repeat(64);
const VALIDATION_ROOT = "d".repeat(64);
const HOLDOUT_ROOT = "e".repeat(64);
const SECOND_MANIFEST_DIGEST = "9".repeat(64);
const WORKFLOW_ID = "portfolio-learning-scope";
const TEST_CLOCK_MILLIS = Date.now();
const NOW = new Date(TEST_CLOCK_MILLIS + 60_000).toISOString();
const LATER = new Date(TEST_CLOCK_MILLIS + 3_600_000).toISOString();

function splitRoots(): AutoResearchPortfolioSplitClosureRoots {
	return { training: TRAINING_ROOT, validation: VALIDATION_ROOT, holdout: HOLDOUT_ROOT };
}

function artifact(
	split: "training" | "validation" | "holdout",
	accessAuthority: "training_workers_training_only" | "validation_evaluator_host_only" | "holdout_host_aggregate_only",
): Record<string, unknown> {
	const sourceTime =
		split === "training"
			? ["2024-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"]
			: split === "validation"
				? ["2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]
				: ["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"];
	return {
		split,
		objectUri: `gs://portfolio-learning/${split}/generation-1`,
		generation: 1,
		sha256: DIGEST,
		bytes: 128,
		schemaVersion: "observations-v1",
		modality: "time_series",
		instrumentSet: ["EUR_USD"],
		sourceTimeStart: sourceTime[0],
		sourceTimeEnd: sourceTime[1],
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
			sourceSystem: "fixture-source",
			sourceDataset: `dataset-${split}`,
			ingestDigest: DIGEST,
			lineageDigest: DIGEST,
			provenanceReceiptDigest: DIGEST,
		},
		closureRootDigest: split === "training" ? TRAINING_ROOT : split === "validation" ? VALIDATION_ROOT : HOLDOUT_ROOT,
		accessAuthority,
	};
}

function inputManifest(): Record<string, unknown> {
	const splitManifest = (
		split: "training" | "validation" | "holdout",
		accessAuthority:
			| "training_workers_training_only"
			| "validation_evaluator_host_only"
			| "holdout_host_aggregate_only",
	): Record<string, unknown> => ({
		locked: true,
		split,
		closureRootDigest: split === "training" ? TRAINING_ROOT : split === "validation" ? VALIDATION_ROOT : HOLDOUT_ROOT,
		artifacts: [artifact(split, accessAuthority)],
	});
	const manifest: Record<string, unknown> = {
		locked: true,
		evaluationEpoch: 1,
		manifestRevision: 1,
		closureRootDigest: ROOT_DIGEST,
		manifestDigest: "",
		splitClosureRoots: splitRoots(),
		splitBoundaryPolicy: {
			locked: true,
			trainingEndExclusive: "2025-01-01T00:00:00.000Z",
			validationStartInclusive: "2025-01-01T00:00:00.000Z",
			validationEndExclusive: "2026-01-01T00:00:00.000Z",
			holdoutStartInclusive: "2026-01-01T00:00:00.000Z",
			holdoutEndExclusive: "2027-01-01T00:00:00.000Z",
			policyDigest: digestObject({
				locked: true,
				trainingEndExclusive: "2025-01-01T00:00:00.000Z",
				validationStartInclusive: "2025-01-01T00:00:00.000Z",
				validationEndExclusive: "2026-01-01T00:00:00.000Z",
				holdoutStartInclusive: "2026-01-01T00:00:00.000Z",
				holdoutEndExclusive: "2027-01-01T00:00:00.000Z",
			}),
		},
		training: splitManifest("training", "training_workers_training_only"),
		validation: splitManifest("validation", "validation_evaluator_host_only"),
		holdout: splitManifest("holdout", "holdout_host_aggregate_only"),
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
	const { manifestDigest: _manifestDigest, ...withoutDigest } = manifest;
	return { ...withoutDigest, manifestDigest: digestObject(withoutDigest) };
}

function immutableManifestDigest(): string {
	return inputManifest().manifestDigest as string;
}

function metric(): Record<string, unknown> {
	return {
		metricId: "quality",
		name: "quality",
		requirementId: "requirement-quality",
		direction: "higher",
		target: 0.8,
		unit: "ratio",
		locked: true,
		evaluationEpoch: 1,
		metricRevision: 1,
		closureRootDigest: ROOT_DIGEST,
		inputManifestDigest: immutableManifestDigest(),
		splitClosureRoots: splitRoots(),
	};
}

function goal(): Record<string, unknown> {
	return {
		goalId: "goal-1",
		domainId: "domain-1",
		title: "Quality",
		description: "Improve quality under a fixed host evaluator.",
		scope: "terminal",
		metrics: [metric()],
		baseline: {
			locked: true,
			measurementId: "baseline-1",
			metricValues: [{ metricId: "quality", value: 0.5 }],
			evidenceDigest: DIGEST,
			evaluationEpoch: 1,
			closureRootDigest: ROOT_DIGEST,
			inputManifestDigest: immutableManifestDigest(),
			splitClosureRoots: splitRoots(),
		},
		evaluator: {
			locked: true,
			evaluatorId: "evaluator-1",
			sourceDigest: DIGEST,
			inputDigest: DIGEST,
			environmentDigest: DIGEST,
			evaluatorDigest: digestObject({
				locked: true,
				evaluatorId: "evaluator-1",
				sourceDigest: DIGEST,
				inputDigest: DIGEST,
				environmentDigest: DIGEST,
				evaluationEpoch: 1,
				evaluatorRevision: 1,
				closureRootDigest: ROOT_DIGEST,
				inputManifestDigest: immutableManifestDigest(),
				splitClosureRoots: splitRoots(),
			}),
			evaluationEpoch: 1,
			evaluatorRevision: 1,
			closureRootDigest: ROOT_DIGEST,
			inputManifestDigest: immutableManifestDigest(),
			splitClosureRoots: splitRoots(),
		},
		parser: {
			locked: true,
			parserId: "parser-1",
			kind: "json_object",
			metricKeys: ["quality"],
			parserDigest: digestObject({
				locked: true,
				parserId: "parser-1",
				kind: "json_object",
				metricKeys: ["quality"],
				evaluationEpoch: 1,
				inputManifestRevision: 1,
				closureRootDigest: ROOT_DIGEST,
				inputManifestDigest: immutableManifestDigest(),
				splitClosureRoots: splitRoots(),
			}),
			evaluationEpoch: 1,
			inputManifestRevision: 1,
			closureRootDigest: ROOT_DIGEST,
			inputManifestDigest: immutableManifestDigest(),
			splitClosureRoots: splitRoots(),
		},
		command: {
			locked: true,
			argv: ["node", "evaluate.mjs"],
			shell: false,
			cwd: "isolated_candidate",
			commandDigest: digestObject({
				locked: true,
				argv: ["node", "evaluate.mjs"],
				shell: false,
				cwd: "isolated_candidate",
			}),
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
			closureRootDigest: ROOT_DIGEST,
			splitClosureRoots: splitRoots(),
		},
		falsification: {
			locked: true,
			criteria: ["quality fails"],
			manifestDigest: digestObject({ locked: true, criteria: ["quality fails"] }),
		},
		adversarial: {
			locked: true,
			checks: ["holdout leakage"],
			manifestDigest: digestObject({ locked: true, checks: ["holdout leakage"] }),
		},
	};
}

function immutableEvaluatorDigest(): string {
	return (goal().evaluator as Record<string, unknown>).evaluatorDigest as string;
}

function contract(): AutoResearchPortfolioContract {
	return parseAutoResearchPortfolioContract({
		schemaVersion: 3,
		contractId: "portfolio-1",
		objective: "Improve quality under fixed host boundaries.",
		acceptanceRequirements: [
			{
				requirementId: "requirement-quality",
				statement: "Quality meets the locked target.",
				locked: true,
				requirementDigest: digestObject({
					requirementId: "requirement-quality",
					statement: "Quality meets the locked target.",
					locked: true,
				}),
			},
		],
		goals: [goal()],
		goalRelations: [],
		lexicographicTiers: [{ tier: 1, goalIds: ["goal-1"] }],
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
		inputManifest: inputManifest(),
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

function candidateRecord(): Record<string, unknown> {
	const solutionFamily = {
		familyId: "family-origin",
		name: "causal representation",
		mechanismClass: "representation",
	};
	const causalMechanism = {
		hypothesis: "A representation separates regimes.",
		intervention: "Replace the shared representation.",
		expectedObservation: "Quality improves on the sealed sample.",
		falsificationCondition: "The improvement disappears on fresh evidence.",
		mechanismDigest: "",
	};
	const { mechanismDigest: _mechanismDigest, ...mechanismWithoutDigest } = causalMechanism;
	causalMechanism.mechanismDigest = digestObject({ solutionFamily, ...mechanismWithoutDigest });
	const change = { kind: "mechanism", changedPaths: ["src/model.ts"], parameterChanges: [], changeDigest: "" };
	change.changeDigest = digestObject({
		kind: change.kind,
		changedPaths: change.changedPaths,
		parameterChanges: change.parameterChanges,
	});
	return {
		candidateId: "candidate-1",
		goalIds: ["goal-1"],
		solutionFamily,
		ancestry: { parentCandidateIds: [], baseDigest: DIGEST, lineageDigest: DIGEST },
		causalMechanism,
		change,
		scope: "terminal",
	};
}

function candidate(): AutoResearchPortfolioCandidate {
	return parseAutoResearchPortfolioCandidate(candidateRecord());
}

function measurement(
	parsedContract: AutoResearchPortfolioContract,
	parsedCandidate: AutoResearchPortfolioCandidate,
): AutoResearchPortfolioMeasurement {
	const goal = parsedContract.goals[0]!;
	const withoutDigest = {
		measurementId: "measurement-candidate-1",
		goalId: goal.goalId,
		candidateId: parsedCandidate.candidateId,
		scope: "terminal" as const,
		kind: "candidate" as const,
		vector: [{ metricId: "quality", value: 0.9 }],
		repeatIndex: 1,
		sampleCount: 3,
		evaluationEpoch: parsedContract.inputManifest.evaluationEpoch,
		inputManifestDigest: parsedContract.inputManifest.manifestDigest,
		splitClosureRoots: parsedContract.inputManifest.splitClosureRoots,
		confidenceInterval: { lower: 0.75, upper: 0.9, level: goal.uncertainty.confidence },
		variance: 0.001,
		runCount: goal.repeatability.runs,
		aggregation: goal.repeatability.aggregation,
		inputDigest: parsedContract.inputManifest.manifestDigest,
		evaluatorDigest: goal.evaluator.evaluatorDigest,
		parserDigest: goal.parser.parserDigest,
		commandDigest: goal.command.commandDigest,
		workspaceDigest: DIGEST,
		evidenceDigests: [DIGEST],
		measuredAt: NOW,
	};
	return parseAutoResearchPortfolioMeasurement({
		...withoutDigest,
		measurementDigest: digestObject(withoutDigest),
	});
}

function candidateDigest(value: AutoResearchPortfolioCandidate): string {
	return digestObject({
		...value,
		goalIds: [...value.goalIds].sort((left, right) => left.localeCompare(right)),
		ancestry: {
			...value.ancestry,
			parentCandidateIds: [...value.ancestry.parentCandidateIds].sort((left, right) => left.localeCompare(right)),
		},
		change: {
			...value.change,
			changedPaths: [...value.change.changedPaths].sort((left, right) => left.localeCompare(right)),
			parameterChanges: [...value.change.parameterChanges].sort((left, right) => left.localeCompare(right)),
		},
	});
}

function contractDigest(value: AutoResearchPortfolioContract): string {
	return digestObject(value);
}

function measurementDigest(value: AutoResearchPortfolioMeasurement): string {
	return digestObject({
		...value,
		vector: [...value.vector].sort((left, right) => left.metricId.localeCompare(right.metricId)),
		evidenceDigests: [...value.evidenceDigests].sort((left, right) => left.localeCompare(right)),
	});
}

const PORTFOLIO_LEARNING_CAPABILITY = "workflow_learning_knowledge_promotion" as const;

function fixtureSourceTargetBinding(
	parsedContract: AutoResearchPortfolioContract,
	parsedCandidate: AutoResearchPortfolioCandidate,
	goalId: string,
	domainId: string,
): {
	readonly sourceGoalId: string;
	readonly sourceDomainId: string;
	readonly targetGoalIds: readonly string[];
	readonly targetDomainIds: readonly string[];
} {
	const targetGoalIds = [...parsedCandidate.goalIds].sort((left, right) => left.localeCompare(right));
	const targetDomainIds = [
		...new Set(
			targetGoalIds
				.map((candidateGoalId) => parsedContract.goals.find((goal) => goal.goalId === candidateGoalId)?.domainId)
				.filter((candidateDomainId): candidateDomainId is string => candidateDomainId !== undefined),
		),
	].sort((left, right) => left.localeCompare(right));
	return { sourceGoalId: goalId, sourceDomainId: domainId, targetGoalIds, targetDomainIds };
}

function fixtureAuthorizationResourceDigest(
	parsedContract: AutoResearchPortfolioContract,
	parsedCandidate: AutoResearchPortfolioCandidate,
	parsedMeasurement: AutoResearchPortfolioMeasurement,
	requestedScope: "goal" | "domain" | "global",
	goalClosure: { readonly goalId: string; readonly evaluatorDigest: string; readonly boundaryDigest: string },
	semantic: FixtureSemantic,
): string {
	return digestObject({
		kind: "portfolio-learning-knowledge-promotion-resource",
		capability: PORTFOLIO_LEARNING_CAPABILITY,
		requestedScope,
		contractDigest: contractDigest(parsedContract),
		candidateDigest: candidateDigest(parsedCandidate),
		measurementDigest: measurementDigest(parsedMeasurement),
		goalClosure,
		sourceTarget: fixtureSourceTargetBinding(parsedContract, parsedCandidate, goalClosure.goalId, "domain-1"),
		semantic,
	});
}

function fixtureAuthorizationOperationDigest(
	requestedScope: "goal" | "domain" | "global",
	workflowId: string,
	bindingDigest: string,
	resourceDigest: string,
	semantic: FixtureSemantic,
	witnessKind: "receipt" | "decision",
	artifact: WorkflowArtifactRef,
	stateDigest: string,
	stateHeadDigest: string,
	revision: number,
	storeEpoch: number,
	coordinatorEpoch: number,
	executionIdentity: string,
	sessionId: string,
): string {
	return digestObject({
		kind: "portfolio-learning-knowledge-promotion-operation",
		capability: PORTFOLIO_LEARNING_CAPABILITY,
		workflowId,
		requestedScope,
		bindingDigest,
		resourceDigest,
		semantic,
		witnessKind,
		artifactRef: artifact,
		stateDigest,
		stateHeadDigest,
		revision,
		epochRef: { storeEpoch, coordinatorEpoch },
		executionIdentity,
		sessionId,
	});
}

function artifactRef(id: string): WorkflowArtifactRef {
	const bytes = canonicalJsonBytes({ id });
	return {
		artifactId: id,
		relativePath: `learning/${id}`,
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: 1,
	};
}

let receiptSequence = 0;

type FixtureSemantic = Readonly<Record<string, string | number>>;

function fixtureWorkerRole(kind: string): string {
	return kind === "originating_vector"
		? "vector_evaluator"
		: kind === "boundary"
			? "boundary_checker"
			: kind === "invariant"
				? "invariant_checker"
				: kind === "domain_transfer"
					? "transfer_evaluator"
					: kind === "cross_domain_transfer"
						? "cross_domain_evaluator"
						: kind === "red_team"
							? "red_team"
							: "manifest_restorer";
}

async function hostEvidence(
	context: ReturnType<typeof createFixtureHostReceiptConsumerContext>,
	stage: string,
	parsedContract: AutoResearchPortfolioContract,
	parsedCandidate: AutoResearchPortfolioCandidate,
	parsedMeasurement: AutoResearchPortfolioMeasurement,
	semantic: FixtureSemantic,
	issuerId = `host-${stage}`,
): Promise<PortfolioLearningHostEvidence> {
	receiptSequence += 1;
	const workerRole = fixtureWorkerRole(String(semantic.kind));
	const executionIdentity = `${issuerId}-execution`;
	const sessionId = `${issuerId}-session`;
	const ref = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: `ref-${stage}-${receiptSequence}`,
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: DIGEST,
		payloadDigest: DIGEST,
		artifactRef: artifactRef(`artifact-${stage}-${receiptSequence}`),
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		oneUse: true,
	}).artifactRef;
	const workerAttestationDigest = digestObject({
		kind: "portfolio-learning-host-worker-attestation",
		workflowId: WORKFLOW_ID,
		candidateId: parsedCandidate.candidateId,
		candidateDigest: candidateDigest(parsedCandidate),
		contractDigest: contractDigest(parsedContract),
		measurementDigest: measurementDigest(parsedMeasurement),
		workerId: issuerId,
		workerRole,
		artifactRef: ref,
	});
	const bindingFields = {
		artifactRef: ref,
		workspaceDigest: parsedMeasurement.workspaceDigest,
		workerId: issuerId,
		workerRole,
		workerAttestationDigest,
		executionIdentity,
		sessionId,
		closureRootDigest: ROOT_DIGEST,
		evaluationEpoch: 1,
		acquisition: "complete",
		coverage: "complete",
	};
	const bindingDigest = digestObject({
		kind: "portfolio-learning-host-evidence-binding",
		workflowId: WORKFLOW_ID,
		candidateId: parsedCandidate.candidateId,
		candidateDigest: candidateDigest(parsedCandidate),
		contractDigest: contractDigest(parsedContract),
		measurementDigest: measurementDigest(parsedMeasurement),
		witnessKind: "receipt",
		stage,
		semantic,
		...bindingFields,
	});
	const payloadDigest = digestObject({
		kind: "portfolio-learning-host-evidence-payload",
		bindingDigest,
		receiptKind: "artifact",
		semantic,
		workerId: issuerId,
		workerRole,
		artifactRef: ref,
	});
	const goalClosure = {
		goalId: "goal-1",
		evaluatorDigest: immutableEvaluatorDigest(),
		boundaryDigest: digestObject({
			boundaryId: parsedContract.hardBoundaries[0]!.boundaryId,
			statement: parsedContract.hardBoundaries[0]!.statement,
			scope: parsedContract.hardBoundaries[0]!.scope,
			locked: parsedContract.hardBoundaries[0]!.locked,
		}),
	};
	const resourceDigest = fixtureAuthorizationResourceDigest(
		parsedContract,
		parsedCandidate,
		parsedMeasurement,
		"global",
		goalClosure,
		semantic,
	);
	const operationDigest = fixtureAuthorizationOperationDigest(
		"global",
		WORKFLOW_ID,
		bindingDigest,
		resourceDigest,
		semantic,
		"receipt",
		ref,
		"state-1",
		"head-1",
		1,
		1,
		1,
		executionIdentity,
		sessionId,
	);
	const receipt = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: `receipt-${stage}-${receiptSequence}`,
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest,
		payloadDigest,
		artifactRef: ref,
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		oneUse: true,
		stateDigest: "state-1",
		revision: 1,
		capabilityBinding: {
			capability: PORTFOLIO_LEARNING_CAPABILITY,
			resourceDigest,
			operationDigest,
			executionIdentity,
			sessionId,
		},
	});
	await resolveAndVerifyWorkflowHostReceipt({
		context,
		workflowId: WORKFLOW_ID,
		expectedBindingDigest: receipt.bindingDigest,
		receipt,
		currentStateDigest: receipt.stateDigest,
		currentRevision: receipt.revision,
		trustedNow: NOW,
	});
	await context.receiptResolver.consumeIfOneUse({
		receipt,
		workflowId: WORKFLOW_ID,
		expectedBindingDigest: receipt.bindingDigest,
		currentRevision: receipt.revision,
	});
	const consumption = await context.receiptResolver.resolveConsumptionWitness({
		receiptId: receipt.receiptId,
		workflowId: WORKFLOW_ID,
		expectedBindingDigest: receipt.bindingDigest,
	});
	if (
		consumption.receiptId !== receipt.receiptId ||
		consumption.workflowId !== WORKFLOW_ID ||
		consumption.bindingDigest !== receipt.bindingDigest
	)
		throw new Error("Fixture receipt consumption was not bound to the signed receipt.");
	const witness: WorkflowLearningHostWitness = {
		witnessId: `witness-${receipt.receiptId}`,
		witnessKind: "receipt",
		workflowId: WORKFLOW_ID,
		stage,
		candidateId: parsedCandidate.candidateId,
		evidenceRef: receipt.artifactRef,
		payloadDigest: receipt.bindingDigest,
		bytesDigest: receipt.artifactRef.digest,
		bytesSize: receipt.artifactRef.sizeBytes,
		revision: receipt.revision,
		storeEpoch: 1,
		coordinatorEpoch: 1,
		stateHeadDigest: "head-1",
		trustedNow: NOW,
		oneUse: true,
	};
	return {
		artifactRef: receipt.artifactRef,
		receipt,
		witness,
		bindingDigest: receipt.bindingDigest,
		workspaceDigest: parsedMeasurement.workspaceDigest,
		workerId: issuerId,
		workerRole: workerRole as PortfolioLearningHostEvidence["workerRole"],
		workerAttestationDigest,
		executionIdentity,
		sessionId,
		closureRootDigest: ROOT_DIGEST,
		evaluationEpoch: 1,
		acquisition: "complete",
		coverage: "complete",
	};
}

type FixturePromotableScope = "goal" | "domain" | "global";

function fixtureResourceDigestForInput(
	input: PortfolioLearningScopeAdmissionInput,
	requestedScope: FixturePromotableScope,
	semantic: FixtureSemantic,
): string {
	const sourceGoalId = input.originatingVectorEvidence?.goalId ?? "";
	const sourceDomainId = input.originatingVectorEvidence?.domainId ?? "";
	const targetGoalIds = [...input.candidate.goalIds].sort((left, right) => left.localeCompare(right));
	const targetDomainIds = [
		...new Set(
			targetGoalIds
				.map((goalId) => input.contract.goals.find((goal) => goal.goalId === goalId)?.domainId)
				.filter((domainId): domainId is string => domainId !== undefined),
		),
	].sort((left, right) => left.localeCompare(right));
	return digestObject({
		kind: "portfolio-learning-knowledge-promotion-resource",
		capability: PORTFOLIO_LEARNING_CAPABILITY,
		requestedScope,
		contractDigest: contractDigest(input.contract),
		candidateDigest: candidateDigest(input.candidate),
		measurementDigest: measurementDigest(input.measurement),
		goalClosure: input.goalClosure,
		sourceTarget: { sourceGoalId, sourceDomainId, targetGoalIds, targetDomainIds },
		semantic,
	});
}

function fixtureOperationDigestForInput(
	input: PortfolioLearningScopeAdmissionInput,
	requestedScope: FixturePromotableScope,
	bindingDigest: string,
	resourceDigest: string,
	semantic: FixtureSemantic,
	witnessKind: "receipt" | "decision",
	artifact: WorkflowArtifactRef,
	executionIdentity: string,
	sessionId: string,
): string {
	return digestObject({
		kind: "portfolio-learning-knowledge-promotion-operation",
		capability: PORTFOLIO_LEARNING_CAPABILITY,
		workflowId: input.workflowId,
		requestedScope,
		bindingDigest,
		resourceDigest,
		semantic,
		witnessKind,
		artifactRef: artifact,
		stateDigest: input.currentStateDigest,
		stateHeadDigest: input.currentStateHeadDigest,
		revision: input.currentRevision,
		epochRef: { storeEpoch: input.currentStoreEpoch, coordinatorEpoch: input.currentCoordinatorEpoch },
		executionIdentity,
		sessionId,
	});
}

interface FixtureReceiptRebinding {
	readonly receipts: Map<string, WorkflowVerifiedHostReceipt>;
	readonly scope: FixturePromotableScope;
	readonly input: PortfolioLearningScopeAdmissionInput;
}

async function rebindHostEvidenceForScope(
	binding: FixtureReceiptRebinding,
	evidence: PortfolioLearningHostEvidence,
	semantic: FixtureSemantic,
): Promise<PortfolioLearningHostEvidence> {
	const originalReceipt = evidence.receipt;
	let receipt = binding.receipts.get(originalReceipt.receiptId);
	if (receipt === undefined) {
		const resourceDigest = fixtureResourceDigestForInput(binding.input, binding.scope, semantic);
		const operationDigest = fixtureOperationDigestForInput(
			binding.input,
			binding.scope,
			evidence.bindingDigest,
			resourceDigest,
			semantic,
			"receipt",
			evidence.artifactRef,
			evidence.executionIdentity,
			evidence.sessionId,
		);
		const rebuilt = createFixtureHostReceipt({
			receiptKind: originalReceipt.receiptKind,
			oneUse: originalReceipt.oneUse,
			receiptId: `${originalReceipt.receiptId}-${binding.scope}`,
			issuerId: originalReceipt.issuerId,
			workflowId: originalReceipt.workflowId,
			bindingDigest: originalReceipt.bindingDigest,
			payloadDigest: originalReceipt.payloadDigest,
			artifactRef: originalReceipt.artifactRef,
			issuedAt: originalReceipt.issuedAt,
			validUntil: originalReceipt.validUntil,
			keyId: originalReceipt.keyId,
			stateDigest: originalReceipt.stateDigest,
			revision: originalReceipt.revision,
			capabilityBinding: {
				capability: PORTFOLIO_LEARNING_CAPABILITY,
				resourceDigest,
				operationDigest,
				executionIdentity: evidence.executionIdentity,
				sessionId: evidence.sessionId,
			},
		});
		receipt =
			originalReceipt.signature === "forged"
				? {
						...rebuilt,
						signature: originalReceipt.signature,
						verificationDigest: originalReceipt.verificationDigest,
					}
				: rebuilt;
		binding.receipts.set(originalReceipt.receiptId, receipt);
		try {
			await binding.input.receiptContext.receiptResolver.consumeIfOneUse({
				receipt,
				workflowId: binding.input.workflowId,
				expectedBindingDigest: receipt.bindingDigest,
				currentRevision: binding.input.currentRevision,
			});
		} catch (_error: unknown) {
			// The admission call must report invalid current-state evidence rather than let this fixture helper throw.
		}
	}
	return {
		...evidence,
		artifactRef: receipt.artifactRef,
		receipt,
		witness: { ...evidence.witness, evidenceRef: receipt.artifactRef },
	};
}

async function rebindInputForScope(
	input: PortfolioLearningScopeAdmissionInput,
	scope: FixturePromotableScope,
): Promise<PortfolioLearningScopeAdmissionInput> {
	if (scope === "global") return { ...input, requestedScope: scope };
	const candidateKeys = new Set([
		"candidateId",
		"goalIds",
		"solutionFamily",
		"ancestry",
		"causalMechanism",
		"change",
		"scope",
	]);
	if (
		Reflect.ownKeys(input.candidate).some((key) => typeof key !== "string" || !candidateKeys.has(key)) ||
		Reflect.ownKeys(input.candidate.solutionFamily).some(
			(key) => typeof key !== "string" || !["familyId", "name", "mechanismClass"].includes(key),
		)
	)
		return { ...input, requestedScope: scope };
	const binding: FixtureReceiptRebinding = { receipts: new Map(), scope, input };
	const vector = input.originatingVectorEvidence;
	const vectorEvidence =
		vector === null || vector === undefined
			? vector
			: {
					...vector,
					evidence: await Promise.all(
						vector.evidence.map((evidence) =>
							rebindHostEvidenceForScope(binding, evidence, {
								kind: "originating_vector",
								goalId: vector.goalId,
								domainId: vector.domainId,
								solutionFamilyId: vector.solutionFamilyId,
								evaluatorDigest: vector.evaluatorDigest,
								boundaryDigest: vector.boundaryDigest,
							}),
						),
					),
				};
	const boundaryEvidence = await Promise.all(
		input.boundaryEvidence.map(async (entry) => ({
			...entry,
			evidence: await rebindHostEvidenceForScope(binding, entry.evidence, {
				kind: "boundary",
				boundaryId: entry.boundaryId,
				boundaryDigest: entry.boundaryDigest,
				disposition: entry.disposition,
			}),
		})),
	);
	const invariantEvidence = await Promise.all(
		input.invariantEvidence.map(async (entry) => {
			const invariant = input.contract.invariants.find((candidate) => candidate.invariantId === entry.invariantId);
			return {
				...entry,
				evidence: await rebindHostEvidenceForScope(binding, entry.evidence, {
					kind: "invariant",
					invariantId: entry.invariantId,
					checkDigest: invariant?.checkDigest ?? "",
					scope: invariant?.scope ?? "terminal",
					disposition: entry.disposition,
				}),
			};
		}),
	);
	const domainManifestDigest = digestObject(
		[...input.approvedGoalFamilyManifest]
			.sort((left, right) =>
				`${left.goalId}\u0000${left.domainId}\u0000${left.solutionFamilyId}`.localeCompare(
					`${right.goalId}\u0000${right.domainId}\u0000${right.solutionFamilyId}`,
				),
			)
			.map((entry) => ({ ...entry })),
	);
	const domainPreregistrationDigest = digestObject({
		kind: "portfolio-learning-domain-preregistration",
		manifestDigest: domainManifestDigest,
	});
	const domainTransferEvidence = await Promise.all(
		input.domainTransferEvidence.map(async (entry) => ({
			...entry,
			evidence: await rebindHostEvidenceForScope(binding, entry.evidence, {
				kind: "domain_transfer",
				transferKey: `${entry.goalId}\u0000${entry.domainId}\u0000${entry.solutionFamilyId}`,
				manifestDigest: domainManifestDigest,
				preregistrationDigest: domainPreregistrationDigest,
				confirmationDigest: entry.confirmationDigest,
				familyDigest:
					input.approvedGoalFamilyManifest.find(
						(manifestEntry) =>
							manifestEntry.goalId === entry.goalId &&
							manifestEntry.domainId === entry.domainId &&
							manifestEntry.solutionFamilyId === entry.solutionFamilyId,
					)?.familyDigest ?? "",
			}),
		})),
	);
	const crossDomainTransfer =
		input.crossDomainTransfer === null || input.crossDomainTransfer === undefined
			? input.crossDomainTransfer
			: {
					...input.crossDomainTransfer,
					evidence: await Promise.all(
						input.crossDomainTransfer.evidence.map(async (entry) => {
							const crossPreregistrationDigest = digestObject({
								kind: "portfolio-learning-cross-domain-preregistration",
								manifest: [...input.crossDomainTransfer!.manifest].sort((left, right) =>
									`${left.goalId}\u0000${left.fromDomainId}\u0000${left.toDomainId}\u0000${left.manifestGeneration}\u0000${left.manifestDigest}`.localeCompare(
										`${right.goalId}\u0000${right.fromDomainId}\u0000${right.toDomainId}\u0000${right.manifestGeneration}\u0000${right.manifestDigest}`,
									),
								),
							});
							return {
								...entry,
								evidence: await rebindHostEvidenceForScope(binding, entry.evidence, {
									kind: "cross_domain_transfer",
									transferKey: `${entry.goalId}\u0000${entry.fromDomainId}\u0000${entry.toDomainId}\u0000${entry.manifestGeneration}\u0000${entry.manifestDigest}`,
									preregistrationDigest: crossPreregistrationDigest,
									confirmationDigest: entry.confirmationDigest,
								}),
							};
						}),
					),
				};
	const redTeamEvidence =
		input.redTeamEvidence === null || input.redTeamEvidence === undefined
			? input.redTeamEvidence
			: {
					...input.redTeamEvidence,
					evidence: await rebindHostEvidenceForScope(binding, input.redTeamEvidence.evidence, {
						kind: "red_team",
						independence: "independent",
						disposition: input.redTeamEvidence.disposition,
					}),
				};
	const restoreRehashProofs = await Promise.all(
		input.restoreRehashProofs.map(async (proof) => ({
			...proof,
			evidence: await rebindHostEvidenceForScope(binding, proof.evidence, {
				kind: "manifest_restore",
				manifestGeneration: proof.manifestGeneration,
				manifestDigest: proof.manifestDigest,
				manifestArtifactDigest: proof.manifestArtifactDigest,
				independence: proof.independence,
				restoration: proof.restoration,
				rehash: proof.rehash,
			}),
		})),
	);
	return {
		...input,
		requestedScope: scope,
		originatingVectorEvidence: vectorEvidence,
		boundaryEvidence,
		invariantEvidence,
		domainTransferEvidence,
		crossDomainTransfer,
		redTeamEvidence,
		restoreRehashProofs,
	};
}

function approvalDecision(
	receipt: WorkflowVerifiedHostReceipt,
	parsedContract: AutoResearchPortfolioContract,
	parsedCandidate: AutoResearchPortfolioCandidate,
	parsedMeasurement: AutoResearchPortfolioMeasurement,
	workerId: string,
	operationDigest: string,
): WorkflowDecisionRecord {
	const goal = parsedContract.goals.find((entry) => entry.goalId === parsedMeasurement.goalId)!;
	return {
		decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: "root-session" },
		decisionId: "decision-global-1",
		revision: 1,
		parentDecisionIds: [],
		kind: "autoresearch_candidate",
		hostClassification: {
			classifier: "host",
			rulesetDigest: DIGEST,
			effectClasses: ["goal_contract_or_scorecard"],
			normalizedReadSet: [],
			normalizedWriteSet: [],
			derivedMateriality: "consequential",
			requiresUserApproval: true,
			reasonCodes: ["wider-learning-scope"],
			classifiedTargetDigest: DIGEST,
			classifiedEffectDigest: DIGEST,
		},
		storeEpoch: 1,
		coordinatorEpoch: 1,
		targetDigest: DIGEST,
		effectDigest: DIGEST,
		preconditionDigest: DIGEST,
		authority: ["request_user_approval"],
		expiresAt: LATER,
		objectiveDigest: DIGEST,
		contractDigest: contractDigest(parsedContract),
		scorecardDigest: DIGEST,
		planDigest: DIGEST,
		stateDigest: "state-1",
		workspaceDigest: parsedMeasurement.workspaceDigest,
		evidenceDigest: DIGEST,
		parserDigest: goal.parser.parserDigest,
		evaluatorDigest: goal.evaluator.evaluatorDigest,
		guardDigest: DIGEST,
		regressionDigest: DIGEST,
		blockerDigest: null,
		redTeamDigest: DIGEST,
		readSet: [],
		writeSet: [],
		attemptToken: "attempt-1",
		nonce: "nonce-1",
		executionKey: "execution-1",
		proposerSessionId: parsedCandidate.candidateId,
		lensSessionIds: [],
		verifierSessionId: "verifier",
		synthesizerSessionId: "synthesizer",
		redTeamSessionId: "red-team",
		stagePlan: {
			stages: ["recon", "lens", "lens", "verification", "synthesis", "red_team"],
			lensRoles: [null, "primary", "secondary", null, null, null],
			charterDigests: [DIGEST, DIGEST, DIGEST, DIGEST, DIGEST, DIGEST],
			planDigest: DIGEST,
		},
		stageVerdicts: [],
		hostAdjudication: {
			stage: "host_adjudication",
			decisionId: "decision-global-1",
			decisionRevision: 1,
			executionIdentity: `${workerId}-execution`,
			sessionId: `${workerId}-session`,
			inputStateDigest: "state-1",
			operationDigest,
			verdictArtifactRef: receipt.artifactRef,
			verdictDigest: receipt.payloadDigest,
			hostReceipt: receipt,
			disposition: "accepted",
		},
		artifactRefs: [receipt.artifactRef],
		disposition: "authorized",
	};
}

interface Fixture {
	readonly input: PortfolioLearningScopeAdmissionInput;
	readonly redTeam: PortfolioLearningHostEvidence;
}

async function fixture(): Promise<Fixture> {
	receiptSequence = 0;
	const context = createFixtureHostReceiptConsumerContext();
	const parsedContract = contract();
	const parsedCandidate = candidate();
	const parsedMeasurement = measurement(parsedContract, parsedCandidate);
	const canonicalBoundaryDigest = digestObject(parsedContract.hardBoundaries[0]!);
	const familyManifest = [
		{ goalId: "goal-1", domainId: "domain-1", solutionFamilyId: "family-transfer-1" },
		{ goalId: "goal-1", domainId: "domain-1", solutionFamilyId: "family-transfer-2" },
	].map((entry) => ({ ...entry, familyDigest: digestObject(entry) }));
	const familyManifestDigest = digestObject(
		[...familyManifest].sort((left, right) =>
			`${left.goalId}\u0000${left.domainId}\u0000${left.solutionFamilyId}`.localeCompare(
				`${right.goalId}\u0000${right.domainId}\u0000${right.solutionFamilyId}`,
			),
		),
	);
	const familyPreregistrationDigest = digestObject({
		kind: "portfolio-learning-domain-preregistration",
		manifestDigest: familyManifestDigest,
	});
	const transferOneConfirmationDigest = digestObject({
		kind: "portfolio-learning-domain-confirmation",
		manifestDigest: familyManifestDigest,
		goalId: "goal-1",
		domainId: "domain-1",
		solutionFamilyId: "family-transfer-1",
		freshness: "fresh",
		independence: "independent",
		disposition: "pass",
	});
	const transferTwoConfirmationDigest = digestObject({
		kind: "portfolio-learning-domain-confirmation",
		manifestDigest: familyManifestDigest,
		goalId: "goal-1",
		domainId: "domain-1",
		solutionFamilyId: "family-transfer-2",
		freshness: "fresh",
		independence: "independent",
		disposition: "pass",
	});
	const vector = await hostEvidence(context, "vector", parsedContract, parsedCandidate, parsedMeasurement, {
		kind: "originating_vector",
		goalId: "goal-1",
		domainId: "domain-1",
		solutionFamilyId: "family-origin",
		evaluatorDigest: immutableEvaluatorDigest(),
		boundaryDigest: canonicalBoundaryDigest,
	});
	const boundary = await hostEvidence(context, "boundary", parsedContract, parsedCandidate, parsedMeasurement, {
		kind: "boundary",
		boundaryId: "boundary-safety",
		boundaryDigest: canonicalBoundaryDigest,
		disposition: "pass",
	});
	const invariant = await hostEvidence(context, "invariant", parsedContract, parsedCandidate, parsedMeasurement, {
		kind: "invariant",
		invariantId: "invariant-safety",
		checkDigest: DIGEST,
		scope: "terminal",
		disposition: "pass",
	});
	const transferOne = await hostEvidence(context, "transfer-one", parsedContract, parsedCandidate, parsedMeasurement, {
		kind: "domain_transfer",
		transferKey: "goal-1\u0000domain-1\u0000family-transfer-1",
		manifestDigest: familyManifestDigest,
		preregistrationDigest: familyPreregistrationDigest,
		confirmationDigest: transferOneConfirmationDigest,
		familyDigest: familyManifest[0]!.familyDigest,
	});
	const transferTwo = await hostEvidence(context, "transfer-two", parsedContract, parsedCandidate, parsedMeasurement, {
		kind: "domain_transfer",
		transferKey: "goal-1\u0000domain-1\u0000family-transfer-2",
		manifestDigest: familyManifestDigest,
		preregistrationDigest: familyPreregistrationDigest,
		confirmationDigest: transferTwoConfirmationDigest,
		familyDigest: familyManifest[1]!.familyDigest,
	});
	const crossManifest = [
		{
			goalId: "goal-1",
			fromDomainId: "domain-1",
			toDomainId: "domain-2",
			manifestGeneration: 2,
			manifestDigest: SECOND_MANIFEST_DIGEST,
		},
	];
	const crossPreregistrationDigest = digestObject({
		kind: "portfolio-learning-cross-domain-preregistration",
		manifest: crossManifest,
	});
	const crossTransferKey = `goal-1\u0000domain-1\u0000domain-2\u00002\u0000${SECOND_MANIFEST_DIGEST}`;
	const crossConfirmationDigest = digestObject({
		kind: "portfolio-learning-cross-domain-confirmation",
		preregistrationDigest: crossPreregistrationDigest,
		transferKey: crossTransferKey,
		freshness: "fresh",
		independence: "independent",
		disposition: "pass",
	});
	const crossDomain = await hostEvidence(
		context,
		"cross-domain",
		parsedContract,
		parsedCandidate,
		parsedMeasurement,
		{
			kind: "cross_domain_transfer",
			transferKey: crossTransferKey,
			preregistrationDigest: crossPreregistrationDigest,
			confirmationDigest: crossConfirmationDigest,
		},
		"cross-domain-worker",
	);
	const redTeam = await hostEvidence(
		context,
		"red-team",
		parsedContract,
		parsedCandidate,
		parsedMeasurement,
		{ kind: "red_team", independence: "independent", disposition: "pass" },
		"red-team-worker",
	);
	const physicalManifestOne = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: "physical-manifest-one",
		issuerId: "manifest-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: DIGEST,
		payloadDigest: DIGEST,
		artifactRef: artifactRef("physical-manifest-one"),
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		oneUse: true,
	}).artifactRef;
	const physicalManifestTwo = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: "physical-manifest-two",
		issuerId: "manifest-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: DIGEST,
		payloadDigest: DIGEST,
		artifactRef: artifactRef("physical-manifest-two"),
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		oneUse: true,
	}).artifactRef;
	const manifestArtifactDigest = (
		generation: number,
		manifestDigest: string,
		refs: readonly WorkflowArtifactRef[],
	): string =>
		digestObject({
			kind: "portfolio-learning-physical-manifest",
			manifestGeneration: generation,
			manifestDigest,
			artifacts: [...refs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
		});
	const restoreOne = await hostEvidence(context, "restore-one", parsedContract, parsedCandidate, parsedMeasurement, {
		kind: "manifest_restore",
		manifestGeneration: 1,
		manifestDigest: parsedContract.inputManifest.manifestDigest,
		manifestArtifactDigest: manifestArtifactDigest(1, parsedContract.inputManifest.manifestDigest, [
			physicalManifestOne,
		]),
		independence: "independent",
		restoration: "verified",
		rehash: "verified",
	});
	const restoreTwo = await hostEvidence(
		context,
		"restore-two",
		parsedContract,
		parsedCandidate,
		parsedMeasurement,
		{
			kind: "manifest_restore",
			manifestGeneration: 2,
			manifestDigest: SECOND_MANIFEST_DIGEST,
			manifestArtifactDigest: manifestArtifactDigest(2, SECOND_MANIFEST_DIGEST, [physicalManifestTwo]),
			independence: "independent",
			restoration: "verified",
			rehash: "verified",
		},
		"restore-two-worker",
	);
	const approvalWorkerId = "approval-worker";
	const approvalOperationDigest = digestObject({
		kind: "portfolio-learning-approval-operation",
		workflowId: WORKFLOW_ID,
		candidateId: parsedCandidate.candidateId,
		candidateDigest: candidateDigest(parsedCandidate),
		contractDigest: contractDigest(parsedContract),
		measurementDigest: measurementDigest(parsedMeasurement),
	});
	const approvalArtifactRef = artifactRef("artifact-approval");
	const placeholderApprovalReceipt = createFixtureHostReceipt({
		receiptKind: "adjudication",
		receiptId: "receipt-approval",
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: DIGEST,
		payloadDigest: DIGEST,
		artifactRef: approvalArtifactRef,
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		oneUse: true,
		stateDigest: "state-1",
		revision: 1,
	});
	const placeholderDecision = approvalDecision(
		placeholderApprovalReceipt,
		parsedContract,
		parsedCandidate,
		parsedMeasurement,
		approvalWorkerId,
		approvalOperationDigest,
	);
	const approvalBindingDigest = digestObject({
		kind: "portfolio-learning-scope-adjudication",
		workflowId: WORKFLOW_ID,
		currentRevision: 1,
		currentStateDigest: "state-1",
		currentStateHeadDigest: "head-1",
		currentStoreEpoch: 1,
		currentCoordinatorEpoch: 1,
		candidateId: parsedCandidate.candidateId,
		candidateDigest: candidateDigest(parsedCandidate),
		contractDigest: contractDigest(parsedContract),
		measurementDigest: measurementDigest(parsedMeasurement),
		workspaceDigest: parsedMeasurement.workspaceDigest,
		decisionId: placeholderDecision.decisionId,
		decisionRevision: placeholderDecision.revision,
		operationDigest: approvalOperationDigest,
		workerId: approvalWorkerId,
		workerRole: "scope_adjudicator",
		artifactRef: placeholderApprovalReceipt.artifactRef,
	});
	const approvalSemantic = {
		kind: "adjudication",
		decisionId: placeholderDecision.decisionId,
		decisionRevision: 1,
		operationDigest: approvalOperationDigest,
		workerId: approvalWorkerId,
		workerRole: "scope_adjudicator",
	} as const;
	const approvalPayloadDigest = digestObject({
		kind: "portfolio-learning-host-evidence-payload",
		bindingDigest: approvalBindingDigest,
		receiptKind: "adjudication",
		semantic: approvalSemantic,
		workerId: approvalWorkerId,
		workerRole: "scope_adjudicator",
		artifactRef: placeholderApprovalReceipt.artifactRef,
	});
	const approvalResourceDigest = fixtureAuthorizationResourceDigest(
		parsedContract,
		parsedCandidate,
		parsedMeasurement,
		"global",
		{
			goalId: "goal-1",
			evaluatorDigest: immutableEvaluatorDigest(),
			boundaryDigest: digestObject(parsedContract.hardBoundaries[0]!),
		},
		approvalSemantic,
	);
	const approvalExecutionIdentity = `${approvalWorkerId}-execution`;
	const approvalSessionId = `${approvalWorkerId}-session`;
	const approvalCapabilityOperationDigest = fixtureAuthorizationOperationDigest(
		"global",
		WORKFLOW_ID,
		approvalBindingDigest,
		approvalResourceDigest,
		approvalSemantic,
		"decision",
		placeholderApprovalReceipt.artifactRef,
		"state-1",
		"head-1",
		1,
		1,
		1,
		approvalExecutionIdentity,
		approvalSessionId,
	);
	const approvalReceipt = createFixtureHostReceipt({
		receiptKind: "adjudication",
		receiptId: placeholderApprovalReceipt.receiptId,
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: approvalBindingDigest,
		payloadDigest: approvalPayloadDigest,
		artifactRef: approvalArtifactRef,
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		oneUse: true,
		stateDigest: "state-1",
		revision: 1,
		capabilityBinding: {
			capability: PORTFOLIO_LEARNING_CAPABILITY,
			resourceDigest: approvalResourceDigest,
			operationDigest: approvalCapabilityOperationDigest,
			executionIdentity: approvalExecutionIdentity,
			sessionId: approvalSessionId,
		},
	});
	const approvalDecisionRecord = approvalDecision(
		approvalReceipt,
		parsedContract,
		parsedCandidate,
		parsedMeasurement,
		approvalWorkerId,
		approvalOperationDigest,
	);
	const approvalAttestationDigest = digestObject({
		kind: "portfolio-learning-scope-adjudicator-attestation",
		workflowId: WORKFLOW_ID,
		candidateId: parsedCandidate.candidateId,
		candidateDigest: candidateDigest(parsedCandidate),
		contractDigest: contractDigest(parsedContract),
		measurementDigest: measurementDigest(parsedMeasurement),
		decisionId: approvalDecisionRecord.decisionId,
		decisionRevision: approvalDecisionRecord.revision,
		workerId: approvalWorkerId,
		workerRole: "scope_adjudicator",
		artifactRef: approvalReceipt.artifactRef,
	});
	await resolveAndVerifyWorkflowHostReceipt({
		context,
		workflowId: WORKFLOW_ID,
		expectedBindingDigest: approvalReceipt.bindingDigest,
		receipt: approvalReceipt,
		currentStateDigest: "state-1",
		currentRevision: 1,
		trustedNow: NOW,
	});
	await context.receiptResolver.consumeIfOneUse({
		receipt: approvalReceipt,
		workflowId: WORKFLOW_ID,
		expectedBindingDigest: approvalReceipt.bindingDigest,
		currentRevision: 1,
	});
	const approvalWitness: WorkflowLearningHostWitness = {
		witnessId: `witness-${approvalReceipt.receiptId}`,
		witnessKind: "decision",
		workflowId: WORKFLOW_ID,
		stage: "approval",
		candidateId: parsedCandidate.candidateId,
		evidenceRef: approvalReceipt.artifactRef,
		payloadDigest: approvalReceipt.bindingDigest,
		bytesDigest: approvalReceipt.artifactRef.digest,
		bytesSize: approvalReceipt.artifactRef.sizeBytes,
		revision: 1,
		storeEpoch: 1,
		coordinatorEpoch: 1,
		stateHeadDigest: "head-1",
		trustedNow: NOW,
		oneUse: true,
	};
	const input: PortfolioLearningScopeAdmissionInput = {
		requestedScope: "global",
		receiptContext: context,
		workflowId: WORKFLOW_ID,
		currentRevision: 1,
		currentStateDigest: "state-1",
		currentStateHeadDigest: "head-1",
		currentStoreEpoch: 1,
		currentCoordinatorEpoch: 1,
		trustedNow: NOW,
		contract: parsedContract,
		candidate: parsedCandidate,
		measurement: parsedMeasurement,
		frontierDisposition: { status: "accepted", postHocCrossGoalGain: "none" },
		originatingVectorEvidence: {
			goalId: "goal-1",
			domainId: "domain-1",
			solutionFamilyId: "family-origin",
			evaluatorDigest: immutableEvaluatorDigest(),
			boundaryDigest: canonicalBoundaryDigest,
			evidence: [vector],
		},
		scopeJustification: "The host-verified mechanism remains within the immutable closure.",
		goalClosure: {
			goalId: "goal-1",
			evaluatorDigest: immutableEvaluatorDigest(),
			boundaryDigest: canonicalBoundaryDigest,
		},
		approvedGoalFamilyManifest: familyManifest,
		domainTransferEvidence: [
			{
				goalId: "goal-1",
				domainId: "domain-1",
				solutionFamilyId: "family-transfer-1",
				freshness: "fresh",
				independence: "independent",
				disposition: "pass",
				manifestDigest: familyManifestDigest,
				preregistrationDigest: familyPreregistrationDigest,
				confirmationDigest: transferOneConfirmationDigest,
				evidence: transferOne,
			},
			{
				goalId: "goal-1",
				domainId: "domain-1",
				solutionFamilyId: "family-transfer-2",
				freshness: "fresh",
				independence: "independent",
				disposition: "pass",
				manifestDigest: familyManifestDigest,
				preregistrationDigest: familyPreregistrationDigest,
				confirmationDigest: transferTwoConfirmationDigest,
				evidence: transferTwo,
			},
		],
		crossDomainTransfer: {
			preregistration: "fresh",
			preregistrationDigest: crossPreregistrationDigest,
			manifest: crossManifest,
			evidence: [
				{
					goalId: "goal-1",
					fromDomainId: "domain-1",
					toDomainId: "domain-2",
					manifestGeneration: 2,
					manifestDigest: SECOND_MANIFEST_DIGEST,
					freshness: "fresh",
					independence: "independent",
					disposition: "pass",
					confirmationDigest: crossConfirmationDigest,
					evidence: crossDomain,
				},
			],
		},
		boundaryEvidence: [
			{
				boundaryId: "boundary-safety",
				boundaryDigest: canonicalBoundaryDigest,
				disposition: "pass",
				evidence: boundary,
			},
		],
		invariantEvidence: [{ invariantId: "invariant-safety", disposition: "pass", evidence: invariant }],
		redTeamEvidence: { independence: "independent", disposition: "pass", evidence: redTeam },
		independentApproval: {
			decision: approvalDecisionRecord,
			decisionWitness: approvalWitness,
			bindingDigest: approvalReceipt.bindingDigest,
			workerId: approvalWorkerId,
			workerRole: "scope_adjudicator",
			workerAttestationDigest: approvalAttestationDigest,
		},
		restoreRehashProofs: [
			{
				manifestGeneration: 1,
				manifestDigest: parsedContract.inputManifest.manifestDigest,
				independence: "independent",
				restoration: "verified",
				rehash: "verified",
				manifestArtifacts: [physicalManifestOne],
				manifestArtifactDigest: manifestArtifactDigest(1, parsedContract.inputManifest.manifestDigest, [
					physicalManifestOne,
				]),
				evidence: restoreOne,
			},
			{
				manifestGeneration: 2,
				manifestDigest: SECOND_MANIFEST_DIGEST,
				independence: "independent",
				restoration: "verified",
				rehash: "verified",
				manifestArtifacts: [physicalManifestTwo],
				manifestArtifactDigest: manifestArtifactDigest(2, SECOND_MANIFEST_DIGEST, [physicalManifestTwo]),
				evidence: restoreTwo,
			},
		],
	};
	return { input, redTeam };
}

function contractWithHoldoutLeakage(value: AutoResearchPortfolioContract): AutoResearchPortfolioContract {
	const clone = structuredClone(value);
	const mutableModelAccess = clone.inputManifest.modelAccess as {
		holdoutRowsVisible: boolean;
		holdoutPerCaseFeedback: boolean;
		holdoutReturns: string;
		signedAggregateEvidence: boolean;
	};
	mutableModelAccess.holdoutRowsVisible = true;
	return clone;
}

async function decide(
	input: PortfolioLearningScopeAdmissionInput,
	scope: PortfolioLearningScopeAdmissionInput["requestedScope"],
) {
	if (scope === "never") return await admitPortfolioLearningScope({ ...input, requestedScope: scope });
	return await admitPortfolioLearningScope(await rebindInputForScope(input, scope));
}

describe("schema-v3 portfolio learning-scope admission", () => {
	it("admits goal learning only with exact goal, evaluator, and boundary closure", async () => {
		const { input } = await fixture();
		const accepted = await decide(input, "goal");
		const wrongGoal = await decide({ ...input, goalClosure: { ...input.goalClosure, goalId: "goal-2" } }, "goal");
		const wrongEvaluator = await decide(
			{ ...input, goalClosure: { ...input.goalClosure, evaluatorDigest: "c".repeat(64) } },
			"goal",
		);
		const wrongBoundary = await decide(
			{ ...input, goalClosure: { ...input.goalClosure, boundaryDigest: "c".repeat(64) } },
			"goal",
		);
		const boundaryViolation = await decide(
			{
				...input,
				boundaryEvidence: [{ ...input.boundaryEvidence[0]!, disposition: "violation" as const }],
			},
			"goal",
		);

		expect(accepted.canPromote).toBe(true);
		expect((await decide(input, "goal")).canPromote).toBe(true);
		expect(wrongGoal.rejectionReasons).toContain("goal_closure_mismatch");
		expect(wrongEvaluator.rejectionReasons).toContain("evaluator_closure_mismatch");
		expect(wrongBoundary.rejectionReasons).toContain("boundary_closure_mismatch");
		expect(boundaryViolation.rejectionReasons).toContain("boundary_violation");
	});

	it("rejects goal-to-domain escalation without fresh independent transfer across the approved family manifest", async () => {
		const { input } = await fixture();
		const missing = await decide({ ...input, domainTransferEvidence: [] }, "domain");
		const stale = await decide(
			{
				...input,
				domainTransferEvidence: input.domainTransferEvidence.map((entry, index) =>
					index === 0 ? { ...entry, freshness: "stale" as const } : entry,
				),
			},
			"domain",
		);
		const overlap = await decide(
			{
				...input,
				domainTransferEvidence: input.domainTransferEvidence.map((entry, index) =>
					index === 1 ? { ...entry, solutionFamilyId: "family-transfer-1" } : entry,
				),
			},
			"domain",
		);

		const acceptedDomain = await decide(input, "domain");
		expect(acceptedDomain.canPromote).toBe(true);
		expect(missing.rejectionReasons).toContain("domain_transfer_evidence_missing");
		expect(stale.rejectionReasons).toContain("domain_transfer_evidence_not_fresh");
		expect(overlap.rejectionReasons).toContain("solution_family_overlap");
	});

	it("requires preregistered cross-domain transfer, invariant safety, independent red-team, approval, and restore proofs globally", async () => {
		const { input, redTeam } = await fixture();
		const noPreregistration = await decide(
			{ ...input, crossDomainTransfer: { ...input.crossDomainTransfer!, preregistration: "post_hoc" } },
			"global",
		);
		const invariantRegression = await decide(
			{ ...input, invariantEvidence: [{ ...input.invariantEvidence[0]!, disposition: "regressed" as const }] },
			"global",
		);
		const noRedTeam = await decide({ ...input, redTeamEvidence: null }, "global");
		const noApproval = await decide({ ...input, independentApproval: null }, "global");
		const missingRestore = await decide({ ...input, restoreRehashProofs: [] }, "global");
		const wrongRestoreGeneration = await decide(
			{
				...input,
				restoreRehashProofs: input.restoreRehashProofs.map((proof, index) =>
					index === 0 ? { ...proof, manifestGeneration: 99 } : proof,
				),
			},
			"global",
		);

		const acceptedGlobal = await decide(input, "global");
		expect(acceptedGlobal.canPromote).toBe(true);
		expect(noPreregistration.rejectionReasons).toContain("cross_domain_transfer_not_preregistered");
		expect(invariantRegression.rejectionReasons).toContain("protected_invariant_regression");
		expect(noRedTeam.rejectionReasons).toContain("red_team_missing");
		expect(noApproval.rejectionReasons).toContain("wider_scope_approval_missing");
		expect(missingRestore.rejectionReasons).toContain("manifest_restore_rehash_missing");
		expect(wrongRestoreGeneration.rejectionReasons).toContain("manifest_restore_rehash_missing");
		expect(redTeam.receipt.receiptKind).toBe("artifact");
	});

	it("rejects holdout leakage, unknown acquisition, provider-empty or partial coverage, and closure mismatches", async () => {
		const { input } = await fixture();
		const holdoutLeak = { ...input, contract: contractWithHoldoutLeakage(input.contract) };
		const unknownAcquisition = {
			...input,
			originatingVectorEvidence: {
				...input.originatingVectorEvidence,
				evidence: [{ ...input.originatingVectorEvidence.evidence[0]!, acquisition: "unknown" as const }],
			},
		} as unknown as PortfolioLearningScopeAdmissionInput;
		const providerEmpty = {
			...input,
			originatingVectorEvidence: {
				...input.originatingVectorEvidence,
				evidence: [{ ...input.originatingVectorEvidence.evidence[0]!, coverage: "provider_empty" as const }],
			},
		};
		const partialCoverage = {
			...input,
			originatingVectorEvidence: {
				...input.originatingVectorEvidence,
				evidence: [{ ...input.originatingVectorEvidence.evidence[0]!, coverage: "partial_coverage" as const }],
			},
		};
		const closureMismatch = {
			...input,
			originatingVectorEvidence: {
				...input.originatingVectorEvidence,
				evidence: [{ ...input.originatingVectorEvidence.evidence[0]!, closureRootDigest: "c".repeat(64) }],
			},
		};

		expect((await decide(holdoutLeak, "goal")).rejectionReasons).toContain("holdout_row_feedback");
		expect((await decide(unknownAcquisition, "goal")).rejectionReasons).toContain("acquisition_unknown_or_missing");
		expect((await decide(providerEmpty, "goal")).rejectionReasons).toContain("provider_empty");
		expect((await decide(partialCoverage, "goal")).rejectionReasons).toContain("partial_coverage");
		expect((await decide(closureMismatch, "goal")).rejectionReasons).toContain("dataset_closure_binding_mismatch");
	});

	it("does not authorize scalar-only, parameter-only, one-off, self-reported, or post-hoc evidence", async () => {
		const { input, redTeam } = await fixture();
		const scalarOnly = {
			...input,
			originatingVectorEvidence: undefined,
			scalarEffectSize: 2,
		} as Partial<PortfolioLearningScopeAdmissionInput> as PortfolioLearningScopeAdmissionInput;
		const parameterOnly = {
			...input,
			candidate: {
				...input.candidate,
				change: { ...input.candidate.change, parameterChanges: ["temperature"] },
			} as AutoResearchPortfolioCandidate,
		};
		const oneOff = {
			...input,
			candidate: { ...input.candidate, oneOffPatch: true } as AutoResearchPortfolioCandidate,
		};
		const selfReported = {
			...input,
			originatingVectorEvidence: { ...input.originatingVectorEvidence, selfReport: true },
		} as PortfolioLearningScopeAdmissionInput;
		const safetyException = { ...input, safetyException: true } as PortfolioLearningScopeAdmissionInput;
		const rawOutcome = { ...input, rawOutcome: { value: 1 } } as PortfolioLearningScopeAdmissionInput;
		const postHoc = {
			...input,
			frontierDisposition: { status: "exploratory" as const, postHocCrossGoalGain: "unconfirmed" as const },
		};
		const selfApproved = {
			...input,
			independentApproval: {
				decision: {
					...input.independentApproval!.decision,
					hostAdjudication: {
						...input.independentApproval!.decision.hostAdjudication,
						hostReceipt: redTeam.receipt,
					},
				} as WorkflowDecisionRecord,
				decisionWitness: { ...redTeam.witness, witnessKind: "decision" as const },
				bindingDigest: redTeam.receipt.bindingDigest,
			},
		} as unknown as PortfolioLearningScopeAdmissionInput;

		expect((await decide(scalarOnly, "domain")).canPromote).toBe(false);
		expect((await decide(scalarOnly, "domain")).rejectionReasons).toContain("originating_vector_evidence_missing");
		expect((await decide(scalarOnly, "domain")).rejectionReasons).toContain("scalar_effect_cannot_authorize_scope");
		expect((await decide(parameterOnly, "goal")).rejectionReasons).toContain("forbidden_parameter_settings");
		expect((await decide(oneOff, "goal")).rejectionReasons).toContain("forbidden_one_off_patch");
		expect((await decide(selfReported, "goal")).rejectionReasons).toContain("forbidden_self_report");
		expect((await decide(safetyException, "goal")).rejectionReasons).toContain("forbidden_safety_exception");
		expect((await decide(rawOutcome, "goal")).rejectionReasons).toContain("forbidden_raw_outcomes");
		expect((await decide(postHoc, "domain")).rejectionReasons).toContain("post_hoc_cross_goal_gain_unconfirmed");
		expect((await decide(selfApproved, "global")).rejectionReasons).toContain("wider_scope_self_approved");
	});

	it("requires resolver-authenticated receipts, exact witnesses, current heads, and one-use consumption", async () => {
		const { input } = await fixture();
		const vectorEvidence = input.originatingVectorEvidence.evidence[0]!;
		const forgedReceipt = await decide(
			{
				...input,
				originatingVectorEvidence: {
					...input.originatingVectorEvidence,
					evidence: [
						{
							...vectorEvidence,
							receipt: { ...vectorEvidence.receipt, signature: "forged" },
						},
					],
				},
			},
			"goal",
		);
		const forgedWitness = await decide(
			{
				...input,
				originatingVectorEvidence: {
					...input.originatingVectorEvidence,
					evidence: [{ ...vectorEvidence, witness: { ...vectorEvidence.witness, payloadDigest: "forged" } }],
				},
			},
			"goal",
		);
		const staleHead = await decide({ ...input, currentStateHeadDigest: "stale-head" }, "goal");
		const replay = await decide(
			{
				...input,
				originatingVectorEvidence: {
					...input.originatingVectorEvidence,
					evidence: [vectorEvidence, vectorEvidence],
				},
			},
			"goal",
		);

		expect(forgedReceipt.rejectionReasons).toContain("host_receipt_missing_or_invalid");
		expect(forgedWitness.rejectionReasons).toContain("host_witness_missing_or_invalid");
		expect(staleHead.rejectionReasons).toContain("host_witness_missing_or_invalid");
		expect(replay.rejectionReasons).toContain("host_receipt_replay");
	});

	it("rejects caller-shaped nested aliases, symbols, and relabeled solution families", async () => {
		const { input } = await fixture();
		const nestedAlias = {
			...input,
			candidate: { ...input.candidate, runState: { alias: "forged" } },
		} as PortfolioLearningScopeAdmissionInput;
		const symbol = Symbol("runState");
		const symbolCandidate = { ...input.candidate, [symbol]: true } as unknown as AutoResearchPortfolioCandidate;
		const symbolInput = { ...input, candidate: symbolCandidate };
		const relabeledFamily = {
			...input,
			candidate: {
				...input.candidate,
				solutionFamily: { ...input.candidate.solutionFamily, name: "unrelated family" },
			},
		};

		expect((await decide(nestedAlias, "goal")).canPromote).toBe(false);
		expect((await decide(symbolInput, "goal")).canPromote).toBe(false);
		expect((await decide(relabeledFamily, "goal")).rejectionReasons).toContain("candidate_invalid");
	});

	it("rejects invalid frontier enums, forged worker approval, and caller-supplied boundary digests", async () => {
		const { input } = await fixture();
		const invalidEnum = {
			...input,
			frontierDisposition: { status: "unexpected", postHocCrossGoalGain: "unexpected" },
		} as unknown as PortfolioLearningScopeAdmissionInput;
		const forgedWorkerApproval = {
			...input,
			independentApproval: {
				...input.independentApproval!,
				decision: {
					...input.independentApproval!.decision,
					hostAdjudication: {
						...input.independentApproval!.decision.hostAdjudication,
						executionIdentity: "worker-forged-approval",
					},
				} as WorkflowDecisionRecord,
			},
		};
		const forgedBoundaryDigest = "f".repeat(64);
		const callerBoundaryDigest = {
			...input,
			originatingVectorEvidence: { ...input.originatingVectorEvidence, boundaryDigest: forgedBoundaryDigest },
			goalClosure: { ...input.goalClosure, boundaryDigest: forgedBoundaryDigest },
			boundaryEvidence: input.boundaryEvidence.map((entry) => ({ ...entry, boundaryDigest: forgedBoundaryDigest })),
		};

		expect((await decide(invalidEnum, "goal")).canPromote).toBe(false);
		expect((await decide(forgedWorkerApproval, "global")).rejectionReasons).toContain("wider_scope_approval_missing");
		expect((await decide(callerBoundaryDigest, "goal")).rejectionReasons).toContain("boundary_closure_mismatch");
	});

	it("requires complete invariant evidence at every promotable scope", async () => {
		const { input } = await fixture();
		const missingInvariant = { ...input, invariantEvidence: [] };
		const result = await decide(missingInvariant, "goal");

		expect(result.canPromote).toBe(false);
		expect(result.rejectionReasons).toContain("protected_invariant_regression");
	});

	it("rejects stale receipts and resolver-returned artifact bytes at the public boundary", async () => {
		const { input } = await fixture();
		const vectorEvidence = input.originatingVectorEvidence.evidence[0]!;
		const staleReceipt = await decide(
			{
				...input,
				originatingVectorEvidence: {
					...input.originatingVectorEvidence,
					evidence: [{ ...vectorEvidence, receipt: { ...vectorEvidence.receipt, issuedAt: LATER } }],
				},
			},
			"goal",
		);
		const originalResolver = input.receiptContext.artifactResolver;
		const mutatedContext = {
			...input.receiptContext,
			artifactResolver: {
				resolve: async (ref: WorkflowArtifactRef) => {
					const resolved = await originalResolver.resolve(ref);
					return { ...resolved, bytes: new Uint8Array(resolved.bytes.length) };
				},
			},
		};
		const mutatedArtifact = await decide({ ...input, receiptContext: mutatedContext }, "goal");

		expect(staleReceipt.rejectionReasons).toContain("host_receipt_missing_or_invalid");
		expect(mutatedArtifact.rejectionReasons).toContain("host_receipt_missing_or_invalid");
	});

	it("keeps never terminal and reports no application or mutation on every rejection", async () => {
		const { input } = await fixture();
		const never = await decide(input, "never");
		const rejected = await decide({ ...input, approvedGoalFamilyManifest: [] }, "domain");

		expect(never.canPromote).toBe(false);
		expect(never.effectiveScope).toBe("never");
		expect(never.rejectionReasons).toContain("never_scope_requested");
		expect(rejected.canPromote).toBe(false);
		expect(rejected.applicationCount).toBe(0);
		expect(rejected.mutationCount).toBe(0);
	});

	it("is input-order invariant and does not mutate closed input", async () => {
		const { input } = await fixture();
		const before = structuredClone({ ...input, receiptContext: null });
		const reordered: PortfolioLearningScopeAdmissionInput = {
			...input,
			approvedGoalFamilyManifest: [...input.approvedGoalFamilyManifest].reverse(),
			domainTransferEvidence: [...input.domainTransferEvidence].reverse(),
			boundaryEvidence: [...input.boundaryEvidence].reverse(),
			invariantEvidence: [...input.invariantEvidence].reverse(),
			restoreRehashProofs: [...input.restoreRehashProofs].reverse(),
		};

		expect(await admitPortfolioLearningScope(input)).toEqual(await admitPortfolioLearningScope(reordered));
		expect({ ...input, receiptContext: null }).toEqual(before);
	});

	it("requires typed knowledge-promotion authorization and rejects a forged principal", async () => {
		const { input } = await fixture();
		let calls = 0;
		const originalAuthorizer = input.receiptContext.principalAuthorizer;
		const forgedPrincipalContext = {
			...input.receiptContext,
			principalAuthorizer: {
				authorize: async (authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput) => {
					calls += 1;
					const authorization = await originalAuthorizer.authorize(authorizationInput);
					return { ...authorization, authenticatedPrincipal: "caller-forged" };
				},
			},
		};
		const result = await decide({ ...input, receiptContext: forgedPrincipalContext }, "goal");

		expect(calls).toBeGreaterThan(0);
		expect(result.canPromote).toBe(false);
	});

	it("rejects worker substitution and capability substitution at the host boundary", async () => {
		const { input } = await fixture();
		const vectorEvidence = input.originatingVectorEvidence.evidence[0]!;
		const workerSubstitution = await decide(
			{
				...input,
				originatingVectorEvidence: {
					...input.originatingVectorEvidence,
					evidence: [{ ...vectorEvidence, workerId: "foreign-worker" }],
				},
			},
			"goal",
		);
		const originalAuthorizer = input.receiptContext.principalAuthorizer;
		const capabilitySubstitutionContext = {
			...input.receiptContext,
			principalAuthorizer: {
				authorize: async (authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput) => {
					const authorization = await originalAuthorizer.authorize(authorizationInput);
					return { ...authorization, capability: "autoresearch_portfolio_frontier_admission" as const };
				},
			},
		};
		const capabilitySubstitution = await decide(
			{ ...input, receiptContext: capabilitySubstitutionContext },
			"global",
		);

		expect(workerSubstitution.canPromote).toBe(false);
		expect(workerSubstitution.rejectionReasons).toContain("host_receipt_missing_or_invalid");
		expect(capabilitySubstitution.canPromote).toBe(false);
		expect(capabilitySubstitution.rejectionReasons).toContain("host_principal_authorization_invalid");
	});
});
