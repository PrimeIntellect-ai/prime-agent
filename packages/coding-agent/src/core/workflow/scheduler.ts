import { getProcessStartId } from "../session-lease.js";
import type { WorkflowInternalAdmissionContext } from "./admission.js";
import type {
	WorkflowAdaptiveAllocationState,
	WorkflowApprovalResponse,
	WorkflowControlCapacityVector,
	WorkflowDispatchBlockingReason,
	WorkflowEpochRef,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowOwnershipLease,
	WorkflowPolicyRevision,
	WorkflowResourceEnvelope,
	WorkflowResourceLease,
	WorkflowResourceVector,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreDurableContext,
	WorkflowTask,
	WorkflowWorkerPartition,
} from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes } from "./contracts.js";
import type { WorkflowRevisionBoundaryReader } from "./dispatch.js";
import {
	assertRevisionBoundary,
	deriveWorkflowExecutionKey,
	leaseRefOf,
	type WorkflowCanonicalDispatchInput,
	type WorkflowDispatcher,
	type WorkflowDispatchReadiness,
	type WorkflowDispatchResult,
} from "./dispatch.js";
import type {
	WorkflowLeaseDispatchReservation,
	WorkflowLeaseManager,
	WorkflowLeaseRequest,
	WorkflowOwnershipLeaseRequest,
} from "./leases.js";
import { createLocalAppendLeaseProcessIdentity } from "./local-append-lease.js";
import {
	consumeWorkflowRecipeAdmissionAtHost,
	validateWorkflowRecipeAdmission,
	verifyWorkflowRecipeAdmissionForTask,
	WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID,
	WORKFLOW_RECIPE_INTENT_TDD_GATE_ID,
	type WorkflowRecipeAdmissionArtifact,
	type WorkflowRecipeHostResolutionPort,
	type WorkflowRecipeSuperpowersSkillBinding,
} from "./recipes.js";
import type { WorkflowTaskGraph } from "./task-graph.js";

export type WorkflowSchedulerEventKind =
	| "task_ready"
	| "lease_released"
	| "attempt_completed"
	| "recovery_reconciled"
	| "configuration_changed"
	| "worker_state_changed"
	| "approval_changed"
	| "evidence_published";

export interface WorkflowSchedulerEvent {
	kind: WorkflowSchedulerEventKind;
	workflowId: string;
	epochRef: WorkflowEpochRef;
	eventSequence: number;
	attemptId?: string;
	/** Digest of the authenticated journal head which authorized this event. */
	headDigest?: string;
	/** Digest of the authenticated source journal event, when applicable. */
	eventDigest?: string;
	/** Writer identity carried by the authenticated source event. */
	writerIdentity?: string;
	/** Alias accepted at the public boundary for callers that name the journal explicitly. */
	journalHeadDigest?: string;
}

export interface WorkflowSchedulerQueueEntry {
	input: WorkflowCanonicalDispatchInput;
	queuedAt: string;
	priority: number;
	blockedBy: readonly WorkflowDispatchBlockingReason[];
	/** Host-resolved admission identity captured before an entry can dispatch. */
	readonly recipeId?: string;
	readonly recipeRevision?: number;
	readonly recipeAdmissionDigest?: string;
}

export interface WorkflowSchedulerState {
	workflowId: string;
	epochRef: WorkflowEpochRef;
	entries: readonly WorkflowSchedulerQueueEntry[];
	pausedReason: string | null;
	activeAttemptIds: readonly string[];
	terminalAttemptIds?: readonly string[];
	lastEventSequence?: number;
}

export interface WorkflowSchedulerStateStore {
	read(workflowId: string, epochRef: WorkflowEpochRef): Promise<WorkflowSchedulerState | null>;
	write(state: WorkflowSchedulerState): Promise<void>;
	compareAndSwap?(input: {
		workflowId: string;
		epochRef: WorkflowEpochRef;
		expectedStateDigest: string | null;
		nextState: WorkflowSchedulerState;
		idempotencyKey: string;
	}): Promise<"applied" | "already_applied" | "conflict">;
}

export interface WorkflowSchedulerRuntimeFactoryInput
	extends Omit<WorkflowSchedulerDependencies, "queueState" | "store"> {
	readonly store: WorkflowRuntimeStore;
	/** Durable auxiliary record used for the scheduler queue projection. */
	readonly schedulerStateRecordName?: string;
}

/**
 * Create the filesystem-backed scheduler state store owned by one runtime store.
 *
 * Args:
 * input: Authenticated runtime store and optional auxiliary record name.
 * Return: Queue state operations serialized by the runtime append lease.
 */
export function createWorkflowSchedulerStateStore(input: {
	readonly store: WorkflowRuntimeStore;
	readonly recordName?: string;
}): WorkflowSchedulerStateStore {
	const durable = input.store.durableContext;
	if (durable === undefined) throw new WorkflowSchedulerError("workflow_scheduler_durable_state_required");
	const recordName = input.recordName ?? "workflow-scheduler-state.json";
	const assertBinding = (workflowId: string, epochRef: WorkflowEpochRef, state: WorkflowSchedulerState): void => {
		if (state.workflowId !== workflowId || !sameEpoch(state.epochRef, epochRef))
			throw new WorkflowSchedulerError("workflow_scheduler_state_epoch_mismatch");
		validateSchedulerState(state);
	};
	const readState = async (workflowId: string, epochRef: WorkflowEpochRef): Promise<WorkflowSchedulerState | null> => {
		const bytes = await durable.auxiliaryStore.read(recordName);
		if (bytes === null) return null;
		let parsed: unknown;
		try {
			parsed = parseCanonicalJsonBytes(bytes);
		} catch {
			throw new WorkflowSchedulerError("workflow_scheduler_state_invalid");
		}
		if (!isRecord(parsed)) throw new WorkflowSchedulerError("workflow_scheduler_state_invalid");
		const state = parsed as unknown as WorkflowSchedulerState;
		assertBinding(workflowId, epochRef, state);
		return state;
	};
	const writeState = async (state: WorkflowSchedulerState): Promise<void> => {
		assertBinding(state.workflowId, state.epochRef, state);
		await durable.withExclusiveLease(`workflow-scheduler-state:${state.workflowId}`, async () => {
			await durable.auxiliaryStore.write(recordName, canonicalJsonBytes(state));
		});
	};
	return {
		read: readState,
		write: writeState,
		compareAndSwap: async (casInput) =>
			durable.withExclusiveLease(`workflow-scheduler-state:${casInput.workflowId}`, async () => {
				const current = await readState(casInput.workflowId, casInput.epochRef);
				const currentDigest = current === null ? null : digestObject(current);
				if (currentDigest === digestObject(casInput.nextState)) return "already_applied";
				if (currentDigest !== casInput.expectedStateDigest) return "conflict";
				assertBinding(casInput.workflowId, casInput.epochRef, casInput.nextState);
				await durable.auxiliaryStore.write(recordName, canonicalJsonBytes(casInput.nextState));
				return "applied";
			}),
	};
}

export interface WorkflowSchedulerClock {
	now(): string;
}

export interface WorkflowSchedulerInventory {
	listRunning(workflowId: string, epochRef?: WorkflowEpochRef): Promise<readonly unknown[]>;
}

export interface WorkflowSchedulerTaskValue {
	/** Expected improvement toward a verified outcome, not throughput. */
	marginalValidatedImprovement: number;
	/** Uncertainty associated with the expected improvement. */
	uncertainty: number;
	/** Cost of the attempt in the same units as the resource envelope. */
	cost: number;
	/** Estimated time to a verified outcome. */
	timeToVerifiedOutcome: number;
	/** Host-derived value of information, bounded before it affects ordering. */
	valueOfInformation?: number;
}

export interface WorkflowSchedulerPolicyWeights {
	priority?: number;
	age?: number;
	value?: number;
	uncertainty?: number;
	cost?: number;
}

export interface WorkflowSchedulerDependencies {
	readonly graph: WorkflowTaskGraph;
	readonly readGraph?: () => WorkflowTaskGraph;
	readonly queueState: WorkflowSchedulerStateStore;
	readonly dispatcher: WorkflowDispatcher;
	readonly leases: WorkflowLeaseManager;
	readonly readCurrentEpoch: ((workflowId: string) => Promise<WorkflowEpochRef>) | (() => Promise<WorkflowEpochRef>);
	readonly readRootLeaseRef:
		| ((workflowId: string, epochRef: WorkflowEpochRef) => Promise<WorkflowLeaseRef>)
		| (() => Promise<WorkflowLeaseRef>);
	readonly clock: WorkflowSchedulerClock;
	readonly maxConcurrentAttempts: number;
	readonly writerIdentity: string;
	readonly workerPartition?: Pick<WorkflowWorkerPartition, "controlCapacity" | "resourceVector"> & {
		readonly enforcementClass?: WorkflowWorkerPartition["enforcementClass"];
	};
	readonly controlPartition?: {
		capacity: WorkflowControlCapacityVector;
		resourceVector: WorkflowResourceVector;
	};
	readonly controlPlaneReserve?: WorkflowResourceVector;
	readonly resourceEnvelope?: WorkflowResourceEnvelope;
	readonly readResourceEnvelope?: () => Promise<WorkflowResourceEnvelope | null>;
	readonly taskInventory?: WorkflowSchedulerInventory;
	readonly adaptiveState?: WorkflowAdaptiveAllocationState | null;
	readonly readAdaptiveState?: () => Promise<WorkflowAdaptiveAllocationState | null>;
	/** Resolve committed adaptive state with certificates bound to this workflow and epoch. */
	readonly resolveAuthenticatedAdaptiveState?: (
		workflowId: string,
		epochRef: WorkflowEpochRef,
	) => Promise<WorkflowAdaptiveAllocationState | null>;
	readonly policyRevision?: WorkflowPolicyRevision | null;
	readonly readPolicyRevision?: () => Promise<WorkflowPolicyRevision | null>;
	readonly currentPolicyRevision?: number;
	readonly policyWeights?: WorkflowSchedulerPolicyWeights;
	readonly readTaskValue?: (task: WorkflowTask) => WorkflowSchedulerTaskValue | null;
	/** Verify the durable host receipt for provider capacity at dispatch time. */
	readonly verifyCloudCapacityReceipt?: (input: {
		workflowId: string;
		epochRef: WorkflowEpochRef;
		task: WorkflowTask;
		envelope: WorkflowResourceEnvelope;
		canonicalEnvelope: WorkflowResourceEnvelope | undefined;
		trustedNow: string;
	}) => Promise<void>;
	readonly store?: WorkflowRuntimeStore;
	readonly epochs?: unknown;
	readonly inventory?: unknown;
	readonly revisionRegistry?: unknown;
	readonly readRevisionBoundaryContext?: WorkflowRevisionBoundaryReader["readRevisionBoundaryContext"];
	/** Resolve the host-committed, immutable recipe admission artifact. */
	readonly resolveRecipeAdmissionArtifact?: (input: {
		workflowId: string;
		epochRef: WorkflowEpochRef;
		task: WorkflowTask;
	}) => Promise<WorkflowRecipeAdmissionArtifact | null>;
	/** Resolve role bindings independently of immutable skill snapshot bytes. */
	readonly resolveRecipeSkillBindings?: (input: {
		workflowId: string;
		epochRef: WorkflowEpochRef;
		task: WorkflowTask;
		admission: WorkflowRecipeAdmissionArtifact;
	}) => Promise<readonly WorkflowRecipeSuperpowersSkillBinding[] | null>;
	/** Read the current host journal head used to bind a one-use recipe admission. */
	readonly readCurrentRecipeHostHeadDigest?: (
		workflowId: string,
		epochRef: WorkflowEpochRef,
	) => Promise<string | null>;
	/** Consume the canonical recipe and skill receipts inside the guarded dispatch transaction. */
	readonly consumeRecipeAdmission?: (admission: WorkflowRecipeAdmissionArtifact) => void | Promise<void>;
	/** Verify the signed, durably consumed recipe registration receipt at the dispatch head. */
	readonly verifyRecipeAdmissionReceipt?: WorkflowSchedulerRecipeAdmissionReceiptVerifier;
	/** Resolve the host authority used to cryptographically verify the immutable registration preimage. */
	readonly resolveRecipeAdmissionHost?: WorkflowSchedulerRecipeAdmissionHostResolver;
	/**
	 * Host transaction which acquires and cancels the complete lease set together.
	 * The scheduler cannot safely compose resource and ownership leases itself.
	 */
	readonly leaseTransaction?: WorkflowSchedulerLeaseTransaction;
	readonly durableAdmissionTransaction?: WorkflowSchedulerDurableAdmissionTransaction;
}

export interface WorkflowSchedulerRecipeAdmissionReceiptVerificationInput {
	readonly admission: WorkflowRecipeAdmissionArtifact;
	readonly task: WorkflowTask;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly expectedHead: WorkflowJournalHead;
	readonly requiredSkillSnapshotDigests: readonly string[];
	readonly skillBindings: readonly WorkflowRecipeSuperpowersSkillBinding[];
}

export type WorkflowSchedulerRecipeAdmissionReceiptVerifier = (
	input: WorkflowSchedulerRecipeAdmissionReceiptVerificationInput,
) => Promise<void>;

export interface WorkflowSchedulerRecipeAdmissionHostResolutionInput {
	readonly admission: WorkflowRecipeAdmissionArtifact;
	readonly task: WorkflowTask;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly expectedHead: WorkflowJournalHead;
}

export type WorkflowSchedulerRecipeAdmissionHostResolver = (
	input: WorkflowSchedulerRecipeAdmissionHostResolutionInput,
) => Promise<WorkflowRecipeHostResolutionPort | null>;

export interface WorkflowSchedulerLeaseTransaction {
	acquire(
		resource: WorkflowLeaseRequest,
		ownership: WorkflowOwnershipLeaseRequest | null,
	): Promise<{ resourceLease: WorkflowResourceLease; ownershipLease: WorkflowOwnershipLease | null }>;
	releasePreDispatch(input: {
		workflowId: string;
		taskId: string;
		attemptId: string;
		epochRef: WorkflowEpochRef;
		resourceLease: WorkflowResourceLease;
		ownershipLease: WorkflowOwnershipLease | null;
	}): Promise<void>;
}

/**
 * Host-owned durable admission seam for runtime-backed scheduler instances.
 *
 * The host must perform one CAS over queue/head/epoch/capacity/admission and
 * persist the dispatch intent with both lease references before returning.
 */
export interface WorkflowSchedulerDurableAdmissionTransaction {
	commit(input: {
		workflowId: string;
		epochRef: WorkflowEpochRef;
		taskId: string;
		attemptId: string;
		executionKey: string;
		expectedStateDigest: string | null;
		expectedHeadDigest: string;
		expectedJournalHeadDigest?: string;
		expectedQueueHeadDigest?: string;
		previousState?: WorkflowSchedulerState;
		nextState?: WorkflowSchedulerState;
		resource: WorkflowLeaseRequest;
		ownership: WorkflowOwnershipLeaseRequest | null;
		recipeAdmission: WorkflowRecipeAdmissionArtifact;
		admissionDigest: string;
		recipeId: string;
		recipeRevision: number;
		requiredSkillSnapshotDigests: readonly string[];
		skillBindings: readonly WorkflowRecipeSuperpowersSkillBinding[];
		/** Consume the host-issued one-use recipe/skill receipt after queue CAS while the guard is held. */
		consumeRecipeAdmission?: () => void | Promise<void>;
	}): Promise<{ resourceLease: WorkflowResourceLease; ownershipLease: WorkflowOwnershipLease | null }>;
	rollback(input: {
		workflowId: string;
		taskId: string;
		epochRef: WorkflowEpochRef;
		attemptId: string;
		executionKey: string;
		resourceLease: WorkflowResourceLease;
		ownershipLease: WorkflowOwnershipLease | null;
		previousState?: WorkflowSchedulerState;
		committedState?: WorkflowSchedulerState;
	}): Promise<void>;
}

