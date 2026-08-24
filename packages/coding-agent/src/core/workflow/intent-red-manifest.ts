import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowJournalHead,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { parseWorkflowCanonicalPath } from "./task-graph.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
export const WORKFLOW_RED_TEST_MANIFEST_SCHEMA_ID = "workflow-red-test-manifest-v1" as const;
export const WORKFLOW_RED_TEST_RESULT_SCHEMA_ID = "workflow-red-test-result-v1" as const;
export const WORKFLOW_INTENT_RED_MUTATION_CAPABILITY = "workflow_intent_red_mutation" as const;
export const WORKFLOW_INTENT_RED_MUTATION_OPERATION = "workflow-intent-red-production-mutation" as const;
const MANIFEST_SCHEMA_ID = WORKFLOW_RED_TEST_MANIFEST_SCHEMA_ID;
const RESULT_SCHEMA_ID = WORKFLOW_RED_TEST_RESULT_SCHEMA_ID;
const MANIFEST_VERSION = 1 as const;
const RESULT_VERSION = 1 as const;
const RECEIPT_KINDS = new Set(["clock", "artifact", "capability", "decision", "lease", "usage", "adjudication"]);
const verifiedManifestTokenData = new WeakMap<object, VerifiedManifestTokenData>();
const verifiedResultTokenData = new WeakMap<object, VerifiedResultTokenData>();
const consumedManifestTokens = new WeakSet<object>();
const consumedResultTokens = new WeakSet<object>();

interface VerifiedManifestTokenData {
	manifest: WorkflowIntentRedManifest;
	hostBinding: WorkflowIntentRedHostBinding;
	currentHead: WorkflowJournalHead;
	currentEpoch: WorkflowEpochRef;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
	receiptWitness: WorkflowHostReceiptConsumptionWitness;
	authorityWitness: WorkflowHostReceiptConsumptionWitness;
	authorityBindingDigest: string;
	principalAuthorization: WorkflowHostPrincipalCapabilityAuthorization;
	context: WorkflowHostReceiptConsumerContext;
}

interface VerifiedResultTokenData {
	manifestToken: WorkflowIntentRedVerifiedManifestToken;
	manifest: WorkflowIntentRedManifest;
	result: WorkflowIntentRedTestResult;
	hostBinding: WorkflowIntentRedHostBinding;
	currentHead: WorkflowJournalHead;
	currentEpoch: WorkflowEpochRef;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
	receiptWitness: WorkflowHostReceiptConsumptionWitness;
}

export type WorkflowIntentRedAssertionTarget = "user_outcome" | "forbidden_outcome";

export type WorkflowIntentRedFailureClass = "assertion_failure" | "setup_error" | "test_error" | "infrastructure_error";

export type WorkflowIntentRedEvidenceClassification = "acceptance" | "debug_probe";

export type WorkflowIntentRedDurabilityEvidenceKind = "integration" | "restart" | "process" | "store";

export interface WorkflowIntentRedDurabilityEvidence {
	kind: WorkflowIntentRedDurabilityEvidenceKind;
	artifactRef: WorkflowArtifactRef;
	provenanceDigest: string;
	observedAt: string;
	freshUntil: string;
	source: string;
}

export interface WorkflowIntentRedPublicBoundaryRegistryEntry {
	publicBoundary: string;
	target: WorkflowIntentRedAssertionTarget;
	outcomeIds: readonly string[];
}

export interface WorkflowIntentRedProcessEvidence {
	artifactRef: WorkflowArtifactRef;
	testId: string;
	commandDigest: string;
	sourceDigest: string;
	publicBoundary: string;
	executionIdentity: string;
	processId: number;
	startedAt: string;
	completedAt: string;
	mode: "real_process";
	fakeOnly: false;
	provenanceDigest: string;
}

export interface WorkflowIntentRedAssertion {
	assertionId: string;
	target: WorkflowIntentRedAssertionTarget;
	outcomeId: string;
	publicBoundary: string;
	description: string;
}

export interface WorkflowIntentRedAssertionFailure {
	assertionId: string;
	target: WorkflowIntentRedAssertionTarget;
	outcomeId: string;
	publicBoundary: string;
	assertionDigest: string;
	artifactRef: WorkflowArtifactRef;
	message: string;
}

export interface WorkflowIntentRedTestCase {
	testId: string;
	attackId: string;
	commandArtifactRef: WorkflowArtifactRef;
	commandDigest: string;
	sourceArtifactRef: WorkflowArtifactRef;
	sourceDigest: string;
	inputArtifactRefs: readonly WorkflowArtifactRef[];
	inputDigest: string;
	publicBoundary: string;
	hostScanEvidenceRefs: readonly WorkflowArtifactRef[];
	evidenceClassification: WorkflowIntentRedEvidenceClassification;
	assertions: readonly WorkflowIntentRedAssertion[];
	expectedExitCode: number;
	timeoutMilliseconds: number;
	requiredEvidenceKinds: readonly string[];
	owner: "host";
	hidden: boolean;
	requiresRealRuntime: true;
	mockOnly: false;
	testDigest: string;
}

export interface WorkflowIntentRedManifest {
	schemaId: typeof MANIFEST_SCHEMA_ID;
	schemaVersion: typeof MANIFEST_VERSION;
	workflowId: string;
	taskId: string;
	attemptId: string;
	expectedHead: WorkflowJournalHead;
	expectedHeadDigest: string;
	epochRef: WorkflowEpochRef;
	scopeDigest: string;
	recipeDigest: string;
	planRevision: number;
	tests: readonly WorkflowIntentRedTestCase[];
	maxTests: number;
	maxRuntimeMilliseconds: number;
	evidenceRefs: readonly WorkflowArtifactRef[];
	durabilityEvidence: readonly WorkflowIntentRedDurabilityEvidence[];
	executable: true;
	owner: "host";
	hostReceipt: WorkflowVerifiedHostReceipt;
	manifestDigest: string;
	idempotencyKey: string;
}

export interface WorkflowIntentRedTestResult {
	schemaId: typeof RESULT_SCHEMA_ID;
	schemaVersion: typeof RESULT_VERSION;
	workflowId: string;
	taskId: string;
	attemptId: string;
	manifestDigest: string;
	recipeDigest: string;
	planRevision: number;
	testId: string;
	testDigest: string;
	invocationId: string;
	idempotencyKey: string;
	expectedHeadDigest: string;
	epochRef: WorkflowEpochRef;
	runtimeMode: "worker_free_shell" | "true_runtime";
	startBoundaryRef: WorkflowArtifactRef;
	endBoundaryRef: WorkflowArtifactRef;
	processEvidenceRefs: readonly WorkflowArtifactRef[];
	processEvidence: WorkflowIntentRedProcessEvidence;
	exitCode: number;
	timedOut: boolean;
	stdoutArtifactRef: WorkflowArtifactRef;
	stderrArtifactRef: WorkflowArtifactRef;
	evidenceRefs: readonly WorkflowArtifactRef[];
	classification: WorkflowIntentRedFailureClass;
	passed: boolean;
	failedAssertions: readonly WorkflowIntentRedAssertionFailure[];
	hostReceipt: WorkflowVerifiedHostReceipt;
	resultDigest: string;
}

export type WorkflowIntentRedTestCaseDraft = Omit<WorkflowIntentRedTestCase, "testDigest">;

export type WorkflowIntentRedManifestBindingInput = Omit<
	WorkflowIntentRedManifest,
	"hostReceipt" | "manifestDigest" | "idempotencyKey" | "tests"
> & {
	tests: readonly WorkflowIntentRedTestCaseDraft[];
};

export type WorkflowIntentRedManifestDraft = WorkflowIntentRedManifestBindingInput & {
	hostReceipt: WorkflowVerifiedHostReceipt;
};

type WorkflowIntentRedNormalizedManifestBinding = Omit<WorkflowIntentRedManifestBindingInput, "tests"> & {
	tests: readonly WorkflowIntentRedTestCase[];
};

export type WorkflowIntentRedResultBindingInput = Omit<WorkflowIntentRedTestResult, "hostReceipt" | "resultDigest">;

export type WorkflowIntentRedTestResultDraft = WorkflowIntentRedResultBindingInput & {
	hostReceipt: WorkflowVerifiedHostReceipt;
};

const verifiedManifestTokenBrand: unique symbol = Symbol("workflow-intent-red-verified-manifest-token");
const verifiedResultTokenBrand: unique symbol = Symbol("workflow-intent-red-verified-result-token");

/** Opaque proof produced only after the host verifies a complete manifest. */
export interface WorkflowIntentRedVerifiedManifestToken {
	readonly [verifiedManifestTokenBrand]: true;
}

/** Opaque proof produced only after the host verifies a result against a verified manifest. */
export interface WorkflowIntentRedVerifiedResultToken {
	readonly [verifiedResultTokenBrand]: true;
}

export interface WorkflowIntentRedHostBinding {
	goalDigest: string;
	scorecardDigest: string;
	publicBoundaryRegistryDigest: string;
	publicBoundaryRegistry: readonly WorkflowIntentRedPublicBoundaryRegistryEntry[];
	effectDigest: string;
	affectedProductionSurface: readonly string[];
	writeSet: readonly string[];
	closureRationale: string;
}

export type WorkflowIntentRedHostReceiptContext = WorkflowHostReceiptConsumerContext;

export interface WorkflowIntentRedManifestVerificationInput {
	manifest: WorkflowIntentRedManifest;
	context: WorkflowHostReceiptConsumerContext;
	hostBinding: WorkflowIntentRedHostBinding;
	authorityReceipt: WorkflowVerifiedHostReceipt;
	currentHead: WorkflowJournalHead;
	currentEpoch: WorkflowEpochRef;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
}

export interface WorkflowIntentRedTestResultVerificationInput {
	manifestToken: WorkflowIntentRedVerifiedManifestToken;
	result: WorkflowIntentRedTestResult;
	context: WorkflowHostReceiptConsumerContext;
	hostBinding: WorkflowIntentRedHostBinding;
	currentHead: WorkflowJournalHead;
	currentEpoch: WorkflowEpochRef;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
}

export interface WorkflowIntentRedMutationAuthorizationInput {
	manifestToken: WorkflowIntentRedVerifiedManifestToken;
	resultTokens: readonly WorkflowIntentRedVerifiedResultToken[];
	scope: WorkflowIntentRedMutationScope;
	currentHead: WorkflowJournalHead;
	currentEpoch: WorkflowEpochRef;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
}

export interface WorkflowIntentRedMutationScope {
	operationDigest: string;
	resourceDigest: string;
	effectDigest: string;
	affectedProductionSurface: readonly string[];
	writeSet: readonly string[];
	closureRationale: string;
}

export const WORKFLOW_INTENT_RED_SLICE_SCHEMA_ID = "workflow-intent-red-slice-v1" as const;

export type WorkflowIntentRedSliceMutationCaseKind =
	| "restart_identical_reconstruction"
	| "stale_approval"
	| "overbroad_approval"
	| "concurrent_duplicate_exactly_once"
	| "read_only_status";

export type WorkflowIntentRedSliceClassification = "coherent_intent_slice" | "fresh_red_required";

export type WorkflowIntentRedSliceExpectedAuthorization =
	| "reconstruct_identical"
	| "deny_stale"
	| "deny_overbroad"
	| "exactly_once"
	| "read_only";

export type WorkflowIntentRedAllowedProductionClosure = Pick<
	WorkflowIntentRedMutationScope,
	"effectDigest" | "affectedProductionSurface" | "writeSet" | "closureRationale"
>;

export interface WorkflowIntentRedSliceProposal {
	proposalId: string;
	schemaField: string;
	evidenceRefs: readonly WorkflowArtifactRef[];
	falsifiableOutcomeIds: readonly string[];
	wallTimeMilliseconds: number;
}

export interface WorkflowIntentRedSliceMutationCaseDraft {
	caseId: string;
	kind: WorkflowIntentRedSliceMutationCaseKind;
	evidenceRefs: readonly WorkflowArtifactRef[];
}

export interface WorkflowIntentRedSliceMutationCase extends WorkflowIntentRedSliceMutationCaseDraft {
	expectedAuthorization: WorkflowIntentRedSliceExpectedAuthorization;
	authorityExpansion: false;
	progressExpansion: false;
}

export interface WorkflowIntentRedSliceMetrics {
	falsifiableOutcomeCount: number;
	evidenceCount: number;
	wallTimeMilliseconds: number;
	outcomesPerWallTime: number;
	evidencePerWallTime: number;
}

export interface WorkflowIntentRedIntentSliceInput {
	manifest: WorkflowIntentRedManifest;
	userOutcomeId: string;
	publicBoundary: string;
	forbiddenOutcomeId: string;
	allowedProductionClosure: WorkflowIntentRedAllowedProductionClosure | WorkflowIntentRedHostBinding;
	hostBinding?: WorkflowIntentRedHostBinding;
	baseRedTestId: string;
	proposals: readonly WorkflowIntentRedSliceProposal[];
	mutationCases: readonly WorkflowIntentRedSliceMutationCaseDraft[];
	metrics: Omit<WorkflowIntentRedSliceMetrics, "outcomesPerWallTime" | "evidencePerWallTime">;
	sliceDigest?: string;
}

export interface WorkflowIntentRedIntentSlice {
	schemaId: typeof WORKFLOW_INTENT_RED_SLICE_SCHEMA_ID;
	schemaVersion: 1;
	classification: WorkflowIntentRedSliceClassification;
	requiresFreshRed: boolean;
	manifest: WorkflowIntentRedManifest;
	baseManifestDigest: string;
	baseRedTestId: string;
	userOutcomeId: string;
	publicBoundary: string;
	forbiddenOutcomeId: string;
	allowedProductionClosure: WorkflowIntentRedAllowedProductionClosure;
	proposals: readonly WorkflowIntentRedSliceProposal[];
	schemaFieldVariants: readonly string[];
	mutationCases: readonly WorkflowIntentRedSliceMutationCase[];
	metrics: WorkflowIntentRedSliceMetrics;
	authorityUnitCount: 1;
	progressUnitCount: 1;
	scopeTokenPolicy: {
		oneUse: true;
		nonRetroactive: true;
	};
	sliceDigest: string;
}

export interface WorkflowIntentRedIntentSliceClassification {
	classification: WorkflowIntentRedSliceClassification;
	requiresFreshRed: boolean;
	reason: string | null;
	slice: WorkflowIntentRedIntentSlice | null;
}

export interface WorkflowIntentRedMutationAuthorization {
	authorized: boolean;
	reason: "outcome_linked_assertion_failure" | "no_outcome_linked_assertion_failure" | "post_effect";
	manifestDigest: string;
	goalDigest: string;
	scorecardDigest: string;
	publicBoundaryRegistryDigest: string;
	publicBoundaryRegistry: readonly WorkflowIntentRedPublicBoundaryRegistryEntry[];
	allowedSemanticBehaviorSurface: readonly string[];
	operationDigest: string;
	resourceDigest: string;
	affectedProductionSurface: readonly string[];
	writeSet: readonly string[];
	normalizedWriteClosure: readonly string[];
	closureRationale: string;
	evidenceDigest: string;
	authorizationDigest: string;
	authorityWitness: WorkflowHostReceiptConsumptionWitness;
	effectDigest: string;
	executionIdentity: string | null;
	sessionId: string | null;
	productionBaseHead: WorkflowJournalHead;
	productionBaseHeadDigest: string;
	baseProductionHead: WorkflowJournalHead;
	baseProductionHeadDigest: string;
	productionBaseEpoch: WorkflowEpochRef;
	baseProductionEpoch: WorkflowEpochRef;
	productionBaseStateDigest: string;
	baseProductionStateDigest: string;
	productionBaseRevision: number;
	baseProductionRevision: number;
	lastAdmissibleProductionHead: WorkflowJournalHead;
	lastAdmissibleProductionHeadDigest: string;
	quarantine:
		| { readonly reason: "none" }
		| { readonly reason: "post_effect"; readonly lastAdmissibleProductionHeadDigest: string };
}

export interface WorkflowIntentRedTestResultReplayInput {
	persisted: WorkflowIntentRedTestResult | null;
	incoming: WorkflowIntentRedTestResult;
}

export interface WorkflowIntentRedTestResultReplay {
	status: "new" | "already_committed";
	result: WorkflowIntentRedTestResult;
}

export interface WorkflowIntentRedManifestEventPayload {
	kind: "workflow_red_test_manifest_published";
	workflowId: string;
	taskId: string;
	attemptId: string;
	expectedHead: WorkflowJournalHead;
	epochRef: WorkflowEpochRef;
	manifestDigest: string;
	manifestArtifactRef: WorkflowArtifactRef;
	idempotencyKey: string;
	hostReceipt: WorkflowVerifiedHostReceipt;
}

export interface WorkflowIntentRedManifestEventPayloadInput {
	manifest: WorkflowIntentRedManifest;
	manifestArtifactRef: WorkflowArtifactRef;
	artifactResolver: WorkflowArtifactResolver;
}

