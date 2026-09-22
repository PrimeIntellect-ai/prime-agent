import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCronJob } from "../../src/core/cron-jobs.js";
import { conversationMessages, createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";

const MODELS = [
	{ id: "faux-1", name: "One", reasoning: true },
	{ id: "faux-2", name: "Two", reasoning: true },
	{ id: "faux-3", name: "Three", reasoning: true },
];

type Deferred<T = void> = {
	promise: Promise<T>;
	resolve(value: T): void;
};

function createDeferred<T = void>(): Deferred<T> {
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

	/** Harness whose model_select handler blocks until the returned deferred is resolved. */
	async function createSlowModelSelectHarness(options?: { nextTurnMessage?: string }): Promise<{
		harness: Harness;
		handlerStarted: Deferred;
		finishHandler: Deferred;
		handlerCompleted: () => boolean;
	}> {
		const handlerStarted = createDeferred();
		const finishHandler = createDeferred();
		let completed = false;
		const harness = await createHarness({
			models: MODELS.slice(0, 2),
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async () => {
						handlerStarted.resolve();
						await finishHandler.promise;
						completed = true;
						if (options?.nextTurnMessage) {
							await pi.sendMessage(
								{ customType: "model-context", content: options.nextTurnMessage, display: false },
								{ deliverAs: "nextTurn" },
							);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		return { harness, handlerStarted, finishHandler, handlerCompleted: () => completed };
	}

	it("setModel saves the model and emits model_select", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: MODELS.slice(0, 2),
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

	it.each(["set", "cycle"] as const)(
		"applies a %s model switch before slow model_select handlers finish",
		async (kind) => {
			const { harness, handlerStarted, finishHandler, handlerCompleted } = await createSlowModelSelectHarness();

			if (kind === "set") {
				await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
			} else {
				const result = await harness.session.cycleModel("forward", { waitForExtensions: false });
				expect(result?.model.id).toBe("faux-2");
			}
			await handlerStarted.promise;

			expect(harness.session.model?.id).toBe("faux-2");
			expect(handlerCompleted()).toBe(false);

			finishHandler.resolve();
			await flushAsyncWork();

			expect(handlerCompleted()).toBe(true);
		},
	);

	it("serializes nonblocking model_select handlers across quick switches", async () => {
		const firstHandlerStarted = createDeferred();
		const finishFirstHandler = createDeferred();
		const events: string[] = [];
		const harness = await createHarness({
			models: MODELS,
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
			models: MODELS,
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

	it("waits for pending model_select handlers before starting the next prompt", async () => {
		const { harness, handlerStarted, finishHandler } = await createSlowModelSelectHarness();
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

	it.each([
		["a user prompt", (harness: Harness) => harness.session.prompt("hi"), { role: "user", text: "hi" }],
		[
			"an accepted agent-message prompt",
			(harness: Harness) =>
				harness.session.acceptAgentMessagePrompt("agent-to-agent payload", { expandPromptTemplates: false }),
			{ role: "user", text: "agent-to-agent payload" },
		],
		[
			"an injected heartbeat prompt",
			(harness: Harness) => harness.session.promptHeartbeat(createHeartbeat()),
			{
				role: "custom",
				text: "[heartbeat: every 5m run#2]\n\nCheck whether the long-running task needs another step.",
			},
		],
	])(
		"delivers nextTurn messages queued by pending model_select handlers before %s",
		async (_name, start, expected) => {
			const { harness, handlerStarted, finishHandler } = await createSlowModelSelectHarness({
				nextTurnMessage: "model context",
			});
			harness.setResponses([fauxAssistantMessage("after model context")]);

			await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
			await handlerStarted.promise;

			const started = start(harness);
			await flushAsyncWork();

			// The turn must not open while a model_select handler is still pending.
			expect(conversationMessages(harness.session)).toHaveLength(0);

			finishHandler.resolve();
			await started;
			await harness.session.agent.waitForIdle();

			expect(
				conversationMessages(harness.session)
					.slice(0, 2)
					.map((message) => ({ role: message.role, text: getMessageText(message) })),
			).toEqual([{ role: "custom", text: "model context" }, expected]);
			expect(getAssistantTexts(harness)).toContain("after model context");
		},
	);

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

	it("allows model_select handlers to enqueue user messages without waiting on themselves", async () => {
		const harness = await createHarness({
			models: MODELS.slice(0, 2),
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
			models: MODELS,
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

	it("cycles through scoped models and clamps thinking to model capabilities", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);
		harness.session.setScopedModels([
			{ model: harness.getModel("faux-1")!, thinkingLevel: "high" },
			{ model: harness.getModel("faux-2")! },
		] as Array<{ model: Model<string>; thinkingLevel?: ThinkingLevel }>);
		harness.session.setThinkingLevel("high");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.session.cycleThinkingLevel()).toBeUndefined();

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("throws when setModel is called without configured auth", async () => {
		const harness = await createHarness({ models: MODELS.slice(0, 2), withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			`No API key for ${harness.getModel().provider}/faux-2`,
		);
	});

	it("allows before_agent_start handlers to inject custom messages and modify the system prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						message: { customType: "before-start", content: "injected", display: true, details: {} },
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
