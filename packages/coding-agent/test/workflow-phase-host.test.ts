import { describe, expect, it, vi } from "vitest";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import type { WorkflowApprovalHostOutcome, WorkflowApprovalManager } from "../src/core/workflow/approvals.js";
import type {
	DurableApprovalSecretProof,
	WorkflowApprovalConsumptionResult,
	WorkflowApprovalReceipt,
	WorkflowApprovalRequest,
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalEvent,
	WorkflowLeaseRef,
	WorkflowPhaseOutcomeRecord,
	WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject } from "../src/core/workflow/contracts.js";
import { decodeWorkflowEventPayload, type WorkflowGoalProjectionAuthorization } from "../src/core/workflow/journal.js";
import type {
	WorkflowAcceptanceState,
	WorkflowPhaseHostContext,
	WorkflowStorePort,
} from "../src/core/workflow/phase-host.js";
import { createProviderFreeWorkflowPhaseHost } from "../src/core/workflow/phase-host.js";
import { createWorkflowGoalCoordinator, type WorkflowGoalTransitionPayload } from "../src/core/workflow/projections.js";
import type {
	WorkflowState as ReducedWorkflowState,
	WorkflowCommitPrecondition,
} from "../src/core/workflow/reducer.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const LEASE: WorkflowLeaseRef = {
	...EPOCH,
	leaseId: "lease-1",
	acquisitionEventSequence: 1,
	processIdentity: "process-1",
	rootDigest: "root-1",
	writerIdentity: "workflow-coordinator",
	acquiredAt: "2026-08-15T00:00:00.000Z",
	expiresAt: "2026-08-15T01:00:00.000Z",
};

function createInteractiveSecretProof(bindingDigest: string): DurableApprovalSecretProof {
	return {
		oneUseSecret: "transport-only-secret",
		bindingDigest,
		bindingDigestAlgorithm: "sha256",
	};
}