export interface WorkflowIntentRedTestResultEventPayload {
	kind: "workflow_red_test_result_recorded";
	workflowId: string;
	taskId: string;
	attemptId: string;
	manifestDigest: string;
	testId: string;
	invocationId: string;
	resultDigest: string;
	resultArtifactRef: WorkflowArtifactRef;
	hostReceipt: WorkflowVerifiedHostReceipt;
}

export interface WorkflowIntentRedResultEventPayloadInput {
	result: WorkflowIntentRedTestResult;
	resultArtifactRef: WorkflowArtifactRef;
	artifactResolver: WorkflowArtifactResolver;
}

export type WorkflowIntentRedScopeExceededReason =
	| "effect"
	| "operation"
	| "resource"
	| "surface"
	| "write_set"
	| "head"
	| "epoch"
	| "state"
	| "revision";

export interface WorkflowIntentRedScopeExceededEventPayload {
	kind: "intent_scope_exceeded";
	workflowId: string;
	taskId: string;
	attemptId: string;
	manifestDigest: string;
	expectedHead: WorkflowJournalHead;
	expectedHeadDigest: string;
	currentHead: WorkflowJournalHead;
	currentHeadDigest: string;
	epochRef: WorkflowEpochRef;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
	authorizedScopeDigest: string;
	attemptedScopeDigest: string;
	effectDigest: string;
	executionIdentity: string | null;
	sessionId: string | null;
	reason: WorkflowIntentRedScopeExceededReason;
	quarantine: {
		reason: "intent_scope_exceeded";
		lastAdmissibleProductionHeadDigest: string;
	};
}

export interface WorkflowIntentRedScopeExceededEventPayloadInput {
	manifest: WorkflowIntentRedManifest;
	authorizedScope: WorkflowIntentRedMutationScope;
	attemptedScope: WorkflowIntentRedMutationScope;
	currentHead: WorkflowJournalHead;
	currentEpoch: WorkflowEpochRef;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
	executionIdentity: string | null;
	sessionId: string | null;
	reason: WorkflowIntentRedScopeExceededReason;
}

/**
 * Build the durable denial payload for a mutation outside the host-authorized RED closure.
 * Args:
 * input: Immutable manifest, authorized scope, attempted scope, and current host tuple.
 * Return: Closed event payload for the existing workflow journal seam.
 */
export function workflowIntentRedScopeExceededEventPayload(
	input: WorkflowIntentRedScopeExceededEventPayloadInput,
): WorkflowIntentRedScopeExceededEventPayload {
	const manifest = assertCompleteManifest(input.manifest);
	const authorizedScope = normalizeMutationScope(input.authorizedScope);
	const attemptedScope = normalizeMutationScope(input.attemptedScope);
	const currentHead = normalizeJournalHead(input.currentHead);
	const currentEpoch = normalizeEpochRef(input.currentEpoch);
	assertVerificationClock(input.currentStateDigest, input.currentRevision, input.trustedNow);
	assertNullableIdentifier(input.executionIdentity, "RED scope denial executionIdentity");
	assertNullableIdentifier(input.sessionId, "RED scope denial sessionId");
	if (currentHead.workflowId !== manifest.workflowId)
		throw new Error("RED scope denial current head names a different workflow.");
	if (currentEpoch.storeEpoch < 1 || currentEpoch.coordinatorEpoch < 1)
		throw new Error("RED scope denial epoch is not canonical.");
	const currentHeadDigest = digestObject(currentHead);
	return cloneFrozen({
		kind: "intent_scope_exceeded",
		workflowId: manifest.workflowId,
		taskId: manifest.taskId,
		attemptId: manifest.attemptId,
		manifestDigest: manifest.manifestDigest,
		expectedHead: manifest.expectedHead,
		expectedHeadDigest: manifest.expectedHeadDigest,
		currentHead,
		currentHeadDigest,
		epochRef: currentEpoch,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
		authorizedScopeDigest: workflowIntentRedMutationScopeDigest(authorizedScope),
		attemptedScopeDigest: workflowIntentRedMutationScopeDigest(attemptedScope),
		effectDigest: attemptedScope.effectDigest,
		executionIdentity: input.executionIdentity,
		sessionId: input.sessionId,
		reason: input.reason,
		quarantine: {
			reason: "intent_scope_exceeded",
			lastAdmissibleProductionHeadDigest: manifest.expectedHeadDigest,
		},
	});
}

/**
 * Compute the digest that a host receipt must bind for a RED manifest.
 * Args:
 * input: Manifest fields excluding the host receipt and derived digests.
 * Return: Canonical SHA-256 digest of the host-bound manifest preimage.
 */
export function workflowIntentRedManifestBindingDigest(input: WorkflowIntentRedManifestBindingInput): string {
	const normalized = normalizeManifestBindingInput(input);
	return digestObject({
		kind: "workflow-intent-red-manifest-binding",
		...normalized,
		tests: normalized.tests.map((test) => ({ ...test })),
	});
}

/**
 * Compute the host-owned authority binding required before RED evidence can authorize mutation.
 * Args:
 * input: Current goal, scorecard, public-boundary registry, head, epoch, state, revision, and trusted time.
 * Return: Canonical digest bound into the host authority receipt.
 */
export function workflowIntentRedHostBindingDigest(input: {
	manifestDigest: string;
	hostBinding: WorkflowIntentRedHostBinding;
	artifactEvidenceDigest: string;
	resourceDigest: string;
	operationDigest: string;
	executionIdentity: string | null;
	sessionId: string | null;
	currentHead: WorkflowJournalHead;
	currentEpoch: WorkflowEpochRef;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
}): string {
	assertDigest(input.manifestDigest, "RED authority manifestDigest");
	assertDigest(input.artifactEvidenceDigest, "RED authority artifactEvidenceDigest");
	assertDigest(input.resourceDigest, "RED authority resourceDigest");
	assertDigest(input.operationDigest, "RED authority operationDigest");
	assertDigest(input.currentStateDigest, "RED authority currentStateDigest");
	if (!Number.isSafeInteger(input.currentRevision) || input.currentRevision < 1)
		throw new Error("RED authority revision is not a positive safe integer.");
	assertTrustedTime(input.trustedNow, "RED authority trustedNow");
	assertNullableIdentifier(input.executionIdentity, "RED authority executionIdentity");
	assertNullableIdentifier(input.sessionId, "RED authority sessionId");
	return digestObject({
		kind: "workflow-intent-red-host-authority",
		manifestDigest: input.manifestDigest,
		hostBinding: normalizeHostBinding(input.hostBinding),
		artifactEvidenceDigest: input.artifactEvidenceDigest,
		resourceDigest: input.resourceDigest,
		operationDigest: input.operationDigest,
		executionIdentity: input.executionIdentity,
		sessionId: input.sessionId,
		currentHead: normalizeJournalHead(input.currentHead),
		currentEpoch: normalizeEpochRef(input.currentEpoch),
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
	});
}

/**
 * Compute the immutable digest of a complete RED manifest.
 * Args:
 * manifest: Complete manifest or a draft with a host receipt.
 * Return: Canonical SHA-256 digest with the derived digest field blanked.
 */
export function workflowIntentRedManifestDigest(
	manifest: WorkflowIntentRedManifest | WorkflowIntentRedManifestDraft,
): string {
	const normalized = normalizeManifestWithReceipt(manifest);
	return digestObject({ ...normalized, manifestDigest: "" });
}

/**
 * Compute the immutable production resource scope for one RED attempt.
 * Args:
 * input: Workflow, task, and attempt identifiers owned by the manifest.
 * Return: Canonical digest used as the generic host capability resource.
 */
export function workflowIntentRedMutationResourceDigest(input: {
	workflowId: string;
	taskId: string;
	attemptId: string;
}): string {
	assertIdentifier(input.workflowId, "RED mutation workflowId");
	assertIdentifier(input.taskId, "RED mutation taskId");
	assertIdentifier(input.attemptId, "RED mutation attemptId");
	return digestObject({
		kind: "workflow-intent-red-production-resource",
		workflowId: input.workflowId,
		taskId: input.taskId,
		attemptId: input.attemptId,
	});
}

/**
 * Compute the immutable production operation scope for one RED manifest.
 * Args:
 * input: Manifest and resource identity that the host capability authorizes.
 * Return: Canonical digest used as the generic host capability operation.
 */
export function workflowIntentRedMutationOperationDigest(input: {
	manifestDigest: string;
	recipeDigest: string;
	planRevision: number;
	resourceDigest: string;
}): string {
	assertDigest(input.manifestDigest, "RED mutation manifestDigest");
	assertDigest(input.recipeDigest, "RED mutation recipeDigest");
	assertDigest(input.resourceDigest, "RED mutation resourceDigest");
	if (!Number.isSafeInteger(input.planRevision) || input.planRevision < 1)
		throw new Error("RED mutation planRevision is not a positive safe integer.");
	return digestObject({
		kind: "workflow-intent-red-production-operation",
		operation: WORKFLOW_INTENT_RED_MUTATION_OPERATION,
		manifestDigest: input.manifestDigest,
		recipeDigest: input.recipeDigest,
		planRevision: input.planRevision,
		resourceDigest: input.resourceDigest,
	});
}

/**
 * Compute the semantic effect digest for a normalized RED mutation closure.
 * Args:
 * input: Immutable resource, affected surface, write set, and closure rationale.
 * Return: Canonical digest used to prevent a broader production effect from reusing RED authority.
 */
export function workflowIntentRedMutationEffectDigest(input: {
	resourceDigest: string;
	affectedProductionSurface: readonly string[];
	writeSet: readonly string[];
	closureRationale: string;
}): string {
	assertDigest(input.resourceDigest, "RED mutation effect resourceDigest");
	const affectedProductionSurface = normalizeProductionPathSet(
		input.affectedProductionSurface,
		"RED mutation effect affected production surface",
	);
	const writeSet = normalizeProductionPathSet(input.writeSet, "RED mutation effect write set");
	assertClosureRationale(input.closureRationale);
	return digestObject({
		kind: "workflow-intent-red-production-effect",
		resourceDigest: input.resourceDigest,
		affectedProductionSurface,
		writeSet,
		closureRationale: input.closureRationale,
	});
}

/**
 * Compute the digest of a normalized RED mutation scope.
 * Args:
 * input: Operation, resource, effect, production surface, write set, and closure rationale.
 * Return: Canonical SHA-256 digest of the exact host-normalized scope.
 */
export function workflowIntentRedMutationScopeDigest(input: WorkflowIntentRedMutationScope): string {
	return digestObject(normalizeMutationScope(input));
}

/**
 * Compute the digest of all immutable RED artifact evidence declared by a manifest.
 * Args:
 * manifest: Complete host-owned manifest.
 * Return: Canonical digest of command, source, input, scan, and durability refs.
 */
export function workflowIntentRedArtifactEvidenceDigest(manifest: WorkflowIntentRedManifest): string {
	const normalized = assertCompleteManifest(manifest);
	return digestObject({
		kind: "workflow-intent-red-artifact-evidence",
		evidenceRefs: normalized.evidenceRefs,
		durabilityEvidence: normalized.durabilityEvidence,
		tests: normalized.tests.map((test) => ({
			testId: test.testId,
			commandArtifactRef: test.commandArtifactRef,
			sourceArtifactRef: test.sourceArtifactRef,
			inputArtifactRefs: test.inputArtifactRefs,
			hostScanEvidenceRefs: test.hostScanEvidenceRefs,
			commandDigest: test.commandDigest,
			sourceDigest: test.sourceDigest,
			inputDigest: test.inputDigest,
		})),
	});
}

/**
 * Compute the payload digest signed by the host capability receipt.
 * Args:
 * input: Host goal, scorecard, public-boundary, evidence, and mutation scope.
 * Return: Canonical digest of the complete authority payload.
 */
export function workflowIntentRedAuthorityPayloadDigest(input: {
	hostBinding: WorkflowIntentRedHostBinding;
	artifactEvidenceDigest: string;
	resourceDigest: string;
	operationDigest: string;
	executionIdentity: string | null;
	sessionId: string | null;
}): string {
	assertDigest(input.artifactEvidenceDigest, "RED authority artifactEvidenceDigest");
	assertDigest(input.resourceDigest, "RED authority resourceDigest");
	assertDigest(input.operationDigest, "RED authority operationDigest");
	assertNullableIdentifier(input.executionIdentity, "RED authority executionIdentity");
	assertNullableIdentifier(input.sessionId, "RED authority sessionId");
	return digestObject({
		kind: "workflow-intent-red-authority-payload",
		hostBinding: normalizeHostBinding(input.hostBinding),
		artifactEvidenceDigest: input.artifactEvidenceDigest,
		resourceDigest: input.resourceDigest,
		operationDigest: input.operationDigest,
		executionIdentity: input.executionIdentity,
		sessionId: input.sessionId,
	});
}

/**
 * Compute the idempotency key for a manifest identity.
 * Args:
 * input: Manifest fields that identify one workflow attempt and expected head.
 * Return: Canonical SHA-256 idempotency key.
 */
export function workflowIntentRedManifestIdempotencyKey(input: WorkflowIntentRedManifestBindingInput): string {
	const normalized = normalizeManifestBindingInput(input);
	return digestObject({
		kind: "workflow-intent-red-manifest",
		workflowId: normalized.workflowId,
		taskId: normalized.taskId,
		attemptId: normalized.attemptId,
		expectedHeadDigest: normalized.expectedHeadDigest,
		epochRef: normalized.epochRef,
		scopeDigest: normalized.scopeDigest,
		recipeDigest: normalized.recipeDigest,
		planRevision: normalized.planRevision,
		tests: normalized.tests.map((test) => ({ ...test })),
	});
}

/**
 * Compute the digest that a host receipt must bind for a RED result.
 * Args:
 * input: Result fields excluding the host receipt and derived result digest.
 * Return: Canonical SHA-256 digest of the host-bound result preimage.
 */
export function workflowIntentRedResultBindingDigest(input: WorkflowIntentRedResultBindingInput): string {
	const normalized = normalizeResultBindingInput(input);
	return digestObject({ kind: "workflow-intent-red-result-binding", ...normalized });
}

/**
 * Compute the immutable digest of a complete RED result.
 * Args:
 * result: Complete result or a draft with a host receipt.
 * Return: Canonical SHA-256 digest with the derived digest field blanked.
 */
export function workflowIntentRedResultDigest(
	result: WorkflowIntentRedTestResult | WorkflowIntentRedTestResultDraft,
): string {
	const normalized = normalizeResultWithReceipt(result);
	return digestObject({ ...normalized, resultDigest: "" });
}

/**
 * Compute the once-only key for one manifest test invocation.
 * Args:
 * input: Immutable manifest, test, and invocation identity.
 * Return: Canonical SHA-256 idempotency key.
 */
export function workflowIntentRedResultIdempotencyKey(input: {
	manifestDigest: string;
	testId: string;
	invocationId: string;
	testDigest: string;
	recipeDigest: string;
	planRevision: number;
}): string {
	assertDigest(input.manifestDigest, "result manifestDigest");
	assertDigest(input.testDigest, "result testDigest");
	assertDigest(input.recipeDigest, "result recipeDigest");
	assertIdentifier(input.testId, "result testId");
	assertIdentifier(input.invocationId, "result invocationId");
	if (!Number.isSafeInteger(input.planRevision) || input.planRevision < 1)
		throw new Error("result planRevision is not a positive safe integer.");
	return digestObject({
		kind: "workflow-intent-red-result",
		manifestDigest: input.manifestDigest,
		testId: input.testId,
		invocationId: input.invocationId,
		testDigest: input.testDigest,
		recipeDigest: input.recipeDigest,
		planRevision: input.planRevision,
	});
}

/**
 * Create a frozen host-owned RED manifest and derive its idempotency and content digests.
 * Args:
 * input: Closed manifest draft with a receipt already bound by the host.
 * Return: Deeply frozen immutable manifest.
 */
export function createWorkflowIntentRedManifest(input: WorkflowIntentRedManifestDraft): WorkflowIntentRedManifest {
	const normalized = normalizeManifestBindingInput(manifestBindingInput(input));
	assertHostReceipt(input.hostReceipt, "manifest hostReceipt");
	const expectedBindingDigest = workflowIntentRedManifestBindingDigest(normalized);
	if (input.hostReceipt.bindingDigest !== expectedBindingDigest)
		throw new Error("Workflow RED manifest host receipt is not bound to its canonical preimage.");
	if (input.hostReceipt.workflowId !== input.workflowId)
		throw new Error("Workflow RED manifest host receipt names a different workflow.");
	const manifest: WorkflowIntentRedManifest = {
		...normalized,
		tests: normalized.tests,
		hostReceipt: cloneFrozen(input.hostReceipt),
		manifestDigest: "",
		idempotencyKey: workflowIntentRedManifestIdempotencyKey(normalized),
	};
	manifest.manifestDigest = workflowIntentRedManifestDigest(manifest);
	return cloneFrozen(manifest);
}

