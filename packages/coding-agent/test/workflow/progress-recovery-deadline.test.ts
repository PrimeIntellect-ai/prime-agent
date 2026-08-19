import { afterEach, expect, it, vi } from "vitest";
import type {
	WorkflowArtifactPublishInput,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalCommit,
	WorkflowJournalHead,
	WorkflowOutboxAppender,
	WorkflowProgressLease,
	WorkflowProgressPredicate,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreDurableContext,
	WorkflowStoreCommitInput,
	WorkflowStoreCommitResult,
} from "../../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject, sha256Hex } from "../../src/core/workflow/contracts.js";
import { createDefaultTaskRuntimeAuthority } from "../../src/core/workflow/default-task-runtime-authority.js";
import type { WorkflowTask, WorkflowTaskGraph } from "../../src/core/workflow/task-graph.js";
import type { WorkflowPrimeStageEvidenceAdapter } from "../../src/core/workflow/task-runtime-authority.js";

const WORKFLOW_ID = "progress-recovery-deadline";
const ROOT_SESSION_ID = "root-session";
const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const BASE_TIME = Date.parse("2026-08-18T00:00:00.000Z");
const GOAL_REVISION_DIGEST = digestObject({ goal: WORKFLOW_ID });

afterEach(() => {
	vi.useRealTimers();
});

it("persists a bounded recovery wake across restart and admits exactly one fresh attempt", async () => {
	vi.useFakeTimers();
	const fixture = progressRecoveryFixture();
	let nowMs = BASE_TIME;
	let workflowStatus: "active" | "paused" = "paused";
	const scheduleProgressWake = vi.fn(async () => "scheduled" as const);
	const blockWorkflow = vi.fn(async () => undefined);
	const workerLauncher = vi.fn(
		async (input: {
			readonly workflowId: string;
			readonly taskId: string;
			readonly attemptId: string;
			readonly executionKey: string;
		}) => ({
			workerId: `worker:${input.taskId}`,
			executionIdentity: `execution:${input.executionKey}`,
			processStartId: "process-start",
			processGroupId: "process-group",
			launchedAt: new Date(nowMs).toISOString(),
			completion: Promise.resolve({
				kind: "worker" as const,
				binding: {
					workflowId: input.workflowId,
					taskId: input.taskId,
					attemptId: input.attemptId,
					executionKey: input.executionKey,
				},
				status: "completed" as const,
				output: "accepted result",
				error: null,
				retryable: false,
			}),
		}),
	);
	const authorityInput = {
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: {
			decisionScope: { kind: "workflow" as const, workflowId: WORKFLOW_ID, rootSessionId: ROOT_SESSION_ID },
			decisionId: "resource-decision",
			revision: 1,
			storeEpoch: EPOCH.storeEpoch,
			coordinatorEpoch: EPOCH.coordinatorEpoch,
			decisionDigest: digestObject({ decision: WORKFLOW_ID }),
		},
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: fixture.graph,
		maxWorkers: 1,
		now: () => new Date(nowMs).toISOString(),
		progressLeaseDurationMs: 10,
		scheduleProgressWake,
		readWorkflowStatus: () => ({ status: workflowStatus, blocked: undefined }),
		workerLauncher,
		blockWorkflow,
		prime: fixture.prime,
	};

	const first = createDefaultTaskRuntimeAuthority(authorityInput);
	await first.start();

	nowMs = BASE_TIME + 11;
	await vi.advanceTimersByTimeAsync(11);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_stalled")).toHaveLength(1);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_recovery_started")).toHaveLength(
		1,
	);
	const recoveryStarted = fixture.events.find((event) => event.payload.kind === "workflow_progress_recovery_started");
	if (recoveryStarted?.payload.kind !== "workflow_progress_recovery_started")
		throw new Error("progress recovery start event missing");
	const persistedAfterRecovery = fixture.auxiliary.get("default-prime-task-runtime-v1.json");
	if (persistedAfterRecovery === undefined) throw new Error("progress recovery state was not persisted");
	const persistedState = JSON.parse(new TextDecoder().decode(persistedAfterRecovery)) as {
		readonly progressRecoveryWake?: {
			readonly recoveryStartedAt: string;
			readonly deadlineAt: string;
			readonly status: string;
		};
	};
	const wake = persistedState.progressRecoveryWake;
	if (wake === undefined) throw new Error("host recovery wake was not persisted");
	expect(wake.status).toBe("pending");
	expect(Date.parse(wake.deadlineAt) - Date.parse(wake.recoveryStartedAt)).toBeLessThanOrEqual(120_000);

	const reopened = createDefaultTaskRuntimeAuthority(authorityInput);
	await reopened.start();
	await reopened.recordTelemetry({
		dispatchLatencyMs: 1,
		childWaitMs: 1,
		idleTimeMs: 1,
		duplicateScans: 1,
		testRuntimeMs: 1,
		blockedCapacityReason: null,
	});
	const persistedAfterTelemetry = fixture.auxiliary.get("default-prime-task-runtime-v1.json");
	if (persistedAfterTelemetry === undefined) throw new Error("telemetry state was not persisted");
	const telemetryState = JSON.parse(new TextDecoder().decode(persistedAfterTelemetry)) as {
		readonly progressRecoveryWake?: { readonly deadlineAt: string };
	};
	expect(telemetryState.progressRecoveryWake?.deadlineAt).toBe(wake.deadlineAt);

	workflowStatus = "active";
	nowMs = Date.parse(wake.deadlineAt) + 1;
	await vi.advanceTimersByTimeAsync(120_001);
	await vi.waitFor(() => expect(workerLauncher).toHaveBeenCalledTimes(1));
	await vi.waitFor(() => {
		expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_lease_closed")).toHaveLength(1);
	});
	expect(blockWorkflow).not.toHaveBeenCalled();
	expect(scheduleProgressWake).toHaveBeenCalledTimes(1);

	const terminalRestart = createDefaultTaskRuntimeAuthority(authorityInput);
	await terminalRestart.start();
	expect(workerLauncher).toHaveBeenCalledTimes(1);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_dispatch_intent")).toHaveLength(1);
});

