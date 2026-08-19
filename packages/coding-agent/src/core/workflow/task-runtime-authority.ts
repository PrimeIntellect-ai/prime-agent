import type {
	WorkflowArtifactRef,
	WorkflowEpochRef,
	WorkflowOutboxAppender,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreDurableContext,
} from "./contracts.js";
import { digestObject } from "./contracts.js";
import {
	type CoordinatorStatusInput,
	type CoordinatorStatusProjection,
	projectCoordinatorStatus,
} from "./coordinator-status.js";
import type { WorkflowCanonicalDispatchInput, WorkflowDispatcher, WorkflowDispatchResult } from "./dispatch.js";
import type { WorkflowEffectBroker } from "./effect-broker.js";
import type { WorkflowLeaseManager } from "./leases.js";
import type { WorkflowReconciliationOutcome, WorkflowRecoveryRequest } from "./recovery.js";
import type { WorkflowRuntimeRecoveryCoordinator } from "./runtime-recovery.js";
import { assertWorkflowRuntimeVersion } from "./runtime-store-adapter.js";
import type { WorkflowScheduler, WorkflowSchedulerEvent, WorkflowSchedulerState } from "./scheduler.js";
import type { WorkflowTaskGraph } from "./task-graph.js";

export type WorkflowTaskRuntimeStatusKind = Exclude<CoordinatorStatusProjection["status"], "needs_input">;

export interface WorkflowTaskRuntimeStatus {
	readonly status: WorkflowTaskRuntimeStatusKind;
	readonly goalRevisionDigest: string;
	readonly activeWorkers: number;
	readonly eligibleReadyTasks: number;
	readonly idleCapacity: number;
	readonly idleReason: CoordinatorStatusProjection["idleReason"] | null;
	readonly progressCutHeadDigest: string | null;
	readonly lastAuthoritativeProgressAt: string | null;
	readonly progressLeaseOwner: string | null;
	readonly progressLeaseDeadline: string | null;
	readonly progressPredicateDigest: string | null;
	readonly nextWakeAt: string | null;
	readonly progressRecoveryCount: number;
	readonly readyTaskSetDigest: string | null;
	readonly nextGate: string | null;
	readonly progressStallReason: "progress_lease_deadline_unchanged" | null;
}

export type WorkflowTaskRuntimeEvidenceKind = "real_integration" | "process_restart" | "durable_store";

/** Host classification required before a stage can authorize durable progress. */
export interface WorkflowTaskRuntimeEvidenceClassification {
	readonly boundary: "public_boundary";
	readonly verification: "host_verified";
	readonly evidenceKind: WorkflowTaskRuntimeEvidenceKind;
	readonly authorizesTerminalization: true;
}

export interface WorkflowTaskRuntimeTelemetry {
	readonly dispatchLatencyMs: number;
	readonly childWaitMs: number;
	readonly idleTimeMs: number;
	readonly duplicateScans: number;
	readonly testRuntimeMs: number;
	readonly blockedCapacityReason: string | null;
}

export interface WorkflowTaskRuntimeWorkerResult {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly workerId: string;
	readonly status: "completed" | "error" | "cancelled" | "lost" | "ambiguous";
	readonly error: string | null;
	readonly retryable: boolean;
	readonly recoveryDecision: "awaiting_evidence" | "replan_required";
	readonly completedAt: string;
	readonly resultEvidenceRef: WorkflowArtifactRef;
	readonly quarantineReason?: "worker_lease_expired" | "launch_identity_unresolved" | "completion_channel_unavailable";
	readonly leaseExpiresAt?: string;
	readonly capacityReleasedAt?: string;
}

export interface WorkflowTaskRuntimeAudit {
	readonly scheduler: WorkflowSchedulerState;
	readonly terminalTaskIds: readonly string[];
	readonly launchEvidenceRefs: readonly WorkflowArtifactRef[];
	readonly workerResults: readonly WorkflowTaskRuntimeWorkerResult[];
}

