import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSessionMessagePayload } from "../src/core/agent-messages.js";
import { createAgentSessionMessage } from "../src/core/agent-messages.js";
import {
	createSessionMessageObligationBridge,
	type SessionMessageObligationBridge,
} from "../src/core/session-message-obligation-bridge.js";

const payload: AgentSessionMessagePayload = {
	id: "agentmsg_lease_settle",
	source: "agent_message",
	message: "work that takes longer than a wake lease",
	from: {
		activeSessionId: "source-active",
		sessionId: "source-session",
		sessionName: "source",
		runtimeKind: "subagent",
		clientId: "client-1",
	},
	fromRelationship: "parent",
	target: {
		activeSessionId: "target-active",
		sessionId: "target-session",
		sessionName: "target",
		runtimeKind: "top-level",
	},
};

/**
 * A model turn routinely outlives the wake lease, so settlement cannot depend on the lease still
 * being live. The bridge holds the delivered context record - and therefore its claimId - at settle
 * time; omitting it forced the store down a lease-expiry fallback and lost the settlement. Production
 * evidence: a root session's ledger read accepted 24, context_delivered 24, processed 12.
 */
describe("settling an agent message after the wake lease expires", () => {
	it("settles on the durable context claim rather than a live lease", async () => {
		const root = await mkdtemp(join(tmpdir(), "obligation-lease-"));
		let bridge: SessionMessageObligationBridge | undefined;
		try {
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker",
				store: { wakeLeaseMs: 40 },
			});
			const accepted = await bridge.accept({ payload, lane: "steering" });
			expect(accepted.accepted).toBe(true);

			const message = createAgentSessionMessage(payload);
			await bridge.beforeAgentMessageDispatch(message);
			await bridge.afterAgentMessageTranscriptAppend(message);

			// The turn runs. Any real turn outlives the lease; 40ms just makes it deterministic.
			await new Promise((resolve) => setTimeout(resolve, 90));

			await expect(bridge.settleAgentMessage(message, "processed")).resolves.toBeUndefined();
		} finally {
			await bridge?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("still settles while the lease is live, so the fast path is unchanged", async () => {
		const root = await mkdtemp(join(tmpdir(), "obligation-lease-fast-"));
		let bridge: SessionMessageObligationBridge | undefined;
		try {
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker",
				store: { wakeLeaseMs: 60_000 },
			});
			await bridge.accept({ payload, lane: "steering" });
			const message = createAgentSessionMessage(payload);
			await bridge.beforeAgentMessageDispatch(message);
			await bridge.afterAgentMessageTranscriptAppend(message);
			await expect(bridge.settleAgentMessage(message, "processed")).resolves.toBeUndefined();
		} finally {
			await bridge?.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
