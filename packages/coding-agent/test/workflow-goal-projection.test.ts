import { describe, expect, it } from "vitest";
import type { GoalState } from "../src/core/goals.js";
import {
	digestObject,
	type WorkflowGoalContract,
	type WorkflowGoalMutationDelta,
	type WorkflowScorecard,
} from "../src/core/workflow/contracts.js";
import type { WorkflowGoalProjectionAuthorization } from "../src/core/workflow/journal.js";
import type {
	WorkflowGoalProgressObservation,
	WorkflowGoalProjectionAdapter,
	WorkflowGoalProjectionEvent,
	WorkflowGoalProjectionState,
	WorkflowGoalTransitionRequest,
} from "../src/core/workflow/projections.js";
import {
	applyWorkflowGoalProgress,
	createWorkflowGoalCoordinator,
	createWorkflowGoalProjection,
	mapWorkflowStatusToGoalStatus,
	projectWorkflowGoalEvents,
	projectWorkflowGoalTransition,
} from "../src/core/workflow/projections.js";
import { loadPersistedEpochFixture } from "./workflow-fixtures.js";

const epoch = loadPersistedEpochFixture().acquired;
const decisionRef = {
	decisionScope: { kind: "workflow" as const, workflowId: "workflow-1", rootSessionId: "root-1" },
	decisionId: "decision-1",
	revision: 1,
	storeEpoch: epoch.storeEpoch,
	coordinatorEpoch: epoch.coordinatorEpoch,
	decisionDigest: "decision-1-digest",
};
const leaseRef = {
	...epoch,
	leaseId: "lease-1",
	acquisitionEventSequence: 1,
	processIdentity: "process-1",
	rootDigest: "root-digest",
	writerIdentity: "writer-1",
	acquiredAt: "2026-08-15T00:00:00.000Z",
	expiresAt: "2026-08-15T01:00:00.000Z",
};

const contract: WorkflowGoalContract = {
	goalId: "goal-1",
	revision: 1,
	originalObjective: "ship the verified result",
	requirements: [
		{
			requirementId: "requirement-1",
			outcome: "the result is observable",
			acceptanceCheckIds: ["check-1"],
			requiredEvidenceKinds: ["integration"],
			adversarialTestArtifactRefs: [],
		},
	],
	constraints: [],
	nonGoals: [],
	authorityCapabilities: [],
	contractDigest: "contract-1",
};

const scorecard: WorkflowScorecard = {
	scorecardId: "scorecard-1",
	revision: 1,
	metrics: [
		{
			metricId: "metric-1",
			requirementId: "requirement-1",
			direction: "maximize",
			baseline: 0,
			target: 1,
			tolerance: 0,
			parserDigest: "parser-1",
			measurementCommandDigest: "command-1",
			evaluatorDigest: "evaluator-1",
			repeatability: { kind: "repeated", runs: 2, aggregation: "mean", maxVariance: 0 },
		},
	],
	acceptanceChecks: [
		{
			checkId: "check-1",
			description: "independent integration evidence",
			evaluatorDigest: "evaluator-1",
			requiredEvidenceKinds: ["integration"],
			freshnessMilliseconds: 60_000,
			reproducibilityDigest: "reproducible-1",
		},
	],
	protectedInvariants: [
		{
			invariantId: "invariant-1",
			description: "the protected behavior remains intact",
			evaluatorDigest: "evaluator-1",
			falsificationArtifactRefs: [],
		},
	],
	guardMetricIds: [],
	resourceConstraintDigest: "resources-1",
	proxyAttackArtifactRefs: [],
	evidenceRuleDigest: "evidence-1",
	scorecardDigest: "scorecard-1",
};

function createProjection(): WorkflowGoalProjectionState {
	return createWorkflowGoalProjection({
		workflowId: "workflow-1",
		goalId: "goal-1",
		objective: contract.originalObjective,
		goalContract: contract,
		scorecard,
		tokenBudget: 100,
	});
}

function createEvidenceRef(id: string): WorkflowGoalProgressObservation["evidenceRefs"][number] {
	return {
		artifactId: id,
		relativePath: `evidence/${id}`,
		digest: `${id}-digest`,
		sizeBytes: 1,
		sourceEventSequence: 2,
	};
}

function createProgressObservation(
	overrides: Partial<WorkflowGoalProgressObservation> = {},
): WorkflowGoalProgressObservation {
	return {
		requirementId: "requirement-1",
		acceptanceCheckIds: ["check-1"],
		protectedInvariantIds: ["invariant-1"],
		evidenceRefs: [createEvidenceRef("integration")],
		evidenceRevisions: [1],
		workspaceDigest: "workspace-1",
		auditorDecisionDigest: "audit-1",
		independent: true,
		outcomeVerified: true,
		...overrides,
	};
}