describe("provider-free workflow phase host", () => {
	it("[supplemental] consumes only a structured approval proof and persists the manager transition", async () => {
		const harness = createHarness();
		const request = createApprovalRequest();
		const proof = createInteractiveSecretProof(
			digestObject({ request: request.approvalRequestId, option: "approve" }),
		);
		const initialState = createWorkflowState("workflow-1", "session-1", "objective", 1, request.stateDigest);
		harness.store.state = {
			...initialState,
			status: "awaiting_user",
			phase: "adjudicating",
			approvalRequest: request,
		};
		bindPausedGoal(harness, "objective");
		harness.context.services.acceptance?.write("workflow-1", {
			acceptanceCheckIds: ["objective"],
			protectedInvariantIds: ["workflow-state"],
		});

		const consumed = createApprovalConsumptionResult(request, "approve");
		const consumeInteractive = vi.fn(
			async (response: Parameters<WorkflowApprovalManager["consumeInteractive"]>[0]) => {
				await harness.store.commit(
					{
						kind: "approval_consumed",
						receipt: consumed.receipt,
						resumeTransition: {
							status: "active",
							phase: "planning",
							plannerEventDigest: digestObject({
								kind: "fresh_planner_started",
								approvalRequestId: response.approvalRequestId,
							}),
							expectedHeadDigest: harness.store.state?.sourceJournalDigest ?? "",
							expectedStateDigest: request.stateDigest,
							expectedEpoch: EPOCH,
						},
					},
					{} as WorkflowCommitPrecondition,
				);
				return consumed;
			},
		);
		harness.context.services.approvals = {
			createRequest: vi.fn(),
			pending: vi.fn(async () => request),
			consumeInteractive,
			consumeSignedHeadless: vi.fn(),
			reopen: vi.fn(),
		};
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });

		const result = await host.execute({
			kind: "respond",
			approvalRequestId: request.approvalRequestId,
			optionId: "approve",
			proof,
		});

		expect(consumeInteractive).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalRequestId: request.approvalRequestId,
				workflowId: request.workflowId,
				optionId: "approve",
				mode: "interactive_secret",
				secretProof: proof,
			}),
		);
		expect(result.status).toBe("active");
		expect(result.phase).toBe("planning");
		expect(result.approvalRequest).toBeNull();
		expect(result.blocked).toBeUndefined();
	});

	it("[supplemental] does not pause or resume an awaiting approval without a consumed proof", async () => {
		const harness = createHarness();
		const request = createApprovalRequest();
		harness.store.state = {
			...createWorkflowState("workflow-1", "session-1", "objective", 1, request.stateDigest),
			status: "awaiting_user",
			phase: "adjudicating",
			approvalRequest: request,
		};
		harness.context.services.acceptance?.write("workflow-1", {
			acceptanceCheckIds: ["objective"],
			protectedInvariantIds: ["workflow-state"],
		});
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });
		const before = harness.store.events.length;

		await expect(host.execute({ kind: "pause", reason: "operator review" })).rejects.toThrow(
			/pending approval|consumed.*proof/i,
		);
		await expect(host.execute({ kind: "resume", note: "operator review" })).rejects.toThrow(
			/awaiting-user|consumed.*proof/i,
		);
		expect(harness.store.events).toHaveLength(before);
		expect(host.status().status).toBe("awaiting_user");
	});

	it.each([
		{ optionId: "approve", expectedStatus: "active" as const, expectedPhase: "planning" as const },
		{ optionId: "decline", expectedStatus: "blocked" as const, expectedPhase: "recovering" as const },
		{ optionId: "cancel", expectedStatus: "cancelled" as const, expectedPhase: "recovering" as const },
	])(
		"[supplemental] applies the consumed $optionId approval outcome without inferring from labels",
		async ({ optionId, expectedStatus, expectedPhase }) => {
			const harness = createHarness();
			const request = createApprovalRequest();
			harness.store.state = {
				...createWorkflowState("workflow-1", "session-1", "objective", 1, request.stateDigest),
				status: "awaiting_user",
				phase: "adjudicating",
				approvalRequest: request,
			};
			bindPausedGoal(harness, "objective");
			harness.context.services.acceptance?.write("workflow-1", {
				acceptanceCheckIds: ["objective"],
				protectedInvariantIds: ["workflow-state"],
			});
			harness.context.services.reconcileDescendants = vi.fn(async () => ({ reconciled: true }));
			const consumed = createApprovalConsumptionResult(request, optionId);
			const consumeInteractive = vi.fn(async () => {
				await harness.store.commit(
					{
						kind: "approval_consumed",
						receipt: consumed.receipt,
						resumeTransition: {
							status: "active",
							phase: "planning",
							plannerEventDigest: digestObject({ kind: "fresh_planner_started", optionId }),
							expectedHeadDigest: harness.store.state?.sourceJournalDigest ?? "",
							expectedStateDigest: request.stateDigest,
							expectedEpoch: EPOCH,
						},
					},
					{} as WorkflowCommitPrecondition,
				);
				return consumed;
			});
			harness.context.services.approvals = {
				createRequest: vi.fn(),
				pending: vi.fn(async () => request),
				consumeInteractive,
				consumeSignedHeadless: vi.fn(),
				reopen: vi.fn(),
			};
			const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });

			const result = await host.execute({
				kind: "respond",
				approvalRequestId: request.approvalRequestId,
				optionId,
				proof: createInteractiveSecretProof(digestObject({ request: request.approvalRequestId, option: optionId })),
			});

			expect(consumeInteractive).toHaveBeenCalledTimes(1);
			expect(result.status).toBe(expectedStatus);
			expect(result.phase).toBe(expectedPhase);
			if (optionId === "approve") {
				expect(result.blocked).toBeUndefined();
			} else {
				expect(result.status).not.toBe("active");
			}
		},
	);

	it("returns the existing terminal workflow as a typed result instead of reducing a new start", async () => {
		const harness = createHarness();
		harness.store.state = {
			...createWorkflowState("workflow-1", "session-1", "objective", 1, digestObject("terminal")),
			status: "complete",
			phase: "auditing_completion",
		};
		harness.context.services.acceptance?.write("workflow-1", {
			acceptanceCheckIds: ["objective"],
			protectedInvariantIds: ["workflow-state"],
		});
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });

		const result = await host.execute({
			kind: "start",
			request: { workflowId: "workflow-1", objective: "must not restart" },
		});

		expect(result.status).toBe("complete");
		expect(result.phase).toBe("auditing_completion");
		expect(harness.store.events).toHaveLength(0);
	});

	it("does not silently reuse a paused goal without an explicit objective", async () => {
		const harness = createHarness();
		const pausedGoal: GoalState = {
			...emptyGoalState(),
			goalId: "goal-1",
			objective: "old objective",
			status: "paused",
			active: false,
		};
		expect(
			harness.context.goalProjection.compareAndSwap(
				emptyGoalState(),
				pausedGoal,
				{} as WorkflowGoalProjectionAuthorization,
			),
		).toBe(true);
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });

		await expect(host.execute({ kind: "start", request: { workflowId: "workflow-1" } })).rejects.toThrow(
			/paused goal.*explicit objective|resume.*goal/i,
		);
		expect(harness.store.events).toHaveLength(0);
	});

	it("[supplemental] reports the manager contract when a consumed approval has no typed outcome", async () => {
		const harness = createHarness();
		const request = createApprovalRequest();
		harness.store.state = {
			...createWorkflowState("workflow-1", "session-1", "objective", 1, request.stateDigest),
			status: "awaiting_user",
			phase: "adjudicating",
			approvalRequest: request,
		};
		harness.context.services.acceptance?.write("workflow-1", {
			acceptanceCheckIds: ["objective"],
			protectedInvariantIds: ["workflow-state"],
		});
		const consumed = createApprovalConsumptionResult(request, "approve");
		const { outcome: _outcome, ...receiptOnlyResult } = consumed;
		harness.context.services.approvals = {
			createRequest: vi.fn(),
			pending: vi.fn(async () => request),
			consumeInteractive: vi.fn(async () => receiptOnlyResult),
			consumeSignedHeadless: vi.fn(),
			reopen: vi.fn(),
		};
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });

		await expect(
			host.execute({
				kind: "respond",
				approvalRequestId: request.approvalRequestId,
				optionId: "approve",
				proof: createInteractiveSecretProof(
					digestObject({ request: request.approvalRequestId, option: "approve" }),
				),
			}),
		).rejects.toThrow(/selected outcome|WorkflowApprovalManagerWithOutcome|receipt contract/i);
	});

	it("rejects stale phase outcomes before changing durable state", async () => {
		const harness = createHarness();
		harness.store.state = {
			...createWorkflowState("workflow-1", "session-1", "stale outcome", 1, digestObject("current-head")),
			status: "active",
			phase: "executing",
		};
		bindPausedGoal(harness, "stale outcome");
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });
		const before = harness.store.events.length;
		const outcome: WorkflowPhaseOutcomeRecord = {
			attemptStatus: "interrupted",
			outcome: {
				workflowId: "workflow-1",
				phaseAttemptId: "attempt-1",
				epochRef: EPOCH,
				invocationToken: "token-1",
				inputStateDigest: "stale-head",
				status: "pause",
				approvalRequestId: "approval-1",
				artifactRefs: [],
				evidenceRefs: [],
			},
		};

		await expect(host.runOutcome(outcome)).rejects.toThrow(/stale|current/i);
		expect(harness.store.events).toHaveLength(before);
	});

	it("rebases a lifecycle pause when worker progress advances the journal after the status read", async () => {
		const harness = createHarness();
		harness.store.state = {
			...createWorkflowState("workflow-1", "session-1", "durable live objective", 1, digestObject("active-head")),
			status: "active",
			phase: "executing",
		};
		const currentGoal = harness.context.goalProjection.read();
		const activeGoal: GoalState = {
			...emptyGoalState(),
			goalId: "goal-1",
			objective: "durable live objective",
			active: true,
			status: "active",
		};
		if (
			!harness.context.goalProjection.compareAndSwap(
				currentGoal,
				activeGoal,
				{} as WorkflowGoalProjectionAuthorization,
			)
		)
			throw new Error("Failed to prepare active goal projection.");
		harness.store.state = {
			...harness.store.state,
			goalId: activeGoal.goalId ?? "",
			objective: activeGoal.objective ?? "",
			goalActive: true,
			goalStatus: "active",
		};
		harness.context.services.acceptance?.write("workflow-1", {
			acceptanceCheckIds: ["lifecycle-pause-is-durable"],
			protectedInvariantIds: ["worker-progress-is-preserved"],
		});
		harness.store.remainingHeadAdvancesBeforeGoalTransition = 6;
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });

		const result = await host.execute({ kind: "pause", reason: "Planner failed after public tool result" });

		expect(result).toMatchObject({ status: "paused", phase: "recovering" });
		expect(harness.store.state).toMatchObject({ status: "paused", goalStatus: "paused" });
		expect(
			harness.store.events.filter((event) => event.kind === "workflow_status_changed" && event.status === "paused"),
		).toHaveLength(1);
		expect(harness.store.syntheticWorkerAdvances).toBe(6);
	});

	it("rebases a lifecycle pause when the worker rotates the active store lease before the status commit", async () => {
		const harness = createHarness();
		harness.store.state = {
			...createWorkflowState("workflow-1", "session-1", "durable live objective", 1, digestObject("active-head")),
			status: "active",
			phase: "executing",
		};
		const currentGoal = harness.context.goalProjection.read();
		const activeGoal: GoalState = {
			...emptyGoalState(),
			goalId: "goal-1",
			objective: "durable live objective",
			active: true,
			status: "active",
		};
		if (
			!harness.context.goalProjection.compareAndSwap(
				currentGoal,
				activeGoal,
				{} as WorkflowGoalProjectionAuthorization,
			)
		)
			throw new Error("Failed to prepare active goal projection.");
		harness.store.state = {
			...harness.store.state,
			goalId: activeGoal.goalId ?? "",
			objective: activeGoal.objective ?? "",
			goalActive: true,
			goalStatus: "active",
		};
		harness.context.services.acceptance?.write("workflow-1", {
			acceptanceCheckIds: ["lifecycle-pause-is-durable"],
			protectedInvariantIds: ["worker-lease-rotation-is-preserved"],
		});
		harness.store.failNextStatusChangeWithStaleStorePrecondition = true;
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });

		const result = await host.execute({ kind: "pause", reason: "Planner failed after public tool result" });

		expect(result).toMatchObject({ status: "paused", phase: "recovering" });
		expect(harness.store.state).toMatchObject({ status: "paused", goalStatus: "paused" });
		expect(harness.store.staleStorePreconditionFailures).toBe(1);
		expect(
			harness.store.events.filter((event) => event.kind === "workflow_status_changed" && event.status === "paused"),
		).toHaveLength(1);
	});

	it("fails closed when lifecycle pause cannot obtain a stable authoritative head", async () => {
		const harness = createHarness();
		harness.store.state = {
			...createWorkflowState("workflow-1", "session-1", "durable live objective", 1, digestObject("active-head")),
			status: "active",
			phase: "executing",
		};
		const currentGoal = harness.context.goalProjection.read();
		const activeGoal: GoalState = {
			...emptyGoalState(),
			goalId: "goal-1",
			objective: "durable live objective",
			active: true,
			status: "active",
		};
		if (
			!harness.context.goalProjection.compareAndSwap(
				currentGoal,
				activeGoal,
				{} as WorkflowGoalProjectionAuthorization,
			)
		)
			throw new Error("Failed to prepare active goal projection.");
		harness.store.state = {
			...harness.store.state,
			goalId: activeGoal.goalId ?? "",
			objective: activeGoal.objective ?? "",
			goalActive: true,
			goalStatus: "active",
		};
		harness.store.advanceHeadBeforeEveryGoalTransition = true;
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });

		await expect(host.execute({ kind: "pause", reason: "Planner failed after public tool result" })).rejects.toThrow(
			"Workflow GoalState transition head or epoch is stale.",
		);

		expect(harness.store.syntheticWorkerAdvances).toBe(16);
		expect(harness.store.state).toMatchObject({ status: "active", goalStatus: "active" });
		expect(
			harness.store.events.filter((event) => event.kind === "workflow_status_changed" && event.status === "paused"),
		).toHaveLength(0);
	});

	it("keeps an external blocker dormant across reopen and resumes once for its exact event", async () => {
		const harness = createHarness();
		harness.store.state = {
			...createWorkflowState("workflow-1", "session-1", "durable blocked workflow", 1, digestObject("active-head")),
			status: "active",
			phase: "executing",
			goalContractDigest: digestObject("immutable-goal-revision"),
		};
		bindPausedGoal(harness, "durable blocked workflow");
		harness.context.services.acceptance?.write("workflow-1", {
			acceptanceCheckIds: ["objective"],
			protectedInvariantIds: ["workflow-state"],
		});
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });
		const blockOnExternal = Reflect.get(host, "blockOnExternal");
		expect(blockOnExternal).toBeTypeOf("function");
		harness.store.failNextStatusChange = true;
		await expect(
			Reflect.apply(blockOnExternal, host, [
				{
					dependencyId: "host-version",
					conditionDigest: digestObject({ minimumVersion: "0.147.0-alpha.10" }),
					requiredChange: "Install an admitted host runtime version.",
					owner: "capability_host",
					resumeEventKind: "host_runtime_ready",
					earliestRetryAt: null,
					evidenceRefs: [],
					recordedAt: "2026-08-17T23:38:34.000Z",
				},
			]),
		).rejects.toThrow(/simulated status commit crash/i);
		expect(harness.store.state?.status).toBe("active");
		const blockerEvent = harness.store.events.find((event) => event.kind === "workflow_external_blocker_recorded");
		if (blockerEvent?.kind !== "workflow_external_blocker_recorded")
			throw new Error("workflow_external_blocker_event_missing");
		expect(decodeWorkflowEventPayload(canonicalJsonBytes(blockerEvent))).toEqual(blockerEvent);
		expect(() =>
			decodeWorkflowEventPayload(
				canonicalJsonBytes({
					...blockerEvent,
					blocker: { ...blockerEvent.blocker, owner: "external" },
				}),
			),
		).toThrow(/canonical|payload|digest/i);
		const reopenedContext: WorkflowPhaseHostContext = {
			...harness.context,
			services: { ...harness.context.services },
		};
		const reopened = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: reopenedContext });
		expect(reopened.status()).toMatchObject({
			status: "blocked",
			blocked: {
				owner: "capability_host",
				resumeEventKind: "host_runtime_ready",
				nextEligibleAt: null,
				blockerDigest: expect.any(String),
				resumePredicateDigest: expect.any(String),
			},
		});
		await expect(reopened.execute({ kind: "resume" })).rejects.toThrow(/blocked|paused/i);
		const resumeBlocked = Reflect.get(reopened, "resumeBlocked");
		expect(resumeBlocked).toBeTypeOf("function");
		await expect(
			Reflect.apply(resumeBlocked, reopened, [
				{
					eventKind: "unrelated_event",
					eventDigest: digestObject("unrelated"),
					observedAt: "2026-08-17T23:40:00.000Z",
				},
			]),
		).rejects.toThrow(/predicate|event/i);
		expect(reopened.status().status).toBe("blocked");
		harness.store.failNextStatusChange = true;
		await expect(
			Reflect.apply(resumeBlocked, reopened, [
				{
					eventKind: "host_runtime_ready",
					eventDigest: digestObject("runtime-0.147.0-alpha.10-ready"),
					observedAt: "2026-08-17T23:41:00.000Z",
				},
			]),
		).rejects.toThrow(/simulated status commit crash/i);
		expect(harness.store.state?.status).toBe("blocked");
		const finalContext: WorkflowPhaseHostContext = {
			...harness.context,
			services: { ...harness.context.services },
		};
		const resumed = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: finalContext });
		expect(resumed.status()).toMatchObject({ status: "active", blocked: undefined });
		const resolvedResume = Reflect.get(resumed, "resumeBlocked");
		await expect(
			Reflect.apply(resolvedResume, resumed, [
				{
					eventKind: "host_runtime_ready",
					eventDigest: digestObject("runtime-0.147.0-alpha.10-ready"),
					observedAt: "2026-08-17T23:41:00.000Z",
				},
			]),
		).rejects.toThrow(/blocked|already/i);
	});
});

