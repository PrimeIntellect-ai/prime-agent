import {
	digestObject,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostReceiptCapability,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowJournalHead,
	type WorkflowLeaseRef,
	type WorkflowObservationCompletionCut,
	type WorkflowObservationDatasetMetadata,
	type WorkflowObservationKind,
	type WorkflowObservationLatePolicyRecord,
	type WorkflowObservationOutcome,
	type WorkflowObservationOutcomeRecord,
	type WorkflowRuntimeEventPayload,
	type WorkflowRuntimeStore,
	type WorkflowStoreCommitResult,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";

export type {
	WorkflowObservationCompletionCut,
	WorkflowObservationDatasetAccessAuthority,
	WorkflowObservationDatasetCoverage,
	WorkflowObservationDatasetGapClassification,
	WorkflowObservationDatasetLifecycle,
	WorkflowObservationDatasetMetadata,
	WorkflowObservationDatasetModality,
	WorkflowObservationDatasetProvenance,
	WorkflowObservationDatasetRestoreVerification,
	WorkflowObservationDatasetSplit,
	WorkflowObservationDatasetValidation,
	WorkflowObservationHoldoutAggregate,
	WorkflowObservationKind,
	WorkflowObservationOutcome,
} from "./contracts.js";

const DIGEST = /^[0-9a-f]{64}$/u;
const MODALITIES = ["time_series", "order_book", "position_book", "pricing_stream"] as const;
const KINDS = ["dataset", "task_result", "evidence", "progress", "supersession", "quarantine"] as const;
const POLICIES = ["no_op", "reopen", "compensate"] as const;

export interface WorkflowObservationInput {
	readonly observationId: string;
	readonly observationDigest: string;
	readonly baseRevisionDigest: string;
	readonly processGeneration: string;
	readonly coordinatorTerm: number;
	readonly effectIdempotencyKey: string;
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly kind: WorkflowObservationKind;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly processReceipt: WorkflowVerifiedHostReceipt;
	readonly decisionRef?: WorkflowDecisionRef;
	readonly datasetMetadata?: WorkflowObservationDatasetMetadata;
}

export type WorkflowObservationDigestInput = Omit<WorkflowObservationInput, "observationDigest" | "processReceipt">;

export type WorkflowObservationCrashCheckpoint = "before_outcome_commit" | "after_outcome_commit_before_return";

export interface WorkflowObservationAuthorityInput {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly workflowId: string;
	readonly sessionId: string;
	readonly writerIdentity: string;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly processGeneration: string;
	readonly coordinatorTerm: number;
	readonly latePolicy?: (input: {
		readonly observationId: string;
		readonly observationDigest: string;
		readonly baseRevisionDigest: string;
		readonly watermark: WorkflowObservationWatermark;
	}) => "no_op" | "reopen" | "compensate" | Promise<"no_op" | "reopen" | "compensate">;
	readonly now?: () => string;
	readonly crash?: (checkpoint: WorkflowObservationCrashCheckpoint) => void | Promise<void>;
}

export interface WorkflowObservationWatermark {
	readonly cutId: string;
	readonly journalSequence: number;
	readonly journalHeadDigest: string;
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
	readonly cutDigest: string;
}

export interface WorkflowObservationResult {
	readonly observationId: string;
	readonly observationDigest: string;
	readonly status: WorkflowObservationOutcome;
	readonly outcomeDigest: string;
	readonly effectIdempotencyKey: string;
	readonly journalSequence: number;
	readonly journalHeadDigest: string;
	readonly causalWatermark: { readonly sequence: number; readonly eventDigest: string };
	readonly acceptedObservationCut: WorkflowObservationWatermark | null;
	readonly reason: string | null;
}

export interface WorkflowCompletionCutInput {
	readonly cutId: string;
	readonly finalClosureObservationId: string;
	readonly trainingClosureRootDigest: string;
	readonly validationClosureRootDigest: string;
	readonly holdoutClosureRootDigest: string;
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly closureReceipt: WorkflowVerifiedHostReceipt;
	readonly processGeneration: string;
	readonly coordinatorTerm: number;
}

export interface WorkflowCompletionCutResult {
	readonly status: "sealed" | "stale" | "rejected";
	readonly watermark: WorkflowObservationWatermark | null;
	readonly reason: string | null;
}

export interface WorkflowLateObservationInput {
	readonly observationId: string;
	readonly observationDigest: string;
	readonly baseRevisionDigest: string;
}

export interface WorkflowLateObservationResult {
	readonly status: "no_op" | "reopen" | "compensate";
	readonly watermark: WorkflowObservationWatermark | null;
	readonly journalSequence: number | null;
	readonly journalHeadDigest: string | null;
}

export interface WorkflowObservationAuthority {
	processObservation(input: WorkflowObservationInput): Promise<WorkflowObservationResult>;
	sealCompletionCut(input: WorkflowCompletionCutInput): Promise<WorkflowCompletionCutResult>;
	readWatermark(): Promise<WorkflowObservationWatermark | null>;
	evaluateLateObservation(input: WorkflowLateObservationInput): Promise<WorkflowLateObservationResult>;
}

type ObservationOutcomePayload = Extract<
	WorkflowRuntimeEventPayload,
	{ kind: "workflow_observation_outcome_recorded" }
>;
type CompletionCutPayload = Extract<WorkflowRuntimeEventPayload, { kind: "workflow_completion_cut_sealed" }>;
type LatePolicyPayload = Extract<WorkflowRuntimeEventPayload, { kind: "workflow_late_observation_policy_recorded" }>;
type ReplayEvent = Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>["events"][number];

const outcomeEventKey = (observationId: string): string => `workflow-observation-outcome:${observationId}`;
const cutEventKey = (cutId: string): string => `workflow-completion-cut:${cutId}`;
const latePolicyEventKey = (observationId: string): string => `workflow-late-policy:${observationId}`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const keys = [...expected].sort();
	if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index]))
		throw new Error(`${label}_keys_invalid`);
}

function assertDigest(value: string, label: string): void {
	if (!DIGEST.test(value)) throw new Error(`${label}_invalid`);
}

function assertEpoch(value: WorkflowEpochRef, label: string): void {
	if (!Number.isSafeInteger(value.storeEpoch) || value.storeEpoch < 1) throw new Error(`${label}_store_epoch_invalid`);
	if (!Number.isSafeInteger(value.coordinatorEpoch) || value.coordinatorEpoch < 1)
		throw new Error(`${label}_coordinator_epoch_invalid`);
}

function assertArtifactRef(ref: WorkflowArtifactRef): void {
	if (
		ref.artifactId.length === 0 ||
		ref.relativePath.length === 0 ||
		ref.relativePath.startsWith("/") ||
		ref.relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
		!DIGEST.test(ref.digest) ||
		!Number.isSafeInteger(ref.sizeBytes) ||
		ref.sizeBytes < 0 ||
		!Number.isSafeInteger(ref.sourceEventSequence) ||
		ref.sourceEventSequence < 0
	)
		throw new Error("workflow_observation_artifact_ref_invalid");
}

