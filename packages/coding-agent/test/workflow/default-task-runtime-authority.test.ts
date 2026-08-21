import { expect, it, vi } from "vitest";
import type {
	WorkflowArtifactPublishInput,
	WorkflowArtifactRef,
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalCommit,
	WorkflowJournalHead,
	WorkflowRuntimeStore,
	WorkflowStoreCommitInput,
	WorkflowStoreCommitResult,
} from "../../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
} from "../../src/core/workflow/contracts.js";
import {
	type DefaultPrimeWorkerCompletion,
	type DefaultPrimeWorkerCompletionBinding,
	type DefaultPrimeWorkerLaunch,
	type DefaultPrimeWorkerTaskCapsule,
	type DefaultPrimeWorkerTaskCapsuleCore,
	defaultPrimeWorkerOutputContract,
	defaultPrimeWorkerTaskCapsuleDigest,
	defaultPrimeWorkerTaskCapsuleReceiptBindingDigest,
} from "../../src/core/workflow/default-task-runtime.js";
import { createDefaultTaskRuntimeAuthority as createDefaultTaskRuntimeAuthorityImpl } from "../../src/core/workflow/default-task-runtime-authority.js";
import { decodeWorkflowEventPayload } from "../../src/core/workflow/journal.js";
import type { WorkflowExternalBlockerInput } from "../../src/core/workflow/phase-host.js";
import type { WorkflowTask, WorkflowTaskGraph } from "../../src/core/workflow/task-graph.js";
import type { WorkflowPrimeStageEvidenceAdapter } from "../../src/core/workflow/task-runtime-authority.js";

const WORKFLOW_ID = "default-task-runtime-fast";
const ROOT_SESSION_ID = "root-session-fast";
const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const NOW = "2026-08-17T20:00:00.000Z";
const GOAL_REVISION_DIGEST = digestObject({ sourceBindingDigest: "immutable-goal-source" });

type TestStrictTaskRuntimeAuthorityInput = Parameters<typeof createDefaultTaskRuntimeAuthorityImpl>[0];
type TestLegacyWorkerCompletion = {
	readonly kind?: "worker";
	readonly status: "completed" | "error" | "cancelled";
	readonly output: string;
	readonly error: string | null;
	readonly retryable: boolean;
	readonly binding?: DefaultPrimeWorkerCompletionBinding;
};
type TestForgedHostCompletion = {
	readonly kind: "host";
	readonly status: "error";
	readonly output: "";
	readonly error: "task_deadline_expired" | "task_resource_lease_expired";
	readonly retryable: true;
};
type TestCompletionEnvelope = TestLegacyWorkerCompletion | TestForgedHostCompletion;
type TestWorkerLauncherRequest = Parameters<NonNullable<TestStrictTaskRuntimeAuthorityInput["workerLauncher"]>>[0];
type TestWorkerLaunch = Omit<
	Awaited<ReturnType<NonNullable<TestStrictTaskRuntimeAuthorityInput["workerLauncher"]>>>,
	"completion"
> & {
	readonly completion?: Promise<TestCompletionEnvelope>;
};
type TestWorkerLauncher = (request: TestWorkerLauncherRequest) => Promise<TestWorkerLaunch>;
type TestTaskRuntimeAuthorityInput = Omit<TestStrictTaskRuntimeAuthorityInput, "workerLauncher"> & {
	readonly workerLauncher?: TestWorkerLauncher;
};

function bindLegacyWorkerCompletions(launcher: TestWorkerLauncher): TestWorkerLauncher {
	return async (request) => {
		const launched = await launcher(request);
		if (launched.completion === undefined || !(launched.completion instanceof Promise)) return launched;
		const completion: Promise<TestCompletionEnvelope> = launched.completion.then((value) =>
			value.kind === undefined
				? {
						...value,
						kind: "worker" as const,
						binding: {
							workflowId: request.workflowId,
							taskId: request.taskId,
							attemptId: request.attemptId,
							executionKey: request.executionKey,
						},
					}
				: (value as unknown as TestCompletionEnvelope),
		);
		return { ...launched, completion };
	};
}

function createDefaultTaskRuntimeAuthority(input: TestTaskRuntimeAuthorityInput) {
	return createDefaultTaskRuntimeAuthorityImpl({
		...input,
		workerLauncher:
			input.workerLauncher === undefined
				? undefined
				: (bindLegacyWorkerCompletions(
						input.workerLauncher,
					) as unknown as TestStrictTaskRuntimeAuthorityInput["workerLauncher"]),
	} as TestStrictTaskRuntimeAuthorityInput);
}

function task(taskId = "recon", dependencyTaskIds: readonly string[] = []): WorkflowTask {
	return {
		taskId,
		planRevision: 1,
		objective: "inspect the public outcome",
		requirementIds: [],
		completionCriteria: ["public outcome is evidenced"],
		dependencyTaskIds,
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
}

function twoStageGraph(): WorkflowTaskGraph {
	const recon = task("recon");
	const verify = task("verify", ["recon"]);
	const tasks = [recon, verify];
	return {
		graphRevision: 1,
		tasks,
		byId: new Map(tasks.map((stage) => [stage.taskId, stage])),
		allowedAuthority: ["read_workspace"],
		ownershipPaths: [],
		generatedOutputPaths: [],
		lockPaths: [],
		namedContracts: [],
		graphDigest: digestObject(tasks),
	};
}

function threeStageGraph(): WorkflowTaskGraph {
	const recon = task("recon");
	const lens = task("lens", ["recon"]);
	const verify = task("verify", ["lens"]);
	const tasks = [recon, lens, verify];
	return {
		graphRevision: 1,
		tasks,
		byId: new Map(tasks.map((stage) => [stage.taskId, stage])),
		allowedAuthority: ["read_workspace"],
		ownershipPaths: [],
		generatedOutputPaths: [],
		lockPaths: [],
		namedContracts: [],
		graphDigest: digestObject(tasks),
	};
}

function graph(): WorkflowTaskGraph {
	const stage = task();
	return {
		graphRevision: 1,
		tasks: [stage],
		byId: new Map([[stage.taskId, stage]]),
		allowedAuthority: ["read_workspace"],
		ownershipPaths: [],
		generatedOutputPaths: [],
		lockPaths: [],
		namedContracts: [],
		graphDigest: digestObject(stage),
	};
}

function generatedOutputGraph(): WorkflowTaskGraph {
	const stage = task();
	const generatedOutputPaths = ["artifacts/out"];
	return {
		graphRevision: 1,
		tasks: [stage],
		byId: new Map([[stage.taskId, stage]]),
		allowedAuthority: ["read_workspace"],
		ownershipPaths: [],
		generatedOutputPaths,
		lockPaths: generatedOutputPaths,
		namedContracts: ["evidence-recon"],
		graphDigest: digestObject({ stage, generatedOutputPaths }),
	};
}

function taskCapsuleFactory(
	graph: WorkflowTaskGraph,
): NonNullable<Parameters<typeof createDefaultTaskRuntimeAuthority>[0]["createTaskCapsule"]> {
	return async (request) => {
		const core: DefaultPrimeWorkerTaskCapsuleCore = {
			schemaVersion: 1,
			kind: "default_prime_worker_task_capsule",
			workflowId: WORKFLOW_ID,
			taskId: request.task.taskId,
			attemptId: request.attemptId,
			executionKey: request.executionKey,
			epochRef: request.epochRef,
			journalHead: request.journalHead,
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			goalBindingDigest: digestObject({ immutableGoal: GOAL_REVISION_DIGEST }),
			graphDigest: graph.graphDigest,
			recipeCapability: "builtin_adaptive_prime",
			recipeDigest: "a".repeat(64),
			admissionDigest: "b".repeat(64),
			objective: request.task.objective,
			requirementIds: request.task.requirementIds,
			completionCriteria: request.task.completionCriteria,
			dependencyTaskIds: request.task.dependencyTaskIds,
			authority: request.task.authority,
			deadlineAt: request.deadlineAt,
			outputContract: defaultPrimeWorkerOutputContract({
				taskId: request.task.taskId,
				logicalPath: "artifacts/out/recon.json",
				evidencePolicyId: "evidence-recon",
				maxBytes: 4096,
				maxItems: 8,
				independent: true,
			}),
			forbiddenOutcomes: ["prose_only_result", "unbound_or_extra_output", "protected_or_holdout_data"],
			terminalReturnProtocol: "canonical_json_only",
		};
		const capsuleDigest = defaultPrimeWorkerTaskCapsuleDigest(core);
		const artifactRef: WorkflowArtifactRef = {
			artifactId: "task-capsule-receipt",
			relativePath: `artifacts/evidence/${"c".repeat(64)}`,
			digest: "c".repeat(64),
			sizeBytes: 1,
			sourceEventSequence: request.journalHead.sequence,
		};
		return {
			...core,
			capsuleDigest,
			receipt: {
				receiptKind: "artifact" as const,
				oneUse: false,
				receiptId: "task-capsule-receipt",
				issuerId: "workflow-host",
				workflowId: WORKFLOW_ID,
				bindingDigest: defaultPrimeWorkerTaskCapsuleReceiptBindingDigest(capsuleDigest),
				payloadDigest: capsuleDigest,
				artifactRef,
				issuedAt: NOW,
				validUntil: "2026-08-18T21:00:00.000Z",
				keyId: "workflow-host-key",
				signatureAlgorithm: "ed25519" as const,
				artifactBytesDigest: artifactRef.digest,
				stateDigest: request.journalHead.eventDigest!,
				revision: 1,
				signature: "signed",
				verificationDigest: "verified",
			},
		};
	};
}

function decisionRefFor(epoch: WorkflowEpochRef = EPOCH): WorkflowDecisionRef {
	return {
		decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: ROOT_SESSION_ID },
		decisionId: "decision-fast",
		revision: 1,
		storeEpoch: epoch.storeEpoch,
		coordinatorEpoch: epoch.coordinatorEpoch,
		decisionDigest: "decision-fast-digest",
	};
}

function decisionRef(): WorkflowDecisionRef {
	return decisionRefFor();
}

it("rejects an unsatisfiable generated-output contract before worker launch", async () => {
	const fixture = runtimeStoreFixture();
	const launchWorker = vi.fn(async () => {
		throw new Error("worker must not launch without a satisfiable output contract");
	});
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: generatedOutputGraph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		prime: primeAdapter(),
	});

	await expect(authority.start()).rejects.toThrow("default_prime_task_contract_unsatisfiable");
	expect(launchWorker).not.toHaveBeenCalled();
	expect(
		fixture.events.some(
			(event) =>
				event.payload.kind === "workflow_resource_lease_acquired" ||
				event.payload.kind === "workflow_dispatch_intent",
		),
	).toBe(false);
});