interface Harness {
	store: MemoryStore;
	context: WorkflowPhaseHostContext;
}

function bindPausedGoal(harness: Harness, objective: string): void {
	const current = harness.context.goalProjection.read();
	const goalId = "goal-1";
	const paused: GoalState = {
		...emptyGoalState(),
		goalId,
		objective,
		active: false,
		status: "paused",
	};
	if (!harness.context.goalProjection.compareAndSwap(current, paused, {} as WorkflowGoalProjectionAuthorization))
		throw new Error("Failed to prepare paused goal projection.");
	if (harness.store.state !== null) {
		harness.store.state = {
			...harness.store.state,
			goalId,
			objective,
			goalActive: paused.active,
			goalStatus: paused.status,
		};
	}
}

class MemoryStore implements WorkflowStorePort {
	state: ReducedWorkflowState | null = null;
	events: WorkflowEventPayload[] = [];
	failNextStatusChange = false;
	failNextStatusChangeWithStaleStorePrecondition = false;
	staleStorePreconditionFailures = 0;
	advanceHeadBeforeNextGoalTransition = false;
	advanceHeadBeforeEveryGoalTransition = false;
	remainingHeadAdvancesBeforeGoalTransition = 0;
	syntheticWorkerAdvances = 0;
	readonly journal = {
		replayLogicalHistory: async (): Promise<readonly WorkflowJournalEvent[]> =>
			this.events.map(
				(payload, index) =>
					({
						sequence: index + 1,
						payload,
					}) as WorkflowJournalEvent,
			),
	};

