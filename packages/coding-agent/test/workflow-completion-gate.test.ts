import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import type { WorkflowApprovalManager } from "../src/core/workflow/approvals.js";
import {
	createWorkflowCompletionGate,
	createWorkflowCompletionGateForStore,
	type WorkflowCompletionCapacityReceiptBindingInput,
	type WorkflowCompletionDigestSources,
	type WorkflowCompletionGate,
	type WorkflowCompletionGateDependencies,
	workflowCompletionAdjudicationReceiptBindingDigest,
	workflowCompletionCapacityReceiptBindingDigest,
	workflowCompletionDecisionAdjudicationBindingDigest,
	workflowCompletionReadinessReceiptBindingDigest,
	workflowCompletionUsageReceiptBindingDigest,
} from "../src/core/workflow/completion-gate.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceiptConsumerContext,
	type DurableApprovalSecretProof,
	digestObject,
	type WorkflowApprovalRequest,
	type WorkflowApprovalResponse,
	type WorkflowArtifactRef,
	type WorkflowCanonicalPoolLedger,
	type WorkflowCompletionCapacityReconciliation,
	type WorkflowCompletionReadinessReceipt,
	type WorkflowCompletionUsageReconciliation,
	type WorkflowControlCapacityVector,
	type WorkflowDecisionRecord,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowEventPayload,
	type WorkflowLeaseRef,
	type WorkflowPhaseOutcomeRecord,
	type WorkflowResourceGrantLedger,
	type WorkflowResourceVector,
} from "../src/core/workflow/contracts.js";
import type { WorkflowPhaseHostContext, WorkflowStorePort } from "../src/core/workflow/phase-host.js";
import { createProviderFreeWorkflowPhaseHost } from "../src/core/workflow/phase-host.js";
import type { WorkflowCommitPrecondition, WorkflowState } from "../src/core/workflow/reducer.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedWorkflowCompletionReadinessAuthorityFactory,
} from "../src/core/workflow/session-host-factory.js";

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

