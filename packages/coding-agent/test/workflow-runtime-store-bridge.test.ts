import { expect, it } from "vitest";
import type {
	DurableStoreCrashBoundaryHook,
	WorkflowArtifactPublisher,
	WorkflowArtifactPublishInput,
	WorkflowArtifactPublishResult,
	WorkflowAuthenticatedMutationTuple,
	WorkflowCommitReturnProof,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowGenerationBinding,
	WorkflowGenerationRotation,
	WorkflowJournalEvent,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowOutboxAppender,
	WorkflowOutboxAppendInput,
	WorkflowOutboxAppendResult,
	WorkflowProjectionAdapter,
	WorkflowProjectionCasInput,
	WorkflowRuntimeStoreIdentity,
	WorkflowSemanticMutationBinding,
	WorkflowSnapshotPublisher,
	WorkflowSnapshotPublishInput,
	WorkflowSnapshotPublishResult,
	WorkflowStoreCommitInput,
} from "../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject } from "../src/core/workflow/contracts.js";
import type { WorkflowJournal } from "../src/core/workflow/journal.js";
import type { WorkflowState, WorkflowStore } from "../src/core/workflow/reducer.js";
import {
	WorkflowRuntimeStoreBridge,
	type WorkflowRuntimeStoreBridgeDependencies,
} from "../src/core/workflow/runtime-store-bridge.js";

const epoch: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };

type TestWorkflowJournal = WorkflowJournal & {
	replayLogicalHistory(): Promise<readonly WorkflowJournalEvent[]>;
};

it("commits through one store and re-reads the authenticated event from that journal", async () => {
	const fixture = createBridgeFixture();
	const input = fixture.commitInput;

	const result = await fixture.bridge.commit(input);

	expect(fixture.storeCommitCount).toBe(1);
	expect(fixture.logicalReplayCount).toBe(1);
	expect(fixture.localReplayCount).toBe(0);
	expect(fixture.capturedPrecondition?.expectedSourceJournalDigest).toBeNull();
	expect(result.status).toBe("committed");
	expect(result.payload).toBe(input.payload);
	expect(result.commit.eventDigest).toBe(fixture.event.eventDigest);
	expect(result.commit.payloadBytes).toEqual(fixture.event.payloadBytes);
	expect(result.commit.commitReturnProof.proofDigest).toBe(fixture.event.commitReturnProof.proofDigest);
	expect(result.head).toEqual({
		workflowId: input.workflowId,
		sequence: fixture.event.sequence,
		eventDigest: fixture.event.eventDigest,
		epochRef: fixture.event.epochRef,
	});
});

it("replays the complete logical history and authenticated head after generation rotation", async () => {
	const fixture = createBridgeFixture({ rotated: true });

	const result = await fixture.bridge.replay({
		workflowId: fixture.workflowId,
		fromSequence: 1,
		expectedStoreEpoch: epoch.storeEpoch,
	});

	expect(result.events.map((event) => event.sequence)).toEqual([
		fixture.event.sequence,
		fixture.successorEvent?.sequence,
	]);
	expect(result.head).toEqual({
		workflowId: fixture.workflowId,
		sequence: fixture.successorEvent?.sequence,
		eventDigest: fixture.successorEvent?.eventDigest,
		epochRef: fixture.successorEvent?.epochRef,
	});
	expect(result.executionKey).toBe(fixture.successorEvent?.executionKey);
	expect(fixture.logicalReplayCount).toBe(1);
	expect(fixture.localReplayCount).toBe(0);
});

it("re-reads an idempotency record from the predecessor generation history", async () => {
	const fixture = createBridgeFixture({ rotated: true });

	const result = await fixture.bridge.commit(fixture.commitInput);

	expect(result.commit.eventDigest).toBe(fixture.event.eventDigest);
	expect(result.head).toEqual({
		workflowId: fixture.workflowId,
		sequence: fixture.successorEvent?.sequence,
		eventDigest: fixture.successorEvent?.eventDigest,
		epochRef: fixture.successorEvent?.epochRef,
	});
	expect(fixture.logicalReplayCount).toBe(1);
	expect(fixture.localReplayCount).toBe(0);
});

it("derives an empty successor head from an authenticated rotation fence nextEpoch", async () => {
	const fixture = createBridgeFixture();
	const nextEpoch: WorkflowEpochRef = {
		storeEpoch: epoch.storeEpoch,
		coordinatorEpoch: epoch.coordinatorEpoch + 1,
	};
	const fenceEvent = createCoordinatorFenceEvent(fixture.event, nextEpoch);
	const logicalEvents = [fixture.event, fenceEvent] as const;
	fixture.dependencies.journal.replayLogicalHistory = async () => logicalEvents;
	fixture.dependencies.readHead = async () => ({
		workflowId: fixture.workflowId,
		sequence: fenceEvent.sequence,
		eventDigest: fenceEvent.eventDigest,
		epochRef: nextEpoch,
	});

	const result = await fixture.bridge.replay({
		workflowId: fixture.workflowId,
		fromSequence: 1,
		expectedStoreEpoch: epoch.storeEpoch,
	});

	expect(result.events.map((event) => event.sequence)).toEqual([fixture.event.sequence, fenceEvent.sequence]);
	expect(result.head).toEqual({
		workflowId: fixture.workflowId,
		sequence: fenceEvent.sequence,
		eventDigest: fenceEvent.eventDigest,
		epochRef: nextEpoch,
	});

	const tamperedFence = {
		...fenceEvent,
		payload: {
			...fenceEvent.payload,
			nextEpoch: { ...nextEpoch, coordinatorEpoch: nextEpoch.coordinatorEpoch + 1 },
		},
	};
	fixture.dependencies.journal.replayLogicalHistory = async () => [fixture.event, tamperedFence];
	fixture.dependencies.readHead = async () => ({
		workflowId: fixture.workflowId,
		sequence: tamperedFence.sequence,
		eventDigest: tamperedFence.eventDigest,
		epochRef: tamperedFence.payload.nextEpoch,
	});

	await expect(
		fixture.bridge.replay({
			workflowId: fixture.workflowId,
			fromSequence: 1,
			expectedStoreEpoch: epoch.storeEpoch,
		}),
	).rejects.toThrow(/unauthenticated|mismatched committed payload/i);
});