function createGoalDelta(overrides: Partial<WorkflowGoalMutationDelta> = {}): WorkflowGoalMutationDelta {
	return {
		goalId: "goal-1",
		objective: contract.originalObjective,
		active: true,
		status: "active",
		tokenBudget: 100,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		continuationsUsed: 0,
		createdAt: 1,
		updatedAt: 1,
		lastReason: null,
		lastError: null,
		...overrides,
	};
}

function createEvent(sequence: number, payload: WorkflowGoalProjectionEvent["payload"]): WorkflowGoalProjectionEvent {
	return { sequence, eventDigest: `event-${sequence}`, payload };
}

describe("workflow goal projection", () => {
	it("keeps the objective, acceptance checks, and protected invariants authoritative", () => {
		const projection = createProjection();

		expect(projection.objective).toBe(contract.originalObjective);
		expect(projection.goalContract).toEqual(contract);
		expect(projection.scorecard).toEqual(scorecard);
		expect(projection.acceptanceCheckIds).toEqual(["check-1"]);
		expect(projection.protectedInvariantIds).toEqual(["invariant-1"]);
		expect(projection.progress.entries).toHaveLength(1);
		expect(projection.progress.entries[0]?.status).toBe("unproven");
	});

	it("preserves exact metric-to-requirement bindings and rejects cross-requirement metrics", () => {
		const projection = createProjection();

		expect(projection.scorecard?.metrics.map(({ metricId, requirementId }) => ({ metricId, requirementId }))).toEqual(
			[{ metricId: "metric-1", requirementId: "requirement-1" }],
		);

		const mismatchedScorecard: WorkflowScorecard = {
			...scorecard,
			metrics: scorecard.metrics.map((metric) => ({ ...metric, requirementId: "requirement-2" })),
			scorecardDigest: "scorecard-mismatched-requirement",
		};
		expect(() =>
			createWorkflowGoalProjection({
				workflowId: "workflow-1",
				goalId: "goal-1",
				objective: contract.originalObjective,
				goalContract: contract,
				scorecard: mismatchedScorecard,
			}),
		).toThrow(/metric.*requirement/i);
	});

	it("rejects a transition that changes the hardened objective or scorecard", () => {
		const projection = createProjection();

		expect(() =>
			projectWorkflowGoalEvents(projection, [
				createEvent(1, {
					kind: "goal_projection_applied",
					goalDelta: createGoalDelta({ objective: "narrowed objective" }),
					goalDigest: digestObject(createGoalDelta({ objective: "narrowed objective" })),
					binding: { workflowId: "workflow-1", eventSequence: 1, transitionDigest: "transition-1", ...epoch },
				}),
			]),
		).toThrow(/objective/i);

		expect(() =>
			projectWorkflowGoalEvents({ ...projection, scorecardDigest: "changed-scorecard" }, [
				createEvent(1, {
					kind: "scorecard_proposed",
					scorecardDigest: "new-scorecard",
					decisionRef,
				}),
			]),
		).toThrow(/scorecard/i);
	});

	it.each([
		["goal contract", { kind: "goal_contract_committed", contract }],
		["scorecard", { kind: "scorecard_committed", scorecard }],
		["accepted progress", { kind: "workflow_progress_accepted", observation: createProgressObservation() }],
		[
			"regressed progress",
			{
				kind: "workflow_progress_regressed",
				observation: createProgressObservation({ regressed: true, regressionReason: "audit" }),
			},
		],
	] as const)("rejects synthetic %s replay inputs absent from the canonical journal", (_name, payload) => {
		expect(() =>
			projectWorkflowGoalEvents(createProjection(), [
				createEvent(1, payload as unknown as WorkflowGoalProjectionEvent["payload"]),
			]),
		).toThrow(/CONTRACT_CHANGE.*canonical.*journal/i);
	});

	it("accepts only independent outcome evidence that covers checks and invariants", () => {
		const projected = applyWorkflowGoalProgress(createProjection(), createProgressObservation());

		expect(projected.progress.entries[0]?.status).toBe("proven");
		expect(projected.provenRequirementIds).toEqual(["requirement-1"]);
		expect(projected.acceptedAcceptanceCheckIds).toEqual(["check-1"]);
		expect(projected.holdingInvariantIds).toEqual(["invariant-1"]);
	});

	it.each([
		["self-report", { independent: false }],
		["metric-only", { metricOnly: true }],
		["proxy-only", { proxyOnly: true }],
		["activity-only", { activityOnly: true }],
		["missing outcome evidence", { outcomeVerified: false }],
		["missing acceptance check", { acceptanceCheckIds: [] }],
		["missing protected invariant", { protectedInvariantIds: [] }],
	])("does not accept %s as goal completion evidence", (_name, overrides) => {
		expect(() => applyWorkflowGoalProgress(createProjection(), createProgressObservation(overrides))).toThrow(
			/independent|evidence|proxy|metric|invariant|acceptance/i,
		);
	});

	it("marks evidence regressed without converting regression into success", () => {
		const proven = applyWorkflowGoalProgress(createProjection(), createProgressObservation());
		const regressed = applyWorkflowGoalProgress(
			proven,
			createProgressObservation({
				regressed: true,
				regressionReason: "workspace changed after verification",
				outcomeVerified: false,
			}),
		);

		expect(regressed.progress.entries[0]?.status).toBe("regressed");
		expect(regressed.provenRequirementIds).toEqual([]);
		expect(regressed.regressedRequirementIds).toEqual(["requirement-1"]);
		expect(regressed.completionEligible).toBe(false);
	});

	it("requires an independently audited durable regression reason", () => {
		const projection = createProjection();

		expect(() =>
			applyWorkflowGoalProgress(
				projection,
				createProgressObservation({ regressed: true, outcomeVerified: false, regressionReason: undefined }),
			),
		).toThrow(/regression.*reason/i);
		expect(() =>
			applyWorkflowGoalProgress(
				projection,
				createProgressObservation({
					regressed: true,
					outcomeVerified: false,
					independent: false,
					regressionReason: "audit",
				}),
			),
		).toThrow(/independent/i);
	});

	it("replays the same events deterministically after restart and ignores an exact retry", () => {
		const events: WorkflowGoalProjectionEvent[] = [
			createEvent(1, {
				kind: "goal_projection_applied",
				goalDelta: createGoalDelta({ tokensUsed: 4, updatedAt: 2 }),
				goalDigest: digestObject(createGoalDelta({ tokensUsed: 4, updatedAt: 2 })),
				binding: { workflowId: "workflow-1", eventSequence: 1, transitionDigest: "transition-1", ...epoch },
			}),
			createEvent(2, {
				kind: "workflow_status_changed",
				status: "paused",
				phase: "adjudicating",
				reason: "approval required",
				goalDelta: createGoalDelta({
					active: false,
					status: "paused",
					tokensUsed: 4,
					lastReason: "approval required",
					updatedAt: 3,
				}),
			}),
		];
		const once = projectWorkflowGoalEvents(createProjection(), events);
		const afterRestart = projectWorkflowGoalEvents(createProjection(), events);
		const retried = projectWorkflowGoalEvents(createProjection(), [...events, events[1]!]);

		expect(afterRestart).toEqual(once);
		expect(retried).toEqual(once);
		expect(afterRestart.sourceJournalSequence).toBe(2);
		expect(afterRestart.sourceJournalDigest).toBe("event-2");
	});

	it("maps workflow statuses to the existing bound GoalState statuses", () => {
		const current = createProjection().goal;

		expect(mapWorkflowStatusToGoalStatus("active", current, "run")).toBe("active");
		expect(mapWorkflowStatusToGoalStatus("awaiting_user", current, "approval")).toBe("paused");
		expect(mapWorkflowStatusToGoalStatus("blocked", current, "blocked")).toBe("paused");
		expect(mapWorkflowStatusToGoalStatus("cancelled", current, "cancelled")).toBe("paused");
		expect(mapWorkflowStatusToGoalStatus("failed", current, "failed")).toBe("error");
		expect(mapWorkflowStatusToGoalStatus("complete", current, "complete")).toBe("complete");
	});

	it("commits the journal event before applying the GoalState projection CAS", async () => {
		const order: string[] = [];
		const authorization = {} as WorkflowGoalProjectionAuthorization;
		let goal: GoalState = {
			active: true,
			status: "active",
			goalId: "goal-1",
			objective: contract.originalObjective,
			tokenBudget: 100,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
			createdAt: 1,
			updatedAt: 1,
			lastReason: "initial",
			lastError: "none",
		};
		const adapter: WorkflowGoalProjectionAdapter = {
			read: () => goal,
			compareAndSwap: (expected, next, receivedAuthorization) => {
				if (expected !== goal) return false;
				expect(receivedAuthorization).toBe(authorization);
				goal = next;
				order.push("goal-cas");
				return true;
			},
		};
		const request: WorkflowGoalTransitionRequest = {
			workflowId: "workflow-1",
			source: "workflow_status",
			expectedGoalDigest: digestObject(adapter.read()),
			payload: {
				kind: "workflow_status_changed",
				status: "paused",
				phase: "adjudicating",
				reason: "fixture",
				goalDelta: {
					goalId: "goal-1",
					objective: contract.originalObjective,
					active: false,
					status: "paused",
					tokenBudget: 100,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					continuationsUsed: 0,
					createdAt: 1,
					updatedAt: 2,
					lastReason: "fixture",
					lastError: null,
				},
			},
			expectedHead: { workflowId: "workflow-1", sequence: 2, eventDigest: "head", epochRef: epoch },
			expectedEpoch: epoch,
			leaseRef,
			idempotencyKey: "goal-transition-1",
			writerIdentity: "writer-1",
			executionKey: null,
		};
		const coordinator = createWorkflowGoalCoordinator({
			adapter,
			append: async (input) => {
				order.push("journal-commit");
				return {
					eventSequence: input.expectedHead.sequence + 1,
					transitionDigest: "digest",
					payload: input.payload,
				};
			},
			readCommitted: async () => null,
			readHead: async () => request.expectedHead,
			authorize: async () => authorization,
		});

		await projectWorkflowGoalTransition(coordinator, request);
		expect(order).toEqual(["journal-commit", "journal-commit", "goal-cas"]);
	});

	it("replays a committed transition after a projection crash with one idempotent bound CAS", async () => {
		const committed = new Map<
			string,
			{ eventSequence: number; transitionDigest: string; payload: WorkflowGoalTransitionRequest["payload"] }
		>();
		const authorizations: WorkflowGoalProjectionAuthorization[] = [];
		const authorization = {} as WorkflowGoalProjectionAuthorization;
		let casAttempts = 0;
		let projectionPayload: WorkflowGoalTransitionRequest["payload"] | null = null;
		let goal: GoalState = {
			active: true,
			status: "active",
			goalId: "goal-1",
			objective: contract.originalObjective,
			tokenBudget: 100,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
			createdAt: 1,
			updatedAt: 1,
			lastReason: "initial",
			lastError: "none",
		};
		const adapter: WorkflowGoalProjectionAdapter = {
			read: () => goal,
			compareAndSwap: (expected, next, receivedAuthorization) => {
				casAttempts += 1;
				if (casAttempts === 1) throw new Error("simulated projection crash");
				if (expected !== goal) return false;
				goal = next;
				authorizations.push(receivedAuthorization);
				return true;
			},
		};
		const request: WorkflowGoalTransitionRequest = {
			workflowId: "workflow-1",
			source: "workflow_status",
			expectedGoalDigest: digestObject(adapter.read()),
			payload: {
				kind: "workflow_status_changed",
				status: "paused",
				phase: "adjudicating",
				reason: "approval required",
				goalDelta: {
					goalId: "goal-1",
					objective: contract.originalObjective,
					active: false,
					status: "paused",
					tokenBudget: 100,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					continuationsUsed: 0,
					createdAt: 1,
					updatedAt: 2,
					lastReason: "approval required",
					lastError: "none",
				},
			},
			expectedHead: { workflowId: "workflow-1", sequence: 2, eventDigest: "head", epochRef: epoch },
			expectedEpoch: epoch,
			leaseRef,
			idempotencyKey: "goal-transition-crash-1",
			writerIdentity: "writer-1",
			executionKey: null,
		};
		const coordinator = createWorkflowGoalCoordinator({
			adapter,
			append: async (input) => {
				const isProjection = input.payload.kind === "goal_projection_applied";
				if (isProjection) projectionPayload = input.payload;
				const key = input.idempotencyKey;
				const event = {
					eventSequence: isProjection ? 4 : 3,
					transitionDigest: isProjection ? "projection-transition-digest" : "transition-digest",
					payload: input.payload,
				};
				committed.set(key, event);
				return event;
			},
			readCommitted: async (_workflowId, idempotencyKey) => committed.get(idempotencyKey) ?? null,
			readHead: async () => request.expectedHead,
			authorize: async () => authorization,
		});

		await expect(projectWorkflowGoalTransition(coordinator, request)).rejects.toThrow(/crash/i);
		const replayed = await projectWorkflowGoalTransition(coordinator, request);

		expect(replayed.status).toBe("paused");
		expect(replayed.tokensUsed).toBe(0);
		expect(casAttempts).toBe(2);
		expect(authorizations).toEqual([authorization]);
		expect(projectionPayload).toMatchObject({
			kind: "goal_projection_applied",
			binding: { workflowId: "workflow-1", eventSequence: 4 },
		});
	});
});
