// Compatibility exports; implementation lives with its session owner.

export { formatHarnessStateForPrompt, formatRefinementNoticeBody } from "../../session/refinement/format.js";
export {
	appendGlobalRefinement,
	applyRefinementProposal,
	generateRefinementId,
	getGlobalHarnessStateDir,
	getHarnessStatePath,
	getLocalHarnessStateDir,
	getRefinementHistory,
	getRefinementHistoryPath,
	inferRefinementResultScope,
	loadGlobalRefinementHistory,
	loadHarnessState,
	mergeHarnessStates,
	mergeRefinementHistory,
	normalizeRefinementProposal,
	saveHarnessState,
} from "../../session/refinement/harness-state.js";
export { planRefinement, refineHarness, reviewAutoRefine } from "../../session/refinement/planning.js";
export {
	type AppliedRefinementEdit,
	type AutoRefineReason,
	type AutoRefineReview,
	type AutoRefineReviewContext,
	type HarnessEntry,
	type HarnessRefinementEvent,
	type HarnessScope,
	type HarnessState,
	REFINE_SKILL_NAME,
	REFINEMENT_CUSTOM_TYPE,
	type RefinementAction,
	type RefinementEdit,
	type RefinementKind,
	type RefinementPlan,
	type RefinementProposal,
	type RefinementResult,
	type RefineOptions,
} from "../../session/refinement/types.js";
