import { randomUUID } from "node:crypto";
import type { GoalState } from "../goals.js";
import {
	isWorkflowApprovalManager,
	type WorkflowApprovalHostOutcome,
	type WorkflowApprovalManager,
} from "./approvals.js";
import type { WorkflowCompletionGate } from "./completion-gate.js";
import { isWorkflowCompletionGateForStore } from "./completion-gate.js";
import type {
	WorkflowApprovalConsumptionResult,
	WorkflowApprovalRequest,
	WorkflowApprovalResponse,
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowExternalBlockerOwner,
	WorkflowExternalBlockerRecord,
	WorkflowExternalBlockerResolution,
	WorkflowGoalMutationDelta,
	WorkflowGoalStatus,
	WorkflowJournalEvent,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowPhaseId,
	WorkflowPhaseOutcomeRecord,
	WorkflowStatus,
} from "./contracts.js";
import { digestObject } from "./contracts.js";
import type { WorkflowLearningPromotionReceiptCapability } from "./learning-promotion-authority.js";
import {
	applyWorkflowGoalTransition,
	digestWorkflowGoalState,
	type WorkflowGoalCoordinator,
	type WorkflowGoalProjectionAdapter,
} from "./projections.js";
import type { WorkflowCommitPrecondition, WorkflowState } from "./reducer.js";
import {
	createWorkflowShell,
	normalizeWorkflowAcceptanceRequest,
	type WorkflowAcceptanceState,
	type WorkflowCommand,
	type WorkflowGoalAccountingInput,
	type WorkflowShell,
	type WorkflowShellBlockedReason,
	type WorkflowShellHandlers,
	type WorkflowShellStatus,
	type WorkflowStartRequest,
} from "./shell.js";

export type {
	WorkflowAcceptanceState,
	WorkflowCommand,
	WorkflowGoalAccountingInput,
	WorkflowGoalContract,
	WorkflowGoalContractRequest,
	WorkflowGoalMetric,
	WorkflowShell,
	WorkflowShellBlockedReason,
	WorkflowShellStatus,
	WorkflowStartRequest,
} from "./shell.js";

/** The reducer/store surface used by the worker-free shell. */
export interface WorkflowStorePort {
	reload(): Promise<WorkflowState | null>;
	snapshot(): WorkflowState | null;
	commit<TPayload extends WorkflowEventPayload>(
		payload: TPayload,
		precondition: WorkflowCommitPrecondition,
	): Promise<WorkflowState>;
}

interface WorkflowGoalReplayStorePort extends WorkflowStorePort {
	readonly journal?: {
		replayLogicalHistory(): Promise<readonly WorkflowJournalEvent[]>;
	};
}

/** The journal surface needed to bind a shell mutation to its active writer. */
export interface WorkflowJournalPort {
	currentLeaseRef(): WorkflowLeaseRef;
}

/** Journal-replay-backed acceptance state; it is not an independent workflow authority. */
export interface WorkflowAcceptanceProjectionPort {
	read(workflowId: string): WorkflowAcceptanceState | null;
	write(workflowId: string, state: WorkflowAcceptanceState): void;
}

export interface WorkflowCancellationBarrier {
	reconciled: boolean;
	reason?: string;
}

export interface WorkflowGoalAccountingPort {
	accountAssistantUsage(input: WorkflowGoalAccountingInput): Promise<GoalState>;
	accountContinuation(input: WorkflowGoalAccountingInput): Promise<GoalState>;
}

export interface WorkflowCoordinatorServices {
	store: WorkflowStorePort;
	journal: WorkflowJournalPort;
	learningPromotionReceipts?: WorkflowLearningPromotionReceiptCapability;
	goal?: WorkflowGoalCoordinator;
	goalAccounting?: WorkflowGoalAccountingPort;
	approvals?: WorkflowApprovalManager;
	acceptance?: WorkflowAcceptanceProjectionPort;
	currentEpoch?: () => WorkflowEpochRef;
	completionGate?: WorkflowCompletionGate;
	reconcileDescendants?: (input: {
		workflowId: string;
		reason: string;
		expectedHead: WorkflowJournalHead;
	}) => Promise<WorkflowCancellationBarrier>;
}

export interface WorkflowPhaseHostContext {
	workflowId: string;
	rootSessionId: string;
	store: WorkflowStorePort;
	goalProjection: WorkflowGoalProjectionAdapter;
	services: WorkflowCoordinatorServices;
}

export interface ProviderFreeWorkflowPhaseHostInput {
	persistSession: true;
	context: WorkflowPhaseHostContext;
}

export interface WorkflowExternalBlockerInput {
	readonly dependencyId: string;
	readonly conditionDigest: string;
	readonly requiredChange: string;
	readonly owner: WorkflowExternalBlockerOwner;
	readonly resumeEventKind: string;
	readonly earliestRetryAt: string | null;
	readonly evidenceRefs: WorkflowExternalBlockerRecord["evidenceRefs"];
	readonly recordedAt: string;
}

export interface WorkflowExternalResumeEvent {
	readonly eventKind: string;
	readonly eventDigest: string;
	readonly observedAt: string;
}

const UNFINISHED_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
	"active",
	"awaiting_user",
	"paused",
	"budget_limited",
	"blocked",
]);

const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set(["failed", "cancelled", "complete"]);

const externalBlockers = new WeakMap<WorkflowPhaseHostContext, WorkflowExternalBlockerRecord>();

const STATUS_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
	active: ["active", "awaiting_user", "paused", "budget_limited", "blocked", "failed", "cancelled", "complete"],
	awaiting_user: ["active", "paused", "blocked", "failed", "cancelled"],
	paused: ["active", "awaiting_user", "cancelled", "failed"],
	budget_limited: ["active", "cancelled", "failed"],
	blocked: ["active", "awaiting_user", "cancelled", "failed"],
	failed: [],
	cancelled: [],
	complete: [],
};

const GOAL_TRANSITION_REBASE_LIMIT = 16;
const GOAL_TRANSITION_REBASE_DELAY_MILLISECONDS = 10;

function isStaleGoalTransition(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === "Workflow GoalState transition CAS is stale." ||
			error.message === "Workflow GoalState transition head or epoch is stale." ||
			error.message ===
				"Workflow store compare-and-swap precondition is stale or is not bound to the active writer and lease.")
	);
}

function assertNonEmpty(value: string, label: string): void {
	if (value.length === 0 || value.trim().length === 0) throw new Error(`${label} must not be empty.`);
}

function assertEpoch(epoch: WorkflowEpochRef): void {
	if (
		!Number.isSafeInteger(epoch.storeEpoch) ||
		epoch.storeEpoch < 1 ||
		!Number.isSafeInteger(epoch.coordinatorEpoch) ||
		epoch.coordinatorEpoch < 1
	)
		throw new Error("Workflow shell requires a positive store/coordinator epoch tuple.");
}

function assertDigest(value: string, label: string): void {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a canonical SHA-256 digest.`);
}

function assertFiniteDate(value: string, label: string): void {
	if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a finite ISO timestamp.`);
}

