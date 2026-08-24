import type { WorkflowArtifactRef } from "../workflow/contracts.js";
import { digestObject } from "../workflow/contracts.js";
import type {
	AutoResearchEvidenceProof,
	AutoResearchExperimentRegistration,
	AutoResearchFixtureRegistration,
	AutoResearchHoldoutResolverBinding,
	AutoResearchHostOnlyHoldoutHandle,
	AutoResearchObservation,
	AutoResearchObservationPhase,
} from "./types.js";

export const AUTO_RESEARCH_OVERFITTING_CHECKS = Object.freeze([
	"metric_preregistration_lock",
	"sample_adequacy",
	"train_eval_separation",
	"test_contamination",
	"repeated_holdout_peeking",
	"proxy_exploitation",
	"variance_replicate_stability",
	"hidden_adversarial_generalization",
] as const);

export type AutoResearchOverfittingCheckKind = (typeof AUTO_RESEARCH_OVERFITTING_CHECKS)[number];

export const AUTO_RESEARCH_OVERFITTING_BLOCKING_BOUNDARIES = Object.freeze([
	"holdout_passed",
	"canary",
	"independent_review",
	"promoted",
	"milestone_acceptance",
	"completion",
] as const);

export type AutoResearchOverfittingBlockingBoundary = (typeof AUTO_RESEARCH_OVERFITTING_BLOCKING_BOUNDARIES)[number];
export type AutoResearchOverfittingCheckDisposition = "pass" | "fail" | "inconclusive";
export type AutoResearchOverfittingReviewDisposition = "advisory" | "blocking";
export type AutoResearchOverfittingPhase = AutoResearchObservationPhase | AutoResearchOverfittingBlockingBoundary;

export interface AutoResearchHoldoutResolverContext extends AutoResearchHoldoutResolverBinding {
	authorizedConsumer: "host_overfitting_reviewer";
}

export interface AutoResearchOverfittingInput {
	registration: AutoResearchExperimentRegistration;
	observations: readonly AutoResearchObservation[];
	evidenceRefs: readonly WorkflowArtifactRef[];
	hostHiddenHoldoutHandles: readonly AutoResearchHostOnlyHoldoutHandle[];
	resolverContexts?: readonly AutoResearchHoldoutResolverContext[];
	hiddenHoldoutEvidenceRefs: readonly WorkflowArtifactRef[];
	adversarialEvidenceRefs: readonly WorkflowArtifactRef[];
	hiddenHoldoutEvidenceProofs?: readonly AutoResearchEvidenceProof[];
	adversarialEvidenceProofs?: readonly AutoResearchEvidenceProof[];
	phase?: AutoResearchOverfittingPhase;
}

export interface AutoResearchOverfittingCheckResult {
	checkKind: AutoResearchOverfittingCheckKind;
	disposition: AutoResearchOverfittingCheckDisposition;
	evidenceRefs: readonly WorkflowArtifactRef[];
	hostHiddenHoldoutHandles: readonly AutoResearchHostOnlyHoldoutHandle[];
	resolverContexts: readonly AutoResearchHoldoutResolverContext[];
	hiddenHoldoutBytesExposed: false;
	resultDigest: string;
}

export interface AutoResearchOverfittingReview {
	reviewId: string;
	registrationDigest: string;
	checkResults: readonly AutoResearchOverfittingCheckResult[];
	disposition: AutoResearchOverfittingReviewDisposition;
	explorationAdvisory: true;
	blockingBefore: readonly AutoResearchOverfittingBlockingBoundary[];
	proposerSeesHiddenHoldoutBytes: false;
	reviewerCanAuthorize: false;
	canAuthorize: false;
	emitsEvidenceOnly: true;
	authorityCapabilities: readonly [];
	accepted: boolean;
	reviewDigest: string;
	receipt: AutoResearchOverfittingReviewReceipt;
}

export interface AutoResearchOverfittingReviewReceipt {
	reviewDigest: string;
	registrationDigest: string;
	boundary: AutoResearchOverfittingBlockingBoundary | "advisory";
	authenticated: true;
	fresh: true;
	revoked: false;
	receiptDigest: string;
}