describe("workflow completion gate at the phase-host boundary", () => {
	it("keeps an unapproved persisted workflow awaiting proof across reopen", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-completion-gate-"));
		const goalProjection = createGoalProjection();
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "session-completion-gate",
				workflowId: "workflow-completion-gate",
				goalProjection,
				genesisEpoch: EPOCH,
			});
			await host.execute({
				kind: "start",
				request: {
					workflowId: "workflow-completion-gate",
					objective: "prove completion is host-authorized",
					acceptanceChecks: ["ready-receipt"],
					protectedInvariants: ["no-worker-complete"],
				},
			});
			const pending = await host.execute({ kind: "status" });
			expect(pending.status).toBe("awaiting_user");
			const goalBeforeInvalidProof = goalProjection.read();
			if (pending.stateDigest === null)
				throw new Error("awaiting-user workflow did not expose its durable head digest");
			await expect(host.runOutcome(createCompleteOutcomeForWorkflow(pending.stateDigest))).rejects.toThrow(
				/receipt|active|completion|readiness/i,
			);
			await expect(host.execute({ kind: "resume", note: "approve the exact workflow proposal" })).rejects.toThrow(
				/structured|one-use|approval/i,
			);
			expect((await host.execute({ kind: "status" })).status).toBe("awaiting_user");
			expect(goalProjection.read()).toEqual(goalBeforeInvalidProof);
			await host.dispose?.();
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "session-completion-gate",
				workflowId: "workflow-completion-gate",
				goalProjection,
				genesisEpoch: EPOCH,
			});
			expect((await host.execute({ kind: "status" })).status).toBe("awaiting_user");
		} finally {
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("consumes the host-issued approval proof once across restart", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-completion-gate-approved-"));
		const goalProjection = createGoalProjection("prove approval survives restart");
		let proof: DurableApprovalSecretProof | undefined;
		let approvalRequestId: string | undefined;
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			const approvalSecretDelivery = ({
				request,
				proof: issuedProof,
			}: {
				readonly request: { approvalRequestId: string };
				readonly proof: DurableApprovalSecretProof;
			}) => {
				approvalRequestId = request.approvalRequestId;
				proof = issuedProof;
			};
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "session-completion-gate-approved",
				workflowId: "workflow-completion-gate-approved",
				goalProjection,
				genesisEpoch: EPOCH,
				approvalSecretDelivery,
			});
			await host.execute({
				kind: "start",
				request: {
					workflowId: "workflow-completion-gate-approved",
					objective: "prove approval survives restart",
					acceptanceChecks: ["restart-approval"],
					protectedInvariants: ["one-use-proof"],
				},
			});
			if (approvalRequestId === undefined || proof === undefined)
				throw new Error("The persisted host did not deliver a structured approval proof.");
			await host.dispose?.();
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "session-completion-gate-approved",
				workflowId: "workflow-completion-gate-approved",
				goalProjection,
				genesisEpoch: EPOCH,
				approvalSecretDelivery,
			});
			expect((await host.execute({ kind: "status" })).status).toBe("awaiting_user");
			await expect(
				host.execute({ kind: "respond", approvalRequestId, optionId: "approve", proof }),
			).resolves.toMatchObject({ status: "active", phase: "planning" });
			const committed = await host.runtimeStore.replay({
				workflowId: "workflow-completion-gate-approved",
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			const goalAfterApproval = goalProjection.read();
			await expect(host.execute({ kind: "respond", approvalRequestId, optionId: "approve", proof })).rejects.toThrow(
				/pending|consumed|approval|structured/i,
			);
			const replayed = await host.runtimeStore.replay({
				workflowId: "workflow-completion-gate-approved",
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			expect(replayed.head).toEqual(committed.head);
			expect(goalProjection.read()).toEqual(goalAfterApproval);
		} finally {
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("does not consume an approval invalidated by the same persisted authority race", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-completion-gate-approval-race-"));
		const workflowId = "workflow-completion-gate-approval-race";
		const rootSessionId = "session-completion-gate-approval-race";
		let proof: DurableApprovalSecretProof | undefined;
		let approvalRequestId: string | undefined;
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: createGoalProjection("persisted approval race"),
				genesisEpoch: EPOCH,
				approvalSecretDelivery: ({ request, proof: issuedProof }) => {
					approvalRequestId = request.approvalRequestId;
					proof = issuedProof;
				},
			});
			await host.execute({
				kind: "start",
				request: { workflowId, objective: "persisted approval race", acceptanceChecks: ["race"] },
			});
			if (approvalRequestId === undefined || proof === undefined)
				throw new Error("The persisted approval race host did not deliver proof.");
			const approvals = host.approvals;
			const request = await approvals.pending(workflowId);
			if (request === null) throw new Error("The persisted approval race request is no longer pending.");
			const response: WorkflowApprovalResponse = {
				approvalRequestId: request.approvalRequestId,
				decisionRef: request.decisionRef,
				decisionRefs: request.decisionRefs.map((ref) => ({
					...ref,
					decisionScope: { kind: "workflow" as const, workflowId, rootSessionId },
					coordinatorEpoch: request.coordinatorEpoch,
				})),
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
				optionId: "approve",
				mode: "interactive_secret",
				secretProof: proof,
			};
			const consumptionPromise = approvals.consumeInteractive(response);
			const invalidationPromise = approvals.invalidate(approvalRequestId, "race invalidation");
			const race = await Promise.allSettled([consumptionPromise, invalidationPromise]);
			const consumption = race[0];
			const invalidation = race[1];
			expect(invalidation.status).toBe("fulfilled");
			if (invalidation.status !== "fulfilled") throw new Error("Approval invalidation did not complete.");
			expect(invalidation.value.status).toBe("invalidated");
			expect(consumption.status).toBe("rejected");
			expect((await host.execute({ kind: "status" })).status).toBe("awaiting_user");
			const replay = await host.runtimeStore.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			expect(replay.events.some((event) => event.payload.kind === "approval_consumed")).toBe(false);
		} finally {
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("commits a supported persisted completion once across a race and restart", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-completion-gate-success-"));
		const workflowId = "workflow-completion-gate-success";
		const rootSessionId = "session-completion-gate-success";
		const goalProjection = createGoalProjection("persisted completion path");
		const completionReadinessAuthorityFactory = createPersistedCompletionAuthorityFactory();
		let proof: DurableApprovalSecretProof | undefined;
		let approvalRequestId: string | undefined;
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection,
				genesisEpoch: EPOCH,
				completionReadinessAuthorityFactory,
				approvalSecretDelivery: ({ request, proof: issuedProof }) => {
					approvalRequestId = request.approvalRequestId;
					proof = issuedProof;
				},
			});
			await host.execute({
				kind: "start",
				request: {
					workflowId,
					objective: "persisted completion path",
					acceptanceChecks: ["completion-ready"],
					protectedInvariants: ["host-only-complete"],
				},
			});
			if (approvalRequestId === undefined || proof === undefined)
				throw new Error("The persisted completion host did not deliver approval proof.");
			await host.execute({ kind: "respond", approvalRequestId, optionId: "approve", proof });
			const active = await host.execute({ kind: "status" });
			if (active.stateDigest === null) throw new Error("The active workflow did not expose its durable head.");
			const outcome = createPersistedCompleteOutcome(workflowId, active.stateDigest);
			const forgedOutcome: WorkflowPhaseOutcomeRecord = {
				attemptStatus: outcome.attemptStatus,
				outcome: {
					workflowId,
					phaseAttemptId: outcome.outcome.phaseAttemptId,
					epochRef: outcome.outcome.epochRef,
					invocationToken: outcome.outcome.invocationToken,
					inputStateDigest: active.stateDigest,
					status: "complete",
					outputStateDigest: digestObject("forged-output"),
					artifactRefs: [],
					evidenceRefs: [],
				},
			};
			await expect(host.runOutcome(forgedOutcome)).rejects.toThrow(/readiness|outcome|current|digest|canonical/i);
			await expect(
				host.runOutcome(createPersistedCompleteOutcome(workflowId, digestObject("stale-head"))),
			).rejects.toThrow(/stale|current|bound/i);
			const race = await Promise.allSettled([host.runOutcome(outcome), host.runOutcome(outcome)]);
			expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
			expect((await host.execute({ kind: "status" })).status).toBe("complete");
			const committed = await host.runtimeStore.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			expect(
				committed.events.filter(
					(event) => event.payload.kind === "workflow_status_changed" && event.payload.status === "complete",
				),
			).toHaveLength(1);
			const completedGoal = goalProjection.read();
			expect(completedGoal.status).toBe("complete");
			await host.dispose?.();
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection,
				genesisEpoch: EPOCH,
				completionReadinessAuthorityFactory,
			});
			expect((await host.execute({ kind: "status" })).status).toBe("complete");
			await expect(host.runOutcome(outcome)).rejects.toThrow(/stale|complete|active|completion/i);
			const afterReplay = await host.runtimeStore.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			expect(afterReplay.head).toEqual(committed.head);
			expect(goalProjection.read()).toEqual(completedGoal);
		} finally {
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	}, 60_000);

	it("rejects a persisted completion receipt carrying a self-supplied weak adjudication binding", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-completion-gate-weak-binding-"));
		const workflowId = "workflow-completion-gate-weak-binding";
		const rootSessionId = "session-completion-gate-weak-binding";
		const goalProjection = createGoalProjection("weak adjudication binding");
		const completionReadinessAuthorityFactory = createPersistedCompletionAuthorityFactory({
			weakDecisionAdjudicationBinding: true,
		});
		let proof: DurableApprovalSecretProof | undefined;
		let approvalRequestId: string | undefined;
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection,
				genesisEpoch: EPOCH,
				completionReadinessAuthorityFactory,
				approvalSecretDelivery: ({ request, proof: issuedProof }) => {
					approvalRequestId = request.approvalRequestId;
					proof = issuedProof;
				},
			});
			await host.execute({
				kind: "start",
				request: { workflowId, objective: "weak adjudication binding", acceptanceChecks: ["binding"] },
			});
			if (approvalRequestId === undefined || proof === undefined)
				throw new Error("The weak-binding host did not deliver approval proof.");
			await host.execute({ kind: "respond", approvalRequestId, optionId: "approve", proof });
			const active = await host.execute({ kind: "status" });
			if (active.stateDigest === null) throw new Error("The weak-binding workflow did not expose its durable head.");
			await expect(host.runOutcome(createPersistedCompleteOutcome(workflowId, active.stateDigest))).rejects.toThrow(
				/binding|receipt|adjudication|canonical/i,
			);
			expect((await host.execute({ kind: "status" })).status).toBe("active");
			expect(goalProjection.read().status).toBe("active");
			const replay = await host.runtimeStore.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			expect(
				replay.events.some(
					(event) => event.payload.kind === "workflow_status_changed" && event.payload.status === "complete",
				),
			).toBe(false);
		} finally {
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("recovers a persisted completion intent after projection failure", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-completion-gate-recovery-"));
		const workflowId = "workflow-completion-gate-recovery";
		const rootSessionId = "session-completion-gate-recovery";
		const goalProjection = createFailingCompleteGoalProjection("recover completion intent");
		const completionReadinessAuthorityFactory = createPersistedCompletionAuthorityFactory();
		let proof: DurableApprovalSecretProof | undefined;
		let approvalRequestId: string | undefined;
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection,
				genesisEpoch: EPOCH,
				completionReadinessAuthorityFactory,
				approvalSecretDelivery: ({ request, proof: issuedProof }) => {
					approvalRequestId = request.approvalRequestId;
					proof = issuedProof;
				},
			});
			await host.execute({
				kind: "start",
				request: { workflowId, objective: "recover completion intent", acceptanceChecks: ["recovery"] },
			});
			if (approvalRequestId === undefined || proof === undefined)
				throw new Error("The persisted recovery host did not deliver approval proof.");
			await host.execute({ kind: "respond", approvalRequestId, optionId: "approve", proof });
			const active = await host.execute({ kind: "status" });
			if (active.stateDigest === null) throw new Error("The recovery workflow did not expose its durable head.");
			const outcome = createPersistedCompleteOutcome(workflowId, active.stateDigest);
			await expect(host.runOutcome(outcome)).rejects.toThrow(/projection|simulated/i);
			await host.dispose?.();
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection,
				genesisEpoch: EPOCH,
				completionReadinessAuthorityFactory,
			});
			expect((await host.execute({ kind: "status" })).status).toBe("complete");
			expect(goalProjection.read().status).toBe("complete");
			const replay = await host.runtimeStore.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			expect(
				replay.events.filter(
					(event) => event.payload.kind === "workflow_status_changed" && event.payload.status === "complete",
				),
			).toHaveLength(1);
		} finally {
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("rejects a structural no-op gate bypass before any durable mutation", async () => {
		const harness = createHarness();
		const completionGate = { verify: async () => undefined } as unknown as WorkflowCompletionGate;
		const services = { ...harness.context.services, completionGate };
		const host = await createProviderFreeWorkflowPhaseHost({
			persistSession: true,
			context: { ...harness.context, services },
		});
		await expect(
			host.runOutcome(createCompleteOutcome(harness.store.state?.sourceJournalDigest ?? "")),
		).rejects.toThrow(/sealed|host-owned|gate/i);
		expect(harness.store.events).toHaveLength(0);
	});

	it("rejects a raw persisted runtime-store complete status without the opaque host capability", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-completion-gate-raw-runtime-"));
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "session-completion-gate-raw-runtime",
				workflowId: "workflow-completion-gate-raw-runtime",
				goalProjection: createGoalProjection("raw runtime complete"),
				genesisEpoch: EPOCH,
			});
			const replay = await host.runtimeStore.replay({
				workflowId: "workflow-completion-gate-raw-runtime",
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			const leaseRef = host.runtimeStore.durableContext?.currentLeaseRef();
			if (leaseRef === undefined) throw new Error("The persisted host did not expose its authenticated lease.");
			const payload = {
				kind: "workflow_status_changed" as const,
				status: "complete" as const,
				phase: "auditing_completion" as const,
				reason: "raw runtime bypass",
				goalDelta: {
					goalId: "goal-raw-runtime",
					objective: "raw runtime complete",
					active: false,
					status: "complete" as const,
					tokenBudget: null,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					continuationsUsed: 0,
					createdAt: null,
					updatedAt: null,
					lastReason: "raw runtime bypass",
					lastError: null,
				},
			};
			const baselineDigest = digestObject(replay.head);
			const commitInput = {
				workflowId: "workflow-completion-gate-raw-runtime",
				payload,
				expectedHead: replay.head,
				epochRef: replay.head.epochRef,
				leaseRef,
				idempotencyKey: "raw-runtime-complete",
				writerIdentity: leaseRef.writerIdentity,
				executionKey: null,
				semanticBinding: {
					mutationId: "raw-runtime-complete",
					baselineDigest,
					expectedGenerations: { workflow: replay.head.epochRef.storeEpoch },
					ownerId: "raw-runtime",
					phase: "auditing_completion" as const,
					reducerDigest: digestObject(payload),
					semanticHead: {
						workflowId: replay.head.workflowId,
						sequence: replay.head.sequence,
						eventDigest: replay.head.eventDigest,
						stateDigest: baselineDigest,
						epochRef: replay.head.epochRef,
						generation: replay.head.epochRef.storeEpoch,
					},
					expectedHead: replay.head,
					idempotencyKey: "raw-runtime-complete",
					executionKey: null,
					writerIdentity: leaseRef.writerIdentity,
					leaseRef,
					epochRef: replay.head.epochRef,
				},
			} satisfies Parameters<typeof host.runtimeStore.commit>[0];
			await expect(host.runtimeStore.commit(commitInput)).rejects.toThrow(
				/opaque|completion|host capability|phase host/i,
			);
		} finally {
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("rejects an exported no-op completion gate that is not bound to this exact store", async () => {
		const harness = createHarness();
		const dependencies: WorkflowCompletionGateDependencies = {
			resolveCurrentState: async () => harness.store.state,
			resolveCurrentEpoch: () => EPOCH,
			resolveReadiness: async () => {
				throw new Error("no-op readiness resolver");
			},
			resolveDigestSources: async () => {
				throw new Error("no-op digest resolver");
			},
			resolveArtifact: {
				resolve: async (_ref: WorkflowArtifactRef) => {
					throw new Error("no-op artifact resolver");
				},
			},
			resolveDecision: async () => {
				throw new Error("no-op decision resolver");
			},
			validateDecision: async () => undefined,
			validateEvidence: async () => undefined,
			validateScorecard: async () => undefined,
			validateProgress: async () => undefined,
			validateResources: async () => undefined,
			receiptContext: createFixtureHostReceiptConsumerContext(),
			trustedNow: () => "2026-08-15T00:00:00.000Z",
			commitCompletion: async () => {
				if (harness.store.state === null) throw new Error("no-op completion state is unavailable");
				return harness.store.state;
			},
		};
		const gate = createWorkflowCompletionGate(dependencies);
		expect(Object.isFrozen(gate)).toBe(true);
		expect(() => createWorkflowCompletionGateForStore(harness.store, dependencies)).toThrow(
			/WorkflowStore|persisted/i,
		);
		const host = await createProviderFreeWorkflowPhaseHost({
			persistSession: true,
			context: { ...harness.context, services: { ...harness.context.services, completionGate: gate } },
		});
		await expect(
			host.runOutcome(createCompleteOutcome(harness.store.state?.sourceJournalDigest ?? "")),
		).rejects.toThrow(/bound|authenticated|host-owned|opaque/i);
		expect(harness.store.events).toHaveLength(0);
	});

	it("rejects a non-branded approval manager that only reports awaiting_user without a durable approval event", async () => {
		const store = new FreshMemoryStore();
		let goal: GoalState = emptyGoalState();
		const goalProjection = {
			read: () => structuredClone(goal),
			compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
				if (digestObject(goal) !== digestObject(expected)) return false;
				goal = structuredClone(next);
				return true;
			},
		};
		const acceptance = new Map<
			string,
			{ acceptanceCheckIds: readonly string[]; protectedInvariantIds: readonly string[] }
		>();
		const fakeRequest = {} as WorkflowApprovalRequest;
		const approvals: WorkflowApprovalManager = {
			createRequest: async () => {
				if (store.state === null) throw new Error("fake approval manager requires a workflow state");
				store.state = {
					...store.state,
					status: "awaiting_user",
					phase: "adjudicating",
					approvalRequest: fakeRequest,
				};
				return fakeRequest;
			},
			pending: async () => fakeRequest,
			consumeInteractive: async () => {
				throw new Error("fake approval manager must not consume");
			},
			consumeSignedHeadless: async () => {
				throw new Error("fake approval manager must not consume");
			},
			reopen: async () => approvals,
		};
		const context: WorkflowPhaseHostContext = {
			workflowId: "workflow-1",
			rootSessionId: "session-1",
			store,
			goalProjection,
			services: {
				store,
				journal: { currentLeaseRef: () => ({ ...LEASE }) },
				currentEpoch: () => ({ ...EPOCH }),
				approvals,
				acceptance: {
					read: (workflowId) => acceptance.get(workflowId) ?? null,
					write: (workflowId, state) => acceptance.set(workflowId, state),
				},
				goal: {
					read: () => structuredClone(goal),
					transition: async (request) => {
						if (request.payload.kind === "goal_binding_committed") {
							goal = {
								...goal,
								goalId: request.payload.goalId,
								objective: request.payload.objective,
								active: true,
								status: "active",
							};
						}
						await store.commit(request.payload, {} as WorkflowCommitPrecondition);
						return structuredClone(goal);
					},
					accountAssistantUsage: async () => structuredClone(goal),
					accountContinuation: async () => structuredClone(goal),
				},
			},
		};
		const host = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context });
		await expect(
			host.execute({
				kind: "start",
				request: { workflowId: "workflow-1", objective: "fake approval bypass", acceptanceChecks: ["durable"] },
			}),
		).rejects.toThrow(/branded|durable|approval_requested/i);
		expect(store.events.some((event) => event.kind === "approval_requested")).toBe(false);
	});
});

