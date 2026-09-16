/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentCronJob } from "./cron-jobs.js";
import {
	type AppliedRefinementEdit,
	formatRefinementNoticeBody,
	type HarnessScope,
	type RefinementResult,
} from "./refinement/refinement.js";
import { isSessionSlashCommandName, parseSessionSlashCommand, type SessionSlashCommand } from "./slash-commands.js";

export const COMPACTION_SUMMARY_PREFIX = `[compaction-summary]

The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `[branch-summary]

The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export const HEARTBEAT_PROMPT_CUSTOM_TYPE = "heartbeat_prompt";
export const HEARTBEAT_PROMPT_PREVIEW_LABEL = "Heartbeat prompt";
export const IPYTHON_STATE_RESTORED_CUSTOM_TYPE = "ipython_state_restored";
export const SESSION_SLASH_COMMAND_CUSTOM_TYPE = "session_slash_command";
export const SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE = "session_slash_command_result";
export const COMPACTION_OUTCOME_CUSTOM_TYPE = "compaction_outcome";
export const MCP_CONNECTION_OUTCOME_CUSTOM_TYPE = "mcp_connection_outcome";
export const REFINEMENT_OUTCOME_CUSTOM_TYPE = "refinement_outcome";
export const REFINEMENT_NOTICE_CUSTOM_TYPE = "refinement_notice";
export const HARNESS_DIGEST_CUSTOM_TYPE = "harness_digest";
export const RLM_CHILD_FAILURE_CUSTOM_TYPE = "rlm_child_failure";
export const RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE = "rlm_child_terminal_notice";
export const ASYNC_BASH_COMPLETION_CUSTOM_TYPE = "async_bash_completion";
export const ASYNC_BASH_COMPLETION_PREVIEW_LABEL = "Background command finished";

/**
 * Names and other metadata interpolated into a `[<kind> ...]` header line must not
 * carry the characters that delimit the header itself (brackets, newlines, commas,
 * or the relationship separator ":").
 */
export function sanitizeMessageHeaderValue(value: string): string {
	return value.replace(/[\s,:[\]]+/g, " ").trim();
}

export interface SessionSlashCommandDetails {
	command: SessionSlashCommand;
	commandEntryId?: string;
}

export interface SessionSlashCommandResultDetails {
	command: SessionSlashCommand;
	success: boolean;
	severity: "info" | "warning" | "error";
	error?: string;
	commandEntryId?: string;
}

export interface SessionSlashCommandMessage extends CustomMessage<SessionSlashCommandDetails> {
	customType: typeof SESSION_SLASH_COMMAND_CUSTOM_TYPE;
	content: string;
	details: SessionSlashCommandDetails;
}

export interface SessionSlashCommandResultMessage extends CustomMessage<SessionSlashCommandResultDetails> {
	customType: typeof SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE;
	content: string;
	details: SessionSlashCommandResultDetails;
}

export type CompactionOutcomeReason = "threshold" | "overflow" | "requested";
export type CompactionOutcome = "skipped" | "cancelled" | "failed";

export interface CompactionOutcomeDetails {
	reason: CompactionOutcomeReason;
	outcome: CompactionOutcome;
}

export interface CompactionOutcomeMessage extends CustomMessage<CompactionOutcomeDetails> {
	customType: typeof COMPACTION_OUTCOME_CUSTOM_TYPE;
	content: string;
	details: CompactionOutcomeDetails;
}

export interface RefinementOutcomeDetails {
	refinementId: string;
	summary: string;
	scope: HarnessScope;
	rollbackOf?: string;
	edits: AppliedRefinementEdit[];
}

export interface RefinementOutcomeMessage extends CustomMessage<RefinementOutcomeDetails> {
	customType: typeof REFINEMENT_OUTCOME_CUSTOM_TYPE;
	content: string;
	details: RefinementOutcomeDetails;
}

/** How a refinement was initiated: reviewer-triggered auto-refine, the /refine slash command, or the model's own refine.run(). */
export type RefinementSource = "auto" | "user" | "self";

export interface RefinementNoticeDetails extends RefinementOutcomeDetails {
	source: RefinementSource;
}