export interface WorkflowSchedulerDurableAdmissionTransactionDependencies {
	readonly store: WorkflowRuntimeStore;
	readonly leases: WorkflowLeaseManager;
	readonly queueState: WorkflowSchedulerStateStore;
	readonly createAdmissionContext: (
		resourceLease: WorkflowResourceLease,
		ownershipLease: WorkflowOwnershipLease | null,
		input: WorkflowSchedulerDurableAdmissionTransactionInput,
	) => WorkflowInternalAdmissionContext;
	/** Resolve the host-owned graph used to rebind the admission to this exact task. */
	readonly readTaskGraph?: () => WorkflowTaskGraph;
	readonly readCurrentEpoch?: (workflowId: string) => Promise<WorkflowEpochRef>;
	/** Verify the signed, durably consumed recipe registration receipt at the dispatch head. */
	readonly verifyRecipeAdmissionReceipt?: WorkflowSchedulerRecipeAdmissionReceiptVerifier;
	/** Resolve the host authority used to cryptographically verify the immutable registration preimage. */
	readonly resolveRecipeAdmissionHost?: WorkflowSchedulerRecipeAdmissionHostResolver;
}

export interface WorkflowSchedulerDurableAdmissionTransactionInput {
	workflowId: string;
	epochRef: WorkflowEpochRef;
	taskId: string;
	attemptId: string;
	executionKey: string;
	expectedStateDigest: string | null;
	expectedHeadDigest: string;
	expectedJournalHeadDigest?: string;
	expectedQueueHeadDigest?: string;
	previousState?: WorkflowSchedulerState;
	nextState?: WorkflowSchedulerState;
	resource: WorkflowLeaseRequest;
	ownership: WorkflowOwnershipLeaseRequest | null;
	recipeAdmission: WorkflowRecipeAdmissionArtifact;
	admissionDigest: string;
	recipeId: string;
	recipeRevision: number;
	requiredSkillSnapshotDigests: readonly string[];
	skillBindings: readonly WorkflowRecipeSuperpowersSkillBinding[];
	/** Consume the host-issued one-use recipe/skill receipt after queue CAS while the guard is held. */
	consumeRecipeAdmission?: () => void | Promise<void>;
}

interface WorkflowDispatchRecoveryMarker {
	version: 1;
	markerDigest: string;
	status: "prepared" | "leases_acquired" | "queue_committed" | "committed" | "rolled_back";
	workflowId: string;
	taskId: string;
	epochRef: WorkflowEpochRef;
	attemptId: string;
	executionKey: string;
	expectedStateDigest: string | null;
	expectedJournalHead: WorkflowJournalHead;
	expectedJournalHeadDigest: string;
	expectedQueueHeadDigest: string;
	recipeAdmissionDigest: string;
	recipeId: string;
	recipeRevision: number;
	requiredSkillSnapshotDigests: readonly string[];
	skillBindings: readonly WorkflowRecipeSuperpowersSkillBinding[];
	previousState: WorkflowSchedulerState;
	nextState: WorkflowSchedulerState;
	resourceLease: WorkflowResourceLease | null;
	ownershipLease: WorkflowOwnershipLease | null;
	ownerProcessIdentity?: string;
}

const WORKFLOW_DISPATCH_RECOVERY_MARKER = "workflow-dispatch-recovery";
const DISPATCH_MARKER_WAIT_TIMEOUT_MILLISECONDS = 30_000;
const DISPATCH_MARKER_WAIT_INTERVAL_MILLISECONDS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDispatchTransactionStates(input: WorkflowSchedulerDurableAdmissionTransactionInput): {
	previousState: WorkflowSchedulerState;
	nextState: WorkflowSchedulerState;
} {
	if (input.previousState === undefined || input.nextState === undefined)
		throw new WorkflowSchedulerError("workflow_scheduler_queue_transition_required");
	if (
		input.previousState.workflowId !== input.workflowId ||
		input.nextState.workflowId !== input.workflowId ||
		!sameEpoch(input.previousState.epochRef, input.epochRef) ||
		!sameEpoch(input.nextState.epochRef, input.epochRef)
	)
		throw new WorkflowSchedulerError("workflow_scheduler_queue_epoch_mismatch");
	const queued = input.previousState.entries.find((entry) => entry.input.attemptId === input.attemptId);
	if (
		queued === undefined ||
		queued.input.workflowId !== input.workflowId ||
		queued.input.taskId !== input.taskId ||
		queued.input.executionKey !== input.executionKey ||
		input.previousState.activeAttemptIds.includes(input.attemptId) ||
		input.previousState.terminalAttemptIds?.includes(input.attemptId) === true
	)
		throw new WorkflowSchedulerError("workflow_scheduler_queue_transition_invalid");
	const expectedEntries = input.previousState.entries.map((entry) =>
		entry.input.attemptId === input.attemptId ? { ...entry, blockedBy: [] } : entry,
	);
	if (
		digestObject(input.nextState.entries) !== digestObject(expectedEntries) ||
		digestObject(input.nextState.activeAttemptIds) !==
			digestObject([...input.previousState.activeAttemptIds, input.attemptId]) ||
		digestObject(input.nextState.terminalAttemptIds ?? []) !==
			digestObject(input.previousState.terminalAttemptIds ?? []) ||
		input.nextState.pausedReason !== input.previousState.pausedReason ||
		(input.nextState.lastEventSequence ?? 0) !== (input.previousState.lastEventSequence ?? 0)
	)
		throw new WorkflowSchedulerError("workflow_scheduler_queue_transition_invalid");
	return { previousState: input.previousState, nextState: input.nextState };
}

async function assertRecipeAdmissionBinding(
	input: WorkflowSchedulerDurableAdmissionTransactionInput,
	expectedHead: WorkflowJournalHead,
	graph: WorkflowTaskGraph | undefined,
	resolveHost: WorkflowSchedulerRecipeAdmissionHostResolver | undefined,
): Promise<{ task: WorkflowTask; host: WorkflowRecipeHostResolutionPort }> {
	const admission = input.recipeAdmission;
	try {
		validateWorkflowRecipeAdmission(admission);
	} catch {
		throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_invalid");
	}
	if (admission.registrationReceipt === undefined || admission.registrationReceiptProof === undefined)
		throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_receipt_required");
	if (graph === undefined) throw new WorkflowSchedulerError("workflow_scheduler_recipe_task_binding_required");
	const task = graph.byId.get(input.taskId);
	if (task === undefined) throw new WorkflowSchedulerError("workflow_scheduler_recipe_task_binding_invalid");
	try {
		verifyWorkflowRecipeAdmissionForTask({
			admission,
			task,
			graph,
			epochRef: input.epochRef,
			workflowId: input.workflowId,
			currentHostHeadDigest: digestObject(expectedHead),
		});
	} catch {
		throw new WorkflowSchedulerError("workflow_scheduler_recipe_task_binding_invalid");
	}
	if (resolveHost === undefined)
		throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_host_resolver_required");
	let host: WorkflowRecipeHostResolutionPort | null;
	try {
		host = await resolveHost({
			admission,
			task,
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			expectedHead,
		});
	} catch {
		throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_receipt_invalid");
	}
	if (host === null) throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_receipt_invalid");
	if (typeof host.context.authenticatedReceiptResolver.consumeAdmissionAtHost !== "function")
		throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_authority_required");
	const queued = input.previousState?.entries.find((entry) => entry.input.attemptId === input.attemptId);
	if (
		queued === undefined ||
		queued.recipeId !== admission.recipeId ||
		queued.recipeRevision !== admission.revision ||
		queued.recipeAdmissionDigest !== admission.admissionDigest
	)
		throw new WorkflowSchedulerError("workflow_scheduler_recipe_queue_binding_invalid");
	if (
		!isRecord(admission) ||
		!Array.isArray(admission.superpowersSkillSnapshots) ||
		!Array.isArray(admission.skillSnapshotDigests) ||
		!Array.isArray(admission.taskBindings) ||
		!Array.isArray(input.requiredSkillSnapshotDigests) ||
		!Array.isArray(input.skillBindings) ||
		!admission.superpowersSkillSnapshots.every(isRecord) ||
		!input.skillBindings.every(isRecord)
	)
		throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_invalid");
	const { admissionDigest, ...withoutDigest } = admission;
	const snapshots = new Map(
		admission.superpowersSkillSnapshots.map((snapshot) => [snapshot.snapshotDigest, snapshot.skillId]),
	);
	if (
		admission.kind !== "workflow_recipe_admission" ||
		admission.workflowId !== input.workflowId ||
		admissionDigest !== input.admissionDigest ||
		admissionDigest !== digestObject(withoutDigest) ||
		admission.recipeId !== input.recipeId ||
		admission.revision !== input.recipeRevision ||
		digestObject(admission.hostEpochRef) !== digestObject(input.epochRef) ||
		admission.hostHeadDigest !== digestObject(expectedHead) ||
		digestObject(admission.skillSnapshotDigests) !== digestObject(input.requiredSkillSnapshotDigests) ||
		input.skillBindings.length !== input.requiredSkillSnapshotDigests.length ||
		new Set(input.skillBindings.map((binding) => binding.snapshotDigest)).size !== input.skillBindings.length ||
		input.skillBindings.some((binding) => {
			const candidate = binding as unknown as {
				authority?: unknown;
				snapshotDigest?: unknown;
				skillId?: unknown;
			};
			return (
				!Array.isArray(candidate.authority) ||
				candidate.authority.length !== 0 ||
				typeof candidate.snapshotDigest !== "string" ||
				!input.requiredSkillSnapshotDigests.includes(candidate.snapshotDigest) ||
				snapshots.get(candidate.snapshotDigest) !== candidate.skillId
			);
		})
	)
		throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_invalid");
	return { task, host };
}

function markerFromBytes(bytes: Uint8Array): WorkflowDispatchRecoveryMarker {
	let parsed: unknown;
	try {
		parsed = parseCanonicalJsonBytes(bytes);
	} catch {
		throw new WorkflowSchedulerError("workflow_scheduler_recovery_marker_invalid");
	}
	if (
		!isRecord(parsed) ||
		parsed.version !== 1 ||
		typeof parsed.markerDigest !== "string" ||
		typeof parsed.workflowId !== "string" ||
		typeof parsed.taskId !== "string" ||
		typeof parsed.attemptId !== "string" ||
		typeof parsed.executionKey !== "string" ||
		!isRecord(parsed.epochRef) ||
		!isRecord(parsed.previousState) ||
		!isRecord(parsed.nextState) ||
		!Object.hasOwn(parsed, "resourceLease") ||
		!Object.hasOwn(parsed, "ownershipLease") ||
		!Object.hasOwn(parsed, "expectedStateDigest") ||
		!isRecord(parsed.expectedJournalHead) ||
		typeof parsed.expectedJournalHead.workflowId !== "string" ||
		!Number.isSafeInteger(parsed.expectedJournalHead.sequence) ||
		(parsed.expectedJournalHead.sequence as number) < 0 ||
		(parsed.expectedJournalHead.eventDigest !== null && typeof parsed.expectedJournalHead.eventDigest !== "string") ||
		!isRecord(parsed.expectedJournalHead.epochRef) ||
		typeof parsed.expectedJournalHeadDigest !== "string" ||
		typeof parsed.expectedQueueHeadDigest !== "string" ||
		typeof parsed.recipeAdmissionDigest !== "string" ||
		typeof parsed.recipeId !== "string" ||
		!Number.isSafeInteger(parsed.recipeRevision) ||
		(parsed.recipeRevision as number) <= 0 ||
		!Array.isArray(parsed.requiredSkillSnapshotDigests) ||
		!(parsed.requiredSkillSnapshotDigests as unknown[]).every((digest) => typeof digest === "string") ||
		!isCanonicalRecipeSkillBindingArray(parsed.skillBindings) ||
		(parsed.status !== "prepared" &&
			parsed.status !== "leases_acquired" &&
			parsed.status !== "queue_committed" &&
			parsed.status !== "committed" &&
			parsed.status !== "rolled_back")
	)
		throw new WorkflowSchedulerError("workflow_scheduler_recovery_marker_invalid");
	if (Object.hasOwn(parsed, "ownerProcessIdentity") && typeof parsed.ownerProcessIdentity !== "string")
		throw new WorkflowSchedulerError("workflow_scheduler_recovery_marker_invalid");
	const { markerDigest, ...withoutDigest } = parsed;
	if (typeof markerDigest !== "string" || markerDigest !== digestObject(withoutDigest))
		throw new WorkflowSchedulerError("workflow_scheduler_recovery_marker_invalid");
	return parsed as unknown as WorkflowDispatchRecoveryMarker;
}

function processIdentityIsLive(identity: string): boolean {
	const match = /^process:(\d+):(.+)$/u.exec(identity);
	if (match === null) return false;
	const pid = Number(match[1]);
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return identity === createLocalAppendLeaseProcessIdentity();
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	const processStartId = getProcessStartId(pid);
	return processStartId === undefined ? match[2].startsWith("runtime:") : processStartId === match[2];
}

