import type { GoalState } from "../goals.js";
import type { WorkflowAdmissionRegistry, WorkflowAdmissionResult } from "./admission.js";
import type {
	WorkflowAttemptReconciliationSummary,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowPhaseOutcomeRecord,
	WorkflowRuntimeEventPayload,
	WorkflowRuntimeStore,
	WorkflowSemanticMutationBinding,
	WorkflowStoreCommitResult,
} from "./contracts.js";
import { digestObject } from "./contracts.js";
import type { WorkflowEffectBroker } from "./effect-broker.js";
import type { WorkflowEpochManager } from "./epochs.js";
import type { WorkflowLeaseManager } from "./leases.js";
import type { WorkflowProcessGroupController, WorkflowUnknownDescendant } from "./process-groups.js";
import type { WorkflowRecoveryPort } from "./recovery.js";

interface WorkflowCancellationGoalBinding {
	readonly workflowId: string;
	readonly eventSequence: number;
	readonly transitionDigest: string;
	readonly storeEpoch: number;
	readonly coordinatorEpoch: number;
}

interface WorkflowCancellationGoalState {
	readonly goal: GoalState;
	readonly binding: WorkflowCancellationGoalBinding | null;
}

interface WorkflowCancellationGoalPort {
	readonly coordinator: {
		transition(request: {
			readonly workflowId: string;
			readonly target: "paused";
			readonly reason: string;
		}): Promise<GoalState>;
	};
	read(): WorkflowCancellationGoalState;
	compareAndSwapUnbind(input: {
		readonly workflowId: string;
		readonly expectedGoalDigest: string;
		readonly expectedBinding: WorkflowCancellationGoalBinding;
	}): Promise<"unbound" | "conflict">;
}

export interface WorkflowCancellationDependencies {
	readonly workflowId: string;
	readonly store: WorkflowRuntimeStore;
	readonly epochs: Pick<WorkflowEpochManager, "assertCurrent">;
	readonly admission: Pick<
		WorkflowAdmissionRegistry,
		"listByWorkflow" | "listDescendants" | "recordOutcome" | "quarantine"
	>;
	readonly leases: Pick<WorkflowLeaseManager, "lookupByLease" | "release" | "quarantine">;
	readonly groups: Pick<
		WorkflowProcessGroupController,
		"verify" | "terminate" | "reap" | "quarantine" | "scanUnknownDescendants"
	>;
	readonly broker: Pick<WorkflowEffectBroker, "reconcile">;
	readonly recovery: WorkflowRecoveryPort;
	readonly goal: WorkflowCancellationGoalPort;
	readonly writerIdentity: string;
	readonly resolveRootLeaseRef: () => Promise<WorkflowLeaseRef>;
	readonly fenceCallbacks: () => Promise<void>;
	readonly readRevisionBoundaryContext: (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		executionKey: string | null,
	) => Promise<unknown>;
	readonly revisionRegistry: { assertActive(context: unknown): Promise<void> };
	readonly quarantineUnknownDescendant?: (descendant: WorkflowUnknownDescendant, reason: string) => Promise<void>;
}

export interface WorkflowCancellationBarrierResult {
	readonly barrierEventSequence: number;
	readonly descendantSetDigest: string;
	readonly reconciliationDigest: string;
	readonly leaseBarrierDigest: string;
}

export interface WorkflowCancellationResult {
	readonly status: "cancelled" | "already_cancelled" | "paused";
	readonly attempts: readonly WorkflowAttemptReconciliationSummary[];
	readonly barrier: WorkflowCancellationBarrierResult | null;
	readonly goal: WorkflowCancellationGoalState;
}

export interface WorkflowCancellationCoordinator {
	cancel(
		workflowId: string,
		rootAttemptId: string | null,
		epochRef: WorkflowEpochRef,
		reason: string,
	): Promise<WorkflowCancellationResult>;
}

export class WorkflowCancellationError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "WorkflowCancellationError";
		this.code = code;
	}
}

