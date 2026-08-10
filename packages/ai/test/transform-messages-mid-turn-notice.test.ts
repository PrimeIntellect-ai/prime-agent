import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "../src/types.js";

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-5",
		name: "Claude Opus 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function assistantWithToolCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "running" },
			{ type: "toolCall", id, name: "ipython", arguments: { code: "1" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

function userText(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as Message;
}

/** Mirrors the anthropic/openai provider requirement: every tool result must directly follow its tool call. */
function assertToolResultsAreAnchored(messages: Message[]): void {
	let pending = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "assistant") {
			pending = new Set(
				(msg as AssistantMessage).content.filter((b) => b.type === "toolCall").map((b: any) => b.id as string),
			);
		} else if (msg.role === "toolResult") {
			const id = (msg as ToolResultMessage).toolCallId;
			expect(pending.has(id), `orphaned tool result ${id} (no tool call in the preceding assistant message)`).toBe(
				true,
			);
			pending.delete(id);
		} else {
			expect(
				pending.size,
				`tool call(s) ${[...pending].join(", ")} left unresolved before a ${msg.role} message`,
			).toBe(0);
			pending = new Set();
		}
	}
}

describe("transformMessages: notices delivered mid tool call", () => {
	const model = makeModel();

	it("keeps the real tool result anchored when a notice lands between the tool call and its result", () => {
		const messages: Message[] = [
			userText("do the thing"),
			assistantWithToolCall("toolu_A"),
			userText("<prime_agent_update_interrupted> restarted"),
			toolResult("toolu_A", "Request was aborted"),
			userText("continue"),
		];

		const out = transformMessages(messages, model);
		assertToolResultsAreAnchored(out);
		const realResult = out.find(
			(m) =>
				m.role === "toolResult" &&
				(m as ToolResultMessage).content[0]?.type === "text" &&
				((m as ToolResultMessage).content[0] as any).text === "Request was aborted",
		);
		expect(realResult, "the real tool result must survive").toBeDefined();
		expect(
			out.filter((m) => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "toolu_A"),
		).toHaveLength(1);
		expect(out.some((m) => m.role === "user" && JSON.stringify(m.content).includes("update_interrupted"))).toBe(true);
	});

	it("keeps every result anchored with several notices interleaved into a parallel tool turn", () => {
		const parallel = assistantWithToolCall("toolu_A");
		(parallel.content as any).push({ type: "toolCall", id: "toolu_B", name: "ipython", arguments: {} });
		const messages: Message[] = [
			userText("do the thing"),
			parallel,
			toolResult("toolu_A", "a"),
			userText("[from child:worker] agent message"),
			userText("<ipython_state_restored> names revived"),
			toolResult("toolu_B", "b"),
		];

		const out = transformMessages(messages, model);
		assertToolResultsAreAnchored(out);
		expect(out.filter((m) => m.role === "toolResult")).toHaveLength(2);
		expect(out.filter((m) => m.role === "user")).toHaveLength(3);
	});

	it("drops tool results whose assistant turn was dropped as errored", () => {
		const errored = assistantWithToolCall("toolu_ERR");
		(errored as any).stopReason = "error";
		const messages: Message[] = [
			userText("do the thing"),
			assistantWithToolCall("toolu_A"),
			toolResult("toolu_A", "a"),
			errored,
			toolResult("toolu_ERR", "orphan"),
			userText("continue"),
		];

		const out = transformMessages(messages, model);
		assertToolResultsAreAnchored(out);
		expect(out.some((m) => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "toolu_ERR")).toBe(
			false,
		);
	});

	it("still resolves genuinely abandoned tool calls with a synthetic result", () => {
		const messages: Message[] = [
			userText("do the thing"),
			assistantWithToolCall("toolu_A"),
			userText("stop, do something else"),
			assistantWithToolCall("toolu_B"),
			toolResult("toolu_B", "b"),
		];

		const out = transformMessages(messages, model);
		assertToolResultsAreAnchored(out);
		const synthetic = out.find((m) => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "toolu_A");
		expect(synthetic).toBeDefined();
		expect((synthetic as ToolResultMessage).isError).toBe(true);
	});
});
