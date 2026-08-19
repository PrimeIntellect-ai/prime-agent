import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import {
	collectElapsedToolMarkers,
	ElapsedToolLabelGate,
	parseElapsedToolMarker,
} from "../src/modes/interactive/components/elapsed-tool-marker.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheWrite: 0, total: 0, cacheRead: 0 },
};

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function markerToolCallMessage(seconds: number, toolCallId: string): AssistantMessage {
	return createAssistantMessage([
		{ type: "text", text: `[T+${seconds}s]` },
		{ type: "toolCall", id: toolCallId, name: "ipython", arguments: { code: "1+1" } },
	]);
}

function toolResultMessage(toolCallId: string, text = "2"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "ipython",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

const componentOptions = {
	ui: { requestRender: vi.fn() } as unknown as TUI,
	cwd: "/tmp",
	toolOptions: {},
	getToolDefinition: () => undefined,
};

describe("elapsed tool status", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("parses only exact elapsed markers", () => {
		expect(parseElapsedToolMarker("[T+548545s]")).toEqual({ seconds: 548545, label: "T+548545s" });
		expect(parseElapsedToolMarker(" [T+548545s] ")).toEqual({ seconds: 548545, label: "T+548545s" });
		expect(parseElapsedToolMarker("The run reached [T+90s] after startup")).toBeUndefined();
		expect(parseElapsedToolMarker("[T+90s] more text")).toBeUndefined();
		expect(parseElapsedToolMarker("T+90s")).toBeUndefined();
	});

	test("associates an exact marker with the next tool call in the same message", () => {
		const markers = collectElapsedToolMarkers(markerToolCallMessage(548545, "tool-1").content);
		expect(markers.get("tool-1")).toEqual({ seconds: 548545, label: "T+548545s", toolCallId: "tool-1" });

		const noTool = collectElapsedToolMarkers(createAssistantMessage([{ type: "text", text: "[T+90s]" }]).content);
		expect(noTool.size).toBe(0);
	});

	test("hides the exact marker paragraph but keeps prose and orphan markers visible", () => {
		const hidden = new AssistantMessageComponent(markerToolCallMessage(548545, "tool-1"));
		expect(stripAnsi(hidden.render(80).join("\n"))).not.toContain("T+548545s");

		const prose = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "The run reached [T+90s] after startup" }]),
		);
		expect(stripAnsi(prose.render(80).join("\n"))).toContain("[T+90s]");

		const orphan = new AssistantMessageComponent(markerToolCallMessage(120, "tool-1"));
		orphan.updateContent(createAssistantMessage([{ type: "text", text: "[T+120s]" }]));
		expect(stripAnsi(orphan.render(80).join("\n"))).toContain("[T+120s]");
	});

	test("gates labels to one display per 30 elapsed seconds", () => {
		const gate = new ElapsedToolLabelGate();
		expect(gate.admit(548545, "T+548545s")).toBe("T+548545s");
		expect(gate.admit(548553, "T+548553s")).toBeUndefined();
		expect(gate.admit(548575, "T+548575s")).toBe("T+548575s");
		gate.reset();
		expect(gate.admit(548576, "T+548576s")).toBe("T+548576s");
	});

	test("replay folds observed markers into one label on the first eligible tool row", () => {
		const messages: AgentMessage[] = [];
		const secondsList = [548545, 548553, 548562, 548570, 548580];
		for (const [index, seconds] of secondsList.entries()) {
			const toolCallId = `tool-${index + 1}`;
			messages.push(markerToolCallMessage(seconds, toolCallId));
			messages.push(toolResultMessage(toolCallId));
		}

		const components = buildConversationComponents(messages, componentOptions);
		for (const width of [80, 120]) {
			const lines = components.flatMap((component) => component.render(width).map(stripAnsi));
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(width);
			}
			const output = lines.join("\n");
			// First and >=30s-later markers become tool-row labels; nothing else.
			expect(output.match(/T\+548545s/g)).toHaveLength(1);
			expect(output.match(/T\+548580s/g)).toHaveLength(1);
			for (const suppressed of ["T+548553s", "T+548562s", "T+548570s"]) {
				expect(output).not.toContain(suppressed);
			}
			// The label rides the tool status row, not a standalone paragraph.
			const labeled = lines.filter((line) => line.includes("T+548545s"));
			expect(labeled).toHaveLength(1);
			expect(labeled[0]).toContain("python");
		}
	});

	test("the elapsed label does not add a row to a tool status line", () => {
		const withLabel = new ToolExecutionComponent(
			"ipython",
			"tool-label",
			{ code: "1+1" },
			{ elapsedLabel: "T+548545s" },
			undefined,
			componentOptions.ui,
			"/tmp",
		);
		const withoutLabel = new ToolExecutionComponent(
			"ipython",
			"tool-plain",
			{ code: "1+1" },
			{},
			undefined,
			componentOptions.ui,
			"/tmp",
		);
		for (const component of [withLabel, withoutLabel]) {
			component.markExecutionStarted();
			component.setArgsComplete();
			component.updateResult(
				{ content: [{ type: "text", text: "2" }], details: { durationMs: 1500 }, isError: false },
				false,
			);
		}
		for (const width of [80, 120]) {
			expect(withLabel.render(width).length).toBe(withoutLabel.render(width).length);
			const labeled = stripAnsi(withLabel.render(width).join("\n"));
			expect(labeled).toContain("T+548545s");
			expect(labeled).toContain("1.5s");
		}
	});

	test("streaming hides marker-only updates, moves markers to tools, and reveals completed orphans", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent: (event: AgentConnectionSessionEvent) => Promise<void>;
			}
		).handleEvent;
		const markerOnly = createAssistantMessage([{ type: "text", text: "[T+548545s]" }]);
		const withTool = markerToolCallMessage(548545, "stream-1");

		await handleEvent.call(fakeThis, { type: "message_start", message: createAssistantMessage([]) });
		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: markerOnly,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "[T+548545s]", partial: markerOnly },
		});
		expect(stripAnsi(fakeThis.streamingComponent!.render(80).join("\n"))).not.toContain("T+548545s");

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: withTool,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: withTool },
		});
		const tool = fakeThis.pendingTools.get("stream-1");
		expect(tool).toBeDefined();
		expect(stripAnsi(tool!.render(80).join("\n"))).toContain("T+548545s");
		await handleEvent.call(fakeThis, { type: "message_end", message: withTool });

		const orphan = createAssistantMessage([{ type: "text", text: "[T+548580s]" }]);
		await handleEvent.call(fakeThis, { type: "message_start", message: createAssistantMessage([]) });
		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: orphan,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "[T+548580s]", partial: orphan },
		});
		expect(stripAnsi(fakeThis.streamingComponent!.render(80).join("\n"))).not.toContain("T+548580s");
		await handleEvent.call(fakeThis, { type: "message_end", message: orphan });
		expect(stripAnsi(fakeThis.chatContainer.render(80).join("\n"))).toContain("T+548580s");
	});

	test("streaming and replay render the same assistant prose", () => {
		const finalMessage = createAssistantMessage([
			{ type: "text", text: "Starting the check." },
			{ type: "text", text: "[T+548545s]" },
			{ type: "toolCall", id: "tool-1", name: "ipython", arguments: { code: "1+1" } },
		]);

		const streamed = new AssistantMessageComponent();
		// message_update sequence: prose first, then the exact marker, then the tool call.
		streamed.updateContent(createAssistantMessage([{ type: "text", text: "Starting the check." }]));
		streamed.updateContent(
			createAssistantMessage([
				{ type: "text", text: "Starting the check." },
				{ type: "text", text: "[T+548545s]" },
			]),
		);
		streamed.updateContent(finalMessage);

		const replayed = new AssistantMessageComponent(finalMessage);
		expect(streamed.render(80)).toEqual(replayed.render(80));
		expect(stripAnsi(streamed.render(80).join("\n"))).toContain("Starting the check.");
		expect(stripAnsi(streamed.render(80).join("\n"))).not.toContain("T+548545s");
	});
});

