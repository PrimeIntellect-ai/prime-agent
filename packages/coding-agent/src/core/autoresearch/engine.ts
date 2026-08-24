import type {
	WorkflowArtifactRef,
	WorkflowDecisionRef,
	WorkflowImprovementProposal,
	WorkflowResourceVector,
} from "../workflow/contracts.js";
import { digestObject } from "../workflow/contracts.js";
import {
	type AutoResearchOverfittingReview,
	canProceedWithOverfittingReview,
	reviewOverfitting,
} from "./overfitting-review.js";
import type {
	AutoResearchCandidateRequest,
	AutoResearchCommandInputBinding,
	AutoResearchCommittedEvent,
	AutoResearchDecisionResolution,
	AutoResearchEngineSnapshot,
	AutoResearchEvaluation,
	AutoResearchEvidenceProof,
	AutoResearchEvidenceSubmission,
	AutoResearchExecutionState,
	AutoResearchExperimentRegistration,
	AutoResearchHoldoutResolverBinding,
	AutoResearchHostMeasurement,
	AutoResearchHostPorts,
	AutoResearchObservation,
	AutoResearchProposalCandidateInput,
	AutoResearchRawObservation,
	AutoResearchTaskReceipt,
	AutoResearchTaskSubmission,
} from "./types.js";

export type {
	AutoResearchCandidateRequest,
	AutoResearchCommandInputBinding,
	AutoResearchCommittedEvent,
	AutoResearchDecisionResolution,
	AutoResearchDecisionSubmission,
	AutoResearchEngineSnapshot,
	AutoResearchEvaluation,
	AutoResearchEvidenceProof,
	AutoResearchEvidenceSubmission,
	AutoResearchExecutionState,
	AutoResearchExperimentRegistration,
	AutoResearchHoldoutEvidence,
	AutoResearchHoldoutResolverBinding,
	AutoResearchHoldoutSubmission,
	AutoResearchHostMeasurement,
	AutoResearchHostOnlyHoldoutHandle,
	AutoResearchHostPorts,
	AutoResearchMetricRegistration,
	AutoResearchObservation,
	AutoResearchProposalCandidateInput,
	AutoResearchRawObservation,
	AutoResearchRuntimePort,
	AutoResearchRuntimeRecord,
	AutoResearchTaskReceipt,
	AutoResearchTaskSubmission,
} from "./types.js";

export class AutoResearchEngineError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AutoResearchEngineError";
		this.code = code;
	}
}

interface CandidateRecord {
	request: AutoResearchCandidateRequest;
	task: AutoResearchTaskReceipt;
}

/**
 * Ephemeral projection rebuilt from the host-owned runtime before every operation.
 * This projection is never the source of truth; only the host runtime commit is authoritative.
 */
interface EngineProjection {
	registration: AutoResearchExperimentRegistration | null;
	registrationDigest: string | null;
	preRegisteredDigest: string | null;
	locked: boolean;
	decisionRef: WorkflowDecisionRef | null;
	holdoutSubmitted: boolean;
	holdoutEvidenceRefs: readonly WorkflowArtifactRef[];
	adversarialEvidenceRefs: readonly WorkflowArtifactRef[];
	holdoutEvidenceProofs: readonly AutoResearchEvidenceProof[];
	adversarialEvidenceProofs: readonly AutoResearchEvidenceProof[];
	resolverContext: AutoResearchHoldoutResolverBinding | null;
	decisionResolution: AutoResearchDecisionResolution | null;
	candidates: Map<string, CandidateRecord>;
	observations: Map<string, AutoResearchObservation>;
	observationResults: Map<string, AutoResearchEvaluation>;
	proposals: Map<string, WorkflowImprovementProposal>;
	executions: Map<string, AutoResearchExecutionState>;
	totalCostMicrounits: number;
	totalLatencyMilliseconds: number;
	resourceUsage: WorkflowResourceVector;
	pendingAcceptedProposals: Map<string, Extract<AutoResearchCommittedEvent, { kind: "accepted_proposal_intent" }>>;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}

function immutableCopy<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HOLDOUT_HANDLE_KEYS = [
	"bytesAccessibleToProposer",
	"bytesAccessibleToWorker",
	"caseCount",
	"handleId",
	"hidden",
	"hostResolverOnly",
	"manifestDigest",
	"opaque",
	"owner",
] as const;
const HOLDOUT_RESOLVER_KEYS = [
	"authenticated",
	"contextId",
	"epochRef",
	"handleId",
	"manifestDigest",
	"registrationDigest",
	"returnsBytes",
	"returnsEvidenceOnly",
	"resolverDigest",
	"stateDigest",
	"workflowId",
] as const;
const FIXTURE_KEYS = ["fixtureId", "hidden", "inputDigest", "manifestDigest", "partition"] as const;
const EVIDENCE_PROOF_KEYS = [
	"authenticated",
	"fresh",
	"kind",
	"proofDigest",
	"ref",
	"registrationDigest",
	"revoked",
	"workflowId",
] as const;
const ARTIFACT_REF_KEYS = ["artifactId", "digest", "relativePath", "sizeBytes", "sourceEventSequence"] as const;
const MAX_ARTIFACT_REF_BYTES = 8_388_608;
const RAW_OBSERVATION_KEYS = ["attemptId", "candidateId", "observationId", "rawResultRefs"] as const;
const OBSERVATION_KEYS = [
	"adversarialMetricValue",
	"candidateClaimedCompletion",
	"candidateClaimedPromotion",
	"commandInputBinding",
	"costMicrounits",
	"evalInputDigest",
	"evaluatorDigest",
	"fixtureManifestDigest",
	"guardDigest",
	"heldOutInputDigest",
	"hiddenMetricValue",
	"latencyMilliseconds",
	"measurementDigest",
	"metricDirection",
	"metricTarget",
	"metricTolerance",
	"metricValue",
	"observationId",
	"parserDigest",
	"phase",
	"proxySignals",
	"rawResultRefsDigest",
	"resourceUsage",
	"sampleCount",
	"seedDigest",
	"source",
	"status",
	"trainInputDigest",
	"variance",
	"candidateId",
	"attemptId",
	"baselineMetricValue",
] as const;
const OBSERVATION_OPTIONAL_CLAIM_KEYS = ["claimedCompletion", "claimedPromotion"] as const;
const TASK_RECEIPT_KEYS = ["attemptId", "candidateId", "changeDigest", "taskDigest", "taskId"] as const;
const CANDIDATE_REQUEST_KEYS = [
	"attemptId",
	"baseRevisionDigest",
	"candidateId",
	"changeDigest",
	"claimedCompletion",
	"claimedPromotion",
	"resourceRequest",
] as const;
const HOST_RECEIPT_KEYS = [
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
] as const;

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
	return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function emptyResource(): WorkflowResourceVector {
	return {
		cpuMilliCores: 0,
		memoryBytes: 0,
		diskBytes: 0,
		ioWeight: 0,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 0,
		monetaryMicrounits: 0,
	};
}

function addResource(left: WorkflowResourceVector, right: WorkflowResourceVector): WorkflowResourceVector {
	const accelerators = new Map(left.accelerators.map((entry) => [entry.poolId, { ...entry }]));
	for (const entry of right.accelerators) {
		const current = accelerators.get(entry.poolId);
		if (current === undefined) accelerators.set(entry.poolId, { ...entry });
		else {
			current.count = safeAdd(current.count, entry.count, "accelerator count");
			current.memoryBytes = safeAdd(current.memoryBytes, entry.memoryBytes, "accelerator memory");
		}
	}
	const providers = new Map(left.providers.map((entry) => [entry.poolId, { ...entry }]));
	for (const entry of right.providers) {
		const current = providers.get(entry.poolId);
		if (current === undefined) providers.set(entry.poolId, { ...entry });
		else {
			current.concurrentRequests = safeAdd(
				current.concurrentRequests,
				entry.concurrentRequests,
				"concurrent requests",
			);
			current.requestsPerMinute = safeAdd(current.requestsPerMinute, entry.requestsPerMinute, "requests per minute");
			current.totalRequests = safeAdd(current.totalRequests, entry.totalRequests, "total requests");
			current.inputTokens = safeAdd(current.inputTokens, entry.inputTokens, "input tokens");
			current.outputTokens = safeAdd(current.outputTokens, entry.outputTokens, "output tokens");
		}
	}
	return {
		cpuMilliCores: safeAdd(left.cpuMilliCores, right.cpuMilliCores, "cpu usage"),
		memoryBytes: safeAdd(left.memoryBytes, right.memoryBytes, "memory usage"),
		diskBytes: safeAdd(left.diskBytes, right.diskBytes, "disk usage"),
		ioWeight: safeAdd(left.ioWeight, right.ioWeight, "io usage"),
		accelerators: [...accelerators.values()],
		providers: [...providers.values()],
		networkEgressBytes: safeAdd(left.networkEgressBytes, right.networkEgressBytes, "network usage"),
		wallMilliseconds: safeAdd(left.wallMilliseconds, right.wallMilliseconds, "wall usage"),
		monetaryMicrounits: safeAdd(left.monetaryMicrounits, right.monetaryMicrounits, "monetary usage"),
	};
}

function validateResourceVector(vector: WorkflowResourceVector, label: string): void {
	if (
		typeof vector !== "object" ||
		vector === null ||
		!Array.isArray(vector.accelerators) ||
		!Array.isArray(vector.providers)
	)
		throw new AutoResearchEngineError("invalid_registration", `${label} must be a complete resource vector`);
	for (const [name, value] of [
		["cpuMilliCores", vector.cpuMilliCores],
		["memoryBytes", vector.memoryBytes],
		["diskBytes", vector.diskBytes],
		["ioWeight", vector.ioWeight],
		["networkEgressBytes", vector.networkEgressBytes],
		["wallMilliseconds", vector.wallMilliseconds],
		["monetaryMicrounits", vector.monetaryMicrounits],
	] as const) {
		finiteNonNegative(value, `${label}.${name}`);
	}
	const acceleratorPools = new Set<string>();
	for (const accelerator of vector.accelerators) {
		if (
			typeof accelerator.poolId !== "string" ||
			accelerator.poolId.length === 0 ||
			acceleratorPools.has(accelerator.poolId)
		)
			throw new AutoResearchEngineError("invalid_registration", `${label} accelerator pools must be unique`);
		acceleratorPools.add(accelerator.poolId);
		finiteNonNegative(accelerator.count, `${label}.accelerators.${accelerator.poolId}.count`);
		finiteNonNegative(accelerator.memoryBytes, `${label}.accelerators.${accelerator.poolId}.memoryBytes`);
	}
	const providerPools = new Set<string>();
	for (const provider of vector.providers) {
		if (typeof provider.poolId !== "string" || provider.poolId.length === 0 || providerPools.has(provider.poolId))
			throw new AutoResearchEngineError("invalid_registration", `${label} provider pools must be unique`);
		providerPools.add(provider.poolId);
		finiteNonNegative(provider.concurrentRequests, `${label}.providers.${provider.poolId}.concurrentRequests`);
		finiteNonNegative(provider.requestsPerMinute, `${label}.providers.${provider.poolId}.requestsPerMinute`);
		finiteNonNegative(provider.totalRequests, `${label}.providers.${provider.poolId}.totalRequests`);
		finiteNonNegative(provider.inputTokens, `${label}.providers.${provider.poolId}.inputTokens`);
		finiteNonNegative(provider.outputTokens, `${label}.providers.${provider.poolId}.outputTokens`);
	}
}

function finiteNonNegative(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
		throw new AutoResearchEngineError("invalid_registration", `${label} must be finite and non-negative`);
}

function safeAdd(left: number, right: number, label: string): number {
	if (!Number.isFinite(left) || !Number.isFinite(right) || left < 0 || right < 0) {
		throw new AutoResearchEngineError("numeric_overflow", `${label} operands must be finite and non-negative`);
	}
	const result = left + right;
	if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER)
		throw new AutoResearchEngineError("numeric_overflow", `${label} exceeds the safe numeric range`);
	return result;
}

function safeMetricBounds(target: number, tolerance: number): void {
	if (
		!Number.isFinite(target) ||
		!Number.isFinite(tolerance) ||
		tolerance < 0 ||
		Math.abs(target) > Number.MAX_SAFE_INTEGER ||
		tolerance > Number.MAX_SAFE_INTEGER
	)
		throw new AutoResearchEngineError("invalid_registration", "metric target and tolerance must be finite");
	if (
		!Number.isFinite(target + tolerance) ||
		!Number.isFinite(target - tolerance) ||
		Math.abs(target + tolerance) > Number.MAX_SAFE_INTEGER ||
		Math.abs(target - tolerance) > Number.MAX_SAFE_INTEGER
	)
		throw new AutoResearchEngineError("numeric_overflow", "metric target/tolerance arithmetic overflows");
}