/**
 * Create a frozen host-owned RED test result and derive its content digest.
 * Args:
 * input: Closed result draft with a receipt already bound by the host.
 * Return: Deeply frozen immutable result.
 */
export function createWorkflowIntentRedTestResult(
	input: WorkflowIntentRedTestResultDraft,
): WorkflowIntentRedTestResult {
	const normalized = normalizeResultBindingInput(resultBindingInput(input));
	assertHostReceipt(input.hostReceipt, "result hostReceipt");
	const expectedIdempotencyKey = workflowIntentRedResultIdempotencyKey({
		manifestDigest: normalized.manifestDigest,
		testId: normalized.testId,
		invocationId: normalized.invocationId,
		testDigest: normalized.testDigest,
		recipeDigest: normalized.recipeDigest,
		planRevision: normalized.planRevision,
	});
	if (normalized.idempotencyKey !== expectedIdempotencyKey)
		throw new Error("Workflow RED result idempotency key is not bound to its invocation.");
	const expectedBindingDigest = workflowIntentRedResultBindingDigest(normalized);
	if (input.hostReceipt.bindingDigest !== expectedBindingDigest)
		throw new Error("Workflow RED result host receipt is not bound to its canonical preimage.");
	if (input.hostReceipt.workflowId !== normalized.workflowId)
		throw new Error("Workflow RED result host receipt names a different workflow.");
	const result: WorkflowIntentRedTestResult = {
		...normalized,
		hostReceipt: cloneFrozen(input.hostReceipt),
		resultDigest: "",
	};
	result.resultDigest = workflowIntentRedResultDigest(result);
	return cloneFrozen(result);
}

/**
 * Parse and verify canonical bytes for a complete RED manifest.
 * Args:
 * bytes: Canonical JSON bytes produced by the host artifact writer.
 * Return: Deeply frozen manifest after strict closed-record and digest checks.
 */
export function parseWorkflowIntentRedManifest(bytes: Readonly<Uint8Array>): WorkflowIntentRedManifest {
	const parsed = parseCanonicalJsonBytes(Uint8Array.from(bytes));
	if (!isRecord(parsed)) throw new Error("Workflow RED manifest must be a canonical object.");
	return cloneFrozen(assertCompleteManifest(parsed));
}

/**
 * Parse and verify canonical bytes for a complete RED result.
 * Args:
 * bytes: Canonical JSON bytes produced by the host artifact writer.
 * Return: Deeply frozen result after strict closed-record and digest checks.
 */
export function parseWorkflowIntentRedTestResult(bytes: Readonly<Uint8Array>): WorkflowIntentRedTestResult {
	const parsed = parseCanonicalJsonBytes(Uint8Array.from(bytes));
	if (!isRecord(parsed)) throw new Error("Workflow RED result must be a canonical object.");
	return cloneFrozen(assertCompleteResult(parsed));
}

/**
 * Verify a manifest against the current authenticated host head, epoch, receipt, and artifacts.
 * Args:
 * input: Current host context and candidate manifest.
 * Return: Opaque host-verification token bound to the immutable manifest and its receipt witnesses.
 */
export async function verifyWorkflowIntentRedManifest(
	input: WorkflowIntentRedManifestVerificationInput,
): Promise<WorkflowIntentRedVerifiedManifestToken> {
	const manifest = assertCompleteManifest(input.manifest);
	const hostBinding = normalizeHostBinding(input.hostBinding);
	assertCurrentHeadAndEpoch(manifest.expectedHead, manifest.epochRef, input.currentHead, input.currentEpoch);
	assertVerificationClock(input.currentStateDigest, input.currentRevision, input.trustedNow);
	assertManifestHostBinding(manifest, hostBinding);
	assertHostReceipt(input.authorityReceipt, "RED authority receipt");
	const capabilityBinding = assertRedAuthorityCapabilityBinding(manifest, input.authorityReceipt);
	const artifactEvidenceDigest = workflowIntentRedArtifactEvidenceDigest(manifest);
	const resourceDigest = workflowIntentRedMutationResourceDigest({
		workflowId: manifest.workflowId,
		taskId: manifest.taskId,
		attemptId: manifest.attemptId,
	});
	const operationDigest = workflowIntentRedMutationOperationDigest({
		manifestDigest: manifest.manifestDigest,
		recipeDigest: manifest.recipeDigest,
		planRevision: manifest.planRevision,
		resourceDigest,
	});
	const authorityBindingDigest = workflowIntentRedHostBindingDigest({
		manifestDigest: manifest.manifestDigest,
		hostBinding,
		artifactEvidenceDigest,
		resourceDigest,
		operationDigest,
		executionIdentity: capabilityBinding.executionIdentity,
		sessionId: capabilityBinding.sessionId,
		currentHead: input.currentHead,
		currentEpoch: input.currentEpoch,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
	});
	if (
		input.authorityReceipt.payloadDigest !==
		workflowIntentRedAuthorityPayloadDigest({
			hostBinding,
			artifactEvidenceDigest,
			resourceDigest,
			operationDigest,
			executionIdentity: capabilityBinding.executionIdentity,
			sessionId: capabilityBinding.sessionId,
		})
	)
		throw new Error(
			"RED authority receipt payload is not bound to the host goal, scorecard, boundary registry, and evidence scope.",
		);
	if (input.context.principalAuthorizer === undefined)
		throw new Error("CONTRACT_CHANGE: verified RED authority requires the generic host principalAuthorizer seam.");
	const authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput = {
		receipt: input.authorityReceipt,
		workflowId: input.currentHead.workflowId,
		bindingDigest: authorityBindingDigest,
		resourceDigest,
		operationDigest,
		stateDigest: input.currentStateDigest,
		revision: input.currentRevision,
		epochRef: input.currentEpoch,
		capability: WORKFLOW_INTENT_RED_MUTATION_CAPABILITY,
		...(capabilityBinding.executionIdentity === null
			? {}
			: { executionIdentity: capabilityBinding.executionIdentity }),
		...(capabilityBinding.sessionId === null ? {} : { sessionId: capabilityBinding.sessionId }),
	};
	const principalAuthorization = await input.context.principalAuthorizer.authorize(authorizationInput);
	assertPrincipalAuthorization(principalAuthorization, authorizationInput);
	/*
	 * The capability authorizer authenticates the host-owned receipt; the receipt
	 * resolver below records the one-use witness in the existing durable store.
	 */
	for (const ref of manifest.evidenceRefs) await verifyArtifact(input.context, ref, "manifest evidence");
	for (const item of manifest.durabilityEvidence) {
		await verifyArtifact(input.context, item.artifactRef, `${item.kind} durability`);
		assertFreshEvidence(item.observedAt, item.freshUntil, input.trustedNow, `${item.kind} durability`);
	}
	for (const test of manifest.tests) {
		const commandBytes = await verifyArtifact(input.context, test.commandArtifactRef, "command");
		const sourceBytes = await verifyArtifact(input.context, test.sourceArtifactRef, "source");
		assertPublicEvidenceBytes(commandBytes, "command");
		assertPublicEvidenceBytes(sourceBytes, "source");
		for (const ref of test.hostScanEvidenceRefs) {
			const bytes = await verifyArtifact(input.context, ref, "public-boundary scan");
			assertPublicEvidenceBytes(bytes, "public-boundary scan");
		}
	}
	const receiptWitness = await verifyAndConsumeReceipt({
		context: input.context,
		workflowId: input.currentHead.workflowId,
		expectedBindingDigest: workflowIntentRedManifestBindingDigest(manifestBindingInput(manifest)),
		receipt: manifest.hostReceipt,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
	});
	const authorityWitness = await verifyAndConsumeReceipt({
		context: input.context,
		workflowId: input.currentHead.workflowId,
		expectedBindingDigest: authorityBindingDigest,
		receipt: input.authorityReceipt,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
	});
	const token = Object.freeze({ [verifiedManifestTokenBrand]: true }) as WorkflowIntentRedVerifiedManifestToken;
	verifiedManifestTokenData.set(token, {
		manifest: cloneFrozen(manifest),
		hostBinding: cloneFrozen(hostBinding),
		currentHead: cloneFrozen(input.currentHead),
		currentEpoch: cloneFrozen(input.currentEpoch),
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
		receiptWitness,
		authorityWitness,
		authorityBindingDigest,
		principalAuthorization: cloneFrozen(principalAuthorization),
		context: input.context,
	});
	return token;
}

/**
 * Verify a result against its manifest, current host head, epoch, receipt, and evidence artifacts.
 * Args:
 * input: Current host context and candidate result.
 * Return: Opaque host-verification token bound to the result and its manifest token.
 */
export async function verifyWorkflowIntentRedTestResult(
	input: WorkflowIntentRedTestResultVerificationInput,
): Promise<WorkflowIntentRedVerifiedResultToken> {
	const manifestTokenData = getManifestTokenData(input.manifestToken);
	const manifest = manifestTokenData.manifest;
	const hostBinding = normalizeHostBinding(input.hostBinding);
	const result = assertCompleteResult(input.result);
	assertVerificationContextMatches(manifestTokenData, input, hostBinding);
	if (
		result.workflowId !== manifest.workflowId ||
		result.taskId !== manifest.taskId ||
		result.attemptId !== manifest.attemptId ||
		result.manifestDigest !== manifest.manifestDigest ||
		result.expectedHeadDigest !== manifest.expectedHeadDigest ||
		digestObject(result.epochRef) !== digestObject(manifest.epochRef)
	)
		throw new Error("Workflow RED result is bound to a different manifest, task, attempt, head, or epoch.");
	assertCurrentHeadAndEpoch(manifest.expectedHead, manifest.epochRef, input.currentHead, input.currentEpoch);
	if (result.runtimeMode !== "true_runtime")
		throw new Error("Worker-free shell RED results cannot authorize production mutation.");
	const test = manifest.tests.find((candidate) => candidate.testId === result.testId);
	if (test === undefined) throw new Error("Workflow RED result names a test absent from the immutable manifest.");
	if (
		result.recipeDigest !== manifest.recipeDigest ||
		result.planRevision !== manifest.planRevision ||
		result.testDigest !== test.testDigest
	)
		throw new Error("Workflow RED result recipe, plan, or test definition is not bound to the manifest.");
	if (result.exitCode !== test.expectedExitCode || result.timedOut)
		throw new Error("Workflow RED result did not observe the manifest's bounded command failure.");
	assertResultAssertions(result, test);
	if (result.classification === "assertion_failure") {
		if (result.passed || result.failedAssertions.length === 0)
			throw new Error("Workflow RED assertion failure must be an observed, unpassed outcome failure.");
	} else if (result.failedAssertions.length !== 0) {
		throw new Error("Setup, test, and infrastructure errors cannot claim outcome-linked assertion failures.");
	}
	if (
		!result.processEvidenceRefs.some((ref) => digestObject(ref) === digestObject(result.processEvidence.artifactRef))
	)
		throw new Error("RED result process evidence omits its declared process artifact.");
	assertProcessEvidence(result.processEvidence, test, input.trustedNow);
	const resultEvidenceRefs = [
		result.startBoundaryRef,
		result.endBoundaryRef,
		...result.processEvidenceRefs,
		result.stdoutArtifactRef,
		result.stderrArtifactRef,
		...result.evidenceRefs,
	];
	for (const ref of resultEvidenceRefs) await verifyArtifact(input.context, ref, "result evidence");
	const receiptWitness = await verifyAndConsumeReceipt({
		context: input.context,
		workflowId: input.currentHead.workflowId,
		expectedBindingDigest: workflowIntentRedResultBindingDigest(resultBindingInput(result)),
		receipt: result.hostReceipt,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
	});
	const token = Object.freeze({ [verifiedResultTokenBrand]: true }) as WorkflowIntentRedVerifiedResultToken;
	verifiedResultTokenData.set(token, {
		manifestToken: input.manifestToken,
		manifest: cloneFrozen(manifest),
		result: cloneFrozen(result),
		hostBinding: cloneFrozen(hostBinding),
		currentHead: cloneFrozen(input.currentHead),
		currentEpoch: cloneFrozen(input.currentEpoch),
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
		receiptWitness,
	});
	return token;
}

/**
 * Decide whether verified RED results authorize a production mutation.
 * Args:
 * input: Opaque manifest and result tokens produced by host verification.
 * Return: Explicit authorization and its evidence digest; diagnostics alone never authorize.
 */
export async function authorizeWorkflowIntentRedProductionMutation(
	input: WorkflowIntentRedMutationAuthorizationInput,
): Promise<WorkflowIntentRedMutationAuthorization> {
	const manifestTokenData = getManifestTokenData(input.manifestToken);
	if (consumedManifestTokens.has(input.manifestToken as object))
		throw new Error("Workflow RED manifest verification token was already consumed.");
	if (input.resultTokens.length === 0) throw new Error("Workflow RED mutation requires verified result tokens.");
	assertCanonicalArray(input.resultTokens, "verified RED result tokens");
	if (new Set(input.resultTokens).size !== input.resultTokens.length)
		throw new Error("Workflow RED mutation result tokens must be unique one-use proofs.");
	assertVerificationClock(input.currentStateDigest, input.currentRevision, input.trustedNow);
	const currentTupleMatches =
		digestObject(manifestTokenData.currentHead) === digestObject(input.currentHead) &&
		digestObject(manifestTokenData.currentEpoch) === digestObject(input.currentEpoch) &&
		manifestTokenData.currentStateDigest === input.currentStateDigest &&
		manifestTokenData.currentRevision === input.currentRevision &&
		manifestTokenData.trustedNow === input.trustedNow;
	const scope = normalizeMutationScope(input.scope);
	const expectedResourceDigest = workflowIntentRedMutationResourceDigest({
		workflowId: manifestTokenData.manifest.workflowId,
		taskId: manifestTokenData.manifest.taskId,
		attemptId: manifestTokenData.manifest.attemptId,
	});
	const expectedOperationDigest = workflowIntentRedMutationOperationDigest({
		manifestDigest: manifestTokenData.manifest.manifestDigest,
		recipeDigest: manifestTokenData.manifest.recipeDigest,
		planRevision: manifestTokenData.manifest.planRevision,
		resourceDigest: expectedResourceDigest,
	});
	const expectedScope: WorkflowIntentRedMutationScope = {
		operationDigest: expectedOperationDigest,
		resourceDigest: expectedResourceDigest,
		effectDigest: manifestTokenData.hostBinding.effectDigest,
		affectedProductionSurface: manifestTokenData.hostBinding.affectedProductionSurface,
		writeSet: manifestTokenData.hostBinding.writeSet,
		closureRationale: manifestTokenData.hostBinding.closureRationale,
	};
	if (digestObject(scope) !== digestObject(expectedScope))
		throw new Error("Workflow RED mutation scope is broader than the still-current authorized invariant.");
	const resultData = input.resultTokens.map((token) => ({ token, data: getResultTokenData(token) }));
	for (const { token, data } of resultData) {
		if (consumedResultTokens.has(token as object))
			throw new Error("Workflow RED result verification token was already consumed.");
		if (data.manifestToken !== input.manifestToken)
			throw new Error("Workflow RED result token is bound to a different verified manifest token.");
	}
	const durableAuthorityWitness = await manifestTokenData.context.receiptResolver.resolveConsumptionWitness({
		receiptId: manifestTokenData.principalAuthorization.receipt.receiptId,
		workflowId: manifestTokenData.manifest.workflowId,
		expectedBindingDigest: manifestTokenData.authorityBindingDigest,
	});
	if (digestObject(durableAuthorityWitness) !== digestObject(manifestTokenData.authorityWitness))
		throw new Error("Workflow RED authority witness changed or is not durably replayable.");
	const valid = resultData.some(({ data: { result, manifest } }) => {
		const test = manifest.tests.find((item) => item.testId === result.testId);
		return (
			test !== undefined &&
			test.evidenceClassification === "acceptance" &&
			result.classification === "assertion_failure" &&
			!result.passed &&
			!result.timedOut &&
			result.exitCode === test.expectedExitCode &&
			result.failedAssertions.length > 0
		);
	});
	consumedManifestTokens.add(input.manifestToken as object);
	for (const token of input.resultTokens) consumedResultTokens.add(token as object);
	const postEffect = !currentTupleMatches;
	return cloneFrozen({
		authorized: valid && !postEffect,
		reason: postEffect
			? "post_effect"
			: valid
				? "outcome_linked_assertion_failure"
				: "no_outcome_linked_assertion_failure",
		manifestDigest: manifestTokenData.manifest.manifestDigest,
		goalDigest: manifestTokenData.hostBinding.goalDigest,
		scorecardDigest: manifestTokenData.hostBinding.scorecardDigest,
		publicBoundaryRegistryDigest: manifestTokenData.hostBinding.publicBoundaryRegistryDigest,
		publicBoundaryRegistry: cloneFrozen(manifestTokenData.hostBinding.publicBoundaryRegistry),
		allowedSemanticBehaviorSurface: cloneFrozen(
			[...new Set(manifestTokenData.hostBinding.publicBoundaryRegistry.map((entry) => entry.publicBoundary))].sort(),
		),
		operationDigest: scope.operationDigest,
		resourceDigest: scope.resourceDigest,
		affectedProductionSurface: cloneFrozen(manifestTokenData.hostBinding.affectedProductionSurface),
		writeSet: cloneFrozen(manifestTokenData.hostBinding.writeSet),
		normalizedWriteClosure: cloneFrozen(manifestTokenData.hostBinding.writeSet),
		closureRationale: manifestTokenData.hostBinding.closureRationale,
		authorizationDigest: manifestTokenData.principalAuthorization.authorizationDigest,
		authorityWitness: cloneFrozen(durableAuthorityWitness),
		effectDigest: scope.effectDigest,
		executionIdentity: manifestTokenData.principalAuthorization.executionIdentity ?? null,
		sessionId: manifestTokenData.principalAuthorization.sessionId ?? null,
		productionBaseHead: cloneFrozen(manifestTokenData.currentHead),
		productionBaseHeadDigest: digestObject(manifestTokenData.currentHead),
		baseProductionHead: cloneFrozen(manifestTokenData.currentHead),
		baseProductionHeadDigest: digestObject(manifestTokenData.currentHead),
		productionBaseEpoch: cloneFrozen(manifestTokenData.currentEpoch),
		baseProductionEpoch: cloneFrozen(manifestTokenData.currentEpoch),
		productionBaseStateDigest: manifestTokenData.currentStateDigest,
		baseProductionStateDigest: manifestTokenData.currentStateDigest,
		productionBaseRevision: manifestTokenData.currentRevision,
		baseProductionRevision: manifestTokenData.currentRevision,
		lastAdmissibleProductionHead: cloneFrozen(manifestTokenData.currentHead),
		lastAdmissibleProductionHeadDigest: digestObject(manifestTokenData.currentHead),
		quarantine: postEffect
			? {
					reason: "post_effect",
					lastAdmissibleProductionHeadDigest: digestObject(manifestTokenData.currentHead),
				}
			: { reason: "none" },
		evidenceDigest: digestObject({
			manifestDigest: manifestTokenData.manifest.manifestDigest,
			resultDigests: resultData.map(({ data: { result } }) => result.resultDigest),
			scope,
			authorizationDigest: manifestTokenData.principalAuthorization.authorizationDigest,
		}),
	});
}

