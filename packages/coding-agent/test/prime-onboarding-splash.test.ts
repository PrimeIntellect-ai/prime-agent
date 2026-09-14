import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { PrimeOnboardingSplashComponent } from "../src/modes/interactive/components/prime-onboarding-splash.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { PRIME_COMPACT_BUTTERFLY_LOGO } from "../src/themes/prime-logo.js";

const logoLines = PRIME_COMPACT_BUTTERFLY_LOGO.split("\n");
const firstLogoLine = logoLines[0]?.trim() ?? "";

describe("PrimeOnboardingSplashComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the brand mark with the welcome line beneath it", () => {
		const component = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 36 },
		);
		const lines = component.render(100);
		const rendered = lines.map((line) => stripAnsi(line));
		const output = rendered.join("\n");

		expect(output).toContain(firstLogoLine);
		expect(output).toContain("Welcome to PRIME Agent");
		expect(output).toContain("Log in with Prime Intellect");
		expect(output).toContain("Continue later");

		const lastLogoRow = rendered.findIndex((line) => line.includes(logoLines[logoLines.length - 1]?.trim() ?? ""));
		const brandRow = rendered.findIndex((line) => line.includes("Welcome to PRIME Agent"));
		const actionRow = rendered.findIndex((line) => line.includes("Log in with Prime Intellect"));
		expect(brandRow).toBeGreaterThan(lastLogoRow);
		expect(actionRow).toBeGreaterThan(brandRow);
	});

	it("sizes to its content, and covers the pane when a row count is given", () => {
		const compact = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{},
		);
		expect(compact.render(100).length).toBeLessThanOrEqual(logoLines.length + 6);

		const covering = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 40 },
		);
		const lines = covering.render(100);
		expect(lines).toHaveLength(40);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
	});

	it("left aligns the mark, the welcome line and the actions", () => {
		const component = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 40 },
		);
		const rendered = component.render(100).map((line) => stripAnsi(line));
		const output = rendered.join("\n");

		expect(output).not.toContain("Enter");
		expect(output).not.toContain("Esc");

		const brandLine = rendered.find((line) => line.includes("Welcome to PRIME Agent"));
		const actionLine = rendered.find((line) => line.includes("Log in with Prime Intellect"));
		const laterLine = rendered.find((line) => line.includes("Continue later"));
		// One shared left edge for the welcome line and both action labels.
		expect(brandLine?.indexOf("Welcome")).toBe(actionLine?.indexOf(">"));
		expect(laterLine?.indexOf("Continue")).toBe(actionLine?.indexOf("Log") ?? 0);
		// Everything hugs the left edge; only the animated field spans the pane.
		expect(brandLine?.search(/\S/)).toBeLessThanOrEqual(2);
		// The mark is indented a little further right than the text column, but is
		// still left aligned rather than centred (the field spans the pane, so the
		// mark's own glyphs pin its position rather than leading whitespace).
		const wingGlyphs = "\u259f\u2588\u2588\u2599";
		const markLine = rendered.find((line) => line.includes(wingGlyphs));
		expect(markLine).toBeDefined();
		const markColumn = markLine?.indexOf(wingGlyphs) ?? -1;
		expect(markColumn).toBeGreaterThan(brandLine?.search(/\S/) ?? 0);
		expect(markColumn).toBeLessThanOrEqual(16);
	});

	it("marks the active action with a caret and a selection background", () => {
		const component = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 36 },
		);
		const lines = component.render(100);
		const selected = lines.find((line) => stripAnsi(line).includes("Log in with Prime Intellect"));
		const unselected = lines.find((line) => stripAnsi(line).includes("Continue later"));

		expect(stripAnsi(selected ?? "")).toContain("> Log in with Prime Intellect");
		expect(stripAnsi(unselected ?? "")).not.toContain(">");
		expect(selected ?? "").toMatch(/\x1b\[(4[0-9]|10[0-7]|48[;:])/);
		expect(unselected ?? "").not.toMatch(/\x1b\[(4[0-9]|10[0-7]|48[;:])/);
	});

	it("moves the selection background with the arrow keys", () => {
		const component = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 36 },
		);

		component.handleInput("\x1b[B");
		const lines = component.render(100);
		const later = lines.find((line) => stripAnsi(line).includes("Continue later"));

		expect(stripAnsi(later ?? "")).toContain("> Continue later");
		expect(later ?? "").toMatch(/\x1b\[(4[0-9]|10[0-7]|48[;:])/);
	});

	it("starts Prime login on confirm", () => {
		let selected = false;
		const component = new PrimeOnboardingSplashComponent(
			() => {
				selected = true;
			},
			() => {},
		);

		component.handleInput("\r");

		expect(selected).toBe(true);
	});

	it("continues later when the second action is confirmed", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const component = new PrimeOnboardingSplashComponent(onSelect, onCancel);

		component.handleInput("\x1b[B");
		component.handleInput("\r");

		expect(onSelect).not.toHaveBeenCalled();
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("continues later on cancel", () => {
		const onCancel = vi.fn();
		const component = new PrimeOnboardingSplashComponent(() => {}, onCancel);

		component.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("renders a model selection action when auth is already available", () => {
		const component = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 36, continueActionLabel: "choose a model" },
		);
		const output = stripAnsi(component.render(100).join("\n"));

		expect(output).toContain("Choose a model");
		expect(output).not.toContain("Log in with Prime Intellect");
		expect(output).toContain("Continue later");
	});

	it("shows progress and ignores input while onboarding advances", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const component = new PrimeOnboardingSplashComponent(onSelect, onCancel, { getRows: () => 36 });

		component.showProgress("Preparing models...");
		component.handleInput("\r");
		component.handleInput("\x1b");

		const output = stripAnsi(component.render(100).join("\n"));
		expect(output).toContain("Preparing models...");
		expect(output).not.toContain("Continue later");
		expect(onSelect).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("animates the mark at an interactive cadence", () => {
		vi.useFakeTimers();
		let renderRequests = 0;
		const component = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{
				getRows: () => 36,
				requestRender: () => {
					renderRequests++;
				},
				animationIntervalMs: 20,
			},
		);

		const firstRender = stripAnsi(component.render(100).join("\n"));
		vi.advanceTimersByTime(60);
		const secondRender = stripAnsi(component.render(100).join("\n"));
		component.dispose();

		expect(renderRequests).toBe(3);
		expect(secondRender).not.toBe(firstRender);
		expect(secondRender).toContain("Welcome to PRIME Agent");
	});
});
