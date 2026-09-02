export const AVO_STATE_VERSION = 14;
export const AVO_SKILL_NAME = "avo";
export const AVO_HOST_REQUEST_TYPES = [
	"avo.initialize",
	"avo.get",
	"avo.configure",
	"avo.obligations.register",
	"avo.obligations.cover",
	"avo.assumptions.register",
	"avo.assumptions.resolve",
	"avo.candidate.add",
	"avo.evaluation.record",
	"avo.external.fetch",
	"avo.verification.baseline.run",
	"avo.evaluation.deterministic",
	"avo.evaluation.artifacts",
	"avo.evaluation.run",
	"avo.evaluation.url",
	"avo.evaluation.tool_result",
	"avo.cycle.complete",
	"avo.experiment.record",
	"avo.trial.run",
	"avo.trial.record",
	"avo.experiment.complete",
	"avo.results.collect",
	"avo.memory.remember",
	"avo.memory.recall",
	"avo.memory.spontaneous",
	"avo.memory.reflect",
	"avo.memory.reflection.record",
	"avo.checkpoint",
	"avo.stop_gate",
	"avo.complete",
	"avo.variation.run",
] as const;

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
export const AVO_DELIVERY_PHASES = ["working", "accepted", "pending", "delivered", "failed"] as const;
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
export const AVO_EXPERIMENT_STAGES = ["screening", "confirmation"] as const;
export const AVO_METRIC_DIRECTIONS = ["maximize", "minimize"] as const;
export const AVO_EXPERIMENT_DECISIONS = ["promote", "retain", "inconclusive"] as const;
export const AVO_OBLIGATION_KINDS = [
	"outcome",
	"functional",
	"constraint",
	"compatibility",
	"documentation",
	"verification",
] as const;
export const AVO_OBLIGATION_EVIDENCE_KINDS = [
	"authoritative",
	"test",
	"build",
	"lint",
	"benchmark",
	"runtime",
	"filesystem",
	"git",
	"artifact",
	"external",
	"deterministic",
	"opinion",
] as const;
export const AVO_OBLIGATION_SOURCES = ["host_objective", "model_preregistered"] as const;
export const AVO_ASSUMPTION_STATUSES = ["open", "supported", "refuted"] as const;
export const AVO_EXPERIMENT_INFERENCE_VERSION = "student_t_95_two_stage_min_effect_v2";
export const AVO_EXPERIMENT_SELECTION_POLICY_VERSION = "project_fwer_online_bonferroni_v1";
export const AVO_EXPERIMENT_FAMILYWISE_ALPHA = 0.05;
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
export type AvoDeliveryPhase = (typeof AVO_DELIVERY_PHASES)[number];
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
export type AvoExperimentStage = (typeof AVO_EXPERIMENT_STAGES)[number];
export type AvoMetricDirection = (typeof AVO_METRIC_DIRECTIONS)[number];
export type AvoExperimentDecision = (typeof AVO_EXPERIMENT_DECISIONS)[number];
export type AvoObligationKind = (typeof AVO_OBLIGATION_KINDS)[number];
export type AvoObligationEvidenceKind = (typeof AVO_OBLIGATION_EVIDENCE_KINDS)[number];
export type AvoObligationSource = (typeof AVO_OBLIGATION_SOURCES)[number];
export type AvoAssumptionStatus = (typeof AVO_ASSUMPTION_STATUSES)[number];

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
	canonicalDeliveryText?: string;
	deterministicResult?: string;
	artifactPaths?: string[];
	artifactTargetDigest?: string;
	claims?: AvoCandidateClaim[];
	workspaceDigest?: string;
	workspaceHead?: string;
	workspaceMode?: "git" | "tree";
	workspaceChangedPaths?: string[];
	pythonProbeBundleDigest?: string;
	impactSurfaces?: AvoImpactSurface[];
	parentCandidateId?: string;
	obligationIds: string[];
	createdAt: string;
}

export interface AvoImpactSurface {
	surfaceId: string;
	kind: "source" | "public_api" | "configuration" | "documentation";
	paths: string[];
	requiredEvidenceGroups: AvoObligationEvidenceKind[][];
}

export interface AvoObligation {
	obligationId: string;
	description: string;
	kind: AvoObligationKind;
	critical: boolean;
	requiredEvidence: AvoObligationEvidenceKind[];
	source: AvoObligationSource;
	createdAt: string;
}

