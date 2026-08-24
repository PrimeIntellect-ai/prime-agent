import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open as openFile, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, it, vi } from "vitest";

import type {
	WorkflowDescriptorHandle,
	WorkflowEpochRef,
	WorkflowLeaseRef,
	WorkflowProjectionAdapter,
	WorkflowRuntimeStoreOpenInput,
} from "../../src/core/workflow/contracts.js";
import { digestObject } from "../../src/core/workflow/contracts.js";
import type {
	WorkflowAppendLease,
	WorkflowDescriptorNativeAdapter,
	WorkflowGenerationContextOpener,
	WorkflowJournal,
	WorkflowJournalKeyProvider,
} from "../../src/core/workflow/journal.js";
import {
	createNodeWorkflowDescriptorFs,
	createWorkflowDescriptorRootAdapters,
	deriveWorkflowGenerationId,
} from "../../src/core/workflow/journal.js";
import { type WorkflowDeferredEventOwnerValidators, WorkflowStore } from "../../src/core/workflow/reducer.js";
import type { WorkflowRuntimeStoreAdapterDependencies } from "../../src/core/workflow/runtime-store-adapter.js";
import {
	assertWorkflowRuntimeVersion,
	MIN_WORKFLOW_RUNTIME_VERSION,
	openWorkflowRuntimeStore,
} from "../../src/core/workflow/runtime-store-adapter.js";

it("accepts the runtime floor and newer releases", () => {
	expect(() => assertWorkflowRuntimeVersion(MIN_WORKFLOW_RUNTIME_VERSION)).not.toThrow();
	expect(() => assertWorkflowRuntimeVersion("0.147.0-alpha.11")).not.toThrow();
	expect(() => assertWorkflowRuntimeVersion("0.148.0")).not.toThrow();
});

it("rejects malformed, missing, and older runtime versions before opening storage", () => {
	expect(() => assertWorkflowRuntimeVersion(undefined)).toThrow("workflow_runtime_version_invalid");
	expect(() => assertWorkflowRuntimeVersion("0.147.0-alpha.01")).toThrow("workflow_runtime_version_invalid");
	expect(() => assertWorkflowRuntimeVersion("0.147.0-alpha.9")).toThrow("workflow_runtime_version_unsupported");
});

it("fails before opening or writing events when the persisted session root is absent", async () => {
	await expect(
		openWorkflowRuntimeStore(undefined, {
			runtimeVersion: MIN_WORKFLOW_RUNTIME_VERSION,
			projectionAdapter: {
				projectionKey: "goal",
				compareAndSwap: async () => "applied",
			},
			readHead: async () => {
				throw new Error("read head is unreachable without a persisted root");
			},
			successorContextOpener: {
				openSuccessor: async () => {
					throw new Error("successor opener is unreachable without a persisted root");
				},
			},
		}),
	).rejects.toThrow("workflow_session_artifact_root_unavailable");
});

it("rejects descriptor-root mismatches before opening the journal", async () => {
	const harness = await createRuntimeStoreHarness("workflow-runtime-root-mismatch");
	try {
		await expect(
			openWorkflowRuntimeStore(
				{
					...harness.input,
					workflowRoot: `${harness.root}/workflows/foreign-workflow`,
				},
				{
					runtimeVersion: MIN_WORKFLOW_RUNTIME_VERSION,
					projectionAdapter: {
						projectionKey: "goal",
						compareAndSwap: async () => "applied",
					},
					readHead: async () => {
						throw new Error("read head is unreachable for a mismatched root");
					},
					successorContextOpener: {
						openSuccessor: async () => {
							throw new Error("successor opener is unreachable for a mismatched root");
						},
					},
				},
			),
		).rejects.toThrow("workflow_descriptor_root_binding_invalid");
	} finally {
		await rm(harness.root, { recursive: true, force: true });
	}
});