function exactArray(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validateCandidateRequest(request: AutoResearchCandidateRequest, label: string): void {
	if (!hasExactKeys(request, CANDIDATE_REQUEST_KEYS))
		throw new AutoResearchEngineError("candidate_invalid", `${label} contains unexpected fields`);
	for (const [field, value] of [
		["candidateId", request.candidateId],
		["attemptId", request.attemptId],
		["changeDigest", request.changeDigest],
		["baseRevisionDigest", request.baseRevisionDigest],
	] as const) {
		if (typeof value !== "string" || value.length === 0)
			throw new AutoResearchEngineError("candidate_invalid", `${label}.${field} is required`);
	}
	if (typeof request.claimedCompletion !== "boolean" || typeof request.claimedPromotion !== "boolean")
		throw new AutoResearchEngineError("candidate_invalid", `${label} authority claims must be boolean`);
}

function expectedVisibleInputs(registration: AutoResearchExperimentRegistration): readonly string[] {
	return registration.fixtures
		.filter((fixture) => fixture.partition === "train" || fixture.partition === "eval")
		.map((fixture) => fixture.inputDigest)
		.sort();
}

function expectedVisibleFixtureDigest(registration: AutoResearchExperimentRegistration): string {
	return registration.fixtures
		.filter((fixture) => fixture.partition === "train" || fixture.partition === "eval")
		.map((fixture) => fixture.manifestDigest)
		.sort()
		.join("|");
}

function expectedHiddenInputs(registration: AutoResearchExperimentRegistration): readonly string[] {
	return registration.fixtures
		.filter((fixture) => fixture.partition === "holdout" || fixture.partition === "adversarial")
		.map((fixture) => fixture.inputDigest);
}

function bindingDigest(binding: Pick<AutoResearchCommandInputBinding, "commandDigest" | "inputDigests">): string {
	return digestObject({ commandDigest: binding.commandDigest, inputDigests: [...binding.inputDigests].sort() });
}

function candidateExecutionBindingDigest(
	registrationDigest: string,
	request: AutoResearchCandidateRequest,
	task: AutoResearchTaskReceipt,
): string {
	return digestObject({
		registrationDigest,
		candidateRequest: {
			candidateId: request.candidateId,
			attemptId: request.attemptId,
			changeDigest: request.changeDigest,
			baseRevisionDigest: request.baseRevisionDigest,
			resourceRequest: request.resourceRequest,
			claimedCompletion: request.claimedCompletion,
			claimedPromotion: request.claimedPromotion,
		},
		task: {
			taskId: task.taskId,
			candidateId: task.candidateId,
			attemptId: task.attemptId,
			changeDigest: task.changeDigest,
			taskDigest: task.taskDigest,
		},
	});
}

function candidateExecutionDigest(
	registrationDigest: string,
	observationId: string,
	candidateBindingDigest: string,
): string {
	return digestObject({
		kind: "autoresearch_candidate_execution",
		registrationDigest,
		observationId,
		candidateBindingDigest,
	});
}

function sameBinding(left: AutoResearchCommandInputBinding, right: AutoResearchCommandInputBinding): boolean {
	return (
		isRecord(left) &&
		isRecord(right) &&
		typeof left.commandDigest === "string" &&
		typeof right.commandDigest === "string" &&
		Array.isArray(left.inputDigests) &&
		Array.isArray(right.inputDigests) &&
		left.inputDigests.every((digest) => typeof digest === "string") &&
		right.inputDigests.every((digest) => typeof digest === "string") &&
		left.commandDigest === right.commandDigest &&
		exactArray(left.inputDigests as readonly string[], right.inputDigests as readonly string[]) &&
		left.bindingDigest === right.bindingDigest
	);
}

function validateBinding(binding: AutoResearchCommandInputBinding, label: string): void {
	if (
		!isRecord(binding) ||
		typeof binding.commandDigest !== "string" ||
		!Array.isArray(binding.inputDigests) ||
		!binding.inputDigests.every((digest) => typeof digest === "string" && digest.length > 0) ||
		binding.commandDigest.length === 0 ||
		binding.inputDigests.length === 0
	)
		throw new AutoResearchEngineError("invalid_binding", `${label} command and inputs are required`);
	if (new Set(binding.inputDigests).size !== binding.inputDigests.length)
		throw new AutoResearchEngineError("invalid_binding", `${label} inputs must be unique`);
	if (binding.bindingDigest !== bindingDigest(binding))
		throw new AutoResearchEngineError("binding_changed", `${label} digest does not match its command and inputs`);
}

function vectorExceeds(request: WorkflowResourceVector, ceiling: WorkflowResourceVector): boolean {
	if (
		request.cpuMilliCores > ceiling.cpuMilliCores ||
		request.memoryBytes > ceiling.memoryBytes ||
		request.diskBytes > ceiling.diskBytes ||
		request.ioWeight > ceiling.ioWeight ||
		request.networkEgressBytes > ceiling.networkEgressBytes ||
		request.wallMilliseconds > ceiling.wallMilliseconds ||
		request.monetaryMicrounits > ceiling.monetaryMicrounits
	)
		return true;
	for (const requestAccelerator of request.accelerators) {
		const ceilingAccelerator = ceiling.accelerators.find((entry) => entry.poolId === requestAccelerator.poolId);
		if (
			ceilingAccelerator === undefined ||
			requestAccelerator.count > ceilingAccelerator.count ||
			requestAccelerator.memoryBytes > ceilingAccelerator.memoryBytes
		)
			return true;
	}
	for (const requestProvider of request.providers) {
		const ceilingProvider = ceiling.providers.find((entry) => entry.poolId === requestProvider.poolId);
		if (
			ceilingProvider === undefined ||
			requestProvider.concurrentRequests > ceilingProvider.concurrentRequests ||
			requestProvider.requestsPerMinute > ceilingProvider.requestsPerMinute ||
			requestProvider.totalRequests > ceilingProvider.totalRequests ||
			requestProvider.inputTokens > ceilingProvider.inputTokens ||
			requestProvider.outputTokens > ceilingProvider.outputTokens
		)
			return true;
	}
	return false;
}

function validateRegistration(registration: AutoResearchExperimentRegistration): void {
	if (
		!isRecord(registration) ||
		typeof registration.runId !== "string" ||
		typeof registration.workflowId !== "string" ||
		!isRecord(registration.revisionResolution) ||
		!isRecord(registration.metric) ||
		!isRecord(registration.evaluator) ||
		!isRecord(registration.commandInputBinding) ||
		!isRecord(registration.seed) ||
		!Array.isArray(registration.fixtures) ||
		(registration.guard !== null && !isRecord(registration.guard)) ||
		!isRecord(registration.resourceCeiling) ||
		(registration.hiddenHoldout !== null && !isRecord(registration.hiddenHoldout))
	)
		throw new AutoResearchEngineError("invalid_registration", "registration has an invalid shape");
	if (registration.runId.length === 0 || registration.workflowId.length === 0)
		throw new AutoResearchEngineError("invalid_registration", "run and workflow IDs are required");
	if (registration.revisionResolution.registryStatus !== "approved")
		throw new AutoResearchEngineError(
			"revision_not_approved",
			"AutoResearch requires an approved workflow revision resolution",
		);
	if (
		typeof registration.metric.metricId !== "string" ||
		typeof registration.metric.name !== "string" ||
		typeof registration.metric.direction !== "string" ||
		typeof registration.metric.target !== "number" ||
		typeof registration.metric.tolerance !== "number" ||
		registration.metric.metricId.length === 0 ||
		registration.metric.name.length === 0
	)
		throw new AutoResearchEngineError("invalid_registration", "metric identity is required");
	if (registration.metric.direction !== "lower" && registration.metric.direction !== "higher")
		throw new AutoResearchEngineError("invalid_registration", "metric direction is invalid");
	finiteNonNegative(registration.metric.tolerance, "metric tolerance");
	if (!Number.isFinite(registration.metric.target))
		throw new AutoResearchEngineError("invalid_registration", "metric target must be finite");
	safeMetricBounds(registration.metric.target, registration.metric.tolerance);
	for (const [label, value] of [
		["required sample size", registration.requiredSampleSize],
		["maximum candidates", registration.maxCandidates],
		["maximum variance", registration.maxVariance],
		["maximum cost", registration.maxCostMicrounits],
		["maximum latency", registration.maxLatencyMilliseconds],
	] as const) {
		if (!Number.isSafeInteger(value) && label !== "maximum variance")
			throw new AutoResearchEngineError("invalid_registration", `${label} must be a safe integer`);
		finiteNonNegative(value, label);
		if (value === 0 && label !== "maximum variance")
			throw new AutoResearchEngineError("invalid_registration", `${label} must be positive`);
	}
	validateBinding(registration.commandInputBinding, "registration command/input binding");
	if (
		typeof registration.evaluator.evaluatorDigest !== "string" ||
		typeof registration.evaluator.parserDigest !== "string" ||
		typeof registration.evaluator.commandDigest !== "string" ||
		registration.evaluator.evaluatorDigest.length === 0 ||
		registration.evaluator.parserDigest.length === 0 ||
		registration.evaluator.commandDigest.length === 0
	)
		throw new AutoResearchEngineError("invalid_registration", "evaluator digests are required");
	if (registration.commandInputBinding.commandDigest !== registration.evaluator.commandDigest)
		throw new AutoResearchEngineError("binding_changed", "command binding does not match the evaluator command");
	validateResourceVector(registration.resourceCeiling, "resourceCeiling");
	const fixtureIds = registration.fixtures.map((fixture) => fixture.fixtureId);
	if (new Set(fixtureIds).size !== fixtureIds.length)
		throw new AutoResearchEngineError("invalid_registration", "fixture IDs must be unique");
	const inputDigests = new Set<string>();
	const manifestDigests = new Set<string>();
	for (const fixture of registration.fixtures) {
		if (
			!isRecord(fixture) ||
			!hasExactKeys(fixture, FIXTURE_KEYS) ||
			typeof fixture.fixtureId !== "string" ||
			typeof fixture.inputDigest !== "string" ||
			typeof fixture.manifestDigest !== "string" ||
			typeof fixture.partition !== "string" ||
			typeof fixture.hidden !== "boolean" ||
			fixture.fixtureId.length === 0 ||
			fixture.inputDigest.length === 0 ||
			fixture.manifestDigest.length === 0
		)
			throw new AutoResearchEngineError("invalid_registration", "fixture identities are required");
		if (!("train|eval|holdout|adversarial".split("|") as readonly string[]).includes(fixture.partition))
			throw new AutoResearchEngineError("invalid_registration", "fixture partition is invalid");
		if (inputDigests.has(fixture.inputDigest))
			throw new AutoResearchEngineError("fixture_leakage", "fixture input is duplicated across partitions");
		inputDigests.add(fixture.inputDigest);
		if (manifestDigests.has(fixture.manifestDigest))
			throw new AutoResearchEngineError("fixture_leakage", "fixture manifest is duplicated across partitions");
		manifestDigests.add(fixture.manifestDigest);
		if ((fixture.partition === "holdout" || fixture.partition === "adversarial") !== fixture.hidden)
			throw new AutoResearchEngineError(
				"invalid_registration",
				"hidden and adversarial fixture visibility must be host-owned",
			);
	}
	const trainInputs = registration.fixtures
		.filter((fixture) => fixture.partition === "train")
		.map((fixture) => fixture.inputDigest);
	const evalInputs = registration.fixtures
		.filter((fixture) => fixture.partition === "eval")
		.map((fixture) => fixture.inputDigest);
	if (trainInputs.length === 0 || evalInputs.length === 0)
		throw new AutoResearchEngineError("invalid_registration", "train and eval fixtures are required");
	if (!exactArray(registration.commandInputBinding.inputDigests, [...trainInputs, ...evalInputs]))
		throw new AutoResearchEngineError("binding_changed", "command/input binding does not match visible fixtures");
	const holdoutFixtures = registration.fixtures.filter((fixture) => fixture.partition === "holdout");
	if (holdoutFixtures.length > 0 && registration.hiddenHoldout === null)
		throw new AutoResearchEngineError("invalid_registration", "a hidden holdout handle is mandatory");
	if (
		registration.hiddenHoldout !== null &&
		(!hasExactKeys(registration.hiddenHoldout, HOLDOUT_HANDLE_KEYS) ||
			typeof registration.hiddenHoldout.handleId !== "string" ||
			typeof registration.hiddenHoldout.manifestDigest !== "string" ||
			typeof registration.hiddenHoldout.owner !== "string" ||
			typeof registration.hiddenHoldout.hidden !== "boolean" ||
			typeof registration.hiddenHoldout.opaque !== "boolean" ||
			typeof registration.hiddenHoldout.hostResolverOnly !== "boolean" ||
			typeof registration.hiddenHoldout.bytesAccessibleToProposer !== "boolean" ||
			typeof registration.hiddenHoldout.bytesAccessibleToWorker !== "boolean" ||
			registration.hiddenHoldout.handleId.length === 0 ||
			registration.hiddenHoldout.manifestDigest.length === 0 ||
			!Number.isSafeInteger(registration.hiddenHoldout.caseCount) ||
			registration.hiddenHoldout.caseCount <= 0 ||
			registration.hiddenHoldout.owner !== "host" ||
			!registration.hiddenHoldout.hidden ||
			!registration.hiddenHoldout.opaque ||
			!registration.hiddenHoldout.hostResolverOnly ||
			registration.hiddenHoldout.bytesAccessibleToProposer ||
			registration.hiddenHoldout.bytesAccessibleToWorker)
	)
		throw new AutoResearchEngineError("invalid_registration", "hidden holdout handle must be opaque and host-owned");
	if (
		registration.hiddenHoldout !== null &&
		!registration.fixtures.some(
			(fixture) =>
				fixture.partition === "holdout" && fixture.manifestDigest === registration.hiddenHoldout?.manifestDigest,
		)
	)
		throw new AutoResearchEngineError(
			"invalid_registration",
			"host holdout handle is not bound to a holdout fixture",
		);
}

/** Validate one complete host registration before durable recipe parsing or execution. */
export function validateAutoResearchRegistration(registration: AutoResearchExperimentRegistration): void {
	validateRegistration(registration);
}

function strictlyImproves(
	direction: "lower" | "higher",
	candidate: number,
	baseline: number,
	_tolerance: number,
): boolean {
	return direction === "lower" ? candidate < baseline : candidate > baseline;
}

function reachesTarget(direction: "lower" | "higher", metric: number, target: number, tolerance: number): boolean {
	return direction === "lower" ? metric <= target + tolerance : metric >= target - tolerance;
}

function evidenceKey(ref: WorkflowArtifactRef): string {
	return `${ref.artifactId}:${ref.digest}`;
}

function validArtifactRef(ref: WorkflowArtifactRef): boolean {
	return (
		typeof ref === "object" &&
		ref !== null &&
		!Array.isArray(ref) &&
		JSON.stringify(Object.keys(ref).sort()) === JSON.stringify([...ARTIFACT_REF_KEYS].sort()) &&
		typeof ref.artifactId === "string" &&
		typeof ref.relativePath === "string" &&
		typeof ref.digest === "string" &&
		ref.artifactId.length > 0 &&
		ref.relativePath.length > 0 &&
		!ref.relativePath.startsWith("/") &&
		!ref.relativePath.includes("\\") &&
		!ref.relativePath.includes("\0") &&
		ref.relativePath.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
		ref.digest.length > 0 &&
		Number.isSafeInteger(ref.sizeBytes) &&
		ref.sizeBytes >= 0 &&
		ref.sizeBytes <= MAX_ARTIFACT_REF_BYTES &&
		Number.isSafeInteger(ref.sourceEventSequence) &&
		ref.sourceEventSequence >= 0
	);
}

function validateDecisionRef(ref: WorkflowDecisionRef, workflowId: string): void {
	if (
		!isRecord(ref) ||
		!isRecord(ref.decisionScope) ||
		typeof ref.decisionScope.kind !== "string" ||
		typeof ref.decisionScope.workflowId !== "string" ||
		typeof ref.decisionScope.rootSessionId !== "string" ||
		typeof ref.decisionId !== "string" ||
		typeof ref.decisionDigest !== "string" ||
		ref.decisionScope.kind !== "workflow" ||
		ref.decisionScope.workflowId !== workflowId ||
		ref.decisionScope.rootSessionId.length === 0 ||
		ref.decisionId.length === 0 ||
		!Number.isSafeInteger(ref.revision) ||
		ref.revision <= 0 ||
		!Number.isSafeInteger(ref.storeEpoch) ||
		ref.storeEpoch <= 0 ||
		!Number.isSafeInteger(ref.coordinatorEpoch) ||
		ref.coordinatorEpoch <= 0 ||
		ref.decisionDigest.length === 0
	)
		throw new AutoResearchEngineError("decision_invalid", "decision reference is not workflow-bound and finite");
}

function validateDecisionResolution(
	resolution: AutoResearchDecisionResolution,
	registration: AutoResearchExperimentRegistration,
	registrationDigest: string,
	decisionRef: WorkflowDecisionRef,
): void {
	if (
		!isRecord(resolution) ||
		!isRecord(resolution.ref) ||
		!isRecord(resolution.epochRef) ||
		!isRecord(resolution.receipt) ||
		!Array.isArray(resolution.authority) ||
		typeof resolution.workflowId !== "string" ||
		typeof resolution.registrationDigest !== "string" ||
		typeof resolution.stateDigest !== "string" ||
		typeof resolution.headDigest !== "string" ||
		typeof resolution.resolutionDigest !== "string"
	)
		throw new AutoResearchEngineError("decision_invalid", "decision resolver returned an invalid shape");
	validateDecisionRef(resolution.ref, registration.workflowId);
	if (
		digestObject(resolution.ref) !== digestObject(decisionRef) ||
		resolution.workflowId !== registration.workflowId ||
		resolution.registrationDigest !== registrationDigest ||
		resolution.stateDigest.length === 0 ||
		resolution.headDigest.length === 0 ||
		!Number.isSafeInteger(resolution.epochRef.storeEpoch) ||
		resolution.epochRef.storeEpoch <= 0 ||
		!Number.isSafeInteger(resolution.epochRef.coordinatorEpoch) ||
		resolution.epochRef.coordinatorEpoch <= 0 ||
		resolution.epochRef.storeEpoch !== resolution.ref.storeEpoch ||
		resolution.epochRef.coordinatorEpoch !== resolution.ref.coordinatorEpoch ||
		resolution.disposition !== "authorized" ||
		!resolution.fresh ||
		resolution.revoked ||
		resolution.authority.length === 0
	)
		throw new AutoResearchEngineError("decision_invalid", "decision resolver returned stale or unauthorized state");
	const receipt = resolution.receipt;
	const expectedReceiptBinding = digestObject({
		workflowId: registration.workflowId,
		registrationDigest,
		decisionRef,
		stateDigest: resolution.stateDigest,
		headDigest: resolution.headDigest,
		epochRef: resolution.epochRef,
	});
	if (
		!hasExactKeys(receipt, HOST_RECEIPT_KEYS) ||
		typeof receipt.receiptId !== "string" ||
		typeof receipt.issuerId !== "string" ||
		typeof receipt.workflowId !== "string" ||
		typeof receipt.bindingDigest !== "string" ||
		typeof receipt.payloadDigest !== "string" ||
		typeof receipt.issuedAt !== "string" ||
		typeof receipt.validUntil !== "string" ||
		typeof receipt.keyId !== "string" ||
		typeof receipt.artifactBytesDigest !== "string" ||
		typeof receipt.stateDigest !== "string" ||
		typeof receipt.signature !== "string" ||
		typeof receipt.verificationDigest !== "string" ||
		typeof receipt.oneUse !== "boolean" ||
		receipt.receiptId.length === 0 ||
		receipt.issuerId.length === 0 ||
		receipt.keyId.length === 0 ||
		receipt.artifactBytesDigest.length === 0 ||
		receipt.signature.length === 0 ||
		receipt.verificationDigest.length === 0 ||
		receipt.signatureAlgorithm !== "ed25519" ||
		!Number.isSafeInteger(receipt.revision) ||
		receipt.revision <= 0 ||
		receipt.receiptKind !== "decision" ||
		receipt.workflowId !== registration.workflowId ||
		receipt.bindingDigest !== expectedReceiptBinding ||
		receipt.payloadDigest !== decisionRef.decisionDigest ||
		receipt.stateDigest !== resolution.stateDigest ||
		receipt.artifactBytesDigest.length === 0 ||
		receipt.validUntil.length === 0 ||
		!Number.isFinite(Date.parse(receipt.issuedAt)) ||
		!Number.isFinite(Date.parse(receipt.validUntil)) ||
		Date.parse(receipt.validUntil) <= Date.parse(receipt.issuedAt) ||
		!validArtifactRef(receipt.artifactRef)
	)
		throw new AutoResearchEngineError("decision_invalid", "decision receipt is missing authenticated freshness");
	if (receipt.verificationDigest !== digestObject({ ...receipt, verificationDigest: "" }))
		throw new AutoResearchEngineError("decision_integrity", "decision receipt verification digest is substituted");
	const { resolutionDigest, ...preimage } = resolution;
	if (resolutionDigest !== digestObject(preimage))
		throw new AutoResearchEngineError("decision_integrity", "decision resolver digest does not match its bytes");
}

function validateEvidenceProof(
	proof: AutoResearchEvidenceProof,
	registration: AutoResearchExperimentRegistration,
	registrationDigest: string,
	ref: WorkflowArtifactRef,
	allowedKinds: readonly AutoResearchEvidenceProof["kind"][],
): void {
	if (
		!isRecord(proof) ||
		!hasExactKeys(proof, EVIDENCE_PROOF_KEYS) ||
		!isRecord(proof.ref) ||
		typeof proof.workflowId !== "string" ||
		typeof proof.registrationDigest !== "string" ||
		typeof proof.proofDigest !== "string" ||
		digestObject(proof.ref) !== digestObject(ref) ||
		proof.workflowId !== registration.workflowId ||
		proof.registrationDigest !== registrationDigest ||
		!allowedKinds.includes(proof.kind) ||
		!proof.authenticated ||
		!proof.fresh ||
		proof.revoked ||
		proof.proofDigest.length === 0 ||
		!validArtifactRef(proof.ref)
	)
		throw new AutoResearchEngineError("evidence_invalid", "evidence proof is unauthenticated or stale");
	const { proofDigest, ...preimage } = proof;
	if (proofDigest !== digestObject(preimage))
		throw new AutoResearchEngineError("evidence_integrity", "evidence proof does not match its bytes");
}

function hasDistinctEvidence(
	holdoutEvidenceRefs: readonly WorkflowArtifactRef[],
	adversarialEvidenceRefs: readonly WorkflowArtifactRef[],
): boolean {
	if (
		holdoutEvidenceRefs.length === 0 ||
		adversarialEvidenceRefs.length === 0 ||
		!hasUniqueEvidence(holdoutEvidenceRefs) ||
		!hasUniqueEvidence(adversarialEvidenceRefs)
	)
		return false;
	const holdout = new Set(holdoutEvidenceRefs.map(evidenceKey));
	return adversarialEvidenceRefs.some((entry) => !holdout.has(evidenceKey(entry)));
}

function hasUniqueEvidence(refs: readonly WorkflowArtifactRef[]): boolean {
	return refs.every(validArtifactRef) && new Set(refs.map(evidenceKey)).size === refs.length;
}

function validateMeasurement(
	measurement: AutoResearchHostMeasurement,
	registration: AutoResearchExperimentRegistration,
	rawObservation: AutoResearchRawObservation,
): void {
	if (
		!isRecord(measurement) ||
		!isRecord(measurement.commandInputBinding) ||
		!isRecord(measurement.resourceUsage) ||
		!Array.isArray(measurement.proxySignals) ||
		measurement.source !== "host" ||
		typeof measurement.measurementDigest !== "string" ||
		measurement.measurementDigest.length === 0 ||
		typeof measurement.rawResultRefsDigest !== "string" ||
		measurement.rawResultRefsDigest.length === 0
	)
		throw new AutoResearchEngineError("measurement_authority", "sample and variance must come from the host");
	validateBinding(measurement.commandInputBinding, "host measurement command/input binding");
	const { measurementDigest, ...measurementPreimage } = measurement;
	let expectedMeasurementDigest: string;
	try {
		expectedMeasurementDigest = digestObject(measurementPreimage);
	} catch {
		throw new AutoResearchEngineError("measurement_invalid", "host measurement contains unsupported numeric data");
	}
	if (measurementDigest !== expectedMeasurementDigest)
		throw new AutoResearchEngineError("measurement_integrity", "host measurement digest does not match its bytes");
	if (!sameBinding(measurement.commandInputBinding, registration.commandInputBinding))
		throw new AutoResearchEngineError("binding_changed", "host measurement command/input binding changed");
	if (
		measurement.metricDirection !== registration.metric.direction ||
		measurement.metricTarget !== registration.metric.target ||
		measurement.metricTolerance !== registration.metric.tolerance
	)
		throw new AutoResearchEngineError("metric_changed", "host measurement metric binding changed");
	if (measurement.rawResultRefsDigest !== digestObject(rawObservation.rawResultRefs))
		throw new AutoResearchEngineError(
			"measurement_integrity",
			"host measurement is not bound to raw result references",
		);
	if (!Number.isSafeInteger(measurement.sampleCount) || measurement.sampleCount <= 0)
		throw new AutoResearchEngineError("measurement_invalid", "host sample count must be a positive integer");
	for (const [label, value] of [
		["metric", measurement.metricValue],
		["baseline metric", measurement.baselineMetricValue],
		["variance", measurement.variance],
		["cost", measurement.costMicrounits],
		["latency", measurement.latencyMilliseconds],
	] as const) {
		if (
			!Number.isFinite(value) ||
			Math.abs(value) > Number.MAX_SAFE_INTEGER ||
			((label === "variance" || label === "cost" || label === "latency") && value < 0)
		)
			throw new AutoResearchEngineError("measurement_invalid", `host ${label} must be finite and bounded`);
	}
	if (
		!(["exploration", "holdout", "canary", "independent_review", "promotion", "completion"] as const).includes(
			measurement.phase,
		) ||
		!(["complete", "partial", "crashed"] as const).includes(measurement.status)
	)
		throw new AutoResearchEngineError("measurement_invalid", "host phase and status are required");
	if (
		typeof measurement.evaluatorDigest !== "string" ||
		typeof measurement.parserDigest !== "string" ||
		(measurement.guardDigest !== null && typeof measurement.guardDigest !== "string") ||
		(measurement.heldOutInputDigest !== null && typeof measurement.heldOutInputDigest !== "string") ||
		typeof measurement.seedDigest !== "string" ||
		typeof measurement.fixtureManifestDigest !== "string" ||
		typeof measurement.trainInputDigest !== "string" ||
		typeof measurement.evalInputDigest !== "string" ||
		measurement.evaluatorDigest.length === 0 ||
		measurement.parserDigest.length === 0 ||
		measurement.seedDigest.length === 0 ||
		measurement.fixtureManifestDigest.length === 0 ||
		measurement.trainInputDigest.length === 0 ||
		measurement.evalInputDigest.length === 0
	)
		throw new AutoResearchEngineError("measurement_invalid", "host provenance digests are required");
	if (
		!Array.isArray(measurement.proxySignals) ||
		measurement.proxySignals.some((signal) => typeof signal !== "string")
	)
		throw new AutoResearchEngineError("measurement_invalid", "host proxy signals are malformed");
	validateResourceVector(measurement.resourceUsage, "host resource usage");
	if (measurement.candidateClaimedCompletion !== false || measurement.candidateClaimedPromotion !== false)
		throw new AutoResearchEngineError(
			"measurement_authority",
			"host measurement cannot contain worker authority claims",
		);
	for (const [label, value] of [
		["hidden metric", measurement.hiddenMetricValue],
		["adversarial metric", measurement.adversarialMetricValue],
	] as const) {
		if (value !== null && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))
			throw new AutoResearchEngineError("measurement_invalid", `host ${label} must be finite when present`);
	}
}

