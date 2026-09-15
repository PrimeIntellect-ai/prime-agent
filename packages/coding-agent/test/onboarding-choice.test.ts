import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { OnboardingChoiceComponent } from "../src/modes/interactive/components/onboarding-choice.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("OnboardingChoiceComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders the prompt, the options and a grey note in the onboarding language", () => {
		const component = new OnboardingChoiceComponent(
			[{ label: "Share agent traces" }, { label: "Not now" }],
			() => {},
			() => {},
			{
				prompt: "Help improve Prime Agent by sharing agent traces?",
				note: "You can change this anytime with /traces.",
			},
		);
		const lines = component.render(90);
		const output = stripAnsi(lines.join("\n"));

		expect(output).toContain("Help improve Prime Agent by sharing agent traces?");
		expect(output).toContain("> Share agent traces");
		expect(output).toContain("  Not now");
		expect(output).toContain("You can change this anytime with /traces.");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(90);
		}
	});

	it("marks the active option with a caret and a selection wash", () => {
		const component = new OnboardingChoiceComponent(
			[{ label: "Personal account" }, { label: "Prime Intellect" }],
			() => {},
			() => {},
		);
		const lines = component.render(90);
		const selected = lines.find((line) => stripAnsi(line).includes("Personal account"));
		const other = lines.find((line) => stripAnsi(line).includes("Prime Intellect"));

		expect(selected ?? "").toMatch(/\x1b\[(4[0-9]|10[0-7]|48[;:])/);
		expect(other ?? "").not.toMatch(/\x1b\[(4[0-9]|10[0-7]|48[;:])/);
	});

	it("reports the confirmed option and cancellation", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const component = new OnboardingChoiceComponent(
			[{ label: "One" }, { label: "Two" }, { label: "Three" }],
			onSelect,
			onCancel,
		);

		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(2);

		component.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("keeps the selection inside the option list", () => {
		const onSelect = vi.fn();
		const component = new OnboardingChoiceComponent([{ label: "Only" }], onSelect, () => {});

		component.handleInput("\x1b[A");
		component.handleInput("\x1b[B");
		component.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith(0);
	});

	it("renders a muted description under the prompt", () => {
		const component = new OnboardingChoiceComponent(
			[{ label: "Share" }, { label: "Not now" }],
			() => {},
			() => {},
			{
				prompt: "Share agent traces with Prime Intellect?",
				description: "Traces train open-source models and improve the open agent ecosystem everyone builds on.",
			},
		);
		const output = stripAnsi(component.render(90).join("\n"));

		expect(output).toContain("Share agent traces with Prime Intellect?");
		expect(output).toContain("Traces train open-source models");
	});

	it("shows an option detail next to its label", () => {
		const component = new OnboardingChoiceComponent(
			[{ label: "Prime Intellect", detail: "prime-intellect" }],
			() => {},
			() => {},
		);
		expect(stripAnsi(component.render(90).join("\n"))).toContain("Prime Intellect  @prime-intellect");
	});
});