it("launches a signed capsule and publishes its one allowed output as recon evidence", async () => {
	const fixture = runtimeStoreFixture();
	const taskGraph = generatedOutputGraph();
	const launchWorker = vi.fn(async () => ({
		workerId: "worker:recon",
		executionIdentity: "rlm:worker:recon:capsule",
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: NOW,
		completion: Promise.resolve({
			status: "completed" as const,
			output: new TextDecoder().decode(
				canonicalJsonBytes({
					findings: ["immutable training inputs are readable"],
					kind: "default_prime_task_output_v1",
					schemaVersion: 1,
					summary: "Recon contract satisfied",
					taskId: "recon",
				}),
			),
			error: null,
			retryable: false,
		}),
	}));
	const createTaskCapsule = vi.fn(taskCapsuleFactory(taskGraph));
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: taskGraph,
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		createTaskCapsule,
		prime: primeAdapter(),
	});

	await authority.start();
	await vi.waitFor(async () => {
		await expect(authority.readAudit()).resolves.toMatchObject({ terminalTaskIds: ["recon"] });
	});
	expect(createTaskCapsule).toHaveBeenCalledTimes(1);
	expect(launchWorker).toHaveBeenCalledWith(
		expect.objectContaining({
			taskCapsule: expect.objectContaining({
				taskId: "recon",
				outputContract: expect.objectContaining({
					logicalPath: "artifacts/out/recon.json",
					resultChannel: "terminal_assistant_response",
					jsonSchema: expect.objectContaining({
						additionalProperties: false,
						required: ["findings", "kind", "schemaVersion", "summary", "taskId"],
					}),
					canonicalExample: {
						findings: ["one concise evidence-backed finding"],
						kind: "default_prime_task_output_v1",
						schemaVersion: 1,
						summary: "one concise task outcome",
						taskId: "recon",
					},
				}),
			}),
			prompt: expect.stringMatching(
				/(?=.*artifacts\/out\/recon\.json)(?=.*"resultChannel":"terminal_assistant_response")/s,
			),
		}),
	);
	const audit = await authority.readAudit();
	const resultRef = audit.workerResults[0]?.resultEvidenceRef;
	if (resultRef === undefined) throw new Error("capsule result evidence is absent");
	expect(parseCanonicalJsonBytes(fixture.artifacts.get(resultRef.digest)!)).toMatchObject({
		kind: "default-prime-autoresearch-evidence",
		workflowId: WORKFLOW_ID,
		taskId: "recon",
		logicalPath: "artifacts/out/recon.json",
		evidencePolicyId: "evidence-recon",
		independent: true,
		output: { summary: "Recon contract satisfied" },
	});
});

it("rejects commentary-prefixed canonical output and admits one fresh retry before its recovery deadline", async () => {
	const fixture = runtimeStoreFixture();
	const taskGraph = generatedOutputGraph();
	const acceptedJson = new TextDecoder().decode(
		canonicalJsonBytes({
			findings: ["immutable training inputs are readable"],
			kind: "default_prime_task_output_v1",
			schemaVersion: 1,
			summary: "Recon contract satisfied",
			taskId: "recon",
		}),
	);
	let resolveFirstCompletion: (completion: TestLegacyWorkerCompletion) => void = () => {
		throw new Error("retryable result completion was not initialized");
	};
	const firstCompletion = new Promise<TestLegacyWorkerCompletion>((resolve) => {
		resolveFirstCompletion = resolve;
	});
	const pendingRetry = new Promise<TestLegacyWorkerCompletion>(() => undefined);
	const launchWorker = vi.fn(
		async (input: { readonly attemptId: string; readonly executionKey: string; readonly taskId: string }) => ({
			workerId: `worker:${input.attemptId}`,
			executionIdentity: `rlm:${input.executionKey}`,
			processStartId: `host:${input.attemptId}`,
			processGroupId: `process-group:${input.attemptId}`,
			launchedAt: NOW,
			completion: launchWorker.mock.calls.length === 1 ? firstCompletion : pendingRetry,
		}),
	);
	let wakeScheduleAttempts = 0;
	const scheduleProgressWake = vi.fn(async () => {
		wakeScheduleAttempts += 1;
		if (wakeScheduleAttempts === 1) throw new Error("scheduler_process_lost_after_result_commit");
		return "already_scheduled" as const;
	});
	const blockWorkflow = vi.fn(async () => undefined);
	let workflowStatus: "active" | "paused" = "active";
	const createAuthority = () =>
		createDefaultTaskRuntimeAuthority({
			runtimeStore: fixture.store,
			workflowId: WORKFLOW_ID,
			rootSessionId: ROOT_SESSION_ID,
			epochRef: EPOCH,
			decisionRef: decisionRef(),
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			graph: taskGraph,
			maxWorkers: 1,
			now: () => NOW,
			workerLauncher: launchWorker,
			createTaskCapsule: taskCapsuleFactory(taskGraph),
			scheduleProgressWake,
			readWorkflowStatus: () => ({ status: workflowStatus, blocked: undefined }),
			blockWorkflow,
			prime: primeAdapter(),
		});
	const authority = createAuthority();

	await authority.start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	workflowStatus = "paused";
	resolveFirstCompletion({
		status: "completed",
		output: `Recon complete.\n${acceptedJson}`,
		error: null,
		retryable: false,
	});
	await vi.waitFor(async () => {
		await expect(authority.readAudit()).resolves.toMatchObject({
			terminalTaskIds: [],
			workerResults: [
				expect.objectContaining({
					status: "error",
					error: "worker_output_contract_invalid",
					retryable: true,
					recoveryDecision: "replan_required",
				}),
			],
		});
	});
	expect(launchWorker).toHaveBeenCalledTimes(1);
	const audit = await authority.readAudit();
	const resultRef = audit.workerResults[0]?.resultEvidenceRef;
	if (resultRef === undefined) throw new Error("invalid output result evidence is absent");
	expect(parseCanonicalJsonBytes(fixture.artifacts.get(resultRef.digest)!)).toMatchObject({
		kind: "default_prime_worker_terminal_packet",
		status: "error",
		error: "worker_output_contract_invalid",
		retryable: true,
	});
	const recoveryStarted = fixture.events.find((event) => event.payload.kind === "workflow_progress_recovery_started");
	if (recoveryStarted?.payload.kind !== "workflow_progress_recovery_started")
		throw new Error("retryable result recovery was not journaled");
	const persisted = fixture.auxiliary.get("default-prime-task-runtime-v1.json");
	if (persisted === undefined) throw new Error("retryable result recovery state is absent");
	const state = parseCanonicalJsonBytes(persisted) as {
		readonly progressRecoveryWake: {
			readonly recoveryStartedAt: string;
			readonly deadlineAt: string;
			readonly status: string;
		};
	};
	expect(state.progressRecoveryWake.recoveryStartedAt).toBe(NOW);
	expect(Date.parse(state.progressRecoveryWake.deadlineAt) - Date.parse(NOW)).toBe(120_000);
	expect(state.progressRecoveryWake.status).toBe("pending");
	expect(scheduleProgressWake).toHaveBeenCalledTimes(1);
	expect(blockWorkflow).not.toHaveBeenCalled();

	workflowStatus = "active";
	const reopened = createAuthority();
	await reopened.start();
	await vi.waitFor(() => expect(launchWorker).toHaveBeenCalledTimes(2));
	expect(scheduleProgressWake).toHaveBeenCalledTimes(1);
	const firstAttempt = launchWorker.mock.calls[0]?.[0];
	const retryAttempt = launchWorker.mock.calls[1]?.[0];
	expect(retryAttempt?.attemptId).not.toBe(firstAttempt?.attemptId);
	expect(retryAttempt?.executionKey).not.toBe(firstAttempt?.executionKey);
	const admittedBytes = fixture.auxiliary.get("default-prime-task-runtime-v1.json");
	if (admittedBytes === undefined) throw new Error("admitted recovery state is absent");
	expect(
		(parseCanonicalJsonBytes(admittedBytes) as { readonly progressRecoveryWake: { readonly status: string } })
			.progressRecoveryWake.status,
	).toBe("admitted");

	await createAuthority().start();
	expect(launchWorker).toHaveBeenCalledTimes(2);
});

function primeAdapter(): WorkflowPrimeStageEvidenceAdapter {
	return {
		recordEvidence: async () => ({
			boundary: "public_boundary",
			verification: "host_verified",
			evidenceKind: "durable_store",
			authorizesTerminalization: true,
		}),
		readCoordinatorStatus: async () => {
			throw new Error("fast_fixture_status_not_used");
		},
		recordTelemetry: async () => undefined,
		assertStageAcceptable: async () => undefined,
		acceptStage: async () => undefined,
		readAudit: async () => ({ terminalTaskIds: [], launchEvidenceRefs: [], workerResults: [] }),
	};
}

