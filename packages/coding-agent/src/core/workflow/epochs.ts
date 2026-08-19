import { join } from "node:path";

import type { SessionManager } from "../session-manager.js";
import type {
	WorkflowCoordinatorLeaseRecord,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowGenerationBinding,
	WorkflowGenerationRotation,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowRuntimeEventPayload,
	WorkflowRuntimeStore,
	WorkflowSemanticMutationBinding,
	WorkflowStoreCommitInput,
	WorkflowStoreCommitResult,
} from "./contracts.js";
import { digestObject } from "./contracts.js";
import type { WorkflowAppendLease } from "./journal.js";

export interface WorkflowRuntimePaths {
	readonly artifactRoot: string;
	readonly workflowRoot: string;
	readonly eventsPath: string;
}

export class WorkflowEpochError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "WorkflowEpochError";
		this.code = code;
	}
}

export interface WorkflowCoordinatorLease {
	readonly record: WorkflowCoordinatorLeaseRecord;
	assertCurrent(): Promise<void>;
	renew(now: string): Promise<WorkflowCoordinatorLeaseRecord>;
	fence(reason: string): Promise<WorkflowCoordinatorLeaseRecord>;
}

export interface WorkflowEpochManager {
	acquire(workflowId: string): Promise<WorkflowCoordinatorLease>;
	replaceStoreEpoch(
		nextEpoch: WorkflowEpochRef,
		generationBinding: WorkflowGenerationBinding,
	): Promise<WorkflowGenerationRotation>;
	assertCurrent(workflowId: string, epochRef: WorkflowEpochRef): Promise<void>;
	renew(lease: WorkflowCoordinatorLease, now: string): Promise<WorkflowCoordinatorLeaseRecord>;
	fence(workflowId: string, epochRef: WorkflowEpochRef, reason: string): Promise<WorkflowCoordinatorLeaseRecord>;
}

export interface WorkflowClock {
	now(): string;
	addMilliseconds(base: string, milliseconds: number): string;
}

export interface WorkflowMonotonicTtl {
	readonly sequence: number;
	readonly observedAtMonotonicMs: number;
	readonly expiresAtMonotonicMs: number;
}

export interface WorkflowLeaseTtlStore {
	read(leaseId: string): Promise<WorkflowMonotonicTtl | null>;
	write(leaseId: string, ttl: WorkflowMonotonicTtl): Promise<void>;
}

export interface WorkflowCoordinatorOwnerStore {
	read(workflowId: string): Promise<WorkflowCoordinatorLeaseRecord | null>;
}

export interface WorkflowEpochManagerDependencies {
	readonly store: WorkflowRuntimeStore;
	readonly workflowId: string;
	readonly workflowRoot: string;
	readonly writerIdentity: string;
	readonly clock: WorkflowClock;
	readonly readCurrentStoreEpoch: (workflowId: string) => Promise<number>;
	readonly processIdentity: {
		readonly pid: number;
		readonly processStartId: string;
		readonly processGroupId: string;
	};
	readonly appendLease: WorkflowAppendLease;
	readonly ownerStore: WorkflowCoordinatorOwnerStore;
	readonly rootLeaseRef: WorkflowLeaseRef;
	readonly leaseTtlStore: WorkflowLeaseTtlStore;
	readonly trustedMonotonicNow: () => number;
}

/**
 * Derive all workflow runtime paths from the persisted session artifact root.
 * Args:
 * sessionManager: Persisted session whose artifact directory owns the workflow.
 * workflowId: Canonical workflow identifier used as the path component.
 * Return: Artifact, workflow, and event-log paths under the session artifact root.
 */
export function resolveWorkflowRuntimePaths(sessionManager: SessionManager, workflowId: string): WorkflowRuntimePaths {
	const artifactRoot = sessionManager.getSessionArtifactDir();
	if (artifactRoot === undefined || artifactRoot.length === 0 || artifactRoot.includes("\u0000"))
		throw new WorkflowEpochError("workflow_artifact_root_unavailable");
	assertCanonicalId(workflowId);
	const workflowRoot = join(artifactRoot, "workflows", workflowId);
	return { artifactRoot, workflowRoot, eventsPath: join(workflowRoot, "events.log") };
}

