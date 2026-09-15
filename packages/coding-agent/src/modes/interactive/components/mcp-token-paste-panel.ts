import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import { MenuPanel, MenuSearchInput } from "./menu-panel.js";
import { shouldTreatAsBack } from "./modal-back.js";

export interface McpTokenPasteField {
	/** Catalog setup field id (the env var the manifest names — display only). */
	id: string;
	/** Human prompt label derived from the field (e.g. "GitHub personal access token"). */
	label: string;
}

export interface McpTokenPastePanelOptions {
	/** Service display label (e.g. "GitHub"); the panel title reads "Connect <label>". */
	serviceLabel: string;
	/** The service's own one-line setup reason, shown as context when present. */
	reason?: string;
	/** The ONE credential the panel collects — the flow is single-credential by construction. */
	field: McpTokenPasteField;
	/**
	 * Completes with the pasted value. The value exists only in memory and the
	 * credential store: this component never renders it, and it never reaches a
	 * status line, log, or transcript on any path.
	 */
	onSubmit: (value: string) => void;
	/** Esc: nothing was stored, nothing is echoed. */
	onCancel: () => void;
}

/** Live projection the body renders from — no secrets, only labels. */
interface TokenPasteRenderState {
	reason?: string;
	promptLabel: string;
	notice?: string;
	input: MenuSearchInput;
}

/** The one muted line the panel shares across renders. */
const STORAGE_HINT =
	"Input is hidden; it is saved only to the agent credential store — never settings, never the transcript.";

/**
 * The inline token paste panel, mounted on the same inline surface as the
 * OAuth login panel (showInlineAuthPanel) and in the #2331/#2340 visual
 * language: one separator rule, a prompt-style header, a muted context line,
 * then the input. Input is MASKED — a rendered line never contains the pasted
 * secret, only bullets — while edits and submit keep the real buffer. Exactly
 * ONE credential is collected: the paste flow prompts once, so a multi-value
 * credential (named header pairs) can never reach this panel.
 */
export class McpTokenPastePanelComponent extends Container implements Focusable {
	private readonly reason: string | undefined;
	private readonly field: McpTokenPasteField;
	private notice: string | undefined;
	private readonly input: MenuSearchInput;
	private readonly onSubmitCallback: (value: string) => void;
	private readonly onCancelCallback: () => void;
	private settled = false;

	// Delegate focus to the input so its IME cursor remains positioned correctly.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(options: McpTokenPastePanelOptions) {
		super();
		this.reason = options.reason?.trim() || undefined;
		this.field = options.field;
		this.onSubmitCallback = options.onSubmit;
		this.onCancelCallback = options.onCancel;
		// Same inline panel shape as the OAuth login dialog: rule + title, and
		// the masked input over the editor background.
		const panel = new MenuPanel({ title: `Connect ${options.serviceLabel}`, inline: true, topRule: true });
		this.addChild(panel);
		this.input = new MenuSearchInput("Paste token", true, { masked: true });
		this.input.onSubmit = () => this.submit();
		panel.addChild(new TokenPasteBody(() => this.renderState()));
	}

	private renderState(): TokenPasteRenderState {
		return {
			...(this.reason ? { reason: this.reason } : {}),
			promptLabel: this.field.label,
			...(this.notice ? { notice: this.notice } : {}),
			input: this.input,
		};
	}

	/** Submit the credential: an empty value stays on the field, never a dead end. */
	private submit(): void {
		if (this.settled) return;
		const value = this.input.getValue().trim();
		if (!value) {
			this.notice = "The value cannot be empty.";
			return;
		}
		this.settled = true;
		this.onSubmitCallback(value);
	}

	private cancel(): void {
		if (this.settled) return;
		this.settled = true;
		this.onCancelCallback();
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		// Esc (and Left at the start of the text, like the login dialog) cancels:
		// nothing was stored, and the masked buffer dies with the panel.
		if (keybindings.matches(keyData, "tui.select.cancel") || shouldTreatAsBack(keyData, this.input)) {
			this.cancel();
			return;
		}
		if (this.settled) return;
		const hadNotice = this.notice !== undefined;
		this.input.handleInput(keyData);
		if (hadNotice && this.input.getValue() !== "") this.notice = undefined;
	}
}

/** Full-width panel body in the #2340 shape: blank, context, prompt, masked input, hints. */
class TokenPasteBody implements Component {
	readonly fillsMenuPanel = true;

	constructor(private readonly getState: () => TokenPasteRenderState) {}

	invalidate(): void {
		// Render output derives from the panel's live state.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const state = this.getState();
		const lines: string[] = [this.line(safeWidth, "")];
		if (state.reason) {
			// Catalog copy can be long: wrap it, cap it at two lines, ellipsize.
			const wrapWidth = Math.max(1, safeWidth - 2);
			const wrapped = wrapTextWithAnsi(state.reason, wrapWidth).slice(0, 2);
			if (wrapped.length === 2 && visibleWidth(wrapped[1] ?? "") >= wrapWidth) {
				wrapped[1] = `${truncateToWidth(wrapped[1] ?? "", Math.max(0, wrapWidth - 1), "")}…`;
			}
			for (const row of wrapped) lines.push(this.line(safeWidth, theme.fg("muted", row)));
			lines.push(this.line(safeWidth, ""));
		}
		if (state.notice) lines.push(this.line(safeWidth, theme.fg("error", state.notice)));
		lines.push(this.line(safeWidth, theme.fg("text", state.promptLabel)));
		lines.push(...state.input.render(safeWidth));
		lines.push(this.line(safeWidth, theme.fg("muted", STORAGE_HINT)));
		const hint = `${keyText("tui.select.confirm", { primaryOnly: true })} submit · ${keyText("tui.select.cancel", { primaryOnly: true })} close`;
		lines.push(this.line(safeWidth, theme.fg("dim", hint)));
		return lines;
	}

	/** One indented line (the #2340 shape: a single column of indent). */
	private line(width: number, content: string): string {
		const truncated = truncateToWidth(content ? ` ${content}` : "", width, "");
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	}
}
