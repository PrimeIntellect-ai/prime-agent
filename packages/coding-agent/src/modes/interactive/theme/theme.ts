import * as fs from "node:fs";
import * as path from "node:path";
import {
	bestAnsiColor,
	blendColor,
	type EditorTheme,
	getDefaultTerminalColors,
	getTerminalBackgroundKind,
	isLightColor,
	type MarkdownTheme,
	onDefaultTerminalColorsChange,
	type Rgb,
	rgbTo256,
	type SelectListTheme,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Static, type TProperties, Type } from "typebox";
import type { Validator } from "typebox/compile";
import { getCustomThemesDir, getThemesDir } from "../../../config.js";
import type { SourceInfo } from "../../../core/source-info.js";
import { closeWatcher, watchWithErrorHandler } from "../../../utils/fs-watch.js";

// ============================================================================
// Types & Schema
// ============================================================================

const ColorValueSchema = Type.Union([
	Type.String(), // hex "#ff0000", var ref "primary", or empty ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

type ColorValue = Static<typeof ColorValueSchema>;

const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// Core UI (10 colors)
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		thinkingText: ColorValueSchema,
		// Backgrounds & Content Text (12 colors)
		selectedBg: ColorValueSchema,
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		customMessageBg: ColorValueSchema,
		customMessageText: ColorValueSchema,
		customMessageLabel: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolDiffAddedBg: ColorValueSchema,
		toolDiffRemovedBg: ColorValueSchema,
		toolPanelBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown (10 colors)
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// Tool Diffs (3 colors)
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffText: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// Syntax Highlighting (9 colors)
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// Thinking Level Borders (6 colors)
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		// Bash Mode (1 color)
		bashMode: ColorValueSchema,
	}),
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema),
			cardBg: Type.Optional(ColorValueSchema),
			infoBg: Type.Optional(ColorValueSchema),
		}),
	),
});

type ThemeJson = Static<typeof ThemeJsonSchema>;

// typebox/compile costs ~300ms to import, so the theme validator loads lazily.
// Built-in themes never validate; custom themes get a minimal structural check
// until the validator is ready (preloaded from initTheme), after which full
// schema validation applies (e.g. on watcher reloads and setTheme).
let validateThemeJson: Validator<TProperties, typeof ThemeJsonSchema> | undefined;
let themeValidatorPromise: Promise<void> | undefined;

export function preloadThemeValidator(): Promise<void> {
	themeValidatorPromise ??= import("typebox/compile").then(({ Compile }) => {
		validateThemeJson = Compile(ThemeJsonSchema);
	});
	return themeValidatorPromise;
}

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffText"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode";

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	| "toolDiffAddedBg"
	| "toolDiffRemovedBg"
	| "toolPanelBg";

type ColorMode = "truecolor" | "256color";

const ADAPTIVE_LIGHT_BG_ACCENT: Rgb = { r: 0, g: 95, b: 135 };
const SURFACE_MIN_LUMINANCE_DELTA = 12;
const SURFACE_CONTRAST_ALPHA = 0.08;
// Selection rows must stand out clearly, much more than passive surfaces.
const SELECTION_MIN_LUMINANCE_DELTA = 28;
const SELECTION_MAX_BLEND_ALPHA = 0.5;
const SELECTION_BLEND_STEP = 0.05;
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;

// ============================================================================
// Color Utilities
// ============================================================================

function detectColorMode(): ColorMode {
	const colorterm = process.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "truecolor";
	}
	// Windows Terminal supports truecolor
	if (process.env.WT_SESSION) {
		return "truecolor";
	}
	const term = process.env.TERM || "";
	// Fall back to 256color for truly limited terminals
	if (term === "dumb" || term === "" || term === "linux") {
		return "256color";
	}
	// Terminal.app also doesn't support truecolor
	if (process.env.TERM_PROGRAM === "Apple_Terminal") {
		return "256color";
	}
	// tmux reports TERM=screen* but forwards 24-bit color, so treat it as
	// truecolor-capable; only genuine GNU screen (no $TMUX) falls back.
	const inTmux = process.env.TMUX !== undefined || term.startsWith("tmux");
	if (!inTmux && (term === "screen" || term.startsWith("screen-") || term.startsWith("screen."))) {
		return "256color";
	}
	// Assume truecolor for everything else - virtually all modern terminals support it
	return "truecolor";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

