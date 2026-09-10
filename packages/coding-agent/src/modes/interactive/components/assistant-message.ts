import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { LOGIN_RECOVERY_MESSAGE } from "../../../core/auth-guidance.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import {
	CollapsibleErrorComponent,
	normalizeErrorDetails,
	shouldCollapseErrorDetails,
	summarizeErrorDetails,
} from "./collapsible-error.js";
import { keyText } from "./keybinding-hints.js";
import type { MermaidMarkdownTransform } from "./mermaid.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const LOGIN_RECOVERY_SUFFIX = `\n\n${LOGIN_RECOVERY_MESSAGE}`;

export interface AssistantMessageComponentOptions {
	cwd?: string;
	expanded?: boolean;
	precededByToolActivity?: boolean;
	/** Replaces Mermaid code blocks in assistant text (never thinking) with Unicode diagrams. */
	mermaidTransform?: MermaidMarkdownTransform;
}

function getThinkingMarkdownTheme(baseTheme: MarkdownTheme): MarkdownTheme {
	const quiet = (text: string) => theme.fg("dim", text);
	return {
		...baseTheme,
		heading: quiet,
		link: quiet,
		linkUrl: quiet,
		code: quiet,
		codeBlock: quiet,
		codeBlockBorder: quiet,
		quote: quiet,
		quoteBorder: quiet,
		hr: quiet,
		listBullet: quiet,
		highlightCode: (code: string) => code.split("\n").map((line) => quiet(line)),
	};
}

function formatInlineLoginRecoveryMessage(message: string): string | undefined {
	const normalized = normalizeErrorDetails(message);
	if (!normalized.endsWith(LOGIN_RECOVERY_SUFFIX)) {
		return undefined;
	}
	const base = normalized.slice(0, -LOGIN_RECOVERY_SUFFIX.length).trimEnd();
	if (!base || shouldCollapseErrorDetails(base)) {
		return undefined;
	}
	return `${base} · ${LOGIN_RECOVERY_MESSAGE}`;
}

