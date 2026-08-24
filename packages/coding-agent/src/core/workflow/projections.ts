import { type GoalState, type GoalStatus, normalizeGoalState } from "../goals.js";
import type {
	WorkflowArtifactRef,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowGoalContract,
	WorkflowGoalMutationDelta,
	WorkflowGoalStatus,
	WorkflowHostReceiptConsumerContext,
	WorkflowJournalEvent,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowPhaseId,
	WorkflowProgressEntry,
	WorkflowScorecard,
	WorkflowScorecardAcceptanceCheck,
	WorkflowScorecardInvariant,
	WorkflowStatus,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { digestObject, parseCanonicalJsonBytes, resolveAndVerifyWorkflowHostReceipt, sha256Hex } from "./contracts.js";
import type { WorkflowGoalProjectionAuthorization } from "./journal.js";

/**
 * Identifies the durable event recorded alongside a goal projection.
 *
 * This shape is persisted as event metadata only. It is not accepted as
 * authority by the AgentSession compare-and-swap boundary.
 */
export interface WorkflowGoalProjectionBinding {
	workflowId: string;
	eventSequence: number;
	transitionDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
}

const WORKFLOW_GOAL_STATE_KEYS = new Set([
	"active",
	"status",
	"workflowId",
	"goalId",
	"objective",
	"tokenBudget",
	"tokensUsed",
	"timeUsedSeconds",
	"continuationsUsed",
	"createdAt",
	"updatedAt",
	"lastReason",
	"lastError",
]);

/**
 * Removes optional `undefined` fields from the public GoalState snapshot used by workflow digests.
 *
 * Args:
 * goal: Persisted GoalState read from the session branch.
 * Return: Canonicalizable GoalState snapshot with the same values.
 */
export function workflowGoalProjectionSnapshot(goal: GoalState): GoalState {
	const prototype = Object.getPrototypeOf(goal);
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		Object.getOwnPropertySymbols(goal).length > 0 ||
		Object.keys(goal).some((key) => !WORKFLOW_GOAL_STATE_KEYS.has(key))
	)
		throw new Error("Workflow GoalState projection contains fields outside the durable GoalState contract.");
	return {
		active: goal.active,
		status: goal.status,
		tokensUsed: goal.tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds,
		continuationsUsed: goal.continuationsUsed,
		...(goal.workflowId === undefined ? {} : { workflowId: goal.workflowId }),
		...(goal.goalId === undefined ? {} : { goalId: goal.goalId }),
		...(goal.objective === undefined ? {} : { objective: goal.objective }),
		...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
		...(goal.createdAt === undefined ? {} : { createdAt: goal.createdAt }),
		...(goal.updatedAt === undefined ? {} : { updatedAt: goal.updatedAt }),
		...(goal.lastReason === undefined ? {} : { lastReason: goal.lastReason }),
		...(goal.lastError === undefined ? {} : { lastError: goal.lastError }),
	};
}
/**
 * Computes the canonical digest used to bind a workflow transition to GoalState.
 *
 * Args:
 * goal: Persisted GoalState snapshot.
 * Return: SHA-256 digest of the canonical projection snapshot.
 */
export function digestWorkflowGoalState(goal: GoalState): string {
	return digestObject(workflowGoalProjectionSnapshot(goal));
}

/**
 * Goal event kinds that may authorize a user-facing GoalState projection.
 *
 * The journal authenticates the event before issuing the opaque authorization;
 * this list is only the reducer-facing allowlist for the exact transition.
 */
export type WorkflowGoalProjectionEventKind =
	| "goal_binding_committed"
	| "workflow_status_changed"
	| "goal_projection_applied";

export type WorkflowGoalMutationSource =
	| "workflow_start"
	| "workflow_status"
	| "workflow_approval"
	| "workflow_budget"
	| "workflow_continuation"
	| "workflow_usage"
	| "workflow_error"
	| "workflow_completion"
	| "workflow_cancellation";

export type WorkflowGoalTransitionPayload = Extract<
	WorkflowEventPayload,
	{ kind: "goal_binding_committed" | "workflow_status_changed" | "goal_projection_applied" }
>;

export interface WorkflowGoalTransitionRequest {
	workflowId: string;
	source: WorkflowGoalMutationSource;
	expectedGoalDigest: string;
	payload: WorkflowGoalTransitionPayload;
	expectedHead: WorkflowJournalHead;
	expectedEpoch: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	idempotencyKey: string;
	writerIdentity: string;
	executionKey: string | null;
}

export interface WorkflowGoalProjectionAdapter {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState, authorization: WorkflowGoalProjectionAuthorization): boolean;
}

export interface WorkflowGoalMeteringProof {
	receipt: WorkflowVerifiedHostReceipt;
	artifactRef: WorkflowVerifiedHostReceipt["artifactRef"];
	proofDigest: string;
}

export interface WorkflowGoalAccountingRequest extends WorkflowGoalTransitionRequest {
	meteringProof: WorkflowGoalMeteringProof;
	receiptContext: WorkflowHostReceiptConsumerContext;
	currentRevision: number;
	trustedNow: string;
}

export interface WorkflowGoalCoordinator {
	read(workflowId: string): GoalState;
	transition(request: WorkflowGoalTransitionRequest): Promise<GoalState>;
	reconcile?(workflowId: string, events: readonly WorkflowJournalEvent[]): Promise<GoalState>;
	accountAssistantUsage(request: WorkflowGoalAccountingRequest): Promise<GoalState>;
	accountContinuation(request: WorkflowGoalAccountingRequest): Promise<GoalState>;
}

export interface WorkflowGoalCoordinatorDependencies {
	adapter: WorkflowGoalProjectionAdapter;
	append(request: WorkflowGoalTransitionRequest): Promise<{
		eventSequence: number;
		transitionDigest: string;
		payload: WorkflowGoalTransitionPayload;
	}>;
	readCommitted(
		workflowId: string,
		idempotencyKey: string,
	): Promise<{
		eventSequence: number;
		transitionDigest: string;
		payload: WorkflowGoalTransitionPayload;
	} | null>;
	readHead(workflowId: string): Promise<WorkflowJournalHead>;
	authorize(input: {
		eventSequence: number;
		eventDigest: string;
		expectedGoal: GoalState;
		nextGoal: GoalState;
	}): Promise<WorkflowGoalProjectionAuthorization>;
}

