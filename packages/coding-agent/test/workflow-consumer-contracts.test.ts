import { describe, expect, it } from "vitest";
import type {
	DurableDecisionRecord,
	DurableStoreCrashBoundaryHook,
	WorkflowImprovementEvent as KWorkflowImprovementEvent,
	WorkflowActiveLeaseContext,
	WorkflowAdaptiveAllocationController,
	WorkflowAdaptiveAllocationEntry,
	WorkflowAdaptiveAllocationHost,
	WorkflowAdaptiveAllocationState,
	WorkflowApprovalReceipt,
	WorkflowApprovalResponse,
	WorkflowArtifactEnvelope,
	WorkflowArtifactPublishInput,
	WorkflowArtifactPublishResult,
	WorkflowArtifactRef,
	WorkflowAttemptReconciliationSummary,
	WorkflowAutoResearchEventPayload,
	WorkflowBlockerAlternativeResult,
	WorkflowCanonicalPoolLedger,
	WorkflowCanonicalPoolMap,
	WorkflowCapacityGrant,
	WorkflowChildAuthority,
	WorkflowChildCapability,
	WorkflowChildIdentity,
	WorkflowChildProcessBinding,
	WorkflowCloudAvailabilityRequest,
	WorkflowCloudAvailabilityResponse,
	WorkflowCloudCapacityReceipt,
	WorkflowCloudCapacityReceiptStore,
	WorkflowCommitReturnProof,
	WorkflowConcreteEffect,
	WorkflowCoordinatorLeaseRecord,
	WorkflowDecisionRef,
	WorkflowDescriptorFs,
	WorkflowDescriptorHandle,
	WorkflowDescriptorRootAdapters,
	WorkflowDispatchBlockingReason,
	WorkflowEffectPreimageResolver,
	WorkflowEfficiencyRedTeamResult,
	WorkflowEfficiencyRedTeamWindowState,
	WorkflowEfficiencyReviewReport,
	WorkflowEfficiencyReviewSchedule,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowEventType,
	WorkflowEvidenceEnvelope,
	WorkflowEvidenceEnvelopeRef,
	WorkflowGenerationBinding,
	WorkflowGenerationRotation,
	WorkflowHostAdjudicationReceipt,
	WorkflowHostReceiptConsumerContext,
	WorkflowHostReceiptResolver,
	WorkflowImprovementEvent,
	WorkflowJournalCommit,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowLeaseReleaseInput,
	WorkflowLeaseReleaseRef,
	WorkflowLeaseReleaseResult,
	WorkflowOpaquePostCommitExtension,
	WorkflowOutboxAppendInput,
	WorkflowOutboxAppendResult,
	WorkflowOwnershipLease,
	WorkflowPhaseOutcome,
	WorkflowPhaseOutcomeRecord,
	WorkflowProcessGroupIdentity,
	WorkflowProcessSpawnRequest,
	WorkflowProjectionAdapter,
	WorkflowProposalRecord,
	WorkflowQueueObservation,
	WorkflowReceiptVerificationKeyResolver,
	WorkflowReconciliationProposal,
	WorkflowResourceAdmission,
	WorkflowResourceEnvelope,
	WorkflowResourceGrantLedger,
	WorkflowResourceGrantLedgerStore,
	WorkflowResourceLease,
	WorkflowRevisionBoundaryContext,
	WorkflowRevisionRegistryEntry,
	WorkflowRevisionRegistryState,
	WorkflowRevisionResolution,
	WorkflowRevisionTuple,
	WorkflowRuntimeEventPayload,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreIdentity,
	WorkflowRuntimeStoreOpenInput,
	WorkflowSemanticMutationBinding,
	WorkflowSignedApprovalArtifact,
	WorkflowSnapshotPublishInput,
	WorkflowSnapshotPublishResult,
	WorkflowSpecializationProjection,
	WorkflowStoreCommitInput,
	WorkflowStoreCommitResult,
	WorkflowVerifiedHostReceipt,
	WorkflowZeroControlCapacityVector,
} from "../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	DurableStoreCrashBoundary,
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	WORKFLOW_EVENT_KINDS,
} from "../src/core/workflow/contracts.js";
import type {
	WorkflowActiveGenerationRecord,
	WorkflowAppendLease,
	WorkflowCommitReturnProofStore,
	WorkflowGenerationContext,
	WorkflowGenerationRotationRecoveryRecord,
	WorkflowGenerationRotationStore,
	WorkflowGoalProjectionAuthorization,
	WorkflowJournal,
	WorkflowJournalAppendInput,
	WorkflowJournalKeyProvider,
} from "../src/core/workflow/journal.js";
import type { WorkflowRecoveryPort } from "../src/core/workflow/recovery.js";
import { loadPersistedEpochFixture } from "./workflow-fixtures.js";

const epochFixture = loadPersistedEpochFixture();
const acquiredEpoch = epochFixture.acquired;

const createFixtureLeaseRef = (
	leaseId: string,
	acquisitionEventSequence: number,
	epoch: WorkflowEpochRef = acquiredEpoch,
): WorkflowLeaseRef => ({
	...epoch,
	leaseId,
	acquisitionEventSequence,
	processIdentity: "process-1",
	rootDigest: "root-1",
	writerIdentity: "writer-1",
	acquiredAt: "2026-08-13T00:00:00.000Z",
	expiresAt: "2026-08-13T00:05:00.000Z",
});

type ConsumerMatrix = {
	autoresearch: (proposal: WorkflowProposalRecord) => DurableDecisionRecord;
	nativeMethodology: (proposal: WorkflowProposalRecord) => DurableDecisionRecord;
	recovery: (proposal: WorkflowReconciliationProposal) => WorkflowChildIdentity | null;
	opaquePostCommit: (extension: WorkflowOpaquePostCommitExtension) => string;
};

const consumerCompilationWitness: ConsumerMatrix = {
	autoresearch: (proposal) => proposal.decision,
	nativeMethodology: (proposal) => proposal.decision,
	recovery: (proposal) => proposal.outcome.observedChildIdentity,
	opaquePostCommit: (extension) => extension.digest,
};

type AImportedContractAssignabilityWitness = {
	activeLease: WorkflowActiveLeaseContext;
	adaptiveController: WorkflowAdaptiveAllocationController;
	adaptiveEntry: WorkflowAdaptiveAllocationEntry;
	adaptiveHost: WorkflowAdaptiveAllocationHost;
	adaptiveState: WorkflowAdaptiveAllocationState;
	approvalResponse: WorkflowApprovalResponse;
	artifactEnvelope: WorkflowArtifactEnvelope;
	artifactPublishResult: WorkflowArtifactPublishResult;
	attemptReconciliation: WorkflowAttemptReconciliationSummary;
	blockerAlternative: WorkflowBlockerAlternativeResult;
	capacityGrant: WorkflowCapacityGrant;
	childAuthority: WorkflowChildAuthority;
	childCapability: WorkflowChildCapability;
	canonicalPoolLedger: WorkflowCanonicalPoolLedger;
	canonicalPoolMap: WorkflowCanonicalPoolMap;
	cloudCapacity: WorkflowCloudCapacityReceipt;
	cloudCapacityStore: WorkflowCloudCapacityReceiptStore;
	coordinatorLease: WorkflowCoordinatorLeaseRecord;
	descriptorRoots: WorkflowDescriptorRootAdapters;
	efficiencyResult: WorkflowEfficiencyRedTeamResult;
	efficiencyReport: WorkflowEfficiencyReviewReport;
	efficiencySchedule: WorkflowEfficiencyReviewSchedule;
	efficiencyWindow: WorkflowEfficiencyRedTeamWindowState;
	generationBinding: WorkflowGenerationBinding;
	hostAdjudication: WorkflowHostAdjudicationReceipt;
	hostReceiptContext: WorkflowHostReceiptConsumerContext;
	hostReceiptResolver: WorkflowHostReceiptResolver;
	improvementEvent: WorkflowImprovementEvent;
	improvementEventAlias: KWorkflowImprovementEvent;
	leaseReleaseInput: WorkflowLeaseReleaseInput;
	leaseRelease: WorkflowLeaseReleaseResult;
	outboxInput: WorkflowOutboxAppendInput;
	outboxResult: WorkflowOutboxAppendResult;
	ownershipLease: WorkflowOwnershipLease;
	projectionAdapter: WorkflowProjectionAdapter;
	receiptKeyResolver: WorkflowReceiptVerificationKeyResolver;
	resourceAdmission: WorkflowResourceAdmission;
	resourceEnvelope: WorkflowResourceEnvelope;
	resourceLedger: WorkflowResourceGrantLedger;
	resourceLedgerStore: WorkflowResourceGrantLedgerStore;
	resourceLease: WorkflowResourceLease;
	revisionBoundary: WorkflowRevisionBoundaryContext;
	revisionEntry: WorkflowRevisionRegistryEntry;
	revisionRegistry: WorkflowRevisionRegistryState;
	revisionResolution: WorkflowRevisionResolution;
	revisionTuple: WorkflowRevisionTuple;
	runtimeIdentity: WorkflowRuntimeStoreIdentity;
	signedApproval: WorkflowSignedApprovalArtifact;
	snapshotInput: WorkflowSnapshotPublishInput;
	snapshotResult: WorkflowSnapshotPublishResult;
	verifiedReceipt: WorkflowVerifiedHostReceipt;
	zeroControl: WorkflowZeroControlCapacityVector;
};