function normalizeObservation(
	rawObservation: AutoResearchRawObservation,
	measurement: AutoResearchHostMeasurement,
): AutoResearchObservation {
	return immutableCopy({
		source: "host",
		observationId: rawObservation.observationId,
		candidateId: rawObservation.candidateId,
		attemptId: rawObservation.attemptId,
		phase: measurement.phase,
		status: measurement.status,
		commandInputBinding: measurement.commandInputBinding,
		metricDirection: measurement.metricDirection,
		metricTarget: measurement.metricTarget,
		metricTolerance: measurement.metricTolerance,
		sampleCount: measurement.sampleCount,
		metricValue: measurement.metricValue,
		baselineMetricValue: measurement.baselineMetricValue,
		variance: measurement.variance,
		fixtureManifestDigest: measurement.fixtureManifestDigest,
		trainInputDigest: measurement.trainInputDigest,
		evalInputDigest: measurement.evalInputDigest,
		heldOutInputDigest: measurement.heldOutInputDigest,
		evaluatorDigest: measurement.evaluatorDigest,
		parserDigest: measurement.parserDigest,
		guardDigest: measurement.guardDigest,
		seedDigest: measurement.seedDigest,
		proxySignals: measurement.proxySignals,
		costMicrounits: measurement.costMicrounits,
		latencyMilliseconds: measurement.latencyMilliseconds,
		resourceUsage: measurement.resourceUsage,
		hiddenMetricValue: measurement.hiddenMetricValue,
		adversarialMetricValue: measurement.adversarialMetricValue,
		candidateClaimedCompletion: false,
		candidateClaimedPromotion: false,
		measurementDigest: measurement.measurementDigest,
		rawResultRefsDigest: measurement.rawResultRefsDigest,
	});
}

