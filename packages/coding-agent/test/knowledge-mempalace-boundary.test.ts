import { describe, expect, it } from "vitest";
import type { KnowledgeDurableStore } from "../src/core/knowledge/knowledge-durable-adapter.js";
import {
	createKnowledgeStore,
	type KnowledgeCommitRequest,
	type KnowledgeStore,
} from "../src/core/knowledge/knowledge-store.js";
import {
	createKnowledgeMempalaceBoundary,
	type KnowledgeMempalaceFence,
	type KnowledgeMempalaceHealth,
	type KnowledgeMempalaceIndex,
	type KnowledgeMempalaceOutbox,
	type KnowledgeMempalaceOutboxEntry,
	type KnowledgeMempalaceRecallInput,
} from "../src/core/knowledge/mempalace-boundary.js";
import {
	type KnowledgeEvent,
	type KnowledgeProjection,
	type KnowledgeRecord,
	reduceKnowledgeEvent,
} from "../src/core/knowledge/records.js";
import type { WorkflowEpochRef, WorkflowJournalHead } from "../src/core/workflow/contracts.js";
import { digestObject } from "../src/core/workflow/contracts.js";
import type { DurableStoreCommitResult } from "../src/core/workflow/durable-store.js";
import {
	bindFixtureKnowledgeAuthority,
	clockReceipt,
	EPOCH,
	hostValidators,
	LEASE,
	proposal,
	RECEIPT_CONTEXT,
	TRUSTED_NOW,
	TRUSTED_PRINCIPAL,
} from "./knowledge-fixtures.js";

function emptyHead(): WorkflowJournalHead {
	return { workflowId: "workflow-1", sequence: 0, eventDigest: null, epochRef: EPOCH };
}

function request(): KnowledgeCommitRequest {
	return {
		proposal: proposal(),
		mutationId: "proposal-1",
		idempotencyKey: "knowledge:proposal-1",
		expectedHead: emptyHead(),
		baselineDigest: "baseline-0",
		expectedGenerations: { knowledge: 1 },
		writerIdentity: "writer-1",
		leaseRef: LEASE,
		epochRef: EPOCH,
		executionKey: "execution-1",
		knowledgeStoreEpoch: EPOCH.storeEpoch,
	};
}

function createStoreFixture(): KnowledgeDurableStore {
	// FAKE-ONLY: this fixture isolates projection ordering; durable-store authentication is covered by its existing suite.
	let state: KnowledgeProjection = { namespace: "knowledge", records: {}, history: [], sequence: 0, digest: null };
	const events: KnowledgeEvent[] = [];
	type TestCommitResult = DurableStoreCommitResult<KnowledgeProjection, KnowledgeEvent> & {
		projectionDigest: string;
		authenticatedCommit: {
			eventDigest: string;
			sequence: number;
			epochRef: WorkflowEpochRef;
			generationId: string;
			keyId: string;
			recordMac: string;
			recordChecksum: string;
			committedFrameDigest: string;
			committedFrameMac: string;
			committedFrameChecksum: string;
		};
	};
	const idempotency = new Map<string, TestCommitResult>();
	const authenticatedCommits = new Map<number, TestCommitResult["authenticatedCommit"]>();
	const durable: KnowledgeDurableStore = {
		storeId: "knowledge-store",
		namespace: "knowledge",
		workflowId: "workflow-1",
		epochRef: EPOCH,
		generationId: "generation-1",
		currentLeaseRef: () => LEASE,
		kernelVersion: 1,
		journalInstanceId: "journal-1",
		leaseInstanceId: "lease-instance-1",
		snapshotInstanceId: "snapshot-1",
		reducerInstanceId: "reducer-1",
		read: async () =>
			structuredClone({
				state,
				sequence: state.sequence,
				digest: state.sequence === 0 ? null : `journal-digest-${state.sequence}`,
				projectionDigest: state.digest,
			}),
		commit: async (input) => {
			const replay = idempotency.get(input.idempotencyKey);
			if (replay !== undefined) return { ...replay, replayed: true };
			const event = input.semantic;
			events.push(event);
			const sequence = events.length;
			const digest = `journal-digest-${sequence}`;
			state = reduceKnowledgeEvent(state, event);
			const head = { workflowId: "workflow-1", sequence, eventDigest: digest, epochRef: EPOCH };
			const authenticatedCommit = {
				eventDigest: digest,
				sequence,
				epochRef: EPOCH,
				generationId: "generation-1",
				keyId: "key-1",
				recordMac: `record-mac-${sequence}`,
				recordChecksum: `record-checksum-${sequence}`,
				committedFrameDigest: `frame-digest-${sequence}`,
				committedFrameMac: `frame-mac-${sequence}`,
				committedFrameChecksum: `frame-checksum-${sequence}`,
			};
			const result = {
				sequence,
				digest,
				replayed: false,
				idempotencyConflict: false,
				authenticatedEventDigest: digest,
				postCommitExtension: null,
				state,
				event,
				head,
				projectionDigest: state.digest ?? digestObject(state),
				authenticatedCommit,
			} satisfies TestCommitResult;
			const completeResult = result as TestCommitResult;
			authenticatedCommits.set(sequence, authenticatedCommit);
			idempotency.set(input.idempotencyKey, completeResult);
			return completeResult;
		},
		replay: async () => [...events],
		readAuthenticatedCommit: async (sequence) => structuredClone(authenticatedCommits.get(sequence) ?? null),
		recover: async () => ({
			status: "healthy" as const,
			metadata: {
				source: { artifactRef: null, relativePath: "events.log", digest: state.digest, sizeBytes: 0 },
				epochRef: EPOCH,
				reconciliation: null,
				quarantine: null,
			},
		}),
	};
	bindFixtureKnowledgeAuthority(durable, events);
	return durable;
}