function isWorkflowGoalTransitionEvent(
	event: WorkflowJournalEvent,
): event is WorkflowJournalEvent & { payload: WorkflowGoalTransitionPayload } {
	return (
		event.payload.kind === "goal_binding_committed" ||
		event.payload.kind === "workflow_status_changed" ||
		event.payload.kind === "goal_projection_applied"
	);
}

export interface WorkflowGoalProgressObservation {
	requirementId: string;
	acceptanceCheckIds: readonly string[];
	protectedInvariantIds: readonly string[];
	evidenceRefs: readonly WorkflowArtifactRef[];
	evidenceRevisions: readonly number[];
	workspaceDigest: string;
	auditorDecisionDigest: string;
	independent: boolean;
	outcomeVerified: boolean;
	metricIds?: readonly string[];
	metricEvidenceIndependent?: boolean;
	proxyOnly?: boolean;
	metricOnly?: boolean;
	activityOnly?: boolean;
	selfReported?: boolean;
	regressed?: boolean;
	regressionReason?: string;
	invalidatedByDecisionId?: string | null;
	observedAt?: string;
}

export interface WorkflowGoalProgressState {
	contractRevision: number;
	scorecardRevision: number;
	entries: readonly WorkflowProgressEntry[];
	acceptedAcceptanceCheckIds: readonly string[];
	holdingInvariantIds: readonly string[];
	acceptedMetricIds: readonly string[];
	progressDigest: string;
}

export interface WorkflowGoalProjectionState {
	workflowId: string;
	goalId: string | null;
	objective: string | null;
	goal: GoalState;
	workflowStatus: WorkflowStatus;
	phase: WorkflowPhaseId | null;
	goalContract: WorkflowGoalContract | null;
	scorecard: WorkflowScorecard | null;
	goalContractDigest: string | null;
	scorecardDigest: string | null;
	acceptanceCheckIds: readonly string[];
	protectedInvariantIds: readonly string[];
	acceptedAcceptanceCheckIds: readonly string[];
	holdingInvariantIds: readonly string[];
	acceptedMetricIds: readonly string[];
	provenRequirementIds: readonly string[];
	unprovenRequirementIds: readonly string[];
	regressedRequirementIds: readonly string[];
	progress: WorkflowGoalProgressState;
	completionEligible: boolean;
	sourceJournalSequence: number;
	sourceJournalDigest: string | null;
	goalProjectionDigest: string | null;
	appliedEventDigests: readonly string[];
}

export type WorkflowGoalProjectionPayload = Extract<
	WorkflowEventPayload,
	{
		kind:
			| "workflow_started"
			| "goal_binding_committed"
			| "goal_contract_proposed"
			| "scorecard_proposed"
			| "workflow_status_changed"
			| "goal_projection_applied";
	}
>;

export interface WorkflowGoalProjectionEvent {
	sequence: number;
	eventDigest: string;
	payload: WorkflowGoalProjectionPayload;
}

export interface WorkflowGoalProjectionInput {
	workflowId: string;
	goalId: string;
	objective: string;
	goalContract?: WorkflowGoalContract | null;
	scorecard?: WorkflowScorecard | null;
	tokenBudget?: number | null;
	createdAt?: number | null;
	updatedAt?: number | null;
}

/**
 * Creates a deterministic initial projection for one workflow-owned goal.
 *
 * Args:
 * input: Immutable workflow identity, objective, contract, and scorecard.
 * Return: A projection whose requirements start unproven.
 */
export function createWorkflowGoalProjection(input: WorkflowGoalProjectionInput): WorkflowGoalProjectionState {
	assertNonEmpty(input.workflowId, "Workflow goal projection requires a workflow ID.");
	assertNonEmpty(input.goalId, "Workflow goal projection requires a goal ID.");
	assertNonEmpty(input.objective, "Workflow goal projection requires an objective.");
	if (input.goalContract !== undefined && input.goalContract !== null) {
		assertGoalContract(input.goalContract, input.goalId, input.objective);
	}
	if (input.scorecard !== undefined && input.scorecard !== null) {
		assertScorecard(input.scorecard);
	}
	if (
		input.goalContract !== undefined &&
		input.goalContract !== null &&
		input.scorecard !== undefined &&
		input.scorecard !== null
	) {
		assertContractScorecardBindings(input.goalContract, input.scorecard);
	}

	const goal: GoalState = {
		active: true,
		status: "active",
		goalId: input.goalId,
		objective: input.objective,
		tokenBudget: input.tokenBudget === null ? undefined : input.tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		continuationsUsed: 0,
		createdAt: input.createdAt ?? undefined,
		updatedAt: input.updatedAt ?? undefined,
	};
	const requirements = input.goalContract?.requirements ?? [];
	const entries = requirements.map((requirement) =>
		createUnprovenProgressEntry(input.workflowId, requirement.requirementId),
	);
	const progress = createProgressState(
		input.goalContract?.revision ?? 0,
		input.scorecard?.revision ?? 0,
		entries,
		[],
		[],
		[],
	);
	const state: WorkflowGoalProjectionState = {
		workflowId: input.workflowId,
		goalId: input.goalId,
		objective: input.objective,
		goal,
		workflowStatus: "active",
		phase: input.goalContract === undefined || input.goalContract === null ? null : "hardening_goal",
		goalContract: input.goalContract ?? null,
		scorecard: input.scorecard ?? null,
		goalContractDigest: input.goalContract?.contractDigest ?? null,
		scorecardDigest: input.scorecard?.scorecardDigest ?? null,
		acceptanceCheckIds: input.scorecard?.acceptanceChecks.map((check) => check.checkId) ?? [],
		protectedInvariantIds: input.scorecard?.protectedInvariants.map((invariant) => invariant.invariantId) ?? [],
		acceptedAcceptanceCheckIds: [],
		holdingInvariantIds: [],
		acceptedMetricIds: [],
		provenRequirementIds: [],
		unprovenRequirementIds: requirements.map((requirement) => requirement.requirementId),
		regressedRequirementIds: [],
		progress,
		completionEligible: false,
		sourceJournalSequence: 0,
		sourceJournalDigest: null,
		goalProjectionDigest: null,
		appliedEventDigests: [],
	};
	return state;
}