/**
 * Replay one immutable result through an idempotency boundary without storing a second journal.
 * Args:
 * input: Existing durable result, if any, and the incoming replay candidate.
 * Return: New or already-committed status; conflicting same-key bytes throw.
 */
export function replayWorkflowIntentRedTestResult(
	input: WorkflowIntentRedTestResultReplayInput,
): WorkflowIntentRedTestResultReplay {
	const incoming = assertCompleteResult(input.incoming);
	if (input.persisted === null) return { status: "new", result: cloneFrozen(incoming) };
	const persisted = assertCompleteResult(input.persisted);
	if (persisted.idempotencyKey !== incoming.idempotencyKey)
		throw new Error("Workflow RED result replay has a different idempotency key.");
	if (persisted.resultDigest !== incoming.resultDigest)
		throw new Error("Workflow RED result replay conflicts with the immutable committed digest.");
	return { status: "already_committed", result: cloneFrozen(persisted) };
}

/**
 * Build the exact existing-journal seam payload for a manifest publication.
 * Args:
 * manifest: Verified immutable manifest.
 * manifestArtifactRef: Existing workflow artifact reference carrying the manifest bytes.
 * Return: Closed payload; persistence remains the existing host journal's responsibility.
 */
export async function workflowIntentRedManifestEventPayload(
	input: WorkflowIntentRedManifestEventPayloadInput,
): Promise<WorkflowIntentRedManifestEventPayload> {
	const verified = assertCompleteManifest(input.manifest);
	assertArtifactRef(input.manifestArtifactRef, "manifestArtifactRef");
	await verifyExactArtifactBytes(
		input.artifactResolver,
		input.manifestArtifactRef,
		canonicalJsonBytes(verified),
		"manifest",
	);
	return cloneFrozen({
		kind: "workflow_red_test_manifest_published",
		workflowId: verified.workflowId,
		taskId: verified.taskId,
		attemptId: verified.attemptId,
		expectedHead: verified.expectedHead,
		epochRef: verified.epochRef,
		manifestDigest: verified.manifestDigest,
		manifestArtifactRef: input.manifestArtifactRef,
		idempotencyKey: verified.idempotencyKey,
		hostReceipt: verified.hostReceipt,
	});
}

/**
 * Build the exact existing-journal seam payload for a result recording.
 * Args:
 * result: Verified immutable result.
 * resultArtifactRef: Existing workflow artifact reference carrying result bytes.
 * Return: Closed payload; persistence remains the existing host journal's responsibility.
 */
export async function workflowIntentRedResultEventPayload(
	input: WorkflowIntentRedResultEventPayloadInput,
): Promise<WorkflowIntentRedTestResultEventPayload> {
	const verified = assertCompleteResult(input.result);
	assertArtifactRef(input.resultArtifactRef, "resultArtifactRef");
	await verifyExactArtifactBytes(
		input.artifactResolver,
		input.resultArtifactRef,
		canonicalJsonBytes(verified),
		"result",
	);
	return cloneFrozen({
		kind: "workflow_red_test_result_recorded",
		workflowId: verified.workflowId,
		taskId: verified.taskId,
		attemptId: verified.attemptId,
		manifestDigest: verified.manifestDigest,
		testId: verified.testId,
		invocationId: verified.invocationId,
		resultDigest: verified.resultDigest,
		resultArtifactRef: input.resultArtifactRef,
		hostReceipt: verified.hostReceipt,
	});
}

export type WorkflowRedTestCase = WorkflowIntentRedTestCase;
export type WorkflowRedTestManifest = WorkflowIntentRedManifest;
export type WorkflowRedTestResult = WorkflowIntentRedTestResult;
export type WorkflowRedAssertion = WorkflowIntentRedAssertion;
export type WorkflowRedAssertionFailure = WorkflowIntentRedAssertionFailure;
export type WorkflowRedTestManifestEventPayload = WorkflowIntentRedManifestEventPayload;
export type WorkflowRedTestResultEventPayload = WorkflowIntentRedTestResultEventPayload;
export const createWorkflowRedTestManifest = createWorkflowIntentRedManifest;
export const createWorkflowRedTestResult = createWorkflowIntentRedTestResult;
export const parseWorkflowRedTestManifest = parseWorkflowIntentRedManifest;
export const parseWorkflowRedTestResult = parseWorkflowIntentRedTestResult;
export const verifyWorkflowRedTestManifest = verifyWorkflowIntentRedManifest;
export const verifyWorkflowRedTestResult = verifyWorkflowIntentRedTestResult;
export const createIntentRedManifest = createWorkflowIntentRedManifest;
export const createIntentRedTestResult = createWorkflowIntentRedTestResult;
export const parseIntentRedManifest = parseWorkflowIntentRedManifest;
export const parseIntentRedTestResult = parseWorkflowIntentRedTestResult;
export const verifyIntentRedManifest = verifyWorkflowIntentRedManifest;
export const verifyIntentRedTestResult = verifyWorkflowIntentRedTestResult;
export const authorizeIntentRedProductionMutation = authorizeWorkflowIntentRedProductionMutation;

/**
 * Create one host-classified Intent TDD slice from a valid public-outcome RED.
 * Args:
 * input: Base manifest, declared outcome boundary, production closure, bounded probes, and metrics.
 * Return: Frozen slice whose field probes share one progress and one authority unit.
 */
export function createWorkflowIntentRedIntentSlice(
	input: WorkflowIntentRedIntentSliceInput,
): WorkflowIntentRedIntentSlice {
	const normalized = normalizeIntentRedIntentSliceInput(input);
	const slice: WorkflowIntentRedIntentSlice = {
		schemaId: WORKFLOW_INTENT_RED_SLICE_SCHEMA_ID,
		schemaVersion: 1,
		classification: "coherent_intent_slice",
		requiresFreshRed: false,
		manifest: normalized.manifest,
		baseManifestDigest: normalized.baseManifestDigest,
		baseRedTestId: normalized.baseRedTestId,
		userOutcomeId: normalized.userOutcomeId,
		publicBoundary: normalized.publicBoundary,
		forbiddenOutcomeId: normalized.forbiddenOutcomeId,
		allowedProductionClosure: normalized.allowedProductionClosure,
		proposals: normalized.proposals,
		schemaFieldVariants: normalized.schemaFieldVariants,
		mutationCases: normalized.mutationCases,
		metrics: normalized.metrics,
		authorityUnitCount: 1,
		progressUnitCount: 1,
		scopeTokenPolicy: { oneUse: true, nonRetroactive: true },
		sliceDigest: "",
	};
	slice.sliceDigest = workflowIntentRedIntentSliceDigest(slice);
	if (input.sliceDigest !== undefined && input.sliceDigest !== slice.sliceDigest)
		throw new Error("Workflow RED intent slice digest is forged or stale.");
	return cloneFrozen(slice);
}

/**
 * Classify a planner proposal without turning a fresh invariant into implicit authority.
 * Args:
 * input: Candidate Intent TDD slice input.
 * Return: Coherent slice or an explicit fresh-RED requirement.
 */
export function classifyWorkflowIntentRedIntentSlice(
	input: WorkflowIntentRedIntentSliceInput,
): WorkflowIntentRedIntentSliceClassification {
	try {
		return {
			classification: "coherent_intent_slice",
			requiresFreshRed: false,
			reason: null,
			slice: createWorkflowIntentRedIntentSlice(input),
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/fresh RED/iu.test(message)) throw error;
		return {
			classification: "fresh_red_required",
			requiresFreshRed: true,
			reason: message,
			slice: null,
		};
	}
}

/**
 * Compute the immutable digest for a normalized Intent TDD slice.
 * Args:
 * slice: Frozen or parsed slice record.
 * Return: Canonical SHA-256 digest with the derived digest field blanked.
 */
export function workflowIntentRedIntentSliceDigest(slice: WorkflowIntentRedIntentSlice): string {
	const { sliceDigest: _sliceDigest, ...preimage } = slice;
	return digestObject({ kind: WORKFLOW_INTENT_RED_SLICE_SCHEMA_ID, ...preimage });
}

export const createWorkflowIntentRedMutationMatrix = createWorkflowIntentRedIntentSlice;
export const classifyWorkflowIntentRedMutationMatrix = classifyWorkflowIntentRedIntentSlice;
export const workflowIntentRedMutationMatrixDigest = workflowIntentRedIntentSliceDigest;
export const createIntentRedIntentSlice = createWorkflowIntentRedIntentSlice;
export const classifyIntentRedIntentSlice = classifyWorkflowIntentRedIntentSlice;

type WorkflowIntentRedNormalizedIntentSliceInput = Omit<
	WorkflowIntentRedIntentSlice,
	| "schemaId"
	| "schemaVersion"
	| "classification"
	| "requiresFreshRed"
	| "authorityUnitCount"
	| "progressUnitCount"
	| "scopeTokenPolicy"
	| "sliceDigest"
>;

function normalizeIntentRedIntentSliceInput(
	input: WorkflowIntentRedIntentSliceInput,
): WorkflowIntentRedNormalizedIntentSliceInput {
	if (!isRecord(input)) throw new Error("Workflow RED intent slice must be an object.");
	const manifest = assertCompleteManifest(input.manifest);
	assertIdentifier(input.userOutcomeId, "RED intent slice userOutcomeId");
	assertPublicBoundary(input.publicBoundary, "RED intent slice publicBoundary");
	assertIdentifier(input.forbiddenOutcomeId, "RED intent slice forbiddenOutcomeId");
	assertIdentifier(input.baseRedTestId, "RED intent slice baseRedTestId");
	const test = manifest.tests.find((candidate) => candidate.testId === input.baseRedTestId);
	if (test === undefined) throw new Error("Workflow RED intent slice base RED test is absent from the manifest.");
	if (test.evidenceClassification !== "acceptance")
		throw new Error("Workflow RED intent slice requires an acceptance RED, not a debug probe.");
	if (test.publicBoundary !== input.publicBoundary)
		throw new Error("Workflow RED intent slice requires fresh RED for a new public boundary.");
	if (
		!test.assertions.some(
			(assertion) =>
				assertion.target === "user_outcome" &&
				assertion.outcomeId === input.userOutcomeId &&
				assertion.publicBoundary === input.publicBoundary,
		)
	)
		throw new Error(
			test.assertions.some((assertion) => assertion.target === "user_outcome")
				? "Workflow RED intent slice requires fresh RED for a new user-visible outcome."
				: "Workflow RED intent slice requires a valid public user outcome RED.",
		);
	if (
		!test.assertions.some(
			(assertion) =>
				assertion.target === "forbidden_outcome" &&
				assertion.outcomeId === input.forbiddenOutcomeId &&
				assertion.publicBoundary === input.publicBoundary,
		)
	)
		throw new Error(
			test.assertions.some((assertion) => assertion.target === "forbidden_outcome")
				? "Workflow RED intent slice requires fresh RED for a new forbidden outcome."
				: "Workflow RED intent slice requires a protected forbidden outcome.",
		);

	const closure = normalizeIntentRedAllowedProductionClosure(input.allowedProductionClosure, manifest);
	const hostBinding =
		input.hostBinding !== undefined
			? normalizeHostBinding(input.hostBinding)
			: hasHostBindingRegistry(input.allowedProductionClosure)
				? normalizeHostBinding(input.allowedProductionClosure)
				: null;
	if (hostBinding !== null) {
		assertManifestHostBinding(manifest, hostBinding);
		if (!registryHas(hostBinding, input.publicBoundary, "user_outcome", input.userOutcomeId))
			throw new Error("Workflow RED intent slice user outcome is not host-declared.");
		if (!registryHas(hostBinding, input.publicBoundary, "forbidden_outcome", input.forbiddenOutcomeId))
			throw new Error("Workflow RED intent slice forbidden outcome is not host-declared.");
		if (
			hostBinding.effectDigest !== closure.effectDigest ||
			digestObject(hostBinding.writeSet) !== digestObject(closure.writeSet) ||
			digestObject(hostBinding.affectedProductionSurface) !== digestObject(closure.affectedProductionSurface) ||
			hostBinding.closureRationale !== closure.closureRationale
		)
			throw new Error("Workflow RED intent slice requires fresh RED for a new production closure.");
	}

	const proposals = normalizeIntentRedSliceProposals(input.proposals, input.userOutcomeId, input.forbiddenOutcomeId);
	const mutationCases = normalizeIntentRedSliceMutationCases(input.mutationCases);
	const evidenceCount =
		proposals.reduce((count, proposal) => count + proposal.evidenceRefs.length, 0) +
		mutationCases.reduce((count, mutationCase) => count + mutationCase.evidenceRefs.length, 0);
	const falsifiableOutcomeIds = new Set(proposals.flatMap((proposal) => proposal.falsifiableOutcomeIds));
	const metricsInput = input.metrics;
	if (!isRecord(metricsInput)) throw new Error("Workflow RED intent slice metrics must be an object.");
	if (!Number.isSafeInteger(metricsInput.falsifiableOutcomeCount) || metricsInput.falsifiableOutcomeCount < 1)
		throw new Error("Workflow RED intent slice falsifiable outcome count must be positive.");
	if (!Number.isSafeInteger(metricsInput.evidenceCount) || metricsInput.evidenceCount < 1)
		throw new Error("Workflow RED intent slice evidence count must be positive.");
	if (!Number.isSafeInteger(metricsInput.wallTimeMilliseconds) || metricsInput.wallTimeMilliseconds < 1)
		throw new Error("Workflow RED intent slice wall time must be positive.");
	if (metricsInput.falsifiableOutcomeCount !== falsifiableOutcomeIds.size)
		throw new Error("Workflow RED intent slice falsifiable outcome metric is not evidence-bound.");
	if (metricsInput.evidenceCount !== evidenceCount)
		throw new Error("Workflow RED intent slice evidence metric is not evidence-bound.");
	if (proposals.length > metricsInput.falsifiableOutcomeCount + metricsInput.evidenceCount)
		throw new Error("Workflow RED intent slice rejects easy-field farming without new falsifiable evidence.");
	const metrics: WorkflowIntentRedSliceMetrics = {
		falsifiableOutcomeCount: metricsInput.falsifiableOutcomeCount,
		evidenceCount: metricsInput.evidenceCount,
		wallTimeMilliseconds: metricsInput.wallTimeMilliseconds,
		outcomesPerWallTime: metricsInput.falsifiableOutcomeCount / metricsInput.wallTimeMilliseconds,
		evidencePerWallTime: metricsInput.evidenceCount / metricsInput.wallTimeMilliseconds,
	};
	const proposalsByField = new Set(proposals.map((proposal) => proposal.schemaField));
	if (proposalsByField.size !== proposals.length)
		throw new Error("Workflow RED intent slice schema-field variants must be grouped once per field.");
	return {
		manifest,
		baseManifestDigest: manifest.manifestDigest,
		baseRedTestId: input.baseRedTestId,
		userOutcomeId: input.userOutcomeId,
		publicBoundary: input.publicBoundary,
		forbiddenOutcomeId: input.forbiddenOutcomeId,
		allowedProductionClosure: closure,
		proposals,
		schemaFieldVariants: [...proposalsByField].sort(),
		mutationCases,
		metrics,
	};
}