it("returns a store-rotation fence nextEpoch as the committed head", async () => {
	const fixture = createBridgeFixture();
	const nextEpoch: WorkflowEpochRef = { storeEpoch: epoch.storeEpoch + 1, coordinatorEpoch: epoch.coordinatorEpoch };
	const fenceEvent = createStoreFenceEvent(fixture.event, nextEpoch);
	fixture.dependencies.journal.replayLogicalHistory = async () => [fixture.event, fenceEvent];

	const result = await fixture.bridge.commit(fixture.commitInput);

	expect(result.head).toEqual({
		workflowId: fixture.workflowId,
		sequence: fenceEvent.sequence,
		eventDigest: fenceEvent.eventDigest,
		epochRef: nextEpoch,
	});
});

it("rejects a tampered store-fence payload before returning a commit head", async () => {
	const fixture = createBridgeFixture();
	const nextEpoch: WorkflowEpochRef = { storeEpoch: epoch.storeEpoch + 1, coordinatorEpoch: epoch.coordinatorEpoch };
	const fenceEvent = createStoreFenceEvent(fixture.event, nextEpoch);
	const tamperedFence = {
		...fenceEvent,
		payload: {
			...fenceEvent.payload,
			nextEpoch: { ...nextEpoch, storeEpoch: nextEpoch.storeEpoch + 1 },
		},
	};
	fixture.dependencies.journal.replayLogicalHistory = async () => [fixture.event, tamperedFence];

	await expect(fixture.bridge.commit(fixture.commitInput)).rejects.toThrow(
		/unauthenticated|mismatched committed payload/i,
	);
});

it("replays mixed historical and current store epochs without quarantining history", async () => {
	const fixture = createBridgeFixture();
	const nextEpoch: WorkflowEpochRef = { storeEpoch: epoch.storeEpoch + 1, coordinatorEpoch: epoch.coordinatorEpoch };
	const fenceEvent = createStoreFenceEvent(fixture.event, nextEpoch);
	const successorEvent = createSuccessorEvent(fenceEvent, nextEpoch);
	fixture.dependencies.journal.replayLogicalHistory = async () => [fixture.event, fenceEvent, successorEvent];
	fixture.dependencies.readHead = async () => ({
		workflowId: fixture.workflowId,
		sequence: successorEvent.sequence,
		eventDigest: successorEvent.eventDigest,
		epochRef: nextEpoch,
	});

	const result = await fixture.bridge.replay({
		workflowId: fixture.workflowId,
		fromSequence: 1,
		expectedStoreEpoch: nextEpoch.storeEpoch,
	});

	expect(result.quarantined).toBe(false);
	expect(result.events.map((event) => event.sequence)).toEqual([
		fixture.event.sequence,
		fenceEvent.sequence,
		successorEvent.sequence,
	]);
	expect(result.head).toEqual({
		workflowId: fixture.workflowId,
		sequence: successorEvent.sequence,
		eventDigest: successorEvent.eventDigest,
		epochRef: nextEpoch,
	});
});

it("rejects a store fence whose authenticated nextEpoch disagrees with the current head", async () => {
	const fixture = createBridgeFixture();
	const expectedEpoch: WorkflowEpochRef = {
		storeEpoch: epoch.storeEpoch + 1,
		coordinatorEpoch: epoch.coordinatorEpoch,
	};
	const invalidFenceEpoch: WorkflowEpochRef = {
		storeEpoch: expectedEpoch.storeEpoch + 1,
		coordinatorEpoch: expectedEpoch.coordinatorEpoch,
	};
	const fenceEvent = createStoreFenceEvent(fixture.event, invalidFenceEpoch);
	fixture.dependencies.journal.replayLogicalHistory = async () => [fixture.event, fenceEvent];
	fixture.dependencies.readHead = async () => ({
		workflowId: fixture.workflowId,
		sequence: fenceEvent.sequence,
		eventDigest: fenceEvent.eventDigest,
		epochRef: expectedEpoch,
	});

	await expect(
		fixture.bridge.replay({
			workflowId: fixture.workflowId,
			fromSequence: 1,
			expectedStoreEpoch: expectedEpoch.storeEpoch,
		}),
	).rejects.toThrow(/head.*journal|journal.*head/i);
});