/**
 * Applies immutable workflow events to a goal projection in journal order.
 *
 * Args:
 * state: Current deterministic goal projection.
 * events: Committed goal-related event records in any replay batch.
 * Return: The replayed projection, or the original state for exact retries.
 */
export function projectWorkflowGoalEvents(
	state: WorkflowGoalProjectionState,
	events: readonly WorkflowGoalProjectionEvent[],
): WorkflowGoalProjectionState {
	let projected = structuredClone(state);
	const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
	for (const event of ordered) {
		assertEventIdentity(event);
		if (projected.appliedEventDigests.includes(event.eventDigest)) {
			continue;
		}
		if (event.sequence <= projected.sourceJournalSequence) {
			throw new Error("Workflow goal replay encountered a stale or conflicting event sequence.");
		}
		projected = applyProjectionPayload(projected, event.payload);
		projected = refreshProjectionMetadata(projected, event.sequence, event.eventDigest);
	}
	return projected;
}

/**
 * Replays a persisted event prefix from a fresh projection.
 *
 * Args:
 * input: Immutable goal projection input.
 * events: Committed goal-related event records.
 * Return: The deterministic replay result.
 */
export function replayWorkflowGoalProjection(
	input: WorkflowGoalProjectionInput,
	events: readonly WorkflowGoalProjectionEvent[],
): WorkflowGoalProjectionState {
	return projectWorkflowGoalEvents(createWorkflowGoalProjection(input), events);
}

/**
 * Applies an independently audited requirement observation to the projection.
 *
 * Args:
 * state: Current goal projection.
 * observation: Host-validated outcome, acceptance, invariant, and evidence facts.
 * Return: The updated projection with proven or regressed requirement state.
 */
export function applyWorkflowGoalProgress(
	state: WorkflowGoalProjectionState,
	observation: WorkflowGoalProgressObservation,
): WorkflowGoalProjectionState {
	assertProgressObservation(state, observation);
	const existing = state.progress.entries.find((entry) => entry.requirementId === observation.requirementId);
	if (existing === undefined) {
		throw new Error(`Workflow progress references unknown requirement ${observation.requirementId}.`);
	}
	const isRegression = observation.regressed === true;
	if (
		isRegression &&
		(observation.regressionReason === undefined || observation.regressionReason.trim().length === 0)
	) {
		throw new Error("Workflow regression requires a durable reason.");
	}
	const entry: WorkflowProgressEntry = {
		...existing,
		status: isRegression ? "regressed" : "proven",
		evidenceRefs: [...observation.evidenceRefs],
		evidenceRevisions: [...observation.evidenceRevisions],
		regressionReason: isRegression ? (observation.regressionReason ?? "current-audit-regression") : null,
		workspaceDigest: observation.workspaceDigest,
		auditorDecisionRef: existing.auditorDecisionRef,
		observedAt: observation.observedAt ?? existing.observedAt,
		invalidatedByDecisionId: isRegression
			? (observation.invalidatedByDecisionId ?? observation.auditorDecisionDigest)
			: null,
	};
	const entries = state.progress.entries.map((candidate) =>
		candidate.requirementId === observation.requirementId ? entry : candidate,
	);
	const acceptedRequirementIds = entries
		.filter((candidate) => candidate.status === "proven")
		.map((candidate) => candidate.requirementId)
		.sort();
	const regressedRequirementIds = entries
		.filter((candidate) => candidate.status === "regressed")
		.map((candidate) => candidate.requirementId)
		.sort();
	const unprovenRequirementIds = entries
		.filter((candidate) => candidate.status === "unproven")
		.map((candidate) => candidate.requirementId)
		.sort();
	const acceptedAcceptanceCheckIds = isRegression
		? state.acceptedAcceptanceCheckIds
		: uniqueSorted([...state.acceptedAcceptanceCheckIds, ...observation.acceptanceCheckIds]);
	const holdingInvariantIds = isRegression
		? state.holdingInvariantIds
		: uniqueSorted([...state.holdingInvariantIds, ...observation.protectedInvariantIds]);
	const acceptedMetricIds = isRegression
		? state.acceptedMetricIds
		: uniqueSorted([...state.acceptedMetricIds, ...(observation.metricIds ?? [])]);
	const progress = createProgressState(
		state.progress.contractRevision,
		state.progress.scorecardRevision,
		entries,
		acceptedAcceptanceCheckIds,
		holdingInvariantIds,
		acceptedMetricIds,
	);
	return {
		...state,
		acceptedAcceptanceCheckIds,
		holdingInvariantIds,
		acceptedMetricIds,
		provenRequirementIds: acceptedRequirementIds,
		unprovenRequirementIds,
		regressedRequirementIds,
		progress,
		completionEligible: calculateCompletionEligibility({
			...state,
			provenRequirementIds: acceptedRequirementIds,
			unprovenRequirementIds,
			regressedRequirementIds,
			acceptedAcceptanceCheckIds,
			holdingInvariantIds,
			acceptedMetricIds,
		}),
	};
}

/**
 * Reports whether all hardened requirements and scorecard gates are currently proven.
 *
 * Args:
 * state: Current goal projection.
 * Return: True only when outcome evidence, acceptance checks, invariants, and metrics pass.
 */
export function isWorkflowGoalComplete(state: WorkflowGoalProjectionState): boolean {
	return state.completionEligible;
}

/**
 * Maps a workflow status to the existing user-facing bound GoalState status.
 *
 * Args:
 * status: Authoritative workflow status.
 * current: Current bound goal, used for diagnostic context.
 * reason: Host reason for unsupported values.
 * Return: The corresponding existing GoalState status.
 */
