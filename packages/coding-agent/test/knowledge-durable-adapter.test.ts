import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GoalState } from "../src/core/goals.js";
import { emptyGoalState } from "../src/core/goals.js";
import {
	createKnowledgeDurableStore,
	type KnowledgeDurableStore,
} from "../src/core/knowledge/knowledge-durable-adapter.js";
import {
	createKnowledgeStore,
	type KnowledgeCommitRequest,
	type KnowledgeStore,
} from "../src/core/knowledge/knowledge-store.js";
import {
	createKnowledgeMempalaceBoundary,
	type KnowledgeMempalaceFence,
	type KnowledgeMempalaceOutboxEntry,
} from "../src/core/knowledge/mempalace-boundary.js";
import type { KnowledgeEvent, KnowledgeProposal, KnowledgeRecord } from "../src/core/knowledge/records.js";
import {
	knowledgeContentDigest,
	knowledgeSourceDigest,
	validateKnowledgeRecord,
} from "../src/core/knowledge/records.js";
import type {
	DurableDecisionRef,
	WorkflowHostReceiptConsumerContext,
	WorkflowJournalHead,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreDurableContext,
	WorkflowSemanticMutationBinding,
} from "../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes } from "../src/core/workflow/contracts.js";
import type { DurableStoreMutationRequest } from "../src/core/workflow/durable-store.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
} from "../src/core/workflow/session-host-factory.js";
import {
	artifact,
	clockReceipt,
	createPersistedFixtureHostReceiptConsumerContext,
	EPOCH,
	hostReceipt,
	hostValidators,
	proposal,
	RECEIPT_CONTEXT,
	TRUSTED_PRINCIPAL,
} from "./knowledge-fixtures.js";

const WORKFLOW_ID = "knowledge-workflow-1";
const ROOT_SESSION_ID = "knowledge-session-1";
const TRUSTED_NOW = "2026-08-16T15:30:00.000Z";

