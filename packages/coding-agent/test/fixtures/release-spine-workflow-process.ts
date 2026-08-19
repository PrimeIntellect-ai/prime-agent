import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { emptyGoalState, type GoalState } from "../../src/core/goals.js";
import type { WorkflowDecisionRef, WorkflowEpochRef } from "../../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
} from "../../src/core/workflow/contracts.js";
import {
	type DefaultPrimeWorkerTaskCapsuleCore,
	defaultPrimeWorkerOutputContract,
	defaultPrimeWorkerTaskCapsuleDigest,
	defaultPrimeWorkerTaskCapsuleReceiptBindingDigest,
} from "../../src/core/workflow/default-task-runtime.js";
import { createDefaultTaskRuntimeAuthority } from "../../src/core/workflow/default-task-runtime-authority.js";
import { createPersistedSessionWorkflowHost } from "../../src/core/workflow/session-host-factory.js";
import type { WorkflowTask, WorkflowTaskGraph } from "../../src/core/workflow/task-graph.js";
import type { WorkflowPrimeStageEvidenceAdapter } from "../../src/core/workflow/task-runtime-authority.js";

const mode = process.argv[2];
const artifactRoot = process.argv[3];
if (
	(mode !== "setup" && mode !== "recover" && mode !== "deadline-setup" && mode !== "deadline-recover") ||
	artifactRoot === undefined
)
	throw new Error(
		"Usage: release-spine-workflow-process.ts <setup|recover|deadline-setup|deadline-recover> <artifact-root>",
	);

const deadlineMode = mode.startsWith("deadline-");
const workflowId = deadlineMode ? "release-spine-deadline-workflow" : "release-spine-workflow";
const rootSessionId = deadlineMode ? "release-spine-deadline-session" : "release-spine-session";
const goalPath = join(artifactRoot, "goal.json");
const approvalPath = join(artifactRoot, "approval.json");
const resultPath = join(artifactRoot, "workflow-result.json");
const goalBytes = new TextEncoder().encode("advance the immutable release-spine goal through its authoritative gate");
const parsedObjective = "advance the immutable release-spine goal through its authoritative gate";
const boundaryIds = ["typed-receipt-required"] as const;
const gateIds = ["w1-authoritative"] as const;

mkdirSync(artifactRoot, { recursive: true });
chmodSync(artifactRoot, 0o700);

function readGoal(): GoalState {
	try {
		return parseCanonicalJsonBytes(new Uint8Array(readFileSync(goalPath))) as unknown as GoalState;
	} catch {
		const initial = emptyGoalState();
		writeFileSync(goalPath, canonicalJsonBytes(initial));
		return initial;
	}
}

const goalProjection = {
	read: (): GoalState => readGoal(),
	compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
		if (digestObject(readGoal()) !== digestObject(expected)) return false;
		writeFileSync(goalPath, canonicalJsonBytes(next));
		return true;
	},
};