function externalBlockerStatus(record: WorkflowExternalBlockerRecord): WorkflowShellBlockedReason {
	return {
		kind: "awaiting_external",
		reason: record.requiredChange,
		blockerId: record.blockerId,
		blockerDigest: record.blockerDigest,
		owner: record.owner,
		resumeEventKind: record.resumeEventKind,
		resumePredicateDigest: record.resumePredicateDigest,
		nextEligibleAt: record.earliestRetryAt,
	};
}

function validateExternalBlockerRecord(record: WorkflowExternalBlockerRecord, context: WorkflowPhaseHostContext): void {
	if (record.schemaVersion !== 1 || record.workflowId !== context.workflowId)
		throw new Error("Workflow external blocker identity is invalid.");
	assertEpoch(record.epochRef);
	assertDigest(record.goalRevisionDigest, "Workflow external blocker goal revision");
	assertNonEmpty(record.dependencyId, "Workflow external blocker dependency");
	assertDigest(record.conditionDigest, "Workflow external blocker condition");
	assertNonEmpty(record.requiredChange, "Workflow external blocker required change");
	assertNonEmpty(record.resumeEventKind, "Workflow external blocker resume event");
	assertDigest(record.resumePredicateDigest, "Workflow external blocker resume predicate");
	if (record.earliestRetryAt !== null) assertFiniteDate(record.earliestRetryAt, "Workflow external blocker retry");
	assertFiniteDate(record.recordedAt, "Workflow external blocker recorded time");
	assertDigest(record.blockerId, "Workflow external blocker ID");
	const { blockerDigest, ...withoutDigest } = record;
	if (blockerDigest !== digestObject(withoutDigest)) throw new Error("Workflow external blocker digest is invalid.");
}

function validateExternalBlockerResolution(
	resolution: WorkflowExternalBlockerResolution,
	record: WorkflowExternalBlockerRecord,
): void {
	if (
		resolution.schemaVersion !== 1 ||
		resolution.workflowId !== record.workflowId ||
		resolution.blockerId !== record.blockerId ||
		resolution.blockerDigest !== record.blockerDigest ||
		resolution.resumePredicateDigest !== record.resumePredicateDigest ||
		resolution.eventKind !== record.resumeEventKind
	)
		throw new Error("Workflow external blocker resolution does not satisfy its predicate.");
	assertEpoch(resolution.epochRef);
	assertDigest(resolution.eventDigest, "Workflow external blocker readiness event");
	assertFiniteDate(resolution.observedAt, "Workflow external blocker readiness time");
	const { resolutionDigest, ...withoutDigest } = resolution;
	if (resolutionDigest !== digestObject(withoutDigest))
		throw new Error("Workflow external blocker resolution digest is invalid.");
}

function currentEpoch(context: WorkflowPhaseHostContext, state: WorkflowState | null): WorkflowEpochRef {
	const epoch = state
		? { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch }
		: (context.services.currentEpoch?.() ?? context.services.journal.currentLeaseRef());
	assertEpoch(epoch);
	return epoch;
}

function toGoalMutationDelta(goal: GoalState): WorkflowGoalMutationDelta {
	return {
		goalId: goal.goalId ?? null,
		objective: goal.objective ?? null,
		active: goal.active,
		status: goal.status as WorkflowGoalStatus,
		tokenBudget: goal.tokenBudget ?? null,
		tokensUsed: goal.tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds,
		continuationsUsed: goal.continuationsUsed,
		createdAt: goal.createdAt ?? null,
		updatedAt: goal.updatedAt ?? null,
		lastReason: goal.lastReason ?? null,
		lastError: goal.lastError ?? null,
	};
}

function mapWorkflowStatusToGoalStatus(status: WorkflowStatus): GoalState["status"] {
	switch (status) {
		case "active":
			return "active";
		case "budget_limited":
			return "budget_limited";
		case "failed":
			return "error";
		case "complete":
			return "complete";
		case "awaiting_user":
		case "paused":
		case "cancelled":
		case "blocked":
			return "paused";
		default: {
			const exhaustive: never = status;
			throw new Error(`Unsupported workflow status ${exhaustive}.`);
		}
	}
}

function createGoalId(): string {
	return randomUUID();
}

function createDecisionRef(
	context: WorkflowPhaseHostContext,
	state: WorkflowState,
	kind: "goal_contract" | "scorecard" | "resource_envelope",
	contentDigest: string,
): WorkflowDecisionRef {
	const decisionScope: WorkflowDecisionRef["decisionScope"] = {
		kind: "workflow" as const,
		workflowId: context.workflowId,
		rootSessionId: context.rootSessionId,
	};
	return {
		decisionScope,
		decisionId: `${kind}:${context.workflowId}`,
		revision: 1,
		storeEpoch: state.storeEpoch,
		coordinatorEpoch: state.coordinatorEpoch,
		decisionDigest: digestObject({ kind, contentDigest, stateDigest: state.sourceJournalDigest }),
	};
}

function createExpectedHead(context: WorkflowPhaseHostContext, state: WorkflowState | null): WorkflowJournalHead {
	const epoch = currentEpoch(context, state);
	return state === null
		? { workflowId: context.workflowId, sequence: 0, eventDigest: null, epochRef: epoch }
		: {
				workflowId: context.workflowId,
				sequence: state.sourceJournalSequence,
				eventDigest: state.sourceJournalDigest,
				epochRef: epoch,
			};
}

function assertWorkflowStartBound(state: WorkflowState | null): void {
	if (
		state !== null &&
		state.status === "active" &&
		(state.goalId.length === 0 || state.objective.length === 0 || state.goalStatus === "idle")
	)
		throw new Error("Workflow start is incomplete; goal binding must be committed before workflow use.");
}

function assertWorkflowStartApprovalCommitted(state: WorkflowState | null): void {
	if (
		state !== null &&
		state.status === "active" &&
		state.approvalRequest === null &&
		(state.phase === "hardening_goal" || state.phase === "hardening_scorecard" || state.phase === "adjudicating")
	)
		throw new Error("Workflow start approval is incomplete; planner resume is blocked until authenticated approval.");
}