function runtimeStoreFixture(): {
	readonly store: WorkflowRuntimeStore;
	readonly events: WorkflowJournalCommit<WorkflowEventPayload>[];
	readonly artifacts: Map<string, Uint8Array>;
	readonly auxiliary: Map<string, Uint8Array>;
	advanceHeadBeforeNextCommit(): void;
	advanceJournalHeadBeforeNextCommit(): void;
	advanceHeadBeforeEveryCommit(): void;
	advanceHeadBeforeCommitKind(kind: WorkflowEventPayload["kind"]): void;
	holdBeforeCommitKind(kind: WorkflowEventPayload["kind"]): () => void;
	failBeforeCommitKind(kind: WorkflowEventPayload["kind"]): void;
	failBeforeCommitKindWithError(kind: WorkflowEventPayload["kind"], message: string): void;
	failEveryCommitKindWithError(kind: WorkflowEventPayload["kind"], message: string): void;
	setCurrentEpoch(epoch: WorkflowEpochRef, generationId?: string): void;
} {
	const events: WorkflowJournalCommit<WorkflowEventPayload>[] = [];
	const auxiliary = new Map<string, Uint8Array>();
	const artifacts = new Map<string, Uint8Array>();
	const commits = new Map<string, WorkflowStoreCommitResult<WorkflowEventPayload>>();
	let currentEpoch = EPOCH;
	let currentGenerationId = "generation-fast";
	let advanceHeadBeforeNextCommit = false;
	let advanceJournalHeadBeforeNextCommit = false;
	let advanceHeadBeforeEveryCommit = false;
	let advanceHeadBeforeCommitKind: WorkflowEventPayload["kind"] | undefined;
	let heldCommitKind: WorkflowEventPayload["kind"] | undefined;
	let heldCommit: Promise<void> | null = null;
	let failedCommitKind: WorkflowEventPayload["kind"] | undefined;
	let failedCommitMessage = "simulated workflow owner process death";
	let repeatedlyFailedCommitKind: WorkflowEventPayload["kind"] | undefined;
	let repeatedlyFailedCommitMessage = "simulated persistent workflow owner failure";
	const leaseRef = {
		...EPOCH,
		leaseId: "root-lease-fast",
		acquisitionEventSequence: 1,
		processIdentity: "process-fast",
		rootDigest: "root-fast",
		writerIdentity: "writer-fast",
		acquiredAt: NOW,
		expiresAt: "2030-01-01T00:00:00.000Z",
	};
	const head = (): WorkflowJournalHead => {
		const event = events.at(-1);
		return {
			workflowId: WORKFLOW_ID,
			sequence: event?.sequence ?? 1,
			eventDigest: event?.eventDigest ?? digestObject({ kind: "w0-fast" }),
			epochRef: currentEpoch,
		};
	};
	const commit = async <TPayload extends WorkflowEventPayload>(
		input: WorkflowStoreCommitInput<TPayload>,
	): Promise<WorkflowStoreCommitResult<TPayload>> => {
		const prior = commits.get(input.idempotencyKey);
		if (prior !== undefined) return { ...prior, status: "already_committed" } as WorkflowStoreCommitResult<TPayload>;
		if (failedCommitKind === input.payload.kind) {
			failedCommitKind = undefined;
			const message = failedCommitMessage;
			failedCommitMessage = "simulated workflow owner process death";
			throw new Error(message);
		}
		if (repeatedlyFailedCommitKind === input.payload.kind) throw new Error(repeatedlyFailedCommitMessage);
		if (heldCommitKind === input.payload.kind && heldCommit !== null) {
			const pending = heldCommit;
			heldCommitKind = undefined;
			heldCommit = null;
			await pending;
		}
		if (
			advanceHeadBeforeNextCommit ||
			advanceJournalHeadBeforeNextCommit ||
			advanceHeadBeforeEveryCommit ||
			advanceHeadBeforeCommitKind === input.payload.kind
		) {
			advanceHeadBeforeNextCommit = false;
			if (advanceHeadBeforeCommitKind === input.payload.kind) advanceHeadBeforeCommitKind = undefined;
			const failAtJournalBoundary = advanceJournalHeadBeforeNextCommit;
			advanceJournalHeadBeforeNextCommit = false;
			const concurrentHead = head();
			const payload: WorkflowEventPayload = {
				kind: "workflow_recovery_started",
				workflowId: WORKFLOW_ID,
				epochRef: currentEpoch,
				journalHeadDigest: concurrentHead.eventDigest ?? "",
			};
			const sequence = concurrentHead.sequence + 1;
			const eventDigest = digestObject({ sequence, payload, prior: concurrentHead.eventDigest });
			events.push({
				workflowId: WORKFLOW_ID,
				sequence,
				payload,
				payloadBytes: canonicalJsonBytes(payload),
				payloadDigest: digestObject(payload),
				priorEventDigest: concurrentHead.eventDigest,
				eventDigest,
				expectedHead: concurrentHead,
				epochRef: EPOCH,
				leaseRef,
				idempotencyKey: "concurrent-worker-progress",
				semanticBinding: input.semanticBinding,
				executionKey: input.executionKey,
				writerIdentity: input.writerIdentity,
			} as unknown as WorkflowJournalCommit<WorkflowEventPayload>);
			if (failAtJournalBoundary) throw new Error("Workflow journal expected head is stale.");
		}
		if (digestObject(input.expectedHead) !== digestObject(head()))
			throw new Error(
				"Workflow store compare-and-swap precondition is stale or is not bound to the active writer and lease.",
			);
		const sequence = head().sequence + 1;
		const eventDigest = digestObject({ sequence, payload: input.payload, prior: head().eventDigest });
		const journalCommit = {
			workflowId: WORKFLOW_ID,
			sequence,
			payload: input.payload,
			payloadBytes: canonicalJsonBytes(input.payload),
			payloadDigest: digestObject(input.payload),
			priorEventDigest: head().eventDigest,
			eventDigest,
			expectedHead: input.expectedHead,
			epochRef: input.epochRef,
			leaseRef,
			idempotencyKey: input.idempotencyKey,
			recordVersion: 1,
			generationId: currentGenerationId,
			recordMac: "record-mac",
			recordChecksum: "record-checksum",
			returnProofId: `return-proof:${input.idempotencyKey}`,
			commitReturnProof: {} as WorkflowJournalCommit<WorkflowEventPayload>["commitReturnProof"],
			preparedFrameDigest: "prepared-frame-digest",
			committedFrameDigest: "committed-frame-digest",
			keyId: "key-fast",
			preparedFrameMac: "prepared-frame-mac",
			committedFrameMac: "committed-frame-mac",
			preparedFrameChecksum: "prepared-frame-checksum",
			committedFrameChecksum: "committed-frame-checksum",
			semanticBinding: input.semanticBinding,
			executionKey: input.executionKey,
			writerIdentity: input.writerIdentity,
		} as WorkflowJournalCommit<TPayload>;
		events.push(journalCommit as WorkflowJournalCommit<WorkflowEventPayload>);
		const result: WorkflowStoreCommitResult<TPayload> = {
			status: "committed",
			payload: input.payload,
			commit: journalCommit,
			state: null,
			head: head(),
		};
		commits.set(input.idempotencyKey, result as WorkflowStoreCommitResult<WorkflowEventPayload>);
		return result;
	};
	const publishArtifact = async (input: WorkflowArtifactPublishInput) => {
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
	};
	const store = {
		identity: {
			storeKind: "workflow" as const,
			namespace: "fast-test",
			rootDir: "/tmp/default-task-runtime-fast",
			storeId: "default-task-runtime-fast",
			workflowId: WORKFLOW_ID,
			identityDigest: "default-task-runtime-fast-digest",
		},
		durableContext: {
			get generationId(): string {
				return currentGenerationId;
			},
			get epochRef(): WorkflowEpochRef {
				return currentEpoch;
			},
			currentLeaseRef: () => leaseRef,
			outbox: {
				append: async () => ({ status: "appended" as const, sequence: 1, entryDigest: "outbox" }),
				recover: async () => ({
					quarantined: false as const,
					entries: [],
					head: { workflowId: WORKFLOW_ID, sequence: 0, eventDigest: null, entryDigest: null, epochRef: EPOCH },
					metadata: {
						status: "complete" as const,
						sourcePath: "",
						sourceDigest: "",
						sourceSizeBytes: 0,
						sequence: null,
						reason: "none" as const,
					},
				}),
			},
			auxiliaryStore: {
				read: async (name: string) => auxiliary.get(name) ?? null,
				write: async (name: string, bytes: Uint8Array) => {
					auxiliary.set(name, bytes);
				},
			},
			withExclusiveLease: async <T>(_boundary: string, operation: () => Promise<T>): Promise<T> => operation(),
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
		},
		commit,
		replay: async () => ({
			workflowId: WORKFLOW_ID,
			executionKey: events.at(-1)?.executionKey ?? null,
			events: [...events],
			head: head(),
			quarantined: false,
			quarantineReason: null,
		}),
		publishArtifact,
		publishSnapshot: async () => {
			throw new Error("fast_fixture_snapshot_not_used");
		},
		compareAndSwapProjection: async () => {
			throw new Error("fast_fixture_projection_not_used");
		},
		appendOutbox: async () => {
			throw new Error("fast_fixture_outbox_not_used");
		},
		replaceCoordinatorEpoch: async () => {
			throw new Error("fast_fixture_rotation_not_used");
		},
		replaceStoreEpoch: async () => {
			throw new Error("fast_fixture_rotation_not_used");
		},
	} as WorkflowRuntimeStore;
	return {
		store,
		events,
		artifacts,
		auxiliary,
		advanceHeadBeforeNextCommit: () => {
			advanceHeadBeforeNextCommit = true;
		},
		advanceJournalHeadBeforeNextCommit: () => {
			advanceJournalHeadBeforeNextCommit = true;
		},
		advanceHeadBeforeEveryCommit: () => {
			advanceHeadBeforeEveryCommit = true;
		},
		advanceHeadBeforeCommitKind: (kind) => {
			advanceHeadBeforeCommitKind = kind;
		},
		holdBeforeCommitKind: (kind) => {
			if (heldCommit !== null) throw new Error("fast_fixture_commit_hold_already_active");
			let release: () => void = () => undefined;
			heldCommitKind = kind;
			heldCommit = new Promise<void>((resolve) => {
				release = resolve;
			});
			return release;
		},
		failBeforeCommitKind: (kind) => {
			failedCommitKind = kind;
		},
		failBeforeCommitKindWithError: (kind, message) => {
			failedCommitKind = kind;
			failedCommitMessage = message;
		},
		failEveryCommitKindWithError: (kind, message) => {
			repeatedlyFailedCommitKind = kind;
			repeatedlyFailedCommitMessage = message;
		},
		setCurrentEpoch: (epoch, generationId = currentGenerationId) => {
			currentEpoch = epoch;
			currentGenerationId = generationId;
		},
	};
}

type TestDispatchCommit = WorkflowJournalCommit<Extract<WorkflowEventPayload, { kind: "workflow_dispatch_intent" }>>;
type TestResourceCommit = WorkflowJournalCommit<
	Extract<WorkflowEventPayload, { kind: "workflow_resource_lease_acquired" }>
>;

function persistedAttemptEvents(fixture: ReturnType<typeof runtimeStoreFixture>): {
	readonly dispatch: TestDispatchCommit;
	readonly resource: TestResourceCommit;
} {
	const dispatch = fixture.events.find((event) => event.payload.kind === "workflow_dispatch_intent");
	const resource = fixture.events.find((event) => event.payload.kind === "workflow_resource_lease_acquired");
	if (dispatch?.payload.kind !== "workflow_dispatch_intent") throw new Error("fast_fixture_dispatch_intent_missing");
	if (resource?.payload.kind !== "workflow_resource_lease_acquired")
		throw new Error("fast_fixture_resource_lease_missing");
	return { dispatch: dispatch as TestDispatchCommit, resource: resource as TestResourceCommit };
}

async function seedUnfinishedAttempt(fixture: ReturnType<typeof runtimeStoreFixture>): Promise<{
	readonly launchWorker: ReturnType<typeof vi.fn>;
	readonly attemptId: string;
	readonly executionKey: string;
}> {
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "process-group:123",
		launchedAt: NOW,
	}));
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		prime: primeAdapter(),
	});
	await authority.start();
	const { dispatch } = persistedAttemptEvents(fixture);
	fixture.auxiliary.delete("default-prime-task-runtime-v1.json");
	return {
		launchWorker,
		attemptId: dispatch.payload.attemptId,
		executionKey: dispatch.payload.executionKey,
	};
}

it("reconstructs a persisted dispatch from the predecessor coordinator epoch after rollover", async () => {
	const fixture = runtimeStoreFixture();
	const { launchWorker, attemptId } = await seedUnfinishedAttempt(fixture);
	const currentEpoch: WorkflowEpochRef = {
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch + 1,
	};
	fixture.setCurrentEpoch(currentEpoch, "generation-successor");
	const reopened = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: currentEpoch,
		decisionRef: decisionRefFor(currentEpoch),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		prime: primeAdapter(),
	});

	await reopened.start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	await expect(reopened.readState()).resolves.toMatchObject({ activeAttemptIds: [attemptId] });
});

it("rejects a replayed dispatch from a future coordinator epoch", async () => {
	const fixture = runtimeStoreFixture();
	await seedUnfinishedAttempt(fixture);
	const { dispatch, resource } = persistedAttemptEvents(fixture);
	const futureEpoch: WorkflowEpochRef = { storeEpoch: EPOCH.storeEpoch, coordinatorEpoch: EPOCH.coordinatorEpoch + 2 };
	dispatch.payload = {
		...dispatch.payload,
		epochRef: futureEpoch,
		decisionRef: decisionRefFor(futureEpoch),
		executionKey: digestObject({
			kind: "default-prime-task-attempt",
			workflowId: WORKFLOW_ID,
			taskId: dispatch.payload.taskId,
			attemptId: dispatch.payload.attemptId,
			epochRef: futureEpoch,
		}),
	};
	resource.payload = {
		...resource.payload,
		epochRef: futureEpoch,
		lease: { ...resource.payload.lease, ...futureEpoch },
	};
	const currentEpoch: WorkflowEpochRef = {
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch + 1,
	};
	fixture.setCurrentEpoch(currentEpoch, "generation-successor");
	const reopened = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: currentEpoch,
		decisionRef: decisionRefFor(currentEpoch),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		prime: primeAdapter(),
	});

	await reopened.start();
	await expect(reopened.readState()).resolves.toMatchObject({ activeAttemptIds: [] });
});