	async reload(): Promise<ReducedWorkflowState | null> {
		return this.state;
	}

	advanceWorkerHead(): void {
		if (
			(!this.advanceHeadBeforeNextGoalTransition &&
				!this.advanceHeadBeforeEveryGoalTransition &&
				this.remainingHeadAdvancesBeforeGoalTransition === 0) ||
			this.state === null
		)
			return;
		this.advanceHeadBeforeNextGoalTransition = false;
		if (this.remainingHeadAdvancesBeforeGoalTransition > 0) this.remainingHeadAdvancesBeforeGoalTransition -= 1;
		this.syntheticWorkerAdvances += 1;
		const sequence = this.state.sourceJournalSequence + 1;
		this.state = {
			...this.state,
			sourceJournalSequence: sequence,
			sourceJournalDigest: digestObject({ sequence, kind: "synthetic_worker_progress" }),
		};
	}

	snapshot(): ReducedWorkflowState | null {
		return this.state;
	}

	async commit(
		payload: WorkflowEventPayload,
		_precondition: WorkflowCommitPrecondition,
	): Promise<ReducedWorkflowState> {
		if (payload.kind === "workflow_status_changed" && this.failNextStatusChangeWithStaleStorePrecondition) {
			this.failNextStatusChangeWithStaleStorePrecondition = false;
			this.staleStorePreconditionFailures += 1;
			throw new Error(
				"Workflow store compare-and-swap precondition is stale or is not bound to the active writer and lease.",
			);
		}
		if (payload.kind === "workflow_status_changed" && this.failNextStatusChange) {
			this.failNextStatusChange = false;
			throw new Error("simulated status commit crash");
		}
		this.events.push(payload);
		const prior = this.state;
		const sequence = (prior?.sourceJournalSequence ?? 0) + 1;
		const stateDigest = digestObject({ sequence, payload });
		if (payload.kind === "workflow_started") {
			this.state = createWorkflowState(
				payload.workflowId,
				payload.rootSessionId,
				payload.objective,
				sequence,
				stateDigest,
			);
			return this.state;
		}
		if (prior === null) throw new Error("Memory workflow store requires workflow_started first.");
		const next: ReducedWorkflowState = {
			...prior,
			sourceJournalSequence: sequence,
			sourceJournalDigest: stateDigest,
		};
		switch (payload.kind) {
			case "goal_binding_committed":
				next.goalId = payload.goalId;
				next.objective = payload.objective;
				next.goalActive = payload.goalDelta.active;
				next.goalStatus = payload.goalDelta.status;
				break;
			case "goal_contract_proposed":
				next.goalContractDigest = payload.contractDigest;
				next.decisionRefs = [...next.decisionRefs, payload.decisionRef];
				break;
			case "scorecard_proposed":
				next.scorecardDigest = payload.scorecardDigest;
				next.decisionRefs = [...next.decisionRefs, payload.decisionRef];
				break;
			case "resource_envelope_proposed":
				next.resourceEnvelopeDigest = payload.envelopeDigest;
				next.decisionRefs = [...next.decisionRefs, payload.decisionRef];
				break;
			case "workflow_status_changed":
				next.status = payload.status;
				next.phase = payload.phase;
				next.goalActive = payload.goalDelta.active;
				next.goalStatus = payload.goalDelta.status;
				next.goalLastReason = payload.goalDelta.lastReason;
				break;
			case "approval_requested":
				next.status = "awaiting_user";
				next.phase = "adjudicating";
				next.approvalRequest = payload.approval;
				next.goalActive = payload.awaitingUser.goalDelta.active;
				next.goalStatus = payload.awaitingUser.goalDelta.status;
				break;
			case "approval_consumed":
				next.status = payload.resumeTransition.status;
				next.phase = payload.resumeTransition.phase;
				next.approvalRequest = null;
				break;
			default:
				break;
		}
		this.state = next;
		return next;
	}
}

