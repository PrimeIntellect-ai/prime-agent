import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { ChildAttemptState } from "../../src/core/child-output-contract.js";
import {
	canonicalJsonBytes,
	digestObject,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowJournalHead,
	type WorkflowLeaseRef,
	type WorkflowRuntimeStore,
	type WorkflowRuntimeStoreDurableContext,
} from "../../src/core/workflow/contracts.js";
import {
	COORDINATOR_OBLIGATION_HOST_CAPABILITY,
	type CoordinatorObligationAuthorizationContext,
	type CoordinatorObligationHostAdapter,
	type CoordinatorObligationRecordAuthority,
	type CoordinatorObligationScheduler,
	createCoordinatorObligationScheduler,
} from "../../src/core/workflow/coordinator-obligation-scheduler.js";
import {
	createLocalAppendLease,
	createLocalAppendLeaseProcessIdentity,
	type LocalAppendLeaseClock,
} from "../../src/core/workflow/local-append-lease.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const WORKFLOW_ID = "workflow-coordinator-obligation-test";
const HEAD: WorkflowJournalHead = {
	workflowId: WORKFLOW_ID,
	sequence: 7,
	eventDigest: "head-7",
	epochRef: EPOCH,
};

interface Fixture {
	readonly root: string;
	readonly host: CoordinatorObligationHostAdapter;
	readonly scheduler: CoordinatorObligationScheduler;
	readonly restartScheduler: () => CoordinatorObligationScheduler;
	readonly observePersistedLease: () => Promise<{
		readonly writerIdentity: string;
		readonly leaseRef: WorkflowLeaseRef;
	} | null>;
	readonly setNow: (monotonicMilliseconds: number) => void;
	readonly setChildState: (outputObligationId: string, stateDigest: string) => void;
	readonly deleteChildState: (outputObligationId: string) => void;
	readonly authorizationContexts: readonly CoordinatorObligationAuthorizationContext[];
	readonly setRetentionWatermark: (revision: number) => void;
	readonly providerAdmissionCount: () => number;
	readonly dispose: () => Promise<void>;
}

interface LocalClock extends LocalAppendLeaseClock {
	advance(milliseconds: number): void;
}

function createClock(initial: string): LocalClock {
	let current = Date.parse(initial);
	return {
		now: () => new Date(current).toISOString(),
		addMilliseconds: (base, milliseconds) => new Date(Date.parse(base) + milliseconds).toISOString(),
		advance: (milliseconds) => {
			current += milliseconds;
		},
	};
}

function childState(outputObligationId: string, stateDigest: string): ChildAttemptState {
	return {
		declaration: {} as never,
		status: "running",
		taskId: outputObligationId.replace("obligation-", "task-"),
		childId: outputObligationId.replace("obligation-", "child-"),
		runId: `run-${outputObligationId}`,
		workflowId: WORKFLOW_ID,
		attemptId: outputObligationId.replace("obligation-", "attempt-"),
		priorAttemptId: null,
		attemptNumber: 1,
		maxAttempts: 1,
		head: HEAD,
		epochRef: EPOCH,
		bindingDigest: `binding-${outputObligationId}`,
		stateDigest,
		outputObligation: {
			obligationId: outputObligationId,
			declarationDigest: `declaration-${outputObligationId}`,
			taskId: outputObligationId.replace("obligation-", "task-"),
			childId: outputObligationId.replace("obligation-", "child-"),
			runId: `run-${outputObligationId}`,
			attemptId: outputObligationId.replace("obligation-", "attempt-"),
			requiredFinalResult: { schema: "fixture", validator: "fixture" },
			requiredArtifactOutputIds: [],
			status: "undischarged",
			terminalEventId: null,
			terminalReason: null,
		},
		provisionalProgressDigest: null,
		provisionalProducerExecutionId: null,
		artifactSeal: null,
		producerFence: null,
		terminalPacketDigest: null,
		terminalToolResults: [],
		quarantineReason: null,
		coordinator: {
			meaningfulProgressDigest: null,
			deadline: { status: "pending", transitionEventId: null, transitionReason: null },
			terminal: null,
			wake: null,
		},
		continuationWake: null,
		compactionCount: 0,
		compactionNoProgressCount: 0,
		lastCompactionEvidenceDigest: null,
		lastCompactionHeadDigest: null,
		diagnostic: null,
		continuationEscalation: null,
		finalAssistantResult: null,
		reportedArtifacts: [],
		validatedOutputs: [],
		deliveryId: null,
		acknowledgementReceipt: null,
		acknowledgementReceiptId: null,
		acknowledgementReceiptDigest: null,
		acknowledgementConsumptionWitness: null,
		acknowledgementAuthorizationDigest: null,
		reason: null,
		durableCommitIntent: null,
		appliedEventDigests: {},
		lastEventId: null,
		retryEventId: null,
		attemptLineage: [],
	} as ChildAttemptState;
}

