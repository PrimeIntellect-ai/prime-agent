import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { emptyGoalState, type GoalState } from "../../src/core/goals.js";
import type { WorkflowDecisionRef, WorkflowEpochRef } from "../../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes } from "../../src/core/workflow/contracts.js";
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
if ((mode !== "setup" && mode !== "early-recover" && mode !== "deadline-recover") || artifactRoot === undefined)
	throw new Error(
		"Usage: retryable-result-recovery-process.ts <setup|early-recover|deadline-recover> <artifact-root>",
	);

const WORKFLOW_ID = "retryable-result-recovery-workflow";
const ROOT_SESSION_ID = "retryable-result-recovery-session";
const WRITER_IDENTITY = "workflow-coordinator:retryable-result-recovery";
const PROCESS_IDENTITY = `process:${process.pid}:retryable-result-recovery`;
const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const GOAL_REVISION_DIGEST = digestObject({ goal: "retryable result recovery" });
const APPROVAL_PATH = join(artifactRoot, "approval.json");
const METADATA_PATH = join(artifactRoot, "metadata.json");
const RESULT_PATH = join(artifactRoot, `${mode}.json`);

mkdirSync(artifactRoot, { recursive: true });
chmodSync(artifactRoot, 0o700);

function writeResult(value: Record<string, unknown>): void {
	const temporaryPath = `${RESULT_PATH}.tmp`;
	writeFileSync(temporaryPath, canonicalJsonBytes(value));
	renameSync(temporaryPath, RESULT_PATH);
}

function readGoal(): GoalState {
	const path = join(artifactRoot, "goal.json");
	try {
		return parseCanonicalJsonBytes(new Uint8Array(readFileSync(path))) as unknown as GoalState;
	} catch {
		const initial = emptyGoalState();
		writeFileSync(path, canonicalJsonBytes(initial));
		return initial;
	}
}

const goalProjection = {
	read: (): GoalState => readGoal(),
	compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
		if (digestObject(readGoal()) !== digestObject(expected)) return false;
		writeFileSync(join(artifactRoot, "goal.json"), canonicalJsonBytes(next));
		return true;
	},
};

