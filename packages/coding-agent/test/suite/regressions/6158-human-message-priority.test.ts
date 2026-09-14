import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionMessage } from "../../../src/core/agent-messages.js";
import { conversationMessages, createHarness, getMessageText, type Harness } from "../harness.js";
import { createWaitingHarness } from "../scheduling.js";

function agentMessage(id: string, body: string) {
	return createAgentSessionMessage({
		id,
		source: "agent_message",
		message: body,
		target: { activeSessionId: "active-target", sessionId: "session-target", sessionName: "target" },
	});
}

async function queueAgentMessage(harness: Harness, id: string, body: string): Promise<void> {
	const message = agentMessage(id, body);
	await harness.session.acceptAgentMessagePrompt(message.content as string, {
		expandPromptTemplates: false,
		streamingBehavior: "steer",
		queueIfBusy: true,
		customMessage: message,
	});
}

describe("#6158 human messages outrank agent messages in the queue", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("queues human input ahead of pending agent messages and keeps human order", async () => {
		const waiting = await createWaitingHarness();
		harnesses.push(waiting.harness);
		const session = waiting.harness.session;
		waiting.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(`reply ${index}`)),
		]);
		await waiting.waitForToolStart;

		await queueAgentMessage(waiting.harness, "agentmsg_one", "agent one");
		await session.prompt("human one", { streamingBehavior: "steer", queueIfBusy: true });
		await queueAgentMessage(waiting.harness, "agentmsg_two", "agent two");
		await session.prompt("human two", { streamingBehavior: "steer", queueIfBusy: true });
		await queueAgentMessage(waiting.harness, "agentmsg_three", "agent three");

		expect(session.getSteeringMessages().map((text) => text.split("\n").pop())).toEqual([
			"human one",
			"human two",
			"agent one",
			"agent two",
			"agent three",
		]);

		waiting.releaseToolExecution();
		await waiting.promptPromise;
		await session.waitForIdle();

		const delivered = conversationMessages(session)
			.map((message) => getMessageText(message).split("\n").pop())
			.filter((text): text is string => text !== undefined && /^(human|agent) /.test(text));
		expect(delivered).toEqual(["human one", "human two", "agent one", "agent two", "agent three"]);
	});

	it("keeps a prompt that waits for its own completion at human priority", async () => {
		const waiting = await createWaitingHarness();
		harnesses.push(waiting.harness);
		const session = waiting.harness.session;
		waiting.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 4 }, (_, index) => fauxAssistantMessage(`reply ${index}`)),
		]);
		await waiting.waitForToolStart;

		await queueAgentMessage(waiting.harness, "agentmsg_wait", "agent wait");
		const pending = session.promptAndWait("human wait", { streamingBehavior: "steer", queueIfBusy: true });
		await vi.waitFor(() => expect(session.getSteeringMessages()).toHaveLength(2));

		expect(session.getSteeringMessages()[0]).toBe("human wait");

		waiting.releaseToolExecution();
		await pending;
		await session.waitForIdle();
	});

	it("keeps an agent message ahead of a human follow-up the user deferred to its own lane", async () => {
		const waiting = await createWaitingHarness();
		harnesses.push(waiting.harness);
		const session = waiting.harness.session;
		waiting.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 4 }, (_, index) => fauxAssistantMessage(`reply ${index}`)),
		]);
		await waiting.waitForToolStart;

		await queueAgentMessage(waiting.harness, "agentmsg_lane", "agent lane");
		await session.prompt("human lane", { streamingBehavior: "followUp", queueIfBusy: true });

		expect(session.getSteeringMessages()).toHaveLength(1);
		expect(session.getFollowUpMessages()).toEqual(["human lane"]);

		waiting.releaseToolExecution();
		await session.dispose();
	});

	it("restores a persisted queue in its stored order", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session;
		await session.restoreSteeringMessage("agent restored", undefined, {
			agentMessageId: "agentmsg_restored",
			customMessage: agentMessage("agentmsg_restored", "agent restored"),
		});
		await session.restoreSteeringMessage("human restored");

		expect(session.getSteeringMessages()).toEqual(["agent restored", "human restored"]);
	});
});