/**
 * Validate an authenticated monotonic lease TTL before it is persisted.
 * Args:
 * previous: Previously persisted TTL for the same lease, if any.
 * next: Candidate TTL to validate and persist.
 * trustedNowMonotonicMs: Trusted monotonic observation used for expiry fencing.
 * Return: Nothing; throws when sequence or expiry moves backwards.
 */
export function validateMonotonicTtl(
	previous: WorkflowMonotonicTtl | null,
	next: WorkflowMonotonicTtl,
	trustedNowMonotonicMs: number,
): void {
	if (
		!Number.isSafeInteger(next.sequence) ||
		next.sequence <= 0 ||
		!Number.isFinite(next.observedAtMonotonicMs) ||
		!Number.isFinite(next.expiresAtMonotonicMs) ||
		next.expiresAtMonotonicMs <= next.observedAtMonotonicMs ||
		next.expiresAtMonotonicMs <= trustedNowMonotonicMs ||
		(previous !== null &&
			(next.sequence <= previous.sequence ||
				next.observedAtMonotonicMs < previous.observedAtMonotonicMs ||
				next.expiresAtMonotonicMs < previous.expiresAtMonotonicMs))
	)
		throw new WorkflowEpochError("workflow_monotonic_ttl_invalid");
}

/**
 * Create the process-identified coordinator epoch manager.
 * Args:
 * dependencies: Authenticated store, append lease, owner reader, TTL store, and process identity ports.
 * Return: Manager that rotates only through the runtime store generation APIs.
 */
