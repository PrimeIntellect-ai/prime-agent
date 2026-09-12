import { describe, expect, it } from "vitest";
import * as CoreCompactionBranchSummarization from "../../src/core/compaction/branch-summarization.js";
import * as CoreCompactionCompaction from "../../src/core/compaction/compaction.js";
import * as CoreCompactionIndex from "../../src/core/compaction/index.js";
import * as CoreCompactionUtils from "../../src/core/compaction/utils.js";
import * as CoreContextTree from "../../src/core/context-tree.js";
import * as CoreMessages from "../../src/core/messages.js";
import * as CorePromptsIndex from "../../src/core/prompts/index.js";
import * as CorePromptsRlm from "../../src/core/prompts/rlm.js";
import * as CoreRefinementIndex from "../../src/core/refinement/index.js";
import * as CoreRefinementRefinement from "../../src/core/refinement/refinement.js";
import * as CoreSessionStats from "../../src/core/session-stats.js";
import * as CoreSystemPrompt from "../../src/core/system-prompt.js";
import * as CoreUsage from "../../src/core/usage.js";
import * as SessionCompactionCompaction from "../../src/session/compaction/compaction.js";
import * as SessionCompactionCompactionExecution from "../../src/session/compaction/compaction-execution.js";
import * as SessionCompactionController from "../../src/session/compaction/controller.js";
import * as SessionCompactionExecution from "../../src/session/compaction/execution.js";
import * as SessionCompactionSummary from "../../src/session/compaction/summary.js";
import * as SessionCompactionTypes from "../../src/session/compaction/types.js";
import * as SessionContextBranchSummary from "../../src/session/context/branch-summary.js";
import * as SessionContextContextTree from "../../src/session/context/context-tree.js";
import * as SessionContextConversationText from "../../src/session/context/conversation-text.js";
import * as SessionContextFileTracking from "../../src/session/context/file-tracking.js";
import * as SessionContextMessages from "../../src/session/context/messages.js";
import * as SessionContextPromptsIndex from "../../src/session/context/prompts/index.js";
import * as SessionContextPromptsRlm from "../../src/session/context/prompts/rlm.js";
import * as SessionContextSystemPrompt from "../../src/session/context/system-prompt.js";
import * as SessionContextTokenEstimate from "../../src/session/context/token-estimate.js";
import * as SessionContextUsage from "../../src/session/context/usage.js";
import * as SessionRefinementAutoRefinement from "../../src/session/refinement/auto-refinement.js";
import * as SessionRefinementAutomatic from "../../src/session/refinement/automatic.js";
import * as SessionRefinementController from "../../src/session/refinement/controller.js";
import * as SessionRefinementExecution from "../../src/session/refinement/execution.js";
import * as SessionRefinementFormat from "../../src/session/refinement/format.js";
import * as SessionRefinementHarnessState from "../../src/session/refinement/harness-state.js";
import * as SessionRefinementPlanning from "../../src/session/refinement/planning.js";
import * as SessionRefinementRefinement from "../../src/session/refinement/refinement.js";
import * as SessionRefinementRefinementExecution from "../../src/session/refinement/refinement-execution.js";
import * as SessionRefinementTypes from "../../src/session/refinement/types.js";

function assertExports(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
	expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
	for (const [name, value] of Object.entries(expected)) {
		expect(actual[name], name).toBe(value);
	}
}