export interface RefinementNoticeMessage extends CustomMessage<RefinementNoticeDetails> {
	customType: typeof REFINEMENT_NOTICE_CUSTOM_TYPE;
	content: string;
	details: RefinementNoticeDetails;
}

/** How an MCP connection attempt finished: verified handshake, saved but unverified, or unrecorded result. */
export type McpConnectionVerificationState = "connected" | "unverified" | "unsaved";

/** Which flow produced the outcome: a completed login, an inline token paste, or a pending-account retry verification. */
export type McpConnectionOutcomeSource = "login" | "paste" | "retry";

/** Whether the saved connection change is live in the current session. */
export type McpConnectionActivationState = "active" | "inactive";

export interface McpConnectionOutcomeDetails {
	/** Absent on entries written before disconnect outcomes existed; both mean "connect". */
	kind?: "connect";
	/** Display label the outcome line names, e.g. "Linear" or "Acme (acme-2)". */
	label: string;
	source: McpConnectionOutcomeSource;
	verification: McpConnectionVerificationState;
	/** Tools verified by the MCP handshake; present only when verification is "connected". */
	toolCount?: number;
	/** Human-readable reason the handshake did not complete; present only when verification is "unverified". */
	issue?: string;
	/** Probe error category behind `issue` (e.g. "http-unauthorized"), so the renderer can name the fix. */
	issueCategory?: string;
	/** Account connection id when the outcome is account-scoped. */
	connectionId?: string;
	/** True when the login added a new account to a multi-account service. */
	addedAccount?: boolean;
	/** Whether the saved change is live in this session; absent until activation resolves. */
	activation?: McpConnectionActivationState;
}

/**
 * How a disconnect finished. Only outcomes that actually removed the stored
 * credential are representable: a failed or partial removal never gets a
 * durable "Disconnected" entry.
 */
export type McpDisconnectionState = "removed" | "credential-only" | "preserved";

export interface McpDisconnectionOutcomeDetails {
	kind: "disconnect";
	/** Display label the outcome line names, e.g. "Granola" or "account acme-2". */
	label: string;
	removal: McpDisconnectionState;
	/** Account connection id when the outcome is account-scoped. */
	connectionId?: string;
	/** Whether the saved change is live in this session; absent until activation resolves. */
	activation?: McpConnectionActivationState;
}

/** Either side of the MCP connection lifecycle, carried by one durable entry type. */
export type McpOutcomeDetails = McpConnectionOutcomeDetails | McpDisconnectionOutcomeDetails;

/** Connect details predate the disconnect entry, so a missing `kind` means "connect". */
export function isMcpDisconnectionOutcome(details: McpOutcomeDetails): details is McpDisconnectionOutcomeDetails {
	return (details as Partial<McpDisconnectionOutcomeDetails>).kind === "disconnect";
}

export interface McpConnectionOutcomeMessage extends CustomMessage<McpOutcomeDetails> {
	customType: typeof MCP_CONNECTION_OUTCOME_CUSTOM_TYPE;
	content: string;
	details: McpOutcomeDetails;
}

export interface HarnessDigestDetails {
	digest: string;
	/** Fingerprint of the harness state at delivery time; cold boundaries skip re-delivery when it still matches. */
	stateFingerprint?: string;
}

export const HARNESS_DIGEST_PREFIX = `[harness-digest]

The persistent memories produced across this session so far:

<harness_state>
`;

export const HARNESS_DIGEST_SUFFIX = `
</harness_state>`;

export function createHarnessDigestMessage(
	digest: string,
	timestamp = Date.now(),
	stateFingerprint?: string,
): CustomMessage<HarnessDigestDetails> {
	return {
		role: "custom",
		customType: HARNESS_DIGEST_CUSTOM_TYPE,
		content: HARNESS_DIGEST_PREFIX + digest + HARNESS_DIGEST_SUFFIX,
		display: false,
		details: { digest, ...(stateFingerprint ? { stateFingerprint } : {}) },
		timestamp,
	};
}

export interface RlmChildFailureDetails {
	childId: string;
	sessionName: string;
	error: string;
}

