import type {
	WorkflowArtifactCodec,
	WorkflowArtifactPayloadKind,
	WorkflowArtifactReadResult,
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowEpochRef,
	WorkflowHostReceiptConsumerContext,
	WorkflowHostReceiptConsumptionWitness,
	WorkflowJournalHead,
	WorkflowVerifiedHostReceipt,
} from "./workflow/contracts.js";
import { digestObject, parseCanonicalJsonBytes, sha256Hex } from "./workflow/contracts.js";

export { sha256Hex } from "./workflow/contracts.js";

export const CHILD_OUTPUT_CONTRACT_VERSION = 1 as const;
export const MAX_CHILD_REQUIRED_OUTPUTS = 64;
export const MAX_CHILD_ATTEMPTS = 16;
export const MAX_CHILD_COMPACTIONS = 3;
export const MAX_CHILD_FINAL_RESULT_BYTES = 1_048_576;
export const MIN_CHILD_OUTPUT_RUNTIME_VERSION = "0.147.0-alpha.10" as const;
export const STALLED_OUTPUT_OBLIGATION_DIAGNOSTIC = "stalled_output_obligation" as const;
export const MISSING_FINAL_ASSISTANT_RESULT_REASON = "missing_final_assistant_result" as const;

export type ChildOutputContractVersion = typeof CHILD_OUTPUT_CONTRACT_VERSION;
export type ChildArtifactResolver = WorkflowArtifactResolver;
export type ChildOutputReceipt = WorkflowVerifiedHostReceipt;
export type ChildOutputConsumptionWitness = WorkflowHostReceiptConsumptionWitness;
export type ChildRequiredArtifactOutput = ChildArtifactOutput;
export type ChildOutputContractDeclaration = ChildTaskDeclaration;
export type ChildOutputContractState = ChildAttemptState;
export type ChildAttemptStatus =
	| "running"
	| "validating"
	| "delivered_pending_ack"
	| "completed"
	| "retryable_incomplete"
	| "cancelled"
	| "terminal_failed"
	| "scope_changed"
	| "quarantined";

export type ChildOutputObligationStatus =
	| "undischarged"
	| "discharged"
	| "cancelled"
	| "terminal_failed"
	| "scope_changed";

export interface ChildOutputObligation {
	readonly obligationId: string;
	readonly declarationDigest: string;
	readonly taskId: string;
	readonly childId: string;
	readonly runId: string;
	readonly attemptId: string;
	readonly requiredFinalResult: ChildFinalResultRequirement;
	readonly requiredArtifactOutputIds: readonly string[];
	readonly status: ChildOutputObligationStatus;
	readonly terminalEventId: string | null;
	readonly terminalReason: string | null;
}

export interface ChildSealedArtifact {
	readonly outputId: string;
	readonly path: string;
	readonly ref: WorkflowArtifactRef;
	readonly digest: string;
	readonly schema: string;
	readonly validator: string;
	readonly immutableGeneration: string;
}

export interface ChildArtifactSeal {
	readonly sealId: string;
	readonly producerAttemptId: string;
	readonly producerExecutionId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly outputObligationId: string;
	readonly packetDigest: string;
	readonly artifacts: readonly ChildSealedArtifact[];
	readonly receipt: ChildOutputReceipt;
	readonly receiptId: string;
	readonly consumptionWitness: ChildOutputConsumptionWitness;
	readonly hostStateDigest: string;
	readonly hostRevision: number;
	readonly receiptDigest: string;
	readonly authorizationDigest: string;
	readonly sealDigest: string;
	readonly status: "stable" | "invalidated";
	readonly invalidationEventId: string | null;
	readonly invalidationDigest: string | null;
	readonly invalidationReason: string | null;
}

export interface ChildProducerFence {
	readonly fenceId: string;
	readonly producerAttemptId: string;
	readonly producerExecutionId: string;
	readonly sealId: string;
	readonly sealDigest: string;
	readonly outputObligationId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly hostAuthorityDigest: string;
	readonly revocationIntent: ChildProducerRevocationIntent;
	readonly writeAuthority: "revoked";
}

export interface ChildProducerRevocationIntent {
	readonly operation: "revoke_producer_write";
	readonly attemptId: string;
	readonly producerExecutionId: string;
	readonly sealDigest: string;
	readonly outputObligationId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly intentDigest: string;
}

export interface ChildContinuationWake {
	readonly wakeId: string;
	readonly childId: string;
	readonly attemptId: string;
	readonly safeBoundary: "after_compaction_queue_empty";
	readonly compactionCount: number;
	readonly evidenceDigest: string;
	readonly headDigest: string;
	readonly witnessDigest: string;
	readonly createdByEventId: string;
	readonly status: "pending";
}

export type ChildContinuationEscalationReason =
	| typeof STALLED_OUTPUT_OBLIGATION_DIAGNOSTIC
	| "continuation_failed"
	| "authority_required";

export interface ChildContinuationEscalation {
	readonly reason: ChildContinuationEscalationReason;
	readonly eventId: string;
	readonly diagnostic: string;
}

export type ChildOutputDeadlineStatus = "pending" | "discharged" | "cancelled" | "terminal_failed" | "scope_changed";

export interface ChildOutputDeadlineTransition {
	readonly status: ChildOutputDeadlineStatus;
	readonly transitionEventId: string | null;
	readonly transitionReason: string | null;
}

export type ChildCoordinatorWakeKind = "final_output" | "error" | "gating";
export type ChildCoordinatorWakeStatus = "pending" | "claimed" | "processed" | "failed";

export interface ChildCoordinatorWake {
	readonly wakeKey: string;
	readonly kind: ChildCoordinatorWakeKind;
	readonly createdByEventId: string;
	readonly status: ChildCoordinatorWakeStatus;
	readonly claimId: string | null;
	readonly processedEventId: string | null;
	readonly failureReason: string | null;
}

export interface ChildCoordinatorTerminalTransition {
	readonly status: "completed" | "cancelled" | "terminal_failed" | "scope_changed";
	readonly eventId: string;
	readonly reason: string;
}

/**
 * Host-owned coordinator projection for parking and deduplicated wake delivery.
 * The deadline is a transition state, not a local clock; the host owns timing.
 */
export interface ChildCoordinatorProjection {
	readonly meaningfulProgressDigest: string | null;
	readonly deadline: ChildOutputDeadlineTransition;
	readonly terminal: ChildCoordinatorTerminalTransition | null;
	readonly wake: ChildCoordinatorWake | null;
}

export interface ChildFinalResultRequirement {
	readonly schema: string;
	readonly validator: string;
}

export interface ChildFinalResultInput {
	readonly resultId: string;
	readonly bytes: Readonly<Uint8Array> | readonly number[];
	readonly schema: string;
	readonly validator: string;
}

export interface ChildFinalAssistantResult {
	readonly resultId: string;
	readonly bytes: Readonly<Uint8Array> | readonly number[];
	readonly digest: string;
	readonly schema: string;
	readonly validator: string;
}

export interface ChildArtifactOutput {
	readonly outputId: string;
	readonly path: string;
	readonly ref: WorkflowArtifactRef;
	readonly digest: string;
	readonly schema: string;
	readonly validator: string;
}

export interface ChildTaskDeclaration {
	readonly version: ChildOutputContractVersion;
	readonly taskId: string;
	readonly childId: string;
	readonly runId: string;
	readonly attemptId: string;
	readonly workflowId: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly maxAttempts: number;
	readonly maxCompactions: number;
	readonly requiredFinalResult: ChildFinalResultRequirement;
	readonly requiredArtifacts: readonly ChildArtifactOutput[];
}

export interface ChildValidatedArtifactOutput {
	readonly outputId: string;
	readonly path: string;
	readonly ref: WorkflowArtifactRef;
	readonly schema: string;
	readonly validator: string;
	readonly validated: true;
}

export interface ChildArtifactValidationInput {
	readonly output: ChildValidatedArtifactOutput;
	readonly required: ChildArtifactOutput;
	readonly resolvedArtifact: WorkflowArtifactReadResult;
}

export interface ChildFinalResultValidationInput {
	readonly result: ChildFinalAssistantResult;
	readonly parsed: unknown;
}

export interface ChildOutputHostTuple {
	readonly workflowId: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly stateDigest: string;
	readonly revision: number;
}

export type ChildOutputCommitOperation =
	| "artifact_seal"
	| "terminal_send"
	| "parent_delivery_ack"
	| "artifact_drift"
	| "compaction"
	| "terminal_gate";

export interface ChildOutputCommitIntent {
	readonly operation: ChildOutputCommitOperation;
	readonly eventId: string;
	readonly eventDigest: string;
	readonly workflowId: string;
	readonly taskId: string;
	readonly childId: string;
	readonly runId: string;
	readonly attemptId: string;
	readonly producerExecutionId: string | null;
	readonly outputObligationId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly expectedStateDigest: string;
	readonly hostStateDigest: string;
	readonly hostRevision: number;
	readonly packetDigest: string | null;
	readonly sealDigest: string | null;
	readonly producerFenceId: string | null;
	readonly deliveryId: string | null;
	readonly intentDigest: string;
}

export type ChildOutputCommitIntentInput = Omit<ChildOutputCommitIntent, "intentDigest">;

export interface ChildOutputHostContext {
	readonly hostTuple: ChildOutputHostTuple;
	readonly runtimeVersion: string;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly readHostTuple: () => Promise<ChildOutputHostTuple>;
	readonly prepareCommitIntent: (input: ChildOutputCommitIntentInput) => Promise<ChildOutputCommitIntent>;
	readonly validateFinalResult: (input: ChildFinalResultValidationInput) => Promise<void> | void;
	readonly validateArtifactOutput: (input: ChildArtifactValidationInput) => Promise<void> | void;
}

export interface ChildOutputEventBase {
	readonly eventId: string;
	readonly attemptId: string;
	readonly workflowId: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly expectedStateDigest: string;
}

export type ChildOutputEvent =
	| (ChildOutputEventBase & {
			readonly kind: "child_finished";
			readonly finalAssistantResult: ChildFinalAssistantResult | null;
			readonly toolResults: readonly unknown[];
			readonly artifacts: readonly ChildArtifactOutput[];
			readonly packetDigest: string;
			readonly producerExecutionId: string;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "provisional_progress";
			readonly progressDigest: string;
			readonly producerExecutionId: string;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "artifact_seal_recorded";
			readonly sealId: string;
			readonly outputObligationId: string;
			readonly packetDigest: string;
			readonly producerExecutionId: string;
			readonly artifacts: readonly ChildArtifactOutput[];
			readonly witness: ChildOutputReceipt;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "producer_write_attempted";
			readonly producerExecutionId: string;
			readonly path: string;
			readonly writeDigest: string;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "seal_drift_detected";
			readonly producerExecutionId: string;
			readonly witness: ChildOutputReceipt;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "outputs_validated";
			readonly outputs: readonly ChildValidatedArtifactOutput[];
	  })
	| (ChildOutputEventBase & {
			readonly kind: "parent_delivery_acknowledged";
			readonly deliveryId: string;
			readonly receipt: ChildOutputReceipt;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "attempt_retried";
			readonly priorAttemptId: string;
			readonly newAttemptId: string;
			readonly lineageDigest: string;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "compaction_completed";
			readonly compactionId: string;
			readonly compactionCount: number;
			readonly evidenceRef: WorkflowArtifactRef;
			readonly queueEmpty: true;
			readonly wakeId: string;
			readonly witness: ChildOutputReceipt;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "obligation_cancelled";
			readonly reason: string;
			readonly witness: ChildOutputReceipt;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "terminal_failure_recorded";
			readonly reason: string;
			readonly witness: ChildOutputReceipt;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "scope_change_approved";
			readonly scopeDigest: string;
			readonly witness: ChildOutputReceipt;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "coordinator_wake_claimed";
			readonly wakeKey: string;
			readonly claimId: string;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "coordinator_wake_processed";
			readonly wakeKey: string;
			readonly claimId: string;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "coordinator_wake_failed";
			readonly wakeKey: string;
			readonly claimId: string;
			readonly reason: string;
	  })
	| (ChildOutputEventBase & {
			readonly kind: "follow_up_requested";
			readonly requestId: string;
	  })
	| (ChildOutputEventBase & { readonly kind: "attempt_completed" });

export interface ChildAttemptLineage {
	readonly attemptId: string;
	readonly priorAttemptId: string | null;
	readonly attemptNumber: number;
	readonly taskId: string;
	readonly childId: string;
	readonly runId: string;
	readonly workflowId: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly declarationDigest: string;
	readonly status: ChildAttemptStatus;
	readonly terminalStateDigest: string | null;
	readonly retryEventId: string | null;
	readonly lineageDigest: string;
}

export interface ChildAttemptState {
	readonly declaration: ChildTaskDeclaration;
	readonly status: ChildAttemptStatus;
	readonly taskId: string;
	readonly childId: string;
	readonly runId: string;
	readonly workflowId: string;
	readonly attemptId: string;
	readonly priorAttemptId: string | null;
	readonly attemptNumber: number;
	readonly maxAttempts: number;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly bindingDigest: string;
	readonly stateDigest: string;
	readonly outputObligation: ChildOutputObligation;
	readonly provisionalProgressDigest: string | null;
	readonly provisionalProducerExecutionId: string | null;
	readonly artifactSeal: ChildArtifactSeal | null;
	readonly producerFence: ChildProducerFence | null;
	readonly terminalPacketDigest: string | null;
	readonly terminalToolResults: readonly unknown[];
	readonly quarantineReason: string | null;
	readonly coordinator: ChildCoordinatorProjection;
	readonly continuationWake: ChildContinuationWake | null;
	readonly compactionCount: number;
	readonly compactionNoProgressCount: number;
	readonly lastCompactionEvidenceDigest: string | null;
	readonly lastCompactionHeadDigest: string | null;
	readonly diagnostic: string | null;
	readonly continuationEscalation: ChildContinuationEscalation | null;
	readonly finalAssistantResult: ChildFinalAssistantResult | null;
	readonly reportedArtifacts: readonly ChildArtifactOutput[];
	readonly validatedOutputs: readonly ChildValidatedArtifactOutput[];
	readonly deliveryId: string | null;
	readonly acknowledgementReceipt: ChildOutputReceipt | null;
	readonly acknowledgementReceiptId: string | null;
	readonly acknowledgementReceiptDigest: string | null;
	readonly acknowledgementConsumptionWitness: ChildOutputConsumptionWitness | null;
	readonly acknowledgementAuthorizationDigest: string | null;
	readonly reason: string | null;
	readonly durableCommitIntent: ChildOutputCommitIntent | null;
	readonly appliedEventDigests: Readonly<Record<string, string>>;
	readonly lastEventId: string | null;
	readonly retryEventId: string | null;
	readonly attemptLineage: readonly ChildAttemptLineage[];
}

export interface ChildRetryAttemptInput {
	readonly attemptId: string;
	readonly eventId: string;
	readonly epochRef?: WorkflowEpochRef;
}

