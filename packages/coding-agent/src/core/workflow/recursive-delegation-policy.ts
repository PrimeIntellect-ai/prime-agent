import {
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { parseWorkflowCanonicalPath } from "./task-graph.js";

/** Scalar and host-control dimensions reserved by one nested child. */
export const RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS = [
	"cpuMilliCores",
	"memoryBytes",
	"diskBytes",
	"ioWeight",
	"networkEgressBytes",
	"wallMilliseconds",
	"monetaryMicrounits",
	"processSlots",
	"childSessionSlots",
	"modelCallSlots",
	"modelInputTokens",
	"modelOutputTokens",
	"verificationSlots",
	"redTeamSlots",
	"recoverySlots",
] as const;

export type RecursiveDelegationResourceDimension = (typeof RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS)[number];
export type RecursiveDelegationResourceVector = Readonly<Record<RecursiveDelegationResourceDimension, number>>;
export type RecursiveDelegationOwnership = "read_only" | "write_set";
export type RecursiveDelegationWorkClass = "substantive" | "easy" | "microtask";
export type RecursiveDelegationChildStatus = "pending" | "completed" | "failed";

export interface RecursiveDelegationPathProof {
	readonly declaredPath: string;
	readonly canonicalPath: string;
	readonly realPath: string;
	readonly caseFoldedRealPath: string;
	readonly symlinkResolved: true;
	readonly caseResolved: true;
	readonly proofDigest: string;
}

export interface RecursiveDelegationVerification {
	readonly criterion: string;
	readonly verified: boolean;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly verifierDigest: string;
}

export interface RecursiveDelegationEstimateEvidence {
	readonly estimatedCriticalPathSavedWallMilliseconds: number;
	readonly contextTransferWallMilliseconds: number;
	readonly reviewWallMilliseconds: number;
	readonly mergeConflictWallMilliseconds: number;
	readonly computeWallMilliseconds: number;
	readonly computeCostMicrounits: number;
	readonly childWallMilliseconds: number;
	readonly queueWaitWallMilliseconds: number;
	readonly verified: boolean;
	readonly maxVerifiedCriticalPathSavedWallMilliseconds: number;
	readonly maxVerifiedComputeCostMicrounits: number;
	readonly maxVerifiedResourceReservation: RecursiveDelegationResourceVector;
	readonly evidenceRef: WorkflowArtifactRef;
}

export interface RecursiveDelegationBlockerAssessment {
	readonly complete: boolean;
	readonly blockers: readonly string[];
}

export interface RecursiveDelegationModelBinding {
	readonly provider: string;
	readonly model: string;
	readonly reasoning: string;
	readonly allowFallback: false;
}

/**
 * Candidate facts are worker-submitted identities and requests. Cost, resource,
 * actionability, and output evidence are never trusted from this object.
 */
export interface RecursiveDelegationCandidate {
	readonly childId: string;
	readonly taskId: string;
	readonly workKey: string;
	readonly scopeId: string;
	readonly atomicGroupId: string | null;
	readonly dependencyTaskIds: readonly string[];
	readonly objective: string;
	readonly ownership: RecursiveDelegationOwnership;
	readonly readSet: readonly string[];
	readonly writeSet: readonly string[];
	readonly pathProofs: readonly RecursiveDelegationPathProof[];
	readonly independentVerification: RecursiveDelegationVerification;
	readonly estimates: RecursiveDelegationEstimateEvidence;
	readonly resourceReservation: RecursiveDelegationResourceVector;
	readonly usefulVerifiedCompletionUnits: number;
	readonly relevance: "required" | "relevant" | "irrelevant";
	readonly workClass: RecursiveDelegationWorkClass;
	readonly blockerAssessment: RecursiveDelegationBlockerAssessment;
	readonly actionable: boolean;
	readonly boundedPacketRef: WorkflowArtifactRef;
	/** Deprecated worker hint; never included in a coordinator packet. */
	readonly fullReportRef?: WorkflowArtifactRef;
}

export interface RecursiveDelegationHostEvidence {
	readonly childId: string;
	readonly taskId: string;
	readonly workKey: string;
	readonly scopeId: string;
	readonly atomicGroupId: string | null;
	readonly dependencyTaskIds: readonly string[];
	readonly objective: string;
	readonly ownership: RecursiveDelegationOwnership;
	readonly readSet: readonly string[];
	readonly writeSet: readonly string[];
	readonly pathProofs: readonly RecursiveDelegationPathProof[];
	readonly independentVerification: RecursiveDelegationVerification;
	readonly estimates: RecursiveDelegationEstimateEvidence;
	readonly resourceReservation: RecursiveDelegationResourceVector;
	readonly usefulVerifiedCompletionUnits: number;
	readonly relevance: "required" | "relevant" | "irrelevant";
	readonly workClass: RecursiveDelegationWorkClass;
	readonly blockerAssessment: RecursiveDelegationBlockerAssessment;
	readonly actionable: boolean;
	readonly boundedPacketRef: WorkflowArtifactRef;
	readonly sectionRefs: readonly WorkflowArtifactRef[];
	readonly modelBinding: RecursiveDelegationModelBinding;
}

export interface RecursiveDelegationHostGraphNode {
	readonly childId: string;
	readonly taskId: string;
	readonly workKey: string;
	readonly scopeId: string;
	readonly atomicGroupId: string | null;
	readonly dependencyTaskIds: readonly string[];
	readonly readSet: readonly string[];
	readonly writeSet: readonly string[];
	readonly pathProofs: readonly RecursiveDelegationPathProof[];
}

export interface RecursiveDelegationHostGraphAuthority {
	readonly graphRevision: number;
	readonly workspaceRootRealPath: string;
	readonly nodes: readonly RecursiveDelegationHostGraphNode[];
}

export interface RecursiveDelegationChildOutcome {
	readonly childId: string;
	readonly status: RecursiveDelegationChildStatus;
	readonly reason?: string;
	readonly outputDigest: string;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	/** Host-authenticated resource-ledger revision that witnessed this outcome. */
	readonly ledgerDigest: string;
	/** Bounded artifact-backed reason/evidence packet; full reports never cross this boundary. */
	readonly boundedPacketRef: WorkflowArtifactRef;
}

export interface RecursiveDelegationLimits {
	readonly maxDepth: number;
	readonly maxFanout: number;
	readonly maxCandidates: number;
	readonly maxPacketBytes: number;
	readonly minUsefulVerifiedCompletionUnits: number;
	readonly minUsefulCompletionPerWallMillisecond: number;
	readonly diminishingReturnsFactor: number;
	readonly maxChildReservation: RecursiveDelegationResourceVector;
	readonly maxChildCostMicrounits: number;
}

export interface RecursiveDelegationHostCeilings extends RecursiveDelegationLimits {
	readonly maxPacketRefs: number;
}

export interface RecursiveDelegationAdaptiveOption {
	readonly enabled?: boolean;
	/** Caller hints are advisory only and are clamped by host ceilings. */
	readonly limits?: Partial<RecursiveDelegationLimits>;
}

export interface RecursiveDelegationBudget {
	readonly capacity: RecursiveDelegationResourceVector;
	readonly inUse: RecursiveDelegationResourceVector;
	readonly verifierReserve: RecursiveDelegationResourceVector;
	readonly controlReserve: RecursiveDelegationResourceVector;
	readonly urgentRecoveryReserve: RecursiveDelegationResourceVector;
}

export interface RecursiveDelegationCurrentState {
	readonly workflowId: string;
	readonly stateDigest: string;
	readonly revision: number;
	readonly epochRef: WorkflowEpochRef;
	readonly resourceLedgerDigest: string;
	readonly graphRevision: number;
	readonly selectedChildIds: readonly string[];
	readonly currentChildIds: readonly string[];
	readonly completedTaskIds: readonly string[];
}

export interface RecursiveDelegationSynthesisObligation {
	readonly l1OwnerId: string;
	readonly contradictionVerifierChildId: string;
	readonly contradictionCheckRequired: true;
	readonly acceptanceCriteria: string;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly obligationDigest: string;
}

export interface RecursiveDelegationHostComposition {
	/**
	 * This context is supplied by persisted production composition. The token is
	 * intentionally unknown here; only the canonical receipt resolver can verify it.
	 */
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly authorizationToken: unknown;
	readonly trustedNow: string;
	readonly currentStateDigest: string;
	readonly currentRevision: number;
	readonly epochRef: WorkflowEpochRef;
	readonly executionIdentity?: string;
	readonly sessionId?: string;
	readonly ceilings: RecursiveDelegationHostCeilings;
	readonly budget: RecursiveDelegationBudget;
	readonly hostEvidence: readonly RecursiveDelegationHostEvidence[];
	readonly graphAuthority: RecursiveDelegationHostGraphAuthority;
	readonly currentState: RecursiveDelegationCurrentState;
	readonly workerModelBinding?: RecursiveDelegationModelBinding;
	readonly synthesisObligation: RecursiveDelegationSynthesisObligation;
	/**
	 * The runtime owns one CAS-bound durable transaction for reservation, urgent
	 * escalation, and release. The planner never calls a worker or model provider.
	 */
	readonly persistIntentBatch?: (batch: RecursiveDelegationDurableIntentBatch) => Promise<void>;
}

export interface RecursiveDelegationPolicyInput {
	readonly workflowId: string;
	readonly workerId: string;
	readonly coordinatorId: string;
	readonly workerDepth: number;
	readonly adaptive?: RecursiveDelegationAdaptiveOption;
	/** Caller accounting is diagnostic only; the host composition budget controls admission. */
	readonly budgets: RecursiveDelegationBudget;
	readonly coordinatorPacketRef: WorkflowArtifactRef;
	readonly candidates: readonly RecursiveDelegationCandidate[];
	readonly childOutcomes?: readonly RecursiveDelegationChildOutcome[];
}

export type RecursiveDelegationEvidenceInput = RecursiveDelegationPolicyInput;

export type RecursiveDelegationDenialReason =
	| "adaptive_option_disabled"
	| "invalid_depth"
	| "depth_limit"
	| "fanout_limit"
	| "candidate_limit"
	| "protected_reserve"
	| "not_bounded"
	| "not_independently_verifiable"
	| "missing_path_proof"
	| "canonical_path_conflict"
	| "ownership_conflict"
	| "write_set_conflict"
	| "duplicate_child"
	| "duplicate_work"
	| "duplicate_scope"
	| "atomic_group_conflict"
	| "dependency_mismatch"
	| "host_graph_mismatch"
	| "host_evidence_missing"
	| "host_path_outside_workspace"
	| "unverified_estimate"
	| "forged_estimate"
	| "resource_limit"
	| "session_slot_required"
	| "nonpositive_benefit"
	| "not_useful"
	| "irrelevant_microtask"
	| "omitted_blocker"
	| "no_actionable_output"
	| "packet_limit"
	| "blocked_model_capability"
	| "synthesis_obligation_missing"
	| "stale_failure"
	| "failure_dependency_unmet";

export interface RecursiveDelegationAuthorizationRequirements {
	readonly capability: "workflow_recursive_delegation_plan";
	readonly workflowId: string;
	readonly operationDigest: string;
	readonly resourceDigest: string;
	readonly requiresHostPrincipalAuthorization: true;
}

export interface RecursiveDelegationAuthorizationSummary {
	readonly authenticatedPrincipal: string;
	readonly keyOwnerPrincipal: string;
	readonly capability: "workflow_recursive_delegation_plan";
	readonly authorizationDigest: string;
	readonly receiptId: string;
	readonly oneUse: boolean;
	readonly consumptionWitness: WorkflowHostReceiptConsumptionWitness | null;
}

export interface RecursiveDelegationChildPlan {
	readonly childId: string;
	readonly taskId: string;
	readonly scopeId: string;
	readonly atomicGroupId: string | null;
	readonly dependencyTaskIds: readonly string[];
	readonly ownership: RecursiveDelegationOwnership;
	readonly readSet: readonly string[];
	readonly writeSet: readonly string[];
	readonly childDepth: number;
	readonly resourceReservation: RecursiveDelegationResourceVector;
	readonly netBenefitWallMilliseconds: number;
	readonly throughputPerWallMillisecond: number;
	readonly boundedPacketRef: WorkflowArtifactRef;
	readonly sectionRefs: readonly WorkflowArtifactRef[];
	readonly artifactRefs: readonly WorkflowArtifactRef[];
	readonly modelBinding: RecursiveDelegationModelBinding;
}

export interface RecursiveDelegationDeniedCandidate {
	readonly childId: string;
	readonly reasons: readonly RecursiveDelegationDenialReason[];
}

export interface RecursiveDelegationResourceReservation {
	readonly childId: string;
	readonly resourceReservation: RecursiveDelegationResourceVector;
}

export interface RecursiveDelegationModeledCriticalPath {
	readonly serialWallMilliseconds: number;
	readonly parallelWallMilliseconds: number;
	readonly savedWallMilliseconds: number;
	readonly queueWaitWallMilliseconds: number;
}

export interface RecursiveDelegationCoordinatorPacket {
	readonly ref: WorkflowArtifactRef;
	readonly digest: string;
	readonly bounded: true;
	readonly childArtifactRefs: readonly WorkflowArtifactRef[];
	readonly boundedPacketRefs: readonly { readonly childId: string; readonly ref: WorkflowArtifactRef }[];
	readonly sectionRefs: readonly { readonly childId: string; readonly refs: readonly WorkflowArtifactRef[] }[];
	readonly blockers: readonly { readonly childId: string; readonly blockers: readonly string[] }[];
	readonly totalRefs: number;
	readonly totalBytes: number;
	readonly fullReportsTransmitted: false;
}

export interface RecursiveDelegationReleaseIntent {
	readonly kind: "recursive_delegation_release";
	readonly durable: true;
	readonly workflowId: string;
	readonly workerId: string;
	readonly coordinatorId: string;
	readonly childId: string;
	readonly reservationDigest: string;
	readonly expectedStateDigest: string;
	readonly expectedRevision: number;
	readonly expectedEpochRef: WorkflowEpochRef;
	readonly expectedGraphRevision: number;
	readonly expectedResourceLedgerDigest: string;
}

export interface RecursiveDelegationEscalationIntent {
	readonly kind: "urgent_nested_failure";
	readonly durable: true;
	readonly audiences: readonly [string, string];
	readonly childId: string;
	readonly reason: string;
	readonly outputDigest: string;
	readonly siblingPolicy: "continue";
	readonly continueSiblingIds: readonly string[];
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly boundedPacketRef: WorkflowArtifactRef;
	readonly releaseIntent: RecursiveDelegationReleaseIntent;
}

export interface RecursiveDelegationReservationCommitIntent {
	readonly kind: "recursive_delegation_reservation_commit";
	readonly durable: true;
	readonly commitRequired: true;
	readonly workflowId: string;
	readonly workerId: string;
	readonly coordinatorId: string;
	readonly childIds: readonly string[];
	readonly reservations: readonly RecursiveDelegationResourceReservation[];
	readonly reservationDigest: string;
	readonly expectedStateDigest: string;
	readonly expectedRevision: number;
	readonly expectedEpochRef: WorkflowEpochRef;
	readonly expectedGraphRevision: number;
	readonly expectedResourceLedgerDigest: string;
}

export interface RecursiveDelegationDurableIntentBatch {
	readonly kind: "recursive_delegation_intent_batch";
	readonly durable: true;
	readonly workflowId: string;
	readonly workerId: string;
	readonly coordinatorId: string;
	readonly reservationIntent: RecursiveDelegationReservationCommitIntent | null;
	readonly escalationIntents: readonly RecursiveDelegationEscalationIntent[];
	readonly expectedStateDigest: string;
	readonly expectedRevision: number;
	readonly expectedEpochRef: WorkflowEpochRef;
	readonly expectedGraphRevision: number;
	readonly expectedResourceLedgerDigest: string;
	readonly batchDigest: string;
}

export interface RecursiveDelegationIntegrationRequirement {
	readonly adapter: "planAdaptiveRecursiveDelegationFromHost";
	readonly persistIntentBatch: true;
	readonly contractChange: "CONTRACT_CHANGE: task runtime must invoke this host adapter and persist one CAS-bound reservation/escalation/release intent batch.";
}

export interface RecursiveDelegationParentAcceptanceObligation {
	readonly required: true;
	readonly integrationOwner: string;
	readonly contextOwner: string;
	readonly acceptanceOwner: string;
	readonly obligationDigest: string;
}

export interface RecursiveDelegationPolicyResult {
	readonly status: "admitted" | "denied";
	readonly limits: RecursiveDelegationLimits;
	readonly selectedChildren: readonly RecursiveDelegationChildPlan[];
	readonly deniedCandidates: readonly RecursiveDelegationDeniedCandidate[];
	readonly denialReasons: readonly RecursiveDelegationDenialReason[];
	readonly childDepth: number;
	readonly resourceReservations: readonly RecursiveDelegationResourceReservation[];
	readonly remainingResources: RecursiveDelegationResourceVector;
	readonly modeledCriticalPath: RecursiveDelegationModeledCriticalPath;
	readonly parentAccountability: {
		readonly integrationOwner: string;
		readonly contextOwner: string;
		readonly coordinatorId: string;
	};
	readonly parentAcceptanceObligation: RecursiveDelegationParentAcceptanceObligation;
	readonly coordinatorPacket: RecursiveDelegationCoordinatorPacket;
	readonly escalationIntents: readonly RecursiveDelegationEscalationIntent[];
	readonly completionDelivery: "checkpoint_batched";
	readonly authorizationRequirements: RecursiveDelegationAuthorizationRequirements;
	readonly authorization: RecursiveDelegationAuthorizationSummary | null;
	readonly workerModelBinding: RecursiveDelegationModelBinding | null;
	readonly synthesisObligation: RecursiveDelegationSynthesisObligation;
	readonly reservationIntent: RecursiveDelegationReservationCommitIntent | null;
	readonly durableIntentBatch: RecursiveDelegationDurableIntentBatch | null;
	readonly integrationRequirement: RecursiveDelegationIntegrationRequirement;
	readonly planDigest: string;
}

const DEFAULT_OPERATION = "recursive-delegation";
const INTEGRATION_REQUIREMENT: RecursiveDelegationIntegrationRequirement = Object.freeze({
	adapter: "planAdaptiveRecursiveDelegationFromHost",
	persistIntentBatch: true,
	contractChange:
		"CONTRACT_CHANGE: task runtime must invoke this host adapter and persist one CAS-bound reservation/escalation/release intent batch.",
});

const MAX_FAILURE_REASON_BYTES = 2_048;
const MAX_BLOCKER_ID_BYTES = 256;

const DENIAL_REASON_ORDER: readonly RecursiveDelegationDenialReason[] = [
	"adaptive_option_disabled",
	"invalid_depth",
	"depth_limit",
	"fanout_limit",
	"candidate_limit",
	"protected_reserve",
	"not_bounded",
	"not_independently_verifiable",
	"missing_path_proof",
	"canonical_path_conflict",
	"ownership_conflict",
	"write_set_conflict",
	"duplicate_child",
	"duplicate_work",
	"duplicate_scope",
	"atomic_group_conflict",
	"dependency_mismatch",
	"host_graph_mismatch",
	"host_evidence_missing",
	"host_path_outside_workspace",
	"unverified_estimate",
	"forged_estimate",
	"resource_limit",
	"session_slot_required",
	"nonpositive_benefit",
	"not_useful",
	"irrelevant_microtask",
	"omitted_blocker",
	"no_actionable_output",
	"packet_limit",
	"blocked_model_capability",
	"synthesis_obligation_missing",
	"stale_failure",
	"failure_dependency_unmet",
];

function compareCodePointStrings(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
	const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < sharedLength; index += 1) {
		if (leftCodePoints[index] !== rightCodePoints[index]) return leftCodePoints[index] - rightCodePoints[index];
	}
	return leftCodePoints.length - rightCodePoints.length;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stringByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertClosedKeys(value: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
	const allowed = new Set(allowedKeys);
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${label} contains unknown fields.`);
}

function deepFreeze(value: unknown, seen = new Set<object>()): void {
	if (typeof value !== "object" || value === null || seen.has(value)) return;
	seen.add(value);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	Object.freeze(value);
}

function immutableSnapshot<T>(value: T): T {
	let snapshot: T;
	try {
		snapshot = structuredClone(value);
	} catch {
		throw new Error("CONTRACT_CHANGE: recursive delegation evidence must be a cloneable host snapshot.");
	}
	deepFreeze(snapshot);
	return snapshot;
}

function freezeResourceVector(vector: RecursiveDelegationResourceVector): RecursiveDelegationResourceVector {
	return Object.freeze({ ...vector });
}

function zeroResourceVector(): RecursiveDelegationResourceVector {
	return Object.freeze(
		Object.fromEntries(RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS.map((dimension) => [dimension, 0])) as Record<
			RecursiveDelegationResourceDimension,
			number
		>,
	);
}

function addResources(
	left: RecursiveDelegationResourceVector,
	right: RecursiveDelegationResourceVector,
): RecursiveDelegationResourceVector {
	return freezeResourceVector(
		Object.fromEntries(
			RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS.map((dimension) => [dimension, left[dimension] + right[dimension]]),
		) as Record<RecursiveDelegationResourceDimension, number>,
	);
}

function subtractResources(
	left: RecursiveDelegationResourceVector,
	right: RecursiveDelegationResourceVector,
): RecursiveDelegationResourceVector {
	return freezeResourceVector(
		Object.fromEntries(
			RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS.map((dimension) => [dimension, left[dimension] - right[dimension]]),
		) as Record<RecursiveDelegationResourceDimension, number>,
	);
}

function resourceFits(
	requested: RecursiveDelegationResourceVector,
	available: RecursiveDelegationResourceVector,
): boolean {
	return RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS.every((dimension) => requested[dimension] <= available[dimension]);
}

function resourceIsZero(vector: RecursiveDelegationResourceVector): boolean {
	return RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS.every((dimension) => vector[dimension] === 0);
}

function protectedReservation(budget: RecursiveDelegationBudget): RecursiveDelegationResourceVector {
	return addResources(
		addResources(budget.inUse, budget.verifierReserve),
		addResources(budget.controlReserve, budget.urgentRecoveryReserve),
	);
}

function availableAfterProtectedReserve(budget: RecursiveDelegationBudget): RecursiveDelegationResourceVector {
	const available = subtractResources(budget.capacity, protectedReservation(budget));
	return RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS.every((dimension) => available[dimension] >= 0)
		? available
		: zeroResourceVector();
}

function assertResourceVector(value: unknown, label: string): asserts value is RecursiveDelegationResourceVector {
	if (!isRecord(value)) throw new Error(`${label} is invalid.`);
	assertClosedKeys(value, RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS, label);
	for (const dimension of RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS) {
		if (!isSafeNonNegativeInteger(value[dimension])) throw new Error(`${label}.${dimension} is invalid.`);
	}
}

function assertDigest(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} is invalid.`);
}

