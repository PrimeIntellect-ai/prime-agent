import { createHmac } from "node:crypto";
import type { WorkflowAutoResearchEventPayload } from "./contracts.js";
import {
	canonicalJsonBytes,
	type DurableDecisionRef,
	type DurableStoreCrashBoundaryHook,
	digestObject,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowCommitReturnProof,
	type WorkflowControlCapacityVector,
	type WorkflowEpochRef,
	type WorkflowEventPayload,
	type WorkflowGenerationBinding,
	type WorkflowGenerationRotation,
	type WorkflowGoalMutationDelta,
	type WorkflowGoalStatus,
	type WorkflowJournalEvent,
	type WorkflowJournalHead,
	type WorkflowLeaseRef,
	type WorkflowPhaseId,
	type WorkflowQuarantineReason,
	type WorkflowRuntimeEventPayload,
	type WorkflowRuntimeStoreIdentity,
	type WorkflowSemanticHead,
	type WorkflowSemanticMutationBinding,
	type WorkflowStatus,
} from "./contracts.js";
import type { WorkflowJournalKey } from "./journal.js";
import {
	deriveWorkflowGenerationId,
	type WorkflowGenerationRotationRequest,
	type WorkflowJournalImpl,
	type WorkflowJournalKeyRotationInput,
} from "./journal.js";
import type { WorkflowQuarantineRecord, WorkflowRecoveryResult, WorkflowRecoverySource } from "./recovery.js";

export interface WorkflowState {
	workflowId: string;
	rootSessionId: string;
	status: WorkflowStatus;
	phase: WorkflowPhaseId;
	objective: string;
	goalId: string;
	goalActive: boolean;
	goalStatus: WorkflowGoalStatus;
	goalTokenBudget: number | null;
	goalTokensUsed: number;
	goalTimeUsedSeconds: number;
	goalContinuationsUsed: number;
	goalCreatedAt: number | null;
	goalUpdatedAt: number | null;
	goalLastReason: string | null;
	goalLastError: string | null;
	sourceJournalSequence: number;
	sourceJournalDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	goalProjectionDigest: string | null;
	capacityDigest: string | null;
	goalContractDigest: string | null;
	approvalRequest: WorkflowStateApprovalRequest | null;
	decisionRefs: readonly DurableDecisionRef[];
	profileDigest: string | null;
	configDigest: string | null;
	skillSnapshotDigests: readonly string[];
	cloudAvailabilityDigest: string | null;
	scorecardDigest: string | null;
	resourceEnvelopeDigest: string | null;
	continuityCapsuleDigest: string | null;
	provenRequirementIds: readonly string[];
	unprovenRequirementIds: readonly string[];
	regressedRequirementIds: readonly string[];
	workspaceDigest: string;
	executionProfile: "unresolved" | "inline" | "parallel";
	planRevision: number;
	acceptedEvidenceRefs: readonly WorkflowArtifactRef[];
	ownershipLeaseRefs: readonly WorkflowLeaseRef[];
	resourceLeaseRefs: readonly WorkflowLeaseRef[];
	failedStrategies: readonly string[];
	unresolvedDecisionRefs: readonly DurableDecisionRef[];
	continuationEntryPoint: string;
	generationBinding: WorkflowGenerationBinding;
}

type WorkflowStateApprovalRequest = Extract<WorkflowEventPayload, { kind: "approval_requested" }>["approval"];

export interface WorkflowCommitPrecondition {
	expectedSourceJournalDigest: string | null;
	expectedHead: WorkflowJournalHead;
	expectedEpoch: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	idempotencyKey: string;
	writerIdentity: string;
	executionKey: string | null;
	semanticBinding: WorkflowSemanticMutationBinding;
	crashHook?: DurableStoreCrashBoundaryHook;
}

export interface WorkflowTransitionPreview<TEvent> {
	nextState: TEvent;
	previewDigest: string;
	semanticHead: WorkflowSemanticHead;
}

export interface WorkflowDeferredEventOwnerValidators {
	autoresearch: (payload: WorkflowAutoResearchEventPayload, commit: WorkflowJournalEvent) => void;
	runtime: (payload: WorkflowRuntimeEventPayload, commit: WorkflowJournalEvent) => void;
	effect: (payload: WorkflowRuntimeEventPayload, commit: WorkflowJournalEvent) => void;
	recovery: (
		payload: WorkflowRuntimeEventPayload | WorkflowAutoResearchEventPayload,
		commit: WorkflowJournalEvent,
	) => void;
}

export class WorkflowReplayValidationError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "WorkflowReplayValidationError";
		this.code = code;
	}
}

const ALLOWED_WORKFLOW_STATUS_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
	active: ["active", "awaiting_user", "paused", "budget_limited", "blocked", "failed", "cancelled", "complete"],
	awaiting_user: ["active", "paused", "blocked", "failed", "cancelled"],
	paused: ["active", "awaiting_user", "cancelled", "failed"],
	budget_limited: ["active", "cancelled", "failed"],
	blocked: ["active", "awaiting_user", "cancelled", "failed"],
	failed: [],
	cancelled: [],
	complete: [],
};

const WORKFLOW_STATUS_TO_GOAL_STATUS: Readonly<Record<WorkflowStatus, WorkflowGoalStatus>> = {
	active: "active",
	awaiting_user: "paused",
	paused: "paused",
	budget_limited: "budget_limited",
	blocked: "paused",
	failed: "error",
	cancelled: "paused",
	complete: "complete",
};

const AUTO_RESEARCH_EVENT_KINDS: ReadonlySet<string> = new Set([
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
	"run_archive_intent",
	"run_archived",
	"verified",
	"completion_audited",
	"refinement_recorded",
	"stop_requested",
	"budget_limited",
	"blocked",
	"target_reached",
	"verification_gap_found",
	"completed",
	"projection_committed",
]);

const EFFECT_EVENT_KINDS: ReadonlySet<string> = new Set([
	"workflow_effect_intent",
	"workflow_effect_completed",
	"workflow_effect_ambiguous",
]);

const RECOVERY_EVENT_KINDS: ReadonlySet<string> = new Set([
	"workflow_recovery_started",
	"workflow_reconciliation_recorded",
	"workflow_observation_outcome_recorded",
	"workflow_completion_cut_sealed",
	"workflow_late_observation_policy_recorded",
	"workflow_cancellation_intent",
	"workflow_cancellation_descendants_reconciled",
	"workflow_cancelled",
	"workflow_lease_quarantined",
	"recovery_classified",
	"candidate_reaped",
]);

const RUNTIME_EVENT_KINDS: ReadonlySet<string> = new Set([
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
	"workflow_cancellation_intent",
	"workflow_cancellation_descendants_reconciled",
	"workflow_cancelled",
	"checkpoint_budget_observed",
]);