function hasHostBindingRegistry(
	value: WorkflowIntentRedAllowedProductionClosure | WorkflowIntentRedHostBinding,
): value is WorkflowIntentRedHostBinding {
	return isRecord(value) && "publicBoundaryRegistry" in value;
}

function normalizeIntentRedAllowedProductionClosure(
	value: WorkflowIntentRedAllowedProductionClosure | WorkflowIntentRedHostBinding,
	manifest: WorkflowIntentRedManifest,
): WorkflowIntentRedAllowedProductionClosure {
	if (!isRecord(value)) throw new Error("Workflow RED intent slice production closure must be an object.");
	assertDigest(value.effectDigest, "RED intent slice closure effectDigest");
	assertCanonicalArray(value.affectedProductionSurface, "RED intent slice affected production surface");
	assertCanonicalArray(value.writeSet, "RED intent slice write set");
	assertClosureRationale(value.closureRationale);
	const affectedProductionSurface = normalizeProductionPathSet(
		value.affectedProductionSurface,
		"RED intent slice affected production surface",
	);
	const writeSet = normalizeProductionPathSet(value.writeSet, "RED intent slice write set");
	const resourceDigest = workflowIntentRedMutationResourceDigest({
		workflowId: manifest.workflowId,
		taskId: manifest.taskId,
		attemptId: manifest.attemptId,
	});
	const expectedEffectDigest = workflowIntentRedMutationEffectDigest({
		resourceDigest,
		affectedProductionSurface,
		writeSet,
		closureRationale: value.closureRationale,
	});
	if (value.effectDigest !== expectedEffectDigest)
		throw new Error("Workflow RED intent slice production closure is not bound to the manifest resource.");
	return {
		effectDigest: value.effectDigest,
		affectedProductionSurface,
		writeSet,
		closureRationale: value.closureRationale,
	};
}

function normalizeIntentRedSliceProposals(
	value: readonly WorkflowIntentRedSliceProposal[],
	userOutcomeId: string,
	forbiddenOutcomeId: string,
): readonly WorkflowIntentRedSliceProposal[] {
	assertCanonicalArray(value, "RED intent slice proposals");
	if (value.length === 0) throw new Error("Workflow RED intent slice requires schema-field variants.");
	const proposalIds = new Set<string>();
	return value.map((proposal) => {
		assertClosedRecord(
			proposal,
			["proposalId", "schemaField", "evidenceRefs", "falsifiableOutcomeIds", "wallTimeMilliseconds"],
			"RED intent slice proposal",
		);
		assertIdentifier(proposal.proposalId, "RED intent slice proposalId");
		assertIdentifier(proposal.schemaField, "RED intent slice schemaField");
		if (proposalIds.has(proposal.proposalId))
			throw new Error("Workflow RED intent slice proposal IDs must be unique.");
		proposalIds.add(proposal.proposalId);
		assertCanonicalArray(proposal.evidenceRefs, "RED intent slice proposal evidenceRefs");
		if (proposal.evidenceRefs.length === 0)
			throw new Error("Workflow RED intent slice proposal requires public evidence.");
		const evidenceRefs = proposal.evidenceRefs.map((ref) =>
			normalizeArtifactRef(ref, "RED intent slice proposal evidence"),
		);
		assertCanonicalArray(proposal.falsifiableOutcomeIds, "RED intent slice proposal outcomes");
		const outcomes = [...new Set(proposal.falsifiableOutcomeIds)];
		for (const outcomeId of outcomes) assertIdentifier(outcomeId, "RED intent slice proposal outcomeId");
		if (!outcomes.includes(userOutcomeId) || !outcomes.includes(forbiddenOutcomeId))
			throw new Error(
				"Workflow RED intent slice variants must provide falsifiable evidence for both the user and forbidden outcomes.",
			);
		if (outcomes.some((outcomeId, index) => outcomeId !== [...outcomes].sort()[index]))
			throw new Error("Workflow RED intent slice proposal outcomes must be canonically ordered.");
		if (!Number.isSafeInteger(proposal.wallTimeMilliseconds) || proposal.wallTimeMilliseconds < 1)
			throw new Error("Workflow RED intent slice proposal wall time must be positive.");
		return {
			proposalId: proposal.proposalId,
			schemaField: proposal.schemaField,
			evidenceRefs,
			falsifiableOutcomeIds: outcomes,
			wallTimeMilliseconds: proposal.wallTimeMilliseconds,
		};
	});
}

function normalizeIntentRedSliceMutationCases(
	value: readonly WorkflowIntentRedSliceMutationCaseDraft[],
): readonly WorkflowIntentRedSliceMutationCase[] {
	assertCanonicalArray(value, "RED intent slice mutation cases");
	const expectedKinds: readonly WorkflowIntentRedSliceMutationCaseKind[] = [
		"restart_identical_reconstruction",
		"stale_approval",
		"overbroad_approval",
		"concurrent_duplicate_exactly_once",
		"read_only_status",
	];
	if (value.length !== expectedKinds.length)
		throw new Error("Workflow RED intent slice requires exactly five bounded mutation cases.");
	const seenKinds = new Set<WorkflowIntentRedSliceMutationCaseKind>();
	const seenIds = new Set<string>();
	const expectedAuthorization: Record<
		WorkflowIntentRedSliceMutationCaseKind,
		WorkflowIntentRedSliceExpectedAuthorization
	> = {
		restart_identical_reconstruction: "reconstruct_identical",
		stale_approval: "deny_stale",
		overbroad_approval: "deny_overbroad",
		concurrent_duplicate_exactly_once: "exactly_once",
		read_only_status: "read_only",
	};
	const normalized = value.map((mutationCase) => {
		const hasNormalizedFields =
			isRecord(mutationCase) &&
			("expectedAuthorization" in mutationCase ||
				"authorityExpansion" in mutationCase ||
				"progressExpansion" in mutationCase);
		assertClosedRecord(
			mutationCase,
			hasNormalizedFields
				? ["caseId", "kind", "evidenceRefs", "expectedAuthorization", "authorityExpansion", "progressExpansion"]
				: ["caseId", "kind", "evidenceRefs"],
			"RED intent slice mutation case",
		);
		assertIdentifier(mutationCase.caseId, "RED intent slice caseId");
		if (seenIds.has(mutationCase.caseId)) throw new Error("Workflow RED intent slice case IDs must be unique.");
		seenIds.add(mutationCase.caseId);
		if (!expectedKinds.includes(mutationCase.kind))
			throw new Error("Workflow RED intent slice mutation case kind is not bounded.");
		if (seenKinds.has(mutationCase.kind))
			throw new Error("Workflow RED intent slice mutation case kinds must be unique.");
		seenKinds.add(mutationCase.kind);
		assertCanonicalArray(mutationCase.evidenceRefs, "RED intent slice mutation case evidenceRefs");
		if (mutationCase.evidenceRefs.length === 0)
			throw new Error("Workflow RED intent slice mutation case requires public evidence.");
		if (
			hasNormalizedFields &&
			(mutationCase.expectedAuthorization !== expectedAuthorization[mutationCase.kind] ||
				mutationCase.authorityExpansion !== false ||
				mutationCase.progressExpansion !== false)
		)
			throw new Error("Workflow RED intent slice mutation case expands authority or progress.");
		return {
			caseId: mutationCase.caseId,
			kind: mutationCase.kind,
			evidenceRefs: mutationCase.evidenceRefs.map((ref) =>
				normalizeArtifactRef(ref, "RED intent slice mutation case evidence"),
			),
			expectedAuthorization: expectedAuthorization[mutationCase.kind],
			authorityExpansion: false as const,
			progressExpansion: false as const,
		};
	});
	if (seenKinds.size !== expectedKinds.length)
		throw new Error("Workflow RED intent slice omitted a bounded mutation case.");
	return [...normalized].sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));
}

function normalizeHostBinding(input: WorkflowIntentRedHostBinding): WorkflowIntentRedHostBinding {
	assertClosedRecord(
		input,
		[
			"goalDigest",
			"scorecardDigest",
			"publicBoundaryRegistryDigest",
			"publicBoundaryRegistry",
			"effectDigest",
			"affectedProductionSurface",
			"writeSet",
			"closureRationale",
		],
		"RED host binding",
	);
	assertDigest(input.goalDigest, "RED host goalDigest");
	assertDigest(input.scorecardDigest, "RED host scorecardDigest");
	assertDigest(input.publicBoundaryRegistryDigest, "RED host publicBoundaryRegistryDigest");
	assertDigest(input.effectDigest, "RED host effectDigest");
	assertCanonicalArray(input.publicBoundaryRegistry, "RED public-boundary registry");
	const affectedProductionSurface = normalizeProductionPathSet(
		input.affectedProductionSurface,
		"RED affected production surface",
	);
	const writeSet = normalizeProductionPathSet(input.writeSet, "RED production write set");
	assertClosureRationale(input.closureRationale);
	if (input.publicBoundaryRegistry.length === 0)
		throw new Error("RED host binding requires a public-boundary registry.");
	const entries = input.publicBoundaryRegistry.map((entry) => {
		assertClosedRecord(entry, ["publicBoundary", "target", "outcomeIds"], "RED public-boundary registry entry");
		assertPublicBoundary(entry.publicBoundary, "RED registry publicBoundary");
		if (entry.target !== "user_outcome" && entry.target !== "forbidden_outcome")
			throw new Error("RED registry target is not canonical.");
		assertCanonicalArray(entry.outcomeIds, "RED registry outcome IDs");
		if (entry.outcomeIds.length === 0) throw new Error("RED registry entry requires an outcome ID.");
		for (const outcomeId of entry.outcomeIds) assertIdentifier(outcomeId, "RED registry outcomeId");
		if (new Set(entry.outcomeIds).size !== entry.outcomeIds.length)
			throw new Error("RED registry outcome IDs must be unique.");
		if (entry.outcomeIds.some((value, index) => value !== [...entry.outcomeIds].sort()[index]))
			throw new Error("RED registry outcome IDs must be canonically ordered.");
		return {
			publicBoundary: entry.publicBoundary,
			target: entry.target,
			outcomeIds: [...entry.outcomeIds],
		};
	});
	const registryKeys = entries.map((entry) => `${entry.publicBoundary}\u0000${entry.target}`);
	if (new Set(registryKeys).size !== registryKeys.length)
		throw new Error("RED public-boundary registry entries must be unique.");
	const ordered = [...entries].sort((left, right) =>
		`${left.publicBoundary}\u0000${left.target}` < `${right.publicBoundary}\u0000${right.target}` ? -1 : 1,
	);
	if (entries.some((entry, index) => digestObject(entry) !== digestObject(ordered[index])))
		throw new Error("RED public-boundary registry entries must be canonically ordered.");
	if (digestObject(entries) !== input.publicBoundaryRegistryDigest)
		throw new Error("RED public-boundary registry digest is not host-bound.");
	return {
		goalDigest: input.goalDigest,
		scorecardDigest: input.scorecardDigest,
		publicBoundaryRegistryDigest: input.publicBoundaryRegistryDigest,
		publicBoundaryRegistry: entries,
		effectDigest: input.effectDigest,
		affectedProductionSurface,
		writeSet,
		closureRationale: input.closureRationale,
	};
}

function normalizeMutationScope(input: WorkflowIntentRedMutationScope): WorkflowIntentRedMutationScope {
	assertClosedRecord(
		input,
		[
			"operationDigest",
			"resourceDigest",
			"effectDigest",
			"affectedProductionSurface",
			"writeSet",
			"closureRationale",
		],
		"RED mutation scope",
	);
	assertDigest(input.operationDigest, "RED mutation scope operationDigest");
	assertDigest(input.resourceDigest, "RED mutation scope resourceDigest");
	assertDigest(input.effectDigest, "RED mutation scope effectDigest");
	assertClosureRationale(input.closureRationale);
	const affectedProductionSurface = normalizeProductionPathSet(
		input.affectedProductionSurface,
		"RED mutation scope affected production surface",
	);
	const writeSet = normalizeProductionPathSet(input.writeSet, "RED mutation scope write set");
	if (
		input.effectDigest !==
		workflowIntentRedMutationEffectDigest({
			resourceDigest: input.resourceDigest,
			affectedProductionSurface,
			writeSet,
			closureRationale: input.closureRationale,
		})
	)
		throw new Error("RED mutation scope effect digest is not bound to its normalized closure.");
	return {
		operationDigest: input.operationDigest,
		resourceDigest: input.resourceDigest,
		effectDigest: input.effectDigest,
		affectedProductionSurface,
		writeSet,
		closureRationale: input.closureRationale,
	};
}

function normalizeProductionPathSet(value: readonly string[], label: string): readonly string[] {
	assertCanonicalArray(value, label);
	if (value.length === 0) throw new Error(`${label} must not be empty.`);
	const normalized = value.map((path) => {
		if (typeof path !== "string") throw new Error(`${label} contains a non-string path.`);
		try {
			return parseWorkflowCanonicalPath(path).join("/");
		} catch (error: unknown) {
			throw new Error(`${label} contains a non-canonical path.`, { cause: error });
		}
	});
	const unique = [...new Set(normalized)].sort();
	if (unique.length !== normalized.length) throw new Error(`${label} contains duplicate paths.`);
	return unique;
}

function assertClosureRationale(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value !== value.trim() ||
		/(?:_for_test|private|source[-_ ]inspection|test[-_ ]only)/iu.test(value)
	)
		throw new Error("RED closure rationale must be a host-owned public rationale.");
}

function assertManifestHostBinding(
	manifest: WorkflowIntentRedManifest,
	hostBinding: WorkflowIntentRedHostBinding,
): void {
	const resourceDigest = workflowIntentRedMutationResourceDigest({
		workflowId: manifest.workflowId,
		taskId: manifest.taskId,
		attemptId: manifest.attemptId,
	});
	if (
		hostBinding.effectDigest !==
		workflowIntentRedMutationEffectDigest({
			resourceDigest,
			affectedProductionSurface: hostBinding.affectedProductionSurface,
			writeSet: hostBinding.writeSet,
			closureRationale: hostBinding.closureRationale,
		})
	)
		throw new Error("RED host effect digest is not bound to its normalized mutation closure.");
	for (const test of manifest.tests) {
		if (!registryHas(hostBinding, test.publicBoundary, "user_outcome", undefined))
			throw new Error("RED test public boundary is not in the host registry.");
		for (const assertion of test.assertions) {
			if (!registryHas(hostBinding, assertion.publicBoundary, assertion.target, assertion.outcomeId))
				throw new Error("RED assertion outcome or public boundary is not host-declared.");
		}
	}
}

function assertPublicEvidenceBytes(bytes: Readonly<Uint8Array>, label: string): void {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error: unknown) {
		throw new Error(`Workflow RED ${label} evidence is not valid public UTF-8.`, { cause: error });
	}
	if (
		/(?:_for_test|private|#private|source[-_ ]inspection|test[-_ ]only)/iu.test(text) ||
		/(?:__filename|__dirname|import\.meta\.url|(?:readFileSync|readFile|readdirSync|globSync)\s*\([^)]*(?:\.ts(?:[^a-z]|$)|\.js(?:[^a-z]|$)|source|__))/iu.test(
			text,
		)
	)
		throw new Error(`Workflow RED ${label} evidence names a private, source-inspection, or test-only seam.`);
}

function registryHas(
	hostBinding: WorkflowIntentRedHostBinding,
	publicBoundary: string,
	target: WorkflowIntentRedAssertionTarget,
	outcomeId: string | undefined,
): boolean {
	return hostBinding.publicBoundaryRegistry.some(
		(entry) =>
			entry.publicBoundary === publicBoundary &&
			entry.target === target &&
			(outcomeId === undefined || entry.outcomeIds.includes(outcomeId)),
	);
}

function assertVerificationClock(currentStateDigest: string, currentRevision: number, trustedNow: string): void {
	assertDigest(currentStateDigest, "RED currentStateDigest");
	if (!Number.isSafeInteger(currentRevision) || currentRevision < 1)
		throw new Error("RED current revision is not a positive safe integer.");
	assertTrustedTime(trustedNow, "RED trustedNow");
}

