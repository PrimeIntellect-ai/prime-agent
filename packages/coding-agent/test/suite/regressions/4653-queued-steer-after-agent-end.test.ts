import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	isAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import {
	createSessionMessageObligationBridge,
	type SessionMessageObligationBridge,
} from "../../../src/core/session-message-obligation-bridge.js";
import { createHarness, getUserTexts, type Harness } from "../harness.js";
import { createWaitingHarness } from "../scheduling.js";

describe("ENG-4653 queued messages after agent end", () => {
	const harnesses: Harness[] = [];
	const obligationBridges: SessionMessageObligationBridge[] = [];

	afterEach(async () => {
		while (obligationBridges.length > 0) {
			await obligationBridges.pop()?.close();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function waitForDelivery(harness: Harness, expectedCalls: number): Promise<void> {
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(expectedCalls));
		await harness.session.agent.waitForIdle();
		await vi.waitFor(() => expect(harness.session.queuedActionCount).toBe(0));
	}

	it("starts a new turn for steering queued from agent_end", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first turn complete"), fauxAssistantMessage("steering handled")]);

		let queued = false;
		const unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type !== "agent_end" || queued) return;
			queued = true;
			await harness.session.steer("stop heartbeat", undefined, { resumeIfIdle: true });
		});

		await harness.session.prompt("start");
		await waitForDelivery(harness, 2);
		unsubscribe();

		expect(getUserTexts(harness)).toEqual(["start", "stop heartbeat"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
	});

	it("wakes a coordinator agent message queued while idle work is pending", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("message handled"), fauxAssistantMessage("pending work handled")]);

		await harness.session.followUp("pending work");
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.unfinishedActionCount).toBe(1);

		const message = createAgentSessionMessage({
			id: "agentmsg_coordinator_4653",
			source: "agent_message",
			message: "continue coordinator work",
			from: { activeSessionId: "coordinator-active", sessionId: "coordinator-session", sessionName: "Coordinator" },
			fromRelationship: "parent",
			target: { activeSessionId: "worker-active", sessionId: harness.session.sessionId, sessionName: "Worker" },
		});
		await harness.session.queueAgentMessagePrompt(message.content, "steer", message);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.unfinishedActionCount).toBe(2);
		await waitForDelivery(harness, 2);

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages).toContainEqual(message);
	});

	it("drains an accepted coordinator steer after the abort boundary without external input", async () => {
		const waiting = await createWaitingHarness();
		const harness = waiting.harness;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("message handled after abort"),
		]);
		await waiting.waitForToolStart;
		expect(harness.session.isStreaming).toBe(true);
		expect(harness.session.state.pendingToolCalls.size).toBeGreaterThan(0);

		const payload = {
			id: "agentmsg_coordinator_abort_4653",
			source: "agent_message",
			message: "continue after abort",
			from: { activeSessionId: "coordinator-active", sessionId: "coordinator-session", sessionName: "Coordinator" },
			fromRelationship: "parent",
			target: { activeSessionId: "worker-active", sessionId: harness.session.sessionId, sessionName: "Worker" },
		} satisfies AgentSessionMessagePayload;
		const message = createAgentSessionMessage(payload);
		const obligationRoot = join(harness.tempDir, "message-obligations");
		const bridge = await createSessionMessageObligationBridge({
			rootDir: obligationRoot,
			targetSessionId: harness.session.sessionId,
			ownerId: "worker-after-abort",
		});
		obligationBridges.push(bridge);
		await bridge.accept({ payload, lane: "steering" });
		harness.session.setAgentMessageObligationBridge(bridge);
		const delivery = harness.session.waitForAgentMessagePromptDelivery(message.details.id);
		await bridge.bindSession(harness.session);
		expect(harness.session.unfinishedActionCount).toBe(2);
		expect(harness.session.queuedActionCount).toBe(1);

		harness.session.requestAbort();
		waiting.releaseToolExecution();
		await harness.session.abort();
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.state.pendingToolCalls.size).toBe(0);
		expect(harness.session.getSessionActionSnapshot().active).toBeUndefined();
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.unfinishedActionCount).toBeGreaterThanOrEqual(1);

		await waitForDelivery(harness, 2);
		await expect(delivery).resolves.toBeUndefined();
		expect(harness.faux.state.callCount).toBe(2);
		expect(
			harness.session.messages.filter(
				(candidate) => isAgentSessionMessage(candidate) && candidate.details.id === message.details.id,
			),
		).toHaveLength(1);
		await vi.waitFor(async () => {
			const currentJournal = await readFile(join(obligationRoot, "message-obligations.jsonl"), "utf8");
			expect(currentJournal.match(/"kind":"processed"/gu)).toHaveLength(1);
		});
		const journal = await readFile(join(obligationRoot, "message-obligations.jsonl"), "utf8");
		expect(journal.match(/"kind":"accepted"/gu)).toHaveLength(1);
		expect(journal.match(/"kind":"wake_claimed"/gu)).toHaveLength(1);
		expect(journal.match(/"kind":"context_delivered"/gu)).toHaveLength(1);
	});

	it("batches accepted agent messages at the first tool-result boundary", async () => {
		const waiting = await createWaitingHarness();
		const harness = waiting.harness;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("message batch handled"),
		]);
		await waiting.waitForToolStart;

		const obligationRoot = join(harness.tempDir, "message-batch-obligations");
		const bridge = await createSessionMessageObligationBridge({
			rootDir: obligationRoot,
			targetSessionId: harness.session.sessionId,
			ownerId: "worker-message-batch",
		});
		obligationBridges.push(bridge);
		const payloads = Array.from(
			{ length: 9 },
			(_, index) =>
				({
					id: `agentmsg_batch_${index}`,
					source: "agent_message",
					message: `gate finding ${index}`,
					from: { activeSessionId: `worker-${index}`, sessionId: `worker-session-${index}` },
					fromRelationship: "child",
					target: { activeSessionId: "coordinator-active", sessionId: harness.session.sessionId },
				}) satisfies AgentSessionMessagePayload,
		);
		const messages = payloads.map((payload) => createAgentSessionMessage(payload));
		for (const payload of payloads) {
			await bridge.accept({ payload, lane: "steering" });
		}
		harness.session.setAgentMessageObligationBridge(bridge);
		await bridge.bindSession(harness.session);
		expect(harness.session.queuedActionCount).toBe(9);

		waiting.releaseToolExecution();
		await harness.session.agent.waitForIdle();
		await waitForDelivery(harness, 2);

		expect(harness.faux.state.callCount).toBe(2);
		for (const message of messages) {
			expect(
				harness.session.messages.filter(
					(candidate) => isAgentSessionMessage(candidate) && candidate.details.id === message.details.id,
				),
			).toHaveLength(1);
		}
		await vi.waitFor(async () => {
			const journal = await readFile(join(obligationRoot, "message-obligations.jsonl"), "utf8");
			expect(journal.match(/"kind":"accepted"/gu)).toHaveLength(9);
			expect(journal.match(/"kind":"wake_claimed"/gu)).toHaveLength(9);
			expect(journal.match(/"kind":"context_delivered"/gu)).toHaveLength(9);
			expect(journal.match(/"kind":"processed"/gu)).toHaveLength(9);
		});
	});

	it("transfers wake ownership after a compaction deadline without external input", async () => {
		const harness = await createHarness({
			compactionDeadlineMs: 500,
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						await new Promise<void>(() => {});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first turn complete"),
			fauxAssistantMessage("second turn complete"),
			fauxAssistantMessage("message handled after compaction recovery"),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const compactResult = harness.session.compact(undefined, { skipAbort: true }).catch((error: unknown) => error);
		await vi.waitFor(() => expect(harness.session.isCompacting).toBe(true));
		const payload = {
			id: "agentmsg_compaction_deadline_4653",
			source: "agent_message",
			message: "continue after compaction recovery",
			from: { activeSessionId: "coordinator-active", sessionId: "coordinator-session", sessionName: "Coordinator" },
			fromRelationship: "parent",
			target: { activeSessionId: "worker-active", sessionId: harness.session.sessionId, sessionName: "Worker" },
		} satisfies AgentSessionMessagePayload;
		const message = createAgentSessionMessage(payload);
		const obligationRoot = join(harness.tempDir, "compaction-message-obligations");
		const bridge = await createSessionMessageObligationBridge({
			rootDir: obligationRoot,
			targetSessionId: harness.session.sessionId,
			ownerId: "worker-after-compaction-timeout",
		});
		obligationBridges.push(bridge);
		await bridge.accept({ payload, lane: "steering" });
		harness.session.setAgentMessageObligationBridge(bridge);
		const delivery = harness.session.waitForAgentMessagePromptDelivery(message.details.id);
		await bridge.bindSession(harness.session);
		expect(harness.session.queuedActionCount).toBe(1);

		try {
			const deadlineOutcome = await Promise.race([
				compactResult.then((error) => ({ kind: "settled" as const, error })),
				new Promise<{ kind: "still_compacting" }>((resolve) => {
					setTimeout(() => resolve({ kind: "still_compacting" }), 1_500);
				}),
			]);
			expect(deadlineOutcome).toMatchObject({
				kind: "settled",
				error: { message: expect.stringContaining("Compaction deadline exceeded") },
			});
		} finally {
			if (harness.session.isCompacting) {
				harness.session.abortCompaction();
				await compactResult;
			}
		}
		await waitForDelivery(harness, 3);
		await expect(delivery).resolves.toBeUndefined();

		expect(
			harness.session.messages.filter(
				(candidate) => isAgentSessionMessage(candidate) && candidate.details.id === message.details.id,
			),
		).toHaveLength(1);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "compaction_outcome"),
		).toContainEqual(expect.objectContaining({ content: expect.stringContaining("Compaction deadline exceeded") }));
		await vi.waitFor(async () => {
			const currentJournal = await readFile(join(obligationRoot, "message-obligations.jsonl"), "utf8");
			expect(currentJournal.match(/"kind":"processed"/gu)).toHaveLength(1);
		});
		const journal = await readFile(join(obligationRoot, "message-obligations.jsonl"), "utf8");
		expect(journal.match(/"kind":"accepted"/gu)).toHaveLength(1);
		expect(journal.match(/"kind":"wake_claimed"/gu)).toHaveLength(1);
		expect(journal.match(/"kind":"context_delivered"/gu)).toHaveLength(1);
	});

	it("bounds and recovers a compaction episode with no queued message or child owner", async () => {
		const harness = await createHarness({
			compactionDeadlineMs: 100,
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						await new Promise<void>(() => {});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("before compaction"), fauxAssistantMessage("after recovery")]);
		await harness.session.prompt("establish context");

		const compaction = harness.session.compact(undefined, { skipAbort: true });
		await vi.waitFor(() => {
			expect(harness.session.isCompacting).toBe(true);
			expect(harness.session.queuedActionCount).toBe(0);
			expect(harness.session.hasRunningRlmChildren()).toBe(false);
			expect(harness.session.getToolExecutionLiveness()).toEqual([]);
		});
		await expect(compaction).rejects.toThrow("Compaction deadline exceeded");

		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.getSessionActionSnapshot().active).toBeUndefined();
		expect(harness.session.getCompactionLiveness()).toBeUndefined();

		await expect(harness.session.prompt("prove the recovered session is processable")).resolves.toBeUndefined();
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("starts a turn for an explicit steering message accepted while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("idle steering handled")]);

		await harness.session.steer("recover stale routing", undefined, { resumeIfIdle: true });
		await waitForDelivery(harness, 1);

		expect(getUserTexts(harness)).toEqual(["recover stale routing"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("starts a new turn for a follow-up queued from agent_end", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first turn complete"), fauxAssistantMessage("follow-up handled")]);

		let queued = false;
		const unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type !== "agent_end" || queued) return;
			queued = true;
			await harness.session.followUp("continue after end", undefined, { resumeIfIdle: true });
		});

		await harness.session.prompt("start");
		await waitForDelivery(harness, 2);
		unsubscribe();

		expect(getUserTexts(harness)).toEqual(["start", "continue after end"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
	});
});
