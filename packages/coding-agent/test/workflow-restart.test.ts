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

describe("workflow phase-host reopen", () => {
	it("reopens from journal-derived awaiting_user state without auto-resuming", async () => {
		const harness = createHarness();
		const firstHost = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });
		await firstHost.execute({
			kind: "start",
			request: {
				workflowId: "workflow-1",
				objective: "survive restart",
				acceptanceChecks: ["restart-state"],
				protectedInvariants: ["no-auto-resume"],
			},
		});
		await firstHost.dispose?.();

		const reopened = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });
		const status = await reopened.execute({ kind: "status" });
		expect(status.status).toBe("awaiting_user");
		expect(status.phase).toBe("adjudicating");
		expect(status.acceptanceCheckIds).toEqual(["restart-state"]);
		expect(status.protectedInvariantIds).toEqual(["no-auto-resume"]);
		expect(status.goal.status).toBe("paused");
		expect(status.approvalRequest).toBeNull();
		expect(harness.store.events.filter((event) => event.kind === "fresh_planner_started")).toHaveLength(0);
	});

	it("preserves a user pause across reopen without bypassing start approval", async () => {
		const harness = createHarness();
		const firstHost = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });
		await firstHost.execute({
			kind: "start",
			request: { workflowId: "workflow-1", objective: "pause across restart" },
		});
		await firstHost.execute({ kind: "pause", reason: "operator pause" });
		await firstHost.dispose?.();

		const reopened = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context: harness.context });
		expect(reopened.status().status).toBe("paused");
		expect(reopened.status().goal.status).toBe("paused");
		const resumed = await reopened.execute({ kind: "resume", note: "operator resumed" });
		expect(resumed.status).toBe("awaiting_user");
		expect(resumed.phase).toBe("adjudicating");
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
		const digest = digestObject({ sequence, payload });
		if (payload.kind === "workflow_started") {
			this.state = createWorkflowState(
				payload.workflowId,
				payload.rootSessionId,
				payload.objective,
				sequence,
				digest,
			);
			return this.state;
		}
		if (previous === null) throw new Error("workflow_started is required");
		const next = { ...previous, sourceJournalSequence: sequence, sourceJournalDigest: digest };
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

function createHarness(): { store: MemoryStore; context: WorkflowPhaseHostContext } {
	const store = new MemoryStore();
	let goal: GoalState = emptyGoalState();
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
