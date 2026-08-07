import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AgentCronJob, shouldDeferHeartbeatCronJob } from "../../../src/core/cron-jobs.js";
import { createGoalContextMessage, type GoalState } from "../../../src/core/goals.js";
import {
	createHeartbeatPromptMessage,
	formatHeartbeatPromptContent,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
} from "../../../src/core/messages.js";
import {
	InjectedPromptMessageComponent,
	isInjectedPromptMessage,
} from "../../../src/modes/interactive/components/injected-prompt-message.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.js";

type AddMessageToChatHost = {
	addMessageToChat(
		this: LegacyHeartbeatRenderMode,
		message: AgentMessage,
		options?: { populateHistory?: boolean },
	): void;
};

type LegacyHeartbeatRenderMode = {
	connectionState: { heartbeat: AgentCronJob };
	chatContainer: Container;
	toolOutputExpanded: boolean;
	editor: { addToHistory?: (text: string) => void };
	getMarkdownThemeWithSettings: () => MarkdownTheme;
};

type MessageStartHandleMode = {
	isInitialized: boolean;
	footer: { invalidate: () => void };
	updateConnectionStateFromEvent: (event: unknown) => void;
	contextUsageTokenBaseline: number;
	activityTracker: { handleEvent: (event: unknown) => void };
	updateWorkingLoaderMessage: () => void;
	addMessageToChat: (message: AgentMessage) => void;
	ui: { requestRender: () => void };
	sessionRecap?: string;
	renderRecap: () => void;
	updatePendingMessagesDisplay: () => void;
};

type MessageStartHandleHost = {
	handleEvent(this: MessageStartHandleMode, event: { type: "message_start"; message: AgentMessage }): Promise<void>;
};

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function render(component: InjectedPromptMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
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

function createMessageStartMode(sessionRecap = "previous recap"): MessageStartHandleMode {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		updateConnectionStateFromEvent: vi.fn(),
		contextUsageTokenBaseline: 12,
		activityTracker: { handleEvent: vi.fn() },
		updateWorkingLoaderMessage: vi.fn(),
		addMessageToChat: vi.fn(),
		ui: { requestRender: vi.fn() },
		sessionRecap,
		renderRecap: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
	}) as MessageStartHandleMode;
}

async function handleMessageStart(mode: MessageStartHandleMode, message: AgentMessage): Promise<void> {
	await (InteractiveMode.prototype as unknown as MessageStartHandleHost).handleEvent.call(mode, {
		type: "message_start",
		message,
	});
}

