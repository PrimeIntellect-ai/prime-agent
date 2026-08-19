import type { WorkflowApprovalDecisionContext } from "../workflow/approvals.js";
import {
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowApprovalReceipt,
	type WorkflowArtifactRef,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";
import type {
	AutoResearchPortfolioCandidate,
	AutoResearchPortfolioConfidenceInterval,
	AutoResearchPortfolioContract,
	AutoResearchPortfolioMeasurement,
	AutoResearchPortfolioMetricDirection,
	AutoResearchPortfolioSplitClosureRoots,
} from "./portfolio-contracts.js";
import {
	parseAutoResearchPortfolioCandidate,
	parseAutoResearchPortfolioContract,
	parseAutoResearchPortfolioMeasurement,
} from "./portfolio-contracts.js";

export interface AutoResearchPortfolioBoundaryEvidence {
	readonly boundaryId: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface AutoResearchPortfolioInvariantEvidence {
	readonly invariantId: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface AutoResearchPortfolioCandidateHistory {
	readonly candidates: readonly AutoResearchPortfolioCandidate[];
	readonly historyDigest: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface AutoResearchPortfolioMechanismFamilyRegistration {
	readonly familyId: string;
	readonly mechanismClass: string;
	readonly mechanismDigest: string;
	readonly changeDigest: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface AutoResearchPortfolioManifestArtifactEvidence {
	readonly split: "training" | "validation" | "holdout";
	readonly objectUri: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface AutoResearchPortfolioManifestEvidence {
	readonly manifestReceipt: WorkflowVerifiedHostReceipt;
	readonly artifactReceipts: readonly AutoResearchPortfolioManifestArtifactEvidence[];
}

export interface AutoResearchPortfolioMeasurementEvidence {
	readonly measurementId: string;
	readonly runs: readonly AutoResearchPortfolioMeasurementRunEvidence[];
}

export interface AutoResearchPortfolioMeasurementRunEvidence {
	readonly runIndex: number;
	readonly artifactRef: WorkflowArtifactRef;
	readonly seedDigest: string;
	readonly contentDigest: string;
	readonly metricValues: readonly AutoResearchPortfolioMeasurement["vector"][number][];
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface AutoResearchPortfolioTradeoffAuthorization {
	readonly candidateId: string;
	readonly competingGoalIds: readonly string[];
	readonly concessions: readonly string[];
	readonly floors: readonly AutoResearchPortfolioTradeoffFloor[];
	readonly evidenceIds: readonly string[];
	readonly selectedFrontierEntryIds: readonly string[];
	readonly userAuthority: AutoResearchPortfolioUserAuthority;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface AutoResearchPortfolioUserAuthority {
	readonly approval: WorkflowApprovalReceipt;
	readonly decisionContext: WorkflowApprovalDecisionContext;
	readonly authorityDigest: string;
}

export interface AutoResearchPortfolioTradeoffFloor {
	readonly goalId: string;
	readonly value: number;
}

export interface AutoResearchPortfolioPreflightInput {
	readonly contract: AutoResearchPortfolioContract;
	readonly candidate: AutoResearchPortfolioCandidate;
	readonly priorCandidates: readonly AutoResearchPortfolioCandidate[];
	readonly preregisteredFamilies?: readonly AutoResearchPortfolioMechanismFamilyRegistration[];
}

export interface AutoResearchPortfolioPreflightResult {
	readonly allowed: boolean;
	readonly reasons: readonly string[];
	readonly impactClosure: AutoResearchPortfolioImpactClosure;
	readonly reviewBindingDigest: string;
	readonly preflightDigest: string;
}

export interface AutoResearchPortfolioPreregistration {
	readonly candidateId: string;
	readonly metricIds: readonly string[];
	readonly evaluationEpoch: number;
	readonly observationHeadDigest: string;
	readonly registeredAt: string;
	readonly userAuthority: AutoResearchPortfolioUserAuthority;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface AutoResearchPortfolioImpactClosure {
	readonly authority: "host_derived";
	readonly derivationVersion: number;
	readonly directGoalIds: readonly string[];
	readonly transitiveGoalIds: readonly string[];
	readonly affectedPartitionIds: readonly string[];
	readonly affectedInvariantIds: readonly string[];
	readonly sourceDigest: string;
	readonly closureDigest: string;
	readonly intendedGoalIds: readonly string[];
	readonly dependentGoalIds: readonly string[];
	readonly competingGoalIds: readonly string[];
	readonly conflictRelatedGoalIds: readonly string[];
	readonly structurallyAffectedGoalIds: readonly string[];
	readonly goalIds: readonly string[];
	readonly metricIds: readonly string[];
	readonly impactClosureDigest: string;
}

export interface AutoResearchPortfolioAdmissionInput {
	readonly contract: AutoResearchPortfolioContract;
	readonly candidate: AutoResearchPortfolioCandidate;
	readonly measurements: readonly AutoResearchPortfolioMeasurement[];
	readonly frontier: readonly AutoResearchPortfolioCandidate[];
	readonly candidateHistory: AutoResearchPortfolioCandidateHistory;
	readonly preflight: AutoResearchPortfolioPreflightResult;
	readonly boundaryEvidence: readonly AutoResearchPortfolioBoundaryEvidence[];
	readonly invariantEvidence: readonly AutoResearchPortfolioInvariantEvidence[];
	readonly manifestEvidence: AutoResearchPortfolioManifestEvidence;
	readonly measurementEvidence: readonly AutoResearchPortfolioMeasurementEvidence[];
	readonly selectedFrontierEntryIds: readonly string[];
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly workflowId: string;
	readonly currentStateDigest: string;
	readonly currentRevision: number;
	readonly currentEpochRef: WorkflowEpochRef;
	readonly trustedNow: string;
	readonly executionIdentity?: string;
	readonly sessionId?: string;
	readonly preregisteredFamilies?: readonly AutoResearchPortfolioMechanismFamilyRegistration[];
	readonly tradeoffAuthorization?: AutoResearchPortfolioTradeoffAuthorization;
	readonly preregistration?: AutoResearchPortfolioPreregistration;
}

export interface AutoResearchPortfolioAdmissionIntent {
	readonly kind: "autoresearch_portfolio_frontier_admission";
	readonly productionOrphaned: true;
	readonly candidateId: string;
	readonly frontierDigest: string;
	readonly receiptCommitments: readonly {
		readonly receiptId: string;
		readonly bindingDigest: string;
		readonly authorizationDigest: string;
		readonly userAuthorityDigest: string;
	}[];
	readonly runReceiptCommitments: readonly {
		readonly measurementId: string;
		readonly runIndex: number;
		readonly receiptId: string;
		readonly bindingDigest: string;
		readonly receiptDigest: string;
	}[];
	readonly consumptionWitnesses: readonly {
		readonly receiptId: string;
		readonly bindingDigest: string;
		readonly receiptDigest: string;
		readonly consumptionSequence: number;
		readonly consumedAt: string;
	}[];
	readonly candidateReviewDigest: string;
	readonly preflightDigest: string;
	readonly currentStateDigest: string;
	readonly currentRevision: number;
	readonly currentEpochRef: WorkflowEpochRef;
	readonly measurementEvidenceDigest: string;
	readonly admissionDigest: string;
}

export interface AutoResearchPortfolioAdmissionResult {
	readonly accepted: boolean;
	readonly automaticPromotion: boolean;
	readonly frontierMembership: "none" | "retained";
	readonly executorAllowed: boolean;
	readonly exploratory: boolean;
	readonly retention: "rejected" | "frontier_promotable" | "evidence_only_exploratory" | "evidence_only_tradeoff";
	readonly admissionIntent?: AutoResearchPortfolioAdmissionIntent;
	readonly reasons: readonly string[];
	readonly impactClosure: AutoResearchPortfolioImpactClosure;
	readonly frontierDigest: string;
	readonly vector: readonly string[];
}

interface Interval {
	lower: number;
	upper: number;
}

interface MetricSpec {
	readonly metricId: string;
	readonly goalId: string;
	readonly direction: AutoResearchPortfolioMetricDirection;
	readonly aggregation: "exact" | "mean" | "median";
	readonly tier: number;
	readonly baseline: Interval;
	readonly minimumEffect: number;
	readonly nonInferiorityMargin: number;
	readonly frontierNonInferiorityMargin: number;
	readonly maxIntervalWidth: number;
	readonly maxVariance: number;
	readonly minimumRepeats: number;
}

interface MetricObservation {
	readonly value: number;
	readonly interval: Interval;
	readonly repeats: number;
	readonly variance: number;
}

interface MetricComparison {
	readonly metric: MetricSpec;
	readonly observation: MetricObservation;
	readonly strictImprovement: boolean;
	readonly regression: boolean;
	readonly intervalNotSeparated: boolean;
}

interface ReferenceVector {
	readonly intervals: ReadonlyMap<string, Interval>;
}

function sortedUnique(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function finite(value: number): boolean {
	return Number.isFinite(value);
}

function digest(value: string): boolean {
	return /^[0-9a-f]{64}$/u.test(value);
}

function interval(value: AutoResearchPortfolioConfidenceInterval | null | undefined): Interval | null {
	if (value === null || value === undefined) return null;
	return finite(value.lower) && finite(value.upper) && value.lower <= value.upper ? value : null;
}

function splitRoots(value: AutoResearchPortfolioSplitClosureRoots): boolean {
	return digest(value.training) && digest(value.validation) && digest(value.holdout);
}

function sameSplitRoots(
	left: AutoResearchPortfolioSplitClosureRoots,
	right: AutoResearchPortfolioSplitClosureRoots,
): boolean {
	return left.training === right.training && left.validation === right.validation && left.holdout === right.holdout;
}

function contractDigest(contract: AutoResearchPortfolioContract): string {
	return digestObject(contract);
}

function cloneForCanonicalParsing(value: unknown): unknown {
	return structuredClone(value);
}

function isDenseArray(value: unknown): value is readonly unknown[] {
	if (!Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length === value.length && keys.every((key, index) => key === String(index));
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key)))
		return false;
	return JSON.stringify([...keys].sort()) === JSON.stringify([...expected].sort());
}

interface CanonicalAdmissionRecords {
	readonly contract: AutoResearchPortfolioContract;
	readonly candidate: AutoResearchPortfolioCandidate;
	readonly measurements: readonly AutoResearchPortfolioMeasurement[];
	readonly frontier: readonly AutoResearchPortfolioCandidate[];
	readonly candidateHistory: AutoResearchPortfolioCandidateHistory;
}

function parseMeasurementForContract(
	contract: AutoResearchPortfolioContract,
	value: unknown,
): AutoResearchPortfolioMeasurement {
	const raw = value as { readonly goalId?: unknown };
	const goal = contract.goals.find((entry) => entry.goalId === raw.goalId);
	if (goal === undefined) throw new Error("measurement_goal_unknown");
	return parseAutoResearchPortfolioMeasurement(value, {
		confidenceLevel: goal.uncertainty.confidence,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		inputManifestDigest: contract.inputManifest.manifestDigest,
		splitClosureRoots: contract.inputManifest.splitClosureRoots,
	});
}

function parseAdmissionRecords(input: AutoResearchPortfolioAdmissionInput): CanonicalAdmissionRecords {
	let contract: AutoResearchPortfolioContract;
	try {
		contract = parseAutoResearchPortfolioContract(cloneForCanonicalParsing(input.contract));
	} catch {
		throw new Error("contract_not_canonical");
	}
	let candidate: AutoResearchPortfolioCandidate;
	try {
		candidate = parseAutoResearchPortfolioCandidate(cloneForCanonicalParsing(input.candidate));
	} catch {
		throw new Error("candidate_not_canonical");
	}
	let measurements: AutoResearchPortfolioMeasurement[];
	try {
		if (!isDenseArray(input.measurements)) throw new Error("measurement_not_canonical");
		measurements = input.measurements.map((measurement) =>
			parseMeasurementForContract(contract, cloneForCanonicalParsing(measurement)),
		);
	} catch {
		throw new Error("measurement_not_canonical");
	}
	let frontier: AutoResearchPortfolioCandidate[];
	try {
		if (!isDenseArray(input.frontier)) throw new Error("frontier_not_canonical");
		frontier = input.frontier.map((entry) => parseAutoResearchPortfolioCandidate(cloneForCanonicalParsing(entry)));
	} catch {
		throw new Error("frontier_not_canonical");
	}
	let historyCandidates: AutoResearchPortfolioCandidate[];
	try {
		if (!isDenseArray(input.candidateHistory.candidates)) throw new Error("history_not_canonical");
		historyCandidates = input.candidateHistory.candidates.map((entry) =>
			parseAutoResearchPortfolioCandidate(cloneForCanonicalParsing(entry)),
		);
	} catch {
		throw new Error("history_not_canonical");
	}
	return {
		contract,
		candidate,
		measurements,
		frontier,
		candidateHistory: { ...input.candidateHistory, candidates: historyCandidates },
	};
}

function relationContradiction(contract: AutoResearchPortfolioContract): boolean {
	const goalIds = new Set(contract.goals.map((goal) => goal.goalId));
	const relationKinds = new Map<string, Set<string>>();
	const undirectedRelationKinds = new Map<string, Set<string>>();
	for (const relation of contract.goalRelations) {
		if (
			relation.fromGoalId === relation.toGoalId ||
			!goalIds.has(relation.fromGoalId) ||
			!goalIds.has(relation.toGoalId)
		)
			return true;
		const key = `${relation.fromGoalId}\u0000${relation.toGoalId}`;
		if (relationKinds.has(key)) return true;
		const kinds = relationKinds.get(key) ?? new Set<string>();
		kinds.add(relation.relation);
		relationKinds.set(key, kinds);
		const undirectedKey = [relation.fromGoalId, relation.toGoalId]
			.sort((left, right) => left.localeCompare(right))
			.join("\u0000");
		const undirectedKinds = undirectedRelationKinds.get(undirectedKey) ?? new Set<string>();
		undirectedKinds.add(relation.relation);
		undirectedRelationKinds.set(undirectedKey, undirectedKinds);
	}
	for (const kinds of relationKinds.values()) {
		const dependency = kinds.has("prerequisite") || kinds.has("complementary");
		const tradeoff = kinds.has("competing") || kinds.has("conflict");
		if (dependency && tradeoff) return true;
	}
	for (const kinds of undirectedRelationKinds.values()) {
		const dependency = kinds.has("prerequisite") || kinds.has("complementary");
		const tradeoff = kinds.has("competing") || kinds.has("conflict");
		if (dependency && tradeoff) return true;
	}
	return false;
}

function normalizePath(value: string): string | null {
	if (typeof value !== "string") return null;
	const replaced = value.trim().replaceAll("\\", "/");
	if (replaced.length === 0 || replaced.startsWith("/") || /^[A-Za-z]:\//u.test(replaced)) return null;
	const parts: string[] = [];
	for (const part of replaced.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") return null;
		parts.push(part);
	}
	return parts.length === 0 ? null : parts.join("/");
}

function pathTouches(left: string, right: string): boolean {
	const normalizedLeft = normalizePath(left);
	const normalizedRight = normalizePath(right);
	return (
		normalizedLeft !== null &&
		normalizedRight !== null &&
		(normalizedLeft === normalizedRight ||
			normalizedLeft.startsWith(`${normalizedRight}/`) ||
			normalizedRight.startsWith(`${normalizedLeft}/`))
	);
}

function hasOverlappingPartitionPaths(contract: AutoResearchPortfolioContract): boolean {
	const paths = contract.scopePartitions.flatMap((partition) =>
		partition.paths.map((path) => ({ path, partitionId: partition.partitionId })),
	);
	if (paths.some(({ path }) => normalizePath(path) === null)) return true;
	for (let index = 0; index < paths.length; index += 1) {
		for (let otherIndex = index + 1; otherIndex < paths.length; otherIndex += 1) {
			if (pathTouches(paths[index]!.path, paths[otherIndex]!.path)) return true;
		}
	}
	return false;
}

function partitionAuthorityReason(
	contract: AutoResearchPortfolioContract,
	candidate: AutoResearchPortfolioCandidate,
): string | null {
	if (hasOverlappingPartitionPaths(contract)) return "scope_partition_overlap";
	const normalizedChangedPaths = candidate.change.changedPaths.map((path) => normalizePath(path));
	if (normalizedChangedPaths.some((path) => path === null)) return "scope_partition_path_invalid";
	if (new Set(normalizedChangedPaths).size !== normalizedChangedPaths.length) return "scope_partition_path_duplicate";
	for (const changedPath of candidate.change.changedPaths) {
		if (normalizePath(changedPath) === null) return "scope_partition_path_invalid";
		const touched = contract.scopePartitions.filter((partition) =>
			partition.paths.some((partitionPath) => pathTouches(changedPath, partitionPath)),
		);
		if (touched.length === 0) return "scope_partition_unbound";
		if (touched.length > 1) return "scope_partition_overlap";
		if (touched[0]!.mutableBy !== "candidate") return "scope_partition_authority_violation";
	}
	return null;
}

function deriveGoalSets(
	contract: AutoResearchPortfolioContract,
	candidate: AutoResearchPortfolioCandidate,
): {
	intendedGoalIds: readonly string[];
	dependentGoalIds: readonly string[];
	competingGoalIds: readonly string[];
	conflictRelatedGoalIds: readonly string[];
	structurallyAffectedGoalIds: readonly string[];
	goalIds: readonly string[];
} {
	const intended = sortedUnique(candidate.goalIds);
	const reachable = new Set(intended);
	const dependent = new Set<string>();
	const competing = new Set<string>();
	const conflictRelated = new Set<string>();
	const structural = new Set<string>();
	const queue = [...intended];
	while (queue.length > 0) {
		const currentGoalId = queue.shift()!;
		for (const relation of contract.goalRelations) {
			const otherGoalId =
				relation.fromGoalId === currentGoalId
					? relation.toGoalId
					: relation.toGoalId === currentGoalId
						? relation.fromGoalId
						: null;
			if (otherGoalId === null) continue;
			if (!reachable.has(otherGoalId)) {
				reachable.add(otherGoalId);
				queue.push(otherGoalId);
			}
			structural.add(otherGoalId);
			if (relation.relation === "prerequisite" || relation.relation === "complementary") dependent.add(otherGoalId);
			if (relation.relation === "competing") competing.add(otherGoalId);
			if (relation.relation === "conflict") conflictRelated.add(otherGoalId);
		}
	}
	const goalIds = sortedUnique([...intended, ...dependent, ...competing, ...conflictRelated, ...structural]);
	const intendedSet = new Set(intended);
	return {
		intendedGoalIds: intended,
		dependentGoalIds: sortedUnique([...dependent].filter((goalId) => !intendedSet.has(goalId))),
		competingGoalIds: sortedUnique([...competing].filter((goalId) => !intendedSet.has(goalId))),
		conflictRelatedGoalIds: sortedUnique([...conflictRelated].filter((goalId) => !intendedSet.has(goalId))),
		structurallyAffectedGoalIds: sortedUnique([...structural].filter((goalId) => !intendedSet.has(goalId))),
		goalIds,
	};
}

function deriveAutoResearchPortfolioImpactClosureCanonical(
	contract: AutoResearchPortfolioContract,
	candidate: AutoResearchPortfolioCandidate,
): AutoResearchPortfolioImpactClosure {
	const sets = deriveGoalSets(contract, candidate);
	const goalSet = new Set(sets.goalIds);
	const metricIds = sortedUnique(
		contract.goals.flatMap((goal) => (goalSet.has(goal.goalId) ? goal.metrics.map((metric) => metric.metricId) : [])),
	);
	const changedPaths = candidate.change.changedPaths
		.map((changedPath) => normalizePath(changedPath))
		.filter((changedPath): changedPath is string => changedPath !== null);
	const affectedPartitionIds = sortedUnique(
		contract.scopePartitions
			.filter(
				(partition) =>
					partition.mutableBy === "candidate" &&
					partition.paths.some((partitionPath) =>
						changedPaths.some((changedPath) => pathTouches(changedPath, partitionPath)),
					),
			)
			.map((partition) => partition.partitionId),
	);
	const affectedInvariantIds = sortedUnique(
		affectedPartitionIds.length > 0
			? contract.invariants
					.filter((invariant) => invariant.scope === "terminal")
					.map((invariant) => invariant.invariantId)
			: [],
	);
	const relationDigest = contract.goalRelations
		.map((relation) => `${relation.fromGoalId}:${relation.toGoalId}:${relation.relation}:${relation.rationale}`)
		.sort((left, right) => left.localeCompare(right));
	const sourceDigest = digestObject({
		contractId: contract.contractId,
		goalIds: sets.goalIds,
		metricIds,
		relations: relationDigest,
		candidateId: candidate.candidateId,
		changedPaths: [...changedPaths].sort((left, right) => left.localeCompare(right)),
		affectedPartitionIds,
		affectedInvariantIds,
		affectedPartitions: contract.scopePartitions
			.filter((partition) => affectedPartitionIds.includes(partition.partitionId))
			.map((partition) => ({
				partitionId: partition.partitionId,
				paths: sortedUnique(partition.paths),
				dataDigests: sortedUnique(partition.dataDigests),
				mutableBy: partition.mutableBy,
			}))
			.sort((left, right) => left.partitionId.localeCompare(right.partitionId)),
	});
	const closureDigest = digestObject({ sourceDigest, goalIds: sets.goalIds, metricIds });
	const impactClosureDigest = digestObject({
		authority: "host_derived",
		derivationVersion: 1,
		sourceDigest,
		closureDigest,
		...sets,
		metricIds,
	});
	return Object.freeze({
		authority: "host_derived",
		derivationVersion: 1,
		directGoalIds: sets.intendedGoalIds,
		transitiveGoalIds: sets.goalIds,
		affectedPartitionIds,
		affectedInvariantIds,
		sourceDigest,
		closureDigest,
		...sets,
		metricIds,
		impactClosureDigest,
	});
}

/** Derive the host-owned impact closure from exact goal relations and scope bindings. */
export function deriveAutoResearchPortfolioImpactClosure(
	contract: AutoResearchPortfolioContract,
	candidate: AutoResearchPortfolioCandidate,
): AutoResearchPortfolioImpactClosure {
	const parsedContract = parseAutoResearchPortfolioContract(cloneForCanonicalParsing(contract));
	const parsedCandidate = parseAutoResearchPortfolioCandidate(cloneForCanonicalParsing(candidate));
	return deriveAutoResearchPortfolioImpactClosureCanonical(parsedContract, parsedCandidate);
}

function emptyImpactClosure(
	contract: AutoResearchPortfolioContract,
	candidate: AutoResearchPortfolioCandidate,
): AutoResearchPortfolioImpactClosure {
	const sourceDigest = digestObject({
		contractId: contract.contractId,
		candidateId: candidate.candidateId,
		invalid: true,
	});
	const closureDigest = digestObject({ sourceDigest, invalid: true });
	const impactClosureDigest = digestObject({ authority: "host_derived", derivationVersion: 1, closureDigest });
	return Object.freeze({
		authority: "host_derived",
		derivationVersion: 1,
		directGoalIds: [],
		transitiveGoalIds: [],
		affectedPartitionIds: [],
		affectedInvariantIds: [],
		sourceDigest,
		closureDigest,
		intendedGoalIds: [],
		dependentGoalIds: [],
		competingGoalIds: [],
		conflictRelatedGoalIds: [],
		structurallyAffectedGoalIds: [],
		goalIds: [],
		metricIds: [],
		impactClosureDigest,
	});
}

function candidateReviewBindingDigest(candidate: AutoResearchPortfolioCandidate): string {
	return digestObject({
		candidateId: candidate.candidateId,
		goalIds: sortedUnique(candidate.goalIds),
		solutionFamily: candidate.solutionFamily,
		ancestry: candidate.ancestry,
		causalMechanism: candidate.causalMechanism,
		change: {
			kind: candidate.change.kind,
			changedPaths: sortedUnique(candidate.change.changedPaths.map((path) => normalizePath(path) ?? path)),
			parameterChanges: [...candidate.change.parameterChanges].sort((left, right) => left.localeCompare(right)),
			changeDigest: candidate.change.changeDigest,
		},
		scope: candidate.scope,
	});
}

function safeCandidateReviewBindingDigest(candidate: AutoResearchPortfolioCandidate): string {
	try {
		return candidateReviewBindingDigest(candidate);
	} catch {
		return digestObject({
			invalidCandidate: true,
			candidateId: typeof candidate?.candidateId === "string" ? candidate.candidateId : "",
		});
	}
}

function mechanismFamilyRegistrationDigest(registration: AutoResearchPortfolioMechanismFamilyRegistration): string {
	return digestObject({
		familyId: registration.familyId,
		mechanismClass: registration.mechanismClass,
		mechanismDigest: registration.mechanismDigest,
		changeDigest: registration.changeDigest,
		receiptId: registration.receipt.receiptId,
		receiptBindingDigest: registration.receipt.bindingDigest,
		patchArtifactRef: registration.receipt.artifactRef,
	});
}

function resolvedMechanismFamilyDigest(candidate: AutoResearchPortfolioCandidate): string {
	return digestObject({
		familyName: candidate.solutionFamily.name,
		mechanismClass: candidate.solutionFamily.mechanismClass,
		changeKind: candidate.change.kind,
		changedPaths: sortedUnique(
			candidate.change.changedPaths
				.map((path) => normalizePath(path))
				.filter((path): path is string => path !== null),
		),
		parameterChanges: [...candidate.change.parameterChanges].sort((left, right) => left.localeCompare(right)),
		hypothesis: candidate.causalMechanism.hypothesis,
		intervention: candidate.causalMechanism.intervention,
		expectedObservation: candidate.causalMechanism.expectedObservation,
		falsificationCondition: candidate.causalMechanism.falsificationCondition,
	});
}

function preregisteredFamilyDigest(
	registrations: readonly AutoResearchPortfolioMechanismFamilyRegistration[] | undefined,
): string {
	try {
		return digestObject(
			(registrations ?? [])
				.map((registration) => mechanismFamilyRegistrationDigest(registration))
				.sort((left, right) => left.localeCompare(right)),
		);
	} catch {
		return digestObject({ invalid: true });
	}
}

function candidateHistoryDigest(candidates: readonly AutoResearchPortfolioCandidate[]): string {
	return digestObject(
		candidates
			.map((candidate) => ({
				candidateId: candidate.candidateId,
				reviewBindingDigest: candidateReviewBindingDigest(candidate),
			}))
			.sort(
				(left, right) =>
					left.candidateId.localeCompare(right.candidateId) ||
					left.reviewBindingDigest.localeCompare(right.reviewBindingDigest),
			),
	);
}

function preflightReasons(
	contract: AutoResearchPortfolioContract,
	candidate: AutoResearchPortfolioCandidate,
	priorCandidates: readonly AutoResearchPortfolioCandidate[],
	preregisteredFamilies: readonly AutoResearchPortfolioMechanismFamilyRegistration[],
): readonly string[] {
	const reasons: string[] = [];
	const malformedFamilies =
		!isDenseArray(preregisteredFamilies) ||
		preregisteredFamilies.some(
			(registration) =>
				typeof registration !== "object" ||
				registration === null ||
				typeof registration.familyId !== "string" ||
				typeof registration.mechanismClass !== "string" ||
				!digest(registration.mechanismDigest) ||
				!digest(registration.changeDigest) ||
				!isWorkflowVerifiedHostReceipt(registration.receipt),
		);
	const duplicateFamilyIds =
		!malformedFamilies &&
		new Set(preregisteredFamilies.map((registration) => registration.familyId)).size !== preregisteredFamilies.length;
	if (malformedFamilies || duplicateFamilyIds) reasons.push("mechanism_family_registration_invalid");
	const goalIds = new Set(contract.goals.map((goal) => goal.goalId));
	if (candidate.scope !== "terminal") reasons.push("scope_violation");
	if (candidate.goalIds.length === 0 || candidate.goalIds.some((goalId) => !goalIds.has(goalId)))
		reasons.push("candidate_goal_invalid");
	if (candidate.change.kind !== "mechanism") reasons.push("parameter_sweep");
	if (candidate.change.parameterChanges.length > 0 || candidate.change.changedPaths.length === 0)
		reasons.push("parameter_sweep");
	const partitionReason = partitionAuthorityReason(contract, candidate);
	if (partitionReason !== null) reasons.push(partitionReason);
	if (candidate.solutionFamily.familyId.length === 0) reasons.push("repeated_family");
	if (new Set(priorCandidates.map((entry) => entry.candidateId)).size !== priorCandidates.length)
		reasons.push("candidate_history_invalid");
	if (new Set(priorCandidates.map((entry) => entry.solutionFamily.familyId)).size !== priorCandidates.length)
		reasons.push("repeated_family");
	if (
		new Set(
			priorCandidates.map((entry) => `${entry.solutionFamily.name}\u0000${entry.solutionFamily.mechanismClass}`),
		).size !== priorCandidates.length
	)
		reasons.push("repeated_family");
	if (new Set(priorCandidates.map((entry) => resolvedMechanismFamilyDigest(entry))).size !== priorCandidates.length)
		reasons.push("mechanism_alias");
	if (priorCandidates.some((entry) => entry.candidateId === candidate.candidateId))
		reasons.push("candidate_history_duplicate");
	if (priorCandidates.some((entry) => entry.solutionFamily.familyId === candidate.solutionFamily.familyId))
		reasons.push("repeated_family");
	if (
		priorCandidates.some(
			(entry) =>
				entry.solutionFamily.name === candidate.solutionFamily.name &&
				entry.solutionFamily.mechanismClass === candidate.solutionFamily.mechanismClass,
		)
	)
		reasons.push("repeated_family");
	if (
		priorCandidates.some((entry) => resolvedMechanismFamilyDigest(entry) === resolvedMechanismFamilyDigest(candidate))
	)
		reasons.push("mechanism_alias");
	if (
		!malformedFamilies &&
		preregisteredFamilies.some((registration) => registration.familyId === candidate.solutionFamily.familyId)
	)
		reasons.push("preregistered_mechanism_family_reuse");
	if (
		!malformedFamilies &&
		preregisteredFamilies.some(
			(registration) =>
				registration.mechanismDigest === candidate.causalMechanism.mechanismDigest &&
				registration.changeDigest === candidate.change.changeDigest,
		)
	)
		reasons.push("mechanism_alias");
	return Object.freeze([...new Set(reasons)]);
}

/** Preflight a candidate against the complete host-owned candidate history before measurements execute. */
function buildPreflightResult(
	contract: AutoResearchPortfolioContract,
	candidate: AutoResearchPortfolioCandidate,
	priorCandidates: readonly AutoResearchPortfolioCandidate[],
	preregisteredFamilies: readonly AutoResearchPortfolioMechanismFamilyRegistration[],
	reasons: readonly string[],
	impactClosure: AutoResearchPortfolioImpactClosure,
): AutoResearchPortfolioPreflightResult {
	const reviewBindingDigest = safeCandidateReviewBindingDigest(candidate);
	const preflightDigest = digestObject({
		version: 1,
		contractDigest: contractDigest(contract),
		candidateId: candidate.candidateId,
		historyDigest: candidateHistoryDigest(priorCandidates),
		reviewBindingDigest,
		impactClosureDigest: impactClosure.impactClosureDigest,
		preregisteredFamilyDigest: preregisteredFamilyDigest(preregisteredFamilies),
		allowed: reasons.length === 0,
		reasons,
	});
	return Object.freeze({
		allowed: reasons.length === 0,
		reasons: Object.freeze([...reasons]),
		impactClosure,
		reviewBindingDigest,
		preflightDigest,
	});
}

export function preflightAutoResearchPortfolioCandidate(
	input: AutoResearchPortfolioPreflightInput,
): AutoResearchPortfolioPreflightResult {
	let contract: AutoResearchPortfolioContract;
	try {
		contract = parseAutoResearchPortfolioContract(cloneForCanonicalParsing(input.contract));
	} catch {
		return buildPreflightResult(
			input.contract,
			input.candidate,
			[],
			input.preregisteredFamilies ?? [],
			["contract_not_canonical"],
			emptyImpactClosure(input.contract, input.candidate),
		);
	}
	let candidate: AutoResearchPortfolioCandidate;
	try {
		candidate = parseAutoResearchPortfolioCandidate(cloneForCanonicalParsing(input.candidate));
	} catch {
		return buildPreflightResult(
			contract,
			input.candidate,
			[],
			input.preregisteredFamilies ?? [],
			["candidate_not_canonical"],
			emptyImpactClosure(contract, input.candidate),
		);
	}
	const priorCandidates: AutoResearchPortfolioCandidate[] = [];
	for (const priorCandidate of input.priorCandidates) {
		try {
			priorCandidates.push(parseAutoResearchPortfolioCandidate(cloneForCanonicalParsing(priorCandidate)));
		} catch {
			return buildPreflightResult(
				contract,
				candidate,
				priorCandidates,
				input.preregisteredFamilies ?? [],
				["history_not_canonical"],
				deriveAutoResearchPortfolioImpactClosure(contract, candidate),
			);
		}
	}
	const impactClosure = deriveAutoResearchPortfolioImpactClosure(contract, candidate);
	return buildPreflightResult(
		contract,
		candidate,
		priorCandidates,
		input.preregisteredFamilies ?? [],
		preflightReasons(contract, candidate, priorCandidates, input.preregisteredFamilies ?? []),
		impactClosure,
	);
}

function evidenceBindingDigest(
	kind: string,
	contract: AutoResearchPortfolioContract,
	payload: Record<string, unknown>,
): string {
	return digestObject({ kind, contractDigest: contractDigest(contract), payload });
}

function isWorkflowVerifiedHostReceipt(value: unknown): value is WorkflowVerifiedHostReceipt {
	if (typeof value !== "object" || value === null) return false;
	const receipt = value as Partial<WorkflowVerifiedHostReceipt>;
	return (
		typeof receipt.receiptKind === "string" &&
		typeof receipt.oneUse === "boolean" &&
		typeof receipt.receiptId === "string" &&
		typeof receipt.issuerId === "string" &&
		typeof receipt.bindingDigest === "string" &&
		typeof receipt.payloadDigest === "string"
	);
}

function isStringArray(value: unknown): value is readonly string[] {
	return isDenseArray(value) && value.every((entry) => typeof entry === "string");
}

function isCanonicalStringArray(value: readonly string[]): boolean {
	return JSON.stringify(value) === JSON.stringify([...value].sort((left, right) => left.localeCompare(right)));
}

function isCurrentWorkflowDecisionRef(
	value: unknown,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	currentRevision: number,
): value is WorkflowDecisionRef {
	if (
		typeof value !== "object" ||
		value === null ||
		!hasExactKeys(value, [
			"decisionScope",
			"decisionId",
			"revision",
			"storeEpoch",
			"decisionDigest",
			"coordinatorEpoch",
		])
	)
		return false;
	const reference = value as WorkflowDecisionRef;
	return (
		typeof reference.decisionScope === "object" &&
		reference.decisionScope !== null &&
		hasExactKeys(reference.decisionScope, ["kind", "workflowId", "rootSessionId"]) &&
		reference.decisionScope.kind === "workflow" &&
		reference.decisionScope.workflowId === workflowId &&
		typeof reference.decisionScope.rootSessionId === "string" &&
		reference.decisionScope.rootSessionId.length > 0 &&
		typeof reference.decisionId === "string" &&
		reference.decisionId.length > 0 &&
		reference.revision === currentRevision &&
		reference.storeEpoch === epochRef.storeEpoch &&
		reference.coordinatorEpoch === epochRef.coordinatorEpoch &&
		digest(reference.decisionDigest)
	);
}

function approvalDecisionContextBindingDigest(
	input: AutoResearchPortfolioAdmissionInput,
	purpose: "tradeoff" | "preregistration",
	bindingDigest: string,
	approval: WorkflowApprovalReceipt,
	decisionContext: WorkflowApprovalDecisionContext,
): string {
	return digestObject({
		kind: "portfolio.user-authority.decision-context.v1",
		purpose,
		bindingDigest,
		workflowId: input.workflowId,
		stateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		currentEpochRef: input.currentEpochRef,
		approvalRequestId: approval.approvalRequestId,
		decisionRef: decisionContext.decisionRef,
		decisionRefs: decisionContext.decisionRefs,
		decisionRoles: decisionContext.decisionRoles,
	});
}

function approvalDecisionContextPayloadDigest(
	approval: WorkflowApprovalReceipt,
	decisionContext: WorkflowApprovalDecisionContext,
): string {
	return digestObject({
		kind: "portfolio.user-authority.decision-context-payload.v1",
		approvalDigest: digestObject(approval),
		decisionRef: decisionContext.decisionRef,
		decisionRefs: decisionContext.decisionRefs,
		decisionRoles: decisionContext.decisionRoles,
	});
}

function isBoundaryEvidence(value: unknown): value is AutoResearchPortfolioBoundaryEvidence {
	if (!hasExactKeys(value, ["boundaryId", "receipt"])) return false;
	const evidence = value as Partial<AutoResearchPortfolioBoundaryEvidence>;
	return typeof evidence.boundaryId === "string" && isWorkflowVerifiedHostReceipt(evidence.receipt);
}

function isInvariantEvidence(value: unknown): value is AutoResearchPortfolioInvariantEvidence {
	if (!hasExactKeys(value, ["invariantId", "receipt"])) return false;
	const evidence = value as Partial<AutoResearchPortfolioInvariantEvidence>;
	return typeof evidence.invariantId === "string" && isWorkflowVerifiedHostReceipt(evidence.receipt);
}

function boundaryBindingDigest(contract: AutoResearchPortfolioContract, boundaryId: string, passed: boolean): string {
	return evidenceBindingDigest("portfolio.boundary.v1", contract, { boundaryId, passed });
}

function invariantBindingDigest(contract: AutoResearchPortfolioContract, invariantId: string, passed: boolean): string {
	const invariant = contract.invariants.find((entry) => entry.invariantId === invariantId);
	return evidenceBindingDigest("portfolio.invariant.v1", contract, {
		invariantId,
		checkDigest: invariant?.checkDigest ?? "",
		passed,
	});
}

function historyBindingDigest(contract: AutoResearchPortfolioContract, historyDigest: string): string {
	return evidenceBindingDigest("portfolio.candidate-history.v1", contract, {
		historyDigest,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		manifestRevision: contract.inputManifest.manifestRevision,
		closureRootDigest: contract.inputManifest.closureRootDigest,
	});
}

function frontierResourceDigest(contract: AutoResearchPortfolioContract): string {
	return contractDigest(contract);
}

async function verifyHostEvidenceReceipt(
	input: AutoResearchPortfolioAdmissionInput,
	receipt: WorkflowVerifiedHostReceipt,
	expectedBindingDigest: string,
	receiptKind: WorkflowVerifiedHostReceipt["receiptKind"],
): Promise<WorkflowHostPrincipalCapabilityAuthorization | null> {
	if (!isWorkflowVerifiedHostReceipt(receipt)) return null;
	if (receipt.receiptKind !== receiptKind) return null;
	try {
		const verifiedReceipt = await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest,
			receipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: input.trustedNow,
		});
		return await verifyPrincipalCapability(
			input,
			verifiedReceipt,
			expectedBindingDigest,
			frontierResourceDigest(input.contract),
			expectedBindingDigest,
		);
	} catch {
		return null;
	}
}

function manifestBindingDigest(contract: AutoResearchPortfolioContract): string {
	return evidenceBindingDigest("portfolio.input-manifest.v1", contract, {
		manifestDigest: contract.inputManifest.manifestDigest,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		manifestRevision: contract.inputManifest.manifestRevision,
		closureRootDigest: contract.inputManifest.closureRootDigest,
		splitClosureRoots: contract.inputManifest.splitClosureRoots,
		splitBoundaryPolicyDigest: contract.inputManifest.splitBoundaryPolicy.policyDigest,
	});
}

function manifestArtifactBindingDigest(
	contract: AutoResearchPortfolioContract,
	split: AutoResearchPortfolioManifestArtifactEvidence["split"],
	objectUri: string,
): string {
	const artifact = contract.inputManifest[split].artifacts.find((entry) => entry.objectUri === objectUri);
	return evidenceBindingDigest("portfolio.input-artifact.v1", contract, {
		split,
		objectUri,
		generation: artifact?.generation ?? 0,
		bytes: artifact?.bytes ?? 0,
		schemaVersion: artifact?.schemaVersion ?? "",
		sha256: artifact?.sha256 ?? "",
		closureRootDigest: artifact?.closureRootDigest ?? "",
		modality: artifact?.modality ?? "",
		instrumentSet: artifact?.instrumentSet ?? [],
		validationResult: artifact?.validationResult ?? "unknown",
		coverage: artifact?.coverage ?? "unknown",
		gapClassification: artifact?.gapClassification ?? "unknown",
		lifecycle: artifact?.lifecycle ?? "unknown",
		sourceTimeStart: artifact?.sourceTimeStart ?? "",
		sourceTimeEnd: artifact?.sourceTimeEnd ?? "",
		provenance: artifact?.provenance ?? null,
		restoreVerification: artifact?.restoreVerification ?? null,
		accessAuthority: artifact?.accessAuthority ?? "",
	});
}

function manifestArtifactPayloadDigest(
	contract: AutoResearchPortfolioContract,
	split: AutoResearchPortfolioManifestArtifactEvidence["split"],
	objectUri: string,
): string {
	const artifact = contract.inputManifest[split].artifacts.find((entry) => entry.objectUri === objectUri);
	return digestObject({
		kind: "portfolio.input-artifact-evidence.v1",
		bindingDigest: manifestArtifactBindingDigest(contract, split, objectUri),
		artifact,
	});
}

function measurementBindingDigest(
	contract: AutoResearchPortfolioContract,
	measurement: AutoResearchPortfolioMeasurement,
	run: AutoResearchPortfolioMeasurementRunEvidence,
): string {
	return evidenceBindingDigest("portfolio.measurement.v1", contract, {
		measurementId: measurement.measurementId,
		measurementDigest: measurement.measurementDigest,
		candidateId: measurement.candidateId,
		repeatIndex: measurement.repeatIndex,
		runIndex: run.runIndex,
		artifactRef: run.artifactRef,
		seedDigest: run.seedDigest,
		contentDigest: run.contentDigest,
		metricValues: [...run.metricValues].sort((left, right) => left.metricId.localeCompare(right.metricId)),
		evaluationEpoch: measurement.evaluationEpoch,
		inputManifestDigest: measurement.inputManifestDigest,
		splitClosureRoots: measurement.splitClosureRoots,
	});
}

function isArtifactRef(value: unknown): value is WorkflowArtifactRef {
	if (
		typeof value !== "object" ||
		value === null ||
		!hasExactKeys(value, ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"])
	)
		return false;
	const ref = value as WorkflowArtifactRef;
	return (
		typeof ref.artifactId === "string" &&
		typeof ref.relativePath === "string" &&
		digest(ref.digest) &&
		Number.isSafeInteger(ref.sizeBytes) &&
		ref.sizeBytes >= 0 &&
		Number.isSafeInteger(ref.sourceEventSequence) &&
		ref.sourceEventSequence >= 0
	);
}

async function verifyImmutableArtifact(
	input: AutoResearchPortfolioAdmissionInput,
	ref: WorkflowArtifactRef,
): Promise<boolean> {
	try {
		const artifact = await input.receiptContext.artifactResolver.resolve(ref);
		return (
			artifact.exists === true &&
			artifact.envelope.immutable === true &&
			artifact.envelope.ref.artifactId === ref.artifactId &&
			artifact.envelope.ref.relativePath === ref.relativePath &&
			artifact.verifiedDigest === ref.digest &&
			artifact.verifiedSizeBytes === ref.sizeBytes &&
			artifact.bytes.byteLength === ref.sizeBytes &&
			sha256Hex(artifact.bytes) === ref.digest
		);
	} catch {
		return false;
	}
}

function capabilityBindingValues(
	receipt: WorkflowVerifiedHostReceipt,
	capability: "autoresearch_portfolio_frontier_admission",
	resourceDigest: string,
	operationDigest: string,
	executionIdentity: string | undefined,
	sessionId: string | undefined,
): boolean {
	const binding = receipt.capabilityBinding;
	return (
		binding !== undefined &&
		binding.capability === capability &&
		binding.resourceDigest === resourceDigest &&
		binding.operationDigest === operationDigest &&
		binding.executionIdentity === (executionIdentity ?? null) &&
		binding.sessionId === (sessionId ?? null)
	);
}

function assertPrincipalAuthorization(
	decision: WorkflowHostPrincipalCapabilityAuthorization,
	input: WorkflowHostPrincipalCapabilityAuthorizationInput,
): boolean {
	return (
		decision.authenticatedPrincipal.length > 0 &&
		decision.keyOwnerPrincipal.length > 0 &&
		decision.capability === input.capability &&
		decision.workflowId === input.workflowId &&
		decision.bindingDigest === input.bindingDigest &&
		decision.stateDigest === input.stateDigest &&
		decision.revision === input.revision &&
		decision.epochRef.storeEpoch === input.epochRef.storeEpoch &&
		decision.epochRef.coordinatorEpoch === input.epochRef.coordinatorEpoch &&
		decision.executionIdentity === input.executionIdentity &&
		decision.sessionId === input.sessionId &&
		decision.validity.issuedAt === input.receipt.issuedAt &&
		decision.validity.validUntil === input.receipt.validUntil &&
		/^[0-9a-f]{64}$/u.test(decision.authorizationDigest) &&
		digestObject(decision.receipt) === digestObject(input.receipt)
	);
}

async function validUserAuthority(
	input: AutoResearchPortfolioAdmissionInput,
	authority: AutoResearchPortfolioUserAuthority | undefined,
	purpose: "tradeoff" | "preregistration",
	bindingDigest: string,
): Promise<boolean> {
	if (
		authority === undefined ||
		typeof authority !== "object" ||
		!hasExactKeys(authority, ["approval", "decisionContext", "authorityDigest"]) ||
		typeof authority.authorityDigest !== "string" ||
		!digest(authority.authorityDigest)
	)
		return false;
	const approval = authority.approval;
	if (
		typeof approval !== "object" ||
		approval === null ||
		!hasExactKeys(approval, [
			"approvalRequestId",
			"workflowId",
			"decisionRef",
			"decisionRefs",
			"headDigest",
			"stateDigest",
			"configDigest",
			"profileDigest",
			"artifactDigest",
			"storeEpoch",
			"coordinatorEpoch",
			"clientSessionId",
			"trustedPrincipal",
			"responseSequence",
			"optionId",
			"decisionRoles",
			"effectDigest",
			"mode",
			"responseDigest",
			"consumedAt",
			"consumptionEventSequence",
			"trustedClockReceipt",
		])
	)
		return false;
	if (
		approval.workflowId !== input.workflowId ||
		approval.headDigest !== input.currentStateDigest ||
		approval.stateDigest !== input.currentStateDigest ||
		approval.storeEpoch !== input.currentEpochRef.storeEpoch ||
		approval.coordinatorEpoch !== input.currentEpochRef.coordinatorEpoch ||
		!Number.isSafeInteger(approval.responseSequence) ||
		approval.responseSequence < 1 ||
		!Number.isSafeInteger(approval.consumptionEventSequence) ||
		approval.consumptionEventSequence < 1 ||
		typeof approval.optionId !== "string" ||
		approval.optionId.length === 0 ||
		!digest(approval.effectDigest) ||
		!digest(approval.configDigest) ||
		!digest(approval.profileDigest) ||
		!digest(approval.artifactDigest) ||
		!digest(approval.responseDigest) ||
		typeof approval.trustedPrincipal !== "object" ||
		approval.trustedPrincipal === null ||
		(approval.trustedPrincipal.kind !== "interactive_ui" &&
			approval.trustedPrincipal.kind !== "workflow_command" &&
			approval.trustedPrincipal.kind !== "headless_signer") ||
		typeof approval.trustedPrincipal.principalId !== "string" ||
		approval.trustedPrincipal.principalId.length === 0 ||
		!digest(approval.trustedPrincipal.credentialDigest) ||
		(approval.mode !== "interactive_secret" && approval.mode !== "signed_headless")
	)
		return false;
	const consumedAt = Date.parse(approval.consumedAt);
	const trustedNow = Date.parse(input.trustedNow);
	if (!Number.isFinite(consumedAt) || !Number.isFinite(trustedNow) || consumedAt > trustedNow) return false;
	const decisionContext = authority.decisionContext;
	if (
		typeof decisionContext !== "object" ||
		decisionContext === null ||
		!hasExactKeys(decisionContext, ["decisionRef", "decisionRefs", "decisionRoles", "hostReceipt"]) ||
		!isDenseArray(decisionContext.decisionRefs) ||
		!isWorkflowVerifiedHostReceipt(decisionContext.hostReceipt) ||
		decisionContext.hostReceipt.receiptKind !== "decision" ||
		!isCurrentWorkflowDecisionRef(
			decisionContext.decisionRef,
			input.workflowId,
			input.currentEpochRef,
			input.currentRevision,
		) ||
		decisionContext.decisionRefs.length === 0 ||
		decisionContext.decisionRefs.some(
			(reference) =>
				!isCurrentWorkflowDecisionRef(reference, input.workflowId, input.currentEpochRef, input.currentRevision),
		) ||
		typeof decisionContext.decisionRoles !== "object" ||
		decisionContext.decisionRoles === null ||
		!hasExactKeys(decisionContext.decisionRoles, ["goal", "scorecard", "resource"]) ||
		!isCurrentWorkflowDecisionRef(
			decisionContext.decisionRoles.goal,
			input.workflowId,
			input.currentEpochRef,
			input.currentRevision,
		) ||
		!isCurrentWorkflowDecisionRef(
			decisionContext.decisionRoles.scorecard,
			input.workflowId,
			input.currentEpochRef,
			input.currentRevision,
		) ||
		!isCurrentWorkflowDecisionRef(
			decisionContext.decisionRoles.resource,
			input.workflowId,
			input.currentEpochRef,
			input.currentRevision,
		) ||
		digestObject(decisionContext.decisionRef) !== digestObject(approval.decisionRef) ||
		digestObject(decisionContext.decisionRefs) !== digestObject(approval.decisionRefs) ||
		digestObject(decisionContext.decisionRoles) !== digestObject(approval.decisionRoles)
	)
		return false;
	const trustedClockReceipt = approval.trustedClockReceipt;
	if (!isWorkflowVerifiedHostReceipt(trustedClockReceipt) || trustedClockReceipt.receiptKind !== "clock") return false;
	try {
		const verifiedClockReceipt = await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest: trustedClockReceipt.bindingDigest,
			receipt: trustedClockReceipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: input.trustedNow,
		});
		if (
			verifiedClockReceipt.receiptKind !== "clock" ||
			Date.parse(verifiedClockReceipt.issuedAt) > consumedAt ||
			verifiedClockReceipt.stateDigest !== input.currentStateDigest ||
			verifiedClockReceipt.revision !== input.currentRevision
		)
			return false;
		const decisionBindingDigest = approvalDecisionContextBindingDigest(
			input,
			purpose,
			bindingDigest,
			approval,
			decisionContext,
		);
		if (
			decisionContext.hostReceipt.bindingDigest !== decisionBindingDigest ||
			decisionContext.hostReceipt.payloadDigest !== approvalDecisionContextPayloadDigest(approval, decisionContext)
		)
			return false;
		const verifiedDecisionReceipt = await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest: decisionBindingDigest,
			receipt: decisionContext.hostReceipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: input.trustedNow,
		});
		if (
			verifiedDecisionReceipt.receiptKind !== "decision" ||
			Date.parse(verifiedDecisionReceipt.issuedAt) > consumedAt ||
			verifiedDecisionReceipt.stateDigest !== input.currentStateDigest ||
			verifiedDecisionReceipt.revision !== input.currentRevision
		)
			return false;
		const expectedAuthorityDigest = digestObject({
			kind: "portfolio.user-authority.v1",
			purpose,
			bindingDigest,
			approvalDigest: digestObject(approval),
			principal: approval.trustedPrincipal,
			optionId: approval.optionId,
			workflowId: input.workflowId,
			stateDigest: input.currentStateDigest,
			currentEpochRef: input.currentEpochRef,
			decisionContextDigest: digestObject(decisionContext),
		});
		return authority.authorityDigest === expectedAuthorityDigest;
	} catch (error) {
		console.log("frontier-debug-authority", error instanceof Error ? error.message : error);
		return false;
	}
}

async function verifyPrincipalCapability(
	input: AutoResearchPortfolioAdmissionInput,
	receipt: WorkflowVerifiedHostReceipt,
	bindingDigest: string,
	resourceDigest: string,
	operationDigest: string,
): Promise<WorkflowHostPrincipalCapabilityAuthorization | null> {
	if (
		!capabilityBindingValues(
			receipt,
			"autoresearch_portfolio_frontier_admission",
			resourceDigest,
			operationDigest,
			input.executionIdentity,
			input.sessionId,
		)
	)
		return null;
	const authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput = {
		receipt,
		workflowId: input.workflowId,
		bindingDigest,
		resourceDigest,
		operationDigest,
		stateDigest: input.currentStateDigest,
		revision: input.currentRevision,
		epochRef: input.currentEpochRef,
		capability: "autoresearch_portfolio_frontier_admission",
		...(input.executionIdentity === undefined ? {} : { executionIdentity: input.executionIdentity }),
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
	};
	try {
		const decision = await input.receiptContext.principalAuthorizer.authorize(authorizationInput);
		return assertPrincipalAuthorization(decision, authorizationInput) ? decision : null;
	} catch {
		return null;
	}
}

async function boundaryReason(input: AutoResearchPortfolioAdmissionInput): Promise<string | null> {
	const contract = input.contract;
	const evidence = input.boundaryEvidence;
	if (!Array.isArray(evidence)) return "boundary_evidence_invalid";
	const results = new Map<string, AutoResearchPortfolioBoundaryEvidence>();
	for (const entry of evidence) {
		if (!isBoundaryEvidence(entry)) return "boundary_evidence_invalid";
		if (results.has(entry.boundaryId)) return "boundary_evidence_duplicate";
		results.set(entry.boundaryId, entry);
	}
	for (const boundary of contract.hardBoundaries) {
		if (boundary.locked !== true || boundary.scope !== "terminal") return "hard_boundary_invalid";
		const result = results.get(boundary.boundaryId);
		if (result === undefined) return `hard_boundary_missing:${boundary.boundaryId}`;
		if (
			!(await verifyHostEvidenceReceipt(
				input,
				result.receipt,
				boundaryBindingDigest(contract, boundary.boundaryId, true),
				"capability",
			))
		)
			return `hard_boundary_failed:${boundary.boundaryId}`;
	}
	if (results.size !== contract.hardBoundaries.length) return "boundary_evidence_extra";
	return null;
}

async function invariantReason(input: AutoResearchPortfolioAdmissionInput): Promise<string | null> {
	if (input.contract.invariants.some((entry) => entry.scope === "terminal" && entry.locked !== true))
		return "invariant_evidence_invalid";
	const required = input.contract.invariants.filter((entry) => entry.scope === "terminal");
	if (!Array.isArray(input.invariantEvidence)) return "invariant_evidence_invalid";
	const evidence = new Map<string, AutoResearchPortfolioInvariantEvidence>();
	for (const entry of input.invariantEvidence) {
		if (!isInvariantEvidence(entry)) return "invariant_evidence_invalid";
		if (evidence.has(entry.invariantId)) return "invariant_evidence_duplicate";
		evidence.set(entry.invariantId, entry);
	}
	for (const invariant of required) {
		const entry = evidence.get(invariant.invariantId);
		if (entry === undefined) return `invariant_evidence_missing:${invariant.invariantId}`;
		if (
			!(await verifyHostEvidenceReceipt(
				input,
				entry.receipt,
				invariantBindingDigest(input.contract, invariant.invariantId, true),
				"capability",
			))
		)
			return `invariant_evidence_failed:${invariant.invariantId}`;
	}
	if (evidence.size !== required.length) return "invariant_evidence_extra";
	return null;
}

async function historyReason(input: AutoResearchPortfolioAdmissionInput): Promise<string | null> {
	const history = input.candidateHistory;
	if (
		typeof history !== "object" ||
		history === null ||
		!hasExactKeys(history, ["candidates", "historyDigest", "receipt"]) ||
		!Array.isArray(history.candidates) ||
		!isWorkflowVerifiedHostReceipt(history.receipt)
	)
		return "history_not_host_bound";
	const expectedHistoryDigest = candidateHistoryDigest(history.candidates);
	if (history.historyDigest !== expectedHistoryDigest) return "history_digest_mismatch";
	if (history.receipt.bindingDigest !== historyBindingDigest(input.contract, expectedHistoryDigest))
		return "history_not_host_bound";
	if (history.receipt.payloadDigest !== expectedHistoryDigest) return "history_not_host_bound";
	if (
		!(await verifyHostEvidenceReceipt(
			input,
			history.receipt,
			historyBindingDigest(input.contract, expectedHistoryDigest),
			"capability",
		))
	)
		return "history_not_host_bound";
	const historyById = new Map(history.candidates.map((entry) => [entry.candidateId, entry]));
	if (historyById.size !== history.candidates.length) return "history_duplicate";
	for (const frontierEntry of input.frontier) {
		const historyEntry = historyById.get(frontierEntry.candidateId);
		if (
			historyEntry === undefined ||
			candidateReviewBindingDigest(historyEntry) !== candidateReviewBindingDigest(frontierEntry)
		)
			return "history_incomplete";
	}
	return null;
}

function manifestReason(contract: AutoResearchPortfolioContract): string | null {
	const manifest = contract.inputManifest;
	if (manifest.locked !== true) return "closure_root_binding_mismatch";
	if (!digest(manifest.closureRootDigest) || !digest(manifest.manifestDigest)) return "closure_root_binding_mismatch";
	const roots = manifest.splitClosureRoots;
	if (!splitRoots(roots) || new Set([roots.training, roots.validation, roots.holdout]).size !== 3)
		return "closure_root_binding_mismatch";
	if (manifest.splitBoundaryPolicy.locked !== true) return "split_provenance_violation";
	const policy = manifest.splitBoundaryPolicy;
	if (!digest(policy.policyDigest)) return "split_provenance_violation";
	const boundaries = [
		Date.parse(policy.trainingEndExclusive),
		Date.parse(policy.validationStartInclusive),
		Date.parse(policy.validationEndExclusive),
		Date.parse(policy.holdoutStartInclusive),
		Date.parse(policy.holdoutEndExclusive),
	];
	if (boundaries.some((value) => !Number.isFinite(value))) return "split_provenance_violation";
	if (
		boundaries[0] > boundaries[1] ||
		boundaries[1] >= boundaries[2] ||
		boundaries[2] > boundaries[3] ||
		boundaries[3] >= boundaries[4]
	)
		return "split_provenance_violation";
	if (
		manifest.modelAccess.training !== "training_workers_training_only" ||
		manifest.modelAccess.validation !== "validation_evaluator_host_only" ||
		manifest.modelAccess.holdout !== "holdout_host_aggregate_only" ||
		manifest.modelAccess.holdoutRowsVisible !== false ||
		manifest.modelAccess.holdoutPerCaseFeedback !== false ||
		manifest.modelAccess.holdoutReturns !== "aggregate_signed_evidence_only" ||
		manifest.modelAccess.signedAggregateEvidence !== true
	)
		return "holdout_evidence_exposed";
	const splitManifests = [manifest.training, manifest.validation, manifest.holdout];
	const artifactUris = new Set<string>();
	for (const [index, splitManifest] of splitManifests.entries()) {
		const expectedSplit = index === 0 ? "training" : index === 1 ? "validation" : "holdout";
		if (splitManifest.split !== expectedSplit || splitManifest.locked !== true) return "split_provenance_violation";
		const expectedRoot = roots[expectedSplit];
		if (splitManifest.closureRootDigest !== expectedRoot || splitManifest.artifacts.length === 0)
			return "closure_root_binding_mismatch";
		for (const artifact of splitManifest.artifacts) {
			if (artifactUris.has(artifact.objectUri)) return "split_provenance_violation";
			artifactUris.add(artifact.objectUri);
			if (artifact.split !== expectedSplit || artifact.closureRootDigest !== expectedRoot)
				return "closure_root_binding_mismatch";
			const expectedAuthority =
				expectedSplit === "training"
					? "training_workers_training_only"
					: expectedSplit === "validation"
						? "validation_evaluator_host_only"
						: "holdout_host_aggregate_only";
			if (artifact.accessAuthority !== expectedAuthority) return "split_provenance_violation";
			if (artifact.modality.length === 0 || artifact.instrumentSet.length === 0) return "split_provenance_violation";
			if (artifact.validationResult === "failed") return "split_provenance_violation";
			if (artifact.gapClassification === "provider_empty") return "provider_empty";
			if (artifact.gapClassification === "partial_coverage") return "partial_coverage";
			if (artifact.gapClassification === "unknown" || artifact.gapClassification === "missing")
				return "unknown_or_missing";
			if (artifact.coverage === "provider_empty") return "provider_empty";
			if (artifact.coverage === "partial_coverage") return "partial_coverage";
			if (artifact.coverage === "unknown" || artifact.coverage === "missing") return "unknown_or_missing";
			if (artifact.coverage !== "complete" || artifact.gapClassification !== "none") return "unknown_or_missing";
			if (artifact.validationResult !== "passed") return "unknown_or_missing";
			if (artifact.lifecycle !== "sealed") return "split_provenance_violation";
			if (
				artifact.restoreVerification.locked !== true ||
				artifact.restoreVerification.independentlyRestored !== true ||
				artifact.restoreVerification.independentlyRehashed !== true ||
				artifact.restoreVerification.verificationEvidenceDigest === null ||
				!digest(artifact.restoreVerification.verificationEvidenceDigest)
			)
				return "split_provenance_violation";
			if (
				!digest(artifact.sha256) ||
				!digest(artifact.provenance.ingestDigest) ||
				!digest(artifact.provenance.lineageDigest) ||
				!digest(artifact.provenance.provenanceReceiptDigest)
			)
				return "split_provenance_violation";
			const start = Date.parse(artifact.sourceTimeStart);
			const end = Date.parse(artifact.sourceTimeEnd);
			if (!Number.isFinite(start) || !Number.isFinite(end)) return "split_provenance_violation";
			if (expectedSplit === "training" && end > boundaries[0]) return "split_provenance_violation";
			if (expectedSplit === "validation" && (start < boundaries[1] || end > boundaries[2]))
				return "split_provenance_violation";
			if (expectedSplit === "holdout" && (start < boundaries[3] || end > boundaries[4]))
				return "split_provenance_violation";
		}
	}
	return null;
}

async function manifestEvidenceReason(input: AutoResearchPortfolioAdmissionInput): Promise<string | null> {
	const evidence = input.manifestEvidence;
	if (
		typeof evidence !== "object" ||
		evidence === null ||
		!hasExactKeys(evidence, ["manifestReceipt", "artifactReceipts"]) ||
		!isWorkflowVerifiedHostReceipt(evidence.manifestReceipt) ||
		!isDenseArray(evidence.artifactReceipts)
	)
		return "manifest_evidence_missing";
	const manifest = input.contract.inputManifest;
	if (
		evidence.manifestReceipt.bindingDigest !== manifestBindingDigest(input.contract) ||
		evidence.manifestReceipt.payloadDigest !== manifest.manifestDigest ||
		!(await verifyHostEvidenceReceipt(
			input,
			evidence.manifestReceipt,
			manifestBindingDigest(input.contract),
			"capability",
		))
	)
		return "manifest_evidence_failed";
	const expectedArtifacts =
		input.contract.inputManifest.training.artifacts.length +
		input.contract.inputManifest.validation.artifacts.length +
		input.contract.inputManifest.holdout.artifacts.length;
	if (evidence.artifactReceipts.length !== expectedArtifacts) return "manifest_evidence_incomplete";
	const seen = new Set<string>();
	for (const entry of evidence.artifactReceipts) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!hasExactKeys(entry, ["split", "objectUri", "receipt"]) ||
			(entry.split !== "training" && entry.split !== "validation" && entry.split !== "holdout") ||
			typeof entry.objectUri !== "string" ||
			!isWorkflowVerifiedHostReceipt(entry.receipt)
		)
			return "manifest_evidence_invalid";
		const key = `${entry.split}\u0000${entry.objectUri}`;
		if (seen.has(key)) return "manifest_evidence_duplicate";
		seen.add(key);
		const expectedBinding = manifestArtifactBindingDigest(input.contract, entry.split, entry.objectUri);
		const artifact = input.contract.inputManifest[entry.split].artifacts.find(
			(candidateArtifact) => candidateArtifact.objectUri === entry.objectUri,
		);
		if (
			artifact === undefined ||
			entry.receipt.bindingDigest !== expectedBinding ||
			entry.receipt.payloadDigest !== manifestArtifactPayloadDigest(input.contract, entry.split, entry.objectUri) ||
			!(await verifyHostEvidenceReceipt(input, entry.receipt, expectedBinding, "capability"))
		)
			return "manifest_evidence_failed";
	}
	return null;
}

async function mechanismFamilyReason(input: AutoResearchPortfolioAdmissionInput): Promise<string | null> {
	const registrations = input.preregisteredFamilies ?? [];
	const seen = new Set<string>();
	for (const registration of registrations) {
		if (
			typeof registration !== "object" ||
			registration === null ||
			!hasExactKeys(registration, ["familyId", "mechanismClass", "mechanismDigest", "changeDigest", "receipt"]) ||
			seen.has(registration.familyId) ||
			!isWorkflowVerifiedHostReceipt(registration.receipt)
		)
			return "mechanism_family_registration_invalid";
		seen.add(registration.familyId);
		const expectedBinding = evidenceBindingDigest("portfolio.mechanism-family.v1", input.contract, {
			familyId: registration.familyId,
			mechanismClass: registration.mechanismClass,
			mechanismDigest: registration.mechanismDigest,
			changeDigest: registration.changeDigest,
			patchArtifactRef: registration.receipt.artifactRef,
		});
		if (
			!isArtifactRef(registration.receipt.artifactRef) ||
			registration.receipt.bindingDigest !== expectedBinding ||
			registration.receipt.payloadDigest !== mechanismFamilyRegistrationDigest(registration) ||
			!(await verifyImmutableArtifact(input, registration.receipt.artifactRef)) ||
			!(await verifyHostEvidenceReceipt(input, registration.receipt, expectedBinding, "capability"))
		)
			return "mechanism_family_registration_failed";
	}
	return null;
}

function goalManifestReason(contract: AutoResearchPortfolioContract): string | null {
	const manifest = contract.inputManifest;
	for (const goal of contract.goals) {
		const expectedRoots = manifest.splitClosureRoots;
		if (goal.scope !== "terminal") return "scope_violation";
		if (
			goal.baseline.evaluationEpoch !== manifest.evaluationEpoch ||
			goal.evaluator.evaluationEpoch !== manifest.evaluationEpoch ||
			goal.parser.evaluationEpoch !== manifest.evaluationEpoch ||
			goal.opaqueHoldout.evaluationEpoch !== manifest.evaluationEpoch
		)
			return "evaluation_epoch_mismatch";
		if (goal.evaluator.evaluatorRevision !== manifest.manifestRevision) return "evaluation_epoch_mismatch";
		if (goal.parser.inputManifestRevision !== manifest.manifestRevision) return "evaluation_epoch_mismatch";
		if (goal.opaqueHoldout.candidateVisible !== false) return "holdout_evidence_exposed";
		if (
			goal.baseline.inputManifestDigest !== manifest.manifestDigest ||
			goal.evaluator.inputManifestDigest !== manifest.manifestDigest ||
			goal.parser.inputManifestDigest !== manifest.manifestDigest ||
			goal.opaqueHoldout.inputDigest !== manifest.manifestDigest
		)
			return "input_manifest_binding_mismatch";
		if (goal.baseline.closureRootDigest !== manifest.closureRootDigest) return "closure_root_binding_mismatch";
		if (goal.evaluator.closureRootDigest !== manifest.closureRootDigest) return "closure_root_binding_mismatch";
		if (goal.parser.closureRootDigest !== manifest.closureRootDigest) return "closure_root_binding_mismatch";
		if (goal.opaqueHoldout.closureRootDigest !== manifest.closureRootDigest) return "closure_root_binding_mismatch";
		if (
			!sameSplitRoots(goal.baseline.splitClosureRoots, expectedRoots) ||
			!sameSplitRoots(goal.evaluator.splitClosureRoots, expectedRoots) ||
			!sameSplitRoots(goal.parser.splitClosureRoots, expectedRoots) ||
			!sameSplitRoots(goal.opaqueHoldout.splitClosureRoots, expectedRoots)
		)
			return "closure_root_binding_mismatch";
		for (const metric of goal.metrics) {
			if (
				metric.evaluationEpoch !== manifest.evaluationEpoch ||
				metric.metricRevision !== manifest.manifestRevision ||
				metric.closureRootDigest !== manifest.closureRootDigest ||
				metric.inputManifestDigest !== manifest.manifestDigest
			)
				return "evaluation_epoch_mismatch";
			const metricRoots = metric.splitClosureRoots;
			if (!sameSplitRoots(metricRoots, manifest.splitClosureRoots)) return "closure_root_binding_mismatch";
		}
	}
	return null;
}

function measurementReason(
	contract: AutoResearchPortfolioContract,
	measurements: readonly AutoResearchPortfolioMeasurement[],
	knownCandidateIds: ReadonlySet<string>,
	trustedNow: string,
): string | null {
	const manifest = contract.inputManifest;
	const trustedNowMilliseconds = Date.parse(trustedNow);
	if (!Number.isFinite(trustedNowMilliseconds)) return "trusted_time_invalid";
	const metricIds = new Set(contract.goals.flatMap((goal) => goal.metrics.map((metric) => metric.metricId)));
	const measurementIds = new Set<string>();
	for (const measurement of measurements) {
		if (measurementIds.has(measurement.measurementId)) return "duplicate_metric_measurement";
		measurementIds.add(measurement.measurementId);
		if (measurement.scope !== "terminal") return "scope_violation";
		if (measurement.kind === "holdout") return "holdout_evidence_exposed";
		if (measurement.kind !== "candidate") return "host_measurement_kind_invalid";
		if (Date.parse(measurement.measuredAt) > trustedNowMilliseconds) return "host_measurement_future_dated";
		if (measurement.evaluationEpoch !== manifest.evaluationEpoch) return "evaluation_epoch_mismatch";
		if (measurement.inputManifestDigest !== manifest.manifestDigest) return "input_manifest_binding_mismatch";
		if (!sameSplitRoots(measurement.splitClosureRoots, manifest.splitClosureRoots))
			return "closure_root_binding_mismatch";
		if (
			!interval(measurement.confidenceInterval) ||
			measurement.confidenceInterval.level <= 0 ||
			measurement.confidenceInterval.level > 1 ||
			!finite(measurement.variance) ||
			measurement.variance < 0 ||
			!Number.isSafeInteger(measurement.runCount) ||
			measurement.runCount < 1 ||
			!Number.isSafeInteger(measurement.sampleCount) ||
			measurement.sampleCount < measurement.runCount
		)
			return "host_measurement_uncertainty_invalid";
		if (!digest(measurement.inputDigest) || !digest(measurement.evaluatorDigest) || !digest(measurement.parserDigest))
			return "host_measurement_unbound";
		if (
			!digest(measurement.commandDigest) ||
			!digest(measurement.workspaceDigest) ||
			!digest(measurement.measurementDigest)
		)
			return "host_measurement_unbound";
		if (measurement.evidenceDigests.length === 0 || measurement.evidenceDigests.some((entry) => !digest(entry)))
			return "host_measurement_unbound";
		if (
			measurement.vector.some(
				(vector) =>
					vector.value < measurement.confidenceInterval.lower ||
					vector.value > measurement.confidenceInterval.upper,
			)
		)
			return "host_measurement_uncertainty_invalid";
		if (measurement.candidateId === null) return "host_measurement_unbound";
		if (measurement.candidateId !== null && !knownCandidateIds.has(measurement.candidateId))
			return "host_measurement_unbound";
		if (measurement.vector.length === 0) return "host_measurement_unbound";
		const goal = contract.goals.find((entry) => entry.goalId === measurement.goalId);
		if (goal === undefined) return "host_measurement_metric_invalid";
		if (measurement.runCount !== goal.repeatability.runs) return "host_measurement_repeatability_invalid";
		if (measurement.aggregation !== goal.repeatability.aggregation) return "host_measurement_repeatability_invalid";
		if (
			measurement.confidenceInterval.upper - measurement.confidenceInterval.lower >
			Math.min(goal.uncertainty.maxWidth, contract.safety.maxUncertainty)
		)
			return "host_measurement_uncertainty_invalid";
		if (measurement.variance > Math.min(goal.repeatability.maxVariance, goal.uncertainty.maxVariance))
			return "variance_exceeds_limit";
		if (measurement.confidenceInterval.level < goal.uncertainty.confidence)
			return "host_measurement_uncertainty_invalid";
		if (measurement.inputDigest !== measurement.inputManifestDigest) return "input_manifest_binding_mismatch";
		if (measurement.evaluatorDigest !== goal.evaluator.evaluatorDigest) return "evaluator_manifest_binding_mismatch";
		if (measurement.parserDigest !== goal.parser.parserDigest) return "parser_manifest_binding_mismatch";
		if (measurement.commandDigest !== goal.command.commandDigest) return "command_manifest_binding_mismatch";
		const goalMetricIds = new Set(goal.metrics.map((metric) => metric.metricId));
		if (
			JSON.stringify(sortedUnique(measurement.vector.map((entry) => entry.metricId))) !==
			JSON.stringify(sortedUnique([...goalMetricIds]))
		)
			return "host_measurement_metric_omission";
		for (const vector of measurement.vector) {
			if (!metricIds.has(vector.metricId) || !goalMetricIds.has(vector.metricId) || !finite(vector.value))
				return "host_measurement_metric_invalid";
		}
	}
	return null;
}

function aggregateRunMetricValues(values: readonly number[], aggregation: "exact" | "mean" | "median"): number | null {
	if (values.length === 0) return null;
	if (aggregation === "exact") return values.every((value) => value === values[0]) ? values[0]! : null;
	if (aggregation === "mean") return values.reduce((sum, value) => sum + value, 0) / values.length;
	const sortedValues = [...values].sort((left, right) => left - right);
	return sortedValues.length % 2 === 1
		? sortedValues[(sortedValues.length - 1) / 2]!
		: (sortedValues[sortedValues.length / 2 - 1]! + sortedValues[sortedValues.length / 2]!) / 2;
}

async function measurementEvidenceReason(
	input: AutoResearchPortfolioAdmissionInput,
	measurements: readonly AutoResearchPortfolioMeasurement[],
): Promise<string | null> {
	const evidence = input.measurementEvidence;
	if (!isDenseArray(evidence) || evidence.length !== measurements.length) return "measurement_evidence_missing";
	const byMeasurementId = new Map<string, AutoResearchPortfolioMeasurementEvidence>();
	for (const entry of evidence) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!hasExactKeys(entry, ["measurementId", "runs"]) ||
			typeof entry.measurementId !== "string" ||
			!isDenseArray(entry.runs)
		)
			return "measurement_evidence_invalid";
		if (byMeasurementId.has(entry.measurementId)) return "measurement_evidence_duplicate";
		byMeasurementId.set(entry.measurementId, entry);
	}
	const receiptIds = new Set<string>();
	const runArtifactIds = new Set<string>();
	const runArtifacts = new Set<string>();
	const runSeeds = new Set<string>();
	const runContents = new Set<string>();
	for (const measurement of measurements) {
		const entry = byMeasurementId.get(measurement.measurementId);
		if (entry === undefined) return "measurement_evidence_missing";
		const goal = input.contract.goals.find((entry) => entry.goalId === measurement.goalId);
		if (goal === undefined || entry.runs.length !== goal.repeatability.runs) return "measurement_run_set_invalid";
		for (let runIndex = 1; runIndex <= goal.repeatability.runs; runIndex += 1) {
			const run = entry.runs[runIndex - 1];
			if (
				typeof run !== "object" ||
				run === null ||
				!hasExactKeys(run, ["runIndex", "artifactRef", "seedDigest", "contentDigest", "metricValues", "receipt"]) ||
				run.runIndex !== runIndex ||
				!isArtifactRef(run.artifactRef) ||
				!digest(run.seedDigest) ||
				!digest(run.contentDigest) ||
				!isDenseArray(run.metricValues) ||
				run.metricValues.some(
					(value) =>
						typeof value !== "object" ||
						value === null ||
						!hasExactKeys(value, ["metricId", "value"]) ||
						typeof value.metricId !== "string" ||
						!finite(value.value),
				) ||
				!isWorkflowVerifiedHostReceipt(run.receipt)
			)
				return "measurement_run_set_invalid";
			const metricIds = measurement.vector.map((entry) => entry.metricId);
			if (
				new Set(run.metricValues.map((entry) => entry.metricId)).size !== run.metricValues.length ||
				JSON.stringify(sortedUnique(run.metricValues.map((entry) => entry.metricId))) !==
					JSON.stringify(sortedUnique(metricIds))
			)
				return "measurement_run_metric_invalid";
			const receipt = run.receipt;
			if (receiptIds.has(receipt.receiptId)) return "measurement_run_set_duplicate";
			receiptIds.add(receipt.receiptId);
			if (runArtifactIds.has(run.artifactRef.artifactId)) return "measurement_run_artifact_duplicate";
			runArtifactIds.add(run.artifactRef.artifactId);
			const artifactKey = digestObject(run.artifactRef);
			if (runArtifacts.has(artifactKey)) return "measurement_run_artifact_duplicate";
			runArtifacts.add(artifactKey);
			if (runSeeds.has(run.seedDigest)) return "measurement_run_seed_duplicate";
			runSeeds.add(run.seedDigest);
			if (runContents.has(run.contentDigest)) return "measurement_run_content_duplicate";
			runContents.add(run.contentDigest);
			if (run.contentDigest !== run.artifactRef.digest) return "measurement_run_content_mismatch";
			if (!(await verifyImmutableArtifact(input, run.artifactRef))) return "measurement_run_artifact_unverified";
			const expectedBinding = measurementBindingDigest(input.contract, measurement, run);
			if (
				receipt.receiptKind !== "capability" ||
				receipt.bindingDigest !== expectedBinding ||
				receipt.payloadDigest !==
					digestObject({
						measurementDigest: measurement.measurementDigest,
						runIndex,
						artifactRef: run.artifactRef,
						seedDigest: run.seedDigest,
						contentDigest: run.contentDigest,
						metricValues: [...run.metricValues].sort((left, right) =>
							left.metricId.localeCompare(right.metricId),
						),
					}) ||
				!(await verifyHostEvidenceReceipt(input, receipt, expectedBinding, "capability"))
			)
				return "measurement_evidence_failed";
		}
		for (const vector of measurement.vector) {
			const runValues = entry.runs.map(
				(run) => run.metricValues.find((value) => value.metricId === vector.metricId)?.value,
			);
			if (runValues.some((value): value is undefined => value === undefined))
				return "measurement_run_metric_invalid";
			const numericValues = runValues as readonly number[];
			const aggregate = aggregateRunMetricValues(numericValues, measurement.aggregation);
			if (aggregate === null || aggregate !== vector.value) return "measurement_aggregate_mismatch";
			const minimum = Math.min(...numericValues);
			const maximum = Math.max(...numericValues);
			if (measurement.confidenceInterval.lower > minimum || measurement.confidenceInterval.upper < maximum)
				return "measurement_interval_mismatch";
			const mean = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
			const variance =
				numericValues.length > 1
					? numericValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (numericValues.length - 1)
					: 0;
			if (variance > measurement.variance + 1e-12 * Math.max(1, Math.abs(variance)))
				return "measurement_variance_mismatch";
		}
	}
	return null;
}