function taskGraph(
	options: { readonly deadlineMs?: number; readonly generatedOutput?: boolean } = {},
): WorkflowTaskGraph {
	const generatedOutputPaths = options.generatedOutput === true ? ["artifacts/out"] : [];
	const task: WorkflowTask = {
		taskId: "w1",
		planRevision: 1,
		objective: "advance W1 through one typed terminal receipt",
		requirementIds: ["w1-authoritative"],
		completionCriteria: ["typed terminal receipt is journaled"],
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
			wallMilliseconds: options.deadlineMs ?? 60_000,
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
	return {
		graphRevision: 1,
		tasks: [task],
		byId: new Map([[task.taskId, task]]),
		allowedAuthority: ["read_workspace"],
		ownershipPaths: [],
		generatedOutputPaths,
		lockPaths: generatedOutputPaths,
		namedContracts: options.generatedOutput === true ? ["evidence-w1"] : [],
		graphDigest: digestObject({ task, generatedOutputPaths }),
	};
}

function deadlineTaskCapsuleFactory(
	graph: WorkflowTaskGraph,
	goalRevisionDigest: string,
): NonNullable<Parameters<typeof createDefaultTaskRuntimeAuthority>[0]["createTaskCapsule"]> {
	return async (request) => {
		const core: DefaultPrimeWorkerTaskCapsuleCore = {
			schemaVersion: 1,
			kind: "default_prime_worker_task_capsule",
			workflowId,
			taskId: request.task.taskId,
			attemptId: request.attemptId,
			executionKey: request.executionKey,
			epochRef: request.epochRef,
			journalHead: request.journalHead,
			goalRevisionDigest,
			goalBindingDigest: digestObject({ workflowId, goalRevisionDigest }),
			graphDigest: graph.graphDigest,
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
				logicalPath: "artifacts/out/w1.json",
				evidencePolicyId: "evidence-w1",
				maxBytes: 4096,
				maxItems: 8,
				independent: true,
			}),
			forbiddenOutcomes: ["prose_only_result", "unbound_or_extra_output", "protected_or_holdout_data"],
			terminalReturnProtocol: "canonical_json_only",
		};
		const capsuleDigest = defaultPrimeWorkerTaskCapsuleDigest(core);
		const issuedAt = new Date().toISOString();
		const artifactRef = {
			artifactId: `capsule:${capsuleDigest}`,
			relativePath: `artifacts/evidence/${capsuleDigest}`,
			digest: capsuleDigest,
			sizeBytes: canonicalJsonBytes(core).byteLength,
			sourceEventSequence: request.journalHead.sequence,
		};
		return {
			...core,
			capsuleDigest,
			receipt: {
				receiptKind: "artifact",
				oneUse: false,
				receiptId: `task-capsule-${request.executionKey.slice(0, 48)}`,
				issuerId: "workflow-host",
				workflowId,
				bindingDigest: defaultPrimeWorkerTaskCapsuleReceiptBindingDigest(capsuleDigest),
				payloadDigest: capsuleDigest,
				artifactRef,
				issuedAt,
				validUntil: new Date(Date.parse(issuedAt) + 300_000).toISOString(),
				keyId: "workflow-host-key",
				signatureAlgorithm: "ed25519",
				artifactBytesDigest: artifactRef.digest,
				stateDigest: digestObject(request.journalHead),
				revision: 1,
				signature: "signed",
				verificationDigest: "verified",
			},
		};
	};
}

function primeAdapter(): WorkflowPrimeStageEvidenceAdapter {
	return {
		recordEvidence: async () => ({
			boundary: "public_boundary",
			verification: "host_verified",
			evidenceKind: "process_restart",
			authorizesTerminalization: true,
		}),
		readCoordinatorStatus: async () => {
			throw new Error("release_spine_status_adapter_not_used");
		},
		recordTelemetry: async () => undefined,
		assertStageAcceptable: async () => undefined,
		acceptStage: async () => undefined,
		readAudit: async () => ({ terminalTaskIds: [], launchEvidenceRefs: [], workerResults: [] }),
	};
}

function currentDecisionRef(decisionRef: WorkflowDecisionRef, epochRef: WorkflowEpochRef): WorkflowDecisionRef {
	return { ...decisionRef, storeEpoch: epochRef.storeEpoch, coordinatorEpoch: epochRef.coordinatorEpoch };
}

async function openHost() {
	return createPersistedSessionWorkflowHost({
		artifactRoot,
		rootSessionId,
		workflowId,
		goalProjection,
		genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
		goalAuthoritySourceResolver: {
			resolve: async () => ({
				objectGeneration: "1",
				bytes: goalBytes,
				parsedObjective,
				boundaryIds,
				gateIds,
			}),
		},
		approvalSecretDelivery: ({ request, proofs }) =>
			writeFileSync(approvalPath, canonicalJsonBytes({ request, proofs })),
	});
}

async function waitForBlocked(host: Awaited<ReturnType<typeof openHost>>): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (host.status().status === "blocked") return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("release_spine_workflow_did_not_block");
}