function assertArtifactRef(value: unknown, label: string): asserts value is WorkflowArtifactRef {
	try {
		if (!isRecord(value)) throw new Error(`${label} is invalid.`);
		assertClosedKeys(value, ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"], label);
		for (const key of ["artifactId", "relativePath"] as const) {
			if (typeof value[key] !== "string" || value[key].length === 0) throw new Error(`${label}.${key} is invalid.`);
		}
		assertDigest(value.digest, `${label}.digest`);
		if (
			typeof value.relativePath !== "string" ||
			value.relativePath.startsWith("/") ||
			value.relativePath.includes("\\") ||
			value.relativePath.includes("//") ||
			value.relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
		)
			throw new Error(`${label}.relativePath is invalid.`);
		if (!isSafeNonNegativeInteger(value.sizeBytes)) throw new Error(`${label}.sizeBytes is invalid.`);
		if (!isSafeNonNegativeInteger(value.sourceEventSequence) || value.sourceEventSequence === 0)
			throw new Error(`${label}.sourceEventSequence is invalid.`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("CONTRACT_CHANGE:")) throw error;
		throw new Error(`CONTRACT_CHANGE: ${label} is invalid.`, { cause: error });
	}
}

function freezeArtifactRef(ref: WorkflowArtifactRef): WorkflowArtifactRef {
	return Object.freeze({ ...ref });
}

function artifactPreimage(ref: WorkflowArtifactRef): WorkflowArtifactRef {
	return {
		artifactId: ref.artifactId,
		relativePath: ref.relativePath,
		digest: ref.digest,
		sizeBytes: ref.sizeBytes,
		sourceEventSequence: ref.sourceEventSequence,
	};
}

function normalizeStringSet(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0))
		throw new Error(`${label} is invalid.`);
	const unique = [...new Set(value)];
	return Object.freeze(unique.sort(compareCodePointStrings));
}

function normalizeBlockers(value: unknown, label: string): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((item) => typeof item !== "string" || item.length === 0)
	)
		throw new Error(`${label} is invalid.`);
	if (new Set(value).size !== value.length || value.some((item) => stringByteLength(item) > MAX_BLOCKER_ID_BYTES))
		throw new Error(`${label} is invalid.`);
	return Object.freeze([...value].sort(compareCodePointStrings));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	const leftNormalized = [...left].sort(compareCodePointStrings);
	const rightNormalized = [...right].sort(compareCodePointStrings);
	return (
		leftNormalized.length === rightNormalized.length &&
		leftNormalized.every((value, index) => value === rightNormalized[index])
	);
}

