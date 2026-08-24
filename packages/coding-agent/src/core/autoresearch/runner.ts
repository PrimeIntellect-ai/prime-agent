import type { WorkflowArtifactRef } from "../workflow/contracts.js";
import { digestObject } from "../workflow/contracts.js";
import { createNativeExperimentEngine, validateAutoResearchRegistration } from "./engine.js";
import { type AutoResearchRunHostAuthority, resolveAutoResearchArtifactRefs } from "./runtime-adapter.js";
import type {
	AutoResearchCandidateRequest,
	AutoResearchEvaluation,
	AutoResearchExperimentRegistration,
	AutoResearchHostPorts,
	AutoResearchRawObservation,
	AutoResearchTaskReceipt,
} from "./types.js";

const SHA256_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_EVIDENCE_REFS = 32;
const RAW_RESULT_KEYS = ["rawResultRefs"] as const;
const CANDIDATE_PLAN_KEYS = ["candidate", "hypothesis", "observationId"] as const;
const CANDIDATE_HYPOTHESIS_KEYS = [
	"expectedGeneralization",
	"falsificationDigest",
	"falsificationCondition",
	"hypothesisDigest",
	"kind",
	"mechanism",
	"mechanismDigest",
	"parameterChanges",
	"parameterOnly",
	"solutionFamily",
	"solutionFamilyDigest",
	"structuralChanges",
] as const;
const INDEPENDENCE_REVIEW_KEYS = [
	"disposition",
	"parameterHunting",
	"reason",
	"reviewDigest",
	"reviewerRole",
	"reviewedCandidateDigest",
	"reviewedHypothesisDigest",
] as const;
const PARAMETER_HUNTING_PATTERN =
	/\b(?:batch[ _-]?size|concurrenc(?:y|ies)|hyperparameter|parameter|prompt|retries|retry|temperature|threshold|timeout|top[ _-]?k|top[ _-]?p|tuning|weight)\b|(?:increase|decrease|raise|lower|set|sweep|try)\s+[^.]{0,48}\b(?:count|limit|rate|size|value)\b/iu;
const MAX_HYPOTHESIS_TEXT_BYTES = 4096;
const CANDIDATE_REQUEST_KEYS = [
	"attemptId",
	"baseRevisionDigest",
	"candidateId",
	"changeDigest",
	"claimedCompletion",
	"claimedPromotion",
	"resourceRequest",
] as const;
const ACCELERATOR_RESOURCE_KEYS = ["count", "deviceType", "memoryBytes", "poolId"] as const;
const PROVIDER_RESOURCE_KEYS = [
	"concurrentRequests",
	"idempotency",
	"inputTokens",
	"outputTokens",
	"poolId",
	"requestsPerMinute",
	"totalRequests",
] as const;
const DURABLE_RECIPE_KEYS = ["candidates", "recipeDigest", "registration"] as const;
const REGISTRATION_KEYS = [
	"commandInputBinding",
	"evaluator",
	"fixtures",
	"guard",
	"hiddenHoldout",
	"maxCandidates",
	"maxCostMicrounits",
	"maxLatencyMilliseconds",
	"maxVariance",
	"metric",
	"requiredSampleSize",
	"resourceCeiling",
	"revisionResolution",
	"runId",
	"seed",
	"workflowId",
] as const;

export interface AutoResearchCandidatePlan {
	readonly observationId: string;
	readonly candidate: AutoResearchCandidateRequest;
	readonly hypothesis: AutoResearchCandidateHypothesis;
}

export interface AutoResearchCandidateHypothesis {
	readonly kind: "independent_solution" | "parameter_tuning";
	readonly solutionFamily: string;
	readonly mechanism: string;
	readonly falsificationCondition: string;
	readonly expectedGeneralization: string;
	readonly structuralChanges: readonly string[];
	readonly parameterChanges: readonly string[];
	readonly solutionFamilyDigest: string;
	readonly mechanismDigest: string;
	readonly falsificationDigest: string;
	readonly parameterOnly: boolean;
	readonly hypothesisDigest: string;
}

export interface AutoResearchCandidateIndependenceReview {
	readonly reviewerRole: "red_team";
	readonly disposition: "approved" | "rejected";
	readonly reviewedCandidateDigest: string;
	readonly reviewedHypothesisDigest: string;
	readonly parameterHunting: boolean;
	readonly reason: string;
	readonly reviewDigest: string;
}

export interface AutoResearchCandidateIndependenceReviewInput {
	readonly workflowId: string;
	readonly recipeDigest: string;
	readonly candidate: AutoResearchCandidateRequest;
	readonly hypothesis: AutoResearchCandidateHypothesis;
	readonly priorHypotheses: readonly AutoResearchCandidateHypothesis[];
}

export type AutoResearchCandidateIndependenceReviewer = (
	input: AutoResearchCandidateIndependenceReviewInput,
) => Promise<AutoResearchCandidateIndependenceReview>;

/** Immutable recipe resolved by the host from its durable workflow snapshots. */
export interface AutoResearchDurableRecipe {
	readonly recipeDigest: string;
	readonly registration: AutoResearchExperimentRegistration;
	readonly candidates: readonly AutoResearchCandidatePlan[];
}