function createGoalProjection(objective = "prove completion is host-authorized"): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	let goal: GoalState = {
		...emptyGoalState(),
		goalId: "goal-workflow-completion-gate",
		objective,
		active: true,
		status: "active",
	};
	return {
		read: () => structuredClone(goal),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
}

function createFailingCompleteGoalProjection(objective: string): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	let failComplete = true;
	let goal: GoalState = {
		...emptyGoalState(),
		goalId: "goal-workflow-completion-recovery",
		objective,
		active: true,
		status: "active",
	};
	return {
		read: () => structuredClone(goal),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			if (failComplete && next.status === "complete") {
				failComplete = false;
				throw new Error("simulated projection crash after completion journal commit");
			}
			goal = structuredClone(next);
			return true;
		},
	};
}

function createCompleteOutcome(inputStateDigest: string): WorkflowPhaseOutcomeRecord {
	return createCompleteOutcomeForWorkflow(inputStateDigest, "workflow-1");
}

function createCompleteOutcomeForWorkflow(
	inputStateDigest: string,
	workflowId = "workflow-completion-gate",
): WorkflowPhaseOutcomeRecord {
	return {
		attemptStatus: "completed",
		outcome: {
			workflowId,
			phaseAttemptId: "attempt-1",
			epochRef: EPOCH,
			invocationToken: "token-1",
			inputStateDigest,
			status: "complete",
			outputStateDigest: digestObject("output-state"),
			artifactRefs: [],
			evidenceRefs: [],
		},
	};
}