it("quarantines a future historical epoch instead of binding it to the current head", async () => {
	const fixture = createBridgeFixture();
	const currentEpoch: WorkflowEpochRef = {
		storeEpoch: epoch.storeEpoch + 1,
		coordinatorEpoch: epoch.coordinatorEpoch,
	};
	const fenceEvent = createStoreFenceEvent(fixture.event, currentEpoch);
	const futureEpoch: WorkflowEpochRef = {
		storeEpoch: currentEpoch.storeEpoch + 1,
		coordinatorEpoch: currentEpoch.coordinatorEpoch,
	};
	const futureEvent = createSuccessorEvent(fenceEvent, futureEpoch);
	const currentEvent = createSuccessorEvent(futureEvent, currentEpoch);
	fixture.dependencies.journal.replayLogicalHistory = async () => [
		fixture.event,
		fenceEvent,
		futureEvent,
		currentEvent,
	];
	fixture.dependencies.readHead = async () => ({
		workflowId: fixture.workflowId,
		sequence: currentEvent.sequence,
		eventDigest: currentEvent.eventDigest,
		epochRef: currentEpoch,
	});

	await expect(
		fixture.bridge.replay({
			workflowId: fixture.workflowId,
			fromSequence: 1,
			expectedStoreEpoch: currentEpoch.storeEpoch,
		}),
	).resolves.toMatchObject({ quarantined: true, quarantineReason: "stale_epoch", events: [] });
});

it("rejects a missing logical predecessor chain without falling back to local replay", async () => {
	const fixture = createBridgeFixture({ rotated: true });
	fixture.dependencies.journal.replayLogicalHistory = async () => {
		throw new Error("missing predecessor chain");
	};

	await expect(
		fixture.bridge.replay({
			workflowId: fixture.workflowId,
			fromSequence: 1,
			expectedStoreEpoch: epoch.storeEpoch,
		}),
	).rejects.toThrow(/missing predecessor chain/i);
	expect(fixture.localReplayCount).toBe(0);
});

it("rejects deferred-owner events before returning them without reducer validation", async () => {
	const fixture = createBridgeFixture();
	const deferredEvent = createDeferredOwnerEvent(fixture.event);
	fixture.dependencies.journal.replayLogicalHistory = async () => [fixture.event, deferredEvent];
	fixture.dependencies.readHead = async () => ({
		workflowId: fixture.workflowId,
		sequence: deferredEvent.sequence,
		eventDigest: deferredEvent.eventDigest,
		epochRef: deferredEvent.epochRef,
	});

	await expect(
		fixture.bridge.replay({
			workflowId: fixture.workflowId,
			fromSequence: 1,
			expectedStoreEpoch: epoch.storeEpoch,
		}),
	).rejects.toMatchObject({
		name: "WorkflowReplayValidationError",
		code: "workflow_replay_owner_validation_unavailable",
	});
});

it("replays only the expected store epoch and quarantines a stale one", async () => {
	const fixture = createBridgeFixture();

	const replay = await fixture.bridge.replay({
		workflowId: fixture.workflowId,
		fromSequence: 1,
		expectedStoreEpoch: epoch.storeEpoch,
	});
	const stale = await fixture.bridge.replay({
		workflowId: fixture.workflowId,
		fromSequence: 1,
		expectedStoreEpoch: epoch.storeEpoch + 1,
	});

	expect(replay.quarantined).toBe(false);
	expect(replay.events).toHaveLength(1);
	expect(replay.events[0]?.payload).toEqual(fixture.event.payload);
	expect(replay.events[0]?.eventDigest).toBe(fixture.event.eventDigest);
	expect(stale).toMatchObject({ quarantined: true, events: [], quarantineReason: "stale_epoch" });
});

it("rejects a stale injected head instead of exposing journal replay state", async () => {
	const fixture = createBridgeFixture();
	fixture.dependencies.readHead = async () => ({
		workflowId: fixture.workflowId,
		sequence: fixture.event.sequence - 1,
		eventDigest: null,
		epochRef: fixture.event.epochRef,
	});

	await expect(
		fixture.bridge.replay({
			workflowId: fixture.workflowId,
			fromSequence: 1,
			expectedStoreEpoch: epoch.storeEpoch,
		}),
	).rejects.toThrow(/head.*journal|journal.*head/i);
});

it("rejects a foreign injected head instead of exposing journal replay state", async () => {
	const fixture = createBridgeFixture();
	fixture.dependencies.readHead = async () => ({
		workflowId: "foreign-workflow",
		sequence: fixture.event.sequence,
		eventDigest: fixture.event.eventDigest,
		epochRef: fixture.event.epochRef,
	});

	await expect(
		fixture.bridge.replay({
			workflowId: fixture.workflowId,
			fromSequence: 1,
			expectedStoreEpoch: epoch.storeEpoch,
		}),
	).rejects.toThrow(/head.*journal|journal.*head/i);
});

