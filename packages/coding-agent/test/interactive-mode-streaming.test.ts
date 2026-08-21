import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import type { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import type { FileChangeSummary } from "../src/modes/interactive/components/edit-summary.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type HandleEventThis = {
	isInitialized: boolean;
	settingsManager: { getShowTerminalProgress(): boolean };
	connectionState: { isStreaming: boolean };
	toolOutputExpanded: boolean;
	footer: { invalidate(): void };
	subagentSummaryLine: { invalidate(): void };
	activeActTrays: Map<number, { actId: string; depth: number; model: string; thinkingLevel?: string }>;
	ui: TUI;
	chatContainer: Container;
	recapContainer: Container;
	sessionRecap: string | undefined;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	pendingTools: Map<string, ToolExecutionComponent>;
	ipythonToolComponents: Map<string, ToolExecutionComponent>;
	lateIpythonSentAgentMessages: Map<string, never[]>;
	lateActEvents: Map<string, Extract<AgentConnectionSessionEvent, { type: "act_event" }>[]>;
	agentRunFileChanges: Map<string, FileChangeSummary>;
	updateConnectionStateFromEvent(event: AgentConnectionSessionEvent): void;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getOrCreatePendingToolComponent(): Promise<ToolExecutionComponent | undefined>;
	getRetryAttempt(): number;
	getCurrentCwd(): string;
	stopWorkingLoader(): void;
	resetPendingToolState(): void;
	checkShutdownRequested(): Promise<void>;
	applyOptimisticContextUsage(): void;
	refreshConnectionContextUsage(): Promise<void>;
	setSessionHasMessages(hasMessages: boolean): void;
	clearShortcutGuide(): void;
	addMessageToChat(): void;
};

type HandleEvent = (this: HandleEventThis, event: AgentConnectionSessionEvent) => Promise<void>;
type GetUserInput = (this: {
	agentsViewRequest?: "agents_view" | "scoped_agents_view";
	onInputCallback?: (text: string | undefined) => void;
}) => Promise<string | undefined>;
type HandleSubagentSummaryChatAction = (
	this: {
		keybindings: { matches(data: string, action: string): boolean };
		editor: { handleInput(data: string): void };
		focusEditor(): void;
		toggleToolOutputExpansion(): void;
		toggleThinkingBlockVisibility(): void;
	},
	data: string,
) => void;