function createPersistedCompleteOutcome(workflowId: string, inputStateDigest: string): WorkflowPhaseOutcomeRecord {
	return {
		attemptStatus: "completed",
		outcome: {
			workflowId,
			phaseAttemptId: "persisted-completion-attempt",
			epochRef: EPOCH,
			invocationToken: "persisted-completion-invocation",
			inputStateDigest,
			status: "complete",
			outputStateDigest: digestObject("persisted-completion-output"),
			artifactRefs: [],
			evidenceRefs: [],
		},
	};
}

interface PersistedCompletionEvaluation {
	readiness: WorkflowCompletionReadinessReceipt;
	digestSources: WorkflowCompletionDigestSources;
	decisions: ReadonlyMap<string, WorkflowDecisionRecord>;
}

function createPersistedCompletionAuthorityFactory(
	options: { weakDecisionAdjudicationBinding?: boolean } = {},
): PersistedWorkflowCompletionReadinessAuthorityFactory {
	return (input) => {
		let evaluation: Promise<PersistedCompletionEvaluation> | undefined;
		const ensureEvaluation = async (
			request: Parameters<NonNullable<WorkflowCompletionGateDependencies["resolveReadiness"]>>[0],
		): Promise<PersistedCompletionEvaluation> => {
			if (
				request.outcome.outcome.status !== "complete" ||
				request.outcome.outcome.outputStateDigest !== digestObject("persisted-completion-output")
			)
				throw new Error("persisted completion evaluator rejected a non-canonical output");
			evaluation ??= buildPersistedCompletionEvaluation(
				input,
				request,
				options.weakDecisionAdjudicationBinding === true,
			);
			return evaluation;
		};
		const assertCanonicalValidation = async (
			request: Parameters<NonNullable<WorkflowCompletionGateDependencies["validateEvidence"]>>[0],
		): Promise<void> => {
			const resolved = await ensureEvaluation({
				workflowId: request.workflowId,
				inputStateDigest: request.currentState.sourceJournalDigest,
				epochRef: request.currentEpoch,
				outcome: request.outcome,
				currentState: request.currentState,
			});
			if (
				request.readiness.receiptDigest !== resolved.readiness.receiptDigest ||
				request.readiness.capacityLedgerDigest !== resolved.readiness.capacityLedgerDigest
			)
				throw new Error("persisted completion evaluator observed a changed canonical closure");
		};
		return {
			runtimeStore: input.runtimeStore,
			authority: {
				resolveReadiness: async (request) => (await ensureEvaluation(request)).readiness,
				resolveDigestSources: async (request) =>
					(
						await ensureEvaluation({
							workflowId: request.workflowId,
							inputStateDigest: request.inputStateDigest,
							epochRef: request.epochRef,
							outcome: request.outcome,
							currentState: request.currentState,
						})
					).digestSources,
				resolveDecision: async (request) => {
					if (evaluation === undefined)
						throw new Error("persisted completion decision requested before readiness");
					const resolved = await evaluation;
					const decision = resolved.decisions.get(request.decisionRef.decisionId);
					if (decision === undefined || digestObject(decision) !== request.decisionRef.decisionDigest)
						throw new Error("persisted completion evaluator returned a foreign decision");
					return decision;
				},
				validateDecision: async (decision) => {
					if (decision.kind !== "completion" || decision.disposition !== "authorized")
						throw new Error("persisted completion evaluator rejected the decision");
				},
				validateEvidence: assertCanonicalValidation,
				validateScorecard: assertCanonicalValidation,
				validateProgress: assertCanonicalValidation,
				validateResources: assertCanonicalValidation,
			},
		};
	};
}

