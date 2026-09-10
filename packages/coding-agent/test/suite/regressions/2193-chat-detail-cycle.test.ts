import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { type Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { afterEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import type { AgentConnection, AgentConnectionSessionEvent } from "../../../src/modes/agent-connection/index.js";
import { BashExecutionComponent } from "../../../src/modes/interactive/components/bash-execution.js";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.js";
import { SideQuestionComponent } from "../../../src/modes/interactive/components/side-question.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { createInteractiveModeUiServices } from "../../../src/modes/interactive/interactive-mode-services.js";
import { initTheme, stopThemeWatcher } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const output = "preview-one\npreview-two\npreview-three\nFULL_TOOL_OUTPUT";
const tools: AgentTool[] = [
	{
		name: "generic",
		label: "Generic",
		description: "Fixture output",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: output }], details: {} }),
	},
	{
		name: "edit",
		label: "Edit",
		description: "Fixture diff",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({
			content: [],
			details: { diff: "-1 OLD_FILE_CONTENT\n+1 NEW_FILE_CONTENT", firstChangedLine: 1 },
		}),
	},
];
type ModeControls = {
	chatContainer: Container;
	defaultEditor: CustomEditor;
	ui: TUI;
	agentMessagesExpanded: boolean;
	setupKeyHandlers(): void;
	renderSessionContext(
		context: ReturnType<SessionManager["buildSessionContext"]>,
		options?: { clearChat: boolean },
	): Promise<void>;
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
function render(mode: ModeControls): string {
	return stripAnsi(mode.chatContainer.render(120).join("\n"));
}
function cycle(mode: ModeControls): void {
	mode.defaultEditor.handleInput("\x0f");
}
function assertMode(mode: ModeControls, detail: "overview" | "details" | "all"): void {
	const text = render(mode);
	expect(text).toContain("Visible assistant answer");
	expect(text).toContain("+1 -1");
	expect(text.includes("PRIVATE_THINKING")).toBe(detail !== "overview");
	expect(text.includes("NEW_FILE_CONTENT")).toBe(detail !== "overview");
	expect(text.includes("FULL_TOOL_OUTPUT")).toBe(detail === "all");
}
describe("conversation detail cycle", () => {
	test("cycles a reopened saved chat without changing messages or JSONL", async () => {
		harness = await createHarness({ tools, persistSession: true, settings: { hideThinkingBlock: false } });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("PRIVATE_THINKING"),
					fauxText("Visible assistant answer"),
					fauxToolCall("generic", {}, { id: "generic-call" }),
					fauxToolCall("edit", { path: "example.ts" }, { id: "edit-call" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Show the fixture");
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted fixture");
		const savedTrace = readFileSync(sessionFile, "utf8");
		const context = SessionManager.open(sessionFile).buildSessionContext();
		const source = JSON.stringify(context.messages);
		const mode = createMode(harness);
		await mode.renderSessionContext(context);
		assertMode(mode, "overview");
		cycle(mode);
		assertMode(mode, "details");
		cycle(mode);
		assertMode(mode, "all");
		expect(mode.agentMessagesExpanded).toBe(true);
		mode.defaultEditor.handleInput("\x10");
		expect(mode.agentMessagesExpanded).toBe(false);
		await mode.renderSessionContext(context, { clearChat: true });
		assertMode(mode, "all");
		cycle(mode);
		assertMode(mode, "overview");
		expect(JSON.stringify(context.messages)).toBe(source);
		expect(readFileSync(sessionFile, "utf8")).toBe(savedTrace);
		expect(harness.settingsManager.getHideThinkingBlock()).toBe(false);
	});
	test("applies the chosen mode to streamed thinking, tool results, and future turns", async () => {
		harness = await createHarness({ tools });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("STREAM_THINKING"),
					fauxText("Streaming answer"),
					fauxToolCall("generic", {}, { id: "stream-tool" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxThinking("NEXT_TURN_THINKING"), fauxText("Next answer")]),
		]);
		await harness.session.prompt("Stream the fixture");
		const mode = createMode(harness);
		cycle(mode);
		for (const event of harness.events) {
			if (
				event.type === "message_start" ||
				event.type === "message_update" ||
				event.type === "message_end" ||
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end"
			)
				await mode.handleEvent(event);
		}
		expect(render(mode)).toContain("STREAM_THINKING");
		expect(render(mode)).toContain("NEXT_TURN_THINKING");
		expect(render(mode)).toContain("Next answer");
		expect(render(mode)).not.toContain("FULL_TOOL_OUTPUT");
		cycle(mode);
		expect(render(mode)).toContain("FULL_TOOL_OUTPUT");
		cycle(mode);
		expect(render(mode)).not.toContain("STREAM_THINKING");
		expect(render(mode)).not.toContain("NEXT_TURN_THINKING");
		expect(render(mode)).toContain("Streaming answer");
		await mode.handleEvent({
			type: "message_start",
			message: fauxAssistantMessage([fauxThinking("LATER_THINKING"), fauxText("Later answer")]),
		});
		expect(render(mode)).not.toContain("LATER_THINKING");
		cycle(mode);
		expect(render(mode)).toContain("LATER_THINKING");
	});
	test("cycles finished side-pane and pending main-chat bash output", async () => {
		harness = await createHarness();
		const mode = createMode(harness);
		const side = new SideQuestionComponent({
			id: "side",
			question: "Question",
			answer: "Answer",
			status: "complete",
		});
		const makeBash = () => {
			const bash = new BashExecutionComponent("fixture", mode.ui);
			bash.appendOutput(["HIDDEN_BASH_HEAD", ...Array.from({ length: 25 }, (_, i) => `line ${i}`)].join("\n"));
			bash.setComplete(0, false);
			return bash;
		};
		const sideBash = makeBash();
		const pendingBash = makeBash();
		side.addBash(sideBash);
		side.finishBash();
		Object.assign(mode, { sideQuestionComponent: side, pendingBashComponents: [pendingBash] });
		const bashText = () => stripAnsi([...side.render(120), ...pendingBash.render(120)].join("\n"));
		expect(bashText()).not.toContain("HIDDEN_BASH_HEAD");
		cycle(mode);
		expect(bashText()).not.toContain("HIDDEN_BASH_HEAD");
		cycle(mode);
		expect(bashText().match(/HIDDEN_BASH_HEAD/g)).toHaveLength(2);
		cycle(mode);
		expect(bashText()).not.toContain("HIDDEN_BASH_HEAD");
	});
});