async function commitWorkflowEvent(
	context: WorkflowPhaseHostContext,
	payload: WorkflowEventPayload,
): Promise<WorkflowState> {
	const state = await context.services.store.reload();
	assertWorkflowStartBound(state);
	if (state !== null && state.workflowId !== context.workflowId)
		throw new Error("Workflow journal state belongs to a different workflow.");
	if (state !== null) assertDigest(state.sourceJournalDigest, "Workflow source journal digest");
	const expectedHead = createExpectedHead(context, state);
	const epoch = expectedHead.epochRef;
	const leaseRef = context.services.journal.currentLeaseRef();
	if (leaseRef.writerIdentity.length === 0) throw new Error("Workflow journal lease has no writer identity.");
	if (leaseRef.storeEpoch !== epoch.storeEpoch || leaseRef.coordinatorEpoch !== epoch.coordinatorEpoch)
		throw new Error("Workflow journal lease is not bound to the current workflow epoch.");
	const mutationId = digestObject({ workflowId: context.workflowId, payload, expectedHead });
	const baselineDigest = digestObject(expectedHead);
	assertDigest(baselineDigest, "Workflow semantic baseline digest");
	const reducerDigest = digestObject(payload);
	assertDigest(reducerDigest, "Workflow reducer digest");
	const semanticBinding = {
		mutationId,
		baselineDigest,
		expectedGenerations: { workflow: state?.storeEpoch ?? epoch.storeEpoch },
		ownerId: "workflow-coordinator",
		phase: state?.phase ?? "hardening_goal",
		reducerDigest,
		semanticHead: {
			workflowId: context.workflowId,
			sequence: expectedHead.sequence,
			eventDigest: expectedHead.eventDigest,
			stateDigest: baselineDigest,
			epochRef: epoch,
			generation: state?.storeEpoch ?? epoch.storeEpoch,
		},
		expectedHead,
		idempotencyKey: mutationId,
		executionKey: null,
		writerIdentity: leaseRef.writerIdentity,
		leaseRef,
		epochRef: epoch,
	};
	return context.services.store.commit(payload, {
		expectedSourceJournalDigest: state?.sourceJournalDigest ?? null,
		expectedHead,
		expectedEpoch: epoch,
		leaseRef,
		idempotencyKey: mutationId,
		writerIdentity: leaseRef.writerIdentity,
		executionKey: null,
		semanticBinding,
	});
}

function createStatusGoal(current: GoalState, status: WorkflowStatus, reason: string): GoalState {
	return {
		...current,
		active: status === "active",
		status: mapWorkflowStatusToGoalStatus(status),
		lastReason: reason,
		lastError: status === "failed" ? reason : current.lastError,
	};
}

function requireGoalCoordinator(context: WorkflowPhaseHostContext): WorkflowGoalCoordinator {
	if (context.services.goal === undefined)
		throw new Error(
			"Workflow host requires the journal-backed GoalState coordinator; projection-only CAS is forbidden.",
		);
	return context.services.goal;
}

async function activateApprovedGoalProjection(
	context: WorkflowPhaseHostContext,
	state: WorkflowState,
	reason: string,
): Promise<void> {
	const goalCoordinator = requireGoalCoordinator(context);
	const currentGoal = context.goalProjection.read();
	if (state.goalActive && state.goalStatus === "active" && currentGoal.active && currentGoal.status === "active")
		return;
	if (currentGoal.goalId === undefined || currentGoal.objective === undefined)
		throw new Error("Approved workflow cannot activate without its durable goal projection.");
	const nextGoal = createStatusGoal(currentGoal, "active", reason);
	const expectedHead = createExpectedHead(context, state);
	const epoch = expectedHead.epochRef;
	const goalDelta = toGoalMutationDelta(nextGoal);
	await goalCoordinator.transition({
		workflowId: context.workflowId,
		source: "workflow_approval",
		expectedGoalDigest: digestObject(currentGoal),
		payload: { kind: "workflow_status_changed", status: "active", phase: "planning", reason, goalDelta },
		expectedHead,
		expectedEpoch: epoch,
		leaseRef: context.services.journal.currentLeaseRef(),
		idempotencyKey: digestObject({
			workflowId: context.workflowId,
			status: "active",
			phase: "planning",
			reason,
			goalDelta,
		}),
		writerIdentity: context.services.journal.currentLeaseRef().writerIdentity,
		executionKey: null,
	});
}

async function appendGoalTransition(
	context: WorkflowPhaseHostContext,
	status: WorkflowStatus,
	phase: WorkflowPhaseId,
	reason: string,
): Promise<WorkflowState> {
	const goalCoordinator = requireGoalCoordinator(context);
	for (let attempt = 1; attempt <= GOAL_TRANSITION_REBASE_LIMIT; attempt += 1) {
		const currentState = await context.services.store.reload();
		if (currentState === null) throw new Error("Workflow status transition requires a durable workflow state.");
		if (!STATUS_TRANSITIONS[currentState.status].includes(status))
			throw new Error(`Workflow status transition ${currentState.status} -> ${status} is not allowed.`);
		const currentGoal = context.goalProjection.read();
		const nextGoal = createStatusGoal(currentGoal, status, reason);
		const expectedHead = createExpectedHead(context, currentState);
		const goalDelta = toGoalMutationDelta(nextGoal);
		try {
			await goalCoordinator.transition({
				workflowId: context.workflowId,
				source: "workflow_status",
				expectedGoalDigest: digestObject(currentGoal),
				payload: { kind: "workflow_status_changed", status, phase, reason, goalDelta },
				expectedHead,
				expectedEpoch: expectedHead.epochRef,
				leaseRef: context.services.journal.currentLeaseRef(),
				idempotencyKey: digestObject({ workflowId: context.workflowId, status, phase, reason, goalDelta }),
				writerIdentity: context.services.journal.currentLeaseRef().writerIdentity,
				executionKey: null,
			});
			const transitioned = await context.services.store.reload();
			if (transitioned === null) throw new Error("Workflow status transition did not produce durable state.");
			return transitioned;
		} catch (error) {
			if (!isStaleGoalTransition(error) || attempt === GOAL_TRANSITION_REBASE_LIMIT) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, GOAL_TRANSITION_REBASE_DELAY_MILLISECONDS));
		}
	}
	throw new Error("Workflow status transition exhausted its bounded GoalState rebase attempts.");
}

interface PreparedGoalBinding {
	goalId: string;
	objective: string;
	goalDelta: WorkflowGoalMutationDelta;
	nextGoal: GoalState;
}

function prepareGoalBinding(currentGoal: GoalState, objective: string, workflowId: string): PreparedGoalBinding {
	const hasGoalId = currentGoal.goalId !== undefined;
	const hasObjective = currentGoal.objective !== undefined;
	if (hasGoalId !== hasObjective) throw new Error("Workflow GoalState projection is only partially bound.");
	if (hasObjective && currentGoal.objective !== objective)
		throw new Error("Workflow objective must exactly match the existing durable goal.");
	const goalId = currentGoal.goalId ?? createGoalId();
	const nextGoal: GoalState = {
		...currentGoal,
		workflowId,
		goalId,
		objective,
		active: true,
		status: "active",
		createdAt: currentGoal.createdAt ?? Date.now(),
		updatedAt: Date.now(),
	};
	const goalDelta = toGoalMutationDelta(nextGoal);
	const canonicalNextGoal = applyWorkflowGoalTransition(currentGoal, {
		kind: "goal_binding_committed",
		workflowId,
		goalId,
		objective,
		goalDelta,
	});
	if (digestWorkflowGoalState(canonicalNextGoal) !== digestWorkflowGoalState(nextGoal))
		throw new Error("Workflow start goal binding preflight is not canonical.");
	return { goalId, objective, goalDelta, nextGoal };
}