async function buildPersistedCompletionEvaluation(
	input: Parameters<PersistedWorkflowCompletionReadinessAuthorityFactory>[0],
	request: Parameters<NonNullable<WorkflowCompletionGateDependencies["resolveReadiness"]>>[0],
	weakDecisionAdjudicationBinding: boolean,
): Promise<PersistedCompletionEvaluation> {
	const state = request.currentState;
	const outputStateDigest =
		request.outcome.outcome.status === "complete" ? request.outcome.outcome.outputStateDigest : "";
	const publish = async (value: unknown, idempotencyKey: string): Promise<WorkflowArtifactRef> => {
		const bytes = new TextEncoder().encode(JSON.stringify(value));
		const canonical = canonicalJsonBytes(value);
		if (bytes.byteLength === 0) throw new Error("completion fixture produced empty artifact bytes");
		const result = await input.runtimeStore.publishArtifact({
			workflowId: state.workflowId,
			payloadKind: "evidence",
			bytes: canonical,
			codec: "canonical_json",
			sourceEventSequence: state.sourceJournalSequence,
			idempotencyKey,
		});
		return result.envelope.ref;
	};
	const zeroResource = (): WorkflowResourceVector => ({
		cpuMilliCores: 0,
		memoryBytes: 0,
		diskBytes: 0,
		ioWeight: 0,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 0,
		monetaryMicrounits: 0,
	});
	const zeroControl = (): WorkflowControlCapacityVector => ({
		processSlots: 0,
		childSessionSlots: 0,
		modelCallSlots: 0,
		modelInputTokens: 0,
		modelOutputTokens: 0,
		verificationSlots: 0,
		redTeamSlots: 0,
		recoverySlots: 0,
	});
	const resourceTotal = zeroResource();
	const controlTotal = zeroControl();
	const approvedEnvelopeDigest = state.resourceEnvelopeDigest ?? digestObject("completion-approved-envelope");
	const capacityCasDigest = digestObject({
		kind: "completion-capacity-cas",
		workflowId: state.workflowId,
		stateDigest: state.sourceJournalDigest,
		approvedEnvelopeDigest,
	});
	const canonicalLedgerRef = await publish(
		{
			kind: "completion-canonical-capacity-ledger",
			workflowId: state.workflowId,
			stateDigest: state.sourceJournalDigest,
			epochRef: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
			approvedEnvelopeDigest,
			capacityCasDigest,
		},
		`completion-canonical-ledger-${state.sourceJournalDigest}`,
	);
	const componentPoolAssignment = {
		workflowId: state.workflowId,
		epochRef: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
		approvedEnvelopeDigest,
		capacityCasDigest,
		resourceComponentPools: {
			cpuMilliCores: "item_pool",
			memoryBytes: "item_pool",
			diskBytes: "item_pool",
			ioWeight: "item_pool",
			accelerators: "item_pool",
			providers: "item_pool",
			acceleratorCount: "item_pool",
			acceleratorMemoryBytes: "item_pool",
			providerConcurrentRequests: "item_pool",
			providerRequestsPerMinute: "item_pool",
			providerTotalRequests: "item_pool",
			providerInputTokens: "item_pool",
			providerOutputTokens: "item_pool",
			networkEgressBytes: "item_pool",
			wallMilliseconds: "item_pool",
			monetaryMicrounits: "item_pool",
		},
		controlComponentPools: {
			processSlots: "item_pool",
			childSessionSlots: "item_pool",
			modelCallSlots: "item_pool",
			modelInputTokens: "item_pool",
			modelOutputTokens: "item_pool",
			verificationSlots: "item_pool",
			redTeamSlots: "item_pool",
			recoverySlots: "item_pool",
		},
		spendPoolId: "item_pool",
		assignmentDigest: digestObject({ workflowId: state.workflowId, approvedEnvelopeDigest, capacityCasDigest }),
	};
	const canonicalPoolLedger: WorkflowCanonicalPoolLedger = {
		ledgerId: `completion-ledger-${state.workflowId}`,
		ledgerEpoch: state.coordinatorEpoch,
		instantaneousPools: [],
		cumulativeSpendPools: [],
		instantaneousComponentLedgers: [],
		cumulativeComponentLedgers: [],
		accountedResourceComponents: [
			"cpuMilliCores",
			"memoryBytes",
			"diskBytes",
			"ioWeight",
			"accelerators",
			"providers",
			"networkEgressBytes",
			"wallMilliseconds",
			"monetaryMicrounits",
		],
		accountedControlComponents: [
			"processSlots",
			"childSessionSlots",
			"modelCallSlots",
			"modelInputTokens",
			"modelOutputTokens",
			"verificationSlots",
			"redTeamSlots",
			"recoverySlots",
		],
		exhaustiveComponentAccounting: true,
		reserveRepresentation: "canonical_ledger_only",
		componentPoolAssignment,
		ledgerDigest: digestObject({ kind: "completion-canonical-ledger", stateDigest: state.sourceJournalDigest }),
		workflowId: state.workflowId,
		revision: state.sourceJournalSequence,
		epoch: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
		approvedPools: {},
		activePools: {},
		remainingPools: {},
		instantaneousByPool: {},
		cumulativeByPool: {},
		reservedByPool: {},
		releasedByPool: {},
		instantaneousSpend: { totalMicrounits: 0, byPool: {} },
		cumulativeSpend: { totalMicrounits: 0, byPool: {} },
		instantaneousSpendByPool: {},
		cumulativeSpendByPool: {},
		exhaustiveResourceComponents: resourceTotal,
		exhaustiveControlDimensions: controlTotal,
		approvedEnvelopeDigest,
		envelopeCapacityCasDigest: capacityCasDigest,
		providerPoolIds: [],
		acceleratorPoolIds: [],
		artifactRef: canonicalLedgerRef,
		digest: digestObject({ kind: "completion-canonical-pool-ledger", stateDigest: state.sourceJournalDigest }),
	};
	const grantLedger: WorkflowResourceGrantLedger = {
		workflowId: state.workflowId,
		revision: state.sourceJournalSequence,
		entries: [],
		resourceTotal,
		spendTotalMicrounits: 0,
		headDigest: state.sourceJournalDigest,
		canonicalLedgerRef,
		canonicalLedgerDigest: canonicalLedgerRef.digest,
		workerTotal: controlTotal,
		controlTotal,
		instantaneousByPool: {},
		cumulativeByPool: {},
		instantaneousSpendByPool: {},
		cumulativeSpendByPool: {},
		instantaneousWorkerCapacity: controlTotal,
		instantaneousControlCapacity: controlTotal,
		cumulativeWorkerCapacity: controlTotal,
		cumulativeControlCapacity: controlTotal,
		canonicalPoolLedger,
		approvedEnvelopeDigest,
		envelopeCapacityCasDigest: capacityCasDigest,
	};
	const grantLedgerRef = await publish(grantLedger, `completion-grant-ledger-${state.sourceJournalDigest}`);
	const goalBudgetDigest = digestObject({ workflowId: state.workflowId, tokenBudget: state.goalTokenBudget });
	const usageBinding = workflowCompletionUsageReceiptBindingDigest({
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outputStateDigest,
		resourceUsage: resourceTotal,
		controlUsage: controlTotal,
		spendMicrounits: 0,
		grantLedgerRef,
		grantLedgerDigest: canonicalLedgerRef.digest,
		approvedEnvelopeDigest,
		goalBudgetDigest,
	});
	const capacityBindingInput: WorkflowCompletionCapacityReceiptBindingInput = {
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outputStateDigest,
		capacityVector: resourceTotal,
		controlCapacity: controlTotal,
		canonicalLedgerRef,
		canonicalLedgerDigest: canonicalLedgerRef.digest,
		approvedEnvelopeDigest,
		capacityCasDigest,
	};
	const usageReceipt = await input.issueReceipt({
		receiptKind: "usage",
		workflowId: state.workflowId,
		bindingDigest: usageBinding,
		oneUse: true,
		stateDigest: state.sourceJournalDigest,
		revision: state.sourceJournalSequence,
	});
	const capacityReceipt = await input.issueReceipt({
		receiptKind: "artifact",
		workflowId: state.workflowId,
		bindingDigest: workflowCompletionCapacityReceiptBindingDigest(capacityBindingInput),
		oneUse: true,
		stateDigest: state.sourceJournalDigest,
		revision: state.sourceJournalSequence,
	});
	const usageBase: WorkflowCompletionUsageReconciliation = {
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outputStateDigest,
		resourceUsage: resourceTotal,
		controlUsage: controlTotal,
		spendMicrounits: 0,
		grantLedgerRef,
		grantLedgerDigest: canonicalLedgerRef.digest,
		approvedEnvelopeDigest,
		goalBudgetDigest,
		hostReceipt: usageReceipt,
		reconciliationDigest: "",
	};
	usageBase.reconciliationDigest = digestObject(usageBase);
	const capacityBase: WorkflowCompletionCapacityReconciliation = {
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outputStateDigest,
		capacityVector: resourceTotal,
		controlCapacity: controlTotal,
		canonicalLedgerRef,
		canonicalLedgerDigest: canonicalLedgerRef.digest,
		approvedEnvelopeDigest,
		capacityCasDigest,
		hostReceipt: capacityReceipt,
		reconciliationDigest: "",
	};
	capacityBase.reconciliationDigest = digestObject(capacityBase);
	const usageReconciliationRef = await publish(
		usageBase,
		`completion-usage-reconciliation-${state.sourceJournalDigest}`,
	);
	const capacityReconciliationRef = await publish(
		capacityBase,
		`completion-capacity-reconciliation-${state.sourceJournalDigest}`,
	);
	const makeDecision = async (
		role: "verifier" | "red-team",
	): Promise<{ decision: WorkflowDecisionRecord; ref: WorkflowDecisionRef }> => {
		const decisionId = `completion-${role}-${state.sourceJournalDigest.slice(0, 16)}`;
		const stagePlan = {
			stages: ["recon", "lens", "lens", "verification", "synthesis", "red_team"] as const,
			lensRoles: [null, "primary", "secondary", null, null, null] as const,
			charterDigests: ["recon", "lens-primary", "lens-secondary", "verification", "synthesis", "red-team"].map(
				(value) => digestObject({ decisionId, value }),
			) as [string, string, string, string, string, string],
			planDigest: digestObject({ kind: "completion-stage-plan", decisionId }),
		};
		const targetDigest = digestObject({ workflowId: state.workflowId, role });
		const effectDigest = digestObject({ kind: "completion", role });
		const preconditionDigest = digestObject({ stateDigest: state.sourceJournalDigest });
		const attemptToken = `${decisionId}:attempt`;
		const nonce = `${decisionId}:nonce`;
		const executionKey = `${decisionId}:execution-key`;
		const proposerSessionId = `${decisionId}:proposer`;
		const lensSessionIds = [`${decisionId}:session:1`, `${decisionId}:session:2`];
		const verifierSessionId = `${decisionId}:session:3`;
		const synthesizerSessionId = `${decisionId}:session:4`;
		const redTeamSessionId = `${decisionId}:session:5`;
		const hostSessionId = `${decisionId}:host-session`;
		const hostExecutionIdentity = `${decisionId}:host-execution`;
		const operationDigest = digestObject({ kind: "completion-adjudication", decisionId });
		const decisionBinding = weakDecisionAdjudicationBinding
			? digestObject({ kind: "weak-completion-decision", decisionId })
			: workflowCompletionDecisionAdjudicationBindingDigest({
					workflowId: state.workflowId,
					rootSessionId: state.rootSessionId,
					role: role === "red-team" ? "red_team" : "verifier",
					decisionId,
					decisionRevision: 1,
					inputStateDigest: state.sourceJournalDigest,
					epochRef: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
					targetDigest,
					effectDigest,
					preconditionDigest,
					planDigest: stagePlan.planDigest,
					attemptToken,
					nonce,
					executionKey,
					proposerSessionId,
					verifierSessionId,
					synthesizerSessionId,
					redTeamSessionId,
					hostSessionId,
					hostExecutionIdentity,
					operationDigest,
					disposition: "accepted",
				});
		const hostReceipt = await input.issueReceipt({
			receiptKind: "adjudication",
			workflowId: state.workflowId,
			bindingDigest: decisionBinding,
			oneUse: true,
			stateDigest: state.sourceJournalDigest,
			revision: state.sourceJournalSequence,
		});
		const stageVerdicts: WorkflowDecisionRecord["stageVerdicts"] = stagePlan.stages.map((stage, index) => {
			const sessionId = `${decisionId}:session:${index}`;
			const executionIdentity = `${decisionId}:execution:${index}`;
			return {
				decisionId,
				decisionRevision: 1,
				stage,
				lensRole: stagePlan.lensRoles[index],
				stageId: `${decisionId}:stage:${index}`,
				disposition: "accepted" as const,
				sessionId,
				executionIdentity,
				storeEpoch: state.storeEpoch,
				coordinatorEpoch: state.coordinatorEpoch,
				inputStateDigest: state.sourceJournalDigest,
				evidenceDigest: digestObject({ decisionId, stage, stateDigest: state.sourceJournalDigest }),
				artifactRefs: [hostReceipt.artifactRef],
				independence: {
					freshContext: true as const,
					distinctSessionIdentity: true as const,
					distinctExecutionIdentity: true as const,
					sharedConversation: false as const,
					sharedMutableOutput: false as const,
					inputStateDigest: state.sourceJournalDigest,
					charterDigest: stagePlan.charterDigests[index],
					limitationRefs: [],
				},
			};
		});
		const decision: WorkflowDecisionRecord = {
			decisionScope: { kind: "workflow", workflowId: state.workflowId, rootSessionId: state.rootSessionId },
			decisionId,
			revision: 1,
			parentDecisionIds: [],
			kind: "completion",
			hostClassification: {
				classifier: "host",
				rulesetDigest: digestObject("completion-ruleset"),
				effectClasses: ["test_or_evaluator"],
				normalizedReadSet: [state.workflowId],
				normalizedWriteSet: [state.workflowId],
				derivedMateriality: "routine",
				requiresUserApproval: false,
				reasonCodes: ["completion-readiness"],
				classifiedTargetDigest: digestObject({ workflowId: state.workflowId }),
				classifiedEffectDigest: digestObject({ kind: "completion" }),
			},
			storeEpoch: state.storeEpoch,
			coordinatorEpoch: state.coordinatorEpoch,
			targetDigest,
			effectDigest,
			preconditionDigest,
			authority: ["observe_workflow", "accept_completion"],
			expiresAt: new Date(Date.parse(input.now()) + 300_000).toISOString(),
			objectiveDigest: digestObject(state.objective),
			contractDigest: state.goalContractDigest ?? digestObject("completion-contract"),
			scorecardDigest: state.scorecardDigest ?? digestObject("completion-scorecard"),
			planDigest: stagePlan.planDigest,
			stateDigest: state.sourceJournalDigest,
			workspaceDigest: state.workspaceDigest,
			evidenceDigest: digestObject({ decisionId, evidence: hostReceipt.artifactRef }),
			parserDigest: digestObject("completion-parser"),
			evaluatorDigest: digestObject("completion-evaluator"),
			guardDigest: digestObject("completion-guard"),
			regressionDigest: digestObject("completion-regression"),
			blockerDigest: null,
			redTeamDigest: digestObject({ decisionId, redTeam: true }),
			readSet: [state.workflowId],
			writeSet: [state.workflowId],
			attemptToken,
			nonce,
			executionKey,
			proposerSessionId,
			lensSessionIds,
			verifierSessionId,
			synthesizerSessionId,
			redTeamSessionId,
			stagePlan,
			stageVerdicts,
			hostAdjudication: {
				stage: "host_adjudication",
				decisionId,
				decisionRevision: 1,
				executionIdentity: hostExecutionIdentity,
				sessionId: hostSessionId,
				inputStateDigest: state.sourceJournalDigest,
				operationDigest,
				verdictArtifactRef: hostReceipt.artifactRef,
				verdictDigest: hostReceipt.payloadDigest,
				hostReceipt,
				disposition: "accepted",
			},
			artifactRefs: [hostReceipt.artifactRef],
			disposition: "authorized",
		};
		return {
			decision,
			ref: {
				decisionScope: decision.decisionScope,
				decisionId,
				revision: 1,
				storeEpoch: state.storeEpoch,
				coordinatorEpoch: state.coordinatorEpoch,
				decisionDigest: digestObject(decision),
			},
		};
	};
	const verifier = await makeDecision("verifier");
	const redTeam = await makeDecision("red-team");
	const digestSources: WorkflowCompletionDigestSources = {
		objective: state.objective,
		hardenedContract: { goalContractDigest: state.goalContractDigest },
		completeRequirementUniverse: {
			provenRequirementIds: [...state.provenRequirementIds],
			unprovenRequirementIds: [...state.unprovenRequirementIds],
			regressedRequirementIds: [...state.regressedRequirementIds],
		},
		fixedBaseline: { stateDigest: state.sourceJournalDigest, sequence: state.sourceJournalSequence },
		capacityLedger: {
			canonicalLedgerRef: { ...canonicalLedgerRef },
			canonicalLedgerDigest: canonicalLedgerRef.digest,
		},
		hiddenFailure: {
			failedStrategies: [...state.failedStrategies],
			unresolvedDecisionRefs: state.unresolvedDecisionRefs.map((ref) => ({
				...ref,
				decisionScope: { ...ref.decisionScope },
			})),
		},
		requirementEvidence: { acceptedEvidenceRefs: state.acceptedEvidenceRefs.map((ref) => ({ ...ref })) },
	};
	const readinessBase: Omit<
		WorkflowCompletionReadinessReceipt,
		"adjudicationReceipt" | "hostReceipt" | "receiptDigest"
	> = {
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outcomeDigest: digestObject(request.outcome.outcome),
		outputStateDigest,
		outputDigest: digestObject([]),
		evidenceDigest: digestObject([]),
		requirementEvidenceDigest: digestObject(digestSources.requirementEvidence),
		objectiveDigest: digestObject(digestSources.objective),
		hardenedContractDigest: digestObject(digestSources.hardenedContract),
		completeRequirementUniverseDigest: digestObject(digestSources.completeRequirementUniverse),
		fixedBaselineDigest: digestObject(digestSources.fixedBaseline),
		capacityLedgerDigest: digestObject(digestSources.capacityLedger),
		hiddenFailureDigest: digestObject(digestSources.hiddenFailure),
		freshVerifierDecisionRef: verifier.ref,
		independentRedTeamDecisionRef: redTeam.ref,
		usageReconciliationRef,
		capacityReconciliationRef,
		verdict: "ready",
	};
	const bindingInput = {
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		headSequence: state.sourceJournalSequence,
		epochRef: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
		outcomeDigest: readinessBase.outcomeDigest,
		outputDigest: readinessBase.outputDigest,
		evidenceDigest: readinessBase.evidenceDigest,
		requirementEvidenceDigest: readinessBase.requirementEvidenceDigest,
		objectiveDigest: readinessBase.objectiveDigest,
		hardenedContractDigest: readinessBase.hardenedContractDigest,
		completeRequirementUniverseDigest: readinessBase.completeRequirementUniverseDigest,
		fixedBaselineDigest: readinessBase.fixedBaselineDigest,
		capacityLedgerDigest: readinessBase.capacityLedgerDigest,
		hiddenFailureDigest: readinessBase.hiddenFailureDigest,
		usageReconciliationRef,
		capacityReconciliationRef,
		freshVerifierDecisionRef: verifier.ref,
		independentRedTeamDecisionRef: redTeam.ref,
	};
	const readinessHostReceipt = await input.issueReceipt({
		receiptKind: "decision",
		workflowId: state.workflowId,
		bindingDigest: workflowCompletionReadinessReceiptBindingDigest(bindingInput),
		oneUse: true,
		stateDigest: state.sourceJournalDigest,
		revision: state.sourceJournalSequence,
	});
	const adjudicationReceipt = await input.issueReceipt({
		receiptKind: "adjudication",
		workflowId: state.workflowId,
		bindingDigest: workflowCompletionAdjudicationReceiptBindingDigest(bindingInput),
		oneUse: true,
		stateDigest: state.sourceJournalDigest,
		revision: state.sourceJournalSequence,
	});
	const readiness: WorkflowCompletionReadinessReceipt = {
		...readinessBase,
		hostReceipt: readinessHostReceipt,
		adjudicationReceipt,
		receiptDigest: "",
	};
	readiness.receiptDigest = digestObject({ ...readiness, receiptDigest: "" });
	return {
		readiness,
		digestSources,
		decisions: new Map([
			[verifier.ref.decisionId, verifier.decision],
			[redTeam.ref.decisionId, redTeam.decision],
		]),
	};
}