function parkInput(index = 1, independentReadyWork = true) {
	return {
		parentId: "parent-1",
		childId: `child-${index}`,
		taskId: `task-${index}`,
		attemptId: `attempt-${index}`,
		outputObligationId: `obligation-${index}`,
		baseHead: HEAD,
		baseEpoch: EPOCH,
		stateDigest: `child-state-${index}`,
		deadlineMilliseconds: 1_000,
		independentReadyWork,
	};
}

function createRecordAuthority(
	auxiliaryPath: string,
	currentLeaseRef: () => WorkflowLeaseRef,
): CoordinatorObligationRecordAuthority {
	const secret = "coordinator-obligation-record-secret";
	const preimage = (input: {
		readonly recordName: string;
		readonly workflowId: string;
		readonly epochRef: WorkflowEpochRef;
		readonly revision: number;
		readonly payload: Readonly<Uint8Array>;
	}): Uint8Array =>
		canonicalJsonBytes({
			recordName: input.recordName,
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			revision: input.revision,
			payload: [...input.payload],
		});
	const macFor = (input: Parameters<typeof preimage>[0]): string =>
		createHmac("sha256", secret).update(preimage(input)).digest("hex");
	return {
		seal: async (input) => ({
			mac: macFor(input),
			receiptDigest: digestObject({
				recordName: input.recordName,
				revision: input.revision,
				payload: [...input.payload],
			}),
		}),
		verify: async (input) => {
			if (
				input.mac !== macFor(input) ||
				input.receiptDigest !==
					digestObject({ recordName: input.recordName, revision: input.revision, payload: [...input.payload] })
			)
				throw new Error("coordinator_obligation_record_authentication_failed");
		},
		compareAndSwap: async (input) => {
			if (!sameLease(input.leaseRef, currentLeaseRef())) throw new Error("coordinator_obligation_lease_fenced");
			let current: { revision?: unknown } | null = null;
			try {
				current = JSON.parse(await readFile(auxiliaryPath, "utf8")) as { revision?: unknown };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const currentRevision = current === null ? null : Number(current.revision);
			if (currentRevision !== input.expectedRevision) throw new Error("coordinator_obligation_record_cas_conflict");
			await writeFile(auxiliaryPath, Buffer.from(input.recordBytes), { mode: 0o600 });
		},
	};
}

function sameLease(left: WorkflowLeaseRef, right: WorkflowLeaseRef): boolean {
	return (
		left.leaseId === right.leaseId &&
		left.processIdentity === right.processIdentity &&
		left.writerIdentity === right.writerIdentity
	);
}

async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "coordinator-obligation-scheduler-"));
	const clock = createClock("2030-01-01T00:00:00.000Z");
	let monotonicMilliseconds = 0;
	let retentionWatermark = 0;
	let leaseRef: WorkflowLeaseRef;
	const processIdentity = createLocalAppendLeaseProcessIdentity();
	const appendLease = createLocalAppendLease({
		sessionArtifactRoot: root,
		rootDigest: "coordinator-obligation-root",
		storeEpoch: EPOCH.storeEpoch,
		secret: "coordinator-obligation-lease-secret",
		ttlMilliseconds: 60_000,
		clock,
		writerIdentity: "coordinator-writer",
		processIdentity,
	});
	leaseRef = await appendLease.acquire(WORKFLOW_ID, "coordinator-writer", EPOCH.coordinatorEpoch, processIdentity);
	const auxiliaryPath = join(root, "workflows", WORKFLOW_ID, "coordinator-obligation-scheduler-v2.json");
	await mkdir(join(root, "workflows", WORKFLOW_ID), { recursive: true });
	const auxiliaryStore = {
		read: async (name: string): Promise<Uint8Array | null> => {
			if (name !== "coordinator-obligation-scheduler-v2.json") throw new Error("unexpected auxiliary record");
			try {
				return new Uint8Array(await readFile(auxiliaryPath));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
		},
		write: async (): Promise<void> => {
			throw new Error("scheduler must use host record CAS");
		},
	};
	const durable: WorkflowRuntimeStoreDurableContext = {
		generationId: "fixture-generation",
		epochRef: EPOCH,
		currentLeaseRef: () => leaseRef,
		outbox: {} as never,
		auxiliaryStore,
		withExclusiveLease: async <T>(boundary: string, operation: () => Promise<T>): Promise<T> =>
			appendLease.withExclusiveGuard(
				{
					workflowId: WORKFLOW_ID,
					writerIdentity: "coordinator-writer",
					leaseRef,
					epochRef: EPOCH,
					rootDigest: "coordinator-obligation-root",
					boundary,
				},
				operation,
			),
		recoverJournal: async () => ({ status: "healthy", metadata: {} }) as never,
	};
	const store = {
		identity: {
			storeKind: "workflow" as const,
			namespace: "fixture",
			rootDir: root,
			storeId: "coordinator-obligation-store",
			workflowId: WORKFLOW_ID,
			identityDigest: "coordinator-obligation-store-digest",
		},
		durableContext: durable,
	} as unknown as WorkflowRuntimeStore;
	const childStates = new Map<string, ChildAttemptState>();
	const missingChildStates = new Set<string>();
	const providerAdmissions = { value: 0 };
	const authorizationContexts: CoordinatorObligationAuthorizationContext[] = [];
	const authorize = async (
		context: CoordinatorObligationAuthorizationContext,
	): Promise<WorkflowHostPrincipalCapabilityAuthorization> => {
		authorizationContexts.push(structuredClone(context));
		const bindingDigest = digestObject({ workflowId: WORKFLOW_ID, park: context.park, operation: context.operation });
		return {
			authenticatedPrincipal: "fixture-host",
			keyOwnerPrincipal: "fixture-host",
			capability: COORDINATOR_OBLIGATION_HOST_CAPABILITY,
			workflowId: WORKFLOW_ID,
			bindingDigest,
			receipt: {
				receiptId: `scheduler-receipt-${context.operation}-${context.recordRevision}-${context.stateDigest}`,
				capabilityBinding: { capability: COORDINATOR_OBLIGATION_HOST_CAPABILITY },
			} as never,
			stateDigest: context.stateDigest,
			revision: context.currentHead.sequence,
			epochRef: EPOCH,
			validity: { issuedAt: clock.now(), validUntil: clock.addMilliseconds(clock.now(), 60_000) },
			authorizationDigest: digestObject(context),
		};
	};
	const initialChild = childState("obligation-1", "child-state-1");
	childStates.set(initialChild.outputObligation.obligationId, initialChild);
	const initialContext: CoordinatorObligationAuthorizationContext = {
		capability: COORDINATOR_OBLIGATION_HOST_CAPABILITY,
		operation: "park",
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		leaseRef,
		currentHead: HEAD,
		recordRevision: 0,
		stateDigest: initialChild.stateDigest,
		park: null,
		childStateDigest: initialChild.stateDigest,
		baseHead: null,
		independentReadyWork: null,
		childOutputDigest: null,
	};
	const capability = await authorize(initialContext);
	const host: CoordinatorObligationHostAdapter = {
		runtimeStore: store,
		runtimeVersion: "0.147.0-alpha.10",
		maxWaitMilliseconds: 10_000,
		capability,
		readTrustedTime: () => ({ monotonicMilliseconds, wallTime: clock.now() }),
		readCurrentLeaseRef: () => leaseRef,
		readCurrentHead: () => HEAD,
		readChildAttemptState: ({ outputObligationId }) => {
			if (missingChildStates.has(outputObligationId)) return null;
			const existing = childStates.get(outputObligationId);
			if (existing !== undefined) return existing;
			const created = childState(outputObligationId, `child-state-${outputObligationId.replace("obligation-", "")}`);
			childStates.set(outputObligationId, created);
			return created;
		},
		authorize,
		readRetentionWatermark: () => retentionWatermark,
		recordAuthority: createRecordAuthority(auxiliaryPath, () => leaseRef),
	};
	const setChildState = (outputObligationId: string, stateDigest: string): void => {
		missingChildStates.delete(outputObligationId);
		const previous = childStates.get(outputObligationId);
		if (previous === undefined) {
			const index = outputObligationId.replace("obligation-", "");
			childStates.set(outputObligationId, childState(outputObligationId, stateDigest));
			void index;
			return;
		}
		childStates.set(outputObligationId, { ...previous, stateDigest });
	};
	const createScheduler = (): CoordinatorObligationScheduler => createCoordinatorObligationScheduler({ host });
	return {
		root,
		host,
		scheduler: createScheduler(),
		restartScheduler: createScheduler,
		observePersistedLease: async () => {
			const restartedLease = createLocalAppendLease({
				sessionArtifactRoot: root,
				rootDigest: "coordinator-obligation-root",
				storeEpoch: EPOCH.storeEpoch,
				secret: "coordinator-obligation-lease-secret",
				ttlMilliseconds: 60_000,
				clock,
				writerIdentity: "coordinator-writer",
				processIdentity,
			});
			return restartedLease.observe(WORKFLOW_ID);
		},
		setNow: (nextMonotonicMilliseconds) => {
			clock.advance(nextMonotonicMilliseconds - monotonicMilliseconds);
			monotonicMilliseconds = nextMonotonicMilliseconds;
		},
		setChildState,
		deleteChildState: (outputObligationId) => {
			missingChildStates.add(outputObligationId);
			childStates.delete(outputObligationId);
		},
		authorizationContexts,
		setRetentionWatermark: (revision) => {
			retentionWatermark = revision;
		},
		providerAdmissionCount: () => providerAdmissions.value,
		dispose: () => rm(root, { recursive: true, force: true }),
	};
}