it("opens and reopens one filesystem authority with bound bridge dependencies", async () => {
	const harness = await createRuntimeStoreHarness("workflow-runtime-adapter");
	const observedJournals: WorkflowJournal[] = [];
	const projectionAdapter: WorkflowProjectionAdapter = {
		projectionKey: "goal",
		compareAndSwap: async () => "applied",
	};
	const successorContextOpener: WorkflowGenerationContextOpener = {
		openSuccessor: async () => {
			throw new Error("successor context is not used while opening this authority");
		},
	};
	const adapters: WorkflowRuntimeStoreAdapterDependencies = {
		runtimeVersion: MIN_WORKFLOW_RUNTIME_VERSION,
		projectionAdapter,
		successorContextOpener,
		readHead: async (journal) => {
			observedJournals.push(journal);
			const events = await journal.replay();
			const last = events.at(-1);
			return last === undefined
				? {
						workflowId: harness.input.workflowId,
						sequence: 0,
						eventDigest: null,
						epochRef: harness.epoch,
					}
				: {
						workflowId: last.workflowId,
						sequence: last.sequence,
						eventDigest: last.eventDigest,
						epochRef: last.epochRef,
					};
		},
	};

	try {
		const opened = await openWorkflowRuntimeStore(harness.input, adapters);
		const firstReplay = await opened.replay({
			workflowId: harness.input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: harness.epoch.storeEpoch,
		});
		const secondReplay = await opened.replay({
			workflowId: harness.input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: harness.epoch.storeEpoch,
		});
		const reopened = await openWorkflowRuntimeStore(harness.input, adapters);
		const reopenedReplay = await reopened.replay({
			workflowId: harness.input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: harness.epoch.storeEpoch,
		});

		expect(firstReplay.events).toHaveLength(0);
		expect(secondReplay.events).toHaveLength(0);
		expect(reopenedReplay.events).toHaveLength(0);
		expect(opened.identity).toEqual(reopened.identity);
		expect(opened.identity).toMatchObject({
			storeKind: "workflow",
			namespace: "fixture",
			rootDir: harness.root,
			storeId: `fixture-store:${harness.input.workflowId}`,
			workflowId: harness.input.workflowId,
		});
		expect(observedJournals).toHaveLength(3);
		expect(observedJournals[0]).toBe(observedJournals[1]);
		expect(observedJournals[1]).not.toBe(observedJournals[2]);
	} finally {
		await rm(harness.root, { recursive: true, force: true });
	}
});

it("passes the exact deferred owner validators through the runtime-store opener", async () => {
	const harness = await createRuntimeStoreHarness("workflow-runtime-adapter-validators");
	const deferredOwnerValidators = createDeferredOwnerValidators();
	const open = vi.spyOn(WorkflowStore, "open");
	const adapters: WorkflowRuntimeStoreAdapterDependencies = {
		runtimeVersion: MIN_WORKFLOW_RUNTIME_VERSION,
		projectionAdapter: {
			projectionKey: "goal",
			compareAndSwap: async () => "applied",
		},
		readHead: async () => ({
			workflowId: harness.input.workflowId,
			sequence: 0,
			eventDigest: null,
			epochRef: harness.epoch,
		}),
		successorContextOpener: {
			openSuccessor: async () => {
				throw new Error("successor context is not used while opening this authority");
			},
		},
	};

	try {
		await openWorkflowRuntimeStore({ ...harness.input, deferredOwnerValidators }, adapters);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open.mock.calls[0]?.[2]).toBe(deferredOwnerValidators);
	} finally {
		open.mockRestore();
		await rm(harness.root, { recursive: true, force: true });
	}
});

interface RuntimeStoreHarness {
	readonly root: string;
	readonly epoch: WorkflowEpochRef;
	readonly input: WorkflowRuntimeStoreOpenInput;
}

function createDeferredOwnerValidators(): WorkflowDeferredEventOwnerValidators {
	return {
		autoresearch: () => undefined,
		runtime: () => undefined,
		effect: () => undefined,
		recovery: () => undefined,
	};
}

async function createRuntimeStoreHarness(workflowId: string): Promise<RuntimeStoreHarness> {
	const root = await mkdtemp(join(tmpdir(), "workflow-runtime-store-real-"));
	const workflowRoot = join(root, "workflows", workflowId);
	await mkdir(workflowRoot, { recursive: true, mode: 0o700 });
	const epoch: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
	const sessionIdentityDigest = await descriptorIdentityDigest(root, "directory");
	const workflowIdentityDigest = await descriptorIdentityDigest(workflowRoot, "directory");
	const rootSessionId = `session-${workflowId}`;
	const writerIdentity = "writer-1";
	const leaseRef: WorkflowLeaseRef = {
		...epoch,
		leaseId: `lease-${workflowId}`,
		acquisitionEventSequence: 1,
		processIdentity: "process-1",
		rootDigest: digestObject({
			descriptorIdentity: sessionIdentityDigest,
			workflowIdentity: workflowIdentityDigest,
			workflowId,
		}),
		writerIdentity,
		acquiredAt: "2026-08-13T00:00:00.000Z",
		expiresAt: "2026-08-14T00:00:00.000Z",
	};
	const descriptorRoots = createWorkflowDescriptorRootAdapters({
		sessionArtifactRoot: root,
		workflowDir: workflowRoot,
		rootSessionId,
		workflowId,
		sessionIdentityDigest,
		workflowIdentityDigest,
	});
	const input: WorkflowRuntimeStoreOpenInput = {
		artifactRoot: root,
		workflowRoot,
		descriptorRoots,
		workflowId,
		rootSessionId,
		storeEpoch: epoch.storeEpoch,
		coordinatorEpoch: epoch.coordinatorEpoch,
		writerIdentity,
		keyProvider: createTestKeyProvider(),
		appendLease: createTestAppendLease(leaseRef),
		leaseRef,
		descriptorFs: createNodeWorkflowDescriptorFs(createRealDescriptorNativeAdapter()),
		now: () => "2026-08-13T00:00:00.000Z",
	};
	return { root, epoch, input };
}

