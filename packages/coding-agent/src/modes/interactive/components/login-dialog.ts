import { win32 } from "node:path";
import { getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import {
	type Component,
	Container,
	type Focusable,
	getCapabilities,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { execFileHidden } from "../../../utils/child-process.js";
import { copyToClipboard } from "../../../utils/clipboard.js";
import { theme } from "../theme/theme.js";
import { formatKeyText, keyHint } from "./keybinding-hints.js";
import { MenuPanel, MenuSearchInput } from "./menu-panel.js";
import { shouldTreatAsBack } from "./modal-back.js";

function isTextEntryKeybinding(key: string): boolean {
	const parts = key.toLowerCase().split("+");
	const keyPart = parts.at(-1);
	return !parts.includes("ctrl") && !parts.includes("alt") && (keyPart === "space" || keyPart?.length === 1);
}

function isPrintableInput(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

/**
 * Login dialog component - replaces the prompt area during provider login flows
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: MenuSearchInput;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	// True only while the editable paste field is actually shown in the panel.
	// Tracks visibility directly rather than inferring it from inputResolver,
	// which can outlive the field when a new screen clears the content.
	private inputVisible = false;
	private continueResolver?: () => void;
	private continueRejecter?: (error: Error) => void;
	private authUrl?: string;
	private authActions?: Text;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		providerId: string,
		private onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
	) {
		super();
		this.tui = tui;

		const providerInfo = getOAuthProviders().find((p) => p.id === providerId);
		const providerName = providerNameOverride || providerInfo?.name || providerId;
		const title = titleOverride ?? `Login to ${providerName}`;

		// The top rule keeps the inline login section separate from the transcript.
		const panel = new MenuPanel({ title, inline: true, topRule: true });
		this.addChild(panel);

		// Dynamic content area
		this.contentContainer = new Container();
		panel.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = new MenuSearchInput("Paste value", true);
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				this.inputResolver(this.input.getValue());
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
			}
		};
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	private cancel(): void {
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
		if (this.continueRejecter) {
			this.continueRejecter(new Error("Login cancelled"));
			this.continueResolver = undefined;
			this.continueRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(url: string, instructions?: string): void {
		this.startContent();
		this.authUrl = url;
		const linkedUrl = getCapabilities().hyperlinks ? `\x1b]8;;${url}\x07${url}\x1b]8;;\x07` : url;
		this.contentContainer.addChild(new Text(theme.fg("text", linkedUrl), 0, 0));
		// Provider instructions already describe the browser step.
		if (instructions) {
			this.addInstructions(instructions);
		} else {
			this.addMutedText("Complete the sign-in in your browser.");
		}
		this.authActions = new Text(this.getAuthActionsText(), 0, 0);
		this.contentContainer.addChild(this.authActions);

		// Try to open browser
		const [command, ...args] =
			process.platform === "darwin"
				? ["open", url]
				: process.platform === "win32"
					? [
							win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"),
							"url.dll,FileProtocolHandler",
							url,
						]
					: ["xdg-open", url];
		execFileHidden(command, args, {}, () => {});

		this.tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.addSectionSpacer();
		this.addMutedText(prompt);
		this.addInputField();
		this.tui.requestRender();

		return this.waitForInput();
	}

	/** Append content while keeping the key-hint row as the panel's last row. */
	private addChildAboveHints(component: Component): void {
		if (!this.authActions) {
			this.contentContainer.addChild(component);
			return;
		}
		this.contentContainer.removeChild(this.authActions);
		this.contentContainer.addChild(component);
		this.contentContainer.addChild(this.authActions);
		this.authActions.setText(this.getAuthActionsText());
	}

	/** Append the paste field plus the single key-hint line at the panel bottom. */
	private addInputField(): void {
		this.contentContainer.removeChild(this.input);
		if (this.authActions) {
			this.contentContainer.removeChild(this.authActions);
		} else {
			this.authActions = new Text(this.getAuthActionsText(), 0, 0);
		}
		this.contentContainer.addChild(this.input);
		this.inputVisible = true;
		this.contentContainer.addChild(this.authActions);
		this.authActions.setText(this.getAuthActionsText());
	}

	/**
	 * Wait for the next submission of the already-visible input.
	 */
	waitForInput(): Promise<string> {
		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string): Promise<string> {
		this.addSectionSpacer();
		this.addSectionTitle(message);
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("muted", `e.g., ${placeholder}`), 0, 0));
		}
		this.addInputField();

		this.input.setValue("");
		this.tui.requestRender();

		return this.waitForInput();
	}

	/**
	 * Show informational text without prompting for input.
	 */
	showInfo(lines: string[]): void {
		this.startContent();
		for (const line of lines) {
			this.contentContainer.addChild(new Text(line, 0, 0));
		}
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("muted", keyHint("tui.select.cancel", "close")), 0, 0));
		this.tui.requestRender();
	}

	showContinueInfo(lines: string[]): Promise<void> {
		this.startContent();
		for (const line of lines) {
			this.contentContainer.addChild(new Text(line, 0, 0));
		}
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(
			new Text(
				theme.fg(
					"muted",
					`${keyHint("tui.select.confirm", "continue")}  ${keyHint("tui.select.cancel", "cancel")}`,
				),
				0,
				0,
			),
		);
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.continueResolver = resolve;
			this.continueRejecter = reject;
		});
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.addSectionSpacer();
		this.addChildAboveHints(new Text(theme.fg("accent", message), 0, 0));
		if (!this.authActions) {
			this.authActions = new Text(this.getAuthActionsText(), 0, 0);
			this.contentContainer.addChild(this.authActions);
		}
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		if (this.contentContainer.children.length === 0) {
			this.startContent();
			this.addSectionTitle("Preparing authentication");
		}
		this.addChildAboveHints(new Text(theme.fg("muted", message), 0, 0));
		this.tui.requestRender();
	}

	private startContent(): void {
		this.contentContainer.clear();
		this.authUrl = undefined;
		this.authActions = undefined;
		// The cleared panel no longer shows the paste field.
		this.inputVisible = false;
		this.contentContainer.addChild(new Spacer(1));
	}

	private addSectionSpacer(): void {
		if (this.contentContainer.children.length === 0) {
			this.startContent();
			return;
		}
		this.addChildAboveHints(new Spacer(1));
	}

	private addInstructions(instructions: string): void {
		const codeMatch = /^(?:Code|Enter code):\s*(.+)$/i.exec(instructions.trim());
		if (codeMatch?.[1]) {
			this.addLabel("Verification code");
			this.contentContainer.addChild(new Text(theme.bold(theme.fg("text", codeMatch[1])), 0, 0));
			return;
		}
		this.contentContainer.addChild(new Text(theme.fg("text", instructions), 0, 0));
	}

	private addSectionTitle(text: string): void {
		this.contentContainer.addChild(new Text(theme.fg("text", text), 0, 0));
	}

	private addLabel(text: string): void {
		this.contentContainer.addChild(new Text(theme.fg("muted", text), 0, 0));
	}

	private addMutedText(text: string): void {
		this.contentContainer.addChild(new Text(theme.fg("muted", text), 0, 0));
	}

	private getAuthActionsText(status?: "copied" | "failed"): string {
		const configuredCopyKeys = getKeybindings().getKeys("app.clipboard.copyLoginUrl");
		const copyKeys = this.inputVisible
			? configuredCopyKeys.filter((key) => !isTextEntryKeybinding(key))
			: configuredCopyKeys.slice(0, 1);
		const copyHint =
			copyKeys.length > 0
				? theme.fg("dim", formatKeyText(copyKeys.join("/"))) +
					theme.fg("muted", ` ${status === "failed" ? "retry" : "copy"}`)
				: undefined;
		const statusText =
			status === "copied"
				? theme.fg("success", "Copied sign-in link")
				: status === "failed"
					? theme.fg("error", "Failed to copy sign-in link")
					: undefined;
		const submitHint = this.inputVisible ? keyHint("tui.select.confirm", "submit") : undefined;
		return [submitHint, statusText, copyHint, keyHint("tui.select.cancel", "cancel")]
			.filter((part): part is string => part !== undefined)
			.join("  ");
	}

	private async copyAuthUrl(): Promise<void> {
		const url = this.authUrl;
		const actions = this.authActions;
		if (!url || !actions) return;

		try {
			await copyToClipboard(url);
			if (this.authUrl === url && this.authActions === actions) {
				actions.setText(this.getAuthActionsText("copied"));
				this.tui.requestRender();
			}
		} catch {
			if (this.authUrl === url && this.authActions === actions) {
				actions.setText(this.getAuthActionsText("failed"));
				this.tui.requestRender();
			}
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (
			this.authUrl &&
			kb.matches(data, "app.clipboard.copyLoginUrl") &&
			(!this.inputVisible || !isPrintableInput(data))
		) {
			void this.copyAuthUrl();
			return;
		}

		// Left arrow acts as "back" like Esc. While the editable field is actually
		// shown, only treat it as back at the start of the text so left still moves
		// the cursor mid-edit; on info/continue screens there is no field to guard.
		const backGuardInput = this.inputVisible ? this.input : undefined;
		if (kb.matches(data, "tui.select.cancel") || shouldTreatAsBack(data, backGuardInput)) {
			this.cancel();
			return;
		}

		if (this.continueResolver && kb.matches(data, "tui.select.confirm")) {
			const resolve = this.continueResolver;
			this.continueResolver = undefined;
			this.continueRejecter = undefined;
			resolve();
			return;
		}

		// Pass to input
		this.input.handleInput(data);
	}
}