export interface AvoObligationCoverage {
	coverageId: string;
	obligationId: string;
	candidateId: string;
	evaluationIds: string[];
	evidenceRefs: string[];
	candidatePayloadDigest: string;
	recordedAt: string;
}

export interface AvoCriticalAssumption {
	assumptionId: string;
	statement: string;
	falsificationPlan: string;
	requiredEvidence: AvoObligationEvidenceKind[];
	critical: boolean;
	status: AvoAssumptionStatus;
	candidateId?: string;
	candidatePayloadDigest?: string;
	evaluationIds: string[];
	evidenceRefs: string[];
	createdAt: string;
	resolvedAt?: string;
}

export interface AvoCandidateClaim {
	claimId: string;
	claimText: string;
}

export interface AvoBaselineTestFile {
	path: string;
	sha256: string;
}

export interface AvoVerificationHarnessEntry {
	path: string;
	sha256: string;
	role: "test" | "fixture" | "config" | "plugin" | "runner";
}

export interface AvoVerificationHarnessManifest {
	policyVersion: 1;
	runnerFamily: "pytest" | "node_test" | "other";
	commandDigest: string;
	runnerIdentityDigest: string;
	environmentDigest: string;
	entries: AvoVerificationHarnessEntry[];
	absentControlPaths: string[];
	supported: boolean;
	unsupportedReasons: string[];
	digest: string;
}