function observationMeasurementDigest(observation: AutoResearchObservation): string {
	return digestObject({
		source: "host",
		commandInputBinding: observation.commandInputBinding,
		phase: observation.phase,
		status: observation.status,
		metricDirection: observation.metricDirection,
		metricTarget: observation.metricTarget,
		metricTolerance: observation.metricTolerance,
		sampleCount: observation.sampleCount,
		metricValue: observation.metricValue,
		baselineMetricValue: observation.baselineMetricValue,
		variance: observation.variance,
		fixtureManifestDigest: observation.fixtureManifestDigest,
		trainInputDigest: observation.trainInputDigest,
		evalInputDigest: observation.evalInputDigest,
		heldOutInputDigest: observation.heldOutInputDigest,
		evaluatorDigest: observation.evaluatorDigest,
		parserDigest: observation.parserDigest,
		guardDigest: observation.guardDigest,
		seedDigest: observation.seedDigest,
		proxySignals: observation.proxySignals,
		costMicrounits: observation.costMicrounits,
		latencyMilliseconds: observation.latencyMilliseconds,
		resourceUsage: observation.resourceUsage,
		hiddenMetricValue: observation.hiddenMetricValue,
		adversarialMetricValue: observation.adversarialMetricValue,
		candidateClaimedCompletion: false,
		candidateClaimedPromotion: false,
		rawResultRefsDigest: observation.rawResultRefsDigest,
	});
}

function validateObservationNumbers(observation: AutoResearchObservation): void {
	if (
		!isRecord(observation) ||
		(JSON.stringify(Object.keys(observation).sort()) !== JSON.stringify([...OBSERVATION_KEYS].sort()) &&
			JSON.stringify(Object.keys(observation).sort()) !==
				JSON.stringify([...OBSERVATION_KEYS, ...OBSERVATION_OPTIONAL_CLAIM_KEYS].sort())) ||
		!isRecord(observation.commandInputBinding) ||
		!isRecord(observation.resourceUsage) ||
		!Array.isArray(observation.proxySignals) ||
		observation.source !== "host" ||
		observation.candidateClaimedCompletion !== false ||
		observation.candidateClaimedPromotion !== false ||
		observation.claimedCompletion === true ||
		observation.claimedPromotion === true
	)
		throw new AutoResearchEngineError("replay_integrity", "observation host authority fields are substituted");
	if (!Number.isSafeInteger(observation.sampleCount) || observation.sampleCount <= 0)
		throw new AutoResearchEngineError("replay_integrity", "observation sample count is not finite and positive");
	for (const [label, value] of [
		["metric target", observation.metricTarget],
		["metric tolerance", observation.metricTolerance],
		["metric", observation.metricValue],
		["baseline metric", observation.baselineMetricValue],
		["variance", observation.variance],
		["cost", observation.costMicrounits],
		["latency", observation.latencyMilliseconds],
	] as const) {
		if (
			!Number.isFinite(value) ||
			Math.abs(value) > Number.MAX_SAFE_INTEGER ||
			(value < 0 && ["metric tolerance", "variance", "cost", "latency"].includes(label))
		)
			throw new AutoResearchEngineError("replay_integrity", `${label} is not finite and bounded`);
	}
	for (const [label, value] of [
		["hidden metric", observation.hiddenMetricValue],
		["adversarial metric", observation.adversarialMetricValue],
	] as const) {
		if (value !== null && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))
			throw new AutoResearchEngineError("replay_integrity", `${label} is not finite and bounded`);
	}
	if (
		!Number.isFinite(observation.metricTarget + observation.metricTolerance) ||
		!Number.isFinite(observation.metricTarget - observation.metricTolerance) ||
		Math.abs(observation.metricTarget + observation.metricTolerance) > Number.MAX_SAFE_INTEGER ||
		Math.abs(observation.metricTarget - observation.metricTolerance) > Number.MAX_SAFE_INTEGER
	)
		throw new AutoResearchEngineError("replay_integrity", "metric target/tolerance arithmetic overflows");
	validateResourceVector(observation.resourceUsage, "replayed observation resource usage");
}

function observationReason(state: EngineProjection, observation: AutoResearchObservation): string | null {
	const registration = state.registration;
	if (registration === null) return "registration is not locked";
	if (observation.source !== "host") return "observation is not host-resolved";
	const candidate = state.candidates.get(observation.candidateId);
	if (candidate === undefined) return "candidate was not submitted by the host";
	if (candidate.request.attemptId !== observation.attemptId)
		return "observation attempt is not bound to the submitted task";
	if (
		observation.candidateClaimedCompletion ||
		observation.candidateClaimedPromotion ||
		observation.claimedCompletion === true ||
		observation.claimedPromotion === true
	)
		return "candidate cannot self-promote or complete";
	if (observation.status !== "complete")
		return `observation is ${observation.status}; partial or crashed observations cannot be reused`;
	if (observation.measurementDigest !== observationMeasurementDigest(observation))
		return "measurement integrity mismatch";
	if (
		!Number.isFinite(observation.costMicrounits) ||
		observation.costMicrounits < 0 ||
		!Number.isFinite(observation.latencyMilliseconds) ||
		observation.latencyMilliseconds < 0
	)
		return "invalid observation accounting";
	try {
		validateResourceVector(observation.resourceUsage, "observation resource usage");
	} catch {
		return "invalid observation accounting";
	}
	if (!sameBinding(observation.commandInputBinding, registration.commandInputBinding))
		return "command/input binding changed";
	if (
		observation.metricDirection !== registration.metric.direction ||
		observation.metricTarget !== registration.metric.target ||
		observation.metricTolerance !== registration.metric.tolerance
	)
		return "metric direction, target, or tolerance changed";
	if (
		!Number.isSafeInteger(observation.sampleCount) ||
		observation.sampleCount <= 0 ||
		observation.sampleCount < registration.requiredSampleSize
	)
		return "inadequate sample";
	if (
		!Number.isFinite(observation.metricValue) ||
		!Number.isFinite(observation.baselineMetricValue) ||
		Math.abs(observation.metricValue) > Number.MAX_SAFE_INTEGER ||
		Math.abs(observation.baselineMetricValue) > Number.MAX_SAFE_INTEGER
	)
		return "metric is not finite";
	if (
		!strictlyImproves(
			registration.metric.direction,
			observation.metricValue,
			observation.baselineMetricValue,
			registration.metric.tolerance,
		)
	)
		return "metric did not strictly improve";
	if (observation.evaluatorDigest !== registration.evaluator.evaluatorDigest) return "modified evaluator";
	if (observation.parserDigest !== registration.evaluator.parserDigest) return "modified parser";
	if (observation.guardDigest !== (registration.guard?.guardDigest ?? null)) return "modified guard";
	if (observation.seedDigest !== registration.seed.seedDigest) return "modified seed";
	if (observation.fixtureManifestDigest !== expectedVisibleFixtureDigest(registration))
		return "modified fixture manifest";
	if (!exactArray(observation.commandInputBinding.inputDigests, expectedVisibleInputs(registration)))
		return "command/input binding changed";
	if (!expectedVisibleInputs(registration).includes(observation.trainInputDigest)) return "unregistered train fixture";
	if (!expectedVisibleInputs(registration).includes(observation.evalInputDigest)) return "unregistered eval fixture";
	if (
		!registration.fixtures.some(
			(fixture) => fixture.partition === "train" && fixture.inputDigest === observation.trainInputDigest,
		)
	)
		return "train/eval leakage";
	if (
		!registration.fixtures.some(
			(fixture) => fixture.partition === "eval" && fixture.inputDigest === observation.evalInputDigest,
		)
	)
		return "train/eval leakage";
	const hiddenInputs = expectedHiddenInputs(registration);
	if (hiddenInputs.includes(observation.trainInputDigest) || hiddenInputs.includes(observation.evalInputDigest))
		return "hidden fixture leakage";
	if (observation.proxySignals.length > 0) return "proxy exploitation";
	if (!Number.isFinite(observation.variance) || observation.variance > registration.maxVariance)
		return "unstable variance";
	if (observation.phase === "holdout" && observation.heldOutInputDigest === null)
		return "holdout input digest is missing";
	if (observation.heldOutInputDigest !== null && !hiddenInputs.includes(observation.heldOutInputDigest))
		return "unregistered holdout input";
	if (
		(observation.phase === "holdout" || observation.heldOutInputDigest !== null) &&
		[...state.observations.values()].some((prior) => prior.phase === "holdout" || prior.heldOutInputDigest !== null)
	)
		return "repeated holdout peeking";
	const requiresGeneralization = observation.phase === "promotion" || observation.phase === "completion";
	if (
		requiresGeneralization &&
		(observation.hiddenMetricValue === null || observation.adversarialMetricValue === null)
	)
		return "finite hidden and adversarial measurements are required";
	for (const metric of [observation.hiddenMetricValue, observation.adversarialMetricValue]) {
		if (
			metric !== null &&
			(!Number.isFinite(metric) ||
				Math.abs(metric) > Number.MAX_SAFE_INTEGER ||
				!strictlyImproves(
					registration.metric.direction,
					metric,
					observation.baselineMetricValue,
					registration.metric.tolerance,
				))
		)
			return "hidden/adversarial degradation";
	}
	if (
		(observation.phase === "promotion" || observation.phase === "completion") &&
		!reachesTarget(
			registration.metric.direction,
			observation.metricValue,
			registration.metric.target,
			registration.metric.tolerance,
		)
	)
		return "metric target not reached";
	if (
		((observation.phase === "promotion" || observation.phase === "completion") &&
			!hasDistinctEvidence(state.holdoutEvidenceRefs, state.adversarialEvidenceRefs)) ||
		state.holdoutEvidenceProofs.length !== state.holdoutEvidenceRefs.length ||
		state.adversarialEvidenceProofs.length !== state.adversarialEvidenceRefs.length
	)
		return "opaque holdout and adversarial evidence are required";
	try {
		if (safeAdd(state.totalCostMicrounits, observation.costMicrounits, "total cost") > registration.maxCostMicrounits)
			return "budget ceiling exceeded";
		if (
			safeAdd(state.totalLatencyMilliseconds, observation.latencyMilliseconds, "total latency") >
			registration.maxLatencyMilliseconds
		)
			return "latency ceiling exceeded";
		if (vectorExceeds(addResource(state.resourceUsage, observation.resourceUsage), registration.resourceCeiling))
			return "resource ceiling exceeded";
	} catch (error) {
		if (error instanceof AutoResearchEngineError && error.code === "numeric_overflow")
			return "resource or accounting ceiling exceeded";
		throw error;
	}
	return null;
}

function proposalIsHostCandidate(
	proposal: WorkflowImprovementProposal,
	registration: AutoResearchExperimentRegistration,
	observation: AutoResearchObservation,
	candidate: CandidateRecord,
	evidenceRefs: readonly WorkflowArtifactRef[] = [],
): boolean {
	if (!isRecord(proposal) || !Array.isArray(proposal.hostAcceptedEvidenceRefs)) return false;
	if (proposal.hostAcceptedEvidenceRefs.some((ref) => !validArtifactRef(ref))) return false;
	const evidenceKeys = new Set(evidenceRefs.map(evidenceKey));
	return (
		typeof proposal.proposalId === "string" &&
		proposal.proposalId.length > 0 &&
		proposal.workflowId === registration.workflowId &&
		proposal.owner === "autoresearch" &&
		proposal.producer === "autoresearch" &&
		proposal.status === "proposed" &&
		proposal.attemptId === observation.attemptId &&
		proposal.candidateDigest === candidate.request.changeDigest &&
		proposal.baselineDigest === candidate.request.baseRevisionDigest &&
		digestObject(proposal.revisionResolution) === digestObject(registration.revisionResolution) &&
		proposal.hostAcceptedEvidenceRefs.length > 0 &&
		proposal.hostAcceptedEvidenceRefs.every((ref) => evidenceKeys.size === 0 || evidenceKeys.has(evidenceKey(ref)))
	);
}

