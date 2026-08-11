import {
	type Component,
	Container,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type AgentSessionMessage, formatAgentMessageParticipant } from "../../../core/agent-messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";

function collapseText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** `◆ <label> · <participant>[ · <preview>]` summary line shared by received and sent agent-message UI. */
export function agentMessageSummaryLine(label: string, participant: string, preview?: string): string {
	const parts = [`${theme.fg("accent", "◆")} ${theme.fg("muted", label)}`, theme.fg("muted", participant)];
	if (preview) {
		parts.push(theme.fg("muted", preview));
	}
	return parts.join(theme.fg("dim", " · "));
}

/** Single-line message preview sized to fit after the summary-line prefix. */
export function agentMessagePreview(prefixWidth: number, message: string): string {
	return truncateToWidth(collapseText(message), Math.max(20, 100 - prefixWidth));
}

/** `╰─`-guttered message body lines shared by received and sent agent-message UI. */
export function agentMessageBodyLines(message: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const textWidth = Math.max(1, safeWidth - 4);
	const bodyLines = message.split("\n").flatMap((line) => {
		const wrapped = wrapTextWithAnsi(line, textWidth);
		return wrapped.length > 0 ? wrapped : [""];
	});
	return bodyLines.map((line, index) => {
		const prefix = index === 0 ? theme.fg("dim", "╰─ ") : "   ";
		return truncateToWidth(` ${prefix}${theme.fg("customMessageText", line)}`, safeWidth, "");
	});
}

class AgentMessageBodyComponent implements Component {
	constructor(private readonly message: string) {}

	render(width: number): string[] {
		return agentMessageBodyLines(this.message, width);
	}

	invalidate(): void {}
}

export class AgentMessageComponent extends Container {
	private readonly content = new Container();
	private readonly header = new Text("", 1, 0);
	private expanded = false;

	constructor(
		private readonly message: AgentSessionMessage,
		_markdownTheme: MarkdownTheme = getMarkdownTheme(),
		options: { suppressLeadingSpace?: boolean } = {},
	) {
		super();
		if (!options.suppressLeadingSpace) this.addChild(new Spacer(1));
		this.addChild(this.content);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.content.clear();
		this.header.setText(this.headerText());
		this.content.addChild(this.header);
		if (this.expanded) {
			this.content.addChild(new AgentMessageBodyComponent(this.message.details.message));
		}
	}

	private headerText(): string {
		const label = "Agent message received";
		const participant = formatAgentMessageParticipant(
			"received",
			this.message.details.fromRelationship,
			this.message.details.from,
		);
		const hint = expandCollapseHint("app.messages.expand", this.expanded);
		if (this.expanded) {
			return `${agentMessageSummaryLine(label, participant)} ${hint}`;
		}

		const prefixWidth = visibleWidth(`◆ ${label} · ${participant} · `);
		const preview = agentMessagePreview(prefixWidth, this.message.details.message);
		return `${agentMessageSummaryLine(label, participant, preview)} ${hint}`;
	}
}