function taskGraph(): WorkflowTaskGraph {
	const task: WorkflowTask = {
		taskId: "recon",
		planRevision: 1,
		objective: "produce one canonical recon result",
		requirementIds: ["canonical-result"],
		completionCriteria: ["the host accepts the canonical result"],
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
			wallMilliseconds: 600_000,
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
	const generatedOutputPaths = ["artifacts/out"];
	return {
		graphRevision: 1,
		tasks: [task],
		byId: new Map([[task.taskId, task]]),
		allowedAuthority: ["read_workspace"],
		ownershipPaths: [],
		generatedOutputPaths,
		lockPaths: generatedOutputPaths,
		namedContracts: ["evidence-recon"],
		graphDigest: digestObject({ task, generatedOutputPaths }),
	};
}

function capsuleFactory(
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
			goalBindingDigest: digestObject({ workflowId: WORKFLOW_ID, goalRevisionDigest: GOAL_REVISION_DIGEST }),
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
		const artifactRef = {
			artifactId: `capsule:${capsuleDigest}`,
			relativePath: `artifacts/evidence/${capsuleDigest}`,
			digest: capsuleDigest,
			sizeBytes: canonicalJsonBytes(core).byteLength,
			sourceEventSequence: request.journalHead.sequence,
		};
		const issuedAt = new Date(Date.parse(request.deadlineAt) - 60_000).toISOString();
		return {
			...core,
			capsuleDigest,
			receipt: {
				receiptKind: "artifact",
				oneUse: false,
				receiptId: `capsule-receipt:${request.attemptId}`,
				issuerId: "workflow-host",
				workflowId: WORKFLOW_ID,
				bindingDigest: defaultPrimeWorkerTaskCapsuleReceiptBindingDigest(capsuleDigest),
				payloadDigest: capsuleDigest,
				artifactRef,
				issuedAt,
				validUntil: request.deadlineAt,
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
			throw new Error("retryable_result_recovery_status_not_used");
		},
		recordTelemetry: async () => undefined,
		assertStageAcceptable: async () => undefined,
		acceptStage: async () => undefined,
		readAudit: async () => ({ terminalTaskIds: [], launchEvidenceRefs: [], workerResults: [] }),
	};
}

function decisionRef(status: { readonly decisionRefs: readonly WorkflowDecisionRef[] }): WorkflowDecisionRef {
	const ref = status.decisionRefs.at(-1);
	if (ref === undefined) throw new Error("retryable_result_recovery_decision_missing");
	return ref;
}

function currentDecisionRef(
	status: { readonly decisionRefs: readonly WorkflowDecisionRef[] },
	epochRef: WorkflowEpochRef,
): WorkflowDecisionRef {
	return { ...decisionRef(status), storeEpoch: epochRef.storeEpoch, coordinatorEpoch: epochRef.coordinatorEpoch };
}

async function openHost(now: string) {
	return createPersistedSessionWorkflowHost({
		artifactRoot,
		rootSessionId: ROOT_SESSION_ID,
		workflowId: WORKFLOW_ID,
		writerIdentity: WRITER_IDENTITY,
		processIdentity: PROCESS_IDENTITY,
		now: () => now,
		goalProjection,
		genesisEpoch: EPOCH,
		approvalSecretDelivery: ({ request, proofs }) =>
			writeFileSync(APPROVAL_PATH, canonicalJsonBytes({ request, proofs })),
	});
}

async function activateWorkflow(host: Awaited<ReturnType<typeof openHost>>): Promise<void> {
	const started = await host.execute({
		kind: "start",
		request: {
			workflowId: WORKFLOW_ID,
			objective: "recover retryable canonical result exactly once",
			requestedProfile: "parallel",
			maxWorkers: 1,
			acceptanceChecks: ["canonical-result"],
			protectedInvariants: ["old attempt is never relaunched"],
		},
	});
	if (started.status !== "awaiting_user" || started.approvalRequest === null)
		throw new Error("retryable_result_recovery_approval_missing");
	const delivery = parseCanonicalJsonBytes(new Uint8Array(readFileSync(APPROVAL_PATH))) as {
		readonly proofs: Readonly<Record<string, unknown>>;
	};
	const option = started.approvalRequest.options.find(
		(candidate) => delivery.proofs[candidate.optionId] !== undefined,
	);
	if (option === undefined) throw new Error("retryable_result_recovery_approval_proof_missing");
	const active = await host.execute({
		kind: "respond",
		approvalRequestId: started.approvalRequest.approvalRequestId,
		optionId: option.optionId,
		proof: delivery.proofs[option.optionId] as never,
	});
	if (active.status !== "active") throw new Error("retryable_result_recovery_workflow_not_active");
}

async function runBoundedChild(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
		cwd: artifactRoot,
		stdio: "ignore",
	});
	if (child.pid === undefined) throw new Error("retryable_result_recovery_child_pid_missing");
	const pid = child.pid;
	await new Promise<void>((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("exit", (code, signal) => {
			if (code !== 0 || signal !== null) {
				rejectExit(new Error("retryable_result_recovery_child_failed"));
				return;
			}
			resolveExit();
		});
	});
	return pid;
}

function readMetadata(): {
	readonly completedAt: string;
	readonly firstAttemptId: string;
	readonly firstExecutionKey: string;
	readonly firstWorkerId: string;
	readonly firstWorkerPid: number;
} {
	return JSON.parse(readFileSync(METADATA_PATH, "utf8")) as {
		completedAt: string;
		firstAttemptId: string;
		firstExecutionKey: string;
		firstWorkerId: string;
		firstWorkerPid: number;
	};
}