function progressRecoveryFixture(): {
	readonly store: WorkflowRuntimeStore;
	readonly graph: WorkflowTaskGraph;
	readonly prime: WorkflowPrimeStageEvidenceAdapter;
	readonly events: WorkflowJournalCommit<WorkflowEventPayload>[];
	readonly auxiliary: Map<string, Uint8Array>;
} {
	const task: WorkflowTask = {
		taskId: "recon",
		planRevision: 1,
		objective: "recover the stalled task",
		requirementIds: [],
		completionCriteria: ["accepted result"],
		dependencyTaskIds: [],
		ownedPaths: [],
		ownedContracts: [],
		requiredSkillSnapshotDigests: [],
		verificationCommandDigests: [],
		authority: ["read_workspace"],
		declaredResourceVector: {
			cpuMilliCores: 1,
			memoryBytes: 1,
			diskBytes: 1,
			ioWeight: 1,
			accelerators: [],
			providers: [],
			networkEgressBytes: 0,
			wallMilliseconds: 1,
			monetaryMicrounits: 0,
		},
		declaredControlCapacity: {
			processSlots: 0,
			childSessionSlots: 0,
			modelCallSlots: 0,
			modelInputTokens: 0,
			modelOutputTokens: 0,
			verificationSlots: 0,
			redTeamSlots: 0,
			recoverySlots: 0,
		},
		status: "ready",
		attemptIds: [],
	};
	const graph: WorkflowTaskGraph = {
		graphRevision: 1,
		tasks: [task],
		byId: new Map([[task.taskId, task]]),
		allowedAuthority: ["read_workspace"],
		ownershipPaths: [],
		generatedOutputPaths: [],
		lockPaths: [],
		namedContracts: [],
		graphDigest: digestObject(task),
	};
	const events: WorkflowJournalCommit<WorkflowEventPayload>[] = [];
	const auxiliary = new Map<string, Uint8Array>();
	const artifacts = new Map<string, Uint8Array>();
	const commits = new Map<string, WorkflowStoreCommitResult<WorkflowEventPayload>>();
	const leaseRef = {
		...EPOCH,
		leaseId: "root-lease",
		acquisitionEventSequence: 1,
		processIdentity: "root-process",
		rootDigest: "root-digest",
		writerIdentity: "workflow-host",
		acquiredAt: new Date(BASE_TIME).toISOString(),
		expiresAt: "2030-01-01T00:00:00.000Z",
	};
	const initialHead: WorkflowJournalHead = {
		workflowId: WORKFLOW_ID,
		sequence: 0,
		eventDigest: null,
		epochRef: EPOCH,
	};
	const predicateWithoutDigest = {
		schemaVersion: 1 as const,
		kind: "task_terminal" as const,
		taskIds: [task.taskId],
		requiredOutcome: "accepted" as const,
		rejectedRenewalSignals: [
			"worker_activity",
			"timestamps",
			"token_use",
			"transcript_growth",
			"heartbeats",
			"test_counts",
			"reports",
			"status_rewrites",
			"task_splitting",
			"nonauthoritative_artifacts",
			"no_op_events",
		] as const,
	};
	const predicate: WorkflowProgressPredicate = {
		...predicateWithoutDigest,
		predicateDigest: digestObject(predicateWithoutDigest),
	};
	const cut = {
		schemaVersion: 1 as const,
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		boundaryRevisionDigest: graph.graphDigest,
		journalHead: initialHead,
		nextGate: task.taskId,
		readyTaskIds: [task.taskId],
		terminalTaskIds: [],
		readyTaskSetDigest: digestObject([task.taskId]),
		unresolvedGatingObligationDigests: [],
		unresolvedEffectDigests: [],
		lastAuthenticatedOutcomeEvidenceRef: null,
		lastAuthoritativeProgressAt: new Date(BASE_TIME).toISOString(),
		semanticProgressDigest: digestObject({ readyTaskIds: [task.taskId] }),
	};
	const leaseWithoutDigest = {
		schemaVersion: 1 as const,
		leaseId: "progress:preloaded",
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		baseJournalHead: initialHead,
		progressCutDigest: digestObject(cut),
		baseSemanticProgressDigest: cut.semanticProgressDigest,
		expectedTransitionPredicate: predicate,
		expectedTransitionPredicateDigest: predicate.predicateDigest,
		adversarialReviewDigest: digestObject({ predicateDigest: predicate.predicateDigest }),
		owner: leaseRef.writerIdentity,
		acquiredAt: new Date(BASE_TIME).toISOString(),
		deadline: new Date(BASE_TIME + 10).toISOString(),
		wakeObligationId: "progress-wake:preloaded",
		recoveryAttempt: 0,
	};
	const lease: WorkflowProgressLease = { ...leaseWithoutDigest, leaseDigest: digestObject(leaseWithoutDigest) };
	appendEvent(
		events,
		leaseRef,
		{
			kind: "workflow_progress_lease_acquired",
			workflowId: WORKFLOW_ID,
			epochRef: EPOCH,
			cut,
			cutDigest: digestObject(cut),
			lease,
			leaseDigest: lease.leaseDigest,
			sourceOutcome: null,
		},
		"preloaded-progress-lease",
		initialHead,
	);
	const head = (): WorkflowJournalHead => {
		const latest = events.at(-1);
		return latest === undefined
			? initialHead
			: { workflowId: WORKFLOW_ID, sequence: latest.sequence, eventDigest: latest.eventDigest, epochRef: EPOCH };
	};
	const commit = async <TPayload extends WorkflowEventPayload>(
		input: WorkflowStoreCommitInput<TPayload>,
	): Promise<WorkflowStoreCommitResult<TPayload>> => {
		const prior = commits.get(input.idempotencyKey);
		if (prior !== undefined) return { ...prior, status: "already_committed" } as WorkflowStoreCommitResult<TPayload>;
		if (digestObject(input.expectedHead) !== digestObject(head())) throw new Error("stale_progress_fixture_head");
		const sequence = head().sequence + 1;
		const eventDigest = digestObject({ sequence, payload: input.payload, prior: head().eventDigest });
		const commitRecord = appendEvent(
			events,
			leaseRef,
			input.payload,
			input.idempotencyKey,
			input.expectedHead,
			sequence,
		);
		const result: WorkflowStoreCommitResult<TPayload> = {
			status: "committed",
			payload: input.payload,
			commit: { ...commitRecord, eventDigest } as WorkflowJournalCommit<TPayload>,
			state: null,
			head: head(),
		};
		commits.set(input.idempotencyKey, result as WorkflowStoreCommitResult<WorkflowEventPayload>);
		return result;
	};
	const durable: WorkflowRuntimeStoreDurableContext = {
		generationId: "generation-progress-recovery",
		epochRef: EPOCH,
		currentLeaseRef: () => leaseRef,
		outbox: {} as WorkflowOutboxAppender,
		auxiliaryStore: {
			read: async (name) => auxiliary.get(name) ?? null,
			write: async (name, bytes) => {
				auxiliary.set(name, Uint8Array.from(bytes));
			},
		},
		withExclusiveLease: async <T>(_boundary: string, operation: () => Promise<T>) => operation(),
		recoverJournal: async () => ({
			quarantined: false,
			events: [],
			metadata: {
				status: "complete" as const,
				sourcePath: "",
				sourceDigest: "",
				sourceSizeBytes: 0,
				sequence: null,
				epochRef: EPOCH,
				reason: "none" as const,
			},
		}),
	};
	const store: WorkflowRuntimeStore = {
		identity: {
			storeKind: "workflow",
			namespace: "test",
			rootDir: "/tmp",
			storeId: WORKFLOW_ID,
			workflowId: WORKFLOW_ID,
			identityDigest: digestObject({ workflowId: WORKFLOW_ID }),
		},
		durableContext: durable,
		commit,
		replay: async () => ({
			workflowId: WORKFLOW_ID,
			executionKey: events.at(-1)?.executionKey ?? null,
			events: [...events],
			head: head(),
			quarantined: false,
			quarantineReason: null,
		}),
		publishArtifact: async (input: WorkflowArtifactPublishInput) => {
			const digest = sha256Hex(input.bytes);
			artifacts.set(digest, input.bytes);
			return {
				status: "published" as const,
				envelope: {
					ref: {
						artifactId: `artifact:${digest}`,
						relativePath: `artifacts/${digest}`,
						digest,
						sizeBytes: input.bytes.byteLength,
						sourceEventSequence: input.sourceEventSequence,
					},
					payloadKind: input.payloadKind,
					codec: input.codec,
					immutable: true as const,
				},
			};
		},
		publishSnapshot: async () => {
			throw new Error("snapshot_not_used");
		},
		compareAndSwapProjection: async () => {
			throw new Error("projection_not_used");
		},
		appendOutbox: async () => {
			throw new Error("outbox_not_used");
		},
		replaceCoordinatorEpoch: async () => {
			throw new Error("rotation_not_used");
		},
		replaceStoreEpoch: async () => {
			throw new Error("rotation_not_used");
		},
	};
	return { store, graph, prime: primeAdapter(), events, auxiliary };
}