export function mapWorkflowStatusToGoalStatus(status: WorkflowStatus, current: GoalState, reason: string): GoalStatus {
	switch (status) {
		case "active":
			return "active";
		case "awaiting_user":
		case "paused":
		case "cancelled":
		case "blocked":
			return "paused";
		case "budget_limited":
			return "budget_limited";
		case "failed":
			return "error";
		case "complete":
			return "complete";
		default: {
			const unsupported: never = status;
			throw new Error(
				`Unsupported workflow status ${unsupported} for goal ${current.goalId ?? "unknown"}: ${reason}`,
			);
		}
	}
}

/**
 * Delegates one event-first GoalState transition to the workflow coordinator.
 *
 * Args:
 * coordinator: Journal-backed goal coordinator.
 * request: Expected-head and expected-goal CAS request.
 * Return: The resulting projected GoalState.
 */
export function projectWorkflowGoalTransition(
	coordinator: WorkflowGoalCoordinator,
	request: WorkflowGoalTransitionRequest,
): Promise<GoalState> {
	return coordinator.transition(request);
}

/**
 * Derives the only GoalState snapshot authorized by one goal transition payload.
 *
 * Args:
 * expected: Stable persisted GoalState before the authenticated event.
 * payload: Canonical journal payload carrying the goal mutation.
 * Return: Normalized GoalState snapshot that the payload is allowed to publish.
 */
export function applyWorkflowGoalTransition(expected: GoalState, payload: WorkflowGoalTransitionPayload): GoalState {
	const workflowId =
		payload.kind === "goal_binding_committed"
			? payload.workflowId
			: payload.kind === "goal_projection_applied"
				? payload.binding.workflowId
				: (expected.workflowId ?? "workflow-goal-projection");
	if (payload.kind === "goal_binding_committed") {
		if (
			payload.goalId.length === 0 ||
			payload.objective.length === 0 ||
			payload.goalDelta.goalId !== payload.goalId ||
			payload.goalDelta.objective !== payload.objective ||
			payload.goalDelta.status !== "active" ||
			!payload.goalDelta.active
		)
			throw new Error("Workflow goal binding is not bound to its exact goal identity and objective.");
		return normalizeGoalState(
			applyGoalDelta(expected, payload.goalDelta, workflowId, payload.goalId, payload.objective),
		);
	}
	if (payload.kind === "workflow_status_changed") {
		const expectedStatus = mapWorkflowStatusToGoalStatus(payload.status, expected, payload.reason);
		if (payload.goalDelta.status !== expectedStatus || payload.goalDelta.active !== (payload.status === "active")) {
			throw new Error("Workflow goal status transition is not bound to its exact GoalState delta.");
		}
		return normalizeGoalState(applyGoalDelta(expected, payload.goalDelta, workflowId));
	}
	// A projection-applied event records the target status of the committed transition;
	// applyGoalDelta validates its identity, monotonic counters, timestamp, and status shape.
	return normalizeGoalState(applyGoalDelta(expected, payload.goalDelta, workflowId));
}

/**
 * Creates the event-first GoalState coordinator used by bound workflows.
 *
 * Args:
 * dependencies: Projection adapter and durable append/read seams.
 * Return: Coordinator that commits before exactly one projection CAS.
 */
