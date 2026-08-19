import {
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowDecisionRecord,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptCapability,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";
import type { WorkflowLearningHostWitness } from "../workflow/learning-controller.js";
import {
	AUTO_RESEARCH_PORTFOLIO_SCHEMA_VERSION,
	type AutoResearchPortfolioCandidate,
	type AutoResearchPortfolioContract,
	type AutoResearchPortfolioMeasurement,
	type AutoResearchPortfolioScope,
	parseAutoResearchPortfolioCandidate,
	parseAutoResearchPortfolioContract,
	parseAutoResearchPortfolioMeasurement,
} from "./portfolio-contracts.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const PORTFOLIO_LEARNING_CAPABILITY: WorkflowHostReceiptCapability = "workflow_learning_knowledge_promotion";

export const PORTFOLIO_LEARNING_SCOPES = Object.freeze(["goal", "domain", "global", "never"] as const);

export type PortfolioLearningScope = (typeof PORTFOLIO_LEARNING_SCOPES)[number];

export const PORTFOLIO_LEARNING_SCOPE_REJECTION_REASONS = Object.freeze([
	"parsed_contract_required",
	"schema_version_invalid",
	"invalid_enum",
	"unsupported_scope",
	"never_scope_requested",
	"candidate_invalid",
	"candidate_binding_mismatch",
	"measurement_missing",
	"measurement_binding_mismatch",
	"measurement_vector_mismatch",
	"measurement_repeatability_mismatch",
	"measurement_uncertainty_mismatch",
	"frontier_disposition_rejected",
	"frontier_disposition_exploratory",
	"originating_vector_evidence_missing",
	"scope_justification_missing",
	"dataset_closure_binding_missing",
	"dataset_closure_binding_mismatch",
	"manifest_generation_binding_missing",
	"manifest_generation_binding_mismatch",
	"evaluation_epoch_binding_missing",
	"evaluation_epoch_binding_mismatch",
	"acquisition_unknown_or_missing",
	"provider_empty",
	"partial_coverage",
	"holdout_row_feedback",
	"split_provenance_violation",
	"goal_closure_mismatch",
	"evaluator_closure_mismatch",
	"boundary_closure_mismatch",
	"domain_transfer_manifest_missing",
	"domain_transfer_evidence_missing",
	"domain_transfer_evidence_not_fresh",
	"domain_transfer_evidence_not_independent",
	"domain_transfer_evidence_failed",
	"solution_family_overlap",
	"transfer_attestation_missing",
	"transfer_confirmation_missing",
	"cross_domain_transfer_not_preregistered",
	"cross_domain_transfer_manifest_missing",
	"cross_domain_transfer_evidence_missing",
	"cross_domain_transfer_evidence_not_fresh",
	"cross_domain_transfer_evidence_not_independent",
	"cross_domain_transfer_evidence_failed",
	"protected_invariant_regression",
	"red_team_missing",
	"red_team_not_independent",
	"red_team_failed",
	"wider_scope_approval_missing",
	"wider_scope_self_approved",
	"manifest_restore_rehash_missing",
	"manifest_artifact_resolution_failed",
	"host_receipt_missing_or_invalid",
	"host_receipt_not_consumed",
	"host_receipt_replay",
	"host_witness_missing_or_invalid",
	"host_principal_authorization_invalid",
	"host_semantic_payload_invalid",
	"worker_attestation_invalid",
	"adjudication_binding_mismatch",
	"closed_input_violation",
	"forbidden_holdout_inputs",
	"forbidden_raw_outcomes",
	"forbidden_parameter_settings",
	"forbidden_safety_exception",
	"forbidden_one_off_patch",
	"forbidden_self_report",
	"boundary_violation",
	"scalar_effect_cannot_authorize_scope",
	"post_hoc_cross_goal_gain_unconfirmed",
] as const);

export type PortfolioLearningScopeRejectionReason = (typeof PORTFOLIO_LEARNING_SCOPE_REJECTION_REASONS)[number];

export type PortfolioLearningAcquisitionState = "complete" | "unknown" | "missing";
export type PortfolioLearningCoverageState = "complete" | "provider_empty" | "partial_coverage" | "unknown" | "missing";
export type PortfolioLearningHostRole =
	| "vector_evaluator"
	| "boundary_checker"
	| "invariant_checker"
	| "transfer_evaluator"
	| "cross_domain_evaluator"
	| "red_team"
	| "manifest_restorer"
	| "scope_adjudicator";

/** Evidence bound to a host receipt that the admission gate verifies and resolves. */
export interface PortfolioLearningHostEvidence {
	readonly artifactRef: WorkflowArtifactRef;
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly witness: WorkflowLearningHostWitness;
	readonly bindingDigest: string;
	readonly workspaceDigest: string;
	readonly workerId: string;
	readonly workerRole: PortfolioLearningHostRole;
	readonly workerAttestationDigest: string;
	readonly executionIdentity: string;
	readonly sessionId: string;
	readonly closureRootDigest: string;
	readonly evaluationEpoch: number;
	readonly acquisition: PortfolioLearningAcquisitionState;
	readonly coverage: PortfolioLearningCoverageState;
}

export interface PortfolioLearningVectorEvidence {
	readonly goalId: string;
	readonly domainId: string;
	readonly solutionFamilyId: string;
	readonly evaluatorDigest: string;
	readonly boundaryDigest: string;
	readonly evidence: readonly PortfolioLearningHostEvidence[];
}

export interface PortfolioLearningGoalClosure {
	readonly goalId: string;
	readonly evaluatorDigest: string;
	readonly boundaryDigest: string;
}

export interface PortfolioLearningGoalFamilyManifestEntry {
	readonly goalId: string;
	readonly domainId: string;
	readonly solutionFamilyId: string;
	/** Canonical identity digest signed by each transfer confirmation. */
	readonly familyDigest: string;
}

export interface PortfolioLearningDomainTransferEvidence {
	readonly goalId: string;
	readonly domainId: string;
	readonly solutionFamilyId: string;
	readonly freshness: "fresh" | "stale";
	readonly independence: "independent" | "overlapping";
	readonly disposition: "pass" | "failed";
	readonly manifestDigest: string;
	readonly preregistrationDigest: string;
	readonly confirmationDigest: string;
	readonly evidence: PortfolioLearningHostEvidence;
}

export interface PortfolioLearningCrossDomainManifestEntry {
	readonly goalId: string;
	readonly fromDomainId: string;
	readonly toDomainId: string;
	readonly manifestGeneration: number;
	readonly manifestDigest: string;
}

export interface PortfolioLearningCrossDomainTransferEvidence {
	readonly goalId: string;
	readonly fromDomainId: string;
	readonly toDomainId: string;
	readonly manifestGeneration: number;
	readonly manifestDigest: string;
	readonly freshness: "fresh" | "stale";
	readonly independence: "independent" | "overlapping";
	readonly disposition: "pass" | "failed";
	readonly confirmationDigest: string;
	readonly evidence: PortfolioLearningHostEvidence;
}

export interface PortfolioLearningCrossDomainTransfer {
	readonly preregistration: "fresh" | "post_hoc";
	readonly preregistrationDigest: string;
	readonly manifest: readonly PortfolioLearningCrossDomainManifestEntry[];
	readonly evidence: readonly PortfolioLearningCrossDomainTransferEvidence[];
}

export interface PortfolioLearningBoundaryEvidence {
	readonly boundaryId: string;
	readonly boundaryDigest: string;
	readonly disposition: "pass" | "failed" | "violation";
	readonly evidence: PortfolioLearningHostEvidence;
}

export interface PortfolioLearningInvariantEvidence {
	readonly invariantId: string;
	readonly disposition: "pass" | "regressed";
	readonly evidence: PortfolioLearningHostEvidence;
}

export interface PortfolioLearningRedTeamEvidence {
	readonly independence: "independent" | "overlapping";
	readonly disposition: "pass" | "failed";
	readonly evidence: PortfolioLearningHostEvidence;
}

export interface PortfolioLearningIndependentApproval {
	readonly decision: WorkflowDecisionRecord;
	readonly decisionWitness: WorkflowLearningHostWitness;
	readonly bindingDigest: string;
	readonly workerId: string;
	readonly workerRole: "scope_adjudicator";
	readonly workerAttestationDigest: string;
}

export interface PortfolioLearningRestoreRehashProof {
	readonly manifestGeneration: number;
	readonly manifestDigest: string;
	readonly independence: "independent" | "overlapping";
	readonly restoration: "verified" | "failed";
	readonly rehash: "verified" | "failed";
	readonly manifestArtifacts: readonly WorkflowArtifactRef[];
	readonly manifestArtifactDigest: string;
	readonly evidence: PortfolioLearningHostEvidence;
}

export interface PortfolioLearningFrontierDisposition {
	readonly status: "accepted" | "exploratory" | "rejected";
	readonly postHocCrossGoalGain: "none" | "unconfirmed" | "fresh_preregistered_confirmation";
}

export interface PortfolioLearningScopeAdmissionInput {
	readonly requestedScope: PortfolioLearningScope;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly workflowId: string;
	readonly currentRevision: number;
	readonly currentStateDigest: string;
	readonly currentStateHeadDigest: string;
	readonly currentStoreEpoch: number;
	readonly currentCoordinatorEpoch: number;
	readonly trustedNow: string;
	readonly contract: AutoResearchPortfolioContract;
	readonly candidate: AutoResearchPortfolioCandidate;
	readonly measurement: AutoResearchPortfolioMeasurement;
	readonly frontierDisposition: PortfolioLearningFrontierDisposition;
	readonly originatingVectorEvidence: PortfolioLearningVectorEvidence;
	readonly scopeJustification: string;
	readonly goalClosure: PortfolioLearningGoalClosure;
	readonly approvedGoalFamilyManifest: readonly PortfolioLearningGoalFamilyManifestEntry[];
	readonly domainTransferEvidence: readonly PortfolioLearningDomainTransferEvidence[];
	readonly crossDomainTransfer: PortfolioLearningCrossDomainTransfer | null;
	readonly boundaryEvidence: readonly PortfolioLearningBoundaryEvidence[];
	readonly invariantEvidence: readonly PortfolioLearningInvariantEvidence[];
	readonly redTeamEvidence: PortfolioLearningRedTeamEvidence | null;
	readonly independentApproval: PortfolioLearningIndependentApproval | null;
	readonly restoreRehashProofs: readonly PortfolioLearningRestoreRehashProof[];
}

export interface PortfolioLearningScopeDecision {
	readonly requestedScope: PortfolioLearningScope | null;
	readonly effectiveScope: PortfolioLearningScope;
	readonly canPromote: boolean;
	readonly exploratory: boolean;
	readonly rejectionReasons: readonly PortfolioLearningScopeRejectionReason[];
	readonly applicationCount: 0;
	readonly mutationCount: 0;
}

interface PortfolioLearningReceiptAudit {
	readonly receiptIds: Set<string>;
	readonly authorizations: Map<string, WorkflowHostPrincipalCapabilityAuthorization>;
}

const REASON_ORDER = new Map<PortfolioLearningScopeRejectionReason, number>(
	PORTFOLIO_LEARNING_SCOPE_REJECTION_REASONS.map((reason, index) => [reason, index]),
);

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === "string" || typeof key === "symbol") deepFreeze(Reflect.get(value, key) as T);
	}
	return Object.freeze(value);
}

function deeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
	if (typeof value !== "object" || value === null) return true;
	if (seen.has(value)) return true;
	if (!Object.isFrozen(value)) return false;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		if (!deeplyFrozen(Reflect.get(value, key), seen)) return false;
	}
	return true;
}