async function setup(): Promise<void> {
	const now = new Date().toISOString();
	const host = await openHost(now);
	await activateWorkflow(host);
	const status = host.status();
	const durable = host.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("retryable_result_recovery_durable_context_missing");
	const graph = taskGraph();
	let launches = 0;
	let workflowStatus: "active" | "paused" = "active";
	let recoveryWakeCallbackReturned = false;
	let resolveRecoveryWakeOperationStarted: (() => void) | undefined;
	const recoveryWakeOperationStarted = new Promise<void>((resolve) => {
		resolveRecoveryWakeOperationStarted = resolve;
	});
	// The scheduler callback returns before recoverProgressWake reaches launchReady; this lease waits for that paused-path auxiliary write to finish.
	const recoveryWakeCompletion = (async (): Promise<void> => {
		await recoveryWakeOperationStarted;
		await durable.withExclusiveLease("retryable-result-recovery-complete", async () => undefined);
	})();
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: host.runtimeStore,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: durable.epochRef,
		decisionRef: currentDecisionRef(status, durable.epochRef),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph,
		maxWorkers: 1,
		now: () => now,
		progressLeaseDurationMs: 600_000,
		scheduleProgressWake: async () => {
			recoveryWakeCallbackReturned = true;
			return "scheduled";
		},
		readWorkflowStatus: () => {
			if (recoveryWakeCallbackReturned) {
				resolveRecoveryWakeOperationStarted?.();
				resolveRecoveryWakeOperationStarted = undefined;
			}
			return { status: workflowStatus, blocked: undefined };
		},
		workerLauncher: async (input) => {
			launches += 1;
			const childPid = await runBoundedChild();
			const workerId = `session:${input.attemptId}:${childPid}`;
			workflowStatus = "paused";
			const canonical = new TextDecoder().decode(
				canonicalJsonBytes({
					findings: ["the host received one canonical result"],
					kind: "default_prime_task_output_v1",
					schemaVersion: 1,
					summary: "canonical result",
					taskId: input.taskId,
				}),
			);
			return {
				workerId,
				executionIdentity: `session:${input.executionKey}`,
				processStartId: `process-start:${childPid}`,
				processGroupId: `process-group:${childPid}`,
				launchedAt: now,
				completion: Promise.resolve({
					kind: "worker" as const,
					status: "completed" as const,
					output: `assistant commentary before canonical result\n${canonical}`,
					error: null,
					retryable: false,
					binding: {
						workflowId: input.workflowId,
						taskId: input.taskId,
						attemptId: input.attemptId,
						executionKey: input.executionKey,
					},
				}),
			};
		},
		createTaskCapsule: capsuleFactory(graph),
		prime: primeAdapter(),
	});
	await authority.start();
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const audit = await authority.readAudit();
		if (audit.workerResults.length === 1) {
			await Promise.race([
				recoveryWakeCompletion,
				new Promise<never>((_, reject) => {
					const timeout = setTimeout(
						() => reject(new Error("retryable_result_recovery_completion_timeout")),
						Math.max(0, deadline - Date.now()),
					);
					timeout.unref?.();
				}),
			]);
			const settledAudit = await authority.readAudit();
			const result = settledAudit.workerResults[0];
			if (result === undefined) throw new Error("retryable_result_recovery_result_missing");
			const replay = await host.runtimeStore.replay({
				workflowId: WORKFLOW_ID,
				fromSequence: 0,
				expectedStoreEpoch: durable.epochRef.storeEpoch,
			});
			const retryableOutcomeCount = replay.events.filter(
				(event) =>
					event.payload.kind === "workflow_child_outcome_committed" &&
					event.payload.outcome.outcome.status === "failed" &&
					event.payload.outcome.outcome.retryable === true,
			).length;
			if (retryableOutcomeCount !== 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				continue;
			}
			const firstWorkerPid = Number(result.workerId.split(":").at(-1));
			const resultValue = {
				mode,
				status: host.status().status,
				launches,
				result,
				completedAt: result.completedAt,
				deadlineAt: new Date(Date.parse(result.completedAt) + 120_000).toISOString(),
				dispatchCount: replay.events.filter((event) => event.payload.kind === "workflow_dispatch_intent").length,
				retryableOutcomeCount,
				firstWorkerPid,
			};
			await host.dispose?.();
			writeFileSync(
				METADATA_PATH,
				canonicalJsonBytes({
					completedAt: result.completedAt,
					firstAttemptId: result.attemptId,
					firstExecutionKey: result.executionKey,
					firstWorkerId: result.workerId,
					firstWorkerPid,
				}),
			);
			writeResult(resultValue);
			setInterval(() => undefined, 1_000);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("retryable_result_recovery_setup_timeout");
}