function assertCapabilityReceipt(receipt: WorkflowVerifiedHostReceipt, label: string): void {
	if (
		!isRecord(receipt) ||
		receipt.receiptKind !== "capability" ||
		receipt.oneUse !== true ||
		typeof receipt.receiptId !== "string" ||
		receipt.receiptId.length === 0 ||
		typeof receipt.workflowId !== "string" ||
		receipt.workflowId.length === 0 ||
		!DIGEST.test(receipt.bindingDigest) ||
		!DIGEST.test(receipt.payloadDigest) ||
		typeof receipt.issuerId !== "string" ||
		receipt.issuerId.length === 0 ||
		typeof receipt.keyId !== "string" ||
		receipt.keyId.length === 0 ||
		typeof receipt.issuedAt !== "string" ||
		typeof receipt.validUntil !== "string" ||
		typeof receipt.signature !== "string" ||
		!DIGEST.test(receipt.verificationDigest) ||
		!DIGEST.test(receipt.artifactBytesDigest) ||
		!DIGEST.test(receipt.stateDigest) ||
		!Number.isSafeInteger(receipt.revision) ||
		receipt.revision < 1 ||
		receipt.signatureAlgorithm !== "ed25519" ||
		!isRecord(receipt.capabilityBinding) ||
		typeof receipt.capabilityBinding.capability !== "string" ||
		!DIGEST.test(receipt.capabilityBinding.resourceDigest) ||
		!DIGEST.test(receipt.capabilityBinding.operationDigest) ||
		(receipt.capabilityBinding.executionIdentity !== null &&
			typeof receipt.capabilityBinding.executionIdentity !== "string") ||
		(receipt.capabilityBinding.sessionId !== null && typeof receipt.capabilityBinding.sessionId !== "string")
	) {
		throw new Error(`${label}_invalid`);
	}
	assertArtifactRef(receipt.artifactRef);
}

function assertCanonicalUtc(value: string, label: string): void {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || new Date(value).toISOString() !== value)
		throw new Error(`${label}_invalid`);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function sameLease(left: WorkflowLeaseRef, right: WorkflowLeaseRef): boolean {
	return digestObject(left) === digestObject(right);
}

function sameHead(left: WorkflowJournalHead, right: WorkflowJournalHead): boolean {
	return digestObject(left) === digestObject(right);
}

function processResourceDigest(observation: WorkflowObservationInput): string {
	return digestObject({
		workflowId: observation.workflowId,
		taskId: observation.taskId,
		attemptId: observation.attemptId,
		effectIdempotencyKey: observation.effectIdempotencyKey,
	});
}

function processOperationDigest(observation: WorkflowObservationInput): string {
	return digestObject({
		observationId: observation.observationId,
		observationDigest: observation.observationDigest,
		baseRevisionDigest: observation.baseRevisionDigest,
		processGeneration: observation.processGeneration,
		coordinatorTerm: observation.coordinatorTerm,
		kind: observation.kind,
		evidenceRefs: observation.evidenceRefs,
		expectedHead: observation.expectedHead,
		epochRef: observation.epochRef,
		leaseRef: observation.leaseRef,
		decisionRef: observation.decisionRef ?? null,
		datasetMetadata: observation.datasetMetadata ?? null,
	});
}

function processBindingDigest(observation: WorkflowObservationInput, sessionId: string): string {
	return digestObject({
		capability: "workflow_observation_process",
		workflowId: observation.workflowId,
		resourceDigest: processResourceDigest(observation),
		operationDigest: processOperationDigest(observation),
		stateDigest: observation.expectedHead.eventDigest,
		revision: observation.expectedHead.sequence,
		epochRef: observation.epochRef,
		executionIdentity: observation.processGeneration,
		sessionId,
	});
}

function datasetResourceDigest(metadata: WorkflowObservationDatasetMetadata): string {
	return digestObject({
		split: metadata.split,
		modality: metadata.modality,
		instrumentSet: metadata.instrumentSet,
		objectUri: metadata.objectUri,
		generation: metadata.generation,
		sha256: metadata.sha256,
		bytes: metadata.bytes,
		schemaVersion: metadata.schemaVersion,
	});
}

function datasetOperationDigest(
	workflowId: string,
	observationId: string,
	metadata: WorkflowObservationDatasetMetadata,
): string {
	return digestObject({
		workflowId,
		observationId,
		closureRootDigest: metadata.closureRootDigest,
		coverage: metadata.coverage,
		lifecycle: metadata.lifecycle,
	});
}

function aggregateResourceDigest(aggregateDigest: string): string {
	return aggregateDigest;
}

function aggregateOperationDigest(
	workflowId: string,
	observationId: string,
	aggregate: { readonly aggregateDigest: string; readonly artifactRef: WorkflowArtifactRef },
): string {
	return digestObject({
		workflowId,
		observationId,
		aggregateDigest: aggregate.aggregateDigest,
		artifactRef: aggregate.artifactRef,
	});
}

function journalDatasetMetadata(metadata: WorkflowObservationDatasetMetadata): WorkflowObservationDatasetMetadata {
	const { capabilityBinding: _hostCapabilityBinding, ...hostReceipt } = metadata.hostReceipt;
	return {
		...metadata,
		hostReceipt,
		holdoutAggregate:
			metadata.holdoutAggregate === null
				? null
				: {
						...metadata.holdoutAggregate,
						receipt: (({ capabilityBinding: _aggregateCapabilityBinding, ...receipt }) => receipt)(
							metadata.holdoutAggregate.receipt,
						),
					},
	};
}

function completionResourceDigest(input: WorkflowCompletionCutInput): string {
	return digestObject({
		workflowId: input.expectedHead.workflowId,
		trainingClosureRootDigest: input.trainingClosureRootDigest,
		validationClosureRootDigest: input.validationClosureRootDigest,
		holdoutClosureRootDigest: input.holdoutClosureRootDigest,
	});
}

function completionOperationDigest(input: WorkflowCompletionCutInput): string {
	return digestObject({
		cutId: input.cutId,
		finalClosureObservationId: input.finalClosureObservationId,
		trainingClosureRootDigest: input.trainingClosureRootDigest,
		validationClosureRootDigest: input.validationClosureRootDigest,
		holdoutClosureRootDigest: input.holdoutClosureRootDigest,
	});
}

function completionBindingDigest(input: WorkflowCompletionCutInput, sessionId: string): string {
	return digestObject({
		capability: "workflow_observation_dataset_receipt",
		workflowId: input.expectedHead.workflowId,
		resourceDigest: completionResourceDigest(input),
		operationDigest: completionOperationDigest(input),
		stateDigest: input.expectedHead.eventDigest,
		revision: input.expectedHead.sequence,
		epochRef: input.epochRef,
		executionIdentity: input.processGeneration,
		sessionId,
	});
}