function initialState(): EngineProjection {
	return {
		registration: null,
		registrationDigest: null,
		preRegisteredDigest: null,
		locked: false,
		decisionRef: null,
		holdoutSubmitted: false,
		holdoutEvidenceRefs: [],
		adversarialEvidenceRefs: [],
		holdoutEvidenceProofs: [],
		adversarialEvidenceProofs: [],
		resolverContext: null,
		decisionResolution: null,
		candidates: new Map(),
		observations: new Map(),
		observationResults: new Map(),
		proposals: new Map(),
		executions: new Map(),
		totalCostMicrounits: 0,
		totalLatencyMilliseconds: 0,
		resourceUsage: emptyResource(),
		pendingAcceptedProposals: new Map(),
	};
}

/** Thin host-authoritative native experiment adapter. */
export class NativeExperimentEngine {
	private state: EngineProjection = initialState();
	private readonly restoration: Promise<void>;
	private pendingRegistration: AutoResearchExperimentRegistration | null = null;

	constructor(private readonly host: AutoResearchHostPorts) {
		if (host === null || typeof host.runtime?.replay !== "function" || typeof host.runtime?.commit !== "function")
			throw new AutoResearchEngineError("runtime_authority", "one host-owned runtime is required");
		this.restoration = this.restore();
	}

	async ready(): Promise<void> {
		await this.restoration;
	}

	async preRegister(registration: AutoResearchExperimentRegistration): Promise<string> {
		return this.withAuthority(async () => {
			validateRegistration(registration);
			const immutableRegistration = immutableCopy(registration);
			const registrationDigest = digestObject(immutableRegistration);
			if (this.state.preRegisteredDigest !== null && this.state.preRegisteredDigest !== registrationDigest)
				throw new AutoResearchEngineError(
					"registration_locked",
					"metric/evaluator/seed/fixture registration cannot change after pre-registration lock",
				);
			if (this.state.locked && this.state.registrationDigest !== registrationDigest)
				throw new AutoResearchEngineError("registration_locked", "locked registration cannot change");
			this.state.registration = immutableRegistration;
			this.state.preRegisteredDigest = registrationDigest;
			this.pendingRegistration = immutableRegistration;
			return registrationDigest;
		});
	}

	async lock(): Promise<void> {
		return this.withAuthority(async () => {
			const registration = this.state.registration;
			const registrationDigest = this.state.preRegisteredDigest;
			if (registration === null || registrationDigest === null)
				throw new AutoResearchEngineError("registration_missing", "pre-register an experiment before locking it");
			if (digestObject(registration) !== registrationDigest)
				throw new AutoResearchEngineError(
					"registration_changed",
					"pre-registered experiment bytes changed before locking",
				);
			let decisionRef: WorkflowDecisionRef;
			let decisionResolution: AutoResearchDecisionResolution;
			if (this.state.locked) {
				if (this.state.holdoutSubmitted || registration.hiddenHoldout === null) {
					this.pendingRegistration = null;
					return;
				}
				if (this.state.decisionRef === null || this.state.decisionResolution === null)
					throw new AutoResearchEngineError(
						"replay_integrity",
						"locked registration lacks its decision resolution",
					);
				decisionRef = this.state.decisionRef;
				decisionResolution = this.state.decisionResolution;
			} else {
				decisionRef = await this.host.submitDecision({
					kind: "registration_lock",
					runId: registration.runId,
					workflowId: registration.workflowId,
					registrationDigest,
					revisionResolution: registration.revisionResolution,
				});
				decisionResolution = await this.host.resolveDecision({
					workflowId: registration.workflowId,
					registrationDigest,
					registration,
					ref: decisionRef,
				});
				validateDecisionResolution(decisionResolution, registration, registrationDigest, decisionRef);
			}
			let holdoutEvidence: Awaited<ReturnType<NonNullable<AutoResearchHostPorts["submitHoldout"]>>> | null = null;
			if (registration.hiddenHoldout !== null) {
				if (this.host.submitHoldout === undefined)
					throw new AutoResearchEngineError("holdout_port_missing", "host holdout submission port is required");
				const evidence = await this.host.submitHoldout({
					runId: registration.runId,
					registrationDigest,
					handle: registration.hiddenHoldout,
				});
				if (
					!isRecord(evidence) ||
					!isRecord(evidence.resolverContext) ||
					!hasExactKeys(evidence.resolverContext, HOLDOUT_RESOLVER_KEYS) ||
					typeof evidence.resolverContext.contextId !== "string" ||
					typeof evidence.resolverContext.workflowId !== "string" ||
					typeof evidence.resolverContext.registrationDigest !== "string" ||
					typeof evidence.resolverContext.handleId !== "string" ||
					typeof evidence.resolverContext.manifestDigest !== "string" ||
					typeof evidence.resolverContext.stateDigest !== "string" ||
					typeof evidence.resolverContext.resolverDigest !== "string" ||
					!isRecord(evidence.resolverContext.epochRef) ||
					!Number.isSafeInteger(evidence.resolverContext.epochRef.storeEpoch) ||
					evidence.resolverContext.epochRef.storeEpoch <= 0 ||
					!Number.isSafeInteger(evidence.resolverContext.epochRef.coordinatorEpoch) ||
					evidence.resolverContext.epochRef.coordinatorEpoch <= 0 ||
					Object.keys(evidence).sort().join("|") !==
						[
							"adversarialEvidenceProofs",
							"adversarialEvidenceRefs",
							"bytesReturned",
							"evidenceProofs",
							"evidenceRefs",
							"handleId",
							"manifestDigest",
							"resolverContext",
						]
							.sort()
							.join("|") ||
					evidence.handleId !== registration.hiddenHoldout.handleId ||
					evidence.manifestDigest !== registration.hiddenHoldout.manifestDigest ||
					evidence.bytesReturned ||
					!Array.isArray(evidence.evidenceRefs) ||
					!Array.isArray(evidence.adversarialEvidenceRefs) ||
					!Array.isArray(evidence.evidenceProofs) ||
					!Array.isArray(evidence.adversarialEvidenceProofs) ||
					evidence.evidenceRefs.length === 0 ||
					evidence.evidenceRefs.some((ref) => !validArtifactRef(ref)) ||
					evidence.adversarialEvidenceRefs.some((ref) => !validArtifactRef(ref)) ||
					!hasUniqueEvidence(evidence.evidenceRefs) ||
					!hasUniqueEvidence(evidence.adversarialEvidenceRefs) ||
					evidence.evidenceProofs.length !== evidence.evidenceRefs.length ||
					evidence.adversarialEvidenceProofs.length !== evidence.adversarialEvidenceRefs.length ||
					evidence.resolverContext.contextId.length === 0 ||
					evidence.resolverContext.workflowId !== registration.workflowId ||
					evidence.resolverContext.registrationDigest !== registrationDigest ||
					evidence.resolverContext.handleId !== registration.hiddenHoldout.handleId ||
					evidence.resolverContext.manifestDigest !== registration.hiddenHoldout.manifestDigest ||
					!evidence.resolverContext.authenticated ||
					!evidence.resolverContext.returnsEvidenceOnly ||
					evidence.resolverContext.returnsBytes ||
					evidence.resolverContext.resolverDigest.length === 0 ||
					decisionResolution.stateDigest.length === 0 ||
					evidence.resolverContext.stateDigest !== decisionResolution.stateDigest ||
					evidence.resolverContext.epochRef.storeEpoch !== decisionResolution.epochRef.storeEpoch ||
					evidence.resolverContext.epochRef.coordinatorEpoch !== decisionResolution.epochRef.coordinatorEpoch ||
					(evidence.adversarialEvidenceRefs.length > 0 &&
						!hasDistinctEvidence(evidence.evidenceRefs, evidence.adversarialEvidenceRefs))
				)
					throw new AutoResearchEngineError(
						"holdout_bytes_exposed",
						"host holdout submission must return opaque evidence only",
					);
				for (const [index, proof] of evidence.evidenceProofs.entries())
					validateEvidenceProof(proof, registration, registrationDigest, evidence.evidenceRefs[index]!, [
						"holdout",
					]);
				for (const [index, proof] of evidence.adversarialEvidenceProofs.entries())
					validateEvidenceProof(
						proof,
						registration,
						registrationDigest,
						evidence.adversarialEvidenceRefs[index]!,
						["adversarial"],
					);
				holdoutEvidence = evidence;
			}
			if (!this.state.locked)
				await this.host.runtime.commit({
					event: immutableCopy({
						kind: "registration_locked",
						registration,
						registrationDigest,
						decisionRef,
						decisionResolution,
					}),
				});
			if (holdoutEvidence !== null) {
				await this.host.runtime.commit({
					event: {
						kind: "holdout_submitted",
						registrationDigest,
						handleId: holdoutEvidence.handleId,
						manifestDigest: holdoutEvidence.manifestDigest,
						resolverContext: immutableCopy(holdoutEvidence.resolverContext),
						evidenceRefs: immutableCopy(holdoutEvidence.evidenceRefs),
						adversarialEvidenceRefs: immutableCopy(holdoutEvidence.adversarialEvidenceRefs),
						evidenceProofs: immutableCopy(holdoutEvidence.evidenceProofs),
						adversarialEvidenceProofs: immutableCopy(holdoutEvidence.adversarialEvidenceProofs),
					},
				});
			}
			await this.restore();
			this.pendingRegistration = null;
		});
	}

	async submitCandidate(request: AutoResearchCandidateRequest): Promise<AutoResearchTaskReceipt> {
		return this.withAuthority(async () => {
			const immutableRequest = immutableCopy(request);
			this.assertLocked();
			const registration = this.state.registration!;
			validateCandidateRequest(immutableRequest, "candidate request");
			if (immutableRequest.claimedCompletion || immutableRequest.claimedPromotion)
				throw new AutoResearchEngineError("candidate_authority", "candidate cannot self-promote or complete");
			if (this.state.candidates.has(immutableRequest.candidateId))
				throw new AutoResearchEngineError("duplicate_candidate", "candidate identity is already committed");
			if (this.state.candidates.size >= registration.maxCandidates)
				throw new AutoResearchEngineError("budget_ceiling", "candidate budget ceiling exhausted");
			validateResourceVector(immutableRequest.resourceRequest, "candidate resource request");
			if (vectorExceeds(immutableRequest.resourceRequest, registration.resourceCeiling))
				throw new AutoResearchEngineError(
					"resource_ceiling",
					"candidate resource request exceeds the approved ceiling",
				);
			const input: AutoResearchTaskSubmission = {
				...immutableRequest,
				runId: registration.runId,
				workflowId: registration.workflowId,
				registrationDigest: this.state.registrationDigest!,
				revisionResolution: registration.revisionResolution,
				commandInputBinding: registration.commandInputBinding,
			};
			const task = await this.host.submitTask(input);
			if (
				!hasExactKeys(task, TASK_RECEIPT_KEYS) ||
				typeof task.taskId !== "string" ||
				typeof task.candidateId !== "string" ||
				typeof task.attemptId !== "string" ||
				typeof task.changeDigest !== "string" ||
				typeof task.taskDigest !== "string" ||
				task.taskId !== immutableRequest.candidateId ||
				task.candidateId !== immutableRequest.candidateId ||
				task.attemptId !== immutableRequest.attemptId ||
				task.changeDigest !== immutableRequest.changeDigest ||
				task.taskDigest.length === 0
			)
				throw new AutoResearchEngineError(
					"task_binding",
					"host task receipt is not bound to the candidate attempt",
				);
			const immutableTask = immutableCopy(task);
			await this.host.runtime.commit({
				event: {
					kind: "candidate_submitted",
					registrationDigest: this.state.registrationDigest!,
					commandInputBinding: registration.commandInputBinding,
					request: immutableRequest,
					task: immutableTask,
					candidateBindingDigest: candidateExecutionBindingDigest(
						this.state.registrationDigest!,
						immutableRequest,
						immutableTask,
					),
					semanticDigest: digestObject({ request: immutableRequest, task: immutableTask }),
				},
			});
			await this.restore();
			return immutableTask;
		});
	}

