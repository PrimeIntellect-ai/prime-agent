import type { AutocompleteProvider } from "./autocomplete.js";
import type { Component } from "./tui.js";

export interface EditorPasteSnapshot {
	pastes: readonly (readonly [number, string])[];
	pasteCounter: number;
}

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	/** Get the current text content */
	getText(): string;

	/** Set the text content */
	setText(text: string): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	/** Called when user submits (e.g., Enter key) */
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	/** Add text to history for up/down navigation */
	addToHistory?(text: string): void;

	/** Prompt history entries available for up/down navigation (most recent first). */
	getHistory?(): readonly string[];

	/** Clear prompt history (e.g. when switching to a different session). */
	clearHistory?(): void;

	/** Insert text at current cursor position */
	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	getPasteSnapshot?(): EditorPasteSnapshot;

	restorePasteSnapshot?(snapshot: EditorPasteSnapshot): void;

	/** Set the autocomplete provider */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	/** Border color function */
	borderColor?: (str: string) => string;

	/** Background color function */
	backgroundColor?: (str: string) => string;

	/** Set horizontal padding */
	setPaddingX?(padding: number): void;

	/** Set max visible items in autocomplete dropdown */
	setAutocompleteMaxVisible?(maxVisible: number): void;
}
