import { expect, it, vi } from "vitest";

import type {
	WorkflowArtifactRef,
	WorkflowEpochRef,
	WorkflowOutboxAppender,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreDurableContext,
} from "../src/core/workflow/contracts.js";
import { digestObject } from "../src/core/workflow/contracts.js";
import type { CoordinatorStatusInput } from "../src/core/workflow/coordinator-status.js";
import type { WorkflowCanonicalDispatchInput, WorkflowDispatcher } from "../src/core/workflow/dispatch.js";
import type { WorkflowEffectBroker } from "../src/core/workflow/effect-broker.js";
import type { WorkflowLeaseManager } from "../src/core/workflow/leases.js";
import type { WorkflowReconciliationOutcome, WorkflowRecoveryRequest } from "../src/core/workflow/recovery.js";
import type { WorkflowRuntimeRecoveryCoordinator } from "../src/core/workflow/runtime-recovery.js";
import type { WorkflowScheduler, WorkflowSchedulerState } from "../src/core/workflow/scheduler.js";
import type { WorkflowTaskGraph } from "../src/core/workflow/task-graph.js";
import {
	createWorkflowTaskRuntimeAuthority,
	type WorkflowPrimeStageEvidenceAdapter,
	type WorkflowTaskRuntimeEvidenceClassification,
} from "../src/core/workflow/task-runtime-authority.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const WORKFLOW_ID = "workflow-task-runtime-authority-test";
const GOAL_REVISION_DIGEST = digestObject({ goal: "workflow-task-runtime-authority-test" });

function store(
	outbox: WorkflowOutboxAppender,
	replayResult?: Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>,
): WorkflowRuntimeStore {
	const durable: WorkflowRuntimeStoreDurableContext = {
		generationId: "generation-task-runtime-authority-test",
		epochRef: EPOCH,
		currentLeaseRef: () => ({
			...EPOCH,
			leaseId: "root-lease",
			acquisitionEventSequence: 1,
			processIdentity: "process-root",
			rootDigest: "root-digest",
			writerIdentity: "writer-root",
			acquiredAt: "2030-01-01T00:00:00.000Z",
			expiresAt: "2030-01-01T01:00:00.000Z",
		}),
		outbox,
		auxiliaryStore: {
			read: async () => null,
			write: async () => undefined,
		},
		withExclusiveLease: async <T>(_boundary: string, operation: () => Promise<T>): Promise<T> => operation(),
		recoverJournal: async () => ({
			quarantined: false,
			events: [],
			metadata: {
				status: "complete",
				sourcePath: "",
				sourceDigest: "",
				sourceSizeBytes: 0,
				sequence: null,
				epochRef: EPOCH,
				reason: "none",
			},
		}),
	};
	const replay = async (): Promise<Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>> =>
		replayResult ?? {
			workflowId: WORKFLOW_ID,
			executionKey: null,
			events: [],
			head: { workflowId: WORKFLOW_ID, sequence: 0, eventDigest: null, epochRef: EPOCH },
			quarantined: false,
			quarantineReason: null,
		};
	return {
		identity: {
			storeKind: "workflow",
			namespace: "test",
			rootDir: "/tmp",
			storeId: "store-task-runtime-authority-test",
			workflowId: WORKFLOW_ID,
			identityDigest: "store-digest",
		},
		durableContext: durable,
		commit: async () => {
			throw new Error("fixture_commit_not_used");
		},
		replay,
		publishArtifact: async () => {
			throw new Error("fixture_publish_not_used");
		},
		publishSnapshot: async () => {
			throw new Error("fixture_snapshot_not_used");
		},
		compareAndSwapProjection: async () => {
			throw new Error("fixture_projection_not_used");
		},
		appendOutbox: async () => {
			throw new Error("fixture_outbox_not_used");
		},
		replaceCoordinatorEpoch: async () => {
			throw new Error("fixture_rotation_not_used");
		},
		replaceStoreEpoch: async () => {
			throw new Error("fixture_rotation_not_used");
		},
	} as unknown as WorkflowRuntimeStore;
}

function graph(): WorkflowTaskGraph {
	return {
		graphRevision: 1,
		tasks: [],
		byId: new Map(),
		allowedAuthority: [],
		ownershipPaths: [],
		generatedOutputPaths: [],
		lockPaths: [],
		namedContracts: [],
		graphDigest: "graph-digest",
	};
}

