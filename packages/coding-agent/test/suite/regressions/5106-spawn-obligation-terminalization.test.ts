import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createSessionMessageObligationStore,
	type SessionMessageObligationStore,
	sessionMessageContentDigest,
} from "../../../src/core/session-message-obligation-store.js";

const FENCE_ONE = { processGeneration: "generation-spawn-v48-1", fencingEpoch: 1 } as const;
const FENCE_TWO = { processGeneration: "generation-spawn-v48-2", fencingEpoch: 2 } as const;
const DELIVERY_ID = "spawn:sub-7b5a9d74:child-session";
const HISTORICAL_OWNER = "child-worker-historical";
const CONTEXT_CLAIM_ID = "context-claim-spawn-v48";
const CONTENT = '{"resultId":"child-result","value":"canonical"}';

function createStore(
	rootDir: string,
	fence: typeof FENCE_ONE | typeof FENCE_TWO,
	now: () => string,
): SessionMessageObligationStore {
	return createSessionMessageObligationStore({ rootDir, fence, wakeLeaseMs: 1_000, now });
}

describe("spawn obligation terminalization", () => {
	it("binds terminal settlement to the historical owner and context claim across restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "spawn-obligation-terminalization-"));
		let store: SessionMessageObligationStore | undefined;
		let now = "2026-08-18T00:00:00.000Z";
		try {
			store = createStore(root, FENCE_ONE, () => now);
			await store.accept({
				messageId: "spawn:sub-7b5a9d74",
				observationId: "observation:workflow-v48",
				content: CONTENT,
				contentDigest: sessionMessageContentDigest(CONTENT),
				recipients: [{ deliveryId: DELIVERY_ID, recipient: "child-session", lane: "steering" }],
			});
			await store.claimWake({ deliveryId: DELIVERY_ID, ownerId: HISTORICAL_OWNER });
			await store.claimContextDelivery({
				deliveryId: DELIVERY_ID,
				ownerId: HISTORICAL_OWNER,
				claimId: CONTEXT_CLAIM_ID,
			});
			await store.markContextDelivered({
				deliveryId: DELIVERY_ID,
				ownerId: HISTORICAL_OWNER,
				claimId: CONTEXT_CLAIM_ID,
			});
			await store.rotateGeneration({ nextFence: FENCE_TWO });
			await store.close();
			store = createStore(root, FENCE_TWO, () => now);
			now = "2026-08-18T00:00:02.000Z";

			await expect(
				store.markProcessed({ deliveryId: DELIVERY_ID, ownerId: "attacker", claimId: CONTEXT_CLAIM_ID }),
			).rejects.toMatchObject({ code: "wake_owned" });
			await expect(
				store.markProcessed({ deliveryId: DELIVERY_ID, ownerId: HISTORICAL_OWNER, claimId: "wrong-claim" }),
			).rejects.toMatchObject({ code: "context_owned" });
			await expect(
				store.markProcessed({ deliveryId: DELIVERY_ID, ownerId: HISTORICAL_OWNER }),
			).rejects.toMatchObject({ code: "context_owned" });
			expect((await store.getObligation(DELIVERY_ID))?.outcome).toBe("pending");

			const processed = await store.markProcessed({
				deliveryId: DELIVERY_ID,
				ownerId: HISTORICAL_OWNER,
				claimId: CONTEXT_CLAIM_ID,
			});
			expect(processed.outcome).toBe("processed");
			expect((await store.getObligation(DELIVERY_ID))?.outcome).toBe("processed");
			expect(
				(
					await store.markProcessed({
						deliveryId: DELIVERY_ID,
						ownerId: HISTORICAL_OWNER,
						claimId: CONTEXT_CLAIM_ID,
					})
				).outcome,
			).toBe("processed");

			const journal = await readFile(join(root, "message-obligations.jsonl"), "utf8");
			const events = journal
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; fence?: unknown; data?: Record<string, unknown> });
			const contextDelivered = events.find((event) => event.kind === "context_delivered");
			expect(contextDelivered).toMatchObject({
				fence: FENCE_ONE,
				data: { deliveryId: DELIVERY_ID, ownerId: HISTORICAL_OWNER, claimId: CONTEXT_CLAIM_ID },
			});
			const processedEvents = events.filter((event) => event.kind === "processed");
			expect(processedEvents).toHaveLength(1);
			expect(processedEvents[0]).toMatchObject({ fence: FENCE_TWO, data: { deliveryId: DELIVERY_ID } });
		} finally {
			await store?.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
