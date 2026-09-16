import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import type { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import type { FileChangeSummary } from "../src/modes/interactive/components/edit-summary.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
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
	ui: TUI;
	chatContainer: Container;
	recapContainer: Container;
	sessionRecap: string | undefined;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	pendingTools: Map<string, ToolExecutionComponent>;
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
	refreshTopBarCost(): void;
	clearShortcutGuide(): void;
	addMessageToChat(): void;
};
type HandleEvent = (this: HandleEventThis, event: AgentConnectionSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): HandleEventThis {
	const fakeThis = {
		isInitialized: true,
		settingsManager: { getShowTerminalProgress: () => false },
		connectionState: { isStreaming: false },
		toolOutputExpanded: false,
		footer: { invalidate: vi.fn() },
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
		refreshTopBarCost: vi.fn(),
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

describe("InteractiveMode streaming events", () => {
	beforeAll(() => {
		initTheme("dark");
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
});