interface ProcessAuthority {
	host: PersistedSessionWorkflowHost;
	runtimeStore: WorkflowRuntimeStore;
	context: WorkflowRuntimeStoreDurableContext;
	store: KnowledgeDurableStore;
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("authenticated knowledge durable projection", () => {
	it("does not expose raw authority, replay, or auxiliary capabilities on the public store", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-public-capabilities-red-"));
		let processA: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const publicNames = Object.getOwnPropertyNames(processA.store);
			expect(publicNames).not.toContain("durableContext");
			expect(publicNames).not.toContain("workflowRuntimeStore");
			expect(publicNames).not.toContain("replayCanonical");
			expect(publicNames).not.toContain("__prime_agent_knowledge_commit_authority__");
			const outboxNames = Object.getOwnPropertyNames(processA.store.mempalaceOutbox ?? {});
			expect(outboxNames).not.toContain("context");
			expect(outboxNames).not.toContain("runtimeStore");
			expect(outboxNames).not.toContain("writeAuxiliary");
		} finally {
			await processA?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("redacted history does not retain source references or canonical tombstone fingerprints", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-history-red-"));
		let processA: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const store = createPublicKnowledgeStore(processA.store);
			const created = await store.commit(
				createKnowledgeRequest(
					processA.store,
					createProposal({
						kind: "procedure",
						procedure: {
							inputs: { command: "sensitive-command" },
							steps: ["Run the sensitive command."],
							successChecks: ["It succeeds."],
							failureChecks: ["It fails."],
						},
					}),
					"knowledge:history-red",
				),
			);
			const retracted = await store.commit(
				createKnowledgeRequest(
					processA.store,
					createProposal({
						proposalId: "proposal:history-retract",
						action: "retract",
						kind: "procedure",
						expectedRevision: created.record.revision,
					}),
					"knowledge:history-retract",
					await processA.store.read(),
				),
			);
			const history = await store.history("record-1");
			expect(history).toHaveLength(2);
			for (const historical of history) {
				expect(historical.evidenceRefs).toEqual([]);
				expect(historical.procedure).toBeUndefined();
				expect(historical.applicability.workspaceId).not.toBe("workspace-1");
				expect(historical.proposalId).not.toBe(created.record.proposalId);
				expect(historical.decisionRef.decisionId).not.toBe(created.record.decisionRef.decisionId);
				expect(JSON.stringify(historical)).not.toContain(WORKFLOW_ID);
			}
			expect(history[0]?.commitRef.knowledgeStoreId).not.toBe(created.record.commitRef.knowledgeStoreId);
			expect(history[0]?.commitRef.transactionDigest).not.toBe(created.record.commitRef.transactionDigest);
			expect(history[1]?.tombstone?.deletionFingerprint).not.toBe(retracted.record.tombstone?.deletionFingerprint);
		} finally {
			await processA?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not let a public auxiliary writer forge a durable MemPalace acknowledgement", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-auxiliary-forgery-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const committed = await commitPublic(processA.store, "knowledge:auxiliary-forgery");
			const entry: KnowledgeMempalaceOutboxEntry = {
				idempotencyKey: "mempalace:auxiliary-forgery",
				operation: "upsert",
				recordId: committed.event.record.recordId,
				revision: committed.event.record.revision,
				canonicalDigest: digestObject(committed.event.record),
				sourceDigest: committed.event.record.sourceDigest,
				tombstoneFingerprint: null,
				fence: {
					knowledgeStoreEpoch: EPOCH.storeEpoch,
					coordinatorEpoch: EPOCH.coordinatorEpoch,
					knowledgeJournalSequence: committed.sequence,
					knowledgeJournalDigest: committed.authenticatedEventDigest,
				},
				record: null,
			};
			await processA.store.mempalaceOutbox!.append(entry);
			await expect(
				processA.context.auxiliaryStore.write(
					"knowledge-mempalace-acks.json",
					new TextEncoder().encode(JSON.stringify({ acknowledged: [entry.idempotencyKey] })),
				),
			).rejects.toThrow(/canonical knowledge outbox authority/i);
			await processA.host.dispose?.();
			processA = undefined;
			processB = await openProcess(root);
			await expect(processB.store.mempalaceOutbox!.pending()).resolves.toEqual([entry]);
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a generic runtime-store knowledge append and preserves the empty journal", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-runtime-authority-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const mutation = await createMutation(processA.store);
			const runtimeStore = processA.runtimeStore;
			const context = processA.context;
			if (runtimeStore === undefined || context === undefined)
				throw new Error("Real knowledge runtime authority is unavailable.");
			const expectedHead = mutation.expectedHead;
			const leaseRef = mutation.leaseRef;
			await expect(
				runtimeStore.commit({
					workflowId: runtimeStore.identity.workflowId,
					payload: {
						kind: "knowledge_record_committed",
						idempotencyKey: mutation.idempotencyKey,
						record: {},
						previous: null,
						previousDigest: null,
						proposalDigest: "forged",
					},
					expectedHead,
					semanticBinding: {
						mutationId: mutation.mutationId,
						baselineDigest: mutation.baselineDigest,
						expectedGenerations: mutation.expectedGenerations,
						ownerId: "knowledge",
						phase: "planning",
						reducerDigest: digestObject("knowledge-reducer-v1"),
						semanticHead: {
							...expectedHead,
							stateDigest: mutation.baselineDigest,
							generation: EPOCH.storeEpoch,
						},
						expectedHead,
						idempotencyKey: mutation.idempotencyKey,
						executionKey: mutation.executionKey,
						writerIdentity: mutation.writerIdentity,
						leaseRef,
						epochRef: mutation.epochRef,
					},
					epochRef: mutation.epochRef,
					leaseRef,
					idempotencyKey: mutation.idempotencyKey,
					writerIdentity: mutation.writerIdentity,
					executionKey: mutation.executionKey,
				}),
			).rejects.toThrow(/knowledge.*authority|knowledge.*store|direct/i);
			const forgedRuntimeStore = {
				...runtimeStore,
				durableContext: { ...context },
			} as typeof runtimeStore;
			await expect(processA.store.commit(mutation)).rejects.toThrow(/authority|canonical|KnowledgeStore/i);
			expect(() =>
				createKnowledgeDurableStore({
					runtimeStore: forgedRuntimeStore,
					namespace: "knowledge",
					epochRef: EPOCH,
				}),
			).toThrow(/authority|authenticated workflow/i);
			await processA.host.dispose?.();
			processA = undefined;
			processB = await openProcess(root);
			await expect(processB.store.replay()).resolves.toEqual([]);
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("freezes the admitted request and rejects a head mutation after an intervening workflow event", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-request-cas-real-"));
		let processA: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const validators = hostValidators();
			const decisionStarted = createDeferred<void>();
			const releaseDecision = createDeferred<void>();
			const store = createKnowledgeStore({
				durableStore: processA.store,
				namespace: "knowledge",
				receiptContext: RECEIPT_CONTEXT,
				trustedNow: () => TRUSTED_NOW,
				...validators,
				validateDecision: async (reference, candidate, context) => {
					decisionStarted.resolve();
					await releaseDecision.promise;
					return validators.validateDecision(reference, candidate, context);
				},
			});
			const request = createKnowledgeRequest(processA.store, createProposal(), "knowledge:request-cas");
			const pending = store.commit(request);
			await decisionStarted.promise;
			await appendUnrelatedWorkflowEvent(processA);
			const advanced = await processA.store.read();
			request.expectedHead = {
				...request.expectedHead,
				sequence: advanced.journalSequence ?? advanced.sequence,
				eventDigest: advanced.journalDigest ?? advanced.digest,
			};
			request.baselineDigest = advanced.state.digest ?? digestObject(advanced.state);
			releaseDecision.resolve();
			await expect(pending).rejects.toThrow(/stale|head|canonical/i);
			expect((await processA.store.replay()).map((event) => event.record.recordId)).toEqual([]);
		} finally {
			await processA?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("commits in process A, reopens the same workflow in process B, and quarantines tampering", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-durable-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const committed = await commitPublic(processA.store, "knowledge:real-commit");
			const eventDigest = committed.authenticatedEventDigest;
			expect(committed.digest).toBe(eventDigest);
			expect(committed.projectionDigest).not.toBe(eventDigest);
			expect(committed.authenticatedCommit).toMatchObject({
				eventDigest,
				sequence: committed.sequence,
				epochRef: EPOCH,
				generationId: expect.any(String),
				keyId: expect.any(String),
				recordMac: expect.any(String),
				committedFrameMac: expect.any(String),
			});
			const journalPath = join(
				root,
				"workflows",
				WORKFLOW_ID,
				"generations",
				processA.context.generationId,
				"events.log",
			);
			const journalSizeBeforeRetry = (await readFile(journalPath)).byteLength;
			const retried = await createPublicKnowledgeStore(processA.store).commit(
				createKnowledgeRequest(processA.store, createProposal(), "knowledge:real-commit"),
			);
			expect(retried.status).toBe("replayed");
			expect(retried.commitRef.knowledgeJournalDigest).toBe(committed.event.record.commitRef.knowledgeJournalDigest);
			expect((await readFile(journalPath)).byteLength).toBe(journalSizeBeforeRetry);

			await processA.host.dispose?.();
			processA = undefined;
			processB = await openProcess(root);
			const replay = await processB.store.replay();
			expect(replay).toHaveLength(1);
			expect(replay[0]?.record.recordId).toBe("record-1");
			expect(replay[0]?.record.revision).toBe(1);
			expect(await processB.store.recover()).toMatchObject({ status: "healthy" });
			await processB.host.dispose?.();
			processB = undefined;

			const bytes = await readFile(journalPath);
			bytes[bytes.length - 12] = (bytes[bytes.length - 12] ?? 0) ^ 0xff;
			await writeFile(journalPath, bytes);
			await expect(openProcess(root)).rejects.toThrow(/quarantin|journal|frame|mac/i);
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reopens and drains a fenced MemPalace outbox without making it canonical", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-mempalace-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		let processC: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const committed = await commitPublic(processA.store, "knowledge:mempalace-real");
			const event = committed.event;
			const outbox = processA.store.mempalaceOutbox;
			expect(outbox).toBeDefined();
			const entry: KnowledgeMempalaceOutboxEntry = {
				idempotencyKey: "mempalace:record-1:1:upsert",
				operation: "upsert",
				recordId: event.record.recordId,
				revision: event.record.revision,
				canonicalDigest: digestObject(event.record),
				sourceDigest: event.record.sourceDigest,
				tombstoneFingerprint: null,
				fence: {
					knowledgeStoreEpoch: EPOCH.storeEpoch,
					coordinatorEpoch: EPOCH.coordinatorEpoch,
					knowledgeJournalSequence: committed.sequence,
					knowledgeJournalDigest: committed.authenticatedEventDigest,
				},
				record: null,
			};
			await outbox!.append(entry);
			await expect(outbox!.pending()).resolves.toEqual([entry]);
			await expect(outbox!.append({ ...entry, sourceDigest: "f".repeat(64) })).rejects.toThrow(
				/idempotency|conflict|fenced/i,
			);
			await expect(outbox!.pending()).resolves.toEqual([entry]);
			expect(await processA.store.replay()).toHaveLength(1);

			await processA.host.dispose?.();
			processA = undefined;
			processB = await openProcess(root);
			await expect(processB.store.mempalaceOutbox!.pending()).resolves.toEqual([entry]);
			expect(processB.store.mempalaceOutbox!.acknowledge).toBeTypeOf("function");
			await processB.store.mempalaceOutbox!.acknowledge!(entry.idempotencyKey, entry.fence);
			await processB.host.dispose?.();
			processB = undefined;

			processC = await openProcess(root);
			try {
				await expect(processC.store.mempalaceOutbox!.pending()).resolves.toEqual([]);
				await expect(
					processC.store.mempalaceOutbox!.append({ ...entry, sourceDigest: "f".repeat(64) }),
				).rejects.toThrow(/acknowledged|conflict|idempotency/i);
				const lostIndexBoundary = createKnowledgeMempalaceBoundary({
					store: createPublicKnowledgeStore(processC.store),
					index: {
						upsert: async () => undefined,
						search: async () => [],
						readFence: async () => null,
					},
					outbox: processC.store.mempalaceOutbox,
				});
				expect((await lostIndexBoundary.health()).status).toBe("degraded");
			} finally {
				await processC.host.dispose?.();
				processC = undefined;
			}
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await processC?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps MemPalace delivery order separate from unrelated workflow journal events", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-mempalace-mixed-workflow-"));
		let processA: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			await appendUnrelatedWorkflowEvent(processA);
			await appendWorkflowMetadataEvent(processA, "workflow-unrelated-metadata");
			const committed = await commitPublic(processA.store, "knowledge:mixed-real");
			const entry: KnowledgeMempalaceOutboxEntry = {
				idempotencyKey: "mempalace:record-1:1:upsert:mixed",
				operation: "upsert",
				recordId: committed.event.record.recordId,
				revision: committed.event.record.revision,
				canonicalDigest: digestObject(committed.event.record),
				sourceDigest: committed.event.record.sourceDigest,
				tombstoneFingerprint: null,
				fence: {
					knowledgeStoreEpoch: EPOCH.storeEpoch,
					coordinatorEpoch: EPOCH.coordinatorEpoch,
					knowledgeJournalSequence: committed.sequence,
					knowledgeJournalDigest: committed.authenticatedEventDigest,
				},
				record: null,
			};
			await processA.store.mempalaceOutbox!.append(entry);
			await expect(processA.store.mempalaceOutbox!.pending()).resolves.toEqual([entry]);
			const recoveredOutbox = await processA.context.outbox.recover(EPOCH);
			await expect(Promise.resolve(recoveredOutbox)).resolves.toMatchObject({
				quarantined: false,
				entries: [
					{
						sequence: 1,
						sourceEventSequence: committed.sequence,
						sourceEventDigest: committed.authenticatedEventDigest,
					},
				],
				head: { sequence: 1 },
			});
			const persistedEntry = recoveredOutbox.entries[0];
			if (persistedEntry === undefined) throw new Error("Mixed workflow fixture lost its durable outbox entry.");
			const {
				sourceEventSequence: _sourceEventSequence,
				sourceEventDigest: _sourceEventDigest,
				...missingSourceBinding
			} = persistedEntry;
			await expect(
				processA.context.outbox.append({
					...missingSourceBinding,
					sequence: persistedEntry.sequence + 1,
					idempotencyKey: "mempalace:missing-source-binding",
					authenticatedTuple: {
						...persistedEntry.authenticatedTuple,
						idempotencyKey: "mempalace:missing-source-binding",
					},
				}),
			).rejects.toThrow(/authenticated|source|tuple|outbox/i);
			const workflowReplay = await processA.runtimeStore.replay({
				workflowId: WORKFLOW_ID,
				fromSequence: 1,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			const unrelated = workflowReplay.events.find((candidate) => candidate.sequence === 1);
			if (unrelated === undefined) throw new Error("Mixed workflow fixture lost its unrelated event.");
			await expect(
				processA.store.mempalaceOutbox!.append({
					...entry,
					idempotencyKey: "mempalace:record-1:1:upsert:foreign-source",
					fence: {
						...entry.fence,
						knowledgeJournalSequence: unrelated.sequence,
						knowledgeJournalDigest: unrelated.eventDigest,
					},
				}),
			).rejects.toThrow(/knowledge journal event|fence|record/i);
			await expect(
				processA.store.mempalaceOutbox!.append({
					...entry,
					idempotencyKey: "mempalace:record-1:1:upsert:stale-source",
					fence: { ...entry.fence, knowledgeJournalDigest: "0".repeat(64) },
				}),
			).rejects.toThrow(/fence|authenticated|journal/i);
			await expect(
				processA.store.mempalaceOutbox!.append({
					...entry,
					idempotencyKey: "mempalace:record-1:1:upsert:forged-source-digest",
					sourceDigest: "f".repeat(64),
				}),
			).rejects.toThrow(/source|fence|record/i);
			await expect(
				processA.store.mempalaceOutbox!.append({
					...entry,
					idempotencyKey: "mempalace:record-1:1:upsert:forged-store-epoch",
					fence: { ...entry.fence, knowledgeStoreEpoch: EPOCH.storeEpoch + 1 },
				}),
			).rejects.toThrow(/epoch|fence|record/i);
			await expect(
				processA.store.mempalaceOutbox!.append({
					...entry,
					idempotencyKey: "mempalace:record-1:1:upsert:forged-coordinator-epoch",
					fence: { ...entry.fence, coordinatorEpoch: EPOCH.coordinatorEpoch + 1 },
				}),
			).rejects.toThrow(/epoch|fence|record/i);
			await expect(
				processA.store.mempalaceOutbox!.append({
					...entry,
					idempotencyKey: "mempalace:record-1:1:upsert:forged-record",
					canonicalDigest: "e".repeat(64),
				}),
			).rejects.toThrow(/record|fence|canonical/i);
			await expect(
				processA.store.mempalaceOutbox!.append({
					...entry,
					sourceDigest: "f".repeat(64),
				}),
			).rejects.toThrow(/idempotency|conflict|fenced/i);
			await expect(processA.store.mempalaceOutbox!.pending()).resolves.toEqual([entry]);
			expect((await processA.store.replay()).map((event) => event.record.recordId)).toEqual(["record-1"]);
		} finally {
			await processA?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("admits through host resolvers, recalls after reopen, and redacts tombstones from replay", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-public-store-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		let processC: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const storeA = createPublicKnowledgeStore(processA.store);
			const created = await storeA.commit(
				createKnowledgeRequest(
					processA.store,
					createProposal({
						kind: "procedure",
						procedure: {
							inputs: { command: "fixture" },
							steps: ["Run the fixture."],
							successChecks: ["The fixture succeeds."],
							failureChecks: ["The fixture fails."],
						},
					}),
					"knowledge:public-1",
				),
			);
			expect(created.status).toBe("committed");

			await processA.host.dispose?.();
			processA = undefined;
			processB = await openProcess(root);
			const storeB = createPublicKnowledgeStore(processB.store);
			const activeState = await storeB.read();
			const trustedClock = clockReceipt({
				workflowId: WORKFLOW_ID,
				stateDigest: digestObject(activeState),
				query: "fixture",
				workspaceId: "workspace-1",
				revision: Math.max(activeState.sequence, 1),
			});
			expect(
				await storeB.recall({
					query: "fixture",
					workspaceId: "workspace-1",
					principal: TRUSTED_PRINCIPAL,
					trustedClockReceipt: trustedClock,
				}),
			).toHaveLength(1);
			await expect(
				storeB.recall({
					query: "fixture",
					workspaceId: "other-workspace",
					principal: TRUSTED_PRINCIPAL,
					trustedClockReceipt: trustedClock,
				}),
			).rejects.toThrow(/binding|receipt|workspace|current/i);
			await expect(
				storeB.recall({
					query: "fixture",
					workspaceId: "workspace-1",
					principal: TRUSTED_PRINCIPAL,
					trustedClockReceipt: clockReceipt({
						workflowId: "foreign-workflow",
						stateDigest: digestObject(activeState),
						query: "fixture",
						workspaceId: "workspace-1",
						revision: Math.max(activeState.sequence, 1),
					}),
				}),
			).rejects.toThrow(/different workflow|receipt/i);

			const current = await processB.store.read();
			const invalidFingerprintStore = createKnowledgeStore({
				durableStore: processB.store,
				namespace: "knowledge",
				receiptContext: RECEIPT_CONTEXT,
				trustedNow: () => TRUSTED_NOW,
				...hostValidators(),
				deriveTombstoneFingerprint: async (context) => ({
					fingerprint: "f".repeat(64),
					receipt: hostReceipt("invalid-tombstone-fingerprint", {
						workflowId: context.workflowId,
						bindingDigest: context.bindingDigest,
						stateDigest: context.currentStateDigest,
						revision: context.currentRevision,
					}),
					context: RECEIPT_CONTEXT,
				}),
			});
			await expect(
				invalidFingerprintStore.commit(
					createKnowledgeRequest(
						processB.store,
						createProposal({
							proposalId: "proposal-invalid-tombstone",
							action: "retract",
							kind: "procedure",
							expectedRevision: created.record.revision,
						}),
						"knowledge:invalid-tombstone",
						current,
					),
				),
			).rejects.toThrow(/fingerprint|payload|binding/i);
			const retractionRequest = createKnowledgeRequest(
				processB.store,
				createProposal({
					proposalId: "proposal-retract-public",
					action: "retract",
					kind: "procedure",
					expectedRevision: created.record.revision,
				}),
				"knowledge:public-retract",
				current,
			);
			const retracted = await storeB.commit(retractionRequest);
			const replayedRetraction = await storeB.commit(retractionRequest);
			expect(replayedRetraction.status).toBe("replayed");
			expect(replayedRetraction.authenticatedCommit.eventDigest).toBe(retracted.authenticatedCommit.eventDigest);
			expect(retracted.record.status).toBe("retracted");
			const originalSourceDigest = created.record.sourceDigest;
			await processB.host.dispose?.();
			processB = undefined;

			processC = await openProcess(root);
			const storeC = createPublicKnowledgeStore(processC.store);
			for (const event of await storeC.replay()) {
				expect(event.record.title).toBe("[retracted]");
				expect(event.record.statement).toBe("[retracted]");
				expect(event.record.procedure).toBeUndefined();
				expect(event.record.sourceDigest).toBe(event.record.tombstone?.deletionFingerprint);
				expect(event.record.sourceDigest).not.toBe(originalSourceDigest);
				if (event.record.status === "superseded")
					expect(event.record.sourceDigest).not.toBe(retracted.record.tombstone?.deletionFingerprint);
			}
			for (const event of await processC.store.replay()) {
				expect(event.record.title).toBe("[retracted]");
				expect(event.record.statement).toBe("[retracted]");
				expect(event.record.procedure).toBeUndefined();
				expect(event.record.title).not.toContain("fixture");
			}
			const redactedHistory = await storeC.history("record-1");
			expect(redactedHistory.every((record) => record.title === "[retracted]")).toBe(true);
			expect(redactedHistory.every((record) => record.sourceDigest === record.tombstone?.deletionFingerprint)).toBe(
				true,
			);
			expect(redactedHistory.every((record) => record.sourceDigest !== originalSourceDigest)).toBe(true);
			expect(
				redactedHistory.some((record) => record.sourceDigest !== retracted.record.tombstone?.deletionFingerprint),
			).toBe(true);
			const redactedState = await storeC.read();
			await expect(
				storeC.recall({
					query: "fixture",
					workspaceId: "workspace-1",
					principal: TRUSTED_PRINCIPAL,
					trustedClockReceipt: clockReceipt({
						workflowId: WORKFLOW_ID,
						stateDigest: digestObject(redactedState),
						query: "fixture",
						workspaceId: "workspace-1",
						revision: Math.max(redactedState.sequence, 1),
					}),
				}),
			).resolves.toEqual([]);
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await processC?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses the host trusted clock instead of the caller-controlled receipt issue time", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-trusted-clock-real-"));
		let processA: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			let trustedNow = TRUSTED_NOW;
			const store = createKnowledgeStore({
				durableStore: processA.store,
				namespace: "knowledge",
				receiptContext: RECEIPT_CONTEXT,
				trustedNow: () => trustedNow,
				...hostValidators(),
			});
			const created = await store.commit(
				createKnowledgeRequest(
					processA.store,
					createProposal({ retention: { class: "session", expiresAt: "2026-08-16T15:31:00.000Z" } }),
					"knowledge:trusted-clock",
				),
			);
			const clock = clockReceipt({
				workflowId: WORKFLOW_ID,
				stateDigest: digestObject(created.state),
				query: "fixture",
				workspaceId: "workspace-1",
				revision: created.state.sequence,
			});
			await expect(
				store.recall({
					query: "fixture",
					workspaceId: "workspace-1",
					principal: TRUSTED_PRINCIPAL,
					trustedClockReceipt: clock,
				}),
			).resolves.toHaveLength(1);
			trustedNow = "2026-08-16T15:32:00.000Z";
			await expect(
				store.recall({
					query: "fixture",
					workspaceId: "workspace-1",
					principal: TRUSTED_PRINCIPAL,
					trustedClockReceipt: clock,
				}),
			).resolves.toEqual([]);
		} finally {
			await processA?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a one-use trusted clock receipt on its second recall after reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-one-use-clock-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const receiptContextA = createPersistedFixtureHostReceiptConsumerContext(root);
			const storeA = createPublicKnowledgeStore(processA.store, receiptContextA);
			await storeA.commit(createKnowledgeRequest(processA.store, createProposal(), "knowledge:one-use-clock"));
			const stateA = await storeA.read();
			const trustedClock = clockReceipt({
				workflowId: WORKFLOW_ID,
				stateDigest: digestObject(stateA),
				query: "fixture",
				workspaceId: "workspace-1",
				principal: TRUSTED_PRINCIPAL,
				revision: stateA.sequence,
				oneUse: true,
			});
			const recallInput = {
				query: "fixture",
				workspaceId: "workspace-1",
				principal: TRUSTED_PRINCIPAL,
				trustedClockReceipt: trustedClock,
			};
			await expect(storeA.recall(recallInput)).resolves.toHaveLength(1);
			await processA.host.dispose?.();
			processA = undefined;

			processB = await openProcess(root);
			const receiptContextB = createPersistedFixtureHostReceiptConsumerContext(root);
			const storeB = createPublicKnowledgeStore(processB.store, receiptContextB);
			await expect(storeB.recall(recallInput)).rejects.toThrow(/consum|one-use|replay/i);
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not project a canonical record after its source receipt is revoked", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-mempalace-revoked-real-"));
		let processA: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const receiptContext = createPersistedFixtureHostReceiptConsumerContext(root);
			const store = createPublicKnowledgeStore(processA.store, receiptContext);
			const committed = await store.commit(
				createKnowledgeRequest(processA.store, createProposal(), "knowledge:mempalace-revoked"),
			);
			(receiptContext.revokedReceiptIds as Set<string>).add(
				committed.record.evidenceRefs[0]!.validationReceipt.receiptId,
			);
			const indexed: KnowledgeRecord[] = [];
			const boundary = createKnowledgeMempalaceBoundary({
				store,
				index: {
					upsert: async (record) => {
						indexed.push(record);
					},
					search: async () => indexed,
					readFence: async () => null,
				},
				outbox: processA.store.mempalaceOutbox,
				now: () => TRUSTED_NOW,
			});
			await boundary.accept(committed.record);
			expect(indexed).toEqual([]);
		} finally {
			await processA?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires a host trusted clock before projecting to MemPalace", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-mempalace-clock-required-real-"));
		let processA: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const store = createPublicKnowledgeStore(processA.store);
			const committed = await commitPublic(processA.store, "knowledge:mempalace-clock-required");
			const indexed: KnowledgeRecord[] = [];
			const boundary = createKnowledgeMempalaceBoundary({
				store,
				index: {
					upsert: async (record) => {
						indexed.push(record);
					},
					search: async () => indexed,
					readFence: async () => null,
				},
				outbox: processA.store.mempalaceOutbox,
			});
			await boundary.accept(committed.event.record);
			expect(indexed).toEqual([]);
			expect((await boundary.health()).status).toBe("blocked");
		} finally {
			await processA?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects evidence whose artifact source sequence is not the authenticated receipt revision", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-source-sequence-real-"));
		let processA: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const store = createKnowledgeStore({
				durableStore: processA.store,
				namespace: "knowledge",
				receiptContext: RECEIPT_CONTEXT,
				trustedNow: () => TRUSTED_NOW,
				...hostValidators({ sourceEventSequence: 2 }),
			});
			await expect(
				store.commit(
					createKnowledgeRequest(processA.store, createProposal(), "knowledge:source-sequence-mismatch"),
				),
			).rejects.toThrow(/source.*sequence|artifact|receipt/i);
		} finally {
			await processA?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("recovers a canonical MemPalace outbox obligation after a process crash before boundary acceptance", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-mempalace-crash-before-accept-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const committed = await commitPublic(processA.store, "knowledge:mempalace-crash-before-accept");
			await processA.host.dispose?.();
			processA = undefined;
			processB = await openProcess(root);
			const pending = await processB.store.mempalaceOutbox!.pending();
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatchObject({
				recordId: committed.event.record.recordId,
				revision: committed.event.record.revision,
				fence: {
					knowledgeJournalSequence: committed.sequence,
					knowledgeJournalDigest: committed.authenticatedEventDigest,
				},
			});
			expect(pending[0]?.idempotencyKey).not.toContain(committed.event.record.statement);
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not repeat an index effect when acknowledgement is uncertain across process reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-mempalace-ack-uncertain-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const storeA = createPublicKnowledgeStore(processA.store);
			const committed = await commitPublic(processA.store, "knowledge:mempalace-ack-uncertain");
			const indexA = createPersistedProjectionIndex(root, processA.store);
			const baseOutbox = processA.store.mempalaceOutbox!;
			let failAcknowledgement = true;
			const uncertainOutbox = {
				append: (entry: KnowledgeMempalaceOutboxEntry) => baseOutbox.append(entry),
				pending: () => baseOutbox.pending(),
				acknowledge: async (idempotencyKey: string, fence: KnowledgeMempalaceFence) => {
					if (failAcknowledgement) {
						failAcknowledgement = false;
						throw new Error("acknowledgement outcome is uncertain");
					}
					await baseOutbox.acknowledge?.(idempotencyKey, fence);
				},
			};
			const boundaryA = createKnowledgeMempalaceBoundary({
				store: storeA,
				index: indexA.index,
				outbox: uncertainOutbox,
				now: () => TRUSTED_NOW,
			});
			await boundaryA.accept(committed.event.record);
			expect(indexA.upsertCount()).toBe(1);
			await processA.host.dispose?.();
			processA = undefined;

			processB = await openProcess(root);
			const indexB = createPersistedProjectionIndex(root, processB.store);
			const health = await createKnowledgeMempalaceBoundary({
				store: createPublicKnowledgeStore(processB.store),
				index: indexB.index,
				outbox: processB.store.mempalaceOutbox,
				now: () => TRUSTED_NOW,
			}).drain();
			expect(indexB.upsertCount()).toBe(0);
			expect(health.pending).toBe(0);
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("hides persisted knowledge when the current resolver revokes evidence or secret-scan receipts", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-revoked-receipt-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const receiptContextA = createPersistedFixtureHostReceiptConsumerContext(root);
			const created = await createPublicKnowledgeStore(processA.store, receiptContextA).commit(
				createKnowledgeRequest(processA.store, createProposal(), "knowledge:revoked-receipt"),
			);
			await processA.host.dispose?.();
			processA = undefined;
			processB = await openProcess(root);
			const receiptContextB = createPersistedFixtureHostReceiptConsumerContext(root);
			const store = createPublicKnowledgeStore(processB.store, receiptContextB);
			const state = await store.read();
			const recallInput = {
				query: "fixture",
				workspaceId: "workspace-1",
				principal: TRUSTED_PRINCIPAL,
				trustedClockReceipt: clockReceipt({
					workflowId: WORKFLOW_ID,
					stateDigest: digestObject(state),
					query: "fixture",
					workspaceId: "workspace-1",
					revision: state.sequence,
				}),
			};
			for (const receiptId of [
				created.record.evidenceRefs[0]!.validationReceipt.receiptId,
				created.record.privacy.secretScan.receiptId,
			]) {
				(receiptContextB.revokedReceiptIds as Set<string>).add(receiptId);
				await expect(store.recall(recallInput)).resolves.toEqual([]);
				(receiptContextB.revokedReceiptIds as Set<string>).delete(receiptId);
			}
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("revalidates source artifacts at recall and before MemPalace projection after reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-revoked-source-artifact-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const receiptContextA = createPersistedFixtureHostReceiptConsumerContext(root);
			const created = await createPublicKnowledgeStore(processA.store, receiptContextA).commit(
				createKnowledgeRequest(processA.store, createProposal(), "knowledge:revoked-source-artifact"),
			);
			await processA.host.dispose?.();
			processA = undefined;

			processB = await openProcess(root);
			const receiptContextB = createPersistedFixtureHostReceiptConsumerContext(root);
			const revokedArtifactId = created.record.evidenceRefs[0]!.artifactRefs[0]!.artifactId;
			const revokedSourceContext: WorkflowHostReceiptConsumerContext = {
				...receiptContextB,
				artifactResolver: {
					resolve: async (ref) => {
						if (ref.artifactId === revokedArtifactId) throw new Error("source artifact was revoked");
						return receiptContextB.artifactResolver.resolve(ref);
					},
				},
			};
			const store = createPublicKnowledgeStore(processB.store, revokedSourceContext);
			const state = await store.read();
			const recallInput = {
				query: "fixture",
				workspaceId: "workspace-1",
				principal: TRUSTED_PRINCIPAL,
				trustedClockReceipt: clockReceipt({
					workflowId: WORKFLOW_ID,
					stateDigest: digestObject(state),
					query: "fixture",
					workspaceId: "workspace-1",
					revision: state.sequence,
				}),
			};
			await expect(store.recall(recallInput)).resolves.toEqual([]);
			const indexed: KnowledgeRecord[] = [];
			const boundary = createKnowledgeMempalaceBoundary({
				store,
				index: {
					upsert: async (record) => {
						indexed.push(record);
					},
					search: async () => indexed,
					readFence: async () => null,
				},
				outbox: processB.store.mempalaceOutbox,
				now: () => TRUSTED_NOW,
			});
			await boundary.accept(created.record);
			expect(indexed).toEqual([]);
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("consumes one-use evidence receipts and requires a durable witness after reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-one-use-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const receiptContextA = createPersistedFixtureHostReceiptConsumerContext(root);
			const storeA = createKnowledgeStore({
				durableStore: processA.store,
				namespace: "knowledge",
				receiptContext: receiptContextA,
				trustedNow: () => TRUSTED_NOW,
				...hostValidators({ oneUse: true, receiptContext: receiptContextA }),
			});
			const committed = await storeA.commit(
				createKnowledgeRequest(processA.store, createProposal(), "knowledge:one-use"),
			);
			const persistedReceipts = [
				committed.record.evidenceRefs[0]!.validationReceipt,
				committed.record.privacy.secretScan,
			];
			for (const receipt of persistedReceipts) {
				expect(receipt.oneUse).toBe(true);
				expect(receipt.artifactRef.sourceEventSequence).toBe(receipt.revision);
				await expect(
					receiptContextA.receiptResolver.resolveConsumptionWitness({
						receiptId: receipt.receiptId,
						workflowId: WORKFLOW_ID,
						expectedBindingDigest: receipt.bindingDigest,
					}),
				).resolves.toMatchObject({ receiptId: receipt.receiptId, bindingDigest: receipt.bindingDigest });
			}
			await processA.host.dispose?.();
			processA = undefined;
			processB = await openProcess(root);
			const receiptContextB = createPersistedFixtureHostReceiptConsumerContext(root);
			const storeB = createKnowledgeStore({
				durableStore: processB.store,
				namespace: "knowledge",
				receiptContext: receiptContextB,
				trustedNow: () => TRUSTED_NOW,
				...hostValidators({ oneUse: true, receiptContext: receiptContextB }),
			});
			const state = await storeB.read();
			await expect(
				storeB.recall({
					query: "fixture",
					workspaceId: "workspace-1",
					principal: TRUSTED_PRINCIPAL,
					trustedClockReceipt: clockReceipt({
						workflowId: WORKFLOW_ID,
						stateDigest: digestObject(state),
						query: "fixture",
						workspaceId: "workspace-1",
						revision: state.sequence,
					}),
				}),
			).resolves.toHaveLength(1);
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rebuilds a corrupted durable MemPalace acknowledgement projection from canonical outbox work", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-mempalace-ack-rebuild-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		let processC: ProcessAuthority | undefined;
		let processD: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const committed = await commitPublic(processA.store, "knowledge:ack-rebuild");
			const entry: KnowledgeMempalaceOutboxEntry = {
				idempotencyKey: "mempalace:ack-rebuild",
				operation: "upsert",
				recordId: committed.event.record.recordId,
				revision: committed.event.record.revision,
				canonicalDigest: digestObject(committed.event.record),
				sourceDigest: committed.event.record.sourceDigest,
				tombstoneFingerprint: null,
				fence: {
					knowledgeStoreEpoch: EPOCH.storeEpoch,
					coordinatorEpoch: EPOCH.coordinatorEpoch,
					knowledgeJournalSequence: committed.sequence,
					knowledgeJournalDigest: committed.authenticatedEventDigest,
				},
				record: null,
			};
			await processA.store.mempalaceOutbox!.append(entry);
			await processA.store.mempalaceOutbox!.acknowledge!(entry.idempotencyKey, entry.fence);
			await writeFile(join(root, "workflows", WORKFLOW_ID, "knowledge-mempalace-acks.json"), "corrupt");
			await processA.host.dispose?.();
			processA = undefined;

			processB = await openProcess(root);
			await expect(processB.store.mempalaceOutbox!.pending()).resolves.toEqual([entry]);
			const indexed: KnowledgeRecord[] = [];
			let indexedFence: KnowledgeMempalaceFence | null = null;
			const boundary = createKnowledgeMempalaceBoundary({
				store: createPublicKnowledgeStore(processB.store),
				index: {
					upsert: async (record) => {
						indexed.push(record);
						indexedFence = entry.fence;
					},
					search: async () => indexed,
					readFence: async () => indexedFence,
				},
				outbox: processB.store.mempalaceOutbox,
				now: () => TRUSTED_NOW,
			});
			await expect(boundary.drain()).resolves.toMatchObject({ status: "healthy", pending: 0 });
			expect(indexed).toEqual([committed.event.record]);
			await processB.host.dispose?.();
			processB = undefined;
			processC = await openProcess(root);
			await expect(processC.store.mempalaceOutbox!.pending()).resolves.toEqual([]);
			await processC.host.dispose?.();
			processC = undefined;
			const staleAckFile = {
				version: 1 as const,
				workflowId: WORKFLOW_ID,
				generationId: "rotated-old-generation",
				epochRef: { storeEpoch: EPOCH.storeEpoch, coordinatorEpoch: EPOCH.coordinatorEpoch - 1 },
				acknowledged: [entry.idempotencyKey],
			};
			await writeFile(
				join(root, "workflows", WORKFLOW_ID, "knowledge-mempalace-acks.json"),
				canonicalJsonBytes({ ...staleAckFile, mac: digestObject(staleAckFile) }),
			);
			processD = await openProcess(root);
			await expect(processD.store.mempalaceOutbox!.pending()).resolves.toEqual([entry]);
			const disabledBoundary = createKnowledgeMempalaceBoundary({
				store: createPublicKnowledgeStore(processD.store),
				outbox: processD.store.mempalaceOutbox,
			});
			await expect(disabledBoundary.health()).resolves.toMatchObject({ status: "disabled", pending: 1 });
			let rebuiltFence: KnowledgeMempalaceFence | null = null;
			const rebuiltBoundary = createKnowledgeMempalaceBoundary({
				store: createPublicKnowledgeStore(processD.store),
				index: {
					upsert: async () => {
						rebuiltFence = entry.fence;
					},
					search: async () => [committed.event.record],
					readFence: async () => rebuiltFence,
				},
				outbox: processD.store.mempalaceOutbox,
				now: () => TRUSTED_NOW,
			});
			await expect(rebuiltBoundary.drain()).resolves.toMatchObject({ status: "healthy", pending: 0 });
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await processC?.host.dispose?.();
			await processD?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires an authenticated indexed projection and supersedes failed upserts after a later tombstone", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-mempalace-require-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const publicStoreA = createPublicKnowledgeStore(processA.store);
			const created = await publicStoreA.commit(
				createKnowledgeRequest(processA.store, createProposal(), "knowledge:require-create"),
			);
			const indexed: KnowledgeRecord[] = [];
			let indexedFence: KnowledgeMempalaceFence | null = null;
			let failUpsert = true;
			const index = {
				upsert: async (record: KnowledgeRecord) => {
					if (failUpsert) throw new Error("index unavailable");
					indexed.push(record);
					const authenticated = await processA!.store.readAuthenticatedCommit(
						record.commitRef.knowledgeJournalSequence,
					);
					if (authenticated === null) throw new Error("index fixture lost canonical receipt");
					indexedFence = {
						knowledgeStoreEpoch: record.commitRef.knowledgeStoreEpoch,
						coordinatorEpoch: record.commitRef.workflowEpochRef.coordinatorEpoch,
						knowledgeJournalSequence: record.commitRef.knowledgeJournalSequence,
						knowledgeJournalDigest: authenticated.eventDigest,
					};
				},
				delete: async (_recordId: string, fence?: KnowledgeMempalaceFence) => {
					indexedFence = fence ?? indexedFence;
				},
				search: async () => indexed,
				readFence: async () => indexedFence,
			};
			const requireRecallInput = {
				query: "fixture",
				workspaceId: "workspace-1",
				principal: TRUSTED_PRINCIPAL,
				trustedClockReceipt: clockReceipt({
					workflowId: WORKFLOW_ID,
					stateDigest: digestObject(await publicStoreA.read()),
					query: "fixture",
					workspaceId: "workspace-1",
					revision: created.state.sequence,
				}),
				route: "require" as const,
			};
			await expect(
				createKnowledgeMempalaceBoundary({ store: publicStoreA }).recall(requireRecallInput),
			).rejects.toThrow(/index|outbox|required/i);
			await expect(
				createKnowledgeMempalaceBoundary({ store: publicStoreA, index }).recall(requireRecallInput),
			).rejects.toThrow(/index|outbox|required/i);
			const publicStoreBoundary = createKnowledgeMempalaceBoundary({
				store: publicStoreA,
				index,
				outbox: processA.store.mempalaceOutbox,
			});
			await expect(
				publicStoreBoundary.recall({
					query: "fixture",
					workspaceId: "workspace-1",
					principal: TRUSTED_PRINCIPAL,
					trustedClockReceipt: clockReceipt({
						workflowId: WORKFLOW_ID,
						stateDigest: digestObject(await publicStoreA.read()),
						query: "fixture",
						workspaceId: "workspace-1",
						revision: created.state.sequence,
					}),
					route: "require",
				}),
			).rejects.toThrow(/required|degraded|fence|projection/i);
			await publicStoreBoundary.accept(created.record);
			await expect(
				publicStoreBoundary.recall({
					query: "fixture",
					workspaceId: "workspace-1",
					principal: TRUSTED_PRINCIPAL,
					trustedClockReceipt: clockReceipt({
						workflowId: WORKFLOW_ID,
						stateDigest: digestObject(await publicStoreA.read()),
						query: "fixture",
						workspaceId: "workspace-1",
						revision: created.state.sequence,
					}),
					route: "require",
				}),
			).rejects.toThrow(/required|degraded|fence|projection/i);

			failUpsert = false;
			await processA.host.dispose?.();
			processA = undefined;
			processB = await openProcess(root);
			const publicStoreB = createPublicKnowledgeStore(processB.store);
			const retracted = await publicStoreB.commit(
				createKnowledgeRequest(
					processB.store,
					createProposal({
						proposalId: "proposal:require-retract",
						action: "retract",
						expectedRevision: created.record.revision,
					}),
					"knowledge:require-retract",
					await processB.store.read(),
				),
			);
			const reopenedBoundary = createKnowledgeMempalaceBoundary({
				store: publicStoreB,
				index,
				outbox: processB.store.mempalaceOutbox,
			});
			await reopenedBoundary.accept(retracted.record);
			const health = await reopenedBoundary.drain();
			expect(health.pending).toBe(0);
			expect(health.status).toBe("healthy");
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("revalidates a pending upsert after restart and terminally acknowledges expired knowledge", async () => {
		const root = await mkdtemp(join(tmpdir(), "knowledge-mempalace-expiry-real-"));
		let processA: ProcessAuthority | undefined;
		let processB: ProcessAuthority | undefined;
		try {
			processA = await openProcess(root);
			const storeA = createPublicKnowledgeStore(processA.store);
			const created = await storeA.commit(
				createKnowledgeRequest(
					processA.store,
					createProposal({ retention: { class: "session", expiresAt: "2026-08-16T15:31:00.000Z" } }),
					"knowledge:expiry-create",
				),
			);
			let initialUpserts = 0;
			const initialIndex = {
				upsert: async () => {
					initialUpserts += 1;
					throw new Error("index unavailable");
				},
				search: async () => [],
				readFence: async () => null,
			};
			const boundaryA = createKnowledgeMempalaceBoundary({
				store: storeA,
				index: initialIndex,
				outbox: processA.store.mempalaceOutbox,
				now: () => TRUSTED_NOW,
			});
			await boundaryA.accept(created.record);
			expect(initialUpserts).toBe(1);
			expect(await processA.store.mempalaceOutbox!.pending()).toHaveLength(1);
			await processA.host.dispose?.();
			processA = undefined;

			processB = await openProcess(root);
			const storeB = createPublicKnowledgeStore(processB.store);
			let restartedUpserts = 0;
			const restartedIndex = {
				upsert: async () => {
					restartedUpserts += 1;
				},
				search: async () => [],
				readFence: async () => null,
			};
			const health = await createKnowledgeMempalaceBoundary({
				store: storeB,
				index: restartedIndex,
				outbox: processB.store.mempalaceOutbox,
				now: () => "2026-08-16T15:32:00.000Z",
			}).drain();
			expect(restartedUpserts).toBe(0);
			expect(health.pending).toBe(0);
			expect(health.status).toBe("blocked");
		} finally {
			await processA?.host.dispose?.();
			await processB?.host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});
});

async function openProcess(root: string): Promise<ProcessAuthority> {
	const host = await createPersistedSessionWorkflowHost({
		artifactRoot: root,
		rootSessionId: ROOT_SESSION_ID,
		workflowId: WORKFLOW_ID,
		goalProjection: createGoalProjection(),
		genesisEpoch: EPOCH,
		now: () => TRUSTED_NOW,
	});
	const store = createKnowledgeDurableStore({
		runtimeStore: host.runtimeStore,
		namespace: "knowledge",
		epochRef: EPOCH,
	});
	const context = host.runtimeStore.durableContext;
	if (context === undefined) throw new Error("Real workflow host did not expose its durable context.");
	return { host, runtimeStore: host.runtimeStore, context, store };
}

function createGoalProjection(): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	let state = emptyGoalState();
	return {
		read: () => structuredClone(state),
		compareAndSwap: (expected, next) => {
			if (digestObject(state) !== digestObject(expected)) return false;
			state = structuredClone(next);
			return true;
		},
	};
}

function createPublicKnowledgeStore(
	durableStore: KnowledgeDurableStore,
	receiptContext: WorkflowHostReceiptConsumerContext = RECEIPT_CONTEXT,
): KnowledgeStore {
	return createKnowledgeStore({
		durableStore,
		namespace: "knowledge",
		receiptContext,
		trustedNow: () => TRUSTED_NOW,
		...hostValidators({ receiptContext }),
	});
}

function createKnowledgeRequest(
	durableStore: KnowledgeDurableStore,
	proposalValue: KnowledgeProposal,
	idempotencyKey: string,
	current?: Awaited<ReturnType<KnowledgeDurableStore["read"]>>,
): KnowledgeCommitRequest {
	const state = current?.state ?? {
		namespace: "knowledge",
		records: {},
		history: [],
		sequence: 0,
		digest: null,
	};
	const leaseRef = durableStore.currentLeaseRef();
	return {
		proposal: proposalValue,
		mutationId: proposalValue.proposalId,
		idempotencyKey,
		expectedHead: {
			workflowId: durableStore.workflowId,
			sequence: current?.journalSequence ?? current?.sequence ?? 0,
			eventDigest: current?.journalDigest ?? current?.digest ?? null,
			epochRef: EPOCH,
		},
		baselineDigest: state.digest ?? digestObject(state),
		expectedGenerations: { [durableStore.generationId]: EPOCH.storeEpoch },
		writerIdentity: leaseRef.writerIdentity,
		leaseRef,
		epochRef: EPOCH,
		executionKey: idempotencyKey,
		knowledgeStoreEpoch: EPOCH.storeEpoch,
	};
}

async function commitPublic(
	durableStore: KnowledgeDurableStore,
	idempotencyKey: string,
): Promise<NonNullable<Awaited<ReturnType<KnowledgeStore["commit"]>>["durableResult"]>> {
	const current = await durableStore.read();
	const result = await createPublicKnowledgeStore(durableStore).commit(
		createKnowledgeRequest(durableStore, createProposal(), idempotencyKey, current),
	);
	if (result.durableResult === undefined) throw new Error("Real knowledge commit did not return durable evidence.");
	return result.durableResult;
}

async function createMutation(store: KnowledgeDurableStore): Promise<DurableStoreMutationRequest<KnowledgeEvent>> {
	const current = await store.read();
	const proposalValue = createProposal();
	const expectedHead: WorkflowJournalHead = {
		workflowId: store.workflowId,
		sequence: current.journalSequence ?? current.sequence,
		eventDigest: current.journalDigest ?? current.digest,
		epochRef: EPOCH,
	};
	const record: KnowledgeRecord = {
		...proposalValue,
		revision: 1,
		status: "active",
		contentDigest: knowledgeContentDigest(proposalValue),
		sourceDigest: knowledgeSourceDigest(proposalValue.evidenceRefs),
		commitRef: {
			knowledgeStoreId: store.storeId,
			workflowEpochRef: EPOCH,
			knowledgeStoreEpoch: EPOCH.storeEpoch,
			proposalId: proposalValue.proposalId,
			decisionRef: proposalValue.decisionRef,
			knowledgeJournalSequence: expectedHead.sequence + 1,
			knowledgeJournalDigest: digestObject({
				sequence: expectedHead.sequence + 1,
				storeId: store.storeId,
				transactionDigest: "transaction-digest",
			}),
			transactionDigest: "transaction-digest",
		},
		createdAt: TRUSTED_NOW,
		updatedAt: TRUSTED_NOW,
	};
	const semantic: KnowledgeEvent = {
		kind: "knowledge_record_committed",
		idempotencyKey: "knowledge:proposal-1",
		record,
		previous: null,
		previousDigest: null,
		proposalDigest: digestObject(proposalValue),
	};
	return {
		mutationId: semantic.idempotencyKey,
		semantic,
		idempotencyKey: semantic.idempotencyKey,
		expectedHead,
		baselineDigest: digestObject(current.state),
		expectedGenerations: { [store.generationId]: EPOCH.storeEpoch },
		writerIdentity: store.currentLeaseRef().writerIdentity,
		leaseRef: store.currentLeaseRef(),
		epochRef: EPOCH,
		executionKey: "knowledge-execution-1",
	};
}

async function appendUnrelatedWorkflowEvent(authority: ProcessAuthority): Promise<void> {
	const runtimeStore = authority.runtimeStore;
	const context = authority.context;
	const current = await authority.store.read();
	const expectedHead: WorkflowJournalHead = {
		workflowId: runtimeStore.identity.workflowId,
		sequence: current.journalSequence ?? current.sequence,
		eventDigest: current.journalDigest ?? current.digest,
		epochRef: EPOCH,
	};
	const idempotencyKey = "workflow-unrelated-event";
	const semanticBinding: WorkflowSemanticMutationBinding = {
		mutationId: idempotencyKey,
		baselineDigest: digestObject(expectedHead),
		expectedGenerations: { [context.generationId]: EPOCH.storeEpoch },
		ownerId: "knowledge-mixed-workflow-test",
		phase: "recovering",
		reducerDigest: digestObject("knowledge-mixed-workflow-test"),
		semanticHead: {
			...expectedHead,
			stateDigest: digestObject(expectedHead),
			generation: EPOCH.storeEpoch,
		},
		expectedHead,
		idempotencyKey,
		executionKey: null,
		writerIdentity: context.currentLeaseRef().writerIdentity,
		leaseRef: context.currentLeaseRef(),
		epochRef: EPOCH,
	};
	await runtimeStore.commit({
		workflowId: runtimeStore.identity.workflowId,
		payload: {
			kind: "workflow_started",
			workflowId: runtimeStore.identity.workflowId,
			rootSessionId: ROOT_SESSION_ID,
			objective: "unrelated workflow event",
		},
		expectedHead,
		semanticBinding,
		epochRef: EPOCH,
		leaseRef: context.currentLeaseRef(),
		idempotencyKey,
		writerIdentity: context.currentLeaseRef().writerIdentity,
		executionKey: null,
	});
}

async function appendWorkflowMetadataEvent(authority: ProcessAuthority, idempotencyKey: string): Promise<void> {
	const runtimeStore = authority.runtimeStore;
	const context = authority.context;
	const current = await authority.store.read();
	const expectedHead: WorkflowJournalHead = {
		workflowId: runtimeStore.identity.workflowId,
		sequence: current.journalSequence ?? current.sequence,
		eventDigest: current.journalDigest ?? current.digest,
		epochRef: EPOCH,
	};
	const leaseRef = context.currentLeaseRef();
	const semanticBinding: WorkflowSemanticMutationBinding = {
		mutationId: idempotencyKey,
		baselineDigest: digestObject(expectedHead),
		expectedGenerations: { [context.generationId]: EPOCH.storeEpoch },
		ownerId: "knowledge-mixed-workflow-test",
		phase: "recovering",
		reducerDigest: digestObject("knowledge-mixed-workflow-metadata"),
		semanticHead: {
			...expectedHead,
			stateDigest: digestObject(expectedHead),
			generation: EPOCH.storeEpoch,
		},
		expectedHead,
		idempotencyKey,
		executionKey: null,
		writerIdentity: leaseRef.writerIdentity,
		leaseRef,
		epochRef: EPOCH,
	};
	await runtimeStore.commit({
		workflowId: runtimeStore.identity.workflowId,
		payload: { kind: "continuity_capsule_published", capsuleDigest: digestObject(idempotencyKey) },
		expectedHead,
		semanticBinding,
		epochRef: EPOCH,
		leaseRef,
		idempotencyKey,
		writerIdentity: leaseRef.writerIdentity,
		executionKey: null,
	});
}

function createProposal(overrides: Partial<KnowledgeProposal> = {}): KnowledgeProposal {
	const decisionRef: DurableDecisionRef = {
		decisionScope: { kind: "knowledge", namespace: "knowledge" },
		decisionId: "decision-1",
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		decisionDigest: "decision-digest",
	};
	const sourceArtifact = artifact("evidence-1");
	return {
		...proposal({
			proposalId: "proposal-1",
			recordId: "record-1",
			decisionRef,
			privacy: { class: "public", secretScan: hostReceipt("secret-scan-1", { workflowId: WORKFLOW_ID }) },
			evidenceRefs: [
				{
					workflowId: WORKFLOW_ID,
					envelopeId: "evidence-1",
					envelopeDigest: "evidence-envelope-digest",
					evidenceRevision: 1,
					artifactRefs: [sourceArtifact],
					validationReceipt: hostReceipt("evidence-receipt-1", { workflowId: WORKFLOW_ID }),
				},
			],
			...overrides,
		}),
	};
}

function parsePersistedProjection(value: unknown): { record: KnowledgeRecord; fence: KnowledgeMempalaceFence } {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Persisted MemPalace fixture is not a bounded object.");
	const parsed = value as Record<string, unknown>;
	if (
		Object.keys(parsed).some((key) => key !== "record" && key !== "fence") ||
		parsed.record === null ||
		typeof parsed.record !== "object" ||
		Array.isArray(parsed.record) ||
		parsed.fence === null ||
		typeof parsed.fence !== "object" ||
		Array.isArray(parsed.fence)
	)
		throw new Error("Persisted MemPalace fixture has an invalid record or fence.");
	const record = validateKnowledgeRecord(parsed.record as KnowledgeRecord);
	const fenceValue = parsed.fence as Record<string, unknown>;
	if (
		Object.keys(fenceValue).some(
			(key) =>
				!["knowledgeStoreEpoch", "coordinatorEpoch", "knowledgeJournalSequence", "knowledgeJournalDigest"].includes(
					key,
				),
		) ||
		typeof fenceValue.knowledgeStoreEpoch !== "number" ||
		!Number.isSafeInteger(fenceValue.knowledgeStoreEpoch) ||
		fenceValue.knowledgeStoreEpoch < 0 ||
		typeof fenceValue.coordinatorEpoch !== "number" ||
		!Number.isSafeInteger(fenceValue.coordinatorEpoch) ||
		fenceValue.coordinatorEpoch < 0 ||
		typeof fenceValue.knowledgeJournalSequence !== "number" ||
		!Number.isSafeInteger(fenceValue.knowledgeJournalSequence) ||
		fenceValue.knowledgeJournalSequence < 1 ||
		typeof fenceValue.knowledgeJournalDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(fenceValue.knowledgeJournalDigest)
	)
		throw new Error("Persisted MemPalace fixture fence is invalid.");
	return {
		record,
		fence: {
			knowledgeStoreEpoch: fenceValue.knowledgeStoreEpoch,
			coordinatorEpoch: fenceValue.coordinatorEpoch,
			knowledgeJournalSequence: fenceValue.knowledgeJournalSequence,
			knowledgeJournalDigest: fenceValue.knowledgeJournalDigest,
		},
	};
}

function createPersistedProjectionIndex(
	root: string,
	store: KnowledgeDurableStore,
): {
	index: {
		upsert(record: KnowledgeRecord): Promise<void>;
		search(): Promise<readonly KnowledgeRecord[]>;
		readFence(): Promise<KnowledgeMempalaceFence | null>;
	};
	upsertCount(): number;
} {
	const path = join(root, "knowledge-mempalace-index.json");
	let writes = 0;
	const readProjection = async (): Promise<{ record: KnowledgeRecord; fence: KnowledgeMempalaceFence } | null> => {
		let bytes: Uint8Array;
		try {
			bytes = await readFile(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		}
		return parsePersistedProjection(parseCanonicalJsonBytes(bytes));
	};
	const index = {
		upsert: async (record: KnowledgeRecord): Promise<void> => {
			const authenticated = await store.readAuthenticatedCommit(record.commitRef.knowledgeJournalSequence);
			if (authenticated === null) throw new Error("Persisted MemPalace fixture lost its source commit.");
			const fence: KnowledgeMempalaceFence = {
				knowledgeStoreEpoch: record.commitRef.knowledgeStoreEpoch,
				coordinatorEpoch: record.commitRef.workflowEpochRef.coordinatorEpoch,
				knowledgeJournalSequence: record.commitRef.knowledgeJournalSequence,
				knowledgeJournalDigest: authenticated.eventDigest,
			};
			await writeFile(path, canonicalJsonBytes({ record, fence }));
			writes += 1;
		},
		search: async (): Promise<readonly KnowledgeRecord[]> => {
			const projection = await readProjection();
			return projection === null ? [] : [projection.record];
		},
		readFence: async (): Promise<KnowledgeMempalaceFence | null> => (await readProjection())?.fence ?? null,
	};
	return { index, upsertCount: () => writes };
}
