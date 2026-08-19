import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open as openFile, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	DurableStoreCrashBoundaryHook,
	WorkflowArtifactPublishInput,
	WorkflowArtifactPublishResult,
	WorkflowAuthenticatedMutationTuple,
	WorkflowCommitReturnProof,
	WorkflowDescriptorHandle,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowGenerationBinding,
	WorkflowGenerationRotation,
	WorkflowJournalCommit,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowOutboxAppendInput,
	WorkflowOutboxAppendResult,
	WorkflowProjectionCasInput,
	WorkflowProjectionCasResult,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreIdentity,
	WorkflowSemanticMutationBinding,
	WorkflowSnapshotPublishInput,
	WorkflowSnapshotPublishResult,
	WorkflowStoreCommitInput,
	WorkflowStoreReplayInput,
	WorkflowStoreReplayResult,
} from "../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	DurableStoreCrashBoundary,
	digestObject,
	parseCanonicalJsonBytes,
} from "../src/core/workflow/contracts.js";
import type {
	DurableStoreAuthenticatedKernel,
	DurableStoreEventCodec,
	DurableStoreMutationBuilder,
	DurableStoreMutationFrame,
	DurableStoreMutationRequest,
	DurableStoreOwnerValidator,
	DurableStoreTransitionPreview,
} from "../src/core/workflow/durable-store.js";
import {
	createDurableStoreAuthenticatedKernel,
	createDurableStoreCommitPhaseAdapter,
	createDurableStoreInstance,
} from "../src/core/workflow/durable-store.js";
import type {
	WorkflowAppendLease,
	WorkflowDescriptorNativeAdapter,
	WorkflowJournalImpl,
	WorkflowJournalKeyProvider,
	WorkflowJournalOptions,
	WorkflowJournalRecoveryResult,
} from "../src/core/workflow/journal.js";
import {
	createNodeWorkflowDescriptorFs,
	createWorkflowDescriptorRootAdapters,
	createWorkflowOwnerValidators,
	deriveWorkflowGenerationId,
	WorkflowJournal,
} from "../src/core/workflow/journal.js";

type Semantic = { amount: number };
type NativeEvent = { kind: "increment"; amount: number };
type Projection = { total: number };

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const LEASE: WorkflowLeaseRef = {
	...EPOCH,
	leaseId: "lease-1",
	acquisitionEventSequence: 0,
	processIdentity: "process-1",
	rootDigest: "root-1",
	writerIdentity: "writer-1",
	acquiredAt: "2026-08-15T00:00:00.000Z",
	expiresAt: "2026-08-15T00:05:00.000Z",
};