function nonEmpty(value: string): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function digest(value: string): boolean {
	return nonEmpty(value) && SHA256.test(value);
}

function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function safeDigestObject(value: unknown): string | null {
	try {
		return digestObject(value);
	} catch (_error: unknown) {
		return null;
	}
}

type PortfolioLearningEvidenceSemanticBinding =
	| {
			readonly kind: "originating_vector";
			readonly goalId: string;
			readonly domainId: string;
			readonly solutionFamilyId: string;
			readonly evaluatorDigest: string;
			readonly boundaryDigest: string;
	  }
	| {
			readonly kind: "boundary";
			readonly boundaryId: string;
			readonly boundaryDigest: string;
			readonly disposition: "pass" | "failed" | "violation";
	  }
	| {
			readonly kind: "invariant";
			readonly invariantId: string;
			readonly checkDigest: string;
			readonly scope: AutoResearchPortfolioScope;
			readonly disposition: "pass" | "regressed";
	  }
	| {
			readonly kind: "domain_transfer";
			readonly transferKey: string;
			readonly manifestDigest: string;
			readonly preregistrationDigest: string;
			readonly confirmationDigest: string;
			readonly familyDigest: string;
	  }
	| {
			readonly kind: "cross_domain_transfer";
			readonly transferKey: string;
			readonly preregistrationDigest: string;
			readonly confirmationDigest: string;
	  }
	| {
			readonly kind: "red_team";
			readonly independence: "independent";
			readonly disposition: "pass" | "failed";
	  }
	| {
			readonly kind: "manifest_restore";
			readonly manifestGeneration: number;
			readonly manifestDigest: string;
			readonly manifestArtifactDigest: string;
			readonly independence: "independent" | "overlapping";
			readonly restoration: "verified" | "failed";
			readonly rehash: "verified" | "failed";
	  }
	| {
			readonly kind: "adjudication";
			readonly decisionId: string;
			readonly decisionRevision: number;
			readonly operationDigest: string;
			readonly workerId: string;
			readonly workerRole: "scope_adjudicator";
	  };

function canonicalContractDigest(contract: AutoResearchPortfolioContract): string | null {
	return safeDigestObject(contract);
}

function canonicalCandidateDigest(candidate: AutoResearchPortfolioCandidate): string | null {
	try {
		return safeDigestObject({
			...candidate,
			goalIds: [...candidate.goalIds].sort((left, right) => left.localeCompare(right)),
			ancestry: {
				...candidate.ancestry,
				parentCandidateIds: [...candidate.ancestry.parentCandidateIds].sort((left, right) =>
					left.localeCompare(right),
				),
			},
			change: {
				...candidate.change,
				changedPaths: [...candidate.change.changedPaths].sort((left, right) => left.localeCompare(right)),
				parameterChanges: [...candidate.change.parameterChanges].sort((left, right) => left.localeCompare(right)),
			},
		});
	} catch (_error: unknown) {
		return null;
	}
}

function canonicalMeasurementDigest(measurement: AutoResearchPortfolioMeasurement): string | null {
	try {
		return safeDigestObject({
			...measurement,
			vector: [...measurement.vector].sort((left, right) => left.metricId.localeCompare(right.metricId)),
			evidenceDigests: [...measurement.evidenceDigests].sort((left, right) => left.localeCompare(right)),
		});
	} catch (_error: unknown) {
		return null;
	}
}

function boundaryDigest(boundary: AutoResearchPortfolioContract["hardBoundaries"][number]): string {
	return (
		safeDigestObject({
			boundaryId: boundary.boundaryId,
			statement: boundary.statement,
			scope: boundary.scope,
			locked: boundary.locked,
		}) ?? ""
	);
}

function familyDigest(entry: PortfolioLearningGoalFamilyManifestEntry): string {
	return (
		safeDigestObject({
			goalId: entry.goalId,
			domainId: entry.domainId,
			solutionFamilyId: entry.solutionFamilyId,
		}) ?? ""
	);
}

function domainManifestDigest(manifest: readonly PortfolioLearningGoalFamilyManifestEntry[]): string {
	return (
		safeDigestObject(
			[...manifest]
				.sort((left, right) => domainManifestKey(left).localeCompare(domainManifestKey(right)))
				.map((entry) => ({ ...entry })),
		) ?? ""
	);
}

function hostWorkerAttestationDigest(
	input: PortfolioLearningScopeAdmissionInput,
	workerId: string,
	workerRole: PortfolioLearningHostRole,
	artifactRef: WorkflowArtifactRef,
): string {
	return (
		safeDigestObject({
			kind: "portfolio-learning-host-worker-attestation",
			workflowId: input.workflowId,
			candidateId: input.candidate.candidateId,
			candidateDigest: canonicalCandidateDigest(input.candidate),
			contractDigest: canonicalContractDigest(input.contract),
			measurementDigest: canonicalMeasurementDigest(input.measurement),
			workerId: workerId ?? "",
			workerRole: workerRole ?? "",
			artifactRef: artifactRef ?? null,
		}) ?? ""
	);
}

function hostEvidenceBindingDigest(
	input: PortfolioLearningScopeAdmissionInput,
	evidence: PortfolioLearningHostEvidence,
	witnessKind: WorkflowLearningHostWitness["witnessKind"],
	semantic: PortfolioLearningEvidenceSemanticBinding,
): string {
	return (
		safeDigestObject({
			kind: "portfolio-learning-host-evidence-binding",
			workflowId: input.workflowId,
			candidateId: input.candidate.candidateId,
			candidateDigest: canonicalCandidateDigest(input.candidate),
			contractDigest: canonicalContractDigest(input.contract),
			measurementDigest: canonicalMeasurementDigest(input.measurement),
			workspaceDigest: input.measurement?.workspaceDigest ?? "",
			workerId: evidence.workerId ?? "",
			workerRole: evidence.workerRole ?? "",
			workerAttestationDigest: evidence.workerAttestationDigest ?? "",
			executionIdentity: evidence.executionIdentity ?? "",
			sessionId: evidence.sessionId ?? "",
			witnessKind,
			stage: evidence.witness?.stage ?? "",
			semantic,
			artifactRef: evidence.artifactRef ?? null,
			closureRootDigest: evidence.closureRootDigest ?? "",
			evaluationEpoch: evidence.evaluationEpoch ?? null,
			acquisition: evidence.acquisition ?? "",
			coverage: evidence.coverage ?? "",
		}) ?? ""
	);
}

function hostEvidencePayloadDigest(
	bindingDigest: string,
	receiptKind: WorkflowVerifiedHostReceipt["receiptKind"],
	semantic: PortfolioLearningEvidenceSemanticBinding,
	workerId: string,
	workerRole: PortfolioLearningHostRole,
	artifactRef: WorkflowArtifactRef,
): string {
	const payload = {
		kind: "portfolio-learning-host-evidence-payload",
		bindingDigest,
		receiptKind,
		semantic,
		workerId: workerId ?? "",
		workerRole,
		artifactRef: artifactRef ?? null,
	};
	return safeDigestObject(payload) ?? "";
}

function portfolioLearningSourceTargetBinding(input: PortfolioLearningScopeAdmissionInput): {
	readonly sourceGoalId: string;
	readonly sourceDomainId: string;
	readonly targetGoalIds: readonly string[];
	readonly targetDomainIds: readonly string[];
} {
	const targetGoalIds = [...input.candidate.goalIds].sort((left, right) => left.localeCompare(right));
	const targetDomainIds = [
		...new Set(
			targetGoalIds
				.map((goalId) => input.contract.goals.find((goal) => goal.goalId === goalId)?.domainId)
				.filter((domainId): domainId is string => domainId !== undefined),
		),
	].sort((left, right) => left.localeCompare(right));
	return {
		sourceGoalId: input.originatingVectorEvidence?.goalId ?? "",
		sourceDomainId: input.originatingVectorEvidence?.domainId ?? "",
		targetGoalIds,
		targetDomainIds,
	};
}

function portfolioLearningAuthorizationResourceDigest(
	input: PortfolioLearningScopeAdmissionInput,
	semantic: PortfolioLearningEvidenceSemanticBinding,
): string {
	return (
		safeDigestObject({
			kind: "portfolio-learning-knowledge-promotion-resource",
			capability: PORTFOLIO_LEARNING_CAPABILITY,
			requestedScope: input.requestedScope,
			contractDigest: canonicalContractDigest(input.contract),
			candidateDigest: canonicalCandidateDigest(input.candidate),
			measurementDigest: canonicalMeasurementDigest(input.measurement),
			goalClosure: input.goalClosure,
			sourceTarget: portfolioLearningSourceTargetBinding(input),
			semantic,
		}) ?? ""
	);
}

function portfolioLearningAuthorizationOperationDigest(
	input: PortfolioLearningScopeAdmissionInput,
	bindingDigest: string,
	resourceDigest: string,
	semantic: PortfolioLearningEvidenceSemanticBinding,
	witnessKind: WorkflowLearningHostWitness["witnessKind"],
	artifactRef: WorkflowArtifactRef,
	executionIdentity: string,
	sessionId: string,
): string {
	const epochRef: WorkflowEpochRef = {
		storeEpoch: input.currentStoreEpoch,
		coordinatorEpoch: input.currentCoordinatorEpoch,
	};
	return (
		safeDigestObject({
			kind: "portfolio-learning-knowledge-promotion-operation",
			capability: PORTFOLIO_LEARNING_CAPABILITY,
			workflowId: input.workflowId,
			requestedScope: input.requestedScope,
			bindingDigest,
			resourceDigest,
			semantic,
			witnessKind,
			artifactRef,
			stateDigest: input.currentStateDigest,
			stateHeadDigest: input.currentStateHeadDigest,
			revision: input.currentRevision,
			epochRef,
			executionIdentity,
			sessionId,
		}) ?? ""
	);
}

function adjudicationBindingDigest(
	input: PortfolioLearningScopeAdmissionInput,
	decision: WorkflowDecisionRecord,
	receipt: WorkflowVerifiedHostReceipt,
	workerId: string,
	workerRole: "scope_adjudicator",
): string {
	return (
		safeDigestObject({
			kind: "portfolio-learning-scope-adjudication",
			workflowId: input.workflowId,
			currentRevision: input.currentRevision,
			currentStateDigest: input.currentStateDigest,
			currentStateHeadDigest: input.currentStateHeadDigest,
			currentStoreEpoch: input.currentStoreEpoch,
			currentCoordinatorEpoch: input.currentCoordinatorEpoch,
			candidateId: input.candidate.candidateId,
			candidateDigest: canonicalCandidateDigest(input.candidate),
			contractDigest: canonicalContractDigest(input.contract),
			measurementDigest: canonicalMeasurementDigest(input.measurement),
			workspaceDigest: input.measurement?.workspaceDigest ?? "",
			decisionId: decision.decisionId,
			decisionRevision: decision.revision,
			operationDigest: decision.hostAdjudication.operationDigest,
			workerId,
			workerRole,
			artifactRef: receipt.artifactRef,
		}) ?? ""
	);
}