function assertRedAuthorityCapabilityBinding(
	manifest: WorkflowIntentRedManifest,
	receipt: WorkflowVerifiedHostReceipt,
): NonNullable<WorkflowVerifiedHostReceipt["capabilityBinding"]> {
	if (receipt.receiptKind !== "capability") throw new Error("RED authority requires a capability receipt.");
	const binding = receipt.capabilityBinding;
	if (binding === undefined) throw new Error("RED authority capability receipt has no typed capability binding.");
	assertClosedRecord(
		binding,
		["capability", "resourceDigest", "operationDigest", "executionIdentity", "sessionId"],
		"RED authority capability binding",
	);
	if (binding.capability !== WORKFLOW_INTENT_RED_MUTATION_CAPABILITY)
		throw new Error("RED authority capability is not the workflow intent RED mutation capability.");
	const resourceDigest = workflowIntentRedMutationResourceDigest({
		workflowId: manifest.workflowId,
		taskId: manifest.taskId,
		attemptId: manifest.attemptId,
	});
	const operationDigest = workflowIntentRedMutationOperationDigest({
		manifestDigest: manifest.manifestDigest,
		recipeDigest: manifest.recipeDigest,
		planRevision: manifest.planRevision,
		resourceDigest,
	});
	if (binding.resourceDigest !== resourceDigest || binding.operationDigest !== operationDigest)
		throw new Error("RED authority capability binding is outside the immutable manifest operation/resource scope.");
	assertNullableIdentifier(binding.executionIdentity, "RED authority capability executionIdentity");
	assertNullableIdentifier(binding.sessionId, "RED authority capability sessionId");
	return binding;
}

function assertPrincipalAuthorization(
	authorization: WorkflowHostPrincipalCapabilityAuthorization,
	input: WorkflowHostPrincipalCapabilityAuthorizationInput,
): void {
	if (!isRecord(authorization)) throw new Error("RED principal capability authorization is not a closed record.");
	const authorizationKeys = [
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
		"authorizationDigest",
		...(authorization.executionIdentity === undefined ? [] : ["executionIdentity"]),
		...(authorization.sessionId === undefined ? [] : ["sessionId"]),
	];
	assertClosedRecord(authorization, authorizationKeys, "RED principal capability authorization");
	assertHostReceipt(authorization.receipt, "RED principal authorization receipt");
	assertClosedRecord(authorization.validity, ["issuedAt", "validUntil"], "RED principal authorization validity");
	if (typeof authorization.authenticatedPrincipal !== "string" || typeof authorization.keyOwnerPrincipal !== "string")
		throw new Error("RED principal capability authorization owner is not canonical.");
	assertNullableIdentifier(authorization.executionIdentity ?? null, "RED principal authorization executionIdentity");
	assertNullableIdentifier(authorization.sessionId ?? null, "RED principal authorization sessionId");
	if (
		authorization.authenticatedPrincipal.trim().length === 0 ||
		authorization.keyOwnerPrincipal.trim().length === 0 ||
		authorization.authenticatedPrincipal !== authorization.keyOwnerPrincipal ||
		authorization.capability !== input.capability ||
		authorization.workflowId !== input.workflowId ||
		authorization.bindingDigest !== input.bindingDigest ||
		authorization.stateDigest !== input.stateDigest ||
		authorization.revision !== input.revision ||
		digestObject(authorization.epochRef) !== digestObject(input.epochRef) ||
		authorization.receipt.receiptId !== input.receipt.receiptId ||
		digestObject(authorization.receipt) !== digestObject(input.receipt) ||
		(authorization.executionIdentity ?? null) !== (input.executionIdentity ?? null) ||
		(authorization.sessionId ?? null) !== (input.sessionId ?? null)
	)
		throw new Error("RED principal capability authorization is not bound to the requested host tuple.");
	assertDigest(authorization.authorizationDigest, "RED principal authorizationDigest");
	if (
		Date.parse(authorization.validity.issuedAt) !== Date.parse(input.receipt.issuedAt) ||
		Date.parse(authorization.validity.validUntil) !== Date.parse(input.receipt.validUntil)
	)
		throw new Error("RED principal capability authorization validity is not bound to its receipt.");
}

function assertVerificationContextMatches(
	manifestTokenData: VerifiedManifestTokenData,
	input: WorkflowIntentRedTestResultVerificationInput,
	hostBinding: WorkflowIntentRedHostBinding,
): void {
	assertVerificationClock(input.currentStateDigest, input.currentRevision, input.trustedNow);
	if (
		digestObject(manifestTokenData.currentHead) !== digestObject(input.currentHead) ||
		digestObject(manifestTokenData.currentEpoch) !== digestObject(input.currentEpoch) ||
		manifestTokenData.currentStateDigest !== input.currentStateDigest ||
		manifestTokenData.currentRevision !== input.currentRevision ||
		manifestTokenData.trustedNow !== input.trustedNow ||
		digestObject(manifestTokenData.hostBinding) !== digestObject(hostBinding)
	)
		throw new Error("Workflow RED result verification context is stale or bound to a different host authority.");
}

function assertTrustedTime(value: string, label: string): void {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
		throw new Error(`${label} is not a trusted ISO time.`);
}

async function verifyAndConsumeReceipt(input: {
	context: WorkflowHostReceiptConsumerContext;
	workflowId: string;
	expectedBindingDigest: string;
	receipt: WorkflowVerifiedHostReceipt;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
}): Promise<WorkflowHostReceiptConsumptionWitness> {
	assertHostReceipt(input.receipt, "RED host receipt");
	if (!input.receipt.oneUse) throw new Error("RED authority requires a one-use host receipt witness.");
	await verifyArtifact(input.context, input.receipt.artifactRef, "host receipt");
	await resolveAndVerifyWorkflowHostReceipt(input);
	await input.context.receiptResolver.consumeIfOneUse({
		receipt: input.receipt,
		workflowId: input.workflowId,
		expectedBindingDigest: input.expectedBindingDigest,
		currentRevision: input.currentRevision,
	});
	const witness = await input.context.receiptResolver.resolveConsumptionWitness({
		receiptId: input.receipt.receiptId,
		workflowId: input.workflowId,
		expectedBindingDigest: input.expectedBindingDigest,
	});
	if (
		witness.receiptId !== input.receipt.receiptId ||
		witness.workflowId !== input.workflowId ||
		witness.bindingDigest !== input.expectedBindingDigest ||
		!Number.isSafeInteger(witness.consumptionSequence) ||
		witness.consumptionSequence < 1 ||
		!Number.isFinite(Date.parse(witness.consumedAt))
	)
		throw new Error("RED host receipt consumption witness is not bound to the verified evidence.");
	return cloneFrozen(witness);
}

function getManifestTokenData(token: WorkflowIntentRedVerifiedManifestToken): VerifiedManifestTokenData {
	if (typeof token !== "object" || token === null)
		throw new Error("Workflow RED mutation requires an opaque manifest token.");
	const data = verifiedManifestTokenData.get(token);
	if (data === undefined) throw new Error("Workflow RED manifest token was not produced by host verification.");
	return data;
}

function getResultTokenData(token: WorkflowIntentRedVerifiedResultToken): VerifiedResultTokenData {
	if (typeof token !== "object" || token === null)
		throw new Error("Workflow RED mutation requires opaque result tokens.");
	const data = verifiedResultTokenData.get(token);
	if (data === undefined) throw new Error("Workflow RED result token was not produced by host verification.");
	return data;
}

function assertProcessEvidence(
	processEvidence: WorkflowIntentRedProcessEvidence,
	test: WorkflowIntentRedTestCase,
	trustedNow: string,
): void {
	assertClosedRecord(
		processEvidence,
		[
			"artifactRef",
			"testId",
			"commandDigest",
			"sourceDigest",
			"publicBoundary",
			"executionIdentity",
			"processId",
			"startedAt",
			"completedAt",
			"mode",
			"fakeOnly",
			"provenanceDigest",
		],
		"RED process evidence",
	);
	assertArtifactRef(processEvidence.artifactRef, "RED process evidence artifact");
	assertIdentifier(processEvidence.testId, "RED process evidence testId");
	assertDigest(processEvidence.commandDigest, "RED process evidence commandDigest");
	assertDigest(processEvidence.sourceDigest, "RED process evidence sourceDigest");
	assertPublicBoundary(processEvidence.publicBoundary, "RED process evidence publicBoundary");
	assertIdentifier(processEvidence.executionIdentity, "RED process evidence executionIdentity");
	assertDigest(processEvidence.provenanceDigest, "RED process evidence provenanceDigest");
	if (
		processEvidence.testId !== test.testId ||
		processEvidence.commandDigest !== test.commandDigest ||
		processEvidence.sourceDigest !== test.sourceDigest ||
		processEvidence.publicBoundary !== test.publicBoundary ||
		processEvidence.mode !== "real_process" ||
		processEvidence.fakeOnly !== false ||
		!Number.isSafeInteger(processEvidence.processId) ||
		processEvidence.processId < 1
	)
		throw new Error("RED process evidence is not a real public-boundary execution for the declared test.");
	const startedAt = Date.parse(processEvidence.startedAt);
	const completedAt = Date.parse(processEvidence.completedAt);
	const now = Date.parse(trustedNow);
	if (completedAt < startedAt || completedAt > now)
		throw new Error("RED process evidence is outside the current trusted execution interval.");
}

function assertFreshEvidence(observedAt: string, freshUntil: string, trustedNow: string, label: string): void {
	assertTrustedTime(observedAt, `${label} observedAt`);
	assertTrustedTime(freshUntil, `${label} freshUntil`);
	const observed = Date.parse(observedAt);
	const fresh = Date.parse(freshUntil);
	const now = Date.parse(trustedNow);
	if (fresh <= observed || now < observed || now >= fresh)
		throw new Error(`${label} evidence is stale or outside its freshness interval.`);
}

async function verifyExactArtifactBytes(
	artifactResolver: WorkflowArtifactResolver,
	ref: WorkflowArtifactRef,
	expectedBytes: Readonly<Uint8Array>,
	label: string,
): Promise<void> {
	const artifact = await artifactResolver.resolve(ref);
	if (
		!artifact.exists ||
		!artifact.envelope.immutable ||
		digestObject(artifact.envelope.ref) !== digestObject(ref) ||
		artifact.verifiedDigest !== ref.digest ||
		artifact.verifiedSizeBytes !== ref.sizeBytes ||
		artifact.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(artifact.bytes) !== ref.digest ||
		artifact.bytes.byteLength !== expectedBytes.byteLength ||
		artifact.bytes.some((value, index) => value !== expectedBytes[index])
	)
		throw new Error(`Workflow RED ${label} event artifact bytes do not exactly match the immutable record.`);
}

function normalizeManifestBindingInput(
	input: WorkflowIntentRedManifestBindingInput,
): WorkflowIntentRedNormalizedManifestBinding {
	assertManifestBindingKeys(input);
	assertManifestIdentity(input);
	assertCanonicalArray(input.tests, "RED manifest tests");
	assertCanonicalArray(input.evidenceRefs, "RED manifest evidenceRefs");
	assertCanonicalArray(input.durabilityEvidence, "RED manifest durabilityEvidence");
	const tests = input.tests.map((test) => normalizeTestCase(test));
	if (tests.length === 0 || tests.length > input.maxTests)
		throw new Error("Workflow RED manifest test count exceeds its finite bound.");
	const timeoutTotal = tests.reduce((total, test) => total + test.timeoutMilliseconds, 0);
	if (timeoutTotal > input.maxRuntimeMilliseconds)
		throw new Error("Workflow RED manifest timeout total exceeds its finite runtime bound.");
	const evidenceRefs = input.evidenceRefs.map((ref) => normalizeArtifactRef(ref, "manifest evidence"));
	if (evidenceRefs.length === 0) throw new Error("Workflow RED manifest requires host evidence references.");
	if (new Set(evidenceRefs.map((ref) => digestObject(ref))).size !== evidenceRefs.length)
		throw new Error("Workflow RED manifest evidence refs must be unique.");
	const durabilityEvidence = input.durabilityEvidence.map((item) => normalizeDurabilityEvidence(item));
	const durabilityKinds = new Set(durabilityEvidence.map((item) => item.kind));
	if (
		durabilityEvidence.length !== 4 ||
		durabilityKinds.size !== 4 ||
		(["integration", "restart", "process", "store"] as const).some((kind) => !durabilityKinds.has(kind))
	)
		throw new Error(
			"Workflow RED manifest requires one host evidence item for integration, restart, process, and store.",
		);
	if (new Set(tests.map((test) => test.testId)).size !== tests.length)
		throw new Error("Workflow RED manifest test IDs must be unique.");
	const durabilityDigests = new Set<string>();
	const testArtifactDigests = new Set(
		tests.flatMap((test) => [
			test.commandArtifactRef.digest,
			test.sourceArtifactRef.digest,
			...test.inputArtifactRefs.map((ref) => ref.digest),
		]),
	);
	for (const item of durabilityEvidence) {
		if (durabilityDigests.has(item.artifactRef.digest))
			throw new Error("Workflow RED durability evidence must use distinct typed artifacts.");
		if (testArtifactDigests.has(item.artifactRef.digest))
			throw new Error("Workflow RED durability evidence must not reuse command, source, or input artifacts.");
		durabilityDigests.add(item.artifactRef.digest);
		if (
			item.provenanceDigest !==
			digestObject({
				kind: item.kind,
				artifactRef: item.artifactRef,
				observedAt: item.observedAt,
				freshUntil: item.freshUntil,
				source: item.source,
			})
		)
			throw new Error("Workflow RED durability evidence provenance is forged or stale.");
	}
	for (const test of tests) {
		for (const ref of [
			test.commandArtifactRef,
			test.sourceArtifactRef,
			...test.inputArtifactRefs,
			...test.hostScanEvidenceRefs,
		]) {
			if (!evidenceRefs.some((candidate) => digestObject(candidate) === digestObject(ref)))
				throw new Error("Workflow RED manifest evidence refs omit a command, source, or input artifact.");
		}
	}
	for (const item of durabilityEvidence) {
		if (!evidenceRefs.some((candidate) => digestObject(candidate) === digestObject(item.artifactRef)))
			throw new Error("Workflow RED manifest evidence refs omit a durability or authority artifact.");
	}
	return {
		...input,
		expectedHead: normalizeJournalHead(input.expectedHead),
		epochRef: normalizeEpochRef(input.epochRef),
		tests,
		evidenceRefs,
		durabilityEvidence,
	};
}

function normalizeManifestWithReceipt(
	input: WorkflowIntentRedManifest | WorkflowIntentRedManifestDraft,
): WorkflowIntentRedManifest {
	const binding = normalizeManifestBindingInput(manifestBindingInput(input));
	assertHostReceipt(input.hostReceipt, "manifest hostReceipt");
	const record = input as Partial<WorkflowIntentRedManifest>;
	return {
		...binding,
		hostReceipt: normalizeHostReceipt(input.hostReceipt),
		manifestDigest: record.manifestDigest ?? "",
		idempotencyKey: record.idempotencyKey ?? "",
	};
}

function normalizeResultBindingInput(input: WorkflowIntentRedResultBindingInput): WorkflowIntentRedResultBindingInput {
	assertResultBindingKeys(input);
	assertIdentifier(input.workflowId, "result workflowId");
	assertIdentifier(input.taskId, "result taskId");
	assertIdentifier(input.attemptId, "result attemptId");
	assertDigest(input.manifestDigest, "result manifestDigest");
	assertDigest(input.recipeDigest, "result recipeDigest");
	assertDigest(input.testDigest, "result testDigest");
	if (!Number.isSafeInteger(input.planRevision) || input.planRevision < 1)
		throw new Error("Workflow RED result planRevision is not a positive safe integer.");
	assertIdentifier(input.testId, "result testId");
	assertIdentifier(input.invocationId, "result invocationId");
	assertDigest(input.idempotencyKey, "result idempotencyKey");
	assertDigest(input.expectedHeadDigest, "result expectedHeadDigest");
	const epoch = normalizeEpochRef(input.epochRef);
	assertCanonicalArray(input.processEvidenceRefs, "RED result processEvidenceRefs");
	assertCanonicalArray(input.evidenceRefs, "RED result evidenceRefs");
	assertCanonicalArray(input.failedAssertions, "RED result failedAssertions");
	if (input.runtimeMode !== "worker_free_shell" && input.runtimeMode !== "true_runtime")
		throw new Error("Workflow RED result runtime mode is not canonical.");
	if (!Number.isSafeInteger(input.exitCode)) throw new Error("Workflow RED result exitCode is not a safe integer.");
	if (typeof input.timedOut !== "boolean" || typeof input.passed !== "boolean")
		throw new Error("Workflow RED result boolean fields are not canonical.");
	const refs = [
		["startBoundaryRef", input.startBoundaryRef],
		["endBoundaryRef", input.endBoundaryRef],
		...input.processEvidenceRefs.map((ref, index) => [`processEvidenceRefs[${index}]`, ref] as const),
		["stdoutArtifactRef", input.stdoutArtifactRef],
		["stderrArtifactRef", input.stderrArtifactRef],
		...input.evidenceRefs.map((ref, index) => [`evidenceRefs[${index}]`, ref] as const),
	] as const;
	for (const [label, ref] of refs) {
		assertArtifactRef(ref, `result ${label}`);
		assertPublicArtifactRef(ref, "RED result evidence");
	}
	if (input.processEvidenceRefs.length === 0 || input.evidenceRefs.length === 0)
		throw new Error("Workflow RED result requires process and evidence artifact references.");
	if (new Set(refs.map(([, ref]) => digestObject(ref))).size !== refs.length)
		throw new Error("Workflow RED result evidence refs must be distinct.");
	if (!isFailureClass(input.classification)) throw new Error("Workflow RED result classification is not canonical.");
	const failedAssertions = input.failedAssertions.map((failure) => normalizeAssertionFailure(failure));
	return {
		...input,
		epochRef: epoch,
		startBoundaryRef: normalizeArtifactRef(input.startBoundaryRef, "result startBoundaryRef"),
		endBoundaryRef: normalizeArtifactRef(input.endBoundaryRef, "result endBoundaryRef"),
		processEvidenceRefs: input.processEvidenceRefs.map((ref) => normalizeArtifactRef(ref, "result process evidence")),
		processEvidence: normalizeProcessEvidence(input.processEvidence),
		stdoutArtifactRef: normalizeArtifactRef(input.stdoutArtifactRef, "result stdoutArtifactRef"),
		stderrArtifactRef: normalizeArtifactRef(input.stderrArtifactRef, "result stderrArtifactRef"),
		evidenceRefs: input.evidenceRefs.map((ref) => normalizeArtifactRef(ref, "result evidence")),
		failedAssertions,
	};
}