export function createWorkflowEpochManager(dependencies: WorkflowEpochManagerDependencies): WorkflowEpochManager {
	assertCanonicalId(dependencies.workflowId);
	if (dependencies.workflowRoot.length === 0 || dependencies.workflowRoot.includes("\u0000"))
		throw new WorkflowEpochError("workflow_artifact_root_unavailable");
	assertLeaseRef(dependencies.rootLeaseRef);

	let activeLeaseRef = { ...dependencies.rootLeaseRef };
	const fencedLeaseIds = new Set<string>();

	const persistLeaseTtl = async (
		leaseId: string,
		previous: WorkflowMonotonicTtl | null,
	): Promise<WorkflowMonotonicTtl> => {
		assertCanonicalId(leaseId);
		const observedAtMonotonicMs = dependencies.trustedMonotonicNow();
		if (!Number.isFinite(observedAtMonotonicMs)) throw new WorkflowEpochError("workflow_monotonic_clock_invalid");
		const next: WorkflowMonotonicTtl = {
			sequence: (previous?.sequence ?? 0) + 1,
			observedAtMonotonicMs,
			expiresAtMonotonicMs: observedAtMonotonicMs + 30_000,
		};
		validateMonotonicTtl(previous, next, observedAtMonotonicMs);
		await dependencies.leaseTtlStore.write(leaseId, next);
		return next;
	};

	const readHead = async (workflowId: string, storeEpoch: number): Promise<WorkflowJournalHead> => {
		assertCanonicalId(workflowId);
		assertPositiveEpoch(storeEpoch, "workflow_store_epoch_invalid");
		const replay = await dependencies.store.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: storeEpoch });
		if (replay.quarantined) {
			if (replay.quarantineReason === "stale_epoch") throw new WorkflowEpochError("workflow_epoch_stale");
			if (
				replay.quarantineReason === "rotation_prepared_only" ||
				replay.quarantineReason === "rotation_lease_transfer_unmatched" ||
				replay.quarantineReason === "rotation_fence_duplicate" ||
				replay.quarantineReason === "rotation_fence_chain_break" ||
				replay.quarantineReason === "rotation_commit_uncertain"
			)
				throw new WorkflowEpochError("workflow_generation_rotation_quarantined");
			throw new WorkflowEpochError("workflow_store_quarantined");
		}
		if (
			replay.workflowId !== workflowId ||
			replay.head.workflowId !== workflowId ||
			replay.head.epochRef.storeEpoch !== storeEpoch
		)
			throw new WorkflowEpochError("workflow_epoch_invalid");
		assertEpochRef(replay.head.epochRef);
		return replay.head;
	};

	const append = async (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		payload: WorkflowRuntimeEventPayload,
		idempotencyKey: string,
		writerIdentity = dependencies.writerIdentity,
	): Promise<WorkflowStoreCommitResult<WorkflowRuntimeEventPayload>> => {
		assertEpochRef(epochRef);
		const expectedHead = await readHead(workflowId, epochRef.storeEpoch);
		if (
			activeLeaseRef.storeEpoch !== epochRef.storeEpoch ||
			activeLeaseRef.coordinatorEpoch !== epochRef.coordinatorEpoch
		)
			throw new WorkflowEpochError("workflow_lease_ref_stale");
		const input: WorkflowStoreCommitInput<WorkflowRuntimeEventPayload> = {
			workflowId,
			payload,
			expectedHead,
			epochRef,
			leaseRef: activeLeaseRef,
			idempotencyKey,
			writerIdentity,
			executionKey: null,
			semanticBinding: makeSemanticBinding({
				workflowId,
				expectedHead,
				epochRef,
				leaseRef: activeLeaseRef,
				idempotencyKey,
				writerIdentity,
				executionKey: null,
			}),
		};
		return commitAuthenticated(dependencies.store, input);
	};

	const assertLease = async (lease: WorkflowCoordinatorLeaseRecord): Promise<void> => {
		assertCoordinatorLeaseRecord(lease);
		if (fencedLeaseIds.has(lease.leaseId)) throw new WorkflowEpochError("workflow_epoch_stale");
		assertProcessIdentity(dependencies.processIdentity);
		if (lease.ownerIdentity !== dependencies.writerIdentity) throw new WorkflowEpochError("workflow_epoch_stale");
		const persisted = await dependencies.ownerStore.read(lease.workflowId);
		const ttl = await dependencies.leaseTtlStore.read(lease.leaseId);
		const trustedNowMonotonicMs = dependencies.trustedMonotonicNow();
		if (!Number.isFinite(trustedNowMonotonicMs)) throw new WorkflowEpochError("workflow_monotonic_clock_invalid");
		if (ttl === null) throw new WorkflowEpochError("workflow_epoch_stale");
		validateStoredTtl(ttl, trustedNowMonotonicMs);
		const currentHead = await readHead(lease.workflowId, lease.epochRef.storeEpoch);
		if (
			persisted === null ||
			persisted.status !== "active" ||
			persisted.workflowId !== lease.workflowId ||
			persisted.leaseId !== lease.leaseId ||
			persisted.epochRef.storeEpoch !== lease.epochRef.storeEpoch ||
			persisted.epochRef.coordinatorEpoch !== lease.epochRef.coordinatorEpoch ||
			persisted.ownerIdentity !== lease.ownerIdentity ||
			persisted.pid !== lease.pid ||
			persisted.processStartId !== lease.processStartId ||
			persisted.processGroupId !== lease.processGroupId ||
			persisted.processStartId !== dependencies.processIdentity.processStartId ||
			persisted.pid !== dependencies.processIdentity.pid ||
			persisted.processGroupId !== dependencies.processIdentity.processGroupId ||
			currentHead.epochRef.storeEpoch !== lease.epochRef.storeEpoch ||
			currentHead.epochRef.coordinatorEpoch !== lease.epochRef.coordinatorEpoch ||
			activeLeaseRef.leaseId !== lease.leaseId ||
			activeLeaseRef.writerIdentity !== lease.ownerIdentity ||
			activeLeaseRef.storeEpoch !== lease.epochRef.storeEpoch ||
			activeLeaseRef.coordinatorEpoch !== lease.epochRef.coordinatorEpoch
		)
			throw new WorkflowEpochError("workflow_epoch_stale");
	};

	const makeLease = (record: WorkflowCoordinatorLeaseRecord): WorkflowCoordinatorLease => ({
		record,
		assertCurrent: async (): Promise<void> => assertLease(record),
		renew: async (now: string): Promise<WorkflowCoordinatorLeaseRecord> => {
			await assertLease(record);
			await persistLeaseTtl(record.leaseId, await dependencies.leaseTtlStore.read(record.leaseId));
			const renewed: WorkflowCoordinatorLeaseRecord = {
				...record,
				renewedAt: now,
				expiresAt: dependencies.clock.addMilliseconds(now, 30_000),
			};
			await append(
				record.workflowId,
				record.epochRef,
				{
					kind: "workflow_coordinator_lease_renewed",
					workflowId: record.workflowId,
					leaseId: record.leaseId,
					epochRef: record.epochRef,
					renewedAt: renewed.renewedAt,
					expiresAt: renewed.expiresAt,
				},
				`coordinator-renew:${record.leaseId}:${renewed.renewedAt}`,
			);
			return renewed;
		},
		fence: async (reason: string): Promise<WorkflowCoordinatorLeaseRecord> => {
			if (reason.length === 0) throw new WorkflowEpochError("workflow_fence_reason_missing");
			await assertLease(record);
			await append(
				record.workflowId,
				record.epochRef,
				{
					kind: "workflow_coordinator_fenced",
					workflowId: record.workflowId,
					leaseId: record.leaseId,
					epochRef: record.epochRef,
					reason,
				},
				`coordinator-fence:${record.leaseId}:${reason}`,
			);
			fencedLeaseIds.add(record.leaseId);
			return { ...record, status: "fenced", renewedAt: dependencies.clock.now() };
		},
	});

	const acquire = async (workflowId: string): Promise<WorkflowCoordinatorLease> => {
		assertCanonicalId(workflowId);
		if (workflowId !== dependencies.workflowId) throw new WorkflowEpochError("workflow_id_mismatch");
		assertProcessIdentity(dependencies.processIdentity);
		if (dependencies.writerIdentity.length === 0) throw new WorkflowEpochError("writer_identity_unavailable");
		const storeEpoch = await dependencies.readCurrentStoreEpoch(workflowId);
		assertPositiveEpoch(storeEpoch, "workflow_epoch_invalid");
		const currentHead = await readHead(workflowId, storeEpoch);
		const observed = await dependencies.appendLease.observe(workflowId);
		if (
			observed === null ||
			observed.leaseRef.storeEpoch !== currentHead.epochRef.storeEpoch ||
			observed.leaseRef.coordinatorEpoch !== currentHead.epochRef.coordinatorEpoch ||
			observed.writerIdentity !== observed.leaseRef.writerIdentity ||
			digestObject(activeLeaseRef) !== digestObject(observed.leaseRef)
		)
			throw new WorkflowEpochError("workflow_append_lease_predecessor_unavailable");
		const nextEpoch: WorkflowEpochRef = {
			storeEpoch: currentHead.epochRef.storeEpoch,
			coordinatorEpoch: currentHead.epochRef.coordinatorEpoch + 1,
		};
		assertEpochRef(nextEpoch);
		const generationBinding: WorkflowGenerationBinding = {
			writerIdentity: dependencies.writerIdentity,
			processGenerationId: dependencies.processIdentity.processStartId,
			ownerIdentity: dependencies.writerIdentity,
		};
		const rotation = await dependencies.store.replaceCoordinatorEpoch(nextEpoch, generationBinding);
		assertRotation(rotation, currentHead, observed.leaseRef, nextEpoch, generationBinding);
		activeLeaseRef = { ...rotation.nextLeaseRef };
		const postFenceHead = await readHead(workflowId, nextEpoch.storeEpoch);
		if (postFenceHead.epochRef.coordinatorEpoch !== nextEpoch.coordinatorEpoch)
			throw new WorkflowEpochError("workflow_coordinator_epoch_not_replaced");
		const lease = coordinatorLeaseFromRotation(rotation, workflowId, dependencies.processIdentity);
		await persistLeaseTtl(lease.leaseId, await dependencies.leaseTtlStore.read(lease.leaseId));
		await append(
			workflowId,
			nextEpoch,
			{ kind: "workflow_coordinator_lease_acquired", workflowId, lease, epochRef: nextEpoch },
			`coordinator-acquire:${workflowId}:${nextEpoch.coordinatorEpoch}`,
		);
		return makeLease(lease);
	};

	const replaceStoreEpoch = async (
		nextEpoch: WorkflowEpochRef,
		generationBinding: WorkflowGenerationBinding,
	): Promise<WorkflowGenerationRotation> => {
		assertEpochRef(nextEpoch);
		assertGenerationBinding(generationBinding);
		const currentStoreEpoch = await dependencies.readCurrentStoreEpoch(dependencies.workflowId);
		assertPositiveEpoch(currentStoreEpoch, "workflow_epoch_invalid");
		const currentHead = await readHead(dependencies.workflowId, currentStoreEpoch);
		if (
			nextEpoch.storeEpoch !== currentHead.epochRef.storeEpoch + 1 ||
			nextEpoch.coordinatorEpoch !== currentHead.epochRef.coordinatorEpoch ||
			activeLeaseRef.storeEpoch !== currentHead.epochRef.storeEpoch ||
			activeLeaseRef.coordinatorEpoch !== currentHead.epochRef.coordinatorEpoch
		)
			throw new WorkflowEpochError("workflow_store_epoch_replacement_invalid");
		const rotation = await dependencies.store.replaceStoreEpoch(nextEpoch, generationBinding);
		assertRotation(rotation, currentHead, activeLeaseRef, nextEpoch, generationBinding);
		activeLeaseRef = { ...rotation.nextLeaseRef };
		await persistLeaseTtl(
			rotation.nextLeaseRef.leaseId,
			await dependencies.leaseTtlStore.read(rotation.nextLeaseRef.leaseId),
		);
		return rotation;
	};

	return {
		acquire,
		replaceStoreEpoch,
		assertCurrent: async (workflowId: string, epochRef: WorkflowEpochRef): Promise<void> => {
			assertCanonicalId(workflowId);
			if (workflowId !== dependencies.workflowId) throw new WorkflowEpochError("workflow_id_mismatch");
			assertEpochRef(epochRef);
			const owner = await dependencies.ownerStore.read(workflowId);
			if (
				owner === null ||
				owner.epochRef.storeEpoch !== epochRef.storeEpoch ||
				owner.epochRef.coordinatorEpoch !== epochRef.coordinatorEpoch
			)
				throw new WorkflowEpochError("workflow_epoch_stale");
			await assertLease(owner);
		},
		renew: async (lease: WorkflowCoordinatorLease, now: string): Promise<WorkflowCoordinatorLeaseRecord> =>
			lease.renew(now),
		fence: async (
			workflowId: string,
			epochRef: WorkflowEpochRef,
			reason: string,
		): Promise<WorkflowCoordinatorLeaseRecord> => {
			assertCanonicalId(workflowId);
			if (workflowId !== dependencies.workflowId) throw new WorkflowEpochError("workflow_id_mismatch");
			assertEpochRef(epochRef);
			const owner = await dependencies.ownerStore.read(workflowId);
			if (
				owner === null ||
				owner.epochRef.storeEpoch !== epochRef.storeEpoch ||
				owner.epochRef.coordinatorEpoch !== epochRef.coordinatorEpoch
			)
				throw new WorkflowEpochError("workflow_epoch_stale");
			return makeLease(owner).fence(reason);
		},
	};
}

