import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { SessionManager } from "../../src/core/session-manager.js";
import {
	digestObject,
	type WorkflowArtifactPublishInput,
	type WorkflowArtifactPublishResult,
	type WorkflowCoordinatorLeaseRecord,
	type WorkflowEpochRef,
	type WorkflowEventPayload,
	type WorkflowGenerationBinding,
	type WorkflowGenerationRotation,
	type WorkflowJournalCommit,
	type WorkflowJournalHead,
	type WorkflowLeaseRef,
	type WorkflowOutboxAppendInput,
	type WorkflowOutboxAppendResult,
	type WorkflowProjectionCasInput,
	type WorkflowProjectionCasResult,
	type WorkflowRuntimeEventPayload,
	type WorkflowRuntimeStore,
	type WorkflowRuntimeStoreIdentity,
	type WorkflowSnapshotPublishInput,
	type WorkflowSnapshotPublishResult,
	type WorkflowStoreCommitInput,
	type WorkflowStoreCommitResult,
} from "../../src/core/workflow/contracts.js";
import {
	createWorkflowEpochManager,
	resolveWorkflowRuntimePaths,
	type WorkflowCoordinatorOwnerStore,
	type WorkflowEpochManagerDependencies,
	type WorkflowLeaseTtlStore,
	type WorkflowMonotonicTtl,
} from "../../src/core/workflow/epochs.js";
import type { WorkflowAppendLease } from "../../src/core/workflow/journal.js";

const GENESIS_EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };

