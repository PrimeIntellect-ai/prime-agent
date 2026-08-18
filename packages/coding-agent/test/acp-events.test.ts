import { describe, expect, it } from "vitest";
import {
	type AcpEventMappingState,
	acpToolKind,
	acpUpdatesForSessionEvent,
	bashToolCallId,
} from "../src/modes/acp/acp-events.js";
import { PRIME_AGENT_META_NAMESPACE } from "../src/modes/acp/acp-meta.js";
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
	it("maps assistant text deltas to agent_message_chunk", () => {
		const updates = acpUpdatesForSessionEvent(assistantDelta("text_delta", "hello"));
		expect(updates).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }]);
	});

	it("maps thinking deltas to agent_thought_chunk, not visible text", () => {
		const updates = acpUpdatesForSessionEvent(assistantDelta("thinking_delta", "reasoning"));
		expect(updates).toEqual([{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reasoning" } }]);
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

	it("treats IPython as an execute tool call carrying its cell source", () => {
		expect(acpToolKind("ipython")).toBe("execute");
		const updates = acpUpdatesForSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "ipython",
			args: { code: "print(1)" },
		} as AgentConnectionSessionEvent);
		expect(updates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "IPython cell",
				kind: "execute",
				status: "in_progress",
				rawInput: { code: "print(1)" },
			},
		]);
	});

	it("carries rich IPython output from the fields the tool actually reports", () => {
		// The ipython tool reports media/diffs under `details`, so the mapping must
		// read those exact fields rather than an invented MIME bundle.
		const updates = acpUpdatesForSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "ipython",
			result: {
				output: "done",
				details: {
					// KernelAttachment carries base64 `data`, never a `bytes` field.
					attachments: [{ mimeType: "image/png", path: "/tmp/plot.png", data: "aGVsbG8=" }],
					diffs: [{ path: "a.ts" }],
				},
			},
			isError: false,
		} as AgentConnectionSessionEvent);
		expect(updates[0]).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "done" } }],
		});
		expect(updates[0]?._meta).toEqual({
			[PRIME_AGENT_META_NAMESPACE]: {
				ipython: {
					attachments: [{ mimeType: "image/png", path: "/tmp/plot.png", bytes: 5 }],
					diffCount: 1,
				},
			},
		});
	});

	it("omits IPython rich metadata when the cell produced none", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-3",
			toolName: "ipython",
			result: { output: "plain", details: { stdout: "plain" } },
			isError: false,
		} as AgentConnectionSessionEvent);
		expect(updates[0]).not.toHaveProperty("_meta");
	});

	it("marks failed tool calls as failed", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-2",
			toolName: "ipython",
			result: "boom",
			isError: true,
		} as AgentConnectionSessionEvent);
		expect(updates[0]).toMatchObject({ status: "failed" });
	});

	it("gives bash a synthetic tool call with a stable id across its lifecycle", () => {
		const state: AcpEventMappingState = {};
		const start = acpUpdatesForSessionEvent(
			{ type: "bash_start", command: "ls", excludeFromContext: false, runId: "r1" } as AgentConnectionSessionEvent,
			state,
		);
		// bash_output carries no runId, so the mapping must remember the active run.
		const mid = acpUpdatesForSessionEvent(
			{ type: "bash_output", chunk: "a.ts\n" } as AgentConnectionSessionEvent,
			state,
		);
		expect(mid[0]).toMatchObject({ toolCallId: bashToolCallId("r1") });
		const end = acpUpdatesForSessionEvent(
			{
				type: "bash_end",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				runId: "r1",
			} as AgentConnectionSessionEvent,
			state,
		);
		expect(start[0]).toMatchObject({ toolCallId: bashToolCallId("r1"), kind: "execute", status: "in_progress" });
		expect(end[0]).toMatchObject({ toolCallId: bashToolCallId("r1"), status: "completed" });
	});

	it("fails a bash tool call on a non-zero exit", () => {
		const end = acpUpdatesForSessionEvent({
			type: "bash_end",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			runId: "r2",
		} as AgentConnectionSessionEvent);
		expect(end[0]).toMatchObject({ status: "failed" });
	});

	it("surfaces subagent updates as namespaced metadata", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "rlm_child_update",
			child: { id: "sub-1", sessionName: "reviewer", status: "running", model: "openai/gpt-5.6-terra" },
		} as AgentConnectionSessionEvent);
		expect(updates[0]?.sessionUpdate).toBe("session_info_update");
		expect(updates[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: {
				subagents: [{ id: "sub-1", sessionName: "reviewer", status: "running" }],
			},
		});
	});

	it("surfaces compaction as metadata rather than distorting a standard update", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "compaction_end",
			reason: "threshold",
			result: { summary: "compacted", tokensBefore: 1234 },
			aborted: false,
			willRetry: false,
		} as AgentConnectionSessionEvent);
		expect(updates[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: { compaction: { tokensBefore: 1234, summary: "compacted" } },
		});
	});

	it("surfaces goal state as namespaced metadata", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "goal_update",
			goal: { status: "active", objective: "ship ACP", tokenBudget: 1000, tokensUsed: 25 },
		} as AgentConnectionSessionEvent);
		expect(updates[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: {
				goal: { status: "active", objective: "ship ACP", tokenBudget: 1000, tokensUsed: 25 },
			},
		});
	});

	it("surfaces continual-harness refinement outcomes, applied edits only", () => {
		const done = acpUpdatesForSessionEvent({
			type: "refine_complete",
			result: {
				summary: "persisted a memory",
				appliedEdits: [
					{ applied: true, action: "create", kind: "memory", id: "m1" },
					{ applied: false, action: "create", kind: "skill", id: "s1" },
				],
			},
		} as AgentConnectionSessionEvent);
		expect(done[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: {
				refinement: { status: "complete", summary: "persisted a memory", changes: ["create memory:m1"] },
			},
		});

		const failed = acpUpdatesForSessionEvent({
			type: "refine_failed",
			error: "budget exhausted",
		} as AgentConnectionSessionEvent);
		expect(failed[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: { refinement: { status: "failed", error: "budget exhausted" } },
		});
	});

	it("surfaces agent-to-agent messages sent from the kernel", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "ipython_sent_agent_message",
			toolCallId: "cell-9",
			message: {
				id: "agentmsg_1",
				message: "done",
				deliveryStatus: "queued",
				target: { activeSessionId: "a1", sessionId: "s1", sessionName: "reviewer" },
			},
		} as AgentConnectionSessionEvent);
		expect(updates[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: {
				agentMessage: { toolCallId: "cell-9", target: "reviewer", deliveryStatus: "queued" },
			},
		});
	});

	it("streams bash output incrementally and surfaces compaction over ACP", () => {
		const start = acpUpdatesForSessionEvent({
			type: "bash_start",
			command: "echo hi",
			excludeFromContext: false,
			runId: "b1",
		} as AgentConnectionSessionEvent);
		const mid = acpUpdatesForSessionEvent({ type: "bash_output", chunk: "hi\n" } as AgentConnectionSessionEvent);
		const end = acpUpdatesForSessionEvent({
			type: "bash_end",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			runId: "b1",
		} as AgentConnectionSessionEvent);

		expect(start[0]).toMatchObject({ sessionUpdate: "tool_call", kind: "execute" });
		expect(JSON.stringify(mid[0]?.content)).toContain("hi");
		expect(end[0]).toMatchObject({ status: "completed" });

		const compaction = acpUpdatesForSessionEvent({
			type: "compaction_end",
			reason: "threshold",
			result: { summary: "kept the last turns", tokensBefore: 90_000, firstKeptEntryId: "e1" },
			aborted: false,
			willRetry: false,
		} as AgentConnectionSessionEvent);
		expect(compaction[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: { compaction: { tokensBefore: 90_000, summary: "kept the last turns" } },
		});
	});

	it("reports a cancelled bash run as a failed tool call", () => {
		const end = acpUpdatesForSessionEvent({
			type: "bash_end",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			runId: "b2",
		} as AgentConnectionSessionEvent);
		expect(end[0]).toMatchObject({ status: "failed" });
	});

	it("emits nothing for events ACP has no place for", () => {
		expect(acpUpdatesForSessionEvent({ type: "agent_start" } as AgentConnectionSessionEvent)).toEqual([]);
		expect(acpUpdatesForSessionEvent({ type: "recap_update", recap: "x" } as AgentConnectionSessionEvent)).toEqual(
			[],
		);
	});
});