function normalizeResultWithReceipt(
	input: WorkflowIntentRedTestResult | WorkflowIntentRedTestResultDraft,
): WorkflowIntentRedTestResult {
	const binding = normalizeResultBindingInput(resultBindingInput(input));
	assertHostReceipt(input.hostReceipt, "result hostReceipt");
	const record = input as Partial<WorkflowIntentRedTestResult>;
	return {
		...binding,
		hostReceipt: normalizeHostReceipt(input.hostReceipt),
		resultDigest: record.resultDigest ?? "",
	};
}

function assertCompleteManifest(value: unknown): WorkflowIntentRedManifest {
	if (!isRecord(value)) throw new Error("Workflow RED manifest must be an object.");
	assertManifestFullKeys(value);
	if (value.schemaId !== MANIFEST_SCHEMA_ID || value.schemaVersion !== MANIFEST_VERSION)
		throw new Error("Workflow RED manifest schema version is unsupported.");
	const binding = normalizeManifestBindingInput(manifestBindingInput(value as unknown as WorkflowIntentRedManifest));
	assertHostReceipt(value.hostReceipt, "manifest hostReceipt");
	const hostReceipt = normalizeHostReceipt(value.hostReceipt);
	if (hostReceipt.workflowId !== binding.workflowId)
		throw new Error("Workflow RED manifest host receipt names a different workflow.");
	if (hostReceipt.bindingDigest !== workflowIntentRedManifestBindingDigest(binding))
		throw new Error("Workflow RED manifest receipt binding digest is forged.");
	const manifest = {
		...binding,
		hostReceipt,
		manifestDigest: value.manifestDigest,
		idempotencyKey: value.idempotencyKey,
	} as WorkflowIntentRedManifest;
	assertDigest(manifest.manifestDigest, "manifestDigest");
	assertDigest(manifest.idempotencyKey, "manifest idempotencyKey");
	if (manifest.idempotencyKey !== workflowIntentRedManifestIdempotencyKey(binding))
		throw new Error("Workflow RED manifest idempotency key is forged.");
	if (manifest.manifestDigest !== workflowIntentRedManifestDigest(manifest))
		throw new Error("Workflow RED manifest immutable digest is forged or stale.");
	return manifest;
}

function manifestBindingInput(
	input: WorkflowIntentRedManifest | WorkflowIntentRedManifestDraft,
): WorkflowIntentRedManifestBindingInput {
	const {
		hostReceipt: _hostReceipt,
		manifestDigest: _manifestDigest,
		idempotencyKey: _idempotencyKey,
		...binding
	} = input as unknown as WorkflowIntentRedManifest;
	return binding;
}

function resultBindingInput(
	input: WorkflowIntentRedTestResult | WorkflowIntentRedTestResultDraft,
): WorkflowIntentRedResultBindingInput {
	const {
		hostReceipt: _hostReceipt,
		resultDigest: _resultDigest,
		...binding
	} = input as unknown as WorkflowIntentRedTestResult;
	return binding;
}

function assertCompleteResult(value: unknown): WorkflowIntentRedTestResult {
	if (!isRecord(value)) throw new Error("Workflow RED result must be an object.");
	assertResultFullKeys(value);
	if (value.schemaId !== RESULT_SCHEMA_ID || value.schemaVersion !== RESULT_VERSION)
		throw new Error("Workflow RED result schema version is unsupported.");
	const binding = normalizeResultBindingInput(resultBindingInput(value as unknown as WorkflowIntentRedTestResult));
	assertHostReceipt(value.hostReceipt, "result hostReceipt");
	const hostReceipt = normalizeHostReceipt(value.hostReceipt);
	if (hostReceipt.workflowId !== binding.workflowId)
		throw new Error("Workflow RED result host receipt names a different workflow.");
	if (hostReceipt.bindingDigest !== workflowIntentRedResultBindingDigest(binding))
		throw new Error("Workflow RED result receipt binding digest is forged.");
	const result = { ...binding, hostReceipt, resultDigest: value.resultDigest } as WorkflowIntentRedTestResult;
	assertDigest(result.resultDigest, "resultDigest");
	if (result.idempotencyKey !== workflowIntentRedResultIdempotencyKey(result))
		throw new Error("Workflow RED result idempotency key is forged.");
	if (result.resultDigest !== workflowIntentRedResultDigest(result))
		throw new Error("Workflow RED result immutable digest is forged or stale.");
	return result;
}

function assertManifestIdentity(input: WorkflowIntentRedManifestBindingInput): void {
	if (input.schemaId !== MANIFEST_SCHEMA_ID || input.schemaVersion !== MANIFEST_VERSION)
		throw new Error("Workflow RED manifest schema version is unsupported.");
	for (const [value, label] of [
		[input.workflowId, "manifest workflowId"],
		[input.taskId, "manifest taskId"],
		[input.attemptId, "manifest attemptId"],
		[input.scopeDigest, "manifest scopeDigest"],
		[input.recipeDigest, "manifest recipeDigest"],
	] as const)
		assertIdentifier(value, label);
	assertDigest(input.expectedHeadDigest, "manifest expectedHeadDigest");
	assertDigest(input.scopeDigest, "manifest scopeDigest");
	assertDigest(input.recipeDigest, "manifest recipeDigest");
	if (!Number.isSafeInteger(input.planRevision) || input.planRevision < 1)
		throw new Error("Workflow RED manifest planRevision is not a positive safe integer.");
	if (!Number.isSafeInteger(input.maxTests) || input.maxTests < 1)
		throw new Error("Workflow RED manifest maxTests is not a positive safe integer.");
	if (!Number.isSafeInteger(input.maxRuntimeMilliseconds) || input.maxRuntimeMilliseconds < 1)
		throw new Error("Workflow RED manifest maxRuntimeMilliseconds is not a positive safe integer.");
	if (input.executable !== true || input.owner !== "host")
		throw new Error("Workflow RED manifest must be a host-owned executable record.");
	if (digestObject(input.expectedHead) !== input.expectedHeadDigest)
		throw new Error("Workflow RED manifest head digest is stale or forged.");
	if (input.expectedHead.workflowId !== input.workflowId)
		throw new Error("Workflow RED manifest head names a different workflow.");
	if (digestObject(input.expectedHead.epochRef) !== digestObject(input.epochRef))
		throw new Error("Workflow RED manifest head and epoch bindings disagree.");
}

function assertManifestBindingKeys(value: unknown): asserts value is WorkflowIntentRedManifestBindingInput {
	assertClosedRecord(
		value,
		[
			"schemaId",
			"schemaVersion",
			"workflowId",
			"taskId",
			"attemptId",
			"expectedHead",
			"expectedHeadDigest",
			"epochRef",
			"scopeDigest",
			"recipeDigest",
			"planRevision",
			"tests",
			"maxTests",
			"maxRuntimeMilliseconds",
			"evidenceRefs",
			"durabilityEvidence",
			"executable",
			"owner",
		],
		"manifest binding",
	);
}

function assertManifestFullKeys(value: unknown): void {
	assertClosedRecord(
		value,
		[
			"schemaId",
			"schemaVersion",
			"workflowId",
			"taskId",
			"attemptId",
			"expectedHead",
			"expectedHeadDigest",
			"epochRef",
			"scopeDigest",
			"recipeDigest",
			"planRevision",
			"tests",
			"maxTests",
			"maxRuntimeMilliseconds",
			"evidenceRefs",
			"durabilityEvidence",
			"executable",
			"owner",
			"hostReceipt",
			"manifestDigest",
			"idempotencyKey",
		],
		"manifest",
	);
}

function assertResultBindingKeys(value: unknown): asserts value is WorkflowIntentRedResultBindingInput {
	assertClosedRecord(
		value,
		[
			"schemaId",
			"schemaVersion",
			"workflowId",
			"taskId",
			"attemptId",
			"manifestDigest",
			"recipeDigest",
			"planRevision",
			"testId",
			"testDigest",
			"invocationId",
			"idempotencyKey",
			"expectedHeadDigest",
			"epochRef",
			"runtimeMode",
			"startBoundaryRef",
			"endBoundaryRef",
			"processEvidenceRefs",
			"processEvidence",
			"exitCode",
			"timedOut",
			"stdoutArtifactRef",
			"stderrArtifactRef",
			"evidenceRefs",
			"classification",
			"passed",
			"failedAssertions",
		],
		"result binding",
	);
}

function assertResultFullKeys(value: unknown): void {
	assertClosedRecord(
		value,
		[
			"schemaId",
			"schemaVersion",
			"workflowId",
			"taskId",
			"attemptId",
			"manifestDigest",
			"recipeDigest",
			"planRevision",
			"testId",
			"testDigest",
			"invocationId",
			"idempotencyKey",
			"expectedHeadDigest",
			"epochRef",
			"runtimeMode",
			"startBoundaryRef",
			"endBoundaryRef",
			"processEvidenceRefs",
			"processEvidence",
			"exitCode",
			"timedOut",
			"stdoutArtifactRef",
			"stderrArtifactRef",
			"evidenceRefs",
			"classification",
			"passed",
			"failedAssertions",
			"hostReceipt",
			"resultDigest",
		],
		"result",
	);
}

function normalizeTestCase(
	input: WorkflowIntentRedTestCaseDraft | WorkflowIntentRedTestCase,
): WorkflowIntentRedTestCase {
	assertClosedRecord(
		input,
		[
			"testId",
			"attackId",
			"commandArtifactRef",
			"commandDigest",
			"sourceArtifactRef",
			"sourceDigest",
			"inputArtifactRefs",
			"inputDigest",
			"publicBoundary",
			"hostScanEvidenceRefs",
			"evidenceClassification",
			"assertions",
			"expectedExitCode",
			"timeoutMilliseconds",
			"requiredEvidenceKinds",
			"owner",
			"hidden",
			"requiresRealRuntime",
			"mockOnly",
			...("testDigest" in input ? ["testDigest"] : []),
		],
		"RED test case",
	);
	assertIdentifier(input.testId, "RED testId");
	assertIdentifier(input.attackId, "RED attackId");
	const commandRef = normalizeArtifactRef(input.commandArtifactRef, "RED command artifact");
	const sourceRef = normalizeArtifactRef(input.sourceArtifactRef, "RED source artifact");
	assertCanonicalArray(input.inputArtifactRefs, "RED input artifact refs");
	assertCanonicalArray(input.hostScanEvidenceRefs, "RED host scan evidence refs");
	assertCanonicalArray(input.requiredEvidenceKinds, "RED required evidence kinds");
	assertCanonicalArray(input.assertions, "RED assertions");
	const inputRefs = input.inputArtifactRefs.map((ref) => normalizeArtifactRef(ref, "RED input artifact"));
	const hostScanEvidenceRefs = input.hostScanEvidenceRefs.map((ref) =>
		normalizeArtifactRef(ref, "RED host scan evidence"),
	);
	for (const ref of [commandRef, sourceRef, ...inputRefs, ...hostScanEvidenceRefs])
		assertPublicArtifactRef(ref, "RED public evidence");
	if (inputRefs.length === 0) throw new Error("RED test case requires an immutable input artifact.");
	if (hostScanEvidenceRefs.length === 0) throw new Error("RED test case requires host scan evidence.");
	if (new Set(hostScanEvidenceRefs.map((ref) => digestObject(ref))).size !== hostScanEvidenceRefs.length)
		throw new Error("RED host scan evidence refs must be unique.");
	if (
		new Set([commandRef.digest, sourceRef.digest, ...inputRefs.map((ref) => ref.digest)]).size !==
		inputRefs.length + 2
	)
		throw new Error("RED test command, source, and input artifacts must be distinct.");
	if (input.commandDigest !== commandRef.digest || input.sourceDigest !== sourceRef.digest)
		throw new Error("RED test command and source digests do not match their artifacts.");
	if (input.inputDigest !== digestObject(inputRefs))
		throw new Error("RED test input digest does not match its complete input artifact set.");
	if (!Number.isSafeInteger(input.expectedExitCode) || input.expectedExitCode < 0)
		throw new Error("RED expected exit code is not a non-negative safe integer.");
	if (!Number.isSafeInteger(input.timeoutMilliseconds) || input.timeoutMilliseconds < 1)
		throw new Error("RED test timeout is not a positive safe integer.");
	if (input.requiredEvidenceKinds.length === 0) throw new Error("RED test requires evidence kinds.");
	if (
		input.requiredEvidenceKinds.some((kind) => typeof kind !== "string" || kind.length === 0) ||
		new Set(input.requiredEvidenceKinds).size !== input.requiredEvidenceKinds.length
	)
		throw new Error("RED test evidence kinds are not canonical.");
	if (input.owner !== "host" || input.requiresRealRuntime !== true || input.mockOnly !== false)
		throw new Error("RED test is not host-owned real-runtime evidence.");
	if (typeof input.hidden !== "boolean") throw new Error("RED test hidden flag is not canonical.");
	assertPublicBoundary(input.publicBoundary, "RED publicBoundary");
	if (input.evidenceClassification !== "acceptance" && input.evidenceClassification !== "debug_probe")
		throw new Error("RED evidence classification is not canonical.");
	if (input.assertions.length === 0)
		throw new Error("RED test must bind at least one user or forbidden outcome assertion.");
	const assertions = input.assertions.map((item) => normalizeAssertion(item));
	if (new Set(assertions.map((item) => item.assertionId)).size !== assertions.length)
		throw new Error("RED test assertion IDs must be unique.");
	const test = {
		testId: input.testId,
		attackId: input.attackId,
		commandArtifactRef: commandRef,
		commandDigest: input.commandDigest,
		sourceArtifactRef: sourceRef,
		sourceDigest: input.sourceDigest,
		inputArtifactRefs: inputRefs,
		inputDigest: input.inputDigest,
		publicBoundary: input.publicBoundary,
		hostScanEvidenceRefs,
		evidenceClassification: input.evidenceClassification,
		assertions,
		expectedExitCode: input.expectedExitCode,
		timeoutMilliseconds: input.timeoutMilliseconds,
		requiredEvidenceKinds: [...input.requiredEvidenceKinds],
		owner: "host" as const,
		hidden: input.hidden,
		requiresRealRuntime: true as const,
		mockOnly: false as const,
	};
	const testDigest = digestObject(test);
	if ("testDigest" in input && input.testDigest !== testDigest)
		throw new Error("RED test immutable digest is forged or stale.");
	return { ...test, testDigest };
}