function metricSpecs(
	contract: AutoResearchPortfolioContract,
	closure: AutoResearchPortfolioImpactClosure,
): readonly MetricSpec[] {
	const specs: MetricSpec[] = [];
	for (const goal of contract.goals) {
		if (!closure.goalIds.includes(goal.goalId)) continue;
		const tier = contract.lexicographicTiers.find((entry) => entry.goalIds.includes(goal.goalId))!.tier;
		for (const metric of goal.metrics) {
			if (!closure.metricIds.includes(metric.metricId)) continue;
			const baselineEntry = goal.baseline.metricValues.find((entry) => entry.metricId === metric.metricId);
			if (baselineEntry === undefined) continue;
			const baselineValue = baselineEntry.value;
			const baseline = { lower: baselineValue, upper: baselineValue };
			const effect = metric.direction === "higher" ? metric.target - baselineValue : baselineValue - metric.target;
			const minimumEffect = Math.max(0, effect);
			const uncertaintyWidth = Math.min(goal.uncertainty.maxWidth, contract.safety.maxUncertainty);
			specs.push({
				metricId: metric.metricId,
				goalId: goal.goalId,
				direction: metric.direction,
				aggregation: goal.repeatability.aggregation,
				tier,
				baseline,
				minimumEffect,
				nonInferiorityMargin: uncertaintyWidth / 2,
				frontierNonInferiorityMargin: uncertaintyWidth / 2,
				maxIntervalWidth: Math.min(goal.uncertainty.maxWidth, contract.safety.maxUncertainty),
				maxVariance: Math.min(goal.repeatability.maxVariance, goal.uncertainty.maxVariance),
				minimumRepeats: goal.repeatability.runs,
			});
		}
	}
	return Object.freeze(
		specs.sort((left, right) => left.tier - right.tier || left.metricId.localeCompare(right.metricId)),
	);
}