function appendEvent<TPayload extends WorkflowEventPayload>(
	events: WorkflowJournalCommit<WorkflowEventPayload>[],
	leaseRef: ReturnType<typeof rootLease>,
	payload: TPayload,
	idempotencyKey: string,
	expectedHead: WorkflowJournalHead,
	sequence = expectedHead.sequence + 1,
): WorkflowJournalCommit<TPayload> {
	const eventDigest = digestObject({ sequence, payload, prior: expectedHead.eventDigest });
	const event = {
		workflowId: WORKFLOW_ID,
		sequence,
		payload,
		payloadBytes: canonicalJsonBytes(payload),
		payloadDigest: digestObject(payload),
		priorEventDigest: expectedHead.eventDigest,
		eventDigest,
		expectedHead,
		epochRef: EPOCH,
		leaseRef,
		idempotencyKey,
		semanticBinding: {} as never,
		executionKey: null,
		writerIdentity: leaseRef.writerIdentity,
	} as unknown as WorkflowJournalCommit<TPayload>;
	events.push(event as WorkflowJournalCommit<WorkflowEventPayload>);
	return event;
}

function rootLease(): {
	readonly storeEpoch: number;
	readonly coordinatorEpoch: number;
	readonly leaseId: string;
	readonly acquisitionEventSequence: number;
	readonly processIdentity: string;
	readonly rootDigest: string;
	readonly writerIdentity: string;
	readonly acquiredAt: string;
	readonly expiresAt: string;
} {
	return {
		...EPOCH,
		leaseId: "root-lease",
		acquisitionEventSequence: 1,
		processIdentity: "root-process",
		rootDigest: "root-digest",
		writerIdentity: "workflow-host",
		acquiredAt: new Date(BASE_TIME).toISOString(),
		expiresAt: "2030-01-01T00:00:00.000Z",
	};
}

function primeAdapter(): WorkflowPrimeStageEvidenceAdapter {
	return {
		recordEvidence: async () => ({
			boundary: "public_boundary",
			verification: "host_verified",
			evidenceKind: "durable_store",
			authorizesTerminalization: true,
		}),
		readCoordinatorStatus: async () => {
			throw new Error("coordinator_status_not_used");
		},
		recordTelemetry: async () => undefined,
		assertStageAcceptable: async () => undefined,
		acceptStage: async () => undefined,
		readAudit: async () => ({ terminalTaskIds: [], launchEvidenceRefs: [], workerResults: [] }),
	};
}
