/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export interface KeyTextOptions {
	primaryOnly?: boolean;
}

function normalizeKeyPart(part: string): string {
	return part === "escape" ? "esc" : part;
}

function formatArrowKey(part: string): string | undefined {
	switch (part) {
		case "up":
			return "↑";
		case "down":
			return "↓";
		case "left":
			return "←";
		case "right":
			return "→";
		default:
			return undefined;
	}
}

function formatKeyPart(part: string, platform: NodeJS.Platform): string {
	const normalized = normalizeKeyPart(part);
	const arrow = formatArrowKey(normalized);
	if (arrow) return arrow;
	// Terminals send the literal Control key on macOS, so never label it Cmd.
	if (platform === "darwin" && normalized === "alt") {
		return "Option";
	}
	return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function formatKeyText(key: string, platform: NodeJS.Platform = process.platform): string {
	return key
		.split("/")
		.map((binding) =>
			binding
				.split("+")
				.map((part) => formatKeyPart(part, platform))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextOptions = {}): string {
	const displayKeys = options.primaryOnly ? keys.slice(0, 1) : keys;
	if (displayKeys.length === 0) return "";
	if (displayKeys.length === 1) return formatKeyText(displayKeys[0]!);
	return formatKeyText(displayKeys.join("/"));
}

export function keyText(keybinding: Keybinding, options: KeyTextOptions = {}): string {
	return formatKeys(getKeybindings().getKeys(keybinding), options);
}

export function keyHint(keybinding: Keybinding, description: string, options: KeyTextOptions = {}): string {
	return theme.fg("dim", keyText(keybinding, options)) + theme.fg("muted", ` ${description}`);
}

/** Canonical bracketed expand/collapse hint, e.g. `(Ctrl+O to expand)`, fully dim. */
export function expandCollapseHint(keybinding: Keybinding, expanded: boolean): string {
	return theme.fg("dim", `(${keyText(keybinding)} ${expanded ? "to collapse" : "to expand"})`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