function assertDecisionRef(ref: WorkflowDecisionRef, workflowId: string, epochRef: WorkflowEpochRef): void {
	if (!isRecord(ref) || !isRecord(ref.decisionScope)) throw new Error("workflow_observation_decision_ref_invalid");
	exactKeys(
		ref,
		["decisionScope", "decisionId", "revision", "storeEpoch", "coordinatorEpoch", "decisionDigest"],
		"workflow_observation_decision_ref",
	);
	exactKeys(ref.decisionScope, ["kind", "workflowId", "rootSessionId"], "workflow_observation_decision_scope");
	if (
		ref.decisionScope.kind !== "workflow" ||
		ref.decisionScope.workflowId !== workflowId ||
		ref.decisionScope.rootSessionId.length === 0 ||
		ref.decisionId.length === 0 ||
		!Number.isSafeInteger(ref.revision) ||
		ref.revision < 1 ||
		ref.storeEpoch !== epochRef.storeEpoch ||
		ref.coordinatorEpoch !== epochRef.coordinatorEpoch
	)
		throw new Error("workflow_observation_decision_ref_invalid");
	assertDigest(ref.decisionDigest, "workflow_observation_decision_digest");
}

function assertInput(input: WorkflowObservationInput): void {
	if (
		typeof input.observationId !== "string" ||
		input.observationId.length === 0 ||
		typeof input.observationDigest !== "string" ||
		typeof input.baseRevisionDigest !== "string" ||
		typeof input.processGeneration !== "string" ||
		input.processGeneration.length === 0 ||
		typeof input.effectIdempotencyKey !== "string" ||
		input.effectIdempotencyKey.length === 0 ||
		typeof input.workflowId !== "string" ||
		input.workflowId.length === 0 ||
		typeof input.taskId !== "string" ||
		input.taskId.length === 0 ||
		typeof input.attemptId !== "string" ||
		input.attemptId.length === 0 ||
		!Array.isArray(input.evidenceRefs) ||
		!KINDS.includes(input.kind)
	)
		throw new Error("workflow_observation_input_invalid");
	assertDigest(input.observationDigest, "workflow_observation_digest");
	assertCapabilityReceipt(input.processReceipt, "workflow_observation_process_receipt");
	for (const ref of input.evidenceRefs) assertArtifactRef(ref);
	assertEpoch(input.epochRef, "workflow_observation_epoch");
	assertEpoch(input.expectedHead.epochRef, "workflow_observation_head_epoch");
	if (input.expectedHead.sequence < 0) throw new Error("workflow_observation_head_invalid");
	if (!Number.isSafeInteger(input.coordinatorTerm) || input.coordinatorTerm < 1)
		throw new Error("workflow_observation_coordinator_term_invalid");
	if ((input.kind === "dataset") !== (input.datasetMetadata !== undefined))
		throw new Error("workflow_observation_dataset_metadata_kind_invalid");
	if (input.decisionRef !== undefined) assertDecisionRef(input.decisionRef, input.workflowId, input.epochRef);
}

function assertDatasetMetadata(metadata: WorkflowObservationDatasetMetadata): void {
	exactKeys(
		metadata as unknown as Record<string, unknown>,
		[
			"split",
			"modality",
			"instrumentSet",
			"sourceTimeStart",
			"sourceTimeEnd",
			"schemaVersion",
			"objectUri",
			"generation",
			"sha256",
			"bytes",
			"validationResult",
			"coverage",
			"gapClassification",
			"gapEvidenceRefs",
			"sourceEmptyEvidenceRefs",
			"lifecycle",
			"lifecycleTargetObservationId",
			"restoreVerification",
			"provenance",
			"closureRootDigest",
			"accessAuthority",
			"hostReceipt",
			"holdoutAggregate",
		],
		"workflow_observation_dataset_metadata",
	);
	assertCapabilityReceipt(metadata.hostReceipt, "workflow_observation_dataset_receipt");
	if (!MODALITIES.includes(metadata.modality)) throw new Error("workflow_observation_dataset_modality_invalid");
	if (
		(metadata.split === "training" && metadata.accessAuthority !== "training_workers_training_only") ||
		(metadata.split === "validation" && metadata.accessAuthority !== "validation_evaluator_host_only") ||
		(metadata.split === "holdout" && metadata.accessAuthority !== "holdout_host_aggregate_only")
	)
		throw new Error("workflow_observation_dataset_access_authority_invalid");
	if (
		metadata.instrumentSet.length === 0 ||
		new Set(metadata.instrumentSet).size !== metadata.instrumentSet.length ||
		metadata.instrumentSet.some((item, index) => index > 0 && item <= metadata.instrumentSet[index - 1])
	)
		throw new Error("workflow_observation_dataset_instrument_set_invalid");
	assertCanonicalUtc(metadata.sourceTimeStart, "workflow_observation_dataset_source_time_start");
	assertCanonicalUtc(metadata.sourceTimeEnd, "workflow_observation_dataset_source_time_end");
	const start = Date.parse(metadata.sourceTimeStart);
	const end = Date.parse(metadata.sourceTimeEnd);
	if (end <= start) throw new Error("workflow_observation_dataset_source_interval_invalid");
	if (
		(metadata.modality === "order_book" || metadata.modality === "position_book") &&
		(end - start !== 20 * 60 * 1000 || start % (20 * 60 * 1000) !== 0)
	)
		throw new Error("workflow_observation_dataset_book_grid_invalid");
	if (
		!/^\S+:\/\/\S+$/u.test(metadata.objectUri) ||
		!Number.isSafeInteger(metadata.generation) ||
		metadata.generation < 1 ||
		!DIGEST.test(metadata.sha256) ||
		!Number.isSafeInteger(metadata.bytes) ||
		metadata.bytes < 0 ||
		metadata.schemaVersion.length === 0 ||
		!DIGEST.test(metadata.closureRootDigest)
	)
		throw new Error("workflow_observation_dataset_binding_invalid");
	const expectedGap = metadata.coverage === "complete" ? "none" : metadata.coverage;
	if (metadata.gapClassification !== expectedGap)
		throw new Error("workflow_observation_dataset_gap_classification_invalid");
	if (metadata.coverage === "complete" && metadata.validationResult !== "passed")
		throw new Error("workflow_observation_dataset_validation_invalid");
	if (
		(metadata.coverage === "provider_empty" || metadata.coverage === "partial_coverage") &&
		metadata.validationResult !== "passed"
	)
		throw new Error("workflow_observation_dataset_validation_invalid");
	if ((metadata.coverage === "unknown" || metadata.coverage === "missing") && metadata.validationResult !== "unknown")
		throw new Error("workflow_observation_dataset_validation_invalid");
	for (const ref of [...metadata.gapEvidenceRefs, ...metadata.sourceEmptyEvidenceRefs]) assertArtifactRef(ref);
	if (metadata.coverage === "provider_empty" && metadata.sourceEmptyEvidenceRefs.length === 0)
		throw new Error("workflow_observation_dataset_source_empty_evidence_missing");
	if (metadata.coverage === "partial_coverage" && metadata.gapEvidenceRefs.length === 0)
		throw new Error("workflow_observation_dataset_gap_evidence_missing");
	if (
		metadata.lifecycle === "sealed" &&
		(!metadata.restoreVerification.independentlyRestored ||
			!metadata.restoreVerification.independentlyRehashed ||
			metadata.restoreVerification.verificationEvidenceDigest === null)
	)
		throw new Error("workflow_observation_dataset_restore_verification_invalid");
	if (
		(metadata.lifecycle === "superseded" || metadata.lifecycle === "quarantined") !==
		(metadata.lifecycleTargetObservationId !== null)
	)
		throw new Error("workflow_observation_dataset_lifecycle_target_invalid");
	if (
		metadata.provenance.sourceSystem.length === 0 ||
		metadata.provenance.sourceDataset.length === 0 ||
		!DIGEST.test(metadata.provenance.ingestDigest) ||
		!DIGEST.test(metadata.provenance.lineageDigest) ||
		!DIGEST.test(metadata.provenance.provenanceReceiptDigest) ||
		metadata.provenance.provenanceReceiptDigest !== metadata.hostReceipt.payloadDigest
	)
		throw new Error("workflow_observation_dataset_provenance_invalid");
	if (metadata.split === "holdout") {
		if (metadata.holdoutAggregate === null) throw new Error("workflow_observation_holdout_aggregate_missing");
		assertArtifactRef(metadata.holdoutAggregate.artifactRef);
		assertCapabilityReceipt(metadata.holdoutAggregate.receipt, "workflow_observation_holdout_receipt");
		if (metadata.holdoutAggregate.receipt.payloadDigest !== metadata.holdoutAggregate.aggregateDigest)
			throw new Error("workflow_observation_holdout_receipt_invalid");
	} else if (metadata.holdoutAggregate !== null) {
		throw new Error("workflow_observation_holdout_aggregate_forbidden");
	}
}