const acceptAImportedContractSurface = <T extends AImportedContractAssignabilityWitness>(surface: T): T => surface;

const childIdentity: WorkflowChildIdentity = {
	admissionId: "admission-1",
	childSessionId: "child-1",
	processGroupId: "group-1",
	executionKey: "execution-1",
	epochRef: acquiredEpoch,
	runtimeVersion: "runtime-1",
	hostCapabilityRevision: "host-1",
	agentRole: "worker",
	modelId: "model-1",
	reasoningEffort: "medium",
	launchConfigDigest: "launch-1",
	identityDigest: "identity-1",
};
const childProcessBinding: WorkflowChildProcessBinding = {
	workflowId: "wf-1",
	taskId: "task-1",
	attemptId: "attempt-1",
	childIdentity,
	processGroup: {
		pid: 123,
		processStartId: "start-1",
		processGroupId: "group-1",
		parentPid: 1,
		identityDigest: "process-1",
	},
	bindingDigest: "binding-1",
};

const cloudRequest: WorkflowCloudAvailabilityRequest = {
	requestId: "capacity-1",
	provider: "provider",
	accountRef: "account",
	region: "region",
	credentialRef: "credential",
	requestedVector: {
		cpuMilliCores: 1,
		memoryBytes: 1,
		diskBytes: 1,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 1,
		monetaryMicrounits: 0,
	},
	egressPolicyDigest: "egress",
	quotaPolicyDigest: "quota-policy",
	pricingPolicyDigest: "pricing-policy",
	billingPolicyDigest: "billing-policy",
	terminationPolicyDigest: "termination-policy",
	timeoutMilliseconds: 5_000,
	requestedAt: "2026-08-13T00:00:00.000Z",
};
const cloudResponse: WorkflowCloudAvailabilityResponse = {
	requestDigest: digestObject(cloudRequest),
	status: "unknown",
	provider: cloudRequest.provider,
	accountRef: cloudRequest.accountRef,
	region: cloudRequest.region,
	capacityArtifactRef: null,
	pricingArtifactRef: null,
	pricingDigest: null,
	authorityDigest: null,
	credentialArtifactRef: null,
	quotaArtifactRef: null,
	rateLimitArtifactRef: null,
	billingArtifactRef: null,
	egressArtifactRef: null,
	terminationArtifactRef: null,
	responseArtifactRef: null,
	responseReceipt: null,
	responseKeyId: null,
	responseMac: null,
	responseChecksum: null,
	validUntil: null,
	reasonCode: "unknown_quota",
};

const runtimePayload: WorkflowRuntimeEventPayload = {
	kind: "workflow_dispatch_readiness_observed",
	workflowId: "wf-1",
	epochRef: acquiredEpoch,
	readinessDigest: "readiness",
	canDispatch: false,
	blockingReasons: ["kernel_contract_unavailable"],
};

const evidenceEnvelope: WorkflowEvidenceEnvelope = {
	evidenceId: "evidence-1",
	evidenceRevision: 1,
	requirementId: "requirement-1",
	claim: "The bounded host check passed.",
	result: "exit-zero",
	method: "independent-integration-test",
	command: {
		commandDigest: "command",
		exitState: "exited",
		exitCode: 0,
		signal: null,
		stdout: "ok",
		stderr: "",
		stdoutBytes: 2,
		stderrBytes: 0,
		outputDigest: "output",
		outputTruncated: false,
	},
	artifactObservations: [
		{
			artifactRef: {
				artifactId: "artifact-1",
				relativePath: "evidence/result",
				digest: "artifact",
				sizeBytes: 2,
				sourceEventSequence: 1,
			},
			exists: true,
			verifiedDigest: "artifact",
			verifiedSizeBytes: 2,
		},
	],
	scanner: {
		scannerDigest: "scanner",
		scanStatus: "passed",
		redactionStatus: "not_required",
		findingCodes: [],
		findingDigest: "findings",
	},
	confidence: "high",
	limitations: [],
	workspaceDigest: "workspace",
	configDigest: "config",
	revisions: { contractRevision: 1, scorecardRevision: 1, planRevision: 1, configRevision: 1, evidenceRevision: 1 },
	evaluatorDigest: "evaluator",
	parserDigest: "parser",
	guardDigest: "guard",
	updatedDigest: "updated",
	invalidatedByDecisionRef: null,
	regressed: false,
	auditorDecisionRef: null,
	observedAt: "2026-08-13T00:00:00.000Z",
	freshUntil: "2026-08-13T00:05:00.000Z",
	freshnessWindowMilliseconds: 300_000,
};
const evidenceEnvelopeRef: WorkflowEvidenceEnvelopeRef = {
	workflowId: "wf-1",
	envelopeId: evidenceEnvelope.evidenceId,
	envelopeDigest: "evidence",
	evidenceRevision: evidenceEnvelope.evidenceRevision,
	artifactRefs: evidenceEnvelope.artifactObservations.map((observation) => observation.artifactRef),
	validationReceipt: createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: "evidence-validation",
		issuerId: "evidence-host",
		workflowId: "wf-1",
		bindingDigest: "evidence",
		payloadDigest: "evidence",
		artifactRef: {
			artifactId: "evidence-validation",
			relativePath: "receipts/evidence-validation",
			digest: "evidence-validation",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		issuedAt: "2026-08-13T00:00:00.000Z",
		validUntil: "2026-08-13T00:05:00.000Z",
		keyId: "evidence-key",
		signature: "evidence-signature",
	}),
};
void [evidenceEnvelope, evidenceEnvelopeRef];

type RequiredAutoResearchEventKind =
	| "scorecard_proposed"
	| "scorecard_red_teamed"
	| "scorecard_approved"
	| "initialization_intent"
	| "projection_intent"
	| "frontier_init_intent"
	| "frontier_initialized"
	| "baseline_intent"
	| "initialized"
	| "projection_committed"
	| "candidate_claim_intent"
	| "candidate_dispatched"
	| "lease_renewed"
	| "candidate_handoff_published"
	| "finish_intent"
	| "metric_recorded"
	| "guard_recorded"
	| "admission_lock_acquired"
	| "stale_rebase_requested"
	| "remeasured"
	| "candidate_red_teamed"
	| "frontier_update_intent"
	| "candidate_admitted"
	| "candidate_discarded"
	| "admission_lock_released"
	| "candidate_abandoned"
	| "candidate_reaped"
	| "recovery_classified"
	| "stop_requested"
	| "budget_limited"
	| "blocked"
	| "candidate_target_observed"
	| "target_reached"
	| "verification_gap_found"
	| "run_archive_intent"
	| "run_archived"
	| "verified"
	| "completion_audited"
	| "refinement_recorded"
	| "completed";
type RequireClosedAutoResearchPayload<K extends RequiredAutoResearchEventKind> = [
	Extract<WorkflowEventPayload, { kind: K }>,
] extends [never]
	? never
	: true;