	async recordObservation(
		input: AutoResearchRawObservation | AutoResearchObservation,
	): Promise<AutoResearchEvaluation> {
		return this.withAuthority(async () => {
			this.assertLocked();
			const rawObservation: AutoResearchRawObservation = immutableCopy(
				"rawResultRefs" in input
					? input
					: {
							observationId: input.observationId,
							candidateId: input.candidateId,
							attemptId: input.attemptId,
							rawResultRefs: [],
						},
			);
			if (
				rawObservation.observationId.length === 0 ||
				rawObservation.candidateId.length === 0 ||
				rawObservation.attemptId.length === 0 ||
				!hasExactKeys(rawObservation, RAW_OBSERVATION_KEYS) ||
				!Array.isArray(rawObservation.rawResultRefs) ||
				rawObservation.rawResultRefs.some((ref) => !validArtifactRef(ref)) ||
				new Set(rawObservation.rawResultRefs.map(evidenceKey)).size !== rawObservation.rawResultRefs.length
			)
				throw new AutoResearchEngineError(
					"observation_invalid",
					"worker observation contains invalid raw result refs",
				);
			if ("rawResultRefs" in input && rawObservation.rawResultRefs.length === 0)
				throw new AutoResearchEngineError(
					"observation_invalid",
					"worker observation must contain opaque result refs",
				);
			const pendingAcceptedProposal = this.state.pendingAcceptedProposals.get(rawObservation.observationId);
			if (pendingAcceptedProposal !== undefined) {
				if (
					pendingAcceptedProposal.observation.candidateId !== rawObservation.candidateId ||
					pendingAcceptedProposal.observation.attemptId !== rawObservation.attemptId
				)
					throw new AutoResearchEngineError(
						"observation_binding",
						"retry observation is not bound to the pending accepted proposal",
					);
				return this.completePendingAcceptedProposal(pendingAcceptedProposal);
			}
			if (this.state.observations.has(rawObservation.observationId))
				throw new AutoResearchEngineError(
					"observation_reuse",
					"partial, crashed, or committed observations cannot be reused",
				);
			const registration = this.state.registration!;
			const measurement = await this.host.measureObservation(rawObservation);
			validateMeasurement(measurement, registration, rawObservation);
			const normalized = normalizeObservation(rawObservation, measurement);
			validateObservationNumbers(normalized);
			const reason = observationReason(this.state, normalized);
			let accepted = reason === null;
			let finalReason = reason;
			if (accepted) {
				const review = this.review(normalized);
				const boundary =
					normalized.phase === "holdout"
						? "holdout_passed"
						: normalized.phase === "independent_review"
							? "independent_review"
							: normalized.phase === "promotion"
								? "promoted"
								: normalized.phase === "completion"
									? "completion"
									: normalized.phase === "canary"
										? "canary"
										: null;
				if (boundary !== null && !canProceedWithOverfittingReview(review, boundary, review.receipt)) {
					accepted = false;
					finalReason = "blocking overfitting review failed";
				}
			}
			const provisionalEvidence: AutoResearchEvidenceSubmission = {
				runId: registration.runId,
				candidateId: normalized.candidateId,
				attemptId: normalized.attemptId,
				observationId: normalized.observationId,
				outcome: accepted ? "accepted" : normalized.status === "complete" ? "rejected" : "inconclusive",
				reason: finalReason,
				observation: normalized,
			};
			let evidenceRef: WorkflowArtifactRef;
			let evidenceProof: AutoResearchEvidenceProof | undefined;
			let proposal: WorkflowImprovementProposal | null = null;
			if (accepted) {
				const proposalInput: AutoResearchProposalCandidateInput = {
					registration,
					registrationDigest: this.state.registrationDigest!,
					candidateRequest: this.state.candidates.get(normalized.candidateId)!.request,
					task: this.state.candidates.get(normalized.candidateId)!.task,
					observation: normalized,
					evidenceRefs: [],
					revisionResolution: registration.revisionResolution,
				};
				proposal = immutableCopy(await this.host.submitProposal(proposalInput));
				if (
					!proposalIsHostCandidate(
						proposal,
						registration,
						normalized,
						this.state.candidates.get(normalized.candidateId)!,
					)
				)
					throw new AutoResearchEngineError(
						"proposal_integrity",
						"host proposal must be validated before accepted evidence publication",
					);
				const transactionDigest = digestObject({
					registrationDigest: this.state.registrationDigest,
					candidateRequest: this.state.candidates.get(normalized.candidateId)!.request,
					task: this.state.candidates.get(normalized.candidateId)!.task,
					observationDigest: digestObject(normalized),
					proposalDigest: digestObject(proposal),
					evidence: provisionalEvidence,
					proposal,
				});
				await this.host.runtime.commit({
					event: {
						kind: "accepted_proposal_intent",
						registrationDigest: this.state.registrationDigest!,
						transactionDigest,
						evidence: provisionalEvidence,
						observation: normalized,
						observationDigest: digestObject(normalized),
						decisionDigest: digestObject({
							observationDigest: digestObject(normalized),
							accepted: true,
							reason: null,
						}),
						proposal,
						proposalDigest: digestObject(proposal),
					},
				});
				const committed = await this.host.submitAcceptedProposal({
					transactionDigest,
					evidence: provisionalEvidence,
					proposal: { ...proposalInput, evidenceRefs: [] },
				});
				if (committed.transactionDigest !== transactionDigest)
					throw new AutoResearchEngineError("transaction_integrity", "host proposal transaction digest changed");
				evidenceRef = immutableCopy(committed.evidenceRef);
				evidenceProof = immutableCopy(committed.evidenceProof);
				validateEvidenceProof(evidenceProof, registration, this.state.registrationDigest!, evidenceRef, [
					"observation",
				]);
				if (digestObject(committed.proposal) !== digestObject(proposal))
					throw new AutoResearchEngineError(
						"proposal_integrity",
						"host accepted-evidence transaction changed the validated proposal",
					);
				proposal = immutableCopy(committed.proposal);
				if (
					!proposalIsHostCandidate(
						proposal,
						registration,
						normalized,
						this.state.candidates.get(normalized.candidateId)!,
						[evidenceRef],
					)
				) {
					throw new AutoResearchEngineError(
						"proposal_integrity",
						"host accepted-evidence transaction returned a proposal outside the candidate boundary",
					);
				}
			} else {
				evidenceRef = immutableCopy(await this.host.submitEvidence(provisionalEvidence));
			}
			const event: AutoResearchCommittedEvent = {
				kind: "observation_recorded",
				registrationDigest: this.state.registrationDigest!,
				observation: normalized,
				accepted,
				reason: finalReason,
				evidenceRef: immutableCopy(evidenceRef),
				...(evidenceProof === undefined ? {} : { evidenceProof: immutableCopy(evidenceProof) }),
				observationDigest: digestObject(normalized),
				decisionDigest: digestObject({
					observationDigest: digestObject(normalized),
					accepted,
					reason: finalReason,
				}),
			};
			if (accepted) {
				if (proposal === null || evidenceProof === undefined)
					throw new AutoResearchEngineError(
						"proposal_missing",
						"accepted evidence requires the validated host proposal and proof",
					);
				await this.host.runtime.commit({
					event: {
						kind: "accepted_proposal_committed",
						registrationDigest: event.registrationDigest,
						observation: event.observation,
						accepted: true,
						reason: null,
						evidenceRef: event.evidenceRef,
						evidenceProof,
						observationDigest: event.observationDigest!,
						decisionDigest: event.decisionDigest!,
						proposal,
						proposalDigest: digestObject(proposal),
						proposalObservationDigest: event.observationDigest!,
					},
				});
			} else {
				await this.host.runtime.commit({ event });
			}
			await this.restore();
			if (!accepted)
				return { accepted, reason: finalReason, evidenceRefs: [evidenceRef], proposal: null, proposalOnly: true };
			if (proposal === null)
				throw new AutoResearchEngineError("proposal_missing", "accepted evidence requires a host proposal");
			const result = {
				accepted: true,
				reason: null,
				evidenceRefs: [evidenceRef],
				proposal,
				proposalOnly: true,
			} satisfies AutoResearchEvaluation;
			return result;
		});
	}

	/** Persist an execution intent before an approved worker/process side effect starts. */
	async beginCandidateExecution(input: {
		readonly observationId: string;
		readonly candidateId: string;
		readonly attemptId: string;
	}): Promise<{ readonly state: AutoResearchExecutionState; readonly acquired: boolean }> {
		return this.withAuthority(async () => {
			this.assertLocked();
			if (
				typeof input.observationId !== "string" ||
				input.observationId.length === 0 ||
				typeof input.candidateId !== "string" ||
				input.candidateId.length === 0 ||
				typeof input.attemptId !== "string" ||
				input.attemptId.length === 0
			)
				throw new AutoResearchEngineError("execution_invalid", "execution identity is required");
			const existing = this.state.executions.get(input.observationId);
			if (existing !== undefined) return { state: immutableCopy(existing), acquired: false };
			const candidate = this.state.candidates.get(input.candidateId);
			if (candidate === undefined || candidate.request.attemptId !== input.attemptId)
				throw new AutoResearchEngineError("execution_binding", "execution is not bound to a submitted candidate");
			const registrationDigest = this.state.registrationDigest!;
			const candidateBindingDigest = candidateExecutionBindingDigest(
				registrationDigest,
				candidate.request,
				candidate.task,
			);
			const executionDigest = candidateExecutionDigest(
				registrationDigest,
				input.observationId,
				candidateBindingDigest,
			);
			const committed = await this.host.runtime.commit({
				event: {
					kind: "candidate_execution_intent",
					registrationDigest,
					observationId: input.observationId,
					candidateRequest: immutableCopy(candidate.request),
					task: immutableCopy(candidate.task),
					candidateBindingDigest,
					executionDigest,
				},
			});
			await this.restore();
			const state = this.state.executions.get(input.observationId);
			if (state === undefined)
				throw new AutoResearchEngineError("execution_missing", "execution intent was not replayable");
			return {
				state: immutableCopy(state),
				acquired: committed.commitStatus !== "already_committed",
			};
		});
	}

	/** Persist authenticated raw result references after the approved execution returns. */
	async completeCandidateExecution(input: {
		readonly observationId: string;
		readonly candidateId: string;
		readonly attemptId: string;
		readonly rawResultRefs: readonly WorkflowArtifactRef[];
	}): Promise<AutoResearchExecutionState> {
		return this.withAuthority(async () => {
			this.assertLocked();
			const pending = this.state.executions.get(input.observationId);
			if (pending === undefined)
				throw new AutoResearchEngineError(
					"execution_missing",
					"execution intent must precede raw result completion",
				);
			if (pending.candidateId !== input.candidateId || pending.attemptId !== input.attemptId)
				throw new AutoResearchEngineError("execution_binding", "raw results are not bound to the execution intent");
			if (pending.status === "completed") return immutableCopy(pending);
			if (
				!Array.isArray(input.rawResultRefs) ||
				input.rawResultRefs.length === 0 ||
				input.rawResultRefs.length > 32 ||
				input.rawResultRefs.some((ref) => !validArtifactRef(ref)) ||
				new Set(input.rawResultRefs.map(evidenceKey)).size !== input.rawResultRefs.length
			)
				throw new AutoResearchEngineError("execution_invalid", "raw result references are invalid or duplicated");
			const candidate = this.state.candidates.get(input.candidateId);
			if (candidate === undefined || candidate.request.attemptId !== input.attemptId)
				throw new AutoResearchEngineError("execution_binding", "candidate execution is no longer bound");
			const rawResultRefs = immutableCopy(input.rawResultRefs);
			const rawResultRefsDigest = digestObject(rawResultRefs);
			const committed = await this.host.runtime.commit({
				event: {
					kind: "candidate_execution_completed",
					registrationDigest: this.state.registrationDigest!,
					observationId: input.observationId,
					candidateRequest: immutableCopy(candidate.request),
					task: immutableCopy(candidate.task),
					candidateBindingDigest: pending.candidateBindingDigest,
					executionDigest: pending.executionDigest,
					rawResultRefs,
					rawResultRefsDigest,
				},
			});
			await this.restore();
			const state = this.state.executions.get(input.observationId);
			if (state === undefined || state.status !== "completed")
				throw new AutoResearchEngineError("execution_missing", "completed execution was not replayable");
			if (
				committed.commitStatus === "already_committed" &&
				digestObject(state.rawResultRefs) !== rawResultRefsDigest
			)
				throw new AutoResearchEngineError(
					"execution_conflict",
					"execution completion changed its raw result references",
				);
			return immutableCopy(state);
		});
	}

	/** Return one authenticated pending or completed execution handoff. */
	async execution(observationId: string): Promise<AutoResearchExecutionState | null> {
		return this.withAuthority(async () => {
			if (typeof observationId !== "string" || observationId.length === 0)
				throw new AutoResearchEngineError("execution_invalid", "observation ID is required");
			const state = this.state.executions.get(observationId);
			return state === undefined ? null : immutableCopy(state);
		});
	}

	async snapshot(): Promise<AutoResearchEngineSnapshot> {
		return this.withAuthority(async () => ({
			registrationDigest: this.state.registrationDigest,
			locked: this.state.locked,
			candidateIds: [...this.state.candidates.keys()].sort(),
			observationIds: [...this.state.observations.keys()].sort(),
			proposalIds: [...this.state.proposals.keys()].sort(),
			totalCostMicrounits: this.state.totalCostMicrounits,
			totalLatencyMilliseconds: this.state.totalLatencyMilliseconds,
		}));
	}

	/** Return the durable task receipt for one candidate, if it has already been submitted. */
	async taskReceipt(candidateId: string): Promise<AutoResearchTaskReceipt | null> {
		return this.withAuthority(async () => {
			if (typeof candidateId !== "string" || candidateId.length === 0)
				throw new AutoResearchEngineError("candidate_invalid", "candidate ID is required");
			const candidate = this.state.candidates.get(candidateId);
			return candidate === undefined ? null : immutableCopy(candidate.task);
		});
	}

	/** Return the full immutable candidate/task binding recovered from the host journal. */
	async candidate(candidateId: string): Promise<{
		readonly request: AutoResearchCandidateRequest;
		readonly task: AutoResearchTaskReceipt;
	} | null> {
		return this.withAuthority(async () => {
			if (typeof candidateId !== "string" || candidateId.length === 0)
				throw new AutoResearchEngineError("candidate_invalid", "candidate ID is required");
			const candidate = this.state.candidates.get(candidateId);
			return candidate === undefined ? null : immutableCopy(candidate);
		});
	}

	/** Return one committed evaluation, if replay has already completed it. */
	async evaluation(observationId: string): Promise<AutoResearchEvaluation | null> {
		return this.withAuthority(async () => {
			if (typeof observationId !== "string" || observationId.length === 0)
				throw new AutoResearchEngineError("observation_invalid", "observation ID is required");
			const result = this.state.observationResults.get(observationId);
			return result === undefined ? null : immutableCopy(result);
		});
	}

