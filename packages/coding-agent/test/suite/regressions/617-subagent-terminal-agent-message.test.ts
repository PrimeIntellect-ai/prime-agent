import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import { createHarness, type Harness } from "../harness.js";

function terminalMessage(messages: readonly unknown[]): AgentSessionMessage | undefined {
	return messages.find(
		(message): message is AgentSessionMessage =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			"customType" in message &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === AGENT_MESSAGE_CUSTOM_TYPE,
	);
}

describe("#617 subagent terminal agent messages", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;

	afterEach(() => {
		child?.cleanup();
		parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	it("delivers a child completion without a reply as an attributed agent message", async () => {
		const childSessionName = "terminal-worker";
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async (input) => {
					expect(input).toMatchObject({
						target: parent!.session.sessionId,
						message: expect.stringContaining("completed without sending a reply"),
					});
					const message = createAgentSessionMessage({
						id: "agentmsg-terminal-completion",
						source: "agent_message",
						message: input.message,
						from: {
							activeSessionId: "child-active",
							sessionId: child!.session.sessionId,
							sessionName: childSessionName,
						},
						fromRelationship: "child",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
					});
					await parent!.session.acceptAgentMessagePrompt(message.content, { customMessage: message });
					return {
						id: message.details.id,
						source: "agent_message",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
						message: input.message,
						deliveryStatus: "delivered",
					};
				},
			},
		});
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		child.setResponses([fauxAssistantMessage("child completed")]);

		const spawned = await parent.session.runRlmChild("finish without replying", { name: childSessionName });

		await expect
			.poll(() => terminalMessage(parent!.session.messages))
			.toMatchObject({
				customType: AGENT_MESSAGE_CUSTOM_TYPE,
				details: {
					id: "agentmsg-terminal-completion",
					fromRelationship: "child",
					from: { sessionId: child.session.sessionId, sessionName: childSessionName },
				},
				content: expect.stringContaining(`[from child:${childSessionName}]`),
			});
		expect(parent.session.messages).not.toContainEqual(
			expect.objectContaining({ customType: "rlm_child_terminal_notice" }),
		);
		expect(terminalMessage(parent.session.messages)?.content).toContain(spawned.rlm_child_id);
	});
	it("falls back to an injected notice when the agent message cannot be delivered", async () => {
		// A controller that always rejects: the parent must still learn the child
		// finished. Losing the notice entirely is worse than losing attribution.
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async () => {
					throw new Error("delivery unavailable");
				},
			},
		});
		parent = await createHarness({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			} as never,
		});
		child.setResponses([fauxAssistantMessage("done, no reply to parent")]);
		parent.setResponses([fauxAssistantMessage("parent ack")]);

		await parent.session.runRlmChild("do the work");
		await new Promise((resolve) => setTimeout(resolve, 200));

		// The notice arrives some way: either the agent message or the injected
		// fallback, but never silently dropped.
		const sawNotice = parent.session.messages.some((message) => {
			const content = (message as { content?: unknown }).content;
			return typeof content === "string" && content.includes("completed without sending a reply");
		});
		expect(sawNotice || terminalMessage(parent.session.messages) !== undefined).toBe(true);
	}, 60_000);
});
