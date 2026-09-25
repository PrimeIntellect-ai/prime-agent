import { describe, expect, it } from "vitest";
import {
	type AcpEventMappingState,
	acpUpdatesForSessionEvent,
	acpUpdatesForTranscript,
} from "../src/modes/acp/acp-events.js";

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

describe("ACP transcript replay mapping", () => {
	const user = { role: "user", content: "hello", timestamp: 1 } as never;
	const assistant = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "reason" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "call-1", name: "ipython", arguments: { code: "print(1)" } },
		],
		usage: {},
		stopReason: "toolUse",
		timestamp: 2,
	} as never;
	const result = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "ipython",
		content: [{ type: "text", text: "1" }],
		isError: false,
		timestamp: 3,
	} as never;

	it("replays user, assistant, and tool result messages in order", () => {
		expect(acpUpdatesForTranscript([user, assistant, result])).toEqual([
			{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } },
			{
				sessionUpdate: "agent_thought_chunk",
				messageId: "prime-agent-replay-assistant-1",
				content: { type: "text", text: "reason" },
			},
			{
				sessionUpdate: "agent_message_chunk",
				messageId: "prime-agent-replay-assistant-1",
				content: { type: "text", text: "answer" },
			},
			{
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "Python cell",
				kind: "execute",
				status: "in_progress",
				rawInput: { code: "print(1)" },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "call-1",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "1" } }],
			},
		]);
	});

	it("marks a failed tool result and reuses ordered assistant ids", () => {
		const secondAssistant = { ...(assistant as object), content: [{ type: "text", text: "next" }] } as never;
		const updates = acpUpdatesForTranscript([
			assistant,
			secondAssistant,
			{ ...(result as object), isError: true } as never,
		]);
		expect(
			updates.filter((update) => update.sessionUpdate === "agent_message_chunk").map((update) => update.messageId),
		).toEqual(["prime-agent-replay-assistant-1", "prime-agent-replay-assistant-2"]);
		expect(updates.find((update) => update.sessionUpdate === "tool_call_update")).toMatchObject({ status: "failed" });
	});

	it("replays bash executions as a synthetic tool call", () => {
		const bash = {
			role: "bashExecution",
			command: "ls",
			output: "a\nb",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 4,
		} as never;
		expect(acpUpdatesForTranscript([bash])).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "prime-agent-replay-bash-1",
				title: "ls",
				kind: "execute",
				status: "in_progress",
				rawInput: { command: "ls" },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "prime-agent-replay-bash-1",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "a\nb" } }],
			},
		]);
	});

	it("marks a cancelled bash execution failed", () => {
		const bash = { role: "bashExecution", command: "sleep 1", output: "", cancelled: true, timestamp: 5 } as never;
		expect(acpUpdatesForTranscript([bash]).at(-1)).toMatchObject({
			sessionUpdate: "tool_call_update",
			status: "failed",
		});
	});

	it("replays a compaction summary as namespaced session info", () => {
		const summary = { role: "compactionSummary", summary: "condensed", tokensBefore: 100, timestamp: 6 } as never;
		const updates = acpUpdatesForTranscript([summary]);
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			sessionUpdate: "session_info_update",
			_meta: { "ai.primeintellect.prime-agent": { compaction: { tokensBefore: 100, summary: "condensed" } } },
		});
	});

	it("ignores message roles ACP has no mapping for", () => {
		expect(acpUpdatesForTranscript([{ role: "branchSummary", summary: "x" } as never])).toEqual([]);
	});
});