function adjudicationWorkerAttestationDigest(
	input: PortfolioLearningScopeAdmissionInput,
	decision: WorkflowDecisionRecord,
	receipt: WorkflowVerifiedHostReceipt,
	workerId: string,
	workerRole: "scope_adjudicator",
): string {
	return (
		safeDigestObject({
			kind: "portfolio-learning-scope-adjudicator-attestation",
			workflowId: input.workflowId,
			candidateId: input.candidate.candidateId,
			candidateDigest: canonicalCandidateDigest(input.candidate),
			contractDigest: canonicalContractDigest(input.contract),
			measurementDigest: canonicalMeasurementDigest(input.measurement),
			decisionId: decision.decisionId,
			decisionRevision: decision.revision,
			workerId,
			workerRole,
			artifactRef: receipt.artifactRef,
		}) ?? ""
	);
}

function addClosedShapeReason(
	value: object | null | undefined,
	keys: readonly string[],
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
): void {
	if (value === null || value === undefined || typeof value !== "object") {
		add("closed_input_violation");
		return;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		add("closed_input_violation");
	}
	const allowed = new Set(keys);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") {
			add("closed_input_violation");
			continue;
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
			add("closed_input_violation");
			continue;
		}
		if (allowed.has(key)) continue;
		if (["selfReport", "selfReported", "unsupportedSelfReport"].includes(key)) add("forbidden_self_report");
		else if (["holdoutInputs", "rawHoldoutInputs", "holdoutRows", "holdoutPerCaseFeedback"].includes(key))
			add("forbidden_holdout_inputs");
		else if (["rawOutcome", "rawOutcomes", "rawHoldoutOutcomes"].includes(key)) add("forbidden_raw_outcomes");
		else if (["parameterSettings", "parameterChanges", "parameterOnly"].includes(key))
			add("forbidden_parameter_settings");
		else if (["safetyException", "safetyExceptions"].includes(key)) add("forbidden_safety_exception");
		else if (["oneOffPatch", "oneOffPatches"].includes(key)) add("forbidden_one_off_patch");
		else add("closed_input_violation");
	}
}

function addClosedInputReasons(input: object, add: (reason: PortfolioLearningScopeRejectionReason) => void): void {
	if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
		add("closed_input_violation");
	}
	const allowed = new Set([
		"requestedScope",
		"receiptContext",
		"workflowId",
		"currentRevision",
		"currentStateDigest",
		"currentStateHeadDigest",
		"currentStoreEpoch",
		"currentCoordinatorEpoch",
		"trustedNow",
		"contract",
		"candidate",
		"measurement",
		"frontierDisposition",
		"originatingVectorEvidence",
		"scopeJustification",
		"goalClosure",
		"approvedGoalFamilyManifest",
		"domainTransferEvidence",
		"crossDomainTransfer",
		"boundaryEvidence",
		"invariantEvidence",
		"redTeamEvidence",
		"independentApproval",
		"restoreRehashProofs",
	]);
	for (const key of Reflect.ownKeys(input)) {
		if (typeof key !== "string") {
			add("closed_input_violation");
			continue;
		}
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
			add("closed_input_violation");
			continue;
		}
		if (allowed.has(key)) continue;
		if (["scalarEffectSize", "effectSize", "scalarEffect"].includes(key)) add("scalar_effect_cannot_authorize_scope");
		else if (["holdoutInputs", "rawHoldoutInputs", "holdoutRows", "holdoutPerCaseFeedback"].includes(key))
			add("forbidden_holdout_inputs");
		else if (["rawOutcome", "rawOutcomes", "rawHoldoutOutcomes"].includes(key)) add("forbidden_raw_outcomes");
		else if (["parameterSettings", "parameterChanges", "parameterOnly"].includes(key))
			add("forbidden_parameter_settings");
		else if (["safetyException", "safetyExceptions"].includes(key)) add("forbidden_safety_exception");
		else if (["oneOffPatch", "oneOffPatches"].includes(key)) add("forbidden_one_off_patch");
		else if (["selfReport", "selfReported", "unsupportedSelfReport"].includes(key)) add("forbidden_self_report");
		else add("closed_input_violation");
	}
}

function sameArtifactRef(
	left: WorkflowArtifactRef | null | undefined,
	right: WorkflowArtifactRef | null | undefined,
): boolean {
	return (
		typeof left === "object" &&
		left !== null &&
		typeof right === "object" &&
		right !== null &&
		left.artifactId === right.artifactId &&
		left.relativePath === right.relativePath &&
		left.digest === right.digest &&
		left.sizeBytes === right.sizeBytes &&
		left.sourceEventSequence === right.sourceEventSequence
	);
}

function validArtifactRef(ref: WorkflowArtifactRef | null | undefined): boolean {
	return (
		typeof ref === "object" &&
		ref !== null &&
		nonEmpty(ref.artifactId) &&
		nonEmpty(ref.relativePath) &&
		digest(ref.digest) &&
		Number.isSafeInteger(ref.sizeBytes) &&
		ref.sizeBytes >= 0 &&
		Number.isSafeInteger(ref.sourceEventSequence) &&
		ref.sourceEventSequence > 0
	);
}

function validReceiptShape(receipt: WorkflowVerifiedHostReceipt | null | undefined): boolean {
	if (receipt === null || receipt === undefined || typeof receipt !== "object") return false;
	if (
		typeof receipt.issuedAt !== "string" ||
		typeof receipt.validUntil !== "string" ||
		!validArtifactRef(receipt.artifactRef)
	)
		return false;
	const issuedAt = Date.parse(receipt.issuedAt);
	const validUntil = Date.parse(receipt.validUntil);
	return (
		receipt.oneUse === true &&
		nonEmpty(receipt.receiptId) &&
		nonEmpty(receipt.issuerId) &&
		nonEmpty(receipt.workflowId) &&
		nonEmpty(receipt.bindingDigest) &&
		nonEmpty(receipt.payloadDigest) &&
		validArtifactRef(receipt.artifactRef) &&
		receipt.signatureAlgorithm === "ed25519" &&
		nonEmpty(receipt.signature) &&
		nonEmpty(receipt.verificationDigest) &&
		receipt.artifactBytesDigest === receipt.artifactRef.digest &&
		positiveInteger(receipt.revision) &&
		nonEmpty(receipt.stateDigest) &&
		nonEmpty(receipt.keyId) &&
		Number.isFinite(issuedAt) &&
		Number.isFinite(validUntil) &&
		validUntil > issuedAt
	);
}

function hasExactKeys(value: object | null | undefined, keys: readonly string[]): boolean {
	if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.some((key) => typeof key !== "string")) return false;
		const actual = ownKeys
			.filter((key): key is string => typeof key === "string")
			.sort((left, right) => left.localeCompare(right));
		const expected = [...keys].sort((left, right) => left.localeCompare(right));
		return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
	} catch (_error: unknown) {
		return false;
	}
}

function validWitnessShape(
	witness: WorkflowLearningHostWitness | null | undefined,
	receipt: WorkflowVerifiedHostReceipt,
	authority: PortfolioLearningReceiptAuthority,
	bindingDigest: string,
	candidateId: string | null,
	witnessKind: WorkflowLearningHostWitness["witnessKind"],
): boolean {
	if (witness === null || witness === undefined || typeof witness !== "object") return false;
	if (!validArtifactRef(receipt.artifactRef)) return false;
	return (
		witness.witnessKind === witnessKind &&
		nonEmpty(witness.witnessId) &&
		witness.workflowId === authority.workflowId &&
		nonEmpty(witness.stage) &&
		witness.candidateId === candidateId &&
		sameArtifactRef(witness.evidenceRef, receipt.artifactRef) &&
		witness.payloadDigest === bindingDigest &&
		witness.bytesDigest === receipt.artifactRef.digest &&
		witness.bytesSize === receipt.artifactRef.sizeBytes &&
		witness.revision === authority.currentRevision &&
		witness.storeEpoch === authority.currentStoreEpoch &&
		witness.coordinatorEpoch === authority.currentCoordinatorEpoch &&
		nonEmpty(witness.stateHeadDigest) &&
		witness.stateHeadDigest === authority.currentStateHeadDigest &&
		witness.trustedNow === authority.trustedNow &&
		witness.oneUse === true
	);
}

function validReceiptAuthority(authority: PortfolioLearningReceiptAuthority): boolean {
	return (
		nonEmpty(authority.workflowId) &&
		positiveInteger(authority.currentRevision) &&
		nonEmpty(authority.currentStateDigest) &&
		nonEmpty(authority.currentStateHeadDigest) &&
		positiveInteger(authority.currentStoreEpoch) &&
		positiveInteger(authority.currentCoordinatorEpoch) &&
		typeof authority.trustedNow === "string" &&
		Number.isFinite(Date.parse(authority.trustedNow))
	);
}

function validPrincipalAuthorizationDecision(
	decision: WorkflowHostPrincipalCapabilityAuthorization | null | undefined,
	input: WorkflowHostPrincipalCapabilityAuthorizationInput,
): boolean {
	if (decision === null || decision === undefined || typeof decision !== "object") return false;
	if (
		!nonEmpty(decision.authenticatedPrincipal) ||
		!nonEmpty(decision.keyOwnerPrincipal) ||
		decision.authenticatedPrincipal !== decision.keyOwnerPrincipal ||
		!hasExactKeys(decision, [
			"authenticatedPrincipal",
			"keyOwnerPrincipal",
			"capability",
			"workflowId",
			"bindingDigest",
			"receipt",
			"stateDigest",
			"revision",
			"epochRef",
			"validity",
			"executionIdentity",
			"sessionId",
			"authorizationDigest",
		]) ||
		!hasExactKeys(decision.epochRef, ["storeEpoch", "coordinatorEpoch"]) ||
		!hasExactKeys(decision.validity, ["issuedAt", "validUntil"]) ||
		!hasExactKeys(decision.receipt, [
			"receiptKind",
			"oneUse",
			"receiptId",
			"issuerId",
			"workflowId",
			"bindingDigest",
			"payloadDigest",
			"artifactRef",
			"capabilityBinding",
			"issuedAt",
			"validUntil",
			"keyId",
			"signatureAlgorithm",
			"artifactBytesDigest",
			"stateDigest",
			"revision",
			"signature",
			"verificationDigest",
		]) ||
		!hasExactKeys(decision.receipt.capabilityBinding, [
			"capability",
			"resourceDigest",
			"operationDigest",
			"executionIdentity",
			"sessionId",
		]) ||
		decision.capability !== input.capability ||
		decision.workflowId !== input.workflowId ||
		decision.bindingDigest !== input.bindingDigest ||
		decision.stateDigest !== input.stateDigest ||
		decision.revision !== input.revision ||
		typeof decision.epochRef !== "object" ||
		decision.epochRef === null ||
		decision.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
		decision.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
		typeof decision.validity !== "object" ||
		decision.validity === null ||
		decision.validity.issuedAt !== input.receipt.issuedAt ||
		decision.validity.validUntil !== input.receipt.validUntil ||
		decision.executionIdentity !== input.executionIdentity ||
		decision.sessionId !== input.sessionId ||
		!digest(decision.authorizationDigest) ||
		!validReceiptShape(decision.receipt)
	)
		return false;
	try {
		return digestObject(decision.receipt) === digestObject(input.receipt);
	} catch (_error: unknown) {
		return false;
	}
}

interface PortfolioLearningReceiptAuthority {
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly workflowId: string;
	readonly currentRevision: number;
	readonly currentStateDigest: string;
	readonly currentStateHeadDigest: string;
	readonly currentStoreEpoch: number;
	readonly currentCoordinatorEpoch: number;
	readonly trustedNow: string;
}

function receiptAuthority(input: PortfolioLearningScopeAdmissionInput): PortfolioLearningReceiptAuthority {
	return input;
}

