/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	HARNESS_DIGEST_CUSTOM_TYPE,
} from "../messages.js";
import { completeWithProviderRetry, type ProviderRetryPolicy } from "../provider-retry.js";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.js";
import { estimateTokens } from "./compaction.js";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.js";
export interface BranchSummaryResult {
	summary?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
	usage?: Usage;
}

/** Details stored in BranchSummaryEntry.details for file tracking */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.js";

export interface BranchPreparation {
	/** Messages extracted for summarization, in chronological order */
	messages: AgentMessage[];
	/** File operations extracted from tool calls */
	fileOps: FileOperations;
	/** Total estimated tokens in messages */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** Entries to summarize, in chronological order */
	entries: SessionEntry[];
	/** Common ancestor between old and new position, if any */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** Model to use for summarization */
	model: Model<any>;
	/** API key for the model */
	apiKey: string;
	/** Request headers for the model */
	headers?: Record<string, string>;
	/** Owning conversation identity for provider routing and caching. */
	sessionId?: string;
	/** Abort signal for cancellation */
	signal: AbortSignal;
	/** Optional custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	retry?: ProviderRetryPolicy;
	/** Tokens reserved for prompt + LLM response (default 16384) */
	reserveTokens?: number;
}
/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}
	entries.reverse();

	return { entries, commonAncestorId };
}
/**
 * Extract AgentMessage from a session entry.
 * Similar to getMessageFromEntry in compaction.ts but also handles compaction entries.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// Tool-result context remains attached to its assistant tool call.
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			// Harness digests are regenerated at cold boundaries; never summarizer input.
			if (entry.customType === HARNESS_DIGEST_CUSTOM_TYPE) return undefined;
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(
				entry.summary,
				entry.tokensBefore,
				entry.timestamp,
				entry.customInstructions,
			);
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// First pass: collect file ops from ALL entries (even if they don't fit in token budget)
	// This ensures we capture cumulative file tracking from nested branch summaries
	// Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}
const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Completion budget for the branch summary wire call. */
const BRANCH_SUMMARY_MAX_TOKENS = 2048;

/**
 * Input-token budget the summarizer keeps: entries that do not fit the model's
 * window after the reserve are dropped. Shared by `generateBranchSummary` and
 * `estimateBranchSummaryRequestTokens` so both slice with the same budget.
 */
function branchSummaryTokenBudget(contextWindow: number | undefined, reserveTokens: number): number {
	return (contextWindow || 128000) - reserveTokens;
}

/**
 * Build the summarizer prompt for a serialized branch: the conversation in its
 * `<conversation>` wrapper plus the selected instructions. Shared with
 * `estimateBranchSummaryRequestTokens` so the estimate cannot drift from the
 * request `generateBranchSummary` issues.
 */
function buildBranchSummaryPrompt(
	conversationText: string,
	customInstructions?: string,
	replaceInstructions?: boolean,
): string {
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	return `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;
}

/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		sessionId,
		signal,
		customInstructions,
		replaceInstructions,
		retry,
		reserveTokens = 16384,
	} = options;
	const tokenBudget = branchSummaryTokenBudget(model.contextWindow, reserveTokens);

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	// Nothing model-visible remains after filtering.
	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}
	// Serialize before the LLM call so it summarizes rather than continues this branch.
	const conversationText = serializeConversation(convertToLlm(messages));
	const promptText = buildBranchSummaryPrompt(conversationText, customInstructions, replaceInstructions);

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];
	const response = await completeWithProviderRetry(
		() =>
			completeSimple(
				model,
				{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
				{ apiKey, headers, sessionId, signal, maxTokens: BRANCH_SUMMARY_MAX_TOKENS },
			),
		{ policy: retry, signal },
	);
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	let summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	summary = BRANCH_SUMMARY_PREAMBLE + summary;
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
		usage: response.usage,
	};
}

export interface EstimateBranchSummaryRequestTokensOptions {
	/** Context window of the model that would run the summary (default 128000) */
	contextWindow?: number;
	/** Tokens reserved for prompt + LLM response (default 16384) */
	reserveTokens?: number;
	/** Optional custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
}

/**
 * Estimate the context window the branch summary needs, using the chars/4
 * heuristic this module already uses for pre-LLM token math. A model must hold
 * two things: the request body `generateBranchSummary` builds
 * (SUMMARIZATION_SYSTEM_PROMPT, the serialized branch inside its
 * `<conversation>` wrapper, and the completion budget) and the reserve the
 * branch call subtracts from its window via `branchSummaryTokenBudget`. The
 * window also sizes the input slice, so a model that covers only the request
 * body drops the oldest entries - or every entry, turning the summary into a
 * "No content to summarize" stub - instead of running the request the session
 * model would have run. A branch whose newest entry alone overflows the budget
 * slices to nothing, so no wire request is issued; the returned floor still
 * requires a window above the reserve, because a smaller window would slice
 * with a non-positive budget that prepareBranchEntries treats as unlimited.
 */
export function estimateBranchSummaryRequestTokens(
	entries: SessionEntry[],
	options: EstimateBranchSummaryRequestTokensOptions = {},
): number {
	const { contextWindow, reserveTokens = 16384, customInstructions, replaceInstructions } = options;
	// Mirrors generateBranchSummary: the same budget decides which entries fit.
	const tokenBudget = branchSummaryTokenBudget(contextWindow, reserveTokens);
	const { messages } = prepareBranchEntries(entries, tokenBudget);
	if (messages.length === 0) {
		// No wire request is issued for this shape, but a resolved model whose
		// window is at or below the reserve would slice with a non-positive
		// budget, which prepareBranchEntries treats as unlimited and would send
		// the whole branch over-limit. Require a window that keeps that budget
		// positive; larger windows slice their own budget and stay bounded.
		return reserveTokens + 1;
	}
	const promptText = buildBranchSummaryPrompt(
		serializeConversation(convertToLlm(messages)),
		customInstructions,
		replaceInstructions,
	);
	const promptTokens = Math.ceil(promptText.length / 4);
	// The completion budget and the input slice reserve are separate draws on the
	// same window, so the larger of the two decides whether the model fits.
	return Math.max(
		Math.ceil(SUMMARIZATION_SYSTEM_PROMPT.length / 4) + promptTokens + BRANCH_SUMMARY_MAX_TOKENS,
		promptTokens + reserveTokens,
	);
}