function schedulerState(): WorkflowSchedulerState {
	return {
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		entries: [],
		pausedReason: null,
		activeAttemptIds: [],
		terminalAttemptIds: [],
		lastEventSequence: 0,
	};
}

function coordinatorStatusEvidence(
	input: {
		readonly activeWorkerIds?: readonly string[];
		readonly readyTaskIds?: readonly string[];
		readonly authenticatedCapacity?: number;
		readonly blockingReasons?: readonly (
			| "write_conflict"
			| "dependency_blocked"
			| "resource_exhausted"
			| "provider_backpressure"
			| "user_decision"
			| "no_ready_work"
			| "recovery"
		)[];
	} = {},
): CoordinatorStatusInput {
	const activeWorkerIds = input.activeWorkerIds ?? [];
	const readyTaskIds = input.readyTaskIds ?? [];
	const authenticatedCapacity = input.authenticatedCapacity ?? 1;
	const blockingReasons = input.blockingReasons ?? [];
	const current = {
		workflowId: WORKFLOW_ID,
		journalHeadDigest: "head-authority",
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		revision: 1,
		sourceEventSequence: 1,
		sourceEventTime: "2030-01-01T00:00:00.000Z",
		trustedNow: "2030-01-01T00:01:00.000Z",
		generation: 1,
		fenceToken: "fence-authority",
	};
	const payload = {
		scheduler: {
			activeWorkerIds,
			readyTaskIds,
			pendingMessageIds: [],
			scheduledWakeAt: null,
			authenticatedCapacity,
			blockingReasons,
		},
		children: {
			obligations: activeWorkerIds.map((childId) => ({ childId, phase: "running" as const })),
		},
	};
	const evidence = {
		payload,
		payloadDigest: digestObject(payload),
		workflowId: current.workflowId,
		journalHeadDigest: current.journalHeadDigest,
		storeEpoch: current.storeEpoch,
		coordinatorEpoch: current.coordinatorEpoch,
		revision: current.revision,
		sourceEventSequence: current.sourceEventSequence,
		sourceEventTime: current.sourceEventTime,
		generation: current.generation,
		fenceToken: current.fenceToken,
	};
	return {
		runtimeVersion: "0.147.0-alpha.10",
		host: {
			readAtomicSnapshot: async () => ({ current, evidence }),
			assertCurrent: async () => undefined,
			resolvePendingDecision: async () => null,
			principalAuthorizer: {
				authorize: async () => {
					throw new Error("fixture_principal_authorizer_not_used");
				},
			} as never,
		},
	};
}

