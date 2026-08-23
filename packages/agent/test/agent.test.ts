import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	Agent,
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	agentLoop,
} from "../src/index.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createToolUseMessage(toolName: string): AssistantMessage {
	return {
		...createAssistantMessage(""),
		content: [{ type: "toolCall", id: "tool-call-1", name: toolName, arguments: {} }],
		stopReason: "toolUse",
	};
}

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("Agent", () => {
	it("should create an agent instance with default state", () => {
		const agent = new Agent();

		expect(agent.state).toBeDefined();
		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.model).toBeDefined();
		expect(agent.state.thinkingLevel).toBe("off");
		expect(agent.state.serviceTier).toBe("default");
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBe(undefined);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("passes an explicit off reasoning selection to providers", async () => {
		let reasoning: AgentLoopConfig["reasoning"];
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				reasoning = options?.reasoning;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(reasoning).toBe("off");
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = getModel("openai", "gpt-4o-mini");
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: customModel,
				thinkingLevel: "low",
				serviceTier: "priority",
			},
		});

		expect(agent.state.systemPrompt).toBe("You are a helpful assistant.");
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe("low");
		expect(agent.state.serviceTier).toBe("priority");
	});

	it("should subscribe to events", () => {
		const agent = new Agent();

		let eventCount = 0;
		const unsubscribe = agent.subscribe((_event) => {
			eventCount++;
		});

		expect(eventCount).toBe(0);

		agent.state.systemPrompt = "Test prompt";
		expect(eventCount).toBe(0);
		expect(agent.state.systemPrompt).toBe("Test prompt");

		unsubscribe();
		agent.state.systemPrompt = "Another prompt";
		expect(eventCount).toBe(0); // Should not increase
	});

	it("should await async subscribers before prompt resolves", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		let listenerFinished = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		let promptResolved = false;
		const promptPromise = agent.prompt("hello").then(() => {
			promptResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(promptResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await promptPromise;

		expect(listenerFinished).toBe(true);
		expect(promptResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("can commit only a prefix of a prompt batch when a listener fails", async () => {
		const agent = new Agent();
		const first: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: Date.now(),
		};
		const second: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "second" }],
			timestamp: Date.now(),
		};
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message === first) {
				throw new Error("listener failed between batched messages");
			}
		});

		await agent.prompt([first, second]);

		expect(agent.state.messages).toContain(first);
		expect(agent.state.messages).not.toContain(second);
		expect(agent.state.errorMessage).toBe("listener failed between batched messages");
	});

	it("waitForIdle should wait for async subscribers", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				await barrier.promise;
			}
		});

		const promptPromise = agent.prompt("hello");
		let idleResolved = false;
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("should pass the active abort signal to subscribers", async () => {
		let receivedSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		agent.subscribe((event, signal) => {
			if (event.type === "agent_start") {
				receivedSignal = signal;
			}
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);

		agent.abort();
		await promptPromise;

		expect(receivedSignal?.aborted).toBe(true);
	});

	it("should update state with mutators", () => {
		const agent = new Agent();

		agent.state.systemPrompt = "Custom prompt";
		expect(agent.state.systemPrompt).toBe("Custom prompt");

		const newModel = getModel("google", "gemini-2.5-flash");
		agent.state.model = newModel;
		expect(agent.state.model).toBe(newModel);

		agent.state.thinkingLevel = "high";
		expect(agent.state.thinkingLevel).toBe("high");

		const tools = [{ name: "test", description: "test tool" } as any];
		agent.state.tools = tools;
		expect(agent.state.tools).toEqual(tools);
		expect(agent.state.tools).not.toBe(tools); // Should be a copy

		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		agent.state.messages = messages;
		expect(agent.state.messages).toEqual(messages);
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		const newMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi" }] };
		agent.state.messages.push(newMessage as any);
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[1]).toBe(newMessage);

		agent.state.messages = [];
		expect(agent.state.messages).toEqual([]);
	});

	it("should support steering message queue", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Steering message", timestamp: Date.now() };
		agent.steer(message);

		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should support follow-up message queue", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Follow-up message", timestamp: Date.now() };
		agent.followUp(message);

		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should handle abort controller", () => {
		const agent = new Agent();

		expect(() => agent.abort()).not.toThrow();
	});

	it("should settle when aborting a stream that ignores the abort signal", async () => {
		let streamStarted = () => {};
		const streamStartedPromise = new Promise<void>((resolve) => {
			streamStarted = resolve;
		});
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					streamStarted();
				});
				return stream;
			},
		});

		const promptPromise = agent.prompt("hello");
		await streamStartedPromise;

		agent.abort();
		await agent.waitForIdle();
		await promptPromise;

		expect(agent.state.isStreaming).toBe(false);
		const lastMessage = agent.state.messages.at(-1);
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});

	it("should settle when aborting a tool that ignores the abort signal", async () => {
		let toolStarted = () => {};
		const toolStartedPromise = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const schema = Type.Object({});
		const hangingTool: AgentTool<typeof schema, Record<string, never>> = {
			name: "hang",
			label: "hang",
			description: "Never resolves",
			parameters: schema,
			execute: () => new Promise(() => {}),
		};
		const agent = new Agent({
			initialState: {
				tools: [hangingTool],
			},
			toolExecution: "sequential",
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "toolUse", message: createToolUseMessage("hang") });
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				toolStarted();
			}
		});

		const promptPromise = agent.prompt("hello");
		await toolStartedPromise;

		agent.abort();
		await agent.waitForIdle();
		await promptPromise;

		const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
			expect(toolResult.content).toEqual([{ type: "text", text: "Tool execution aborted" }]);
		}
		expect(agent.state.pendingToolCalls.size).toBe(0);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("should preserve the original failure when the recovery agent_end listener throws", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
			if (event.type === "agent_end") {
				throw new Error("agent_end listener failed");
			}
			if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant") {
				throw new Error("original listener failure");
			}
		});

		await expect(agent.prompt("hello")).resolves.toBeUndefined();

		expect(events).toContain("agent_end");
		expect(agent.state.errorMessage).toBe("original listener failure");
		const lastMessage = agent.state.messages.at(-1);
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("error");
			expect(lastMessage.errorMessage).toBe("original listener failure");
		}
		expect(agent.state.isStreaming).toBe(false);
	});

	it("should not drain steering messages when aborting before a queued poll", async () => {
		const controller = new AbortController();
		controller.abort();
		const queuedMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "queued" }],
			timestamp: Date.now(),
		};
		const getSteeringMessages = vi.fn(async () => [queuedMessage]);
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: getModel("openai", "gpt-4o-mini"),
			convertToLlm: () => [],
			getSteeringMessages,
		};

		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() }],
			context,
			config,
			controller.signal,
		);
		for await (const _event of stream) {
		}

		expect(await stream.result()).toEqual([]);
		expect(getSteeringMessages).not.toHaveBeenCalled();
	});

	it("should end the event stream when abort rejects the loop", async () => {
		const controller = new AbortController();
		controller.abort();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: getModel("openai", "gpt-4o-mini"),
			convertToLlm: () => [],
		};

		const events: unknown[] = [];
		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() }],
			context,
			config,
			controller.signal,
		);
		for await (const event of stream) {
			events.push(event);
		}

		await expect(stream.result()).resolves.toEqual([]);
		expect(events.some((event) => (event as { type?: string }).type === "agent_end")).toBe(false);
	});

	it("should throw when prompt() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const firstPrompt = agent.prompt("First message");

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		await expect(agent.prompt("Second message")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		agent.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("should throw when continue() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const firstPrompt = agent.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		await expect(agent.continue()).rejects.toMatchObject({
			name: "AgentContinueError",
			code: "busy",
			message: "Agent is already processing. Wait for completion before continuing.",
		});

		agent.abort();
		await firstPrompt.catch(() => {});
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it("continue() should keep one-at-a-time steering semantics from assistant tail", async () => {
		let responseCount = 0;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				responseCount++;
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(`Processed ${responseCount}`),
					});
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(responseCount).toBe(2);
	});

	it("keeps queued message batches atomic in one-at-a-time mode", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		const prefix = { role: "user" as const, content: "Prefix", timestamp: Date.now() };
		const prompt = { role: "user" as const, content: "Prompt", timestamp: Date.now() + 1 };
		const next = { role: "user" as const, content: "Next", timestamp: Date.now() + 2 };
		agent.state.messages = [createAssistantMessage("Initial response")];
		agent.followUp([prefix, prompt]);
		agent.followUp(next);

		await agent.continue();

		expect(agent.state.messages.slice(1).map((message) => message.role)).toEqual([
			"user",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("removes a whole queued batch when one message matches", () => {
		const agent = new Agent();
		const prefix = { role: "user" as const, content: "Prefix", timestamp: Date.now() };
		const prompt = { role: "user" as const, content: "Prompt", timestamp: Date.now() + 1 };
		const next = { role: "user" as const, content: "Next", timestamp: Date.now() + 2 };
		agent.followUp([prefix, prompt]);
		agent.followUp(next);

		expect(agent.removeQueuedMessages((message) => message === prompt)).toEqual([prefix, prompt]);
		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("forwards sessionId to streamFn options", async () => {
		let receivedSessionId: string | undefined;
		const agent = new Agent({
			sessionId: "session-abc",
			streamFn: (_model, _context, options) => {
				receivedSessionId = options?.sessionId;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("ok");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedSessionId).toBe("session-abc");

		agent.sessionId = "session-def";
		expect(agent.sessionId).toBe("session-def");

		await agent.prompt("hello again");
		expect(receivedSessionId).toBe("session-def");
	});

	it("forwards the service tier to streamFn options", async () => {
		let receivedServiceTier: string | null | undefined;
		const agent = new Agent({
			initialState: { serviceTier: "priority" },
			streamFn: (_model, _context, options) => {
				receivedServiceTier = options?.serviceTier;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedServiceTier).toBe("priority");
	});
});
