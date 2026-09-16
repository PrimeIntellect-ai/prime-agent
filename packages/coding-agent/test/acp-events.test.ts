import { describe, expect, it } from "vitest";
import { type AcpEventMappingState, acpUpdatesForSessionEvent } from "../src/modes/acp/acp-events.js";

import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/types.js";

/** Real streaming shape: the discriminator is on the event, delta is a string. */
function assistantDelta(type: "text_delta" | "thinking_delta", delta: string): AgentConnectionSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content: [], usage: {} } as never,
		assistantMessageEvent: { type, contentIndex: 0, delta, partial: {} } as never,
	} as AgentConnectionSessionEvent;
}

describe("ACP session event mapping", () => {
	it("maps thinking deltas to agent_thought_chunk, not visible text", () => {
		const updates = acpUpdatesForSessionEvent(assistantDelta("thinking_delta", "reasoning"));
		expect(updates).toEqual([
			{
				sessionUpdate: "agent_thought_chunk",
				messageId: "prime-agent-assistant-1",
				content: { type: "text", text: "reasoning" },
			},
		]);
	});

	it("assigns one message id per assistant message", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		const start = { type: "message_start", message } as AgentConnectionSessionEvent;
		const end = { type: "message_end", message } as AgentConnectionSessionEvent;

		expect(acpUpdatesForSessionEvent(start, state)).toEqual([]);
		expect(acpUpdatesForSessionEvent(assistantDelta("thinking_delta", "think"), state)[0]).toMatchObject({
			messageId: "prime-agent-assistant-1",
		});
		expect(acpUpdatesForSessionEvent(assistantDelta("text_delta", "answer"), state)[0]).toMatchObject({
			messageId: "prime-agent-assistant-1",
		});
		expect(acpUpdatesForSessionEvent(end, state)).toEqual([]);
		expect(state.activeAssistantMessageId).toBeUndefined();

		expect(acpUpdatesForSessionEvent(start, state)).toEqual([]);
		expect(acpUpdatesForSessionEvent(assistantDelta("text_delta", "next"), state)[0]).toMatchObject({
			messageId: "prime-agent-assistant-2",
		});
	});

	it("ignores empty deltas and non-assistant messages", () => {
		expect(acpUpdatesForSessionEvent(assistantDelta("text_delta", ""))).toEqual([]);
		expect(
			acpUpdatesForSessionEvent({
				type: "message_update",
				message: { role: "user", content: "hi" } as never,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} } as never,
			} as AgentConnectionSessionEvent),
		).toEqual([]);
	});

	it("emits nothing for events ACP has no place for", () => {
		expect(acpUpdatesForSessionEvent({ type: "agent_start" } as AgentConnectionSessionEvent)).toEqual([]);
		expect(acpUpdatesForSessionEvent({ type: "recap_update", recap: "x" } as AgentConnectionSessionEvent)).toEqual(
			[],
		);
	});
});