function artifact(): WorkflowArtifactRef {
	return {
		artifactId: "evidence",
		relativePath: "evidence.json",
		digest: "evidence-digest",
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
}

function hostVerifiedClassification(
	evidenceKind: WorkflowTaskRuntimeEvidenceClassification["evidenceKind"] = "real_integration",
): WorkflowTaskRuntimeEvidenceClassification {
	return {
		boundary: "public_boundary",
		verification: "host_verified",
		evidenceKind,
		authorizesTerminalization: true,
	};
}

function reconciliationOutcome(
	disposition: WorkflowReconciliationOutcome["disposition"],
): WorkflowReconciliationOutcome {
	return {
		workflowId: WORKFLOW_ID,
		reconciliationAttemptId: `reconciliation-${disposition}`,
		taskId: "recon",
		attemptId: "attempt-recon",
		disposition,
		persistedChildIdentity: null,
		observedChildIdentity: null,
		observedProcessGroupId: null,
		observedTranscriptDigest: null,
		observedWorkspaceDigest: "workspace",
		epochRef: EPOCH,
		evidenceRefs: [],
		stateDigest: `state-${disposition}`,
	};
}

function authorityFixture(
	input: {
		readonly runtimeVersion?: string;
		readonly recoveryOutcome?: WorkflowReconciliationOutcome;
		readonly replayResult?: Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>;
	} = {},
): {
	readonly runtime: ReturnType<typeof createWorkflowTaskRuntimeAuthority>;
	readonly scheduler: WorkflowScheduler;
	readonly recovery: WorkflowRuntimeRecoveryCoordinator;
	readonly outbox: WorkflowOutboxAppender;
	readonly prime: WorkflowPrimeStageEvidenceAdapter;
} {
	const scheduler = {
		enqueue: vi.fn(async () => undefined),
		onEvent: vi.fn(async () => []),
		refill: vi.fn(async () => []),
		observe: vi.fn(async () => []),
		pause: vi.fn(async () => undefined),
		resume: vi.fn(async () => undefined),
	} as unknown as WorkflowScheduler;
	const outbox = { append: vi.fn(), recover: vi.fn() } as unknown as WorkflowOutboxAppender;
	const recovery = {
		readiness: () => ({ canRecover: true, blockingReasons: [] }),
		startRecovery: vi.fn(async () => ({
			status: "started",
			binding: null,
			nonExecutionProof: null,
			journalHeadDigest: "head",
		})),
		beginRecovery: vi.fn(async () => ({
			status: "started",
			binding: null,
			nonExecutionProof: null,
			journalHeadDigest: "head",
		})),
		reconcile: vi.fn(async () => input.recoveryOutcome ?? reconciliationOutcome("reattached")),
	} as unknown as WorkflowRuntimeRecoveryCoordinator;
	const prime: WorkflowPrimeStageEvidenceAdapter = {
		recordEvidence: async () => hostVerifiedClassification(),
		readCoordinatorStatus: async () => coordinatorStatusEvidence(),
		recordTelemetry: async () => undefined,
		assertStageAcceptable: async () => undefined,
		acceptStage: async () => undefined,
		readAudit: async () => ({ terminalTaskIds: [], launchEvidenceRefs: [], workerResults: [] }),
	};
	const runtime = createWorkflowTaskRuntimeAuthority({
		runtimeVersion: input.runtimeVersion ?? "0.147.0-alpha.10",
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		runtimeStore: store(outbox, input.replayResult),
		scheduler,
		dispatcher: {} as WorkflowDispatcher,
		leases: {} as WorkflowLeaseManager,
		effects: {} as WorkflowEffectBroker,
		recovery,
		prime,
		readSchedulerState: async () => schedulerState(),
	});
	return { runtime, scheduler, recovery, outbox, prime };
}

it("rejects a runtime below the required host composition version", () => {
	expect(() => authorityFixture({ runtimeVersion: "0.147.0-alpha.9" })).toThrow(
		"workflow_runtime_version_unsupported",
	);
});

it("rejects stage acceptance evidence that is not host-verified at the public boundary", async () => {
	const fixture = authorityFixture();
	await expect(
		fixture.runtime.acceptStage({
			stageId: "recon",
			classification: {
				boundary: "private_symbol",
				verification: "mock_only",
				evidenceKind: "debug_probe",
				authorizesTerminalization: false,
			} as never,
		}),
	).rejects.toThrow("workflow_task_runtime_stage_evidence_not_authorizing");
});

it("requires the host adapter to classify evidence before accepting a stage", async () => {
	const fixture = authorityFixture();
	fixture.prime.recordEvidence = vi.fn(
		async () =>
			({
				boundary: "public_boundary",
				verification: "host_verified",
				evidenceKind: "mock_only",
				authorizesTerminalization: false,
			}) as never,
	);
	await expect(fixture.runtime.prime.recordEvidence({ stageId: "recon", evidenceRefs: [artifact()] })).rejects.toThrow(
		"workflow_task_runtime_stage_evidence_not_authorizing",
	);
});

it("composes generic authorities and keeps Prime stage/evidence state host-owned", async () => {
	const enqueue = vi.fn(async (_input: WorkflowCanonicalDispatchInput, _queuedAt: string) => undefined);
	const scheduler = {
		enqueue,
		onEvent: vi.fn(async () => []),
		refill: vi.fn(async () => []),
		observe: vi.fn(async () => []),
		pause: vi.fn(async () => undefined),
		resume: vi.fn(async () => undefined),
	} as unknown as WorkflowScheduler;
	const dispatcher = {} as WorkflowDispatcher;
	const leases = {} as WorkflowLeaseManager;
	const effects = {} as WorkflowEffectBroker;
	const recovery = {
		readiness: () => ({ canRecover: true, blockingReasons: [] }),
		startRecovery: vi.fn(async () => ({
			status: "started",
			binding: null,
			nonExecutionProof: null,
			journalHeadDigest: "head",
		})),
		beginRecovery: vi.fn(async () => ({
			status: "started",
			binding: null,
			nonExecutionProof: null,
			journalHeadDigest: "head",
		})),
		reconcile: vi.fn(async () => ({
			workflowId: WORKFLOW_ID,
			reconciliationAttemptId: "reconciliation",
			taskId: "recon",
			attemptId: "attempt-recon",
			disposition: "reattached",
			persistedChildIdentity: null,
			observedChildIdentity: null,
			observedProcessGroupId: null,
			observedTranscriptDigest: null,
			observedWorkspaceDigest: "workspace",
			epochRef: EPOCH,
			evidenceRefs: [],
			stateDigest: "state",
		})),
	} as unknown as WorkflowRuntimeRecoveryCoordinator;
	const recordEvidence = vi.fn(async (_input: { stageId: string; evidenceRefs: readonly WorkflowArtifactRef[] }) =>
		hostVerifiedClassification(),
	);
	const prime: WorkflowPrimeStageEvidenceAdapter = {
		recordEvidence,
		readCoordinatorStatus: async () => coordinatorStatusEvidence(),
		recordTelemetry: async () => undefined,
		assertStageAcceptable: async () => undefined,
		acceptStage: async () => undefined,
		readAudit: async () => ({ terminalTaskIds: [], launchEvidenceRefs: [], workerResults: [] }),
	};
	const outbox = { append: vi.fn(), recover: vi.fn() } as unknown as WorkflowOutboxAppender;
	const runtime = createWorkflowTaskRuntimeAuthority({
		runtimeVersion: "0.147.0-alpha.10",
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		runtimeStore: store(outbox),
		scheduler,
		dispatcher,
		leases,
		effects,
		recovery,
		prime,
		readSchedulerState: async () => schedulerState(),
	});

	const dispatchInput = {
		workflowId: WORKFLOW_ID,
		taskId: "recon",
		attemptId: "attempt-recon",
		executionKey: "execution-recon",
		epochRef: EPOCH,
	} as WorkflowCanonicalDispatchInput;
	await runtime.prime.enqueue({ stageId: "recon", dispatchInput, queuedAt: "2030-01-01T00:00:00.000Z" });
	await runtime.prime.recordEvidence({ stageId: "recon", evidenceRefs: [artifact()] });

	expect(enqueue).toHaveBeenCalledWith(dispatchInput, "2030-01-01T00:00:00.000Z");
	expect(recordEvidence).toHaveBeenCalledWith({ stageId: "recon", evidenceRefs: [artifact()] });
	expect(runtime.scheduler).toBe(scheduler);
	expect(runtime.dispatcher).toBe(dispatcher);
	expect(runtime.leases).toBe(leases);
	expect(runtime.effects).toBe(effects);
	expect(runtime.recovery).toBe(recovery);
	expect(runtime.failureOutbox).toBe(outbox);
	await expect(runtime.readState()).resolves.toEqual(schedulerState());
	await expect(runtime.readAudit()).resolves.toMatchObject({
		scheduler: schedulerState(),
		terminalTaskIds: [],
		launchEvidenceRefs: [],
		workerResults: [],
	});
});

it("reports live-child status without a needs-input state and forwards adaptive telemetry", async () => {
	const fixture = authorityFixture();
	const readCoordinatorStatus = vi.fn(async () =>
		coordinatorStatusEvidence({
			activeWorkerIds: ["child-recon"],
			readyTaskIds: ["ready-recon"],
			authenticatedCapacity: 3,
		}),
	);
	fixture.prime.readCoordinatorStatus = readCoordinatorStatus;
	const recordTelemetry = vi.fn(async () => ({ recorded: true }));
	fixture.prime.recordTelemetry = recordTelemetry;

	await expect(fixture.runtime.readStatus()).resolves.toEqual({
		status: "working",
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		activeWorkers: 1,
		eligibleReadyTasks: 1,
		idleCapacity: 2,
		idleReason: "none",
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
	readCoordinatorStatus.mockResolvedValue(
		coordinatorStatusEvidence({ activeWorkerIds: ["child-recon"], authenticatedCapacity: 3 }),
	);
	await expect(fixture.runtime.readStatus()).resolves.toMatchObject({
		status: "waiting_on_children",
		idleReason: "none",
	});
	await expect(
		fixture.runtime.recordTelemetry({
			dispatchLatencyMs: 1,
			childWaitMs: 2,
			idleTimeMs: 3,
			duplicateScans: 4,
			testRuntimeMs: 5,
			blockedCapacityReason: "protocol_review_required",
		}),
	).resolves.toEqual({ recorded: true });
	expect(recordTelemetry).toHaveBeenCalledWith({
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		telemetry: {
			dispatchLatencyMs: 1,
			childWaitMs: 2,
			idleTimeMs: 3,
			duplicateScans: 4,
			testRuntimeMs: 5,
			blockedCapacityReason: "protocol_review_required",
		},
	});
	await fixture.runtime.onEvent({
		kind: "task_ready",
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		eventSequence: 2,
	});
	expect(fixture.scheduler.onEvent as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "task_ready", eventSequence: 2 }),
	);
});

it("uses authenticated coordinator evidence for the public status projection", async () => {
	const fixture = authorityFixture();
	const coordinatorEvidence = coordinatorStatusEvidence({
		activeWorkerIds: ["child-authoritative"],
		authenticatedCapacity: 2,
	});
	const primeWithCoordinator = fixture.prime;
	primeWithCoordinator.readCoordinatorStatus = vi.fn(async () => coordinatorEvidence);

	await expect(fixture.runtime.readStatus()).resolves.toEqual({
		status: "waiting_on_children",
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		activeWorkers: 1,
		eligibleReadyTasks: 0,
		idleCapacity: 1,
		idleReason: "none",
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
	expect(primeWithCoordinator.readCoordinatorStatus).toHaveBeenCalledTimes(1);
});

it("starts recovery before bounded scheduler refill and routes terminal events to the scheduler", async () => {
	const fixture = authorityFixture();
	await fixture.runtime.start();
	await fixture.runtime.onTerminal({
		kind: "attempt_completed",
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		eventSequence: 1,
		attemptId: "attempt-recon",
	});

	expect(fixture.recovery.startRecovery as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	expect(fixture.scheduler.refill as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(WORKFLOW_ID, EPOCH);
	expect(fixture.scheduler.onEvent as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "attempt_completed", attemptId: "attempt-recon" }),
	);
});

it("does not reassign a reattached attempt and only refills after durable proven-not-executed evidence", async () => {
	const request: WorkflowRecoveryRequest = {
		workflowId: WORKFLOW_ID,
		taskId: "recon",
		attemptId: "attempt-recon",
		executionKey: "execution-recon",
		epochRef: EPOCH,
		persistedChildIdentity: null,
		evidenceRefs: [],
	};
	const reattached = authorityFixture({ recoveryOutcome: reconciliationOutcome("reattached") });
	await expect(reattached.runtime.recover(request)).resolves.toMatchObject({ disposition: "reattached" });
	expect(reattached.scheduler.onEvent as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	const replacement = {
		stageId: request.taskId,
		dispatchInput: {
			workflowId: WORKFLOW_ID,
			taskId: request.taskId,
			attemptId: "attempt-replacement",
			executionKey: "execution-replacement",
			epochRef: EPOCH,
		} as WorkflowCanonicalDispatchInput,
		queuedAt: "2030-01-01T00:01:00.000Z",
	};
	await expect(reattached.runtime.reassign({ request, replacement })).rejects.toThrow(
		"workflow_task_runtime_reassignment_not_proven",
	);
	expect(reattached.scheduler.enqueue as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

	const proven = reconciliationOutcome("proven_not_executed");
	const replayResult = {
		workflowId: WORKFLOW_ID,
		executionKey: request.executionKey,
		events: [
			{
				workflowId: WORKFLOW_ID,
				sequence: 1,
				payload: {
					kind: "workflow_reconciliation_recorded",
					workflowId: WORKFLOW_ID,
					attemptId: request.attemptId,
					epochRef: EPOCH,
					outcome: proven,
					outcomeDigest: digestObject(proven),
				},
				eventDigest: "event-digest",
				writerIdentity: "writer-root",
			},
		],
		head: { workflowId: WORKFLOW_ID, sequence: 1, eventDigest: "event-digest", epochRef: EPOCH },
		quarantined: false,
		quarantineReason: null,
	} as never;
	const provenRuntime = authorityFixture({ recoveryOutcome: proven, replayResult });
	await expect(provenRuntime.runtime.recover(request)).resolves.toMatchObject({
		disposition: "proven_not_executed",
	});
	expect(provenRuntime.scheduler.onEvent as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "recovery_reconciled", attemptId: request.attemptId, eventSequence: 1 }),
	);
	await provenRuntime.runtime.reassign({ request, replacement });
	expect(provenRuntime.scheduler.enqueue as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
		replacement.dispatchInput,
		replacement.queuedAt,
	);
});