async function commitAuthenticated<TPayload extends WorkflowEventPayload>(
	store: WorkflowRuntimeStore,
	input: WorkflowStoreCommitInput<TPayload>,
): Promise<WorkflowStoreCommitResult<TPayload>> {
	assertCanonicalId(input.workflowId, input.writerIdentity, input.idempotencyKey);
	assertEpochRef(input.epochRef);
	assertEpochRef(input.expectedHead.epochRef);
	assertLeaseRef(input.leaseRef);
	if (
		("workflowId" in input.payload && input.payload.workflowId !== input.workflowId) ||
		("epochRef" in input.payload && digestObject(input.payload.epochRef) !== digestObject(input.epochRef)) ||
		("executionKey" in input.payload && input.payload.executionKey !== input.executionKey) ||
		input.executionKey !== input.semanticBinding.executionKey ||
		input.semanticBinding.idempotencyKey !== input.idempotencyKey ||
		input.semanticBinding.writerIdentity !== input.writerIdentity ||
		input.semanticBinding.leaseRef.leaseId !== input.leaseRef.leaseId ||
		digestObject(input.semanticBinding.epochRef) !== digestObject(input.epochRef) ||
		digestObject(input.semanticBinding.expectedHead) !== digestObject(input.expectedHead) ||
		input.leaseRef.storeEpoch !== input.epochRef.storeEpoch ||
		input.leaseRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch
	)
		throw new WorkflowEpochError("workflow_commit_semantic_binding_mismatch");
	const result = await store.commit(input);
	const proof = result.commit.commitReturnProof;
	if (
		result.commit.workflowId !== input.workflowId ||
		result.commit.writerIdentity !== input.writerIdentity ||
		result.commit.idempotencyKey !== input.idempotencyKey ||
		result.commit.returnProofId !== `return-proof:${input.idempotencyKey}` ||
		proof.proofDigest.length === 0 ||
		proof.idempotencyKey !== input.idempotencyKey ||
		proof.writerIdentity !== input.writerIdentity ||
		digestObject(proof.leaseRef) !== digestObject(input.leaseRef) ||
		digestObject(result.commit.epochRef) !== digestObject(input.epochRef)
	)
		throw new WorkflowEpochError("workflow_commit_return_proof_invalid");
	return result;
}

