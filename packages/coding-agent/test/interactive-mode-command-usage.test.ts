import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { getText: () => string; setText: (text: string) => void };
	[key: string]: unknown;
};

type Prototype = {
	setupEditorSubmitHandler(this: SubmitContext): void;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;

function makeSubmitContext() {
	const prompt = vi.fn(async () => undefined);
	let editorText = "";
	const context: SubmitContext = {
		defaultEditor: {},
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
			},
		},
		agentConnection: { prompt },
		showError: vi.fn(),
		showStatus: vi.fn(),
		echoLocalCommand: vi.fn(),
		handleSessionCommand: vi.fn(async () => undefined),
		showTreeSelector: vi.fn(async () => undefined),
		showSettingsSelector: vi.fn(async () => undefined),
		showHeartbeatManager: vi.fn(async () => undefined),
		submittedInputBehavior: "steer",
		inputSubmissionGeneration: 0,
		inputSubmissionsPending: 0,
		pendingPromptStashReleases: [],
		promptStashState: {},
		pendingSubmittedPromptStash: undefined,
		snapshotPromptStash: vi.fn(() => ({ text: "" })),
		promptStash: undefined,
		promptStashSessionId: "session-1",
		sessionId: "session-1",
		clearShortcutGuide: vi.fn(),
	};
	return context;
}

describe("InteractiveMode no-argument command usage errors", () => {
	beforeAll(() => initTheme("dark"));

	it("rejects arguments to /tree with a usage error instead of prompting", async () => {
		const context = makeSubmitContext();
		const prompt = (context.agentConnection as { prompt: ReturnType<typeof vi.fn> }).prompt;
		prototype.setupEditorSubmitHandler.call(context);
		// The real editor holds the submitted text; the usage error must preserve it.
		context.editor.setText("/tree fix the bug");
		await context.defaultEditor.onSubmit?.("/tree fix the bug");
		expect(context.showError).toHaveBeenCalledWith("Usage: /tree");
		expect(prompt).not.toHaveBeenCalled();
		expect(context.showTreeSelector).not.toHaveBeenCalled();
		// The submit chain preserves the editor text when a usage error shows.
		expect(context.editor.getText()).toBe("/tree fix the bug");
	});

	it("still opens the tree selector without arguments", async () => {
		const context = makeSubmitContext();
		prototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("/tree");
		expect(context.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it.each(["settings", "session", "heartbeats"])("rejects arguments to /%s", async (command) => {
		const context = makeSubmitContext();
		const prompt = (context.agentConnection as { prompt: ReturnType<typeof vi.fn> }).prompt;
		prototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.(`/${command} stray argument`);
		expect(context.showError).toHaveBeenCalledWith(`Usage: /${command}`);
		expect(prompt).not.toHaveBeenCalled();
	});
});
