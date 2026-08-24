import type {
	WorkflowArtifactRef,
	WorkflowHostPrincipalCapabilityAuthorization,
	WorkflowHostPrincipalCapabilityAuthorizer,
	WorkflowHostReceiptCapability,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { digestObject } from "./contracts.js";
import { assertWorkflowRuntimeVersion } from "./runtime-store-adapter.js";

export type CoordinatorStatusKind = "working" | "waiting_on_children" | "idle" | "blocked" | "needs_input";

export type CoordinatorIdleReason =
	| "none"
	| "write_conflict"
	| "dependency_blocked"
	| "resource_exhausted"
	| "provider_backpressure"
	| "user_decision"
	| "no_ready_work"
	| "recovery";

export interface CoordinatorStatusCurrentBinding {
	readonly workflowId: string;
	readonly journalHeadDigest: string;
	readonly storeEpoch: number;
	readonly coordinatorEpoch: number;
	readonly revision: number;
	readonly sourceEventSequence: number;
	readonly sourceEventTime: string;
	readonly trustedNow: string;
	readonly generation: number;
	readonly fenceToken: string;
}

export interface CoordinatorStatusHostAdapter {
	/** Read one host-atomic snapshot; this seam must not consume or rotate authority. */
	readonly readAtomicSnapshot: () => Promise<unknown>;
	/** Assert that the frozen snapshot remains current without mutating host authority. */
	readonly assertCurrent: (input: {
		readonly current: CoordinatorStatusCurrentBinding;
		readonly payloadDigest: string;
	}) => Promise<void>;
	readonly resolvePendingDecision: (input: {
		readonly current: CoordinatorStatusCurrentBinding;
		readonly payloadDigest: string;
	}) => Promise<unknown>;
	readonly principalAuthorizer: WorkflowHostPrincipalCapabilityAuthorizer;
}

export type CoordinatorStatusHostEvidenceResolver = CoordinatorStatusHostAdapter;

export interface CoordinatorStatusInput {
	readonly runtimeVersion: string;
	readonly host: CoordinatorStatusHostAdapter;
}

export interface CoordinatorStatusProjectionRequest {
	readonly runtimeVersion: string;
}

export interface CoordinatorStatusProjection {
	readonly status: CoordinatorStatusKind;
	readonly activeWorkers: number;
	readonly eligibleReadyTasks: number;
	readonly idleCapacity: number;
	readonly idleReason: CoordinatorIdleReason;
}

type CoordinatorChildPhase = "starting" | "running" | "awaiting_audit" | "reconciling";

interface CoordinatorSchedulerPayload {
	readonly activeWorkerIds: readonly string[];
	readonly readyTaskIds: readonly string[];
	readonly pendingMessageIds: readonly string[];
	readonly scheduledWakeAt: string | null;
	readonly authenticatedCapacity: number;
	readonly rawCapacity?: number;
	readonly blockingReasons: readonly CoordinatorIdleReason[];
}

interface CoordinatorChildPayload {
	readonly childId: string;
	readonly phase: CoordinatorChildPhase;
	readonly reportedStatus?: string;
}

interface CoordinatorEvidencePayload {
	readonly scheduler: CoordinatorSchedulerPayload;
	readonly children: readonly CoordinatorChildPayload[];
}

interface CoordinatorStatusAtomicSnapshot {
	readonly current: CoordinatorStatusCurrentBinding;
	readonly evidence: CoordinatorVerifiedEvidence;
}

interface CoordinatorVerifiedEvidence {
	readonly payload: CoordinatorEvidencePayload;
	readonly payloadDigest: string;
	readonly workflowId: string;
	readonly journalHeadDigest: string;
	readonly storeEpoch: number;
	readonly coordinatorEpoch: number;
	readonly revision: number;
	readonly sourceEventSequence: number;
	readonly sourceEventTime: string;
	readonly generation: number;
	readonly fenceToken: string;
}

export interface CoordinatorStatusPendingDecision {
	readonly registryMembershipDigest: string;
	readonly decisionId: string;
	readonly decisionDigest: string;
	readonly capability: WorkflowHostReceiptCapability;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface CoordinatorStatusPendingDecisionBindingInput {
	readonly current: CoordinatorStatusCurrentBinding;
	readonly payloadDigest: string;
	readonly registryMembershipDigest: string;
	readonly decisionId: string;
	readonly decisionDigest: string;
}

/**
 * Build the canonical binding digest a host capability receipt must carry.
 *
 * Args:
 * input: Current host binding, evidence digest, and host-resolved decision identity.
 * Return: Digest covering every status decision binding field.
 */
export function coordinatorStatusPendingDecisionBindingDigest(
	input: CoordinatorStatusPendingDecisionBindingInput,
): string {
	return digestObject({
		workflowId: input.current.workflowId,
		journalHeadDigest: input.current.journalHeadDigest,
		storeEpoch: input.current.storeEpoch,
		coordinatorEpoch: input.current.coordinatorEpoch,
		revision: input.current.revision,
		payloadDigest: input.payloadDigest,
		generation: input.current.generation,
		fenceToken: input.current.fenceToken,
		sourceEventSequence: input.current.sourceEventSequence,
		sourceEventTime: input.current.sourceEventTime,
		trustedNow: input.current.trustedNow,
		registryMembershipDigest: input.registryMembershipDigest,
		decisionId: input.decisionId,
		decisionDigest: input.decisionDigest,
	});
}

const ACTIVE_CHILD_PHASES: ReadonlySet<string> = new Set(["starting", "running", "awaiting_audit", "reconciling"]);
const IDLE_REASON_PRIORITY: readonly CoordinatorIdleReason[] = [
	"recovery",
	"write_conflict",
	"dependency_blocked",
	"resource_exhausted",
	"provider_backpressure",
	"user_decision",
	"no_ready_work",
];
const KNOWN_IDLE_REASONS: ReadonlySet<string> = new Set(IDLE_REASON_PRIORITY);
const INPUT_KEYS = ["runtimeVersion", "host"] as const;
const HOST_KEYS = ["readAtomicSnapshot", "assertCurrent", "resolvePendingDecision", "principalAuthorizer"] as const;
const SNAPSHOT_KEYS = ["current", "evidence"] as const;
const CURRENT_KEYS = [
	"workflowId",
	"journalHeadDigest",
	"storeEpoch",
	"coordinatorEpoch",
	"revision",
	"sourceEventSequence",
	"sourceEventTime",
	"trustedNow",
	"generation",
	"fenceToken",
] as const;
const EVIDENCE_KEYS = [
	"payload",
	"payloadDigest",
	"workflowId",
	"journalHeadDigest",
	"storeEpoch",
	"coordinatorEpoch",
	"revision",
	"sourceEventSequence",
	"sourceEventTime",
	"generation",
	"fenceToken",
] as const;
const PAYLOAD_KEYS = ["scheduler", "children"] as const;
const SCHEDULER_KEYS = [
	"activeWorkerIds",
	"readyTaskIds",
	"pendingMessageIds",
	"scheduledWakeAt",
	"authenticatedCapacity",
	"blockingReasons",
] as const;
const CHILDREN_KEYS = ["obligations"] as const;
const PENDING_DECISION_KEYS = [
	"registryMembershipDigest",
	"decisionId",
	"decisionDigest",
	"capability",
	"receipt",
] as const;
const RECEIPT_KEYS = [
	"receiptKind",
	"oneUse",
	"receiptId",
	"issuerId",
	"workflowId",
	"bindingDigest",
	"payloadDigest",
	"artifactRef",
	"issuedAt",
	"validUntil",
	"keyId",
	"signatureAlgorithm",
	"artifactBytesDigest",
	"stateDigest",
	"revision",
	"signature",
	"verificationDigest",
] as const;
const RECEIPT_OPTIONAL_KEYS = ["capabilityBinding"] as const;
const ARTIFACT_REF_KEYS = ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"] as const;
const CAPABILITY_BINDING_KEYS = [
	"capability",
	"resourceDigest",
	"operationDigest",
	"executionIdentity",
	"sessionId",
] as const;
const AUTHORIZATION_KEYS = [
	"authenticatedPrincipal",
	"keyOwnerPrincipal",
	"capability",
	"workflowId",
	"bindingDigest",
	"receipt",
	"stateDigest",
	"revision",
	"epochRef",
	"validity",
	"authorizationDigest",
] as const;
const AUTHORIZATION_OPTIONAL_KEYS = ["executionIdentity", "sessionId"] as const;
const EPOCH_KEYS = ["storeEpoch", "coordinatorEpoch"] as const;
const VALIDITY_KEYS = ["issuedAt", "validUntil"] as const;
const KNOWN_RECEIPT_KINDS: ReadonlySet<string> = new Set([
	"clock",
	"artifact",
	"capability",
	"decision",
	"lease",
	"usage",
	"adjudication",
]);
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
	"workflow_observation_process",
	"workflow_observation_dataset_receipt",
	"workflow_coordinator_status_projection",
	"workflow_checkpoint_budget_observation",
	"workflow_dispatch_capacity_attestation",
	"workflow_dispatch_path_attestation",
	"portfolio_default_completion",
	"workflow_learning_knowledge_promotion",
	"autoresearch.legacy_scalar_provenance_import",
	"workflow_intent_red_mutation",
	"child_output_delivery_ack",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[], optionalKeys: readonly string[] = []): boolean {
	if (!isRecord(value)) return false;
	const allowed = new Set([...keys, ...optionalKeys]);
	const ownKeys = Reflect.ownKeys(value);
	return (
		keys.every((key) => Object.hasOwn(value, key)) &&
		ownKeys.every((key) => typeof key === "string" && allowed.has(key))
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || isNonEmptyString(value);
}

function isSafePositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isSafeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isKnownIdleReason(value: unknown): value is CoordinatorIdleReason {
	return typeof value === "string" && KNOWN_IDLE_REASONS.has(value);
}

function isValidTime(value: unknown): value is string {
	return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isKnownCapability(value: unknown): value is WorkflowHostReceiptCapability {
	return typeof value === "string" && KNOWN_CAPABILITIES.has(value);
}

function isKnownReceiptKind(value: unknown): boolean {
	return typeof value === "string" && KNOWN_RECEIPT_KINDS.has(value);
}

function uniqueStrings(value: unknown): value is readonly string[] {
	if (!Array.isArray(value)) return false;
	const values: string[] = [];
	for (const item of value) {
		if (!isNonEmptyString(item)) return false;
		values.push(item);
	}
	return new Set(values).size === values.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value) => right.includes(value));
}

function validBlockingReasons(value: unknown): value is readonly CoordinatorIdleReason[] {
	if (!Array.isArray(value)) return false;
	const reasons: CoordinatorIdleReason[] = [];
	for (const reason of value) {
		if (!isKnownIdleReason(reason)) return false;
		reasons.push(reason);
	}
	if (reasons.includes("none")) return false;
	return new Set(reasons).size === reasons.length;
}

function limitingReason(
	reasons: readonly CoordinatorIdleReason[],
	fallback: CoordinatorIdleReason,
): CoordinatorIdleReason {
	for (const reason of IDLE_REASON_PRIORITY) {
		if (reasons.includes(reason)) return reason;
	}
	return fallback;
}

function recoveryProjection(): CoordinatorStatusProjection {
	return Object.freeze({
		status: "blocked",
		activeWorkers: 0,
		eligibleReadyTasks: 0,
		idleCapacity: 0,
		idleReason: "recovery",
	});
}

function parseCurrentBinding(value: unknown): CoordinatorStatusCurrentBinding | null {
	if (!hasExactKeys(value, CURRENT_KEYS)) return null;
	const current = value as Record<string, unknown>;
	if (
		!isNonEmptyString(current.workflowId) ||
		!isNonEmptyString(current.journalHeadDigest) ||
		!isSafePositiveInteger(current.storeEpoch) ||
		!isSafePositiveInteger(current.coordinatorEpoch) ||
		!isSafePositiveInteger(current.revision) ||
		!isSafePositiveInteger(current.sourceEventSequence) ||
		!isValidTime(current.sourceEventTime) ||
		!isValidTime(current.trustedNow) ||
		!isSafePositiveInteger(current.generation) ||
		!isNonEmptyString(current.fenceToken)
	)
		return null;
	if (Date.parse(current.sourceEventTime) > Date.parse(current.trustedNow)) return null;
	return {
		workflowId: current.workflowId,
		journalHeadDigest: current.journalHeadDigest,
		storeEpoch: current.storeEpoch,
		coordinatorEpoch: current.coordinatorEpoch,
		revision: current.revision,
		sourceEventSequence: current.sourceEventSequence,
		sourceEventTime: current.sourceEventTime,
		trustedNow: current.trustedNow,
		generation: current.generation,
		fenceToken: current.fenceToken,
	};
}

function parseScheduler(value: unknown): CoordinatorSchedulerPayload | null {
	if (!hasExactKeys(value, SCHEDULER_KEYS, ["rawCapacity"])) return null;
	const scheduler = value as Record<string, unknown>;
	const hasRawCapacity = Object.hasOwn(scheduler, "rawCapacity");
	const rawCapacity = hasRawCapacity ? scheduler.rawCapacity : undefined;
	if (
		!uniqueStrings(scheduler.activeWorkerIds) ||
		!uniqueStrings(scheduler.readyTaskIds) ||
		!uniqueStrings(scheduler.pendingMessageIds) ||
		!(scheduler.scheduledWakeAt === null || isValidTime(scheduler.scheduledWakeAt)) ||
		!isSafeCount(scheduler.authenticatedCapacity) ||
		(hasRawCapacity && !isSafeCount(rawCapacity)) ||
		!validBlockingReasons(scheduler.blockingReasons)
	)
		return null;
	return {
		activeWorkerIds: [...scheduler.activeWorkerIds],
		readyTaskIds: [...scheduler.readyTaskIds],
		pendingMessageIds: [...scheduler.pendingMessageIds],
		scheduledWakeAt: scheduler.scheduledWakeAt as string | null,
		authenticatedCapacity: scheduler.authenticatedCapacity,
		rawCapacity: hasRawCapacity ? (rawCapacity as number) : undefined,
		blockingReasons: [...scheduler.blockingReasons],
	};
}

function parseChild(value: unknown): CoordinatorChildPayload | null {
	if (!hasExactKeys(value, ["childId", "phase"], ["reportedStatus"])) return null;
	const child = value as Record<string, unknown>;
	const hasReportedStatus = Object.hasOwn(child, "reportedStatus");
	const reportedStatus = hasReportedStatus ? child.reportedStatus : undefined;
	if (
		!isNonEmptyString(child.childId) ||
		typeof child.phase !== "string" ||
		!ACTIVE_CHILD_PHASES.has(child.phase) ||
		(hasReportedStatus && typeof reportedStatus !== "string")
	)
		return null;
	if (hasReportedStatus) {
		return {
			childId: child.childId,
			phase: child.phase as CoordinatorChildPhase,
			reportedStatus: reportedStatus as string,
		};
	}
	return { childId: child.childId, phase: child.phase as CoordinatorChildPhase };
}

function parsePayload(value: unknown): CoordinatorEvidencePayload | null {
	if (!hasExactKeys(value, PAYLOAD_KEYS)) return null;
	const payload = value as Record<string, unknown>;
	const scheduler = parseScheduler(payload.scheduler);
	if (scheduler === null) return null;
	if (!hasExactKeys(payload.children, CHILDREN_KEYS)) return null;
	const childrenValue = payload.children as Record<string, unknown>;
	if (!Array.isArray(childrenValue.obligations)) return null;
	const children: CoordinatorChildPayload[] = [];
	for (const childValue of childrenValue.obligations) {
		const child = parseChild(childValue);
		if (child === null) return null;
		children.push(child);
	}
	const childIds = children.map((child) => child.childId);
	if (!uniqueStrings(childIds) || !sameStringSet(scheduler.activeWorkerIds, childIds)) return null;
	if (scheduler.activeWorkerIds.length > scheduler.authenticatedCapacity) return null;
	return {
		scheduler,
		children,
	};
}

function parseVerifiedEvidence(value: unknown): CoordinatorVerifiedEvidence | null {
	if (!hasExactKeys(value, EVIDENCE_KEYS)) return null;
	const evidence = value as Record<string, unknown>;
	const payloadValue = parsePayload(evidence.payload);
	if (
		payloadValue === null ||
		!isNonEmptyString(evidence.payloadDigest) ||
		!isNonEmptyString(evidence.workflowId) ||
		!isNonEmptyString(evidence.journalHeadDigest) ||
		!isSafePositiveInteger(evidence.storeEpoch) ||
		!isSafePositiveInteger(evidence.coordinatorEpoch) ||
		!isSafePositiveInteger(evidence.revision) ||
		!isSafePositiveInteger(evidence.sourceEventSequence) ||
		!isValidTime(evidence.sourceEventTime) ||
		!isSafePositiveInteger(evidence.generation) ||
		!isNonEmptyString(evidence.fenceToken)
	)
		return null;
	try {
		if (evidence.payloadDigest !== digestObject(evidence.payload)) return null;
	} catch {
		return null;
	}
	return {
		payload: payloadValue,
		payloadDigest: evidence.payloadDigest,
		workflowId: evidence.workflowId,
		journalHeadDigest: evidence.journalHeadDigest,
		storeEpoch: evidence.storeEpoch,
		coordinatorEpoch: evidence.coordinatorEpoch,
		revision: evidence.revision,
		sourceEventSequence: evidence.sourceEventSequence,
		sourceEventTime: evidence.sourceEventTime,
		generation: evidence.generation,
		fenceToken: evidence.fenceToken,
	};
}

function bindsToCurrent(evidence: CoordinatorVerifiedEvidence, current: CoordinatorStatusCurrentBinding): boolean {
	return (
		evidence.workflowId === current.workflowId &&
		evidence.journalHeadDigest === current.journalHeadDigest &&
		evidence.storeEpoch === current.storeEpoch &&
		evidence.coordinatorEpoch === current.coordinatorEpoch &&
		evidence.revision === current.revision &&
		evidence.sourceEventSequence === current.sourceEventSequence &&
		evidence.sourceEventTime === current.sourceEventTime &&
		evidence.generation === current.generation &&
		evidence.fenceToken === current.fenceToken
	);
}

function parseArtifactRef(value: unknown): WorkflowArtifactRef | null {
	if (!hasExactKeys(value, ARTIFACT_REF_KEYS)) return null;
	const ref = value as Record<string, unknown>;
	if (
		!isNonEmptyString(ref.artifactId) ||
		!isNonEmptyString(ref.relativePath) ||
		!isNonEmptyString(ref.digest) ||
		!isSafePositiveInteger(ref.sizeBytes) ||
		!isSafePositiveInteger(ref.sourceEventSequence)
	)
		return null;
	return {
		artifactId: ref.artifactId,
		relativePath: ref.relativePath,
		digest: ref.digest,
		sizeBytes: ref.sizeBytes,
		sourceEventSequence: ref.sourceEventSequence,
	};
}

function parseHostReceipt(value: unknown): WorkflowVerifiedHostReceipt | null {
	if (!hasExactKeys(value, RECEIPT_KEYS, RECEIPT_OPTIONAL_KEYS)) return null;
	const receipt = value as Record<string, unknown>;
	const artifactRef = parseArtifactRef(receipt.artifactRef);
	if (
		!isKnownReceiptKind(receipt.receiptKind) ||
		receipt.receiptKind !== "capability" ||
		typeof receipt.oneUse !== "boolean" ||
		!isNonEmptyString(receipt.receiptId) ||
		!isNonEmptyString(receipt.issuerId) ||
		!isNonEmptyString(receipt.workflowId) ||
		!isNonEmptyString(receipt.bindingDigest) ||
		!isNonEmptyString(receipt.payloadDigest) ||
		artifactRef === null ||
		!isValidTime(receipt.issuedAt) ||
		!isValidTime(receipt.validUntil) ||
		Date.parse(receipt.issuedAt) > Date.parse(receipt.validUntil) ||
		!isNonEmptyString(receipt.keyId) ||
		receipt.signatureAlgorithm !== "ed25519" ||
		!isNonEmptyString(receipt.artifactBytesDigest) ||
		!isNonEmptyString(receipt.stateDigest) ||
		!isSafePositiveInteger(receipt.revision) ||
		!isNonEmptyString(receipt.signature) ||
		!isNonEmptyString(receipt.verificationDigest) ||
		!hasExactKeys(receipt.capabilityBinding, CAPABILITY_BINDING_KEYS)
	)
		return null;
	const capabilityBinding = receipt.capabilityBinding as Record<string, unknown>;
	if (
		!isKnownCapability(capabilityBinding.capability) ||
		!isNonEmptyString(capabilityBinding.resourceDigest) ||
		!isNonEmptyString(capabilityBinding.operationDigest) ||
		!isNullableString(capabilityBinding.executionIdentity) ||
		!isNullableString(capabilityBinding.sessionId)
	)
		return null;
	return {
		receiptKind: "capability",
		oneUse: receipt.oneUse,
		receiptId: receipt.receiptId,
		issuerId: receipt.issuerId,
		workflowId: receipt.workflowId,
		bindingDigest: receipt.bindingDigest,
		payloadDigest: receipt.payloadDigest,
		artifactRef,
		issuedAt: receipt.issuedAt,
		validUntil: receipt.validUntil,
		keyId: receipt.keyId,
		signatureAlgorithm: "ed25519",
		artifactBytesDigest: receipt.artifactBytesDigest,
		stateDigest: receipt.stateDigest,
		revision: receipt.revision,
		capabilityBinding: {
			capability: capabilityBinding.capability,
			resourceDigest: capabilityBinding.resourceDigest,
			operationDigest: capabilityBinding.operationDigest,
			executionIdentity: capabilityBinding.executionIdentity,
			sessionId: capabilityBinding.sessionId,
		},
		signature: receipt.signature,
		verificationDigest: receipt.verificationDigest,
	};
}

function pendingDecisionBindingDigest(
	current: CoordinatorStatusCurrentBinding,
	payloadDigest: string,
	pendingDecision: Pick<
		CoordinatorStatusPendingDecision,
		"registryMembershipDigest" | "decisionId" | "decisionDigest"
	>,
): string {
	return coordinatorStatusPendingDecisionBindingDigest({
		current,
		payloadDigest,
		registryMembershipDigest: pendingDecision.registryMembershipDigest,
		decisionId: pendingDecision.decisionId,
		decisionDigest: pendingDecision.decisionDigest,
	});
}

function parsePendingDecision(
	value: unknown,
	current: CoordinatorStatusCurrentBinding,
	payloadDigest: string,
): CoordinatorStatusPendingDecision | null | undefined {
	if (value === null) return null;
	if (!hasExactKeys(value, PENDING_DECISION_KEYS)) return undefined;
	const pendingDecision = value as Record<string, unknown>;
	if (
		!isNonEmptyString(pendingDecision.registryMembershipDigest) ||
		!isNonEmptyString(pendingDecision.decisionId) ||
		!isNonEmptyString(pendingDecision.decisionDigest) ||
		!isKnownCapability(pendingDecision.capability)
	)
		return undefined;
	const receipt = parseHostReceipt(pendingDecision.receipt);
	if (receipt === null) return undefined;
	const candidate: CoordinatorStatusPendingDecision = {
		registryMembershipDigest: pendingDecision.registryMembershipDigest,
		decisionId: pendingDecision.decisionId,
		decisionDigest: pendingDecision.decisionDigest,
		capability: pendingDecision.capability,
		receipt,
	};
	try {
		if (
			receipt.workflowId !== current.workflowId ||
			receipt.payloadDigest !== payloadDigest ||
			receipt.stateDigest !== current.journalHeadDigest ||
			receipt.revision !== current.revision ||
			Date.parse(receipt.issuedAt) > Date.parse(current.trustedNow) ||
			Date.parse(receipt.validUntil) < Date.parse(current.trustedNow) ||
			receipt.capabilityBinding === undefined ||
			receipt.capabilityBinding.capability !== candidate.capability ||
			receipt.capabilityBinding.resourceDigest !== candidate.registryMembershipDigest ||
			receipt.capabilityBinding.operationDigest !== candidate.decisionDigest ||
			receipt.bindingDigest !== pendingDecisionBindingDigest(current, payloadDigest, candidate)
		)
			return undefined;
	} catch {
		return undefined;
	}
	return candidate;
}

function parseAtomicSnapshot(value: unknown): CoordinatorStatusAtomicSnapshot | null {
	if (!hasExactKeys(value, SNAPSHOT_KEYS)) return null;
	const snapshot = value as Record<string, unknown>;
	const current = parseCurrentBinding(snapshot.current);
	const evidence = parseVerifiedEvidence(snapshot.evidence);
	if (current === null || evidence === null || !bindsToCurrent(evidence, current)) return null;
	return { current, evidence };
}

function isPendingDecisionAuthorization(
	value: unknown,
	current: CoordinatorStatusCurrentBinding,
	payloadDigest: string,
	pendingDecision: CoordinatorStatusPendingDecision,
): value is WorkflowHostPrincipalCapabilityAuthorization {
	if (!hasExactKeys(value, AUTHORIZATION_KEYS, AUTHORIZATION_OPTIONAL_KEYS)) return false;
	const authorization = value as Record<string, unknown>;
	if (
		!isNonEmptyString(authorization.authenticatedPrincipal) ||
		!isNonEmptyString(authorization.keyOwnerPrincipal) ||
		!isKnownCapability(authorization.capability) ||
		!isNonEmptyString(authorization.workflowId) ||
		!isNonEmptyString(authorization.bindingDigest) ||
		!isNonEmptyString(authorization.stateDigest) ||
		!isSafePositiveInteger(authorization.revision) ||
		!isNonEmptyString(authorization.authorizationDigest) ||
		!hasExactKeys(authorization.epochRef, EPOCH_KEYS) ||
		!hasExactKeys(authorization.validity, VALIDITY_KEYS)
	)
		return false;
	const receipt = parseHostReceipt(authorization.receipt);
	const epochRef = authorization.epochRef as Record<string, unknown>;
	const validity = authorization.validity as Record<string, unknown>;
	if (
		receipt === null ||
		authorization.capability !== pendingDecision.capability ||
		authorization.workflowId !== current.workflowId ||
		authorization.bindingDigest !== pendingDecisionBindingDigest(current, payloadDigest, pendingDecision) ||
		authorization.stateDigest !== current.journalHeadDigest ||
		authorization.revision !== current.revision ||
		epochRef.storeEpoch !== current.storeEpoch ||
		epochRef.coordinatorEpoch !== current.coordinatorEpoch ||
		receipt.receiptId !== pendingDecision.receipt.receiptId ||
		receipt.bindingDigest !== authorization.bindingDigest ||
		!isValidTime(validity.issuedAt) ||
		!isValidTime(validity.validUntil) ||
		validity.issuedAt !== receipt.issuedAt ||
		validity.validUntil !== receipt.validUntil
	)
		return false;
	if (Object.hasOwn(authorization, "executionIdentity") && !isNonEmptyString(authorization.executionIdentity))
		return false;
	if (Object.hasOwn(authorization, "sessionId") && !isNonEmptyString(authorization.sessionId)) return false;
	if (
		Object.hasOwn(authorization, "executionIdentity") &&
		authorization.executionIdentity !== receipt.capabilityBinding?.executionIdentity
	)
		return false;
	if (Object.hasOwn(authorization, "sessionId") && authorization.sessionId !== receipt.capabilityBinding?.sessionId)
		return false;
	try {
		return digestObject(receipt) === digestObject(pendingDecision.receipt);
	} catch {
		return false;
	}
}

function projectPayload(
	payload: CoordinatorEvidencePayload,
	pendingDecision: CoordinatorStatusPendingDecision | null,
): CoordinatorStatusProjection {
	const activeWorkers = payload.scheduler.activeWorkerIds.length;
	const eligibleReadyTasks = payload.scheduler.readyTaskIds.length;
	const idleCapacity = payload.scheduler.authenticatedCapacity - activeWorkers;
	const blockingReasons = payload.scheduler.blockingReasons;

	if (blockingReasons.includes("recovery")) return recoveryProjection();
	if (activeWorkers > 0) {
		return Object.freeze({
			status: eligibleReadyTasks > 0 ? "working" : "waiting_on_children",
			activeWorkers,
			eligibleReadyTasks,
			idleCapacity,
			idleReason: "none",
		});
	}
	if (eligibleReadyTasks > 0 && idleCapacity > 0) {
		return Object.freeze({
			status: "working",
			activeWorkers,
			eligibleReadyTasks,
			idleCapacity,
			idleReason: "none",
		});
	}
	if (eligibleReadyTasks > 0) {
		return Object.freeze({
			status: "blocked",
			activeWorkers,
			eligibleReadyTasks,
			idleCapacity,
			idleReason: limitingReason(blockingReasons, "resource_exhausted"),
		});
	}
	if (payload.scheduler.pendingMessageIds.length > 0 || payload.scheduler.scheduledWakeAt !== null) {
		return Object.freeze({
			status: "waiting_on_children",
			activeWorkers,
			eligibleReadyTasks,
			idleCapacity,
			idleReason: "none",
		});
	}
	if (pendingDecision !== null) {
		return Object.freeze({
			status: "needs_input",
			activeWorkers,
			eligibleReadyTasks,
			idleCapacity,
			idleReason: "user_decision",
		});
	}
	if (blockingReasons.includes("user_decision")) return recoveryProjection();
	return Object.freeze({
		status: "idle",
		activeWorkers,
		eligibleReadyTasks,
		idleCapacity,
		idleReason: limitingReason(blockingReasons, "no_ready_work"),
	});
}

/**
 * Project public coordinator status from one host-verified, atomic read snapshot.
 *
 * Args:
 * input: Versioned host adapter for a read-only snapshot/assert-current seam and canonical decisions.
 * Return: Frozen status projection; resolver or binding failures become recovery/blocked state.
 */
export async function projectCoordinatorStatus(input: CoordinatorStatusInput): Promise<CoordinatorStatusProjection> {
	if (!isRecord(input) || typeof input.runtimeVersion !== "string") return recoveryProjection();
	if (!hasExactKeys(input, INPUT_KEYS)) return recoveryProjection();
	assertWorkflowRuntimeVersion(input.runtimeVersion);

	try {
		const host = input.host;
		if (
			!hasExactKeys(host, HOST_KEYS) ||
			typeof host.readAtomicSnapshot !== "function" ||
			typeof host.assertCurrent !== "function" ||
			typeof host.resolvePendingDecision !== "function" ||
			!isRecord(host.principalAuthorizer) ||
			typeof host.principalAuthorizer.authorize !== "function"
		)
			return recoveryProjection();
		const snapshot = parseAtomicSnapshot(await host.readAtomicSnapshot());
		if (snapshot === null) return recoveryProjection();
		const frozenCurrent = Object.freeze(snapshot.current);
		const pendingDecision = parsePendingDecision(
			await host.resolvePendingDecision({ current: frozenCurrent, payloadDigest: snapshot.evidence.payloadDigest }),
			frozenCurrent,
			snapshot.evidence.payloadDigest,
		);
		if (pendingDecision === undefined) return recoveryProjection();
		if (pendingDecision !== null) {
			const bindingDigest = pendingDecisionBindingDigest(
				frozenCurrent,
				snapshot.evidence.payloadDigest,
				pendingDecision,
			);
			const authorization = await host.principalAuthorizer.authorize({
				receipt: pendingDecision.receipt,
				workflowId: frozenCurrent.workflowId,
				bindingDigest,
				resourceDigest: pendingDecision.registryMembershipDigest,
				operationDigest: pendingDecision.decisionDigest,
				stateDigest: frozenCurrent.journalHeadDigest,
				revision: frozenCurrent.revision,
				epochRef: {
					storeEpoch: frozenCurrent.storeEpoch,
					coordinatorEpoch: frozenCurrent.coordinatorEpoch,
				},
				capability: pendingDecision.capability,
				...(pendingDecision.receipt.capabilityBinding?.executionIdentity === null
					? {}
					: { executionIdentity: pendingDecision.receipt.capabilityBinding?.executionIdentity }),
				...(pendingDecision.receipt.capabilityBinding?.sessionId === null
					? {}
					: { sessionId: pendingDecision.receipt.capabilityBinding?.sessionId }),
			});
			if (
				!isPendingDecisionAuthorization(
					authorization,
					frozenCurrent,
					snapshot.evidence.payloadDigest,
					pendingDecision,
				)
			)
				return recoveryProjection();
		}
		const currentAssertion: unknown = await host.assertCurrent({
			current: frozenCurrent,
			payloadDigest: snapshot.evidence.payloadDigest,
		});
		if (currentAssertion !== undefined && currentAssertion !== true) return recoveryProjection();
		return projectPayload(snapshot.evidence.payload, pendingDecision);
	} catch {
		return recoveryProjection();
	}
}

export type CoordinatorStatusProjector = (
	input: CoordinatorStatusProjectionRequest,
) => Promise<CoordinatorStatusProjection>;

/**
 * Bind one host-owned status adapter to the public projection request.
 *
 * Args:
 * host: Host adapter that reads/asserts a current generation fence and resolves canonical decisions.
 * Return: A runtime-versioned coordinator status projector.
 */
export function createCoordinatorStatusProjector(host: CoordinatorStatusHostAdapter): CoordinatorStatusProjector {
	return (input) => projectCoordinatorStatus({ runtimeVersion: input.runtimeVersion, host });
}
