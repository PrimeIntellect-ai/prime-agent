import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import type { AgentConnection, AgentConnectionSessionEvent } from "../../../src/modes/agent-connection/index.js";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.js";
import type { TopBar } from "../../../src/modes/interactive/components/top-bar.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { createInteractiveModeUiServices } from "../../../src/modes/interactive/interactive-mode-services.js";
import { initTheme, stopThemeWatcher } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

type ModeControls = {
	defaultEditor: CustomEditor;
	ui: TUI;
	topBar: TopBar;
	handleEvent(event: AgentConnectionSessionEvent): Promise<void>;
	setupEditorSubmitHandler(): void;
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
	controls.setupEditorSubmitHandler();
	return controls;
}

function topBarLine(mode: ModeControls): string {
	return stripAnsi(mode.topBar.render(80).join("\n"));
}

function completedResponse(tokens: number, elapsedMs: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: tokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now() - elapsedMs,
	};
}

describe("/speed readout placement", () => {
	test("shows the tok/s readout on the top bar line with the chat name, and nowhere else", async () => {
		harness = await createHarness();
		const mode = createMode(harness);
		// Stand in for the branch spend the cost refresh caches for the top bar.
		Object.assign(mode, { topBarCost: { sessionId: undefined, total: 1.42 } });
		const withoutSpeed = topBarLine(mode);
		expect(withoutSpeed).toContain("$1.42");

		await mode.defaultEditor.onSubmit?.("/speed on");
		await mode.handleEvent({ type: "message_end", message: completedResponse(100, 2_000) });

		const withSpeed = topBarLine(mode);
		expect(withSpeed).toContain("50.0 tok/s");
		// Same row as the chat name: the readout leads the line the name sits on.
		expect(mode.topBar.render(80)).toHaveLength(1);
		expect(withSpeed.startsWith("50.0 tok/s")).toBe(true);
		expect(withSpeed).toContain(withoutSpeed.trim());

		await mode.defaultEditor.onSubmit?.("/speed off");
		expect(topBarLine(mode)).toBe(withoutSpeed);
	});
});