function observationBindingDigest(workflowId: string, observation: WorkflowObservationInput): string {
	const metadata = observation.datasetMetadata;
	return digestObject({
		workflowId,
		observationId: observation.observationId,
		split: metadata?.split ?? null,
		modality: metadata?.modality ?? null,
		instrumentSet: metadata?.instrumentSet ?? null,
		sourceTimeStart: metadata?.sourceTimeStart ?? null,
		sourceTimeEnd: metadata?.sourceTimeEnd ?? null,
		objectUri: metadata?.objectUri ?? null,
		generation: metadata?.generation ?? null,
		sha256: metadata?.sha256 ?? null,
		bytes: metadata?.bytes ?? null,
		schemaVersion: metadata?.schemaVersion ?? null,
		validationResult: metadata?.validationResult ?? null,
		coverage: metadata?.coverage ?? null,
		gapClassification: metadata?.gapClassification ?? null,
		gapEvidenceRefs: metadata?.gapEvidenceRefs ?? null,
		sourceEmptyEvidenceRefs: metadata?.sourceEmptyEvidenceRefs ?? null,
		lifecycle: metadata?.lifecycle ?? null,
		lifecycleTargetObservationId: metadata?.lifecycleTargetObservationId ?? null,
		restoreVerification: metadata?.restoreVerification ?? null,
		provenance: metadata?.provenance ?? null,
		closureRootDigest: metadata?.closureRootDigest ?? null,
		accessAuthority: metadata?.accessAuthority ?? null,
		holdoutAggregate: metadata?.holdoutAggregate
			? {
					aggregateDigest: metadata.holdoutAggregate.aggregateDigest,
					artifactRef: metadata.holdoutAggregate.artifactRef,
				}
			: null,
	});
}

async function validateArtifacts(
	refs: readonly WorkflowArtifactRef[],
	resolver: WorkflowArtifactResolver | undefined,
): Promise<void> {
	for (const ref of refs) assertArtifactRef(ref);
	if (refs.length === 0) return;
	if (resolver === undefined) throw new Error("workflow_observation_artifact_resolver_missing");
	if (new Set(refs.map((ref) => digestObject(ref))).size !== refs.length)
		throw new Error("workflow_observation_evidence_duplicate");
	for (const ref of refs) {
		const resolved = await resolver.resolve(ref);
		if (
			!resolved.exists ||
			resolved.envelope.immutable !== true ||
			digestObject(resolved.envelope.ref) !== digestObject(ref) ||
			resolved.verifiedDigest !== ref.digest ||
			resolved.verifiedSizeBytes !== ref.sizeBytes ||
			resolved.bytes.byteLength !== ref.sizeBytes ||
			sha256Hex(resolved.bytes) !== ref.digest
		)
			throw new Error("workflow_observation_artifact_evidence_invalid");
	}
}

interface WorkflowObservationReceiptPlan {
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly capability: WorkflowHostReceiptCapability;
	readonly bindingDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly workflowId: string;
	readonly stateDigest: string;
	readonly revision: number;
	readonly epochRef: WorkflowEpochRef;
	readonly executionIdentity: string;
	readonly sessionId: string;
	readonly authorization: WorkflowHostPrincipalCapabilityAuthorization;
}

function assertAuthorizationBinding(
	authorization: WorkflowHostPrincipalCapabilityAuthorization,
	plan: Omit<WorkflowObservationReceiptPlan, "authorization">,
): void {
	if (
		authorization.capability !== plan.capability ||
		authorization.workflowId !== plan.workflowId ||
		authorization.bindingDigest !== plan.bindingDigest ||
		authorization.stateDigest !== plan.stateDigest ||
		authorization.revision !== plan.revision ||
		!sameEpoch(authorization.epochRef, plan.epochRef) ||
		authorization.receipt.receiptId !== plan.receipt.receiptId ||
		authorization.executionIdentity !== plan.executionIdentity ||
		authorization.sessionId !== plan.sessionId ||
		!DIGEST.test(authorization.authorizationDigest)
	)
		throw new Error("workflow_observation_authorization_binding_invalid");
}

async function authorizeReceipt(
	context: WorkflowHostReceiptConsumerContext,
	plan: Omit<WorkflowObservationReceiptPlan, "authorization">,
): Promise<WorkflowObservationReceiptPlan> {
	assertCapabilityReceipt(plan.receipt, "workflow_observation_capability_receipt");
	const authorization = await context.principalAuthorizer.authorize({
		receipt: plan.receipt,
		workflowId: plan.workflowId,
		bindingDigest: plan.bindingDigest,
		resourceDigest: plan.resourceDigest,
		operationDigest: plan.operationDigest,
		stateDigest: plan.stateDigest,
		revision: plan.revision,
		epochRef: plan.epochRef,
		capability: plan.capability,
		executionIdentity: plan.executionIdentity,
		sessionId: plan.sessionId,
	});
	assertAuthorizationBinding(authorization, plan);
	return { ...plan, authorization };
}