async function bindGoal(context: WorkflowPhaseHostContext, prepared: PreparedGoalBinding): Promise<WorkflowState> {
	const state = await context.services.store.reload();
	if (state === null) throw new Error("Goal binding requires a durable workflow start event.");
	const goalCoordinator = requireGoalCoordinator(context);
	const expectedHead = createExpectedHead(context, state);
	const epoch = expectedHead.epochRef;
	const currentGoal = context.goalProjection.read();
	await goalCoordinator.transition({
		workflowId: context.workflowId,
		source: "workflow_start",
		expectedGoalDigest: digestObject(currentGoal),
		payload: {
			kind: "goal_binding_committed",
			workflowId: context.workflowId,
			goalId: prepared.goalId,
			objective: prepared.objective,
			goalDelta: prepared.goalDelta,
		},
		expectedHead,
		expectedEpoch: epoch,
		leaseRef: context.services.journal.currentLeaseRef(),
		idempotencyKey: digestObject({
			workflowId: context.workflowId,
			goalId: prepared.goalId,
			objective: prepared.objective,
			goalDelta: prepared.goalDelta,
		}),
		writerIdentity: context.services.journal.currentLeaseRef().writerIdentity,
		executionKey: null,
	});
	const bound = await context.services.store.reload();
	if (bound === null) throw new Error("Goal binding did not produce durable state.");
	return bound;
}

function workflowAcceptanceState(context: WorkflowPhaseHostContext): WorkflowAcceptanceState {
	const state = context.services.store.snapshot();
	if (state === null) return { acceptanceCheckIds: [], protectedInvariantIds: [], goalContract: null };
	const acceptance = context.services.acceptance?.read(context.workflowId);
	if (acceptance === null || acceptance === undefined)
		throw new Error("Workflow status is unavailable without its durable acceptance projection.");
	return acceptance;
}

function workflowDecisionRefs(state: WorkflowState | null): readonly WorkflowDecisionRef[] {
	if (state === null) return [];
	return state.decisionRefs.map((ref) => {
		if (ref.decisionScope.kind !== "workflow")
			throw new Error("Workflow status contains a non-workflow decision reference.");
		if (!("coordinatorEpoch" in ref) || typeof ref.coordinatorEpoch !== "number")
			throw new Error("Workflow status contains a decision reference without its coordinator epoch.");
		return {
			...ref,
			decisionScope: {
				kind: "workflow",
				workflowId: ref.decisionScope.workflowId,
				rootSessionId: ref.decisionScope.rootSessionId,
			},
			coordinatorEpoch: ref.coordinatorEpoch,
		} satisfies WorkflowDecisionRef;
	});
}

function workflowApprovalDecisionRefs(request: WorkflowApprovalRequest): readonly WorkflowDecisionRef[] {
	return request.decisionRefs.map((ref) => {
		if (ref.decisionScope.kind !== "workflow")
			throw new Error("Workflow approval request contains a non-workflow decision reference.");
		if (!("coordinatorEpoch" in ref) || typeof ref.coordinatorEpoch !== "number")
			throw new Error("Workflow approval request contains a decision reference without its coordinator epoch.");
		return {
			...ref,
			decisionScope: {
				kind: "workflow",
				workflowId: ref.decisionScope.workflowId,
				rootSessionId: ref.decisionScope.rootSessionId,
			},
			coordinatorEpoch: ref.coordinatorEpoch,
		} satisfies WorkflowDecisionRef;
	});
}

function shellStatus(context: WorkflowPhaseHostContext): WorkflowShellStatus {
	const state = context.services.store.snapshot();
	assertWorkflowStartBound(state);
	assertWorkflowStartApprovalCommitted(state);
	const acceptance = workflowAcceptanceState(context);
	const externalBlocker = state?.status === "blocked" ? externalBlockers.get(context) : undefined;
	return {
		workflowId: state?.workflowId ?? null,
		status: state?.status ?? "idle",
		phase: state?.phase ?? null,
		goal: structuredClone(context.goalProjection.read()),
		approvalRequest: (state?.approvalRequest ?? null) as WorkflowApprovalRequest | null,
		stateDigest: state?.sourceJournalDigest ?? null,
		decisionRefs: workflowDecisionRefs(state),
		resourceEnvelopeDigest: state?.resourceEnvelopeDigest ?? null,
		scorecardDigest: state?.scorecardDigest ?? null,
		pendingWaitReasons:
			state?.status === "awaiting_user"
				? [{ code: "approval_required", detail: "Approval is required before workflow effects or dispatch." }]
				: [],
		acceptanceCheckIds: [...acceptance.acceptanceCheckIds],
		protectedInvariantIds: [...acceptance.protectedInvariantIds],
		goalContract: acceptance.goalContract === undefined ? null : structuredClone(acceptance.goalContract),
		blocked: externalBlocker === undefined ? undefined : externalBlockerStatus(externalBlocker),
	};
}

function blockedStatus(context: WorkflowPhaseHostContext, blocked: WorkflowShellBlockedReason): WorkflowShellStatus {
	return { ...shellStatus(context), blocked };
}

function consumedApprovalOutcome(consumed: WorkflowApprovalConsumptionResult): WorkflowApprovalHostOutcome {
	if (!("outcome" in consumed) || typeof consumed.outcome !== "object" || consumed.outcome === null)
		throw new Error(
			"Workflow approval consumption lacks a selected outcome; inject WorkflowApprovalManagerWithOutcome or add outcome to the approval receipt contract.",
		);
	const outcome = consumed.outcome;
	if (
		!("action" in outcome) ||
		typeof outcome.action !== "string" ||
		(outcome.action !== "approve" &&
			outcome.action !== "decline" &&
			outcome.action !== "cancel" &&
			outcome.action !== "revise" &&
			outcome.action !== "request_changes" &&
			outcome.action !== "request-changes")
	)
		throw new Error(
			"Workflow approval consumption lacks a supported selected outcome; inject WorkflowApprovalManagerWithOutcome or add outcome to the approval receipt contract.",
		);
	return outcome as WorkflowApprovalHostOutcome;
}

function createStartPayload(
	context: WorkflowPhaseHostContext,
	state: WorkflowState,
	request: WorkflowStartRequest,
	acceptance: WorkflowAcceptanceState,
): {
	goal: Extract<WorkflowEventPayload, { kind: "goal_contract_proposed" }>;
	scorecard: Extract<WorkflowEventPayload, { kind: "scorecard_proposed" }>;
	resource: Extract<WorkflowEventPayload, { kind: "resource_envelope_proposed" }>;
} {
	const goalContractDigest =
		acceptance.goalContract?.contractDigest ?? digestObject({ objective: request.objective, acceptance });
	const goalRef = createDecisionRef(context, state, "goal_contract", goalContractDigest);
	const scorecardRef = createDecisionRef(context, state, "scorecard", digestObject({ acceptance }));
	const resourceRef = createDecisionRef(
		context,
		state,
		"resource_envelope",
		digestObject({ requestedProfile: request.requestedProfile ?? null, maxWorkers: request.maxWorkers ?? null }),
	);
	return {
		goal: {
			kind: "goal_contract_proposed",
			contractDigest: goalContractDigest,
			decisionRef: goalRef,
		},
		scorecard: {
			kind: "scorecard_proposed",
			scorecardDigest: digestObject({ acceptance }),
			decisionRef: scorecardRef,
		},
		resource: {
			kind: "resource_envelope_proposed",
			envelopeDigest: digestObject({
				requestedProfile: request.requestedProfile ?? null,
				maxWorkers: request.maxWorkers ?? null,
			}),
			decisionRef: resourceRef,
		},
	};
}

