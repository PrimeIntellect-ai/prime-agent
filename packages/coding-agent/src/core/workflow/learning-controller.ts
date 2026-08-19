import type { RefinementProposal } from "../refinement/refinement.js";
import {
	type DurableDecisionRecord,
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	WORKFLOW_EVIDENCE_LIMITS,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowDecisionRecord,
	type WorkflowDecisionRef,
	type WorkflowEventKind,
	type WorkflowEvidenceEnvelope,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowImprovementCaseManifest,
	type WorkflowImprovementOwner,
	type WorkflowImprovementProducer,
	type WorkflowImprovementProposal,
	type WorkflowPolicyRevision,
	type WorkflowRevisionTuple,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import type { WorkflowAuthorizationInput, WorkflowDecisionGate, WorkflowOperation } from "./decision-gate.js";
import type { WorkflowEvidenceValidationInput, WorkflowEvidenceValidator } from "./evidence.js";

export type WorkflowLearningTriggerKind = "milestone" | "failure" | "regression" | "efficiency_review";

export type WorkflowLearningMutationClass =
	| "workflow"
	| "methodology"
	| "policy"
	| "evaluator"
	| "metric"
	| "kernel"
	| "authority"
	| "scheduler"
	| "recipe"
	| "skill";

export type WorkflowLearningOutcome = "positive" | "negative" | "rejected" | "failed";
export type WorkflowLearningProgressKind = "verified" | "utilization" | "tokens" | "none";

export interface WorkflowLearningTrigger {
	kind: WorkflowLearningTriggerKind;
	candidateId: string | null;
	sourceEventRef: WorkflowArtifactRef;
	evidenceRefs: readonly WorkflowArtifactRef[];
	workflowId?: string;
	storeEpoch?: number;
	coordinatorEpoch?: number;
	stateHeadDigest?: string;
	evidenceDigest?: string;
	hostReceipt?: WorkflowVerifiedHostReceipt;
	evidenceWitnesses?: readonly WorkflowLearningHostWitness[];
}

export interface WorkflowLearningExperienceInput {
	experienceId: string;
	workflowId: string;
	source: "host" | "worker" | "model";
	outcome: WorkflowLearningOutcome;
	progressKind: WorkflowLearningProgressKind;
	progressEvidenceRefs: readonly WorkflowArtifactRef[];
	evidence: readonly WorkflowEvidenceEnvelope[];
	committedAt: string;
	sourceEventRef: WorkflowArtifactRef;
	hostReceipt: WorkflowVerifiedHostReceipt;
}

export interface WorkflowLearningExperience extends WorkflowLearningExperienceInput {
	source: "host";
	validatedEvidenceDigests: readonly string[];
	evidenceDigest: string;
	evidenceWitnesses?: readonly WorkflowLearningHostWitness[];
}

export interface WorkflowLearningHostSnapshot {
	workflowId: string;
	stateDigest: string;
	workspaceDigest: string;
	configDigest: string;
	parserDigest: string;
	evaluatorDigest: string;
	guardDigest: string;
	revisions: WorkflowRevisionTuple;
	currentRevision: number;
	trustedNow: string;
	trustedClockReceipt: WorkflowVerifiedHostReceipt;
	requiredFreshnessMilliseconds: number;
	baselineRevision: number;
	baselineDigest: string;
	evaluatorBaselineDigest: string;
	metricBaselineDigest: string;
	revisionRegistryDigest: string;
	artifactResolver: WorkflowArtifactResolver;
	receiptContext: WorkflowHostReceiptConsumerContext;
	storeEpoch?: number;
	coordinatorEpoch?: number;
	stateHeadDigest?: string;
}

/** Capability-free state passed to model and stage callbacks. */
export interface WorkflowLearningHostProjection {
	workflowId: string;
	stateDigest: string;
	workspaceDigest: string;
	configDigest: string;
	parserDigest: string;
	evaluatorDigest: string;
	guardDigest: string;
	revisions: WorkflowRevisionTuple;
	currentRevision: number;
	trustedNow: string;
	requiredFreshnessMilliseconds: number;
	baselineRevision: number;
	baselineDigest: string;
	evaluatorBaselineDigest: string;
	metricBaselineDigest: string;
	revisionRegistryDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	stateHeadDigest: string;
}

export type WorkflowLearningWitnessKind = "evidence" | "receipt" | "decision";

export interface WorkflowLearningHostWitness {
	witnessId: string;
	witnessKind: WorkflowLearningWitnessKind;
	workflowId: string;
	stage: string;
	candidateId: string | null;
	evidenceRef: WorkflowArtifactRef;
	payloadDigest: string;
	bytesDigest: string;
	bytesSize: number;
	revision: number;
	storeEpoch: number;
	coordinatorEpoch: number;
	stateHeadDigest: string;
	trustedNow: string;
	oneUse: boolean;
}

export interface WorkflowLearningStageMetrics {
	sampleCount: number;
	effectSize: number;
	variance: number;
	costMicrounits: number;
	latencyMilliseconds: number;
	evaluatorDigest: string;
	metricDigest: string;
	evidenceDigest: string;
}

export interface WorkflowLearningCandidateClassification {
	mutationClass: WorkflowLearningMutationClass;
	payloadDigest: string;
	classifierDigest: string;
	protectedPaths: readonly string[];
	proposalDigest?: string | null;
}

export interface WorkflowLearningCasExpectation {
	currentRevision: number;
	storeEpoch: number;
	coordinatorEpoch: number;
	stateHeadDigest: string;
}

export interface WorkflowLearningCandidate {
	candidateId: string;
	experienceId: string;
	workflowId: string;
	owner: WorkflowImprovementOwner;
	producer: WorkflowImprovementProducer;
	kind: WorkflowImprovementProposal["kind"];
	mutationClass: WorkflowLearningMutationClass;
	proposalRef: WorkflowArtifactRef;
	candidateRef: WorkflowArtifactRef;
	candidateDigest: string;
	baselineRevision: number;
	baselineDigest: string;
	baselineArtifactRef: WorkflowArtifactRef;
	scorecardRef: WorkflowArtifactRef;
	scorecardDigest: string;
	evaluatorRef: WorkflowArtifactRef;
	evaluatorDigest: string;
	parserRef: WorkflowArtifactRef;
	caseManifest: WorkflowImprovementCaseManifest;
	hiddenHoldoutManifestRef: WorkflowArtifactRef;
	proposal: RefinementProposal | null;
	hostReceipt: WorkflowVerifiedHostReceipt;
}

export interface WorkflowLearningFreshBaseline {
	baselineRevision: number;
	baselineDigest: string;
	decisionRef: WorkflowDecisionRef;
}

export interface WorkflowLearningShadowResult {
	candidateId: string;
	sameCaseInputDigest: string;
	heldOutInputDigest: string;
	heldOutSampleCount: number;
	heldOutPassed: boolean;
	overfittingDetected: boolean;
	nonRegressionPassed: boolean;
	safetyPassed: boolean;
	evidenceRefs: readonly WorkflowArtifactRef[];
	receipts: readonly WorkflowVerifiedHostReceipt[];
	resultRef: WorkflowArtifactRef;
	freshBaseline?: WorkflowLearningFreshBaseline | null;
	metrics?: WorkflowLearningStageMetrics;
	evidenceWitnesses?: readonly WorkflowLearningHostWitness[];
}

export interface WorkflowLearningCanaryResult {
	candidateId: string;
	inputDigest: string;
	passed: boolean;
	sessionId: string;
	executionIdentity: string;
	evidenceRefs: readonly WorkflowArtifactRef[];
	receipts: readonly WorkflowVerifiedHostReceipt[];
	resultRef: WorkflowArtifactRef;
	metrics?: WorkflowLearningStageMetrics;
	evidenceWitnesses?: readonly WorkflowLearningHostWitness[];
}

export interface WorkflowLearningRedTeamResult {
	candidateId: string;
	independent: boolean;
	passed: boolean;
	sessionId: string;
	executionIdentity: string;
	evidenceRefs: readonly WorkflowArtifactRef[];
	receipts: readonly WorkflowVerifiedHostReceipt[];
	resultRef: WorkflowArtifactRef;
	metrics?: WorkflowLearningStageMetrics;
	evidenceWitnesses?: readonly WorkflowLearningHostWitness[];
}

export interface WorkflowLearningDecision {
	decision: DurableDecisionRecord;
	operation: WorkflowOperation;
	decisionRef?: WorkflowDecisionRef;
	decisionWitness?: WorkflowLearningHostWitness;
}

export interface WorkflowLearningPromotion {
	promotionId: string;
	candidateId: string;
	revisionId: string;
	revision: number;
	policyDigest: string;
	revisionRecord?: Pick<WorkflowPolicyRevision, "revision" | "policyDigest">;
	receipt: WorkflowVerifiedHostReceipt;
	stateHeadDigest?: string;
	storeEpoch?: number;
	coordinatorEpoch?: number;
	casExecutionKey?: string;
}

export interface WorkflowLearningRollbackProposal {
	proposalId: string;
	candidateId: string;
	rollbackOf: string;
	proposalRef: WorkflowArtifactRef;
	proposalDigest: string;
	receipt: WorkflowVerifiedHostReceipt;
	stateHeadDigest?: string;
	storeEpoch?: number;
	coordinatorEpoch?: number;
	casExecutionKey?: string;
}

/**
 * Durable registry effect returned by the host after rollback CAS, apply, reload, and future-load checks.
 *
 * The operation id is the host fence. Every digest and identity is checked by the controller before the
 * effect is recorded, so a proposal without a verified effect can never be reported as a rollback success.
 */
export interface WorkflowLearningRollbackApplication {
	operationId: string;
	workflowId: string;
	candidateId: string;
	rollbackOf: string;
	proposalId: string;
	proposalRef: WorkflowArtifactRef;
	proposalDigest: string;
	triggerIdentity: string;
	decisionRef: WorkflowDecisionRef;
	expected: WorkflowLearningCasExpectation;
	receipt: WorkflowVerifiedHostReceipt;
	registryCasDigest: string;
	appliedRegistryDigest: string;
	reloadedRegistryDigest: string;
	futureLoadDigest: string;
	appliedRevision: number;
	reloadedRevision: number;
	futureLoadRevision: number;
	stateHeadDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	casExecutionKey: string;
}

/** State record that may only be appended after the host has verified a rollback effect. */
export interface WorkflowLearningRollbackRecord extends WorkflowLearningRollbackProposal {
	application: WorkflowLearningRollbackApplication;
}

/** Durable lookup result used to reconcile a promotion that committed before learning state did. */
export interface WorkflowLearningPromotionReconciliation {
	operationId: string;
	workflowId: string;
	candidateId: string;
	decisionRef: WorkflowDecisionRef;
	expected: WorkflowLearningCasExpectation;
	promotion: WorkflowLearningPromotion;
}

export interface WorkflowLearningReceiptPort {
	verify(input: {
		receipt: WorkflowVerifiedHostReceipt;
		bindingDigest: string;
		stage: string;
		candidateId: string | null;
		current: WorkflowLearningHostSnapshot;
	}): Promise<WorkflowLearningHostWitness | undefined>;
	consume(input: {
		receipt: WorkflowVerifiedHostReceipt;
		bindingDigest: string;
		stage: string;
		candidateId: string | null;
		current: WorkflowLearningHostSnapshot;
	}): Promise<WorkflowLearningHostWitness | undefined>;
}

export interface WorkflowLearningHost {
	current(): Promise<WorkflowLearningHostSnapshot>;
	createCandidate(input: {
		experience: WorkflowLearningExperience;
		trigger: WorkflowLearningTrigger;
		current: WorkflowLearningHostProjection;
	}): Promise<WorkflowLearningCandidate>;
	runShadow(input: {
		candidate: WorkflowLearningCandidate;
		current: WorkflowLearningHostProjection;
	}): Promise<WorkflowLearningShadowResult>;
	runCanary(input: {
		candidate: WorkflowLearningCandidate;
		shadow: WorkflowLearningShadowResult;
		current: WorkflowLearningHostProjection;
	}): Promise<WorkflowLearningCanaryResult>;
	runIndependentRedTeam(input: {
		candidate: WorkflowLearningCandidate;
		shadow: WorkflowLearningShadowResult;
		canary: WorkflowLearningCanaryResult;
		current: WorkflowLearningHostProjection;
	}): Promise<WorkflowLearningRedTeamResult>;
	resolveDecision(input: {
		candidate: WorkflowLearningCandidate;
		shadow: WorkflowLearningShadowResult;
		canary: WorkflowLearningCanaryResult;
		redTeam: WorkflowLearningRedTeamResult;
		current: WorkflowLearningHostProjection;
	}): Promise<WorkflowLearningDecision>;
	classifyCandidate?(input: {
		candidate: WorkflowLearningCandidate;
		current: WorkflowLearningHostProjection;
	}): Promise<WorkflowLearningCandidateClassification>;
	resolveEvidence?(input: {
		stage: string;
		workflowId: string;
		candidateId: string | null;
		evidenceRefs: readonly WorkflowArtifactRef[];
		payloadDigest: string;
		current: WorkflowLearningHostSnapshot;
		witnessKind?: WorkflowLearningWitnessKind;
	}): Promise<readonly WorkflowLearningHostWitness[]>;
	promote(input: {
		operationId: string;
		candidate: WorkflowLearningCandidate;
		shadow: WorkflowLearningShadowResult;
		canary: WorkflowLearningCanaryResult;
		redTeam: WorkflowLearningRedTeamResult;
		decision: WorkflowLearningDecision;
		current: WorkflowLearningHostProjection;
		expected: WorkflowLearningCasExpectation;
	}): Promise<WorkflowLearningPromotion>;
	/** Look up a prior durable effect by operation id before attempting a new promotion side effect. */
	reconcilePromotion(input: {
		operationId: string;
		candidate: WorkflowLearningCandidate;
		shadow: WorkflowLearningShadowResult;
		canary: WorkflowLearningCanaryResult;
		redTeam: WorkflowLearningRedTeamResult;
		decision: WorkflowLearningDecision;
		current: WorkflowLearningHostProjection;
		expected: WorkflowLearningCasExpectation;
	}): Promise<WorkflowLearningPromotionReconciliation | null>;
	proposeRollback(input: {
		operationId: string;
		candidate: WorkflowLearningCandidate;
		trigger: WorkflowLearningTrigger;
		decisionRef: WorkflowDecisionRef;
		current: WorkflowLearningHostProjection;
		expected: WorkflowLearningCasExpectation;
	}): Promise<WorkflowLearningRollbackProposal>;
	/** Atomically CAS/apply/reload/future-load the exact proposal, returning only a verified durable effect. */
	applyRollback(input: {
		operationId: string;
		candidate: WorkflowLearningCandidate;
		trigger: WorkflowLearningTrigger;
		proposal: WorkflowLearningRollbackProposal;
		decisionRef: WorkflowDecisionRef;
		current: WorkflowLearningHostProjection;
		expected: WorkflowLearningCasExpectation;
	}): Promise<WorkflowLearningRollbackApplication>;
}

export interface WorkflowLearningEvent {
	kind: Extract<WorkflowEventKind, "improvement_proposed" | "improvement_reviewed" | "policy_revision_recorded">;
	candidateId: string;
	proposalRef: WorkflowArtifactRef;
	reviewRef: WorkflowArtifactRef | null;
	resultRef: WorkflowArtifactRef | null;
}

export interface WorkflowLearningEventSink {
	append(event: WorkflowLearningEvent): Promise<void>;
}

export interface WorkflowLearningPorts {
	evidenceValidator: Pick<WorkflowEvidenceValidator, "validate">;
	decisionGate: Pick<WorkflowDecisionGate, "validateVerdicts" | "authorize">;
	receiptPort: WorkflowLearningReceiptPort;
	host: WorkflowLearningHost;
	eventSink?: WorkflowLearningEventSink;
}

export type WorkflowLearningCandidateStatus = "typed" | "rejected" | "proposed" | "promoted" | "rollback_proposed";
export type WorkflowLearningReviewStatus = "rejected" | "proposed" | "promoted";

export interface WorkflowLearningCandidateRecord {
	candidate: WorkflowLearningCandidate;
	status: WorkflowLearningCandidateStatus;
}

export interface WorkflowLearningReviewRecord {
	reviewId: string;
	candidateId: string;
	status: WorkflowLearningReviewStatus;
	reasons: readonly string[];
	shadow: WorkflowLearningShadowResult;
	canary: WorkflowLearningCanaryResult | null;
	redTeam: WorkflowLearningRedTeamResult | null;
	promotion: WorkflowLearningPromotion | null;
	decision: WorkflowLearningDecision | null;
	decisionRef: WorkflowDecisionRef | null;
	decisionWitness: WorkflowLearningHostWitness | null;
}

export interface WorkflowLearningState {
	schemaVersion: 1;
	experiences: readonly WorkflowLearningExperience[];
	candidates: readonly WorkflowLearningCandidateRecord[];
	reviews: readonly WorkflowLearningReviewRecord[];
	rollbackProposals: readonly WorkflowLearningRollbackRecord[];
	triggers: readonly WorkflowLearningTrigger[];
	consumedReceiptIds: readonly string[];
	consumedWitnessIds?: readonly string[];
	stateDigest: string;
}

export interface WorkflowLearningReviewResult extends WorkflowLearningReviewRecord {}

export type WorkflowLearningTriggerResult =
	| { status: "queued"; trigger: WorkflowLearningTrigger }
	| { status: "rollback_proposed"; trigger: WorkflowLearningTrigger; proposal: WorkflowLearningRollbackRecord };

export interface WorkflowLearningController {
	commitExperience(input: WorkflowLearningExperienceInput): Promise<WorkflowLearningExperience>;
	typeCandidate(input: { experienceId: string; trigger: WorkflowLearningTrigger }): Promise<WorkflowLearningCandidate>;
	reviewCandidate(candidateId: string, operationId?: string): Promise<WorkflowLearningReviewResult>;
	handleTrigger(trigger: WorkflowLearningTrigger): Promise<WorkflowLearningTriggerResult>;
	getState(): WorkflowLearningState;
}

const LEARNING_MUTATION_CLASSES: ReadonlySet<WorkflowLearningMutationClass> = new Set([
	"workflow",
	"methodology",
	"policy",
	"evaluator",
	"metric",
	"kernel",
	"authority",
	"scheduler",
	"recipe",
	"skill",
]);

const PROTECTED_AUTO_PROMOTION_CLASSES: ReadonlySet<WorkflowLearningMutationClass> = new Set([
	"kernel",
	"authority",
	"scheduler",
	"recipe",
	"skill",
]);

const TRIGGER_KINDS: ReadonlySet<WorkflowLearningTriggerKind> = new Set([
	"milestone",
	"failure",
	"regression",
	"efficiency_review",
]);

const MAX_LEARNING_TRIGGERS = 256;
const MAX_LEARNING_COLLECTION = 256;
const MAX_LEARNING_RECEIPTS = 64;
const MAX_LEARNING_SAMPLES = 100_000;
const MAX_LEARNING_METRIC = 1_000_000_000_000;
const MAX_LEARNING_STRING_BYTES = WORKFLOW_EVIDENCE_LIMITS.maxIdentifierBytes;
const PROTECTED_MUTATION_PATHS = ["skill", "skills", "subagent", "subagents", "harness"] as const;

function normalizeOpaqueKey(key: string): string {
	return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const OPAQUE_HOLDOUT_KEYS = new Set([
	"heldoutinput",
	"heldoutbytes",
	"heldoutinputbytes",
	"heldoutvalue",
	"hiddeninput",
	"hiddeninputbytes",
	"hiddeninputvalue",
	"holdoutinput",
	"holdoutbytes",
	"holdoutinputbytes",
	"holdoutvalue",
	"hiddenholdoutinput",
	"hiddenholdoutbytes",
	"hiddenholdoutvalue",
	"rawholdout",
	"rawholdoutinput",
	"holdoutraw",
	"holdoutsecret",
	"hiddensecret",
]);
const CAPABILITY_KEYS = new Set(["artifactresolver", "receiptcontext", "receiptport", "decisiongate"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digestPayload(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("Learning payload cannot be serialized.");
	return digestObject(JSON.parse(serialized) as unknown);
}

function stripReceiptPayload(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => stripReceiptPayload(item));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "hostReceipt" && key !== "receipt" && key !== "receipts")
			.map(([key, item]) => [key, stripReceiptPayload(item)]),
	);
}

function digestReceiptBindingPayload(value: unknown): string {
	return digestPayload(stripReceiptPayload(value));
}

function cleanPayload<T>(value: T): T {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("Learning payload cannot be serialized.");
	return JSON.parse(serialized) as T;
}

function assertBoundedString(
	value: unknown,
	label: string,
	maxBytes: number = MAX_LEARNING_STRING_BYTES,
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required.`);
	if (new TextEncoder().encode(value).byteLength > maxBytes) throw new Error(`${label} exceeds the bounded size.`);
}

function assertNonEmpty(value: string, label: string): void {
	assertBoundedString(value, label);
}

function assertCanonicalDigest(value: unknown, label: string): asserts value is string {
	assertBoundedString(value, label, 128);
	if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} is not canonical.`);
}