async function consumeReceipt(
	context: WorkflowHostReceiptConsumerContext,
	plan: WorkflowObservationReceiptPlan,
): Promise<WorkflowHostReceiptConsumptionWitness> {
	let witness: WorkflowHostReceiptConsumptionWitness;
	try {
		await context.receiptResolver.consumeIfOneUse({
			receipt: plan.receipt,
			workflowId: plan.workflowId,
			expectedBindingDigest: plan.bindingDigest,
			currentRevision: plan.revision,
		});
	} catch (error) {
		try {
			witness = await context.receiptResolver.resolveConsumptionWitness({
				receiptId: plan.receipt.receiptId,
				workflowId: plan.workflowId,
				expectedBindingDigest: plan.bindingDigest,
			});
		} catch {
			throw error;
		}
		return witness;
	}
	witness = await context.receiptResolver.resolveConsumptionWitness({
		receiptId: plan.receipt.receiptId,
		workflowId: plan.workflowId,
		expectedBindingDigest: plan.bindingDigest,
	});
	if (
		witness.receiptId !== plan.receipt.receiptId ||
		witness.workflowId !== plan.workflowId ||
		witness.bindingDigest !== plan.bindingDigest
	)
		throw new Error("workflow_observation_receipt_witness_invalid");
	return witness;
}

async function authorizeProcessReceipt(
	context: WorkflowHostReceiptConsumerContext,
	workflowId: string,
	observation: WorkflowObservationInput,
	replayHead: WorkflowJournalHead,
	sessionId: string,
): Promise<WorkflowObservationReceiptPlan> {
	return authorizeReceipt(context, {
		receipt: observation.processReceipt,
		capability: "workflow_observation_process",
		bindingDigest: processBindingDigest(observation, sessionId),
		resourceDigest: processResourceDigest(observation),
		operationDigest: processOperationDigest(observation),
		workflowId,
		stateDigest: replayHead.eventDigest ?? "",
		revision: replayHead.sequence,
		epochRef: replayHead.epochRef,
		executionIdentity: observation.processGeneration,
		sessionId,
	});
}

async function authorizeDatasetReceipts(
	workflowId: string,
	observation: WorkflowObservationInput,
	replayHead: WorkflowJournalHead,
	context: WorkflowHostReceiptConsumerContext,
	processGeneration: string,
	sessionId: string,
): Promise<readonly WorkflowObservationReceiptPlan[]> {
	const metadata = observation.datasetMetadata;
	if (metadata === undefined) return [];
	const plans: WorkflowObservationReceiptPlan[] = [
		await authorizeReceipt(context, {
			receipt: metadata.hostReceipt,
			capability: "workflow_observation_dataset_receipt",
			bindingDigest: observationBindingDigest(workflowId, observation),
			resourceDigest: datasetResourceDigest(metadata),
			operationDigest: datasetOperationDigest(workflowId, observation.observationId, metadata),
			workflowId,
			stateDigest: replayHead.eventDigest ?? "",
			revision: replayHead.sequence,
			epochRef: replayHead.epochRef,
			executionIdentity: processGeneration,
			sessionId,
		}),
	];
	if (metadata.holdoutAggregate !== null) {
		const aggregate = metadata.holdoutAggregate;
		plans.push(
			await authorizeReceipt(context, {
				receipt: aggregate.receipt,
				capability: "workflow_observation_dataset_receipt",
				bindingDigest: digestObject({
					workflowId,
					observationId: observation.observationId,
					aggregateDigest: aggregate.aggregateDigest,
					artifactRef: aggregate.artifactRef,
				}),
				resourceDigest: aggregateResourceDigest(aggregate.aggregateDigest),
				operationDigest: aggregateOperationDigest(workflowId, observation.observationId, aggregate),
				workflowId,
				stateDigest: replayHead.eventDigest ?? "",
				revision: replayHead.sequence,
				epochRef: replayHead.epochRef,
				executionIdentity: processGeneration,
				sessionId,
			}),
		);
	}
	return plans;
}

function observationEventForId(events: readonly ReplayEvent[], observationId: string): ReplayEvent | undefined {
	return events.find(
		(event) =>
			event.idempotencyKey === outcomeEventKey(observationId) &&
			event.payload.kind === "workflow_observation_outcome_recorded",
	);
}

function observationRecord(event: ReplayEvent): WorkflowObservationOutcomeRecord {
	if (event.payload.kind !== "workflow_observation_outcome_recorded")
		throw new Error("workflow_observation_event_kind_invalid");
	if (event.payload.recordDigest !== digestObject(event.payload.record))
		throw new Error("workflow_observation_record_digest_invalid");
	return event.payload.record;
}

function completionCutForEvent(event: ReplayEvent): WorkflowObservationWatermark {
	if (event.payload.kind !== "workflow_completion_cut_sealed")
		throw new Error("workflow_completion_cut_event_kind_invalid");
	if (event.payload.cutDigest !== digestObject(event.payload.cut))
		throw new Error("workflow_completion_cut_digest_invalid");
	return {
		...event.payload.cut,
		journalSequence: event.sequence,
		journalHeadDigest: event.eventDigest,
		cutDigest: event.payload.cutDigest,
	};
}

function latestCompletionCut(events: readonly ReplayEvent[]): WorkflowObservationWatermark | null {
	let latest: WorkflowObservationWatermark | null = null;
	for (const event of events) {
		if (event.payload.kind === "workflow_completion_cut_sealed") latest = completionCutForEvent(event);
	}
	return latest;
}

function outcomeResult(
	event: ReplayEvent,
	record: WorkflowObservationOutcomeRecord,
	watermark: WorkflowObservationWatermark | null,
): WorkflowObservationResult {
	if (event.payload.kind !== "workflow_observation_outcome_recorded")
		throw new Error("workflow_observation_event_kind_invalid");
	return Object.freeze({
		observationId: record.observationId,
		observationDigest: record.observationDigest,
		status: record.outcome,
		outcomeDigest: event.payload.recordDigest,
		effectIdempotencyKey: record.effectIdempotencyKey,
		journalSequence: event.sequence,
		journalHeadDigest: event.eventDigest,
		causalWatermark: { sequence: event.sequence, eventDigest: event.eventDigest },
		acceptedObservationCut: watermark,
		reason: record.reason,
	});
}

function hostTupleStatus(
	input: WorkflowObservationInput,
	config: WorkflowObservationAuthorityInput,
	replay: Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>,
	currentLease: WorkflowLeaseRef,
): { readonly status: "applied" | "stale" | "rejected"; readonly reason: string | null } {
	if (
		replay.quarantined ||
		input.workflowId !== config.workflowId ||
		config.runtimeStore.identity.workflowId !== config.workflowId ||
		config.writerIdentity !== currentLease.writerIdentity ||
		config.leaseRef.writerIdentity !== config.writerIdentity
	)
		return { status: "rejected", reason: "workflow_observation_host_identity_invalid" };
	if (
		!sameEpoch(input.epochRef, replay.head.epochRef) ||
		!sameLease(input.leaseRef, currentLease) ||
		!sameLease(config.leaseRef, currentLease) ||
		input.processGeneration !== config.processGeneration ||
		input.processGeneration !== currentLease.processIdentity ||
		input.coordinatorTerm !== config.coordinatorTerm ||
		input.coordinatorTerm !== replay.head.epochRef.coordinatorEpoch ||
		!sameEpoch(config.epochRef, replay.head.epochRef)
	)
		return { status: "stale", reason: "workflow_observation_fence_stale" };
	if (!sameHead(input.expectedHead, replay.head))
		return { status: "stale", reason: "workflow_observation_head_stale" };
	if (input.baseRevisionDigest !== replay.head.eventDigest)
		return { status: "rejected", reason: "workflow_observation_base_revision_binding_invalid" };
	return { status: "applied", reason: null };
}