function makeSemanticBinding(input: {
	readonly workflowId: string;
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly idempotencyKey: string;
	readonly writerIdentity: string;
	readonly executionKey: string | null;
}): WorkflowSemanticMutationBinding {
	const mutationId = `workflow-epoch:${input.idempotencyKey}`;
	return {
		mutationId,
		baselineDigest: digestObject({ mutationId, workflowId: input.workflowId }),
		expectedGenerations: { workflow: 1 },
		ownerId: input.writerIdentity,
		phase: "executing",
		reducerDigest: digestObject("workflow-epoch-reducer"),
		semanticHead: {
			workflowId: input.workflowId,
			sequence: input.expectedHead.sequence,
			eventDigest: input.expectedHead.eventDigest,
			stateDigest: digestObject(input.expectedHead),
			epochRef: input.epochRef,
			generation: 1,
		},
		expectedHead: input.expectedHead,
		idempotencyKey: input.idempotencyKey,
		executionKey: input.executionKey,
		writerIdentity: input.writerIdentity,
		leaseRef: input.leaseRef,
		epochRef: input.epochRef,
	};
}

function coordinatorLeaseFromRotation(
	rotation: WorkflowGenerationRotation,
	workflowId: string,
	processIdentity: WorkflowEpochManagerDependencies["processIdentity"],
): WorkflowCoordinatorLeaseRecord {
	assertProcessIdentity(processIdentity);
	return {
		workflowId,
		leaseId: rotation.nextLeaseRef.leaseId,
		ownerIdentity: rotation.generationBinding.ownerIdentity,
		pid: processIdentity.pid,
		processStartId: processIdentity.processStartId,
		processGroupId: processIdentity.processGroupId,
		epochRef: rotation.nextEpoch,
		acquiredAt: rotation.nextLeaseRef.acquiredAt,
		renewedAt: rotation.nextLeaseRef.acquiredAt,
		expiresAt: rotation.nextLeaseRef.expiresAt,
		status: "active",
	};
}

