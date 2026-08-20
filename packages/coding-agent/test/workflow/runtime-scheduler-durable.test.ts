import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { expect, it } from "vitest";

import type {
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowOwnershipLease,
	WorkflowResourceLease,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreDurableContext,
} from "../../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject, sha256Hex } from "../../src/core/workflow/contracts.js";
import { deriveWorkflowExecutionKey, type WorkflowCanonicalDispatchInput } from "../../src/core/workflow/dispatch.js";
import type { WorkflowLeaseManager } from "../../src/core/workflow/leases.js";
import {
	createWorkflowSchedulerDurableAdmissionTransaction,
	type WorkflowSchedulerDurableAdmissionTransactionInput,
	type WorkflowSchedulerState,
	type WorkflowSchedulerStateStore,
} from "../../src/core/workflow/scheduler.js";
import { validateWorkflowTaskGraph } from "../../src/core/workflow/task-graph.js";
import { createPrimeWorkflowFixture, createPrimeWorkflowTasks } from "./prime-loop-fixtures.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const WORKFLOW_ID = "workflow-scheduler-durable-test";
const ROOT_SESSION_ID = "scheduler-durable-session";
const TASK_ID = "recon";
const ATTEMPT_ID = "attempt-durable";
const WRITER_IDENTITY = "writer-durable";
const LAUNCH_CONFIG_DIGEST = sha256Hex("scheduler-durable-launch-config");

function head(sequence: number, eventDigest: string | null): WorkflowJournalHead {
	return { workflowId: WORKFLOW_ID, sequence, eventDigest, epochRef: EPOCH };
}

function decisionRef() {
	return {
		decisionScope: { kind: "workflow" as const, workflowId: WORKFLOW_ID, rootSessionId: ROOT_SESSION_ID },
		decisionId: "scheduler-durable-decision",
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		decisionDigest: sha256Hex("scheduler-durable-decision"),
	};
}

function executionKeyFor(attemptId: string): string {
	return deriveWorkflowExecutionKey({
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId,
		decisionRef: decisionRef(),
		launchConfigDigest: LAUNCH_CONFIG_DIGEST,
	});
}

function leaseRef(leaseId: string, acquisitionEventSequence: number): WorkflowLeaseRef {
	return {
		...EPOCH,
		leaseId,
		acquisitionEventSequence,
		processIdentity: "process:scheduler-durable",
		rootDigest: "root-digest",
		writerIdentity: WRITER_IDENTITY,
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T00:10:00.000Z",
	};
}

function resourceLease(attemptId: string, leaseId: string, acquisitionEventSequence: number): WorkflowResourceLease {
	return {
		leaseId,
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId,
		holderIdentity: WRITER_IDENTITY,
		resourceAdmission: {} as never,
		controlCapacity: {} as never,
		workerCapacity: {} as never,
		status: "active",
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		acquisitionEventSequence,
		idempotencyKey: `resource:${attemptId}`,
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T00:10:00.000Z",
		releaseEventSequence: null,
	};
}

function ownershipLease(attemptId: string, leaseId: string, acquisitionEventSequence: number): WorkflowOwnershipLease {
	return {
		leaseId,
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId,
		ownedPaths: ["src"],
		ownedContracts: [],
		status: "active",
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		acquisitionEventSequence,
		releaseEventSequence: null,
	};
}

function dispatchInput(attemptId: string, executionKey: string): WorkflowCanonicalDispatchInput {
	return {
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		taskId: TASK_ID,
		attemptId,
		executionKey,
		decisionRef: decisionRef(),
		epochRef: EPOCH,
		rootLeaseRef: leaseRef("root-lease", 1),
		resourceLease: resourceLease(attemptId, `queued:${attemptId}`, 1),
		ownershipLease: null,
		childAuthority: {
			capabilities: ["read_only"],
			writeClass: "read_only",
			parentAttemptId: null,
			rootSpawned: true,
		},
		launchConfigDigest: LAUNCH_CONFIG_DIGEST,
		configSnapshotDigest: sha256Hex("scheduler-durable-config"),
		canonicalAdmissionBundleRef: {} as never,
		canonicalAdmissionBundleDigest: sha256Hex("scheduler-durable-bundle"),
		canonicalAdmissionBundle: {} as never,
		revisionTuple: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			evidenceRevision: 1,
			configRevision: 1,
		},
		revisionRegistryRef: {} as never,
		revisionRegistryDigest: sha256Hex("scheduler-durable-revision"),
		writerIdentity: WRITER_IDENTITY,
		expectedEffectDigest: sha256Hex("scheduler-durable-effect"),
		promptArtifactRef: {} as never,
		prompt: "scheduler durable recovery",
		sessionName: "scheduler-durable",
		sessionDir: "/tmp/scheduler-durable",
		cwd: "/tmp/scheduler-durable",
		modelProvider: "none",
		modelId: "none",
		reasoningLevel: "medium",
		serviceTier: "default",
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "scheduler-durable-host",
		agentRole: "worker",
		processGroupRequest: {} as never,
	};
}

