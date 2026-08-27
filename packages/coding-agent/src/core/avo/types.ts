export const AVO_STATE_VERSION = 8;
export const AVO_SKILL_NAME = "avo";

export const AVO_ENVIRONMENTS = ["general", "coding", "research"] as const;
export const AVO_HORIZONS = ["direct", "iterative", "long"] as const;
export const AVO_AUTHORITIES = ["host", "environment", "external", "model_opinion"] as const;
export const AVO_EVALUATION_STATUSES = ["pass", "fail", "revise", "inconclusive"] as const;
export const AVO_EVALUATION_ISSUERS = ["host", "model", "legacy_unverified"] as const;
export const AVO_VERIFICATION_POLICIES = ["required", "best_effort", "not_applicable"] as const;
export const AVO_VERIFICATION_CLASSES = [
	"external_factual",
	"deterministic_local",
	"coding",
	"research",
	"artifact",
	"subjective",
] as const;
export const AVO_RUN_STATUSES = ["active", "completed", "blocked", "failed"] as const;
export const AVO_CYCLE_OUTCOMES = ["accepted", "rejected", "revised", "inconclusive"] as const;
export const AVO_MEMORY_NAMESPACES = ["shared", ...AVO_ENVIRONMENTS] as const;
export const AVO_MEMORY_TYPES = ["info", "skill", "episode", "intent", "todo", "reflection", "scratch"] as const;
export const AVO_MEMORY_SCOPES = ["task", "project", "global"] as const;
export const AVO_MEMORY_VERIFICATION_STATES = ["proposed", "verified", "contested", "invalidated"] as const;
export const AVO_MEMORY_REFERENCE_KINDS = [
	"file",
	"candidate",
	"experiment",
	"trial",
	"evaluation",
	"cycle",
	"artifact",
	"task",
	"memory",
] as const;
export const AVO_MEMORY_RECALL_CHANNELS = ["deliberate", "spontaneous"] as const;
export const AVO_EXPERIMENT_STATUSES = ["planned", "running", "completed"] as const;
export const AVO_EXPERIMENT_MODES = ["prospective", "retrospective"] as const;
export const AVO_EXPERIMENT_PAIRINGS = ["paired", "independent"] as const;
export const AVO_METRIC_DIRECTIONS = ["maximize", "minimize"] as const;
export const AVO_EXPERIMENT_DECISIONS = ["promote", "retain", "inconclusive"] as const;
export const AVO_EXPERIMENT_INFERENCE_VERSION = "student_t_95_min_pairs_5_v1";
export const AVO_MIN_PAIRED_OBSERVATIONS_FOR_PROMOTION = 5;

export type AvoEnvironment = (typeof AVO_ENVIRONMENTS)[number];
export type AvoEnvironmentSelection = "auto" | AvoEnvironment;
export type AvoHorizon = (typeof AVO_HORIZONS)[number];
export type AvoHorizonSelection = "auto" | AvoHorizon;
export type AvoEvaluationAuthority = (typeof AVO_AUTHORITIES)[number];
export type AvoEvaluationStatus = (typeof AVO_EVALUATION_STATUSES)[number];
export type AvoEvaluationIssuer = (typeof AVO_EVALUATION_ISSUERS)[number];
export type AvoVerificationPolicy = (typeof AVO_VERIFICATION_POLICIES)[number];
export type AvoVerificationClass = (typeof AVO_VERIFICATION_CLASSES)[number];
export type AvoRunStatus = (typeof AVO_RUN_STATUSES)[number];
export type AvoCycleOutcome = (typeof AVO_CYCLE_OUTCOMES)[number];
export type AvoMemoryNamespace = (typeof AVO_MEMORY_NAMESPACES)[number];
export type AvoMemoryType = (typeof AVO_MEMORY_TYPES)[number];
export type AvoMemoryScope = (typeof AVO_MEMORY_SCOPES)[number];
export type AvoMemoryVerificationState = (typeof AVO_MEMORY_VERIFICATION_STATES)[number];
export type AvoMemoryReferenceKind = (typeof AVO_MEMORY_REFERENCE_KINDS)[number];
export type AvoMemoryRecallChannel = (typeof AVO_MEMORY_RECALL_CHANNELS)[number];
export type AvoExperimentStatus = (typeof AVO_EXPERIMENT_STATUSES)[number];
export type AvoExperimentMode = (typeof AVO_EXPERIMENT_MODES)[number];
export type AvoExperimentPairing = (typeof AVO_EXPERIMENT_PAIRINGS)[number];
export type AvoMetricDirection = (typeof AVO_METRIC_DIRECTIONS)[number];
export type AvoExperimentDecision = (typeof AVO_EXPERIMENT_DECISIONS)[number];

