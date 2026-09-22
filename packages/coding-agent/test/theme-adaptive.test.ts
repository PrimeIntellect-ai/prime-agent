import { clearDefaultTerminalColors, setDefaultTerminalColors } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEditorTheme, initTheme, setThemeInstance, Theme, theme } from "../src/modes/interactive/theme/theme.js";

type Rgb = { r: number; g: number; b: number };

function ansi256IndexToRgb(index: number): Rgb {
	if (index >= 232) {
		const v = 8 + (index - 232) * 10;
		return { r: v, g: v, b: v };
	}
	const cube = [0, 95, 135, 175, 215, 255];
	const n = index - 16;
	return { r: cube[Math.floor(n / 36)]!, g: cube[Math.floor((n % 36) / 6)]!, b: cube[n % 6]! };
}

const luminance = (c: Rgb): number => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

function renderedLuminance(rendered: string): number {
	const truecolor = /48;2;(\d+);(\d+);(\d+)m/.exec(rendered);
	if (truecolor) return luminance({ r: +truecolor[1]!, g: +truecolor[2]!, b: +truecolor[3]! });
	const indexed = /48;5;(\d+)m/.exec(rendered);
	if (indexed) return luminance(ansi256IndexToRgb(Number(indexed[1])));
	throw new Error(`Expected a background color escape, got: ${JSON.stringify(rendered)}`);
}

function setThemeColors(colors: Record<string, string | number>, depth: "truecolor" | "256color"): void {
	setThemeInstance(
		new Theme({} as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], depth),
	);
}

const setBackground = (background: Rgb, foreground: Rgb = { r: 255, g: 255, b: 255 }) =>
	setDefaultTerminalColors({ foreground, background });