function assertAllowedWorkflowStatus(current: WorkflowStatus, next: WorkflowStatus): void {
	if (!ALLOWED_WORKFLOW_STATUS_TRANSITIONS[current].includes(next))
		throw new Error(`Workflow status transition ${current} -> ${next} is not allowed.`);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function assertEpoch(epochRef: WorkflowEpochRef, name: string): void {
	if (
		!Number.isSafeInteger(epochRef.storeEpoch) ||
		!Number.isSafeInteger(epochRef.coordinatorEpoch) ||
		epochRef.storeEpoch < 1 ||
		epochRef.coordinatorEpoch < 1
	)
		throw new Error(`${name} is not a positive integer epoch tuple.`);
}

function isAutoResearchPayload(payload: WorkflowEventPayload): payload is WorkflowAutoResearchEventPayload {
	return AUTO_RESEARCH_EVENT_KINDS.has(payload.kind);
}

function isRuntimePayload(payload: WorkflowEventPayload): payload is WorkflowRuntimeEventPayload {
	return RUNTIME_EVENT_KINDS.has(payload.kind);
}

function isRuntimeOrAutoResearchPayload(
	payload: WorkflowEventPayload,
): payload is WorkflowRuntimeEventPayload | WorkflowAutoResearchEventPayload {
	return isRuntimePayload(payload) || isAutoResearchPayload(payload);
}

function assertGoalMutationDelta(
	state: WorkflowState,
	delta: WorkflowGoalMutationDelta,
	workflowStatus: WorkflowStatus,
): void {
	if (
		delta.status !== WORKFLOW_STATUS_TO_GOAL_STATUS[workflowStatus] ||
		delta.active !== (workflowStatus === "active") ||
		(delta.goalId !== null && state.goalId.length > 0 && delta.goalId !== state.goalId) ||
		(delta.objective !== null && state.objective.length > 0 && delta.objective !== state.objective) ||
		(delta.tokenBudget !== null && (!Number.isSafeInteger(delta.tokenBudget) || delta.tokenBudget < 0)) ||
		(state.goalTokenBudget !== null && delta.tokenBudget !== state.goalTokenBudget) ||
		!Number.isSafeInteger(delta.tokensUsed) ||
		delta.tokensUsed < state.goalTokensUsed ||
		(delta.tokenBudget !== null
			? delta.tokensUsed > delta.tokenBudget
			: state.goalTokenBudget !== null && delta.tokensUsed > state.goalTokenBudget) ||
		!Number.isFinite(delta.timeUsedSeconds) ||
		delta.timeUsedSeconds < state.goalTimeUsedSeconds ||
		!Number.isSafeInteger(delta.continuationsUsed) ||
		delta.continuationsUsed < state.goalContinuationsUsed ||
		(delta.createdAt !== null && !Number.isFinite(delta.createdAt)) ||
		(state.goalCreatedAt !== null && delta.createdAt !== state.goalCreatedAt) ||
		(delta.updatedAt !== null && !Number.isFinite(delta.updatedAt)) ||
		(state.goalUpdatedAt !== null && (delta.updatedAt === null || delta.updatedAt < state.goalUpdatedAt))
	)
		throw new Error("Workflow goal mutation is not bound to the workflow status or has regressed durable counters.");
}

function applyGoalMutationDelta(
	state: WorkflowState,
	delta: WorkflowGoalMutationDelta,
	workflowStatus: WorkflowStatus,
): WorkflowState {
	assertGoalMutationDelta(state, delta, workflowStatus);
	return {
		...state,
		goalId: delta.goalId ?? state.goalId,
		objective: delta.objective ?? state.objective,
		goalActive: delta.active,
		goalStatus: delta.status,
		goalTokenBudget: delta.tokenBudget,
		goalTokensUsed: delta.tokensUsed,
		goalTimeUsedSeconds: delta.timeUsedSeconds,
		goalContinuationsUsed: delta.continuationsUsed,
		goalCreatedAt: delta.createdAt,
		goalUpdatedAt: delta.updatedAt,
		goalLastReason: delta.lastReason,
		goalLastError: delta.lastError,
	};
}

function advanceEventMetadata(
	state: WorkflowState,
	commit: WorkflowJournalEvent,
	resultingEpoch: WorkflowEpochRef = commit.epochRef,
): WorkflowState {
	return {
		...state,
		sourceJournalSequence: commit.sequence,
		sourceJournalDigest: commit.eventDigest,
		storeEpoch: resultingEpoch.storeEpoch,
		coordinatorEpoch: resultingEpoch.coordinatorEpoch,
	};
}

export function validateWorkflowDeferredEventOwner(
	payload: WorkflowEventPayload,
	commit: WorkflowJournalEvent,
	validators: WorkflowDeferredEventOwnerValidators | undefined,
): void {
	if (!AUTO_RESEARCH_EVENT_KINDS.has(payload.kind) && !RUNTIME_EVENT_KINDS.has(payload.kind)) return;
	if (validators === undefined)
		throw new WorkflowReplayValidationError("workflow_replay_owner_validation_unavailable");
	if (AUTO_RESEARCH_EVENT_KINDS.has(payload.kind)) {
		if (!isAutoResearchPayload(payload)) throw new Error(`Event ${payload.kind} is not an AutoResearch payload.`);
		validators.autoresearch(payload, commit);
		return;
	}
	if (EFFECT_EVENT_KINDS.has(payload.kind)) {
		if (!isRuntimePayload(payload)) throw new Error(`Event ${payload.kind} is not a runtime payload.`);
		validators.effect(payload, commit);
		return;
	}
	if (RECOVERY_EVENT_KINDS.has(payload.kind)) {
		if (!isRuntimeOrAutoResearchPayload(payload)) throw new Error(`Event ${payload.kind} is not a recovery payload.`);
		validators.recovery(payload, commit);
		return;
	}
	if (!isRuntimePayload(payload)) throw new Error(`Event ${payload.kind} is not a runtime payload.`);
	validators.runtime(payload, commit);
}

function appendUniqueDecisionRefs(
	state: WorkflowState,
	refs: readonly DurableDecisionRef[],
): readonly DurableDecisionRef[] {
	const seen = new Set(state.decisionRefs.map((ref) => `${ref.decisionId}:${ref.revision}`));
	return [
		...state.decisionRefs,
		...refs.filter((ref) => {
			const key = `${ref.decisionId}:${ref.revision}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
	];
}

const WORKFLOW_CONTROL_CAPACITY_DIMENSIONS = [
	"processSlots",
	"childSessionSlots",
	"modelCallSlots",
	"modelInputTokens",
	"modelOutputTokens",
	"verificationSlots",
	"redTeamSlots",
	"recoverySlots",
] as const satisfies readonly (keyof WorkflowControlCapacityVector)[];

function sameWorkflowValue(left: unknown, right: unknown): boolean {
	try {
		return digestObject(left) === digestObject(right);
	} catch {
		return false;
	}
}

function isZeroWorkflowControlCapacity(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	return WORKFLOW_CONTROL_CAPACITY_DIMENSIONS.every((dimension) => Reflect.get(value, dimension) === 0);
}

function assertWorkflowResourceLeaseAcquisition(
	payload: Extract<WorkflowEventPayload, { kind: "workflow_resource_lease_acquired" }>,
	commit: WorkflowJournalEvent,
): void {
	const lease = payload.lease;
	const admission = lease.resourceAdmission;
	const grant = admission?.capacityGrant;
	const acquiredAt = typeof lease.acquiredAt === "string" ? Date.parse(lease.acquiredAt) : Number.NaN;
	const expiresAt = Date.parse(lease.expiresAt);
	if (
		lease.workflowId !== payload.workflowId ||
		lease.storeEpoch !== payload.epochRef.storeEpoch ||
		lease.coordinatorEpoch !== payload.epochRef.coordinatorEpoch ||
		lease.acquisitionEventSequence !== commit.sequence ||
		lease.status !== "active" ||
		lease.taskId === null ||
		lease.attemptId === null ||
		lease.leaseId !== `resource:${lease.workflowId}:${lease.attemptId}` ||
		lease.idempotencyKey !== `resource:${lease.attemptId}` ||
		!Number.isFinite(acquiredAt) ||
		!Number.isFinite(expiresAt) ||
		expiresAt <= acquiredAt ||
		grant === undefined ||
		admission.canonicalPoolLedgerRef === undefined ||
		admission.canonicalLedgerRef === undefined ||
		admission.controlCapacity === undefined ||
		admission.controlCapacityProjectionDigest === undefined ||
		admission.admitted !== true ||
		!Array.isArray(admission.unknownPoolIds) ||
		admission.unknownPoolIds.length !== 0
	)
		throw new Error("Workflow resource lease acquisition is not a complete admitted manager payload.");
	if (grant.kind !== "worker" && grant.kind !== "control")
		throw new Error("Workflow resource lease acquisition has an unknown capacity grant kind.");
	if (
		grant.grantId !== `grant:${lease.attemptId}` ||
		!sameWorkflowValue(grant.canonicalPoolLedgerRef, admission.canonicalPoolLedgerRef) ||
		!sameWorkflowValue(grant.canonicalPoolLedgerRef, admission.canonicalLedgerRef) ||
		admission.canonicalLedgerDigest !== admission.canonicalLedgerRef.digest ||
		!sameWorkflowValue(grant.resourceVector, admission.declaredVector) ||
		!sameWorkflowValue(grant.resourceVector, admission.hostDerivedConservativeVector) ||
		!sameWorkflowValue(grant.resourceVector, admission.reservedVector) ||
		!sameWorkflowValue(grant.controlCapacity, admission.controlCapacity) ||
		!sameWorkflowValue(grant.controlCapacity, lease.controlCapacity) ||
		!sameWorkflowValue(grant.controlCapacity, admission.declaredControlCapacity) ||
		!sameWorkflowValue(grant.controlCapacity, admission.hostDerivedControlCapacity) ||
		!sameWorkflowValue(grant.controlCapacity, admission.reservedControlCapacity) ||
		admission.derivationPolicyDigest !==
			digestObject({
				enforcementClass: admission.enforcementClass,
				controlPlane: grant.kind === "control",
			}) ||
		admission.controlCapacityProjectionDigest !== digestObject(grant.controlCapacity)
	)
		throw new Error("Workflow resource lease acquisition has a foreign grant, ledger, or control projection.");
	if (
		(grant.kind === "worker" &&
			(!isZeroWorkflowControlCapacity(grant.controlCapacity) ||
				!isZeroWorkflowControlCapacity(lease.controlCapacity) ||
				!isZeroWorkflowControlCapacity(lease.workerCapacity))) ||
		(grant.kind === "control" && !isZeroWorkflowControlCapacity(lease.workerCapacity))
	)
		throw new Error("Workflow resource lease acquisition has a control capacity in the wrong partition.");
}

function applyKnownWorkflowPayload(
	state: WorkflowState,
	payload: WorkflowEventPayload,
	commit: WorkflowJournalEvent,
	validators?: WorkflowDeferredEventOwnerValidators,
): WorkflowState {
	switch (payload.kind) {
		case "goal_binding_committed":
			if (
				payload.goalId.length === 0 ||
				payload.objective.length === 0 ||
				payload.goalDelta.goalId !== payload.goalId ||
				payload.goalDelta.objective !== payload.objective ||
				(state.goalId.length > 0 && payload.goalId !== state.goalId) ||
				(state.objective.length > 0 && payload.objective !== state.objective)
			)
				throw new Error("Workflow goal binding attempts to replace an existing goal identity or objective.");
			assertGoalMutationDelta(state, payload.goalDelta, state.status);
			return advanceEventMetadata(
				applyGoalMutationDelta(
					{ ...state, goalId: payload.goalId, objective: payload.objective },
					payload.goalDelta,
					state.status,
				),
				commit,
			);
		case "capacity_observed":
			return advanceEventMetadata(
				{ ...state, capacityDigest: payload.capacityDigest, phase: "discovering_capacity" },
				commit,
			);
		case "cloud_availability_observed":
			return advanceEventMetadata({ ...state, cloudAvailabilityDigest: digestObject(payload.response) }, commit);
		case "profile_selected":
			return advanceEventMetadata(
				{ ...state, profileDigest: payload.profileDigest, executionProfile: payload.resolvedProfile },
				commit,
			);
		case "configuration_snapshot_pinned":
			return advanceEventMetadata(
				{
					...state,
					configDigest: payload.configDigest,
					planRevision: Math.max(state.planRevision, payload.configRevision),
				},
				commit,
			);
		case "skill_snapshot_pinned":
			return advanceEventMetadata(
				{ ...state, skillSnapshotDigests: [...state.skillSnapshotDigests, payload.snapshotDigest] },
				commit,
			);
		case "goal_contract_proposed":
			return advanceEventMetadata(
				{
					...state,
					goalContractDigest: payload.contractDigest,
					decisionRefs: appendUniqueDecisionRefs(state, [payload.decisionRef]),
					phase: "hardening_goal",
				},
				commit,
			);
		case "scorecard_proposed":
			return advanceEventMetadata(
				{
					...state,
					scorecardDigest: payload.scorecardDigest,
					decisionRefs: appendUniqueDecisionRefs(state, [payload.decisionRef]),
					phase: "hardening_scorecard",
				},
				commit,
			);
		case "resource_envelope_proposed":
			return advanceEventMetadata(
				{
					...state,
					resourceEnvelopeDigest: payload.envelopeDigest,
					decisionRefs: appendUniqueDecisionRefs(state, [payload.decisionRef]),
					phase: "adjudicating",
				},
				commit,
			);
		case "approval_requested":
			if (
				payload.awaitingUser.expectedHeadDigest !== state.sourceJournalDigest ||
				!sameEpoch(payload.awaitingUser.expectedEpoch, currentEpoch(state)) ||
				payload.approval.stateDigest.length === 0 ||
				!sameEpoch(
					{ storeEpoch: payload.approval.storeEpoch, coordinatorEpoch: payload.approval.coordinatorEpoch },
					currentEpoch(state),
				)
			)
				throw new Error("Approval request is not bound to the authenticated current head and epoch tuple.");
			assertAllowedWorkflowStatus(state.status, payload.awaitingUser.status);
			return advanceEventMetadata(
				applyGoalMutationDelta(
					{
						...state,
						approvalRequest: payload.approval,
						decisionRefs: [...payload.approval.decisionRefs],
						status: payload.awaitingUser.status,
						phase: payload.awaitingUser.phase,
					},
					payload.awaitingUser.goalDelta,
					payload.awaitingUser.status,
				),
				commit,
			);
		case "approval_consumed":
			if (
				state.approvalRequest?.approvalRequestId !== payload.receipt.approvalRequestId ||
				state.approvalRequest.stateDigest !== payload.receipt.stateDigest ||
				payload.resumeTransition.expectedStateDigest !== payload.receipt.stateDigest ||
				payload.resumeTransition.expectedHeadDigest !== state.sourceJournalDigest ||
				!sameEpoch(payload.resumeTransition.expectedEpoch, currentEpoch(state))
			)
				throw new Error("Approval consumption is not bound to the current request, head, and epoch tuple.");
			assertAllowedWorkflowStatus(state.status, payload.resumeTransition.status);
			return advanceEventMetadata(
				{
					...state,
					approvalRequest: null,
					decisionRefs: [...payload.receipt.decisionRefs],
					status: payload.resumeTransition.status,
					phase: payload.resumeTransition.phase,
				},
				commit,
			);
		case "approval_epoch_reanchored":
			// A coordinator-epoch fence advances the live epoch without touching the pending approval
			// request, which stays bound (decision refs, headless signature, one-use secret) to the
			// epoch it was requested under. This event only re-baselines the durable head that
			// consumption freshness is checked against; it must never rewrite the request itself.
			if (
				payload.workflowId !== state.workflowId ||
				state.status !== "awaiting_user" ||
				state.approvalRequest?.approvalRequestId !== payload.approvalRequestId ||
				state.approvalRequest.stateDigest !== payload.stateDigest ||
				!sameEpoch(payload.nextEpoch, currentEpoch(state))
			)
				throw new Error("Approval epoch reanchor is not bound to the pending request and the live epoch.");
			return advanceEventMetadata(state, commit);
		case "fresh_planner_started":
			if (
				payload.workflowId !== state.workflowId ||
				payload.stateDigest !== state.sourceJournalDigest ||
				!sameEpoch(payload.epochRef, currentEpoch(state))
			)
				throw new Error("Fresh planner transition is not bound to the consumed approval state.");
			return advanceEventMetadata({ ...state, phase: "planning", status: "active", approvalRequest: null }, commit);
		case "resource_approved":
			return advanceEventMetadata(
				{
					...state,
					resourceEnvelopeDigest: payload.envelopeDigest,
					approvalRequest: null,
					decisionRefs: [...payload.receipt.decisionRefs],
					phase: "planning",
				},
				commit,
			);
		case "workflow_status_changed":
			assertAllowedWorkflowStatus(state.status, payload.status);
			return advanceEventMetadata(
				applyGoalMutationDelta(
					{ ...state, status: payload.status, phase: payload.phase },
					payload.goalDelta,
					payload.status,
				),
				commit,
			);
		case "goal_projection_applied":
			if (
				payload.binding.workflowId !== state.workflowId ||
				payload.binding.eventSequence !== commit.sequence ||
				payload.binding.storeEpoch !== commit.epochRef.storeEpoch ||
				payload.binding.coordinatorEpoch !== commit.epochRef.coordinatorEpoch
			)
				throw new Error("Goal projection binding is not attached to the committed workflow event.");
			return advanceEventMetadata(
				applyGoalMutationDelta(
					{ ...state, goalProjectionDigest: payload.goalDigest },
					payload.goalDelta,
					state.status,
				),
				commit,
			);
		case "continuity_capsule_published":
			return advanceEventMetadata({ ...state, continuityCapsuleDigest: payload.capsuleDigest }, commit);
		case "store_generation_fenced":
			return applyStoreGenerationFence(state, payload, commit);
		case "coordinator_epoch_fenced":
			return applyCoordinatorEpochFence(state, payload, commit);
		case "workflow_started":
			throw new Error("workflow_started is valid only when initializing an empty store.");
		case "target_reached":
			validateWorkflowDeferredEventOwner(payload, commit, validators);
			return advanceEventMetadata({ ...state, phase: "verifying" }, commit);
		case "verification_gap_found":
			validateWorkflowDeferredEventOwner(payload, commit, validators);
			assertAllowedWorkflowStatus(state.status, "paused");
			return advanceEventMetadata({ ...state, status: "paused", phase: "recovering" }, commit);
		case "completed":
			validateWorkflowDeferredEventOwner(payload, commit, validators);
			assertAllowedWorkflowStatus(state.status, "complete");
			return advanceEventMetadata({ ...state, status: "complete", phase: "auditing_completion" }, commit);
		case "budget_limited":
			validateWorkflowDeferredEventOwner(payload, commit, validators);
			assertAllowedWorkflowStatus(state.status, "budget_limited");
			return advanceEventMetadata({ ...state, status: "budget_limited", phase: "recovering" }, commit);
		case "blocked":
			validateWorkflowDeferredEventOwner(payload, commit, validators);
			assertAllowedWorkflowStatus(state.status, "blocked");
			return advanceEventMetadata({ ...state, status: "blocked", phase: "recovering" }, commit);
		case "workflow_cancelled":
			validateWorkflowDeferredEventOwner(payload, commit, validators);
			assertAllowedWorkflowStatus(state.status, "cancelled");
			return advanceEventMetadata({ ...state, status: "cancelled", phase: "recovering" }, commit);
		case "checkpoint_budget_observed":
			if (
				payload.workflowId !== state.workflowId ||
				payload.head.workflowId !== state.workflowId ||
				payload.head.sequence !== state.sourceJournalSequence ||
				payload.head.eventDigest !== state.sourceJournalDigest ||
				!sameEpoch(payload.epochRef, currentEpoch(state)) ||
				!sameEpoch(payload.head.epochRef, currentEpoch(state))
			)
				throw new Error("Checkpoint budget observation is not bound to the authenticated current workflow head.");
			return advanceEventMetadata(state, commit);
		case "scorecard_red_teamed":
		case "scorecard_approved":
		case "initialization_intent":
		case "projection_intent":
		case "frontier_init_intent":
		case "frontier_initialized":
		case "baseline_intent":
		case "initialized":
		case "projection_committed":
		case "lease_renewed":
		case "candidate_claim_intent":
		case "candidate_dispatched":
		case "candidate_handoff_published":
		case "finish_intent":
		case "metric_recorded":
		case "guard_recorded":
		case "admission_lock_acquired":
		case "stale_rebase_requested":
		case "remeasured":
		case "candidate_red_teamed":
		case "frontier_update_intent":
		case "candidate_admitted":
		case "candidate_discarded":
		case "admission_lock_released":
		case "candidate_abandoned":
		case "candidate_reaped":
		case "recovery_classified":
		case "candidate_target_observed":
		case "run_archive_intent":
		case "run_archived":
		case "verified":
		case "completion_audited":
		case "refinement_recorded":
		case "stop_requested":
			validateWorkflowDeferredEventOwner(payload, commit, validators);
			return advanceEventMetadata(state, commit);
		case "workflow_coordinator_lease_acquired":
		case "workflow_coordinator_lease_renewed":
		case "workflow_coordinator_fenced":
		case "workflow_dispatch_readiness_observed":
		case "workflow_ownership_lease_acquired":
		case "workflow_task_lease_heartbeat":
		case "workflow_dispatch_intent":
		case "workflow_child_identity_bound":
		case "workflow_child_outcome_committed":
		case "workflow_external_blocker_recorded":
		case "workflow_external_blocker_resolved":
		case "workflow_effect_intent":
		case "workflow_effect_completed":
		case "workflow_effect_ambiguous":
		case "workflow_process_group_owned":
		case "workflow_process_group_fenced":
		case "workflow_process_group_reaped":
		case "workflow_lease_release_recorded":
		case "workflow_lease_quarantined":
		case "workflow_scheduler_observation":
		case "workflow_progress_lease_acquired":
		case "workflow_progress_stalled":
		case "workflow_progress_lease_closed":
		case "workflow_progress_recovery_started":
		case "workflow_recovery_started":
		case "workflow_reconciliation_recorded":
		case "workflow_observation_outcome_recorded":
		case "workflow_completion_cut_sealed":
		case "workflow_late_observation_policy_recorded":
		case "workflow_cancellation_intent":
		case "workflow_cancellation_descendants_reconciled":
			validateWorkflowDeferredEventOwner(payload, commit, validators);
			return advanceEventMetadata(
				payload.kind === "workflow_recovery_started" ? { ...state, phase: "recovering" } : state,
				commit,
			);
		case "workflow_resource_lease_acquired":
			assertWorkflowResourceLeaseAcquisition(payload, commit);
			validateWorkflowDeferredEventOwner(payload, commit, validators);
			return advanceEventMetadata(state, commit);
		case "adaptive_observed":
		case "adaptive_observation_coalesced":
		case "adaptive_observation_superseded":
		case "adaptive_observation_stale":
		case "adaptive_observation_cancelled":
		case "adaptive_controller_recovered":
		case "adaptive_reconciled":
		case "adaptive_allocation_intent":
		case "adaptive_allocation_applied":
		case "adaptive_allocation_uncertain":
		case "adaptive_allocation_reconciled":
		case "adaptive_review_started":
		case "adaptive_review_completed":
		case "adaptive_review_cancelled":
		case "adaptive_review_fenced":
		case "adaptive_review_recovered":
		case "adaptive_review_stale_result":
		case "adaptive_allocation_reserved":
		case "adaptive_allocation_reallocated":
		case "adaptive_measured":
		case "adaptive_rollback_applied":
		case "improvement_proposed":
		case "improvement_reviewed":
		case "policy_revision_recorded":
		case "efficiency_red_team_scheduled":
		case "efficiency_red_team_snapshot_published":
		case "efficiency_red_team_started":
		case "efficiency_red_team_completed":
		case "efficiency_red_team_overlap_rejected":
		case "efficiency_red_team_catch_up_consumed":
		case "efficiency_red_team_failed":
		case "efficiency_red_team_suggestion_recorded":
			return advanceEventMetadata(state, commit);
		case "knowledge_record_committed":
			return advanceEventMetadata(state, commit);
		default: {
			const exhaustivePayload: never = payload;
			throw new Error(`Unknown workflow event kind: ${String(exhaustivePayload)}`);
		}
	}
}

function currentEpoch(state: WorkflowState): WorkflowEpochRef {
	return { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch };
}

function workflowEventDigest(event: WorkflowJournalEvent): string {
	return sha256Hex(
		canonicalJsonBytes({
			workflowId: event.workflowId,
			sequence: event.sequence,
			payloadBytes: Array.from(event.payloadBytes),
			priorEventDigest: event.priorEventDigest,
			idempotencyKey: event.idempotencyKey,
			semanticBinding: event.semanticBinding,
		}),
	);
}

function workflowCommitReturnProofDigest(proof: WorkflowCommitReturnProof): string {
	const { proofDigest: _proofDigest, ...unsigned } = proof;
	return digestObject(unsigned);
}

function assertPayloadIdentity(
	payload: WorkflowEventPayload,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	executionKey: string | null,
): void {
	const declaredWorkflowId = "workflowId" in payload ? payload.workflowId : null;
	if (declaredWorkflowId !== null && declaredWorkflowId !== workflowId)
		throw new Error("Workflow payload identity is foreign.");
	if ("executionKey" in payload && payload.executionKey !== executionKey)
		throw new Error("Workflow payload execution key is not bound to the committed event.");
	if ("epochRef" in payload && !sameEpoch(payload.epochRef, epochRef))
		throw new Error("Workflow payload epoch is not bound to the committed event.");
}

function applyStoreGenerationFence(
	state: WorkflowState,
	payload: Extract<WorkflowEventPayload, { kind: "store_generation_fenced" }>,
	commit: WorkflowJournalEvent,
): WorkflowState {
	if (
		payload.workflowId !== state.workflowId ||
		!sameEpoch(payload.priorEpoch, currentEpoch(state)) ||
		payload.nextEpoch.storeEpoch !== payload.storeEpoch ||
		payload.nextEpoch.storeEpoch !== state.storeEpoch + 1 ||
		payload.nextEpoch.coordinatorEpoch !== state.coordinatorEpoch ||
		digestObject(payload.priorLeaseRef) !== digestObject(commit.leaseRef) ||
		payload.nextLeaseRef.storeEpoch !== payload.nextEpoch.storeEpoch ||
		payload.nextLeaseRef.coordinatorEpoch !== payload.nextEpoch.coordinatorEpoch ||
		payload.nextLeaseRef.writerIdentity !== payload.generationBinding.writerIdentity ||
		payload.generationId.length === 0
	)
		throw new Error("Store-generation fence is not bound to the exact predecessor and successor tuples.");
	return advanceEventMetadata({ ...state, generationBinding: payload.generationBinding }, commit, payload.nextEpoch);
}

function applyCoordinatorEpochFence(
	state: WorkflowState,
	payload: Extract<WorkflowEventPayload, { kind: "coordinator_epoch_fenced" }>,
	commit: WorkflowJournalEvent,
): WorkflowState {
	if (
		payload.workflowId !== state.workflowId ||
		!sameEpoch(payload.priorEpoch, currentEpoch(state)) ||
		payload.nextEpoch.coordinatorEpoch !== payload.coordinatorEpoch ||
		payload.nextEpoch.coordinatorEpoch !== state.coordinatorEpoch + 1 ||
		payload.nextEpoch.storeEpoch !== state.storeEpoch ||
		digestObject(payload.priorLeaseRef) !== digestObject(commit.leaseRef) ||
		payload.nextLeaseRef.storeEpoch !== payload.nextEpoch.storeEpoch ||
		payload.nextLeaseRef.coordinatorEpoch !== payload.nextEpoch.coordinatorEpoch ||
		payload.nextLeaseRef.writerIdentity !== payload.generationBinding.writerIdentity ||
		payload.generationId.length === 0
	)
		throw new Error("Coordinator fence is not bound to the exact predecessor and successor tuples.");
	return advanceEventMetadata({ ...state, generationBinding: payload.generationBinding }, commit, payload.nextEpoch);
}

function assertCommitBinding(
	state: WorkflowState | null,
	payload: WorkflowEventPayload,
	commit: WorkflowJournalEvent,
	replaying: boolean,
): void {
	if (
		commit.kind !== payload.kind ||
		commit.eventType !== payload.kind ||
		commit.workflowId.length === 0 ||
		commit.idempotencyKey.length === 0 ||
		commit.writerIdentity.length === 0 ||
		commit.returnProofId !== `return-proof:${commit.idempotencyKey}` ||
		commit.payloadDigest !== digestObject(payload) ||
		sha256Hex(commit.payloadBytes) !== sha256Hex(canonicalJsonBytes(payload)) ||
		commit.eventDigest !== workflowEventDigest(commit) ||
		commit.eventDigest.length === 0 ||
		commit.recordVersion !== 1 ||
		commit.generationId.length === 0 ||
		commit.keyId.length === 0 ||
		commit.preparedFrameDigest.length === 0 ||
		commit.committedFrameDigest.length === 0 ||
		commit.preparedFrameMac.length === 0 ||
		commit.committedFrameMac.length === 0 ||
		commit.preparedFrameChecksum.length === 0 ||
		commit.committedFrameChecksum.length === 0 ||
		commit.recordMac.length === 0 ||
		commit.recordChecksum.length === 0 ||
		commit.leaseRef.writerIdentity !== commit.writerIdentity ||
		!sameEpoch(commit.leaseRef, commit.epochRef) ||
		commit.expectedHead.workflowId !== commit.workflowId ||
		!sameEpoch(commit.expectedHead.epochRef, commit.epochRef) ||
		commit.sequence < 1 ||
		commit.expectedHead.sequence !== commit.sequence - 1 ||
		commit.priorEventDigest !== commit.expectedHead.eventDigest ||
		commit.semanticBinding.mutationId.length === 0 ||
		commit.semanticBinding.baselineDigest.length === 0 ||
		commit.semanticBinding.ownerId.length === 0 ||
		commit.semanticBinding.phase.length === 0 ||
		commit.semanticBinding.reducerDigest.length === 0 ||
		commit.semanticBinding.semanticHead.workflowId !== commit.workflowId ||
		commit.semanticBinding.semanticHead.sequence !== commit.expectedHead.sequence ||
		commit.semanticBinding.semanticHead.eventDigest !== commit.expectedHead.eventDigest ||
		!sameEpoch(commit.semanticBinding.semanticHead.epochRef, commit.expectedHead.epochRef) ||
		digestObject(commit.semanticBinding.expectedHead) !== digestObject(commit.expectedHead) ||
		!sameEpoch(commit.semanticBinding.epochRef, commit.epochRef) ||
		digestObject(commit.semanticBinding.leaseRef) !== digestObject(commit.leaseRef) ||
		commit.semanticBinding.idempotencyKey !== commit.idempotencyKey ||
		commit.semanticBinding.executionKey !== commit.executionKey ||
		commit.semanticBinding.writerIdentity !== commit.writerIdentity
	)
		throw new Error(
			"Workflow journal event is not bound to its exact authenticated head, lease, writer, execution, or idempotency tuple.",
		);
	const proof = commit.commitReturnProof;
	if (
		proof.recordVersion !== commit.recordVersion ||
		proof.generationId !== commit.generationId ||
		proof.mutationId !== commit.returnProofId ||
		proof.workflowId !== commit.workflowId ||
		proof.sequence !== commit.sequence ||
		proof.eventDigest !== commit.eventDigest ||
		proof.committedFrameDigest !== commit.committedFrameDigest ||
		digestObject(proof.expectedHead) !== digestObject(commit.expectedHead) ||
		!sameEpoch(proof.epochRef, commit.epochRef) ||
		digestObject(proof.leaseRef) !== digestObject(commit.leaseRef) ||
		proof.writerIdentity !== commit.writerIdentity ||
		proof.idempotencyKey !== commit.idempotencyKey ||
		proof.keyId !== commit.keyId ||
		proof.frameMac !== commit.committedFrameMac ||
		proof.frameChecksum !== commit.committedFrameChecksum ||
		proof.recordMac !== commit.recordMac ||
		proof.recordChecksum !== commit.recordChecksum ||
		proof.priorRecordDigest !== commit.priorEventDigest ||
		proof.proofDigest !== workflowCommitReturnProofDigest(proof)
	)
		throw new Error("Workflow commit return proof is not bound to the committed event tuple.");
	assertPayloadIdentity(payload, commit.workflowId, commit.epochRef, commit.executionKey);
	if (state !== null) {
		if (commit.workflowId !== state.workflowId) throw new Error("Workflow event identity is invalid.");
		if (!replaying) {
			if (
				commit.expectedHead.sequence !== state.sourceJournalSequence ||
				commit.expectedHead.eventDigest !== state.sourceJournalDigest
			)
				throw new Error("Workflow event head is stale.");
		}
		if (
			commit.kind !== "coordinator_epoch_fenced" &&
			commit.kind !== "store_generation_fenced" &&
			commit.writerIdentity !== state.generationBinding.writerIdentity
		)
			throw new Error("Workflow event writer identity is fenced.");
	} else if (commit.sequence !== 1 || commit.expectedHead.eventDigest !== null) {
		throw new Error("Workflow initialization event does not start at the empty journal head.");
	}
}

export function reduceWorkflowEvent(
	state: WorkflowState | null,
	payload: WorkflowEventPayload,
	commit: WorkflowJournalEvent,
	validators?: WorkflowDeferredEventOwnerValidators,
): WorkflowState {
	const replaying =
		state !== null &&
		state.sourceJournalSequence === commit.sequence &&
		state.sourceJournalDigest === commit.eventDigest;
	assertCommitBinding(state, payload, commit, replaying);
	if (replaying) {
		validateWorkflowDeferredEventOwner(payload, commit, validators);
		return state;
	}
	assertEpoch(commit.epochRef, "Committed event epoch");
	if (state === null) {
		if (payload.kind !== "workflow_started")
			throw new Error("Workflow event requires workflow_started initialization.");
		return {
			workflowId: payload.workflowId,
			rootSessionId: payload.rootSessionId,
			status: "active",
			phase: "hardening_goal",
			objective: payload.objective,
			goalId: "",
			goalActive: false,
			goalStatus: "idle",
			goalTokenBudget: null,
			goalTokensUsed: 0,
			goalTimeUsedSeconds: 0,
			goalContinuationsUsed: 0,
			goalCreatedAt: null,
			goalUpdatedAt: null,
			goalLastReason: null,
			goalLastError: null,
			sourceJournalSequence: commit.sequence,
			sourceJournalDigest: commit.eventDigest,
			storeEpoch: commit.epochRef.storeEpoch,
			coordinatorEpoch: commit.epochRef.coordinatorEpoch,
			goalProjectionDigest: null,
			capacityDigest: null,
			goalContractDigest: null,
			approvalRequest: null,
			decisionRefs: [],
			profileDigest: null,
			configDigest: null,
			skillSnapshotDigests: [],
			cloudAvailabilityDigest: null,
			scorecardDigest: null,
			resourceEnvelopeDigest: null,
			continuityCapsuleDigest: null,
			provenRequirementIds: [],
			unprovenRequirementIds: [],
			regressedRequirementIds: [],
			workspaceDigest: "",
			executionProfile: "unresolved",
			planRevision: 0,
			acceptedEvidenceRefs: [],
			ownershipLeaseRefs: [],
			resourceLeaseRefs: [],
			failedStrategies: [],
			unresolvedDecisionRefs: [],
			continuationEntryPoint: "hardening_goal",
			generationBinding: {
				writerIdentity: commit.writerIdentity,
				processGenerationId: commit.writerIdentity,
				ownerIdentity: commit.writerIdentity,
			},
		};
	}
	if (commit.epochRef.storeEpoch < state.storeEpoch || commit.epochRef.coordinatorEpoch < state.coordinatorEpoch)
		throw new Error("Workflow event epoch is stale.");
	const isStoreFence = payload.kind === "store_generation_fenced";
	const isCoordinatorFence = payload.kind === "coordinator_epoch_fenced";
	if (!isStoreFence && commit.epochRef.storeEpoch !== state.storeEpoch)
		throw new Error("Future store epoch requires an explicit store-generation fence.");
	if (!isCoordinatorFence && commit.epochRef.coordinatorEpoch !== state.coordinatorEpoch)
		throw new Error("Future coordinator epoch requires an explicit coordinator fence.");
	if (
		isStoreFence &&
		(!sameEpoch(commit.epochRef, currentEpoch(state)) ||
			payload.nextEpoch.storeEpoch !== commit.epochRef.storeEpoch + 1)
	)
		throw new Error("Store-generation fence event epoch is invalid.");
	if (
		isCoordinatorFence &&
		(!sameEpoch(commit.epochRef, currentEpoch(state)) ||
			payload.nextEpoch.coordinatorEpoch !== commit.epochRef.coordinatorEpoch + 1)
	)
		throw new Error("Coordinator fence event epoch is invalid.");
	return applyKnownWorkflowPayload(state, payload, commit, validators);
}

function workflowHead(
	events: readonly WorkflowJournalEvent[],
	epochRef: WorkflowEpochRef,
	workflowId: string,
): WorkflowJournalHead {
	const last = events.at(-1);
	return last === undefined
		? { workflowId, sequence: 0, eventDigest: null, epochRef }
		: {
				workflowId: last.workflowId,
				sequence: last.sequence,
				eventDigest: last.eventDigest,
				epochRef:
					last.payload.kind === "store_generation_fenced" || last.payload.kind === "coordinator_epoch_fenced"
						? last.payload.nextEpoch
						: last.epochRef,
			};
}

function assertPreconditionTuple(
	store: WorkflowStore,
	state: WorkflowState | null,
	precondition: WorkflowCommitPrecondition,
	head: WorkflowJournalHead,
): void {
	if (
		precondition.expectedHead.workflowId !== head.workflowId ||
		precondition.expectedHead.sequence !== head.sequence ||
		precondition.expectedHead.eventDigest !== head.eventDigest ||
		!sameEpoch(precondition.expectedHead.epochRef, head.epochRef) ||
		precondition.expectedSourceJournalDigest !== (state?.sourceJournalDigest ?? null) ||
		!sameEpoch(precondition.expectedEpoch, head.epochRef) ||
		precondition.expectedEpoch.storeEpoch !== store.journal.options.epoch.storeEpoch ||
		precondition.expectedEpoch.coordinatorEpoch !== store.journal.options.epoch.coordinatorEpoch ||
		precondition.writerIdentity !== store.journal.options.writerIdentity ||
		digestObject(precondition.leaseRef) !== digestObject(store.journal.options.leaseRef) ||
		precondition.leaseRef.writerIdentity !== precondition.writerIdentity ||
		precondition.idempotencyKey.length === 0
	)
		throw new Error(
			"Workflow store compare-and-swap precondition is stale or is not bound to the active writer and lease.",
		);
	const binding = precondition.semanticBinding;
	if (
		binding.mutationId.length === 0 ||
		binding.baselineDigest.length === 0 ||
		binding.ownerId.length === 0 ||
		binding.phase.length === 0 ||
		binding.reducerDigest.length === 0 ||
		binding.semanticHead.workflowId !== head.workflowId ||
		binding.semanticHead.sequence !== head.sequence ||
		binding.semanticHead.eventDigest !== head.eventDigest ||
		digestObject(binding.expectedHead) !== digestObject(precondition.expectedHead) ||
		!sameEpoch(binding.epochRef, precondition.expectedEpoch) ||
		digestObject(binding.leaseRef) !== digestObject(precondition.leaseRef) ||
		binding.idempotencyKey !== precondition.idempotencyKey ||
		binding.executionKey !== precondition.executionKey ||
		binding.writerIdentity !== precondition.writerIdentity
	)
		throw new Error("Workflow semantic owner, phase, reducer, and CAS tuple are not identical.");
}

function assertExistingIdempotency(
	existing: WorkflowJournalEvent,
	payload: WorkflowEventPayload,
	precondition: WorkflowCommitPrecondition,
): void {
	if (
		existing.payloadDigest !== digestObject(payload) ||
		existing.workflowId !== precondition.expectedHead.workflowId ||
		digestObject(existing.expectedHead) !== digestObject(precondition.expectedHead) ||
		existing.executionKey !== precondition.executionKey ||
		existing.writerIdentity !== precondition.writerIdentity ||
		digestObject(existing.leaseRef) !== digestObject(precondition.leaseRef) ||
		digestObject(existing.epochRef) !== digestObject(precondition.expectedEpoch) ||
		digestObject(existing.semanticBinding) !== digestObject(precondition.semanticBinding) ||
		existing.returnProofId !== `return-proof:${precondition.idempotencyKey}`
	)
		throw new Error("Workflow store idempotency key conflicts with a different authenticated mutation.");
}

function assertRootSessionScope(payload: WorkflowEventPayload, rootSessionId: string): void {
	if ("rootSessionId" in payload && payload.rootSessionId !== rootSessionId)
		throw new Error("Workflow event rootSessionId is outside the validated publication scope.");
	const decisionRefs = [
		...("decisionRef" in payload ? [payload.decisionRef] : []),
		...("decisionRefs" in payload ? payload.decisionRefs : []),
		...("approval" in payload && payload.approval !== null
			? [payload.approval.decisionRef, ...payload.approval.decisionRefs]
			: []),
		...("receipt" in payload && payload.receipt !== null
			? [payload.receipt.decisionRef, ...payload.receipt.decisionRefs]
			: []),
	];
	if (
		decisionRefs.some(
			(ref) => "rootSessionId" in ref.decisionScope && ref.decisionScope.rootSessionId !== rootSessionId,
		)
	)
		throw new Error("Nested decision scope rootSessionId is outside the validated publication scope.");
}

async function reloadWorkflowStore(store: WorkflowStore): Promise<WorkflowState | null> {
	const recovery = await store.journal.recover();
	if (recovery.quarantined) {
		throw new Error(`Workflow store cannot replay a quarantined journal: ${recovery.metadata.reason}.`);
	}
	let state: WorkflowState | null = null;
	const events = await store.journal.replayLogicalHistory();
	for (const event of events) {
		assertRootSessionScope(event.payload, store.rootSessionId);
		if (state === null && event.payload.kind === "knowledge_record_committed") continue;
		state = reduceWorkflowEvent(state, event.payload, event, store.deferredValidators);
	}
	store.state = state;
	return state;
}

async function commitWorkflowStore(
	store: WorkflowStore,
	payload: WorkflowEventPayload,
	precondition: WorkflowCommitPrecondition,
): Promise<WorkflowState> {
	const events = await store.journal.replayLogicalHistory();
	const state = await reloadWorkflowStore(store);
	const existing = events.find((event) => event.idempotencyKey === precondition.idempotencyKey);
	if (existing !== undefined) {
		assertExistingIdempotency(existing, payload, precondition);
		if (
			precondition.expectedEpoch.storeEpoch !== store.journal.options.epoch.storeEpoch ||
			precondition.expectedEpoch.coordinatorEpoch !== store.journal.options.epoch.coordinatorEpoch ||
			precondition.writerIdentity !== store.journal.options.writerIdentity ||
			digestObject(precondition.leaseRef) !== digestObject(store.journal.options.leaseRef)
		)
			throw new Error("Workflow idempotency retry is not bound to the active epoch, writer, and lease.");
		if (state === null) throw new Error("Workflow idempotency record exists without a replayable state.");
		return state;
	}
	const head = workflowHead(events, store.journal.options.epoch, precondition.expectedHead.workflowId);
	assertPreconditionTuple(store, state, precondition, head);
	assertPayloadIdentity(
		payload,
		store.journal.options.workflowId,
		precondition.expectedEpoch,
		precondition.executionKey,
	);
	if ((state === null) !== (payload.kind === "workflow_started"))
		throw new Error(
			state === null
				? "Workflow event requires workflow_started initialization."
				: "workflow_started is valid only when initializing an empty store.",
		);
	const event = await store.journal.append({
		workflowId: precondition.expectedHead.workflowId,
		payload,
		expectedHead: precondition.expectedHead,
		epochRef: precondition.expectedEpoch,
		leaseRef: precondition.leaseRef,
		idempotencyKey: precondition.idempotencyKey,
		writerIdentity: precondition.writerIdentity,
		executionKey: precondition.executionKey,
		semanticBinding: precondition.semanticBinding,
		returnProofId: `return-proof:${precondition.idempotencyKey}`,
		crashHook: precondition.crashHook,
	});
	const next = reduceWorkflowEvent(state, event.payload, event, store.deferredValidators);
	store.state = next;
	return next;
}

function createLeaseRef(
	state: WorkflowState,
	nextEpoch: WorkflowEpochRef,
	binding: WorkflowGenerationBinding,
	rootDigest: string,
	issuedAt: string,
): WorkflowLeaseRef {
	const issuedAtMilliseconds = Date.parse(issuedAt);
	if (!Number.isFinite(issuedAtMilliseconds))
		throw new Error("Workflow epoch replacement requires a finite host timestamp.");
	return {
		...nextEpoch,
		leaseId: binding.processGenerationId,
		acquisitionEventSequence: state.sourceJournalSequence + 1,
		processIdentity: binding.processGenerationId,
		rootDigest,
		writerIdentity: binding.writerIdentity,
		acquiredAt: issuedAt,
		expiresAt: new Date(issuedAtMilliseconds + 60_000).toISOString(),
	};
}

function createRotationRequest(
	store: WorkflowStore,
	state: WorkflowState,
	nextEpoch: WorkflowEpochRef,
	binding: WorkflowGenerationBinding,
	previousKey: WorkflowJournalKey,
	nextKey: WorkflowJournalKey,
	priorRecordDigest: string | null,
	identity: WorkflowRotationIdentity,
): WorkflowGenerationRotationRequest {
	const { previousEpoch, expectedHead, expectedHeadDigest, rotationId, mutationId } = identity;
	const generationId = deriveWorkflowGenerationId({
		workflowId: state.workflowId,
		nextEpoch,
		rotationId,
		priorHeadDigest: expectedHeadDigest,
	});
	if (nextKey.generationId !== generationId)
		throw new Error(
			"Workflow key provider did not issue the authenticated successor generation expected by the fence.",
		);
	const nextLeaseRef = createLeaseRef(
		state,
		nextEpoch,
		binding,
		store.journal.descriptorContext.rootDigest,
		store.journal.options.now(),
	);
	const authenticatedTuple = {
		workflowId: state.workflowId,
		rotationId,
		mutationId,
		idempotencyKey: mutationId,
		expectedHeadDigest,
		previousEpoch,
		nextEpoch,
		previousGenerationId: store.journal.descriptorContext.generationId,
		generationId,
		previousWriterIdentity: state.generationBinding.writerIdentity,
		previousLeaseRef: store.journal.options.leaseRef,
		nextLeaseRef,
		generationBinding: binding,
	};
	const previousFrameBytes = canonicalJsonBytes({ role: "predecessor", authenticatedTuple });
	const nextFrameBytes = canonicalJsonBytes({ role: "successor", authenticatedTuple });
	const previousFrameMac = createHmac("sha256", previousKey.secret).update(previousFrameBytes).digest("hex");
	const previousFrameChecksum = sha256Hex(previousFrameBytes).slice(0, 8);
	const frameMac = createHmac("sha256", nextKey.secret).update(nextFrameBytes).digest("hex");
	const frameChecksum = sha256Hex(nextFrameBytes).slice(0, 8);
	const recordBytes = canonicalJsonBytes({
		authenticatedTuple,
		previousFrameMac,
		previousFrameChecksum,
		frameMac,
		frameChecksum,
		keyId: nextKey.keyId,
	});
	const recordMac = createHmac("sha256", nextKey.secret).update(recordBytes).digest("hex");
	const recordChecksum = sha256Hex(recordBytes).slice(0, 8);
	const manifestRefWithoutDigest: WorkflowArtifactRef = {
		artifactId: `generation-manifest:${generationId}`,
		relativePath: `generations/${generationId}/ACTIVE`,
		digest: "",
		sizeBytes: 0,
		sourceEventSequence: state.sourceJournalSequence,
	};
	const manifestDigest = sha256Hex(
		canonicalJsonBytes({
			workflowId: state.workflowId,
			generationId,
			manifestRef: manifestRefWithoutDigest,
			sourceHead: expectedHead,
			epochRef: nextEpoch,
			generationBinding: binding,
			leaseRef: nextLeaseRef,
			keyId: nextKey.keyId,
			frameMac,
			frameChecksum,
			priorRecordDigest,
			manifestBytesDigest: "",
			sideRecordMac: "",
		}),
	);
	return {
		recordVersion: 1,
		generationId,
		rotationId,
		mutationId,
		idempotencyKey: mutationId,
		expectedHeadDigest,
		previousEpoch,
		nextEpoch,
		previousKeyId: previousKey.keyId,
		previousGenerationId: store.journal.descriptorContext.generationId,
		previousFrameMac,
		previousFrameChecksum,
		previousWriterIdentity: state.generationBinding.writerIdentity,
		previousLeaseRef: store.journal.options.leaseRef,
		nextLeaseRef,
		generationBinding: binding,
		activeGenerationManifestRef: { ...manifestRefWithoutDigest, digest: manifestDigest },
		keyId: nextKey.keyId,
		frameMac,
		frameChecksum,
		recordMac,
		recordChecksum,
		priorRecordDigest,
	};
}

interface WorkflowRotationIdentity {
	previousEpoch: WorkflowEpochRef;
	expectedHead: WorkflowJournalHead;
	expectedHeadDigest: string;
	rotationId: string;
	mutationId: string;
}

function createRotationIdentity(
	state: WorkflowState,
	nextEpoch: WorkflowEpochRef,
	mode: "coordinator" | "store",
): WorkflowRotationIdentity {
	const previousEpoch = currentEpoch(state);
	const expectedHead: WorkflowJournalHead = {
		workflowId: state.workflowId,
		sequence: state.sourceJournalSequence,
		eventDigest: state.sourceJournalDigest,
		epochRef: previousEpoch,
	};
	const rotationId = `${mode}:${state.workflowId}:${mode === "store" ? nextEpoch.storeEpoch : nextEpoch.coordinatorEpoch}`;
	return {
		previousEpoch,
		expectedHead,
		expectedHeadDigest: digestObject(expectedHead),
		rotationId,
		mutationId: `rotation:${rotationId}`,
	};
}

function mapJournalQuarantineReason(reason: string): WorkflowQuarantineReason {
	if (
		reason === "invalid_mac" ||
		reason === "stale_epoch" ||
		reason === "prepared_without_commit" ||
		reason === "committed_without_prepared" ||
		reason === "duplicate_sequence" ||
		reason === "sequence_chain_break" ||
		reason === "commit_return_uncertain" ||
		reason === "rotation_prepared_only" ||
		reason === "rotation_lease_transfer_unmatched" ||
		reason === "rotation_fence_duplicate" ||
		reason === "rotation_fence_chain_break" ||
		reason === "rotation_commit_uncertain"
	)
		return reason;
	if (reason === "tail_truncated") return "prepared_without_commit";
	if (reason === "interior_corruption") return "sequence_chain_break";
	return "invalid_frame";
}

function recoverySource(metadata: {
	sourcePath: string;
	sourceDigest: string;
	sourceSizeBytes: number;
}): WorkflowRecoverySource {
	return {
		artifactRef: null,
		relativePath: metadata.sourcePath,
		digest: metadata.sourceDigest,
		sizeBytes: metadata.sourceSizeBytes,
	};
}

export class WorkflowStore {
	state: WorkflowState | null = null;

	private constructor(
		readonly journal: WorkflowJournalImpl,
		readonly rootSessionId: string,
		readonly deferredValidators?: WorkflowDeferredEventOwnerValidators,
	) {}

	get identity(): WorkflowRuntimeStoreIdentity {
		const identity = {
			storeKind: this.journal.options.storeKind,
			namespace: this.journal.options.namespace,
			rootDir: this.journal.options.artifactRoot,
			storeId: this.journal.options.storeId,
			workflowId: this.journal.options.workflowId,
		};
		return { ...identity, identityDigest: digestObject(identity) };
	}

	static async open(
		journal: WorkflowJournalImpl,
		rootSessionId: string,
		deferredValidators?: WorkflowDeferredEventOwnerValidators,
		allowQuarantined = false,
	): Promise<WorkflowStore> {
		if (journal.options.rootSessionId !== rootSessionId || journal.options.workflowId.length === 0)
			throw new Error("Workflow store rootSessionId does not match the validated journal publication root.");
		const store = new WorkflowStore(journal, rootSessionId, deferredValidators);
		const recovery = await store.recover();
		if (recovery.status === "quarantined" && !allowQuarantined)
			throw new Error(`Workflow store cannot open a quarantined journal: ${recovery.reason ?? "unknown"}.`);
		if (recovery.status !== "quarantined") await store.reload();
		return store;
	}

	snapshot(): WorkflowState | null {
		return this.state;
	}

	hasWorkflow(): boolean {
		return this.state !== null;
	}

	commit<TPayload extends WorkflowEventPayload>(
		payload: TPayload,
		precondition: WorkflowCommitPrecondition,
	): Promise<WorkflowState> {
		return commitWorkflowStore(this, payload, precondition);
	}

	reload(): Promise<WorkflowState | null> {
		return reloadWorkflowStore(this);
	}

	async recover(): Promise<WorkflowRecoveryResult> {
		const recovery = await this.journal.recover();
		const source = recoverySource(recovery.metadata);
		if (!recovery.quarantined)
			return {
				workflowId: this.journal.options.workflowId,
				status: "healthy",
				reason: null,
				source,
				epochRef: recovery.metadata.epochRef ?? this.journal.options.epoch,
				reconciliation: null,
				quarantine: null,
			};
		const reason = mapJournalQuarantineReason(recovery.metadata.reason);
		const quarantine: WorkflowQuarantineRecord = {
			workflowId: this.journal.options.workflowId,
			status: "quarantined",
			reason,
			source,
			epochRef: recovery.metadata.epochRef ?? this.journal.options.epoch,
			eventSequence: recovery.metadata.sequence,
		};
		return {
			workflowId: this.journal.options.workflowId,
			status: "quarantined",
			reason,
			source,
			epochRef: quarantine.epochRef,
			reconciliation: null,
			quarantine,
		};
	}

	async replaceCoordinatorEpoch(
		nextEpoch: WorkflowEpochRef,
		generationBinding: WorkflowGenerationBinding,
	): Promise<WorkflowGenerationRotation> {
		return this.replaceEpoch(nextEpoch, generationBinding, "coordinator");
	}

	async replaceStoreEpoch(
		nextEpoch: WorkflowEpochRef,
		generationBinding: WorkflowGenerationBinding,
	): Promise<WorkflowGenerationRotation> {
		return this.replaceEpoch(nextEpoch, generationBinding, "store");
	}

	private async replaceEpoch(
		nextEpoch: WorkflowEpochRef,
		generationBinding: WorkflowGenerationBinding,
		mode: "coordinator" | "store",
	): Promise<WorkflowGenerationRotation> {
		const state = await this.reload();
		if (state === null) throw new Error("An epoch cannot replace an empty workflow.");
		const previousEpoch = currentEpoch(state);
		if (
			mode === "coordinator"
				? nextEpoch.storeEpoch !== previousEpoch.storeEpoch ||
					nextEpoch.coordinatorEpoch !== previousEpoch.coordinatorEpoch + 1
				: nextEpoch.storeEpoch !== previousEpoch.storeEpoch + 1 ||
					nextEpoch.coordinatorEpoch !== previousEpoch.coordinatorEpoch
		)
			throw new Error("Workflow epoch replacement must advance exactly one predecessor dimension.");
		if (
			generationBinding.writerIdentity.length === 0 ||
			generationBinding.processGenerationId.length === 0 ||
			generationBinding.ownerIdentity.length === 0
		)
			throw new Error("Workflow epoch replacement requires a complete successor generation binding.");
		const identity = createRotationIdentity(state, nextEpoch, mode);
		const previousKey = await this.journal.options.keyProvider.current(
			this.journal.options.workflowId,
			identity.previousEpoch,
		);
		const rotateGeneration = this.journal.options.keyProvider.rotateGeneration;
		if (rotateGeneration === undefined)
			throw new Error("Workflow key provider cannot issue a canonical successor generation.");
		const rotationInput: WorkflowJournalKeyRotationInput = {
			workflowId: this.journal.options.workflowId,
			previousEpoch: identity.previousEpoch,
			nextEpoch: nextEpoch,
			rotationId: identity.rotationId,
			priorHeadDigest: identity.expectedHeadDigest,
		};
		const nextKey = await rotateGeneration.call(this.journal.options.keyProvider, rotationInput);
		const active = await this.journal.rotationStore.readActiveGeneration(this.journal.options.workflowId);
		const priorRecordDigest = active === null ? state.sourceJournalDigest : sha256Hex(canonicalJsonBytes(active));
		const request = createRotationRequest(
			this,
			state,
			nextEpoch,
			generationBinding,
			previousKey,
			nextKey,
			priorRecordDigest,
			identity,
		);
		const rotation = await this.journal.rotateGeneration(request);
		await this.reload();
		return rotation;
	}
}