function candidateRows(
	candidate: AutoResearchPortfolioCandidate,
	measurements: readonly AutoResearchPortfolioMeasurement[],
): readonly AutoResearchPortfolioMeasurement[] {
	return measurements.filter(
		(measurement) => measurement.candidateId === candidate.candidateId && measurement.kind === "candidate",
	);
}

function hasCompleteRepeatSets(
	candidate: AutoResearchPortfolioCandidate,
	specs: readonly MetricSpec[],
	measurements: readonly AutoResearchPortfolioMeasurement[],
): boolean {
	const rows = candidateRows(candidate, measurements);
	let expected: readonly number[] | null = null;
	for (const spec of specs) {
		const repeats = sortedUnique(
			rows
				.filter((row) => row.vector.some((entry) => entry.metricId === spec.metricId))
				.map((row) => String(row.repeatIndex)),
		).map((value) => Number(value));
		if (repeats.length === 0) return true;
		if (expected === null) expected = repeats;
		if (JSON.stringify(repeats) !== JSON.stringify(expected)) return false;
	}
	return expected !== null;
}

function measurementInterval(row: AutoResearchPortfolioMeasurement): Interval {
	return { lower: row.confidenceInterval.lower, upper: row.confidenceInterval.upper };
}

function aggregateMetric(
	rows: readonly AutoResearchPortfolioMeasurement[],
	spec: MetricSpec,
): {
	readonly observation: MetricObservation | null;
	readonly duplicate: boolean;
	readonly aggregationInvalid: boolean;
	readonly intervalInvalid: boolean;
} {
	const entries: Array<{
		readonly row: AutoResearchPortfolioMeasurement;
		readonly vector: AutoResearchPortfolioMeasurement["vector"][number];
	}> = [];
	const seenRepeats = new Set<number>();
	let duplicate = false;
	for (const row of rows) {
		const hostRow = row;
		const vector = row.vector.find((entry) => entry.metricId === spec.metricId);
		if (vector === undefined) continue;
		if (seenRepeats.has(row.repeatIndex)) duplicate = true;
		seenRepeats.add(row.repeatIndex);
		entries.push({ row: hostRow, vector });
	}
	if (entries.length === 0) return { observation: null, duplicate, aggregationInvalid: false, intervalInvalid: false };
	const values = entries.map((entry) => entry.vector.value);
	if (entries.some((entry) => entry.row.aggregation !== spec.aggregation))
		return { observation: null, duplicate, aggregationInvalid: true, intervalInvalid: false };
	if (spec.aggregation === "exact" && values.some((value) => value !== values[0]))
		return { observation: null, duplicate, aggregationInvalid: true, intervalInvalid: false };
	const sortedValues = [...values].sort((left, right) => left - right);
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const aggregatedValue =
		spec.aggregation === "exact"
			? values[0]!
			: spec.aggregation === "mean"
				? mean
				: sortedValues.length % 2 === 1
					? sortedValues[(sortedValues.length - 1) / 2]!
					: (sortedValues[sortedValues.length / 2 - 1]! + sortedValues[sortedValues.length / 2]!) / 2;
	const varianceValues =
		values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
	const explicitVariance = Math.max(0, ...entries.map((entry) => entry.row.variance));
	const intervals = entries.map((entry) => measurementInterval(entry.row));
	const repeats = entries.length * spec.minimumRepeats;
	const aggregateInterval = {
		lower: Math.min(...intervals.map((value) => value.lower)),
		upper: Math.max(...intervals.map((value) => value.upper)),
	};
	const intervalInvalid = aggregateInterval.upper - aggregateInterval.lower > spec.maxIntervalWidth;
	return {
		observation: {
			value: aggregatedValue,
			interval: aggregateInterval,
			repeats,
			variance: Math.max(varianceValues, explicitVariance),
		},
		duplicate,
		aggregationInvalid: false,
		intervalInvalid,
	};
}