function markerOwnerIsLive(marker: WorkflowDispatchRecoveryMarker): boolean {
	return marker.ownerProcessIdentity !== undefined && processIdentityIsLive(marker.ownerProcessIdentity);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

async function waitForDispatchCompletion(
	durable: WorkflowRuntimeStoreDurableContext,
	workflowId: string,
	epochRef: WorkflowEpochRef,
): Promise<void> {
	const deadline = Date.now() + DISPATCH_MARKER_WAIT_TIMEOUT_MILLISECONDS;
	while (true) {
		const bytes = await durable.auxiliaryStore.read(WORKFLOW_DISPATCH_RECOVERY_MARKER);
		if (bytes === null) return;
		const marker = markerFromBytes(bytes);
		if (
			marker.workflowId !== workflowId ||
			!sameEpoch(marker.epochRef, epochRef) ||
			marker.status === "committed" ||
			marker.status === "rolled_back" ||
			!markerOwnerIsLive(marker)
		)
			return;
		if (Date.now() >= deadline) throw new WorkflowSchedulerError("workflow_scheduler_dispatch_wait_timeout");
		await new Promise<void>((resolve) => setTimeout(resolve, DISPATCH_MARKER_WAIT_INTERVAL_MILLISECONDS));
	}
}

function recoveryRetryAttemptId(marker: WorkflowDispatchRecoveryMarker, occupiedAttemptIds: readonly string[]): string {
	const match = /^(.*):retry:(\d+)$/u.exec(marker.attemptId);
	const baseAttemptId = match?.[1] ?? marker.attemptId;
	let retryNumber = match === null ? 1 : Number(match[2]) + 1;
	if (!Number.isSafeInteger(retryNumber) || retryNumber <= 0)
		throw new WorkflowSchedulerError("workflow_scheduler_recovery_binding_invalid");
	let candidate = `${baseAttemptId}:retry:${retryNumber}`;
	const occupied = new Set(occupiedAttemptIds);
	while (occupied.has(candidate)) {
		retryNumber += 1;
		if (!Number.isSafeInteger(retryNumber))
			throw new WorkflowSchedulerError("workflow_scheduler_recovery_binding_invalid");
		candidate = `${baseAttemptId}:retry:${retryNumber}`;
	}
	return candidate;
}

function rebindRecoveryInput(input: WorkflowCanonicalDispatchInput, attemptId: string): WorkflowCanonicalDispatchInput {
	try {
		const executionKey = deriveWorkflowExecutionKey({ ...input, attemptId });
		return { ...input, attemptId, executionKey };
	} catch {
		throw new WorkflowSchedulerError("workflow_scheduler_recovery_binding_invalid");
	}
}

function recoveryQueueStates(marker: WorkflowDispatchRecoveryMarker): {
	readonly previousState: WorkflowSchedulerState;
	readonly nextState: WorkflowSchedulerState;
} {
	const queued = marker.previousState.entries.find((entry) => entry.input.attemptId === marker.attemptId);
	if (queued === undefined) throw new WorkflowSchedulerError("workflow_scheduler_recovery_binding_invalid");
	const occupiedAttemptIds = [
		...marker.previousState.entries.map((entry) => entry.input.attemptId),
		...(marker.previousState.terminalAttemptIds ?? []),
	];
	const attemptId = recoveryRetryAttemptId(marker, occupiedAttemptIds);
	const input = rebindRecoveryInput(queued.input, attemptId);
	const rebindEntries = (state: WorkflowSchedulerState): readonly WorkflowSchedulerQueueEntry[] =>
		state.entries.map((entry) => (entry.input.attemptId === marker.attemptId ? { ...entry, input } : entry));
	return {
		previousState: {
			...marker.previousState,
			entries: rebindEntries(marker.previousState),
			activeAttemptIds: marker.previousState.activeAttemptIds.map((value) =>
				value === marker.attemptId ? attemptId : value,
			),
			...(marker.previousState.terminalAttemptIds === undefined
				? {}
				: {
						terminalAttemptIds: marker.previousState.terminalAttemptIds.map((value) =>
							value === marker.attemptId ? attemptId : value,
						),
					}),
		},
		nextState: {
			...marker.nextState,
			entries: rebindEntries(marker.nextState),
			activeAttemptIds: marker.nextState.activeAttemptIds.map((value) =>
				value === marker.attemptId ? attemptId : value,
			),
			...(marker.nextState.terminalAttemptIds === undefined
				? {}
				: {
						terminalAttemptIds: marker.nextState.terminalAttemptIds.map((value) =>
							value === marker.attemptId ? attemptId : value,
						),
					}),
		},
	};
}

/**
 * Compose the durable scheduler admission boundary over the authenticated store and lease manager.
 *
 * Args:
 * dependencies: Durable queue, lease, and admission-context authorities.
 * Return: A cross-process transaction that recovers an interrupted dispatch before admitting another one.
 */
export function createWorkflowSchedulerDurableAdmissionTransaction(
	dependencies: WorkflowSchedulerDurableAdmissionTransactionDependencies,
): WorkflowSchedulerDurableAdmissionTransaction {
	const durable = dependencies.store.durableContext;
	if (durable === undefined) throw new WorkflowSchedulerError("workflow_scheduler_durable_state_required");
	const reserveDispatch = dependencies.leases.reserveDispatch;
	if (reserveDispatch === undefined)
		throw new WorkflowSchedulerError("workflow_scheduler_dispatch_reservation_required");
	if (dependencies.leases.releasePreDispatch === undefined)
		throw new WorkflowSchedulerError("workflow_scheduler_dispatch_rollback_required");
	const releasePreDispatch = dependencies.leases.releasePreDispatch;

	const writeMarker = async (marker: WorkflowDispatchRecoveryMarker): Promise<void> => {
		const { markerDigest: _markerDigest, ...withoutDigest } = marker;
		await durable.auxiliaryStore.write(
			WORKFLOW_DISPATCH_RECOVERY_MARKER,
			canonicalJsonBytes({ ...withoutDigest, markerDigest: digestObject(withoutDigest) }),
		);
	};

	const rollbackQueueState = async (marker: WorkflowDispatchRecoveryMarker, idempotencyKey: string): Promise<void> => {
		if (dependencies.queueState.compareAndSwap === undefined)
			throw new WorkflowSchedulerError("workflow_scheduler_durable_state_transaction_required");
		const current = await dependencies.queueState.read(marker.workflowId, marker.epochRef);
		if (current === null) {
			if (marker.expectedStateDigest === null) return;
			throw new WorkflowSchedulerError("workflow_scheduler_state_conflict");
		}
		const currentDigest = digestObject(current);
		const previousDigest = digestObject(marker.previousState);
		if (currentDigest === previousDigest) {
			return;
		}
		const currentEntry = current.entries.find((entry) => entry.input.attemptId === marker.attemptId);
		if (
			currentEntry !== undefined &&
			currentEntry.input.taskId === marker.taskId &&
			currentEntry.input.executionKey === marker.executionKey &&
			!current.activeAttemptIds.includes(marker.attemptId)
		) {
			return;
		}
		if (currentDigest !== digestObject(marker.nextState))
			throw new WorkflowSchedulerError("workflow_scheduler_state_conflict");
		const status = await dependencies.queueState.compareAndSwap({
			workflowId: marker.workflowId,
			epochRef: marker.epochRef,
			expectedStateDigest: currentDigest,
			nextState: marker.previousState,
			idempotencyKey: `${idempotencyKey}:rollback`,
		});
		if (status === "conflict") throw new WorkflowSchedulerError("workflow_scheduler_state_conflict");
	};

	const leaseAcquiredAfter = (
		lease: WorkflowResourceLease | WorkflowOwnershipLease,
		marker: WorkflowDispatchRecoveryMarker,
	): boolean =>
		lease.workflowId === marker.workflowId &&
		lease.attemptId === marker.attemptId &&
		lease.storeEpoch === marker.epochRef.storeEpoch &&
		lease.coordinatorEpoch === marker.epochRef.coordinatorEpoch &&
		lease.acquisitionEventSequence > marker.expectedJournalHead.sequence;

	const leasesFromReplay = (
		marker: WorkflowDispatchRecoveryMarker,
		replay: Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>,
	): {
		resourceLease: WorkflowResourceLease | null;
		ownershipLease: WorkflowOwnershipLease | null;
		releaseResourceLease: boolean;
		releaseOwnershipLease: boolean;
	} => {
		let resourceLease = marker.resourceLease;
		let ownershipLease = marker.ownershipLease;
		for (const event of replay.events) {
			if (
				event.sequence <= marker.expectedJournalHead.sequence ||
				event.executionKey !== marker.executionKey ||
				!sameEpoch(event.epochRef, marker.epochRef)
			)
				continue;
			if (event.payload.kind === "workflow_resource_lease_acquired") {
				if (
					event.payload.lease.attemptId === marker.attemptId &&
					event.payload.lease.taskId === marker.taskId &&
					leaseAcquiredAfter(event.payload.lease, marker)
				)
					resourceLease ??= event.payload.lease;
				continue;
			}
			if (event.payload.kind === "workflow_ownership_lease_acquired") {
				if (
					event.payload.lease.attemptId === marker.attemptId &&
					event.payload.lease.taskId === marker.taskId &&
					leaseAcquiredAfter(event.payload.lease, marker)
				)
					ownershipLease ??= event.payload.lease;
			}
		}
		return {
			resourceLease,
			ownershipLease,
			releaseResourceLease: resourceLease !== null && leaseAcquiredAfter(resourceLease, marker),
			releaseOwnershipLease: ownershipLease !== null && leaseAcquiredAfter(ownershipLease, marker),
		};
	};

	const assertRecoveredIntent = async (
		marker: WorkflowDispatchRecoveryMarker,
		replay: Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>,
	): Promise<void> => {
		const current = await dependencies.queueState.read(marker.workflowId, marker.epochRef);
		if (current === null || digestObject(current) !== digestObject(marker.nextState))
			throw new WorkflowSchedulerError("workflow_scheduler_recovery_state_conflict");
		const queued = marker.nextState.entries.find((entry) => entry.input.attemptId === marker.attemptId);
		if (
			queued === undefined ||
			queued.recipeId !== marker.recipeId ||
			queued.recipeRevision !== marker.recipeRevision ||
			queued.recipeAdmissionDigest !== marker.recipeAdmissionDigest
		)
			throw new WorkflowSchedulerError("workflow_scheduler_recovery_binding_invalid");
		const intents = replay.events.filter(
			(event) =>
				event.payload.kind === "workflow_dispatch_intent" &&
				event.payload.workflowId === marker.workflowId &&
				event.payload.taskId === marker.taskId &&
				event.payload.attemptId === marker.attemptId &&
				event.payload.executionKey === marker.executionKey &&
				sameEpoch(event.payload.epochRef, marker.epochRef),
		);
		if (intents.length !== 1) throw new WorkflowSchedulerError("workflow_scheduler_recovery_intent_invalid");
		const intent = intents[0];
		const preceding =
			intent === undefined ? undefined : replay.events.find((event) => event.sequence === intent.sequence - 1);
		const expectedIntentHead =
			preceding === undefined
				? {
						workflowId: marker.workflowId,
						sequence: 0,
						eventDigest: null,
						epochRef: marker.epochRef,
					}
				: {
						workflowId: marker.workflowId,
						sequence: preceding.sequence,
						eventDigest: preceding.eventDigest,
						epochRef: marker.epochRef,
					};
		if (
			intent === undefined ||
			intent.payload.kind !== "workflow_dispatch_intent" ||
			intent.payload.admissionId !== `admission:${marker.executionKey}` ||
			intent.sequence !== intent.expectedHead.sequence + 1 ||
			intent.expectedHead.sequence <= marker.expectedJournalHead.sequence ||
			digestObject(intent.expectedHead) !== digestObject(expectedIntentHead) ||
			!sameEpoch(intent.expectedHead.epochRef, marker.epochRef) ||
			intent.priorEventDigest !== intent.expectedHead.eventDigest ||
			intent.payloadDigest !== digestObject(intent.payload) ||
			intent.writerIdentity.length === 0 ||
			!isRecord(intent.leaseRef) ||
			intent.leaseRef.writerIdentity !== intent.writerIdentity ||
			!sameEpoch(intent.leaseRef, marker.epochRef) ||
			marker.resourceLease === null ||
			digestObject(intent.payload.resourceLeaseRef) !== digestObject(leaseRefOf(marker.resourceLease)) ||
			(marker.ownershipLease !== null &&
				intent.payload.ownershipLeaseRef?.leaseId !== marker.ownershipLease.leaseId) ||
			(marker.ownershipLease === null && intent.payload.ownershipLeaseRef !== null)
		)
			throw new WorkflowSchedulerError("workflow_scheduler_recovery_intent_invalid");
	};

	const recover = async (input: WorkflowSchedulerDurableAdmissionTransactionInput): Promise<boolean> => {
		const bytes = await durable.auxiliaryStore.read(WORKFLOW_DISPATCH_RECOVERY_MARKER);
		if (bytes === null) return false;
		const marker = markerFromBytes(bytes);
		if (marker.workflowId !== dependencies.store.identity.workflowId) return false;
		if (marker.status === "committed" || marker.status === "rolled_back") {
			if (
				marker.workflowId === input.workflowId &&
				marker.taskId === input.taskId &&
				marker.attemptId === input.attemptId &&
				marker.executionKey === input.executionKey
			)
				throw new WorkflowSchedulerError("workflow_scheduler_recovery_requeued");
			return false;
		}
		if (markerOwnerIsLive(marker)) throw new WorkflowSchedulerError("workflow_scheduler_dispatch_in_progress");
		if (
			marker.workflowId !== input.workflowId ||
			marker.taskId !== input.taskId ||
			marker.attemptId !== input.attemptId ||
			marker.executionKey !== input.executionKey
		)
			throw new WorkflowSchedulerError("workflow_scheduler_recovery_binding_invalid");
		const claimedMarker: WorkflowDispatchRecoveryMarker = {
			...marker,
			ownerProcessIdentity: createLocalAppendLeaseProcessIdentity(),
		};
		await writeMarker(claimedMarker);
		const markerForRecovery = claimedMarker;
		const replay = await dependencies.store.replay({
			workflowId: markerForRecovery.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: markerForRecovery.epochRef.storeEpoch,
		});
		const intentCommitted = replay.events.some(
			(event) =>
				event.payload.kind === "workflow_dispatch_intent" &&
				event.payload.workflowId === markerForRecovery.workflowId &&
				event.payload.taskId === markerForRecovery.taskId &&
				event.payload.attemptId === markerForRecovery.attemptId &&
				event.payload.executionKey === markerForRecovery.executionKey &&
				sameEpoch(event.payload.epochRef, markerForRecovery.epochRef),
		);
		if (intentCommitted) {
			await assertRecoveredIntent(markerForRecovery, replay);
			await writeMarker({ ...markerForRecovery, status: "committed" });
			return false;
		}
		const retryStates = recoveryQueueStates(markerForRecovery);
		const currentQueue = await dependencies.queueState.read(markerForRecovery.workflowId, markerForRecovery.epochRef);
		const retryPreviousDigest = digestObject(retryStates.previousState);
		if (currentQueue === null || digestObject(currentQueue) !== retryPreviousDigest) {
			if (currentQueue !== null && digestObject(currentQueue) !== digestObject(markerForRecovery.previousState))
				await rollbackQueueState(markerForRecovery, `workflow-dispatch-recovery:${markerForRecovery.attemptId}`);
		}
		await dependencies.leases.hydrateFromReplay();
		const leases = leasesFromReplay(markerForRecovery, replay);
		if (leases.releaseOwnershipLease && leases.resourceLease === null)
			throw new WorkflowSchedulerError("workflow_scheduler_recovery_lease_pair_invalid");
		if (leases.resourceLease !== null && (leases.releaseResourceLease || leases.releaseOwnershipLease))
			await releasePreDispatch({
				workflowId: markerForRecovery.workflowId,
				taskId: markerForRecovery.taskId,
				attemptId: markerForRecovery.attemptId,
				executionKey: markerForRecovery.executionKey,
				epochRef: markerForRecovery.epochRef,
				resourceLease: leases.resourceLease,
				ownershipLease: leases.releaseOwnershipLease ? leases.ownershipLease : null,
				releaseResourceLease: leases.releaseResourceLease,
				reason: "workflow_dispatch_recovery_rollback",
			});
		const rolledBack = await dependencies.queueState.read(markerForRecovery.workflowId, markerForRecovery.epochRef);
		if (rolledBack === null) throw new WorkflowSchedulerError("workflow_scheduler_recovery_state_conflict");
		if (digestObject(rolledBack) === digestObject(markerForRecovery.previousState)) {
			const status = await dependencies.queueState.compareAndSwap!({
				workflowId: markerForRecovery.workflowId,
				epochRef: markerForRecovery.epochRef,
				expectedStateDigest: digestObject(markerForRecovery.previousState),
				nextState: retryStates.previousState,
				idempotencyKey: `workflow-dispatch-recovery:${markerForRecovery.attemptId}:retry`,
			});
			if (status === "conflict") throw new WorkflowSchedulerError("workflow_scheduler_recovery_state_conflict");
		} else if (digestObject(rolledBack) !== retryPreviousDigest) {
			throw new WorkflowSchedulerError("workflow_scheduler_recovery_state_conflict");
		}
		await writeMarker({ ...markerForRecovery, status: "rolled_back" });
		return true;
	};

	const commit = async (
		input: WorkflowSchedulerDurableAdmissionTransactionInput,
	): Promise<{ resourceLease: WorkflowResourceLease; ownershipLease: WorkflowOwnershipLease | null }> => {
		const { previousState, nextState } = assertDispatchTransactionStates(input);
		const recoveryMarkerBytes = await durable.auxiliaryStore.read(WORKFLOW_DISPATCH_RECOVERY_MARKER);
		if (recoveryMarkerBytes !== null) {
			const recoveryMarker = markerFromBytes(recoveryMarkerBytes);
			if (
				recoveryMarker.workflowId === input.workflowId &&
				sameEpoch(recoveryMarker.epochRef, input.epochRef) &&
				recoveryMarker.status !== "committed" &&
				recoveryMarker.status !== "rolled_back" &&
				markerOwnerIsLive(recoveryMarker)
			)
				throw new WorkflowSchedulerError("workflow_scheduler_dispatch_in_progress");
		}
		let recoveryChangedHead: boolean;
		try {
			recoveryChangedHead = await durable.withExclusiveLease("workflow-dispatch-recovery", async () =>
				recover(input),
			);
		} catch (error) {
			if (!hasErrorCode(error, "workflow_append_lease_guard_timeout")) throw error;
			const recoveryBytes = await durable.auxiliaryStore.read(WORKFLOW_DISPATCH_RECOVERY_MARKER);
			if (recoveryBytes !== null) {
				const observedMarker = markerFromBytes(recoveryBytes);
				if (observedMarker.workflowId === input.workflowId && sameEpoch(observedMarker.epochRef, input.epochRef)) {
					if (observedMarker.status === "committed" || observedMarker.status === "rolled_back")
						throw new WorkflowSchedulerError("workflow_scheduler_recovery_requeued");
					if (markerOwnerIsLive(observedMarker))
						throw new WorkflowSchedulerError("workflow_scheduler_dispatch_in_progress");
				}
			}
			throw new WorkflowSchedulerError("workflow_scheduler_recovery_blocked");
		}
		if (recoveryChangedHead) throw new WorkflowSchedulerError("workflow_scheduler_recovery_requeued");
		const prepared = await durable.withExclusiveLease("workflow-dispatch-transaction-prepare", async () => {
			const existingMarkerBytes = await durable.auxiliaryStore.read(WORKFLOW_DISPATCH_RECOVERY_MARKER);
			if (existingMarkerBytes !== null) {
				const existingMarker = markerFromBytes(existingMarkerBytes);
				if (
					existingMarker.workflowId === input.workflowId &&
					sameEpoch(existingMarker.epochRef, input.epochRef) &&
					existingMarker.status !== "committed" &&
					existingMarker.status !== "rolled_back"
				) {
					if (markerOwnerIsLive(existingMarker))
						throw new WorkflowSchedulerError("workflow_scheduler_dispatch_in_progress");
					throw new WorkflowSchedulerError("workflow_scheduler_recovery_requeued");
				}
			}
			const replay = await dependencies.store.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.epochRef.storeEpoch,
			});
			const expectedJournalHeadDigest = input.expectedJournalHeadDigest ?? input.expectedHeadDigest;
			if (replay.quarantined || digestObject(replay.head) !== expectedJournalHeadDigest)
				throw new WorkflowSchedulerError("workflow_scheduler_head_stale");
			const recipeBinding = await assertRecipeAdmissionBinding(
				input,
				replay.head,
				dependencies.readTaskGraph?.(),
				dependencies.resolveRecipeAdmissionHost,
			);
			if (input.consumeRecipeAdmission === undefined)
				throw new WorkflowSchedulerError("workflow_scheduler_recipe_consumer_required");
			const admissionHeadDigest = expectedJournalHeadDigest;
			if (dependencies.readCurrentEpoch !== undefined) {
				const currentEpoch = await dependencies.readCurrentEpoch(input.workflowId);
				if (!sameEpoch(currentEpoch, input.epochRef))
					throw new WorkflowSchedulerError("workflow_scheduler_epoch_mismatch");
			}
			const persisted = await dependencies.queueState.read(input.workflowId, input.epochRef);
			if (
				persisted === null ||
				input.expectedStateDigest === null ||
				digestObject(persisted) !== input.expectedStateDigest ||
				digestObject(persisted) !== digestObject(previousState) ||
				(input.expectedQueueHeadDigest !== undefined &&
					queueEntryHeadDigest(persisted) !== input.expectedQueueHeadDigest)
			)
				throw new WorkflowSchedulerError("workflow_scheduler_state_conflict");
			const markerBase: WorkflowDispatchRecoveryMarker = {
				version: 1,
				markerDigest: "",
				status: "prepared",
				workflowId: input.workflowId,
				taskId: input.taskId,
				epochRef: input.epochRef,
				attemptId: input.attemptId,
				executionKey: input.executionKey,
				expectedStateDigest: input.expectedStateDigest,
				expectedJournalHead: replay.head,
				expectedJournalHeadDigest: admissionHeadDigest,
				expectedQueueHeadDigest: input.expectedQueueHeadDigest ?? queueEntryHeadDigest(previousState),
				recipeAdmissionDigest: input.admissionDigest,
				recipeId: input.recipeId,
				recipeRevision: input.recipeRevision,
				requiredSkillSnapshotDigests: input.requiredSkillSnapshotDigests,
				skillBindings: input.skillBindings,
				previousState,
				nextState,
				resourceLease: null,
				ownershipLease: null,
				ownerProcessIdentity: createLocalAppendLeaseProcessIdentity(),
			};
			const consumeRecipeAdmission = async (): Promise<void> => {
				let completion: Promise<void> | undefined;
				try {
					await consumeWorkflowRecipeAdmissionAtHost({
						admission: input.recipeAdmission,
						host: recipeBinding.host,
						consumer: {
							consumeWorkflowRecipeAdmission: () => {
								completion = Promise.resolve(input.consumeRecipeAdmission!());
							},
						},
					});
					if (completion !== undefined) await completion;
				} catch {
					throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_receipt_invalid");
				}
			};
			await writeMarker(markerBase);
			return { admissionHeadDigest, consumeRecipeAdmission, marker: markerBase, replay };
		});
		let marker = prepared.marker;
		let reservation: WorkflowLeaseDispatchReservation;
		try {
			reservation = await reserveDispatch({
				workflowId: input.workflowId,
				epochRef: input.epochRef,
				resource: input.resource,
				ownership: input.ownership,
				expectedHead: prepared.replay.head,
				expectedHeadDigest: prepared.admissionHeadDigest,
				createAdmissionContext: (resourceLease, ownershipLease) =>
					dependencies.createAdmissionContext(resourceLease, ownershipLease, input),
				commitQueueState: async () => {
					if (dependencies.queueState.compareAndSwap === undefined)
						throw new WorkflowSchedulerError("workflow_scheduler_durable_state_transaction_required");
					const current = await dependencies.queueState.read(input.workflowId, input.epochRef);
					if (current === null || digestObject(current) !== input.expectedStateDigest)
						throw new WorkflowSchedulerError("workflow_scheduler_state_conflict");
					const status = await dependencies.queueState.compareAndSwap({
						workflowId: input.workflowId,
						epochRef: input.epochRef,
						expectedStateDigest: input.expectedStateDigest,
						nextState,
						idempotencyKey: `workflow-dispatch-state:${input.executionKey}`,
					});
					if (status === "conflict") throw new WorkflowSchedulerError("workflow_scheduler_state_conflict");
				},
				rollbackQueueState: async () => rollbackQueueState(marker, `workflow-dispatch:${input.executionKey}`),
				onLeasesAcquired: async (resourceLease, ownershipLease) => {
					marker = { ...marker, status: "leases_acquired", resourceLease, ownershipLease };
					await writeMarker(marker);
				},
				onQueueCommitted: async () => {
					marker = { ...marker, status: "queue_committed" };
					await writeMarker(marker);
				},
				consumeRecipeAdmission: prepared.consumeRecipeAdmission,
			});
		} catch (error) {
			await durable.withExclusiveLease("workflow-dispatch-transaction-finalize", async () => {
				await writeMarker({ ...marker, status: "rolled_back" });
			});
			throw error;
		}
		await durable.withExclusiveLease("workflow-dispatch-transaction-finalize", async () => {
			await writeMarker({ ...marker, status: "committed" });
		});
		return reservation;
	};

	return {
		commit,
		rollback: async (input) =>
			durable.withExclusiveLease("workflow-dispatch-rollback", async () => {
				if (input.previousState !== undefined && input.committedState !== undefined) {
					await rollbackQueueState(
						{
							version: 1,
							markerDigest: "",
							status: "queue_committed",
							workflowId: input.workflowId,
							taskId: input.taskId,
							epochRef: input.epochRef,
							attemptId: input.attemptId,
							executionKey: input.executionKey,
							expectedStateDigest: digestObject(input.previousState),
							expectedJournalHead: {
								workflowId: input.workflowId,
								sequence: 0,
								eventDigest: null,
								epochRef: input.epochRef,
							},
							expectedJournalHeadDigest: "",
							expectedQueueHeadDigest: queueEntryHeadDigest(input.previousState),
							recipeAdmissionDigest: "",
							recipeId: "",
							recipeRevision: 0,
							requiredSkillSnapshotDigests: [],
							skillBindings: [],
							previousState: input.previousState,
							nextState: input.committedState,
							resourceLease: input.resourceLease,
							ownershipLease: input.ownershipLease,
						},
						`workflow-dispatch-rollback:${input.executionKey}`,
					);
				}
				if (dependencies.leases.releasePreDispatch !== undefined)
					await releasePreDispatch({
						workflowId: input.workflowId,
						taskId: input.taskId,
						attemptId: input.attemptId,
						executionKey: input.executionKey,
						epochRef: input.epochRef,
						resourceLease: input.resourceLease,
						ownershipLease: input.ownershipLease,
						reason: "workflow_dispatch_dispatch_failed",
					});
				const markerBytes = await durable.auxiliaryStore.read(WORKFLOW_DISPATCH_RECOVERY_MARKER);
				if (markerBytes !== null) {
					const marker = markerFromBytes(markerBytes);
					if (
						marker.workflowId === input.workflowId &&
						marker.attemptId === input.attemptId &&
						marker.executionKey === input.executionKey &&
						marker.status !== "committed" &&
						marker.status !== "rolled_back"
					) {
						await writeMarker({ ...marker, status: "rolled_back" });
					}
				}
			}),
	};
}

