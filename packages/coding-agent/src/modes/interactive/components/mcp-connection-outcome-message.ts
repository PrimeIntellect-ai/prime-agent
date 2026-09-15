import { Spacer, Text } from "@earendil-works/pi-tui";
import {
	isMcpDisconnectionOutcome,
	type McpConnectionOutcomeMessage,
	type McpDisconnectionOutcomeDetails,
	type McpOutcomeDetails,
} from "../../../core/messages.js";
import { theme } from "../theme/theme.js";
import { ExpandableEventMessage } from "./expandable-event-message.js";

function outcomeHeader(details: McpOutcomeDetails): string {
	if (isMcpDisconnectionOutcome(details)) return `Disconnected ${details.label}`;
	const { label, verification, toolCount } = details;
	switch (verification) {
		case "connected":
			return `Connected ${label}${toolCount !== undefined ? ` · ${toolCount} tools verified` : ""}`;
		case "unverified":
			return `Verification did not complete · ${label} saved`;
		case "unsaved":
			return `Verification result not recorded · ${label} saved`;
	}
}

function capitalize(sentence: string): string {
	return sentence.length > 0 ? `${sentence[0]!.toUpperCase()}${sentence.slice(1)}` : sentence;
}

function disconnectionDetail(details: McpDisconnectionOutcomeDetails): string | undefined {
	switch (details.removal) {
		case "removed":
			return undefined;
		case "credential-only":
			return "No saved connection entry existed; the stored credential was removed.";
		case "preserved":
			return "The saved connection entry was kept and now shows as not connected.";
	}
}

/**
 * The detail the header does NOT already say. The header is the outcome
 * sentence, so the body carries only what it leaves out (added account, issue,
 * next step, deferred activation) and is omitted entirely for a plain success.
 */
function outcomeBody(details: McpOutcomeDetails): string | undefined {
	const parts: string[] = [];
	if (isMcpDisconnectionOutcome(details)) {
		const detail = disconnectionDetail(details);
		if (detail) parts.push(detail);
	} else {
		if (details.addedAccount === true && details.connectionId) parts.push(`Added account ${details.connectionId}.`);
		if (details.verification === "unverified")
			parts.push(details.issue ? `${capitalize(details.issue)}. Retry from /plugins.` : "Retry from /plugins.");
		if (details.verification === "unsaved") parts.push("Retry verification from /plugins.");
	}
	if (details.activation === "inactive") parts.push("The change remains saved, but it is not active in this session.");
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function outcomeMetadata(details: McpOutcomeDetails): string {
	const activation =
		details.activation === "inactive" ? "saved, but not active in this session" : "active in this session";
	const origin = isMcpDisconnectionOutcome(details)
		? disconnectionOrigin(details)
		: details.source === "retry"
			? "retry verification"
			: details.source === "paste"
				? "paste flow"
				: "login flow";
	return [origin, ...(details.connectionId ? [`account ${details.connectionId}`] : []), activation].join(" · ");
}

function disconnectionOrigin(details: McpDisconnectionOutcomeDetails): string {
	switch (details.removal) {
		case "removed":
			return "account removed";
		case "credential-only":
			return "credential removed";
		case "preserved":
			return "entry kept, credential removed";
	}
}

/**
 * Durable MCP connect/disconnect outcome: the header states the outcome, the
 * body adds only what the header omits, and the metadata line is the toggle.
 * Disconnects use the muted key rather than the connect purple (a disconnect
 * is no refinement) or the error red (it succeeded) — the same grey /plugins
 * already uses for "Not connected".
 */
export class McpConnectionOutcomeMessageComponent extends ExpandableEventMessage {
	constructor(private readonly message: McpConnectionOutcomeMessage) {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		const { details } = this.message;
		const disconnect = isMcpDisconnectionOutcome(details);
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg(disconnect ? "muted" : "refinementHeader", `◆ ${outcomeHeader(details)}`), 1, 0));
		const body = outcomeBody(details);
		if (body) this.addSummary(body, undefined, disconnect ? "dim" : "refinementSummary");
		if (this.expanded) {
			this.addChild(new Text(theme.fg("dim", outcomeMetadata(details)), 1, 0));
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