export interface AutoResearchProductionRunRequest {
	readonly recipeDigest: string;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && SHA256_DIGEST.test(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function isArtifactRef(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		hasExactKeys(value, ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"]) &&
		isNonEmptyString(value.artifactId) &&
		isNonEmptyString(value.relativePath) &&
		isDigest(value.digest) &&
		isSafeInteger(value.sizeBytes) &&
		value.sizeBytes >= 0 &&
		isSafeInteger(value.sourceEventSequence) &&
		value.sourceEventSequence >= 0
	);
}

function isResourceVector(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (
		!hasExactKeys(value, [
			"accelerators",
			"cpuMilliCores",
			"diskBytes",
			"ioWeight",
			"memoryBytes",
			"monetaryMicrounits",
			"networkEgressBytes",
			"providers",
			"wallMilliseconds",
		]) ||
		!isFiniteNumber(value.cpuMilliCores) ||
		!isFiniteNumber(value.memoryBytes) ||
		!isFiniteNumber(value.diskBytes) ||
		!isFiniteNumber(value.ioWeight) ||
		!isFiniteNumber(value.networkEgressBytes) ||
		!isFiniteNumber(value.wallMilliseconds) ||
		!isFiniteNumber(value.monetaryMicrounits) ||
		!Array.isArray(value.accelerators) ||
		!Array.isArray(value.providers) ||
		value.accelerators.length > 128 ||
		value.providers.length > 128
	)
		return false;
	const finiteNonNegative = (entry: unknown): entry is number => isFiniteNumber(entry) && entry >= 0;
	const acceleratorsValid = value.accelerators.every((entry) => {
		if (
			!isRecord(entry) ||
			!hasExactKeys(entry, ACCELERATOR_RESOURCE_KEYS) ||
			!isNonEmptyString(entry.poolId) ||
			!isNonEmptyString(entry.deviceType) ||
			!finiteNonNegative(entry.count) ||
			!finiteNonNegative(entry.memoryBytes)
		)
			return false;
		return true;
	});
	const providersValid = value.providers.every((entry) => {
		if (
			!isRecord(entry) ||
			!hasExactKeys(entry, PROVIDER_RESOURCE_KEYS) ||
			!isNonEmptyString(entry.poolId) ||
			!finiteNonNegative(entry.concurrentRequests) ||
			!finiteNonNegative(entry.requestsPerMinute) ||
			!finiteNonNegative(entry.totalRequests) ||
			!finiteNonNegative(entry.inputTokens) ||
			!finiteNonNegative(entry.outputTokens) ||
			(entry.idempotency !== "provider_native" &&
				entry.idempotency !== "host_reconciled" &&
				entry.idempotency !== "none")
		)
			return false;
		return true;
	});
	return (
		acceleratorsValid &&
		providersValid &&
		new Set(value.accelerators.map((entry) => (entry as Record<string, unknown>).poolId)).size ===
			value.accelerators.length &&
		new Set(value.providers.map((entry) => (entry as Record<string, unknown>).poolId)).size === value.providers.length
	);
}

function isHostReceipt(value: unknown, workflowId: string): boolean {
	if (!isRecord(value)) return false;
	return (
		hasExactKeys(value, [
			"artifactBytesDigest",
			"artifactRef",
			"bindingDigest",
			"issuedAt",
			"issuerId",
			"keyId",
			"oneUse",
			"payloadDigest",
			"receiptId",
			"receiptKind",
			"revision",
			"signature",
			"signatureAlgorithm",
			"stateDigest",
			"validUntil",
			"verificationDigest",
			"workflowId",
		]) &&
		value.workflowId === workflowId &&
		isNonEmptyString(value.receiptKind) &&
		typeof value.oneUse === "boolean" &&
		isNonEmptyString(value.receiptId) &&
		isNonEmptyString(value.issuerId) &&
		isDigest(value.bindingDigest) &&
		isDigest(value.payloadDigest) &&
		isArtifactRef(value.artifactRef) &&
		isNonEmptyString(value.issuedAt) &&
		isNonEmptyString(value.validUntil) &&
		isNonEmptyString(value.keyId) &&
		value.signatureAlgorithm === "ed25519" &&
		isDigest(value.artifactBytesDigest) &&
		isDigest(value.stateDigest) &&
		isSafeInteger(value.revision) &&
		value.revision >= 1 &&
		isNonEmptyString(value.signature) &&
		isDigest(value.verificationDigest)
	);
}

function isDurableRecipe(
	value: unknown,
	binding: { recipeDigest: string; workflowId: string },
): value is AutoResearchDurableRecipe {
	if (!isRecord(value) || !hasExactKeys(value, DURABLE_RECIPE_KEYS)) return false;
	if (value.recipeDigest !== binding.recipeDigest || !isDigest(value.recipeDigest) || !isRecord(value.registration))
		return false;
	const registration = value.registration;
	if (
		!hasExactKeys(registration, REGISTRATION_KEYS) ||
		!isNonEmptyString(registration.runId) ||
		registration.workflowId !== binding.workflowId ||
		!isRecord(registration.revisionResolution) ||
		!isRecord(registration.metric) ||
		!isRecord(registration.evaluator) ||
		!isRecord(registration.commandInputBinding) ||
		!isRecord(registration.seed) ||
		!Array.isArray(registration.fixtures) ||
		(registration.guard !== null && !isRecord(registration.guard)) ||
		!isResourceVector(registration.resourceCeiling) ||
		!isSafeInteger(registration.requiredSampleSize) ||
		registration.requiredSampleSize < 1 ||
		!isSafeInteger(registration.maxCandidates) ||
		registration.maxCandidates < 1 ||
		!isFiniteNumber(registration.maxVariance) ||
		registration.maxVariance < 0 ||
		!isFiniteNumber(registration.maxCostMicrounits) ||
		registration.maxCostMicrounits < 0 ||
		!isFiniteNumber(registration.maxLatencyMilliseconds) ||
		registration.maxLatencyMilliseconds < 0
	)
		return false;
	const revisionResolution = registration.revisionResolution;
	if (
		!hasExactKeys(revisionResolution, [
			"casExecutionKey",
			"compatibilityClosureDigest",
			"expectedRegistryEpoch",
			"hostReceipt",
			"observedRegistryEpoch",
			"registryEntryId",
			"registryEntryRef",
			"registryEpoch",
			"registryStatus",
			"revisionKind",
			"revocationEpoch",
			"revocationEventSequence",
			"rollbackOfRevisionId",
			"rollbackEventSequence",
			"scope",
			"scopeBinding",
			"resolutionDigest",
		]) ||
		!isArtifactRef(revisionResolution.registryEntryRef) ||
		!isNonEmptyString(revisionResolution.registryEntryId) ||
		!isSafeInteger(revisionResolution.registryEpoch) ||
		revisionResolution.registryEpoch < 1 ||
		revisionResolution.registryStatus !== "approved" ||
		!isDigest(revisionResolution.compatibilityClosureDigest) ||
		!isSafeInteger(revisionResolution.expectedRegistryEpoch) ||
		!isSafeInteger(revisionResolution.observedRegistryEpoch) ||
		!isNonEmptyString(revisionResolution.casExecutionKey) ||
		!isHostReceipt(revisionResolution.hostReceipt, binding.workflowId) ||
		!isDigest(revisionResolution.resolutionDigest) ||
		!isNonEmptyString(revisionResolution.revisionKind) ||
		!isNonEmptyString(revisionResolution.scope) ||
		!isRecord(revisionResolution.scopeBinding)
	)
		return false;
	const metric = registration.metric;
	if (
		!hasExactKeys(metric, ["direction", "metricId", "name", "target", "tolerance"]) ||
		!isNonEmptyString(metric.metricId) ||
		!isNonEmptyString(metric.name) ||
		(metric.direction !== "lower" && metric.direction !== "higher") ||
		!isFiniteNumber(metric.target) ||
		!isFiniteNumber(metric.tolerance) ||
		metric.tolerance < 0
	)
		return false;
	const evaluator = registration.evaluator;
	if (
		!hasExactKeys(evaluator, ["commandDigest", "evaluatorDigest", "parserDigest"]) ||
		!isDigest(evaluator.commandDigest) ||
		!isDigest(evaluator.evaluatorDigest) ||
		!isDigest(evaluator.parserDigest)
	)
		return false;
	const commandInputBinding = registration.commandInputBinding;
	if (
		!hasExactKeys(commandInputBinding, ["bindingDigest", "commandDigest", "inputDigests"]) ||
		!isDigest(commandInputBinding.bindingDigest) ||
		!isDigest(commandInputBinding.commandDigest) ||
		!Array.isArray(commandInputBinding.inputDigests) ||
		!commandInputBinding.inputDigests.every(isDigest)
	)
		return false;
	const seed = registration.seed;
	if (!hasExactKeys(seed, ["seedDigest", "seedId"]) || !isDigest(seed.seedDigest) || !isNonEmptyString(seed.seedId))
		return false;
	if (
		!registration.fixtures.every((fixture) => {
			if (!isRecord(fixture)) return false;
			return (
				hasExactKeys(fixture, ["fixtureId", "hidden", "inputDigest", "manifestDigest", "partition"]) &&
				isNonEmptyString(fixture.fixtureId) &&
				isDigest(fixture.inputDigest) &&
				isDigest(fixture.manifestDigest) &&
				typeof fixture.hidden === "boolean" &&
				isNonEmptyString(fixture.partition)
			);
		}) ||
		!registration.fixtures.length
	)
		return false;
	if (
		registration.guard !== null &&
		(!hasExactKeys(registration.guard, ["guardDigest"]) || !isDigest(registration.guard.guardDigest))
	)
		return false;
	if (
		registration.hiddenHoldout !== null &&
		(!isRecord(registration.hiddenHoldout) ||
			!hasExactKeys(registration.hiddenHoldout, [
				"bytesAccessibleToProposer",
				"bytesAccessibleToWorker",
				"caseCount",
				"handleId",
				"hidden",
				"hostResolverOnly",
				"manifestDigest",
				"opaque",
				"owner",
			]) ||
			!isNonEmptyString(registration.hiddenHoldout.handleId) ||
			!isDigest(registration.hiddenHoldout.manifestDigest) ||
			!isSafeInteger(registration.hiddenHoldout.caseCount) ||
			registration.hiddenHoldout.caseCount < 1 ||
			registration.hiddenHoldout.owner !== "host" ||
			registration.hiddenHoldout.hidden !== true ||
			registration.hiddenHoldout.opaque !== true ||
			registration.hiddenHoldout.hostResolverOnly !== true ||
			registration.hiddenHoldout.bytesAccessibleToProposer !== false ||
			registration.hiddenHoldout.bytesAccessibleToWorker !== false)
	)
		return false;
	if (!Array.isArray(value.candidates) || value.candidates.length === 0) return false;
	return value.candidates.every((plan) => {
		if (!isRecord(plan) || !hasExactKeys(plan, CANDIDATE_PLAN_KEYS) || !isNonEmptyString(plan.observationId))
			return false;
		const candidate = plan.candidate;
		const hypothesis = plan.hypothesis;
		return (
			isRecord(candidate) &&
			hasExactKeys(candidate, CANDIDATE_REQUEST_KEYS) &&
			isNonEmptyString(candidate.candidateId) &&
			isNonEmptyString(candidate.attemptId) &&
			isDigest(candidate.changeDigest) &&
			isDigest(candidate.baseRevisionDigest) &&
			isResourceVector(candidate.resourceRequest) &&
			candidate.claimedCompletion === false &&
			candidate.claimedPromotion === false &&
			isRecord(hypothesis) &&
			hasExactKeys(hypothesis, CANDIDATE_HYPOTHESIS_KEYS) &&
			(hypothesis.kind === "independent_solution" || hypothesis.kind === "parameter_tuning") &&
			isNonEmptyString(hypothesis.solutionFamily) &&
			isNonEmptyString(hypothesis.mechanism) &&
			isNonEmptyString(hypothesis.falsificationCondition) &&
			isNonEmptyString(hypothesis.expectedGeneralization) &&
			Array.isArray(hypothesis.structuralChanges) &&
			hypothesis.structuralChanges.every(isNonEmptyString) &&
			Array.isArray(hypothesis.parameterChanges) &&
			hypothesis.parameterChanges.every(isNonEmptyString) &&
			isDigest(hypothesis.solutionFamilyDigest) &&
			isDigest(hypothesis.mechanismDigest) &&
			isDigest(hypothesis.falsificationDigest) &&
			typeof hypothesis.parameterOnly === "boolean" &&
			isDigest(hypothesis.hypothesisDigest)
		);
	});
}

export interface AutoResearchApprovedCandidateExecutionInput {
	readonly recipeDigest: string;
	readonly registrationDigest: string;
	readonly candidate: AutoResearchCandidateRequest;
	readonly task: AutoResearchTaskReceipt;
	readonly visibleInputDigests: readonly string[];
}

/** Approved process/tool output. Workers return references only; the host measures them. */
export interface AutoResearchApprovedCandidateExecutionResult {
	readonly rawResultRefs: readonly WorkflowArtifactRef[];
}

export type AutoResearchDurableRecipeResolver = (recipeDigest: string) => Promise<AutoResearchDurableRecipe>;

export type AutoResearchApprovedCandidateExecutor = (
	input: AutoResearchApprovedCandidateExecutionInput,
) => Promise<AutoResearchApprovedCandidateExecutionResult>;

export interface AutoResearchPythonArtifactRef {
	readonly artifact_id: string;
	readonly relative_path: string;
	readonly digest: string;
	readonly size_bytes: number;
	readonly source_event_sequence: number;
}

export interface AutoResearchPythonResult extends Readonly<Record<string, unknown>> {
	readonly skill_id: "autoresearch";
	readonly output_kind: "evidence" | "knowledge_proposal";
	readonly evidence_refs: readonly AutoResearchPythonArtifactRef[];
	readonly durable_knowledge_boundary_digest: string | null;
	readonly transient_state_refs: readonly [];
	readonly can_authorize: false;
	readonly output_digest: string;
}

export interface AutoResearchProductionRunnerFactoryInput {
	readonly host: AutoResearchHostPorts;
	readonly authority: AutoResearchRunHostAuthority;
	readonly resolveRecipe: AutoResearchDurableRecipeResolver;
	readonly reviewCandidateIndependence?: AutoResearchCandidateIndependenceReviewer;
	readonly executeCandidate: AutoResearchApprovedCandidateExecutor;
}

export interface AutoResearchProductionRunner {
	run(input: AutoResearchProductionRunRequest): Promise<AutoResearchPythonResult>;
}

function fail(code: string, message: string): never {
	throw new Error(`autoresearch_runner_${code}: ${message}`);
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	if (ArrayBuffer.isView(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}

function immutableCopy<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

function assertDigest(value: string, label: string): void {
	if (!SHA256_DIGEST.test(value)) fail("digest_invalid", `${label} must be a lowercase sha256 digest`);
}

function assertRecipeRequest(input: AutoResearchProductionRunRequest): void {
	if (
		typeof input !== "object" ||
		input === null ||
		Array.isArray(input) ||
		typeof input.recipeDigest !== "string" ||
		!Array.isArray(input.evidenceRefs)
	)
		fail("request_invalid", "recipe and evidence references are required");
	assertDigest(input.recipeDigest, "recipeDigest");
	if (input.evidenceRefs.length > MAX_EVIDENCE_REFS) fail("evidence_invalid", "too many evidence references");
}

/** Bind one semantic mechanism hypothesis to its canonical content. */
export function autoResearchCandidateHypothesisDigest(
	hypothesis: Omit<AutoResearchCandidateHypothesis, "hypothesisDigest">,
): string {
	return digestObject(hypothesis);
}

/** Bind an adversarial independence review to one exact candidate mechanism. */
export function autoResearchIndependenceReviewDigest(
	review: Omit<AutoResearchCandidateIndependenceReview, "reviewDigest">,
): string {
	return digestObject(review);
}

function normalizedMechanismText(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function assertBoundedHypothesisText(value: string, label: string): void {
	if (new TextEncoder().encode(value).byteLength > MAX_HYPOTHESIS_TEXT_BYTES)
		fail("candidate_plan_invalid", `${label} is unbounded`);
}

function semanticHypothesisFingerprint(hypothesis: AutoResearchCandidateHypothesis): string {
	return digestObject({
		solutionFamily: normalizedMechanismText(hypothesis.solutionFamily),
		mechanism: normalizedMechanismText(hypothesis.mechanism),
		structuralChanges: hypothesis.structuralChanges.map(normalizedMechanismText).sort(),
	});
}

function hypothesisContainsParameterHunting(hypothesis: AutoResearchCandidateHypothesis): boolean {
	const searchable = [hypothesis.solutionFamily, hypothesis.mechanism, ...hypothesis.structuralChanges].join("\n");
	return PARAMETER_HUNTING_PATTERN.test(searchable);
}

/** Build the mandatory host-side adversarial reviewer for candidate mechanism independence. */
export function createAutoResearchNoParameterHuntingReviewer(): AutoResearchCandidateIndependenceReviewer {
	return async (input) => {
		const family = normalizedMechanismText(input.hypothesis.solutionFamily);
		const mechanism = semanticHypothesisFingerprint(input.hypothesis);
		const repeatsPriorMechanism = input.priorHypotheses.some(
			(prior) =>
				normalizedMechanismText(prior.solutionFamily) === family ||
				semanticHypothesisFingerprint(prior) === mechanism,
		);
		const parameterHunting =
			input.hypothesis.kind !== "independent_solution" ||
			input.hypothesis.parameterOnly ||
			input.hypothesis.parameterChanges.length !== 0 ||
			hypothesisContainsParameterHunting(input.hypothesis) ||
			repeatsPriorMechanism;
		const withoutDigest = {
			reviewerRole: "red_team" as const,
			disposition: parameterHunting ? ("rejected" as const) : ("approved" as const),
			reviewedCandidateDigest: digestObject(input.candidate),
			reviewedHypothesisDigest: input.hypothesis.hypothesisDigest,
			parameterHunting,
			reason: parameterHunting
				? "candidate is parameter tuning or repeats an existing solution mechanism"
				: "candidate is a distinct falsifiable solution mechanism",
		};
		return deepFreeze({ ...withoutDigest, reviewDigest: autoResearchIndependenceReviewDigest(withoutDigest) });
	};
}

function assertRecipeShape(
	recipe: AutoResearchDurableRecipe,
	expectedWorkflowId: string,
	expectedRecipeDigest: string,
): void {
	if (
		typeof recipe !== "object" ||
		recipe === null ||
		Array.isArray(recipe) ||
		typeof recipe.recipeDigest !== "string" ||
		!isRecord(recipe.registration) ||
		!Array.isArray(recipe.candidates)
	)
		fail("recipe_invalid", "host recipe shape is invalid");
	if (recipe.recipeDigest !== expectedRecipeDigest) fail("recipe_binding", "resolved recipe digest changed");
	assertDigest(recipe.recipeDigest, "recipeDigest");
	if (recipe.registration.workflowId !== expectedWorkflowId) fail("workflow_binding", "recipe workflow changed");
	validateAutoResearchRegistration(recipe.registration);
	if (recipe.candidates.length === 0) fail("candidate_plan_missing", "recipe has no candidate plan");
	if (recipe.candidates.length > 256) fail("candidate_plan_invalid", "candidate plan is unbounded");
	const candidateIds = new Set<string>();
	const observationIds = new Set<string>();
	const changeDigests = new Set<string>();
	const solutionFamilies = new Set<string>();
	const mechanisms = new Set<string>();
	for (const plan of recipe.candidates) {
		const candidate = plan.candidate;
		const hypothesis = plan.hypothesis;
		if (
			JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify([...CANDIDATE_PLAN_KEYS].sort()) ||
			typeof plan.observationId !== "string" ||
			plan.observationId.length === 0 ||
			JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify([...CANDIDATE_REQUEST_KEYS].sort()) ||
			candidate.claimedCompletion !== false ||
			candidate.claimedPromotion !== false ||
			typeof candidate.candidateId !== "string"
		)
			fail("candidate_plan_invalid", "candidate plan is not host-bound");
		if (
			hypothesis.kind !== "independent_solution" ||
			hypothesis.parameterOnly ||
			hypothesis.parameterChanges.length !== 0 ||
			hypothesis.structuralChanges.length === 0 ||
			hypothesis.structuralChanges.length > 32 ||
			hypothesisContainsParameterHunting(hypothesis)
		)
			fail(
				"parameter_hunting_forbidden",
				"AutoResearch candidates must test independent solution mechanisms, not tuned parameters",
			);
		const hypothesisTexts: Array<readonly [string, string]> = [
			["solution family", hypothesis.solutionFamily],
			["mechanism", hypothesis.mechanism],
			["falsification condition", hypothesis.falsificationCondition],
			["expected generalization", hypothesis.expectedGeneralization],
			...hypothesis.structuralChanges.map(
				(value: string, index: number) => [`structural change ${String(index)}`, value] as const,
			),
		];
		for (const [label, value] of hypothesisTexts) assertBoundedHypothesisText(value, label);
		const hypothesisWithoutDigest = {
			kind: hypothesis.kind,
			solutionFamily: hypothesis.solutionFamily,
			mechanism: hypothesis.mechanism,
			falsificationCondition: hypothesis.falsificationCondition,
			expectedGeneralization: hypothesis.expectedGeneralization,
			structuralChanges: hypothesis.structuralChanges,
			parameterChanges: hypothesis.parameterChanges,
			solutionFamilyDigest: hypothesis.solutionFamilyDigest,
			mechanismDigest: hypothesis.mechanismDigest,
			falsificationDigest: hypothesis.falsificationDigest,
			parameterOnly: hypothesis.parameterOnly,
		};
		if (
			hypothesis.solutionFamilyDigest !==
				digestObject({ solutionFamily: normalizedMechanismText(hypothesis.solutionFamily) }) ||
			hypothesis.mechanismDigest !==
				digestObject({
					mechanism: normalizedMechanismText(hypothesis.mechanism),
					structuralChanges: hypothesis.structuralChanges.map(normalizedMechanismText).sort(),
				}) ||
			hypothesis.falsificationDigest !==
				digestObject({ falsificationCondition: normalizedMechanismText(hypothesis.falsificationCondition) }) ||
			hypothesis.hypothesisDigest !== autoResearchCandidateHypothesisDigest(hypothesisWithoutDigest)
		)
			fail("candidate_plan_invalid", "candidate hypothesis digests are not bound to canonical semantics");
		if (candidateIds.has(candidate.candidateId)) fail("candidate_plan_invalid", "candidate IDs must be unique");
		if (observationIds.has(plan.observationId)) fail("candidate_plan_invalid", "observation IDs must be unique");
		if (changeDigests.has(candidate.changeDigest))
			fail("parameter_hunting_forbidden", "candidate changes must be unique within a run");
		const solutionFamily = normalizedMechanismText(hypothesis.solutionFamily);
		const mechanism = semanticHypothesisFingerprint(hypothesis);
		if (solutionFamilies.has(solutionFamily))
			fail("parameter_hunting_forbidden", "candidate solution families must be independent within a run");
		if (mechanisms.has(mechanism))
			fail("parameter_hunting_forbidden", "candidate mechanisms must be independent within a run");
		candidateIds.add(candidate.candidateId);
		observationIds.add(plan.observationId);
		changeDigests.add(candidate.changeDigest);
		solutionFamilies.add(solutionFamily);
		mechanisms.add(mechanism);
	}
}

async function assertIndependentCandidateReviews(
	recipe: AutoResearchDurableRecipe,
	workflowId: string,
	reviewer: AutoResearchCandidateIndependenceReviewer,
): Promise<void> {
	const priorHypotheses: AutoResearchCandidateHypothesis[] = [];
	for (const plan of recipe.candidates) {
		const review = await reviewer(
			immutableCopy({
				workflowId,
				recipeDigest: recipe.recipeDigest,
				candidate: plan.candidate,
				hypothesis: plan.hypothesis,
				priorHypotheses,
			}),
		);
		if (
			!isRecord(review) ||
			!hasExactKeys(review, INDEPENDENCE_REVIEW_KEYS) ||
			review.reviewerRole !== "red_team" ||
			(review.disposition !== "approved" && review.disposition !== "rejected") ||
			typeof review.parameterHunting !== "boolean" ||
			!isNonEmptyString(review.reason) ||
			!isDigest(review.reviewedCandidateDigest) ||
			!isDigest(review.reviewedHypothesisDigest) ||
			!isDigest(review.reviewDigest)
		)
			fail("independence_review_invalid", "host red-team review has an invalid shape");
		const reviewWithoutDigest = {
			reviewerRole: review.reviewerRole,
			disposition: review.disposition,
			reviewedCandidateDigest: review.reviewedCandidateDigest,
			reviewedHypothesisDigest: review.reviewedHypothesisDigest,
			parameterHunting: review.parameterHunting,
			reason: review.reason,
		};
		if (
			review.reviewedCandidateDigest !== digestObject(plan.candidate) ||
			review.reviewedHypothesisDigest !== plan.hypothesis.hypothesisDigest ||
			review.reviewDigest !== autoResearchIndependenceReviewDigest(reviewWithoutDigest)
		)
			fail("independence_review_invalid", "host red-team review is not bound to the exact candidate");
		if (review.disposition !== "approved" || review.parameterHunting)
			fail("parameter_hunting_forbidden", review.reason);
		priorHypotheses.push(plan.hypothesis);
	}
}

/** Parse one closed, immutable durable recipe from a host snapshot. */
export function parseAutoResearchDurableRecipe(
	value: unknown,
	expectedWorkflowId: string,
	expectedRecipeDigest: string,
): AutoResearchDurableRecipe {
	if (typeof expectedWorkflowId !== "string" || expectedWorkflowId.length === 0)
		fail("workflow_binding", "expected workflow ID is required");
	assertDigest(expectedRecipeDigest, "expectedRecipeDigest");
	if (!isDurableRecipe(value, { recipeDigest: expectedRecipeDigest, workflowId: expectedWorkflowId }))
		fail("recipe_invalid", "host recipe shape is invalid");
	const recipe = immutableCopy(value);
	assertRecipeShape(recipe, expectedWorkflowId, expectedRecipeDigest);
	return recipe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
	return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function visibleInputs(registration: AutoResearchExperimentRegistration): readonly string[] {
	return registration.fixtures
		.filter((fixture) => fixture.partition === "train" || fixture.partition === "eval")
		.map((fixture) => fixture.inputDigest)
		.sort();
}

function assertExecutionResult(value: AutoResearchApprovedCandidateExecutionResult): readonly WorkflowArtifactRef[] {
	if (
		!isRecord(value) ||
		JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...RAW_RESULT_KEYS].sort()) ||
		!Array.isArray(value.rawResultRefs) ||
		value.rawResultRefs.length === 0 ||
		value.rawResultRefs.length > MAX_EVIDENCE_REFS
	)
		fail("execution_result_invalid", "approved execution must return bounded raw artifact references");
	return immutableCopy(value.rawResultRefs);
}

function candidateMatchesTask(candidate: AutoResearchCandidateRequest, task: AutoResearchTaskReceipt): boolean {
	return (
		task.taskId === candidate.candidateId &&
		task.candidateId === candidate.candidateId &&
		task.attemptId === candidate.attemptId &&
		task.changeDigest === candidate.changeDigest
	);
}

function toPythonRef(ref: WorkflowArtifactRef): AutoResearchPythonArtifactRef {
	return {
		artifact_id: ref.artifactId,
		relative_path: ref.relativePath,
		digest: ref.digest,
		size_bytes: ref.sizeBytes,
		source_event_sequence: ref.sourceEventSequence,
	};
}

function uniqueRefs(refs: readonly WorkflowArtifactRef[]): readonly WorkflowArtifactRef[] {
	const seen = new Set<string>();
	const unique: WorkflowArtifactRef[] = [];
	for (const ref of refs) {
		const key = `${ref.artifactId}:${ref.digest}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(ref);
	}
	if (unique.length > MAX_EVIDENCE_REFS) fail("evidence_invalid", "host output evidence is unbounded");
	return unique;
}

function resultFor(
	request: AutoResearchProductionRunRequest,
	recipeDigest: string,
	registrationDigest: string,
	evaluation: AutoResearchEvaluation,
	hostEvidence: {
		readonly holdoutEvidenceRefs: readonly WorkflowArtifactRef[];
		readonly adversarialEvidenceRefs: readonly WorkflowArtifactRef[];
	},
): AutoResearchPythonResult {
	const evidenceRefs = uniqueRefs([
		...request.evidenceRefs,
		...evaluation.evidenceRefs,
		...hostEvidence.holdoutEvidenceRefs,
		...hostEvidence.adversarialEvidenceRefs,
	]);
	const outputKind = evaluation.proposal === null ? "evidence" : "knowledge_proposal";
	const boundaryDigest = digestObject({
		kind: "autoresearch_evaluation",
		recipeDigest,
		registrationDigest,
		evaluation: {
			accepted: evaluation.accepted,
			reason: evaluation.reason,
			evidenceRefs,
			proposalDigest: evaluation.proposal === null ? null : digestObject(evaluation.proposal),
		},
	});
	const unsigned = {
		skill_id: "autoresearch" as const,
		output_kind: outputKind as "evidence" | "knowledge_proposal",
		evidence_refs: evidenceRefs.map(toPythonRef),
		durable_knowledge_boundary_digest: boundaryDigest,
		transient_state_refs: [] as const,
		can_authorize: false as const,
	};
	return deepFreeze({ ...unsigned, output_digest: digestObject(unsigned) });
}

function assertAuthority(input: AutoResearchProductionRunnerFactoryInput): void {
	if (
		!isRecord(input) ||
		!isRecord(input.host) ||
		!isRecord(input.authority) ||
		!isRecord(input.authority.runtimeStore) ||
		typeof input.resolveRecipe !== "function" ||
		(input.reviewCandidateIndependence !== undefined && typeof input.reviewCandidateIndependence !== "function") ||
		typeof input.executeCandidate !== "function"
	)
		fail("authority_missing", "host execution seams are required");
	if (input.authority.runtimeStore.durableContext === undefined)
		fail("authority_not_persisted", "production runner requires the persisted workflow store");
	if (input.authority.runtimeStore.identity.workflowId !== input.authority.workflowId)
		fail("workflow_binding", "runtime store and host authority workflow differ");
}

/**
 * Build the host-owned AutoResearch loop over one persisted runtime and approved execution seam.
 *
 * Args:
 * input: The exact host ports, persisted artifact/receipt authority, durable recipe resolver, and
 * approved process/tool executor. The executor receives no source text or hidden fixture bytes.
 * Return: A restart-safe runner whose result is evidence/proposal only.
 */
export function createAutoResearchProductionRunner(
	input: AutoResearchProductionRunnerFactoryInput,
): AutoResearchProductionRunner {
	assertAuthority(input);
	const run = async (request: AutoResearchProductionRunRequest): Promise<AutoResearchPythonResult> => {
		assertRecipeRequest(request);
		const recipe = parseAutoResearchDurableRecipe(
			await input.resolveRecipe(request.recipeDigest),
			input.authority.workflowId,
			request.recipeDigest,
		);
		await assertIndependentCandidateReviews(
			recipe,
			input.authority.workflowId,
			input.reviewCandidateIndependence ?? createAutoResearchNoParameterHuntingReviewer(),
		);
		const engine = await createNativeExperimentEngine(input.host);
		const registrationDigest = await engine.preRegister(recipe.registration);
		await engine.lock();
		const resolvedInputRefs = await resolveAutoResearchArtifactRefs(input.authority, request.evidenceRefs);
		const visibleInputDigests = visibleInputs(recipe.registration);
		let evaluation: AutoResearchEvaluation | null = null;
		for (const plan of recipe.candidates) {
			const existingEvaluation = await engine.evaluation(plan.observationId);
			if (existingEvaluation !== null) {
				evaluation = existingEvaluation;
				if (existingEvaluation.accepted) break;
				continue;
			}
			const persistedCandidate = await engine.candidate(plan.candidate.candidateId);
			if (persistedCandidate !== null && digestObject(persistedCandidate.request) !== digestObject(plan.candidate))
				fail("candidate_binding", "replayed candidate request differs from the durable plan");
			let task = persistedCandidate?.task ?? null;
			if (task !== null && !candidateMatchesTask(plan.candidate, task))
				fail("candidate_binding", "replayed task receipt differs from the durable candidate plan");
			if (task === null) task = await engine.submitCandidate(plan.candidate);
			const execution = await engine.execution(plan.observationId);
			if (execution?.status === "pending")
				fail(
					"execution_pending",
					"a prior process started this candidate without an authenticated raw-result handoff",
				);
			let resolvedRawResultRefs: readonly WorkflowArtifactRef[];
			if (execution?.status === "completed") {
				resolvedRawResultRefs = await resolveAutoResearchArtifactRefs(input.authority, execution.rawResultRefs);
			} else {
				const claim = await engine.beginCandidateExecution({
					observationId: plan.observationId,
					candidateId: plan.candidate.candidateId,
					attemptId: plan.candidate.attemptId,
				});
				if (!claim.acquired) fail("execution_pending", "another process owns the candidate execution intent");
				const executionResult = await input.executeCandidate(
					immutableCopy({
						recipeDigest: recipe.recipeDigest,
						registrationDigest,
						candidate: plan.candidate,
						task,
						visibleInputDigests,
					}),
				);
				const rawResultRefs = assertExecutionResult(executionResult);
				resolvedRawResultRefs = await resolveAutoResearchArtifactRefs(input.authority, rawResultRefs);
				await engine.completeCandidateExecution({
					observationId: plan.observationId,
					candidateId: plan.candidate.candidateId,
					attemptId: plan.candidate.attemptId,
					rawResultRefs: resolvedRawResultRefs,
				});
			}
			const rawObservation: AutoResearchRawObservation = immutableCopy({
				observationId: plan.observationId,
				candidateId: plan.candidate.candidateId,
				attemptId: plan.candidate.attemptId,
				rawResultRefs: resolvedRawResultRefs,
			});
			evaluation = await engine.recordObservation(rawObservation);
			if (evaluation.accepted) break;
		}
		if (evaluation === null) fail("evaluation_missing", "candidate execution produced no durable evaluation");
		const hostEvidence = await engine.hostEvidence();
		const resolvedHostEvidence = {
			holdoutEvidenceRefs: await resolveAutoResearchArtifactRefs(input.authority, hostEvidence.holdoutEvidenceRefs),
			adversarialEvidenceRefs: await resolveAutoResearchArtifactRefs(
				input.authority,
				hostEvidence.adversarialEvidenceRefs,
			),
		};
		return resultFor(
			{ ...request, evidenceRefs: resolvedInputRefs },
			recipe.recipeDigest,
			registrationDigest,
			evaluation,
			resolvedHostEvidence,
		);
	};
	return Object.freeze({ run });
}
