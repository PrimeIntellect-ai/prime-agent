import { describe, expect, it } from "vitest";
import type { KnowledgeDurableStore } from "../src/core/knowledge/knowledge-durable-adapter.js";
import {
	createKnowledgeStore,
	type KnowledgeCommitRequest,
	type KnowledgeRecallInput,
	type KnowledgeStore,
} from "../src/core/knowledge/knowledge-store.js";
import { type KnowledgeEvent, type KnowledgeProjection, reduceKnowledgeEvent } from "../src/core/knowledge/records.js";
import type { WorkflowEpochRef, WorkflowJournalHead } from "../src/core/workflow/contracts.js";
import { digestObject } from "../src/core/workflow/contracts.js";
import type { DurableStoreCommitResult } from "../src/core/workflow/durable-store.js";
import {
	bindFixtureKnowledgeAuthority,
	clockReceipt,
	decisionRef,
	EPOCH,
	evidence,
	hostValidators,
	LEASE,
	proposal,
	RECEIPT_CONTEXT,
	TRUSTED_NOW,
	TRUSTED_PRINCIPAL,
} from "./knowledge-fixtures.js";

function request(overrides: Partial<KnowledgeCommitRequest> = {}): KnowledgeCommitRequest {
	const nextProposal = overrides.proposal ?? proposal();
	return {
		proposal: nextProposal,
		mutationId: nextProposal.proposalId,
		idempotencyKey: `knowledge:${nextProposal.proposalId}`,
		expectedHead: emptyHead(),
		baselineDigest: "baseline-0",
		expectedGenerations: { knowledge: 1 },
		writerIdentity: "writer-1",
		leaseRef: LEASE,
		epochRef: EPOCH,
		executionKey: "execution-1",
		knowledgeStoreEpoch: EPOCH.storeEpoch,
		...overrides,
	};
}

function emptyHead(): WorkflowJournalHead {
	return { workflowId: "workflow-1", sequence: 0, eventDigest: null, epochRef: EPOCH };
}

