import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Container, Input, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KEYBINDINGS, KeybindingsManager } from "../../../src/core/keybindings.js";
import type { ConfigurationMenuComponent } from "../../../src/modes/interactive/components/configuration-menu.js";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const harnesses: Harness[] = [];
beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function fixture() {
	const harness = await createHarness({
		models: [
			{ id: "plain", name: "Plain", reasoning: false },
			{ id: "reason", name: "Reason", reasoning: true },
		],
	});
	harnesses.push(harness);
	const model = harness.getModel("reason")!;
	const plain = harness.getModel("plain")!;
	const editor = new Input();
	editor.setValue("preserved draft");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const setThinkingLevel = vi.fn(async (_level: ModelThinkingLevel) => {});
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as object, {
		editor,
		editorContainer,
		ui: { terminal: { rows: 30 }, requestRender: vi.fn(), setFocus: vi.fn() },
		uiServices: {
			modelRegistry: harness.session.modelRegistry,
			settingsManager: {
				getRecentModels: () => [],
				getDefaultThinkingLevel: () => "medium",
			},
		},
		connectionConfiguredProviders: new Set([model.provider]),
		connectionState: { thinkingLevel: "off" },
		getCurrentModel: () => plain,
		getScopedModelState: () => [],
		getCachedModelCandidates: () => [model],
		getModelSelectorRefreshPromise: () => undefined,
		createAuthFlows: () => ({ getLoginProviderOptions: () => [] }),
		ensureModelProviderConfigured: async () => true,
		completeModelSelection: vi.fn(async () => {}),
		agentConnection: { setThinkingLevel },
		patchConnectionState: vi.fn(),
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	}) as unknown as {
		showConfigurationMenu(tab: "models"): Promise<void>;
		completeModelSelection: ReturnType<typeof vi.fn<() => Promise<void>>>;
		ui: { setFocus: ReturnType<typeof vi.fn> };
		showError: ReturnType<typeof vi.fn>;
	};
	return {
		harness,
		model,
		mode,
		editor,
		editorContainer,
		setThinkingLevel,
		menu: () => editorContainer.children[0] as ConfigurationMenuComponent,
	};
}

it("retains picker focus and draft until model and explicit effort both complete", async () => {
	const f = await fixture();
	const modelApplied = deferred();
	const effortApplied = deferred();
	f.mode.completeModelSelection.mockImplementation(() => modelApplied.promise);
	f.setThinkingLevel.mockImplementation(() => effortApplied.promise);
	const done = f.mode.showConfigurationMenu("models");
	const menu = f.menu();
	expect(stripAnsi(menu.render(100).join("\n"))).toContain("medium");
	menu.handleInput("\x1b[C");
	menu.handleInput("\r");
	await vi.waitFor(() => expect(f.mode.completeModelSelection).toHaveBeenCalledOnce());
	let finished = false;
	void done.then(() => {
		finished = true;
	});
	menu.handleInput("\x1b");
	menu.handleInput("\r");
	const competing = f.mode.showConfigurationMenu("models");
	expect(f.menu()).toBe(menu);
	expect(f.mode.ui.setFocus).toHaveBeenLastCalledWith(menu);
	expect(f.setThinkingLevel).not.toHaveBeenCalled();
	modelApplied.resolve();
	await vi.waitFor(() => expect(f.setThinkingLevel).toHaveBeenCalledWith("high"));
	expect(finished).toBe(false);
	expect(f.menu()).toBe(menu);
	effortApplied.resolve();
	await Promise.all([done, competing]);
	expect(f.mode.completeModelSelection).toHaveBeenCalledOnce();
	expect(f.editorContainer.children).toEqual([f.editor]);
	expect(f.editor.getValue()).toBe("preserved draft");
});

it("leaves untouched effort to the normal model-switch default restoration", async () => {
	const f = await fixture();
	f.harness.session.settingsManager.setDefaultThinkingLevel("high");
	f.mode.completeModelSelection.mockImplementation(async () => {
		await f.harness.session.setModel(f.model);
	});
	const done = f.mode.showConfigurationMenu("models");
	f.menu().handleInput("\r");
	await done;
	expect(f.setThinkingLevel).not.toHaveBeenCalled();
	expect(f.harness.session.thinkingLevel).toBe("high");
});

it("keeps a failed effort selection open and allows retry", async () => {
	const f = await fixture();
	f.setThinkingLevel.mockRejectedValueOnce(new Error("effort update failed"));
	const done = f.mode.showConfigurationMenu("models");
	const menu = f.menu();
	menu.handleInput("\x1b[C");
	menu.handleInput("\r");
	await vi.waitFor(() => expect(f.mode.showError).toHaveBeenCalledWith("effort update failed"));
	expect(f.menu()).toBe(menu);
	menu.handleInput("\r");
	await done;
	expect(f.setThinkingLevel).toHaveBeenCalledTimes(2);
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it.each([false, true])("edits search text with arrows for reasoning=%s", async (reasoning) => {
	const f = await fixture();
	const selected = vi.fn();
	const cancel = vi.fn();
	const model = reasoning ? f.model : f.harness.getModel("plain")!;
	const selector = new ModelSelectorComponent(
		{ requestRender: () => {} } as TUI,
		model,
		f.harness.session.modelRegistry,
		[],
		selected,
		cancel,
		undefined,
		{ availableModels: [model], thinkingLevel: "medium", inline: true },
	);
	selector.handleInput("re");
	selector.handleInput("\x1b[D");
	selector.handleInput("a");
	expect(selector.getSearchInput().getValue()).toBe("rae");
	selector.handleInput("\x1b[C");
	selector.handleInput("b");
	expect(selector.getSearchInput().getValue()).toBe("raeb");
	selector.handleInput("\x01");
	selector.handleInput("\x1b[D");
	expect(cancel).toHaveBeenCalledOnce();
	selector.getSearchInput().setValue("");
	selector.updateState(model, [model]);
	if (reasoning) {
		selector.handleInput("\x1b[C");
		selector.handleInput("\r");
		expect(selected).toHaveBeenLastCalledWith(model, "high");
	} else {
		selector.handleInput("\x1b[D");
		expect(cancel).toHaveBeenCalledTimes(2);
	}
});

it("does not publish the removed configuration tab action", () => {
	expect(Object.keys(KEYBINDINGS)).not.toContain("app.configuration.previousTab");
});
