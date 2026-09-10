import { Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import {
	BrandSplashHeader,
	getRandomStartHint,
	InteractiveMode,
	START_HINTS,
} from "../src/modes/interactive/interactive-mode.js";
import type { PromptStashState } from "../src/modes/interactive/prompt-stash-state.js";
import { getEditorTheme, getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

describe("InteractiveMode startup hints", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	function createMode(messageCount = 0, returnToAgentsView = false, getEditorText = () => "") {
		const editor = { getText: getEditorText };
		const mode = {
			options: { returnToAgentsView },
			editor,
			editorContainer: { children: [editor] as unknown[] },
			ui: { hasOverlay: () => false },
			heartbeatCatalog: [],
			subagentSnapshots: new Map(),
			connectionState: {
				model: { id: "test-model", name: "test-model", provider: "test-provider", reasoning: true },
				thinkingLevel: "high",
				messageCount,
				isStreaming: false,
			},
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		return mode;
	}

	it("keeps a blank row above the shared splash and limits its metadata", () => {
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
			undefined,
			{
				topPadding: true,
				getStartHint: () => 'Try "refactor @<filepath>"',
			},
		);

		const lines = header.render(120);
		const output = stripAnsi(lines.join("\n"));

		expect(lines[0]).toBe("");
		expect(output).toContain("version  v0.0.0");
		expect(output).toContain("model    test-model");
		expect(output).toContain("cwd      /tmp/project");
		expect(output).toContain('Try "refactor @<filepath>"');
		expect(output).not.toContain("input");
		expect(output).not.toContain("files");
		expect(output).not.toContain("help");

		const unpadded = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
		);
		expect(unpadded.render(120)[0]).not.toBe("");
	});

	it("randomly selects from five concise filepath prompts", () => {
		expect(START_HINTS).toHaveLength(5);
		expect(new Set(START_HINTS).size).toBe(5);

		for (const [index, hint] of START_HINTS.entries()) {
			expect(getRandomStartHint(() => index / START_HINTS.length)).toBe(hint);
			expect(hint).toMatch(/^Try ".*@<filepath>.*"$/);
		}
	});

	it("places the fresh-chat shortcut hint after the model", () => {
		const mode = createMode();
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("test-model  ? for shortcuts");
	});

	it("shows current effort in a compact prompt label and hides it for non-reasoning models", () => {
		const mode = createMode();
		const getLabel = (width: number) =>
			Reflect.get(InteractiveMode.prototype, "getPromptEffortLabel").call(mode, width) as string | undefined;

		expect(stripAnsi(getLabel(40)!)).toBe("high · /effort");
		expect(stripAnsi(getLabel(6)!)).toBe("high");
		expect(stripAnsi(getLabel(3)!)).toBe("hig");
		expect(getLabel(0)).toBeUndefined();
		mode.connectionState.thinkingLevel = "off";
		expect(stripAnsi(getLabel(40)!)).toBe("off · /effort");
		mode.connectionState.thinkingLevel = "xhigh";
		mode.connectionState.isStreaming = true;
		expect(stripAnsi(getLabel(40)!)).toBe("xhigh · /effort");
		mode.connectionState.model.reasoning = false;
		expect(getLabel(40)).toBeUndefined();
	});

	it.each([
		["GLM 5.3 Fast (internal)", "GLM 5.3 Fast"],
		["internal/glm-5.3-fast", "glm-5.3-fast"],
		["test-provider/test-model", "test-model"],
		["Qwen/Qwen3-Next-80B-A3B-Instruct", "Qwen/Qwen3-Next-80B-A3B-Instruct"],
		["custom/fine-tune (thinking)", "custom/fine-tune (thinking)"],
	])("shortens the prompt model name %s without changing model identity", (name, expected) => {
		const mode = createMode();
		mode.connectionState.model.name = name;
		const before = { ...mode.connectionState.model };

		expect(Reflect.get(InteractiveMode.prototype, "getModelTrayLabel").call(mode)).toBe(expected);
		expect(mode.connectionState.model).toEqual(before);
	});

	it("refreshes effort above the prompt without rebuilding the recap", () => {
		const mode = {
			...createMode(),
			recapContainer: new Container(),
			agentRunFileChanges: new Map(),
			ui: { requestRender: vi.fn() },
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		Reflect.get(InteractiveMode.prototype, "renderRecap").call(mode);
		const render = () => stripAnsi(mode.recapContainer.render(80).join("\n"));

		expect(render()).toContain("high · /effort");
		mode.connectionState.thinkingLevel = "low";
		expect(render()).toContain("low · /effort");
		mode.connectionState.model.reasoning = false;
		expect(mode.recapContainer.render(80)).toEqual([]);
		mode.connectionState.model.reasoning = true;
		expect(render()).toContain("low · /effort");
		Reflect.deleteProperty(mode.connectionState, "model");
		expect(mode.recapContainer.render(80)).toEqual([]);
	});

	it.each([false, true])("keeps effort outside custom editors and preserves drafts and headers (%s)", (ownHeader) => {
		const keybindings = new KeybindingsManager();
		const ui = { terminal: { rows: 24 }, requestRender: vi.fn(), setFocus: vi.fn() } as unknown as TUI;
		const defaultEditor = new CustomEditor(ui, getEditorTheme(), keybindings);
		defaultEditor.setText("unfinished draft");
		const mode = {
			...createMode(),
			ui,
			keybindings,
			defaultEditor,
			editor: defaultEditor,
			editorContainer: new Container(),
			recapContainer: new Container(),
			agentRunFileChanges: new Map(),
			sessionRecap: "Updated files",
			pastedImages: new Map(),
			queueSelection: { selected: undefined },
			ctrlCExitHintExpiresAt: 0,
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		Reflect.get(InteractiveMode.prototype, "renderRecap").call(mode);
		const replacement = new CustomEditor(ui, getEditorTheme(), keybindings);
		if (ownHeader) replacement.getHeaderLine = () => "extension header";

		Reflect.get(InteractiveMode.prototype, "setCustomEditorComponent").call(mode, () => replacement);

		expect(replacement.getText()).toBe("unfinished draft");
		expect(stripAnsi(replacement.render(80).join("\n"))).not.toContain("/effort");
		if (ownHeader) expect(replacement.render(80)[1]).toContain("extension header");
		const rows = mode.recapContainer.render(80);
		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[0]!)).toMatch(/^ Recap: Updated files\s+high · \/effort $/);
		expect(rows[1]).toBe("");
		expect(rows[0]).not.toMatch(/\x1b\[(?:4\d|10[0-7])(?:;[\d;]*)?m/);
		mode.connectionState.thinkingLevel = "low";
		expect(stripAnsi(mode.recapContainer.render(80)[0]!)).toContain("low · /effort");
		Reflect.get(InteractiveMode.prototype, "setCustomEditorComponent").call(mode, undefined);
		expect(defaultEditor.getText()).toBe("unfinished draft");
		expect(stripAnsi(defaultEditor.render(80).join("\n"))).not.toContain("/effort");
	});

	it("uses the configured keybinding in the manage hint", () => {
		setKeybindings(new KeybindingsManager({ "app.agents.back": "ctrl+g" }));
		const label = Reflect.get(InteractiveMode.prototype, "getAgentsViewTrayHint").call(createMode(0, true));

		expect(stripAnsi(label)).toBe("Ctrl+G manage");
	});

	it("keeps fresh-chat guidance hidden when a mid-turn snapshot still has no committed messages", () => {
		const mode = createMode();
		const patchConnectionState = (patch: Record<string, unknown>) => Object.assign(mode.connectionState, patch);
		Object.assign(mode, {
			patchConnectionState,
			builtInHeader: { invalidate: vi.fn() },
			subagentSummaryLine: { invalidate: vi.fn() },
		});
		const updateConnectionStateFromEvent = Reflect.get(
			InteractiveMode.prototype,
			"updateConnectionStateFromEvent",
		) as (event: unknown) => void;
		const getLabel = () => stripAnsi(Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode));
		const message = { role: "user", content: "hello", timestamp: 1 };

		updateConnectionStateFromEvent.call(mode, { type: "agent_start" });
		updateConnectionStateFromEvent.call(mode, { type: "message_start", message });
		Object.assign(mode.connectionState, { messageCount: 0, isStreaming: true });

		expect(getLabel()).not.toContain("for shortcuts");

		updateConnectionStateFromEvent.call(mode, { type: "message_end", message });
		updateConnectionStateFromEvent.call(mode, { type: "agent_end", messages: [message] });
		expect(getLabel()).not.toContain("for shortcuts");
	});

	it("routes session-view requests through the existing agents-view return path", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(0, true), { returnToAgentsView });

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledOnce();
	});

	it("no longer blocks the agents-view handoff on a draft", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const showStatus = vi.fn();
		const mode = Object.assign(
			createMode(0, true, () => "draft prompt"),
			{ returnToAgentsView, showStatus },
		);

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledOnce();
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("no longer blocks the scoped agents-view handoff on a draft", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const showStatus = vi.fn();
		const mode = Object.assign(
			createMode(0, true, () => "scoped draft"),
			{ returnToAgentsView, showStatus },
		);

		await Reflect.get(InteractiveMode.prototype, "openScopedAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledWith("scoped_agents_view");
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("stashes the draft once per agents-view handoff even when re-requested mid-teardown", async () => {
		const promptStashState: PromptStashState = {};
		let resolveDispose!: () => void;
		const disposePromise = new Promise<void>((resolve) => {
			resolveDispose = resolve;
		});
		const mode = Object.assign(
			createMode(0, true, () => "draft prompt"),
			{
				promptStashState,
				pastedImages: new Map(),
				isShuttingDown: false,
				agentsViewRequest: undefined,
				unregisterSignalHandlers: vi.fn(),
				teardownSessionUi: vi.fn(async () => {}),
				agentConnection: { dispose: vi.fn(() => disposePromise) },
			},
		);
		const returnToAgentsView = Reflect.get(InteractiveMode.prototype, "returnToAgentsView");

		const firstHandoff = returnToAgentsView.call(mode);
		await returnToAgentsView.call(mode);

		expect(promptStashState.stash).toMatchObject({ text: "draft prompt", restoreOnOpen: true });
		expect(promptStashState.queuedStashes).toBeUndefined();
		resolveDispose();
		await firstHandoff;
	});

	it("opens the shared session view on back navigation for process-local chats", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(0, false), { requestAgentsView, returnToAgentsView });

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(true);
		expect(requestAgentsView).toHaveBeenCalledOnce();
		expect(returnToAgentsView).not.toHaveBeenCalled();
	});

	it("returns to the daemon agents view on back navigation for daemon chats", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(0, true), { requestAgentsView, returnToAgentsView });

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(true);
		expect(returnToAgentsView).toHaveBeenCalledOnce();
		expect(requestAgentsView).not.toHaveBeenCalled();
	});

	it("leaves back navigation to the editor while a draft exists", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const mode = Object.assign(
			createMode(0, false, () => "draft prompt"),
			{ requestAgentsView },
		);

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(false);
		expect(requestAgentsView).not.toHaveBeenCalled();
	});

	it("explains that the agents view needs the daemon for non-daemon chats", async () => {
		const showStatus = vi.fn();
		const shutdown = vi.fn(async () => {});
		const mode = Object.assign(createMode(0, false), {
			returnToAgentsView: vi.fn(async () => {}),
			showStatus,
			shutdown,
		});

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("needs the daemon"));
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("keeps the manage hint while typing", () => {
		let editorText = "";
		const mode = createMode(0, true, () => editorText);
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(getLabel())).toBe("← manage  test-model  ? for shortcuts");

		editorText = "draft prompt";
		expect(stripAnsi(getLabel())).toBe("← manage  test-model");
	});

	it("hides the fresh-chat shortcut hint while the prompt has text", () => {
		let editorText = "";
		const mode = createMode(0, false, () => editorText);
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(getLabel())).toBe("test-model  ? for shortcuts");

		editorText = "draft prompt";
		expect(stripAnsi(getLabel())).toBe("test-model");

		editorText = " ";
		expect(stripAnsi(getLabel())).toBe("test-model");

		editorText = "";
		expect(stripAnsi(getLabel())).toBe("test-model  ? for shortcuts");
	});

	it("hides the tray shortcut guidance for chats with history", () => {
		const mode = createMode(1);
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("test-model");
	});

	it("hides the tray while an inline picker is open", () => {
		const mode = createMode(0, true);
		const locationLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);
		const contextLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayContextLabel").call(mode);
		const overrideLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode);
		Object.assign(mode.connectionState, {
			goal: {
				active: true,
				status: "active",
				objective: "finish the task",
				tokensUsed: 0,
				timeUsedSeconds: 65,
				continuationsUsed: 1,
			},
			contextUsage: { contextWindow: 100_000, tokens: 75_000, percent: 75 },
		});
		Object.assign(mode, { ctrlCExitHintExpiresAt: Date.now() + 60_000 });

		expect(stripAnsi(locationLabel())).toBe("← manage  test-model  ? for shortcuts");
		expect(stripAnsi(contextLabel())).toBe("Pursuing goal (1m 05s) · 75k (75%)");
		expect(stripAnsi(overrideLabel())).toBe("Press Ctrl+C again to exit");

		mode.ui.hasOverlay = () => true;
		expect(locationLabel()).toBeUndefined();
		expect(contextLabel()).toBeUndefined();
		expect(overrideLabel()).toBeUndefined();

		mode.ui.hasOverlay = () => false;
		mode.editorContainer.children.length = 0;
		mode.editorContainer.children.push({});
		expect(locationLabel()).toBeUndefined();
		expect(contextLabel()).toBeUndefined();
		expect(overrideLabel()).toBeUndefined();
	});

	it("never shows a depth label for root sessions and keeps it for subagent sessions", () => {
		const root = createMode();
		Object.assign(root.options, { sessionDepth: 0, sessionHasChildren: true });
		const subagent = createMode(1);
		Object.assign(subagent.options, { sessionDepth: 1 });
		const getLabel = (mode: ReturnType<typeof createMode>) =>
			stripAnsi(Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode));

		expect(getLabel(root)).toBe("test-model  ? for shortcuts");
		expect(getLabel(subagent)).toBe("depth 1  test-model");
	});

	it("keeps the question-mark shortcut guide compact", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getShortcutGuide").call(createMode());

		expect(guide).toContain("`!` shell mode · `/` commands · `@` file paths");
		expect(guide).toContain("stash prompt");
		expect(guide).toContain("`/hotkeys` full reference");
		expect(guide).not.toContain("Ctrl+Z");
		expect(guide).not.toContain("suspend");
		expect(guide).not.toContain("**Navigation**");
		expect(guide).not.toContain("**Extensions**");
	});

	it("renders question-mark shortcut help ephemerally without appending to chat history", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "showShortcutGuide").call(mode);
		Reflect.get(InteractiveMode.prototype, "showShortcutGuide").call(mode);

		expect(chatContainer.children).toHaveLength(0);
		expect(shortcutGuideContainer.children).toHaveLength(2);

		Reflect.get(InteractiveMode.prototype, "clearShortcutGuide").call(mode);

		expect(shortcutGuideContainer.children).toHaveLength(0);
	});

	it("keeps /hotkeys comprehensive without Ctrl+Z", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getHotkeysGuide").call(createMode());

		expect(guide).toContain("**Navigation**");
		expect(guide).toContain("**Editing**");
		expect(guide).toContain("**Fullscreen mode (`/fullscreen`)**");
		expect(guide).toContain("Queue follow-up message");
		expect(guide).not.toContain("Ctrl+Z");
		expect(guide).not.toContain("Suspend to background");
	});

	it("renders /hotkeys in chat history instead of the temporary guide", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "handleHotkeysCommand").call(mode);

		expect(chatContainer.children).toHaveLength(2);
		expect(shortcutGuideContainer.children).toHaveLength(0);
	});
});