async function activateWorkflow(host: Awaited<ReturnType<typeof openHost>>) {
	const started = await host.execute({
		kind: "start",
		request: {
			workflowId,
			objective: parsedObjective,
			requestedProfile: "parallel",
			maxWorkers: 1,
			acceptanceChecks: gateIds,
			protectedInvariants: boundaryIds,
			goalContract: {
				authoritativeSource: {
					kind: "immutable_object",
					uri: "fixture://release-spine/goal",
					objectGeneration: "1",
					objectDigest: sha256Hex(goalBytes),
					objectSizeBytes: goalBytes.byteLength,
					parsedObjective,
					boundaryIds,
					gateIds,
				},
				successMetrics: [
					{
						metricId: "w1-gate-transition",
						requirementId: "w1-authoritative",
						direction: "at_least",
						target: 1,
						tolerance: 0,
						measurement: "fresh_process",
						guardIds: boundaryIds,
					},
				],
				nonGoalIds: ["worker-activity-is-not-progress"],
				budgets: { tokenLimit: 10_000, wallTimeLimitSeconds: 3_600, spendLimitMicrounits: 0 },
			},
		},
	});
	if (started.status !== "awaiting_user" || started.approvalRequest === null)
		throw new Error("release_spine_approval_request_missing");
	const delivery = parseCanonicalJsonBytes(new Uint8Array(readFileSync(approvalPath))) as {
		readonly proofs: Readonly<Record<string, unknown>>;
	};
	const option = started.approvalRequest.options.find(
		(candidate) => delivery.proofs[candidate.optionId] !== undefined,
	);
	if (option === undefined) throw new Error("release_spine_approval_option_missing");
	const active = await host.execute({
		kind: "respond",
		approvalRequestId: started.approvalRequest.approvalRequestId,
		optionId: option.optionId,
		proof: delivery.proofs[option.optionId] as never,
	});
	const decisionRef = active.decisionRefs.at(-1);
	const goalRevisionDigest = active.goalContract?.contractDigest;
	const durable = host.runtimeStore.durableContext;
	if (
		active.status !== "active" ||
		decisionRef === undefined ||
		goalRevisionDigest === undefined ||
		durable === undefined
	)
		throw new Error("release_spine_active_authority_missing");
	return { decisionRef, goalRevisionDigest, durable };
}

async function waitForDeadlineRetry(
	authority: ReturnType<typeof createDefaultTaskRuntimeAuthority>,
	host: Awaited<ReturnType<typeof openHost>>,
	epochRef: WorkflowEpochRef,
): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const audit = await authority.readAudit();
		const replay = await host.runtimeStore.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: epochRef.storeEpoch,
		});
		const dispatchCount = replay.events.filter((event) => event.payload.kind === "workflow_dispatch_intent").length;
		if (dispatchCount === 2 && audit.launchEvidenceRefs.length === 2 && audit.workerResults.length === 1) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("release_spine_deadline_retry_not_started");
}

async function deadlineResult(
	authority: ReturnType<typeof createDefaultTaskRuntimeAuthority>,
	host: Awaited<ReturnType<typeof openHost>>,
	epochRef: WorkflowEpochRef,
	unexpectedLaunches: number,
	retryDeadlineAt: string | null,
): Promise<Readonly<Record<string, unknown>>> {
	const audit = await authority.readAudit();
	const replay = await host.runtimeStore.replay({
		workflowId,
		fromSequence: 0,
		expectedStoreEpoch: epochRef.storeEpoch,
	});
	const deadlineResults = audit.workerResults.filter((result) => result.error === "task_deadline_expired");
	const dispatches = replay.events.flatMap((event) =>
		event.payload.kind === "workflow_dispatch_intent" ? [event.payload] : [],
	);
	const deadlineOutcomes = replay.events.flatMap((event) => {
		if (
			event.payload.kind !== "workflow_child_outcome_committed" ||
			event.payload.outcome.outcome.status !== "failed" ||
			event.payload.outcome.outcome.errorCode !== "task_deadline_expired"
		)
			return [];
		return [event.payload.outcome.outcome];
	});
	return {
		mode,
		status: host.status().status,
		unexpectedLaunches,
		dispatchCount: replay.events.filter((event) => event.payload.kind === "workflow_dispatch_intent").length,
		outcomeCount: replay.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed").length,
		releaseCount: replay.events.filter((event) => event.payload.kind === "workflow_lease_release_recorded").length,
		blockerCount: replay.events.filter((event) => event.payload.kind === "workflow_external_blocker_recorded").length,
		workerResultCount: audit.workerResults.length,
		retryableDeadlineResultCount: deadlineResults.filter((result) => result.retryable).length,
		retryableDeadlineOutcomeCount: deadlineOutcomes.filter((outcome) => outcome.retryable).length,
		resourceAdmissionCount: replay.events.filter((event) => event.payload.kind === "workflow_resource_lease_acquired")
			.length,
		attemptIds: dispatches.map((dispatch) => dispatch.attemptId),
		executionKeyCount: new Set(dispatches.map((dispatch) => dispatch.executionKey)).size,
		launchEvidenceCount: audit.launchEvidenceRefs.length,
		retryDeadlineAt,
		blocker: host.status().blocked ?? null,
	};
}