function sameProofs(
	left: readonly RecursiveDelegationPathProof[],
	right: readonly RecursiveDelegationPathProof[],
): boolean {
	const key = (proof: RecursiveDelegationPathProof): string =>
		[
			proof.declaredPath,
			proof.canonicalPath,
			proof.realPath,
			proof.caseFoldedRealPath,
			proof.symlinkResolved,
			proof.caseResolved,
			proof.proofDigest,
		].join("\u0000");
	const leftKeys = left.map(key).sort(compareCodePointStrings);
	const rightKeys = right.map(key).sort(compareCodePointStrings);
	return leftKeys.length === rightKeys.length && leftKeys.every((value, index) => value === rightKeys[index]);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function normalizeBudget(input: RecursiveDelegationBudget): RecursiveDelegationBudget {
	assertResourceVector(input.capacity, "budget.capacity");
	assertResourceVector(input.inUse, "budget.inUse");
	assertResourceVector(input.verifierReserve, "budget.verifierReserve");
	assertResourceVector(input.controlReserve, "budget.controlReserve");
	assertResourceVector(input.urgentRecoveryReserve, "budget.urgentRecoveryReserve");
	return Object.freeze({
		capacity: freezeResourceVector(input.capacity),
		inUse: freezeResourceVector(input.inUse),
		verifierReserve: freezeResourceVector(input.verifierReserve),
		controlReserve: freezeResourceVector(input.controlReserve),
		urgentRecoveryReserve: freezeResourceVector(input.urgentRecoveryReserve),
	});
}

function normalizeCeilings(input: RecursiveDelegationHostCeilings): RecursiveDelegationHostCeilings {
	assertResourceVector(input.maxChildReservation, "host ceilings.maxChildReservation");
	if (
		!isSafeNonNegativeInteger(input.maxDepth) ||
		!isSafeNonNegativeInteger(input.maxFanout) ||
		!isSafeNonNegativeInteger(input.maxCandidates) ||
		!isSafeNonNegativeInteger(input.maxPacketBytes) ||
		!isSafeNonNegativeInteger(input.maxPacketRefs) ||
		!isFiniteNonNegativeNumber(input.minUsefulVerifiedCompletionUnits) ||
		!isFiniteNonNegativeNumber(input.minUsefulCompletionPerWallMillisecond) ||
		!isFiniteNonNegativeNumber(input.diminishingReturnsFactor) ||
		!isFiniteNonNegativeNumber(input.maxChildCostMicrounits) ||
		input.diminishingReturnsFactor > 1
	)
		throw new Error("CONTRACT_CHANGE: host recursive delegation ceilings are invalid.");
	return Object.freeze({
		...input,
		maxChildReservation: freezeResourceVector(input.maxChildReservation),
	});
}

function isValidModelBinding(value: unknown): value is RecursiveDelegationModelBinding {
	return (
		isRecord(value) &&
		typeof value.provider === "string" &&
		value.provider.length > 0 &&
		typeof value.model === "string" &&
		value.model.length > 0 &&
		typeof value.reasoning === "string" &&
		value.reasoning.length > 0 &&
		value.allowFallback === false
	);
}

function clampLimits(
	requested: Partial<RecursiveDelegationLimits> | undefined,
	host: RecursiveDelegationHostCeilings,
): RecursiveDelegationLimits {
	const requestedMaxReservation = requested?.maxChildReservation;
	if (requestedMaxReservation !== undefined)
		assertResourceVector(requestedMaxReservation, "requested maxChildReservation");
	const maxChildReservation = requestedMaxReservation
		? freezeResourceVector(
				Object.fromEntries(
					RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS.map((dimension) => [
						dimension,
						Math.min(requestedMaxReservation[dimension], host.maxChildReservation[dimension]),
					]),
				) as Record<RecursiveDelegationResourceDimension, number>,
			)
		: host.maxChildReservation;
	return Object.freeze({
		maxDepth: host.maxDepth,
		maxFanout: host.maxFanout,
		maxCandidates: host.maxCandidates,
		maxPacketBytes: host.maxPacketBytes,
		minUsefulVerifiedCompletionUnits: host.minUsefulVerifiedCompletionUnits,
		minUsefulCompletionPerWallMillisecond: host.minUsefulCompletionPerWallMillisecond,
		diminishingReturnsFactor: host.diminishingReturnsFactor,
		maxChildReservation,
		maxChildCostMicrounits: host.maxChildCostMicrounits,
	});
}

function proofPreimage(value: RecursiveDelegationPathProof): Omit<RecursiveDelegationPathProof, "proofDigest"> {
	return {
		declaredPath: value.declaredPath,
		canonicalPath: value.canonicalPath,
		realPath: value.realPath,
		caseFoldedRealPath: value.caseFoldedRealPath,
		symlinkResolved: value.symlinkResolved,
		caseResolved: value.caseResolved,
	};
}

function isAbsoluteResolvedPath(value: string): boolean {
	return (
		value.startsWith("/") &&
		!value.includes("\\") &&
		!value.includes("//") &&
		value.normalize("NFC") === value &&
		value
			.split("/")
			.slice(1)
			.every((part) => part.length > 0 && part !== "." && part !== "..")
	);
}

function isPathWithin(path: string, root: string): boolean {
	const pathParts = path.split("/").filter(Boolean);
	const rootParts = root.split("/").filter(Boolean);
	return rootParts.length <= pathParts.length && rootParts.every((part, index) => pathParts[index] === part);
}

function pathsOverlap(left: string, right: string): boolean {
	return isPathWithin(left, right) || isPathWithin(right, left);
}

function normalizeProofs(
	evidence: RecursiveDelegationHostEvidence,
	workspaceRoot: string,
): ReadonlyMap<string, RecursiveDelegationPathProof> {
	const expected = new Set([...evidence.readSet, ...evidence.writeSet]);
	const proofs = new Map<string, RecursiveDelegationPathProof>();
	for (const value of evidence.pathProofs) {
		if (
			!isRecord(value) ||
			typeof value.declaredPath !== "string" ||
			typeof value.canonicalPath !== "string" ||
			typeof value.realPath !== "string" ||
			typeof value.caseFoldedRealPath !== "string" ||
			value.symlinkResolved !== true ||
			value.caseResolved !== true ||
			typeof value.proofDigest !== "string"
		)
			throw new Error("path proof is invalid.");
		parseWorkflowCanonicalPath(value.declaredPath);
		if (
			!isAbsoluteResolvedPath(value.canonicalPath) ||
			!isAbsoluteResolvedPath(value.realPath) ||
			!isPathWithin(value.canonicalPath, workspaceRoot) ||
			!isPathWithin(value.realPath, workspaceRoot) ||
			value.caseFoldedRealPath !== value.realPath.toLowerCase() ||
			value.proofDigest !== digestObject(proofPreimage(value))
		)
			throw new Error("host realpath proof is not workspace-contained.");
		if (!expected.has(value.declaredPath) || proofs.has(value.declaredPath))
			throw new Error("path proof coverage is invalid.");
		proofs.set(value.declaredPath, Object.freeze({ ...value }));
	}
	if (proofs.size !== expected.size || [...expected].some((path) => !proofs.has(path)))
		throw new Error("path proof coverage is incomplete.");
	return proofs;
}

function candidatePreimage(candidate: RecursiveDelegationCandidate): Record<string, unknown> {
	return {
		childId: candidate.childId,
		taskId: candidate.taskId,
		workKey: candidate.workKey,
		scopeId: candidate.scopeId,
		atomicGroupId: candidate.atomicGroupId,
		dependencyTaskIds: [...candidate.dependencyTaskIds].sort(compareCodePointStrings),
		objective: candidate.objective,
		ownership: candidate.ownership,
		readSet: [...candidate.readSet].sort(compareCodePointStrings),
		writeSet: [...candidate.writeSet].sort(compareCodePointStrings),
		pathProofs: [...candidate.pathProofs]
			.sort((left, right) => compareCodePointStrings(left.declaredPath, right.declaredPath))
			.map((value) => ({
				...proofPreimage(value),
				proofDigest: value.proofDigest,
			})),
		independentVerification: {
			...candidate.independentVerification,
			evidenceRefs: [...candidate.independentVerification.evidenceRefs]
				.sort((left, right) => compareCodePointStrings(left.artifactId, right.artifactId))
				.map(artifactPreimage),
		},
		estimates: candidate.estimates,
		resourceReservation: candidate.resourceReservation,
		usefulVerifiedCompletionUnits: candidate.usefulVerifiedCompletionUnits,
		relevance: candidate.relevance,
		workClass: candidate.workClass,
		blockerAssessment: candidate.blockerAssessment,
		actionable: candidate.actionable,
		boundedPacketRef: candidate.boundedPacketRef,
	};
}

function hostEvidencePreimage(value: RecursiveDelegationHostEvidence): Record<string, unknown> {
	return {
		childId: value.childId,
		taskId: value.taskId,
		workKey: value.workKey,
		scopeId: value.scopeId,
		atomicGroupId: value.atomicGroupId,
		dependencyTaskIds: [...value.dependencyTaskIds].sort(compareCodePointStrings),
		objective: value.objective,
		ownership: value.ownership,
		readSet: [...value.readSet].sort(compareCodePointStrings),
		writeSet: [...value.writeSet].sort(compareCodePointStrings),
		pathProofs: [...value.pathProofs]
			.sort((left, right) => compareCodePointStrings(left.declaredPath, right.declaredPath))
			.map((proof) => ({ ...proofPreimage(proof), proofDigest: proof.proofDigest })),
		independentVerification: {
			...value.independentVerification,
			evidenceRefs: [...value.independentVerification.evidenceRefs]
				.sort((left, right) => compareCodePointStrings(left.artifactId, right.artifactId))
				.map(artifactPreimage),
		},
		estimates: value.estimates,
		resourceReservation: value.resourceReservation,
		usefulVerifiedCompletionUnits: value.usefulVerifiedCompletionUnits,
		relevance: value.relevance,
		workClass: value.workClass,
		blockerAssessment: value.blockerAssessment,
		actionable: value.actionable,
		boundedPacketRef: value.boundedPacketRef,
		sectionRefs: [...value.sectionRefs]
			.sort((left, right) => compareCodePointStrings(left.artifactId, right.artifactId))
			.map(artifactPreimage),
		modelBinding: value.modelBinding,
	};
}

function outcomePreimage(outcome: RecursiveDelegationChildOutcome): Record<string, unknown> {
	return {
		childId: outcome.childId,
		status: outcome.status,
		reason: outcome.reason ?? null,
		outputDigest: outcome.outputDigest,
		evidenceRefs: outcome.evidenceRefs.map(artifactPreimage),
		ledgerDigest: outcome.ledgerDigest,
		boundedPacketRef: artifactPreimage(outcome.boundedPacketRef),
	};
}

function evidencePreimage(input: RecursiveDelegationEvidenceInput): Record<string, unknown> {
	const budget = normalizeBudget(input.budgets);
	return {
		workflowId: input.workflowId,
		workerId: input.workerId,
		coordinatorId: input.coordinatorId,
		workerDepth: input.workerDepth,
		adaptive: {
			enabled: input.adaptive?.enabled ?? false,
			requestedLimits: input.adaptive?.limits ?? null,
		},
		budgets: budget,
		coordinatorPacketRef: input.coordinatorPacketRef,
		candidates: [...input.candidates]
			.sort((left, right) => compareCodePointStrings(left.childId, right.childId))
			.map(candidatePreimage),
		childOutcomes: [...(input.childOutcomes ?? [])]
			.sort((left, right) => compareCodePointStrings(left.childId, right.childId))
			.map(outcomePreimage),
	};
}

/**
 * Digest caller evidence for diagnostics. Admission also binds host evidence,
 * ceilings, host budget, graph, state, and synthesis obligations through the host receipt.
 */
export function digestRecursiveDelegationEvidence(input: RecursiveDelegationEvidenceInput): string {
	return digestObject(evidencePreimage(input));
}

export function digestRecursiveDelegationHostEvidence(input: {
	readonly request: RecursiveDelegationPolicyInput;
	readonly ceilings: RecursiveDelegationHostCeilings;
	readonly budget: RecursiveDelegationBudget;
	readonly hostEvidence: readonly RecursiveDelegationHostEvidence[];
	readonly graphAuthority: RecursiveDelegationHostGraphAuthority;
	readonly currentState: RecursiveDelegationCurrentState;
	readonly executionIdentity?: string;
	readonly sessionId?: string;
	readonly workerModelBinding?: RecursiveDelegationModelBinding;
	readonly synthesisObligation: RecursiveDelegationSynthesisObligation;
}): string {
	const canonicalCurrentState = {
		...input.currentState,
		selectedChildIds: [...input.currentState.selectedChildIds].sort(compareCodePointStrings),
		currentChildIds: [...input.currentState.currentChildIds].sort(compareCodePointStrings),
		completedTaskIds: [...input.currentState.completedTaskIds].sort(compareCodePointStrings),
	};
	return digestObject({
		request: evidencePreimage(input.request),
		ceilings: input.ceilings,
		budget: normalizeBudget(input.budget),
		hostEvidence: [...input.hostEvidence]
			.sort((left, right) => compareCodePointStrings(left.childId, right.childId))
			.map(hostEvidencePreimage),
		graphAuthority: {
			graphRevision: input.graphAuthority.graphRevision,
			workspaceRootRealPath: input.graphAuthority.workspaceRootRealPath,
			nodes: [...input.graphAuthority.nodes]
				.sort((left, right) => compareCodePointStrings(left.childId, right.childId))
				.map((node) => ({
					...node,
					dependencyTaskIds: [...node.dependencyTaskIds].sort(compareCodePointStrings),
					readSet: [...node.readSet].sort(compareCodePointStrings),
					writeSet: [...node.writeSet].sort(compareCodePointStrings),
					pathProofs: [...node.pathProofs]
						.sort((left, right) => compareCodePointStrings(left.declaredPath, right.declaredPath))
						.map((proof) => ({ ...proofPreimage(proof), proofDigest: proof.proofDigest })),
				})),
		},
		currentState: canonicalCurrentState,
		executionIdentity: input.executionIdentity ?? null,
		sessionId: input.sessionId ?? null,
		workerModelBinding: input.workerModelBinding ?? null,
		synthesisObligation: {
			...input.synthesisObligation,
			evidenceRefs: [...input.synthesisObligation.evidenceRefs]
				.sort((left, right) => compareCodePointStrings(left.artifactId, right.artifactId))
				.map(artifactPreimage),
		},
	});
}

function orderReasons(reasons: readonly RecursiveDelegationDenialReason[]): readonly RecursiveDelegationDenialReason[] {
	return Object.freeze(
		[...new Set(reasons)].sort(
			(left, right) => DENIAL_REASON_ORDER.indexOf(left) - DENIAL_REASON_ORDER.indexOf(right),
		),
	);
}

function uniqueArtifactRefs(refs: readonly WorkflowArtifactRef[]): readonly WorkflowArtifactRef[] {
	const byArtifactId = new Map<string, WorkflowArtifactRef>();
	for (const value of refs) {
		assertArtifactRef(value, "host artifact");
		const prior = byArtifactId.get(value.artifactId);
		if (
			prior !== undefined &&
			(prior.digest !== value.digest ||
				prior.relativePath !== value.relativePath ||
				prior.sizeBytes !== value.sizeBytes ||
				prior.sourceEventSequence !== value.sourceEventSequence)
		)
			throw new Error("CONTRACT_CHANGE: artifact identity has conflicting metadata.");
		byArtifactId.set(value.artifactId, value);
	}
	return Object.freeze(
		[...byArtifactId.values()]
			.sort((left, right) =>
				compareCodePointStrings(
					`${left.artifactId}\u0000${left.digest}\u0000${left.relativePath}\u0000${left.sizeBytes}\u0000${left.sourceEventSequence}`,
					`${right.artifactId}\u0000${right.digest}\u0000${right.relativePath}\u0000${right.sizeBytes}\u0000${right.sourceEventSequence}`,
				),
			)
			.map(freezeArtifactRef),
	);
}

function duplicateReasonMap(
	candidates: readonly RecursiveDelegationCandidate[],
): Map<string, RecursiveDelegationDenialReason[]> {
	const result = new Map<string, RecursiveDelegationDenialReason[]>();
	const addDuplicates = (
		selector: (candidate: RecursiveDelegationCandidate) => string,
		reason: RecursiveDelegationDenialReason,
	): void => {
		const groups = new Map<string, string[]>();
		for (const candidate of candidates) {
			const key = selector(candidate);
			const members = groups.get(key) ?? [];
			members.push(candidate.childId);
			groups.set(key, members);
		}
		for (const members of groups.values()) {
			if (members.length < 2) continue;
			for (const childId of members) result.set(childId, [...(result.get(childId) ?? []), reason]);
		}
	};
	addDuplicates((candidate) => candidate.childId, "duplicate_child");
	addDuplicates((candidate) => candidate.workKey, "duplicate_work");
	addDuplicates((candidate) => candidate.scopeId, "duplicate_scope");
	return result;
}

interface NormalizedCandidate {
	readonly candidate: RecursiveDelegationCandidate;
	readonly evidence: RecursiveDelegationHostEvidence;
	readonly graphNode: RecursiveDelegationHostGraphNode;
	readonly readSet: readonly string[];
	readonly writeSet: readonly string[];
	readonly pathIdentities: ReadonlyMap<string, string>;
	readonly rawBenefitWallMilliseconds: number;
	readonly throughputPerWallMillisecond: number;
}

interface CandidateAssessment {
	readonly normalized: NormalizedCandidate | null;
	readonly reasons: readonly RecursiveDelegationDenialReason[];
}

function assessment(
	candidate: RecursiveDelegationCandidate,
	evidence: RecursiveDelegationHostEvidence | undefined,
	graphNode: RecursiveDelegationHostGraphNode | undefined,
	workspaceRoot: string,
	limits: RecursiveDelegationLimits,
	completedTaskIds: ReadonlySet<string>,
	allowUnresolvedDependencies: boolean,
): CandidateAssessment {
	const fail = (reason: RecursiveDelegationDenialReason): CandidateAssessment => ({
		normalized: null,
		reasons: [reason],
	});
	if (evidence === undefined) return fail("host_evidence_missing");
	if (graphNode === undefined) return fail("host_graph_mismatch");
	if (typeof evidence.objective !== "string" || evidence.objective.length === 0) return fail("not_bounded");
	if (
		candidate.childId !== evidence.childId ||
		evidence.taskId !== graphNode.taskId ||
		evidence.workKey !== graphNode.workKey ||
		evidence.scopeId !== graphNode.scopeId ||
		evidence.atomicGroupId !== graphNode.atomicGroupId ||
		candidate.taskId !== graphNode.taskId ||
		candidate.workKey !== graphNode.workKey ||
		candidate.scopeId !== graphNode.scopeId ||
		candidate.atomicGroupId !== graphNode.atomicGroupId ||
		!sameStrings(candidate.dependencyTaskIds, graphNode.dependencyTaskIds) ||
		!sameStrings(evidence.dependencyTaskIds, graphNode.dependencyTaskIds) ||
		!sameStrings(evidence.readSet, graphNode.readSet) ||
		!sameStrings(evidence.writeSet, graphNode.writeSet) ||
		!sameProofs(evidence.pathProofs, graphNode.pathProofs)
	)
		return fail("host_graph_mismatch");
	if (
		!allowUnresolvedDependencies &&
		evidence.dependencyTaskIds.some((dependency) => !completedTaskIds.has(dependency))
	)
		return fail("dependency_mismatch");
	if (evidence.ownership === "read_only" && evidence.writeSet.length > 0) return fail("ownership_conflict");
	if (evidence.ownership === "write_set" && evidence.writeSet.length === 0) return fail("ownership_conflict");
	if (evidence.ownership !== "read_only" && evidence.ownership !== "write_set") return fail("ownership_conflict");
	if (evidence.relevance === "irrelevant" || evidence.workClass !== "substantive") return fail("irrelevant_microtask");
	if (
		!isRecord(evidence.blockerAssessment) ||
		evidence.blockerAssessment.complete !== true ||
		!Array.isArray(evidence.blockerAssessment.blockers)
	)
		return fail("omitted_blocker");
	try {
		normalizeBlockers(evidence.blockerAssessment.blockers, "host blockers");
	} catch {
		return fail("omitted_blocker");
	}
	if (evidence.actionable !== true || resourceIsZero(evidence.resourceReservation))
		return fail("no_actionable_output");
	if (
		evidence.independentVerification.verified !== true ||
		evidence.independentVerification.criterion.length === 0 ||
		evidence.independentVerification.evidenceRefs.length === 0 ||
		evidence.independentVerification.verifierDigest.length === 0
	)
		return fail("not_independently_verifiable");
	if (!isValidModelBinding(evidence.modelBinding)) return fail("blocked_model_capability");
	if (evidence.estimates.verified !== true) return fail("unverified_estimate");
	try {
		assertResourceVector(evidence.resourceReservation, "host resourceReservation");
		assertResourceVector(evidence.estimates.maxVerifiedResourceReservation, "host maxVerifiedResourceReservation");
		if (evidence.resourceReservation.childSessionSlots < 1) return fail("session_slot_required");
		for (const value of [
			evidence.estimates.estimatedCriticalPathSavedWallMilliseconds,
			evidence.estimates.contextTransferWallMilliseconds,
			evidence.estimates.reviewWallMilliseconds,
			evidence.estimates.mergeConflictWallMilliseconds,
			evidence.estimates.computeWallMilliseconds,
			evidence.estimates.computeCostMicrounits,
			evidence.estimates.childWallMilliseconds,
			evidence.estimates.queueWaitWallMilliseconds,
			evidence.estimates.maxVerifiedCriticalPathSavedWallMilliseconds,
			evidence.estimates.maxVerifiedComputeCostMicrounits,
			evidence.usefulVerifiedCompletionUnits,
		])
			if (!isFiniteNonNegativeNumber(value)) return fail("forged_estimate");
		assertArtifactRef(evidence.estimates.evidenceRef, "host estimate evidenceRef");
		for (const value of evidence.independentVerification.evidenceRefs)
			assertArtifactRef(value, "host verification evidenceRef");
		assertArtifactRef(evidence.boundedPacketRef, "host boundedPacketRef");
		for (const value of evidence.sectionRefs) assertArtifactRef(value, "host sectionRef");
		if (
			evidence.estimates.estimatedCriticalPathSavedWallMilliseconds >
				evidence.estimates.maxVerifiedCriticalPathSavedWallMilliseconds ||
			evidence.estimates.computeCostMicrounits > evidence.estimates.maxVerifiedComputeCostMicrounits ||
			!resourceFits(evidence.resourceReservation, evidence.estimates.maxVerifiedResourceReservation) ||
			evidence.estimates.computeCostMicrounits > limits.maxChildCostMicrounits ||
			!resourceFits(evidence.resourceReservation, limits.maxChildReservation)
		)
			return fail("forged_estimate");
		if (evidence.boundedPacketRef.sizeBytes > limits.maxPacketBytes) return fail("packet_limit");
	} catch {
		return fail("forged_estimate");
	}
	let readSet: readonly string[];
	let writeSet: readonly string[];
	try {
		readSet = normalizeStringSet(evidence.readSet, "host readSet");
		writeSet = normalizeStringSet(evidence.writeSet, "host writeSet");
		for (const path of [...readSet, ...writeSet]) parseWorkflowCanonicalPath(path);
	} catch {
		return fail("missing_path_proof");
	}
	let pathIdentities: ReadonlyMap<string, string>;
	try {
		const proofs = normalizeProofs({ ...evidence, readSet, writeSet }, workspaceRoot);
		pathIdentities = new Map([...proofs].map(([path, pathProof]) => [path, pathProof.caseFoldedRealPath]));
	} catch {
		return fail("host_path_outside_workspace");
	}
	const identities = [...pathIdentities.values()];
	for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1)
		for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1)
			if (pathsOverlap(identities[leftIndex]!, identities[rightIndex]!)) return fail("canonical_path_conflict");
	const wallDenominator = evidence.estimates.childWallMilliseconds + evidence.estimates.queueWaitWallMilliseconds;
	const throughput = wallDenominator > 0 ? evidence.usefulVerifiedCompletionUnits / wallDenominator : 0;
	if (
		evidence.usefulVerifiedCompletionUnits < limits.minUsefulVerifiedCompletionUnits ||
		throughput < limits.minUsefulCompletionPerWallMillisecond
	)
		return fail("not_useful");
	const rawBenefit =
		evidence.estimates.estimatedCriticalPathSavedWallMilliseconds -
		evidence.estimates.contextTransferWallMilliseconds -
		evidence.estimates.reviewWallMilliseconds -
		evidence.estimates.mergeConflictWallMilliseconds -
		evidence.estimates.computeWallMilliseconds -
		evidence.estimates.queueWaitWallMilliseconds;
	if (rawBenefit <= 0) return fail("nonpositive_benefit");
	return {
		normalized: Object.freeze({
			candidate: Object.freeze(candidate),
			evidence: Object.freeze(evidence),
			graphNode: Object.freeze(graphNode),
			readSet,
			writeSet,
			pathIdentities,
			rawBenefitWallMilliseconds: rawBenefit,
			throughputPerWallMillisecond: throughput,
		}),
		reasons: [],
	};
}

