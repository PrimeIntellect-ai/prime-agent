// Compatibility exports; implementation lives with its session owner.

export {
	buildSummarizationPrompt,
	compact,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	prepareCompaction,
	shouldCompact,
} from "../../session/compaction/summary.js";
export {
	COMPACT_SKILL_NAME,
	type CompactionDetails,
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	type CutPointResult,
	DEFAULT_COMPACTION_SETTINGS,
	type SummaryCallRunner,
	type SummarySlice,
} from "../../session/compaction/types.js";
export {
	type BranchPreparation,
	type BranchSummaryDetails,
	type BranchSummaryResult,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	prepareBranchEntries,
} from "../../session/context/branch-summary.js";
export { SUMMARIZATION_SYSTEM_PROMPT, serializeConversation } from "../../session/context/conversation-text.js";
export {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
} from "../../session/context/file-tracking.js";
export {
	type ContextUsageEstimate,
	calculateContextTokens,
	estimateContextTokens,
	estimateTokens,
	getLastAssistantUsage,
} from "../../session/context/token-estimate.js";