async function descriptorIdentityDigest(path: string, kind: "file" | "directory"): Promise<string> {
	const stats = await lstat(path);
	return digestObject({ device: Number(stats.dev), inode: Number(stats.ino), kind });
}

function createTestKeyProvider(): WorkflowJournalKeyProvider {
	return {
		current: async (workflowId, epoch) => createTestKey(workflowId, epoch),
		resolve: async (workflowId, _keyId, epoch) => createTestKey(workflowId, epoch),
	};
}

function createTestKey(
	workflowId: string,
	epoch: WorkflowEpochRef,
): { keyId: string; secret: Uint8Array; validStoreEpoch: number; generationId: string } {
	const generationId = deriveWorkflowGenerationId({
		workflowId,
		nextEpoch: epoch,
		rotationId: "bootstrap",
		priorHeadDigest: "test-head",
	});
	return {
		keyId: `test-key-${epoch.storeEpoch}`,
		secret: new TextEncoder().encode("workflow-runtime-store-test-secret"),
		validStoreEpoch: epoch.storeEpoch,
		generationId,
	};
}

function createTestAppendLease(initialLease: WorkflowLeaseRef): WorkflowAppendLease {
	let currentLease = initialLease;
	return {
		acquire: async () => currentLease,
		renew: async () => undefined,
		assertOwned: async (input) => {
			if (
				input.writerIdentity !== currentLease.writerIdentity ||
				digestObject(input.leaseRef) !== digestObject(currentLease) ||
				digestObject(input.epochRef) !==
					digestObject({ storeEpoch: currentLease.storeEpoch, coordinatorEpoch: currentLease.coordinatorEpoch }) ||
				input.rootDigest !== currentLease.rootDigest ||
				input.boundary.length === 0
			)
				throw new Error("append lease is not owned");
		},
		withExclusiveGuard: async (_input, operation) => operation(),
		observe: async () => ({ writerIdentity: currentLease.writerIdentity, leaseRef: currentLease }),
		rotate: async (input) => {
			if (digestObject(input.expectedLeaseRef) !== digestObject(currentLease))
				throw new Error("append lease rotation tuple is stale");
			currentLease = input.nextLeaseRef;
		},
		release: async () => undefined,
	};
}

interface RealDescriptorState {
	readonly path: string;
	readonly file: Awaited<ReturnType<typeof openFile>>;
	readonly kind: "file" | "directory";
}

function createRealDescriptorNativeAdapter(): WorkflowDescriptorNativeAdapter {
	const states = new WeakMap<WorkflowDescriptorHandle, RealDescriptorState>();
	const stateOf = (handle: WorkflowDescriptorHandle): RealDescriptorState => {
		const state = states.get(handle);
		if (state === undefined) throw new Error("Unknown real descriptor handle");
		return state;
	};
	const openHandle = async (path: string, flags: number, mode: number): Promise<WorkflowDescriptorHandle> => {
		const before = await lstat(path).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (before?.isSymbolicLink()) throw new Error("descriptor adapter refuses symlink traversal");
		const file = await openFile(path, flags, mode);
		try {
			const stats = await file.stat();
			if (
				before !== undefined &&
				(Number(before.dev) !== Number(stats.dev) || Number(before.ino) !== Number(stats.ino))
			)
				throw new Error("descriptor adapter detected a path swap during open");
			const kind = stats.isDirectory() ? "directory" : "file";
			const identityDigest = digestObject({ device: Number(stats.dev), inode: Number(stats.ino), kind });
			const handle: WorkflowDescriptorHandle = {
				identityDigest,
				write: async (bytes) => file.writeFile(bytes),
				read: async () => new Uint8Array(await file.readFile()),
				stat: async () => {
					const current = await file.stat();
					return {
						kind,
						linkCount: Number(current.nlink),
						device: Number(current.dev),
						identityDigest,
					};
				},
				sync: async () => file.sync(),
				close: async () => file.close(),
			};
			states.set(handle, { path, file, kind });
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
				await link(from, to);
				await unlink(from);
				return;
			}
			await rename(from, to);
		},
		unlinkAt: (parent, component) => unlink(join(pathOf(parent), component)),
		syncDirectoryChain: async (leaf, root) => {
			const rootPath = pathOf(root);
			const leafPath = pathOf(leaf);
			await stateOf(leaf).file.sync();
			let ancestorPath = leafPath === rootPath ? rootPath : dirname(leafPath);
			while (ancestorPath !== rootPath) {
				const ancestor = await openHandle(
					ancestorPath,
					fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
					0o700,
				);
				try {
					await ancestor.sync();
				} finally {
					await ancestor.close();
				}
				ancestorPath = dirname(ancestorPath);
			}
			await stateOf(root).file.sync();
		},
	};
}
