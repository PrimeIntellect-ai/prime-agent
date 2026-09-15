import { Spacer, Text } from "@earendil-works/pi-tui";
import { formatMcpConnectionOutcomeNotice, type McpConnectionOutcomeMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";
import { ExpandableEventMessage } from "./expandable-event-message.js";

function outcomeHeader(message: McpConnectionOutcomeMessage): string {
	const { label, verification, toolCount } = message.details;
	switch (verification) {
		case "connected":
			return `Connected ${label}${toolCount !== undefined ? ` · ${toolCount} tools verified` : ""}`;
		case "unverified":
			return `Verification did not complete · ${label} saved`;
		case "unsaved":
			return `Verification result not recorded · ${label} saved`;
	}
}

function outcomeMetadata(message: McpConnectionOutcomeMessage): string {
	const { source, connectionId, activation } = message.details;
	const parts = [
		source === "retry" ? "retry verification" : "login flow",
		...(connectionId ? [`account ${connectionId}`] : []),
		activation === "inactive" ? "saved, but not active in this session" : "active in this session",
	];
	return parts.join(" · ");
}

/** Durable MCP connect outcome: compact header, full wording as the body. */
export class McpConnectionOutcomeMessageComponent extends ExpandableEventMessage {
	constructor(private readonly message: McpConnectionOutcomeMessage) {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("refinementHeader", `◆ ${outcomeHeader(this.message)}`), 1, 0));
		this.addSummary(formatMcpConnectionOutcomeNotice(this.message.details), undefined, "refinementSummary");
		if (this.expanded) {
			this.addChild(new Text(theme.fg("dim", outcomeMetadata(this.message)), 1, 0));
		}
	}
}

export class MalformedMcpConnectionOutcomeMessageComponent extends ExpandableEventMessage {
	constructor() {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("error", "[Malformed MCP connection outcome message]"), 1, 0));
	}
}