function createFakeInteractiveModeThis(): HandleEventThis {
	const fakeThis = {
		isInitialized: true,
		settingsManager: { getShowTerminalProgress: () => false },
		connectionState: { isStreaming: false },
		toolOutputExpanded: false,
		footer: { invalidate: vi.fn() },
		subagentSummaryLine: { invalidate: vi.fn() },
		activityTracker: new AgentActivityTracker(),
		ui: { requestRender: vi.fn() } as unknown as TUI,
		chatContainer: new Container(),
		recapContainer: new Container(),
		sessionRecap: "Updated files",
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingTools: new Map<string, ToolExecutionComponent>(),
		ipythonToolComponents: new Map<string, ToolExecutionComponent>(),
		lateIpythonSentAgentMessages: new Map<string, never[]>(),
		lateActEvents: new Map<string, Extract<AgentConnectionSessionEvent, { type: "act_event" }>[]>(),
		activeActTrays: new Map(),
		agentRunFileChanges: new Map<string, FileChangeSummary>(),
		updateConnectionStateFromEvent: vi.fn(),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getOrCreatePendingToolComponent: vi.fn(async () => undefined),
		getRetryAttempt: () => 0,
		getCurrentCwd: () => "/tmp",
		stopWorkingLoader: vi.fn(),
		resetPendingToolState: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		applyOptimisticContextUsage: vi.fn(),
		refreshConnectionContextUsage: vi.fn(async () => {}),
		setSessionHasMessages: vi.fn(),
		clearShortcutGuide: vi.fn(),
		addMessageToChat: vi.fn(),
	};
	Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
	return fakeThis;
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

function actTerminalEvent(outerToolCallId: string): Extract<AgentConnectionSessionEvent, { type: "act_event" }> {
	return {
		type: "act_event",
		actId: "late-act",
		outerToolCallId,
		sequence: 4,
		event: "terminal",
		status: "done",
		prompt: "late prompt",
		promptTruncated: false,
		model: { provider: "test", id: "late-model", name: "Late" },
		thinkingLevel: "medium",
		directingModel: { provider: "test", id: "root-model", name: "Sol" },
		directingThinkingLevel: "low",
		cancellationCapability: "cooperative-only",
		usage: EMPTY_USAGE,
		errorTruncated: false,
	};
}

describe("InteractiveMode streaming events", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("routes Act events only beneath their exactly correlated root IPython tool", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const root = new ToolExecutionComponent(
			"ipython",
			"outer-act",
			{ code: "await rlm.act('inspect')" },
			{},
			undefined,
			fakeThis.ui,
			"/tmp",
		);
		const other = new ToolExecutionComponent(
			"ipython",
			"outer-other",
			{ code: "1 + 1" },
			{},
			undefined,
			fakeThis.ui,
			"/tmp",
		);
		fakeThis.ipythonToolComponents.set("outer-act", root);
		fakeThis.ipythonToolComponents.set("outer-other", other);

		await handleEvent.call(fakeThis, {
			type: "act_event",
			actId: "act-live",
			outerToolCallId: "outer-act",
			sequence: 1,
			event: "start",
			prompt: "inspect",
			promptTruncated: false,
			model: { provider: "test", id: "live-model", name: "Luna" },
			thinkingLevel: "medium",
			directingModel: { provider: "test", id: "root-model", name: "Sol" },
			directingThinkingLevel: "low",
			cancellationCapability: "posix-managed",
		});
		expect([...fakeThis.activeActTrays.values()]).toEqual([
			{ actId: "act-live", depth: 1, model: "Luna", thinkingLevel: "medium" },
		]);
		const getActTrayLabel = (
			InteractiveMode.prototype as unknown as { getActTrayLabel(this: HandleEventThis): string | undefined }
		).getActTrayLabel;
		expect(stripAnsi(getActTrayLabel.call(fakeThis) ?? "")).toContain("act: Luna • medium");
		await handleEvent.call(fakeThis, {
			type: "act_event",
			actId: "act-nested",
			depth: 2,
			parentActId: "act-live",
			outerToolCallId: "outer-act",
			sequence: 1,
			event: "start",
			prompt: "inspect nested",
			promptTruncated: false,
			model: { provider: "test", id: "nested-model", name: "DeepSeek" },
			thinkingLevel: "high",
			directingModel: { provider: "test", id: "live-model", name: "Luna" },
			directingThinkingLevel: "medium",
			cancellationCapability: "posix-managed",
		});
		expect(stripAnsi(getActTrayLabel.call(fakeThis) ?? "")).toContain("act 2: DeepSeek • high");
		await handleEvent.call(fakeThis, {
			type: "act_event",
			actId: "act-nested",
			depth: 2,
			parentActId: "act-live",
			outerToolCallId: "outer-act",
			sequence: 2,
			event: "terminal",
			status: "done",
			prompt: "inspect nested",
			promptTruncated: false,
			model: { provider: "test", id: "nested-model", name: "DeepSeek" },
			thinkingLevel: "high",
			directingModel: { provider: "test", id: "live-model", name: "Luna" },
			directingThinkingLevel: "medium",
			cancellationCapability: "posix-managed",
			usage: EMPTY_USAGE,
			errorTruncated: false,
		});
		expect(stripAnsi(getActTrayLabel.call(fakeThis) ?? "")).toContain("act: Luna • medium");
		await handleEvent.call(fakeThis, {
			type: "act_event",
			actId: "act-live",
			outerToolCallId: "outer-act",
			sequence: 3,
			event: "terminal",
			status: "done",
			prompt: "inspect",
			promptTruncated: false,
			model: { provider: "test", id: "live-model", name: "Luna" },
			thinkingLevel: "medium",
			directingModel: { provider: "test", id: "root-model", name: "Sol" },
			directingThinkingLevel: "low",
			cancellationCapability: "posix-managed",
			usage: EMPTY_USAGE,
			errorTruncated: false,
		});

		expect(fakeThis.activeActTrays.size).toBe(0);
		expect(renderChat(root)).toContain("act  Luna • medium");
		expect(renderChat(root)).toContain("act 2  DeepSeek • high");
		expect(renderChat(root)).toContain("return 2  Luna • medium");
		expect(renderChat(root)).toContain("return  Sol • low");
		const rendered = renderChat(root);
		expect(rendered.indexOf("act  Luna")).toBeLessThan(rendered.indexOf("act 2  DeepSeek"));
		expect(rendered.indexOf("return 2  Luna")).toBeLessThan(rendered.indexOf("return  Sol"));
		expect(renderChat(other)).not.toContain("Act");
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
	});

	test("replays ordered Act start and progress events when the root component appears late", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const startEvent = {
			type: "act_event" as const,
			actId: "late-act",
			outerToolCallId: "outer-late",
			sequence: 1,
			event: "start" as const,
			prompt: "late prompt",
			promptTruncated: false,
			model: { provider: "test", id: "late-model", name: "Late" },
			thinkingLevel: "medium",
			directingModel: { provider: "test", id: "root-model", name: "Sol" },
			directingThinkingLevel: "low",
			cancellationCapability: "cooperative-only" as const,
		};
		await handleEvent.call(fakeThis, startEvent);
		await handleEvent.call(fakeThis, {
			type: "act_event",
			actId: "late-act",
			outerToolCallId: "outer-late",
			sequence: 2,
			event: "assistant_delta",
			stream: "thinking",
			text: "working",
			textTruncated: false,
		});
		expect(fakeThis.lateActEvents.get("outer-late")).toHaveLength(2);
		expect(renderChat(fakeThis.chatContainer)).not.toContain("act  Late");

		const root = new ToolExecutionComponent(
			"ipython",
			"outer-late",
			{ code: "await act" },
			{},
			undefined,
			fakeThis.ui,
			"/tmp",
		);
		const register = (
			InteractiveMode.prototype as unknown as {
				registerIpythonToolComponent(name: string, id: string, component: ToolExecutionComponent): void;
			}
		).registerIpythonToolComponent;
		register.call(fakeThis, "ipython", "outer-late", root);

		expect(fakeThis.lateActEvents.has("outer-late")).toBe(false);
		const rendered = renderChat(root);
		expect(rendered).toContain("act  Late • medium");
		expect(rendered).toContain("working");
		expect(rendered).not.toContain("return  Sol");
	});

	test("bounds retained Act events across unattached tool calls", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		for (let index = 0; index < 129; index++) {
			await handleEvent.call(fakeThis, {
				type: "act_event",
				actId: `act-${index}`,
				outerToolCallId: `outer-${index}`,
				sequence: 1,
				event: "assistant_delta",
				stream: "thinking",
				text: "working",
				textTruncated: false,
			});
		}
		expect(fakeThis.lateActEvents.size).toBe(128);
		expect(fakeThis.lateActEvents.has("outer-0")).toBe(false);
		expect(fakeThis.lateActEvents.has("outer-1")).toBe(true);
	});

	test("cleans up a retained terminal when its root IPython component appears", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		await handleEvent.call(fakeThis, actTerminalEvent("outer-late"));
		expect(fakeThis.lateActEvents.get("outer-late")).toHaveLength(1);

		const root = new ToolExecutionComponent(
			"ipython",
			"outer-late",
			{ code: "await act" },
			{},
			undefined,
			fakeThis.ui,
			"/tmp",
		);
		const register = (
			InteractiveMode.prototype as unknown as {
				registerIpythonToolComponent(name: string, id: string, component: ToolExecutionComponent): void;
			}
		).registerIpythonToolComponent;
		register.call(fakeThis, "ipython", "outer-late", root);

		expect(fakeThis.lateActEvents.has("outer-late")).toBe(false);
		expect(renderChat(root)).toContain("act  Late • medium");
		expect(renderChat(root)).toContain("return  Sol • low");
	});

	test("renders assistant updates when attaching after message_start", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: createAssistantMessage("partial response"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial response",
				partial: createAssistantMessage("partial response"),
			},
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("partial response");

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: createAssistantMessage("final response"),
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("final response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("renders assistant end events when attaching after all updates", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: createAssistantMessage("final response"),
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("final response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("does not block later compaction events on the agent-end stats refresh", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		let resolveRefresh!: () => void;
		fakeThis.refreshConnectionContextUsage = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveRefresh = resolve;
				}),
		);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await expect(handleEvent.call(fakeThis, { type: "agent_end", messages: [] })).resolves.toBeUndefined();
		expect(fakeThis.refreshConnectionContextUsage).toHaveBeenCalledOnce();
		resolveRefresh();
	});

	test("keeps attached partial assistant text when agent_end arrives without message_end", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: createAssistantMessage("partial response"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial response",
				partial: createAssistantMessage("partial response"),
			},
		});
		await handleEvent.call(fakeThis, { type: "agent_end", messages: [] });

		expect(renderChat(fakeThis.chatContainer)).toContain("partial response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("renders one agent-run edit total only when files changed", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const message = createAssistantMessage("");
		message.content = [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts" } }];

		await handleEvent.call(fakeThis, {
			type: "turn_end",
			message,
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "edit-1",
					toolName: "edit",
					content: [],
					details: { diff: "-1 old\n+1 new" },
					isError: false,
					timestamp: 0,
				},
			],
		});
		await handleEvent.call(fakeThis, { type: "agent_end", messages: [] });
		const recap = renderChat(fakeThis.recapContainer);
		expect(recap).toContain("Recap: Updated files");
		expect(recap).toContain("1 file changed | +1 -1");
		expect(recap.indexOf("1 file changed")).toBeLessThan(recap.indexOf("Recap:"));
		expect(renderChat(fakeThis.chatContainer)).not.toContain("file changed");

		const unchanged = createFakeInteractiveModeThis();
		await handleEvent.call(unchanged, { type: "agent_end", messages: [] });
		expect(renderChat(unchanged.recapContainer)).not.toContain("file changed");
	});

	test("keeps edit totals across automatic retries", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.agentRunFileChanges.set("/tmp/a.ts", { path: "a.ts", added: 1, removed: 1 });
		fakeThis.getRetryAttempt = () => 1;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, { type: "agent_start" });

		expect([...fakeThis.agentRunFileChanges.values()]).toEqual([{ path: "a.ts", added: 1, removed: 1 }]);
	});

	test("keeps edit totals when compaction restarts the agent", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.agentRunFileChanges.set("/tmp/a.ts", { path: "a.ts", added: 1, removed: 1 });
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, { type: "agent_start" });

		expect([...fakeThis.agentRunFileChanges.values()]).toEqual([{ path: "a.ts", added: 1, removed: 1 }]);
	});

	test("clears edit totals when a new user prompt starts", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.agentRunFileChanges.set("/tmp/a.ts", { path: "a.ts", added: 1, removed: 1 });
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		await handleEvent.call(fakeThis, { type: "agent_end", messages: [] });
		expect(renderChat(fakeThis.recapContainer)).toContain("1 file changed");

		await handleEvent.call(fakeThis, {
			type: "message_start",
			message: { role: "user", content: "next task", timestamp: Date.now() },
		});

		expect(fakeThis.agentRunFileChanges.size).toBe(0);
		expect(renderChat(fakeThis.recapContainer)).not.toContain("file changed");
		expect(renderChat(fakeThis.recapContainer)).toContain("Recap: Updated files");
	});

	test("resolves input immediately after return to agents view was requested", async () => {
		const getUserInput = (InteractiveMode.prototype as unknown as { getUserInput: GetUserInput }).getUserInput;

		await expect(getUserInput.call({ agentsViewRequest: "agents_view" })).resolves.toBeUndefined();
	});

	test("forwards typed keys from focused subagent summary back to the editor", () => {
		const handleSubagentSummaryChatAction = (
			InteractiveMode.prototype as unknown as { handleSubagentSummaryChatAction: HandleSubagentSummaryChatAction }
		).handleSubagentSummaryChatAction;
		const fakeThis = {
			keybindings: { matches: vi.fn(() => false) },
			editor: { handleInput: vi.fn() },
			focusEditor: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
		};

		handleSubagentSummaryChatAction.call(fakeThis, "x");

		expect(fakeThis.focusEditor).toHaveBeenCalledOnce();
		expect(fakeThis.editor.handleInput).toHaveBeenCalledWith("x");
		expect(fakeThis.toggleToolOutputExpansion).not.toHaveBeenCalled();
		expect(fakeThis.toggleThinkingBlockVisibility).not.toHaveBeenCalled();
	});

	test("keeps focused subagent summary shortcuts in the chat surface", () => {
		const handleSubagentSummaryChatAction = (
			InteractiveMode.prototype as unknown as { handleSubagentSummaryChatAction: HandleSubagentSummaryChatAction }
		).handleSubagentSummaryChatAction;
		const fakeThis = {
			keybindings: { matches: vi.fn((_data: string, action: string) => action === "app.tools.expand") },
			editor: { handleInput: vi.fn() },
			focusEditor: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
		};

		handleSubagentSummaryChatAction.call(fakeThis, "\x0f");

		expect(fakeThis.toggleToolOutputExpansion).toHaveBeenCalledOnce();
		expect(fakeThis.focusEditor).not.toHaveBeenCalled();
		expect(fakeThis.editor.handleInput).not.toHaveBeenCalled();
	});

	test("does not pulse renders for background-only subagent work", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
			Object.assign(mode, {
				connectionState: { isStreaming: false },
				subagentSnapshots: new Map([["worker", { id: "worker", status: "running" }]]),
				pulseTimer: undefined,
				ui: { requestRender },
			});
			const updatePulse = Reflect.get(InteractiveMode.prototype, "updateWorkingPulse") as (
				this: typeof mode,
			) => void;

			updatePulse.call(mode);
			vi.advanceTimersByTime(1000);

			expect(requestRender).not.toHaveBeenCalled();
			expect(Reflect.get(mode, "pulseTimer")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