	/** Return host-authenticated holdout and adversarial evidence recovered from the journal. */
	async hostEvidence(): Promise<{
		readonly holdoutEvidenceRefs: readonly WorkflowArtifactRef[];
		readonly adversarialEvidenceRefs: readonly WorkflowArtifactRef[];
	}> {
		return this.withAuthority(async () =>
			immutableCopy({
				holdoutEvidenceRefs: this.state.holdoutEvidenceRefs,
				adversarialEvidenceRefs: this.state.adversarialEvidenceRefs,
			}),
		);
	}

	private review(observation: AutoResearchObservation): AutoResearchOverfittingReview {
		const registration = this.state.registration!;
		return reviewOverfitting({
			registration,
			observations: [...this.state.observations.values(), observation],
			evidenceRefs: [],
			hostHiddenHoldoutHandles: registration.hiddenHoldout === null ? [] : [registration.hiddenHoldout],
			resolverContexts:
				this.state.resolverContext === null
					? []
					: [{ ...this.state.resolverContext, authorizedConsumer: "host_overfitting_reviewer" }],
			hiddenHoldoutEvidenceRefs: this.state.holdoutEvidenceRefs,
			adversarialEvidenceRefs: this.state.adversarialEvidenceRefs,
			hiddenHoldoutEvidenceProofs: this.state.holdoutEvidenceProofs,
			adversarialEvidenceProofs: this.state.adversarialEvidenceProofs,
			phase: observation.phase,
		});
	}

	private async completePendingAcceptedProposal(
		intent: Extract<AutoResearchCommittedEvent, { kind: "accepted_proposal_intent" }>,
	): Promise<AutoResearchEvaluation> {
		const registration = this.state.registration;
		if (registration === null || this.state.registrationDigest === null)
			throw new AutoResearchEngineError("replay_lifecycle", "pending accepted proposal lacks its registration");
		const candidate = this.state.candidates.get(intent.observation.candidateId);
		if (candidate === undefined || candidate.request.attemptId !== intent.observation.attemptId)
			throw new AutoResearchEngineError("replay_integrity", "pending accepted proposal lacks its candidate task");
		const proposalInput: AutoResearchProposalCandidateInput = {
			registration,
			registrationDigest: this.state.registrationDigest,
			candidateRequest: candidate.request,
			task: candidate.task,
			observation: intent.observation,
			evidenceRefs: [],
			revisionResolution: registration.revisionResolution,
		};
		const committed = await this.host.submitAcceptedProposal({
			transactionDigest: intent.transactionDigest,
			evidence: intent.evidence,
			proposal: proposalInput,
		});
		if (committed.transactionDigest !== intent.transactionDigest)
			throw new AutoResearchEngineError(
				"transaction_integrity",
				"host proposal retry changed its transaction digest",
			);
		const evidenceRef = immutableCopy(committed.evidenceRef);
		const evidenceProof = immutableCopy(committed.evidenceProof);
		validateEvidenceProof(evidenceProof, registration, this.state.registrationDigest, evidenceRef, ["observation"]);
		if (digestObject(committed.proposal) !== intent.proposalDigest)
			throw new AutoResearchEngineError("proposal_integrity", "host proposal retry changed its proposal");
		const proposal = immutableCopy(committed.proposal);
		if (!proposalIsHostCandidate(proposal, registration, intent.observation, candidate, [evidenceRef]))
			throw new AutoResearchEngineError("proposal_integrity", "host proposal retry escaped the candidate boundary");
		await this.host.runtime.commit({
			event: {
				kind: "accepted_proposal_committed",
				registrationDigest: intent.registrationDigest,
				observation: intent.observation,
				accepted: true,
				reason: null,
				evidenceRef,
				evidenceProof,
				observationDigest: intent.observationDigest,
				decisionDigest: intent.decisionDigest,
				proposal,
				proposalDigest: digestObject(proposal),
				proposalObservationDigest: intent.observationDigest,
			},
		});
		await this.restore();
		return {
			accepted: true,
			reason: null,
			evidenceRefs: [evidenceRef],
			proposal,
			proposalOnly: true,
		};
	}

	private assertLocked(): void {
		if (!this.state.locked || this.state.registration === null || this.state.registrationDigest === null)
			throw new AutoResearchEngineError(
				"registration_unlocked",
				"experiment registration must be host-locked before work",
			);
	}

	private async withAuthority<T>(action: () => Promise<T>): Promise<T> {
		await this.ready();
		await this.restore();
		if (
			this.state.locked &&
			this.pendingRegistration !== null &&
			digestObject(this.pendingRegistration) !== this.state.registrationDigest
		)
			throw new AutoResearchEngineError(
				"registration_locked",
				"another host claim already locked a different registration",
			);
		if (!this.state.locked && this.pendingRegistration !== null) {
			this.state.registration = this.pendingRegistration;
			this.state.preRegisteredDigest = digestObject(this.pendingRegistration);
		}
		return action();
	}

	private async restore(): Promise<void> {
		const records = await this.host.runtime.replay();
		this.state = initialState();
		for (const [index, record] of records.entries()) this.applyCommittedEvent(record.event, index);
		if (this.state.locked && this.state.registration?.hiddenHoldout !== null && !this.state.holdoutSubmitted)
			throw new AutoResearchEngineError(
				"replay_lifecycle",
				"locked registration is missing its host holdout evidence",
			);
	}

	private applyObservationProjection(
		event: Extract<AutoResearchCommittedEvent, { kind: "observation_recorded" }>,
	): void {
		const observation = event.observation;
		this.state.observations.set(observation.observationId, observation);
		this.state.observationResults.set(observation.observationId, {
			accepted: event.accepted,
			reason: event.reason,
			evidenceRefs: [event.evidenceRef],
			proposal: null,
			proposalOnly: true,
		});
		const totalCostMicrounits = safeAdd(this.state.totalCostMicrounits, observation.costMicrounits, "total cost");
		const totalLatencyMilliseconds = safeAdd(
			this.state.totalLatencyMilliseconds,
			observation.latencyMilliseconds,
			"total latency",
		);
		const resourceUsage = addResource(this.state.resourceUsage, observation.resourceUsage);
		this.state.totalCostMicrounits = totalCostMicrounits;
		this.state.totalLatencyMilliseconds = totalLatencyMilliseconds;
		this.state.resourceUsage = resourceUsage;
	}

