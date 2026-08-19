import type {
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowAuthorityCapability,
	WorkflowGoalContract,
	WorkflowMetricDirection,
	WorkflowRepeatabilityPolicy,
	WorkflowScorecard,
	WorkflowScorecardAcceptanceCheck,
	WorkflowScorecardInvariant,
	WorkflowScorecardMetric,
} from "./contracts.js";
import { digestObject, sha256Hex } from "./contracts.js";

export interface WorkflowScorecardValidation {
	scorecard: WorkflowScorecard;
	scorecardDigest: string;
	requiresUserApproval: true;
}

export interface WorkflowScorecardValidationContext {
	currentApprovedClosureDigest: string;
	currentApprovedClosureRef: WorkflowArtifactRef;
	approvedClosureResolver: WorkflowArtifactResolver;
}

/**
 * Return the host-owned measurement policy for a metric.
 *
 * Args:
 * metric: Metric whose repeatability policy is being classified.
 * Return: The finite policy used by the host evaluator.
 */
export function scorecardMeasurementPolicy(
	metric: WorkflowScorecardMetric,
): "determinism_attested" | "repeated" | "held_out" {
	if (metric.repeatability.kind === "single") return "determinism_attested";
	return metric.repeatability.kind;
}

/**
 * Validate an immutable scorecard against the already hardened goal contract.
 *
 * Args:
 * scorecard: Candidate scorecard to validate.
 * goal: Hardened goal contract that the scorecard is allowed to measure.
 * context: Host resolver and digest for the current approved input closure.
 * Return: The unchanged scorecard and its approved-content digest.
 */
export async function validateWorkflowScorecard(
	scorecard: WorkflowScorecard,
	goal: WorkflowGoalContract,
	context: WorkflowScorecardValidationContext,
): Promise<WorkflowScorecardValidation> {
	await assertCurrentApprovedClosure(context);
	assertGoalContract(goal);
	assertScorecardIdentity(scorecard);
	assertAcceptanceChecks(scorecard.acceptanceChecks);
	assertProtectedInvariants(scorecard.protectedInvariants);
	assertGoalRequirementsCovered(scorecard, goal);
	assertMetrics(scorecard.metrics, goal);
	assertGuardMetrics(scorecard);
	assertArtifactRefs("proxy attack", scorecard.proxyAttackArtifactRefs, true);
	return { scorecard, scorecardDigest: scorecard.scorecardDigest, requiresUserApproval: true };
}

async function assertCurrentApprovedClosure(context: WorkflowScorecardValidationContext): Promise<void> {
	const { currentApprovedClosureDigest: digest, currentApprovedClosureRef: ref } = context;
	if (digest.trim().length === 0 || !isCompleteArtifactRef(ref) || ref.digest !== digest) {
		throw new Error("Scorecard requires the current approved input closure.");
	}
	const artifact = await context.approvedClosureResolver.resolve(ref);
	if (
		!artifact.exists ||
		!artifact.envelope.immutable ||
		digestObject(artifact.envelope.ref) !== digestObject(ref) ||
		artifact.verifiedDigest !== digest ||
		artifact.verifiedSizeBytes !== ref.sizeBytes ||
		artifact.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(artifact.bytes) !== digest
	) {
		throw new Error("Scorecard approved input closure is stale or not resolver-verified.");
	}
}