export function createWorkflowGoalCoordinator(
	dependencies: WorkflowGoalCoordinatorDependencies,
): WorkflowGoalCoordinator {
	const readSnapshot = (workflowId: string): GoalState => {
		const goal = dependencies.adapter.read();
		if (workflowId.length === 0) {
			throw new Error("Workflow GoalState projection requires a workflow identity.");
		}
		return structuredClone(goal);
	};
	const read = (workflowId: string): GoalState => {
		const goal = readSnapshot(workflowId);
		if (goal.goalId === undefined || goal.objective === undefined) {
			throw new Error("Workflow GoalState projection is not durably bound to a workflow.");
		}
		return goal;
	};
	const readForTransition = (request: WorkflowGoalTransitionRequest): GoalState => {
		const goal = readSnapshot(request.workflowId);
		const hasGoalId = goal.goalId !== undefined;
		const hasObjective = goal.objective !== undefined;
		if (hasGoalId !== hasObjective) {
			throw new Error("Workflow GoalState projection is only partially bound.");
		}
		if (hasGoalId) return goal;
		if (request.source !== "workflow_start" || request.payload.kind !== "goal_binding_committed") {
			throw new Error("Only an authenticated workflow start may bind an unbound GoalState projection.");
		}
		return goal;
	};
	const recoverCommittedProjection = async (
		request: WorkflowGoalTransitionRequest,
		current: GoalState,
		committedEvent: {
			eventSequence: number;
			transitionDigest: string;
			payload: WorkflowGoalTransitionPayload;
		},
	): Promise<GoalState> => {
		const projectionIdempotencyKey = `${request.idempotencyKey}:goal-projection`;
		const persistedProjection = await dependencies.readCommitted(request.workflowId, projectionIdempotencyKey);
		const projectionCommit =
			committedEvent.payload.kind === "goal_projection_applied"
				? committedEvent
				: (persistedProjection ??
					(await dependencies.append({
						...request,
						expectedHead: {
							workflowId: request.workflowId,
							sequence: committedEvent.eventSequence,
							eventDigest: committedEvent.transitionDigest,
							epochRef: request.expectedEpoch,
						},
						idempotencyKey: projectionIdempotencyKey,
						payload: {
							kind: "goal_projection_applied",
							binding: {
								workflowId: request.workflowId,
								eventSequence: committedEvent.eventSequence + 1,
								transitionDigest: committedEvent.transitionDigest,
								storeEpoch: request.expectedEpoch.storeEpoch,
								coordinatorEpoch: request.expectedEpoch.coordinatorEpoch,
							},
							goalDigest: digestObject(committedEvent.payload.goalDelta),
							goalDelta: committedEvent.payload.goalDelta,
						},
					})));
		if (projectionCommit.payload.kind !== "goal_projection_applied") {
			throw new Error("Goal transition did not emit the required durable projection-applied event.");
		}
		const next = applyWorkflowGoalTransition(current, projectionCommit.payload);
		const projected = dependencies.adapter.read();
		if (digestWorkflowGoalState(projected) === digestWorkflowGoalState(next)) {
			return structuredClone(projected);
		}
		const authorization = await dependencies.authorize({
			eventSequence: projectionCommit.eventSequence,
			eventDigest: projectionCommit.transitionDigest,
			expectedGoal: projected,
			nextGoal: next,
		});
		if (!dependencies.adapter.compareAndSwap(projected, next, authorization)) {
			throw new Error(
				"Workflow GoalState projection compare-and-swap conflict after authenticated historical replay.",
			);
		}
		return structuredClone(next);
	};
	const transition = async (request: WorkflowGoalTransitionRequest): Promise<GoalState> => {
		const current = readForTransition(request);
		const historical = await dependencies.readCommitted(request.workflowId, request.idempotencyKey);
		if (historical !== null) {
			return recoverCommittedProjection(request, current, historical);
		}
		if (digestWorkflowGoalState(current) !== request.expectedGoalDigest) {
			const raced = await dependencies.readCommitted(request.workflowId, request.idempotencyKey);
			if (raced !== null) return recoverCommittedProjection(request, readForTransition(request), raced);
			throw new Error("Workflow GoalState transition CAS is stale.");
		}
		const head = await dependencies.readHead(request.workflowId);
		if (
			digestObject(head) !== digestObject(request.expectedHead) ||
			digestObject(head.epochRef) !== digestObject(request.expectedEpoch)
		) {
			const raced = await dependencies.readCommitted(request.workflowId, request.idempotencyKey);
			if (raced !== null) return recoverCommittedProjection(request, readForTransition(request), raced);
			throw new Error("Workflow GoalState transition head or epoch is stale.");
		}
		try {
			const appended = await dependencies.append(request);
			return recoverCommittedProjection(request, current, appended);
		} catch (error) {
			const raced = await dependencies.readCommitted(request.workflowId, request.idempotencyKey);
			if (raced !== null) return recoverCommittedProjection(request, readForTransition(request), raced);
			throw error;
		}
	};
	const account = async (
		request: WorkflowGoalAccountingRequest,
		kind: "usage" | "continuation",
	): Promise<GoalState> => {
		const current = read(request.workflowId);
		if (
			request.meteringProof.artifactRef.digest !== request.meteringProof.receipt.artifactRef.digest ||
			request.meteringProof.proofDigest.length === 0
		) {
			throw new Error("Goal accounting requires an authenticated host metering proof.");
		}
		const artifact = await request.receiptContext.artifactResolver.resolve(request.meteringProof.artifactRef);
		if (
			!artifact.exists ||
			!artifact.envelope.immutable ||
			artifact.verifiedDigest !== request.meteringProof.artifactRef.digest ||
			sha256Hex(artifact.bytes) !== request.meteringProof.artifactRef.digest
		) {
			throw new Error("Goal metering proof bytes are not resolver-verified.");
		}
		const value = parseCanonicalJsonBytes(artifact.bytes);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Goal metering proof is not a canonical host record.");
		}
		const metering = value as {
			tokenDelta?: unknown;
			wallTimeDeltaSeconds?: unknown;
			continuationDelta?: unknown;
			proofDigest?: unknown;
		};
		const meteringDigestInput = {
			tokenDelta: metering.tokenDelta,
			wallTimeDeltaSeconds: metering.wallTimeDeltaSeconds,
			continuationDelta: metering.continuationDelta,
			proofDigest: "",
		};
		if (
			metering.proofDigest !== request.meteringProof.proofDigest ||
			metering.proofDigest !== digestObject(meteringDigestInput) ||
			typeof metering.tokenDelta !== "number" ||
			!Number.isSafeInteger(metering.tokenDelta) ||
			metering.tokenDelta < 0 ||
			typeof metering.wallTimeDeltaSeconds !== "number" ||
			!Number.isFinite(metering.wallTimeDeltaSeconds) ||
			metering.wallTimeDeltaSeconds < 0 ||
			typeof metering.continuationDelta !== "number" ||
			!Number.isSafeInteger(metering.continuationDelta) ||
			metering.continuationDelta < 0
		) {
			throw new Error("Goal metering deltas are not finite, nonnegative, or host-authenticated.");
		}
		await resolveAndVerifyWorkflowHostReceipt({
			context: request.receiptContext,
			workflowId: request.workflowId,
			expectedBindingDigest: digestObject({
				workflowId: request.workflowId,
				expectedHead: request.expectedHead,
				expectedEpoch: request.expectedEpoch,
				kind,
				meteringDigest: request.meteringProof.proofDigest,
			}),
			receipt: request.meteringProof.receipt,
			currentStateDigest: request.expectedHead.eventDigest ?? request.expectedGoalDigest,
			currentRevision: request.currentRevision,
			trustedNow: request.trustedNow,
		});
		const goalDelta: WorkflowGoalMutationDelta = {
			...toWorkflowGoalMutationDelta(current),
			tokensUsed: current.tokensUsed + metering.tokenDelta,
			timeUsedSeconds: current.timeUsedSeconds + metering.wallTimeDeltaSeconds,
			continuationsUsed: current.continuationsUsed + metering.continuationDelta,
		};
		if (current.tokenBudget !== undefined && goalDelta.tokensUsed > current.tokenBudget) {
			throw new Error("Authenticated goal metering exceeds the durable token budget.");
		}
		const binding: WorkflowGoalProjectionBinding = {
			workflowId: request.workflowId,
			eventSequence: request.expectedHead.sequence + 1,
			transitionDigest: digestObject({
				workflowId: request.workflowId,
				source: request.source,
				expectedGoalDigest: request.expectedGoalDigest,
				expectedHead: request.expectedHead,
				expectedEpoch: request.expectedEpoch,
				leaseRef: request.leaseRef,
				idempotencyKey: request.idempotencyKey,
				writerIdentity: request.writerIdentity,
				executionKey: request.executionKey,
				meteringProof: {
					receipt: request.meteringProof.receipt,
					artifactRef: request.meteringProof.artifactRef,
					proofDigest: request.meteringProof.proofDigest,
				},
				currentRevision: request.currentRevision,
				trustedNow: request.trustedNow,
				goalDelta,
			}),
			storeEpoch: request.expectedEpoch.storeEpoch,
			coordinatorEpoch: request.expectedEpoch.coordinatorEpoch,
		};
		return transition({
			...request,
			source: kind === "usage" ? "workflow_usage" : "workflow_continuation",
			payload: {
				kind: "goal_projection_applied",
				binding,
				goalDigest: digestObject(goalDelta),
				goalDelta,
			},
		});
	};
	const reconcile = async (workflowId: string, events: readonly WorkflowJournalEvent[]): Promise<GoalState> => {
		const latestGoalEvent = events
			.filter(isWorkflowGoalTransitionEvent)
			.filter((event) => event.workflowId === workflowId)
			.at(-1);
		const current = readSnapshot(workflowId);
		if (latestGoalEvent === undefined) return current;
		const next = applyWorkflowGoalTransition(current, latestGoalEvent.payload);
		if (digestWorkflowGoalState(current) === digestWorkflowGoalState(next)) return current;
		const authorization = await dependencies.authorize({
			eventSequence: latestGoalEvent.sequence,
			eventDigest: latestGoalEvent.eventDigest,
			expectedGoal: current,
			nextGoal: next,
		});
		if (!dependencies.adapter.compareAndSwap(current, next, authorization))
			throw new Error("Workflow goal projection recovery compare-and-swap conflict.");
		return structuredClone(next);
	};
	return {
		read,
		transition,
		reconcile,
		accountAssistantUsage: (request) => account(request, "usage"),
		accountContinuation: (request) => account(request, "continuation"),
	};
}

