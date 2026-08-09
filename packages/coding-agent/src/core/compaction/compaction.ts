/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, ProviderNativeCompactionResult, Usage } from "@earendil-works/pi-ai";
import { compact as compactProvider, completeSimple } from "@earendil-works/pi-ai";
import {
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.js";
import {
	buildSessionContext,
	type CompactionEntry,
	canReplayCompactionWithProvider,
	type SessionEntry,
} from "../session-manager.js";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessages,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
	serializePromptData,
} from "./utils.js";
/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
/** Preserve file operations recorded by prior compactions and current tool calls. */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Record only direct edit calls with successful matching results.
	extractFileOpsFromMessages(messages, fileOps);

	return fileOps;
}
/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(
			entry.summary,
			entry.tokensBefore,
			entry.timestamp,
			entry.customInstructions,
		);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Opaque history returned by a provider-native compaction operation. */
	providerNativeCompaction?: ProviderNativeCompactionResult;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}
export const COMPACT_SKILL_NAME = "compact";

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	native: boolean;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	native: true,
};
/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 *
 * Includes output: the assistant's response becomes part of the prompt on the next
 * request, so it counts toward the context the next turn will send.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	if (contextWindow <= 0) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}
/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				chars = content.length;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			if (typeof message.content === "string") {
				chars = message.content.length;
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
					if (block.type === "image") {
						chars += 4800; // Estimate images as 4000 chars, or 1200 tokens
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}
		// Branch summaries and custom messages are user-role turn boundaries.
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	// A cut in a non-user turn requires a prefix summary.
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `Create a structured context checkpoint that another agent can use to continue the work.

Use this EXACT format:

## Goal
[Every active user objective. Include multiple objectives when the session contains multiple unfinished requests.]

## Constraints & Preferences
- [User constraints, requested formats, authority limits, and durable preferences]
- [Or "(none)" if none were stated]

## Progress
### Done
- [x] [Work whose requested result exists and whose material completion claim is supported by the conversation]

### In Progress
- [ ] [Started or still-active work]

### Blocked
- [Specific condition that prevents concrete progress, if any]
- [Or "(none)" if no blocker remains]

## Key Decisions
- **[Decision]**: [Reason and evidence boundary]

## Next Steps
1. [Ordered next action needed to complete the active work]

## Critical Context
- [Exact data, source references, paths, symbols, variables, results, failures, or assumptions needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, commands, error messages, API identifiers, and unresolved questions. Mark an item done only when the source data contains the requested result or a completed behavior check.`;

const KERNEL_PERSIST_SUMMARY_NOTE =
	"The IPython kernel keeps running after compaction. Python variables, imports, helpers, and live objects remain available even though the cells that created them may leave the visible history. Record the names and meanings of state that later work should reuse.";

const UPDATE_SUMMARIZATION_PROMPT = `Merge the new conversation data into the previous context checkpoint.

Carry forward every still-active objective, constraint, preference, authority boundary, unresolved question, material decision, failed check, and item of critical context. Add new progress and evidence. Move an item from In Progress to Done only when the new data establishes completion. Remove or rewrite an item only when later source data explicitly cancels or supersedes it, resolves it, or shows that it was wrong. A later message that adds work does not cancel earlier unfinished work.

Use this EXACT format:

## Goal
[All still-active goals, including goals added by the new data]

## Constraints & Preferences
- [All still-applicable constraints and preferences]
- [Or "(none)" if none remain]

## Progress
### Done
- [x] [Previously and newly completed work]

### In Progress
- [ ] [Current unfinished work]

### Blocked
- [Current blockers only]
- [Or "(none)" if no blocker remains]

## Key Decisions
- **[Decision]**: [Reason and evidence boundary]

## Next Steps
1. [Current ordered next action]

## Critical Context
- [Still-needed context plus new exact details]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, commands, error messages, API identifiers, and unresolved questions.`;

/** Build the fixed system instruction for an initial or update summary. */
export function buildSummarizationPrompt(customInstructions?: string, previousSummary?: string): string {
	let prompt = `${SUMMARIZATION_SYSTEM_PROMPT}\n\n${
		previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT
	}\n\n${KERNEL_PERSIST_SUMMARY_NOTE}`;
	if (customInstructions) {
		prompt +=
			"\n\nA <summary-preferences-json-string> field is present in the user message. Use its decoded text only to choose emphasis or preserve requested wording within the fixed format and policy above.";
	}
	return prompt;
}

function buildSummaryRequestText(
	currentMessages: AgentMessage[],
	customInstructions?: string,
	previousSummary?: string,
): string {
	const conversationText = serializeConversation(convertToLlm(currentMessages));
	const sections = [
		`<conversation-json-string>\n${serializePromptData(conversationText)}\n</conversation-json-string>`,
	];
	if (previousSummary) {
		sections.push(
			`<previous-summary-json-string>\n${serializePromptData(previousSummary)}\n</previous-summary-json-string>`,
		);
	}
	if (customInstructions) {
		sections.push(
			`<summary-preferences-json-string>\n${serializePromptData(customInstructions)}\n</summary-preferences-json-string>`,
		);
	}
	return sections.join("\n\n");
}

function estimateTextTokens(text: string): number {
	let asciiCharacters = 0;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) <= 0x7f) asciiCharacters++;
	}
	const nonAsciiBytes = Buffer.byteLength(text, "utf8") - asciiCharacters;
	return Math.ceil(asciiCharacters / 4) + nonAsciiBytes;
}