function assertRotation(
	rotation: WorkflowGenerationRotation,
	previousHead: WorkflowJournalHead,
	previousLeaseRef: WorkflowLeaseRef,
	nextEpoch: WorkflowEpochRef,
	generationBinding: WorkflowGenerationBinding,
): void {
	if (rotation.status === "quarantined") throw new WorkflowEpochError("workflow_generation_rotation_quarantined");
	if (
		rotation.status !== "committed" ||
		digestObject(rotation.expectedHead) !== digestObject(previousHead) ||
		digestObject(rotation.previousEpoch) !== digestObject(previousHead.epochRef) ||
		digestObject(rotation.nextEpoch) !== digestObject(nextEpoch) ||
		digestObject(rotation.previousLeaseRef) !== digestObject(previousLeaseRef) ||
		digestObject(rotation.generationBinding) !== digestObject(generationBinding) ||
		rotation.nextLeaseRef.storeEpoch !== nextEpoch.storeEpoch ||
		rotation.nextLeaseRef.coordinatorEpoch !== nextEpoch.coordinatorEpoch ||
		rotation.nextLeaseRef.processIdentity !== generationBinding.processGenerationId ||
		rotation.nextLeaseRef.writerIdentity !== generationBinding.writerIdentity ||
		rotation.nextLeaseRef.acquisitionEventSequence !== previousLeaseRef.acquisitionEventSequence + 1
	)
		throw new WorkflowEpochError("workflow_generation_rotation_invalid");
}