export type RlmChildTerminalNoticeDetails =
	| {
			kind: "cancelled";
			childId: string;
			sessionName: string;
			reason?: string;
	  }
	| {
			kind: "completed_without_reply";
			childId: string;
			sessionName: string;
			lastAssistantTextPreview?: string;
	  };

export interface AsyncBashCompletionDetails {
	pid: number;
	command: string;
	exitCode: number;
}

interface AsyncBashCompletionMessage extends CustomMessage<AsyncBashCompletionDetails> {
	customType: typeof ASYNC_BASH_COMPLETION_CUSTOM_TYPE;
	content: string;
}

export function createAsyncBashCompletionMessage(
	details: AsyncBashCompletionDetails,
	timestamp = Date.now(),
): AsyncBashCompletionMessage {
	return {
		role: "custom",
		customType: ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
		content: `[bash-done pid:${details.pid} exit:${details.exitCode}]

Command: ${JSON.stringify(details.command)}`,
		display: true,
		details,
		timestamp,
	};
}

export function createRlmChildFailureMessage(
	details: RlmChildFailureDetails,
	timestamp = Date.now(),
): CustomMessage<RlmChildFailureDetails> {
	return {
		role: "custom",
		customType: RLM_CHILD_FAILURE_CUSTOM_TYPE,
		content: `[child-failed child:${sanitizeMessageHeaderValue(details.sessionName)}]

${details.error}`,
		display: true,
		details,
		timestamp,
	};
}