type StreamingFakeThis = {
	isInitialized: boolean;
	settingsManager: { getShowImages(): boolean };
	toolOutputExpanded: boolean;
	agentMessagesExpanded: boolean;
	editDiffsExpanded: boolean;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	footer: { invalidate(): void };
	subagentSummaryLine: { invalidate(): void };
	ui: TUI;
	chatContainer: Container;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	pendingTools: Map<string, ToolExecutionComponent>;
	pendingToolCreations: Set<string>;
	pendingToolGeneration: number;
	startedToolCalls: Set<string>;
	toolDefinitionCache: Map<string, unknown>;
	ipythonToolComponents: Map<string, ToolExecutionComponent>;
	lateIpythonSentAgentMessages: Map<string, never[]>;
	elapsedToolLabelGate: ElapsedToolLabelGate;
	agentConnection: { getToolDefinition(name: string): Promise<unknown> };
	updateConnectionStateFromEvent(event: AgentConnectionSessionEvent): void;
	activityTracker: AgentActivityTracker;
	getMarkdownThemeWithSettings(): ReturnType<typeof getMarkdownTheme>;
	getRetryAttempt(): number;
	getCurrentCwd(): string;
	resetPendingToolState(): void;
};

function createFakeInteractiveModeThis(): StreamingFakeThis {
	const fakeThis = {
		isInitialized: true,
		settingsManager: { getShowImages: () => true },
		toolOutputExpanded: false,
		agentMessagesExpanded: false,
		editDiffsExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		footer: { invalidate: vi.fn() },
		subagentSummaryLine: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		chatContainer: new Container(),
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map<string, ToolExecutionComponent>(),
		pendingToolCreations: new Set<string>(),
		pendingToolGeneration: 0,
		startedToolCalls: new Set<string>(),
		toolDefinitionCache: new Map<string, unknown>(),
		ipythonToolComponents: new Map<string, ToolExecutionComponent>(),
		lateIpythonSentAgentMessages: new Map<string, never[]>(),
		elapsedToolLabelGate: new ElapsedToolLabelGate(),
		agentConnection: { getToolDefinition: async () => undefined },
		updateConnectionStateFromEvent: vi.fn(),
		activityTracker: new AgentActivityTracker(),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getRetryAttempt: () => 0,
		getCurrentCwd: () => "/tmp",
		resetPendingToolState: vi.fn(),
	};
	Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
	return fakeThis as StreamingFakeThis;
}
