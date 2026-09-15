import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { OnboardingPickerComponent } from "../src/modes/interactive/components/onboarding-picker.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const items = [
	{ id: "anthropic", label: "Anthropic (Claude Pro/Max)" },
	{ id: "openai", label: "ChatGPT Plus/Pro", connected: true },
	{ id: "copilot", label: "GitHub Copilot" },
	{ id: "xai", label: "xAI (Grok)" },
	{ id: "bedrock", label: "Amazon Bedrock" },
	{ id: "azure", label: "Azure OpenAI" },
	{ id: "groq", label: "Groq" },
	{ id: "mistral", label: "Mistral" },
];

const render = (component: OnboardingPickerComponent) => stripAnsi(component.render(90).join("\n"));

describe("OnboardingPickerComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("pins continue, shows a search field and a bounded viewport", () => {
		const component = new OnboardingPickerComponent(
			items,
			() => {},
			() => {},
			() => {},
			{
				prompt: "Connect other providers, or continue.",
				searchPlaceholder: "Search providers",
			},
		);
		const lines = component.render(90);
		const output = stripAnsi(lines.join("\n"));

		expect(output).toContain("Connect other providers, or continue.");
		expect(output).toContain("Search providers");
		expect(output).toContain("> Continue");
		expect(output).toContain("Anthropic (Claude Pro/Max)");
		// Six entries at a time, with the remainder called out.
		expect(output).not.toContain("Mistral");
		expect(output).toContain("2 more below");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(90);
		}
	});

	it("filters as the user types", () => {
		const component = new OnboardingPickerComponent(
			items,
			() => {},
			() => {},
			() => {},
		);
		for (const char of "groq") {
			component.handleInput(char);
		}
		const output = render(component);

		expect(output).toContain("Groq");
		expect(output).not.toContain("Anthropic (Claude Pro/Max)");
	});

	it("continues from the pinned action and cancels on escape", () => {
		const onContinue = vi.fn();
		const onCancel = vi.fn();
		const component = new OnboardingPickerComponent(items, () => {}, onContinue, onCancel);

		component.handleInput("\r");
		expect(onContinue).toHaveBeenCalledTimes(1);

		component.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