function assertCoordinatorLeaseRecord(record: WorkflowCoordinatorLeaseRecord): void {
	assertCanonicalId(
		record.workflowId,
		record.leaseId,
		record.ownerIdentity,
		record.processStartId,
		record.processGroupId,
	);
	assertEpochRef(record.epochRef);
	if (
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		!Number.isFinite(Date.parse(record.acquiredAt)) ||
		!Number.isFinite(Date.parse(record.renewedAt)) ||
		!Number.isFinite(Date.parse(record.expiresAt))
	)
		throw new WorkflowEpochError("workflow_coordinator_lease_invalid");
}

function assertProcessIdentity(processIdentity: WorkflowEpochManagerDependencies["processIdentity"]): void {
	if (
		!Number.isSafeInteger(processIdentity.pid) ||
		processIdentity.pid <= 0 ||
		processIdentity.processStartId.length === 0 ||
		processIdentity.processGroupId.length === 0
	)
		throw new WorkflowEpochError("process_start_identity_unavailable");
}

function assertGenerationBinding(generationBinding: WorkflowGenerationBinding): void {
	if (
		generationBinding.writerIdentity.length === 0 ||
		generationBinding.processGenerationId.length === 0 ||
		generationBinding.ownerIdentity.length === 0 ||
		generationBinding.ownerIdentity !== generationBinding.writerIdentity
	)
		throw new WorkflowEpochError("workflow_generation_binding_invalid");
}

function assertEpochRef(epochRef: WorkflowEpochRef): void {
	assertPositiveEpoch(epochRef.storeEpoch, "workflow_store_epoch_invalid");
	assertPositiveEpoch(epochRef.coordinatorEpoch, "workflow_coordinator_epoch_invalid");
}

function assertPositiveEpoch(value: number, code: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new WorkflowEpochError(code);
}

function assertLeaseRef(leaseRef: WorkflowLeaseRef): void {
	assertEpochRef(leaseRef);
	assertCanonicalId(leaseRef.leaseId, leaseRef.processIdentity, leaseRef.rootDigest, leaseRef.writerIdentity);
	if (
		!Number.isSafeInteger(leaseRef.acquisitionEventSequence) ||
		leaseRef.acquisitionEventSequence <= 0 ||
		!Number.isFinite(Date.parse(leaseRef.acquiredAt)) ||
		!Number.isFinite(Date.parse(leaseRef.expiresAt)) ||
		Date.parse(leaseRef.expiresAt) <= Date.parse(leaseRef.acquiredAt)
	)
		throw new WorkflowEpochError("workflow_lease_ref_invalid");
}

function validateStoredTtl(ttl: WorkflowMonotonicTtl, trustedNowMonotonicMs: number): void {
	try {
		validateMonotonicTtl(null, ttl, trustedNowMonotonicMs);
	} catch {
		throw new WorkflowEpochError("workflow_epoch_stale");
	}
}

function assertCanonicalId(...ids: readonly string[]): void {
	if (
		ids.some(
			(id) =>
				id.length === 0 ||
				id === "." ||
				id === ".." ||
				id.includes("/") ||
				id.includes("\\") ||
				id.includes("\u0000") ||
				id.split(/[\\/]/).some((segment) => segment === "." || segment === ".."),
		)
	)
		throw new WorkflowEpochError("workflow_id_invalid");
}