function orientedDifference(direction: AutoResearchPortfolioMetricDirection, value: number, baseline: number): number {
	return direction === "higher" ? value - baseline : baseline - value;
}

function compareMetric(
	spec: MetricSpec,
	observation: MetricObservation,
	frontier: Interval,
	reference: "baseline" | "frontier",
): MetricComparison {
	const guaranteedEffect =
		spec.direction === "higher"
			? observation.interval.lower - frontier.upper
			: frontier.lower - observation.interval.upper;
	const rawEffect = orientedDifference(spec.direction, observation.value, (frontier.lower + frontier.upper) / 2);
	const nonInferiorityMargin =
		reference === "baseline" ? spec.nonInferiorityMargin : spec.frontierNonInferiorityMargin;
	const regression =
		spec.direction === "higher"
			? observation.interval.upper < frontier.lower - nonInferiorityMargin
			: observation.interval.lower > frontier.upper + nonInferiorityMargin;
	const minimumEffect = reference === "baseline" ? spec.minimumEffect : 0;
	const strictImprovement =
		guaranteedEffect >= minimumEffect && rawEffect >= minimumEffect && (guaranteedEffect > 0 || rawEffect > 0);
	return {
		metric: spec,
		observation,
		strictImprovement,
		regression,
		intervalNotSeparated: !strictImprovement && !regression && rawEffect > 0,
	};
}