async function commitPayload<TPayload extends WorkflowRuntimeEventPayload>(
	store: WorkflowRuntimeStore,
	workflowId: string,
	payload: TPayload,
	epochRef: WorkflowEpochRef,
	leaseRef: WorkflowLeaseRef,
	writerIdentity: string,
	idempotencyKey: string,
): Promise<WorkflowStoreCommitResult<TPayload>> {
	const replay = await store.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
	if (replay.quarantined) throw new Error("workflow_observation_store_quarantined");
	const baselineDigest = digestObject(replay.head);
	return store.commit({
		workflowId,
		payload,
		expectedHead: replay.head,
		epochRef,
		leaseRef,
		idempotencyKey,
		writerIdentity,
		executionKey: null,
		semanticBinding: {
			mutationId: idempotencyKey,
			baselineDigest,
			expectedGenerations: { workflow: epochRef.storeEpoch },
			ownerId: writerIdentity,
			phase: "recovering",
			reducerDigest: digestObject(payload),
			semanticHead: {
				workflowId,
				sequence: replay.head.sequence,
				eventDigest: replay.head.eventDigest,
				stateDigest: baselineDigest,
				epochRef,
				generation: epochRef.storeEpoch,
			},
			expectedHead: replay.head,
			idempotencyKey,
			executionKey: null,
			writerIdentity,
			leaseRef,
			epochRef,
		},
	});
}

function assertCutInput(input: WorkflowCompletionCutInput): void {
	if (
		input.cutId.length === 0 ||
		input.finalClosureObservationId.length === 0 ||
		input.processGeneration.length === 0 ||
		!Number.isSafeInteger(input.coordinatorTerm) ||
		input.coordinatorTerm < 1
	)
		throw new Error("workflow_completion_cut_input_invalid");
	assertDigest(input.trainingClosureRootDigest, "workflow_completion_training_root");
	assertDigest(input.validationClosureRootDigest, "workflow_completion_validation_root");
	assertDigest(input.holdoutClosureRootDigest, "workflow_completion_holdout_root");
	assertCapabilityReceipt(input.closureReceipt, "workflow_completion_closure_receipt");
	if (
		new Set([input.trainingClosureRootDigest, input.validationClosureRootDigest, input.holdoutClosureRootDigest])
			.size !== 3
	)
		throw new Error("workflow_completion_cut_roots_not_distinct");
	assertEpoch(input.epochRef, "workflow_completion_cut_epoch");
	assertEpoch(input.expectedHead.epochRef, "workflow_completion_cut_head_epoch");
}

function cutRecordFromInput(
	input: WorkflowCompletionCutInput,
	replayHead: WorkflowJournalHead,
	ids: { readonly superseded: readonly string[]; readonly quarantined: readonly string[] },
	now: string,
	finalClosureObservationDigest: string,
): WorkflowObservationCompletionCut {
	return {
		workflowId: replayHead.workflowId,
		cutId: input.cutId,
		expectedHead: replayHead,
		epochRef: replayHead.epochRef,
		finalClosureObservationId: input.finalClosureObservationId,
		finalClosureObservationDigest,
		trainingClosureRootDigest: input.trainingClosureRootDigest,
		validationClosureRootDigest: input.validationClosureRootDigest,
		holdoutClosureRootDigest: input.holdoutClosureRootDigest,
		supersededObservationIds: [...ids.superseded],
		quarantinedObservationIds: [...ids.quarantined],
		sealedAt: now,
	};
}

function recordsThrough(
	events: readonly ReplayEvent[],
): readonly { event: ReplayEvent; record: WorkflowObservationOutcomeRecord }[] {
	return events
		.filter((event) => event.payload.kind === "workflow_observation_outcome_recorded")
		.map((event) => ({ event, record: observationRecord(event) }));
}

export function workflowObservationDigest(input: WorkflowObservationDigestInput): string {
	return digestObject({
		observationId: input.observationId,
		baseRevisionDigest: input.baseRevisionDigest,
		processGeneration: input.processGeneration,
		coordinatorTerm: input.coordinatorTerm,
		effectIdempotencyKey: input.effectIdempotencyKey,
		workflowId: input.workflowId,
		taskId: input.taskId,
		attemptId: input.attemptId,
		kind: input.kind,
		evidenceRefs: input.evidenceRefs,
		expectedHead: input.expectedHead,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		decisionRef: input.decisionRef ?? null,
		datasetMetadata: input.datasetMetadata ?? null,
	});
}

