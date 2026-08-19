import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
	bridgePortfolioToDefaultCompletion,
	createPortfolioCompletionHostAuthority,
	type PortfolioCompletionAtomicCommitInput,
	type PortfolioCompletionAtomicCommitResult,
	type PortfolioCompletionBridgeResult,
	type PortfolioCompletionFrontierAdmissionEvidence,
	type PortfolioCompletionHostAuthorityInput,
	type PortfolioCompletionRequest,
} from "../src/core/autoresearch/portfolio-completion.js";
import {
	type AutoResearchPortfolioCandidate,
	type AutoResearchPortfolioContract,
	type AutoResearchPortfolioMeasurement,
	parseAutoResearchPortfolioContract,
} from "../src/core/autoresearch/portfolio-contracts.js";
import {
	type AutoResearchPortfolioAdmissionIntent,
	deriveAutoResearchPortfolioImpactClosure,
	preflightAutoResearchPortfolioCandidate,
} from "../src/core/autoresearch/portfolio-frontier.js";
import {
	type PortfolioHostAcquisitionEvidence,
	type PortfolioHostArtifactEvidence,
	type PortfolioHostBoundaryEvidence,
	type PortfolioHostCompletionEvidence,
	type PortfolioHostFrontierEvidence,
	type PortfolioHostMeasurementEvidence,
	type PortfolioTerminalInput,
	portfolioAcquisitionBindingDigest,
	portfolioBoundaryBindingDigest,
	portfolioCompletionBindingDigest,
	portfolioDefaultCompletionOperationDigest,
	portfolioDefaultCompletionResourceDigest,
	portfolioFrontierBindingDigest,
	portfolioMeasurementBindingDigest,
} from "../src/core/autoresearch/portfolio-terminal.js";
import type { AutoResearchRunHostAuthority } from "../src/core/autoresearch/runtime-adapter.js";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	parseCanonicalJsonBytes,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowEventPayload,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowLeaseRef,
	type WorkflowRuntimeStore,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import { commitWorkflowRuntimeEvent } from "../src/core/workflow/process-groups.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
	type PersistedWorkflowCompletionReadinessAuthority,
	type PersistedWorkflowCompletionReceiptIssuer,
} from "../src/core/workflow/session-host-factory.js";

const DIGEST = "a".repeat(64);
const PORTFOLIO_ROOT = "b".repeat(64);
const TRAINING_ROOT = "c".repeat(64);
const VALIDATION_ROOT = "d".repeat(64);
const HOLDOUT_ROOT = "e".repeat(64);
const VERIFICATION = "9".repeat(64);
const WORKFLOW_ID = "workflow-portfolio-completion";
const SESSION_ID = "session-portfolio-completion";
const STATE_DIGEST = "state-portfolio-completion";
const REVISION = 11;
const TRUSTED_NOW = "2026-08-17T12:00:00.000Z";

function splitRoots(): Record<string, string> {
	return { training: TRAINING_ROOT, validation: VALIDATION_ROOT, holdout: HOLDOUT_ROOT };
}

function digestWithoutField(value: Record<string, unknown>, field: string): string {
	const payload = { ...value };
	delete payload[field];
	return digestObject(payload);
}

function datasetArtifact(
	split: "training" | "validation" | "holdout",
	start: string,
	end: string,
	authority: "training_workers_training_only" | "validation_evaluator_host_only" | "holdout_host_aggregate_only",
): Record<string, unknown> {
	return {
		split,
		objectUri: `gs://completion-${split}/manifest.json`,
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

function inputManifest(): Record<string, unknown> {
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
	};
	manifest.manifestDigest = digestWithoutField(manifest, "manifestDigest");
	return manifest;
}

function manifestDigest(): string {
	return String(inputManifest().manifestDigest);
}

function metric(metricId = "quality", requirementId = "requirement-quality"): Record<string, unknown> {
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
		inputManifestDigest: manifestDigest(),
		splitClosureRoots: splitRoots(),
	};
}

function acceptanceRequirement(requirementId: string, statement: string): Record<string, unknown> {
	const body = { requirementId, statement, locked: true as const };
	return { ...body, requirementDigest: digestObject(body) };
}