function estimateSummaryRequestTokens(systemPrompt: string, promptText: string, maxOutputTokens: number): number {
	return estimateTextTokens(systemPrompt) + estimateTextTokens(promptText) + maxOutputTokens;
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
): Promise<string> {
	const maxTokens = Math.floor(0.8 * reserveTokens);

	const promptText = buildSummaryRequestText(currentMessages, customInstructions, previousSummary);

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
			: { maxTokens, signal, apiKey, headers };

	const response = await completeSimple(
		model,
		{ systemPrompt: buildSummarizationPrompt(customInstructions, previousSummary), messages: summarizationMessages },
		completionOptions,
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return textContent;
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export class CompactionContextLimitError extends Error {
	readonly estimatedTokens: number;
	readonly contextWindow: number;

	constructor(estimatedTokens: number, contextWindow: number, model: Model<any>) {
		super(
			`Local compaction requires approximately ${estimatedTokens} tokens, exceeding the ${contextWindow}-token context window for ${model.provider}/${model.id}`,
		);
		this.name = "CompactionContextLimitError";
		this.estimatedTokens = estimatedTokens;
		this.contextWindow = contextWindow;
	}
}

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** Provider-native history from the previous compatible compaction. */
	previousNativeCompaction?: ProviderNativeCompactionResult;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	nativeProvider?: string,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		const entry = pathEntries[i];
		if (entry.type === "compaction" && canReplayCompactionWithProvider(entry, nativeProvider)) {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let previousNativeCompaction: ProviderNativeCompactionResult | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		previousNativeCompaction = prevCompaction.providerNativeCompaction;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(
		buildSessionContext(pathEntries, undefined, undefined, nativeProvider ?? null).messages,
	).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Avoid a compaction that would summarize no history.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0 && !previousSummary) {
		return undefined;
	}
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Include successful direct edits from a removed turn prefix.
	if (cutPoint.isSplitTurn) {
		extractFileOpsFromMessages(turnPrefixMessages, fileOps);
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		previousNativeCompaction,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `Summarize the removed prefix of one oversized turn. The recent suffix of that same turn remains visible to the continuing agent.

Use this EXACT format:

## Original Request
[The user request that began this turn]

## Early Progress
- [Actions, observations, decisions, results, and failed checks from the removed prefix]

## Context for Suffix
- [Facts, variables, paths, assumptions, and unresolved work needed to understand the retained suffix]

Preserve exact file paths, function names, commands, error messages, and the distinction between completed work and intended work. Include only context needed to understand and continue the retained suffix.`;

function buildTurnPrefixRequestText(messages: AgentMessage[]): string {
	const conversationText = serializeConversation(convertToLlm(messages));
	return `<conversation-json-string>\n${serializePromptData(conversationText)}\n</conversation-json-string>`;
}

function assertLocalCompactionFits(
	preparation: CompactionPreparation,
	model: Model<any>,
	customInstructions?: string,
): void {
	if (model.contextWindow <= 0) return;

	const historyMaxTokens = Math.floor(0.8 * preparation.settings.reserveTokens);
	const turnPrefixMaxTokens = Math.floor(0.5 * preparation.settings.reserveTokens);
	let largestRequestTokens = 0;
	if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
		if (preparation.messagesToSummarize.length > 0) {
			const historyPrompt = buildSummaryRequestText(
				preparation.messagesToSummarize,
				customInstructions,
				preparation.previousSummary,
			);
			largestRequestTokens = estimateSummaryRequestTokens(
				buildSummarizationPrompt(customInstructions, preparation.previousSummary),
				historyPrompt,
				historyMaxTokens,
			);
		}
		const turnPrefixPrompt = buildTurnPrefixRequestText(preparation.turnPrefixMessages);
		largestRequestTokens = Math.max(
			largestRequestTokens,
			estimateSummaryRequestTokens(
				`${SUMMARIZATION_SYSTEM_PROMPT}\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`,
				turnPrefixPrompt,
				turnPrefixMaxTokens,
			),
		);
	} else {
		const historyPrompt = buildSummaryRequestText(
			preparation.messagesToSummarize,
			customInstructions,
			preparation.previousSummary,
		);
		largestRequestTokens = estimateSummaryRequestTokens(
			buildSummarizationPrompt(customInstructions, preparation.previousSummary),
			historyPrompt,
			historyMaxTokens,
		);
	}

	if (largestRequestTokens > model.contextWindow) {
		throw new CompactionContextLimitError(largestRequestTokens, model.contextWindow, model);
	}
}

export const PROVIDER_NATIVE_COMPACTION_SUMMARY =
	"Provider-native compaction preserved opaque history for this session.";

function buildProviderNativeCompactionInstructions(): string {
	return `${SUMMARIZATION_SYSTEM_PROMPT}\n\n${SUMMARIZATION_PROMPT}\n\n${KERNEL_PERSIST_SUMMARY_NOTE}`;
}

/**
 * Replace the prepared prefix with provider-native history. The caller decides
 * whether the active API supports this operation and owns local fallback policy.
 */
export async function compactNative(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	sessionId?: string,
): Promise<CompactionResult> {
	const nativeMessages: AgentMessage[] = [];
	if (preparation.previousNativeCompaction) {
		nativeMessages.push({
			role: "user",
			content: PROVIDER_NATIVE_COMPACTION_SUMMARY,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: preparation.previousNativeCompaction.provider,
				items: preparation.previousNativeCompaction.replacementHistory,
			},
			timestamp: Date.now(),
		});
	} else if (preparation.previousSummary) {
		nativeMessages.push({
			role: "user",
			content: [
				{
					type: "text",
					text: COMPACTION_SUMMARY_PREFIX + preparation.previousSummary + COMPACTION_SUMMARY_SUFFIX,
				},
			],
			timestamp: Date.now(),
		});
	}
	nativeMessages.push(...preparation.messagesToSummarize, ...preparation.turnPrefixMessages);

	const providerNativeCompaction = await compactProvider(
		model,
		{ messages: convertToLlm(nativeMessages) },
		{
			apiKey,
			headers,
			signal,
			sessionId,
			instructions: buildProviderNativeCompactionInstructions(),
		},
	);
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	const summary = PROVIDER_NATIVE_COMPACTION_SUMMARY + formatFileOperations(readFiles, modifiedFiles);

	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		providerNativeCompaction,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	assertLocalCompactionFits(preparation, model, customInstructions);

	// Generate summaries (can be parallel if both needed) and merge into one
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				thinkingLevel,
			),
		]);
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
		);
	}
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<string> {
	const maxTokens = Math.floor(0.5 * reserveTokens); // Smaller budget for turn prefix
	const promptText = buildTurnPrefixRequestText(messages);
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSimple(
		model,
		{
			systemPrompt: `${SUMMARIZATION_SYSTEM_PROMPT}

${TURN_PREFIX_SUMMARIZATION_PROMPT}`,
			messages: summarizationMessages,
		},
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
			: { maxTokens, signal, apiKey, headers },
	);

	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