const DECLARATION_KEYS = [
	"attemptId",
	"childId",
	"epochRef",
	"head",
	"maxAttempts",
	"maxCompactions",
	"requiredArtifacts",
	"requiredFinalResult",
	"runId",
	"taskId",
	"version",
	"workflowId",
] as const;
const EPOCH_KEYS = ["coordinatorEpoch", "storeEpoch"] as const;
const HEAD_KEYS = ["epochRef", "eventDigest", "sequence", "workflowId"] as const;
const REF_KEYS = ["artifactId", "digest", "relativePath", "sizeBytes", "sourceEventSequence"] as const;
const ARTIFACT_KEYS = ["digest", "outputId", "path", "ref", "schema", "validator"] as const;
const SEALED_ARTIFACT_KEYS = [
	"digest",
	"immutableGeneration",
	"outputId",
	"path",
	"ref",
	"schema",
	"validator",
] as const;
const WITNESS_KEYS = [
	"bindingDigest",
	"capability",
	"consumedAt",
	"consumptionSequence",
	"operationDigest",
	"receiptDigest",
	"receiptId",
	"resourceDigest",
	"workflowId",
] as const;
const SEAL_KEYS = [
	"artifacts",
	"authorizationDigest",
	"consumptionWitness",
	"epochRef",
	"head",
	"hostRevision",
	"hostStateDigest",
	"invalidationDigest",
	"invalidationEventId",
	"invalidationReason",
	"outputObligationId",
	"packetDigest",
	"producerAttemptId",
	"producerExecutionId",
	"receipt",
	"receiptId",
	"receiptDigest",
	"sealDigest",
	"sealId",
	"status",
] as const;
const FENCE_KEYS = [
	"epochRef",
	"fenceId",
	"head",
	"hostAuthorityDigest",
	"outputObligationId",
	"producerAttemptId",
	"producerExecutionId",
	"sealDigest",
	"sealId",
	"revocationIntent",
	"writeAuthority",
] as const;
const REVOCATION_INTENT_KEYS = [
	"attemptId",
	"epochRef",
	"head",
	"intentDigest",
	"operation",
	"outputObligationId",
	"producerExecutionId",
	"sealDigest",
] as const;
const COMMIT_INTENT_KEYS = [
	"attemptId",
	"childId",
	"deliveryId",
	"eventDigest",
	"eventId",
	"epochRef",
	"expectedStateDigest",
	"head",
	"hostRevision",
	"hostStateDigest",
	"intentDigest",
	"operation",
	"outputObligationId",
	"packetDigest",
	"producerExecutionId",
	"producerFenceId",
	"runId",
	"sealDigest",
	"taskId",
	"workflowId",
] as const;
const FINAL_REQUIREMENT_KEYS = ["schema", "validator"] as const;
const FINAL_INPUT_KEYS = ["bytes", "resultId", "schema", "validator"] as const;
const FINAL_RESULT_KEYS = ["bytes", "digest", "resultId", "schema", "validator"] as const;
const VALIDATED_OUTPUT_KEYS = ["outputId", "path", "ref", "schema", "validated", "validator"] as const;
const RECEIPT_KEYS = [
	"artifactBytesDigest",
	"artifactRef",
	"bindingDigest",
	"issuedAt",
	"issuerId",
	"keyId",
	"oneUse",
	"payloadDigest",
	"receiptId",
	"receiptKind",
	"revision",
	"signature",
	"signatureAlgorithm",
	"stateDigest",
	"validUntil",
	"verificationDigest",
	"workflowId",
] as const;
const RECEIPT_CAPABILITY_BINDING_KEYS = [
	"capability",
	"executionIdentity",
	"operationDigest",
	"resourceDigest",
	"sessionId",
] as const;
const EVENT_BASE_KEYS = [
	"attemptId",
	"epochRef",
	"eventId",
	"expectedStateDigest",
	"head",
	"kind",
	"workflowId",
] as const;
const STATE_KEYS = [
	"acknowledgementAuthorizationDigest",
	"acknowledgementConsumptionWitness",
	"acknowledgementReceipt",
	"acknowledgementReceiptId",
	"acknowledgementReceiptDigest",
	"appliedEventDigests",
	"attemptId",
	"attemptLineage",
	"attemptNumber",
	"bindingDigest",
	"childId",
	"artifactSeal",
	"compactionCount",
	"compactionNoProgressCount",
	"coordinator",
	"continuationEscalation",
	"continuationWake",
	"declaration",
	"diagnostic",
	"durableCommitIntent",
	"deliveryId",
	"epochRef",
	"finalAssistantResult",
	"head",
	"lastEventId",
	"lastCompactionEvidenceDigest",
	"lastCompactionHeadDigest",
	"maxAttempts",
	"producerFence",
	"provisionalProducerExecutionId",
	"provisionalProgressDigest",
	"priorAttemptId",
	"quarantineReason",
	"reason",
	"reportedArtifacts",
	"retryEventId",
	"runId",
	"stateDigest",
	"status",
	"taskId",
	"terminalPacketDigest",
	"terminalToolResults",
	"outputObligation",
	"validatedOutputs",
	"workflowId",
] as const;
const LINEAGE_KEYS = [
	"attemptId",
	"attemptNumber",
	"childId",
	"declarationDigest",
	"epochRef",
	"head",
	"lineageDigest",
	"priorAttemptId",
	"retryEventId",
	"runId",
	"status",
	"terminalStateDigest",
	"taskId",
	"workflowId",
] as const;
const OBLIGATION_KEYS = [
	"attemptId",
	"childId",
	"declarationDigest",
	"obligationId",
	"requiredArtifactOutputIds",
	"requiredFinalResult",
	"runId",
	"status",
	"taskId",
	"terminalEventId",
	"terminalReason",
] as const;
const WAKE_KEYS = [
	"attemptId",
	"childId",
	"compactionCount",
	"createdByEventId",
	"evidenceDigest",
	"headDigest",
	"safeBoundary",
	"status",
	"wakeId",
	"witnessDigest",
] as const;
const ESCALATION_KEYS = ["diagnostic", "eventId", "reason"] as const;
const COORDINATOR_KEYS = ["deadline", "meaningfulProgressDigest", "terminal", "wake"] as const;
const DEADLINE_KEYS = ["status", "transitionEventId", "transitionReason"] as const;
const COORDINATOR_WAKE_KEYS = [
	"claimId",
	"createdByEventId",
	"failureReason",
	"kind",
	"processedEventId",
	"status",
	"wakeKey",
] as const;
const COORDINATOR_TERMINAL_KEYS = ["eventId", "reason", "status"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new Error(`${label} is not a closed versioned record.`);
	}
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty.`);
}

function assertSafeInteger(value: unknown, label: string, minimum: number): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum)
		throw new Error(`${label} must be a finite integer.`);
}

interface ChildRuntimeVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease: readonly (number | string)[];
}

function parseChildRuntimeVersion(version: string): ChildRuntimeVersion {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			version,
		);
	if (match === null) throw new Error("workflow_runtime_version_unsupported");
	const components = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (!components.every((component) => Number.isSafeInteger(component)))
		throw new Error("workflow_runtime_version_unsupported");
	const prerelease = (match[4] ?? "")
		.split(".")
		.filter((part) => part.length > 0)
		.map((part): number | string => {
			if (!/^\d+$/.test(part)) return part;
			if (part.length > 1 && part.startsWith("0")) throw new Error("workflow_runtime_version_unsupported");
			const numeric = Number(part);
			if (!Number.isSafeInteger(numeric)) throw new Error("workflow_runtime_version_unsupported");
			return numeric;
		});
	const [major, minor, patch] = components;
	if (major === undefined || minor === undefined || patch === undefined)
		throw new Error("workflow_runtime_version_unsupported");
	return { major, minor, patch, prerelease };
}

function compareChildRuntimeVersions(left: ChildRuntimeVersion, right: ChildRuntimeVersion): number {
	for (const field of ["major", "minor", "patch"] as const) {
		if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
	}
	if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
	if (left.prerelease.length === 0) return 1;
	if (right.prerelease.length === 0) return -1;
	for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
		const leftPart = left.prerelease[index];
		const rightPart = right.prerelease[index];
		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;
		if (leftPart === rightPart) continue;
		if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart < rightPart ? -1 : 1;
		if (typeof leftPart === "number") return -1;
		if (typeof rightPart === "number") return 1;
		return leftPart < rightPart ? -1 : 1;
	}
	return 0;
}

export function assertChildOutputRuntimeVersion(version: string | undefined): void {
	if (typeof version !== "string") throw new Error("workflow_runtime_version_unsupported");
	if (
		compareChildRuntimeVersions(
			parseChildRuntimeVersion(version),
			parseChildRuntimeVersion(MIN_CHILD_OUTPUT_RUNTIME_VERSION),
		) < 0
	)
		throw new Error("workflow_runtime_version_unsupported");
}

function assertRelativePath(value: unknown, label: string): asserts value is string {
	assertNonEmptyString(value, label);
	const path = value as string;
	if (path.includes("\u0000")) throw new Error(`${label} contains a NUL byte.`);
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path))
		throw new Error(`${label} must be a relative path.`);
	if (path.split(/[\\/]+/).some((segment) => segment === ".."))
		throw new Error(`${label} cannot escape its artifact root.`);
}

function parseHostReceipt(value: unknown, label: string): WorkflowVerifiedHostReceipt {
	assertRecord(value, label);
	const actualKeys = Object.keys(value).sort();
	const requiredKeys = [...RECEIPT_KEYS].sort();
	const optionalKeys = [...RECEIPT_KEYS, "capabilityBinding"].sort();
	const matches = (expected: readonly string[]) =>
		actualKeys.length === expected.length && actualKeys.every((key, index) => key === expected[index]);
	if (!matches(requiredKeys) && !matches(optionalKeys)) throw new Error(`${label} is not a closed signed receipt.`);
	if (
		!["clock", "artifact", "capability", "decision", "lease", "usage", "adjudication"].includes(
			value.receiptKind as string,
		)
	)
		throw new Error(`${label}.receiptKind is invalid.`);
	assertNonEmptyString(value.receiptId, `${label}.receiptId`);
	assertNonEmptyString(value.issuerId, `${label}.issuerId`);
	assertNonEmptyString(value.workflowId, `${label}.workflowId`);
	assertNonEmptyString(value.bindingDigest, `${label}.bindingDigest`);
	assertNonEmptyString(value.payloadDigest, `${label}.payloadDigest`);
	assertNonEmptyString(value.issuedAt, `${label}.issuedAt`);
	assertNonEmptyString(value.validUntil, `${label}.validUntil`);
	assertNonEmptyString(value.keyId, `${label}.keyId`);
	assertNonEmptyString(value.artifactBytesDigest, `${label}.artifactBytesDigest`);
	assertNonEmptyString(value.stateDigest, `${label}.stateDigest`);
	assertNonEmptyString(value.signature, `${label}.signature`);
	assertNonEmptyString(value.verificationDigest, `${label}.verificationDigest`);
	assertSafeInteger(value.revision, `${label}.revision`, 0);
	if (value.signatureAlgorithm !== "ed25519") throw new Error(`${label}.signatureAlgorithm is invalid.`);
	if (value.oneUse !== true) throw new Error(`${label} must be a one-use host receipt.`);
	parseArtifactRef(value.artifactRef, `${label}.artifactRef`);
	if (value.receiptKind !== "capability")
		throw new Error(`${label}.receiptKind must authorize child output delivery.`);
	assertRecord(value.capabilityBinding, `${label}.capabilityBinding`);
	assertExactKeys(value.capabilityBinding, RECEIPT_CAPABILITY_BINDING_KEYS, `${label}.capabilityBinding`);
	if (value.capabilityBinding.capability !== "child_output_delivery_ack")
		throw new Error(`${label}.capabilityBinding.capability is invalid.`);
	assertNonEmptyString(value.capabilityBinding.resourceDigest, `${label}.capabilityBinding.resourceDigest`);
	assertNonEmptyString(value.capabilityBinding.operationDigest, `${label}.capabilityBinding.operationDigest`);
	if (value.capabilityBinding.executionIdentity !== null)
		assertNonEmptyString(value.capabilityBinding.executionIdentity, `${label}.capabilityBinding.executionIdentity`);
	if (value.capabilityBinding.sessionId !== null)
		assertNonEmptyString(value.capabilityBinding.sessionId, `${label}.capabilityBinding.sessionId`);
	return value as unknown as WorkflowVerifiedHostReceipt;
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function sameArtifactRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
	return digestObject(left) === digestObject(right);
}

function cloneAndFreeze<T>(value: T): T {
	if (Array.isArray(value)) {
		for (const item of value) cloneAndFreeze(item);
		return Object.freeze(value);
	}
	if (isRecord(value)) {
		for (const item of Object.values(value)) cloneAndFreeze(item);
		return Object.freeze(value) as T;
	}
	return value;
}

function parseEpoch(value: unknown, label: string): WorkflowEpochRef {
	assertRecord(value, label);
	assertExactKeys(value, EPOCH_KEYS, label);
	assertSafeInteger(value.storeEpoch, `${label}.storeEpoch`, 0);
	assertSafeInteger(value.coordinatorEpoch, `${label}.coordinatorEpoch`, 0);
	return { storeEpoch: value.storeEpoch, coordinatorEpoch: value.coordinatorEpoch };
}

function parseHead(value: unknown, workflowId: string, epochRef: WorkflowEpochRef, label: string): WorkflowJournalHead {
	assertRecord(value, label);
	assertExactKeys(value, HEAD_KEYS, label);
	assertNonEmptyString(value.workflowId, `${label}.workflowId`);
	if (value.workflowId !== workflowId) throw new Error(`${label} is bound to another workflow.`);
	assertSafeInteger(value.sequence, `${label}.sequence`, 0);
	let eventDigest: string | null;
	if (value.eventDigest === null) eventDigest = null;
	else {
		assertNonEmptyString(value.eventDigest, `${label}.eventDigest`);
		eventDigest = value.eventDigest;
	}
	const headEpoch = parseEpoch(value.epochRef, `${label}.epochRef`);
	if (!sameEpoch(headEpoch, epochRef)) throw new Error(`${label} and epoch are not bound.`);
	return { workflowId, sequence: value.sequence, eventDigest, epochRef: headEpoch };
}

function parseHostTuple(value: unknown, label: string): ChildOutputHostTuple {
	assertRecord(value, label);
	assertExactKeys(value, ["epochRef", "head", "revision", "stateDigest", "workflowId"], label);
	assertNonEmptyString(value.workflowId, `${label}.workflowId`);
	const epochRef = parseEpoch(value.epochRef, `${label}.epochRef`);
	const head = parseHead(value.head, value.workflowId, epochRef, `${label}.head`);
	assertNonEmptyString(value.stateDigest, `${label}.stateDigest`);
	assertSafeInteger(value.revision, `${label}.revision`, 0);
	return { workflowId: value.workflowId, head, epochRef, stateDigest: value.stateDigest, revision: value.revision };
}

function assertHostContext(context: ChildOutputHostContext): void {
	if (!context || typeof context !== "object") throw new Error("Child output host context is required.");
	assertChildOutputRuntimeVersion(context.runtimeVersion);
	parseHostTuple(context.hostTuple, "Child output host tuple");
	if (typeof context.readHostTuple !== "function")
		throw new Error("CONTRACT_CHANGE: child output requires a live host tuple reader.");
	if (typeof context.prepareCommitIntent !== "function")
		throw new Error("CONTRACT_CHANGE: child output requires an atomic commit-intent seam.");
	const receiptContext = context.receiptContext;
	if (
		!receiptContext ||
		typeof receiptContext !== "object" ||
		!receiptContext.receiptResolver ||
		typeof receiptContext.receiptResolver.resolve !== "function" ||
		typeof receiptContext.receiptResolver.consumeIfOneUse !== "function" ||
		typeof receiptContext.receiptResolver.resolveConsumptionWitness !== "function" ||
		!receiptContext.keyResolver ||
		typeof receiptContext.keyResolver.resolve !== "function" ||
		!receiptContext.revokedReceiptIds ||
		typeof receiptContext.revokedReceiptIds.has !== "function" ||
		!receiptContext.artifactResolver ||
		typeof receiptContext.artifactResolver.resolve !== "function" ||
		!receiptContext.principalAuthorizer ||
		typeof receiptContext.principalAuthorizer.authorize !== "function"
	)
		throw new Error("CONTRACT_CHANGE: child output requires the generic WorkflowHostReceiptConsumerContext.");
	if (typeof context.validateFinalResult !== "function")
		throw new Error("Child output host final-result validator is invalid.");
	if (typeof context.validateArtifactOutput !== "function")
		throw new Error("Child output host artifact validator is invalid.");
}

function parseArtifactRef(value: unknown, label: string): WorkflowArtifactRef {
	assertRecord(value, label);
	assertExactKeys(value, REF_KEYS, label);
	assertNonEmptyString(value.artifactId, `${label}.artifactId`);
	assertRelativePath(value.relativePath, `${label}.relativePath`);
	assertNonEmptyString(value.digest, `${label}.digest`);
	assertSafeInteger(value.sizeBytes, `${label}.sizeBytes`, 0);
	assertSafeInteger(value.sourceEventSequence, `${label}.sourceEventSequence`, 0);
	return {
		artifactId: value.artifactId,
		relativePath: value.relativePath,
		digest: value.digest,
		sizeBytes: value.sizeBytes,
		sourceEventSequence: value.sourceEventSequence,
	};
}

function parseArtifactOutput(value: unknown, label: string): ChildArtifactOutput {
	assertRecord(value, label);
	assertExactKeys(value, ARTIFACT_KEYS, label);
	assertNonEmptyString(value.outputId, `${label}.outputId`);
	assertRelativePath(value.path, `${label}.path`);
	assertNonEmptyString(value.digest, `${label}.digest`);
	assertNonEmptyString(value.schema, `${label}.schema`);
	assertNonEmptyString(value.validator, `${label}.validator`);
	const ref = parseArtifactRef(value.ref, `${label}.ref`);
	if (value.path !== ref.relativePath) throw new Error(`${label} path is not bound to its artifact reference.`);
	if (value.digest !== ref.digest) throw new Error(`${label} digest is not bound to its artifact reference.`);
	return {
		outputId: value.outputId,
		path: value.path,
		ref,
		digest: value.digest,
		schema: value.schema,
		validator: value.validator,
	};
}

function parseSealedArtifact(value: unknown, label: string): ChildSealedArtifact {
	assertRecord(value, label);
	assertExactKeys(value, SEALED_ARTIFACT_KEYS, label);
	assertNonEmptyString(value.outputId, `${label}.outputId`);
	assertRelativePath(value.path, `${label}.path`);
	assertNonEmptyString(value.digest, `${label}.digest`);
	assertNonEmptyString(value.schema, `${label}.schema`);
	assertNonEmptyString(value.validator, `${label}.validator`);
	assertNonEmptyString(value.immutableGeneration, `${label}.immutableGeneration`);
	const ref = parseArtifactRef(value.ref, `${label}.ref`);
	if (value.path !== ref.relativePath || value.digest !== ref.digest)
		throw new Error(`${label} is not bound to its immutable artifact reference.`);
	return {
		outputId: value.outputId,
		path: value.path,
		ref,
		digest: value.digest,
		schema: value.schema,
		validator: value.validator,
		immutableGeneration: value.immutableGeneration,
	};
}

function sealDigestForSeal(seal: ChildArtifactSeal): string {
	return digestObject({
		sealId: seal.sealId,
		producerAttemptId: seal.producerAttemptId,
		producerExecutionId: seal.producerExecutionId,
		epochRef: seal.epochRef,
		head: seal.head,
		outputObligationId: seal.outputObligationId,
		packetDigest: seal.packetDigest,
		artifacts: seal.artifacts,
		receipt: seal.receipt,
		receiptId: seal.receiptId,
		consumptionWitness: seal.consumptionWitness,
		hostStateDigest: seal.hostStateDigest,
		hostRevision: seal.hostRevision,
		receiptDigest: seal.receiptDigest,
		authorizationDigest: seal.authorizationDigest,
	});
}

function parseFinalRequirement(value: unknown): ChildFinalResultRequirement {
	assertRecord(value, "Task declaration final result");
	assertExactKeys(value, FINAL_REQUIREMENT_KEYS, "Task declaration final result");
	assertNonEmptyString(value.schema, "Task declaration final result.schema");
	assertNonEmptyString(value.validator, "Task declaration final result.validator");
	return { schema: value.schema, validator: value.validator };
}

function normalizeBytes(value: unknown, label: string): number[] {
	if (value instanceof Uint8Array) return Array.from(value);
	if (!Array.isArray(value) || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
		throw new Error(`${label} must be a byte array.`);
	return [...value] as number[];
}

/**
 * Canonicalize and digest the bytes of a final assistant result.
 *
 * Args:
 * input: Result identity, canonical JSON bytes, schema, and validator supplied by the child.
 * Return: Detached result whose bytes and digest are authoritative for the reducer.
 */
export function canonicalFinalResult(input: ChildFinalResultInput): ChildFinalAssistantResult {
	assertRecord(input, "Child final assistant result");
	assertExactKeys(input, FINAL_INPUT_KEYS, "Child final assistant result");
	assertNonEmptyString(input.resultId, "Child final assistant result.resultId");
	assertNonEmptyString(input.schema, "Child final assistant result.schema");
	assertNonEmptyString(input.validator, "Child final assistant result.validator");
	const bytes = normalizeBytes(input.bytes, "Child final assistant result.bytes");
	const byteView = Uint8Array.from(bytes);
	if (byteView.byteLength > MAX_CHILD_FINAL_RESULT_BYTES)
		throw new Error("Child final assistant result exceeds the bounded byte limit.");
	const parsed = parseCanonicalJsonBytes(byteView);
	if (!isRecord(parsed) || parsed.resultId !== input.resultId)
		throw new Error("Child final assistant result bytes are not bound to resultId.");
	return cloneAndFreeze({
		resultId: input.resultId,
		bytes,
		digest: sha256Hex(byteView),
		schema: input.schema,
		validator: input.validator,
	});
}

function parseFinalAssistantResult(value: unknown): ChildFinalAssistantResult | null {
	if (value === null) return null;
	assertRecord(value, "Child final assistant result");
	assertExactKeys(value, FINAL_RESULT_KEYS, "Child final assistant result");
	const result = canonicalFinalResult({
		resultId: value.resultId as string,
		bytes: value.bytes as readonly number[],
		schema: value.schema as string,
		validator: value.validator as string,
	});
	assertNonEmptyString(value.digest, "Child final assistant result.digest");
	if (value.digest !== result.digest) throw new Error("Child final assistant result digest is invalid.");
	return result;
}

type ChildResolvedArtifactReadResult = Omit<WorkflowArtifactReadResult, "envelope"> & {
	readonly envelope: WorkflowArtifactReadResult["envelope"] & { readonly immutableGeneration: string };
};

function parseResolvedArtifact(value: unknown, expectedRef: WorkflowArtifactRef): ChildResolvedArtifactReadResult {
	assertRecord(value, "Resolved artifact");
	assertExactKeys(value, ["bytes", "envelope", "exists", "verifiedDigest", "verifiedSizeBytes"], "Resolved artifact");
	if (value.exists !== true || !(value.bytes instanceof Uint8Array))
		throw new Error("Resolved artifact is missing or not durably readable.");
	assertNonEmptyString(value.verifiedDigest, "Resolved artifact.verifiedDigest");
	assertSafeInteger(value.verifiedSizeBytes, "Resolved artifact.verifiedSizeBytes", 0);
	assertRecord(value.envelope, "Resolved artifact envelope");
	assertExactKeys(
		value.envelope,
		["codec", "immutable", "immutableGeneration", "payloadKind", "ref"],
		"Resolved artifact envelope",
	);
	if (value.envelope.immutable !== true) throw new Error("Resolved artifact envelope is mutable.");
	assertNonEmptyString(value.envelope.immutableGeneration, "Resolved artifact envelope.immutableGeneration");
	if (
		!(
			[
				"handoff",
				"evidence",
				"process_identity",
				"effect_result",
				"recovery_finding",
				"barrier",
			] as readonly unknown[]
		).includes(value.envelope.payloadKind)
	)
		throw new Error("Resolved artifact envelope payload kind is invalid.");
	if (!(["canonical_json", "utf8", "binary"] as readonly unknown[]).includes(value.envelope.codec))
		throw new Error("Resolved artifact envelope codec is invalid.");
	const resolvedRef = parseArtifactRef(value.envelope.ref, "Resolved artifact envelope.ref");
	if (!sameArtifactRef(resolvedRef, expectedRef))
		throw new Error("Resolved artifact reference is not the required reference.");
	const bytes = Uint8Array.from(value.bytes);
	if (value.verifiedDigest !== expectedRef.digest || sha256Hex(bytes) !== expectedRef.digest)
		throw new Error("Resolved artifact bytes do not match the required digest.");
	if (value.verifiedSizeBytes !== expectedRef.sizeBytes || bytes.byteLength !== expectedRef.sizeBytes)
		throw new Error("Resolved artifact bytes do not match the required size.");
	return {
		envelope: {
			ref: resolvedRef,
			payloadKind: value.envelope.payloadKind as WorkflowArtifactPayloadKind,
			codec: value.envelope.codec as WorkflowArtifactCodec,
			immutableGeneration: value.envelope.immutableGeneration,
			immutable: true,
		},
		exists: true,
		bytes,
		verifiedDigest: value.verifiedDigest,
		verifiedSizeBytes: value.verifiedSizeBytes,
	};
}

function parseValidatedOutput(value: unknown, label: string): ChildValidatedArtifactOutput {
	assertRecord(value, label);
	assertExactKeys(value, VALIDATED_OUTPUT_KEYS, label);
	assertNonEmptyString(value.outputId, `${label}.outputId`);
	assertRelativePath(value.path, `${label}.path`);
	assertNonEmptyString(value.schema, `${label}.schema`);
	assertNonEmptyString(value.validator, `${label}.validator`);
	if (value.validated !== true) throw new Error(`${label} is not validated.`);
	const ref = parseArtifactRef(value.ref, `${label}.ref`);
	if (value.path !== ref.relativePath) throw new Error(`${label} path is not bound to its reference.`);
	return {
		outputId: value.outputId,
		path: value.path,
		ref,
		schema: value.schema,
		validator: value.validator,
		validated: true,
	};
}

function parseConsumptionWitness(value: unknown, label: string): ChildOutputConsumptionWitness {
	assertRecord(value, label);
	assertExactKeys(value, WITNESS_KEYS, label);
	assertNonEmptyString(value.receiptId, `${label}.receiptId`);
	assertNonEmptyString(value.workflowId, `${label}.workflowId`);
	assertNonEmptyString(value.bindingDigest, `${label}.bindingDigest`);
	if (value.capability !== null) assertNonEmptyString(value.capability, `${label}.capability`);
	if (value.resourceDigest !== null) assertNonEmptyString(value.resourceDigest, `${label}.resourceDigest`);
	if (value.operationDigest !== null) assertNonEmptyString(value.operationDigest, `${label}.operationDigest`);
	assertNonEmptyString(value.receiptDigest, `${label}.receiptDigest`);
	assertNonEmptyString(value.consumedAt, `${label}.consumedAt`);
	assertSafeInteger(value.consumptionSequence, `${label}.consumptionSequence`, 1);
	return {
		receiptId: value.receiptId,
		workflowId: value.workflowId,
		bindingDigest: value.bindingDigest,
		capability: value.capability as ChildOutputConsumptionWitness["capability"],
		resourceDigest: value.resourceDigest as string | null,
		operationDigest: value.operationDigest as string | null,
		receiptDigest: value.receiptDigest,
		consumedAt: value.consumedAt,
		consumptionSequence: value.consumptionSequence,
	};
}

function revocationIntentDigest(input: Omit<ChildProducerRevocationIntent, "intentDigest">): string {
	return digestObject(input);
}

function fenceIdForFence(fence: ChildProducerFence): string {
	return digestObject({
		sealId: fence.sealId,
		sealDigest: fence.sealDigest,
		producerAttemptId: fence.producerAttemptId,
		producerExecutionId: fence.producerExecutionId,
		outputObligationId: fence.outputObligationId,
		hostAuthorityDigest: fence.hostAuthorityDigest,
		revocationIntent: fence.revocationIntent,
		epochRef: fence.epochRef,
		head: fence.head,
	});
}

function parseRevocationIntent(value: unknown, label: string): ChildProducerRevocationIntent {
	assertRecord(value, label);
	assertExactKeys(value, REVOCATION_INTENT_KEYS, label);
	if (value.operation !== "revoke_producer_write") throw new Error(`${label}.operation is invalid.`);
	assertNonEmptyString(value.attemptId, `${label}.attemptId`);
	assertNonEmptyString(value.producerExecutionId, `${label}.producerExecutionId`);
	assertNonEmptyString(value.sealDigest, `${label}.sealDigest`);
	assertNonEmptyString(value.outputObligationId, `${label}.outputObligationId`);
	const epochRef = parseEpoch(value.epochRef, `${label}.epochRef`);
	const head = parseHead(value.head, headWorkflowId(value.head, `${label}.head`), epochRef, `${label}.head`);
	assertNonEmptyString(value.intentDigest, `${label}.intentDigest`);
	const input = {
		operation: "revoke_producer_write" as const,
		attemptId: value.attemptId,
		producerExecutionId: value.producerExecutionId,
		sealDigest: value.sealDigest,
		outputObligationId: value.outputObligationId,
		epochRef,
		head,
	};
	if (value.intentDigest !== revocationIntentDigest(input)) throw new Error(`${label}.intentDigest is invalid.`);
	return { ...input, intentDigest: value.intentDigest };
}

function commitIntentDigest(input: ChildOutputCommitIntentInput): string {
	return digestObject(input);
}

function parseCommitIntent(value: unknown, label: string): ChildOutputCommitIntent | null {
	if (value === null) return null;
	assertRecord(value, label);
	assertExactKeys(value, COMMIT_INTENT_KEYS, label);
	if (
		![
			"artifact_seal",
			"terminal_send",
			"parent_delivery_ack",
			"artifact_drift",
			"compaction",
			"terminal_gate",
		].includes(value.operation as string)
	)
		throw new Error(`${label}.operation is invalid.`);
	assertNonEmptyString(value.eventId, `${label}.eventId`);
	assertNonEmptyString(value.eventDigest, `${label}.eventDigest`);
	assertNonEmptyString(value.workflowId, `${label}.workflowId`);
	assertNonEmptyString(value.taskId, `${label}.taskId`);
	assertNonEmptyString(value.childId, `${label}.childId`);
	assertNonEmptyString(value.runId, `${label}.runId`);
	assertNonEmptyString(value.attemptId, `${label}.attemptId`);
	if (value.producerExecutionId !== null)
		assertNonEmptyString(value.producerExecutionId, `${label}.producerExecutionId`);
	assertNonEmptyString(value.outputObligationId, `${label}.outputObligationId`);
	const epochRef = parseEpoch(value.epochRef, `${label}.epochRef`);
	const head = parseHead(value.head, value.workflowId, epochRef, `${label}.head`);
	assertNonEmptyString(value.expectedStateDigest, `${label}.expectedStateDigest`);
	assertNonEmptyString(value.hostStateDigest, `${label}.hostStateDigest`);
	assertSafeInteger(value.hostRevision, `${label}.hostRevision`, 0);
	if (value.packetDigest !== null) assertNonEmptyString(value.packetDigest, `${label}.packetDigest`);
	if (value.sealDigest !== null) assertNonEmptyString(value.sealDigest, `${label}.sealDigest`);
	if (value.producerFenceId !== null) assertNonEmptyString(value.producerFenceId, `${label}.producerFenceId`);
	if (value.deliveryId !== null) assertNonEmptyString(value.deliveryId, `${label}.deliveryId`);
	assertNonEmptyString(value.intentDigest, `${label}.intentDigest`);
	const input: ChildOutputCommitIntentInput = {
		operation: value.operation as ChildOutputCommitOperation,
		eventId: value.eventId,
		eventDigest: value.eventDigest,
		workflowId: value.workflowId,
		taskId: value.taskId,
		childId: value.childId,
		runId: value.runId,
		attemptId: value.attemptId,
		producerExecutionId: value.producerExecutionId as string | null,
		outputObligationId: value.outputObligationId,
		epochRef,
		head,
		expectedStateDigest: value.expectedStateDigest,
		hostStateDigest: value.hostStateDigest,
		hostRevision: value.hostRevision,
		packetDigest: value.packetDigest as string | null,
		sealDigest: value.sealDigest as string | null,
		producerFenceId: value.producerFenceId as string | null,
		deliveryId: value.deliveryId as string | null,
	};
	if (value.intentDigest !== commitIntentDigest(input)) throw new Error(`${label}.intentDigest is invalid.`);
	return { ...input, intentDigest: value.intentDigest };
}

function parseAttemptStatus(value: unknown, label: string): ChildAttemptStatus {
	if (
		![
			"running",
			"validating",
			"delivered_pending_ack",
			"completed",
			"retryable_incomplete",
			"cancelled",
			"terminal_failed",
			"scope_changed",
			"quarantined",
		].includes(value as string)
	)
		throw new Error(`${label} is not a valid child attempt status.`);
	return value as ChildAttemptStatus;
}

function parseChildTaskDeclarationShape(value: unknown): ChildTaskDeclaration {
	assertRecord(value, "Child task declaration");
	assertExactKeys(value, DECLARATION_KEYS, "Child task declaration");
	if (value.version !== CHILD_OUTPUT_CONTRACT_VERSION)
		throw new Error(`Unsupported child output contract version: ${String(value.version)}.`);
	assertNonEmptyString(value.taskId, "Task declaration taskId");
	assertNonEmptyString(value.childId, "Task declaration childId");
	assertNonEmptyString(value.runId, "Task declaration runId");
	assertNonEmptyString(value.attemptId, "Task declaration attemptId");
	assertNonEmptyString(value.workflowId, "Task declaration workflowId");
	const epochRef = parseEpoch(value.epochRef, "Task declaration epochRef");
	const head = parseHead(value.head, value.workflowId, epochRef, "Task declaration head");
	assertSafeInteger(value.maxAttempts, "Task declaration maxAttempts", 1);
	if (value.maxAttempts > MAX_CHILD_ATTEMPTS)
		throw new Error("Task declaration maxAttempts exceeds the finite limit.");
	assertSafeInteger(value.maxCompactions, "Task declaration maxCompactions", 1);
	if (value.maxCompactions > MAX_CHILD_COMPACTIONS)
		throw new Error("Task declaration maxCompactions exceeds the finite limit.");
	if (!Array.isArray(value.requiredArtifacts) || value.requiredArtifacts.length === 0)
		throw new Error("Task declaration requires a finite non-empty artifact output set.");
	if (value.requiredArtifacts.length > MAX_CHILD_REQUIRED_OUTPUTS)
		throw new Error("Task declaration artifact output set exceeds the finite limit.");
	const requiredArtifacts = value.requiredArtifacts.map((artifact, index) =>
		parseArtifactOutput(artifact, `Required artifact ${index}`),
	);
	const outputIds = new Set<string>();
	for (const artifact of requiredArtifacts) {
		if (outputIds.has(artifact.outputId)) throw new Error("Task declaration artifact output IDs must be unique.");
		outputIds.add(artifact.outputId);
	}
	return cloneAndFreeze({
		version: CHILD_OUTPUT_CONTRACT_VERSION,
		taskId: value.taskId,
		childId: value.childId,
		runId: value.runId,
		attemptId: value.attemptId,
		workflowId: value.workflowId,
		head,
		epochRef,
		maxAttempts: value.maxAttempts,
		maxCompactions: value.maxCompactions,
		requiredFinalResult: parseFinalRequirement(value.requiredFinalResult),
		requiredArtifacts,
	});
}

/**
 * Parse and normalize a closed child task declaration bound to the host context.
 *
 * Args:
 * value: Untrusted versioned child task declaration.
 * context: Authenticated host tuple, runtime gate, artifact resolver, receipt consumer, and validators.
 * Return: Immutable declaration bound to the supplied host context.
 */
export function parseChildTaskDeclaration(value: unknown, context: ChildOutputHostContext): ChildTaskDeclaration {
	assertHostContext(context);
	const declaration = parseChildTaskDeclarationShape(value);
	const hostTuple = parseHostTuple(context.hostTuple, "Child output host tuple");
	if (
		declaration.workflowId !== hostTuple.workflowId ||
		!sameEpoch(declaration.epochRef, hostTuple.epochRef) ||
		digestObject(declaration.head) !== digestObject(hostTuple.head)
	)
		throw new Error("Child task declaration is not bound to the host workflow, head, and epoch.");
	return declaration;
}

/**
 * Parse a closed child output event before reducer authority checks.
 *
 * Args:
 * value: Untrusted event from the child or parent delivery path.
 * Return: Detached typed event with canonical final-result and binding fields.
 */
export function parseChildOutputEvent(value: unknown): ChildOutputEvent {
	assertRecord(value, "Child output event");
	assertNonEmptyString(value.kind, "Child output event.kind");
	assertNonEmptyString(value.eventId, "Child output event.eventId");
	assertNonEmptyString(value.attemptId, "Child output event.attemptId");
	assertNonEmptyString(value.workflowId, "Child output event.workflowId");
	assertNonEmptyString(value.expectedStateDigest, "Child output event.expectedStateDigest");
	const epochRef = parseEpoch(value.epochRef, "Child output event.epochRef");
	const head = parseHead(value.head, value.workflowId, epochRef, "Child output event.head");
	const base: ChildOutputEventBase = {
		eventId: value.eventId,
		attemptId: value.attemptId,
		workflowId: value.workflowId,
		head,
		epochRef,
		expectedStateDigest: value.expectedStateDigest,
	};
	switch (value.kind) {
		case "child_finished": {
			assertExactKeys(
				value,
				[
					...EVENT_BASE_KEYS,
					"artifacts",
					"finalAssistantResult",
					"packetDigest",
					"producerExecutionId",
					"toolResults",
				],
				"Child finished event",
			);
			if (!Array.isArray(value.toolResults)) throw new Error("Child finished event requires tool results.");
			if (!Array.isArray(value.artifacts)) throw new Error("Child finished event requires artifact outputs.");
			assertNonEmptyString(value.packetDigest, "Child finished event.packetDigest");
			assertNonEmptyString(value.producerExecutionId, "Child finished event.producerExecutionId");
			return {
				...base,
				kind: "child_finished",
				finalAssistantResult: parseFinalAssistantResult(value.finalAssistantResult),
				toolResults: value.toolResults,
				artifacts: value.artifacts.map((artifact, index) =>
					parseArtifactOutput(artifact, `Child finished artifact ${index}`),
				),
				packetDigest: value.packetDigest,
				producerExecutionId: value.producerExecutionId,
			};
		}
		case "provisional_progress":
			assertExactKeys(
				value,
				[...EVENT_BASE_KEYS, "producerExecutionId", "progressDigest"],
				"Provisional progress event",
			);
			assertNonEmptyString(value.producerExecutionId, "Provisional progress producerExecutionId");
			assertNonEmptyString(value.progressDigest, "Provisional progress progressDigest");
			return {
				...base,
				kind: "provisional_progress",
				producerExecutionId: value.producerExecutionId,
				progressDigest: value.progressDigest,
			};
		case "artifact_seal_recorded": {
			assertExactKeys(
				value,
				[
					...EVENT_BASE_KEYS,
					"artifacts",
					"outputObligationId",
					"packetDigest",
					"producerExecutionId",
					"sealId",
					"witness",
				],
				"Artifact seal event",
			);
			if (!Array.isArray(value.artifacts)) throw new Error("Artifact seal event requires immutable artifacts.");
			assertNonEmptyString(value.outputObligationId, "Artifact seal outputObligationId");
			assertNonEmptyString(value.packetDigest, "Artifact seal packetDigest");
			assertNonEmptyString(value.producerExecutionId, "Artifact seal producerExecutionId");
			assertNonEmptyString(value.sealId, "Artifact seal sealId");
			const witness = parseHostReceipt(value.witness, "Artifact seal witness");
			return {
				...base,
				kind: "artifact_seal_recorded",
				artifacts: value.artifacts.map((artifact, index) =>
					parseArtifactOutput(artifact, `Artifact seal ${index}`),
				),
				outputObligationId: value.outputObligationId,
				packetDigest: value.packetDigest,
				producerExecutionId: value.producerExecutionId,
				sealId: value.sealId,
				witness,
			};
		}
		case "producer_write_attempted":
			assertExactKeys(
				value,
				[...EVENT_BASE_KEYS, "path", "producerExecutionId", "writeDigest"],
				"Producer write event",
			);
			assertRelativePath(value.path, "Producer write path");
			assertNonEmptyString(value.producerExecutionId, "Producer write producerExecutionId");
			assertNonEmptyString(value.writeDigest, "Producer write writeDigest");
			return {
				...base,
				kind: "producer_write_attempted",
				path: value.path,
				producerExecutionId: value.producerExecutionId,
				writeDigest: value.writeDigest,
			};
		case "seal_drift_detected": {
			assertExactKeys(value, [...EVENT_BASE_KEYS, "producerExecutionId", "witness"], "Seal drift event");
			assertNonEmptyString(value.producerExecutionId, "Seal drift producerExecutionId");
			const witness = parseHostReceipt(value.witness, "Seal drift witness");
			return {
				...base,
				kind: "seal_drift_detected",
				producerExecutionId: value.producerExecutionId,
				witness,
			};
		}
		case "outputs_validated":
			assertExactKeys(value, [...EVENT_BASE_KEYS, "outputs"], "Output validation event");
			if (!Array.isArray(value.outputs)) throw new Error("Output validation event requires outputs.");
			return {
				...base,
				kind: "outputs_validated",
				outputs: value.outputs.map((output, index) => parseValidatedOutput(output, `Validated output ${index}`)),
			};
		case "parent_delivery_acknowledged": {
			assertExactKeys(value, [...EVENT_BASE_KEYS, "deliveryId", "receipt"], "Parent delivery acknowledgement");
			assertNonEmptyString(value.deliveryId, "Parent delivery acknowledgement.deliveryId");
			const receipt = parseHostReceipt(value.receipt, "Parent delivery receipt");
			return { ...base, kind: "parent_delivery_acknowledged", deliveryId: value.deliveryId, receipt };
		}
		case "attempt_retried":
			assertExactKeys(
				value,
				[...EVENT_BASE_KEYS, "lineageDigest", "newAttemptId", "priorAttemptId"],
				"Attempt retry event",
			);
			assertNonEmptyString(value.priorAttemptId, "Attempt retry priorAttemptId");
			assertNonEmptyString(value.newAttemptId, "Attempt retry newAttemptId");
			assertNonEmptyString(value.lineageDigest, "Attempt retry lineageDigest");
			return {
				...base,
				kind: "attempt_retried",
				priorAttemptId: value.priorAttemptId,
				newAttemptId: value.newAttemptId,
				lineageDigest: value.lineageDigest,
			};
		case "compaction_completed": {
			assertExactKeys(
				value,
				[...EVENT_BASE_KEYS, "compactionCount", "compactionId", "evidenceRef", "queueEmpty", "wakeId", "witness"],
				"Compaction completion event",
			);
			assertNonEmptyString(value.compactionId, "Compaction completion compactionId");
			assertSafeInteger(value.compactionCount, "Compaction completion compactionCount", 1);
			const evidenceRef = parseArtifactRef(value.evidenceRef, "Compaction completion evidenceRef");
			if (value.queueEmpty !== true) throw new Error("Compaction completion requires an empty queue.");
			assertNonEmptyString(value.wakeId, "Compaction completion wakeId");
			const witness = parseHostReceipt(value.witness, "Compaction completion witness");
			return {
				...base,
				kind: "compaction_completed",
				compactionId: value.compactionId,
				compactionCount: value.compactionCount,
				evidenceRef,
				queueEmpty: true,
				wakeId: value.wakeId,
				witness,
			};
		}
		case "obligation_cancelled":
			assertExactKeys(value, [...EVENT_BASE_KEYS, "reason", "witness"], "Obligation cancellation event");
			assertNonEmptyString(value.reason, "Obligation cancellation reason");
			return {
				...base,
				kind: "obligation_cancelled",
				reason: value.reason,
				witness: parseHostReceipt(value.witness, "Obligation cancellation witness"),
			};
		case "terminal_failure_recorded":
			assertExactKeys(value, [...EVENT_BASE_KEYS, "reason", "witness"], "Terminal failure event");
			assertNonEmptyString(value.reason, "Terminal failure reason");
			return {
				...base,
				kind: "terminal_failure_recorded",
				reason: value.reason,
				witness: parseHostReceipt(value.witness, "Terminal failure witness"),
			};
		case "scope_change_approved":
			assertExactKeys(value, [...EVENT_BASE_KEYS, "scopeDigest", "witness"], "Scope change event");
			assertNonEmptyString(value.scopeDigest, "Scope change scopeDigest");
			return {
				...base,
				kind: "scope_change_approved",
				scopeDigest: value.scopeDigest,
				witness: parseHostReceipt(value.witness, "Scope-change witness"),
			};
		case "coordinator_wake_claimed":
			assertExactKeys(value, [...EVENT_BASE_KEYS, "claimId", "wakeKey"], "Coordinator wake claim event");
			assertNonEmptyString(value.claimId, "Coordinator wake claim claimId");
			assertNonEmptyString(value.wakeKey, "Coordinator wake claim wakeKey");
			return { ...base, kind: "coordinator_wake_claimed", claimId: value.claimId, wakeKey: value.wakeKey };
		case "coordinator_wake_processed":
			assertExactKeys(value, [...EVENT_BASE_KEYS, "claimId", "wakeKey"], "Coordinator wake processed event");
			assertNonEmptyString(value.claimId, "Coordinator wake processed claimId");
			assertNonEmptyString(value.wakeKey, "Coordinator wake processed wakeKey");
			return { ...base, kind: "coordinator_wake_processed", claimId: value.claimId, wakeKey: value.wakeKey };
		case "coordinator_wake_failed":
			assertExactKeys(value, [...EVENT_BASE_KEYS, "claimId", "reason", "wakeKey"], "Coordinator wake failure event");
			assertNonEmptyString(value.claimId, "Coordinator wake failure claimId");
			assertNonEmptyString(value.wakeKey, "Coordinator wake failure wakeKey");
			assertNonEmptyString(value.reason, "Coordinator wake failure reason");
			return {
				...base,
				kind: "coordinator_wake_failed",
				claimId: value.claimId,
				wakeKey: value.wakeKey,
				reason: value.reason,
			};
		case "follow_up_requested":
			assertExactKeys(value, [...EVENT_BASE_KEYS, "requestId"], "Follow-up request");
			assertNonEmptyString(value.requestId, "Follow-up requestId");
			return { ...base, kind: "follow_up_requested", requestId: value.requestId };
		case "attempt_completed":
			assertExactKeys(value, EVENT_BASE_KEYS, "Attempt completion event");
			return { ...base, kind: "attempt_completed" };
		default:
			throw new Error(`Unknown child output event kind: ${String(value.kind)}.`);
	}
}

function digestable(value: unknown): unknown {
	if (value === undefined) return null;
	if (value instanceof Uint8Array) return Array.from(value);
	if (Array.isArray(value)) return value.map((item) => digestable(item));
	if (isRecord(value)) {
		const record: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) record[key] = digestable(item);
		return record;
	}
	return value;
}

function eventDigest(event: ChildOutputEvent): string {
	return digestObject(digestable(event));
}

function terminalPacketDigest(
	finalAssistantResult: ChildFinalAssistantResult | null,
	toolResults: readonly unknown[],
	artifacts: readonly ChildArtifactOutput[],
): string {
	return digestObject({ finalAssistantResult, toolResults, artifacts });
}

function contractDigest(declaration: ChildTaskDeclaration): string {
	return digestObject(declaration);
}

type ChildAttemptStateFields = Omit<ChildAttemptState, "stateDigest">;

function lineageEntryDigest(input: Omit<ChildAttemptLineage, "lineageDigest">): string {
	return digestObject({
		attemptId: input.attemptId,
		priorAttemptId: input.priorAttemptId,
		attemptNumber: input.attemptNumber,
		taskId: input.taskId,
		childId: input.childId,
		runId: input.runId,
		workflowId: input.workflowId,
		head: input.head,
		epochRef: input.epochRef,
		declarationDigest: input.declarationDigest,
		status: input.status,
		terminalStateDigest: input.terminalStateDigest,
		retryEventId: input.retryEventId,
	});
}

function makeLineageEntry(input: Omit<ChildAttemptLineage, "lineageDigest">): ChildAttemptLineage {
	return cloneAndFreeze({ ...input, lineageDigest: lineageEntryDigest(input) });
}

function stateProjection(state: ChildAttemptStateFields | ChildAttemptState): unknown {
	return {
		acknowledgementAuthorizationDigest: state.acknowledgementAuthorizationDigest,
		acknowledgementConsumptionWitness: state.acknowledgementConsumptionWitness,
		acknowledgementReceipt: state.acknowledgementReceipt,
		acknowledgementReceiptId: state.acknowledgementReceiptId,
		acknowledgementReceiptDigest: state.acknowledgementReceiptDigest,
		appliedEventDigests: state.appliedEventDigests,
		attemptId: state.attemptId,
		attemptLineage: state.attemptLineage,
		attemptNumber: state.attemptNumber,
		bindingDigest: state.bindingDigest,
		childId: state.childId,
		artifactSeal: state.artifactSeal,
		compactionCount: state.compactionCount,
		compactionNoProgressCount: state.compactionNoProgressCount,
		coordinator: state.coordinator,
		continuationEscalation: state.continuationEscalation,
		continuationWake: state.continuationWake,
		declarationDigest: contractDigest(state.declaration),
		diagnostic: state.diagnostic,
		durableCommitIntent: state.durableCommitIntent,
		deliveryId: state.deliveryId,
		epochRef: state.epochRef,
		finalAssistantResult: state.finalAssistantResult,
		head: state.head,
		lastEventId: state.lastEventId,
		lastCompactionEvidenceDigest: state.lastCompactionEvidenceDigest,
		lastCompactionHeadDigest: state.lastCompactionHeadDigest,
		maxAttempts: state.maxAttempts,
		outputObligation: state.outputObligation,
		producerFence: state.producerFence,
		priorAttemptId: state.priorAttemptId,
		provisionalProducerExecutionId: state.provisionalProducerExecutionId,
		provisionalProgressDigest: state.provisionalProgressDigest,
		quarantineReason: state.quarantineReason,
		reason: state.reason,
		reportedArtifacts: state.reportedArtifacts,
		retryEventId: state.retryEventId,
		runId: state.runId,
		status: state.status,
		taskId: state.taskId,
		terminalPacketDigest: state.terminalPacketDigest,
		terminalToolResults: state.terminalToolResults,
		validatedOutputs: state.validatedOutputs,
		workflowId: state.workflowId,
	};
}

function makeState(input: ChildAttemptStateFields): ChildAttemptState {
	return cloneAndFreeze({ ...input, stateDigest: digestObject(stateProjection(input)) });
}

/**
 * Recompute a child attempt state digest from its durable projection.
 *
 * Args:
 * state: State projection, including its stored digest if present.
 * Return: Digest recomputed from all state fields that affect authority.
 */
export function recomputeChildAttemptStateDigest(state: ChildAttemptState): string {
	return digestObject(stateProjection(state));
}

function omitStateDigest(state: ChildAttemptState): ChildAttemptStateFields {
	const { stateDigest: _stateDigest, ...fields } = state;
	return fields;
}

function updateCurrentLineage(state: ChildAttemptState, status: ChildAttemptStatus): readonly ChildAttemptLineage[] {
	if (state.attemptLineage.length === 0) throw new Error("Child attempt lineage is empty.");
	const lastIndex = state.attemptLineage.length - 1;
	const current = state.attemptLineage[lastIndex];
	const updated = makeLineageEntry({ ...current, status });
	return [...state.attemptLineage.slice(0, lastIndex), updated];
}

function updateCurrentLineageHead(state: ChildAttemptState, head: WorkflowJournalHead): readonly ChildAttemptLineage[] {
	if (state.attemptLineage.length === 0) throw new Error("Child attempt lineage is empty.");
	const lastIndex = state.attemptLineage.length - 1;
	const current = state.attemptLineage[lastIndex];
	const updated = makeLineageEntry({ ...current, head });
	return [...state.attemptLineage.slice(0, lastIndex), updated];
}

function withEvent(
	state: ChildAttemptState,
	event: ChildOutputEvent,
	changes: ChildAttemptStateFields,
): ChildAttemptState {
	const appliedEventDigests = { ...state.appliedEventDigests, [event.eventId]: eventDigest(event) };
	return makeState({
		...changes,
		attemptLineage: updateCurrentLineage(state, changes.status),
		appliedEventDigests,
		lastEventId: event.eventId,
	});
}

function assertFinalResultMatches(declaration: ChildTaskDeclaration, result: ChildFinalAssistantResult): void {
	if (
		result.schema !== declaration.requiredFinalResult.schema ||
		result.validator !== declaration.requiredFinalResult.validator
	)
		throw new Error("Child final assistant result does not match its declared schema or validator.");
}

function assertReportedArtifactsMatch(
	declaration: ChildTaskDeclaration,
	artifacts: readonly ChildArtifactOutput[],
): void {
	if (artifacts.length !== declaration.requiredArtifacts.length)
		throw new Error("Child finished event omitted a required artifact output.");
	const seen = new Set<string>();
	for (const artifact of artifacts) {
		if (seen.has(artifact.outputId)) throw new Error("Child finished event contains duplicate artifact outputs.");
		seen.add(artifact.outputId);
		const required = declaration.requiredArtifacts.find((candidate) => candidate.outputId === artifact.outputId);
		if (
			!required ||
			artifact.path !== required.path ||
			artifact.digest !== required.digest ||
			!sameArtifactRef(artifact.ref, required.ref) ||
			artifact.schema !== required.schema ||
			artifact.validator !== required.validator
		)
			throw new Error("Child finished artifact output is not bound to the declaration.");
	}
}

function validateOutputIdentity(
	declaration: ChildTaskDeclaration,
	reportedArtifacts: readonly ChildArtifactOutput[],
	outputs: readonly ChildValidatedArtifactOutput[],
): void {
	if (outputs.length !== declaration.requiredArtifacts.length)
		throw new Error("Child output validation is incomplete.");
	const seen = new Set<string>();
	for (const output of outputs) {
		if (seen.has(output.outputId)) throw new Error("Child output validation contains a duplicate output.");
		seen.add(output.outputId);
		const required = declaration.requiredArtifacts.find((candidate) => candidate.outputId === output.outputId);
		const reported = reportedArtifacts.find((candidate) => candidate.outputId === output.outputId);
		if (
			!required ||
			!reported ||
			output.path !== required.path ||
			output.path !== output.ref.relativePath ||
			output.schema !== required.schema ||
			output.validator !== required.validator ||
			!sameArtifactRef(output.ref, required.ref) ||
			output.validated !== true
		)
			throw new Error("Child output validation is not bound to the durable required output contract.");
	}
}

async function resolveValidatedOutputs(
	context: ChildOutputHostContext,
	declaration: ChildTaskDeclaration,
	reportedArtifacts: readonly ChildArtifactOutput[],
	outputs: readonly ChildValidatedArtifactOutput[],
): Promise<readonly ChildValidatedArtifactOutput[]> {
	validateOutputIdentity(declaration, reportedArtifacts, outputs);
	const resolvedOutputs: ChildValidatedArtifactOutput[] = [];
	for (const output of outputs) {
		const required = declaration.requiredArtifacts.find((candidate) => candidate.outputId === output.outputId);
		if (!required) throw new Error("Child output validation references an unknown output.");
		const resolvedArtifact = parseResolvedArtifact(
			await context.receiptContext.artifactResolver.resolve(required.ref),
			required.ref,
		);
		await context.validateArtifactOutput({ output, required, resolvedArtifact });
		resolvedOutputs.push({
			outputId: output.outputId,
			path: output.path,
			ref: { ...output.ref },
			schema: output.schema,
			validator: output.validator,
			validated: true,
		});
	}
	return cloneAndFreeze(resolvedOutputs);
}

function assertEventHostBinding(
	event: ChildOutputEvent,
	state: ChildAttemptState,
	hostTuple: ChildOutputHostTuple,
	allowHeadAdvance: boolean,
	isReplay: boolean,
): void {
	if (event.workflowId !== hostTuple.workflowId || event.workflowId !== state.workflowId)
		throw new Error("Child output event is fenced to another workflow.");
	if (!sameEpoch(event.epochRef, hostTuple.epochRef) || !sameEpoch(event.epochRef, state.epochRef))
		throw new Error("Child output event is fenced by a stale epoch.");
	if (!isReplay && digestObject(event.head) !== digestObject(hostTuple.head))
		throw new Error("Child output event is fenced to another workflow head.");
	if (!isReplay && !allowHeadAdvance && digestObject(event.head) !== digestObject(state.head))
		throw new Error("Child output event is fenced to another workflow head.");
	if (
		!isReplay &&
		allowHeadAdvance &&
		(event.head.sequence < state.head.sequence ||
			(event.head.sequence === state.head.sequence && digestObject(event.head) !== digestObject(state.head)))
	)
		throw new Error("Child compaction event cannot move the workflow head backwards.");
}

function assertLineageIntegrity(state: ChildAttemptState): void {
	if (state.attemptLineage.length === 0) throw new Error("Child attempt lineage is empty.");
	const attemptIds = new Set<string>();
	for (let index = 0; index < state.attemptLineage.length; index += 1) {
		const entry = state.attemptLineage[index];
		if (attemptIds.has(entry.attemptId)) throw new Error("Child attempt ID was reused in its immutable lineage.");
		attemptIds.add(entry.attemptId);
		if (
			entry.taskId !== state.taskId ||
			entry.childId !== state.childId ||
			entry.runId !== state.runId ||
			entry.workflowId !== state.workflowId ||
			!sameEpoch(entry.epochRef, state.epochRef) ||
			entry.head.sequence < state.declaration.head.sequence
		)
			throw new Error("Child attempt lineage is not bound to its workflow head and epoch.");
		if (entry.attemptNumber !== index + 1) throw new Error("Child attempt lineage numbering is not contiguous.");
		const expectedDigest = lineageEntryDigest({
			attemptId: entry.attemptId,
			priorAttemptId: entry.priorAttemptId,
			attemptNumber: entry.attemptNumber,
			taskId: entry.taskId,
			childId: entry.childId,
			runId: entry.runId,
			workflowId: entry.workflowId,
			head: entry.head,
			epochRef: entry.epochRef,
			declarationDigest: entry.declarationDigest,
			status: entry.status,
			terminalStateDigest: entry.terminalStateDigest,
			retryEventId: entry.retryEventId,
		});
		if (entry.lineageDigest !== expectedDigest) throw new Error("Child attempt lineage integrity is invalid.");
		if (index === 0 && entry.priorAttemptId !== null) throw new Error("Child attempt lineage root is invalid.");
		if (index > 0 && entry.priorAttemptId !== state.attemptLineage[index - 1].attemptId)
			throw new Error("Child attempt lineage link is invalid.");
		if (index < state.attemptLineage.length - 1) {
			if (entry.terminalStateDigest === null || entry.retryEventId === null)
				throw new Error("Prior child attempt lineage entry is not terminally recorded.");
			if (entry.status !== "completed" && entry.status !== "retryable_incomplete" && entry.status !== "quarantined")
				throw new Error("Prior child attempt lineage entry is not terminal.");
		}
	}
	const current = state.attemptLineage[state.attemptLineage.length - 1];
	if (current.attemptId !== state.attemptId || current.attemptNumber !== state.attemptNumber)
		throw new Error("Child attempt lineage does not identify the current attempt.");
	if (digestObject(current.head) !== digestObject(state.head))
		throw new Error("Current child attempt lineage head is not bound to the state.");
	if (current.declarationDigest !== state.bindingDigest)
		throw new Error("Current child attempt lineage declaration is not bound to the state.");
	if (current.status !== state.status || current.terminalStateDigest !== null || current.retryEventId !== null)
		throw new Error("Current child attempt lineage entry is not open.");
}

function makeOutputObligation(declaration: ChildTaskDeclaration): ChildOutputObligation {
	const declarationDigest = contractDigest(declaration);
	return cloneAndFreeze({
		obligationId: outputObligationIdFor(declaration, declarationDigest),
		declarationDigest,
		taskId: declaration.taskId,
		childId: declaration.childId,
		runId: declaration.runId,
		attemptId: declaration.attemptId,
		requiredFinalResult: { ...declaration.requiredFinalResult },
		requiredArtifactOutputIds: declaration.requiredArtifacts.map((artifact) => artifact.outputId),
		status: "undischarged",
		terminalEventId: null,
		terminalReason: null,
	});
}

function outputObligationIdFor(
	declaration: ChildTaskDeclaration,
	declarationDigest = contractDigest(declaration),
): string {
	return digestObject({
		workflowId: declaration.workflowId,
		taskId: declaration.taskId,
		childId: declaration.childId,
		runId: declaration.runId,
		attemptId: declaration.attemptId,
		declarationDigest,
	});
}

function initialCoordinatorProjection(): ChildCoordinatorProjection {
	return {
		meaningfulProgressDigest: null,
		deadline: {
			status: "pending",
			transitionEventId: null,
			transitionReason: null,
		},
		terminal: null,
		wake: null,
	};
}

function coordinatorWakeKey(state: ChildAttemptState): string {
	return digestObject({
		workflowId: state.workflowId,
		taskId: state.taskId,
		childId: state.childId,
		runId: state.runId,
		attemptId: state.attemptId,
		obligation: "required_output",
	});
}

function makeCoordinatorWake(
	state: ChildAttemptState,
	event: ChildOutputEvent,
	kind: ChildCoordinatorWakeKind,
): ChildCoordinatorWake {
	return {
		wakeKey: coordinatorWakeKey(state),
		kind,
		createdByEventId: event.eventId,
		status: "pending",
		claimId: null,
		processedEventId: null,
		failureReason: null,
	};
}

function coordinatorWithWake(
	state: ChildAttemptState,
	event: ChildOutputEvent,
	kind: ChildCoordinatorWakeKind,
	replaceKind = false,
): ChildCoordinatorProjection {
	if (state.coordinator.wake !== null) {
		return replaceKind ? { ...state.coordinator, wake: { ...state.coordinator.wake, kind } } : state.coordinator;
	}
	return { ...state.coordinator, wake: makeCoordinatorWake(state, event, kind) };
}

function coordinatorProgressDigest(evidenceDigest: string, head: WorkflowJournalHead): string {
	return digestObject({ evidenceDigest, head });
}

function coordinatorDeadline(
	status: ChildOutputDeadlineStatus,
	eventId: string,
	transitionReason: string,
): ChildOutputDeadlineTransition {
	return { status, transitionEventId: eventId, transitionReason };
}

function coordinatorTerminal(
	status: ChildCoordinatorTerminalTransition["status"],
	eventId: string,
	reason: string,
): ChildCoordinatorTerminalTransition {
	return { status, eventId, reason };
}

function assertOutputObligationIntegrity(state: ChildAttemptState): void {
	const obligation = state.outputObligation;
	if (
		obligation.obligationId !== outputObligationIdFor(state.declaration, state.bindingDigest) ||
		obligation.declarationDigest !== state.bindingDigest ||
		obligation.taskId !== state.taskId ||
		obligation.childId !== state.childId ||
		obligation.runId !== state.runId ||
		obligation.attemptId !== state.attemptId ||
		obligation.requiredFinalResult.schema !== state.declaration.requiredFinalResult.schema ||
		obligation.requiredFinalResult.validator !== state.declaration.requiredFinalResult.validator ||
		obligation.requiredArtifactOutputIds.length !== state.declaration.requiredArtifacts.length ||
		obligation.requiredArtifactOutputIds.some(
			(outputId, index) => outputId !== state.declaration.requiredArtifacts[index].outputId,
		)
	)
		throw new Error("Child required-output obligation is not bound to its declaration.");
	const expectedStatus: ChildOutputObligationStatus =
		state.status === "completed"
			? "discharged"
			: state.status === "cancelled"
				? "cancelled"
				: state.status === "terminal_failed"
					? "terminal_failed"
					: state.status === "scope_changed"
						? "scope_changed"
						: "undischarged";
	if (obligation.status !== expectedStatus)
		throw new Error("Child required-output obligation status was cleared or advanced without authority.");
	if (obligation.status === "undischarged") {
		if (obligation.terminalEventId !== null || obligation.terminalReason !== null)
			throw new Error("Undischarged child required-output obligation has terminal metadata.");
	} else {
		if (obligation.terminalEventId === null || obligation.terminalReason === null)
			throw new Error("Terminal child required-output obligation lacks durable terminal metadata.");
	}
}

function assertSealIntegrity(state: ChildAttemptState): void {
	const seal = state.artifactSeal;
	const fence = state.producerFence;
	if (seal === null) {
		if (fence !== null || state.terminalPacketDigest !== null)
			throw new Error("Child terminal packet or producer fence exists without an immutable artifact seal.");
		return;
	}
	if (
		seal.producerAttemptId !== state.attemptId ||
		seal.producerExecutionId.length === 0 ||
		!sameEpoch(seal.epochRef, state.epochRef) ||
		digestObject(seal.head) !== digestObject(state.head) ||
		seal.outputObligationId !== state.outputObligation.obligationId ||
		seal.packetDigest.length === 0 ||
		seal.receipt.receiptId !== seal.receiptId ||
		seal.receipt.workflowId !== state.workflowId ||
		seal.receiptId.length === 0 ||
		seal.consumptionWitness.receiptId !== seal.receiptId ||
		seal.consumptionWitness.workflowId !== state.workflowId ||
		seal.consumptionWitness.capability !== "child_output_delivery_ack" ||
		seal.consumptionWitness.receiptDigest !== seal.receiptDigest ||
		seal.consumptionWitness.resourceDigest === null ||
		seal.consumptionWitness.operationDigest === null ||
		digestObject(seal.receipt) !== seal.receiptDigest ||
		seal.hostStateDigest.length === 0 ||
		seal.hostRevision < 0 ||
		seal.receiptDigest.length === 0 ||
		seal.authorizationDigest.length === 0 ||
		seal.sealDigest !== sealDigestForSeal(seal)
	)
		throw new Error("Child artifact seal is not bound to the attempt, head, epoch, or obligation.");
	if (seal.status === "stable") {
		if (seal.invalidationEventId !== null || seal.invalidationDigest !== null || seal.invalidationReason !== null)
			throw new Error("Stable child artifact seal carries invalidation metadata.");
	} else if (
		seal.invalidationEventId === null ||
		seal.invalidationDigest === null ||
		seal.invalidationReason === null ||
		state.appliedEventDigests[seal.invalidationEventId] === undefined
	) {
		throw new Error("Invalidated child artifact seal lacks a durable drift event.");
	}
	if (seal.artifacts.length !== state.declaration.requiredArtifacts.length)
		throw new Error("Child artifact seal omitted a required immutable artifact.");
	for (const sealedArtifact of seal.artifacts) {
		const required = state.declaration.requiredArtifacts.find(
			(candidate) => candidate.outputId === sealedArtifact.outputId,
		);
		if (
			!required ||
			sealedArtifact.path !== required.path ||
			sealedArtifact.digest !== required.digest ||
			!sameArtifactRef(sealedArtifact.ref, required.ref) ||
			sealedArtifact.schema !== required.schema ||
			sealedArtifact.validator !== required.validator ||
			sealedArtifact.immutableGeneration.length === 0
		)
			throw new Error("Child artifact seal is not bound to the immutable required artifacts.");
	}
	if (fence === null) throw new Error("Child artifact seal lacks its producer write fence.");
	if (
		fence.producerAttemptId !== seal.producerAttemptId ||
		fence.producerExecutionId !== seal.producerExecutionId ||
		fence.sealId !== seal.sealId ||
		fence.sealDigest !== seal.sealDigest ||
		fence.outputObligationId !== seal.outputObligationId ||
		!sameEpoch(fence.epochRef, seal.epochRef) ||
		digestObject(fence.head) !== digestObject(seal.head) ||
		fence.hostAuthorityDigest.length === 0 ||
		fence.hostAuthorityDigest !== seal.authorizationDigest ||
		fence.revocationIntent.attemptId !== fence.producerAttemptId ||
		fence.revocationIntent.producerExecutionId !== fence.producerExecutionId ||
		fence.revocationIntent.sealDigest !== fence.sealDigest ||
		fence.revocationIntent.outputObligationId !== fence.outputObligationId ||
		!sameEpoch(fence.revocationIntent.epochRef, fence.epochRef) ||
		digestObject(fence.revocationIntent.head) !== digestObject(fence.head) ||
		fence.revocationIntent.intentDigest !==
			revocationIntentDigest({
				operation: "revoke_producer_write",
				attemptId: fence.revocationIntent.attemptId,
				producerExecutionId: fence.revocationIntent.producerExecutionId,
				sealDigest: fence.revocationIntent.sealDigest,
				outputObligationId: fence.revocationIntent.outputObligationId,
				epochRef: fence.revocationIntent.epochRef,
				head: fence.revocationIntent.head,
			}) ||
		fence.fenceId !== fenceIdForFence(fence) ||
		fence.writeAuthority !== "revoked"
	)
		throw new Error("Child producer fence is not bound to the immutable artifact seal.");
	if (state.terminalPacketDigest !== null) {
		if (state.finalAssistantResult === null || state.reportedArtifacts.length === 0)
			throw new Error("Child terminal packet digest exists without its final result and artifacts.");
		if (
			state.terminalPacketDigest !==
			terminalPacketDigest(state.finalAssistantResult, state.terminalToolResults, state.reportedArtifacts)
		)
			throw new Error("Child terminal packet digest does not match its canonical packet.");
		if (state.terminalPacketDigest !== seal.packetDigest)
			throw new Error("Child terminal packet is not the sealed packet.");
	} else if (state.finalAssistantResult !== null || state.reportedArtifacts.length !== 0) {
		throw new Error("Child final result exists before its sealed terminal packet.");
	}
	const requiresStableSeal = ["validating", "delivered_pending_ack", "completed"].includes(state.status);
	if (requiresStableSeal && seal.status !== "stable")
		throw new Error("Child completion cannot advance past an invalidated artifact seal.");
	if (state.status === "quarantined" && seal.status !== "invalidated")
		throw new Error("Quarantined child attempt lacks an invalidated artifact seal.");
}

function assertCommitIntentIntegrity(
	state: ChildAttemptState,
	hostTuple: ChildOutputHostTuple,
	allowHeadAdvance = false,
): void {
	const intent = state.durableCommitIntent;
	if (intent === null) {
		if ((state.status !== "running" && state.status !== "retryable_incomplete") || state.artifactSeal !== null)
			throw new Error("Child output transition lacks its durable CAS/journal commit intent.");
		return;
	}
	const { intentDigest: _intentDigest, ...intentInput } = intent;
	if (
		intent.workflowId !== state.workflowId ||
		intent.taskId !== state.taskId ||
		intent.childId !== state.childId ||
		intent.runId !== state.runId ||
		intent.attemptId !== state.attemptId ||
		intent.outputObligationId !== state.outputObligation.obligationId ||
		!sameEpoch(intent.epochRef, state.epochRef) ||
		digestObject(intent.head) !== digestObject(state.head) ||
		(!allowHeadAdvance && intent.hostStateDigest !== hostTuple.stateDigest) ||
		(!allowHeadAdvance && intent.hostRevision !== hostTuple.revision) ||
		(allowHeadAdvance && intent.hostRevision > hostTuple.revision) ||
		state.appliedEventDigests[intent.eventId] !== intent.eventDigest ||
		intent.intentDigest !== commitIntentDigest(intentInput as ChildOutputCommitIntentInput)
	)
		throw new Error("Child output CAS/journal commit intent is stale or not bound to the authenticated transition.");
	if (intent.operation === "artifact_seal") {
		if (
			state.artifactSeal === null ||
			state.producerFence === null ||
			intent.sealDigest !== state.artifactSeal.sealDigest
		)
			throw new Error("Child artifact seal lacks its durable revocation commit intent.");
	} else if (intent.operation === "terminal_send") {
		if (state.terminalPacketDigest === null || intent.packetDigest !== state.terminalPacketDigest)
			throw new Error("Child terminal send lacks its durable CAS/journal commit intent.");
	} else if (intent.operation === "parent_delivery_ack") {
		if (state.status !== "completed" || intent.deliveryId !== state.deliveryId)
			throw new Error("Child parent acknowledgement lacks its durable CAS/journal commit intent.");
	} else if (intent.operation === "artifact_drift") {
		if (state.status !== "quarantined" || state.artifactSeal?.status !== "invalidated")
			throw new Error("Child artifact drift lacks its durable quarantine commit intent.");
	} else if (intent.operation === "compaction") {
		if (state.compactionCount === 0 || state.lastCompactionEvidenceDigest === null)
			throw new Error("Child compaction lacks its durable evidence commit intent.");
	} else if (intent.operation === "terminal_gate") {
		if (!["cancelled", "terminal_failed", "scope_changed"].includes(state.status))
			throw new Error("Child terminal gate lacks its durable authority commit intent.");
	}
}

function assertCoordinatorIntegrity(state: ChildAttemptState): void {
	const coordinator = state.coordinator;
	const expectedDeadlineStatus: ChildOutputDeadlineStatus =
		state.status === "completed"
			? "discharged"
			: state.status === "cancelled"
				? "cancelled"
				: state.status === "terminal_failed"
					? "terminal_failed"
					: state.status === "scope_changed"
						? "scope_changed"
						: "pending";
	if (coordinator.deadline.status !== expectedDeadlineStatus)
		throw new Error("Child coordinator deadline transition is not bound to the obligation.");
	if (expectedDeadlineStatus === "pending") {
		if (coordinator.deadline.transitionEventId !== null || coordinator.deadline.transitionReason !== null)
			throw new Error("Pending child output extended its deadline without a terminal transition.");
	} else if (
		coordinator.deadline.transitionEventId !== state.outputObligation.terminalEventId ||
		coordinator.deadline.transitionReason !== state.outputObligation.terminalReason
	) {
		throw new Error("Child coordinator deadline transition is not durably bound to terminal output.");
	}
	if (state.compactionCount === 0) {
		if (coordinator.meaningfulProgressDigest !== null)
			throw new Error("Child coordinator reports progress before durable compaction evidence.");
	} else if (
		coordinator.meaningfulProgressDigest !==
		coordinatorProgressDigest(state.lastCompactionEvidenceDigest as string, state.head)
	) {
		throw new Error("Child coordinator meaningful progress is not bound to durable evidence and head.");
	}
	const terminalStatus = ["completed", "cancelled", "terminal_failed", "scope_changed"].includes(state.status);
	if (terminalStatus) {
		const terminal = coordinator.terminal;
		if (
			terminal === null ||
			terminal.status !== state.status ||
			terminal.eventId !== state.outputObligation.terminalEventId ||
			terminal.reason !== state.outputObligation.terminalReason ||
			state.outputObligation.terminalEventId === null ||
			state.appliedEventDigests[state.outputObligation.terminalEventId] === undefined
		)
			throw new Error("Child coordinator terminal transition is not durably bound to the obligation.");
	} else if (coordinator.terminal !== null) {
		throw new Error("Non-terminal child output has a terminal coordinator transition.");
	}
	if (coordinator.wake === null) {
		if (state.status === "retryable_incomplete" || state.status === "quarantined" || terminalStatus)
			throw new Error("Child output terminal/error state lacks a durable coordinator wake.");
		return;
	}
	if (
		coordinator.wake.wakeKey !== coordinatorWakeKey(state) ||
		coordinator.wake.createdByEventId.length === 0 ||
		state.appliedEventDigests[coordinator.wake.createdByEventId] === undefined ||
		(coordinator.wake.status === "pending" &&
			(coordinator.wake.claimId !== null ||
				coordinator.wake.processedEventId !== null ||
				coordinator.wake.failureReason !== null)) ||
		(coordinator.wake.status === "claimed" &&
			(coordinator.wake.claimId === null ||
				coordinator.wake.processedEventId !== null ||
				coordinator.wake.failureReason !== null)) ||
		(coordinator.wake.status === "processed" &&
			(coordinator.wake.claimId === null ||
				coordinator.wake.processedEventId === null ||
				coordinator.wake.failureReason !== null ||
				state.appliedEventDigests[coordinator.wake.processedEventId] === undefined)) ||
		(coordinator.wake.status === "failed" &&
			(coordinator.wake.claimId === null ||
				coordinator.wake.processedEventId !== null ||
				coordinator.wake.failureReason === null))
	)
		throw new Error("Child coordinator wake is not durably bound to its stable key and event.");
	if ((state.status === "retryable_incomplete" || state.status === "quarantined") && coordinator.wake.kind !== "error")
		throw new Error("Retryable incomplete child output lacks an error coordinator wake.");
}

function assertContinuationStateIntegrity(state: ChildAttemptState): void {
	if (
		!Number.isSafeInteger(state.compactionCount) ||
		state.compactionCount < 0 ||
		state.compactionCount > state.declaration.maxCompactions
	)
		throw new Error("Child compaction count is outside the bounded declaration.");
	if (
		!Number.isSafeInteger(state.compactionNoProgressCount) ||
		state.compactionNoProgressCount < 0 ||
		state.compactionNoProgressCount > state.compactionCount
	)
		throw new Error("Child compaction progress count is invalid.");
	if (state.compactionCount === 0) {
		if (state.lastCompactionEvidenceDigest !== null || state.lastCompactionHeadDigest !== null)
			throw new Error("Child compaction evidence is present before a compaction.");
	} else if (state.lastCompactionEvidenceDigest === null || state.lastCompactionHeadDigest === null) {
		throw new Error("Child compaction evidence is missing from its durable state.");
	}
	if (state.diagnostic !== null && state.diagnostic !== STALLED_OUTPUT_OBLIGATION_DIAGNOSTIC)
		throw new Error("Child continuation diagnostic is unknown.");
	if (state.continuationEscalation !== null) {
		if (state.continuationEscalation.eventId.length === 0 || state.continuationEscalation.diagnostic.length === 0)
			throw new Error("Child continuation escalation is incomplete.");
		if (state.continuationEscalation.reason !== state.diagnostic)
			throw new Error("Child continuation escalation is not bound to its diagnostic.");
	}
	const wake = state.continuationWake;
	if (wake === null) {
		if (state.compactionCount > 0 && state.outputObligation.status === "undischarged")
			throw new Error("Undischarged child output obligation lost its durable compaction wake.");
		return;
	}
	if (
		wake.wakeId.length === 0 ||
		wake.childId !== state.childId ||
		wake.attemptId !== state.attemptId ||
		wake.safeBoundary !== "after_compaction_queue_empty" ||
		wake.compactionCount < 1 ||
		wake.compactionCount > state.compactionCount ||
		wake.evidenceDigest.length === 0 ||
		wake.evidenceDigest !== state.lastCompactionEvidenceDigest ||
		wake.headDigest !== digestObject(state.head) ||
		wake.witnessDigest.length === 0 ||
		wake.createdByEventId.length === 0 ||
		state.appliedEventDigests[wake.createdByEventId] === undefined ||
		wake.status !== "pending"
	)
		throw new Error("Child continuation wake is not durably bound to its compaction event.");
	if (state.outputObligation.status !== "undischarged")
		throw new Error("Terminal child required-output obligation retains an automatic wake.");
}

function assertStateIntegrity(
	state: ChildAttemptState,
	hostTuple: ChildOutputHostTuple,
	allowHeadAdvance = false,
): void {
	if (!state || typeof state !== "object") throw new Error("Child attempt state is required.");
	if (state.stateDigest !== recomputeChildAttemptStateDigest(state))
		throw new Error("Child attempt state digest does not match its durable projection.");
	const declaration = parseChildTaskDeclarationShape(state.declaration);
	if (
		state.bindingDigest !== contractDigest(declaration) ||
		state.declaration.attemptId !== state.attemptId ||
		state.declaration.workflowId !== state.workflowId ||
		state.declaration.taskId !== state.taskId ||
		state.declaration.childId !== state.childId ||
		state.declaration.runId !== state.runId ||
		state.declaration.maxAttempts !== state.maxAttempts ||
		state.attemptNumber > state.maxAttempts ||
		!sameEpoch(state.declaration.epochRef, state.epochRef) ||
		!sameEpoch(state.head.epochRef, state.epochRef) ||
		state.declaration.head.sequence > state.head.sequence ||
		(state.declaration.head.sequence === state.head.sequence &&
			digestObject(state.declaration.head) !== digestObject(state.head)) ||
		state.workflowId !== hostTuple.workflowId ||
		!sameEpoch(state.epochRef, hostTuple.epochRef) ||
		(!allowHeadAdvance && digestObject(state.head) !== digestObject(hostTuple.head)) ||
		(allowHeadAdvance &&
			(state.head.sequence > hostTuple.head.sequence ||
				(state.head.sequence === hostTuple.head.sequence &&
					digestObject(state.head) !== digestObject(hostTuple.head))))
	)
		throw new Error("Child attempt state is not bound to its declaration.");
	assertLineageIntegrity(state);
	assertOutputObligationIntegrity(state);
	assertSealIntegrity(state);
	assertCommitIntentIntegrity(state, hostTuple, allowHeadAdvance);
	assertCoordinatorIntegrity(state);
	assertContinuationStateIntegrity(state);
	assertStateSemantics(state);
}

function assertStateSemantics(state: ChildAttemptState): void {
	const acknowledgementFields = [
		state.acknowledgementReceipt,
		state.acknowledgementReceiptId,
		state.acknowledgementReceiptDigest,
		state.acknowledgementConsumptionWitness,
		state.acknowledgementAuthorizationDigest,
	];
	const hasAcknowledgement = acknowledgementFields.some((field) => field !== null);
	if (hasAcknowledgement && acknowledgementFields.some((field) => field === null))
		throw new Error("Child parent acknowledgement fields must be complete or absent.");
	if (
		hasAcknowledgement &&
		(state.acknowledgementReceipt?.receiptId !== state.acknowledgementReceiptId ||
			state.acknowledgementReceipt?.workflowId !== state.workflowId ||
			digestObject(state.acknowledgementReceipt as ChildOutputReceipt) !== state.acknowledgementReceiptDigest ||
			state.acknowledgementConsumptionWitness?.receiptId !== state.acknowledgementReceiptId ||
			state.acknowledgementConsumptionWitness?.workflowId !== state.workflowId ||
			state.acknowledgementConsumptionWitness?.capability !== "child_output_delivery_ack" ||
			state.acknowledgementConsumptionWitness?.receiptDigest !== state.acknowledgementReceiptDigest)
	)
		throw new Error("Child parent acknowledgement witness is not bound to its receipt and workflow.");
	if (state.status === "running") {
		if (
			state.finalAssistantResult !== null ||
			state.reportedArtifacts.length !== 0 ||
			state.validatedOutputs.length !== 0 ||
			state.deliveryId !== null ||
			hasAcknowledgement ||
			state.reason !== null ||
			state.terminalToolResults.length !== 0 ||
			state.quarantineReason !== null
		)
			throw new Error("Running child attempt has terminal output.");
		return;
	}
	if (state.status === "retryable_incomplete") {
		if (
			state.reason !== MISSING_FINAL_ASSISTANT_RESULT_REASON ||
			state.finalAssistantResult !== null ||
			state.reportedArtifacts.length !== 0 ||
			state.validatedOutputs.length !== 0 ||
			state.deliveryId !== null ||
			hasAcknowledgement ||
			state.artifactSeal !== null ||
			state.producerFence !== null ||
			state.terminalToolResults.length !== 0
		)
			throw new Error("Retryable incomplete child attempt has the wrong reason or result.");
		return;
	}
	if (state.status === "cancelled" || state.status === "terminal_failed" || state.status === "scope_changed") {
		if (state.deliveryId !== null || hasAcknowledgement)
			throw new Error("Terminal child failure state has a parent acknowledgement.");
		return;
	}
	if (state.status === "quarantined") {
		if (state.deliveryId !== null || hasAcknowledgement || state.quarantineReason === null)
			throw new Error("Quarantined child output retains an invalid parent delivery or lacks a reason.");
		return;
	}
	if (state.status === "validating" || state.status === "delivered_pending_ack" || state.status === "completed") {
		if (state.finalAssistantResult === null || state.reportedArtifacts.length === 0)
			throw new Error("Child attempt advanced without a final result and required outputs.");
		assertFinalResultMatches(state.declaration, state.finalAssistantResult);
		assertReportedArtifactsMatch(state.declaration, state.reportedArtifacts);
	}
	if (
		state.status === "validating" &&
		(state.validatedOutputs.length !== 0 || state.deliveryId !== null || hasAcknowledgement || state.reason !== null)
	)
		throw new Error("Validating child attempt has advanced delivery state.");
	if (state.status === "delivered_pending_ack") {
		if (state.deliveryId !== null || hasAcknowledgement || state.validatedOutputs.length === 0)
			throw new Error("Child attempt is pending delivery without the required validation state.");
		validateOutputIdentity(state.declaration, state.reportedArtifacts, state.validatedOutputs);
	}
	if (state.status === "completed") {
		if (state.deliveryId === null || !hasAcknowledgement)
			throw new Error("Child attempt completed without a verified durable parent acknowledgement.");
		validateOutputIdentity(state.declaration, state.reportedArtifacts, state.validatedOutputs);
	}
}

/**
 * Create an immutable running projection for one declared child attempt.
 *
 * Args:
 * declaration: Closed declaration bound to the host workflow head and epoch.
 * context: Authenticated host tuple, receipt consumer, resolver, and validator seam.
 * Return: Running attempt state with a deterministic state digest.
 */
export function createChildAttemptState(
	declaration: ChildTaskDeclaration,
	context: ChildOutputHostContext,
): ChildAttemptState {
	const parsed = parseChildTaskDeclaration(declaration, context);
	const bindingDigest = contractDigest(parsed);
	const lineage = makeLineageEntry({
		attemptId: parsed.attemptId,
		priorAttemptId: null,
		attemptNumber: 1,
		taskId: parsed.taskId,
		childId: parsed.childId,
		runId: parsed.runId,
		workflowId: parsed.workflowId,
		head: parsed.head,
		epochRef: parsed.epochRef,
		declarationDigest: bindingDigest,
		status: "running",
		terminalStateDigest: null,
		retryEventId: null,
	});
	return makeState({
		declaration: parsed,
		status: "running",
		taskId: parsed.taskId,
		childId: parsed.childId,
		runId: parsed.runId,
		workflowId: parsed.workflowId,
		attemptId: parsed.attemptId,
		priorAttemptId: null,
		attemptNumber: 1,
		maxAttempts: parsed.maxAttempts,
		head: parsed.head,
		epochRef: parsed.epochRef,
		bindingDigest,
		outputObligation: makeOutputObligation(parsed),
		provisionalProgressDigest: null,
		provisionalProducerExecutionId: null,
		artifactSeal: null,
		producerFence: null,
		terminalPacketDigest: null,
		terminalToolResults: [],
		quarantineReason: null,
		coordinator: initialCoordinatorProjection(),
		continuationWake: null,
		compactionCount: 0,
		compactionNoProgressCount: 0,
		lastCompactionEvidenceDigest: null,
		lastCompactionHeadDigest: null,
		diagnostic: null,
		continuationEscalation: null,
		finalAssistantResult: null,
		reportedArtifacts: [],
		validatedOutputs: [],
		deliveryId: null,
		acknowledgementReceipt: null,
		acknowledgementReceiptId: null,
		acknowledgementReceiptDigest: null,
		acknowledgementConsumptionWitness: null,
		acknowledgementAuthorizationDigest: null,
		reason: null,
		durableCommitIntent: null,
		appliedEventDigests: {},
		lastEventId: null,
		retryEventId: null,
		attemptLineage: [lineage],
	});
}

/**
 * Parse and verify a JSON-reopened child attempt projection.
 *
 * Args:
 * value: Durable state bytes decoded by a store or journal reader.
 * context: Current host binding used to fence stale or foreign projections.
 * Return: Immutable validated state projection.
 */
export function parseChildAttemptState(value: unknown, context: ChildOutputHostContext): ChildAttemptState {
	assertHostContext(context);
	const hostTuple = parseHostTuple(context.hostTuple, "Child output host tuple");
	assertRecord(value, "Child attempt state");
	assertExactKeys(value, STATE_KEYS, "Child attempt state");
	const declaration = parseChildTaskDeclarationShape(value.declaration);
	assertNonEmptyString(value.status, "Child attempt state.status");
	const status = parseAttemptStatus(value.status, "Child attempt state.status");
	assertNonEmptyString(value.taskId, "Child attempt state.taskId");
	assertNonEmptyString(value.childId, "Child attempt state.childId");
	assertNonEmptyString(value.runId, "Child attempt state.runId");
	assertNonEmptyString(value.workflowId, "Child attempt state.workflowId");
	assertNonEmptyString(value.attemptId, "Child attempt state.attemptId");
	assertSafeInteger(value.attemptNumber, "Child attempt state.attemptNumber", 1);
	assertSafeInteger(value.maxAttempts, "Child attempt state.maxAttempts", 1);
	assertSafeInteger(value.compactionCount, "Child attempt state.compactionCount", 0);
	assertSafeInteger(value.compactionNoProgressCount, "Child attempt state.compactionNoProgressCount", 0);
	const epochRef = parseEpoch(value.epochRef, "Child attempt state.epochRef");
	const head = parseHead(value.head, value.workflowId, epochRef, "Child attempt state.head");
	assertNonEmptyString(value.bindingDigest, "Child attempt state.bindingDigest");
	assertNonEmptyString(value.stateDigest, "Child attempt state.stateDigest");
	if (value.priorAttemptId !== null) assertNonEmptyString(value.priorAttemptId, "Child attempt state.priorAttemptId");
	if (value.deliveryId !== null) assertNonEmptyString(value.deliveryId, "Child attempt state.deliveryId");
	const acknowledgementReceipt =
		value.acknowledgementReceipt === null
			? null
			: parseHostReceipt(value.acknowledgementReceipt, "Child attempt state.acknowledgementReceipt");
	if (value.acknowledgementReceiptId !== null)
		assertNonEmptyString(value.acknowledgementReceiptId, "Child attempt state.acknowledgementReceiptId");
	if (value.acknowledgementReceiptDigest !== null)
		assertNonEmptyString(value.acknowledgementReceiptDigest, "Child attempt state.acknowledgementReceiptDigest");
	if (value.acknowledgementAuthorizationDigest !== null)
		assertNonEmptyString(
			value.acknowledgementAuthorizationDigest,
			"Child attempt state.acknowledgementAuthorizationDigest",
		);
	if (value.reason !== null) assertNonEmptyString(value.reason, "Child attempt state.reason");
	if (value.lastEventId !== null) assertNonEmptyString(value.lastEventId, "Child attempt state.lastEventId");
	if (value.retryEventId !== null) assertNonEmptyString(value.retryEventId, "Child attempt state.retryEventId");
	if (value.lastCompactionEvidenceDigest !== null)
		assertNonEmptyString(value.lastCompactionEvidenceDigest, "Child attempt state.lastCompactionEvidenceDigest");
	if (value.lastCompactionHeadDigest !== null)
		assertNonEmptyString(value.lastCompactionHeadDigest, "Child attempt state.lastCompactionHeadDigest");
	if (value.diagnostic !== null) assertNonEmptyString(value.diagnostic, "Child attempt state.diagnostic");
	if (value.provisionalProgressDigest !== null)
		assertNonEmptyString(value.provisionalProgressDigest, "Child attempt state.provisionalProgressDigest");
	if (value.provisionalProducerExecutionId !== null)
		assertNonEmptyString(value.provisionalProducerExecutionId, "Child attempt state.provisionalProducerExecutionId");
	if (value.terminalPacketDigest !== null)
		assertNonEmptyString(value.terminalPacketDigest, "Child attempt state.terminalPacketDigest");
	if (value.quarantineReason !== null)
		assertNonEmptyString(value.quarantineReason, "Child attempt state.quarantineReason");
	if (
		!Array.isArray(value.reportedArtifacts) ||
		!Array.isArray(value.validatedOutputs) ||
		!Array.isArray(value.terminalToolResults)
	)
		throw new Error("Child attempt state output collections are invalid.");
	if (!isRecord(value.appliedEventDigests)) throw new Error("Child attempt state event digest map is invalid.");
	for (const [eventId, digest] of Object.entries(value.appliedEventDigests)) {
		assertNonEmptyString(eventId, "Child attempt state event ID");
		assertNonEmptyString(digest, `Child attempt state event digest ${eventId}`);
	}
	if (!Array.isArray(value.attemptLineage)) throw new Error("Child attempt state lineage is invalid.");
	const reportedArtifacts = value.reportedArtifacts.map((artifact, index) =>
		parseArtifactOutput(artifact, `Reported artifact ${index}`),
	);
	const validatedOutputs = value.validatedOutputs.map((output, index) =>
		parseValidatedOutput(output, `Validated output ${index}`),
	);
	const attemptLineage = value.attemptLineage.map((entry, index) =>
		parseLineageEntry(entry, declaration.workflowId, `Attempt lineage ${index}`),
	);
	const outputObligation = parseObligation(value.outputObligation, "Child attempt state.outputObligation");
	const artifactSeal = parseArtifactSeal(value.artifactSeal, "Child attempt state.artifactSeal");
	const producerFence = parseProducerFence(value.producerFence, "Child attempt state.producerFence");
	const acknowledgementConsumptionWitness =
		value.acknowledgementConsumptionWitness === null
			? null
			: parseConsumptionWitness(
					value.acknowledgementConsumptionWitness,
					"Child attempt state.acknowledgementConsumptionWitness",
				);
	const durableCommitIntent = parseCommitIntent(value.durableCommitIntent, "Child attempt state.durableCommitIntent");
	const coordinator = parseCoordinatorProjection(value.coordinator, "Child attempt state.coordinator");
	const continuationWake = parseContinuationWake(value.continuationWake, "Child attempt state.continuationWake");
	const continuationEscalation = parseContinuationEscalation(
		value.continuationEscalation,
		"Child attempt state.continuationEscalation",
	);
	const candidate: ChildAttemptState = {
		declaration,
		status,
		taskId: value.taskId,
		childId: value.childId,
		runId: value.runId,
		workflowId: value.workflowId,
		attemptId: value.attemptId,
		priorAttemptId: value.priorAttemptId as string | null,
		attemptNumber: value.attemptNumber,
		maxAttempts: value.maxAttempts,
		head,
		epochRef,
		bindingDigest: value.bindingDigest,
		stateDigest: value.stateDigest,
		outputObligation,
		provisionalProgressDigest: value.provisionalProgressDigest as string | null,
		provisionalProducerExecutionId: value.provisionalProducerExecutionId as string | null,
		artifactSeal,
		producerFence,
		terminalPacketDigest: value.terminalPacketDigest as string | null,
		terminalToolResults: value.terminalToolResults,
		quarantineReason: value.quarantineReason as string | null,
		coordinator,
		continuationWake,
		compactionCount: value.compactionCount,
		compactionNoProgressCount: value.compactionNoProgressCount,
		lastCompactionEvidenceDigest: value.lastCompactionEvidenceDigest as string | null,
		lastCompactionHeadDigest: value.lastCompactionHeadDigest as string | null,
		diagnostic: value.diagnostic as string | null,
		continuationEscalation,
		finalAssistantResult: parseFinalAssistantResult(value.finalAssistantResult),
		reportedArtifacts,
		validatedOutputs,
		deliveryId: value.deliveryId as string | null,
		acknowledgementReceipt,
		acknowledgementReceiptId: value.acknowledgementReceiptId as string | null,
		acknowledgementReceiptDigest: value.acknowledgementReceiptDigest as string | null,
		acknowledgementConsumptionWitness,
		acknowledgementAuthorizationDigest: value.acknowledgementAuthorizationDigest as string | null,
		reason: value.reason as string | null,
		durableCommitIntent,
		appliedEventDigests: { ...value.appliedEventDigests } as Record<string, string>,
		lastEventId: value.lastEventId as string | null,
		retryEventId: value.retryEventId as string | null,
		attemptLineage,
	};
	if (candidate.stateDigest !== recomputeChildAttemptStateDigest(candidate))
		throw new Error("Child attempt state digest does not match its durable projection.");
	assertStateIntegrity(candidate, hostTuple);
	assertStateSemantics(candidate);
	return cloneAndFreeze(candidate);
}

function parseLineageEntry(value: unknown, workflowId: string, label: string): ChildAttemptLineage {
	assertRecord(value, label);
	assertExactKeys(value, LINEAGE_KEYS, label);
	assertNonEmptyString(value.attemptId, `${label}.attemptId`);
	assertSafeInteger(value.attemptNumber, `${label}.attemptNumber`, 1);
	assertNonEmptyString(value.taskId, `${label}.taskId`);
	assertNonEmptyString(value.childId, `${label}.childId`);
	assertNonEmptyString(value.runId, `${label}.runId`);
	assertNonEmptyString(value.workflowId, `${label}.workflowId`);
	if (value.workflowId !== workflowId) throw new Error(`${label} is bound to another workflow.`);
	assertNonEmptyString(value.declarationDigest, `${label}.declarationDigest`);
	const epochRef = parseEpoch(value.epochRef, `${label}.epochRef`);
	const head = parseHead(value.head, workflowId, epochRef, `${label}.head`);
	const status = parseAttemptStatus(value.status, `${label}.status`);
	if (value.priorAttemptId !== null) assertNonEmptyString(value.priorAttemptId, `${label}.priorAttemptId`);
	if (value.terminalStateDigest !== null)
		assertNonEmptyString(value.terminalStateDigest, `${label}.terminalStateDigest`);
	if (value.retryEventId !== null) assertNonEmptyString(value.retryEventId, `${label}.retryEventId`);
	assertNonEmptyString(value.lineageDigest, `${label}.lineageDigest`);
	return {
		attemptId: value.attemptId,
		priorAttemptId: value.priorAttemptId as string | null,
		attemptNumber: value.attemptNumber,
		taskId: value.taskId,
		childId: value.childId,
		runId: value.runId,
		workflowId,
		head,
		epochRef,
		declarationDigest: value.declarationDigest,
		status,
		terminalStateDigest: value.terminalStateDigest as string | null,
		retryEventId: value.retryEventId as string | null,
		lineageDigest: value.lineageDigest,
	};
}

function parseObligation(value: unknown, label: string): ChildOutputObligation {
	assertRecord(value, label);
	assertExactKeys(value, OBLIGATION_KEYS, label);
	assertNonEmptyString(value.obligationId, `${label}.obligationId`);
	assertNonEmptyString(value.declarationDigest, `${label}.declarationDigest`);
	assertNonEmptyString(value.taskId, `${label}.taskId`);
	assertNonEmptyString(value.childId, `${label}.childId`);
	assertNonEmptyString(value.runId, `${label}.runId`);
	assertNonEmptyString(value.attemptId, `${label}.attemptId`);
	if (
		!["undischarged", "discharged", "cancelled", "terminal_failed", "scope_changed"].includes(value.status as string)
	)
		throw new Error(`${label}.status is invalid.`);
	if (!Array.isArray(value.requiredArtifactOutputIds) || value.requiredArtifactOutputIds.length === 0)
		throw new Error(`${label}.requiredArtifactOutputIds must be finite and non-empty.`);
	const requiredArtifactOutputIds = value.requiredArtifactOutputIds.map((outputId, index) => {
		assertNonEmptyString(outputId, `${label}.requiredArtifactOutputIds[${index}]`);
		return outputId;
	});
	if (new Set(requiredArtifactOutputIds).size !== requiredArtifactOutputIds.length)
		throw new Error(`${label}.requiredArtifactOutputIds must be unique.`);
	const requiredFinalResult = parseFinalRequirement(value.requiredFinalResult);
	if (value.terminalEventId !== null) assertNonEmptyString(value.terminalEventId, `${label}.terminalEventId`);
	if (value.terminalReason !== null) assertNonEmptyString(value.terminalReason, `${label}.terminalReason`);
	return {
		obligationId: value.obligationId,
		declarationDigest: value.declarationDigest,
		taskId: value.taskId,
		childId: value.childId,
		runId: value.runId,
		attemptId: value.attemptId,
		requiredFinalResult,
		requiredArtifactOutputIds,
		status: value.status as ChildOutputObligationStatus,
		terminalEventId: value.terminalEventId as string | null,
		terminalReason: value.terminalReason as string | null,
	};
}

function parseArtifactSeal(value: unknown, label: string): ChildArtifactSeal | null {
	if (value === null) return null;
	assertRecord(value, label);
	assertExactKeys(value, SEAL_KEYS, label);
	assertNonEmptyString(value.sealId, `${label}.sealId`);
	assertNonEmptyString(value.producerAttemptId, `${label}.producerAttemptId`);
	assertNonEmptyString(value.producerExecutionId, `${label}.producerExecutionId`);
	const epochRef = parseEpoch(value.epochRef, `${label}.epochRef`);
	const head = parseHead(value.head, headWorkflowId(value.head, `${label}.head`), epochRef, `${label}.head`);
	assertNonEmptyString(value.outputObligationId, `${label}.outputObligationId`);
	assertNonEmptyString(value.packetDigest, `${label}.packetDigest`);
	const receipt = parseHostReceipt(value.receipt, `${label}.receipt`);
	assertNonEmptyString(value.receiptId, `${label}.receiptId`);
	const consumptionWitness = parseConsumptionWitness(value.consumptionWitness, `${label}.consumptionWitness`);
	assertNonEmptyString(value.hostStateDigest, `${label}.hostStateDigest`);
	assertSafeInteger(value.hostRevision, `${label}.hostRevision`, 0);
	assertNonEmptyString(value.receiptDigest, `${label}.receiptDigest`);
	assertNonEmptyString(value.authorizationDigest, `${label}.authorizationDigest`);
	assertNonEmptyString(value.sealDigest, `${label}.sealDigest`);
	if (!Array.isArray(value.artifacts) || value.artifacts.length === 0)
		throw new Error(`${label}.artifacts must be finite and non-empty.`);
	const artifacts = value.artifacts.map((artifact, index) =>
		parseSealedArtifact(artifact, `${label}.artifacts[${index}]`),
	);
	if (new Set(artifacts.map((artifact) => artifact.outputId)).size !== artifacts.length)
		throw new Error(`${label}.artifacts must have unique output IDs.`);
	if (value.status !== "stable" && value.status !== "invalidated") throw new Error(`${label}.status is invalid.`);
	if (value.invalidationEventId !== null)
		assertNonEmptyString(value.invalidationEventId, `${label}.invalidationEventId`);
	if (value.invalidationDigest !== null) assertNonEmptyString(value.invalidationDigest, `${label}.invalidationDigest`);
	if (value.invalidationReason !== null) assertNonEmptyString(value.invalidationReason, `${label}.invalidationReason`);
	return {
		sealId: value.sealId,
		producerAttemptId: value.producerAttemptId,
		producerExecutionId: value.producerExecutionId,
		epochRef,
		head,
		outputObligationId: value.outputObligationId,
		packetDigest: value.packetDigest,
		artifacts,
		receipt,
		receiptId: value.receiptId,
		consumptionWitness,
		hostStateDigest: value.hostStateDigest,
		hostRevision: value.hostRevision,
		receiptDigest: value.receiptDigest,
		authorizationDigest: value.authorizationDigest,
		sealDigest: value.sealDigest,
		status: value.status,
		invalidationEventId: value.invalidationEventId as string | null,
		invalidationDigest: value.invalidationDigest as string | null,
		invalidationReason: value.invalidationReason as string | null,
	};
}

function headWorkflowId(value: unknown, label: string): string {
	assertRecord(value, label);
	assertNonEmptyString(value.workflowId, `${label}.workflowId`);
	return value.workflowId;
}

function parseProducerFence(value: unknown, label: string): ChildProducerFence | null {
	if (value === null) return null;
	assertRecord(value, label);
	assertExactKeys(value, FENCE_KEYS, label);
	assertNonEmptyString(value.fenceId, `${label}.fenceId`);
	assertNonEmptyString(value.producerAttemptId, `${label}.producerAttemptId`);
	assertNonEmptyString(value.producerExecutionId, `${label}.producerExecutionId`);
	assertNonEmptyString(value.sealId, `${label}.sealId`);
	assertNonEmptyString(value.sealDigest, `${label}.sealDigest`);
	assertNonEmptyString(value.outputObligationId, `${label}.outputObligationId`);
	assertNonEmptyString(value.hostAuthorityDigest, `${label}.hostAuthorityDigest`);
	const epochRef = parseEpoch(value.epochRef, `${label}.epochRef`);
	const head = parseHead(value.head, headWorkflowId(value.head, `${label}.head`), epochRef, `${label}.head`);
	const revocationIntent = parseRevocationIntent(value.revocationIntent, `${label}.revocationIntent`);
	if (value.writeAuthority !== "revoked") throw new Error(`${label}.writeAuthority is not revoked.`);
	return {
		fenceId: value.fenceId,
		producerAttemptId: value.producerAttemptId,
		producerExecutionId: value.producerExecutionId,
		sealId: value.sealId,
		sealDigest: value.sealDigest,
		outputObligationId: value.outputObligationId,
		epochRef,
		head,
		hostAuthorityDigest: value.hostAuthorityDigest,
		revocationIntent,
		writeAuthority: "revoked",
	};
}

function parseCoordinatorDeadline(value: unknown, label: string): ChildOutputDeadlineTransition {
	assertRecord(value, label);
	assertExactKeys(value, DEADLINE_KEYS, label);
	if (!["pending", "discharged", "cancelled", "terminal_failed", "scope_changed"].includes(value.status as string))
		throw new Error(`${label}.status is invalid.`);
	if (value.transitionEventId !== null) assertNonEmptyString(value.transitionEventId, `${label}.transitionEventId`);
	if (value.transitionReason !== null) assertNonEmptyString(value.transitionReason, `${label}.transitionReason`);
	return {
		status: value.status as ChildOutputDeadlineStatus,
		transitionEventId: value.transitionEventId as string | null,
		transitionReason: value.transitionReason as string | null,
	};
}

function parseCoordinatorWake(value: unknown, label: string): ChildCoordinatorWake | null {
	if (value === null) return null;
	assertRecord(value, label);
	assertExactKeys(value, COORDINATOR_WAKE_KEYS, label);
	assertNonEmptyString(value.wakeKey, `${label}.wakeKey`);
	assertNonEmptyString(value.createdByEventId, `${label}.createdByEventId`);
	if (!["final_output", "error", "gating"].includes(value.kind as string))
		throw new Error(`${label}.kind is invalid.`);
	if (!["pending", "claimed", "processed", "failed"].includes(value.status as string))
		throw new Error(`${label}.status is invalid.`);
	if (value.claimId !== null) assertNonEmptyString(value.claimId, `${label}.claimId`);
	if (value.processedEventId !== null) assertNonEmptyString(value.processedEventId, `${label}.processedEventId`);
	if (value.failureReason !== null) assertNonEmptyString(value.failureReason, `${label}.failureReason`);
	return {
		wakeKey: value.wakeKey,
		kind: value.kind as ChildCoordinatorWakeKind,
		createdByEventId: value.createdByEventId,
		status: value.status as ChildCoordinatorWakeStatus,
		claimId: value.claimId as string | null,
		processedEventId: value.processedEventId as string | null,
		failureReason: value.failureReason as string | null,
	};
}

function parseCoordinatorTerminal(value: unknown, label: string): ChildCoordinatorTerminalTransition | null {
	if (value === null) return null;
	assertRecord(value, label);
	assertExactKeys(value, COORDINATOR_TERMINAL_KEYS, label);
	assertNonEmptyString(value.eventId, `${label}.eventId`);
	assertNonEmptyString(value.reason, `${label}.reason`);
	if (!["completed", "cancelled", "terminal_failed", "scope_changed"].includes(value.status as string))
		throw new Error(`${label}.status is invalid.`);
	return {
		status: value.status as ChildCoordinatorTerminalTransition["status"],
		eventId: value.eventId,
		reason: value.reason,
	};
}

function parseCoordinatorProjection(value: unknown, label: string): ChildCoordinatorProjection {
	assertRecord(value, label);
	assertExactKeys(value, COORDINATOR_KEYS, label);
	if (value.meaningfulProgressDigest !== null)
		assertNonEmptyString(value.meaningfulProgressDigest, `${label}.meaningfulProgressDigest`);
	return {
		meaningfulProgressDigest: value.meaningfulProgressDigest as string | null,
		deadline: parseCoordinatorDeadline(value.deadline, `${label}.deadline`),
		terminal: parseCoordinatorTerminal(value.terminal, `${label}.terminal`),
		wake: parseCoordinatorWake(value.wake, `${label}.wake`),
	};
}

function parseContinuationWake(value: unknown, label: string): ChildContinuationWake | null {
	if (value === null) return null;
	assertRecord(value, label);
	assertExactKeys(value, WAKE_KEYS, label);
	assertNonEmptyString(value.wakeId, `${label}.wakeId`);
	assertNonEmptyString(value.childId, `${label}.childId`);
	assertNonEmptyString(value.attemptId, `${label}.attemptId`);
	assertSafeInteger(value.compactionCount, `${label}.compactionCount`, 1);
	assertNonEmptyString(value.evidenceDigest, `${label}.evidenceDigest`);
	assertNonEmptyString(value.headDigest, `${label}.headDigest`);
	assertNonEmptyString(value.witnessDigest, `${label}.witnessDigest`);
	assertNonEmptyString(value.createdByEventId, `${label}.createdByEventId`);
	if (value.safeBoundary !== "after_compaction_queue_empty" || value.status !== "pending")
		throw new Error(`${label} is not a pending safe-boundary wake.`);
	return {
		wakeId: value.wakeId,
		childId: value.childId,
		attemptId: value.attemptId,
		safeBoundary: "after_compaction_queue_empty",
		compactionCount: value.compactionCount,
		evidenceDigest: value.evidenceDigest,
		headDigest: value.headDigest,
		witnessDigest: value.witnessDigest,
		createdByEventId: value.createdByEventId,
		status: "pending",
	};
}

function parseContinuationEscalation(value: unknown, label: string): ChildContinuationEscalation | null {
	if (value === null) return null;
	assertRecord(value, label);
	assertExactKeys(value, ESCALATION_KEYS, label);
	assertNonEmptyString(value.eventId, `${label}.eventId`);
	assertNonEmptyString(value.diagnostic, `${label}.diagnostic`);
	if (
		![STALLED_OUTPUT_OBLIGATION_DIAGNOSTIC, "continuation_failed", "authority_required"].includes(
			value.reason as string,
		)
	)
		throw new Error(`${label}.reason is invalid.`);
	return {
		reason: value.reason as ChildContinuationEscalationReason,
		eventId: value.eventId,
		diagnostic: value.diagnostic,
	};
}

function retryLineageDigest(state: ChildAttemptState, newAttemptId: string): string {
	return digestObject({
		workflowId: state.workflowId,
		taskId: state.taskId,
		childId: state.childId,
		runId: state.runId,
		priorAttemptId: state.attemptId,
		newAttemptId,
		priorAttemptNumber: state.attemptNumber,
		priorStateDigest: state.stateDigest,
		declarationDigest: state.bindingDigest,
		head: state.head,
		epochRef: state.epochRef,
	});
}

interface ChildAuthorizedReceipt {
	readonly receipt: ChildOutputReceipt;
	readonly receiptId: string;
	readonly receiptDigest: string;
	readonly authorizationDigest: string;
	readonly bindingDigest: string;
	readonly consumptionWitness: ChildOutputConsumptionWitness;
}

function assertConsumedWitnessBinding(
	witness: ChildOutputConsumptionWitness,
	receipt: ChildOutputReceipt,
	bindingDigest: string,
): void {
	if (
		witness.receiptId !== receipt.receiptId ||
		witness.workflowId !== receipt.workflowId ||
		witness.bindingDigest !== bindingDigest ||
		witness.capability !== "child_output_delivery_ack" ||
		witness.receiptDigest !== digestObject(receipt) ||
		witness.resourceDigest === null ||
		witness.operationDigest === null
	)
		throw new Error("Host receipt consumption witness is not bound to the authenticated one-use receipt.");
}

function receiptResourceDigest(state: ChildAttemptState): string {
	return digestObject({
		workflowId: state.workflowId,
		taskId: state.taskId,
		childId: state.childId,
		runId: state.runId,
		attemptId: state.attemptId,
		outputObligationId: state.outputObligation.obligationId,
	});
}

function receiptExecutionIdentity(event: ChildOutputEvent): string | undefined {
	if (event.kind === "artifact_seal_recorded" || event.kind === "seal_drift_detected")
		return event.producerExecutionId;
	return undefined;
}

async function authorizeAndConsumeReceipt(
	context: ChildOutputHostContext,
	hostTuple: ChildOutputHostTuple,
	state: ChildAttemptState,
	event: ChildOutputEvent,
	receipt: ChildOutputReceipt,
	operation: ChildOutputCommitOperation,
	details: unknown,
): Promise<ChildAuthorizedReceipt> {
	if (receipt.workflowId !== hostTuple.workflowId) throw new Error("Host receipt is bound to another workflow.");
	const resourceDigest = receiptResourceDigest(state);
	const bindingDigest = digestObject({
		operation,
		eventId: event.eventId,
		eventDigest: eventDigest(event),
		workflowId: hostTuple.workflowId,
		taskId: state.taskId,
		childId: state.childId,
		runId: state.runId,
		attemptId: state.attemptId,
		outputObligationId: state.outputObligation.obligationId,
		hostStateDigest: hostTuple.stateDigest,
		hostRevision: hostTuple.revision,
		epochRef: hostTuple.epochRef,
		head: hostTuple.head,
		details,
	});
	const operationDigest = digestObject({ operation, bindingDigest, resourceDigest, details });
	const receiptArtifact = await context.receiptContext.artifactResolver.resolve(receipt.artifactRef);
	if (receiptArtifact.exists !== true || !(receiptArtifact.bytes instanceof Uint8Array))
		throw new Error("Host receipt artifact is not durably readable.");
	const resolvedReceipt = await context.receiptContext.receiptResolver.resolve({
		receipt,
		workflowId: hostTuple.workflowId,
		expectedBindingDigest: bindingDigest,
		artifactBytes: receiptArtifact.bytes,
		currentStateDigest: hostTuple.stateDigest,
		currentRevision: hostTuple.revision,
		trustedNow: receipt.issuedAt,
		keyResolver: context.receiptContext.keyResolver,
		revokedReceiptIds: context.receiptContext.revokedReceiptIds,
	});
	if (digestObject(resolvedReceipt) !== digestObject(receipt))
		throw new Error("Host receipt resolver returned a conflicting authenticated receipt.");
	const authorization = await context.receiptContext.principalAuthorizer.authorize({
		receipt,
		workflowId: hostTuple.workflowId,
		bindingDigest,
		resourceDigest,
		operationDigest,
		stateDigest: hostTuple.stateDigest,
		revision: hostTuple.revision,
		epochRef: hostTuple.epochRef,
		capability: "child_output_delivery_ack",
		executionIdentity: receiptExecutionIdentity(event),
	});
	assertRecord(authorization, "Host principal authorization");
	if (
		authorization.capability !== "child_output_delivery_ack" ||
		authorization.workflowId !== hostTuple.workflowId ||
		authorization.bindingDigest !== bindingDigest ||
		authorization.stateDigest !== hostTuple.stateDigest ||
		authorization.revision !== hostTuple.revision ||
		!sameEpoch(authorization.epochRef, hostTuple.epochRef) ||
		authorization.receipt.receiptId !== receipt.receiptId ||
		digestObject(authorization.receipt) !== digestObject(receipt)
	)
		throw new Error("Host principal authorization is not bound to the live child output tuple.");
	assertNonEmptyString(authorization.authorizationDigest, "Host principal authorization digest");
	let consumptionWitness: ChildOutputConsumptionWitness;
	try {
		await context.receiptContext.receiptResolver.consumeIfOneUse({
			receipt,
			workflowId: hostTuple.workflowId,
			expectedBindingDigest: bindingDigest,
			currentRevision: hostTuple.revision,
		});
	} catch (error) {
		try {
			consumptionWitness = await context.receiptContext.receiptResolver.resolveConsumptionWitness({
				receiptId: receipt.receiptId,
				workflowId: hostTuple.workflowId,
				expectedBindingDigest: bindingDigest,
			});
		} catch {
			throw error;
		}
		const parsedWitness = parseConsumptionWitness(consumptionWitness, "Host receipt consumption witness");
		assertConsumedWitnessBinding(parsedWitness, receipt, bindingDigest);
		return {
			receipt,
			receiptId: receipt.receiptId,
			receiptDigest: digestObject(authorization.receipt),
			authorizationDigest: authorization.authorizationDigest,
			bindingDigest,
			consumptionWitness: parsedWitness,
		};
	}
	consumptionWitness = await context.receiptContext.receiptResolver.resolveConsumptionWitness({
		receiptId: receipt.receiptId,
		workflowId: hostTuple.workflowId,
		expectedBindingDigest: bindingDigest,
	});
	const parsedWitness = parseConsumptionWitness(consumptionWitness, "Host receipt consumption witness");
	assertConsumedWitnessBinding(parsedWitness, receipt, bindingDigest);
	return {
		receipt,
		receiptId: receipt.receiptId,
		receiptDigest: digestObject(authorization.receipt),
		authorizationDigest: authorization.authorizationDigest,
		bindingDigest,
		consumptionWitness: parsedWitness,
	};
}

async function prepareCommitIntent(
	context: ChildOutputHostContext,
	input: ChildOutputCommitIntentInput,
): Promise<ChildOutputCommitIntent> {
	const intent = await context.prepareCommitIntent(input);
	const parsed = parseCommitIntent(intent, "Child output atomic commit intent");
	if (parsed === null || parsed.intentDigest !== commitIntentDigest(input))
		throw new Error("Child output atomic commit intent is not recomputable.");
	return cloneAndFreeze(parsed);
}

async function verifyPersistedReceiptAuthority(
	context: ChildOutputHostContext,
	hostTuple: ChildOutputHostTuple,
	receipt: ChildOutputReceipt,
	witness: ChildOutputConsumptionWitness,
	receiptDigest: string,
	authorizationDigest: string,
	hostStateDigest: string,
	hostRevision: number,
	executionIdentity: string | undefined,
): Promise<void> {
	if (hostStateDigest !== hostTuple.stateDigest || hostRevision !== hostTuple.revision)
		throw new Error("Persisted child output authority is fenced by a stale host tuple.");
	const receiptArtifact = await context.receiptContext.artifactResolver.resolve(receipt.artifactRef);
	if (receiptArtifact.exists !== true || !(receiptArtifact.bytes instanceof Uint8Array))
		throw new Error("Persisted child receipt artifact is not durably readable.");
	const resolvedReceipt = await context.receiptContext.receiptResolver.resolve({
		receipt,
		workflowId: hostTuple.workflowId,
		expectedBindingDigest: witness.bindingDigest,
		artifactBytes: receiptArtifact.bytes,
		currentStateDigest: hostStateDigest,
		currentRevision: hostRevision,
		trustedNow: receipt.issuedAt,
		keyResolver: context.receiptContext.keyResolver,
		revokedReceiptIds: context.receiptContext.revokedReceiptIds,
	});
	if (digestObject(resolvedReceipt) !== digestObject(receipt))
		throw new Error("Persisted child receipt resolver returned a conflicting receipt.");
	const resolvedWitness = await context.receiptContext.receiptResolver.resolveConsumptionWitness({
		receiptId: receipt.receiptId,
		workflowId: hostTuple.workflowId,
		expectedBindingDigest: witness.bindingDigest,
	});
	const parsedWitness = parseConsumptionWitness(resolvedWitness, "Persisted child receipt witness");
	assertConsumedWitnessBinding(parsedWitness, receipt, witness.bindingDigest);
	if (digestObject(parsedWitness) !== digestObject(witness))
		throw new Error("Persisted child receipt witness conflicts with the authenticated state.");
	if (witness.resourceDigest === null || witness.operationDigest === null)
		throw new Error("Persisted child receipt witness lacks capability operation identity.");
	const authorization = await context.receiptContext.principalAuthorizer.authorize({
		receipt,
		workflowId: hostTuple.workflowId,
		bindingDigest: witness.bindingDigest,
		resourceDigest: witness.resourceDigest,
		operationDigest: witness.operationDigest,
		stateDigest: hostStateDigest,
		revision: hostRevision,
		epochRef: hostTuple.epochRef,
		capability: "child_output_delivery_ack",
		executionIdentity,
	});
	if (
		authorization.capability !== "child_output_delivery_ack" ||
		authorization.workflowId !== hostTuple.workflowId ||
		authorization.bindingDigest !== witness.bindingDigest ||
		authorization.receipt.receiptId !== receipt.receiptId ||
		digestObject(authorization.receipt) !== digestObject(receipt) ||
		authorization.stateDigest !== hostStateDigest ||
		authorization.revision !== hostRevision ||
		!sameEpoch(authorization.epochRef, hostTuple.epochRef) ||
		authorization.authorizationDigest !== authorizationDigest
	)
		throw new Error("Persisted child receipt authorization is not authenticated.");
	if (digestObject(receipt) !== receiptDigest) throw new Error("Persisted child receipt digest is not authenticated.");
}

async function resolveSealedArtifacts(
	context: ChildOutputHostContext,
	declaration: ChildTaskDeclaration,
	artifacts: readonly ChildArtifactOutput[],
): Promise<readonly ChildSealedArtifact[]> {
	const resolvedArtifacts: ChildSealedArtifact[] = [];
	for (const artifact of artifacts) {
		const required = declaration.requiredArtifacts.find((candidate) => candidate.outputId === artifact.outputId);
		if (!required) throw new Error("Child artifact seal references an unknown required output.");
		const resolved = await parseResolvedArtifact(
			await context.receiptContext.artifactResolver.resolve(required.ref),
			required.ref,
		);
		await context.validateArtifactOutput({
			output: {
				outputId: artifact.outputId,
				path: artifact.path,
				ref: { ...artifact.ref },
				schema: artifact.schema,
				validator: artifact.validator,
				validated: true,
			},
			required,
			resolvedArtifact: resolved,
		});
		resolvedArtifacts.push({
			...artifact,
			immutableGeneration: resolved.envelope.immutableGeneration,
		});
	}
	return cloneAndFreeze(resolvedArtifacts);
}

async function reduceProvisionalProgressEvent(
	state: ChildAttemptState,
	event: Extract<ChildOutputEvent, { kind: "provisional_progress" }>,
): Promise<ChildAttemptState> {
	if (state.status !== "running")
		throw new Error("Provisional progress is only valid while a child attempt is running.");
	if (state.artifactSeal !== null || state.producerFence !== null)
		throw new Error("Producer writes are fenced after the artifact seal.");
	if (
		state.provisionalProducerExecutionId !== null &&
		state.provisionalProducerExecutionId !== event.producerExecutionId
	)
		throw new Error("Provisional progress changed producer execution without a new attempt.");
	return withEvent(state, event, {
		...omitStateDigest(state),
		provisionalProgressDigest: event.progressDigest,
		provisionalProducerExecutionId: event.producerExecutionId,
	});
}

async function reduceArtifactSealEvent(
	state: ChildAttemptState,
	event: Extract<ChildOutputEvent, { kind: "artifact_seal_recorded" }>,
	context: ChildOutputHostContext,
	hostTuple: ChildOutputHostTuple,
): Promise<ChildAttemptState> {
	if (state.status !== "running") throw new Error("Artifact seal is only valid while a child attempt is running.");
	if (state.artifactSeal !== null || state.producerFence !== null)
		throw new Error("Child artifact seal cannot be replaced within an attempt.");
	if (state.outputObligation.status !== "undischarged")
		throw new Error("Child artifact seal cannot advance a terminal output obligation.");
	if (
		state.provisionalProducerExecutionId !== null &&
		state.provisionalProducerExecutionId !== event.producerExecutionId
	)
		throw new Error("Artifact seal changed producer execution without a new attempt.");
	assertReportedArtifactsMatch(state.declaration, event.artifacts);
	const sealedArtifacts = await resolveSealedArtifacts(context, state.declaration, event.artifacts);
	const authorized = await authorizeAndConsumeReceipt(
		context,
		hostTuple,
		state,
		event,
		event.witness,
		"artifact_seal",
		{
			sealId: event.sealId,
			outputObligationId: state.outputObligation.obligationId,
			packetDigest: event.packetDigest,
			producerExecutionId: event.producerExecutionId,
			artifacts: sealedArtifacts,
		},
	);
	const sealBase: ChildArtifactSeal = {
		sealId: event.sealId,
		producerAttemptId: state.attemptId,
		producerExecutionId: event.producerExecutionId,
		epochRef: state.epochRef,
		head: state.head,
		outputObligationId: state.outputObligation.obligationId,
		packetDigest: event.packetDigest,
		artifacts: sealedArtifacts,
		receipt: event.witness,
		receiptId: authorized.receiptId,
		consumptionWitness: authorized.consumptionWitness,
		hostStateDigest: hostTuple.stateDigest,
		hostRevision: hostTuple.revision,
		receiptDigest: authorized.receiptDigest,
		authorizationDigest: authorized.authorizationDigest,
		sealDigest: "",
		status: "stable",
		invalidationEventId: null,
		invalidationDigest: null,
		invalidationReason: null,
	};
	const seal = { ...sealBase, sealDigest: sealDigestForSeal(sealBase) };
	const revocationInput = {
		operation: "revoke_producer_write" as const,
		attemptId: state.attemptId,
		producerExecutionId: event.producerExecutionId,
		sealDigest: seal.sealDigest,
		outputObligationId: state.outputObligation.obligationId,
		epochRef: state.epochRef,
		head: state.head,
	};
	const revocationIntent: ChildProducerRevocationIntent = {
		...revocationInput,
		intentDigest: revocationIntentDigest(revocationInput),
	};
	const fence: ChildProducerFence = {
		fenceId: "",
		producerAttemptId: state.attemptId,
		producerExecutionId: event.producerExecutionId,
		sealId: seal.sealId,
		sealDigest: seal.sealDigest,
		outputObligationId: state.outputObligation.obligationId,
		epochRef: state.epochRef,
		head: state.head,
		hostAuthorityDigest: authorized.authorizationDigest,
		revocationIntent,
		writeAuthority: "revoked",
	};
	const completeFence = { ...fence, fenceId: fenceIdForFence(fence) };
	const intent = await prepareCommitIntent(context, {
		operation: "artifact_seal",
		eventId: event.eventId,
		eventDigest: eventDigest(event),
		workflowId: state.workflowId,
		taskId: state.taskId,
		childId: state.childId,
		runId: state.runId,
		attemptId: state.attemptId,
		producerExecutionId: event.producerExecutionId,
		outputObligationId: state.outputObligation.obligationId,
		epochRef: state.epochRef,
		head: state.head,
		expectedStateDigest: state.stateDigest,
		hostStateDigest: hostTuple.stateDigest,
		hostRevision: hostTuple.revision,
		packetDigest: event.packetDigest,
		sealDigest: seal.sealDigest,
		producerFenceId: completeFence.fenceId,
		deliveryId: null,
	});
	return withEvent(state, event, {
		...omitStateDigest(state),
		provisionalProducerExecutionId: event.producerExecutionId,
		artifactSeal: seal,
		producerFence: completeFence,
		durableCommitIntent: intent,
	});
}

function reduceProducerWriteAttemptEvent(
	state: ChildAttemptState,
	event: Extract<ChildOutputEvent, { kind: "producer_write_attempted" }>,
): ChildAttemptState {
	if (state.artifactSeal !== null || state.producerFence !== null)
		throw new Error("Producer write authority was revoked by the artifact seal.");
	if (state.status !== "running") throw new Error("Producer write is not valid after the running state.");
	if (
		state.provisionalProducerExecutionId !== null &&
		state.provisionalProducerExecutionId !== event.producerExecutionId
	)
		throw new Error("Producer write changed execution identity without a new attempt.");
	return withEvent(state, event, { ...omitStateDigest(state) });
}

async function observeSealDrift(
	context: ChildOutputHostContext,
	state: ChildAttemptState,
): Promise<{ readonly driftDigest: string; readonly reason: string } | null> {
	const observations: Array<{ readonly outputId: string; readonly status: "matching" | "drifted" }> = [];
	for (const artifact of state.artifactSeal?.artifacts ?? []) {
		try {
			const resolved = await parseResolvedArtifact(
				await context.receiptContext.artifactResolver.resolve(artifact.ref),
				artifact.ref,
			);
			observations.push({
				outputId: artifact.outputId,
				status: resolved.envelope.immutableGeneration === artifact.immutableGeneration ? "matching" : "drifted",
			});
		} catch {
			observations.push({ outputId: artifact.outputId, status: "drifted" });
		}
	}
	if (observations.every((observation) => observation.status === "matching")) return null;
	const reason = "immutable_artifact_drift_detected";
	return { driftDigest: digestObject({ sealDigest: state.artifactSeal?.sealDigest, observations, reason }), reason };
}

async function reduceSealDriftEvent(
	state: ChildAttemptState,
	event: Extract<ChildOutputEvent, { kind: "seal_drift_detected" }>,
	context: ChildOutputHostContext,
	hostTuple: ChildOutputHostTuple,
): Promise<ChildAttemptState> {
	const seal = state.artifactSeal;
	if (seal === null || state.producerFence === null || seal.status !== "stable")
		throw new Error("Seal drift requires a stable durable artifact seal.");
	if (event.producerExecutionId !== seal.producerExecutionId)
		throw new Error("Seal drift is bound to another producer execution.");
	const drift = await observeSealDrift(context, state);
	if (drift === null) throw new Error("Seal drift was not attested by a resolver reread.");
	await authorizeAndConsumeReceipt(context, hostTuple, state, event, event.witness, "artifact_drift", {
		producerExecutionId: event.producerExecutionId,
		sealDigest: seal.sealDigest,
		driftDigest: drift.driftDigest,
	});
	const invalidatedSeal: ChildArtifactSeal = {
		...seal,
		status: "invalidated",
		invalidationEventId: event.eventId,
		invalidationDigest: drift.driftDigest,
		invalidationReason: drift.reason,
	};
	const intent = await prepareCommitIntent(context, {
		operation: "artifact_drift",
		eventId: event.eventId,
		eventDigest: eventDigest(event),
		workflowId: state.workflowId,
		taskId: state.taskId,
		childId: state.childId,
		runId: state.runId,
		attemptId: state.attemptId,
		producerExecutionId: event.producerExecutionId,
		outputObligationId: state.outputObligation.obligationId,
		epochRef: state.epochRef,
		head: state.head,
		expectedStateDigest: state.stateDigest,
		hostStateDigest: hostTuple.stateDigest,
		hostRevision: hostTuple.revision,
		packetDigest: state.terminalPacketDigest,
		sealDigest: seal.sealDigest,
		producerFenceId: state.producerFence.fenceId,
		deliveryId: null,
	});
	return withEvent(state, event, {
		...omitStateDigest(state),
		status: "quarantined",
		outputObligation: {
			...state.outputObligation,
			status: "undischarged",
			terminalEventId: null,
			terminalReason: null,
		},
		artifactSeal: invalidatedSeal,
		coordinator: {
			...coordinatorWithWake(state, event, "error", true),
			deadline: {
				status: "pending",
				transitionEventId: null,
				transitionReason: null,
			},
			terminal: null,
		},
		continuationWake: state.continuationWake,
		diagnostic: null,
		continuationEscalation: null,
		deliveryId: null,
		acknowledgementReceipt: null,
		acknowledgementReceiptId: null,
		acknowledgementReceiptDigest: null,
		acknowledgementConsumptionWitness: null,
		acknowledgementAuthorizationDigest: null,
		validatedOutputs: [],
		reason: drift.reason,
		quarantineReason: drift.reason,
		durableCommitIntent: intent,
	});
}

async function reduceCompactionEvent(
	state: ChildAttemptState,
	event: Extract<ChildOutputEvent, { kind: "compaction_completed" }>,
	eventDigestValue: string,
	context: ChildOutputHostContext,
	hostTuple: ChildOutputHostTuple,
): Promise<ChildAttemptState> {
	if (state.status !== "running") throw new Error("Compaction is only valid while a child attempt is running.");
	if (state.outputObligation.status !== "undischarged")
		throw new Error("Compaction cannot clear a terminal required-output obligation.");
	if (state.artifactSeal !== null || state.producerFence !== null)
		throw new Error("Compaction cannot advance after the immutable artifact seal.");
	if (event.compactionCount !== state.compactionCount + 1)
		throw new Error("Child compaction count is not the next durable count.");
	if (event.compactionCount > state.declaration.maxCompactions)
		throw new Error("Child compaction exceeds the bounded declaration.");
	if (event.evidenceRef.sourceEventSequence > event.head.sequence)
		throw new Error("Compaction evidence is newer than its authenticated workflow head.");
	const evidence = await parseResolvedArtifact(
		await context.receiptContext.artifactResolver.resolve(event.evidenceRef),
		event.evidenceRef,
	);
	if (evidence.envelope.payloadKind !== "evidence") throw new Error("Compaction evidence has the wrong payload kind.");
	const evidenceDigest = sha256Hex(evidence.bytes);
	const authorized = await authorizeAndConsumeReceipt(context, hostTuple, state, event, event.witness, "compaction", {
		compactionId: event.compactionId,
		compactionCount: event.compactionCount,
		evidenceRef: event.evidenceRef,
		evidenceDigest,
		head: event.head,
	});
	const witnessDigest = digestObject(authorized.consumptionWitness);
	const headDigest = digestObject(event.head);
	const hasProgress =
		state.lastCompactionEvidenceDigest === null ||
		state.lastCompactionHeadDigest === null ||
		state.lastCompactionEvidenceDigest !== evidenceDigest ||
		state.lastCompactionHeadDigest !== headDigest;
	const compactionNoProgressCount = hasProgress ? 0 : state.compactionNoProgressCount + 1;
	const stalled = compactionNoProgressCount > 0;
	const diagnostic = stalled ? STALLED_OUTPUT_OBLIGATION_DIAGNOSTIC : null;
	const intent = await prepareCommitIntent(context, {
		operation: "compaction",
		eventId: event.eventId,
		eventDigest: eventDigestValue,
		workflowId: state.workflowId,
		taskId: state.taskId,
		childId: state.childId,
		runId: state.runId,
		attemptId: state.attemptId,
		producerExecutionId: null,
		outputObligationId: state.outputObligation.obligationId,
		epochRef: event.epochRef,
		head: event.head,
		expectedStateDigest: state.stateDigest,
		hostStateDigest: hostTuple.stateDigest,
		hostRevision: hostTuple.revision,
		packetDigest: null,
		sealDigest: null,
		producerFenceId: null,
		deliveryId: null,
	});
	return makeState({
		...omitStateDigest(state),
		head: event.head,
		compactionCount: event.compactionCount,
		compactionNoProgressCount,
		lastCompactionEvidenceDigest: evidenceDigest,
		lastCompactionHeadDigest: headDigest,
		coordinator: {
			...state.coordinator,
			meaningfulProgressDigest: coordinatorProgressDigest(evidenceDigest, event.head),
		},
		diagnostic,
		continuationEscalation: stalled
			? {
					reason: STALLED_OUTPUT_OBLIGATION_DIAGNOSTIC,
					eventId: event.eventId,
					diagnostic: STALLED_OUTPUT_OBLIGATION_DIAGNOSTIC,
				}
			: null,
		continuationWake:
			hasProgress || state.continuationWake === null
				? {
						wakeId: event.wakeId,
						childId: state.childId,
						attemptId: state.attemptId,
						safeBoundary: "after_compaction_queue_empty",
						compactionCount: event.compactionCount,
						evidenceDigest,
						headDigest,
						witnessDigest,
						createdByEventId: event.eventId,
						status: "pending",
					}
				: state.continuationWake,
		attemptLineage: updateCurrentLineageHead(state, event.head),
		appliedEventDigests: { ...state.appliedEventDigests, [event.eventId]: eventDigestValue },
		lastEventId: event.eventId,
		durableCommitIntent: intent,
	});
}

function reduceCoordinatorWakeEvent(
	state: ChildAttemptState,
	event:
		| Extract<ChildOutputEvent, { kind: "coordinator_wake_claimed" }>
		| Extract<ChildOutputEvent, { kind: "coordinator_wake_processed" }>
		| Extract<ChildOutputEvent, { kind: "coordinator_wake_failed" }>,
): ChildAttemptState {
	const wake = state.coordinator.wake;
	if (wake === null || wake.wakeKey !== event.wakeKey)
		throw new Error("Coordinator wake transition references an unknown stable wake key.");
	if (event.kind === "coordinator_wake_claimed") {
		if (wake.status !== "pending") throw new Error("Coordinator wake claim is not pending.");
		return withEvent(state, event, {
			...omitStateDigest(state),
			coordinator: {
				...state.coordinator,
				wake: { ...wake, status: "claimed", claimId: event.claimId, processedEventId: null, failureReason: null },
			},
		});
	}
	if (wake.status !== "claimed" || wake.claimId !== event.claimId)
		throw new Error("Coordinator wake transition does not own its durable claim.");
	return withEvent(state, event, {
		...omitStateDigest(state),
		coordinator: {
			...state.coordinator,
			wake:
				event.kind === "coordinator_wake_processed"
					? { ...wake, status: "processed", processedEventId: event.eventId, failureReason: null }
					: { ...wake, status: "failed", processedEventId: null, failureReason: event.reason },
		},
	});
}

async function reduceTerminalObligationEvent(
	state: ChildAttemptState,
	event:
		| Extract<ChildOutputEvent, { kind: "obligation_cancelled" }>
		| Extract<ChildOutputEvent, { kind: "terminal_failure_recorded" }>
		| Extract<ChildOutputEvent, { kind: "scope_change_approved" }>,
	context: ChildOutputHostContext,
	hostTuple: ChildOutputHostTuple,
): Promise<ChildAttemptState> {
	if (
		state.status === "completed" ||
		state.status === "cancelled" ||
		state.status === "terminal_failed" ||
		state.status === "scope_changed"
	)
		throw new Error("Child required-output obligation is already terminal.");
	let obligationStatus: Exclude<ChildOutputObligationStatus, "undischarged" | "discharged">;
	let status: ChildCoordinatorTerminalTransition["status"];
	let terminalReason: string;
	if (event.kind === "obligation_cancelled") {
		obligationStatus = "cancelled";
		status = "cancelled";
		terminalReason = event.reason;
	} else if (event.kind === "terminal_failure_recorded") {
		obligationStatus = "terminal_failed";
		status = "terminal_failed";
		terminalReason = event.reason;
	} else {
		obligationStatus = "scope_changed";
		status = "scope_changed";
		terminalReason = event.scopeDigest;
	}
	const nextEventDigest = eventDigest(event);
	await authorizeAndConsumeReceipt(context, hostTuple, state, event, event.witness, "terminal_gate", {
		status,
		reason: terminalReason,
		scopeDigest: event.kind === "scope_change_approved" ? event.scopeDigest : null,
	});
	const intent = await prepareCommitIntent(context, {
		operation: "terminal_gate",
		eventId: event.eventId,
		eventDigest: nextEventDigest,
		workflowId: state.workflowId,
		taskId: state.taskId,
		childId: state.childId,
		runId: state.runId,
		attemptId: state.attemptId,
		producerExecutionId: state.producerFence?.producerExecutionId ?? null,
		outputObligationId: state.outputObligation.obligationId,
		epochRef: state.epochRef,
		head: state.head,
		expectedStateDigest: state.stateDigest,
		hostStateDigest: hostTuple.stateDigest,
		hostRevision: hostTuple.revision,
		packetDigest: state.terminalPacketDigest,
		sealDigest: state.artifactSeal?.sealDigest ?? null,
		producerFenceId: state.producerFence?.fenceId ?? null,
		deliveryId: null,
	});
	return withEvent(state, event, {
		...omitStateDigest(state),
		status,
		coordinator: {
			...coordinatorWithWake(
				state,
				event,
				event.kind === "scope_change_approved" || event.kind === "obligation_cancelled" ? "gating" : "error",
				true,
			),
			deadline: coordinatorDeadline(obligationStatus, event.eventId, terminalReason),
			terminal: coordinatorTerminal(status, event.eventId, terminalReason),
		},
		outputObligation: {
			...state.outputObligation,
			status: obligationStatus,
			terminalEventId: event.eventId,
			terminalReason,
		},
		continuationWake: null,
		diagnostic: null,
		continuationEscalation: null,
		reason: terminalReason,
		acknowledgementReceipt: null,
		acknowledgementReceiptId: null,
		acknowledgementReceiptDigest: null,
		acknowledgementConsumptionWitness: null,
		acknowledgementAuthorizationDigest: null,
		durableCommitIntent: intent,
		appliedEventDigests: { ...state.appliedEventDigests, [event.eventId]: nextEventDigest },
		lastEventId: event.eventId,
	});
}

function reduceRetryEvent(
	state: ChildAttemptState,
	event: Extract<ChildOutputEvent, { kind: "attempt_retried" }>,
	eventDigestValue: string,
	context: ChildOutputHostContext,
): ChildAttemptState {
	if (state.status !== "completed" && state.status !== "retryable_incomplete" && state.status !== "quarantined")
		throw new Error("Retry requires a terminal child attempt.");
	if (event.attemptId !== state.attemptId || event.priorAttemptId !== state.attemptId)
		throw new Error("Retry event is not linked to the current attempt.");
	if (state.attemptNumber >= state.maxAttempts) throw new Error("Child retry exceeds max attempts.");
	if (state.attemptLineage.some((entry) => entry.attemptId === event.newAttemptId))
		throw new Error("Retry cannot reuse an attempt ID from immutable lineage.");
	if (event.lineageDigest !== retryLineageDigest(state, event.newAttemptId))
		throw new Error("Retry event lineage digest is invalid.");
	const nextDeclaration = parseChildTaskDeclaration(
		{ ...state.declaration, attemptId: event.newAttemptId, head: state.head },
		context,
	);
	const fresh = createChildAttemptState(nextDeclaration, context);
	const prior = state.attemptLineage[state.attemptLineage.length - 1];
	const priorTerminal = makeLineageEntry({
		...prior,
		status: state.status,
		terminalStateDigest: state.stateDigest,
		retryEventId: event.eventId,
	});
	const nextLineageEntry = makeLineageEntry({
		attemptId: fresh.attemptId,
		priorAttemptId: state.attemptId,
		attemptNumber: state.attemptNumber + 1,
		taskId: fresh.taskId,
		childId: fresh.childId,
		runId: fresh.runId,
		workflowId: fresh.workflowId,
		head: fresh.head,
		epochRef: fresh.epochRef,
		declarationDigest: fresh.bindingDigest,
		status: "running",
		terminalStateDigest: null,
		retryEventId: null,
	});
	const freshFields = omitStateDigest(fresh);
	return makeState({
		...freshFields,
		priorAttemptId: state.attemptId,
		attemptNumber: state.attemptNumber + 1,
		retryEventId: event.eventId,
		attemptLineage: [...state.attemptLineage.slice(0, -1), priorTerminal, nextLineageEntry],
		appliedEventDigests: { ...state.appliedEventDigests, [event.eventId]: eventDigestValue },
		lastEventId: event.eventId,
	});
}

/**
 * Reduce one child output event with resolver-backed validation and host fencing.
 *
 * Args:
 * state: Current immutable attempt projection.
 * event: Closed child or parent event carrying its expected prior digest.
 * context: Live host tuple, generic receipt consumer, resolver, validators, and commit-intent seam.
 * Return: Next immutable projection, or the same projection for an idempotent replay.
 */
export async function reduceChildOutputEvent(
	state: ChildAttemptState,
	event: ChildOutputEvent,
	context: ChildOutputHostContext,
): Promise<ChildAttemptState> {
	assertHostContext(context);
	const parsed = parseChildOutputEvent(event);
	const hostTuple = parseHostTuple(await context.readHostTuple(), "Live child output host tuple");
	const allowHeadAdvance = parsed.kind === "compaction_completed";
	assertStateIntegrity(state, hostTuple, allowHeadAdvance);
	const parsedDigest = eventDigest(parsed);
	const priorDigest = state.appliedEventDigests[parsed.eventId];
	assertEventHostBinding(parsed, state, hostTuple, allowHeadAdvance, priorDigest !== undefined);
	if (priorDigest !== undefined) {
		if (priorDigest !== parsedDigest) throw new Error("Child output event replay conflicts with its prior payload.");
		return state;
	}
	if (state.artifactSeal !== null) {
		await verifyPersistedReceiptAuthority(
			context,
			hostTuple,
			state.artifactSeal.receipt,
			state.artifactSeal.consumptionWitness,
			state.artifactSeal.receiptDigest,
			state.artifactSeal.authorizationDigest,
			state.artifactSeal.hostStateDigest,
			state.artifactSeal.hostRevision,
			state.artifactSeal.producerExecutionId,
		);
	}
	if (
		state.acknowledgementReceipt !== null &&
		state.acknowledgementConsumptionWitness !== null &&
		state.acknowledgementReceiptDigest !== null &&
		state.acknowledgementAuthorizationDigest !== null
	) {
		const acknowledgementIntent = state.durableCommitIntent;
		if (acknowledgementIntent === null || acknowledgementIntent.operation !== "parent_delivery_ack")
			throw new Error("Persisted child acknowledgement lacks its authenticated commit intent.");
		await verifyPersistedReceiptAuthority(
			context,
			hostTuple,
			state.acknowledgementReceipt,
			state.acknowledgementConsumptionWitness,
			state.acknowledgementReceiptDigest,
			state.acknowledgementAuthorizationDigest,
			acknowledgementIntent.hostStateDigest,
			acknowledgementIntent.hostRevision,
			undefined,
		);
	}
	if (parsed.attemptId !== state.attemptId) throw new Error("Child output event is fenced to another attempt.");
	if (parsed.expectedStateDigest !== state.stateDigest)
		throw new Error("Child output event has a stale state digest.");

	switch (parsed.kind) {
		case "provisional_progress":
			return reduceProvisionalProgressEvent(state, parsed);
		case "artifact_seal_recorded":
			return reduceArtifactSealEvent(state, parsed, context, hostTuple);
		case "producer_write_attempted":
			return reduceProducerWriteAttemptEvent(state, parsed);
		case "seal_drift_detected":
			return reduceSealDriftEvent(state, parsed, context, hostTuple);
		case "child_finished": {
			if (state.status !== "running") throw new Error("Child finished event is invalid after the running state.");
			if (parsed.finalAssistantResult === null) {
				if (state.artifactSeal !== null || state.producerFence !== null)
					throw new Error("A sealed child attempt cannot send a terminal packet without a final result.");
				return withEvent(state, parsed, {
					...omitStateDigest(state),
					status: "retryable_incomplete",
					coordinator: {
						...coordinatorWithWake(state, parsed, "error"),
					},
					terminalPacketDigest: null,
					terminalToolResults: [],
					finalAssistantResult: null,
					reportedArtifacts: [],
					validatedOutputs: [],
					deliveryId: null,
					acknowledgementReceipt: null,
					acknowledgementReceiptId: null,
					acknowledgementReceiptDigest: null,
					acknowledgementConsumptionWitness: null,
					acknowledgementAuthorizationDigest: null,
					reason: MISSING_FINAL_ASSISTANT_RESULT_REASON,
				});
			}
			if (
				state.artifactSeal === null ||
				state.producerFence === null ||
				state.artifactSeal.status !== "stable" ||
				parsed.producerExecutionId !== state.producerFence.producerExecutionId
			)
				throw new Error("Terminal child output requires a stable artifact seal and producer fence.");
			assertFinalResultMatches(state.declaration, parsed.finalAssistantResult);
			assertReportedArtifactsMatch(state.declaration, parsed.artifacts);
			const expectedPacketDigest = terminalPacketDigest(
				parsed.finalAssistantResult,
				parsed.toolResults,
				parsed.artifacts,
			);
			if (parsed.packetDigest !== expectedPacketDigest || parsed.packetDigest !== state.artifactSeal.packetDigest)
				throw new Error("Child terminal packet does not match the sealed canonical packet digest.");
			const parsedBytes = Uint8Array.from(parsed.finalAssistantResult.bytes);
			await context.validateFinalResult({
				result: parsed.finalAssistantResult,
				parsed: parseCanonicalJsonBytes(parsedBytes),
			});
			const terminalIntent = await prepareCommitIntent(context, {
				operation: "terminal_send",
				eventId: parsed.eventId,
				eventDigest: parsedDigest,
				workflowId: state.workflowId,
				taskId: state.taskId,
				childId: state.childId,
				runId: state.runId,
				attemptId: state.attemptId,
				producerExecutionId: parsed.producerExecutionId,
				outputObligationId: state.outputObligation.obligationId,
				epochRef: state.epochRef,
				head: state.head,
				expectedStateDigest: state.stateDigest,
				hostStateDigest: hostTuple.stateDigest,
				hostRevision: hostTuple.revision,
				packetDigest: parsed.packetDigest,
				sealDigest: state.artifactSeal.sealDigest,
				producerFenceId: state.producerFence.fenceId,
				deliveryId: null,
			});
			return withEvent(state, parsed, {
				...omitStateDigest(state),
				status: "validating",
				coordinator: {
					...coordinatorWithWake(state, parsed, "final_output"),
				},
				terminalPacketDigest: parsed.packetDigest,
				terminalToolResults: parsed.toolResults,
				finalAssistantResult: parsed.finalAssistantResult,
				reportedArtifacts: parsed.artifacts.map((artifact) => ({ ...artifact, ref: { ...artifact.ref } })),
				validatedOutputs: [],
				deliveryId: null,
				acknowledgementReceipt: null,
				acknowledgementReceiptId: null,
				acknowledgementReceiptDigest: null,
				acknowledgementConsumptionWitness: null,
				acknowledgementAuthorizationDigest: null,
				reason: null,
				durableCommitIntent: terminalIntent,
			});
		}
		case "outputs_validated": {
			if (state.status !== "validating")
				throw new Error("Output validation is only allowed after child completion.");
			const validatedOutputs = await resolveValidatedOutputs(
				context,
				state.declaration,
				state.reportedArtifacts,
				parsed.outputs,
			);
			return withEvent(state, parsed, {
				...omitStateDigest(state),
				status: "delivered_pending_ack",
				validatedOutputs,
				deliveryId: null,
				acknowledgementReceipt: null,
				acknowledgementReceiptId: null,
				acknowledgementReceiptDigest: null,
				acknowledgementConsumptionWitness: null,
				acknowledgementAuthorizationDigest: null,
				reason: null,
			});
		}
		case "parent_delivery_acknowledged": {
			if (state.status !== "delivered_pending_ack")
				throw new Error("Parent delivery acknowledgement is only valid while delivery is pending.");
			if (state.artifactSeal === null || state.producerFence === null || state.artifactSeal.status !== "stable")
				throw new Error("Parent delivery acknowledgement requires a stable artifact seal and producer fence.");
			if (parsed.receipt.receiptId === state.artifactSeal.receiptId)
				throw new Error(
					"Parent delivery acknowledgement requires a distinct one-use receipt from the artifact seal.",
				);
			if ((await observeSealDrift(context, state)) !== null)
				throw new Error("Parent delivery acknowledgement requires a resolver-attested stable artifact seal.");
			const acknowledged = await authorizeAndConsumeReceipt(
				context,
				hostTuple,
				state,
				parsed,
				parsed.receipt,
				"parent_delivery_ack",
				{
					deliveryId: parsed.deliveryId,
					outputObligationId: state.outputObligation.obligationId,
					packetDigest: state.terminalPacketDigest,
					sealDigest: state.artifactSeal.sealDigest,
					producerFenceId: state.producerFence.fenceId,
					artifacts: state.artifactSeal.artifacts,
				},
			);
			const ackIntent = await prepareCommitIntent(context, {
				operation: "parent_delivery_ack",
				eventId: parsed.eventId,
				eventDigest: parsedDigest,
				workflowId: state.workflowId,
				taskId: state.taskId,
				childId: state.childId,
				runId: state.runId,
				attemptId: state.attemptId,
				producerExecutionId: state.producerFence.producerExecutionId,
				outputObligationId: state.outputObligation.obligationId,
				epochRef: state.epochRef,
				head: state.head,
				expectedStateDigest: state.stateDigest,
				hostStateDigest: hostTuple.stateDigest,
				hostRevision: hostTuple.revision,
				packetDigest: state.terminalPacketDigest,
				sealDigest: state.artifactSeal.sealDigest,
				producerFenceId: state.producerFence.fenceId,
				deliveryId: parsed.deliveryId,
			});
			return withEvent(state, parsed, {
				...omitStateDigest(state),
				status: "completed",
				coordinator: {
					...state.coordinator,
					deadline: coordinatorDeadline("discharged", parsed.eventId, "parent_delivery_acknowledged"),
					terminal: coordinatorTerminal("completed", parsed.eventId, "parent_delivery_acknowledged"),
				},
				outputObligation: {
					...state.outputObligation,
					status: "discharged",
					terminalEventId: parsed.eventId,
					terminalReason: "parent_delivery_acknowledged",
				},
				continuationWake: null,
				diagnostic: null,
				continuationEscalation: null,
				deliveryId: parsed.deliveryId,
				acknowledgementReceipt: acknowledged.receipt,
				acknowledgementReceiptId: acknowledged.receiptId,
				acknowledgementReceiptDigest: acknowledged.receiptDigest,
				acknowledgementConsumptionWitness: acknowledged.consumptionWitness,
				acknowledgementAuthorizationDigest: acknowledged.authorizationDigest,
				durableCommitIntent: ackIntent,
				reason: null,
			});
		}
		case "attempt_retried":
			return reduceRetryEvent(state, parsed, parsedDigest, context);
		case "compaction_completed":
			return reduceCompactionEvent(state, parsed, parsedDigest, context, hostTuple);
		case "obligation_cancelled":
		case "terminal_failure_recorded":
		case "scope_change_approved":
			return reduceTerminalObligationEvent(state, parsed, context, hostTuple);
		case "coordinator_wake_claimed":
		case "coordinator_wake_processed":
		case "coordinator_wake_failed":
			return reduceCoordinatorWakeEvent(state, parsed);
		case "follow_up_requested":
			throw new Error("Follow-up to a terminal child attempt requires an explicitly new attempt.");
		case "attempt_completed":
			throw new Error("Child attempt cannot complete without durable parent delivery acknowledgement.");
	}
}

/**
 * Record an explicitly new retry attempt through the same durable retry event reducer.
 *
 * Args:
 * state: Terminal attempt projection eligible for a bounded retry.
 * input: New attempt ID and retry event ID.
 * context: Current host binding used to fence the retry.
 * Return: Fresh running attempt with immutable prior-attempt lineage.
 */
export async function createRetryAttempt(
	state: ChildAttemptState,
	input: ChildRetryAttemptInput,
	context: ChildOutputHostContext,
): Promise<ChildAttemptState> {
	assertNonEmptyString(input.attemptId, "Retry attemptId");
	assertNonEmptyString(input.eventId, "Retry eventId");
	assertHostContext(context);
	const hostTuple = parseHostTuple(await context.readHostTuple(), "Live child output host tuple");
	const epochRef = input.epochRef ?? hostTuple.epochRef;
	const event: ChildOutputEvent = {
		eventId: input.eventId,
		attemptId: state.attemptId,
		workflowId: hostTuple.workflowId,
		head: hostTuple.head,
		epochRef,
		expectedStateDigest: state.stateDigest,
		kind: "attempt_retried",
		priorAttemptId: state.attemptId,
		newAttemptId: input.attemptId,
		lineageDigest: retryLineageDigest(state, input.attemptId),
	};
	return reduceChildOutputEvent(state, event, context);
}

export const parseChildOutputDeclaration = parseChildTaskDeclaration;
export const createChildOutputContractState = createChildAttemptState;
export const reduceChildOutputContract = reduceChildOutputEvent;
export const retryChildAttempt = createRetryAttempt;