describe("ENG-4482 heartbeat injected prompt UI", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records heartbeat prompts as custom transcript messages while keeping provider input as user content", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerMessages: Message[] = [];
		harness.setResponses([
			(context) => {
				providerMessages = [...context.messages];
				return fauxAssistantMessage("heartbeat handled");
			},
		]);

		await harness.session.promptHeartbeat(createHeartbeat());

		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.messages[0]).toMatchObject({
			role: "custom",
			customType: HEARTBEAT_PROMPT_CUSTOM_TYPE,
			display: true,
		});
		expect(getMessageText(harness.session.messages[0])).toBe(formatHeartbeatPromptContent(createHeartbeat()));
		expect(providerMessages.at(-1)).toMatchObject({ role: "user" });
		expect(getMessageText(providerMessages.at(-1))).toBe(formatHeartbeatPromptContent(createHeartbeat()));
	});

	it("runs heartbeat prompts through before_agent_start handlers", async () => {
		const harness = await createHarness({
			systemPrompt: "base prompt",
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						message: {
							customType: "before-start",
							content: "extension context",
							display: true,
							details: { source: "test" },
						},
						systemPrompt: `${event.systemPrompt}\n\nheartbeat instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		let sawExtensionContext = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				sawExtensionContext = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "extension context",
				);
				return fauxAssistantMessage("heartbeat handled");
			},
		]);

		await harness.session.promptHeartbeat(createHeartbeat());

		expect(providerSystemPrompt).toContain("heartbeat instructions");
		expect(sawExtensionContext).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "before-start"),
		).toBe(true);
	});

	it("resets overflow recovery state when heartbeat prompt turns start", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as { _overflowRecovery: string };
		sessionInternals._overflowRecovery = "attempted";
		harness.setResponses([fauxAssistantMessage("heartbeat handled")]);

		await harness.session.promptHeartbeat(createHeartbeat());
		await harness.session.agent.waitForIdle();

		expect(sessionInternals._overflowRecovery).toBe("idle");
	});

	it("keeps pending nextTurn context separate from queued heartbeat prompts", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		let queuedHeartbeatText = "";
		let queuedPendingContextText = "";
		const queueEvents: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "session_action_update") {
				queueEvents.push({ steering: event.actions.steering, followUp: event.actions.followUps });
			}
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				const pendingContextMessage = context.messages.find(
					(message) => message.role === "user" && getMessageText(message) === "pending heartbeat context",
				);
				const queuedUserMessage = context.messages.find(
					(message) =>
						message.role === "user" &&
						getMessageText(message).includes("Check whether the long-running task needs another step."),
				);
				queuedPendingContextText = getMessageText(pendingContextMessage);
				queuedHeartbeatText = getMessageText(queuedUserMessage);
				return fauxAssistantMessage("heartbeat handled");
			},
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "pending-context", content: "pending heartbeat context", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		await harness.session.promptHeartbeat(createHeartbeat(), { streamingBehavior: "followUp" });

		releaseToolExecution?.();
		await promptPromise;

		expect(queuedPendingContextText).toBe("pending heartbeat context");
		expect(queuedHeartbeatText).toBe(formatHeartbeatPromptContent(createHeartbeat()));
		expect(
			queueEvents.some((event) =>
				event.followUp.includes("Heartbeat prompt: Check whether the long-running task needs another step."),
			),
		).toBe(true);
	});

	it("orders a heartbeat after an earlier prompt with a slow input handler", async () => {
		let markInputReached = () => {};
		const inputReached = new Promise<void>((resolve) => {
			markInputReached = resolve;
		});
		let releaseInput = () => {};
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "ordinary first") return;
						markInputReached();
						await inputGate;
					});
				},
			],
		});
		harnesses.push(harness);
		const providerOrder: string[] = [];
		harness.setResponses([
			(context) => {
				providerOrder.push(getMessageText(context.messages.at(-1)));
				return fauxAssistantMessage("first done");
			},
			(context) => {
				providerOrder.push(getMessageText(context.messages.at(-1)));
				return fauxAssistantMessage("heartbeat done");
			},
		]);

		const ordinary = harness.session.prompt("ordinary first");
		await inputReached;
		const heartbeat = harness.session.promptHeartbeat(createHeartbeat());
		releaseInput();
		await Promise.all([ordinary, heartbeat]);
		await harness.session.waitForIdle();

		expect(providerOrder).toEqual(["ordinary first", formatHeartbeatPromptContent(createHeartbeat())]);
	});

	it("waits for a queued-work pause before admitting a streaming heartbeat", async () => {
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseTurn = () => {};
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				markStarted();
				await turnGate;
				return fauxAssistantMessage("original done");
			},
			fauxAssistantMessage("heartbeat done"),
		]);

		const originalTurn = harness.session.prompt("start");
		await started;
		const pause = harness.session.acquireQueuedWorkPause();
		const heartbeat = harness.session.promptHeartbeat(createHeartbeat(), { streamingBehavior: "followUp" });
		await Promise.resolve();
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);

		pause.release();
		await heartbeat;
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(1);
		releaseTurn();
		await originalTurn;
		await harness.session.waitForIdle();
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
	});

	it("preserves next-turn context order across queued heartbeat admission", async () => {
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseTurn = () => {};
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		let deliveredOrder: string[] = [];
		harness.setResponses([
			async () => {
				markStarted();
				await turnGate;
				return fauxAssistantMessage("original turn complete");
			},
			(context) => {
				deliveredOrder = context.messages
					.map(getMessageText)
					.filter((text) =>
						["context A", "context B", formatHeartbeatPromptContent(createHeartbeat())].includes(text),
					);
				return fauxAssistantMessage("heartbeat handled");
			},
		]);

		const originalTurn = harness.session.prompt("start");
		await started;
		expect(harness.session.isStreaming).toBe(true);
		expect(harness.session.unfinishedActionCount).toBe(1);
		expect(harness.session.hasPendingSessionWork).toBe(false);
		expect(shouldDeferHeartbeatCronJob(createHeartbeat(), harness.session)).toBe(false);
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "context A", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		await harness.session.promptHeartbeat(createHeartbeat(), { streamingBehavior: "followUp" });
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "context B", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		releaseTurn();
		await originalTurn;
		await harness.session.waitForIdle();

		expect(deliveredOrder).toEqual(["context A", "context B", formatHeartbeatPromptContent(createHeartbeat())]);
	});

	it("returns raw text when clearing queued heartbeat prompts while previews remain labeled", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		const heartbeatText = "Check whether the long-running task needs another step.";
		const heartbeatPreview = `Heartbeat prompt: ${heartbeatText}`;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
		]);
		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await harness.session.promptHeartbeat(createHeartbeat(), { streamingBehavior: "followUp" });

		expect(harness.session.getFollowUpMessagePreviews()).toEqual([heartbeatPreview]);
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [heartbeatText] });

		releaseToolExecution?.();
		await promptPromise;

		expect(harness.session.getFollowUpMessagePreviews()).toEqual([]);
	});

	it("removes queued steered heartbeat prompts by heartbeat queue key", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		const heartbeatText = "Check whether the long-running task needs another step.";
		const heartbeatPreview = `Heartbeat prompt: ${heartbeatText}`;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
		]);
		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await harness.session.promptHeartbeat(createHeartbeat(), { streamingBehavior: "steer" });

		expect(harness.session.getSteeringMessagePreviews()).toEqual([heartbeatPreview]);
		expect(harness.session.removeQueuedFollowUp("heartbeat:heartbeat-1")).toBe(true);
		expect(harness.session.getSteeringMessagePreviews()).toEqual([]);

		releaseToolExecution?.();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("renders heartbeat prompts as expandable injected prompt panels", () => {
		const component = new InjectedPromptMessageComponent(createHeartbeatPromptMessage(createHeartbeat()));
		const collapsed = render(component);

		expect(collapsed).toContain("♥");
		expect(collapsed).toContain("Heartbeat prompt");
		expect(collapsed).toContain("every 5m");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("Check whether the long-running task needs another step.");

		component.setExpanded(true);
		const expanded = render(component);
		expect(expanded).toContain("Heartbeat prompt");
		expect(expanded).toContain("Check whether the long-running task needs another step.");
	});

	it("keeps the current recap when heartbeat prompt turns start", async () => {
		const heartbeatMode = createMessageStartMode();
		const heartbeatMessage = createHeartbeatPromptMessage(createHeartbeat());

		await handleMessageStart(heartbeatMode, heartbeatMessage);

		expect(heartbeatMode.addMessageToChat).toHaveBeenCalledWith(heartbeatMessage);
		expect(heartbeatMode.sessionRecap).toBe("previous recap");
		expect(heartbeatMode.renderRecap).not.toHaveBeenCalled();
		expect(heartbeatMode.updatePendingMessagesDisplay).not.toHaveBeenCalled();

		const goalMode = createMessageStartMode();
		const goal: GoalState = {
			active: true,
			status: "active",
			goalId: "goal-1",
			objective: "Finish the implementation plan",
			tokensUsed: 10,
			timeUsedSeconds: 20,
			continuationsUsed: 1,
		};
		const goalMessage = createGoalContextMessage(goal, "continuation");

		await handleMessageStart(goalMode, goalMessage);

		expect(goalMode.sessionRecap).toBe("previous recap");
		expect(goalMode.renderRecap).not.toHaveBeenCalled();
		expect(goalMode.updatePendingMessagesDisplay).not.toHaveBeenCalled();
	});

	it("renders expanded injected prompt images as placeholders", () => {
		const message = createHeartbeatPromptMessage(createHeartbeat());
		message.content = [
			{ type: "text", text: "Review this screenshot." },
			{ type: "image", data: "base64-data", mimeType: "image/png" },
		];
		const component = new InjectedPromptMessageComponent(message);

		component.setExpanded(true);

		expect(render(component)).toContain("Review this screenshot.");
		expect(render(component)).toContain("[image]");
	});

	it.each(["active", "cancelled"] as const)(
		"renders %s legacy daemon heartbeat user messages as injected prompt panels",
		(status) => {
			const heartbeat =
				status === "cancelled"
					? { ...createHeartbeat(), status, nextRunAt: undefined, lastRunAt: "2026-01-01T00:05:00.000Z" }
					: { ...createHeartbeat(), status };
			const timestamp = Date.parse(heartbeat.nextRunAt ?? heartbeat.lastRunAt ?? heartbeat.createdAt);
			const chatContainer = new Container();
			const addToHistory = vi.fn();
			const mode = Object.create(InteractiveMode.prototype) as LegacyHeartbeatRenderMode;
			mode.connectionState = { heartbeat };
			mode.chatContainer = chatContainer;
			mode.toolOutputExpanded = false;
			mode.editor = { addToHistory };
			mode.getMarkdownThemeWithSettings = () => getMarkdownTheme();
			const message: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: heartbeat.prompt }],
				timestamp,
			};

			(InteractiveMode.prototype as unknown as AddMessageToChatHost).addMessageToChat.call(mode, message, {
				populateHistory: true,
			});

			const rendered = stripAnsi(chatContainer.render(120).join("\n"));
			expect(rendered).toContain("Heartbeat prompt");
			expect(rendered).toContain("every 5m");
			expect(rendered).not.toContain("Check whether the long-running task needs another step.");
			expect(addToHistory).not.toHaveBeenCalled();
		},
	);

	it("does not render matching user messages at interval phases as heartbeat panels", () => {
		const heartbeat = createHeartbeat();
		const chatContainer = new Container();
		const mode = Object.create(InteractiveMode.prototype) as LegacyHeartbeatRenderMode;
		mode.connectionState = { heartbeat };
		mode.chatContainer = chatContainer;
		mode.toolOutputExpanded = false;
		mode.editor = {};
		mode.getMarkdownThemeWithSettings = () => getMarkdownTheme();
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: heartbeat.prompt }],
			timestamp: Date.parse("2026-01-01T00:15:00.000Z"),
		};

		(InteractiveMode.prototype as unknown as AddMessageToChatHost).addMessageToChat.call(mode, message);

		const rendered = stripAnsi(chatContainer.render(120).join("\n"));
		expect(rendered).not.toContain("Heartbeat prompt");
		expect(rendered).toContain("Check whether the long-running task needs another step.");
	});

	it("renders goal continuation prompts as injected prompt panels", () => {
		const goal: GoalState = {
			active: true,
			status: "active",
			goalId: "goal-1",
			objective: "Finish the implementation plan",
			tokensUsed: 10,
			timeUsedSeconds: 20,
			continuationsUsed: 1,
		};
		const message = createGoalContextMessage(goal, "continuation");
		const component = new InjectedPromptMessageComponent(message);

		expect(message.display).toBe(true);
		expect(isInjectedPromptMessage(message)).toBe(true);
		expect(render(component)).toContain("Goal continuation");

		component.setExpanded(true);
		expect(render(component)).toContain("<goal_context>");
	});
});