function state(
	recipeAdmission: { readonly recipeId: string; readonly revision: number; readonly admissionDigest: string },
	attemptId: string,
	activeAttemptIds: readonly string[] = [],
): WorkflowSchedulerState {
	const executionKey = executionKeyFor(attemptId);
	return {
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		entries: [
			{
				input: dispatchInput(attemptId, executionKey),
				queuedAt: "2030-01-01T00:00:00.000Z",
				priority: 1,
				blockedBy: [],
				recipeId: recipeAdmission.recipeId,
				recipeRevision: recipeAdmission.revision,
				recipeAdmissionDigest: recipeAdmission.admissionDigest,
			},
		],
		pausedReason: null,
		activeAttemptIds,
	};
}

it("reopens a queue-committed marker, rolls back once, and admits a fresh fenced lease", async () => {
	const artifactRoot = await mkdtemp(`${tmpdir()}/workflow-scheduler-durable-`);
	let currentHead = head(0, null);
	const expectedJournalHead = currentHead;
	const events: Array<Record<string, unknown>> = [];
	const auxiliary = new Map<string, Uint8Array>();
	let locked = false;
	const recipeFixtures = new Map<string, Awaited<ReturnType<typeof createPrimeWorkflowFixture>>>();
	const graph = validateWorkflowTaskGraph(createPrimeWorkflowTasks(), {
		knownSkillSnapshotDigests: [],
		allowedAuthority: ["read_workspace"],
		workspacePaths: ["src"],
		generatedOutputPaths: ["artifacts/out"],
		namedContracts: [],
	});
	const fixtureForHead = async (headDigest: string) => {
		const existing = recipeFixtures.get(headDigest);
		if (existing !== undefined) return existing;
		const fixture = await createPrimeWorkflowFixture(artifactRoot, WORKFLOW_ID, EPOCH, headDigest);
		recipeFixtures.set(headDigest, fixture);
		return fixture;
	};
	const initialFixture = await fixtureForHead(digestObject(expectedJournalHead));
	const previousState = state(initialFixture.snapshots.recipe, ATTEMPT_ID);
	const nextState = state(initialFixture.snapshots.recipe, ATTEMPT_ID, [ATTEMPT_ID]);
	let persistedState = structuredClone(nextState);
	const store = {
		identity: {
			storeKind: "workflow" as const,
			namespace: "test",
			rootDir: "/tmp/workflow-scheduler-durable-test",
			storeId: "scheduler-durable-store",
			workflowId: WORKFLOW_ID,
			identityDigest: "scheduler-durable-store-digest",
		},
		durableContext: undefined as WorkflowRuntimeStoreDurableContext | undefined,
		replay: async () => ({
			workflowId: WORKFLOW_ID,
			executionKey: events.at(-1)?.executionKey as string | null,
			events: events as never,
			head: currentHead,
			quarantined: false,
			quarantineReason: null,
		}),
	} as unknown as WorkflowRuntimeStore;
	const root = leaseRef("root-lease", 1);
	const durable: WorkflowRuntimeStoreDurableContext = {
		generationId: "generation-durable",
		epochRef: EPOCH,
		currentLeaseRef: () => root,
		outbox: {} as never,
		auxiliaryStore: {
			read: async (name) => auxiliary.get(name) ?? null,
			write: async (name, bytes) => {
				auxiliary.set(name, Uint8Array.from(bytes));
			},
		},
		withExclusiveLease: async (_boundary, operation) => {
			if (locked) throw new Error("exclusive lease was not serialized");
			locked = true;
			try {
				return await operation();
			} finally {
				locked = false;
			}
		},
		recoverJournal: async () => ({ status: "healthy", metadata: {} }) as never,
	};
	(store as { durableContext: WorkflowRuntimeStoreDurableContext }).durableContext = durable;

	const append = (payload: WorkflowEventPayload, executionKey: string): void => {
		const sequence = currentHead.sequence + 1;
		const eventDigest = digestObject({ sequence, payload });
		events.push({ sequence, workflowId: WORKFLOW_ID, payload, epochRef: EPOCH, executionKey, eventDigest });
		currentHead = head(sequence, eventDigest);
	};
	const oldExecutionKey = executionKeyFor(ATTEMPT_ID);
	const oldResourceLease = resourceLease(ATTEMPT_ID, "resource:old", 1);
	const oldOwnershipLease = ownershipLease(ATTEMPT_ID, "ownership:old", 2);
	append(
		{ kind: "workflow_resource_lease_acquired", workflowId: WORKFLOW_ID, lease: oldResourceLease, epochRef: EPOCH },
		oldExecutionKey,
	);
	append(
		{ kind: "workflow_ownership_lease_acquired", workflowId: WORKFLOW_ID, lease: oldOwnershipLease, epochRef: EPOCH },
		oldExecutionKey,
	);
	const markerWithoutDigest = {
		version: 1 as const,
		markerDigest: "",
		status: "queue_committed" as const,
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		epochRef: EPOCH,
		attemptId: ATTEMPT_ID,
		executionKey: oldExecutionKey,
		expectedStateDigest: digestObject(previousState),
		expectedJournalHead,
		expectedJournalHeadDigest: digestObject(expectedJournalHead),
		expectedQueueHeadDigest: digestObject(previousState),
		recipeAdmissionDigest: initialFixture.snapshots.recipe.admissionDigest,
		recipeId: initialFixture.snapshots.recipe.recipeId,
		recipeRevision: initialFixture.snapshots.recipe.revision,
		requiredSkillSnapshotDigests: [],
		skillBindings: [],
		previousState,
		nextState,
		resourceLease: oldResourceLease,
		ownershipLease: oldOwnershipLease,
		ownerProcessIdentity: "process:999999999:dead",
	};
	const { markerDigest: _markerDigest, ...markerPayload } = markerWithoutDigest;
	auxiliary.set(
		"workflow-dispatch-recovery",
		canonicalJsonBytes({ ...markerPayload, markerDigest: digestObject(markerPayload) } as never),
	);

	let hydrateCalls = 0;
	const hydratedLeaseIds: string[] = [];
	const releasedLeaseIds: string[] = [];
	let reservations = 0;
	const freshAttemptId = `${ATTEMPT_ID}:retry:1`;
	const freshExecutionKey = executionKeyFor(freshAttemptId);
	const leaseManager = {
		reserveDispatch: async (input: Parameters<NonNullable<WorkflowLeaseManager["reserveDispatch"]>>[0]) => {
			reservations += 1;
			const resource = resourceLease(freshAttemptId, "resource:fresh", currentHead.sequence + 1);
			const ownership = ownershipLease(freshAttemptId, "ownership:fresh", currentHead.sequence + 2);
			append(
				{ kind: "workflow_resource_lease_acquired", workflowId: WORKFLOW_ID, lease: resource, epochRef: EPOCH },
				freshExecutionKey,
			);
			append(
				{ kind: "workflow_ownership_lease_acquired", workflowId: WORKFLOW_ID, lease: ownership, epochRef: EPOCH },
				freshExecutionKey,
			);
			await input.onLeasesAcquired?.(resource, ownership);
			await input.commitQueueState?.();
			await input.onQueueCommitted?.();
			return { resourceLease: resource, ownershipLease: ownership, admission: {} as never };
		},
		hydrateFromReplay: async () => {
			hydrateCalls += 1;
			const replay = await store.replay({
				workflowId: WORKFLOW_ID,
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			for (const event of replay.events) {
				if (
					event.payload.kind === "workflow_resource_lease_acquired" ||
					event.payload.kind === "workflow_ownership_lease_acquired"
				)
					hydratedLeaseIds.push(event.payload.lease.leaseId);
			}
		},
		releasePreDispatch: async (input: {
			resourceLease: WorkflowResourceLease;
			ownershipLease: WorkflowOwnershipLease | null;
			attemptId: string;
			executionKey: string;
		}) => {
			releasedLeaseIds.push(input.resourceLease.leaseId);
			if (input.ownershipLease !== null) releasedLeaseIds.push(input.ownershipLease.leaseId);
			for (const lease of [input.resourceLease, input.ownershipLease]) {
				if (lease === null) continue;
				append(
					{
						kind: "workflow_lease_release_recorded",
						workflowId: WORKFLOW_ID,
						releaseRef: {
							leaseRef: leaseRef(lease.leaseId, lease.acquisitionEventSequence),
							attemptId: input.attemptId,
							terminalOutcomeDigest: digestObject({ leaseId: lease.leaseId, executionKey: input.executionKey }),
							releaseEventSequence: currentHead.sequence + 1,
							releaseProof: sha256Hex(`release:${lease.leaseId}`),
						},
						epochRef: EPOCH,
						status: "released",
					} as never,
					input.executionKey,
				);
			}
		},
	} as unknown as WorkflowLeaseManager;
	const queueState: WorkflowSchedulerStateStore = {
		read: async () => structuredClone(persistedState),
		write: async (next) => {
			persistedState = structuredClone(next);
		},
		compareAndSwap: async ({ expectedStateDigest, nextState }) => {
			if (digestObject(persistedState) !== expectedStateDigest) return "conflict";
			persistedState = structuredClone(nextState);
			return "applied";
		},
	};
	const createTransaction = () =>
		createWorkflowSchedulerDurableAdmissionTransaction({
			store,
			leases: leaseManager,
			queueState,
			createAdmissionContext: () => ({}) as never,
			readTaskGraph: () => graph,
			resolveRecipeAdmissionHost: async ({ expectedHead }) =>
				recipeFixtures.get(digestObject(expectedHead))?.recipeHost ?? null,
		});
	const input = (
		attemptId: string,
		executionKey: string,
		expectedHeadDigest: string,
		states: { readonly previousState: WorkflowSchedulerState; readonly nextState: WorkflowSchedulerState },
		admission: Awaited<ReturnType<typeof createPrimeWorkflowFixture>>["snapshots"]["recipe"],
	): WorkflowSchedulerDurableAdmissionTransactionInput => ({
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		taskId: TASK_ID,
		attemptId,
		executionKey,
		expectedStateDigest: digestObject(states.previousState),
		expectedHeadDigest,
		previousState: states.previousState,
		nextState: states.nextState,
		resource: {} as never,
		ownership: {} as never,
		recipeAdmission: admission,
		admissionDigest: admission.admissionDigest,
		recipeId: admission.recipeId,
		recipeRevision: admission.revision,
		requiredSkillSnapshotDigests: [],
		skillBindings: [],
		consumeRecipeAdmission: async () => undefined,
	});

	try {
		const reopenedTransaction = createTransaction();
		await expect(
			reopenedTransaction.commit(
				input(
					ATTEMPT_ID,
					oldExecutionKey,
					digestObject(currentHead),
					{ previousState, nextState },
					initialFixture.snapshots.recipe,
				),
			),
		).rejects.toThrow("workflow_scheduler_recovery_requeued");
		const retryFixture = await fixtureForHead(digestObject(currentHead));
		const retryPreviousState = state(retryFixture.snapshots.recipe, freshAttemptId);
		const retryNextState = state(retryFixture.snapshots.recipe, freshAttemptId, [freshAttemptId]);
		persistedState = structuredClone(retryPreviousState);
		const retryTransaction = createTransaction();
		await expect(
			retryTransaction.commit(
				input(
					freshAttemptId,
					freshExecutionKey,
					digestObject(currentHead),
					{ previousState: retryPreviousState, nextState: retryNextState },
					retryFixture.snapshots.recipe,
				),
			),
		).resolves.toMatchObject({
			resourceLease: { leaseId: "resource:fresh", attemptId: freshAttemptId },
			ownershipLease: { leaseId: "ownership:fresh", attemptId: freshAttemptId },
		});
		expect(hydrateCalls).toBe(1);
		expect(hydratedLeaseIds).toEqual(["resource:old", "ownership:old"]);
		expect(releasedLeaseIds).toEqual(["resource:old", "ownership:old"]);
		expect(reservations).toBe(1);
		expect(persistedState.activeAttemptIds).toEqual([freshAttemptId]);
		expect(freshExecutionKey).not.toBe(oldExecutionKey);
		expect(auxiliary.has("workflow-dispatch-recovery")).toBe(true);
	} finally {
		await rm(artifactRoot, { recursive: true, force: true });
	}
});
