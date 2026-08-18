import { type KeyId, matchesKey } from "./keys.js";

/**
 * Global keybinding registry.
 * Downstream packages can add keybindings via declaration merging.
 */
export interface Keybindings {
	// Editor navigation and editing
	"tui.editor.cursorUp": true;
	"tui.editor.cursorDown": true;
	"tui.editor.cursorLeft": true;
	"tui.editor.cursorRight": true;
	"tui.editor.cursorWordLeft": true;
	"tui.editor.cursorWordRight": true;
	"tui.editor.cursorLineStart": true;
	"tui.editor.cursorLineEnd": true;
	"tui.editor.jumpForward": true;
	"tui.editor.jumpBackward": true;
	"tui.editor.pageUp": true;
	"tui.editor.pageDown": true;
	"tui.editor.deleteCharBackward": true;
	"tui.editor.deleteCharForward": true;
	"tui.editor.deleteWordBackward": true;
	"tui.editor.deleteWordForward": true;
	"tui.editor.deleteToLineStart": true;
	"tui.editor.deleteToLineEnd": true;
	"tui.editor.yank": true;
	"tui.editor.yankPop": true;
	"tui.editor.undo": true;
	// Generic input actions
	"tui.input.newLine": true;
	"tui.input.submit": true;
	"tui.input.tab": true;
	"tui.input.copy": true;
	// Fullscreen transcript viewport
	"tui.viewport.pageUp": true;
	"tui.viewport.pageDown": true;
	"tui.viewport.top": true;
	"tui.viewport.follow": true;
	// Generic selection actions
	"tui.select.up": true;
	"tui.select.down": true;
	"tui.select.pageUp": true;
	"tui.select.pageDown": true;
	"tui.select.confirm": true;
	"tui.select.cancel": true;
}

export type Keybinding = keyof Keybindings;

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
	defaultKeyScope?: string;
}

export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export const TUI_KEYBINDINGS = {
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up", defaultKeyScope: "editor" },
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down", defaultKeyScope: "editor" },
	"tui.editor.cursorLeft": {
		defaultKeys: ["left", "ctrl+b"],
		description: "Move cursor left",
		defaultKeyScope: "editor",
	},
	"tui.editor.cursorRight": {
		defaultKeys: ["right", "ctrl+f"],
		description: "Move cursor right",
		defaultKeyScope: "editor",
	},
	"tui.editor.cursorWordLeft": {
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		description: "Move cursor word left",
		defaultKeyScope: "editor",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		description: "Move cursor word right",
		defaultKeyScope: "editor",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: ["home", "ctrl+a"],
		description: "Move to line start",
		defaultKeyScope: "editor",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: ["end", "ctrl+e"],
		description: "Move to line end",
		defaultKeyScope: "editor",
	},
	"tui.editor.jumpForward": {
		defaultKeys: "ctrl+]",
		description: "Jump forward to character",
		defaultKeyScope: "editor",
	},
	"tui.editor.jumpBackward": {
		defaultKeys: "ctrl+alt+]",
		description: "Jump backward to character",
		defaultKeyScope: "editor",
	},
	"tui.editor.pageUp": { defaultKeys: "pageUp", description: "Page up", defaultKeyScope: "editor" },
	"tui.editor.pageDown": { defaultKeys: "pageDown", description: "Page down", defaultKeyScope: "editor" },
	"tui.editor.deleteCharBackward": {
		defaultKeys: "backspace",
		description: "Delete character backward",
		defaultKeyScope: "editor",
	},
	"tui.editor.deleteCharForward": {
		defaultKeys: ["delete", "ctrl+d"],
		description: "Delete character forward",
		defaultKeyScope: "editor",
	},
	"tui.editor.deleteWordBackward": {
		defaultKeys: ["ctrl+w", "alt+backspace"],
		description: "Delete word backward",
		defaultKeyScope: "editor",
	},
	"tui.editor.deleteWordForward": {
		defaultKeys: ["alt+d", "alt+delete"],
		description: "Delete word forward",
		defaultKeyScope: "editor",
	},
	"tui.editor.deleteToLineStart": {
		defaultKeys: "ctrl+u",
		description: "Delete to line start",
		defaultKeyScope: "editor",
	},
	"tui.editor.deleteToLineEnd": {
		defaultKeys: "ctrl+k",
		description: "Delete to line end",
		defaultKeyScope: "editor",
	},
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank", defaultKeyScope: "editor" },
	"tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop", defaultKeyScope: "editor" },
	"tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo", defaultKeyScope: "editor" },
	"tui.input.newLine": {
		defaultKeys: "shift+enter",
		description: "Insert newline",
		defaultKeyScope: "editor",
	},
	"tui.input.submit": { defaultKeys: "enter", description: "Submit input", defaultKeyScope: "editor" },
	"tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete", defaultKeyScope: "editor" },
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection", defaultKeyScope: "editor" },
	"tui.viewport.pageUp": {
		defaultKeys: "pageUp",
		description: "Scroll transcript up a page (fullscreen)",
	},
	"tui.viewport.pageDown": {
		defaultKeys: "pageDown",
		description: "Scroll transcript down a page (fullscreen)",
	},
	"tui.viewport.top": {
		defaultKeys: "shift+alt+up",
		description: "Scroll transcript to top (fullscreen)",
	},
	"tui.viewport.follow": {
		defaultKeys: "ctrl+shift+down",
		description: "Scroll to bottom and follow output (fullscreen)",
	},
	"tui.select.up": { defaultKeys: "up", description: "Move selection up" },
	"tui.select.down": { defaultKeys: "down", description: "Move selection down" },
	"tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
	"tui.select.pageDown": {
		defaultKeys: "pageDown",
		description: "Selection page down",
	},
	"tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
	"tui.select.cancel": {
		defaultKeys: ["escape", "ctrl+c"],
		description: "Cancel selection",
	},
} as const satisfies KeybindingDefinitions;

