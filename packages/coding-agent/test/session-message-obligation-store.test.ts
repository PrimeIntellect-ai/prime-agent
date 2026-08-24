import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createSessionMessageObligationStore,
	type SessionMessageObligationFence,
	type SessionMessageObligationStore,
	type SessionMessageObligationStoreOptions,
	sessionMessageContentDigest,
} from "../src/core/session-message-obligation-store.js";

async function makeStoreRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "session-message-obligations-"));
}

async function closeStore(store: SessionMessageObligationStore | undefined, root: string): Promise<void> {
	await store?.close();
	await rm(root, { recursive: true, force: true });
}

const FENCE_ONE = { processGeneration: "generation-1", fencingEpoch: 1 } as const;
const FENCE_TWO = { processGeneration: "generation-2", fencingEpoch: 2 } as const;

function singleMessage(messageId: string, content = `content-${messageId}`) {
	return {
		messageId,
		observationId: `observation-${messageId}`,
		content,
		contentDigest: sessionMessageContentDigest(content),
		recipients: [
			{ deliveryId: `delivery-${messageId}`, recipient: `session-${messageId}`, lane: "steering" as const },
		],
	};
}

async function reopen(
	root: string,
	fence: SessionMessageObligationFence = FENCE_ONE,
	options: Partial<Omit<SessionMessageObligationStoreOptions, "rootDir" | "fence">> = {},
): Promise<SessionMessageObligationStore> {
	return createSessionMessageObligationStore({ rootDir: root, fence, ...options });
}