function assertGoalContract(goal: WorkflowGoalContract): void {
	if (
		goal.goalId.trim().length === 0 ||
		!Number.isSafeInteger(goal.revision) ||
		goal.revision < 1 ||
		goal.originalObjective.trim().length === 0 ||
		goal.requirements.length === 0
	) {
		throw new Error("Scorecard requires a complete hardened goal contract.");
	}
	if (goal.authorityCapabilities.length === 0) {
		throw new Error("Scorecard requires an explicit goal authority capability.");
	}
	const authorityCapabilities = new Set<WorkflowAuthorityCapability>();
	for (const capability of goal.authorityCapabilities) {
		if (capability.length === 0 || authorityCapabilities.has(capability)) {
			throw new Error("Goal contract authority capabilities are incomplete or duplicated.");
		}
		authorityCapabilities.add(capability);
	}
	const { contractDigest: _contractDigest, ...withoutDigest } = goal;
	if (goal.contractDigest.length === 0 || goal.contractDigest !== digestObject(withoutDigest)) {
		throw new Error("Goal contract self-digest is invalid.");
	}
	const requirementIds = new Set<string>();
	for (const requirement of goal.requirements) {
		if (
			requirement.requirementId.trim().length === 0 ||
			requirementIds.has(requirement.requirementId) ||
			requirement.outcome.trim().length === 0 ||
			requirement.acceptanceCheckIds.length === 0 ||
			requirement.requiredEvidenceKinds.length === 0 ||
			requirement.acceptanceCheckIds.some((checkId) => checkId.trim().length === 0) ||
			requirement.requiredEvidenceKinds.some((kind) => kind.trim().length === 0)
		) {
			throw new Error("Goal contract requirements are incomplete or duplicated.");
		}
		requirementIds.add(requirement.requirementId);
	}
}

function assertScorecardIdentity(scorecard: WorkflowScorecard): void {
	if (
		scorecard.scorecardId.length === 0 ||
		!Number.isSafeInteger(scorecard.revision) ||
		scorecard.revision < 1 ||
		scorecard.resourceConstraintDigest.length === 0 ||
		scorecard.evidenceRuleDigest.length === 0 ||
		scorecard.scorecardDigest.length === 0 ||
		scorecard.scorecardDigest !== scorecardContentDigest(scorecard)
	) {
		throw new Error("Scorecard identity or self-digest is invalid.");
	}
}

function scorecardContentDigest(scorecard: WorkflowScorecard): string {
	const { scorecardDigest: _scorecardDigest, ...withoutDigest } = scorecard;
	return digestObject(withoutDigest);
}

function assertAcceptanceChecks(checks: readonly WorkflowScorecardAcceptanceCheck[]): void {
	if (checks.length === 0) throw new Error("Scorecard requires an acceptance check.");
	const ids = new Set<string>();
	for (const check of checks) {
		if (
			check.checkId.length === 0 ||
			ids.has(check.checkId) ||
			check.description.length === 0 ||
			check.evaluatorDigest.length === 0 ||
			check.requiredEvidenceKinds.length === 0 ||
			check.requiredEvidenceKinds.some((kind) => kind.length === 0) ||
			!Number.isSafeInteger(check.freshnessMilliseconds) ||
			check.freshnessMilliseconds <= 0 ||
			check.reproducibilityDigest.length === 0
		) {
			throw new Error("Scorecard acceptance checks are incomplete or duplicated.");
		}
		ids.add(check.checkId);
	}
}

function assertProtectedInvariants(invariants: readonly WorkflowScorecardInvariant[]): void {
	if (invariants.length === 0) throw new Error("Scorecard requires a protected invariant.");
	const ids = new Set<string>();
	for (const invariant of invariants) {
		if (
			invariant.invariantId.length === 0 ||
			ids.has(invariant.invariantId) ||
			invariant.description.length === 0 ||
			invariant.evaluatorDigest.length === 0
		) {
			throw new Error("Scorecard invariants are incomplete or duplicated.");
		}
		assertArtifactRefs("invariant falsification", invariant.falsificationArtifactRefs, true);
		ids.add(invariant.invariantId);
	}
}

function assertGoalRequirementsCovered(scorecard: WorkflowScorecard, goal: WorkflowGoalContract): void {
	const checksById = new Map(scorecard.acceptanceChecks.map((check) => [check.checkId, check]));
	for (const requirement of goal.requirements) {
		const coveredEvidenceKinds = new Set<string>();
		for (const checkId of requirement.acceptanceCheckIds) {
			const check = checksById.get(checkId);
			if (check === undefined) {
				throw new Error("Scorecard is missing an acceptance check required by the goal contract.");
			}
			for (const kind of check.requiredEvidenceKinds) coveredEvidenceKinds.add(kind);
		}
		if (requirement.requiredEvidenceKinds.some((kind) => !coveredEvidenceKinds.has(kind))) {
			throw new Error("Scorecard narrows evidence required by the goal contract.");
		}
	}
}