export function createWorkflowObservationAuthority(
	input: WorkflowObservationAuthorityInput,
): WorkflowObservationAuthority {
	if (input.runtimeStore.identity.workflowId !== input.workflowId)
		throw new Error("workflow_observation_runtime_store_identity_invalid");
	if (input.writerIdentity.length === 0 || input.leaseRef.writerIdentity !== input.writerIdentity)
		throw new Error("workflow_observation_writer_identity_invalid");
	if (input.sessionId.length === 0) throw new Error("workflow_observation_session_identity_invalid");
	if (
		!isRecord(input.receiptContext) ||
		!isRecord(input.receiptContext.principalAuthorizer) ||
		typeof input.receiptContext.principalAuthorizer.authorize !== "function"
	)
		throw new Error("CONTRACT_CHANGE: workflow observation requires the generic host principal authorizer.");
	assertEpoch(input.epochRef, "workflow_observation_authority_epoch");
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("workflow_observation_requires_durable_runtime");
	const now = input.now ?? (() => new Date().toISOString());
	const readReplay = async (): Promise<Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>> =>
		input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: durable.epochRef.storeEpoch,
		});
	const readWatermark = async (): Promise<WorkflowObservationWatermark | null> =>
		durable.withExclusiveLease("workflow-observation-watermark-read", async () =>
			latestCompletionCut((await readReplay()).events),
		);

	const processObservation = async (rawInput: WorkflowObservationInput): Promise<WorkflowObservationResult> => {
		const observation = structuredClone(rawInput);
		assertInput(observation);
		return durable.withExclusiveLease("workflow-observation-authority", async () => {
			const replay = await readReplay();
			const existingEvent = observationEventForId(replay.events, observation.observationId);
			const digestMatches = observation.observationDigest === workflowObservationDigest(observation);
			if (existingEvent !== undefined) {
				const existingRecord = observationRecord(existingEvent);
				if (existingRecord.observationDigest !== observation.observationDigest || !digestMatches)
					throw new Error("workflow_observation_idempotency_conflict");
				return outcomeResult(existingEvent, existingRecord, latestCompletionCut(replay.events));
			}
			const conflict = recordsThrough(replay.events).find(
				(entry) =>
					entry.record.effectIdempotencyKey === observation.effectIdempotencyKey &&
					(entry.record.observationId !== observation.observationId ||
						entry.record.observationDigest !== observation.observationDigest),
			);
			const existingEffect = replay.events.find(
				(event) =>
					(event.payload.kind === "workflow_effect_intent" ||
						event.payload.kind === "workflow_effect_completed" ||
						event.payload.kind === "workflow_effect_ambiguous") &&
					event.payload.idempotencyKey === observation.effectIdempotencyKey,
			);
			const currentLease = durable.currentLeaseRef();
			const hostStatus = hostTupleStatus(observation, input, replay, currentLease);
			let status: WorkflowObservationOutcome = hostStatus.status;
			let reason = hostStatus.reason;
			let receiptEvidenceRefs: readonly WorkflowArtifactRef[] = [];
			if (conflict !== undefined || existingEffect !== undefined) {
				status = "rejected";
				reason = "workflow_observation_effect_idempotency_conflict";
			} else if (status === "applied") {
				try {
					const receiptPlans: WorkflowObservationReceiptPlan[] = [];
					assertDigest(observation.baseRevisionDigest, "workflow_observation_base_revision_digest");
					if (!digestMatches) throw new Error("workflow_observation_digest_mismatch");
					receiptPlans.push(
						await authorizeProcessReceipt(
							input.receiptContext,
							input.workflowId,
							observation,
							replay.head,
							input.sessionId,
						),
					);
					if (observation.datasetMetadata !== undefined) {
						assertDatasetMetadata(observation.datasetMetadata);
						const targetId = observation.datasetMetadata.lifecycleTargetObservationId;
						if (targetId !== null) {
							const target = recordsThrough(replay.events).find(
								(entry) => entry.record.observationId === targetId,
							);
							if (
								target === undefined ||
								target.record.outcome !== "applied" ||
								target.record.kind !== "dataset" ||
								target.record.datasetMetadata?.split !== observation.datasetMetadata.split ||
								target.record.datasetMetadata.lifecycle !== "sealed" ||
								target.record.datasetMetadata.coverage !== "complete"
							)
								throw new Error("workflow_observation_lifecycle_target_invalid");
						}
						receiptPlans.push(
							...(await authorizeDatasetReceipts(
								input.workflowId,
								observation,
								replay.head,
								input.receiptContext,
								input.processGeneration,
								input.sessionId,
							)),
						);
					}
					const evidenceRefs = [
						...observation.evidenceRefs,
						...(observation.datasetMetadata?.gapEvidenceRefs ?? []),
						...(observation.datasetMetadata?.sourceEmptyEvidenceRefs ?? []),
						...(observation.datasetMetadata?.holdoutAggregate === null ||
						observation.datasetMetadata?.holdoutAggregate === undefined
							? []
							: [observation.datasetMetadata.holdoutAggregate.artifactRef]),
					];
					await validateArtifacts(evidenceRefs, input.receiptContext.artifactResolver);
					const consumedReceiptRefs: WorkflowArtifactRef[] = [];
					for (const plan of receiptPlans) {
						await consumeReceipt(input.receiptContext, plan);
						consumedReceiptRefs.push(plan.receipt.artifactRef);
					}
					receiptEvidenceRefs = consumedReceiptRefs;
				} catch (error) {
					status = "rejected";
					reason = error instanceof Error ? error.message : "workflow_observation_validation_failed";
				}
			}
			const record: WorkflowObservationOutcomeRecord = {
				workflowId: input.workflowId,
				observationId: observation.observationId,
				observationDigest: observation.observationDigest,
				baseRevisionDigest:
					status === "applied"
						? observation.baseRevisionDigest
						: (replay.head.eventDigest ?? observation.baseRevisionDigest),
				processGeneration: status === "applied" ? observation.processGeneration : currentLease.processIdentity,
				coordinatorTerm: status === "applied" ? observation.coordinatorTerm : replay.head.epochRef.coordinatorEpoch,
				effectIdempotencyKey: observation.effectIdempotencyKey,
				taskId: observation.taskId,
				attemptId: observation.attemptId,
				kind: observation.kind,
				evidenceRefs: [...observation.evidenceRefs, ...receiptEvidenceRefs],
				decisionRef: observation.decisionRef ?? null,
				expectedHead: status === "applied" ? observation.expectedHead : replay.head,
				epochRef: status === "applied" ? observation.epochRef : replay.head.epochRef,
				leaseRef: status === "applied" ? observation.leaseRef : currentLease,
				outcome: status,
				reason,
				acceptedAt: status === "applied" ? now() : null,
				datasetMetadata:
					status === "applied" && observation.datasetMetadata !== undefined
						? journalDatasetMetadata(observation.datasetMetadata)
						: null,
			};
			await input.crash?.("before_outcome_commit");
			const payload: ObservationOutcomePayload = {
				kind: "workflow_observation_outcome_recorded",
				workflowId: input.workflowId,
				epochRef: replay.head.epochRef,
				record,
				recordDigest: digestObject(record),
			};
			const committed = await commitPayload(
				input.runtimeStore,
				input.workflowId,
				payload,
				replay.head.epochRef,
				durable.currentLeaseRef(),
				input.writerIdentity,
				outcomeEventKey(observation.observationId),
			);
			await input.crash?.("after_outcome_commit_before_return");
			const currentReplay = await readReplay();
			return outcomeResult(committed.commit, record, latestCompletionCut(currentReplay.events));
		});
	};

	const sealCompletionCut = async (rawInput: WorkflowCompletionCutInput): Promise<WorkflowCompletionCutResult> => {
		const cutInput = structuredClone(rawInput);
		assertCutInput(cutInput);
		return durable.withExclusiveLease("workflow-completion-cut", async () => {
			const replay = await readReplay();
			const existing = replay.events.find(
				(event) =>
					event.idempotencyKey === cutEventKey(cutInput.cutId) &&
					event.payload.kind === "workflow_completion_cut_sealed",
			);
			if (existing !== undefined) {
				const existingCut = completionCutForEvent(existing);
				if (
					existingCut.finalClosureObservationId !== cutInput.finalClosureObservationId ||
					existingCut.trainingClosureRootDigest !== cutInput.trainingClosureRootDigest ||
					existingCut.validationClosureRootDigest !== cutInput.validationClosureRootDigest ||
					existingCut.holdoutClosureRootDigest !== cutInput.holdoutClosureRootDigest
				)
					throw new Error("workflow_completion_cut_idempotency_conflict");
				return { status: "sealed", watermark: existingCut, reason: null };
			}
			const currentLease = durable.currentLeaseRef();
			if (
				!sameHead(cutInput.expectedHead, replay.head) ||
				!sameEpoch(cutInput.epochRef, replay.head.epochRef) ||
				!sameLease(cutInput.leaseRef, currentLease) ||
				cutInput.processGeneration !== currentLease.processIdentity ||
				cutInput.coordinatorTerm !== replay.head.epochRef.coordinatorEpoch
			)
				return { status: "stale", watermark: null, reason: "workflow_completion_cut_fence_stale" };
			const accepted = recordsThrough(replay.events).filter(({ record }) => record.outcome === "applied");
			const targeted = new Set(
				accepted
					.map(({ record }) => record.datasetMetadata?.lifecycleTargetObservationId)
					.filter((target): target is string => target !== null && target !== undefined),
			);
			const sealedBySplit = new Map<
				string,
				{ readonly event: ReplayEvent; readonly record: WorkflowObservationOutcomeRecord }
			>();
			for (const entry of accepted) {
				const metadata = entry.record.datasetMetadata;
				if (
					entry.record.kind !== "dataset" ||
					metadata?.lifecycle !== "sealed" ||
					metadata.coverage !== "complete" ||
					targeted.has(entry.record.observationId)
				)
					continue;
				sealedBySplit.set(metadata.split, entry);
			}
			const roots = {
				training: sealedBySplit.get("training"),
				validation: sealedBySplit.get("validation"),
				holdout: sealedBySplit.get("holdout"),
			};
			if (roots.training === undefined || roots.validation === undefined || roots.holdout === undefined)
				return { status: "rejected", watermark: null, reason: "workflow_completion_dataset_closure_incomplete" };
			if (
				roots.training.record.datasetMetadata?.closureRootDigest !== cutInput.trainingClosureRootDigest ||
				roots.validation.record.datasetMetadata?.closureRootDigest !== cutInput.validationClosureRootDigest ||
				roots.holdout.record.datasetMetadata?.closureRootDigest !== cutInput.holdoutClosureRootDigest
			)
				return { status: "rejected", watermark: null, reason: "workflow_completion_closure_root_mismatch" };
			const latestClosure = [roots.training, roots.validation, roots.holdout].sort(
				(left, right) => left.event.sequence - right.event.sequence,
			)[2];
			if (latestClosure === undefined || latestClosure.record.observationId !== cutInput.finalClosureObservationId)
				return {
					status: "rejected",
					watermark: null,
					reason: "workflow_completion_final_closure_observation_invalid",
				};
			try {
				const closurePlan = await authorizeReceipt(input.receiptContext, {
					receipt: cutInput.closureReceipt,
					capability: "workflow_observation_dataset_receipt",
					bindingDigest: completionBindingDigest(cutInput, input.sessionId),
					resourceDigest: completionResourceDigest(cutInput),
					operationDigest: completionOperationDigest(cutInput),
					workflowId: input.workflowId,
					stateDigest: replay.head.eventDigest ?? "",
					revision: replay.head.sequence,
					epochRef: replay.head.epochRef,
					executionIdentity: cutInput.processGeneration,
					sessionId: input.sessionId,
				});
				await consumeReceipt(input.receiptContext, closurePlan);
			} catch (error) {
				return {
					status: "rejected",
					watermark: null,
					reason: error instanceof Error ? error.message : "workflow_completion_receipt_invalid",
				};
			}
			const ids = {
				superseded: accepted
					.filter(
						({ record }) => record.datasetMetadata?.lifecycle === "superseded" || record.kind === "supersession",
					)
					.map(({ record }) => record.observationId),
				quarantined: accepted
					.filter(
						({ record }) => record.datasetMetadata?.lifecycle === "quarantined" || record.kind === "quarantine",
					)
					.map(({ record }) => record.observationId),
			};
			const cut = cutRecordFromInput(
				cutInput,
				replay.head,
				{ superseded: ids.superseded, quarantined: ids.quarantined },
				now(),
				latestClosure.record.observationDigest,
			);
			const payload: CompletionCutPayload = {
				kind: "workflow_completion_cut_sealed",
				workflowId: input.workflowId,
				epochRef: replay.head.epochRef,
				cut,
				cutDigest: digestObject(cut),
			};
			const committed = await commitPayload(
				input.runtimeStore,
				input.workflowId,
				payload,
				replay.head.epochRef,
				durable.currentLeaseRef(),
				input.writerIdentity,
				cutEventKey(cutInput.cutId),
			);
			return { status: "sealed", watermark: completionCutForEvent(committed.commit), reason: null };
		});
	};

	const evaluateLateObservation = async (
		late: WorkflowLateObservationInput,
	): Promise<WorkflowLateObservationResult> => {
		assertDigest(late.observationDigest, "workflow_observation_late_digest");
		assertDigest(late.baseRevisionDigest, "workflow_observation_late_base_revision_digest");
		if (late.observationId.length === 0) throw new Error("workflow_observation_late_input_invalid");
		return durable.withExclusiveLease("workflow-late-observation-policy", async () => {
			const replay = await readReplay();
			const cutEvent = [...replay.events]
				.reverse()
				.find((event) => event.payload.kind === "workflow_completion_cut_sealed");
			if (cutEvent === undefined)
				return { status: "no_op", watermark: null, journalSequence: null, journalHeadDigest: null };
			const watermark = completionCutForEvent(cutEvent);
			const existing = replay.events.find(
				(event) =>
					event.idempotencyKey === latePolicyEventKey(late.observationId) &&
					event.payload.kind === "workflow_late_observation_policy_recorded",
			);
			if (existing !== undefined) {
				if (
					existing.payload.kind !== "workflow_late_observation_policy_recorded" ||
					existing.payload.record.observationDigest !== late.observationDigest ||
					existing.payload.record.baseRevisionDigest !== late.baseRevisionDigest
				)
					throw new Error("workflow_observation_late_idempotency_conflict");
				return {
					status: existing.payload.record.policy,
					watermark,
					journalSequence: existing.sequence,
					journalHeadDigest: existing.eventDigest,
				};
			}
			const policy =
				late.baseRevisionDigest === watermark.expectedHead.eventDigest
					? "no_op"
					: ((await input.latePolicy?.({ ...late, watermark })) ?? "no_op");
			if (!POLICIES.includes(policy)) throw new Error("workflow_observation_late_policy_invalid");
			const record: WorkflowObservationLatePolicyRecord = {
				workflowId: input.workflowId,
				cutId: watermark.cutId,
				observationId: late.observationId,
				observationDigest: late.observationDigest,
				baseRevisionDigest: late.baseRevisionDigest,
				policy,
				epochRef: replay.head.epochRef,
			};
			const payload: LatePolicyPayload = {
				kind: "workflow_late_observation_policy_recorded",
				workflowId: input.workflowId,
				epochRef: replay.head.epochRef,
				record,
				recordDigest: digestObject(record),
			};
			const committed = await commitPayload(
				input.runtimeStore,
				input.workflowId,
				payload,
				replay.head.epochRef,
				durable.currentLeaseRef(),
				input.writerIdentity,
				latePolicyEventKey(late.observationId),
			);
			return {
				status: policy,
				watermark,
				journalSequence: committed.commit.sequence,
				journalHeadDigest: committed.commit.eventDigest,
			};
		});
	};

	return Object.freeze({ processObservation, sealCompletionCut, readWatermark, evaluateLateObservation });
}