export interface AvoRoutingDecision {
	environment: AvoEnvironment;
	horizon: AvoHorizon;
	source: "host_auto" | "model" | "user";
	reasons: string[];
	decidedAt: string;
}

export interface AvoCandidate {
	candidateId: string;
	kind: string;
	summary: string;
	payloadDigest: string;
	deliveryDigest?: string;
	deterministicResult?: string;
	artifactPaths?: string[];
	artifactTargetDigest?: string;
	claims?: AvoCandidateClaim[];
	workspaceDigest?: string;
	workspaceHead?: string;
	workspaceMode?: "git" | "tree";
	parentCandidateId?: string;
	createdAt: string;
}

export interface AvoCandidateClaim {
	claimId: string;
	claimText: string;
}

export interface AvoBaselineTestFile {
	path: string;
	sha256: string;
}

export interface AvoVerificationBaseline {
	kind: "coding";
	contractDigest: string;
	workspaceDigest: string;
	testFiles: AvoBaselineTestFile[];
	userAcceptanceCommands: string[];
	executions: AvoBaselineExecution[];
	capturedAt: string;
}

export interface AvoBaselineExecution {
	executionId: string;
	command: string;
	commandDigest: string;
	outputDigest: string;
	workspaceDigest: string;
	postWorkspaceDigest: string;
	status: AvoEvaluationStatus;
	meaningful: boolean;
	observedWorkUnits: number;
	observedPassedWorkUnits: number;
	observedBaselineTestFiles: string[];
	testTrustBasis: string;
	recordedAt: string;
}

export interface AvoEvaluationReceipt {
	evaluationId: string;
	candidateId: string;
	evaluatorId: string;
	status: AvoEvaluationStatus;
	authority: AvoEvaluationAuthority;
	issuedBy: AvoEvaluationIssuer;
	evidenceRefs: string[];
	metrics: Record<string, number | string | boolean>;
	createdAt: string;
}

export interface AvoExperiment {
	experimentId: string;
	title: string;
	hypothesis: string;
	design: string;
	plan?: AvoExperimentPlan;
	status: AvoExperimentStatus;
	trialIds: string[];
	tags: string[];
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	aggregateEvaluationId?: string;
	outcome?: AvoExperimentOutcome;
}

export interface AvoExperimentCondition {
	conditionId: string;
	label: string;
	parameters: Record<string, number | string | boolean>;
	commandTemplate: string;
}

export interface AvoExperimentPlan {
	mode: AvoExperimentMode;
	candidateIds: string[];
	conditions: AvoExperimentCondition[];
	seeds: string[];
	pairing: AvoExperimentPairing;
	primaryMetric: string;
	metricDirection: AvoMetricDirection;
	baselineCandidateId?: string;
	expectedTrials: number;
}

export interface AvoMetricSummary {
	count: number;
	mean: number;
	median: number;
	variance: number;
	standardDeviation: number;
	minimum: number;
	maximum: number;
	ci95Method: "student_t" | "not_estimable";
	ci95DegreesOfFreedom: number;
	ci95Low: number | null;
	ci95High: number | null;
}

export interface AvoCandidateAggregate {
	candidateId: string;
	metric: AvoMetricSummary;
}

export interface AvoConditionAggregate extends AvoCandidateAggregate {
	conditionId: string;
}

export interface AvoPairedComparison {
	candidateId: string;
	baselineCandidateId: string;
	delta: AvoMetricSummary;
	favorableMean: number;
	favorableCi95Low: number | null;
	favorableCi95High: number | null;
	wins: number;
	losses: number;
	ties: number;
	winRate: number;
}

export interface AvoConditionPairedComparison extends AvoPairedComparison {
	conditionId: string;
}

export interface AvoExperimentOutcome {
	inferenceVersion: typeof AVO_EXPERIMENT_INFERENCE_VERSION;
	minimumPairedObservationsForPromotion: typeof AVO_MIN_PAIRED_OBSERVATIONS_FOR_PROMOTION;
	primaryMetric: string;
	metricDirection: AvoMetricDirection;
	candidateAggregates: AvoCandidateAggregate[];
	conditionAggregates: AvoConditionAggregate[];
	pairedComparisons: AvoPairedComparison[];
	conditionPairedComparisons: AvoConditionPairedComparison[];
	ranking: string[];
	championCandidateId?: string;
	decision: AvoExperimentDecision;
	reason: string;
	trialManifestDigest: string;
	aggregateDigest: string;
}

