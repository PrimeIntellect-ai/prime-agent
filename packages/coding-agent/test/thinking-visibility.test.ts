import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("thinking visibility", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("hides thinking without hiding assistant text or changing the source message", () => {
		const message = fauxAssistantMessage([fauxThinking("Trace one."), fauxText("Answer.")]);
		const original = JSON.stringify(message);
		const component = new AssistantMessageComponent(message, true);
		const render = () => stripAnsi(component.render(100).join("\n"));
		expect(render()).toContain("Answer.");
		expect(render()).not.toContain("Trace one.");
		component.setHideThinkingBlock(false);
		expect(render()).toContain("Thinking: (Ctrl+O cycle detail)");
		expect(render()).toContain("Trace one.");
		component.setHideThinkingBlock(true);
		expect(render()).not.toContain("Trace one.");
		expect(render()).toContain("Answer.");
		expect(JSON.stringify(message)).toBe(original);
	});

	test("keeps the selected thinking visibility for subsequent streaming updates", () => {
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(fauxAssistantMessage(fauxThinking("Partial")), true);
		expect(component.render(100)).toEqual([]);
		component.setHideThinkingBlock(false);
		component.updateContent(fauxAssistantMessage(fauxThinking("Partial reasoning completed.")), true);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("Partial reasoning completed.");
		component.setHideThinkingBlock(true);
		component.updateContent(fauxAssistantMessage(fauxThinking("Next reasoning update.")), true);
		expect(component.render(100)).toEqual([]);
	});
});