function ansi256ToRgb(index: number): Rgb | undefined {
	if (index < 0 || index > 255) {
		return undefined;
	}
	if (index < 16) {
		const basicColors: Rgb[] = [
			{ r: 0, g: 0, b: 0 },
			{ r: 128, g: 0, b: 0 },
			{ r: 0, g: 128, b: 0 },
			{ r: 128, g: 128, b: 0 },
			{ r: 0, g: 0, b: 128 },
			{ r: 128, g: 0, b: 128 },
			{ r: 0, g: 128, b: 128 },
			{ r: 192, g: 192, b: 192 },
			{ r: 128, g: 128, b: 128 },
			{ r: 255, g: 0, b: 0 },
			{ r: 0, g: 255, b: 0 },
			{ r: 255, g: 255, b: 0 },
			{ r: 0, g: 0, b: 255 },
			{ r: 255, g: 0, b: 255 },
			{ r: 0, g: 255, b: 255 },
			{ r: 255, g: 255, b: 255 },
		];
		return basicColors[index];
	}
	if (index >= 232) {
		const value = 8 + (index - 232) * 10;
		return { r: value, g: value, b: value };
	}
	const cubeIndex = index - 16;
	return {
		r: CUBE_VALUES[Math.floor(cubeIndex / 36)]!,
		g: CUBE_VALUES[Math.floor((cubeIndex % 36) / 6)]!,
		b: CUBE_VALUES[cubeIndex % 6]!,
	};
}

function colorValueToRgb(value: string | number | undefined): Rgb | undefined {
	if (typeof value === "number") {
		return ansi256ToRgb(value);
	}
	if (!value || !value.startsWith("#")) {
		return undefined;
	}
	try {
		return hexToRgb(value);
	} catch {
		// Malformed theme colors (e.g. 3-character hex shorthand) should not crash rendering.
		return undefined;
	}
}