function normalizeProcessEvidence(input: WorkflowIntentRedProcessEvidence): WorkflowIntentRedProcessEvidence {
	assertClosedRecord(
		input,
		[
			"artifactRef",
			"testId",
			"commandDigest",
			"sourceDigest",
			"publicBoundary",
			"executionIdentity",
			"processId",
			"startedAt",
			"completedAt",
			"mode",
			"fakeOnly",
			"provenanceDigest",
		],
		"RED process evidence",
	);
	assertArtifactRef(input.artifactRef, "RED process evidence artifact");
	assertIdentifier(input.testId, "RED process evidence testId");
	assertDigest(input.commandDigest, "RED process evidence commandDigest");
	assertDigest(input.sourceDigest, "RED process evidence sourceDigest");
	assertPublicBoundary(input.publicBoundary, "RED process evidence publicBoundary");
	assertIdentifier(input.executionIdentity, "RED process evidence executionIdentity");
	if (/(?:fixture|mock|fake|structuredclone|_for_test|private|source[-_ ]inspection)/iu.test(input.executionIdentity))
		throw new Error("RED process evidence execution identity is not a public host process.");
	if (!Number.isSafeInteger(input.processId) || input.processId < 1)
		throw new Error("RED process evidence processId is not a positive safe integer.");
	if (input.mode !== "real_process" || input.fakeOnly !== false)
		throw new Error("RED process evidence must be a real process and cannot be a fake-only probe.");
	assertTrustedTime(input.startedAt, "RED process evidence startedAt");
	assertTrustedTime(input.completedAt, "RED process evidence completedAt");
	if (Date.parse(input.completedAt) < Date.parse(input.startedAt))
		throw new Error("RED process evidence completedAt precedes startedAt.");
	assertDigest(input.provenanceDigest, "RED process evidence provenanceDigest");
	const artifactRef = normalizeArtifactRef(input.artifactRef, "RED process evidence artifact");
	assertPublicArtifactRef(artifactRef, "RED process evidence");
	if (
		input.provenanceDigest !==
		digestObject({
			kind: "process",
			artifactRef: input.artifactRef,
			testId: input.testId,
			commandDigest: input.commandDigest,
			sourceDigest: input.sourceDigest,
			publicBoundary: input.publicBoundary,
			executionIdentity: input.executionIdentity,
			processId: input.processId,
			startedAt: input.startedAt,
			completedAt: input.completedAt,
			mode: input.mode,
			fakeOnly: input.fakeOnly,
		})
	)
		throw new Error("RED process evidence provenance is forged or stale.");
	return {
		artifactRef,
		testId: input.testId,
		commandDigest: input.commandDigest,
		sourceDigest: input.sourceDigest,
		publicBoundary: input.publicBoundary,
		executionIdentity: input.executionIdentity,
		processId: input.processId,
		startedAt: input.startedAt,
		completedAt: input.completedAt,
		mode: "real_process",
		fakeOnly: false,
		provenanceDigest: input.provenanceDigest,
	};
}

function normalizeDurabilityEvidence(input: WorkflowIntentRedDurabilityEvidence): WorkflowIntentRedDurabilityEvidence {
	assertClosedRecord(
		input,
		["kind", "artifactRef", "provenanceDigest", "observedAt", "freshUntil", "source"],
		"RED durability evidence",
	);
	if (!(["integration", "restart", "process", "store"] as const).includes(input.kind))
		throw new Error("RED durability evidence kind is not canonical.");
	assertDigest(input.provenanceDigest, "RED durability evidence provenanceDigest");
	assertIdentifier(input.source, "RED durability evidence source");
	if (/(?:fixture|mock|fake|structuredclone|_for_test|private|source[-_ ]inspection)/iu.test(input.source))
		throw new Error("RED durability evidence provenance names a non-authoritative or private source.");
	assertTrustedTime(input.observedAt, "RED durability evidence observedAt");
	assertTrustedTime(input.freshUntil, "RED durability evidence freshUntil");
	if (Date.parse(input.freshUntil) <= Date.parse(input.observedAt))
		throw new Error("RED durability evidence freshness interval is empty.");
	const artifactRef = normalizeArtifactRef(input.artifactRef, "RED durability evidence");
	assertPublicArtifactRef(artifactRef, "RED durability evidence");
	return {
		kind: input.kind,
		artifactRef,
		provenanceDigest: input.provenanceDigest,
		observedAt: input.observedAt,
		freshUntil: input.freshUntil,
		source: input.source,
	};
}

function normalizeAssertion(input: WorkflowIntentRedAssertion): WorkflowIntentRedAssertion {
	assertClosedRecord(input, ["assertionId", "target", "outcomeId", "publicBoundary", "description"], "RED assertion");
	assertIdentifier(input.assertionId, "RED assertionId");
	assertIdentifier(input.outcomeId, "RED outcomeId");
	if (input.target !== "user_outcome" && input.target !== "forbidden_outcome")
		throw new Error("RED assertion target is not a user or forbidden outcome.");
	if (typeof input.description !== "string" || input.description.trim().length === 0)
		throw new Error("RED assertion description is empty.");
	assertPublicBoundary(input.publicBoundary, "RED assertion publicBoundary");
	return {
		assertionId: input.assertionId,
		target: input.target,
		outcomeId: input.outcomeId,
		publicBoundary: input.publicBoundary,
		description: input.description,
	};
}

function normalizeAssertionFailure(input: WorkflowIntentRedAssertionFailure): WorkflowIntentRedAssertionFailure {
	assertClosedRecord(
		input,
		["assertionId", "target", "outcomeId", "publicBoundary", "assertionDigest", "artifactRef", "message"],
		"RED assertion failure",
	);
	assertIdentifier(input.assertionId, "RED failed assertionId");
	assertIdentifier(input.outcomeId, "RED failed outcomeId");
	assertPublicBoundary(input.publicBoundary, "RED failed publicBoundary");
	assertDigest(input.assertionDigest, "RED failed assertionDigest");
	const artifactRef = normalizeArtifactRef(input.artifactRef, "RED failed assertion artifact");
	assertPublicArtifactRef(artifactRef, "RED failed assertion artifact");
	if (input.target !== "user_outcome" && input.target !== "forbidden_outcome")
		throw new Error("RED failed assertion target is not canonical.");
	if (typeof input.message !== "string" || input.message.trim().length === 0)
		throw new Error("RED failed assertion message is empty.");
	return {
		assertionId: input.assertionId,
		target: input.target,
		outcomeId: input.outcomeId,
		publicBoundary: input.publicBoundary,
		assertionDigest: input.assertionDigest,
		artifactRef,
		message: input.message,
	};
}

function assertResultAssertions(result: WorkflowIntentRedTestResult, test: WorkflowIntentRedTestCase): void {
	const seen = new Set<string>();
	for (const failure of result.failedAssertions) {
		if (seen.has(failure.assertionId)) throw new Error("RED result repeats an assertion failure.");
		seen.add(failure.assertionId);
		const expected = test.assertions.find((assertion) => assertion.assertionId === failure.assertionId);
		if (
			expected === undefined ||
			failure.target !== expected.target ||
			failure.outcomeId !== expected.outcomeId ||
			failure.publicBoundary !== expected.publicBoundary ||
			failure.assertionDigest !== digestObject(expected) ||
			!result.evidenceRefs.some((ref) => digestObject(ref) === digestObject(failure.artifactRef))
		)
			throw new Error("RED result assertion failure is not bound to a declared user or forbidden outcome.");
	}
}

function assertCurrentHeadAndEpoch(
	expectedHead: WorkflowJournalHead,
	expectedEpoch: WorkflowEpochRef,
	currentHead: WorkflowJournalHead,
	currentEpoch: WorkflowEpochRef,
): void {
	if (
		digestObject(expectedHead) !== digestObject(currentHead) ||
		digestObject(expectedEpoch) !== digestObject(currentEpoch) ||
		expectedHead.workflowId !== currentHead.workflowId
	)
		throw new Error("Workflow RED manifest or result is stale for the current workflow head or epoch.");
}

async function verifyArtifact(
	context: WorkflowHostReceiptConsumerContext,
	ref: WorkflowArtifactRef,
	label: string,
): Promise<Readonly<Uint8Array>> {
	const artifact = await context.artifactResolver.resolve(ref);
	if (
		!artifact.exists ||
		!artifact.envelope.immutable ||
		digestObject(artifact.envelope.ref) !== digestObject(ref) ||
		artifact.verifiedDigest !== ref.digest ||
		artifact.verifiedSizeBytes !== ref.sizeBytes ||
		artifact.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(artifact.bytes) !== ref.digest
	)
		throw new Error(`Workflow RED ${label} artifact is missing, mutable, or not content-addressed.`);
	return Uint8Array.from(artifact.bytes);
}

function normalizeJournalHead(input: WorkflowJournalHead): WorkflowJournalHead {
	assertClosedRecord(input, ["workflowId", "sequence", "eventDigest", "epochRef"], "workflow head");
	assertIdentifier(input.workflowId, "workflow head workflowId");
	if (!Number.isSafeInteger(input.sequence) || input.sequence < 0)
		throw new Error("Workflow head sequence is not a non-negative safe integer.");
	if (input.eventDigest !== null) assertDigest(input.eventDigest, "workflow head eventDigest");
	return {
		workflowId: input.workflowId,
		sequence: input.sequence,
		eventDigest: input.eventDigest,
		epochRef: normalizeEpochRef(input.epochRef),
	};
}

function normalizeEpochRef(input: WorkflowEpochRef): WorkflowEpochRef {
	assertClosedRecord(input, ["storeEpoch", "coordinatorEpoch"], "workflow epoch");
	if (!Number.isSafeInteger(input.storeEpoch) || input.storeEpoch < 1)
		throw new Error("Workflow store epoch is not a positive safe integer.");
	if (!Number.isSafeInteger(input.coordinatorEpoch) || input.coordinatorEpoch < 1)
		throw new Error("Workflow coordinator epoch is not a positive safe integer.");
	return { storeEpoch: input.storeEpoch, coordinatorEpoch: input.coordinatorEpoch };
}

function normalizeArtifactRef(input: WorkflowArtifactRef, label: string): WorkflowArtifactRef {
	assertArtifactRef(input, label);
	return {
		artifactId: input.artifactId,
		relativePath: input.relativePath,
		digest: input.digest,
		sizeBytes: input.sizeBytes,
		sourceEventSequence: input.sourceEventSequence,
	};
}

function assertArtifactRef(input: unknown, label: string): asserts input is WorkflowArtifactRef {
	assertClosedRecord(input, ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"], label);
	const ref = input as unknown as WorkflowArtifactRef;
	if (typeof ref.artifactId !== "string" || ref.artifactId.trim().length === 0)
		throw new Error(`${label} artifactId is empty.`);
	if (typeof ref.relativePath !== "string" || ref.relativePath.length === 0)
		throw new Error(`${label} relativePath is empty.`);
	try {
		parseWorkflowCanonicalPath(ref.relativePath);
	} catch (error: unknown) {
		throw new Error(`${label} relativePath is not canonical.`, { cause: error });
	}
	assertDigest(ref.digest, `${label} digest`);
	if (!Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 0)
		throw new Error(`${label} sizeBytes is not a non-negative safe integer.`);
	if (!Number.isSafeInteger(ref.sourceEventSequence) || ref.sourceEventSequence < 0)
		throw new Error(`${label} sourceEventSequence is not a non-negative safe integer.`);
}

function assertPublicArtifactRef(ref: WorkflowArtifactRef, label: string): void {
	if (
		/(?:_for_test|private|source[-_ ]inspection|test[-_ ]only|fixture|mock|fake|structuredclone)/iu.test(
			`${ref.artifactId}/${ref.relativePath}`,
		)
	)
		throw new Error(`${label} artifact reference names a private or test-only seam.`);
}

function normalizeHostReceipt(input: WorkflowVerifiedHostReceipt): WorkflowVerifiedHostReceipt {
	assertHostReceipt(input, "host receipt");
	return { ...input, artifactRef: normalizeArtifactRef(input.artifactRef, "host receipt artifact") };
}

function assertHostReceipt(input: unknown, label: string): asserts input is WorkflowVerifiedHostReceipt {
	if (!isRecord(input)) throw new Error(`${label} must be a closed object.`);
	const baseKeys = [
		"receiptKind",
		"oneUse",
		"receiptId",
		"issuerId",
		"workflowId",
		"bindingDigest",
		"payloadDigest",
		"artifactRef",
		"issuedAt",
		"validUntil",
		"keyId",
		"signatureAlgorithm",
		"artifactBytesDigest",
		"stateDigest",
		"revision",
		"signature",
		"verificationDigest",
	] as const;
	assertClosedRecord(
		input,
		input.capabilityBinding === undefined ? baseKeys : [...baseKeys, "capabilityBinding"],
		label,
	);
	const receipt = input as unknown as WorkflowVerifiedHostReceipt;
	if (typeof receipt.receiptKind !== "string" || !RECEIPT_KINDS.has(receipt.receiptKind))
		throw new Error(`${label} receiptKind is not canonical.`);
	if (
		typeof receipt.oneUse !== "boolean" ||
		typeof receipt.receiptId !== "string" ||
		typeof receipt.issuerId !== "string" ||
		typeof receipt.workflowId !== "string" ||
		typeof receipt.keyId !== "string" ||
		typeof receipt.signature !== "string" ||
		typeof receipt.stateDigest !== "string"
	)
		throw new Error(`${label} identity fields are not canonical.`);
	for (const [value, field] of [
		[receipt.bindingDigest, "bindingDigest"],
		[receipt.payloadDigest, "payloadDigest"],
		[receipt.artifactBytesDigest, "artifactBytesDigest"],
		[receipt.verificationDigest, "verificationDigest"],
	] as const)
		assertDigest(value, `${label} ${field}`);
	assertArtifactRef(receipt.artifactRef, `${label} artifactRef`);
	if (receipt.signatureAlgorithm !== "ed25519") throw new Error(`${label} signature algorithm is not canonical.`);
	if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1)
		throw new Error(`${label} revision is not a positive safe integer.`);
	if (
		typeof receipt.issuedAt !== "string" ||
		typeof receipt.validUntil !== "string" ||
		!Number.isFinite(Date.parse(receipt.issuedAt)) ||
		!Number.isFinite(Date.parse(receipt.validUntil)) ||
		Date.parse(receipt.validUntil) <= Date.parse(receipt.issuedAt)
	)
		throw new Error(`${label} validity interval is not canonical.`);
	if (receipt.capabilityBinding !== undefined) {
		assertClosedRecord(
			receipt.capabilityBinding,
			["capability", "resourceDigest", "operationDigest", "executionIdentity", "sessionId"],
			`${label} capabilityBinding`,
		);
		if (typeof receipt.capabilityBinding.capability !== "string")
			throw new Error(`${label} capabilityBinding capability is not canonical.`);
		assertDigest(receipt.capabilityBinding.resourceDigest, `${label} capabilityBinding resourceDigest`);
		assertDigest(receipt.capabilityBinding.operationDigest, `${label} capabilityBinding operationDigest`);
		assertNullableIdentifier(
			receipt.capabilityBinding.executionIdentity,
			`${label} capabilityBinding executionIdentity`,
		);
		assertNullableIdentifier(receipt.capabilityBinding.sessionId, `${label} capabilityBinding sessionId`);
	}
}

function assertClosedRecord(
	value: unknown,
	keys: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be a closed object.`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} has a non-canonical prototype.`);
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.some((key) => typeof key !== "string")) throw new Error(`${label} contains a symbol field.`);
	const actual = ownKeys as string[];
	actual.sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
		throw new Error(`${label} contains unknown or missing fields.`);
	for (const key of actual) {
		if (Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true)
			throw new Error(`${label} contains a non-enumerable field.`);
	}
}

function assertCanonicalArray(value: unknown, label: string): asserts value is readonly unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be a canonical array.`);
	const ownKeys = Reflect.ownKeys(value);
	if (
		Object.getPrototypeOf(value) !== Array.prototype ||
		ownKeys.length !== value.length + 1 ||
		!ownKeys.includes("length") ||
		ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key))) ||
		Array.from({ length: value.length }, (_, index) => String(index)).some((key) => !ownKeys.includes(key))
	)
		throw new Error(`${label} contains holes, symbols, or extra fields.`);
	for (let index = 0; index < value.length; index += 1) {
		if (Object.getOwnPropertyDescriptor(value, String(index))?.enumerable !== true)
			throw new Error(`${label} contains a non-enumerable item.`);
	}
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim())
		throw new Error(`${label} must be a non-empty canonical identifier.`);
}

function assertNullableIdentifier(value: string | null, label: string): void {
	if (value !== null) assertIdentifier(value, label);
}

function assertPublicBoundary(value: unknown, label: string): asserts value is string {
	if (
		typeof value !== "string" ||
		!/^((public)|(protected)):[a-z0-9][a-z0-9._-]*$/u.test(value) ||
		value.includes("_for_test") ||
		value.includes("private")
	)
		throw new Error(`${label} must name a public or protected boundary, never a private test seam.`);
}

function assertDigest(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !DIGEST_PATTERN.test(value))
		throw new Error(`${label} must be a lowercase SHA-256 digest.`);
}

function isFailureClass(value: unknown): value is WorkflowIntentRedFailureClass {
	return (
		value === "assertion_failure" ||
		value === "setup_error" ||
		value === "test_error" ||
		value === "infrastructure_error"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneFrozen<T>(value: T): T {
	const clone = structuredClone(value);
	const freeze = (candidate: unknown): void => {
		if (typeof candidate !== "object" || candidate === null || Object.isFrozen(candidate)) return;
		for (const child of Object.values(candidate)) freeze(child);
		Object.freeze(candidate);
	};
	freeze(clone);
	return clone;
}