export interface WorkflowScheduler {
	enqueue(input: WorkflowCanonicalDispatchInput, queuedAt: string): Promise<void>;
	onEvent(event: WorkflowSchedulerEvent): Promise<readonly WorkflowDispatchResult[]>;
	refill(workflowId: string, epochRef: WorkflowEpochRef): Promise<readonly WorkflowDispatchResult[]>;
	observe(workflowId: string): Promise<readonly WorkflowQueueObservation[]>;
	pause(workflowId: string, reason: string, approval?: WorkflowApprovalResponse): Promise<void>;
	resume(workflowId: string, approval: WorkflowApprovalResponse | WorkflowSchedulerResumeApproval): Promise<void>;
}

export interface WorkflowSchedulerResumeApproval {
	decisionRef: string;
	approvalReceipt: string;
}

export interface WorkflowQueueObservation {
	taskId: string;
	attemptId: string;
	enqueuedAt: string;
	ageMs: number;
	priority: number;
	required: WorkflowResourceVector;
	blockedBy: readonly WorkflowDispatchBlockingReason[];
}

export class WorkflowSchedulerError extends Error {
	readonly code: string;

	public constructor(code: string) {
		super(code);
		this.name = "WorkflowSchedulerError";
		this.code = code;
	}
}

const CONTROL_CAPACITY_FIELDS: readonly (keyof WorkflowControlCapacityVector)[] = [
	"processSlots",
	"childSessionSlots",
	"modelCallSlots",
	"modelInputTokens",
	"modelOutputTokens",
	"verificationSlots",
	"redTeamSlots",
	"recoverySlots",
];

const RESOURCE_FIELDS: readonly (keyof Omit<WorkflowResourceVector, "accelerators" | "providers">)[] = [
	"cpuMilliCores",
	"memoryBytes",
	"diskBytes",
	"ioWeight",
	"networkEgressBytes",
	"wallMilliseconds",
	"monetaryMicrounits",
];

const BLOCKED: WorkflowDispatchBlockingReason = "protocol_review_required";

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function finite(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function controlCapacity(
	value: Partial<WorkflowControlCapacityVector> | undefined = undefined,
): WorkflowControlCapacityVector {
	const result = {} as WorkflowControlCapacityVector;
	for (const field of CONTROL_CAPACITY_FIELDS) {
		const candidate = value?.[field];
		result[field] = typeof candidate === "number" && finite(candidate) ? candidate : 0;
	}
	return result;
}

function resourceVector(value: Partial<WorkflowResourceVector> | undefined): WorkflowResourceVector {
	const result = {
		cpuMilliCores: 0,
		memoryBytes: 0,
		diskBytes: 0,
		ioWeight: 0,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 0,
		monetaryMicrounits: 0,
	} satisfies WorkflowResourceVector;
	for (const field of RESOURCE_FIELDS) {
		const candidate = value?.[field];
		if (typeof candidate === "number" && finite(candidate)) result[field] = candidate;
	}
	return {
		...result,
		accelerators: value?.accelerators ?? [],
		providers: value?.providers ?? [],
	};
}

function isBoundArtifactRef(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		artifactId?: unknown;
		relativePath?: unknown;
		digest?: unknown;
		sizeBytes?: unknown;
		sourceEventSequence?: unknown;
	};
	return (
		typeof candidate.artifactId === "string" &&
		candidate.artifactId.length > 0 &&
		typeof candidate.relativePath === "string" &&
		candidate.relativePath.length > 0 &&
		candidate.relativePath.charCodeAt(0) !== 47 &&
		!candidate.relativePath.includes("\\") &&
		!candidate.relativePath.includes("\u0000") &&
		!candidate.relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..") &&
		typeof candidate.digest === "string" &&
		candidate.digest.length > 0 &&
		Number.isSafeInteger(candidate.sizeBytes) &&
		(candidate.sizeBytes as number) >= 0 &&
		Number.isSafeInteger(candidate.sourceEventSequence) &&
		(candidate.sourceEventSequence as number) >= 0
	);
}

function isBoundAdaptiveLease(value: unknown, epochRef: WorkflowEpochRef): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<WorkflowLeaseRef>;
	return (
		sameEpoch(candidate as WorkflowEpochRef, epochRef) &&
		typeof candidate.leaseId === "string" &&
		candidate.leaseId.length > 0 &&
		typeof candidate.rootDigest === "string" &&
		candidate.rootDigest.length > 0
	);
}

function isBoundAdaptiveAllocationEntry(
	value: unknown,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	policyDigest: string,
	acceptedObservationDigest: string,
): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		taskId?: unknown;
		attemptId?: unknown;
		allocationDigest?: unknown;
		slotState?: unknown;
		attemptClass?: unknown;
		reason?: unknown;
		sourceObservationDigest?: unknown;
		resourceLeaseRef?: unknown;
		ownershipLeaseRef?: unknown;
		taskValueCertificate?: unknown;
	};
	const certificate = candidate.taskValueCertificate as {
		workflowId?: unknown;
		taskId?: unknown;
		attemptId?: unknown;
		independentAdmissionStatus?: unknown;
		valuePolicyDigest?: unknown;
		acceptedDagRef?: unknown;
		independentAdmissionRef?: unknown;
		certificateDigest?: unknown;
		boundedOutcomeEvidence?: { taskId?: unknown };
		independentAuditReceipt?: { workflowId?: unknown; receiptKind?: unknown; bindingDigest?: unknown };
		evidenceGapRequirementIds?: unknown;
	} | null;
	return (
		typeof candidate.taskId === "string" &&
		candidate.taskId.length > 0 &&
		typeof candidate.attemptId === "string" &&
		candidate.attemptId.length > 0 &&
		typeof candidate.allocationDigest === "string" &&
		candidate.allocationDigest.length > 0 &&
		(candidate.slotState === "unclaimed" || candidate.slotState === "claimed" || candidate.slotState === "active") &&
		(candidate.attemptClass === "implementation" ||
			candidate.attemptClass === "recon" ||
			candidate.attemptClass === "lens" ||
			candidate.attemptClass === "verification" ||
			candidate.attemptClass === "red_team" ||
			candidate.attemptClass === "recovery") &&
		typeof candidate.reason === "string" &&
		candidate.reason.length > 0 &&
		candidate.sourceObservationDigest === acceptedObservationDigest &&
		isBoundAdaptiveLease(candidate.resourceLeaseRef, epochRef) &&
		isBoundAdaptiveLease(candidate.ownershipLeaseRef, epochRef) &&
		certificate !== undefined &&
		certificate !== null &&
		certificate.workflowId === workflowId &&
		certificate.taskId === candidate.taskId &&
		certificate.attemptId === candidate.attemptId &&
		certificate.independentAdmissionStatus === "accepted" &&
		certificate.valuePolicyDigest === policyDigest &&
		isBoundArtifactRef(certificate.acceptedDagRef) &&
		isBoundArtifactRef(certificate.independentAdmissionRef) &&
		Array.isArray(certificate.evidenceGapRequirementIds) &&
		certificate.evidenceGapRequirementIds.every((requirementId) => typeof requirementId === "string") &&
		typeof certificate.boundedOutcomeEvidence === "object" &&
		certificate.boundedOutcomeEvidence !== null &&
		certificate.boundedOutcomeEvidence.taskId === candidate.taskId &&
		typeof certificate.certificateDigest === "string" &&
		certificate.certificateDigest.length > 0 &&
		certificate.independentAuditReceipt?.workflowId === workflowId &&
		certificate.independentAuditReceipt.receiptKind === "adjudication" &&
		typeof certificate.independentAuditReceipt.bindingDigest === "string" &&
		certificate.independentAuditReceipt.bindingDigest.length > 0
	);
}

