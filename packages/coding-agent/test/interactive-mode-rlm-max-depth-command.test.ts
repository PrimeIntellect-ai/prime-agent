import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type Context = {
	agentConnection: {
		getRlmMaxDepthStatus: () => Promise<{ maxDepth: number; source: "chat" }>;
		setRlmMaxDepth: (
			maxDepth: number,
			options?: { global?: boolean },
		) => Promise<{ maxDepth: number; source: "chat"; globalSaved: boolean; globalError?: string }>;
	};
	chatContainer: Container;
	ui: { requestRender: () => void };
	showWarning: (message: string) => void;
	showError: (message: string) => void;
};

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { getText: () => string; setText: (text: string) => void };
	handleRlmMaxDepthCommand: (args: string) => Promise<void>;
	[key: string]: unknown;
};

type Prototype = {
	handleRlmMaxDepthCommand(this: Context, args: string): Promise<void>;
	setupEditorSubmitHandler(this: SubmitContext): void;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;

function renderAll(container: Container, width = 120): string {
	return container.children
		.flatMap((child) => child.render(width))
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

function makeContext(overrides: Partial<Context["agentConnection"]> = {}): Context {
	return {
		agentConnection: {
			getRlmMaxDepthStatus: vi.fn(async () => ({ maxDepth: 2, source: "chat" as const })),
			setRlmMaxDepth: vi.fn(async (maxDepth, options) => ({
				maxDepth,
				source: "chat" as const,
				globalSaved: options?.global === true,
			})),
			...overrides,
		},
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		showWarning: vi.fn(),
		showError: vi.fn(),
	};
}

describe("InteractiveMode /rlm-max-depth", () => {
	beforeAll(() => initTheme("dark"));

	it("does not erase input typed while the command RPC is pending", async () => {
		let editorText = "";
		let resolveCommand = () => {};
		const commandPending = new Promise<void>((resolve) => {
			resolveCommand = resolve;
		});
		const submitContext = {
			defaultEditor: {},
			editor: {
				getText: () => editorText,
				setText: (text: string) => {
					editorText = text;
				},
			},
			handleRlmMaxDepthCommand: vi.fn(() => commandPending),
			submittedInputBehavior: "steer",
			inputSubmissionGeneration: 0,
			inputSubmissionsPending: 0,
			pendingPromptStashReleases: [],
			promptStashState: {},
			clearShortcutGuide: vi.fn(),
		} as unknown as SubmitContext;
		prototype.setupEditorSubmitHandler.call(submitContext);

		const submission = submitContext.defaultEditor.onSubmit?.("/rlm-max-depth 3");
		await vi.waitFor(() => expect(submitContext.handleRlmMaxDepthCommand).toHaveBeenCalledWith("3"));
		editorText = "new draft";
		resolveCommand();
		await submission;

		expect(editorText).toBe("new draft");
	});

	it("shows current state as a dim one-liner through the immediate connection API", async () => {
		const context = makeContext();
		await prototype.handleRlmMaxDepthCommand.call(context, "");
		expect(context.agentConnection.getRlmMaxDepthStatus).toHaveBeenCalledOnce();
		expect(context.agentConnection.setRlmMaxDepth).not.toHaveBeenCalled();
		expect(renderAll(context.chatContainer)).toContain("RLM max depth: 2 (chat)");
	});

	it("sets the value globally and shows a dim one-liner", async () => {
		const context = makeContext();
		await prototype.handleRlmMaxDepthCommand.call(context, "3 --global");
		expect(context.agentConnection.setRlmMaxDepth).toHaveBeenCalledWith(3, { global: true });
		expect(renderAll(context.chatContainer)).toContain("RLM max depth set: 3 and saved as global default");
	});

	it("surfaces a global-save error without losing the successful chat update", async () => {
		const context = makeContext({
			setRlmMaxDepth: vi.fn(async () => ({
				maxDepth: 4,
				source: "chat" as const,
				globalSaved: false,
				globalError: "disk full",
			})),
		});
		await prototype.handleRlmMaxDepthCommand.call(context, "4 --global");
		expect(renderAll(context.chatContainer)).toContain("RLM max depth set: 4");
		expect(context.showError).toHaveBeenCalledWith(
			"RLM max depth set for this chat, but the global default was not saved: disk full",
		);
	});
});
