import { blendColor, isLightColor, type Rgb, rgbTo256 } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

/** How far a selected row lifts off the canvas; lower reads more transparent. */
const HIGHLIGHT_LIFT = 0.08;
const DARK_CANVAS: Rgb = { r: 16, g: 16, b: 16 };
const LIGHT_CANVAS: Rgb = { r: 255, g: 255, b: 255 };

function parseHexColor(value: string | undefined): Rgb | undefined {
	const match = /^#?([0-9a-f]{6})$/i.exec(value?.trim() ?? "");
	if (!match?.[1]) {
		return undefined;
	}
	const int = Number.parseInt(match[1], 16);
	return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/**
 * The selected-row wash shared by every onboarding surface: the canvas lifted a
 * few percent toward the text colour, rather than the picker's solid fill.
 */
export function onboardingHighlightBackground(colors: Record<string, string>): (text: string) => string {
	const text = parseHexColor(colors.text);
	const onDark = !text || isLightColor(text);
	const canvas = parseHexColor(colors.background) ?? (onDark ? DARK_CANVAS : LIGHT_CANVAS);
	const lift: Rgb = onDark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
	const washed = blendColor(lift, canvas, HIGHLIGHT_LIFT);
	const ansi =
		theme.colorMode === "truecolor"
			? `\x1b[48;2;${washed.r};${washed.g};${washed.b}m`
			: `\x1b[48;5;${rgbTo256(washed)}m`;
	return (value: string) => `${ansi}${value}\x1b[49m`;
}