function isBoundAdaptiveState(
	state: WorkflowAdaptiveAllocationState,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	currentPolicyRevision: number | undefined,
): boolean {
	return (
		typeof state === "object" &&
		state !== null &&
		state.workflowId === workflowId &&
		typeof state.currentEpoch === "object" &&
		state.currentEpoch !== null &&
		sameEpoch(state.currentEpoch, epochRef) &&
		Number.isSafeInteger(state.revision) &&
		state.revision > 0 &&
		Number.isSafeInteger(state.policyRevision) &&
		state.policyRevision > 0 &&
		(currentPolicyRevision === undefined || state.policyRevision === currentPolicyRevision) &&
		Number.isSafeInteger(state.sourceJournalSequence) &&
		state.sourceJournalSequence > 0 &&
		typeof state.sourceJournalDigest === "string" &&
		state.sourceJournalDigest.length > 0 &&
		typeof state.stateDigest === "string" &&
		state.stateDigest.length > 0 &&
		typeof state.allocationDigest === "string" &&
		state.allocationDigest.length > 0 &&
		typeof state.policyDigest === "string" &&
		state.policyDigest.length > 0 &&
		typeof state.criticalPathProofDigest === "string" &&
		state.criticalPathProofDigest.length > 0 &&
		isBoundArtifactRef(state.acceptedObservation) &&
		isBoundArtifactRef(state.criticalPathCertificateRef) &&
		Array.isArray(state.allocationEntries) &&
		Array.isArray(state.criticalPathTaskIds) &&
		Array.isArray(state.readyQueue) &&
		Array.isArray(state.runningQueue) &&
		typeof state.marginalVerifiedProgressByResource === "object" &&
		state.marginalVerifiedProgressByResource !== null &&
		Object.values(state.marginalVerifiedProgressByResource).every((value) => boundedSignal(value) === value) &&
		typeof state.uncertainty === "object" &&
		state.uncertainty !== null &&
		Object.values(state.uncertainty).every((value) => boundedSignal(value) === value) &&
		state.criticalPathTaskIds.every((taskId) => typeof taskId === "string" && taskId.length > 0) &&
		new Set(state.criticalPathTaskIds).size === state.criticalPathTaskIds.length &&
		state.allocationEntries.every((entry) =>
			isBoundAdaptiveAllocationEntry(
				entry,
				workflowId,
				epochRef,
				state.policyDigest,
				state.acceptedObservation.digest,
			),
		)
	);
}

function subtractResource(left: WorkflowResourceVector, right: WorkflowResourceVector): WorkflowResourceVector {
	const rightAccelerators = new Map(right.accelerators.map((item) => [item.poolId, item]));
	const rightProviders = new Map(right.providers.map((item) => [item.poolId, item]));
	return {
		cpuMilliCores: Math.max(0, left.cpuMilliCores - right.cpuMilliCores),
		memoryBytes: Math.max(0, left.memoryBytes - right.memoryBytes),
		diskBytes: Math.max(0, left.diskBytes - right.diskBytes),
		ioWeight: Math.max(0, left.ioWeight - right.ioWeight),
		accelerators: left.accelerators.map((pool) => {
			const used = rightAccelerators.get(pool.poolId);
			return used === undefined
				? pool
				: {
						...pool,
						count: Math.max(0, pool.count - used.count),
						memoryBytes: Math.max(0, pool.memoryBytes - used.memoryBytes),
					};
		}),
		providers: left.providers.map((pool) => {
			const used = rightProviders.get(pool.poolId);
			return used === undefined
				? pool
				: {
						...pool,
						concurrentRequests: Math.max(0, pool.concurrentRequests - used.concurrentRequests),
						requestsPerMinute: Math.max(0, pool.requestsPerMinute - used.requestsPerMinute),
						totalRequests: Math.max(0, pool.totalRequests - used.totalRequests),
						inputTokens: Math.max(0, pool.inputTokens - used.inputTokens),
						outputTokens: Math.max(0, pool.outputTokens - used.outputTokens),
					};
		}),
		networkEgressBytes: Math.max(0, left.networkEgressBytes - right.networkEgressBytes),
		wallMilliseconds: Math.max(0, left.wallMilliseconds - right.wallMilliseconds),
		monetaryMicrounits: Math.max(0, left.monetaryMicrounits - right.monetaryMicrounits),
	};
}

function fitsControl(required: WorkflowControlCapacityVector, available: WorkflowControlCapacityVector): boolean {
	return CONTROL_CAPACITY_FIELDS.every((field) => required[field] <= available[field]);
}

function fitsScalar(required: WorkflowResourceVector, available: WorkflowResourceVector): boolean {
	return RESOURCE_FIELDS.every((field) => required[field] <= available[field]);
}

function providerRank(idempotency: "none" | "host_reconciled" | "provider_native"): number {
	return idempotency === "provider_native" ? 2 : idempotency === "host_reconciled" ? 1 : 0;
}

function fitsPools(required: WorkflowResourceVector, available: WorkflowResourceVector): boolean {
	return (
		required.accelerators.every((needed) => {
			const pool = available.accelerators.find((candidate) => candidate.poolId === needed.poolId);
			return (
				pool !== undefined &&
				pool.count >= needed.count &&
				pool.memoryBytes >= needed.memoryBytes &&
				pool.deviceType === needed.deviceType
			);
		}) &&
		required.providers.every((needed) => {
			const pool = available.providers.find((candidate) => candidate.poolId === needed.poolId);
			return (
				pool !== undefined &&
				pool.concurrentRequests >= needed.concurrentRequests &&
				pool.requestsPerMinute >= needed.requestsPerMinute &&
				pool.totalRequests >= needed.totalRequests &&
				pool.inputTokens >= needed.inputTokens &&
				pool.outputTokens >= needed.outputTokens &&
				providerRank(pool.idempotency) >= providerRank(needed.idempotency)
			);
		})
	);
}

function taskPriority(task: WorkflowTask): number {
	return Number.isFinite(task.planRevision) ? task.planRevision : 0;
}

function clampWeight(value: number | undefined, baseline: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(-4, Math.min(4, value)) : baseline;
}

function boundedSignal(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0;
}

function taskUsesPool(task: WorkflowTask, pool: WorkflowAdaptiveAllocationState["limitingPool"]): boolean {
	switch (pool) {
		case "cpu":
			return task.declaredResourceVector.cpuMilliCores > 0;
		case "memory":
			return task.declaredResourceVector.memoryBytes > 0;
		case "disk":
			return task.declaredResourceVector.diskBytes > 0;
		case "io":
			return task.declaredResourceVector.ioWeight > 0;
		case "accelerator":
			return task.declaredResourceVector.accelerators.length > 0;
		case "provider":
			return task.declaredResourceVector.providers.length > 0;
		case "network":
			return task.declaredResourceVector.networkEgressBytes > 0;
		case "wall_time":
			return task.declaredResourceVector.wallMilliseconds > 0;
		case "monetary":
			return task.declaredResourceVector.monetaryMicrounits > 0;
		case "control_plane":
			return CONTROL_CAPACITY_FIELDS.some((field) => task.declaredControlCapacity[field] > 0);
		default:
			return false;
	}
}

function reserveControlCapacity(
	left: Partial<WorkflowControlCapacityVector> | undefined,
	right: Partial<WorkflowControlCapacityVector> | undefined,
): WorkflowControlCapacityVector {
	const result = {} as WorkflowControlCapacityVector;
	const leftCapacity = controlCapacity(left);
	const rightCapacity = controlCapacity(right);
	for (const field of CONTROL_CAPACITY_FIELDS) {
		result[field] = Math.max(leftCapacity[field], rightCapacity[field]);
	}
	return result;
}

function cloudCapacityApproved(
	workflowId: string,
	epochRef: WorkflowEpochRef,
	task: WorkflowTask,
	envelope: WorkflowResourceEnvelope | null,
	canonicalEnvelope: WorkflowResourceEnvelope | undefined,
	now: string,
): boolean {
	const receipt = envelope?.capacityReceipt;
	if (envelope === null || receipt === null || receipt === undefined) return false;
	if (canonicalEnvelope !== undefined && digestObject(canonicalEnvelope) !== digestObject(envelope)) return false;
	const receiptRefs = [
		receipt.capacityArtifactRef,
		receipt.pricingArtifactRef,
		receipt.credentialArtifactRef,
		receipt.quotaArtifactRef,
		receipt.rateLimitArtifactRef,
		receipt.billingArtifactRef,
		receipt.egressArtifactRef,
		receipt.terminationArtifactRef,
		receipt.responseArtifactRef,
	];
	if (
		!receiptRefs.every((ref) => isBoundArtifactRef(ref) && ref.sizeBytes > 0) ||
		typeof receipt.trustedClockReceipt !== "object" ||
		receipt.trustedClockReceipt === null ||
		typeof receipt.responseReceipt !== "object" ||
		receipt.responseReceipt === null ||
		typeof receipt.finalEnvelopeDecisionRef !== "object" ||
		receipt.finalEnvelopeDecisionRef === null ||
		typeof receipt.finalEnvelopeDecisionRef.decisionScope !== "object" ||
		receipt.finalEnvelopeDecisionRef.decisionScope === null ||
		typeof receipt.requestDigest !== "string" ||
		receipt.requestDigest.length === 0
	)
		return false;
	if (
		receipt.workflowId !== workflowId ||
		receipt.finalEnvelopeDigest !== envelope.envelopeDigest ||
		digestObject({
			...envelope,
			capacityReceipt: { ...receipt, finalEnvelopeDigest: "", receiptDigest: "" },
			envelopeDigest: "",
		}) !== envelope.envelopeDigest ||
		digestObject(receipt.finalEnvelopeDecisionRef) !== digestObject(envelope.approvalDecisionRef) ||
		receipt.finalEnvelopeDecisionRef.storeEpoch !== epochRef.storeEpoch ||
		receipt.finalEnvelopeDecisionRef.coordinatorEpoch !== epochRef.coordinatorEpoch ||
		receipt.finalEnvelopeDecisionRef.decisionScope.kind !== "workflow" ||
		receipt.finalEnvelopeDecisionRef.decisionScope.workflowId !== workflowId ||
		receipt.trustedClockReceipt.receiptKind !== "clock" ||
		receipt.trustedClockReceipt.workflowId !== workflowId ||
		receipt.trustedClockReceipt.bindingDigest !== receipt.requestDigest ||
		receipt.trustedClockReceipt.issuedAt !== receipt.observedAt ||
		receipt.responseReceipt.workflowId !== workflowId ||
		receipt.responseReceipt.payloadDigest !== receipt.responseArtifactRef.digest ||
		receipt.receiptDigest !== digestObject({ ...receipt, receiptDigest: "" })
	)
		return false;
	if (!fitsScalar(task.declaredResourceVector, resourceVector(receipt.capacityVector))) return false;
	if (!fitsPools(task.declaredResourceVector, resourceVector(receipt.capacityVector))) return false;
	const validUntil = Date.parse(receipt.validUntil);
	const observedAt = Date.parse(receipt.observedAt);
	const nowMs = Date.parse(now);
	return (
		Number.isFinite(validUntil) &&
		Number.isFinite(observedAt) &&
		Number.isFinite(nowMs) &&
		observedAt <= nowMs &&
		validUntil > nowMs
	);
}

function capacityWindowApproved(envelope: WorkflowResourceEnvelope | null, now: string): boolean {
	if (envelope === null) return true;
	const hasFrom = typeof envelope.validFrom === "string";
	const hasUntil = typeof envelope.validUntil === "string";
	if (!hasFrom && !hasUntil) return true;
	if (!hasFrom || !hasUntil) return false;
	const validFrom = Date.parse(envelope.validFrom);
	const validUntil = Date.parse(envelope.validUntil);
	const nowMs = Date.parse(now);
	return (
		Number.isFinite(validFrom) &&
		Number.isFinite(validUntil) &&
		Number.isFinite(nowMs) &&
		validFrom <= nowMs &&
		nowMs < validUntil
	);
}

function isApprovedPolicy(
	policy: WorkflowPolicyRevision | null,
	workflowId: string,
	currentRevision: number | undefined,
): policy is WorkflowPolicyRevision {
	return (
		policy !== null &&
		policy.status === "approved" &&
		(policy.workflowId === null || policy.workflowId === workflowId) &&
		Number.isSafeInteger(policy.revision) &&
		policy.revision > 0 &&
		(currentRevision === undefined || currentRevision === policy.revision)
	);
}

function ageMilliseconds(now: string, queuedAt: string): number {
	const difference = Date.parse(now) - Date.parse(queuedAt);
	return Number.isFinite(difference) ? Math.max(0, difference) : 0;
}

function codePointCompare(left: string, right: string): number {
	const leftPoints = Array.from(left);
	const rightPoints = Array.from(right);
	const length = Math.min(leftPoints.length, rightPoints.length);
	for (let index = 0; index < length; index += 1) {
		const difference = leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!;
		if (difference !== 0) return difference;
	}
	return leftPoints.length - rightPoints.length;
}

function isReadOnlyPlanningRole(binding: WorkflowRecipeSuperpowersSkillBinding): boolean {
	return (
		binding.role === "planning" || binding.role === "design" || binding.role === "recon" || binding.role === "review"
	);
}

function isCanonicalRecipeSkillBinding(value: unknown): value is WorkflowRecipeSuperpowersSkillBinding {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Reflect.ownKeys(value);
	const allowed = new Set(["skillId", "snapshotDigest", "role", "gateId", "readOnly", "ownedPathKinds", "authority"]);
	if (keys.length !== allowed.size || keys.some((key) => typeof key !== "string" || !allowed.has(key))) return false;
	for (const key of keys) {
		if (typeof key !== "string") return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) return false;
	}
	const binding = value as WorkflowRecipeSuperpowersSkillBinding;
	if (
		typeof binding.skillId !== "string" ||
		typeof binding.snapshotDigest !== "string" ||
		typeof binding.role !== "string" ||
		typeof binding.gateId !== "string" ||
		typeof binding.readOnly !== "boolean" ||
		!Array.isArray(binding.ownedPathKinds) ||
		!Array.isArray(binding.authority) ||
		binding.authority.length !== 0
	)
		return false;
	for (const array of [binding.ownedPathKinds, binding.authority]) {
		for (let index = 0; index < array.length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
			if (
				!Object.hasOwn(array, index) ||
				descriptor?.enumerable !== true ||
				descriptor.get !== undefined ||
				descriptor.set !== undefined
			)
				return false;
		}
		if (
			Reflect.ownKeys(array).some(
				(key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)),
			)
		)
			return false;
	}
	return true;
}

function isCanonicalRecipeSkillBindingArray(value: unknown): value is readonly WorkflowRecipeSuperpowersSkillBinding[] {
	if (!Array.isArray(value)) return false;
	if (
		Reflect.ownKeys(value).some(
			(key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)),
		)
	)
		return false;
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (
			!Object.hasOwn(value, index) ||
			descriptor?.enumerable !== true ||
			descriptor.get !== undefined ||
			descriptor.set !== undefined
		)
			return false;
		if (!isCanonicalRecipeSkillBinding(value[index])) return false;
	}
	return true;
}