it("rejects a replayed dispatch from a different store epoch", async () => {
	const fixture = runtimeStoreFixture();
	await seedUnfinishedAttempt(fixture);
	const { dispatch, resource } = persistedAttemptEvents(fixture);
	const foreignEpoch: WorkflowEpochRef = {
		storeEpoch: EPOCH.storeEpoch + 1,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
	};
	dispatch.payload = { ...dispatch.payload, epochRef: foreignEpoch, decisionRef: decisionRefFor(foreignEpoch) };
	resource.payload = {
		...resource.payload,
		epochRef: foreignEpoch,
		lease: { ...resource.payload.lease, ...foreignEpoch },
	};
	const reopened = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		prime: primeAdapter(),
	});

	await reopened.start();
	await expect(reopened.readState()).resolves.toMatchObject({ activeAttemptIds: [] });
});

it.each([
	["execution key", (dispatch: TestDispatchCommit) => ({ ...dispatch.payload, executionKey: "forged-execution-key" })],
	[
		"decision reference",
		(dispatch: TestDispatchCommit) => ({
			...dispatch.payload,
			decisionRef: { ...dispatch.payload.decisionRef, decisionDigest: "forged-decision-digest" },
		}),
	],
])("rejects a forged persisted %s binding", async (_binding, forge) => {
	const fixture = runtimeStoreFixture();
	await seedUnfinishedAttempt(fixture);
	const { dispatch } = persistedAttemptEvents(fixture);
	dispatch.payload = forge(dispatch) as TestDispatchCommit["payload"];
	fixture.auxiliary.delete("default-prime-task-runtime-v1.json");
	const reopened = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		prime: primeAdapter(),
	});

	await reopened.start();
	await expect(reopened.readState()).resolves.toMatchObject({ activeAttemptIds: [] });
});

it("rebinds a resource lease acquisition sequence after concurrent journal head movement", async () => {
	const fixture = runtimeStoreFixture();
	fixture.advanceHeadBeforeCommitKind("workflow_resource_lease_acquired");
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: NOW,
	}));
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		prime: primeAdapter(),
	});

	await authority.start();
	const acquisition = fixture.events.find((event) => event.payload.kind === "workflow_resource_lease_acquired");
	if (acquisition?.payload.kind !== "workflow_resource_lease_acquired")
		throw new Error("resource_lease_acquisition_missing");
	expect(acquisition.payload.lease.acquisitionEventSequence).toBe(acquisition.sequence);
	expect(launchWorker).toHaveBeenCalledTimes(1);
});

it("reconstructs an active task attempt from the journal when its scheduler projection is lost", async () => {
	const fixture = runtimeStoreFixture();
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: NOW,
	}));
	const createAuthority = () =>
		createDefaultTaskRuntimeAuthority({
			runtimeStore: fixture.store,
			workflowId: WORKFLOW_ID,
			rootSessionId: ROOT_SESSION_ID,
			epochRef: EPOCH,
			decisionRef: decisionRef(),
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			graph: graph(),
			maxWorkers: 1,
			now: () => NOW,
			workerLauncher: launchWorker,
			prime: primeAdapter(),
		});

	await createAuthority().start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	expect(fixture.auxiliary.delete("default-prime-task-runtime-v1.json")).toBe(true);

	const reopened = createAuthority();
	await reopened.start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	await expect(reopened.readState()).resolves.toMatchObject({
		activeAttemptIds: [expect.stringMatching(/^attempt:recon:/u)],
	});
	await expect(reopened.readStatus()).resolves.toMatchObject({
		status: "blocked",
		idleReason: "recovery",
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		nextGate: "recon",
	});
	const dispatch = fixture.events.find((event) => event.payload.kind === "workflow_dispatch_intent");
	if (dispatch?.payload.kind !== "workflow_dispatch_intent") throw new Error("fast_fixture_dispatch_intent_missing");
	await expect(
		reopened.recover({
			workflowId: WORKFLOW_ID,
			taskId: dispatch.payload.taskId,
			attemptId: dispatch.payload.attemptId,
			executionKey: dispatch.payload.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		}),
	).resolves.toMatchObject({
		disposition: "corrective_work_required",
		taskId: "recon",
		attemptId: dispatch.payload.attemptId,
	});
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_reconciliation_recorded")).toHaveLength(1);
});

it("holds a dependency launch behind the host message-delivery barrier", async () => {
	const fixture = runtimeStoreFixture();
	let finishRecon: (completion: { status: "completed"; output: string; error: null; retryable: false }) => void =
		() => {};
	const reconCompletion = new Promise<{
		status: "completed";
		output: string;
		error: null;
		retryable: false;
	}>((resolve) => {
		finishRecon = resolve;
	});
	let releaseBarrier: () => void = () => {};
	const barrier = new Promise<void>((resolve) => {
		releaseBarrier = resolve;
	});
	const beforeTaskLaunch = vi.fn(async (taskId: string) => {
		if (taskId === "verify") await barrier;
	});
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: NOW,
		...(input.taskId === "recon" ? { completion: reconCompletion } : {}),
	}));
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: twoStageGraph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		prime: primeAdapter(),
		beforeTaskLaunch,
	});

	await authority.start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	finishRecon({ status: "completed", output: "recon result", error: null, retryable: false });
	await vi.waitFor(() => expect(beforeTaskLaunch).toHaveBeenCalledWith("verify"));
	expect(launchWorker).toHaveBeenCalledTimes(1);
	expect([...fixture.auxiliary.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n")).not.toContain(
		'"taskId":"verify"',
	);
	releaseBarrier();
	await vi.waitFor(() => expect(launchWorker).toHaveBeenCalledTimes(2));
});

it("does not admit a dependency successor while the authoritative workflow is paused", async () => {
	const fixture = runtimeStoreFixture();
	let finishRecon: (completion: { status: "completed"; output: string; error: null; retryable: false }) => void =
		() => {};
	const reconCompletion = new Promise<{
		status: "completed";
		output: string;
		error: null;
		retryable: false;
	}>((resolve) => {
		finishRecon = resolve;
	});
	let workflowStatus: "active" | "paused" = "active";
	const readWorkflowStatus = vi.fn(() => ({ status: workflowStatus }));
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: NOW,
		...(input.taskId === "recon" ? { completion: reconCompletion } : {}),
	}));
	const authorityInput = {
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: twoStageGraph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		prime: primeAdapter(),
		readWorkflowStatus,
	};
	const authority = createDefaultTaskRuntimeAuthority(authorityInput);

	await authority.start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	workflowStatus = "paused";
	finishRecon({ status: "completed", output: "recon result", error: null, retryable: false });
	await new Promise<void>((resolve) => setTimeout(resolve, 50));

	expect(readWorkflowStatus).toHaveBeenCalled();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	const audit = await authority.readAudit();
	expect(audit.launchEvidenceRefs).toHaveLength(1);
});

it("retries terminal evidence publication after a transient append-guard timeout", async () => {
	const fixture = runtimeStoreFixture();
	let terminalPublicationAttempts = 0;
	const runtimeStore: WorkflowRuntimeStore = {
		...fixture.store,
		publishArtifact: async (input) => {
			if (input.idempotencyKey.startsWith("default-prime-worker-terminal:")) {
				terminalPublicationAttempts += 1;
				if (terminalPublicationAttempts === 1) throw new Error("workflow_append_lease_guard_timeout");
			}
			return fixture.store.publishArtifact(input);
		},
	};
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: async () => ({
			workerId: "worker:recon",
			executionIdentity: "rlm:worker:recon:guard-timeout",
			processStartId: "host:123:456",
			processGroupId: "same-process-rlm:123",
			launchedAt: NOW,
			completion: Promise.resolve({
				status: "completed",
				output: "authenticated recon result",
				error: null,
				retryable: false,
			}),
		}),
		prime: primeAdapter(),
	});

	await authority.start();
	await vi.waitFor(async () => {
		await expect(authority.readAudit()).resolves.toMatchObject({ terminalTaskIds: ["recon"] });
	});
	expect(terminalPublicationAttempts).toBe(2);
});

it("runs consecutive result-to-successor handoffs through the host lease operation", async () => {
	const fixture = runtimeStoreFixture();
	let hostOperationActive = false;
	let hostOperationEntries = 0;
	const withHostLeaseOperation = vi.fn(async <T>(operation: () => Promise<T>): Promise<T> => {
		if (hostOperationActive) return operation();
		hostOperationEntries += 1;
		hostOperationActive = true;
		try {
			return await operation();
		} finally {
			hostOperationActive = false;
		}
	});
	const guardedStore: WorkflowRuntimeStore = {
		...fixture.store,
		commit: async (request) => {
			if (!hostOperationActive) throw new Error("workflow_append_lease_guard_timeout");
			return fixture.store.commit(request);
		},
	};
	type Completion = {
		readonly status: "completed";
		readonly output: string;
		readonly error: null;
		readonly retryable: false;
	};
	const finish = new Map<string, (completion: Completion) => void>();
	const launchWorker = vi.fn(async (request: { readonly taskId: string; readonly executionKey: string }) => {
		const completion = new Promise<Completion>((resolve) => finish.set(request.taskId, resolve));
		return {
			workerId: `worker:${request.taskId}`,
			executionIdentity: `rlm:worker:${request.taskId}:${request.executionKey}`,
			processStartId: `host:123:${request.taskId}`,
			processGroupId: `same-process-rlm:123:${request.taskId}`,
			launchedAt: NOW,
			completion,
		};
	});
	const authorityInput = {
		runtimeStore: guardedStore,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: threeStageGraph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		prime: primeAdapter(),
		withHostLeaseOperation,
	} as Parameters<typeof createDefaultTaskRuntimeAuthority>[0] & {
		readonly withHostLeaseOperation: <T>(operation: () => Promise<T>) => Promise<T>;
	};
	const authority = createDefaultTaskRuntimeAuthority(authorityInput);

	await authority.start();
	const entriesAfterInitialLaunch = hostOperationEntries;
	fixture.advanceHeadBeforeCommitKind("workflow_child_outcome_committed");
	finish.get("recon")?.({ status: "completed", output: "recon result", error: null, retryable: false });
	await vi.waitFor(() => expect(launchWorker).toHaveBeenCalledTimes(2));
	expect(hostOperationEntries - entriesAfterInitialLaunch).toBe(1);
	const entriesAfterReconHandoff = hostOperationEntries;
	fixture.advanceHeadBeforeCommitKind("workflow_child_outcome_committed");
	finish.get("lens")?.({ status: "completed", output: "lens result", error: null, retryable: false });
	await vi.waitFor(() => expect(launchWorker).toHaveBeenCalledTimes(3));
	expect(hostOperationEntries - entriesAfterReconHandoff).toBe(1);
	finish.get("verify")?.({ status: "completed", output: "verify result", error: null, retryable: false });
	await vi.waitFor(async () => {
		await expect(authority.readAudit()).resolves.toMatchObject({
			terminalTaskIds: ["recon", "lens", "verify"],
		});
	});
	expect(withHostLeaseOperation).toHaveBeenCalled();
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(3);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_dispatch_intent")).toHaveLength(3);
});