function frontierReferenceVectors(
	contract: AutoResearchPortfolioContract,
	specs: readonly MetricSpec[],
	frontier: readonly AutoResearchPortfolioCandidate[],
	measurements: readonly AutoResearchPortfolioMeasurement[],
	closure: AutoResearchPortfolioImpactClosure,
): readonly ReferenceVector[] {
	const references: ReferenceVector[] = [];
	for (const entry of frontier) {
		const entryClosure = deriveAutoResearchPortfolioImpactClosure(contract, entry);
		if (
			JSON.stringify(entryClosure.metricIds) !== JSON.stringify(closure.metricIds) ||
			JSON.stringify(entryClosure.goalIds) !== JSON.stringify(closure.goalIds)
		)
			continue;
		if (!hasCompleteRepeatSets(entry, specs, measurements)) continue;
		const intervals = new Map<string, Interval>();
		let complete = true;
		for (const spec of specs) {
			const aggregate = aggregateMetric(candidateRows(entry, measurements), spec);
			if (
				aggregate.duplicate ||
				aggregate.aggregationInvalid ||
				aggregate.intervalInvalid ||
				aggregate.observation === null ||
				aggregate.observation.repeats < spec.minimumRepeats ||
				aggregate.observation.variance > spec.maxVariance
			) {
				complete = false;
				break;
			}
			intervals.set(spec.metricId, aggregate.observation.interval);
		}
		if (complete) references.push({ intervals });
	}
	return references;
}