it("rejects an injected head with a different digest or epoch", async () => {
	const fixture = createBridgeFixture();
	fixture.dependencies.readHead = async () => ({
		workflowId: fixture.workflowId,
		sequence: fixture.event.sequence,
		eventDigest: "stale-event-digest",
		epochRef: { storeEpoch: epoch.storeEpoch, coordinatorEpoch: epoch.coordinatorEpoch + 1 },
	});

	await expect(
		fixture.bridge.replay({
			workflowId: fixture.workflowId,
			fromSequence: 1,
			expectedStoreEpoch: epoch.storeEpoch,
		}),
	).rejects.toThrow(/head.*journal|journal.*head/i);
});

it("delegates all four dependent publications and forwards both epoch replacements", async () => {
	const fixture = createBridgeFixture();
	const hook = {} as DurableStoreCrashBoundaryHook;
	const tuple = fixture.authenticatedTuple;
	const artifactInput: WorkflowArtifactPublishInput = {
		workflowId: fixture.workflowId,
		payloadKind: "evidence",
		bytes: new TextEncoder().encode("artifact"),
		codec: "utf8",
		sourceEventSequence: fixture.event.sequence,
		idempotencyKey: "artifact-1",
	};
	const snapshotInput: WorkflowSnapshotPublishInput = {
		workflowId: fixture.workflowId,
		sequence: fixture.event.sequence,
		sourceEventDigest: fixture.event.eventDigest,
		epochRef: epoch,
		expectedHead: {
			workflowId: fixture.workflowId,
			sequence: 0,
			sourceEventDigest: null,
			stateDigest: null,
			epochRef: epoch,
		},
		leaseRef: fixture.leaseRef,
		writerIdentity: fixture.writerIdentity,
		stateBytes: new TextEncoder().encode("state"),
		stateDigest: "state-digest",
		idempotencyKey: "snapshot-1",
		authenticatedTuple: tuple,
	};
	const projectionInput: WorkflowProjectionCasInput = {
		workflowId: fixture.workflowId,
		projectionKey: "goal",
		expectedHead: fixture.expectedHead,
		projectionDigest: "projection-digest",
		epochRef: epoch,
		idempotencyKey: "projection-1",
		authenticatedTuple: tuple,
	};
	const outboxInput: WorkflowOutboxAppendInput = {
		workflowId: fixture.workflowId,
		sequence: fixture.event.sequence,
		eventDigest: fixture.event.eventDigest,
		epochRef: epoch,
		expectedHead: {
			workflowId: fixture.workflowId,
			sequence: 0,
			eventDigest: null,
			entryDigest: null,
			epochRef: epoch,
		},
		leaseRef: fixture.leaseRef,
		writerIdentity: fixture.writerIdentity,
		idempotencyKey: "outbox-1",
		bytes: new TextEncoder().encode("outbox"),
		entryDigest: "entry-digest",
		authenticatedTuple: tuple,
	};

	await expect(fixture.bridge.publishArtifact(artifactInput, hook)).resolves.toBe(fixture.artifactResult);
	await expect(fixture.bridge.publishSnapshot(snapshotInput, hook)).resolves.toBe(fixture.snapshotResult);
	await expect(fixture.bridge.compareAndSwapProjection(projectionInput, hook)).resolves.toBe("applied");
	await expect(fixture.bridge.appendOutbox(outboxInput, hook)).resolves.toBe(fixture.outboxResult);
	expect(fixture.artifactCall).toEqual({ input: artifactInput, hook });
	expect(fixture.snapshotCall).toEqual({ input: snapshotInput, hook });
	expect(fixture.projectionCall).toEqual({ input: projectionInput, hook });
	expect(fixture.outboxCall).toEqual({ input: outboxInput, hook });

	const coordinatorEpoch: WorkflowEpochRef = { storeEpoch: epoch.storeEpoch, coordinatorEpoch: 2 };
	const storeEpoch: WorkflowEpochRef = { storeEpoch: 2, coordinatorEpoch: coordinatorEpoch.coordinatorEpoch };
	const binding: WorkflowGenerationBinding = {
		writerIdentity: "writer-2",
		processGenerationId: "process-2",
		ownerIdentity: "owner-2",
	};
	await expect(fixture.bridge.replaceCoordinatorEpoch(coordinatorEpoch, binding)).resolves.toBe(fixture.rotation);
	await expect(fixture.bridge.replaceStoreEpoch(storeEpoch, binding)).resolves.toBe(fixture.rotation);
	expect(fixture.coordinatorReplacement).toEqual({ nextEpoch: coordinatorEpoch, generationBinding: binding });
	expect(fixture.storeReplacement).toEqual({ nextEpoch: storeEpoch, generationBinding: binding });
});

it("rejects a store paired with a different journal authority", () => {
	const fixture = createBridgeFixture();
	const foreignJournal = createJournal([fixture.event], [fixture.event]);

	expect(() =>
		WorkflowRuntimeStoreBridge.compose({
			...fixture.dependencies,
			journal: foreignJournal,
		}),
	).toThrow(/same authenticated|identity/i);
});

