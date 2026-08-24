import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
	WorkflowArtifactRef,
	WorkflowAuthoritativeProgressCut,
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalHead,
	WorkflowPhaseOutcomeRecord,
	WorkflowProgressLease,
	WorkflowProgressPredicate,
	WorkflowResourceAdmission,
	WorkflowResourceLease,
	WorkflowRuntimeStore,
} from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes, sha256Hex } from "./contracts.js";
import type {
	DefaultPrimeTaskCapsuleFactory,
	DefaultPrimeWorkerCompletion,
	DefaultPrimeWorkerFailureNotice,
	DefaultPrimeWorkerLaunch,
	DefaultPrimeWorkerLauncher,
	DefaultPrimeWorkerTaskCapsule,
	DefaultPrimeWorkerTaskCapsuleCore,
} from "./default-task-runtime.js";
import {
	defaultPrimeWorkerTaskCapsuleDigest,
	defaultPrimeWorkerTaskCapsuleReceiptBindingDigest,
	workflowToolsForCapabilities,
} from "./default-task-runtime.js";
import type { WorkflowDispatcher, WorkflowDispatchResult } from "./dispatch.js";
import { leaseRefOf } from "./dispatch.js";
import type { WorkflowEffectBroker } from "./effect-broker.js";
import type { WorkflowLeaseManager } from "./leases.js";
import type { WorkflowExternalBlockerInput } from "./phase-host.js";
import { WORKFLOW_WRITE_AUTHORITY_CAPABILITIES } from "./recipes.js";
import type { WorkflowReconciliationOutcome, WorkflowRecoveryRequest } from "./recovery.js";
import type { WorkflowRuntimeRecoveryCoordinator } from "./runtime-recovery.js";
import type { WorkflowScheduler, WorkflowSchedulerEvent, WorkflowSchedulerState } from "./scheduler.js";
import type { WorkflowShellStatus } from "./shell.js";
import type { WorkflowTask, WorkflowTaskGraph } from "./task-graph.js";
import { parseWorkflowCanonicalPath } from "./task-graph.js";
import type {
	WorkflowPrimeStageEvidenceAdapter,
	WorkflowTaskRuntimeAuthority,
	WorkflowTaskRuntimeEvidenceClassification,
	WorkflowTaskRuntimeTelemetry,
	WorkflowTaskRuntimeWorkerResult,
} from "./task-runtime-authority.js";

const DEFAULT_TASK_RUNTIME_RECORD = "default-prime-task-runtime-v1.json";
const DEFAULT_PROGRESS_LEASE_DURATION_MS = 5 * 60 * 1_000;
const PROGRESS_RECOVERY_DEADLINE_MILLISECONDS = 120_000;
const RUNTIME_EVENT_REBASE_LIMIT = 4;
const TERMINAL_RESULT_PUBLICATION_RETRY_LIMIT = 4;
const TERMINAL_RESULT_PUBLICATION_RETRY_DELAY_MILLISECONDS = 10;
const TASK_RETRY_LIMIT = 1;
const DEFAULT_PRIME_HOST_COMPLETION_TOKEN: unique symbol = Symbol("default-prime-host-completion");
const PROGRESS_REJECTED_RENEWAL_SIGNALS = [
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
] as const;

function isStaleRuntimeEventCommit(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message ===
			"Workflow store compare-and-swap precondition is stale or is not bound to the active writer and lease." ||
			error.message === "Workflow journal expected head is stale." ||
			error.message === "workflow_append_lease_guard_timeout")
	);
}

function isAppendGuardTimeout(error: unknown): boolean {
	return error instanceof Error && error.message === "workflow_append_lease_guard_timeout";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function isEpochRef(value: unknown): value is WorkflowEpochRef {
	return (
		isRecord(value) &&
		Number.isSafeInteger(value.storeEpoch) &&
		(value.storeEpoch as number) > 0 &&
		Number.isSafeInteger(value.coordinatorEpoch) &&
		(value.coordinatorEpoch as number) > 0
	);
}

function isJournalHead(value: unknown): value is WorkflowJournalHead {
	return (
		isRecord(value) &&
		typeof value.workflowId === "string" &&
		Number.isSafeInteger(value.sequence) &&
		(value.sequence as number) >= 0 &&
		(value.eventDigest === null || typeof value.eventDigest === "string") &&
		isEpochRef(value.epochRef)
	);
}

function isArtifactRef(value: unknown): value is WorkflowArtifactRef {
	return (
		isRecord(value) &&
		typeof value.artifactId === "string" &&
		typeof value.relativePath === "string" &&
		typeof value.digest === "string" &&
		/^[0-9a-f]{64}$/u.test(value.digest) &&
		Number.isSafeInteger(value.sizeBytes) &&
		(value.sizeBytes as number) >= 0 &&
		Number.isSafeInteger(value.sourceEventSequence) &&
		(value.sourceEventSequence as number) >= 0
	);
}

function isDefaultTaskRuntimeTerminalPacket(value: unknown): value is DefaultTaskRuntimeTerminalPacket {
	return (
		isRecord(value) &&
		value.kind === "default_prime_worker_terminal_packet" &&
		typeof value.workflowId === "string" &&
		typeof value.taskId === "string" &&
		typeof value.attemptId === "string" &&
		typeof value.executionKey === "string" &&
		typeof value.workerId === "string" &&
		value.workerId.length > 0 &&
		value.status === "completed" &&
		typeof value.output === "string" &&
		value.output.length > 0 &&
		value.error === null &&
		value.retryable === false &&
		typeof value.completedAt === "string" &&
		Number.isFinite(Date.parse(value.completedAt)) &&
		typeof value.goalRevisionDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(value.goalRevisionDigest) &&
		typeof value.graphDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(value.graphDigest) &&
		typeof value.inputStateDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(value.inputStateDigest) &&
		typeof value.launchEvidenceDigest === "string" &&
		/^[0-9a-f]{64}$/u.test(value.launchEvidenceDigest) &&
		isEpochRef(value.epochRef) &&
		isJournalHead(value.journalHead)
	);
}

function isDefaultTaskRuntimeGeneratedOutput(value: unknown): value is DefaultTaskRuntimeGeneratedOutput {
	if (
		!isRecord(value) ||
		(value.kind !== "default_prime_generated_task_output" && value.kind !== "default-prime-autoresearch-evidence") ||
		typeof value.workflowId !== "string" ||
		typeof value.taskId !== "string" ||
		typeof value.attemptId !== "string" ||
		typeof value.executionKey !== "string" ||
		typeof value.workerId !== "string" ||
		value.workerId.length === 0 ||
		value.status !== "completed" ||
		!isRecord(value.output) ||
		typeof value.completedAt !== "string" ||
		!Number.isFinite(Date.parse(value.completedAt)) ||
		typeof value.goalRevisionDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.goalRevisionDigest) ||
		typeof value.graphDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.graphDigest) ||
		typeof value.inputStateDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.inputStateDigest) ||
		typeof value.launchEvidenceDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.launchEvidenceDigest) ||
		typeof value.capsuleDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.capsuleDigest) ||
		typeof value.recipeCapability !== "string" ||
		(value.recipeCapability !== "dynamic_task_graph" && value.recipeCapability !== "builtin_adaptive_prime") ||
		typeof value.logicalPath !== "string" ||
		typeof value.evidencePolicyId !== "string" ||
		typeof value.independent !== "boolean" ||
		!isEpochRef(value.epochRef) ||
		!isJournalHead(value.journalHead)
	)
		return false;
	if (value.recipeCapability === "dynamic_task_graph") {
		return (
			typeof value.taskGraphSourceDigest === "string" &&
			/^[0-9a-f]{64}$/u.test(value.taskGraphSourceDigest) &&
			typeof value.evidenceKind === "string" &&
			isRecord(value.evidencePolicy) &&
			Array.isArray(value.requirementIds) &&
			Array.isArray(value.completionCriteria) &&
			Array.isArray(value.inputRefs) &&
			Array.isArray(value.boundaryIds) &&
			Array.isArray(value.outputRefs) &&
			isRecord(value.budget) &&
			typeof value.recoveryPolicy === "string" &&
			(value.recoveryPolicy === "retry" || value.recoveryPolicy === "replan" || value.recoveryPolicy === "block") &&
			Array.isArray(value.authority)
		);
	}
	return true;
}

function isDefaultTaskRuntimeLaunchReceipt(value: unknown): value is DefaultTaskRuntimeLaunchReceipt {
	return (
		isRecord(value) &&
		value.kind === "default_prime_worker_launch_receipt" &&
		typeof value.workflowId === "string" &&
		typeof value.taskId === "string" &&
		typeof value.attemptId === "string" &&
		typeof value.executionKey === "string" &&
		typeof value.workerId === "string" &&
		value.workerId.length > 0 &&
		isEpochRef(value.epochRef)
	);
}

async function readDefaultTaskRuntimeEvidenceArtifacts(
	runtimeStore: WorkflowRuntimeStore,
): Promise<readonly DefaultTaskRuntimeRecoveredArtifact[]> {
	const artifacts: DefaultTaskRuntimeRecoveredArtifact[] = [];
	const evidenceRoots = [
		join(runtimeStore.identity.rootDir, "artifacts", "evidence"),
		join(runtimeStore.identity.rootDir, "workflows", runtimeStore.identity.workflowId, "artifacts", "evidence"),
	];
	for (const evidenceRoot of evidenceRoots) {
		let entries: readonly Dirent[];
		try {
			entries = await readdir(evidenceRoot, { withFileTypes: true });
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !/^[0-9a-f]{64}$/u.test(entry.name)) continue;
			const artifactPath = join(evidenceRoot, entry.name);
			const metadataPath = `${artifactPath}.metadata.json`;
			let bytes: Uint8Array;
			let metadataBytes: Uint8Array;
			try {
				bytes = new Uint8Array(await readFile(artifactPath));
				metadataBytes = new Uint8Array(await readFile(metadataPath));
			} catch (error) {
				if (isRecord(error) && error.code === "ENOENT") continue;
				throw error;
			}
			if (sha256Hex(bytes) !== entry.name) continue;
			let payload: unknown;
			let metadata: unknown;
			try {
				payload = parseCanonicalJsonBytes(bytes);
				metadata = parseCanonicalJsonBytes(metadataBytes);
			} catch {
				continue;
			}
			if (!sameBytes(canonicalJsonBytes(payload), bytes) || !isRecord(metadata)) continue;
			if (
				metadata.payloadKind !== "evidence" ||
				metadata.codec !== "canonical_json" ||
				metadata.immutable !== true ||
				!isArtifactRef(metadata.ref) ||
				metadata.ref.artifactId !== `evidence:${entry.name}` ||
				metadata.ref.relativePath !== `artifacts/evidence/${entry.name}` ||
				metadata.ref.digest !== entry.name ||
				metadata.ref.sizeBytes !== bytes.byteLength
			)
				continue;
			if (!isRecord(payload)) continue;
			artifacts.push({ ref: metadata.ref, payload });
		}
	}
	return artifacts;
}

interface DefaultTaskRuntimeLaunch {
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly workerId: string | null;
	readonly status: "launching" | "running" | "completed" | "error" | "cancelled" | "ambiguous";
	readonly launchEvidenceRef: WorkflowArtifactRef | null;
	readonly taskCapsule: DefaultPrimeWorkerTaskCapsule | null;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly result: WorkflowTaskRuntimeWorkerResult | null;
}

interface DefaultTaskRuntimeProgressRecoveryWake {
	readonly leaseId: string;
	readonly wakeObligationId: string;
	readonly predicateDigest: string;
	readonly recoveryAttempt: number;
	readonly readyTaskIds: readonly string[];
	readonly recoveryStartedAt: string;
	readonly deadlineAt: string;
	readonly status: "pending" | "admitted" | "blocked";
}

interface DefaultTaskRuntimeState {
	readonly version: 1;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly graphDigest: string;
	readonly launches: readonly DefaultTaskRuntimeLaunch[];
	readonly pendingCompletions: readonly DefaultTaskRuntimePendingCompletion[];
	readonly terminalTaskIds: readonly string[];
	readonly latestTelemetry: WorkflowTaskRuntimeTelemetry | null;
	readonly progressRecoveryWake: DefaultTaskRuntimeProgressRecoveryWake | null;
	readonly stateDigest: string;
}

interface DefaultTaskRuntimeHostCompletion {
	readonly kind: "host";
	readonly hostToken: typeof DEFAULT_PRIME_HOST_COMPLETION_TOKEN;
	readonly status: "error";
	readonly output: "";
	readonly error: "task_deadline_expired" | "task_resource_lease_expired";
	readonly retryable: true;
}

type DefaultTaskRuntimeCompletion = DefaultPrimeWorkerCompletion | DefaultTaskRuntimeHostCompletion;

type DefaultTaskRuntimeReplayEvent = Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>["events"][number];
type DefaultTaskRuntimeDispatchEvent = Extract<
	DefaultTaskRuntimeReplayEvent["payload"],
	{ kind: "workflow_dispatch_intent" }
>;

interface DefaultTaskRuntimeRecoveredArtifact {
	readonly ref: WorkflowArtifactRef;
	readonly payload: Record<string, unknown>;
}

interface DefaultTaskRuntimeTerminalPacket {
	readonly kind: "default_prime_worker_terminal_packet";
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly workerId: string;
	readonly status: "completed";
	readonly output: string;
	readonly error: null;
	readonly retryable: false;
	readonly completedAt: string;
	readonly goalRevisionDigest: string;
	readonly graphDigest: string;
	readonly inputStateDigest: string;
	readonly launchEvidenceDigest: string;
	readonly epochRef: WorkflowEpochRef;
	readonly journalHead: WorkflowJournalHead;
}

interface DefaultTaskRuntimeGeneratedOutput {
	readonly kind: "default_prime_generated_task_output" | "default-prime-autoresearch-evidence";
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly workerId: string;
	readonly status: "completed";
	readonly output: Record<string, unknown>;
	readonly completedAt: string;
	readonly goalRevisionDigest: string;
	readonly graphDigest: string;
	readonly inputStateDigest: string;
	readonly launchEvidenceDigest: string;
	readonly capsuleDigest: string;
	readonly recipeCapability: "dynamic_task_graph" | "builtin_adaptive_prime";
	readonly taskGraphSourceDigest?: string;
	readonly logicalPath: string;
	readonly evidencePolicyId: string;
	readonly evidenceKind?: string;
	readonly evidencePolicy?: Record<string, unknown>;
	readonly requirementIds?: readonly unknown[];
	readonly completionCriteria?: readonly unknown[];
	readonly inputRefs?: readonly unknown[];
	readonly boundaryIds?: readonly unknown[];
	readonly outputRefs?: readonly unknown[];
	readonly budget?: Record<string, unknown>;
	readonly recoveryPolicy?: string;
	readonly authority?: readonly unknown[];
	readonly independent: boolean;
	readonly epochRef: WorkflowEpochRef;
	readonly journalHead: WorkflowJournalHead;
}

type DefaultTaskRuntimeTerminalArtifact = DefaultTaskRuntimeTerminalPacket | DefaultTaskRuntimeGeneratedOutput;

function isTerminalArtifactBoundToCapsule(
	artifact: DefaultTaskRuntimeTerminalArtifact,
	capsule: DefaultPrimeWorkerTaskCapsule | null,
	launchReceipt: DefaultTaskRuntimeLaunchReceipt,
	task: WorkflowTask | undefined,
): boolean {
	if (!isDefaultTaskRuntimeGeneratedOutput(artifact)) {
		if (capsule !== null) return true;
		return (
			task !== undefined &&
			launchReceipt.taskCapsuleDigest === null &&
			launchReceipt.taskCapsuleReceiptDigest === null
		);
	}
	if (capsule === null) {
		return (
			task !== undefined &&
			artifact.recipeCapability === "dynamic_task_graph" &&
			artifact.capsuleDigest === launchReceipt.taskCapsuleDigest &&
			artifact.taskGraphSourceDigest === task.taskGraphSourceDigest &&
			artifact.evidenceKind === task.evidenceKind &&
			digestObject(artifact.evidencePolicy) === digestObject(task.evidencePolicy) &&
			digestObject(artifact.requirementIds) === digestObject(task.requirementIds) &&
			digestObject(artifact.completionCriteria) === digestObject(task.completionCriteria) &&
			digestObject(artifact.inputRefs) === digestObject(task.inputRefs) &&
			digestObject(artifact.boundaryIds) === digestObject(task.boundaryIds) &&
			digestObject(artifact.outputRefs) === digestObject(task.outputRefs) &&
			digestObject(artifact.budget) === digestObject(task.budget) &&
			artifact.recoveryPolicy === task.recoveryPolicy &&
			digestObject(artifact.authority) === digestObject(task.authority)
		);
	}
	if (artifact.capsuleDigest !== capsule.capsuleDigest) return false;
	if (artifact.recipeCapability !== capsule.recipeCapability) return false;
	if (artifact.kind === "default_prime_generated_task_output") {
		return (
			capsule.recipeCapability === "dynamic_task_graph" &&
			artifact.taskGraphSourceDigest === capsule.taskGraphSourceDigest &&
			artifact.evidenceKind === capsule.evidenceKind &&
			digestObject(artifact.evidencePolicy) === digestObject(capsule.evidencePolicy) &&
			digestObject(artifact.requirementIds) === digestObject(capsule.requirementIds) &&
			digestObject(artifact.completionCriteria) === digestObject(capsule.completionCriteria) &&
			digestObject(artifact.inputRefs) === digestObject(capsule.inputRefs) &&
			digestObject(artifact.boundaryIds) === digestObject(capsule.boundaryIds) &&
			digestObject(artifact.outputRefs) === digestObject(capsule.outputRefs) &&
			digestObject(artifact.budget) === digestObject(capsule.budget) &&
			artifact.recoveryPolicy === capsule.recoveryPolicy &&
			digestObject(artifact.authority) === digestObject(capsule.authority)
		);
	}
	return capsule.recipeCapability === "builtin_adaptive_prime";
}