function startApprovalInput(
	context: WorkflowPhaseHostContext,
	request: WorkflowStartRequest,
	state: WorkflowState,
	goal: GoalState,
	refs: readonly WorkflowDecisionRef[],
	acceptance: WorkflowAcceptanceState,
): Parameters<WorkflowApprovalManager["createRequest"]>[0] {
	const epoch = { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch };
	const pausedGoal = createStatusGoal(
		goal,
		"awaiting_user",
		"Awaiting exact approval for the bounded workflow start and cloud-compute allowance.",
	);
	const decisionRoles = { goal: refs[0], scorecard: refs[1], resource: refs[2] };
	const goalContractDigest = acceptance.goalContract?.contractDigest ?? null;
	const artifactDigest = digestObject({ objective: request.objective, decisionRefs: refs, goalContractDigest });
	const requestedProfile = request.requestedProfile ?? "inline";
	const maxWorkers = request.maxWorkers ?? 1;
	const approvalBinding = { objective: request.objective, refs, requestedProfile, maxWorkers, goalContractDigest };
	return {
		workflowId: context.workflowId,
		decisionRef: refs[2],
		decisionRefs: refs,
		decisionRoles,
		headDigest: state.sourceJournalDigest,
		stateDigest: state.sourceJournalDigest,
		configDigest: digestObject({ executionProfile: "unresolved" }),
		profileDigest: digestObject({
			requestedProfile: request.requestedProfile ?? null,
			maxWorkers: request.maxWorkers ?? null,
		}),
		artifactDigest,
		storeEpoch: epoch.storeEpoch,
		coordinatorEpoch: epoch.coordinatorEpoch,
		expectedResponseSequence: 1,
		ttlMilliseconds: 300_000,
		question: `Approve the exact objective, causal metrics, anti-gaming guards, non-goals, and budgets. Is cloud compute available for profile=${requestedProfile} with maxWorkers=${maxWorkers}?`,
		options: [
			{
				optionId: "approve",
				label: "Approve without cloud compute",
				effectDigest: digestObject({ ...approvalBinding, cloudComputeAvailable: false, cloudMaxWorkers: 0 }),
			},
			{
				optionId: "approve_cloud",
				label: `Approve cloud compute (up to ${maxWorkers} workers)`,
				effectDigest: digestObject({
					...approvalBinding,
					cloudComputeAvailable: true,
					cloudMaxWorkers: maxWorkers,
				}),
			},
			{
				optionId: "decline",
				label: "Decline",
				effectDigest: digestObject({ ...approvalBinding, disposition: "declined" }),
			},
			{
				optionId: "cancel",
				label: "Cancel",
				effectDigest: digestObject({ ...approvalBinding, disposition: "cancelled" }),
			},
			{
				optionId: "revise",
				label: "Revise and ask again",
				effectDigest: digestObject({ ...approvalBinding, disposition: "revised" }),
			},
			{
				optionId: "restart",
				label: "Restart this proposal",
				effectDigest: digestObject({ ...approvalBinding, disposition: "restarted" }),
			},
		],
		awaitingUserTransition: {
			status: "awaiting_user",
			phase: "adjudicating",
			goalDelta: toGoalMutationDelta(pausedGoal),
			expectedHeadDigest: state.sourceJournalDigest,
			expectedEpoch: epoch,
		},
	};
}

async function startWorkflow(
	context: WorkflowPhaseHostContext,
	request: WorkflowStartRequest,
): Promise<WorkflowShellStatus> {
	if (request.workflowId !== context.workflowId)
		throw new Error("Workflow start identity must match the host workflow context.");
	const state = await context.services.store.reload();
	assertWorkflowStartBound(state);
	if (state !== null && UNFINISHED_WORKFLOW_STATUSES.has(state.status))
		throw new Error("The root session already has an unfinished workflow.");
	if (state !== null && TERMINAL_WORKFLOW_STATUSES.has(state.status)) return shellStatus(context);
	const currentGoal = context.goalProjection.read();
	if (currentGoal.status === "paused" && request.objective === undefined)
		throw new Error(
			"Workflow start cannot silently reuse a paused goal; provide an explicit objective or explicitly resume the goal.",
		);
	const objective = request.objective ?? currentGoal.objective;
	if (objective === undefined || objective.trim().length === 0)
		throw new Error("Workflow start requires an exact objective or an active goal.");
	if (
		currentGoal.active &&
		currentGoal.objective !== undefined &&
		request.objective !== undefined &&
		currentGoal.objective !== request.objective
	)
		throw new Error("Workflow objective must exactly match the active goal.");
	if (currentGoal.active && request.objective === undefined && currentGoal.objective === undefined)
		throw new Error("Workflow start requires an active goal objective.");
	requireGoalCoordinator(context);
	const preparedGoalBinding = prepareGoalBinding(currentGoal, objective, context.workflowId);
	if (request.maxWorkers !== undefined && (!Number.isSafeInteger(request.maxWorkers) || request.maxWorkers < 1))
		throw new Error("Workflow maxWorkers must be a positive safe integer.");
	const acceptance = normalizeWorkflowAcceptanceRequest({ ...request, objective });
	if (context.services.acceptance === undefined)
		throw new Error("Workflow start requires a durable acceptance projection.");
	if (context.services.approvals === undefined)
		throw new Error("Workflow start requires a host approval manager; no approval transition is permitted.");
	if (!isWorkflowApprovalManager(context.services.approvals))
		throw new Error("Workflow start requires a branded host approval manager.");
	await commitWorkflowEvent(context, {
		kind: "workflow_started",
		workflowId: context.workflowId,
		rootSessionId: context.rootSessionId,
		objective,
	});
	const bound = await bindGoal(context, preparedGoalBinding);
	await commitWorkflowEvent(context, {
		kind: "profile_selected",
		requestedProfile: request.requestedProfile ?? null,
		resolvedProfile: request.requestedProfile ?? "inline",
		maxWorkers: request.maxWorkers ?? 1,
		profileDigest: digestObject({
			requestedProfile: request.requestedProfile ?? null,
			maxWorkers: request.maxWorkers ?? null,
		}),
	});
	context.services.acceptance.write(context.workflowId, acceptance);
	const startPayloads = createStartPayload(context, bound, { ...request, objective }, acceptance);
	await commitWorkflowEvent(context, startPayloads.goal);
	await commitWorkflowEvent(context, startPayloads.scorecard);
	await commitWorkflowEvent(context, startPayloads.resource);
	const proposed = await context.services.store.reload();
	if (proposed === null) throw new Error("Workflow start proposals were not durably committed.");
	const refs = [
		startPayloads.goal.decisionRef,
		startPayloads.scorecard.decisionRef,
		startPayloads.resource.decisionRef,
	];
	const approval = await context.services.approvals.createRequest(
		startApprovalInput(context, { ...request, objective }, proposed, context.goalProjection.read(), refs, acceptance),
	);
	const awaiting = await context.services.store.reload();
	if (
		awaiting === null ||
		awaiting.status !== "awaiting_user" ||
		awaiting.approvalRequest === null ||
		awaiting.approvalRequest.approvalRequestId !== approval.approvalRequestId ||
		digestObject(awaiting.approvalRequest) !== digestObject(approval)
	)
		throw new Error("Workflow approval manager did not durably commit the exact approval_requested transition.");
	const replayStore = context.services.store as WorkflowGoalReplayStorePort;
	if (replayStore.journal === undefined)
		throw new Error("Workflow approval manager did not expose the authenticated durable journal.");
	const history = await replayStore.journal.replayLogicalHistory();
	const approvalEvent = history.at(-1);
	if (
		approvalEvent === undefined ||
		approvalEvent.payload.kind !== "approval_requested" ||
		approvalEvent.payload.approval.approvalRequestId !== approval.approvalRequestId ||
		digestObject(approvalEvent.payload.approval) !== digestObject(approval) ||
		approvalEvent.payload.awaitingUser.status !== "awaiting_user" ||
		approvalEvent.payload.awaitingUser.phase !== "adjudicating" ||
		approvalEvent.payload.awaitingUser.expectedHeadDigest !== approval.headDigest ||
		digestObject(approvalEvent.payload.awaitingUser.expectedEpoch) !==
			digestObject({ storeEpoch: approval.storeEpoch, coordinatorEpoch: approval.coordinatorEpoch })
	)
		throw new Error("Workflow approval manager did not commit the exact authenticated approval_requested event.");
	return shellStatus(context);
}