interface Harness {
	store: MemoryStore;
	context: WorkflowPhaseHostContext;
}

class MemoryStore implements WorkflowStorePort {
	state: WorkflowState | null = createWorkflowState();
	events: WorkflowEventPayload[] = [];

	async reload(): Promise<WorkflowState | null> {
		return this.state;
	}

	snapshot(): WorkflowState | null {
		return this.state;
	}

	async commit(payload: WorkflowEventPayload, _precondition: WorkflowCommitPrecondition): Promise<WorkflowState> {
		if (this.state === null) throw new Error("Memory store requires a workflow state before commit.");
		this.events.push(payload);
		this.state = {
			...this.state,
			sourceJournalSequence: this.state.sourceJournalSequence + 1,
			sourceJournalDigest: digestObject({ sequence: this.state.sourceJournalSequence + 1, payload }),
			status: payload.kind === "workflow_status_changed" ? payload.status : this.state.status,
			phase: payload.kind === "workflow_status_changed" ? payload.phase : this.state.phase,
			goalActive: payload.kind === "workflow_status_changed" ? payload.goalDelta.active : this.state.goalActive,
			goalStatus: payload.kind === "workflow_status_changed" ? payload.goalDelta.status : this.state.goalStatus,
		};
		return this.state;
	}
}

