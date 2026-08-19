import { Buffer } from "node:buffer";
import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
	canonicalWorkflowProcessGroupDigest,
	commitAuthenticated,
	type WorkflowAdmissionRegistry,
	type WorkflowAdmissionResult,
	type WorkflowBindingReceiptStore,
	type WorkflowInternalAdmissionContext,
} from "./admission.js";
import type {
	WorkflowActiveLeaseContext,
	WorkflowArtifactRef,
	WorkflowCanonicalPoolMap,
	WorkflowCapacityGrant,
	WorkflowControlCapacityVector,
	WorkflowControlPartition,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalHead,
	WorkflowLeaseReconciliation,
	WorkflowLeaseRef,
	WorkflowLeaseReleaseInput,
	WorkflowLeaseReleaseRef,
	WorkflowLeaseReleaseResult,
	WorkflowLeaseStatus,
	WorkflowOwnershipLease,
	WorkflowResourceAdmission,
	WorkflowResourceEnforcementClass,
	WorkflowResourceLease,
	WorkflowResourceVector,
	WorkflowRuntimeStore,
	WorkflowWorkerPartition,
	WorkflowZeroControlCapacityVector,
} from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes } from "./contracts.js";
import {
	assertRevisionBoundary as assertDispatchRevisionBoundary,
	leaseRefOf as leaseRefOfResource,
	type WorkflowRevisionBoundaryReader,
} from "./dispatch.js";
import type { WorkflowEpochManager, WorkflowLeaseTtlStore } from "./epochs.js";
import {
	assertFiniteWorkflowControlCapacity,
	assertFiniteWorkflowResourceVector,
	zeroWorkflowControlCapacity,
	zeroWorkflowResourceVector,
} from "./resources.js";
import type { WorkflowTask, WorkflowTaskGraph } from "./task-graph.js";
import { parseWorkflowCanonicalPath } from "./task-graph.js";

export type WorkflowLeaseKind = "resource" | "ownership";

export class WorkflowLeaseError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "WorkflowLeaseError";
		this.code = code;
	}
}

export interface WorkflowLeaseRequest {
	workflowId: string;
	taskId: string;
	attemptId: string;
	executionKey: string;
	epochRef: WorkflowEpochRef;
	vector: WorkflowResourceVector;
	controlCapacity: WorkflowControlCapacityVector;
	enforcementClass: WorkflowResourceEnforcementClass;
	processSlots: number;
	conflictKey: string;
	queuePriority: number;
	queuedAt: string;
	controlPlane: boolean;
}

export interface WorkflowOwnershipLeaseRequest extends WorkflowLeaseRequest {
	ownedPaths: readonly string[];
	ownedContracts: readonly string[];
}

export interface WorkflowLeaseAdmissionBinding {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly epochRef: WorkflowEpochRef;
	readonly controlCapacity: WorkflowControlCapacityVector;
}

export interface WorkflowLeaseGrantBinding {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly epochRef: WorkflowEpochRef;
	readonly vector: WorkflowResourceVector;
	readonly controlCapacity: WorkflowControlCapacityVector;
	readonly grantDigest: string;
	readonly canonicalLedgerDigest: string;
}

export interface WorkflowLeaseAdmissionState {
	terminalEventSequence: number | null;
	executionKey: string;
	outcomeDigest: string | null;
	leaseStatus: WorkflowLeaseStatus;
}

export interface WorkflowLeaseQuarantineInput {
	readonly workflowId: string;
	readonly attemptId: string;
	readonly leaseRef: WorkflowLeaseRef;
	readonly epochRef: WorkflowEpochRef;
	readonly store: WorkflowRuntimeStore;
	readonly executionKey: string;
	readonly reason: string;
}

export interface WorkflowLeasePreDispatchReleaseInput {
	readonly workflowId: string;
	readonly taskId?: string;
	readonly attemptId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly executionKey: string;
	readonly resourceLease: WorkflowResourceLease;
	readonly ownershipLease: WorkflowOwnershipLease | null;
	/** Preserve a pre-existing resource lease when only a newly acquired ownership lease is rolled back. */
	readonly releaseResourceLease?: boolean;
	readonly reason?: string;
}

export interface WorkflowLeaseDispatchReservationInput {
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly resource: WorkflowLeaseRequest;
	readonly ownership: WorkflowOwnershipLeaseRequest | null;
	readonly expectedHead?: WorkflowJournalHead;
	readonly expectedHeadDigest?: string;
	readonly createAdmissionContext: (
		resourceLease: WorkflowResourceLease,
		ownershipLease: WorkflowOwnershipLease | null,
	) => WorkflowInternalAdmissionContext;
	/** Persist the scheduler queue transition while the dispatch lease guard is held. */
	readonly commitQueueState?: () => Promise<void>;
	/** Restore the scheduler queue transition when admission cannot be committed. */
	readonly rollbackQueueState?: () => Promise<void>;
	/** Record the durable recovery marker after the complete lease pair is acquired. */
	readonly onLeasesAcquired?: (
		resourceLease: WorkflowResourceLease,
		ownershipLease: WorkflowOwnershipLease | null,
	) => Promise<void>;
	/** Record the durable recovery marker after the queue CAS succeeds. */
	readonly onQueueCommitted?: () => Promise<void>;
	/** Revalidate the host receipt after queue CAS and before dispatch intent append. */
	readonly verifyRecipeAdmissionReceipt?: () => void | Promise<void>;
	/** Consume the host-issued recipe only after head, capacity, and queue CAS succeed. */
	readonly consumeRecipeAdmission?: () => void | Promise<void>;
}

export interface WorkflowLeaseDispatchReservation {
	readonly resourceLease: WorkflowResourceLease;
	readonly ownershipLease: WorkflowOwnershipLease | null;
	readonly admission: WorkflowAdmissionResult;
}

export interface WorkflowLeaseManager {
	acquireResource(input: WorkflowLeaseRequest): Promise<WorkflowResourceLease>;
	acquireOwnership(input: WorkflowOwnershipLeaseRequest): Promise<WorkflowOwnershipLease>;
	reserveDispatch?(input: WorkflowLeaseDispatchReservationInput): Promise<WorkflowLeaseDispatchReservation>;
	hydrateFromReplay(): Promise<void>;
	releasePreDispatch?(input: WorkflowLeasePreDispatchReleaseInput): Promise<void>;
	release(input: WorkflowLeaseReleaseInput): Promise<WorkflowLeaseReleaseResult>;
	quarantine(input: WorkflowLeaseQuarantineInput): Promise<WorkflowLeaseReconciliation>;
	reconcile(input: WorkflowLeaseReleaseInput): Promise<WorkflowLeaseReconciliation>;
	activeVector(workflowId: string): Promise<WorkflowResourceVector>;
	activeControlCapacity(workflowId: string): Promise<WorkflowControlCapacityVector>;
	canAdmit(input: WorkflowLeaseRequest): Promise<boolean>;
	lookupByLease(workflowId: string, leaseRef: WorkflowLeaseRef): Promise<WorkflowLeaseAdmissionState | undefined>;
}

export interface WorkflowLeaseManagerDependencies extends WorkflowRevisionBoundaryReader {
	readonly store: WorkflowRuntimeStore;
	readonly callbackFenceStore: WorkflowBindingReceiptStore;
	readonly epochs: WorkflowEpochManager;
	readonly admission: WorkflowAdmissionRegistry;
	readonly workflowRoot: string;
	readonly controlPlaneReserve: WorkflowResourceVector;
	readonly controlPartition: WorkflowControlPartition;
	readonly workerPartition: WorkflowWorkerPartition;
	readonly observedControlCapacity: WorkflowControlCapacityVector;
	readonly poolMap: WorkflowCanonicalPoolMap;
	readonly resourceCeiling: WorkflowResourceVector;
	readonly writerIdentity: string;
	readonly rootLeaseRef: WorkflowLeaseRef;
	readonly canonicalPoolLedgerRef: WorkflowArtifactRef;
	readonly trustedNow: () => string;
	readonly trustedMonotonicNow: () => number;
	readonly leaseTtlStore: WorkflowLeaseTtlStore;
	readonly resourceLeaseTtlMilliseconds: number;
	readonly readAdmissionBinding?: (
		workflowId: string,
		taskId: string,
		attemptId: string,
		executionKey: string,
	) => Promise<WorkflowLeaseAdmissionBinding | null>;
	readonly readTask?: (workflowId: string, taskId: string) => Promise<WorkflowTask | null>;
	readonly taskGraph?: WorkflowTaskGraph;
	readonly readGrant?: (input: WorkflowLeaseRequest) => Promise<WorkflowLeaseGrantBinding | null>;
	readonly readActiveLeaseContext?: () => Promise<WorkflowActiveLeaseContext>;
	readonly activeLease?: WorkflowActiveLeaseContext;
}

interface LeaseFold {
	records: Array<WorkflowResourceLease | WorkflowOwnershipLease>;
	released: Map<string, WorkflowLeaseRef>;
	quarantined: Map<string, WorkflowLeaseRef>;
	leaseRefs: Map<string, WorkflowLeaseRef>;
	executionKeys: Map<string, string>;
	ownershipReservations: Map<string, WorkflowOwnershipReservation>;
}

interface WorkflowOwnershipReservation {
	readonly vector: WorkflowResourceVector;
	readonly controlCapacity: WorkflowControlCapacityVector;
	readonly conflictKeyDigest: string;
	readonly enforcementClass: WorkflowResourceEnforcementClass;
	readonly controlPlane: boolean;
}

const CONTROL_DIMENSIONS = [
	"processSlots",
	"childSessionSlots",
	"modelCallSlots",
	"modelInputTokens",
	"modelOutputTokens",
	"verificationSlots",
	"redTeamSlots",
	"recoverySlots",
] as const satisfies readonly (keyof WorkflowControlCapacityVector)[];

const EMPTY_FOLD = (): LeaseFold => ({
	records: [],
	released: new Map(),
	quarantined: new Map(),
	leaseRefs: new Map(),
	executionKeys: new Map(),
	ownershipReservations: new Map(),
});

const PROVIDER_IDEMPOTENCY_RANK = {
	none: 0,
	host_reconciled: 1,
	provider_native: 2,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}

function frozenClone<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

interface OwnershipBindingEnvelope {
	readonly version: 1;
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly conflictKey: string;
	readonly vector: WorkflowResourceVector;
	readonly controlCapacity: WorkflowControlCapacityVector;
	readonly enforcementClass: WorkflowResourceEnforcementClass;
	readonly controlPlane: boolean;
}

function encodeOwnershipBinding(input: WorkflowOwnershipLeaseRequest): string {
	const binding: OwnershipBindingEnvelope = {
		version: 1,
		workflowId: input.workflowId,
		taskId: input.taskId,
		attemptId: input.attemptId,
		executionKey: input.executionKey,
		conflictKey: input.conflictKey,
		vector: input.vector,
		controlCapacity: input.controlCapacity,
		enforcementClass: input.enforcementClass,
		controlPlane: input.controlPlane,
	};
	return `ownership:v1:${Buffer.from(canonicalJsonBytes(binding)).toString("base64url")}`;
}