describe("context ownership compatibility exports", () => {
	it("preserves core/compaction/compaction.ts", () => {
		assertExports(CoreCompactionCompaction, {
			COMPACT_SKILL_NAME: SessionCompactionTypes.COMPACT_SKILL_NAME,
			DEFAULT_COMPACTION_SETTINGS: SessionCompactionTypes.DEFAULT_COMPACTION_SETTINGS,
			calculateContextTokens: SessionContextTokenEstimate.calculateContextTokens,
			getLastAssistantUsage: SessionContextTokenEstimate.getLastAssistantUsage,
			estimateContextTokens: SessionContextTokenEstimate.estimateContextTokens,
			shouldCompact: SessionCompactionSummary.shouldCompact,
			estimateTokens: SessionContextTokenEstimate.estimateTokens,
			findTurnStartIndex: SessionCompactionSummary.findTurnStartIndex,
			findCutPoint: SessionCompactionSummary.findCutPoint,
			buildSummarizationPrompt: SessionCompactionSummary.buildSummarizationPrompt,
			generateSummary: SessionCompactionSummary.generateSummary,
			prepareCompaction: SessionCompactionSummary.prepareCompaction,
			compact: SessionCompactionSummary.compact,
		});
	});
	it("preserves core/compaction/utils.ts", () => {
		assertExports(CoreCompactionUtils, {
			createFileOps: SessionContextFileTracking.createFileOps,
			extractFileOpsFromMessage: SessionContextFileTracking.extractFileOpsFromMessage,
			computeFileLists: SessionContextFileTracking.computeFileLists,
			formatFileOperations: SessionContextFileTracking.formatFileOperations,
			serializeConversation: SessionContextConversationText.serializeConversation,
			SUMMARIZATION_SYSTEM_PROMPT: SessionContextConversationText.SUMMARIZATION_SYSTEM_PROMPT,
		});
	});
	it("preserves core/refinement/refinement.ts", () => {
		assertExports(CoreRefinementRefinement, {
			REFINEMENT_CUSTOM_TYPE: SessionRefinementTypes.REFINEMENT_CUSTOM_TYPE,
			REFINE_SKILL_NAME: SessionRefinementTypes.REFINE_SKILL_NAME,
			inferRefinementResultScope: SessionRefinementHarnessState.inferRefinementResultScope,
			getGlobalHarnessStateDir: SessionRefinementHarnessState.getGlobalHarnessStateDir,
			getLocalHarnessStateDir: SessionRefinementHarnessState.getLocalHarnessStateDir,
			getHarnessStatePath: SessionRefinementHarnessState.getHarnessStatePath,
			loadHarnessState: SessionRefinementHarnessState.loadHarnessState,
			mergeHarnessStates: SessionRefinementHarnessState.mergeHarnessStates,
			saveHarnessState: SessionRefinementHarnessState.saveHarnessState,
			getRefinementHistoryPath: SessionRefinementHarnessState.getRefinementHistoryPath,
			appendGlobalRefinement: SessionRefinementHarnessState.appendGlobalRefinement,
			loadGlobalRefinementHistory: SessionRefinementHarnessState.loadGlobalRefinementHistory,
			mergeRefinementHistory: SessionRefinementHarnessState.mergeRefinementHistory,
			formatRefinementNoticeBody: SessionRefinementFormat.formatRefinementNoticeBody,
			formatHarnessStateForPrompt: SessionRefinementFormat.formatHarnessStateForPrompt,
			normalizeRefinementProposal: SessionRefinementHarnessState.normalizeRefinementProposal,
			applyRefinementProposal: SessionRefinementHarnessState.applyRefinementProposal,
			getRefinementHistory: SessionRefinementHarnessState.getRefinementHistory,
			generateRefinementId: SessionRefinementHarnessState.generateRefinementId,
			planRefinement: SessionRefinementPlanning.planRefinement,
			reviewAutoRefine: SessionRefinementPlanning.reviewAutoRefine,
			refineHarness: SessionRefinementPlanning.refineHarness,
		});
	});
	it("preserves core/compaction/branch-summarization.ts", () => {
		assertExports(CoreCompactionBranchSummarization, {
			collectEntriesForBranchSummary: SessionContextBranchSummary.collectEntriesForBranchSummary,
			prepareBranchEntries: SessionContextBranchSummary.prepareBranchEntries,
			generateBranchSummary: SessionContextBranchSummary.generateBranchSummary,
		});
	});
	it("preserves core/messages.ts", () => {
		assertExports(CoreMessages, {
			COMPACTION_SUMMARY_PREFIX: SessionContextMessages.COMPACTION_SUMMARY_PREFIX,
			COMPACTION_SUMMARY_SUFFIX: SessionContextMessages.COMPACTION_SUMMARY_SUFFIX,
			BRANCH_SUMMARY_PREFIX: SessionContextMessages.BRANCH_SUMMARY_PREFIX,
			BRANCH_SUMMARY_SUFFIX: SessionContextMessages.BRANCH_SUMMARY_SUFFIX,
			HEARTBEAT_PROMPT_CUSTOM_TYPE: SessionContextMessages.HEARTBEAT_PROMPT_CUSTOM_TYPE,
			HEARTBEAT_PROMPT_PREVIEW_LABEL: SessionContextMessages.HEARTBEAT_PROMPT_PREVIEW_LABEL,
			IPYTHON_STATE_RESTORED_CUSTOM_TYPE: SessionContextMessages.IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			SESSION_SLASH_COMMAND_CUSTOM_TYPE: SessionContextMessages.SESSION_SLASH_COMMAND_CUSTOM_TYPE,
			SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE: SessionContextMessages.SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
			COMPACTION_OUTCOME_CUSTOM_TYPE: SessionContextMessages.COMPACTION_OUTCOME_CUSTOM_TYPE,
			REFINEMENT_OUTCOME_CUSTOM_TYPE: SessionContextMessages.REFINEMENT_OUTCOME_CUSTOM_TYPE,
			REFINEMENT_NOTICE_CUSTOM_TYPE: SessionContextMessages.REFINEMENT_NOTICE_CUSTOM_TYPE,
			HARNESS_DIGEST_CUSTOM_TYPE: SessionContextMessages.HARNESS_DIGEST_CUSTOM_TYPE,
			RLM_CHILD_FAILURE_CUSTOM_TYPE: SessionContextMessages.RLM_CHILD_FAILURE_CUSTOM_TYPE,
			RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE: SessionContextMessages.RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
			ASYNC_BASH_COMPLETION_CUSTOM_TYPE: SessionContextMessages.ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
			ASYNC_BASH_COMPLETION_PREVIEW_LABEL: SessionContextMessages.ASYNC_BASH_COMPLETION_PREVIEW_LABEL,
			sanitizeMessageHeaderValue: SessionContextMessages.sanitizeMessageHeaderValue,
			HARNESS_DIGEST_PREFIX: SessionContextMessages.HARNESS_DIGEST_PREFIX,
			HARNESS_DIGEST_SUFFIX: SessionContextMessages.HARNESS_DIGEST_SUFFIX,
			createHarnessDigestMessage: SessionContextMessages.createHarnessDigestMessage,
			createAsyncBashCompletionMessage: SessionContextMessages.createAsyncBashCompletionMessage,
			createRlmChildFailureMessage: SessionContextMessages.createRlmChildFailureMessage,
			createRlmChildTerminalNoticeMessage: SessionContextMessages.createRlmChildTerminalNoticeMessage,
			bashOutputToText: SessionContextMessages.bashOutputToText,
			bashExecutionToText: SessionContextMessages.bashExecutionToText,
			createBranchSummaryMessage: SessionContextMessages.createBranchSummaryMessage,
			createCompactionSummaryMessage: SessionContextMessages.createCompactionSummaryMessage,
			createCustomMessage: SessionContextMessages.createCustomMessage,
			createSessionSlashCommandMessage: SessionContextMessages.createSessionSlashCommandMessage,
			createSessionSlashCommandResultMessage: SessionContextMessages.createSessionSlashCommandResultMessage,
			createCompactionOutcomeMessage: SessionContextMessages.createCompactionOutcomeMessage,
			createRefinementOutcomeMessage: SessionContextMessages.createRefinementOutcomeMessage,
			createRefinementNoticeMessage: SessionContextMessages.createRefinementNoticeMessage,
			isSessionSlashCommand: SessionContextMessages.isSessionSlashCommand,
			isSessionSlashCommandMessage: SessionContextMessages.isSessionSlashCommandMessage,
			isSessionSlashCommandResultMessage: SessionContextMessages.isSessionSlashCommandResultMessage,
			isCompactionOutcomeMessage: SessionContextMessages.isCompactionOutcomeMessage,
			isRefinementOutcomeMessage: SessionContextMessages.isRefinementOutcomeMessage,
			createHeartbeatPromptMessage: SessionContextMessages.createHeartbeatPromptMessage,
			convertToLlm: SessionContextMessages.convertToLlm,
		});
	});
	it("preserves core/context-tree.ts", () => {
		assertExports(CoreContextTree, {
			computeOwnAndTotalUsage: SessionContextContextTree.computeOwnAndTotalUsage,
			loadContextTreeChildFromDisk: SessionContextContextTree.loadContextTreeChildFromDisk,
			loadContextTreeChildrenFromDisk: SessionContextContextTree.loadContextTreeChildrenFromDisk,
		});
	});
	it("preserves core/usage.ts", () => {
		assertExports(CoreUsage, {
			sessionUsageSummaryFrom: SessionContextUsage.sessionUsageSummaryFrom,
			emptyUsage: SessionContextUsage.emptyUsage,
			addAssistantUsage: SessionContextUsage.addAssistantUsage,
			subtractAssistantUsage: SessionContextUsage.subtractAssistantUsage,
			cloneUsage: SessionContextUsage.cloneUsage,
		});
	});
	it("preserves core/session-stats.ts", () => {
		assertExports(CoreSessionStats, {});
	});
	it("preserves core/system-prompt.ts", () => {
		assertExports(CoreSystemPrompt, {
			buildSystemPrompt: SessionContextSystemPrompt.buildSystemPrompt,
		});
	});
	it("preserves core/prompts/index.ts", () => {
		assertExports(CorePromptsIndex, {
			buildChildAgentDoctrine: SessionContextPromptsIndex.buildChildAgentDoctrine,
			buildRlmPrompt: SessionContextPromptsIndex.buildRlmPrompt,
			buildSubagentGuidance: SessionContextPromptsIndex.buildSubagentGuidance,
		});
	});
	it("preserves core/prompts/rlm.ts", () => {
		assertExports(CorePromptsRlm, {
			buildChildAgentDoctrine: SessionContextPromptsRlm.buildChildAgentDoctrine,
			buildRlmPrompt: SessionContextPromptsRlm.buildRlmPrompt,
			buildSubagentGuidance: SessionContextPromptsRlm.buildSubagentGuidance,
		});
	});
	it("preserves session/compaction/compaction.ts", () => {
		assertExports(SessionCompactionCompaction, {
			SessionCompaction: SessionCompactionController.SessionCompaction,
		});
	});
	it("preserves session/compaction/compaction-execution.ts", () => {
		assertExports(SessionCompactionCompactionExecution, {
			CompactionSkippedError: SessionCompactionExecution.CompactionSkippedError,
			performSessionCompaction: SessionCompactionExecution.performSessionCompaction,
		});
	});
	it("preserves session/refinement/refinement.ts", () => {
		assertExports(SessionRefinementRefinement, {
			SessionRefinement: SessionRefinementController.SessionRefinement,
			RefineSkippedError: SessionRefinementController.RefineSkippedError,
		});
	});
	it("preserves session/refinement/auto-refinement.ts", () => {
		assertExports(SessionRefinementAutoRefinement, {
			autoRefineInstructions: SessionRefinementAutomatic.autoRefineInstructions,
			AutoRefinement: SessionRefinementAutomatic.AutoRefinement,
		});
	});
	it("preserves session/refinement/refinement-execution.ts", () => {
		assertExports(SessionRefinementRefinementExecution, {
			RefineSkippedError: SessionRefinementExecution.RefineSkippedError,
			RefinementExecution: SessionRefinementExecution.RefinementExecution,
		});
	});
	it("preserves core/compaction/index.ts", () => {
		assertExports(CoreCompactionIndex, {
			COMPACT_SKILL_NAME: SessionCompactionTypes.COMPACT_SKILL_NAME,
			DEFAULT_COMPACTION_SETTINGS: SessionCompactionTypes.DEFAULT_COMPACTION_SETTINGS,
			calculateContextTokens: SessionContextTokenEstimate.calculateContextTokens,
			getLastAssistantUsage: SessionContextTokenEstimate.getLastAssistantUsage,
			estimateContextTokens: SessionContextTokenEstimate.estimateContextTokens,
			shouldCompact: SessionCompactionSummary.shouldCompact,
			estimateTokens: SessionContextTokenEstimate.estimateTokens,
			findTurnStartIndex: SessionCompactionSummary.findTurnStartIndex,
			findCutPoint: SessionCompactionSummary.findCutPoint,
			buildSummarizationPrompt: SessionCompactionSummary.buildSummarizationPrompt,
			generateSummary: SessionCompactionSummary.generateSummary,
			prepareCompaction: SessionCompactionSummary.prepareCompaction,
			compact: SessionCompactionSummary.compact,
			createFileOps: SessionContextFileTracking.createFileOps,
			extractFileOpsFromMessage: SessionContextFileTracking.extractFileOpsFromMessage,
			computeFileLists: SessionContextFileTracking.computeFileLists,
			formatFileOperations: SessionContextFileTracking.formatFileOperations,
			serializeConversation: SessionContextConversationText.serializeConversation,
			SUMMARIZATION_SYSTEM_PROMPT: SessionContextConversationText.SUMMARIZATION_SYSTEM_PROMPT,
			collectEntriesForBranchSummary: SessionContextBranchSummary.collectEntriesForBranchSummary,
			prepareBranchEntries: SessionContextBranchSummary.prepareBranchEntries,
			generateBranchSummary: SessionContextBranchSummary.generateBranchSummary,
		});
	});
	it("preserves core/refinement/index.ts", () => {
		assertExports(CoreRefinementIndex, {
			REFINEMENT_CUSTOM_TYPE: SessionRefinementTypes.REFINEMENT_CUSTOM_TYPE,
			REFINE_SKILL_NAME: SessionRefinementTypes.REFINE_SKILL_NAME,
			inferRefinementResultScope: SessionRefinementHarnessState.inferRefinementResultScope,
			getGlobalHarnessStateDir: SessionRefinementHarnessState.getGlobalHarnessStateDir,
			getLocalHarnessStateDir: SessionRefinementHarnessState.getLocalHarnessStateDir,
			getHarnessStatePath: SessionRefinementHarnessState.getHarnessStatePath,
			loadHarnessState: SessionRefinementHarnessState.loadHarnessState,
			mergeHarnessStates: SessionRefinementHarnessState.mergeHarnessStates,
			saveHarnessState: SessionRefinementHarnessState.saveHarnessState,
			getRefinementHistoryPath: SessionRefinementHarnessState.getRefinementHistoryPath,
			appendGlobalRefinement: SessionRefinementHarnessState.appendGlobalRefinement,
			loadGlobalRefinementHistory: SessionRefinementHarnessState.loadGlobalRefinementHistory,
			mergeRefinementHistory: SessionRefinementHarnessState.mergeRefinementHistory,
			formatRefinementNoticeBody: SessionRefinementFormat.formatRefinementNoticeBody,
			formatHarnessStateForPrompt: SessionRefinementFormat.formatHarnessStateForPrompt,
			normalizeRefinementProposal: SessionRefinementHarnessState.normalizeRefinementProposal,
			applyRefinementProposal: SessionRefinementHarnessState.applyRefinementProposal,
			getRefinementHistory: SessionRefinementHarnessState.getRefinementHistory,
			generateRefinementId: SessionRefinementHarnessState.generateRefinementId,
			planRefinement: SessionRefinementPlanning.planRefinement,
			reviewAutoRefine: SessionRefinementPlanning.reviewAutoRefine,
			refineHarness: SessionRefinementPlanning.refineHarness,
		});
	});
});