async function respondWorkflow(
	context: WorkflowPhaseHostContext,
	command: Extract<WorkflowCommand, { kind: "respond" }>,
): Promise<WorkflowShellStatus> {
	requireGoalCoordinator(context);
	const approvals = context.services.approvals;
	if (approvals === undefined)
		throw new Error("Workflow approval response is unavailable in the provider-free shell.");
	const request = await approvals.pending(context.workflowId);
	if (
		request === null ||
		request.workflowId !== context.workflowId ||
		request.approvalRequestId !== command.approvalRequestId ||
		request.options.every((option) => option.optionId !== command.optionId)
	)
		throw new Error("Approval response is not bound to the current request and option.");
	const decisionRefs = workflowApprovalDecisionRefs(request);
	const responseBase = {
		approvalRequestId: request.approvalRequestId,
		decisionRef: request.decisionRef,
		decisionRefs,
		decisionRoles: request.decisionRoles,
		workflowId: request.workflowId,
		headDigest: request.headDigest,
		stateDigest: request.stateDigest,
		configDigest: request.configDigest,
		profileDigest: request.profileDigest,
		artifactDigest: request.artifactDigest,
		storeEpoch: request.storeEpoch,
		coordinatorEpoch: request.coordinatorEpoch,
		clientSessionId: request.requestingClientSessionId,
		trustedPrincipal: request.trustedPrincipal,
		responseSequence: request.expectedResponseSequence,
		optionId: command.optionId,
	};
	const response: WorkflowApprovalResponse =
		"oneUseSecret" in command.proof
			? { ...responseBase, mode: "interactive_secret", secretProof: command.proof }
			: command.proof.kind === "signed_headless"
				? { ...responseBase, mode: "signed_headless", signedHeadlessArtifact: command.proof }
				: (() => {
						throw new Error("Workflow approval response requires a structured trusted proof.");
					})();
	const consumed =
		response.mode === "interactive_secret"
			? await approvals.consumeInteractive(response)
			: await approvals.consumeSignedHeadless(response);
	if (consumed.status !== "consumed") throw new Error("Workflow approval response was already consumed.");
	const selectedOutcome = consumedApprovalOutcome(consumed);
	if (selectedOutcome.optionId !== command.optionId)
		throw new Error("Consumed approval receipt does not match the structured requested outcome.");
	switch (selectedOutcome.action) {
		case "approve": {
			const approved = await context.services.store.reload();
			if (approved === null || approved.status !== "active" || approved.phase !== "planning")
				throw new Error("Consumed approval did not produce an active planning state.");
			await activateApprovedGoalProjection(context, approved, "approved by operator");
			return shellStatus(context);
		}
		case "decline":
			await appendGoalTransition(context, "blocked", "recovering", "Workflow approval was declined.");
			return shellStatus(context);
		case "cancel": {
			const cancellation = await cancelWorkflow(context, "Workflow approval was cancelled.");
			if (cancellation.status !== "active") return cancellation;
			await appendGoalTransition(
				context,
				"blocked",
				"recovering",
				"Cancellation is waiting for descendant reconciliation.",
			);
			return blockedStatus(context, {
				kind: "cancellation_reconciliation",
				reason: "descendant reconciliation barrier is unavailable",
			});
		}
		case "revise":
		case "restart":
			await appendGoalTransition(
				context,
				"blocked",
				"recovering",
				selectedOutcome.action === "revise"
					? "Workflow approval was revised; a new structured proposal is required."
					: "Workflow approval was restarted; a new structured proposal is required.",
			);
			return shellStatus(context);
	}
	throw new Error("Unsupported workflow approval outcome.");
}

async function cancelWorkflow(context: WorkflowPhaseHostContext, reason: string): Promise<WorkflowShellStatus> {
	requireGoalCoordinator(context);
	const state = await context.services.store.reload();
	if (state === null) throw new Error("Workflow cancellation requires a durable workflow state.");
	const expectedHead = createExpectedHead(context, state);
	const reconcile = context.services.reconcileDescendants;
	if (reconcile === undefined)
		return blockedStatus(context, {
			kind: "cancellation_reconciliation",
			reason: "descendant reconciliation barrier is unavailable",
		});
	const barrier = await reconcile({ workflowId: context.workflowId, reason, expectedHead });
	if (!barrier.reconciled)
		return blockedStatus(context, {
			kind: "cancellation_reconciliation",
			reason: barrier.reason ?? "descendant reconciliation barrier is not complete",
		});
	await appendGoalTransition(context, "cancelled", "recovering", reason);
	return shellStatus(context);
}

async function assertNoPendingApproval(context: WorkflowPhaseHostContext, state: WorkflowState): Promise<void> {
	if (state.status === "awaiting_user" && context.services.approvals === undefined)
		throw new Error("Awaiting-user workflow requires a host approval manager and consumed structured proof.");
	const pending = state.approvalRequest ?? (await context.services.approvals?.pending(context.workflowId)) ?? null;
	if (pending !== null)
		throw new Error("A pending approval must be consumed before pausing or resuming this workflow.");
}