class FreshMemoryStore extends MemoryStore {
	constructor() {
		super();
		this.state = null;
	}
}

function createHarness(): Harness {
	const store = new MemoryStore();
	let goal: GoalState = {
		...emptyGoalState(),
		goalId: "goal-1",
		objective: "complete the workflow",
		active: true,
		status: "active",
	};
	const context: WorkflowPhaseHostContext = {
		workflowId: "workflow-1",
		rootSessionId: "session-1",
		store,
		goalProjection: {
			read: () => structuredClone(goal),
			compareAndSwap: (expected, next) => {
				if (digestObject(goal) !== digestObject(expected)) return false;
				goal = structuredClone(next);
				return true;
			},
		},
		services: {
			store,
			journal: { currentLeaseRef: () => ({ ...LEASE }) },
			currentEpoch: () => ({ ...EPOCH }),
		},
	};
	return { store, context };
}

function createWorkflowState(): WorkflowState {
	return {
		workflowId: "workflow-1",
		rootSessionId: "session-1",
		status: "active",
		phase: "verifying",
		objective: "complete the workflow",
		goalId: "goal-1",
		goalActive: true,
		goalStatus: "active",
		goalTokenBudget: null,
		goalTokensUsed: 0,
		goalTimeUsedSeconds: 0,
		goalContinuationsUsed: 0,
		goalCreatedAt: null,
		goalUpdatedAt: null,
		goalLastReason: null,
		goalLastError: null,
		sourceJournalSequence: 1,
		sourceJournalDigest: digestObject("current-state"),
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		goalProjectionDigest: null,
		capacityDigest: null,
		goalContractDigest: digestObject("contract"),
		approvalRequest: null,
		decisionRefs: [],
		profileDigest: null,
		configDigest: null,
		skillSnapshotDigests: [],
		cloudAvailabilityDigest: null,
		scorecardDigest: digestObject("scorecard"),
		resourceEnvelopeDigest: digestObject("envelope"),
		continuityCapsuleDigest: null,
		provenRequirementIds: ["requirement-1"],
		unprovenRequirementIds: [],
		regressedRequirementIds: [],
		workspaceDigest: digestObject("workspace"),
		executionProfile: "inline",
		planRevision: 1,
		acceptedEvidenceRefs: [],
		ownershipLeaseRefs: [],
		resourceLeaseRefs: [],
		failedStrategies: [],
		unresolvedDecisionRefs: [],
		continuationEntryPoint: "verifying",
		generationBinding: {
			writerIdentity: LEASE.writerIdentity,
			processGenerationId: "generation-1",
			ownerIdentity: "workflow-coordinator",
		},
	};
}
