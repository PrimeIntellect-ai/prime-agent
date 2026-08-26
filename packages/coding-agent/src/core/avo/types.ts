export const AVO_STATE_VERSION = 1;
export const AVO_SKILL_NAME = "avo";

export const AVO_ENVIRONMENTS = ["general", "coding", "research"] as const;
export const AVO_HORIZONS = ["direct", "iterative", "long"] as const;
export const AVO_AUTHORITIES = ["host", "environment", "external", "model_opinion"] as const;
export const AVO_EVALUATION_STATUSES = ["pass", "fail", "revise", "inconclusive"] as const;
export const AVO_RUN_STATUSES = ["active", "completed", "blocked", "failed"] as const;
export const AVO_CYCLE_OUTCOMES = ["accepted", "rejected", "revised", "inconclusive"] as const;
export const AVO_MEMORY_NAMESPACES = ["shared", ...AVO_ENVIRONMENTS] as const;

export type AvoEnvironment = (typeof AVO_ENVIRONMENTS)[number];
export type AvoEnvironmentSelection = "auto" | AvoEnvironment;
export type AvoHorizon = (typeof AVO_HORIZONS)[number];
export type AvoHorizonSelection = "auto" | AvoHorizon;
export type AvoEvaluationAuthority = (typeof AVO_AUTHORITIES)[number];
export type AvoEvaluationStatus = (typeof AVO_EVALUATION_STATUSES)[number];
export type AvoRunStatus = (typeof AVO_RUN_STATUSES)[number];
export type AvoCycleOutcome = (typeof AVO_CYCLE_OUTCOMES)[number];
export type AvoMemoryNamespace = (typeof AVO_MEMORY_NAMESPACES)[number];

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
	parentCandidateId?: string;
	createdAt: string;
}

export interface AvoEvaluationReceipt {
	evaluationId: string;
	candidateId: string;
	evaluatorId: string;
	status: AvoEvaluationStatus;
	authority: AvoEvaluationAuthority;
	evidenceRefs: string[];
	metrics: Record<string, number | string | boolean>;
	createdAt: string;
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
	type: string;
	title: string;
	content: string;
	tags: string[];
	importance: number;
	sourceIds: string[];
	createdAt: string;
	lastVerifiedAt?: string;
	invalidatedAt?: string;
}

export interface AvoMemoryReflection {
	reflectionId: string;
	trigger: "five_cycles" | "supervisor_intervention" | "candidate_acceptance" | "manual";
	cycleId?: string;
	report: Record<string, number | string | boolean>;
	archivedMemoryIds: string[];
	recordedAt: string;
}

export interface AvoCandidateInput {
	candidateId?: string;
	kind: string;
	summary: string;
	payload: unknown;
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

export interface AvoCycleInput {
	candidateId: string;
	evaluationIds?: string[];
	failureSignature?: string;
	trajectoryFingerprint?: string;
}

export interface AvoMemoryInput {
	memoryId?: string;
	namespace: AvoMemoryNamespace;
	type: string;
	title: string;
	content: string;
	tags?: string[];
	importance: number;
	sourceIds?: string[];
}

export interface AvoAdapterStateRef {
	adapterId: AvoEnvironment;
	statePath: string;
	schemaVersion?: number;
	updatedAt: string;
}

export interface AvoRunState {
	schemaVersion: typeof AVO_STATE_VERSION;
	runId: string;
	objective?: string;
	environmentSelection: AvoEnvironmentSelection;
	horizonSelection: AvoHorizonSelection;
	routing: AvoRoutingDecision;
	status: AvoRunStatus;
	candidates: AvoCandidate[];
	evaluations: AvoEvaluationReceipt[];
	cycles: AvoCycle[];
	lineage: AvoLineageEntry[];
	checkpoints: AvoCheckpoint[];
	memories: AvoMemory[];
	memoryReflections: AvoMemoryReflection[];
	supervisor?: AvoSupervisorBinding;
	supervision: AvoSupervisorReview[];
	adapterStateRef?: AvoAdapterStateRef;
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
	environment: AvoEnvironment;
	horizon: AvoHorizon;
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