async function runOutcome(
	context: WorkflowPhaseHostContext,
	record: WorkflowPhaseOutcomeRecord,
): Promise<WorkflowState> {
	const outcome = record.outcome;
	assertNonEmpty(outcome.workflowId, "Phase outcome workflow ID");
	assertNonEmpty(outcome.phaseAttemptId, "Phase outcome attempt ID");
	assertNonEmpty(outcome.invocationToken, "Phase outcome invocation token");
	assertNonEmpty(outcome.inputStateDigest, "Phase outcome input state digest");
	assertEpoch(outcome.epochRef);
	const state = await context.services.store.reload();
	if (
		state === null ||
		outcome.workflowId !== context.workflowId ||
		outcome.inputStateDigest !== state.sourceJournalDigest ||
		outcome.epochRef.storeEpoch !== state.storeEpoch ||
		outcome.epochRef.coordinatorEpoch !== state.coordinatorEpoch
	)
		throw new Error("Phase outcome is stale or not bound to the current workflow state.");
	if (outcome.status === "complete") {
		const completionGate = context.services.completionGate;
		if (!isWorkflowCompletionGateForStore(completionGate, context.store))
			throw new Error("Completion remains blocked until a sealed host-owned readiness gate is available.");
		const readiness = await completionGate.verify({
			workflowId: context.workflowId,
			currentState: state,
			currentEpoch: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
			outcome: record,
		});
		return completionGate.commit({
			workflowId: context.workflowId,
			currentState: state,
			currentEpoch: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
			outcome: record,
			readiness,
		});
	}
	const status: WorkflowStatus =
		outcome.status === "pause" ? "paused" : outcome.status === "blocked" ? "blocked" : "failed";
	const next = await appendGoalTransition(
		context,
		status,
		status === "blocked" ? "recovering" : state.phase,
		`phase-outcome:${record.attemptStatus}`,
	);
	return next;
}

interface WorkflowExternalBlockerReplay {
	readonly latestRecord: WorkflowExternalBlockerRecord | null;
	readonly unresolved: WorkflowExternalBlockerRecord | null;
}

async function replayExternalBlocker(context: WorkflowPhaseHostContext): Promise<WorkflowExternalBlockerReplay> {
	const replayStore = context.services.store as WorkflowGoalReplayStorePort;
	if (replayStore.journal === undefined) return { latestRecord: null, unresolved: null };
	let latestRecord: WorkflowExternalBlockerRecord | null = null;
	let unresolved: WorkflowExternalBlockerRecord | null = null;
	for (const event of await replayStore.journal.replayLogicalHistory()) {
		if (event.payload.kind === "workflow_external_blocker_recorded") {
			validateExternalBlockerRecord(event.payload.blocker, context);
			if (event.payload.blockerDigest !== event.payload.blocker.blockerDigest)
				throw new Error("Workflow external blocker event digest is invalid.");
			latestRecord = event.payload.blocker;
			unresolved = event.payload.blocker;
			continue;
		}
		if (
			event.payload.kind === "workflow_external_blocker_resolved" &&
			unresolved !== null &&
			event.payload.resolution.blockerId === unresolved.blockerId
		) {
			validateExternalBlockerResolution(event.payload.resolution, unresolved);
			if (event.payload.resolutionDigest !== event.payload.resolution.resolutionDigest)
				throw new Error("Workflow external blocker resolution event digest is invalid.");
			unresolved = null;
		}
	}
	return { latestRecord, unresolved };
}

async function blockOnExternal(
	context: WorkflowPhaseHostContext,
	input: WorkflowExternalBlockerInput,
): Promise<WorkflowShellStatus> {
	const state = await context.services.store.reload();
	if (state === null || (state.status !== "active" && state.status !== "blocked"))
		throw new Error("Workflow external blocker requires an active or identically blocked durable workflow.");
	const goalRevisionDigest = state.goalContractDigest;
	if (goalRevisionDigest === null) throw new Error("Workflow external blocker requires an immutable goal revision.");
	assertDigest(goalRevisionDigest, "Workflow external blocker goal revision");
	assertNonEmpty(input.dependencyId, "Workflow external blocker dependency");
	assertDigest(input.conditionDigest, "Workflow external blocker condition");
	assertNonEmpty(input.requiredChange, "Workflow external blocker required change");
	assertNonEmpty(input.resumeEventKind, "Workflow external blocker resume event");
	assertFiniteDate(input.recordedAt, "Workflow external blocker recorded time");
	if (input.earliestRetryAt !== null) assertFiniteDate(input.earliestRetryAt, "Workflow external blocker retry time");
	const epochRef = currentEpoch(context, state);
	const resumePredicateDigest = digestObject({
		workflowId: context.workflowId,
		goalRevisionDigest,
		dependencyId: input.dependencyId,
		conditionDigest: input.conditionDigest,
		owner: input.owner,
		resumeEventKind: input.resumeEventKind,
	});
	const blockerId = digestObject({
		workflowId: context.workflowId,
		goalRevisionDigest,
		dependencyId: input.dependencyId,
		conditionDigest: input.conditionDigest,
		resumePredicateDigest,
	});
	const withoutDigest = {
		schemaVersion: 1 as const,
		blockerId,
		workflowId: context.workflowId,
		epochRef,
		goalRevisionDigest,
		dependencyId: input.dependencyId,
		conditionDigest: input.conditionDigest,
		requiredChange: input.requiredChange,
		owner: input.owner,
		resumeEventKind: input.resumeEventKind,
		resumePredicateDigest,
		earliestRetryAt: input.earliestRetryAt,
		evidenceRefs: structuredClone(input.evidenceRefs),
		recordedAt: input.recordedAt,
	};
	const blocker: WorkflowExternalBlockerRecord = {
		...withoutDigest,
		blockerDigest: digestObject(withoutDigest),
	};
	if (state.status === "blocked") {
		const existing = externalBlockers.get(context);
		if (existing?.blockerId === blocker.blockerId) return shellStatus(context);
		throw new Error("Workflow is already blocked by a different durable predicate.");
	}
	await commitWorkflowEvent(context, {
		kind: "workflow_external_blocker_recorded",
		workflowId: context.workflowId,
		epochRef,
		blocker,
		blockerDigest: blocker.blockerDigest,
	});
	externalBlockers.set(context, blocker);
	await appendGoalTransition(context, "blocked", "recovering", `external-blocker:${blocker.blockerId}`);
	return shellStatus(context);
}

async function resumeBlocked(
	context: WorkflowPhaseHostContext,
	input: WorkflowExternalResumeEvent,
): Promise<WorkflowShellStatus> {
	const state = await context.services.store.reload();
	const blocker = externalBlockers.get(context);
	if (state === null || state.status !== "blocked" || blocker === undefined)
		throw new Error("Workflow external blocker is already resolved or unavailable.");
	if (input.eventKind !== blocker.resumeEventKind)
		throw new Error("Workflow readiness event does not satisfy the blocker predicate.");
	assertDigest(input.eventDigest, "Workflow external blocker readiness event");
	assertFiniteDate(input.observedAt, "Workflow external blocker readiness time");
	if (blocker.earliestRetryAt !== null && Date.parse(input.observedAt) < Date.parse(blocker.earliestRetryAt))
		throw new Error("Workflow external blocker is not yet eligible for retry.");
	const withoutDigest = {
		schemaVersion: 1 as const,
		workflowId: context.workflowId,
		blockerId: blocker.blockerId,
		blockerDigest: blocker.blockerDigest,
		epochRef: currentEpoch(context, state),
		resumePredicateDigest: blocker.resumePredicateDigest,
		eventKind: input.eventKind,
		eventDigest: input.eventDigest,
		observedAt: input.observedAt,
	};
	const resolution: WorkflowExternalBlockerResolution = {
		...withoutDigest,
		resolutionDigest: digestObject(withoutDigest),
	};
	await commitWorkflowEvent(context, {
		kind: "workflow_external_blocker_resolved",
		workflowId: context.workflowId,
		epochRef: resolution.epochRef,
		resolution,
		resolutionDigest: resolution.resolutionDigest,
	});
	externalBlockers.delete(context);
	await appendGoalTransition(context, "active", "planning", `external-blocker-resolved:${blocker.blockerId}`);
	return shellStatus(context);
}