const ARTIFACT_REF_KEYS = ["artifactId", "digest", "relativePath", "sizeBytes", "sourceEventSequence"] as const;
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
const RESOLVER_CONTEXT_KEYS = [
	"authenticated",
	"authorizedConsumer",
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
const EPOCH_KEYS = ["coordinatorEpoch", "storeEpoch"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
	return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}

function reviewBoundary(input: AutoResearchOverfittingInput): AutoResearchOverfittingReviewReceipt["boundary"] {
	if (input.phase === undefined || input.phase === "exploration") return "advisory";
	if (input.phase === "holdout" || input.phase === "holdout_passed") return "holdout_passed";
	if (input.phase === "canary") return "canary";
	if (input.phase === "independent_review") return "independent_review";
	if (input.phase === "promotion" || input.phase === "promoted") return "promoted";
	if (input.phase === "completion") return "completion";
	return "advisory";
}

function hasUnsafeHiddenBytes(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	if (Array.isArray(value)) return value.some(hasUnsafeHiddenBytes);
	return Object.entries(value).some(([key, nested]) => {
		if (["hiddenHoldoutBytes", "rawBytes", "bytes"].includes(key)) return true;
		return hasUnsafeHiddenBytes(nested);
	});
}

function fixtureDigest(registration: AutoResearchExperimentRegistration): string {
	return registration.fixtures
		.filter((fixture) => fixture.partition === "train" || fixture.partition === "eval")
		.map((fixture) => fixture.manifestDigest)
		.filter((digest, index, values) => values.indexOf(digest) === index)
		.sort()
		.join("|");
}

function fixtureForPartition(
	fixtures: readonly AutoResearchFixtureRegistration[],
	partition: AutoResearchFixtureRegistration["partition"],
): readonly AutoResearchFixtureRegistration[] {
	return fixtures.filter((fixture) => fixture.partition === partition);
}

function expectedVisibleInputs(registration: AutoResearchExperimentRegistration): {
	train: readonly string[];
	eval: readonly string[];
} {
	return {
		train: fixtureForPartition(registration.fixtures, "train").map((fixture) => fixture.inputDigest),
		eval: fixtureForPartition(registration.fixtures, "eval").map((fixture) => fixture.inputDigest),
	};
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

function validArtifactRef(ref: WorkflowArtifactRef): boolean {
	return (
		hasExactKeys(ref, ARTIFACT_REF_KEYS) &&
		typeof ref.artifactId === "string" &&
		ref.artifactId.length > 0 &&
		typeof ref.relativePath === "string" &&
		/^([A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(ref.relativePath) &&
		typeof ref.digest === "string" &&
		ref.digest.length > 0 &&
		Number.isSafeInteger(ref.sizeBytes) &&
		ref.sizeBytes >= 0 &&
		Number.isSafeInteger(ref.sourceEventSequence) &&
		ref.sourceEventSequence >= 0
	);
}

function validEvidenceProof(
	proof: AutoResearchEvidenceProof | undefined,
	ref: WorkflowArtifactRef,
	registration: AutoResearchExperimentRegistration,
	kind: AutoResearchEvidenceProof["kind"],
): boolean {
	if (
		proof === undefined ||
		proof === null ||
		!hasExactKeys(proof, EVIDENCE_PROOF_KEYS) ||
		!validArtifactRef(ref) ||
		!validArtifactRef(proof.ref) ||
		typeof proof.workflowId !== "string" ||
		typeof proof.registrationDigest !== "string" ||
		typeof proof.proofDigest !== "string" ||
		digestObject(proof.ref) !== digestObject(ref) ||
		proof.workflowId !== registration.workflowId ||
		proof.registrationDigest !== digestObject(registration) ||
		proof.kind !== kind ||
		!proof.authenticated ||
		!proof.fresh ||
		proof.revoked ||
		typeof proof.proofDigest !== "string" ||
		proof.proofDigest.length === 0
	)
		return false;
	const { proofDigest, ...preimage } = proof;
	return proofDigest === digestObject(preimage);
}

function validResolverContext(
	context: AutoResearchHoldoutResolverContext,
	registration: AutoResearchExperimentRegistration,
): boolean {
	return (
		hasExactKeys(context, RESOLVER_CONTEXT_KEYS) &&
		typeof context.contextId === "string" &&
		typeof context.workflowId === "string" &&
		typeof context.registrationDigest === "string" &&
		typeof context.handleId === "string" &&
		typeof context.manifestDigest === "string" &&
		typeof context.stateDigest === "string" &&
		typeof context.resolverDigest === "string" &&
		isRecord(context.epochRef) &&
		JSON.stringify(Object.keys(context.epochRef).sort()) === JSON.stringify([...EPOCH_KEYS].sort()) &&
		Number.isSafeInteger(context.epochRef.storeEpoch) &&
		context.epochRef.storeEpoch > 0 &&
		Number.isSafeInteger(context.epochRef.coordinatorEpoch) &&
		context.epochRef.coordinatorEpoch > 0 &&
		context.contextId.length > 0 &&
		context.workflowId === registration.workflowId &&
		context.registrationDigest === digestObject(registration) &&
		context.handleId === registration.hiddenHoldout?.handleId &&
		context.manifestDigest === registration.hiddenHoldout?.manifestDigest &&
		context.stateDigest.length > 0 &&
		context.resolverDigest.length > 0 &&
		context.authorizedConsumer === "host_overfitting_reviewer" &&
		context.authenticated &&
		context.returnsEvidenceOnly &&
		!context.returnsBytes
	);
}

function validateHostObservation(
	input: AutoResearchOverfittingInput,
	observation: AutoResearchObservation,
): AutoResearchOverfittingCheckDisposition {
	if (
		!isRecord(observation) ||
		!isRecord(observation.commandInputBinding) ||
		!isRecord(observation.resourceUsage) ||
		!Array.isArray(observation.proxySignals) ||
		observation.source !== "host"
	)
		return "fail";
	if (!Number.isSafeInteger(observation.sampleCount) || observation.sampleCount <= 0) return "fail";
	if (
		!Number.isFinite(observation.metricValue) ||
		!Number.isFinite(observation.baselineMetricValue) ||
		!Number.isFinite(observation.metricTarget) ||
		!Number.isFinite(observation.metricTolerance) ||
		observation.metricTolerance < 0 ||
		!Number.isFinite(observation.variance) ||
		observation.variance < 0 ||
		Math.abs(observation.metricTarget) > Number.MAX_SAFE_INTEGER ||
		Math.abs(observation.metricTolerance) > Number.MAX_SAFE_INTEGER ||
		Math.abs(observation.metricValue) > Number.MAX_SAFE_INTEGER ||
		Math.abs(observation.baselineMetricValue) > Number.MAX_SAFE_INTEGER ||
		Math.abs(observation.metricTarget + observation.metricTolerance) > Number.MAX_SAFE_INTEGER ||
		Math.abs(observation.metricTarget - observation.metricTolerance) > Number.MAX_SAFE_INTEGER
	)
		return "fail";
	for (const value of [observation.hiddenMetricValue, observation.adversarialMetricValue]) {
		if (value !== null && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return "fail";
	}
	if (
		!Number.isFinite(observation.costMicrounits) ||
		!Number.isFinite(observation.latencyMilliseconds) ||
		observation.costMicrounits < 0 ||
		observation.latencyMilliseconds < 0 ||
		Math.abs(observation.costMicrounits) > Number.MAX_SAFE_INTEGER ||
		Math.abs(observation.latencyMilliseconds) > Number.MAX_SAFE_INTEGER ||
		observation.proxySignals.some((signal) => typeof signal !== "string")
	)
		return "fail";
	if (
		observation.status !== "complete" ||
		observation.candidateClaimedCompletion !== false ||
		observation.candidateClaimedPromotion !== false ||
		observation.claimedCompletion === true ||
		observation.claimedPromotion === true
	)
		return "fail";
	if (observation.measurementDigest !== observationMeasurementDigest(observation)) return "fail";
	const expected = expectedVisibleInputs(input.registration);
	if (!expected.train.includes(observation.trainInputDigest) || !expected.eval.includes(observation.evalInputDigest))
		return "fail";
	return "pass";
}

function makeCheck(
	checkKind: AutoResearchOverfittingCheckKind,
	dispositionValue: AutoResearchOverfittingCheckDisposition,
	input: AutoResearchOverfittingInput,
	evidenceRefs: readonly WorkflowArtifactRef[] = input.evidenceRefs,
): AutoResearchOverfittingCheckResult {
	const resolverContexts = input.resolverContexts ?? [];
	const preimage = {
		checkKind,
		disposition: dispositionValue,
		evidenceRefs,
		handles: input.hostHiddenHoldoutHandles,
		resolverContexts,
	};
	return {
		checkKind,
		disposition: dispositionValue,
		evidenceRefs,
		hostHiddenHoldoutHandles: input.hostHiddenHoldoutHandles,
		resolverContexts,
		hiddenHoldoutBytesExposed: false,
		resultDigest: digestObject(preimage),
	};
}

function validateHostHandles(input: AutoResearchOverfittingInput): void {
	if (hasUnsafeHiddenBytes(input)) throw new Error("overfitting review cannot receive hidden holdout bytes");
	if (
		input.registration.hiddenHoldout === null
			? input.hostHiddenHoldoutHandles.length !== 0
			: input.hostHiddenHoldoutHandles.length !== 1 ||
				input.hostHiddenHoldoutHandles[0]?.handleId !== input.registration.hiddenHoldout.handleId ||
				input.hostHiddenHoldoutHandles[0]?.manifestDigest !== input.registration.hiddenHoldout.manifestDigest
	)
		throw new Error("overfitting review holdout handle is not bound to registration");
	for (const handle of input.hostHiddenHoldoutHandles) {
		if (
			!hasExactKeys(handle, HOLDOUT_HANDLE_KEYS) ||
			typeof handle.handleId !== "string" ||
			typeof handle.manifestDigest !== "string" ||
			!Number.isSafeInteger(handle.caseCount) ||
			handle.caseCount <= 0 ||
			handle.owner !== "host" ||
			!handle.hidden ||
			!handle.opaque ||
			!handle.hostResolverOnly ||
			handle.bytesAccessibleToProposer ||
			handle.bytesAccessibleToWorker
		)
			throw new Error("overfitting review requires opaque host-only holdout handles");
	}
	for (const context of input.resolverContexts ?? []) {
		if (!validResolverContext(context, input.registration))
			throw new Error("hidden holdout resolver context is unauthorized");
	}
}

function checkMetricLock(input: AutoResearchOverfittingInput): AutoResearchOverfittingCheckDisposition {
	const registration = input.registration;
	const expectedFixtureDigest = fixtureDigest(registration);
	return input.observations.some(
		(observation) =>
			validateHostObservation(input, observation) === "fail" ||
			observation.evaluatorDigest !== registration.evaluator.evaluatorDigest ||
			observation.parserDigest !== registration.evaluator.parserDigest ||
			observation.guardDigest !== (registration.guard?.guardDigest ?? null) ||
			observation.seedDigest !== registration.seed.seedDigest ||
			observation.metricDirection !== registration.metric.direction ||
			observation.metricTarget !== registration.metric.target ||
			observation.metricTolerance !== registration.metric.tolerance ||
			observation.commandInputBinding === undefined ||
			observation.commandInputBinding.commandDigest !== registration.commandInputBinding.commandDigest ||
			observation.commandInputBinding.bindingDigest !== registration.commandInputBinding.bindingDigest ||
			JSON.stringify([...observation.commandInputBinding.inputDigests].sort()) !==
				JSON.stringify([...registration.commandInputBinding.inputDigests].sort()) ||
			observation.fixtureManifestDigest !== expectedFixtureDigest,
	)
		? "fail"
		: "pass";
}

function checkSample(input: AutoResearchOverfittingInput): AutoResearchOverfittingCheckDisposition {
	if (
		input.observations.some(
			(observation) =>
				!Number.isSafeInteger(observation.sampleCount) ||
				observation.sampleCount <= 0 ||
				observation.sampleCount < input.registration.requiredSampleSize,
		)
	)
		return "fail";
	return input.observations.length === 0 ? "inconclusive" : "pass";
}

function checkTrainEvalSeparation(input: AutoResearchOverfittingInput): AutoResearchOverfittingCheckDisposition {
	const train = fixtureForPartition(input.registration.fixtures, "train").map((fixture) => fixture.inputDigest);
	const evalInputs = fixtureForPartition(input.registration.fixtures, "eval").map((fixture) => fixture.inputDigest);
	const observationLeak = input.observations.some(
		(observation) =>
			observation.trainInputDigest === observation.evalInputDigest ||
			!train.includes(observation.trainInputDigest) ||
			!evalInputs.includes(observation.evalInputDigest),
	);
	return observationLeak || train.some((digest) => evalInputs.includes(digest)) ? "fail" : "pass";
}

function checkContamination(input: AutoResearchOverfittingInput): AutoResearchOverfittingCheckDisposition {
	const all = input.registration.fixtures.map((fixture) => fixture.inputDigest);
	const manifests = input.registration.fixtures.map((fixture) => fixture.manifestDigest);
	return new Set(all).size === all.length && new Set(manifests).size === manifests.length ? "pass" : "fail";
}

function checkPeeking(input: AutoResearchOverfittingInput): AutoResearchOverfittingCheckDisposition {
	const holdoutObservations = input.observations.filter(
		(observation) => observation.phase === "holdout" || observation.heldOutInputDigest !== null,
	);
	if (holdoutObservations.length > 1) return "fail";
	if (holdoutObservations.some((observation) => observation.heldOutInputDigest === null)) return "fail";
	return "pass";
}

function checkProxy(input: AutoResearchOverfittingInput): AutoResearchOverfittingCheckDisposition {
	return input.observations.some((observation) => observation.proxySignals.length > 0) ? "fail" : "pass";
}

function checkVariance(input: AutoResearchOverfittingInput): AutoResearchOverfittingCheckDisposition {
	return input.observations.some(
		(observation) =>
			!Number.isFinite(observation.variance) ||
			observation.variance < 0 ||
			observation.variance > input.registration.maxVariance ||
			Math.abs(observation.variance) > Number.MAX_SAFE_INTEGER,
	)
		? "fail"
		: "pass";
}

function hasUniqueEvidence(refs: readonly WorkflowArtifactRef[]): boolean {
	return (
		refs.every(validArtifactRef) && new Set(refs.map((ref) => `${ref.artifactId}:${ref.digest}`)).size === refs.length
	);
}

function improves(direction: "lower" | "higher", candidate: number, baseline: number): boolean {
	return direction === "lower" ? candidate < baseline : candidate > baseline;
}

function checkGeneralization(input: AutoResearchOverfittingInput): AutoResearchOverfittingCheckDisposition {
	const blockingBoundary =
		input.phase === "promotion" || input.phase === "completion" || input.phase === "holdout_passed";
	if (
		input.hostHiddenHoldoutHandles.length === 0 ||
		input.hiddenHoldoutEvidenceRefs.length === 0 ||
		input.adversarialEvidenceRefs.length === 0
	)
		return blockingBoundary ? "fail" : "inconclusive";
	if (input.resolverContexts?.length !== input.hostHiddenHoldoutHandles.length)
		return blockingBoundary ? "fail" : "inconclusive";
	if (
		(input.hiddenHoldoutEvidenceProofs?.length ?? 0) !== input.hiddenHoldoutEvidenceRefs.length ||
		(input.adversarialEvidenceProofs?.length ?? 0) !== input.adversarialEvidenceRefs.length ||
		(input.hiddenHoldoutEvidenceProofs ?? []).some(
			(proof) => !proof.authenticated || proof.revoked || !proof.fresh,
		) ||
		(input.adversarialEvidenceProofs ?? []).some((proof) => !proof.authenticated || proof.revoked || !proof.fresh)
	)
		return "fail";
	if (
		input.hiddenHoldoutEvidenceRefs.some(
			(ref, index) =>
				!validEvidenceProof(input.hiddenHoldoutEvidenceProofs?.[index], ref, input.registration, "holdout"),
		) ||
		input.adversarialEvidenceRefs.some(
			(ref, index) =>
				!validEvidenceProof(input.adversarialEvidenceProofs?.[index], ref, input.registration, "adversarial"),
		)
	)
		return "fail";
	if (input.observations.length === 0) return "fail";
	if (!hasUniqueEvidence(input.hiddenHoldoutEvidenceRefs) || !hasUniqueEvidence(input.adversarialEvidenceRefs))
		return "fail";
	const hiddenEvidence = new Set(input.hiddenHoldoutEvidenceRefs.map((ref) => `${ref.artifactId}:${ref.digest}`));
	if (input.adversarialEvidenceRefs.some((ref) => hiddenEvidence.has(`${ref.artifactId}:${ref.digest}`)))
		return "fail";
	return input.observations.some((observation) => {
		if (observation.hiddenMetricValue === null || observation.adversarialMetricValue === null)
			return blockingBoundary;
		if (
			!Number.isFinite(observation.hiddenMetricValue) ||
			!Number.isFinite(observation.adversarialMetricValue) ||
			Math.abs(observation.hiddenMetricValue) > Number.MAX_SAFE_INTEGER ||
			Math.abs(observation.adversarialMetricValue) > Number.MAX_SAFE_INTEGER
		)
			return true;
		const hiddenDegraded = !improves(
			input.registration.metric.direction,
			observation.hiddenMetricValue,
			observation.baselineMetricValue,
		);
		const adversarialDegraded = !improves(
			input.registration.metric.direction,
			observation.adversarialMetricValue,
			observation.baselineMetricValue,
		);
		return hiddenDegraded || adversarialDegraded;
	})
		? "fail"
		: "pass";
}

/** Evaluate the host-only eight-check overfitting contract without exposing holdout bytes. */
export function reviewOverfitting(input: AutoResearchOverfittingInput): AutoResearchOverfittingReview {
	validateHostHandles(input);
	const checks: Record<AutoResearchOverfittingCheckKind, AutoResearchOverfittingCheckDisposition> = {
		metric_preregistration_lock: checkMetricLock(input),
		sample_adequacy: checkSample(input),
		train_eval_separation: checkTrainEvalSeparation(input),
		test_contamination: checkContamination(input),
		repeated_holdout_peeking: checkPeeking(input),
		proxy_exploitation: checkProxy(input),
		variance_replicate_stability: checkVariance(input),
		hidden_adversarial_generalization: checkGeneralization(input),
	};
	const checkResults = AUTO_RESEARCH_OVERFITTING_CHECKS.map((checkKind) =>
		makeCheck(checkKind, checks[checkKind], input, [
			...input.evidenceRefs,
			...input.hiddenHoldoutEvidenceRefs,
			...input.adversarialEvidenceRefs,
		]),
	);
	const accepted = checkResults.every((check) => check.disposition === "pass");
	const registrationDigest = digestObject(input.registration);
	const reviewDigest = digestObject({ registrationDigest, checkResults, accepted });
	const disposition = input.phase === "exploration" || input.phase === undefined ? "advisory" : "blocking";
	const receiptPreimage = {
		reviewDigest,
		registrationDigest,
		boundary: reviewBoundary(input),
		authenticated: true as const,
		fresh: true as const,
		revoked: false as const,
	};
	const result = deepFreeze({
		reviewId: `overfitting-review:${reviewDigest.slice(0, 16)}`,
		registrationDigest,
		checkResults,
		disposition,
		explorationAdvisory: true,
		blockingBefore: AUTO_RESEARCH_OVERFITTING_BLOCKING_BOUNDARIES,
		proposerSeesHiddenHoldoutBytes: false,
		reviewerCanAuthorize: false,
		canAuthorize: false,
		emitsEvidenceOnly: true,
		authorityCapabilities: [],
		accepted,
		reviewDigest,
		receipt: {
			...receiptPreimage,
			receiptDigest: digestObject(receiptPreimage),
		},
	} satisfies AutoResearchOverfittingReview);
	return result;
}

/** Return whether an existing review permits a named consequential lifecycle boundary. */
export function canProceedWithOverfittingReview(
	review: AutoResearchOverfittingReview,
	boundary: AutoResearchOverfittingBlockingBoundary,
	receipt: AutoResearchOverfittingReviewReceipt | undefined = undefined,
): boolean {
	if (
		receipt === undefined ||
		!receipt.authenticated ||
		!receipt.fresh ||
		receipt.revoked ||
		receipt.reviewDigest !== review.reviewDigest ||
		receipt.registrationDigest !== review.registrationDigest ||
		receipt.boundary !== boundary
	)
		return false;
	const { receiptDigest, ...receiptPreimage } = receipt;
	if (receiptDigest !== digestObject(receiptPreimage)) return false;
	const expectedReviewDigest = digestObject({
		registrationDigest: review.registrationDigest,
		checkResults: review.checkResults,
		accepted: review.accepted,
	});
	if (review.reviewDigest !== expectedReviewDigest) return false;
	return (
		review.checkResults.length === AUTO_RESEARCH_OVERFITTING_CHECKS.length &&
		review.checkResults.every(
			(check, index) => check.checkKind === AUTO_RESEARCH_OVERFITTING_CHECKS[index] && check.disposition === "pass",
		) &&
		review.disposition === "blocking" &&
		review.blockingBefore.includes(boundary) &&
		review.accepted
	);
}

export const evaluateOverfittingReview = reviewOverfitting;