export interface AvoTrial {
	trialId: string;
	experimentId: string;
	candidateId: string;
	evaluationId: string;
	sourceEvaluationId?: string;
	label: string;
	seed?: string;
	conditionId?: string;
	parameters?: Record<string, number | string | boolean>;
	commandDigest?: string;
	cellDigest?: string;
	status: AvoEvaluationStatus;
	metrics: Record<string, number | string | boolean>;
	evidenceRefs: string[];
	recordedAt: string;
}

export interface AvoTaskRunArchive {
	runId: string;
	objective: string;
	verificationPolicy: AvoVerificationPolicy;
	verificationClass: AvoVerificationClass;
	verificationReasons: string[];
	routing: AvoRoutingDecision;
	status: AvoRunStatus;
	candidates: AvoCandidate[];
	evaluations: AvoEvaluationReceipt[];
	experiments: AvoExperiment[];
	trials: AvoTrial[];
	cycles: AvoCycle[];
	lineage: AvoLineageEntry[];
	checkpoints: AvoCheckpoint[];
	supervision: AvoSupervisorReview[];
	adapterStateRef?: AvoAdapterStateRef;
	verificationBaseline?: AvoVerificationBaseline;
	artifactBaselinePaths?: string[];
	createdAt: string;
	updatedAt: string;
	archivedAt: string;
	archiveReason: string;
}

export interface AvoCycle {
	cycleId: string;
	candidateId: string;
	candidateKind: string;
	evaluationIds: string[];
	outcome: AvoCycleOutcome;
	failureSignature?: string;
	trajectoryFingerprint?: string;
	completedAt: string;
}

export interface AvoLineageEntry {
	lineageId: string;
	kind:
		| "initialized"
		| "routing_changed"
		| "candidate_recorded"
		| "evaluation_recorded"
		| "experiment_recorded"
		| "trial_recorded"
		| "experiment_completed"
		| "champion_promoted"
		| "cycle_completed"
		| "candidate_accepted"
		| "horizon_escalated"
		| "supervisor_intervention"
		| "adapter_progress"
		| "completed";
	summary: string;
	referenceId?: string;
	recordedAt: string;
}

export interface AvoSupervisorBinding {
	rlmChildId: string;
	name: string;
	boundAt: string;
}

export interface AvoSupervisorReview {
	reviewId: string;
	cycleId: string;
	status: "progressing" | "watch" | "intervene";
	reason: string;
	detectedPatterns: string[];
	recommendedActions: string[];
	recordedAt: string;
	source: "retained_supervisor" | "host_checkpoint" | "manual_recovery";
}

export interface AvoCheckpoint {
	checkpointId: string;
	cycleId?: string;
	status: "progressing" | "watch" | "intervene";
	reason: string;
	interventionNeeded: boolean;
	triggeredHeuristics: string[];
	progressIndicators: {
		cyclesSinceAcceptedProgress: number;
		repeatedFailureCount: number;
		repeatedTrajectoryCount: number;
		repeatedCandidateKindCount: number;
	};
	createdAt: string;
}

export interface AvoMemory {
	memoryId: string;
	namespace: AvoMemoryNamespace;
	type: AvoMemoryType;
	scope: AvoMemoryScope;
	verificationState: AvoMemoryVerificationState;
	owner: string;
	taskRunId: string;
	title: string;
	content: string;
	tags: string[];
	importance: number;
	sourceIds: string[];
	references: AvoMemoryReference[];
	reinforcementCount: number;
	createdAt: string;
	updatedAt: string;
	lastVerifiedAt?: string;
	contestedAt?: string;
	invalidatedAt?: string;
	supersededBy?: string;
}

export interface AvoMemoryReference {
	kind: AvoMemoryReferenceKind;
	key: string;
	preview?: string;
	capturedAt: string;
}

export interface AvoMemoryRecall {
	recallId: string;
	runId: string;
	channel: AvoMemoryRecallChannel;
	queryDigest: string;
	memoryIds: string[];
	contextChars: number;
	recordedAt: string;
	cycleId?: string;
	cycleOutcome?: AvoCycleOutcome;
}

export interface AvoMemoryReflection {
	reflectionId: string;
	trigger: "five_cycles" | "supervisor_intervention" | "candidate_acceptance" | "post_task" | "manual";
	cycleId?: string;
	report: Record<string, number | string | boolean>;
	archivedMemoryIds: string[];
	proposedMemoryIds?: string[];
	verifiedMemoryIds?: string[];
	recordedAt: string;
}

export interface AvoCandidateInput {
	candidateId?: string;
	kind: string;
	summary: string;
	payload: unknown;
	artifactPaths?: string[];
	claims?: AvoCandidateClaim[];
	workspaceDigest?: string;
	workspaceHead?: string;
	workspaceMode?: "git" | "tree";
	parentCandidateId?: string;
}