interface BridgeFixture {
	bridge: WorkflowRuntimeStoreBridge;
	dependencies: WorkflowRuntimeStoreBridgeDependencies;
	workflowId: string;
	writerIdentity: string;
	leaseRef: WorkflowLeaseRef;
	expectedHead: WorkflowJournalHead;
	commitInput: WorkflowStoreCommitInput<Extract<WorkflowEventPayload, { kind: "workflow_started" }>>;
	event: WorkflowJournalEvent;
	successorEvent: WorkflowJournalEvent | null;
	authenticatedTuple: WorkflowAuthenticatedMutationTuple;
	rotation: WorkflowGenerationRotation;
	artifactResult: WorkflowArtifactPublishResult;
	snapshotResult: WorkflowSnapshotPublishResult;
	outboxResult: WorkflowOutboxAppendResult;
	storeCommitCount: number;
	localReplayCount: number;
	logicalReplayCount: number;
	capturedPrecondition: CapturedPrecondition | null;
	artifactCall: { input: WorkflowArtifactPublishInput; hook: DurableStoreCrashBoundaryHook | undefined } | null;
	snapshotCall: { input: WorkflowSnapshotPublishInput; hook: DurableStoreCrashBoundaryHook | undefined } | null;
	projectionCall: { input: WorkflowProjectionCasInput; hook: DurableStoreCrashBoundaryHook | undefined } | null;
	outboxCall: { input: WorkflowOutboxAppendInput; hook: DurableStoreCrashBoundaryHook | undefined } | null;
	coordinatorReplacement: { nextEpoch: WorkflowEpochRef; generationBinding: WorkflowGenerationBinding } | null;
	storeReplacement: { nextEpoch: WorkflowEpochRef; generationBinding: WorkflowGenerationBinding } | null;
}

interface CapturedPrecondition {
	expectedSourceJournalDigest: string | null;
}

function createBridgeFixture(options: { rotated?: boolean } = {}): BridgeFixture {
	const workflowId = "workflow-bridge";
	const writerIdentity = "writer-1";
	const leaseRef = createLeaseRef(workflowId, writerIdentity);
	const expectedHead: WorkflowJournalHead = { workflowId, sequence: 0, eventDigest: null, epochRef: epoch };
	const payload = {
		kind: "workflow_started" as const,
		workflowId,
		rootSessionId: "session-bridge",
		objective: "bridge",
	};
	const semanticBinding: WorkflowSemanticMutationBinding = {
		mutationId: "mutation-1",
		baselineDigest: "state-0",
		expectedGenerations: { workflow: 1 },
		ownerId: "bridge-test",
		phase: "planning",
		reducerDigest: "reducer-digest",
		semanticHead: {
			workflowId,
			sequence: 0,
			eventDigest: null,
			stateDigest: "state-0",
			epochRef: epoch,
			generation: 1,
		},
		expectedHead,
		idempotencyKey: "commit-1",
		executionKey: null,
		writerIdentity,
		leaseRef,
		epochRef: epoch,
	};
	const event = createJournalEvent(payload, expectedHead, semanticBinding, leaseRef, writerIdentity);
	const successorEvent = options.rotated ? createSuccessorEvent(event) : null;
	const localEvents = successorEvent === null ? [event] : [successorEvent];
	const logicalEvents = successorEvent === null ? [event] : [event, successorEvent];
	const headEvent = logicalEvents.at(-1) ?? event;
	const authenticatedTuple = createAuthenticatedTuple(event);
	const rotation = { status: "committed" } as unknown as WorkflowGenerationRotation;
	let state: WorkflowState | null = null;
	let storeCommitCount = 0;
	let localReplayCount = 0;
	let logicalReplayCount = 0;
	let capturedPrecondition: CapturedPrecondition | null = null;
	let artifactCall: BridgeFixture["artifactCall"] = null;
	let snapshotCall: BridgeFixture["snapshotCall"] = null;
	let projectionCall: BridgeFixture["projectionCall"] = null;
	let outboxCall: BridgeFixture["outboxCall"] = null;
	let coordinatorReplacement: BridgeFixture["coordinatorReplacement"] = null;
	let storeReplacement: BridgeFixture["storeReplacement"] = null;

	const identity: WorkflowRuntimeStoreIdentity = {
		storeKind: "workflow",
		namespace: "workflow",
		rootDir: "/tmp/workflow-bridge",
		storeId: "store-workflow-bridge",
		workflowId,
		identityDigest: digestObject({
			storeKind: "workflow",
			namespace: "workflow",
			rootDir: "/tmp/workflow-bridge",
			storeId: "store-workflow-bridge",
			workflowId,
		}),
	};
	const journal = createJournal(
		localEvents,
		logicalEvents,
		replayCountRef(() => (localReplayCount += 1)),
		replayCountRef(() => (logicalReplayCount += 1)),
	);
	const store = {
		journal,
		identity,
		snapshot: () => state,
		commit: async (_payload: WorkflowEventPayload, precondition: CapturedPrecondition): Promise<WorkflowState> => {
			storeCommitCount += 1;
			capturedPrecondition = precondition;
			state = createState(workflowId, headEvent);
			return state;
		},
		replaceCoordinatorEpoch: async (nextEpoch: WorkflowEpochRef, generationBinding: WorkflowGenerationBinding) => {
			coordinatorReplacement = { nextEpoch, generationBinding };
			return rotation;
		},
		replaceStoreEpoch: async (nextEpoch: WorkflowEpochRef, generationBinding: WorkflowGenerationBinding) => {
			storeReplacement = { nextEpoch, generationBinding };
			return rotation;
		},
	} as unknown as WorkflowStore;
	const artifactResult: WorkflowArtifactPublishResult = {
		status: "published",
		envelope: {
			ref: {
				artifactId: "artifact-1",
				relativePath: "artifacts/evidence/artifact-1",
				digest: "artifact-digest",
				sizeBytes: 8,
				sourceEventSequence: event.sequence,
			},
			payloadKind: "evidence",
			codec: "utf8",
			immutable: true,
		},
	};
	const snapshotResult: WorkflowSnapshotPublishResult = {
		status: "published",
		sequence: event.sequence,
		sourceEventDigest: event.eventDigest,
		stateDigest: "state-digest",
	};
	const outboxResult: WorkflowOutboxAppendResult = {
		status: "appended",
		sequence: event.sequence,
		entryDigest: "entry-digest",
	};
	const artifactPublisher: WorkflowArtifactPublisher = {
		publish: async (input, hook) => {
			artifactCall = { input, hook };
			return artifactResult;
		},
	};
	const snapshotPublisher: WorkflowSnapshotPublisher = {
		publish: async (input, hook) => {
			snapshotCall = { input, hook };
			return snapshotResult;
		},
	};
	const projectionAdapter: WorkflowProjectionAdapter<"goal"> = {
		projectionKey: "goal",
		compareAndSwap: async (input, hook) => {
			projectionCall = { input, hook };
			return "applied";
		},
	};
	const outboxAppender: WorkflowOutboxAppender = {
		append: async (input, hook) => {
			outboxCall = { input, hook };
			return outboxResult;
		},
		recover: async () => {
			throw new Error("recovery is not part of the runtime-store surface");
		},
	};
	const dependencies: WorkflowRuntimeStoreBridgeDependencies = {
		store,
		journal,
		artifactPublisher,
		snapshotPublisher,
		outboxAppender,
		projectionAdapter,
		readHead: async () => ({
			workflowId,
			sequence: headEvent.sequence,
			eventDigest: headEvent.eventDigest,
			epochRef: headEvent.epochRef,
		}),
	};
	const commitInput: BridgeFixture["commitInput"] = {
		workflowId,
		payload,
		expectedHead,
		semanticBinding,
		epochRef: epoch,
		leaseRef,
		idempotencyKey: "commit-1",
		writerIdentity,
		executionKey: null,
	};

	return {
		bridge: WorkflowRuntimeStoreBridge.compose(dependencies),
		dependencies,
		workflowId,
		writerIdentity,
		leaseRef,
		expectedHead,
		commitInput,
		event,
		successorEvent,
		authenticatedTuple,
		rotation,
		artifactResult,
		snapshotResult,
		outboxResult,
		get storeCommitCount() {
			return storeCommitCount;
		},
		get localReplayCount() {
			return localReplayCount;
		},
		get logicalReplayCount() {
			return logicalReplayCount;
		},
		get capturedPrecondition() {
			return capturedPrecondition;
		},
		get artifactCall() {
			return artifactCall;
		},
		get snapshotCall() {
			return snapshotCall;
		},
		get projectionCall() {
			return projectionCall;
		},
		get outboxCall() {
			return outboxCall;
		},
		get coordinatorReplacement() {
			return coordinatorReplacement;
		},
		get storeReplacement() {
			return storeReplacement;
		},
	};
}

