/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, ProviderPayload, TextContent } from "@earendil-works/pi-ai";
import type { AgentCronJob } from "./cron-jobs.js";
import { isSessionSlashCommandName, parseSessionSlashCommand, type SessionSlashCommand } from "./slash-commands.js";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export const HEARTBEAT_PROMPT_CUSTOM_TYPE = "heartbeat_prompt";
export const HEARTBEAT_PROMPT_PREVIEW_LABEL = "Heartbeat prompt";
export const IPYTHON_STATE_RESTORED_CUSTOM_TYPE = "ipython_state_restored";
export const SESSION_SLASH_COMMAND_CUSTOM_TYPE = "session_slash_command";
export const SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE = "session_slash_command_result";
export const COMPACTION_OUTCOME_CUSTOM_TYPE = "compaction_outcome";
export const RLM_CHILD_FAILURE_CUSTOM_TYPE = "rlm_child_failure";
export const RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE = "rlm_child_terminal_notice";

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

export function createRlmChildFailureMessage(
	details: RlmChildFailureDetails,
	timestamp = Date.now(),
): CustomMessage<RlmChildFailureDetails> {
	return {
		role: "custom",
		customType: RLM_CHILD_FAILURE_CUSTOM_TYPE,
		content: `RLM child ${details.sessionName} (${details.childId}) failed: ${details.error}`,
		display: true,
		details,
		timestamp,
	};
}

export function createRlmChildTerminalNoticeMessage(
	details: RlmChildTerminalNoticeDetails,
	timestamp = Date.now(),
): CustomMessage<RlmChildTerminalNoticeDetails> {
	const content =
		details.kind === "cancelled"
			? `RLM child ${details.sessionName} (${details.childId}) was cancelled${details.reason ? `: ${details.reason}` : ""}`
			: `RLM child ${details.sessionName} (${details.childId}) completed without sending a reply${details.lastAssistantTextPreview ? `. Last assistant text: ${details.lastAssistantTextPreview}` : ""}`;
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
	/** Provider-native history replayed instead of the display summary by a matching provider. */
	providerPayload?: ProviderPayload;
	/** User instructions that guided the summary (from `/compact <instructions>`) */
	customInstructions?: string;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
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
	providerPayload?: ProviderPayload,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		retainedMessageCount,
		providerPayload,
		customInstructions,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

export function createHeartbeatPromptMessage(
	job: AgentCronJob,
	timestamp = Date.now(),
): CustomMessage<HeartbeatPromptDetails> {
	return {
		role: "custom",
		customType: HEARTBEAT_PROMPT_CUSTOM_TYPE,
		content: job.prompt,
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
					// Skip messages excluded from context (!! prefix)
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
						m.customType === COMPACTION_OUTCOME_CUSTOM_TYPE
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
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						providerPayload: m.providerPayload,
						timestamp: m.timestamp,
					};
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
