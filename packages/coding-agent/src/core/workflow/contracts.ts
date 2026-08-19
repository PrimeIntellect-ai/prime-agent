import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from "node:crypto";
import type {
	WorkflowAppendLease,
	WorkflowDescriptorRootAdapters,
	WorkflowJournalKeyProvider,
	WorkflowJournalRecoveryResult,
} from "./journal.js";
import type { WorkflowQuarantineReason, WorkflowReconciliationOutcome } from "./recovery.js";
import type { WorkflowDeferredEventOwnerValidators } from "./reducer.js";

export type { WorkflowDescriptorRootAdapters } from "./journal.js";
export type { WorkflowQuarantineReason, WorkflowReconciliationOutcome } from "./recovery.js";

export type WorkflowHostReceiptKind =
	| "clock"
	| "artifact"
	| "capability"
	| "decision"
	| "lease"
	| "usage"
	| "adjudication";

/** Closed capabilities that a host-owned receipt can authorize. */
export type WorkflowHostReceiptCapability =
	| "workflow_observation_process"
	| "workflow_observation_dataset_receipt"
	| "workflow_coordinator_status_projection"
	| "workflow_checkpoint_budget_observation"
	| "workflow_dispatch_capacity_attestation"
	| "workflow_dispatch_path_attestation"
	| "workflow_worker_model_dispatch"
	| "workflow_recursive_delegation_plan"
	| "workflow_decision_packet_delivery"
	| "autoresearch_portfolio_frontier_admission"
	| "autoresearch_portfolio_projection_commit"
	| "portfolio_default_completion"
	| "workflow_learning_knowledge_promotion"
	| "autoresearch.legacy_scalar_provenance_import"
	| "workflow_intent_red_mutation"
	| "child_output_delivery_ack"
	| "workflow_coordinator_obligation_scheduler";

export interface WorkflowHostReceiptCapabilityBinding {
	readonly capability: WorkflowHostReceiptCapability;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly executionIdentity: string | null;
	readonly sessionId: string | null;
}

export interface WorkflowVerifiedHostReceipt {
	receiptKind: WorkflowHostReceiptKind;
	oneUse: boolean;
	receiptId: string;
	issuerId: string;
	workflowId: string;
	bindingDigest: string;
	payloadDigest: string;
	artifactRef: WorkflowArtifactRef;
	issuedAt: string;
	validUntil: string;
	keyId: string;
	signatureAlgorithm: "ed25519";
	artifactBytesDigest: string;
	stateDigest: string;
	revision: number;
	/** Signed authority preimage fields; present only for receipts issued for a capability. */
	capabilityBinding?: WorkflowHostReceiptCapabilityBinding;
	signature: string;
	verificationDigest: string;
}

export interface WorkflowCloudCapacityReceipt {
	workflowId: string;
	requestDigest: string;
	capacityArtifactRef: WorkflowArtifactRef;
	pricingArtifactRef: WorkflowArtifactRef;
	credentialArtifactRef: WorkflowArtifactRef;
	quotaArtifactRef: WorkflowArtifactRef;
	rateLimitArtifactRef: WorkflowArtifactRef;
	billingArtifactRef: WorkflowArtifactRef;
	egressArtifactRef: WorkflowArtifactRef;
	terminationArtifactRef: WorkflowArtifactRef;
	responseArtifactRef: WorkflowArtifactRef;
	responseReceipt: WorkflowVerifiedHostReceipt;
	capacityVector: WorkflowResourceVector;
	trustedClockReceipt: WorkflowVerifiedHostReceipt;
	observedAt: string;
	validUntil: string;
	ttlMilliseconds: number;
	finalEnvelopeDecisionRef: WorkflowDecisionRef | null;
	finalEnvelopeDigest: string;
	receiptDigest: string;
}

export interface WorkflowCloudCapacityReceiptStore {
	compareAndSwap(input: {
		workflowId: string;
		expectedDigest: string | null;
		receipt: WorkflowCloudCapacityReceipt;
		envelopeDecisionRef: WorkflowDecisionRef;
		trustedNow: string;
		receiptContext: WorkflowHostReceiptConsumerContext;
		currentStateDigest: string;
		currentRevision: number;
	}): Promise<WorkflowCloudCapacityReceipt>;
	read(workflowId: string): Promise<WorkflowCloudCapacityReceipt | null>;
	verify(input: {
		receipt: WorkflowCloudCapacityReceipt;
		trustedNow: string;
		expectedDecisionRef: WorkflowDecisionRef;
		receiptContext: WorkflowHostReceiptConsumerContext;
		currentStateDigest: string;
		currentRevision: number;
	}): Promise<void>;
}

export interface WorkflowReceiptVerificationKey {
	algorithm: "ed25519";
	verify(input: { bytes: Readonly<Uint8Array>; signature: string }): boolean;
	/** Authenticated owner; never inferred from WorkflowVerifiedHostReceipt. */
	readonly ownerPrincipal: string;
	/** Capabilities granted by the persisted host key. */
	readonly allowedCapabilities: ReadonlySet<WorkflowHostReceiptCapability>;
	/** Persisted generation to which this key belongs. */
	readonly generationId: string;
	/** Persisted epoch to which this key belongs. */
	readonly epochRef: WorkflowEpochRef;
	/** Digest of the generation/epoch fence that authenticated this key. */
	readonly fencingDigest: string;
	/** Revoked keys are never accepted by receipt verification or authorization. */
	readonly revoked: boolean;
}

export interface WorkflowReceiptVerificationKeyResolver {
	resolve(keyId: string): Promise<WorkflowReceiptVerificationKey>;
}

export interface WorkflowHostReceiptResolveInput {
	receipt: WorkflowVerifiedHostReceipt;
	workflowId: string;
	expectedBindingDigest: string;
	artifactBytes: Readonly<Uint8Array>;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
	keyResolver: WorkflowReceiptVerificationKeyResolver;
	revokedReceiptIds: ReadonlySet<string>;
}

export interface WorkflowHostReceiptConsumptionWitness {
	receiptId: string;
	workflowId: string;
	bindingDigest: string;
	/** Signed capability identity; null for non-capability one-use receipts. */
	capability: WorkflowHostReceiptCapability | null;
	/** Signed capability resource identity; null for non-capability one-use receipts. */
	resourceDigest: string | null;
	/** Signed capability operation identity; null for non-capability one-use receipts. */
	operationDigest: string | null;
	/** Digest of the complete signed receipt whose one-use witness was recorded. */
	receiptDigest: string;
	consumedAt: string;
	consumptionSequence: number;
}

export interface WorkflowHostReceiptResolver {
	resolve(input: WorkflowHostReceiptResolveInput): Promise<WorkflowVerifiedHostReceipt>;
	consumeIfOneUse(input: {
		receipt: WorkflowVerifiedHostReceipt;
		workflowId: string;
		expectedBindingDigest: string;
		currentRevision: number;
	}): Promise<void>;
	resolveConsumptionWitness(input: {
		receiptId: string;
		workflowId: string;
		expectedBindingDigest: string;
	}): Promise<WorkflowHostReceiptConsumptionWitness>;
}

export interface WorkflowHostPrincipalCapabilityAuthorizationInput {
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly workflowId: string;
	readonly bindingDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly stateDigest: string;
	readonly revision: number;
	readonly epochRef: WorkflowEpochRef;
	readonly capability: WorkflowHostReceiptCapability;
	readonly executionIdentity?: string;
	readonly sessionId?: string;
}

export interface WorkflowHostPrincipalCapabilityAuthorization {
	readonly authenticatedPrincipal: string;
	readonly keyOwnerPrincipal: string;
	readonly capability: WorkflowHostReceiptCapability;
	readonly workflowId: string;
	readonly bindingDigest: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly stateDigest: string;
	readonly revision: number;
	readonly epochRef: WorkflowEpochRef;
	readonly validity: { readonly issuedAt: string; readonly validUntil: string };
	readonly executionIdentity?: string;
	readonly sessionId?: string;
	/** Digest/witness of the complete authenticated authorization tuple. */
	readonly authorizationDigest: string;
}

export interface WorkflowHostPrincipalCapabilityAuthorizer {
	authorize(
		input: WorkflowHostPrincipalCapabilityAuthorizationInput,
	): Promise<WorkflowHostPrincipalCapabilityAuthorization>;
}

export interface WorkflowHostReceiptConsumerContext {
	readonly receiptResolver: WorkflowHostReceiptResolver;
	readonly keyResolver: WorkflowReceiptVerificationKeyResolver;
	readonly revokedReceiptIds: ReadonlySet<string>;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly principalAuthorizer: WorkflowHostPrincipalCapabilityAuthorizer;
	/** Persist a receipt revocation in the host-owned generation authority. */
	readonly revokeReceipt?: (receiptId: string) => Promise<void>;
	/** Host-owned signer used for durable witness records that must survive process restart. */
	readonly signer?: {
		readonly keyId: string;
		readonly signatureAlgorithm: "ed25519";
		sign(bytes: Readonly<Uint8Array>): Promise<string>;
	};
}

export interface WorkflowHostAdjudicationReceipt {
	decisionId: string;
	decisionRevision: number;
	operationDigest: string;
	stateDigest: string;
	epochRef: WorkflowEpochRef;
	executionIdentity: string;
	sessionId: string;
	verdictArtifactRef: WorkflowArtifactRef;
	verdictDigest: string;
	hostReceipt: WorkflowVerifiedHostReceipt;
	disposition: "accepted" | "rejected";
}

export type WorkflowStatus =
	| "active"
	| "awaiting_user"
	| "paused"
	| "budget_limited"
	| "blocked"
	| "failed"
	| "cancelled"
	| "complete";

export type WorkflowPhaseId =
	| "discovering_capacity"
	| "hardening_goal"
	| "hardening_scorecard"
	| "reconnaissance"
	| "analyzing_lenses"
	| "verifying_evidence"
	| "synthesizing"
	| "red_teaming"
	| "adjudicating"
	| "planning"
	| "dispatching"
	| "executing"
	| "auditing_progress"
	| "verifying"
	| "auditing_completion"
	| "refining"
	| "recovering";

export interface WorkflowEpochRef {
	storeEpoch: number;
	coordinatorEpoch: number;
}

export type WorkflowGoalStatus =
	| "idle"
	| "active"
	| "paused"
	| "budget_limited"
	| "failed"
	| "blocked"
	| "complete"
	| "error";

export interface WorkflowGoalMutationDelta {
	goalId: string | null;
	objective: string | null;
	active: boolean;
	status: WorkflowGoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	continuationsUsed: number;
	createdAt: number | null;
	updatedAt: number | null;
	lastReason: string | null;
	lastError: string | null;
}

export interface WorkflowGenerationBinding {
	writerIdentity: string;
	processGenerationId: string;
	ownerIdentity: string;
}

export type WorkflowGenerationRotationQuarantineReason =
	| "rotation_prepared_only"
	| "rotation_lease_transfer_unmatched"
	| "rotation_fence_duplicate"
	| "rotation_fence_chain_break"
	| "rotation_commit_uncertain";

export interface WorkflowGenerationRotation {
	recordVersion: 1;
	generationId: string;
	rotationId: string;
	mutationId: string;
	idempotencyKey: string;
	expectedHead: WorkflowJournalHead;
	previousEpoch: WorkflowEpochRef;
	nextEpoch: WorkflowEpochRef;
	previousWriterIdentity: string;
	previousLeaseRef: WorkflowLeaseRef;
	nextLeaseRef: WorkflowLeaseRef;
	generationBinding: WorkflowGenerationBinding;
	status: "committed" | "quarantined";
	fenceEventSequence: number;
	fenceEventDigest: string;
	activeGenerationManifestRef: WorkflowArtifactRef;
	priorRecordDigest: string | null;
	keyId: string;
	frameMac: string;
	frameChecksum: string;
	recordMac: string;
	recordChecksum: string;
	rotationArtifactRef: WorkflowArtifactRef;
}

export interface WorkflowArtifactRef {
	artifactId: string;
	relativePath: string;
	digest: string;
	sizeBytes: number;
	sourceEventSequence: number;
}

export type WorkflowArtifactCodec = "canonical_json" | "utf8" | "binary";

export interface WorkflowArtifactEnvelope {
	ref: WorkflowArtifactRef;
	payloadKind: WorkflowArtifactPayloadKind;
	codec: WorkflowArtifactCodec;
	immutable: true;
}

export interface WorkflowArtifactReadResult {
	envelope: WorkflowArtifactEnvelope;
	exists: true;
	bytes: Readonly<Uint8Array>;
	verifiedDigest: string;
	verifiedSizeBytes: number;
}

export interface WorkflowArtifactResolver {
	resolve(ref: WorkflowArtifactRef): Promise<WorkflowArtifactReadResult>;
}

export type WorkflowObservationKind =
	| "dataset"
	| "task_result"
	| "evidence"
	| "progress"
	| "supersession"
	| "quarantine";
export type WorkflowObservationOutcome = "applied" | "no_op" | "stale" | "rejected" | "failed";
export type WorkflowObservationDatasetSplit = "training" | "validation" | "holdout";
export type WorkflowObservationDatasetCoverage =
	| "complete"
	| "provider_empty"
	| "partial_coverage"
	| "unknown"
	| "missing";
export type WorkflowObservationDatasetGapClassification =
	| "none"
	| "provider_empty"
	| "partial_coverage"
	| "unknown"
	| "missing";
export type WorkflowObservationDatasetValidation = "passed" | "failed" | "unknown";
export type WorkflowObservationDatasetLifecycle = "in_progress" | "sealed" | "superseded" | "quarantined";
export type WorkflowObservationDatasetModality = "time_series" | "order_book" | "position_book" | "pricing_stream";
export type WorkflowObservationDatasetAccessAuthority =
	| "training_workers_training_only"
	| "validation_evaluator_host_only"
	| "holdout_host_aggregate_only";

export interface WorkflowObservationDatasetRestoreVerification {
	readonly locked: true;
	readonly independentlyRestored: boolean;
	readonly independentlyRehashed: boolean;
	readonly verificationEvidenceDigest: string | null;
}

export interface WorkflowObservationDatasetProvenance {
	readonly sourceSystem: string;
	readonly sourceDataset: string;
	readonly ingestDigest: string;
	readonly lineageDigest: string;
	readonly provenanceReceiptDigest: string;
}