async function authorizePortfolioLearningReceipt(
	input: PortfolioLearningScopeAdmissionInput,
	authority: PortfolioLearningReceiptAuthority,
	receipt: WorkflowVerifiedHostReceipt,
	bindingDigest: string,
	semantic: PortfolioLearningEvidenceSemanticBinding,
	witnessKind: WorkflowLearningHostWitness["witnessKind"],
	executionIdentity: string,
	sessionId: string,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
): Promise<WorkflowHostPrincipalCapabilityAuthorization | null> {
	const resourceDigest = portfolioLearningAuthorizationResourceDigest(input, semantic);
	const operationDigest = portfolioLearningAuthorizationOperationDigest(
		input,
		bindingDigest,
		resourceDigest,
		semantic,
		witnessKind,
		receipt.artifactRef,
		executionIdentity,
		sessionId,
	);
	const capabilityBinding = receipt.capabilityBinding;
	if (
		capabilityBinding === null ||
		typeof capabilityBinding !== "object" ||
		capabilityBinding === undefined ||
		capabilityBinding.capability !== PORTFOLIO_LEARNING_CAPABILITY ||
		capabilityBinding.resourceDigest !== resourceDigest ||
		capabilityBinding.operationDigest !== operationDigest ||
		capabilityBinding.executionIdentity !== executionIdentity ||
		capabilityBinding.sessionId !== sessionId
	) {
		add("host_principal_authorization_invalid");
		return null;
	}
	const authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput = {
		receipt,
		workflowId: authority.workflowId,
		bindingDigest,
		resourceDigest,
		operationDigest,
		stateDigest: authority.currentStateDigest,
		revision: authority.currentRevision,
		epochRef: {
			storeEpoch: authority.currentStoreEpoch,
			coordinatorEpoch: authority.currentCoordinatorEpoch,
		},
		capability: PORTFOLIO_LEARNING_CAPABILITY,
		executionIdentity,
		sessionId,
	};
	try {
		const decision = await authority.receiptContext.principalAuthorizer.authorize(authorizationInput);
		if (!validPrincipalAuthorizationDecision(decision, authorizationInput)) {
			add("host_principal_authorization_invalid");
			return null;
		}
		return decision;
	} catch (_error: unknown) {
		add("host_principal_authorization_invalid");
		return null;
	}
}

async function verifyReceiptAndWitness(
	input: PortfolioLearningScopeAdmissionInput,
	authority: PortfolioLearningReceiptAuthority,
	receipt: WorkflowVerifiedHostReceipt | null | undefined,
	bindingDigest: string,
	witness: WorkflowLearningHostWitness | null | undefined,
	candidateId: string | null,
	witnessKind: WorkflowLearningHostWitness["witnessKind"],
	semantic: PortfolioLearningEvidenceSemanticBinding,
	workerId: string,
	workerRole: PortfolioLearningHostRole,
	executionIdentity: string,
	sessionId: string,
	audit: PortfolioLearningReceiptAudit,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
): Promise<boolean> {
	let valid = true;
	const expectedReceiptKind: WorkflowVerifiedHostReceipt["receiptKind"] =
		witnessKind === "decision" ? "adjudication" : "artifact";
	if (!validReceiptAuthority(authority)) {
		add("host_witness_missing_or_invalid");
		valid = false;
	}
	if (!validReceiptShape(receipt) || !digest(bindingDigest) || receipt?.bindingDigest !== bindingDigest) {
		add("host_receipt_missing_or_invalid");
		valid = false;
	}
	if (receipt === null || receipt === undefined || typeof receipt !== "object") {
		add("host_receipt_missing_or_invalid");
		add("host_witness_missing_or_invalid");
		return false;
	}
	if (receipt.receiptKind !== expectedReceiptKind) {
		add("host_semantic_payload_invalid");
		valid = false;
	}
	if (
		receipt.payloadDigest !==
		hostEvidencePayloadDigest(bindingDigest, receipt.receiptKind, semantic, workerId, workerRole, receipt.artifactRef)
	) {
		add("host_semantic_payload_invalid");
		valid = false;
	}
	const issuedAt = Date.parse(receipt.issuedAt);
	const validUntil = Date.parse(receipt.validUntil);
	const trustedNow = Date.parse(authority.trustedNow);
	if (
		!Number.isFinite(issuedAt) ||
		!Number.isFinite(validUntil) ||
		!Number.isFinite(trustedNow) ||
		issuedAt > trustedNow ||
		trustedNow >= validUntil
	) {
		add("host_receipt_missing_or_invalid");
		valid = false;
	}
	const replay = audit.receiptIds.has(receipt.receiptId);
	if (digest(bindingDigest)) {
		try {
			const verified = await resolveAndVerifyWorkflowHostReceipt({
				context: authority.receiptContext,
				workflowId: authority.workflowId,
				expectedBindingDigest: bindingDigest,
				receipt,
				currentStateDigest: authority.currentStateDigest,
				currentRevision: authority.currentRevision,
				trustedNow: authority.trustedNow,
			});
			if (
				verified.receiptId !== receipt.receiptId ||
				verified.bindingDigest !== bindingDigest ||
				!sameArtifactRef(verified.artifactRef, receipt.artifactRef) ||
				digestObject(verified) !== digestObject(receipt)
			) {
				add("host_receipt_missing_or_invalid");
				valid = false;
			}
		} catch (_error: unknown) {
			add("host_receipt_missing_or_invalid");
			valid = false;
		}
	} else {
		valid = false;
	}
	try {
		const artifact = await authority.receiptContext.artifactResolver.resolve(receipt.artifactRef);
		const bytes = new Uint8Array(artifact.bytes);
		if (
			artifact.exists !== true ||
			artifact.envelope.immutable !== true ||
			!sameArtifactRef(artifact.envelope.ref, receipt.artifactRef) ||
			artifact.verifiedDigest !== receipt.artifactRef.digest ||
			artifact.verifiedSizeBytes !== receipt.artifactRef.sizeBytes ||
			bytes.byteLength !== receipt.artifactRef.sizeBytes ||
			sha256Hex(bytes) !== receipt.artifactRef.digest ||
			artifact.envelope.payloadKind !== "evidence"
		) {
			add("host_semantic_payload_invalid");
			valid = false;
		}
	} catch (_error: unknown) {
		add("host_semantic_payload_invalid");
		valid = false;
	}
	if (receipt.oneUse !== true) valid = false;
	if (receipt.oneUse === true && digest(bindingDigest)) {
		try {
			const consumption = await authority.receiptContext.receiptResolver.resolveConsumptionWitness({
				receiptId: receipt.receiptId,
				workflowId: authority.workflowId,
				expectedBindingDigest: bindingDigest,
			});
			if (
				consumption.receiptId !== receipt.receiptId ||
				consumption.workflowId !== authority.workflowId ||
				consumption.bindingDigest !== bindingDigest ||
				!Number.isSafeInteger(consumption.consumptionSequence) ||
				consumption.consumptionSequence <= 0 ||
				!Number.isFinite(Date.parse(consumption.consumedAt)) ||
				Date.parse(consumption.consumedAt) > trustedNow
			) {
				add("host_receipt_not_consumed");
				valid = false;
			}
		} catch (_error: unknown) {
			add("host_receipt_not_consumed");
			valid = false;
		}
	} else {
		add("host_receipt_not_consumed");
		valid = false;
	}
	if (!validWitnessShape(witness, receipt, authority, bindingDigest, candidateId, witnessKind)) {
		add("host_witness_missing_or_invalid");
		valid = false;
	}
	if (valid && !replay) {
		const authorization = await authorizePortfolioLearningReceipt(
			input,
			authority,
			receipt,
			bindingDigest,
			semantic,
			witnessKind,
			executionIdentity,
			sessionId,
			add,
		);
		if (authorization === null) valid = false;
		else audit.authorizations.set(receipt.receiptId, authorization);
	}
	if (replay) {
		add("host_receipt_replay");
		valid = false;
	} else if (valid) {
		audit.receiptIds.add(receipt.receiptId);
	}
	return valid;
}

function orderedReasons(
	reasons: ReadonlySet<PortfolioLearningScopeRejectionReason>,
): readonly PortfolioLearningScopeRejectionReason[] {
	return [...reasons].sort(
		(left, right) =>
			(REASON_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) - (REASON_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
	);
}

function addParsedRecordReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
): void {
	const contractKeys = [
		"schemaVersion",
		"contractId",
		"objective",
		"acceptanceRequirements",
		"goals",
		"goalRelations",
		"lexicographicTiers",
		"hardBoundaries",
		"invariants",
		"nonGoals",
		"budgets",
		"safety",
		"inputManifest",
		"scopePartitions",
		"terminalScope",
		"learningScope",
	] as const;
	const candidateKeys = [
		"candidateId",
		"goalIds",
		"solutionFamily",
		"ancestry",
		"causalMechanism",
		"change",
		"scope",
	] as const;
	const measurementKeys = [
		"measurementId",
		"goalId",
		"candidateId",
		"scope",
		"kind",
		"vector",
		"repeatIndex",
		"sampleCount",
		"evaluationEpoch",
		"inputManifestDigest",
		"splitClosureRoots",
		"confidenceInterval",
		"variance",
		"runCount",
		"aggregation",
		"inputDigest",
		"evaluatorDigest",
		"parserDigest",
		"commandDigest",
		"workspaceDigest",
		"evidenceDigests",
		"measuredAt",
		"measurementDigest",
	] as const;
	addClosedShapeReason(input.contract, contractKeys, add);
	addClosedShapeReason(input.candidate, candidateKeys, add);
	addClosedShapeReason(input.measurement, measurementKeys, add);
	try {
		parseAutoResearchPortfolioContract(structuredClone(input.contract));
	} catch (_error: unknown) {
		add("parsed_contract_required");
	}
	try {
		parseAutoResearchPortfolioCandidate(structuredClone(input.candidate));
	} catch (_error: unknown) {
		add("candidate_invalid");
	}
	if (!deeplyFrozen(input.contract) || canonicalContractDigest(input.contract) === null)
		add("parsed_contract_required");
	if (!deeplyFrozen(input.candidate) || canonicalCandidateDigest(input.candidate) === null) add("candidate_invalid");
	if (!deeplyFrozen(input.measurement) || canonicalMeasurementDigest(input.measurement) === null)
		add("measurement_missing");
}

function addMeasurementReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
): void {
	const goalId = input.originatingVectorEvidence?.goalId;
	const goal = input.contract.goals.find((entry) => entry.goalId === goalId);
	const measurement = input.measurement;
	if (goal === undefined || measurement === undefined || measurement === null) {
		add("measurement_missing");
		return;
	}
	if (
		typeof measurement !== "object" ||
		!Array.isArray(measurement.vector) ||
		measurement.confidenceInterval === null ||
		typeof measurement.confidenceInterval !== "object"
	) {
		add("measurement_missing");
		return;
	}
	try {
		parseAutoResearchPortfolioMeasurement(structuredClone(measurement), {
			confidenceLevel: goal.uncertainty.confidence,
			evaluationEpoch: input.contract.inputManifest.evaluationEpoch,
			inputManifestDigest: input.contract.inputManifest.manifestDigest,
			splitClosureRoots: input.contract.inputManifest.splitClosureRoots,
		});
	} catch (_error: unknown) {
		add("measurement_binding_mismatch");
	}
	if (measurement.goalId !== goal.goalId || measurement.candidateId !== input.candidate.candidateId) {
		add("measurement_binding_mismatch");
	}
	if (measurement.scope !== "terminal" || measurement.kind !== "candidate") add("invalid_enum");
	const metricIds = [...goal.metrics].map((entry) => entry.metricId).sort();
	const measurementMetricIds = [...measurement.vector].map((entry) => entry.metricId).sort();
	if (
		metricIds.length !== measurementMetricIds.length ||
		metricIds.some((metricId, index) => metricId !== measurementMetricIds[index])
	)
		add("measurement_vector_mismatch");
	if (
		measurement.evaluatorDigest !== goal.evaluator.evaluatorDigest ||
		measurement.parserDigest !== goal.parser.parserDigest ||
		measurement.commandDigest !== goal.command.commandDigest ||
		!digest(measurement.workspaceDigest)
	)
		add("measurement_binding_mismatch");
	if (
		measurement.runCount < goal.repeatability.runs ||
		measurement.aggregation !== goal.repeatability.aggregation ||
		measurement.variance > goal.repeatability.maxVariance
	)
		add("measurement_repeatability_mismatch");
	if (
		measurement.confidenceInterval.level !== goal.uncertainty.confidence ||
		measurement.confidenceInterval.upper - measurement.confidenceInterval.lower > goal.uncertainty.maxWidth ||
		measurement.variance > goal.uncertainty.maxVariance
	)
		add("measurement_uncertainty_mismatch");
}

function addDatasetReasons(
	contract: AutoResearchPortfolioContract,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
): void {
	const manifest = contract.inputManifest;
	if (manifest.locked !== true || !digest(manifest.closureRootDigest) || !digest(manifest.manifestDigest)) {
		add("dataset_closure_binding_missing");
	}
	if (!positiveInteger(manifest.evaluationEpoch)) add("evaluation_epoch_binding_missing");
	if (!positiveInteger(manifest.manifestRevision)) add("manifest_generation_binding_missing");
	if (
		positiveInteger(manifest.evaluationEpoch) &&
		positiveInteger(manifest.manifestRevision) &&
		manifest.manifestRevision > manifest.evaluationEpoch
	)
		add("evaluation_epoch_binding_mismatch");
	if (
		!digest(manifest.splitClosureRoots.training) ||
		!digest(manifest.splitClosureRoots.validation) ||
		!digest(manifest.splitClosureRoots.holdout)
	)
		add("dataset_closure_binding_missing");
	const splitManifests = [manifest.training, manifest.validation, manifest.holdout];
	for (const splitManifest of splitManifests) {
		if (splitManifest.locked !== true || !digest(splitManifest.closureRootDigest))
			add("dataset_closure_binding_missing");
		if (splitManifest.closureRootDigest !== manifest.splitClosureRoots[splitManifest.split])
			add("dataset_closure_binding_mismatch");
	}
	const artifacts = splitManifests.flatMap((splitManifest) => splitManifest.artifacts);
	for (const artifact of artifacts) {
		if (artifact.coverage === "provider_empty") add("provider_empty");
		if (artifact.coverage === "partial_coverage") add("partial_coverage");
		if (artifact.coverage === "unknown" || artifact.coverage === "missing") add("acquisition_unknown_or_missing");
		if (artifact.validationResult !== "passed" || artifact.gapClassification !== "none")
			add("split_provenance_violation");
		if (artifact.lifecycle !== "sealed") add("split_provenance_violation");
		if (
			artifact.restoreVerification.locked !== true ||
			artifact.restoreVerification.independentlyRestored !== true ||
			artifact.restoreVerification.independentlyRehashed !== true ||
			!digest(artifact.restoreVerification.verificationEvidenceDigest ?? "")
		)
			add("manifest_restore_rehash_missing");
		if (
			!digest(artifact.closureRootDigest) ||
			artifact.closureRootDigest !== manifest.splitClosureRoots[artifact.split] ||
			!digest(artifact.provenance.ingestDigest) ||
			!digest(artifact.provenance.lineageDigest) ||
			!digest(artifact.provenance.provenanceReceiptDigest)
		)
			add("split_provenance_violation");
	}
	const modelAccess = manifest.modelAccess;
	if (
		modelAccess.holdoutRowsVisible !== false ||
		modelAccess.holdoutPerCaseFeedback !== false ||
		modelAccess.holdoutReturns !== "aggregate_signed_evidence_only" ||
		modelAccess.signedAggregateEvidence !== true
	) {
		add("holdout_row_feedback");
		add("forbidden_holdout_inputs");
	}
}

async function addHostEvidenceReasons(
	input: PortfolioLearningScopeAdmissionInput,
	evidence: PortfolioLearningHostEvidence | null,
	authority: PortfolioLearningReceiptAuthority,
	candidateId: string | null,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
	audit: PortfolioLearningReceiptAudit,
	semantic: PortfolioLearningEvidenceSemanticBinding,
	witnessKind: WorkflowLearningHostWitness["witnessKind"] = "receipt",
): Promise<boolean> {
	if (evidence === null || evidence === undefined) {
		add("host_receipt_missing_or_invalid");
		add("host_witness_missing_or_invalid");
		return false;
	}
	addClosedShapeReason(
		evidence,
		[
			"artifactRef",
			"receipt",
			"witness",
			"bindingDigest",
			"workspaceDigest",
			"workerId",
			"workerRole",
			"workerAttestationDigest",
			"executionIdentity",
			"sessionId",
			"closureRootDigest",
			"evaluationEpoch",
			"acquisition",
			"coverage",
		],
		add,
	);
	addClosedShapeReason(
		evidence.artifactRef,
		["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"],
		add,
	);
	addClosedShapeReason(
		evidence.receipt,
		[
			"receiptKind",
			"oneUse",
			"receiptId",
			"issuerId",
			"workflowId",
			"bindingDigest",
			"payloadDigest",
			"artifactRef",
			"capabilityBinding",
			"issuedAt",
			"validUntil",
			"keyId",
			"signatureAlgorithm",
			"artifactBytesDigest",
			"stateDigest",
			"revision",
			"signature",
			"verificationDigest",
		],
		add,
	);
	if (evidence.receipt?.capabilityBinding !== undefined)
		addClosedShapeReason(
			evidence.receipt.capabilityBinding,
			["capability", "resourceDigest", "operationDigest", "executionIdentity", "sessionId"],
			add,
		);
	addClosedShapeReason(
		evidence.witness,
		[
			"witnessId",
			"witnessKind",
			"workflowId",
			"stage",
			"candidateId",
			"evidenceRef",
			"payloadDigest",
			"bytesDigest",
			"bytesSize",
			"revision",
			"storeEpoch",
			"coordinatorEpoch",
			"stateHeadDigest",
			"trustedNow",
			"oneUse",
		],
		add,
	);
	const manifest = input.contract.inputManifest;
	let valid = true;
	const expectedRole: PortfolioLearningHostRole =
		semantic.kind === "originating_vector"
			? "vector_evaluator"
			: semantic.kind === "boundary"
				? "boundary_checker"
				: semantic.kind === "invariant"
					? "invariant_checker"
					: semantic.kind === "domain_transfer"
						? "transfer_evaluator"
						: semantic.kind === "cross_domain_transfer"
							? "cross_domain_evaluator"
							: semantic.kind === "red_team"
								? "red_team"
								: "manifest_restorer";
	if (evidence.workerRole !== expectedRole || !nonEmpty(evidence.executionIdentity) || !nonEmpty(evidence.sessionId)) {
		add("worker_attestation_invalid");
		valid = false;
	}
	if (
		evidence.workerAttestationDigest !==
		hostWorkerAttestationDigest(input, evidence.workerId, evidence.workerRole, evidence.artifactRef)
	) {
		add("worker_attestation_invalid");
		valid = false;
	}
	if (evidence.workspaceDigest !== input.measurement?.workspaceDigest) {
		add("measurement_binding_mismatch");
		valid = false;
	}
	if (evidence.acquisition !== "complete" && evidence.acquisition !== "unknown" && evidence.acquisition !== "missing")
		add("invalid_enum");
	if (
		evidence.coverage !== "complete" &&
		evidence.coverage !== "provider_empty" &&
		evidence.coverage !== "partial_coverage" &&
		evidence.coverage !== "unknown" &&
		evidence.coverage !== "missing"
	)
		add("invalid_enum");
	if (evidence.acquisition !== "complete") {
		add("acquisition_unknown_or_missing");
		valid = false;
	}
	if (evidence.coverage === "provider_empty") add("provider_empty");
	if (evidence.coverage === "partial_coverage") add("partial_coverage");
	if (evidence.coverage === "unknown" || evidence.coverage === "missing") {
		add("acquisition_unknown_or_missing");
		valid = false;
	}
	if (!digest(evidence.closureRootDigest)) {
		add("dataset_closure_binding_missing");
		valid = false;
	} else if (evidence.closureRootDigest !== manifest.closureRootDigest) {
		add("dataset_closure_binding_mismatch");
		valid = false;
	}
	if (!positiveInteger(evidence.evaluationEpoch)) {
		add("evaluation_epoch_binding_missing");
		valid = false;
	} else if (evidence.evaluationEpoch !== manifest.evaluationEpoch) {
		add("evaluation_epoch_binding_mismatch");
		valid = false;
	}
	if (
		!validArtifactRef(evidence.artifactRef) ||
		!sameArtifactRef(evidence.artifactRef, evidence.receipt?.artifactRef) ||
		evidence.receipt?.receiptKind !== "artifact" ||
		evidence.bindingDigest !== hostEvidenceBindingDigest(input, evidence, witnessKind, semantic)
	) {
		add("host_receipt_missing_or_invalid");
		valid = false;
	}
	const receiptValid = await verifyReceiptAndWitness(
		input,
		authority,
		evidence.receipt,
		evidence.bindingDigest,
		evidence.witness,
		candidateId,
		witnessKind,
		semantic,
		evidence.workerId,
		evidence.workerRole,
		evidence.executionIdentity,
		evidence.sessionId,
		audit,
		add,
	);
	return valid && receiptValid;
}

async function addOriginatingEvidenceReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
	audit: PortfolioLearningReceiptAudit,
): Promise<void> {
	const vector = input.originatingVectorEvidence;
	if (vector === undefined || vector === null) {
		add("originating_vector_evidence_missing");
		if (!nonEmpty(input.scopeJustification)) add("scope_justification_missing");
		return;
	}
	addClosedShapeReason(
		vector,
		["goalId", "domainId", "solutionFamilyId", "evaluatorDigest", "boundaryDigest", "evidence"],
		add,
	);
	if (
		!nonEmpty(vector.goalId) ||
		!nonEmpty(vector.domainId) ||
		!nonEmpty(vector.solutionFamilyId) ||
		!digest(vector.evaluatorDigest) ||
		!digest(vector.boundaryDigest) ||
		vector.evidence.length === 0
	) {
		add("originating_vector_evidence_missing");
	}
	const goal = input.contract.goals.find((entry) => entry.goalId === vector.goalId);
	if (
		goal === undefined ||
		goal.domainId !== vector.domainId ||
		goal.evaluator.evaluatorDigest !== vector.evaluatorDigest ||
		!input.contract.hardBoundaries.some((boundary) => boundaryDigest(boundary) === vector.boundaryDigest)
	)
		add("boundary_closure_mismatch");
	if (vector.solutionFamilyId !== input.candidate.solutionFamily.familyId) add("solution_family_overlap");
	if (!input.candidate.goalIds.includes(vector.goalId)) add("goal_closure_mismatch");
	for (const evidence of vector.evidence) {
		await addHostEvidenceReasons(input, evidence, receiptAuthority(input), input.candidate.candidateId, add, audit, {
			kind: "originating_vector",
			goalId: vector.goalId,
			domainId: vector.domainId,
			solutionFamilyId: vector.solutionFamilyId,
			evaluatorDigest: vector.evaluatorDigest,
			boundaryDigest: vector.boundaryDigest,
		});
	}
	if (!nonEmpty(input.scopeJustification)) add("scope_justification_missing");
}

function addCandidateReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
): void {
	if (
		input.candidate === null ||
		typeof input.candidate !== "object" ||
		input.candidate.causalMechanism === null ||
		typeof input.candidate.causalMechanism !== "object" ||
		input.candidate.change === null ||
		typeof input.candidate.change !== "object" ||
		input.candidate.solutionFamily === null ||
		typeof input.candidate.solutionFamily !== "object" ||
		input.candidate.ancestry === null ||
		typeof input.candidate.ancestry !== "object" ||
		!Array.isArray(input.candidate.goalIds) ||
		!Array.isArray(input.candidate.change.changedPaths) ||
		!Array.isArray(input.candidate.change.parameterChanges) ||
		!Array.isArray(input.candidate.ancestry.parentCandidateIds)
	) {
		add("candidate_invalid");
		return;
	}
	addClosedShapeReason(input.frontierDisposition, ["status", "postHocCrossGoalGain"], add);
	addClosedShapeReason(
		input.candidate,
		["candidateId", "goalIds", "solutionFamily", "ancestry", "causalMechanism", "change", "scope"],
		add,
	);
	if (
		!nonEmpty(input.candidate.candidateId) ||
		input.candidate.goalIds.length === 0 ||
		!nonEmpty(input.candidate.solutionFamily.familyId)
	)
		add("candidate_invalid");
	const expectedMechanismDigest = safeDigestObject({
		solutionFamily: input.candidate.solutionFamily,
		hypothesis: input.candidate.causalMechanism.hypothesis,
		intervention: input.candidate.causalMechanism.intervention,
		expectedObservation: input.candidate.causalMechanism.expectedObservation,
		falsificationCondition: input.candidate.causalMechanism.falsificationCondition,
	});
	const expectedChangeDigest = safeDigestObject({
		kind: input.candidate.change.kind,
		changedPaths: input.candidate.change.changedPaths,
		parameterChanges: input.candidate.change.parameterChanges,
	});
	if (
		input.candidate.causalMechanism.mechanismDigest !== expectedMechanismDigest ||
		input.candidate.change.changeDigest !== expectedChangeDigest
	)
		add("candidate_invalid");
	for (const goalId of input.candidate.goalIds) {
		if (!input.contract.goals.some((entry) => entry.goalId === goalId)) add("candidate_invalid");
	}
	if (input.candidate.scope !== "terminal" || input.candidate.change.kind !== "mechanism") add("boundary_violation");
	if (input.candidate.change.parameterChanges.length > 0) add("forbidden_parameter_settings");
	if (
		input.frontierDisposition === null ||
		typeof input.frontierDisposition !== "object" ||
		(input.frontierDisposition.status !== "accepted" &&
			input.frontierDisposition.status !== "exploratory" &&
			input.frontierDisposition.status !== "rejected") ||
		(input.frontierDisposition.postHocCrossGoalGain !== "none" &&
			input.frontierDisposition.postHocCrossGoalGain !== "unconfirmed" &&
			input.frontierDisposition.postHocCrossGoalGain !== "fresh_preregistered_confirmation")
	)
		add("invalid_enum");
	if (input.frontierDisposition?.status === "rejected") add("frontier_disposition_rejected");
	if (input.frontierDisposition?.status === "exploratory") add("frontier_disposition_exploratory");
}

function addGoalClosureReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
): void {
	const vector = input.originatingVectorEvidence;
	if (vector === undefined || vector === null) {
		add("originating_vector_evidence_missing");
		return;
	}
	addClosedShapeReason(input.goalClosure, ["goalId", "evaluatorDigest", "boundaryDigest"], add);
	const closure = input.goalClosure;
	if (closure === null || closure === undefined || typeof closure !== "object") {
		add("goal_closure_mismatch");
		return;
	}
	if (closure.goalId !== vector.goalId) add("goal_closure_mismatch");
	if (closure.evaluatorDigest !== vector.evaluatorDigest) add("evaluator_closure_mismatch");
	if (closure.boundaryDigest !== vector.boundaryDigest) add("boundary_closure_mismatch");
	if (
		input.requestedScope === "goal" &&
		(input.candidate.goalIds.length !== 1 || input.candidate.goalIds[0] !== vector.goalId)
	)
		add("goal_closure_mismatch");
	const goal = input.contract.goals.find((entry) => entry.goalId === vector.goalId);
	if (
		goal === undefined ||
		goal.evaluator.evaluatorDigest !== closure.evaluatorDigest ||
		goal.domainId !== vector.domainId ||
		!input.contract.hardBoundaries.some((boundary) => boundaryDigest(boundary) === closure.boundaryDigest)
	)
		add("evaluator_closure_mismatch");
	if (!input.candidate.goalIds.includes(vector.goalId)) add("goal_closure_mismatch");
}

function domainManifestKey(entry: PortfolioLearningGoalFamilyManifestEntry): string {
	return `${entry.goalId}\u0000${entry.domainId}\u0000${entry.solutionFamilyId}`;
}

function transferKey(entry: PortfolioLearningDomainTransferEvidence): string {
	return `${entry.goalId}\u0000${entry.domainId}\u0000${entry.solutionFamilyId}`;
}

async function addDomainTransferReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
	audit: PortfolioLearningReceiptAudit,
): Promise<void> {
	const manifest = input.approvedGoalFamilyManifest;
	if (manifest.length === 0) {
		add("domain_transfer_manifest_missing");
		return;
	}
	if (input.originatingVectorEvidence === undefined || input.originatingVectorEvidence === null) {
		add("originating_vector_evidence_missing");
		return;
	}
	const originFamily = input.originatingVectorEvidence.solutionFamilyId;
	const manifestKeys = new Set<string>();
	const manifestFamilies = new Set<string>();
	for (const entry of manifest) {
		addClosedShapeReason(entry, ["goalId", "domainId", "solutionFamilyId", "familyDigest"], add);
		if (
			!nonEmpty(entry.goalId) ||
			!nonEmpty(entry.domainId) ||
			!nonEmpty(entry.solutionFamilyId) ||
			!digest(entry.familyDigest) ||
			entry.familyDigest !== familyDigest(entry)
		)
			add("domain_transfer_manifest_missing");
		const key = domainManifestKey(entry);
		if (manifestKeys.has(key) || manifestFamilies.has(entry.solutionFamilyId)) add("solution_family_overlap");
		manifestKeys.add(key);
		manifestFamilies.add(entry.solutionFamilyId);
		const goal = input.contract.goals.find((candidateGoal) => candidateGoal.goalId === entry.goalId);
		if (entry.solutionFamilyId === originFamily || goal === undefined || goal.domainId !== entry.domainId)
			add("solution_family_overlap");
	}
	const manifestDigest = domainManifestDigest(manifest);
	const preregistrationDigest =
		safeDigestObject({
			kind: "portfolio-learning-domain-preregistration",
			manifestDigest,
		}) ?? "";
	const evidenceByKey = new Map<string, PortfolioLearningDomainTransferEvidence>();
	const executionIdentities = new Set<string>();
	const sessionIds = new Set<string>();
	for (const evidence of input.domainTransferEvidence) {
		addClosedShapeReason(
			evidence,
			[
				"goalId",
				"domainId",
				"solutionFamilyId",
				"freshness",
				"independence",
				"disposition",
				"manifestDigest",
				"preregistrationDigest",
				"confirmationDigest",
				"evidence",
			],
			add,
		);
		const key = transferKey(evidence);
		if (!nonEmpty(evidence.goalId) || !nonEmpty(evidence.domainId) || !nonEmpty(evidence.solutionFamilyId))
			add("domain_transfer_evidence_failed");
		if (evidenceByKey.has(key)) add("solution_family_overlap");
		if (evidence.solutionFamilyId === originFamily) add("solution_family_overlap");
		evidenceByKey.set(key, evidence);
		if (evidence.freshness !== "fresh" && evidence.freshness !== "stale") add("invalid_enum");
		if (evidence.independence !== "independent" && evidence.independence !== "overlapping") add("invalid_enum");
		if (evidence.disposition !== "pass" && evidence.disposition !== "failed") add("invalid_enum");
		if (evidence.freshness !== "fresh") add("domain_transfer_evidence_not_fresh");
		if (evidence.independence !== "independent") add("domain_transfer_evidence_not_independent");
		if (evidence.disposition !== "pass") add("domain_transfer_evidence_failed");
		const expectedConfirmationDigest =
			safeDigestObject({
				kind: "portfolio-learning-domain-confirmation",
				manifestDigest,
				goalId: evidence.goalId,
				domainId: evidence.domainId,
				solutionFamilyId: evidence.solutionFamilyId,
				freshness: "fresh",
				independence: "independent",
				disposition: "pass",
			}) ?? "";
		if (
			evidence.manifestDigest !== manifestDigest ||
			evidence.preregistrationDigest !== preregistrationDigest ||
			evidence.confirmationDigest !== expectedConfirmationDigest
		) {
			add("transfer_attestation_missing");
		}
		const manifestEntry = manifest.find((entry) => domainManifestKey(entry) === key);
		if (manifestEntry === undefined || evidence.manifestDigest !== manifestDigest)
			add("transfer_confirmation_missing");
		await addHostEvidenceReasons(
			input,
			evidence.evidence,
			receiptAuthority(input),
			input.candidate.candidateId,
			add,
			audit,
			{
				kind: "domain_transfer",
				transferKey: key,
				manifestDigest,
				preregistrationDigest,
				confirmationDigest: evidence.confirmationDigest,
				familyDigest: manifestEntry?.familyDigest ?? "",
			},
		);
		const receiptId = evidence.evidence?.receipt?.receiptId;
		const authorization = typeof receiptId === "string" ? audit.authorizations.get(receiptId) : undefined;
		if (
			authorization === undefined ||
			authorization.executionIdentity === undefined ||
			authorization.sessionId === undefined ||
			executionIdentities.has(authorization.executionIdentity) ||
			sessionIds.has(authorization.sessionId)
		)
			add("domain_transfer_evidence_not_independent");
		if (authorization?.executionIdentity !== undefined) executionIdentities.add(authorization.executionIdentity);
		if (authorization?.sessionId !== undefined) sessionIds.add(authorization.sessionId);
	}
	for (const entry of manifest) {
		if (!evidenceByKey.has(domainManifestKey(entry))) add("domain_transfer_evidence_missing");
	}
	for (const key of evidenceByKey.keys()) if (!manifestKeys.has(key)) add("domain_transfer_evidence_failed");
}

function crossDomainKey(entry: PortfolioLearningCrossDomainManifestEntry): string {
	return `${entry.goalId}\u0000${entry.fromDomainId}\u0000${entry.toDomainId}\u0000${entry.manifestGeneration}\u0000${entry.manifestDigest}`;
}

function crossDomainEvidenceKey(entry: PortfolioLearningCrossDomainTransferEvidence): string {
	return `${entry.goalId}\u0000${entry.fromDomainId}\u0000${entry.toDomainId}\u0000${entry.manifestGeneration}\u0000${entry.manifestDigest}`;
}