function candidateConflicts(
	left: NormalizedCandidate,
	right: NormalizedCandidate,
): RecursiveDelegationDenialReason | null {
	if (left.candidate.childId === right.candidate.childId) return "duplicate_child";
	if (left.evidence.workKey === right.evidence.workKey) return "duplicate_work";
	if (left.evidence.atomicGroupId !== null && left.evidence.atomicGroupId === right.evidence.atomicGroupId)
		return "atomic_group_conflict";
	if (left.evidence.scopeId === right.evidence.scopeId) return "duplicate_scope";
	if (
		left.evidence.dependencyTaskIds.includes(right.evidence.taskId) ||
		right.evidence.dependencyTaskIds.includes(left.evidence.taskId)
	)
		return "dependency_mismatch";
	const leftWriteIdentities = left.writeSet.map((path) => left.pathIdentities.get(path) ?? "");
	const rightWriteIdentities = right.writeSet.map((path) => right.pathIdentities.get(path) ?? "");
	const leftReadIdentities = left.readSet.map((path) => left.pathIdentities.get(path) ?? "");
	const rightReadIdentities = right.readSet.map((path) => right.pathIdentities.get(path) ?? "");
	if (
		leftWriteIdentities.some((leftPath) =>
			rightWriteIdentities.some((rightPath) => pathsOverlap(leftPath, rightPath)),
		) ||
		leftWriteIdentities.some((leftPath) =>
			rightReadIdentities.some((rightPath) => pathsOverlap(leftPath, rightPath)),
		) ||
		rightWriteIdentities.some((rightPath) => leftReadIdentities.some((leftPath) => pathsOverlap(rightPath, leftPath)))
	)
		return "write_set_conflict";
	return null;
}