export interface WorkflowObservationHoldoutAggregate {
	readonly aggregateDigest: string;
	readonly artifactRef: WorkflowArtifactRef;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface WorkflowObservationDatasetMetadata {
	readonly split: WorkflowObservationDatasetSplit;
	readonly modality: WorkflowObservationDatasetModality;
	readonly instrumentSet: readonly string[];
	readonly sourceTimeStart: string;
	readonly sourceTimeEnd: string;
	readonly schemaVersion: string;
	readonly objectUri: string;
	readonly generation: number;
	readonly sha256: string;
	readonly bytes: number;
	readonly validationResult: WorkflowObservationDatasetValidation;
	readonly coverage: WorkflowObservationDatasetCoverage;
	readonly gapClassification: WorkflowObservationDatasetGapClassification;
	readonly gapEvidenceRefs: readonly WorkflowArtifactRef[];
	readonly sourceEmptyEvidenceRefs: readonly WorkflowArtifactRef[];
	readonly lifecycle: WorkflowObservationDatasetLifecycle;
	readonly lifecycleTargetObservationId: string | null;
	readonly restoreVerification: WorkflowObservationDatasetRestoreVerification;
	readonly provenance: WorkflowObservationDatasetProvenance;
	readonly closureRootDigest: string;
	readonly accessAuthority: WorkflowObservationDatasetAccessAuthority;
	readonly hostReceipt: WorkflowVerifiedHostReceipt;
	readonly holdoutAggregate: WorkflowObservationHoldoutAggregate | null;
}

export interface WorkflowObservationOutcomeRecord {
	readonly workflowId: string;
	readonly observationId: string;
	readonly observationDigest: string;
	readonly baseRevisionDigest: string;
	readonly processGeneration: string;
	readonly coordinatorTerm: number;
	readonly effectIdempotencyKey: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly kind: WorkflowObservationKind;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly decisionRef: WorkflowDecisionRef | null;
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly outcome: WorkflowObservationOutcome;
	readonly reason: string | null;
	readonly acceptedAt: string | null;
	readonly datasetMetadata: WorkflowObservationDatasetMetadata | null;
}

export interface WorkflowObservationCompletionCut {
	readonly workflowId: string;
	readonly cutId: string;
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly finalClosureObservationId: string;
	readonly finalClosureObservationDigest: string;
	readonly trainingClosureRootDigest: string;
	readonly validationClosureRootDigest: string;
	readonly holdoutClosureRootDigest: string;
	readonly supersededObservationIds: readonly string[];
	readonly quarantinedObservationIds: readonly string[];
	readonly sealedAt: string;
}

export interface WorkflowObservationLatePolicyRecord {
	readonly workflowId: string;
	readonly cutId: string;
	readonly observationId: string;
	readonly observationDigest: string;
	readonly baseRevisionDigest: string;
	readonly policy: "no_op" | "reopen" | "compensate";
	readonly epochRef: WorkflowEpochRef;
}

export interface WorkflowEffectPreimage {
	artifactRef: WorkflowArtifactRef;
	codec: WorkflowArtifactCodec;
	immutable: true;
	bytes: Readonly<Uint8Array>;
	verifiedDigest: string;
	verifiedSizeBytes: number;
}

export interface WorkflowEffectPreimageResolver {
	resolve(ref: WorkflowArtifactRef): Promise<WorkflowEffectPreimage>;
}

export interface WorkflowAcceleratorResource {
	poolId: string;
	deviceType: string;
	count: number;
	memoryBytes: number;
}

export interface WorkflowProviderResource {
	poolId: string;
	concurrentRequests: number;
	requestsPerMinute: number;
	totalRequests: number;
	inputTokens: number;
	outputTokens: number;
	idempotency: "provider_native" | "host_reconciled" | "none";
}

export interface WorkflowResourceVector {
	cpuMilliCores: number;
	memoryBytes: number;
	diskBytes: number;
	ioWeight: number;
	accelerators: readonly WorkflowAcceleratorResource[];
	providers: readonly WorkflowProviderResource[];
	networkEgressBytes: number;
	wallMilliseconds: number;
	monetaryMicrounits: number;
}

export interface WorkflowAuthenticatedCapacitySnapshotRefs {
	capacitySnapshotRef: WorkflowArtifactRef;
	usageSnapshotRef: WorkflowArtifactRef;
	billingSnapshotRef: WorkflowArtifactRef;
	rateLimitSnapshotRef: WorkflowArtifactRef;
	authenticationDigest: string;
	observedAt: string;
	expiresAt: string;
	monotonicObservationSequence: number;
	snapshotDigest: string;
}

export interface WorkflowAdaptiveCapacitySnapshotArtifact {
	workflowId: string;
	capacity: WorkflowResourceVector;
	controlCapacity: WorkflowControlCapacityVector;
	unknownPoolIds: readonly string[];
	observedAt: string;
	expiresAt: string;
	monotonicObservationSequence: number;
	authenticationDigest: string;
	hostReceipt: WorkflowVerifiedHostReceipt;
	snapshotDigest: string;
}

export interface WorkflowControlCapacityVector {
	processSlots: number;
	childSessionSlots: number;
	modelCallSlots: number;
	modelInputTokens: number;
	modelOutputTokens: number;
	verificationSlots: number;
	redTeamSlots: number;
	recoverySlots: number;
}

export interface WorkflowAcceleratorPool {
	poolId: string;
	deviceType: string;
	count: number;
	memoryBytes: number;
}

export interface WorkflowProviderPool {
	poolId: string;
	concurrentRequests: number;
	requestsPerMinute: number;
	totalRequests: number;
	inputTokens: number;
	outputTokens: number;
	idempotency: "provider_native" | "host_reconciled" | "none";
}

export interface WorkflowCanonicalPoolMap {
	readonly accelerators: ReadonlyMap<string, WorkflowAcceleratorPool>;
	readonly providers: ReadonlyMap<string, WorkflowProviderPool>;
	readonly digest: string;
}

export type WorkflowCanonicalPoolClass =
	| "scalar"
	| "control"
	| "provider"
	| "accelerator"
	| "billing"
	| "quota"
	| "rate_limit";
export type WorkflowResourceLedgerComponent =
	| "cpuMilliCores"
	| "memoryBytes"
	| "diskBytes"
	| "ioWeight"
	| "accelerators"
	| "providers"
	| "networkEgressBytes"
	| "wallMilliseconds"
	| "monetaryMicrounits";
export type WorkflowControlLedgerComponent =
	| "processSlots"
	| "childSessionSlots"
	| "modelCallSlots"
	| "modelInputTokens"
	| "modelOutputTokens"
	| "verificationSlots"
	| "redTeamSlots"
	| "recoverySlots";
export type WorkflowCanonicalPoolDimension =
	| WorkflowResourceLedgerComponent
	| WorkflowControlLedgerComponent
	| "spend"
	| "acceleratorCount"
	| "acceleratorMemoryBytes"
	| "providerConcurrentRequests"
	| "providerRequestsPerMinute"
	| "providerTotalRequests"
	| "providerInputTokens"
	| "providerOutputTokens";
export type WorkflowCanonicalResourceDimension =
	| WorkflowResourceLedgerComponent
	| "acceleratorCount"
	| "acceleratorMemoryBytes"
	| "providerConcurrentRequests"
	| "providerRequestsPerMinute"
	| "providerTotalRequests"
	| "providerInputTokens"
	| "providerOutputTokens";
export type WorkflowCanonicalPoolSelector = string | "item_pool";

export interface WorkflowCanonicalPoolAssignment {
	workflowId: string;
	epochRef: WorkflowEpochRef;
	approvedEnvelopeDigest: string;
	capacityCasDigest: string;
	resourceComponentPools: Readonly<Record<WorkflowCanonicalResourceDimension, WorkflowCanonicalPoolSelector>>;
	controlComponentPools: Readonly<Record<WorkflowControlLedgerComponent, string>>;
	spendPoolId: string;
	assignmentDigest: string;
}

export interface WorkflowCanonicalSpendState {
	totalMicrounits: number;
	byPool: Readonly<Record<string, number>>;
}

export interface WorkflowInstantaneousPoolLedger {
	poolId: string;
	poolClass: WorkflowCanonicalPoolClass;
	component: WorkflowCanonicalPoolDimension;
	dimension: WorkflowCanonicalPoolDimension;
	approvedCapacity: number;
	reservedCapacity: number;
	activeCapacity: number;
	remainingCapacity: number;
	observedAt: string;
	monotonicObservationSequence: number;
	ledgerDigest: string;
}

export interface WorkflowCumulativeSpendLedger {
	poolId: string;
	poolClass: WorkflowCanonicalPoolClass;
	budgetMicrounits: number;
	committedMicrounits: number;
	settledMicrounits: number;
	quarantinedMicrounits: number;
	remainingMicrounits: number;
	observedAt: string;
	monotonicObservationSequence: number;
	ledgerDigest: string;
}

export interface WorkflowCanonicalPoolComponentLedger {
	poolId: string;
	component: WorkflowCanonicalPoolDimension;
	accounting: "instantaneous" | "cumulative";
	approvedValue: number;
	reservedValue: number;
	activeValue: number;
	remainingValue: number;
	committedValue: number;
	releasedValue: number;
	quarantinedValue: number;
	observedAt: string;
	monotonicObservationSequence: number;
	ledgerDigest: string;
}

export interface WorkflowCanonicalPoolLedger {
	ledgerId: string;
	ledgerEpoch: number;
	instantaneousPools: readonly WorkflowInstantaneousPoolLedger[];
	cumulativeSpendPools: readonly WorkflowCumulativeSpendLedger[];
	instantaneousComponentLedgers: readonly WorkflowCanonicalPoolComponentLedger[];
	cumulativeComponentLedgers: readonly WorkflowCanonicalPoolComponentLedger[];
	accountedResourceComponents: readonly WorkflowCanonicalPoolDimension[];
	accountedControlComponents: readonly WorkflowControlLedgerComponent[];
	exhaustiveComponentAccounting: true;
	reserveRepresentation: "canonical_ledger_only";
	componentPoolAssignment: WorkflowCanonicalPoolAssignment;
	ledgerDigest: string;
	workflowId: string;
	revision: number;
	epoch: WorkflowEpochRef;
	approvedPools: Readonly<Record<string, WorkflowResourceVector>>;
	activePools: Readonly<Record<string, WorkflowResourceVector>>;
	remainingPools: Readonly<Record<string, WorkflowResourceVector>>;
	instantaneousByPool: Readonly<Record<string, WorkflowResourceVector>>;
	cumulativeByPool: Readonly<Record<string, WorkflowResourceVector>>;
	reservedByPool: Readonly<Record<string, WorkflowResourceVector>>;
	releasedByPool: Readonly<Record<string, WorkflowResourceVector>>;
	instantaneousSpend: WorkflowCanonicalSpendState;
	cumulativeSpend: WorkflowCanonicalSpendState;
	instantaneousSpendByPool: Readonly<Record<string, number>>;
	cumulativeSpendByPool: Readonly<Record<string, number>>;
	exhaustiveResourceComponents: WorkflowResourceVector;
	exhaustiveControlDimensions: WorkflowControlCapacityVector;
	approvedEnvelopeDigest: string;
	envelopeCapacityCasDigest: string;
	providerPoolIds: readonly string[];
	acceleratorPoolIds: readonly string[];
	artifactRef: WorkflowArtifactRef;
	digest: string;
}

export interface WorkflowTaskResourceGrant {
	resourceVector: WorkflowResourceVector;
	workerCapacity: WorkflowControlCapacityVector;
	controlCapacity: WorkflowControlCapacityVector;
	expectedEnvelopeDigest: string;
	canonicalLedgerRef: WorkflowArtifactRef;
	canonicalLedgerDigest: string;
	grantDigest: string;
}

export interface WorkflowWorkerGrantLedgerEntry {
	kind: "worker";
	workflowId: string;
	entryId: string;
	taskId: string;
	attemptId: string;
	leaseRef: WorkflowLeaseRef;
	epochRef: WorkflowEpochRef;
	idempotencyKey: string;
	grant: WorkflowTaskResourceGrant;
	usageReceipt: WorkflowVerifiedHostReceipt;
	release: { sequence: number; receipt: WorkflowVerifiedHostReceipt } | null;
}

export interface WorkflowControlGrantLedgerEntry {
	kind: "control";
	workflowId: string;
	entryId: string;
	taskId: string | null;
	attemptId: string | null;
	leaseRef: WorkflowLeaseRef;
	epochRef: WorkflowEpochRef;
	idempotencyKey: string;
	grant: WorkflowTaskResourceGrant;
	usageReceipt: WorkflowVerifiedHostReceipt;
	release: { sequence: number; receipt: WorkflowVerifiedHostReceipt } | null;
}

export type WorkflowResourceGrantLedgerEntry = WorkflowWorkerGrantLedgerEntry | WorkflowControlGrantLedgerEntry;

export interface WorkflowResourceGrantLedger {
	workflowId: string;
	revision: number;
	entries: readonly WorkflowResourceGrantLedgerEntry[];
	resourceTotal: WorkflowResourceVector;
	spendTotalMicrounits: number;
	headDigest: string;
	canonicalLedgerRef: WorkflowArtifactRef;
	canonicalLedgerDigest: string;
	workerTotal: WorkflowControlCapacityVector;
	controlTotal: WorkflowControlCapacityVector;
	instantaneousByPool: Readonly<Record<string, WorkflowResourceVector>>;
	cumulativeByPool: Readonly<Record<string, WorkflowResourceVector>>;
	instantaneousSpendByPool: Readonly<Record<string, number>>;
	cumulativeSpendByPool: Readonly<Record<string, number>>;
	instantaneousWorkerCapacity: WorkflowControlCapacityVector;
	instantaneousControlCapacity: WorkflowControlCapacityVector;
	cumulativeWorkerCapacity: WorkflowControlCapacityVector;
	cumulativeControlCapacity: WorkflowControlCapacityVector;
	canonicalPoolLedger: WorkflowCanonicalPoolLedger;
	approvedEnvelopeDigest: string;
	envelopeCapacityCasDigest: string;
}

export interface WorkflowResourceGrantLedgerStore {
	read(workflowId: string): Promise<WorkflowResourceGrantLedger>;
	compareAndSwap(input: {
		workflowId: string;
		expectedHeadDigest: string;
		entry: WorkflowResourceGrantLedgerEntry;
	}): Promise<WorkflowResourceGrantLedger>;
	release(input: {
		workflowId: string;
		expectedHeadDigest: string;
		entryId: string;
		release: { sequence: number; receipt: WorkflowVerifiedHostReceipt };
	}): Promise<WorkflowResourceGrantLedger>;
	reconcile(workflowId: string): Promise<WorkflowResourceGrantLedger>;
	replay(workflowId: string): Promise<readonly WorkflowResourceGrantLedgerEntry[]>;
}

export interface WorkflowZeroControlCapacityVector extends WorkflowControlCapacityVector {
	processSlots: 0;
	childSessionSlots: 0;
	modelCallSlots: 0;
	modelInputTokens: 0;
	modelOutputTokens: 0;
	verificationSlots: 0;
	redTeamSlots: 0;
	recoverySlots: 0;
}

export type WorkflowCapacityGrant =
	| {
			kind: "worker";
			grantId: string;
			resourceVector: WorkflowResourceVector;
			controlCapacity: WorkflowZeroControlCapacityVector;
			canonicalPoolLedgerRef: WorkflowArtifactRef;
			grantDigest: string;
	  }
	| {
			kind: "control";
			grantId: string;
			resourceVector: WorkflowResourceVector;
			controlCapacity: WorkflowControlCapacityVector;
			canonicalPoolLedgerRef: WorkflowArtifactRef;
			grantDigest: string;
	  };

export interface WorkflowControlPartition {
	capacity: WorkflowControlCapacityVector;
	resourceVector: WorkflowResourceVector;
	canonicalPoolLedgerRef: WorkflowArtifactRef;
	partitionDigest: string;
}

export interface WorkflowWorkerPartition {
	resourceVector: WorkflowResourceVector;
	controlCapacity: WorkflowZeroControlCapacityVector;
	enforcementClass: WorkflowResourceEnforcementClass;
	canonicalPoolLedgerRef: WorkflowArtifactRef;
	partitionDigest: string;
}

export interface WorkflowExecutionCeilings {
	maxWorkflowWallMilliseconds: number;
	maxWorkflowTokens: number;
	maxModelCalls: number;
	maxTaskAttempts: number;
	maxPlannerCycles: number;
	maxDistinctStrategiesPerRequirement: number;
	maxAnalysisAttemptsPerRequirement: number;
	maxRecoveryAttemptsPerEffectClass: number;
	renewalRequiresUserApproval: true;
}

export type WorkflowExecutionCeilingInput = Partial<Omit<WorkflowExecutionCeilings, "renewalRequiresUserApproval">> & {
	renewalRequiresUserApproval?: true;
};

export const DEFAULT_WORKFLOW_EXECUTION_CEILINGS: WorkflowExecutionCeilings = Object.freeze({
	maxWorkflowWallMilliseconds: 86_400_000,
	maxWorkflowTokens: 1_000_000,
	maxModelCalls: 100,
	maxTaskAttempts: 100,
	maxPlannerCycles: 100,
	maxDistinctStrategiesPerRequirement: 5,
	maxAnalysisAttemptsPerRequirement: 5,
	maxRecoveryAttemptsPerEffectClass: 3,
	renewalRequiresUserApproval: true,
});

export type WorkflowResourceEnforcementClass = "isolated_metered" | "host_bounded" | "exclusive_unisolated";

export interface WorkflowResourceAdmission {
	capacityGrant: WorkflowCapacityGrant;
	canonicalPoolLedgerRef: WorkflowArtifactRef;
	controlCapacity: WorkflowControlCapacityVector;
	controlCapacityProjectionDigest: string;
	declaredVector: WorkflowResourceVector;
	hostDerivedConservativeVector: WorkflowResourceVector;
	reservedVector: WorkflowResourceVector;
	declaredControlCapacity: WorkflowControlCapacityVector;
	hostDerivedControlCapacity: WorkflowControlCapacityVector;
	reservedControlCapacity: WorkflowControlCapacityVector;
	derivationPolicyDigest: string;
	enforcementClass: WorkflowResourceEnforcementClass;
	unknownPoolIds: readonly string[];
	canonicalLedgerRef: WorkflowArtifactRef;
	canonicalLedgerDigest: string;
	admitted: boolean;
	admissionDigest: string;
}

export interface WorkflowControlCapacityReservation {
	reservationId: string;
	workflowId: string;
	expectedEnvelopeDigest: string;
	expectedStateDigest: string;
	grantedCapacity: WorkflowControlCapacityVector;
	controlCapacity: WorkflowControlCapacityVector;
	workerCapacity: WorkflowControlCapacityVector;
	reservationDigest: string;
}

export interface WorkflowControlCapacityReservationStore {
	compareAndSwap(input: {
		workflowId: string;
		expectedEnvelopeDigest: string;
		expectedStateDigest: string;
		priorReservationDigest: string | null;
		grants: readonly WorkflowTaskResourceGrant[];
	}): Promise<WorkflowControlCapacityReservation>;
}

export interface WorkflowResourceEnvelopeDraft {
	envelopeId: string;
	resources: WorkflowResourceVector;
	controlPlaneReserve: WorkflowResourceVector;
	controlPlaneReserveCapacity: WorkflowControlCapacityVector;
	controlCapacity: WorkflowControlCapacityVector;
	workerCapacity: WorkflowControlCapacityVector;
	processSlots: number;
	childSessionSlots: number;
	candidateSlots: number;
	executionCeilings: WorkflowExecutionCeilings;
	providerQuotaSnapshotRef: WorkflowArtifactRef;
	inventoryDigest: string;
	pricingDigest: string;
	terminationPolicyDigest: string;
	billingReconciliationPolicyDigest: string;
	egressPolicyDigest: string;
	validFrom: string;
	validUntil: string;
	capacityReceipt: WorkflowCloudCapacityReceipt | null;
	approvalDecisionRef: null;
	canonicalLedgerRef: WorkflowArtifactRef;
	canonicalLedgerDigest: string;
	draftDigest: string;
}

export interface WorkflowResourceEnvelope {
	envelopeId: string;
	resources: WorkflowResourceVector;
	controlPlaneReserve: WorkflowResourceVector;
	controlPlaneReserveCapacity: WorkflowControlCapacityVector;
	controlCapacity: WorkflowControlCapacityVector;
	workerCapacity: WorkflowControlCapacityVector;
	processSlots: number;
	childSessionSlots: number;
	candidateSlots: number;
	executionCeilings: WorkflowExecutionCeilings;
	providerQuotaSnapshotRef: WorkflowArtifactRef;
	inventoryDigest: string;
	pricingDigest: string;
	terminationPolicyDigest: string;
	billingReconciliationPolicyDigest: string;
	egressPolicyDigest: string;
	validFrom: string;
	validUntil: string;
	capacityReceipt: WorkflowCloudCapacityReceipt | null;
	approvalDecisionRef: WorkflowDecisionRef;
	canonicalLedgerRef: WorkflowArtifactRef;
	canonicalLedgerDigest: string;
	envelopeDigest: string;
}

export interface WorkflowResourceReadiness {
	workflowId: string;
	taskId: string;
	attemptId: string;
	ready: boolean;
	blockingReasons: readonly WorkflowDispatchBlockingReason[];
	canonicalLedgerRef: WorkflowArtifactRef;
	canonicalLedgerDigest: string;
	envelopeDigest: string;
	epochRef: WorkflowEpochRef;
	readinessDigest: string;
}

export interface WorkflowCloudEnvelope extends WorkflowResourceEnvelope {
	provider: string;
	accountRef: string;
	region: string;
	credentialRef: string;
	providerSpendCapRef: string;
}

export interface WorkflowRuntimeConfigSnapshot {
	configSchemaVersion: number;
	configRevision: number;
	runtimeIdentityDigest: string;
	repositoryPolicyDigest: string;
	workspaceIdentityDigest: string;
	globalSettingsDigest: string;
	projectSettingsDigest: string;
	packageDefaultsDigest: string;
	methodologyManifestDigests: readonly string[];
	nativeMethodologyContractDigest: string;
	skillContentDigests: readonly string[];
	skillDependencyDigests: readonly string[];
	evaluatorDigests: readonly string[];
	parserDigests: readonly string[];
	guardDigests: readonly string[];
	scorecardRuleDigest: string;
	resourceInventoryDigest: string;
	resourceEnvelopePolicyDigest: string;
	egressPolicyDigest: string;
	authorityPolicyDigest: string;
	approvalPolicyDigest: string;
	provenanceManifestDigest: string;
	daemonCapabilityDigest: string;
	closureManifestDigest: string;
	resolvedConfigDigest: string;
	executionProfile: "unresolved" | "inline" | "parallel";
	decisionLimitsDigest: string;
	schedulerPolicyDigest: string;
	journalFormatDigest: string;
	closureManifestRef: WorkflowArtifactRef;
	closureManifestBytes: Readonly<Uint8Array>;
}

export interface WorkflowCloudObservation {
	available: boolean;
	provider: string | null;
	accountRef: string | null;
	region: string | null;
	credentialRef: string | null;
	vector: WorkflowResourceVector;
	unknownPoolIds: readonly string[];
	billingLagDigest: string | null;
	rateLimitLagDigest: string | null;
	terminationUncertaintyDigest: string | null;
}

export type WorkflowCloudAvailabilityStatus = "available" | "unavailable" | "unknown";

export interface WorkflowCloudAvailabilityRequest {
	requestId: string;
	provider: string;
	accountRef: string;
	region: string;
	credentialRef: string;
	requestedVector: WorkflowResourceVector;
	egressPolicyDigest: string;
	quotaPolicyDigest: string;
	pricingPolicyDigest: string;
	billingPolicyDigest: string;
	terminationPolicyDigest: string;
	timeoutMilliseconds: number;
	requestedAt: string;
}

export interface WorkflowCloudAvailabilityResponse {
	requestDigest: string;
	status: WorkflowCloudAvailabilityStatus;
	provider: string;
	accountRef: string;
	region: string;
	capacityArtifactRef: WorkflowArtifactRef | null;
	pricingArtifactRef: WorkflowArtifactRef | null;
	pricingDigest: string | null;
	authorityDigest: string | null;
	credentialArtifactRef: WorkflowArtifactRef | null;
	quotaArtifactRef: WorkflowArtifactRef | null;
	rateLimitArtifactRef: WorkflowArtifactRef | null;
	billingArtifactRef: WorkflowArtifactRef | null;
	egressArtifactRef: WorkflowArtifactRef | null;
	terminationArtifactRef: WorkflowArtifactRef | null;
	responseArtifactRef: WorkflowArtifactRef | null;
	responseReceipt: WorkflowVerifiedHostReceipt | null;
	responseKeyId: string | null;
	responseMac: string | null;
	responseChecksum: string | null;
	validUntil: string | null;
	reasonCode: "reported_available" | "reported_unavailable" | "unknown_authority" | "unknown_quota" | "expired";
}

export type DurableDecisionScope =
	| { kind: "workflow"; workflowId: string; rootSessionId: string }
	| { kind: "session"; rootSessionId: string }
	| { kind: "knowledge"; namespace: string }
	| { kind: "workspace"; workspaceId: string }
	| { kind: "user"; userId: string }
	| { kind: "global"; authorityId: string };

export type DurableDecisionKind =
	| "goal_binding"
	| "goal_transition"
	| "goal_contract"
	| "scorecard"
	| "resource_envelope"
	| "configuration_revision"
	| "profile_selection"
	| "plan"
	| "ownership"
	| "strategy_change"
	| "progress_acceptance"
	| "blocker"
	| "recovery"
	| "skill_gate"
	| "autoresearch_candidate"
	| "refinement"
	| "memory_write"
	| "completion"
	| "cancellation";

export type WorkflowAuthorityCapability =
	| "observe_workflow"
	| "read_workspace"
	| "read_external_evidence"
	| "propose_transition"
	| "write_owned_paths"
	| "spawn_child"
	| "consume_resource_lease"
	| "invoke_host_effect"
	| "request_user_approval"
	| "apply_goal_projection"
	| "accept_progress"
	| "accept_completion"
	| "write_canonical_knowledge";

export type DurableDecisionStage = "recon" | "lens" | "verification" | "synthesis" | "red_team" | "host_adjudication";
export type DurableLensRole = "primary" | "secondary";
export type DurableStageVerdictDisposition = "accepted" | "rejected" | "inconclusive";

export interface DurableStagePlan {
	stages: readonly ["recon", "lens", "lens", "verification", "synthesis", "red_team"];
	lensRoles: readonly [null, "primary", "secondary", null, null, null];
	charterDigests: readonly [string, string, string, string, string, string];
	planDigest: string;
}

export interface DurableStageIndependence {
	freshContext: true;
	distinctSessionIdentity: true;
	distinctExecutionIdentity: true;
	sharedConversation: false;
	sharedMutableOutput: false;
	inputStateDigest: string;
	charterDigest: string;
	limitationRefs: readonly WorkflowArtifactRef[];
}

export interface DurableStageVerdict {
	decisionId: string;
	decisionRevision: number;
	stage: DurableDecisionStage;
	lensRole: DurableLensRole | null;
	stageId: string;
	disposition: DurableStageVerdictDisposition;
	sessionId: string;
	executionIdentity: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	inputStateDigest: string;
	evidenceDigest: string;
	artifactRefs: readonly WorkflowArtifactRef[];
	independence: DurableStageIndependence;
}

export interface DurableHostAdjudication {
	stage: "host_adjudication";
	decisionId: string;
	decisionRevision: number;
	executionIdentity: string;
	sessionId: string;
	inputStateDigest: string;
	operationDigest: string;
	verdictArtifactRef: WorkflowArtifactRef;
	verdictDigest: string;
	hostReceipt: WorkflowVerifiedHostReceipt;
	disposition: "accepted" | "rejected";
}

export type DurableMateriality = "routine" | "material" | "consequential";

export type DurableEffectClass =
	| "read_only"
	| "owned_reversible_local_write"
	| "public_interface"
	| "test_or_evaluator"
	| "dependency_or_lockfile"
	| "configuration"
	| "goal_contract_or_scorecard"
	| "authority_or_resource"
	| "git_or_publication"
	| "external_side_effect"
	| "destructive_or_irreversible"
	| "unknown";

export interface DurableHostDecisionClassification {
	classifier: "host";
	rulesetDigest: string;
	effectClasses: readonly DurableEffectClass[];
	normalizedReadSet: readonly string[];
	normalizedWriteSet: readonly string[];
	derivedMateriality: DurableMateriality;
	requiresUserApproval: boolean;
	reasonCodes: readonly string[];
	classifiedTargetDigest: string;
	classifiedEffectDigest: string;
}

export interface DurableDecisionRecord {
	decisionScope: DurableDecisionScope;
	decisionId: string;
	revision: number;
	parentDecisionIds: readonly string[];
	kind: DurableDecisionKind;
	hostClassification: DurableHostDecisionClassification;
	storeEpoch: number;
	coordinatorEpoch: number;
	targetDigest: string;
	effectDigest: string;
	preconditionDigest: string;
	authority: readonly WorkflowAuthorityCapability[];
	expiresAt: string;
	objectiveDigest: string;
	contractDigest: string;
	scorecardDigest: string;
	planDigest: string;
	stateDigest: string;
	workspaceDigest: string;
	evidenceDigest: string;
	parserDigest: string;
	evaluatorDigest: string;
	guardDigest: string;
	regressionDigest: string;
	blockerDigest: string | null;
	redTeamDigest: string;
	readSet: readonly string[];
	writeSet: readonly string[];
	attemptToken: string;
	nonce: string;
	executionKey: string;
	proposerSessionId: string;
	lensSessionIds: readonly string[];
	verifierSessionId: string;
	synthesizerSessionId: string;
	redTeamSessionId: string;
	stagePlan: DurableStagePlan;
	stageVerdicts: readonly DurableStageVerdict[];
	hostAdjudication: DurableHostAdjudication;
	writeSetReservation?: { reservationId: string; reservationDigest: string };
	artifactRefs: readonly WorkflowArtifactRef[];
	disposition: "proposed" | "rejected" | "awaiting_user" | "authorized" | "applied" | "stale" | "conflicted";
}

export type WorkflowDecisionRecord = DurableDecisionRecord & {
	decisionScope: { kind: "workflow"; workflowId: string; rootSessionId: string };
};

export interface DurableDecisionRef {
	decisionScope: DurableDecisionScope;
	decisionId: string;
	revision: number;
	storeEpoch: number;
	decisionDigest: string;
}

export type WorkflowDecisionRef = DurableDecisionRef & {
	decisionScope: { kind: "workflow"; workflowId: string; rootSessionId: string };
	coordinatorEpoch: number;
};

export type WorkflowRevisionDecisionRef =
	| (DurableDecisionRef & { decisionScope: { kind: "knowledge"; namespace: string } })
	| (DurableDecisionRef & { decisionScope: { kind: "session"; rootSessionId: string } })
	| (DurableDecisionRef & { decisionScope: { kind: "workspace"; workspaceId: string } })
	| (DurableDecisionRef & { decisionScope: { kind: "user"; userId: string } })
	| (DurableDecisionRef & { decisionScope: { kind: "global"; authorityId: string } })
	| WorkflowDecisionRef;

export type WorkflowRevisionScope = "session" | "workflow" | "knowledge" | "workspace" | "user" | "global";

export type WorkflowRevisionScopeRecord =
	| { kind: "knowledge"; namespace: string }
	| { kind: "session"; rootSessionId: string }
	| { kind: "workflow"; workflowId: string; rootSessionId: string }
	| { kind: "workspace"; workspaceId: string }
	| { kind: "user"; userId: string }
	| { kind: "global"; authorityId: string };

export type WorkflowLeaseStatus = "reserved" | "active" | "release_pending" | "released" | "quarantined" | "expired";

export interface WorkflowLeaseRef extends WorkflowEpochRef {
	leaseId: string;
	acquisitionEventSequence: number;
	processIdentity: string;
	rootDigest: string;
	writerIdentity: string;
	acquiredAt: string;
	expiresAt: string;
}

/**
 * Compare the immutable ownership identity of two append-lease snapshots.
 * Args:
 * left: First lease snapshot.
 * right: Second lease snapshot.
 * Return: True when both snapshots identify the same acquisition; expiry may differ after renewal.
 */
export function sameWorkflowLeaseIdentity(left: WorkflowLeaseRef, right: WorkflowLeaseRef): boolean {
	return (
		left.storeEpoch === right.storeEpoch &&
		left.coordinatorEpoch === right.coordinatorEpoch &&
		left.leaseId === right.leaseId &&
		left.acquisitionEventSequence === right.acquisitionEventSequence &&
		left.processIdentity === right.processIdentity &&
		left.rootDigest === right.rootDigest &&
		left.writerIdentity === right.writerIdentity &&
		left.acquiredAt === right.acquiredAt
	);
}

export interface WorkflowResourceLease {
	leaseId: string;
	workflowId: string;
	taskId: string | null;
	attemptId: string | null;
	holderIdentity: string;
	resourceAdmission: WorkflowResourceAdmission;
	controlCapacity: WorkflowControlCapacityVector;
	workerCapacity: WorkflowControlCapacityVector;
	status: WorkflowLeaseStatus;
	storeEpoch: number;
	coordinatorEpoch: number;
	acquisitionEventSequence: number;
	idempotencyKey: string;
	/** Trusted manager timestamp; every dispatchable lease has acquiredAt < expiresAt. */
	acquiredAt: string;
	expiresAt: string;
	releaseEventSequence: number | null;
}

export interface WorkflowOwnershipLease {
	leaseId: string;
	workflowId: string;
	taskId: string;
	attemptId: string;
	ownedPaths: readonly string[];
	generatedOutputPaths?: readonly string[];
	lockPaths?: readonly string[];
	ownedContracts: readonly string[];
	status: WorkflowLeaseStatus;
	storeEpoch: number;
	coordinatorEpoch: number;
	acquisitionEventSequence: number;
	releaseEventSequence: number | null;
}

export interface WorkflowLeaseReleaseInput {
	workflowId: string;
	attemptId: string;
	leaseRef: WorkflowLeaseRef;
	epochRef: WorkflowEpochRef;
	outcomeDigest: string;
	store: WorkflowRuntimeStore;
}

export interface WorkflowLeaseReleaseRef {
	leaseRef: WorkflowLeaseRef;
	attemptId: string;
	terminalOutcomeDigest: string;
	releaseEventSequence: number;
	releaseProof: string;
}

export interface WorkflowLeaseReleaseResult {
	status: "released" | "already_released";
	leaseRef: WorkflowLeaseRef;
	releaseEventSequence: number;
	epochRef: WorkflowEpochRef;
}

export type WorkflowChildCapability = "read_only" | "shell" | "ipython" | "edit" | "recursive_spawn";
export type WorkflowChildWriteClass = "read_only" | "write_capable";

export interface WorkflowChildAuthority {
	capabilities: readonly WorkflowChildCapability[];
	writeClass: WorkflowChildWriteClass;
	parentAttemptId: string | null;
	rootSpawned: boolean;
}

export interface WorkflowChildIdentity {
	admissionId: string;
	childSessionId: string;
	processGroupId: string;
	executionKey: string;
	epochRef: WorkflowEpochRef;
	runtimeVersion: string;
	hostCapabilityRevision: string;
	agentRole: string;
	modelId: string;
	reasoningEffort: string;
	launchConfigDigest: string;
	identityDigest: string;
}

export interface WorkflowChildProcessBinding {
	workflowId: string;
	taskId: string;
	attemptId: string;
	childIdentity: WorkflowChildIdentity;
	processGroup: WorkflowProcessGroupIdentity;
	bindingDigest: string;
}

export type WorkflowAttemptStatus =
	| "admitted"
	| "starting"
	| "running"
	| "awaiting_audit"
	| "reconciling"
	| "completed"
	| "needs_fix"
	| "blocked"
	| "failed"
	| "interrupted"
	| "cancelled"
	| "quarantined";

export interface WorkflowAttemptLifecycle {
	workflowId: string;
	taskId: string;
	attemptId: string;
	status: WorkflowAttemptStatus;
	childIdentity: WorkflowChildIdentity | null;
	childAuthority: WorkflowChildAuthority;
	admissionEventSequence: number;
	terminalEventSequence: number | null;
	epochRef: WorkflowEpochRef;
	statusDigest: string;
}

export interface WorkflowTask {
	taskId: string;
	planRevision: number;
	objective: string;
	requirementIds: readonly string[];
	completionCriteria: readonly string[];
	dependencyTaskIds: readonly string[];
	/** Dynamic task inputs retained from the approved graph source. */
	inputRefs?: readonly string[];
	/** Dynamic task boundaries retained from the approved graph source. */
	boundaryIds?: readonly string[];
	/** Dynamic task outputs retained from the approved graph source. */
	outputRefs?: readonly string[];
	/** Dynamic task evidence limits retained from the approved graph source. */
	evidencePolicy?: {
		kind: string;
		maxBytes: number;
		maxItems: number;
		independent: boolean;
	};
	/** Dynamic task evidence kind retained from the approved graph source. */
	evidenceKind?: string;
	/** Dynamic task budget retained without unit coercion. */
	budget?: {
		tokenLimit: number;
		wallTimeLimitSeconds: number;
		spendLimitMicrounits: number;
	};
	/** Dynamic task recovery behavior retained from the approved graph source. */
	recoveryPolicy?: "retry" | "replan" | "block";
	/** Graph-source digest shared by every dynamically admitted task. */
	taskGraphSourceDigest?: string;
	ownedPaths: readonly string[];
	ownedContracts: readonly string[];
	requiredSkillSnapshotDigests: readonly string[];
	verificationCommandDigests: readonly string[];
	authority: readonly WorkflowAuthorityCapability[];
	declaredResourceVector: WorkflowResourceVector;
	declaredControlCapacity: WorkflowControlCapacityVector;
	status:
		| "pending"
		| "ready"
		| "admitted"
		| "running"
		| "awaiting_audit"
		| "accepted"
		| "needs_fix"
		| "blocked"
		| "cancelled";
	attemptIds: readonly string[];
}

export interface WorkflowAttemptHandoff {
	taskId: string;
	attemptId: string;
	outcome: "completed" | "needs_fix" | "blocked" | "interrupted";
	planRevision: number;
	goalContractRevision: number;
	ownedPaths: readonly string[];
	ownedContracts: readonly string[];
	upstreamDecisionRefs: readonly WorkflowArtifactRef[];
	interfaceAndDependencyRefs: readonly WorkflowArtifactRef[];
	recommendation: string;
	rationale: string;
	preservedInvariants: readonly string[];
	pitfalls: readonly string[];
	requirementEvidence: readonly WorkflowRequirementEvidence[];
	verificationEvidenceRefs: readonly WorkflowArtifactRef[];
	unresolvedIssues: readonly string[];
	failedApproaches: readonly string[];
	escalation: WorkflowEscalationRequest | null;
	preWorkspaceDigest: string;
	postWorkspaceDigest: string;
}

export const WORKFLOW_EVIDENCE_LIMITS = Object.freeze({
	maxEnvelopeBytes: 16_384,
	maxIdentifierBytes: 256,
	maxClaimBytes: 2_048,
	maxResultBytes: 4_096,
	maxMethodBytes: 2_048,
	maxLimitations: 16,
	maxLimitationBytes: 512,
	maxArtifactObservations: 32,
	maxArtifactSizeBytes: 8_388_608,
	maxCommandDigestBytes: 256,
	maxCommandOutputBytes: 8_192,
	maxCommandOutputLines: 256,
	maxScannerFindings: 32,
	maxScannerFindingCodeBytes: 128,
	maxFreshnessMilliseconds: 86_400_000,
});

export type WorkflowEvidenceCommandExitState = "exited" | "signaled" | "timed_out" | "spawn_failed" | "not_run";
export type WorkflowEvidenceSignal = "SIGABRT" | "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGTERM" | "unknown";

export interface WorkflowEvidenceCommandObservation {
	commandDigest: string;
	exitState: WorkflowEvidenceCommandExitState;
	exitCode: number | null;
	signal: WorkflowEvidenceSignal | null;
	stdout: string;
	stderr: string;
	stdoutBytes: number;
	stderrBytes: number;
	outputDigest: string;
	outputTruncated: boolean;
}

export interface WorkflowEvidenceArtifactObservation {
	artifactRef: WorkflowArtifactRef;
	exists: true;
	verifiedDigest: string;
	verifiedSizeBytes: number;
}

export interface WorkflowEvidenceScannerObservation {
	scannerDigest: string;
	scanStatus: "passed" | "redacted" | "blocked";
	redactionStatus: "not_required" | "applied" | "blocked";
	findingCodes: readonly string[];
	findingDigest: string;
}

export interface WorkflowEvidenceEnvelope {
	evidenceId: string;
	evidenceRevision: number;
	requirementId: string;
	claim: string;
	result: string;
	method: string;
	command: WorkflowEvidenceCommandObservation | null;
	artifactObservations: readonly WorkflowEvidenceArtifactObservation[];
	scanner: WorkflowEvidenceScannerObservation;
	confidence: "high" | "medium" | "low";
	limitations: readonly string[];
	workspaceDigest: string;
	configDigest: string;
	revisions: WorkflowRevisionTuple;
	evaluatorDigest: string;
	parserDigest: string;
	guardDigest: string;
	updatedDigest: string;
	invalidatedByDecisionRef: WorkflowDecisionRef | null;
	regressed: boolean;
	auditorDecisionRef: WorkflowDecisionRef | null;
	observedAt: string;
	freshUntil: string;
	freshnessWindowMilliseconds: number;
}

export interface WorkflowEvidenceEnvelopeRef {
	workflowId: string;
	envelopeId: string;
	envelopeDigest: string;
	evidenceRevision: number;
	artifactRefs: readonly WorkflowArtifactRef[];
	validationReceipt: WorkflowVerifiedHostReceipt;
}

export interface WorkflowRequirementEvidence {
	evidenceId: string;
	requirementId: string;
	claim: string;
	result: string;
	method: string;
	artifactRefs: readonly WorkflowArtifactRef[];
	confidence: "high" | "medium" | "low";
	limitations: readonly string[];
	workspaceDigest: string;
	observedAt: string;
}

export interface WorkflowEscalationRequest {
	reason: string;
	materialChangeKinds: readonly string[];
	evidenceRefs: readonly WorkflowArtifactRef[];
	requestedDecision: string;
}
export interface WorkflowProgressEntry {
	requirementId: string;
	status: "unproven" | "proven" | "regressed";
	evidenceRefs: readonly WorkflowArtifactRef[];
	evidenceRevisions: readonly number[];
	regressionReason: string | null;
	workspaceDigest: string;
	auditorDecisionRef: WorkflowDecisionRef;
	observedAt: string;
	invalidatedByDecisionId: string | null;
}

export interface WorkflowProgressLedger {
	workflowId: string;
	contractRevision: number;
	scorecardRevision: number;
	planRevision: number;
	configRevision: number;
	evidenceRevision: number;
	revisions: WorkflowRevisionTuple;
	entries: readonly WorkflowProgressEntry[];
	progressDigest: string;
}

export interface WorkflowRevisionTuple {
	contractRevision: number;
	scorecardRevision: number;
	planRevision: number;
	configRevision: number;
	evidenceRevision: number;
}

export interface WorkflowRevisionBoundaryContext {
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly executionKey: string | null;
	readonly revisionTuple: WorkflowRevisionTuple;
	readonly revisionRegistryRef: WorkflowArtifactRef;
	readonly revisionRegistryDigest: string;
	readonly configSnapshotDigest: string;
	readonly tupleDigest: string;
}

export interface WorkflowActiveLeaseContext {
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly writerIdentity: string;
	readonly generationId: string;
	readonly revisionBoundary: WorkflowRevisionBoundaryContext;
}

export type WorkflowBlockerAlternativeDisposition =
	| "failed_with_evidence"
	| "unsafe"
	| "outside_authority"
	| "external_state_unavailable";

export interface WorkflowBlockerAlternativeResult {
	alternativeId: string;
	strategyDigest: string;
	disposition: WorkflowBlockerAlternativeDisposition;
	attemptedStateDigest: string;
	evidenceRefs: readonly WorkflowArtifactRef[];
}

export interface WorkflowBlockerClaim {
	dependencyId: string;
	conditionDigest: string;
	requiredChange: string;
	registeredAlternativeSetDigest: string;
	alternativeResults: readonly WorkflowBlockerAlternativeResult[];
	evidenceRefs: readonly WorkflowArtifactRef[];
}

export interface WorkflowBlockerRecord extends WorkflowBlockerClaim {
	blockerId: string;
	workflowId: string;
	firstObservedGoalTurnId: string;
	lastObservedGoalTurnId: string;
	firstObservedGoalTurnSequence: number;
	lastObservedGoalTurnSequence: number;
	consecutiveGoalTurnCount: number;
	observedGoalTurnIds: readonly string[];
	remainingSafeAlternativeIds: readonly string[];
	auditDecisionRefs: readonly WorkflowDecisionRef[];
	disposition: "claimed" | "rejected" | "awaiting_user" | "confirmed";
}

export interface WorkflowPhaseOutcomeBase {
	workflowId: string;
	phaseAttemptId: string;
	epochRef: WorkflowEpochRef;
	invocationToken: string;
	inputStateDigest: string;
}

export type WorkflowPhaseOutcome =
	| (WorkflowPhaseOutcomeBase & {
			status: "complete";
			outputStateDigest: string;
			artifactRefs: readonly WorkflowArtifactRef[];
			evidenceRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowPhaseOutcomeBase & {
			status: "pause";
			approvalRequestId: string;
			artifactRefs: readonly WorkflowArtifactRef[];
			evidenceRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowPhaseOutcomeBase & {
			status: "blocked";
			blockerClaim: WorkflowBlockerClaim;
	  })
	| (WorkflowPhaseOutcomeBase & {
			status: "failed";
			errorCode: string;
			retryable: boolean;
			artifactRefs: readonly WorkflowArtifactRef[];
			evidenceRefs: readonly WorkflowArtifactRef[];
			completedAt?: string;
			workerId?: string;
			resultEvidenceRef?: WorkflowArtifactRef;
	  });

export interface WorkflowPhaseOutcomeRecord {
	outcome: WorkflowPhaseOutcome;
	attemptStatus: WorkflowAttemptStatus;
}

export interface WorkflowCompletionReadinessReceipt {
	workflowId: string;
	inputStateDigest: string;
	outcomeDigest: string;
	outputStateDigest: string;
	outputDigest: string;
	evidenceDigest: string;
	requirementEvidenceDigest: string;
	objectiveDigest: string;
	hardenedContractDigest: string;
	completeRequirementUniverseDigest: string;
	fixedBaselineDigest: string;
	capacityLedgerDigest: string;
	hiddenFailureDigest: string;
	freshVerifierDecisionRef: WorkflowDecisionRef;
	independentRedTeamDecisionRef: WorkflowDecisionRef;
	usageReconciliationRef: WorkflowArtifactRef;
	capacityReconciliationRef: WorkflowArtifactRef;
	adjudicationReceipt: WorkflowVerifiedHostReceipt;
	verdict: "ready" | "not_ready";
	hostReceipt: WorkflowVerifiedHostReceipt;
	receiptDigest: string;
}

export interface WorkflowCompletionUsageReconciliation {
	workflowId: string;
	inputStateDigest: string;
	outputStateDigest: string;
	resourceUsage: WorkflowResourceVector;
	controlUsage: WorkflowControlCapacityVector;
	spendMicrounits: number;
	grantLedgerRef: WorkflowArtifactRef;
	grantLedgerDigest: string;
	approvedEnvelopeDigest: string;
	goalBudgetDigest: string;
	hostReceipt: WorkflowVerifiedHostReceipt;
	reconciliationDigest: string;
}

export interface WorkflowCompletionCapacityReconciliation {
	workflowId: string;
	inputStateDigest: string;
	outputStateDigest: string;
	capacityVector: WorkflowResourceVector;
	controlCapacity: WorkflowControlCapacityVector;
	canonicalLedgerRef: WorkflowArtifactRef;
	canonicalLedgerDigest: string;
	approvedEnvelopeDigest: string;
	capacityCasDigest: string;
	hostReceipt: WorkflowVerifiedHostReceipt;
	reconciliationDigest: string;
}

export interface WorkflowGoalRequirement {
	requirementId: string;
	outcome: string;
	acceptanceCheckIds: readonly string[];
	requiredEvidenceKinds: readonly string[];
	adversarialTestArtifactRefs: readonly WorkflowArtifactRef[];
}

export interface WorkflowGoalContract {
	goalId: string;
	revision: number;
	originalObjective: string;
	requirements: readonly WorkflowGoalRequirement[];
	constraints: readonly string[];
	nonGoals: readonly string[];
	authorityCapabilities: readonly WorkflowAuthorityCapability[];
	contractDigest: string;
}

export type WorkflowMetricDirection = "maximize" | "minimize" | "target";
export type WorkflowRepeatabilityPolicy =
	| {
			kind: "single";
			hostDeterminismAttestationRef: WorkflowArtifactRef;
			deterministicInputClosureDigest: string;
			allowedVariance: 0;
	  }
	| { kind: "repeated"; runs: number; aggregation: "median" | "mean"; maxVariance: number }
	| {
			kind: "held_out";
			runs: number;
			heldOutInputDigest: string;
			aggregation: "median" | "mean";
			maxVariance: number;
	  };

export interface WorkflowMetricRunRecord {
	workflowId: string;
	evaluationId: string;
	hostExecutionId: string;
	metricId: string;
	runIndex: number;
	inputPartition: "declared" | "held_out";
	inputDigest: string;
	approvedClosureDigest: string;
	scorecardDigest: string;
	baselineDigest: string;
	observedValue: number;
	measurementCommandDigest: string;
	parserDigest: string;
	evaluatorDigest: string;
	evidenceRef: WorkflowArtifactRef;
	determinismEvidenceRefs: readonly WorkflowArtifactRef[];
	falsificationEvidenceRefs: readonly WorkflowArtifactRef[];
	attackEvidenceRefs: readonly WorkflowArtifactRef[];
	guardEvidenceRefs: readonly WorkflowArtifactRef[];
	hostReceipt: WorkflowVerifiedHostReceipt;
	trustedClockReceipt: WorkflowVerifiedHostReceipt;
}

export interface WorkflowMetricRunIssuer {
	issue(input: {
		workflowId: string;
		metric: WorkflowScorecardMetric;
		approvedClosureDigest: string;
		evaluatorDigest: string;
		parserDigest: string;
		measurementCommandDigest: string;
		baselineDigest: string;
		runIndex: number;
		inputPartition: "declared" | "held_out";
		inputDigest: string;
		trustedClockReceipt: WorkflowVerifiedHostReceipt;
		receiptContext: WorkflowHostReceiptConsumerContext;
		currentStateDigest: string;
		currentRevision: number;
	}): Promise<WorkflowMetricRunRecord>;
}

/**
 * Compute the host receipt binding for every metric run input and measurement.
 *
 * Args:
 * run: Metric run fields excluding receipts, which are signed over this digest.
 * metric: Approved metric whose requirement binding is signed into the receipt.
 * Return: Canonical digest used by the usage and trusted-clock receipts.
 */
export function workflowMetricRunBindingDigest(
	run: Omit<WorkflowMetricRunRecord, "hostReceipt" | "trustedClockReceipt">,
	metric: Pick<WorkflowScorecardMetric, "requirementId">,
): string {
	const evidenceRefs = [
		...run.determinismEvidenceRefs,
		...run.falsificationEvidenceRefs,
		...run.attackEvidenceRefs,
		...run.guardEvidenceRefs,
		run.evidenceRef,
	];
	return digestObject({
		workflowId: run.workflowId,
		evaluationId: run.evaluationId,
		hostExecutionId: run.hostExecutionId,
		metricId: run.metricId,
		requirementId: metric.requirementId,
		runIndex: run.runIndex,
		inputPartition: run.inputPartition,
		inputDigest: run.inputDigest,
		approvedClosureDigest: run.approvedClosureDigest,
		scorecardDigest: run.scorecardDigest,
		baselineDigest: run.baselineDigest,
		observedValue: run.observedValue,
		measurementCommandDigest: run.measurementCommandDigest,
		parserDigest: run.parserDigest,
		evaluatorDigest: run.evaluatorDigest,
		evidenceRefs,
	});
}

export interface WorkflowMetricEvaluationContext {
	currentWorkflowId: string;
	currentApprovedClosureDigest: string;
	currentScorecardDigest: string;
}

export interface WorkflowMetricEvaluation {
	evaluationId: string | null;
	metricId: string;
	runCount: number;
	aggregate: "single" | "median" | "mean";
	aggregateValue: number | null;
	variance: number | null;
	heldOutInputDigest: string | null;
	repeatabilitySatisfied: boolean;
	targetSatisfied: boolean;
	accepted: boolean;
	rejectionReasons: readonly (
		| "missing_run"
		| "extra_run"
		| "duplicate_run"
		| "non_finite_value"
		| "digest_mismatch"
		| "held_out_mismatch"
		| "variance_exceeded"
		| "target_missed"
		| "closure_mismatch"
		| "evidence_missing"
		| "execution_replay"
		| "baseline_mismatch"
	)[];
}

export interface WorkflowScorecardMetric {
	metricId: string;
	requirementId: string;
	direction: WorkflowMetricDirection;
	baseline: number | null;
	target: number;
	tolerance: number;
	parserDigest: string;
	measurementCommandDigest: string;
	evaluatorDigest: string;
	repeatability: WorkflowRepeatabilityPolicy;
}

export interface WorkflowScorecardAcceptanceCheck {
	checkId: string;
	description: string;
	evaluatorDigest: string;
	requiredEvidenceKinds: readonly string[];
	freshnessMilliseconds: number;
	reproducibilityDigest: string;
}

export interface WorkflowScorecardInvariant {
	invariantId: string;
	description: string;
	evaluatorDigest: string;
	falsificationArtifactRefs: readonly WorkflowArtifactRef[];
}

export interface WorkflowScorecard {
	scorecardId: string;
	revision: number;
	metrics: readonly WorkflowScorecardMetric[];
	acceptanceChecks: readonly WorkflowScorecardAcceptanceCheck[];
	protectedInvariants: readonly WorkflowScorecardInvariant[];
	guardMetricIds: readonly string[];
	resourceConstraintDigest: string;
	proxyAttackArtifactRefs: readonly WorkflowArtifactRef[];
	evidenceRuleDigest: string;
	scorecardDigest: string;
}
export interface WorkflowTrustedPrincipal {
	kind: "interactive_ui" | "workflow_command" | "headless_signer";
	principalId: string;
	credentialDigest: string;
}

export interface WorkflowApprovalOption {
	optionId: string;
	label: string;
	effectDigest: string;
}

export interface WorkflowApprovalDecisionRoles {
	goal: WorkflowDecisionRef;
	scorecard: WorkflowDecisionRef;
	resource: WorkflowDecisionRef;
}

export interface DurableSignedApprovalArtifact {
	kind: "signed_headless";
	approvalRequestId: string;
	workflowId: string;
	decisionRef: DurableDecisionRef;
	decisionRefs: readonly DurableDecisionRef[];
	decisionRoles: { goal: DurableDecisionRef; scorecard: DurableDecisionRef; resource: DurableDecisionRef };
	headDigest: string;
	stateDigest: string;
	configDigest: string;
	profileDigest: string;
	artifactDigest: string;
	optionId: string;
	principal: WorkflowTrustedPrincipal;
	storeEpoch: number;
	clientSessionId: string;
	responseSequence: number;
	expiresAt: string;
	signedRequestDigest: string;
	keyId: string;
	signatureAlgorithm: "ed25519";
	signature: string;
}

export interface WorkflowSignedApprovalArtifact extends DurableSignedApprovalArtifact {
	decisionRef: WorkflowRevisionDecisionRef;
	decisionRefs: readonly WorkflowDecisionRef[];
	coordinatorEpoch: number;
}

export interface DurableApprovalSecretProof {
	oneUseSecret: string;
	bindingDigest: string;
	bindingDigestAlgorithm: "sha256";
}

export interface DurableApprovalRequest {
	approvalRequestId: string;
	decisionRef: DurableDecisionRef;
	decisionRefs: readonly DurableDecisionRef[];
	decisionRoles: { goal: DurableDecisionRef; scorecard: DurableDecisionRef; resource: DurableDecisionRef };
	headDigest: string;
	stateDigest: string;
	configDigest: string;
	profileDigest: string;
	artifactDigest: string;
	storeEpoch: number;
	tokenHash: string;
	tokenHashAlgorithm: "sha256";
	trustedPrincipal: WorkflowTrustedPrincipal;
	requestingClientSessionId: string;
	expectedResponseSequence: number;
	expiresAt: string;
	question: string;
	options: readonly WorkflowApprovalOption[];
}

export interface DurableApprovalResponseBase {
	approvalRequestId: string;
	decisionRef: DurableDecisionRef;
	decisionRefs: readonly DurableDecisionRef[];
	decisionRoles: { goal: DurableDecisionRef; scorecard: DurableDecisionRef; resource: DurableDecisionRef };
	headDigest: string;
	stateDigest: string;
	configDigest: string;
	profileDigest: string;
	artifactDigest: string;
	storeEpoch: number;
	clientSessionId: string;
	trustedPrincipal: WorkflowTrustedPrincipal;
	responseSequence: number;
	optionId: string;
}

export type DurableApprovalResponse = DurableApprovalResponseBase &
	(
		| { mode: "interactive_secret"; secretProof: DurableApprovalSecretProof; signedHeadlessArtifact?: never }
		| { mode: "signed_headless"; secretProof?: never; signedHeadlessArtifact: DurableSignedApprovalArtifact }
	);

export interface WorkflowApprovalRequest extends DurableApprovalRequest {
	workflowId: string;
	decisionRef: WorkflowDecisionRef;
	coordinatorEpoch: number;
	decisionRoles: WorkflowApprovalDecisionRoles;
}

export interface WorkflowApprovalAwaitingUserTransition {
	status: "awaiting_user";
	phase: "adjudicating";
	goalDelta: WorkflowGoalMutationDelta;
	expectedHeadDigest: string;
	expectedEpoch: WorkflowEpochRef;
}

export interface WorkflowApprovalResumeTransition {
	status: "active";
	phase: "planning";
	plannerEventDigest: string;
	expectedHeadDigest: string;
	expectedStateDigest: string;
	expectedEpoch: WorkflowEpochRef;
}

export interface WorkflowApprovalResponseBase {
	approvalRequestId: string;
	decisionRef: WorkflowDecisionRef;
	decisionRefs: readonly WorkflowDecisionRef[];
	decisionRoles: { goal: WorkflowDecisionRef; scorecard: WorkflowDecisionRef; resource: WorkflowDecisionRef };
	workflowId: string;
	headDigest: string;
	stateDigest: string;
	configDigest: string;
	profileDigest: string;
	artifactDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	clientSessionId: string;
	trustedPrincipal: WorkflowTrustedPrincipal;
	responseSequence: number;
	optionId: string;
}

export type WorkflowApprovalResponse = WorkflowApprovalResponseBase &
	(
		| { mode: "interactive_secret"; secretProof: DurableApprovalSecretProof; signedHeadlessArtifact?: never }
		| { mode: "signed_headless"; secretProof?: never; signedHeadlessArtifact: WorkflowSignedApprovalArtifact }
	);

export interface WorkflowApprovalReceipt {
	approvalRequestId: string;
	workflowId: string;
	decisionRef: WorkflowDecisionRef;
	decisionRefs: readonly WorkflowDecisionRef[];
	headDigest: string;
	stateDigest: string;
	configDigest: string;
	profileDigest: string;
	artifactDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	clientSessionId: string;
	trustedPrincipal: WorkflowTrustedPrincipal;
	responseSequence: number;
	optionId: string;
	decisionRoles: WorkflowApprovalDecisionRoles;
	effectDigest: string;
	mode: "interactive_secret" | "signed_headless";
	responseDigest: string;
	consumedAt: string;
	consumptionEventSequence: number;
	trustedClockReceipt: WorkflowVerifiedHostReceipt;
}

export interface WorkflowApprovalConsumptionResult {
	status: "consumed" | "already_consumed";
	receipt: WorkflowApprovalReceipt;
}

export interface WorkflowOpaquePostCommitExtension {
	/** C-owned namespace; K treats this as opaque and never authorizes it. */
	readonly namespace: string;
	readonly digest: string;
	readonly opaqueBytes: Readonly<Uint8Array>;
}

export interface WorkflowKnowledgeCommitRef {
	knowledgeStoreId: string;
	workflowEpochRef: WorkflowEpochRef;
	knowledgeStoreEpoch: number;
	proposalId: string;
	decisionRef: DurableDecisionRef;
	knowledgeJournalSequence: number;
	knowledgeJournalDigest: string;
	transactionDigest: string;
}

export interface WorkflowSpecializationProjection {
	kind: "native_methodology" | "autoresearch";
	contractVersion: string;
	phaseTag: string;
	statusTag?: string;
	sourceJournalSequence: number;
	sourceJournalDigest: string;
	payloadRef: WorkflowArtifactRef;
}

export interface WorkflowSpecializationProjectionWrapper<TPayload> {
	base: WorkflowSpecializationProjection;
	extension: TPayload;
}

export type ResourceVector = WorkflowResourceVector;
export type ResourceLeaseRef = Pick<
	WorkflowResourceLease,
	"leaseId" | "status" | "storeEpoch" | "coordinatorEpoch" | "acquisitionEventSequence" | "expiresAt"
>;
export type OwnershipLeaseRef = Pick<
	WorkflowOwnershipLease,
	"leaseId" | "status" | "storeEpoch" | "coordinatorEpoch" | "acquisitionEventSequence"
>;

export interface WorkflowProposal<TKind extends DurableDecisionKind, TPayload> {
	decision: WorkflowDecisionRecord;
	kind: TKind;
	payload: TPayload;
	proposalDigest: string;
}

export type WorkflowProposalRecord =
	| WorkflowProposal<"goal_contract", WorkflowGoalContract>
	| WorkflowProposal<"scorecard", WorkflowScorecard>
	| WorkflowProposal<"resource_envelope", WorkflowResourceEnvelope>
	| WorkflowProposal<"plan", readonly WorkflowTask[]>
	| WorkflowProposal<"recovery", WorkflowReconciliationOutcome>;

export interface WorkflowReconciliationProposal {
	outcome: WorkflowReconciliationOutcome;
	decisionRef: DurableDecisionRef;
}

export type WorkflowRevisionRegistryStatus = "approved" | "superseded" | "revoked";

export interface WorkflowRevisionCompatibilityClosure {
	compatibleRevisionDigests: readonly string[];
	incompatibleRevisionDigests: readonly string[];
	requiredHostContractDigests: readonly string[];
	closureDigest: string;
}

export interface WorkflowRevisionScopeBindingBase {
	scope: WorkflowRevisionScope;
}

export type WorkflowRevisionScopeBinding =
	| (WorkflowRevisionScopeBindingBase & { scope: "session"; sessionId: string })
	| (WorkflowRevisionScopeBindingBase & { scope: "workflow"; workflowId: string })
	| (WorkflowRevisionScopeBindingBase & { scope: "knowledge"; knowledgeScope: "session"; sessionId: string })
	| (WorkflowRevisionScopeBindingBase & { scope: "knowledge"; knowledgeScope: "workflow"; workflowId: string })
	| (WorkflowRevisionScopeBindingBase & { scope: "workspace" })
	| (WorkflowRevisionScopeBindingBase & { scope: "user" })
	| (WorkflowRevisionScopeBindingBase & { scope: "global" });

export interface WorkflowRevisionRegistryEntryBase {
	registryEntryId: string;
	revisionId: string;
	revisionDigest: string;
	pinnedArtifactRefs: readonly WorkflowArtifactRef[];
	compatibilityClosure: WorkflowRevisionCompatibilityClosure;
	status: WorkflowRevisionRegistryStatus;
	approvedDecisionRef: WorkflowDecisionRef;
	supersededByRevisionId: string | null;
	revocationEpoch: number | null;
	revocationEventSequence: number | null;
	rollbackOfRevisionId: string | null;
	rollbackEventSequence: number | null;
	rollbackCasExecutionKey: string | null;
	registryEpoch: number;
	registryCasExecutionKey: string;
	entryDigest: string;
}

export type WorkflowRevisionRegistryEntry =
	| (WorkflowRevisionRegistryEntryBase & {
			revisionKind: "knowledge";
			scope: "knowledge";
			scopeBinding: Extract<WorkflowRevisionScopeBinding, { scope: "knowledge" }>;
	  })
	| (WorkflowRevisionRegistryEntryBase & {
			revisionKind: Exclude<"workflow" | "methodology" | "policy" | "evaluator" | "knowledge", "knowledge">;
			scope: Exclude<WorkflowRevisionScope, "knowledge">;
			scopeBinding: Exclude<WorkflowRevisionScopeBinding, { scope: "knowledge" }>;
	  });

export interface WorkflowRevisionRegistryState {
	registryEpoch: number;
	entries: readonly WorkflowRevisionRegistryEntry[];
	stateDigest: string;
}

export interface WorkflowRevisionResolution {
	registryEntryRef: WorkflowArtifactRef;
	registryEntryId: string;
	registryEpoch: number;
	revisionKind: WorkflowRevisionRegistryEntry["revisionKind"];
	scope: WorkflowRevisionScope;
	scopeBinding: WorkflowRevisionScopeBinding;
	registryStatus: "approved";
	compatibilityClosureDigest: string;
	expectedRegistryEpoch: number;
	observedRegistryEpoch: number;
	revocationEpoch: number | null;
	revocationEventSequence: number | null;
	rollbackOfRevisionId: string | null;
	rollbackEventSequence: number | null;
	casExecutionKey: string;
	hostReceipt: WorkflowVerifiedHostReceipt;
	resolutionDigest: string;
}

export type WorkflowImprovementOwner = "policy" | "native" | "autoresearch" | "knowledge";
export type WorkflowImprovementCaseKind = "baseline" | "same_case" | "held_out" | "replay" | "canary";

export interface WorkflowImprovementCaseManifestBase {
	manifestId: string;
	kind: WorkflowImprovementCaseKind;
	sourceArtifactRefs: readonly WorkflowArtifactRef[];
	inputDigest: string;
	hidden: boolean;
	requiredSampleSize: number;
	effectThreshold: number;
	tolerance: number;
	nonRegressionPredicateRefs: readonly WorkflowArtifactRef[];
	maxCostMicrounits: number;
	maxLatencyMilliseconds: number;
	manifestDigest: string;
}

export type WorkflowImprovementCaseManifest =
	| (WorkflowImprovementCaseManifestBase & {
			kind: "baseline" | "same_case" | "replay" | "canary";
			hidden: false;
			heldOutInputDigest?: never;
	  })
	| (WorkflowImprovementCaseManifestBase & { kind: "held_out"; hidden: true; heldOutInputDigest: string });

export type WorkflowImprovementMetricDirection = "maximize" | "minimize" | "target";
export type WorkflowImprovementAggregation = "exact" | "mean" | "median";
export type WorkflowImprovementRiskClassification = "routine" | "risk_relevant";

export interface WorkflowImprovementEvaluatorContract {
	evaluatorRef: WorkflowArtifactRef;
	parserRef: WorkflowArtifactRef;
	owner: "host";
	metricDirection: WorkflowImprovementMetricDirection;
	targetValue: number | null;
	aggregation: WorkflowImprovementAggregation;
	repeatabilityRuns: number;
	varianceBound: number;
	deterministicRiskClassifierRef: WorkflowArtifactRef;
	riskClassification: WorkflowImprovementRiskClassification;
	holdoutCommitmentRefs: readonly WorkflowArtifactRef[];
	evaluatorDigest: string;
	parserDigest: string;
	contractDigest: string;
}

export interface WorkflowImprovementScorecard {
	scorecardId: string;
	revision: number;
	owner: "host";
	riskRelevantChange: boolean;
	caseManifestRefs: readonly WorkflowArtifactRef[];
	mandatoryHiddenHoldout: boolean;
	hiddenHoldoutManifestRefs: readonly WorkflowArtifactRef[];
	requiredSampleSizes: Readonly<Record<string, number>>;
	effectThreshold: number;
	tolerance: number;
	nonRegressionPredicateRefs: readonly WorkflowArtifactRef[];
	maxCostMicrounits: number;
	maxLatencyMilliseconds: number;
	proposerMayChooseOrOmitHoldouts: false;
	evaluatorContract: WorkflowImprovementEvaluatorContract;
	metricDirection: WorkflowImprovementMetricDirection;
	targetValue: number | null;
	aggregation: WorkflowImprovementAggregation;
	repeatabilityRuns: number;
	varianceBound: number;
	riskClassification: WorkflowImprovementRiskClassification;
	holdoutCommitmentRefs: readonly WorkflowArtifactRef[];
	decisionRef: WorkflowDecisionRef;
	scorecardDigest: string;
}

export interface WorkflowImprovementReviewBudget {
	observationQueuePolicy: "latest_wins";
	maxPendingReviews: 1;
	maxActiveReviews: 1;
	supersededCancellation: "required";
	dutyCycleCapPermille: number;
	maxReviewsPerWindow: number;
	maxReviewsPerPhase: number;
	maxReviewsPerWorkflow: number;
	reviewResourceAdmission: WorkflowResourceAdmission;
	dedicatedReviewReserve: WorkflowResourceVector;
	plannerVerifierReserve: WorkflowResourceVector;
	dedicatedReviewReserveLedgerRefs: readonly WorkflowArtifactRef[];
	plannerVerifierReserveLedgerRefs: readonly WorkflowArtifactRef[];
	reserveVectorsAreLedgerProjections: true;
	budgetDigest: string;
}

export type WorkflowImprovementProducer = "durable" | "native" | "autoresearch" | "knowledge";
export type WorkflowImprovementProposalStatus =
	| "queued"
	| "reviewing"
	| "proposed"
	| "rejected"
	| "approved"
	| "rolled_back"
	| "superseded";

export type WorkflowImprovementEventKind =
	| "proposal_queued"
	| "review_started"
	| "review_superseded"
	| "review_completed"
	| "result_promoted"
	| "result_rejected"
	| "result_rolled_back"
	| "result_fenced";

export interface WorkflowImprovementEvent {
	eventSequence: number;
	kind: WorkflowImprovementEventKind;
	proposalRef: WorkflowArtifactRef;
	reviewRef: WorkflowArtifactRef | null;
	resultRef: WorkflowArtifactRef | null;
	queueState: "pending" | "active" | "superseded" | "cancelled";
	crashFenceState: "none" | "prepared" | "fenced" | "reconciled";
	registryEpoch: number;
	eventDigest: string;
}

export type WorkflowAdaptiveBottleneckPool =
	| "dependency"
	| "ownership"
	| "authority"
	| "cpu"
	| "memory"
	| "disk"
	| "io"
	| "accelerator"
	| "provider"
	| "network"
	| "wall_time"
	| "monetary"
	| "control_plane"
	| "evidence"
	| "uncertain";
export type WorkflowAdaptiveObjectiveOrder = readonly [
	"time_to_genuine_proof",
	"evidence_gap",
	"cost",
	"uncertainty",
	"queue_age",
	"task_id",
];

export interface WorkflowRemainingWorkEstimate {
	taskId: string;
	requirementIds: readonly string[];
	acceptedDagDigest: string;
	remainingWorkMilliseconds: number;
	remainingWorkVector: WorkflowResourceVector;
	evidenceGapDigest: string;
	evidenceGapRequirementIds: readonly string[];
	uncertainty: number;
	queueAgeMilliseconds: number;
	hostObservationRef: WorkflowArtifactRef;
	observedAt: string;
	estimateSequence: number;
	estimateDigest: string;
}

export interface WorkflowObservedTaskNovelty {
	taskId: string;
	candidateDigest: string;
	priorCandidateDigestRefs: readonly WorkflowArtifactRef[];
	duplicate: boolean;
	hostObservationRef: WorkflowArtifactRef;
	proofDigest: string;
}

export interface WorkflowBoundedOutcomeEvidence {
	taskId: string;
	observableOutcomeRef: WorkflowArtifactRef;
	boundedOutcomeDescription: string;
	expectedEvidenceRefs: readonly WorkflowArtifactRef[];
	maximumWorkMilliseconds: number;
	maximumCostMicrounits: number;
	outcomeDigest: string;
}

export interface WorkflowAdaptiveFairnessPolicy {
	priorityBucketOrder: readonly string[];
	promotionEnabled: boolean;
	agingQuantumMilliseconds: number;
	starvationDeadlineMilliseconds: number;
	maxAgingBoost: number;
	maxPromotionBuckets: number;
	maxPromotionsPerWindow: number;
	explorationQuotaPerWindow: number;
	policyDigest: string;
}

export interface WorkflowAdaptiveHysteresisPolicy {
	minimumWindowEvents: number;
	minimumWindowMilliseconds: number;
	benefitThreshold: number;
	minimumDwellMilliseconds: number;
	maxTransitionsPerWindow: number;
	policyDigest: string;
}

export interface WorkflowAdaptiveFairnessState {
	taskLastServedAt: Readonly<Record<string, string>>;
	priorityBucketByTask: Readonly<Record<string, string>>;
	promotionCountByWindow: Readonly<Record<string, number>>;
	policy: WorkflowAdaptiveFairnessPolicy;
	agingPolicyDigest: string;
	explorationQuotaRemaining: number;
	explorationQuotaWindow: number;
	lastServedTaskId: string | null;
	fairnessDigest: string;
}

export interface WorkflowAdaptiveReviewQueueState {
	pendingObservationRef: WorkflowArtifactRef | null;
	activeObservationRef: WorkflowArtifactRef | null;
	pendingReviewId: string | null;
	activeReviewId: string | null;
	activeFenceDigest: string | null;
	supersededObservationIds: readonly string[];
	cancellationDigest: string | null;
	staleResultDigest: string | null;
	recoveryDigest: string | null;
	lastResultDigest: string | null;
}

export interface WorkflowAdaptiveObservation {
	observationId: string;
	sourceEventSequence: number;
	sourceJournalDigest: string;
	workflowId: string;
	headDigest: string;
	acceptedDagRef: WorkflowArtifactRef;
	configDigest: string;
	evaluatorDigest: string;
	leaseStateDigest: string;
	goalContractDigest: string;
	scorecardDigest: string;
	revisionRegistryDigest: string;
	workspaceDigest: string;
	criticalPathCertificateRef: WorkflowArtifactRef;
	remainingWorkEstimates: readonly WorkflowRemainingWorkEstimate[];
	hostObservedNoveltyProofRefs: readonly WorkflowArtifactRef[];
	taskValueCertificateRefs: readonly WorkflowArtifactRef[];
	independentCertificateAdmissionRef: WorkflowArtifactRef;
	criticalPathTaskIds: readonly string[];
	readyQueueTaskIds: readonly string[];
	evidenceGapRequirementIds: readonly string[];
	blockerIds: readonly string[];
	throughputEvidenceRefs: readonly WorkflowArtifactRef[];
	latencyEvidenceRefs: readonly WorkflowArtifactRef[];
	marginalVerifiedProgressEvidenceRefs: readonly WorkflowArtifactRef[];
	uncertaintyEvidenceRefs: readonly WorkflowArtifactRef[];
	liveResourceLeaseRefs: readonly WorkflowLeaseRef[];
	liveOwnershipLeaseRefs: readonly WorkflowLeaseRef[];
	controlPlaneReserve: WorkflowResourceVector;
	controlPlaneReserveCapacity: WorkflowControlCapacityVector;
	observedCapacity: WorkflowResourceVector;
	observedControlCapacity: WorkflowControlCapacityVector;
	authenticatedCapacitySnapshotRefs: WorkflowAuthenticatedCapacitySnapshotRefs;
	limitingPool: WorkflowAdaptiveBottleneckPool;
	monotonicObservation: WorkflowMonotonicClockObservation;
	observedAt: string;
	hostObservationReceipt: WorkflowVerifiedHostReceipt;
	observationDigest: string;
}

export interface WorkflowAdaptiveAllocationEntry {
	allocationDigest: string;
	taskId: string;
	attemptId: string;
	resourceLeaseRef: WorkflowLeaseRef;
	ownershipLeaseRef: WorkflowLeaseRef;
	slotState: "unclaimed" | "claimed" | "active";
	capacityGrant: WorkflowCapacityGrant;
	controlCapacity: WorkflowControlCapacityVector;
	controlCapacityProjectionDigest: string;
	attemptClass: "implementation" | "recon" | "lens" | "verification" | "red_team" | "recovery";
	resourceAdmission: WorkflowResourceAdmission;
	taskValueCertificate: WorkflowTaskValueCertificate;
	reason: WorkflowAdaptiveBottleneckPool;
	sourceObservationDigest: string;
}

export interface WorkflowAdaptiveAllocationPreimage {
	workflowId: string;
	taskId: string;
	attemptId: string;
	resourceLeaseRef: WorkflowLeaseRef;
	ownershipLeaseRef: WorkflowLeaseRef;
	capacityGrant: WorkflowCapacityGrant;
	controlCapacity: WorkflowControlCapacityVector;
	controlCapacityProjectionDigest: string;
	attemptClass: WorkflowAdaptiveAllocationEntry["attemptClass"];
	resourceAdmission: WorkflowResourceAdmission;
	taskValueCertificate: WorkflowTaskValueCertificate;
	reason: WorkflowAdaptiveBottleneckPool;
	sourceObservationDigest: string;
	certificate: WorkflowCriticalPathCertificate;
	valueCertificates: readonly WorkflowTaskValueCertificate[];
	ledgerHeadDigest: string;
	idempotencyKey: string;
	epochRef: WorkflowEpochRef;
	priorStateDigest: string;
	decisionRef: WorkflowDecisionRef;
}

export interface WorkflowAdaptiveNonExecutionProof {
	allocationDigest: string;
	stateDigest: string;
	nonExecutionReceipt: WorkflowVerifiedHostReceipt;
	reconciledLedger: WorkflowResourceGrantLedger;
	restoredState: WorkflowAdaptiveAllocationState;
	proofDigest: string;
}

export interface WorkflowAdaptiveAppliedEffect {
	allocationDigest: string;
	allocationEntry: WorkflowAdaptiveAllocationEntry;
	ledger: WorkflowResourceGrantLedger;
	effectReceipt: WorkflowVerifiedHostReceipt;
	lastSafeAllocationTupleRef: WorkflowArtifactRef;
	effectDigest: string;
}

export interface WorkflowAdaptiveAllocationState {
	allocationRevision: number;
	acceptedObservation: WorkflowArtifactRef;
	allocationEntries: readonly WorkflowAdaptiveAllocationEntry[];
	limitingPool: WorkflowAdaptiveBottleneckPool;
	fairness: WorkflowAdaptiveFairnessState;
	reviewQueueState: WorkflowAdaptiveReviewQueueState;
	hysteresisPolicy: WorkflowAdaptiveHysteresisPolicy;
	minimumWindowEvents: number;
	minimumWindowMilliseconds: number;
	benefitMetricDigest: string;
	benefitThreshold: number;
	minimumDwellMilliseconds: number;
	maxTransitionsPerWindow: number;
	transitionsInWindow: number;
	lastDecisionRef: WorkflowDecisionRef | null;
	safetyOverride: "none" | "active";
	cooldownUntil: string | null;
	cooldownMonotonicMilliseconds: number | null;
	rollbackAllocationRef: WorkflowArtifactRef | null;
	allocationStatus: "stable" | "rebalancing" | "awaiting_user" | "quarantined";
	allocationDigest: string;
	workflowId: string;
	revision: number;
	currentEpoch: WorkflowEpochRef;
	stateDigest: string;
	criticalPathTaskIds: readonly string[];
	readyQueue: readonly string[];
	runningQueue: readonly string[];
	evidenceGaps: readonly string[];
	blockers: readonly string[];
	throughputPerMinute: number;
	latencyMilliseconds: number;
	marginalVerifiedProgressByResource: Readonly<Record<string, number>>;
	uncertainty: Readonly<Record<string, number>>;
	criticalPathCertificateRef: WorkflowArtifactRef;
	criticalPathProofDigest: string;
	controlPlaneReserve: WorkflowResourceVector;
	controlCapacity: WorkflowControlCapacityVector;
	workerCapacity: WorkflowControlCapacityVector;
	activeLocalLeases: readonly WorkflowLeaseRef[];
	activeCloudLeases: readonly WorkflowLeaseRef[];
	policyRevision: number;
	policyDigest: string;
	monotonicObservation: WorkflowMonotonicClockObservation;
	observedAt: string;
	observationWindowMilliseconds: number;
	minimumObservationWindowMilliseconds: number;
	executionCeilings: WorkflowExecutionCeilings;
	rollbackState: "none" | "pending" | "applied" | "quarantined";
	hysteresisThreshold: number;
	hysteresisDwellMilliseconds: number;
	maxHysteresisTransitions: number;
	fairnessAgingMilliseconds: number;
	fairnessDebtByTask: Readonly<Record<string, number>>;
	explorationQuota: number;
	hysteresisRevision: number;
	lastAllocationDigest: string | null;
	acceptedObservationDigest: string | null;
	acceptedAllocationEntries: readonly WorkflowAdaptiveAllocationEntry[];
	lastSafeAllocationDigest: string | null;
	lastSafeAllocationTupleDigest: string | null;
	lastSafeLedgerHeadDigest: string | null;
	lastSafeLeaseTupleDigest: string | null;
	reviewQueue: readonly string[];
	sourceJournalSequence: number;
	sourceJournalDigest: string;
	capacityBindingRefs: readonly WorkflowArtifactRef[];
	pendingObservationDigest: string | null;
	supersededObservationDigests: readonly string[];
	staleObservationDigests: readonly string[];
	cancellationDigest: string | null;
	controllerRecoveryDigest: string | null;
}

export interface WorkflowAdaptiveAllocationObservation {
	exactObservation: WorkflowAdaptiveObservation;
	workflowId: string;
	observedState: WorkflowAdaptiveAllocationState;
	hostStateDigest: string;
	currentHeadDigest: string;
	currentEpoch: WorkflowEpochRef;
	hostObservedAt: string;
	verifiedEvidenceRefs: readonly WorkflowArtifactRef[];
	acceptedDagDigest: string;
	evidenceGapRefs: readonly WorkflowArtifactRef[];
	criticalPathCertificate: WorkflowCriticalPathCertificate;
	taskValueCertificates: readonly WorkflowTaskValueCertificate[];
	policyRevision: number;
	policyDigest: string;
	resourceEnvelopeDigest: string;
	canonicalLedgerDigest: string;
	controlCapacity: WorkflowControlCapacityVector;
	workerCapacity: WorkflowControlCapacityVector;
	activeLocalLeases: readonly WorkflowLeaseRef[];
	activeCloudLeases: readonly WorkflowLeaseRef[];
	capacityBindingRefs: readonly WorkflowArtifactRef[];
	sourceJournalSequence: number;
	sourceJournalDigest: string;
	supersededObservationDigest: string | null;
	observationDigest: string;
}

export interface WorkflowMonotonicClockObservation {
	clockSourceDigest: string;
	observedAt: string;
	monotonicMilliseconds: number;
	observationSequence: number;
	previousObservationSequence: number | null;
	previousMonotonicMilliseconds: number | null;
	observationDigest: string;
}

export interface WorkflowCriticalPathCertificate {
	planRevision: number;
	taskGraphDigest: string;
	acceptedDagRef: WorkflowArtifactRef;
	remainingWorkEstimates: readonly WorkflowRemainingWorkEstimate[];
	hostObservedNoveltyProofRefs: readonly WorkflowArtifactRef[];
	independentAdmissionRef: WorkflowArtifactRef;
	independentCertificateAdmission: true;
	independentAdmissionStatus: "accepted";
	schedulerPolicyDigest: string;
	acceptedRequirementIds: readonly string[];
	unprovenRequirementIds: readonly string[];
	criticalPathTaskIds: readonly string[];
	objectiveOrder: WorkflowAdaptiveObjectiveOrder;
	proofDigest: string;
	certificateId: string;
	workflowId: string;
	acceptedDagDigest: string;
	remainingWorkDigest: string;
	evidenceDigest: string;
	policyRevision: number;
	policyDigest: string;
	orderedTaskIds: readonly string[];
	genuineProofTimeMilliseconds: number;
	evidenceGapDigest: string;
	costMicrounits: number;
	uncertainty: number;
	queueAgeMilliseconds: number;
	typedDagDigest: string;
	evidenceGapProofDigest: string;
	leaseProofDigest: string;
	admissionProofDigest: string;
	independentAuditReceipt: WorkflowVerifiedHostReceipt;
	certificateDigest: string;
}

export interface WorkflowTaskValueCertificate {
	requirementIds: readonly string[];
	evidenceGapRequirementIds: readonly string[];
	acceptedDagRef: WorkflowArtifactRef;
	hostObservedNoveltyProof: WorkflowObservedTaskNovelty;
	boundedOutcomeEvidence: WorkflowBoundedOutcomeEvidence;
	explorationQuota: number;
	independentAdmissionRef: WorkflowArtifactRef;
	independentAdmissionStatus: "accepted";
	valuePolicyDigest: string;
	certificateId: string;
	workflowId: string;
	taskId: string;
	attemptId: string;
	unprovenRequirementId: string;
	evidenceGapDigest: string;
	noveltyDigest: string;
	boundedOutcomeDigest: string;
	explorationQuotaBefore: number;
	explorationQuotaAfter: number;
	policyDigest: string;
	evidenceGapProofDigest: string;
	typedDagDigest: string;
	leaseProofDigest: string;
	leaseRefs: readonly WorkflowLeaseRef[];
	admissionProofDigest: string;
	independentAuditReceipt: WorkflowVerifiedHostReceipt;
	certificateDigest: string;
}

export interface WorkflowAdaptiveAllocationController {
	observe(): Promise<WorkflowAdaptiveAllocationObservation>;
	reconcile(observation: WorkflowAdaptiveAllocationObservation): Promise<WorkflowAdaptiveAllocationObservation>;
	runReconLensVerifySynthesizeRedTeam(
		observation: WorkflowAdaptiveAllocationObservation,
	): Promise<WorkflowArtifactRef[]>;
	reserveOrReallocate(input: {
		observation: WorkflowAdaptiveAllocationObservation;
		evidenceRefs: readonly WorkflowArtifactRef[];
		expectedStateDigest: string;
	}): Promise<WorkflowAdaptiveAllocationState>;
	measure(input: {
		prior: WorkflowAdaptiveAllocationState;
		expectedStateDigest: string;
	}): Promise<WorkflowAdaptiveAllocationState>;
	rollback(input: {
		prior: WorkflowAdaptiveAllocationState;
		expectedStateDigest: string;
	}): Promise<WorkflowAdaptiveAllocationState>;
	runFiniteCycles(input: {
		maxCycles: number;
		expectedStateDigest: string;
	}): Promise<{ state: WorkflowAdaptiveAllocationState; cycles: number; complete: boolean }>;
}

export interface WorkflowAdaptiveAllocationHost {
	currentState(): Promise<{
		headDigest: string;
		workspaceDigest: string;
		configDigest: string;
		evaluatorDigest: string;
		leaseStateDigest: string;
		trustedNow: string;
		monotonicObservation: WorkflowMonotonicClockObservation;
	}>;
	observe(): Promise<WorkflowAdaptiveAllocationObservation>;
	reconcile(observation: WorkflowAdaptiveAllocationObservation): Promise<WorkflowAdaptiveAllocationObservation>;
	review(observation: WorkflowAdaptiveAllocationObservation): Promise<readonly WorkflowArtifactRef[]>;
	reserveOrReallocate(input: {
		observation: WorkflowAdaptiveAllocationObservation;
		evidenceRefs: readonly WorkflowArtifactRef[];
	}): Promise<{
		allocationDigest: string;
		certificate: WorkflowCriticalPathCertificate;
		valueCertificates: readonly WorkflowTaskValueCertificate[];
		allocationEntry: WorkflowAdaptiveAllocationEntry;
		ledgerHeadDigest: string;
		leaseRef: WorkflowLeaseRef;
		decisionRef: WorkflowDecisionRef;
		decisionReceipt: WorkflowVerifiedHostReceipt;
	}>;
	apply(input: {
		allocationDigest: string;
		preimage: WorkflowAdaptiveAllocationPreimage;
		observation: WorkflowAdaptiveAllocationObservation;
		leaseRef: WorkflowLeaseRef;
	}): Promise<WorkflowAdaptiveAppliedEffect>;
	proveNonExecution(input: {
		allocationDigest: string;
		observation: WorkflowAdaptiveAllocationObservation;
		leaseRef: WorkflowLeaseRef;
	}): Promise<WorkflowAdaptiveNonExecutionProof>;
	measure(prior: WorkflowAdaptiveAllocationState): Promise<WorkflowAdaptiveAllocationState>;
	rollback(prior: WorkflowAdaptiveAllocationState): Promise<WorkflowAdaptiveAllocationState>;
}

export interface WorkflowAdaptiveAllocationStore {
	read(workflowId: string): Promise<WorkflowAdaptiveAllocationState>;
	recordObservation(input: {
		workflowId: string;
		expectedStateDigest: string;
		observation: WorkflowAdaptiveAllocationObservation;
		supersededObservationDigest: string | null;
		receiptContext: WorkflowHostReceiptConsumerContext;
		currentHeadDigest: string;
		currentWorkspaceDigest: string;
		currentConfigDigest: string;
		currentEvaluatorDigest: string;
		currentLeaseStateDigest: string;
		trustedNow: string;
	}): Promise<WorkflowAdaptiveAllocationState>;
	markObservationStale(input: {
		workflowId: string;
		expectedStateDigest: string;
		observationDigest: string;
		reasonDigest: string;
	}): Promise<WorkflowAdaptiveAllocationState>;
	cancelObservation(input: {
		workflowId: string;
		expectedStateDigest: string;
		observationDigest: string;
		reasonDigest: string;
	}): Promise<WorkflowAdaptiveAllocationState>;
	controllerRecovered(input: {
		workflowId: string;
		expectedStateDigest: string;
		recoveryDigest: string;
	}): Promise<WorkflowAdaptiveAllocationState>;
	beginReview(input: {
		workflowId: string;
		expectedStateDigest: string;
		observationDigest: string;
		reviewId: string;
		epochRef: WorkflowEpochRef;
	}): Promise<WorkflowAdaptiveAllocationState>;
	completeReview(input: {
		workflowId: string;
		expectedStateDigest: string;
		observationDigest: string;
		reviewId: string;
		evidenceRefs: readonly WorkflowArtifactRef[];
		resultDigest: string;
		epochRef: WorkflowEpochRef;
	}): Promise<WorkflowAdaptiveAllocationState>;
	cancelReview(input: {
		workflowId: string;
		expectedStateDigest: string;
		observationDigest: string;
		reviewId: string;
		reasonDigest: string;
		epochRef: WorkflowEpochRef;
	}): Promise<WorkflowAdaptiveAllocationState>;
	fenceReview(input: {
		workflowId: string;
		expectedStateDigest: string;
		observationDigest: string;
		reviewId: string;
		fenceDigest: string;
		epochRef: WorkflowEpochRef;
	}): Promise<WorkflowAdaptiveAllocationState>;
	recoverReview(input: {
		workflowId: string;
		expectedStateDigest: string;
		observationDigest: string;
		reviewId: string;
		recoveryDigest: string;
		epochRef: WorkflowEpochRef;
	}): Promise<WorkflowAdaptiveAllocationState>;
	staleReviewResult(input: {
		workflowId: string;
		expectedStateDigest: string;
		observationDigest: string;
		reviewId: string;
		resultDigest: string;
		epochRef: WorkflowEpochRef;
	}): Promise<WorkflowAdaptiveAllocationState>;
	intent(input: {
		workflowId: string;
		expectedStateDigest: string;
		certificate: WorkflowCriticalPathCertificate;
		valueCertificates: readonly WorkflowTaskValueCertificate[];
		allocationEntry: WorkflowAdaptiveAllocationEntry;
		ledgerHeadDigest: string;
		leaseRef: WorkflowLeaseRef;
		epochRef: WorkflowEpochRef;
		decisionRef: WorkflowDecisionRef;
		decisionReceipt: WorkflowVerifiedHostReceipt;
		receiptContext: WorkflowHostReceiptConsumerContext;
	}): Promise<WorkflowAdaptiveAllocationState>;
	applied(input: {
		workflowId: string;
		expectedStateDigest: string;
		appliedEffect: WorkflowAdaptiveAppliedEffect;
		epochRef: WorkflowEpochRef;
		receiptContext: WorkflowHostReceiptConsumerContext;
		currentRevision: number;
		trustedNow: string;
	}): Promise<WorkflowAdaptiveAllocationState>;
	uncertain(input: {
		workflowId: string;
		expectedStateDigest: string;
		allocationDigest: string;
		epochRef: WorkflowEpochRef;
		reason: "crash_before_effect" | "provider_unknown" | "release_unknown";
	}): Promise<WorkflowAdaptiveAllocationState>;
	reconciled(input: {
		workflowId: string;
		expectedStateDigest: string;
		allocationDigest: string;
		epochRef: WorkflowEpochRef;
		nonExecutionReceipt: WorkflowVerifiedHostReceipt;
		ledger: WorkflowResourceGrantLedger;
		restoredState: WorkflowAdaptiveAllocationState;
		receiptContext: WorkflowHostReceiptConsumerContext;
	}): Promise<WorkflowAdaptiveAllocationState>;
	measured(input: {
		workflowId: string;
		expectedStateDigest: string;
		epochRef: WorkflowEpochRef;
		state: WorkflowAdaptiveAllocationState;
	}): Promise<WorkflowAdaptiveAllocationState>;
	rollback(input: {
		workflowId: string;
		expectedStateDigest: string;
		epochRef: WorkflowEpochRef;
		priorAllocationDigest: string;
		state: WorkflowAdaptiveAllocationState;
	}): Promise<WorkflowAdaptiveAllocationState>;
	replay(workflowId: string): Promise<readonly WorkflowAdaptiveAllocationEvent[]>;
}

export interface WorkflowImprovementProposal {
	proposalId: string;
	workflowId: string;
	owner: WorkflowImprovementOwner;
	scope: WorkflowRevisionScopeRecord;
	sourcePhaseOrIncident: string;
	baselineRevision: number;
	baselineDigest: string;
	candidateDigest: string;
	caseManifestDigest: string;
	baselineArtifactRef: WorkflowArtifactRef;
	candidateArtifactRef: WorkflowArtifactRef;
	trialMode: "shadow" | "canary" | "replay";
	sampleSize: number;
	minimumEffectSize: number;
	tolerance: number;
	hostAcceptedEvidenceRefs: readonly WorkflowArtifactRef[];
	fixedEvaluatorDigest: string;
	preregisteredManifestDigest: string;
	hiddenHoldoutDigest: string;
	safetyInvariantDigest: string;
	costCeilingMicrounits: number;
	antiGoodhartReceipt: WorkflowVerifiedHostReceipt;
	queuedAt: string;
	proposalEpoch: WorkflowEpochRef;
	hiddenHoldoutManifestRef: WorkflowArtifactRef;
	registryEpoch: number;
	registryResolutionReceipt: WorkflowVerifiedHostReceipt;
	revisionResolution: WorkflowRevisionResolution;
	baselineBytesDigest: string;
	candidateBytesDigest: string;
	proposalDigest: string;
	producer: WorkflowImprovementProducer;
	kind: "workflow" | "methodology" | "policy" | "evaluator" | "knowledge";
	baselineRevisionId: string;
	baselineRevisionDigest: string;
	candidateRef: WorkflowArtifactRef;
	scorecardRef: WorkflowArtifactRef;
	scorecardDigest: string;
	evaluatorRef: WorkflowArtifactRef;
	parserRef: WorkflowArtifactRef;
	baselineEvidenceRefs: readonly WorkflowArtifactRef[];
	candidateEvidenceRefs: readonly WorkflowArtifactRef[];
	queueState: "pending" | "active" | "superseded" | "cancelled";
	queueRevision: number;
	attemptId: string | null;
	reviewLeaseRef: WorkflowLeaseRef | null;
	ownershipLeaseRef: WorkflowLeaseRef | null;
	epochRef: WorkflowEpochRef;
	executionKey: string;
	status: WorkflowImprovementProposalStatus;
	caseManifest: WorkflowImprovementCaseManifest;
	scorecard: WorkflowImprovementScorecard;
	evaluatorContract: WorkflowImprovementEvaluatorContract;
	reviewBudget: WorkflowImprovementReviewBudget;
}

export interface WorkflowImprovementReviewResult {
	workflowId: string;
	proposalId: string;
	trialId: string;
	owner: WorkflowImprovementOwner;
	baselineDigest: string;
	candidateDigest: string;
	caseManifestDigest: string;
	baselineArtifactRef: WorkflowArtifactRef;
	candidateArtifactRef: WorkflowArtifactRef;
	trialMode: "shadow" | "canary" | "replay";
	sampleSize: number;
	effectSize: number;
	tolerance: number;
	metricDirection: WorkflowImprovementMetricDirection;
	aggregation: WorkflowImprovementAggregation;
	repeatabilityRuns: number;
	observedVariance: number;
	latencyMilliseconds: number;
	thresholdPassed: boolean;
	safetyReceipt: WorkflowVerifiedHostReceipt;
	scorecardDigest: string;
	hiddenHoldoutReceipt: WorkflowVerifiedHostReceipt;
	antiGoodhartReceipt: WorkflowVerifiedHostReceipt;
	nonRegressionReceipt: WorkflowVerifiedHostReceipt;
	costReceipt: WorkflowVerifiedHostReceipt;
	costMicrounits: number;
	nonRegressionPassed: boolean;
	goodhartPassed: boolean;
	safetyPassed: boolean;
	costWithinCeiling: boolean;
	registryEpoch: number;
	registryResolutionReceipt: WorkflowVerifiedHostReceipt;
	hiddenHoldoutManifestRef: WorkflowArtifactRef;
	baselineBytesDigest: string;
	candidateBytesDigest: string;
	futureLoadDigest: string;
	rollbackOf: string | null;
	decision: "promote" | "reject" | "rollback";
	resultDigest: string;
	resultId: string;
	proposalRef: WorkflowArtifactRef;
	reviewRef: WorkflowArtifactRef;
	disposition: "promoted" | "rejected" | "rolled_back" | "empty";
	registryStateRef: WorkflowArtifactRef;
	expectedRegistryEpoch: number;
	appliedRegistryEpoch: number | null;
	rollbackOfRevisionId: string | null;
	rollbackEventSequence: number | null;
	casExecutionKey: string;
	reloadVerificationRef: WorkflowArtifactRef;
	futureLoadVerificationRef: WorkflowArtifactRef;
	hostVerdictDigest: string;
	hiddenHoldoutCaseRef: WorkflowArtifactRef;
	baselineResolvedBytesRef: WorkflowArtifactRef;
	candidateResolvedBytesRef: WorkflowArtifactRef;
	heldOutSampleCount: number;
	nonRegressionThreshold: number;
	safetyPredicateDigest: string;
	goodhartPredicateDigest: string;
	costPredicateDigest: string;
}

export interface WorkflowPolicyRevision {
	workflowId: string | null;
	revision: number;
	policyDigest: string;
	approvedDecisionRef: WorkflowRevisionDecisionRef;
	approvalReceipt: WorkflowVerifiedHostReceipt;
	sourceProposalId: string;
	provenanceRefs: readonly WorkflowArtifactRef[];
	compatibilityDigest: string;
	scope: WorkflowRevisionScopeRecord;
	status: "approved" | "superseded" | "revoked";
	revocationEpoch: WorkflowEpochRef | null;
	revocationEventSequence: number | null;
	revisionCasDigest: string;
	activeWorkFenceDigest: string;
	fencedLeaseIds: readonly string[];
	fencedApprovalIds: readonly string[];
	fencedCacheDigests: readonly string[];
	priorApprovedRevision: number | null;
	priorApprovedPolicyDigest: string | null;
	priorApprovedPinnedArtifactRefs: readonly WorkflowArtifactRef[] | null;
	priorApprovedSourceProposalId: string | null;
	priorApprovedProvenanceRefs: readonly WorkflowArtifactRef[] | null;
	priorApprovedCompatibilityDigest: string | null;
	priorApprovedCompatibilityClosure: WorkflowRevisionCompatibilityClosure | null;
	priorApprovedApprovedDecisionRef: WorkflowRevisionDecisionRef | null;
	priorApprovedApprovalReceipt: WorkflowVerifiedHostReceipt | null;
	priorApprovedReloadVerificationRef: WorkflowArtifactRef | null;
	priorApprovedFutureLoadVerificationRef: WorkflowArtifactRef | null;
	priorApprovedRegistryEntryId: string | null;
	priorApprovedRevisionId: string | null;
	priorApprovedScopeBinding: WorkflowRevisionScopeBinding | null;
	restoredFromRevision: number | null;
	restoredPolicyDigest: string | null;
	reloadVerificationRef: WorkflowArtifactRef;
	futureLoadVerificationRef: WorkflowArtifactRef;
	registryEntryId: string;
	revisionId: string;
	pinnedArtifactRefs: readonly WorkflowArtifactRef[];
	compatibilityClosure: WorkflowRevisionCompatibilityClosure;
	supersededByRevisionId: string | null;
	rollbackOfRevisionId: string | null;
	rollbackEventSequence: number | null;
	rollbackCasExecutionKey: string | null;
	registryEpoch: number;
	registryEventSequence: number;
	registryCasExecutionKey: string;
	entryDigest: string;
	scopeBinding: WorkflowRevisionScopeBinding;
}

export type WorkflowEfficiencyReviewReservePartition = "planner" | "verifier" | "redTeam" | "recovery" | "control";

export type WorkflowEfficiencyReviewTrigger =
	| "scheduled_window"
	| "task_terminal"
	| "phase_transition"
	| "result_transition"
	| "lease_release"
	| "material_evidence_transition"
	| "incident"
	| "recovery_boundary"
	| "completion_gate";

export interface WorkflowEfficiencyReviewSchedule {
	workflowId: string;
	scheduleId: string;
	revision: number;
	epochRef: WorkflowEpochRef;
	nextDueAt: string;
	lastRunAt: string | null;
	minimumCadenceMilliseconds: number;
	maximumCadenceMilliseconds: number;
	overheadBudgetMicrounits: number;
	idempotencyWindowMilliseconds: number;
	dutyCycleCapMicrounits: number;
	perWindowOverheadCapMicrounits: number;
	perPhaseOverheadCapMicrounits: number;
	perWorkflowOverheadCapMicrounits: number;
	dedicatedControlReserve: WorkflowControlCapacityVector;
	approvedResourceEnvelopeDigest: string;
	trustedClockSourceRef: WorkflowArtifactRef;
	triggerSet: readonly WorkflowEfficiencyReviewTrigger[];
	approvedDecisionRef: WorkflowDecisionRef;
	approvalReceipt: WorkflowVerifiedHostReceipt;
	resourceEnvelopeRef: WorkflowArtifactRef;
	capacityRegistryRef: WorkflowArtifactRef;
	wallCeilingMilliseconds: number;
	tokenCeiling: number;
	costCeilingMicrounits: number;
	status: "scheduled" | "started" | "completed" | "skipped" | "recovered" | "failed" | "cancelled" | "fenced";
	trustedClockSourceDigest: string;
	clockObservationRef: WorkflowArtifactRef;
	lastAdmittedWindowSequence: number;
	lastAdmittedWindowId: string | null;
	cadenceMilliseconds: number;
	majorTransitionTriggers: readonly WorkflowEfficiencyReviewTrigger[];
	maxReviewsPerWindow: 1;
	maxReviewsPerPhase: number;
	maxReviewsPerWorkflow: number;
	dutyCycleCapPermille: number;
	overlapPolicy: "reject";
	catchUpAfterRestart: "one";
	reviewResourceAdmission: WorkflowResourceAdmission;
	maxReviewWallMilliseconds: number;
	maxReviewTokens: number;
	maxReviewCostMicrounits: number;
	scheduleBoundsDigest: string;
	scheduleDigest: string;
	reservePartitions: {
		planner: WorkflowControlCapacityVector;
		verifier: WorkflowControlCapacityVector;
		redTeam: WorkflowControlCapacityVector;
		recovery: WorkflowControlCapacityVector;
		control: WorkflowControlCapacityVector;
	};
	reserveLedgerRef: WorkflowArtifactRef;
	reserveLedgerDigest: string;
}

export interface WorkflowEfficiencyRedTeamSnapshot {
	workflowId: string;
	reviewId: string;
	scheduleId: string;
	windowId: string;
	sourceJournalSequence: number;
	sourceJournalDigest: string;
	workflowStateDigest: string;
	originalObjectiveRef: WorkflowArtifactRef;
	originalObjectiveDigest: string;
	hardenedGoalContractRef: WorkflowArtifactRef;
	hardenedGoalContractDigest: string;
	scorecardRef: WorkflowArtifactRef;
	scorecardDigest: string;
	protectedInvariantRefs: readonly WorkflowArtifactRef[];
	protectedInvariantDigest: string;
	planRef: WorkflowArtifactRef;
	planDigest: string;
	criticalPathCertificateRef: WorkflowArtifactRef;
	criticalPathCertificateDigest: string;
	configurationRef: WorkflowArtifactRef;
	configurationDigest: string;
	evaluatorRef: WorkflowArtifactRef;
	evaluatorDigest: string;
	guardRef: WorkflowArtifactRef | null;
	guardDigest: string | null;
	revisionRegistryRef: WorkflowArtifactRef;
	revisionRegistryDigest: string;
	snapshotRef: WorkflowArtifactRef;
	publicationEnvelopeRef: WorkflowArtifactRef;
	publicationEnvelopeDigest: string;
	hostDereferenceProofRef: WorkflowArtifactRef;
	staleRejectionPolicyDigest: string;
	criticalPathTaskIds: readonly string[];
	readyQueueTaskIds: readonly string[];
	liveResourceLeaseRefs: readonly WorkflowLeaseRef[];
	liveOwnershipLeaseRefs: readonly WorkflowLeaseRef[];
	costEvidenceRefs: readonly WorkflowArtifactRef[];
	throughputEvidenceRefs: readonly WorkflowArtifactRef[];
	latencyEvidenceRefs: readonly WorkflowArtifactRef[];
	acceptedProgressEvidenceRefs: readonly WorkflowArtifactRef[];
	evidenceGapRefs: readonly WorkflowArtifactRef[];
	uncertaintyEvidenceRefs: readonly WorkflowArtifactRef[];
	controlPlaneReserve: WorkflowResourceVector;
	controlPlaneReserveCapacity: WorkflowControlCapacityVector;
	canonicalPoolLedgerRef: WorkflowArtifactRef;
	canonicalPoolLedgerDigest: string;
	authenticatedCapacitySnapshotRefs: WorkflowAuthenticatedCapacitySnapshotRefs;
	envelopeDigest: string;
	snapshotDigest: string;
}

export interface WorkflowEfficiencyRedTeamInvocation {
	reviewId: string;
	snapshotRef: WorkflowArtifactRef;
	reviewerChildIdentity: WorkflowChildIdentity;
	readOnlyCapabilityProofRef: WorkflowArtifactRef;
	admissionRef: WorkflowArtifactRef;
	resourceLeaseRef: WorkflowLeaseRef;
	ownershipLeaseRef: WorkflowLeaseRef;
	epochRef: WorkflowEpochRef;
	windowSequence: number;
	executionKey: string;
	casExecutionKey: string;
	invocationTokenDigest: string;
	startedAt: string;
	actualUsage: WorkflowResourceVector;
	status: "prepared" | "started" | "completed" | "failed" | "fenced";
	invocationDigest: string;
}

export interface WorkflowEfficiencyRedTeamSuccessResult {
	kind: "success";
	reviewId: string;
	invocationRef: WorkflowArtifactRef;
	suggestionRef: WorkflowArtifactRef;
	actualUsage: WorkflowResourceVector;
	completedAt: string;
	resultDigest: string;
}

export interface WorkflowEfficiencyRedTeamFailureResult {
	kind: "failure";
	reviewId: string;
	invocationRef: WorkflowArtifactRef;
	status: "failed" | "timed_out" | "stale" | "unavailable" | "fenced";
	errorRef: WorkflowArtifactRef;
	actualUsage: WorkflowResourceVector;
	completedAt: string;
	resultDigest: string;
}

export type WorkflowEfficiencyRedTeamResult =
	| WorkflowEfficiencyRedTeamSuccessResult
	| WorkflowEfficiencyRedTeamFailureResult;
export interface WorkflowEfficiencyRedTeamWindowState {
	scheduleId: string;
	windowId: string;
	sourceWorkflowStateDigest: string;
	scheduledAt: string;
	windowSequence: number;
	clockObservationSequence: number;
	lastAdmittedWindowSequence: number;
	triggerDigests: readonly string[];
	reviewId: string | null;
	invocationRef: WorkflowArtifactRef | null;
	resultRef: WorkflowArtifactRef | null;
	catchUpConsumed: boolean;
	status: "pending" | "running" | "completed" | "failed" | "rejected_overlap" | "skipped";
	sourceSnapshotRef: WorkflowArtifactRef | null;
	sourceSnapshotDigest: string | null;
	completedAt: string | null;
	windowDigest: string;
}
export type WorkflowEfficiencyReviewSnapshot = WorkflowEfficiencyRedTeamSnapshot;
export type WorkflowEfficiencyReviewReport = WorkflowEfficiencyRedTeamReport;

export interface WorkflowEfficiencyRedTeamReport {
	workflowId: string;
	dueWindowId: string;
	kind: "success";
	runId: string;
	hostExecutionId: string;
	reviewId: string;
	invocationRef: WorkflowArtifactRef;
	snapshotRef: WorkflowArtifactRef;
	invocationDigest: string;
	snapshotDigest: string;
	resultDigest: string;
	reportDigest: string;
	suggestions: readonly WorkflowEfficiencyRedTeamSuggestion[];
	suggestionDigests: readonly string[];
	resolverReceipt: WorkflowVerifiedHostReceipt;
	exactSnapshot: WorkflowEfficiencyRedTeamSnapshot;
	exactInvocation: WorkflowEfficiencyRedTeamInvocation;
	exactResult: WorkflowEfficiencyRedTeamSuccessResult;
	sourceJournalSequence: number;
	sourceJournalDigest: string;
	registryRef: WorkflowArtifactRef;
	registryDigest: string;
	capacitySnapshotRefs: WorkflowAuthenticatedCapacitySnapshotRefs;
	usageSnapshotRefs: readonly WorkflowArtifactRef[];
	billingSnapshotRefs: readonly WorkflowArtifactRef[];
	rateLimitSnapshotRefs: readonly WorkflowArtifactRef[];
	monotonicClockObservation: WorkflowMonotonicClockObservation;
	childIdentity: WorkflowChildIdentity;
	epochRef: WorkflowEpochRef;
	executionKey: string;
	casExecutionKey: string;
	invocationTokenDigest: string;
	resourceLeaseRef: WorkflowLeaseRef;
	ownershipLeaseRef: WorkflowLeaseRef;
	throughputEvidenceRefs: readonly WorkflowArtifactRef[];
	evidenceGapRefs: readonly WorkflowArtifactRef[];
	uncertaintyEvidenceRefs: readonly WorkflowArtifactRef[];
	actualUsage: WorkflowResourceVector;
	disposition:
		| "no_change"
		| "suggest_reallocation"
		| "suggest_schedule_change"
		| "suggest_user_decision"
		| "safety_finding";
	writeAuthority: false;
	reallocationAuthority: false;
	approvalAuthority: false;
}

export interface WorkflowEfficiencyRedTeamSuggestion {
	suggestionId: string;
	reviewId: string;
	windowId: string;
	disposition:
		| "no_change"
		| "suggest_reallocation"
		| "suggest_schedule_change"
		| "suggest_user_decision"
		| "safety_finding";
	findingRefs: readonly WorkflowArtifactRef[];
	evidenceRefs: readonly WorkflowArtifactRef[];
	recommendedAllocationRef: WorkflowArtifactRef | null;
	expectedVerifiedOutcomeRef: WorkflowArtifactRef | null;
	writeAuthority: false;
	leaseAuthority: false;
	allocationAuthority: false;
	approvalAuthority: false;
	completionAuthority: false;
	suggestionDigest: string;
}

export type WorkflowEventKind =
	| "workflow_started"
	| "goal_binding_committed"
	| "capacity_observed"
	| "cloud_availability_observed"
	| "profile_selected"
	| "configuration_snapshot_pinned"
	| "skill_snapshot_pinned"
	| "goal_contract_proposed"
	| "scorecard_proposed"
	| "resource_envelope_proposed"
	| "approval_requested"
	| "approval_consumed"
	| "fresh_planner_started"
	| "resource_approved"
	| "workflow_status_changed"
	| "goal_projection_applied"
	| "continuity_capsule_published"
	| "projection_committed"
	| "store_generation_fenced"
	| "coordinator_epoch_fenced"
	| "scorecard_red_teamed"
	| "scorecard_approved"
	| "initialization_intent"
	| "projection_intent"
	| "frontier_init_intent"
	| "frontier_initialized"
	| "baseline_intent"
	| "initialized"
	| "lease_renewed"
	| "candidate_claim_intent"
	| "candidate_dispatched"
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
	| "candidate_target_observed"
	| "target_reached"
	| "verification_gap_found"
	| "run_archive_intent"
	| "run_archived"
	| "verified"
	| "completion_audited"
	| "refinement_recorded"
	| "completed"
	| "stop_requested"
	| "budget_limited"
	| "blocked"
	| "workflow_coordinator_lease_acquired"
	| "workflow_coordinator_lease_renewed"
	| "workflow_coordinator_fenced"
	| "workflow_dispatch_readiness_observed"
	| "workflow_resource_lease_acquired"
	| "workflow_task_lease_heartbeat"
	| "workflow_ownership_lease_acquired"
	| "workflow_dispatch_intent"
	| "workflow_child_identity_bound"
	| "workflow_child_outcome_committed"
	| "workflow_external_blocker_recorded"
	| "workflow_external_blocker_resolved"
	| "workflow_effect_intent"
	| "workflow_effect_completed"
	| "workflow_effect_ambiguous"
	| "workflow_process_group_owned"
	| "workflow_process_group_fenced"
	| "workflow_process_group_reaped"
	| "workflow_lease_release_recorded"
	| "workflow_lease_quarantined"
	| "workflow_scheduler_observation"
	| "workflow_progress_lease_acquired"
	| "workflow_progress_stalled"
	| "workflow_progress_lease_closed"
	| "workflow_progress_recovery_started"
	| "workflow_recovery_started"
	| "workflow_reconciliation_recorded"
	| "workflow_observation_outcome_recorded"
	| "workflow_completion_cut_sealed"
	| "workflow_late_observation_policy_recorded"
	| "workflow_cancellation_intent"
	| "workflow_cancellation_descendants_reconciled"
	| "workflow_cancelled"
	| "checkpoint_budget_observed"
	| "knowledge_record_committed"
	| "adaptive_observed"
	| "adaptive_observation_coalesced"
	| "adaptive_observation_superseded"
	| "adaptive_observation_stale"
	| "adaptive_observation_cancelled"
	| "adaptive_controller_recovered"
	| "adaptive_reconciled"
	| "adaptive_allocation_intent"
	| "adaptive_allocation_applied"
	| "adaptive_allocation_uncertain"
	| "adaptive_allocation_reconciled"
	| "adaptive_review_started"
	| "adaptive_review_completed"
	| "adaptive_review_cancelled"
	| "adaptive_review_fenced"
	| "adaptive_review_recovered"
	| "adaptive_review_stale_result"
	| "adaptive_allocation_reserved"
	| "adaptive_allocation_reallocated"
	| "adaptive_measured"
	| "adaptive_rollback_applied"
	| "improvement_proposed"
	| "improvement_reviewed"
	| "policy_revision_recorded"
	| "efficiency_red_team_scheduled"
	| "efficiency_red_team_snapshot_published"
	| "efficiency_red_team_started"
	| "efficiency_red_team_completed"
	| "efficiency_red_team_overlap_rejected"
	| "efficiency_red_team_catch_up_consumed"
	| "efficiency_red_team_failed"
	| "efficiency_red_team_suggestion_recorded";

export type WorkflowAdaptiveAllocationEvent =
	| {
			kind: "adaptive_observed";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observation: WorkflowAdaptiveAllocationObservation;
	  }
	| {
			kind: "adaptive_observation_coalesced";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			supersededObservationDigest: string;
	  }
	| {
			kind: "adaptive_observation_superseded";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			supersededObservationDigest: string;
	  }
	| {
			kind: "adaptive_observation_stale";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			reasonDigest: string;
	  }
	| {
			kind: "adaptive_observation_cancelled";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			reasonDigest: string;
	  }
	| { kind: "adaptive_controller_recovered"; workflowId: string; epochRef: WorkflowEpochRef; recoveryDigest: string }
	| {
			kind: "adaptive_reconciled";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			stateDigest: string;
	  }
	| {
			kind: "adaptive_allocation_intent";
			workflowId: string;
			allocationDigest: string;
			taskId: string;
			attemptId: string;
			leaseRef: WorkflowLeaseRef;
			epochRef: WorkflowEpochRef;
			idempotencyKey: string;
			certificateDigest: string;
			taskValueCertificateDigest: string;
			allocationEntry: WorkflowAdaptiveAllocationEntry;
			decisionRef: WorkflowDecisionRef;
			decisionReceipt: WorkflowVerifiedHostReceipt;
	  }
	| {
			kind: "adaptive_allocation_applied";
			workflowId: string;
			allocationDigest: string;
			ledgerHeadDigest: string;
			epochRef: WorkflowEpochRef;
			idempotencyKey: string;
			lastSafeAllocationTupleRef: WorkflowArtifactRef;
	  }
	| {
			kind: "adaptive_allocation_uncertain";
			workflowId: string;
			allocationDigest: string;
			epochRef: WorkflowEpochRef;
			reason: "crash_before_effect" | "provider_unknown" | "release_unknown";
	  }
	| {
			kind: "adaptive_allocation_reconciled";
			workflowId: string;
			allocationDigest: string;
			ledgerHeadDigest: string;
			epochRef: WorkflowEpochRef;
			nonExecutionReceipt: WorkflowVerifiedHostReceipt;
	  }
	| {
			kind: "adaptive_review_started";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			reviewId: string;
	  }
	| {
			kind: "adaptive_review_completed";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			reviewId: string;
			resultDigest: string;
			evidenceRefs: readonly WorkflowArtifactRef[];
	  }
	| {
			kind: "adaptive_review_cancelled";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			reviewId: string;
			reasonDigest: string;
	  }
	| {
			kind: "adaptive_review_fenced";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			reviewId: string;
			fenceDigest: string;
	  }
	| {
			kind: "adaptive_review_recovered";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			reviewId: string;
			recoveryDigest: string;
	  }
	| {
			kind: "adaptive_review_stale_result";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			observationDigest: string;
			reviewId: string;
			resultDigest: string;
	  }
	| {
			kind: "adaptive_allocation_reserved";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			allocationDigest: string;
			taskId: string;
			attemptId: string;
			leaseRef: WorkflowLeaseRef;
	  }
	| {
			kind: "adaptive_allocation_reallocated";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			allocationDigest: string;
			priorLeaseRef: WorkflowLeaseRef;
			nextLeaseRef: WorkflowLeaseRef;
	  }
	| {
			kind: "adaptive_measured";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			state: WorkflowAdaptiveAllocationState;
	  }
	| {
			kind: "adaptive_rollback_applied";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			priorAllocationDigest: string;
			restoredStateDigest: string;
	  }
	| {
			kind: "improvement_proposed";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			proposal: WorkflowImprovementProposal;
	  }
	| {
			kind: "improvement_reviewed";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			result: WorkflowImprovementReviewResult;
	  }
	| {
			kind: "policy_revision_recorded";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			revision: WorkflowPolicyRevision;
	  };

export type WorkflowEfficiencyRedTeamEvent =
	| {
			kind: "efficiency_red_team_scheduled";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			schedule: WorkflowEfficiencyReviewSchedule;
	  }
	| {
			kind: "efficiency_red_team_snapshot_published";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			runId: string;
			dueWindowId: string;
			trigger: WorkflowEfficiencyReviewTrigger;
			clockSequence: number;
			clockObservation: WorkflowMonotonicClockObservation;
			snapshot: WorkflowEfficiencyRedTeamSnapshot;
			supersededPendingRunId: string | null;
			supersessionDigest: string | null;
			fencedActiveRunId: string | null;
			activeFenceDigest: string | null;
	  }
	| {
			kind: "efficiency_red_team_started";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			runId: string;
			dueWindowId: string;
			hostExecutionId: string;
	  }
	| {
			kind: "efficiency_red_team_completed";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			report: WorkflowEfficiencyReviewReport;
	  }
	| {
			kind: "efficiency_red_team_overlap_rejected";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			dueWindowId: string;
			reason: "not_due" | "duplicate_window" | "overhead_budget" | "overlapping_run";
	  }
	| {
			kind: "efficiency_red_team_catch_up_consumed";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			dueWindowId: string;
			reportDigest: string | null;
			catchUp: true;
	  }
	| {
			kind: "efficiency_red_team_failed";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			dueWindowId: string;
			runId: string;
			failureDigest: string;
			status: "failed" | "cancelled" | "fenced";
			recoveryBoundary: "none" | "recovered";
	  }
	| {
			kind: "efficiency_red_team_suggestion_recorded";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			report: WorkflowEfficiencyReviewReport;
	  };

export type WorkflowKernelEventPayload =
	| { kind: "workflow_started"; workflowId: string; rootSessionId: string; objective: string }
	| {
			kind: "goal_binding_committed";
			workflowId: string;
			goalId: string;
			objective: string;
			goalDelta: WorkflowGoalMutationDelta;
	  }
	| { kind: "capacity_observed"; capacityDigest: string }
	| { kind: "cloud_availability_observed"; response: WorkflowCloudAvailabilityResponse }
	| {
			kind: "profile_selected";
			requestedProfile: "inline" | "parallel" | null;
			resolvedProfile: "inline" | "parallel" | "unresolved";
			maxWorkers: number;
			profileDigest: string;
	  }
	| { kind: "configuration_snapshot_pinned"; configDigest: string; configRevision: number }
	| {
			kind: "skill_snapshot_pinned";
			snapshotDigest: string;
			configDigest: string;
			epochRef: WorkflowEpochRef;
			dependencyManifestDigest: string;
	  }
	| { kind: "goal_contract_proposed"; contractDigest: string; decisionRef: WorkflowDecisionRef }
	| { kind: "scorecard_proposed"; scorecardDigest: string; decisionRef: WorkflowDecisionRef }
	| { kind: "resource_envelope_proposed"; envelopeDigest: string; decisionRef: WorkflowDecisionRef }
	| {
			kind: "approval_requested";
			approval: WorkflowApprovalRequest;
			awaitingUser: WorkflowApprovalAwaitingUserTransition;
	  }
	| { kind: "approval_consumed"; receipt: WorkflowApprovalReceipt; resumeTransition: WorkflowApprovalResumeTransition }
	| {
			kind: "fresh_planner_started";
			workflowId: string;
			approvalRequestId: string;
			stateDigest: string;
			epochRef: WorkflowEpochRef;
			plannerEventDigest: string;
	  }
	| { kind: "resource_approved"; envelopeDigest: string; receipt: WorkflowApprovalReceipt }
	| {
			kind: "workflow_status_changed";
			status: WorkflowStatus;
			phase: WorkflowPhaseId;
			reason: string;
			goalDelta: WorkflowGoalMutationDelta;
	  }
	| {
			kind: "goal_projection_applied";
			binding: {
				workflowId: string;
				eventSequence: number;
				transitionDigest: string;
				storeEpoch: number;
				coordinatorEpoch: number;
			};
			goalDigest: string;
			goalDelta: WorkflowGoalMutationDelta;
	  }
	| { kind: "continuity_capsule_published"; capsuleDigest: string }
	| {
			kind: "store_generation_fenced";
			workflowId: string;
			storeEpoch: number;
			priorEpoch: WorkflowEpochRef;
			nextEpoch: WorkflowEpochRef;
			priorLeaseRef: WorkflowLeaseRef;
			nextLeaseRef: WorkflowLeaseRef;
			generationId: string;
			generationBinding: WorkflowGenerationBinding;
	  }
	| {
			kind: "coordinator_epoch_fenced";
			workflowId: string;
			coordinatorEpoch: number;
			priorEpoch: WorkflowEpochRef;
			nextEpoch: WorkflowEpochRef;
			priorLeaseRef: WorkflowLeaseRef;
			nextLeaseRef: WorkflowLeaseRef;
			generationId: string;
			generationBinding: WorkflowGenerationBinding;
	  };

export interface WorkflowAutoResearchExpectedArtifact {
	kind: "run_config" | "event_prefix" | "baseline_log" | "acceptance_log" | "diagnostic";
	relativePath: string;
}

export interface CandidatePathBoundary {
	repositoryRoot: string;
	primaryCheckoutRealPath: string;
	primaryGitRealPath: string;
	externalWorktreeRoot: string;
	allowedRepoRelativePrefixes: readonly string[];
	excludedRealPaths: readonly string[];
	excludedKinds: readonly ("evaluator" | "guard" | "fixture" | "dependency" | "generated" | "out_of_scope")[];
	preSnapshotDigest: string;
	postSnapshotDigest: string | null;
}

export interface ChangedPathAllowlist {
	worktreeRealPath: string;
	allowedRepoRelativePrefixes: readonly string[];
	changedPaths: readonly string[];
	excludedPaths: readonly string[];
	symlinkEscapes: readonly string[];
	hardlinkEscapes: readonly string[];
	violation: string | null;
}

export interface WorkflowAutoResearchPrefixRef {
	sequence: number;
	digest: string;
}

export interface WorkflowAutoResearchFrontierRef {
	frontierRef: string;
	frontierWorktree: string;
	commit: string;
	metric: number;
	admittedCandidate: number | null;
	workspaceDigest: string;
	resultRef: string;
	refGeneration: number;
	refDigest: string;
}

export interface WorkflowAutoResearchFrontierCas {
	expectedRef: string;
	expectedCommit: string;
	expectedGeneration: number;
	expectedDigest: string;
	executionKey: string;
	epochRef: WorkflowEpochRef;
}

export interface WorkflowAutoResearchEventBase {
	workflowId: string;
	epochRef: WorkflowEpochRef;
	executionKey: string;
}

export type WorkflowAutoResearchEventPayload =
	| (WorkflowAutoResearchEventBase & {
			kind: "scorecard_red_teamed";
			scorecardProposalDigest: string;
			findings: readonly WorkflowArtifactRef[];
			disposition: "accepted" | "rejected" | "inconclusive";
			redTeamDigest: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "scorecard_approved";
			scorecardProposalDigest: string;
			approval: WorkflowApprovalReceipt;
			approvedRevision: number;
			authorizedAt: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "initialization_intent";
			runId: string;
			rootSessionId: string;
			goalDigest: string;
			scorecardDigest: string;
			resourceDigest: string;
			cleanBranch: string;
			resourceLease: WorkflowLeaseRef;
			ownershipLease: WorkflowLeaseRef;
			expectedArtifacts: readonly WorkflowAutoResearchExpectedArtifact[];
			expectedV2RunId: string;
			expectedV2FirstSeq: 0;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "projection_intent";
			runId: string;
			expectedPrefix: WorkflowAutoResearchPrefixRef | null;
			projectionLockId: string;
			effectDigest: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "frontier_init_intent";
			runId: string;
			baseCommit: string;
			frontierRef: string;
			frontierWorktree: string;
			expectedRefGeneration: number;
			resourceLease: WorkflowLeaseRef;
			ownershipLease: WorkflowLeaseRef;
			grant: WorkflowTaskResourceGrant;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "frontier_initialized";
			runId: string;
			frontier: WorkflowAutoResearchFrontierRef;
			artifactRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "baseline_intent";
			runId: string;
			attemptId: string;
			commandDigest: string;
			parserDigest: string;
			guardDigest: string | null;
			checkDigests: readonly string[];
			expectedArtifacts: readonly WorkflowAutoResearchExpectedArtifact[];
			knownGoodCommit: string;
			preCommandWorkspaceDigest: string;
			configDigest: string;
			leaseRef: WorkflowLeaseRef;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "initialized";
			runId: string;
			runConfigDigest: string;
			prefix: WorkflowAutoResearchPrefixRef;
			knownGoodCommit: string;
			baselineMetric: number;
			checkDigests: readonly string[];
			bindingIds: readonly string[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "projection_committed";
			runId: string;
			expectedPrefix: WorkflowAutoResearchPrefixRef | null;
			resultPrefix: WorkflowAutoResearchPrefixRef;
			projectionArtifactRef: WorkflowArtifactRef;
			effectDigest: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "lease_renewed";
			runId: string;
			candidateId: number;
			attemptId: string;
			leaseRef: WorkflowLeaseRef;
			expiresAt: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "candidate_claim_intent";
			runId: string;
			candidateId: number;
			attemptId: string;
			role: "exploit" | "explore";
			baseCommit: string;
			grant: WorkflowTaskResourceGrant;
			resourceLease: WorkflowLeaseRef;
			ownershipLease: WorkflowLeaseRef;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "candidate_dispatched";
			runId: string;
			candidateId: number;
			attemptId: string;
			packetDigest: string;
			branch: string;
			worktree: string;
			resourceLease: WorkflowLeaseRef;
			ownershipLease: WorkflowLeaseRef | null;
			childIdentity: WorkflowChildIdentity;
			processBinding: WorkflowChildProcessBinding;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "candidate_handoff_published";
			runId: string;
			candidateId: number;
			attemptId: string;
			packetDigest: string;
			childIdentity: WorkflowChildIdentity;
			processBinding: WorkflowChildProcessBinding;
			handoff: WorkflowAttemptHandoff;
			handoffDigest: string;
			evidenceDigest: string;
			workspaceDigest: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "finish_intent";
			runId: string;
			candidateId: number;
			attemptId: string;
			packetDigest: string;
			childIdentity: WorkflowChildIdentity;
			processBinding: WorkflowChildProcessBinding;
			decisionRef: WorkflowDecisionRef;
			decisionDigest: string;
			evidenceDigest: string;
			evaluatorDigest: string;
			guardDigest: string | null;
			effectDigest: string;
			expectedFrontier: WorkflowAutoResearchFrontierRef;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "metric_recorded";
			runId: string;
			candidateId: number;
			attemptId: string;
			trialCommit: string;
			metric: number;
			parserDigest: string;
			verifyLogDigest: string;
			evidenceRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "guard_recorded";
			runId: string;
			candidateId: number;
			attemptId: string;
			disposition: "pass" | "fail" | "not_run";
			guardDigest: string;
			evidenceRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "admission_lock_acquired";
			runId: string;
			lockId: string;
			frontier: WorkflowAutoResearchFrontierRef;
			lockOwner: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "stale_rebase_requested";
			runId: string;
			candidateId: number;
			attemptId: string;
			oldFrontier: WorkflowAutoResearchFrontierRef;
			newFrontier: WorkflowAutoResearchFrontierRef;
			rebaseCommit: string | null;
			reason: "stale_frontier" | "late_finish";
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "remeasured";
			runId: string;
			candidateId: number;
			attemptId: string;
			rebaseCommit: string;
			metric: number;
			metricDigest: string;
			guardDigest: string;
			evidenceRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "candidate_red_teamed";
			runId: string;
			candidateId: number;
			attemptId: string;
			diffDigest: string;
			resultDigest: string;
			findings: readonly WorkflowArtifactRef[];
			redTeamDigest: string;
			disposition: "accepted" | "rejected";
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "frontier_update_intent";
			runId: string;
			candidateId: number;
			attemptId: string;
			frontierCas: WorkflowAutoResearchFrontierCas;
			candidateCommit: string;
			packetDigest: string;
			evidenceDigest: string;
			lockId: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "candidate_admitted";
			runId: string;
			candidateId: number;
			attemptId: string;
			resolvedFrontier: WorkflowAutoResearchFrontierRef;
			candidateCommit: string;
			finishIntentDigest: string;
			decisionDigest: string;
			evidenceDigest: string;
			strictImprovement: true;
			guardPassed: true;
			acceptancePassed: true;
			redTeamDigest: string;
			resultRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "candidate_discarded";
			runId: string;
			candidateId: number;
			attemptId: string;
			reason:
				| "no_improvement"
				| "stale_no_improvement"
				| "rebase_conflict"
				| "guard_failed"
				| "no_change"
				| "abandoned"
				| "lease_expired"
				| "red_team_rejected"
				| "wrong_epoch"
				| "missing_decision";
			trialCommit: string | null;
			revertCommit: string | null;
			metricDigest: string | null;
			guardDigest: string | null;
			redTeamDigest: string | null;
			finishIntentDigest: string;
			evidenceDigest: string;
			frontierUnchanged: true;
			frontierDigest: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "admission_lock_released";
			runId: string;
			lockId: string;
			frontierDigest: string;
			status: "released" | "quarantined";
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "candidate_abandoned";
			runId: string;
			candidateId: number;
			attemptId: string;
			reason: string;
			leaseEvidenceRefs: readonly WorkflowArtifactRef[];
			noAdmission: true;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "candidate_reaped";
			runId: string;
			candidateId: number;
			attemptId: string;
			reason: string;
			livenessEvidenceRefs: readonly WorkflowArtifactRef[];
			noAdmission: true;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "recovery_classified";
			runId: string;
			candidateId: number;
			attemptId: string;
			disposition:
				| "reattached"
				| "completed"
				| "proven_not_executed"
				| "corrective_work_required"
				| "user_input_required"
				| "failed";
			evidenceRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "candidate_target_observed";
			runId: string;
			candidateId: number;
			attemptId: string;
			metric: number;
			target: number;
			evidenceRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "target_reached";
			runId: string;
			source: "admitted_frontier" | "approved_baseline";
			metric: number;
			target: number;
			frontierDigest: string;
			status: "target_pending_verification";
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "verification_gap_found";
			runId: string;
			gapDigest: string;
			evidenceRefs: readonly WorkflowArtifactRef[];
			reason: string;
			replacementRequested: true;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "run_archive_intent";
			runId: string;
			terminalPrefix: WorkflowAutoResearchPrefixRef;
			archiveDestination: string;
			decisionRefs: readonly WorkflowDecisionRef[];
			descendantSetDigest: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "run_archived";
			runId: string;
			terminalPrefix: WorkflowAutoResearchPrefixRef;
			archiveArtifactRef: WorkflowArtifactRef;
			archiveDestination: string;
			archiveDigest: string;
			archivedAt: string;
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "verified";
			runId: string;
			verificationDigest: string;
			evidenceRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "completion_audited";
			runId: string;
			completionDigest: string;
			redTeamDigest: string;
			evidenceRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "refinement_recorded";
			runId: string;
			refinementDigest: string;
			scope: "session" | "workspace" | "user";
			evidenceRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "completed";
			runId: string;
			completionDecisionRef: WorkflowDecisionRef;
			finalDigest: string;
			resultRefs: readonly WorkflowArtifactRef[];
	  })
	| (WorkflowAutoResearchEventBase & {
			kind: "stop_requested";
			runId: string;
			reason: string;
			authorityDigest: string;
	  })
	| (WorkflowAutoResearchEventBase & { kind: "budget_limited"; runId: string; budgetDigest: string; reason: string })
	| (WorkflowAutoResearchEventBase & {
			kind: "blocked";
			runId: string;
			blockerDigest: string;
			reason: string;
			evidenceRefs: readonly WorkflowArtifactRef[];
	  });

export interface WorkflowJournalHead {
	workflowId: string;
	sequence: number;
	eventDigest: string | null;
	epochRef: WorkflowEpochRef;
}

export type WorkflowCrashBoundary =
	| "after_epoch_acquired"
	| "after_resource_lease_acquired"
	| "after_ownership_lease_acquired"
	| "after_dispatch_intent_committed"
	| "after_child_process_created_before_identity_bind"
	| "after_child_identity_committed_before_start"
	| "after_effect_intent_committed_before_execution"
	| "during_effect_before_completion_commit"
	| "after_effect_completion_before_outcome_commit"
	| "after_outcome_committed_before_lease_release"
	| "after_lease_release_before_refill"
	| "after_cancellation_intent_before_descendant_enumeration"
	| "after_cancellation_reap_before_barrier";

export interface WorkflowCrashBoundaryHook {
	checkpoint: WorkflowCrashBoundary;
	beforeCommit(input: {
		workflowId: string;
		attemptId: string | null;
		executionKey: string | null;
		epochRef: WorkflowEpochRef;
		checkpoint: WorkflowCrashBoundary;
	}): Promise<void>;
	afterCommit(input: {
		workflowId: string;
		attemptId: string | null;
		executionKey: string | null;
		epochRef: WorkflowEpochRef;
		checkpoint: WorkflowCrashBoundary;
		eventDigest: string;
	}): Promise<void>;
}

// A and R import this hook; they do not reopen crash-boundary names or add an
// untyped callback at a child/effect boundary.

export interface WorkflowCoordinatorLeaseRecord {
	workflowId: string;
	leaseId: string;
	ownerIdentity: string;
	pid: number;
	processStartId: string;
	processGroupId: string;
	epochRef: WorkflowEpochRef;
	acquiredAt: string;
	renewedAt: string;
	expiresAt: string;
	status: "active" | "fenced" | "expired";
}

export type WorkflowDispatchBlockingReason =
	| "kernel_contract_unavailable"
	| "artifact_root_unavailable"
	| "coordinator_epoch_stale"
	| "process_start_identity_unavailable"
	| "process_group_unenforceable"
	| "same_process_child_session"
	| "child_authority_invalid"
	| "resource_envelope_unapproved"
	| "config_snapshot_stale"
	| "effect_hook_unbrokered"
	| "protocol_review_required";

export interface WorkflowProcessGroupIdentity {
	pid: number;
	processStartId: string;
	processGroupId: string;
	parentPid: number;
	identityDigest: string;
}

export interface WorkflowProcessSpawnRequest {
	executable: string;
	arguments: readonly string[];
	cwd: string;
	detached: boolean;
	requireProcessStartId: boolean;
}

export type WorkflowArtifactPayloadKind =
	| "handoff"
	| "evidence"
	| "process_identity"
	| "effect_result"
	| "recovery_finding"
	| "barrier";

export interface WorkflowArtifactPublishInput {
	workflowId: string;
	payloadKind: WorkflowArtifactPayloadKind;
	/** Optional host-owned namespace for evidence artifacts with a stricter consumer boundary. */
	readonly artifactNamespace?: "skills";
	bytes: Uint8Array;
	codec: WorkflowArtifactCodec;
	sourceEventSequence: number;
	idempotencyKey: string;
}

export interface WorkflowArtifactPublishResult {
	status: "published" | "already_published";
	envelope: WorkflowArtifactEnvelope;
}

export interface WorkflowArtifactPublisher {
	publish(
		input: WorkflowArtifactPublishInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowArtifactPublishResult>;
}

export interface WorkflowDescriptorHandle {
	readonly identityDigest: string;
	write(bytes: Uint8Array): Promise<void>;
	read(): Promise<Uint8Array>;
	stat(): Promise<{ kind: "file" | "directory"; linkCount: number; device: number; identityDigest: string }>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

export interface WorkflowDescriptorFs {
	openRoot(artifactRoot: string): Promise<WorkflowDescriptorHandle>;
	mkdirAt(parent: WorkflowDescriptorHandle, component: string, mode: number): Promise<WorkflowDescriptorHandle>;
	openAt(
		parent: WorkflowDescriptorHandle,
		component: string,
		flags: number,
		mode: number,
	): Promise<WorkflowDescriptorHandle>;
	renameAt(
		parent: WorkflowDescriptorHandle,
		fromComponent: string,
		toComponent: string,
		options?: { replace: boolean; noReplace: boolean },
	): Promise<void>;
	unlinkAt(parent: WorkflowDescriptorHandle, component: string): Promise<void>;
	syncDirectoryChain(leaf: WorkflowDescriptorHandle, root: WorkflowDescriptorHandle): Promise<void>;
}

export interface WorkflowSnapshotPublishInput {
	workflowId: string;
	sequence: number;
	sourceEventDigest: string;
	epochRef: WorkflowEpochRef;
	expectedHead: WorkflowSnapshotHead;
	leaseRef: WorkflowLeaseRef;
	writerIdentity: string;
	stateBytes: Uint8Array;
	stateDigest: string;
	idempotencyKey: string;
	authenticatedTuple: WorkflowAuthenticatedMutationTuple;
}

export interface WorkflowSnapshotHead {
	workflowId: string;
	sequence: number;
	sourceEventDigest: string | null;
	stateDigest: string | null;
	epochRef: WorkflowEpochRef;
}

export interface WorkflowSnapshotPublishResult {
	status: "published" | "already_published";
	sequence: number;
	sourceEventDigest: string;
	stateDigest: string;
}

export interface WorkflowOutboxAppendInput {
	workflowId: string;
	/** Contiguous delivery order in the outbox log, independent of the source journal. */
	sequence: number;
	/** Source workflow event digest retained for the existing outbox-head chain. */
	eventDigest: string;
	/** Authenticated source workflow journal sequence. Legacy callers default to sequence. */
	sourceEventSequence?: number;
	/** Authenticated source workflow journal event digest. Legacy callers default to eventDigest. */
	sourceEventDigest?: string;
	epochRef: WorkflowEpochRef;
	expectedHead: WorkflowOutboxHead;
	leaseRef: WorkflowLeaseRef;
	writerIdentity: string;
	idempotencyKey: string;
	bytes: Uint8Array;
	entryDigest: string;
	authenticatedTuple: WorkflowAuthenticatedMutationTuple;
}

export interface WorkflowOutboxHead {
	workflowId: string;
	/** Contiguous delivery order of the last persisted outbox entry. */
	sequence: number;
	/** Source workflow event digest carried by the last outbox entry. */
	eventDigest: string | null;
	entryDigest: string | null;
	epochRef: WorkflowEpochRef;
}

export interface WorkflowOutboxAppendResult {
	status: "appended" | "already_appended";
	/** Contiguous delivery sequence in the outbox log. */
	sequence: number;
	entryDigest: string;
}

export type WorkflowOutboxTailStatus = "complete" | "partial_frame" | "invalid_record";

export interface WorkflowOutboxRecoveryMetadata {
	status: WorkflowOutboxTailStatus;
	sourcePath: string;
	sourceDigest: string;
	sourceSizeBytes: number;
	sequence: number | null;
	reason: "none" | "tail_truncated" | "invalid_record";
}

// When quarantined is true, entries is always [] and head is null; no prefix
// is exposed to a reducer.
export type WorkflowOutboxRecoveryResult =
	| {
			quarantined: false;
			entries: readonly WorkflowOutboxAppendInput[];
			head: WorkflowOutboxHead;
			metadata: WorkflowOutboxRecoveryMetadata;
	  }
	| { quarantined: true; entries: readonly []; head: null; metadata: WorkflowOutboxRecoveryMetadata };

export interface WorkflowSnapshotPublisher {
	publish(
		input: WorkflowSnapshotPublishInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowSnapshotPublishResult>;
}

export interface WorkflowOutboxAppender {
	append(input: WorkflowOutboxAppendInput, hook?: DurableStoreCrashBoundaryHook): Promise<WorkflowOutboxAppendResult>;
	recover(expectedEpoch: WorkflowEpochRef): Promise<WorkflowOutboxRecoveryResult>;
}

export type WorkflowProjectionKey = "goal" | "status" | "continuity";

export interface WorkflowProjectionCasInput {
	workflowId: string;
	projectionKey: WorkflowProjectionKey;
	expectedHead: WorkflowJournalHead;
	projectionDigest: string;
	epochRef: WorkflowEpochRef;
	idempotencyKey: string;
	authenticatedTuple: WorkflowAuthenticatedMutationTuple;
}

export type WorkflowProjectionCasResult = "applied" | "already_applied" | "conflict";

export interface WorkflowProjectionAdapter<TKey extends WorkflowProjectionKey = WorkflowProjectionKey> {
	readonly projectionKey: TKey;
	compareAndSwap(
		input: WorkflowProjectionCasInput & { projectionKey: TKey },
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowProjectionCasResult>;
}

export type WorkflowConcreteEffect =
	| {
			kind: "bash_exec";
			operationId: string;
			commandPreimageRef: WorkflowArtifactRef;
			cwd: string;
			timeoutMs: number;
			writeClass: "read_only" | "workspace_write" | "external_write";
	  }
	| { kind: "file_read"; operationId: string; path: string; pathDigest: string }
	| {
			kind: "file_write";
			operationId: string;
			path: string;
			contentPreimageRef: WorkflowArtifactRef;
			writeClass: "workspace_write" | "external_write";
	  }
	| {
			kind: "ipython_exec";
			operationId: string;
			codePreimageRef: WorkflowArtifactRef;
			kernelId: string;
			writeClass: "read_only" | "workspace_write" | "external_write";
	  }
	| {
			kind: "package_manager";
			operationId: string;
			manager: "npm" | "pnpm" | "yarn" | "pip" | "uv";
			argumentsPreimageRef: WorkflowArtifactRef;
			cwd: string;
			writeClass: "workspace_write" | "external_write";
	  }
	| {
			kind: "child_process_spawn";
			operationId: string;
			executablePreimageRef: WorkflowArtifactRef;
			argumentsPreimageRef: WorkflowArtifactRef;
			cwd: string;
			processGroupRequest: WorkflowProcessSpawnRequest;
	  }
	| {
			kind: "artifact_publish";
			operationId: string;
			payloadKind: WorkflowArtifactPayloadKind;
			payloadPreimageRef: WorkflowArtifactRef;
	  }
	| {
			kind: "session_mutation";
			operationId: string;
			target: "goal" | "settings" | "session_projection";
			mutationPreimageRef: WorkflowArtifactRef;
	  };

export interface WorkflowLeaseReconciliation {
	leaseRef: WorkflowLeaseRef;
	status: "released" | "already_released" | "quarantined";
	reason: string | null;
}

export interface WorkflowQueueObservation {
	taskId: string;
	attemptId: string;
	enqueuedAt: string;
	ageMs: number;
	priority: number;
	required: WorkflowResourceVector;
	blockedBy: readonly WorkflowDispatchBlockingReason[];
}

export interface WorkflowAttemptReconciliationSummary {
	attemptId: string;
	status: "cancelled" | "already_cancelled" | "reattached" | "quarantined";
	detail:
		| "child_running"
		| "child_terminal"
		| "not_started_proven"
		| "effect_completed"
		| "effect_ambiguous"
		| "identity_lost"
		| "lease_released"
		| "lease_quarantined";
	outcomeDigest: string | null;
	processReapDigest: string | null;
	effectDisposition: "none" | "completed" | "ambiguous" | "quarantined";
	leaseResults: readonly WorkflowLeaseReconciliation[];
}

export type WorkflowCheckpointBudgetRetentionClass =
	| "durable_fact"
	| "artifact_ref"
	| "transient_tool_output"
	| "transient_dataframe"
	| "transient_log_tail"
	| "reproducible_cache";

export type WorkflowCheckpointBudgetRepresentation = "durable" | "transient" | "unavailable";

export interface WorkflowCheckpointBudgetRequiredStatePayload {
	readonly valueId: string;
	readonly type: string;
	readonly classification: "durable_fact" | "artifact_ref";
}

export interface WorkflowCheckpointBudgetRetainedValuePayload {
	readonly valueId: string;
	readonly type: string;
	readonly bytes: number;
	readonly classification: WorkflowCheckpointBudgetRetentionClass;
	readonly representation: WorkflowCheckpointBudgetRepresentation;
	readonly digest: string | null;
	readonly artifactRef: WorkflowArtifactRef | null;
	readonly reasonCode: string | null;
	readonly required: boolean;
}

export interface WorkflowCheckpointBudgetObservationPayload {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly idempotencyKey: string;
	readonly kind: "checkpoint_budget_observed";
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly processGenerationId: string;
	readonly runtimeVersion: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly source: "host";
	readonly authority: "host_committed";
	readonly classificationAuthority: "host";
	readonly completionEvidence: "none";
	readonly mockOnly: false;
	readonly publicBoundary: string;
	readonly bindingDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly receiptDigest: string;
	readonly authorizationDigest: string;
	readonly fenceDigest: string;
	readonly requiredStateRegistryDigest: string;
	readonly requiredStateRegistry: readonly WorkflowCheckpointBudgetRequiredStatePayload[];
	readonly requiredStateIds: readonly string[];
	readonly missingRequiredStateIds: readonly string[];
	readonly checkpointTurn: number;
	readonly serializeStartedAtMonotonicMs: number;
	readonly serializeEndedAtMonotonicMs: number;
	readonly restoreStartedAtMonotonicMs: number | null;
	readonly restoreEndedAtMonotonicMs: number | null;
	readonly observedAtMonotonicMs: number;
	readonly bytesWritten: number;
	readonly durableBytes: number;
	readonly retainedValues: readonly WorkflowCheckpointBudgetRetainedValuePayload[];
	readonly previousObservationDigest: string | null;
	readonly previousCheckpointTurn: number | null;
	readonly previousDurableBytes: number | null;
	readonly durabilityOutcome: "durable";
	readonly failureReason: null;
	/** Facts digest; journal eventDigest/recordMac remain the authenticated commit proof. */
	readonly observationDigest: string;
}

export interface WorkflowAuthoritativeProgressCut {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly goalRevisionDigest: string;
	readonly boundaryRevisionDigest: string;
	readonly journalHead: WorkflowJournalHead;
	readonly nextGate: string;
	readonly readyTaskIds: readonly string[];
	readonly terminalTaskIds: readonly string[];
	readonly readyTaskSetDigest: string;
	readonly unresolvedGatingObligationDigests: readonly string[];
	readonly unresolvedEffectDigests: readonly string[];
	readonly lastAuthenticatedOutcomeEvidenceRef: WorkflowArtifactRef | null;
	readonly lastAuthoritativeProgressAt: string;
	readonly semanticProgressDigest: string;
}

export interface WorkflowProgressPredicate {
	readonly schemaVersion: 1;
	readonly kind: "task_terminal";
	readonly taskIds: readonly string[];
	readonly requiredOutcome: "accepted";
	readonly rejectedRenewalSignals: readonly [
		"worker_activity",
		"timestamps",
		"token_use",
		"transcript_growth",
		"heartbeats",
		"test_counts",
		"reports",
		"status_rewrites",
		"task_splitting",
		"nonauthoritative_artifacts",
		"no_op_events",
	];
	readonly predicateDigest: string;
}

export interface WorkflowProgressLease {
	readonly schemaVersion: 1;
	readonly leaseId: string;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly baseJournalHead: WorkflowJournalHead;
	readonly progressCutDigest: string;
	readonly baseSemanticProgressDigest: string;
	readonly expectedTransitionPredicate: WorkflowProgressPredicate;
	readonly expectedTransitionPredicateDigest: string;
	readonly adversarialReviewDigest: string;
	readonly owner: string;
	readonly acquiredAt: string;
	readonly deadline: string;
	readonly wakeObligationId: string;
	readonly recoveryAttempt: number;
	readonly leaseDigest: string;
}

export interface WorkflowProgressStallRecord {
	readonly schemaVersion: 1;
	readonly stallId: string;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseId: string;
	readonly wakeObligationId: string;
	readonly observedHead: WorkflowJournalHead;
	readonly baseSemanticProgressDigest: string;
	readonly observedSemanticProgressDigest: string;
	readonly readyTaskSetDigest: string;
	readonly stalledAt: string;
	readonly reason: "progress_lease_deadline_unchanged";
	readonly recoveryAttempt: number;
	readonly stallDigest: string;
}

export interface WorkflowProgressSourceOutcome {
	readonly eventSequence: number;
	readonly eventDigest: string;
	readonly attemptId: string;
	readonly taskId: string;
	readonly outcomeDigest: string;
	readonly evidenceDigests: readonly string[];
}

export type WorkflowExternalBlockerOwner = "workflow_host" | "resource_host" | "capability_host" | "external";

export interface WorkflowExternalBlockerRecord {
	readonly schemaVersion: 1;
	readonly blockerId: string;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly goalRevisionDigest: string;
	readonly dependencyId: string;
	readonly conditionDigest: string;
	readonly requiredChange: string;
	readonly owner: WorkflowExternalBlockerOwner;
	readonly resumeEventKind: string;
	readonly resumePredicateDigest: string;
	readonly earliestRetryAt: string | null;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly recordedAt: string;
	readonly blockerDigest: string;
}

export interface WorkflowExternalBlockerResolution {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly blockerId: string;
	readonly blockerDigest: string;
	readonly epochRef: WorkflowEpochRef;
	readonly resumePredicateDigest: string;
	readonly eventKind: string;
	readonly eventDigest: string;
	readonly observedAt: string;
	readonly resolutionDigest: string;
}

export type WorkflowRuntimeEventPayload =
	| {
			kind: "workflow_coordinator_lease_acquired";
			workflowId: string;
			lease: WorkflowCoordinatorLeaseRecord;
			epochRef: WorkflowEpochRef;
	  }
	| {
			kind: "workflow_coordinator_lease_renewed";
			workflowId: string;
			leaseId: string;
			epochRef: WorkflowEpochRef;
			renewedAt: string;
			expiresAt: string;
	  }
	| {
			kind: "workflow_coordinator_fenced";
			workflowId: string;
			leaseId: string;
			epochRef: WorkflowEpochRef;
			reason: string;
	  }
	| {
			kind: "workflow_dispatch_readiness_observed";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			readinessDigest: string;
			canDispatch: boolean;
			blockingReasons: readonly WorkflowDispatchBlockingReason[];
	  }
	| {
			kind: "workflow_resource_lease_acquired";
			workflowId: string;
			lease: WorkflowResourceLease;
			epochRef: WorkflowEpochRef;
	  }
	| {
			kind: "workflow_task_lease_heartbeat";
			workflowId: string;
			taskId: string;
			attemptId: string;
			executionKey: string;
			epochRef: WorkflowEpochRef;
			resourceLeaseRef: WorkflowLeaseRef;
			observedAt: string;
			priorExpiresAt: string;
			renewedExpiresAt: string;
			progressDigest: string;
			heartbeatDigest: string;
	  }
	| {
			kind: "workflow_ownership_lease_acquired";
			workflowId: string;
			lease: WorkflowOwnershipLease;
			epochRef: WorkflowEpochRef;
	  }
	| {
			kind: "workflow_dispatch_intent";
			workflowId: string;
			taskId: string;
			attemptId: string;
			executionKey: string;
			admissionId: string;
			epochRef: WorkflowEpochRef;
			decisionRef: DurableDecisionRef;
			resourceLeaseRef: WorkflowLeaseRef;
			ownershipLeaseRef: WorkflowLeaseRef | null;
			childAuthority: WorkflowChildAuthority;
			launchConfigDigest: string;
			expectedEffectDigest: string;
	  }
	| {
			kind: "workflow_child_identity_bound";
			workflowId: string;
			attemptId: string;
			admissionId: string;
			identity: WorkflowChildIdentity;
			processBinding: WorkflowChildProcessBinding;
			epochRef: WorkflowEpochRef;
	  }
	| {
			kind: "workflow_child_outcome_committed";
			workflowId: string;
			attemptId: string;
			executionKey: string;
			outcome: WorkflowPhaseOutcomeRecord;
			outcomeDigest: string;
			epochRef: WorkflowEpochRef;
	  }
	| {
			kind: "workflow_external_blocker_recorded";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			blocker: WorkflowExternalBlockerRecord;
			blockerDigest: string;
	  }
	| {
			kind: "workflow_external_blocker_resolved";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			resolution: WorkflowExternalBlockerResolution;
			resolutionDigest: string;
	  }
	| {
			kind: "workflow_effect_intent";
			workflowId: string;
			attemptId: string;
			executionKey: string;
			effectDigest: string;
			decisionRef: DurableDecisionRef;
			epochRef: WorkflowEpochRef;
			idempotencyKey: string;
			effect: WorkflowConcreteEffect;
	  }
	| {
			kind: "workflow_effect_completed";
			workflowId: string;
			attemptId: string;
			executionKey: string;
			effectDigest: string;
			resultDigest: string;
			idempotencyKey: string;
			epochRef: WorkflowEpochRef;
			disposition: "completed" | "already_completed";
	  }
	| {
			kind: "workflow_effect_ambiguous";
			workflowId: string;
			attemptId: string;
			executionKey: string;
			effectDigest: string;
			idempotencyKey: string;
			epochRef: WorkflowEpochRef;
			reason: "unknown_external_outcome" | "process_identity_lost" | "completion_commit_uncertain";
	  }
	| {
			kind: "workflow_process_group_owned";
			workflowId: string;
			attemptId: string;
			processGroup: WorkflowProcessGroupIdentity;
			epochRef: WorkflowEpochRef;
	  }
	| {
			kind: "workflow_process_group_fenced";
			workflowId: string;
			attemptId: string;
			processGroup: WorkflowProcessGroupIdentity;
			epochRef: WorkflowEpochRef;
			reason: string;
	  }
	| {
			kind: "workflow_process_group_reaped";
			workflowId: string;
			attemptId: string;
			processGroupId: string;
			epochRef: WorkflowEpochRef;
			remainingPids: readonly number[];
			reapDigest: string;
	  }
	| {
			kind: "workflow_lease_release_recorded";
			workflowId: string;
			releaseRef: WorkflowLeaseReleaseRef;
			epochRef: WorkflowEpochRef;
			status: "released" | "already_released";
	  }
	| {
			kind: "workflow_lease_quarantined";
			workflowId: string;
			leaseRef: WorkflowLeaseRef;
			epochRef: WorkflowEpochRef;
			reason: string;
	  }
	| {
			kind: "workflow_scheduler_observation";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			readyTaskIds: readonly string[];
			queue: readonly WorkflowQueueObservation[];
			inventoryDigest: string;
			limiterDigest: string;
	  }
	| {
			kind: "workflow_progress_lease_acquired";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			cut: WorkflowAuthoritativeProgressCut;
			cutDigest: string;
			lease: WorkflowProgressLease;
			leaseDigest: string;
			sourceOutcome: WorkflowProgressSourceOutcome | null;
	  }
	| {
			kind: "workflow_progress_stalled";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			record: WorkflowProgressStallRecord;
			recordDigest: string;
	  }
	| {
			kind: "workflow_progress_lease_closed";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			leaseId: string;
			sourceOutcome: WorkflowProgressSourceOutcome;
			closedAt: string;
			disposition: "advanced" | "terminal";
			closureDigest: string;
	  }
	| {
			kind: "workflow_progress_recovery_started";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			leaseId: string;
			wakeObligationId: string;
			recoveryAttempt: number;
			recoveryStartedAt: string;
			recoveryDigest: string;
	  }
	| { kind: "workflow_recovery_started"; workflowId: string; epochRef: WorkflowEpochRef; journalHeadDigest: string }
	| {
			kind: "workflow_reconciliation_recorded";
			workflowId: string;
			attemptId: string;
			epochRef: WorkflowEpochRef;
			outcome: WorkflowReconciliationOutcome;
			outcomeDigest: string;
	  }
	| {
			kind: "workflow_observation_outcome_recorded";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			record: WorkflowObservationOutcomeRecord;
			recordDigest: string;
	  }
	| {
			kind: "workflow_completion_cut_sealed";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			cut: WorkflowObservationCompletionCut;
			cutDigest: string;
	  }
	| {
			kind: "workflow_late_observation_policy_recorded";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			record: WorkflowObservationLatePolicyRecord;
			recordDigest: string;
	  }
	| {
			kind: "workflow_cancellation_intent";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			reason: string;
			descendantSetDigest: string;
	  }
	| {
			kind: "workflow_cancellation_descendants_reconciled";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			descendantSetDigest: string;
			reconciliationDigest: string;
			leaseBarrierDigest: string;
			attemptOutcomes: readonly WorkflowAttemptReconciliationSummary[];
	  }
	| {
			kind: "workflow_cancelled";
			workflowId: string;
			epochRef: WorkflowEpochRef;
			barrierEventSequence: number;
			descendantSetDigest: string;
			reconciliationDigest: string;
			leaseBarrierDigest: string;
	  }
	| WorkflowCheckpointBudgetObservationPayload;

export interface WorkflowKnowledgeEventPayload {
	kind: "knowledge_record_committed";
	idempotencyKey: string;
	record: WorkflowCanonicalJsonObject;
	previous: WorkflowCanonicalJsonObject | null;
	previousDigest: string | null;
	proposalDigest: string;
}

export type WorkflowRuntimeEvent = WorkflowRuntimeEventPayload;
export type WorkflowEventPayload =
	| WorkflowKernelEventPayload
	| WorkflowAutoResearchEventPayload
	| WorkflowRuntimeEventPayload
	| WorkflowAdaptiveAllocationEvent
	| WorkflowEfficiencyRedTeamEvent
	| WorkflowKnowledgeEventPayload;
export type WorkflowEventType = WorkflowEventPayload["kind"];

export const WORKFLOW_EVENT_KINDS: ReadonlySet<WorkflowEventKind> = new Set<WorkflowEventKind>([
	"workflow_started",
	"goal_binding_committed",
	"capacity_observed",
	"cloud_availability_observed",
	"profile_selected",
	"configuration_snapshot_pinned",
	"skill_snapshot_pinned",
	"goal_contract_proposed",
	"scorecard_proposed",
	"resource_envelope_proposed",
	"approval_requested",
	"approval_consumed",
	"fresh_planner_started",
	"resource_approved",
	"workflow_status_changed",
	"goal_projection_applied",
	"continuity_capsule_published",
	"projection_committed",
	"store_generation_fenced",
	"coordinator_epoch_fenced",
	"scorecard_red_teamed",
	"scorecard_approved",
	"initialization_intent",
	"projection_intent",
	"frontier_init_intent",
	"frontier_initialized",
	"baseline_intent",
	"initialized",
	"lease_renewed",
	"candidate_claim_intent",
	"candidate_dispatched",
	"candidate_handoff_published",
	"finish_intent",
	"metric_recorded",
	"guard_recorded",
	"admission_lock_acquired",
	"stale_rebase_requested",
	"remeasured",
	"candidate_red_teamed",
	"frontier_update_intent",
	"candidate_admitted",
	"candidate_discarded",
	"admission_lock_released",
	"candidate_abandoned",
	"candidate_reaped",
	"recovery_classified",
	"candidate_target_observed",
	"target_reached",
	"verification_gap_found",
	"run_archive_intent",
	"run_archived",
	"verified",
	"completion_audited",
	"refinement_recorded",
	"completed",
	"stop_requested",
	"budget_limited",
	"blocked",
	"workflow_coordinator_lease_acquired",
	"workflow_coordinator_lease_renewed",
	"workflow_coordinator_fenced",
	"workflow_dispatch_readiness_observed",
	"workflow_resource_lease_acquired",
	"workflow_task_lease_heartbeat",
	"workflow_ownership_lease_acquired",
	"workflow_dispatch_intent",
	"workflow_child_identity_bound",
	"workflow_child_outcome_committed",
	"workflow_external_blocker_recorded",
	"workflow_external_blocker_resolved",
	"workflow_effect_intent",
	"workflow_effect_completed",
	"workflow_effect_ambiguous",
	"workflow_process_group_owned",
	"workflow_process_group_fenced",
	"workflow_process_group_reaped",
	"workflow_lease_release_recorded",
	"workflow_lease_quarantined",
	"workflow_scheduler_observation",
	"workflow_progress_lease_acquired",
	"workflow_progress_stalled",
	"workflow_progress_lease_closed",
	"workflow_progress_recovery_started",
	"workflow_recovery_started",
	"workflow_reconciliation_recorded",
	"workflow_observation_outcome_recorded",
	"workflow_completion_cut_sealed",
	"workflow_late_observation_policy_recorded",
	"workflow_cancellation_intent",
	"workflow_cancellation_descendants_reconciled",
	"workflow_cancelled",
	"checkpoint_budget_observed",
	"knowledge_record_committed",
	"adaptive_observed",
	"adaptive_observation_coalesced",
	"adaptive_observation_superseded",
	"adaptive_observation_stale",
	"adaptive_observation_cancelled",
	"adaptive_controller_recovered",
	"adaptive_reconciled",
	"adaptive_allocation_intent",
	"adaptive_allocation_applied",
	"adaptive_allocation_uncertain",
	"adaptive_allocation_reconciled",
	"adaptive_review_started",
	"adaptive_review_completed",
	"adaptive_review_cancelled",
	"adaptive_review_fenced",
	"adaptive_review_recovered",
	"adaptive_review_stale_result",
	"adaptive_allocation_reserved",
	"adaptive_allocation_reallocated",
	"adaptive_measured",
	"adaptive_rollback_applied",
	"improvement_proposed",
	"improvement_reviewed",
	"policy_revision_recorded",
	"efficiency_red_team_scheduled",
	"efficiency_red_team_snapshot_published",
	"efficiency_red_team_started",
	"efficiency_red_team_completed",
	"efficiency_red_team_overlap_rejected",
	"efficiency_red_team_catch_up_consumed",
	"efficiency_red_team_failed",
	"efficiency_red_team_suggestion_recorded",
]);

export interface WorkflowStoreCommitInput<TPayload extends WorkflowEventPayload> {
	workflowId: string;
	payload: TPayload;
	expectedHead: WorkflowJournalHead;
	semanticBinding: WorkflowSemanticMutationBinding;
	epochRef: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	idempotencyKey: string;
	writerIdentity: string;
	executionKey: string | null;
	crashHook?: DurableStoreCrashBoundaryHook;
}

export interface WorkflowSemanticHead {
	workflowId: string;
	sequence: number;
	eventDigest: string | null;
	stateDigest: string;
	epochRef: WorkflowEpochRef;
	generation: number;
}

export interface WorkflowSemanticMutationBinding {
	mutationId: string;
	baselineDigest: string;
	expectedGenerations: Readonly<Record<string, number>>;
	ownerId: string;
	phase: WorkflowPhaseId;
	reducerDigest: string;
	semanticHead: WorkflowSemanticHead;
	expectedHead: WorkflowJournalHead;
	idempotencyKey: string;
	executionKey: string | null;
	writerIdentity: string;
	leaseRef: WorkflowLeaseRef;
	epochRef: WorkflowEpochRef;
}

export interface WorkflowSemanticTransitionPreview {
	workflowId: string;
	mutationId: string;
	ownerId: string;
	phase: WorkflowPhaseId;
	reducerDigest: string;
	baselineDigest: string;
	expectedGenerations: Readonly<Record<string, number>>;
	expectedHead: WorkflowJournalHead;
	semanticHead: WorkflowSemanticHead;
	payloadDigest: string;
	leaseRef: WorkflowLeaseRef;
	epochRef: WorkflowEpochRef;
	writerIdentity: string;
	executionKey: string | null;
	idempotencyKey: string;
}

export function previewWorkflowSemanticTransition(input: {
	payload: WorkflowEventPayload;
	binding: WorkflowSemanticMutationBinding;
	expectedHead: WorkflowJournalHead;
	epochRef: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	writerIdentity: string;
	executionKey: string | null;
	idempotencyKey: string;
	workflowId: string;
}): WorkflowSemanticTransitionPreview {
	const generations = Object.values(input.binding.expectedGenerations);
	if (
		input.workflowId.length === 0 ||
		input.binding.mutationId.length === 0 ||
		input.binding.ownerId.length === 0 ||
		input.binding.phase.length === 0 ||
		input.binding.reducerDigest.length === 0 ||
		input.binding.baselineDigest.length === 0 ||
		generations.some((generation) => !Number.isSafeInteger(generation) || generation < 0) ||
		input.binding.semanticHead.workflowId !== input.expectedHead.workflowId ||
		input.binding.semanticHead.sequence !== input.expectedHead.sequence ||
		input.binding.semanticHead.eventDigest !== input.expectedHead.eventDigest ||
		digestObject(input.binding.expectedHead) !== digestObject(input.expectedHead) ||
		digestObject(input.binding.epochRef) !== digestObject(input.epochRef) ||
		digestObject(input.binding.leaseRef) !== digestObject(input.leaseRef) ||
		input.binding.writerIdentity !== input.writerIdentity ||
		input.binding.executionKey !== input.executionKey ||
		input.binding.idempotencyKey !== input.idempotencyKey
	)
		throw new Error(
			"Workflow semantic preview is not bound to the current owner, phase, reducer, lease, epoch, writer, execution, or idempotency tuple.",
		);
	return {
		workflowId: input.workflowId,
		mutationId: input.binding.mutationId,
		ownerId: input.binding.ownerId,
		phase: input.binding.phase,
		reducerDigest: input.binding.reducerDigest,
		baselineDigest: input.binding.baselineDigest,
		expectedGenerations: structuredClone(input.binding.expectedGenerations),
		expectedHead: input.expectedHead,
		semanticHead: input.binding.semanticHead,
		payloadDigest: digestObject(input.payload),
		leaseRef: input.leaseRef,
		epochRef: input.epochRef,
		writerIdentity: input.writerIdentity,
		executionKey: input.executionKey,
		idempotencyKey: input.idempotencyKey,
	};
}

export interface WorkflowJournalCommit<TPayload extends WorkflowEventPayload> {
	workflowId: string;
	sequence: number;
	payload: TPayload;
	payloadBytes: Uint8Array;
	payloadDigest: string;
	priorEventDigest: string | null;
	eventDigest: string;
	recordVersion: 1;
	generationId: string;
	recordMac: string;
	recordChecksum: string;
	expectedHead: WorkflowJournalHead;
	epochRef: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	idempotencyKey: string;
	returnProofId: string;
	commitReturnProof: WorkflowCommitReturnProof;
	preparedFrameDigest: string;
	committedFrameDigest: string;
	keyId: string;
	preparedFrameMac: string;
	committedFrameMac: string;
	preparedFrameChecksum: string;
	committedFrameChecksum: string;
	semanticBinding: WorkflowSemanticMutationBinding;
	executionKey: string | null;
	writerIdentity: string;
}

export interface WorkflowStoreCommitResult<TPayload extends WorkflowEventPayload> {
	status: "committed" | "already_committed";
	payload: TPayload;
	commit: WorkflowJournalCommit<TPayload>;
	state: unknown;
	head: WorkflowJournalHead;
}

export interface WorkflowStoreReplayInput {
	workflowId: string;
	fromSequence: number;
	expectedStoreEpoch: number;
}

export interface WorkflowStoreReplayResult {
	workflowId: string;
	executionKey: string | null;
	events: readonly WorkflowJournalCommit<WorkflowEventPayload>[];
	head: WorkflowJournalHead;
	quarantined: boolean;
	quarantineReason: WorkflowQuarantineReason | null;
}

export interface WorkflowRuntimeStoreIdentity {
	storeKind: "workflow" | "knowledge";
	namespace: string;
	rootDir: string;
	storeId: string;
	workflowId: string;
	identityDigest: string;
}

/**
 * Durable capabilities exposed by the authenticated workflow runtime.
 *
 * Knowledge is a projection over this authority. The context intentionally
 * carries the workflow outbox and descriptor-backed auxiliary files rather
 * than introducing a second knowledge journal or key authority.
 */
export interface WorkflowRuntimeStoreDurableContext {
	readonly generationId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly currentLeaseRef: () => WorkflowLeaseRef;
	readonly outbox: WorkflowOutboxAppender;
	readonly auxiliaryStore: WorkflowRuntimeAuxiliaryStore;
	withExclusiveLease<T>(boundary: string, operation: () => Promise<T>): Promise<T>;
	recoverJournal(): Promise<WorkflowJournalRecoveryResult>;
}

export interface WorkflowRuntimeAuxiliaryStore {
	read(name: string): Promise<Uint8Array | null>;
	write(name: string, bytes: Readonly<Uint8Array>): Promise<void>;
}

/** Authenticated delete capability reserved for host-owned learning promotion rollback. */
export interface WorkflowLearningPromotionAuxiliaryStore extends WorkflowRuntimeAuxiliaryStore {
	remove(name: string, expectedBytesDigest: string): Promise<void>;
}

export type WorkflowLearningPromotionDurableContext = Omit<WorkflowRuntimeStoreDurableContext, "auxiliaryStore"> & {
	readonly auxiliaryStore: WorkflowLearningPromotionAuxiliaryStore;
};

export interface WorkflowRuntimeStore {
	readonly identity: WorkflowRuntimeStoreIdentity;
	readonly durableContext?: WorkflowRuntimeStoreDurableContext;
	commit<TPayload extends WorkflowEventPayload>(
		input: WorkflowStoreCommitInput<TPayload>,
	): Promise<WorkflowStoreCommitResult<TPayload>>;
	replay(input: WorkflowStoreReplayInput): Promise<WorkflowStoreReplayResult>;
	publishArtifact(
		input: WorkflowArtifactPublishInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowArtifactPublishResult>;
	publishSnapshot(
		input: WorkflowSnapshotPublishInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowSnapshotPublishResult>;
	compareAndSwapProjection(
		input: WorkflowProjectionCasInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowProjectionCasResult>;
	appendOutbox(
		input: WorkflowOutboxAppendInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowOutboxAppendResult>;
	replaceCoordinatorEpoch(
		nextEpoch: WorkflowEpochRef,
		generationBinding: WorkflowGenerationBinding,
	): Promise<WorkflowGenerationRotation>;
	replaceStoreEpoch(
		nextEpoch: WorkflowEpochRef,
		generationBinding: WorkflowGenerationBinding,
	): Promise<WorkflowGenerationRotation>;
}

export interface WorkflowRuntimeStoreOpenInput {
	artifactRoot: string;
	workflowRoot: string;
	descriptorRoots: WorkflowDescriptorRootAdapters;
	workflowId: string;
	rootSessionId: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	writerIdentity: string;
	keyProvider: WorkflowJournalKeyProvider;
	appendLease: WorkflowAppendLease;
	leaseRef: WorkflowLeaseRef;
	descriptorFs: WorkflowDescriptorFs;
	now(): string;
	deferredOwnerValidators?: WorkflowDeferredEventOwnerValidators;
}

// A owns openWorkflowRuntimeStore in runtime-store-adapter.ts. K exports only
// WorkflowRuntimeStoreOpenInput and WorkflowRuntimeStore for that adapter.

export interface WorkflowJournalEvent {
	workflowId: string;
	sequence: number;
	kind: WorkflowEventType;
	eventType: WorkflowEventType;
	payload: WorkflowEventPayload;
	payloadBytes: Uint8Array;
	payloadDigest: string;
	priorEventDigest: string | null;
	eventDigest: string;
	recordVersion: 1;
	generationId: string;
	recordMac: string;
	recordChecksum: string;
	idempotencyKey: string;
	returnProofId: string;
	expectedHead: WorkflowJournalHead;
	executionKey: string | null;
	epochRef: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	writerIdentity: string;
	preparedFrameDigest: string;
	committedFrameDigest: string;
	keyId: string;
	preparedFrameMac: string;
	committedFrameMac: string;
	preparedFrameChecksum: string;
	committedFrameChecksum: string;
	semanticBinding: WorkflowSemanticMutationBinding;
	commitReturnProof: WorkflowCommitReturnProof;
}

export interface WorkflowAuthenticatedMutationTuple {
	recordVersion: 1;
	generationId: string;
	workflowId: string;
	mutationId: string;
	expectedHead: WorkflowJournalHead;
	sequence: number;
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
}

export interface WorkflowCommitReturnProof {
	recordVersion: 1;
	generationId: string;
	mutationId: string;
	workflowId: string;
	sequence: number;
	eventDigest: string;
	committedFrameDigest: string;
	expectedHead: WorkflowJournalHead;
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
	returnedAt: string;
	proofDigest: string;
}

export const DurableStoreCrashBoundary = Object.freeze({
	beforePrepare: "before_prepare",
	afterPreparedAppendBeforePreparedFileFlush: "after_prepared_append_before_prepared_file_flush",
	afterPreparedFileFlushBeforeCommittedMarkerAppend: "after_prepared_file_flush_before_committed_marker_append",
	afterCommittedMarkerAppendBeforeCommittedFileFlush: "after_committed_marker_append_before_committed_file_flush",
	afterCommittedFileFlushBeforeDirectoryFlush: "after_committed_file_flush_before_directory_flush",
	afterDirectoryFlushBeforeArtifactPublish: "after_directory_flush_before_artifact_publish",
	afterArtifactPublishBeforeSnapshotPublish: "after_artifact_publish_before_snapshot_publish",
	afterSnapshotAppendBeforeSnapshotFileFlush: "after_snapshot_append_before_snapshot_file_flush",
	afterSnapshotFileFlushBeforeSnapshotRename: "after_snapshot_file_flush_before_snapshot_rename",
	afterSnapshotRenameBeforeProjectionCas: "after_snapshot_rename_before_projection_cas",
	afterProjectionCasBeforeOutbox: "after_projection_cas_before_outbox",
	afterOutboxAppendBeforeOutboxFileFlush: "after_outbox_append_before_outbox_file_flush",
	afterOutboxFileFlush: "after_outbox_file_flush",
	afterRotationPrepareBeforeFence: "after_rotation_prepare_before_fence",
	afterRotationFenceBeforeLeaseTransfer: "after_rotation_fence_before_lease_transfer",
	afterRotationLeaseTransferBeforeRecord: "after_rotation_lease_transfer_before_record",
	afterRotationRecordBeforeManifest: "after_rotation_record_before_manifest",
	afterRotationManifestBeforeCommit: "after_rotation_manifest_before_commit",
	afterRotationCommitBeforeRetire: "after_rotation_commit_before_retire",
	afterRotationRetireBeforeRebind: "after_rotation_retire_before_rebind",
} as const);

export type DurableStoreCrashBoundary = (typeof DurableStoreCrashBoundary)[keyof typeof DurableStoreCrashBoundary];

export interface DurableStoreCrashBoundaryHook {
	checkpoint: DurableStoreCrashBoundary;
	before(input: { storeId: string; mutationId: string; checkpoint: DurableStoreCrashBoundary }): Promise<void>;
	after(input: {
		storeId: string;
		mutationId: string;
		checkpoint: DurableStoreCrashBoundary;
		digest: string;
	}): Promise<void>;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(canonicalizeValue(value));
}

export function parseCanonicalJsonBytes(bytes: Uint8Array): WorkflowCanonicalJsonValue {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error("Workflow canonical payload is not valid UTF-8.", { cause: error });
	}
	const parser = new CanonicalJsonParser(text);
	const value = parser.parseValue();
	parser.skipWhitespace();
	if (!parser.atEnd()) throw new Error("Workflow canonical payload contains trailing bytes.");
	const canonical = canonicalJsonBytes(value);
	if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index])) {
		throw new Error("Workflow canonical payload is not canonically encoded.");
	}
	return value;
}

export function digestObject(value: unknown): string {
	return sha256Hex(canonicalJsonBytes(value));
}

export function sha256Hex(value: Uint8Array | string): string {
	const hash = createHash("sha256");
	hash.update(value);
	return hash.digest("hex");
}

export async function resolveAndVerifyWorkflowHostReceipt(input: {
	context: WorkflowHostReceiptConsumerContext;
	workflowId: string;
	expectedBindingDigest: string;
	receipt: WorkflowVerifiedHostReceipt;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
}): Promise<WorkflowVerifiedHostReceipt> {
	if (!/^[0-9a-f]{64}$/u.test(input.expectedBindingDigest))
		throw new Error("Workflow host receipt binding digest is not canonical.");
	const artifact = await input.context.artifactResolver.resolve(input.receipt.artifactRef);
	if (
		!artifact.exists ||
		!artifact.envelope.immutable ||
		artifact.verifiedDigest !== input.receipt.artifactRef.digest ||
		artifact.verifiedSizeBytes !== input.receipt.artifactRef.sizeBytes ||
		artifact.bytes.byteLength !== input.receipt.artifactRef.sizeBytes ||
		sha256Hex(artifact.bytes) !== input.receipt.artifactRef.digest
	) {
		throw new Error("Workflow host receipt artifact is not resolver-verified and content-addressed.");
	}
	const trustedNowMs = Date.parse(input.trustedNow);
	if (!Number.isFinite(trustedNowMs)) throw new Error("Workflow host receipt trusted time is invalid.");
	const resolved = await input.context.receiptResolver.resolve({
		receipt: input.receipt,
		workflowId: input.workflowId,
		expectedBindingDigest: input.expectedBindingDigest,
		artifactBytes: artifact.bytes,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
		keyResolver: input.context.keyResolver,
		revokedReceiptIds: input.context.revokedReceiptIds,
	});
	const key = await input.context.keyResolver.resolve(resolved.keyId);
	if (key.revoked || resolved.issuerId !== key.ownerPrincipal)
		throw new Error("Workflow host receipt issuer is not authenticated by its verification key.");
	return resolved;
}

export type WorkflowCanonicalJsonValue =
	| null
	| boolean
	| number
	| string
	| WorkflowCanonicalJsonValue[]
	| WorkflowCanonicalJsonObject;

export interface WorkflowCanonicalJsonObject {
	[key: string]: WorkflowCanonicalJsonValue;
}

function isCanonicalJsonObject(value: unknown): value is WorkflowCanonicalJsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0)
		return false;
	return Object.values(value).every((item) => isCanonicalJsonValue(item));
}

function isCanonicalJsonValue(value: unknown): value is WorkflowCanonicalJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value))
		return Object.keys(value).length === value.length && value.every((item) => isCanonicalJsonValue(item));
	return isCanonicalJsonObject(value);
}

class CanonicalJsonParser {
	private index = 0;

	constructor(private readonly text: string) {}

	atEnd(): boolean {
		return this.index >= this.text.length;
	}

	skipWhitespace(): void {
		while (this.index < this.text.length && " \t\n\r".includes(this.text[this.index] ?? "")) this.index += 1;
	}

	parseValue(): WorkflowCanonicalJsonValue {
		this.skipWhitespace();
		const character = this.text[this.index];
		if (character === "{") return this.parseObject();
		if (character === "[") return this.parseArray();
		if (character === '"') return this.parseString();
		if (this.text.startsWith("true", this.index)) {
			this.index += 4;
			return true;
		}
		if (this.text.startsWith("false", this.index)) {
			this.index += 5;
			return false;
		}
		if (this.text.startsWith("null", this.index)) {
			this.index += 4;
			return null;
		}
		return this.parseNumber();
	}

	private parseObject(): WorkflowCanonicalJsonObject {
		this.expect("{");
		const result = createCanonicalJsonObject();
		const keys = new Set<string>();
		this.skipWhitespace();
		if (this.consume("}")) return result;
		while (true) {
			this.skipWhitespace();
			if (this.text[this.index] !== '"') throw new Error("Workflow canonical object key must be a string.");
			const key = this.parseString();
			if (keys.has(key)) throw new Error(`Workflow canonical payload contains duplicate key: ${key}`);
			keys.add(key);
			this.skipWhitespace();
			this.expect(":");
			result[key] = this.parseValue();
			this.skipWhitespace();
			if (this.consume("}")) return result;
			this.expect(",");
		}
	}

	private parseArray(): WorkflowCanonicalJsonValue[] {
		this.expect("[");
		const result: WorkflowCanonicalJsonValue[] = [];
		this.skipWhitespace();
		if (this.consume("]")) return result;
		while (true) {
			result.push(this.parseValue());
			this.skipWhitespace();
			if (this.consume("]")) return result;
			this.expect(",");
		}
	}

	private parseString(): string {
		this.expect('"');
		let result = "";
		while (this.index < this.text.length) {
			const character = this.text[this.index++];
			if (character === '"') return result;
			if (character < " ") throw new Error("Workflow canonical string contains a control character.");
			if (character !== "\\") {
				result += character;
				continue;
			}
			if (this.index >= this.text.length) throw new Error("Workflow canonical string escape is truncated.");
			const escapeCharacter = this.text[this.index++];
			const simpleEscapes: Record<string, string> = {
				'"': '"',
				"\\": "\\",
				"/": "/",
				b: "\b",
				f: "\f",
				n: "\n",
				r: "\r",
				t: "\t",
			};
			if (escapeCharacter in simpleEscapes) {
				result += simpleEscapes[escapeCharacter];
				continue;
			}
			if (escapeCharacter !== "u") throw new Error("Workflow canonical string contains an unsupported escape.");
			const codePoint = this.parseHexCodePoint();
			if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
				if (this.text.slice(this.index, this.index + 2) !== "\\u")
					throw new Error("Workflow canonical string contains an unpaired surrogate.");
				this.index += 2;
				const low = this.parseHexCodePoint();
				if (low < 0xdc00 || low > 0xdfff)
					throw new Error("Workflow canonical string contains an invalid surrogate pair.");
				result += String.fromCodePoint(0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00));
			} else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
				throw new Error("Workflow canonical string contains an unpaired surrogate.");
			} else {
				result += String.fromCodePoint(codePoint);
			}
		}
		throw new Error("Workflow canonical string is unterminated.");
	}