function replayCountRef(increment: () => void): { increment(): void } {
	return { increment };
}

function createJournal(
	localEvents: readonly WorkflowJournalEvent[],
	logicalEvents: readonly WorkflowJournalEvent[],
	localReplay: { increment(): void } = { increment: () => undefined },
	logicalReplay: { increment(): void } = { increment: () => undefined },
): TestWorkflowJournal {
	return {
		replay: async () => {
			localReplay.increment();
			return localEvents;
		},
		replayLogicalHistory: async () => {
			logicalReplay.increment();
			return logicalEvents;
		},
	} as unknown as TestWorkflowJournal;
}

function createCoordinatorFenceEvent(
	predecessor: WorkflowJournalEvent,
	nextEpoch: WorkflowEpochRef,
): WorkflowJournalEvent {
	return createFenceEvent(predecessor, nextEpoch, "coordinator");
}

function createStoreFenceEvent(predecessor: WorkflowJournalEvent, nextEpoch: WorkflowEpochRef): WorkflowJournalEvent {
	return createFenceEvent(predecessor, nextEpoch, "store");
}

function createFenceEvent(
	predecessor: WorkflowJournalEvent,
	nextEpoch: WorkflowEpochRef,
	mode: "coordinator" | "store",
): WorkflowJournalEvent {
	const generationBinding: WorkflowGenerationBinding = {
		writerIdentity: "writer-2",
		processGenerationId: "process-2",
		ownerIdentity: "owner-2",
	};
	const nextLeaseRef: WorkflowLeaseRef = {
		...predecessor.leaseRef,
		...nextEpoch,
		leaseId: "lease-workflow-bridge-successor",
		processIdentity: "process-2",
		writerIdentity: generationBinding.writerIdentity,
	};
	const payload: Extract<WorkflowEventPayload, { kind: "store_generation_fenced" | "coordinator_epoch_fenced" }> =
		mode === "store"
			? {
					kind: "store_generation_fenced",
					workflowId: predecessor.workflowId,
					storeEpoch: nextEpoch.storeEpoch,
					priorEpoch: predecessor.epochRef,
					nextEpoch,
					priorLeaseRef: predecessor.leaseRef,
					nextLeaseRef,
					generationId: generationBinding.processGenerationId,
					generationBinding,
				}
			: {
					kind: "coordinator_epoch_fenced",
					workflowId: predecessor.workflowId,
					coordinatorEpoch: nextEpoch.coordinatorEpoch,
					priorEpoch: predecessor.epochRef,
					nextEpoch,
					priorLeaseRef: predecessor.leaseRef,
					nextLeaseRef,
					generationId: generationBinding.processGenerationId,
					generationBinding,
				};
	const expectedHead: WorkflowJournalHead = {
		workflowId: predecessor.workflowId,
		sequence: predecessor.sequence,
		eventDigest: predecessor.eventDigest,
		epochRef: predecessor.epochRef,
	};
	const sequence = predecessor.sequence + 1;
	const eventDigest = "fence-event-digest";
	const idempotencyKey = "fence-1";
	const returnProofId = `return-proof:${idempotencyKey}`;
	const semanticBinding: WorkflowSemanticMutationBinding = {
		...predecessor.semanticBinding,
		mutationId: "fence-mutation",
		expectedHead,
		idempotencyKey,
		executionKey: null,
		writerIdentity: predecessor.writerIdentity,
		leaseRef: predecessor.leaseRef,
		epochRef: predecessor.epochRef,
	};
	const proofWithoutDigest: Omit<WorkflowCommitReturnProof, "proofDigest"> = {
		...predecessor.commitReturnProof,
		recordVersion: 1,
		generationId: generationBinding.processGenerationId,
		mutationId: returnProofId,
		workflowId: predecessor.workflowId,
		sequence,
		eventDigest,
		committedFrameDigest: predecessor.committedFrameDigest,
		expectedHead,
		epochRef: predecessor.epochRef,
		leaseRef: predecessor.leaseRef,
		writerIdentity: predecessor.writerIdentity,
		idempotencyKey,
		priorRecordDigest: predecessor.eventDigest,
	};
	const commitReturnProof: WorkflowCommitReturnProof = {
		...proofWithoutDigest,
		proofDigest: digestObject({ ...proofWithoutDigest, proofDigest: "" }),
	};
	return {
		...predecessor,
		sequence,
		kind: payload.kind,
		eventType: payload.kind,
		payload,
		payloadBytes: canonicalJsonBytes(payload),
		payloadDigest: digestObject(payload),
		priorEventDigest: predecessor.eventDigest,
		eventDigest,
		generationId: generationBinding.processGenerationId,
		idempotencyKey,
		returnProofId,
		expectedHead,
		executionKey: null,
		semanticBinding,
		commitReturnProof,
	};
}