export interface KeybindingConflict {
	key: KeyId;
	keybindings: string[];
}

function normalizeKeys(keys: KeyId | KeyId[] | undefined): KeyId[] {
	if (keys === undefined) return [];
	const keyList = Array.isArray(keys) ? keys : [keys];
	const seen = new Set<KeyId>();
	const result: KeyId[] = [];
	for (const key of keyList) {
		if (!seen.has(key)) {
			seen.add(key);
			result.push(key);
		}
	}
	return result;
}

export class KeybindingsManager {
	private definitions: KeybindingDefinitions;
	private userBindings: KeybindingsConfig;
	private keysById = new Map<Keybinding, KeyId[]>();
	private conflicts: KeybindingConflict[] = [];

	constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
		this.definitions = definitions;
		this.userBindings = userBindings;
		this.rebuild();
	}

	private rebuild(): void {
		this.keysById.clear();
		this.conflicts = [];

		const explicitClaims = new Map<KeyId, Set<Keybinding>>();
		const addedClaims = new Map<KeyId, Set<Keybinding>>();
		for (const [keybinding, keys] of Object.entries(this.userBindings)) {
			const definition = this.definitions[keybinding];
			if (!definition) continue;
			const defaults = new Set(normalizeKeys(definition.defaultKeys));
			for (const key of normalizeKeys(keys)) {
				const explicitClaimants = explicitClaims.get(key) ?? new Set<Keybinding>();
				explicitClaimants.add(keybinding as Keybinding);
				explicitClaims.set(key, explicitClaimants);
				if (!defaults.has(key)) {
					const addedClaimants = addedClaims.get(key) ?? new Set<Keybinding>();
					addedClaimants.add(keybinding as Keybinding);
					addedClaims.set(key, addedClaimants);
				}
			}
		}

		for (const [key, keybindings] of explicitClaims) {
			if (keybindings.size > 1) {
				this.conflicts.push({ key, keybindings: [...keybindings] });
			}
		}

		for (const [id, definition] of Object.entries(this.definitions)) {
			const userKeys = this.userBindings[id];
			const keys =
				userKeys === undefined
					? normalizeKeys(definition.defaultKeys).filter((key) => {
							if (!definition.defaultKeyScope) return true;
							return ![...(addedClaims.get(key) ?? [])].some(
								(claimant) => this.definitions[claimant]?.defaultKeyScope === definition.defaultKeyScope,
							);
						})
					: normalizeKeys(userKeys);
			this.keysById.set(id as Keybinding, keys);
		}
	}

	matches(data: string, keybinding: Keybinding): boolean {
		const keys = this.keysById.get(keybinding) ?? [];
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	getKeys(keybinding: Keybinding): KeyId[] {
		return [...(this.keysById.get(keybinding) ?? [])];
	}

	getDefinition(keybinding: Keybinding): KeybindingDefinition {
		return this.definitions[keybinding];
	}

	getConflicts(): KeybindingConflict[] {
		return this.conflicts.map((conflict) => ({ ...conflict, keybindings: [...conflict.keybindings] }));
	}

	setUserBindings(userBindings: KeybindingsConfig): void {
		this.userBindings = userBindings;
		this.rebuild();
	}

	getUserBindings(): KeybindingsConfig {
		return { ...this.userBindings };
	}

	getResolvedBindings(): KeybindingsConfig {
		const resolved: KeybindingsConfig = {};
		for (const id of Object.keys(this.definitions)) {
			const keys = this.keysById.get(id as Keybinding) ?? [];
			resolved[id] = keys.length === 1 ? keys[0]! : [...keys];
		}
		return resolved;
	}
}

let globalKeybindings: KeybindingsManager | null = null;

export function setKeybindings(keybindings: KeybindingsManager): void {
	globalKeybindings = keybindings;
}

export function getKeybindings(): KeybindingsManager {
	if (!globalKeybindings) {
		globalKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	}
	return globalKeybindings;
}