interface BoundaryFixture {
	store: KnowledgeStore;
	request: KnowledgeCommitRequest;
	commit: () => Promise<KnowledgeRecord>;
	index: KnowledgeMempalaceIndex;
	indexed: KnowledgeRecord[];
	deleted: string[];
	outbox: KnowledgeMempalaceOutbox;
	outboxEntries: KnowledgeMempalaceOutboxEntry[];
}

async function recall(
	testFixture: BoundaryFixture,
	boundary: ReturnType<typeof createKnowledgeMempalaceBoundary>,
	overrides: Partial<Omit<KnowledgeMempalaceRecallInput, "query" | "principal" | "trustedClockReceipt">> = {},
) {
	const query = "fixture";
	const scoped = { workspaceId: "workspace-1", ...overrides };
	const state = await testFixture.store.read();
	const result = await boundary.recall({
		query,
		...scoped,
		principal: TRUSTED_PRINCIPAL,
		trustedClockReceipt: clockReceipt({
			stateDigest: digestObject(state),
			query,
			revision: Math.max(state.sequence, 1),
			...scoped,
		}),
	});
	return result;
}

function fixture(): BoundaryFixture {
	const durable = createStoreFixture();
	const store = createKnowledgeStore({
		durableStore: durable,
		namespace: "knowledge",
		trustedNow: () => TRUSTED_NOW,
		receiptContext: RECEIPT_CONTEXT,
		...hostValidators(),
	});
	const commitRequest = request();
	const indexed: KnowledgeRecord[] = [];
	const deleted: string[] = [];
	let indexFence: KnowledgeMempalaceFence | null = null;
	const index: KnowledgeMempalaceIndex = {
		upsert: async (record) => {
			indexed.push(record);
			indexFence = {
				knowledgeStoreEpoch: record.commitRef.knowledgeStoreEpoch,
				coordinatorEpoch: record.commitRef.workflowEpochRef.coordinatorEpoch,
				knowledgeJournalSequence: record.commitRef.knowledgeJournalSequence,
				knowledgeJournalDigest: `journal-digest-${record.commitRef.knowledgeJournalSequence}`,
			};
		},
		delete: async (recordId, fence) => {
			deleted.push(recordId);
			indexFence = fence ?? indexFence;
		},
		search: async () => indexed,
		readFence: async () => indexFence,
	};
	const pending: KnowledgeMempalaceOutboxEntry[] = [];
	const outboxEntries: KnowledgeMempalaceOutboxEntry[] = [];
	const outbox: KnowledgeMempalaceOutbox = {
		append: async (entry) => {
			outboxEntries.push(entry);
			pending.push(entry);
		},
		pending: async () => pending,
		acknowledge: async (idempotencyKey) => {
			const index = pending.findIndex((entry) => entry.idempotencyKey === idempotencyKey);
			if (index >= 0) pending.splice(index, 1);
		},
	};
	return {
		store,
		request: commitRequest,
		commit: async () => (await store.commit(commitRequest)).record,
		index,
		indexed,
		deleted,
		outbox,
		outboxEntries,
	};
}

