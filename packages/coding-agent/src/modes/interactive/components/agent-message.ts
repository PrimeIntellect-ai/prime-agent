import {
	type Component,
	Container,
	type MarkdownTheme,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type AgentSessionMessage, formatAgentMessageParticipant } from "../../../core/agent-messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/** `◆ <label> · <participant>[ · <preview>]` summary line shared by received and sent agent-message UI. */
export function agentMessageSummaryLine(label: string, participant: string, preview?: string): string {
	const parts = [`${theme.fg("accent", "◆")} ${theme.fg("muted", label)}`, theme.fg("dim", participant)];
	if (preview) {
		parts.push(theme.fg("dim", preview));
	}
	return parts.join(theme.fg("dim", " · "));
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
	private readonly suppressLeadingSpace: boolean;
	private readonly shouldAddLeadingSpace?: (expanded: boolean) => boolean;
	private expanded = false;

	constructor(
		private readonly message: AgentSessionMessage,
		_markdownTheme: MarkdownTheme = getMarkdownTheme(),
		options: { suppressLeadingSpace?: boolean; shouldAddLeadingSpace?: (expanded: boolean) => boolean } = {},
	) {
		super();
		this.suppressLeadingSpace = options.suppressLeadingSpace ?? false;
		this.shouldAddLeadingSpace = options.shouldAddLeadingSpace;
		this.addChild(this.content);
		this.updateDisplay();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const leadingSpace = this.shouldAddLeadingSpace?.(this.expanded) ?? !this.suppressLeadingSpace;
		return leadingSpace ? ["", ...lines] : lines;
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
		return agentMessageSummaryLine(label, participant);
	}
}