function sameImpactClosureShape(
	left: AutoResearchPortfolioImpactClosure,
	right: AutoResearchPortfolioImpactClosure,
): boolean {
	return (
		JSON.stringify({
			intendedGoalIds: left.intendedGoalIds,
			dependentGoalIds: left.dependentGoalIds,
			competingGoalIds: left.competingGoalIds,
			conflictRelatedGoalIds: left.conflictRelatedGoalIds,
			structurallyAffectedGoalIds: left.structurallyAffectedGoalIds,
			goalIds: left.goalIds,
			metricIds: left.metricIds,
			affectedPartitionIds: left.affectedPartitionIds,
			affectedInvariantIds: left.affectedInvariantIds,
		}) ===
		JSON.stringify({
			intendedGoalIds: right.intendedGoalIds,
			dependentGoalIds: right.dependentGoalIds,
			competingGoalIds: right.competingGoalIds,
			conflictRelatedGoalIds: right.conflictRelatedGoalIds,
			structurallyAffectedGoalIds: right.structurallyAffectedGoalIds,
			goalIds: right.goalIds,
			metricIds: right.metricIds,
			affectedPartitionIds: right.affectedPartitionIds,
			affectedInvariantIds: right.affectedInvariantIds,
		})
	);
}

interface VerifiedTradeoffAuthorization {
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly bindingDigest: string;
	readonly authorizationDigest: string;
	readonly userAuthorityDigest: string;
}

interface VerifiedPreregistration {
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly bindingDigest: string;
	readonly authorizationDigest: string;
	readonly userAuthorityDigest: string;
}

async function consumeAdmissionReceipt(
	input: AutoResearchPortfolioAdmissionInput,
	receipt: WorkflowVerifiedHostReceipt,
	bindingDigest: string,
): Promise<WorkflowHostReceiptConsumptionWitness | null> {
	if (!receipt.oneUse) return null;
	try {
		await input.receiptContext.receiptResolver.consumeIfOneUse({
			receipt,
			workflowId: input.workflowId,
			expectedBindingDigest: bindingDigest,
			currentRevision: input.currentRevision,
		});
		const witness = await input.receiptContext.receiptResolver.resolveConsumptionWitness({
			receiptId: receipt.receiptId,
			workflowId: input.workflowId,
			expectedBindingDigest: bindingDigest,
		});
		return witness.receiptId === receipt.receiptId &&
			witness.workflowId === input.workflowId &&
			witness.bindingDigest === bindingDigest &&
			witness.receiptDigest === digestObject(receipt) &&
			witness.capability === receipt.capabilityBinding?.capability &&
			witness.resourceDigest === receipt.capabilityBinding?.resourceDigest &&
			witness.operationDigest === receipt.capabilityBinding?.operationDigest &&
			Number.isSafeInteger(witness.consumptionSequence) &&
			witness.consumptionSequence >= 1 &&
			Number.isFinite(Date.parse(witness.consumedAt)) &&
			Date.parse(witness.consumedAt) <= Date.parse(input.trustedNow)
			? witness
			: null;
	} catch {
		return null;
	}
}

async function receiptAlreadyConsumed(
	input: AutoResearchPortfolioAdmissionInput,
	receipt: WorkflowVerifiedHostReceipt,
	bindingDigest: string,
): Promise<boolean> {
	if (!receipt.oneUse) return false;
	try {
		await input.receiptContext.receiptResolver.resolveConsumptionWitness({
			receiptId: receipt.receiptId,
			workflowId: input.workflowId,
			expectedBindingDigest: bindingDigest,
		});
		return true;
	} catch {
		return false;
	}
}

function tradeoffBindingDigest(
	input: AutoResearchPortfolioAdmissionInput,
	authorization: AutoResearchPortfolioTradeoffAuthorization,
): string {
	const competingGoalSet = new Set(authorization.competingGoalIds);
	const evidence = input.measurements
		.filter(
			(measurement) =>
				measurement.candidateId === input.candidate.candidateId &&
				measurement.kind === "candidate" &&
				competingGoalSet.has(measurement.goalId),
		)
		.map((measurement) => ({
			measurementId: measurement.measurementId,
			measurementDigest: measurement.measurementDigest,
		}))
		.sort((left, right) => left.measurementId.localeCompare(right.measurementId));
	const candidateMeasurements = input.measurements
		.filter(
			(measurement) => measurement.candidateId === input.candidate.candidateId && measurement.kind === "candidate",
		)
		.map((measurement) => ({
			measurementId: measurement.measurementId,
			measurementDigest: measurement.measurementDigest,
		}))
		.sort((left, right) => left.measurementId.localeCompare(right.measurementId));
	const selectedFrontierEntries = input.frontier
		.filter((entry) => authorization.selectedFrontierEntryIds.includes(entry.candidateId))
		.map((entry) => ({
			candidateId: entry.candidateId,
			candidateReviewBindingDigest: candidateReviewBindingDigest(entry),
		}))
		.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
	return digestObject({
		kind: "portfolio.frontier.tradeoff.v1",
		contractDigest: contractDigest(input.contract),
		impactClosureDigest: deriveAutoResearchPortfolioImpactClosure(input.contract, input.candidate)
			.impactClosureDigest,
		candidateId: authorization.candidateId,
		competingGoalIds: sortedUnique(authorization.competingGoalIds),
		concessions: sortedUnique(authorization.concessions),
		floors: [...authorization.floors].sort((left, right) => left.goalId.localeCompare(right.goalId)),
		evidenceIds: sortedUnique(authorization.evidenceIds),
		evidence,
		candidateMeasurements,
		selectedFrontierEntryIds: sortedUnique(authorization.selectedFrontierEntryIds),
		selectedFrontierEntries,
	});
}