async function main(): Promise<void> {
	const host = await openHost();
	if (mode === "deadline-setup") {
		const { decisionRef, goalRevisionDigest, durable } = await activateWorkflow(host);
		const graph = taskGraph({ deadlineMs: 30_000, generatedOutput: true });
		let retryDeadlineAt: string | null = null;
		const authority = createDefaultTaskRuntimeAuthority({
			runtimeStore: host.runtimeStore,
			workflowId,
			rootSessionId,
			epochRef: durable.epochRef,
			decisionRef: currentDecisionRef(decisionRef, durable.epochRef),
			goalRevisionDigest,
			graph,
			maxWorkers: 1,
			now: () => new Date().toISOString(),
			progressLeaseDurationMs: 30_000,
			scheduleProgressWake: async () => "scheduled",
			blockWorkflow: (blocker) => host.blockOnExternal(blocker).then(() => undefined),
			workerLauncher: async (input) => {
				if (input.attemptId.endsWith(":retry:1")) retryDeadlineAt = input.deadlineAt;
				return {
					workerId: `worker:${input.attemptId}`,
					executionIdentity: `rlm:${input.executionKey}`,
					processStartId: `process:${process.pid}`,
					processGroupId: `process-group:${process.pid}`,
					launchedAt: new Date().toISOString(),
					terminate: async () => true,
					completion: input.attemptId.endsWith(":retry:1")
						? new Promise<never>(() => undefined)
						: Promise.resolve({
								kind: "worker" as const,
								binding: {
									workflowId: input.workflowId,
									taskId: input.taskId,
									attemptId: input.attemptId,
									executionKey: input.executionKey,
								},
								status: "cancelled" as const,
								output: "",
								error: "task_deadline_expired",
								retryable: false,
							}),
				};
			},
			createTaskCapsule: deadlineTaskCapsuleFactory(graph, goalRevisionDigest),
			prime: primeAdapter(),
		});
		await authority.start();
		await waitForDeadlineRetry(authority, host, durable.epochRef);
		writeFileSync(
			resultPath,
			canonicalJsonBytes(await deadlineResult(authority, host, durable.epochRef, 0, retryDeadlineAt)),
		);
		setInterval(() => {}, 1_000);
		return;
	}

	if (mode === "deadline-recover") {
		const status = host.status();
		const decisionRef = status.decisionRefs.at(-1);
		const goalRevisionDigest = status.goalContract?.contractDigest;
		const durable = host.runtimeStore.durableContext;
		if (
			status.status !== "active" ||
			decisionRef === undefined ||
			goalRevisionDigest === undefined ||
			durable === undefined
		)
			throw new Error("release_spine_deadline_authority_not_reconstructed");
		let unexpectedLaunches = 0;
		const graph = taskGraph({ deadlineMs: 30_000, generatedOutput: true });
		const authority = createDefaultTaskRuntimeAuthority({
			runtimeStore: host.runtimeStore,
			workflowId,
			rootSessionId,
			epochRef: durable.epochRef,
			decisionRef: currentDecisionRef(decisionRef, durable.epochRef),
			goalRevisionDigest,
			graph,
			maxWorkers: 1,
			now: () => new Date().toISOString(),
			progressLeaseDurationMs: 30_000,
			scheduleProgressWake: async () => "already_scheduled",
			blockWorkflow: (blocker) => host.blockOnExternal(blocker).then(() => undefined),
			workerLauncher: async () => {
				unexpectedLaunches += 1;
				throw new Error("release_spine_deadline_duplicate_launch");
			},
			createTaskCapsule: deadlineTaskCapsuleFactory(graph, goalRevisionDigest),
			prime: primeAdapter(),
		});
		await authority.start();
		await waitForBlocked(host);
		writeFileSync(
			resultPath,
			canonicalJsonBytes(await deadlineResult(authority, host, durable.epochRef, unexpectedLaunches, null)),
		);
		await host.dispose?.();
		return;
	}

	if (mode === "setup") {
		const started = await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: parsedObjective,
				requestedProfile: "parallel",
				maxWorkers: 1,
				acceptanceChecks: gateIds,
				protectedInvariants: boundaryIds,
				goalContract: {
					authoritativeSource: {
						kind: "immutable_object",
						uri: "fixture://release-spine/goal",
						objectGeneration: "1",
						objectDigest: sha256Hex(goalBytes),
						objectSizeBytes: goalBytes.byteLength,
						parsedObjective,
						boundaryIds,
						gateIds,
					},
					successMetrics: [
						{
							metricId: "w1-gate-transition",
							requirementId: "w1-authoritative",
							direction: "at_least",
							target: 1,
							tolerance: 0,
							measurement: "fresh_process",
							guardIds: boundaryIds,
						},
					],
					nonGoalIds: ["worker-activity-is-not-progress"],
					budgets: { tokenLimit: 10_000, wallTimeLimitSeconds: 3_600, spendLimitMicrounits: 0 },
				},
			},
		});
		if (started.status !== "awaiting_user" || started.approvalRequest === null)
			throw new Error("release_spine_approval_request_missing");
		const delivery = parseCanonicalJsonBytes(new Uint8Array(readFileSync(approvalPath))) as {
			readonly proofs: Readonly<Record<string, unknown>>;
		};
		const option = started.approvalRequest.options.find(
			(candidate) => delivery.proofs[candidate.optionId] !== undefined,
		);
		if (option === undefined) throw new Error("release_spine_approval_option_missing");
		const active = await host.execute({
			kind: "respond",
			approvalRequestId: started.approvalRequest.approvalRequestId,
			optionId: option.optionId,
			proof: delivery.proofs[option.optionId] as never,
		});
		const decisionRef = active.decisionRefs.at(-1);
		const goalRevisionDigest = active.goalContract?.contractDigest;
		const durable = host.runtimeStore.durableContext;
		if (
			active.status !== "active" ||
			decisionRef === undefined ||
			goalRevisionDigest === undefined ||
			durable === undefined
		)
			throw new Error("release_spine_active_authority_missing");
		const authority = createDefaultTaskRuntimeAuthority({
			runtimeStore: host.runtimeStore,
			workflowId,
			rootSessionId,
			epochRef: durable.epochRef,
			decisionRef: currentDecisionRef(decisionRef, durable.epochRef),
			goalRevisionDigest,
			graph: taskGraph(),
			maxWorkers: 1,
			now: () => new Date().toISOString(),
			progressLeaseDurationMs: 60_000,
			scheduleProgressWake: async () => "scheduled",
			blockWorkflow: (blocker) => host.blockOnExternal(blocker).then(() => undefined),
			workerLauncher: async (input) => {
				await input.reportHeartbeat({
					observedAt: new Date().toISOString(),
					progressDigest: digestObject({ taskId: input.taskId, evidence: "meaningful" }),
				});
				return {
					workerId: "worker:w1",
					executionIdentity: `rlm:worker:w1:${input.executionKey}`,
					processStartId: `process:${process.pid}`,
					processGroupId: `process-group:${process.pid}`,
					launchedAt: new Date().toISOString(),
					completion: Promise.resolve({
						kind: "worker" as const,
						binding: {
							workflowId: input.workflowId,
							taskId: input.taskId,
							attemptId: input.attemptId,
							executionKey: input.executionKey,
						},
						status: "error",
						output: "",
						error: "bounded_tool_stalled",
						retryable: true,
					}),
				};
			},
			prime: primeAdapter(),
		});
		await authority.start();
		await waitForBlocked(host);
		const replay = await host.runtimeStore.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: durable.epochRef.storeEpoch,
		});
		writeFileSync(
			resultPath,
			canonicalJsonBytes({
				mode,
				status: host.status().status,
				goalRevisionDigest,
				dispatchCount: replay.events.filter((event) => event.payload.kind === "workflow_dispatch_intent").length,
				heartbeatCount: replay.events.filter((event) => event.payload.kind === "workflow_task_lease_heartbeat")
					.length,
				outcomeCount: replay.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")
					.length,
				releaseCount: replay.events.filter((event) => event.payload.kind === "workflow_lease_release_recorded")
					.length,
				blocker: host.status().blocked,
			}),
		);
		setInterval(() => {}, 1_000);
		return;
	}

	const status = host.status();
	const decisionRef = status.decisionRefs.at(-1);
	const goalRevisionDigest = status.goalContract?.contractDigest;
	const durable = host.runtimeStore.durableContext;
	if (
		status.status !== "blocked" ||
		decisionRef === undefined ||
		goalRevisionDigest === undefined ||
		durable === undefined
	)
		throw new Error("release_spine_blocker_not_reconstructed");
	let unexpectedLaunches = 0;
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: host.runtimeStore,
		workflowId,
		rootSessionId,
		epochRef: durable.epochRef,
		decisionRef: currentDecisionRef(decisionRef, durable.epochRef),
		goalRevisionDigest,
		graph: taskGraph(),
		maxWorkers: 1,
		now: () => new Date().toISOString(),
		progressLeaseDurationMs: 60_000,
		scheduleProgressWake: async () => "already_scheduled",
		workerLauncher: async () => {
			unexpectedLaunches += 1;
			throw new Error("release_spine_duplicate_launch");
		},
		prime: primeAdapter(),
	});
	await authority.start();
	const reconstructedTask = await authority.readStatus();
	const resumed = await host.resumeBlocked({
		eventKind: "workflow_attempt_reconciled",
		eventDigest: digestObject({ workflowId, taskId: "w1", disposition: "reconciled" }),
		observedAt: new Date().toISOString(),
	});
	let duplicateResumeRejected = false;
	try {
		await host.resumeBlocked({
			eventKind: "workflow_attempt_reconciled",
			eventDigest: digestObject({ workflowId, taskId: "w1", disposition: "reconciled" }),
			observedAt: new Date().toISOString(),
		});
	} catch {
		duplicateResumeRejected = true;
	}
	const replay = await host.runtimeStore.replay({
		workflowId,
		fromSequence: 0,
		expectedStoreEpoch: durable.epochRef.storeEpoch,
	});
	writeFileSync(
		resultPath,
		canonicalJsonBytes({
			mode,
			statusBefore: status.status,
			statusAfter: resumed.status,
			taskStatus: reconstructedTask.status,
			unexpectedLaunches,
			duplicateResumeRejected,
			goalRevisionDigest,
			dispatchCount: replay.events.filter((event) => event.payload.kind === "workflow_dispatch_intent").length,
			heartbeatCount: replay.events.filter((event) => event.payload.kind === "workflow_task_lease_heartbeat").length,
			outcomeCount: replay.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed")
				.length,
			releaseCount: replay.events.filter((event) => event.payload.kind === "workflow_lease_release_recorded").length,
			blockerCount: replay.events.filter((event) => event.payload.kind === "workflow_external_blocker_recorded")
				.length,
			resolutionCount: replay.events.filter((event) => event.payload.kind === "workflow_external_blocker_resolved")
				.length,
		}),
	);
	await host.dispose?.();
}

await main();