interface DefaultTaskRuntimeLaunchReceipt {
	readonly kind: "default_prime_worker_launch_receipt";
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly workerId: string;
	readonly taskCapsuleDigest: string | null;
	readonly taskCapsuleReceiptDigest: string | null;
	readonly epochRef: WorkflowEpochRef;
	readonly journalHead: WorkflowJournalHead;
}

interface DefaultTaskRuntimePendingCompletion {
	readonly attemptId: string;
	readonly completion: DefaultPrimeWorkerCompletion;
	readonly completedAt: string;
}

export interface DefaultTaskRuntimeAuthorityInput {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly decisionRef: WorkflowDecisionRef;
	readonly goalRevisionDigest: string;
	readonly graph: WorkflowTaskGraph;
	readonly maxWorkers: number;
	readonly now: () => string;
	readonly progressLeaseDurationMs?: number;
	readonly withHostLeaseOperation?: <T>(operation: () => Promise<T>) => Promise<T>;
	readonly scheduleProgressWake?: (
		obligation: DefaultTaskRuntimeProgressWakeObligation,
	) => Promise<"scheduled" | "already_scheduled">;
	readonly readWorkflowStatus?: () => Pick<WorkflowShellStatus, "status" | "blocked">;
	readonly beforeTaskLaunch?: (taskId: string) => Promise<void>;
	readonly workerLauncher?: DefaultPrimeWorkerLauncher;
	readonly createTaskCapsule?: DefaultPrimeTaskCapsuleFactory;
	readonly workerFailureDelivery?: (notice: DefaultPrimeWorkerFailureNotice) => Promise<void> | void;
	readonly blockWorkflow?: (blocker: WorkflowExternalBlockerInput) => Promise<void>;
	readonly prime: WorkflowPrimeStageEvidenceAdapter;
}

export interface DefaultTaskRuntimeProgressWakeObligation {
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseId: string;
	readonly wakeObligationId: string;
	readonly predicateDigest: string;
	readonly recoveryAttempt: number;
	readonly reason: "progress_lease_deadline_unchanged" | "retryable_task_result";
	readonly readyTaskIds: readonly string[];
}

function stateDigest(state: Omit<DefaultTaskRuntimeState, "stateDigest">): string {
	return digestObject(state);
}

function initialState(input: DefaultTaskRuntimeAuthorityInput): DefaultTaskRuntimeState {
	const unsigned = {
		version: 1 as const,
		workflowId: input.workflowId,
		epochRef: input.epochRef,
		graphDigest: input.graph.graphDigest,
		launches: [],
		pendingCompletions: [],
		terminalTaskIds: [],
		latestTelemetry: null,
		progressRecoveryWake: null,
	};
	return { ...unsigned, stateDigest: stateDigest(unsigned) };
}

function evolveState(
	state: DefaultTaskRuntimeState,
	updates: Partial<Omit<DefaultTaskRuntimeState, "stateDigest">>,
): DefaultTaskRuntimeState {
	const { stateDigest: _priorDigest, ...current } = state;
	const unsigned = { ...current, ...updates };
	return { ...unsigned, stateDigest: stateDigest(unsigned) };
}

function isPendingCompletion(value: unknown): value is DefaultTaskRuntimePendingCompletion {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const pending = value as {
		readonly attemptId?: unknown;
		readonly completedAt?: unknown;
		readonly completion?: unknown;
	};
	if (typeof pending.attemptId !== "string" || typeof pending.completedAt !== "string") return false;
	if (typeof pending.completion !== "object" || pending.completion === null || Array.isArray(pending.completion))
		return false;
	const completion = pending.completion as {
		readonly kind?: unknown;
		readonly status?: unknown;
		readonly output?: unknown;
		readonly error?: unknown;
		readonly retryable?: unknown;
		readonly binding?: unknown;
	};
	if (
		completion.kind !== "worker" ||
		!(["completed", "error", "cancelled"] as const).includes(
			completion.status as "completed" | "error" | "cancelled",
		) ||
		typeof completion.output !== "string" ||
		(typeof completion.error !== "string" && completion.error !== null) ||
		typeof completion.retryable !== "boolean" ||
		typeof completion.binding !== "object" ||
		completion.binding === null ||
		Array.isArray(completion.binding)
	)
		return false;
	const binding = completion.binding as {
		readonly workflowId?: unknown;
		readonly taskId?: unknown;
		readonly attemptId?: unknown;
		readonly executionKey?: unknown;
	};
	return (
		typeof binding.workflowId === "string" &&
		typeof binding.taskId === "string" &&
		typeof binding.attemptId === "string" &&
		typeof binding.executionKey === "string"
	);
}

function parseState(value: unknown, input: DefaultTaskRuntimeAuthorityInput): DefaultTaskRuntimeState {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("default_prime_task_runtime_state_invalid");
	const state = value as DefaultTaskRuntimeState & {
		readonly pendingCompletions?: unknown;
		readonly progressRecoveryWake?: unknown;
	};
	const pendingCompletions = state.pendingCompletions === undefined ? [] : state.pendingCompletions;
	if (!Array.isArray(pendingCompletions) || pendingCompletions.some((pending) => !isPendingCompletion(pending)))
		throw new Error("default_prime_task_runtime_state_invalid");
	const progressRecoveryWake = state.progressRecoveryWake === undefined ? null : state.progressRecoveryWake;
	if (
		progressRecoveryWake !== null &&
		(typeof progressRecoveryWake !== "object" ||
			Array.isArray(progressRecoveryWake) ||
			typeof (progressRecoveryWake as { readonly leaseId?: unknown }).leaseId !== "string" ||
			typeof (progressRecoveryWake as { readonly wakeObligationId?: unknown }).wakeObligationId !== "string" ||
			typeof (progressRecoveryWake as { readonly predicateDigest?: unknown }).predicateDigest !== "string" ||
			typeof (progressRecoveryWake as { readonly recoveryAttempt?: unknown }).recoveryAttempt !== "number" ||
			!Array.isArray((progressRecoveryWake as { readonly readyTaskIds?: unknown }).readyTaskIds) ||
			(progressRecoveryWake as { readonly readyTaskIds: readonly unknown[] }).readyTaskIds.some(
				(taskId) => typeof taskId !== "string",
			) ||
			typeof (progressRecoveryWake as { readonly recoveryStartedAt?: unknown }).recoveryStartedAt !== "string" ||
			typeof (progressRecoveryWake as { readonly deadlineAt?: unknown }).deadlineAt !== "string" ||
			!(["pending", "admitted", "blocked"] as const).includes(
				(progressRecoveryWake as { readonly status?: unknown }).status as "pending" | "admitted" | "blocked",
			))
	)
		throw new Error("default_prime_task_runtime_state_invalid");
	const {
		stateDigest: persistedDigest,
		pendingCompletions: _persistedPendingCompletions,
		progressRecoveryWake: _persistedWake,
		...unsignedWithoutOptionalFields
	} = state;
	const unsigned = { ...unsignedWithoutOptionalFields, pendingCompletions, progressRecoveryWake };
	const legacyDigests = [
		digestObject(unsignedWithoutOptionalFields),
		digestObject({ ...unsignedWithoutOptionalFields, progressRecoveryWake }),
		digestObject({ ...unsignedWithoutOptionalFields, pendingCompletions }),
	];
	if (
		state.version !== 1 ||
		state.workflowId !== input.workflowId ||
		state.graphDigest !== input.graph.graphDigest ||
		state.epochRef?.storeEpoch !== input.epochRef.storeEpoch ||
		state.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
		!Array.isArray(state.launches) ||
		!Array.isArray(state.terminalTaskIds) ||
		(persistedDigest !== stateDigest(unsigned) && !legacyDigests.includes(persistedDigest))
	)
		throw new Error("default_prime_task_runtime_state_invalid");
	return structuredClone({ ...state, pendingCompletions, progressRecoveryWake }) as DefaultTaskRuntimeState;
}

function classification(): WorkflowTaskRuntimeEvidenceClassification {
	return {
		boundary: "public_boundary",
		verification: "host_verified",
		evidenceKind: "durable_store",
		authorizesTerminalization: true,
	};
}

function assertClassification(value: WorkflowTaskRuntimeEvidenceClassification): void {
	if (digestObject(value) !== digestObject(classification()))
		throw new Error("workflow_task_runtime_stage_evidence_not_authorizing");
}

/** Compose the default task lifecycle directly over the canonical workflow runtime store. */
/**
 * The effect broker this host does not wire.
 *
 * `effect-broker.ts` implements real command execution, but nothing in production constructs it -
 * only tests do - so the live authority has always passed an empty object cast to the broker type.
 * Cast-to-type means the first call fails as "x is not a function", at whatever point in a long run
 * happens to reach it. This answers `readiness` truthfully instead, so a caller that asks can route
 * around it, and names the missing wiring when something tries to execute anyway.
 *
 * Consequence worth stating plainly: with no host executor, anything the host would need to measure
 * for itself has to be produced by a worker, which is the party a measurement is meant to check.
 *
 * ponytail: `dispatcher` and `leases` are stubbed the same way and left alone - prime runs its own
 * scheduler and never calls them, and hand-writing 13 throwing members would add noise, not safety.
 */
export function unwiredEffectBroker(): WorkflowEffectBroker {
	const unwired = (): never => {
		throw new Error("workflow_effect_broker_not_wired: this host constructs no effect executors");
	};
	return Object.freeze({
		classify: unwired,
		execute: unwired,
		reconcile: unwired,
		readiness: () => ({ canExecute: false, blockingReasons: ["workflow_effect_broker_not_wired"] as const }),
	}) as WorkflowEffectBroker;
}

