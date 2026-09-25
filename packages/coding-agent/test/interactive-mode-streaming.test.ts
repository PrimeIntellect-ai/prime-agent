import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import type { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import type { FileChangeSummary } from "../src/modes/interactive/components/edit-summary.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { TopBar } from "../src/modes/interactive/components/top-bar.js";
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

function createAssistantMessage(text: string, usage: Usage = EMPTY_USAGE): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
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
	describe("speed display tok/sec tracking", () => {
		// The readout belongs to the top bar: the top bar below reads the same
		// speedText field the constructor's getSpeedText wiring reads.
		type SpeedThis = { speedText?: string };
		const topBarLine = (bar: TopBar) => stripAnsi(bar.render(80).join("\n"));
		const makeSpeedThis = (enabled = true) => {
			const fakeThis = createFakeInteractiveModeThis();
			const state = fakeThis as unknown as SpeedThis;
			const topBar = new TopBar({
				getChatName: () => "demo",
				getCostUsd: () => 1.42,
				getSpeedText: () => state.speedText,
			});
			const footer = new FooterComponent({ getGitBranch: () => null } as ReadonlyFooterDataProvider);
			Object.assign(fakeThis as Record<string, unknown>, { footer, speedDisplayEnabled: enabled });
			return { fakeThis, state, topBar, footer };
		};
		const speedPrototype = InteractiveMode.prototype as unknown as {
			handleEvent(this: Record<string, unknown>, event: AgentConnectionSessionEvent): Promise<void>;
			recordSpeedSample(this: Record<string, unknown>, message: AssistantMessage): void;
		};
		afterEach(() => vi.restoreAllMocks());
		test("records output tok/s per completed assistant message on the top bar line", async () => {
			const { fakeThis, topBar, footer } = makeSpeedThis();
			const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
			const first = createAssistantMessage("first", { ...EMPTY_USAGE, output: 100, totalTokens: 100 });
			now.mockReturnValue(3_000);
			await speedPrototype.handleEvent.call(fakeThis, { type: "message_end", message: first });
			// One row: readout, name, and spend share the top bar line.
			expect(topBar.render(80)).toHaveLength(1);
			expect(topBarLine(topBar)).toContain("50.0 tok/s");
			expect(topBarLine(topBar)).toContain("demo  $1.42");
			const second = createAssistantMessage("second", { ...EMPTY_USAGE, output: 300, totalTokens: 300 });
			now.mockReturnValue(5_500);
			await speedPrototype.handleEvent.call(fakeThis, { type: "message_end", message: second });
			expect(topBarLine(topBar)).toContain("120 tok/s · avg 88.9");
			// Moved, not copied: the footer renders no readout and kept no speed setters.
			expect(footer.render(200)).toEqual([]);
			expect((footer as unknown as Record<string, unknown>).setSpeedText).toBeUndefined();
		});
		test.each<[string, boolean, number, number, Record<string, unknown>]>([
			["zero output tokens", true, 0, 2_000, { timestamp: 1_000 }],
			["zero duration", true, 100, 0, {}],
			["aborted message", true, 50, 2_000, { stopReason: "aborted", timestamp: 1_000 }],
			["stripped usage and timestamp", true, 100, 2_000, { usage: undefined, timestamp: undefined }],
			["display disabled", false, 100, 2_000, {}],
		])("skips the sample when %s", (_label, enabled, output, durationMs, overrides) => {
			const { fakeThis, state, topBar } = makeSpeedThis(enabled);
			// A readout on screen when a sample is skipped must survive the skip.
			if (enabled) state.speedText = "9.9 tok/s";
			vi.spyOn(Date, "now").mockReturnValue(1_000 + durationMs);
			const message = Object.assign(createAssistantMessage("partial", { ...EMPTY_USAGE, output }), overrides);
			speedPrototype.recordSpeedSample.call(fakeThis, message);
			if (enabled) {
				expect(topBarLine(topBar)).toContain("9.9 tok/s");
			} else {
				expect(topBarLine(topBar)).not.toContain("tok/s");
			}
		});
	});
});