	private parseHexCodePoint(): number {
		const digits = this.text.slice(this.index, this.index + 4);
		if (!/^[0-9a-fA-F]{4}$/.test(digits))
			throw new Error("Workflow canonical string contains an invalid Unicode escape.");
		this.index += 4;
		return Number.parseInt(digits, 16);
	}

	private parseNumber(): number {
		const remaining = this.text.slice(this.index);
		const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining);
		if (match === null) throw new Error("Workflow canonical payload contains an invalid number or token.");
		this.index += match[0].length;
		const value = Number(match[0]);
		if (!Number.isFinite(value)) throw new Error("Workflow canonical payload contains a non-finite number.");
		return value;
	}

	private consume(character: string): boolean {
		if (this.text[this.index] !== character) return false;
		this.index += 1;
		return true;
	}

	private expect(character: string): void {
		if (!this.consume(character)) throw new Error(`Workflow canonical payload expected ${character}.`);
	}
}

function createCanonicalJsonObject(): WorkflowCanonicalJsonObject {
	const result: WorkflowCanonicalJsonObject = {};
	Object.setPrototypeOf(result, null);
	return result;
}

function fixtureReceiptArtifactBytes(ref: WorkflowArtifactRef): Uint8Array {
	return canonicalJsonBytes({
		artifactId: ref.artifactId,
		relativePath: ref.relativePath,
		sourceEventSequence: ref.sourceEventSequence,
		payloadDigest: "fixture",
	});
}

