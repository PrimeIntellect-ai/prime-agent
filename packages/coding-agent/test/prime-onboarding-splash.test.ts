import { setKeybindings } from "@earendil-works/pi-tui";
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

	it("exits the app on ctrl+c and ctrl+d instead of trapping the user", () => {
		for (const key of ["\x03", "\x04"]) {
			const onExit = vi.fn();
			const splash = new PrimeOnboardingSplashComponent(() => {}, { onExit });

			splash.handleInput(key);

			expect(onExit).toHaveBeenCalledOnce();
		}
	});

	it("renders the brand mark with the welcome line beneath it", () => {
		const component = new PrimeOnboardingSplashComponent(() => {}, { getRows: () => 36 });
		const lines = component.render(100);
		const rendered = lines.map((line) => stripAnsi(line));
		const output = rendered.join("\n");

		expect(output).toContain(firstLogoLine);
		expect(output).toContain("Welcome to PRIME Agent");
		expect(output).toContain("> Log in with Prime Intellect");
		// Signing in is the only route forward.
		expect(output).not.toContain("Continue later");
		// The description is present and wrapped inside the block rather than
		// running past its width; the wording itself is not the behaviour.
		const descriptionRows = rendered.filter((line) => line.trim().length > 0);
		expect(descriptionRows.length).toBeGreaterThan(logoLines.length);
		for (const line of rendered) {
			expect(stripAnsi(line).trimEnd().length).toBeLessThanOrEqual(100);
		}

		const lastLogoRow = rendered.findIndex((line) => line.includes(logoLines[logoLines.length - 1]?.trim() ?? ""));
		const brandRow = rendered.findIndex((line) => line.includes("Welcome to PRIME Agent"));
		const actionRow = rendered.findIndex((line) => line.includes("Log in with Prime Intellect"));
		expect(brandRow).toBeGreaterThan(lastLogoRow);
		expect(actionRow).toBeGreaterThan(brandRow);
	});

	it("left aligns the mark, the welcome line and the actions", () => {
		const component = new PrimeOnboardingSplashComponent(() => {}, { getRows: () => 40 });
		const rendered = component.render(100).map((line) => stripAnsi(line));
		const output = rendered.join("\n");

		expect(output).not.toContain("Enter");
		expect(output).not.toContain("Esc");

		const brandLine = rendered.find((line) => line.includes("Welcome to PRIME Agent"));
		const actionLine = rendered.find((line) => line.includes("Log in with Prime Intellect"));
		// One shared left edge for the welcome line and the action.
		expect(brandLine?.indexOf("Welcome")).toBe(actionLine?.indexOf(">"));
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

	it("starts Prime login on confirm", () => {
		let selected = false;
		const component = new PrimeOnboardingSplashComponent(() => {
			selected = true;
		});

		component.handleInput("\r");

		expect(selected).toBe(true);
	});

	it("never falls back to the intro once a flow has started", () => {
		const component = new PrimeOnboardingSplashComponent(() => {}, { getRows: () => 36 });
		component.setPanel({ render: () => ["panel row"], invalidate: () => {} }, "Login with Prime Intellect");
		// Between two flow panels the block must not flash the first screen back.
		component.setPanel(undefined);
		const output = stripAnsi(component.render(100).join("\n"));

		expect(output).toContain("Welcome to PRIME Agent");
		expect(output).not.toContain("Log in with Prime Intellect");
		expect(output).not.toContain("monitor dozens of experiments");
	});

	it("animates the mark at an interactive cadence", () => {
		vi.useFakeTimers();
		let renderRequests = 0;
		const component = new PrimeOnboardingSplashComponent(() => {}, {
			getRows: () => 36,
			requestRender: () => {
				renderRequests++;
			},
			animationIntervalMs: 20,
		});

		const firstRender = stripAnsi(component.render(100).join("\n"));
		vi.advanceTimersByTime(60);
		const secondRender = stripAnsi(component.render(100).join("\n"));
		component.dispose();

		expect(renderRequests).toBe(3);
		expect(secondRender).not.toBe(firstRender);
		expect(secondRender).toContain("Welcome to PRIME Agent");
	});
});