const requiredAutoResearchPayloads: { [K in RequiredAutoResearchEventKind]: RequireClosedAutoResearchPayload<K> } = {
	scorecard_proposed: true,
	scorecard_red_teamed: true,
	scorecard_approved: true,
	initialization_intent: true,
	projection_intent: true,
	frontier_init_intent: true,
	frontier_initialized: true,
	baseline_intent: true,
	initialized: true,
	projection_committed: true,
	candidate_claim_intent: true,
	candidate_dispatched: true,
	lease_renewed: true,
	candidate_handoff_published: true,
	finish_intent: true,
	metric_recorded: true,
	guard_recorded: true,
	admission_lock_acquired: true,
	stale_rebase_requested: true,
	remeasured: true,
	candidate_red_teamed: true,
	frontier_update_intent: true,
	candidate_admitted: true,
	candidate_discarded: true,
	admission_lock_released: true,
	candidate_abandoned: true,
	candidate_reaped: true,
	recovery_classified: true,
	stop_requested: true,
	budget_limited: true,
	blocked: true,
	candidate_target_observed: true,
	target_reached: true,
	verification_gap_found: true,
	run_archive_intent: true,
	run_archived: true,
	completion_audited: true,
	refinement_recorded: true,
	completed: true,
	verified: true,
};
const autoresearchPayloadWitness = <K extends RequiredAutoResearchEventKind>(
	payload: Extract<WorkflowEventPayload, { kind: K }>,
): Extract<WorkflowEventPayload, { kind: K }> => payload;
type AutoResearchPayloadKind = Exclude<RequiredAutoResearchEventKind, "scorecard_proposed">;
const autoPayloadWitness = <K extends AutoResearchPayloadKind>(
	payload: Extract<WorkflowAutoResearchEventPayload, { kind: K }>,
): Extract<WorkflowAutoResearchEventPayload, { kind: K }> => payload;
void requiredAutoResearchPayloads;
void autoresearchPayloadWitness;
void autoPayloadWitness;
const projectionCommittedPayload: Extract<WorkflowEventPayload, { kind: "projection_committed" }> = {
	kind: "projection_committed",
	workflowId: "wf-1",
	epochRef: acquiredEpoch,
	executionKey: "projection-1",
	runId: "run-1",
	expectedPrefix: null,
	resultPrefix: { sequence: 1, digest: "prefix" },
	projectionArtifactRef: {
		artifactId: "projection-1",
		relativePath: "projections/projection-1",
		digest: "projection",
		sizeBytes: 1,
		sourceEventSequence: 1,
	},
	effectDigest: "effect",
};
void projectionCommittedPayload;
const approvalDecisionRef: WorkflowDecisionRef = {
	decisionScope: { kind: "workflow", workflowId: "wf-1", rootSessionId: "session-1" },
	decisionId: "decision-1",
	revision: 1,
	...acquiredEpoch,
	decisionDigest: "decision",
	coordinatorEpoch: acquiredEpoch.coordinatorEpoch,
};
const approvalReceipt: WorkflowApprovalReceipt = {
	approvalRequestId: "approval-1",
	workflowId: "wf-1",
	decisionRef: approvalDecisionRef,
	decisionRefs: [],
	headDigest: "head",
	stateDigest: "state",
	configDigest: "config",
	profileDigest: "profile",
	artifactDigest: "artifact",
	...acquiredEpoch,
	clientSessionId: "client-1",
	trustedPrincipal: { kind: "interactive_ui", principalId: "user-1", credentialDigest: "credential" },
	responseSequence: 1,
	optionId: "approve",
	decisionRoles: { goal: approvalDecisionRef, scorecard: approvalDecisionRef, resource: approvalDecisionRef },
	effectDigest: "effect",
	mode: "interactive_secret",
	responseDigest: "response",
	consumedAt: "2026-08-13T00:00:00.000Z",
	consumptionEventSequence: 1,
	trustedClockReceipt: createFixtureHostReceipt({
		receiptKind: "clock",
		receiptId: "approval-clock",
		issuerId: "approval-host",
		workflowId: "wf-1",
		bindingDigest: "clock-binding",
		payloadDigest: "clock-payload",
		artifactRef: {
			artifactId: "approval-clock",
			relativePath: "receipts/approval-clock",
			digest: "clock",
			sizeBytes: 1,
			sourceEventSequence: 0,
		},
		issuedAt: "2026-08-13T00:00:00.000Z",
		validUntil: "2026-08-13T00:05:00.000Z",
		keyId: "clock-key",
		signature: "clock-signature",
	}),
};
const resourceApprovedPayload: Extract<WorkflowEventPayload, { kind: "resource_approved" }> = {
	kind: "resource_approved",
	envelopeDigest: "envelope",
	receipt: approvalReceipt,
};
void resourceApprovedPayload;

type RuntimeEventByKind = {
	[K in WorkflowRuntimeEventPayload["kind"]]: Extract<WorkflowRuntimeEventPayload, { kind: K }>;
};
type RuntimePayloadConsumer = {
	[K in WorkflowRuntimeEventPayload["kind"]]: (payload: RuntimeEventByKind[K]) => RuntimeEventByKind[K];
};
const runtimePayloadConsumer: RuntimePayloadConsumer = {
	workflow_coordinator_lease_acquired: (payload) => payload,
	workflow_coordinator_lease_renewed: (payload) => payload,
	workflow_coordinator_fenced: (payload) => payload,
	workflow_dispatch_readiness_observed: (payload) => payload,
	workflow_resource_lease_acquired: (payload) => payload,
	workflow_task_lease_heartbeat: (payload) => payload,
	workflow_ownership_lease_acquired: (payload) => payload,
	workflow_dispatch_intent: (payload) => payload,
	workflow_child_identity_bound: (payload) => payload,
	workflow_child_outcome_committed: (payload) => payload,
	workflow_external_blocker_recorded: (payload) => payload,
	workflow_external_blocker_resolved: (payload) => payload,
	workflow_effect_intent: (payload) => payload,
	workflow_effect_completed: (payload) => payload,
	workflow_effect_ambiguous: (payload) => payload,
	workflow_process_group_owned: (payload) => payload,
	workflow_process_group_fenced: (payload) => payload,
	workflow_process_group_reaped: (payload) => payload,
	workflow_lease_release_recorded: (payload) => payload,
	workflow_lease_quarantined: (payload) => payload,
	workflow_scheduler_observation: (payload) => payload,
	workflow_progress_lease_acquired: (payload) => payload,
	workflow_progress_stalled: (payload) => payload,
	workflow_progress_lease_closed: (payload) => payload,
	workflow_progress_recovery_started: (payload) => payload,
	workflow_recovery_started: (payload) => payload,
	workflow_reconciliation_recorded: (payload) => payload,
	workflow_cancellation_intent: (payload) => payload,
	workflow_cancellation_descendants_reconciled: (payload) => payload,
	workflow_cancelled: (payload) => payload,
	checkpoint_budget_observed: (payload) => payload,
	workflow_observation_outcome_recorded: (payload) => payload,
	workflow_completion_cut_sealed: (payload) => payload,
	workflow_late_observation_policy_recorded: (payload) => payload,
};
void runtimePayloadConsumer;
const processRequest: WorkflowProcessSpawnRequest = {
	executable: "node",
	arguments: [],
	cwd: ".",
	detached: true,
	requireProcessStartId: true,
};
const executablePreimageRef: WorkflowArtifactRef = {
	artifactId: "executable-1",
	relativePath: "effects/executable-1",
	digest: "node",
	sizeBytes: 4,
	sourceEventSequence: 1,
};
const argumentsPreimageRef: WorkflowArtifactRef = {
	artifactId: "arguments-1",
	relativePath: "effects/arguments-1",
	digest: "empty",
	sizeBytes: 0,
	sourceEventSequence: 1,
};
const effect: WorkflowConcreteEffect = {
	kind: "child_process_spawn",
	operationId: "compile-only",
	executablePreimageRef,
	argumentsPreimageRef,
	cwd: ".",
	processGroupRequest: processRequest,
};
const effectPreimages = createEffectPreimageResolverFixture();
const releaseRef: WorkflowLeaseReleaseRef = {
	leaseRef: createFixtureLeaseRef("lease-1", 1),
	attemptId: "attempt-1",
	terminalOutcomeDigest: "outcome",
	releaseEventSequence: 2,
	releaseProof: "release-proof",
};
const releasePayload: Extract<WorkflowRuntimeEventPayload, { kind: "workflow_lease_release_recorded" }> = {
	kind: "workflow_lease_release_recorded",
	workflowId: "wf-1",
	releaseRef,
	epochRef: acquiredEpoch,
	status: "released",
};
void releasePayload;
const phaseOutcome: WorkflowPhaseOutcome = {
	status: "complete",
	workflowId: "wf-1",
	phaseAttemptId: "phase-attempt-1",
	epochRef: acquiredEpoch,
	invocationToken: "invocation-1",
	inputStateDigest: "input",
	artifactRefs: [],
	evidenceRefs: [],
	outputStateDigest: "output",
};
const phaseOutcomeRecord: WorkflowPhaseOutcomeRecord = { outcome: phaseOutcome, attemptStatus: "completed" };
void phaseOutcomeRecord;
const queue: WorkflowQueueObservation = {
	taskId: "task-1",
	attemptId: "attempt-1",
	enqueuedAt: "2030-01-01T00:00:00.000Z",
	ageMs: 0,
	priority: 1,
	required: {
		cpuMilliCores: 1,
		memoryBytes: 1,
		diskBytes: 1,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 1,
		monetaryMicrounits: 0,
	},
	blockedBy: ["same_process_child_session"],
};
const processGroup: WorkflowProcessGroupIdentity = {
	pid: 1,
	processStartId: "start",
	processGroupId: "group",
	parentPid: 1,
	identityDigest: "digest",
};
const blockingReason: WorkflowDispatchBlockingReason = queue.blockedBy[0];
const artifactPublish: WorkflowArtifactPublishInput = {
	workflowId: "wf-1",
	payloadKind: "evidence",
	bytes: new Uint8Array(),
	codec: "binary",
	sourceEventSequence: 1,
	idempotencyKey: "artifact-1",
};
const expectedHead: WorkflowJournalHead = {
	workflowId: "wf-1",
	sequence: 0,
	eventDigest: null,
	epochRef: acquiredEpoch,
};
const fixtureSemanticBinding: WorkflowSemanticMutationBinding = {
	mutationId: "fixture-mutation",
	baselineDigest: "state",
	expectedGenerations: { workflow: 1 },
	ownerId: "fixture-owner",
	phase: "planning",
	reducerDigest: "fixture-reducer",
	semanticHead: {
		workflowId: "wf-1",
		sequence: 0,
		eventDigest: null,
		stateDigest: "state",
		epochRef: acquiredEpoch,
		generation: 1,
	},
	expectedHead,
	idempotencyKey: "fixture-mutation",
	executionKey: null,
	writerIdentity: "writer-1",
	leaseRef: createFixtureLeaseRef("lease-1", 1),
	epochRef: acquiredEpoch,
};
const workflowInitializer: Extract<WorkflowEventPayload, { kind: "workflow_started" }> = {
	kind: "workflow_started",
	workflowId: "wf-1",
	rootSessionId: "session-1",
	objective: "x",
};
const journalAppendInput: WorkflowJournalAppendInput = {
	workflowId: "wf-1",
	payload: workflowInitializer,
	expectedHead,
	epochRef: acquiredEpoch,
	leaseRef: createFixtureLeaseRef("lease-1", 1),
	idempotencyKey: "journal-1",
	writerIdentity: "writer-1",
	executionKey: null,
	semanticBinding: fixtureSemanticBinding,
	returnProofId: "return-proof:journal-1",
};
const journal = createJournalFixture();
void [effect, queue, processGroup, blockingReason, artifactPublish, expectedHead, workflowInitializer];