function createSuccessorEvent(
	predecessor: WorkflowJournalEvent,
	epochRef: WorkflowEpochRef = {
		storeEpoch: predecessor.epochRef.storeEpoch,
		coordinatorEpoch: predecessor.epochRef.coordinatorEpoch + 1,
	},
): WorkflowJournalEvent {
	const predecessorHeadEpoch =
		predecessor.payload.kind === "store_generation_fenced" || predecessor.payload.kind === "coordinator_epoch_fenced"
			? predecessor.payload.nextEpoch
			: predecessor.epochRef;
	const expectedHead: WorkflowJournalHead = {
		workflowId: predecessor.workflowId,
		sequence: predecessor.sequence,
		eventDigest: predecessor.eventDigest,
		epochRef: predecessorHeadEpoch,
	};
	const leaseRef: WorkflowLeaseRef = {
		...predecessor.leaseRef,
		...epochRef,
		leaseId: "lease-workflow-bridge-successor",
		writerIdentity: "writer-2",
	};
	const idempotencyKey = "commit-2";
	const returnProofId = `return-proof:${idempotencyKey}`;
	const eventDigest = "successor-event-digest";
	const semanticBinding: WorkflowSemanticMutationBinding = {
		...predecessor.semanticBinding,
		mutationId: "mutation-2",
		expectedHead,
		semanticHead: {
			...predecessor.semanticBinding.semanticHead,
			sequence: predecessor.sequence,
			eventDigest: predecessor.eventDigest,
			epochRef,
		},
		idempotencyKey,
		writerIdentity: leaseRef.writerIdentity,
		leaseRef,
		epochRef,
	};
	const proofWithoutDigest = {
		...predecessor.commitReturnProof,
		generationId: "generation-2",
		mutationId: returnProofId,
		sequence: predecessor.sequence + 1,
		eventDigest,
		expectedHead,
		epochRef,
		leaseRef,
		writerIdentity: leaseRef.writerIdentity,
		idempotencyKey,
		priorRecordDigest: predecessor.eventDigest,
	};
	const commitReturnProof: WorkflowCommitReturnProof = {
		...proofWithoutDigest,
		proofDigest: digestObject({ ...proofWithoutDigest, proofDigest: "" }),
	};
	return {
		...predecessor,
		sequence: predecessor.sequence + 1,
		priorEventDigest: predecessor.eventDigest,
		eventDigest,
		generationId: "generation-2",
		recordMac: "successor-record-mac",
		recordChecksum: "successor-record-checksum",
		idempotencyKey,
		returnProofId,
		expectedHead,
		executionKey: "execution-successor",
		epochRef,
		leaseRef,
		writerIdentity: leaseRef.writerIdentity,
		preparedFrameDigest: "successor-prepared-frame-digest",
		committedFrameDigest: "successor-committed-frame-digest",
		keyId: "successor-key-1",
		preparedFrameMac: "successor-prepared-frame-mac",
		committedFrameMac: "successor-committed-frame-mac",
		preparedFrameChecksum: "successor-prepared-frame-checksum",
		committedFrameChecksum: "successor-committed-frame-checksum",
		semanticBinding,
		commitReturnProof,
	};
}