function candidateConflictsWithCurrentGraph(
	candidate: RecursiveDelegationCandidate,
	graph: ReadonlyMap<string, RecursiveDelegationHostGraphNode>,
	currentChildIds: ReadonlySet<string>,
	outcomeChildIds: ReadonlySet<string>,
): boolean {
	if (outcomeChildIds.has(candidate.childId)) return false;
	return [...currentChildIds].some((childId) => {
		const current = graph.get(childId);
		return (
			current !== undefined &&
			(current.childId === candidate.childId ||
				current.taskId === candidate.taskId ||
				current.workKey === candidate.workKey ||
				current.scopeId === candidate.scopeId ||
				(current.atomicGroupId !== null && current.atomicGroupId === candidate.atomicGroupId))
		);
	});
}

function makePacket(
	input: RecursiveDelegationPolicyInput,
	selected: readonly NormalizedCandidate[],
): RecursiveDelegationCoordinatorPacket {
	assertArtifactRef(input.coordinatorPacketRef, "coordinatorPacketRef");
	const childArtifactRefs = uniqueArtifactRefs(
		selected.flatMap(({ evidence }) => [
			...evidence.independentVerification.evidenceRefs,
			evidence.estimates.evidenceRef,
			evidence.boundedPacketRef,
			...evidence.sectionRefs,
		]),
	);
	const boundedPacketRefs = Object.freeze(
		selected
			.map(({ evidence }) => ({ childId: evidence.childId, ref: freezeArtifactRef(evidence.boundedPacketRef) }))
			.sort((left, right) => compareCodePointStrings(left.childId, right.childId)),
	);
	const sectionRefs = Object.freeze(
		selected
			.map(({ evidence }) => ({
				childId: evidence.childId,
				refs: uniqueArtifactRefs(evidence.sectionRefs),
			}))
			.sort((left, right) => compareCodePointStrings(left.childId, right.childId)),
	);
	const blockers = Object.freeze(
		selected
			.map(({ evidence }) => ({
				childId: evidence.childId,
				blockers: normalizeBlockers(evidence.blockerAssessment.blockers, "host blockers"),
			}))
			.sort((left, right) => compareCodePointStrings(left.childId, right.childId)),
	);
	const blockerBytes = blockers.reduce(
		(sum, entry) =>
			sum +
			stringByteLength(entry.childId) +
			entry.blockers.reduce((entrySum, blocker) => entrySum + stringByteLength(blocker), 0),
		0,
	);
	const totalBytes =
		input.coordinatorPacketRef.sizeBytes +
		childArtifactRefs.reduce((sum, ref) => sum + ref.sizeBytes, 0) +
		blockerBytes;
	const totalRefs = 1 + childArtifactRefs.length;
	const packetDigest = digestObject({
		coordinatorPacketRef: artifactPreimage(input.coordinatorPacketRef),
		childArtifactRefs: childArtifactRefs.map(artifactPreimage),
		boundedPacketRefs: boundedPacketRefs.map(({ childId, ref }) => ({ childId, ref: artifactPreimage(ref) })),
		sectionRefs: sectionRefs.map(({ childId, refs }) => ({ childId, refs: refs.map(artifactPreimage) })),
		blockers,
		bounded: true,
		fullReportsTransmitted: false,
	});
	return Object.freeze({
		ref: freezeArtifactRef(input.coordinatorPacketRef),
		digest: packetDigest,
		bounded: true,
		childArtifactRefs,
		boundedPacketRefs,
		sectionRefs,
		blockers,
		totalRefs,
		totalBytes,
		fullReportsTransmitted: false,
	});
}

function packetWithinLimits(
	input: RecursiveDelegationPolicyInput,
	selected: readonly NormalizedCandidate[],
	ceilings: RecursiveDelegationHostCeilings,
): boolean {
	try {
		const packet = makePacket(input, selected);
		return packet.totalBytes <= ceilings.maxPacketBytes && packet.totalRefs <= ceilings.maxPacketRefs;
	} catch {
		return false;
	}
}

function authorizationRequirements(
	input: RecursiveDelegationPolicyInput,
	operationDigest: string,
	evidenceDigest: string,
): RecursiveDelegationAuthorizationRequirements {
	return Object.freeze({
		capability: "workflow_recursive_delegation_plan",
		workflowId: input.workflowId,
		operationDigest,
		resourceDigest: evidenceDigest,
		requiresHostPrincipalAuthorization: true,
	});
}

function assertAuthorizationDecision(
	decision: WorkflowHostPrincipalCapabilityAuthorization,
	receipt: WorkflowVerifiedHostReceipt,
	input: RecursiveDelegationPolicyInput,
	epochRef: WorkflowEpochRef,
	executionIdentity: string | undefined,
	sessionId: string | undefined,
	consumptionWitness: WorkflowHostReceiptConsumptionWitness | null,
): RecursiveDelegationAuthorizationSummary {
	let receiptDigestMatches = false;
	try {
		receiptDigestMatches = isRecord(decision.receipt) && digestObject(decision.receipt) === digestObject(receipt);
	} catch {
		receiptDigestMatches = false;
	}
	if (
		!isRecord(decision) ||
		!isRecord(decision.receipt) ||
		!isRecord(decision.epochRef) ||
		decision.capability !== "workflow_recursive_delegation_plan" ||
		decision.workflowId !== input.workflowId ||
		decision.bindingDigest !== receipt.bindingDigest ||
		decision.receipt.receiptId !== receipt.receiptId ||
		decision.receipt.workflowId !== receipt.workflowId ||
		decision.receipt.payloadDigest !== receipt.payloadDigest ||
		decision.receipt.bindingDigest !== receipt.bindingDigest ||
		!receiptDigestMatches ||
		decision.stateDigest !== receipt.stateDigest ||
		decision.revision !== receipt.revision ||
		decision.epochRef.storeEpoch !== epochRef.storeEpoch ||
		decision.epochRef.coordinatorEpoch !== epochRef.coordinatorEpoch ||
		decision.executionIdentity !== executionIdentity ||
		decision.sessionId !== sessionId ||
		typeof receipt.oneUse !== "boolean" ||
		typeof decision.authenticatedPrincipal !== "string" ||
		decision.authenticatedPrincipal.length === 0 ||
		typeof decision.keyOwnerPrincipal !== "string" ||
		decision.keyOwnerPrincipal.length === 0 ||
		typeof decision.authorizationDigest !== "string" ||
		decision.authorizationDigest.length === 0 ||
		receipt.capabilityBinding?.capability !== "workflow_recursive_delegation_plan" ||
		receipt.workflowId !== input.workflowId ||
		receipt.stateDigest.length === 0 ||
		!isSafePositiveInteger(receipt.revision) ||
		!isSafePositiveInteger(epochRef.storeEpoch) ||
		!isSafePositiveInteger(epochRef.coordinatorEpoch)
	)
		throw new Error("CONTRACT_CHANGE: recursive delegation host authorization is not canonical.");
	return Object.freeze({
		authenticatedPrincipal: decision.authenticatedPrincipal,
		keyOwnerPrincipal: decision.keyOwnerPrincipal,
		capability: "workflow_recursive_delegation_plan",
		authorizationDigest: decision.authorizationDigest,
		receiptId: receipt.receiptId,
		oneUse: receipt.oneUse,
		consumptionWitness,
	});
}

interface ParsedAuthorizationToken {
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly bindingDigest: string;
	readonly operationDigest: string;
}

function parseAuthorizationToken(value: unknown): ParsedAuthorizationToken {
	if (
		!isRecord(value) ||
		!isRecord(value.receipt) ||
		typeof value.bindingDigest !== "string" ||
		typeof value.operationDigest !== "string"
	)
		throw new Error("CONTRACT_CHANGE: recursive delegation requires an opaque host-issued authorization token.");
	return {
		receipt: value.receipt as unknown as WorkflowVerifiedHostReceipt,
		bindingDigest: value.bindingDigest,
		operationDigest: value.operationDigest,
	};
}

function validateConsumptionWitness(
	witness: WorkflowHostReceiptConsumptionWitness,
	receipt: WorkflowVerifiedHostReceipt,
	input: RecursiveDelegationPolicyInput,
	expectedBindingDigest: string,
	operationDigest: string,
): WorkflowHostReceiptConsumptionWitness {
	if (!isRecord(witness))
		throw new Error("CONTRACT_CHANGE: recursive delegation receipt consumption witness is invalid.");
	assertClosedKeys(
		witness,
		[
			"receiptId",
			"workflowId",
			"bindingDigest",
			"capability",
			"resourceDigest",
			"operationDigest",
			"receiptDigest",
			"consumedAt",
			"consumptionSequence",
		],
		"recursive delegation receipt consumption witness",
	);
	if (
		witness.receiptId !== receipt.receiptId ||
		witness.workflowId !== input.workflowId ||
		witness.bindingDigest !== expectedBindingDigest ||
		witness.capability !== receipt.capabilityBinding?.capability ||
		witness.resourceDigest !== receipt.capabilityBinding?.resourceDigest ||
		witness.operationDigest !== operationDigest ||
		witness.receiptDigest !== digestObject(receipt) ||
		typeof witness.consumedAt !== "string" ||
		!Number.isFinite(Date.parse(witness.consumedAt)) ||
		!isSafePositiveInteger(witness.consumptionSequence)
	)
		throw new Error("CONTRACT_CHANGE: recursive delegation receipt consumption witness is not authenticated.");
	return Object.freeze({ ...witness });
}

