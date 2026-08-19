import { describe, expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import type { WorkflowEpochRef, WorkflowEventPayload, WorkflowLeaseRef } from "../src/core/workflow/contracts.js";
import { digestObject } from "../src/core/workflow/contracts.js";
import {
	createProviderFreeWorkflowPhaseHost,
	type WorkflowAcceptanceState,
	type WorkflowPhaseHostContext,
	type WorkflowStorePort,
} from "../src/core/workflow/phase-host.js";
import type { WorkflowCommitPrecondition, WorkflowState } from "../src/core/workflow/reducer.js";

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

describe("workflow shell commands", () => {
	it("enforces exact objective binding and rejects duplicate starts without appending", async () => {
		const harness = createHarness({ objective: "existing objective" });
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });

		await expect(
			host.execute({
				kind: "start",
				request: { workflowId: "workflow-1", objective: "different objective" },
			}),
		).rejects.toThrow(/exactly match/i);
		expect(harness.store.events).toHaveLength(0);

		await host.execute({ kind: "start", request: { workflowId: "workflow-1", objective: "existing objective" } });
		const eventCount = harness.store.events.length;
		await expect(
			host.execute({ kind: "start", request: { workflowId: "workflow-1", objective: "existing objective" } }),
		).rejects.toThrow(/unfinished|already/i);
		expect(harness.store.events).toHaveLength(eventCount);
	});

	it("keeps cancellation typed blocked when no reconciliation barrier is available", async () => {
		const harness = createHarness({});
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });
		await host.execute({
			kind: "start",
			request: { workflowId: "workflow-1", objective: "do not cancel live work" },
		});
		const eventCount = harness.store.events.length;

		const result = await host.execute({ kind: "cancel", reason: "operator requested stop" });
		expect(result.status).toBe("awaiting_user");
		expect(result.blocked).toEqual({
			kind: "cancellation_reconciliation",
			reason: "descendant reconciliation barrier is unavailable",
		});
		expect(harness.store.events).toHaveLength(eventCount);
	});

	it("makes status, decisions, and resources inspection read-only", async () => {
		const harness = createHarness({});
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });
		await host.execute({ kind: "start", request: { workflowId: "workflow-1", objective: "inspect me" } });
		const eventCount = harness.store.events.length;

		await host.execute({ kind: "status" });
		await host.execute({ kind: "decisions" });
		await host.execute({ kind: "resources" });
		expect(harness.store.events).toHaveLength(eventCount);
	});
});

class MemoryStore implements WorkflowStorePort {
	state: WorkflowState | null = null;
	events: WorkflowEventPayload[] = [];

	async reload(): Promise<WorkflowState | null> {
		return this.state;
	}

	snapshot(): WorkflowState | null {
		return this.state;
	}

	async commit(payload: WorkflowEventPayload, _precondition: WorkflowCommitPrecondition): Promise<WorkflowState> {
		this.events.push(payload);
		const previous = this.state;
		const sequence = (previous?.sourceJournalSequence ?? 0) + 1;
		const nextDigest = digestObject({ sequence, payload });
		if (payload.kind === "workflow_started") {
			this.state = createWorkflowState(
				payload.workflowId,
				payload.rootSessionId,
				payload.objective,
				sequence,
				nextDigest,
			);
			return this.state;
		}
		if (previous === null) throw new Error("workflow_started is required");
		const next = { ...previous, sourceJournalSequence: sequence, sourceJournalDigest: nextDigest };
		if (payload.kind === "goal_binding_committed") {
			next.goalId = payload.goalId;
			next.objective = payload.objective;
			next.goalActive = payload.goalDelta.active;
			next.goalStatus = payload.goalDelta.status;
		}
		if (payload.kind === "goal_contract_proposed") {
			next.goalContractDigest = payload.contractDigest;
			next.decisionRefs = [...next.decisionRefs, payload.decisionRef];
		}
		if (payload.kind === "scorecard_proposed") {
			next.scorecardDigest = payload.scorecardDigest;
			next.decisionRefs = [...next.decisionRefs, payload.decisionRef];
		}
		if (payload.kind === "resource_envelope_proposed") {
			next.resourceEnvelopeDigest = payload.envelopeDigest;
			next.decisionRefs = [...next.decisionRefs, payload.decisionRef];
		}
		if (payload.kind === "workflow_status_changed") {
			next.status = payload.status;
			next.phase = payload.phase;
			next.goalActive = payload.goalDelta.active;
			next.goalStatus = payload.goalDelta.status;
			next.goalLastReason = payload.goalDelta.lastReason;
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
): WorkflowState {
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

function createHarness(input: { objective?: string }): { store: MemoryStore; context: WorkflowPhaseHostContext } {
	const store = new MemoryStore();
	let goal: GoalState = input.objective
		? { ...emptyGoalState(), goalId: "goal-1", objective: input.objective, active: true, status: "active" }
		: emptyGoalState();
	let acceptance: WorkflowAcceptanceState | null = null;
	const goalProjection = {
		read: () => structuredClone(goal),
		compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
	return {
		store,
		context: {
			workflowId: "workflow-1",
			rootSessionId: "session-1",
			store,
			goalProjection,
			services: {
				store,
				journal: { currentLeaseRef: () => ({ ...LEASE }) },
				currentEpoch: () => ({ ...EPOCH }),
				acceptance: {
					read: () => (acceptance === null ? null : structuredClone(acceptance)),
					write: (_workflowId: string, next: WorkflowAcceptanceState): void => {
						acceptance = structuredClone(next);
					},
				},
			},
		},
	};
}