it("persists park, one snapshot, and one reply across scheduler restart without provider admission", async () => {
	const fixture = await createFixture();
	try {
		const scheduler = fixture.scheduler;
		await scheduler.parkChildObligation(parkInput());
		const snapshot = {
			outputObligationId: "obligation-1",
			digest: "snapshot-digest",
			ref: "snapshot-ref",
			sizeBytes: 12,
		};
		expect(await scheduler.recordLocalSnapshot(snapshot)).toBe("recorded");
		expect(await scheduler.recordLocalSnapshot(snapshot)).toBe("already_recorded");
		expect(await scheduler.modelTurnAdmission()).toMatchObject({
			status: "parked",
			independentDispatchAllowed: true,
		});

		expect(await fixture.observePersistedLease()).toMatchObject({ writerIdentity: "coordinator-writer" });
		const restarted = fixture.restartScheduler();
		fixture.setChildState("obligation-1", "child-state-terminal");
		await restarted.recordChildOutput({
			outputObligationId: "obligation-1",
			stateDigest: "child-state-terminal",
			eventId: "child-finished-1",
			head: HEAD,
			wakeKey: "stable-wake-1",
			wakeKind: "final_output",
			terminalStatus: "discharged",
		});
		const packet = await restarted.claimWake();
		expect(packet?.wakeKeys).toEqual(["stable-wake-1"]);
		expect(fixture.providerAdmissionCount()).toBe(0);

		const restartedAgain = fixture.restartScheduler();
		expect(await restartedAgain.claimWake()).toEqual(packet);
		await restartedAgain.acknowledgeWake({ episodeId: packet?.episodeId ?? "", claimId: packet?.claimId ?? "" });
		fixture.setChildState("obligation-1", "child-state-terminal-replay");
		await restartedAgain.recordChildOutput({
			outputObligationId: "obligation-1",
			stateDigest: "child-state-terminal-replay",
			eventId: "child-finished-duplicate",
			head: HEAD,
			wakeKey: "stable-wake-1",
			wakeKind: "final_output",
		});
		expect(await restartedAgain.claimWake()).toBeNull();
	} finally {
		await fixture.dispose();
	}
});