export interface AvoVerificationBaseline {
	kind: "coding";
	contractDigest: string;
	workspaceRoot?: string;
	workspaceDigest: string;
	workspaceMode?: "git" | "tree";
	workspaceHead?: string;
	workspacePathDigests?: Record<string, string>;
	pythonCallableDimensions?: Record<string, Record<string, string[]>>;
	pythonCallableSignatureDigests?: Record<string, Record<string, string>>;
	pythonUninspectableCallables?: Record<string, string[]>;
	pythonUnsafePaths?: string[];
	taskSourcePaths?: string[];
	strictTaskSourcePaths?: boolean;
	testFiles: AvoBaselineTestFile[];
	userAcceptanceCommands: string[];
	executions: AvoBaselineExecution[];
	specContract?: {
		contractPath: string;
		contractContent: string;
		contractDigest: string;
		receiptPublicKeyDigest?: string;
		capturedAt: string;
	};
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
	observedTestIdentities: string[];
	observedBaselineTestFiles: string[];
	testTrustBasis: string;
	verificationHarness: AvoVerificationHarnessManifest;
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

export interface AvoExperimentPromotionPolicy {
	minimumPairedObservations: number;
	minimumAbsoluteEffect: number;
	minimumRelativeEffect: number;
}

export interface AvoExperimentSelectionReservation {
	policyVersion: typeof AVO_EXPERIMENT_SELECTION_POLICY_VERSION;
	familyId: string;
	reservationId: string;
	bindingDigest: string;
	attemptIndex: number;
	familywiseAlpha: number;
	allocatedAlpha: number;
	cumulativeAlpha: number;
	reservedAt: string;
}

export interface AvoExperimentSelectionEvidence extends AvoExperimentSelectionReservation {
	candidateId: string;
	oneSidedPValue: number;
	oneSidedConfidenceLevel: number;
	favorableLowerBound: number;
	passed: boolean;
}

export interface AvoExperimentPlan {
	stage: AvoExperimentStage;
	mode: AvoExperimentMode;
	candidateIds: string[];
	conditions: AvoExperimentCondition[];
	seeds: string[];
	pairing: AvoExperimentPairing;
	primaryMetric: string;
	metricDirection: AvoMetricDirection;
	baselineCandidateId?: string;
	confirmationOfExperimentId?: string;
	confirmationCandidateIdentityDigests?: Record<string, string>;
	selectionReservation?: AvoExperimentSelectionReservation;
	promotion: AvoExperimentPromotionPolicy;
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
	stage: AvoExperimentStage;
	confirmationOfExperimentId?: string;
	confirmationCandidateIdentityDigests?: Record<string, string>;
	minimumPairedObservationsForPromotion: number;
	minimumAbsoluteEffectForPromotion: number;
	minimumRelativeEffectForPromotion: number;
	requiredMinimumEffect?: number;
	selectionEvidence?: AvoExperimentSelectionEvidence;
	primaryMetric: string;
	metricDirection: AvoMetricDirection;
	candidateAggregates: AvoCandidateAggregate[];
	conditionAggregates: AvoConditionAggregate[];
	pairedComparisons: AvoPairedComparison[];
	conditionPairedComparisons: AvoConditionPairedComparison[];
	ranking: string[];
	provisionalBestCandidateId?: string;
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
	delivery: AvoDeliveryState;
	candidates: AvoCandidate[];
	evaluations: AvoEvaluationReceipt[];
	experiments: AvoExperiment[];
	trials: AvoTrial[];
	obligations: AvoObligation[];
	obligationCoverage: AvoObligationCoverage[];
	criticalAssumptions: AvoCriticalAssumption[];
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
		| "canonical_memory_repaired"
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
	attemptIndex?: number;
	inputDigest?: string;
	supersedesReviewId?: string;
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
	event: "memory_recall";
	satisfies: string[];
	channel: AvoMemoryRecallChannel;
	backend: "nooa-memory" | "host-fallback";
	status: "ok" | "fallback" | "failed";
	reason?: string;
	retrieval?: string;
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
	workspaceChangedPaths?: string[];
	pythonProbeBundleDigest?: string;
	parentCandidateId?: string;
	obligationIds?: string[];
}

export interface AvoObligationInput {
	obligationId: string;
	description: string;
	kind: AvoObligationKind;
	critical?: boolean;
	requiredEvidence: AvoObligationEvidenceKind[];
}

export interface AvoObligationCoverageInput {
	obligationId: string;
	candidateId: string;
	evaluationIds: string[];
}

export interface AvoCriticalAssumptionInput {
	assumptionId: string;
	statement: string;
	falsificationPlan: string;
	requiredEvidence: AvoObligationEvidenceKind[];
	critical?: boolean;
}

export interface AvoAssumptionResolutionInput {
	assumptionId: string;
	candidateId: string;
	evaluationIds: string[];
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

export interface AvoExperimentPromotionPolicyInput {
	minimumPairedObservations?: number;
	minimumAbsoluteEffect?: number;
	minimumRelativeEffect?: number;
}

export interface AvoExperimentPlanInput {
	stage?: AvoExperimentStage;
	mode?: AvoExperimentMode;
	candidateIds: string[];
	conditions: AvoExperimentConditionInput[];
	seeds: Array<string | number>;
	pairing?: AvoExperimentPairing;
	primaryMetric: string;
	metricDirection: AvoMetricDirection;
	baselineCandidateId?: string;
	confirmationOfExperimentId?: string;
	promotion?: AvoExperimentPromotionPolicyInput;
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

export interface AvoCanonicalDeliveryBinding {
	runId: string;
	candidateId: string;
	cycleId: string;
	deliveryDigest: string;
	stateVersion: number;
}

/**
 * Persisted canonical-delivery ownership. `accepted` protects the accepted
 * cycle while host verification/supervision finishes. `pending` is the
 * fail-closed terminal phase in which the only permitted model action is the
 * exact canonical delivery. The record deliberately binds every identity
 * needed to resume that phase after a process restart.
 */
export interface AvoDeliveryState {
	phase: AvoDeliveryPhase;
	runId: string;
	stateVersion?: number;
	candidateId?: string;
	cycleId?: string;
	memoryId?: string;
	deliveryDigest?: string;
	canonicalText?: string;
	acceptedAt?: string;
	gatePassedAt?: string;
	gateDigest?: string;
	gate?: AvoStopGate;
	deliveredAt?: string;
	failureCode?: string;
	failureReason?: string;
	failedAt?: string;
}

export interface AvoCanonicalDeliveryReadiness {
	ready: boolean;
	candidateId?: string;
	cycleId?: string;
	memoryId?: string;
	deliveryDigest?: string;
	reason?: string;
}

export interface AvoRunState {
	schemaVersion: typeof AVO_STATE_VERSION;
	sessionId: string;
	runId: string;
	stateVersion?: number;
	taskRuns: AvoTaskRunArchive[];
	objective?: string;
	verificationPolicy: AvoVerificationPolicy;
	verificationClass: AvoVerificationClass;
	verificationReasons: string[];
	environmentSelection: AvoEnvironmentSelection;
	horizonSelection: AvoHorizonSelection;
	routing: AvoRoutingDecision;
	status: AvoRunStatus;
	delivery: AvoDeliveryState;
	candidates: AvoCandidate[];
	workingAttempts?: AvoWorkingAttempt[];
	evaluations: AvoEvaluationReceipt[];
	experiments: AvoExperiment[];
	trials: AvoTrial[];
	obligations: AvoObligation[];
	obligationCoverage: AvoObligationCoverage[];
	criticalAssumptions: AvoCriticalAssumption[];
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

// ---------------------------------------------------------------------------
// Paper-Faithful AVO Core Types (arXiv:2603.24517)
// ---------------------------------------------------------------------------

export const AVO_PAPER_CORE_VERSION = "avo_paper_core_v1" as const;

export type AvoKnowledgeKind = "doc" | "specification" | "reference_kernel" | "constraint" | "note";

export interface AvoKnowledgeEntry {
	knowledgeId: string;
	title: string;
	kind: AvoKnowledgeKind;
	content: string;
	digest: string;
	uriOrPath?: string;
	metadata?: Record<string, unknown>;
}

export interface AvoCommittedSolution<T = unknown> {
	solutionId: string;
	solutionRef: string;
	payload?: T;
	scores: Record<string, number>;
	passedCorrectness: boolean;
	parentSolutionId?: string;
	trajectoryRef?: string;
	timestamp: string;
	metadata?: Record<string, unknown>;
}

export interface AvoLineage<T = unknown> {
	lineageId: string;
	entries: AvoCommittedSolution<T>[];
	bestSolutionId?: string;
	baselineScore?: Record<string, number>;
	metadata?: Record<string, unknown>;
}

export interface AvoScoreDimension {
	name: string;
	direction: "maximize" | "minimize";
	unit?: string;
	weight?: number;
}

export interface AvoScoringReceipt {
	scorerId: string;
	scorerVersion: string;
	scorerDigest: string;
	candidateDigest: string;
	passedCorrectness: boolean;
	scores: Record<string, number>;
	executionStatus: "pass" | "fail" | "error";
	logs?: string;
	logsRef?: string;
	timestamp: string;
}

export interface AvoScoringRunInput {
	candidateRef: string;
	content?: string;
	parameters?: Record<string, unknown>;
}

export interface AvoScoringUtility {
	scorerId: string;
	version: string;
	scorerDigest: string;
	scoreDimensions: AvoScoreDimension[];
	evaluate: (input: AvoScoringRunInput) => Promise<AvoScoringReceipt>;
}

export interface AvoVariationBudget {
	maxEvaluations?: number;
	maxWallClockSeconds?: number;
	maxEdits?: number;
}

export type AvoVariationActionType =
	| "inspect_lineage"
	| "inspect_knowledge"
	| "edit"
	| "evaluate"
	| "diagnose"
	| "repair";

export interface AvoWorkingAttempt {
	attemptId: string;
	actionType: AvoVariationActionType;
	timestamp: string;
	targetId?: string;
	reason?: string;
	candidateRef?: string;
	contentDigest?: string;
	receipt?: AvoScoringReceipt;
	diagnostics?: string;
}

export interface AvoStagnationPattern {
	isStagnating: boolean;
	consecutiveFailures: number;
	consecutiveRegressions: number;
	repeatedErrors: string[];
	rationale: string;
}

export interface AvoSupervisorSteering {
	detectedPattern: string;
	suggestedDirections: string[];
	rationale: string;
	timestamp: string;
}

export interface AvoVariationContract<T = unknown> {
	taskContext: string;
	lineage: AvoLineage<T>;
	knowledge: AvoKnowledgeEntry[];
	scorer: AvoScoringUtility;
	budget?: AvoVariationBudget;
	supervisor?: {
		enabled: boolean;
		maxConsecutiveFailuresBeforeIntervention?: number;
		steer?: (
			trajectory: AvoWorkingAttempt[],
			stagnation: AvoStagnationPattern,
		) => Promise<AvoSupervisorSteering | null>;
	};
	extensions?: {
		enableNooaMemory?: boolean;
		enableObligations?: boolean;
		enableCanonicalDelivery?: boolean;
	};
}

export interface AvoVariationResult<T = unknown> {
	status: "committed" | "uncommitted_exhausted" | "budget_exceeded";
	paperCoreVersion: typeof AVO_PAPER_CORE_VERSION;
	candidateSolution?: AvoCommittedSolution<T>;
	trajectory: AvoWorkingAttempt[];
	sampledLineageIds: string[];
	sampledKnowledgeIds: string[];
	evaluationCount: number;
	enabledExtensions: string[];
	supervisorInterventions: AvoSupervisorSteering[];
}