function createWorkflowState(
	workflowId: string,
	rootSessionId: string,
	objective: string,
	sequence: number,
	digest: string,
): ReducedWorkflowState {
	return {
		workflowId,
		rootSessionId,
		status: "active",
		phase: "hardening_goal",
		objective,
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
		sourceJournalSequence: sequence,
		sourceJournalDigest: digest,
		storeEpoch: 1,
		coordinatorEpoch: 1,
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
			writerIdentity: LEASE.writerIdentity,
			processGenerationId: "generation-1",
			ownerIdentity: "workflow-coordinator",
		},
	};
}

function createApprovalDecisionRef(decisionId: string): WorkflowDecisionRef {
	return {
		decisionScope: { kind: "workflow", workflowId: "workflow-1", rootSessionId: "session-1" },
		decisionId,
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		decisionDigest: digestObject(decisionId),
	};
}

function createApprovalRequest(): WorkflowApprovalRequest {
	const decisionRefs = [
		createApprovalDecisionRef("goal"),
		createApprovalDecisionRef("scorecard"),
		createApprovalDecisionRef("resource"),
	] as const;
	return {
		approvalRequestId: "approval-1",
		workflowId: "workflow-1",
		decisionRef: decisionRefs[2],
		decisionRefs,
		decisionRoles: { goal: decisionRefs[0], scorecard: decisionRefs[1], resource: decisionRefs[2] },
		headDigest: digestObject("head"),
		stateDigest: digestObject("state"),
		configDigest: digestObject("config"),
		profileDigest: digestObject("profile"),
		artifactDigest: digestObject("artifact"),
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		tokenHash: digestObject("token"),
		tokenHashAlgorithm: "sha256",
		trustedPrincipal: {
			kind: "workflow_command",
			principalId: "operator-1",
			credentialDigest: digestObject("credential"),
		},
		requestingClientSessionId: "session-1",
		expectedResponseSequence: 1,
		expiresAt: "2030-01-01T00:05:00.000Z",
		question: "Choose a workflow disposition.",
		options: [
			{ optionId: "approve", label: "Approve", effectDigest: digestObject("approve") },
			{ optionId: "decline", label: "Decline", effectDigest: digestObject("decline") },
			{ optionId: "cancel", label: "Cancel", effectDigest: digestObject("cancel") },
		],
	};
}

