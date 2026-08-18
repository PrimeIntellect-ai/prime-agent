import type { AssistantMessage, AssistantMessageEvent, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AgentActivityTracker, formatTokenCount } from "../src/modes/interactive/agent-activity.js";

function createAssistantMessage(outputTokens = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: outputTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function createUserMessage(): UserMessage {
	return { role: "user", content: "hello", timestamp: 0 };
}

function update(message: AssistantMessage, assistantMessageEvent: AssistantMessageEvent) {
	return { type: "message_update" as const, message, assistantMessageEvent };
}

describe("AgentActivityTracker", () => {
	test("starts waiting with no tokens", () => {
		const tracker = new AgentActivityTracker();
		expect(tracker.getStatus()).toEqual({ activity: "waiting", direction: "up", tokens: 0 });
	});

	test("derives activity from streaming delta types", () => {
		const tracker = new AgentActivityTracker();
		const message = createAssistantMessage();
		tracker.handleEvent({ type: "agent_start" });
		tracker.handleEvent({ type: "message_start", message });

		tracker.handleEvent(update(message, { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: message }));
		expect(tracker.getStatus().activity).toBe("thinking");
		expect(tracker.getStatus().direction).toBe("down");

		tracker.handleEvent(update(message, { type: "text_delta", contentIndex: 1, delta: "hi", partial: message }));
		expect(tracker.getStatus().activity).toBe("writing");

		tracker.handleEvent(update(message, { type: "toolcall_start", contentIndex: 2, partial: message }));
		expect(tracker.getStatus().activity).toBe("writing-code");
		expect(tracker.getStatus().direction).toBe("down");
	});

	test("uses streamed usage tokens when the provider reports them", () => {
		const tracker = new AgentActivityTracker();
		const message = createAssistantMessage(1234);
		tracker.handleEvent({ type: "message_start", message });
		tracker.handleEvent(update(message, { type: "text_delta", contentIndex: 0, delta: "hi", partial: message }));
		expect(tracker.getStatus().tokens).toBe(1234);
	});

	test("falls back to a character estimate when usage is not streamed", () => {
		const tracker = new AgentActivityTracker();
		const message = createAssistantMessage(0);
		tracker.handleEvent({ type: "message_start", message });
		tracker.handleEvent(
			update(message, { type: "text_delta", contentIndex: 0, delta: "a".repeat(40), partial: message }),
		);
		expect(tracker.getStatus().tokens).toBe(10);
	});

	test("updates live from the character estimate when streamed usage is stale", () => {
		const tracker = new AgentActivityTracker();
		const message = createAssistantMessage(1);
		tracker.handleEvent({ type: "message_start", message });
		tracker.handleEvent(
			update(message, { type: "text_delta", contentIndex: 0, delta: "a".repeat(400), partial: message }),
		);
		expect(tracker.getStatus().tokens).toBe(100);
	});

	test("never decreases when authoritative usage arrives at message end", () => {
		const tracker = new AgentActivityTracker();
		const message = createAssistantMessage(0);
		tracker.handleEvent({ type: "message_start", message });
		tracker.handleEvent(
			update(message, { type: "text_delta", contentIndex: 0, delta: "a".repeat(400), partial: message }),
		);
		expect(tracker.getStatus().tokens).toBe(100);
		tracker.handleEvent({ type: "message_end", message: createAssistantMessage(80) });
		expect(tracker.getStatus().tokens).toBe(100);
	});

	test("accumulates tokens across turns and flips direction while executing tools", () => {
		const tracker = new AgentActivityTracker();
		const first = createAssistantMessage(500);
		tracker.handleEvent({ type: "message_start", message: first });
		tracker.handleEvent(update(first, { type: "toolcall_delta", contentIndex: 0, delta: "code", partial: first }));
		tracker.handleEvent({ type: "message_end", message: first });
		expect(tracker.getStatus()).toEqual({ activity: "waiting", direction: "up", tokens: 500 });

		tracker.handleEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "ipython", args: {} });
		expect(tracker.getStatus()).toEqual({ activity: "executing", direction: "up", tokens: 500 });

		tracker.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "ipython",
			result: {},
			isError: false,
		});
		expect(tracker.getStatus().activity).toBe("waiting");

		const second = createAssistantMessage(250);
		tracker.handleEvent({ type: "message_start", message: second });
		tracker.handleEvent(update(second, { type: "text_delta", contentIndex: 0, delta: "done", partial: second }));
		expect(tracker.getStatus().tokens).toBe(750);
	});

	test("stays executing while a parallel tool call is still running", () => {
		const tracker = new AgentActivityTracker();
		tracker.handleEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "ipython", args: {} });
		tracker.handleEvent({ type: "tool_execution_start", toolCallId: "t2", toolName: "ipython", args: {} });
		tracker.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "ipython",
			result: {},
			isError: false,
		});
		expect(tracker.getStatus().activity).toBe("executing");
		tracker.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "ipython",
			result: {},
			isError: false,
		});
		expect(tracker.getStatus().activity).toBe("waiting");
	});

	test("resets token count on the next user message", () => {
		const tracker = new AgentActivityTracker();
		const message = createAssistantMessage(500);
		tracker.handleEvent({ type: "message_start", message });
		tracker.handleEvent({ type: "message_end", message });
		expect(tracker.getStatus().tokens).toBe(500);

		tracker.handleEvent({ type: "message_start", message: createUserMessage() });
		expect(tracker.getStatus()).toEqual({ activity: "waiting", direction: "up", tokens: 0 });
	});
});

describe("formatTokenCount", () => {
	test("formats counts below 1k as-is", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(999)).toBe("999");
	});

	test("formats small thousands with one decimal", () => {
		expect(formatTokenCount(1000)).toBe("1.0k");
		expect(formatTokenCount(9940)).toBe("9.9k");
	});

	test("drops the decimal at 10k and above", () => {
		expect(formatTokenCount(12340)).toBe("12k");
		expect(formatTokenCount(250400)).toBe("250k");
	});

	test("formats millions", () => {
		expect(formatTokenCount(1500000)).toBe("1.5M");
		expect(formatTokenCount(12000000)).toBe("12M");
	});
});