function fakeDurableStore(): KnowledgeDurableStore & {
	commitCalls: number;
	events: KnowledgeEvent[];
} {
	// FAKE-ONLY: this fixture isolates the adapter contract; the durable-store package owns authenticated runtime integration.
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
	const durable: KnowledgeDurableStore & { commitCalls: number; events: KnowledgeEvent[] } = {
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
		commitCalls: 0,
		events,
		read: async () =>
			structuredClone({
				state,
				sequence: state.sequence,
				digest: state.sequence === 0 ? null : `journal-digest-${state.sequence}`,
				projectionDigest: state.digest,
			}),
		commit: async (input) => {
			durable.commitCalls += 1;
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

function createStore(): { store: KnowledgeStore; durable: ReturnType<typeof fakeDurableStore> } {
	const durable = fakeDurableStore();
	return {
		store: createKnowledgeStore({
			durableStore: durable,
			namespace: "knowledge",
			trustedNow: () => TRUSTED_NOW,
			receiptContext: RECEIPT_CONTEXT,
			...hostValidators(),
		}),
		durable,
	};
}

async function recall(
	store: KnowledgeStore,
	overrides: Omit<KnowledgeRecallInput, "query" | "principal" | "trustedClockReceipt"> = {},
) {
	const query = "fixture";
	const scoped = { workspaceId: "workspace-1", ...overrides };
	const state = await store.read();
	return store.recall({
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
}

describe("canonical knowledge durable store", () => {
	it("commits only through the injected knowledge durable store and is idempotent", async () => {
		const { store, durable } = createStore();
		const first = await store.commit(request());
		const replay = await store.commit(request());
		expect(first.status).toBe("committed");
		expect(replay.status).toBe("replayed");
		expect(durable.commitCalls).toBe(1);
		expect(first.record.commitRef).toEqual(replay.record.commitRef);
	});

	it("rejects wrong namespace, epoch, decision, and evidence before durable commit", async () => {
		const { store, durable } = createStore();
		await expect(
			store.commit(
				request({
					proposal: proposal({
						applicability: { namespace: "other", scope: "workspace", workspaceId: "workspace-1" },
					}),
				}),
			),
		).rejects.toThrow(/namespace/i);
		await expect(
			store.commit(request({ proposal: proposal({ epochRef: { storeEpoch: 4, coordinatorEpoch: 7 } }) })),
		).rejects.toThrow(/epoch/i);
		await expect(
			store.commit(
				request({
					proposal: proposal({
						decisionRef: { ...decisionRef(), decisionScope: { kind: "knowledge", namespace: "other" } },
					}),
				}),
			),
		).rejects.toThrow(/decision|namespace/i);
		await expect(store.commit(request({ proposal: proposal({ evidenceRefs: [] }) }))).rejects.toThrow(/evidence/i);
		expect(durable.commitCalls).toBe(0);
	});

	it("rejects a no-op host decision resolver before durable append", async () => {
		const durable = fakeDurableStore();
		const store = createKnowledgeStore({
			durableStore: durable,
			namespace: "knowledge",
			trustedNow: () => TRUSTED_NOW,
			receiptContext: RECEIPT_CONTEXT,
			...hostValidators(),
			validateDecision: async () => undefined as never,
		});
		await expect(store.commit(request())).rejects.toThrow(/resolver-backed|decision|receipt/i);
		expect(durable.commitCalls).toBe(0);
	});

	it("creates immutable revisions, records supersession, and supports compensating rollback", async () => {
		const { store } = createStore();
		const created = await store.commit(request());
		const superseded = await store.commit(
			request({
				proposal: proposal({
					proposalId: "proposal-2",
					statement: "Run the fixture and inspect the verified output.",
					action: "supersede",
					expectedRevision: created.record.revision,
				}),
				mutationId: "proposal-2",
				idempotencyKey: "knowledge:proposal-2",
				expectedHead: { ...emptyHead(), sequence: 1, eventDigest: "journal-digest-1" },
				baselineDigest: "baseline-1",
			}),
		);
		expect(superseded.record.revision).toBe(2);
		expect(superseded.record.status).toBe("active");
		expect((await store.history("record-1")).map((record) => record.status)).toEqual(["superseded", "active"]);
		const rolledBack = await store.commit(
			request({
				proposal: proposal({
					proposalId: "proposal-3",
					action: "rollback",
					expectedRevision: superseded.record.revision,
					rollbackRevision: created.record.revision,
				}),
				mutationId: "proposal-3",
				idempotencyKey: "knowledge:proposal-3",
				expectedHead: { ...emptyHead(), sequence: 2, eventDigest: "journal-digest-2" },
				baselineDigest: "baseline-2",
			}),
		);
		expect(rolledBack.record.revision).toBe(3);
		expect(rolledBack.record.action).toBe("rollback");
		expect(rolledBack.record.statement).toBe(created.record.statement);
	});

	it("replays the canonical projection and recovers across a new wrapper", async () => {
		const durable = fakeDurableStore();
		const first = createKnowledgeStore({
			durableStore: durable,
			namespace: "knowledge",
			trustedNow: () => TRUSTED_NOW,
			receiptContext: RECEIPT_CONTEXT,
			...hostValidators(),
		});
		await first.commit(request());
		const reopened = createKnowledgeStore({
			durableStore: durable,
			namespace: "knowledge",
			trustedNow: () => TRUSTED_NOW,
			receiptContext: RECEIPT_CONTEXT,
			...hostValidators(),
		});
		expect((await reopened.read()).records["record-1"]?.commitRef).toBeDefined();
		expect((await reopened.replay()).map((event) => event.record.recordId)).toEqual(["record-1"]);
		expect((await reopened.recover()).status).toBe("healthy");
	});

	it("rejects stale host evidence before invoking the durable writer", async () => {
		const { store, durable } = createStore();
		const stale = proposal({
			evidenceRefs: [
				{
					...evidence("stale"),
					validationReceipt: {
						...evidence("stale").validationReceipt,
						validUntil: "2026-08-15T00:00:00.000Z",
					},
				},
			],
		});
		await expect(store.commit(request({ proposal: stale }))).rejects.toThrow(/fresh|stale|expired/i);
		expect(durable.commitCalls).toBe(0);
	});

	it("rejects a durable result whose authenticated sequence does not bind the request", async () => {
		const { store, durable } = createStore();
		const originalCommit = durable.commit;
		durable.commit = async (input) => {
			const result = await originalCommit(input);
			return {
				...result,
				event: {
					...result.event,
					record: {
						...result.event.record,
						commitRef: { ...result.event.record.commitRef, knowledgeJournalSequence: result.sequence + 1 },
					},
				},
			};
		};
		await expect(store.commit(request())).rejects.toThrow(/binding|sequence|canonical/i);
	});

	it("rejects a replay chain with a sequence gap instead of trusting the projection", async () => {
		const durable = fakeDurableStore();
		const store = createKnowledgeStore({
			durableStore: durable,
			namespace: "knowledge",
			trustedNow: () => TRUSTED_NOW,
			receiptContext: RECEIPT_CONTEXT,
			...hostValidators(),
		});
		await store.commit(request());
		durable.events[0] = {
			...durable.events[0]!,
			record: {
				...durable.events[0]!.record,
				commitRef: { ...durable.events[0]!.record.commitRef, knowledgeJournalSequence: 4 },
			},
		};
		await expect(store.replay()).rejects.toThrow(/chain|sequence|canonical/i);
	});

	it("retracts to an anti-resurrection tombstone and removes the record from recall", async () => {
		const { store } = createStore();
		const created = await store.commit(request());
		const retracted = await store.commit(
			request({
				proposal: proposal({
					proposalId: "proposal-retract",
					action: "retract",
					expectedRevision: created.record.revision,
				}),
				mutationId: "proposal-retract",
				idempotencyKey: "knowledge:proposal-retract",
				expectedHead: { ...emptyHead(), sequence: 1, eventDigest: "journal-digest-1" },
				baselineDigest: "baseline-1",
			}),
		);
		expect(retracted.record.status).toBe("retracted");
		expect(retracted.record.tombstone?.deletionFingerprint).toBeTruthy();
		expect(retracted.record.statement).toBe("[retracted]");
		expect(await recall(store)).toEqual([]);
		for (const record of await store.history("record-1")) {
			expect(record.title).toBe("[retracted]");
			expect(record.statement).toBe("[retracted]");
			expect(record.procedure).toBeUndefined();
		}
		for (const event of await store.replay()) {
			expect(event.record.title).toBe("[retracted]");
			expect(event.record.statement).toBe("[retracted]");
			expect(event.record.procedure).toBeUndefined();
		}
	});

	it("keeps path-bound workspace knowledge visible from an enclosing recall boundary", async () => {
		const { store } = createStore();
		await store.commit(
			request({
				proposal: proposal({
					applicability: {
						namespace: "knowledge",
						scope: "workspace",
						workspaceId: "workspace-1",
						pathPrefix: "src/utils",
					},
				}),
			}),
		);
		expect(await recall(store, { workspaceId: "workspace-1", pathPrefix: "src" })).toHaveLength(1);
	});

	it("does not let a revision change its stable path binding", async () => {
		const { store } = createStore();
		const created = await store.commit(request());
		await expect(
			store.commit(
				request({
					proposal: proposal({
						proposalId: "proposal-path-change",
						action: "supersede",
						expectedRevision: created.record.revision,
						applicability: {
							namespace: "knowledge",
							scope: "workspace",
							workspaceId: "workspace-1",
							pathPrefix: "other",
						},
					}),
					mutationId: "proposal-path-change",
					idempotencyKey: "knowledge:proposal-path-change",
					expectedHead: { ...emptyHead(), sequence: 1, eventDigest: "journal-digest-1" },
					baselineDigest: "baseline-1",
				}),
			),
		).rejects.toThrow(/scope|path|binding/i);
	});
});