function contract(): AutoResearchPortfolioContract {
	return parseAutoResearchPortfolioContract({
		schemaVersion: 3,
		contractId: "portfolio-completion-1",
		objective: "Improve quality under fixed host boundaries.",
		acceptanceRequirements: [
			acceptanceRequirement("requirement-quality", "Quality meets the locked target."),
			acceptanceRequirement("requirement-safety", "Safety meets the locked target."),
		],
		goals: [
			{
				goalId: "goal-quality",
				domainId: "domain-quality",
				title: "Quality",
				description: "Improve quality.",
				scope: "terminal",
				metrics: [metric(), metric("safety", "requirement-safety")],
				baseline: {
					locked: true,
					measurementId: "measurement-baseline",
					metricValues: [
						{ metricId: "quality", value: 0.5 },
						{ metricId: "safety", value: 0.5 },
					],
					evidenceDigest: DIGEST,
					evaluationEpoch: 1,
					closureRootDigest: PORTFOLIO_ROOT,
					inputManifestDigest: manifestDigest(),
					splitClosureRoots: splitRoots(),
				},
				evaluator: {
					locked: true,
					evaluatorId: "evaluator-quality",
					sourceDigest: DIGEST,
					inputDigest: DIGEST,
					environmentDigest: DIGEST,
					evaluatorDigest: digestObject({
						locked: true,
						evaluatorId: "evaluator-quality",
						sourceDigest: DIGEST,
						inputDigest: DIGEST,
						environmentDigest: DIGEST,
						evaluationEpoch: 1,
						evaluatorRevision: 1,
						closureRootDigest: PORTFOLIO_ROOT,
						inputManifestDigest: manifestDigest(),
						splitClosureRoots: splitRoots(),
					}),
					evaluationEpoch: 1,
					evaluatorRevision: 1,
					closureRootDigest: PORTFOLIO_ROOT,
					inputManifestDigest: manifestDigest(),
					splitClosureRoots: splitRoots(),
				},
				parser: {
					locked: true,
					parserId: "parser-quality",
					kind: "json_object",
					metricKeys: ["quality", "safety"],
					parserDigest: digestObject({
						locked: true,
						parserId: "parser-quality",
						kind: "json_object",
						metricKeys: ["quality", "safety"],
						evaluationEpoch: 1,
						inputManifestRevision: 1,
						closureRootDigest: PORTFOLIO_ROOT,
						inputManifestDigest: manifestDigest(),
						splitClosureRoots: splitRoots(),
					}),
					evaluationEpoch: 1,
					inputManifestRevision: 1,
					closureRootDigest: PORTFOLIO_ROOT,
					inputManifestDigest: manifestDigest(),
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
					closureRootDigest: PORTFOLIO_ROOT,
					splitClosureRoots: splitRoots(),
				},
				falsification: {
					locked: true,
					criteria: ["quality fails"],
					manifestDigest: digestObject({ locked: true, criteria: ["quality fails"] }),
				},
				adversarial: {
					locked: true,
					checks: ["metric omission"],
					manifestDigest: digestObject({ locked: true, checks: ["metric omission"] }),
				},
			},
		],
		goalRelations: [],
		lexicographicTiers: [{ tier: 1, goalIds: ["goal-quality"] }],
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
				paths: ["src"],
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

function receipt(
	input: Pick<
		WorkflowVerifiedHostReceipt,
		"receiptKind" | "receiptId" | "issuerId" | "payloadDigest" | "bindingDigest"
	> &
		Partial<Pick<WorkflowVerifiedHostReceipt, "oneUse">>,
	context: WorkflowHostReceiptConsumerContext,
	capabilityDigests: { readonly resourceDigest?: string; readonly operationDigest?: string } = {},
): WorkflowVerifiedHostReceipt {
	void context;
	return createFixtureHostReceipt({
		...input,
		workflowId: WORKFLOW_ID,
		issuerId: input.issuerId === "worker" || input.issuerId === "self" ? input.issuerId : "fixture-host",
		artifactRef: artifactRef(input.receiptId),
		issuedAt: "2026-08-17T00:00:00.000Z",
		validUntil: "2026-08-18T00:00:00.000Z",
		keyId: "fixture-key",
		stateDigest: STATE_DIGEST,
		revision: REVISION,
		capabilityBinding: {
			capability: "portfolio_default_completion",
			resourceDigest: capabilityDigests.resourceDigest ?? DIGEST,
			operationDigest: capabilityDigests.operationDigest ?? DIGEST,
			executionIdentity: "completion-fixture-process",
			sessionId: SESSION_ID,
		},
	});
}

function hostArtifact(
	parsedContract: AutoResearchPortfolioContract,
	split: "training" | "validation" | "holdout",
): PortfolioHostArtifactEvidence {
	const artifact = parsedContract.inputManifest[split].artifacts[0]!;
	return {
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
}

function completionCandidate(candidateId = "candidate-1"): AutoResearchPortfolioCandidate {
	return {
		candidateId,
		goalIds: ["goal-quality"],
		solutionFamily: {
			familyId: `family-${candidateId}`,
			name: `sealed representation ${candidateId}`,
			mechanismClass: "representation",
		},
		ancestry: {
			parentCandidateIds: [],
			baseDigest: DIGEST,
			lineageDigest: DIGEST,
		},
		causalMechanism: {
			hypothesis: "The representation change improves the locked evaluator.",
			intervention: "Replace the terminal representation implementation.",
			expectedObservation: "Both locked metrics improve without boundary violations.",
			falsificationCondition: "Either locked metric regresses or a boundary fails.",
			mechanismDigest: DIGEST,
		},
		change: {
			kind: "mechanism",
			changedPaths: ["src/representation.ts"],
			parameterChanges: [],
			changeDigest: DIGEST,
		},
		scope: "terminal",
	};
}

function completionReceiptContext(): WorkflowHostReceiptConsumerContext {
	const { revokeReceipt: _revokeReceipt, ...context } = createFixtureHostReceiptConsumerContext();
	return Object.assign(context, {
		signer: {
			keyId: "fixture-key",
			signatureAlgorithm: "ed25519" as const,
			sign: async () => "fixture-witness-signature",
		},
	});
}

function runtimeAuthority(context: WorkflowHostReceiptConsumerContext): AutoResearchRunHostAuthority {
	const leaseRef: WorkflowLeaseRef = {
		storeEpoch: 1,
		coordinatorEpoch: 1,
		leaseId: "completion-fixture-lease",
		acquisitionEventSequence: 1,
		processIdentity: "completion-fixture-process",
		rootDigest: DIGEST,
		writerIdentity: "completion-fixture-writer",
		acquiredAt: "2026-08-17T00:00:00.000Z",
		expiresAt: "2026-08-18T00:00:00.000Z",
	};
	const runtimeStore = {
		identity: {
			storeKind: "workflow",
			namespace: "completion-fixture",
			rootDir: "/tmp/completion-fixture",
			storeId: "completion-fixture-store",
			workflowId: WORKFLOW_ID,
			identityDigest: DIGEST,
		},
		durableContext: { epochRef: { storeEpoch: 1, coordinatorEpoch: 1 }, currentLeaseRef: () => leaseRef },
		replay: async () => ({
			quarantined: false,
			quarantineReason: null,
			head: {
				workflowId: WORKFLOW_ID,
				sequence: 1,
				eventDigest: DIGEST,
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			},
			events: [
				{
					sequence: 1,
					workflowId: WORKFLOW_ID,
					epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				},
			],
		}),
	} as unknown as WorkflowRuntimeStore;
	return {
		runtimeStore,
		artifactResolver: context.artifactResolver,
		workflowId: WORKFLOW_ID,
		executionKey: "completion-fixture-execution",
		writerIdentity: "completion-fixture-writer",
		resolveLeaseRef: async () => leaseRef,
		receiptContext: context,
	};
}

interface PersistedCompletionCapture {
	runtimeStore: WorkflowRuntimeStore;
	receiptContext: WorkflowHostReceiptConsumerContext;
	issueReceipt: PersistedWorkflowCompletionReceiptIssuer;
}

interface PersistedCompletionHead {
	epochRef: WorkflowEpochRef;
	stateDigest: string;
	revision: number;
	executionIdentity: string;
	writerIdentity: string;
}

interface PersistedCompletionRequestFixture {
	request: PortfolioCompletionRequest;
	authorityInput: PortfolioCompletionHostAuthorityInput;
	capture: PersistedCompletionCapture;
	dataClosureRefs: ReadonlyMap<"training" | "validation" | "holdout", WorkflowArtifactRef>;
}

function completionGoalProjection(): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	let state = emptyGoalState();
	return {
		read: () => structuredClone(state),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(state) !== JSON.stringify(expected)) return false;
			state = structuredClone(next);
			return true;
		},
	};
}

function unusedCompletionReadinessAuthority(): PersistedWorkflowCompletionReadinessAuthority {
	const unused = async (): Promise<never> => {
		throw new Error("unused readiness authority in portfolio completion integration test");
	};
	return {
		resolveReadiness: unused,
		resolveDigestSources: unused,
		resolveDecision: unused,
		validateDecision: unused,
		validateEvidence: unused,
		validateScorecard: unused,
		validateProgress: unused,
		validateResources: unused,
	};
}

async function openPersistedCompletionHost(
	artifactRoot: string,
	capture: { current?: PersistedCompletionCapture },
	goalProjection: ReturnType<typeof completionGoalProjection>,
): Promise<PersistedSessionWorkflowHost> {
	return createPersistedSessionWorkflowHost({
		artifactRoot,
		rootSessionId: SESSION_ID,
		workflowId: WORKFLOW_ID,
		genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
		writerIdentity: "completion-persisted-writer",
		processIdentity: "completion-persisted-process",
		now: () => TRUSTED_NOW,
		goalProjection,
		completionReadinessAuthorityFactory: ({ runtimeStore, receiptContext, issueReceipt }) => {
			const { revokeReceipt: _revokeReceipt, ...terminalReceiptContext } = receiptContext;
			capture.current = {
				runtimeStore,
				receiptContext: terminalReceiptContext,
				issueReceipt,
			};
			return { runtimeStore, authority: unusedCompletionReadinessAuthority() };
		},
	});
}

async function persistedCompletionHead(runtimeStore: WorkflowRuntimeStore): Promise<PersistedCompletionHead> {
	const durable = runtimeStore.durableContext;
	if (durable === undefined) throw new Error("portfolio completion integration requires a durable runtime");
	const replay = await runtimeStore.replay({
		workflowId: WORKFLOW_ID,
		fromSequence: 0,
		expectedStoreEpoch: durable.epochRef.storeEpoch,
	});
	if (replay.quarantined || replay.head.eventDigest === null || replay.head.sequence < 1)
		throw new Error("portfolio completion integration requires an authenticated head");
	const lease = durable.currentLeaseRef();
	return {
		epochRef: { ...durable.epochRef },
		stateDigest: replay.head.eventDigest,
		revision: replay.head.sequence,
		executionIdentity: lease.processIdentity,
		writerIdentity: lease.writerIdentity,
	};
}

async function issuePersistedCompletionReceipt(
	capture: PersistedCompletionCapture,
	head: PersistedCompletionHead,
	input: Pick<WorkflowVerifiedHostReceipt, "receiptKind" | "receiptId" | "bindingDigest"> & {
		readonly oneUse?: boolean;
		readonly resourceDigest: string;
		readonly operationDigest: string;
	},
): Promise<WorkflowVerifiedHostReceipt> {
	return capture.issueReceipt({
		receiptKind: input.receiptKind,
		workflowId: WORKFLOW_ID,
		bindingDigest: input.bindingDigest,
		capability: "portfolio_default_completion",
		resourceDigest: input.resourceDigest,
		operationDigest: input.operationDigest,
		executionIdentity: head.executionIdentity,
		sessionId: SESSION_ID,
		receiptId: input.receiptId,
		oneUse: input.oneUse,
		issuedAt: TRUSTED_NOW,
		stateDigest: head.stateDigest,
		revision: head.revision,
		payloadKind: "workflow-resource-loader",
		payloadDigest: DIGEST,
	});
}

interface PersistedPortfolioCompletionAtomicRecord {
	readonly version: 1;
	readonly status: "pending" | "committed";
	readonly workflowId: string;
	readonly generationId: string;
	readonly transactionDigest: string;
	readonly idempotencyKey: string;
	readonly auditDigest: string;
	readonly journalRecordDigest: string | null;
	readonly receiptIds: readonly string[];
	readonly witnesses: readonly WorkflowHostReceiptConsumptionWitness[];
	readonly createdAt: string;
	readonly committedAt: string | null;
}

function persistedExactKeys(value: unknown, expected: readonly string[]): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Reflect.ownKeys(value);
	return (
		keys.every((key) => typeof key === "string") &&
		JSON.stringify(keys.sort()) === JSON.stringify([...expected].sort())
	);
}