it("durably blocks terminal reconciliation when result publication contention persists", async () => {
	const fixture = runtimeStoreFixture();
	const blockWorkflow = vi.fn(async (_blocker: WorkflowExternalBlockerInput) => undefined);
	const runtimeStore: WorkflowRuntimeStore = {
		...fixture.store,
		publishArtifact: async (input) => {
			if (input.idempotencyKey.startsWith("default-prime-worker-terminal:"))
				throw new Error("workflow_append_lease_guard_timeout");
			return fixture.store.publishArtifact(input);
		},
	};
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: async () => ({
			workerId: "worker:recon",
			executionIdentity: "rlm:worker:recon:persistent-guard-timeout",
			processStartId: "host:123:456",
			processGroupId: "same-process-rlm:123",
			launchedAt: NOW,
			completion: Promise.resolve({
				status: "completed",
				output: "authenticated recon result",
				error: null,
				retryable: false,
			}),
		}),
		blockWorkflow,
		prime: primeAdapter(),
	});

	await authority.start();
	await vi.waitFor(() =>
		expect(blockWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				dependencyId: "task:recon:terminal",
				owner: "workflow_host",
				requiredChange: "task_terminal_result_publication_required",
				resumeEventKind: "workflow_attempt_reconciled",
			}),
		),
	);
	await expect(authority.readAudit()).resolves.toMatchObject({ terminalTaskIds: [] });
});

it("binds realistic worker identity and reconstructs terminal lifecycle without a kernel", async () => {
	const fixture = runtimeStoreFixture();
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: NOW,
		completion: Promise.resolve({
			status: "completed" as const,
			output: "authenticated worker result",
			error: null,
			retryable: false,
		}),
	}));
	const createAuthority = () =>
		createDefaultTaskRuntimeAuthority({
			runtimeStore: fixture.store,
			workflowId: WORKFLOW_ID,
			rootSessionId: ROOT_SESSION_ID,
			epochRef: EPOCH,
			decisionRef: decisionRef(),
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			graph: graph(),
			maxWorkers: 1,
			now: () => NOW,
			workerLauncher: launchWorker,
			prime: primeAdapter(),
		});

	const first = createAuthority();
	await first.start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	const progressPayload = fixture.events[0]?.payload;
	if (progressPayload?.kind !== "workflow_progress_lease_acquired")
		throw new Error("fast_fixture_progress_lease_missing");
	expect(progressPayload.cut.goalRevisionDigest).toBe(GOAL_REVISION_DIGEST);
	const resourcePayload = fixture.events[1]?.payload;
	if (resourcePayload?.kind !== "workflow_resource_lease_acquired")
		throw new Error("fast_fixture_resource_lease_missing");
	expect(resourcePayload.lease.expiresAt).toBe(progressPayload.lease.deadline);
	const forgedPredicate = {
		...progressPayload,
		lease: {
			...progressPayload.lease,
			expectedTransitionPredicate: {
				...progressPayload.lease.expectedTransitionPredicate,
				predicateDigest: "0".repeat(64),
			},
		},
	};
	expect(() => decodeWorkflowEventPayload(canonicalJsonBytes(forgedPredicate))).toThrow(/canonical|digest/i);
	await vi.waitFor(async () => {
		await expect(first.readAudit()).resolves.toMatchObject({
			workerResults: [expect.objectContaining({ status: "completed" })],
		});
	});
	const evidenceRef: WorkflowArtifactRef = {
		artifactId: "stage-evidence",
		relativePath: "evidence/stage",
		digest: "stage-evidence-digest",
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
	const classification = await first.prime.recordEvidence({ stageId: "recon", evidenceRefs: [evidenceRef] });
	await first.assertStageAcceptable({ stageId: "recon", classification });
	await first.acceptStage({ stageId: "recon", classification });

	expect(fixture.events.map((event) => event.payload.kind)).toEqual([
		"workflow_progress_lease_acquired",
		"workflow_resource_lease_acquired",
		"workflow_dispatch_intent",
		"workflow_child_outcome_committed",
		"workflow_lease_release_recorded",
		"workflow_progress_lease_closed",
	]);
	const launchRef = (await first.readAudit()).launchEvidenceRefs[0];
	if (launchRef === undefined) throw new Error("fast_fixture_launch_evidence_missing");
	expect(parseCanonicalJsonBytes(fixture.artifacts.get(launchRef.digest)!)).toMatchObject({
		kind: "default_prime_worker_launch_receipt",
		executionIdentity: expect.stringContaining("rlm:worker:recon:"),
		executionKey: expect.any(String),
	});

	expect(fixture.auxiliary.delete("default-prime-task-runtime-v1.json")).toBe(true);
	const reopened = createAuthority();
	await reopened.start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	await expect(reopened.readAudit()).resolves.toMatchObject({ terminalTaskIds: ["recon"] });
	await expect(reopened.readStatus()).resolves.toMatchObject({ nextWakeAt: null, progressStallReason: null });
});

it("retries an unadmitted launch once after the prior workflow owner dies", async () => {
	const fixture = runtimeStoreFixture();
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: `host:123:${input.taskId}`,
		processGroupId: `same-process-rlm:123:${input.taskId}`,
		launchedAt: NOW,
	}));
	const createAuthority = () =>
		createDefaultTaskRuntimeAuthority({
			runtimeStore: fixture.store,
			workflowId: WORKFLOW_ID,
			rootSessionId: ROOT_SESSION_ID,
			epochRef: EPOCH,
			decisionRef: decisionRef(),
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			graph: graph(),
			maxWorkers: 1,
			now: () => NOW,
			workerLauncher: launchWorker,
			prime: primeAdapter(),
		});

	fixture.failBeforeCommitKind("workflow_progress_lease_acquired");
	await expect(createAuthority().start()).rejects.toThrow("simulated workflow owner process death");
	expect(launchWorker).not.toHaveBeenCalled();

	const recovered = createAuthority();
	await recovered.start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	await expect(recovered.readStatus()).resolves.toMatchObject({
		status: "waiting_on_children",
		activeWorkers: 1,
	});
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_dispatch_intent")).toHaveLength(1);
});

it("blocks an ambiguous launch after process death once dispatch intent exists", async () => {
	const fixture = runtimeStoreFixture();
	const blockWorkflow = vi.fn();
	const launchWorker = vi.fn(async () => {
		throw new Error("simulated post-dispatch process death");
	});
	const createAuthority = () =>
		createDefaultTaskRuntimeAuthority({
			runtimeStore: fixture.store,
			workflowId: WORKFLOW_ID,
			rootSessionId: ROOT_SESSION_ID,
			epochRef: EPOCH,
			decisionRef: decisionRef(),
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			graph: graph(),
			maxWorkers: 1,
			now: () => NOW,
			workerLauncher: launchWorker,
			blockWorkflow,
			prime: primeAdapter(),
		});

	await expect(createAuthority().start()).rejects.toThrow("simulated post-dispatch process death");
	expect(launchWorker).toHaveBeenCalledTimes(1);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_dispatch_intent")).toHaveLength(1);

	await createAuthority().start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	expect(blockWorkflow).toHaveBeenCalledTimes(1);
	expect(blockWorkflow).toHaveBeenCalledWith(
		expect.objectContaining({
			dependencyId: "task:recon:launch",
			requiredChange: "task_launch_reconciliation_required",
			owner: "workflow_host",
			resumeEventKind: "workflow_attempt_reconciled",
			evidenceRefs: [expect.objectContaining({ digest: expect.any(String) })],
		}),
	);
});

it("reconciles a persisted worker result after restart before launching its dependent task", async () => {
	const fixture = runtimeStoreFixture();
	let resolveRecon: (value: {
		readonly status: "completed";
		readonly output: string;
		readonly error: null;
		readonly retryable: false;
	}) => void = () => {
		throw new Error("restart fixture completion was not initialized");
	};
	const reconCompletion = new Promise<{
		readonly status: "completed";
		readonly output: string;
		readonly error: null;
		readonly retryable: false;
	}>((resolve) => {
		resolveRecon = resolve;
	});
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: `host:123:${input.taskId}`,
		processGroupId: `same-process-rlm:123:${input.taskId}`,
		launchedAt: NOW,
		completion: input.taskId === "recon" ? reconCompletion : undefined,
	}));
	const createAuthority = () =>
		createDefaultTaskRuntimeAuthority({
			runtimeStore: fixture.store,
			workflowId: WORKFLOW_ID,
			rootSessionId: ROOT_SESSION_ID,
			epochRef: EPOCH,
			decisionRef: decisionRef(),
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			graph: twoStageGraph(),
			maxWorkers: 1,
			now: () => NOW,
			workerLauncher: launchWorker,
			prime: primeAdapter(),
		});

	const first = createAuthority();
	await first.start();
	const releaseOutcomeCommit = fixture.holdBeforeCommitKind("workflow_child_outcome_committed");
	resolveRecon({
		status: "completed",
		output: "authenticated recon result",
		error: null,
		retryable: false,
	});
	await vi.waitFor(async () => {
		await expect(first.readAudit()).resolves.toMatchObject({
			terminalTaskIds: [],
			workerResults: [expect.objectContaining({ status: "completed" })],
		});
	});

	const reopened = createAuthority();
	try {
		await reopened.start();
		await vi.waitFor(() => expect(launchWorker).toHaveBeenCalledTimes(2));
		await expect(reopened.readAudit()).resolves.toMatchObject({ terminalTaskIds: ["recon"] });
		expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(
			1,
		);
	} finally {
		releaseOutcomeCommit();
	}
});

it("blocks with the completed result evidence when terminal reconciliation exhausts its CAS bound", async () => {
	const fixture = runtimeStoreFixture();
	const blockWorkflow = vi.fn();
	let resolveCompletion: (value: {
		readonly status: "completed";
		readonly output: string;
		readonly error: null;
		readonly retryable: false;
	}) => void = () => {
		throw new Error("contention fixture completion was not initialized");
	};
	const completion = new Promise<{
		readonly status: "completed";
		readonly output: string;
		readonly error: null;
		readonly retryable: false;
	}>((resolve) => {
		resolveCompletion = resolve;
	});
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: `host:123:${input.taskId}`,
		processGroupId: `same-process-rlm:123:${input.taskId}`,
		launchedAt: NOW,
		completion,
	}));
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: twoStageGraph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		blockWorkflow,
		prime: primeAdapter(),
	});

	await authority.start();
	fixture.advanceHeadBeforeEveryCommit();
	resolveCompletion({
		status: "completed",
		output: "authenticated recon result",
		error: null,
		retryable: false,
	});
	await vi.waitFor(() => expect(blockWorkflow).toHaveBeenCalledTimes(1));

	const audit = await authority.readAudit();
	const resultEvidenceRef = audit.workerResults[0]?.resultEvidenceRef;
	if (resultEvidenceRef === undefined) throw new Error("contention fixture result evidence is absent");
	expect(blockWorkflow).toHaveBeenCalledWith({
		dependencyId: "task:recon:terminal",
		conditionDigest: expect.any(String),
		requiredChange: "task_terminal_reconciliation_required",
		owner: "workflow_host",
		resumeEventKind: "workflow_attempt_reconciled",
		earliestRetryAt: null,
		evidenceRefs: [resultEvidenceRef],
		recordedAt: NOW,
	});
	expect(launchWorker).toHaveBeenCalledTimes(1);
	await expect(authority.readAudit()).resolves.toMatchObject({ terminalTaskIds: [] });
});