const TERMINAL_ATTEMPT_STATUSES = new Set(["completed", "needs_fix", "blocked", "failed", "cancelled", "quarantined"]);

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function assertCancellationInput(
	configuredWorkflowId: string,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	reason: string,
): void {
	if (
		workflowId !== configuredWorkflowId ||
		workflowId.length === 0 ||
		reason.length === 0 ||
		!Number.isSafeInteger(epochRef.storeEpoch) ||
		!Number.isSafeInteger(epochRef.coordinatorEpoch) ||
		epochRef.storeEpoch < 1 ||
		epochRef.coordinatorEpoch < 1
	)
		throw new WorkflowCancellationError("workflow_cancellation_input_invalid");
}

function eventHead(replayHead: WorkflowJournalHead, epochRef: WorkflowEpochRef): WorkflowJournalHead {
	if (!sameEpoch(replayHead.epochRef, epochRef)) throw new WorkflowCancellationError("workflow_epoch_stale");
	return replayHead;
}

function semanticBinding(
	workflowId: string,
	payload: WorkflowRuntimeEventPayload,
	expectedHead: WorkflowJournalHead,
	epochRef: WorkflowEpochRef,
	leaseRef: WorkflowLeaseRef,
	idempotencyKey: string,
	writerIdentity: string,
): WorkflowSemanticMutationBinding {
	const baselineDigest = digestObject(expectedHead);
	return {
		mutationId: idempotencyKey,
		baselineDigest,
		expectedGenerations: { workflow: epochRef.storeEpoch },
		ownerId: writerIdentity,
		phase: "recovering",
		reducerDigest: digestObject(payload),
		semanticHead: {
			workflowId,
			sequence: expectedHead.sequence,
			eventDigest: expectedHead.eventDigest,
			stateDigest: baselineDigest,
			epochRef,
			generation: epochRef.storeEpoch,
		},
		expectedHead,
		idempotencyKey,
		executionKey: null,
		writerIdentity,
		leaseRef,
		epochRef,
	};
}

async function commitEvent<TPayload extends WorkflowRuntimeEventPayload>(
	dependencies: WorkflowCancellationDependencies,
	epochRef: WorkflowEpochRef,
	leaseRef: WorkflowLeaseRef,
	payload: TPayload,
	idempotencyKey: string,
): Promise<WorkflowStoreCommitResult<TPayload>> {
	const replay = await dependencies.store.replay({
		workflowId: dependencies.workflowId,
		fromSequence: 1,
		expectedStoreEpoch: epochRef.storeEpoch,
	});
	if (replay.quarantined) throw new WorkflowCancellationError("workflow_store_quarantined");
	const expectedHead = eventHead(replay.head, epochRef);
	return dependencies.store.commit({
		workflowId: dependencies.workflowId,
		payload,
		expectedHead,
		semanticBinding: semanticBinding(
			dependencies.workflowId,
			payload,
			expectedHead,
			epochRef,
			leaseRef,
			idempotencyKey,
			dependencies.writerIdentity,
		),
		epochRef,
		leaseRef,
		idempotencyKey,
		writerIdentity: dependencies.writerIdentity,
		executionKey: null,
	});
}

function cancellationOutcome(attempt: WorkflowAdmissionResult): WorkflowPhaseOutcomeRecord {
	return {
		attemptStatus: "cancelled",
		outcome: {
			workflowId: attempt.context.workflowId,
			phaseAttemptId: attempt.context.attemptId,
			epochRef: attempt.context.epochRef,
			invocationToken: attempt.context.executionKey,
			inputStateDigest: attempt.context.expectedEffectDigest,
			status: "failed",
			errorCode: "workflow_cancelled",
			retryable: false,
			artifactRefs: [],
			evidenceRefs: [],
		},
	};
}

function summary(
	attempt: WorkflowAdmissionResult,
	input: Omit<WorkflowAttemptReconciliationSummary, "attemptId">,
): WorkflowAttemptReconciliationSummary {
	return { attemptId: attempt.context.attemptId, ...input };
}