export function createDefaultTaskRuntimeAuthority(
	input: DefaultTaskRuntimeAuthorityInput,
): WorkflowTaskRuntimeAuthority {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("default_prime_task_runtime_durable_store_required");
	if (input.runtimeStore.identity.workflowId !== input.workflowId)
		throw new Error("default_prime_task_runtime_store_binding_invalid");
	// Store epoch is the durable anchor and must match: a rotated store is a different history.
	// Coordinator epoch is excluded — it rotates on every resume as live-coordinator fencing, so
	// requiring it would mean a decision recorded before a restart could never be acted on, which
	// is exactly what an approved-then-resumed workflow needs to do.
	if (
		input.decisionRef.decisionScope.kind !== "workflow" ||
		input.decisionRef.decisionScope.workflowId !== input.workflowId ||
		input.decisionRef.decisionScope.rootSessionId !== input.rootSessionId ||
		input.decisionRef.storeEpoch !== input.epochRef.storeEpoch
	)
		throw new Error("default_prime_task_runtime_decision_binding_invalid");
	if (!/^[0-9a-f]{64}$/u.test(input.goalRevisionDigest))
		throw new Error("default_prime_task_runtime_goal_revision_invalid");
	if (
		durable.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
		durable.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch
	)
		throw new Error("default_prime_task_runtime_epoch_binding_invalid");
	if (!Number.isSafeInteger(input.maxWorkers) || input.maxWorkers < 1)
		throw new Error("default_prime_task_runtime_capacity_invalid");
	const progressLeaseDurationMs = input.progressLeaseDurationMs ?? DEFAULT_PROGRESS_LEASE_DURATION_MS;
	if (!Number.isSafeInteger(progressLeaseDurationMs) || progressLeaseDurationMs < 1)
		throw new Error("default_prime_task_runtime_progress_lease_duration_invalid");
	let progressLeaseTimer: ReturnType<typeof setTimeout> | null = null;
	let progressRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
	const taskLeaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let scheduleProgressLeaseDeadline: (lease: WorkflowProgressLease) => void = () => undefined;
	let scheduleProgressRecoveryDeadline: (wake: DefaultTaskRuntimeProgressRecoveryWake) => void = () => undefined;
	let scheduleTaskLeaseDeadline: (attemptId: string, expiresAt: string) => void = () => undefined;
	const withHostLeaseOperation =
		input.withHostLeaseOperation ?? (async <T>(operation: () => Promise<T>) => operation());

	const reconstructStateFromJournal = async (
		baseState: DefaultTaskRuntimeState = initialState(input),
	): Promise<DefaultTaskRuntimeState> => {
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("default_prime_task_runtime_w0_authority_missing");
		const taskIds = new Set(input.graph.tasks.map((task) => task.taskId));
		const launchesByAttempt = new Map(baseState.launches.map((launch) => [launch.attemptId, launch]));
		const dispatchByAttempt = new Map<string, DefaultTaskRuntimeDispatchEvent>();
		const terminalTaskIds = new Set(baseState.terminalTaskIds);
		// A persisted dispatch is adopted on recovery, so its bindings have to be re-derived here rather
		// than trusted. Without this any journalled workflow_dispatch_intent for a known task became an
		// active attempt: a dispatch from a foreign store epoch, from a coordinator epoch that has not
		// happened yet, or carrying a forged execution key or decision digest would all be picked up and
		// treated as in flight. The store epoch is the durable anchor and must match exactly; the
		// coordinator epoch rotates on every resume, so an earlier one is ordinary recovery while a later
		// one cannot exist yet.
		const dispatchBindingVerifies = (dispatch: DefaultTaskRuntimeDispatchEvent): boolean => {
			if (dispatch.epochRef.storeEpoch !== input.epochRef.storeEpoch) return false;
			if (dispatch.epochRef.coordinatorEpoch > input.epochRef.coordinatorEpoch) return false;
			const canonicalExecutionKey = digestObject({
				kind: "default-prime-task-attempt",
				workflowId: input.workflowId,
				taskId: dispatch.taskId,
				attemptId: dispatch.attemptId,
				epochRef: dispatch.epochRef,
			});
			if (dispatch.executionKey !== canonicalExecutionKey) return false;
			if (
				dispatch.decisionRef.decisionScope.kind !== "workflow" ||
				dispatch.decisionRef.decisionScope.workflowId !== input.workflowId ||
				dispatch.decisionRef.storeEpoch !== input.epochRef.storeEpoch
			)
				return false;
			// A digest can only be checked against one this authority can reproduce, which is its own.
			// A dispatch from an earlier coordinator epoch carries that epoch's decision and is ordinary
			// recovery, so it keeps the structural checks above and no more.
			if (dispatch.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch) return true;
			return dispatch.decisionRef.decisionDigest === input.decisionRef.decisionDigest;
		};
		for (const event of replay.events) {
			if (event.payload.kind === "workflow_dispatch_intent" && taskIds.has(event.payload.taskId)) {
				if (!dispatchBindingVerifies(event.payload)) continue;
				dispatchByAttempt.set(event.payload.attemptId, event.payload);
				if (!launchesByAttempt.has(event.payload.attemptId))
					launchesByAttempt.set(event.payload.attemptId, {
						taskId: event.payload.taskId,
						attemptId: event.payload.attemptId,
						executionKey: event.payload.executionKey,
						workerId: null,
						status: "ambiguous",
						launchEvidenceRef: null,
						taskCapsule: null,
						evidenceRefs: [],
						result: null,
					});
				continue;
			}
			if (event.payload.kind !== "workflow_child_outcome_committed") continue;
			const launch = launchesByAttempt.get(event.payload.attemptId);
			if (launch === undefined || launch.executionKey !== event.payload.executionKey) continue;
			const outcome = event.payload.outcome.outcome;
			const terminalStatus =
				outcome.status === "complete"
					? ("completed" as const)
					: outcome.status === "failed"
						? ("error" as const)
						: outcome.status === "blocked"
							? ("ambiguous" as const)
							: ("ambiguous" as const);
			const evidenceRefs = "evidenceRefs" in outcome ? outcome.evidenceRefs : [];
			const launchEvidenceRef = launch.launchEvidenceRef ?? evidenceRefs[0] ?? null;
			const result =
				outcome.status === "failed" &&
				outcome.completedAt !== undefined &&
				outcome.workerId !== undefined &&
				outcome.resultEvidenceRef !== undefined
					? {
							workflowId: input.workflowId,
							taskId: launch.taskId,
							attemptId: launch.attemptId,
							executionKey: launch.executionKey,
							workerId: outcome.workerId,
							status:
								event.payload.outcome.attemptStatus === "cancelled"
									? ("cancelled" as const)
									: ("error" as const),
							error: outcome.errorCode,
							retryable: outcome.retryable,
							recoveryDecision: "replan_required" as const,
							completedAt: outcome.completedAt,
							resultEvidenceRef: outcome.resultEvidenceRef,
						}
					: launch.result;
			launchesByAttempt.set(event.payload.attemptId, {
				...launch,
				status: terminalStatus,
				workerId: launch.workerId ?? (outcome.status === "failed" ? (outcome.workerId ?? null) : null),
				launchEvidenceRef,
				evidenceRefs,
				result,
			});
			if (terminalStatus === "completed") terminalTaskIds.add(launch.taskId);
		}
		const ambiguousLaunches = [...launchesByAttempt.values()].filter(
			(launch) => launch.status === "ambiguous" && launch.result === null,
		);
		if (ambiguousLaunches.length > 0) {
			const artifacts = await readDefaultTaskRuntimeEvidenceArtifacts(input.runtimeStore);
			const isBoundToDispatch = (
				ref: WorkflowArtifactRef,
				journalHead: WorkflowJournalHead,
				dispatch: DefaultTaskRuntimeDispatchEvent,
			): boolean => {
				const source = replay.events.find((event) => event.sequence === ref.sourceEventSequence);
				return (
					source !== undefined &&
					source.workflowId === input.workflowId &&
					digestObject(source.epochRef) === digestObject(dispatch.epochRef) &&
					journalHead.workflowId === input.workflowId &&
					journalHead.sequence === ref.sourceEventSequence &&
					journalHead.eventDigest === source.eventDigest &&
					digestObject(journalHead.epochRef) === digestObject(dispatch.epochRef)
				);
			};
			const isArtifactSourceBoundToDispatch = (
				ref: WorkflowArtifactRef,
				dispatch: DefaultTaskRuntimeDispatchEvent,
			): boolean => {
				const source = replay.events.find((event) => event.sequence === ref.sourceEventSequence);
				return (
					source !== undefined &&
					source.workflowId === input.workflowId &&
					digestObject(source.epochRef) === digestObject(dispatch.epochRef)
				);
			};
			for (const launch of ambiguousLaunches) {
				const dispatch = dispatchByAttempt.get(launch.attemptId);
				if (dispatch === undefined || dispatch.executionKey !== launch.executionKey) continue;
				const launchReceipts = artifacts.filter((artifact) => {
					const receipt = artifact.payload;
					return (
						isDefaultTaskRuntimeLaunchReceipt(receipt) &&
						receipt.workflowId === input.workflowId &&
						receipt.taskId === launch.taskId &&
						receipt.attemptId === launch.attemptId &&
						receipt.executionKey === launch.executionKey &&
						digestObject(receipt.epochRef) === digestObject(dispatch.epochRef) &&
						isArtifactSourceBoundToDispatch(artifact.ref, dispatch)
					);
				});
				const terminalPackets = artifacts.filter((artifact) => {
					const packet = artifact.payload;
					return (
						(isDefaultTaskRuntimeTerminalPacket(packet) || isDefaultTaskRuntimeGeneratedOutput(packet)) &&
						packet.workflowId === input.workflowId &&
						packet.taskId === launch.taskId &&
						packet.attemptId === launch.attemptId &&
						packet.executionKey === launch.executionKey &&
						packet.goalRevisionDigest === input.goalRevisionDigest &&
						packet.graphDigest === input.graph.graphDigest &&
						packet.inputStateDigest ===
							digestObject({
								workflowId: input.workflowId,
								taskId: launch.taskId,
								attemptId: launch.attemptId,
								graphDigest: input.graph.graphDigest,
							}) &&
						digestObject(packet.epochRef) === digestObject(dispatch.epochRef) &&
						isBoundToDispatch(artifact.ref, packet.journalHead, dispatch)
					);
				});
				if (launchReceipts.length !== 1 || terminalPackets.length !== 1) continue;
				const launchReceiptArtifact = launchReceipts[0];
				const terminalArtifact = terminalPackets[0];
				if (launchReceiptArtifact === undefined || terminalArtifact === undefined) continue;
				const launchReceipt = launchReceiptArtifact.payload;
				const terminalPacket = terminalArtifact.payload;
				if (
					!isDefaultTaskRuntimeLaunchReceipt(launchReceipt) ||
					(!isDefaultTaskRuntimeTerminalPacket(terminalPacket) &&
						!isDefaultTaskRuntimeGeneratedOutput(terminalPacket)) ||
					terminalPacket.workerId !== launchReceipt.workerId ||
					terminalPacket.launchEvidenceDigest !== launchReceiptArtifact.ref.digest ||
					!isTerminalArtifactBoundToCapsule(
						terminalPacket,
						launch.taskCapsule,
						launchReceipt,
						input.graph.byId.get(launch.taskId),
					)
				)
					continue;
				launchesByAttempt.set(launch.attemptId, {
					...launch,
					workerId: launchReceipt.workerId,
					status: "completed",
					launchEvidenceRef: launchReceiptArtifact.ref,
					evidenceRefs: [terminalArtifact.ref],
					result: {
						workflowId: input.workflowId,
						taskId: launch.taskId,
						attemptId: launch.attemptId,
						executionKey: launch.executionKey,
						workerId: terminalPacket.workerId,
						status: "completed",
						error: null,
						retryable: false,
						recoveryDecision: "awaiting_evidence",
						completedAt: terminalPacket.completedAt,
						resultEvidenceRef: terminalArtifact.ref,
					},
				});
			}
		}
		for (const [attemptId, launch] of launchesByAttempt) {
			if (launch.status !== "ambiguous" || launch.launchEvidenceRef !== null) continue;
			const resourceEvent = replay.events.find(
				(event) =>
					event.payload.kind === "workflow_resource_lease_acquired" && event.payload.lease.attemptId === attemptId,
			);
			if (resourceEvent?.payload.kind !== "workflow_resource_lease_acquired") continue;
			launchesByAttempt.set(attemptId, {
				...launch,
				workerId: `unresolved:${attemptId}`,
				launchEvidenceRef: resourceEvent.payload.lease.resourceAdmission.canonicalPoolLedgerRef,
			});
		}
		return evolveState(baseState, {
			launches: [...launchesByAttempt.values()],
			terminalTaskIds: [...terminalTaskIds],
		});
	};

	const readState = async (): Promise<DefaultTaskRuntimeState> => {
		let bytes: Uint8Array | null;
		try {
			bytes = await durable.auxiliaryStore.read(DEFAULT_TASK_RUNTIME_RECORD);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				(error.message !== "Workflow auxiliary record belongs to a different generation." &&
					error.message !== "Workflow auxiliary record belongs to a different epoch.")
			)
				throw error;
			bytes = null;
		}
		return reconstructStateFromJournal(
			bytes === null ? initialState(input) : parseState(parseCanonicalJsonBytes(bytes), input),
		);
	};
	const mutate = <T>(operation: (state: DefaultTaskRuntimeState) => Promise<[DefaultTaskRuntimeState, T]>) =>
		durable.withExclusiveLease("default-prime-task-runtime", async () => {
			const [next, result] = await operation(await readState());
			await durable.auxiliaryStore.write(DEFAULT_TASK_RUNTIME_RECORD, canonicalJsonBytes(next));
			return result;
		});

	const commitRuntimeEvent = async <TPayload extends WorkflowEventPayload>(
		payload: TPayload,
		idempotencyKey: string,
		executionKey: string,
		rebasePayload?: (head: WorkflowJournalHead) => TPayload,
	): Promise<TPayload> =>
		withHostLeaseOperation(async () => {
			for (let attempt = 1; attempt <= RUNTIME_EVENT_REBASE_LIMIT; attempt += 1) {
				const replay = await input.runtimeStore.replay({
					workflowId: input.workflowId,
					fromSequence: 0,
					expectedStoreEpoch: input.epochRef.storeEpoch,
				});
				if (replay.quarantined || replay.head.eventDigest === null)
					throw new Error("default_prime_task_runtime_w0_authority_missing");
				const leaseRef = durable.currentLeaseRef();
				const baselineDigest = digestObject(replay.head);
				const currentPayload = rebasePayload?.(replay.head) ?? payload;
				try {
					const result = await input.runtimeStore.commit({
						workflowId: input.workflowId,
						payload: currentPayload,
						expectedHead: replay.head,
						semanticBinding: {
							mutationId: idempotencyKey,
							baselineDigest,
							expectedGenerations: { workflow: input.epochRef.storeEpoch },
							ownerId: "workflow-runtime",
							phase: "executing",
							reducerDigest: digestObject(currentPayload),
							semanticHead: {
								workflowId: input.workflowId,
								sequence: replay.head.sequence,
								eventDigest: replay.head.eventDigest,
								stateDigest: baselineDigest,
								epochRef: input.epochRef,
								generation: input.epochRef.storeEpoch,
							},
							expectedHead: replay.head,
							idempotencyKey,
							executionKey,
							writerIdentity: leaseRef.writerIdentity,
							leaseRef,
							epochRef: input.epochRef,
						},
						epochRef: input.epochRef,
						leaseRef,
						idempotencyKey,
						writerIdentity: leaseRef.writerIdentity,
						executionKey,
					});
					return result.payload;
				} catch (error) {
					if (!isStaleRuntimeEventCommit(error) || attempt === RUNTIME_EVENT_REBASE_LIMIT) throw error;
				}
			}
			throw new Error("default_prime_task_runtime_rebase_exhausted");
		});

	const ensureProgressLease = async (readyTaskIds: readonly string[]): Promise<void> => {
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("default_prime_task_runtime_w0_authority_missing");
		const orderedReadyTaskIds = [...new Set(readyTaskIds)].sort();
		if (orderedReadyTaskIds.length === 0) throw new Error("default_prime_task_runtime_progress_ready_set_empty");
		const nextGate = orderedReadyTaskIds[0];
		if (nextGate === undefined) throw new Error("default_prime_task_runtime_progress_ready_set_empty");
		const acquiredAt = input.now();
		const predicateWithoutDigest = {
			schemaVersion: 1 as const,
			kind: "task_terminal" as const,
			taskIds: orderedReadyTaskIds,
			requiredOutcome: "accepted" as const,
			rejectedRenewalSignals: PROGRESS_REJECTED_RENEWAL_SIGNALS,
		};
		const predicate: WorkflowProgressPredicate = {
			...predicateWithoutDigest,
			predicateDigest: digestObject(predicateWithoutDigest),
		};
		const dispatchByAttempt = new Map<string, { readonly taskId: string; readonly executionKey: string }>();
		for (const event of replay.events) {
			if (event.payload.kind === "workflow_dispatch_intent")
				dispatchByAttempt.set(event.payload.attemptId, {
					taskId: event.payload.taskId,
					executionKey: event.payload.executionKey,
				});
		}
		const completedOutcomes = replay.events.flatMap((event) => {
			if (
				event.payload.kind !== "workflow_child_outcome_committed" ||
				event.payload.outcome.attemptStatus !== "completed" ||
				event.payload.outcome.outcome.status !== "complete"
			)
				return [];
			const dispatch = dispatchByAttempt.get(event.payload.attemptId);
			if (dispatch === undefined) return [];
			return [
				{
					eventSequence: event.sequence,
					eventDigest: event.eventDigest,
					attemptId: event.payload.attemptId,
					outcomeDigest: event.payload.outcomeDigest,
					taskId: dispatch.taskId,
					evidenceRefs: event.payload.outcome.outcome.evidenceRefs,
				},
			];
		});
		const terminalTaskIds = [...new Set(completedOutcomes.map((outcome) => outcome.taskId))].sort();
		const latestOutcome = completedOutcomes.at(-1) ?? null;
		const latestEvidenceRefs =
			latestOutcome === null
				? []
				: [...latestOutcome.evidenceRefs].sort((left, right) => left.digest.localeCompare(right.digest));
		const lastAuthenticatedOutcomeEvidenceRef = latestEvidenceRefs[0] ?? null;
		const sourceOutcome =
			latestOutcome === null
				? null
				: {
						eventSequence: latestOutcome.eventSequence,
						eventDigest: latestOutcome.eventDigest,
						attemptId: latestOutcome.attemptId,
						taskId: latestOutcome.taskId,
						outcomeDigest: latestOutcome.outcomeDigest,
						evidenceDigests: latestEvidenceRefs.map((ref) => ref.digest),
					};
		const terminalAttemptIds = new Set(completedOutcomes.map((outcome) => outcome.attemptId));
		const unresolvedGatingObligationDigests = [...dispatchByAttempt.entries()]
			.filter(([attemptId]) => !terminalAttemptIds.has(attemptId))
			.map(([attemptId, dispatch]) => digestObject({ attemptId, ...dispatch }))
			.sort();
		const completedEffectDigests = new Set(
			replay.events.flatMap((event) =>
				event.payload.kind === "workflow_effect_completed" || event.payload.kind === "workflow_effect_ambiguous"
					? [event.payload.effectDigest]
					: [],
			),
		);
		const unresolvedEffectDigests = replay.events
			.flatMap((event) =>
				event.payload.kind === "workflow_effect_intent" && !completedEffectDigests.has(event.payload.effectDigest)
					? [event.payload.effectDigest]
					: [],
			)
			.sort();
		const semanticProgressDigest = digestObject({
			goalRevisionDigest: input.goalRevisionDigest,
			boundaryRevisionDigest: input.graph.graphDigest,
			nextGate,
			readyTaskIds: orderedReadyTaskIds,
			terminalTaskIds,
			unresolvedGatingObligationDigests,
			unresolvedEffectDigests,
			lastAuthenticatedOutcomeEvidenceDigest: lastAuthenticatedOutcomeEvidenceRef?.digest ?? null,
		});
		const existing = [...replay.events]
			.reverse()
			.find((event) => event.payload.kind === "workflow_progress_lease_acquired");
		const existingLeaseId =
			existing?.payload.kind === "workflow_progress_lease_acquired" ? existing.payload.lease.leaseId : null;
		if (
			existing?.payload.kind === "workflow_progress_lease_acquired" &&
			existing.payload.cut.semanticProgressDigest === semanticProgressDigest &&
			existing.payload.lease.expectedTransitionPredicateDigest === predicate.predicateDigest &&
			!replay.events.some(
				(event) =>
					event.payload.kind === "workflow_progress_lease_closed" && event.payload.leaseId === existingLeaseId,
			)
		) {
			scheduleProgressLeaseDeadline(existing.payload.lease);
			return;
		}
		const cut: WorkflowAuthoritativeProgressCut = {
			schemaVersion: 1,
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			goalRevisionDigest: input.goalRevisionDigest,
			boundaryRevisionDigest: input.graph.graphDigest,
			journalHead: replay.head,
			nextGate,
			readyTaskIds: orderedReadyTaskIds,
			terminalTaskIds,
			readyTaskSetDigest: digestObject(orderedReadyTaskIds),
			unresolvedGatingObligationDigests,
			unresolvedEffectDigests,
			lastAuthenticatedOutcomeEvidenceRef,
			lastAuthoritativeProgressAt: acquiredAt,
			semanticProgressDigest,
		};
		const cutDigest = digestObject(cut);
		const deadline = new Date(Date.parse(acquiredAt) + progressLeaseDurationMs).toISOString();
		const leaseWithoutDigest = {
			schemaVersion: 1 as const,
			leaseId: `progress:${input.workflowId}:${predicate.predicateDigest}:${semanticProgressDigest}`,
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			baseJournalHead: replay.head,
			progressCutDigest: cutDigest,
			baseSemanticProgressDigest: semanticProgressDigest,
			expectedTransitionPredicate: predicate,
			expectedTransitionPredicateDigest: predicate.predicateDigest,
			adversarialReviewDigest: digestObject({
				schemaVersion: 1,
				predicateDigest: predicate.predicateDigest,
				rejectedRenewalSignals: PROGRESS_REJECTED_RENEWAL_SIGNALS,
				verdict: "accepted",
			}),
			owner: durable.currentLeaseRef().writerIdentity,
			acquiredAt,
			deadline,
			wakeObligationId: `progress-wake:${input.workflowId}:${predicate.predicateDigest}:${semanticProgressDigest}`,
			recoveryAttempt: 0,
		};
		const lease: WorkflowProgressLease = {
			...leaseWithoutDigest,
			leaseDigest: digestObject(leaseWithoutDigest),
		};
		await commitRuntimeEvent(
			{
				kind: "workflow_progress_lease_acquired",
				workflowId: input.workflowId,
				epochRef: input.epochRef,
				cut,
				cutDigest,
				lease,
				leaseDigest: lease.leaseDigest,
				sourceOutcome,
			},
			`default-prime-progress-lease:${lease.leaseId}`,
			`progress:${input.graph.graphDigest}`,
		);
		scheduleProgressLeaseDeadline(lease);
	};

	const evaluateProgressLease = async (lease: WorkflowProgressLease): Promise<void> => {
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined) throw new Error("default_prime_task_runtime_progress_replay_quarantined");
		const leaseClosed = replay.events.some(
			(event) => event.payload.kind === "workflow_progress_lease_closed" && event.payload.leaseId === lease.leaseId,
		);
		if (leaseClosed) {
			if (progressRecoveryTimer !== null) {
				clearTimeout(progressRecoveryTimer);
				progressRecoveryTimer = null;
			}
			return;
		}
		const recoveryEvent = [...replay.events]
			.reverse()
			.find(
				(event) =>
					event.payload.kind === "workflow_progress_recovery_started" && event.payload.leaseId === lease.leaseId,
			);
		if (recoveryEvent?.payload.kind === "workflow_progress_recovery_started") {
			const state = await readState();
			const existingWake = state.progressRecoveryWake;
			const wake =
				existingWake?.leaseId === lease.leaseId
					? existingWake
					: {
							leaseId: lease.leaseId,
							wakeObligationId: recoveryEvent.payload.wakeObligationId,
							predicateDigest: lease.expectedTransitionPredicateDigest,
							recoveryAttempt: recoveryEvent.payload.recoveryAttempt,
							readyTaskIds: lease.expectedTransitionPredicate.taskIds,
							recoveryStartedAt: recoveryEvent.payload.recoveryStartedAt,
							deadlineAt: new Date(
								Date.parse(recoveryEvent.payload.recoveryStartedAt) + PROGRESS_RECOVERY_DEADLINE_MILLISECONDS,
							).toISOString(),
							status: "pending" as const,
						};
			if (existingWake !== wake) {
				await mutate(async (current) => [evolveState(current, { progressRecoveryWake: wake }), undefined]);
			}
			scheduleProgressRecoveryDeadline(wake);
			return;
		}
		const taskAttemptIds = new Set(
			replay.events.flatMap((event) =>
				event.payload.kind === "workflow_dispatch_intent" &&
				lease.expectedTransitionPredicate.taskIds.includes(event.payload.taskId)
					? [event.payload.attemptId]
					: [],
			),
		);
		if (
			replay.events.some(
				(event) =>
					event.payload.kind === "workflow_child_outcome_committed" &&
					taskAttemptIds.has(event.payload.attemptId) &&
					event.payload.outcome.attemptStatus === "completed",
			)
		)
			return;
		const evaluatedAt = input.now();
		if (Date.parse(evaluatedAt) < Date.parse(lease.deadline)) {
			scheduleProgressLeaseDeadline(lease);
			return;
		}
		const recoveryAttempt = lease.recoveryAttempt + 1;
		const stallWithoutDigest = {
			schemaVersion: 1 as const,
			stallId: `stall:${lease.leaseId}:${recoveryAttempt}`,
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			leaseId: lease.leaseId,
			wakeObligationId: lease.wakeObligationId,
			observedHead: replay.head,
			baseSemanticProgressDigest: lease.baseSemanticProgressDigest,
			observedSemanticProgressDigest: lease.baseSemanticProgressDigest,
			readyTaskSetDigest: digestObject(lease.expectedTransitionPredicate.taskIds),
			stalledAt: evaluatedAt,
			reason: "progress_lease_deadline_unchanged" as const,
			recoveryAttempt,
		};
		const record = { ...stallWithoutDigest, stallDigest: digestObject(stallWithoutDigest) };
		await commitRuntimeEvent(
			{
				kind: "workflow_progress_stalled",
				workflowId: input.workflowId,
				epochRef: input.epochRef,
				record,
				recordDigest: record.stallDigest,
			},
			`default-prime-progress-stalled:${lease.leaseId}:${recoveryAttempt}`,
			`progress:${input.graph.graphDigest}`,
		);
		if (input.scheduleProgressWake === undefined)
			throw new Error("default_prime_task_runtime_progress_wake_scheduler_missing");
		await input.scheduleProgressWake({
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			leaseId: lease.leaseId,
			wakeObligationId: lease.wakeObligationId,
			predicateDigest: lease.expectedTransitionPredicateDigest,
			recoveryAttempt,
			reason: "progress_lease_deadline_unchanged",
			readyTaskIds: lease.expectedTransitionPredicate.taskIds,
		});
		const recoveryWithoutDigest = {
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			leaseId: lease.leaseId,
			wakeObligationId: lease.wakeObligationId,
			recoveryAttempt,
			recoveryStartedAt: evaluatedAt,
		};
		await commitRuntimeEvent(
			{
				kind: "workflow_progress_recovery_started",
				...recoveryWithoutDigest,
				recoveryDigest: digestObject(recoveryWithoutDigest),
			},
			`default-prime-progress-recovery:${lease.leaseId}:${recoveryAttempt}`,
			`progress:${input.graph.graphDigest}`,
		);
		const progressRecoveryWake: DefaultTaskRuntimeProgressRecoveryWake = {
			leaseId: lease.leaseId,
			wakeObligationId: lease.wakeObligationId,
			predicateDigest: lease.expectedTransitionPredicateDigest,
			recoveryAttempt,
			readyTaskIds: lease.expectedTransitionPredicate.taskIds,
			recoveryStartedAt: evaluatedAt,
			deadlineAt: new Date(Date.parse(evaluatedAt) + PROGRESS_RECOVERY_DEADLINE_MILLISECONDS).toISOString(),
			status: "pending",
		};
		await mutate(async (state) => [evolveState(state, { progressRecoveryWake }), undefined]);
		scheduleProgressRecoveryDeadline(progressRecoveryWake);
	};

	const evaluateScheduledProgressLease = async (lease: WorkflowProgressLease): Promise<void> => {
		try {
			await evaluateProgressLease(lease);
		} catch (error) {
			if (!isStaleRuntimeEventCommit(error) || input.blockWorkflow === undefined) return;
			try {
				await input.blockWorkflow({
					dependencyId: `progress:${lease.leaseId}`,
					conditionDigest: digestObject({
						workflowId: input.workflowId,
						leaseId: lease.leaseId,
						predicateDigest: lease.expectedTransitionPredicateDigest,
						baseSemanticProgressDigest: lease.baseSemanticProgressDigest,
					}),
					requiredChange: "progress_lease_reconciliation_required",
					owner: "workflow_host",
					resumeEventKind: "workflow_progress_reconciled",
					earliestRetryAt: null,
					evidenceRefs: [],
					recordedAt: input.now(),
				});
			} catch {
				if (progressLeaseTimer !== null) clearTimeout(progressLeaseTimer);
				progressLeaseTimer = setTimeout(
					() => {
						progressLeaseTimer = null;
						void evaluateScheduledProgressLease(lease);
					},
					Math.min(progressLeaseDurationMs, 1_000),
				);
				progressLeaseTimer.unref?.();
			}
		}
	};

	scheduleProgressLeaseDeadline = (lease) => {
		if (input.scheduleProgressWake === undefined) return;
		if (progressLeaseTimer !== null) clearTimeout(progressLeaseTimer);
		const delayMs = Math.max(0, Date.parse(lease.deadline) - Date.parse(input.now()));
		progressLeaseTimer = setTimeout(() => {
			progressLeaseTimer = null;
			void evaluateScheduledProgressLease(lease);
		}, delayMs);
		progressLeaseTimer.unref?.();
	};

	const recoverProgressLease = async (): Promise<void> => {
		if (input.scheduleProgressWake === undefined) return;
		const state = await readState();
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const leaseEvent = [...replay.events]
			.reverse()
			.find((event) => event.payload.kind === "workflow_progress_lease_acquired");
		if (leaseEvent?.payload.kind !== "workflow_progress_lease_acquired") return;
		const progressLeaseId = leaseEvent.payload.lease.leaseId;
		const recoveryEvent = [...replay.events]
			.reverse()
			.find(
				(event) =>
					event.payload.kind === "workflow_progress_recovery_started" && event.payload.leaseId === progressLeaseId,
			);
		if (recoveryEvent?.payload.kind === "workflow_progress_recovery_started") {
			const existingWake = state.progressRecoveryWake;
			const wake =
				existingWake?.leaseId === progressLeaseId
					? existingWake
					: {
							leaseId: progressLeaseId,
							wakeObligationId: recoveryEvent.payload.wakeObligationId,
							predicateDigest: leaseEvent.payload.lease.expectedTransitionPredicateDigest,
							recoveryAttempt: recoveryEvent.payload.recoveryAttempt,
							readyTaskIds: leaseEvent.payload.lease.expectedTransitionPredicate.taskIds,
							recoveryStartedAt: recoveryEvent.payload.recoveryStartedAt,
							deadlineAt: new Date(
								Date.parse(recoveryEvent.payload.recoveryStartedAt) + PROGRESS_RECOVERY_DEADLINE_MILLISECONDS,
							).toISOString(),
							status: "pending" as const,
						};
			if (existingWake !== wake)
				await mutate(async (current) => [evolveState(current, { progressRecoveryWake: wake }), undefined]);
			if (
				wake.status === "pending" &&
				(wake.wakeObligationId.startsWith("result-recovery-wake:") ||
					Date.parse(input.now()) >= Date.parse(wake.deadlineAt))
			)
				await recoverProgressWake(wake);
			else scheduleProgressRecoveryDeadline(wake);
			return;
		}
		await evaluateProgressLease(leaseEvent.payload.lease);
	};

	const acquireTaskResourceLease = async (
		taskId: string,
		attemptId: string,
		executionKey: string,
	): Promise<WorkflowResourceLease> => {
		const task = input.graph.byId.get(taskId);
		if (task === undefined) throw new Error("default_prime_task_runtime_task_missing");
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("default_prime_task_runtime_w0_authority_missing");
		const existing = replay.events.find(
			(event) =>
				event.payload.kind === "workflow_resource_lease_acquired" && event.payload.lease.attemptId === attemptId,
		);
		if (existing?.payload.kind === "workflow_resource_lease_acquired") return existing.payload.lease;
		const ledgerPayload = {
			kind: "default_prime_task_resource_ledger",
			workflowId: input.workflowId,
			taskId,
			attemptId,
			executionKey,
			epochRef: input.epochRef,
			resourceVector: task.declaredResourceVector,
			controlCapacity: task.declaredControlCapacity,
		};
		const ledger = await input.runtimeStore.publishArtifact({
			workflowId: input.workflowId,
			payloadKind: "evidence",
			bytes: canonicalJsonBytes(ledgerPayload),
			codec: "canonical_json",
			sourceEventSequence: replay.head.sequence,
			idempotencyKey: `default-prime-resource-ledger:${executionKey}`,
		});
		const zeroControlCapacity = {
			processSlots: 0,
			childSessionSlots: 0,
			modelCallSlots: 0,
			modelInputTokens: 0,
			modelOutputTokens: 0,
			verificationSlots: 0,
			redTeamSlots: 0,
			recoverySlots: 0,
		} as const;
		if (digestObject(task.declaredControlCapacity) !== digestObject(zeroControlCapacity))
			throw new Error("default_prime_task_runtime_worker_control_capacity_invalid");
		const grantWithoutDigest = {
			kind: "worker" as const,
			grantId: `grant:${attemptId}`,
			resourceVector: task.declaredResourceVector,
			controlCapacity: zeroControlCapacity,
			canonicalPoolLedgerRef: ledger.envelope.ref,
		};
		const capacityGrant = { ...grantWithoutDigest, grantDigest: digestObject(grantWithoutDigest) };
		const admissionWithoutDigest: Omit<WorkflowResourceAdmission, "admissionDigest"> = {
			capacityGrant,
			canonicalPoolLedgerRef: ledger.envelope.ref,
			controlCapacity: zeroControlCapacity,
			controlCapacityProjectionDigest: digestObject(zeroControlCapacity),
			declaredVector: task.declaredResourceVector,
			hostDerivedConservativeVector: task.declaredResourceVector,
			reservedVector: task.declaredResourceVector,
			declaredControlCapacity: zeroControlCapacity,
			hostDerivedControlCapacity: zeroControlCapacity,
			reservedControlCapacity: zeroControlCapacity,
			derivationPolicyDigest: digestObject({ enforcementClass: "host_bounded", controlPlane: false }),
			enforcementClass: "host_bounded",
			unknownPoolIds: [],
			canonicalLedgerRef: ledger.envelope.ref,
			canonicalLedgerDigest: ledger.envelope.ref.digest,
			admitted: true,
		};
		const resourceAdmission = {
			...admissionWithoutDigest,
			admissionDigest: digestObject(admissionWithoutDigest),
		};
		const acquiredAt = input.now();
		const rootLease = durable.currentLeaseRef();
		if (Date.parse(rootLease.expiresAt) <= Date.parse(acquiredAt))
			throw new Error("default_prime_task_runtime_root_lease_expired");
		const taskDeadline = new Date(Date.parse(acquiredAt) + progressLeaseDurationMs).toISOString();
		const expiresAt = new Date(Math.min(Date.parse(rootLease.expiresAt), Date.parse(taskDeadline))).toISOString();
		const lease: WorkflowResourceLease = {
			leaseId: `resource:${input.workflowId}:${attemptId}`,
			workflowId: input.workflowId,
			taskId,
			attemptId,
			holderIdentity: rootLease.writerIdentity,
			resourceAdmission,
			controlCapacity: zeroControlCapacity,
			workerCapacity: zeroControlCapacity,
			status: "active",
			storeEpoch: input.epochRef.storeEpoch,
			coordinatorEpoch: input.epochRef.coordinatorEpoch,
			acquisitionEventSequence: replay.head.sequence + 1,
			idempotencyKey: `resource:${attemptId}`,
			acquiredAt,
			expiresAt,
			releaseEventSequence: null,
		};
		const committed = await commitRuntimeEvent(
			{ kind: "workflow_resource_lease_acquired", workflowId: input.workflowId, lease, epochRef: input.epochRef },
			`default-prime-resource-lease:${executionKey}`,
			executionKey,
			(head) => ({
				kind: "workflow_resource_lease_acquired",
				workflowId: input.workflowId,
				lease: { ...lease, acquisitionEventSequence: head.sequence + 1 },
				epochRef: input.epochRef,
			}),
		);
		return committed.lease;
	};

	const commitDispatchIntent = async (
		taskId: string,
		attemptId: string,
		executionKey: string,
		resourceLease: WorkflowResourceLease,
	): Promise<void> => {
		const launchConfigDigest = digestObject({
			kind: "default_prime_worker_launch",
			workflowId: input.workflowId,
			taskId,
			attemptId,
			executionKey,
			epochRef: input.epochRef,
		});
		await commitRuntimeEvent(
			{
				kind: "workflow_dispatch_intent",
				workflowId: input.workflowId,
				taskId,
				attemptId,
				executionKey,
				admissionId: `admission:${executionKey}`,
				epochRef: input.epochRef,
				decisionRef: input.decisionRef,
				resourceLeaseRef: leaseRefOf(resourceLease),
				ownershipLeaseRef: null,
				childAuthority: {
					capabilities: ["read_only"],
					writeClass: "read_only",
					parentAttemptId: null,
					rootSpawned: true,
				},
				launchConfigDigest,
				expectedEffectDigest: digestObject({ kind: "default_prime_stage_effect", taskId, attemptId }),
			},
			`default-prime-dispatch-intent:${executionKey}`,
			executionKey,
		);
	};

	const releaseTaskResourceLease = async (
		attemptId: string,
		executionKey: string,
		terminalOutcomeDigest: string,
	): Promise<void> => {
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const resourceEvent = replay.events.find(
			(event) =>
				event.payload.kind === "workflow_resource_lease_acquired" && event.payload.lease.attemptId === attemptId,
		);
		if (resourceEvent?.payload.kind !== "workflow_resource_lease_acquired")
			throw new Error("default_prime_task_runtime_resource_lease_missing");
		const resourceLeaseRef = leaseRefOf(resourceEvent.payload.lease);
		const releaseEventSequence = replay.head.sequence + 1;
		const releaseEvidence = await input.runtimeStore.publishArtifact({
			workflowId: input.workflowId,
			payloadKind: "barrier",
			bytes: canonicalJsonBytes({
				workflowId: input.workflowId,
				attemptId,
				leaseRef: resourceLeaseRef,
				terminalOutcomeDigest,
				expectedReleaseSequence: releaseEventSequence,
			}),
			codec: "canonical_json",
			sourceEventSequence: replay.head.sequence,
			idempotencyKey: `default-prime-lease-release-evidence:${executionKey}`,
		});
		await commitRuntimeEvent(
			{
				kind: "workflow_lease_release_recorded",
				workflowId: input.workflowId,
				releaseRef: {
					leaseRef: resourceLeaseRef,
					attemptId,
					terminalOutcomeDigest,
					releaseEventSequence,
					releaseProof: releaseEvidence.envelope.ref.digest,
				},
				epochRef: input.epochRef,
				status: "released",
			},
			`default-prime-lease-release:${executionKey}`,
			executionKey,
		);
	};

	const commitAcceptedStageOutcome = async (stageId: string): Promise<void> => {
		const state = await readState();
		const launch = state.launches.find((candidate) => candidate.taskId === stageId);
		if (
			launch === undefined ||
			launch.launchEvidenceRef === null ||
			launch.result?.status !== "completed" ||
			launch.result.resultEvidenceRef.digest === launch.launchEvidenceRef.digest ||
			launch.evidenceRefs.length === 0
		)
			throw new Error("default_prime_task_runtime_stage_evidence_missing");
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (
			replay.events.some(
				(event) =>
					event.payload.kind === "workflow_child_outcome_committed" &&
					event.payload.attemptId === launch.attemptId &&
					event.payload.executionKey === launch.executionKey &&
					event.payload.outcome.outcome.status === "complete",
			)
		)
			return;
		const outcome: WorkflowPhaseOutcomeRecord = {
			outcome: {
				workflowId: input.workflowId,
				phaseAttemptId: launch.attemptId,
				epochRef: input.epochRef,
				invocationToken: launch.executionKey,
				inputStateDigest: digestObject({
					workflowId: input.workflowId,
					taskId: launch.taskId,
					attemptId: launch.attemptId,
					graphDigest: input.graph.graphDigest,
				}),
				status: "complete",
				outputStateDigest: digestObject({
					workflowId: input.workflowId,
					taskId: launch.taskId,
					evidenceRefs: launch.evidenceRefs,
				}),
				artifactRefs: [launch.result.resultEvidenceRef],
				evidenceRefs: launch.evidenceRefs,
			},
			attemptStatus: "completed",
		};
		const outcomeDigest = digestObject(outcome);
		await commitRuntimeEvent(
			{
				kind: "workflow_child_outcome_committed",
				workflowId: input.workflowId,
				attemptId: launch.attemptId,
				executionKey: launch.executionKey,
				outcome,
				outcomeDigest,
				epochRef: input.epochRef,
			},
			`default-prime-child-outcome:${launch.executionKey}`,
			launch.executionKey,
		);
		await releaseTaskResourceLease(launch.attemptId, launch.executionKey, outcomeDigest);
	};

	const commitCompletedTaskOutcome = async (launch: DefaultTaskRuntimeLaunch): Promise<void> => {
		if (launch.launchEvidenceRef === null) throw new Error("default_prime_task_runtime_launch_evidence_missing");
		if (
			launch.result?.status !== "completed" ||
			launch.result.resultEvidenceRef.digest === launch.launchEvidenceRef.digest
		)
			throw new Error("default_prime_task_runtime_result_evidence_missing");
		const resultEvidenceRef = launch.result.resultEvidenceRef;
		const outcome: WorkflowPhaseOutcomeRecord = {
			outcome: {
				workflowId: input.workflowId,
				phaseAttemptId: launch.attemptId,
				epochRef: input.epochRef,
				invocationToken: launch.executionKey,
				inputStateDigest: digestObject({
					workflowId: input.workflowId,
					taskId: launch.taskId,
					attemptId: launch.attemptId,
					graphDigest: input.graph.graphDigest,
				}),
				status: "complete",
				outputStateDigest: digestObject({
					workflowId: input.workflowId,
					taskId: launch.taskId,
					resultEvidenceDigest: resultEvidenceRef.digest,
				}),
				artifactRefs: [resultEvidenceRef],
				evidenceRefs: [resultEvidenceRef],
			},
			attemptStatus: "completed",
		};
		const outcomeDigest = digestObject(outcome);
		await commitRuntimeEvent(
			{
				kind: "workflow_child_outcome_committed",
				workflowId: input.workflowId,
				attemptId: launch.attemptId,
				executionKey: launch.executionKey,
				outcome,
				outcomeDigest,
				epochRef: input.epochRef,
			},
			`default-prime-child-outcome:${launch.executionKey}`,
			launch.executionKey,
		);
		await releaseTaskResourceLease(launch.attemptId, launch.executionKey, outcomeDigest);
	};

	const blockCompletedTaskReconciliation = async (launch: DefaultTaskRuntimeLaunch, error: unknown): Promise<void> => {
		if (!isStaleRuntimeEventCommit(error) || input.blockWorkflow === undefined) throw error;
		if (launch.result?.status !== "completed")
			throw new Error("default_prime_task_runtime_completed_reconciliation_result_missing");
		await input.blockWorkflow({
			dependencyId: `task:${launch.taskId}:terminal`,
			conditionDigest: digestObject({
				workflowId: input.workflowId,
				taskId: launch.taskId,
				attemptId: launch.attemptId,
				executionKey: launch.executionKey,
				resultEvidenceDigest: launch.result.resultEvidenceRef.digest,
			}),
			requiredChange: "task_terminal_reconciliation_required",
			owner: "workflow_host",
			resumeEventKind: "workflow_attempt_reconciled",
			earliestRetryAt: null,
			evidenceRefs: [launch.result.resultEvidenceRef],
			recordedAt: input.now(),
		});
	};

	const reconcileCompletedTask = async (launch: DefaultTaskRuntimeLaunch): Promise<void> => {
		await commitCompletedTaskOutcome(launch);
		await closeProgressLease(launch.taskId);
		await mutate(async (state) => {
			const terminalTaskIds = [...new Set([...state.terminalTaskIds, launch.taskId])];
			return [evolveState(state, { terminalTaskIds }), undefined];
		});
	};

	const recoverCompletedTasks = async (): Promise<boolean> => {
		const state = await readState();
		const pending = state.launches.filter(
			(launch) =>
				launch.status === "completed" &&
				launch.result?.status === "completed" &&
				!state.terminalTaskIds.includes(launch.taskId),
		);
		for (const launch of pending) {
			try {
				await reconcileCompletedTask(launch);
			} catch (error) {
				await blockCompletedTaskReconciliation(launch, error);
				return false;
			}
		}
		return true;
	};

	const recoverUnadmittedLaunches = async (): Promise<boolean> => {
		const state = await readState();
		const pending = state.launches.filter(
			(launch) =>
				launch.status === "launching" &&
				launch.workerId === null &&
				launch.launchEvidenceRef === null &&
				launch.result === null,
		);
		if (pending.length === 0) return true;
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		for (const launch of pending) {
			const dispatch = replay.events.find(
				(event) =>
					event.payload.kind === "workflow_dispatch_intent" &&
					event.payload.attemptId === launch.attemptId &&
					event.payload.executionKey === launch.executionKey,
			);
			const resource = replay.events.find(
				(event) =>
					event.payload.kind === "workflow_resource_lease_acquired" &&
					event.payload.lease.attemptId === launch.attemptId,
			);
			const resourceExpired =
				resource?.payload.kind === "workflow_resource_lease_acquired" &&
				Date.parse(input.now()) >= Date.parse(resource.payload.lease.expiresAt);
			if (dispatch === undefined && !resourceExpired) continue;
			if (input.blockWorkflow === undefined)
				throw new Error("default_prime_task_runtime_unadmitted_launch_reconciliation_required");
			const evidenceRefs =
				resource?.payload.kind === "workflow_resource_lease_acquired"
					? [resource.payload.lease.resourceAdmission.canonicalPoolLedgerRef]
					: [];
			await input.blockWorkflow({
				dependencyId: `task:${launch.taskId}:launch`,
				conditionDigest: digestObject({
					workflowId: input.workflowId,
					taskId: launch.taskId,
					attemptId: launch.attemptId,
					executionKey: launch.executionKey,
					dispatchIntentPresent: dispatch !== undefined,
					resourceLeaseExpired: resourceExpired,
				}),
				requiredChange:
					dispatch === undefined ? "task_launch_lease_expired" : "task_launch_reconciliation_required",
				owner: "workflow_host",
				resumeEventKind: "workflow_attempt_reconciled",
				earliestRetryAt: null,
				evidenceRefs,
				recordedAt: input.now(),
			});
			return false;
		}
		const retryableAttempts = new Set(pending.map((launch) => launch.attemptId));
		await mutate(async (current) => {
			const launches = current.launches.filter(
				(launch) =>
					!retryableAttempts.has(launch.attemptId) ||
					launch.status !== "launching" ||
					launch.workerId !== null ||
					launch.launchEvidenceRef !== null ||
					launch.result !== null,
			);
			return [evolveState(current, { launches }), undefined];
		});
		return true;
	};

	const taskRetryAvailable = (state: DefaultTaskRuntimeState, taskId: string): boolean => {
		const attempts = state.launches.filter((launch) => launch.taskId === taskId);
		const latest = attempts.at(-1);
		const retryableResultError = latest?.result?.error;
		return (
			attempts.length <= TASK_RETRY_LIMIT &&
			latest !== undefined &&
			(latest.status === "error" || latest.status === "cancelled") &&
			latest.result?.retryable === true &&
			(retryableResultError === "task_deadline_expired" ||
				retryableResultError === "worker_output_contract_invalid" ||
				retryableResultError === "worker_result_missing") &&
			(input.scheduleProgressWake !== undefined || latest.result.error === "task_deadline_expired")
		);
	};

	const persistRetryableResultRecoveryWake = async (
		launch: DefaultTaskRuntimeLaunch,
	): Promise<DefaultTaskRuntimeProgressRecoveryWake> => {
		if (launch.result === null || !launch.result.retryable)
			throw new Error("default_prime_task_runtime_retryable_result_required");
		if (input.scheduleProgressWake === undefined)
			throw new Error("default_prime_task_runtime_progress_wake_scheduler_missing");
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		let lease: WorkflowProgressLease | null = null;
		for (const event of [...replay.events].reverse()) {
			if (event.payload.kind !== "workflow_progress_lease_acquired") continue;
			const candidateLease = event.payload.lease;
			if (!candidateLease.expectedTransitionPredicate.taskIds.includes(launch.taskId)) continue;
			const closed = replay.events.some(
				(candidate) =>
					candidate.payload.kind === "workflow_progress_lease_closed" &&
					candidate.payload.leaseId === candidateLease.leaseId,
			);
			if (closed) continue;
			lease = candidateLease;
			break;
		}
		if (lease === null) throw new Error("default_prime_task_runtime_progress_lease_missing");
		const wakeObligationId = `result-recovery-wake:${input.workflowId}:${launch.executionKey}`;
		const existingRecovery = replay.events.find(
			(event) =>
				event.payload.kind === "workflow_progress_recovery_started" &&
				event.payload.leaseId === lease.leaseId &&
				event.payload.wakeObligationId === wakeObligationId &&
				event.payload.recoveryStartedAt === launch.result?.completedAt,
		);
		const priorRecoveryAttempts = replay.events.flatMap((event) =>
			event.payload.kind === "workflow_progress_recovery_started" && event.payload.leaseId === lease.leaseId
				? [event.payload.recoveryAttempt]
				: [],
		);
		const recoveryAttempt =
			existingRecovery?.payload.kind === "workflow_progress_recovery_started"
				? existingRecovery.payload.recoveryAttempt
				: Math.max(lease.recoveryAttempt, ...priorRecoveryAttempts) + 1;
		if (existingRecovery === undefined) {
			const recoveryWithoutDigest = {
				workflowId: input.workflowId,
				epochRef: input.epochRef,
				leaseId: lease.leaseId,
				wakeObligationId,
				recoveryAttempt,
				recoveryStartedAt: launch.result.completedAt,
			};
			await commitRuntimeEvent(
				{
					kind: "workflow_progress_recovery_started",
					...recoveryWithoutDigest,
					recoveryDigest: digestObject(recoveryWithoutDigest),
				},
				`default-prime-result-recovery:${launch.executionKey}`,
				launch.executionKey,
			);
		}
		const wake: DefaultTaskRuntimeProgressRecoveryWake = {
			leaseId: lease.leaseId,
			wakeObligationId,
			predicateDigest: lease.expectedTransitionPredicateDigest,
			recoveryAttempt,
			readyTaskIds: lease.expectedTransitionPredicate.taskIds,
			recoveryStartedAt: launch.result.completedAt,
			deadlineAt: new Date(
				Date.parse(launch.result.completedAt) + PROGRESS_RECOVERY_DEADLINE_MILLISECONDS,
			).toISOString(),
			status: "pending",
		};
		await mutate(async (state) => {
			if (
				state.progressRecoveryWake?.wakeObligationId === wake.wakeObligationId &&
				state.progressRecoveryWake.status !== "pending"
			)
				return [state, undefined];
			return [evolveState(state, { progressRecoveryWake: wake }), undefined];
		});
		scheduleProgressRecoveryDeadline(wake);
		try {
			await input.scheduleProgressWake({
				workflowId: input.workflowId,
				epochRef: input.epochRef,
				leaseId: lease.leaseId,
				wakeObligationId,
				predicateDigest: lease.expectedTransitionPredicateDigest,
				recoveryAttempt,
				reason: "retryable_task_result",
				readyTaskIds: lease.expectedTransitionPredicate.taskIds,
			});
		} catch {
			// The authenticated recovery record and deadline timer retain ownership when the advisory wake fails.
		}
		return wake;
	};

	const blockWorkflowForFailedOutcome = async (
		launch: DefaultTaskRuntimeLaunch,
		outcomeDigest: string,
		errorCode: string,
		recordedAt: string,
		recoveredResultEvidenceRef?: WorkflowArtifactRef,
	): Promise<void> => {
		if (input.blockWorkflow === undefined) return;
		if (launch.launchEvidenceRef === null) throw new Error("default_prime_task_runtime_launch_evidence_missing");
		const resultEvidenceRef = recoveredResultEvidenceRef ?? launch.result?.resultEvidenceRef;
		if (resultEvidenceRef === undefined || resultEvidenceRef.digest === launch.launchEvidenceRef.digest)
			throw new Error("default_prime_task_runtime_result_evidence_missing");
		await input.blockWorkflow({
			dependencyId: `task:${launch.taskId}:terminal`,
			conditionDigest: digestObject({
				workflowId: input.workflowId,
				taskId: launch.taskId,
				attemptId: launch.attemptId,
				outcomeDigest,
			}),
			requiredChange: errorCode,
			owner: "workflow_host",
			resumeEventKind: "workflow_attempt_reconciled",
			earliestRetryAt: null,
			evidenceRefs: [resultEvidenceRef],
			recordedAt,
		});
	};

	const commitFailedStageOutcome = async (
		launch: DefaultTaskRuntimeLaunch,
		completion: DefaultTaskRuntimeCompletion,
		blockFailedWorkflow: boolean,
	): Promise<void> => {
		if (launch.launchEvidenceRef === null) throw new Error("default_prime_task_runtime_launch_evidence_missing");
		if (launch.result === null || launch.result.resultEvidenceRef.digest === launch.launchEvidenceRef.digest)
			throw new Error("default_prime_task_runtime_result_evidence_missing");
		const errorCode = completion.error ?? `worker_${completion.status}`;
		const outcome: WorkflowPhaseOutcomeRecord = {
			outcome: {
				workflowId: input.workflowId,
				phaseAttemptId: launch.attemptId,
				epochRef: input.epochRef,
				invocationToken: launch.executionKey,
				inputStateDigest: digestObject({
					workflowId: input.workflowId,
					taskId: launch.taskId,
					attemptId: launch.attemptId,
					graphDigest: input.graph.graphDigest,
				}),
				status: "failed",
				errorCode,
				retryable: completion.retryable,
				artifactRefs: [launch.result.resultEvidenceRef],
				evidenceRefs: [launch.launchEvidenceRef],
				completedAt: launch.result.completedAt,
				workerId: launch.result.workerId,
				resultEvidenceRef: launch.result.resultEvidenceRef,
			},
			attemptStatus: completion.status === "cancelled" ? "cancelled" : "failed",
		};
		const outcomeDigest = digestObject(outcome);
		await commitRuntimeEvent(
			{
				kind: "workflow_child_outcome_committed",
				workflowId: input.workflowId,
				attemptId: launch.attemptId,
				executionKey: launch.executionKey,
				outcome,
				outcomeDigest,
				epochRef: input.epochRef,
			},
			`default-prime-child-outcome:${launch.executionKey}`,
			launch.executionKey,
		);
		await releaseTaskResourceLease(launch.attemptId, launch.executionKey, outcomeDigest);
		if (blockFailedWorkflow) await blockWorkflowForFailedOutcome(launch, outcomeDigest, errorCode, input.now());
	};

	const recoverFailedWorkflowBlocker = async (): Promise<void> => {
		if (input.blockWorkflow === undefined) return;
		const state = await readState();
		const failed = [...state.launches]
			.reverse()
			.find((launch) => launch.status === "error" || launch.status === "cancelled");
		if (failed === undefined) return;
		if (state.terminalTaskIds.includes(failed.taskId)) return;
		if (
			state.launches.some(
				(launch) =>
					launch.taskId === failed.taskId &&
					(launch.status === "launching" || launch.status === "running" || launch.status === "ambiguous"),
			) ||
			taskRetryAvailable(state, failed.taskId)
		)
			return;
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const outcomeEvent = [...replay.events]
			.reverse()
			.find(
				(event) =>
					event.payload.kind === "workflow_child_outcome_committed" &&
					event.payload.attemptId === failed.attemptId &&
					event.payload.executionKey === failed.executionKey,
			);
		if (
			outcomeEvent?.payload.kind !== "workflow_child_outcome_committed" ||
			outcomeEvent.payload.outcome.outcome.status !== "failed"
		)
			throw new Error("default_prime_task_runtime_failed_outcome_missing");
		const resourceEvent = replay.events.find(
			(event) =>
				event.payload.kind === "workflow_resource_lease_acquired" &&
				event.payload.lease.attemptId === failed.attemptId,
		);
		if (resourceEvent?.payload.kind !== "workflow_resource_lease_acquired")
			throw new Error("default_prime_task_runtime_resource_lease_missing");
		await blockWorkflowForFailedOutcome(
			failed,
			outcomeEvent.payload.outcomeDigest,
			outcomeEvent.payload.outcome.outcome.errorCode,
			resourceEvent.payload.lease.acquiredAt,
			outcomeEvent.payload.outcome.outcome.artifactRefs[0],
		);
	};

	const closeProgressLease = async (stageId: string): Promise<void> => {
		const state = await readState();
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const leaseEvent = [...replay.events]
			.reverse()
			.find((event) => event.payload.kind === "workflow_progress_lease_acquired");
		if (leaseEvent?.payload.kind !== "workflow_progress_lease_acquired")
			throw new Error("default_prime_task_runtime_progress_lease_missing");
		const progressLease = leaseEvent.payload.lease;
		if (
			replay.events.some(
				(event) =>
					event.payload.kind === "workflow_progress_lease_closed" &&
					event.payload.leaseId === progressLease.leaseId,
			)
		)
			return;
		const acceptedLaunch = [...state.launches]
			.reverse()
			.find(
				(launch) => launch.taskId === stageId && launch.status === "completed" && launch.evidenceRefs.length > 0,
			);
		if (acceptedLaunch === undefined) throw new Error("default_prime_task_runtime_progress_dispatch_missing");
		const outcomeEvent = [...replay.events]
			.reverse()
			.find(
				(event) =>
					event.payload.kind === "workflow_child_outcome_committed" &&
					event.payload.attemptId === acceptedLaunch.attemptId &&
					event.payload.executionKey === acceptedLaunch.executionKey &&
					event.payload.outcome.attemptStatus === "completed" &&
					event.payload.outcome.outcome.status === "complete",
			);
		if (outcomeEvent?.payload.kind !== "workflow_child_outcome_committed")
			throw new Error("default_prime_task_runtime_progress_outcome_missing");
		const phaseOutcome = outcomeEvent.payload.outcome.outcome;
		if (phaseOutcome.status !== "complete")
			throw new Error("default_prime_task_runtime_progress_outcome_not_complete");
		const evidenceDigests = phaseOutcome.evidenceRefs.map((ref) => ref.digest).sort();
		if (evidenceDigests.length === 0) throw new Error("default_prime_task_runtime_progress_evidence_missing");
		const sourceOutcome = {
			eventSequence: outcomeEvent.sequence,
			eventDigest: outcomeEvent.eventDigest,
			attemptId: outcomeEvent.payload.attemptId,
			taskId: stageId,
			outcomeDigest: outcomeEvent.payload.outcomeDigest,
			evidenceDigests,
		};
		const closureWithoutDigest = {
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			leaseId: progressLease.leaseId,
			sourceOutcome,
			closedAt: input.now(),
			disposition: input.graph.tasks.some((task) => task.dependencyTaskIds.includes(stageId))
				? ("advanced" as const)
				: ("terminal" as const),
		};
		await commitRuntimeEvent(
			{
				kind: "workflow_progress_lease_closed",
				...closureWithoutDigest,
				closureDigest: digestObject(closureWithoutDigest),
			},
			`default-prime-progress-lease-close:${progressLease.leaseId}`,
			`progress:${input.graph.graphDigest}`,
		);
		if (progressLeaseTimer !== null) {
			clearTimeout(progressLeaseTimer);
			progressLeaseTimer = null;
		}
		await clearProgressRecoveryWake(progressLease.leaseId);
	};

	const publishLaunchEvidence = async (
		taskId: string,
		attemptId: string,
		executionKey: string,
		launch: DefaultPrimeWorkerLaunch,
		taskCapsule: DefaultPrimeWorkerTaskCapsule | null,
	): Promise<WorkflowArtifactRef> => {
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("default_prime_task_runtime_w0_authority_missing");
		const publication = await input.runtimeStore.publishArtifact({
			workflowId: input.workflowId,
			payloadKind: "evidence",
			bytes: canonicalJsonBytes({
				kind: "default_prime_worker_launch_receipt",
				workflowId: input.workflowId,
				taskId,
				attemptId,
				executionKey,
				workerId: launch.workerId,
				executionIdentity: launch.executionIdentity,
				processStartId: launch.processStartId,
				processGroupId: launch.processGroupId,
				launchedAt: launch.launchedAt,
				taskCapsuleDigest: taskCapsule?.capsuleDigest ?? null,
				taskCapsuleReceiptDigest: taskCapsule === null ? null : digestObject(taskCapsule.receipt),
				generatedOutputPath: taskCapsule?.outputContract.logicalPath ?? null,
				epochRef: input.epochRef,
			}),
			codec: "canonical_json",
			sourceEventSequence: replay.head.sequence,
			idempotencyKey: `default-prime-worker-launch:${executionKey}`,
		});
		return publication.envelope.ref;
	};

	const publishWorkerResultEvidence = async (
		launch: DefaultTaskRuntimeLaunch,
		completion: DefaultTaskRuntimeCompletion,
		completedAt: string,
	): Promise<WorkflowArtifactRef> => {
		if (launch.workerId === null || launch.launchEvidenceRef === null)
			throw new Error("default_prime_task_runtime_completion_without_launch");
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("default_prime_task_runtime_w0_authority_missing");
		const inputStateDigest = digestObject({
			workflowId: input.workflowId,
			taskId: launch.taskId,
			attemptId: launch.attemptId,
			graphDigest: input.graph.graphDigest,
		});
		let artifact: unknown;
		if (completion.status === "completed" && launch.taskCapsule !== null) {
			const parsedOutput = parseCanonicalJsonBytes(new TextEncoder().encode(completion.output));
			const recipeCapability = launch.taskCapsule.recipeCapability;
			if (recipeCapability === undefined) throw new Error("default_prime_task_runtime_recipe_capability_missing");
			const taskGraphSourceDigest = launch.taskCapsule.taskGraphSourceDigest;
			const evidenceKind = launch.taskCapsule.evidenceKind ?? launch.taskCapsule.outputContract.evidenceKind;
			if (
				recipeCapability === "dynamic_task_graph" &&
				(taskGraphSourceDigest === undefined ||
					evidenceKind === undefined ||
					launch.taskCapsule.evidencePolicy === undefined)
			)
				throw new Error("default_prime_task_runtime_dynamic_contract_missing");
			artifact = {
				schemaVersion: 1,
				kind:
					recipeCapability === "builtin_adaptive_prime"
						? "default-prime-autoresearch-evidence"
						: "default_prime_generated_task_output",
				workflowId: input.workflowId,
				taskId: launch.taskId,
				attemptId: launch.attemptId,
				executionKey: launch.executionKey,
				workerId: launch.workerId,
				status: completion.status,
				completedAt,
				goalRevisionDigest: input.goalRevisionDigest,
				inputStateDigest,
				goalBindingDigest: launch.taskCapsule.goalBindingDigest,
				graphDigest: input.graph.graphDigest,
				recipeDigest: launch.taskCapsule.recipeDigest,
				admissionDigest: launch.taskCapsule.admissionDigest,
				capsuleDigest: launch.taskCapsule.capsuleDigest,
				recipeCapability,
				...(taskGraphSourceDigest === undefined ? {} : { taskGraphSourceDigest }),
				...(launch.taskCapsule.requirementIds === undefined
					? {}
					: { requirementIds: launch.taskCapsule.requirementIds }),
				...(launch.taskCapsule.completionCriteria === undefined
					? {}
					: { completionCriteria: launch.taskCapsule.completionCriteria }),
				...(launch.taskCapsule.inputRefs === undefined ? {} : { inputRefs: launch.taskCapsule.inputRefs }),
				...(launch.taskCapsule.boundaryIds === undefined ? {} : { boundaryIds: launch.taskCapsule.boundaryIds }),
				...(launch.taskCapsule.outputRefs === undefined ? {} : { outputRefs: launch.taskCapsule.outputRefs }),
				...(launch.taskCapsule.evidencePolicy === undefined
					? {}
					: { evidencePolicy: launch.taskCapsule.evidencePolicy }),
				...(evidenceKind === undefined ? {} : { evidenceKind }),
				...(launch.taskCapsule.budget === undefined ? {} : { budget: launch.taskCapsule.budget }),
				...(launch.taskCapsule.recoveryPolicy === undefined
					? {}
					: { recoveryPolicy: launch.taskCapsule.recoveryPolicy }),
				authority: launch.taskCapsule.authority,
				logicalPath: launch.taskCapsule.outputContract.logicalPath,
				evidencePolicyId: launch.taskCapsule.outputContract.evidencePolicyId,
				independent: launch.taskCapsule.outputContract.independent,
				output: parsedOutput,
				launchEvidenceDigest: launch.launchEvidenceRef.digest,
				epochRef: input.epochRef,
				journalHead: replay.head,
			};
		} else {
			artifact = {
				kind: "default_prime_worker_terminal_packet",
				workflowId: input.workflowId,
				taskId: launch.taskId,
				attemptId: launch.attemptId,
				executionKey: launch.executionKey,
				workerId: launch.workerId,
				status: completion.status,
				output: completion.output,
				error: completion.error,
				retryable: completion.retryable,
				completedAt,
				goalRevisionDigest: input.goalRevisionDigest,
				inputStateDigest,
				graphDigest: input.graph.graphDigest,
				launchEvidenceDigest: launch.launchEvidenceRef.digest,
				epochRef: input.epochRef,
				journalHead: replay.head,
			};
		}
		for (let attempt = 1; attempt <= TERMINAL_RESULT_PUBLICATION_RETRY_LIMIT; attempt += 1) {
			try {
				const publication = await input.runtimeStore.publishArtifact({
					workflowId: input.workflowId,
					payloadKind: "evidence",
					bytes: canonicalJsonBytes(artifact),
					codec: "canonical_json",
					sourceEventSequence: replay.head.sequence,
					idempotencyKey: `default-prime-worker-terminal:${launch.executionKey}`,
				});
				if (publication.envelope.ref.digest === launch.launchEvidenceRef.digest)
					throw new Error("default_prime_task_runtime_result_evidence_conflicts_with_launch");
				return publication.envelope.ref;
			} catch (error) {
				if (!isAppendGuardTimeout(error) || attempt === TERMINAL_RESULT_PUBLICATION_RETRY_LIMIT) throw error;
				await new Promise<void>((resolve) =>
					setTimeout(resolve, TERMINAL_RESULT_PUBLICATION_RETRY_DELAY_MILLISECONDS),
				);
			}
		}
		throw new Error("default_prime_task_runtime_result_evidence_publication_exhausted");
	};

	const blockTerminalPublicationFailure = async (attemptId: string, error: unknown): Promise<void> => {
		const activeState = await readState();
		const launch = activeState.launches.find((candidate) => candidate.attemptId === attemptId);
		if (launch === undefined || input.blockWorkflow === undefined) return;
		const errorCode = error instanceof Error ? error.message : "unknown_terminal_publication_failure";
		await input.blockWorkflow({
			dependencyId: `task:${launch.taskId}:terminal`,
			conditionDigest: digestObject({
				workflowId: input.workflowId,
				taskId: launch.taskId,
				attemptId: launch.attemptId,
				executionKey: launch.executionKey,
				errorCode,
			}),
			requiredChange: isAppendGuardTimeout(error)
				? "task_terminal_result_publication_required"
				: "task_terminal_reconciliation_required",
			owner: "workflow_host",
			resumeEventKind: "workflow_attempt_reconciled",
			earliestRetryAt: null,
			evidenceRefs: launch.launchEvidenceRef === null ? [] : [launch.launchEvidenceRef],
			recordedAt: input.now(),
		});
	};

	const workerOutputContractError = (
		launch: DefaultTaskRuntimeLaunch,
		completion: DefaultTaskRuntimeCompletion,
	): string | null => {
		if (completion.status !== "completed" || launch.taskCapsule === null) return null;
		const bytes = new TextEncoder().encode(completion.output);
		if (bytes.byteLength < 1 || bytes.byteLength > launch.taskCapsule.outputContract.maxBytes)
			return "worker_output_contract_invalid";
		let parsed: unknown;
		try {
			parsed = parseCanonicalJsonBytes(bytes);
		} catch {
			return "worker_output_contract_invalid";
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return "worker_output_contract_invalid";
		const record = parsed as Record<string, unknown>;
		if (
			digestObject(Object.keys(record).sort()) !==
				digestObject(["findings", "kind", "schemaVersion", "summary", "taskId"]) ||
			record.schemaVersion !== 1 ||
			record.kind !== launch.taskCapsule.outputContract.schemaKind ||
			record.taskId !== launch.taskId ||
			typeof record.summary !== "string" ||
			record.summary.trim().length === 0 ||
			!Array.isArray(record.findings) ||
			record.findings.length < 1 ||
			record.findings.length > launch.taskCapsule.outputContract.maxItems ||
			record.findings.some((finding) => typeof finding !== "string" || finding.trim().length === 0) ||
			new TextDecoder().decode(canonicalJsonBytes(parsed)) !== completion.output
		)
			return "worker_output_contract_invalid";
		return null;
	};

	const completeLaunchWithinHostOperation = async (
		attemptId: string,
		completion: DefaultTaskRuntimeCompletion,
	): Promise<void> => {
		const activeState = await readState();
		const activeLaunch = activeState.launches.find((launch) => launch.attemptId === attemptId);
		if (
			activeLaunch === undefined ||
			activeLaunch.workerId === null ||
			activeLaunch.launchEvidenceRef === null ||
			(activeLaunch.status !== "launching" &&
				activeLaunch.status !== "running" &&
				activeLaunch.status !== "ambiguous")
		)
			return;
		if (completion.kind === "host") {
			if (
				completion.hostToken !== DEFAULT_PRIME_HOST_COMPLETION_TOKEN ||
				(completion.error !== "task_deadline_expired" && completion.error !== "task_resource_lease_expired")
			)
				return;
		} else {
			const binding = completion.binding;
			if (
				completion.kind !== "worker" ||
				binding === undefined ||
				binding.workflowId !== input.workflowId ||
				binding.taskId !== activeLaunch.taskId ||
				binding.attemptId !== activeLaunch.attemptId ||
				binding.executionKey !== activeLaunch.executionKey
			)
				return;
		}
		const outputContractError = workerOutputContractError(activeLaunch, completion);
		const effectiveCompletion: DefaultPrimeWorkerCompletion =
			completion.kind === "host"
				? {
						kind: "worker",
						binding: {
							workflowId: input.workflowId,
							taskId: activeLaunch.taskId,
							attemptId: activeLaunch.attemptId,
							executionKey: activeLaunch.executionKey,
						},
						status: "error",
						output: completion.output,
						error: completion.error,
						retryable: true,
					}
				: completion.error === "task_deadline_expired"
					? {
							kind: "worker",
							status: "error",
							output: completion.output,
							error: "task_deadline_expired",
							retryable: true,
							binding: completion.binding,
						}
					: completion.status === "completed" &&
							(completion.output.trim().length === 0 || outputContractError !== null)
						? {
								kind: "worker",
								binding: completion.binding,
								status: "error",
								output: completion.output,
								error: outputContractError ?? "worker_result_missing",
								retryable: true,
							}
						: completion;
		const pendingCompletion = await mutate<DefaultTaskRuntimePendingCompletion | null>(async (state) => {
			const current = state.launches.find((launch) => launch.attemptId === attemptId);
			if (
				current === undefined ||
				current.workerId === null ||
				current.launchEvidenceRef === null ||
				(current.status !== "launching" && current.status !== "running" && current.status !== "ambiguous")
			)
				return [state, null];
			const existing = state.pendingCompletions.find((pending) => pending.attemptId === attemptId);
			if (existing !== undefined) {
				return digestObject(existing.completion) === digestObject(effectiveCompletion)
					? [state, existing]
					: [state, null];
			}
			const pending: DefaultTaskRuntimePendingCompletion = {
				attemptId,
				completion: effectiveCompletion,
				completedAt: input.now(),
			};
			return [evolveState(state, { pendingCompletions: [...state.pendingCompletions, pending] }), pending];
		});
		if (pendingCompletion === null) return;
		const resultEvidenceRef = await publishWorkerResultEvidence(
			activeLaunch,
			pendingCompletion.completion,
			pendingCompletion.completedAt,
		);
		const terminalLaunch = await mutate<DefaultTaskRuntimeLaunch | null>(async (state) => {
			const current = state.launches.find((launch) => launch.attemptId === attemptId);
			if (current === undefined || current.workerId === null || current.launchEvidenceRef === null)
				throw new Error("default_prime_task_runtime_completion_without_launch");
			const pendingCompletions = state.pendingCompletions.filter((pending) => pending.attemptId !== attemptId);
			if (current.status !== "launching" && current.status !== "running" && current.status !== "ambiguous")
				return [evolveState(state, { pendingCompletions }), null];
			const status = effectiveCompletion.status === "completed" ? "completed" : effectiveCompletion.status;
			const result: WorkflowTaskRuntimeWorkerResult = {
				workflowId: input.workflowId,
				taskId: current.taskId,
				attemptId,
				executionKey: current.executionKey,
				workerId: current.workerId,
				status,
				error: effectiveCompletion.error,
				retryable: effectiveCompletion.retryable,
				recoveryDecision: status === "completed" ? "awaiting_evidence" : "replan_required",
				completedAt: pendingCompletion.completedAt,
				resultEvidenceRef,
			};
			const launches: readonly DefaultTaskRuntimeLaunch[] = state.launches.map((launch) =>
				launch.attemptId === attemptId ? { ...launch, status, result } : launch,
			);
			return [evolveState(state, { launches, pendingCompletions }), { ...current, status, result }];
		});
		if (terminalLaunch === null) return;
		if (terminalLaunch.workerId === null) throw new Error("default_prime_task_runtime_completion_without_worker");
		const failureNotice: DefaultPrimeWorkerFailureNotice | null =
			effectiveCompletion.status === "completed"
				? null
				: {
						workflowId: input.workflowId,
						taskId: terminalLaunch.taskId,
						attemptId,
						executionKey: terminalLaunch.executionKey,
						workerId: terminalLaunch.workerId,
						status: effectiveCompletion.status,
						error: effectiveCompletion.error ?? `Worker ended with ${effectiveCompletion.status}`,
						retryable: effectiveCompletion.retryable,
						recoveryDecision: "replan_required",
						resultEvidenceRef,
					};
		const timer = taskLeaseTimers.get(attemptId);
		if (timer !== undefined) {
			clearTimeout(timer);
			taskLeaseTimers.delete(attemptId);
		}
		if (terminalLaunch.status === "completed") {
			try {
				await reconcileCompletedTask(terminalLaunch);
				await launchReady();
			} catch {
				if (await recoverCompletedTasks()) await launchReady();
			}
		} else {
			const retryableTask = taskRetryAvailable(await readState(), terminalLaunch.taskId);
			await commitFailedStageOutcome(terminalLaunch, effectiveCompletion, !retryableTask);
			if (retryableTask && input.scheduleProgressWake !== undefined) {
				const wake = await persistRetryableResultRecoveryWake(terminalLaunch);
				await recoverProgressWake(wake);
			} else if (retryableTask) await launchReady();
		}
		if (failureNotice !== null) await input.workerFailureDelivery?.(failureNotice);
	};
	const completeLaunch = (
		...args: Parameters<typeof completeLaunchWithinHostOperation>
	): ReturnType<typeof completeLaunchWithinHostOperation> =>
		withHostLeaseOperation(() => completeLaunchWithinHostOperation(...args));
	const recoverPendingCompletions = async (): Promise<boolean> => {
		const state = await readState();
		for (const pending of state.pendingCompletions) {
			const launch = state.launches.find((candidate) => candidate.attemptId === pending.attemptId);
			if (
				launch === undefined ||
				(launch.status !== "launching" && launch.status !== "running" && launch.status !== "ambiguous")
			) {
				await mutate(async (current) => [
					evolveState(current, {
						pendingCompletions: current.pendingCompletions.filter(
							(candidate) => candidate.attemptId !== pending.attemptId,
						),
					}),
					undefined,
				]);
				continue;
			}
			try {
				await completeLaunch(pending.attemptId, pending.completion);
			} catch {
				return false;
			}
		}
		return true;
	};

	const workerTerminators = new Map<string, NonNullable<DefaultPrimeWorkerLaunch["terminate"]>>();
	const expiringAttempts = new Set<string>();
	const effectiveTaskLeaseExpiry = async (
		attemptId: string,
		hardDeadlineAt: string | null,
	): Promise<string | null> => {
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (
			replay.events.some(
				(event) =>
					(event.payload.kind === "workflow_child_outcome_committed" && event.payload.attemptId === attemptId) ||
					(event.payload.kind === "workflow_lease_release_recorded" &&
						event.payload.releaseRef.attemptId === attemptId),
			)
		)
			return null;
		const resourceEvent = replay.events.find(
			(event) =>
				event.payload.kind === "workflow_resource_lease_acquired" && event.payload.lease.attemptId === attemptId,
		);
		if (resourceEvent?.payload.kind !== "workflow_resource_lease_acquired") return null;
		const heartbeatEvent = [...replay.events]
			.reverse()
			.find(
				(event) => event.payload.kind === "workflow_task_lease_heartbeat" && event.payload.attemptId === attemptId,
			);
		const leaseExpiry =
			heartbeatEvent?.payload.kind === "workflow_task_lease_heartbeat"
				? heartbeatEvent.payload.renewedExpiresAt
				: resourceEvent.payload.lease.expiresAt;
		return hardDeadlineAt === null || Date.parse(leaseExpiry) <= Date.parse(hardDeadlineAt)
			? leaseExpiry
			: hardDeadlineAt;
	};

	const expireTaskLease = async (attemptId: string): Promise<void> => {
		const state = await readState();
		const launch = state.launches.find((candidate) => candidate.attemptId === attemptId);
		if (
			launch === undefined ||
			(launch.status !== "launching" && launch.status !== "running" && launch.status !== "ambiguous")
		)
			return;
		const hardDeadlineAt = launch.taskCapsule?.deadlineAt ?? null;
		const expiresAt = await effectiveTaskLeaseExpiry(attemptId, hardDeadlineAt);
		if (expiresAt === null) return;
		if (Date.parse(input.now()) < Date.parse(expiresAt)) {
			scheduleTaskLeaseDeadline(attemptId, expiresAt);
			return;
		}
		const expiryError =
			(hardDeadlineAt !== null || (launch.status === "ambiguous" && input.graph.generatedOutputPaths.length > 0)) &&
			Date.parse(input.now()) >= Date.parse(expiresAt)
				? "task_deadline_expired"
				: "task_resource_lease_expired";
		expiringAttempts.add(attemptId);
		try {
			await workerTerminators.get(attemptId)?.(expiryError);
			await completeLaunch(attemptId, {
				kind: "host",
				hostToken: DEFAULT_PRIME_HOST_COMPLETION_TOKEN,
				status: "error",
				output: "",
				error: expiryError,
				retryable: true,
			});
		} finally {
			expiringAttempts.delete(attemptId);
			workerTerminators.delete(attemptId);
		}
	};

	scheduleTaskLeaseDeadline = (attemptId, expiresAt) => {
		const prior = taskLeaseTimers.get(attemptId);
		if (prior !== undefined) clearTimeout(prior);
		const timer = setTimeout(
			() => {
				taskLeaseTimers.delete(attemptId);
				void expireTaskLease(attemptId);
			},
			Math.max(0, Date.parse(expiresAt) - Date.parse(input.now())),
		);
		timer.unref?.();
		taskLeaseTimers.set(attemptId, timer);
	};

	const recoverTaskLeaseDeadlines = async (): Promise<void> => {
		const state = await readState();
		for (const launch of state.launches) {
			if (launch.status !== "launching" && launch.status !== "running" && launch.status !== "ambiguous") continue;
			const expiresAt = await effectiveTaskLeaseExpiry(launch.attemptId, launch.taskCapsule?.deadlineAt ?? null);
			if (expiresAt === null) continue;
			if (Date.parse(input.now()) >= Date.parse(expiresAt)) await expireTaskLease(launch.attemptId);
			else scheduleTaskLeaseDeadline(launch.attemptId, expiresAt);
		}
	};

	const reportTaskHeartbeat = async (
		taskId: string,
		attemptId: string,
		executionKey: string,
		heartbeat: { readonly observedAt: string; readonly progressDigest: string },
	): Promise<void> => {
		if (!Number.isFinite(Date.parse(heartbeat.observedAt)))
			throw new Error("default_prime_task_runtime_heartbeat_time_invalid");
		if (!/^[0-9a-f]{64}$/u.test(heartbeat.progressDigest))
			throw new Error("default_prime_task_runtime_heartbeat_progress_invalid");
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const resourceEvent = replay.events.find(
			(event) =>
				event.payload.kind === "workflow_resource_lease_acquired" &&
				event.payload.lease.taskId === taskId &&
				event.payload.lease.attemptId === attemptId,
		);
		if (resourceEvent?.payload.kind !== "workflow_resource_lease_acquired")
			throw new Error("default_prime_task_runtime_resource_lease_missing");
		const state = await readState();
		const launch = state.launches.find(
			(candidate) => candidate.attemptId === attemptId && candidate.executionKey === executionKey,
		);
		if (launch === undefined) throw new Error("default_prime_task_runtime_heartbeat_launch_missing");
		const hardDeadlineAt = launch.taskCapsule?.deadlineAt ?? resourceEvent.payload.lease.expiresAt;
		const latestHeartbeat = [...replay.events]
			.reverse()
			.find(
				(event) =>
					event.payload.kind === "workflow_task_lease_heartbeat" &&
					event.payload.attemptId === attemptId &&
					event.payload.executionKey === executionKey,
			);
		if (
			latestHeartbeat?.payload.kind === "workflow_task_lease_heartbeat" &&
			latestHeartbeat.payload.progressDigest === heartbeat.progressDigest
		)
			return;
		const priorExpiresAt =
			latestHeartbeat?.payload.kind === "workflow_task_lease_heartbeat"
				? latestHeartbeat.payload.renewedExpiresAt
				: resourceEvent.payload.lease.expiresAt;
		if (
			Date.parse(heartbeat.observedAt) > Date.parse(priorExpiresAt) ||
			Date.parse(heartbeat.observedAt) >= Date.parse(hardDeadlineAt)
		)
			throw new Error("default_prime_task_runtime_heartbeat_after_lease_expired");
		const rootLease = durable.currentLeaseRef();
		const renewedExpiresAt = new Date(
			Math.min(
				Date.parse(rootLease.expiresAt),
				Date.parse(hardDeadlineAt),
				Date.parse(heartbeat.observedAt) + progressLeaseDurationMs,
			),
		).toISOString();
		if (Date.parse(renewedExpiresAt) <= Date.parse(heartbeat.observedAt))
			throw new Error("default_prime_task_runtime_heartbeat_deadline_invalid");
		const heartbeatWithoutDigest = {
			workflowId: input.workflowId,
			taskId,
			attemptId,
			executionKey,
			epochRef: input.epochRef,
			resourceLeaseRef: leaseRefOf(resourceEvent.payload.lease),
			observedAt: heartbeat.observedAt,
			priorExpiresAt,
			renewedExpiresAt,
			progressDigest: heartbeat.progressDigest,
		};
		await commitRuntimeEvent(
			{
				kind: "workflow_task_lease_heartbeat",
				...heartbeatWithoutDigest,
				heartbeatDigest: digestObject(heartbeatWithoutDigest),
			},
			`default-prime-task-heartbeat:${executionKey}:${heartbeat.progressDigest}`,
			executionKey,
		);
		scheduleTaskLeaseDeadline(attemptId, renewedExpiresAt);
	};

	const validateTaskCapsule = (
		capsule: DefaultPrimeWorkerTaskCapsule,
		expected: DefaultPrimeWorkerTaskCapsuleCore,
	): void => {
		const { capsuleDigest, receipt, ...core } = capsule;
		const logicalPathParts = parseWorkflowCanonicalPath(capsule.outputContract.logicalPath);
		const graphAllowsOutput = input.graph.generatedOutputPaths.some((root) => {
			const rootParts = parseWorkflowCanonicalPath(root);
			return (
				rootParts.length <= logicalPathParts.length &&
				rootParts.every((part, index) => part === logicalPathParts[index])
			);
		});
		if (
			digestObject(core) !== digestObject(expected) ||
			capsuleDigest !== defaultPrimeWorkerTaskCapsuleDigest(expected) ||
			receipt.workflowId !== input.workflowId ||
			receipt.bindingDigest !== defaultPrimeWorkerTaskCapsuleReceiptBindingDigest(capsuleDigest) ||
			!capsule.outputContract.logicalPath.startsWith("artifacts/out/") ||
			!graphAllowsOutput ||
			capsule.outputContract.maxBytes < 1 ||
			capsule.outputContract.maxItems < 1
		)
			throw new Error("default_prime_task_capsule_invalid");
	};

	const taskCapsulePrompt = (capsule: DefaultPrimeWorkerTaskCapsule): string =>
		[
			"Execute the signed task capsule below.",
			"Submit the result as the final assistant response using only canonical JSON that matches outputContract.jsonSchema.",
			"The host validates that response and publishes it to outputContract.logicalPath; do not write the input workspace.",
			new TextDecoder().decode(canonicalJsonBytes(capsule)),
		].join("\n\n");

	const clearProgressRecoveryWake = async (leaseId: string): Promise<void> => {
		if (progressRecoveryTimer !== null) {
			clearTimeout(progressRecoveryTimer);
			progressRecoveryTimer = null;
		}
		await mutate(async (state) =>
			state.progressRecoveryWake?.leaseId === leaseId
				? [evolveState(state, { progressRecoveryWake: null }), undefined]
				: [state, undefined],
		);
	};

	const blockProgressRecovery = async (wake: DefaultTaskRuntimeProgressRecoveryWake): Promise<void> => {
		const state = await readState();
		if (state.progressRecoveryWake?.status === "blocked") return;
		if (state.progressRecoveryWake?.status === "admitted") return;
		const conditionDigest = digestObject({
			workflowId: input.workflowId,
			leaseId: wake.leaseId,
			wakeObligationId: wake.wakeObligationId,
			predicateDigest: wake.predicateDigest,
			recoveryAttempt: wake.recoveryAttempt,
			deadlineAt: wake.deadlineAt,
		});
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (
			replay.events.some(
				(event) =>
					event.payload.kind === "workflow_external_blocker_recorded" &&
					event.payload.blocker.dependencyId === `progress:${wake.leaseId}` &&
					event.payload.blocker.conditionDigest === conditionDigest,
			)
		) {
			await mutate(async (current) => [
				evolveState(current, {
					progressRecoveryWake:
						current.progressRecoveryWake?.leaseId === wake.leaseId
							? { ...current.progressRecoveryWake, status: "blocked" as const }
							: current.progressRecoveryWake,
				}),
				undefined,
			]);
			return;
		}
		if (input.blockWorkflow === undefined)
			throw new Error("default_prime_task_runtime_progress_recovery_deadline_expired");
		await input.blockWorkflow({
			dependencyId: `progress:${wake.leaseId}`,
			conditionDigest,
			requiredChange: "progress_recovery_deadline_expired",
			owner: "workflow_host",
			resumeEventKind: "workflow_progress_reconciled",
			earliestRetryAt: null,
			evidenceRefs: [],
			recordedAt: input.now(),
		});
		await mutate(async (current) => [
			evolveState(current, {
				progressRecoveryWake:
					current.progressRecoveryWake?.leaseId === wake.leaseId
						? { ...current.progressRecoveryWake, status: "blocked" as const }
						: current.progressRecoveryWake,
			}),
			undefined,
		]);
	};

	const recoverProgressWake = async (wake: DefaultTaskRuntimeProgressRecoveryWake): Promise<void> => {
		const state = await readState();
		const persistedWake = state.progressRecoveryWake;
		if (persistedWake === null || persistedWake.leaseId !== wake.leaseId || persistedWake.status !== "pending")
			return;
		if (
			!persistedWake.wakeObligationId.startsWith("result-recovery-wake:") &&
			Date.parse(input.now()) < Date.parse(persistedWake.deadlineAt)
		) {
			scheduleProgressRecoveryDeadline(persistedWake);
			return;
		}
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const closed = replay.events.some(
			(event) => event.payload.kind === "workflow_progress_lease_closed" && event.payload.leaseId === wake.leaseId,
		);
		if (closed) {
			await clearProgressRecoveryWake(wake.leaseId);
			return;
		}
		const recoveryEvent = replay.events.find(
			(event) =>
				event.payload.kind === "workflow_progress_recovery_started" &&
				event.payload.leaseId === wake.leaseId &&
				event.payload.wakeObligationId === wake.wakeObligationId &&
				event.payload.recoveryAttempt === wake.recoveryAttempt,
		);
		if (recoveryEvent?.payload.kind !== "workflow_progress_recovery_started")
			throw new Error("default_prime_task_runtime_progress_recovery_event_missing");
		const resultWakePrefix = `result-recovery-wake:${input.workflowId}:`;
		const sourceExecutionKey = wake.wakeObligationId.startsWith(resultWakePrefix)
			? wake.wakeObligationId.slice(resultWakePrefix.length)
			: null;
		const sourceTaskId =
			sourceExecutionKey === null
				? null
				: state.launches.find((launch) => launch.executionKey === sourceExecutionKey)?.taskId;
		if (sourceExecutionKey !== null && sourceTaskId === undefined)
			throw new Error("default_prime_task_runtime_progress_recovery_source_missing");
		try {
			await recoverTaskLeaseDeadlines();
			await launchReady();
		} catch {
			await blockProgressRecovery(persistedWake);
			return;
		}
		const afterLaunch = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const freshAttemptIds = new Set(
			afterLaunch.events.flatMap((event) =>
				event.sequence > recoveryEvent.sequence &&
				event.payload.kind === "workflow_dispatch_intent" &&
				(sourceTaskId === null || event.payload.taskId === sourceTaskId)
					? [event.payload.attemptId]
					: [],
			),
		);
		const afterState = await readState();
		const freshAdmission = afterState.launches.some(
			(launch) =>
				freshAttemptIds.has(launch.attemptId) &&
				(sourceTaskId === null || launch.taskId === sourceTaskId) &&
				launch.workerId !== null &&
				launch.launchEvidenceRef !== null &&
				(input.graph.generatedOutputPaths.length === 0 || launch.taskCapsule !== null),
		);
		if (freshAdmission) {
			await mutate(async (current) => [
				evolveState(current, {
					progressRecoveryWake:
						current.progressRecoveryWake?.leaseId === wake.leaseId
							? { ...current.progressRecoveryWake, status: "admitted" as const }
							: current.progressRecoveryWake,
				}),
				undefined,
			]);
			if (progressRecoveryTimer !== null) {
				clearTimeout(progressRecoveryTimer);
				progressRecoveryTimer = null;
			}
			return;
		}
		if (
			afterLaunch.events.some(
				(event) =>
					event.payload.kind === "workflow_progress_lease_closed" && event.payload.leaseId === wake.leaseId,
			)
		) {
			await clearProgressRecoveryWake(wake.leaseId);
			return;
		}
		if (Date.parse(input.now()) < Date.parse(persistedWake.deadlineAt)) {
			scheduleProgressRecoveryDeadline(persistedWake);
			return;
		}
		await blockProgressRecovery(persistedWake);
	};

	const evaluateScheduledProgressRecovery = (wake: DefaultTaskRuntimeProgressRecoveryWake): void => {
		void recoverProgressWake(wake).catch(async () => {
			try {
				await blockProgressRecovery(wake);
			} catch {
				if (Date.parse(input.now()) < Date.parse(wake.deadlineAt)) scheduleProgressRecoveryDeadline(wake);
			}
		});
	};

	scheduleProgressRecoveryDeadline = (wake) => {
		if (wake.status !== "pending") return;
		if (progressRecoveryTimer !== null) clearTimeout(progressRecoveryTimer);
		progressRecoveryTimer = setTimeout(
			() => {
				progressRecoveryTimer = null;
				evaluateScheduledProgressRecovery(wake);
			},
			Math.max(0, Date.parse(wake.deadlineAt) - Date.parse(input.now())),
		);
		progressRecoveryTimer.unref?.();
	};

	async function launchReady(): Promise<void> {
		if (input.workerLauncher === undefined) return;
		if (input.graph.generatedOutputPaths.length > 0 && input.createTaskCapsule === undefined)
			throw new Error("default_prime_task_contract_unsatisfiable");
		const launchRequests = await mutate(async (state) => {
			const running = state.launches.filter(
				(launch) => launch.status === "launching" || launch.status === "running",
			).length;
			const available = Math.max(0, input.maxWorkers - running);
			const terminal = new Set(state.terminalTaskIds);
			const tasks = input.graph.tasks
				.filter((task) => {
					if (!task.dependencyTaskIds.every((dependency) => terminal.has(dependency))) return false;
					const attempts = state.launches.filter((launch) => launch.taskId === task.taskId);
					return attempts.length === 0 || taskRetryAvailable(state, task.taskId);
				})
				.slice(0, available);
			const statusBeforeBarrier = input.readWorkflowStatus?.();
			if (statusBeforeBarrier !== undefined && statusBeforeBarrier.status !== "active") return [state, []];
			await Promise.all(tasks.map((task) => input.beforeTaskLaunch?.(task.taskId)));
			const statusAfterBarrier = input.readWorkflowStatus?.();
			if (statusAfterBarrier !== undefined && statusAfterBarrier.status !== "active") return [state, []];
			const launches = [...state.launches];
			const requests = tasks.map((task) => {
				const priorAttempts = launches.filter((launch) => launch.taskId === task.taskId).length;
				const baseAttemptId = `attempt:${task.taskId}:${input.graph.graphDigest.slice(0, 16)}`;
				const attemptId = priorAttempts === 0 ? baseAttemptId : `${baseAttemptId}:retry:${priorAttempts}`;
				const executionKey = digestObject({
					kind: "default-prime-task-attempt",
					workflowId: input.workflowId,
					taskId: task.taskId,
					attemptId,
					epochRef: input.epochRef,
				});
				launches.push({
					taskId: task.taskId,
					attemptId,
					executionKey,
					workerId: null,
					status: "launching",
					launchEvidenceRef: null,
					taskCapsule: null,
					evidenceRefs: [],
					result: null,
				});
				return { task, attemptId, executionKey };
			});
			return [evolveState(state, { launches }), requests];
		});
		for (const request of launchRequests) {
			await ensureProgressLease(launchRequests.map((candidate) => candidate.task.taskId));
			const resourceLease = await acquireTaskResourceLease(
				request.task.taskId,
				request.attemptId,
				request.executionKey,
			);
			await commitDispatchIntent(request.task.taskId, request.attemptId, request.executionKey, resourceLease);
			let taskCapsule: DefaultPrimeWorkerTaskCapsule | null = null;
			if (input.createTaskCapsule !== undefined) {
				const replay = await input.runtimeStore.replay({
					workflowId: input.workflowId,
					fromSequence: 0,
					expectedStoreEpoch: input.epochRef.storeEpoch,
				});
				if (replay.quarantined || replay.head.eventDigest === null)
					throw new Error("default_prime_task_runtime_w0_authority_missing");
				taskCapsule = await input.createTaskCapsule({
					task: request.task,
					attemptId: request.attemptId,
					executionKey: request.executionKey,
					epochRef: input.epochRef,
					journalHead: replay.head,
					deadlineAt: resourceLease.expiresAt,
				});
				const { capsuleDigest: _capsuleDigest, receipt: _receipt, ...capsuleCore } = taskCapsule;
				validateTaskCapsule(taskCapsule, {
					...capsuleCore,
					workflowId: input.workflowId,
					taskId: request.task.taskId,
					attemptId: request.attemptId,
					executionKey: request.executionKey,
					epochRef: input.epochRef,
					journalHead: replay.head,
					goalRevisionDigest: input.goalRevisionDigest,
					graphDigest: input.graph.graphDigest,
					objective: request.task.objective,
					requirementIds: request.task.requirementIds,
					completionCriteria: request.task.completionCriteria,
					dependencyTaskIds: request.task.dependencyTaskIds,
					authority: request.task.authority,
					deadlineAt: resourceLease.expiresAt,
				});
			}
			const launched = await input.workerLauncher({
				workflowId: input.workflowId,
				taskId: request.task.taskId,
				attemptId: request.attemptId,
				executionKey: request.executionKey,
				epochRef: input.epochRef,
				deadlineAt: resourceLease.expiresAt,
				prompt: taskCapsule === null ? request.task.objective : taskCapsulePrompt(taskCapsule),
				taskCapsule: taskCapsule ?? undefined,
				sessionName: `prime-${request.task.taskId}`,
				...(request.task.computeClass === undefined ? {} : { computeClass: request.task.computeClass }),
				// A task's declared authority becomes the worker's actual tool set. Without this a
				// review role would launch holding an edit tool, and "the reviewer cannot author the
				// work it checks" would be prose rather than a property of the process.
				...(() => {
					const allowedToolNames = workflowToolsForCapabilities(request.task.authority);
					return allowedToolNames === undefined ? {} : { allowedToolNames };
				})(),
				// The scheduler already refuses overlapping declarations; passing them down is what
				// lets the host compare a declaration to what the worker actually wrote. A read-only
				// role is handed an explicitly empty list rather than nothing, because "may write
				// nothing" has to be enforceable: its tools can write even though its role says it
				// does not, so the declaration alone proves nothing.
				...(() => {
					if (request.task.ownedPaths.length > 0) return { ownedPaths: request.task.ownedPaths };
					// No write authority means no path may change. Anchoring on authority rather than a
					// role label matters because the tool table hands `ipython` to a plain
					// `read_workspace` task, and IPython can write a file - so the grant says read-only
					// while the tools say otherwise, and only the writes settle it.
					const mayWrite = request.task.authority.some((capability) =>
						(WORKFLOW_WRITE_AUTHORITY_CAPABILITIES as readonly string[]).includes(capability),
					);
					return mayWrite ? {} : { ownedPaths: [] as readonly string[] };
				})(),
				reportHeartbeat: (heartbeat) =>
					reportTaskHeartbeat(request.task.taskId, request.attemptId, request.executionKey, heartbeat),
			});
			if (launched.terminate !== undefined) workerTerminators.set(request.attemptId, launched.terminate);
			if (
				[launched.workerId, launched.executionIdentity, launched.processStartId, launched.processGroupId].some(
					(value) => value.length === 0,
				) ||
				!Number.isFinite(Date.parse(launched.launchedAt))
			)
				throw new Error("default_prime_task_runtime_worker_identity_invalid");
			const launchEvidenceRef = await publishLaunchEvidence(
				request.task.taskId,
				request.attemptId,
				request.executionKey,
				launched,
				taskCapsule,
			);
			await mutate(async (state) => {
				const launches = state.launches.map((launch) =>
					launch.attemptId === request.attemptId
						? {
								...launch,
								status: "running" as const,
								workerId: launched.workerId,
								launchEvidenceRef,
								taskCapsule,
							}
						: launch,
				);
				return [evolveState(state, { launches }), undefined];
			});
			scheduleTaskLeaseDeadline(request.attemptId, resourceLease.expiresAt);
			if (launched.completion !== undefined)
				void launched.completion
					.then((completion) =>
						expiringAttempts.has(request.attemptId) ? undefined : completeLaunch(request.attemptId, completion),
					)
					.catch((error: unknown) => blockTerminalPublicationFailure(request.attemptId, error))
					.catch(() => undefined);
		}
	}

	const scheduler = {
		enqueue: async () => undefined,
		onEvent: async (_event: WorkflowSchedulerEvent): Promise<readonly WorkflowDispatchResult[]> => {
			await launchReady();
			return [];
		},
		refill: async (): Promise<readonly WorkflowDispatchResult[]> => {
			await launchReady();
			return [];
		},
		observe: async (): Promise<readonly WorkflowDispatchResult[]> => [],
		pause: async () => undefined,
		resume: async () => undefined,
	} as unknown as WorkflowScheduler;

	const readSchedulerState = async (): Promise<WorkflowSchedulerState> => {
		const state = await readState();
		return {
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			entries: [],
			pausedReason: null,
			activeAttemptIds: state.launches
				.filter(
					(launch) =>
						launch.status === "launching" || launch.status === "running" || launch.status === "ambiguous",
				)
				.map((launch) => launch.attemptId),
			terminalAttemptIds: state.launches
				.filter(
					(launch) =>
						launch.status !== "launching" && launch.status !== "running" && launch.status !== "ambiguous",
				)
				.map((launch) => launch.attemptId),
			lastEventSequence: state.launches.length + state.terminalTaskIds.length,
		};
	};

	const reconcileAttempt = async (request: WorkflowRecoveryRequest): Promise<WorkflowReconciliationOutcome> => {
		if (
			request.workflowId !== input.workflowId ||
			request.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
			request.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
			request.taskId.length === 0 ||
			request.attemptId.length === 0 ||
			request.executionKey.length === 0 ||
			(request.persistedChildIdentity !== null &&
				request.persistedChildIdentity.executionKey !== request.executionKey)
		)
			throw new Error("default_prime_task_runtime_recovery_request_invalid");
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("default_prime_task_runtime_w0_authority_missing");
		const prior = [...replay.events]
			.reverse()
			.find(
				(event) =>
					event.payload.kind === "workflow_reconciliation_recorded" &&
					event.payload.attemptId === request.attemptId,
			);
		if (prior?.payload.kind === "workflow_reconciliation_recorded") return structuredClone(prior.payload.outcome);
		const state = await readState();
		const launch = state.launches.find(
			(candidate) =>
				candidate.taskId === request.taskId &&
				candidate.attemptId === request.attemptId &&
				candidate.executionKey === request.executionKey,
		);
		if (launch === undefined) throw new Error("default_prime_task_runtime_recovery_attempt_missing");
		const disposition =
			launch.status === "completed"
				? ("completed" as const)
				: launch.status === "error" || launch.status === "cancelled"
					? ("failed" as const)
					: ("corrective_work_required" as const);
		const outcomeWithoutDigest = {
			workflowId: input.workflowId,
			reconciliationAttemptId: `reconcile:${request.attemptId}`,
			taskId: request.taskId,
			attemptId: request.attemptId,
			disposition,
			persistedChildIdentity: request.persistedChildIdentity,
			observedChildIdentity: null,
			observedProcessGroupId: null,
			observedTranscriptDigest: null,
			observedWorkspaceDigest: digestObject({
				workflowId: input.workflowId,
				goalRevisionDigest: input.goalRevisionDigest,
				graphDigest: input.graph.graphDigest,
				journalHeadDigest: replay.head.eventDigest,
			}),
			epochRef: input.epochRef,
			evidenceRefs: launch.evidenceRefs.length === 0 ? structuredClone(request.evidenceRefs) : launch.evidenceRefs,
		};
		const outcome: WorkflowReconciliationOutcome = {
			...outcomeWithoutDigest,
			stateDigest: digestObject(outcomeWithoutDigest),
		};
		await commitRuntimeEvent(
			{
				kind: "workflow_reconciliation_recorded",
				workflowId: input.workflowId,
				attemptId: request.attemptId,
				epochRef: input.epochRef,
				outcome,
				outcomeDigest: digestObject(outcome),
			},
			`default-prime-reconciliation:${request.executionKey}`,
			request.executionKey,
		);
		return outcome;
	};

	const recovery: WorkflowRuntimeRecoveryCoordinator = Object.freeze({
		readiness: () => ({ canRecover: true, blockingReasons: [] }),
		startRecovery: async () => ({
			status: "started" as const,
			binding: null,
			nonExecutionProof: null,
			journalHeadDigest: null,
		}),
		beginRecovery: async () => ({
			status: "started" as const,
			binding: null,
			nonExecutionProof: null,
			journalHeadDigest: null,
		}),
		reconcile: reconcileAttempt,
	});

	const authority: WorkflowTaskRuntimeAuthority = {
		workflowId: input.workflowId,
		epochRef: input.epochRef,
		graph: input.graph,
		runtimeStore: input.runtimeStore,
		scheduler,
		dispatcher: Object.freeze({}) as WorkflowDispatcher,
		leases: Object.freeze({}) as WorkflowLeaseManager,
		effects: unwiredEffectBroker(),
		recovery,
		failureOutbox: durable.outbox,
		prime: {
			enqueue: async () => {
				throw new Error("default_prime_task_runtime_direct_enqueue_forbidden");
			},
			recordEvidence: async (request) => {
				if (request.evidenceRefs.length === 0) throw new Error("workflow_task_runtime_evidence_required");
				await mutate(async (state) => {
					if (!state.launches.some((launch) => launch.taskId === request.stageId))
						throw new Error("workflow_task_runtime_stage_attempt_missing");
					const launches = state.launches.map((launch) =>
						launch.taskId === request.stageId
							? {
									...launch,
									evidenceRefs: [...new Map(request.evidenceRefs.map((ref) => [ref.digest, ref])).values()],
								}
							: launch,
					);
					return [evolveState(state, { launches }), undefined];
				});
				return classification();
			},
		},
		start: async () => {
			const replay = await input.runtimeStore.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.epochRef.storeEpoch,
			});
			if (replay.quarantined || replay.head.eventDigest === null)
				throw new Error("default_prime_task_runtime_w0_authority_missing");
			if (!(await recoverPendingCompletions())) return [];
			if (!(await recoverUnadmittedLaunches())) return [];
			await recoverProgressLease();
			await recoverFailedWorkflowBlocker();
			await recoverTaskLeaseDeadlines();
			if (await recoverCompletedTasks()) await launchReady();
			return [];
		},
		dispatch: async () => {
			throw new Error("default_prime_task_runtime_direct_dispatch_forbidden");
		},
		onEvent: scheduler.onEvent,
		onTerminal: scheduler.onEvent,
		readStatus: async () => {
			const state = await readState();
			const replay = await input.runtimeStore.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.epochRef.storeEpoch,
			});
			const leaseEvent = [...replay.events]
				.reverse()
				.find((event) => event.payload.kind === "workflow_progress_lease_acquired");
			const progressLease =
				leaseEvent?.payload.kind === "workflow_progress_lease_acquired" ? leaseEvent.payload : null;
			const leaseClosed =
				progressLease !== null &&
				replay.events.some(
					(event) =>
						event.payload.kind === "workflow_progress_lease_closed" &&
						event.payload.leaseId === progressLease.lease.leaseId,
				);
			const stallEvent =
				progressLease === null || leaseClosed
					? null
					: [...replay.events]
							.reverse()
							.find(
								(event) =>
									event.payload.kind === "workflow_progress_stalled" &&
									event.payload.record.leaseId === progressLease.lease.leaseId,
							);
			const progressRecoveryCount =
				progressLease === null
					? 0
					: replay.events.filter(
							(event) =>
								event.payload.kind === "workflow_progress_recovery_started" &&
								event.payload.leaseId === progressLease.lease.leaseId,
						).length;
			const activeWorkers = state.launches.filter(
				(launch) => launch.status === "launching" || launch.status === "running",
			).length;
			const activeTaskIds = new Set(
				state.launches
					.filter((launch) => launch.status === "launching" || launch.status === "running")
					.map((launch) => launch.taskId),
			);
			const unresolvedAttempts = state.launches.filter((launch) => launch.status === "ambiguous").length;
			const failedAttempts = state.launches.filter(
				(launch) =>
					(launch.status === "error" || launch.status === "cancelled") && !activeTaskIds.has(launch.taskId),
			).length;
			const blockedAttempts = unresolvedAttempts + failedAttempts;
			return {
				status: blockedAttempts > 0 ? "blocked" : activeWorkers > 0 ? "waiting_on_children" : "idle",
				goalRevisionDigest: input.goalRevisionDigest,
				activeWorkers,
				eligibleReadyTasks: 0,
				idleCapacity: Math.max(0, input.maxWorkers - activeWorkers),
				idleReason: blockedAttempts > 0 ? "recovery" : activeWorkers > 0 ? "none" : "no_ready_work",
				progressCutHeadDigest: progressLease?.cut.journalHead.eventDigest ?? null,
				lastAuthoritativeProgressAt: progressLease?.cut.lastAuthoritativeProgressAt ?? null,
				progressLeaseOwner: progressLease?.lease.owner ?? null,
				progressLeaseDeadline: progressLease?.lease.deadline ?? null,
				progressPredicateDigest: progressLease?.lease.expectedTransitionPredicateDigest ?? null,
				nextWakeAt: progressLease === null || leaseClosed ? null : progressLease.lease.deadline,
				progressRecoveryCount,
				readyTaskSetDigest: progressLease?.cut.readyTaskSetDigest ?? null,
				nextGate: progressLease?.cut.nextGate ?? null,
				progressStallReason:
					stallEvent?.payload.kind === "workflow_progress_stalled" ? stallEvent.payload.record.reason : null,
			};
		},
		recordTelemetry: async (telemetry) =>
			mutate(async (state) => {
				return [evolveState(state, { latestTelemetry: structuredClone(telemetry) }), structuredClone(telemetry)];
			}),
		assertStageAcceptable: async (request) => {
			assertClassification(request.classification);
			const state = await readState();
			if (!state.launches.some((launch) => launch.taskId === request.stageId))
				throw new Error("workflow_task_runtime_stage_attempt_missing");
		},
		acceptStage: async (request) => {
			assertClassification(request.classification);
			const state = await readState();
			if (state.terminalTaskIds.includes(request.stageId)) return;
			await commitAcceptedStageOutcome(request.stageId);
			await closeProgressLease(request.stageId);
			await mutate(async (state) => {
				if (!state.launches.some((launch) => launch.taskId === request.stageId))
					throw new Error("workflow_task_runtime_stage_attempt_missing");
				const terminalTaskIds = [...new Set([...state.terminalTaskIds, request.stageId])];
				const launches = state.launches.map((launch) =>
					launch.taskId === request.stageId && (launch.status === "launching" || launch.status === "running")
						? { ...launch, status: "completed" as const }
						: launch,
				);
				return [evolveState(state, { terminalTaskIds, launches }), undefined];
			});
			await launchReady();
		},
		readState: readSchedulerState,
		readAudit: async () => {
			const state = await readState();
			return {
				scheduler: await readSchedulerState(),
				terminalTaskIds: state.terminalTaskIds,
				launchEvidenceRefs: state.launches.flatMap((launch) =>
					launch.launchEvidenceRef === null ? [] : [launch.launchEvidenceRef],
				),
				workerResults: state.launches.flatMap((launch) => (launch.result === null ? [] : [launch.result])),
			};
		},
		recover: reconcileAttempt,
		reassign: async () => {
			throw new Error("default_prime_task_runtime_reassignment_requires_recovery_proof");
		},
	};
	return Object.freeze(authority);
}
