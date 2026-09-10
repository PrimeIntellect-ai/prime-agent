import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Ctrl+T transiently reveals the most recent thinking block and hides it again. */
describe("thinking visibility toggle", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	function createFakeThis(chatContainer: Container): any {
		const fakeThis = {
			chatContainer,
			ui: { requestRender: vi.fn() },
			hideThinkingBlock: true,
			revealedThinkingComponents: [],
			showStatus: vi.fn(),
		};
		Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
		return fakeThis;
	}

	test("reveals every thinking block in the conversation and hides them again", () => {
		const first = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "Trace one." }]),
			true,
		);
		const second = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "Trace two." }]),
			true,
		);
		const textOnly = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "Answer." }]));
		const chatContainer = new Container();
		chatContainer.addChild(textOnly);
		chatContainer.addChild(first);
		chatContainer.addChild(second);
		const fakeThis = createFakeThis(chatContainer);

		(InteractiveMode.prototype as any).toggleThinkingBlockVisibility.call(fakeThis);
		expect(fakeThis.revealedThinkingComponents).toEqual([first, second]);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Thinking: shown (2 blocks)");
		expect(stripAnsi(first.render(80).join("\n"))).toContain("Thinking: (Ctrl+T to hide)");
		expect(stripAnsi(first.render(80).join("\n"))).toContain("Trace one.");
		expect(stripAnsi(second.render(80).join("\n"))).toContain("Trace two.");

		(InteractiveMode.prototype as any).toggleThinkingBlockVisibility.call(fakeThis);
		expect(fakeThis.revealedThinkingComponents).toEqual([]);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Thinking: hidden");
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
		expect(first.render(80)).toEqual([]);
		expect(second.render(80)).toEqual([]);
	});

	test("reports when there is no thinking to show", () => {
		const chatContainer = new Container();
		chatContainer.addChild(new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "Hi." }])));
		const fakeThis = createFakeThis(chatContainer);

		(InteractiveMode.prototype as any).toggleThinkingBlockVisibility.call(fakeThis);
		expect(fakeThis.revealedThinkingComponent).toBeUndefined();
		expect(fakeThis.showStatus).toHaveBeenCalledWith("No thinking to show yet");
	});
});