async function releaseTerminalLease(
	dependencies: WorkflowCancellationDependencies,
	attempt: WorkflowAdmissionResult,
	epochRef: WorkflowEpochRef,
): Promise<WorkflowAttemptReconciliationSummary> {
	const state = await dependencies.leases.lookupByLease(dependencies.workflowId, attempt.context.resourceLeaseRef);
	if (state === undefined || state.leaseStatus === "quarantined") {
		return summary(attempt, {
			status: "quarantined",
			detail: "lease_quarantined",
			outcomeDigest: attempt.outcomeDigest,
			processReapDigest: null,
			effectDisposition: "quarantined",
			leaseResults: [],
		});
	}
	if (state.leaseStatus === "released") {
		return summary(attempt, {
			status: "already_cancelled",
			detail: "lease_released",
			outcomeDigest: attempt.outcomeDigest,
			processReapDigest: null,
			effectDisposition: "none",
			leaseResults: [{ leaseRef: attempt.context.resourceLeaseRef, status: "already_released", reason: null }],
		});
	}
	if (attempt.outcomeDigest === null) throw new WorkflowCancellationError("workflow_terminal_outcome_unavailable");
	await dependencies.leases.release({
		workflowId: dependencies.workflowId,
		attemptId: attempt.context.attemptId,
		leaseRef: attempt.context.resourceLeaseRef,
		epochRef,
		outcomeDigest: attempt.outcomeDigest,
		store: dependencies.store,
	});
	return summary(attempt, {
		status: "already_cancelled",
		detail: "lease_released",
		outcomeDigest: attempt.outcomeDigest,
		processReapDigest: null,
		effectDisposition: "none",
		leaseResults: [{ leaseRef: attempt.context.resourceLeaseRef, status: "released", reason: null }],
	});
}

async function reconcileRunningAttempt(
	dependencies: WorkflowCancellationDependencies,
	attempt: WorkflowAdmissionResult,
	epochRef: WorkflowEpochRef,
	replayedEvents: readonly { readonly payload: WorkflowEventPayload }[],
): Promise<{ readonly resolved: boolean; readonly result: WorkflowAttemptReconciliationSummary }> {
	let processReapDigest: string | null = null;
	if (attempt.processBinding !== null) {
		const verified = await dependencies.groups.verify(attempt.processBinding.processGroup);
		if (!verified) {
			await dependencies.admission.quarantine(attempt.admissionId, "workflow_process_identity_lost");
			return {
				resolved: false,
				result: summary(attempt, {
					status: "quarantined",
					detail: "identity_lost",
					outcomeDigest: null,
					processReapDigest: null,
					effectDisposition: "quarantined",
					leaseResults: [],
				}),
			};
		}
		await dependencies.groups.terminate(attempt.processBinding.processGroup, "workflow_cancelled");
		const reaped = await dependencies.groups.reap(attempt.processBinding.processGroup);
		processReapDigest = reaped.reapDigest;
		if (reaped.remainingPids.length > 0) {
			return {
				resolved: false,
				result: summary(attempt, {
					status: "quarantined",
					detail: "child_running",
					outcomeDigest: null,
					processReapDigest,
					effectDisposition: "none",
					leaseResults: [],
				}),
			};
		}
	}

	const effectIntent = replayedEvents.find(
		(event) =>
			event.payload.kind === "workflow_effect_intent" &&
			event.payload.attemptId === attempt.context.attemptId &&
			event.payload.executionKey === attempt.context.executionKey,
	)?.payload;
	let effectDisposition: WorkflowAttemptReconciliationSummary["effectDisposition"] = "none";
	if (effectIntent?.kind === "workflow_effect_intent") {
		const effect = await dependencies.broker.reconcile(effectIntent.effect, effectIntent.idempotencyKey, epochRef);
		effectDisposition =
			effect.status === "completed" || effect.status === "already_completed"
				? "completed"
				: effect.status === "ambiguous"
					? "ambiguous"
					: "quarantined";
		if (effectDisposition !== "completed") {
			return {
				resolved: false,
				result: summary(attempt, {
					status: "quarantined",
					detail: effectDisposition === "ambiguous" ? "effect_ambiguous" : "lease_quarantined",
					outcomeDigest: null,
					processReapDigest,
					effectDisposition,
					leaseResults: [],
				}),
			};
		}
	}

	const recovery = await dependencies.recovery.reconcile({
		workflowId: dependencies.workflowId,
		taskId: attempt.context.taskId,
		attemptId: attempt.context.attemptId,
		executionKey: attempt.context.executionKey,
		epochRef,
		persistedChildIdentity: attempt.childIdentity,
		evidenceRefs: [],
	});
	if (recovery.disposition !== "completed" && recovery.disposition !== "proven_not_executed") {
		return {
			resolved: false,
			result: summary(attempt, {
				status: recovery.disposition === "still_running" ? "reattached" : "quarantined",
				detail: recovery.disposition === "still_running" ? "child_running" : "identity_lost",
				outcomeDigest: null,
				processReapDigest,
				effectDisposition,
				leaseResults: [],
			}),
		};
	}

	const outcome = cancellationOutcome(attempt);
	const recorded = await dependencies.admission.recordOutcome(
		attempt.admissionId,
		outcome,
		attempt.lifecycle.statusDigest,
	);
	const released = await releaseTerminalLease(dependencies, recorded, epochRef);
	return {
		resolved: true,
		result: { ...released, status: "cancelled", detail: "lease_released", processReapDigest, effectDisposition },
	};
}

