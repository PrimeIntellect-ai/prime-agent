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
	type ContextUsageEstimate,
	calculateContextTokens,
	estimateContextTokens,
	estimateTokens,
	getLastAssistantUsage,
} from "../../session/context/token-estimate.js";
