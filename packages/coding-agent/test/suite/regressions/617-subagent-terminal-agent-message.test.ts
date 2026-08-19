import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../../../src/core/messages.js";
import { waitForHeadlessCompletion } from "../../../src/modes/headless-completion.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

function terminalNotices(messages: readonly unknown[]): CustomMessage[] {
	return messages.filter(
		(message): message is CustomMessage =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			"customType" in message &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === "rlm_child_terminal_notice",
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

	it("delivers a child completion without a reply through the private typed notice path", async () => {
		const childSessionName = "terminal-worker";
		const sendAgentMessage = vi.fn(async () => {
			throw new Error("synthesized terminal notices must not use agent_message");
		});
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage,
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

		await expect.poll(() => terminalNotices(parent!.session.messages)).toHaveLength(1);
		expect(sendAgentMessage).not.toHaveBeenCalled();
		expect(terminalNotices(parent.session.messages)[0]).toMatchObject({
			customType: "rlm_child_terminal_notice",
			details: {
				kind: "completed_without_reply",
				childId: spawned.rlm_child_id,
				sessionName: childSessionName,
			},
			content: expect.stringContaining(
				`RLM child ${childSessionName} (${spawned.rlm_child_id}) completed without sending a reply`,
			),
		});
	});

	it("waits for the parent to consume a child terminal notice", async () => {
		const childSessionName = "headless-worker";
		const sendAgentMessage = vi.fn(async () => {
			throw new Error("synthesized terminal notices must not use agent_message");
		});
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage,
			},
		});
		parent = await createHarness({
			serializedRefine: true,
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		child.setResponses([fauxAssistantMessage("child completed")]);
		parent.setResponses([fauxAssistantMessage("parent consumed the child result")]);

		const spawned = await parent.session.runRlmChild("finish without replying", { name: childSessionName });
		await waitForHeadlessCompletion(parent.session, { waitForRlmQuiescence: true });

		expect(sendAgentMessage).not.toHaveBeenCalled();
		expect(terminalNotices(parent.session.messages)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					kind: "completed_without_reply",
					childId: spawned.rlm_child_id,
					sessionName: childSessionName,
				}),
			}),
		]);
		expect(getAssistantTexts(parent)).toEqual(["parent consumed the child result"]);
		expect(parent.session.hasRunningRlmChildren()).toBe(false);
	});
});