describe("durable store", () => {
	it("commits one typed mutation, replays it idempotently, and rejects a stale CAS", async () => {
		const harness = createHarness();
		const store = createStore(harness);
		const request = createRequest();

		const committed = await store.commit(request);
		expect(committed.replayed).toBe(false);
		expect(committed.state).toEqual({ total: 2 });
		expect((await store.replay()).map((event) => event.amount)).toEqual([2]);

		const retried = await store.commit(request);
		expect(retried.replayed).toBe(true);
		expect(retried.authenticatedEventDigest).toBe(committed.authenticatedEventDigest);
		expect(harness.commitCount).toBe(1);

		await expect(
			store.commit({
				...request,
				mutationId: "mutation-2",
				idempotencyKey: "mutation-2",
				expectedHead: emptyHead(),
			}),
		).rejects.toThrow(/stale|CAS|head/i);
		expect(harness.commitCount).toBe(1);
	});

	it("serializes two instances against one authenticated runtime store", async () => {
		const harness = createHarness();
		const left = createStore(harness);
		const right = createStore(harness);
		const first = createRequest();
		const second = {
			...first,
			mutationId: "mutation-2",
			idempotencyKey: "mutation-2",
			semantic: { amount: 3 },
		};

		const results = await Promise.allSettled([left.commit(first), right.commit(second)]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(harness.committed).toHaveLength(1);
	});

	it("reopens from the authenticated journal after a crash boundary", async () => {
		const harness = createHarness();
		const store = createStore(harness);
		const checkpoints: string[] = [];
		const crashHook: DurableStoreCrashBoundaryHook = {
			checkpoint: DurableStoreCrashBoundary.beforePrepare,
			before: async ({ checkpoint }) => {
				checkpoints.push(`before:${checkpoint}`);
			},
			after: async ({ checkpoint }) => {
				checkpoints.push(`after:${checkpoint}`);
			},
		};

		await store.commit({ ...createRequest(), crashHook });
		const reopened = createStore(harness);
		expect(await reopened.read()).toMatchObject({ state: { total: 2 }, sequence: 1 });
		expect(checkpoints).toEqual(["before:before_prepare", "after:before_prepare"]);
	});

	it("preserves the journal quarantine reason, source, and event sequence", async () => {
		const harness = createHarness();
		const journalRecovery: WorkflowJournalRecoveryResult = {
			quarantined: true,
			events: [],
			metadata: {
				status: "uncertain_committed",
				sourcePath: "generations/generation-1/events.log",
				sourceDigest: "f".repeat(64),
				sourceSizeBytes: 123,
				sequence: 7,
				epochRef: EPOCH,
				reason: "invalid_mac",
			},
		};
		const kernel = createDurableStoreAuthenticatedKernel({
			storeId: "store-1",
			storeKind: "workflow",
			namespace: "workflow",
			rootDir: "/tmp/workflow-store-1",
			workflowId: "workflow-1",
			runtimeStore: harness.store,
			readHead: async () => emptyHead(),
			readSemanticHead: async () => ({
				workflowId: "workflow-1",
				sequence: 0,
				eventDigest: null,
				stateDigest: "baseline-0",
				epochRef: EPOCH,
				generation: 1,
			}),
			readGenerations: async () => ({ workflow: 1 }),
			eventCodec: harness.kernel.eventCodec,
			phaseAdapter: harness.kernel.phaseAdapter,
			publicationPort: { prepare: async () => undefined, finalize: async () => undefined },
			recovery: async () => journalRecovery,
		});

		await expect(kernel.recover()).resolves.toEqual({
			status: "quarantined",
			metadata: {
				source: {
					artifactRef: null,
					relativePath: "generations/generation-1/events.log",
					digest: "f".repeat(64),
					sizeBytes: 123,
				},
				epochRef: EPOCH,
				reconciliation: null,
				quarantine: {
					reason: "invalid_mac",
					source: {
						artifactRef: null,
						relativePath: "generations/generation-1/events.log",
						digest: "f".repeat(64),
						sizeBytes: 123,
					},
					epochRef: EPOCH,
					eventSequence: 7,
				},
			},
		});
	});

	it("replays prepared and committed journal frames after reopening", async () => {
		const harness = await createRealJournalHarness("workflow-durable-reopen");
		let activeJournal = harness.journal;
		try {
			const appended = await activeJournal.append(createRealAppendInput(harness, "durable-reopen-1"));
			expect(appended.sequence).toBe(1);
			await closeRealJournal(activeJournal);
			activeJournal = await WorkflowJournal.open(harness.options);
			const recovery = await activeJournal.recover();
			expect(recovery.quarantined).toBe(false);
			expect(recovery.events).toHaveLength(1);
			expect(recovery.metadata.status).toBe("complete");
			expect(recovery.metadata.sequence).toBe(1);
			expect(recovery.metadata.epochRef).toEqual(EPOCH);

			const identity = {
				storeKind: "workflow" as const,
				namespace: "workflow",
				rootDir: harness.root,
				storeId: harness.options.storeId,
				workflowId: harness.workflowId,
			};
			const runtimeStore: WorkflowRuntimeStore = {
				...createHarness().store,
				identity: { ...identity, identityDigest: digestObject(identity) },
			};
			const kernel = createDurableStoreAuthenticatedKernel({
				storeId: identity.storeId,
				storeKind: identity.storeKind,
				namespace: identity.namespace,
				rootDir: identity.rootDir,
				workflowId: identity.workflowId,
				runtimeStore,
				readHead: async () => ({
					workflowId: identity.workflowId,
					sequence: 1,
					eventDigest: appended.eventDigest,
					epochRef: EPOCH,
				}),
				readSemanticHead: async () => ({
					workflowId: identity.workflowId,
					sequence: 1,
					eventDigest: appended.eventDigest,
					stateDigest: "state-1",
					epochRef: EPOCH,
					generation: 1,
				}),
				readGenerations: async () => ({ workflow: 1 }),
				eventCodec: eventCodec(),
				phaseAdapter: createDurableStoreCommitPhaseAdapter<NativeEvent>(),
				publicationPort: { prepare: async () => undefined, finalize: async () => undefined },
				recovery: async () => recovery,
			});
			await expect(kernel.recover()).resolves.toEqual({
				status: "healthy",
				metadata: {
					source: {
						artifactRef: null,
						relativePath: recovery.metadata.sourcePath,
						digest: recovery.metadata.sourceDigest,
						sizeBytes: recovery.metadata.sourceSizeBytes,
					},
					epochRef: EPOCH,
					reconciliation: null,
					quarantine: null,
				},
			});
		} finally {
			await closeRealJournal(activeJournal);
			await rm(harness.root, { recursive: true, force: true });
		}
	});
});

interface Harness {
	committed: WorkflowJournalCommit<WorkflowEventPayload>[];
	commitCount: number;
	store: WorkflowRuntimeStore;
	kernel: DurableStoreAuthenticatedKernel<NativeEvent>;
}

function emptyHead(): WorkflowJournalHead {
	return { workflowId: "workflow-1", sequence: 0, eventDigest: null, epochRef: EPOCH };
}

function createRequest(): DurableStoreMutationRequest<Semantic> {
	return {
		mutationId: "mutation-1",
		semantic: { amount: 2 },
		idempotencyKey: "mutation-1",
		expectedHead: emptyHead(),
		baselineDigest: "baseline-0",
		expectedGenerations: { workflow: 1 },
		writerIdentity: "writer-1",
		leaseRef: LEASE,
		epochRef: EPOCH,
		executionKey: "execution-1",
	};
}

function createStore(harness: Harness) {
	return createDurableStoreInstance<NativeEvent, Projection, Semantic>({
		storeId: "store-1",
		storeKind: "workflow",
		namespace: "workflow",
		rootDir: "/tmp/workflow-store-1",
		initialState: { total: 0 },
		reduce: (state, event) => ({ total: state.total + event.amount }),
		mutationBuilder: mutationBuilder(),
		ownerValidator: ownerValidator(),
		authenticatedKernel: harness.kernel,
		eventCodec: harness.kernel.eventCodec,
		phaseAdapter: harness.kernel.phaseAdapter,
		publicationPort: { prepare: async () => undefined, finalize: async () => undefined },
	});
}

function eventCodec(): DurableStoreEventCodec<NativeEvent> {
	return {
		encode: canonicalJsonBytes,
		decode: (bytes) => {
			const value = parseCanonicalJsonBytes(bytes);
			if (
				value === null ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				value.kind !== "increment" ||
				typeof value.amount !== "number"
			)
				throw new Error("invalid native event");
			return { kind: "increment", amount: value.amount };
		},
		validate: (event) => {
			if (event.kind !== "increment" || !Number.isSafeInteger(event.amount) || event.amount <= 0)
				throw new Error("invalid native event");
		},
		toWorkflowEvent: (event) => ({
			kind: "workflow_started",
			workflowId: "workflow-1",
			rootSessionId: "session-1",
			objective: String(event.amount),
		}),
		fromWorkflowEvent: (event) => {
			if (event.kind !== "workflow_started") throw new Error("wrong workflow event");
			return { kind: "increment", amount: Number(event.objective) };
		},
	};
}

function mutationBuilder(): DurableStoreMutationBuilder<Semantic, NativeEvent> {
	return {
		preview: (input, current): DurableStoreTransitionPreview<NativeEvent> => ({
			nextState: { kind: "increment", amount: input.semantic.amount },
			previewDigest: digestObject(current.head),
			semanticHead: current.head,
		}),
		build: (input): DurableStoreMutationFrame<NativeEvent> => ({
			binding: {
				mutationId: input.mutationId,
				baselineDigest: input.baselineDigest,
				expectedGenerations: input.expectedGenerations,
				ownerId: "owner-1",
				phase: "planning",
				reducerDigest: "reducer-1",
				semanticHead: {
					workflowId: "workflow-1",
					sequence: input.expectedHead.sequence,
					eventDigest: input.expectedHead.eventDigest,
					stateDigest: input.baselineDigest,
					epochRef: input.epochRef,
					generation: 1,
				},
				expectedHead: input.expectedHead,
				idempotencyKey: input.idempotencyKey,
				executionKey: input.executionKey,
				writerIdentity: input.writerIdentity,
				leaseRef: input.leaseRef,
				epochRef: input.epochRef,
			},
			preparedEvent: { kind: "increment", amount: input.semantic.amount },
			committedEvent: { kind: "increment", amount: input.semantic.amount },
			artifactPublishes: [],
			snapshot: null,
			projection: null,
			outbox: null,
			postCommitExtension: null,
		}),
	};
}

function ownerValidator(): DurableStoreOwnerValidator<Semantic, NativeEvent> {
	return {
		validateSemanticPreflight: (input) => {
			if (input.semantic.amount <= 0) throw new Error("semantic amount must be positive");
		},
		validateFrame: (frame) => {
			if (frame.binding.ownerId !== "owner-1") throw new Error("unexpected owner");
		},
		validateReplay: (event) => {
			if (event.payload.kind !== "workflow_started") throw new Error("unexpected event");
		},
	};
}

function createHarness(): Harness {
	const identity = {
		storeKind: "workflow" as const,
		namespace: "workflow",
		rootDir: "/tmp/workflow-store-1",
		storeId: "store-1",
		workflowId: "workflow-1",
	};
	const runtimeIdentity: WorkflowRuntimeStoreIdentity = { ...identity, identityDigest: digestObject(identity) };
	const committed: WorkflowJournalCommit<WorkflowEventPayload>[] = [];
	const head = (): WorkflowJournalHead => {
		const event = committed.at(-1);
		return event === undefined
			? emptyHead()
			: {
					workflowId: event.workflowId,
					sequence: event.sequence,
					eventDigest: event.eventDigest,
					epochRef: event.epochRef,
				};
	};
	const store: WorkflowRuntimeStore = {
		identity: runtimeIdentity,
		commit: async <TPayload extends WorkflowEventPayload>(input: WorkflowStoreCommitInput<TPayload>) => {
			const current = head();
			if (digestObject(input.expectedHead) !== digestObject(current)) throw new Error("runtime CAS is stale");
			const sequence = current.sequence + 1;
			const payloadBytes = canonicalJsonBytes(input.payload);
			const eventDigest = digestObject({ sequence, payload: input.payload, prior: current.eventDigest });
			const commit = createCommit(input, sequence, payloadBytes, eventDigest, current);
			committed.push(commit);
			return { status: "committed", payload: input.payload, commit, state: null, head: head() };
		},
		replay: async (input: WorkflowStoreReplayInput): Promise<WorkflowStoreReplayResult> => ({
			workflowId: input.workflowId,
			executionKey: committed.at(-1)?.executionKey ?? null,
			events: committed.filter((event) => event.sequence >= input.fromSequence),
			head: head(),
			quarantined: false,
			quarantineReason: null,
		}),
		publishArtifact: async (_input: WorkflowArtifactPublishInput): Promise<WorkflowArtifactPublishResult> => {
			throw new Error("not used");
		},
		publishSnapshot: async (_input: WorkflowSnapshotPublishInput): Promise<WorkflowSnapshotPublishResult> => {
			throw new Error("not used");
		},
		compareAndSwapProjection: async (_input: WorkflowProjectionCasInput): Promise<WorkflowProjectionCasResult> =>
			"applied",
		appendOutbox: async (_input: WorkflowOutboxAppendInput): Promise<WorkflowOutboxAppendResult> => {
			throw new Error("not used");
		},
		replaceCoordinatorEpoch: async (
			_nextEpoch: WorkflowEpochRef,
			_binding: WorkflowGenerationBinding,
		): Promise<WorkflowGenerationRotation> => {
			throw new Error("not used");
		},
		replaceStoreEpoch: async (
			_nextEpoch: WorkflowEpochRef,
			_binding: WorkflowGenerationBinding,
		): Promise<WorkflowGenerationRotation> => {
			throw new Error("not used");
		},
	};
	const harness: Harness = {
		committed,
		commitCount: 0,
		store,
		kernel: undefined as never,
	};
	const codec = eventCodec();
	harness.kernel = {
		rootDir: identity.rootDir,
		namespace: identity.namespace,
		storeId: identity.storeId,
		workflowId: identity.workflowId,
		storeKind: identity.storeKind,
		runtimeStore: store,
		readHead: async () => head(),
		readSemanticHead: async () => ({
			workflowId: identity.workflowId,
			sequence: head().sequence,
			eventDigest: head().eventDigest,
			stateDigest: head().sequence === 0 ? "baseline-0" : `baseline-${head().sequence}`,
			epochRef: head().epochRef,
			generation: 1,
		}),
		readGenerations: async () => ({ workflow: 1 }),
		eventCodec: codec,
		phaseAdapter: createDurableStoreCommitPhaseAdapter<NativeEvent>(),
		prepareDependentPublications: async () => undefined,
		finalizeDependentPublications: async () => undefined,
		commitSemanticMutation: async (input) => {
			harness.commitCount += 1;
			if (input.crashHook?.checkpoint === DurableStoreCrashBoundary.beforePrepare) {
				await input.crashHook.before({
					storeId: identity.workflowId,
					mutationId: input.mutation.mutationId,
					checkpoint: DurableStoreCrashBoundary.beforePrepare,
				});
				await input.crashHook.after({
					storeId: identity.workflowId,
					mutationId: input.mutation.mutationId,
					checkpoint: DurableStoreCrashBoundary.beforePrepare,
					digest: "event-digest",
				});
			}
			const committedResult = await store.commit({
				workflowId: identity.workflowId,
				payload: codec.toWorkflowEvent(input.frame.committedEvent),
				expectedHead: input.mutation.expectedHead,
				semanticBinding: input.authenticatedBinding,
				epochRef: input.mutation.epochRef,
				leaseRef: input.mutation.leaseRef,
				idempotencyKey: input.mutation.idempotencyKey,
				writerIdentity: input.mutation.writerIdentity,
				executionKey: input.mutation.executionKey,
			});
			return { commit: committedResult.commit, head: committedResult.head, postCommitExtension: null };
		},
		replay: async () => committed,
		recover: async () => ({
			status: "healthy" as const,
			metadata: {
				source: { artifactRef: null, relativePath: "events.log", digest: head().eventDigest, sizeBytes: 0 },
				epochRef: head().epochRef,
				reconciliation: null,
				quarantine: null,
			},
		}),
	};
	return harness;
}

interface RealJournalHarness {
	readonly root: string;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly epoch: WorkflowEpochRef;
	readonly writerIdentity: string;
	readonly leaseRef: WorkflowLeaseRef;
	readonly options: WorkflowJournalOptions;
	readonly journal: WorkflowJournalImpl;
}

async function createRealJournalHarness(workflowId: string): Promise<RealJournalHarness> {
	const root = await mkdtemp(join(tmpdir(), "workflow-durable-real-"));
	const workflowDir = join(root, "workflows", workflowId);
	await mkdir(workflowDir, { recursive: true, mode: 0o700 });
	const rootIdentityDigest = await descriptorIdentityDigest(root, "directory");
	const workflowIdentityDigest = await descriptorIdentityDigest(workflowDir, "directory");
	const rootSessionId = `session-${workflowId}`;
	const writerIdentity = "writer-1";
	const leaseRef: WorkflowLeaseRef = {
		...EPOCH,
		leaseId: `lease-${workflowId}`,
		acquisitionEventSequence: 1,
		processIdentity: "process-1",
		rootDigest: digestObject({
			descriptorIdentity: rootIdentityDigest,
			workflowIdentity: workflowIdentityDigest,
			workflowId,
		}),
		writerIdentity,
		acquiredAt: "2026-08-15T00:00:00.000Z",
		expiresAt: "2026-08-16T00:00:00.000Z",
	};
	const descriptorRoots = createWorkflowDescriptorRootAdapters({
		sessionArtifactRoot: root,
		workflowDir,
		rootSessionId,
		workflowId,
		sessionIdentityDigest: rootIdentityDigest,
		workflowIdentityDigest,
	});
	const options: WorkflowJournalOptions = {
		artifactRoot: root,
		sessionArtifactRoot: root,
		workflowDir,
		descriptorRoots,
		storeKind: "workflow",
		namespace: "workflow",
		storeId: `store-${workflowId}`,
		workflowId,
		rootSessionId,
		epoch: EPOCH,
		writerIdentity,
		keyProvider: createRealKeyProvider(),
		appendLease: createRealAppendLease(leaseRef, writerIdentity, [leaseRef.rootDigest, workflowIdentityDigest]),
		leaseRef,
		descriptorFs: createNodeWorkflowDescriptorFs(createRealDescriptorNativeAdapter()),
		ownerValidators: createWorkflowOwnerValidators(),
		now: () => "2026-08-15T00:00:00.000Z",
		successorContextOpener: {
			openSuccessor: async () => {
				throw new Error("successor context is not used by this focused harness");
			},
		},
	};
	return {
		root,
		workflowId,
		rootSessionId,
		epoch: EPOCH,
		writerIdentity,
		leaseRef,
		options,
		journal: await WorkflowJournal.open(options),
	};
}

function createRealAppendInput(
	harness: RealJournalHarness,
	idempotencyKey: string,
): Parameters<WorkflowJournalImpl["append"]>[0] {
	const expectedHead: WorkflowJournalHead = {
		workflowId: harness.workflowId,
		sequence: 0,
		eventDigest: null,
		epochRef: harness.epoch,
	};
	const payload: WorkflowEventPayload = {
		kind: "workflow_started",
		workflowId: harness.workflowId,
		rootSessionId: harness.rootSessionId,
		objective: "durable-reopen",
	};
	const semanticBinding: WorkflowSemanticMutationBinding = {
		mutationId: idempotencyKey,
		baselineDigest: digestObject(expectedHead),
		expectedGenerations: { [harness.journal.descriptorContext.generationId]: harness.epoch.storeEpoch },
		ownerId: "durable-store-test",
		phase: "recovering",
		reducerDigest: digestObject(payload),
		semanticHead: {
			...expectedHead,
			stateDigest: digestObject(expectedHead),
			generation: harness.epoch.storeEpoch,
		},
		expectedHead,
		idempotencyKey,
		executionKey: null,
		writerIdentity: harness.writerIdentity,
		leaseRef: harness.leaseRef,
		epochRef: harness.epoch,
	};
	return {
		workflowId: harness.workflowId,
		payload,
		expectedHead,
		epochRef: harness.epoch,
		leaseRef: harness.leaseRef,
		idempotencyKey,
		writerIdentity: harness.writerIdentity,
		executionKey: null,
		semanticBinding,
		returnProofId: `return-proof:${idempotencyKey}`,
	};
}

async function closeRealJournal(journal: WorkflowJournalImpl): Promise<void> {
	await Promise.all([
		journal.descriptorContext.workflow.close().catch(() => undefined),
		journal.descriptorContext.root.close().catch(() => undefined),
	]);
}

async function descriptorIdentityDigest(path: string, kind: "file" | "directory"): Promise<string> {
	const stats = await lstat(path);
	return digestObject({ device: Number(stats.dev), inode: Number(stats.ino), kind });
}

function createRealKeyProvider(): WorkflowJournalKeyProvider {
	return {
		current: async (workflowId, epoch) => createRealKey(workflowId, epoch),
		resolve: async (workflowId, keyId, epoch) => {
			const key = createRealKey(workflowId, epoch);
			if (key.keyId !== keyId) throw new Error("durable-store test key mismatch");
			return key;
		},
	};
}

function createRealKey(
	workflowId: string,
	epoch: WorkflowEpochRef,
): { keyId: string; secret: Uint8Array; validStoreEpoch: number; generationId: string } {
	return {
		keyId: `test-key-${epoch.storeEpoch}`,
		secret: new TextEncoder().encode("workflow-journal-test-secret"),
		validStoreEpoch: epoch.storeEpoch,
		generationId: deriveWorkflowGenerationId({
			workflowId,
			nextEpoch: epoch,
			rotationId: "bootstrap",
			priorHeadDigest: "test-head",
		}),
	};
}

function createRealAppendLease(
	initialLease: WorkflowLeaseRef,
	initialWriter: string,
	acceptedRootDigests: readonly string[],
): WorkflowAppendLease {
	let guard: Promise<void> = Promise.resolve();
	return {
		acquire: async () => initialLease,
		renew: async () => undefined,
		assertOwned: (input) => thisAssertOwned(input, initialLease, initialWriter, acceptedRootDigests),
		withExclusiveGuard: async (input, operation) => {
			const previous = guard;
			let release!: () => void;
			guard = new Promise<void>((resolvePromise) => {
				release = resolvePromise;
			});
			await previous;
			try {
				await thisAssertOwned(input, initialLease, initialWriter, acceptedRootDigests);
				return await operation();
			} finally {
				release();
			}
		},
		observe: async () => ({ writerIdentity: initialWriter, leaseRef: initialLease }),
		rotate: async () => undefined,
		release: async () => undefined,
	};
}

async function thisAssertOwned(
	input: Parameters<WorkflowAppendLease["assertOwned"]>[0],
	leaseRef: WorkflowLeaseRef,
	writerIdentity: string,
	acceptedRootDigests: readonly string[],
): Promise<void> {
	if (
		input.writerIdentity !== writerIdentity ||
		input.leaseRef.writerIdentity !== writerIdentity ||
		digestObject(input.leaseRef) !== digestObject(leaseRef) ||
		digestObject(input.epochRef) !== digestObject(EPOCH) ||
		!acceptedRootDigests.includes(input.rootDigest) ||
		input.boundary.length === 0
	)
		throw new Error("durable-store test append lease is not owned");
}

interface RealDescriptorState {
	readonly path: string;
	readonly file: Awaited<ReturnType<typeof openFile>>;
	readonly kind: "file" | "directory";
	readonly identityDigest: string;
}

function createRealDescriptorNativeAdapter(): WorkflowDescriptorNativeAdapter {
	const states = new WeakMap<WorkflowDescriptorHandle, RealDescriptorState>();
	const stateOf = (handle: WorkflowDescriptorHandle): RealDescriptorState => {
		const state = states.get(handle);
		if (state === undefined) throw new Error("Unknown durable-store test descriptor handle.");
		return state;
	};
	const openHandle = async (path: string, flags: number, mode: number): Promise<WorkflowDescriptorHandle> => {
		const beforeStats = await lstat(path).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (beforeStats?.isSymbolicLink()) throw new Error("descriptor adapter refuses symlink traversal");
		const file = await openFile(path, flags, mode);
		try {
			const stats = await file.stat();
			const kind = stats.isDirectory() ? "directory" : "file";
			if (
				beforeStats !== undefined &&
				(Number(beforeStats.dev) !== Number(stats.dev) || Number(beforeStats.ino) !== Number(stats.ino))
			)
				throw new Error("descriptor adapter detected a path swap during open");
			if (kind === "file" && Number(stats.nlink) !== 1)
				throw new Error("descriptor adapter refuses hard-linked regular files");
			const identityDigest = digestObject({ device: Number(stats.dev), inode: Number(stats.ino), kind });
			const handle: WorkflowDescriptorHandle = {
				identityDigest,
				write: async (bytes) => {
					if (kind !== "file") throw new Error("directory descriptor cannot be written");
					await file.writeFile(bytes);
				},
				read: async () => new Uint8Array(await file.readFile()),
				stat: async () => {
					const current = await file.stat();
					return { kind, linkCount: Number(current.nlink), device: Number(current.dev), identityDigest };
				},
				sync: async () => {
					await file.sync();
				},
				close: async () => {
					await file.close();
				},
			};
			states.set(handle, { path, file, kind, identityDigest });
			return handle;
		} catch (error) {
			await file.close().catch(() => undefined);
			throw error;
		}
	};
	const pathOf = (handle: WorkflowDescriptorHandle): string => stateOf(handle).path;
	return {
		openRoot: (rootPath) =>
			openHandle(
				rootPath,
				fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
				0o700,
			),
		mkdirAt: async (parent, component, mode) => {
			const path = join(pathOf(parent), component);
			await mkdir(path, { recursive: false, mode });
			return openHandle(
				path,
				fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
				mode,
			);
		},
		openAt: (parent, component, flags, mode) => openHandle(join(pathOf(parent), component), flags, mode),
		renameAt: async (parent, fromComponent, toComponent, options = { replace: true, noReplace: false }) => {
			const from = join(pathOf(parent), fromComponent);
			const to = join(pathOf(parent), toComponent);
			if (options.noReplace) {
				try {
					await link(from, to);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
					throw error;
				}
				await unlink(from);
				return;
			}
			await rename(from, to);
		},
		unlinkAt: (parent, component) => unlink(join(pathOf(parent), component)),
		syncDirectoryChain: async (leaf, root) => {
			const rootPath = pathOf(root);
			const leafState = stateOf(leaf);
			await leafState.file.sync();
			let ancestorPath = leafState.path === rootPath ? rootPath : dirname(leafState.path);
			while (ancestorPath !== rootPath) {
				const ancestor = await openHandle(
					ancestorPath,
					fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
					0o700,
				);
				try {
					await ancestor.sync();
				} finally {
					await ancestor.close().catch(() => undefined);
				}
				const parentPath = dirname(ancestorPath);
				if (parentPath === ancestorPath) throw new Error("descriptor adapter could not reach opened root");
				ancestorPath = parentPath;
			}
			await stateOf(root).file.sync();
		},
	};
}

function createCommit<TPayload extends WorkflowEventPayload>(
	input: WorkflowStoreCommitInput<TPayload>,
	sequence: number,
	payloadBytes: Uint8Array,
	eventDigest: string,
	head: WorkflowJournalHead,
): WorkflowJournalCommit<TPayload> {
	const tuple: WorkflowAuthenticatedMutationTuple = {
		recordVersion: 1 as const,
		generationId: "generation-1",
		workflowId: input.workflowId,
		mutationId: input.semanticBinding.mutationId,
		expectedHead: input.expectedHead,
		sequence,
		eventDigest,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		writerIdentity: input.writerIdentity,
		idempotencyKey: input.idempotencyKey,
		keyId: "key-1",
		frameMac: "frame-mac",
		frameChecksum: "frame-checksum",
		recordMac: "record-mac",
		recordChecksum: "record-checksum",
		priorRecordDigest: head.eventDigest,
	};
	const proofWithoutDigest = {
		recordVersion: 1 as const,
		generationId: tuple.generationId,
		mutationId: `return-proof:${input.idempotencyKey}`,
		workflowId: input.workflowId,
		sequence,
		eventDigest,
		committedFrameDigest: "committed-frame",
		expectedHead: input.expectedHead,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		writerIdentity: input.writerIdentity,
		idempotencyKey: input.idempotencyKey,
		keyId: tuple.keyId,
		frameMac: tuple.frameMac,
		frameChecksum: tuple.frameChecksum,
		recordMac: tuple.recordMac,
		recordChecksum: tuple.recordChecksum,
		priorRecordDigest: head.eventDigest,
		returnedAt: "2026-08-15T00:00:00.000Z",
	};
	const proof: WorkflowCommitReturnProof = { ...proofWithoutDigest, proofDigest: digestObject(proofWithoutDigest) };
	return {
		workflowId: input.workflowId,
		sequence,
		payload: input.payload,
		payloadBytes,
		payloadDigest: digestObject(input.payload),
		priorEventDigest: head.eventDigest,
		eventDigest,
		recordVersion: 1,
		generationId: tuple.generationId,
		recordMac: tuple.recordMac,
		recordChecksum: tuple.recordChecksum,
		expectedHead: input.expectedHead,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		idempotencyKey: input.idempotencyKey,
		returnProofId: proof.mutationId,
		commitReturnProof: proof,
		preparedFrameDigest: "prepared-frame",
		committedFrameDigest: proof.committedFrameDigest,
		keyId: tuple.keyId,
		preparedFrameMac: "prepared-mac",
		committedFrameMac: tuple.frameMac,
		preparedFrameChecksum: "prepared-checksum",
		committedFrameChecksum: tuple.frameChecksum,
		semanticBinding: input.semanticBinding,
		executionKey: input.executionKey,
		writerIdentity: input.writerIdentity,
	};
}