type WorkflowFixtureHostReceiptSignedPreimage = Omit<WorkflowVerifiedHostReceipt, "signature" | "verificationDigest">;

function fixtureHostReceiptSignedPreimageBytes(receipt: WorkflowFixtureHostReceiptSignedPreimage): Uint8Array {
	return canonicalJsonBytes(receipt);
}

export function createFixtureHostReceipt(
	input: Omit<
		WorkflowVerifiedHostReceipt,
		| "signatureAlgorithm"
		| "artifactBytesDigest"
		| "stateDigest"
		| "revision"
		| "verificationDigest"
		| "oneUse"
		| "signature"
	> &
		Partial<Pick<WorkflowVerifiedHostReceipt, "stateDigest" | "revision" | "oneUse" | "signature">>,
): WorkflowVerifiedHostReceipt {
	const artifactBytes = fixtureReceiptArtifactBytes(input.artifactRef);
	const artifactRef = { ...input.artifactRef, digest: sha256Hex(artifactBytes), sizeBytes: artifactBytes.byteLength };
	const signedFields: WorkflowFixtureHostReceiptSignedPreimage = {
		receiptKind: input.receiptKind,
		oneUse: input.oneUse ?? input.receiptKind === "capability",
		receiptId: input.receiptId,
		issuerId: input.issuerId,
		workflowId: input.workflowId,
		bindingDigest: input.bindingDigest,
		payloadDigest: input.payloadDigest,
		artifactRef,
		issuedAt: input.issuedAt,
		validUntil: input.validUntil,
		keyId: input.keyId,
		signatureAlgorithm: "ed25519",
		artifactBytesDigest: sha256Hex(artifactBytes),
		stateDigest: input.stateDigest ?? "fixture-state",
		revision: input.revision ?? 1,
		...(input.capabilityBinding === undefined ? {} : { capabilityBinding: structuredClone(input.capabilityBinding) }),
	};
	const signature = signBytes(
		null,
		Buffer.from(fixtureHostReceiptSignedPreimageBytes(signedFields)),
		FIXTURE_RECEIPT_PRIVATE_KEY,
	).toString("base64");
	const receiptWithoutVerification = { ...signedFields, signature, verificationDigest: "" };
	return { ...receiptWithoutVerification, verificationDigest: digestObject(receiptWithoutVerification) };
}