function recipeAdmissionMatchesTask(
	task: WorkflowTask,
	admission: WorkflowRecipeAdmissionArtifact,
	bindings: readonly WorkflowRecipeSuperpowersSkillBinding[],
	graph: WorkflowTaskGraph,
	epochRef: WorkflowEpochRef,
	workflowId: string,
	currentHostHeadDigest: string,
): boolean {
	try {
		verifyWorkflowRecipeAdmissionForTask({
			admission,
			task,
			graph,
			epochRef,
			workflowId,
			currentHostHeadDigest,
		});
	} catch {
		return false;
	}
	if (
		!Array.isArray(admission.skillSnapshotDigests) ||
		!Array.isArray(admission.superpowersSkillSnapshots) ||
		!Array.isArray(bindings)
	)
		return false;
	if (digestObject(admission.skillSnapshotDigests) !== digestObject(task.requiredSkillSnapshotDigests)) return false;
	if (
		digestObject(admission.superpowersSkillSnapshots.map((snapshot) => snapshot.snapshotDigest)) !==
		digestObject(admission.skillSnapshotDigests)
	)
		return false;
	if (admission.recipeId === WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID) {
		const gate = admission.intentTddGate;
		if (
			gate === undefined ||
			gate.gateId !== WORKFLOW_RECIPE_INTENT_TDD_GATE_ID ||
			gate.blocking !== true ||
			gate.hostOwned !== true ||
			!Array.isArray(gate.stageIds) ||
			gate.stageIds.length === 0 ||
			!Array.isArray(gate.evidenceKinds) ||
			gate.evidenceKinds.length === 0 ||
			!Array.isArray(gate.evidenceRequirements) ||
			gate.evidenceRequirements.length === 0 ||
			!Array.isArray(gate.promotionConstraints) ||
			gate.promotionConstraints.length === 0
		)
			return false;
	}
	const snapshotsByDigest = new Map(
		admission.superpowersSkillSnapshots.map((snapshot) => [snapshot.snapshotDigest, snapshot]),
	);
	if (bindings.length !== task.requiredSkillSnapshotDigests.length) return false;
	const seen = new Set<string>();
	for (const binding of bindings) {
		if (!isCanonicalRecipeSkillBinding(binding)) return false;
		const ownedPathKinds = binding.ownedPathKinds as readonly unknown[];
		const snapshot = snapshotsByDigest.get(binding.snapshotDigest);
		if (
			typeof binding.skillId !== "string" ||
			typeof binding.snapshotDigest !== "string" ||
			typeof binding.role !== "string" ||
			binding.role.length === 0 ||
			typeof binding.gateId !== "string" ||
			binding.gateId.length === 0 ||
			seen.has(binding.snapshotDigest) ||
			!task.requiredSkillSnapshotDigests.includes(binding.snapshotDigest) ||
			snapshot === undefined ||
			binding.skillId !== snapshot.skillId ||
			binding.authority.length !== 0 ||
			ownedPathKinds.some((kind: unknown) => kind !== "code" && kind !== "tests" && kind !== "artifacts")
		)
			return false;
		if (isReadOnlyPlanningRole(binding)) {
			if (!binding.readOnly || ownedPathKinds.some((kind: unknown) => kind !== "artifacts")) return false;
			if (task.ownedPaths.length > 0 || task.authority.includes("write_owned_paths")) return false;
		} else if (
			(binding.role === "implementation" || binding.role === "implementer") &&
			(binding.readOnly || !ownedPathKinds.some((kind: unknown) => kind === "code" || kind === "tests"))
		) {
			return false;
		} else if (binding.readOnly && ownedPathKinds.includes("code")) {
			return false;
		}
		seen.add(binding.snapshotDigest);
	}
	return seen.size === task.requiredSkillSnapshotDigests.length;
}

function sortRecipeSkillBindings(
	bindings: readonly WorkflowRecipeSuperpowersSkillBinding[],
): readonly WorkflowRecipeSuperpowersSkillBinding[] {
	const key = (value: unknown): string => (typeof value === "string" ? value : "");
	return [...bindings].sort((left, right) => {
		const skillDifference = codePointCompare(key(left.skillId), key(right.skillId));
		if (skillDifference !== 0) return skillDifference;
		const snapshotDifference = codePointCompare(key(left.snapshotDigest), key(right.snapshotDigest));
		if (snapshotDifference !== 0) return snapshotDifference;
		return codePointCompare(key(left.gateId), key(right.gateId));
	});
}

interface WorkflowSchedulerRecipeAdmissionContext {
	readonly artifact: WorkflowRecipeAdmissionArtifact;
	readonly admissionDigest: string;
	readonly bindings: readonly WorkflowRecipeSuperpowersSkillBinding[];
}

function queueEntryHeadDigest(state: WorkflowSchedulerState): string {
	const entries = [...state.entries].sort((left, right) => {
		if (left.queuedAt !== right.queuedAt) return codePointCompare(left.queuedAt, right.queuedAt);
		if (left.priority !== right.priority) return right.priority - left.priority;
		if (left.input.taskId !== right.input.taskId) return codePointCompare(left.input.taskId, right.input.taskId);
		return codePointCompare(left.input.attemptId, right.input.attemptId);
	});
	return digestObject({
		workflowId: state.workflowId,
		epochRef: state.epochRef,
		entries,
		activeAttemptIds: [...state.activeAttemptIds].sort(codePointCompare),
		terminalAttemptIds: [...(state.terminalAttemptIds ?? [])].sort(codePointCompare),
		pausedReason: state.pausedReason,
		lastEventSequence: state.lastEventSequence ?? 0,
	});
}

function validateSchedulerState(state: WorkflowSchedulerState): void {
	const terminalAttemptIds = state.terminalAttemptIds ?? [];
	if (
		terminalAttemptIds.some((attemptId) => typeof attemptId !== "string" || attemptId.length === 0) ||
		new Set(terminalAttemptIds).size !== terminalAttemptIds.length
	)
		throw new WorkflowSchedulerError("workflow_scheduler_terminal_state_invalid");
	const terminal = new Set(terminalAttemptIds);
	const queuedAttemptIds = new Set<string>();
	for (const entry of state.entries) {
		const attemptId = entry.input.attemptId;
		if (
			typeof attemptId !== "string" ||
			attemptId.length === 0 ||
			terminal.has(attemptId) ||
			queuedAttemptIds.has(attemptId)
		)
			throw new WorkflowSchedulerError("workflow_scheduler_queue_state_invalid");
		queuedAttemptIds.add(attemptId);
	}
	if (
		new Set(state.activeAttemptIds).size !== state.activeAttemptIds.length ||
		state.activeAttemptIds.some(
			(attemptId) => typeof attemptId !== "string" || terminal.has(attemptId) || !queuedAttemptIds.has(attemptId),
		)
	)
		throw new WorkflowSchedulerError("workflow_scheduler_active_state_invalid");
}

function queueBlock(input: WorkflowDispatchReadiness): readonly WorkflowDispatchBlockingReason[] {
	return input.blockingReasons.length > 0 ? input.blockingReasons : [BLOCKED];
}

function overlaps(left: WorkflowTask, right: WorkflowTask): boolean {
	return (
		left.ownedPaths.some((path) =>
			right.ownedPaths.some((candidate) => {
				const leftParts = path.split("/");
				const rightParts = candidate.split("/");
				const leftWithinRight = rightParts.every((part, index) => leftParts[index] === part);
				const rightWithinLeft = leftParts.every((part, index) => rightParts[index] === part);
				return leftWithinRight || rightWithinLeft;
			}),
		) || left.ownedContracts.some((contract) => right.ownedContracts.includes(contract))
	);
}

function currentTaskGraph(dependencies: WorkflowSchedulerDependencies): WorkflowTaskGraph {
	return dependencies.readGraph?.() ?? dependencies.graph;
}

function canonicalKey(input: WorkflowCanonicalDispatchInput): string | null {
	const candidate = input as Partial<WorkflowCanonicalDispatchInput>;
	if (
		candidate.decisionRef === undefined ||
		typeof candidate.decisionRef !== "object" ||
		candidate.decisionRef === null ||
		typeof candidate.decisionRef.decisionDigest !== "string" ||
		typeof candidate.launchConfigDigest !== "string"
	)
		return null;
	return deriveWorkflowExecutionKey(input);
}

function newState(input: WorkflowCanonicalDispatchInput, epochRef: WorkflowEpochRef): WorkflowSchedulerState {
	return {
		workflowId: input.workflowId,
		epochRef,
		entries: [],
		pausedReason: null,
		activeAttemptIds: [],
		terminalAttemptIds: [],
		lastEventSequence: 0,
	};
}

function approvalIdentifier(approval: WorkflowApprovalResponse | WorkflowSchedulerResumeApproval): string {
	if (typeof approval.decisionRef === "string") return approval.decisionRef;
	return approval.decisionRef.decisionDigest;
}

/**
 * Create the single durable scheduler projection over the existing graph, leases, admission, and dispatcher.
 *
 * Args:
 * dependencies: Existing runtime authorities used by scheduling decisions.
 * Return: Event-driven scheduler facade.
 */