export function createRlmChildTerminalNoticeMessage(
	details: RlmChildTerminalNoticeDetails,
	timestamp = Date.now(),
): CustomMessage<RlmChildTerminalNoticeDetails> {
	const childName = sanitizeMessageHeaderValue(details.sessionName);
	const content =
		details.kind === "cancelled"
			? `[child-exited: cancelled child:${childName}]${details.reason ? `\n\n${details.reason}` : ""}`
			: `[child-exited: no-reply child:${childName}]${details.lastAssistantTextPreview ? `\n\nLast assistant text: ${details.lastAssistantTextPreview}` : ""}`;
	return {
		role: "custom",
		customType: RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
		content,
		display: true,
		details,
		timestamp,
	};
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface HeartbeatPromptDetails {
	jobId: string;
	schedule: string;
	status: AgentCronJob["status"];
	runCount: number;
	nextRunAt?: string;
	lastRunAt?: string;
}

export interface IpythonStateRestoredDetails {
	restored: boolean;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	/** Number of retained messages that precede this summary in transcript presentation. */
	retainedMessageCount?: number;
	/** User instructions that guided the summary (from `/compact <instructions>`) */
	customInstructions?: string;
	/** Harness digest snapshot rendered before the summary in LLM context. Attached mechanically at compaction, never summarized. */
	harnessDigest?: string;
	/** Fingerprint of the harness state behind `harnessDigest` at compaction time; lets cold boundaries skip re-delivery. */
	harnessStateFingerprint?: string;
	timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Format bash output for LLM context. The fence must be longer than any
 * backtick run in the output so command output cannot terminate it early.
 */
export function bashOutputToText(
	msg: Pick<BashExecutionMessage, "output" | "exitCode" | "cancelled" | "truncated" | "fullOutputPath">,
): string {
	let text = "";
	if (msg.output) {
		let longestBacktickRun = 0;
		for (const match of msg.output.matchAll(/`+/g)) {
			longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
		}
		const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
		text += `${fence}\n${msg.output}\n${fence}`;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated) {
		text += msg.fullOutputPath
			? `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`
			: "\n\n[Output truncated.]";
	}
	return text;
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	return `Ran \`${msg.command}\`\n${bashOutputToText(msg)}`;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	customInstructions?: string,
	retainedMessageCount?: number,
	harnessDigest?: string,
	harnessStateFingerprint?: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		retainedMessageCount,
		customInstructions,
		harnessDigest,
		harnessStateFingerprint,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createSessionSlashCommandMessage(
	command: SessionSlashCommand,
	details: Omit<SessionSlashCommandDetails, "command"> = {},
	display = true,
	timestamp = Date.now(),
): SessionSlashCommandMessage {
	return {
		role: "custom",
		customType: SESSION_SLASH_COMMAND_CUSTOM_TYPE,
		content: command.text,
		display,
		details: { ...details, command: { ...command } },
		timestamp,
	};
}

export function createSessionSlashCommandResultMessage(
	content: string,
	details: SessionSlashCommandResultDetails,
	display = true,
	timestamp = Date.now(),
): SessionSlashCommandResultMessage {
	return {
		role: "custom",
		customType: SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
		content,
		display,
		details: { ...details, command: { ...details.command } },
		timestamp,
	};
}

export function createCompactionOutcomeMessage(
	content: string,
	details: CompactionOutcomeDetails,
	display = true,
	timestamp = Date.now(),
): CompactionOutcomeMessage {
	return {
		role: "custom",
		customType: COMPACTION_OUTCOME_CUSTOM_TYPE,
		content,
		display,
		details: { ...details },
		timestamp,
	};
}

export function createRefinementOutcomeMessage(
	result: RefinementResult,
	display = true,
	timestamp = Date.now(),
): RefinementOutcomeMessage {
	return {
		role: "custom",
		customType: REFINEMENT_OUTCOME_CUSTOM_TYPE,
		content: `Refinement complete: ${result.summary}`,
		display,
		details: {
			refinementId: result.id,
			summary: result.summary,
			scope: result.scope ?? "local",
			...(result.rollbackOf ? { rollbackOf: result.rollbackOf } : {}),
			edits: result.appliedEdits,
		},
		timestamp,
	};
}

/** Model-facing refinement notice: passes convertToLlm (unlike the refinement_outcome audit entry); display false because the TUI renders the outcome message. */
export function createRefinementNoticeMessage(
	result: RefinementResult,
	source: RefinementSource,
	timestamp = Date.now(),
): RefinementNoticeMessage {
	return {
		role: "custom",
		customType: REFINEMENT_NOTICE_CUSTOM_TYPE,
		content: `[${source}-refinement]\n\n${formatRefinementNoticeBody(result)}`,
		display: false,
		details: {
			refinementId: result.id,
			summary: result.summary,
			scope: result.scope ?? "local",
			...(result.rollbackOf ? { rollbackOf: result.rollbackOf } : {}),
			edits: result.appliedEdits,
			source,
		},
		timestamp,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The saved-but-not-live tail every outcome line shares. */
function activationSuffix(details: McpOutcomeDetails): string {
	return details.activation === "inactive" ? " The change remains saved, but it is not active in this session." : "";
}

/** Plain-text outcome line for a completed MCP disconnect. */
function formatMcpDisconnectionNotice(details: McpDisconnectionOutcomeDetails): string {
	const suffix = activationSuffix(details);
	switch (details.removal) {
		case "removed":
			return `Disconnected ${details.label}.${suffix}`;
		case "credential-only":
			return `Disconnected ${details.label}. No saved connection entry existed; the stored credential was removed.${suffix}`;
		case "preserved":
			return `Disconnected ${details.label}. The saved connection entry was kept and now shows as not connected.${suffix}`;
	}
}

/**
 * Plain-text outcome line for an MCP connect or disconnect. This is the
 * durable wording the flows already reported: it is what the entry persists as
 * `content` and what the transient fallback shows, so it stays a full sentence
 * even where the rendered entry splits it into a header and a detail line.
 */
export function formatMcpConnectionOutcomeNotice(details: McpOutcomeDetails): string {
	if (isMcpDisconnectionOutcome(details)) return formatMcpDisconnectionNotice(details);
	const prefix =
		details.source === "login" && details.addedAccount === true && details.connectionId
			? `Added account ${details.connectionId}. `
			: "";
	const suffix = activationSuffix(details);
	switch (details.verification) {
		case "connected":
			return `${prefix}Connected ${details.label}${
				details.toolCount !== undefined ? ` (${details.toolCount} tools verified)` : ""
			}.${suffix}`;
		case "unverified":
			if (details.source === "retry") {
				return `Verification did not complete: ${details.issue}. The connection is saved; retry from /plugins.${suffix}`;
			}
			if (details.source === "paste") {
				// No login happened: the user pasted a token. "Login succeeded"
				// would be a false claim here.
				return `Token saved for ${details.label}, but connection verification did not complete: ${details.issue}. The connection is saved; retry from /plugins.${suffix}`;
			}
			return `${prefix}Login succeeded for ${details.label}, but connection verification did not complete: ${details.issue}. The connection is saved; retry from /plugins.${suffix}`;
		case "unsaved":
			if (details.source === "retry") {
				return `The verification result could not be saved. The connection is saved; retry from /plugins.${suffix}`;
			}
			if (details.source === "paste") {
				return `Token saved for ${details.label}, but the verification result could not be saved. The connection is saved; retry from /plugins.${suffix}`;
			}
			return `${prefix}Login succeeded for ${details.label}, but the verification result could not be saved. The connection is saved; retry from /plugins.${suffix}`;
	}
}

export function createMcpConnectionOutcomeMessage(
	details: McpOutcomeDetails,
	display = true,
	timestamp = Date.now(),
): McpConnectionOutcomeMessage {
	return {
		role: "custom",
		customType: MCP_CONNECTION_OUTCOME_CUSTOM_TYPE,
		content: formatMcpConnectionOutcomeNotice(details),
		display,
		details: { ...details },
		timestamp,
	};
}

function hasValidCustomMessageEnvelope(message: Record<string, unknown>, customType: string): boolean {
	return (
		message.role === "custom" &&
		message.customType === customType &&
		typeof message.content === "string" &&
		typeof message.display === "boolean" &&
		typeof message.timestamp === "number" &&
		Number.isFinite(message.timestamp)
	);
}

export function isSessionSlashCommand(value: unknown): value is SessionSlashCommand {
	if (
		!isRecord(value) ||
		!isSessionSlashCommandName(value.name) ||
		typeof value.args !== "string" ||
		typeof value.text !== "string"
	) {
		return false;
	}
	const parsed = parseSessionSlashCommand(value.text);
	return (
		parsed !== undefined && parsed.name === value.name && parsed.args === value.args && parsed.text === value.text
	);
}

function isValidCommandEntryId(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === "string" && value.length > 0);
}

export function isSessionSlashCommandMessage(message: unknown): message is SessionSlashCommandMessage {
	if (
		!isRecord(message) ||
		!hasValidCustomMessageEnvelope(message, SESSION_SLASH_COMMAND_CUSTOM_TYPE) ||
		typeof message.content !== "string"
	) {
		return false;
	}
	if (!isRecord(message.details) || !isSessionSlashCommand(message.details.command)) return false;
	return message.content === message.details.command.text && isValidCommandEntryId(message.details.commandEntryId);
}

export function isSessionSlashCommandResultMessage(message: unknown): message is SessionSlashCommandResultMessage {
	if (!isRecord(message) || !hasValidCustomMessageEnvelope(message, SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE))
		return false;
	if (!isRecord(message.details) || !isSessionSlashCommand(message.details.command)) return false;
	return (
		typeof message.details.success === "boolean" &&
		(message.details.severity === "info" ||
			message.details.severity === "warning" ||
			message.details.severity === "error") &&
		(message.details.error === undefined || typeof message.details.error === "string") &&
		isValidCommandEntryId(message.details.commandEntryId)
	);
}

export function isCompactionOutcomeMessage(message: unknown): message is CompactionOutcomeMessage {
	if (!isRecord(message) || !hasValidCustomMessageEnvelope(message, COMPACTION_OUTCOME_CUSTOM_TYPE)) return false;
	if (!isRecord(message.details)) return false;
	return (
		(message.details.reason === "threshold" ||
			message.details.reason === "overflow" ||
			message.details.reason === "requested") &&
		(message.details.outcome === "skipped" ||
			message.details.outcome === "cancelled" ||
			message.details.outcome === "failed")
	);
}

function isAppliedRefinementEdit(value: unknown): value is AppliedRefinementEdit {
	return (
		isRecord(value) &&
		(value.action === "create" || value.action === "update" || value.action === "delete") &&
		typeof value.kind === "string" &&
		typeof value.id === "string" &&
		typeof value.applied === "boolean"
	);
}

export function isRefinementOutcomeMessage(message: unknown): message is RefinementOutcomeMessage {
	if (!isRecord(message) || !hasValidCustomMessageEnvelope(message, REFINEMENT_OUTCOME_CUSTOM_TYPE)) return false;
	if (!isRecord(message.details)) return false;
	return (
		typeof message.details.summary === "string" &&
		(message.details.scope === "local" || message.details.scope === "global") &&
		Array.isArray(message.details.edits) &&
		message.details.edits.every(isAppliedRefinementEdit)
	);
}

function isValidMcpActivation(activation: unknown): boolean {
	return activation === undefined || activation === "active" || activation === "inactive";
}

function isValidMcpDisconnectionDetails(details: Record<string, unknown>): boolean {
	return (
		typeof details.label === "string" &&
		(details.removal === "removed" || details.removal === "credential-only" || details.removal === "preserved") &&
		(details.connectionId === undefined || typeof details.connectionId === "string") &&
		isValidMcpActivation(details.activation)
	);
}

export function isMcpConnectionOutcomeMessage(message: unknown): message is McpConnectionOutcomeMessage {
	if (!isRecord(message) || !hasValidCustomMessageEnvelope(message, MCP_CONNECTION_OUTCOME_CUSTOM_TYPE)) return false;
	if (!isRecord(message.details)) return false;
	if (message.details.kind === "disconnect") return isValidMcpDisconnectionDetails(message.details);
	return (
		(message.details.kind === undefined || message.details.kind === "connect") &&
		typeof message.details.label === "string" &&
		(message.details.source === "login" ||
			message.details.source === "retry" ||
			message.details.source === "paste") &&
		(message.details.verification === "connected" ||
			message.details.verification === "unverified" ||
			message.details.verification === "unsaved") &&
		(message.details.toolCount === undefined ||
			(typeof message.details.toolCount === "number" && Number.isInteger(message.details.toolCount))) &&
		(message.details.issue === undefined || typeof message.details.issue === "string") &&
		(message.details.issueCategory === undefined || typeof message.details.issueCategory === "string") &&
		(message.details.connectionId === undefined || typeof message.details.connectionId === "string") &&
		(message.details.addedAccount === undefined || typeof message.details.addedAccount === "boolean") &&
		isValidMcpActivation(message.details.activation)
	);
}

export interface HeartbeatPromptMessage extends CustomMessage<HeartbeatPromptDetails> {
	customType: typeof HEARTBEAT_PROMPT_CUSTOM_TYPE;
	content: string;
}

export function createHeartbeatPromptMessage(job: AgentCronJob, timestamp = Date.now()): HeartbeatPromptMessage {
	return {
		role: "custom",
		customType: HEARTBEAT_PROMPT_CUSTOM_TYPE,
		content: `[heartbeat: ${sanitizeMessageHeaderValue(job.schedule.expression)} run#${job.runCount}]\n\n${job.prompt}`,
		display: true,
		details: {
			jobId: job.id,
			schedule: job.schedule.expression,
			status: job.status,
			runCount: job.runCount,
			nextRunAt: job.nextRunAt,
			lastRunAt: job.lastRunAt,
		},
		timestamp,
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					if (
						m.customType === SESSION_SLASH_COMMAND_CUSTOM_TYPE ||
						m.customType === SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE ||
						m.customType === COMPACTION_OUTCOME_CUSTOM_TYPE ||
						m.customType === MCP_CONNECTION_OUTCOME_CUSTOM_TYPE ||
						m.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE
					) {
						return undefined;
					}
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary": {
					const digestBlock = m.harnessDigest
						? `${HARNESS_DIGEST_PREFIX}${m.harnessDigest}${HARNESS_DIGEST_SUFFIX}\n\n`
						: "";
					return {
						role: "user",
						content: [
							{
								type: "text" as const,
								text: digestBlock + COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX,
							},
						],
						timestamp: m.timestamp,
					};
				}
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