export interface AvoEvaluationInput {
	evaluationId?: string;
	candidateId: string;
	evaluatorId: string;
	status: AvoEvaluationStatus;
	authority: AvoEvaluationAuthority;
	evidenceRefs: string[];
	metrics: Record<string, number | string | boolean>;
}

export interface AvoExperimentInput {
	experimentId?: string;
	title: string;
	hypothesis: string;
	design: string;
	plan: AvoExperimentPlanInput;
	tags?: string[];
}

export interface AvoExperimentConditionInput {
	conditionId: string;
	label?: string;
	parameters?: Record<string, number | string | boolean>;
	commandTemplate: string;
}

export interface AvoExperimentPlanInput {
	mode?: AvoExperimentMode;
	candidateIds: string[];
	conditions: AvoExperimentConditionInput[];
	seeds: Array<string | number>;
	pairing?: AvoExperimentPairing;
	primaryMetric: string;
	metricDirection: AvoMetricDirection;
	baselineCandidateId?: string;
}

export interface AvoTrialInput {
	trialId?: string;
	experimentId: string;
	candidateId: string;
	evaluationId: string;
	conditionId: string;
	seed: string;
}

export interface AvoTrialRunInput {
	experimentId: string;
	candidateId: string;
	conditionId: string;
	seed: string;
}

export interface AvoCycleInput {
	candidateId: string;
	evaluationIds?: string[];
	failureSignature?: string;
	trajectoryFingerprint?: string;
}

export interface AvoMemoryInput {
	memoryId?: string;
	namespace: AvoMemoryNamespace;
	type: AvoMemoryType;
	scope?: AvoMemoryScope;
	title: string;
	content: string;
	tags?: string[];
	importance: number;
	sourceIds?: string[];
	references?: Array<{ kind: AvoMemoryReferenceKind; key: string }>;
}

export interface AvoAdapterStateRef {
	adapterId: AvoEnvironment;
	statePath: string;
	schemaVersion?: number;
	updatedAt: string;
}

export interface AvoRunState {
	schemaVersion: typeof AVO_STATE_VERSION;
	sessionId: string;
	runId: string;
	taskRuns: AvoTaskRunArchive[];
	objective?: string;
	verificationPolicy: AvoVerificationPolicy;
	verificationClass: AvoVerificationClass;
	verificationReasons: string[];
	environmentSelection: AvoEnvironmentSelection;
	horizonSelection: AvoHorizonSelection;
	routing: AvoRoutingDecision;
	status: AvoRunStatus;
	candidates: AvoCandidate[];
	evaluations: AvoEvaluationReceipt[];
	experiments: AvoExperiment[];
	trials: AvoTrial[];
	cycles: AvoCycle[];
	lineage: AvoLineageEntry[];
	checkpoints: AvoCheckpoint[];
	memories: AvoMemory[];
	memoryRecalls: AvoMemoryRecall[];
	memoryReflections: AvoMemoryReflection[];
	supervisor?: AvoSupervisorBinding;
	supervision: AvoSupervisorReview[];
	adapterStateRef?: AvoAdapterStateRef;
	verificationBaseline?: AvoVerificationBaseline;
	artifactBaselinePaths?: string[];
	createdAt: string;
	updatedAt: string;
}

export interface AvoProgressSignals {
	acceptedCandidates: number;
	rejectedCandidates: number;
	revisedCandidates: number;
	authoritativeEvaluations: number;
	modelOpinionEvaluations: number;
	openCandidates: number;
	latestFailure?: string;
}

export interface AvoStopGateCheck {
	id: string;
	label: string;
	passed: boolean;
	reason?: string;
}

export interface AvoStopGate {
	passed: boolean;
	checks: AvoStopGateCheck[];
	reasons: string[];
}

export interface AvoDashboardMetric {
	label: string;
	value: string | number;
}

export interface AvoDashboardSection {
	id: string;
	title: string;
	items: Array<{ label: string; value: string; status?: "ok" | "watch" | "fail" | "neutral" }>;
}

export interface AvoDashboardProjection {
	runId: string;
	taskRunCount: number;
	environment: AvoEnvironment;
	horizon: AvoHorizon;
	verificationPolicy: AvoVerificationPolicy;
	verificationClass: AvoVerificationClass;
	status: AvoRunStatus;
	phase: {
		id: string;
		title: string;
		detail: string;
		progressPercent: number;
	};
	phases: Array<{
		id: string;
		title: string;
		short: string;
		status: "complete" | "active" | "pending";
	}>;
	metrics: AvoDashboardMetric[];
	sections: AvoDashboardSection[];
	stopGate: AvoStopGate;
}