function assertHostComposition(
	input: RecursiveDelegationPolicyInput,
	composition: RecursiveDelegationHostComposition,
): void {
	if (
		!isRecord(input) ||
		typeof input.workflowId !== "string" ||
		input.workflowId.length === 0 ||
		typeof input.workerId !== "string" ||
		input.workerId.length === 0 ||
		typeof input.coordinatorId !== "string" ||
		input.coordinatorId.length === 0 ||
		!isRecord(composition) ||
		typeof composition.trustedNow !== "string" ||
		typeof composition.currentStateDigest !== "string" ||
		!isSafePositiveInteger(composition.currentRevision) ||
		!isRecord(composition.receiptContext) ||
		typeof composition.receiptContext.receiptResolver?.resolve !== "function" ||
		typeof composition.receiptContext.receiptResolver?.consumeIfOneUse !== "function" ||
		typeof composition.receiptContext.receiptResolver?.resolveConsumptionWitness !== "function" ||
		typeof composition.receiptContext.artifactResolver?.resolve !== "function" ||
		typeof composition.receiptContext.principalAuthorizer?.authorize !== "function" ||
		!Array.isArray(composition.hostEvidence) ||
		!Array.isArray(composition.graphAuthority?.nodes) ||
		!isRecord(composition.currentState) ||
		typeof composition.currentState.workflowId !== "string" ||
		composition.currentState.workflowId.length === 0 ||
		!isSafePositiveInteger(composition.currentState.revision) ||
		!isRecord(composition.currentState.epochRef) ||
		!isSafePositiveInteger(composition.currentState.epochRef.storeEpoch) ||
		!isSafePositiveInteger(composition.currentState.epochRef.coordinatorEpoch) ||
		!isSafePositiveInteger(composition.currentState.graphRevision) ||
		!Array.isArray(composition.currentState.selectedChildIds) ||
		!composition.currentState.selectedChildIds.every((value) => typeof value === "string" && value.length > 0) ||
		new Set(composition.currentState.selectedChildIds).size !== composition.currentState.selectedChildIds.length ||
		!Array.isArray(composition.currentState.currentChildIds) ||
		!composition.currentState.currentChildIds.every((value) => typeof value === "string" && value.length > 0) ||
		new Set(composition.currentState.currentChildIds).size !== composition.currentState.currentChildIds.length ||
		!Array.isArray(composition.currentState.completedTaskIds) ||
		!composition.currentState.completedTaskIds.every((value) => typeof value === "string" && value.length > 0) ||
		new Set(composition.currentState.completedTaskIds).size !== composition.currentState.completedTaskIds.length ||
		!isRecord(composition.epochRef) ||
		!isSafePositiveInteger(composition.epochRef.storeEpoch) ||
		!isSafePositiveInteger(composition.epochRef.coordinatorEpoch) ||
		(composition.executionIdentity !== undefined &&
			(typeof composition.executionIdentity !== "string" || composition.executionIdentity.length === 0)) ||
		(composition.sessionId !== undefined &&
			(typeof composition.sessionId !== "string" || composition.sessionId.length === 0)) ||
		!isRecord(composition.budget) ||
		!isRecord(composition.synthesisObligation) ||
		(composition.persistIntentBatch !== undefined && typeof composition.persistIntentBatch !== "function")
	)
		throw new Error("CONTRACT_CHANGE: recursive delegation requires persisted production host composition.");
	try {
		normalizeBudget(composition.budget);
	} catch (error) {
		throw new Error("CONTRACT_CHANGE: recursive delegation host resource budget is invalid.", { cause: error });
	}
	if (input.workflowId !== composition.currentState.workflowId)
		throw new Error("CONTRACT_CHANGE: recursive delegation workflow binding is inconsistent.");
	assertDigest(composition.currentStateDigest, "recursive delegation state digest");
	assertDigest(composition.currentState.resourceLedgerDigest, "recursive delegation resource ledger digest");
	if (
		composition.currentState.stateDigest !== composition.currentStateDigest ||
		composition.currentState.revision !== composition.currentRevision
	)
		throw new Error("CONTRACT_CHANGE: recursive delegation state binding is inconsistent.");
	if (!sameEpoch(composition.currentState.epochRef, composition.epochRef))
		throw new Error("CONTRACT_CHANGE: recursive delegation epoch binding is inconsistent.");
	if (composition.currentState.graphRevision !== composition.graphAuthority.graphRevision)
		throw new Error("CONTRACT_CHANGE: recursive delegation graph revision is inconsistent.");
}

function assertChildOutcomes(input: RecursiveDelegationPolicyInput, host: RecursiveDelegationHostComposition): void {
	const seen = new Set<string>();
	for (const outcome of input.childOutcomes ?? []) {
		if (
			!isRecord(outcome) ||
			Object.keys(outcome).some(
				(key) =>
					![
						"childId",
						"status",
						"reason",
						"outputDigest",
						"evidenceRefs",
						"ledgerDigest",
						"boundedPacketRef",
					].includes(key),
			) ||
			typeof outcome.childId !== "string" ||
			outcome.childId.length === 0 ||
			seen.has(outcome.childId) ||
			(outcome.status !== "pending" && outcome.status !== "completed" && outcome.status !== "failed") ||
			typeof outcome.outputDigest !== "string" ||
			!Array.isArray(outcome.evidenceRefs) ||
			(outcome.reason !== undefined &&
				(typeof outcome.reason !== "string" ||
					outcome.reason.length === 0 ||
					stringByteLength(outcome.reason) > MAX_FAILURE_REASON_BYTES)) ||
			typeof outcome.ledgerDigest !== "string" ||
			typeof outcome.boundedPacketRef !== "object" ||
			outcome.boundedPacketRef === null
		)
			throw new Error("CONTRACT_CHANGE: recursive delegation child outcome is invalid.");
		seen.add(outcome.childId);
		try {
			assertDigest(outcome.outputDigest, "recursive delegation child outcome outputDigest");
			assertDigest(outcome.ledgerDigest, "recursive delegation child outcome ledgerDigest");
			if (outcome.ledgerDigest !== host.currentState.resourceLedgerDigest)
				throw new Error("recursive delegation child outcome ledger is stale.");
			assertArtifactRef(outcome.boundedPacketRef, "recursive delegation child outcome boundedPacketRef");
			if (outcome.boundedPacketRef.sizeBytes > host.ceilings.maxPacketBytes)
				throw new Error("recursive delegation child outcome bounded packet exceeds host ceiling.");
			for (const ref of outcome.evidenceRefs)
				assertArtifactRef(ref, "recursive delegation child outcome evidenceRef");
			const refs = uniqueArtifactRefs([outcome.boundedPacketRef, ...outcome.evidenceRefs]);
			if (
				refs.length + 1 > host.ceilings.maxPacketRefs ||
				stringByteLength(outcome.childId) +
					stringByteLength(outcome.reason ?? "") +
					stringByteLength(outcome.ledgerDigest) +
					refs.reduce((sum, ref) => sum + ref.sizeBytes, 0) >
					host.ceilings.maxPacketBytes
			)
				throw new Error("recursive delegation child outcome evidence exceeds host packet limits.");
			if (outcome.status === "failed" && (outcome.reason === undefined || outcome.reason.length === 0))
				throw new Error("recursive delegation failed child outcome has no bounded reason.");
		} catch (error) {
			throw new Error("CONTRACT_CHANGE: recursive delegation child outcome evidence is invalid.", { cause: error });
		}
	}
}

function makeReservationIntent(
	input: RecursiveDelegationPolicyInput,
	selected: readonly RecursiveDelegationChildPlan[],
	host: RecursiveDelegationHostComposition,
): RecursiveDelegationReservationCommitIntent | null {
	if (selected.length === 0) return null;
	const reservations = Object.freeze(
		selected.map(({ childId, resourceReservation }) =>
			Object.freeze({ childId, resourceReservation: freezeResourceVector(resourceReservation) }),
		),
	);
	const reservationDigest = digestObject({
		workflowId: input.workflowId,
		workerId: input.workerId,
		coordinatorId: input.coordinatorId,
		childIds: selected.map(({ childId }) => childId).sort(compareCodePointStrings),
		reservations,
		expectedStateDigest: host.currentState.stateDigest,
		expectedRevision: host.currentState.revision,
		expectedEpochRef: host.currentState.epochRef,
		expectedGraphRevision: host.currentState.graphRevision,
		expectedResourceLedgerDigest: host.currentState.resourceLedgerDigest,
	});
	return Object.freeze({
		kind: "recursive_delegation_reservation_commit",
		durable: true,
		commitRequired: true,
		workflowId: input.workflowId,
		workerId: input.workerId,
		coordinatorId: input.coordinatorId,
		childIds: Object.freeze(selected.map(({ childId }) => childId).sort(compareCodePointStrings)),
		reservations,
		reservationDigest,
		expectedStateDigest: host.currentState.stateDigest,
		expectedRevision: host.currentState.revision,
		expectedEpochRef: Object.freeze({ ...host.currentState.epochRef }),
		expectedGraphRevision: host.currentState.graphRevision,
		expectedResourceLedgerDigest: host.currentState.resourceLedgerDigest,
	});
}

function makeEscalations(
	input: RecursiveDelegationPolicyInput,
	selected: readonly RecursiveDelegationChildPlan[],
	host: RecursiveDelegationHostComposition,
	reservationIntent: RecursiveDelegationReservationCommitIntent | null,
): {
	readonly escalations: readonly RecursiveDelegationEscalationIntent[];
	readonly reasons: readonly RecursiveDelegationDenialReason[];
} {
	const selectedIds = new Set(selected.map(({ childId }) => childId));
	const selectedStateIds = new Set(host.currentState.selectedChildIds);
	const completedTaskIds = new Set(host.currentState.completedTaskIds);
	const selectedTaskIds = new Set(selected.map(({ taskId }) => taskId));
	const failedOutcomes = [...(input.childOutcomes ?? [])]
		.filter((value) => value.status === "failed")
		.sort((left, right) => compareCodePointStrings(left.childId, right.childId));
	const failedTaskIds = new Set(
		failedOutcomes.flatMap((outcome) => {
			const node = host.graphAuthority.nodes.find((candidate) => candidate.childId === outcome.childId);
			return node === undefined ? [] : [node.taskId];
		}),
	);
	const reasons: RecursiveDelegationDenialReason[] = [];
	const escalations: RecursiveDelegationEscalationIntent[] = [];
	for (const outcome of failedOutcomes) {
		if (
			!selectedIds.has(outcome.childId) ||
			!selectedStateIds.has(outcome.childId) ||
			!host.currentState.currentChildIds.includes(outcome.childId)
		) {
			reasons.push("stale_failure");
			continue;
		}
		const graphNode = host.graphAuthority.nodes.find((node) => node.childId === outcome.childId);
		if (
			graphNode === undefined ||
			graphNode.dependencyTaskIds.some(
				(dependency) =>
					!completedTaskIds.has(dependency) && (!selectedTaskIds.has(dependency) || failedTaskIds.has(dependency)),
			)
		) {
			reasons.push("failure_dependency_unmet");
			continue;
		}
		for (const ref of outcome.evidenceRefs) assertArtifactRef(ref, "nested failure evidenceRef");
		assertDigest(outcome.outputDigest, "nested failure outputDigest");
		if (reservationIntent === null)
			throw new Error("CONTRACT_CHANGE: failed child has no durable reservation intent.");
		const releaseIntent: RecursiveDelegationReleaseIntent = Object.freeze({
			kind: "recursive_delegation_release",
			durable: true,
			workflowId: input.workflowId,
			workerId: input.workerId,
			coordinatorId: input.coordinatorId,
			childId: outcome.childId,
			reservationDigest: reservationIntent.reservationDigest,
			expectedStateDigest: host.currentState.stateDigest,
			expectedRevision: host.currentState.revision,
			expectedEpochRef: Object.freeze({ ...host.currentState.epochRef }),
			expectedGraphRevision: host.currentState.graphRevision,
			expectedResourceLedgerDigest: host.currentState.resourceLedgerDigest,
		});
		escalations.push(
			Object.freeze({
				kind: "urgent_nested_failure",
				durable: true,
				audiences: [input.workerId, input.coordinatorId] as [string, string],
				childId: outcome.childId,
				reason: outcome.reason ?? "nested child failed without a reason",
				outputDigest: outcome.outputDigest,
				siblingPolicy: "continue",
				continueSiblingIds: Object.freeze(
					selected
						.map(({ childId }) => childId)
						.filter((childId) => childId !== outcome.childId)
						.sort(compareCodePointStrings),
				),
				evidenceRefs: uniqueArtifactRefs(outcome.evidenceRefs),
				boundedPacketRef: freezeArtifactRef(outcome.boundedPacketRef),
				releaseIntent,
			}),
		);
	}
	return { escalations: Object.freeze(escalations), reasons: Object.freeze(reasons) };
}

function makeDurableIntentBatch(
	input: RecursiveDelegationPolicyInput,
	host: RecursiveDelegationHostComposition,
	reservationIntent: RecursiveDelegationReservationCommitIntent | null,
	escalationIntents: readonly RecursiveDelegationEscalationIntent[],
): RecursiveDelegationDurableIntentBatch | null {
	if (reservationIntent === null && escalationIntents.length === 0) return null;
	const expectedStateDigest = host.currentState.stateDigest;
	const expectedRevision = host.currentState.revision;
	const expectedEpochRef = Object.freeze({ ...host.currentState.epochRef });
	const expectedGraphRevision = host.currentState.graphRevision;
	const expectedResourceLedgerDigest = host.currentState.resourceLedgerDigest;
	const batchPreimage = {
		kind: "recursive_delegation_intent_batch" as const,
		durable: true as const,
		workflowId: input.workflowId,
		workerId: input.workerId,
		coordinatorId: input.coordinatorId,
		reservationIntent,
		escalationIntents,
		expectedStateDigest,
		expectedRevision,
		expectedEpochRef,
		expectedGraphRevision,
		expectedResourceLedgerDigest,
	};
	return Object.freeze({ ...batchPreimage, batchDigest: digestObject(batchPreimage) });
}

function makePlanDigest(value: unknown): string {
	return digestObject(value);
}