function applyProjectionPayload(
	state: WorkflowGoalProjectionState,
	payload: WorkflowGoalProjectionPayload,
): WorkflowGoalProjectionState {
	switch (payload.kind) {
		case "workflow_started":
			if (payload.workflowId !== state.workflowId || payload.objective !== state.objective) {
				throw new Error("Workflow start objective or identity does not match the bound goal projection.");
			}
			return { ...state, workflowStatus: "active", phase: "hardening_goal" };
		case "goal_binding_committed":
			return applyGoalDelta(state, payload.goalDelta, state.workflowId, payload.goalId, payload.objective);
		case "goal_contract_proposed":
			if (state.goalContractDigest !== null && state.goalContractDigest !== payload.contractDigest) {
				throw new Error("Workflow goal contract cannot be replaced by a projection event.");
			}
			return { ...state, goalContractDigest: payload.contractDigest };
		case "scorecard_proposed":
			if (state.scorecardDigest !== null && state.scorecardDigest !== payload.scorecardDigest) {
				throw new Error("Workflow scorecard cannot be replaced by a projection event.");
			}
			return { ...state, scorecardDigest: payload.scorecardDigest };
		case "workflow_status_changed":
			if (payload.status === "complete" && !state.completionEligible) {
				throw new Error(
					"Workflow completion cannot be projected without current requirement evidence and protected invariants.",
				);
			}
			return {
				...applyGoalDelta(state, payload.goalDelta, state.workflowId),
				workflowStatus: payload.status,
				phase: payload.phase,
			};
		case "goal_projection_applied":
			if (
				payload.binding.workflowId !== state.workflowId ||
				payload.binding.transitionDigest.length === 0 ||
				!Number.isSafeInteger(payload.binding.eventSequence) ||
				payload.binding.eventSequence < 1
			) {
				throw new Error("Workflow goal projection binding is incomplete or foreign.");
			}
			if (payload.goalDigest !== digestObject(payload.goalDelta)) {
				throw new Error("Workflow goal projection digest does not cover the complete goal delta.");
			}
			if (payload.goalDelta.status === "complete" && !state.completionEligible) {
				throw new Error(
					"Workflow completion cannot be projected without current requirement evidence and protected invariants.",
				);
			}
			return {
				...applyGoalDelta(state, payload.goalDelta, state.workflowId),
				goalProjectionDigest: payload.goalDigest,
			};
		default: {
			throw new Error(
				"CONTRACT_CHANGE: canonical workflow journal has no authenticated goal contract/scorecard payload or workflow progress acceptance/regression event; synthetic projection inputs are not replayable.",
			);
		}
	}
}

