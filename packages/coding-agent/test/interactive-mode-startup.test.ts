import {
	type AutocompleteProvider,
	type Component,
	Container,
	setKeybindings,
	Text,
	TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { emptyUsage } from "../src/core/usage.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { BrandSplashHeader, InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import type { PromptStashState } from "../src/modes/interactive/prompt-stash-state.js";
import { getEditorTheme, getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.js";

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
				model: { id: "test-model", name: "Test Model", provider: "test-provider", reasoning: true },
				thinkingLevel: "high",
				messageCount,
				isStreaming: false,
			},
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		return mode;
	}

	it("shows a compact butterfly beside metadata without a repeated input hint", () => {
		const header = new BrandSplashHeader("0.0.0", () => "/tmp/project", undefined, {
			topPadding: true,
			getExtraMetadata: () => [{ label: "agents", value: "2 running" }],
		});

		const lines = header.render(120);
		const output = stripAnsi(lines.join("\n"));

		expect(lines[0]).toBe("");
		expect(lines.length).toBeLessThanOrEqual(8);
		expect(output).toContain("prime agent v0.0.0");
		expect(output).toMatch(/[▗▙▛▜]/u);
		expect(stripAnsi(lines[4])).toContain("agents 2 running");
		expect(stripAnsi(lines[5])).toContain("cwd /tmp/project");
		expect(output).not.toContain("model ");
		expect(output).not.toContain("Try ");
		expect(output).not.toContain("type to search sessions");

		const unpadded = new BrandSplashHeader("0.0.0", () => "/tmp/project");
		expect(unpadded.render(120)[0]).not.toBe("");
	});

	it("renders the model line in the chat splash without effort metadata", () => {
		let modelId: string | undefined = "first-model";
		const header = new BrandSplashHeader("0.0.0", () => "/tmp/project", undefined, {
			topPadding: true,
			getModelId: () => modelId,
		});

		const lines = header.render(120);
		const output = stripAnsi(lines.join("\n"));

		expect(output).toContain("prime agent v0.0.0");
		expect(stripAnsi(lines[3])).toContain("prime agent v0.0.0");
		expect(stripAnsi(lines[4])).toContain("model first-model");
		expect(stripAnsi(lines[5])).toContain("cwd /tmp/project");
		expect(output).not.toContain("•");

		modelId = "second-model";
		const updated = stripAnsi(header.render(120).join("\n"));
		expect(updated).toContain("model second-model");
		expect(updated).not.toContain("first-model");

		modelId = undefined;
		expect(stripAnsi(header.render(120).join("\n"))).toContain("model —");
	});

	it("keeps metadata visible in narrow terminals and bounds every rendered row", () => {
		const header = new BrandSplashHeader("0.0.0", () => "/tmp/project");

		for (const width of [1, 2, 12, 14, 20, 24, 39, 40, 50, 51, 80]) {
			const lines = header.render(width);
			const output = stripAnsi(lines.join("\n"));
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			if (width < 51) {
				expect(output).not.toMatch(/[▗▙▛▜]/u);
				if (width >= 14) expect(output).toContain("prime agent");
			} else {
				expect(output).toMatch(/[▗▙▛▜]/u);
				expect(output).toContain("agent v0.0.0");
			}
			if (width >= 14) {
				expect(output).toContain("v0.0.0");
			}
			if (width >= 18) {
				expect(output).toContain("cwd /tmp/project");
			}
		}
	});

	it("renders live agents metadata, custom marks, and verbose instructions", () => {
		let cwd = "/tmp/first";
		const header = new BrandSplashHeader("0.0.0", () => cwd, "custom shortcut instructions", {
			logo: "<>\n><",
			getExtraMetadata: () => [
				{ label: "agents", value: "2 running" },
				{ label: "scope", value: "current project" },
			],
		});

		const initial = stripAnsi(header.render(80).join("\n"));
		expect(initial).toContain("<>");
		expect(initial).toContain("prime agent v0.0.0");
		expect(initial).toContain("agents 2 running");
		expect(initial).toContain("scope current project");
		expect(initial).toContain("custom shortcut instructions");

		cwd = "/tmp/second";
		const updated = stripAnsi(header.render(80).join("\n"));
		expect(updated).toContain("/tmp/second");
	});

	it("keeps fresh-chat shortcut instructions out of the lower tray", () => {
		const mode = createMode();
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("");
	});

	it("shows the model ID and current effort in the lower tray and omits unsupported effort", () => {
		const mode = createMode();
		const getLabel = (width: number) =>
			Reflect.get(InteractiveMode.prototype, "getModelContextLabel").call(mode, width) as string | undefined;

		expect(stripAnsi(getLabel(40)!)).toBe("test-model:high");
		expect(stripAnsi(getLabel(6)!)).toBe("test-m");
		expect(stripAnsi(getLabel(3)!)).toBe("tes");
		expect(getLabel(0)).toBeUndefined();
		mode.connectionState.thinkingLevel = "off";
		expect(stripAnsi(getLabel(40)!)).toBe("test-model:off");
		mode.connectionState.thinkingLevel = "xhigh";
		mode.connectionState.isStreaming = true;
		expect(stripAnsi(getLabel(40)!)).toBe("test-model:xhigh");
		mode.connectionState.model.reasoning = false;
		expect(stripAnsi(getLabel(40)!)).toBe("test-model");
	});

	it("shows context usage after model and effort below without duplicating it above", () => {
		const mode = createMode(1);
		mode.connectionState.model.id = "glm-5.3";
		Object.assign(mode.connectionState, {
			contextUsage: { contextWindow: 400_000, tokens: 175_000, percent: 43.75 },
		});
		const label = Reflect.get(InteractiveMode.prototype, "getModelContextLabel").call(mode, 120);

		expect(stripAnsi(label)).toBe("glm-5.3:high · 175k (44%)");
		expect(stripAnsi(Reflect.get(InteractiveMode.prototype, "getTrayContextLabel").call(mode))).toBe(
			"glm-5.3:high · 175k (44%)",
		);
		expect(stripAnsi(Reflect.get(InteractiveMode.prototype, "getPromptContextLabel").call(mode, 120))).not.toContain(
			"175k",
		);
	});

	it("keeps available context usage visible when the model is unknown", () => {
		const mode = createMode(1);
		Reflect.deleteProperty(mode.connectionState, "model");
		Object.assign(mode.connectionState, {
			contextUsage: { contextWindow: 100_000, tokens: 12_000, percent: 12 },
		});
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getModelContextLabel").call(mode, 120);

		expect(stripAnsi(getLabel())).toBe("12k (12%)");
		Reflect.deleteProperty(mode.connectionState, "contextUsage");
		expect(getLabel()).toBeUndefined();
	});

	it("refreshes context usage during streaming and omits unknown post-compaction counts", () => {
		let outputTokens = 7_000;
		const mode = Object.assign(createMode(1), {
			recapContainer: new Container(),
			agentRunFileChanges: new Map(),
			activityTracker: { getStatus: () => ({ tokens: outputTokens }) },
			contextUsageTokenBaseline: 5_000,
			ui: { requestRender: vi.fn() },
		});
		Object.assign(mode.connectionState, {
			contextUsage: { contextWindow: 100_000, tokens: 42_000, percent: 42 },
			isStreaming: true,
		});
		Reflect.get(InteractiveMode.prototype, "renderRecap").call(mode);
		const render = () => stripAnsi(Reflect.get(InteractiveMode.prototype, "getModelContextLabel").call(mode));

		expect(render()).toContain("test-model:high · 44k (44%)");
		outputTokens = 8_000;
		expect(render()).toContain("test-model:high · 45k (45%)");
		Object.assign(mode.connectionState, { contextUsage: { contextWindow: 100_000, tokens: null, percent: null } });
		expect(render()).toContain("test-model:high");
		expect(render()).not.toContain("%");
		Object.assign(mode.connectionState, {
			contextUsage: { contextWindow: 100_000, tokens: 0, percent: 0 },
			isStreaming: false,
		});
		expect(render()).toContain("test-model:high · 0 (0%)");
	});

	it.each([
		["glm-5.3", "glm-5.3"],
		["glm-5.3-high", "glm-5.3-high"],
		["test-provider/glm-5.3", "glm-5.3"],
		["Qwen/Qwen3-Next-80B-A3B-Instruct", "Qwen/Qwen3-Next-80B-A3B-Instruct"],
	])("shows model ID %s without changing its spelling or identity", (id, expected) => {
		const mode = createMode();
		mode.connectionState.model.id = id;
		const before = { ...mode.connectionState.model };

		expect(stripAnsi(Reflect.get(InteractiveMode.prototype, "getModelContextLabel").call(mode, 120))).toBe(
			`${expected}:high`,
		);
		expect(mode.connectionState.model).toEqual(before);
	});

	it("keeps fast mode separate and omits unavailable effort", () => {
		const mode = createMode();
		Object.assign(mode.connectionState, { serviceTier: "priority", thinkingLevel: undefined });
		expect(stripAnsi(Reflect.get(InteractiveMode.prototype, "getModelContextLabel").call(mode))).toBe(
			"test-model · fast",
		);
	});

	it.each([
		[false, false, "Collapsed mode (Ctrl+O to expand)"],
		[false, true, "Details mode (Ctrl+O to expand)"],
		[true, true, "Expanded mode (Ctrl+O to collapse)"],
	] as const)("shows a muted detail status above the prompt (%s, %s)", (allOutput, details, expected) => {
		const mode = Object.assign(createMode(), { toolOutputExpanded: allOutput, editDiffsExpanded: details });
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getPromptContextLabel").call(mode, 120);
		expect(getLabel()).toBe(theme.fg("dim", expected));
		expect(stripAnsi(Reflect.get(InteractiveMode.prototype, "getTrayContextLabel").call(mode))).toBe(
			"test-model:high",
		);
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
		expect(stripAnsi(getLabel())).toBe(expected.replace("Ctrl+O", "Ctrl+E"));
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		expect(stripAnsi(getLabel())).toBe(expected.split(" (")[0]);
	});

	it("refreshes effort in the lower tray without rebuilding the recap", () => {
		const mode = {
			...createMode(),
			recapContainer: new Container(),
			agentRunFileChanges: new Map(),
			ui: { requestRender: vi.fn() },
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		Reflect.get(InteractiveMode.prototype, "renderRecap").call(mode);
		const render = () => stripAnsi(Reflect.get(InteractiveMode.prototype, "getModelContextLabel").call(mode) ?? "");

		expect(render()).toContain("test-model:high");
		mode.connectionState.thinkingLevel = "low";
		expect(render()).toContain("test-model:low");
		mode.connectionState.model.reasoning = false;
		expect(render()).toContain("test-model");
		expect(render()).not.toContain("low");
		mode.connectionState.model.reasoning = true;
		expect(render()).toContain("test-model:low");
		Reflect.deleteProperty(mode.connectionState, "model");
		expect(render()).toBe("");
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
		expect(stripAnsi(rows[1]!)).toMatch(/^ Recap: Updated files\s+Collapsed mode \(Ctrl\+O to expand\) $/);
		expect(rows[0]).toBe("");
		expect(rows[1]).not.toMatch(/\x1b\[(?:4\d|10[0-7])(?:;[\d;]*)?m/);
		const promptDock = new Container();
		promptDock.addChild(mode.recapContainer);
		promptDock.addChild(mode.editorContainer);
		const dockRows = promptDock.render(80);
		expect(dockRows[1]).toBe(rows[1]);
		expect(dockRows[2]).toBe(replacement.render(80)[0]);
		expect(dockRows[2]).toMatch(/\x1b\[48;/);
		mode.connectionState.thinkingLevel = "low";
		expect(stripAnsi(Reflect.get(InteractiveMode.prototype, "getModelContextLabel").call(mode))).toContain(
			"test-model:low",
		);
		Reflect.get(InteractiveMode.prototype, "setCustomEditorComponent").call(mode, undefined);
		expect(defaultEditor.getText()).toBe("unfinished draft");
		expect(stripAnsi(defaultEditor.render(80).join("\n"))).not.toContain("/effort");
	});

	it.each(
		(["assistant", "tool", "refinement"] as const).flatMap((lastMessage) =>
			[false, true].flatMap((withWidget) =>
				[false, true].flatMap((withRecap) =>
					[false, true].map((pickerOpen) => ({ lastMessage, withWidget, withRecap, pickerOpen })),
				),
			),
		),
	)(
		"uses one prompt separator after $lastMessage (widget=$withWidget, recap=$withRecap, picker=$pickerOpen)",
		({ lastMessage, withWidget, withRecap, pickerOpen }) => {
			const width = 120;
			const ui = { terminal: { rows: 24 }, requestRender: vi.fn(), hasOverlay: () => pickerOpen } as unknown as TUI;
			const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager());
			editor.setText("Draft prompt");
			const activeInput = pickerOpen ? new Text("Choose a model", 1, 0) : editor;
			const editorContainer = new Container();
			editorContainer.addChild(activeInput);
			let finalMessage: Component;
			if (lastMessage === "assistant") {
				finalMessage = new AssistantMessageComponent({
					role: "assistant",
					content: [{ type: "text", text: "Finished the response." }],
					api: "openai-completions",
					provider: "test",
					model: "test-model",
					usage: emptyUsage(),
					stopReason: "stop",
					timestamp: 0,
				});
			} else if (lastMessage === "tool") {
				const tool = new ToolExecutionComponent("test-tool", "tool-1", {}, {}, undefined, ui, "/tmp");
				tool.updateResult({ content: [{ type: "text", text: "Finished the tool." }], isError: false });
				finalMessage = tool;
			} else {
				finalMessage = new RefinementOutcomeMessageComponent({
					role: "custom",
					customType: "refinement_outcome",
					content: "Refinement complete",
					display: true,
					timestamp: 0,
					details: { refinementId: "refine-1", summary: "Updated the harness", scope: "local", edits: [] },
				});
			}
			const widget = new Text("Extension widget", 1, 0);
			const mode = Object.assign(createMode(1, true), {
				ui,
				editor,
				editorContainer,
				widgetContainerAbove: new Container(),
				widgetContainerBelow: new Container(),
				extensionWidgetsAbove: new Map<string, Component>(withWidget ? [["test", widget]] : []),
				extensionWidgetsBelow: new Map<string, Component>(),
				queuedMessagesContainer: new Container(),
				sideQuestionContainer: new Container(),
				recapContainer: new Container(),
				agentRunFileChanges: new Map(),
				sessionRecap: withRecap ? "Completed the work" : undefined,
			});
			Reflect.get(InteractiveMode.prototype, "renderWidgets").call(mode);
			Reflect.get(InteractiveMode.prototype, "renderRecap").call(mode);
			const layout = new Container();
			layout.addChild(finalMessage);
			layout.addChild(mode.widgetContainerAbove);
			for (const container of Reflect.get(InteractiveMode.prototype, "getPromptContextContainers").call(mode)) {
				layout.addChild(container);
			}
			layout.addChild(mode.recapContainer);
			layout.addChild(mode.editorContainer);
			const recapRows = mode.recapContainer.render(width);
			const precedingRows = [...finalMessage.render(width)];
			if (withWidget) precedingRows.push("", ...widget.render(width));
			expect(layout.render(width)).toEqual([...precedingRows, "", recapRows[1], ...activeInput.render(width)]);
			expect(stripAnsi(recapRows[1]!)).toContain("Collapsed mode");
			expect(stripAnsi(recapRows[1]!)).not.toContain("test-model");
			expect(stripAnsi(recapRows[1]!)).toContain(withRecap ? "Recap: Completed the work" : "Collapsed mode");
			if (!withRecap) expect(stripAnsi(recapRows[1]!)).not.toContain("Recap:");
			expect(mode.widgetContainerBelow.render(width)).toEqual([]);
			if (!withWidget) expect(mode.widgetContainerAbove.render(width)).toEqual([]);
			if (withWidget) {
				mode.extensionWidgetsAbove.clear();
				Reflect.get(InteractiveMode.prototype, "renderWidgets").call(mode);
				expect(layout.render(width)).toEqual([
					...finalMessage.render(width),
					"",
					recapRows[1],
					...activeInput.render(width),
				]);
			}
		},
	);

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

		expect(stripAnsi(getLabel())).toBe("← manage");

		editorText = "draft prompt";
		expect(stripAnsi(getLabel())).toBe("← manage");
	});

	it("keeps shortcut instructions out of the tray for blank and nonempty prompts", () => {
		let editorText = "";
		const mode = createMode(0, false, () => editorText);
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(getLabel())).toBe("");

		editorText = "draft prompt";
		expect(stripAnsi(getLabel())).toBe("");

		editorText = " ";
		expect(stripAnsi(getLabel())).toBe("");

		editorText = "";
		expect(stripAnsi(getLabel())).toBe("");
	});

	it("hides the tray shortcut guidance for chats with history", () => {
		const mode = createMode(1);
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("");
	});

	it("keeps the tray and subagents visible during slash autocomplete but hides them for a picker", async () => {
		const ui = new TUI(new VirtualTerminal(100, 30));
		vi.spyOn(ui, "requestRender").mockImplementation(() => {});
		const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager());
		const provider: AutocompleteProvider = {
			getSuggestions: async (lines, line, col) => ({
				prefix: lines[line]!.slice(0, col),
				kind: "slash-command",
				items: [
					{ value: "/model", label: "model" },
					{ value: "/mcp", label: "mcp" },
				],
			}),
			applyCompletion: (lines, cursorLine, _cursorCol, item) => ({
				lines: lines.map((line, index) => (index === cursorLine ? item.value : line)),
				cursorLine,
				cursorCol: item.value.length,
			}),
		};
		editor.setAutocompleteProvider(provider);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const mode = Object.assign(createMode(1, true), { ui, editor, editorContainer });
		const call = (method: string) => Reflect.get(InteractiveMode.prototype, method).call(mode);
		const summary = new SubagentSummaryLine(
			() => call("getTrayLocationLabel"),
			() => call("getTrayContextLabel"),
			() => call("getTrayOverrideLabel"),
			() => call("isInlinePickerOpen"),
		);
		summary.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		summary.setOpenable(true);
		const expectVisible = () => {
			const output = stripAnsi(summary.render(100).join("\n"));
			expect(output).toContain("manage");
			expect(output).toContain("test-model:high");
			expect(output).toContain("subagents");
			expect(output).toContain("1 running");
		};
		ui.setFocus(editor);
		expectVisible();
		editor.handleInput("/");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		expect(ui.hasOverlay()).toBe(true);
		expectVisible();
		editor.handleInput("m");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		expect(editor.getText()).toBe("/m");
		expectVisible();

		// Opening a capturing picker must hide the tray even while autocomplete is retained underneath.
		const picker = ui.showOverlay(new Text("Models / Providers / MCP", 0, 0));
		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(editor.focused).toBe(false);
		expect(summary.render(100)).toEqual([]);
		picker.hide();
		expect(editor.focused).toBe(true);
		expectVisible();

		editorContainer.clear();
		editorContainer.addChild(new Text("Inline settings picker", 0, 0));
		expect(summary.render(100)).toEqual([]);
		editorContainer.clear();
		editorContainer.addChild(editor);
		expectVisible();
		editor.handleInput("\x1b");
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(ui.hasOverlay()).toBe(false);
		expectVisible();
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

		expect(stripAnsi(locationLabel())).toBe("← manage");
		expect(stripAnsi(contextLabel())).toBe("Pursuing goal (1m 05s) · test-model:high · 75k (75%)");
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

		expect(getLabel(root)).toBe("");
		expect(getLabel(subagent)).toBe("depth 1");
	});

	it("keeps remapped conversation detail shortcuts out of the footer while typing", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": ["ctrl+e", "ctrl+g"] }));
		const mode = createMode(2, false, () => "draft prompt");
		const label = stripAnsi(Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode));

		expect(label).toBe("");
		expect(label).not.toContain("detail");
		expect(label).not.toContain("Ctrl+E");
		expect(label).not.toContain("Ctrl+O");
		expect(label).not.toContain("Ctrl+G");
	});

	it("omits the detail hint when the binding is disabled", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		const label = stripAnsi(Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(createMode(1)));

		expect(label).toBe("");
		expect(label).not.toContain("detail");
	});

	it("keeps the footer free of detail shortcuts while an overlay owns the input", () => {
		const mode = createMode(1);
		mode.ui.hasOverlay = () => true;
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(label).toBeUndefined();
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
