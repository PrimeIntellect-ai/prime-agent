import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ClearCommandContext = {
	stopWorkingLoader: () => void;
	agentConnection: {
		newSession: () => Promise<{ cancelled: boolean }>;
		setSessionName?: (name: string) => Promise<void>;
		prompt?: (prompt: string, options?: { images?: unknown[] }) => Promise<void>;
	};
	editor?: { setText: (text: string) => void; addToHistory?: (text: string) => void };
	collectImagesFor?: (text: string) => unknown[] | undefined;
	getPromptStashImages?: (text: string) => readonly (readonly [number, unknown])[];
	pastedImages?: Map<number, unknown>;
	showError?: (message: string) => void;
	renderCurrentSessionState: () => Promise<void>;
	chatContainer: Container;
	ui: { requestRender: () => void };
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
};

type InteractiveModePrototype = {
	handleClearCommand(this: ClearCommandContext, options?: { name?: string; prompt?: string }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function renderAll(container: Container, width = 120): string {
	return container.children
		.flatMap((child) => child.render(width))
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("InteractiveMode /clear", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("creates the replacement session through AgentConnection", async () => {
		const newSession = vi.fn(async () => ({ cancelled: false }));
		const renderCurrentSessionState = vi.fn(async () => {});
		const requestRender = vi.fn();
		const prompt = vi.fn(async () => {});
		const image = {};
		const pastedImages = new Map([[7, image]]);
		const setSessionName = vi.fn(async () => pastedImages.clear());
		const collectImagesFor = vi.fn(() => [...pastedImages.values()]);
		const addToHistory = vi.fn();
		const context: ClearCommandContext = {
			stopWorkingLoader: vi.fn(),
			agentConnection: { newSession, setSessionName, prompt },
			editor: { setText: vi.fn(), addToHistory },
			collectImagesFor,
			getPromptStashImages: vi.fn(() => [[7, image] as const]),
			pastedImages,
			renderCurrentSessionState,
			chatContainer: new Container(),
			ui: { requestRender },
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
		};

		await interactiveModePrototype.handleClearCommand.call(context, {
			name: "stable",
			prompt: "-- exact\n  text [image #7]  ",
		});

		expect(context.stopWorkingLoader).toHaveBeenCalledWith();
		expect(newSession).toHaveBeenCalledWith();
		expect(renderCurrentSessionState).toHaveBeenCalledWith();
		expect(setSessionName).toHaveBeenCalledWith("stable");
		expect(addToHistory).toHaveBeenCalledWith("-- exact\n  text [image #7]  ");
		expect(prompt).toHaveBeenCalledWith("-- exact\n  text [image #7]  ", { images: [image] });
		expect(setSessionName.mock.invocationCallOrder[0]).toBeLessThan(prompt.mock.invocationCallOrder[0]);
		expect(requestRender).toHaveBeenCalledWith();
		expect(renderAll(context.chatContainer)).toContain("New session started");
	});

	it("does not rerender when the connection reports cancellation", async () => {
		const newSession = vi.fn(async () => ({ cancelled: true }));
		const setText = vi.fn();
		const context: ClearCommandContext = {
			stopWorkingLoader: vi.fn(),
			agentConnection: { newSession },
			editor: { setText },
			getPromptStashImages: vi.fn(() => []),
			pastedImages: new Map(),
			renderCurrentSessionState: vi.fn(async () => {}),
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
		};

		await interactiveModePrototype.handleClearCommand.call(context, { prompt: "keep me" });

		expect(newSession).toHaveBeenCalledWith();
		expect(setText).toHaveBeenCalledWith("keep me");
		expect(context.renderCurrentSessionState).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
		expect(context.chatContainer.children).toHaveLength(0);
	});
});