const runtimeCommitInput: WorkflowStoreCommitInput<WorkflowRuntimeEventPayload> = {
	workflowId: "wf-1",
	payload: runtimePayload,
	expectedHead,
	epochRef: acquiredEpoch,
	leaseRef: createFixtureLeaseRef("lease-1", 1),
	idempotencyKey: "runtime-1",
	writerIdentity: "writer-1",
	executionKey: null,
	semanticBinding: fixtureSemanticBinding,
};
const runtimeStore = createRuntimeStoreFixture();
const recoveryPort = createRecoveryPortFixture();
const keyProvider = createKeyProviderFixture();
const appendLease = createAppendLeaseFixture();
const runtimeOpenInput: WorkflowRuntimeStoreOpenInput = {
	artifactRoot: "session-artifacts/session-1",
	workflowRoot: "session-artifacts/session-1/workflows/wf-1",
	descriptorRoots: {
		sessionRoot: {
			rootSessionId: "session-1",
			descriptorRoot: "session-artifacts/session-1",
			identityDigest: "session-descriptor",
		},
		workflowRoot: {
			workflowId: "wf-1",
			descriptorRoot: "session-artifacts/session-1/workflows/wf-1",
			identityDigest: "workflow-descriptor",
		},
	},
	workflowId: "wf-1",
	rootSessionId: "session-1",
	...acquiredEpoch,
	writerIdentity: "writer-1",
	keyProvider,
	appendLease,
	leaseRef: createFixtureLeaseRef("lease-1", 1),
	descriptorFs: createDescriptorFsFixture(),
	now: () => "2026-08-13T00:00:00.000Z",
};
void effectPreimages;
void runtimeOpenInput;

const specialization: WorkflowSpecializationProjection = {
	kind: "autoresearch",
	contractVersion: "1",
	phaseTag: "planning",
	statusTag: "awaiting_user",
	sourceJournalSequence: 1,
	sourceJournalDigest: "journal",
	payloadRef: {
		artifactId: "projection-1",
		relativePath: "projections/projection-1",
		digest: "projection",
		sizeBytes: 1,
		sourceEventSequence: 1,
	},
};
void childIdentity;
void cloudResponse;
void specialization;

function createEffectPreimageResolverFixture(): WorkflowEffectPreimageResolver {
	return {
		resolve: async (ref) => ({
			artifactRef: ref,
			codec: "binary",
			immutable: true,
			bytes: new Uint8Array(),
			verifiedDigest: ref.digest,
			verifiedSizeBytes: ref.sizeBytes,
		}),
	};
}

function createJournalFixture(): WorkflowJournal {
	const fixtureGeneration = "generation-0123456789abcdef0123456789abcdef";
	const emptyRecovery: Awaited<ReturnType<WorkflowJournal["recover"]>> = {
		quarantined: false,
		events: [],
		metadata: {
			status: "complete",
			sourcePath: "events.log",
			sourceDigest: "empty",
			sourceSizeBytes: 0,
			sequence: 0,
			epochRef: acquiredEpoch,
			reason: "none",
		},
	};
	const expectedHead: WorkflowJournalHead = {
		workflowId: "wf-1",
		sequence: 0,
		eventDigest: null,
		epochRef: acquiredEpoch,
	};
	const leaseRef = createFixtureLeaseRef("lease-fixture", 1);
	const semanticBinding: WorkflowSemanticMutationBinding = {
		mutationId: "fixture",
		baselineDigest: "baseline",
		expectedGenerations: {},
		ownerId: "fixture",
		phase: "planning",
		reducerDigest: "reducer",
		semanticHead: {
			workflowId: "wf-1",
			sequence: 0,
			eventDigest: null,
			stateDigest: "state",
			epochRef: acquiredEpoch,
			generation: 1,
		},
		expectedHead,
		idempotencyKey: "fixture",
		executionKey: null,
		writerIdentity: "writer-1",
		leaseRef,
		epochRef: acquiredEpoch,
	};
	const commitReturnProof: WorkflowCommitReturnProof = {
		recordVersion: 1,
		generationId: fixtureGeneration,
		mutationId: "fixture",
		workflowId: "wf-1",
		sequence: 1,
		eventDigest: "event",
		committedFrameDigest: "committed",
		expectedHead,
		epochRef: acquiredEpoch,
		leaseRef,
		writerIdentity: "writer-1",
		idempotencyKey: "fixture",
		keyId: "key",
		frameMac: "mac",
		frameChecksum: "checksum",
		recordMac: "mac",
		recordChecksum: "checksum",
		priorRecordDigest: null,
		returnedAt: "2030-01-01T00:00:00.000Z",
		proofDigest: "proof",
	};
	const event: Awaited<ReturnType<WorkflowJournal["append"]>> = {
		workflowId: "wf-1",
		sequence: 1,
		kind: "workflow_started",
		eventType: "workflow_started",
		payload: { kind: "workflow_started", workflowId: "wf-1", rootSessionId: "session-1", objective: "fixture" },
		payloadBytes: new Uint8Array(),
		payloadDigest: "payload",
		priorEventDigest: null,
		eventDigest: "event",
		recordVersion: 1,
		generationId: fixtureGeneration,
		recordMac: "mac",
		recordChecksum: "checksum",
		idempotencyKey: "fixture",
		returnProofId: "return-proof:fixture",
		expectedHead,
		executionKey: null,
		epochRef: acquiredEpoch,
		leaseRef,
		writerIdentity: "writer-1",
		preparedFrameDigest: "prepared",
		committedFrameDigest: "committed",
		keyId: "key",
		preparedFrameMac: "mac",
		committedFrameMac: "mac",
		preparedFrameChecksum: "checksum",
		committedFrameChecksum: "checksum",
		semanticBinding,
		commitReturnProof,
	};
	let latestEvent = event;
	return {
		append: async (input) => {
			latestEvent = {
				...event,
				workflowId: input.workflowId,
				kind: input.payload.kind,
				eventType: input.payload.kind,
				payload: input.payload,
				payloadBytes: canonicalJsonBytes(input.payload),
				payloadDigest: digestObject(input.payload),
				expectedHead: input.expectedHead,
				executionKey: input.executionKey,
				epochRef: input.epochRef,
				leaseRef: input.leaseRef,
				idempotencyKey: input.idempotencyKey,
				semanticBinding: input.semanticBinding,
				writerIdentity: input.writerIdentity,
			};
			return latestEvent;
		},
		replay: async () => [latestEvent],
		replayLogicalHistory: async () => [latestEvent],
		authorizeGoalProjection: async () => ({}) as WorkflowGoalProjectionAuthorization,
		inspectRecovery: async () => null,
		recover: async () => emptyRecovery,
		currentLeaseRef: () => leaseRef,
		rotateGeneration: async (input): Promise<WorkflowGenerationRotation> => ({
			recordVersion: input.recordVersion,
			generationId: input.generationId,
			rotationId: input.rotationId,
			mutationId: input.mutationId,
			idempotencyKey: input.idempotencyKey,
			expectedHead: event.expectedHead,
			previousEpoch: input.previousEpoch,
			nextEpoch: input.nextEpoch,
			previousWriterIdentity: input.previousWriterIdentity,
			previousLeaseRef: input.previousLeaseRef,
			nextLeaseRef: input.nextLeaseRef,
			generationBinding: input.generationBinding,
			status: "committed",
			fenceEventSequence: 1,
			fenceEventDigest: "fence",
			activeGenerationManifestRef: input.activeGenerationManifestRef,
			priorRecordDigest: input.priorRecordDigest,
			keyId: input.keyId,
			frameMac: input.frameMac,
			frameChecksum: input.frameChecksum,
			recordMac: input.recordMac,
			recordChecksum: input.recordChecksum,
			rotationArtifactRef: input.activeGenerationManifestRef,
		}),
		rebindSuccessor: async (
			_context: WorkflowGenerationContext,
			_expected: { generationId: string; epochRef: WorkflowEpochRef; head: WorkflowJournalHead },
		): Promise<void> => undefined,
	};
}