/** Minimum luminance contrast the adaptive theme keeps between selection and terminal background. */
const MIN_CONTRAST = 27.5;
const TRUECOLOR_BG = /\x1b\[48;2;\d+;\d+;\d+mx\x1b\[49m/;

describe("adaptive TUI theme colors", () => {
	let previousColorTerm: string | undefined;
	let previousColorFgBg: string | undefined;

	beforeEach(() => {
		previousColorTerm = process.env.COLORTERM;
		previousColorFgBg = process.env.COLORFGBG;
		process.env.COLORTERM = "truecolor";
		delete process.env.COLORFGBG;
		clearDefaultTerminalColors();
		initTheme("prime");
	});

	afterEach(() => {
		clearDefaultTerminalColors();
		if (previousColorTerm === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = previousColorTerm;
		if (previousColorFgBg === undefined) delete process.env.COLORFGBG;
		else process.env.COLORFGBG = previousColorFgBg;
		initTheme("prime");
	});

	it.each([
		["unknown terminal background", undefined, false],
		["a dark terminal background", { r: 0, g: 0, b: 0 }, false],
		["a light terminal background", { r: 255, g: 255, b: 255 }, false],
		["a terminal background matching the editor surface", { r: 26, g: 26, b: 31 }, true],
	] as const)("resolves editor chrome against %s", (_name, background, nudged) => {
		if (background) setBackground(background);

		const editorTheme = getEditorTheme();
		const rendered = editorTheme.backgroundColor?.("x");

		if (nudged) {
			expect(rendered).not.toBe(theme.bg("userMessageBg", "x"));
			expect(rendered).toMatch(TRUECOLOR_BG);
		} else {
			expect(rendered).toBe(theme.bg("userMessageBg", "x"));
		}
		// Border chrome never adapts to the terminal background.
		expect(editorTheme.borderColor("x")).toBe(theme.fg("borderMuted", "x"));
	});

	// [name, theme, selectedBg override, terminal background, adapts, luminance bound]
	it.each([
		["unknown terminal background", "prime", undefined, undefined, false, undefined],
		["a clearly darker terminal background", "prime", undefined, { r: 0, g: 0, b: 0 }, false, undefined],
		["a nearly matching terminal background", "prime", undefined, { r: 29, g: 32, b: 33 }, true, undefined],
		// Selection luminance 34.5 vs terminal 60: blending darker reaches the minimum
		// without crossing the background.
		["a lighter dark terminal background", "prime", undefined, { r: 60, g: 60, b: 60 }, true, { max: 34.5 }],
		// #222226 (~34.5) is only slightly darker, so the capped same-side blend cannot
		// reach the threshold and must cross upward instead.
		["a capped same-side blend", "prime", undefined, { r: 35, g: 35, b: 35 }, true, undefined],
		// Light selectedBg #d0d0e0 has luminance ~209.7 against 200.
		["a darker light terminal background", "light", undefined, { r: 200, g: 200, b: 200 }, true, { min: 209.7 }],
		["a nearly matching light terminal background", "light", undefined, { r: 210, g: 210, b: 220 }, true, undefined],
		// Blending toward black cannot change a black selection, so it must cross upward.
		["a selection at the blend endpoint", "prime", "#000000", { r: 1, g: 1, b: 1 }, true, undefined],
	] as const)(
		"keeps truecolor selection contrast against %s",
		(_name, themeName, selectedBg, background, adapts, bound) => {
			initTheme(themeName);
			if (selectedBg !== undefined) setThemeColors({ selectedBg }, "truecolor");
			if (background) setBackground(background);

			const rendered = theme.getSelectionBackgroundColor()("x");

			if (!adapts) {
				expect(rendered).toBe(theme.bg("selectedBg", "x"));
				return;
			}
			expect(rendered).not.toBe(theme.bg("selectedBg", "x"));
			expect(rendered).toMatch(TRUECOLOR_BG);
			const selection = renderedLuminance(rendered);
			expect(Math.abs(selection - luminance(background!))).toBeGreaterThanOrEqual(MIN_CONTRAST);
			if (bound && "min" in bound) expect(selection).toBeGreaterThan(bound.min);
			if (bound && "max" in bound) expect(selection).toBeLessThan(bound.max);
		},
	);

	// [name, selectedBg, terminal background, adapts]
	it.each([
		// The pre-quantized blend is fine, but naive quantization lands on #af5f5f,
		// matching the terminal background exactly.
		["quantization erasing a valid blend", "#e93e4d", { r: 44, g: 166, b: 73 }, true],
		// Both exact-target blends quantize far below the threshold; a stronger blend
		// toward white quantizes to #87afaf and clears it.
		["quantization undershooting both exact blends", "#2f4d50", { r: 117, g: 29, b: 206 }, true],
		// Raw delta 33 passes, but the selection quantizes to #d7005f, nearly matching.
		["quantization collapsing the configured contrast", "#e82d6a", { r: 214, g: 0, b: 93 }, true],
		["a selectedBg deferring to the terminal default", "", { r: 29, g: 32, b: 33 }, true],
		["a terminal-defined basic ANSI selection color", 0, { r: 29, g: 32, b: 33 }, false],
	] as const)("keeps 256-color selection contrast with %s", (_name, selectedBg, background, adapts) => {
		setThemeColors({ selectedBg }, "256color");
		setBackground(background);

		const rendered = theme.getSelectionBackgroundColor()("x");

		if (!adapts) {
			expect(rendered).toBe(theme.bg("selectedBg", "x"));
			return;
		}
		expect(rendered).not.toBe(theme.bg("selectedBg", "x"));
		expect(Math.abs(renderedLuminance(rendered) - luminance(background))).toBeGreaterThanOrEqual(MIN_CONTRAST);
	});

	it("keeps the plain selection background for soft highlights when the terminal background is unknown", () => {
		expect(theme.getSoftSelectionBackgroundColor()("x")).toBe(theme.bg("selectedBg", "x"));
	});

	it("blends the soft selection halfway toward the editor surface", () => {
		setBackground({ r: 29, g: 32, b: 33 }, { r: 235, g: 219, b: 178 });

		const soft = renderedLuminance(theme.getSoftSelectionBackgroundColor()("x"));
		const selection = renderedLuminance(theme.bg("selectedBg", "x"));
		const surface = renderedLuminance(theme.bg("userMessageBg", "x"));
		expect(soft).toBeLessThan(selection);
		expect(soft).toBeGreaterThan(surface);
		expect(Math.abs(soft - (selection + surface) / 2)).toBeLessThan(1.5);
	});

	it("strengthens the soft selection when quantization collapses it into the editor surface", () => {
		// #222226 and #1a1a1f quantize to the same 256-color cell for every blend alpha,
		// so the soft highlight falls back to the adaptive selection machinery.
		setThemeColors({ selectedBg: "#222226", userMessageBg: "#1a1a1f" }, "256color");
		setBackground({ r: 29, g: 32, b: 33 }, { r: 235, g: 219, b: 178 });

		const soft = theme.getSoftSelectionBackgroundColor()("x");
		expect(renderedLuminance(soft)).not.toBe(renderedLuminance(theme.bg("userMessageBg", "x")));
	});

	it("uses COLORFGBG for automatic default theme selection when OSC colors are unavailable", () => {
		process.env.COLORFGBG = "0;15";
		clearDefaultTerminalColors();
		initTheme(undefined);
		expect(theme.name).toBe("light");

		process.env.COLORFGBG = "15;0";
		clearDefaultTerminalColors();
		initTheme(undefined);
		expect(theme.name).toBe("prime");
	});
});