function unknownSummary(descendant: WorkflowUnknownDescendant): WorkflowAttemptReconciliationSummary {
	return {
		attemptId: descendant.descendantId,
		status: "quarantined",
		detail: "identity_lost",
		outcomeDigest: null,
		processReapDigest: null,
		effectDisposition: "quarantined",
		leaseResults: [],
	};
}

async function pauseGoal(
	dependencies: WorkflowCancellationDependencies,
	reason: string,
): Promise<WorkflowCancellationGoalState> {
	await dependencies.goal.coordinator.transition({
		workflowId: dependencies.workflowId,
		target: "paused",
		reason,
	});
	return dependencies.goal.read();
}

export function createWorkflowCancellationCoordinator(
	dependencies: WorkflowCancellationDependencies,
): WorkflowCancellationCoordinator {
	return {
		async cancel(workflowId, rootAttemptId, epochRef, reason): Promise<WorkflowCancellationResult> {
			assertCancellationInput(dependencies.workflowId, workflowId, epochRef, reason);
			try {
				await dependencies.epochs.assertCurrent(workflowId, epochRef);
			} catch (error) {
				const code = error instanceof Error && error.message.length > 0 ? error.message : "workflow_epoch_stale";
				throw new WorkflowCancellationError(code);
			}
			const boundary = await dependencies.readRevisionBoundaryContext(workflowId, epochRef, null);
			await dependencies.revisionRegistry.assertActive(boundary);
			const initialReplay = await dependencies.store.replay({
				workflowId,
				fromSequence: 1,
				expectedStoreEpoch: epochRef.storeEpoch,
			});
			if (initialReplay.quarantined) throw new WorkflowCancellationError("workflow_store_quarantined");
			if (initialReplay.events.some((event) => event.payload.kind === "workflow_cancelled")) {
				return {
					status: "already_cancelled",
					attempts: [],
					barrier: null,
					goal: dependencies.goal.read(),
				};
			}

			const leaseRef = await dependencies.resolveRootLeaseRef();
			if (!sameEpoch(leaseRef, epochRef)) throw new WorkflowCancellationError("workflow_epoch_stale");
			const descendants = await dependencies.admission.listDescendants(workflowId, rootAttemptId);
			const rootAttempt =
				rootAttemptId === null
					? null
					: ((await dependencies.admission.listByWorkflow(workflowId)).find(
							(attempt) => attempt.context.attemptId === rootAttemptId,
						) ?? null);
			const attempts =
				rootAttempt === null || descendants.some((attempt) => attempt.context.attemptId === rootAttemptId)
					? descendants
					: [rootAttempt, ...descendants];
			const descendantSetDigest = digestObject(
				attempts
					.map((attempt) => ({
						attemptId: attempt.context.attemptId,
						executionKey: attempt.context.executionKey,
						statusDigest: attempt.lifecycle.statusDigest,
					}))
					.sort((left, right) =>
						left.attemptId < right.attemptId ? -1 : left.attemptId > right.attemptId ? 1 : 0,
					),
			);
			await commitEvent(
				dependencies,
				epochRef,
				leaseRef,
				{ kind: "workflow_cancellation_intent", workflowId, epochRef, reason, descendantSetDigest },
				`cancellation:intent:${descendantSetDigest}`,
			);
			await dependencies.fenceCallbacks();

			const replay = await dependencies.store.replay({
				workflowId,
				fromSequence: 1,
				expectedStoreEpoch: epochRef.storeEpoch,
			});
			const outcomes: WorkflowAttemptReconciliationSummary[] = [];
			let allResolved = true;
			for (const attempt of attempts) {
				if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
					outcomes.push(await releaseTerminalLease(dependencies, attempt, epochRef));
					continue;
				}
				const reconciled = await reconcileRunningAttempt(dependencies, attempt, epochRef, replay.events);
				outcomes.push(reconciled.result);
				allResolved &&= reconciled.resolved;
			}

			const unknown = await dependencies.groups.scanUnknownDescendants(workflowId);
			for (const descendant of unknown) {
				await dependencies.quarantineUnknownDescendant?.(descendant, "workflow_unknown_descendant");
				outcomes.push(unknownSummary(descendant));
				allResolved = false;
			}
			const reconciliationDigest = digestObject(outcomes);
			const leaseBarrierDigest = digestObject(
				outcomes.flatMap((outcome) => outcome.leaseResults).map((result) => result.leaseRef),
			);
			const reconciledCommit = await commitEvent(
				dependencies,
				epochRef,
				leaseRef,
				{
					kind: "workflow_cancellation_descendants_reconciled",
					workflowId,
					epochRef,
					descendantSetDigest,
					reconciliationDigest,
					leaseBarrierDigest,
					attemptOutcomes: outcomes,
				},
				`cancellation:reconciled:${descendantSetDigest}:${reconciliationDigest}`,
			);
			const pausedGoal = await pauseGoal(dependencies, reason);
			if (!allResolved) {
				return { status: "paused", attempts: outcomes, barrier: null, goal: pausedGoal };
			}

			const barrierEventSequence = reconciledCommit.head.sequence;
			await commitEvent(
				dependencies,
				epochRef,
				leaseRef,
				{
					kind: "workflow_cancelled",
					workflowId,
					epochRef,
					barrierEventSequence,
					descendantSetDigest,
					reconciliationDigest,
					leaseBarrierDigest,
				},
				`cancellation:barrier:${descendantSetDigest}:${reconciliationDigest}`,
			);
			if (pausedGoal.binding === null) throw new WorkflowCancellationError("workflow_goal_binding_unavailable");
			const unbound = await dependencies.goal.compareAndSwapUnbind({
				workflowId,
				expectedGoalDigest: digestObject(pausedGoal.goal),
				expectedBinding: pausedGoal.binding,
			});
			if (unbound !== "unbound") throw new WorkflowCancellationError("workflow_goal_unbind_conflict");
			return {
				status: "cancelled",
				attempts: outcomes,
				barrier: { barrierEventSequence, descendantSetDigest, reconciliationDigest, leaseBarrierDigest },
				goal: dependencies.goal.read(),
			};
		},
	};
}
