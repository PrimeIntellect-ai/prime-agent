import {
	CURSOR_MARKER,
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.js";

export interface CustomEditorOptions extends EditorOptions {
	placeholder?: string;
	placeholderColor?: (text: string) => string;
	isArgumentCommand?: (name: string) => boolean;
}

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private defaultPromptPrefix: string;
	private readonly configuredPaddingX: number;
	private placeholder: string | undefined;
	private readonly placeholderColor: (text: string) => string;
	private readonly isArgumentCommand: (name: string) => boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	public onMoveBelowPrompt?: () => boolean;
	public onAgentsBack?: () => boolean;
	/** When set, the returned line is rendered inside the top of the editor box. */
	public getHeaderLine?: () => string | undefined;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		const promptPrefix = options?.promptPrefix ?? "> ";
		super(tui, theme, { ...options, promptPrefix });
		this.keybindings = keybindings;
		this.defaultPromptPrefix = promptPrefix;
		this.configuredPaddingX = options?.paddingX ?? 0;
		this.placeholder = options?.placeholder;
		this.placeholderColor = options?.placeholderColor ?? ((text) => text);
		this.isArgumentCommand = options?.isArgumentCommand ?? (() => false);
	}

	protected override getPromptPrefix(): string {
		return this.getBashPromptInfo(this.getLines()[0] ?? "")?.promptPrefix ?? this.defaultPromptPrefix;
	}

	protected override formatPromptPrefix(prefix: string): string {
		return prefix.startsWith("!") ? this.borderColor(prefix) : prefix;
	}

	protected override getHiddenTextPrefixLength(lineIndex: number, line: string): number {
		if (lineIndex !== 0) {
			return 0;
		}
		return this.getBashPromptInfo(line)?.hiddenTextPrefixLength ?? 0;
	}

	protected override styleDisplayText(
		displayText: string,
		layoutLineIndex: number,
		lineText: string,
		cursorCol: number | undefined,
	): string {
		const commandColor = this.commandColor;
		if (!commandColor || layoutLineIndex !== 0) {
			return displayText;
		}

		const match = /^(\s*)\/(\S+)/.exec(lineText);
		if (!match) {
			return displayText;
		}
		const [token, leadingWhitespace, name] = match as unknown as [string, string, string];
		if (!this.isArgumentCommand(name)) {
			return displayText;
		}

		const tokenStart = leadingWhitespace.length;
		const tokenEnd = token.length;

		if (cursorCol !== undefined && cursorCol < tokenEnd) {
			return displayText;
		}

		const before = displayText.slice(0, tokenStart);
		const tokenText = displayText.slice(tokenStart, tokenEnd);
		const after = displayText.slice(tokenEnd);
		return `${before}${commandColor(tokenText)}${after}`;
	}

	private getBashPromptInfo(line: string): { promptPrefix: string; hiddenTextPrefixLength: number } | undefined {
		const trimmedLine = line.trimStart();
		const leadingWhitespaceLength = line.length - trimmedLine.length;
		if (trimmedLine.startsWith("!!")) {
			return {
				promptPrefix: "!! ",
				hiddenTextPrefixLength: leadingWhitespaceLength + (trimmedLine.startsWith("!! ") ? 3 : 2),
			};
		}
		if (trimmedLine.startsWith("!")) {
			return {
				promptPrefix: "! ",
				hiddenTextPrefixLength: leadingWhitespaceLength + (trimmedLine.startsWith("! ") ? 2 : 1),
			};
		}
		return undefined;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	override render(width: number): string[] {
		let lines = super.render(width);
		if (this.placeholder && this.getText().length === 0 && lines.length >= 2) {
			lines = [lines[0]!, this.renderPlaceholderLine(width), ...lines.slice(2)];
		}
		const headerLine = this.getHeaderLine?.();
		if (headerLine !== undefined && lines.length >= 2) {
			lines = [
				lines[0]!,
				this.renderHeaderContentLine(headerLine, width),
				this.renderHeaderContentLine("", width),
				...lines.slice(1),
			];
		}
		return lines;
	}

	setPlaceholder(placeholder: string | undefined): void {
		this.placeholder = placeholder;
		this.invalidate();
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		const repeatedClearInput = this.splitRepeatedKeybinding(data, "app.input.clear");
		if (repeatedClearInput) {
			for (const input of repeatedClearInput) {
				this.handleInput(input);
			}
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		if (this.keybindings.matches(data, "app.agents.back") && this.onAgentsBack?.()) {
			return;
		}

		// Clear input
		if (this.keybindings.matches(data, "app.input.clear")) {
			const hadAutocomplete = this.isShowingAutocomplete();
			if (hadAutocomplete) {
				this.cancelAutocomplete();
			}
			const handler = this.onEscape ?? this.actionHandlers.get("app.input.clear");
			if (handler) {
				handler();
				return;
			}
			if (hadAutocomplete) {
				return;
			}
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions. A raw "\n" is Shift+Enter's newline in some
		// terminals, so it goes to the editor even though it decodes as ctrl+j.
		for (const [action, handler] of this.actionHandlers) {
			if (
				data !== "\n" &&
				action !== "app.input.clear" &&
				action !== "app.exit" &&
				(action !== "app.shortcuts" || this.getText().length === 0) &&
				this.keybindings.matches(data, action)
			) {
				if ((action === "app.clear" || action === "app.interrupt") && this.isShowingAutocomplete()) {
					this.cancelAutocomplete();
				}
				handler();
				return;
			}
		}

		if (
			this.keybindings.matches(data, "tui.editor.cursorDown") &&
			!this.isShowingAutocomplete() &&
			!this.isHistoryNavigationActive() &&
			this.isCursorAtEnd() &&
			this.onMoveBelowPrompt?.()
		) {
			return;
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}

	private isCursorAtEnd(): boolean {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return cursor.line === lines.length - 1 && cursor.col === (lines[cursor.line]?.length ?? 0);
	}

	private splitRepeatedKeybinding(data: string, keybinding: AppKeybinding): string[] | undefined {
		const inputs: string[] = [];
		let offset = 0;

		while (offset < data.length) {
			let match: string | undefined;
			for (let end = offset + 1; end <= data.length; end++) {
				const candidate = data.slice(offset, end);
				if (this.keybindings.matches(candidate, keybinding)) {
					match = candidate;
					offset = end;
					break;
				}
			}
			if (!match) {
				return undefined;
			}
			inputs.push(match);
		}

		return inputs.length > 1 ? inputs : undefined;
	}

	private getEffectivePaddingX(width: number): number {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const configuredPaddingX = Math.min(this.configuredPaddingX, maxPadding);
		return this.backgroundColor !== undefined
			? Math.min(Math.max(configuredPaddingX, 2), maxPadding)
			: configuredPaddingX;
	}

	private renderHeaderContentLine(content: string, width: number): string {
		const paddingX = this.getEffectivePaddingX(width);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const line = `${" ".repeat(paddingX)}${truncateToWidth(content, contentWidth)}`;
		const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		const backgroundColor = this.backgroundColor;
		if (!backgroundColor) {
			return padded;
		}
		// Truncation may inject full ANSI resets; wrap each segment so the
		// background survives past them instead of falling back to the terminal's.
		return padded
			.split("\x1b[0m")
			.map((segment) => backgroundColor(segment))
			.join("\x1b[0m");
	}

	private renderPlaceholderLine(width: number): string {
		const paddingX = this.getEffectivePaddingX(width);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const promptPrefixText = this.getPromptPrefix();
		const promptPrefixWidth = Math.min(visibleWidth(promptPrefixText), Math.max(0, contentWidth - 1));
		const inputWidth = Math.max(1, contentWidth - promptPrefixWidth);
		const promptPrefix =
			promptPrefixWidth > 0 ? this.formatPromptPrefix(truncateToWidth(promptPrefixText, promptPrefixWidth, "")) : "";
		const promptPrefixInset = promptPrefixWidth > 0 ? Math.min(1, paddingX) : 0;
		const promptLeadingPadding = " ".repeat(promptPrefixInset);
		const promptTrailingPadding = " ".repeat(Math.max(0, paddingX - promptPrefixInset));
		const rightPadding = " ".repeat(paddingX);
		const placeholderWidth = Math.max(0, inputWidth - 1);
		const placeholderText = truncateToWidth(this.placeholder ?? "", placeholderWidth, "");
		const cursorMarker = this.focused && !this.isShowingAutocomplete() ? CURSOR_MARKER : "";
		const cursorReset = this.backgroundColor ? "\x1b[27m" : "\x1b[0m";
		const displayText = `${cursorMarker}\x1b[7m ${cursorReset}${this.placeholderColor(placeholderText)}`;
		const padding = " ".repeat(Math.max(0, placeholderWidth - visibleWidth(placeholderText)));
		const line = `${promptLeadingPadding}${promptPrefix}${promptTrailingPadding}${displayText}${padding}${rightPadding}`;
		const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		return this.getAutocompleteAnchorMarker() + (this.backgroundColor ? this.backgroundColor(padded) : padded);
	}
}