const FIXTURE_RECEIPT_PRIVATE_KEY = createPrivateKey({
	key: Buffer.from("MC4CAQAwBQYDK2VwBCIEIB5lR90D1Sz+aLcswVjPVOyT/eHed2dLUvDu/z3K1Jkx", "base64"),
	format: "der",
	type: "pkcs8",
});
const FIXTURE_RECEIPT_PUBLIC_KEY = createPublicKey({
	key: Buffer.from("MCowBQYDK2VwAyEA1nUnivt2hj89XJ1A5U/1TY5ib3Vd7qn9412p0ZhKFLM=", "base64"),
	format: "der",
	type: "spki",
});

export function createFixtureHostReceiptConsumerContext(): WorkflowHostReceiptConsumerContext {
	const allowedCapabilities = new Set<WorkflowHostReceiptCapability>([
		"workflow_observation_process",
		"workflow_observation_dataset_receipt",
		"workflow_coordinator_status_projection",
		"workflow_checkpoint_budget_observation",
		"workflow_dispatch_capacity_attestation",
		"workflow_dispatch_path_attestation",
		"workflow_worker_model_dispatch",
		"workflow_recursive_delegation_plan",
		"workflow_decision_packet_delivery",
		"autoresearch_portfolio_frontier_admission",
		"autoresearch_portfolio_projection_commit",
		"portfolio_default_completion",
		"workflow_learning_knowledge_promotion",
		"autoresearch.legacy_scalar_provenance_import",
		"workflow_intent_red_mutation",
		"child_output_delivery_ack",
		"workflow_coordinator_obligation_scheduler",
	]);
	const revokedReceiptIds = new Set<string>();
	const keyResolver: WorkflowReceiptVerificationKeyResolver = {
		resolve: async () => ({
			algorithm: "ed25519",
			ownerPrincipal: "fixture-host",
			allowedCapabilities: new Set(allowedCapabilities),
			generationId: "fixture-generation",
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			fencingDigest: digestObject({
				generationId: "fixture-generation",
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			}),
			revoked: false,
			verify: ({ bytes, signature }) =>
				verifyBytes(null, Buffer.from(bytes), FIXTURE_RECEIPT_PUBLIC_KEY, Buffer.from(signature, "base64")),
		}),
	};
	const receiptResolver = createFixtureHostReceiptResolver(revokedReceiptIds);
	const receiptContext: WorkflowHostReceiptConsumerContext = {
		receiptResolver,
		keyResolver,
		revokedReceiptIds,
		revokeReceipt: async (receiptId) => {
			if (receiptId.length === 0) throw new Error("Fixture receipt revocation identity is invalid.");
			revokedReceiptIds.add(receiptId);
		},
		artifactResolver: {
			resolve: async (ref) => {
				const bytes = fixtureReceiptArtifactBytes(ref);
				return {
					envelope: { ref, payloadKind: "evidence", codec: "canonical_json", immutable: true },
					exists: true,
					bytes,
					verifiedDigest: sha256Hex(bytes),
					verifiedSizeBytes: bytes.byteLength,
				};
			},
		},
		principalAuthorizer: {
			authorize: async (input) => {
				const binding = input.receipt.capabilityBinding;
				if (
					input.receipt.receiptKind !== "capability" ||
					binding === undefined ||
					binding.capability !== input.capability ||
					binding.resourceDigest !== input.resourceDigest ||
					binding.operationDigest !== input.operationDigest ||
					binding.executionIdentity !== (input.executionIdentity ?? null) ||
					binding.sessionId !== (input.sessionId ?? null)
				)
					throw new Error("Fixture host principal capability binding is invalid.");
				const verified = await resolveAndVerifyWorkflowHostReceipt({
					context: receiptContext,
					workflowId: input.workflowId,
					expectedBindingDigest: input.bindingDigest,
					receipt: input.receipt,
					currentStateDigest: input.stateDigest,
					currentRevision: input.revision,
					trustedNow: input.receipt.issuedAt,
				});
				const key = await keyResolver.resolve(verified.keyId);
				if (
					key.revoked ||
					verified.issuerId !== key.ownerPrincipal ||
					key.generationId !== "fixture-generation" ||
					key.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
					key.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
					key.fencingDigest !== digestObject({ generationId: key.generationId, epochRef: input.epochRef }) ||
					!key.allowedCapabilities.has(input.capability)
				)
					throw new Error("Fixture host principal capability key is not authorized.");
				return {
					authenticatedPrincipal: key.ownerPrincipal,
					keyOwnerPrincipal: key.ownerPrincipal,
					capability: input.capability,
					workflowId: input.workflowId,
					bindingDigest: input.bindingDigest,
					receipt: verified,
					stateDigest: input.stateDigest,
					revision: input.revision,
					epochRef: input.epochRef,
					validity: { issuedAt: verified.issuedAt, validUntil: verified.validUntil },
					...(input.executionIdentity === undefined ? {} : { executionIdentity: input.executionIdentity }),
					...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
					authorizationDigest: digestObject({
						principal: key.ownerPrincipal,
						capability: input.capability,
						workflowId: input.workflowId,
						bindingDigest: input.bindingDigest,
						receiptId: verified.receiptId,
						receiptDigest: digestObject(verified),
						keyId: verified.keyId,
						stateDigest: input.stateDigest,
						revision: input.revision,
						epochRef: input.epochRef,
						generationId: key.generationId,
						fencingDigest: key.fencingDigest,
						resourceDigest: input.resourceDigest,
						operationDigest: input.operationDigest,
						executionIdentity: input.executionIdentity ?? null,
						sessionId: input.sessionId ?? null,
					}),
				};
			},
		},
	};
	return receiptContext;
}