/** Host-owned stage/evidence operations that remain outside generic scheduling state. */
export interface WorkflowPrimeStageEvidenceAdapter {
	recordEvidence(input: {
		readonly stageId: string;
		readonly evidenceRefs: readonly WorkflowArtifactRef[];
	}): Promise<WorkflowTaskRuntimeEvidenceClassification>;
	readCoordinatorStatus(input: {
		readonly workflowId: string;
		readonly epochRef: WorkflowEpochRef;
	}): Promise<CoordinatorStatusInput>;
	recordTelemetry(input: {
		readonly workflowId: string;
		readonly epochRef: WorkflowEpochRef;
		readonly telemetry: WorkflowTaskRuntimeTelemetry;
	}): Promise<unknown>;
	assertStageAcceptable(input: {
		readonly stageId: string;
		readonly classification: WorkflowTaskRuntimeEvidenceClassification;
	}): Promise<void>;
	acceptStage(input: {
		readonly stageId: string;
		readonly classification: WorkflowTaskRuntimeEvidenceClassification;
	}): Promise<void>;
	readAudit(): Promise<{
		readonly terminalTaskIds: readonly string[];
		readonly launchEvidenceRefs: readonly WorkflowArtifactRef[];
		readonly workerResults: readonly WorkflowTaskRuntimeWorkerResult[];
	}>;
}

export interface WorkflowPrimeStageDispatchInput {
	readonly stageId: string;
	readonly dispatchInput: WorkflowCanonicalDispatchInput;
	readonly queuedAt: string;
}

export interface WorkflowTaskRuntimeAuthorityInput {
	readonly runtimeVersion: string;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly goalRevisionDigest: string;
	readonly graph: WorkflowTaskGraph;
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly scheduler: WorkflowScheduler;
	readonly dispatcher: WorkflowDispatcher;
	readonly leases: WorkflowLeaseManager;
	readonly effects: WorkflowEffectBroker;
	readonly recovery: WorkflowRuntimeRecoveryCoordinator;
	readonly prime: WorkflowPrimeStageEvidenceAdapter;
	readonly readSchedulerState: () => Promise<WorkflowSchedulerState>;
}

export interface WorkflowTaskRuntimePrimeSurface {
	enqueue(input: WorkflowPrimeStageDispatchInput): Promise<void>;
	recordEvidence(input: {
		readonly stageId: string;
		readonly evidenceRefs: readonly WorkflowArtifactRef[];
	}): Promise<WorkflowTaskRuntimeEvidenceClassification>;
}