	private applyCommittedEvent(event: AutoResearchCommittedEvent, index: number): void {
		if (event.kind === "registration_locked") {
			if (index !== 0 || this.state.registrationDigest !== null)
				throw new AutoResearchEngineError(
					"replay_lifecycle",
					"registration lock must be the first and only lock event",
				);
			validateRegistration(event.registration);
			if (digestObject(event.registration) !== event.registrationDigest)
				throw new AutoResearchEngineError("replay_integrity", "registration digest does not match committed bytes");
			if (event.decisionResolution === undefined)
				throw new AutoResearchEngineError("replay_integrity", "registration lock lacks resolver context");
			validateDecisionResolution(
				event.decisionResolution,
				event.registration,
				event.registrationDigest,
				event.decisionRef,
			);
			this.state.registration = immutableCopy(event.registration);
			this.state.preRegisteredDigest = event.registrationDigest;
			this.state.registrationDigest = event.registrationDigest;
			this.state.locked = true;
			this.state.decisionRef = immutableCopy(event.decisionRef);
			this.state.decisionResolution = immutableCopy(event.decisionResolution);
			return;
		}
		if (event.kind === "holdout_submitted") {
			if (
				!this.state.locked ||
				this.state.holdoutSubmitted ||
				this.state.candidates.size > 0 ||
				this.state.registration?.hiddenHoldout === null
			)
				throw new AutoResearchEngineError(
					"replay_lifecycle",
					"holdout evidence must follow registration lock once",
				);
			this.assertEventRegistration(event.registrationDigest);
			if (
				event.evidenceRefs.length === 0 ||
				event.handleId !== this.state.registration!.hiddenHoldout?.handleId ||
				event.manifestDigest !== this.state.registration!.hiddenHoldout?.manifestDigest ||
				event.resolverContext === undefined ||
				event.evidenceProofs === undefined ||
				event.adversarialEvidenceProofs === undefined
			)
				throw new AutoResearchEngineError("replay_integrity", "holdout evidence cannot be empty");
			if (
				event.evidenceRefs.some((ref) => !validArtifactRef(ref)) ||
				event.adversarialEvidenceRefs.some((ref) => !validArtifactRef(ref))
			)
				throw new AutoResearchEngineError(
					"replay_integrity",
					"holdout evidence contains an invalid artifact reference",
				);
			if (
				!hasExactKeys(event.resolverContext, HOLDOUT_RESOLVER_KEYS) ||
				event.resolverContext.workflowId !== this.state.registration!.workflowId ||
				event.resolverContext.registrationDigest !== event.registrationDigest ||
				event.resolverContext.handleId !== event.handleId ||
				event.resolverContext.manifestDigest !== event.manifestDigest ||
				!event.resolverContext.authenticated ||
				!event.resolverContext.returnsEvidenceOnly ||
				event.resolverContext.returnsBytes ||
				event.resolverContext.resolverDigest.length === 0 ||
				!isRecord(event.resolverContext.epochRef) ||
				!Number.isSafeInteger(event.resolverContext.epochRef.storeEpoch) ||
				event.resolverContext.epochRef.storeEpoch <= 0 ||
				!Number.isSafeInteger(event.resolverContext.epochRef.coordinatorEpoch) ||
				event.resolverContext.epochRef.coordinatorEpoch <= 0 ||
				this.state.decisionResolution === null ||
				event.resolverContext.stateDigest !== this.state.decisionResolution.stateDigest ||
				event.resolverContext.epochRef.storeEpoch !== this.state.decisionResolution.epochRef.storeEpoch ||
				event.resolverContext.epochRef.coordinatorEpoch !==
					this.state.decisionResolution.epochRef.coordinatorEpoch ||
				event.evidenceProofs.length !== event.evidenceRefs.length ||
				event.adversarialEvidenceProofs.length !== event.adversarialEvidenceRefs.length
			)
				throw new AutoResearchEngineError("replay_integrity", "holdout resolver context is substituted");
			for (const [index, proof] of event.evidenceProofs.entries())
				validateEvidenceProof(
					proof,
					this.state.registration!,
					event.registrationDigest,
					event.evidenceRefs[index]!,
					["holdout"],
				);
			for (const [index, proof] of event.adversarialEvidenceProofs.entries())
				validateEvidenceProof(
					proof,
					this.state.registration!,
					event.registrationDigest,
					event.adversarialEvidenceRefs[index]!,
					["adversarial"],
				);
			if (
				event.adversarialEvidenceRefs.length > 0 &&
				!hasDistinctEvidence(event.evidenceRefs, event.adversarialEvidenceRefs)
			)
				throw new AutoResearchEngineError("replay_integrity", "holdout and adversarial evidence must not alias");
			this.state.holdoutSubmitted = true;
			this.state.holdoutEvidenceRefs = immutableCopy(event.evidenceRefs);
			this.state.adversarialEvidenceRefs = immutableCopy(event.adversarialEvidenceRefs);
			this.state.holdoutEvidenceProofs = immutableCopy(event.evidenceProofs);
			this.state.adversarialEvidenceProofs = immutableCopy(event.adversarialEvidenceProofs);
			this.state.resolverContext = immutableCopy(event.resolverContext);
			return;
		}
		if (event.kind === "candidate_submitted") {
			if (!this.state.locked)
				throw new AutoResearchEngineError("replay_lifecycle", "candidate precedes registration lock");
			this.assertEventRegistration(event.registrationDigest);
			validateCandidateRequest(event.request, "replayed candidate request");
			if (!sameBinding(event.commandInputBinding, this.state.registration!.commandInputBinding))
				throw new AutoResearchEngineError("replay_integrity", "candidate command/input binding changed");
			if (event.request.claimedCompletion || event.request.claimedPromotion)
				throw new AutoResearchEngineError("replay_integrity", "worker claim cannot be replayed as authority");
			if (this.state.candidates.has(event.request.candidateId))
				throw new AutoResearchEngineError("replay_integrity", "candidate claim is duplicated");
			if (this.state.candidates.size >= this.state.registration!.maxCandidates)
				throw new AutoResearchEngineError("replay_integrity", "candidate budget is exceeded");
			validateResourceVector(event.request.resourceRequest, "replayed candidate resource request");
			if (vectorExceeds(event.request.resourceRequest, this.state.registration!.resourceCeiling))
				throw new AutoResearchEngineError("replay_integrity", "replayed candidate exceeds the resource ceiling");
			if (
				!hasExactKeys(event.task, TASK_RECEIPT_KEYS) ||
				typeof event.task.taskId !== "string" ||
				typeof event.task.candidateId !== "string" ||
				typeof event.task.attemptId !== "string" ||
				typeof event.task.changeDigest !== "string" ||
				typeof event.task.taskDigest !== "string" ||
				event.task.taskId !== event.request.candidateId ||
				event.task.candidateId !== event.request.candidateId ||
				event.task.attemptId !== event.request.attemptId ||
				event.task.changeDigest !== event.request.changeDigest ||
				event.task.taskDigest.length === 0
			)
				throw new AutoResearchEngineError("replay_integrity", "candidate task receipt is not bound to its attempt");
			if (
				event.semanticDigest === undefined ||
				event.semanticDigest !== digestObject({ request: event.request, task: event.task }) ||
				event.candidateBindingDigest !==
					candidateExecutionBindingDigest(event.registrationDigest, event.request, event.task)
			)
				throw new AutoResearchEngineError("replay_integrity", "candidate semantic digest is substituted");
			this.state.candidates.set(event.request.candidateId, {
				request: immutableCopy(event.request),
				task: immutableCopy(event.task),
			});
			return;
		}
		if (event.kind === "candidate_execution_intent") {
			if (
				!hasExactKeys(event, [
					"candidateBindingDigest",
					"candidateRequest",
					"executionDigest",
					"kind",
					"observationId",
					"registrationDigest",
					"task",
				]) ||
				!this.state.locked ||
				this.state.executions.has(event.observationId) ||
				typeof event.observationId !== "string" ||
				event.observationId.length === 0
			)
				throw new AutoResearchEngineError(
					"replay_lifecycle",
					"candidate execution intent is duplicated or misplaced",
				);
			this.assertEventRegistration(event.registrationDigest);
			validateCandidateRequest(event.candidateRequest, "replayed execution candidate");
			const candidate = this.state.candidates.get(event.candidateRequest.candidateId);
			if (
				candidate === undefined ||
				candidate.request.attemptId !== event.candidateRequest.attemptId ||
				digestObject(candidate.request) !== digestObject(event.candidateRequest) ||
				digestObject(candidate.task) !== digestObject(event.task) ||
				!hasExactKeys(event.task, TASK_RECEIPT_KEYS) ||
				event.task.taskId !== event.candidateRequest.candidateId ||
				event.task.candidateId !== event.candidateRequest.candidateId ||
				event.task.attemptId !== event.candidateRequest.attemptId ||
				event.task.changeDigest !== event.candidateRequest.changeDigest ||
				event.candidateBindingDigest !==
					candidateExecutionBindingDigest(event.registrationDigest, event.candidateRequest, event.task) ||
				event.executionDigest !==
					candidateExecutionDigest(event.registrationDigest, event.observationId, event.candidateBindingDigest)
			)
				throw new AutoResearchEngineError("replay_integrity", "candidate execution intent binding is substituted");
			this.state.executions.set(
				event.observationId,
				immutableCopy({
					status: "pending" as const,
					observationId: event.observationId,
					candidateId: event.candidateRequest.candidateId,
					attemptId: event.candidateRequest.attemptId,
					candidateBindingDigest: event.candidateBindingDigest,
					executionDigest: event.executionDigest,
					rawResultRefs: [],
				}),
			);
			return;
		}
		if (event.kind === "candidate_execution_completed") {
			if (
				!hasExactKeys(event, [
					"candidateBindingDigest",
					"candidateRequest",
					"executionDigest",
					"kind",
					"observationId",
					"rawResultRefs",
					"rawResultRefsDigest",
					"registrationDigest",
					"task",
				]) ||
				!this.state.locked
			)
				throw new AutoResearchEngineError("replay_lifecycle", "candidate execution completion is misplaced");
			this.assertEventRegistration(event.registrationDigest);
			const pending = this.state.executions.get(event.observationId);
			const candidate = this.state.candidates.get(event.candidateRequest.candidateId);
			validateCandidateRequest(event.candidateRequest, "replayed completed execution candidate");
			if (
				pending === undefined ||
				pending.status !== "pending" ||
				candidate === undefined ||
				digestObject(candidate.request) !== digestObject(event.candidateRequest) ||
				digestObject(candidate.task) !== digestObject(event.task) ||
				event.candidateBindingDigest !== pending.candidateBindingDigest ||
				event.executionDigest !== pending.executionDigest ||
				!Array.isArray(event.rawResultRefs) ||
				event.rawResultRefs.length === 0 ||
				event.rawResultRefs.length > 32 ||
				event.rawResultRefs.some((ref) => !validArtifactRef(ref)) ||
				new Set(event.rawResultRefs.map(evidenceKey)).size !== event.rawResultRefs.length ||
				event.rawResultRefsDigest !== digestObject(event.rawResultRefs)
			)
				throw new AutoResearchEngineError("replay_integrity", "candidate execution completion is substituted");
			this.state.executions.set(
				event.observationId,
				immutableCopy({
					status: "completed" as const,
					observationId: event.observationId,
					candidateId: event.candidateRequest.candidateId,
					attemptId: event.candidateRequest.attemptId,
					candidateBindingDigest: event.candidateBindingDigest,
					executionDigest: event.executionDigest,
					rawResultRefs: event.rawResultRefs,
				}),
			);
			return;
		}
		if (event.kind === "accepted_proposal_committed") {
			if (
				event.accepted !== true ||
				event.reason !== null ||
				event.observationDigest !== digestObject(event.observation) ||
				event.proposalObservationDigest !== event.observationDigest ||
				event.proposalDigest !== digestObject(event.proposal)
			)
				throw new AutoResearchEngineError(
					"replay_integrity",
					"replay accepted proposal transaction semantic digests are substituted",
				);
			this.applyCommittedEvent(
				{
					kind: "observation_recorded",
					registrationDigest: event.registrationDigest,
					observation: event.observation,
					accepted: true,
					reason: null,
					evidenceRef: event.evidenceRef,
					evidenceProof: event.evidenceProof,
					observationDigest: event.observationDigest,
					decisionDigest: event.decisionDigest,
				},
				index,
			);
			this.applyCommittedEvent(
				{
					kind: "proposal_emitted",
					registrationDigest: event.registrationDigest,
					observationId: event.observation.observationId,
					proposal: event.proposal,
					proposalDigest: event.proposalDigest,
					observationDigest: event.proposalObservationDigest,
				},
				index,
			);
			this.state.pendingAcceptedProposals.delete(event.observation.observationId);
			return;
		}
		if (event.kind === "accepted_proposal_intent") {
			const candidate = this.state.candidates.get(event.observation.candidateId);
			if (
				!this.state.locked ||
				candidate === undefined ||
				candidate.request.attemptId !== event.observation.attemptId ||
				event.observationDigest !== digestObject(event.observation) ||
				event.proposalDigest !== digestObject(event.proposal) ||
				event.decisionDigest !==
					digestObject({ observationDigest: event.observationDigest, accepted: true, reason: null }) ||
				event.evidence.runId !== this.state.registration?.runId ||
				event.evidence.candidateId !== event.observation.candidateId ||
				event.evidence.attemptId !== event.observation.attemptId ||
				event.evidence.observationId !== event.observation.observationId ||
				event.evidence.outcome !== "accepted" ||
				event.evidence.reason !== null ||
				digestObject(event.evidence.observation) !== event.observationDigest ||
				event.evidence.observation.observationId !== event.observation.observationId
			)
				throw new AutoResearchEngineError(
					"replay_integrity",
					"replay accepted proposal intent is not semantically bound",
				);
			this.assertEventRegistration(event.registrationDigest);
			validateObservationNumbers(event.observation);
			if (
				!proposalIsHostCandidate(event.proposal, this.state.registration!, event.observation, candidate) ||
				observationReason(this.state, event.observation) !== null
			)
				throw new AutoResearchEngineError(
					"replay_integrity",
					"accepted proposal intent is not reproducible from host-resolved state",
				);
			const reviewBoundary =
				event.observation.phase === "holdout"
					? "holdout_passed"
					: event.observation.phase === "independent_review"
						? "independent_review"
						: event.observation.phase === "promotion"
							? "promoted"
							: event.observation.phase === "completion"
								? "completion"
								: event.observation.phase === "canary"
									? "canary"
									: null;
			if (reviewBoundary !== null) {
				const intentReview = this.review(event.observation);
				if (!canProceedWithOverfittingReview(intentReview, reviewBoundary, intentReview.receipt))
					throw new AutoResearchEngineError(
						"replay_integrity",
						"accepted proposal intent failed host overfitting review",
					);
			}
			const transactionDigest = digestObject({
				registrationDigest: this.state.registrationDigest,
				candidateRequest: candidate.request,
				task: candidate.task,
				observationDigest: event.observationDigest,
				proposalDigest: event.proposalDigest,
				evidence: event.evidence,
				proposal: event.proposal,
			});
			if (event.transactionDigest !== transactionDigest)
				throw new AutoResearchEngineError(
					"replay_integrity",
					"accepted proposal intent transaction digest is substituted",
				);
			if (this.state.pendingAcceptedProposals.has(event.observation.observationId))
				throw new AutoResearchEngineError("replay_integrity", "accepted proposal intent is duplicated");
			if (this.state.observations.has(event.observation.observationId))
				throw new AutoResearchEngineError("replay_lifecycle", "accepted proposal intent follows its observation");
			this.state.pendingAcceptedProposals.set(event.observation.observationId, immutableCopy(event));
			return;
		}
		if (event.kind === "observation_recorded") {
			if (!this.state.locked)
				throw new AutoResearchEngineError("replay_lifecycle", "observation precedes registration lock");
			this.assertEventRegistration(event.registrationDigest);
			const candidate = this.state.candidates.get(event.observation.candidateId);
			if (candidate === undefined || candidate.request.attemptId !== event.observation.attemptId)
				throw new AutoResearchEngineError("replay_integrity", "observation is not bound to a candidate attempt");
			if (this.state.observations.has(event.observation.observationId))
				throw new AutoResearchEngineError("replay_integrity", "observation is duplicated");
			if (event.accepted && event.reason !== null)
				throw new AutoResearchEngineError(
					"replay_integrity",
					"accepted observation cannot carry a rejection reason",
				);
			if (!event.accepted && event.reason === null)
				throw new AutoResearchEngineError("replay_integrity", "rejected observation requires a reason");
			if (!validArtifactRef(event.evidenceRef))
				throw new AutoResearchEngineError("replay_integrity", "observation evidence reference is invalid");
			validateObservationNumbers(event.observation);
			const expectedObservationDigest = digestObject(event.observation);
			if (
				event.observation.source !== "host" ||
				event.observationDigest === undefined ||
				event.observationDigest !== expectedObservationDigest ||
				event.observation.measurementDigest !== observationMeasurementDigest(event.observation)
			)
				throw new AutoResearchEngineError(
					"replay_integrity",
					"observation semantic digest integrity is substituted",
				);
			if (
				event.decisionDigest === undefined ||
				event.decisionDigest !==
					digestObject({
						observationDigest: expectedObservationDigest,
						accepted: event.accepted,
						reason: event.reason,
					})
			)
				throw new AutoResearchEngineError("replay_integrity", "observation outcome semantic digest is substituted");
			if (event.accepted && event.evidenceProof === undefined)
				throw new AutoResearchEngineError("replay_integrity", "accepted observation lacks authenticated evidence");
			if (event.evidenceProof !== undefined)
				validateEvidenceProof(
					event.evidenceProof,
					this.state.registration!,
					event.registrationDigest,
					event.evidenceRef,
					["observation"],
				);
			let expectedReason = observationReason(this.state, event.observation);
			if (expectedReason === null) {
				const review = this.review(event.observation);
				const boundary =
					event.observation.phase === "holdout"
						? "holdout_passed"
						: event.observation.phase === "independent_review"
							? "independent_review"
							: event.observation.phase === "promotion"
								? "promoted"
								: event.observation.phase === "completion"
									? "completion"
									: event.observation.phase === "canary"
										? "canary"
										: null;
				if (boundary !== null && !canProceedWithOverfittingReview(review, boundary, review.receipt))
					expectedReason = "blocking overfitting review failed";
			}
			if (event.accepted !== (expectedReason === null) || event.reason !== expectedReason)
				throw new AutoResearchEngineError(
					"replay_integrity",
					"observation admission outcome is not reproducible from host-resolved measurements",
				);
			this.applyObservationProjection({
				...event,
				observation: immutableCopy(event.observation),
				evidenceRef: immutableCopy(event.evidenceRef),
			});
			return;
		}
		if (event.kind === "proposal_emitted") {
			if (!this.state.locked)
				throw new AutoResearchEngineError("replay_lifecycle", "proposal precedes registration lock");
			this.assertEventRegistration(event.registrationDigest);
			const result = this.state.observationResults.get(event.observationId);
			if (result === undefined || !result.accepted)
				throw new AutoResearchEngineError("replay_lifecycle", "proposal requires accepted observation evidence");
			if (result.proposal !== null)
				throw new AutoResearchEngineError("replay_integrity", "proposal is duplicated for the observation");
			if (
				event.observationDigest === undefined ||
				event.observationDigest !== digestObject(this.state.observations.get(event.observationId)!)
			)
				throw new AutoResearchEngineError(
					"replay_integrity",
					"proposal observation semantic digest is substituted",
				);
			if (
				!proposalIsHostCandidate(
					event.proposal,
					this.state.registration!,
					this.state.observations.get(event.observationId)!,
					this.state.candidates.get(this.state.observations.get(event.observationId)!.candidateId)!,
					result.evidenceRefs,
				)
			)
				throw new AutoResearchEngineError("replay_integrity", "replayed proposal is not a host-owned candidate");
			if (this.state.proposals.has(event.proposal.proposalId))
				throw new AutoResearchEngineError("replay_integrity", "proposal is duplicated");
			if (event.proposalDigest === undefined || event.proposalDigest !== digestObject(event.proposal))
				throw new AutoResearchEngineError("replay_integrity", "proposal semantic digest is substituted");
			this.state.proposals.set(event.proposal.proposalId, immutableCopy(event.proposal));
			this.state.observationResults.set(event.observationId, { ...result, proposal: event.proposal });
			return;
		}
		throw new AutoResearchEngineError("replay_integrity", "unknown committed AutoResearch event");
	}

	private assertEventRegistration(registrationDigest: string): void {
		if (this.state.registrationDigest === null || this.state.registrationDigest !== registrationDigest)
			throw new AutoResearchEngineError("replay_integrity", "event registration digest is not bound to the lock");
	}
}

export type AutoResearchEngine = NativeExperimentEngine;

/** Create and restore the native adapter from the host's committed event port. */
export async function createNativeExperimentEngine(host: AutoResearchHostPorts): Promise<NativeExperimentEngine> {
	const engine = new NativeExperimentEngine(host);
	await engine.ready();
	return engine;
}