it("turns a host deadline into a durable terminal diagnostic wake and does not keep it active forever", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation({ ...parkInput(1, false), deadlineMilliseconds: 1_000 });
		fixture.setNow(1_000);
		await fixture.scheduler.onHostTimer();
		const state = await fixture.scheduler.readState();
		expect(state.parks[0]?.deadline.status).toBe("terminal_failed");
		expect(state.wakeEpisodes).toHaveLength(1);
		expect(state.diagnosticCount).toBe(1);
		expect((await fixture.scheduler.status()).pendingObligationCount).toBe(1);
		await fixture.scheduler.onHostTimer();
		expect((await fixture.scheduler.readState()).diagnosticCount).toBe(1);
	} finally {
		await fixture.dispose();
	}
});

it("coalesces 32 wakes, paginates the rest, and never appends to a claimed episode", async () => {
	const fixture = await createFixture();
	try {
		for (let index = 1; index <= 32; index += 1) {
			const input = parkInput(index);
			await fixture.scheduler.parkChildObligation(input);
			fixture.setChildState(input.outputObligationId, `done-${index}`);
			await fixture.scheduler.recordChildOutput({
				outputObligationId: input.outputObligationId,
				stateDigest: `done-${index}`,
				eventId: `done-event-${index}`,
				head: HEAD,
				wakeKey: "same-stable-key",
				wakeKind: "final_output",
			});
		}
		const first = await fixture.scheduler.claimWake();
		expect(first?.wakeKeys).toHaveLength(32);
		for (let index = 33; index <= 35; index += 1) {
			const input = parkInput(index);
			await fixture.scheduler.parkChildObligation(input);
			fixture.setChildState(input.outputObligationId, `done-${index}`);
			await fixture.scheduler.recordChildOutput({
				outputObligationId: input.outputObligationId,
				stateDigest: `done-${index}`,
				eventId: `done-event-${index}`,
				head: HEAD,
				wakeKey: "same-stable-key",
				wakeKind: "final_output",
			});
		}
		const state = await fixture.scheduler.readState();
		expect(state.wakeEpisodes).toHaveLength(2);
		expect(state.wakeEpisodes[0]?.status).toBe("claimed");
		expect(state.wakeEpisodes[1]?.wakeRefs).toHaveLength(3);
	} finally {
		await fixture.dispose();
	}
});