function applyGoalDelta(
	state: WorkflowGoalProjectionState,
	delta: WorkflowGoalMutationDelta,
	workflowId: string,
	goalIdOverride?: string,
	objectiveOverride?: string,
): WorkflowGoalProjectionState;
function applyGoalDelta(
	state: GoalState,
	delta: WorkflowGoalMutationDelta,
	workflowId: string,
	goalIdOverride?: string,
	objectiveOverride?: string,
): GoalState;
function applyGoalDelta(
	state: WorkflowGoalProjectionState | GoalState,
	delta: WorkflowGoalMutationDelta,
	workflowId: string,
	goalIdOverride?: string,
	objectiveOverride?: string,
): WorkflowGoalProjectionState | GoalState {
	assertNonEmpty(workflowId, "Workflow GoalState projection requires a workflow ID.");
	const isProjection = isWorkflowGoalProjectionState(state);
	const currentGoal = isProjection ? state.goal : state;
	if (currentGoal.workflowId !== undefined && currentGoal.workflowId !== workflowId) {
		throw new Error("Workflow GoalState projection cannot replace its durable workflow owner.");
	}
	const currentGoalId = currentGoal.goalId ?? null;
	const nextGoalId = goalIdOverride ?? delta.goalId ?? currentGoalId;
	const currentObjective = currentGoal.objective ?? null;
	const nextObjective = objectiveOverride ?? delta.objective ?? currentObjective;
	if (nextGoalId === null || nextGoalId.length === 0 || nextGoalId !== currentGoalId) {
		if (currentGoalId !== null || nextGoalId === null || nextGoalId.length === 0) {
			throw new Error("Workflow GoalState projection cannot replace or clear the bound goal ID.");
		}
	}
	if (
		nextObjective === null ||
		nextObjective.length === 0 ||
		(currentObjective !== null && nextObjective !== currentObjective)
	) {
		if (currentObjective !== null || nextObjective === null || nextObjective.length === 0) {
			throw new Error("Workflow GoalState projection cannot replace or clear the hardened objective.");
		}
	}
	if (delta.tokenBudget !== null && (!Number.isSafeInteger(delta.tokenBudget) || delta.tokenBudget < 0)) {
		throw new Error("Workflow GoalState projection contains an invalid token budget.");
	}
	if (currentGoal.tokenBudget !== undefined && delta.tokenBudget !== currentGoal.tokenBudget) {
		throw new Error("Workflow GoalState projection cannot replace the durable token budget.");
	}
	if (
		!Number.isSafeInteger(delta.tokensUsed) ||
		delta.tokensUsed < currentGoal.tokensUsed ||
		(delta.tokenBudget !== null
			? delta.tokensUsed > delta.tokenBudget
			: currentGoal.tokenBudget !== undefined && delta.tokensUsed > currentGoal.tokenBudget) ||
		!Number.isFinite(delta.timeUsedSeconds) ||
		delta.timeUsedSeconds < currentGoal.timeUsedSeconds ||
		!Number.isSafeInteger(delta.continuationsUsed) ||
		delta.continuationsUsed < currentGoal.continuationsUsed
	) {
		throw new Error("Workflow GoalState accounting cannot regress durable usage counters.");
	}
	if (delta.createdAt !== null && !Number.isFinite(delta.createdAt)) {
		throw new Error("Workflow GoalState projection contains an invalid creation timestamp.");
	}
	if (currentGoal.createdAt !== undefined && delta.createdAt !== currentGoal.createdAt) {
		throw new Error("Workflow GoalState projection cannot replace its durable creation timestamp.");
	}
	if (delta.updatedAt !== null && !Number.isFinite(delta.updatedAt)) {
		throw new Error("Workflow GoalState projection contains an invalid update timestamp.");
	}
	if (currentGoal.updatedAt !== undefined && (delta.updatedAt === null || delta.updatedAt < currentGoal.updatedAt)) {
		throw new Error("Workflow GoalState projection cannot regress its durable update timestamp.");
	}
	const status = toGoalStatus(delta.status);
	if ((status === "active") !== delta.active) {
		throw new Error("Workflow GoalState projection active flag does not match its status.");
	}
	const nextGoal: GoalState = {
		...currentGoal,
		active: delta.active,
		status,
		workflowId: currentGoal.workflowId ?? workflowId,
		goalId: nextGoalId,
		objective: nextObjective,
		tokenBudget: delta.tokenBudget === null ? currentGoal.tokenBudget : delta.tokenBudget,
		tokensUsed: delta.tokensUsed,
		timeUsedSeconds: delta.timeUsedSeconds,
		continuationsUsed: delta.continuationsUsed,
		createdAt: delta.createdAt === null ? currentGoal.createdAt : delta.createdAt,
		updatedAt: delta.updatedAt === null ? currentGoal.updatedAt : delta.updatedAt,
		lastReason: delta.lastReason === null ? currentGoal.lastReason : delta.lastReason,
		lastError: delta.lastError === null ? currentGoal.lastError : delta.lastError,
	};
	if (isProjection) {
		return {
			...state,
			goalId: nextGoalId,
			objective: nextObjective,
			goal: nextGoal,
			completionEligible: status === "complete" ? state.completionEligible : false,
		};
	}
	return workflowGoalProjectionSnapshot(nextGoal);
}

function isWorkflowGoalProjectionState(
	state: WorkflowGoalProjectionState | GoalState,
): state is WorkflowGoalProjectionState {
	return "workflowId" in state && "goal" in state && "progress" in state;
}

function refreshProjectionMetadata(
	state: WorkflowGoalProjectionState,
	sequence: number,
	digest: string,
): WorkflowGoalProjectionState {
	return {
		...state,
		sourceJournalSequence: sequence,
		sourceJournalDigest: digest,
		appliedEventDigests: [...state.appliedEventDigests, digest],
	};
}

function createProgressState(
	contractRevision: number,
	scorecardRevision: number,
	entries: readonly WorkflowProgressEntry[],
	acceptedAcceptanceCheckIds: readonly string[],
	holdingInvariantIds: readonly string[],
	acceptedMetricIds: readonly string[],
): WorkflowGoalProgressState {
	const normalizedEntries = entries.map((entry) => structuredClone(entry));
	const normalizedAcceptedChecks = uniqueSorted(acceptedAcceptanceCheckIds);
	const normalizedInvariants = uniqueSorted(holdingInvariantIds);
	const normalizedMetrics = uniqueSorted(acceptedMetricIds);
	return {
		contractRevision,
		scorecardRevision,
		entries: normalizedEntries,
		acceptedAcceptanceCheckIds: normalizedAcceptedChecks,
		holdingInvariantIds: normalizedInvariants,
		acceptedMetricIds: normalizedMetrics,
		progressDigest: digestObject({
			contractRevision,
			scorecardRevision,
			entries: normalizedEntries,
			acceptedAcceptanceCheckIds: normalizedAcceptedChecks,
			holdingInvariantIds: normalizedInvariants,
			acceptedMetricIds: normalizedMetrics,
		}),
	};
}

function createUnprovenProgressEntry(workflowId: string, requirementId: string): WorkflowProgressEntry {
	return {
		requirementId,
		status: "unproven",
		evidenceRefs: [],
		evidenceRevisions: [],
		regressionReason: null,
		workspaceDigest: "",
		auditorDecisionRef: {
			decisionScope: { kind: "workflow", workflowId, rootSessionId: "projection" },
			decisionId: `unproven:${requirementId}`,
			revision: 0,
			storeEpoch: 0,
			coordinatorEpoch: 0,
			decisionDigest: "projection-initial",
		},
		observedAt: "",
		invalidatedByDecisionId: null,
	};
}

