import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type Component, type Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAgentSessionMessage } from "../../../src/core/agent-messages.js";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { createAsyncBashCompletionMessage, createRefinementOutcomeMessage } from "../../../src/core/messages.js";
import type {
	AgentConnection,
	AgentConnectionSessionContext,
	AgentConnectionSessionEvent,
} from "../../../src/modes/agent-connection/index.js";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.js";
import {
	buildConversationComponents,
	createConversationSpacing,
} from "../../../src/modes/interactive/components/conversation-components.js";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { createInteractiveModeUiServices } from "../../../src/modes/interactive/interactive-mode-services.js";
import { initTheme, stopThemeWatcher } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

type ModeControls = {
	chatContainer: Container;
	defaultEditor: CustomEditor;
	ui: TUI;
	setupKeyHandlers(): void;
	renderSessionContext(context: AgentConnectionSessionContext): Promise<void>;
	handleEvent(event: AgentConnectionSessionEvent): Promise<void>;
};
let harness: Harness | undefined;
const modes: InteractiveMode[] = [];
afterEach(() => {
	for (const mode of modes.splice(0)) mode.stop();
	stopThemeWatcher();
	harness?.cleanup();
	harness = undefined;
	vi.restoreAllMocks();
});
function createMode(harness: Harness): ModeControls {
	initTheme("dark");
	const connection = {
		onBeforeSessionInvalidate: () => () => {},
		getToolDefinition: async () => undefined,
	} as unknown as AgentConnection;
	const mode = new InteractiveMode({
		agentConnection: connection,
		uiServices: createInteractiveModeUiServices(harness.session),
	});
	modes.push(mode);
	const controls = mode as unknown as ModeControls;
	vi.spyOn(controls.ui, "requestRender").mockImplementation(() => {});
	vi.spyOn(controls.ui, "requestRenderPreservingViewport").mockImplementation(() => {});
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	Object.assign(mode, { keybindings, isInitialized: true });
	controls.setupKeyHandlers();
	return controls;
}
function notice(id: string) {
	return createAgentSessionMessage({
		id,
		source: "agent_message",
		message: `Body ${id}`,
		from: { activeSessionId: id, sessionId: id, sessionName: id },
		fromRelationship: "child",
		target: { activeSessionId: "parent", sessionId: "parent" },
	});
}
function call(id: string) {
	return fauxToolCall("ipython", { code: `print('${id}')` }, { id });
}
function result(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [],
		isError: false,
		details: { status: "ok", stdout: `output ${id}` },
		timestamp: 1,
	};
}
function rows(components: readonly Component[]) {
	return components.flatMap((component) => component.render(120)).map((line) => stripAnsi(line).trimEnd());
}
function precedingGap(lines: string[], match: string) {
	const index = lines.findIndex((line) => line.includes(match));
	expect(index, `Missing ${match}`).toBeGreaterThanOrEqual(0);
	let gap = 0;
	for (let i = index - 1; i >= 0 && lines[i]?.trim() === ""; i--) gap++;
	return gap;
}
function fixtures(): AgentMessage[] {
	return [
		notice("start"),
		fauxAssistantMessage(call("one"), { stopReason: "toolUse" }),
		result("one"),
		fauxAssistantMessage([fauxText("")]),
		notice("after-empty"),
		fauxAssistantMessage([fauxThinking("Hidden reasoning"), fauxText("")]),
		notice("after-thinking"),
		fauxAssistantMessage([call("two"), call("three")], { stopReason: "toolUse" }),
		result("two"),
		result("three"),
		notice("after-tools"),
		createAsyncBashCompletionMessage({ pid: 99, command: "unmatched fixture", exitCode: 0 }, 10000),
		fauxAssistantMessage("Visible prose"),
		notice("after-prose"),
	];
}
async function deliver(mode: ModeControls, messages: AgentMessage[]) {
	for (const message of messages) {
		if (message.role === "toolResult") {
			await mode.handleEvent({
				type: "tool_execution_end",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				result: { content: message.content, details: message.details },
				isError: message.isError,
			});
			continue;
		}
		await mode.handleEvent({ type: "message_start", message });
		if (message.role === "assistant")
			for (const block of message.content) {
				if (block.type === "toolCall")
					await mode.handleEvent({
						type: "tool_execution_start",
						toolCallId: block.id,
						toolName: block.name,
						args: block.arguments,
					});
			}
		await mode.handleEvent({ type: "message_end", message });
	}
}
function assertSpacing(lines: string[], detail: number) {
	expect(precedingGap(lines, "from child after-empty")).toBe(detail === 2 ? 1 : 0);
	expect(precedingGap(lines, "from child after-thinking")).toBe(detail === 0 ? 0 : 1);
	expect(precedingGap(lines, "from child after-tools")).toBe(detail === 2 ? 1 : 0);
	expect(precedingGap(lines, "from child after-prose")).toBe(1);
	const two = lines.findIndex((line) => line.includes("python") && line.includes("print('two')"));
	const three = lines.findIndex((line) => line.includes("python") && line.includes("print('three')"));
	expect(two).toBeGreaterThan(0);
	expect(three).toBeGreaterThan(two);
	expect(lines[two - 1]?.trim() === "").toBe(detail === 2);
	expect(lines[three - 1]?.trim() === "").toBe(detail === 2);
	if (detail === 2) {
		expect(lines[two + 1]).toContain("╰─");
		expect(lines[three + 1]).toContain("╰─");
	}
	expect(precedingGap(lines, "Background shell command finished")).toBe(detail === 2 ? 1 : 0);
	expect(lines.some((line) => line.includes("Hidden reasoning"))).toBe(detail !== 0);
}
describe("visible conversation spacing", () => {
	test("keeps compact rows adjacent across hidden wrappers in live and reopened chats, then spaces expanded blocks", async () => {
		harness = await createHarness();
		const messages = fixtures();
		const source = JSON.stringify(messages);
		const context = {
			messages,
			thinkingLevel: "off",
			serviceTier: "default",
			model: null,
		} satisfies AgentConnectionSessionContext;
		const live = createMode(harness);
		await deliver(live, messages);
		const reopened = createMode(harness);
		await reopened.renderSessionContext(context);
		for (const mode of [live, reopened])
			for (const detail of [0, 1, 2, 0]) {
				assertSpacing(rows(mode.chatContainer.children), detail);
				mode.defaultEditor.handleInput("\x0f");
			}
		expect(JSON.stringify(messages)).toBe(source);
	});
	test("uses the same mode-aware spacing in side-pane conversation builders", async () => {
		harness = await createHarness();
		const mode = createMode(harness);
		const components = buildConversationComponents(fixtures(), {
			ui: mode.ui,
			cwd: harness.tempDir,
			toolOptions: {},
			getToolDefinition: () => undefined,
			hideThinkingBlock: true,
		});
		for (const detail of [0, 1, 2, 0]) {
			for (const component of components) {
				if (component instanceof AssistantMessageComponent) component.setHideThinkingBlock(detail === 0);
				if ("setExpanded" in component && typeof component.setExpanded === "function")
					component.setExpanded(detail === 2);
			}
			assertSpacing(rows(components), detail);
		}
	});
	test("separates shell notices from the previous visible event in live, replay and all detail modes", async () => {
		harness = await createHarness();
		const refinement = createRefinementOutcomeMessage({
			id: "spacing-refinement",
			summary: "Remember the verified shell behavior.",
			rationale: "Keep the result.",
			expectedOutcome: "Retain verified knowledge.",
			appliedEdits: [{ action: "create", kind: "memory", id: "verified-shell", applied: true }],
			harnessStatePath: "/tmp/harness.json",
			scope: "local",
		});
		const messages: AgentMessage[] = [
			refinement,
			fauxAssistantMessage([fauxText("")]),
			createAsyncBashCompletionMessage({ pid: 91, command: "unmatched", exitCode: 0 }, 10000),
			fauxAssistantMessage([fauxThinking("Reasoning after completion"), fauxText("")]),
			createAsyncBashCompletionMessage({ pid: 92, command: "another unmatched", exitCode: 0 }, 20000),
		];
		const source = JSON.stringify(messages);
		const live = createMode(harness);
		await deliver(live, messages);
		const reopened = createMode(harness);
		await reopened.renderSessionContext({ messages, thinkingLevel: "off", serviceTier: "default", model: null });
		for (const mode of [live, reopened]) {
			const [refinementComponent, empty, firstShell, thinking, secondShell] = mode.chatContainer.children;
			for (const detail of [0, 1, 2, 0]) {
				expect(empty!.render(120)).toEqual([]);
				const refinementRows = refinementComponent!.render(120);
				const firstShellRows = firstShell!.render(120);
				expect(stripAnsi(refinementRows.at(-1)!).trim()).not.toBe("");
				expect(precedingGap(rows(mode.chatContainer.children), "Background shell command finished")).toBe(1);
				expect(firstShellRows[0]).toBe("");
				expect(stripAnsi(firstShellRows[1]!)).toContain("Background shell command finished");
				// No trailing separator is added to an event merely because it ends the transcript.
				expect(mode.chatContainer.render(120).slice(0, refinementRows.length)).toEqual(refinementRows);
				expect(secondShell!.render(120)[0] === "").toBe(detail !== 0);
				expect(thinking!.render(120).length > 0).toBe(detail !== 0);
				mode.defaultEditor.handleInput("\x0f");
			}
		}
		expect(JSON.stringify(messages)).toBe(source);
	});

	test("handles long invisible histories without losing the preceding compact row", async () => {
		harness = await createHarness();
		const mode = createMode(harness);
		const messages = [
			notice("start"),
			...Array.from({ length: 400 }, () => fauxAssistantMessage([fauxThinking("hidden"), fauxText("")])),
			notice("end"),
		];
		const components = buildConversationComponents(messages, {
			ui: mode.ui,
			cwd: harness.tempDir,
			toolOptions: {},
			getToolDefinition: () => undefined,
			hideThinkingBlock: true,
		});
		expect(rows(components).filter((line) => line.trim())).toHaveLength(2);
		expect(precedingGap(rows(components), "from child end")).toBe(0);
	});
	test("does not recursively inspect adjacent streamed tool-only wrappers", async () => {
		harness = await createHarness();
		const mode = createMode(harness);
		const components = buildConversationComponents([notice("start")], {
			ui: mode.ui,
			cwd: harness.tempDir,
			toolOptions: {},
			getToolDefinition: () => undefined,
			hideThinkingBlock: true,
		});
		for (let index = 0; index < 500; index++) {
			const spacing = createConversationSpacing(components);
			components.push(
				new AssistantMessageComponent(
					fauxAssistantMessage(call(`pending-${index}`), { stopReason: "toolUse" }),
					true,
					undefined,
					{ precededByToolActivity: spacing.precededByToolActivity },
				),
			);
		}
		expect(createConversationSpacing(components).precededByToolActivity()).toBe(true);
		expect(createConversationSpacing(components).shouldAddLeadingSpace(false)).toBe(false);
		expect(rows(components).filter((line) => line.trim())).toHaveLength(1);
	});
});