function createRuntimeStoreFixture(): WorkflowRuntimeStore {
	const previousGeneration = "generation-0123456789abcdef0123456789abcdef";
	const nextGeneration = "generation-abcdef0123456789abcdef0123456789";
	const createRotation = (nextEpoch: WorkflowEpochRef): WorkflowGenerationRotation => ({
		recordVersion: 1,
		generationId: nextGeneration,
		rotationId: "rotation",
		mutationId: "mutation",
		idempotencyKey: "idempotency",
		expectedHead: { workflowId: "wf-1", sequence: 0, eventDigest: null, epochRef: acquiredEpoch },
		previousEpoch: acquiredEpoch,
		nextEpoch,
		previousWriterIdentity: "writer-1",
		previousLeaseRef: createFixtureLeaseRef("lease-fixture", 1),
		nextLeaseRef: createFixtureLeaseRef("lease-next", 1, nextEpoch),
		generationBinding: { writerIdentity: "writer-2", processGenerationId: "process-2", ownerIdentity: "owner-1" },
		status: "committed",
		fenceEventSequence: 1,
		fenceEventDigest: "fence",
		activeGenerationManifestRef: {
			artifactId: "manifest",
			relativePath: `generations/${nextGeneration}/ACTIVE`,
			digest: "manifest",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		priorRecordDigest: null,
		keyId: "key",
		frameMac: "mac",
		frameChecksum: "checksum",
		recordMac: "mac",
		recordChecksum: "checksum",
		rotationArtifactRef: {
			artifactId: "rotation",
			relativePath: "rotations/rotation",
			digest: "rotation",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
	});
	return {
		identity: {
			storeKind: "workflow",
			namespace: "fixture",
			rootDir: "fixtures/workflow",
			storeId: "fixture-store",
			workflowId: "wf-1",
			identityDigest: "fixture-store-identity",
		},
		commit: async <TPayload extends WorkflowEventPayload>(
			input: WorkflowStoreCommitInput<TPayload>,
		): Promise<WorkflowStoreCommitResult<TPayload>> => {
			const sequence = input.expectedHead.sequence + 1;
			const commitReturnProof: WorkflowCommitReturnProof = {
				recordVersion: 1,
				generationId: previousGeneration,
				mutationId: input.semanticBinding.mutationId,
				workflowId: input.workflowId,
				sequence,
				eventDigest: "event",
				committedFrameDigest: "committed",
				expectedHead: input.expectedHead,
				epochRef: input.epochRef,
				leaseRef: input.leaseRef,
				writerIdentity: input.writerIdentity,
				idempotencyKey: input.idempotencyKey,
				keyId: "key",
				frameMac: "mac",
				frameChecksum: "checksum",
				recordMac: "mac",
				recordChecksum: "checksum",
				priorRecordDigest: input.expectedHead.eventDigest,
				returnedAt: "2030-01-01T00:00:00.000Z",
				proofDigest: "proof",
			};
			const commit: WorkflowJournalCommit<TPayload> = {
				workflowId: input.workflowId,
				sequence,
				payload: input.payload,
				payloadBytes: canonicalJsonBytes(input.payload),
				payloadDigest: digestObject(input.payload),
				priorEventDigest: input.expectedHead.eventDigest,
				eventDigest: "event",
				recordVersion: 1,
				generationId: previousGeneration,
				recordMac: "mac",
				recordChecksum: "checksum",
				expectedHead: input.expectedHead,
				epochRef: input.epochRef,
				leaseRef: input.leaseRef,
				idempotencyKey: input.idempotencyKey,
				returnProofId: `return-proof:${input.idempotencyKey}`,
				commitReturnProof,
				preparedFrameDigest: "prepared",
				committedFrameDigest: "committed",
				keyId: "key",
				preparedFrameMac: "mac",
				committedFrameMac: "mac",
				preparedFrameChecksum: "checksum",
				committedFrameChecksum: "checksum",
				semanticBinding: input.semanticBinding,
				executionKey: input.executionKey,
				writerIdentity: input.writerIdentity,
			};
			return {
				status: "committed",
				payload: input.payload,
				commit,
				state: {},
				head: { workflowId: input.workflowId, sequence, eventDigest: "event", epochRef: input.epochRef },
			};
		},
		replay: async () => ({
			workflowId: "wf-1",
			executionKey: null,
			events: [],
			head: { workflowId: "wf-1", sequence: 0, eventDigest: null, epochRef: acquiredEpoch },
			quarantined: false,
			quarantineReason: null,
		}),
		publishArtifact: async (input) => ({
			status: "published",
			envelope: {
				ref: {
					artifactId: "fixture",
					relativePath: "artifacts/fixture",
					digest: "fixture",
					sizeBytes: input.bytes.byteLength,
					sourceEventSequence: input.sourceEventSequence,
				},
				payloadKind: input.payloadKind,
				codec: input.codec,
				immutable: true,
			},
		}),
		publishSnapshot: async (input) => ({
			status: "published",
			sequence: input.sequence,
			sourceEventDigest: input.sourceEventDigest,
			stateDigest: input.stateDigest,
		}),
		compareAndSwapProjection: async () => "applied",
		appendOutbox: async (input) => ({ status: "appended", sequence: input.sequence, entryDigest: input.entryDigest }),
		replaceCoordinatorEpoch: async (input): Promise<WorkflowGenerationRotation> => createRotation(input),
		replaceStoreEpoch: async (input): Promise<WorkflowGenerationRotation> => createRotation(input),
	};
}

function createRecoveryPortFixture(): WorkflowRecoveryPort {
	return {
		reconcile: async (request) => ({
			workflowId: request.workflowId,
			reconciliationAttemptId: "reconciliation-1",
			taskId: request.taskId,
			attemptId: request.attemptId,
			disposition: "proven_not_executed",
			persistedChildIdentity: request.persistedChildIdentity,
			observedChildIdentity: null,
			observedProcessGroupId: null,
			observedTranscriptDigest: null,
			observedWorkspaceDigest: "workspace",
			epochRef: request.epochRef,
			evidenceRefs: request.evidenceRefs,
			stateDigest: "state",
		}),
	};
}

function createKeyProviderFixture(): WorkflowJournalKeyProvider {
	const fixtureGenerationId = (epoch: WorkflowEpochRef): string =>
		`generation-${sha256Hex(canonicalJsonBytes({ fixture: "key", epoch })).slice(0, 32)}`;
	return {
		current: async (_workflowId, epoch) => ({
			keyId: `fixture-key-${epoch.storeEpoch}`,
			secret: new Uint8Array([1]),
			validStoreEpoch: epoch.storeEpoch,
			generationId: fixtureGenerationId(epoch),
		}),
		resolve: async (_workflowId, _keyId, epoch) => ({
			keyId: `fixture-key-${epoch.storeEpoch}`,
			secret: new Uint8Array([1]),
			validStoreEpoch: epoch.storeEpoch,
			generationId: fixtureGenerationId(epoch),
		}),
	};
}

function createAppendLeaseFixture(): WorkflowAppendLease {
	const leaseRef: WorkflowLeaseRef = createFixtureLeaseRef("lease-fixture", 1);
	let fixtureGuard: Promise<void> = Promise.resolve();
	return {
		acquire: async () => leaseRef,
		renew: async () => undefined,
		assertOwned: async (input) => {
			if (
				input.writerIdentity !== "writer-1" ||
				input.leaseRef.leaseId !== leaseRef.leaseId ||
				input.epochRef.storeEpoch !== leaseRef.storeEpoch ||
				input.epochRef.coordinatorEpoch !== leaseRef.coordinatorEpoch ||
				input.rootDigest.length === 0
			)
				throw new Error("fixture append lease is not owned");
		},
		withExclusiveGuard: async (input, operation) => {
			const previous = fixtureGuard;
			let release!: () => void;
			fixtureGuard = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
			try {
				if (
					input.writerIdentity !== "writer-1" ||
					input.leaseRef.leaseId !== leaseRef.leaseId ||
					input.epochRef.storeEpoch !== leaseRef.storeEpoch ||
					input.epochRef.coordinatorEpoch !== leaseRef.coordinatorEpoch ||
					input.rootDigest.length === 0
				)
					throw new Error("fixture append guard is not owned");
				return await operation();
			} finally {
				release();
			}
		},
		observe: async () => ({ writerIdentity: "writer-1", leaseRef }),
		rotate: async () => undefined,
		release: async () => undefined,
	};
}

function createDescriptorFsFixture(): WorkflowDescriptorFs {
	const directories = new Set<string>();
	const files = new Map<string, Uint8Array>();
	const synced = new Set<string>();
	const missing = (): Error => Object.assign(new Error("fixture descriptor entry does not exist"), { code: "ENOENT" });
	const invalid = (): Error => Object.assign(new Error("fixture descriptor component is invalid"), { code: "EINVAL" });
	const componentPath = (parent: string, component: string): string => {
		if (
			component.length === 0 ||
			component === "." ||
			component === ".." ||
			component.includes("/") ||
			component.includes("\\") ||
			component.includes(":")
		)
			throw invalid();
		return parent.length === 0 ? component : `${parent}/${component}`;
	};
	const handleFor = (path: string, kind: "file" | "directory"): WorkflowDescriptorHandle => {
		const identityDigest = digestObject({ fixture: "descriptor", path, kind });
		return {
			identityDigest,
			async write(bytes) {
				if (kind !== "file") throw new Error("fixture descriptor directory is not writable as a file");
				files.set(path, bytes.slice());
			},
			async read() {
				if (kind !== "file") throw new Error("fixture descriptor directory cannot be read as bytes");
				const bytes = files.get(path);
				if (bytes === undefined) throw missing();
				return bytes.slice();
			},
			async stat() {
				return { kind, linkCount: 1, device: 1, identityDigest };
			},
			async sync() {
				synced.add(path);
			},
			async close() {
				if (!synced.has(path) && kind === "file")
					throw new Error("fixture descriptor file was closed before fsync");
			},
		};
	};
	return {
		async openRoot(rootPath) {
			if (rootPath.length === 0 || rootPath.includes("\\")) throw invalid();
			directories.add(rootPath);
			return handleFor(rootPath, "directory");
		},
		async mkdirAt(parent, component) {
			const path = componentPath(parent.identityDigest, component);
			directories.add(path);
			return handleFor(path, "directory");
		},
		async openAt(parent, component, flags) {
			const path = componentPath(parent.identityDigest, component);
			if (directories.has(path)) return handleFor(path, "directory");
			if (files.has(path)) return handleFor(path, "file");
			if ((flags & 0x40) !== 0) {
				files.set(path, new Uint8Array());
				return handleFor(path, "file");
			}
			throw missing();
		},
		async renameAt(parent, fromComponent, toComponent, options = { replace: true, noReplace: false }) {
			const from = componentPath(parent.identityDigest, fromComponent);
			const to = componentPath(parent.identityDigest, toComponent);
			const bytes = files.get(from);
			if (bytes === undefined) throw missing();
			if (options.noReplace && files.has(to))
				throw Object.assign(new Error("fixture descriptor no-replace rename collided"), { code: "EEXIST" });
			if (!options.replace && files.has(to))
				throw Object.assign(new Error("fixture descriptor rename refused replacement"), { code: "EEXIST" });
			files.set(to, bytes);
			files.delete(from);
			synced.add(parent.identityDigest);
		},
		async unlinkAt(parent, component) {
			const path = componentPath(parent.identityDigest, component);
			if (!files.delete(path)) throw missing();
			synced.add(parent.identityDigest);
		},
		async syncDirectoryChain(leaf, root) {
			if (leaf.identityDigest.length === 0 || root.identityDigest.length === 0)
				throw new Error("fixture descriptor fsync chain is unbound");
			synced.add(leaf.identityDigest);
			synced.add(root.identityDigest);
		},
	};
}

function createReturnProofStoreFixture(): WorkflowCommitReturnProofStore {
	const records = new Map<
		string,
		{ state: "pending" | "committed" | "returned"; proof: WorkflowCommitReturnProof | null; tupleDigest: string }
	>();
	const tupleDigest = (input: {
		generationId: string;
		mutationId: string;
		workflowId: string;
		expectedHead: WorkflowJournalHead;
		expectedSequence?: number;
		sequence?: number;
		eventDigest: string;
		epochRef: WorkflowEpochRef;
		leaseRef: WorkflowLeaseRef;
		writerIdentity: string;
		idempotencyKey: string;
		keyId: string;
		frameMac: string;
		frameChecksum: string;
		recordMac: string;
		recordChecksum: string;
		priorRecordDigest: string | null;
	}): string =>
		digestObject({
			generationId: input.generationId,
			mutationId: input.mutationId,
			workflowId: input.workflowId,
			expectedHead: input.expectedHead,
			sequence: input.expectedSequence ?? input.sequence,
			eventDigest: input.eventDigest,
			epochRef: input.epochRef,
			leaseRef: input.leaseRef,
			writerIdentity: input.writerIdentity,
			idempotencyKey: input.idempotencyKey,
			keyId: input.keyId,
			frameMac: input.frameMac,
			frameChecksum: input.frameChecksum,
			recordMac: input.recordMac,
			recordChecksum: input.recordChecksum,
			priorRecordDigest: input.priorRecordDigest,
		});
	const assertTuple = (input: {
		generationId: string;
		mutationId: string;
		workflowId: string;
		expectedHead?: WorkflowJournalHead;
		epochRef: WorkflowEpochRef;
		leaseRef: WorkflowLeaseRef;
		writerIdentity: string;
		idempotencyKey: string;
		keyId: string;
		frameMac: string;
		frameChecksum: string;
		recordMac: string;
		recordChecksum: string;
		priorRecordDigest: string | null;
	}): void => {
		if (
			input.generationId.length === 0 ||
			input.mutationId.length === 0 ||
			input.workflowId.length === 0 ||
			input.writerIdentity.length === 0 ||
			input.idempotencyKey.length === 0 ||
			input.keyId.length === 0 ||
			input.frameMac.length === 0 ||
			input.frameChecksum.length === 0 ||
			input.recordMac.length === 0 ||
			input.recordChecksum.length === 0 ||
			input.epochRef.storeEpoch < 1 ||
			input.epochRef.coordinatorEpoch < 1 ||
			input.leaseRef.leaseId.length === 0
		)
			throw new Error("Fixture return proof tuple is incomplete.");
	};
	return {
		async markPending(input) {
			assertTuple(input);
			const digest = tupleDigest(input);
			const prior = records.get(input.mutationId);
			if (prior !== undefined && prior.tupleDigest !== digest)
				throw new Error("Fixture return proof idempotency tuple conflicts.");
			if (prior === undefined) records.set(input.mutationId, { state: "pending", proof: null, tupleDigest: digest });
		},
		async markCommitted(input) {
			assertTuple(input);
			const prior = records.get(input.mutationId);
			if (prior === undefined || prior.tupleDigest !== tupleDigest({ ...input, expectedSequence: input.sequence }))
				throw new Error("Fixture committed return proof lacks its exact prepared tuple.");
			if (prior.state === "returned") throw new Error("Fixture return proof was already returned.");
			const proofWithoutDigest: Omit<WorkflowCommitReturnProof, "proofDigest"> = {
				recordVersion: 1,
				generationId: input.generationId,
				mutationId: input.mutationId,
				workflowId: input.workflowId,
				sequence: input.sequence,
				eventDigest: input.eventDigest,
				committedFrameDigest: input.committedFrameDigest,
				expectedHead: input.expectedHead,
				epochRef: input.epochRef,
				leaseRef: input.leaseRef,
				writerIdentity: input.writerIdentity,
				idempotencyKey: input.idempotencyKey,
				keyId: input.keyId,
				frameMac: input.frameMac,
				frameChecksum: input.frameChecksum,
				recordMac: input.recordMac,
				recordChecksum: input.recordChecksum,
				priorRecordDigest: input.priorRecordDigest,
				returnedAt: "2030-01-01T00:00:00.000Z",
			};
			records.set(input.mutationId, {
				state: "committed",
				proof: { ...proofWithoutDigest, proofDigest: digestObject(proofWithoutDigest) },
				tupleDigest: prior.tupleDigest,
			});
		},
		async markReturned(proof) {
			const prior = records.get(proof.mutationId);
			if (
				prior === undefined ||
				prior.state !== "committed" ||
				prior.proof === null ||
				digestObject(prior.proof) !== digestObject(proof)
			)
				throw new Error("Fixture return proof cannot be marked returned without the exact committed proof.");
			records.set(proof.mutationId, { ...prior, state: "returned" });
		},
		async resolve(mutationId) {
			const record = records.get(mutationId);
			return record === undefined
				? { state: "pending", proof: null }
				: { state: record.state, proof: record.proof === null ? null : structuredClone(record.proof) };
		},
	};
}

function createFixtureActiveGenerationManifestBytesDigest(
	input: Omit<WorkflowActiveGenerationRecord, "manifestBytesDigest" | "sideRecordMac">,
): string {
	return sha256Hex(
		canonicalJsonBytes({
			...input,
			manifestRef: { ...input.manifestRef, digest: "", sizeBytes: 0 },
			manifestBytesDigest: "",
			sideRecordMac: "",
		}),
	);
}

function createRotationStoreFixture(): WorkflowGenerationRotationStore {
	const records = new Map<string, WorkflowGenerationRotationRecoveryRecord>();
	let active: WorkflowActiveGenerationRecord | null = null;
	const checkpoint = async (
		hook: DurableStoreCrashBoundaryHook | undefined,
		rotationId: string,
		boundary: DurableStoreCrashBoundary,
		digest: string,
	): Promise<void> => {
		if (hook?.checkpoint === boundary)
			await hook.before({ storeId: "fixture-workflow", mutationId: rotationId, checkpoint: boundary });
		if (hook?.checkpoint === boundary)
			await hook.after({ storeId: "fixture-workflow", mutationId: rotationId, checkpoint: boundary, digest });
	};
	return {
		async prepare(input, hook) {
			const rotationArtifactRef: WorkflowArtifactRef = {
				artifactId: `rotation:${input.rotationId}`,
				relativePath: `rotations/${input.rotationId}`,
				digest: digestObject(input),
				sizeBytes: canonicalJsonBytes(input).byteLength,
				sourceEventSequence: input.expectedHead.sequence + 1,
			};
			const record: WorkflowGenerationRotationRecoveryRecord = {
				request: structuredClone(input),
				expectedHead: input.expectedHead,
				rotationArtifactRef,
				activeGenerationManifestRef: input.activeGenerationManifestRef,
				priorRecordDigest: input.priorRecordDigest,
				authenticatedTuple: null,
				state: "prepared",
				fenceEventSequence: null,
				fenceEventDigest: null,
				commitReturnProof: null,
				rotation: null,
				quarantineReason: null,
				lastCheckpoint: DurableStoreCrashBoundary.afterRotationPrepareBeforeFence,
				checkpointDigest: rotationArtifactRef.digest,
				sideRecordMac: digestObject({
					rotationArtifactRef,
					priorRecordDigest: input.priorRecordDigest,
					generationId: input.generationId,
					epoch: input.nextEpoch,
				}),
			};
			records.set(input.rotationId, record);
			await checkpoint(
				hook,
				input.rotationId,
				DurableStoreCrashBoundary.afterRotationPrepareBeforeFence,
				rotationArtifactRef.digest,
			);
			return rotationArtifactRef;
		},
		async markLeaseTransferred(rotationId, input, hook) {
			const record = records.get(rotationId);
			if (
				record === undefined ||
				record.state !== "prepared" ||
				record.priorRecordDigest !== input.expectedPriorRecordDigest ||
				digestObject(record.request.nextLeaseRef) !== digestObject(input.nextLeaseRef) ||
				digestObject(record.request.nextEpoch) !== digestObject(input.epochRef) ||
				record.request.generationBinding.writerIdentity !== input.writerIdentity
			)
				throw new Error("Fixture rotation lease transfer is not predecessor-bound.");
			records.set(rotationId, {
				...record,
				state: "lease_transferred",
				lastCheckpoint: DurableStoreCrashBoundary.afterRotationLeaseTransferBeforeRecord,
				checkpointDigest: digestObject(input),
			});
			await checkpoint(
				hook,
				rotationId,
				DurableStoreCrashBoundary.afterRotationLeaseTransferBeforeRecord,
				digestObject(input),
			);
		},
		async markFenceCommitted(rotationId, input, hook) {
			const record = records.get(rotationId);
			if (
				record === undefined ||
				record.state !== "lease_transferred" ||
				record.priorRecordDigest !== input.expectedPriorRecordDigest ||
				record.request.generationId !== input.generationId ||
				input.fenceEventSequence <= record.expectedHead.sequence ||
				input.fenceEventDigest.length === 0 ||
				input.commitReturnProof.sequence !== input.fenceEventSequence ||
				input.commitReturnProof.eventDigest !== input.fenceEventDigest
			)
				throw new Error("Fixture rotation fence is not a unique authenticated predecessor fence.");
			const rotation: WorkflowGenerationRotation = {
				...record.request,
				expectedHead: record.expectedHead,
				status: "committed",
				fenceEventSequence: input.fenceEventSequence,
				fenceEventDigest: input.fenceEventDigest,
				rotationArtifactRef: record.rotationArtifactRef,
			};
			records.set(rotationId, {
				...record,
				state: "fence_committed",
				fenceEventSequence: input.fenceEventSequence,
				fenceEventDigest: input.fenceEventDigest,
				commitReturnProof: input.commitReturnProof,
				rotation,
				authenticatedTuple: {
					recordVersion: 1,
					generationId: input.generationId,
					workflowId: "wf-1",
					mutationId: record.request.mutationId,
					expectedHead: record.expectedHead,
					sequence: input.fenceEventSequence,
					eventDigest: input.fenceEventDigest,
					epochRef: record.request.nextEpoch,
					leaseRef: record.request.nextLeaseRef,
					writerIdentity: record.request.generationBinding.writerIdentity,
					idempotencyKey: record.request.idempotencyKey,
					keyId: input.keyId,
					frameMac: input.frameMac,
					frameChecksum: input.frameChecksum,
					recordMac: input.recordMac,
					recordChecksum: input.recordChecksum,
					priorRecordDigest: record.priorRecordDigest,
				},
				lastCheckpoint: DurableStoreCrashBoundary.afterRotationRecordBeforeManifest,
				checkpointDigest: digestObject(input),
				sideRecordMac: digestObject({ rotation, input }),
			});
			await checkpoint(
				hook,
				rotationId,
				DurableStoreCrashBoundary.afterRotationRecordBeforeManifest,
				digestObject(input),
			);
		},
		async selectActiveGenerationManifest(rotation, hook) {
			const record = records.get(rotation.rotationId);
			if (
				record === undefined ||
				record.state !== "fence_committed" ||
				record.rotation === null ||
				record.rotation.fenceEventDigest !== rotation.fenceEventDigest
			)
				throw new Error("Fixture active-generation publication lacks the durable fence.");
			const manifestRecord: Omit<WorkflowActiveGenerationRecord, "manifestBytesDigest" | "sideRecordMac"> = {
				workflowId: "wf-1",
				generationId: rotation.generationId,
				manifestRef: rotation.activeGenerationManifestRef,
				sourceHead: rotation.expectedHead,
				epochRef: rotation.nextEpoch,
				generationBinding: rotation.generationBinding,
				leaseRef: rotation.nextLeaseRef,
				keyId: rotation.keyId,
				frameMac: rotation.frameMac,
				frameChecksum: rotation.frameChecksum,
				priorRecordDigest: rotation.priorRecordDigest,
			};
			const manifestBytesDigest = createFixtureActiveGenerationManifestBytesDigest(manifestRecord);
			active = {
				...manifestRecord,
				manifestBytesDigest,
				sideRecordMac: digestObject({ rotation, manifestBytesDigest }),
			};
			records.set(rotation.rotationId, {
				...record,
				state: "committed",
				rotation,
				lastCheckpoint: DurableStoreCrashBoundary.afterRotationManifestBeforeCommit,
				checkpointDigest: manifestBytesDigest,
			});
			await checkpoint(
				hook,
				rotation.rotationId,
				DurableStoreCrashBoundary.afterRotationManifestBeforeCommit,
				manifestBytesDigest,
			);
		},
		async commit(rotation, hook) {
			const record = records.get(rotation.rotationId);
			if (
				record === undefined ||
				record.rotation === null ||
				active === null ||
				active.generationId !== rotation.generationId
			)
				throw new Error("Fixture rotation commit lacks an active successor manifest.");
			records.set(rotation.rotationId, {
				...record,
				state: "committed",
				lastCheckpoint: DurableStoreCrashBoundary.afterRotationCommitBeforeRetire,
				checkpointDigest: active.manifestBytesDigest,
			});
			await checkpoint(
				hook,
				rotation.rotationId,
				DurableStoreCrashBoundary.afterRotationCommitBeforeRetire,
				active.manifestBytesDigest,
			);
		},
		async retirePreviousGeneration(rotationId, hook) {
			const record = records.get(rotationId);
			if (record === undefined || record.state !== "committed")
				throw new Error("Fixture retirement requires a committed replacement generation.");
			if (active === null || active.generationId.length === 0)
				throw new Error("Fixture retirement requires a persisted successor generation identity.");
			const checkpointDigest = digestObject({ rotationId, activeGenerationId: active.generationId });
			records.set(rotationId, {
				...record,
				state: "retired",
				lastCheckpoint: DurableStoreCrashBoundary.afterRotationRetireBeforeRebind,
				checkpointDigest,
			});
			await checkpoint(
				hook,
				rotationId,
				DurableStoreCrashBoundary.afterRotationRetireBeforeRebind,
				checkpointDigest,
			);
		},
		async quarantine(rotationId, reason) {
			const record = records.get(rotationId);
			if (record === undefined) throw new Error("Fixture rotation quarantine lacks a durable record.");
			records.set(rotationId, {
				...record,
				state: "quarantined",
				quarantineReason: reason,
				lastCheckpoint: null,
				checkpointDigest: digestObject({ rotationId, reason }),
			});
		},
		async resolve(rotationId) {
			const record = records.get(rotationId);
			return record === undefined ? null : structuredClone(record);
		},
		async listUnfinished(workflowId) {
			return [...records.values()]
				.filter(() => workflowId === "wf-1")
				.filter((record) => !["retired", "quarantined"].includes(record.state))
				.map((record) => structuredClone(record));
		},
		async readActiveGeneration(workflowId) {
			return active === null || active.workflowId !== workflowId ? null : structuredClone(active);
		},
		async readRotationForGeneration(generationId) {
			const matches = [...records.values()].filter((record) => record.request.generationId === generationId);
			if (matches.length > 1) throw new Error("Fixture generation has multiple authenticated rotation records.");
			return matches[0] === undefined ? null : structuredClone(matches[0]);
		},
	};
}

type RejectOpenEventType = string extends WorkflowEventType ? never : true;
const closedEventTypeWitness: RejectOpenEventType = true;
const rejectedOpenEvent: string = "arbitrary-open-event";
if ([...WORKFLOW_EVENT_KINDS].some((eventKind) => eventKind === rejectedOpenEvent))
	throw new Error("Event registry accepted an arbitrary event kind.");
void closedEventTypeWitness;
void rejectedOpenEvent;

describe("workflow consumer contract", () => {
	it("keeps A/N/R/C/M and downstream K contracts assignable without dispatch", () => {
		expect(consumerCompilationWitness.recovery).toBeTypeOf("function");
		expect(acceptAImportedContractSurface).toBeTypeOf("function");
	});

	it("round-trips, consumes, and rejects tampered fixture host receipts", async () => {
		const context = createFixtureHostReceiptConsumerContext();
		const expectedBindingDigest = digestObject({ kind: "receipt-binding" });
		const payloadDigest = digestObject({ kind: "round-trip-payload" });
		const stateDigest = digestObject({ kind: "fixture-state" });
		const receipt = createFixtureHostReceipt({
			receiptKind: "decision",
			oneUse: true,
			receiptId: "round-trip-receipt",
			issuerId: "fixture-host",
			workflowId: "wf-1",
			bindingDigest: expectedBindingDigest,
			payloadDigest,
			artifactRef: {
				artifactId: "round-trip-receipt",
				relativePath: "receipts/round-trip-receipt",
				digest: "placeholder",
				sizeBytes: 0,
				sourceEventSequence: 1,
			},
			issuedAt: "2030-01-01T00:00:00.000Z",
			validUntil: "2030-01-01T00:10:00.000Z",
			keyId: "fixture-receipt-key",
			signature: "placeholder-signature",
			stateDigest,
			revision: 1,
		});

		await expect(
			resolveAndVerifyWorkflowHostReceipt({
				context,
				workflowId: "wf-1",
				expectedBindingDigest,
				receipt,
				currentStateDigest: stateDigest,
				currentRevision: 1,
				trustedNow: "2030-01-01T00:01:00.000Z",
			}),
		).resolves.toEqual(receipt);
		await context.receiptResolver.consumeIfOneUse({
			workflowId: "wf-1",
			expectedBindingDigest,
			receipt,
			currentRevision: 1,
		});
		await expect(
			context.receiptResolver.resolveConsumptionWitness({
				workflowId: "wf-1",
				receiptId: receipt.receiptId,
				expectedBindingDigest,
			}),
		).resolves.toMatchObject({
			receiptId: receipt.receiptId,
			workflowId: "wf-1",
			bindingDigest: expectedBindingDigest,
		});
		await expect(
			context.receiptResolver.consumeIfOneUse({
				workflowId: "wf-1",
				expectedBindingDigest,
				receipt,
				currentRevision: 1,
			}),
		).rejects.toThrow(/already consumed/i);

		const tamperedSignature = { ...receipt, signature: "tampered-signature" };
		await expect(
			resolveAndVerifyWorkflowHostReceipt({
				context,
				workflowId: "wf-1",
				expectedBindingDigest,
				receipt: tamperedSignature,
				currentStateDigest: stateDigest,
				currentRevision: 1,
				trustedNow: "2030-01-01T00:01:00.000Z",
			}),
		).rejects.toThrow(/cryptographically valid/i);
		const tamperedBinding = { ...receipt, bindingDigest: digestObject({ kind: "other-binding" }) };
		await expect(
			resolveAndVerifyWorkflowHostReceipt({
				context,
				workflowId: "wf-1",
				expectedBindingDigest,
				receipt: tamperedBinding,
				currentStateDigest: stateDigest,
				currentRevision: 1,
				trustedNow: "2030-01-01T00:01:00.000Z",
			}),
		).rejects.toThrow(/cryptographically valid/i);
	});

	it("executes the generic runtime commit and journal/recovery witnesses", async () => {
		const committed = await runtimeStore.commit(runtimeCommitInput);
		expect(committed.payload).toEqual(runtimePayload);
		expect(committed.commit.payload).toEqual(runtimePayload);
		expect(committed.commit.commitReturnProof.returnedAt).toBe("2030-01-01T00:00:00.000Z");
		expect(childProcessBinding).toMatchObject({
			workflowId: "wf-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			bindingDigest: "binding-1",
			childIdentity,
		});

		const proof = committed.commit.commitReturnProof;
		const returnProofStore = createReturnProofStoreFixture();
		await returnProofStore.markPending({
			recordVersion: proof.recordVersion,
			generationId: proof.generationId,
			mutationId: proof.mutationId,
			workflowId: proof.workflowId,
			expectedSequence: proof.sequence,
			eventDigest: proof.eventDigest,
			expectedHead: proof.expectedHead,
			epochRef: proof.epochRef,
			leaseRef: proof.leaseRef,
			writerIdentity: proof.writerIdentity,
			idempotencyKey: proof.idempotencyKey,
			keyId: proof.keyId,
			frameMac: proof.frameMac,
			frameChecksum: proof.frameChecksum,
			recordMac: proof.recordMac,
			recordChecksum: proof.recordChecksum,
			priorRecordDigest: proof.priorRecordDigest,
		});
		await returnProofStore.markCommitted({
			recordVersion: proof.recordVersion,
			generationId: proof.generationId,
			mutationId: proof.mutationId,
			workflowId: proof.workflowId,
			sequence: proof.sequence,
			eventDigest: proof.eventDigest,
			committedFrameDigest: proof.committedFrameDigest,
			expectedHead: proof.expectedHead,
			epochRef: proof.epochRef,
			leaseRef: proof.leaseRef,
			writerIdentity: proof.writerIdentity,
			idempotencyKey: proof.idempotencyKey,
			keyId: proof.keyId,
			frameMac: proof.frameMac,
			frameChecksum: proof.frameChecksum,
			recordMac: proof.recordMac,
			recordChecksum: proof.recordChecksum,
			priorRecordDigest: proof.priorRecordDigest,
		});
		const resolvedProof = await returnProofStore.resolve(proof.mutationId);
		if (resolvedProof.proof === null) throw new Error("Expected a committed return proof.");
		expect(resolvedProof.state).toBe("committed");
		expect(resolvedProof.proof).toMatchObject({
			mutationId: proof.mutationId,
			sequence: proof.sequence,
			committedFrameDigest: proof.committedFrameDigest,
		});
		await returnProofStore.markReturned(resolvedProof.proof);
		await expect(returnProofStore.resolve(proof.mutationId)).resolves.toMatchObject({ state: "returned" });

		const rotationStore = createRotationStoreFixture();
		const nextEpoch: WorkflowEpochRef = {
			storeEpoch: acquiredEpoch.storeEpoch + 1,
			coordinatorEpoch: acquiredEpoch.coordinatorEpoch,
		};
		const rotationId = "rotation-fixture";
		const rotationArtifactRef = await rotationStore.prepare({
			recordVersion: 1,
			generationId: "generation-next",
			rotationId,
			mutationId: "mutation-rotation",
			idempotencyKey: "idempotency-rotation",
			expectedHeadDigest: digestObject(expectedHead),
			previousEpoch: acquiredEpoch,
			nextEpoch,
			previousKeyId: "key-previous",
			previousGenerationId: "generation-previous",
			previousFrameMac: "mac-previous",
			previousFrameChecksum: "checksum-previous",
			previousWriterIdentity: "writer-1",
			previousLeaseRef: createFixtureLeaseRef("lease-previous", 1),
			nextLeaseRef: createFixtureLeaseRef("lease-next", 2, nextEpoch),
			generationBinding: {
				writerIdentity: "writer-1",
				processGenerationId: "process-next",
				ownerIdentity: "owner-1",
			},
			activeGenerationManifestRef: {
				artifactId: "manifest-next",
				relativePath: "generations/generation-next/ACTIVE",
				digest: "manifest-next",
				sizeBytes: 1,
				sourceEventSequence: 1,
			},
			keyId: "key-next",
			frameMac: "mac-next",
			frameChecksum: "checksum-next",
			recordMac: "record-mac-next",
			recordChecksum: "record-checksum-next",
			priorRecordDigest: null,
			expectedHead,
		});
		expect(rotationArtifactRef).toMatchObject({
			artifactId: `rotation:${rotationId}`,
			sourceEventSequence: expectedHead.sequence + 1,
		});
		await expect(rotationStore.resolve(rotationId)).resolves.toMatchObject({ state: "prepared" });
		await expect(rotationStore.listUnfinished("wf-1")).resolves.toHaveLength(1);
		await expect(rotationStore.readRotationForGeneration("generation-next")).resolves.toMatchObject({
			request: { generationId: "generation-next" },
			state: "prepared",
		});
		await expect(rotationStore.readRotationForGeneration("generation-missing")).resolves.toBeNull();
		await expect(rotationStore.readActiveGeneration("wf-1")).resolves.toBeNull();

		const appended = await journal.append(journalAppendInput);
		expect(appended.payload).toEqual(workflowInitializer);
		await expect(journal.replay()).resolves.toHaveLength(1);
		await expect(journal.replayLogicalHistory()).resolves.toEqual([appended]);
		await expect(journal.recover()).resolves.toMatchObject({ quarantined: false, metadata: { status: "complete" } });
		await expect(journal.inspectRecovery()).resolves.toBeNull();

		await expect(
			recoveryPort.reconcile({
				workflowId: "wf-1",
				taskId: "task-1",
				attemptId: "attempt-1",
				executionKey: "execution-1",
				epochRef: acquiredEpoch,
				persistedChildIdentity: childIdentity,
				evidenceRefs: [],
			}),
		).resolves.toMatchObject({ workflowId: "wf-1", disposition: "proven_not_executed", epochRef: acquiredEpoch });
	});
});