function luminance(rgb: Rgb): number {
	return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

function hexTo256(hex: string): number {
	return rgbTo256(hexToRgb(hex));
}

function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[38;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[48;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

// ============================================================================
// Theme Class
// ============================================================================

export class Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private bgColorValues: Map<ThemeBg, string | number>;
	private mode: ColorMode;

	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		mode: ColorMode,
		options: { name?: string; sourcePath?: string; sourceInfo?: SourceInfo } = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.sourceInfo = options.sourceInfo;
		this.mode = mode;
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
		this.bgColorValues = new Map(Object.entries(bgColors) as [ThemeBg, string | number][]);
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	/** Active color depth (truecolor vs 256color). */
	get colorMode(): ColorMode {
		return this.mode;
	}

	getEditorBackgroundColor(): ((str: string) => string) | undefined {
		return this.surfaceBackgroundColor("userMessageBg");
	}

	getUserMessageBackgroundColor(): (str: string) => string {
		return this.surfaceBackgroundColor("userMessageBg");
	}

	getPopupBackgroundColor(): (str: string) => string {
		return this.surfaceBackgroundColor("toolPanelBg");
	}

	getSelectionBackgroundColor(): (str: string) => string {
		const terminalBg = getDefaultTerminalColors()?.background;
		const selectedBgValue = this.bgColorValues.get("selectedBg");
		// Basic ANSI colors (0-15) are terminal-defined; their rendered color is
		// unknown, so no reliable contrast computation (or blend base) exists.
		if (!terminalBg || (typeof selectedBgValue === "number" && selectedBgValue < 16)) {
			return (str: string) => this.bg("selectedBg", str);
		}
		// An empty selectedBg renders as the terminal background itself; blend
		// from there so the selection still gets an explicit contrasting color.
		const selectionRgb = colorValueToRgb(selectedBgValue) ?? terminalBg;

		// Compare against what actually renders: on 256-color terminals the
		// palette quantization can erase the contrast of the configured value,
		// and gives the blends a quantized baseline to beat.
		const terminalLuminance = luminance(terminalBg);
		const renderedSelection = colorValueToRgb(bestAnsiColor(selectionRgb, this.mode)) ?? selectionRgb;
		const selectionLuminance = luminance(renderedSelection);
		const delta = Math.abs(selectionLuminance - terminalLuminance);
		if (delta >= SELECTION_MIN_LUMINANCE_DELTA) {
			return (str: string) => this.bg("selectedBg", str);
		}

		// Blend away from the terminal background toward the endpoint on the
		// selection's side of it. When that direction cannot reach the minimum
		// delta (e.g. the selection already sits at the endpoint), fall back to
		// the opposite endpoint, which requires crossing the background.
		const endpoints = selectionLuminance >= terminalLuminance ? [WHITE, BLACK] : [BLACK, WHITE];
		let bestColor: string | number | undefined;
		let bestDelta = delta;
		for (const top of endpoints) {
			const spread = luminance(top) - selectionLuminance;
			if (spread === 0) {
				continue;
			}
			const targetLuminance = terminalLuminance + Math.sign(spread) * SELECTION_MIN_LUMINANCE_DELTA;
			const baseAlpha = Math.min(SELECTION_MAX_BLEND_ALPHA, (targetLuminance - selectionLuminance) / spread);
			// Quantize before evaluating: on 256-color terminals the palette
			// rounding can otherwise erase the delta the blend was chosen for.
			// If the direct hit undershoots, keep stepping toward the cap —
			// a stronger blend may quantize to a palette color that passes.
			const alphas: number[] = [];
			for (let alpha = baseAlpha; alpha < SELECTION_MAX_BLEND_ALPHA; alpha += SELECTION_BLEND_STEP) {
				alphas.push(alpha);
			}
			alphas.push(SELECTION_MAX_BLEND_ALPHA);
			for (const alpha of alphas) {
				const adjustedColor = bestAnsiColor(blendColor(top, selectionRgb, alpha), this.mode);
				const adjustedRgb = colorValueToRgb(adjustedColor);
				if (adjustedColor === "" || !adjustedRgb) {
					continue;
				}
				const resultDelta = Math.abs(luminance(adjustedRgb) - terminalLuminance);
				if (resultDelta >= SELECTION_MIN_LUMINANCE_DELTA - 1) {
					bestColor = adjustedColor;
					bestDelta = resultDelta;
					break;
				}
				if (resultDelta > bestDelta) {
					bestColor = adjustedColor;
					bestDelta = resultDelta;
				}
			}
			if (bestColor !== undefined && bestDelta >= SELECTION_MIN_LUMINANCE_DELTA - 1) {
				break;
			}
		}
		if (bestColor === undefined) {
			return (str: string) => this.bg("selectedBg", str);
		}
		const ansi = bgAnsi(bestColor, this.mode);
		return (str: string) => `${ansi}${str}\x1b[49m`;
	}

	private surfaceBackgroundColor(color: ThemeBg): (str: string) => string {
		const terminalBg = getDefaultTerminalColors()?.background;
		const surfaceRgb = colorValueToRgb(this.bgColorValues.get(color));
		if (!terminalBg || !surfaceRgb) {
			return (str: string) => this.bg(color, str);
		}

		const delta = Math.abs(luminance(surfaceRgb) - luminance(terminalBg));
		if (delta >= SURFACE_MIN_LUMINANCE_DELTA) {
			return (str: string) => this.bg(color, str);
		}

		const top = isLightColor(terminalBg) ? BLACK : WHITE;
		const adjustedColor = bestAnsiColor(blendColor(top, surfaceRgb, SURFACE_CONTRAST_ALPHA), this.mode);
		if (adjustedColor === "") {
			return (str: string) => this.bg(color, str);
		}
		const ansi = bgAnsi(adjustedColor, this.mode);
		return (str: string) => `${ansi}${str}\x1b[49m`;
	}

	getAdaptiveAccentColor(): (str: string) => string {
		const ansi =
			getTerminalBackgroundKind() === "light"
				? fgAnsi(bestAnsiColor(ADAPTIVE_LIGHT_BG_ACCENT, this.mode), this.mode)
				: "\x1b[36m";
		return (str: string) => `${ansi}\x1b[1m${str}\x1b[22m\x1b[39m`;
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(
		level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
	): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			case "max":
				// Reuse the xhigh color: a dedicated max color would touch every theme preset.
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const themesDir = getThemesDir();
		const primePath = path.join(themesDir, "prime.json");
		const darkPath = path.join(themesDir, "dark.json");
		const lightPath = path.join(themesDir, "light.json");
		BUILTIN_THEMES = {
			prime: JSON.parse(fs.readFileSync(primePath, "utf-8")) as ThemeJson,
			dark: JSON.parse(fs.readFileSync(darkPath, "utf-8")) as ThemeJson,
			light: JSON.parse(fs.readFileSync(lightPath, "utf-8")) as ThemeJson,
		};
	}
	return BUILTIN_THEMES;
}

export function getAvailableThemes(): string[] {
	const themes = new Set<string>(Object.keys(getBuiltinThemes()));
	const customThemesDir = getCustomThemesDir();
	if (fs.existsSync(customThemesDir)) {
		const files = fs.readdirSync(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				themes.add(file.slice(0, -5));
			}
		}
	}
	for (const name of registeredThemes.keys()) {
		themes.add(name);
	}
	return Array.from(themes).sort();
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export function getAvailableThemesWithPaths(): ThemeInfo[] {
	const themesDir = getThemesDir();
	const customThemesDir = getCustomThemesDir();
	const result: ThemeInfo[] = [];

	// Built-in themes
	for (const name of Object.keys(getBuiltinThemes())) {
		result.push({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// Custom themes
	if (fs.existsSync(customThemesDir)) {
		for (const file of fs.readdirSync(customThemesDir)) {
			if (file.endsWith(".json")) {
				const name = file.slice(0, -5);
				if (!result.some((t) => t.name === name)) {
					result.push({ name, path: path.join(customThemesDir, file) });
				}
			}
		}
	}

	for (const [name, theme] of registeredThemes.entries()) {
		if (!result.some((t) => t.name === name)) {
			result.push({ name, path: theme.sourcePath });
		}
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

function parseThemeJson(label: string, json: unknown): ThemeJson {
	if (!validateThemeJson) {
		// Validator not loaded yet (first custom-theme parse during startup):
		// apply a minimal structural check now and report full schema errors
		// asynchronously once the validator is ready.
		const colors = (json as Partial<ThemeJson> | null)?.colors;
		if (!json || typeof json !== "object" || !colors || typeof colors !== "object") {
			throw new Error(`Invalid theme "${label}": expected a JSON object with a "colors" object`);
		}
		void preloadThemeValidator().then(() => {
			try {
				parseThemeJson(label, json);
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
			}
		});
		return json as ThemeJson;
	}
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	return json as ThemeJson;
}

function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}

function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

function createTheme(themeJson: ThemeJson, mode?: ColorMode, sourcePath?: string): Theme {
	const colorMode = mode ?? detectColorMode();
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
		"toolDiffAddedBg",
		"toolDiffRemovedBg",
		"toolPanelBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return new Theme(fgColors, bgColors, colorMode, {
		name: themeJson.name,
		sourcePath,
	});
}

export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return createTheme(themeJson, mode, themePath);
}

function loadTheme(name: string, mode?: ColorMode): Theme {
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		return registeredTheme;
	}
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

export function getThemeByName(name: string): Theme | undefined {
	try {
		return loadTheme(name);
	} catch {
		return undefined;
	}
}

function detectTerminalBackground(): "dark" | "light" {
	return getTerminalBackgroundKind() ?? "dark";
}

function getDefaultTheme(): string {
	// Prime brand is dark-first; only fall back to light when the terminal is light.
	return detectTerminalBackground() === "light" ? "light" : "prime";
}

// ============================================================================
// Global Theme Instance
// ============================================================================

// Use globalThis to share theme across module loaders (tsx + jiti in dev mode)
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances (tsx, jiti) see the same theme
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
}

let currentThemeName: string | undefined;
let currentThemeIsAutomatic = false;
let themeWatcher: fs.FSWatcher | undefined;
let themeReloadTimer: NodeJS.Timeout | undefined;
let onThemeChangeCallback: (() => void) | undefined;
const registeredThemes = new Map<string, Theme>();

onDefaultTerminalColorsChange(() => {
	if (currentThemeIsAutomatic) {
		const name = getDefaultTheme();
		if (name !== currentThemeName) {
			currentThemeName = name;
			try {
				setGlobalTheme(loadTheme(name));
			} catch {
				currentThemeName = "dark";
				setGlobalTheme(loadTheme("dark"));
			}
		}
	}
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
});

export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			registeredThemes.set(theme.name, theme);
		}
	}
}