function decodeOwnershipBinding(idempotencyKey: string): OwnershipBindingEnvelope | null {
	const prefix = "ownership:v1:";
	if (!idempotencyKey.startsWith(prefix)) return null;
	try {
		const value: unknown = parseCanonicalJsonBytes(Buffer.from(idempotencyKey.slice(prefix.length), "base64url"));
		if (
			!isRecord(value) ||
			value.version !== 1 ||
			typeof value.workflowId !== "string" ||
			typeof value.taskId !== "string" ||
			typeof value.attemptId !== "string" ||
			typeof value.executionKey !== "string" ||
			typeof value.conflictKey !== "string" ||
			typeof value.enforcementClass !== "string" ||
			typeof value.controlPlane !== "boolean"
		)
			return null;
		if (
			value.enforcementClass !== "isolated_metered" &&
			value.enforcementClass !== "host_bounded" &&
			value.enforcementClass !== "exclusive_unisolated"
		)
			return null;
		return value as unknown as OwnershipBindingEnvelope;
	} catch {
		return null;
	}
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

export function createWorkflowLeaseManager(dependencies: WorkflowLeaseManagerDependencies): WorkflowLeaseManager {
	let fold: LeaseFold | null = null;
	let hydrated = false;

	const assertHydrated = (): LeaseFold => {
		if (!hydrated || fold === null) throw new WorkflowLeaseError("workflow_lease_replay_required");
		return fold;
	};

	const activeContext = async (): Promise<WorkflowActiveLeaseContext> => {
		if (dependencies.readActiveLeaseContext !== undefined) return dependencies.readActiveLeaseContext();
		if (dependencies.activeLease !== undefined) return dependencies.activeLease;
		return {
			workflowId: dependencies.store.identity.workflowId,
			epochRef: {
				storeEpoch: dependencies.rootLeaseRef.storeEpoch,
				coordinatorEpoch: dependencies.rootLeaseRef.coordinatorEpoch,
			},
			leaseRef: dependencies.rootLeaseRef,
			writerIdentity: dependencies.rootLeaseRef.writerIdentity,
			generationId: "workflow-generation",
			revisionBoundary: {
				workflowId: dependencies.store.identity.workflowId,
				epochRef: {
					storeEpoch: dependencies.rootLeaseRef.storeEpoch,
					coordinatorEpoch: dependencies.rootLeaseRef.coordinatorEpoch,
				},
				leaseRef: dependencies.rootLeaseRef,
				executionKey: null,
				revisionTuple: {
					contractRevision: 0,
					scorecardRevision: 0,
					planRevision: 0,
					evidenceRevision: 0,
					configRevision: 0,
				},
				revisionRegistryRef: dependencies.canonicalPoolLedgerRef,
				revisionRegistryDigest: dependencies.canonicalPoolLedgerRef.digest,
				configSnapshotDigest: dependencies.canonicalPoolLedgerRef.digest,
				tupleDigest: dependencies.canonicalPoolLedgerRef.digest,
			},
		};
	};

	const assertEpoch = async (workflowId: string, epochRef: WorkflowEpochRef): Promise<WorkflowActiveLeaseContext> => {
		if (workflowId.length === 0) throw new WorkflowLeaseError("workflow_workflow_id_invalid");
		const current = await activeContext();
		if (
			current.workflowId !== workflowId ||
			current.epochRef.storeEpoch !== epochRef.storeEpoch ||
			current.epochRef.coordinatorEpoch !== epochRef.coordinatorEpoch
		)
			throw new WorkflowLeaseError("workflow_epoch_stale");
		await dependencies.epochs.assertCurrent(workflowId, epochRef);
		return current;
	};

	const assertRevision = async (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		executionKey: string | null,
	): Promise<void> => {
		try {
			await assertDispatchRevisionBoundary(dependencies, workflowId, epochRef, executionKey);
		} catch (error) {
			if (error instanceof WorkflowLeaseError) throw error;
			throw new WorkflowLeaseError(
				error instanceof Error ? error.message : "workflow_revision_boundary_unavailable",
			);
		}
	};

	const checkedNumber = (value: number, code: string): number => {
		if (!Number.isSafeInteger(value) || value < 0) throw new WorkflowLeaseError(code);
		return value;
	};

	const checkedAdd = (left: number, right: number): number => {
		checkedNumber(left, "workflow_resource_sum_unsafe");
		checkedNumber(right, "workflow_resource_sum_unsafe");
		if (left > Number.MAX_SAFE_INTEGER - right) throw new WorkflowLeaseError("workflow_resource_sum_unsafe");
		return left + right;
	};

	const validPoolMap = (vector: WorkflowResourceVector): boolean => {
		const acceleratorIds = new Set<string>();
		for (const accelerator of vector.accelerators) {
			const key = `${accelerator.poolId}\u0000${accelerator.deviceType}`;
			if (
				acceleratorIds.has(key) ||
				!dependencies.poolMap.accelerators.has(key) ||
				accelerator.poolId.length === 0 ||
				accelerator.deviceType.length === 0
			)
				return false;
			acceleratorIds.add(key);
		}
		const providerIds = new Set<string>();
		for (const provider of vector.providers) {
			if (
				providerIds.has(provider.poolId) ||
				!dependencies.poolMap.providers.has(provider.poolId) ||
				!Object.hasOwn(PROVIDER_IDEMPOTENCY_RANK, provider.idempotency)
			)
				return false;
			providerIds.add(provider.poolId);
		}
		return true;
	};

	const validControl = (capacity: WorkflowControlCapacityVector): boolean => {
		try {
			assertFiniteWorkflowControlCapacity(capacity);
			return CONTROL_DIMENSIONS.every(
				(dimension) => Number.isSafeInteger(capacity[dimension]) && capacity[dimension] >= 0,
			);
		} catch {
			return false;
		}
	};

	const validVector = (vector: WorkflowResourceVector): boolean => {
		try {
			assertFiniteWorkflowResourceVector(vector);
			return validPoolMap(vector);
		} catch {
			return false;
		}
	};

	const addControl = (
		left: WorkflowControlCapacityVector,
		right: WorkflowControlCapacityVector,
	): WorkflowControlCapacityVector => {
		if (!validControl(left) || !validControl(right))
			throw new WorkflowLeaseError("workflow_control_capacity_invalid");
		return Object.fromEntries(
			CONTROL_DIMENSIONS.map((dimension) => [dimension, checkedAdd(left[dimension], right[dimension])]),
		) as unknown as WorkflowControlCapacityVector;
	};

	const addVector = (left: WorkflowResourceVector, right: WorkflowResourceVector): WorkflowResourceVector => {
		if (!validVector(left) || !validVector(right)) throw new WorkflowLeaseError("workflow_resource_vector_invalid");
		const acceleratorKeys = new Set([
			...left.accelerators.map((entry) => `${entry.poolId}\u0000${entry.deviceType}`),
			...right.accelerators.map((entry) => `${entry.poolId}\u0000${entry.deviceType}`),
		]);
		const providerKeys = new Set([
			...left.providers.map((entry) => entry.poolId),
			...right.providers.map((entry) => entry.poolId),
		]);
		const accelerators = [...acceleratorKeys].sort().map((key) => {
			const separator = key.indexOf("\u0000");
			const poolId = key.slice(0, separator);
			const deviceType = key.slice(separator + 1);
			const leftEntry = left.accelerators.find(
				(entry) => entry.poolId === poolId && entry.deviceType === deviceType,
			);
			const rightEntry = right.accelerators.find(
				(entry) => entry.poolId === poolId && entry.deviceType === deviceType,
			);
			return {
				poolId,
				deviceType,
				count: checkedAdd(leftEntry?.count ?? 0, rightEntry?.count ?? 0),
				memoryBytes: checkedAdd(leftEntry?.memoryBytes ?? 0, rightEntry?.memoryBytes ?? 0),
			};
		});
		const providers = [...providerKeys].sort().map((poolId) => {
			const leftEntry = left.providers.find((entry) => entry.poolId === poolId);
			const rightEntry = right.providers.find((entry) => entry.poolId === poolId);
			const idempotency: "none" | "host_reconciled" | "provider_native" =
				leftEntry?.idempotency === "none" || rightEntry?.idempotency === "none"
					? "none"
					: leftEntry?.idempotency === "host_reconciled" || rightEntry?.idempotency === "host_reconciled"
						? "host_reconciled"
						: "provider_native";
			return {
				poolId,
				concurrentRequests: checkedAdd(leftEntry?.concurrentRequests ?? 0, rightEntry?.concurrentRequests ?? 0),
				requestsPerMinute: checkedAdd(leftEntry?.requestsPerMinute ?? 0, rightEntry?.requestsPerMinute ?? 0),
				totalRequests: checkedAdd(leftEntry?.totalRequests ?? 0, rightEntry?.totalRequests ?? 0),
				inputTokens: checkedAdd(leftEntry?.inputTokens ?? 0, rightEntry?.inputTokens ?? 0),
				outputTokens: checkedAdd(leftEntry?.outputTokens ?? 0, rightEntry?.outputTokens ?? 0),
				idempotency,
			};
		});
		return {
			cpuMilliCores: checkedAdd(left.cpuMilliCores, right.cpuMilliCores),
			memoryBytes: checkedAdd(left.memoryBytes, right.memoryBytes),
			diskBytes: checkedAdd(left.diskBytes, right.diskBytes),
			ioWeight: checkedAdd(left.ioWeight, right.ioWeight),
			accelerators,
			providers,
			networkEgressBytes: checkedAdd(left.networkEgressBytes, right.networkEgressBytes),
			wallMilliseconds: checkedAdd(left.wallMilliseconds, right.wallMilliseconds),
			monetaryMicrounits: checkedAdd(left.monetaryMicrounits, right.monetaryMicrounits),
		};
	};

	const fitsControl = (candidate: WorkflowControlCapacityVector, ceiling: WorkflowControlCapacityVector): boolean =>
		validControl(candidate) &&
		validControl(ceiling) &&
		CONTROL_DIMENSIONS.every((dimension) => candidate[dimension] <= ceiling[dimension]);

	const fitsVector = (candidate: WorkflowResourceVector, ceiling: WorkflowResourceVector): boolean => {
		if (!validVector(candidate) || !validVector(ceiling)) return false;
		if (
			candidate.cpuMilliCores > ceiling.cpuMilliCores ||
			candidate.memoryBytes > ceiling.memoryBytes ||
			candidate.diskBytes > ceiling.diskBytes ||
			candidate.ioWeight > ceiling.ioWeight ||
			candidate.networkEgressBytes > ceiling.networkEgressBytes ||
			candidate.wallMilliseconds > ceiling.wallMilliseconds ||
			candidate.monetaryMicrounits > ceiling.monetaryMicrounits
		)
			return false;
		return (
			candidate.accelerators.every((required) => {
				const capacity = ceiling.accelerators.find(
					(entry) => entry.poolId === required.poolId && entry.deviceType === required.deviceType,
				);
				return (
					capacity !== undefined &&
					required.count <= capacity.count &&
					required.memoryBytes <= capacity.memoryBytes
				);
			}) &&
			candidate.providers.every((required) => {
				const capacity = ceiling.providers.find((entry) => entry.poolId === required.poolId);
				return (
					capacity !== undefined &&
					PROVIDER_IDEMPOTENCY_RANK[capacity.idempotency] >= PROVIDER_IDEMPOTENCY_RANK[required.idempotency] &&
					required.concurrentRequests <= capacity.concurrentRequests &&
					required.requestsPerMinute <= capacity.requestsPerMinute &&
					required.totalRequests <= capacity.totalRequests &&
					required.inputTokens <= capacity.inputTokens &&
					required.outputTokens <= capacity.outputTokens
				);
			})
		);
	};

	const minVector = (left: WorkflowResourceVector, right: WorkflowResourceVector): WorkflowResourceVector => {
		if (!validVector(left) || !validVector(right)) throw new WorkflowLeaseError("workflow_resource_vector_invalid");
		const acceleratorKeys = new Set([
			...left.accelerators.map((entry) => `${entry.poolId}\u0000${entry.deviceType}`),
			...right.accelerators.map((entry) => `${entry.poolId}\u0000${entry.deviceType}`),
		]);
		const providerKeys = new Set([
			...left.providers.map((entry) => entry.poolId),
			...right.providers.map((entry) => entry.poolId),
		]);
		const accelerators = [...acceleratorKeys].sort().map((key) => {
			const separator = key.indexOf("\u0000");
			const poolId = key.slice(0, separator);
			const deviceType = key.slice(separator + 1);
			const l = left.accelerators.find((entry) => entry.poolId === poolId && entry.deviceType === deviceType);
			const r = right.accelerators.find((entry) => entry.poolId === poolId && entry.deviceType === deviceType);
			return {
				poolId,
				deviceType,
				count: Math.min(l?.count ?? 0, r?.count ?? 0),
				memoryBytes: Math.min(l?.memoryBytes ?? 0, r?.memoryBytes ?? 0),
			};
		});
		const providers = [...providerKeys].sort().map((poolId) => {
			const l = left.providers.find((entry) => entry.poolId === poolId);
			const r = right.providers.find((entry) => entry.poolId === poolId);
			return {
				poolId,
				concurrentRequests: Math.min(l?.concurrentRequests ?? 0, r?.concurrentRequests ?? 0),
				requestsPerMinute: Math.min(l?.requestsPerMinute ?? 0, r?.requestsPerMinute ?? 0),
				totalRequests: Math.min(l?.totalRequests ?? 0, r?.totalRequests ?? 0),
				inputTokens: Math.min(l?.inputTokens ?? 0, r?.inputTokens ?? 0),
				outputTokens: Math.min(l?.outputTokens ?? 0, r?.outputTokens ?? 0),
				idempotency: l?.idempotency ?? r?.idempotency ?? "none",
			};
		});
		return {
			cpuMilliCores: Math.min(left.cpuMilliCores, right.cpuMilliCores),
			memoryBytes: Math.min(left.memoryBytes, right.memoryBytes),
			diskBytes: Math.min(left.diskBytes, right.diskBytes),
			ioWeight: Math.min(left.ioWeight, right.ioWeight),
			accelerators,
			providers,
			networkEgressBytes: Math.min(left.networkEgressBytes, right.networkEgressBytes),
			wallMilliseconds: Math.min(left.wallMilliseconds, right.wallMilliseconds),
			monetaryMicrounits: Math.min(left.monetaryMicrounits, right.monetaryMicrounits),
		};
	};

	const subtractVector = (
		available: WorkflowResourceVector,
		reserved: WorkflowResourceVector,
	): WorkflowResourceVector => {
		if (!validVector(available) || !validVector(reserved))
			throw new WorkflowLeaseError("workflow_resource_vector_invalid");
		const subtract = (left: number, right: number): number => Math.max(0, left - right);
		const acceleratorKeys = new Set([
			...available.accelerators.map((entry) => `${entry.poolId}\u0000${entry.deviceType}`),
			...reserved.accelerators.map((entry) => `${entry.poolId}\u0000${entry.deviceType}`),
		]);
		const accelerators = [...acceleratorKeys].sort().map((key) => {
			const separator = key.indexOf("\u0000");
			const poolId = key.slice(0, separator);
			const deviceType = key.slice(separator + 1);
			const availableEntry = available.accelerators.find(
				(entry) => entry.poolId === poolId && entry.deviceType === deviceType,
			);
			const reservedEntry = reserved.accelerators.find(
				(entry) => entry.poolId === poolId && entry.deviceType === deviceType,
			);
			return {
				poolId,
				deviceType,
				count: subtract(availableEntry?.count ?? 0, reservedEntry?.count ?? 0),
				memoryBytes: subtract(availableEntry?.memoryBytes ?? 0, reservedEntry?.memoryBytes ?? 0),
			};
		});
		const providerKeys = new Set([
			...available.providers.map((entry) => entry.poolId),
			...reserved.providers.map((entry) => entry.poolId),
		]);
		const providers = [...providerKeys].sort().map((poolId) => {
			const availableEntry = available.providers.find((entry) => entry.poolId === poolId);
			const reservedEntry = reserved.providers.find((entry) => entry.poolId === poolId);
			return {
				poolId,
				concurrentRequests: subtract(
					availableEntry?.concurrentRequests ?? 0,
					reservedEntry?.concurrentRequests ?? 0,
				),
				requestsPerMinute: subtract(availableEntry?.requestsPerMinute ?? 0, reservedEntry?.requestsPerMinute ?? 0),
				totalRequests: subtract(availableEntry?.totalRequests ?? 0, reservedEntry?.totalRequests ?? 0),
				inputTokens: subtract(availableEntry?.inputTokens ?? 0, reservedEntry?.inputTokens ?? 0),
				outputTokens: subtract(availableEntry?.outputTokens ?? 0, reservedEntry?.outputTokens ?? 0),
				idempotency: availableEntry?.idempotency ?? reservedEntry?.idempotency ?? "none",
			};
		});
		return {
			cpuMilliCores: subtract(available.cpuMilliCores, reserved.cpuMilliCores),
			memoryBytes: subtract(available.memoryBytes, reserved.memoryBytes),
			diskBytes: subtract(available.diskBytes, reserved.diskBytes),
			ioWeight: subtract(available.ioWeight, reserved.ioWeight),
			accelerators,
			providers,
			networkEgressBytes: subtract(available.networkEgressBytes, reserved.networkEgressBytes),
			wallMilliseconds: subtract(available.wallMilliseconds, reserved.wallMilliseconds),
			monetaryMicrounits: subtract(available.monetaryMicrounits, reserved.monetaryMicrounits),
		};
	};

	const resourceCeiling = (controlPlane: boolean): WorkflowResourceVector => {
		const partition = controlPlane
			? dependencies.controlPartition.resourceVector
			: dependencies.workerPartition.resourceVector;
		const ceiling = minVector(dependencies.resourceCeiling, partition);
		return controlPlane ? ceiling : subtractVector(ceiling, dependencies.controlPlaneReserve);
	};

	const controlCeiling = (controlPlane: boolean): WorkflowControlCapacityVector => {
		const partition = controlPlane
			? dependencies.controlPartition.capacity
			: dependencies.workerPartition.controlCapacity;
		if (!validControl(partition) || !validControl(dependencies.observedControlCapacity))
			return zeroWorkflowControlCapacity();
		return Object.fromEntries(
			CONTROL_DIMENSIONS.map((dimension) => [
				dimension,
				Math.min(partition[dimension], dependencies.observedControlCapacity[dimension]),
			]),
		) as unknown as WorkflowControlCapacityVector;
	};

	const resourceRecords = (workflowId: string): WorkflowResourceLease[] =>
		assertHydrated().records.filter(
			(lease): lease is WorkflowResourceLease => lease.workflowId === workflowId && "resourceAdmission" in lease,
		);
	const ownershipRecords = (workflowId: string): WorkflowOwnershipLease[] =>
		assertHydrated().records.filter(
			(lease): lease is WorkflowOwnershipLease => lease.workflowId === workflowId && !("resourceAdmission" in lease),
		);

	const leaseExpired = async (lease: WorkflowResourceLease | WorkflowOwnershipLease): Promise<boolean> => {
		if (lease.status === "released" || lease.status === "quarantined") return false;
		const ttl = await dependencies.leaseTtlStore.read(lease.leaseId);
		if (ttl !== null) {
			const monotonicNow = dependencies.trustedMonotonicNow();
			if (!Number.isFinite(monotonicNow)) throw new WorkflowLeaseError("workflow_monotonic_clock_invalid");
			if (monotonicNow >= ttl.observedAtMonotonicMs) return monotonicNow >= ttl.expiresAtMonotonicMs;
		}
		const trustedNow = Date.parse(dependencies.trustedNow());
		const expiresAt = Date.parse(
			"expiresAt" in lease
				? lease.expiresAt
				: (assertHydrated().leaseRefs.get(lease.leaseId)?.expiresAt ?? "invalid"),
		);
		if (!Number.isFinite(trustedNow) || !Number.isFinite(expiresAt))
			throw new WorkflowLeaseError("workflow_lease_expiration_invalid");
		return trustedNow >= expiresAt;
	};

	const activeResourceRecords = async (workflowId: string): Promise<WorkflowResourceLease[]> => {
		const active: WorkflowResourceLease[] = [];
		for (const lease of resourceRecords(workflowId)) {
			if (lease.status !== "released" && !(await leaseExpired(lease))) active.push(lease);
		}
		return active;
	};
	const activeOwnershipRecords = async (workflowId: string): Promise<WorkflowOwnershipLease[]> => {
		const active: WorkflowOwnershipLease[] = [];
		for (const lease of ownershipRecords(workflowId)) {
			if (lease.status !== "released" && !(await leaseExpired(lease))) active.push(lease);
		}
		return active;
	};
	const activeExclusive = async (workflowId: string): Promise<boolean> =>
		(await activeResourceRecords(workflowId)).some(
			(lease) => lease.resourceAdmission.enforcementClass === "exclusive_unisolated",
		) ||
		(await activeOwnershipRecords(workflowId)).some(
			(lease) =>
				assertHydrated().ownershipReservations.get(lease.leaseId)?.enforcementClass === "exclusive_unisolated",
		);

	const activeVector = async (
		workflowId: string,
		excludeOwnershipAttemptId?: string,
	): Promise<WorkflowResourceVector> => {
		const resources = await activeResourceRecords(workflowId);
		const resourceAttempts = new Set(resources.map((lease) => lease.attemptId));
		let total = resources.reduce(
			(total, lease) => addVector(total, lease.resourceAdmission.reservedVector),
			zeroWorkflowResourceVector(),
		);
		for (const lease of await activeOwnershipRecords(workflowId)) {
			if (excludeOwnershipAttemptId !== undefined && lease.attemptId === excludeOwnershipAttemptId) continue;
			if (resourceAttempts.has(lease.attemptId)) continue;
			const reservation = assertHydrated().ownershipReservations.get(lease.leaseId);
			if (reservation === undefined) throw new WorkflowLeaseError("workflow_ownership_reservation_missing");
			total = addVector(total, reservation.vector);
		}
		return frozenClone(total);
	};

	const activeControlCapacity = async (
		workflowId: string,
		excludeOwnershipAttemptId?: string,
	): Promise<WorkflowControlCapacityVector> => {
		const resources = await activeResourceRecords(workflowId);
		const resourceAttempts = new Set(resources.map((lease) => lease.attemptId));
		let total = resources.reduce(
			(total, lease) => addControl(total, lease.controlCapacity),
			zeroWorkflowControlCapacity(),
		);
		for (const lease of await activeOwnershipRecords(workflowId)) {
			if (excludeOwnershipAttemptId !== undefined && lease.attemptId === excludeOwnershipAttemptId) continue;
			if (resourceAttempts.has(lease.attemptId)) continue;
			const reservation = assertHydrated().ownershipReservations.get(lease.leaseId);
			if (reservation === undefined) throw new WorkflowLeaseError("workflow_ownership_reservation_missing");
			total = addControl(total, reservation.controlCapacity);
		}
		return frozenClone(total);
	};

	const leaseRefFor = (
		lease: WorkflowResourceLease | WorkflowOwnershipLease,
		current: WorkflowLeaseRef,
	): WorkflowLeaseRef => {
		if ("resourceAdmission" in lease) return leaseRefOfResource(lease);
		return {
			storeEpoch: lease.storeEpoch,
			coordinatorEpoch: lease.coordinatorEpoch,
			leaseId: lease.leaseId,
			acquisitionEventSequence: lease.acquisitionEventSequence,
			processIdentity: current.processIdentity,
			rootDigest: current.rootDigest,
			writerIdentity: current.writerIdentity,
			acquiredAt: current.acquiredAt,
			expiresAt: current.expiresAt,
		};
	};

	const sameLeaseRef = (left: WorkflowLeaseRef, right: WorkflowLeaseRef): boolean =>
		digestObject(left) === digestObject(right);

	const leaseIdentity = (kind: WorkflowLeaseKind, input: WorkflowLeaseRequest): string =>
		`${kind}:${input.workflowId}:${input.attemptId}`;

	const readTask = async (workflowId: string, taskId: string): Promise<WorkflowTask> => {
		const task =
			dependencies.readTask !== undefined
				? await dependencies.readTask(workflowId, taskId)
				: (dependencies.taskGraph?.byId.get(taskId) ?? null);
		if (task === null || task === undefined) throw new WorkflowLeaseError("workflow_task_binding_unavailable");
		return task;
	};

	const assertAdmissionBinding = async (input: WorkflowLeaseRequest): Promise<WorkflowTask> => {
		if (dependencies.readAdmissionBinding === undefined || dependencies.readGrant === undefined)
			throw new WorkflowLeaseError("workflow_admission_binding_unavailable");
		const admission = await dependencies.readAdmissionBinding(
			input.workflowId,
			input.taskId,
			input.attemptId,
			input.executionKey,
		);
		if (
			admission === null ||
			admission.workflowId !== input.workflowId ||
			admission.taskId !== input.taskId ||
			admission.attemptId !== input.attemptId ||
			admission.executionKey !== input.executionKey ||
			!sameEpoch(admission.epochRef, input.epochRef) ||
			digestObject(admission.controlCapacity) !== digestObject(input.controlCapacity)
		)
			throw new WorkflowLeaseError("workflow_admission_binding_mismatch");
		const task = await readTask(input.workflowId, input.taskId);
		if (
			(task.attemptIds.length > 0 && !task.attemptIds.includes(input.attemptId)) ||
			digestObject(task.declaredResourceVector) !== digestObject(input.vector) ||
			digestObject(task.declaredControlCapacity) !== digestObject(input.controlCapacity)
		)
			throw new WorkflowLeaseError("workflow_task_binding_mismatch");
		const grant = await dependencies.readGrant(input);
		if (
			grant === null ||
			grant.workflowId !== input.workflowId ||
			grant.taskId !== input.taskId ||
			grant.attemptId !== input.attemptId ||
			grant.executionKey !== input.executionKey ||
			!sameEpoch(grant.epochRef, input.epochRef) ||
			digestObject(grant.vector) !== digestObject(input.vector) ||
			digestObject(grant.controlCapacity) !== digestObject(input.controlCapacity) ||
			grant.grantDigest.length === 0 ||
			grant.canonicalLedgerDigest !== dependencies.canonicalPoolLedgerRef.digest
		)
			throw new WorkflowLeaseError("workflow_grant_binding_mismatch");
		return task;
	};

	const assertRequest = async (
		input: WorkflowLeaseRequest,
		kind: WorkflowLeaseKind,
	): Promise<WorkflowActiveLeaseContext> => {
		if (
			input.workflowId !== dependencies.store.identity.workflowId ||
			input.taskId.length === 0 ||
			input.attemptId.length === 0 ||
			input.executionKey.length === 0 ||
			input.conflictKey.length === 0 ||
			input.queuedAt.length === 0 ||
			(input.enforcementClass !== "isolated_metered" &&
				input.enforcementClass !== "host_bounded" &&
				input.enforcementClass !== "exclusive_unisolated")
		)
			throw new WorkflowLeaseError("workflow_lease_binding_invalid");
		const current = await assertEpoch(input.workflowId, input.epochRef);
		await assertRevision(input.workflowId, input.epochRef, input.executionKey);
		if (!validVector(input.vector) || !validControl(input.controlCapacity))
			throw new WorkflowLeaseError("workflow_resource_vector_invalid");
		checkedNumber(input.processSlots, "workflow_process_slots_invalid");
		checkedNumber(input.queuePriority, "workflow_queue_priority_invalid");
		if (input.processSlots !== input.controlCapacity.processSlots)
			throw new WorkflowLeaseError("workflow_control_capacity_binding_mismatch");
		if (
			input.enforcementClass === "exclusive_unisolated" &&
			CONTROL_DIMENSIONS.some((dimension) => input.controlCapacity[dimension] > 0)
		)
			throw new WorkflowLeaseError("workflow_unisolated_control_capacity_forbidden");
		if (!input.controlPlane && CONTROL_DIMENSIONS.some((dimension) => input.controlCapacity[dimension] !== 0))
			throw new WorkflowLeaseError("workflow_worker_control_capacity_forbidden");
		if (
			kind === "ownership" &&
			(input.controlPlane || CONTROL_DIMENSIONS.some((dimension) => input.controlCapacity[dimension] !== 0))
		)
			throw new WorkflowLeaseError("workflow_ownership_control_capacity_forbidden");
		await assertAdmissionBinding(input);
		return current;
	};

	const assertOwnershipPaths = async (
		paths: readonly string[],
		contracts: readonly string[],
	): Promise<readonly string[]> => {
		let canonicalRoot: string;
		try {
			const rootStat = await lstat(dependencies.workflowRoot);
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("workflow_root_invalid");
			canonicalRoot = await realpath(dependencies.workflowRoot);
		} catch {
			throw new WorkflowLeaseError("workflow_ownership_root_unavailable");
		}
		const canonical = paths.map((path) => {
			try {
				if (typeof path !== "string") throw new Error("workflow_path_invalid");
				const parts = parseWorkflowCanonicalPath(path);
				const candidate = resolve(canonicalRoot, ...parts);
				const escaped = relative(canonicalRoot, candidate);
				if (escaped === ".." || escaped.startsWith("../") || resolve(canonicalRoot, escaped) !== candidate)
					throw new Error("workflow_path_escape");
				return { path, parts };
			} catch {
				throw new WorkflowLeaseError("workflow_ownership_path_invalid");
			}
		});
		for (const entry of canonical) {
			let currentPath = canonicalRoot;
			for (const part of entry.parts) {
				currentPath = resolve(currentPath, part);
				try {
					const stats = await lstat(currentPath);
					if (stats.isSymbolicLink()) throw new WorkflowLeaseError("workflow_ownership_path_symlink");
				} catch (error) {
					if (error instanceof WorkflowLeaseError) throw error;
					if (
						error instanceof Error &&
						typeof (error as Error & { code?: unknown }).code === "string" &&
						(error as Error & { code: string }).code === "ENOENT"
					)
						break;
					throw new WorkflowLeaseError("workflow_ownership_path_unavailable");
				}
			}
		}
		if (
			canonical.length !== new Set(canonical.map((entry) => entry.path)).size ||
			contracts.length !== new Set(contracts).size ||
			contracts.some((contract) => typeof contract !== "string" || contract.length === 0)
		)
			throw new WorkflowLeaseError("workflow_ownership_contract_invalid");
		return Object.freeze(canonical.map((entry) => entry.path).sort());
	};

	const pathOverlaps = (left: string, right: string): boolean => {
		const leftParts = left.split("/");
		const rightParts = right.split("/");
		const prefix = (shorter: readonly string[], longer: readonly string[]): boolean =>
			shorter.length <= longer.length && shorter.every((part, index) => part === longer[index]);
		return prefix(leftParts, rightParts) || prefix(rightParts, leftParts);
	};

	const positiveSequence = (head: WorkflowJournalHead): number => {
		if (!Number.isSafeInteger(head.sequence) || head.sequence < 0 || head.sequence >= Number.MAX_SAFE_INTEGER)
			throw new WorkflowLeaseError("workflow_lease_acquisition_sequence_invalid");
		return head.sequence + 1;
	};

	const ttlExpiry = async (
		leaseId: string,
	): Promise<{
		acquiredAt: string;
		expiresAt: string;
		next: { sequence: number; observedAtMonotonicMs: number; expiresAtMonotonicMs: number };
	}> => {
		if (
			!Number.isSafeInteger(dependencies.resourceLeaseTtlMilliseconds) ||
			dependencies.resourceLeaseTtlMilliseconds <= 0
		)
			throw new WorkflowLeaseError("workflow_lease_ttl_invalid");
		const previous = await dependencies.leaseTtlStore.read(leaseId);
		const monotonicNow = dependencies.trustedMonotonicNow();
		if (!Number.isFinite(monotonicNow)) throw new WorkflowLeaseError("workflow_monotonic_clock_invalid");
		const next = {
			sequence: (previous?.sequence ?? 0) + 1,
			observedAtMonotonicMs: monotonicNow,
			expiresAtMonotonicMs: monotonicNow + dependencies.resourceLeaseTtlMilliseconds,
		};
		if (
			!Number.isSafeInteger(next.sequence) ||
			next.sequence <= 0 ||
			next.expiresAtMonotonicMs <= next.observedAtMonotonicMs ||
			(previous !== null &&
				(next.sequence <= previous.sequence ||
					next.observedAtMonotonicMs < previous.observedAtMonotonicMs ||
					next.expiresAtMonotonicMs < previous.expiresAtMonotonicMs))
		)
			throw new WorkflowLeaseError("workflow_monotonic_ttl_invalid");
		const trustedNow = dependencies.trustedNow();
		const trustedNowMilliseconds = Date.parse(trustedNow);
		if (!Number.isFinite(trustedNowMilliseconds)) throw new WorkflowLeaseError("workflow_lease_clock_invalid");
		const expiresAt = new Date(trustedNowMilliseconds + dependencies.resourceLeaseTtlMilliseconds).toISOString();
		return { acquiredAt: trustedNow, expiresAt, next };
	};

	const commitEvent = async <TPayload extends WorkflowEventPayload>(
		workflowId: string,
		payload: TPayload,
		epochRef: WorkflowEpochRef,
		leaseRef: WorkflowLeaseRef,
		idempotencyKey: string,
		executionKey: string | null,
		expectedHead?: WorkflowJournalHead,
	) => {
		await assertRevision(workflowId, epochRef, executionKey);
		await dependencies.epochs.assertCurrent(workflowId, epochRef);
		const head =
			expectedHead ??
			(await dependencies.store.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch }))
				.head;
		const result = await commitAuthenticated(dependencies.store, {
			workflowId,
			payload,
			expectedHead: head,
			epochRef,
			leaseRef,
			idempotencyKey,
			writerIdentity: dependencies.writerIdentity,
			executionKey,
		});
		return result;
	};

	const validEpochRef = (value: unknown): value is WorkflowEpochRef =>
		isRecord(value) &&
		Number.isSafeInteger(value.storeEpoch) &&
		(value.storeEpoch as number) > 0 &&
		Number.isSafeInteger(value.coordinatorEpoch) &&
		(value.coordinatorEpoch as number) > 0;

	const validLeaseRef = (value: unknown): value is WorkflowLeaseRef =>
		isRecord(value) &&
		validEpochRef(value) &&
		typeof value.leaseId === "string" &&
		value.leaseId.length > 0 &&
		Number.isSafeInteger(value.acquisitionEventSequence) &&
		(value.acquisitionEventSequence as number) >= 0 &&
		typeof value.processIdentity === "string" &&
		value.processIdentity.length > 0 &&
		typeof value.rootDigest === "string" &&
		value.rootDigest.length > 0 &&
		typeof value.writerIdentity === "string" &&
		value.writerIdentity.length > 0 &&
		typeof value.acquiredAt === "string" &&
		value.acquiredAt.length > 0 &&
		typeof value.expiresAt === "string" &&
		value.expiresAt.length > 0 &&
		Number.isFinite(Date.parse(value.acquiredAt)) &&
		Number.isFinite(Date.parse(value.expiresAt)) &&
		Date.parse(value.expiresAt) > Date.parse(value.acquiredAt);

	const assertReplayEvent = (event: unknown, sequence: number, workflowId: string): WorkflowEventPayload => {
		if (!isRecord(event) || event.sequence !== sequence || event.workflowId !== workflowId)
			throw new WorkflowLeaseError("workflow_lease_replay_invalid");
		const payload = event.payload;
		if (!isRecord(payload) || ("workflowId" in payload && payload.workflowId !== workflowId))
			throw new WorkflowLeaseError("workflow_lease_replay_invalid");
		if (
			!validEpochRef(event.epochRef) ||
			!validLeaseRef(event.leaseRef) ||
			typeof event.idempotencyKey !== "string" ||
			event.idempotencyKey.length === 0 ||
			typeof event.writerIdentity !== "string" ||
			event.writerIdentity.length === 0 ||
			(event.executionKey !== null && typeof event.executionKey !== "string") ||
			!isRecord(event.expectedHead) ||
			event.expectedHead.workflowId !== workflowId ||
			event.expectedHead.sequence !== sequence - 1 ||
			!validEpochRef(event.expectedHead.epochRef) ||
			!sameEpoch(event.expectedHead.epochRef, event.epochRef) ||
			!sameEpoch(event.leaseRef, event.epochRef)
		)
			throw new WorkflowLeaseError("workflow_lease_replay_invalid");
		if (
			(payload.epochRef !== undefined &&
				(!validEpochRef(payload.epochRef) || !sameEpoch(payload.epochRef, event.epochRef))) ||
			("executionKey" in payload && payload.executionKey !== event.executionKey)
		)
			throw new WorkflowLeaseError("workflow_lease_replay_invalid");
		return payload as unknown as WorkflowEventPayload;
	};

	const ownershipReservationFromEvent = (
		event: { idempotencyKey: string; executionKey: string | null },
		lease: WorkflowOwnershipLease,
	): WorkflowOwnershipReservation => {
		const binding = decodeOwnershipBinding(event.idempotencyKey);
		if (
			binding === null ||
			binding.workflowId !== lease.workflowId ||
			binding.taskId !== lease.taskId ||
			binding.attemptId !== lease.attemptId ||
			binding.executionKey !== event.executionKey ||
			!validVector(binding.vector) ||
			!validControl(binding.controlCapacity) ||
			(!binding.controlPlane && CONTROL_DIMENSIONS.some((dimension) => binding.controlCapacity[dimension] !== 0))
		)
			throw new WorkflowLeaseError("workflow_lease_replay_invalid");
		return {
			vector: frozenClone(binding.vector),
			controlCapacity: frozenClone(binding.controlCapacity),
			conflictKeyDigest: digestObject(binding.conflictKey),
			enforcementClass: binding.enforcementClass,
			controlPlane: binding.controlPlane,
		};
	};

	const hydrateFromReplay = async (): Promise<void> => {
		const current = await activeContext();
		const replay = await dependencies.store.replay({
			workflowId: current.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: current.epochRef.storeEpoch,
		});
		if (replay.quarantined) throw new WorkflowLeaseError("workflow_store_quarantined");
		if (
			replay.workflowId !== current.workflowId ||
			replay.head.epochRef.storeEpoch !== current.epochRef.storeEpoch ||
			replay.head.epochRef.coordinatorEpoch !== current.epochRef.coordinatorEpoch
		)
			throw new WorkflowLeaseError("workflow_epoch_stale");
		const next = EMPTY_FOLD();
		let expectedSequence = 1;
		for (const event of replay.events) {
			const payload = assertReplayEvent(event, expectedSequence, current.workflowId);
			expectedSequence += 1;
			if (
				payload.kind === "workflow_resource_lease_acquired" ||
				payload.kind === "workflow_ownership_lease_acquired"
			) {
				if (
					typeof event.executionKey !== "string" ||
					event.executionKey.length === 0 ||
					payload.epochRef.storeEpoch !== payload.lease.storeEpoch ||
					payload.epochRef.coordinatorEpoch !== payload.lease.coordinatorEpoch ||
					payload.lease.acquisitionEventSequence !== event.sequence ||
					payload.lease.workflowId !== payload.workflowId ||
					(payload.kind === "workflow_resource_lease_acquired" &&
						event.idempotencyKey !== payload.lease.idempotencyKey) ||
					(payload.kind === "workflow_ownership_lease_acquired" &&
						decodeOwnershipBinding(event.idempotencyKey)?.workflowId !== payload.workflowId)
				)
					throw new WorkflowLeaseError("workflow_lease_replay_invalid");
				const existing = next.records.find((lease) => lease.leaseId === payload.lease.leaseId);
				if (existing === undefined) {
					next.records.push(structuredClone(payload.lease));
					next.leaseRefs.set(payload.lease.leaseId, leaseRefFor(payload.lease, current.leaseRef));
					if (payload.kind === "workflow_ownership_lease_acquired")
						next.ownershipReservations.set(
							payload.lease.leaseId,
							ownershipReservationFromEvent(event, payload.lease),
						);
				} else if (digestObject(existing) !== digestObject(payload.lease)) {
					existing.status = "quarantined";
					next.quarantined.set(
						payload.lease.leaseId,
						next.leaseRefs.get(payload.lease.leaseId) ?? leaseRefFor(payload.lease, current.leaseRef),
					);
				}
				if (payload.lease.attemptId !== null && payload.lease.attemptId !== undefined)
					next.executionKeys.set(payload.lease.leaseId, event.executionKey ?? "");
				continue;
			}
			if (payload.kind === "workflow_dispatch_intent") {
				if (typeof payload.executionKey !== "string" || payload.executionKey.length === 0)
					throw new WorkflowLeaseError("workflow_lease_replay_invalid");
				for (const leaseRef of [payload.resourceLeaseRef, payload.ownershipLeaseRef]) {
					if (leaseRef !== null) {
						const lease = next.records.find((candidate) => candidate.leaseId === leaseRef.leaseId);
						const expectedRef = next.leaseRefs.get(leaseRef.leaseId);
						if (lease === undefined || expectedRef === undefined || !sameLeaseRef(expectedRef, leaseRef))
							throw new WorkflowLeaseError("workflow_lease_replay_invalid");
						if (lease.attemptId !== payload.attemptId)
							throw new WorkflowLeaseError("workflow_lease_replay_invalid");
						next.executionKeys.set(leaseRef.leaseId, payload.executionKey);
					}
				}
				continue;
			}
			if (payload.kind === "workflow_child_outcome_committed") {
				if (typeof payload.executionKey !== "string" || payload.executionKey.length === 0)
					throw new WorkflowLeaseError("workflow_lease_replay_invalid");
				if (!next.records.some((lease) => lease.attemptId === payload.attemptId))
					throw new WorkflowLeaseError("workflow_lease_replay_invalid");
				for (const lease of next.records)
					if (lease.attemptId === payload.attemptId) next.executionKeys.set(lease.leaseId, payload.executionKey);
				continue;
			}
			if (payload.kind === "workflow_process_group_fenced") {
				const attemptLeases = next.records.filter((lease) => lease.attemptId === payload.attemptId);
				if (
					!isRecord(payload.processGroup) ||
					attemptLeases.length === 0 ||
					payload.processGroup.identityDigest !==
						canonicalWorkflowProcessGroupDigest(payload.processGroup as never) ||
					!sameEpoch(payload.epochRef, event.epochRef) ||
					attemptLeases.some((lease) => next.executionKeys.get(lease.leaseId) !== event.executionKey)
				)
					throw new WorkflowLeaseError("workflow_lease_replay_invalid");
				continue;
			}
			if (payload.kind === "workflow_process_group_reaped") {
				const attemptLeases = next.records.filter((lease) => lease.attemptId === payload.attemptId);
				if (
					!Array.isArray(payload.remainingPids) ||
					!payload.remainingPids.every((pid) => Number.isSafeInteger(pid) && pid >= 0) ||
					typeof payload.reapDigest !== "string" ||
					payload.reapDigest.length === 0 ||
					attemptLeases.length === 0 ||
					attemptLeases.some((lease) => next.executionKeys.get(lease.leaseId) !== event.executionKey)
				)
					throw new WorkflowLeaseError("workflow_lease_replay_invalid");
				continue;
			}
			if (payload.kind === "workflow_lease_release_recorded") {
				const lease = next.records.find((candidate) => candidate.leaseId === payload.releaseRef.leaseRef.leaseId);
				const expectedRef = next.leaseRefs.get(payload.releaseRef.leaseRef.leaseId);
				if (
					lease === undefined ||
					expectedRef === undefined ||
					!sameLeaseRef(expectedRef, payload.releaseRef.leaseRef) ||
					lease.attemptId !== payload.releaseRef.attemptId ||
					next.executionKeys.get(lease.leaseId) !== event.executionKey ||
					payload.releaseRef.releaseEventSequence !== event.sequence ||
					payload.releaseRef.terminalOutcomeDigest.length === 0 ||
					payload.releaseRef.releaseProof.length === 0
				)
					throw new WorkflowLeaseError("workflow_lease_replay_invalid");
				lease.status = "released";
				lease.releaseEventSequence = event.sequence;
				next.released.set(lease.leaseId, payload.releaseRef.leaseRef);
				continue;
			}
			if (payload.kind === "workflow_lease_quarantined") {
				const lease = next.records.find((candidate) => candidate.leaseId === payload.leaseRef.leaseId);
				const expectedRef = next.leaseRefs.get(payload.leaseRef.leaseId);
				if (lease === undefined || expectedRef === undefined || !sameLeaseRef(expectedRef, payload.leaseRef))
					throw new WorkflowLeaseError("workflow_lease_replay_invalid");
				lease.status = "quarantined";
				next.quarantined.set(payload.leaseRef.leaseId, payload.leaseRef);
			}
		}
		fold = next;
		hydrated = true;
	};

	const releasePreDispatch = async (input: WorkflowLeasePreDispatchReleaseInput): Promise<void> => {
		assertHydrated();
		if (input.workflowId !== dependencies.store.identity.workflowId)
			throw new WorkflowLeaseError("workflow_store_mismatch");
		const current = await assertEpoch(input.workflowId, input.epochRef);
		const leases = [input.releaseResourceLease === false ? null : input.resourceLease, input.ownershipLease].filter(
			(lease): lease is WorkflowResourceLease | WorkflowOwnershipLease => lease !== null,
		);
		for (const lease of leases) {
			const persisted = assertHydrated().records.find((candidate) => candidate.leaseId === lease.leaseId);
			const comparisonLease =
				persisted?.status === "released"
					? { ...persisted, status: "active" as const, releaseEventSequence: null }
					: persisted;
			if (
				persisted === undefined ||
				persisted.workflowId !== input.workflowId ||
				persisted.attemptId !== input.attemptId ||
				(input.taskId !== undefined && persisted.taskId !== input.taskId) ||
				comparisonLease === undefined ||
				digestObject(comparisonLease) !== digestObject(lease)
			)
				throw new WorkflowLeaseError("workflow_lease_input_mismatch");
			const boundExecutionKey = assertHydrated().executionKeys.get(lease.leaseId);
			if (boundExecutionKey !== undefined && boundExecutionKey !== "" && boundExecutionKey !== input.executionKey)
				throw new WorkflowLeaseError("workflow_execution_binding_mismatch");
			const expectedRef = assertHydrated().leaseRefs.get(lease.leaseId) ?? leaseRefFor(persisted, current.leaseRef);
			if (!sameLeaseRef(expectedRef, "resourceAdmission" in persisted ? leaseRefOfResource(persisted) : expectedRef))
				throw new WorkflowLeaseError("workflow_lease_binding_mismatch");
			if (persisted.status === "released") continue;
			const replay = await dependencies.store.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.epochRef.storeEpoch,
			});
			const releaseEventSequence = positiveSequence(replay.head);
			const reason = input.reason ?? "workflow_dispatch_rollback";
			const terminalOutcomeDigest = digestObject({
				kind: "workflow_dispatch_rollback",
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				executionKey: input.executionKey,
				leaseId: persisted.leaseId,
				reason,
			});
			const releaseRef: WorkflowLeaseReleaseRef = {
				leaseRef: expectedRef,
				attemptId: input.attemptId,
				terminalOutcomeDigest,
				releaseEventSequence,
				releaseProof: digestObject({ terminalOutcomeDigest, releaseEventSequence }),
			};
			const committed = await commitEvent(
				input.workflowId,
				{
					kind: "workflow_lease_release_recorded",
					workflowId: input.workflowId,
					releaseRef,
					epochRef: input.epochRef,
					status: "released",
				},
				input.epochRef,
				current.leaseRef,
				`lease-release-pre-dispatch:${persisted.leaseId}:${input.executionKey}`,
				input.executionKey,
				replay.head,
			);
			if (committed.commit.sequence !== releaseEventSequence && committed.status !== "already_committed")
				throw new WorkflowLeaseError("workflow_release_sequence_mismatch");
		}
		await hydrateFromReplay();
	};

	const reserveDispatch = async (
		input: WorkflowLeaseDispatchReservationInput,
	): Promise<WorkflowLeaseDispatchReservation> => {
		assertHydrated();
		const durable = dependencies.store.durableContext;
		if (durable === undefined) throw new WorkflowLeaseError("workflow_atomic_transaction_required");
		if (
			input.workflowId !== dependencies.store.identity.workflowId ||
			input.resource.workflowId !== input.workflowId ||
			input.resource.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
			input.resource.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
			(input.ownership !== null &&
				(input.ownership.workflowId !== input.workflowId ||
					input.ownership.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
					input.ownership.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch))
		)
			throw new WorkflowLeaseError("workflow_lease_binding_invalid");
		return durable.withExclusiveLease("workflow-dispatch-admission", async () => {
			const baseline = await dependencies.store.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.epochRef.storeEpoch,
			});
			if (
				(input.expectedHead !== undefined && digestObject(input.expectedHead) !== digestObject(baseline.head)) ||
				(input.expectedHeadDigest !== undefined && input.expectedHeadDigest !== digestObject(baseline.head))
			)
				throw new WorkflowLeaseError("workflow_dispatch_head_stale");
			await hydrateFromReplay();
			const baselineLeaseIds = new Set(
				baseline.events.flatMap((event) =>
					event.payload.kind === "workflow_resource_lease_acquired" ||
					event.payload.kind === "workflow_ownership_lease_acquired"
						? [event.payload.lease.leaseId]
						: [],
				),
			);
			let resourceLease: WorkflowResourceLease | undefined;
			let ownershipLease: WorkflowOwnershipLease | null = null;
			try {
				resourceLease = await acquireResource(input.resource);
				ownershipLease = input.ownership === null ? null : await acquireOwnership(input.ownership);
				if (input.onLeasesAcquired !== undefined) {
					await input.onLeasesAcquired(resourceLease, ownershipLease);
				}
				const context = input.createAdmissionContext(resourceLease, ownershipLease);
				const resourceLeaseRef = leaseRefOfResource(resourceLease);
				const ownerLeaseRef =
					ownershipLease === null
						? null
						: (assertHydrated().leaseRefs.get(ownershipLease.leaseId) ??
							leaseRefFor(ownershipLease, (await activeContext()).leaseRef));
				if (
					context.workflowId !== input.workflowId ||
					context.taskId !== input.resource.taskId ||
					context.attemptId !== input.resource.attemptId ||
					context.executionKey !== input.resource.executionKey ||
					!sameEpoch(context.epochRef, input.epochRef) ||
					context.writerIdentity !== dependencies.writerIdentity ||
					digestObject(context.resourceLeaseRef) !== digestObject(resourceLeaseRef) ||
					digestObject(context.ownershipLeaseRef) !== digestObject(ownerLeaseRef)
				)
					throw new WorkflowLeaseError("workflow_dispatch_admission_binding_mismatch");
				if (input.commitQueueState !== undefined) {
					await input.commitQueueState();
				}
				if (input.onQueueCommitted !== undefined) {
					await input.onQueueCommitted();
				}
				if (input.verifyRecipeAdmissionReceipt !== undefined) await input.verifyRecipeAdmissionReceipt();
				if (input.consumeRecipeAdmission !== undefined) {
					await input.consumeRecipeAdmission();
				}
				const intentHead = await dependencies.store.replay({
					workflowId: input.workflowId,
					fromSequence: 0,
					expectedStoreEpoch: input.epochRef.storeEpoch,
				});
				const admission = await dependencies.admission.admit(context, intentHead.head);
				const committed = await dependencies.store.replay({
					workflowId: input.workflowId,
					fromSequence: 0,
					expectedStoreEpoch: input.epochRef.storeEpoch,
				});
				const intents = committed.events.filter(
					(event) =>
						event.payload.kind === "workflow_dispatch_intent" &&
						event.payload.executionKey === context.executionKey,
				);
				const intent = intents.length === 1 ? intents[0] : undefined;
				if (
					intent === undefined ||
					intent.payload.kind !== "workflow_dispatch_intent" ||
					intent.payload.workflowId !== context.workflowId ||
					intent.payload.taskId !== context.taskId ||
					intent.payload.attemptId !== context.attemptId ||
					intent.payload.admissionId !== admission.admissionId ||
					intent.payload.executionKey !== context.executionKey ||
					!sameEpoch(intent.payload.epochRef, context.epochRef) ||
					intent.executionKey !== context.executionKey ||
					intent.idempotencyKey !== context.idempotencyKey ||
					intent.writerIdentity !== dependencies.writerIdentity ||
					digestObject(intent.payload.resourceLeaseRef) !== digestObject(context.resourceLeaseRef) ||
					digestObject(intent.payload.ownershipLeaseRef) !== digestObject(context.ownershipLeaseRef) ||
					(intent.sequence > intentHead.head.sequence &&
						digestObject(intent.expectedHead) !== digestObject(intentHead.head))
				)
					throw new WorkflowLeaseError("workflow_dispatch_intent_missing");
				await hydrateFromReplay();
				return {
					resourceLease: frozenClone(resourceLease),
					ownershipLease: ownershipLease === null ? null : frozenClone(ownershipLease),
					admission,
				};
			} catch (error: unknown) {
				let rollbackError: unknown;
				if (input.rollbackQueueState !== undefined) {
					try {
						await input.rollbackQueueState();
					} catch (queueError: unknown) {
						rollbackError = queueError;
					}
				}
				try {
					await hydrateFromReplay();
				} catch (hydrateError: unknown) {
					rollbackError ??= hydrateError;
				}
				resourceLease ??= assertHydrated().records.find(
					(lease): lease is WorkflowResourceLease =>
						"resourceAdmission" in lease && lease.leaseId === leaseIdentity("resource", input.resource),
				);
				ownershipLease ??=
					assertHydrated().records.find(
						(lease): lease is WorkflowOwnershipLease =>
							!("resourceAdmission" in lease) &&
							input.ownership !== null &&
							lease.leaseId === leaseIdentity("ownership", input.ownership),
					) ?? null;
				const rollbackResource =
					resourceLease !== undefined && !baselineLeaseIds.has(resourceLease.leaseId) ? resourceLease : undefined;
				const rollbackOwnership =
					ownershipLease !== null && !baselineLeaseIds.has(ownershipLease.leaseId) ? ownershipLease : null;
				if (rollbackResource !== undefined || rollbackOwnership !== null) {
					await releasePreDispatch({
						workflowId: input.workflowId,
						taskId: input.resource.taskId,
						attemptId: input.resource.attemptId,
						epochRef: input.epochRef,
						executionKey: input.resource.executionKey,
						resourceLease: rollbackResource ?? resourceLease!,
						ownershipLease: rollbackOwnership,
						releaseResourceLease: rollbackResource !== undefined,
						reason: "workflow_dispatch_transaction_failed",
					});
				}
				if (rollbackError !== undefined) throw rollbackError;
				throw error;
			}
		});
	};

	const acquireResource = async (input: WorkflowLeaseRequest): Promise<WorkflowResourceLease> => {
		assertHydrated();
		const current = await assertRequest(input, "resource");
		const existingId = leaseIdentity("resource", input);
		const existing = assertHydrated().records.find((lease) => lease.leaseId === existingId);
		if (existing !== undefined) {
			if (
				!("resourceAdmission" in existing) ||
				existing.workflowId !== input.workflowId ||
				existing.taskId !== input.taskId ||
				existing.attemptId !== input.attemptId ||
				existing.idempotencyKey !== `resource:${input.attemptId}` ||
				digestObject(existing.resourceAdmission.declaredVector) !== digestObject(input.vector) ||
				digestObject(existing.controlCapacity) !== digestObject(input.controlCapacity) ||
				existing.resourceAdmission.enforcementClass !== input.enforcementClass
			)
				throw new WorkflowLeaseError("workflow_lease_binding_conflict");
			if (
				assertHydrated().executionKeys.get(existing.leaseId) !== undefined &&
				assertHydrated().executionKeys.get(existing.leaseId) !== "" &&
				assertHydrated().executionKeys.get(existing.leaseId) !== input.executionKey
			)
				throw new WorkflowLeaseError("workflow_execution_binding_mismatch");
			if (existing.status === "released" || existing.status === "quarantined")
				throw new WorkflowLeaseError("workflow_lease_reuse_forbidden");
			if (await leaseExpired(existing)) throw new WorkflowLeaseError("workflow_lease_expired");
			return frozenClone(existing);
		}
		const active = await activeVector(input.workflowId, input.attemptId);
		const activeControl = await activeControlCapacity(input.workflowId, input.attemptId);
		const exclusiveActive = await activeExclusive(input.workflowId);
		if (
			input.enforcementClass === "exclusive_unisolated" &&
			(exclusiveActive ||
				CONTROL_DIMENSIONS.some((dimension) => activeControl[dimension] > 0) ||
				!fitsVector(active, zeroWorkflowResourceVector()))
		)
			throw new WorkflowLeaseError("workflow_exclusive_unisolated_busy");
		if (input.enforcementClass !== "exclusive_unisolated" && exclusiveActive)
			throw new WorkflowLeaseError("workflow_exclusive_unisolated_busy");
		const requestedVector = addVector(active, input.vector);
		const requestedControl = addControl(activeControl, input.controlCapacity);
		if (
			!fitsVector(requestedVector, resourceCeiling(input.controlPlane)) ||
			!fitsControl(requestedControl, controlCeiling(input.controlPlane))
		)
			throw new WorkflowLeaseError("workflow_resource_limit");
		const replay = await dependencies.store.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const acquisitionEventSequence = positiveSequence(replay.head);
		const leaseId = existingId;
		const ttl = await ttlExpiry(leaseId);
		const acquiredAt = ttl.acquiredAt;
		const expiresAt = ttl.expiresAt;
		const zeroControl = zeroWorkflowControlCapacity() as WorkflowZeroControlCapacityVector;
		const grantControl = input.controlPlane ? input.controlCapacity : zeroControl;
		const capacityGrant: WorkflowCapacityGrant = input.controlPlane
			? {
					kind: "control",
					grantId: `grant:${input.attemptId}`,
					resourceVector: input.vector,
					controlCapacity: input.controlCapacity,
					canonicalPoolLedgerRef: dependencies.canonicalPoolLedgerRef,
					grantDigest: digestObject({
						kind: "control",
						input,
						canonicalPoolLedgerRef: dependencies.canonicalPoolLedgerRef,
					}),
				}
			: {
					kind: "worker",
					grantId: `grant:${input.attemptId}`,
					resourceVector: input.vector,
					controlCapacity: zeroControl,
					canonicalPoolLedgerRef: dependencies.canonicalPoolLedgerRef,
					grantDigest: digestObject({
						kind: "worker",
						input,
						canonicalPoolLedgerRef: dependencies.canonicalPoolLedgerRef,
					}),
				};
		const admission: WorkflowResourceAdmission = {
			capacityGrant,
			canonicalPoolLedgerRef: dependencies.canonicalPoolLedgerRef,
			controlCapacity: grantControl,
			controlCapacityProjectionDigest: digestObject(grantControl),
			declaredVector: input.vector,
			hostDerivedConservativeVector: input.vector,
			reservedVector: input.vector,
			declaredControlCapacity: input.controlCapacity,
			hostDerivedControlCapacity: input.controlCapacity,
			reservedControlCapacity: input.controlCapacity,
			derivationPolicyDigest: digestObject({
				enforcementClass: input.enforcementClass,
				controlPlane: input.controlPlane,
			}),
			enforcementClass: input.enforcementClass,
			unknownPoolIds: [],
			canonicalLedgerRef: dependencies.canonicalPoolLedgerRef,
			canonicalLedgerDigest: dependencies.canonicalPoolLedgerRef.digest,
			admitted: true,
			admissionDigest: digestObject({ input, capacityGrant }),
		};
		const lease: WorkflowResourceLease = {
			leaseId,
			workflowId: input.workflowId,
			taskId: input.taskId,
			attemptId: input.attemptId,
			holderIdentity: dependencies.writerIdentity,
			resourceAdmission: admission,
			controlCapacity: grantControl,
			workerCapacity: input.controlPlane ? zeroControl : input.controlCapacity,
			status: "active",
			storeEpoch: input.epochRef.storeEpoch,
			coordinatorEpoch: input.epochRef.coordinatorEpoch,
			acquisitionEventSequence,
			idempotencyKey: `resource:${input.attemptId}`,
			acquiredAt,
			expiresAt,
			releaseEventSequence: null,
		};
		const committed = await commitEvent(
			input.workflowId,
			{ kind: "workflow_resource_lease_acquired", workflowId: input.workflowId, lease, epochRef: input.epochRef },
			input.epochRef,
			current.leaseRef,
			lease.idempotencyKey,
			input.executionKey,
			replay.head,
		);
		const sequence = committed.commit.sequence;
		if (sequence !== acquisitionEventSequence)
			throw new WorkflowLeaseError("workflow_lease_acquisition_sequence_mismatch");
		try {
			await dependencies.leaseTtlStore.write(leaseId, ttl.next);
		} catch (error) {
			try {
				const afterCommit = await dependencies.store.replay({
					workflowId: input.workflowId,
					fromSequence: 0,
					expectedStoreEpoch: input.epochRef.storeEpoch,
				});
				await commitEvent(
					input.workflowId,
					{
						kind: "workflow_lease_quarantined",
						workflowId: input.workflowId,
						leaseRef: leaseRefOfResource(lease),
						epochRef: input.epochRef,
						reason: "workflow_lease_ttl_persist_failed",
					},
					input.epochRef,
					current.leaseRef,
					`quarantine:${lease.leaseId}:workflow_lease_ttl_persist_failed`,
					input.executionKey,
					afterCommit.head,
				);
			} catch {
				// The acquisition remains unavailable when its TTL transition cannot be persisted.
			}
			throw new WorkflowLeaseError(error instanceof Error ? error.message : "workflow_lease_ttl_persist_failed");
		}
		await hydrateFromReplay();
		const persisted = assertHydrated().records.find((candidate) => candidate.leaseId === lease.leaseId);
		if (persisted === undefined || !("resourceAdmission" in persisted))
			throw new WorkflowLeaseError("workflow_lease_persist_failed");
		assertHydrated().leaseRefs.set(lease.leaseId, leaseRefFor(lease, current.leaseRef));
		assertHydrated().executionKeys.set(lease.leaseId, input.executionKey);
		return frozenClone(persisted);
	};

	const acquireOwnership = async (input: WorkflowOwnershipLeaseRequest): Promise<WorkflowOwnershipLease> => {
		assertHydrated();
		const current = await assertRequest(input, "ownership");
		const task = await readTask(input.workflowId, input.taskId);
		const ownedPaths = await assertOwnershipPaths(input.ownedPaths, input.ownedContracts);
		if (
			ownedPaths.some((path) => !task.ownedPaths.includes(path)) ||
			input.ownedContracts.some((contract) => !task.ownedContracts.includes(contract))
		)
			throw new WorkflowLeaseError("workflow_ownership_authority_mismatch");
		const ownedContracts = Object.freeze([...input.ownedContracts].sort());
		const existingId = leaseIdentity("ownership", input);
		const existing = assertHydrated().records.find((lease) => lease.leaseId === existingId);
		if (existing !== undefined) {
			if (
				"resourceAdmission" in existing ||
				existing.workflowId !== input.workflowId ||
				existing.taskId !== input.taskId ||
				existing.attemptId !== input.attemptId ||
				digestObject(existing.ownedPaths) !== digestObject(ownedPaths) ||
				digestObject(existing.ownedContracts) !== digestObject(ownedContracts)
			)
				throw new WorkflowLeaseError("workflow_lease_binding_conflict");
			const reservation = assertHydrated().ownershipReservations.get(existing.leaseId);
			if (
				reservation === undefined ||
				digestObject(reservation.vector) !== digestObject(input.vector) ||
				digestObject(reservation.controlCapacity) !== digestObject(input.controlCapacity) ||
				reservation.conflictKeyDigest !== digestObject(input.conflictKey) ||
				reservation.enforcementClass !== input.enforcementClass ||
				reservation.controlPlane !== input.controlPlane
			)
				throw new WorkflowLeaseError("workflow_lease_binding_conflict");
			const boundExecutionKey = assertHydrated().executionKeys.get(existing.leaseId);
			if (boundExecutionKey !== undefined && boundExecutionKey !== "" && boundExecutionKey !== input.executionKey)
				throw new WorkflowLeaseError("workflow_execution_binding_mismatch");
			if (existing.status === "released" || existing.status === "quarantined")
				throw new WorkflowLeaseError("workflow_lease_reuse_forbidden");
			if (await leaseExpired(existing)) throw new WorkflowLeaseError("workflow_lease_expired");
			return frozenClone(existing);
		}
		const active = await activeVector(input.workflowId);
		const activeControl = await activeControlCapacity(input.workflowId);
		const matchingResource = (await activeResourceRecords(input.workflowId)).some(
			(lease) => lease.attemptId === input.attemptId,
		);
		const ownershipVector = matchingResource ? zeroWorkflowResourceVector() : input.vector;
		const ownershipControl = matchingResource ? zeroWorkflowControlCapacity() : input.controlCapacity;
		if (
			!fitsVector(addVector(active, ownershipVector), resourceCeiling(input.controlPlane)) ||
			!fitsControl(addControl(activeControl, ownershipControl), controlCeiling(input.controlPlane))
		)
			throw new WorkflowLeaseError("workflow_resource_limit");
		const requestedConflictDigest = digestObject(input.conflictKey);
		const overlaps = (await activeOwnershipRecords(input.workflowId)).some(
			(lease) =>
				assertHydrated().ownershipReservations.get(lease.leaseId)?.conflictKeyDigest === requestedConflictDigest ||
				lease.status === "quarantined" ||
				lease.ownedPaths.some((ownedPath) =>
					ownedPaths.some((requestedPath) => pathOverlaps(ownedPath, requestedPath)),
				) ||
				lease.ownedContracts.some((contract) => ownedContracts.includes(contract)),
		);
		if (overlaps) throw new WorkflowLeaseError("workflow_ownership_overlap");
		const replay = await dependencies.store.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const acquisitionEventSequence = positiveSequence(replay.head);
		const lease: WorkflowOwnershipLease = {
			leaseId: existingId,
			workflowId: input.workflowId,
			taskId: input.taskId,
			attemptId: input.attemptId,
			ownedPaths,
			ownedContracts,
			status: "active",
			storeEpoch: input.epochRef.storeEpoch,
			coordinatorEpoch: input.epochRef.coordinatorEpoch,
			acquisitionEventSequence,
			releaseEventSequence: null,
		};
		const idempotencyKey = encodeOwnershipBinding(input);
		const committed = await commitEvent(
			input.workflowId,
			{ kind: "workflow_ownership_lease_acquired", workflowId: input.workflowId, lease, epochRef: input.epochRef },
			input.epochRef,
			current.leaseRef,
			idempotencyKey,
			input.executionKey,
			replay.head,
		);
		if (committed.commit.sequence !== acquisitionEventSequence)
			throw new WorkflowLeaseError("workflow_lease_acquisition_sequence_mismatch");
		await hydrateFromReplay();
		const persisted = assertHydrated().records.find((candidate) => candidate.leaseId === lease.leaseId);
		if (persisted === undefined || "resourceAdmission" in persisted)
			throw new WorkflowLeaseError("workflow_lease_persist_failed");
		assertHydrated().leaseRefs.set(lease.leaseId, leaseRefFor(lease, current.leaseRef));
		assertHydrated().executionKeys.set(lease.leaseId, input.executionKey);
		return frozenClone(persisted);
	};

	const lookupByLease = async (
		workflowId: string,
		leaseRef: WorkflowLeaseRef,
	): Promise<WorkflowLeaseAdmissionState | undefined> => {
		assertHydrated();
		if (workflowId !== dependencies.store.identity.workflowId)
			throw new WorkflowLeaseError("workflow_workflow_id_invalid");
		const lease = assertHydrated().records.find(
			(candidate) => candidate.workflowId === workflowId && candidate.leaseId === leaseRef.leaseId,
		);
		if (lease === undefined) return undefined;
		const expected =
			assertHydrated().leaseRefs.get(lease.leaseId) ?? leaseRefFor(lease, (await activeContext()).leaseRef);
		if (!sameLeaseRef(expected, leaseRef)) throw new WorkflowLeaseError("workflow_lease_binding_mismatch");
		const admission = (await dependencies.admission.listByWorkflow(workflowId)).find(
			(candidate) => candidate.context.attemptId === lease.attemptId,
		);
		return {
			terminalEventSequence: admission?.terminalEventSequence ?? null,
			executionKey:
				admission?.context.executionKey ?? assertHydrated().executionKeys.get(lease.leaseId) ?? lease.leaseId,
			outcomeDigest: admission?.outcomeDigest ?? null,
			leaseStatus: (await leaseExpired(lease)) ? "expired" : lease.status,
		};
	};

	const release = async (input: WorkflowLeaseReleaseInput): Promise<WorkflowLeaseReleaseResult> => {
		assertHydrated();
		if (input.store !== dependencies.store) throw new WorkflowLeaseError("workflow_store_mismatch");
		const current = await assertEpoch(input.workflowId, input.epochRef);
		const lease = assertHydrated().records.find((candidate) => candidate.leaseId === input.leaseRef.leaseId);
		if (lease === undefined) throw new WorkflowLeaseError("workflow_lease_not_found");
		if (
			lease.workflowId !== input.workflowId ||
			lease.attemptId !== input.attemptId ||
			lease.storeEpoch !== input.epochRef.storeEpoch ||
			lease.coordinatorEpoch !== input.epochRef.coordinatorEpoch
		)
			throw new WorkflowLeaseError("workflow_lease_input_mismatch");
		const expectedRef = assertHydrated().leaseRefs.get(lease.leaseId) ?? leaseRefFor(lease, current.leaseRef);
		if (!sameLeaseRef(expectedRef, input.leaseRef)) throw new WorkflowLeaseError("workflow_lease_binding_mismatch");
		if (await leaseExpired(lease)) throw new WorkflowLeaseError("workflow_lease_expired");
		const state = await lookupByLease(input.workflowId, input.leaseRef);
		await assertRevision(input.workflowId, input.epochRef, state?.executionKey ?? null);
		if (
			state === undefined ||
			state.terminalEventSequence === null ||
			state.terminalEventSequence <= 0 ||
			state.outcomeDigest === null
		)
			throw new WorkflowLeaseError("workflow_outcome_required");
		if (state.outcomeDigest !== input.outcomeDigest) throw new WorkflowLeaseError("workflow_outcome_digest_mismatch");
		if (lease.status === "released") {
			return {
				status: "already_released",
				leaseRef: input.leaseRef,
				releaseEventSequence: lease.releaseEventSequence ?? input.leaseRef.acquisitionEventSequence,
				epochRef: input.epochRef,
			};
		}
		await assertRevision(input.workflowId, input.epochRef, state.executionKey);
		const replay = await dependencies.store.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const expectedReleaseSequence = positiveSequence(replay.head);
		const releaseArtifact = await dependencies.store.publishArtifact({
			workflowId: input.workflowId,
			payloadKind: "barrier",
			bytes: canonicalJsonBytes({
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				leaseRef: input.leaseRef,
				terminalOutcomeDigest: input.outcomeDigest,
				expectedReleaseSequence,
			}),
			codec: "canonical_json",
			sourceEventSequence: replay.head.sequence,
			idempotencyKey: `lease-release-evidence:${input.workflowId}:${input.leaseRef.leaseId}:${input.leaseRef.acquisitionEventSequence}`,
		});
		const afterArtifact = await dependencies.store.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const releaseEventSequence = positiveSequence(afterArtifact.head);
		const releaseRef: WorkflowLeaseReleaseRef = {
			leaseRef: input.leaseRef,
			attemptId: input.attemptId,
			terminalOutcomeDigest: input.outcomeDigest,
			releaseEventSequence,
			releaseProof: releaseArtifact.envelope.ref.digest,
		};
		try {
			const committed = await commitEvent(
				input.workflowId,
				{
					kind: "workflow_lease_release_recorded",
					workflowId: input.workflowId,
					releaseRef,
					epochRef: input.epochRef,
					status: "released",
				},
				input.epochRef,
				current.leaseRef,
				`lease-release:${input.workflowId}:${input.leaseRef.leaseId}:${input.leaseRef.acquisitionEventSequence}`,
				state.executionKey,
				afterArtifact.head,
			);
			if (committed.status === "already_committed") {
				await hydrateFromReplay();
				return {
					status: "already_released",
					leaseRef: input.leaseRef,
					releaseEventSequence: committed.commit.sequence,
					epochRef: input.epochRef,
				};
			}
			if (committed.commit.sequence !== releaseEventSequence)
				throw new WorkflowLeaseError("workflow_release_sequence_mismatch");
		} catch (error) {
			await hydrateFromReplay();
			const afterConflict = assertHydrated().records.find(
				(candidate) => candidate.leaseId === input.leaseRef.leaseId,
			);
			if (afterConflict?.status === "released") {
				return {
					status: "already_released",
					leaseRef: input.leaseRef,
					releaseEventSequence: afterConflict.releaseEventSequence ?? releaseEventSequence,
					epochRef: input.epochRef,
				};
			}
			throw error;
		}
		await hydrateFromReplay();
		return { status: "released", leaseRef: input.leaseRef, releaseEventSequence, epochRef: input.epochRef };
	};

	const quarantine = async (input: WorkflowLeaseQuarantineInput): Promise<WorkflowLeaseReconciliation> => {
		assertHydrated();
		if (input.store !== dependencies.store) throw new WorkflowLeaseError("workflow_store_mismatch");
		const lease = assertHydrated().records.find((candidate) => candidate.leaseId === input.leaseRef.leaseId);
		if (lease === undefined) throw new WorkflowLeaseError("workflow_lease_not_found");
		if (lease.workflowId !== input.workflowId || lease.attemptId !== input.attemptId)
			throw new WorkflowLeaseError("workflow_lease_input_mismatch");
		const expectedRef =
			assertHydrated().leaseRefs.get(lease.leaseId) ?? leaseRefFor(lease, (await activeContext()).leaseRef);
		if (!sameLeaseRef(expectedRef, input.leaseRef)) throw new WorkflowLeaseError("workflow_lease_binding_mismatch");
		const boundExecutionKey = assertHydrated().executionKeys.get(lease.leaseId);
		if (boundExecutionKey !== undefined && boundExecutionKey !== "" && boundExecutionKey !== input.executionKey)
			throw new WorkflowLeaseError("workflow_execution_binding_mismatch");
		if (lease.status === "released") return { leaseRef: input.leaseRef, status: "already_released", reason: null };
		let active = await activeContext();
		try {
			active = await assertEpoch(input.workflowId, input.epochRef);
		} catch (error) {
			if (!(error instanceof WorkflowLeaseError) || error.code !== "workflow_epoch_stale") throw error;
		}
		const replay = await dependencies.store.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: active.epochRef.storeEpoch,
		});
		const existing = replay.events.find(
			(event) =>
				event.payload.kind === "workflow_lease_quarantined" &&
				event.payload.leaseRef.leaseId === input.leaseRef.leaseId,
		);
		if (existing?.payload.kind === "workflow_lease_quarantined") {
			await hydrateFromReplay();
			return { leaseRef: input.leaseRef, status: "quarantined", reason: existing.payload.reason };
		}
		await commitEvent(
			input.workflowId,
			{
				kind: "workflow_lease_quarantined",
				workflowId: input.workflowId,
				leaseRef: input.leaseRef,
				epochRef: active.epochRef,
				reason: input.reason,
			},
			active.epochRef,
			active.leaseRef,
			`quarantine:${input.leaseRef.leaseId}:${input.reason}`,
			input.executionKey,
			replay.head,
		);
		await hydrateFromReplay();
		return { leaseRef: input.leaseRef, status: "quarantined", reason: input.reason };
	};

	const reconcile = async (input: WorkflowLeaseReleaseInput): Promise<WorkflowLeaseReconciliation> => {
		assertHydrated();
		const state = await lookupByLease(input.workflowId, input.leaseRef);
		if (state?.leaseStatus === "released")
			return { leaseRef: input.leaseRef, status: "already_released", reason: null };
		return quarantine({
			workflowId: input.workflowId,
			attemptId: input.attemptId,
			leaseRef: input.leaseRef,
			epochRef: input.epochRef,
			store: input.store,
			executionKey: state?.executionKey ?? input.leaseRef.leaseId,
			reason: "workflow_lease_reconciliation_required",
		});
	};

	const canAdmit = async (input: WorkflowLeaseRequest): Promise<boolean> => {
		if (!hydrated) return false;
		try {
			await assertRequest(input, "resource");
			const active = await activeVector(input.workflowId, input.attemptId);
			const activeControl = await activeControlCapacity(input.workflowId, input.attemptId);
			const exclusiveActive = (await activeResourceRecords(input.workflowId)).some(
				(lease) => lease.resourceAdmission.enforcementClass === "exclusive_unisolated",
			);
			if (input.enforcementClass === "exclusive_unisolated") {
				if (
					exclusiveActive ||
					CONTROL_DIMENSIONS.some((dimension) => activeControl[dimension] > 0) ||
					!fitsVector(active, zeroWorkflowResourceVector())
				)
					return false;
			} else if (exclusiveActive) return false;
			return (
				fitsVector(addVector(active, input.vector), resourceCeiling(input.controlPlane)) &&
				fitsControl(addControl(activeControl, input.controlCapacity), controlCeiling(input.controlPlane))
			);
		} catch {
			return false;
		}
	};

	return {
		acquireResource,
		acquireOwnership,
		reserveDispatch,
		hydrateFromReplay,
		releasePreDispatch,
		release,
		quarantine,
		reconcile,
		activeVector,
		activeControlCapacity,
		canAdmit,
		lookupByLease,
	};
}