it("creates a new urgent episode after acknowledgement and requires safe-boundary handling", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation(parkInput());
		fixture.setChildState("obligation-1", "normal-done");
		await fixture.scheduler.recordChildOutput({
			outputObligationId: "obligation-1",
			stateDigest: "normal-done",
			eventId: "normal-event",
			head: HEAD,
			wakeKey: "stable-wake-1",
			wakeKind: "final_output",
			terminalStatus: "discharged",
		});
		const normal = await fixture.scheduler.claimWake();
		await fixture.scheduler.acknowledgeWake({ episodeId: normal?.episodeId ?? "", claimId: normal?.claimId ?? "" });
		fixture.setChildState("obligation-1", "gated-done");
		await fixture.scheduler.recordChildOutput({
			outputObligationId: "obligation-1",
			stateDigest: "gated-done",
			eventId: "gating-event",
			head: HEAD,
			wakeKey: "stable-wake-1",
			wakeKind: "gating",
		});
		const urgent = await fixture.scheduler.claimWake();
		expect(urgent?.episodeId).not.toBe(normal?.episodeId);
		expect(urgent?.priority).toBe("urgent");
		expect((await fixture.scheduler.modelTurnAdmission()).status).toBe("parked");
		await fixture.scheduler.acknowledgeWake({ episodeId: urgent?.episodeId ?? "", claimId: urgent?.claimId ?? "" });
		expect((await fixture.scheduler.modelTurnAdmission()).status).toBe("parked");
		await fixture.scheduler.handleUrgentSafeBoundary({ episodeId: urgent?.episodeId ?? "" });
		expect((await fixture.scheduler.modelTurnAdmission()).status).toBe("admitted");
	} finally {
		await fixture.dispose();
	}
});

it("durably stalls after bounded wake failures and retains the obligation", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation(parkInput());
		fixture.setChildState("obligation-1", "failed-wake");
		await fixture.scheduler.recordChildOutput({
			outputObligationId: "obligation-1",
			stateDigest: "failed-wake",
			eventId: "wake-event",
			head: HEAD,
			wakeKey: "stable-wake-1",
			wakeKind: "error",
		});
		for (let failure = 0; failure < 3; failure += 1) {
			const packet = await fixture.scheduler.claimWake();
			await fixture.scheduler.recordWakeFailure({
				episodeId: packet?.episodeId ?? "",
				claimId: packet?.claimId ?? "",
				reason: "provider unavailable",
			});
		}
		const state = await fixture.scheduler.readState();
		expect(state.wakeEpisodes[0]?.status).toBe("stalled");
		expect(state.parks).toHaveLength(1);
		expect(state.diagnosticCount).toBe(3);
	} finally {
		await fixture.dispose();
	}
});

