import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AutoResearchPortfolioCandidate,
	type AutoResearchPortfolioContract,
	type AutoResearchPortfolioMeasurement,
	autoResearchPortfolioCandidateDigest,
	autoResearchPortfolioContractDigest,
	autoResearchPortfolioMeasurementDigest,
	parseAutoResearchPortfolioCandidate,
	parseAutoResearchPortfolioContract,
	parseAutoResearchPortfolioMeasurement,
} from "../src/core/autoresearch/portfolio-contracts.js";
import {
	composePortfolioKnowledge,
	type PortfolioKnowledgeCompositionInput,
	portfolioKnowledgePromotionAuthorityDigests,
} from "../src/core/autoresearch/portfolio-knowledge.js";
import type {
	PortfolioLearningHostEvidence,
	PortfolioLearningScopeAdmissionInput,
	PortfolioLearningScopeDecision,
} from "../src/core/autoresearch/portfolio-learning-scope.js";
import type {
	PortfolioTerminalEvaluation,
	PortfolioTerminalInput,
} from "../src/core/autoresearch/portfolio-terminal.js";
import type { KnowledgeDurableStore } from "../src/core/knowledge/knowledge-durable-adapter.js";
import {
	createKnowledgeStore,
	type KnowledgeCommitRequest,
	type KnowledgeStore,
} from "../src/core/knowledge/knowledge-store.js";
import { createKnowledgeMempalaceBoundary } from "../src/core/knowledge/mempalace-boundary.js";
import { type KnowledgeEvent, type KnowledgeProjection, reduceKnowledgeEvent } from "../src/core/knowledge/records.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import type { WorkflowLearningHostWitness } from "../src/core/workflow/learning-controller.js";
import type { WorkflowLearningRuntimeAdapter } from "../src/core/workflow/learning-runtime-adapter.js";
import {
	bindFixtureKnowledgeAuthority,
	EPOCH,
	hostValidators,
	LEASE,
	proposal,
	RECEIPT_CONTEXT,
	TRUSTED_NOW,
} from "./knowledge-fixtures.js";

const DIGEST = "a".repeat(64);
const ROOT_DIGEST = "b".repeat(64);
const TRAINING_ROOT = "c".repeat(64);
const VALIDATION_ROOT = "d".repeat(64);
const HOLDOUT_ROOT = "e".repeat(64);
const WORKFLOW_ID = "workflow-1";
const LATER = "2026-08-16T16:30:00.000Z";

const { admitScopeMock, evaluateTerminalMock } = vi.hoisted(() => ({
	admitScopeMock: vi.fn(),
	evaluateTerminalMock: vi.fn(),
}));

// Gate stubs keep this acceptance test focused on the public bridge sequencing;
// the canonical KnowledgeStore and MemPalace path below is real and reopened.
vi.mock("../src/core/autoresearch/portfolio-learning-scope.js", () => ({
	admitPortfolioLearningScope: admitScopeMock,
}));
vi.mock("../src/core/autoresearch/portfolio-terminal.js", () => ({
	evaluatePortfolioTerminal: evaluateTerminalMock,
}));

function splitRoots(): { training: string; validation: string; holdout: string } {
	return { training: TRAINING_ROOT, validation: VALIDATION_ROOT, holdout: HOLDOUT_ROOT };
}