function createDeferredOwnerEvent(predecessor: WorkflowJournalEvent): WorkflowJournalEvent {
	const payload: WorkflowEventPayload = {
		kind: "workflow_dispatch_readiness_observed",
		workflowId: predecessor.workflowId,
		epochRef: predecessor.epochRef,
		readinessDigest: "readiness-digest",
		canDispatch: false,
		blockingReasons: [],
	};
	const successor = createSuccessorEvent(predecessor, predecessor.epochRef);
	return {
		...successor,
		kind: payload.kind,
		eventType: payload.kind,
		payload,
		payloadBytes: canonicalJsonBytes(payload),
		payloadDigest: digestObject(payload),
		eventDigest: "deferred-event-digest",
	};
}

function createState(workflowId: string, event: WorkflowJournalEvent): WorkflowState {
	return {
		workflowId,
		sourceJournalSequence: event.sequence,
		sourceJournalDigest: event.eventDigest,
	} as unknown as WorkflowState;
}

function createLeaseRef(workflowId: string, writerIdentity: string): WorkflowLeaseRef {
	return {
		...epoch,
		leaseId: `lease-${workflowId}`,
		acquisitionEventSequence: 1,
		processIdentity: "process-1",
		rootDigest: "root-digest",
		writerIdentity,
		acquiredAt: "2026-08-15T00:00:00.000Z",
		expiresAt: "2026-08-16T00:00:00.000Z",
	};
}

function createJournalEvent(
	payload: Extract<WorkflowEventPayload, { kind: "workflow_started" }>,
	expectedHead: WorkflowJournalHead,
	semanticBinding: WorkflowSemanticMutationBinding,
	leaseRef: WorkflowLeaseRef,
	writerIdentity: string,
): WorkflowJournalEvent {
	const eventDigest = "event-digest";
	const returnProofId = "return-proof:commit-1";
	const proofWithoutDigest: Omit<WorkflowCommitReturnProof, "proofDigest"> = {
		recordVersion: 1,
		generationId: "generation-1",
		mutationId: returnProofId,
		workflowId: payload.workflowId,
		sequence: 1,
		eventDigest,
		committedFrameDigest: "committed-frame-digest",
		expectedHead,
		epochRef: epoch,
		leaseRef,
		writerIdentity,
		idempotencyKey: "commit-1",
		keyId: "key-1",
		frameMac: "committed-frame-mac",
		frameChecksum: "committed-frame-checksum",
		recordMac: "record-mac",
		recordChecksum: "record-checksum",
		priorRecordDigest: null,
		returnedAt: "2026-08-15T00:00:00.000Z",
	};
	const commitReturnProof: WorkflowCommitReturnProof = {
		...proofWithoutDigest,
		proofDigest: digestObject({ ...proofWithoutDigest, proofDigest: "" }),
	};
	return {
		workflowId: payload.workflowId,
		sequence: 1,
		kind: payload.kind,
		eventType: payload.kind,
		payload,
		payloadBytes: canonicalJsonBytes(payload),
		payloadDigest: digestObject(payload),
		priorEventDigest: null,
		eventDigest,
		recordVersion: 1,
		generationId: "generation-1",
		recordMac: "record-mac",
		recordChecksum: "record-checksum",
		idempotencyKey: "commit-1",
		returnProofId,
		expectedHead,
		executionKey: null,
		epochRef: epoch,
		leaseRef,
		writerIdentity,
		preparedFrameDigest: "prepared-frame-digest",
		committedFrameDigest: "committed-frame-digest",
		keyId: "key-1",
		preparedFrameMac: "prepared-frame-mac",
		committedFrameMac: "committed-frame-mac",
		preparedFrameChecksum: "prepared-frame-checksum",
		committedFrameChecksum: "committed-frame-checksum",
		semanticBinding,
		commitReturnProof,
	};
}

function createAuthenticatedTuple(event: WorkflowJournalEvent): WorkflowAuthenticatedMutationTuple {
	return {
		recordVersion: event.recordVersion,
		generationId: event.generationId,
		workflowId: event.workflowId,
		mutationId: event.returnProofId,
		expectedHead: event.expectedHead,
		sequence: event.sequence,
		eventDigest: event.eventDigest,
		epochRef: event.epochRef,
		leaseRef: event.leaseRef,
		writerIdentity: event.writerIdentity,
		idempotencyKey: event.idempotencyKey,
		keyId: event.keyId,
		frameMac: event.committedFrameMac,
		frameChecksum: event.committedFrameChecksum,
		recordMac: event.recordMac,
		recordChecksum: event.recordChecksum,
		priorRecordDigest: event.priorEventDigest,
	};
}
