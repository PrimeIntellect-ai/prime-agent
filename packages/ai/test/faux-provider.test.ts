import { afterEach, describe, expect, it } from "vitest";
import {
	complete,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
	stream,
	Type,
} from "../src/index.js";
import type { AssistantMessageEvent, Context, ProviderStreamOptions } from "../src/types.js";

async function collectEvents(streamResult: ReturnType<typeof stream>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamResult) {
		events.push(event);
	}
	return events;
}

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function register(options?: Parameters<typeof registerFauxProvider>[0]) {
	const registration = registerFauxProvider(options);
	registrations.push(registration);
	return registration;
}

const userTurn = (): Context => ({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });

describe("faux provider", () => {
	it("consumes queued responses in order and errors when exhausted", async () => {
		const registration = register();
		registration.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const context = userTurn();
		const first = await complete(registration.getModel(), context);
		const second = await complete(registration.getModel(), context);
		const exhausted = await complete(registration.getModel(), context);

		expect(first.content).toEqual([{ type: "text", text: "first" }]);
		expect(second.content).toEqual([{ type: "text", text: "second" }]);
		expect(exhausted.stopReason).toBe("error");
		expect(exhausted.errorMessage).toBe("No more faux responses queued");
		expect(registration.getPendingResponseCount()).toBe(0);
		expect(registration.state.callCount).toBe(3);
	});

	it("emits an error when a response factory throws", async () => {
		const registration = register();
		registration.setResponses([
			() => {
				throw new Error("boom");
			},
		]);

		const events = await collectEvents(stream(registration.getModel(), userTurn()));

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		if (events[0].type === "error") {
			expect(events[0].error.stopReason).toBe("error");
			expect(events[0].error.errorMessage).toBe("boom");
		}
	});

	it("estimates prompt and output tokens from serialized context", async () => {
		const registration = register();
		registration.setResponses([fauxAssistantMessage("done")]);

		const tool = { name: "echo", description: "Echo back text", parameters: Type.Object({ text: Type.String() }) };
		const context: Context = {
			systemPrompt: "sys",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "hello" },
						{ type: "image", mimeType: "image/png", data: "abcd" },
					],
					timestamp: 1,
				},
				fauxAssistantMessage("prior"),
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "echo",
					content: [{ type: "text", text: "tool out" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [tool],
		};

		const response = await complete(registration.getModel(), context);
		const promptText = [
			"system:sys",
			"user:hello\n[image:image/png:4]",
			"assistant:prior",
			"toolResult:echo\ntool out",
			`tools:${JSON.stringify([tool])}`,
		].join("\n\n");
		const expectedPromptTokens = Math.ceil(promptText.length / 4);
		const expectedOutputTokens = Math.ceil("done".length / 4);

		expect(response.usage.input).toBe(expectedPromptTokens);
		expect(response.usage.output).toBe(expectedOutputTokens);
		expect(response.usage.cacheRead).toBe(0);
		expect(response.usage.cacheWrite).toBe(0);
		expect(response.usage.totalTokens).toBe(expectedPromptTokens + expectedOutputTokens);
	});

	// Two sequential requests over a growing context; only a repeated sessionId with a real
	// retention window may report a cache hit on the second request.
	it.each([
		{
			name: "reuses the prefix for a repeated sessionId",
			first: { sessionId: "session-1", cacheRetention: "short" } as ProviderStreamOptions,
			second: { sessionId: "session-1", cacheRetention: "short" } as ProviderStreamOptions,
			cacheHit: true,
			cacheWrite: true,
		},
		{
			name: "does not share the cache across sessions",
			first: { sessionId: "session-1", cacheRetention: "short" } as ProviderStreamOptions,
			second: { sessionId: "session-2", cacheRetention: "short" } as ProviderStreamOptions,
			cacheHit: false,
			cacheWrite: true,
		},
		{
			name: "does not cache without a sessionId",
			first: undefined,
			second: undefined,
			cacheHit: false,
			cacheWrite: false,
		},
		{
			name: "does not cache when cacheRetention is none",
			first: { sessionId: "session-1", cacheRetention: "none" } as ProviderStreamOptions,
			second: { sessionId: "session-1", cacheRetention: "none" } as ProviderStreamOptions,
			cacheHit: false,
			cacheWrite: false,
		},
	])("simulates prompt caching: $name", async ({ first, second, cacheHit, cacheWrite }) => {
		const registration = register();
		registration.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const context: Context = {
			systemPrompt: "Be concise.",
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const firstResponse = await complete(registration.getModel(), context, first);
		context.messages.push(firstResponse);
		context.messages.push({ role: "user", content: "follow up", timestamp: Date.now() + 1 });
		const secondResponse = await complete(registration.getModel(), context, second);

		if (cacheWrite) {
			expect(firstResponse.usage.cacheWrite).toBeGreaterThan(0);
		} else {
			expect(firstResponse.usage.cacheWrite).toBe(0);
		}
		expect(firstResponse.usage.cacheRead).toBe(0);
		if (cacheHit) {
			expect(secondResponse.usage.cacheRead).toBeGreaterThan(0);
		} else {
			expect(secondResponse.usage.cacheRead).toBe(0);
		}
	});

	it("streams an exact event order for fixed-size chunks", async () => {
		const registration = register({ tokenSize: { min: 1, max: 1 } });
		registration.setResponses([
			fauxAssistantMessage([fauxThinking("go"), fauxText("ok"), fauxToolCall("echo", {}, { id: "tool-1" })], {
				stopReason: "toolUse",
			}),
		]);

		const events = await collectEvents(stream(registration.getModel(), userTurn()));

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
	});

	it("reassembles tool call arguments from partial deltas", async () => {
		const registration = register();
		registration.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hi", count: 12 }, { id: "tool-1" })], {
				stopReason: "toolUse",
			}),
		]);

		const deltas: string[] = [];
		for await (const event of stream(registration.getModel(), userTurn())) {
			if (event.type === "toolcall_delta") deltas.push(event.delta);
		}

		expect(deltas.length).toBeGreaterThan(1);
		expect(JSON.parse(deltas.join(""))).toEqual({ text: "hi", count: 12 });
	});

	it("streams multiple tool calls in one message", async () => {
		const registration = register();
		registration.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { text: "one" }, { id: "tool-1" }),
					fauxToolCall("echo", { text: "two" }, { id: "tool-2" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const events = await collectEvents(stream(registration.getModel(), userTurn()));

		expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
	});

	// An explicit terminal stopReason must flush the partial text and then end on a single error event.
	it.each([
		{ stopReason: "error" as const, errorMessage: "upstream failed", reason: "error" },
		{ stopReason: "aborted" as const, errorMessage: "Request was aborted", reason: "aborted" },
	])("streams an explicit $stopReason message as a terminal error", async ({ stopReason, errorMessage, reason }) => {
		const registration = register({ tokenSize: { min: 2, max: 2 } });
		registration.setResponses([{ ...fauxAssistantMessage("partial"), stopReason, errorMessage }]);

		const events = await collectEvents(stream(registration.getModel(), userTurn()));

		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
		const terminal = events[events.length - 1];
		expect(terminal.type).toBe("error");
		if (terminal.type === "error") {
			expect(terminal.reason).toBe(reason);
			expect(terminal.error.stopReason).toBe(stopReason);
			expect(terminal.error.errorMessage).toBe(errorMessage);
		}
	});

	it("supports aborting before the first chunk", async () => {
		const registration = register({ tokensPerSecond: 50, tokenSize: { min: 3, max: 3 } });
		registration.setResponses([fauxAssistantMessage("abcdefghijklmnopqrstuvwxyz")]);

		const controller = new AbortController();
		controller.abort();
		const events = await collectEvents(stream(registration.getModel(), userTurn(), { signal: controller.signal }));

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		if (events[0].type === "error") {
			expect(events[0].reason).toBe("aborted");
			expect(events[0].error.stopReason).toBe("aborted");
		}
	});

	// Aborting on the first delta of a paced stream must stop the block without emitting its *_end event.
	it.each([
		{
			kind: "text",
			response: fauxAssistantMessage("abcdefghijklmnopqrstuvwxyz"),
			deltaType: "text_delta" as const,
			startType: "text_start",
			endType: "text_end",
		},
		{
			kind: "thinking",
			response: {
				...fauxAssistantMessage("ignored"),
				content: [{ type: "thinking" as const, thinking: "abcdefghijklmnopqrstuvwxyz" }],
			},
			deltaType: "thinking_delta" as const,
			startType: "thinking_start",
			endType: "thinking_end",
		},
		{
			kind: "toolcall",
			response: {
				...fauxAssistantMessage("done"),
				content: [
					{
						type: "toolCall" as const,
						id: "tool-1",
						name: "echo",
						arguments: { text: "abcdefghijklmnopqrstuvwxyz", count: 123456789 },
					},
				],
				stopReason: "toolUse" as const,
			},
			deltaType: "toolcall_delta" as const,
			startType: "toolcall_start",
			endType: "toolcall_end",
		},
	])("supports aborting mid-$kind stream when paced", async ({ response, deltaType, startType, endType }) => {
		const registration = register({ tokensPerSecond: 100, tokenSize: { min: 3, max: 3 } });
		registration.setResponses([response]);

		const controller = new AbortController();
		const events: string[] = [];
		let deltaCount = 0;
		for await (const event of stream(registration.getModel(), userTurn(), { signal: controller.signal })) {
			events.push(event.type);
			if (event.type === deltaType) {
				deltaCount++;
				controller.abort();
			}
		}

		expect(deltaCount).toBe(1);
		expect(events).toContain(startType);
		expect(events).toContain(deltaType);
		expect(events).toContain("error");
		expect(events).not.toContain(endType);
	});
});