function assertProgressObservation(
	state: WorkflowGoalProjectionState,
	observation: WorkflowGoalProgressObservation,
): void {
	assertNonEmpty(observation.requirementId, "Workflow progress requires a requirement ID.");
	assertNonEmpty(observation.workspaceDigest, "Workflow progress requires a workspace digest.");
	assertNonEmpty(observation.auditorDecisionDigest, "Workflow progress requires an auditor decision digest.");
	if (
		observation.evidenceRefs.length === 0 ||
		observation.evidenceRevisions.length !== observation.evidenceRefs.length
	) {
		throw new Error("Workflow progress requires one revision for every immutable evidence reference.");
	}
	if (new Set(observation.evidenceRefs.map((ref) => ref.digest)).size !== observation.evidenceRefs.length) {
		throw new Error("Workflow progress evidence references must be immutable and non-duplicated.");
	}
	if (!observation.independent) {
		throw new Error("Workflow progress requires an independently audited observation.");
	}
	if (!observation.regressed && !observation.outcomeVerified) {
		throw new Error("Workflow progress requires independently verified outcome evidence.");
	}
	if (observation.proxyOnly || observation.metricOnly || observation.activityOnly || observation.selfReported) {
		throw new Error(
			"Workflow progress cannot be accepted from proxy, metric-only, activity-only, or self-reported evidence.",
		);
	}
	const requirement = state.goalContract?.requirements.find(
		(candidate) => candidate.requirementId === observation.requirementId,
	);
	if (requirement === undefined) {
		throw new Error(`Workflow progress references unknown requirement ${observation.requirementId}.`);
	}
	if (!observation.regressed) {
		if (requirement.acceptanceCheckIds.some((id) => !observation.acceptanceCheckIds.includes(id))) {
			throw new Error("Workflow progress does not cover every acceptance check for the requirement.");
		}
		if (state.protectedInvariantIds.some((id) => !observation.protectedInvariantIds.includes(id))) {
			throw new Error("Workflow progress does not cover every protected invariant.");
		}
		if (
			(observation.metricIds ?? []).some((id) => {
				const metric = state.scorecard?.metrics.find((candidate) => candidate.metricId === id);
				return metric === undefined || metric.requirementId !== observation.requirementId;
			})
		) {
			throw new Error("Workflow progress references a metric outside the approved requirement binding.");
		}
		if ((observation.metricIds?.length ?? 0) > 0 && observation.metricEvidenceIndependent !== true) {
			throw new Error("Workflow metric evidence requires an independent host evaluation.");
		}
	}
}

function calculateCompletionEligibility(state: WorkflowGoalProjectionState): boolean {
	const hasAllRequirements =
		state.unprovenRequirementIds.length === 0 &&
		state.regressedRequirementIds.length === 0 &&
		state.provenRequirementIds.length > 0;
	const hasAllChecks = state.acceptanceCheckIds.every((id) => state.acceptedAcceptanceCheckIds.includes(id));
	const hasAllInvariants =
		state.protectedInvariantIds.length > 0 &&
		state.protectedInvariantIds.every((id) => state.holdingInvariantIds.includes(id));
	const hasAllMetrics = (state.scorecard?.metrics ?? []).every((metric) =>
		state.acceptedMetricIds.includes(metric.metricId),
	);
	return hasAllRequirements && hasAllChecks && hasAllInvariants && hasAllMetrics;
}

function assertContractScorecardBindings(contract: WorkflowGoalContract, scorecard: WorkflowScorecard): void {
	const checkIds = new Set(scorecard.acceptanceChecks.map((check) => check.checkId));
	const requirementIds = new Set(contract.requirements.map((requirement) => requirement.requirementId));
	for (const requirement of contract.requirements) {
		if (requirement.acceptanceCheckIds.some((checkId) => !checkIds.has(checkId))) {
			throw new Error("Workflow scorecard does not preserve every contract acceptance check.");
		}
	}
	if (scorecard.metrics.some((metric) => !requirementIds.has(metric.requirementId))) {
		throw new Error("Workflow scorecard metric is not bound to an approved requirement.");
	}
}

function assertGoalContract(contract: WorkflowGoalContract, goalId: string, objective: string): void {
	if (
		contract.goalId !== goalId ||
		contract.originalObjective !== objective ||
		contract.revision < 1 ||
		contract.contractDigest.length === 0 ||
		contract.requirements.length === 0 ||
		contract.requirements.some((requirement) => requirement.requirementId.length === 0)
	) {
		throw new Error("Workflow goal contract is incomplete or changes the authoritative objective.");
	}
}

function assertScorecard(scorecard: WorkflowScorecard): void {
	if (
		scorecard.revision < 1 ||
		scorecard.scorecardDigest.length === 0 ||
		scorecard.acceptanceChecks.length === 0 ||
		scorecard.protectedInvariants.length === 0 ||
		scorecard.metrics.some((metric) => metric.requirementId.trim().length === 0) ||
		new Set(scorecard.acceptanceChecks.map((check) => check.checkId)).size !== scorecard.acceptanceChecks.length ||
		new Set(scorecard.protectedInvariants.map((invariant) => invariant.invariantId)).size !==
			scorecard.protectedInvariants.length
	) {
		throw new Error("Workflow scorecard must retain acceptance checks and protected invariants.");
	}
}

function assertEventIdentity(event: WorkflowGoalProjectionEvent): void {
	if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.eventDigest.length === 0) {
		throw new Error("Workflow goal replay event identity is incomplete.");
	}
}

function assertNonEmpty(value: string, message: string): void {
	if (value.trim().length === 0) {
		throw new Error(message);
	}
}

function toGoalStatus(status: WorkflowGoalStatus): GoalStatus {
	switch (status) {
		case "idle":
		case "active":
		case "paused":
		case "budget_limited":
		case "complete":
		case "error":
			return status;
		case "failed":
			return "error";
		case "blocked":
			return "paused";
		default: {
			const unsupported: never = status;
			throw new Error(`Unsupported workflow goal status ${unsupported}.`);
		}
	}
}

function toWorkflowGoalMutationDelta(goal: GoalState): WorkflowGoalMutationDelta {
	return {
		goalId: goal.goalId ?? null,
		objective: goal.objective ?? null,
		active: goal.active,
		status: goal.status,
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

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

export type WorkflowGoalProjectionAcceptanceCheck = WorkflowScorecardAcceptanceCheck;
export type WorkflowGoalProjectionInvariant = WorkflowScorecardInvariant;