it("derives workflow paths from the persisted session artifact root", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-epoch-paths-"));
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	try {
		const artifactRoot = sessionManager.getSessionArtifactDir();
		if (artifactRoot === undefined) throw new Error("test artifact root unavailable");
		const paths = resolveWorkflowRuntimePaths(sessionManager, "wf-fixture");
		expect(paths).toEqual({
			artifactRoot,
			workflowRoot: join(artifactRoot, "workflows", "wf-fixture"),
			eventsPath: join(artifactRoot, "workflows", "wf-fixture", "events.log"),
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects a coordinator without a process-start identity before store access", async () => {
	const fixture = createEpochFixture({ processStartId: "" });
	await expect(fixture.manager.acquire("wf-fixture")).rejects.toMatchObject({
		code: "process_start_identity_unavailable",
	});
	expect(fixture.storeReplayCalls).toBe(0);
});

it("rotates the coordinator epoch, renews its monotonic TTL, and fences the predecessor", async () => {
	const fixture = createEpochFixture();
	const predecessor = await fixture.manager.acquire("wf-fixture");
	await predecessor.assertCurrent();

	const renewed = await predecessor.renew("2030-01-01T00:00:10.000Z");
	expect(renewed.leaseId).toBe(predecessor.record.leaseId);
	expect(fixture.ttlStore.value?.sequence).toBe(2);

	const successorManager = createEpochFixture({
		store: fixture.store,
		appendLease: fixture.appendLease,
		ownerStore: fixture.ownerStore,
		ttlStore: fixture.ttlStore,
		rootLeaseRef: makeLeaseRef(predecessor.record.epochRef, "writer-root", "process-start-root"),
		writerIdentity: "writer-restarted",
		processStartId: "process-start-restarted",
		processGroupId: "group-root",
		clock: fixture.clock,
		trustedMonotonicNow: fixture.trustedMonotonicNow,
	});
	const successor = await successorManager.manager.acquire("wf-fixture");

	await expect(predecessor.assertCurrent()).rejects.toMatchObject({ code: "workflow_epoch_stale" });
	await expect(successor.assertCurrent()).resolves.toBeUndefined();
	expect(successor.record.epochRef).toEqual({ storeEpoch: 1, coordinatorEpoch: 3 });
	expect(successor.record.ownerIdentity).toBe("writer-restarted");
	expect(fixture.commits.map((commit) => commit.payload.kind)).toEqual([
		"workflow_coordinator_lease_acquired",
		"workflow_coordinator_lease_renewed",
		"workflow_coordinator_lease_acquired",
	]);
});

it("never fabricates a genesis store epoch when the store reports an invalid epoch", async () => {
	const fixture = createEpochFixture({ readCurrentStoreEpoch: async () => 0 });
	await expect(fixture.manager.acquire("wf-fixture")).rejects.toMatchObject({ code: "workflow_epoch_invalid" });
});

it("fences an expired monotonic TTL before allowing another mutation", async () => {
	let monotonicNow = 100;
	const fixture = createEpochFixture({ trustedMonotonicNow: () => monotonicNow });
	const lease = await fixture.manager.acquire("wf-fixture");
	monotonicNow = 30_100;

	await expect(lease.assertCurrent()).rejects.toMatchObject({ code: "workflow_epoch_stale" });
});

it("uses the returned successor lease when replacing the store generation", async () => {
	const fixture = createEpochFixture();
	const coordinator = await fixture.manager.acquire("wf-fixture");
	const rotation = await fixture.manager.replaceStoreEpoch(
		{ storeEpoch: 2, coordinatorEpoch: coordinator.record.epochRef.coordinatorEpoch },
		{ writerIdentity: "writer-root", processGenerationId: "process-start-root", ownerIdentity: "writer-root" },
	);

	expect(rotation.nextLeaseRef.storeEpoch).toBe(2);
	expect(rotation.nextLeaseRef.coordinatorEpoch).toBe(coordinator.record.epochRef.coordinatorEpoch);
	await expect(coordinator.assertCurrent()).rejects.toMatchObject({ code: "workflow_epoch_stale" });
});

it("fences a current lease before rejecting later assertions", async () => {
	const fixture = createEpochFixture();
	const lease = await fixture.manager.acquire("wf-fixture");
	const fenced = await lease.fence("operator-request");

	expect(fenced.status).toBe("fenced");
	await expect(lease.assertCurrent()).rejects.toMatchObject({ code: "workflow_epoch_stale" });
});

interface EpochFixture {
	manager: ReturnType<typeof createWorkflowEpochManager>;
	store: WorkflowRuntimeStore;
	appendLease: WorkflowAppendLease;
	ownerStore: WorkflowCoordinatorOwnerStore;
	ttlStore: RecordingTtlStore;
	clock: TestClock;
	trustedMonotonicNow: () => number;
	storeReplayCalls: number;
	commits: WorkflowStoreCommitInput<WorkflowRuntimeEventPayload>[];
}

interface TestClock {
	now(): string;
	addMilliseconds(base: string, milliseconds: number): string;
}

class RecordingTtlStore implements WorkflowLeaseTtlStore {
	value: WorkflowMonotonicTtl | null = null;

	async read(_leaseId: string): Promise<WorkflowMonotonicTtl | null> {
		return this.value;
	}

	async write(_leaseId: string, value: WorkflowMonotonicTtl): Promise<void> {
		this.value = value;
	}
}

function createEpochFixture(
	overrides: Partial<{
		store: WorkflowRuntimeStore;
		appendLease: WorkflowAppendLease;
		ownerStore: WorkflowCoordinatorOwnerStore;
		ttlStore: RecordingTtlStore;
		rootLeaseRef: WorkflowLeaseRef | undefined;
		writerIdentity: string;
		processStartId: string;
		processGroupId: string;
		clock: TestClock;
		trustedMonotonicNow: () => number;
		readCurrentStoreEpoch: (workflowId: string) => Promise<number>;
	}> = {},
): EpochFixture {
	let currentEpoch = GENESIS_EPOCH;
	let currentLease = makeLeaseRef(GENESIS_EPOCH, "writer-root", "process-start-root");
	let owner: WorkflowCoordinatorLeaseRecord | null = null;
	let head: WorkflowJournalHead = {
		workflowId: "wf-fixture",
		sequence: 1,
		eventDigest: "genesis-head",
		epochRef: GENESIS_EPOCH,
	};
	let replayCalls = 0;
	const commits: WorkflowStoreCommitInput<WorkflowRuntimeEventPayload>[] = [];
	const clock = overrides.clock ?? createClock();
	const ttlStore = overrides.ttlStore ?? new RecordingTtlStore();
	const writerIdentity = overrides.writerIdentity ?? "writer-root";
	const processStartId = overrides.processStartId ?? "process-start-root";
	const processGroupId = overrides.processGroupId ?? "group-root";
	const trustedMonotonicNow = overrides.trustedMonotonicNow ?? (() => 100);

	const appendLease: WorkflowAppendLease =
		overrides.appendLease ??
		({
			acquire: async () => currentLease,
			renew: async () => undefined,
			assertOwned: async () => undefined,
			withExclusiveGuard: async <T>(
				_input: Parameters<WorkflowAppendLease["withExclusiveGuard"]>[0],
				operation: () => Promise<T>,
			) => operation(),
			observe: async () => ({ writerIdentity: currentLease.writerIdentity, leaseRef: currentLease }),
			rotate: async (input) => {
				currentLease = input.nextLeaseRef;
				return undefined;
			},
			release: async () => undefined,
		} satisfies WorkflowAppendLease);

	const ownerStore: WorkflowCoordinatorOwnerStore =
		overrides.ownerStore ??
		({
			read: async () => owner,
		} satisfies WorkflowCoordinatorOwnerStore);
	const replaceEpoch = async (
		nextEpoch: WorkflowEpochRef,
		binding: WorkflowGenerationBinding,
	): Promise<WorkflowGenerationRotation> => {
		const previousEpoch = currentEpoch;
		const previousLeaseRef = currentLease;
		currentEpoch = nextEpoch;
		currentLease = makeLeaseRef(
			nextEpoch,
			binding.writerIdentity,
			binding.processGenerationId,
			previousLeaseRef.acquisitionEventSequence + 1,
		);
		const rotation = makeRotation(previousEpoch, nextEpoch, previousLeaseRef, currentLease, binding, head);
		head = {
			...head,
			sequence: head.sequence + 1,
			eventDigest: `fence-${nextEpoch.coordinatorEpoch}`,
			epochRef: nextEpoch,
		};
		owner = {
			workflowId: "wf-fixture",
			leaseId: currentLease.leaseId,
			ownerIdentity: binding.ownerIdentity,
			pid: process.pid,
			processStartId: binding.processGenerationId,
			processGroupId,
			epochRef: nextEpoch,
			acquiredAt: currentLease.acquiredAt,
			renewedAt: currentLease.acquiredAt,
			expiresAt: currentLease.expiresAt,
			status: "active",
		};
		return rotation;
	};

	const identity: WorkflowRuntimeStoreIdentity = {
		storeKind: "workflow",
		namespace: "test",
		rootDir: "/tmp/workflow-fixture",
		storeId: "test-store",
		workflowId: "wf-fixture",
		identityDigest: "test-store-digest",
	};
	const store: WorkflowRuntimeStore =
		overrides.store ??
		({
			identity,
			commit: async <TPayload extends WorkflowEventPayload>(
				input: WorkflowStoreCommitInput<TPayload>,
			): Promise<WorkflowStoreCommitResult<TPayload>> => {
				commits.push(input as WorkflowStoreCommitInput<WorkflowRuntimeEventPayload>);
				const sequence = head.sequence + 1;
				const eventDigest = digestObject({ sequence, payload: input.payload, leaseRef: input.leaseRef });
				const commit = makeCommit(input, sequence, eventDigest);
				head = { workflowId: input.workflowId, sequence, eventDigest, epochRef: input.epochRef };
				return { status: "committed", payload: input.payload, commit, state: {}, head };
			},
			replay: async (input) => {
				replayCalls += 1;
				if (input.expectedStoreEpoch !== head.epochRef.storeEpoch)
					return {
						workflowId: input.workflowId,
						executionKey: null,
						events: [],
						head,
						quarantined: true,
						quarantineReason: "stale_epoch",
					};
				return {
					workflowId: input.workflowId,
					executionKey: null,
					events: [],
					head,
					quarantined: false,
					quarantineReason: null,
				};
			},
			publishArtifact: async (_input: WorkflowArtifactPublishInput): Promise<WorkflowArtifactPublishResult> => {
				throw new Error("unused");
			},
			publishSnapshot: async (_input: WorkflowSnapshotPublishInput): Promise<WorkflowSnapshotPublishResult> => {
				throw new Error("unused");
			},
			compareAndSwapProjection: async (_input: WorkflowProjectionCasInput): Promise<WorkflowProjectionCasResult> => {
				throw new Error("unused");
			},
			appendOutbox: async (_input: WorkflowOutboxAppendInput): Promise<WorkflowOutboxAppendResult> => {
				throw new Error("unused");
			},
			replaceCoordinatorEpoch: replaceEpoch,
			replaceStoreEpoch: replaceEpoch,
		} satisfies WorkflowRuntimeStore);

	const managerDependencies: WorkflowEpochManagerDependencies = {
		store,
		workflowId: "wf-fixture",
		workflowRoot: "/tmp/workflow-fixture/workflows/wf-fixture",
		writerIdentity,
		clock,
		readCurrentStoreEpoch: overrides.readCurrentStoreEpoch ?? (async () => head.epochRef.storeEpoch),
		processIdentity: { pid: process.pid, processStartId, processGroupId },
		appendLease,
		ownerStore,
		rootLeaseRef: overrides.rootLeaseRef ?? currentLease,
		leaseTtlStore: ttlStore,
		trustedMonotonicNow,
	};
	const manager = createWorkflowEpochManager(managerDependencies);
	return {
		manager,
		store,
		appendLease,
		ownerStore,
		ttlStore,
		clock,
		trustedMonotonicNow,
		storeReplayCalls: replayCalls,
		commits,
	};
}

function createClock(): TestClock {
	return {
		now: () => "2030-01-01T00:00:00.000Z",
		addMilliseconds: (base, milliseconds) => new Date(Date.parse(base) + milliseconds).toISOString(),
	};
}

function makeLeaseRef(
	epochRef: WorkflowEpochRef,
	writerIdentity: string,
	processIdentity: string,
	acquisitionEventSequence = epochRef.coordinatorEpoch,
): WorkflowLeaseRef {
	return {
		...epochRef,
		leaseId: `lease-${writerIdentity}-${epochRef.coordinatorEpoch}`,
		acquisitionEventSequence,
		processIdentity,
		rootDigest: "root-digest",
		writerIdentity,
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T00:01:00.000Z",
	};
}

function makeRotation(
	previousEpoch: WorkflowEpochRef,
	nextEpoch: WorkflowEpochRef,
	previousLeaseRef: WorkflowLeaseRef,
	nextLeaseRef: WorkflowLeaseRef,
	generationBinding: WorkflowGenerationBinding,
	expectedHead: WorkflowJournalHead,
): WorkflowGenerationRotation {
	return {
		recordVersion: 1,
		generationId: `generation-${nextEpoch.coordinatorEpoch}`,
		rotationId: `rotation-${nextEpoch.coordinatorEpoch}`,
		mutationId: `rotation-${nextEpoch.coordinatorEpoch}`,
		idempotencyKey: `rotation-${nextEpoch.coordinatorEpoch}`,
		expectedHead,
		previousEpoch,
		nextEpoch,
		previousWriterIdentity: previousLeaseRef.writerIdentity,
		previousLeaseRef,
		nextLeaseRef,
		generationBinding,
		status: "committed",
		fenceEventSequence: expectedHead.sequence + 1,
		fenceEventDigest: `fence-${nextEpoch.coordinatorEpoch}`,
		activeGenerationManifestRef: {
			artifactId: `manifest-${nextEpoch.coordinatorEpoch}`,
			relativePath: `generations/generation-${nextEpoch.coordinatorEpoch}/ACTIVE`,
			digest: "manifest-digest",
			sizeBytes: 1,
			sourceEventSequence: expectedHead.sequence,
		},
		priorRecordDigest: expectedHead.eventDigest,
		keyId: "test-key",
		frameMac: "frame-mac",
		frameChecksum: "frame-checksum",
		recordMac: "record-mac",
		recordChecksum: "record-checksum",
		rotationArtifactRef: {
			artifactId: `rotation-${nextEpoch.coordinatorEpoch}`,
			relativePath: `rotations/rotation-${nextEpoch.coordinatorEpoch}.json`,
			digest: "rotation-digest",
			sizeBytes: 1,
			sourceEventSequence: expectedHead.sequence,
		},
	};
}

function makeCommit<TPayload extends WorkflowEventPayload>(
	input: WorkflowStoreCommitInput<TPayload>,
	sequence: number,
	eventDigest: string,
): WorkflowJournalCommit<TPayload> {
	const frameDigest = `frame-${sequence}`;
	const proofWithoutDigest = {
		recordVersion: 1 as const,
		generationId: `generation-${input.epochRef.coordinatorEpoch}`,
		mutationId: input.idempotencyKey,
		workflowId: input.workflowId,
		sequence,
		eventDigest,
		committedFrameDigest: frameDigest,
		expectedHead: input.expectedHead,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		writerIdentity: input.writerIdentity,
		idempotencyKey: input.idempotencyKey,
		keyId: "test-key",
		frameMac: "frame-mac",
		frameChecksum: "frame-checksum",
		recordMac: "record-mac",
		recordChecksum: "record-checksum",
		priorRecordDigest: input.expectedHead.eventDigest,
		returnedAt: "2030-01-01T00:00:00.000Z",
	};
	const commitReturnProof = { ...proofWithoutDigest, proofDigest: digestObject(proofWithoutDigest) };
	return {
		workflowId: input.workflowId,
		sequence,
		payload: input.payload,
		payloadBytes: new TextEncoder().encode(JSON.stringify(input.payload)),
		payloadDigest: digestObject(input.payload),
		priorEventDigest: input.expectedHead.eventDigest,
		eventDigest,
		recordVersion: 1,
		generationId: proofWithoutDigest.generationId,
		recordMac: "record-mac",
		recordChecksum: "record-checksum",
		expectedHead: input.expectedHead,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		idempotencyKey: input.idempotencyKey,
		returnProofId: `return-proof:${input.idempotencyKey}`,
		commitReturnProof,
		preparedFrameDigest: "prepared-frame",
		committedFrameDigest: frameDigest,
		keyId: "test-key",
		preparedFrameMac: "prepared-frame-mac",
		committedFrameMac: "committed-frame-mac",
		preparedFrameChecksum: "prepared-frame-checksum",
		committedFrameChecksum: "committed-frame-checksum",
		semanticBinding: input.semanticBinding,
		executionKey: input.executionKey,
		writerIdentity: input.writerIdentity,
	};
}
