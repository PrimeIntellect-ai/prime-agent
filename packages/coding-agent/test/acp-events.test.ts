import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import type { ActProjectionEvent } from "../src/core/act-events.js";
import {
	ACP_ACT_CONTENT_MAX_CHARS,
	ACP_ACT_PROGRESS_UPDATE_MAX,
	type AcpEventMappingState,
	acpToolKind,
	acpUpdatesForSessionEvent,
	actToolCallId,
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

const actUsage = {
	input: 7,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

type ActEventBody = ActProjectionEvent extends infer Event
	? Event extends ActProjectionEvent
		? Omit<Event, "type" | "actId" | "outerToolCallId">
		: never
	: never;

function actEvent(event: ActEventBody): ActProjectionEvent {
	return {
		type: "act_event",
		actId: "act-1",
		outerToolCallId: "outer-cell-9",
		...event,
	} as ActProjectionEvent;
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
		expect(JSON.stringify(mid[0])).toContain("hi");
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

	it("maps one ordered Act stream to one standard ACP tool call", () => {
		const state: AcpEventMappingState = {};
		const events: ActProjectionEvent[] = [
			actEvent({
				sequence: 1,
				event: "start",
				prompt: "inspect retained state",
				promptTruncated: false,
				model: { provider: "test", id: "model-a" },
				cancellationCapability: "posix-managed",
			}),
			actEvent({
				sequence: 2,
				event: "assistant_delta",
				stream: "thinking",
				text: "reasoning",
				textTruncated: false,
			}),
			actEvent({ sequence: 3, event: "cell_start", cellId: "cell-1", code: "1 / 0", codeTruncated: false }),
			actEvent({
				sequence: 4,
				event: "cell_terminal",
				cellId: "cell-1",
				status: "error",
				stdout: "",
				stdoutTruncated: false,
				stderr: "",
				stderrTruncated: false,
				error: "ZeroDivisionError",
				resultTruncated: false,
				errorTruncated: true,
			}),
			actEvent({
				sequence: 5,
				event: "assistant_delta",
				stream: "text",
				text: "recovering",
				textTruncated: false,
			}),
			actEvent({ sequence: 6, event: "cell_start", cellId: "cell-2", code: "6 * 7", codeTruncated: false }),
			actEvent({
				sequence: 7,
				event: "cell_terminal",
				cellId: "cell-2",
				status: "ok",
				stdout: "",
				stdoutTruncated: false,
				stderr: "",
				stderrTruncated: false,
				result: "42",
				resultTruncated: false,
				errorTruncated: false,
			}),
			actEvent({
				sequence: 8,
				event: "terminal",
				status: "done",
				prompt: "inspect retained state",
				promptTruncated: false,
				model: { provider: "test", id: "model-a" },
				cancellationCapability: "posix-managed",
				usage: actUsage,
				errorTruncated: false,
			}),
		];
		const updates = events.flatMap((event) => acpUpdatesForSessionEvent(event, state));
		// The mapper's public return type is the ACP SDK's standard union. Prime
		// Agent metadata is additive, so a vanilla client accepts every update.
		const vanillaUpdates: SessionUpdate[] = updates;
		expect(vanillaUpdates).toHaveLength(7);
		expect(updates[0]).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: actToolCallId("act-1"),
			kind: "execute",
			status: "in_progress",
			rawInput: { prompt: "inspect retained state" },
		});
		expect(updates.slice(1, -1).every((update) => (update as { status?: string }).status === "in_progress")).toBe(
			true,
		);
		expect(updates.at(-1)).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: actToolCallId("act-1"),
			status: "completed",
		});

		const expectedText = ["reasoning", "1 / 0", "ZeroDivisionError", "recovering", "6 * 7", "42"];
		const terminalText = JSON.stringify(updates.at(-1));
		let cursor = -1;
		for (const text of expectedText) {
			const next = terminalText.indexOf(text, cursor + 1);
			expect(next).toBeGreaterThan(cursor);
			cursor = next;
		}

		const meta = updates.map(
			(update) => (update._meta as Record<string, { act: Record<string, unknown> }>)[PRIME_AGENT_META_NAMESPACE].act,
		);
		expect(meta.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 6, 7, 8]);
		expect(meta.every((entry) => entry.actId === "act-1" && entry.outerToolCallId === "outer-cell-9")).toBe(true);
		expect(meta.every((entry) => (entry.model as { id: string }).id === "model-a")).toBe(true);
		expect(meta.every((entry) => entry.cancellationCapability === "posix-managed")).toBe(true);
		expect(meta[3]).toMatchObject({
			event: "cell_terminal",
			cellId: "cell-1",
			cellStatus: "error",
			truncatedFields: ["error"],
		});
		expect(meta.at(-1)).toMatchObject({ terminalStatus: "done", usage: actUsage });
		expect(JSON.stringify(updates)).not.toContain('"value"');
		expect(JSON.stringify(updates)).not.toContain("messageId");
	});

	it("bounds retained and serialized ACP content for long token streams and oversized cells", () => {
		const state: AcpEventMappingState = {};
		const updates: SessionUpdate[] = [];
		updates.push(
			...acpUpdatesForSessionEvent(
				actEvent({
					sequence: 1,
					event: "start",
					prompt: "stress",
					promptTruncated: false,
					model: { provider: "test", id: "model-a" },
					cancellationCapability: "posix-managed",
				}),
				state,
			),
		);
		let sequence = 2;
		for (let index = 0; index < 10_000; index += 1) {
			updates.push(
				...acpUpdatesForSessionEvent(
					actEvent({
						sequence: sequence++,
						event: "assistant_delta",
						stream: "thinking",
						text: String(index % 10),
						textTruncated: false,
					}),
					state,
				),
			);
		}
		updates.push(
			...acpUpdatesForSessionEvent(
				actEvent({
					sequence: sequence++,
					event: "cell_terminal",
					cellId: "stress-cell",
					status: "error",
					stdout: "\0".repeat(65_536),
					stdoutTruncated: false,
					stderr: "",
					stderrTruncated: false,
					error: "E".repeat(65_536),
					resultTruncated: false,
					errorTruncated: false,
				}),
				state,
			),
		);
		for (let index = 0; index < 10_000; index += 1) {
			updates.push(
				...acpUpdatesForSessionEvent(
					actEvent({
						sequence: sequence++,
						event: "assistant_delta",
						stream: "text",
						text: "ignored-after-budget",
						textTruncated: false,
					}),
					state,
				),
			);
		}

		const active = [...(state.activeActs ?? new Map()).values()][0] as unknown as {
			progressChunks: string[];
			progressChars: number;
			contentTruncated: boolean;
		};
		expect(active.progressChars).toBeLessThan(ACP_ACT_CONTENT_MAX_CHARS);
		expect(active.progressChunks.length).toBeLessThanOrEqual(1024);
		expect(active.contentTruncated).toBe(true);

		const terminalError = `terminal-visible-${"T".repeat(4096 - "terminal-visible-".length)}`;
		updates.push(
			...acpUpdatesForSessionEvent(
				actEvent({
					sequence,
					event: "terminal",
					status: "error",
					prompt: "stress",
					promptTruncated: false,
					model: { provider: "test", id: "model-a" },
					cancellationCapability: "posix-managed",
					usage: actUsage,
					error: terminalError,
					errorTruncated: false,
				}),
				state,
			),
		);

		const progressUpdates = updates.filter((update) => update.sessionUpdate === "tool_call_update").slice(0, -1);
		expect(progressUpdates.length).toBeLessThanOrEqual(ACP_ACT_PROGRESS_UPDATE_MAX);
		for (const update of updates) {
			const content = (update as { content?: unknown[] }).content;
			expect(content?.length ?? 0).toBeLessThanOrEqual(1);
			expect(JSON.stringify(update).length).toBeLessThanOrEqual(ACP_ACT_CONTENT_MAX_CHARS * 6 + 20_000);
		}
		const wireChars = updates.reduce((total, update) => total + JSON.stringify(update).length, 0);
		expect(wireChars).toBeLessThanOrEqual(
			(ACP_ACT_PROGRESS_UPDATE_MAX + 2) * (ACP_ACT_CONTENT_MAX_CHARS * 6 + 20_000),
		);

		const terminal = updates.at(-1)!;
		const terminalText = JSON.stringify(terminal);
		const terminalContent =
			(terminal as { content: Array<{ content: { text: string } }> }).content[0]?.content.text ?? "";
		expect(terminalContent.length).toBeLessThanOrEqual(ACP_ACT_CONTENT_MAX_CHARS);
		expect(terminalContent).toContain("Act error.");
		expect(terminalContent.endsWith(terminalError)).toBe(true);
		expect(terminal).toMatchObject({ status: "failed" });
		expect(terminalText).toContain("0123456789");
		expect(terminalText).toContain("Cell stress-cell error:");
		expect(terminalText).toContain("[Act progress truncated]");
		expect(
			updates
				.slice(0, -1)
				.some((update) =>
					Boolean(
						(update._meta as Record<string, { act?: { contentTruncated?: boolean } }> | undefined)?.[
							PRIME_AGENT_META_NAMESPACE
						]?.act?.contentTruncated,
					),
				),
		).toBe(true);
		expect(terminalText).toContain("terminal-visible-");
		expect(terminalText.indexOf("0123456789")).toBeLessThan(terminalText.indexOf("Cell stress-cell error:"));
		expect(terminal?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: {
				act: {
					contentTruncated: true,
					contentMaxChars: ACP_ACT_CONTENT_MAX_CHARS,
					terminalStatus: "error",
				},
			},
		});
		expect(terminalText).not.toContain('"value"');
		expect(terminalText).not.toContain("messageId");
	});

	it.each(["cancelled", "error"] as const)("closes an Act %s terminal as failed exactly once", (status) => {
		const state: AcpEventMappingState = {};
		acpUpdatesForSessionEvent(
			actEvent({
				sequence: 1,
				event: "start",
				prompt: "stop",
				promptTruncated: false,
				model: { provider: "test", id: "model-a" },
				cancellationCapability: "posix-managed",
			}),
			state,
		);
		const terminal = actEvent({
			sequence: 2,
			event: "terminal",
			status,
			prompt: "stop",
			promptTruncated: false,
			model: { provider: "test", id: "model-a" },
			cancellationCapability: "posix-managed",
			usage: actUsage,
			error: status === "error" ? "provider failed" : "cancelled",
			errorTruncated: false,
		});
		const [closed] = acpUpdatesForSessionEvent(terminal, state);
		expect(closed).toMatchObject({ status: "failed" });
		expect(closed?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: { act: { terminalStatus: status, usage: actUsage } },
		});
		expect(acpUpdatesForSessionEvent(terminal, state)).toEqual([]);
	});

	it("creates one self-contained standard terminal call after a late ACP attachment", () => {
		const terminal = actEvent({
			sequence: 4,
			event: "terminal",
			status: "done",
			prompt: "late prompt",
			promptTruncated: false,
			model: { provider: "test", id: "model-b" },
			cancellationCapability: "cooperative-only",
			usage: actUsage,
			errorTruncated: false,
		});
		const updates = acpUpdatesForSessionEvent(terminal, {});
		const vanillaUpdates: SessionUpdate[] = updates;
		expect(vanillaUpdates).toEqual([
			expect.objectContaining({
				sessionUpdate: "tool_call",
				toolCallId: actToolCallId("act-1"),
				status: "completed",
				rawInput: { prompt: "late prompt" },
			}),
		]);
	});

	it("leaves ordinary root and child ACP updates unchanged around an active Act", () => {
		const state: AcpEventMappingState = {};
		acpUpdatesForSessionEvent(
			actEvent({
				sequence: 1,
				event: "start",
				prompt: "act",
				promptTruncated: false,
				model: { provider: "test", id: "model-a" },
				cancellationCapability: "posix-managed",
			}),
			state,
		);
		expect(acpUpdatesForSessionEvent(assistantDelta("text_delta", "root"), state)).toEqual([
			{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "root" } },
		]);
		expect(
			acpUpdatesForSessionEvent(
				{
					type: "rlm_child_update",
					child: { id: "sub-1", status: "running", sessionName: "child" },
				} as AgentConnectionSessionEvent,
				state,
			),
		).toEqual([
			expect.objectContaining({
				sessionUpdate: "session_info_update",
				_meta: { [PRIME_AGENT_META_NAMESPACE]: { subagents: [expect.objectContaining({ id: "sub-1" })] } },
			}),
		]);
	});

	it("emits nothing for events ACP has no place for", () => {
		expect(acpUpdatesForSessionEvent({ type: "agent_start" } as AgentConnectionSessionEvent)).toEqual([]);
		expect(acpUpdatesForSessionEvent({ type: "recap_update", recap: "x" } as AgentConnectionSessionEvent)).toEqual(
			[],
		);
	});
});