export interface WorkflowTaskRuntimeAuthority {
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly graph: WorkflowTaskGraph;
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly scheduler: WorkflowScheduler;
	readonly dispatcher: WorkflowDispatcher;
	readonly leases: WorkflowLeaseManager;
	readonly effects: WorkflowEffectBroker;
	readonly recovery: WorkflowRuntimeRecoveryCoordinator;
	readonly prime: WorkflowTaskRuntimePrimeSurface;
	readonly failureOutbox: WorkflowOutboxAppender;
	start(): Promise<readonly WorkflowDispatchResult[]>;
	dispatch(input: WorkflowPrimeStageDispatchInput): Promise<readonly WorkflowDispatchResult[]>;
	onEvent(event: WorkflowSchedulerEvent): Promise<readonly WorkflowDispatchResult[]>;
	onTerminal(event: WorkflowSchedulerEvent): Promise<readonly WorkflowDispatchResult[]>;
	readStatus(): Promise<WorkflowTaskRuntimeStatus>;
	recordTelemetry(telemetry: WorkflowTaskRuntimeTelemetry): Promise<unknown>;
	assertStageAcceptable(input: {
		readonly stageId: string;
		readonly classification: WorkflowTaskRuntimeEvidenceClassification;
	}): Promise<void>;
	acceptStage(input: {
		readonly stageId: string;
		readonly classification: WorkflowTaskRuntimeEvidenceClassification;
	}): Promise<void>;
	readState(): Promise<WorkflowSchedulerState>;
	readAudit(): Promise<WorkflowTaskRuntimeAudit>;
	recover(request: WorkflowRecoveryRequest): Promise<WorkflowReconciliationOutcome>;
	reassign(input: {
		readonly request: WorkflowRecoveryRequest;
		readonly replacement: WorkflowPrimeStageDispatchInput;
	}): Promise<readonly WorkflowDispatchResult[]>;
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function assertCompositionBinding(
	input: WorkflowTaskRuntimeAuthorityInput,
	durable: WorkflowRuntimeStoreDurableContext,
): void {
	if (input.workflowId.length === 0) throw new Error("workflow_task_runtime_workflow_id_invalid");
	if (input.runtimeStore.identity.workflowId !== input.workflowId)
		throw new Error("workflow_task_runtime_store_binding_invalid");
	if (!sameEpoch(input.epochRef, durable.epochRef)) throw new Error("workflow_task_runtime_epoch_binding_invalid");
	if (!/^[0-9a-f]{64}$/u.test(input.goalRevisionDigest))
		throw new Error("workflow_task_runtime_goal_revision_invalid");
	if (input.graph.byId === undefined) throw new Error("workflow_task_runtime_graph_invalid");
}

function assertTerminalEventBinding(input: WorkflowTaskRuntimeAuthorityInput, event: WorkflowSchedulerEvent): void {
	if (
		event.workflowId !== input.workflowId ||
		!sameEpoch(event.epochRef, input.epochRef) ||
		(event.kind !== "lease_released" && event.kind !== "attempt_completed" && event.kind !== "recovery_reconciled")
	)
		throw new Error("workflow_task_runtime_terminal_event_invalid");
}

function assertSchedulerEventBinding(input: WorkflowTaskRuntimeAuthorityInput, event: WorkflowSchedulerEvent): void {
	if (event.workflowId !== input.workflowId || !sameEpoch(event.epochRef, input.epochRef))
		throw new Error("workflow_task_runtime_event_invalid");
}

function assertTelemetry(telemetry: WorkflowTaskRuntimeTelemetry): void {
	if (
		!Number.isFinite(telemetry.dispatchLatencyMs) ||
		telemetry.dispatchLatencyMs < 0 ||
		!Number.isFinite(telemetry.childWaitMs) ||
		telemetry.childWaitMs < 0 ||
		!Number.isFinite(telemetry.idleTimeMs) ||
		telemetry.idleTimeMs < 0 ||
		!Number.isSafeInteger(telemetry.duplicateScans) ||
		telemetry.duplicateScans < 0 ||
		!Number.isFinite(telemetry.testRuntimeMs) ||
		telemetry.testRuntimeMs < 0 ||
		(telemetry.blockedCapacityReason !== null && telemetry.blockedCapacityReason.length === 0)
	)
		throw new Error("workflow_task_runtime_telemetry_invalid");
}

function assertStageEvidenceClassification(classification: WorkflowTaskRuntimeEvidenceClassification): void {
	if (
		classification === null ||
		typeof classification !== "object" ||
		classification.boundary !== "public_boundary" ||
		classification.verification !== "host_verified" ||
		(classification.evidenceKind !== "real_integration" &&
			classification.evidenceKind !== "process_restart" &&
			classification.evidenceKind !== "durable_store") ||
		classification.authorizesTerminalization !== true
	)
		throw new Error("workflow_task_runtime_stage_evidence_not_authorizing");
}

function publicCoordinatorStatus(
	projection: CoordinatorStatusProjection,
	goalRevisionDigest: string,
): WorkflowTaskRuntimeStatus {
	if (projection.status === "needs_input") {
		return Object.freeze({
			status: "blocked",
			goalRevisionDigest,
			activeWorkers: projection.activeWorkers,
			eligibleReadyTasks: projection.eligibleReadyTasks,
			idleCapacity: projection.idleCapacity,
			idleReason: "user_decision",
			progressCutHeadDigest: null,
			lastAuthoritativeProgressAt: null,
			progressLeaseOwner: null,
			progressLeaseDeadline: null,
			progressPredicateDigest: null,
			nextWakeAt: null,
			progressRecoveryCount: 0,
			readyTaskSetDigest: null,
			nextGate: null,
			progressStallReason: null,
		});
	}
	return Object.freeze({
		status: projection.status,
		goalRevisionDigest,
		activeWorkers: projection.activeWorkers,
		eligibleReadyTasks: projection.eligibleReadyTasks,
		idleCapacity: projection.idleCapacity,
		idleReason: projection.idleReason,
		progressCutHeadDigest: null,
		lastAuthoritativeProgressAt: null,
		progressLeaseOwner: null,
		progressLeaseDeadline: null,
		progressPredicateDigest: null,
		nextWakeAt: null,
		progressRecoveryCount: 0,
		readyTaskSetDigest: null,
		nextGate: null,
		progressStallReason: null,
	});
}

function assertStageDispatchBinding(
	input: WorkflowTaskRuntimeAuthorityInput,
	request: WorkflowPrimeStageDispatchInput,
): void {
	if (
		request.stageId.length === 0 ||
		request.dispatchInput.workflowId !== input.workflowId ||
		request.dispatchInput.taskId !== request.stageId ||
		request.dispatchInput.attemptId.length === 0 ||
		request.dispatchInput.executionKey.length === 0 ||
		!sameEpoch(request.dispatchInput.epochRef, input.epochRef) ||
		!Number.isFinite(Date.parse(request.queuedAt))
	)
		throw new Error("workflow_task_runtime_dispatch_binding_invalid");
}

async function recoveryEventFor(
	input: WorkflowTaskRuntimeAuthorityInput,
	request: WorkflowRecoveryRequest,
	outcome: WorkflowReconciliationOutcome,
): Promise<WorkflowSchedulerEvent> {
	const replay = await input.runtimeStore.replay({
		workflowId: input.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: input.epochRef.storeEpoch,
	});
	if (replay.quarantined || replay.head.eventDigest === null)
		throw new Error("workflow_task_runtime_reconciliation_not_durable");
	const recorded = [...replay.events]
		.reverse()
		.find(
			(event) =>
				event.payload.kind === "workflow_reconciliation_recorded" &&
				event.payload.workflowId === input.workflowId &&
				event.payload.attemptId === request.attemptId &&
				outcome.workflowId === input.workflowId &&
				outcome.taskId === request.taskId &&
				event.payload.outcome.workflowId === outcome.workflowId &&
				event.payload.outcome.taskId === request.taskId &&
				event.payload.outcome.attemptId === request.attemptId &&
				sameEpoch(event.payload.outcome.epochRef, request.epochRef) &&
				event.payload.outcomeDigest === digestObject(outcome) &&
				event.payload.outcome.stateDigest === outcome.stateDigest,
		);
	if (recorded === undefined || recorded.payload.kind !== "workflow_reconciliation_recorded")
		throw new Error("workflow_task_runtime_reconciliation_not_durable");
	const rootLease = input.runtimeStore.durableContext?.currentLeaseRef();
	if (rootLease === undefined || recorded.writerIdentity !== rootLease.writerIdentity)
		throw new Error("workflow_task_runtime_reconciliation_writer_invalid");
	return {
		kind: "recovery_reconciled",
		workflowId: input.workflowId,
		epochRef: input.epochRef,
		eventSequence: replay.head.sequence,
		attemptId: request.attemptId,
		headDigest: digestObject(replay.head),
		eventDigest: replay.head.eventDigest,
		writerIdentity: recorded.writerIdentity,
		journalHeadDigest: digestObject(replay.head),
	};
}

/**
 * Compose the generic workflow authorities into the single task-runtime boundary.
 *
 * Args:
 * input: Authenticated workflow authorities and the host-owned Prime stage/evidence adapter.
 * Return: A task-runtime boundary that delegates scheduling, dispatch, leases, effects, recovery, and outbox work.
 */
export function createWorkflowTaskRuntimeAuthority(
	input: WorkflowTaskRuntimeAuthorityInput,
): WorkflowTaskRuntimeAuthority {
	assertWorkflowRuntimeVersion(input.runtimeVersion);
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("workflow_task_runtime_durable_store_required");
	assertCompositionBinding(input, durable);

	const prime: WorkflowTaskRuntimePrimeSurface = {
		enqueue: async (request): Promise<void> => {
			assertStageDispatchBinding(input, request);
			const { dispatchInput, queuedAt } = request;
			await input.scheduler.enqueue(dispatchInput, queuedAt);
		},
		recordEvidence: async (request) => {
			if (request.stageId.length === 0) throw new Error("workflow_task_runtime_stage_id_invalid");
			if (request.evidenceRefs.length === 0) throw new Error("workflow_task_runtime_evidence_required");
			const classification = await input.prime.recordEvidence({
				stageId: request.stageId,
				evidenceRefs: structuredClone(request.evidenceRefs),
			});
			assertStageEvidenceClassification(classification);
			return structuredClone(classification);
		},
	};

	const failureOutbox: WorkflowOutboxAppender = durable.outbox;

	const start = async (): Promise<readonly WorkflowDispatchResult[]> => {
		const recovery = await input.recovery.startRecovery();
		if (recovery.status === "blocked") throw new Error("workflow_task_runtime_recovery_blocked");
		return input.scheduler.refill(input.workflowId, input.epochRef);
	};

	const dispatch = async (request: WorkflowPrimeStageDispatchInput): Promise<readonly WorkflowDispatchResult[]> => {
		await prime.enqueue(request);
		return input.scheduler.refill(input.workflowId, input.epochRef);
	};

	const onEvent = async (event: WorkflowSchedulerEvent): Promise<readonly WorkflowDispatchResult[]> => {
		assertSchedulerEventBinding(input, event);
		return input.scheduler.onEvent(event);
	};

	const onTerminal = async (event: WorkflowSchedulerEvent): Promise<readonly WorkflowDispatchResult[]> => {
		assertTerminalEventBinding(input, event);
		return onEvent(event);
	};

	const readStatus = async (): Promise<WorkflowTaskRuntimeStatus> => {
		const projection = await projectCoordinatorStatus(
			await input.prime.readCoordinatorStatus({ workflowId: input.workflowId, epochRef: input.epochRef }),
		);
		return publicCoordinatorStatus(projection, input.goalRevisionDigest);
	};

	const recordTelemetry = async (telemetry: WorkflowTaskRuntimeTelemetry): Promise<unknown> => {
		assertTelemetry(telemetry);
		return input.prime.recordTelemetry({
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			telemetry: structuredClone(telemetry),
		});
	};

	const assertStageAcceptable = async (request: {
		readonly stageId: string;
		readonly classification: WorkflowTaskRuntimeEvidenceClassification;
	}): Promise<void> => {
		if (request.stageId.length === 0) throw new Error("workflow_task_runtime_stage_id_invalid");
		assertStageEvidenceClassification(request.classification);
		await input.prime.assertStageAcceptable({
			stageId: request.stageId,
			classification: structuredClone(request.classification),
		});
	};

	const acceptStage = async (request: {
		readonly stageId: string;
		readonly classification: WorkflowTaskRuntimeEvidenceClassification;
	}): Promise<void> => {
		if (request.stageId.length === 0) throw new Error("workflow_task_runtime_stage_id_invalid");
		assertStageEvidenceClassification(request.classification);
		await input.prime.acceptStage({
			stageId: request.stageId,
			classification: structuredClone(request.classification),
		});
	};

	const readState = async (): Promise<WorkflowSchedulerState> => input.readSchedulerState();

	const readAudit = async (): Promise<WorkflowTaskRuntimeAudit> => {
		const [scheduler, audit] = await Promise.all([input.readSchedulerState(), input.prime.readAudit()]);
		return {
			scheduler: structuredClone(scheduler),
			terminalTaskIds: structuredClone(audit.terminalTaskIds),
			launchEvidenceRefs: structuredClone(audit.launchEvidenceRefs),
			workerResults: structuredClone(audit.workerResults),
		};
	};

	const recover = async (request: WorkflowRecoveryRequest): Promise<WorkflowReconciliationOutcome> => {
		if (
			request.workflowId !== input.workflowId ||
			!sameEpoch(request.epochRef, input.epochRef) ||
			request.attemptId.length === 0 ||
			request.executionKey.length === 0
		)
			throw new Error("workflow_task_runtime_recovery_request_invalid");
		const started = await input.recovery.startRecovery(request);
		if (started.status === "blocked") throw new Error("workflow_task_runtime_recovery_blocked");
		const outcome = await input.recovery.reconcile(request);
		if (outcome.disposition !== "proven_not_executed") return outcome;
		await input.scheduler.onEvent(await recoveryEventFor(input, request, outcome));
		return outcome;
	};

	const reassign = async (request: {
		readonly request: WorkflowRecoveryRequest;
		readonly replacement: WorkflowPrimeStageDispatchInput;
	}): Promise<readonly WorkflowDispatchResult[]> => {
		const outcome = await recover(request.request);
		if (outcome.disposition !== "proven_not_executed")
			throw new Error("workflow_task_runtime_reassignment_not_proven");
		if (request.replacement.stageId !== request.request.taskId)
			throw new Error("workflow_task_runtime_replacement_task_mismatch");
		if (
			request.replacement.dispatchInput.attemptId === request.request.attemptId ||
			request.replacement.dispatchInput.executionKey === request.request.executionKey
		)
			throw new Error("workflow_task_runtime_replacement_identity_reused");
		await prime.enqueue(request.replacement);
		return input.scheduler.refill(input.workflowId, input.epochRef);
	};

	return Object.freeze({
		workflowId: input.workflowId,
		epochRef: Object.freeze({ ...input.epochRef }),
		graph: input.graph,
		runtimeStore: input.runtimeStore,
		scheduler: input.scheduler,
		dispatcher: input.dispatcher,
		leases: input.leases,
		effects: input.effects,
		recovery: input.recovery,
		prime: Object.freeze(prime),
		failureOutbox,
		start,
		dispatch,
		onEvent,
		onTerminal,
		readStatus,
		recordTelemetry,
		assertStageAcceptable,
		acceptStage,
		readState,
		readAudit,
		recover,
		reassign,
	});
}