function buildResult(
	input: RecursiveDelegationPolicyInput,
	limits: RecursiveDelegationLimits,
	ceilings: RecursiveDelegationHostCeilings,
	selected: readonly NormalizedCandidate[],
	deniedCandidates: readonly RecursiveDelegationDeniedCandidate[],
	denialReasons: readonly RecursiveDelegationDenialReason[],
	_remainingResources: RecursiveDelegationResourceVector,
	authorization: RecursiveDelegationAuthorizationSummary | null,
	evidenceDigest: string,
	operationDigest: string,
	host: RecursiveDelegationHostComposition,
): RecursiveDelegationPolicyResult {
	const childDepth = input.workerDepth + 1;
	const selectedChildren = Object.freeze(
		selected
			.map(({ evidence, readSet, writeSet, rawBenefitWallMilliseconds, throughputPerWallMillisecond }) =>
				Object.freeze({
					childId: evidence.childId,
					taskId: evidence.taskId,
					scopeId: evidence.scopeId,
					atomicGroupId: evidence.atomicGroupId,
					dependencyTaskIds: Object.freeze([...evidence.dependencyTaskIds].sort(compareCodePointStrings)),
					ownership: evidence.ownership,
					readSet,
					writeSet,
					childDepth,
					resourceReservation: freezeResourceVector(evidence.resourceReservation),
					netBenefitWallMilliseconds: rawBenefitWallMilliseconds,
					throughputPerWallMillisecond,
					boundedPacketRef: freezeArtifactRef(evidence.boundedPacketRef),
					sectionRefs: uniqueArtifactRefs(evidence.sectionRefs),
					artifactRefs: uniqueArtifactRefs([
						...evidence.independentVerification.evidenceRefs,
						evidence.estimates.evidenceRef,
						evidence.boundedPacketRef,
						...evidence.sectionRefs,
					]),
					modelBinding: Object.freeze({ ...evidence.modelBinding }),
				}),
			)
			.sort((left, right) => compareCodePointStrings(left.childId, right.childId)),
	);
	const serialWallMilliseconds = selected.reduce(
		(total, { evidence }) => total + evidence.estimates.childWallMilliseconds,
		0,
	);
	const parallelWallMilliseconds =
		selected.length === 0 ? 0 : Math.max(...selected.map(({ evidence }) => evidence.estimates.childWallMilliseconds));
	const queueWaitWallMilliseconds = selected.reduce(
		(total, { evidence }) => total + evidence.estimates.queueWaitWallMilliseconds,
		0,
	);
	const modeledCriticalPath = Object.freeze({
		serialWallMilliseconds,
		parallelWallMilliseconds,
		savedWallMilliseconds: Math.max(0, serialWallMilliseconds - parallelWallMilliseconds),
		queueWaitWallMilliseconds,
	});
	const packetSelected = [...selected];
	const packetDenied = new Map<string, RecursiveDelegationDenialReason[]>();
	while (!packetWithinLimits(input, packetSelected, ceilings) && packetSelected.length > 0) {
		const removed = packetSelected.pop();
		if (removed !== undefined) packetDenied.set(removed.candidate.childId, ["packet_limit"]);
	}
	const coordinatorPacket = makePacket(input, packetSelected);
	const coordinatorPacketOverLimit = !packetWithinLimits(input, [], ceilings);
	const allDenied = new Map<string, RecursiveDelegationDenialReason[]>();
	for (const entry of deniedCandidates) allDenied.set(entry.childId, [...entry.reasons]);
	for (const [childId, reasons] of packetDenied) allDenied.set(childId, reasons);
	const effectiveSelected =
		packetSelected.length === selected.length
			? selectedChildren
			: Object.freeze(
					selectedChildren.filter(({ childId }) =>
						packetSelected.some((entry) => entry.candidate.childId === childId),
					),
				);
	const effectiveReservations = Object.freeze(
		effectiveSelected.map(({ childId, resourceReservation }) =>
			Object.freeze({ childId, resourceReservation: freezeResourceVector(resourceReservation) }),
		),
	);
	const effectiveUsed = effectiveReservations.reduce(
		(total, entry) => addResources(total, entry.resourceReservation),
		zeroResourceVector(),
	);
	const effectiveRemaining = subtractResources(
		availableAfterProtectedReserve(normalizeBudget(host.budget)),
		effectiveUsed,
	);
	const reservationIntent = makeReservationIntent(input, effectiveSelected, host);
	const escalationResult = makeEscalations(input, effectiveSelected, host, reservationIntent);
	const durableIntentBatch = makeDurableIntentBatch(input, host, reservationIntent, escalationResult.escalations);
	const mergedDenialEntries = [...allDenied.entries()]
		.map(([childId, reasons]) => Object.freeze({ childId, reasons: orderReasons(reasons) }))
		.sort((left, right) => compareCodePointStrings(left.childId, right.childId));
	const mergedDenialReasons = orderReasons([
		...denialReasons,
		...[...packetDenied.values()].flat(),
		...(coordinatorPacketOverLimit ? ["packet_limit" as const] : []),
		...escalationResult.reasons,
	]);
	const parentAccountability = Object.freeze({
		integrationOwner: input.workerId,
		contextOwner: input.workerId,
		coordinatorId: input.coordinatorId,
	});
	const parentAcceptanceObligation = Object.freeze({
		required: true as const,
		integrationOwner: input.workerId,
		contextOwner: input.workerId,
		acceptanceOwner: input.workerId,
		obligationDigest: digestObject({
			workflowId: input.workflowId,
			required: true,
			integrationOwner: input.workerId,
			contextOwner: input.workerId,
			acceptanceOwner: input.workerId,
			childIds: effectiveSelected.map(({ childId }) => childId),
			coordinatorPacketDigest: coordinatorPacket.digest,
		}),
	});
	const status: RecursiveDelegationPolicyResult["status"] = effectiveSelected.length > 0 ? "admitted" : "denied";
	const resultWithoutDigest = {
		status,
		limits,
		selectedChildren: effectiveSelected,
		deniedCandidates: Object.freeze(mergedDenialEntries),
		denialReasons: mergedDenialReasons,
		childDepth,
		resourceReservations: effectiveReservations,
		remainingResources: effectiveRemaining,
		modeledCriticalPath:
			effectiveSelected.length === selectedChildren.length
				? modeledCriticalPath
				: Object.freeze({
						serialWallMilliseconds: effectiveSelected.reduce(
							(total, child) =>
								total +
								host.hostEvidence.find((entry) => entry.childId === child.childId)!.estimates
									.childWallMilliseconds,
							0,
						),
						parallelWallMilliseconds:
							effectiveSelected.length === 0
								? 0
								: Math.max(
										...effectiveSelected.map(
											(child) =>
												host.hostEvidence.find((entry) => entry.childId === child.childId)!.estimates
													.childWallMilliseconds,
										),
									),
						savedWallMilliseconds: 0,
						queueWaitWallMilliseconds: effectiveSelected.reduce(
							(total, child) =>
								total +
								host.hostEvidence.find((entry) => entry.childId === child.childId)!.estimates
									.queueWaitWallMilliseconds,
							0,
						),
					}),
		parentAccountability,
		parentAcceptanceObligation,
		coordinatorPacket,
		escalationIntents: escalationResult.escalations,
		completionDelivery: "checkpoint_batched" as const,
		authorizationRequirements: authorizationRequirements(input, operationDigest, evidenceDigest),
		authorization,
		workerModelBinding: isValidModelBinding(host.workerModelBinding)
			? Object.freeze({ ...host.workerModelBinding })
			: null,
		synthesisObligation: host.synthesisObligation,
		reservationIntent,
		durableIntentBatch,
		integrationRequirement: INTEGRATION_REQUIREMENT,
	};
	return Object.freeze({
		...resultWithoutDigest,
		planDigest: makePlanDigest(resultWithoutDigest),
	});
}

function validateHostGraph(host: RecursiveDelegationHostComposition): Map<string, RecursiveDelegationHostGraphNode> {
	if (
		!isSafePositiveInteger(host.graphAuthority.graphRevision) ||
		!isAbsoluteResolvedPath(host.graphAuthority.workspaceRootRealPath)
	)
		throw new Error("CONTRACT_CHANGE: host graph workspace root is not canonical.");
	const nodes = new Map<string, RecursiveDelegationHostGraphNode>();
	const workKeys = new Set<string>();
	const taskIds = new Set<string>();
	const scopeIds = new Set<string>();
	for (const node of host.graphAuthority.nodes) {
		if (
			!isRecord(node) ||
			nodes.has(node.childId) ||
			workKeys.has(node.workKey) ||
			taskIds.has(node.taskId) ||
			scopeIds.has(node.scopeId) ||
			typeof node.taskId !== "string" ||
			node.taskId.length === 0 ||
			typeof node.childId !== "string" ||
			node.childId.length === 0 ||
			typeof node.workKey !== "string" ||
			node.workKey.length === 0 ||
			typeof node.scopeId !== "string" ||
			node.scopeId.length === 0 ||
			(typeof node.atomicGroupId !== "string" && node.atomicGroupId !== null) ||
			(typeof node.atomicGroupId === "string" && node.atomicGroupId.length === 0) ||
			!Array.isArray(node.dependencyTaskIds) ||
			!node.dependencyTaskIds.every((value) => typeof value === "string" && value.length > 0) ||
			!Array.isArray(node.readSet) ||
			!node.readSet.every((value) => typeof value === "string" && value.length > 0) ||
			!Array.isArray(node.writeSet) ||
			!node.writeSet.every((value) => typeof value === "string" && value.length > 0) ||
			!Array.isArray(node.pathProofs) ||
			!node.pathProofs.every((value) => isRecord(value))
		)
			throw new Error("CONTRACT_CHANGE: host graph contains duplicate or invalid identity.");
		nodes.set(node.childId, node);
		workKeys.add(node.workKey);
		taskIds.add(node.taskId);
		scopeIds.add(node.scopeId);
	}
	for (const childId of [...host.currentState.selectedChildIds, ...host.currentState.currentChildIds])
		if (!nodes.has(childId))
			throw new Error("CONTRACT_CHANGE: host current state references an unknown graph child.");
	return nodes;
}

function validateSynthesisObligation(
	input: RecursiveDelegationPolicyInput,
	host: RecursiveDelegationHostComposition,
	graph: ReadonlyMap<string, RecursiveDelegationHostGraphNode>,
): boolean {
	const obligation = host.synthesisObligation;
	if (
		typeof obligation.l1OwnerId !== "string" ||
		obligation.l1OwnerId !== input.workerId ||
		obligation.contradictionCheckRequired !== true ||
		typeof obligation.acceptanceCriteria !== "string" ||
		obligation.acceptanceCriteria.length === 0 ||
		typeof obligation.contradictionVerifierChildId !== "string" ||
		obligation.contradictionVerifierChildId.length === 0 ||
		!graph.has(obligation.contradictionVerifierChildId) ||
		!input.candidates.some((candidate) => candidate.childId === obligation.contradictionVerifierChildId) ||
		!host.hostEvidence.some((evidence) => evidence.childId === obligation.contradictionVerifierChildId) ||
		!Array.isArray(obligation.evidenceRefs)
	)
		return false;
	for (const ref of obligation.evidenceRefs) assertArtifactRef(ref, "synthesis obligation evidenceRef");
	return (
		obligation.obligationDigest ===
		digestObject({
			l1OwnerId: obligation.l1OwnerId,
			contradictionVerifierChildId: obligation.contradictionVerifierChildId,
			contradictionCheckRequired: obligation.contradictionCheckRequired,
			acceptanceCriteria: obligation.acceptanceCriteria,
			evidenceRefs: obligation.evidenceRefs,
		})
	);
}

