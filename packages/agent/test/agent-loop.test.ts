import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue, runAgentLoop } from "../src/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

// Mock stream for testing - mimics MockAssistantStream
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

class DelayedResultStream extends MockAssistantStream {
	constructor(private readonly getDelayedResult: () => Promise<AssistantMessage>) {
		super();
	}

	override result(): Promise<AssistantMessage> {
		return this.getDelayedResult();
	}
}

class ThrowingResultStream extends MockAssistantStream {
	constructor(
		private readonly onResult: () => void,
		private readonly error: Error,
	) {
		super();
	}

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		return {
			next: async () => ({ done: true, value: undefined as never }),
		};
	}

	override result(): Promise<AssistantMessage> {
		this.onResult();
		throw this.error;
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("agentLoop with AgentMessage", () => {
	it("should preserve a terminal response when abort fires after done", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};
		const controller = new AbortController();
		const finalMessage = createAssistantMessage([{ type: "text", text: "complete" }]);
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		const streamFn = () => {
			const stream = new DelayedResultStream(() => {
				controller.abort();
				return Promise.resolve(finalMessage);
			});
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: finalMessage });
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("Hello")], context, config, controller.signal, streamFn);
		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		const assistant = messages.find((message) => message.role === "assistant");
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role === "assistant") {
			expect(assistant.stopReason).toBe("stop");
			expect(assistant.content).toEqual([{ type: "text", text: "complete" }]);
		}
	});

	it("should not wait for a pending terminal result after abort", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};
		const controller = new AbortController();
		const finalMessage = createAssistantMessage([{ type: "text", text: "complete" }]);
		let resolveResult: ((message: AssistantMessage) => void) | undefined;
		const pendingResult = new Promise<AssistantMessage>((resolve) => {
			resolveResult = resolve;
		});
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		const streamFn = () => {
			const stream = new DelayedResultStream(() => {
				controller.abort();
				return pendingResult;
			});
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: finalMessage });
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("Hello")], context, config, controller.signal, streamFn);
		const events: AgentEvent[] = [];
		const consume = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
			return stream.result();
		})();
		const result = await Promise.race([
			consume,
			new Promise<"timeout">((resolve) => {
				setTimeout(() => resolve("timeout"), 50);
			}),
		]);
		if (result === "timeout") {
			resolveResult?.(finalMessage);
			await consume;
			throw new Error("agent loop waited for a pending terminal result after abort");
		}

		const assistant = result.find((message) => message.role === "assistant");
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role === "assistant") {
			expect(assistant.stopReason).toBe("stop");
			expect(assistant.content).toEqual([{ type: "text", text: "complete" }]);
		}
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
	});

	it("should not mask stream result errors when abort is already signaled", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};
		const controller = new AbortController();
		const providerError = new Error("provider parse failed");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		const events: AgentEvent[] = [];

		await expect(
			runAgentLoop(
				[createUserMessage("Hello")],
				context,
				config,
				(event) => {
					events.push(event);
				},
				controller.signal,
				() =>
					new ThrowingResultStream(() => {
						controller.abort();
					}, providerError),
			),
		).rejects.toThrow("provider parse failed");
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.stopReason === "aborted",
			),
		).toBe(false);
	});

	it("should return an aborted assistant when abort fires before the stream starts", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};
		const controller = new AbortController();
		const streamFn = vi.fn(() => new MockAssistantStream());
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				controller.abort();
				return identityConverter(messages);
			},
		};

		const stream = agentLoop([createUserMessage("Hello")], context, config, controller.signal, streamFn);
		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		const assistant = messages.find((message) => message.role === "assistant");
		expect(streamFn).not.toHaveBeenCalled();
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role === "assistant") {
			expect(assistant.stopReason).toBe("aborted");
			expect(assistant.errorMessage).toBe("Request was aborted");
		}
	});

	it("should end without adding an aborted assistant when abort fires after turn completion", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};
		const controller = new AbortController();
		const finalMessage = createAssistantMessage([{ type: "text", text: "complete" }]);
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			shouldStopAfterTurn: async () => {
				controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 0));
				return false;
			},
		};
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: finalMessage });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("Hello")], context, config, controller.signal, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		const assistantMessages = messages.filter((message) => message.role === "assistant");

		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0]?.role).toBe("assistant");
		if (assistantMessages[0]?.role === "assistant") {
			expect(assistantMessages[0].stopReason).toBe("stop");
			expect(assistantMessages[0].content).toEqual([{ type: "text", text: "complete" }]);
		}
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("should not invoke tools when the signal aborts before tool execution", async () => {
		const controller = new AbortController();
		const toolExecute: AgentTool["execute"] = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "should not run" }],
			details: {},
		}));
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [
				{
					name: "wait",
					label: "Wait",
					description: "Wait",
					parameters: Type.Object({}),
					execute: toolExecute,
				},
			],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async () => {
				controller.abort();
				return undefined;
			},
		};
		const assistantMessage = createAssistantMessage(
			[{ type: "toolCall", id: "tool_1", name: "wait", arguments: {} }],
			"toolUse",
		);
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "toolUse", message: assistantMessage });
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("Hello")], context, config, controller.signal, streamFn);
		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		expect(toolExecute).not.toHaveBeenCalled();
	});

	it("should stop a sequential tool batch after aborting a tool call", async () => {
		const controller = new AbortController();
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "work",
			label: "Work",
			description: "Work",
			parameters: toolSchema,
			execute: async (_toolCallId, params) => {
				executed.push(params.value);
				if (params.value === "first") {
					controller.abort();
				}
				return {
					content: [{ type: "text", text: `done:${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
		};
		const assistantMessage = createAssistantMessage(
			[
				{ type: "toolCall", id: "tool_1", name: "work", arguments: { value: "first" } },
				{ type: "toolCall", id: "tool_2", name: "work", arguments: { value: "second" } },
			],
			"toolUse",
		);
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "toolUse", message: assistantMessage });
			});
			return stream;
		};
		const events: AgentEvent[] = [];

		await runAgentLoop(
			[createUserMessage("Hello")],
			context,
			config,
			(event) => {
				events.push(event);
			},
			controller.signal,
			streamFn,
		);

		const toolStartIds = events.flatMap((event) => (event.type === "tool_execution_start" ? [event.toolCallId] : []));
		const toolResultIds = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "toolResult" ? [event.message.toolCallId] : [],
		);

		expect(executed).toEqual(["first"]);
		expect(toolStartIds).toEqual(["tool_1"]);
		expect(toolResultIds).toEqual(["tool_1"]);
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
	});

	it("should preserve a successful tool result when abort fires during update flush", async () => {
		const controller = new AbortController();
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "work",
			label: "Work",
			description: "Work",
			parameters: toolSchema,
			execute: async (_toolCallId, _params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "progress" }], details: {} });
				return {
					content: [{ type: "text", text: "done" }],
					details: {},
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
		};
		const assistantMessage = createAssistantMessage(
			[{ type: "toolCall", id: "tool_1", name: "work", arguments: {} }],
			"toolUse",
		);
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "toolUse", message: assistantMessage });
			});
			return stream;
		};
		const events: AgentEvent[] = [];

		const messages = await runAgentLoop(
			[createUserMessage("Hello")],
			context,
			config,
			(event) => {
				events.push(event);
				if (event.type === "tool_execution_update") {
					return new Promise<void>(() => {
						setTimeout(() => controller.abort(), 0);
					});
				}
			},
			controller.signal,
			streamFn,
		);

		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(false);
			expect(toolResult.content).toEqual([{ type: "text", text: "done" }]);
		}
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
	});

	it("should freeze synthetic aborted messages against later partial mutation", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};
		const controller = new AbortController();
		const partialMessage = createAssistantMessage([{ type: "text", text: "partial" }]);
		partialMessage.usage.cost.total = 1;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: partialMessage });
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("Hello")], context, config, controller.signal, streamFn);
		for await (const event of stream) {
			if (event.type === "message_start" && event.message.role === "assistant") {
				controller.abort();
			}
		}

		const messages = await stream.result();
		const assistant = messages.find((message) => message.role === "assistant");
		const text = partialMessage.content[0];
		if (text?.type === "text") {
			text.text = "mutated";
		}
		partialMessage.usage.cost.total = 99;

		expect(assistant?.role).toBe("assistant");
		if (assistant?.role === "assistant") {
			expect(assistant.stopReason).toBe("aborted");
			expect(assistant.content).toEqual([{ type: "text", text: "partial" }]);
			expect(assistant.usage.cost.total).toBe(1);
		}
	});

	it("should handle custom message types via convertToLlm", async () => {
		// Create a custom message type
		interface CustomNotification {
			role: "notification";
			text: string;
			timestamp: number;
		}

		const notification: CustomNotification = {
			role: "notification",
			text: "This is a notification",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [notification as unknown as AgentMessage], // Custom message in context
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		let convertedMessages: Message[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Filter out notifications, convert rest
				convertedMessages = messages
					.filter((m) => (m as { role: string }).role !== "notification")
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// The notification should have been filtered out in convertToLlm
		expect(convertedMessages.length).toBe(1); // Only user message
		expect(convertedMessages[0].role).toBe("user");
	});

	it("should resolve the system prompt after asynchronous API key lookup", async () => {
		let systemPrompt = "before lookup";
		let resolveApiKey: ((apiKey: string) => void) | undefined;
		const apiKey = new Promise<string>((resolve) => {
			resolveApiKey = resolve;
		});
		let markLookupStarted: (() => void) | undefined;
		const lookupStarted = new Promise<void>((resolve) => {
			markLookupStarted = resolve;
		});
		let providerSystemPrompt: string | undefined;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getApiKey: async () => {
				markLookupStarted?.();
				return apiKey;
			},
			getSystemPrompt: () => systemPrompt,
		};
		const stream = agentLoop(
			[createUserMessage("Hello")],
			{ systemPrompt: "fallback", messages: [], tools: [] },
			config,
			undefined,
			(_model, context, options) => {
				providerSystemPrompt = context.systemPrompt;
				expect(options?.apiKey).toBe("resolved key");
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "Response" }]),
					});
				});
				return mockStream;
			},
		);
		const consume = (async () => {
			for await (const _event of stream) {
				// consume
			}
		})();

		await lookupStarted;
		systemPrompt = "after lookup";
		resolveApiKey?.("resolved key");
		await consume;

		expect(providerSystemPrompt).toBe("after lookup");
	});

	it("should apply transformContext before convertToLlm", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [
				createUserMessage("old message 1"),
				createAssistantMessage([{ type: "text", text: "old response 1" }]),
				createUserMessage("old message 2"),
				createAssistantMessage([{ type: "text", text: "old response 2" }]),
			],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("new message");

		let transformedMessages: AgentMessage[] = [];
		let convertedMessages: Message[] = [];

		const config: AgentLoopConfig = {
			model: createModel(),
			transformContext: async (messages) => {
				// Keep only last 2 messages (prune old ones)
				transformedMessages = messages.slice(-2);
				return transformedMessages;
			},
			convertToLlm: (messages) => {
				convertedMessages = messages.filter(
					(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				) as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const _ of stream) {
			// consume
		}

		// transformContext should have been called first, keeping only last 2
		expect(transformedMessages.length).toBe(2);
		// Then convertToLlm receives the pruned messages
		expect(convertedMessages.length).toBe(2);
	});

	it("should execute mutated beforeToolCall args without revalidation", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: Array<string | number> = [];
		const tool: AgentTool<typeof toolSchema, { value: string | number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value as string | number);
				return {
					content: [{ type: "text", text: `echoed: ${String(params.value)}` }],
					details: { value: params.value as string | number },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async ({ args }) => {
				const mutableArgs = args as { value: string | number };
				mutableArgs.value = 123;
				return undefined;
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([123]);
	});

	it("should prepare tool arguments for validation", async () => {
		const replaceSchema = Type.Object({ oldText: Type.String(), newText: Type.String() });
		const toolSchema = Type.Object({ edits: Type.Array(replaceSchema) });
		const executed: Array<Array<{ oldText: string; newText: string }>> = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "edit",
			label: "Edit",
			description: "Edit tool",
			parameters: toolSchema,
			prepareArguments(args) {
				if (!args || typeof args !== "object") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				const input = args as {
					edits?: Array<{ oldText: string; newText: string }>;
					oldText?: string;
					newText?: string;
				};
				if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				return {
					edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
				};
			},
			async execute(_toolCallId, params) {
				executed.push(params.edits);
				return {
					content: [{ type: "text", text: `edited ${params.edits.length}` }],
					details: { count: params.edits.length },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("edit something");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "edit",
								arguments: { oldText: "before", newText: "after" },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([[{ oldText: "before", newText: "after" }]]);
	});

	it("should emit tool_execution_end in completion order but persist tool results in source order", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolExecutionEndIds = events.flatMap((event) => {
			if (event.type !== "tool_execution_end") {
				return [];
			}
			return [event.toolCallId];
		});
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		const turnToolResultIds = events.flatMap((event) => {
			if (event.type !== "turn_end") {
				return [];
			}
			return event.toolResults.map((toolResult) => toolResult.toolCallId);
		});

		expect(parallelObserved).toBe(true);
		expect(toolExecutionEndIds).toEqual(["tool-2", "tool-1"]);
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should inject queued messages after all tool calls complete", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("start");
		const queuedUserMessage: AgentMessage = createUserMessage("interrupt");

		let queuedDelivered = false;
		let callIndex = 0;
		let sawInterruptInContext = false;

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
			getSteeringMessages: async () => {
				// Return steering message after tool execution has started.
				if (executed.length >= 1 && !queuedDelivered) {
					queuedDelivered = true;
					return [queuedUserMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, (_model, ctx, _options) => {
			// Check if interrupt message is in context on second call
			if (callIndex === 1) {
				sawInterruptInContext = ctx.messages.some(
					(m) => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
				);
			}

			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return two tool calls
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const event of stream) {
			events.push(event);
		}

		// Both tools should execute before steering is injected
		expect(executed).toEqual(["first", "second"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(false);

		// Queued message should appear in events after both tool result messages
		const eventSequence = events.flatMap((event) => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence).toContain("interrupt");
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		expect(sawInterruptInContext).toBe(true);
	});

	it("should inject continuation messages when the agent would otherwise stop", async () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [],
		};

		let continuationPolls = 0;
		let sawContinuationInContext = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getContinuationMessages: async ({ message }) => {
				continuationPolls++;
				expect(message.role).toBe("assistant");
				if (continuationPolls === 1) {
					return [createUserMessage("continue")];
				}
				return [];
			},
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, (_model, ctx) => {
			if (callIndex === 1) {
				sawContinuationInContext = ctx.messages.some(
					(message) => message.role === "user" && message.content === "continue",
				);
			}
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: callIndex === 0 ? "paused" : "done" }]);
				mockStream.push({ type: "done", reason: "stop", message });
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		expect(callIndex).toBe(2);
		expect(continuationPolls).toBe(2);
		expect(sawContinuationInContext).toBe(true);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
	});

	it("should prefer explicit follow-up messages before continuation messages", async () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [],
		};

		let followUpDelivered = false;
		let continuationPolls = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getFollowUpMessages: async () => {
				if (followUpDelivered) {
					return [];
				}
				followUpDelivered = true;
				return [createUserMessage("follow up")];
			},
			getContinuationMessages: async () => {
				continuationPolls++;
				return [];
			},
		};

		let callIndex = 0;
		let sawFollowUpInContext = false;
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, (_model, ctx) => {
			if (callIndex === 1) {
				sawFollowUpInContext = ctx.messages.some(
					(message) => message.role === "user" && message.content === "follow up",
				);
			}
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: callIndex === 0 ? "paused" : "done" }]);
				mockStream.push({ type: "done", reason: "stop", message });
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(callIndex).toBe(2);
		expect(continuationPolls).toBe(1);
		expect(sawFollowUpInContext).toBe(true);
	});

	it("should force sequential execution when a tool has executionMode=sequential even with default parallel config", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		// config is parallel (default), but tool forces sequential
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "slow", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With sequential execution, second tool should NOT start before first finishes
		expect(parallelObserved).toBe(false);

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should force sequential execution when one of multiple tools has executionMode=sequential", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executionOrder: string[] = [];
		let releaseSlow: (() => void) | undefined;
		const slowDone = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				executionOrder.push(`slow:${params.value}`);
				if (params.value === "a") {
					await slowDone;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const fastTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "fast",
			label: "Fast",
			description: "Fast tool",
			parameters: toolSchema,
			// no executionMode = defaults to parallel
			async execute(_toolCallId, params) {
				executionOrder.push(`fast:${params.value}`);
				return {
					content: [{ type: "text", text: `fast: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool, fastTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			// parallel by default, but slowTool forces sequential
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "a" } },
							{ type: "toolCall", id: "tool-2", name: "fast", arguments: { value: "b" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseSlow?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Fast tool should NOT run before slow tool finishes
		expect(executionOrder[0]).toBe("slow:a");
		expect(executionOrder).toContain("fast:b");
	});

	it("should allow parallel execution when all tools have executionMode=parallel", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With executionMode=parallel, second tool should start before first finishes
		expect(parallelObserved).toBe(true);
	});

	const naturalCompletionCases: Array<{
		name: string;
		stopBefore: "always" | "afterTurn" | "never";
		steerOnce?: boolean;
		naturalWork?: boolean;
		expected: { llmCalls: number; stopChecks?: number; steeringPolls?: number; naturalPolls?: number };
	}> = [
		{
			name: "stops only after completing the initial turn",
			stopBefore: "always",
			expected: { llmCalls: 1, stopChecks: 1 },
		},
		{
			name: "observes a stop requested after the turn before polling steering",
			stopBefore: "afterTurn",
			expected: { llmCalls: 1, steeringPolls: 1 },
		},
		{
			name: "stops before polling natural-completion work",
			stopBefore: "always",
			naturalWork: true,
			expected: { llmCalls: 1, naturalPolls: 0 },
		},
		{
			name: "continues with steering when no stop is requested",
			stopBefore: "never",
			steerOnce: true,
			expected: { llmCalls: 2 },
		},
	];

	it.each(naturalCompletionCases)("$name", async ({ stopBefore, steerOnce, naturalWork, expected }) => {
		let llmCalls = 0;
		let stopRequested = false;
		let steeringDelivered = false;
		const shouldStopBeforeTurn = vi.fn(() => stopBefore === "always" || stopRequested);
		const getSteeringMessages = vi.fn(async () => {
			if (steerOnce && llmCalls === 1 && !steeringDelivered) {
				steeringDelivered = true;
				return [createUserMessage("steer")];
			}
			return [];
		});
		const getFollowUpMessages = vi.fn(async () => (naturalWork ? [createUserMessage("follow up")] : []));
		const getContinuationMessages = vi.fn(async () => (naturalWork ? [createUserMessage("continue")] : []));
		const stream = agentLoop(
			[createUserMessage("start")],
			{ systemPrompt: "", messages: [], tools: [] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				shouldStopBeforeTurn,
				getSteeringMessages,
				getFollowUpMessages,
				getContinuationMessages,
				...(stopBefore === "afterTurn" && {
					shouldStopAfterTurn: async () => {
						await Promise.resolve();
						stopRequested = true;
						return false;
					},
				}),
			},
			undefined,
			() => {
				llmCalls++;
				const mockStream = new MockAssistantStream();
				queueMicrotask(() =>
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					}),
				);
				return mockStream;
			},
		);
		for await (const _event of stream) {
			// Drain the stream.
		}

		expect(llmCalls).toBe(expected.llmCalls);
		if (expected.stopChecks !== undefined) expect(shouldStopBeforeTurn).toHaveBeenCalledTimes(expected.stopChecks);
		if (expected.steeringPolls !== undefined)
			expect(getSteeringMessages).toHaveBeenCalledTimes(expected.steeringPolls);
		if (expected.naturalPolls !== undefined) {
			expect(getFollowUpMessages).toHaveBeenCalledTimes(expected.naturalPolls);
			expect(getContinuationMessages).toHaveBeenCalledTimes(expected.naturalPolls);
		}
	});

	it("rechecks a tool-cycle stop after polling steering", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }));
		let stopRequested = false;
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("start")],
			{
				systemPrompt: "",
				messages: [],
				tools: [{ name: "work", label: "Work", description: "Work", parameters: Type.Object({}), execute }],
			},
			{
				model: createModel(),
				convertToLlm: identityConverter,
				shouldStopBeforeTurn: () => stopRequested,
				getSteeringMessages: async () => {
					// Flip only on the post-tool-batch poll; the pre-loop poll would stop before the recheck runs.
					if (llmCalls > 0) stopRequested = true;
					return [];
				},
			},
			undefined,
			() => {
				llmCalls++;
				const mockStream = new MockAssistantStream();
				queueMicrotask(() =>
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "work", arguments: {} }],
							"toolUse",
						),
					}),
				);
				return mockStream;
			},
		);
		for await (const _event of stream) {
			// Drain the stream.
		}
		expect(llmCalls).toBe(1);
	});

	it("injects steering drained by the poll even when a stop flips during it", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }));
		let stopRequested = false;
		const injected: string[] = [];
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("start")],
			{
				systemPrompt: "",
				messages: [],
				tools: [{ name: "work", label: "Work", description: "Work", parameters: Type.Object({}), execute }],
			},
			{
				model: createModel(),
				convertToLlm: identityConverter,
				shouldStopBeforeTurn: () => stopRequested,
				getSteeringMessages: async () => {
					// Only the post-tool-batch poll returns steering; the stop flips during it.
					if (llmCalls !== 1 || stopRequested) return [];
					stopRequested = true;
					return [createUserMessage("late steer")];
				},
			},
			undefined,
			() => {
				llmCalls++;
				const mockStream = new MockAssistantStream();
				const calls = llmCalls;
				queueMicrotask(() =>
					mockStream.push({
						type: "done",
						reason: calls === 1 ? "toolUse" : "stop",
						message:
							calls === 1
								? createAssistantMessage(
										[{ type: "toolCall", id: "tool-1", name: "work", arguments: {} }],
										"toolUse",
									)
								: createAssistantMessage([{ type: "text", text: "steered reply" }], "stop"),
					}),
				);
				return mockStream;
			},
		);
		for await (const event of stream) {
			if (event.type === "message_end" && event.message.role === "user") {
				const text = event.message.content;
				if (typeof text !== "string") continue;
				injected.push(text);
			}
		}
		expect(injected).toContain("late steer");
		expect(llmCalls).toBe(2);
	});

	it("checks shouldStopBeforeTurn after a tool batch and before another model call", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }));
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [
				{
					name: "work",
					label: "Work",
					description: "Work",
					parameters: Type.Object({}),
					execute,
				},
			],
		};
		let llmCalls = 0;
		const stream = agentLoop(
			[createUserMessage("start")],
			context,
			{ model: createModel(), convertToLlm: identityConverter, shouldStopBeforeTurn: () => true },
			undefined,
			() => {
				llmCalls++;
				const mockStream = new MockAssistantStream();
				queueMicrotask(() =>
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "work", arguments: {} }],
							"toolUse",
						),
					}),
				);
				return mockStream;
			},
		);
		for await (const _event of stream) {
			// Drain the stream.
		}

		expect(execute).toHaveBeenCalledOnce();
		expect(llmCalls).toBe(1);
	});

	it("should stop after the current turn when shouldStopAfterTurn returns true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let steeringPolls = 0;
		let followUpPolls = 0;
		let callbackToolResultIds: string[] = [];
		let callbackContextRoles: string[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getSteeringMessages: async () => {
				steeringPolls++;
				return [];
			},
			getFollowUpMessages: async () => {
				followUpPolls++;
				return [createUserMessage("follow up should stay queued")];
			},
			shouldStopAfterTurn: async ({ message, toolResults, context }) => {
				expect(message.role).toBe("assistant");
				callbackToolResultIds = toolResults.map((toolResult) => toolResult.toolCallId);
				callbackContextRoles = context.messages.map((contextMessage) => contextMessage.role);
				return true;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(executed).toEqual(["hello"]);
		expect(steeringPolls).toBe(1);
		expect(followUpPolls).toBe(0);
		expect(callbackToolResultIds).toEqual(["tool-1"]);
		expect(callbackContextRoles).toEqual(["user", "assistant", "toolResult"]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("should stop after a tool batch when every tool result sets terminate=true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: true,
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
	});

	it("should continue after parallel tool calls when not all tool results terminate", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: params.value === "first",
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("echo both")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		expect(callIndex).toBe(2);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
	});

	it("should allow afterToolCall to mark a tool batch as terminating", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async () => ({ terminate: true }),
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
	});
});

describe("agentLoopContinue with AgentMessage", () => {
	it("should throw when context has no messages", () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		expect(() => agentLoopContinue(context, config)).toThrow("Cannot continue: no messages in context");
	});

	it("should continue from existing context without emitting user message events", async () => {
		const userMessage: AgentMessage = createUserMessage("Hello");

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [userMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBe(1);
		expect((messageEndEvents[0] as any).message.role).toBe("assistant");
	});

	it("should allow custom message types as last message (caller responsibility)", async () => {
		// Custom message that will be converted to user message by convertToLlm
		interface CustomMessage {
			role: "custom";
			text: string;
			timestamp: number;
		}

		const customMessage: CustomMessage = {
			role: "custom",
			text: "Hook content",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [customMessage as unknown as AgentMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Convert custom to user message
				return messages
					.map((m) => {
						if ((m as any).role === "custom") {
							return {
								role: "user" as const,
								content: (m as any).text,
								timestamp: m.timestamp,
							};
						}
						return m;
					})
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response to custom message" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		// Should not throw - the custom message will be converted to user message
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");
	});
});