describe("session message obligation store", () => {
	it("durably accepts immutable fanout obligations and reconstructs them after reopen", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({
				rootDir: root,
				fence: { processGeneration: "generation-1", fencingEpoch: 1 },
			});
			const accepted = await store.accept({
				messageId: "message-1",
				observationId: "observation-1",
				content: "immutable content",
				contentDigest: sessionMessageContentDigest("immutable content"),
				recipients: [
					{ deliveryId: "delivery-a", recipient: "session-a", lane: "steering" },
					{ deliveryId: "delivery-b", recipient: "session-b", lane: "followUp" },
				],
			});

			expect(accepted.status).toBe("accepted");
			await store.close();
			store = createSessionMessageObligationStore({
				rootDir: root,
				fence: { processGeneration: "generation-1", fencingEpoch: 1 },
			});
			expect(await store.recoverPending()).toHaveLength(2);
			expect((await store.getMessage("message-1"))?.content).toBe("immutable content");
		} finally {
			await closeStore(store, root);
		}
	});

	it("does not accept before the durable commit and preserves acceptance after a post-commit crash", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await expect(
				store.accept({
					...singleMessage("before-crash"),
					crashHook: {
						beforeDurableCommit: () => {
							throw new Error("crash-before-commit");
						},
					},
				}),
			).rejects.toThrow("crash-before-commit");
			await store.close();
			store = await reopen(root);
			expect(await store.recoverPending()).toEqual([]);

			await expect(
				store.accept({
					...singleMessage("after-crash"),
					crashHook: {
						afterDurableCommit: () => {
							throw new Error("crash-after-commit");
						},
					},
				}),
			).rejects.toThrow("crash-after-commit");
			await store.close();
			store = await reopen(root);
			expect((await store.recoverPending()).map((record) => record.deliveryId)).toEqual(["delivery-after-crash"]);
			expect((await store.accept(singleMessage("after-crash"))).status).toBe("idempotent");
		} finally {
			await closeStore(store, root);
		}
	});

	it("keeps context delivery pending until the processed acknowledgement survives restart", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("context-crash"));
			await store.claimWake({ deliveryId: "delivery-context-crash", ownerId: "worker-1" });
			await store.claimContextDelivery({
				deliveryId: "delivery-context-crash",
				ownerId: "worker-1",
				claimId: "claim-1",
			});
			await expect(
				store.markContextDelivered({
					deliveryId: "delivery-context-crash",
					ownerId: "worker-1",
					claimId: "claim-1",
					crashHook: {
						afterDurableCommit: () => {
							throw new Error("crash-after-context");
						},
					},
				}),
			).rejects.toThrow("crash-after-context");
			await store.close();
			store = await reopen(root);
			const recovered = await store.getObligation("delivery-context-crash");
			expect(recovered?.contextDelivery.status).toBe("delivered");
			expect(recovered?.outcome).toBe("pending");
			expect(
				(await store.markProcessed({ deliveryId: "delivery-context-crash", ownerId: "worker-1" })).outcome,
			).toBe("processed");
		} finally {
			await closeStore(store, root);
		}
	});

	it("requires a store-issued one-use owner continuity handoff for historical settlement", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		let successor: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("handoff"));
			await store.claimWake({ deliveryId: "delivery-handoff", ownerId: "historical-worker" });
			await store.claimContextDelivery({
				deliveryId: "delivery-handoff",
				ownerId: "historical-worker",
				claimId: "handoff-claim",
			});
			await store.markContextDelivered({
				deliveryId: "delivery-handoff",
				ownerId: "historical-worker",
				claimId: "handoff-claim",
			});

			const handoff = await store.issueOwnerContinuityHandoff({
				deliveryId: "delivery-handoff",
				ownerId: "historical-worker",
				claimId: "handoff-claim",
				successorOwnerId: "successor-worker",
				successorFence: FENCE_TWO,
			});
			expect(handoff).toMatchObject({
				deliveryId: "delivery-handoff",
				claimId: "handoff-claim",
				predecessorOwnerId: "historical-worker",
				predecessorFence: FENCE_ONE,
				successorOwnerId: "successor-worker",
				successorFence: FENCE_TWO,
			});
			await expect(
				store.markProcessed({
					deliveryId: "delivery-handoff",
					ownerId: "historical-worker",
					claimId: "handoff-claim",
				}),
			).rejects.toMatchObject({ code: "owner_continuity_required" });

			await store.rotateGeneration({ nextFence: FENCE_TWO });
			await store.close();
			successor = await reopen(root, FENCE_TWO);
			await expect(
				successor.consumeOwnerContinuityHandoff({
					handoff: { ...handoff, credential: "self-authored" },
					ownerId: "successor-worker",
				}),
			).rejects.toMatchObject({ code: "owner_continuity_invalid" });
			const settlement = await successor.consumeOwnerContinuityHandoff({ handoff, ownerId: "successor-worker" });
			expect(
				(
					await successor.markProcessed({
						deliveryId: "delivery-handoff",
						ownerId: "successor-worker",
						ownerContinuitySettlement: settlement,
					})
				).outcome,
			).toBe("processed");
			await expect(
				successor.consumeOwnerContinuityHandoff({ handoff, ownerId: "successor-worker" }),
			).rejects.toMatchObject({
				code: "owner_continuity_used",
			});
		} finally {
			await store?.close();
			await successor?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reconstructs an issued and consumed handoff across durable crashes", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		let successor: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("handoff-crash"));
			await store.claimWake({ deliveryId: "delivery-handoff-crash", ownerId: "historical-worker" });
			await store.claimContextDelivery({
				deliveryId: "delivery-handoff-crash",
				ownerId: "historical-worker",
				claimId: "handoff-crash-claim",
			});
			await store.markContextDelivered({
				deliveryId: "delivery-handoff-crash",
				ownerId: "historical-worker",
				claimId: "handoff-crash-claim",
			});
			const issueInput = {
				deliveryId: "delivery-handoff-crash",
				ownerId: "historical-worker",
				claimId: "handoff-crash-claim",
				successorOwnerId: "successor-worker",
				successorFence: FENCE_TWO,
			};
			await expect(
				store.issueOwnerContinuityHandoff({
					...issueInput,
					crashHook: {
						afterDurableCommit: () => {
							throw new Error("crash-after-handoff");
						},
					},
				}),
			).rejects.toThrow("crash-after-handoff");
			await store.close();
			store = await reopen(root);
			const handoff = await store.issueOwnerContinuityHandoff(issueInput);
			await store.rotateGeneration({ nextFence: FENCE_TWO });
			await store.close();
			successor = await reopen(root, FENCE_TWO);
			await expect(
				successor.consumeOwnerContinuityHandoff({
					handoff,
					ownerId: "successor-worker",
					crashHook: {
						afterDurableCommit: () => {
							throw new Error("crash-after-consume");
						},
					},
				}),
			).rejects.toThrow("crash-after-consume");
			await successor.close();
			successor = await reopen(root, FENCE_TWO);
			expect((await successor.getOwnerContinuityHandoff(handoff))?.consumed).toBe(true);
			const freshHandoff = await successor.reissueOwnerContinuityHandoff({
				consumedHandoff: handoff,
				successorOwnerId: "successor-worker",
				successorFence: FENCE_TWO,
			});
			const settlement = await successor.consumeOwnerContinuityHandoff({
				handoff: freshHandoff,
				ownerId: "successor-worker",
			});
			expect(
				(
					await successor.markProcessed({
						deliveryId: "delivery-handoff-crash",
						ownerId: "successor-worker",
						ownerContinuitySettlement: settlement,
					})
				).outcome,
			).toBe("processed");
		} finally {
			await store?.close();
			await successor?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("resumes only the fresh handoff after a reissue crash while retaining consumed audit history", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		let successor: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("handoff-reissue-restart"));
			await store.claimWake({ deliveryId: "delivery-handoff-reissue-restart", ownerId: "historical-worker" });
			await store.claimContextDelivery({
				deliveryId: "delivery-handoff-reissue-restart",
				ownerId: "historical-worker",
				claimId: "handoff-reissue-restart-claim",
			});
			await store.markContextDelivered({
				deliveryId: "delivery-handoff-reissue-restart",
				ownerId: "historical-worker",
				claimId: "handoff-reissue-restart-claim",
			});
			const handoff = await store.issueOwnerContinuityHandoff({
				deliveryId: "delivery-handoff-reissue-restart",
				ownerId: "historical-worker",
				claimId: "handoff-reissue-restart-claim",
				successorOwnerId: "successor-worker",
				successorFence: FENCE_TWO,
			});
			await store.rotateGeneration({ nextFence: FENCE_TWO });
			await store.close();
			store = undefined;

			successor = await reopen(root, FENCE_TWO);
			await expect(
				successor.consumeOwnerContinuityHandoff({
					handoff,
					ownerId: "successor-worker",
					crashHook: {
						afterDurableCommit: () => {
							throw new Error("crash-after-first-consume");
						},
					},
				}),
			).rejects.toThrow("crash-after-first-consume");
			await successor.close();
			successor = await reopen(root, FENCE_TWO);

			await expect(
				successor.reissueOwnerContinuityHandoff({
					consumedHandoff: handoff,
					successorOwnerId: "successor-worker",
					successorFence: FENCE_TWO,
					crashHook: {
						afterDurableCommit: () => {
							throw new Error("crash-after-reissue");
						},
					},
				}),
			).rejects.toThrow("crash-after-reissue");
			await successor.close();
			successor = await reopen(root, FENCE_TWO);
			const freshHandoff = await successor.reissueOwnerContinuityHandoff({
				consumedHandoff: handoff,
				successorOwnerId: "successor-worker",
				successorFence: FENCE_TWO,
			});
			expect(freshHandoff.credential).not.toBe(handoff.credential);
			expect(await successor.hasPendingOwnerContinuityHandoff()).toBe(true);

			await expect(
				successor.prepareBridgeFence({
					nextFence: FENCE_TWO,
					ownerId: "successor-worker",
					ownerContinuityHandoff: handoff,
				}),
			).rejects.toMatchObject({ code: "owner_continuity_used" });
			expect((await successor.read()).currentFence).toEqual(FENCE_TWO);
			expect(
				await successor.prepareBridgeFence({
					nextFence: FENCE_TWO,
					ownerId: "successor-worker",
					ownerContinuityHandoff: freshHandoff,
				}),
			).toEqual(FENCE_TWO);
			const settlement = await successor.consumeOwnerContinuityHandoff({
				handoff: freshHandoff,
				ownerId: "successor-worker",
			});
			await expect(
				successor.consumeOwnerContinuityHandoff({
					handoff: freshHandoff,
					ownerId: "successor-worker",
				}),
			).rejects.toMatchObject({ code: "owner_continuity_used" });
			expect(
				(
					await successor.markProcessed({
						deliveryId: "delivery-handoff-reissue-restart",
						ownerId: "successor-worker",
						ownerContinuitySettlement: settlement,
					})
				).outcome,
			).toBe("processed");
			expect(await successor.hasPendingOwnerContinuityHandoff()).toBe(false);
		} finally {
			await store?.close();
			await successor?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires an advancing successor process generation for handoff and rotation", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("handoff-generation"));
			await store.claimWake({ deliveryId: "delivery-handoff-generation", ownerId: "historical-worker" });
			await store.claimContextDelivery({
				deliveryId: "delivery-handoff-generation",
				ownerId: "historical-worker",
				claimId: "handoff-generation-claim",
			});
			await store.markContextDelivered({
				deliveryId: "delivery-handoff-generation",
				ownerId: "historical-worker",
				claimId: "handoff-generation-claim",
			});
			await expect(
				store.issueOwnerContinuityHandoff({
					deliveryId: "delivery-handoff-generation",
					ownerId: "historical-worker",
					successorOwnerId: "successor-worker",
					successorFence: { processGeneration: FENCE_ONE.processGeneration, fencingEpoch: 2 },
				}),
			).rejects.toMatchObject({ code: "stale_generation" });
			await expect(
				store.rotateGeneration({
					nextFence: { processGeneration: FENCE_ONE.processGeneration, fencingEpoch: 2 },
				}),
			).rejects.toMatchObject({ code: "stale_generation" });
		} finally {
			await closeStore(store, root);
		}
	});

	it("tombstones a consumed handoff when settlement fails and requires a fresh credential", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		let successor: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("handoff-tombstone"));
			await store.claimWake({ deliveryId: "delivery-handoff-tombstone", ownerId: "historical-worker" });
			await store.claimContextDelivery({
				deliveryId: "delivery-handoff-tombstone",
				ownerId: "historical-worker",
				claimId: "handoff-tombstone-claim",
			});
			await store.markContextDelivered({
				deliveryId: "delivery-handoff-tombstone",
				ownerId: "historical-worker",
				claimId: "handoff-tombstone-claim",
			});
			const handoff = await store.issueOwnerContinuityHandoff({
				deliveryId: "delivery-handoff-tombstone",
				ownerId: "historical-worker",
				claimId: "handoff-tombstone-claim",
				successorOwnerId: "successor-worker",
				successorFence: FENCE_TWO,
			});
			await store.rotateGeneration({ nextFence: FENCE_TWO });
			await store.close();
			successor = await reopen(root, FENCE_TWO);
			const settlement = await successor.consumeOwnerContinuityHandoff({
				handoff,
				ownerId: "successor-worker",
			});
			await expect(
				successor.markProcessed({
					deliveryId: "delivery-handoff-tombstone",
					ownerId: "successor-worker",
					ownerContinuitySettlement: settlement,
					crashHook: {
						beforeDurableCommit: () => {
							throw new Error("settlement-rejected");
						},
					},
				}),
			).rejects.toThrow("settlement-rejected");
			await expect(
				successor.markProcessed({
					deliveryId: "delivery-handoff-tombstone",
					ownerId: "successor-worker",
					ownerContinuitySettlement: settlement,
				}),
			).rejects.toMatchObject({ code: "owner_continuity_required" });
			await expect(
				successor.reissueOwnerContinuityHandoff({
					consumedHandoff: { ...handoff, credential: "self-authored" },
					successorOwnerId: "successor-worker",
					successorFence: FENCE_TWO,
				}),
			).rejects.toMatchObject({ code: "owner_continuity_required" });
			const freshHandoff = await successor.reissueOwnerContinuityHandoff({
				consumedHandoff: handoff,
				successorOwnerId: "successor-worker",
				successorFence: FENCE_TWO,
			});
			expect(freshHandoff.credential).not.toBe(handoff.credential);
			const freshSettlement = await successor.consumeOwnerContinuityHandoff({
				handoff: freshHandoff,
				ownerId: "successor-worker",
			});
			expect(
				(
					await successor.markProcessed({
						deliveryId: "delivery-handoff-tombstone",
						ownerId: "successor-worker",
						ownerContinuitySettlement: freshSettlement,
					})
				).outcome,
			).toBe("processed");
		} finally {
			await store?.close();
			await successor?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not reuse a consumed handoff after failure retry and a new context claim", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		let successor: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("handoff-retry"));
			await store.claimWake({ deliveryId: "delivery-handoff-retry", ownerId: "historical-worker" });
			await store.claimContextDelivery({
				deliveryId: "delivery-handoff-retry",
				ownerId: "historical-worker",
				claimId: "handoff-retry-claim",
			});
			await store.markContextDelivered({
				deliveryId: "delivery-handoff-retry",
				ownerId: "historical-worker",
				claimId: "handoff-retry-claim",
			});
			const handoff = await store.issueOwnerContinuityHandoff({
				deliveryId: "delivery-handoff-retry",
				ownerId: "historical-worker",
				claimId: "handoff-retry-claim",
				successorOwnerId: "successor-worker",
				successorFence: FENCE_TWO,
			});
			await store.rotateGeneration({ nextFence: FENCE_TWO });
			await store.close();
			successor = await reopen(root, FENCE_TWO);
			await successor.claimWake({ deliveryId: "delivery-handoff-retry", ownerId: "successor-worker" });
			const settlement = await successor.consumeOwnerContinuityHandoff({
				handoff,
				ownerId: "successor-worker",
			});
			await successor.markFailure({
				deliveryId: "delivery-handoff-retry",
				ownerId: "successor-worker",
				ownerContinuitySettlement: settlement,
			});
			await successor.retry({ deliveryId: "delivery-handoff-retry", ownerId: "successor-worker" });
			await successor.claimWake({ deliveryId: "delivery-handoff-retry", ownerId: "new-worker" });
			await successor.claimContextDelivery({
				deliveryId: "delivery-handoff-retry",
				ownerId: "new-worker",
				claimId: "new-context-claim",
			});
			await successor.markContextDelivered({
				deliveryId: "delivery-handoff-retry",
				ownerId: "new-worker",
				claimId: "new-context-claim",
			});
			await expect(
				successor.consumeOwnerContinuityHandoff({ handoff, ownerId: "successor-worker" }),
			).rejects.toMatchObject({ code: "owner_continuity_used" });
			await expect(
				successor.markProcessed({
					deliveryId: "delivery-handoff-retry",
					ownerId: "new-worker",
					ownerContinuitySettlement: settlement,
				}),
			).rejects.toMatchObject({ code: "owner_continuity_invalid" });
		} finally {
			await store?.close();
			await successor?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("recovers fanout recipients independently and retains terminal history", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept({
				...singleMessage("fanout", "fanout-content"),
				recipients: [
					{ deliveryId: "fanout-a", recipient: "session-a", lane: "steering" },
					{ deliveryId: "fanout-b", recipient: "session-b", lane: "followUp" },
					{ deliveryId: "fanout-c", recipient: "session-c", lane: "steering" },
				],
			});
			await store.claimWake({ deliveryId: "fanout-a", ownerId: "worker-a" });
			await store.claimContextDelivery({ deliveryId: "fanout-a", ownerId: "worker-a", claimId: "claim-a" });
			await store.markContextDelivered({ deliveryId: "fanout-a", ownerId: "worker-a", claimId: "claim-a" });
			await store.markProcessed({ deliveryId: "fanout-a", ownerId: "worker-a" });
			await store.close();
			store = await reopen(root);
			expect((await store.recoverPending()).map((record) => record.deliveryId)).toEqual(["fanout-b", "fanout-c"]);
			expect((await store.listAll()).map((record) => record.outcome)).toEqual(["processed", "pending", "pending"]);
		} finally {
			await closeStore(store, root);
		}
	});

	it("enforces digest idempotency and rejects integrity conflicts", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("digest"));
			expect((await store.accept(singleMessage("digest"))).status).toBe("idempotent");
			await expect(
				store.accept({
					...singleMessage("digest"),
					content: "changed",
					contentDigest: sessionMessageContentDigest("changed"),
				}),
			).rejects.toMatchObject({ code: "integrity_conflict" });
		} finally {
			await closeStore(store, root);
		}
	});

	it("rejects stale generations and fences every mutation", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		let successor: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("stale"));
			await store.rotateGeneration({ nextFence: FENCE_TWO });
			await expect(store.claimWake({ deliveryId: "delivery-stale", ownerId: "old-worker" })).rejects.toMatchObject({
				code: "stale_generation",
			});
			successor = await reopen(root, FENCE_TWO);
			expect(
				(await successor.claimWake({ deliveryId: "delivery-stale", ownerId: "new-worker" })).fence.fencingEpoch,
			).toBe(1);
		} finally {
			await store?.close();
			await successor?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects capacity exhaustion explicitly before acceptance and bounds fanout", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({
				rootDir: root,
				fence: FENCE_ONE,
				capacity: { maxItems: 1, maxFanout: 1, maxBytes: 4 },
			});
			expect((await store.accept(singleMessage("one", "1234"))).status).toBe("accepted");
			expect((await store.accept(singleMessage("two", "5678"))).reason).toBe("capacity_items");
			expect(
				(
					await store.accept({
						...singleMessage("fanout"),
						recipients: [
							{ recipient: "a", lane: "steering" },
							{ recipient: "b", lane: "steering" },
						],
					})
				).reason,
			).toBe("capacity_fanout");
			await store.claimWake({ deliveryId: "delivery-one", ownerId: "capacity-worker" });
			await store.cancel({ deliveryId: "delivery-one", ownerId: "capacity-worker" });
			expect((await store.accept({ ...singleMessage("bytes", "12345") })).reason).toBe("capacity_bytes");
			expect(await store.getMessage("two")).toBeUndefined();
		} finally {
			await closeStore(store, root);
		}
	});

	it("paces recovery with a finite cursor and deduplicates each delivery", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			for (const id of ["a", "b", "c", "d", "e"]) await store.accept(singleMessage(id));
			const first = await store.recoverPending({ limit: 2 });
			const second = await store.recoverPending({
				limit: 2,
				after:
					first[1] === undefined
						? undefined
						: { acceptedSequence: first[1].acceptedSequence, deliveryId: first[1].deliveryId },
			});
			expect(first).toHaveLength(2);
			expect(second).toHaveLength(2);
			expect(new Set([...first, ...second].map((record) => record.deliveryId)).size).toBe(4);
			expect(
				await store.recoverPending({
					limit: 1,
					after:
						second[1] === undefined
							? undefined
							: { acceptedSequence: second[1].acceptedSequence, deliveryId: second[1].deliveryId },
				}),
			).toHaveLength(1);
		} finally {
			await closeStore(store, root);
		}
	});

	it("keeps retry capacity and transition ordering explicit", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({
				rootDir: root,
				fence: FENCE_ONE,
				capacity: { maxRetries: 0 },
			});
			await store.accept(singleMessage("retry"));
			await expect(store.markProcessed({ deliveryId: "delivery-retry" })).rejects.toMatchObject({
				code: "wake_owned",
			});
			await store.claimWake({ deliveryId: "delivery-retry", ownerId: "retry-worker" });
			await expect(
				store.markProcessed({ deliveryId: "delivery-retry", ownerId: "retry-worker" }),
			).rejects.toMatchObject({
				code: "context_not_delivered",
			});
			await store.markFailure({ deliveryId: "delivery-retry", ownerId: "retry-worker", reason: "temporary" });
			await expect(store.retry({ deliveryId: "delivery-retry", ownerId: "retry-worker" })).rejects.toMatchObject({
				code: "capacity_retries",
			});
			await expect(
				store.markProcessed({ deliveryId: "delivery-retry", ownerId: "retry-worker" }),
			).rejects.toMatchObject({ code: "invalid_transition" });
		} finally {
			await closeStore(store, root);
		}
	});

	it("converges after restart without exposing transport state", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("converge-a"));
			await store.accept(singleMessage("converge-b"));
			await store.claimWake({ deliveryId: "delivery-converge-a", ownerId: "worker" });
			await store.claimContextDelivery({ deliveryId: "delivery-converge-a", ownerId: "worker", claimId: "claim-a" });
			await store.markContextDelivered({ deliveryId: "delivery-converge-a", ownerId: "worker", claimId: "claim-a" });
			await store.markProcessed({ deliveryId: "delivery-converge-a", ownerId: "worker" });
			await store.close();
			store = await reopen(root);
			const pending = await store.recoverPending({ limit: 8 });
			expect(pending.map((record) => record.deliveryId)).toEqual(["delivery-converge-b"]);
			expect(Object.keys(pending[0] ?? {})).not.toContain("transport");
		} finally {
			await closeStore(store, root);
		}
	});

	it("serializes concurrent capacity reservations without losing an accepted message", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE, capacity: { maxItems: 1 } });
			const results = await Promise.all([
				store.accept(singleMessage("race-a")),
				store.accept(singleMessage("race-b")),
			]);
			expect(results.filter((result) => result.accepted)).toHaveLength(1);
			expect(results.filter((result) => result.reason === "capacity_items")).toHaveLength(1);
			await store.close();
			store = await reopen(root, FENCE_ONE, { capacity: { maxItems: 1 } });
			expect(await store.recoverPending()).toHaveLength(1);
		} finally {
			await closeStore(store, root);
		}
	});

	it("replays an accepted message by extending missing recipient obligations atomically", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			const original = singleMessage("fanout-replay");
			await store.accept(original);
			const replay = await store.accept({
				...original,
				recipients: [
					...original.recipients,
					{ deliveryId: "delivery-replay-b", recipient: "session-replay-b", lane: "steering" },
				],
			});
			expect(replay.obligations.map((record) => record.deliveryId)).toEqual([
				"delivery-fanout-replay",
				"delivery-replay-b",
			]);
			await expect(
				store.accept({
					...original,
					recipients: [
						...original.recipients,
						{ deliveryId: "delivery-replay-b", recipient: "session-replay-b", lane: "steering" },
						{ deliveryId: "delivery-replay-c", recipient: "session-replay-c", lane: "followUp" },
					],
					crashHook: {
						afterDurableCommit: () => {
							throw new Error("crash-after-fanout-replay");
						},
					},
				}),
			).rejects.toThrow("crash-after-fanout-replay");
			await store.close();
			store = await reopen(root);
			expect((await store.recoverPending()).map((record) => record.deliveryId)).toEqual([
				"delivery-fanout-replay",
				"delivery-replay-b",
				"delivery-replay-c",
			]);
		} finally {
			await closeStore(store, root);
		}
	});

	it("rejects a same-delivery route mutation as an integrity conflict", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			const original = singleMessage("route-conflict");
			await store.accept(original);
			await expect(
				store.accept({
					...original,
					recipients: [
						{ deliveryId: "delivery-route-conflict", recipient: "different-session", lane: "followUp" },
					],
				}),
			).rejects.toMatchObject({ code: "integrity_conflict" });
		} finally {
			await closeStore(store, root);
		}
	});

	it("rejects ownerless processed, failed, and retry acknowledgements", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE, capacity: { maxRetries: 1 } });
			await store.accept(singleMessage("owner-bypass"));
			await store.claimWake({ deliveryId: "delivery-owner-bypass", ownerId: "worker" });
			await store.claimContextDelivery({ deliveryId: "delivery-owner-bypass", ownerId: "worker", claimId: "claim" });
			await store.markContextDelivered({ deliveryId: "delivery-owner-bypass", ownerId: "worker", claimId: "claim" });
			await expect(store.markProcessed({ deliveryId: "delivery-owner-bypass" })).rejects.toMatchObject({
				code: "wake_owned",
			});
			await expect(store.markFailure({ deliveryId: "delivery-owner-bypass" })).rejects.toMatchObject({
				code: "wake_owned",
			});
			await store.markFailure({ deliveryId: "delivery-owner-bypass", ownerId: "worker" });
			await expect(store.retry({ deliveryId: "delivery-owner-bypass" })).rejects.toMatchObject({
				code: "wake_owned",
			});
		} finally {
			await closeStore(store, root);
		}
	});

	it("requires the active owner and fence for cancel and expire acknowledgements", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept({
				messageId: "cancel-expire-auth",
				observationId: "observation-cancel-expire-auth",
				content: "cancel-expire-auth",
				contentDigest: sessionMessageContentDigest("cancel-expire-auth"),
				recipients: [
					{ deliveryId: "delivery-cancel-auth", recipient: "cancel-session", lane: "steering" },
					{ deliveryId: "delivery-expire-auth", recipient: "expire-session", lane: "steering" },
				],
			});
			await store.claimWake({ deliveryId: "delivery-cancel-auth", ownerId: "cancel-worker" });
			await store.claimWake({ deliveryId: "delivery-expire-auth", ownerId: "expire-worker" });
			await expect(store.cancel({ deliveryId: "delivery-cancel-auth" })).rejects.toMatchObject({
				code: "wake_owned",
			});
			await expect(
				store.cancel({ deliveryId: "delivery-cancel-auth", ownerId: "other-worker" }),
			).rejects.toMatchObject({ code: "wake_owned" });
			await expect(
				store.cancel({
					deliveryId: "delivery-cancel-auth",
					ownerId: "cancel-worker",
					fence: { processGeneration: "stale-cancel-generation", fencingEpoch: 1 },
				}),
			).rejects.toMatchObject({ code: "stale_generation" });
			await expect(store.expire({ deliveryId: "delivery-expire-auth" })).rejects.toMatchObject({
				code: "wake_owned",
			});
			await expect(
				store.expire({ deliveryId: "delivery-expire-auth", ownerId: "other-worker" }),
			).rejects.toMatchObject({ code: "wake_owned" });
			expect((await store.cancel({ deliveryId: "delivery-cancel-auth", ownerId: "cancel-worker" })).outcome).toBe(
				"cancelled",
			);
			expect((await store.expire({ deliveryId: "delivery-expire-auth", ownerId: "expire-worker" })).outcome).toBe(
				"expired",
			);
		} finally {
			await store?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retains failed outcomes across reopen until an explicit fenced owner retry", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({
				rootDir: root,
				fence: FENCE_ONE,
				capacity: { maxRetries: 1 },
			});
			await store.accept(singleMessage("failed-restart"));
			await store.claimWake({ deliveryId: "delivery-failed-restart", ownerId: "failed-worker" });
			await store.markFailure({ deliveryId: "delivery-failed-restart", ownerId: "failed-worker" });
			await store.close();
			store = await reopen(root);
			expect(await store.recoverPending()).toEqual([]);
			expect((await store.getObligation("delivery-failed-restart"))?.outcome).toBe("failed");
			await expect(store.retry({ deliveryId: "delivery-failed-restart" })).rejects.toMatchObject({
				code: "wake_owned",
			});
			await expect(
				store.retry({ deliveryId: "delivery-failed-restart", ownerId: "failed-worker", fence: FENCE_TWO }),
			).rejects.toMatchObject({ code: "stale_generation" });
			expect((await store.retry({ deliveryId: "delivery-failed-restart", ownerId: "failed-worker" })).outcome).toBe(
				"pending",
			);
		} finally {
			await closeStore(store, root);
		}
	});

	it("preflights delivery collisions before append and recovers after rejection", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("collision-a"));
			await expect(
				store.accept({
					messageId: "collision-b",
					observationId: "observation-collision-b",
					content: "content-collision-b",
					contentDigest: sessionMessageContentDigest("content-collision-b"),
					recipients: [{ deliveryId: "delivery-collision-a", recipient: "other-session", lane: "steering" }],
				}),
			).rejects.toMatchObject({ code: "integrity_conflict" });
			await store.close();
			store = await reopen(root);
			expect(await store.getMessage("collision-b")).toBeUndefined();
			expect((await store.accept(singleMessage("collision-c"))).status).toBe("accepted");
		} finally {
			await closeStore(store, root);
		}
	});

	it("rejects a caller-supplied digest that is not the content hash", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await expect(
				store.accept({
					messageId: "digest-assertion",
					observationId: "observation-digest-assertion",
					content: "immutable",
					contentDigest: "caller-asserted",
					recipients: [{ deliveryId: "delivery-digest-assertion", recipient: "session", lane: "steering" }],
				}),
			).rejects.toMatchObject({ code: "integrity_conflict" });
			await store.close();
			store = await reopen(root);
			expect(await store.listAll()).toEqual([]);
		} finally {
			await closeStore(store, root);
		}
	});

	it("reclaims an expired same-generation wake lease after reopen", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		let now = "2026-01-01T00:00:00.000Z";
		try {
			store = createSessionMessageObligationStore({
				rootDir: root,
				fence: FENCE_ONE,
				capacity: { maxRetries: 0 },
				wakeLeaseMs: 1_000,
				now: () => now,
			});
			await store.accept(singleMessage("lease"));
			await store.claimWake({ deliveryId: "delivery-lease", ownerId: "crashed-worker" });
			await store.close();
			now = "2026-01-01T00:00:02.000Z";
			store = await reopen(root, FENCE_ONE, {
				capacity: { maxRetries: 0 },
				wakeLeaseMs: 1_000,
				now: () => now,
			});
			const reclaimed = await store.claimWake({ deliveryId: "delivery-lease", ownerId: "recovery-worker" });
			expect(reclaimed.wakeOwner?.ownerId).toBe("recovery-worker");
			expect(reclaimed.attemptCount).toBe(1);
		} finally {
			await closeStore(store, root);
		}
	});

	it("uses accepted sequence plus delivery id as the bounded recovery cursor", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept({
				messageId: "cursor-z",
				observationId: "observation-cursor-z",
				content: "z",
				contentDigest: sessionMessageContentDigest("z"),
				recipients: [{ deliveryId: "z-delivery", recipient: "z", lane: "steering" }],
			});
			await store.accept({
				messageId: "cursor-a",
				observationId: "observation-cursor-a",
				content: "a",
				contentDigest: sessionMessageContentDigest("a"),
				recipients: [{ deliveryId: "a-delivery", recipient: "a", lane: "steering" }],
			});
			const first = await store.recoverPending({ limit: 1 });
			expect(first.map((record) => record.deliveryId)).toEqual(["z-delivery"]);
			await store.close();
			store = await reopen(root);
			const second = await store.recoverPending({
				limit: 1,
				after: { acceptedSequence: first[0]!.acceptedSequence, deliveryId: first[0]!.deliveryId },
			});
			expect(second.map((record) => record.deliveryId)).toEqual(["a-delivery"]);
		} finally {
			await closeStore(store, root);
		}
	});

	it("converges page-size-one recovery with an exact raw tuple comparator", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept({
				messageId: "cursor-case",
				observationId: "observation-cursor-case",
				content: "case-sensitive",
				contentDigest: sessionMessageContentDigest("case-sensitive"),
				recipients: [
					{ deliveryId: "a", recipient: "lower", lane: "steering" },
					{ deliveryId: "A", recipient: "upper", lane: "steering" },
				],
			});
			const recovered: string[] = [];
			let after: { acceptedSequence: number; deliveryId: string } | undefined;
			for (;;) {
				const page = await store.recoverPending({ limit: 1, after });
				if (page.length === 0) break;
				const record = page[0]!;
				recovered.push(record.deliveryId);
				after = { acceptedSequence: record.acceptedSequence, deliveryId: record.deliveryId };
			}
			expect(recovered).toEqual(["A", "a"]);
		} finally {
			await closeStore(store, root);
		}
	});

	it("repairs an incomplete final JSON line before the next durable append", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("torn-before"));
			await store.close();
			await appendFile(join(root, "message-obligations.jsonl"), '{"torn":', "utf8");
			store = await reopen(root);
			expect((await store.accept(singleMessage("torn-after"))).status).toBe("accepted");
			await store.close();
			store = await reopen(root);
			expect((await store.recoverPending()).map((record) => record.deliveryId)).toEqual([
				"delivery-torn-before",
				"delivery-torn-after",
			]);
		} finally {
			await closeStore(store, root);
		}
	});

	it("fails closed on a parseable but invalid final journal record", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			await store.accept(singleMessage("parseable-corruption"));
			await store.close();
			await appendFile(join(root, "message-obligations.jsonl"), '{"torn":true}\n', "utf8");
			await expect(reopen(root)).rejects.toMatchObject({ code: "corrupt_store" });
		} finally {
			await closeStore(store, root);
		}
	});

	it("converges after a fault between checkpoint publication and journal replacement", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			for (let index = 0; index < 42; index++) {
				const messageId = `checkpoint-fault-${index}`;
				await store.accept(singleMessage(messageId));
				await store.claimWake({ deliveryId: `delivery-${messageId}`, ownerId: "checkpoint-worker" });
				await store.cancel({ deliveryId: `delivery-${messageId}`, ownerId: "checkpoint-worker" });
			}
			await store.accept(singleMessage("checkpoint-fault-final"));
			await expect(
				store.claimWake({
					deliveryId: "delivery-checkpoint-fault-final",
					ownerId: "checkpoint-worker",
					crashHook: {
						afterCheckpointPublication: () => {
							throw new Error("crash-between-checkpoint-and-journal");
						},
					},
				}),
			).rejects.toThrow("crash-between-checkpoint-and-journal");
			await store.close();
			store = await reopen(root);
			await store.cancel({ deliveryId: "delivery-checkpoint-fault-final", ownerId: "checkpoint-worker" });
			expect(await store.listAll()).toHaveLength(43);
			expect((await store.getObligation("delivery-checkpoint-fault-final"))?.outcome).toBe("cancelled");
			await store.accept(singleMessage("checkpoint-after-reopen"));
			await store.close();
			store = await reopen(root);
			expect(await store.listAll()).toHaveLength(44);
		} finally {
			await closeStore(store, root);
		}
	});

	it("compacts the journal into a durable host-owned checkpoint while retaining terminal history", async () => {
		const root = await makeStoreRoot();
		let store: SessionMessageObligationStore | undefined;
		try {
			store = createSessionMessageObligationStore({ rootDir: root, fence: FENCE_ONE });
			for (let index = 0; index < 64; index++) {
				const messageId = `compact-${index}`;
				await store.accept(singleMessage(messageId));
				await store.claimWake({ deliveryId: `delivery-${messageId}`, ownerId: "compact-worker" });
				await store.cancel({ deliveryId: `delivery-${messageId}`, ownerId: "compact-worker" });
			}
			await store.close();
			const journalBefore = (await stat(join(root, "message-obligations.jsonl"))).size;
			const checkpoint = await stat(join(root, "message-obligations.checkpoint.json"));
			expect(checkpoint.size).toBeGreaterThan(0);
			store = await reopen(root);
			expect(await store.listAll()).toHaveLength(64);
			expect((await stat(join(root, "message-obligations.jsonl"))).size).toBeLessThanOrEqual(journalBefore);
		} finally {
			await closeStore(store, root);
		}
	});
});
