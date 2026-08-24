import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSessionMessagePayload } from "../src/core/agent-messages.js";
import { createAgentSessionMessage } from "../src/core/agent-messages.js";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	createSessionMessageObligationBridge,
	parseSessionMessageObligationEnvelope,
	type SessionMessageObligationBridge,
	serializeSessionMessageObligationEnvelope,
} from "../src/core/session-message-obligation-bridge.js";
import {
	createSessionMessageObligationStore,
	type SessionMessageObligationFence,
	type SessionMessageObligationStore,
} from "../src/core/session-message-obligation-store.js";

const payload: AgentSessionMessagePayload = {
	id: "agentmsg_bridge_red",
	source: "agent_message",
	message: "durable hello",
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

describe("session message obligation bridge", () => {
	it("commits the canonical envelope before returning accepted", async () => {
		const root = await mkdtemp(join(tmpdir(), "session-message-bridge-red-"));
		let bridge: SessionMessageObligationBridge | undefined;
		try {
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker",
			});
			const accepted = await bridge.accept({ payload, lane: "steering" });
			expect(accepted.accepted).toBe(true);
			const journal = await readFile(join(root, "message-obligations.jsonl"), "utf8");
			expect(journal).toContain('"version":1');
			expect(journal).toContain('"messageId":"agentmsg_bridge_red"');
			expect(journal).toContain('\\"sessionName\\":\\"source\\"');
		} finally {
			await bridge?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("replays the same immutable envelope without allocating a new obligation", async () => {
		const root = await mkdtemp(join(tmpdir(), "session-message-bridge-idempotent-"));
		let bridge: SessionMessageObligationBridge | undefined;
		try {
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker",
			});
			const first = await bridge.accept({
				payload: { ...payload, observationId: "agentobs_stable" },
				lane: "steering",
			});
			await bridge.close();
			const firstManifest = JSON.parse(await readFile(join(root, "message-obligations.manifest.json"), "utf8")) as {
				currentFence: { fencingEpoch: number };
			};
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-restarted",
			});
			const secondManifest = JSON.parse(await readFile(join(root, "message-obligations.manifest.json"), "utf8")) as {
				currentFence: { fencingEpoch: number };
			};
			expect(secondManifest.currentFence.fencingEpoch).toBe(firstManifest.currentFence.fencingEpoch + 1);
			const second = await bridge.accept({
				payload: { ...payload, observationId: "agentobs_stable" },
				lane: "steering",
			});
			expect(first.replayed).toBe(false);
			expect(second.replayed).toBe(true);
			expect(second.obligations).toHaveLength(1);
			const journal = await readFile(join(root, "message-obligations.jsonl"), "utf8");
			expect(journal.match(/"kind":"accepted"/g)).toHaveLength(1);
			expect(journal.match(/"kind":"fanout_extended"/g)).toBeNull();
		} finally {
			await bridge?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("claims context before dispatch and quarantines a transcript-reconciled retry", async () => {
		const root = await mkdtemp(join(tmpdir(), "session-message-bridge-recovery-"));
		let bridge: SessionMessageObligationBridge | undefined;
		let recoveredBridge: SessionMessageObligationBridge | undefined;
		const message = createAgentSessionMessage({ ...payload, observationId: "agentobs_recovery" });
		const session = {
			hasPersistedAgentMessage: () => false,
			hasAgentMessageAction: () => false,
			queueAgentMessagePrompt: async () => true,
		} as unknown as AgentSession;
		try {
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-1",
			});
			await bridge.accept({ payload: { ...payload, observationId: "agentobs_recovery" }, lane: "steering" });
			expect(await bridge.beforeAgentMessageDispatch(message)).toBe("dispatch");
			await bridge.afterAgentMessageTranscriptAppend(message);
			await bridge.close();

			recoveredBridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-2",
			});
			const recoveredSession = {
				...session,
				hasPersistedAgentMessage: () => true,
			} as unknown as AgentSession;
			await recoveredBridge.bindSession(recoveredSession);
			expect(await recoveredBridge.beforeAgentMessageDispatch(message)).toBe("quarantine");
			const firstEvent = JSON.parse(
				(await readFile(join(root, "message-obligations.jsonl"), "utf8")).split("\n")[0]!,
			) as {
				data: { message: { content: string } };
			};
			const envelope = parseSessionMessageObligationEnvelope(firstEvent.data.message.content);
			expect(serializeSessionMessageObligationEnvelope(envelope)).toContain('"messageId":"agentmsg_bridge_red"');
		} finally {
			await bridge?.close();
			await recoveredBridge?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("restores the historical owner and claim when settling after bridge restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "session-message-bridge-terminal-restart-"));
		let bridge: SessionMessageObligationBridge | undefined;
		let restartedBridge: SessionMessageObligationBridge | undefined;
		const message = createAgentSessionMessage({ ...payload, observationId: "agentobs_terminal_restart" });
		try {
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-historical",
			});
			await bridge.accept({ payload: { ...payload, observationId: "agentobs_terminal_restart" }, lane: "steering" });
			expect(await bridge.beforeAgentMessageDispatch(message)).toBe("dispatch");
			await bridge.afterAgentMessageTranscriptAppend(message);
			const successorFence: SessionMessageObligationFence = {
				processGeneration: "bridge-successor-generation",
				fencingEpoch: 2,
			};
			const handoff = await bridge.issueOwnerContinuityHandoff({
				message,
				successorOwnerId: "target-worker-restarted",
				successorFence,
			});
			await bridge.close();

			restartedBridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-restarted",
				ownerContinuityHandoff: handoff,
			});
			await expect(restartedBridge.settleAgentMessage(message, "processed")).resolves.toBeUndefined();
			const journal = await readFile(join(root, "message-obligations.jsonl"), "utf8");
			expect(journal.match(/"kind":"context_delivered"/g)).toHaveLength(1);
			expect(journal.match(/"kind":"processed"/g)).toHaveLength(1);
		} finally {
			await bridge?.close();
			await restartedBridge?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("consumes a handoff exactly once after the successor fence was persisted before bridge restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "session-message-bridge-rotated-restart-"));
		let bridge: SessionMessageObligationBridge | undefined;
		let restartedBridge: SessionMessageObligationBridge | undefined;
		let rotatedStore: SessionMessageObligationStore | undefined;
		const message = createAgentSessionMessage({ ...payload, observationId: "agentobs_rotated_restart" });
		try {
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-historical",
			});
			await bridge.accept({ payload: { ...payload, observationId: "agentobs_rotated_restart" }, lane: "steering" });
			expect(await bridge.beforeAgentMessageDispatch(message)).toBe("dispatch");
			await bridge.afterAgentMessageTranscriptAppend(message);
			const successorFence: SessionMessageObligationFence = {
				processGeneration: "bridge-rotated-successor-generation",
				fencingEpoch: 2,
			};
			const handoff = await bridge.issueOwnerContinuityHandoff({
				message,
				successorOwnerId: "target-worker-restarted",
				successorFence,
			});
			await bridge.close();
			const persistedManifest = JSON.parse(
				await readFile(join(root, "message-obligations.manifest.json"), "utf8"),
			) as {
				currentFence: SessionMessageObligationFence;
			};
			rotatedStore = createSessionMessageObligationStore({ rootDir: root, fence: persistedManifest.currentFence });
			await rotatedStore.rotateGeneration({ nextFence: successorFence });
			await rotatedStore.close();
			rotatedStore = undefined;

			restartedBridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-restarted",
				ownerContinuityHandoff: handoff,
			});
			await expect(restartedBridge.settleAgentMessage(message, "processed")).resolves.toBeUndefined();
			await expect(restartedBridge.settleAgentMessage(message, "processed")).resolves.toBeUndefined();
			const journal = await readFile(join(root, "message-obligations.jsonl"), "utf8");
			expect(journal.match(/"kind":"owner_handoff_consumed"/g)).toHaveLength(1);
			expect(journal.match(/"kind":"processed"/g)).toHaveLength(1);
		} finally {
			await bridge?.close();
			await restartedBridge?.close();
			await rotatedStore?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an intentless bridge before it can rotate an active successor handoff", async () => {
		const root = await mkdtemp(join(tmpdir(), "session-message-bridge-handoff-fence-"));
		let bridge: SessionMessageObligationBridge | undefined;
		let successorBridge: SessionMessageObligationBridge | undefined;
		let preflightStore: SessionMessageObligationStore | undefined;
		const message = createAgentSessionMessage({ ...payload, observationId: "agentobs_handoff_fence" });
		try {
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-historical",
			});
			await bridge.accept({ payload: { ...payload, observationId: "agentobs_handoff_fence" }, lane: "steering" });
			expect(await bridge.beforeAgentMessageDispatch(message)).toBe("dispatch");
			await bridge.afterAgentMessageTranscriptAppend(message);
			const preflightManifest = JSON.parse(
				await readFile(join(root, "message-obligations.manifest.json"), "utf8"),
			) as { currentFence: SessionMessageObligationFence };
			preflightStore = createSessionMessageObligationStore({ rootDir: root, fence: preflightManifest.currentFence });
			expect(await preflightStore.hasPendingOwnerContinuityHandoff()).toBe(false);
			const handoff = await bridge.issueOwnerContinuityHandoff({
				message,
				successorOwnerId: "target-worker-successor",
				successorFence: {
					processGeneration: "handoff-fence-successor-generation",
					fencingEpoch: 2,
				},
			});
			await preflightStore.close();
			preflightStore = undefined;
			await bridge.close();
			bridge = undefined;
			const beforeManifest = JSON.parse(await readFile(join(root, "message-obligations.manifest.json"), "utf8")) as {
				currentFence: SessionMessageObligationFence;
			};
			await expect(
				createSessionMessageObligationBridge({
					rootDir: root,
					targetSessionId: payload.target.sessionId,
					ownerId: "attacker-without-intent",
				}),
			).rejects.toMatchObject({ code: "CONTRACT_CHANGE" });
			const afterManifest = JSON.parse(await readFile(join(root, "message-obligations.manifest.json"), "utf8")) as {
				currentFence: SessionMessageObligationFence;
			};
			expect(afterManifest.currentFence).toEqual(beforeManifest.currentFence);
			const journalBeforeSuccessor = await readFile(join(root, "message-obligations.jsonl"), "utf8");
			expect(journalBeforeSuccessor.match(/"kind":"generation_rotated"/g)).toBeNull();

			successorBridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-successor",
				ownerContinuityHandoff: handoff,
			});
			await expect(successorBridge.settleAgentMessage(message, "processed")).resolves.toBeUndefined();
		} finally {
			await bridge?.close();
			await successorBridge?.close();
			await preflightStore?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an attacker bridge from replaying a delivered settlement", async () => {
		const root = await mkdtemp(join(tmpdir(), "session-message-bridge-attacker-replay-"));
		let bridge: SessionMessageObligationBridge | undefined;
		let attackerBridge: SessionMessageObligationBridge | undefined;
		const message = createAgentSessionMessage({ ...payload, observationId: "agentobs_attacker_replay" });
		try {
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-historical",
			});
			await bridge.accept({ payload: { ...payload, observationId: "agentobs_attacker_replay" }, lane: "steering" });
			expect(await bridge.beforeAgentMessageDispatch(message)).toBe("dispatch");
			await bridge.afterAgentMessageTranscriptAppend(message);
			await bridge.close();

			attackerBridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "attacker-bridge",
			});
			await expect(attackerBridge.settleAgentMessage(message, "processed")).rejects.toMatchObject({
				code: "wake_owned",
			});
			const journal = await readFile(join(root, "message-obligations.jsonl"), "utf8");
			expect(journal.match(/"kind":"processed"/g)).toBeNull();
		} finally {
			await bridge?.close();
			await attackerBridge?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not mint continuity for a persisted transcript without successor intent", async () => {
		const root = await mkdtemp(join(tmpdir(), "session-message-bridge-transcript-attacker-"));
		let bridge: SessionMessageObligationBridge | undefined;
		let restartedBridge: SessionMessageObligationBridge | undefined;
		const message = createAgentSessionMessage({ ...payload, observationId: "agentobs_transcript_attacker" });
		try {
			bridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "target-worker-historical",
			});
			await bridge.accept({
				payload: { ...payload, observationId: "agentobs_transcript_attacker" },
				lane: "steering",
			});
			expect(await bridge.beforeAgentMessageDispatch(message)).toBe("dispatch");
			await bridge.afterAgentMessageTranscriptAppend(message);
			await bridge.close();

			restartedBridge = await createSessionMessageObligationBridge({
				rootDir: root,
				targetSessionId: payload.target.sessionId,
				ownerId: "attacker-successor",
			});
			const persistedSession = {
				hasPersistedAgentMessage: () => true,
				hasAgentMessageAction: () => false,
				queueAgentMessagePrompt: async () => true,
			} as unknown as AgentSession;
			await restartedBridge.bindSession(persistedSession);
			expect(await restartedBridge.beforeAgentMessageDispatch(message)).toBe("quarantine");
			await expect(
				restartedBridge.settleAgentMessage(message, "failed", "transcript was quarantined"),
			).rejects.toMatchObject({
				code: "wake_owned",
			});
		} finally {
			await bridge?.close();
			await restartedBridge?.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