it("journals a failed worker terminal receipt and does not relaunch it after projection loss", async () => {
	const fixture = runtimeStoreFixture();
	const failureDelivery = vi.fn();
	const blockWorkflow = vi.fn();
	let resolveCompletion: (value: { status: "error"; output: string; error: string; retryable: boolean }) => void =
		() => {
			throw new Error("fast_fixture_completion_not_initialized");
		};
	const completion = new Promise<{
		status: "error";
		output: string;
		error: string;
		retryable: boolean;
	}>((resolve) => {
		resolveCompletion = resolve;
	});
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: NOW,
		completion,
	}));
	const createAuthority = () =>
		createDefaultTaskRuntimeAuthority({
			runtimeStore: fixture.store,
			workflowId: WORKFLOW_ID,
			rootSessionId: ROOT_SESSION_ID,
			epochRef: EPOCH,
			decisionRef: decisionRef(),
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			graph: graph(),
			maxWorkers: 1,
			now: () => NOW,
			workerLauncher: launchWorker,
			workerFailureDelivery: failureDelivery,
			blockWorkflow,
			prime: primeAdapter(),
		});

	await createAuthority().start();
	const staleRunningProjection = fixture.auxiliary.get("default-prime-task-runtime-v1.json");
	if (staleRunningProjection === undefined) throw new Error("fast_fixture_running_projection_missing");
	resolveCompletion({
		status: "error",
		output: "",
		error: "worker stream ended before its required result",
		retryable: true,
	});
	await vi.waitFor(() => {
		expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(
			1,
		);
	});
	const terminal = fixture.events.find((event) => event.payload.kind === "workflow_child_outcome_committed");
	if (terminal?.payload.kind !== "workflow_child_outcome_committed")
		throw new Error("fast_fixture_terminal_receipt_missing");
	expect(terminal.payload.outcome).toMatchObject({
		attemptStatus: "failed",
		outcome: {
			status: "failed",
			errorCode: "worker stream ended before its required result",
			retryable: true,
		},
	});
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_lease_release_recorded")).toHaveLength(1);
	expect(failureDelivery).toHaveBeenCalledTimes(1);
	expect(blockWorkflow).toHaveBeenCalledTimes(1);
	expect(blockWorkflow).toHaveBeenCalledWith(
		expect.objectContaining({
			dependencyId: expect.stringContaining("recon"),
			owner: "workflow_host",
			resumeEventKind: "workflow_attempt_reconciled",
			conditionDigest: expect.any(String),
		}),
	);
	fixture.auxiliary.set("default-prime-task-runtime-v1.json", staleRunningProjection);

	const reopened = createAuthority();
	await reopened.start();
	expect(launchWorker).toHaveBeenCalledTimes(1);
	await expect(reopened.readState()).resolves.toMatchObject({
		terminalAttemptIds: [expect.stringMatching(/^attempt:recon:/u)],
	});
	await expect(reopened.readStatus()).resolves.toMatchObject({
		status: "blocked",
		idleReason: "recovery",
		activeWorkers: 0,
	});
});

it("rejects a normal worker stop without a terminal result instead of reusing launch evidence", async () => {
	const fixture = runtimeStoreFixture();
	let resolveCompletion: (value: {
		readonly status: "completed";
		readonly output: string;
		readonly error: null;
		readonly retryable: false;
	}) => void = () => {
		throw new Error("missing-result fixture completion was not initialized");
	};
	const completion = new Promise<{
		readonly status: "completed";
		readonly output: string;
		readonly error: null;
		readonly retryable: false;
	}>((resolve) => {
		resolveCompletion = resolve;
	});
	const blockWorkflow = vi.fn();
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: NOW,
		completion,
	}));
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		blockWorkflow,
		prime: primeAdapter(),
	});

	await authority.start();
	resolveCompletion({ status: "completed", output: "", error: null, retryable: false });
	await vi.waitFor(async () => {
		await expect(authority.readAudit()).resolves.toMatchObject({
			terminalTaskIds: [],
			workerResults: [
				expect.objectContaining({
					status: "error",
					error: "worker_result_missing",
					retryable: true,
					recoveryDecision: "replan_required",
				}),
			],
		});
	});
	const audit = await authority.readAudit();
	const result = audit.workerResults[0];
	const launchRef = audit.launchEvidenceRefs[0];
	if (result === undefined || launchRef === undefined) throw new Error("missing-result fixture evidence is absent");
	expect(result.resultEvidenceRef.digest).not.toBe(launchRef.digest);
	expect(parseCanonicalJsonBytes(fixture.artifacts.get(result.resultEvidenceRef.digest)!)).toMatchObject({
		kind: "default_prime_worker_terminal_packet",
		status: "error",
		error: "worker_result_missing",
		output: "",
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		launchEvidenceDigest: launchRef.digest,
	});
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(1);
	expect(blockWorkflow).toHaveBeenCalledTimes(1);
});

it("preserves a normal child result when its heartbeat races journal head movement", async () => {
	const fixture = runtimeStoreFixture();
	let reportProgress:
		| ((input: { readonly observedAt: string; readonly progressDigest: string }) => Promise<void>)
		| undefined;
	let resolveChild: (value: {
		readonly status: "completed";
		readonly output: string;
		readonly error: null;
		readonly retryable: false;
	}) => void = () => {
		throw new Error("fast_fixture_child_completion_not_initialized");
	};
	const childCompletion = new Promise<{
		readonly status: "completed";
		readonly output: string;
		readonly error: null;
		readonly retryable: false;
	}>((resolve) => {
		resolveChild = resolve;
	});
	const launcher = vi.fn(
		async (input: {
			readonly taskId: string;
			readonly executionKey: string;
			readonly reportHeartbeat: (input: {
				readonly observedAt: string;
				readonly progressDigest: string;
			}) => Promise<void>;
		}) => {
			if (input.taskId === "recon") reportProgress = input.reportHeartbeat;
			return {
				workerId: `worker:${input.taskId}`,
				executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
				processStartId: "host:123:456",
				processGroupId: "same-process-rlm:123",
				launchedAt: NOW,
				...(input.taskId === "recon" ? { completion: childCompletion } : {}),
			};
		},
	);
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: twoStageGraph(),
		maxWorkers: 1,
		now: () => new Date().toISOString(),
		workerLauncher: launcher,
		prime: primeAdapter(),
	});

	await authority.start();
	if (reportProgress === undefined) throw new Error("fast_fixture_progress_callback_missing");
	for (let heartbeat = 0; heartbeat < 20; heartbeat += 1) {
		fixture.advanceJournalHeadBeforeNextCommit();
		await reportProgress({
			observedAt: new Date(Date.parse(NOW) + heartbeat * 1_000).toISOString(),
			progressDigest: digestObject({ publicOutcome: "worker inspected immutable inputs", heartbeat }),
		});
	}
	resolveChild({ status: "completed", output: "bounded recon result", error: null, retryable: false });
	await vi.waitFor(async () => {
		await expect(authority.readAudit()).resolves.toMatchObject({
			terminalTaskIds: ["recon"],
			workerResults: [expect.objectContaining({ status: "completed", error: null })],
		});
		expect(launcher).toHaveBeenCalledTimes(2);
	});
	const audit = await authority.readAudit();
	const result = audit.workerResults[0];
	const launchRef = audit.launchEvidenceRefs[0];
	if (result === undefined || launchRef === undefined) throw new Error("normal-result fixture evidence is absent");
	expect(result.resultEvidenceRef.digest).not.toBe(launchRef.digest);
	expect(parseCanonicalJsonBytes(fixture.artifacts.get(result.resultEvidenceRef.digest)!)).toMatchObject({
		kind: "default_prime_worker_terminal_packet",
		status: "completed",
		output: "bounded recon result",
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		launchEvidenceDigest: launchRef.digest,
	});
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_recovery_started")).toHaveLength(20);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(1);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_lease_release_recorded")).toHaveLength(1);
	expect(launcher.mock.calls[1]?.[0]).toMatchObject({ taskId: "verify" });
});

it("reconstructs one progress wake when active work does not advance the authoritative cut", async () => {
	const fixture = runtimeStoreFixture();
	let nowMs = Date.parse(NOW);
	const acceptedWakeIds = new Set<string>();
	const wakeAttempts: string[] = [];
	const scheduleProgressWake = vi.fn(async (obligation: { readonly wakeObligationId: string }) => {
		wakeAttempts.push(obligation.wakeObligationId);
		if (acceptedWakeIds.has(obligation.wakeObligationId)) return "already_scheduled" as const;
		acceptedWakeIds.add(obligation.wakeObligationId);
		return "scheduled" as const;
	});
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: NOW,
	}));
	const authorityInput = {
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => new Date(nowMs).toISOString(),
		workerLauncher: launchWorker,
		prime: primeAdapter(),
		progressLeaseDurationMs: 10,
		scheduleProgressWake,
	};

	const first = createDefaultTaskRuntimeAuthority(authorityInput);
	await first.start();
	await first.recordTelemetry({
		dispatchLatencyMs: 1,
		childWaitMs: 1,
		idleTimeMs: 0,
		duplicateScans: 0,
		testRuntimeMs: 1,
		blockedCapacityReason: null,
	});
	nowMs += 20;
	const reopened = createDefaultTaskRuntimeAuthority(authorityInput);
	await reopened.start();

	await vi.waitFor(() => expect(acceptedWakeIds.size).toBe(1));
	expect(new Set(wakeAttempts).size).toBe(1);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_lease_acquired")).toHaveLength(1);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_stalled")).toHaveLength(1);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_recovery_started")).toHaveLength(
		1,
	);
	await expect(reopened.readStatus()).resolves.toMatchObject({
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		progressCutHeadDigest: expect.any(String),
		lastAuthoritativeProgressAt: NOW,
		progressLeaseOwner: "writer-fast",
		progressLeaseDeadline: new Date(Date.parse(NOW) + 10).toISOString(),
		progressPredicateDigest: expect.any(String),
		nextWakeAt: new Date(Date.parse(NOW) + 10).toISOString(),
		progressRecoveryCount: 1,
		readyTaskSetDigest: expect.any(String),
		nextGate: "recon",
		progressStallReason: "progress_lease_deadline_unchanged",
	});
});

it("retries progress recovery when the append guard is briefly contended", async () => {
	const fixture = runtimeStoreFixture();
	let nowMs = Date.parse(NOW);
	const scheduleProgressWake = vi.fn(async () => "scheduled" as const);
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => new Date(nowMs).toISOString(),
		workerLauncher: vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
			workerId: `worker:${input.taskId}`,
			executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
			processStartId: "host:123:456",
			processGroupId: "same-process-rlm:123",
			launchedAt: NOW,
		})),
		prime: primeAdapter(),
		progressLeaseDurationMs: 10,
		scheduleProgressWake,
	});

	await authority.start();
	fixture.failBeforeCommitKindWithError("workflow_progress_stalled", "workflow_append_lease_guard_timeout");
	nowMs += 20;

	await vi.waitFor(() => {
		expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_stalled")).toHaveLength(1);
		expect(
			fixture.events.filter((event) => event.payload.kind === "workflow_progress_recovery_started"),
		).toHaveLength(1);
	});
	expect(scheduleProgressWake).toHaveBeenCalledTimes(1);
});

it("blocks durably instead of crashing when progress recovery contention persists", async () => {
	const fixture = runtimeStoreFixture();
	let nowMs = Date.parse(NOW);
	const blockWorkflow = vi
		.fn<(blocker: WorkflowExternalBlockerInput) => Promise<void>>()
		.mockRejectedValueOnce(new Error("workflow_append_lease_guard_timeout"))
		.mockResolvedValue(undefined);
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => new Date(nowMs).toISOString(),
		workerLauncher: vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
			workerId: `worker:${input.taskId}`,
			executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
			processStartId: "host:123:456",
			processGroupId: "same-process-rlm:123",
			launchedAt: NOW,
		})),
		prime: primeAdapter(),
		progressLeaseDurationMs: 10,
		scheduleProgressWake: vi.fn(async () => "scheduled" as const),
		blockWorkflow,
	});

	await authority.start();
	fixture.failEveryCommitKindWithError("workflow_progress_stalled", "workflow_append_lease_guard_timeout");
	nowMs += 20;

	await vi.waitFor(() => {
		expect(
			blockWorkflow.mock.calls.filter(
				([blocker]) => blocker.requiredChange === "progress_lease_reconciliation_required",
			),
		).toHaveLength(2);
		expect(blockWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				dependencyId: expect.stringMatching(/^progress:/u),
				owner: "workflow_host",
				requiredChange: "progress_lease_reconciliation_required",
				resumeEventKind: "workflow_progress_reconciled",
			}),
		);
	});
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_stalled")).toHaveLength(0);
});

