import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_SOURCE, createAgentSessionMessage } from "../../../src/core/agent-messages.js";
import type { SessionAutonomousContinuation } from "../../../src/session/autonomous-continuation.js";
import { createHarness, getUserTexts, type Harness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

describe("session input and turn ownership", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("resolves public admission wrappers installed after construction and waits for completion", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const started = createDeferred();
		const response = createDeferred();
		harness.setResponses([
			async () => {
				started.resolve();
				await response.promise;
				return fauxAssistantMessage("complete");
			},
		]);
		const admit = vi.spyOn(harness.session, "promptUntilAccepted");
		let completed = false;
		const prompt = harness.session.promptAndWait("work", { agentMessageId: "correlation" }).then(() => {
			completed = true;
		});
		await started.promise;
		expect(admit).toHaveBeenCalledWith("work", { agentMessageId: "correlation" });
		expect(completed).toBe(false);
		response.resolve();
		await prompt;
		expect(completed).toBe(true);
	});

	it("keeps correlation waiters isolated across sessions and rejects only disposed work", async () => {
		const first = await createHarness();
		const second = await createHarness();
		harnesses.push(first, second);
		const firstDelivery = first.session.waitForAgentMessagePromptDelivery("same-id");
		const secondDelivery = second.session.waitForAgentMessagePromptDelivery("same-id");
		const firstRejected = expect(firstDelivery).rejects.toThrow("disposed");
		first.session.dispose();
		await firstRejected;
		second.setResponses([fauxAssistantMessage("received")]);
		await second.session.promptAndWait("second session", { agentMessageId: "same-id" });
		await expect(secondDelivery).resolves.toBeUndefined();
		expect(getUserTexts(first)).toEqual([]);
		expect(getUserTexts(second)).toEqual(["second session"]);
	});

	it("uses late autonomous status wrappers for both rendered and persisted status", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const session = harness.session;
		const original = session.getAutonomousStatus;
		let calls = 0;
		const status = vi.spyOn(session, "getAutonomousStatus").mockImplementation(function (this: typeof session) {
			expect(this).toBe(session);
			return { ...original.call(this), continuationsUsed: 40 + ++calls };
		});

		await session.prompt("/autonomous status");
		await session.waitForIdle();

		expect(status).toHaveBeenCalledTimes(2);
		const message = session.messages.find(
			(entry) => entry.role === "custom" && entry.customType === "autonomous_status",
		);
		expect(message).toMatchObject({
			content: expect.stringContaining("Continuations: 41/"),
			details: { continuationsUsed: 42 },
		});
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom_message",
				customType: "autonomous_status",
				content: expect.stringContaining("Continuations: 41/"),
				details: expect.objectContaining({ continuationsUsed: 42 }),
			}),
		);
	});

	it("surfaces a status wrapper failure without emitting or persisting autonomous status", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		vi.spyOn(harness.session, "getAutonomousStatus").mockImplementation(() => {
			throw new Error("status unavailable");
		});

		await harness.session.prompt("/autonomous status");
		await harness.session.waitForIdle();
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ content: "Command failed: status unavailable" }),
		);

		expect(harness.session.messages).not.toContainEqual(expect.objectContaining({ customType: "autonomous_status" }));
		expect(harness.sessionManager.getEntries()).not.toContainEqual(
			expect.objectContaining({ customType: "autonomous_status" }),
		);
	});

	it("reads goal.get through a getter installed after construction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session;
		session.handleGoalHostRequest("goal.create", { objective: "stored goal", token_budget: 100 });
		const stored = session.goalState;
		const getter = vi.spyOn(session, "goalState", "get").mockImplementation(function (this: typeof session) {
			expect(this).toBe(session);
			return { ...stored, objective: "visible goal", tokensUsed: 30 };
		});

		expect(session.handleGoalHostRequest("goal.get")).toMatchObject({
			goal: { objective: "visible goal", tokens_used: 30 },
			remaining_tokens: 70,
		});
		expect(getter).toHaveBeenCalledOnce();
		getter.mockImplementation(() => {
			throw new Error("goal unavailable");
		});
		expect(() => session.handleGoalHostRequest("goal.get")).toThrow("goal unavailable");
	});

	it.each(["coalesce", "reject"] as const)(
		"preserves late queue wrappers for suspended incoming messages: %s",
		async (outcome) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const session = harness.session;
			await session.followUp("existing queued work");
			session.requestAbort();
			const queue = vi.spyOn(session, "queueAgentMessagePrompt");
			if (outcome === "coalesce") queue.mockResolvedValue(false);
			else queue.mockRejectedValue(new Error("queue unavailable"));
			const preflightResult = vi.fn();
			const accepted = session.acceptAgentMessagePrompt("incoming", {
				queueIfBusy: true,
				streamingBehavior: "followUp",
				preflightResult,
			});

			if (outcome === "coalesce") {
				await accepted;
				expect(preflightResult).toHaveBeenCalledWith(false, false);
			} else {
				await expect(accepted).rejects.toThrow("queue unavailable");
				expect(preflightResult).not.toHaveBeenCalled();
			}
			expect(queue).toHaveBeenCalledWith("incoming", "followUp", undefined);
			expect(queue.mock.contexts).toEqual([session]);
			expect(session.getFollowUpMessages()).toEqual(["existing queued work"]);
		},
	);

	it("clears agent messages by metadata and advances cancellation identity without text-wrapper dispatch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session;
		await session.followUp("protected queued message");
		const message = createAgentSessionMessage({
			id: "agentmsg-clear-boundary",
			source: AGENT_MESSAGE_SOURCE,
			message: "clear this agent message",
			fromRelationship: "parent",
			from: { sessionName: "root" },
			target: { activeSessionId: "active", sessionId: "session" },
		});
		await session.queueAgentMessagePrompt(message.content, "followUp", message);
		const owner = (session as unknown as { _actionQueue: { clearEpoch: number } })._actionQueue;
		const initialEpoch = owner.clearEpoch;
		const clear = vi.spyOn(session, "clearQueuedUserMessagesMatching").mockImplementation(() => {
			throw new Error("text wrapper must not handle metadata-based clearing");
		});

		expect(session.clearQueuedAgentMessages()).toEqual({ steering: [], followUp: [message.content] });
		expect(owner.clearEpoch).toBe(initialEpoch + 1);
		expect(clear).not.toHaveBeenCalled();
		expect(session.getFollowUpMessages()).toEqual(["protected queued message"]);
		expect(session.clearQueuedAgentMessages()).toEqual({ steering: [], followUp: [] });
		expect(owner.clearEpoch).toBe(initialEpoch + 2);
		expect(clear).not.toHaveBeenCalled();
		expect(session.getFollowUpMessages()).toEqual(["protected queued message"]);
	});

	it.each(["nextTurn", undefined] as const)(
		"keeps settled custom-message timing for %s delivery",
		async (deliverAs) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const order: string[] = [];
			const sent = harness.session
				.sendCustomMessage({ customType: "timing", content: "context", display: false }, { deliverAs })
				.then(() => order.push("sent"));
			queueMicrotask(() => order.push("tick"));
			await sent;
			expect(order).toEqual(["sent", "tick"]);
		},
	);

	it("does not add a promise adoption step before autonomous continuation decisions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const owner = (
			harness.session as unknown as { _autonomousContinuation: Pick<SessionAutonomousContinuation, "next"> }
		)._autonomousContinuation;
		const order: string[] = [];
		const next = owner.next(fauxAssistantMessage("done")).then((message) => {
			expect(message).toBeUndefined();
			order.push("continuation");
		});
		queueMicrotask(() => order.push("tick"));
		await next;
		expect(order).toEqual(["continuation", "tick"]);
	});
});