it("garbage-collects acknowledged terminal parks only after the durable retention watermark", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation(parkInput());
		fixture.setChildState("obligation-1", "terminal-for-gc");
		await fixture.scheduler.recordChildOutput({
			outputObligationId: "obligation-1",
			stateDigest: "terminal-for-gc",
			eventId: "gc-event",
			head: HEAD,
			wakeKey: "gc-wake",
			wakeKind: "final_output",
			terminalStatus: "discharged",
		});
		const packet = await fixture.scheduler.claimWake();
		await fixture.scheduler.acknowledgeWake({ episodeId: packet?.episodeId ?? "", claimId: packet?.claimId ?? "" });
		expect((await fixture.scheduler.readState()).parks).toHaveLength(1);
		fixture.setRetentionWatermark(10_000);
		await fixture.scheduler.onHostTimer();
		expect((await fixture.scheduler.readState()).parks).toHaveLength(0);
	} finally {
		await fixture.dispose();
	}
});

it("rejects a tampered auxiliary record before reopening the durable scheduler", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation(parkInput());
		const recordPath = join(fixture.root, "workflows", WORKFLOW_ID, "coordinator-obligation-scheduler-v2.json");
		const record = JSON.parse(await readFile(recordPath, "utf8")) as { mac: string };
		record.mac = "tampered-mac";
		await writeFile(recordPath, JSON.stringify(record));
		await expect(fixture.restartScheduler().readState()).rejects.toThrow(/record_authentication_failed/);
	} finally {
		await fixture.dispose();
	}
});

it("requires authorized child-output lineage and never overwrites an immutable terminal payload", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation(parkInput());
		fixture.setChildState("obligation-1", "child-output-a");
		await expect(
			fixture.scheduler.recordChildOutput({
				outputObligationId: "obligation-1",
				stateDigest: "child-output-a",
				eventId: "child-output-forged-head",
				wakeKey: "child-output-wake",
				wakeKind: "final_output",
				head: { ...HEAD, eventDigest: "forged-head" },
				independentReadyWork: true,
			} as never),
		).rejects.toThrow(/head/);

		await fixture.scheduler.recordChildOutput({
			outputObligationId: "obligation-1",
			stateDigest: "child-output-a",
			eventId: "child-output-a-event",
			wakeKey: "child-output-wake",
			wakeKind: "final_output",
			terminalStatus: "discharged",
			head: HEAD,
			independentReadyWork: true,
		} as never);
		const childOutputAuthorization = [...fixture.authorizationContexts]
			.reverse()
			.find((context) => context.operation === "child_output");
		expect((childOutputAuthorization as unknown as { independentReadyWork: boolean }).independentReadyWork).toBe(
			true,
		);
		expect(
			(await fixture.scheduler.readState()).parks[0] as unknown as { childOutput: { eventId: string } },
		).toMatchObject({ childOutput: { eventId: "child-output-a-event" } });

		fixture.setChildState("obligation-1", "child-output-b");
		await expect(
			fixture.scheduler.recordChildOutput({
				outputObligationId: "obligation-1",
				stateDigest: "child-output-b",
				eventId: "child-output-b-event",
				wakeKey: "child-output-wake",
				wakeKind: "final_output",
				terminalStatus: "cancelled",
				terminalReason: "replacement-must-not-win",
				head: HEAD,
				independentReadyWork: true,
			} as never),
		).rejects.toThrow(/terminal/);
		const state = await fixture.scheduler.readState();
		expect(state.parks[0]?.deadline).toMatchObject({
			status: "discharged",
			transitionEventId: "child-output-a-event",
		});
	} finally {
		await fixture.dispose();
	}
});

it("does not let whitespace activity forge independent ready work", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation(parkInput(1, false));
		fixture.setChildState("obligation-1", "heartbeat-state");
		await expect(
			fixture.scheduler.observeChildActivity({
				outputObligationId: "obligation-1",
				stateDigest: "heartbeat-state",
				kind: "whitespace",
				independentReadyWork: true,
			}),
		).rejects.toThrow(/ready_work/);
		expect((await fixture.scheduler.readState()).parks[0]?.independentReadyWork).toBe(false);
	} finally {
		await fixture.dispose();
	}
});