async function recover(): Promise<void> {
	const metadata = readMetadata();
	const recoveryAt = new Date(
		Date.parse(metadata.completedAt) + (mode === "early-recover" ? 60_000 : 120_000),
	).toISOString();
	const host = await openHost(recoveryAt);
	const status = host.status();
	const durable = host.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("retryable_result_recovery_durable_context_missing");
	const graph = taskGraph();
	let launches = 0;
	const workerIds: string[] = [];
	const authority = createDefaultTaskRuntimeAuthority({
		runtimeStore: host.runtimeStore,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		epochRef: durable.epochRef,
		decisionRef: currentDecisionRef(status, durable.epochRef),
		goalRevisionDigest: GOAL_REVISION_DIGEST,
		graph,
		maxWorkers: 1,
		now: () => recoveryAt,
		progressLeaseDurationMs: 600_000,
		scheduleProgressWake: async () => "already_scheduled",
		blockWorkflow: (blocker) => host.blockOnExternal(blocker).then(() => undefined),
		workerLauncher: async (input) => {
			launches += 1;
			if (mode === "deadline-recover") throw new Error("retryable_result_recovery_duplicate_launch");
			const childPid = await runBoundedChild();
			const workerId = `session:${input.attemptId}:${childPid}`;
			workerIds.push(workerId);
			const output = new TextDecoder().decode(
				canonicalJsonBytes({
					findings: ["the retry returned one exact canonical result"],
					kind: "default_prime_task_output_v1",
					schemaVersion: 1,
					summary: "retry accepted",
					taskId: input.taskId,
				}),
			);
			return {
				workerId,
				executionIdentity: `session:${input.executionKey}`,
				processStartId: `process-start:${childPid}`,
				processGroupId: `process-group:${childPid}`,
				launchedAt: recoveryAt,
				completion: Promise.resolve({
					kind: "worker" as const,
					status: "completed" as const,
					output,
					error: null,
					retryable: false,
					binding: {
						workflowId: input.workflowId,
						taskId: input.taskId,
						attemptId: input.attemptId,
						executionKey: input.executionKey,
					},
				}),
			};
		},
		createTaskCapsule: capsuleFactory(graph),
		prime: primeAdapter(),
	});
	await authority.start();
	if (mode === "early-recover") {
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const audit = await authority.readAudit();
			if (audit.terminalTaskIds.includes("recon")) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	const audit = await authority.readAudit();
	const replay = await host.runtimeStore.replay({
		workflowId: WORKFLOW_ID,
		fromSequence: 0,
		expectedStoreEpoch: durable.epochRef.storeEpoch,
	});
	const dispatches = replay.events.flatMap((event) =>
		event.payload.kind === "workflow_dispatch_intent" ? [event.payload] : [],
	);
	writeResult({
		mode,
		status: host.status().status,
		blocker: host.status().blocked ?? null,
		launches,
		attemptIds: dispatches.map((dispatch) => dispatch.attemptId),
		executionKeys: dispatches.map((dispatch) => dispatch.executionKey),
		workerIds: [metadata.firstWorkerId, ...workerIds],
		oldAttemptCount: dispatches.filter((dispatch) => dispatch.attemptId === metadata.firstAttemptId).length,
		oldWorkerIdReused: workerIds.includes(metadata.firstWorkerId),
		terminalTaskIds: audit.terminalTaskIds,
		completedAt: metadata.completedAt,
		recoveryAt,
		dispatchCount: dispatches.length,
	});
	await host.dispose?.();
}

if (mode === "setup") await setup();
else await recover();