export function createFixtureHostReceiptResolver(
	revokedReceiptIds: ReadonlySet<string> = new Set<string>(),
): WorkflowHostReceiptResolver {
	const consumedOneUseReceipts = new Set<string>();
	const consumptionWitnesses = new Map<string, WorkflowHostReceiptConsumptionWitness>();
	return {
		async resolve(input) {
			const key = await input.keyResolver.resolve(input.receipt.keyId);
			if (key.algorithm !== input.receipt.signatureAlgorithm)
				throw new Error("Fixture receipt key algorithm mismatch.");
			const issuedAt = Date.parse(input.receipt.issuedAt);
			const validUntil = Date.parse(input.receipt.validUntil);
			const { signature: _signature, verificationDigest: _verificationDigest, ...signedFields } = input.receipt;
			const signedBytes = fixtureHostReceiptSignedPreimageBytes(signedFields);
			if (
				revokedReceiptIds.has(input.receipt.receiptId) ||
				key.revoked ||
				input.receipt.workflowId !== input.workflowId ||
				input.receipt.bindingDigest !== input.expectedBindingDigest ||
				input.receipt.issuerId !== key.ownerPrincipal ||
				!Number.isFinite(issuedAt) ||
				!Number.isFinite(validUntil) ||
				!Number.isFinite(Date.parse(input.trustedNow)) ||
				validUntil <= issuedAt ||
				!Number.isSafeInteger(input.receipt.revision) ||
				input.receipt.revision < 1 ||
				input.receipt.artifactBytesDigest !== sha256Hex(input.artifactBytes) ||
				input.receipt.stateDigest !== input.currentStateDigest ||
				input.receipt.revision !== input.currentRevision ||
				Date.parse(input.trustedNow) < issuedAt ||
				Date.parse(input.trustedNow) >= validUntil ||
				input.receipt.verificationDigest !== digestObject({ ...input.receipt, verificationDigest: "" }) ||
				!key.verify({ bytes: signedBytes, signature: input.receipt.signature })
			)
				throw new Error("Fixture host receipt is revoked, not cryptographically valid, current, or trusted.");
			return structuredClone(input.receipt);
		},
		async consumeIfOneUse(input) {
			if (
				input.receipt.workflowId !== input.workflowId ||
				input.receipt.bindingDigest !== input.expectedBindingDigest ||
				input.receipt.revision !== input.currentRevision
			)
				throw new Error("Fixture host receipt is not bound to the current workflow, binding, or revision.");
			if (!input.receipt.oneUse) return;
			if (consumedOneUseReceipts.has(input.receipt.receiptId))
				throw new Error("Fixture host receipt was already consumed.");
			consumedOneUseReceipts.add(input.receipt.receiptId);
			consumptionWitnesses.set(input.receipt.receiptId, {
				receiptId: input.receipt.receiptId,
				workflowId: input.workflowId,
				bindingDigest: input.expectedBindingDigest,
				capability: input.receipt.capabilityBinding?.capability ?? null,
				resourceDigest: input.receipt.capabilityBinding?.resourceDigest ?? null,
				operationDigest: input.receipt.capabilityBinding?.operationDigest ?? null,
				receiptDigest: digestObject(input.receipt),
				consumedAt: new Date().toISOString(),
				consumptionSequence: consumptionWitnesses.size + 1,
			});
		},
		async resolveConsumptionWitness(input) {
			const witness = consumptionWitnesses.get(input.receiptId);
			if (
				witness === undefined ||
				witness.workflowId !== input.workflowId ||
				witness.bindingDigest !== input.expectedBindingDigest
			)
				throw new Error("Fixture host receipt has no matching durable one-use witness.");
			return structuredClone(witness);
		},
	};
}