function persistedCompletionAtomicCommitter(
	capture: PersistedCompletionCapture,
	options: { readonly crashAfterConsumption?: boolean } = {},
): (input: PortfolioCompletionAtomicCommitInput) => Promise<PortfolioCompletionAtomicCommitResult> {
	let crashAfterConsumption = options.crashAfterConsumption === true;
	return async (input) => {
		const durable = capture.runtimeStore.durableContext;
		if (durable === undefined) throw new Error("persisted completion atomic runtime missing");
		const recordName = `portfolio-completion-atomic-${durable.generationId}`;
		return durable.withExclusiveLease("portfolio-completion-atomic", async () => {
			const readRecord = async (): Promise<PersistedPortfolioCompletionAtomicRecord | null> => {
				const bytes = await durable.auxiliaryStore.read(recordName);
				if (bytes === null) return null;
				const parsed = parseCanonicalJsonBytes(bytes) as unknown as PersistedPortfolioCompletionAtomicRecord;
				if (
					canonicalJsonBytes(parsed).byteLength !== bytes.byteLength ||
					canonicalJsonBytes(parsed).some((byte, index) => byte !== bytes[index]) ||
					!persistedExactKeys(parsed, [
						"version",
						"status",
						"workflowId",
						"generationId",
						"transactionDigest",
						"idempotencyKey",
						"auditDigest",
						"journalRecordDigest",
						"receiptIds",
						"witnesses",
						"createdAt",
						"committedAt",
					]) ||
					parsed.version !== 1 ||
					(parsed.status !== "pending" && parsed.status !== "committed") ||
					parsed.workflowId !== input.workflowId ||
					parsed.generationId !== durable.generationId ||
					parsed.transactionDigest !== input.transactionDigest ||
					!Array.isArray(parsed.receiptIds) ||
					!Array.isArray(parsed.witnesses)
				)
					throw new Error("persisted completion atomic intent is corrupt or foreign");
				return parsed;
			};
			const writeRecord = async (record: PersistedPortfolioCompletionAtomicRecord): Promise<void> => {
				await durable.auxiliaryStore.write(recordName, canonicalJsonBytes(record));
			};
			const existing = await readRecord();
			const inputReceiptIds = input.receipts.map((receipt) => receipt.receiptId).sort();
			if (
				existing !== null &&
				(existing.auditDigest !== input.auditDigest ||
					JSON.stringify(existing.receiptIds) !== JSON.stringify(inputReceiptIds))
			) {
				throw new Error("persisted completion atomic intent conflicts with the requested receipt set");
			}
			if (existing?.status === "committed") {
				if (existing.journalRecordDigest === null)
					throw new Error("persisted completion atomic journal proof missing");
				return {
					status: "already_committed",
					transactionDigest: input.transactionDigest,
					journalRecordDigest: existing.journalRecordDigest,
					witnesses: structuredClone(existing.witnesses),
				};
			}
			const replay = await capture.runtimeStore.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: durable.epochRef.storeEpoch,
			});
			if (replay.quarantined || replay.head.eventDigest === null)
				throw new Error("persisted completion atomic journal head unavailable");
			const idempotencyKey =
				existing?.idempotencyKey ??
				digestObject({
					kind: "portfolio.default_completion.atomic_commit.v1",
					transactionDigest: input.transactionDigest,
				});
			const priorEvent = replay.events.find((event) => event.idempotencyKey === idempotencyKey);
			if (priorEvent !== undefined) {
				if (priorEvent.payload.kind !== "workflow_completion_cut_sealed")
					throw new Error("persisted completion atomic idempotency conflict");
				const witnesses = await Promise.all(
					input.receipts.map((receipt) =>
						capture.receiptContext.receiptResolver.resolveConsumptionWitness({
							receiptId: receipt.receiptId,
							workflowId: input.workflowId,
							expectedBindingDigest: receipt.bindingDigest,
						}),
					),
				);
				const record: PersistedPortfolioCompletionAtomicRecord = {
					version: 1,
					status: "committed",
					workflowId: input.workflowId,
					generationId: durable.generationId,
					transactionDigest: input.transactionDigest,
					idempotencyKey,
					auditDigest: input.auditDigest,
					journalRecordDigest: priorEvent.eventDigest,
					receiptIds: inputReceiptIds,
					witnesses,
					createdAt: TRUSTED_NOW,
					committedAt: TRUSTED_NOW,
				};
				await writeRecord(record);
				return {
					status: "already_committed",
					transactionDigest: input.transactionDigest,
					journalRecordDigest: priorEvent.eventDigest,
					witnesses,
				};
			}
			if (
				replay.head.eventDigest !== input.currentStateDigest ||
				replay.head.sequence !== input.currentRevision ||
				replay.head.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
				replay.head.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
				durable.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
				durable.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch
			)
				throw new Error("persisted completion atomic current head CAS failed");
			const pending: PersistedPortfolioCompletionAtomicRecord = {
				version: 1,
				status: "pending",
				workflowId: input.workflowId,
				generationId: durable.generationId,
				transactionDigest: input.transactionDigest,
				idempotencyKey,
				auditDigest: input.auditDigest,
				journalRecordDigest: null,
				receiptIds: inputReceiptIds,
				witnesses: [],
				createdAt: TRUSTED_NOW,
				committedAt: null,
			};
			await writeRecord(pending);
			for (const receipt of input.receipts) {
				await capture.receiptContext.receiptResolver.consumeIfOneUse({
					receipt,
					workflowId: input.workflowId,
					expectedBindingDigest: receipt.bindingDigest,
					currentRevision: input.currentRevision,
				});
			}
			if (crashAfterConsumption) {
				crashAfterConsumption = false;
				throw new Error("persisted_completion_atomic_simulated_crash");
			}
			const witnesses = await Promise.all(
				input.receipts.map((receipt) =>
					capture.receiptContext.receiptResolver.resolveConsumptionWitness({
						receiptId: receipt.receiptId,
						workflowId: input.workflowId,
						expectedBindingDigest: receipt.bindingDigest,
					}),
				),
			);
			const cut = {
				workflowId: input.workflowId,
				cutId: input.transactionDigest,
				expectedHead: replay.head,
				epochRef: replay.head.epochRef,
				finalClosureObservationId: `portfolio-completion:${input.transactionDigest}`,
				finalClosureObservationDigest: input.auditDigest,
				trainingClosureRootDigest: input.audit.splitProvenance.splitClosureRoots.training,
				validationClosureRootDigest: input.audit.splitProvenance.splitClosureRoots.validation,
				holdoutClosureRootDigest: input.audit.splitProvenance.splitClosureRoots.holdout,
				supersededObservationIds: [],
				quarantinedObservationIds: [],
				sealedAt: TRUSTED_NOW,
			};
			const payload = {
				kind: "workflow_completion_cut_sealed" as const,
				workflowId: input.workflowId,
				epochRef: replay.head.epochRef,
				cut,
				cutDigest: digestObject(cut),
			};
			const lease = durable.currentLeaseRef();
			const committed = await commitWorkflowRuntimeEvent(capture.runtimeStore, {
				workflowId: input.workflowId,
				payload: payload as WorkflowEventPayload & typeof payload,
				epochRef: replay.head.epochRef,
				leaseRef: lease,
				idempotencyKey,
				writerIdentity: lease.writerIdentity,
				executionKey: null,
			});
			const record: PersistedPortfolioCompletionAtomicRecord = {
				...pending,
				status: "committed",
				journalRecordDigest: committed.commit.eventDigest,
				witnesses,
				committedAt: TRUSTED_NOW,
			};
			await writeRecord(record);
			return {
				status: committed.status,
				transactionDigest: input.transactionDigest,
				journalRecordDigest: committed.commit.eventDigest,
				witnesses,
			};
		});
	};
}

async function persistedCompletionRequest(
	capture: PersistedCompletionCapture,
	head: PersistedCompletionHead,
): Promise<PersistedCompletionRequestFixture> {
	const base = validInput();
	const contractValue = base.contract;
	const terminalMeasurements = base.measurements.map(({ measurement }) => measurement);
	const terminalSkeleton: PortfolioTerminalInput = {
		...base,
		currentStateDigest: head.stateDigest,
		currentRevision: head.revision,
		trustedNow: TRUSTED_NOW,
		receiptContext: capture.receiptContext,
	};
	const resourceDigest = portfolioDefaultCompletionResourceDigest(
		contractValue,
		terminalSkeleton,
		terminalMeasurements,
	);
	const issue = (
		receiptKind: WorkflowVerifiedHostReceipt["receiptKind"],
		receiptId: string,
		bindingDigest: string,
		role: Parameters<typeof portfolioDefaultCompletionOperationDigest>[3],
		oneUse = false,
	) =>
		issuePersistedCompletionReceipt(capture, head, {
			receiptKind,
			receiptId,
			bindingDigest,
			resourceDigest,
			operationDigest: portfolioDefaultCompletionOperationDigest(
				contractValue,
				terminalSkeleton,
				terminalMeasurements,
				role,
				bindingDigest,
			),
			oneUse,
		});
	const measurements = await Promise.all(
		base.measurements.map(async ({ measurement }) => ({
			measurement,
			receipt: await issue(
				"artifact",
				`persisted-${measurement.measurementId}`,
				portfolioMeasurementBindingDigest(contractValue, measurement),
				"measurement",
				false,
			),
		})),
	);
	const frontierEntries = base.frontier.entries;
	const frontier = {
		...base.frontier,
		receipt: await issue(
			"decision",
			"persisted-frontier",
			portfolioFrontierBindingDigest(contractValue, frontierEntries, base.frontier.selectedEntryIds),
			"frontier",
			false,
		),
	};
	const boundaries = await Promise.all(
		base.boundaries.map(async (entry) => ({
			...entry,
			receipt: await issue(
				"adjudication",
				`persisted-${entry.boundaryId}`,
				portfolioBoundaryBindingDigest(contractValue, entry.boundaryId, entry.passed),
				"boundary",
				false,
			),
		})),
	);
	const acquisition = {
		splits: await Promise.all(
			base.acquisition.splits.map(async (entry) => ({
				...entry,
				receipt: await issue(
					"artifact",
					`persisted-acquisition-${entry.split}`,
					portfolioAcquisitionBindingDigest(contractValue, entry.split, entry.artifacts),
					"acquisition",
					false,
				),
			})),
		),
	};
	const completionBinding = {
		manifestGeneration: contractValue.inputManifest.evaluationEpoch,
		manifestRevision: contractValue.inputManifest.manifestRevision,
		manifestDigest: contractValue.inputManifest.manifestDigest,
		closureRootDigest: contractValue.inputManifest.closureRootDigest,
		artifacts: (["training", "validation", "holdout"] as const).map((split) => hostArtifact(contractValue, split)),
	};
	const completion = {
		...completionBinding,
		receipt: await issue(
			"artifact",
			"persisted-completion",
			portfolioCompletionBindingDigest(contractValue, completionBinding),
			"completion",
			false,
		),
	};
	const dataClosureRefs = new Map<"training" | "validation" | "holdout", WorkflowArtifactRef>();
	for (const split of ["training", "validation", "holdout"] as const) {
		const splitManifest = contractValue.inputManifest[split];
		const published = await capture.runtimeStore.publishArtifact({
			workflowId: WORKFLOW_ID,
			payloadKind: "evidence",
			bytes: canonicalJsonBytes({
				kind: "portfolio-completion-data-closure.v1",
				split,
				manifestDigest: contractValue.inputManifest.manifestDigest,
				closureRootDigest: splitManifest.closureRootDigest,
				splitManifest,
			}),
			codec: "canonical_json",
			sourceEventSequence: head.revision,
			idempotencyKey: `portfolio-completion-data-closure:${split}`,
		});
		dataClosureRefs.set(split, published.envelope.ref);
	}
	const holdoutMeasurement = measurements.find(({ measurement }) => measurement.kind === "holdout");
	if (holdoutMeasurement === undefined) throw new Error("portfolio completion integration holdout missing");
	const holdoutAggregate = {
		aggregateId: "persisted-aggregate-holdout",
		goalId: holdoutMeasurement.measurement.goalId,
		candidateId: holdoutMeasurement.measurement.candidateId,
		evidenceDigest: holdoutMeasurement.receipt.payloadDigest,
		envelope: {
			kind: "host_only_holdout_aggregate" as const,
			aggregateId: "persisted-aggregate-holdout",
			goalId: holdoutMeasurement.measurement.goalId,
			candidateId: holdoutMeasurement.measurement.candidateId,
			metricVector: holdoutMeasurement.measurement.vector,
			inputManifestDigest: holdoutMeasurement.measurement.inputManifestDigest,
			splitClosureRoots: holdoutMeasurement.measurement.splitClosureRoots,
			rawRows: null,
			perCase: null,
			envelopeDigest: "",
		},
		aggregateDigest: "",
	};
	holdoutAggregate.envelope.envelopeDigest = digestObject({ ...holdoutAggregate.envelope, envelopeDigest: "" });
	holdoutAggregate.aggregateDigest = digestObject({
		aggregateId: holdoutAggregate.aggregateId,
		goalId: holdoutAggregate.goalId,
		candidateId: holdoutAggregate.candidateId,
		evidenceDigest: holdoutAggregate.evidenceDigest,
	});
	const measurementConsumptionReceipts = await Promise.all(
		measurements.map(async ({ measurement, receipt: evidenceReceipt }) => {
			const bindingDigest = digestObject({
				kind: "portfolio.default_completion.measurement_consumption.v1",
				portfolioDigest: digestObject(contractValue),
				measurementId: measurement.measurementId,
				measurementDigest: measurement.measurementDigest,
				evidenceReceiptId: evidenceReceipt.receiptId,
				evidenceBindingDigest: evidenceReceipt.bindingDigest,
				evidencePayloadDigest: evidenceReceipt.payloadDigest,
				evidenceArtifactRef: evidenceReceipt.artifactRef,
				evidenceVerificationDigest: evidenceReceipt.verificationDigest,
			});
			return {
				measurementId: measurement.measurementId,
				receipt: await issuePersistedCompletionReceipt(capture, head, {
					receiptKind: "capability",
					receiptId: `persisted-consume-${measurement.measurementId}`,
					bindingDigest,
					resourceDigest,
					operationDigest: portfolioDefaultCompletionOperationDigest(
						contractValue,
						terminalSkeleton,
						terminalMeasurements,
						"measurement",
						bindingDigest,
					),
				}),
			};
		}),
	);
	const terminal: PortfolioTerminalInput = {
		...base,
		currentStateDigest: head.stateDigest,
		currentRevision: head.revision,
		trustedNow: TRUSTED_NOW,
		receiptContext: capture.receiptContext,
		measurements,
		frontier,
		boundaries,
		acquisition,
		completion,
	};
	const invariantReceipts = await Promise.all(
		contractValue.invariants
			.filter((invariant) => invariant.scope === "terminal")
			.map((invariant) =>
				issue(
					"capability",
					`persisted-${invariant.invariantId}`,
					invariantBindingDigest(contractValue, invariant.invariantId, invariant.checkDigest),
					"boundary",
					true,
				),
			),
	);
	const frontierAdmission = buildFrontierAdmission(
		terminal,
		completionCandidate(),
		[],
		[completionCandidate()],
		frontier.receipt,
		invariantReceipts,
	);
	const authorityInput: PortfolioCompletionHostAuthorityInput = {
		runtime: {
			runtimeStore: capture.runtimeStore,
			artifactResolver: capture.receiptContext.artifactResolver,
			workflowId: WORKFLOW_ID,
			executionKey: "completion-persisted-execution",
			writerIdentity: head.writerIdentity,
			resolveLeaseRef: async () => capture.runtimeStore.durableContext!.currentLeaseRef(),
			receiptContext: capture.receiptContext,
		},
		runtimeVersion: "0.147.0-alpha.10",
		sessionId: SESSION_ID,
		candidate: completionCandidate(),
		priorCandidates: [],
		frontierCandidates: [completionCandidate()],
		holdoutAggregates: [holdoutAggregate],
		frontierAdmission,
		resolveDataClosure: async ({ split, manifestDigest: expectedManifestDigest, closureRootDigest }) => ({
			split,
			manifestDigest: expectedManifestDigest,
			closureRootDigest,
			artifactRefs: [dataClosureRefs.get(split)!],
			artifactDigests: [dataClosureRefs.get(split)!.digest],
		}),
		measurementConsumptionReceipts,
		commitCompletion: persistedCompletionAtomicCommitter(capture),
		readCurrentHead: async () => ({
			stateDigest: head.stateDigest,
			revision: head.revision,
			evaluationEpoch: 1,
		}),
	};
	return {
		request: { terminal, authority: createPortfolioCompletionHostAuthority(authorityInput) },
		authorityInput,
		capture,
		dataClosureRefs,
	};
}