function assertMetrics(metrics: readonly WorkflowScorecardMetric[], goal: WorkflowGoalContract): void {
	const ids = new Set<string>();
	const requirementIds = new Set(goal.requirements.map((requirement) => requirement.requirementId));
	for (const metric of metrics) {
		if (
			metric.metricId.length === 0 ||
			metric.requirementId.trim().length === 0 ||
			!requirementIds.has(metric.requirementId) ||
			ids.has(metric.metricId) ||
			!isMetricDirection(metric.direction) ||
			(metric.baseline !== null && !Number.isFinite(metric.baseline)) ||
			!Number.isFinite(metric.target) ||
			metric.target < 0 ||
			!Number.isFinite(metric.tolerance) ||
			metric.tolerance < 0 ||
			metric.parserDigest.length === 0 ||
			metric.measurementCommandDigest.length === 0 ||
			metric.evaluatorDigest.length === 0
		) {
			throw new Error("Scorecard metric is incomplete, invalid, duplicated, or unrelated to the goal.");
		}
		assertRepeatabilityPolicy(metric.repeatability);
		ids.add(metric.metricId);
	}
}

function isMetricDirection(direction: WorkflowMetricDirection): boolean {
	return direction === "maximize" || direction === "minimize" || direction === "target";
}

function assertRepeatabilityPolicy(policy: WorkflowRepeatabilityPolicy): void {
	if (policy.kind === "single") {
		if (
			policy.allowedVariance !== 0 ||
			policy.deterministicInputClosureDigest.length === 0 ||
			!isCompleteArtifactRef(policy.hostDeterminismAttestationRef)
		) {
			throw new Error("Single-run scorecard metrics require a zero-variance host determinism attestation.");
		}
		return;
	}
	if (
		!Number.isSafeInteger(policy.runs) ||
		policy.runs < 2 ||
		(policy.aggregation !== "mean" && policy.aggregation !== "median") ||
		!Number.isFinite(policy.maxVariance) ||
		policy.maxVariance < 0 ||
		(policy.kind === "held_out" && policy.heldOutInputDigest.length === 0)
	) {
		throw new Error("Repeated and held-out scorecard metrics require finite repeated evidence.");
	}
}

function assertGuardMetrics(scorecard: WorkflowScorecard): void {
	const metricIds = new Set(scorecard.metrics.map((metric) => metric.metricId));
	const guardIds = new Set<string>();
	for (const metricId of scorecard.guardMetricIds) {
		if (metricId.length === 0 || guardIds.has(metricId) || !metricIds.has(metricId)) {
			throw new Error("Scorecard guard metric is not declared or is duplicated.");
		}
		guardIds.add(metricId);
	}
}

function assertArtifactRefs(label: string, refs: readonly WorkflowArtifactRef[], requireOne: boolean): void {
	if (requireOne && refs.length === 0) throw new Error(`Scorecard requires ${label} artifacts.`);
	const digests = new Set<string>();
	for (const ref of refs) {
		if (!isCompleteArtifactRef(ref) || digests.has(ref.digest)) {
			throw new Error(`Scorecard ${label} artifacts are incomplete or duplicated.`);
		}
		digests.add(ref.digest);
	}
}

function isCompleteArtifactRef(ref: WorkflowArtifactRef): boolean {
	return (
		ref.artifactId.length > 0 &&
		ref.relativePath.length > 0 &&
		ref.digest.length > 0 &&
		Number.isSafeInteger(ref.sizeBytes) &&
		ref.sizeBytes > 0 &&
		Number.isSafeInteger(ref.sourceEventSequence) &&
		ref.sourceEventSequence >= 0
	);
}