async function validTradeoffAuthorization(
	input: AutoResearchPortfolioAdmissionInput,
	competingGoalIds: readonly string[],
	observations: ReadonlyMap<string, MetricObservation>,
): Promise<VerifiedTradeoffAuthorization | null> {
	const authorization = input.tradeoffAuthorization;
	if (
		authorization === undefined ||
		authorization === null ||
		typeof authorization !== "object" ||
		!hasExactKeys(authorization, [
			"candidateId",
			"competingGoalIds",
			"concessions",
			"floors",
			"evidenceIds",
			"selectedFrontierEntryIds",
			"userAuthority",
			"receipt",
		])
	)
		return null;
	if (
		!isStringArray(authorization.competingGoalIds) ||
		!isStringArray(authorization.concessions) ||
		!isStringArray(authorization.evidenceIds) ||
		!isStringArray(authorization.selectedFrontierEntryIds) ||
		!isDenseArray(authorization.floors) ||
		authorization.floors.some(
			(floor) =>
				typeof floor !== "object" ||
				floor === null ||
				!hasExactKeys(floor, ["goalId", "value"]) ||
				typeof floor.goalId !== "string" ||
				typeof floor.value !== "number",
		)
	)
		return null;
	if (authorization.candidateId !== input.candidate.candidateId) return null;
	if (
		new Set(authorization.competingGoalIds).size !== authorization.competingGoalIds.length ||
		new Set(authorization.concessions).size !== authorization.concessions.length ||
		new Set(authorization.evidenceIds).size !== authorization.evidenceIds.length ||
		!isCanonicalStringArray(authorization.competingGoalIds) ||
		!isCanonicalStringArray(authorization.concessions) ||
		!isCanonicalStringArray(authorization.evidenceIds) ||
		!isCanonicalStringArray(authorization.selectedFrontierEntryIds)
	)
		return null;
	if (JSON.stringify(sortedUnique(authorization.competingGoalIds)) !== JSON.stringify(sortedUnique(competingGoalIds)))
		return null;
	if (JSON.stringify(sortedUnique(authorization.concessions)) !== JSON.stringify(sortedUnique(competingGoalIds)))
		return null;
	const floorGoalIds = authorization.floors.map((floor) => floor.goalId);
	if (
		new Set(floorGoalIds).size !== floorGoalIds.length ||
		JSON.stringify(floorGoalIds) !==
			JSON.stringify([...floorGoalIds].sort((left, right) => left.localeCompare(right))) ||
		JSON.stringify(sortedUnique(floorGoalIds)) !== JSON.stringify(sortedUnique(competingGoalIds)) ||
		authorization.floors.some((floor) => !finite(floor.value))
	)
		return null;
	const floorByGoalId = new Map(authorization.floors.map((floor) => [floor.goalId, floor.value]));
	for (const goalId of competingGoalIds) {
		const floor = floorByGoalId.get(goalId);
		const goal = input.contract.goals.find((entry) => entry.goalId === goalId);
		if (floor === undefined || goal === undefined || goal.metrics.length !== 1) return null;
		for (const metric of goal.metrics) {
			const observation = observations.get(metric.metricId);
			if (observation === undefined) return null;
			const baseline = goal.baseline.metricValues.find((entry) => entry.metricId === metric.metricId);
			if (baseline === undefined) return null;
			const lowerBound = Math.min(baseline.value, metric.target);
			const upperBound = Math.max(baseline.value, metric.target);
			if (floor < lowerBound || floor > upperBound) return null;
			if (metric.direction === "higher" && observation.interval.lower < floor) return null;
			if (metric.direction === "lower" && observation.interval.upper > floor) return null;
		}
	}
	const expectedEvidenceIds = sortedUnique(
		input.measurements
			.filter(
				(measurement) =>
					measurement.candidateId === input.candidate.candidateId &&
					measurement.kind === "candidate" &&
					competingGoalIds.includes(measurement.goalId),
			)
			.map((measurement) => measurement.measurementId),
	);
	if (JSON.stringify(sortedUnique(authorization.evidenceIds)) !== JSON.stringify(expectedEvidenceIds)) return null;
	const frontierIds = new Set(input.frontier.map((entry) => entry.candidateId));
	if (
		new Set(authorization.selectedFrontierEntryIds).size !== authorization.selectedFrontierEntryIds.length ||
		authorization.selectedFrontierEntryIds.some((entry) => !frontierIds.has(entry)) ||
		JSON.stringify(sortedUnique(authorization.selectedFrontierEntryIds)) !==
			JSON.stringify(sortedUnique(input.selectedFrontierEntryIds))
	)
		return null;
	const receipt = authorization.receipt;
	if (!isWorkflowVerifiedHostReceipt(receipt)) return null;
	if (receipt.receiptKind !== "capability" || receipt.oneUse !== true) return null;
	const expectedBindingDigest = tradeoffBindingDigest(input, authorization);
	if (!(await validUserAuthority(input, authorization.userAuthority, "tradeoff", expectedBindingDigest))) return null;
	if (receipt.bindingDigest !== expectedBindingDigest) return null;
	if (await receiptAlreadyConsumed(input, receipt, expectedBindingDigest)) return null;
	try {
		const verifiedReceipt = await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest,
			receipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: input.trustedNow,
		});
		const principal = await verifyPrincipalCapability(
			input,
			verifiedReceipt,
			expectedBindingDigest,
			contractDigest(input.contract),
			expectedBindingDigest,
		);
		return principal === null
			? null
			: {
					receipt: verifiedReceipt,
					bindingDigest: expectedBindingDigest,
					authorizationDigest: principal.authorizationDigest,
					userAuthorityDigest: authorization.userAuthority.authorityDigest,
				};
	} catch {
		return null;
	}
}

function preregistrationObservationHeadDigest(input: AutoResearchPortfolioAdmissionInput): string {
	return digestObject({
		kind: "portfolio.preregistration-head.v1",
		contractDigest: contractDigest(input.contract),
		candidateId: input.candidate.candidateId,
		historyDigest: candidateHistoryDigest(input.candidateHistory.candidates),
		frontierCandidateIds: sortedUnique(input.frontier.map((entry) => entry.candidateId)),
		evaluationEpoch: input.contract.inputManifest.evaluationEpoch,
		manifestRevision: input.contract.inputManifest.manifestRevision,
		closureRootDigest: input.contract.inputManifest.closureRootDigest,
	});
}

function preregistrationBindingDigest(
	input: AutoResearchPortfolioAdmissionInput,
	preregistration: AutoResearchPortfolioPreregistration,
): string {
	return evidenceBindingDigest("portfolio.preregistration.v1", input.contract, {
		candidateId: preregistration.candidateId,
		metricIds: sortedUnique(preregistration.metricIds),
		evaluationEpoch: preregistration.evaluationEpoch,
		observationHeadDigest: preregistration.observationHeadDigest,
		registeredAt: preregistration.registeredAt,
	});
}

function contractPostHocMetricIds(
	contract: AutoResearchPortfolioContract,
	closure: AutoResearchPortfolioImpactClosure,
): readonly string[] {
	return sortedUnique(
		contract.goals
			.flatMap((goal) => goal.metrics.map((metric) => metric.metricId))
			.filter((metricId) => !closure.metricIds.includes(metricId)),
	);
}

async function validPreregistration(
	input: AutoResearchPortfolioAdmissionInput,
	postHocMetricIds: readonly string[],
	contractPostHocIds: readonly string[],
): Promise<VerifiedPreregistration | null> {
	const preregistration = input.preregistration;
	if (
		preregistration === undefined ||
		preregistration === null ||
		typeof preregistration !== "object" ||
		!hasExactKeys(preregistration, [
			"candidateId",
			"metricIds",
			"evaluationEpoch",
			"observationHeadDigest",
			"registeredAt",
			"userAuthority",
			"receipt",
		])
	)
		return null;
	if (!isStringArray(preregistration.metricIds)) return null;
	if (!isCanonicalStringArray(preregistration.metricIds)) return null;
	if (preregistration.candidateId !== input.candidate.candidateId) return null;
	if (preregistration.evaluationEpoch !== input.contract.inputManifest.evaluationEpoch) return null;
	if (new Set(preregistration.metricIds).size !== preregistration.metricIds.length) return null;
	if (
		JSON.stringify(preregistration.metricIds) !== JSON.stringify(contractPostHocIds) ||
		JSON.stringify(sortedUnique(postHocMetricIds)) !== JSON.stringify(contractPostHocIds)
	)
		return null;
	if (preregistration.observationHeadDigest !== preregistrationObservationHeadDigest(input)) return null;
	const registeredAt = Date.parse(preregistration.registeredAt);
	const trustedNow = Date.parse(input.trustedNow);
	if (!Number.isFinite(registeredAt) || !Number.isFinite(trustedNow) || registeredAt > trustedNow) return null;
	const candidateRowsForPreregistration = candidateRows(input.candidate, input.measurements);
	if (candidateRowsForPreregistration.length === 0) return null;
	const candidateMeasurementIds = new Set(candidateRowsForPreregistration.map((row) => row.measurementId));
	const candidateRunReceiptTimes = input.measurementEvidence
		.filter((entry) => candidateMeasurementIds.has(entry.measurementId))
		.flatMap((entry) => entry.runs)
		.map((run) => Date.parse(run.receipt.issuedAt));
	const firstMeasurementReceiptIssuedAt = Math.min(...candidateRunReceiptTimes);
	if (!Number.isFinite(firstMeasurementReceiptIssuedAt) || registeredAt >= firstMeasurementReceiptIssuedAt)
		return null;
	const receipt = preregistration.receipt;
	if (!isWorkflowVerifiedHostReceipt(receipt)) return null;
	if (receipt.receiptKind !== "capability" || receipt.oneUse !== true) return null;
	const expectedBindingDigest = preregistrationBindingDigest(input, preregistration);
	if (!(await validUserAuthority(input, preregistration.userAuthority, "preregistration", expectedBindingDigest)))
		return null;
	if (
		receipt.bindingDigest !== expectedBindingDigest ||
		receipt.payloadDigest !== preregistration.observationHeadDigest
	)
		return null;
	if (await receiptAlreadyConsumed(input, receipt, expectedBindingDigest)) return null;
	try {
		const verifiedReceipt = await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest,
			receipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: input.trustedNow,
		});
		const principal = await verifyPrincipalCapability(
			input,
			verifiedReceipt,
			expectedBindingDigest,
			contractDigest(input.contract),
			expectedBindingDigest,
		);
		if (principal === null) return null;
		if (
			Date.parse(principal.validity.issuedAt) > registeredAt ||
			verifiedReceipt.stateDigest !== input.currentStateDigest ||
			verifiedReceipt.revision !== input.currentRevision
		)
			return null;
		return {
			receipt: verifiedReceipt,
			bindingDigest: expectedBindingDigest,
			authorizationDigest: principal.authorizationDigest,
			userAuthorityDigest: preregistration.userAuthority.authorityDigest,
		};
	} catch {
		return null;
	}
}

function frontierDigest(
	contract: AutoResearchPortfolioContract,
	closure: AutoResearchPortfolioImpactClosure,
	frontier: readonly AutoResearchPortfolioCandidate[],
	measurements: readonly AutoResearchPortfolioMeasurement[],
	selectedFrontierEntryIds: readonly string[],
): string {
	const frontierIds = sortedUnique(frontier.map((entry) => entry.candidateId));
	const frontierEntries = frontier
		.map((entry) => ({
			candidate: entry,
			candidateReviewBindingDigest: candidateReviewBindingDigest(entry),
		}))
		.sort((left, right) => left.candidateReviewBindingDigest.localeCompare(right.candidateReviewBindingDigest));
	const rows = measurements
		.filter((measurement) => measurement.candidateId !== null && frontierIds.includes(measurement.candidateId))
		.map((measurement) => ({
			...measurement,
			vector: [...measurement.vector].sort((left, right) => left.metricId.localeCompare(right.metricId)),
		}))
		.sort(
			(left, right) =>
				(left.candidateId ?? "").localeCompare(right.candidateId ?? "") ||
				left.measurementId.localeCompare(right.measurementId) ||
				left.repeatIndex - right.repeatIndex ||
				digestObject(left).localeCompare(digestObject(right)),
		);
	return digestObject({
		contractDigest: contractDigest(contract),
		closure,
		frontierIds,
		selectedFrontierEntryIds: sortedUnique(selectedFrontierEntryIds),
		frontierEntries,
		rows,
	});
}

function frontierIdentityDigest(
	contract: AutoResearchPortfolioContract,
	closure: AutoResearchPortfolioImpactClosure,
	frontier: readonly AutoResearchPortfolioCandidate[],
): string {
	return digestObject({
		contractDigest: contractDigest(contract),
		closure,
		frontierEntries: frontier
			.map((entry) => ({
				candidateId: entry.candidateId,
				candidate: entry,
				candidateReviewBindingDigest: candidateReviewBindingDigest(entry),
			}))
			.sort((left, right) => left.candidateReviewBindingDigest.localeCompare(right.candidateReviewBindingDigest)),
	});
}

function safeImpactClosure(
	contract: AutoResearchPortfolioContract,
	candidate: AutoResearchPortfolioCandidate,
): AutoResearchPortfolioImpactClosure {
	try {
		return deriveAutoResearchPortfolioImpactClosure(contract, candidate);
	} catch {
		return emptyImpactClosure(contract, candidate);
	}
}

function safeFrontierIdentityDigest(
	contract: AutoResearchPortfolioContract,
	closure: AutoResearchPortfolioImpactClosure,
	frontier: readonly AutoResearchPortfolioCandidate[],
): string {
	try {
		return frontierIdentityDigest(contract, closure, frontier);
	} catch {
		return digestObject({ invalid: true, closureDigest: closure.closureDigest });
	}
}

function measurementEvidenceDigest(input: AutoResearchPortfolioAdmissionInput): string {
	return digestObject(
		input.measurementEvidence
			.map((entry) => ({
				measurementId: entry.measurementId,
				runs: entry.runs
					.map((run) => ({
						runIndex: run.runIndex,
						artifactRef: run.artifactRef,
						seedDigest: run.seedDigest,
						contentDigest: run.contentDigest,
						receiptId: run.receipt.receiptId,
						bindingDigest: run.receipt.bindingDigest,
						receiptDigest: digestObject(run.receipt),
					}))
					.sort((left, right) => left.runIndex - right.runIndex),
			}))
			.sort((left, right) => left.measurementId.localeCompare(right.measurementId)),
	);
}

function admissionEvidenceDigest(
	input: AutoResearchPortfolioAdmissionInput,
	closure: AutoResearchPortfolioImpactClosure,
	frontierDigestValue: string,
	measurementEvidenceDigestValue: string,
	consumptionWitnesses: readonly {
		readonly receiptId: string;
		readonly bindingDigest: string;
		readonly receiptDigest: string;
		readonly consumptionSequence: number;
		readonly consumedAt: string;
	}[],
): string {
	return digestObject({
		kind: "portfolio.frontier.admission.v2",
		contractDigest: contractDigest(input.contract),
		candidateId: input.candidate.candidateId,
		candidateReviewDigest: candidateReviewBindingDigest(input.candidate),
		preflightDigest: input.preflight.preflightDigest,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		currentEpochRef: input.currentEpochRef,
		closure,
		frontierDigest: frontierDigestValue,
		selectedFrontierEntryIds: sortedUnique(input.selectedFrontierEntryIds),
		measurements: input.measurements
			.map((measurement) => ({
				measurementId: measurement.measurementId,
				candidateId: measurement.candidateId,
				measurementDigest: measurement.measurementDigest,
				measurementEpoch: measurement.evaluationEpoch,
			}))
			.sort((left, right) => left.measurementId.localeCompare(right.measurementId)),
		measurementEvidenceDigest: measurementEvidenceDigestValue,
		consumptionWitnesses,
		boundaryEvidence: input.boundaryEvidence
			.map((entry) => ({ boundaryId: entry.boundaryId, receiptDigest: digestObject(entry.receipt) }))
			.sort((left, right) => left.boundaryId.localeCompare(right.boundaryId)),
		invariantEvidence: input.invariantEvidence
			.map((entry) => ({ invariantId: entry.invariantId, receiptDigest: digestObject(entry.receipt) }))
			.sort((left, right) => left.invariantId.localeCompare(right.invariantId)),
		manifestEvidence: digestObject(input.manifestEvidence),
		candidateHistory: {
			historyDigest: input.candidateHistory.historyDigest,
			receiptDigest: digestObject(input.candidateHistory.receipt),
		},
		preregisteredFamilies: digestObject(input.preregisteredFamilies ?? []),
		tradeoffAuthorization:
			input.tradeoffAuthorization === undefined ? null : digestObject(input.tradeoffAuthorization),
		preregistration: input.preregistration === undefined ? null : digestObject(input.preregistration),
	});
}

function result(
	accepted: boolean,
	automaticPromotion: boolean,
	frontierMembership: AutoResearchPortfolioAdmissionResult["frontierMembership"],
	executorAllowed: boolean,
	exploratory: boolean,
	reasons: readonly string[],
	closure: AutoResearchPortfolioImpactClosure,
	frontierDigestValue: string,
	vector: readonly string[],
	retention: AutoResearchPortfolioAdmissionResult["retention"] = accepted
		? exploratory
			? "evidence_only_exploratory"
			: automaticPromotion
				? "frontier_promotable"
				: "evidence_only_tradeoff"
		: "rejected",
	admissionIntent?: AutoResearchPortfolioAdmissionIntent,
): AutoResearchPortfolioAdmissionResult {
	return {
		accepted,
		automaticPromotion,
		frontierMembership,
		executorAllowed,
		exploratory,
		retention,
		...(admissionIntent === undefined ? {} : { admissionIntent }),
		reasons: Object.freeze([...new Set(reasons)]),
		impactClosure: closure,
		frontierDigest: frontierDigestValue,
		vector: Object.freeze([...vector]),
	};
}

function preflightMatches(
	actual: AutoResearchPortfolioPreflightResult,
	expected: AutoResearchPortfolioPreflightResult,
): boolean {
	return (
		actual.preflightDigest === expected.preflightDigest &&
		actual.allowed === expected.allowed &&
		actual.reviewBindingDigest === expected.reviewBindingDigest &&
		actual.impactClosure.impactClosureDigest === expected.impactClosure.impactClosureDigest &&
		JSON.stringify(actual.reasons) === JSON.stringify(expected.reasons)
	);
}