async function withPersistedCompletion<T>(
	callback: (fixture: PersistedCompletionRequestFixture) => Promise<T>,
): Promise<T> {
	const artifactRoot = await mkdtemp(join(tmpdir(), "portfolio-completion-success-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		const captureHolder: { current?: PersistedCompletionCapture } = {};
		host = await openPersistedCompletionHost(artifactRoot, captureHolder, completionGoalProjection());
		await host.execute({
			kind: "start",
			request: { workflowId: WORKFLOW_ID, objective: "persist portfolio completion evidence" },
		});
		const capture = captureHolder.current;
		if (capture === undefined) throw new Error("persisted completion capture missing");
		const head = await persistedCompletionHead(capture.runtimeStore);
		return await callback(await persistedCompletionRequest(capture, head));
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}

function persistedAtomicCommitInput(
	fixture: PersistedCompletionRequestFixture,
	result: PortfolioCompletionBridgeResult,
): PortfolioCompletionAtomicCommitInput {
	const terminal = fixture.request.terminal;
	const receipts = [
		terminal.frontier.receipt,
		...terminal.boundaries.map((entry) => entry.receipt),
		...terminal.acquisition.splits.map((entry) => entry.receipt),
		terminal.completion.receipt,
		...fixture.authorityInput.frontierAdmission.invariantEvidence.map((entry) => entry.receipt),
		...fixture.authorityInput.measurementConsumptionReceipts.map((entry) => entry.receipt),
	].filter((receipt) => receipt.oneUse);
	const durable = fixture.capture.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("persisted completion durable context missing");
	return {
		workflowId: terminal.workflowId,
		currentStateDigest: terminal.currentStateDigest,
		currentRevision: terminal.currentRevision,
		evaluationEpoch: terminal.contract.inputManifest.evaluationEpoch,
		epochRef: durable.epochRef,
		terminalCommitIntent: result.completionTransaction.terminalCommitIntent,
		receipts,
		receiptCommitments: result.completionTransaction.receiptCommitments.map(
			({ witness: _witness, ...commitment }) => commitment,
		),
		auditDigest: result.completionTransaction.auditDigest,
		audit: result.completionTransaction.audit,
		transactionDigest: result.completionTransaction.transactionDigest,
	};
}

function measurementConsumptionBindingDigest(
	input: PortfolioTerminalInput,
	measurement: AutoResearchPortfolioMeasurement,
	receiptValue: WorkflowVerifiedHostReceipt,
): string {
	return digestObject({
		kind: "portfolio.default_completion.measurement_consumption.v1",
		portfolioDigest: digestObject(input.contract),
		measurementId: measurement.measurementId,
		measurementDigest: measurement.measurementDigest,
		evidenceReceiptId: receiptValue.receiptId,
		evidenceBindingDigest: receiptValue.bindingDigest,
		evidencePayloadDigest: receiptValue.payloadDigest,
		evidenceArtifactRef: receiptValue.artifactRef,
		evidenceVerificationDigest: receiptValue.verificationDigest,
	});
}

function validInput(): PortfolioTerminalInput {
	const parsedContract = contract();
	const context = completionReceiptContext();
	const measurementWithoutDigest: AutoResearchPortfolioMeasurement = {
		measurementId: "measurement-candidate",
		goalId: "goal-quality",
		candidateId: "candidate-1",
		scope: "terminal",
		kind: "candidate",
		vector: [
			{ metricId: "quality", value: 0.9 },
			{ metricId: "safety", value: 0.9 },
		],
		repeatIndex: 1,
		sampleCount: 3,
		inputDigest: manifestDigest(),
		inputManifestDigest: manifestDigest(),
		evaluatorDigest: parsedContract.goals[0]!.evaluator.evaluatorDigest,
		parserDigest: parsedContract.goals[0]!.parser.parserDigest,
		commandDigest: parsedContract.goals[0]!.command.commandDigest,
		workspaceDigest: DIGEST,
		evidenceDigests: [VERIFICATION, DIGEST],
		measuredAt: TRUSTED_NOW,
		measurementDigest: "",
		evaluationEpoch: 1,
		splitClosureRoots: parsedContract.inputManifest.splitClosureRoots,
		confidenceInterval: { lower: 0.8, upper: 1, level: 0.95 },
		variance: 0.01,
		runCount: 3,
		aggregation: "median",
	};
	const measurement: AutoResearchPortfolioMeasurement = {
		...measurementWithoutDigest,
		measurementDigest: digestWithoutField(
			measurementWithoutDigest as unknown as Record<string, unknown>,
			"measurementDigest",
		),
	};
	const measurementEvidence: PortfolioHostMeasurementEvidence = {
		measurement,
		receipt: receipt(
			{
				receiptKind: "artifact",
				receiptId: "receipt-measurement",
				issuerId: "host-evaluator",
				payloadDigest: DIGEST,
				bindingDigest: portfolioMeasurementBindingDigest(parsedContract, measurement),
			},
			context,
		),
	};
	const additionalMeasurements: readonly PortfolioHostMeasurementEvidence[] = (
		["holdout", "adversarial"] as const
	).map((kind) => {
		const measurementValue = {
			...measurement,
			measurementId: `measurement-${kind}`,
			kind,
			measurementDigest: "",
		};
		measurementValue.measurementDigest = digestWithoutField(measurementValue, "measurementDigest");
		return {
			measurement: measurementValue,
			receipt: receipt(
				{
					receiptKind: "artifact",
					receiptId: `receipt-measurement-${kind}`,
					issuerId: "host-evaluator",
					payloadDigest: DIGEST,
					bindingDigest: portfolioMeasurementBindingDigest(parsedContract, measurementValue),
				},
				context,
			),
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
		receipt: receipt(
			{
				receiptKind: "decision",
				receiptId: "receipt-frontier",
				issuerId: "host-frontier",
				payloadDigest: DIGEST,
				bindingDigest: portfolioFrontierBindingDigest(parsedContract, frontierEntries, ["frontier-1"]),
			},
			context,
		),
	};
	const boundaries: readonly PortfolioHostBoundaryEvidence[] = [
		{
			boundaryId: "boundary-safety",
			passed: true,
			receipt: receipt(
				{
					receiptKind: "adjudication",
					receiptId: "receipt-boundary",
					issuerId: "host-safety",
					payloadDigest: DIGEST,
					bindingDigest: portfolioBoundaryBindingDigest(parsedContract, "boundary-safety", true),
				},
				context,
			),
		},
	];
	const acquisition: PortfolioHostAcquisitionEvidence = {
		splits: (["training", "validation", "holdout"] as const).map((split) => {
			const artifacts = [hostArtifact(parsedContract, split)];
			return {
				split,
				artifacts,
				receipt: receipt(
					{
						receiptKind: "artifact",
						receiptId: `receipt-${split}`,
						issuerId: "host-acquisition",
						payloadDigest: DIGEST,
						bindingDigest: portfolioAcquisitionBindingDigest(parsedContract, split, artifacts),
					},
					context,
				),
			};
		}),
	};
	const artifacts = (["training", "validation", "holdout"] as const).map((split) =>
		hostArtifact(parsedContract, split),
	);
	const completionBinding = {
		manifestGeneration: parsedContract.inputManifest.evaluationEpoch,
		manifestRevision: parsedContract.inputManifest.manifestRevision,
		manifestDigest: parsedContract.inputManifest.manifestDigest,
		closureRootDigest: parsedContract.inputManifest.closureRootDigest,
		artifacts,
	};
	const completion: PortfolioHostCompletionEvidence = {
		...completionBinding,
		receipt: receipt(
			{
				receiptKind: "artifact",
				receiptId: "receipt-completion",
				issuerId: "host-completion",
				payloadDigest: DIGEST,
				bindingDigest: portfolioCompletionBindingDigest(parsedContract, completionBinding),
			},
			context,
		),
	};
	const input: PortfolioTerminalInput = {
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
	};
	return bindFixtureCapabilityReceipts(input);
}

function bindFixtureCapabilityReceipts(input: PortfolioTerminalInput): PortfolioTerminalInput {
	const measurements = input.measurements.map(({ measurement }) => measurement);
	const resourceDigest = portfolioDefaultCompletionResourceDigest(input.contract, input, measurements);
	const operationDigest = (
		role: Parameters<typeof portfolioDefaultCompletionOperationDigest>[3],
		bindingDigest: string,
	) => portfolioDefaultCompletionOperationDigest(input.contract, input, measurements, role, bindingDigest);
	const rebind = (
		value: WorkflowVerifiedHostReceipt,
		bindingDigest: string,
		role: Parameters<typeof portfolioDefaultCompletionOperationDigest>[3],
	) =>
		receipt(
			{
				receiptKind: value.receiptKind,
				receiptId: value.receiptId,
				issuerId: value.issuerId,
				oneUse: value.oneUse,
				payloadDigest: value.payloadDigest,
				bindingDigest,
			},
			input.receiptContext,
			{ resourceDigest, operationDigest: operationDigest(role, bindingDigest) },
		);
	const reboundMeasurements = input.measurements.map(({ measurement, receipt: measurementReceipt }) => ({
		measurement,
		receipt: rebind(
			measurementReceipt,
			portfolioMeasurementBindingDigest(input.contract, measurement),
			"measurement",
		),
	}));
	const frontierBinding = portfolioFrontierBindingDigest(
		input.contract,
		input.frontier.entries,
		input.frontier.selectedEntryIds,
	);
	const boundaryValues = input.boundaries.map((entry) => ({
		...entry,
		receipt: rebind(
			entry.receipt,
			portfolioBoundaryBindingDigest(input.contract, entry.boundaryId, entry.passed),
			"boundary",
		),
	}));
	const acquisitionValues = input.acquisition.splits.map((entry) => ({
		...entry,
		receipt: rebind(
			entry.receipt,
			portfolioAcquisitionBindingDigest(input.contract, entry.split, entry.artifacts),
			"acquisition",
		),
	}));
	const completionBinding = portfolioCompletionBindingDigest(input.contract, input.completion);
	return {
		...input,
		measurements: reboundMeasurements,
		frontier: {
			...input.frontier,
			receipt: rebind(input.frontier.receipt, frontierBinding, "frontier"),
		},
		boundaries: boundaryValues,
		acquisition: { splits: acquisitionValues },
		completion: {
			...input.completion,
			receipt: rebind(input.completion.receipt, completionBinding, "completion"),
		},
	};
}

function candidateReviewDigest(candidate: AutoResearchPortfolioCandidate): string {
	return digestObject({
		candidateId: candidate.candidateId,
		goalIds: [...candidate.goalIds].sort((left, right) => left.localeCompare(right)),
		solutionFamily: candidate.solutionFamily,
		ancestry: candidate.ancestry,
		causalMechanism: candidate.causalMechanism,
		change: {
			kind: candidate.change.kind,
			changedPaths: [...candidate.change.changedPaths].sort((left, right) => left.localeCompare(right)),
			parameterChanges: [...candidate.change.parameterChanges].sort((left, right) => left.localeCompare(right)),
			changeDigest: candidate.change.changeDigest,
		},
		scope: candidate.scope,
	});
}

function invariantBindingDigest(
	contractValue: AutoResearchPortfolioContract,
	invariantId: string,
	checkDigest: string,
): string {
	return digestObject({
		kind: "portfolio.default_completion.invariant.v1",
		portfolioDigest: digestObject(contractValue),
		invariantId,
		checkDigest,
		passed: true,
	});
}

function buildFrontierAdmission(
	input: PortfolioTerminalInput,
	candidate: AutoResearchPortfolioCandidate,
	priorCandidates: readonly AutoResearchPortfolioCandidate[],
	frontierCandidates: readonly AutoResearchPortfolioCandidate[],
	frontierReceipt: WorkflowVerifiedHostReceipt,
	invariantReceipts: readonly WorkflowVerifiedHostReceipt[] = [],
): PortfolioCompletionFrontierAdmissionEvidence {
	let impactClosure: ReturnType<typeof deriveAutoResearchPortfolioImpactClosure>;
	let preflight: ReturnType<typeof preflightAutoResearchPortfolioCandidate>;
	try {
		impactClosure = deriveAutoResearchPortfolioImpactClosure(input.contract, candidate);
		preflight = preflightAutoResearchPortfolioCandidate({
			contract: input.contract,
			candidate,
			priorCandidates,
		});
	} catch {
		return {
			admissionDigest: DIGEST,
			candidateId: candidate.candidateId,
			candidateReviewDigest: DIGEST,
			preflightDigest: DIGEST,
			frontierDigest: DIGEST,
			impactClosure: {
				authority: "host_derived",
				derivationVersion: 1,
				directGoalIds: [],
				transitiveGoalIds: [],
				affectedPartitionIds: [],
				affectedInvariantIds: [],
				sourceDigest: DIGEST,
				closureDigest: DIGEST,
				intendedGoalIds: [],
				dependentGoalIds: [],
				competingGoalIds: [],
				conflictRelatedGoalIds: [],
				structurallyAffectedGoalIds: [],
				goalIds: [],
				metricIds: [],
				impactClosureDigest: DIGEST,
			},
			invariantEvidence: [],
			receipt: frontierReceipt,
			admissionIntent: {
				kind: "autoresearch_portfolio_frontier_admission",
				productionOrphaned: true,
				candidateId: candidate.candidateId,
				frontierDigest: DIGEST,
				receiptCommitments: [],
				runReceiptCommitments: [],
				consumptionWitnesses: [],
				candidateReviewDigest: DIGEST,
				preflightDigest: DIGEST,
				currentStateDigest: input.currentStateDigest,
				currentRevision: input.currentRevision,
				currentEpochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				measurementEvidenceDigest: DIGEST,
				admissionDigest: DIGEST,
			},
		};
	}
	const invariantEvidence = input.contract.invariants
		.filter((invariant) => invariant.scope === "terminal")
		.map((invariant, index) => ({
			invariantId: invariant.invariantId,
			checkDigest: invariant.checkDigest,
			passed: true as const,
			receipt:
				invariantReceipts[index] ??
				receipt(
					{
						receiptKind: "capability",
						receiptId: `receipt-${invariant.invariantId}`,
						issuerId: "host-invariant",
						oneUse: true,
						payloadDigest: DIGEST,
						bindingDigest: invariantBindingDigest(input.contract, invariant.invariantId, invariant.checkDigest),
					},
					input.receiptContext,
					{
						resourceDigest: portfolioDefaultCompletionResourceDigest(
							input.contract,
							input,
							input.measurements.map(({ measurement }) => measurement),
						),
						operationDigest: portfolioDefaultCompletionOperationDigest(
							input.contract,
							input,
							input.measurements.map(({ measurement }) => measurement),
							"boundary",
							invariantBindingDigest(input.contract, invariant.invariantId, invariant.checkDigest),
						),
					},
				),
		}));
	const candidateBinding = {
		candidateId: candidate.candidateId,
		candidateDigest: digestObject(candidate),
		reviewDigest: candidateReviewDigest(candidate),
		solutionFamilyDigest: digestObject(candidate.solutionFamily),
		causalMechanismDigest: digestObject(candidate.causalMechanism),
		ancestryDigest: digestObject(candidate.ancestry),
		pathsDigest: digestObject([...candidate.change.changedPaths].sort((left, right) => left.localeCompare(right))),
		changeDigest: candidate.change.changeDigest,
	};
	const frontierDigest = digestObject({
		entries: frontierCandidates
			.map((entry) => ({ candidateId: entry.candidateId, candidateDigest: digestObject(entry) }))
			.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
		selectedEntryIds: [...input.frontier.selectedEntryIds].sort((left, right) => left.localeCompare(right)),
	});
	const admissionDigest = digestObject({
		kind: "portfolio.default_completion.frontier_admission.v1",
		portfolioDigest: digestObject(input.contract),
		candidate: candidateBinding,
		frontierDigest,
		impactClosure,
		preflightDigest: preflight.preflightDigest,
		invariantEvidence: invariantEvidence
			.map((entry) => ({
				invariantId: entry.invariantId,
				checkDigest: entry.checkDigest,
				passed: entry.passed,
				receiptDigest: digestObject(entry.receipt),
			}))
			.sort((left, right) => left.invariantId.localeCompare(right.invariantId)),
		receiptDigest: digestObject(frontierReceipt),
	});
	const admissionIntent: AutoResearchPortfolioAdmissionIntent = {
		kind: "autoresearch_portfolio_frontier_admission",
		productionOrphaned: true,
		candidateId: candidate.candidateId,
		frontierDigest,
		receiptCommitments: [],
		runReceiptCommitments: [],
		consumptionWitnesses: [],
		candidateReviewDigest: candidateBinding.reviewDigest,
		preflightDigest: preflight.preflightDigest,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		currentEpochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
		measurementEvidenceDigest: digestObject(
			input.measurements.map(({ measurement }) => ({
				measurementId: measurement.measurementId,
				measurementDigest: measurement.measurementDigest,
			})),
		),
		admissionDigest,
	};
	return {
		admissionDigest,
		candidateId: candidate.candidateId,
		candidateReviewDigest: candidateBinding.reviewDigest,
		preflightDigest: preflight.preflightDigest,
		frontierDigest,
		impactClosure,
		invariantEvidence,
		receipt: frontierReceipt,
		admissionIntent,
	};
}

function requestFor(
	input: PortfolioTerminalInput,
	candidate = completionCandidate(),
	priorCandidates: readonly AutoResearchPortfolioCandidate[] = [],
	frontierCandidates: readonly AutoResearchPortfolioCandidate[] = [candidate],
): PortfolioCompletionRequest {
	const holdoutMeasurement = input.measurements.find(({ measurement }) => measurement.kind === "holdout");
	const holdoutAggregates =
		holdoutMeasurement === undefined
			? []
			: [
					{
						aggregateId: "aggregate-holdout",
						goalId: holdoutMeasurement.measurement.goalId,
						candidateId: holdoutMeasurement.measurement.candidateId,
						evidenceDigest: holdoutMeasurement.receipt.payloadDigest,
						envelope: (() => {
							const envelopeWithoutDigest = {
								kind: "host_only_holdout_aggregate" as const,
								aggregateId: "aggregate-holdout",
								goalId: holdoutMeasurement.measurement.goalId,
								candidateId: holdoutMeasurement.measurement.candidateId,
								metricVector: holdoutMeasurement.measurement.vector,
								inputManifestDigest: holdoutMeasurement.measurement.inputManifestDigest,
								splitClosureRoots: holdoutMeasurement.measurement.splitClosureRoots,
								rawRows: null,
								perCase: null,
								envelopeDigest: "",
							};
							return {
								...envelopeWithoutDigest,
								envelopeDigest: digestObject(envelopeWithoutDigest),
							};
						})(),
						aggregateDigest: digestObject({
							aggregateId: "aggregate-holdout",
							goalId: holdoutMeasurement.measurement.goalId,
							candidateId: holdoutMeasurement.measurement.candidateId,
							evidenceDigest: holdoutMeasurement.receipt.payloadDigest,
						}),
					},
				];
	const terminalMeasurements = input.measurements.map(({ measurement }) => measurement);
	const resourceDigest = portfolioDefaultCompletionResourceDigest(input.contract, input, terminalMeasurements);
	const measurementConsumptionReceipts = input.measurements.map(({ measurement, receipt: evidenceReceipt }) => {
		const bindingDigest = measurementConsumptionBindingDigest(input, measurement, evidenceReceipt);
		return {
			measurementId: measurement.measurementId,
			receipt: receipt(
				{
					receiptKind: "capability",
					receiptId: `receipt-consume-${measurement.measurementId}`,
					issuerId: "host-completion",
					payloadDigest: DIGEST,
					bindingDigest,
				},
				input.receiptContext,
				{
					resourceDigest,
					operationDigest: portfolioDefaultCompletionOperationDigest(
						input.contract,
						input,
						terminalMeasurements,
						"measurement",
						bindingDigest,
					),
				},
			),
		};
	});
	const frontierAdmission = buildFrontierAdmission(
		input,
		candidate,
		priorCandidates,
		frontierCandidates,
		input.frontier.receipt,
	);
	const authorityInput: PortfolioCompletionHostAuthorityInput = {
		runtime: runtimeAuthority(input.receiptContext),
		runtimeVersion: "0.147.0-alpha.10",
		candidate,
		priorCandidates,
		frontierCandidates,
		holdoutAggregates,
		frontierAdmission,
		resolveDataClosure: async ({ split, manifestDigest: expectedManifestDigest, closureRootDigest }) => ({
			split,
			manifestDigest: expectedManifestDigest,
			closureRootDigest,
			artifactRefs: [input.completion.receipt.artifactRef],
			artifactDigests: [input.completion.receipt.artifactRef.digest],
		}),
		measurementConsumptionReceipts,
		commitCompletion: async () => {
			throw new Error("portfolio_completion_fixture_atomic_commit_unavailable");
		},
		sessionId: SESSION_ID,
		readCurrentHead: async () => ({
			stateDigest: STATE_DIGEST,
			revision: REVISION,
			evaluationEpoch: 1,
		}),
	};
	return { terminal: input, authority: createPortfolioCompletionHostAuthority(authorityInput) };
}

function expectRejected(input: PortfolioTerminalInput, message: RegExp): Promise<void> {
	return expect(bridgePortfolioToDefaultCompletion(requestFor(input))).rejects.toThrow(message);
}

describe("portfolio-to-default-completion bridge", () => {
	it("rejects a host runtime below the completion contract minimum", () => {
		const input = validInput();
		expect(() =>
			createPortfolioCompletionHostAuthority({
				runtime: runtimeAuthority(input.receiptContext),
				runtimeVersion: "0.147.0-alpha.9",
				sessionId: SESSION_ID,
				candidate: completionCandidate(),
				priorCandidates: [],
				frontierCandidates: [completionCandidate()],
				holdoutAggregates: [],
				frontierAdmission: buildFrontierAdmission(
					input,
					completionCandidate(),
					[],
					[completionCandidate()],
					input.frontier.receipt,
				),
				resolveDataClosure: async ({ split, manifestDigest: expectedManifestDigest, closureRootDigest }) => ({
					split,
					manifestDigest: expectedManifestDigest,
					closureRootDigest,
					artifactRefs: [input.completion.receipt.artifactRef],
					artifactDigests: [input.completion.receipt.artifactRef.digest],
				}),
				measurementConsumptionReceipts: [],
				commitCompletion: async () => {
					throw new Error("unused");
				},
				readCurrentHead: async () => ({ stateDigest: STATE_DIGEST, revision: REVISION, evaluationEpoch: 1 }),
			}),
		).toThrow("workflow_runtime_version_unsupported");
	});

	it("requires an authenticated host authority instead of caller-supplied terminal context", async () => {
		await expect(bridgePortfolioToDefaultCompletion({ terminal: validInput() } as never)).rejects.toThrow(
			/request|authority|principal|host/i,
		);
	});

	it("projects one accepted full vector into exactly one per-coordinate default evaluation", async () => {
		await withPersistedCompletion(async (fixture) => {
			const input = fixture.request.terminal;
			const result: PortfolioCompletionBridgeResult = await bridgePortfolioToDefaultCompletion(fixture.request);
			const measurement = input.measurements[0]!.measurement;
			const expectedPortfolioDigest = digestObject(input.contract);
			const expectedVectorDigest = digestObject({
				kind: "portfolio.default_completion.vector.v1",
				portfolioDigest: expectedPortfolioDigest,
				measurements: input.measurements
					.map(({ measurement: vectorMeasurement }) => ({
						measurementId: vectorMeasurement.measurementId,
						measurementBindingDigest: portfolioMeasurementBindingDigest(input.contract, vectorMeasurement),
						vector: [...vectorMeasurement.vector].sort((left, right) =>
							left.metricId.localeCompare(right.metricId),
						),
					}))
					.sort((left, right) => left.measurementId.localeCompare(right.measurementId)),
			});

			expect(result.terminalOutcome).toBe("complete");
			expect(result.portfolioDigest).toBe(expectedPortfolioDigest);
			expect(result.vectorDigest).toBe(expectedVectorDigest);
			expect(result.goalMetricEvaluations).toHaveLength(measurement.vector.length);
			for (const evaluation of result.goalMetricEvaluations) {
				const coordinate = measurement.vector.find((entry) => entry.metricId === evaluation.metricId);
				expect(coordinate).toBeDefined();
				expect(evaluation.requirementId).toBe(`requirement-${evaluation.metricId}`);
				expect(evaluation).toMatchObject({
					portfolioDigest: expectedPortfolioDigest,
					vectorDigest: expectedVectorDigest,
					inputManifestDigest: manifestDigest(),
					splitClosureRoots: splitRoots(),
					evaluatorDigest: input.contract.goals[0]!.evaluator.evaluatorDigest,
					parserDigest: input.contract.goals[0]!.parser.parserDigest,
					commandDigest: input.contract.goals[0]!.command.commandDigest,
					measurementId: measurement.measurementId,
					measurementDigest: measurement.measurementDigest,
					evidenceRefs: [input.measurements[0]!.receipt.artifactRef],
					evidenceDigests: [VERIFICATION, DIGEST],
					receipt: input.measurements[0]!.receipt,
				});
				expect(evaluation.supportingReceipts).toHaveLength(3);
				expect(evaluation.holdoutAggregateId).toBe("aggregate-holdout");
				expect(evaluation.holdoutAggregateDigest).toBe(
					digestObject({
						aggregateId: "aggregate-holdout",
						goalId: "goal-quality",
						candidateId: "candidate-1",
						evidenceDigest: DIGEST,
					}),
				);
				expect(evaluation.evaluation).toMatchObject({
					metricId: evaluation.metricId,
					runCount: 3,
					aggregate: "median",
					aggregateValue: coordinate?.value,
					repeatabilitySatisfied: true,
					targetSatisfied: true,
					accepted: true,
					rejectionReasons: [],
				});
				expect(evaluation.evaluationDigest).toBe(digestObject({ ...evaluation, evaluationDigest: "" }));
			}
		});
	});

	it("requires a terminal, complete portfolio and exact vector coordinates", async () => {
		const input = validInput();
		await expectRejected(
			{ ...input, measurements: input.measurements.filter((entry) => entry.measurement.kind !== "holdout") },
			/coverage|measurement|kind/i,
		);
		await expectRejected(
			{ ...input, measurements: [...input.measurements, input.measurements[0]!] },
			/coverage|measurement|kind/i,
		);
		const missingCoordinateWithoutDigest = {
			...input.measurements[0]!.measurement,
			vector: [],
			measurementDigest: "",
		} as AutoResearchPortfolioMeasurement;
		const missingCoordinate = {
			...missingCoordinateWithoutDigest,
			measurementDigest: digestWithoutField(
				missingCoordinateWithoutDigest as unknown as Record<string, unknown>,
				"measurementDigest",
			),
		} as AutoResearchPortfolioMeasurement;
		await expectRejected(
			{ ...input, measurements: [{ measurement: missingCoordinate, receipt: input.measurements[0]!.receipt }] },
			/metric|vector|coordinate|receipt/i,
		);
		const extraCoordinateWithoutDigest = {
			...input.measurements[0]!.measurement,
			vector: [...input.measurements[0]!.measurement.vector, { metricId: "unknown", value: 0.9 }],
			measurementDigest: "",
		} as AutoResearchPortfolioMeasurement;
		const extraCoordinate = {
			...extraCoordinateWithoutDigest,
			measurementDigest: digestWithoutField(
				extraCoordinateWithoutDigest as unknown as Record<string, unknown>,
				"measurementDigest",
			),
		} as AutoResearchPortfolioMeasurement;
		await expectRejected(
			{ ...input, measurements: [{ measurement: extraCoordinate, receipt: input.measurements[0]!.receipt }] },
			/metric|vector|coordinate/i,
		);
		await expectRejected(
			{ ...input, measurements: [input.measurements[0]!, input.measurements[0]!] },
			/measurement|goal|exact/i,
		);

		const nonterminal = validInput();
		const unresolvedFrontier = {
			...nonterminal.frontier,
			selectedEntryIds: [],
			receipt: receipt(
				{
					receiptKind: "decision",
					receiptId: "receipt-frontier-empty",
					issuerId: "host-frontier",
					payloadDigest: DIGEST,
					bindingDigest: portfolioFrontierBindingDigest(nonterminal.contract, nonterminal.frontier.entries, []),
				},
				nonterminal.receiptContext,
			),
		};
		await expectRejected({ ...nonterminal, frontier: unresolvedFrontier }, /terminal|complete|portfolio/i);
	});

	it("uses current signed head evidence and rejects forged or consumed vector receipts", async () => {
		const forged = validInput();
		await expectRejected(
			{
				...forged,
				measurements: [
					{ ...forged.measurements[0]!, receipt: { ...forged.measurements[0]!.receipt, signature: "forged" } },
					...forged.measurements.slice(1),
				],
			},
			/receipt|signature|verified/i,
		);
		const mutated = validInput();
		const originalMeasurement = mutated.measurements[0]!.measurement;
		const mutatedMeasurementWithoutDigest = {
			...originalMeasurement,
			vector: originalMeasurement.vector.map((coordinate) =>
				coordinate.metricId === "quality" ? { ...coordinate, value: 0.95 } : coordinate,
			),
			measurementDigest: "",
		};
		const mutatedMeasurement = {
			...mutatedMeasurementWithoutDigest,
			measurementDigest: digestWithoutField(
				mutatedMeasurementWithoutDigest as unknown as Record<string, unknown>,
				"measurementDigest",
			),
		} as AutoResearchPortfolioMeasurement;
		await expectRejected(
			{
				...mutated,
				measurements: [
					{ measurement: mutatedMeasurement, receipt: mutated.measurements[0]!.receipt },
					...mutated.measurements.slice(1),
				],
			},
			/receipt|binding|terminal|complete/i,
		);

		const stale = validInput();
		await expectRejected({ ...stale, currentStateDigest: "stale-state" }, /receipt|state|stale|head/i);

		const consumed = validInput();
		const vector = consumed.measurements[0]!.measurement;
		const consumedReceipt = receipt(
			{
				receiptKind: "artifact",
				receiptId: "receipt-measurement",
				issuerId: "host-evaluator",
				payloadDigest: DIGEST,
				bindingDigest: portfolioMeasurementBindingDigest(consumed.contract, vector),
			},
			consumed.receiptContext,
		);
		const oneUse = {
			...consumed,
			measurements: [{ measurement: vector, receipt: consumedReceipt }, ...consumed.measurements.slice(1)],
		};
		await expectRejected(oneUse, /consum|replay|receipt|terminal|complete/i);
	});

	it("consumes host capability receipts once and rejects replay after completion", async () => {
		await withPersistedCompletion(async (fixture) => {
			const result = await bridgePortfolioToDefaultCompletion(fixture.request);
			expect(result.completionTransaction.receiptCommitments.length).toBeGreaterThan(0);
			const replay = await fixture.authorityInput.commitCompletion(persistedAtomicCommitInput(fixture, result));
			expect(replay.status).toBe("already_committed");
		});
	});

	it("returns one host-committed atomic completion transaction", async () => {
		const result = await withPersistedCompletion((fixture) => bridgePortfolioToDefaultCompletion(fixture.request));

		expect(result.commitStatus).toBe("committed");
		expect(result.completionTransaction).toMatchObject({
			terminalCommitIntent: expect.objectContaining({
				capability: "portfolio_default_completion",
				witnessRequired: true,
			}),
			receiptCommitments: expect.any(Array),
			transactionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		expect(result.completionTransaction.audit.splitProvenance.resolved).toHaveLength(3);
		for (const evaluation of result.goalMetricEvaluations) {
			expect(evaluation.evidenceRefs).toHaveLength(1);
			for (const supportingReceipt of evaluation.supportingReceipts) {
				expect(supportingReceipt).not.toHaveProperty("artifactRef");
			}
		}
	});

	it("requires the generic host principal-authorizer seam and rejects worker or self issuers", async () => {
		const input = validInput();
		const contextWithoutAuthorizer = { ...completionReceiptContext() } as Record<string, unknown>;
		delete contextWithoutAuthorizer.principalAuthorizer;
		expect(() =>
			requestFor({ ...input, receiptContext: contextWithoutAuthorizer } as unknown as PortfolioTerminalInput),
		).toThrow(/CONTRACT_CHANGE|principalAuthorizer/i);

		for (const issuerId of ["worker", "self"]) {
			const forgedIssuer = validInput();
			const baseContext = forgedIssuer.receiptContext;
			const guardedContext = {
				...baseContext,
				principalAuthorizer: {
					authorize: async (authorization: Parameters<typeof baseContext.principalAuthorizer.authorize>[0]) => {
						if (authorization.receipt.issuerId === issuerId)
							throw new Error("fixture principal authorization rejected");
						return baseContext.principalAuthorizer.authorize(authorization);
					},
				},
			};
			const candidateMeasurement = forgedIssuer.measurements[0]!;
			const terminalMeasurements = forgedIssuer.measurements.map(({ measurement }) => measurement);
			const resourceDigest = portfolioDefaultCompletionResourceDigest(
				forgedIssuer.contract,
				forgedIssuer,
				terminalMeasurements,
			);
			const measurementBinding = candidateMeasurement.receipt.bindingDigest;
			const issuerReceipt = receipt(
				{
					receiptKind: "artifact",
					receiptId: candidateMeasurement.receipt.receiptId,
					issuerId,
					payloadDigest: candidateMeasurement.receipt.payloadDigest,
					bindingDigest: candidateMeasurement.receipt.bindingDigest,
				},
				forgedIssuer.receiptContext,
				{
					resourceDigest,
					operationDigest: portfolioDefaultCompletionOperationDigest(
						forgedIssuer.contract,
						forgedIssuer,
						terminalMeasurements,
						"measurement",
						measurementBinding,
					),
				},
			);
			await expectRejected(
				{
					...forgedIssuer,
					receiptContext: guardedContext,
					measurements: [
						{ measurement: candidateMeasurement.measurement, receipt: issuerReceipt },
						...forgedIssuer.measurements.slice(1),
					],
				},
				/principal|authority|issuer|measurement receipt/i,
			);
		}
	});

	it("rejects baseline regression, epoch mutation, and parameter-hunting candidates", async () => {
		const regressed = validInput();
		const regressedMeasurements = regressed.measurements.map(({ measurement, receipt: evidenceReceipt }) => {
			const withoutDigest = {
				...measurement,
				vector: measurement.vector.map((coordinate) => ({ ...coordinate, value: 0.4 })),
				confidenceInterval: { lower: 0.3, upper: 0.5, level: measurement.confidenceInterval.level },
				measurementDigest: "",
			};
			const nextMeasurement = {
				...withoutDigest,
				measurementDigest: digestWithoutField(withoutDigest, "measurementDigest"),
			} as AutoResearchPortfolioMeasurement;
			const nextReceipt = receipt(
				{
					receiptKind: "artifact",
					receiptId: evidenceReceipt.receiptId,
					issuerId: evidenceReceipt.issuerId,
					payloadDigest: evidenceReceipt.payloadDigest,
					bindingDigest: portfolioMeasurementBindingDigest(regressed.contract, nextMeasurement),
				},
				regressed.receiptContext,
			);
			return { measurement: nextMeasurement, receipt: nextReceipt };
		});
		await expectRejected({ ...regressed, measurements: regressedMeasurements }, /baseline|regression/i);

		const epochMutated = validInput();
		const epochMeasurement = epochMutated.measurements[0]!.measurement;
		const epochWithoutDigest = { ...epochMeasurement, evaluationEpoch: 2, measurementDigest: "" };
		const epochValue = {
			...epochWithoutDigest,
			measurementDigest: digestWithoutField(epochWithoutDigest, "measurementDigest"),
		} as AutoResearchPortfolioMeasurement;
		await expectRejected(
			{
				...epochMutated,
				measurements: [
					{ measurement: epochValue, receipt: epochMutated.measurements[0]!.receipt },
					...epochMutated.measurements.slice(1),
				],
			},
			/epoch|canonical|binding/i,
		);

		const hunted = validInput();
		const huntedCandidate = {
			...completionCandidate(),
			change: { ...completionCandidate().change, parameterChanges: ["learning-rate=0.1"] },
		};
		await expect(bridgePortfolioToDefaultCompletion(requestFor(hunted, huntedCandidate))).rejects.toThrow(
			/parameter|preflight|candidate/i,
		);

		const frontierMismatch = validInput();
		const selectedCandidate = completionCandidate();
		const mismatchedFrontierCandidate = {
			...selectedCandidate,
			solutionFamily: { ...selectedCandidate.solutionFamily, familyId: "family-forged" },
		};
		await expect(
			bridgePortfolioToDefaultCompletion(
				requestFor(frontierMismatch, selectedCandidate, [], [mismatchedFrontierCandidate]),
			),
		).rejects.toThrow(/frontier|candidate|binding/i);
	});

	it("rejects boundary violations, holdout leakage, and unknown scalar records", async () => {
		const input = validInput();
		const violatedBoundary: PortfolioHostBoundaryEvidence = {
			...input.boundaries[0]!,
			passed: false,
			receipt: receipt(
				{
					receiptKind: "adjudication",
					receiptId: "receipt-boundary-failed",
					issuerId: "host-safety",
					payloadDigest: DIGEST,
					bindingDigest: portfolioBoundaryBindingDigest(input.contract, "boundary-safety", false),
				},
				input.receiptContext,
			),
		};
		await expectRejected({ ...input, boundaries: [violatedBoundary] }, /boundar|terminal|complete/i);

		const leaked = structuredClone(input.contract) as unknown as Record<string, unknown>;
		const leakedManifest = leaked.inputManifest as Record<string, unknown>;
		const leakedAccess = leakedManifest.modelAccess as Record<string, unknown>;
		leakedAccess.holdoutRowsVisible = true;
		Object.freeze(leakedManifest);
		Object.freeze(leaked);
		await expectRejected(
			{ ...input, contract: leaked as unknown as AutoResearchPortfolioContract },
			/holdout|contract|parsed/i,
		);

		await expectRejected(
			{ ...input, scalarEffect: 0 } as unknown as PortfolioTerminalInput,
			/unknown|scalar|record/i,
		);
	});

	it("rejects mutated holdout envelopes and data-closure metadata", async () => {
		await withPersistedCompletion(async (fixture) => {
			const holdout = fixture.authorityInput.holdoutAggregates[0]!;
			const forgedAuthorityInput: PortfolioCompletionHostAuthorityInput = {
				...fixture.authorityInput,
				holdoutAggregates: [
					{
						...holdout,
						envelope: { ...holdout.envelope, rawRows: [{ row: "forged" }] } as never,
					},
				],
			};
			await expect(
				bridgePortfolioToDefaultCompletion({
					terminal: fixture.request.terminal,
					authority: createPortfolioCompletionHostAuthority(forgedAuthorityInput),
				}),
			).rejects.toThrow(/holdout|aggregate|row/i);

			const forgedClosureAuthorityInput: PortfolioCompletionHostAuthorityInput = {
				...fixture.authorityInput,
				resolveDataClosure: async ({ split, manifestDigest: expectedManifestDigest, closureRootDigest }) => ({
					split,
					manifestDigest: expectedManifestDigest,
					closureRootDigest,
					artifactRefs: [fixture.request.terminal.completion.receipt.artifactRef],
					artifactDigests: [DIGEST],
				}),
			};
			await expect(
				bridgePortfolioToDefaultCompletion({
					terminal: fixture.request.terminal,
					authority: createPortfolioCompletionHostAuthority(forgedClosureAuthorityInput),
				}),
			).rejects.toThrow(/closure|rehash|artifact/i);
		});
	});

	it("uses the public persisted host and preserves consumption across reopen", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "portfolio-completion-persisted-"));
		const goalProjection = completionGoalProjection();
		let host: PersistedSessionWorkflowHost | undefined;
		let reopened: PersistedSessionWorkflowHost | undefined;
		try {
			const captureHolder: { current?: PersistedCompletionCapture } = {};
			host = await openPersistedCompletionHost(artifactRoot, captureHolder, goalProjection);
			await host.execute({
				kind: "start",
				request: { workflowId: WORKFLOW_ID, objective: "persist portfolio completion evidence" },
			});
			const capture = captureHolder.current;
			if (capture === undefined) throw new Error("persisted completion capture missing");
			const head = await persistedCompletionHead(capture.runtimeStore);
			const fixture = await persistedCompletionRequest(capture, head);
			const result = await bridgePortfolioToDefaultCompletion(fixture.request);
			expect(result.terminalOutcome).toBe("complete");
			expect(result.goalMetricEvaluations).toHaveLength(2);

			await host.dispose?.();
			host = undefined;
			const reopenedCaptureHolder: { current?: PersistedCompletionCapture } = {};
			reopened = await openPersistedCompletionHost(artifactRoot, reopenedCaptureHolder, goalProjection);
			const reopenedCapture = reopenedCaptureHolder.current;
			if (reopenedCapture === undefined) throw new Error("reopened completion capture missing");
			const reopenedHead = await persistedCompletionHead(reopenedCapture.runtimeStore);
			const reopenedTerminal: PortfolioTerminalInput = {
				...fixture.request.terminal,
				receiptContext: reopenedCapture.receiptContext,
				currentStateDigest: reopenedHead.stateDigest,
				currentRevision: reopenedHead.revision,
			};
			const reopenedAuthorityInput: PortfolioCompletionHostAuthorityInput = {
				...fixture.authorityInput,
				runtime: {
					...fixture.authorityInput.runtime,
					runtimeStore: reopenedCapture.runtimeStore,
					artifactResolver: reopenedCapture.receiptContext.artifactResolver,
					writerIdentity: reopenedHead.writerIdentity,
					resolveLeaseRef: async () => reopenedCapture.runtimeStore.durableContext!.currentLeaseRef(),
					receiptContext: reopenedCapture.receiptContext,
				},
				readCurrentHead: async () => ({
					stateDigest: reopenedHead.stateDigest,
					revision: reopenedHead.revision,
					evaluationEpoch: 1,
				}),
			};
			await expect(
				bridgePortfolioToDefaultCompletion({
					terminal: reopenedTerminal,
					authority: createPortfolioCompletionHostAuthority(reopenedAuthorityInput),
				}),
			).rejects.toThrow(/consum|replay|witness/i);
		} finally {
			await reopened?.dispose?.();
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	}, 120_000);

	it("recovers a pending atomic completion intent after a process reopen", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "portfolio-completion-crash-"));
		const goalProjection = completionGoalProjection();
		let host: PersistedSessionWorkflowHost | undefined;
		let reopened: PersistedSessionWorkflowHost | undefined;
		try {
			const captureHolder: { current?: PersistedCompletionCapture } = {};
			host = await openPersistedCompletionHost(artifactRoot, captureHolder, goalProjection);
			await host.execute({
				kind: "start",
				request: { workflowId: WORKFLOW_ID, objective: "persist portfolio completion crash recovery" },
			});
			const capture = captureHolder.current;
			if (capture === undefined) throw new Error("persisted completion capture missing");
			const head = await persistedCompletionHead(capture.runtimeStore);
			const fixture = await persistedCompletionRequest(capture, head);
			const crashingAuthorityInput: PortfolioCompletionHostAuthorityInput = {
				...fixture.authorityInput,
				commitCompletion: persistedCompletionAtomicCommitter(capture, { crashAfterConsumption: true }),
			};
			await expect(
				bridgePortfolioToDefaultCompletion({
					terminal: fixture.request.terminal,
					authority: createPortfolioCompletionHostAuthority(crashingAuthorityInput),
				}),
			).rejects.toThrow("persisted_completion_atomic_simulated_crash");
			await host.dispose?.();
			host = undefined;

			const reopenedCaptureHolder: { current?: PersistedCompletionCapture } = {};
			reopened = await openPersistedCompletionHost(artifactRoot, reopenedCaptureHolder, goalProjection);
			const reopenedCapture = reopenedCaptureHolder.current;
			if (reopenedCapture === undefined) throw new Error("reopened completion capture missing");
			const reopenedHead = await persistedCompletionHead(reopenedCapture.runtimeStore);
			const reopenedTerminal: PortfolioTerminalInput = {
				...fixture.request.terminal,
				receiptContext: reopenedCapture.receiptContext,
				currentStateDigest: reopenedHead.stateDigest,
				currentRevision: reopenedHead.revision,
			};
			const reopenedAuthorityInput: PortfolioCompletionHostAuthorityInput = {
				...fixture.authorityInput,
				runtime: {
					...fixture.authorityInput.runtime,
					runtimeStore: reopenedCapture.runtimeStore,
					artifactResolver: reopenedCapture.receiptContext.artifactResolver,
					writerIdentity: reopenedHead.writerIdentity,
					resolveLeaseRef: async () => reopenedCapture.runtimeStore.durableContext!.currentLeaseRef(),
					receiptContext: reopenedCapture.receiptContext,
				},
				resolveDataClosure: async ({ split, manifestDigest: expectedManifestDigest, closureRootDigest }) => ({
					split,
					manifestDigest: expectedManifestDigest,
					closureRootDigest,
					artifactRefs: [fixture.dataClosureRefs.get(split)!],
					artifactDigests: [fixture.dataClosureRefs.get(split)!.digest],
				}),
				commitCompletion: persistedCompletionAtomicCommitter(reopenedCapture),
				readCurrentHead: async () => ({
					stateDigest: reopenedHead.stateDigest,
					revision: reopenedHead.revision,
					evaluationEpoch: 1,
				}),
			};
			const result = await bridgePortfolioToDefaultCompletion({
				terminal: reopenedTerminal,
				authority: createPortfolioCompletionHostAuthority(reopenedAuthorityInput),
			});
			expect(result.commitStatus).toBe("committed");
			const replay = await reopenedCapture.runtimeStore.replay({
				workflowId: WORKFLOW_ID,
				fromSequence: 0,
				expectedStoreEpoch: reopenedCapture.runtimeStore.durableContext!.epochRef.storeEpoch,
			});
			expect(replay.events.some((event) => event.payload.kind === "workflow_completion_cut_sealed")).toBe(true);
		} finally {
			await reopened?.dispose?.();
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	}, 120_000);
});
