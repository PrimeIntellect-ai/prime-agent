import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCronJob } from "../../src/core/cron-jobs.js";
import type { ExtensionAPI } from "../../src/index.js";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";

function createDeferred<T = void>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function createHeartbeat(): AgentCronJob {
	return {
		id: "heartbeat-1",
		status: "active",
		source: "heartbeat",
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		prompt: "Check whether the long-running task needs another step.",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: "2026-01-01T00:05:00.000Z",
		runCount: 2,
	};
}

describe("AgentSession model and extension characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("setModel saves the model and emits model_select", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						modelEvents.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(modelEvents).toEqual(["faux-1->faux-2:set"]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual([`${nextModel.provider}/${nextModel.id}`]);
	});

	it("can save the model before slow model_select handlers finish", async () => {
		const handlerStarted = createDeferred();
		const finishHandler = createDeferred();
		let handlerCompleted = false;
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async () => {
						handlerStarted.resolve();
						await finishHandler.promise;
						handlerCompleted = true;
					});
				},
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel, { waitForExtensions: false });
		await handlerStarted.promise;

		expect(harness.session.model?.id).toBe("faux-2");
		expect(handlerCompleted).toBe(false);

		finishHandler.resolve();
		await flushAsyncWork();

		expect(handlerCompleted).toBe(true);
	});

	it("serializes nonblocking model_select handlers across quick switches", async () => {
		const firstHandlerStarted = createDeferred();
		const finishFirstHandler = createDeferred();
		const events: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						events.push(`start:${event.model.id}`);
						if (event.model.id === "faux-2") {
							firstHandlerStarted.resolve();
							await finishFirstHandler.promise;
						}
						events.push(`end:${event.model.id}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		await firstHandlerStarted.promise;
		await harness.session.setModel(harness.getModel("faux-3")!, { waitForExtensions: false });
		await flushAsyncWork();

		expect(harness.session.model?.id).toBe("faux-3");
		expect(events).toEqual(["start:faux-2"]);

		finishFirstHandler.resolve();
		await flushAsyncWork();
		await flushAsyncWork();

		expect(events).toEqual(["start:faux-2", "end:faux-2", "start:faux-3", "end:faux-3"]);
	});

	it("queues cycle model_select handlers behind pending nonblocking switches", async () => {
		const firstHandlerStarted = createDeferred();
		const finishFirstHandler = createDeferred();
		const events: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						events.push(`start:${event.model.id}`);
						if (event.model.id === "faux-2") {
							firstHandlerStarted.resolve();
							await finishFirstHandler.promise;
						}
						events.push(`end:${event.model.id}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		await firstHandlerStarted.promise;

		let cycleResolved = false;
		const cycle = harness.session.cycleModel().then((result) => {
			cycleResolved = true;
			return result;
		});
		await flushAsyncWork();

		expect(cycleResolved).toBe(false);
		expect(events).toEqual(["start:faux-2"]);

		finishFirstHandler.resolve();
		const result = await cycle;

		expect(result?.model.id).toBe("faux-3");
		expect(events).toEqual(["start:faux-2", "end:faux-2", "start:faux-3", "end:faux-3"]);
	});

	it("can cycle models before slow model_select handlers finish", async () => {
		const handlerStarted = createDeferred();
		const finishHandler = createDeferred();
		let handlerCompleted = false;
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async () => {
						handlerStarted.resolve();
						await finishHandler.promise;
						handlerCompleted = true;
					});
				},
			],
		});
		harnesses.push(harness);

		const result = await harness.session.cycleModel("forward", { waitForExtensions: false });
		await handlerStarted.promise;

		expect(result?.model.id).toBe("faux-2");
		expect(harness.session.model?.id).toBe("faux-2");
		expect(handlerCompleted).toBe(false);

		finishHandler.resolve();
		await flushAsyncWork();

		expect(handlerCompleted).toBe(true);
	});

	it("waits for pending model_select handlers before starting the next prompt", async () => {
		const handlerStarted = createDeferred();
		const finishHandler = createDeferred();
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async () => {
						handlerStarted.resolve();
						await finishHandler.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("after model select")]);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		await handlerStarted.promise;

		const prompt = harness.session.prompt("hi");
		await flushAsyncWork();

		expect(getAssistantTexts(harness)).not.toContain("after model select");

		finishHandler.resolve();
		await prompt;

		expect(getAssistantTexts(harness)).toContain("after model select");
	});

	it("includes nextTurn messages queued by pending model_select handlers in the next prompt", async () => {
		const handlerStarted = createDeferred();
		const finishHandler = createDeferred();
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async () => {
						handlerStarted.resolve();
						await finishHandler.promise;
						await pi.sendMessage(
							{
								customType: "model-context",
								content: "model context",
								display: false,
							},
							{ deliverAs: "nextTurn" },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("after model context")]);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		await handlerStarted.promise;

		const prompt = harness.session.prompt("hi");
		await flushAsyncWork();

		expect(harness.session.messages).toHaveLength(0);

		finishHandler.resolve();
		await prompt;
		for (let i = 0; i < 5 && !getAssistantTexts(harness).includes("after model context"); i++) {
			await flushAsyncWork();
		}

		expect(
			harness.session.messages.slice(0, 2).map((message) => ({ role: message.role, text: getMessageText(message) })),
		).toEqual([
			{ role: "custom", text: "model context" },
			{ role: "user", text: "hi" },
		]);
		expect(getAssistantTexts(harness)).toContain("after model context");
	});

	it("includes nextTurn messages queued by pending model_select handlers in accepted prompts", async () => {
		const handlerStarted = createDeferred();
		const finishHandler = createDeferred();
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async () => {
						handlerStarted.resolve();
						await finishHandler.promise;
						await pi.sendMessage(
							{
								customType: "model-context",
								content: "accepted model context",
								display: false,
							},
							{ deliverAs: "nextTurn" },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("accepted")]);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		await handlerStarted.promise;

		const accepted = harness.session.acceptAgentMessagePrompt("agent-to-agent payload", {
			expandPromptTemplates: false,
		});
		await flushAsyncWork();

		expect(harness.session.messages).toHaveLength(0);

		finishHandler.resolve();
		await accepted;
		await harness.session.agent.waitForIdle();

		expect(
			harness.session.messages.slice(0, 2).map((message) => ({ role: message.role, text: getMessageText(message) })),
		).toEqual([
			{ role: "custom", text: "accepted model context" },
			{ role: "user", text: "agent-to-agent payload" },
		]);
		expect(getAssistantTexts(harness)).toContain("accepted");
	});

	it("keeps streaming injected prompts under turn admission when the turn becomes idle", async () => {
		const toolStarted = createDeferred();
		const finishTool = createDeferred();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.resolve();
				await finishTool.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("heartbeat"),
		]);

		const turn = harness.session.prompt("start");
		await toolStarted.promise;
		await harness.session.promptHeartbeat(createHeartbeat(), { streamingBehavior: "followUp" });

		finishTool.resolve();
		await turn;
		await harness.session.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["", "turn complete", "heartbeat"]);
	});

	it("includes nextTurn messages queued by pending model_select handlers in injected prompts", async () => {
		const handlerStarted = createDeferred();
		const finishHandler = createDeferred();
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async () => {
						handlerStarted.resolve();
						await finishHandler.promise;
						await pi.sendMessage(
							{
								customType: "model-context",
								content: "heartbeat model context",
								display: false,
							},
							{ deliverAs: "nextTurn" },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("heartbeat")]);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		await handlerStarted.promise;

		const heartbeat = harness.session.promptHeartbeat(createHeartbeat());
		await flushAsyncWork();

		expect(harness.session.messages).toHaveLength(0);

		finishHandler.resolve();
		await heartbeat;
		await harness.session.agent.waitForIdle();

		expect(
			harness.session.messages.slice(0, 2).map((message) => ({ role: message.role, text: getMessageText(message) })),
		).toEqual([
			{ role: "custom", text: "heartbeat model context" },
			{ role: "custom", text: "Check whether the long-running task needs another step." },
		]);
		expect(getAssistantTexts(harness)).toContain("heartbeat");
	});

	it("allows model_select handlers to enqueue user messages without waiting on themselves", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", () => {
						pi.sendUserMessage("from model_select");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("queued from hook")]);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		for (let i = 0; i < 5 && !getAssistantTexts(harness).includes("queued from hook"); i++) {
			await flushAsyncWork();
		}

		expect(getAssistantTexts(harness)).toContain("queued from hook");
	});

	it("allows model_select handlers to switch models without waiting on themselves", async () => {
		const events: string[] = [];
		let harness: Harness;
		harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						events.push(`start:${event.model.id}`);
						if (event.model.id === "faux-2") {
							await harness.session.setModel(harness.getModel("faux-3")!);
							events.push("nested-returned");
						}
						events.push(`end:${event.model.id}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!);
		for (let i = 0; i < 5 && !events.includes("end:faux-3"); i++) {
			await flushAsyncWork();
		}

		expect(harness.session.model?.id).toBe("faux-3");
		expect(events).toEqual(["start:faux-2", "nested-returned", "end:faux-2", "start:faux-3", "end:faux-3"]);
	});

	it("cycles through scoped models and preserves the scoped thinking preference", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);
		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;
		harness.session.setScopedModels([{ model: modelOne, thinkingLevel: "high" }, { model: modelTwo }] as Array<{
			model: Model<string>;
			thinkingLevel?: ThinkingLevel;
		}>);
		harness.session.setThinkingLevel("high");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.thinkingLevel).toBe("off");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("clamps thinking levels to model capabilities and cycles available levels", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: false }] });
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.session.cycleThinkingLevel()).toBeUndefined();
	});

	it("throws when setModel is called without configured auth", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			`No API key for ${harness.getModel().provider}/faux-2`,
		);
	});

	it("allows extension tool_call handlers to block tool execution", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => ({ block: true, reason: "Blocked by test" }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const errorText =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(errorText);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Blocked by test");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("allows extension tool_result handlers to modify tool results", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async () => ({
						content: [{ type: "text", text: "patched result" }],
						details: { patched: true },
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(text);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("patched result");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.details?.patched === true),
		).toBeDefined();
	});

	it("allows extension context handlers to modify messages before the LLM call", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user"
								? { ...message, content: [{ type: "text", text: "rewritten" }], timestamp: message.timestamp }
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerUserText = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("original");

		expect(providerUserText).toBe("rewritten");
		const storedUserMessage = harness.session.messages.find((message) => message.role === "user");
		expect(storedUserMessage?.role).toBe("user");
		if (storedUserMessage?.role === "user") {
			expect(storedUserMessage.content).toEqual([{ type: "text", text: "original" }]);
		}
	});

	it("allows extension input handlers to transform or handle input", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const transformedHarness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("input", async (event) => {
						if (event.text === "ping") {
							return { action: "handled" };
						}
						return { action: "transform", text: `transformed:${event.text}` };
					});
				},
			],
		});
		harnesses.push(transformedHarness);
		let providerUserText = "";
		transformedHarness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await transformedHarness.session.prompt("hello");
		await transformedHarness.session.prompt("ping");

		expect(providerUserText).toBe("transformed:hello");
		expect(transformedHarness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(extensionApi).toBeDefined();
	});

	it("allows before_agent_start handlers to inject custom messages and modify the system prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						message: {
							customType: "before-start",
							content: "injected",
							display: true,
							details: { injected: true },
						},
						systemPrompt: `${event.systemPrompt}\n\nextra instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		let sawInjectedUserMessage = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				sawInjectedUserMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "injected"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain("extra instructions");
		expect(sawInjectedUserMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "before-start"),
		).toBe(true);
	});

	it("bindExtensions emits session_start and reload emits session_shutdown then session_start", async () => {
		const lifecycleEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (event) => {
						lifecycleEvents.push(`start:${event.reason}`);
					});
					pi.on("session_shutdown", async (event) => {
						lifecycleEvents.push(`shutdown:${event.reason}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.reload();

		expect(lifecycleEvents).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});
});