/**
 * Component that renders a complete assistant message.
 *
 * Streaming sends one updateContent() per token, so content updates are
 * reconciled lazily at render time (at most once per frame): when the block
 * structure is unchanged, only the text of changed blocks is updated in place,
 * preserving each Markdown child's render cache instead of rebuilding the tree.
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private expanded = false;
	private dirty = false;
	private lastSignature?: string;
	private blockMarkdowns = new Map<number, Markdown>();
	private lastBlockTexts = new Map<number, string>();
	private precededByToolActivity: boolean;
	private mermaidTransform?: MermaidMarkdownTransform;
	private baseUrl?: string;
	private isStreaming = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking:",
		options: AssistantMessageComponentOptions = {},
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.expanded = options.expanded ?? false;
		this.precededByToolActivity = options.precededByToolActivity ?? false;
		this.mermaidTransform = options.mermaidTransform;
		this.baseUrl = options.cwd ? pathToFileURL(`${resolve(options.cwd)}${sep}`).href : undefined;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		// Force a full rebuild so theme-dependent children are recreated.
		this.lastSignature = undefined;
		this.dirty = true;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.dirty = true;
	}

	/** True when the message carries a non-empty thinking block (drives the reveal toggle). */
	hasThinkingContent(): boolean {
		return (this.lastMessage?.content ?? []).some((c) => c?.type === "thinking" && c.thinking.trim());
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		this.dirty = true;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			this.dirty = true;
		}
	}

	override render(width: number): string[] {
		if (this.dirty) {
			if (this.lastMessage) {
				this.reconcile(this.lastMessage);
			}
			this.dirty = false;
		}
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.dirty = true;
	}

	/**
	 * Everything that affects child component identity/order, but not the text
	 * inside a block. While the signature is stable, updates reduce to setText()
	 * on changed blocks; any structural change triggers a full rebuild.
	 */
	private computeSignature(message: AssistantMessage): string {
		const parts: string[] = [];
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content?.type === "text") {
				parts.push(`${i}:text:${content.text.trim() ? 1 : 0}`);
			} else if (content?.type === "thinking") {
				parts.push(`${i}:thinking:${content.thinking.trim() ? 1 : 0}`);
			} else {
				parts.push(`${i}:${content?.type ?? "invalid"}`);
			}
		}
		parts.push(
			`hide:${this.hideThinkingBlock}`,
			`label:${this.hiddenThinkingLabel}`,
			`expanded:${this.expanded}`,
			// In the signature so the streaming->final transition rebuilds (mermaid renders differently).
			`streaming:${this.isStreaming}`,
			`stop:${message.stopReason ?? ""}`,
			`error:${message.errorMessage ?? ""}`,
		);
		return parts.join("|");
	}

	private reconcile(message: AssistantMessage): void {
		const signature = this.computeSignature(message);
		if (signature !== this.lastSignature) {
			this.lastSignature = signature;
			this.rebuild(message);
			return;
		}

		// Structure unchanged: update only blocks whose text changed (during
		// streaming that is just the final block).
		for (let i = 0; i < message.content.length; i++) {
			const markdown = this.blockMarkdowns.get(i);
			if (!markdown) {
				continue;
			}
			const content = message.content[i];
			const text =
				content?.type === "text"
					? content.text.trim()
					: content?.type === "thinking"
						? content.thinking.trim()
						: "";
			if (this.lastBlockTexts.get(i) !== text) {
				markdown.setText(text);
				this.lastBlockTexts.set(i, text);
			}
		}
	}

	private rebuild(message: AssistantMessage): void {
		// Clear content container
		this.contentContainer.clear();
		this.blockMarkdowns.clear();
		this.lastBlockTexts.clear();

		const hasVisibleContent = message.content.some(
			(c) =>
				(c?.type === "text" && c.text.trim()) ||
				(c?.type === "thinking" && !this.hideThinkingBlock && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content?.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const mermaidTransform = this.mermaidTransform;
				const isStreaming = this.isStreaming;
				const markdown = new Markdown(
					content.text.trim(),
					1,
					0,
					this.markdownTheme,
					{
						color: (text: string) => theme.fg("mdBody", text),
					},
					{
						baseUrl: this.baseUrl,
						transform:
							mermaidTransform && ((md, availableWidth) => mermaidTransform(md, availableWidth, isStreaming)),
					},
				);
				this.blockMarkdowns.set(i, markdown);
				this.lastBlockTexts.set(i, content.text.trim());
				this.contentContainer.addChild(markdown);
			} else if (content?.type === "thinking" && content.thinking.trim()) {
				// Hidden thinking renders nothing at all; the working loader in the
				// tray is the activity signal while the rows are hidden.
				if (!this.hideThinkingBlock) {
					// Revealed: the label line with the hide hint, then the quiet trace.
					// Add spacing only when another visible assistant content block follows.
					const hasVisibleContentAfter = message.content
						.slice(i + 1)
						.some((c) => (c?.type === "text" && c.text.trim()) || (c?.type === "thinking" && c.thinking.trim()));

					const thinkingLabel = theme.fg("thinkingText", this.hiddenThinkingLabel);
					this.contentContainer.addChild(
						new Text(`${thinkingLabel} ${theme.fg("dim", `(${keyText("app.thinking.toggle")} to hide)`)}`, 1, 0),
					);
					const markdown = new Markdown(
						content.thinking.trim(),
						1,
						0,
						getThinkingMarkdownTheme(this.markdownTheme),
						{
							color: (text: string) => theme.fg("dim", text),
						},
						{ baseUrl: this.baseUrl },
					);
					this.blockMarkdowns.set(i, markdown);
					this.lastBlockTexts.set(i, content.thinking.trim());
					this.contentContainer.addChild(markdown);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		const hasToolCalls = message.content.some((c) => c?.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "aborted") {
			const abortMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(this.createErrorComponent(abortMessage));
		} else if (!hasToolCalls && message.stopReason === "error") {
			const errorMsg = message.errorMessage || "Unknown error";
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(this.createErrorComponent(errorMsg, "Error"));
		}

		if (hasToolCalls && (hasVisibleContent || message.stopReason === "aborted" || !this.precededByToolActivity)) {
			this.contentContainer.addChild(new Spacer(1));
		}
	}

	private createErrorComponent(message: string, prefix?: string): Component {
		const inlineLoginRecovery = formatInlineLoginRecoveryMessage(message);
		if (inlineLoginRecovery) {
			const text = prefix ? `${prefix}: ${inlineLoginRecovery}` : inlineLoginRecovery;
			return new Text(theme.fg("error", text), 1, 0);
		}

		if (!shouldCollapseErrorDetails(message)) {
			const text = prefix ? `${prefix}: ${message}` : message;
			return new Text(theme.fg("error", text), 1, 0);
		}

		const text = prefix ? `${prefix}: ${message}` : message;
		const summary = prefix ? `${prefix}: ${summarizeErrorDetails(message)}` : summarizeErrorDetails(message);
		return new CollapsibleErrorComponent({
			text,
			summary,
			expanded: this.expanded,
		});
	}
}