function createApprovalConsumptionResult(
	request: WorkflowApprovalRequest,
	optionId: string,
): WorkflowApprovalConsumptionResult & { outcome: WorkflowApprovalHostOutcome } {
	const effectDigest = request.options.find((option) => option.optionId === optionId)?.effectDigest ?? "";
	const responseDigest = digestObject({ request: request.approvalRequestId, optionId });
	const outcomeBase = {
		approvalRequestId: request.approvalRequestId,
		optionId,
		effectDigest,
		responseDigest,
		outcomeDigest: digestObject({ request: request.approvalRequestId, optionId, effectDigest, responseDigest }),
	};
	const outcome: WorkflowApprovalHostOutcome =
		optionId === "approve"
			? { ...outcomeBase, action: "approve", disposition: "approved", transition: "resume_planning" }
			: optionId === "decline"
				? { ...outcomeBase, action: "decline", disposition: "declined", transition: "remain_awaiting_user" }
				: optionId === "cancel"
					? { ...outcomeBase, action: "cancel", disposition: "cancelled", transition: "cancelled" }
					: (() => {
							throw new Error(`Unsupported test approval option ${optionId}.`);
						})();
	const receipt: WorkflowApprovalReceipt = {
		approvalRequestId: request.approvalRequestId,
		workflowId: request.workflowId,
		decisionRef: request.decisionRef,
		decisionRefs: request.decisionRefs as readonly WorkflowDecisionRef[],
		decisionRoles: request.decisionRoles,
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
		optionId,
		effectDigest,
		mode: "interactive_secret",
		responseDigest,
		consumedAt: "2030-01-01T00:00:01.000Z",
		consumptionEventSequence: 2,
		trustedClockReceipt: {} as WorkflowVerifiedHostReceipt,
	};
	return { status: "consumed", receipt, outcome };
}