export function createWorkflowScheduler(dependencies: WorkflowSchedulerDependencies): WorkflowScheduler {
	if (dependencies.durableAdmissionTransaction !== undefined && dependencies.store === undefined)
		throw new WorkflowSchedulerError("workflow_scheduler_durable_state_transaction_required");
	const workflowLocks = new Map<string, Promise<void>>();
	const withWorkflowLock = async <T>(workflowId: string, operation: () => Promise<T>): Promise<T> => {
		const previous = workflowLocks.get(workflowId) ?? Promise.resolve();
		let release: (() => void) | undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.catch(() => undefined).then(() => current);
		workflowLocks.set(workflowId, queued);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release?.();
			if (workflowLocks.get(workflowId) === queued) workflowLocks.delete(workflowId);
		}
	};
	const readCurrentEpoch = async (workflowId: string): Promise<WorkflowEpochRef> => {
		const reader = dependencies.readCurrentEpoch as (workflowId: string) => Promise<WorkflowEpochRef>;
		return reader(workflowId);
	};
	const readRootLeaseRef = async (workflowId: string, epochRef: WorkflowEpochRef): Promise<WorkflowLeaseRef> => {
		const reader = dependencies.readRootLeaseRef as (
			workflowId: string,
			epochRef: WorkflowEpochRef,
		) => Promise<WorkflowLeaseRef>;
		return reader(workflowId, epochRef);
	};
	const assertRevision = async (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		executionKey: string | null,
	): Promise<void> => {
		const hasReader = dependencies.readRevisionBoundaryContext !== undefined;
		const hasRegistry = dependencies.revisionRegistry !== undefined;
		if (!hasReader || !hasRegistry) throw new WorkflowSchedulerError("workflow_scheduler_revision_boundary_missing");
		await assertRevisionBoundary(
			{
				readRevisionBoundaryContext: dependencies.readRevisionBoundaryContext,
				revisionRegistry: dependencies.revisionRegistry as WorkflowRevisionBoundaryReader["revisionRegistry"],
			},
			workflowId,
			epochRef,
			executionKey,
		);
	};
	const readState = async (workflowId: string, epochRef: WorkflowEpochRef): Promise<WorkflowSchedulerState> => {
		const state = await dependencies.queueState.read(workflowId, epochRef);
		if (state === null) {
			const task = currentTaskGraph(dependencies).tasks[0];
			if (task === undefined) throw new WorkflowSchedulerError("workflow_scheduler_empty_graph");
			return newState({ workflowId, taskId: task.taskId } as WorkflowCanonicalDispatchInput, epochRef);
		}
		if (state.workflowId !== workflowId || !sameEpoch(state.epochRef, epochRef))
			throw new WorkflowSchedulerError("workflow_scheduler_state_epoch_mismatch");
		validateSchedulerState(state);
		return state;
	};

	const writeState = async (
		state: WorkflowSchedulerState,
		previousState: WorkflowSchedulerState = state,
	): Promise<void> => {
		validateSchedulerState(state);
		if (dependencies.store !== undefined) {
			if (dependencies.queueState.compareAndSwap === undefined)
				throw new WorkflowSchedulerError("workflow_scheduler_durable_state_transaction_required");
			const persisted = await dependencies.queueState.read(state.workflowId, state.epochRef);
			const status = await dependencies.queueState.compareAndSwap({
				workflowId: state.workflowId,
				epochRef: state.epochRef,
				expectedStateDigest: persisted === null ? null : digestObject(previousState),
				nextState: state,
				idempotencyKey: `workflow-scheduler-state:${state.workflowId}:${state.epochRef.storeEpoch}:${state.epochRef.coordinatorEpoch}:${digestObject(state)}`,
			});
			if (status === "conflict") throw new WorkflowSchedulerError("workflow_scheduler_state_conflict");
			return;
		}
		await dependencies.queueState.write({
			...state,
			entries: [...state.entries],
			activeAttemptIds: [...state.activeAttemptIds],
			terminalAttemptIds: [...(state.terminalAttemptIds ?? [])],
		});
	};

	const readEnvelope = async (): Promise<WorkflowResourceEnvelope | null> => {
		if (dependencies.readResourceEnvelope !== undefined) return dependencies.readResourceEnvelope();
		return dependencies.resourceEnvelope ?? null;
	};

	const runningTasks = async (workflowId: string, graph: WorkflowTaskGraph): Promise<readonly WorkflowTask[]> => {
		if (dependencies.taskInventory !== undefined) {
			const records = await dependencies.taskInventory.listRunning(workflowId, await readCurrentEpoch(workflowId));
			return records.flatMap((record) => {
				if (typeof record !== "object" || record === null) return [];
				const candidate = record as { taskId?: unknown; context?: { taskId?: unknown } };
				const taskId =
					typeof candidate.taskId === "string"
						? candidate.taskId
						: typeof candidate.context?.taskId === "string"
							? candidate.context.taskId
							: null;
				const task = taskId === null ? undefined : graph.byId.get(taskId);
				return task === undefined ? [] : [task];
			});
		}
		return graph.tasks.filter((task) => task.status === "admitted" || task.status === "running");
	};

	const resolvePolicy = async (workflowId: string): Promise<WorkflowPolicyRevision | null> => {
		const policy = dependencies.readPolicyRevision
			? await dependencies.readPolicyRevision()
			: (dependencies.policyRevision ?? null);
		return isApprovedPolicy(policy, workflowId, dependencies.currentPolicyRevision) ? policy : null;
	};

	const resolveAdaptiveState = async (workflowId: string): Promise<WorkflowAdaptiveAllocationState | null> => {
		const epochRef = await readCurrentEpoch(workflowId);
		if (durableAdmissionRequired && dependencies.resolveAuthenticatedAdaptiveState === undefined)
			throw new WorkflowSchedulerError("workflow_scheduler_adaptive_state_invalid");
		const state =
			dependencies.resolveAuthenticatedAdaptiveState === undefined
				? null
				: await dependencies.resolveAuthenticatedAdaptiveState(workflowId, epochRef);
		if (
			durableAdmissionRequired &&
			(state === null || !isBoundAdaptiveState(state, workflowId, epochRef, dependencies.currentPolicyRevision))
		)
			throw new WorkflowSchedulerError("workflow_scheduler_adaptive_state_invalid");
		if (state === null || !isBoundAdaptiveState(state, workflowId, epochRef, dependencies.currentPolicyRevision))
			return null;
		return state;
	};
	const durableAdmissionRequired =
		dependencies.store !== undefined || dependencies.durableAdmissionTransaction !== undefined;
	const resolveRecipeAdmission = async (
		entry: WorkflowSchedulerQueueEntry | null,
		task: WorkflowTask,
		input: WorkflowCanonicalDispatchInput,
		graph: WorkflowTaskGraph,
	): Promise<WorkflowSchedulerRecipeAdmissionContext | null | undefined> => {
		const required = durableAdmissionRequired || task.requiredSkillSnapshotDigests.length > 0;
		if (!required) return undefined;
		if (
			dependencies.resolveRecipeAdmissionArtifact === undefined ||
			dependencies.resolveRecipeSkillBindings === undefined
		)
			return null;
		const admission = await dependencies.resolveRecipeAdmissionArtifact({
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			task,
		});
		if (admission === null) return null;
		const bindings = await dependencies.resolveRecipeSkillBindings({
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			task,
			admission,
		});
		if (bindings === null || !isCanonicalRecipeSkillBindingArray(bindings)) return null;
		const canonicalBindings = sortRecipeSkillBindings(bindings);
		const currentHostHeadDigest =
			dependencies.readCurrentRecipeHostHeadDigest === undefined
				? null
				: await dependencies.readCurrentRecipeHostHeadDigest(input.workflowId, input.epochRef);
		if (currentHostHeadDigest === null) return null;
		if (
			!recipeAdmissionMatchesTask(
				task,
				admission,
				canonicalBindings,
				graph,
				input.epochRef,
				input.workflowId,
				currentHostHeadDigest,
			)
		)
			return null;
		if (dependencies.consumeRecipeAdmission === undefined) return null;
		if (
			entry !== null &&
			(entry.recipeId !== undefined ||
				entry.recipeRevision !== undefined ||
				entry.recipeAdmissionDigest !== undefined) &&
			(entry.recipeId !== admission.recipeId ||
				entry.recipeRevision !== admission.revision ||
				entry.recipeAdmissionDigest !== admission.admissionDigest)
		)
			return null;
		if (
			durableAdmissionRequired &&
			entry !== null &&
			(entry.recipeId === undefined ||
				entry.recipeRevision === undefined ||
				entry.recipeAdmissionDigest === undefined)
		)
			return null;
		return { artifact: admission, admissionDigest: admission.admissionDigest, bindings: canonicalBindings };
	};

	const sortEntries = async (
		entries: readonly WorkflowSchedulerQueueEntry[],
		workflowId: string,
	): Promise<readonly WorkflowSchedulerQueueEntry[]> => {
		const policy = await resolvePolicy(workflowId);
		const adaptiveState = await resolveAdaptiveState(workflowId);
		const now = dependencies.clock.now();
		const hysteresisActive =
			adaptiveState?.cooldownUntil !== null &&
			adaptiveState?.cooldownUntil !== undefined &&
			Date.parse(adaptiveState.cooldownUntil) > Date.parse(now);
		const weights = policy === null || hysteresisActive ? undefined : dependencies.policyWeights;
		const graph = currentTaskGraph(dependencies);
		const scored = entries.map((entry) => {
			const task = graph.byId.get(entry.input.taskId);
			const age = ageMilliseconds(now, entry.queuedAt);
			const fairnessPolicy = adaptiveState?.fairness?.policy;
			const agingQuantum =
				typeof fairnessPolicy?.agingQuantumMilliseconds === "number" &&
				Number.isFinite(fairnessPolicy.agingQuantumMilliseconds)
					? Math.max(1, Math.min(3_600_000, fairnessPolicy.agingQuantumMilliseconds))
					: 1_000;
			const starvationDeadline =
				typeof fairnessPolicy?.starvationDeadlineMilliseconds === "number" &&
				Number.isFinite(fairnessPolicy.starvationDeadlineMilliseconds)
					? Math.max(0, Math.min(86_400_000, fairnessPolicy.starvationDeadlineMilliseconds))
					: 0;
			const maxAgingBoost =
				typeof fairnessPolicy?.maxAgingBoost === "number" && Number.isFinite(fairnessPolicy.maxAgingBoost)
					? Math.max(0, Math.min(4, fairnessPolicy.maxAgingBoost))
					: 4;
			const agingBoost =
				age >= starvationDeadline ? Math.min(maxAgingBoost, Math.floor(age / Math.max(1, agingQuantum))) : 0;
			const base = clampWeight(weights?.priority, 1) * (entry.priority + agingBoost);
			const ageScore = clampWeight(weights?.age, 0.001) * age;
			const valueScore = 0;
			const adaptiveScore =
				hysteresisActive || task === undefined
					? 0
					: (() => {
							const criticalPathSignal = adaptiveState?.criticalPathTaskIds?.includes(task.taskId) ? 2 : 0;
							const limitingPoolSignal =
								adaptiveState?.limitingPool !== undefined && taskUsesPool(task, adaptiveState.limitingPool)
									? 1
									: 0;
							const allocationSignal =
								adaptiveState?.allocationEntries?.some(
									(entryValue) =>
										entryValue.taskId === task.taskId && entryValue.reason === adaptiveState.limitingPool,
								) === true
									? 1
									: 0;
							const uncertaintySignal = boundedSignal(adaptiveState?.uncertainty?.[task.taskId]);
							const bottleneckValueSignal = boundedSignal(
								adaptiveState?.limitingPool === undefined
									? undefined
									: adaptiveState.marginalVerifiedProgressByResource?.[adaptiveState.limitingPool],
							);
							const valueOfInformationSignal = boundedSignal(
								adaptiveState?.allocationEntries?.find((allocation) => allocation.taskId === task.taskId)
									?.taskValueCertificate.evidenceGapRequirementIds.length,
							);
							const weightedValueSignal =
								clampWeight(weights?.value, 1) * valueOfInformationSignal +
								clampWeight(weights?.uncertainty, 1) * uncertaintySignal * bottleneckValueSignal;
							return criticalPathSignal + limitingPoolSignal + allocationSignal + weightedValueSignal;
						})();
			return { entry, score: base + ageScore + valueScore + adaptiveScore, age };
		});
		return scored
			.sort((left, right) => {
				if (right.score !== left.score) return right.score - left.score;
				if (right.age !== left.age) return right.age - left.age;
				if (right.entry.priority !== left.entry.priority) return right.entry.priority - left.entry.priority;
				if (left.entry.queuedAt !== right.entry.queuedAt)
					return codePointCompare(left.entry.queuedAt, right.entry.queuedAt);
				return codePointCompare(left.entry.input.taskId, right.entry.input.taskId);
			})
			.map((item) => item.entry);
	};

	const readiness = async (
		entry: WorkflowSchedulerQueueEntry,
		graph: WorkflowTaskGraph,
		activeTasks: readonly WorkflowTask[],
	): Promise<{
		task: WorkflowTask;
		blockedBy: readonly WorkflowDispatchBlockingReason[];
		recipeAdmission?: WorkflowSchedulerRecipeAdmissionContext;
	}> => {
		const task = graph.byId.get(entry.input.taskId);
		if (task === undefined || task.status !== "ready")
			throw new WorkflowSchedulerError("workflow_scheduler_ready_set_mismatch");
		if (task.dependencyTaskIds.some((dependency) => graph.byId.get(dependency)?.status !== "accepted"))
			throw new WorkflowSchedulerError("workflow_scheduler_ready_set_mismatch");
		if (activeTasks.some((active) => overlaps(task, active))) return { task, blockedBy: [BLOCKED] };
		const recipeAdmission = await resolveRecipeAdmission(entry, task, entry.input, graph);
		if (recipeAdmission === null) return { task, blockedBy: [BLOCKED] };
		const adaptiveState = await resolveAdaptiveState(entry.input.workflowId);
		if (
			adaptiveState?.safetyOverride === "active" ||
			adaptiveState?.allocationStatus === "awaiting_user" ||
			adaptiveState?.allocationStatus === "quarantined"
		)
			return { task, blockedBy: [BLOCKED] };

		const envelope = await readEnvelope();
		const hasResourceAuthority = envelope !== null || dependencies.workerPartition !== undefined;
		if (!hasResourceAuthority) return { task, blockedBy: ["resource_envelope_unapproved"] };
		if (!capacityWindowApproved(envelope, dependencies.clock.now()))
			return { task, blockedBy: ["resource_envelope_unapproved"] };
		{
			const workerResources = resourceVector(envelope?.resources ?? dependencies.workerPartition?.resourceVector);
			const reserveResources = resourceVector(envelope?.controlPlaneReserve ?? dependencies.controlPlaneReserve);
			const activeResources = await dependencies.leases.activeVector(entry.input.workflowId);
			const available = subtractResource(subtractResource(workerResources, reserveResources), activeResources);
			if (!fitsScalar(task.declaredResourceVector, available) || !fitsPools(task.declaredResourceVector, available))
				return { task, blockedBy: ["resource_envelope_unapproved"] };
			const workerCapacity = controlCapacity(
				dependencies.workerPartition?.controlCapacity ?? envelope?.workerCapacity,
			);
			const reserveCapacity = reserveControlCapacity(
				envelope?.controlPlaneReserveCapacity,
				dependencies.controlPartition?.capacity,
			);
			const activeControl = await dependencies.leases.activeControlCapacity(entry.input.workflowId);
			const availableControl = controlCapacity();
			for (const field of CONTROL_CAPACITY_FIELDS)
				availableControl[field] = Math.max(
					0,
					workerCapacity[field] - reserveCapacity[field] - activeControl[field],
				);
			if (!fitsControl(task.declaredControlCapacity, availableControl)) return { task, blockedBy: [BLOCKED] };
			if (
				task.declaredResourceVector.providers.length > 0 &&
				!cloudCapacityApproved(
					entry.input.workflowId,
					entry.input.epochRef,
					task,
					envelope,
					entry.input.canonicalAdmissionBundle?.envelope,
					dependencies.clock.now(),
				)
			)
				return { task, blockedBy: ["resource_envelope_unapproved"] };
			if (task.declaredResourceVector.providers.length > 0 && durableAdmissionRequired) {
				if (dependencies.verifyCloudCapacityReceipt === undefined || envelope === null)
					return { task, blockedBy: ["resource_envelope_unapproved"] };
				try {
					await dependencies.verifyCloudCapacityReceipt({
						workflowId: entry.input.workflowId,
						epochRef: entry.input.epochRef,
						task,
						envelope,
						canonicalEnvelope: entry.input.canonicalAdmissionBundle?.envelope,
						trustedNow: dependencies.clock.now(),
					});
				} catch {
					return { task, blockedBy: ["resource_envelope_unapproved"] };
				}
			}
		}
		return { task, blockedBy: [], recipeAdmission };
	};

	const requestFor = (
		entry: WorkflowSchedulerQueueEntry,
		task: WorkflowTask,
		epochRef: WorkflowEpochRef,
	): WorkflowLeaseRequest => ({
		workflowId: entry.input.workflowId,
		taskId: task.taskId,
		attemptId: entry.input.attemptId,
		executionKey: entry.input.executionKey,
		epochRef,
		vector: task.declaredResourceVector,
		controlCapacity: task.declaredControlCapacity,
		enforcementClass: dependencies.workerPartition?.enforcementClass ?? "host_bounded",
		processSlots: task.declaredControlCapacity.processSlots,
		conflictKey: `${entry.input.workflowId}:${task.taskId}`,
		queuePriority: entry.priority,
		queuedAt: entry.queuedAt,
		controlPlane: false,
	});

	const dispatchOne = async (
		entry: WorkflowSchedulerQueueEntry,
		state: WorkflowSchedulerState,
		graph: WorkflowTaskGraph,
		activeTasks: readonly WorkflowTask[],
		nextState: WorkflowSchedulerState,
	): Promise<{
		result: WorkflowDispatchResult | null;
		blockedBy: readonly WorkflowDispatchBlockingReason[];
		rollback?: () => Promise<void>;
	}> => {
		await assertRevision(entry.input.workflowId, state.epochRef, entry.input.executionKey);
		const checked = await readiness(entry, graph, activeTasks);
		if (checked.blockedBy.length > 0) return { result: null, blockedBy: checked.blockedBy };
		if (durableAdmissionRequired && dependencies.durableAdmissionTransaction === undefined)
			throw new WorkflowSchedulerError("workflow_scheduler_durable_admission_transaction_required");
		const request = requestFor(entry, checked.task, state.epochRef);
		const durableAdmissionTransaction = dependencies.durableAdmissionTransaction;
		if (durableAdmissionTransaction === undefined && !(await dependencies.leases.canAdmit(request)))
			return { result: null, blockedBy: [BLOCKED] };
		let ownershipRequest: WorkflowOwnershipLeaseRequest | null = null;
		if (checked.task.ownedPaths.length > 0 || checked.task.ownedContracts.length > 0) {
			ownershipRequest = {
				...request,
				ownedPaths: checked.task.ownedPaths,
				ownedContracts: checked.task.ownedContracts,
			};
		}
		let acquired: { resourceLease: WorkflowResourceLease; ownershipLease: WorkflowOwnershipLease | null };
		let releasePreDispatch: () => Promise<void>;
		const recipeAdmission = checked.recipeAdmission;
		if (durableAdmissionTransaction !== undefined) {
			if (recipeAdmission === undefined || recipeAdmission === null)
				throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_required");
			acquired = await durableAdmissionTransaction.commit({
				workflowId: entry.input.workflowId,
				epochRef: state.epochRef,
				taskId: checked.task.taskId,
				attemptId: entry.input.attemptId,
				executionKey: entry.input.executionKey,
				expectedStateDigest: digestObject(state),
				expectedHeadDigest: dependencies.store
					? digestObject(
							(
								await dependencies.store.replay({
									workflowId: entry.input.workflowId,
									fromSequence: 0,
									expectedStoreEpoch: state.epochRef.storeEpoch,
								})
							).head,
						)
					: queueEntryHeadDigest(state),
				expectedJournalHeadDigest: dependencies.store
					? digestObject(
							(
								await dependencies.store.replay({
									workflowId: entry.input.workflowId,
									fromSequence: 0,
									expectedStoreEpoch: state.epochRef.storeEpoch,
								})
							).head,
						)
					: undefined,
				expectedQueueHeadDigest: queueEntryHeadDigest(state),
				previousState: state,
				nextState,
				resource: request,
				ownership: ownershipRequest,
				recipeAdmission: recipeAdmission.artifact,
				admissionDigest: recipeAdmission.admissionDigest,
				recipeId: recipeAdmission.artifact.recipeId,
				recipeRevision: recipeAdmission.artifact.revision,
				requiredSkillSnapshotDigests: checked.task.requiredSkillSnapshotDigests,
				skillBindings: recipeAdmission.bindings,
				consumeRecipeAdmission:
					dependencies.consumeRecipeAdmission === undefined
						? undefined
						: () => dependencies.consumeRecipeAdmission!(recipeAdmission.artifact),
			});
			releasePreDispatch = async (): Promise<void> => {
				await durableAdmissionTransaction.rollback({
					workflowId: entry.input.workflowId,
					taskId: checked.task.taskId,
					attemptId: entry.input.attemptId,
					epochRef: state.epochRef,
					executionKey: entry.input.executionKey,
					resourceLease: acquired.resourceLease,
					ownershipLease: acquired.ownershipLease,
					previousState: state,
					committedState: nextState,
				});
			};
		} else {
			if (recipeAdmission !== undefined)
				throw new WorkflowSchedulerError("workflow_scheduler_durable_admission_transaction_required");
			if (dependencies.leaseTransaction === undefined)
				throw new WorkflowSchedulerError("workflow_scheduler_atomic_lease_transaction_required");
			const leaseTransaction = dependencies.leaseTransaction;
			acquired = await leaseTransaction.acquire(request, ownershipRequest);
			releasePreDispatch = async (): Promise<void> => {
				await leaseTransaction.releasePreDispatch({
					workflowId: entry.input.workflowId,
					taskId: checked.task.taskId,
					attemptId: entry.input.attemptId,
					epochRef: state.epochRef,
					resourceLease: acquired.resourceLease,
					ownershipLease: acquired.ownershipLease,
				});
			};
		}
		const resourceLease = acquired.resourceLease;
		const ownershipLease = acquired.ownershipLease;
		if ((ownershipRequest === null) !== (ownershipLease === null)) {
			await releasePreDispatch();
			throw new WorkflowSchedulerError("workflow_scheduler_atomic_lease_incomplete");
		}
		let leasedInput: WorkflowCanonicalDispatchInput;
		let observed: WorkflowDispatchReadiness;
		try {
			leasedInput = {
				...entry.input,
				epochRef: state.epochRef,
				rootLeaseRef: await readRootLeaseRef(entry.input.workflowId, state.epochRef),
				writerIdentity: dependencies.writerIdentity,
				resourceLease,
				ownershipLease,
			} as WorkflowCanonicalDispatchInput;
			observed = await dependencies.dispatcher.observe(leasedInput);
		} catch (error) {
			await releasePreDispatch();
			throw error;
		}
		if (!observed.canDispatch) {
			await releasePreDispatch();
			return { result: null, blockedBy: queueBlock(observed) };
		}
		try {
			return {
				result: await dependencies.dispatcher.dispatch(leasedInput),
				blockedBy: [],
				rollback: releasePreDispatch,
			};
		} catch (error) {
			await releasePreDispatch();
			throw error;
		}
	};

	const approvedParallelism = (envelope: WorkflowResourceEnvelope | null): number => {
		if (envelope === null) {
			return dependencies.workerPartition === undefined ? 0 : Number.POSITIVE_INFINITY;
		}
		if (
			!Number.isSafeInteger(envelope.processSlots) ||
			envelope.processSlots < 0 ||
			!Number.isSafeInteger(envelope.candidateSlots) ||
			envelope.candidateSlots < 0
		)
			throw new WorkflowSchedulerError("workflow_scheduler_capacity_profile_invalid");
		if (envelope.candidateSlots === 0 || envelope.processSlots === 0)
			throw new WorkflowSchedulerError("workflow_scheduler_capacity_gap");
		const workerCapacity = controlCapacity(envelope.workerCapacity);
		const aggregateCapacity = controlCapacity(envelope.controlCapacity);
		const reserveCapacity = reserveControlCapacity(
			envelope.controlPlaneReserveCapacity,
			dependencies.controlPartition?.capacity,
		);
		const hasAggregateCapacity = CONTROL_CAPACITY_FIELDS.some((field) => aggregateCapacity[field] > 0);
		for (const field of CONTROL_CAPACITY_FIELDS) {
			const capacityCeiling = hasAggregateCapacity
				? aggregateCapacity[field]
				: field === "processSlots"
					? Math.max(workerCapacity[field], envelope.processSlots)
					: workerCapacity[field];
			if (reserveCapacity[field] > capacityCeiling)
				throw new WorkflowSchedulerError("workflow_scheduler_reserve_partition_invalid");
		}
		return Math.max(0, Math.min(envelope.processSlots, envelope.candidateSlots) - reserveCapacity.processSlots);
	};

	const observe = async (workflowId: string): Promise<readonly WorkflowQueueObservation[]> => {
		const epochRef = await readCurrentEpoch(workflowId);
		await assertRevision(workflowId, epochRef, null);
		const state = await readState(workflowId, epochRef);
		const graph = currentTaskGraph(dependencies);
		const sorted = await sortEntries(state.entries, workflowId);
		const admissionAllowed = await Promise.all(
			sorted.map(async (entry) => {
				const task = graph.byId.get(entry.input.taskId);
				if (task === undefined) return false;
				return (await resolveRecipeAdmission(entry, task, entry.input, graph)) !== null;
			}),
		);
		return sorted.map((entry, entryIndex) => {
			const task = graph.byId.get(entry.input.taskId);
			if (
				task === undefined ||
				task.status !== "ready" ||
				task.dependencyTaskIds.some((dependency) => graph.byId.get(dependency)?.status !== "accepted")
			)
				throw new WorkflowSchedulerError("workflow_scheduler_ready_set_mismatch");
			return {
				taskId: task.taskId,
				attemptId: entry.input.attemptId,
				enqueuedAt: entry.queuedAt,
				ageMs: ageMilliseconds(dependencies.clock.now(), entry.queuedAt),
				priority: entry.priority,
				required: task.declaredResourceVector,
				blockedBy:
					admissionAllowed[entryIndex] === false ? [...new Set([...entry.blockedBy, BLOCKED])] : entry.blockedBy,
			};
		});
	};

	const refillUnlocked = async (
		workflowId: string,
		epochRef: WorkflowEpochRef,
	): Promise<readonly WorkflowDispatchResult[]> => {
		const currentEpoch = await readCurrentEpoch(workflowId);
		if (!sameEpoch(epochRef, currentEpoch)) throw new WorkflowSchedulerError("workflow_scheduler_epoch_mismatch");
		let state = await readState(workflowId, epochRef);
		const envelope = await readEnvelope();
		const approvedParallelismValue = approvedParallelism(envelope);
		if (state.pausedReason !== null) return [];
		const graph = currentTaskGraph(dependencies);
		const running = await runningTasks(workflowId, graph);
		const activeQueued = state.activeAttemptIds
			.map((attemptId) => state.entries.find((entry) => entry.input.attemptId === attemptId))
			.map((entry) => (entry === undefined ? undefined : graph.byId.get(entry.input.taskId)))
			.filter((task): task is WorkflowTask => task !== undefined);
		const activeTasks = [...running, ...activeQueued];
		const sorted = await sortEntries(state.entries, workflowId);
		const results: WorkflowDispatchResult[] = [];
		const rollbacks: Array<() => Promise<void>> = [];
		const active = new Set(state.activeAttemptIds);
		let persistedState = state;
		const configuredParallelism = Number.isFinite(dependencies.maxConcurrentAttempts)
			? Math.max(0, Math.floor(dependencies.maxConcurrentAttempts))
			: 0;
		const maxConcurrent = Math.max(0, Math.floor(Math.min(configuredParallelism, approvedParallelismValue)));
		let occupied = active.size + running.length;
		for (const entry of sorted) {
			if (active.has(entry.input.attemptId) || occupied >= maxConcurrent) continue;
			const nextState: WorkflowSchedulerState = {
				...state,
				entries: state.entries.map((candidate) =>
					candidate.input.attemptId === entry.input.attemptId ? { ...candidate, blockedBy: [] } : candidate,
				),
				activeAttemptIds: [...state.activeAttemptIds, entry.input.attemptId],
			};
			let dispatched: Awaited<ReturnType<typeof dispatchOne>>;
			try {
				dispatched = await dispatchOne(entry, state, graph, activeTasks, nextState);
			} catch (error) {
				if (error instanceof WorkflowSchedulerError && error.code === "workflow_scheduler_recovery_requeued")
					return refillUnlocked(workflowId, epochRef);
				if (error instanceof WorkflowSchedulerError && error.code === "workflow_scheduler_dispatch_in_progress") {
					const durable = dependencies.store?.durableContext;
					if (durable === undefined) throw new WorkflowSchedulerError("workflow_scheduler_durable_state_required");
					await waitForDispatchCompletion(durable, workflowId, epochRef);
					return refillUnlocked(workflowId, epochRef);
				}
				throw error;
			}
			if (dispatched.blockedBy.length > 0) {
				state = {
					...state,
					entries: state.entries.map((candidate) =>
						candidate.input.attemptId === entry.input.attemptId
							? { ...candidate, blockedBy: dispatched.blockedBy }
							: candidate,
					),
				};
				continue;
			}
			if (dispatched.result !== null) {
				results.push(dispatched.result);
				if (dispatched.rollback !== undefined) rollbacks.push(dispatched.rollback);
				state = nextState;
				if (dependencies.durableAdmissionTransaction !== undefined) persistedState = nextState;
				active.add(entry.input.attemptId);
				occupied += 1;
				activeTasks.push(graph.byId.get(entry.input.taskId) as WorkflowTask);
			}
		}
		state = { ...state, activeAttemptIds: [...active] };
		if (digestObject(state) !== digestObject(persistedState)) {
			try {
				await writeState(state, persistedState);
			} catch (error) {
				for (const rollback of rollbacks.reverse()) await rollback();
				throw error;
			}
		}
		return results;
	};

	return {
		enqueue: async (input, queuedAt) =>
			withWorkflowLock(input.workflowId, async () => {
				if (input.workflowId.length === 0 || input.taskId.length === 0 || input.attemptId.length === 0)
					throw new WorkflowSchedulerError("workflow_scheduler_input_invalid");
				const expectedExecutionKey = canonicalKey(input);
				if (expectedExecutionKey !== null && expectedExecutionKey !== input.executionKey)
					throw new WorkflowSchedulerError("workflow_scheduler_idempotency_mismatch");
				if (!Number.isFinite(Date.parse(queuedAt)))
					throw new WorkflowSchedulerError("workflow_scheduler_queue_time_invalid");
				const epochRef = await readCurrentEpoch(input.workflowId);
				if (!sameEpoch(input.epochRef, epochRef))
					throw new WorkflowSchedulerError("workflow_scheduler_epoch_mismatch");
				await assertRevision(input.workflowId, epochRef, input.executionKey);
				let state = await readState(input.workflowId, epochRef);
				const graph = currentTaskGraph(dependencies);
				const task = graph.byId.get(input.taskId);
				if (task === undefined || task.status !== "ready")
					throw new WorkflowSchedulerError("workflow_scheduler_ready_set_mismatch");
				if (state.terminalAttemptIds?.includes(input.attemptId) === true)
					throw new WorkflowSchedulerError("workflow_scheduler_attempt_terminal");
				const recipeAdmission = await resolveRecipeAdmission(null, task, input, graph);
				if (durableAdmissionRequired && recipeAdmission === null)
					throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_required");
				const duplicate = state.entries.find((entry) => entry.input.attemptId === input.attemptId);
				if (duplicate !== undefined) {
					if (duplicate.input.executionKey !== input.executionKey)
						throw new WorkflowSchedulerError("workflow_scheduler_idempotency_mismatch");
					if (
						recipeAdmission !== undefined &&
						recipeAdmission !== null &&
						duplicate.recipeAdmissionDigest !== recipeAdmission.admissionDigest
					)
						throw new WorkflowSchedulerError("workflow_scheduler_recipe_admission_mismatch");
					return;
				}
				const previousState = state;
				state = {
					...state,
					entries: [
						...state.entries,
						{
							input,
							queuedAt,
							priority: taskPriority(task),
							blockedBy: [],
							...(recipeAdmission === undefined || recipeAdmission === null
								? {}
								: {
										recipeId: recipeAdmission.artifact.recipeId,
										recipeRevision: recipeAdmission.artifact.revision,
										recipeAdmissionDigest: recipeAdmission.admissionDigest,
									}),
						},
					],
				};
				await writeState(state, previousState);
			}),
		onEvent: async (event) =>
			withWorkflowLock(event.workflowId, async () => {
				if (!Number.isSafeInteger(event.eventSequence) || event.eventSequence <= 0)
					throw new WorkflowSchedulerError("workflow_scheduler_event_sequence_invalid");
				const epochRef = await readCurrentEpoch(event.workflowId);
				if (event.workflowId.length === 0 || !sameEpoch(event.epochRef, epochRef))
					throw new WorkflowSchedulerError("workflow_scheduler_epoch_mismatch");
				await assertRevision(event.workflowId, event.epochRef, null);
				if (dependencies.store !== undefined) {
					const replay = await dependencies.store.replay({
						workflowId: event.workflowId,
						fromSequence: 0,
						expectedStoreEpoch: event.epochRef.storeEpoch,
					});
					const suppliedHeadDigest = event.journalHeadDigest ?? event.headDigest;
					const rootLease = await readRootLeaseRef(event.workflowId, event.epochRef);
					if (
						replay.quarantined ||
						(event.eventSequence !== replay.head.sequence && event.eventSequence > 0) ||
						suppliedHeadDigest !== digestObject(replay.head) ||
						event.eventDigest !== replay.head.eventDigest ||
						event.writerIdentity !== rootLease.writerIdentity
					)
						throw new WorkflowSchedulerError("workflow_scheduler_event_unauthenticated");
				}
				const state = await readState(event.workflowId, event.epochRef);
				if ((state.lastEventSequence ?? 0) >= event.eventSequence) return [];
				const terminalEvent =
					event.kind === "lease_released" ||
					event.kind === "attempt_completed" ||
					event.kind === "recovery_reconciled";
				const attemptId = event.attemptId;
				if (terminalEvent && attemptId !== undefined && state.terminalAttemptIds?.includes(attemptId) === true) {
					await writeState({ ...state, lastEventSequence: event.eventSequence }, state);
					return [];
				}
				const matchingEntry =
					attemptId === undefined ? undefined : state.entries.find((entry) => entry.input.attemptId === attemptId);
				if (
					terminalEvent &&
					attemptId === undefined &&
					(state.activeAttemptIds.length > 0 || state.entries.length > 0)
				)
					throw new WorkflowSchedulerError("workflow_scheduler_attempt_id_required");
				const entries =
					terminalEvent && attemptId !== undefined
						? state.entries.filter((entry) => entry.input.attemptId !== attemptId)
						: state.entries;
				const activeAttemptIds =
					terminalEvent && attemptId !== undefined
						? state.activeAttemptIds.filter((candidate) => candidate !== attemptId)
						: state.activeAttemptIds;
				if (
					terminalEvent &&
					attemptId !== undefined &&
					matchingEntry === undefined &&
					!state.activeAttemptIds.includes(attemptId)
				) {
					const terminalAttemptIds = [...new Set([...(state.terminalAttemptIds ?? []), attemptId])].sort(
						codePointCompare,
					);
					await writeState({ ...state, terminalAttemptIds, lastEventSequence: event.eventSequence }, state);
					return [];
				}
				const terminalAttemptIds =
					terminalEvent && attemptId !== undefined
						? [...new Set([...(state.terminalAttemptIds ?? []), attemptId])].sort(codePointCompare)
						: state.terminalAttemptIds;
				await writeState(
					{
						...state,
						entries,
						activeAttemptIds,
						...(terminalAttemptIds === undefined ? {} : { terminalAttemptIds }),
						lastEventSequence: event.eventSequence,
					},
					state,
				);
				return refillUnlocked(event.workflowId, event.epochRef);
			}),
		refill: async (workflowId, epochRef) => withWorkflowLock(workflowId, () => refillUnlocked(workflowId, epochRef)),
		observe,
		pause: async (workflowId, reason, approval) =>
			withWorkflowLock(workflowId, async () => {
				if (reason.length === 0) throw new WorkflowSchedulerError("workflow_scheduler_pause_reason_missing");
				if (approval !== undefined && approvalIdentifier(approval).length === 0)
					throw new WorkflowSchedulerError("workflow_scheduler_approval_required");
				const epochRef = await readCurrentEpoch(workflowId);
				await assertRevision(workflowId, epochRef, null);
				const state = await readState(workflowId, epochRef);
				await writeState({ ...state, pausedReason: reason }, state);
			}),
		resume: async (workflowId, approval) =>
			withWorkflowLock(workflowId, async () => {
				if (
					approvalIdentifier(approval).length === 0 ||
					(typeof approval === "object" &&
						"approvalReceipt" in approval &&
						approval.approvalReceipt.length === 0) ||
					("optionId" in approval && approval.optionId.length === 0)
				)
					throw new WorkflowSchedulerError("workflow_scheduler_approval_required");
				const epochRef = await readCurrentEpoch(workflowId);
				await assertRevision(workflowId, epochRef, null);
				const state = await readState(workflowId, epochRef);
				await writeState({ ...state, pausedReason: null }, state);
			}),
	};
}

/**
 * Create a scheduler whose queue projection and dispatch transaction share one durable runtime store.
 *
 * Args:
 * input: Scheduler authorities plus the authenticated runtime store.
 * Return: A scheduler backed by the runtime store's durable auxiliary CAS queue.
 */
export function createWorkflowRuntimeScheduler(input: WorkflowSchedulerRuntimeFactoryInput): WorkflowScheduler {
	const { schedulerStateRecordName, store, ...dependencies } = input;
	return createWorkflowScheduler({
		...dependencies,
		store,
		queueState: createWorkflowSchedulerStateStore({ store, recordName: schedulerStateRecordName }),
	});
}