function assertArtifactRef(ref: WorkflowArtifactRef, label: string): void {
	if (
		!isRecord(ref) ||
		typeof ref.artifactId !== "string" ||
		typeof ref.relativePath !== "string" ||
		typeof ref.digest !== "string" ||
		ref.artifactId.trim().length === 0 ||
		ref.relativePath.trim().length === 0 ||
		ref.digest.trim().length === 0 ||
		!Number.isSafeInteger(ref.sizeBytes) ||
		ref.sizeBytes < 0 ||
		!Number.isSafeInteger(ref.sourceEventSequence) ||
		ref.sourceEventSequence < 0
	) {
		throw new Error(`${label} is not a complete artifact reference.`);
	}
	assertBoundedString(ref.artifactId, `${label} id`);
	assertBoundedString(ref.relativePath, `${label} path`, 1024);
	assertBoundedString(ref.digest, `${label} digest`, 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(ref.artifactId)) {
		throw new Error(`${label} id is not canonical.`);
	}
	if (
		ref.relativePath.startsWith("/") ||
		ref.relativePath.includes("\\") ||
		ref.relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
	) {
		throw new Error(`${label} path is not canonical.`);
	}
	if (!/^[a-f0-9]{64}$/i.test(ref.digest)) throw new Error(`${label} digest is not canonical.`);
	if (ref.sizeBytes > WORKFLOW_EVIDENCE_LIMITS.maxArtifactSizeBytes) {
		throw new Error(`${label} exceeds the bounded artifact size.`);
	}
}

function sameArtifactRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
	return digestObject(left) === digestObject(right);
}

function assertArtifactRefs(
	refs: readonly WorkflowArtifactRef[],
	label: string,
	maxCount: number = WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations,
): void {
	if (!Array.isArray(refs) || refs.length === 0 || refs.length > Math.min(maxCount, MAX_LEARNING_COLLECTION)) {
		throw new Error(`${label} must contain between one and ${maxCount} artifact references.`);
	}
	const digests = refs.map((ref) => {
		assertArtifactRef(ref, label);
		return digestObject(ref);
	});
	if (new Set(digests).size !== digests.length) throw new Error(`${label} contains duplicate artifact references.`);
}

function assertHostSnapshot(current: WorkflowLearningHostSnapshot): asserts current is WorkflowLearningHostSnapshot & {
	storeEpoch: number;
	coordinatorEpoch: number;
	stateHeadDigest: string;
} {
	if (!isRecord(current)) throw new Error("Learning host snapshot is required.");
	assertNonEmpty(current.workflowId, "Learning host workflow id");
	assertNonEmpty(current.stateDigest, "Learning host state digest");
	assertNonEmpty(current.trustedNow, "Learning host trusted time");
	if (!Number.isSafeInteger(current.currentRevision) || current.currentRevision < 1) {
		throw new Error("Learning host revision is invalid.");
	}
	const storeEpoch = current.storeEpoch;
	const coordinatorEpoch = current.coordinatorEpoch;
	if (typeof storeEpoch !== "number" || !Number.isSafeInteger(storeEpoch) || storeEpoch < 1) {
		throw new Error("Learning host store epoch is required.");
	}
	if (typeof coordinatorEpoch !== "number" || !Number.isSafeInteger(coordinatorEpoch) || coordinatorEpoch < 1) {
		throw new Error("Learning host coordinator epoch is required.");
	}
	assertNonEmpty(current.stateHeadDigest ?? "", "Learning host state head digest");
	assertReceipt(current.trustedClockReceipt, current, "Learning trusted clock receipt");
}

function hostProjection(current: WorkflowLearningHostSnapshot): WorkflowLearningHostProjection {
	assertHostSnapshot(current);
	const projection: WorkflowLearningHostProjection = {
		workflowId: current.workflowId,
		stateDigest: current.stateDigest,
		workspaceDigest: current.workspaceDigest,
		configDigest: current.configDigest,
		parserDigest: current.parserDigest,
		evaluatorDigest: current.evaluatorDigest,
		guardDigest: current.guardDigest,
		revisions: structuredClone(current.revisions),
		currentRevision: current.currentRevision,
		trustedNow: current.trustedNow,
		requiredFreshnessMilliseconds: current.requiredFreshnessMilliseconds,
		baselineRevision: current.baselineRevision,
		baselineDigest: current.baselineDigest,
		evaluatorBaselineDigest: current.evaluatorBaselineDigest,
		metricBaselineDigest: current.metricBaselineDigest,
		revisionRegistryDigest: current.revisionRegistryDigest,
		storeEpoch: current.storeEpoch,
		coordinatorEpoch: current.coordinatorEpoch,
		stateHeadDigest: current.stateHeadDigest,
	};
	return freezeProjection(projection);
}

function copyHostSnapshot(current: WorkflowLearningHostSnapshot): WorkflowLearningHostSnapshot {
	return {
		...current,
		revisions: structuredClone(current.revisions),
		trustedClockReceipt: structuredClone(current.trustedClockReceipt),
		artifactResolver: current.artifactResolver,
		receiptContext: current.receiptContext,
	};
}

function freezeProjection<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) freezeProjection(child);
		Object.freeze(value);
	}
	return value;
}

function immutableClone<T>(value: T): T {
	return freezeProjection(structuredClone(value));
}

function casExpectation(current: WorkflowLearningHostSnapshot): WorkflowLearningCasExpectation {
	assertHostSnapshot(current);
	return {
		currentRevision: current.currentRevision,
		storeEpoch: current.storeEpoch,
		coordinatorEpoch: current.coordinatorEpoch,
		stateHeadDigest: current.stateHeadDigest,
	};
}

function assertReceipt(
	receipt: WorkflowVerifiedHostReceipt,
	current: WorkflowLearningHostSnapshot,
	label: string,
): void {
	assertHostSnapshotBasic(current);
	if (
		!isRecord(receipt) ||
		typeof receipt.workflowId !== "string" ||
		receipt.workflowId !== current.workflowId ||
		typeof receipt.receiptId !== "string" ||
		typeof receipt.bindingDigest !== "string" ||
		typeof receipt.payloadDigest !== "string" ||
		typeof receipt.stateDigest !== "string" ||
		receipt.receiptId.trim().length === 0 ||
		receipt.bindingDigest.trim().length === 0 ||
		receipt.payloadDigest.trim().length === 0 ||
		receipt.stateDigest.trim().length === 0 ||
		!Number.isSafeInteger(receipt.revision) ||
		receipt.revision < 1
	) {
		throw new Error(`${label} is not bound to the current workflow.`);
	}
	assertBoundedString(receipt.receiptId, `${label} id`);
	assertBoundedString(receipt.issuerId, `${label} issuer`);
	assertBoundedString(receipt.bindingDigest, `${label} binding`, 128);
	assertBoundedString(receipt.payloadDigest, `${label} payload`, 128);
	assertBoundedString(receipt.stateDigest, `${label} state`, 128);
	assertBoundedString(receipt.issuedAt, `${label} issued time`);
	assertBoundedString(receipt.validUntil, `${label} expiry`);
	assertBoundedString(receipt.keyId, `${label} key`, 256);
	assertBoundedString(receipt.signature, `${label} signature`, 512);
	assertBoundedString(receipt.verificationDigest, `${label} verification`, 128);
	assertBoundedString(receipt.artifactBytesDigest, `${label} bytes digest`, 128);
	assertArtifactRef(receipt.artifactRef, `${label} artifact`);
	if (receipt.artifactBytesDigest !== receipt.artifactRef.digest) {
		throw new Error(`${label} bytes digest does not match its artifact reference.`);
	}
	if (receipt.stateDigest !== current.stateDigest) {
		throw new Error(`${label} is bound to a stale state digest.`);
	}
	const issuedAt = Date.parse(receipt.issuedAt);
	const validUntil = Date.parse(receipt.validUntil);
	const trustedNow = Date.parse(current.trustedNow);
	if (
		!Number.isFinite(issuedAt) ||
		!Number.isFinite(validUntil) ||
		!Number.isFinite(trustedNow) ||
		validUntil <= issuedAt ||
		trustedNow < issuedAt ||
		trustedNow > validUntil
	) {
		throw new Error(`${label} is outside the trusted host time window.`);
	}
	if (receipt.revision !== current.currentRevision) {
		throw new Error(`${label} is bound to a stale revision.`);
	}
}

function assertHostSnapshotBasic(current: WorkflowLearningHostSnapshot): void {
	if (!isRecord(current)) throw new Error("Learning host snapshot is required.");
	assertNonEmpty(current.workflowId, "Learning host workflow id");
	assertNonEmpty(current.stateDigest, "Learning host state digest");
	assertNonEmpty(current.trustedNow, "Learning host trusted time");
}