function createHarness(): Harness {
	const store = new MemoryStore();
	let goal: GoalState = emptyGoalState();
	const committedGoalEvents = new Map<
		string,
		{ eventSequence: number; transitionDigest: string; payload: WorkflowGoalTransitionPayload }
	>();
	const authorization = {} as WorkflowGoalProjectionAuthorization;
	let acceptance: WorkflowAcceptanceState | null = null;
	const goalProjection = {
		read: () => structuredClone(goal),
		compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
	const goalCoordinator = createWorkflowGoalCoordinator({
		adapter: goalProjection,
		append: async (request) => {
			const next = await store.commit(request.payload, {} as WorkflowCommitPrecondition);
			const committed = {
				eventSequence: next.sourceJournalSequence,
				transitionDigest: next.sourceJournalDigest,
				payload: request.payload,
			};
			committedGoalEvents.set(`${request.workflowId}:${request.idempotencyKey}`, committed);
			return committed;
		},
		readCommitted: async (workflowId, idempotencyKey) =>
			committedGoalEvents.get(`${workflowId}:${idempotencyKey}`) ?? null,
		readHead: async () => {
			store.advanceWorkerHead();
			const state = await store.reload();
			if (state === null) throw new Error("Memory workflow store has no current head.");
			return {
				workflowId: state.workflowId,
				sequence: state.sourceJournalSequence,
				eventDigest: state.sourceJournalDigest,
				epochRef: EPOCH,
			};
		},
		authorize: async () => authorization,
	});
	const context: WorkflowPhaseHostContext = {
		workflowId: "workflow-1",
		rootSessionId: "session-1",
		store,
		goalProjection,
		services: {
			store,
			goal: goalCoordinator,
			journal: { currentLeaseRef: () => ({ ...LEASE }) },
			currentEpoch: () => ({ ...EPOCH }),
			acceptance: {
				read: () => (acceptance === null ? null : structuredClone(acceptance)),
				write: (_workflowId: string, next: WorkflowAcceptanceState): void => {
					acceptance = structuredClone(next);
				},
			},
		},
	};
	return { store, context };
}