async function executeCommand(
	context: WorkflowPhaseHostContext,
	command: WorkflowCommand,
): Promise<WorkflowShellStatus> {
	switch (command.kind) {
		case "start":
			return startWorkflow(context, command.request);
		case "status":
		case "decisions":
		case "resources":
			await context.services.store.reload();
			return shellStatus(context);
		case "respond":
			return respondWorkflow(context, command);
		case "pause": {
			const state = await context.services.store.reload();
			if (state?.status === "awaiting_user") {
				await assertNoPendingApproval(context, state);
				await appendGoalTransition(context, "paused", "adjudicating", command.reason);
			} else {
				if (state?.status === "paused") await assertNoPendingApproval(context, state);
				await appendGoalTransition(context, "paused", "recovering", command.reason);
			}
			return shellStatus(context);
		}
		case "resume": {
			const state = await context.services.store.reload();
			if (state === null) throw new Error("Workflow resume requires a durable workflow state.");
			if (state.status === "awaiting_user") {
				throw new Error(
					"Awaiting-user workflow requires a consumed one-use structured approval proof via respond.",
				);
			}
			if (state.status !== "paused") throw new Error("Only a user-paused workflow can be resumed.");
			if (state.phase === "adjudicating") {
				const approvals = context.services.approvals;
				if (approvals === undefined)
					throw new Error(
						"Paused adjudication cannot resume without a host approval manager and pending request.",
					);
				const pending = state.approvalRequest ?? (await approvals.pending(context.workflowId));
				if (pending === null)
					throw new Error("Paused adjudication cannot resume without a durable pending approval request.");
				await appendGoalTransition(
					context,
					"awaiting_user",
					"adjudicating",
					"Start approval remains required after operator resume.",
				);
				return shellStatus(context);
			}
			await assertNoPendingApproval(context, state);
			await appendGoalTransition(context, "active", "planning", command.note ?? "resumed by operator");
			return shellStatus(context);
		}
		case "cancel":
			return cancelWorkflow(context, command.reason ?? "cancelled by operator");
		default: {
			const exhaustive: never = command;
			throw new Error(`Unsupported workflow command ${exhaustive}.`);
		}
	}
}

/**
 * Opens a provider-free shell against an already durable workflow context.
 *
 * Args:
 * input: A persisted context and explicit session-persistence marker.
 * Return: A shell whose state is reloaded from the journal before inspection.
 */
export async function createProviderFreeWorkflowPhaseHost(
	input: ProviderFreeWorkflowPhaseHostInput,
): Promise<WorkflowPhaseHost> {
	if (input.persistSession !== true) throw new Error("Provider-free workflow shell requires persisted session state.");
	if (input.context.workflowId.length === 0 || input.context.rootSessionId.length === 0)
		throw new Error("Provider-free workflow shell requires workflow and root-session identities.");
	if (input.context.store !== input.context.services.store)
		throw new Error("Workflow phase host store and service store must be the same durable port.");
	const state = await input.context.services.store.reload();
	if (state !== null && state.workflowId !== input.context.workflowId)
		throw new Error("Provider-free workflow shell cannot reopen another workflow's state.");
	if (state !== null && state.rootSessionId !== input.context.rootSessionId)
		throw new Error("Provider-free workflow shell cannot bind state from another root session.");
	assertWorkflowStartBound(state);
	const goalCoordinator = input.context.services.goal;
	const replayStore = input.context.services.store as WorkflowGoalReplayStorePort;
	if (goalCoordinator?.reconcile !== undefined && replayStore.journal !== undefined)
		await goalCoordinator.reconcile(input.context.workflowId, await replayStore.journal.replayLogicalHistory());
	const blockerReplay = await replayExternalBlocker(input.context);
	const reconciledState = await input.context.services.store.reload();
	if (blockerReplay.unresolved !== null) {
		externalBlockers.set(input.context, blockerReplay.unresolved);
		if (reconciledState?.status === "active")
			await appendGoalTransition(
				input.context,
				"blocked",
				"recovering",
				`external-blocker:${blockerReplay.unresolved.blockerId}`,
			);
	} else {
		externalBlockers.delete(input.context);
		if (
			blockerReplay.latestRecord !== null &&
			reconciledState?.status === "blocked" &&
			reconciledState.goalLastReason === `external-blocker:${blockerReplay.latestRecord.blockerId}`
		)
			await appendGoalTransition(
				input.context,
				"active",
				"planning",
				`external-blocker-resolved:${blockerReplay.latestRecord.blockerId}`,
			);
	}
	const handlers: WorkflowShellHandlers = {
		execute: (command) => executeCommand(input.context, command),
		status: () => shellStatus(input.context),
		learningPromotionReceipts: input.context.services.learningPromotionReceipts,
		accountAssistantUsage: input.context.services.goalAccounting?.accountAssistantUsage,
		accountContinuation: input.context.services.goalAccounting?.accountContinuation,
	};
	const shell = createWorkflowShell(handlers);
	let disposed = false;
	return {
		execute: shell.execute,
		status: shell.status,
		learningPromotionReceipts: shell.learningPromotionReceipts,
		accountAssistantUsage: shell.accountAssistantUsage,
		accountContinuation: shell.accountContinuation,
		blockOnExternal: (blocker) => {
			if (disposed) throw new Error("Workflow shell has been disposed.");
			return blockOnExternal(input.context, blocker);
		},
		resumeBlocked: (event) => {
			if (disposed) throw new Error("Workflow shell has been disposed.");
			return resumeBlocked(input.context, event);
		},
		runOutcome: (outcome) => {
			if (disposed) throw new Error("Workflow shell has been disposed.");
			return runOutcome(input.context, outcome);
		},
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			await shell.dispose?.();
		},
	};
}

export async function reopenWorkflowPhaseHost(input: ProviderFreeWorkflowPhaseHostInput): Promise<WorkflowPhaseHost> {
	return createProviderFreeWorkflowPhaseHost(input);
}

export interface WorkflowPhaseHost extends WorkflowShell {
	blockOnExternal(input: WorkflowExternalBlockerInput): Promise<WorkflowShellStatus>;
	resumeBlocked(event: WorkflowExternalResumeEvent): Promise<WorkflowShellStatus>;
	runOutcome(outcome: WorkflowPhaseOutcomeRecord): Promise<WorkflowState>;
}