/** Evaluate exact host measurements for Pareto and lexicographic frontier admission. */
export async function evaluateAutoResearchPortfolioAdmission(
	input: AutoResearchPortfolioAdmissionInput,
): Promise<AutoResearchPortfolioAdmissionResult> {
	let parsed: CanonicalAdmissionRecords;
	try {
		parsed = parseAdmissionRecords(input);
	} catch (error) {
		const closure = safeImpactClosure(input.contract, input.candidate);
		const reason = error instanceof Error ? error.message : "contract_not_canonical";
		return result(
			false,
			false,
			"none",
			false,
			false,
			[reason],
			closure,
			safeFrontierIdentityDigest(input.contract, closure, input.frontier),
			closure.metricIds,
		);
	}
	input = {
		...input,
		...parsed,
		manifestEvidence: cloneForCanonicalParsing(input.manifestEvidence) as AutoResearchPortfolioManifestEvidence,
		measurementEvidence: cloneForCanonicalParsing(
			input.measurementEvidence,
		) as readonly AutoResearchPortfolioMeasurementEvidence[],
		preregisteredFamilies:
			input.preregisteredFamilies === undefined
				? undefined
				: (cloneForCanonicalParsing(
						input.preregisteredFamilies,
					) as readonly AutoResearchPortfolioMechanismFamilyRegistration[]),
	};
	const expectedPreflight = preflightAutoResearchPortfolioCandidate({
		contract: input.contract,
		candidate: input.candidate,
		priorCandidates: input.candidateHistory.candidates,
		preregisteredFamilies: input.preregisteredFamilies,
	});
	const closure = expectedPreflight.impactClosure;
	let frontierDigestValue = frontierIdentityDigest(input.contract, closure, input.frontier);
	let vector: readonly string[] = closure.metricIds;
	const reject = (reason: string): AutoResearchPortfolioAdmissionResult =>
		result(false, false, "none", false, false, [reason], closure, frontierDigestValue, vector);
	if (
		typeof input.receiptContext !== "object" ||
		input.receiptContext === null ||
		typeof input.receiptContext.principalAuthorizer?.authorize !== "function"
	)
		return reject("host_authorizer_unavailable");
	if (input.preflight === undefined || !preflightMatches(input.preflight, expectedPreflight))
		return reject("preflight_digest_mismatch");
	if (!expectedPreflight.allowed)
		return result(
			false,
			false,
			"none",
			false,
			false,
			expectedPreflight.reasons.length > 0 ? expectedPreflight.reasons : ["preflight_rejected"],
			closure,
			frontierDigestValue,
			vector,
		);
	if (input.contract.schemaVersion !== 3) return reject("schema_version_mismatch");
	if (input.contract.terminalScope !== "terminal" || input.contract.learningScope !== "learning")
		return reject("scope_violation");
	if (
		input.contract.safety.locked !== true ||
		input.contract.safety.network !== "disabled" ||
		input.contract.safety.externalEffects !== "none" ||
		input.contract.safety.requireOpaqueHoldout !== true ||
		input.contract.safety.requireAdversarialReview !== true
	)
		return reject("safety_boundary_invalid");
	if (input.candidate.scope !== "terminal") return reject("scope_violation");
	if (
		input.candidate.goalIds.length === 0 ||
		input.candidate.goalIds.some((goalId) => !input.contract.goals.some((goal) => goal.goalId === goalId))
	)
		return reject("candidate_goal_invalid");
	if (relationContradiction(input.contract)) return reject("contradictory_goal_relations");
	if (
		input.candidateHistory.candidates.some(
			(entry) =>
				entry.scope !== "terminal" ||
				entry.goalIds.length === 0 ||
				entry.goalIds.some((goalId) => !input.contract.goals.some((goal) => goal.goalId === goalId)),
		)
	)
		return reject("history_candidate_scope_invalid");
	const boundary = await boundaryReason(input);
	if (boundary !== null) return reject(boundary);
	const invariant = await invariantReason(input);
	if (invariant !== null) return reject(invariant);
	const history = await historyReason(input);
	if (history !== null) return reject(history);
	const manifest = manifestReason(input.contract);
	if (manifest !== null) return reject(manifest);
	const manifestEvidence = await manifestEvidenceReason(input);
	if (manifestEvidence !== null) return reject(manifestEvidence);
	const goalManifest = goalManifestReason(input.contract);
	if (goalManifest !== null) return reject(goalManifest);
	const mechanismFamily = await mechanismFamilyReason(input);
	if (mechanismFamily !== null) return reject(mechanismFamily);
	const partitionReason = partitionAuthorityReason(input.contract, input.candidate);
	if (partitionReason !== null) return reject(partitionReason);
	if (new Set(input.frontier.map((entry) => entry.candidateId)).size !== input.frontier.length)
		return reject("frontier_invalid");
	if (input.frontier.some((entry) => entry.candidateId === input.candidate.candidateId))
		return reject("frontier_invalid");
	if (
		input.frontier.some(
			(entry) =>
				entry.scope !== "terminal" ||
				entry.goalIds.length === 0 ||
				entry.goalIds.some((goalId) => !input.contract.goals.some((goal) => goal.goalId === goalId)),
		)
	)
		return reject("frontier_candidate_scope_invalid");
	if (
		!isStringArray(input.selectedFrontierEntryIds) ||
		!isCanonicalStringArray(input.selectedFrontierEntryIds) ||
		new Set(input.selectedFrontierEntryIds).size !== input.selectedFrontierEntryIds.length ||
		JSON.stringify(sortedUnique(input.selectedFrontierEntryIds)) !==
			JSON.stringify(sortedUnique(input.frontier.map((entry) => entry.candidateId)))
	)
		return reject("frontier_selection_mismatch");
	for (const frontierEntry of input.frontier) {
		const frontierClosure = deriveAutoResearchPortfolioImpactClosure(input.contract, frontierEntry);
		if (!sameImpactClosureShape(frontierClosure, closure)) return reject("frontier_closure_mismatch");
	}
	const specs = metricSpecs(input.contract, closure);
	vector = specs.map((spec) => spec.metricId);
	const knownCandidateIds = new Set([
		input.candidate.candidateId,
		...input.frontier.map((entry) => entry.candidateId),
	]);
	const measurement = measurementReason(input.contract, input.measurements, knownCandidateIds, input.trustedNow);
	if (measurement !== null) return reject(measurement);
	const measurementEvidence = await measurementEvidenceReason(input, input.measurements);
	if (measurementEvidence !== null) return reject(measurementEvidence);
	frontierDigestValue = frontierDigest(
		input.contract,
		closure,
		input.frontier,
		input.measurements,
		input.selectedFrontierEntryIds,
	);
	if (specs.length !== closure.metricIds.length) return reject("baseline_metric_omission");
	if (!hasCompleteRepeatSets(input.candidate, specs, input.measurements))
		return reject("candidate_measurement_stitching");
	const rows = candidateRows(input.candidate, input.measurements);
	const observations = new Map<string, MetricObservation>();
	for (const spec of specs) {
		const aggregate = aggregateMetric(rows, spec);
		if (aggregate.duplicate) return reject("duplicate_metric_measurement");
		if (aggregate.aggregationInvalid) return reject("host_measurement_repeatability_invalid");
		if (aggregate.observation === null) return reject("candidate_metric_omission");
		if (aggregate.intervalInvalid) return reject("host_measurement_uncertainty_invalid");
		if (aggregate.observation.repeats < spec.minimumRepeats) return reject("repeatability_insufficient");
		if (aggregate.observation.variance > spec.maxVariance) return reject("variance_exceeds_limit");
		if (aggregate.observation.interval.upper - aggregate.observation.interval.lower > spec.maxIntervalWidth)
			return reject("host_measurement_uncertainty_invalid");
		observations.set(spec.metricId, aggregate.observation);
	}
	const postHocMetricIds = sortedUnique(
		[...new Set(rows.flatMap((row) => row.vector.map((entry) => entry.metricId)))].filter(
			(metricId) => !closure.metricIds.includes(metricId),
		),
	);
	const contractPostHocIds = contractPostHocMetricIds(input.contract, closure);
	const verifiedPreregistration =
		postHocMetricIds.length > 0 ? await validPreregistration(input, postHocMetricIds, contractPostHocIds) : null;
	const exploratory = postHocMetricIds.length > 0 && verifiedPreregistration === null;
	const baselineIntervals = new Map(specs.map((spec) => [spec.metricId, spec.baseline]));
	const baselineReference: ReferenceVector = { intervals: baselineIntervals };
	const frontierReferences = frontierReferenceVectors(
		input.contract,
		specs,
		input.frontier,
		input.measurements,
		closure,
	);
	if (frontierReferences.length !== input.frontier.length) return reject("frontier_measurement_incomplete");
	const references = [baselineReference, ...frontierReferences];
	const comparisonsByReference = references.map((reference) =>
		specs.map((spec) =>
			compareMetric(
				spec,
				observations.get(spec.metricId)!,
				reference.intervals.get(spec.metricId)!,
				references.indexOf(reference) === 0 ? "baseline" : "frontier",
			),
		),
	);
	const frontierComparisons = comparisonsByReference.slice(1);
	const allComparisons = comparisonsByReference.flat();
	const dominates = (comparisons: readonly MetricComparison[]): boolean =>
		comparisons.length === specs.length &&
		comparisons.some((comparison) => comparison.strictImprovement) &&
		comparisons.every((comparison) => !comparison.regression && !comparison.intervalNotSeparated);
	const dominatesBaseline = dominates(comparisonsByReference[0]);
	const dominatesFrontier = frontierComparisons.some((comparisons) => dominates(comparisons));
	const dominatedByFrontier = frontierComparisons.some(
		(comparisons) =>
			comparisons.length === specs.length &&
			comparisons.some((comparison) => comparison.regression) &&
			comparisons.every(
				(comparison) =>
					comparison.regression || (!comparison.strictImprovement && !comparison.intervalNotSeparated),
			),
	);
	const strict = allComparisons.filter((comparison) => comparison.strictImprovement);
	const regressions = allComparisons.filter((comparison) => comparison.regression);
	const lexicographicRegression = comparisonsByReference.some((comparisons) => {
		const strictComparisons = comparisons.filter((comparison) => comparison.strictImprovement);
		const highestStrictTier =
			strictComparisons.length === 0
				? Number.POSITIVE_INFINITY
				: Math.min(...strictComparisons.map((entry) => entry.metric.tier));
		return (
			strictComparisons.length > 0 &&
			comparisons.some((comparison) => comparison.regression && comparison.metric.tier <= highestStrictTier)
		);
	});
	if (lexicographicRegression) return reject("lexicographic_regression");
	const competingGoalSet = new Set(closure.competingGoalIds);
	const dependentGoalSet = new Set(closure.dependentGoalIds);
	const conflictGoalSet = new Set(closure.conflictRelatedGoalIds);
	const competingRegressions = regressions.filter((comparison) => competingGoalSet.has(comparison.metric.goalId));
	if (regressions.some((comparison) => conflictGoalSet.has(comparison.metric.goalId)))
		return reject("conflict_regression");
	if (regressions.some((comparison) => dependentGoalSet.has(comparison.metric.goalId)))
		return reject("dependent_regression");
	if (
		regressions.some(
			(comparison) =>
				!competingGoalSet.has(comparison.metric.goalId) &&
				!dependentGoalSet.has(comparison.metric.goalId) &&
				!conflictGoalSet.has(comparison.metric.goalId),
		)
	)
		return reject("unrelated_regression");
	if (dominatedByFrontier) return reject("dominated_by_frontier");
	let verifiedTradeoff: VerifiedTradeoffAuthorization | null = null;
	if (competingRegressions.length > 0) {
		verifiedTradeoff = await validTradeoffAuthorization(
			input,
			sortedUnique(competingRegressions.map((comparison) => comparison.metric.goalId)),
			observations,
		);
		if (verifiedTradeoff === null)
			return reject(input.tradeoffAuthorization === undefined ? "unsigned_tradeoff" : "needs_authority");
	}
	const authorizedTradeoff = verifiedTradeoff !== null;
	if (allComparisons.some((comparison) => comparison.intervalNotSeparated)) return reject("interval_not_separated");
	if (strict.length === 0) return reject("no_dominance");
	if (frontierComparisons.length > 0 && !dominatesFrontier && !authorizedTradeoff) {
		const incomparable = frontierComparisons.some(
			(comparisons) =>
				comparisons.some((comparison) => comparison.strictImprovement) &&
				comparisons.some((comparison) => comparison.regression),
		);
		if (!incomparable) return reject("no_dominance");
	}
	const reasons: string[] = [];
	if (postHocMetricIds.length > 0) reasons.push("posthoc_cross_goal_gain");
	if (authorizedTradeoff) reasons.push("authorized_tradeoff_exploration");
	if (regressions.length > 0 && !authorizedTradeoff) reasons.push("incomparable_frontier_candidate");
	const automaticPromotion =
		(dominatesFrontier || (input.frontier.length === 0 && dominatesBaseline)) && !exploratory && !authorizedTradeoff;
	const admissionReceipts = [
		...(verifiedTradeoff === null
			? []
			: [{ receipt: verifiedTradeoff.receipt, bindingDigest: verifiedTradeoff.bindingDigest }]),
		...(verifiedPreregistration === null
			? []
			: [{ receipt: verifiedPreregistration.receipt, bindingDigest: verifiedPreregistration.bindingDigest }]),
	].sort((left, right) => left.receipt.receiptId.localeCompare(right.receipt.receiptId));
	if (admissionReceipts.length > 1) return reject("admission_commit_requires_atomic_host");
	const consumptionWitnesses: Array<{
		readonly receiptId: string;
		readonly bindingDigest: string;
		readonly receiptDigest: string;
		readonly consumptionSequence: number;
		readonly consumedAt: string;
	}> = [];
	for (const admissionReceipt of admissionReceipts) {
		const witness = await consumeAdmissionReceipt(input, admissionReceipt.receipt, admissionReceipt.bindingDigest);
		if (witness === null) return reject("admission_commit_failed");
		consumptionWitnesses.push({
			receiptId: witness.receiptId,
			bindingDigest: witness.bindingDigest,
			receiptDigest: witness.receiptDigest,
			consumptionSequence: witness.consumptionSequence,
			consumedAt: witness.consumedAt,
		});
	}
	consumptionWitnesses.sort((left, right) => left.receiptId.localeCompare(right.receiptId));
	const measurementEvidenceDigestValue = measurementEvidenceDigest(input);
	const admissionDigest = admissionEvidenceDigest(
		input,
		closure,
		frontierDigestValue,
		measurementEvidenceDigestValue,
		consumptionWitnesses,
	);
	const admissionIntent: AutoResearchPortfolioAdmissionIntent = Object.freeze({
		kind: "autoresearch_portfolio_frontier_admission",
		productionOrphaned: true,
		candidateId: input.candidate.candidateId,
		frontierDigest: frontierDigestValue,
		receiptCommitments: Object.freeze(
			[
				...(verifiedTradeoff === null
					? []
					: [
							{
								receiptId: verifiedTradeoff.receipt.receiptId,
								bindingDigest: verifiedTradeoff.bindingDigest,
								authorizationDigest: verifiedTradeoff.authorizationDigest,
								userAuthorityDigest: verifiedTradeoff.userAuthorityDigest,
							},
						]),
				...(verifiedPreregistration === null
					? []
					: [
							{
								receiptId: verifiedPreregistration.receipt.receiptId,
								bindingDigest: verifiedPreregistration.bindingDigest,
								authorizationDigest: verifiedPreregistration.authorizationDigest,
								userAuthorityDigest: verifiedPreregistration.userAuthorityDigest,
							},
						]),
			].sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
		),
		runReceiptCommitments: Object.freeze(
			input.measurementEvidence
				.flatMap((entry) =>
					entry.runs.map((run) => ({
						measurementId: entry.measurementId,
						runIndex: run.runIndex,
						receiptId: run.receipt.receiptId,
						bindingDigest: run.receipt.bindingDigest,
						receiptDigest: digestObject(run.receipt),
					})),
				)
				.sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
		),
		consumptionWitnesses: Object.freeze(consumptionWitnesses),
		candidateReviewDigest: candidateReviewBindingDigest(input.candidate),
		preflightDigest: input.preflight.preflightDigest,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		currentEpochRef: input.currentEpochRef,
		measurementEvidenceDigest: measurementEvidenceDigestValue,
		admissionDigest,
	});
	return result(
		true,
		automaticPromotion,
		exploratory || authorizedTradeoff ? "none" : "retained",
		automaticPromotion,
		exploratory,
		reasons,
		closure,
		frontierDigestValue,
		vector,
		exploratory ? "evidence_only_exploratory" : authorizedTradeoff ? "evidence_only_tradeoff" : "frontier_promotable",
		admissionIntent,
	);
}