it("revalidates the live lease and trusted clock on read and admission", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation(parkInput());
		fixture.setNow(61_000);
		await expect(
			Promise.all([fixture.scheduler.readState(), fixture.scheduler.modelTurnAdmission()]),
		).rejects.toThrow(/lease/);
	} finally {
		await fixture.dispose();
	}
});

it("quarantines one missing child state while processing another due deadline", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation(parkInput(1, false));
		await fixture.scheduler.parkChildObligation(parkInput(2, false));
		fixture.deleteChildState("obligation-1");
		fixture.setNow(1_000);
		const state = await fixture.scheduler.onHostTimer();
		expect((state.parks[0] as unknown as { quarantineReason: string | null }).quarantineReason).not.toBeNull();
		expect(state.parks[1]?.deadline.status).toBe("terminal_failed");
	} finally {
		await fixture.dispose();
	}
});

it("retains urgent safe-boundary pending across episodes and preserves new event provenance", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation(parkInput());
		fixture.setChildState("obligation-1", "normal-terminal");
		await fixture.scheduler.recordChildOutput({
			outputObligationId: "obligation-1",
			stateDigest: "normal-terminal",
			eventId: "normal-event",
			head: HEAD,
			wakeKey: "stable-wake-1",
			wakeKind: "final_output",
			terminalStatus: "discharged",
		});
		const normal = await fixture.scheduler.claimWake();
		await fixture.scheduler.acknowledgeWake({ episodeId: normal?.episodeId ?? "", claimId: normal?.claimId ?? "" });

		fixture.setChildState("obligation-1", "gating-state-1");
		await fixture.scheduler.recordChildOutput({
			outputObligationId: "obligation-1",
			stateDigest: "gating-state-1",
			eventId: "gating-event-1",
			head: HEAD,
			wakeKey: "stable-wake-1",
			wakeKind: "gating",
		});
		const urgentOne = await fixture.scheduler.claimWake();
		await fixture.scheduler.acknowledgeWake({
			episodeId: urgentOne?.episodeId ?? "",
			claimId: urgentOne?.claimId ?? "",
		});

		fixture.setChildState("obligation-1", "gating-state-2");
		await fixture.scheduler.recordChildOutput({
			outputObligationId: "obligation-1",
			stateDigest: "gating-state-2",
			eventId: "gating-event-2",
			head: HEAD,
			wakeKey: "stable-wake-1",
			wakeKind: "gating",
		});
		const stateWithTwoUrgentEpisodes = await fixture.scheduler.readState();
		const urgentEpisodes = stateWithTwoUrgentEpisodes.wakeEpisodes.filter((episode) => episode.priority === "urgent");
		expect(urgentEpisodes).toHaveLength(2);
		expect(urgentEpisodes[1]?.wakeRefs[0]?.createdByEventId).toBe("gating-event-2");
		const urgentTwo = await fixture.scheduler.claimWake();
		await fixture.scheduler.acknowledgeWake({
			episodeId: urgentTwo?.episodeId ?? "",
			claimId: urgentTwo?.claimId ?? "",
		});
		await fixture.scheduler.handleUrgentSafeBoundary({ episodeId: urgentOne?.episodeId ?? "" });
		expect((await fixture.scheduler.readState()).urgentBoundaryPending).toBe(true);
		await fixture.scheduler.handleUrgentSafeBoundary({ episodeId: urgentTwo?.episodeId ?? "" });
		expect((await fixture.scheduler.readState()).urgentBoundaryPending).toBe(false);
	} finally {
		await fixture.dispose();
	}
});

it("bounds child-output identity strings", async () => {
	const fixture = await createFixture();
	try {
		await fixture.scheduler.parkChildObligation(parkInput());
		fixture.setChildState("obligation-1", "bounded-state");
		await expect(
			fixture.scheduler.recordChildOutput({
				outputObligationId: "obligation-1",
				stateDigest: "bounded-state",
				eventId: "e".repeat(4096),
				head: HEAD,
				wakeKey: "bounded-wake",
				wakeKind: "final_output",
			}),
		).rejects.toThrow(/event/);
	} finally {
		await fixture.dispose();
	}
});
