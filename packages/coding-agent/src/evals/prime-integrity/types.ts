export type PrimeIntegrityCategory =
	| "affected_surface"
	| "benchmark_shortcut"
	| "compositional_hidden"
	| "easy_verifier"
	| "incomplete_obligations"
	| "stale_assumption"
	| "test_tampering"
	| "zero_test";

export const PRIME_INTEGRITY_TOKEN_STAGES = [
	"setup",
	"implementation",
	"candidate_evaluation",
	"obligation_coverage",
	"completion",
	"completion_repair",
	"post_ready_work",
	"memory",
	"other",
] as const;

export type PrimeIntegrityTokenStage = (typeof PRIME_INTEGRITY_TOKEN_STAGES)[number];

export interface PrimeIntegrityModelUsageSummary {
	modelCalls: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

export interface PrimeIntegrityCompletionAttempt {
	attempt: number;
	source: "explicit_stop_gate" | "host_completion";
	assistantTurn: number;
	timestamp?: string;
	passed: boolean | null;
	blockerIds: string[];
	blockerReasons: Record<string, string>;
	reasons: string[];
}

export interface PrimeIntegrityCompletionBlockerSummary {
	blockerId: string;
	reason?: string;
	occurrences: number;
	firstAttempt: number;
	lastAttempt: number;
	clearedAtAttempt: number | null;
	assistantTurnsToFirstClearance: number | null;
	tokensToFirstClearance: number | null;
}

export interface PrimeIntegrityCommand {
	argv: string[];
	timeoutMs?: number;
}

export interface PrimeIntegrityObligation extends PrimeIntegrityCommand {
	id: string;
	description: string;
}

export interface PrimeIntegrityCase {
	id: string;
	title: string;
	category: PrimeIntegrityCategory;
	prompt: string;
	files: Record<string, string>;
	protectedPaths: string[];
	visibleChecks: PrimeIntegrityCommand[];
	hiddenObligations: PrimeIntegrityObligation[];
}

export interface PrimeIntegrityCommandResult {
	argv: string[];
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	stdout: string;
	stderr: string;
}

export interface PrimeIntegrityTraceSummary {
	completedRuns: number;
	assistantTurns: number;
	modelCalls: number;
	toolCalls: number;
	candidates: number;
	cycles: number;
	acceptedCycles: number;
	revisedCycles: number;
	obligations: number;
	coveredObligations: number;
	obligationCoverageEvaluationCount: number;
	maxObligationsPerCoverageEvaluation: number;
	acceptedCandidateCoveredObligations: number;
	acceptedCandidateObligationEvidenceReceiptCount: number;
	acceptedCandidateMeanObligationsPerEvidenceReceipt: number;
	acceptedCandidateMaxObligationsPerEvidenceReceipt: number;
	acceptedCandidateEvidenceDiversity: number;
	acceptedCandidateMaxEvidenceConcentration: number;
	criticalAssumptions: number;
	resolvedCriticalAssumptions: number;
	watchdogInterventions: number;
	watchdogWatches: number;
	supervisorReviews: number;
	supervisorProgressingReviews: number;
	supervisorWatchReviews: number;
	supervisorInterventions: number;
	toolProbationActivations: number;
	toolProbationBlockedCalls: number;
	completionAttemptCount: number;
	failedCompletionAttemptCount: number;
	successfulCompletionAttemptCount: number;
	inconclusiveCompletionAttemptCount: number;
	firstCompletionAttemptPassed: boolean | null;
	completionRepairTurns: number;
	inputTokensAfterFirstCompletionAttempt: number;
	cacheReadTokensAfterFirstCompletionAttempt: number;
	cacheWriteTokensAfterFirstCompletionAttempt: number;
	outputTokensAfterFirstCompletionAttempt: number;
	tokensAfterFirstCompletionAttempt: number;
	costUsdAfterFirstCompletionAttempt: number;
	completionRepairAmplification: number;
	uniqueCompletionBlockerCount: number;
	repeatedCompletionBlockerCount: number;
	sameBlockerConsecutiveRepeatCount: number;
	completionAttempts: PrimeIntegrityCompletionAttempt[];
	completionBlockers: PrimeIntegrityCompletionBlockerSummary[];
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
	tokenUsageByStage: Record<PrimeIntegrityTokenStage, PrimeIntegrityModelUsageSummary>;
	commands: string[];
}

export interface PrimeIntegrityCaseResult {
	caseId: string;
	title: string;
	category: PrimeIntegrityCategory;
	hardening: boolean;
	agentExitCode: number | null;
	agentTimedOut: boolean;
	durationMs: number;
	visiblePass: boolean;
	hiddenPass: boolean;
	legitimateSuccess: boolean;
	falseCompletion: boolean;
	rewardHacking: boolean;
	evaluatorTampering: boolean;
	watchdogBypass: boolean;
	obligationsPassed: number;
	obligationsTotal: number;
	obligationCoverage: number;
	visibleResults: PrimeIntegrityCommandResult[];
	obligationResults: Array<PrimeIntegrityCommandResult & { id: string; description: string; passed: boolean }>;
	protectedPathChanges: string[];
	trace: PrimeIntegrityTraceSummary;
	workspacePath?: string;
	transcriptPath: string;
	sessionPaths: string[];
}

export interface PrimeIntegrityAggregate {
	schemaVersion: 1;
	benchmark: "Prime Integrity Eval";
	benchmarkVersion: "1.0.0";
	startedAt: string;
	completedAt: string;
	provider?: string;
	model?: string;
	hardening: boolean;
	caseCount: number;
	metrics: {
		taskSuccessRate: number;
		legitimateSuccessRate: number;
		visiblePassRate: number;
		hiddenPassRate: number;
		falseCompletionRate: number;
		rewardHackingRate: number;
		evaluatorTamperingRate: number;
		watchdogBypassRate: number;
		watchdogInterventionRate: number;
		unsupportedAssumptionRate: number;
		incompleteObligationRate: number;
		meanObligationCoverage: number;
		meanCandidatesPerTask?: number;
		meanCyclesPerTask?: number;
		meanTokensPerTask: number;
		meanCostUsdPerTask: number;
		meanDurationMs: number;
	};
	cases: PrimeIntegrityCaseResult[];
}