it("rebases progress recovery when worker evidence advances the journal before its commit", async () => {
	const fixture = runtimeStoreFixture();
	let nowMs = Date.parse(NOW);
	const scheduleProgressWake = vi.fn(async () => "scheduled" as const);
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: NOW,
	}));
	const authorityInput = {
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => new Date(nowMs).toISOString(),
		workerLauncher: launchWorker,
		prime: primeAdapter(),
		progressLeaseDurationMs: 100_000,
		scheduleProgressWake,
	};

	await createDefaultTaskRuntimeAuthority(authorityInput).start();
	nowMs += 200_000;
	fixture.advanceHeadBeforeNextCommit();
	const reopened = createDefaultTaskRuntimeAuthority(authorityInput);

	await reopened.start();

	expect(fixture.events.filter((event) => event.payload.kind === "workflow_recovery_started")).toHaveLength(1);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_stalled")).toHaveLength(1);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_recovery_started")).toHaveLength(
		1,
	);
	expect(scheduleProgressWake).toHaveBeenCalledTimes(1);
});

it("fails closed when progress recovery cannot obtain a stable authoritative head", async () => {
	const fixture = runtimeStoreFixture();
	let nowMs = Date.parse(NOW);
	const authorityInput = {
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => new Date(nowMs).toISOString(),
		workerLauncher: vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
			workerId: `worker:${input.taskId}`,
			executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
			processStartId: "host:123:456",
			processGroupId: "same-process-rlm:123",
			launchedAt: NOW,
		})),
		prime: primeAdapter(),
		progressLeaseDurationMs: 100_000,
		scheduleProgressWake: vi.fn(async () => "scheduled" as const),
	};

	await createDefaultTaskRuntimeAuthority(authorityInput).start();
	nowMs += 200_000;
	fixture.advanceHeadBeforeEveryCommit();

	await expect(createDefaultTaskRuntimeAuthority(authorityInput).start()).rejects.toThrow(
		"Workflow store compare-and-swap precondition is stale or is not bound to the active writer and lease.",
	);

	expect(fixture.events.filter((event) => event.payload.kind === "workflow_recovery_started")).toHaveLength(4);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_stalled")).toHaveLength(0);
});

it("renews progress only from accepted outcome evidence for the next ready gate", async () => {
	const fixture = runtimeStoreFixture();
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: `host:123:${input.taskId}`,
		processGroupId: `same-process-rlm:123:${input.taskId}`,
		launchedAt: NOW,
		completion: Promise.resolve({
			status: "completed" as const,
			output: `result:${input.taskId}`,
			error: null,
			retryable: false,
		}),
	}));
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: twoStageGraph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		prime: primeAdapter(),
	});

	await authority.start();
	await vi.waitFor(async () => {
		expect((await authority.readAudit()).workerResults).toEqual(
			expect.arrayContaining([expect.objectContaining({ taskId: "recon", status: "completed" })]),
		);
	});
	const reconResult = (await authority.readAudit()).workerResults.find((result) => result.taskId === "recon");
	if (reconResult === undefined) throw new Error("fast_fixture_recon_result_missing");

	const progressEvents = fixture.events.filter((event) => event.payload.kind === "workflow_progress_lease_acquired");
	expect(progressEvents).toHaveLength(2);
	expect(progressEvents[1]?.payload).toMatchObject({
		sourceOutcome: {
			taskId: "recon",
			evidenceDigests: [reconResult.resultEvidenceRef.digest],
		},
		cut: {
			nextGate: "verify",
			terminalTaskIds: ["recon"],
		},
	});
	expect(launchWorker).toHaveBeenCalledTimes(2);
});

it("records meaningful worker progress without extending the signed task capsule deadline", async () => {
	const fixture = runtimeStoreFixture();
	type ReportHeartbeat = (input: { readonly observedAt: string; readonly progressDigest: string }) => Promise<void>;
	let reportHeartbeat: ReportHeartbeat = async () => {
		throw new Error("fast_fixture_heartbeat_reporter_missing");
	};
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => {
		const candidate = Reflect.get(input, "reportHeartbeat");
		expect(candidate).toBeTypeOf("function");
		reportHeartbeat = candidate as ReportHeartbeat;
		return {
			workerId: `worker:${input.taskId}`,
			executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
			processStartId: "host:123:456",
			processGroupId: "same-process-rlm:123",
			launchedAt: NOW,
		};
	});
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		progressLeaseDurationMs: 1_000,
		workerLauncher: launchWorker,
		prime: primeAdapter(),
	});

	await authority.start();
	const firstObservedAt = new Date(Date.parse(NOW) + 100).toISOString();
	const secondObservedAt = new Date(Date.parse(NOW) + 200).toISOString();
	await reportHeartbeat({ observedAt: firstObservedAt, progressDigest: digestObject("meaningful-progress-1") });
	await reportHeartbeat({ observedAt: firstObservedAt, progressDigest: digestObject("meaningful-progress-1") });
	await reportHeartbeat({ observedAt: secondObservedAt, progressDigest: digestObject("meaningful-progress-2") });

	const heartbeats = fixture.events.filter((event) => event.payload.kind === "workflow_task_lease_heartbeat");
	expect(heartbeats).toHaveLength(2);
	expect(heartbeats.map((event) => event.payload)).toMatchObject([
		{ observedAt: firstObservedAt, renewedExpiresAt: new Date(Date.parse(NOW) + 1_000).toISOString() },
		{ observedAt: secondObservedAt, renewedExpiresAt: new Date(Date.parse(NOW) + 1_000).toISOString() },
	]);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_progress_lease_acquired")).toHaveLength(1);
	await expect(
		reportHeartbeat({
			observedAt: new Date(Date.parse(NOW) + 1_201).toISOString(),
			progressDigest: digestObject("late-progress"),
		}),
	).rejects.toThrow(/expired|deadline/i);
});