function datasetArtifact(split: "training" | "validation" | "holdout"): Record<string, unknown> {
	const sourceTime =
		split === "training"
			? ["2024-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"]
			: split === "validation"
				? ["2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]
				: ["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"];
	const accessAuthority =
		split === "training"
			? "training_workers_training_only"
			: split === "validation"
				? "validation_evaluator_host_only"
				: "holdout_host_aggregate_only";
	return {
		split,
		objectUri: `memory://portfolio/${split}/1`,
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
			sourceSystem: "fixture",
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
	const splitManifest = (split: "training" | "validation" | "holdout"): Record<string, unknown> => ({
		locked: true,
		split,
		closureRootDigest: split === "training" ? TRAINING_ROOT : split === "validation" ? VALIDATION_ROOT : HOLDOUT_ROOT,
		artifacts: [datasetArtifact(split)],
	});
	const withoutDigest = {
		locked: true,
		evaluationEpoch: 1,
		manifestRevision: 1,
		closureRootDigest: ROOT_DIGEST,
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
		training: splitManifest("training"),
		validation: splitManifest("validation"),
		holdout: splitManifest("holdout"),
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
	return { ...withoutDigest, manifestDigest: digestObject(withoutDigest) };
}

function portfolioContract(): AutoResearchPortfolioContract {
	const manifest = inputManifest();
	const manifestDigest = manifest.manifestDigest as string;
	const metric = {
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
		inputManifestDigest: manifestDigest,
		splitClosureRoots: splitRoots(),
	};
	const goal = {
		goalId: "goal-1",
		domainId: "domain-1",
		title: "Quality",
		description: "Improve quality under the host evaluator.",
		scope: "terminal",
		metrics: [metric],
		baseline: {
			locked: true,
			measurementId: "baseline-1",
			metricValues: [{ metricId: "quality", value: 0.5 }],
			evidenceDigest: DIGEST,
			evaluationEpoch: 1,
			closureRootDigest: ROOT_DIGEST,
			inputManifestDigest: manifestDigest,
			splitClosureRoots: splitRoots(),
		},
		evaluator: {
			locked: true,
			evaluatorId: "evaluator-1",
			sourceDigest: DIGEST,
			inputDigest: DIGEST,
			environmentDigest: DIGEST,
			evaluatorDigest: "",
			evaluationEpoch: 1,
			evaluatorRevision: 1,
			closureRootDigest: ROOT_DIGEST,
			inputManifestDigest: manifestDigest,
			splitClosureRoots: splitRoots(),
		},
		parser: {
			locked: true,
			parserId: "parser-1",
			kind: "json_object",
			metricKeys: ["quality"],
			parserDigest: "",
			evaluationEpoch: 1,
			inputManifestRevision: 1,
			closureRootDigest: ROOT_DIGEST,
			inputManifestDigest: manifestDigest,
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
	const { evaluatorDigest: _evaluatorDigest, ...evaluatorWithoutDigest } = goal.evaluator;
	goal.evaluator.evaluatorDigest = digestObject(evaluatorWithoutDigest);
	const { parserDigest: _parserDigest, ...parserWithoutDigest } = goal.parser;
	goal.parser.parserDigest = digestObject(parserWithoutDigest);
	const requirement = {
		requirementId: "requirement-quality",
		statement: "Quality meets the locked target.",
		locked: true,
		requirementDigest: digestObject({
			requirementId: "requirement-quality",
			statement: "Quality meets the locked target.",
			locked: true,
		}),
	};
	return parseAutoResearchPortfolioContract({
		schemaVersion: 3,
		contractId: "portfolio-1",
		objective: "Improve quality under fixed host boundaries.",
		acceptanceRequirements: [requirement],
		goals: [goal],
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

function portfolioCandidate(): AutoResearchPortfolioCandidate {
	const solutionFamily = {
		familyId: "family-origin",
		name: "causal representation",
		mechanismClass: "representation",
	};
	const mechanismWithoutDigest = {
		hypothesis: "A representation separates regimes.",
		intervention: "Replace the shared representation.",
		expectedObservation: "Quality improves on the sealed sample.",
		falsificationCondition: "The improvement disappears on fresh evidence.",
	};
	const causalMechanism = {
		...mechanismWithoutDigest,
		mechanismDigest: digestObject({ solutionFamily, ...mechanismWithoutDigest }),
	};
	const changeWithoutDigest = { kind: "mechanism", changedPaths: ["src/model.ts"], parameterChanges: [] };
	const change = { ...changeWithoutDigest, changeDigest: digestObject(changeWithoutDigest) };
	return parseAutoResearchPortfolioCandidate({
		candidateId: "candidate-1",
		goalIds: ["goal-1"],
		solutionFamily,
		ancestry: { parentCandidateIds: [], baseDigest: DIGEST, lineageDigest: DIGEST },
		causalMechanism,
		change,
		scope: "terminal",
	});
}

function portfolioMeasurement(
	contract: AutoResearchPortfolioContract,
	candidate: AutoResearchPortfolioCandidate,
): AutoResearchPortfolioMeasurement {
	const goal = contract.goals[0]!;
	const withoutDigest = {
		measurementId: "measurement-candidate-1",
		goalId: goal.goalId,
		candidateId: candidate.candidateId,
		scope: "terminal" as const,
		kind: "candidate" as const,
		vector: [{ metricId: "quality", value: 0.9 }],
		repeatIndex: 1,
		sampleCount: 3,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		inputManifestDigest: contract.inputManifest.manifestDigest,
		splitClosureRoots: contract.inputManifest.splitClosureRoots,
		confidenceInterval: { lower: 0.75, upper: 0.9, level: goal.uncertainty.confidence },
		variance: 0.001,
		runCount: goal.repeatability.runs,
		aggregation: goal.repeatability.aggregation,
		inputDigest: contract.inputManifest.manifestDigest,
		evaluatorDigest: goal.evaluator.evaluatorDigest,
		parserDigest: goal.parser.parserDigest,
		commandDigest: goal.command.commandDigest,
		workspaceDigest: DIGEST,
		evidenceDigests: [DIGEST],
		measuredAt: TRUSTED_NOW,
	};
	return parseAutoResearchPortfolioMeasurement({ ...withoutDigest, measurementDigest: digestObject(withoutDigest) });
}

function artifactRef(id: string): WorkflowArtifactRef {
	const bytes = canonicalJsonBytes({ id });
	return {
		artifactId: id,
		relativePath: `evidence/${id}.json`,
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: 1,
	};
}

function hostReceipt(
	id: string,
	options: Partial<Pick<WorkflowVerifiedHostReceipt, "oneUse" | "bindingDigest" | "payloadDigest" | "issuerId">> = {},
): WorkflowVerifiedHostReceipt {
	return createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: id,
		issuerId: options.issuerId ?? "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: options.bindingDigest ?? DIGEST,
		payloadDigest: options.payloadDigest ?? DIGEST,
		artifactRef: artifactRef(id),
		issuedAt: TRUSTED_NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		oneUse: options.oneUse ?? false,
		stateDigest: "state-1",
		revision: 1,
	});
}

function knowledgePromotionReceiptContext(calls: string[] = []): WorkflowHostReceiptConsumerContext {
	const base = createFixtureHostReceiptConsumerContext();
	let context: WorkflowHostReceiptConsumerContext;
	const principalAuthorizer = {
		authorize: async (authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput) => {
			calls.push("authorize");
			const verified = await resolveAndVerifyWorkflowHostReceipt({
				context,
				workflowId: authorizationInput.workflowId,
				expectedBindingDigest: authorizationInput.bindingDigest,
				receipt: authorizationInput.receipt,
				currentStateDigest: authorizationInput.stateDigest,
				currentRevision: authorizationInput.revision,
				trustedNow: authorizationInput.receipt.issuedAt,
			});
			return {
				authenticatedPrincipal: "fixture-host",
				keyOwnerPrincipal: "fixture-host",
				capability: authorizationInput.capability,
				workflowId: authorizationInput.workflowId,
				bindingDigest: authorizationInput.bindingDigest,
				receipt: verified,
				stateDigest: authorizationInput.stateDigest,
				revision: authorizationInput.revision,
				epochRef: authorizationInput.epochRef,
				validity: { issuedAt: verified.issuedAt, validUntil: verified.validUntil },
				executionIdentity: authorizationInput.executionIdentity,
				sessionId: authorizationInput.sessionId,
				authorizationDigest: digestObject({
					kind: "fixture-knowledge-promotion-authorization",
					capability: authorizationInput.capability,
					workflowId: authorizationInput.workflowId,
					bindingDigest: authorizationInput.bindingDigest,
					receipt: digestObject(verified),
					resourceDigest: authorizationInput.resourceDigest,
					operationDigest: authorizationInput.operationDigest,
					stateDigest: authorizationInput.stateDigest,
					revision: authorizationInput.revision,
					epochRef: authorizationInput.epochRef,
					executionIdentity: authorizationInput.executionIdentity ?? null,
					sessionId: authorizationInput.sessionId ?? null,
				}),
			};
		},
	};
	context = {
		...base,
		receiptResolver: {
			...base.receiptResolver,
			consumeIfOneUse: async (input) => {
				calls.push("consume");
				await base.receiptResolver.consumeIfOneUse(input);
			},
			resolveConsumptionWitness: async (input) => ({
				...(await base.receiptResolver.resolveConsumptionWitness(input)),
				consumedAt: TRUSTED_NOW,
			}),
		},
		keyResolver: {
			resolve: async (keyId) => {
				const key = await base.keyResolver.resolve(keyId);
				return {
					...key,
					ownerPrincipal: keyId === "red-team-key" ? "red-team-host" : "fixture-host",
					epochRef: EPOCH,
					fencingDigest: digestObject({ generationId: key.generationId, epochRef: EPOCH }),
				};
			},
		},
		principalAuthorizer,
	};
	return context;
}

function hostWitness(receipt: WorkflowVerifiedHostReceipt, stage: string): WorkflowLearningHostWitness {
	return {
		witnessId: `witness-${receipt.receiptId}`,
		witnessKind: "receipt",
		workflowId: WORKFLOW_ID,
		stage,
		candidateId: "candidate-1",
		evidenceRef: receipt.artifactRef,
		payloadDigest: receipt.bindingDigest,
		bytesDigest: receipt.artifactRef.digest,
		bytesSize: receipt.artifactRef.sizeBytes,
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		stateHeadDigest: "head-1",
		trustedNow: TRUSTED_NOW,
		oneUse: true,
	};
}

async function redTeamEvidence(
	context: ReturnType<typeof createFixtureHostReceiptConsumerContext>,
	contract: AutoResearchPortfolioContract,
	candidate: AutoResearchPortfolioCandidate,
	measurement: AutoResearchPortfolioMeasurement,
): Promise<PortfolioLearningHostEvidence> {
	const seed = hostReceipt("red-team-seed", { issuerId: "red-team-host", oneUse: true });
	const evidenceBase = {
		artifactRef: seed.artifactRef,
		workspaceDigest: measurement.workspaceDigest,
		workerId: "red-team-host",
		workerRole: "red_team" as const,
		executionIdentity: "red-team-execution",
		sessionId: "red-team-session",
		closureRootDigest: contract.inputManifest.closureRootDigest,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		acquisition: "complete" as const,
		coverage: "complete" as const,
	};
	const workerAttestationDigest = digestObject({
		kind: "portfolio-learning-host-worker-attestation",
		workflowId: WORKFLOW_ID,
		candidateId: candidate.candidateId,
		candidateDigest: autoResearchPortfolioCandidateDigest(candidate),
		contractDigest: autoResearchPortfolioContractDigest(contract),
		measurementDigest: autoResearchPortfolioMeasurementDigest(measurement),
		workerId: evidenceBase.workerId,
		workerRole: evidenceBase.workerRole,
		artifactRef: evidenceBase.artifactRef,
	});
	const bindingDigest = digestObject({
		kind: "portfolio-learning-host-evidence-binding",
		workflowId: WORKFLOW_ID,
		candidateId: candidate.candidateId,
		candidateDigest: autoResearchPortfolioCandidateDigest(candidate),
		contractDigest: autoResearchPortfolioContractDigest(contract),
		measurementDigest: autoResearchPortfolioMeasurementDigest(measurement),
		workspaceDigest: measurement.workspaceDigest,
		workerId: evidenceBase.workerId,
		workerRole: evidenceBase.workerRole,
		workerAttestationDigest,
		executionIdentity: evidenceBase.executionIdentity,
		sessionId: evidenceBase.sessionId,
		witnessKind: "receipt",
		stage: "red_team",
		semantic: { kind: "red_team", independence: "independent", disposition: "pass" },
		artifactRef: evidenceBase.artifactRef,
		closureRootDigest: evidenceBase.closureRootDigest,
		evaluationEpoch: evidenceBase.evaluationEpoch,
		acquisition: evidenceBase.acquisition,
		coverage: evidenceBase.coverage,
	});
	const payloadDigest = digestObject({
		kind: "portfolio-learning-host-evidence-payload",
		bindingDigest,
		receiptKind: "artifact",
		semantic: { kind: "red_team", independence: "independent", disposition: "pass" },
		workerId: evidenceBase.workerId,
		workerRole: evidenceBase.workerRole,
		artifactRef: evidenceBase.artifactRef,
	});
	const receipt = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: "red-team-receipt",
		issuerId: "red-team-host",
		workflowId: WORKFLOW_ID,
		bindingDigest,
		payloadDigest,
		artifactRef: evidenceBase.artifactRef,
		issuedAt: TRUSTED_NOW,
		validUntil: LATER,
		keyId: "red-team-key",
		oneUse: true,
		stateDigest: "state-1",
		revision: 1,
	});
	await resolveAndVerifyWorkflowHostReceipt({
		context,
		workflowId: WORKFLOW_ID,
		expectedBindingDigest: bindingDigest,
		receipt,
		currentStateDigest: "state-1",
		currentRevision: 1,
		trustedNow: TRUSTED_NOW,
	});
	await context.receiptResolver.consumeIfOneUse({
		receipt,
		workflowId: WORKFLOW_ID,
		expectedBindingDigest: bindingDigest,
		currentRevision: 1,
	});
	return {
		...evidenceBase,
		receipt,
		witness: hostWitness(receipt, "red_team"),
		bindingDigest,
		workerAttestationDigest,
	};
}

function fakeDurableStore(): KnowledgeDurableStore {
	let state: KnowledgeProjection = { namespace: "knowledge", records: {}, history: [], sequence: 0, digest: null };
	const events: KnowledgeEvent[] = [];
	const authenticatedCommits = new Map<
		number,
		{
			eventDigest: string;
			sequence: number;
			epochRef: WorkflowEpochRef;
			generationId: string;
			keyId: string;
			recordMac: string;
			recordChecksum: string;
			committedFrameDigest: string;
			committedFrameMac: string;
			committedFrameChecksum: string;
		}
	>();
	const durable: KnowledgeDurableStore = {
		storeId: "knowledge-store",
		namespace: "knowledge",
		workflowId: "workflow-1",
		epochRef: EPOCH,
		generationId: "generation-1",
		currentLeaseRef: () => LEASE,
		kernelVersion: 1,
		journalInstanceId: "journal-1",
		leaseInstanceId: "lease-instance-1",
		snapshotInstanceId: "snapshot-1",
		reducerInstanceId: "reducer-1",
		read: async () =>
			structuredClone({
				state,
				sequence: state.sequence,
				digest: state.sequence === 0 ? null : `journal-digest-${state.sequence}`,
				projectionDigest: state.digest,
			}),
		commit: async (input) => {
			const sequence = events.length + 1;
			const digest = `journal-digest-${sequence}`;
			const event = input.semantic;
			events.push(event);
			state = reduceKnowledgeEvent(state, event);
			const head = { workflowId: "workflow-1", sequence, eventDigest: digest, epochRef: EPOCH };
			const authenticatedCommit = {
				eventDigest: digest,
				sequence,
				epochRef: EPOCH,
				generationId: "generation-1",
				keyId: "key-1",
				recordMac: `record-mac-${sequence}`,
				recordChecksum: `record-checksum-${sequence}`,
				committedFrameDigest: `frame-digest-${sequence}`,
				committedFrameMac: `frame-mac-${sequence}`,
				committedFrameChecksum: `frame-checksum-${sequence}`,
			};
			authenticatedCommits.set(sequence, authenticatedCommit);
			return {
				sequence,
				digest,
				replayed: false,
				idempotencyConflict: false,
				authenticatedEventDigest: digest,
				postCommitExtension: null,
				state,
				event,
				head,
				projectionDigest: state.digest ?? digestObject(state),
				authenticatedCommit,
			};
		},
		replay: async () => [...events],
		readAuthenticatedCommit: async (sequence) => structuredClone(authenticatedCommits.get(sequence) ?? null),
		recover: async () => ({
			status: "healthy" as const,
			metadata: {
				source: { artifactRef: null, relativePath: "events.log", digest: state.digest, sizeBytes: 0 },
				epochRef: EPOCH,
				reconciliation: null,
				quarantine: null,
			},
		}),
	};
	bindFixtureKnowledgeAuthority(durable, events);
	return durable;
}

function createStore(durable: KnowledgeDurableStore): KnowledgeStore {
	return createKnowledgeStore({
		durableStore: durable,
		namespace: "knowledge",
		receiptContext: RECEIPT_CONTEXT,
		trustedNow: () => TRUSTED_NOW,
		...hostValidators(),
	});
}

function learningRuntime(calls: string[]): WorkflowLearningRuntimeAdapter {
	return {
		commitExperience: async (input) => {
			calls.push("experience");
			return {
				...input,
				source: "host",
				validatedEvidenceDigests: [],
				evidenceDigest: DIGEST,
			} as unknown as Awaited<ReturnType<WorkflowLearningRuntimeAdapter["commitExperience"]>>;
		},
		typeCandidate: async ({ experienceId }) => {
			calls.push("candidate");
			return {
				candidateId: "candidate-1",
				experienceId,
				kind: "policy",
				mutationClass: "policy",
			} as unknown as Awaited<ReturnType<WorkflowLearningRuntimeAdapter["typeCandidate"]>>;
		},
		reviewCandidate: async (candidateId) => {
			calls.push("review");
			return { status: "promoted", promotion: { candidateId } } as unknown as Awaited<
				ReturnType<WorkflowLearningRuntimeAdapter["reviewCandidate"]>
			>;
		},
		handleTrigger: async () =>
			({}) as unknown as Awaited<ReturnType<WorkflowLearningRuntimeAdapter["handleTrigger"]>>,
		replay: async () => ({}) as unknown as Awaited<ReturnType<WorkflowLearningRuntimeAdapter["replay"]>>,
		getState: async () => ({}) as unknown as Awaited<ReturnType<WorkflowLearningRuntimeAdapter["getState"]>>,
	};
}

function promotedScope(): PortfolioLearningScopeDecision {
	return {
		requestedScope: "goal",
		effectiveScope: "goal",
		canPromote: true,
		exploratory: false,
		rejectionReasons: [],
		applicationCount: 0,
		mutationCount: 0,
	};
}

function successfulTerminal(contract: AutoResearchPortfolioContract): PortfolioTerminalEvaluation {
	return {
		accepted: true,
		outcome: "complete",
		goalDispositions: [{ goalId: "goal-1", disposition: "achieved" }],
		requiredGoalIds: ["goal-1"],
		unresolvedGoalIds: [],
		selectedFrontierEntryIds: [],
		reasons: [],
		authority: "host",
		workerCanAuthorize: false,
		candidateCanAuthorize: false,
		mutated: false,
		evaluationDigest: digestObject({
			contractDigest: autoResearchPortfolioContractDigest(contract),
			outcome: "complete",
		}),
	};
}

interface PositiveFixture {
	input: PortfolioKnowledgeCompositionInput;
	durable: KnowledgeDurableStore;
	store: KnowledgeStore;
	calls: string[];
}

async function positiveFixture(): Promise<PositiveFixture> {
	const contract = portfolioContract();
	const candidate = portfolioCandidate();
	const measurement = portfolioMeasurement(contract, candidate);
	const calls: string[] = [];
	const context = knowledgePromotionReceiptContext(calls);
	const terminalReceipt = hostReceipt("terminal-receipt");
	const vectorReceipt = terminalReceipt;
	const redTeam = await redTeamEvidence(context, contract, candidate, measurement);
	calls.length = 0;
	const vectorEvidence: PortfolioLearningHostEvidence = {
		artifactRef: vectorReceipt.artifactRef,
		receipt: vectorReceipt,
		witness: hostWitness(vectorReceipt, "vector_evaluator"),
		bindingDigest: DIGEST,
		workspaceDigest: measurement.workspaceDigest,
		workerId: "vector-host",
		workerRole: "vector_evaluator",
		executionIdentity: "vector-execution",
		sessionId: "vector-session",
		workerAttestationDigest: DIGEST,
		closureRootDigest: contract.inputManifest.closureRootDigest,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		acquisition: "complete",
		coverage: "complete",
	};
	const refinementArtifactRefs = [terminalReceipt.artifactRef, vectorReceipt.artifactRef, redTeam.artifactRef];
	const refinementExperience = {
		experienceId: "experience-1",
		workflowId: WORKFLOW_ID,
		source: "host" as const,
		outcome: "positive" as const,
		progressKind: "verified" as const,
		progressEvidenceRefs: refinementArtifactRefs,
		evidence: [],
		committedAt: TRUSTED_NOW,
		sourceEventRef: artifactRef("source-event"),
		hostReceipt: redTeam.receipt,
	};
	const refinementTrigger = {
		kind: "milestone" as const,
		candidateId: candidate.candidateId,
		sourceEventRef: artifactRef("trigger-event"),
		evidenceRefs: refinementArtifactRefs,
		workflowId: WORKFLOW_ID,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		stateHeadDigest: "head-1",
		evidenceDigest: DIGEST,
		hostReceipt: redTeam.receipt,
	};
	const durable = fakeDurableStore();
	const store = createStore(durable);
	const commit = store.commit.bind(store);
	store.commit = async (request) => {
		calls.push("knowledge");
		return commit(request);
	};
	const terminal: PortfolioTerminalInput = {
		contract,
		workflowId: WORKFLOW_ID,
		currentStateDigest: "state-1",
		currentRevision: 1,
		trustedNow: TRUSTED_NOW,
		receiptContext: context,
		measurements: [{ measurement, receipt: terminalReceipt }],
		frontier: {} as PortfolioTerminalInput["frontier"],
		boundaries: [],
		acquisition: {} as PortfolioTerminalInput["acquisition"],
		completion: {} as PortfolioTerminalInput["completion"],
		tradeoff: null,
		infeasibility: [],
		goalDecisions: [],
		stop: null,
	};
	const learning = {
		requestedScope: "goal" as const,
		receiptContext: context,
		workflowId: WORKFLOW_ID,
		currentRevision: 1,
		currentStateDigest: "state-1",
		currentStateHeadDigest: "head-1",
		currentStoreEpoch: EPOCH.storeEpoch,
		currentCoordinatorEpoch: EPOCH.coordinatorEpoch,
		trustedNow: TRUSTED_NOW,
		contract,
		candidate,
		measurement,
		frontierDisposition: { status: "accepted" as const, postHocCrossGoalGain: "none" as const },
		originatingVectorEvidence: {
			goalId: "goal-1",
			domainId: "domain-1",
			solutionFamilyId: "family-origin",
			evaluatorDigest: contract.goals[0]!.evaluator.evaluatorDigest,
			boundaryDigest: DIGEST,
			evidence: [vectorEvidence],
		},
		scopeJustification: "The approved goal is bounded to this workspace.",
		goalClosure: {
			goalId: "goal-1",
			evaluatorDigest: contract.goals[0]!.evaluator.evaluatorDigest,
			boundaryDigest: DIGEST,
		},
		approvedGoalFamilyManifest: [],
		domainTransferEvidence: [],
		crossDomainTransfer: null,
		boundaryEvidence: [],
		invariantEvidence: [],
		redTeamEvidence: { independence: "independent" as const, disposition: "pass" as const, evidence: redTeam },
		independentApproval: null,
		restoreRehashProofs: [],
	} as unknown as PortfolioLearningScopeAdmissionInput;
	const template = proposal({
		proposalId: "template-1",
		recordId: "template-record",
		procedure: { inputs: { command: "run" }, steps: ["run"], successChecks: ["pass"], failureChecks: ["fail"] },
		applicability: { namespace: "knowledge", scope: "workspace", workspaceId: "workspace-1" },
	});
	const request: KnowledgeCommitRequest = {
		proposal: template,
		mutationId: "template-1",
		idempotencyKey: "knowledge:template-1",
		expectedHead: { workflowId: "workflow-1", sequence: 0, eventDigest: null, epochRef: EPOCH },
		baselineDigest: "baseline-0",
		expectedGenerations: { knowledge: 1 },
		writerIdentity: "writer-1",
		leaseRef: LEASE,
		epochRef: EPOCH,
		executionKey: "execution-1",
		knowledgeStoreEpoch: EPOCH.storeEpoch,
	};
	const baseInput = {
		terminal,
		learning,
		lesson: {
			kind: "how",
			title: "A durable mechanism",
			statement: "Use the verified vector before changing policy.",
		},
		applicability: { namespace: "knowledge", workspaceId: "workspace-1" },
		knowledgeStore: store,
		knowledgeCommitRequest: request,
		mempalace: createKnowledgeMempalaceBoundary({ store }),
		learningRuntime: learningRuntime(calls),
		refinement: { experience: refinementExperience, trigger: refinementTrigger },
	} as unknown as PortfolioKnowledgeCompositionInput;
	admitScopeMock.mockResolvedValue(promotedScope());
	evaluateTerminalMock.mockResolvedValue(successfulTerminal(contract));
	const authorityIdentity = { executionIdentity: LEASE.processIdentity, sessionId: request.executionKey! };
	const authorityDigests = portfolioKnowledgePromotionAuthorityDigests(
		baseInput,
		promotedScope(),
		{ measurement, receipt: terminalReceipt },
		authorityIdentity,
	);
	const authorityReceipt = createFixtureHostReceipt({
		receiptKind: "capability",
		receiptId: "knowledge-promotion-authority",
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: authorityDigests.bindingDigest,
		payloadDigest: DIGEST,
		artifactRef: artifactRef("knowledge-promotion-authority"),
		issuedAt: TRUSTED_NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		oneUse: true,
		stateDigest: "state-1",
		revision: 1,
		capabilityBinding: {
			capability: "workflow_learning_knowledge_promotion",
			resourceDigest: authorityDigests.resourceDigest,
			operationDigest: authorityDigests.operationDigest,
			executionIdentity: authorityIdentity.executionIdentity,
			sessionId: authorityIdentity.sessionId,
		},
	});
	const input = {
		...baseInput,
		authority: { receipt: authorityReceipt, ...authorityIdentity },
	} as PortfolioKnowledgeCompositionInput;
	return { input, durable, store, calls };
}

describe("portfolio knowledge composition", () => {
	beforeEach(() => {
		admitScopeMock.mockReset();
		evaluateTerminalMock.mockReset();
	});

	it("exposes only the exact canonical store, MemPalace, and learning runtime boundaries", () => {
		const publicInput: PortfolioKnowledgeCompositionInput = {
			terminal: null as unknown as PortfolioKnowledgeCompositionInput["terminal"],
			learning: null as unknown as PortfolioKnowledgeCompositionInput["learning"],
			lesson: { kind: "how", title: "A lesson", statement: "A durable mechanism." },
			applicability: { namespace: "knowledge" },
			knowledgeStore: null as unknown as KnowledgeStore,
			knowledgeCommitRequest: null as unknown as KnowledgeCommitRequest,
			authority: null as unknown as PortfolioKnowledgeCompositionInput["authority"],
			learningRuntime: null as unknown as WorkflowLearningRuntimeAdapter,
			refinement: null as unknown as PortfolioKnowledgeCompositionInput["refinement"],
		};

		expect(publicInput.knowledgeStore).toBeNull();
	});

	it("does not mutate any downstream authority when the approved learning scope is never", async () => {
		const calls: string[] = [];
		admitScopeMock.mockResolvedValue({
			requestedScope: "never",
			effectiveScope: "never",
			canPromote: false,
			exploratory: false,
			rejectionReasons: ["never_scope_requested"],
			applicationCount: 0,
			mutationCount: 0,
		} satisfies PortfolioLearningScopeDecision);
		const input = {
			terminal: {} as PortfolioKnowledgeCompositionInput["terminal"],
			learning: { requestedScope: "never" } as PortfolioKnowledgeCompositionInput["learning"],
			lesson: {
				kind: "how",
				title: "A bounded lesson",
				statement: "The host-verified mechanism improved the goal.",
			},
			knowledgeStore: {
				commit: async () => {
					calls.push("knowledge");
					throw new Error("must not commit");
				},
			} as unknown as KnowledgeStore,
			knowledgeCommitRequest: null as unknown as KnowledgeCommitRequest,
			learningRuntime: {
				commitExperience: async () => {
					calls.push("experience");
					throw new Error("must not commit experience");
				},
			} as unknown as WorkflowLearningRuntimeAdapter,
			refinement: null as unknown as PortfolioKnowledgeCompositionInput["refinement"],
		} as unknown as PortfolioKnowledgeCompositionInput;

		const result = await composePortfolioKnowledge(input);

		expect(result.mutated).toBe(false);
		expect(result.scope.effectiveScope).toBe("never");
		expect(calls).toEqual([]);
	});

	it("commits canonical knowledge, projects it, and reopens as an idempotent no-op", async () => {
		const fixture = await positiveFixture();
		const first = await composePortfolioKnowledge(fixture.input);
		expect(first.accepted).toBe(true);
		expect(first.mutated).toBe(true);
		expect(first.projectedToMemPalace).toBe(true);
		expect(first.applicability).toEqual({
			namespace: "knowledge",
			scope: "workspace",
			workspaceId: "workspace-1",
			pathPrefix: "goal/goal-1",
		});
		expect(first.knowledgeRecord?.procedure).toBeUndefined();
		expect(fixture.calls).toEqual(["authorize", "knowledge", "consume", "experience", "candidate", "review"]);
		const recordId = first.knowledgeRecord?.recordId;
		expect(recordId).toBeDefined();

		const reopenedStore = createStore(fixture.durable);
		const replayCalls: string[] = [];
		const replayInput: PortfolioKnowledgeCompositionInput = {
			...fixture.input,
			knowledgeStore: reopenedStore,
			mempalace: createKnowledgeMempalaceBoundary({ store: reopenedStore }),
			learningRuntime: learningRuntime(replayCalls),
		};
		const replay = await composePortfolioKnowledge(replayInput);

		expect(replay.accepted).toBe(true);
		expect(replay.mutated).toBe(false);
		expect(replay.projectedToMemPalace).toBe(false);
		expect(replay.knowledgeRecord?.recordId).toBe(recordId);
		expect(replay.learning.status).toBe("not_attempted");
		expect(replayCalls).toEqual([]);
		expect(fixture.calls).toEqual([
			"authorize",
			"knowledge",
			"consume",
			"experience",
			"candidate",
			"review",
			"authorize",
		]);
		expect((await reopenedStore.read()).records[recordId!]?.recordId).toBe(recordId);
	});

	it("RED: requires the typed workflow learning knowledge-promotion authorizer seam", async () => {
		const fixture = await positiveFixture();
		const contextWithoutAuthorizer = { ...fixture.input.terminal.receiptContext } as Record<string, unknown>;
		delete contextWithoutAuthorizer.principalAuthorizer;
		const input = {
			...fixture.input,
			terminal: { ...fixture.input.terminal, receiptContext: contextWithoutAuthorizer },
			learning: { ...fixture.input.learning, receiptContext: contextWithoutAuthorizer },
			authority: {
				receipt: fixture.input.learning.redTeamEvidence!.evidence.receipt,
				executionIdentity: "knowledge-writer",
				sessionId: "knowledge-session",
			},
		} as unknown as PortfolioKnowledgeCompositionInput;

		await expect(composePortfolioKnowledge(input)).rejects.toThrow(/CONTRACT_CHANGE|principalAuthorizer/i);
		expect(fixture.calls).toEqual([]);
	});

	it("rejects worker, self-session, forged capability, and forged principal substitutions", async () => {
		const workerFixture = await positiveFixture();
		const workerInput = {
			...workerFixture.input,
			authority: { ...workerFixture.input.authority, executionIdentity: "worker-self" },
		};
		await expect(composePortfolioKnowledge(workerInput)).rejects.toThrow(/execution session|host-owned/i);
		expect(workerFixture.calls).toEqual([]);

		const sessionFixture = await positiveFixture();
		const sessionInput = {
			...sessionFixture.input,
			authority: { ...sessionFixture.input.authority, sessionId: "self-session" },
		};
		await expect(composePortfolioKnowledge(sessionInput)).rejects.toThrow(/execution session|host-owned/i);
		expect(sessionFixture.calls).toEqual([]);

		const capabilityFixture = await positiveFixture();
		const capabilityInput = {
			...capabilityFixture.input,
			authority: {
				...capabilityFixture.input.authority,
				receipt: {
					...capabilityFixture.input.authority.receipt,
					capabilityBinding: {
						...capabilityFixture.input.authority.receipt.capabilityBinding,
						capability: "portfolio_default_completion" as const,
					},
				},
			},
		} as unknown as PortfolioKnowledgeCompositionInput;
		await expect(composePortfolioKnowledge(capabilityInput)).rejects.toThrow(/capability|authority|receipt/i);
		expect(capabilityFixture.calls).toEqual([]);

		const principalFixture = await positiveFixture();
		const principalContext = principalFixture.input.terminal.receiptContext;
		const principalAuthorizer = principalContext.principalAuthorizer;
		const forgedPrincipalContext: WorkflowHostReceiptConsumerContext = {
			...principalContext,
			principalAuthorizer: {
				authorize: async (authorizationInput) => ({
					...(await principalAuthorizer.authorize(authorizationInput)),
					authenticatedPrincipal: "worker-self",
				}),
			},
		};
		const principalInput = {
			...principalFixture.input,
			terminal: { ...principalFixture.input.terminal, receiptContext: forgedPrincipalContext },
			learning: { ...principalFixture.input.learning, receiptContext: forgedPrincipalContext },
		};
		await expect(composePortfolioKnowledge(principalInput)).rejects.toThrow(/principal authorization/i);
		expect(principalFixture.calls).toEqual(["authorize"]);
	});

	it("rejects raw holdout material in a closed refinement trigger before canonical commit", async () => {
		const fixture = await positiveFixture();
		const trigger = {
			...fixture.input.refinement.trigger,
			rawHoldoutInputs: ["hidden row"],
		} as unknown as PortfolioKnowledgeCompositionInput["refinement"]["trigger"];
		const input = {
			...fixture.input,
			refinement: { ...fixture.input.refinement, trigger },
		};

		await expect(composePortfolioKnowledge(input)).rejects.toThrow(/rawholdout|holdout/i);
		expect(fixture.calls).toEqual([]);
	});

	it("rejects raw holdout material added to the promotion authority envelope", async () => {
		const fixture = await positiveFixture();
		const input = {
			...fixture.input,
			authority: {
				...fixture.input.authority,
				rawHoldoutInput: "hidden row",
			},
		} as unknown as PortfolioKnowledgeCompositionInput;

		await expect(composePortfolioKnowledge(input)).rejects.toThrow(/holdout|unknown/i);
		expect(fixture.calls).toEqual([]);
	});

	it("rejects adversarial evidence with a stale current-head witness", async () => {
		const fixture = await positiveFixture();
		const redTeam = fixture.input.learning.redTeamEvidence!;
		const staleEvidence = {
			...redTeam.evidence,
			witness: { ...redTeam.evidence.witness, stateHeadDigest: "stale-head" },
		};
		const input = {
			...fixture.input,
			learning: {
				...fixture.input.learning,
				redTeamEvidence: { ...redTeam, evidence: staleEvidence },
			},
		};

		await expect(composePortfolioKnowledge(input)).rejects.toThrow(/current portfolio tuple/i);
		expect(fixture.calls).toEqual([]);
	});
});