describe("MemPalace canonical boundary", () => {
	it("does not recall or accept a record before canonical commit", async () => {
		const testFixture = fixture();
		const boundary = createKnowledgeMempalaceBoundary({
			store: testFixture.store,
			index: testFixture.index,
			now: () => TRUSTED_NOW,
		});
		const uncommitted = {
			...(testFixture.request.proposal as unknown as KnowledgeRecord),
			commitRef: null,
		} as unknown as KnowledgeRecord;
		await expect(boundary.accept(uncommitted)).rejects.toThrow(/commit|canonical/i);
		expect(await recall(testFixture, boundary)).toEqual([]);
	});

	it("rejects forged commit receipts and alias mutation", async () => {
		const testFixture = fixture();
		const boundary = createKnowledgeMempalaceBoundary({
			store: testFixture.store,
			index: testFixture.index,
			now: () => TRUSTED_NOW,
		});
		const committed = await testFixture.commit();
		const forged = structuredClone(committed);
		forged.commitRef.transactionDigest = "forged";
		await expect(boundary.accept(forged)).rejects.toThrow(/commit|receipt|canonical/i);
		const callerRecord = structuredClone(committed);
		const accepted = await boundary.accept(callerRecord);
		callerRecord.title = "caller mutation";
		expect(accepted.title).not.toBe("caller mutation");
	});

	it("uses canonical committed records regardless of missing or stale index state", async () => {
		const testFixture = fixture();
		const boundary = createKnowledgeMempalaceBoundary({
			store: testFixture.store,
			index: testFixture.index,
			now: () => TRUSTED_NOW,
		});
		const committed = await testFixture.commit();
		await boundary.accept(committed);
		const stale = structuredClone(committed);
		stale.statement = "stale index text";
		testFixture.index.search = async () => [stale];
		const recalled = await recall(testFixture, boundary);
		expect(recalled).toHaveLength(1);
		expect(recalled[0]!.statement).toBe(committed.statement);
		const noIndex = createKnowledgeMempalaceBoundary({ store: testFixture.store, now: () => TRUSTED_NOW });
		expect(await recall(testFixture, noIndex)).toEqual(recalled);
	});

	it("writes a fenced outbox entry before projecting and reports degraded index health", async () => {
		const testFixture = fixture();
		const boundary = createKnowledgeMempalaceBoundary({
			store: testFixture.store,
			index: testFixture.index,
			outbox: testFixture.outbox,
			now: () => TRUSTED_NOW,
		});
		const committed = await testFixture.commit();
		await expect(boundary.accept(committed)).resolves.toEqual(committed);
		expect(testFixture.outboxEntries).toHaveLength(1);
		expect(testFixture.outboxEntries[0]!.fence.knowledgeJournalSequence).toBe(
			committed.commitRef.knowledgeJournalSequence,
		);
		expect(testFixture.outboxEntries[0]!.fence.knowledgeJournalDigest).toBe("journal-digest-1");
		expect(await boundary.health()).toMatchObject<Partial<KnowledgeMempalaceHealth>>({ status: "healthy" });

		const failingIndex: KnowledgeMempalaceIndex = {
			upsert: async () => {
				throw new Error("index unavailable");
			},
			search: async () => [],
		};
		const degraded = createKnowledgeMempalaceBoundary({
			store: testFixture.store,
			index: failingIndex,
			now: () => TRUSTED_NOW,
		});
		await degraded.accept(committed);
		expect((await degraded.health()).status).toBe("degraded");
		expect((await recall(testFixture, degraded))[0]?.recordId).toBe("record-1");
	});

	it("never reports healthy or projects directly when an index has no durable outbox", async () => {
		const testFixture = fixture();
		const boundary = createKnowledgeMempalaceBoundary({
			store: testFixture.store,
			index: testFixture.index,
			now: () => TRUSTED_NOW,
		});
		const committed = await testFixture.commit();

		await expect(boundary.accept(committed)).resolves.toEqual(committed);
		expect(testFixture.indexed).toEqual([]);
		expect(await boundary.health()).toMatchObject<Partial<KnowledgeMempalaceHealth>>({
			status: "degraded",
			reason: expect.stringMatching(/outbox/i),
		});
	});

	it("deduplicates repeated delivery and rejects unknown recall routes", async () => {
		const testFixture = fixture();
		const boundary = createKnowledgeMempalaceBoundary({
			store: testFixture.store,
			index: testFixture.index,
			outbox: testFixture.outbox,
			now: () => TRUSTED_NOW,
		});
		const committed = await testFixture.commit();
		await boundary.accept(committed);
		await boundary.accept(committed);
		expect(testFixture.outboxEntries).toHaveLength(1);
		await expect(recall(testFixture, boundary, { route: "unknown" as never })).rejects.toThrow(/route/i);
	});

	it("projects a retraction as a delete and rejects stale active resurrection", async () => {
		const testFixture = fixture();
		const boundary = createKnowledgeMempalaceBoundary({
			store: testFixture.store,
			index: testFixture.index,
			outbox: testFixture.outbox,
			now: () => TRUSTED_NOW,
		});
		const committed = await testFixture.commit();
		await boundary.accept(committed);
		const retractedRequest = {
			...testFixture.request,
			proposal: {
				...testFixture.request.proposal,
				proposalId: "proposal-retract",
				action: "retract" as const,
				expectedRevision: committed.revision,
			},
			mutationId: "proposal-retract",
			idempotencyKey: "knowledge:proposal-retract",
			expectedHead: { ...emptyHead(), sequence: 1, eventDigest: "journal-digest-1" },
			baselineDigest: "baseline-1",
		};
		const retracted = (await testFixture.store.commit(retractedRequest)).record;
		await expect(boundary.accept(retracted)).resolves.toEqual(retracted);
		expect(testFixture.deleted).toEqual(["record-1"]);
		await expect(boundary.accept(committed)).rejects.toThrow(/canonical|revision|stale/i);
	});
});