export async function evaluateWorkflowMetric(
	metric: WorkflowScorecardMetric,
	runs: readonly WorkflowMetricRunRecord[],
	receiptContext: WorkflowHostReceiptConsumerContext,
	currentStateDigest: string,
	currentRevision: number,
	trustedNow: string,
	currentBinding: WorkflowMetricEvaluationContext,
): Promise<WorkflowMetricEvaluation> {
	if (
		currentBinding.currentWorkflowId.trim().length === 0 ||
		currentBinding.currentApprovedClosureDigest.trim().length === 0 ||
		currentBinding.currentScorecardDigest.trim().length === 0
	) {
		throw new Error("Metric evaluation requires the current workflow, closure, and scorecard binding.");
	}
	const repeatability = metric.repeatability;
	for (const run of runs) {
		if (
			run.workflowId !== currentBinding.currentWorkflowId ||
			run.approvedClosureDigest !== currentBinding.currentApprovedClosureDigest ||
			run.scorecardDigest !== currentBinding.currentScorecardDigest
		) {
			throw new Error("Metric run is not bound to the current workflow, closure, and scorecard.");
		}
		const evidenceRefs = [
			...run.determinismEvidenceRefs,
			...run.falsificationEvidenceRefs,
			...run.attackEvidenceRefs,
			...run.guardEvidenceRefs,
			run.evidenceRef,
		];
		for (const ref of evidenceRefs) {
			const artifact = await receiptContext.artifactResolver.resolve(ref);
			if (
				!artifact.exists ||
				!artifact.envelope.immutable ||
				artifact.verifiedDigest !== ref.digest ||
				artifact.verifiedSizeBytes !== ref.sizeBytes ||
				artifact.bytes.byteLength !== ref.sizeBytes ||
				sha256Hex(artifact.bytes) !== ref.digest
			)
				throw new Error("Metric evidence bytes are not resolver-verified and content-addressed.");
		}
		const bindingDigest = workflowMetricRunBindingDigest(run, metric);
		await resolveAndVerifyWorkflowHostReceipt({
			context: receiptContext,
			workflowId: currentBinding.currentWorkflowId,
			expectedBindingDigest: bindingDigest,
			receipt: run.hostReceipt,
			currentStateDigest,
			currentRevision,
			trustedNow,
		});
		await resolveAndVerifyWorkflowHostReceipt({
			context: receiptContext,
			workflowId: currentBinding.currentWorkflowId,
			expectedBindingDigest: digestObject({ runBindingDigest: bindingDigest, trustedNow }),
			receipt: run.trustedClockReceipt,
			currentStateDigest,
			currentRevision,
			trustedNow,
		});
	}
	const expectedRuns = repeatability.kind === "single" ? 1 : repeatability.runs;
	const rejectionReasons = new Set<WorkflowMetricEvaluation["rejectionReasons"][number]>();
	if (runs.length < expectedRuns) rejectionReasons.add("missing_run");
	if (runs.length > expectedRuns) rejectionReasons.add("extra_run");
	const runIndexes = new Set(runs.map((run) => run.runIndex));
	if (
		runIndexes.size !== runs.length ||
		Array.from(runIndexes).some(
			(runIndex) => !Number.isSafeInteger(runIndex) || runIndex < 1 || runIndex > expectedRuns,
		)
	)
		rejectionReasons.add("duplicate_run");
	if (
		new Set(runs.map((run) => run.hostExecutionId)).size !== runs.length ||
		runs.some((run) => run.hostExecutionId.length === 0)
	)
		rejectionReasons.add("execution_replay");
	if (runs.some((run) => !Number.isFinite(run.observedValue))) rejectionReasons.add("non_finite_value");
	if (
		new Set(runs.map((run) => run.evaluationId)).size > 1 ||
		new Set(runs.map((run) => run.approvedClosureDigest)).size > 1 ||
		new Set(runs.map((run) => run.scorecardDigest)).size > 1 ||
		runs.some(
			(run) =>
				run.metricId !== metric.metricId ||
				run.measurementCommandDigest !== metric.measurementCommandDigest ||
				run.parserDigest !== metric.parserDigest ||
				run.evaluatorDigest !== metric.evaluatorDigest ||
				run.approvedClosureDigest.length === 0 ||
				run.scorecardDigest.length === 0 ||
				run.baselineDigest !== digestObject(metric.baseline),
		)
	)
		rejectionReasons.add("digest_mismatch");
	if (
		runs.some(
			(run) =>
				run.workflowId.length === 0 ||
				run.hostReceipt.receiptKind !== "usage" ||
				run.trustedClockReceipt.receiptKind !== "clock" ||
				run.hostReceipt.workflowId !== run.workflowId ||
				run.hostReceipt.signatureAlgorithm !== "ed25519" ||
				run.hostReceipt.verificationDigest.length === 0 ||
				run.evidenceRef.digest.length === 0 ||
				run.determinismEvidenceRefs.length === 0 ||
				run.falsificationEvidenceRefs.length === 0 ||
				run.attackEvidenceRefs.length === 0 ||
				run.guardEvidenceRefs.length === 0,
		)
	)
		rejectionReasons.add("evidence_missing");
	if (
		repeatability.kind === "repeated" &&
		(new Set(runs.map((run) => run.inputPartition)).size > 1 || new Set(runs.map((run) => run.inputDigest)).size > 1)
	)
		rejectionReasons.add("digest_mismatch");
	if (metric.baseline !== null && runs.some((run) => run.baselineDigest !== digestObject(metric.baseline)))
		rejectionReasons.add("baseline_mismatch");
	if (
		repeatability.kind === "single" &&
		runs.some((run) => run.inputDigest !== repeatability.deterministicInputClosureDigest)
	)
		rejectionReasons.add("digest_mismatch");
	if (
		repeatability.kind === "held_out" &&
		runs.some((run) => run.inputPartition !== "held_out" || run.inputDigest !== repeatability.heldOutInputDigest)
	)
		rejectionReasons.add("held_out_mismatch");
	const values = runs.filter((run) => Number.isFinite(run.observedValue)).map((run) => run.observedValue);
	const mean = values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
	const ordered = [...values].sort((left, right) => left - right);
	const median =
		ordered.length === 0
			? null
			: ordered.length % 2 === 1
				? ordered[(ordered.length - 1) / 2]
				: (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2;
	const aggregate = repeatability.kind === "single" ? "single" : repeatability.aggregation;
	const aggregateValue = aggregate === "mean" ? mean : median;
	const variance = mean === null ? null : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
	const maxVariance = repeatability.kind === "single" ? repeatability.allowedVariance : repeatability.maxVariance;
	if (variance === null || variance > maxVariance) rejectionReasons.add("variance_exceeded");
	const targetSatisfied =
		aggregateValue !== null &&
		(metric.direction === "maximize"
			? aggregateValue >= metric.target - metric.tolerance
			: metric.direction === "minimize"
				? aggregateValue <= metric.target + metric.tolerance
				: Math.abs(aggregateValue - metric.target) <= metric.tolerance);
	if (!targetSatisfied) rejectionReasons.add("target_missed");
	return {
		evaluationId: runs[0]?.evaluationId ?? null,
		metricId: metric.metricId,
		runCount: runs.length,
		aggregate,
		aggregateValue,
		variance,
		heldOutInputDigest: metric.repeatability.kind === "held_out" ? metric.repeatability.heldOutInputDigest : null,
		repeatabilitySatisfied:
			!rejectionReasons.has("missing_run") &&
			!rejectionReasons.has("extra_run") &&
			!rejectionReasons.has("duplicate_run") &&
			!rejectionReasons.has("non_finite_value") &&
			!rejectionReasons.has("digest_mismatch") &&
			!rejectionReasons.has("held_out_mismatch") &&
			!rejectionReasons.has("variance_exceeded"),
		targetSatisfied,
		accepted: rejectionReasons.size === 0,
		rejectionReasons: Array.from(rejectionReasons).sort(),
	};
}

function canonicalizeValue(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value.replace(/\r\n?/g, "\n"));
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Canonical workflow payload contains a non-finite number.");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (Object.keys(value).length !== value.length)
			throw new Error("Canonical workflow payload contains a sparse array.");
		return `[${Array.from(value, canonicalizeValue).join(",")}]`;
	}
	if (typeof value === "object") {
		if (!isCanonicalJsonObject(value)) throw new Error("Canonical workflow payload contains an unsupported object.");
		const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeValue(item)}`).join(",")}}`;
	}
	throw new Error("Canonical workflow payload contains an unsupported value.");
}