function planInternal(
	input: RecursiveDelegationPolicyInput,
	host: RecursiveDelegationHostComposition,
	authorization: RecursiveDelegationAuthorizationSummary,
	evidenceDigest: string,
	operationDigest: string,
): RecursiveDelegationPolicyResult {
	const budget = normalizeBudget(host.budget);
	const ceilings = normalizeCeilings(host.ceilings);
	const limits = clampLimits(input.adaptive?.limits, ceilings);
	const graph = validateHostGraph(host);
	const baseDenials: RecursiveDelegationDeniedCandidate[] = [];
	if (input.adaptive?.enabled !== true)
		return buildResult(
			input,
			limits,
			ceilings,
			[],
			baseDenials,
			["adaptive_option_disabled"],
			availableAfterProtectedReserve(budget),
			authorization,
			evidenceDigest,
			operationDigest,
			host,
		);
	if (!isValidModelBinding(host.workerModelBinding))
		return buildResult(
			input,
			limits,
			ceilings,
			[],
			baseDenials,
			["blocked_model_capability"],
			availableAfterProtectedReserve(budget),
			authorization,
			evidenceDigest,
			operationDigest,
			host,
		);
	if (!isSafeNonNegativeInteger(input.workerDepth)) {
		return buildResult(
			input,
			limits,
			ceilings,
			[],
			baseDenials,
			["invalid_depth"],
			availableAfterProtectedReserve(budget),
			authorization,
			evidenceDigest,
			operationDigest,
			host,
		);
	}
	if (input.workerDepth >= limits.maxDepth)
		return buildResult(
			input,
			limits,
			ceilings,
			[],
			baseDenials,
			["depth_limit"],
			availableAfterProtectedReserve(budget),
			authorization,
			evidenceDigest,
			operationDigest,
			host,
		);
	if (input.candidates.length > limits.maxCandidates)
		return buildResult(
			input,
			limits,
			ceilings,
			[],
			baseDenials,
			["candidate_limit"],
			availableAfterProtectedReserve(budget),
			authorization,
			evidenceDigest,
			operationDigest,
			host,
		);
	if (!validateSynthesisObligation(input, host, graph))
		return buildResult(
			input,
			limits,
			ceilings,
			[],
			baseDenials,
			["synthesis_obligation_missing"],
			availableAfterProtectedReserve(budget),
			authorization,
			evidenceDigest,
			operationDigest,
			host,
		);
	if (
		RECURSIVE_DELEGATION_RESOURCE_DIMENSIONS.some(
			(dimension) => protectedReservation(budget)[dimension] > budget.capacity[dimension],
		)
	)
		return buildResult(
			input,
			limits,
			ceilings,
			[],
			baseDenials,
			["protected_reserve"],
			zeroResourceVector(),
			authorization,
			evidenceDigest,
			operationDigest,
			host,
		);
	const evidenceByChildId = new Map<string, RecursiveDelegationHostEvidence>();
	for (const evidence of host.hostEvidence) {
		if (evidenceByChildId.has(evidence.childId))
			throw new Error("CONTRACT_CHANGE: host evidence contains duplicate child identity.");
		evidenceByChildId.set(evidence.childId, evidence);
	}
	const duplicateDenials = duplicateReasonMap(input.candidates);
	const denied = new Map<string, RecursiveDelegationDenialReason[]>(duplicateDenials);
	const completedTaskIds = new Set(host.currentState.completedTaskIds);
	const currentChildIds = new Set([...host.currentState.selectedChildIds, ...host.currentState.currentChildIds]);
	const outcomeChildIds = new Set((input.childOutcomes ?? []).map((outcome) => outcome.childId));
	const assessments = input.candidates
		.map((candidate) => ({
			candidate,
			assessment: candidateConflictsWithCurrentGraph(candidate, graph, currentChildIds, outcomeChildIds)
				? { normalized: null, reasons: ["host_graph_mismatch"] as const }
				: assessment(
						candidate,
						evidenceByChildId.get(candidate.childId),
						graph.get(candidate.childId),
						host.graphAuthority.workspaceRootRealPath,
						limits,
						completedTaskIds,
						outcomeChildIds.has(candidate.childId),
					),
		}))
		.sort((left, right) => compareCodePointStrings(left.candidate.childId, right.candidate.childId));
	for (const entry of assessments)
		if (entry.assessment.normalized === null)
			denied.set(entry.candidate.childId, [
				...(denied.get(entry.candidate.childId) ?? []),
				...entry.assessment.reasons,
			]);
	const valid = assessments
		.map(({ candidate, assessment: candidateAssessment }) =>
			denied.has(candidate.childId) ? null : candidateAssessment.normalized,
		)
		.filter((candidate): candidate is NormalizedCandidate => candidate !== null)
		.sort((left, right) => {
			const verifierChildId = host.synthesisObligation.contradictionVerifierChildId;
			if (left.candidate.childId === verifierChildId && right.candidate.childId !== verifierChildId) return -1;
			if (right.candidate.childId === verifierChildId && left.candidate.childId !== verifierChildId) return 1;
			if (right.rawBenefitWallMilliseconds !== left.rawBenefitWallMilliseconds)
				return right.rawBenefitWallMilliseconds - left.rawBenefitWallMilliseconds;
			if (right.writeSet.length !== left.writeSet.length) return right.writeSet.length - left.writeSet.length;
			return compareCodePointStrings(left.candidate.childId, right.candidate.childId);
		});
	const available = availableAfterProtectedReserve(budget);
	const selected: NormalizedCandidate[] = [];
	let used = zeroResourceVector();
	for (const candidate of valid) {
		if (selected.length >= limits.maxFanout) {
			denied.set(candidate.candidate.childId, ["fanout_limit"]);
			continue;
		}
		const conflict = selected.map((other) => candidateConflicts(candidate, other)).find((reason) => reason !== null);
		if (conflict !== undefined && conflict !== null) {
			denied.set(candidate.candidate.childId, [conflict]);
			continue;
		}
		const remaining = subtractResources(available, used);
		if (!resourceFits(candidate.evidence.resourceReservation, remaining)) {
			denied.set(candidate.candidate.childId, ["resource_limit"]);
			continue;
		}
		const multiplier =
			limits.maxFanout > 0 ? 1 - limits.diminishingReturnsFactor * (selected.length / limits.maxFanout) : 0;
		if (candidate.rawBenefitWallMilliseconds * multiplier <= 0) {
			denied.set(candidate.candidate.childId, ["nonpositive_benefit"]);
			continue;
		}
		selected.push(candidate);
		used = addResources(used, candidate.evidence.resourceReservation);
	}
	if (
		selected.length > 0 &&
		!selected.some(({ candidate }) => candidate.childId === host.synthesisObligation.contradictionVerifierChildId)
	) {
		for (const candidate of selected) denied.set(candidate.candidate.childId, ["synthesis_obligation_missing"]);
		selected.length = 0;
		used = zeroResourceVector();
	}
	const deniedCandidates = [...denied.entries()]
		.map(([childId, reasons]) => Object.freeze({ childId, reasons: orderReasons(reasons) }))
		.sort((left, right) => compareCodePointStrings(left.childId, right.childId));
	const denialReasons = deniedCandidates.flatMap(({ reasons }) => reasons);
	return buildResult(
		input,
		limits,
		ceilings,
		selected,
		deniedCandidates,
		denialReasons,
		subtractResources(available, used),
		authorization,
		evidenceDigest,
		operationDigest,
		host,
	);
}

async function authorizePlan(
	input: RecursiveDelegationPolicyInput,
	host: RecursiveDelegationHostComposition,
	evidenceDigest: string,
): Promise<{
	readonly authorization: RecursiveDelegationAuthorizationSummary;
	readonly operationDigest: string;
}> {
	const token = parseAuthorizationToken(host.authorizationToken);
	assertDigest(token.bindingDigest, "recursive delegation binding digest");
	const operationDigest = digestObject({ operation: DEFAULT_OPERATION, workflowId: input.workflowId });
	if (token.operationDigest !== operationDigest)
		throw new Error("CONTRACT_CHANGE: recursive delegation token operation is not canonical.");
	const receipt = await resolveAndVerifyWorkflowHostReceipt({
		context: host.receiptContext,
		workflowId: input.workflowId,
		expectedBindingDigest: token.bindingDigest,
		receipt: token.receipt,
		currentStateDigest: host.currentStateDigest,
		currentRevision: host.currentRevision,
		trustedNow: host.trustedNow,
	});
	if (
		receipt.payloadDigest !== evidenceDigest ||
		receipt.capabilityBinding?.resourceDigest !== evidenceDigest ||
		receipt.capabilityBinding?.operationDigest !== operationDigest ||
		receipt.capabilityBinding?.capability !== "workflow_recursive_delegation_plan" ||
		receipt.bindingDigest !== token.bindingDigest
	)
		throw new Error("CONTRACT_CHANGE: recursive delegation receipt is not bound to host evidence.");
	const pendingDecision = host.receiptContext.principalAuthorizer.authorize({
		receipt,
		workflowId: input.workflowId,
		bindingDigest: token.bindingDigest,
		resourceDigest: evidenceDigest,
		operationDigest,
		stateDigest: host.currentStateDigest,
		revision: host.currentRevision,
		epochRef: host.epochRef,
		capability: "workflow_recursive_delegation_plan",
		executionIdentity: host.executionIdentity,
		sessionId: host.sessionId,
	});
	if (pendingDecision === undefined || typeof pendingDecision.then !== "function")
		throw new Error("CONTRACT_CHANGE: recursive delegation host authorizer must complete asynchronously.");
	const decision = await pendingDecision;
	const authorizationDecision = assertAuthorizationDecision(
		decision,
		receipt,
		input,
		host.epochRef,
		host.executionIdentity,
		host.sessionId,
		null,
	);
	let consumptionWitness: WorkflowHostReceiptConsumptionWitness | null = null;
	if (receipt.oneUse) {
		try {
			await host.receiptContext.receiptResolver.consumeIfOneUse({
				receipt,
				workflowId: input.workflowId,
				expectedBindingDigest: token.bindingDigest,
				currentRevision: host.currentRevision,
			});
			consumptionWitness = validateConsumptionWitness(
				await host.receiptContext.receiptResolver.resolveConsumptionWitness({
					receiptId: receipt.receiptId,
					workflowId: input.workflowId,
					expectedBindingDigest: token.bindingDigest,
				}),
				receipt,
				input,
				token.bindingDigest,
				operationDigest,
			);
		} catch (error) {
			throw new Error(
				"CONTRACT_CHANGE: recursive delegation authorization receipt was already consumed or could not be durably witnessed.",
				{
					cause: error,
				},
			);
		}
	}
	return {
		authorization: Object.freeze({ ...authorizationDecision, consumptionWitness }),
		operationDigest,
	};
}

/**
 * Verify host-issued authority, then plan from an immutable evidence snapshot.
 * The adapter has no spawning behavior; admitted plans require the runtime's
 * durable CAS-bound intent-batch persistence seam.
 */
export async function planAdaptiveRecursiveDelegationFromHost(
	input: RecursiveDelegationPolicyInput,
	host: RecursiveDelegationHostComposition,
): Promise<RecursiveDelegationPolicyResult> {
	assertHostComposition(input, host);
	assertChildOutcomes(input, host);
	const snapshot = immutableSnapshot({
		request: input,
		authorizationToken: host.authorizationToken,
		trustedNow: host.trustedNow,
		currentStateDigest: host.currentStateDigest,
		currentRevision: host.currentRevision,
		epochRef: host.epochRef,
		executionIdentity: host.executionIdentity,
		sessionId: host.sessionId,
		ceilings: host.ceilings,
		budget: host.budget,
		hostEvidence: host.hostEvidence,
		graphAuthority: host.graphAuthority,
		currentState: host.currentState,
		workerModelBinding: host.workerModelBinding,
		synthesisObligation: host.synthesisObligation,
	});
	let evidenceDigest: string;
	try {
		evidenceDigest = digestRecursiveDelegationHostEvidence(snapshot);
	} catch (error) {
		throw new Error("CONTRACT_CHANGE: recursive delegation host evidence is not canonical.", { cause: error });
	}
	const authHost: RecursiveDelegationHostComposition = {
		...host,
		authorizationToken: snapshot.authorizationToken,
		trustedNow: snapshot.trustedNow,
		currentStateDigest: snapshot.currentStateDigest,
		currentRevision: snapshot.currentRevision,
		epochRef: snapshot.epochRef,
		executionIdentity: snapshot.executionIdentity,
		sessionId: snapshot.sessionId,
	};
	const authorized = await authorizePlan(snapshot.request, authHost, evidenceDigest);
	const result = planInternal(
		snapshot.request,
		{
			...host,
			ceilings: snapshot.ceilings,
			hostEvidence: snapshot.hostEvidence,
			graphAuthority: snapshot.graphAuthority,
			currentState: snapshot.currentState,
			budget: snapshot.budget,
			workerModelBinding: snapshot.workerModelBinding,
			synthesisObligation: snapshot.synthesisObligation,
		},
		authorized.authorization,
		evidenceDigest,
		authorized.operationDigest,
	);
	if (result.durableIntentBatch !== null && host.persistIntentBatch === undefined)
		throw new Error(INTEGRATION_REQUIREMENT.contractChange);
	if (result.status === "admitted" && result.reservationIntent === null)
		throw new Error("CONTRACT_CHANGE: admitted recursive delegation plan has no reservation intent.");
	if (result.durableIntentBatch !== null) await host.persistIntentBatch!(result.durableIntentBatch);
	return result;
}

/**
 * Compatibility name for callers that already know the host adapter contract.
 * No structural authorizer is accepted; omission is an explicit contract change.
 */
export async function planAdaptiveRecursiveDelegation(
	input: RecursiveDelegationPolicyInput,
	host?: RecursiveDelegationHostComposition,
): Promise<RecursiveDelegationPolicyResult> {
	if (host === undefined) throw new Error(INTEGRATION_REQUIREMENT.contractChange);
	return planAdaptiveRecursiveDelegationFromHost(input, host);
}