async function addCrossDomainTransferReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
	audit: PortfolioLearningReceiptAudit,
): Promise<void> {
	const transfer = input.crossDomainTransfer;
	if (transfer === null || transfer === undefined) {
		add("cross_domain_transfer_manifest_missing");
		add("cross_domain_transfer_evidence_missing");
		return;
	}
	addClosedShapeReason(transfer, ["preregistration", "preregistrationDigest", "manifest", "evidence"], add);
	if (transfer.preregistration !== "fresh") add("cross_domain_transfer_not_preregistered");
	if (transfer.preregistration !== "fresh" && transfer.preregistration !== "post_hoc") add("invalid_enum");
	if (transfer.manifest.length === 0) add("cross_domain_transfer_manifest_missing");
	const manifestKeys = new Set<string>();
	const domains = new Set<string>();
	for (const entry of transfer.manifest) {
		addClosedShapeReason(
			entry,
			["goalId", "fromDomainId", "toDomainId", "manifestGeneration", "manifestDigest"],
			add,
		);
		if (
			!nonEmpty(entry.goalId) ||
			!nonEmpty(entry.fromDomainId) ||
			!nonEmpty(entry.toDomainId) ||
			!positiveInteger(entry.manifestGeneration) ||
			!digest(entry.manifestDigest)
		)
			add("cross_domain_transfer_manifest_missing");
		if (entry.fromDomainId === entry.toDomainId || manifestKeys.has(crossDomainKey(entry))) {
			add("cross_domain_transfer_manifest_missing");
		}
		manifestKeys.add(crossDomainKey(entry));
		domains.add(entry.fromDomainId);
		domains.add(entry.toDomainId);
	}
	if (domains.size < 2) add("cross_domain_transfer_manifest_missing");
	const preregistrationDigest =
		safeDigestObject({
			kind: "portfolio-learning-cross-domain-preregistration",
			manifest: [...transfer.manifest].sort((left, right) =>
				crossDomainKey(left).localeCompare(crossDomainKey(right)),
			),
		}) ?? "";
	if (transfer.preregistrationDigest !== preregistrationDigest) add("transfer_attestation_missing");
	const evidenceKeys = new Set<string>();
	const executionIdentities = new Set<string>();
	const sessionIds = new Set<string>();
	for (const evidence of transfer.evidence) {
		addClosedShapeReason(
			evidence,
			[
				"goalId",
				"fromDomainId",
				"toDomainId",
				"manifestGeneration",
				"manifestDigest",
				"freshness",
				"independence",
				"disposition",
				"confirmationDigest",
				"evidence",
			],
			add,
		);
		if (
			!nonEmpty(evidence.goalId) ||
			!nonEmpty(evidence.fromDomainId) ||
			!nonEmpty(evidence.toDomainId) ||
			!positiveInteger(evidence.manifestGeneration) ||
			!digest(evidence.manifestDigest)
		)
			add("cross_domain_transfer_evidence_failed");
		if (evidenceKeys.has(crossDomainEvidenceKey(evidence))) add("cross_domain_transfer_evidence_failed");
		evidenceKeys.add(crossDomainEvidenceKey(evidence));
		if (evidence.freshness !== "fresh" && evidence.freshness !== "stale") add("invalid_enum");
		if (evidence.independence !== "independent" && evidence.independence !== "overlapping") add("invalid_enum");
		if (evidence.disposition !== "pass" && evidence.disposition !== "failed") add("invalid_enum");
		if (evidence.freshness !== "fresh") add("cross_domain_transfer_evidence_not_fresh");
		if (evidence.independence !== "independent") add("cross_domain_transfer_evidence_not_independent");
		if (evidence.disposition !== "pass") add("cross_domain_transfer_evidence_failed");
		const expectedConfirmationDigest =
			safeDigestObject({
				kind: "portfolio-learning-cross-domain-confirmation",
				preregistrationDigest,
				transferKey: crossDomainEvidenceKey(evidence),
				freshness: "fresh",
				independence: "independent",
				disposition: "pass",
			}) ?? "";
		if (evidence.confirmationDigest !== expectedConfirmationDigest) add("transfer_confirmation_missing");
		await addHostEvidenceReasons(
			input,
			evidence.evidence,
			receiptAuthority(input),
			input.candidate.candidateId,
			add,
			audit,
			{
				kind: "cross_domain_transfer",
				transferKey: crossDomainEvidenceKey(evidence),
				preregistrationDigest,
				confirmationDigest: evidence.confirmationDigest,
			},
		);
		const receiptId = evidence.evidence?.receipt?.receiptId;
		const authorization = typeof receiptId === "string" ? audit.authorizations.get(receiptId) : undefined;
		if (
			authorization === undefined ||
			authorization.executionIdentity === undefined ||
			authorization.sessionId === undefined ||
			executionIdentities.has(authorization.executionIdentity) ||
			sessionIds.has(authorization.sessionId)
		)
			add("cross_domain_transfer_evidence_not_independent");
		if (authorization?.executionIdentity !== undefined) executionIdentities.add(authorization.executionIdentity);
		if (authorization?.sessionId !== undefined) sessionIds.add(authorization.sessionId);
	}
	for (const entry of transfer.manifest) {
		if (!evidenceKeys.has(crossDomainKey(entry))) add("cross_domain_transfer_evidence_missing");
	}
	for (const key of evidenceKeys) if (!manifestKeys.has(key)) add("cross_domain_transfer_evidence_failed");
}

async function addBoundaryReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
	audit: PortfolioLearningReceiptAudit,
): Promise<void> {
	const expectedIds = new Set(input.contract.hardBoundaries.map((entry) => entry.boundaryId));
	const seen = new Set<string>();
	for (const evidence of input.boundaryEvidence) {
		addClosedShapeReason(evidence, ["boundaryId", "boundaryDigest", "disposition", "evidence"], add);
		if (seen.has(evidence.boundaryId)) add("boundary_violation");
		seen.add(evidence.boundaryId);
		const boundary = input.contract.hardBoundaries.find((entry) => entry.boundaryId === evidence.boundaryId);
		if (!expectedIds.has(evidence.boundaryId) || boundary === undefined) add("boundary_closure_mismatch");
		if (boundary === undefined || evidence.boundaryDigest !== boundaryDigest(boundary))
			add("boundary_closure_mismatch");
		if (evidence.disposition !== "pass" && evidence.disposition !== "failed" && evidence.disposition !== "violation")
			add("invalid_enum");
		if (evidence.disposition !== "pass") add("boundary_violation");
		await addHostEvidenceReasons(
			input,
			evidence.evidence,
			receiptAuthority(input),
			input.candidate.candidateId,
			add,
			audit,
			{
				kind: "boundary",
				boundaryId: evidence.boundaryId,
				boundaryDigest: boundary === undefined ? evidence.boundaryDigest : boundaryDigest(boundary),
				disposition: evidence.disposition,
			},
		);
	}
	for (const boundaryId of expectedIds) if (!seen.has(boundaryId)) add("boundary_closure_mismatch");
}

async function addInvariantReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
	audit: PortfolioLearningReceiptAudit,
	requireComplete: boolean,
): Promise<void> {
	const expectedIds = new Set(input.contract.invariants.map((entry) => entry.invariantId));
	const seen = new Set<string>();
	for (const evidence of input.invariantEvidence) {
		addClosedShapeReason(evidence, ["invariantId", "disposition", "evidence"], add);
		if (seen.has(evidence.invariantId)) add("protected_invariant_regression");
		seen.add(evidence.invariantId);
		if (!expectedIds.has(evidence.invariantId)) add("protected_invariant_regression");
		const invariant = input.contract.invariants.find((entry) => entry.invariantId === evidence.invariantId);
		if (evidence.disposition !== "pass" && evidence.disposition !== "regressed") add("invalid_enum");
		if (evidence.disposition === "regressed") add("protected_invariant_regression");
		await addHostEvidenceReasons(
			input,
			evidence.evidence,
			receiptAuthority(input),
			input.candidate.candidateId,
			add,
			audit,
			{
				kind: "invariant",
				invariantId: evidence.invariantId,
				checkDigest: invariant?.checkDigest ?? "",
				scope: invariant?.scope ?? "terminal",
				disposition: evidence.disposition,
			},
		);
	}
	if (requireComplete) {
		for (const invariantId of expectedIds) if (!seen.has(invariantId)) add("protected_invariant_regression");
	}
}