function assertReceiptSet(
	receipts: readonly WorkflowVerifiedHostReceipt[],
	current: WorkflowLearningHostSnapshot,
	label: string,
): void {
	if (!Array.isArray(receipts) || receipts.length === 0 || receipts.length > MAX_LEARNING_RECEIPTS)
		throw new Error(`${label} requires a bounded host receipt set.`);
	const ids = receipts.map((receipt) => {
		assertReceipt(receipt, current, label);
		return receipt.receiptId;
	});
	if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate receipts.`);
}

function assertWitness(
	witness: WorkflowLearningHostWitness,
	current: WorkflowLearningHostSnapshot,
	stage: string,
	candidateId: string | null,
	payloadDigest: string,
	ref: WorkflowArtifactRef,
	kind: WorkflowLearningWitnessKind,
): void {
	assertHostSnapshot(current);
	if (
		!isRecord(witness) ||
		witness.witnessKind !== kind ||
		witness.workflowId !== current.workflowId ||
		witness.stage !== stage ||
		witness.candidateId !== candidateId ||
		digestObject(witness.evidenceRef) !== digestObject(ref) ||
		witness.payloadDigest !== payloadDigest ||
		witness.bytesDigest !== ref.digest ||
		witness.bytesSize !== ref.sizeBytes ||
		witness.revision !== current.currentRevision ||
		witness.storeEpoch !== current.storeEpoch ||
		witness.coordinatorEpoch !== current.coordinatorEpoch ||
		witness.stateHeadDigest !== current.stateHeadDigest ||
		witness.trustedNow !== current.trustedNow ||
		typeof witness.oneUse !== "boolean"
	) {
		throw new Error(`${stage} witness is not bound to exact host bytes and state.`);
	}
	assertBoundedString(witness.witnessId, `${stage} witness id`);
	assertBoundedString(witness.payloadDigest, `${stage} witness payload`, 128);
	assertBoundedString(witness.bytesDigest, `${stage} witness bytes`, 128);
	assertBoundedString(witness.stateHeadDigest, `${stage} witness state head`, 128);
	assertBoundedString(witness.trustedNow, `${stage} witness trusted time`);
}

function assertWitnessSet(
	witnesses: readonly WorkflowLearningHostWitness[],
	refs: readonly WorkflowArtifactRef[],
	current: WorkflowLearningHostSnapshot,
	stage: string,
	candidateId: string | null,
	payloadDigest: string,
	kind: WorkflowLearningWitnessKind,
): void {
	if (!Array.isArray(witnesses) || witnesses.length !== refs.length || witnesses.length > MAX_LEARNING_RECEIPTS) {
		throw new Error(`${stage} requires resolver witnesses for every artifact.`);
	}
	const witnessIds = new Set<string>();
	for (const ref of refs) {
		const witness = witnesses.find((item) => digestObject(item.evidenceRef) === digestObject(ref));
		if (witness === undefined) throw new Error(`${stage} is missing an exact resolver witness.`);
		assertWitness(witness, current, stage, candidateId, payloadDigest, ref, kind);
		if (witnessIds.has(witness.witnessId)) throw new Error(`${stage} contains duplicate witnesses.`);
		witnessIds.add(witness.witnessId);
	}
}

function assertStageMetrics(metrics: WorkflowLearningStageMetrics | undefined, stage: string): void {
	if (
		!isRecord(metrics) ||
		!Number.isSafeInteger(metrics.sampleCount) ||
		metrics.sampleCount <= 0 ||
		metrics.sampleCount > MAX_LEARNING_SAMPLES ||
		!Number.isFinite(metrics.effectSize) ||
		Math.abs(metrics.effectSize) > MAX_LEARNING_METRIC ||
		!Number.isFinite(metrics.variance) ||
		metrics.variance < 0 ||
		metrics.variance > MAX_LEARNING_METRIC ||
		!Number.isFinite(metrics.costMicrounits) ||
		metrics.costMicrounits < 0 ||
		metrics.costMicrounits > MAX_LEARNING_METRIC ||
		!Number.isFinite(metrics.latencyMilliseconds) ||
		metrics.latencyMilliseconds < 0 ||
		metrics.latencyMilliseconds > MAX_LEARNING_METRIC
	) {
		throw new Error(`${stage} requires positive bounded host-derived metrics.`);
	}
	assertBoundedString(metrics.evaluatorDigest, `${stage} evaluator digest`, 128);
	assertBoundedString(metrics.metricDigest, `${stage} metric digest`, 128);
	assertBoundedString(metrics.evidenceDigest, `${stage} metric evidence digest`, 128);
}

function stageMetricsSatisfyCandidate(
	metrics: WorkflowLearningStageMetrics | undefined,
	candidate: WorkflowLearningCandidate,
	evidenceRefs: readonly WorkflowArtifactRef[],
): boolean {
	if (!stageMetricsValid(metrics) || metrics === undefined) return false;
	return (
		metrics.sampleCount >= candidate.caseManifest.requiredSampleSize &&
		metrics.effectSize > 0 &&
		metrics.effectSize >= candidate.caseManifest.effectThreshold &&
		metrics.costMicrounits <= candidate.caseManifest.maxCostMicrounits &&
		metrics.latencyMilliseconds <= candidate.caseManifest.maxLatencyMilliseconds &&
		metrics.evidenceDigest === digestObject(evidenceRefs)
	);
}

function assertCasOutput(
	output: {
		stateHeadDigest?: string;
		storeEpoch?: number;
		coordinatorEpoch?: number;
		casExecutionKey?: string;
	},
	expected: WorkflowLearningCasExpectation,
	kind: string,
): void {
	if (
		!isRecord(output) ||
		typeof output.stateHeadDigest !== "string" ||
		output.stateHeadDigest === expected.stateHeadDigest ||
		output.storeEpoch !== expected.storeEpoch ||
		output.coordinatorEpoch !== expected.coordinatorEpoch ||
		typeof output.casExecutionKey !== "string"
	) {
		throw new Error(`${kind} requires a host CAS identity bound to head and epoch.`);
	}
	assertBoundedString(output.stateHeadDigest, `${kind} state head`, 128);
	assertBoundedString(output.casExecutionKey, `${kind} CAS execution key`, 256);
}

function assertPostPromotionSnapshot(
	current: WorkflowLearningHostSnapshot,
	promotion: WorkflowLearningPromotion,
	expected: WorkflowLearningCasExpectation,
): void {
	assertHostSnapshot(current);
	assertCasOutput(promotion, expected, "Promotion");
	if (
		current.currentRevision !== promotion.revision ||
		current.stateHeadDigest !== promotion.stateHeadDigest ||
		current.storeEpoch !== promotion.storeEpoch ||
		current.coordinatorEpoch !== promotion.coordinatorEpoch
	) {
		throw new Error("Promotion postcondition snapshot is not bound to the host CAS result.");
	}
}

function assertCandidateClassification(
	candidate: WorkflowLearningCandidate,
	classification: WorkflowLearningCandidateClassification,
): void {
	if (
		!isRecord(classification) ||
		classification.mutationClass !== candidate.mutationClass ||
		classification.payloadDigest !== candidate.candidateDigest
	) {
		throw new Error("Host classifier disagrees with the immutable candidate mutation identity.");
	}
	assertBoundedString(classification.classifierDigest, "Candidate classifier digest", 128);
	if (
		!Array.isArray(classification.protectedPaths) ||
		classification.protectedPaths.length > MAX_LEARNING_COLLECTION
	) {
		throw new Error("Candidate classifier protected paths are invalid.");
	}
	for (const path of classification.protectedPaths) {
		assertBoundedString(path, "Candidate protected path", 1024);
		const normalized = path.toLowerCase().replaceAll("\\", "/");
		if (PROTECTED_MUTATION_PATHS.some((prefix) => normalized.split("/").includes(prefix))) {
			throw new Error("Protected skill, subagent, or harness paths cannot be mislabeled as workflow changes.");
		}
	}
	if (candidate.proposal !== null && classification.proposalDigest !== digestObject(candidate.proposal)) {
		throw new Error("Legacy refinement proposal is not bound to the host classifier payload.");
	}
	if (candidate.proposal !== null) {
		assertBoundedString(candidate.proposal.summary, "Legacy proposal summary", 2048);
		assertBoundedString(candidate.proposal.rationale, "Legacy proposal rationale", 4096);
		assertBoundedString(candidate.proposal.expectedOutcome, "Legacy proposal outcome", 2048);
		if (!Array.isArray(candidate.proposal.edits) || candidate.proposal.edits.length > MAX_LEARNING_COLLECTION) {
			throw new Error("Legacy refinement proposal edits are bounded.");
		}
		for (const edit of candidate.proposal.edits) {
			assertOpaque(edit);
			if (edit.kind === "subagent" || (edit.kind === "skill" && candidate.mutationClass !== "skill")) {
				throw new Error("Protected skill and subagent changes cannot be mislabeled as workflow changes.");
			}
			if (edit.path !== undefined) {
				assertBoundedString(edit.path, "Legacy proposal path", 1024);
				const normalized = edit.path.toLowerCase().replaceAll("\\", "/");
				if (PROTECTED_MUTATION_PATHS.some((prefix) => normalized.split("/").includes(prefix))) {
					throw new Error("Protected skill, subagent, or harness paths cannot be mislabeled as workflow changes.");
				}
			}
		}
	}
}

function assertWorkflowDecisionRef(
	ref: WorkflowDecisionRef,
	workflowId: string,
	label: string,
	current?: WorkflowLearningHostSnapshot,
): void {
	if (
		!isRecord(ref) ||
		typeof ref.decisionId !== "string" ||
		typeof ref.decisionDigest !== "string" ||
		ref.decisionId.trim().length === 0 ||
		ref.decisionDigest.trim().length === 0 ||
		!Number.isSafeInteger(ref.revision) ||
		ref.revision < 1 ||
		!Number.isSafeInteger(ref.storeEpoch) ||
		ref.storeEpoch < 1 ||
		!Number.isSafeInteger(ref.coordinatorEpoch) ||
		ref.coordinatorEpoch < 1 ||
		!isRecord(ref.decisionScope) ||
		ref.decisionScope.kind !== "workflow" ||
		ref.decisionScope.workflowId !== workflowId ||
		typeof ref.decisionScope.rootSessionId !== "string" ||
		ref.decisionScope.rootSessionId.trim().length === 0
	) {
		throw new Error(`${label} is not a positive workflow-scoped decision reference.`);
	}
	assertBoundedString(ref.decisionId, `${label} id`);
	assertBoundedString(ref.decisionDigest, `${label} digest`, 128);
	assertBoundedString(ref.decisionScope.rootSessionId, `${label} root session`);
	if (
		current !== undefined &&
		(ref.revision !== current.currentRevision ||
			ref.storeEpoch !== current.storeEpoch ||
			ref.coordinatorEpoch !== current.coordinatorEpoch)
	) {
		throw new Error(`${label} is stale for the current host epoch.`);
	}
}

function sameDecisionRef(left: WorkflowDecisionRef, right: WorkflowDecisionRef): boolean {
	return digestObject(left) === digestObject(right);
}

function assertOpaque(value: unknown): void {
	if (typeof value === "function") throw new Error("Learning stage payloads cannot carry host capabilities.");
	if (Array.isArray(value)) {
		for (const item of value) assertOpaque(item);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (CAPABILITY_KEYS.has(normalizeOpaqueKey(key))) {
			throw new Error("Learning stage payloads cannot carry host capabilities.");
		}
		if (OPAQUE_HOLDOUT_KEYS.has(normalizeOpaqueKey(key)))
			throw new Error("Held-out inputs must remain opaque to the learning controller.");
		assertOpaque(child);
	}
}

function assertTriggerShape(trigger: WorkflowLearningTrigger): void {
	if (!isRecord(trigger)) throw new Error("Learning trigger is required.");
	if (!TRIGGER_KINDS.has(trigger.kind)) throw new Error("Learning trigger is not an allowed host event trigger.");
	if (trigger.candidateId !== null) assertNonEmpty(trigger.candidateId, "Learning trigger candidate id");
	assertArtifactRef(trigger.sourceEventRef, "Learning trigger source event");
	assertArtifactRefs(trigger.evidenceRefs, "Learning trigger evidence");
	assertNonEmpty(trigger.workflowId ?? "", "Learning trigger workflow id");
	assertNonEmpty(trigger.stateHeadDigest ?? "", "Learning trigger state head");
	const storeEpoch = trigger.storeEpoch;
	const coordinatorEpoch = trigger.coordinatorEpoch;
	if (typeof storeEpoch !== "number" || !Number.isSafeInteger(storeEpoch) || storeEpoch < 1) {
		throw new Error("Learning trigger store epoch is required.");
	}
	if (typeof coordinatorEpoch !== "number" || !Number.isSafeInteger(coordinatorEpoch) || coordinatorEpoch < 1) {
		throw new Error("Learning trigger coordinator epoch is required.");
	}
	assertNonEmpty(trigger.evidenceDigest ?? "", "Learning trigger evidence digest");
	if (trigger.evidenceDigest !== digestObject(trigger.evidenceRefs)) {
		throw new Error("Learning trigger evidence digest does not match its immutable references.");
	}
	if (trigger.hostReceipt === undefined) throw new Error("Learning trigger requires an authenticated host receipt.");
}

function assertTrigger(trigger: WorkflowLearningTrigger, current?: WorkflowLearningHostSnapshot): void {
	assertTriggerShape(trigger);
	if (current === undefined) return;
	assertHostSnapshot(current);
	if (
		trigger.workflowId !== current.workflowId ||
		trigger.storeEpoch !== current.storeEpoch ||
		trigger.coordinatorEpoch !== current.coordinatorEpoch ||
		trigger.stateHeadDigest !== current.stateHeadDigest
	) {
		throw new Error("Learning trigger is not bound to the current workflow epoch and state head.");
	}
	assertReceipt(trigger.hostReceipt as WorkflowVerifiedHostReceipt, current, "Learning trigger receipt");
}

function assertExperienceInput(input: WorkflowLearningExperienceInput): void {
	assertOpaque(input);
	assertNonEmpty(input.experienceId, "Experience id");
	assertNonEmpty(input.workflowId, "Experience workflow id");
	assertNonEmpty(input.committedAt, "Experience committed time");
	assertArtifactRef(input.sourceEventRef, "Experience source event");
	assertNonEmpty(input.hostReceipt.receiptId, "Experience host receipt");
	assertArtifactRefs(input.progressEvidenceRefs, "Experience progress evidence");
	if (input.source !== "host") throw new Error("Only host-committed evidence can create validated experience.");
	if (
		input.progressEvidenceRefs.length === 0 ||
		input.progressKind === "utilization" ||
		input.progressKind === "tokens" ||
		(input.outcome === "positive" && input.progressKind !== "verified") ||
		(input.outcome !== "positive" && input.progressKind !== "verified" && input.progressKind !== "none")
	) {
		throw new Error("Learning progress requires independently verified evidence, not utilization or tokens.");
	}
	if (input.evidence.length === 0) throw new Error("Committed experience requires host evidence.");
	const evidenceIds = input.evidence.map((item) => item.evidenceId);
	if (evidenceIds.some((id) => typeof id !== "string" || id.trim().length === 0))
		throw new Error("Committed experience evidence ids are required.");
	if (new Set(evidenceIds).size !== evidenceIds.length)
		throw new Error("Committed experience evidence ids are duplicated.");
	if (input.evidence.length > MAX_LEARNING_COLLECTION) throw new Error("Committed experience evidence is bounded.");
}

function assertReplayedEvidenceEnvelope(evidence: WorkflowEvidenceEnvelope, workflowId: string): void {
	if (!isRecord(evidence)) throw new Error("Replayed evidence envelope is required.");
	assertBoundedString(evidence.evidenceId, "Replayed evidence id");
	assertBoundedString(evidence.requirementId, "Replayed evidence requirement");
	assertBoundedString(evidence.claim, "Replayed evidence claim", WORKFLOW_EVIDENCE_LIMITS.maxClaimBytes);
	assertBoundedString(evidence.result, "Replayed evidence result", WORKFLOW_EVIDENCE_LIMITS.maxResultBytes);
	assertBoundedString(evidence.method, "Replayed evidence method", WORKFLOW_EVIDENCE_LIMITS.maxMethodBytes);
	if (!Number.isSafeInteger(evidence.evidenceRevision) || evidence.evidenceRevision < 1) {
		throw new Error("Replayed evidence revision is invalid.");
	}
	for (const [revisionName, revision] of Object.entries(evidence.revisions)) {
		if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(`Replayed ${revisionName} is invalid.`);
	}
	for (const [digest, label] of [
		[evidence.workspaceDigest, "workspace digest"],
		[evidence.configDigest, "config digest"],
		[evidence.evaluatorDigest, "evaluator digest"],
		[evidence.parserDigest, "parser digest"],
		[evidence.guardDigest, "guard digest"],
		[evidence.updatedDigest, "updated digest"],
	] as const)
		assertBoundedString(digest, `Replayed evidence ${label}`, 128);
	assertBoundedString(evidence.observedAt, "Replayed evidence observed time");
	assertBoundedString(evidence.freshUntil, "Replayed evidence freshness time");
	if (
		!Number.isSafeInteger(evidence.freshnessWindowMilliseconds) ||
		evidence.freshnessWindowMilliseconds < 0 ||
		evidence.freshnessWindowMilliseconds > WORKFLOW_EVIDENCE_LIMITS.maxFreshnessMilliseconds
	) {
		throw new Error("Replayed evidence freshness window is invalid.");
	}
	if (!Array.isArray(evidence.limitations) || evidence.limitations.length > WORKFLOW_EVIDENCE_LIMITS.maxLimitations) {
		throw new Error("Replayed evidence limitations are bounded.");
	}
	for (const limitation of evidence.limitations)
		assertBoundedString(limitation, "Replayed evidence limitation", WORKFLOW_EVIDENCE_LIMITS.maxLimitationBytes);
	if (!Array.isArray(evidence.artifactObservations) || evidence.artifactObservations.length > MAX_LEARNING_RECEIPTS) {
		throw new Error("Replayed evidence artifacts are bounded.");
	}
	for (const observation of evidence.artifactObservations) {
		if (!isRecord(observation) || observation.exists !== true || !isRecord(observation.artifactRef)) {
			throw new Error("Replayed evidence artifact observation is invalid.");
		}
		const artifactRef = observation.artifactRef as unknown as WorkflowArtifactRef;
		assertArtifactRef(artifactRef, "Replayed evidence artifact");
		if (
			observation.verifiedDigest !== artifactRef.digest ||
			observation.verifiedSizeBytes !== artifactRef.sizeBytes
		) {
			throw new Error("Replayed evidence artifact bytes are not bound to their reference.");
		}
	}
	if (!isRecord(evidence.scanner)) throw new Error("Replayed evidence scanner is required.");
	assertBoundedString(evidence.scanner.scannerDigest, "Replayed scanner digest", 128);
	assertBoundedString(evidence.scanner.findingDigest, "Replayed scanner finding digest", 128);
	if (
		!Array.isArray(evidence.scanner.findingCodes) ||
		evidence.scanner.findingCodes.length > WORKFLOW_EVIDENCE_LIMITS.maxScannerFindings
	) {
		throw new Error("Replayed scanner findings are bounded.");
	}
	for (const findingCode of evidence.scanner.findingCodes)
		assertBoundedString(findingCode, "Replayed scanner finding", WORKFLOW_EVIDENCE_LIMITS.maxScannerFindingCodeBytes);
	if (evidence.invalidatedByDecisionRef !== null)
		assertWorkflowDecisionRef(evidence.invalidatedByDecisionRef, workflowId, "Replayed invalidation decision");
	if (evidence.auditorDecisionRef !== null)
		assertWorkflowDecisionRef(evidence.auditorDecisionRef, workflowId, "Replayed auditor decision");
	if (evidence.command !== null) {
		if (!isRecord(evidence.command)) throw new Error("Replayed evidence command is invalid.");
		assertBoundedString(evidence.command.commandDigest, "Replayed command digest", 128);
		assertBoundedString(evidence.command.outputDigest, "Replayed command output digest", 128);
		if (
			typeof evidence.command.stdout !== "string" ||
			typeof evidence.command.stderr !== "string" ||
			new TextEncoder().encode(evidence.command.stdout).byteLength >
				WORKFLOW_EVIDENCE_LIMITS.maxCommandOutputBytes ||
			new TextEncoder().encode(evidence.command.stderr).byteLength > WORKFLOW_EVIDENCE_LIMITS.maxCommandOutputBytes
		) {
			throw new Error("Replayed command output is bounded.");
		}
		if (
			!Number.isSafeInteger(evidence.command.stdoutBytes) ||
			evidence.command.stdoutBytes < 0 ||
			!Number.isSafeInteger(evidence.command.stderrBytes) ||
			evidence.command.stderrBytes < 0 ||
			evidence.command.stdoutBytes > WORKFLOW_EVIDENCE_LIMITS.maxCommandOutputBytes ||
			evidence.command.stderrBytes > WORKFLOW_EVIDENCE_LIMITS.maxCommandOutputBytes
		) {
			throw new Error("Replayed command output bounds are invalid.");
		}
	}
}

function assertReplayedReceipt(receipt: WorkflowVerifiedHostReceipt, workflowId: string, label: string): void {
	if (
		!isRecord(receipt) ||
		receipt.workflowId !== workflowId ||
		!Number.isSafeInteger(receipt.revision) ||
		receipt.revision < 1 ||
		receipt.oneUse !== true
	) {
		throw new Error(`${label} is not a replayable host receipt.`);
	}
	for (const [value, field] of [
		[receipt.receiptId, "id"],
		[receipt.issuerId, "issuer"],
		[receipt.bindingDigest, "binding"],
		[receipt.payloadDigest, "payload"],
		[receipt.stateDigest, "state"],
		[receipt.issuedAt, "issued time"],
		[receipt.validUntil, "expiry"],
		[receipt.keyId, "key"],
		[receipt.signature, "signature"],
		[receipt.verificationDigest, "verification"],
		[receipt.artifactBytesDigest, "bytes digest"],
	] as const)
		assertBoundedString(value, `${label} ${field}`, 512);
	assertArtifactRef(receipt.artifactRef, `${label} artifact`);
	if (receipt.artifactBytesDigest !== receipt.artifactRef.digest) {
		throw new Error(`${label} bytes are not bound to the artifact reference.`);
	}
	const issuedAt = Date.parse(receipt.issuedAt);
	const validUntil = Date.parse(receipt.validUntil);
	if (!Number.isFinite(issuedAt) || !Number.isFinite(validUntil) || validUntil <= issuedAt) {
		throw new Error(`${label} time window is invalid.`);
	}
}

function assertReplayedCandidate(candidate: WorkflowLearningCandidate, experience: WorkflowLearningExperience): void {
	assertOpaque(candidate);
	if (
		candidate.experienceId !== experience.experienceId ||
		candidate.workflowId !== experience.workflowId ||
		!LEARNING_MUTATION_CLASSES.has(candidate.mutationClass) ||
		!new Set(["workflow", "methodology", "policy", "evaluator", "knowledge"]).has(candidate.kind) ||
		!new Set(["policy", "native", "autoresearch", "knowledge"]).has(candidate.owner) ||
		!new Set(["durable", "native", "autoresearch", "knowledge"]).has(candidate.producer)
	) {
		throw new Error("Replayed candidate identity or mutation class is invalid.");
	}
	for (const [value, label] of [
		[candidate.candidateId, "id"],
		[candidate.candidateDigest, "digest"],
		[candidate.baselineDigest, "baseline digest"],
		[candidate.scorecardDigest, "scorecard digest"],
		[candidate.evaluatorDigest, "evaluator digest"],
	] as const)
		assertBoundedString(value, `Replayed candidate ${label}`, 128);
	if (!Number.isSafeInteger(candidate.baselineRevision) || candidate.baselineRevision < 1) {
		throw new Error("Replayed candidate baseline revision is invalid.");
	}
	for (const [artifact, label] of [
		[candidate.proposalRef, "proposal"],
		[candidate.candidateRef, "candidate"],
		[candidate.baselineArtifactRef, "baseline"],
		[candidate.scorecardRef, "scorecard"],
		[candidate.evaluatorRef, "evaluator"],
		[candidate.parserRef, "parser"],
		[candidate.hiddenHoldoutManifestRef, "held-out manifest"],
	] as const)
		assertArtifactRef(artifact, `Replayed candidate ${label}`);
	if (
		candidate.candidateDigest !== candidate.candidateRef.digest ||
		candidate.scorecardDigest !== candidate.scorecardRef.digest ||
		candidate.evaluatorDigest !== candidate.evaluatorRef.digest
	) {
		throw new Error("Replayed candidate scorer or mutation identity is not content-bound.");
	}
	const manifest = candidate.caseManifest;
	if (
		!isRecord(manifest) ||
		manifest.kind !== "held_out" ||
		manifest.hidden !== true ||
		!Number.isSafeInteger(manifest.requiredSampleSize) ||
		manifest.requiredSampleSize <= 0 ||
		manifest.requiredSampleSize > MAX_LEARNING_SAMPLES ||
		!Number.isFinite(manifest.effectThreshold) ||
		manifest.effectThreshold < 0 ||
		Math.abs(manifest.effectThreshold) > MAX_LEARNING_METRIC ||
		!Number.isFinite(manifest.tolerance) ||
		manifest.tolerance < 0 ||
		manifest.tolerance > MAX_LEARNING_METRIC ||
		!Number.isFinite(manifest.maxCostMicrounits) ||
		manifest.maxCostMicrounits < 0 ||
		manifest.maxCostMicrounits > MAX_LEARNING_METRIC ||
		!Number.isFinite(manifest.maxLatencyMilliseconds) ||
		manifest.maxLatencyMilliseconds < 0 ||
		manifest.maxLatencyMilliseconds > MAX_LEARNING_METRIC ||
		manifest.inputDigest === manifest.heldOutInputDigest
	) {
		throw new Error("Replayed candidate holdout manifest is invalid.");
	}
	assertBoundedString(manifest.manifestId, "Replayed candidate manifest id");
	assertBoundedString(manifest.inputDigest, "Replayed candidate input digest", 128);
	assertBoundedString(manifest.heldOutInputDigest, "Replayed candidate held-out identity", 128);
	assertBoundedString(manifest.manifestDigest, "Replayed candidate manifest digest", 128);
	assertArtifactRefs(manifest.sourceArtifactRefs, "Replayed candidate source artifacts");
	assertArtifactRefs(manifest.nonRegressionPredicateRefs, "Replayed candidate predicates");
	assertReplayedReceipt(candidate.hostReceipt, candidate.workflowId, "Replayed candidate receipt");
}

function assertReplayedWitness(
	witness: WorkflowLearningHostWitness,
	workflowId: string,
	stage: string,
	candidateId: string | null,
	payloadDigest: string,
	ref: WorkflowArtifactRef,
	kind: WorkflowLearningWitnessKind = "evidence",
	requireOneUse = false,
): void {
	if (
		!isRecord(witness) ||
		witness.witnessKind !== kind ||
		witness.workflowId !== workflowId ||
		witness.stage !== stage ||
		witness.candidateId !== candidateId ||
		witness.payloadDigest !== payloadDigest ||
		typeof witness.oneUse !== "boolean" ||
		(requireOneUse && witness.oneUse !== true) ||
		!Number.isSafeInteger(witness.revision) ||
		witness.revision < 1 ||
		!Number.isSafeInteger(witness.storeEpoch) ||
		witness.storeEpoch < 1 ||
		!Number.isSafeInteger(witness.coordinatorEpoch) ||
		witness.coordinatorEpoch < 1 ||
		witness.bytesDigest !== ref.digest ||
		witness.bytesSize !== ref.sizeBytes ||
		digestObject(witness.evidenceRef) !== digestObject(ref)
	) {
		throw new Error("Replayed host witness is not bound to exact evidence and state.");
	}
	assertBoundedString(witness.witnessId, "Replayed witness id");
	assertBoundedString(witness.payloadDigest, "Replayed witness payload", 128);
	assertBoundedString(witness.bytesDigest, "Replayed witness bytes", 128);
	assertBoundedString(witness.stateHeadDigest, "Replayed witness state head", 128);
	assertBoundedString(witness.trustedNow, "Replayed witness trusted time");
	assertArtifactRef(witness.evidenceRef, "Replayed witness artifact");
	if (!Number.isFinite(Date.parse(witness.trustedNow))) throw new Error("Replayed witness time is invalid.");
}

function assertReplayedStageWitnesses(
	witnesses: readonly WorkflowLearningHostWitness[] | undefined,
	refs: readonly WorkflowArtifactRef[],
	workflowId: string,
	candidateId: string | null,
	stage: string,
	payloadDigest: string,
	kind: WorkflowLearningWitnessKind = "evidence",
	requireOneUse = false,
): void {
	if (!Array.isArray(witnesses) || witnesses.length !== refs.length || witnesses.length > MAX_LEARNING_RECEIPTS) {
		throw new Error(`Replayed ${stage} witnesses are required and bounded.`);
	}
	const ids = new Set<string>();
	for (const ref of refs) {
		const witness = witnesses.find((item) => digestObject(item.evidenceRef) === digestObject(ref));
		if (witness === undefined) throw new Error(`Replayed ${stage} witness is missing.`);
		assertReplayedWitness(witness, workflowId, stage, candidateId, payloadDigest, ref, kind, requireOneUse);
		if (ids.has(witness.witnessId)) throw new Error(`Replayed ${stage} witness identity is duplicated.`);
		ids.add(witness.witnessId);
	}
}

function assertCandidate(
	candidate: WorkflowLearningCandidate,
	experience: WorkflowLearningExperience,
	current: WorkflowLearningHostSnapshot,
): void {
	assertOpaque(candidate);
	assertNonEmpty(candidate.candidateId, "Candidate id");
	assertNonEmpty(candidate.experienceId, "Candidate experience id");
	assertNonEmpty(candidate.workflowId, "Candidate workflow id");
	if (!LEARNING_MUTATION_CLASSES.has(candidate.mutationClass)) {
		throw new Error("Candidate mutation class is outside the closed learning vocabulary.");
	}
	if (candidate.experienceId !== experience.experienceId || candidate.workflowId !== current.workflowId) {
		throw new Error("Typed candidate is not bound to the committed experience and current workflow.");
	}
	if (candidate.baselineRevision !== current.baselineRevision || candidate.baselineDigest !== current.baselineDigest) {
		throw new Error("Typed candidate is not bound to the current host baseline.");
	}
	for (const [value, label] of [
		[candidate.candidateDigest, "Candidate digest"],
		[candidate.scorecardDigest, "Candidate scorecard digest"],
		[candidate.evaluatorDigest, "Candidate evaluator digest"],
	] as const)
		assertNonEmpty(value, label);
	if (candidate.candidateDigest !== candidate.candidateRef.digest) {
		throw new Error("Candidate mutation identity is not bound to its immutable candidate artifact.");
	}
	assertArtifactRef(candidate.proposalRef, "Candidate proposal");
	assertArtifactRef(candidate.candidateRef, "Candidate artifact");
	assertArtifactRef(candidate.baselineArtifactRef, "Candidate baseline");
	assertArtifactRef(candidate.scorecardRef, "Candidate scorecard");
	assertArtifactRef(candidate.evaluatorRef, "Candidate evaluator");
	assertArtifactRef(candidate.parserRef, "Candidate parser");
	assertArtifactRef(candidate.hiddenHoldoutManifestRef, "Candidate held-out manifest");
	assertBoundedString(candidate.caseManifest.manifestId, "Candidate case manifest id");
	assertBoundedString(candidate.caseManifest.inputDigest, "Candidate case input digest", 128);
	assertBoundedString(candidate.caseManifest.heldOutInputDigest, "Candidate held-out identity", 128);
	assertBoundedString(candidate.caseManifest.manifestDigest, "Candidate case manifest digest", 128);
	assertArtifactRefs(candidate.caseManifest.sourceArtifactRefs, "Candidate case source artifacts");
	assertArtifactRefs(candidate.caseManifest.nonRegressionPredicateRefs, "Candidate non-regression predicates");
	if (
		!Number.isFinite(candidate.caseManifest.effectThreshold) ||
		candidate.caseManifest.effectThreshold < 0 ||
		Math.abs(candidate.caseManifest.effectThreshold) > MAX_LEARNING_METRIC ||
		!Number.isFinite(candidate.caseManifest.tolerance) ||
		candidate.caseManifest.tolerance < 0 ||
		candidate.caseManifest.tolerance > MAX_LEARNING_METRIC ||
		!Number.isFinite(candidate.caseManifest.maxCostMicrounits) ||
		candidate.caseManifest.maxCostMicrounits < 0 ||
		candidate.caseManifest.maxCostMicrounits > MAX_LEARNING_METRIC ||
		!Number.isFinite(candidate.caseManifest.maxLatencyMilliseconds) ||
		candidate.caseManifest.maxLatencyMilliseconds < 0 ||
		candidate.caseManifest.maxLatencyMilliseconds > MAX_LEARNING_METRIC
	) {
		throw new Error("Candidate case manifest metrics are invalid.");
	}
	if (
		!Number.isSafeInteger(candidate.caseManifest.requiredSampleSize) ||
		candidate.caseManifest.requiredSampleSize <= 0
	) {
		throw new Error("Candidate held-out sample size must be positive.");
	}
	if (candidate.caseManifest.requiredSampleSize > MAX_LEARNING_SAMPLES) {
		throw new Error("Candidate held-out sample size is bounded.");
	}
	if (
		candidate.caseManifest.kind !== "held_out" ||
		candidate.caseManifest.hidden !== true ||
		candidate.caseManifest.heldOutInputDigest.trim().length === 0 ||
		candidate.caseManifest.manifestDigest.trim().length === 0
	) {
		throw new Error("Typed candidate must carry a host-committed opaque held-out manifest.");
	}
	if (candidate.caseManifest.inputDigest === candidate.caseManifest.heldOutInputDigest) {
		throw new Error("Typed candidate must keep same-case and held-out inputs distinct.");
	}
	assertReceipt(candidate.hostReceipt, current, "Candidate host receipt");
}

function assertWorkflowDecision(
	decision: DurableDecisionRecord,
	workflowId: string,
): asserts decision is WorkflowDecisionRecord {
	if (
		decision.decisionScope.kind !== "workflow" ||
		decision.decisionScope.workflowId !== workflowId ||
		decision.decisionScope.rootSessionId.trim().length === 0
	) {
		throw new Error("Learning promotion requires a workflow-scoped host decision.");
	}
}

function assertReviewResult(candidate: WorkflowLearningCandidate, shadow: WorkflowLearningShadowResult): void {
	assertOpaque(shadow);
	if (shadow.candidateId !== candidate.candidateId) throw new Error("Shadow result is not bound to the candidate.");
	assertNonEmpty(shadow.sameCaseInputDigest, "Same-case input digest");
	assertNonEmpty(shadow.heldOutInputDigest, "Held-out input digest");
	assertArtifactRefs(shadow.evidenceRefs, "Shadow review evidence");
	assertArtifactRef(shadow.resultRef, "Shadow review result");
	if (
		shadow.heldOutSampleCount <= 0 ||
		!Number.isSafeInteger(shadow.heldOutSampleCount) ||
		shadow.heldOutSampleCount > MAX_LEARNING_SAMPLES
	) {
		throw new Error("Held-out sample count is invalid.");
	}
}

type LearningStageArtifactStage = "shadow" | "canary" | "red_team";
type LearningStageResult = WorkflowLearningShadowResult | WorkflowLearningCanaryResult | WorkflowLearningRedTeamResult;

function assertTypedStageResultArtifact(
	value: unknown,
	stage: LearningStageArtifactStage,
	result: LearningStageResult,
	candidate: WorkflowLearningCandidate,
): void {
	if (!isRecord(value)) throw new Error(`${stage} evaluator artifact is not a closed record.`);
	if (
		value.schemaVersion !== 1 ||
		value.kind !== "workflow_learning_stage_result" ||
		value.workflowId !== candidate.workflowId ||
		value.candidateId !== candidate.candidateId ||
		value.stage !== stage ||
		digestObject(value.evidenceRefs) !== digestObject(result.evidenceRefs) ||
		digestObject(value.metrics ?? null) !== digestObject(result.metrics ?? null)
	) {
		throw new Error(`${stage} evaluator artifact is not bound to the typed host result.`);
	}
	if (stage === "shadow") {
		const shadow = result as WorkflowLearningShadowResult;
		if (
			value.sameCaseInputDigest !== shadow.sameCaseInputDigest ||
			value.heldOutInputDigest !== shadow.heldOutInputDigest ||
			value.heldOutSampleCount !== shadow.heldOutSampleCount ||
			value.heldOutPassed !== shadow.heldOutPassed ||
			value.overfittingDetected !== shadow.overfittingDetected ||
			value.nonRegressionPassed !== shadow.nonRegressionPassed ||
			value.safetyPassed !== shadow.safetyPassed
		) {
			throw new Error("Shadow evaluator booleans are not bound to parsed evidence.");
		}
		return;
	}
	const resultWithPass = result as WorkflowLearningCanaryResult | WorkflowLearningRedTeamResult;
	if (value.passed !== resultWithPass.passed)
		throw new Error(`${stage} evaluator boolean is not bound to parsed evidence.`);
}

function assertHoldoutManifestArtifact(value: unknown, candidate: WorkflowLearningCandidate): void {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.kind !== "workflow_learning_holdout_manifest" ||
		value.workflowId !== candidate.workflowId ||
		value.candidateId !== candidate.candidateId ||
		value.manifestDigest !== candidate.caseManifest.manifestDigest ||
		!isRecord(value.manifest) ||
		digestObject(value.manifest) !== digestObject(candidate.caseManifest)
	) {
		throw new Error("Candidate holdout manifest bytes are not bound to its schema, digest, and candidate.");
	}
	const manifestWithoutDigest = { ...candidate.caseManifest, manifestDigest: "" };
	if (candidate.caseManifest.manifestDigest !== digestObject(manifestWithoutDigest)) {
		throw new Error("Candidate holdout manifest digest is not derived from its canonical bytes.");
	}
}

function stageMetricsValid(metrics: WorkflowLearningStageMetrics | undefined): boolean {
	try {
		assertStageMetrics(metrics, "Learning stage");
		return true;
	} catch (_error: unknown) {
		return false;
	}
}

function assertCanaryResult(candidate: WorkflowLearningCandidate, canary: WorkflowLearningCanaryResult): void {
	assertOpaque(canary);
	if (canary.candidateId !== candidate.candidateId) throw new Error("Canary result is not bound to the candidate.");
	assertNonEmpty(canary.inputDigest, "Canary input digest");
	assertNonEmpty(canary.sessionId, "Canary session id");
	assertNonEmpty(canary.executionIdentity, "Canary execution identity");
	assertArtifactRefs(canary.evidenceRefs, "Canary review evidence");
	assertArtifactRef(canary.resultRef, "Canary review result");
}

function assertRedTeamResult(
	candidate: WorkflowLearningCandidate,
	canary: WorkflowLearningCanaryResult,
	redTeam: WorkflowLearningRedTeamResult,
): void {
	assertOpaque(redTeam);
	if (redTeam.candidateId !== candidate.candidateId || !redTeam.independent) {
		throw new Error("Independent red-team result is not bound to the candidate.");
	}
	assertNonEmpty(redTeam.sessionId, "Red-team session id");
	assertNonEmpty(redTeam.executionIdentity, "Red-team execution identity");
	if (redTeam.sessionId === canary.sessionId || redTeam.executionIdentity === canary.executionIdentity) {
		throw new Error("Red-team must use an independent session and execution identity.");
	}
	assertArtifactRefs(redTeam.evidenceRefs, "Independent red-team evidence");
	assertArtifactRef(redTeam.resultRef, "Independent red-team result");
}

function assertPromotion(
	promotion: WorkflowLearningPromotion,
	candidate: WorkflowLearningCandidate,
	current: WorkflowLearningHostSnapshot,
	priorPromotions: readonly WorkflowLearningPromotion[],
	expected: WorkflowLearningCasExpectation,
	decision: WorkflowLearningDecision,
): void {
	assertHostSnapshot(current);
	if (decision.decisionRef === undefined) {
		throw new Error("Promotion requires a current durable decision reference.");
	}
	assertWorkflowDecisionRef(decision.decisionRef, candidate.workflowId, "Promotion decision", current);
	if (promotion.candidateId !== candidate.candidateId) {
		throw new Error("Host promotion is not bound to the reviewed candidate.");
	}
	assertNonEmpty(promotion.promotionId, "Promotion id");
	assertNonEmpty(promotion.revisionId, "Promotion revision id");
	assertNonEmpty(promotion.policyDigest, "Promotion policy digest");
	if (!Number.isSafeInteger(promotion.revision) || promotion.revision !== current.currentRevision + 1) {
		throw new Error("Host promotion revision must advance exactly one step from the current revision.");
	}
	if (
		priorPromotions.some(
			(prior) => prior.revisionId === promotion.revisionId || prior.promotionId === promotion.promotionId,
		)
	) {
		throw new Error("Host promotion identity was already recorded.");
	}
	if (priorPromotions.some((prior) => prior.revision >= promotion.revision)) {
		throw new Error("Host promotion revision is not monotonic with prior promotions.");
	}
	if (
		promotion.revisionRecord !== undefined &&
		(promotion.revisionRecord.revision !== promotion.revision ||
			promotion.revisionRecord.policyDigest !== promotion.policyDigest)
	) {
		throw new Error("Host promotion revision record does not match the promotion identity.");
	}
	assertReceipt(promotion.receipt, current, "Promotion receipt");
	assertCasOutput(promotion, expected, "Promotion");
}

function assertPromotionReconciliation(
	reconciliation: WorkflowLearningPromotionReconciliation,
	candidate: WorkflowLearningCandidate,
	current: WorkflowLearningHostSnapshot,
	priorPromotions: readonly WorkflowLearningPromotion[],
	expected: WorkflowLearningCasExpectation,
	decision: WorkflowLearningDecision,
	operationId: string,
): void {
	if (decision.decisionRef === undefined) {
		throw new Error("Promotion reconciliation requires a current durable decision reference.");
	}
	if (
		reconciliation.operationId !== operationId ||
		reconciliation.workflowId !== candidate.workflowId ||
		reconciliation.candidateId !== candidate.candidateId ||
		!sameDecisionRef(reconciliation.decisionRef, decision.decisionRef) ||
		digestObject(reconciliation.expected) !== digestObject(expected)
	) {
		throw new Error("Promotion reconciliation is not bound to the exact operation, decision, candidate, or CAS.");
	}
	assertPromotion(reconciliation.promotion, candidate, current, priorPromotions, expected, decision);
}

function rollbackRegistryCasDigest(
	candidate: WorkflowLearningCandidate,
	proposal: WorkflowLearningRollbackProposal,
	trigger: WorkflowLearningTrigger,
	decisionRef: WorkflowDecisionRef,
	expected: WorkflowLearningCasExpectation,
): string {
	return digestObject({
		kind: "workflow_learning_rollback_registry_cas",
		workflowId: candidate.workflowId,
		candidateId: candidate.candidateId,
		rollbackOf: proposal.rollbackOf,
		proposalId: proposal.proposalId,
		proposalDigest: proposal.proposalDigest,
		triggerIdentity: triggerIdentity(trigger),
		decisionRef,
		expected,
	});
}

function rollbackAppliedRegistryDigest(application: WorkflowLearningRollbackApplication): string {
	return digestObject({
		kind: "workflow_learning_rollback_registry_applied",
		registryCasDigest: application.registryCasDigest,
		proposalDigest: application.proposalDigest,
		revision: application.appliedRevision,
	});
}

function rollbackReloadedRegistryDigest(application: WorkflowLearningRollbackApplication): string {
	return digestObject({
		kind: "workflow_learning_rollback_registry_reloaded",
		appliedRegistryDigest: application.appliedRegistryDigest,
		revision: application.reloadedRevision,
	});
}

function rollbackFutureLoadDigest(application: WorkflowLearningRollbackApplication): string {
	return digestObject({
		kind: "workflow_learning_rollback_future_load",
		reloadedRegistryDigest: application.reloadedRegistryDigest,
		revision: application.futureLoadRevision,
	});
}

function assertRollbackApplicationIdentity(
	application: WorkflowLearningRollbackApplication,
	candidate: WorkflowLearningCandidate,
	proposal: WorkflowLearningRollbackProposal,
	trigger: WorkflowLearningTrigger,
	decisionRef: WorkflowDecisionRef,
	expected: WorkflowLearningCasExpectation,
	operationId: string,
): void {
	if (
		application.operationId !== operationId ||
		application.workflowId !== candidate.workflowId ||
		application.candidateId !== candidate.candidateId ||
		application.rollbackOf !== proposal.rollbackOf ||
		application.proposalId !== proposal.proposalId ||
		application.proposalDigest !== proposal.proposalDigest ||
		!sameArtifactRef(application.proposalRef, proposal.proposalRef) ||
		application.triggerIdentity !== triggerIdentity(trigger) ||
		!sameDecisionRef(application.decisionRef, decisionRef) ||
		digestObject(application.expected) !== digestObject(expected) ||
		application.stateHeadDigest !== expected.stateHeadDigest ||
		application.storeEpoch !== expected.storeEpoch ||
		application.coordinatorEpoch !== expected.coordinatorEpoch ||
		application.appliedRevision !== application.reloadedRevision ||
		application.reloadedRevision !== application.futureLoadRevision
	) {
		throw new Error("Rollback application is not bound to the exact proposal, decision, trigger, or CAS.");
	}
	assertArtifactRef(application.proposalRef, "Rollback application proposal artifact");
	if (application.proposalDigest !== application.proposalRef.digest) {
		throw new Error("Rollback application proposal digest does not match its exact artifact bytes.");
	}
	assertCanonicalDigest(application.registryCasDigest, "Rollback registry CAS digest");
	assertCanonicalDigest(application.appliedRegistryDigest, "Rollback applied registry digest");
	assertCanonicalDigest(application.reloadedRegistryDigest, "Rollback reloaded registry digest");
	assertCanonicalDigest(application.futureLoadDigest, "Rollback future-load digest");
	if (
		application.registryCasDigest !==
			rollbackRegistryCasDigest(candidate, proposal, trigger, decisionRef, expected) ||
		application.appliedRegistryDigest !== rollbackAppliedRegistryDigest(application) ||
		application.reloadedRegistryDigest !== rollbackReloadedRegistryDigest(application) ||
		application.futureLoadDigest !== rollbackFutureLoadDigest(application)
	) {
		throw new Error("Rollback application did not prove registry CAS, apply, reload, and future-load identity.");
	}
	assertBoundedString(application.casExecutionKey, "Rollback application CAS execution key", 256);
	if (
		!Number.isSafeInteger(application.appliedRevision) ||
		application.appliedRevision < 1 ||
		!Number.isSafeInteger(application.reloadedRevision) ||
		application.reloadedRevision < 1 ||
		!Number.isSafeInteger(application.futureLoadRevision) ||
		application.futureLoadRevision < 1
	) {
		throw new Error("Rollback application revision verification is invalid.");
	}
}

function assertRollbackApplication(
	application: WorkflowLearningRollbackApplication,
	candidate: WorkflowLearningCandidate,
	proposal: WorkflowLearningRollbackProposal,
	trigger: WorkflowLearningTrigger,
	decisionRef: WorkflowDecisionRef,
	current: WorkflowLearningHostSnapshot,
	expected: WorkflowLearningCasExpectation,
	operationId: string,
): void {
	assertHostSnapshot(current);
	assertRollbackApplicationIdentity(application, candidate, proposal, trigger, decisionRef, expected, operationId);
	assertReceipt(application.receipt, current, "Rollback application receipt");
}

function assertRollbackProposal(
	proposal: WorkflowLearningRollbackProposal,
	candidate: WorkflowLearningCandidate,
	promotedRevisionId: string,
	decisionRef: WorkflowDecisionRef,
	current: WorkflowLearningHostSnapshot,
	expected: WorkflowLearningCasExpectation,
): void {
	assertHostSnapshot(current);
	assertWorkflowDecisionRef(decisionRef, candidate.workflowId, "Rollback decision");
	if (proposal.candidateId !== candidate.candidateId) {
		throw new Error("Rollback proposal is not bound to the promoted candidate.");
	}
	if (proposal.rollbackOf !== promotedRevisionId) {
		throw new Error("Rollback proposal must identify the promoted revision it restores.");
	}
	assertNonEmpty(proposal.proposalId, "Rollback proposal id");
	assertNonEmpty(proposal.proposalDigest, "Rollback proposal digest");
	assertArtifactRef(proposal.proposalRef, "Rollback proposal artifact");
	if (proposal.proposalDigest !== proposal.proposalRef.digest) {
		throw new Error("Rollback proposal digest must match the exact proposal artifact bytes.");
	}
	assertReceipt(proposal.receipt, current, "Rollback receipt");
	if (
		proposal.stateHeadDigest !== expected.stateHeadDigest ||
		proposal.storeEpoch !== expected.storeEpoch ||
		proposal.coordinatorEpoch !== expected.coordinatorEpoch
	) {
		throw new Error("Rollback proposal CAS identity is stale.");
	}
	assertBoundedString(proposal.casExecutionKey, "Rollback CAS execution key", 256);
}

function withoutDigest(state: Omit<WorkflowLearningState, "stateDigest">): Omit<WorkflowLearningState, "stateDigest"> {
	const { stateDigest: _stateDigest, ...withoutStateDigest } = state as WorkflowLearningState;
	return structuredClone(withoutStateDigest);
}

function finalizeState(state: Omit<WorkflowLearningState, "stateDigest">): WorkflowLearningState {
	const normalized = withoutDigest(state);
	if (
		normalized.experiences.length > MAX_LEARNING_COLLECTION ||
		normalized.candidates.length > MAX_LEARNING_COLLECTION ||
		normalized.reviews.length > MAX_LEARNING_COLLECTION ||
		normalized.rollbackProposals.length > MAX_LEARNING_COLLECTION ||
		normalized.triggers.length > MAX_LEARNING_TRIGGERS ||
		normalized.consumedReceiptIds.length > MAX_LEARNING_COLLECTION ||
		(normalized.consumedWitnessIds?.length ?? 0) > MAX_LEARNING_COLLECTION
	) {
		throw new Error("Learning state collections are bounded.");
	}
	return { ...normalized, stateDigest: digestObject(normalized) };
}

function assertReplayedStateSemantics(state: WorkflowLearningState): void {
	if (
		state.experiences.length > MAX_LEARNING_COLLECTION ||
		state.candidates.length > MAX_LEARNING_COLLECTION ||
		state.reviews.length > MAX_LEARNING_COLLECTION ||
		state.rollbackProposals.length > MAX_LEARNING_COLLECTION ||
		state.triggers.length > MAX_LEARNING_TRIGGERS ||
		state.consumedReceiptIds.length > MAX_LEARNING_COLLECTION ||
		(state.consumedWitnessIds?.length ?? 0) > MAX_LEARNING_COLLECTION
	) {
		throw new Error("Learning state collections are bounded.");
	}
	for (const experience of state.experiences) {
		assertExperienceInput(experience);
		if (experience.source !== "host") throw new Error("Replayed experience source is not host-authenticated.");
		for (const evidence of experience.evidence) assertReplayedEvidenceEnvelope(evidence, experience.workflowId);
		assertBoundedString(experience.evidenceDigest, "Replayed experience evidence digest", 128);
		if (experience.evidenceWitnesses === undefined || experience.evidenceWitnesses.length > MAX_LEARNING_RECEIPTS) {
			throw new Error("Replayed experience evidence witnesses are required and bounded.");
		}
		const experienceRefs = [
			...experience.progressEvidenceRefs,
			...experience.evidence.flatMap((item) =>
				item.artifactObservations.map((observation) => observation.artifactRef),
			),
		];
		const uniqueExperienceRefs = [...new Map(experienceRefs.map((ref) => [digestObject(ref), ref])).values()];
		assertReplayedStageWitnesses(
			experience.evidenceWitnesses,
			uniqueExperienceRefs,
			experience.workflowId,
			null,
			"experience",
			experience.evidenceDigest,
		);
	}
	const candidateIds = new Set<string>();
	const experiencesById = new Map(state.experiences.map((experience) => [experience.experienceId, experience]));
	for (const record of state.candidates) {
		if (!LEARNING_MUTATION_CLASSES.has(record.candidate.mutationClass)) {
			throw new Error("Replayed candidate mutation class is outside the closed vocabulary.");
		}
		assertNonEmpty(record.candidate.candidateId, "Replayed candidate id");
		assertNonEmpty(record.candidate.experienceId, "Replayed candidate experience id");
		const experience = experiencesById.get(record.candidate.experienceId);
		if (experience === undefined || record.candidate.workflowId !== experience.workflowId) {
			throw new Error("Replayed candidate is not bound to its experience workflow.");
		}
		assertReplayedCandidate(record.candidate, experience);
		assertArtifactRef(record.candidate.candidateRef, "Replayed candidate artifact");
		if (candidateIds.has(record.candidate.candidateId)) throw new Error("Replayed candidate identity is duplicated.");
		candidateIds.add(record.candidate.candidateId);
	}
	const reviewIds = new Set<string>();
	const candidatesById = new Map(state.candidates.map((record) => [record.candidate.candidateId, record.candidate]));
	const promotionIds = new Set<string>();
	const promotionRevisions = new Set<number>();
	for (const review of state.reviews) {
		assertNonEmpty(review.reviewId, "Replayed review id");
		if (reviewIds.has(review.reviewId)) throw new Error("Replayed review identity is duplicated.");
		reviewIds.add(review.reviewId);
		const candidate = candidatesById.get(review.candidateId);
		if (candidate === undefined || !candidateIds.has(review.candidateId)) {
			throw new Error("Replayed review references an unknown candidate.");
		}
		if (!new Set(["rejected", "proposed", "promoted"]).has(review.status)) {
			throw new Error("Replayed review status is outside the closed vocabulary.");
		}
		if (!Array.isArray(review.reasons) || review.reasons.length > MAX_LEARNING_COLLECTION) {
			throw new Error("Replayed review reasons are bounded.");
		}
		for (const reason of review.reasons) assertBoundedString(reason, "Replayed review reason");
		assertReviewResult(candidate, review.shadow);
		if (review.shadow.metrics !== undefined) assertStageMetrics(review.shadow.metrics, "Replayed shadow");
		const { evidenceWitnesses: _shadowWitnesses, ...shadowPayload } = review.shadow;
		const shadowPayloadDigest = digestPayload(shadowPayload);
		const shadowRefs = [
			...new Map(
				[...review.shadow.evidenceRefs, candidate.hiddenHoldoutManifestRef].map((ref) => [digestObject(ref), ref]),
			).values(),
		];
		const shadowWitnesses = review.shadow.evidenceWitnesses;
		assertReplayedStageWitnesses(
			shadowWitnesses?.filter((witness) => witness.stage === "shadow"),
			shadowRefs,
			candidate.workflowId,
			candidate.candidateId,
			"shadow",
			shadowPayloadDigest,
		);
		const holdoutIdentityWitnesses = shadowWitnesses?.filter((witness) => witness.stage === "holdout_identity");
		assertReplayedStageWitnesses(
			holdoutIdentityWitnesses,
			[candidate.hiddenHoldoutManifestRef],
			candidate.workflowId,
			candidate.candidateId,
			"holdout_identity",
			candidate.caseManifest.heldOutInputDigest as string,
		);
		const holdoutResultWitnesses = shadowWitnesses?.filter((witness) => witness.stage === "holdout_result_identity");
		assertReplayedStageWitnesses(
			holdoutResultWitnesses,
			[candidate.hiddenHoldoutManifestRef],
			candidate.workflowId,
			candidate.candidateId,
			"holdout_result_identity",
			review.shadow.heldOutInputDigest,
		);
		for (const receipt of review.shadow.receipts)
			assertReplayedReceipt(receipt, candidate.workflowId, "Replayed shadow receipt");
		if (review.canary !== null) {
			assertCanaryResult(candidate, review.canary);
			if (review.canary.metrics !== undefined) assertStageMetrics(review.canary.metrics, "Replayed canary");
			const { evidenceWitnesses: _canaryWitnesses, ...canaryPayload } = review.canary;
			assertReplayedStageWitnesses(
				review.canary.evidenceWitnesses,
				review.canary.evidenceRefs,
				candidate.workflowId,
				candidate.candidateId,
				"canary",
				digestPayload(canaryPayload),
			);
			for (const receipt of review.canary.receipts)
				assertReplayedReceipt(receipt, candidate.workflowId, "Replayed canary receipt");
		} else if (review.redTeam !== null) {
			throw new Error("Replayed red-team result lacks its canary result.");
		}
		if (review.redTeam !== null) {
			if (review.canary === null) throw new Error("Replayed red-team result lacks its canary result.");
			assertRedTeamResult(candidate, review.canary, review.redTeam);
			if (review.redTeam.metrics !== undefined) assertStageMetrics(review.redTeam.metrics, "Replayed red-team");
			const { evidenceWitnesses: _redTeamWitnesses, ...redTeamPayload } = review.redTeam;
			assertReplayedStageWitnesses(
				review.redTeam.evidenceWitnesses,
				review.redTeam.evidenceRefs,
				candidate.workflowId,
				candidate.candidateId,
				"red_team",
				digestPayload(redTeamPayload),
			);
			for (const receipt of review.redTeam.receipts)
				assertReplayedReceipt(receipt, candidate.workflowId, "Replayed red-team receipt");
		}
		if (review.decisionRef !== null)
			assertWorkflowDecisionRef(review.decisionRef, candidate.workflowId, "Replayed review decision");
		if (review.decision !== null) {
			assertOpaque(review.decision);
			assertWorkflowDecision(review.decision.decision, candidate.workflowId);
			if (
				review.decisionRef !== null &&
				review.decision.decisionRef !== undefined &&
				!sameDecisionRef(review.decisionRef, review.decision.decisionRef)
			)
				throw new Error("Replayed review decision identity changed.");
		} else if (review.status === "promoted") {
			throw new Error("Replayed promoted review lacks its complete host decision.");
		}
		if (review.decisionWitness !== null) {
			assertReplayedWitness(
				review.decisionWitness,
				candidate.workflowId,
				"decision",
				candidate.candidateId,
				review.decisionWitness.payloadDigest,
				review.decisionWitness.evidenceRef,
				"decision",
				true,
			);
		} else if (review.canary !== null || review.redTeam !== null || review.status === "promoted") {
			throw new Error("Replayed reviewed candidate lacks its decision witness.");
		}
		if (review.status === "promoted") {
			if (
				review.decision === null ||
				review.decisionRef === null ||
				review.decision.decisionRef === undefined ||
				!sameDecisionRef(review.decisionRef, review.decision.decisionRef)
			) {
				throw new Error("Replayed promoted review lacks its current durable decision reference.");
			}
			if (
				!stageMetricsSatisfyCandidate(review.shadow.metrics, candidate, review.shadow.evidenceRefs) ||
				review.shadow.sameCaseInputDigest !== candidate.caseManifest.inputDigest ||
				review.shadow.heldOutInputDigest !== candidate.caseManifest.heldOutInputDigest ||
				review.shadow.heldOutSampleCount < candidate.caseManifest.requiredSampleSize ||
				review.shadow.overfittingDetected ||
				!review.shadow.heldOutPassed ||
				!review.shadow.nonRegressionPassed ||
				!review.shadow.safetyPassed ||
				review.canary === null ||
				review.redTeam === null ||
				!stageMetricsSatisfyCandidate(review.canary.metrics, candidate, review.canary.evidenceRefs) ||
				!review.canary.passed ||
				!stageMetricsSatisfyCandidate(review.redTeam.metrics, candidate, review.redTeam.evidenceRefs) ||
				!review.redTeam.passed
			) {
				throw new Error("Replayed promoted review is not bound to passing host stage evidence.");
			}
		}
		if ((review.status === "promoted") !== (review.promotion !== null)) {
			throw new Error("Replayed review status is not bound to its promotion identity.");
		}
		if (review.promotion !== null) {
			if (
				review.promotion.candidateId !== review.candidateId ||
				promotionIds.has(review.promotion.promotionId) ||
				promotionRevisions.has(review.promotion.revision)
			) {
				throw new Error("Replayed promotion identity is duplicated or misbound.");
			}
			assertReplayedReceipt(review.promotion.receipt, candidate.workflowId, "Replayed promotion receipt");
			assertNonEmpty(review.promotion.promotionId, "Replayed promotion id");
			assertNonEmpty(review.promotion.revisionId, "Replayed promotion revision id");
			assertNonEmpty(review.promotion.policyDigest, "Replayed promotion policy digest");
			if (
				!Number.isSafeInteger(review.promotion.revision) ||
				review.promotion.revision <= candidate.baselineRevision
			) {
				throw new Error("Replayed promotion revision is not monotonic.");
			}
			assertBoundedString(review.promotion.stateHeadDigest, "Replayed promotion state head", 128);
			assertBoundedString(review.promotion.casExecutionKey, "Replayed promotion CAS key", 256);
			promotionIds.add(review.promotion.promotionId);
			promotionRevisions.add(review.promotion.revision);
		}
	}
	for (const proposal of state.rollbackProposals) {
		assertNonEmpty(proposal.proposalId, "Replayed rollback id");
		const candidate = candidatesById.get(proposal.candidateId);
		if (candidate === undefined) throw new Error("Replayed rollback references an unknown candidate.");
		assertNonEmpty(proposal.candidateId, "Replayed rollback candidate id");
		assertNonEmpty(proposal.rollbackOf, "Replayed rollback revision id");
		assertArtifactRef(proposal.proposalRef, "Replayed rollback artifact");
		assertNonEmpty(proposal.proposalDigest, "Replayed rollback digest");
		if (proposal.proposalDigest !== proposal.proposalRef.digest)
			throw new Error("Replayed rollback proposal is not bound to its exact artifact bytes.");
		assertReplayedReceipt(proposal.receipt, candidate.workflowId, "Replayed rollback receipt");
		assertBoundedString(proposal.stateHeadDigest, "Replayed rollback state head", 128);
		const storeEpoch = proposal.storeEpoch;
		const coordinatorEpoch = proposal.coordinatorEpoch;
		if (
			typeof storeEpoch !== "number" ||
			!Number.isSafeInteger(storeEpoch) ||
			storeEpoch < 1 ||
			typeof coordinatorEpoch !== "number" ||
			!Number.isSafeInteger(coordinatorEpoch) ||
			coordinatorEpoch < 1
		) {
			throw new Error("Replayed rollback epoch is invalid.");
		}
		assertBoundedString(proposal.casExecutionKey, "Replayed rollback CAS key", 256);
		if (!state.reviews.some((review) => review.promotion?.revisionId === proposal.rollbackOf)) {
			throw new Error("Replayed rollback is not bound to a promoted revision.");
		}
		const promotedReview = [...state.reviews]
			.reverse()
			.find((review) => review.promotion?.revisionId === proposal.rollbackOf);
		if (promotedReview?.decisionRef === null || promotedReview === undefined) {
			throw new Error("Replayed rollback is missing its promotion decision reference.");
		}
		if (proposal.application === undefined) {
			throw new Error("Replayed rollback has no durable CAS/apply/reload/future-load effect.");
		}
		const rollbackTrigger = state.triggers.find(
			(trigger) =>
				trigger.candidateId === proposal.candidateId &&
				triggerIdentity(trigger) === proposal.application?.triggerIdentity,
		);
		if (rollbackTrigger === undefined) {
			throw new Error("Replayed rollback has no bound regression trigger.");
		}
		assertRollbackApplicationIdentity(
			proposal.application,
			candidate,
			proposal,
			rollbackTrigger,
			promotedReview.decisionRef,
			proposal.application.expected,
			proposal.application.operationId,
		);
		assertReplayedReceipt(
			proposal.application.receipt,
			candidate.workflowId,
			"Replayed rollback application receipt",
		);
	}
	for (const trigger of state.triggers) assertTriggerShape(trigger);
	for (const trigger of state.triggers) {
		if (trigger.evidenceWitnesses === undefined) throw new Error("Replayed trigger evidence witnesses are required.");
		assertReplayedStageWitnesses(
			trigger.evidenceWitnesses,
			trigger.evidenceRefs,
			trigger.workflowId ?? "",
			trigger.candidateId,
			"trigger",
			trigger.evidenceDigest ?? "",
		);
		for (const witness of trigger.evidenceWitnesses) {
			if (
				witness.storeEpoch !== trigger.storeEpoch ||
				witness.coordinatorEpoch !== trigger.coordinatorEpoch ||
				witness.stateHeadDigest !== trigger.stateHeadDigest
			) {
				throw new Error("Replayed trigger witness is stale for its trigger epoch.");
			}
		}
	}
}

function initialState(state: WorkflowLearningState | undefined): WorkflowLearningState {
	if (state === undefined) {
		return finalizeState({
			schemaVersion: 1,
			experiences: [],
			candidates: [],
			reviews: [],
			rollbackProposals: [],
			triggers: [],
			consumedReceiptIds: [],
			consumedWitnessIds: [],
		});
	}
	if (state.schemaVersion !== 1) throw new Error("Unsupported learning controller state schema.");
	const suppliedDigest = state.stateDigest;
	const expectedDigest = digestObject(withoutDigest(state));
	if (suppliedDigest !== expectedDigest) throw new Error("Learning state digest does not match the replayed bytes.");
	if (state.triggers.length > MAX_LEARNING_TRIGGERS) throw new Error("Learning trigger history is bounded.");
	const triggerIdentities = state.triggers.map((trigger) => triggerIdentity(trigger));
	if (new Set(triggerIdentities).size !== triggerIdentities.length) {
		throw new Error("Learning trigger history contains duplicate identities.");
	}
	if (new Set(state.consumedReceiptIds).size !== state.consumedReceiptIds.length) {
		throw new Error("Learning receipt history contains duplicate identities.");
	}
	for (const receiptId of state.consumedReceiptIds) assertBoundedString(receiptId, "Learning receipt history id");
	const consumedWitnessIds = state.consumedWitnessIds ?? [];
	if (new Set(consumedWitnessIds).size !== consumedWitnessIds.length) {
		throw new Error("Learning witness history contains duplicate identities.");
	}
	for (const witnessId of consumedWitnessIds) assertBoundedString(witnessId, "Learning witness history id");
	for (const experience of state.experiences) assertOpaque(experience);
	for (const record of state.candidates) assertOpaque(record);
	for (const review of state.reviews) assertOpaque(review);
	for (const proposal of state.rollbackProposals) assertOpaque(proposal);
	for (const trigger of state.triggers) assertOpaque(trigger);
	assertReplayedStateSemantics(state);
	return finalizeState({
		schemaVersion: 1,
		experiences: state.experiences,
		candidates: state.candidates,
		reviews: state.reviews,
		rollbackProposals: state.rollbackProposals,
		triggers: state.triggers,
		consumedReceiptIds: state.consumedReceiptIds,
		consumedWitnessIds,
	});
}

function receiptBinding(kind: string, payload: unknown, receipt: WorkflowVerifiedHostReceipt): string {
	return digestObject({
		kind,
		payloadDigest: digestReceiptBindingPayload(payload),
		receiptId: receipt.receiptId,
		receiptPayloadDigest: receipt.payloadDigest,
	});
}

function triggerIdentity(trigger: WorkflowLearningTrigger): string {
	return digestObject({
		kind: trigger.kind,
		candidateId: trigger.candidateId,
		sourceEventRef: trigger.sourceEventRef,
		workflowId: trigger.workflowId,
		storeEpoch: trigger.storeEpoch,
		coordinatorEpoch: trigger.coordinatorEpoch,
		stateHeadDigest: trigger.stateHeadDigest,
		evidenceDigest: trigger.evidenceDigest,
		evidenceRefs: trigger.evidenceRefs,
		hostReceipt: trigger.hostReceipt,
	});
}

function reviewResult(record: WorkflowLearningReviewRecord): WorkflowLearningReviewResult {
	return immutableClone(record);
}

function candidateStatus(
	state: WorkflowLearningState,
	candidateId: string,
	status: WorkflowLearningCandidateStatus,
): WorkflowLearningState {
	return finalizeState({
		...state,
		candidates: state.candidates.map((record) =>
			record.candidate.candidateId === candidateId ? { ...record, status } : record,
		),
	});
}

function findCandidate(state: WorkflowLearningState, candidateId: string): WorkflowLearningCandidateRecord {
	const record = state.candidates.find((item) => item.candidate.candidateId === candidateId);
	if (record === undefined) throw new Error(`Learning candidate ${candidateId} was not found.`);
	return record;
}

function appendReview(
	state: WorkflowLearningState,
	review: WorkflowLearningReviewRecord,
	status: WorkflowLearningCandidateStatus,
): WorkflowLearningState {
	return candidateStatus(finalizeState({ ...state, reviews: [...state.reviews, review] }), review.candidateId, status);
}

async function emitEvent(sink: WorkflowLearningEventSink | undefined, event: WorkflowLearningEvent): Promise<void> {
	if (sink !== undefined) await sink.append(structuredClone(event));
}

/**
 * Create the host-owned learning lifecycle over existing evidence, decision, and revision ports.
 *
 * Args:
 * options: Injected host ports and an optional replayed lifecycle projection.
 * Return: Controller for committing experience, reviewing candidates, and proposing fenced changes.
 */
function createWorkflowLearningControllerInternal(options: {
	ports: WorkflowLearningPorts;
	state?: WorkflowLearningState;
}): WorkflowLearningController {
	let state = initialState(options.state);
	const reviewInFlight = new Map<string, Promise<WorkflowLearningReviewResult>>();
	const triggerInFlight = new Map<string, Promise<WorkflowLearningTriggerResult>>();

	const verifyCanonicalReceipt = async (
		receipt: WorkflowVerifiedHostReceipt,
		bindingDigest: string,
		current: WorkflowLearningHostSnapshot,
		label: string,
	): Promise<void> => {
		assertReceipt(receipt, current, label);
		await resolveAndVerifyWorkflowHostReceipt({
			context: current.receiptContext,
			workflowId: current.workflowId,
			expectedBindingDigest: bindingDigest,
			receipt,
			currentStateDigest: current.stateDigest,
			currentRevision: current.currentRevision,
			trustedNow: current.trustedNow,
		});
	};

	const verifyTrustedClock = async (current: WorkflowLearningHostSnapshot): Promise<void> => {
		await verifyCanonicalReceipt(
			current.trustedClockReceipt,
			current.trustedClockReceipt.bindingDigest,
			current,
			"Learning trusted clock receipt",
		);
	};

	const verifyCanonicalArtifact = async (
		artifactRef: WorkflowArtifactRef,
		current: WorkflowLearningHostSnapshot,
		label: string,
	): Promise<void> => {
		assertArtifactRef(artifactRef, label);
		const artifact = await current.artifactResolver.resolve(artifactRef);
		if (
			!artifact.exists ||
			!artifact.envelope.immutable ||
			digestObject(artifact.envelope.ref) !== digestObject(artifactRef) ||
			artifact.verifiedDigest !== artifactRef.digest ||
			artifact.verifiedSizeBytes !== artifactRef.sizeBytes ||
			artifact.bytes.byteLength !== artifactRef.sizeBytes ||
			sha256Hex(artifact.bytes) !== artifactRef.digest
		) {
			throw new Error(`${label} is not resolver-verified and content-addressed.`);
		}
	};

	const verifyTypedStageResultArtifact = async (
		stage: LearningStageArtifactStage,
		result: LearningStageResult,
		candidate: WorkflowLearningCandidate,
		current: WorkflowLearningHostSnapshot,
	): Promise<void> => {
		await verifyCanonicalArtifact(result.resultRef, current, `${stage} result artifact`);
		const resolved = await current.artifactResolver.resolve(result.resultRef);
		const parsed = parseCanonicalJsonBytes(new Uint8Array(resolved.bytes));
		assertTypedStageResultArtifact(parsed, stage, result, candidate);
	};

	const consumeReceipts = async (
		receipts: readonly WorkflowVerifiedHostReceipt[],
		kind: string,
		payload: unknown,
		current: WorkflowLearningHostSnapshot,
		candidateId: string | null = null,
	): Promise<readonly WorkflowLearningHostWitness[]> => {
		assertHostSnapshot(current);
		if (receipts.length === 0 || receipts.length > MAX_LEARNING_RECEIPTS) {
			throw new Error("Learning receipt history is bounded and non-empty.");
		}
		const ids = receipts.map((receipt) => receipt.receiptId);
		if (ids.some((id) => id.trim().length === 0) || new Set(ids).size !== ids.length) {
			throw new Error("Learning receipt set contains a duplicate or empty receipt.");
		}
		for (const receipt of receipts) {
			assertReceipt(receipt, current, "Learning receipt");
			if (state.consumedReceiptIds.includes(receipt.receiptId)) {
				throw new Error("Learning receipt replay was rejected.");
			}
		}
		const witnesses: WorkflowLearningHostWitness[] = [];
		for (const receipt of receipts) {
			const bindingDigest = receiptBinding(kind, payload, receipt);
			await verifyCanonicalReceipt(receipt, bindingDigest, current, "Learning receipt");
			let consumptionWitness: Awaited<
				ReturnType<WorkflowHostReceiptConsumerContext["receiptResolver"]["resolveConsumptionWitness"]>
			>;
			try {
				consumptionWitness = await current.receiptContext.receiptResolver.resolveConsumptionWitness({
					receiptId: receipt.receiptId,
					workflowId: current.workflowId,
					expectedBindingDigest: bindingDigest,
				});
			} catch (_error: unknown) {
				await current.receiptContext.receiptResolver.consumeIfOneUse({
					receipt,
					workflowId: current.workflowId,
					expectedBindingDigest: bindingDigest,
					currentRevision: current.currentRevision,
				});
				consumptionWitness = await current.receiptContext.receiptResolver.resolveConsumptionWitness({
					receiptId: receipt.receiptId,
					workflowId: current.workflowId,
					expectedBindingDigest: bindingDigest,
				});
			}
			if (
				consumptionWitness.receiptId !== receipt.receiptId ||
				consumptionWitness.workflowId !== current.workflowId ||
				consumptionWitness.bindingDigest !== bindingDigest
			) {
				throw new Error("Learning receipt durable consumption witness is not bound to the exact receipt.");
			}
			const verifiedWitness = await options.ports.receiptPort.verify({
				receipt,
				bindingDigest,
				stage: kind,
				candidateId,
				current,
			});
			if (verifiedWitness === undefined) throw new Error("Learning receipt resolver witness is required.");
			assertWitness(verifiedWitness, current, kind, candidateId, bindingDigest, receipt.artifactRef, "receipt");
			if (!receipt.oneUse || !verifiedWitness.oneUse)
				throw new Error("Learning stage receipts must be one-use authenticated witnesses.");
			const consumedWitness = await options.ports.receiptPort.consume({
				receipt,
				bindingDigest,
				stage: kind,
				candidateId,
				current,
			});
			if (consumedWitness === undefined) throw new Error("Learning receipt consumption witness is required.");
			assertWitness(consumedWitness, current, kind, candidateId, bindingDigest, receipt.artifactRef, "receipt");
			if (consumedWitness.witnessId !== verifiedWitness.witnessId) {
				throw new Error("Learning receipt verification and consumption witnesses differ.");
			}
			witnesses.push(structuredClone(consumedWitness));
			state = finalizeState({
				...state,
				consumedReceiptIds: [...state.consumedReceiptIds, receipt.receiptId],
				consumedWitnessIds: [...(state.consumedWitnessIds ?? []), consumedWitness.witnessId],
			});
		}
		return Object.freeze(witnesses.map((witness) => freezeProjection(witness)));
	};

	const resolveEvidence = async (input: {
		stage: string;
		candidateId: string | null;
		evidenceRefs: readonly WorkflowArtifactRef[];
		payloadDigest: string;
		current: WorkflowLearningHostSnapshot;
		witnessKind?: WorkflowLearningWitnessKind;
	}): Promise<readonly WorkflowLearningHostWitness[]> => {
		assertHostSnapshot(input.current);
		assertArtifactRefs(input.evidenceRefs, `${input.stage} evidence`, MAX_LEARNING_RECEIPTS);
		assertBoundedString(input.payloadDigest, `${input.stage} payload digest`, 128);
		const resolver = options.ports.host.resolveEvidence;
		if (resolver === undefined) throw new Error(`${input.stage} host evidence resolver is required.`);
		for (const evidenceRef of input.evidenceRefs) {
			await verifyCanonicalArtifact(evidenceRef, input.current, `${input.stage} evidence artifact`);
		}
		const witnesses = await resolver({
			stage: input.stage,
			workflowId: input.current.workflowId,
			candidateId: input.candidateId,
			evidenceRefs: structuredClone(input.evidenceRefs),
			payloadDigest: input.payloadDigest,
			current: input.current,
			witnessKind: input.witnessKind,
		});
		assertWitnessSet(
			witnesses,
			input.evidenceRefs,
			input.current,
			input.stage,
			input.candidateId,
			input.payloadDigest,
			input.witnessKind ?? "evidence",
		);
		return Object.freeze(witnesses.map((witness) => freezeProjection(structuredClone(witness))));
	};

	const verifyReceipt = async (
		receipt: WorkflowVerifiedHostReceipt,
		kind: string,
		payload: unknown,
		current: WorkflowLearningHostSnapshot,
		candidateId: string | null,
	): Promise<void> => {
		assertReceipt(receipt, current, `${kind} receipt`);
		const bindingDigest = receiptBinding(kind, payload, receipt);
		await verifyCanonicalReceipt(receipt, bindingDigest, current, `${kind} receipt`);
		const witness = await options.ports.receiptPort.verify({
			receipt,
			bindingDigest,
			stage: kind,
			candidateId,
			current,
		});
		if (witness === undefined) throw new Error(`${kind} receipt resolver witness is required.`);
		assertWitness(witness, current, kind, candidateId, bindingDigest, receipt.artifactRef, "receipt");
		if (!receipt.oneUse || !witness.oneUse)
			throw new Error(`${kind} receipt must be a one-use authenticated witness.`);
	};

	const commitExperience = async (input: WorkflowLearningExperienceInput): Promise<WorkflowLearningExperience> => {
		const frozenInput = immutableClone(input);
		assertExperienceInput(frozenInput);
		if (state.experiences.some((experience) => experience.experienceId === frozenInput.experienceId)) {
			throw new Error("Committed experience identity was already recorded.");
		}
		const current = copyHostSnapshot(await options.ports.host.current());
		assertHostSnapshot(current);
		await verifyTrustedClock(current);
		if (current.workflowId !== frozenInput.workflowId)
			throw new Error("Experience is not bound to the current workflow.");
		await verifyCanonicalArtifact(frozenInput.sourceEventRef, current, "Experience source event artifact");
		assertReceipt(frozenInput.hostReceipt, current, "Experience host receipt");
		const validatedEvidenceDigests: string[] = [];
		for (const evidence of frozenInput.evidence) {
			const validationInput: WorkflowEvidenceValidationInput = {
				workflowId: frozenInput.workflowId,
				evidence,
				trustedClockReceipt: current.trustedClockReceipt,
				currentWorkspaceDigest: current.workspaceDigest,
				currentConfigDigest: current.configDigest,
				currentParserDigest: current.parserDigest,
				currentEvaluatorDigest: current.evaluatorDigest,
				currentGuardDigest: current.guardDigest,
				currentRevisions: current.revisions,
				requiredFreshnessMilliseconds: current.requiredFreshnessMilliseconds,
				artifactResolver: current.artifactResolver,
				receiptContext: current.receiptContext,
				currentStateDigest: current.stateDigest,
				currentRevision: current.currentRevision,
			};
			const validation = await options.ports.evidenceValidator.validate(validationInput);
			if (!validation.accepted) throw new Error(`Committed experience evidence was rejected: ${validation.code}.`);
			validatedEvidenceDigests.push(validation.evidenceDigest);
		}
		const experienceRefs = [
			...frozenInput.progressEvidenceRefs,
			...frozenInput.evidence.flatMap((item) =>
				item.artifactObservations.map((observation) => observation.artifactRef),
			),
		];
		const uniqueExperienceRefs = [...new Map(experienceRefs.map((ref) => [digestObject(ref), ref])).values()];
		const evidenceWitnesses = await resolveEvidence({
			stage: "experience",
			candidateId: null,
			evidenceRefs: uniqueExperienceRefs,
			payloadDigest: digestPayload(frozenInput.evidence),
			current,
		});
		await consumeReceipts(
			[frozenInput.hostReceipt],
			"committed_experience",
			{
				experienceId: frozenInput.experienceId,
				workflowId: frozenInput.workflowId,
				outcome: frozenInput.outcome,
				progressKind: frozenInput.progressKind,
				progressEvidenceRefs: frozenInput.progressEvidenceRefs,
				evidenceDigest: digestPayload(frozenInput.evidence),
				sourceEventRef: frozenInput.sourceEventRef,
			},
			current,
		);
		const experience: WorkflowLearningExperience = {
			...structuredClone(frozenInput),
			source: "host",
			validatedEvidenceDigests,
			evidenceDigest: digestPayload(frozenInput.evidence),
			evidenceWitnesses,
		};
		state = finalizeState({ ...state, experiences: [...state.experiences, experience] });
		return immutableClone(experience);
	};

	const typeCandidate = async (input: {
		experienceId: string;
		trigger: WorkflowLearningTrigger;
	}): Promise<WorkflowLearningCandidate> => {
		const frozenInput = immutableClone(input);
		const experience = state.experiences.find((item) => item.experienceId === frozenInput.experienceId);
		if (experience === undefined) throw new Error(`Committed experience ${input.experienceId} was not found.`);
		if (experience.outcome === "rejected") {
			throw new Error("Rejected experience cannot create a learning candidate.");
		}
		const current = copyHostSnapshot(await options.ports.host.current());
		assertTrigger(frozenInput.trigger, current);
		await verifyTrustedClock(current);
		await verifyCanonicalArtifact(
			frozenInput.trigger.sourceEventRef,
			current,
			"Candidate trigger source event artifact",
		);
		const triggerEvidenceWitnesses = await resolveEvidence({
			stage: "trigger",
			candidateId: frozenInput.trigger.candidateId,
			evidenceRefs: frozenInput.trigger.evidenceRefs,
			payloadDigest: frozenInput.trigger.evidenceDigest ?? "",
			current,
		});
		await consumeReceipts(
			[frozenInput.trigger.hostReceipt as WorkflowVerifiedHostReceipt],
			"trigger",
			frozenInput.trigger,
			current,
			frozenInput.trigger.candidateId,
		);
		const recordedTrigger = cleanPayload({ ...frozenInput.trigger, evidenceWitnesses: triggerEvidenceWitnesses });
		const candidate = await options.ports.host.createCandidate({
			experience: structuredClone(experience),
			trigger: structuredClone(recordedTrigger),
			current: hostProjection(current),
		});
		assertCandidate(candidate, experience, current);
		for (const [label, artifactRef] of [
			["proposal", candidate.proposalRef],
			["candidate", candidate.candidateRef],
			["baseline", candidate.baselineArtifactRef],
			["scorecard", candidate.scorecardRef],
			["evaluator", candidate.evaluatorRef],
			["parser", candidate.parserRef],
			["held-out manifest", candidate.hiddenHoldoutManifestRef],
		] as const) {
			await verifyCanonicalArtifact(artifactRef, current, `Candidate ${label} artifact`);
		}
		const holdoutManifest = await current.artifactResolver.resolve(candidate.hiddenHoldoutManifestRef);
		assertHoldoutManifestArtifact(parseCanonicalJsonBytes(new Uint8Array(holdoutManifest.bytes)), candidate);
		for (const [index, artifactRef] of candidate.caseManifest.sourceArtifactRefs.entries()) {
			await verifyCanonicalArtifact(artifactRef, current, `Candidate case artifact ${index}`);
		}
		for (const [index, artifactRef] of candidate.caseManifest.nonRegressionPredicateRefs.entries()) {
			await verifyCanonicalArtifact(artifactRef, current, `Candidate predicate artifact ${index}`);
		}
		const classifier = options.ports.host.classifyCandidate;
		if (classifier === undefined) throw new Error("Host candidate classifier is required.");
		const classification = await classifier({
			candidate: structuredClone(candidate),
			current: hostProjection(current),
		});
		assertCandidateClassification(candidate, classification);
		if (state.candidates.some((record) => record.candidate.candidateId === candidate.candidateId)) {
			throw new Error("Typed candidate identity was already recorded.");
		}
		if (state.triggers.length >= MAX_LEARNING_TRIGGERS) throw new Error("Learning trigger history is bounded.");
		await consumeReceipts(
			[candidate.hostReceipt],
			"typed_candidate",
			{ candidate, trigger: recordedTrigger },
			current,
			candidate.candidateId,
		);
		state = finalizeState({
			...state,
			candidates: [...state.candidates, { candidate: structuredClone(candidate), status: "typed" }],
			triggers: [...state.triggers, recordedTrigger],
		});
		await emitEvent(options.ports.eventSink, {
			kind: "improvement_proposed",
			candidateId: candidate.candidateId,
			proposalRef: candidate.proposalRef,
			reviewRef: null,
			resultRef: null,
		});
		return immutableClone(candidate);
	};

	const reviewCandidateInternal = async (
		candidateId: string,
		operationId: string | undefined,
	): Promise<WorkflowLearningReviewResult> => {
		const record = findCandidate(state, candidateId);
		if (record.status !== "typed") throw new Error("Learning candidate is no longer reviewable.");
		const candidate = record.candidate;
		if (candidate.caseManifest.kind !== "held_out") throw new Error("Candidate holdout manifest is required.");
		const heldOutInputDigest = candidate.caseManifest.heldOutInputDigest;
		const current = copyHostSnapshot(await options.ports.host.current());
		assertHostSnapshot(current);
		await verifyTrustedClock(current);
		const shadowResult = await options.ports.host.runShadow({
			candidate: structuredClone(candidate),
			current: hostProjection(current),
		});
		assertReviewResult(candidate, shadowResult);
		await verifyTypedStageResultArtifact("shadow", shadowResult, candidate, current);
		const shadowPayloadDigest = digestPayload(shadowResult);
		const shadowEvidenceRefs = [...shadowResult.evidenceRefs, candidate.hiddenHoldoutManifestRef];
		const uniqueShadowEvidenceRefs = [...new Map(shadowEvidenceRefs.map((ref) => [digestObject(ref), ref])).values()];
		const shadowEvidenceWitnesses = await resolveEvidence({
			stage: "shadow",
			candidateId: candidate.candidateId,
			evidenceRefs: uniqueShadowEvidenceRefs,
			payloadDigest: shadowPayloadDigest,
			current,
		});
		const holdoutIdentityWitnesses = await resolveEvidence({
			stage: "holdout_identity",
			candidateId: candidate.candidateId,
			evidenceRefs: [candidate.hiddenHoldoutManifestRef],
			payloadDigest: heldOutInputDigest,
			current,
		});
		const holdoutResultWitnesses = await resolveEvidence({
			stage: "holdout_result_identity",
			candidateId: candidate.candidateId,
			evidenceRefs: [candidate.hiddenHoldoutManifestRef],
			payloadDigest: shadowResult.heldOutInputDigest,
			current,
		});
		const shadow = cleanPayload({
			...shadowResult,
			evidenceWitnesses: [...shadowEvidenceWitnesses, ...holdoutIdentityWitnesses, ...holdoutResultWitnesses],
		});
		assertReceiptSet(shadow.receipts, current, "Shadow review receipts");
		await consumeReceipts(
			shadow.receipts,
			"shadow_review",
			{ candidate, shadow: shadowResult },
			current,
			candidate.candidateId,
		);
		const reasons: string[] = [];
		if (!stageMetricsSatisfyCandidate(shadow.metrics, candidate, shadow.evidenceRefs)) {
			reasons.push("metrics_required");
		}
		if (shadow.sameCaseInputDigest !== candidate.caseManifest.inputDigest) reasons.push("same_case_mismatch");
		if (shadow.sameCaseInputDigest === shadow.heldOutInputDigest) reasons.push("held_out_mismatch");
		if (shadow.heldOutInputDigest !== candidate.caseManifest.heldOutInputDigest) reasons.push("held_out_mismatch");
		if (shadow.heldOutSampleCount < candidate.caseManifest.requiredSampleSize)
			reasons.push("held_out_sample_missing");
		if (shadow.overfittingDetected) reasons.push("overfitting_detected");
		if (!shadow.heldOutPassed) reasons.push("held_out_failed");
		if (!shadow.nonRegressionPassed) reasons.push("non_regression_failed");
		if (!shadow.safetyPassed) reasons.push("safety_failed");

		let canary: WorkflowLearningCanaryResult | null = null;
		let redTeam: WorkflowLearningRedTeamResult | null = null;
		let promotion: WorkflowLearningPromotion | null = null;
		let decision: WorkflowLearningDecision | null = null;
		let decisionRef: WorkflowDecisionRef | null = null;
		let decisionWitness: WorkflowLearningHostWitness | null = null;
		if (reasons.length === 0) {
			const canaryResult = await options.ports.host.runCanary({
				candidate: structuredClone(candidate),
				shadow: structuredClone(shadow),
				current: hostProjection(current),
			});
			assertCanaryResult(candidate, canaryResult);
			await verifyTypedStageResultArtifact("canary", canaryResult, candidate, current);
			const canaryEvidenceWitnesses = await resolveEvidence({
				stage: "canary",
				candidateId: candidate.candidateId,
				evidenceRefs: canaryResult.evidenceRefs,
				payloadDigest: digestPayload(canaryResult),
				current,
			});
			canary = cleanPayload({ ...canaryResult, evidenceWitnesses: canaryEvidenceWitnesses });
			assertReceiptSet(canary.receipts, current, "Canary review receipts");
			await consumeReceipts(
				[...canary.receipts],
				"canary_review",
				{ candidate, shadow, canary: canaryResult },
				current,
				candidate.candidateId,
			);
			if (!stageMetricsSatisfyCandidate(canary.metrics, candidate, canary.evidenceRefs)) {
				reasons.push("metrics_required");
			}
			if (!canary.passed) reasons.push("canary_failed");
		}
		if (reasons.length === 0 && canary !== null) {
			const redTeamResult = await options.ports.host.runIndependentRedTeam({
				candidate: structuredClone(candidate),
				shadow: structuredClone(shadow),
				canary: structuredClone(canary),
				current: hostProjection(current),
			});
			assertRedTeamResult(candidate, canary, redTeamResult);
			await verifyTypedStageResultArtifact("red_team", redTeamResult, candidate, current);
			const redTeamEvidenceWitnesses = await resolveEvidence({
				stage: "red_team",
				candidateId: candidate.candidateId,
				evidenceRefs: redTeamResult.evidenceRefs,
				payloadDigest: digestPayload(redTeamResult),
				current,
			});
			redTeam = cleanPayload({ ...redTeamResult, evidenceWitnesses: redTeamEvidenceWitnesses });
			await consumeReceipts(
				[...redTeam.receipts],
				"independent_red_team",
				{ candidate, shadow, canary, redTeam: redTeamResult },
				current,
				candidate.candidateId,
			);
			if (!stageMetricsSatisfyCandidate(redTeam.metrics, candidate, redTeam.evidenceRefs)) {
				reasons.push("metrics_required");
			}
			if (!redTeam.passed) reasons.push("red_team_failed");
		}

		if (reasons.length === 0 && canary !== null && redTeam !== null) {
			const currentForDecision = copyHostSnapshot(await options.ports.host.current());
			assertHostSnapshot(currentForDecision);
			if (
				currentForDecision.baselineRevision !== candidate.baselineRevision ||
				currentForDecision.baselineDigest !== candidate.baselineDigest ||
				currentForDecision.currentRevision !== candidate.baselineRevision
			) {
				reasons.push("baseline_mismatch");
			}
			if (candidate.mutationClass === "evaluator" || candidate.mutationClass === "metric") {
				const freshBaseline = shadow.freshBaseline;
				const expectedBaselineDigest =
					candidate.mutationClass === "evaluator"
						? currentForDecision.evaluatorBaselineDigest
						: currentForDecision.metricBaselineDigest;
				if (freshBaseline === undefined || freshBaseline === null) {
					reasons.push("fresh_baseline_required");
				} else {
					if (
						freshBaseline.baselineDigest !== expectedBaselineDigest ||
						freshBaseline.baselineRevision !== currentForDecision.baselineRevision
					) {
						reasons.push("fresh_baseline_required");
					}
					try {
						assertWorkflowDecisionRef(
							freshBaseline.decisionRef,
							candidate.workflowId,
							"Fresh baseline decision",
							currentForDecision,
						);
					} catch (_error: unknown) {
						reasons.push("fresh_decision_required");
					}
				}
			}
			if (reasons.length === 0) {
				decision = await options.ports.host.resolveDecision({
					candidate: structuredClone(candidate),
					shadow: structuredClone(shadow),
					canary: structuredClone(canary),
					redTeam: structuredClone(redTeam),
					current: hostProjection(currentForDecision),
				});
				assertOpaque(decision);
				assertWorkflowDecision(decision.decision, candidate.workflowId);
				if (decision.decisionWitness === undefined) {
					reasons.push("decision_witness_required");
				} else {
					decisionWitness = structuredClone(decision.decisionWitness);
					const decisionPayloadDigest = digestPayload(decision.decision);
					const resolvedDecisionWitnesses = await resolveEvidence({
						stage: "decision",
						candidateId: candidate.candidateId,
						evidenceRefs: [decision.decisionWitness.evidenceRef],
						payloadDigest: decisionPayloadDigest,
						current: currentForDecision,
						witnessKind: "decision",
					});
					assertWitness(
						decision.decisionWitness,
						currentForDecision,
						"decision",
						candidate.candidateId,
						decisionPayloadDigest,
						decision.decisionWitness.evidenceRef,
						"decision",
					);
					if (resolvedDecisionWitnesses[0]?.witnessId !== decision.decisionWitness.witnessId) {
						throw new Error("Decision witness was not verified by the host resolver.");
					}
					if (!decision.decisionWitness.oneUse) throw new Error("Decision witness must be one-use.");
				}
				decisionRef = decision.decisionRef ?? null;
				if (decision.decisionRef === undefined) {
					reasons.push("current_decision_required");
				} else {
					try {
						assertWorkflowDecisionRef(
							decision.decisionRef,
							candidate.workflowId,
							"Promotion decision",
							currentForDecision,
						);
					} catch (_error: unknown) {
						reasons.push("current_decision_required");
					}
				}
				if (candidate.mutationClass === "evaluator" || candidate.mutationClass === "metric") {
					const freshDecisionRef = shadow.freshBaseline?.decisionRef;
					if (freshDecisionRef === undefined || decision.decisionRef === undefined) {
						reasons.push("fresh_decision_required");
					} else {
						try {
							assertWorkflowDecisionRef(
								decision.decisionRef,
								candidate.workflowId,
								"Promotion decision",
								currentForDecision,
							);
						} catch (_error: unknown) {
							reasons.push("fresh_decision_required");
						}
						if (reasons.length === 0 && !sameDecisionRef(freshDecisionRef, decision.decisionRef)) {
							reasons.push("fresh_decision_required");
						}
					}
				}
				if (reasons.length === 0) {
					await options.ports.decisionGate.validateVerdicts(decision.decision);
					const authorization = await options.ports.decisionGate.authorize(
						decision.decision,
						decision.operation as WorkflowAuthorizationInput,
					);
					if (authorization === "awaiting_user") {
						const review: WorkflowLearningReviewRecord = {
							reviewId: `review-${state.reviews.length + 1}`,
							candidateId,
							status: "proposed",
							reasons: ["decision_awaiting_user"],
							shadow,
							canary,
							redTeam,
							promotion: null,
							decision,
							decisionRef,
							decisionWitness,
						};
						state = appendReview(state, review, "proposed");
						await emitEvent(options.ports.eventSink, {
							kind: "improvement_reviewed",
							candidateId,
							proposalRef: candidate.proposalRef,
							reviewRef: shadow.resultRef,
							resultRef: null,
						});
						return reviewResult(review);
					}
					if (authorization !== "authorized") reasons.push("decision_rejected");
					if (reasons.length === 0 && PROTECTED_AUTO_PROMOTION_CLASSES.has(candidate.mutationClass)) {
						const review: WorkflowLearningReviewRecord = {
							reviewId: `review-${state.reviews.length + 1}`,
							candidateId,
							status: "proposed",
							reasons: ["host_approval_required"],
							shadow,
							canary,
							redTeam,
							promotion: null,
							decision,
							decisionRef,
							decisionWitness,
						};
						state = appendReview(state, review, "proposed");
						await emitEvent(options.ports.eventSink, {
							kind: "improvement_reviewed",
							candidateId,
							proposalRef: candidate.proposalRef,
							reviewRef: shadow.resultRef,
							resultRef: null,
						});
						return reviewResult(review);
					}
					if (reasons.length === 0) {
						const promotionOperationId = operationId ?? `learning:review:${digestObject(candidateId)}`;
						assertBoundedString(promotionOperationId, "Promotion operation id", 256);
						const expected = casExpectation(currentForDecision);
						const reconciled = await options.ports.host.reconcilePromotion({
							operationId: promotionOperationId,
							candidate: structuredClone(candidate),
							shadow: structuredClone(shadow),
							canary: structuredClone(canary),
							redTeam: structuredClone(redTeam),
							decision: structuredClone(decision),
							current: hostProjection(currentForDecision),
							expected,
						});
						const priorPromotions = state.reviews.flatMap((review) =>
							review.promotion === null ? [] : [review.promotion],
						);
						if (reconciled !== null) {
							assertPromotionReconciliation(
								reconciled,
								candidate,
								currentForDecision,
								priorPromotions,
								expected,
								decision,
								promotionOperationId,
							);
							promotion = reconciled.promotion;
						} else {
							promotion = await options.ports.host.promote({
								operationId: promotionOperationId,
								candidate: structuredClone(candidate),
								shadow: structuredClone(shadow),
								canary: structuredClone(canary),
								redTeam: structuredClone(redTeam),
								decision: structuredClone(decision),
								current: hostProjection(currentForDecision),
								expected,
							});
						}
						assertPromotion(promotion, candidate, currentForDecision, priorPromotions, expected, decision);
						await consumeReceipts(
							[promotion.receipt],
							"host_fenced_promotion",
							{ candidate, shadow, canary, redTeam, decision, promotion },
							currentForDecision,
							candidate.candidateId,
						);
						const postPromotion = copyHostSnapshot(await options.ports.host.current());
						assertPostPromotionSnapshot(postPromotion, promotion, expected);
					}
				}
			}
		}

		const status: WorkflowLearningReviewStatus =
			promotion !== null ? "promoted" : reasons.length === 0 ? "proposed" : "rejected";
		const candidateState: WorkflowLearningCandidateStatus =
			promotion !== null ? "promoted" : status === "proposed" ? "proposed" : "rejected";
		const review: WorkflowLearningReviewRecord = {
			reviewId: `review-${state.reviews.length + 1}`,
			candidateId,
			status,
			reasons,
			shadow,
			canary,
			redTeam,
			promotion,
			decision,
			decisionRef,
			decisionWitness,
		};
		state = appendReview(state, review, candidateState);
		await emitEvent(options.ports.eventSink, {
			kind: "improvement_reviewed",
			candidateId,
			proposalRef: candidate.proposalRef,
			reviewRef: shadow.resultRef,
			resultRef: promotion?.receipt.artifactRef ?? null,
		});
		if (promotion !== null) {
			await emitEvent(options.ports.eventSink, {
				kind: "policy_revision_recorded",
				candidateId,
				proposalRef: candidate.proposalRef,
				reviewRef: shadow.resultRef,
				resultRef: promotion.receipt.artifactRef,
			});
		}
		return reviewResult(review);
	};

	const handleTriggerInternal = async (trigger: WorkflowLearningTrigger): Promise<WorkflowLearningTriggerResult> => {
		const current = copyHostSnapshot(await options.ports.host.current());
		assertTrigger(trigger, current);
		await verifyTrustedClock(current);
		await verifyCanonicalArtifact(trigger.sourceEventRef, current, "Trigger source event artifact");
		const triggerEvidenceWitnesses = await resolveEvidence({
			stage: "trigger",
			candidateId: trigger.candidateId,
			evidenceRefs: trigger.evidenceRefs,
			payloadDigest: trigger.evidenceDigest ?? "",
			current,
		});
		const recordedTrigger = cleanPayload({ ...trigger, evidenceWitnesses: triggerEvidenceWitnesses });
		const triggerReceipt = trigger.hostReceipt as WorkflowVerifiedHostReceipt;
		await verifyReceipt(triggerReceipt, "trigger", trigger, current, trigger.candidateId);
		const identity = triggerIdentity(trigger);
		const existing = state.triggers.find((recorded) => triggerIdentity(recorded) === identity);
		if (existing !== undefined) {
			if (existing.kind === "regression" && existing.candidateId !== null) {
				const existingProposal = state.rollbackProposals.find(
					(proposal) => proposal.candidateId === existing.candidateId,
				);
				if (existingProposal !== undefined) {
					return {
						status: "rollback_proposed",
						trigger: immutableClone(existing),
						proposal: structuredClone(existingProposal),
					};
				}
			}
			return { status: "queued", trigger: immutableClone(existing) };
		}
		if (trigger.kind === "regression" && trigger.candidateId !== null) {
			const existingProposal = state.rollbackProposals.find(
				(proposal) => proposal.candidateId === trigger.candidateId,
			);
			if (existingProposal !== undefined) {
				if (!state.consumedReceiptIds.includes(triggerReceipt.receiptId)) {
					await consumeReceipts([triggerReceipt], "trigger", trigger, current, trigger.candidateId);
				}
				if (state.triggers.length >= MAX_LEARNING_TRIGGERS) {
					throw new Error("Learning trigger history is bounded.");
				}
				state = finalizeState({ ...state, triggers: [...state.triggers, recordedTrigger] });
				return {
					status: "rollback_proposed",
					trigger: immutableClone(recordedTrigger),
					proposal: immutableClone(existingProposal),
				};
			}
		}
		if (state.triggers.length >= MAX_LEARNING_TRIGGERS) {
			throw new Error("Learning trigger history is bounded.");
		}
		if (trigger.kind !== "regression" || trigger.candidateId === null) {
			await consumeReceipts(
				[trigger.hostReceipt as WorkflowVerifiedHostReceipt],
				"trigger",
				trigger,
				current,
				trigger.candidateId,
			);
			state = finalizeState({ ...state, triggers: [...state.triggers, recordedTrigger] });
			return { status: "queued", trigger: immutableClone(recordedTrigger) };
		}
		const candidateRecord = findCandidate(state, trigger.candidateId);
		if (candidateRecord.status !== "promoted") throw new Error("Regression rollback requires a promoted candidate.");
		const promotedReview = [...state.reviews]
			.reverse()
			.find((review) => review.candidateId === trigger.candidateId && review.promotion !== null);
		if (promotedReview?.promotion === null || promotedReview === undefined) {
			throw new Error("Regression rollback requires a recorded promotion identity.");
		}
		if (promotedReview.decisionRef === null) {
			throw new Error("Regression rollback requires the promotion decision reference.");
		}
		await consumeReceipts(
			[trigger.hostReceipt as WorkflowVerifiedHostReceipt],
			"trigger",
			trigger,
			current,
			trigger.candidateId,
		);
		const rollbackOperationId = `learning:rollback:${digestObject({
			candidateId: candidateRecord.candidate.candidateId,
			triggerIdentity: triggerIdentity(recordedTrigger),
		})}`;
		const expected = casExpectation(current);
		const proposal = await options.ports.host.proposeRollback({
			operationId: rollbackOperationId,
			candidate: structuredClone(candidateRecord.candidate),
			trigger: structuredClone(recordedTrigger),
			decisionRef: structuredClone(promotedReview.decisionRef),
			current: hostProjection(current),
			expected,
		});
		assertRollbackProposal(
			proposal,
			candidateRecord.candidate,
			promotedReview.promotion.revisionId,
			promotedReview.decisionRef,
			current,
			expected,
		);
		await verifyCanonicalArtifact(proposal.proposalRef, current, "Rollback proposal artifact");
		if (state.rollbackProposals.some((existingProposal) => existingProposal.proposalId === proposal.proposalId)) {
			throw new Error("Rollback proposal identity was already recorded.");
		}
		await consumeReceipts(
			[proposal.receipt],
			"rollback_proposal",
			{
				candidate: candidateRecord.candidate,
				trigger: recordedTrigger,
				proposal,
				decisionRef: promotedReview.decisionRef,
			},
			current,
			candidateRecord.candidate.candidateId,
		);
		const application = await options.ports.host.applyRollback({
			operationId: rollbackOperationId,
			candidate: structuredClone(candidateRecord.candidate),
			trigger: structuredClone(recordedTrigger),
			proposal: structuredClone(proposal),
			decisionRef: promotedReview.decisionRef,
			current: hostProjection(current),
			expected,
		});
		assertRollbackApplication(
			application,
			candidateRecord.candidate,
			proposal,
			recordedTrigger,
			promotedReview.decisionRef,
			current,
			expected,
			rollbackOperationId,
		);
		await consumeReceipts(
			[application.receipt],
			"rollback_applied",
			{ candidate: candidateRecord.candidate, trigger: recordedTrigger, proposal, application },
			current,
			candidateRecord.candidate.candidateId,
		);
		const recordedProposal: WorkflowLearningRollbackRecord = {
			...proposal,
			application: structuredClone(application),
		};
		state = finalizeState({
			...state,
			triggers: [...state.triggers, recordedTrigger],
			rollbackProposals: [...state.rollbackProposals, recordedProposal],
		});
		state = candidateStatus(state, trigger.candidateId, "rollback_proposed");
		await emitEvent(options.ports.eventSink, {
			kind: "improvement_proposed",
			candidateId: trigger.candidateId,
			proposalRef: proposal.proposalRef,
			reviewRef: null,
			resultRef: null,
		});
		return {
			status: "rollback_proposed",
			trigger: immutableClone(recordedTrigger),
			proposal: immutableClone(recordedProposal),
		};
	};

	const reviewCandidate = (candidateId: string, operationId?: string): Promise<WorkflowLearningReviewResult> => {
		const existing = reviewInFlight.get(candidateId);
		if (existing !== undefined) return existing.then((review) => immutableClone(review));
		const pending = reviewCandidateInternal(candidateId, operationId);
		reviewInFlight.set(candidateId, pending);
		void pending.then(
			() => {
				if (reviewInFlight.get(candidateId) === pending) reviewInFlight.delete(candidateId);
			},
			() => {
				if (reviewInFlight.get(candidateId) === pending) reviewInFlight.delete(candidateId);
			},
		);
		return pending.then((review) => immutableClone(review));
	};

	const handleTrigger = (trigger: WorkflowLearningTrigger): Promise<WorkflowLearningTriggerResult> => {
		const frozenTrigger = immutableClone(trigger);
		const validated = (async (): Promise<WorkflowLearningTriggerResult> => {
			assertTriggerShape(frozenTrigger);
			const current = copyHostSnapshot(await options.ports.host.current());
			assertTrigger(frozenTrigger, current);
			await verifyTrustedClock(current);
			await verifyCanonicalArtifact(frozenTrigger.sourceEventRef, current, "Trigger source event artifact");
			await resolveEvidence({
				stage: "trigger",
				candidateId: frozenTrigger.candidateId,
				evidenceRefs: frozenTrigger.evidenceRefs,
				payloadDigest: frozenTrigger.evidenceDigest ?? "",
				current,
			});
			const triggerReceipt = frozenTrigger.hostReceipt as WorkflowVerifiedHostReceipt;
			await verifyReceipt(triggerReceipt, "trigger", frozenTrigger, current, frozenTrigger.candidateId);
			const identity = triggerIdentity(frozenTrigger);
			const existing = triggerInFlight.get(identity);
			if (existing !== undefined) return existing;
			const pending = handleTriggerInternal(frozenTrigger);
			triggerInFlight.set(identity, pending);
			void pending.then(
				() => {
					if (triggerInFlight.get(identity) === pending) triggerInFlight.delete(identity);
				},
				() => {
					if (triggerInFlight.get(identity) === pending) triggerInFlight.delete(identity);
				},
			);
			return pending;
		})();
		return validated.then((result) => immutableClone(result));
	};

	return {
		commitExperience,
		typeCandidate,
		reviewCandidate,
		handleTrigger,
		getState: () => immutableClone(state),
	};
}

/**
 * Create a fresh learning controller from live host ports.
 *
 * Replayed state is intentionally not accepted here. Durable adapters must
 * authenticate and validate persisted bytes before using the internal replay
 * seam below.
 */
export function createWorkflowLearningController(options: {
	ports: WorkflowLearningPorts;
	state?: WorkflowLearningState;
}): WorkflowLearningController {
	if (options.state !== undefined) {
		throw new Error("Learning state hydration requires the authenticated durable replay seam.");
	}
	return createWorkflowLearningControllerInternal({ ports: options.ports });
}

/**
 * Hydrate a controller only after a durable host adapter has authenticated the
 * persisted state and its signed artifacts.
 */
export function createWorkflowLearningControllerFromDurableState(options: {
	ports: WorkflowLearningPorts;
	state: WorkflowLearningState;
}): WorkflowLearningController {
	return createWorkflowLearningControllerInternal(options);
}