it("terminalizes an expired signed task deadline without another transcript event and recovers it once", async () => {
	const fixture = runtimeStoreFixture();
	const blockWorkflow = vi.fn();
	const terminationOrder: string[] = [];
	let resolveLateCompletion: ((completion: TestLegacyWorkerCompletion) => void) | undefined;
	const lateCompletion = new Promise<TestLegacyWorkerCompletion>((resolve) => {
		resolveLateCompletion = resolve;
	});
	const terminate = vi.fn(async () => {
		terminationOrder.push("runtime-fenced");
		return true;
	});
	const launchWorker = vi.fn(async (input: { readonly taskId: string; readonly executionKey: string }) => ({
		workerId: `worker:${input.taskId}`,
		executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
		processStartId: "host:123:456",
		processGroupId: "same-process-rlm:123",
		launchedAt: new Date().toISOString(),
		terminate,
		completion: lateCompletion,
	}));
	const createAuthority = () =>
		createDefaultTaskRuntimeAuthority({
			runtimeStore: fixture.store,
			workflowId: WORKFLOW_ID,
			rootSessionId: ROOT_SESSION_ID,
			epochRef: EPOCH,
			decisionRef: decisionRef(),
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			graph: generatedOutputGraph(),
			maxWorkers: 1,
			now: () => new Date().toISOString(),
			progressLeaseDurationMs: 20,
			workerLauncher: launchWorker,
			createTaskCapsule: taskCapsuleFactory(generatedOutputGraph()),
			blockWorkflow,
			prime: primeAdapter(),
		});

	await createAuthority().start();
	await vi.waitFor(
		() => {
			expect(
				fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed"),
			).toHaveLength(2);
		},
		{ timeout: 500 },
	);
	const outcome = fixture.events.find((event) => event.payload.kind === "workflow_child_outcome_committed");
	if (outcome?.payload.kind !== "workflow_child_outcome_committed")
		throw new Error("fast_fixture_expired_terminal_missing");
	expect(outcome.payload.outcome).toMatchObject({
		attemptStatus: "failed",
		outcome: {
			status: "failed",
			errorCode: "task_deadline_expired",
			retryable: true,
		},
	});
	expect(terminate).toHaveBeenCalledTimes(2);
	expect(terminate).toHaveBeenNthCalledWith(1, "task_deadline_expired");
	expect(terminate).toHaveBeenNthCalledWith(2, "task_deadline_expired");
	terminationOrder.push("terminal-published");
	expect(terminationOrder).toEqual(["runtime-fenced", "runtime-fenced", "terminal-published"]);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_lease_release_recorded")).toHaveLength(2);
	expect(blockWorkflow).toHaveBeenCalledTimes(1);

	const reopened = createAuthority();
	await reopened.start();
	expect(launchWorker).toHaveBeenCalledTimes(2);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(2);
	resolveLateCompletion?.({
		status: "completed",
		output: "late result without authority",
		error: null,
		retryable: false,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(2);
	await expect(reopened.readAudit()).resolves.toMatchObject({
		workerResults: [
			expect.objectContaining({ status: "error", error: "task_deadline_expired", retryable: true }),
			expect.objectContaining({ status: "error", error: "task_deadline_expired", retryable: true }),
		],
	});
	await expect(reopened.readStatus()).resolves.toMatchObject({
		status: "blocked",
		activeWorkers: 0,
		idleReason: "recovery",
	});
});

it("normalizes a child-owned signed deadline cancellation and retries it once with fresh authority", async () => {
	const fixture = runtimeStoreFixture();
	const blockWorkflow = vi.fn();
	let resolveRetryCompletion: ((completion: TestLegacyWorkerCompletion) => void) | undefined;
	const retryCompletion = new Promise<TestLegacyWorkerCompletion>((resolve) => {
		resolveRetryCompletion = resolve;
	});
	const launchWorker = vi.fn(
		async (input: {
			readonly taskId: string;
			readonly attemptId: string;
			readonly executionKey: string;
			readonly taskCapsule?: DefaultPrimeWorkerTaskCapsule;
		}) => ({
			workerId: `worker:${input.taskId}`,
			executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
			processStartId: "host:123:456",
			processGroupId: "same-process-rlm:123",
			launchedAt: new Date().toISOString(),
			completion: input.attemptId.includes(":retry:")
				? retryCompletion
				: Promise.resolve<TestLegacyWorkerCompletion>({
						status: "cancelled",
						output: "",
						error: "task_deadline_expired",
						retryable: false,
					}),
		}),
	);
	const createAuthority = () =>
		createDefaultTaskRuntimeAuthority({
			runtimeStore: fixture.store,
			workflowId: WORKFLOW_ID,
			rootSessionId: ROOT_SESSION_ID,
			epochRef: EPOCH,
			decisionRef: decisionRef(),
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			graph: generatedOutputGraph(),
			maxWorkers: 1,
			now: () => new Date().toISOString(),
			progressLeaseDurationMs: 1_000,
			workerLauncher: launchWorker,
			createTaskCapsule: taskCapsuleFactory(generatedOutputGraph()),
			blockWorkflow,
			prime: primeAdapter(),
		});
	const authority = createAuthority();

	await authority.start();
	await vi.waitFor(() => {
		expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(
			1,
		);
		expect(launchWorker).toHaveBeenCalledTimes(2);
	});
	const outcome = fixture.events.find((event) => event.payload.kind === "workflow_child_outcome_committed");
	if (outcome?.payload.kind !== "workflow_child_outcome_committed")
		throw new Error("child_owned_deadline_terminal_missing");
	expect(outcome.payload.outcome).toMatchObject({
		attemptStatus: "failed",
		outcome: {
			status: "failed",
			errorCode: "task_deadline_expired",
			retryable: true,
		},
	});
	await expect(authority.readAudit()).resolves.toMatchObject({
		workerResults: [expect.objectContaining({ status: "error", error: "task_deadline_expired", retryable: true })],
	});
	const [firstLaunch, retryLaunch] = launchWorker.mock.calls.map(([request]) => request);
	expect(retryLaunch.attemptId).not.toBe(firstLaunch.attemptId);
	expect(retryLaunch.executionKey).not.toBe(firstLaunch.executionKey);
	expect(retryLaunch.taskCapsule?.capsuleDigest).not.toBe(firstLaunch.taskCapsule?.capsuleDigest);
	expect(blockWorkflow).not.toHaveBeenCalled();
	const reopened = createAuthority();
	await reopened.start();
	expect(launchWorker).toHaveBeenCalledTimes(2);
	await expect(reopened.readStatus()).resolves.toMatchObject({ status: "waiting_on_children", activeWorkers: 1 });

	resolveRetryCompletion?.({
		status: "cancelled",
		output: "",
		error: "task_deadline_expired",
		retryable: false,
	});
	await vi.waitFor(() => {
		expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(
			2,
		);
		expect(blockWorkflow).toHaveBeenCalledOnce();
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(launchWorker).toHaveBeenCalledTimes(2);
	await expect(authority.readStatus()).resolves.toMatchObject({ status: "blocked", activeWorkers: 0 });
});

it("ignores an old completion envelope delivered to retry:1 before accepting its bound completion", async () => {
	const fixture = runtimeStoreFixture();
	const launchRequests: Array<{ readonly attemptId: string; readonly executionKey: string }> = [];
	const completionListeners: Array<(completion: DefaultPrimeWorkerCompletion) => unknown> = [];
	const completionChannel = {} as {
		then(onFulfilled: (completion: DefaultPrimeWorkerCompletion) => unknown): Promise<never>;
	};
	// The adversarial channel deliberately reuses one completion delivery path for two attempt bindings.
	// biome-ignore lint/suspicious/noThenProperty: this thenable models a misrouted worker completion channel.
	Object.defineProperty(completionChannel, "then", {
		value: (onFulfilled: (completion: DefaultPrimeWorkerCompletion) => unknown): Promise<never> => {
			completionListeners.push(onFulfilled);
			return new Promise<never>(() => undefined);
		},
	});
	const completionPromise = completionChannel as unknown as Promise<DefaultPrimeWorkerCompletion>;
	const launchWorker = vi.fn(async (input: { readonly attemptId: string; readonly executionKey: string }) => {
		launchRequests.push(input);
		return {
			workerId: `worker:${input.attemptId}`,
			executionIdentity: `rlm:${input.executionKey}`,
			processStartId: `process:${input.attemptId}`,
			processGroupId: `process-group:${input.attemptId}`,
			launchedAt: new Date().toISOString(),
			completion: completionPromise,
		};
	});
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => new Date().toISOString(),
		workerLauncher: launchWorker,
		prime: primeAdapter(),
	});

	await authority.start();
	await vi.waitFor(() => expect(completionListeners).toHaveLength(1));
	const firstRequest = launchRequests[0];
	if (firstRequest === undefined) throw new Error("stale completion retry fixture first launch is missing");
	completionListeners[0]?.({
		kind: "worker",
		status: "error",
		output: "",
		error: "task_deadline_expired",
		retryable: true,
		binding: {
			workflowId: WORKFLOW_ID,
			taskId: "recon",
			attemptId: firstRequest.attemptId,
			executionKey: firstRequest.executionKey,
		},
	});
	await vi.waitFor(() => expect(launchWorker).toHaveBeenCalledTimes(2));
	const retryRequest = launchRequests[1];
	if (retryRequest === undefined) throw new Error("stale completion retry fixture retry launch is missing");
	await vi.waitFor(() => expect(completionListeners).toHaveLength(2));

	completionListeners[1]?.({
		kind: "worker",
		status: "completed",
		output: "unbound old attempt result",
		error: null,
		retryable: false,
	} as unknown as DefaultPrimeWorkerCompletion);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await expect(authority.readAudit()).resolves.toMatchObject({ terminalTaskIds: [] });

	completionListeners[1]?.({
		kind: "worker",
		status: "completed",
		output: "old attempt result",
		error: null,
		retryable: false,
		binding: {
			workflowId: WORKFLOW_ID,
			taskId: "recon",
			attemptId: firstRequest.attemptId,
			executionKey: firstRequest.executionKey,
		},
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await expect(authority.readAudit()).resolves.toMatchObject({ terminalTaskIds: [] });

	completionListeners[1]?.({
		kind: "worker",
		status: "completed",
		output: "retry result",
		error: null,
		retryable: false,
		binding: {
			workflowId: WORKFLOW_ID,
			taskId: "recon",
			attemptId: retryRequest.attemptId,
			executionKey: retryRequest.executionKey,
		},
	});
	await vi.waitFor(async () => {
		await expect(authority.readAudit()).resolves.toMatchObject({ terminalTaskIds: ["recon"] });
	});
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(2);
	const audit = await authority.readAudit();
	// Two attempts launched, so two launch-evidence refs. An earlier version of this assertion
	// expected one, on the assumption that a failed attempt's launch evidence is dropped; it is not,
	// and it should not be - the audit has to retain evidence for the attempt that errored, or the
	// retry's success would be the only trace of a task that ran twice.
	expect(audit.launchEvidenceRefs).toHaveLength(2);
	const launchDigests = new Set(audit.launchEvidenceRefs.map((ref) => ref.digest));
	expect(launchDigests.size).toBe(2);
	// Launch evidence and result evidence are separate artifacts; the audit must not conflate them.
	for (const result of audit.workerResults) expect(launchDigests.has(result.resultEvidenceRef.digest)).toBe(false);
	expect(audit.workerResults).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ attemptId: firstRequest.attemptId, status: "error" }),
			expect.objectContaining({ attemptId: retryRequest.attemptId, status: "completed" }),
		]),
	);
});

it("ignores a host expiry completion forged by a worker launcher", async () => {
	const fixture = runtimeStoreFixture();
	const launchWorker = vi.fn(
		async (input: { readonly taskId: string; readonly attemptId: string; readonly executionKey: string }) => ({
			workerId: `worker:${input.attemptId}`,
			executionIdentity: `rlm:${input.executionKey}`,
			processStartId: `process:${input.attemptId}`,
			processGroupId: `process-group:${input.attemptId}`,
			launchedAt: NOW,
			completion: Promise.resolve({
				kind: "host" as const,
				status: "error" as const,
				output: "" as const,
				error: "task_deadline_expired" as const,
				retryable: true as const,
			}),
		}),
	);
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: fixture.store,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: EPOCH,
		decisionRef: decisionRef(),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph: graph(),
		maxWorkers: 1,
		now: () => NOW,
		workerLauncher: launchWorker,
		prime: primeAdapter(),
	});

	await authority.start();
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	await expect(authority.readAudit()).resolves.toMatchObject({ terminalTaskIds: [], workerResults: [] });
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(0);
});

it("keeps host and unbound worker completions out of the public launch type", () => {
	const hostCompletion = Promise.resolve({
		kind: "host" as const,
		status: "error" as const,
		output: "" as const,
		error: "task_deadline_expired" as const,
		retryable: true as const,
	});
	const hostLaunch: DefaultPrimeWorkerLaunch = {
		workerId: "worker:forged",
		executionIdentity: "execution:forged",
		processStartId: "process:forged",
		processGroupId: "process-group:forged",
		launchedAt: NOW,
		// @ts-expect-error Host completion envelopes are authority-private.
		completion: hostCompletion,
	};
	const unboundCompletion = Promise.resolve({
		kind: "worker" as const,
		status: "completed" as const,
		output: "result",
		error: null,
		retryable: false as const,
	});
	const unboundLaunch: DefaultPrimeWorkerLaunch = {
		workerId: "worker:unbound",
		executionIdentity: "execution:unbound",
		processStartId: "process:unbound",
		processGroupId: "process-group:unbound",
		launchedAt: NOW,
		// @ts-expect-error Worker completion bindings are mandatory.
		completion: unboundCompletion,
	};
	expect(hostLaunch.completion).toBe(hostCompletion);
	expect(unboundLaunch.completion).toBe(unboundCompletion);
});

it("recovers a terminal completion after a crash immediately following result publication", async () => {
	const fixture = runtimeStoreFixture();
	let terminalPublicationCount = 0;
	let crashAfterPublication = true;
	const runtimeStore: WorkflowRuntimeStore = {
		...fixture.store,
		publishArtifact: async (input) => {
			const publication = await fixture.store.publishArtifact(input);
			if (input.idempotencyKey.startsWith("default-prime-worker-terminal:") && crashAfterPublication) {
				crashAfterPublication = false;
				terminalPublicationCount += 1;
				throw new Error("simulated crash after terminal result publication");
			}
			if (input.idempotencyKey.startsWith("default-prime-worker-terminal:")) terminalPublicationCount += 1;
			return publication;
		},
	};
	const launchWorker = vi.fn(
		async (input: { readonly taskId: string; readonly attemptId: string; readonly executionKey: string }) => ({
			workerId: `worker:${input.attemptId}`,
			executionIdentity: `rlm:${input.executionKey}`,
			processStartId: `process:${input.attemptId}`,
			processGroupId: `process-group:${input.attemptId}`,
			launchedAt: NOW,
			completion: Promise.resolve({
				kind: "worker" as const,
				status: "completed" as const,
				output: "authenticated terminal result",
				error: null,
				retryable: false,
				binding: {
					workflowId: WORKFLOW_ID,
					taskId: input.taskId,
					attemptId: input.attemptId,
					executionKey: input.executionKey,
				},
			}),
		}),
	);
	const createAuthority = () =>
		createDefaultTaskRuntimeAuthority({
			runtimeStore,
			workflowId: WORKFLOW_ID,
			rootSessionId: ROOT_SESSION_ID,
			epochRef: EPOCH,
			decisionRef: decisionRef(),
			goalRevisionDigest: GOAL_REVISION_DIGEST,
			graph: graph(),
			maxWorkers: 1,
			now: () => NOW,
			workerLauncher: launchWorker,
			prime: primeAdapter(),
		});

	const first = createAuthority();
	await first.start();
	await vi.waitFor(() => expect(terminalPublicationCount).toBe(1));
	await expect(first.readAudit()).resolves.toMatchObject({ terminalTaskIds: [] });

	const reopened = createAuthority();
	await reopened.start();
	await vi.waitFor(async () => {
		await expect(reopened.readAudit()).resolves.toMatchObject({ terminalTaskIds: ["recon"] });
	});
	expect(terminalPublicationCount).toBe(2);
	expect(launchWorker).toHaveBeenCalledTimes(1);
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")).toHaveLength(1);
});