type CodeHighlighterModule = typeof import("./code-highlighter.js");
let codeHighlighter: CodeHighlighterModule | undefined;
let codeHighlighterPromise: Promise<void> | undefined;

/**
 * Start loading the syntax highlighter (cli-highlight pulls in all of
 * highlight.js, ~350ms) off the startup-critical import path. highlightCode
 * falls back to unhighlighted output until the load completes; await this
 * before the first render to guarantee highlighted code blocks.
 */
export function preloadCodeHighlighter(): Promise<void> {
	codeHighlighterPromise ??= import("./code-highlighter.js").then((module) => {
		codeHighlighter = module;
	});
	return codeHighlighterPromise;
}

export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
	void preloadCodeHighlighter();
	void preloadThemeValidator();
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	currentThemeIsAutomatic = themeName === undefined;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (_error) {
		// Theme is invalid - fall back to dark theme silently
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// Don't start watcher for fallback theme
	}
}

export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	currentThemeName = name;
	currentThemeIsAutomatic = false;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		// Theme is invalid - fall back to dark theme
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function setThemeInstance(themeInstance: Theme): void {
	setGlobalTheme(themeInstance);
	currentThemeName = "<in-memory>";
	currentThemeIsAutomatic = false;
	stopThemeWatcher(); // Can't watch a direct instance
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
	if (getDefaultTerminalColors()) {
		callback();
	}
}