async function addGlobalReviewReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
	audit: PortfolioLearningReceiptAudit,
): Promise<void> {
	const redTeam = input.redTeamEvidence;
	if (redTeam === null || redTeam === undefined) {
		add("red_team_missing");
	} else {
		addClosedShapeReason(redTeam, ["independence", "disposition", "evidence"], add);
		if (redTeam.independence !== "independent" && redTeam.independence !== "overlapping") add("invalid_enum");
		if (redTeam.disposition !== "pass" && redTeam.disposition !== "failed") add("invalid_enum");
		if (redTeam.independence !== "independent") add("red_team_not_independent");
		if (redTeam.disposition !== "pass") add("red_team_failed");
		await addHostEvidenceReasons(
			input,
			redTeam.evidence,
			receiptAuthority(input),
			input.candidate.candidateId,
			add,
			audit,
			{ kind: "red_team", independence: "independent", disposition: redTeam.disposition },
		);
	}
	const approval = input.independentApproval;
	if (approval === null || approval === undefined) {
		add("wider_scope_approval_missing");
		return;
	}
	addClosedShapeReason(
		approval,
		["decision", "decisionWitness", "bindingDigest", "workerId", "workerRole", "workerAttestationDigest"],
		add,
	);
	const redReceipt = redTeam?.evidence?.receipt;
	const redWitness = redTeam?.evidence?.witness;
	const decision = approval.decision;
	const adjudication = decision?.hostAdjudication;
	const decisionReceipt = adjudication?.hostReceipt;
	if (approval.workerRole !== "scope_adjudicator") add("invalid_enum");
	if (!nonEmpty(approval.workerId) || !digest(approval.workerAttestationDigest)) add("worker_attestation_invalid");
	if (decisionReceipt !== undefined && decisionReceipt !== null && typeof decisionReceipt === "object") {
		addClosedShapeReason(
			decisionReceipt,
			[
				"receiptKind",
				"oneUse",
				"receiptId",
				"issuerId",
				"workflowId",
				"bindingDigest",
				"payloadDigest",
				"artifactRef",
				"capabilityBinding",
				"issuedAt",
				"validUntil",
				"keyId",
				"signatureAlgorithm",
				"artifactBytesDigest",
				"stateDigest",
				"revision",
				"signature",
				"verificationDigest",
			],
			add,
		);
		if (decisionReceipt.capabilityBinding !== undefined)
			addClosedShapeReason(
				decisionReceipt.capabilityBinding,
				["capability", "resourceDigest", "operationDigest", "executionIdentity", "sessionId"],
				add,
			);
	}
	addClosedShapeReason(
		approval.decisionWitness,
		[
			"witnessId",
			"witnessKind",
			"workflowId",
			"stage",
			"candidateId",
			"evidenceRef",
			"payloadDigest",
			"bytesDigest",
			"bytesSize",
			"revision",
			"storeEpoch",
			"coordinatorEpoch",
			"stateHeadDigest",
			"trustedNow",
			"oneUse",
		],
		add,
	);
	const decisionStructureValid =
		decision !== null &&
		typeof decision === "object" &&
		decisionReceipt !== undefined &&
		decisionReceipt !== null &&
		typeof decisionReceipt === "object" &&
		approval.decisionWitness !== undefined &&
		decision.disposition === "authorized" &&
		Array.isArray(decision.authority) &&
		decision.authority.includes("request_user_approval") &&
		decision.decisionScope?.kind === "workflow" &&
		decision.decisionScope.workflowId === input.workflowId &&
		decision.revision === input.currentRevision &&
		decision.storeEpoch === input.currentStoreEpoch &&
		decision.coordinatorEpoch === input.currentCoordinatorEpoch &&
		decision.stateDigest === input.currentStateDigest &&
		adjudication?.stage === "host_adjudication" &&
		adjudication?.decisionId === decision?.decisionId &&
		adjudication?.decisionRevision === decision?.revision &&
		adjudication?.disposition === "accepted" &&
		decisionReceipt.receiptKind === "adjudication" &&
		sameArtifactRef(adjudication?.verdictArtifactRef, decisionReceipt.artifactRef) &&
		approval.bindingDigest === decisionReceipt.bindingDigest &&
		nonEmpty(adjudication?.executionIdentity ?? "") &&
		nonEmpty(adjudication?.sessionId ?? "") &&
		adjudication?.verdictDigest === decisionReceipt.payloadDigest &&
		decisionReceipt.bindingDigest ===
			adjudicationBindingDigest(input, decision, decisionReceipt, approval.workerId, "scope_adjudicator") &&
		approval.workerAttestationDigest ===
			adjudicationWorkerAttestationDigest(
				input,
				decision,
				decisionReceipt,
				approval.workerId,
				"scope_adjudicator",
			) &&
		decision.hostClassification?.classifier === "host" &&
		decision.hostClassification?.requiresUserApproval === true &&
		decision.contractDigest === canonicalContractDigest(input.contract) &&
		decision.evaluatorDigest ===
			input.contract.goals.find((entry) => entry.goalId === input.measurement.goalId)?.evaluator.evaluatorDigest &&
		decision.parserDigest ===
			input.contract.goals.find((entry) => entry.goalId === input.measurement.goalId)?.parser.parserDigest &&
		decision.workspaceDigest === input.measurement.workspaceDigest;
	const approvalSemantic: PortfolioLearningEvidenceSemanticBinding = {
		kind: "adjudication",
		decisionId: decision?.decisionId ?? "",
		decisionRevision: decision?.revision ?? 0,
		operationDigest: adjudication?.operationDigest ?? "",
		workerId: approval.workerId ?? "",
		workerRole: "scope_adjudicator",
	};
	const approvalReceiptValid = await verifyReceiptAndWitness(
		input,
		receiptAuthority(input),
		decisionReceipt,
		approval.bindingDigest,
		approval.decisionWitness,
		input.candidate.candidateId,
		"decision",
		approvalSemantic,
		approval.workerId,
		"scope_adjudicator",
		adjudication?.executionIdentity ?? "",
		adjudication?.sessionId ?? "",
		audit,
		add,
	);
	if (!decisionStructureValid || !approvalReceiptValid) add("wider_scope_approval_missing");
	const redAuthorization = redReceipt === undefined ? undefined : audit.authorizations.get(redReceipt.receiptId);
	const approvalAuthorization =
		decisionReceipt === undefined ? undefined : audit.authorizations.get(decisionReceipt.receiptId);
	if (
		redTeam !== null &&
		decisionReceipt !== undefined &&
		decisionReceipt !== null &&
		redReceipt !== undefined &&
		redReceipt !== null &&
		(decisionReceipt.receiptId === redReceipt.receiptId ||
			approval.decisionWitness?.witnessId === redWitness?.witnessId ||
			(redAuthorization !== undefined &&
				approvalAuthorization !== undefined &&
				((redAuthorization.executionIdentity !== undefined &&
					redAuthorization.executionIdentity === approvalAuthorization.executionIdentity) ||
					(redAuthorization.sessionId !== undefined &&
						redAuthorization.sessionId === approvalAuthorization.sessionId))))
	)
		add("wider_scope_self_approved");
}

async function addRestoreRehashReasons(
	input: PortfolioLearningScopeAdmissionInput,
	add: (reason: PortfolioLearningScopeRejectionReason) => void,
	audit: PortfolioLearningReceiptAudit,
): Promise<void> {
	const expected = new Set<string>([
		`${input.contract.inputManifest.manifestRevision}\u0000${input.contract.inputManifest.manifestDigest}`,
	]);
	for (const entry of input.crossDomainTransfer?.manifest ?? [])
		expected.add(`${entry.manifestGeneration}\u0000${entry.manifestDigest}`);
	const proofs = new Set<string>();
	for (const proof of input.restoreRehashProofs) {
		addClosedShapeReason(
			proof,
			[
				"manifestGeneration",
				"manifestDigest",
				"independence",
				"restoration",
				"rehash",
				"manifestArtifacts",
				"manifestArtifactDigest",
				"evidence",
			],
			add,
		);
		const key = `${proof.manifestGeneration}\u0000${proof.manifestDigest}`;
		const expectedManifestArtifactDigest =
			safeDigestObject({
				kind: "portfolio-learning-physical-manifest",
				manifestGeneration: proof.manifestGeneration,
				manifestDigest: proof.manifestDigest,
				artifacts: Array.isArray(proof.manifestArtifacts)
					? [...proof.manifestArtifacts].sort((left, right) => left.artifactId.localeCompare(right.artifactId))
					: [],
			}) ?? "";
		if (
			!positiveInteger(proof.manifestGeneration) ||
			!digest(proof.manifestDigest) ||
			proof.independence !== "independent" ||
			proof.restoration !== "verified" ||
			proof.rehash !== "verified" ||
			!Array.isArray(proof.manifestArtifacts) ||
			proof.manifestArtifacts.length === 0 ||
			proof.manifestArtifactDigest !== expectedManifestArtifactDigest
		)
			add("manifest_restore_rehash_missing");
		if (proof.independence !== "independent" && proof.independence !== "overlapping") add("invalid_enum");
		if (proof.restoration !== "verified" && proof.restoration !== "failed") add("invalid_enum");
		if (proof.rehash !== "verified" && proof.rehash !== "failed") add("invalid_enum");
		if (proofs.has(key)) add("manifest_restore_rehash_missing");
		proofs.add(key);
		const artifactIds = new Set<string>();
		const manifestArtifacts = Array.isArray(proof.manifestArtifacts) ? proof.manifestArtifacts : [];
		for (const ref of manifestArtifacts) {
			addClosedShapeReason(ref, ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"], add);
			if (!validArtifactRef(ref) || artifactIds.has(ref.artifactId)) {
				add("manifest_artifact_resolution_failed");
				continue;
			}
			artifactIds.add(ref.artifactId);
			try {
				const resolved = await input.receiptContext.artifactResolver.resolve(ref);
				const bytes = new Uint8Array(resolved.bytes);
				if (
					resolved.exists !== true ||
					resolved.envelope.immutable !== true ||
					!sameArtifactRef(resolved.envelope.ref, ref) ||
					resolved.verifiedDigest !== ref.digest ||
					resolved.verifiedSizeBytes !== ref.sizeBytes ||
					bytes.byteLength !== ref.sizeBytes ||
					sha256Hex(bytes) !== ref.digest
				)
					add("manifest_artifact_resolution_failed");
			} catch (_error: unknown) {
				add("manifest_artifact_resolution_failed");
			}
		}
		await addHostEvidenceReasons(
			input,
			proof.evidence,
			receiptAuthority(input),
			input.candidate.candidateId,
			add,
			audit,
			{
				kind: "manifest_restore",
				manifestGeneration: proof.manifestGeneration,
				manifestDigest: proof.manifestDigest,
				manifestArtifactDigest: proof.manifestArtifactDigest,
				independence: proof.independence,
				restoration: proof.restoration,
				rehash: proof.rehash,
			},
		);
	}
	if (input.restoreRehashProofs.length === 0) add("manifest_restore_rehash_missing");
	for (const key of expected) if (!proofs.has(key)) add("manifest_restore_rehash_missing");
}

function decision(
	input: PortfolioLearningScopeAdmissionInput,
	reasons: ReadonlySet<PortfolioLearningScopeRejectionReason>,
	exploratory: boolean,
): PortfolioLearningScopeDecision {
	const rejectionReasons = orderedReasons(reasons);
	const canPromote = rejectionReasons.length === 0;
	const requestedScope = PORTFOLIO_LEARNING_SCOPES.includes(input.requestedScope) ? input.requestedScope : null;
	return deepFreeze({
		requestedScope,
		effectiveScope: canPromote && requestedScope !== null ? requestedScope : "never",
		canPromote,
		exploratory,
		rejectionReasons,
		applicationCount: 0,
		mutationCount: 0,
	});
}

/** Decide whether a parsed schema-v3 portfolio may promote learning at one closed scope. */
export async function admitPortfolioLearningScope(
	input: PortfolioLearningScopeAdmissionInput,
): Promise<PortfolioLearningScopeDecision> {
	const reasons = new Set<PortfolioLearningScopeRejectionReason>();
	const add = (reason: PortfolioLearningScopeRejectionReason): void => {
		reasons.add(reason);
	};
	addClosedInputReasons(input, add);
	if (!PORTFOLIO_LEARNING_SCOPES.includes(input.requestedScope)) add("unsupported_scope");
	if (input.requestedScope === "never") {
		add("never_scope_requested");
		return decision(input, reasons, false);
	}
	addParsedRecordReasons(input, add);
	addClosedShapeReason(
		input.contract,
		[
			"schemaVersion",
			"contractId",
			"objective",
			"acceptanceRequirements",
			"goals",
			"goalRelations",
			"lexicographicTiers",
			"hardBoundaries",
			"invariants",
			"nonGoals",
			"budgets",
			"safety",
			"inputManifest",
			"scopePartitions",
			"terminalScope",
			"learningScope",
		],
		add,
	);
	if (!deeplyFrozen(input.contract)) add("parsed_contract_required");
	if (
		input.contract.schemaVersion !== AUTO_RESEARCH_PORTFOLIO_SCHEMA_VERSION ||
		input.contract.terminalScope !== "terminal" ||
		input.contract.learningScope !== "learning"
	)
		add("schema_version_invalid");
	addDatasetReasons(input.contract, add);
	addCandidateReasons(input, add);
	addMeasurementReasons(input, add);
	const exploratory =
		input.frontierDisposition.status === "exploratory" ||
		input.frontierDisposition.postHocCrossGoalGain === "unconfirmed";
	if (input.frontierDisposition.postHocCrossGoalGain === "unconfirmed") add("post_hoc_cross_goal_gain_unconfirmed");
	const audit: PortfolioLearningReceiptAudit = { receiptIds: new Set<string>(), authorizations: new Map() };
	await addOriginatingEvidenceReasons(input, add, audit);
	await addBoundaryReasons(input, add, audit);
	await addInvariantReasons(input, add, audit, true);
	addGoalClosureReasons(input, add);
	if (
		input.frontierDisposition.postHocCrossGoalGain === "fresh_preregistered_confirmation" &&
		input.requestedScope === "goal"
	)
		await addDomainTransferReasons(input, add, audit);
	if (input.requestedScope === "domain" || input.requestedScope === "global")
		await addDomainTransferReasons(input, add, audit);
	if (input.requestedScope === "global") {
		await addCrossDomainTransferReasons(input, add, audit);
		await addGlobalReviewReasons(input, add, audit);
		await addRestoreRehashReasons(input, add, audit);
	}
	return decision(input, reasons, exploratory);
}
