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

/** One prompt of the paste panel: a credential field with its human label. */
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
	/** Credential fields to prompt, in order; every one is required. */
	fields: readonly McpTokenPasteField[];
	/**
	 * Completes with every pasted value keyed by field id, in prompt order.
	 * The secret values exist only in memory and the credential store: this
	 * component never renders them, and they never reach a status line, log,
	 * or transcript on any path.
	 */
	onSubmit: (values: Record<string, string>) => void;
	/** Esc: nothing was stored, nothing is echoed. */
	onCancel: () => void;
}

/** Live projection the body renders from — no secrets, only labels. */
interface TokenPasteRenderState {
	reason?: string;
	completedLabels: readonly string[];
	promptLabel: string;
	notice?: string;
	input: MenuSearchInput;
}

/** The one muted line every field of the panel shares. */
const STORAGE_HINT =
	"Input is hidden; it is saved only to the agent credential store — never settings, never the transcript.";

/**
 * The inline token paste panel, mounted on the same inline surface as the
 * OAuth login panel (showInlineAuthPanel) and in the #2331/#2340 visual
 * language: one separator rule, a prompt-style header, a muted context line,
 * then the input. Input is MASKED — a rendered line never contains the pasted
 * secret, only bullets — while edits and submit keep the real buffer.
 */
export class McpTokenPastePanelComponent extends Container implements Focusable {
	private readonly serviceLabel: string;
	private readonly reason: string | undefined;
	private readonly fields: readonly McpTokenPasteField[];
	private readonly values: Record<string, string> = {};
	private fieldIndex = 0;
	private notice: string | undefined;
	private readonly input: MenuSearchInput;
	private readonly onSubmitCallback: (values: Record<string, string>) => void;
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
		if (options.fields.length === 0) {
			throw new Error("The token paste panel requires at least one field");
		}
		this.serviceLabel = options.serviceLabel;
		this.reason = options.reason?.trim() || undefined;
		this.fields = [...options.fields];
		this.onSubmitCallback = options.onSubmit;
		this.onCancelCallback = options.onCancel;
		// Same inline panel shape as the OAuth login dialog: rule + title, and
		// the masked input over the editor background.
		const panel = new MenuPanel({ title: `Connect ${options.serviceLabel}`, inline: true, topRule: true });
		this.addChild(panel);
		this.input = new MenuSearchInput("Paste token", true, { masked: true });
		this.input.onSubmit = () => this.submitCurrent();
		panel.addChild(new TokenPasteBody(() => this.renderState()));
	}

	private renderState(): TokenPasteRenderState {
		return {
			...(this.reason ? { reason: this.reason } : {}),
			completedLabels: this.fields.slice(0, this.fieldIndex).map((field) => field.label),
			promptLabel: this.fields[this.fieldIndex]?.label ?? "",
			...(this.notice ? { notice: this.notice } : {}),
			input: this.input,
		};
	}

	/** Submit the current field: an empty value stays on the field, never a dead end. */
	private submitCurrent(): void {
		if (this.settled) return;
		const value = this.input.getValue().trim();
		if (!value) {
			this.notice = "The value cannot be empty.";
			return;
		}
		const field = this.fields[this.fieldIndex];
		if (!field) return;
		this.values[field.id] = value;
		this.input.setValue("");
		this.notice = undefined;
		this.fieldIndex += 1;
		if (this.fieldIndex >= this.fields.length) {
			this.settled = true;
			this.onSubmitCallback({ ...this.values });
		}
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

/** Full-width panel body in the #2340 shape: blank, context, completed rows, prompt, input, hints. */
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
		for (const label of state.completedLabels) {
			lines.push(this.line(safeWidth, theme.fg("muted", `✓ ${label}`)));
		}
		if (state.completedLabels.length > 0) lines.push(this.line(safeWidth, ""));
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