function startThemeWatcher(): void {
	stopThemeWatcher();

	// Only watch if it's a custom theme (not built-in)
	if (
		!currentThemeName ||
		currentThemeName === "prime" ||
		currentThemeName === "dark" ||
		currentThemeName === "light"
	) {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// Ignore stale timers after switching themes or stopping the watcher
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// Keep the last successfully loaded theme active if the file is temporarily missing
			if (!fs.existsSync(themeFile)) {
				return;
			}

			try {
				// Reload the theme from disk and refresh the registry cache
				const reloadedTheme = loadThemeFromPath(themeFile);
				registeredThemes.set(watchedThemeName, reloadedTheme);
				setGlobalTheme(reloadedTheme);
				// Notify callback (to invalidate UI)
				if (onThemeChangeCallback) {
					onThemeChangeCallback();
				}
			} catch (_error) {
				// Ignore errors (file might be in invalid state while being edited)
			}
		}, 100);
	};

	themeWatcher =
		watchWithErrorHandler(
			customThemesDir,
			(_eventType, filename) => {
				if (currentThemeName !== watchedThemeName) {
					return;
				}
				if (!filename) {
					scheduleReload();
					return;
				}
				if (filename !== watchedFileName) {
					return;
				}
				scheduleReload();
			},
			() => {
				closeWatcher(themeWatcher);
				themeWatcher = undefined;
			},
		) ?? undefined;
}

export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	closeWatcher(themeWatcher);
	themeWatcher = undefined;
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
function ansi256ToHex(index: number): string {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	const isLight = name === "light";
	const themeJson = loadThemeJson(name);
	const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

	// Default text color for empty values (terminal uses default fg color)
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// Empty means default terminal color - use sensible fallback for HTML
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * Check if a theme is a "light" theme (for CSS that needs light/dark variants).
 */
export function isLightTheme(themeName?: string): boolean {
	// Currently just check the name - could be extended to analyze colors
	return themeName === "light";
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	try {
		const themeJson = loadThemeJson(name);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		const resolve = (value: ColorValue | undefined): string | undefined => {
			if (value === undefined) return undefined;
			const resolved = resolveVarRefs(value, vars);
			if (typeof resolved === "number") return ansi256ToHex(resolved);
			if (resolved === "") return undefined;
			return resolved;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

// ============================================================================
// TUI Helpers
// ============================================================================

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
	};
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
	// The highlighter loads lazily; until then render the block unhighlighted.
	const highlighter = codeHighlighter;
	// Validate language before highlighting to avoid stderr spam from cli-highlight
	const validLang = lang && highlighter?.supportsLanguage(lang) ? lang : undefined;
	// Skip highlighting when no valid language is specified. cli-highlight's
	// auto-detection is unreliable and can misidentify prose as AppleScript,
	// LiveCodeServer, etc., coloring random English words as keywords.
	if (!highlighter || !validLang) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return highlighter.highlight(code, opts).split("\n");
	} catch {
		return code.split("\n");
	}
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		math: (text: string) => theme.fg("mdCode", text),
		mathBlock: (text: string) => theme.fg("mdCodeBlock", text),
		highlightCode: (code: string, lang?: string): string[] => {
			// The highlighter loads lazily; until then render the block unhighlighted.
			const highlighter = codeHighlighter;
			// Validate language before highlighting to avoid stderr spam from cli-highlight
			const validLang = lang && highlighter?.supportsLanguage(lang) ? lang : undefined;
			// Skip highlighting when no valid language is specified. cli-highlight's
			// auto-detection is unreliable and can misidentify prose as AppleScript,
			// LiveCodeServer, etc., coloring random English words as keywords.
			if (!highlighter || !validLang) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			};
			try {
				return highlighter.highlight(code, opts).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		argumentHint: (text: string) => theme.fg("mdCode", text),
		sourceTag: (text: string) => theme.fg("dim", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		backgroundColor: theme.getEditorBackgroundColor(),
		autocompleteBackgroundColor: (text: string) => theme.getPopupBackgroundColor()(text),
		selectList: getSelectListTheme(),
		commandColor: (text: string) => theme.fg("accent", text),
	};
}

export function getSettingsListTheme(): import("@earendil-works/pi-tui").SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "› "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
