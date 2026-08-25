import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const AUTORESEARCH_SKILL_NAME = "autoresearch";
export const AUTORESEARCH_STATE_VERSION = 2;

const FIELD_MAP_KINDS = [
	"assumptions",
	"limitations",
	"contradictions",
	"methods_and_evaluations",
	"closest_prior_work",
] as const;
const CLAIM_TYPES = [
	"FIELD_PRACTICE",
	"SHARED_ASSUMPTION",
	"KNOWN_LIMITATION",
	"CONTRADICTION",
	"PRIOR_ART",
	"EMPIRICAL_OBSERVATION",
	"MECHANISTIC_HYPOTHESIS",
	"FEASIBILITY_CONSTRAINT",
] as const;
const SOURCE_TYPES = ["publication", "experiment", "dataset", "code", "web"] as const;
const PUBLICATION_STATUSES = ["peer_reviewed", "preprint", "published_status_unclear"] as const;
const CYCLE_OUTCOMES = ["rejected", "revised", "survived", "experiment_failed", "promoted"] as const;
const REVIEWER_ROLES = ["literature_auditor", "prior_art_killer", "experimental_critic", "top_tier_editor"] as const;
const REVIEWER_VERDICTS = ["pass", "revise", "reject"] as const;
const SUPERVISOR_STATUSES = ["progressing", "watch", "intervene"] as const;
const MEMORY_TYPES = [
	"PAPER_FINDING",
	"ASSUMPTION",
	"CONTRADICTION",
	"NOVELTY_COLLISION",
	"FAILED_DIRECTION",
	"EXPERIMENT_RESULT",
	"OPEN_QUESTION",
	"REVIEWER_OBJECTION",
	"SUPERVISOR_INTERVENTION",
	"USEFUL_SEARCH_QUERY",
] as const;
const EXPERIMENT_STATUSES = ["planned", "running", "failed", "completed"] as const;
const REUSE_STATUSES = ["proposed", "verified", "rejected"] as const;

export type AutoresearchFieldMapKind = (typeof FIELD_MAP_KINDS)[number];
export type AutoresearchClaimType = (typeof CLAIM_TYPES)[number];
export type AutoresearchSourceType = (typeof SOURCE_TYPES)[number];
export type AutoresearchPublicationStatus = (typeof PUBLICATION_STATUSES)[number];
export type AutoresearchCycleOutcome = (typeof CYCLE_OUTCOMES)[number];
export type AutoresearchReviewerRole = (typeof REVIEWER_ROLES)[number];
export type AutoresearchReviewerVerdict = (typeof REVIEWER_VERDICTS)[number];
export type AutoresearchSupervisorStatus = (typeof SUPERVISOR_STATUSES)[number];
export type AutoresearchMemoryType = (typeof MEMORY_TYPES)[number];
export type AutoresearchExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export type AutoresearchReuseStatus = (typeof REUSE_STATUSES)[number];

export interface AutoresearchPublication {
	paperId: string;
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
	doi?: string;
	publicationStatus: AutoresearchPublicationStatus;
	preprintId?: string;
	fullTextUrl?: string;
	metadataVerifiedBy?: string[];
	lastVerifiedAt: string;
}

export interface AutoresearchEvidenceBinding {
	sourceType: AutoresearchSourceType;
	sourceId: string;
	exactPointer: string;
	demonstrates: string;
	interpretation: string;
}

export interface AutoresearchClaim {
	claimId: string;
	claimText: string;
	claimType: AutoresearchClaimType;
	status: "proposed" | "canonical" | "contested" | "rejected";
	supportingEvidence: AutoresearchEvidenceBinding[];
	contradictingEvidence: AutoresearchEvidenceBinding[];
	confidence: "low" | "medium" | "high";
	unresolvedObjections: string[];
	createdAt: string;
	lastVerifiedAt?: string;
}

export interface AutoresearchClaimUpdate {
	supportingEvidence: AutoresearchEvidenceBinding[];
	contradictingEvidence: AutoresearchEvidenceBinding[];
	confidence?: "low" | "medium" | "high";
	unresolvedObjections: string[];
}

export interface AutoresearchCandidate {
	candidateId: string;
	statement: string;
	motivation: string;
	mechanisticMotivation: string;
	closestPriorArt: string;
	unresolvedQuestions: string[];
	falsifier: string;
	experimentDesign: string;
	baselinePlan: string;
	broaderRelevance: string;
	requirements: string[];
}

export interface AutoresearchReviewerResult {
	role: AutoresearchReviewerRole;
	verdict: AutoresearchReviewerVerdict;
	summary: string;
	objections: string[];
}

export interface AutoresearchProblemGates {
	important: boolean;
	unresolved: boolean;
	publicationBacked: boolean;
	mechanisticallyMotivated: boolean;
	falsifiable: boolean;
	feasible: boolean;
	closestPriorWorkAnalyzed: boolean;
	broaderRelevance: boolean;
}

export interface AutoresearchSearchCoverage {
	mechanismQueries: boolean;
	synonymsAndAdjacent: boolean;
	backwardReferences: boolean;
	forwardCitations: boolean;
	relatedRecommendations: boolean;
	recent12To24Months: boolean;
	recentPreprints: boolean;
	surveysOrReviews: boolean;
}

export interface AutoresearchExperiment {
	experimentId: string;
	candidateId: string;
	hypothesis: string;
	design: string;
	baselines: string[];
	dataRequirements: string[];
	codeRequirements: string[];
	computeRequirements: string[];
	artifactPaths: string[];
	metrics: Record<string, number | string | boolean>;
	results?: string;
	interpretation?: string;
	confounds: string[];
	status: AutoresearchExperimentStatus;
	createdAt: string;
	updatedAt: string;
}

export interface AutoresearchMemory {
	memoryId: string;
	type: AutoresearchMemoryType;
	title: string;
	content: string;
	tags: string[];
	importance: number;
	sourceIds: string[];
	currentStateReferences: string[];
	createdAt: string;
	lastVerifiedAt?: string;
	invalidatedAt?: string;
}

export interface AutoresearchMemoryReusePlan {
	reuseId: string;
	query: string;
	memoryIds: string[];
	currentStateBindings: string[];
	applicabilityConditions: string[];
	reusableProcedure: string;
	verificationRequirements: string[];
	status: AutoresearchReuseStatus;
	verificationEvidence: string[];
	createdAt: string;
	verifiedAt?: string;
}

export interface AutoresearchCollectedReview {
	messageId: string;
	candidateId: string;
	recordedAt: string;
	reviewer: AutoresearchReviewerResult;
}

export interface AutoresearchStopGate {
	passed: boolean;
	candidateId?: string;
	checks: {
		promotedCandidate: boolean;
		clearProblemStatement: boolean;
		multipleRealPublications: boolean;
		latestPreprintCheck: boolean;
		strongClosestPriorWorkComparison: boolean;
		mechanisticExplanation: boolean;
		falsifiableHypothesis: boolean;
		feasibleExperiment: boolean;
		preliminaryEvidence: boolean;
		strongBaselinePlan: boolean;
		broaderRelevance: boolean;
		fourReviewSurvival: boolean;
		supervisorProgressing: boolean;
	};
	reasons: string[];
}

export interface AutoresearchCycle {
	cycleId: string;
	completedAt: string;
	candidate: AutoresearchCandidate;
	outcome: AutoresearchCycleOutcome;
	rejectionReason?: string;
	priorArtCluster?: string;
	explicitStuck: boolean;
	trajectoryFingerprint?: string;
	papersAdded: number;
	paperIds: string[];
	fieldMapChanged: boolean;
	reviewers: AutoresearchReviewerResult[];
	gates: AutoresearchProblemGates;
	searchCoverage: AutoresearchSearchCoverage;
	motivationPaperIds: string[];
	closestPriorWorkPaperIds: string[];
	preliminaryEvidenceExperimentIds: string[];
	canonicalPromotionIds: string[];
}

export interface AutoresearchCheckpoint {
	status: AutoresearchSupervisorStatus;
	reason: string;
	detectedPattern: string;
	interventionNeeded: boolean;
	triggeredHeuristics: string[];
	progressIndicators: {
		cyclesSinceCanonicalProgress: number;
		repeatedRejectionCount: number;
		repeatedPriorArtCount: number;
		papersSinceFieldMapChange: number;
		repeatedTrajectoryCount: number;
	};
}

export interface AutoresearchSupervision {
	supervisionId: string;
	cycleId: string;
	recordedAt: string;
	status: AutoresearchSupervisorStatus;
	reason: string;
	detectedPattern: string;
	interventionNeeded: boolean;
	diagnosis?: string;
	failedSearchPattern?: string;
	assumptionToQuestion?: string;
	alternativeDirections: Array<{
		direction: string;
		whyDifferent: string;
		killSearch: string;
		falsifier: string;
		priority: number;
	}>;
}

export interface AutoresearchLineageEntry {
	lineageId: string;
	recordedAt: string;
	kind:
		| "initialized"
		| "claim_promoted"
		| "claim_revised"
		| "claim_invalidated"
		| "cycle_completed"
		| "supervisor_intervention"
		| "experiment_completed";
	summary: string;
	referenceId?: string;
}

export interface AutoresearchSupervisorRef {
	rlmChildId: string;
	name: string;
}

export interface AutoresearchState {
	schemaVersion: number;
	objective?: string;
	topic?: string;
	createdAt?: string;
	updatedAt: string;
	supervisor?: AutoresearchSupervisorRef;
	publications: AutoresearchPublication[];
	checkpointedPublicationKeys: string[];
	claims: AutoresearchClaim[];
	experiments: AutoresearchExperiment[];
	memories: AutoresearchMemory[];
	memoryReusePlans: AutoresearchMemoryReusePlan[];
	collectedReviews: AutoresearchCollectedReview[];
	ingestedAgentMessageIds: string[];
	fieldMaps: Record<AutoresearchFieldMapKind, string[]>;
	cycles: AutoresearchCycle[];
	supervision: AutoresearchSupervision[];
	lineage: AutoresearchLineageEntry[];
}

export interface AutoresearchCycleInput {
	candidate: AutoresearchCandidate;
	outcome: AutoresearchCycleOutcome;
	rejectionReason?: string;
	priorArtCluster?: string;
	explicitStuck: boolean;
	trajectoryFingerprint?: string;
	publications: AutoresearchPublication[];
	fieldMaps: Record<AutoresearchFieldMapKind, string[]>;
	reviewers: AutoresearchReviewerResult[];
	gates: AutoresearchProblemGates;
	searchCoverage: AutoresearchSearchCoverage;
	motivationPaperIds: string[];
	closestPriorWorkPaperIds: string[];
	preliminaryEvidenceExperimentIds: string[];
	canonicalPromotionIds: string[];
}

export interface AutoresearchCycleResult {
	cycle: AutoresearchCycle;
	checkpoint: AutoresearchCheckpoint;
	packet: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;

function emptyFieldMaps(): Record<AutoresearchFieldMapKind, string[]> {
	return {
		assumptions: [],
		limitations: [],
		contradictions: [],
		methods_and_evaluations: [],
		closest_prior_work: [],
	};
}

function emptyState(now: string): AutoresearchState {
	return {
		schemaVersion: AUTORESEARCH_STATE_VERSION,
		updatedAt: now,
		publications: [],
		checkpointedPublicationKeys: [],
		claims: [],
		experiments: [],
		memories: [],
		memoryReusePlans: [],
		collectedReviews: [],
		ingestedAgentMessageIds: [],
		fieldMaps: emptyFieldMaps(),
		cycles: [],
		supervision: [],
		lineage: [],
	};
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function requireIdentifier(value: unknown, label: string): string {
	const identifier = requireString(value, label);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identifier)) {
		throw new Error(`${label} must be a marker-safe identifier`);
	}
	return identifier;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireString(value, label);
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
	return value.map((item, index) => requireString(item, `${label}[${index}]`));
}

function optionalStringArray(value: unknown, label: string): string[] {
	return value === undefined ? [] : stringArray(value, label);
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
	return value;
}

function requireNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
	return value;
}

function scalarRecord(value: unknown, label: string): Record<string, number | string | boolean> {
	if (value === undefined) return {};
	const source = requireRecord(value, label);
	const result: Record<string, number | string | boolean> = {};
	for (const [key, item] of Object.entries(source)) {
		if (typeof item !== "number" && typeof item !== "string" && typeof item !== "boolean") {
			throw new Error(`${label}.${key} must be a number, string, or boolean`);
		}
		result[key] = item;
	}
	return result;
}

function enumValue<const Values extends readonly string[]>(
	value: unknown,
	values: Values,
	label: string,
): Values[number] {
	if (typeof value !== "string" || !values.includes(value)) {
		throw new Error(`${label} must be one of: ${values.join(", ")}`);
	}
	return value as Values[number];
}

function normalizeList(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		const key = trimmed.toLowerCase();
		if (!trimmed || seen.has(key)) continue;
		seen.add(key);
		result.push(trimmed);
	}
	return result;
}

function normalizeMapList(values: string[]): string[] {
	return normalizeList(values).sort((left, right) => left.localeCompare(right));
}

function normalizeFingerprint(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function sameNormalized(left: string | undefined, right: string | undefined): boolean {
	const a = normalizeFingerprint(left);
	const b = normalizeFingerprint(right);
	return !!a && a === b;
}

export function parseAutoresearchPublicationInput(
	value: unknown,
	now = new Date().toISOString(),
): AutoresearchPublication {
	const source = requireRecord(value, "publication");
	const year = source.year;
	if (year !== undefined && (!Number.isInteger(year) || (year as number) < 1000 || (year as number) > 9999)) {
		throw new Error("publication.year must be a four-digit integer when provided");
	}
	const publication: AutoresearchPublication = {
		paperId: requireString(source.paper_id ?? source.paperId, "publication.paper_id"),
		title: requireString(source.title, "publication.title"),
		authors: stringArray(source.authors, "publication.authors"),
		publicationStatus: enumValue(
			source.publication_status ?? source.publicationStatus,
			PUBLICATION_STATUSES,
			"publication.publication_status",
		),
		lastVerifiedAt:
			optionalString(source.last_verified_at ?? source.lastVerifiedAt, "publication.last_verified_at") ?? now,
	};
	if (publication.authors.length === 0) throw new Error("publication.authors must contain at least one author");
	if (year !== undefined) publication.year = year as number;
	const venue = optionalString(source.venue, "publication.venue");
	const doi = optionalString(source.doi, "publication.doi");
	const preprintId = optionalString(source.preprint_id ?? source.preprintId, "publication.preprint_id");
	const fullTextUrl = optionalString(source.full_text_url ?? source.fullTextUrl, "publication.full_text_url");
	const metadataVerifiedBy = optionalStringArray(
		source.metadata_verified_by ?? source.metadataVerifiedBy,
		"publication.metadata_verified_by",
	);
	if (venue) publication.venue = venue;
	if (doi) publication.doi = doi;
	if (preprintId) publication.preprintId = preprintId;
	if (fullTextUrl) publication.fullTextUrl = fullTextUrl;
	if (metadataVerifiedBy.length > 0) publication.metadataVerifiedBy = normalizeList(metadataVerifiedBy);
	if (!publication.doi && !publication.preprintId && !publication.fullTextUrl) {
		throw new Error("publication must include a DOI, preprint ID, or full-text URL");
	}
	return publication;
}

function parseEvidenceBinding(value: unknown, label: string): AutoresearchEvidenceBinding {
	const source = requireRecord(value, label);
	return {
		sourceType: enumValue(source.source_type ?? source.sourceType, SOURCE_TYPES, `${label}.source_type`),
		sourceId: requireString(source.source_id ?? source.sourceId, `${label}.source_id`),
		exactPointer: requireString(source.exact_pointer ?? source.exactPointer, `${label}.exact_pointer`),
		demonstrates: requireString(source.demonstrates, `${label}.demonstrates`),
		interpretation: requireString(source.interpretation, `${label}.interpretation`),
	};
}

function evidenceArray(value: unknown, label: string): AutoresearchEvidenceBinding[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((item, index) => parseEvidenceBinding(item, `${label}[${index}]`));
}

export function parseAutoresearchClaimInput(value: unknown, now = new Date().toISOString()): AutoresearchClaim {
	const source = requireRecord(value, "claim");
	return {
		claimId: optionalString(source.claim_id ?? source.claimId, "claim.claim_id") ?? `claim-${randomUUID()}`,
		claimText: requireString(source.claim_text ?? source.claimText, "claim.claim_text"),
		claimType: enumValue(source.claim_type ?? source.claimType, CLAIM_TYPES, "claim.claim_type"),
		status: "proposed",
		supportingEvidence: evidenceArray(
			source.supporting_evidence ?? source.supportingEvidence,
			"claim.supporting_evidence",
		),
		contradictingEvidence: evidenceArray(
			source.contradicting_evidence ?? source.contradictingEvidence,
			"claim.contradicting_evidence",
		),
		confidence: enumValue(source.confidence ?? "low", ["low", "medium", "high"] as const, "claim.confidence"),
		unresolvedObjections: optionalStringArray(
			source.unresolved_objections ?? source.unresolvedObjections,
			"claim.unresolved_objections",
		),
		createdAt: now,
	};
}

export function parseAutoresearchClaimUpdateInput(value: unknown): AutoresearchClaimUpdate {
	const source = requireRecord(value, "claim_update");
	const confidence =
		source.confidence === undefined
			? undefined
			: enumValue(source.confidence, ["low", "medium", "high"] as const, "claim_update.confidence");
	const update: AutoresearchClaimUpdate = {
		supportingEvidence: evidenceArray(
			source.supporting_evidence ?? source.supportingEvidence,
			"claim_update.supporting_evidence",
		),
		contradictingEvidence: evidenceArray(
			source.contradicting_evidence ?? source.contradictingEvidence,
			"claim_update.contradicting_evidence",
		),
		confidence,
		unresolvedObjections: optionalStringArray(
			source.unresolved_objections ?? source.unresolvedObjections,
			"claim_update.unresolved_objections",
		),
	};
	if (
		update.supportingEvidence.length === 0 &&
		update.contradictingEvidence.length === 0 &&
		update.unresolvedObjections.length === 0 &&
		update.confidence === undefined
	) {
		throw new Error("claim_update requires evidence, an objection, or confidence");
	}
	return update;
}

export function parseAutoresearchCandidateInput(value: unknown): AutoresearchCandidate {
	const source = requireRecord(value, "cycle.candidate");
	return {
		candidateId:
			source.candidate_id === undefined && source.candidateId === undefined
				? `candidate-${randomUUID()}`
				: requireIdentifier(source.candidate_id ?? source.candidateId, "cycle.candidate.candidate_id"),
		statement: requireString(source.statement, "cycle.candidate.statement"),
		motivation: requireString(source.motivation, "cycle.candidate.motivation"),
		mechanisticMotivation: requireString(
			source.mechanistic_motivation ?? source.mechanisticMotivation,
			"cycle.candidate.mechanistic_motivation",
		),
		closestPriorArt: requireString(
			source.closest_prior_art ?? source.closestPriorArt,
			"cycle.candidate.closest_prior_art",
		),
		unresolvedQuestions: stringArray(
			source.unresolved_questions ?? source.unresolvedQuestions,
			"cycle.candidate.unresolved_questions",
		),
		falsifier: requireString(source.falsifier, "cycle.candidate.falsifier"),
		experimentDesign: requireString(
			source.experiment_design ?? source.experimentDesign,
			"cycle.candidate.experiment_design",
		),
		baselinePlan: requireString(source.baseline_plan ?? source.baselinePlan, "cycle.candidate.baseline_plan"),
		broaderRelevance: requireString(
			source.broader_relevance ?? source.broaderRelevance,
			"cycle.candidate.broader_relevance",
		),
		requirements: optionalStringArray(source.requirements, "cycle.candidate.requirements"),
	};
}

function parseReviewer(value: unknown, index: number): AutoresearchReviewerResult {
	const source = requireRecord(value, `cycle.reviewers[${index}]`);
	return {
		role: enumValue(source.role, REVIEWER_ROLES, `cycle.reviewers[${index}].role`),
		verdict: enumValue(source.verdict, REVIEWER_VERDICTS, `cycle.reviewers[${index}].verdict`),
		summary: requireString(source.summary, `cycle.reviewers[${index}].summary`),
		objections: optionalStringArray(source.objections, `cycle.reviewers[${index}].objections`),
	};
}

function parseGates(value: unknown): AutoresearchProblemGates {
	const source = requireRecord(value, "cycle.gates");
	return {
		important: requireBoolean(source.important, "cycle.gates.important"),
		unresolved: requireBoolean(source.unresolved, "cycle.gates.unresolved"),
		publicationBacked: requireBoolean(
			source.publication_backed ?? source.publicationBacked,
			"cycle.gates.publication_backed",
		),
		mechanisticallyMotivated: requireBoolean(
			source.mechanistically_motivated ?? source.mechanisticallyMotivated,
			"cycle.gates.mechanistically_motivated",
		),
		falsifiable: requireBoolean(source.falsifiable, "cycle.gates.falsifiable"),
		feasible: requireBoolean(source.feasible, "cycle.gates.feasible"),
		closestPriorWorkAnalyzed: requireBoolean(
			source.closest_prior_work_analyzed ?? source.closestPriorWorkAnalyzed,
			"cycle.gates.closest_prior_work_analyzed",
		),
		broaderRelevance: requireBoolean(
			source.broader_relevance ?? source.broaderRelevance,
			"cycle.gates.broader_relevance",
		),
	};
}

function parseSearchCoverage(value: unknown): AutoresearchSearchCoverage {
	if (value === undefined) {
		return {
			mechanismQueries: false,
			synonymsAndAdjacent: false,
			backwardReferences: false,
			forwardCitations: false,
			relatedRecommendations: false,
			recent12To24Months: false,
			recentPreprints: false,
			surveysOrReviews: false,
		};
	}
	const source = requireRecord(value, "cycle.search_coverage");
	return {
		mechanismQueries: requireBoolean(
			source.mechanism_queries ?? source.mechanismQueries,
			"cycle.search_coverage.mechanism_queries",
		),
		synonymsAndAdjacent: requireBoolean(
			source.synonyms_and_adjacent ?? source.synonymsAndAdjacent,
			"cycle.search_coverage.synonyms_and_adjacent",
		),
		backwardReferences: requireBoolean(
			source.backward_references ?? source.backwardReferences,
			"cycle.search_coverage.backward_references",
		),
		forwardCitations: requireBoolean(
			source.forward_citations ?? source.forwardCitations,
			"cycle.search_coverage.forward_citations",
		),
		relatedRecommendations: requireBoolean(
			source.related_recommendations ?? source.relatedRecommendations,
			"cycle.search_coverage.related_recommendations",
		),
		recent12To24Months: requireBoolean(
			source.recent_12_to_24_months ?? source.recent12To24Months,
			"cycle.search_coverage.recent_12_to_24_months",
		),
		recentPreprints: requireBoolean(
			source.recent_preprints ?? source.recentPreprints,
			"cycle.search_coverage.recent_preprints",
		),
		surveysOrReviews: requireBoolean(
			source.surveys_or_reviews ?? source.surveysOrReviews,
			"cycle.search_coverage.surveys_or_reviews",
		),
	};
}

export function parseAutoresearchExperimentInput(
	value: unknown,
	now = new Date().toISOString(),
): AutoresearchExperiment {
	const source = requireRecord(value, "experiment");
	const status = enumValue(source.status ?? "planned", EXPERIMENT_STATUSES, "experiment.status");
	const experiment: AutoresearchExperiment = {
		experimentId:
			optionalString(source.experiment_id ?? source.experimentId, "experiment.experiment_id") ??
			`experiment-${randomUUID()}`,
		candidateId: requireIdentifier(source.candidate_id ?? source.candidateId, "experiment.candidate_id"),
		hypothesis: requireString(source.hypothesis, "experiment.hypothesis"),
		design: requireString(source.design, "experiment.design"),
		baselines: stringArray(source.baselines, "experiment.baselines"),
		dataRequirements: optionalStringArray(
			source.data_requirements ?? source.dataRequirements,
			"experiment.data_requirements",
		),
		codeRequirements: optionalStringArray(
			source.code_requirements ?? source.codeRequirements,
			"experiment.code_requirements",
		),
		computeRequirements: optionalStringArray(
			source.compute_requirements ?? source.computeRequirements,
			"experiment.compute_requirements",
		),
		artifactPaths: optionalStringArray(source.artifact_paths ?? source.artifactPaths, "experiment.artifact_paths"),
		metrics: scalarRecord(source.metrics, "experiment.metrics"),
		confounds: optionalStringArray(source.confounds, "experiment.confounds"),
		status,
		createdAt: optionalString(source.created_at ?? source.createdAt, "experiment.created_at") ?? now,
		updatedAt: now,
	};
	const results = optionalString(source.results, "experiment.results");
	const interpretation = optionalString(source.interpretation, "experiment.interpretation");
	if (results) experiment.results = results;
	if (interpretation) experiment.interpretation = interpretation;
	if (experiment.baselines.length === 0) throw new Error("experiment.baselines must not be empty");
	if (status === "completed" && (!results || !interpretation || experiment.artifactPaths.length === 0)) {
		throw new Error("a completed experiment requires results, interpretation, and artifact_paths");
	}
	if (status === "failed" && !results) throw new Error("a failed experiment requires results explaining the failure");
	return experiment;
}

export function parseAutoresearchMemoryInput(value: unknown, now = new Date().toISOString()): AutoresearchMemory {
	const source = requireRecord(value, "memory");
	const importance = requireNumber(source.importance ?? 5, "memory.importance");
	if (importance < 0 || importance > 10) throw new Error("memory.importance must be between 0 and 10");
	return {
		memoryId: optionalString(source.memory_id ?? source.memoryId, "memory.memory_id") ?? `memory-${randomUUID()}`,
		type: enumValue(source.type, MEMORY_TYPES, "memory.type"),
		title: requireString(source.title, "memory.title"),
		content: requireString(source.content, "memory.content"),
		tags: normalizeList(optionalStringArray(source.tags, "memory.tags")),
		importance,
		sourceIds: normalizeList(optionalStringArray(source.source_ids ?? source.sourceIds, "memory.source_ids")),
		currentStateReferences: normalizeList(
			optionalStringArray(
				source.current_state_references ?? source.currentStateReferences,
				"memory.current_state_references",
			),
		),
		createdAt: now,
	};
}

export function parseAutoresearchMemoryReuseInput(
	value: unknown,
	now = new Date().toISOString(),
): AutoresearchMemoryReusePlan {
	const source = requireRecord(value, "memory_reuse");
	const plan: AutoresearchMemoryReusePlan = {
		reuseId: optionalString(source.reuse_id ?? source.reuseId, "memory_reuse.reuse_id") ?? `reuse-${randomUUID()}`,
		query: requireString(source.query, "memory_reuse.query"),
		memoryIds: normalizeList(stringArray(source.memory_ids ?? source.memoryIds, "memory_reuse.memory_ids")),
		currentStateBindings: normalizeList(
			stringArray(
				source.current_state_bindings ?? source.currentStateBindings,
				"memory_reuse.current_state_bindings",
			),
		),
		applicabilityConditions: normalizeList(
			stringArray(
				source.applicability_conditions ?? source.applicabilityConditions,
				"memory_reuse.applicability_conditions",
			),
		),
		reusableProcedure: requireString(
			source.reusable_procedure ?? source.reusableProcedure,
			"memory_reuse.reusable_procedure",
		),
		verificationRequirements: normalizeList(
			stringArray(
				source.verification_requirements ?? source.verificationRequirements,
				"memory_reuse.verification_requirements",
			),
		),
		status: "proposed",
		verificationEvidence: [],
		createdAt: now,
	};
	if (plan.memoryIds.length === 0) throw new Error("memory_reuse.memory_ids must not be empty");
	if (plan.currentStateBindings.length === 0) {
		throw new Error("memory_reuse.current_state_bindings must not be empty");
	}
	if (plan.applicabilityConditions.length === 0 || plan.verificationRequirements.length === 0) {
		throw new Error("memory reuse requires applicability_conditions and verification_requirements");
	}
	return plan;
}

function parseFieldMaps(value: unknown): Record<AutoresearchFieldMapKind, string[]> {
	const source = requireRecord(value, "cycle.field_maps");
	const maps = emptyFieldMaps();
	for (const kind of FIELD_MAP_KINDS)
		maps[kind] = normalizeMapList(stringArray(source[kind], `cycle.field_maps.${kind}`));
	return maps;
}

export function parseAutoresearchCycleInput(value: unknown, now = new Date().toISOString()): AutoresearchCycleInput {
	const source = requireRecord(value, "cycle");
	const rawPublications = source.publications ?? [];
	if (!Array.isArray(rawPublications)) throw new Error("cycle.publications must be an array");
	const rawReviewers = source.reviewers ?? [];
	if (!Array.isArray(rawReviewers)) throw new Error("cycle.reviewers must be an array");
	const input: AutoresearchCycleInput = {
		candidate: parseAutoresearchCandidateInput(source.candidate),
		outcome: enumValue(source.outcome, CYCLE_OUTCOMES, "cycle.outcome"),
		rejectionReason: optionalString(source.rejection_reason ?? source.rejectionReason, "cycle.rejection_reason"),
		priorArtCluster: optionalString(source.prior_art_cluster ?? source.priorArtCluster, "cycle.prior_art_cluster"),
		explicitStuck:
			source.explicit_stuck === undefined && source.explicitStuck === undefined
				? false
				: requireBoolean(source.explicit_stuck ?? source.explicitStuck, "cycle.explicit_stuck"),
		trajectoryFingerprint: optionalString(
			source.trajectory_fingerprint ?? source.trajectoryFingerprint,
			"cycle.trajectory_fingerprint",
		),
		publications: rawPublications.map((item) => parseAutoresearchPublicationInput(item, now)),
		fieldMaps: parseFieldMaps(source.field_maps ?? source.fieldMaps),
		reviewers: rawReviewers.map((item, index) => parseReviewer(item, index)),
		gates: parseGates(source.gates),
		searchCoverage: parseSearchCoverage(source.search_coverage ?? source.searchCoverage),
		motivationPaperIds: normalizeList(
			optionalStringArray(source.motivation_paper_ids ?? source.motivationPaperIds, "cycle.motivation_paper_ids"),
		),
		closestPriorWorkPaperIds: normalizeList(
			optionalStringArray(
				source.closest_prior_work_paper_ids ?? source.closestPriorWorkPaperIds,
				"cycle.closest_prior_work_paper_ids",
			),
		),
		preliminaryEvidenceExperimentIds: normalizeList(
			optionalStringArray(
				source.preliminary_evidence_experiment_ids ?? source.preliminaryEvidenceExperimentIds,
				"cycle.preliminary_evidence_experiment_ids",
			),
		),
		canonicalPromotionIds: optionalStringArray(
			source.canonical_promotion_ids ?? source.canonicalPromotionIds,
			"cycle.canonical_promotion_ids",
		),
	};
	validateCycleGate(input);
	return input;
}

function validateCycleGate(input: AutoresearchCycleInput): void {
	const roles = new Set(input.reviewers.map((reviewer) => reviewer.role));
	if (roles.size !== input.reviewers.length) throw new Error("cycle.reviewers must not repeat a reviewer role");
	if (input.outcome === "rejected" && !input.rejectionReason) {
		throw new Error("a rejected cycle requires rejection_reason");
	}
	if (input.outcome === "promoted" && input.canonicalPromotionIds.length === 0) {
		throw new Error("a promoted cycle requires canonical_promotion_ids");
	}
	if (input.outcome !== "survived" && input.outcome !== "promoted") return;
	const missingRoles = REVIEWER_ROLES.filter((role) => !roles.has(role));
	if (missingRoles.length > 0) {
		throw new Error(`surviving candidates require all four reviewer roles; missing: ${missingRoles.join(", ")}`);
	}
	const failedReview = input.reviewers.find((reviewer) => reviewer.verdict !== "pass");
	if (failedReview) throw new Error(`surviving candidates require passing reviews; ${failedReview.role} did not pass`);
	const failedGate = Object.entries(input.gates).find(([, passed]) => !passed);
	if (failedGate) throw new Error(`surviving candidates require every problem gate; ${failedGate[0]} did not pass`);
	const missingCoverage = Object.entries(input.searchCoverage).find(([, covered]) => !covered);
	if (missingCoverage) {
		throw new Error(
			`surviving candidates require complete literature-search coverage; ${missingCoverage[0]} is missing`,
		);
	}
	if (input.motivationPaperIds.length < 2) {
		throw new Error("surviving candidates require at least two motivation_paper_ids");
	}
	if (input.closestPriorWorkPaperIds.length === 0) {
		throw new Error("surviving candidates require closest_prior_work_paper_ids");
	}
	if (input.outcome === "promoted" && input.preliminaryEvidenceExperimentIds.length === 0) {
		throw new Error("a promoted candidate requires preliminary_evidence_experiment_ids");
	}
}

export function parseAutoresearchSupervisionInput(
	value: unknown,
	now = new Date().toISOString(),
): AutoresearchSupervision {
	const source = requireRecord(value, "supervision");
	const status = enumValue(source.status, SUPERVISOR_STATUSES, "supervision.status");
	const rawDirections = source.alternative_directions ?? source.alternativeDirections ?? [];
	if (!Array.isArray(rawDirections)) throw new Error("supervision.alternative_directions must be an array");
	const alternativeDirections = rawDirections.map((item, index) => {
		const direction = requireRecord(item, `supervision.alternative_directions[${index}]`);
		const priority = direction.priority;
		if (!Number.isInteger(priority) || (priority as number) < 1) {
			throw new Error(`supervision.alternative_directions[${index}].priority must be a positive integer`);
		}
		return {
			direction: requireString(direction.direction, `supervision.alternative_directions[${index}].direction`),
			whyDifferent: requireString(
				direction.why_different ?? direction.whyDifferent,
				`supervision.alternative_directions[${index}].why_different`,
			),
			killSearch: requireString(
				direction.kill_search ?? direction.killSearch,
				`supervision.alternative_directions[${index}].kill_search`,
			),
			falsifier: requireString(direction.falsifier, `supervision.alternative_directions[${index}].falsifier`),
			priority: priority as number,
		};
	});
	const interventionNeeded =
		source.intervention_needed === undefined && source.interventionNeeded === undefined
			? status === "intervene"
			: requireBoolean(source.intervention_needed ?? source.interventionNeeded, "supervision.intervention_needed");
	if (status === "intervene" && alternativeDirections.length !== 3) {
		throw new Error("an intervention must include exactly three alternative_directions");
	}
	if (status !== "intervene" && alternativeDirections.length !== 0) {
		throw new Error("non-intervention supervision must use an empty alternative_directions array");
	}
	if (interventionNeeded !== (status === "intervene")) {
		throw new Error("supervision.intervention_needed must agree with supervision.status");
	}
	if (
		status === "intervene" &&
		alternativeDirections
			.map((direction) => direction.priority)
			.sort((left, right) => left - right)
			.join(",") !== "1,2,3"
	) {
		throw new Error("intervention direction priorities must be exactly 1, 2, and 3");
	}
	const supervision: AutoresearchSupervision = {
		supervisionId: `supervision-${randomUUID()}`,
		cycleId: requireString(source.cycle_id ?? source.cycleId, "supervision.cycle_id"),
		recordedAt: now,
		status,
		reason: requireString(source.reason, "supervision.reason"),
		detectedPattern: requireString(source.detected_pattern ?? source.detectedPattern, "supervision.detected_pattern"),
		interventionNeeded,
		alternativeDirections,
	};
	const diagnosis = optionalString(source.diagnosis, "supervision.diagnosis");
	const failedSearchPattern = optionalString(
		source.failed_search_pattern ?? source.failedSearchPattern,
		"supervision.failed_search_pattern",
	);
	const assumptionToQuestion = optionalString(
		source.assumption_to_question ?? source.assumptionToQuestion,
		"supervision.assumption_to_question",
	);
	if (status === "intervene" && (!diagnosis || !failedSearchPattern || !assumptionToQuestion)) {
		throw new Error("an intervention requires diagnosis, failed_search_pattern, and assumption_to_question");
	}
	if (diagnosis) supervision.diagnosis = diagnosis;
	if (failedSearchPattern) supervision.failedSearchPattern = failedSearchPattern;
	if (assumptionToQuestion) supervision.assumptionToQuestion = assumptionToQuestion;
	return supervision;
}

export type AutoresearchAgentPayload =
	| { kind: "review"; candidateId: string; reviewer: AutoresearchReviewerResult }
	| { kind: "supervision"; cycleId: string; supervision: AutoresearchSupervision };

export function parseAutoresearchAgentPayload(
	text: string,
	now = new Date().toISOString(),
): AutoresearchAgentPayload | undefined {
	const marker = text.match(/AUTORESEARCH_(REVIEW|SUPERVISION)_JSON:([^\s`]+)/);
	if (!marker || marker.index === undefined) return undefined;
	const jsonStart = text.indexOf("{", marker.index + marker[0].length);
	const jsonEnd = text.lastIndexOf("}");
	if (jsonStart < 0 || jsonEnd < jsonStart)
		throw new Error("autoresearch agent marker is not followed by a JSON object");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
	} catch (error) {
		throw new Error(
			`autoresearch agent payload is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const source = requireRecord(parsed, "autoresearch agent payload");
	const markerId = marker[2]!;
	if (marker[1] === "REVIEW") {
		const candidateId = requireIdentifier(
			source.candidate_id ?? source.candidateId,
			"autoresearch review.candidate_id",
		);
		if (candidateId !== markerId) throw new Error("autoresearch review marker and candidate_id do not agree");
		return { kind: "review", candidateId, reviewer: parseReviewer(source, 0) };
	}
	const supervision = parseAutoresearchSupervisionInput(source, now);
	if (supervision.cycleId !== markerId) {
		throw new Error("autoresearch supervision marker and cycle_id do not agree");
	}
	return { kind: "supervision", cycleId: supervision.cycleId, supervision };
}

function allSame(values: Array<string | undefined>): boolean {
	if (values.length === 0 || !values[0]) return false;
	return values.every((value) => sameNormalized(value, values[0]));
}

function countTrailingMatches(
	cycles: AutoresearchCycle[],
	select: (cycle: AutoresearchCycle) => string | undefined,
): number {
	const target = select(cycles.at(-1)!);
	if (!target) return 0;
	let count = 0;
	for (let index = cycles.length - 1; index >= 0; index--) {
		if (!sameNormalized(select(cycles[index]), target)) break;
		count++;
	}
	return count;
}

export function evaluateAutoresearchCheckpoint(cycles: AutoresearchCycle[]): AutoresearchCheckpoint {
	if (cycles.length === 0) {
		return {
			status: "progressing",
			reason: "No completed research cycle is available yet.",
			detectedPattern: "none",
			interventionNeeded: false,
			triggeredHeuristics: [],
			progressIndicators: {
				cyclesSinceCanonicalProgress: 0,
				repeatedRejectionCount: 0,
				repeatedPriorArtCount: 0,
				papersSinceFieldMapChange: 0,
				repeatedTrajectoryCount: 0,
			},
		};
	}
	const latest = cycles.at(-1)!;
	let lastPromotionIndex = -1;
	for (let index = cycles.length - 1; index >= 0; index--) {
		if (cycles[index].canonicalPromotionIds.length > 0 || cycles[index].fieldMapChanged) {
			lastPromotionIndex = index;
			break;
		}
	}
	const cyclesSinceCanonicalProgress = cycles.length - (lastPromotionIndex + 1);
	const trailingThree = cycles.slice(-3);
	const repeatedRejections =
		trailingThree.length === 3 &&
		trailingThree.every((cycle) => cycle.outcome === "rejected") &&
		allSame(trailingThree.map((cycle) => cycle.rejectionReason));
	const repeatedPriorArt = trailingThree.length === 3 && allSame(trailingThree.map((cycle) => cycle.priorArtCluster));
	const repeatedTrajectory =
		trailingThree.length === 3 && allSame(trailingThree.map((cycle) => cycle.trajectoryFingerprint));
	let papersSinceFieldMapChange = 0;
	for (let index = cycles.length - 1; index >= 0; index--) {
		const cycle = cycles[index];
		if (cycle.fieldMapChanged) break;
		papersSinceFieldMapChange += cycle.papersAdded;
	}
	const repeatedRejectionCount = countTrailingMatches(cycles, (cycle) =>
		cycle.outcome === "rejected" ? cycle.rejectionReason : undefined,
	);
	const repeatedPriorArtCount = countTrailingMatches(cycles, (cycle) => cycle.priorArtCluster);
	const repeatedTrajectoryCount = countTrailingMatches(cycles, (cycle) => cycle.trajectoryFingerprint);
	const triggers: string[] = [];
	if (cyclesSinceCanonicalProgress >= 5) triggers.push("no_canonical_progress_5_cycles");
	if (repeatedRejections) triggers.push("same_rejection_reason_3_cycles");
	if (repeatedPriorArt) triggers.push("same_prior_art_cluster_3_cycles");
	if (papersSinceFieldMapChange >= 10) triggers.push("literature_expansion_without_map_change");
	if (latest.explicitStuck) triggers.push("main_agent_reported_stuck");
	if (repeatedTrajectory) triggers.push("trajectory_repetition_3_cycles");
	const progressIndicators = {
		cyclesSinceCanonicalProgress,
		repeatedRejectionCount,
		repeatedPriorArtCount,
		papersSinceFieldMapChange,
		repeatedTrajectoryCount,
	};
	if (triggers.length > 0) {
		return {
			status: "intervene",
			reason: `Prototype stagnation heuristics triggered: ${triggers.join(", ")}.`,
			detectedPattern: triggers.join(" + "),
			interventionNeeded: true,
			triggeredHeuristics: triggers,
			progressIndicators,
		};
	}
	const watchReasons: string[] = [];
	if (cyclesSinceCanonicalProgress >= 3) watchReasons.push("canonical progress is approaching the five-cycle limit");
	if (repeatedRejectionCount >= 2) watchReasons.push("the last two rejections share a reason");
	if (repeatedPriorArtCount >= 2) watchReasons.push("the last two candidates share a prior-art cluster");
	if (papersSinceFieldMapChange >= 7) watchReasons.push("literature growth has not yet changed the field map");
	if (repeatedTrajectoryCount >= 2) watchReasons.push("the last two trajectory fingerprints match");
	return {
		status: watchReasons.length > 0 ? "watch" : "progressing",
		reason: watchReasons.length > 0 ? watchReasons.join("; ") : "The cycle changed the verified research trajectory.",
		detectedPattern: watchReasons.length > 0 ? "early_stagnation_signal" : "none",
		interventionNeeded: false,
		triggeredHeuristics: [],
		progressIndicators,
	};
}

function isAutoresearchState(value: unknown): value is AutoresearchState {
	if (!isRecord(value)) return false;
	if (!isRecord(value.fieldMaps)) return false;
	const fieldMaps = value.fieldMaps;
	return (
		value.schemaVersion === AUTORESEARCH_STATE_VERSION &&
		typeof value.updatedAt === "string" &&
		Array.isArray(value.publications) &&
		Array.isArray(value.checkpointedPublicationKeys) &&
		Array.isArray(value.claims) &&
		Array.isArray(value.experiments) &&
		Array.isArray(value.memories) &&
		Array.isArray(value.memoryReusePlans) &&
		Array.isArray(value.collectedReviews) &&
		Array.isArray(value.ingestedAgentMessageIds) &&
		FIELD_MAP_KINDS.every((kind) => Array.isArray(fieldMaps[kind])) &&
		Array.isArray(value.cycles) &&
		Array.isArray(value.supervision) &&
		Array.isArray(value.lineage)
	);
}

function migrateAutoresearchState(value: unknown): unknown {
	if (!isRecord(value) || value.schemaVersion !== 1) return value;
	const cycles = Array.isArray(value.cycles)
		? value.cycles.map((item) => {
				if (!isRecord(item)) return item;
				return {
					...item,
					searchCoverage: item.searchCoverage ?? parseSearchCoverage(undefined),
					motivationPaperIds: item.motivationPaperIds ?? [],
					closestPriorWorkPaperIds: item.closestPriorWorkPaperIds ?? [],
					preliminaryEvidenceExperimentIds: item.preliminaryEvidenceExperimentIds ?? [],
				};
			})
		: value.cycles;
	return {
		...value,
		schemaVersion: AUTORESEARCH_STATE_VERSION,
		experiments: [],
		memories: [],
		memoryReusePlans: [],
		collectedReviews: [],
		ingestedAgentMessageIds: [],
		cycles,
	};
}

function publicationKey(publication: AutoresearchPublication): string {
	return publication.doi?.toLowerCase() ?? publication.preprintId?.toLowerCase() ?? publication.paperId.toLowerCase();
}

function samePublication(left: AutoresearchPublication, right: AutoresearchPublication): boolean {
	if (left.paperId.toLowerCase() === right.paperId.toLowerCase()) return true;
	if (left.doi && right.doi && left.doi.toLowerCase() === right.doi.toLowerCase()) return true;
	return !!left.preprintId && !!right.preprintId && left.preprintId.toLowerCase() === right.preprintId.toLowerCase();
}

function canonicalClaimSummaries(state: AutoresearchState): Array<Record<string, unknown>> {
	return state.claims
		.filter((claim) => claim.status === "canonical" || claim.status === "contested")
		.slice(-20)
		.map((claim) => ({
			claim_id: claim.claimId,
			claim: claim.claimText,
			type: claim.claimType,
			status: claim.status,
			confidence: claim.confidence,
			unresolved_objections: claim.unresolvedObjections,
		}));
}

function compactFieldMaps(state: AutoresearchState): Record<string, unknown> {
	return Object.fromEntries(
		FIELD_MAP_KINDS.map((kind) => [
			kind,
			{ entries: state.fieldMaps[kind].slice(0, 50), total: state.fieldMaps[kind].length },
		]),
	);
}

function memoryTerms(value: string): Set<string> {
	return new Set(
		value
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((term) => term.length > 2),
	);
}

function memoryRelevance(memory: AutoresearchMemory, query: string): number {
	const queryTerms = memoryTerms(query);
	if (queryTerms.size === 0) return 0;
	const memoryTermSet = memoryTerms(`${memory.title} ${memory.content} ${memory.tags.join(" ")}`);
	let overlap = 0;
	for (const term of queryTerms) if (memoryTermSet.has(term)) overlap++;
	return overlap / queryTerms.size + memory.importance / 100;
}

export class AutoresearchStore {
	private readonly statePath?: string;
	private state: AutoresearchState;
	private loadError?: string;

	constructor(
		artifactDir?: string,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		this.statePath = artifactDir ? join(artifactDir, "autoresearch", "state.json") : undefined;
		this.state = this.load();
	}

	private load(): AutoresearchState {
		const fallback = emptyState(this.now());
		if (!this.statePath || !existsSync(this.statePath)) return fallback;
		try {
			const parsed = migrateAutoresearchState(JSON.parse(readFileSync(this.statePath, "utf8")) as unknown);
			if (!isAutoresearchState(parsed)) throw new Error("state schema is invalid or unsupported");
			return parsed;
		} catch (error) {
			this.loadError = error instanceof Error ? error.message : String(error);
			return fallback;
		}
	}

	private assertHealthy(): void {
		if (this.loadError) {
			throw new Error(`autoresearch state could not be loaded; the existing file was preserved: ${this.loadError}`);
		}
	}

	private save(): void {
		this.assertHealthy();
		this.state.updatedAt = this.now();
		if (!this.statePath) return;
		mkdirSync(dirname(this.statePath), { recursive: true });
		const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, this.statePath);
	}

	getState(): AutoresearchState {
		this.assertHealthy();
		return structuredClone(this.state);
	}

	initialize(objective: string, topic?: string): AutoresearchState {
		const normalizedObjective = requireString(objective, "objective");
		const normalizedTopic = optionalString(topic, "topic");
		if (this.state.objective && this.state.objective !== normalizedObjective) {
			throw new Error(
				"this session already contains a different autoresearch objective; start a new session instead",
			);
		}
		if (!this.state.objective) {
			const recordedAt = this.now();
			this.state.objective = normalizedObjective;
			this.state.createdAt = recordedAt;
			this.state.lineage.push({
				lineageId: `lineage-${randomUUID()}`,
				recordedAt,
				kind: "initialized",
				summary: `Initialized autoresearch objective: ${normalizedObjective}`,
			});
		}
		if (normalizedTopic) this.state.topic = normalizedTopic;
		this.save();
		return this.getState();
	}

	setSupervisor(supervisor: AutoresearchSupervisorRef): AutoresearchState {
		this.state.supervisor = {
			rlmChildId: requireString(supervisor.rlmChildId, "supervisor.rlm_child_id"),
			name: requireString(supervisor.name, "supervisor.name"),
		};
		this.save();
		return this.getState();
	}

	addPublication(publication: AutoresearchPublication): AutoresearchPublication {
		const existing = this.state.publications.findIndex((candidate) => samePublication(candidate, publication));
		if (existing >= 0) this.state.publications[existing] = publication;
		else this.state.publications.push(publication);
		this.save();
		return structuredClone(publication);
	}

	recordExperiment(experiment: AutoresearchExperiment): AutoresearchExperiment {
		const existing = this.state.experiments.findIndex((item) => item.experimentId === experiment.experimentId);
		if (existing >= 0) {
			const previous = this.state.experiments[existing]!;
			if (previous.candidateId !== experiment.candidateId) {
				throw new Error("an experiment cannot be reassigned to another candidate");
			}
			if (previous.status === "completed" && experiment.status !== "completed") {
				throw new Error("a completed experiment cannot be moved back to a non-completed status");
			}
			experiment.createdAt = previous.createdAt;
			this.state.experiments[existing] = experiment;
		} else {
			this.state.experiments.push(experiment);
		}
		if (experiment.status === "completed") {
			const alreadyRecorded = this.state.lineage.some(
				(entry) => entry.kind === "experiment_completed" && entry.referenceId === experiment.experimentId,
			);
			if (!alreadyRecorded) {
				this.state.lineage.push({
					lineageId: `lineage-${randomUUID()}`,
					recordedAt: experiment.updatedAt,
					kind: "experiment_completed",
					summary: `Completed ${experiment.experimentId}: ${experiment.results}`,
					referenceId: experiment.experimentId,
				});
			}
		}
		this.save();
		return structuredClone(experiment);
	}

	remember(memory: AutoresearchMemory): AutoresearchMemory {
		if (this.state.memories.some((item) => item.memoryId === memory.memoryId)) {
			throw new Error(`memory ${memory.memoryId} already exists`);
		}
		this.state.memories.push(memory);
		this.save();
		return structuredClone(memory);
	}

	recallMemories(query: string, limit = 8): AutoresearchMemory[] {
		const normalizedQuery = requireString(query, "query");
		if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer from 1 to 50");
		return this.state.memories
			.filter((memory) => !memory.invalidatedAt)
			.map((memory) => ({ memory, score: memoryRelevance(memory, normalizedQuery) }))
			.filter((item) => item.score > 0.05)
			.sort((left, right) => right.score - left.score)
			.slice(0, limit)
			.map((item) => structuredClone(item.memory));
	}

	createMemoryReusePlan(plan: AutoresearchMemoryReusePlan): AutoresearchMemoryReusePlan {
		if (this.state.memoryReusePlans.some((item) => item.reuseId === plan.reuseId)) {
			throw new Error(`memory reuse plan ${plan.reuseId} already exists`);
		}
		for (const memoryId of plan.memoryIds) {
			const memory = this.state.memories.find((item) => item.memoryId === memoryId && !item.invalidatedAt);
			if (!memory) throw new Error(`memory reuse references missing or invalidated memory ${memoryId}`);
		}
		this.state.memoryReusePlans.push(plan);
		this.save();
		return structuredClone(plan);
	}

	verifyMemoryReuse(reuseId: string, accepted: boolean, evidence: string[]): AutoresearchMemoryReusePlan {
		const plan = this.state.memoryReusePlans.find((item) => item.reuseId === requireString(reuseId, "reuse_id"));
		if (!plan) throw new Error(`memory reuse plan ${reuseId} was not found`);
		if (plan.status !== "proposed") throw new Error(`memory reuse plan ${reuseId} is already ${plan.status}`);
		const normalizedEvidence = normalizeList(evidence);
		if (normalizedEvidence.length === 0) throw new Error("memory reuse verification requires evidence");
		plan.verificationEvidence = normalizedEvidence;
		plan.status = accepted ? "verified" : "rejected";
		plan.verifiedAt = this.now();
		if (accepted) {
			for (const memoryId of plan.memoryIds) {
				const memory = this.state.memories.find((item) => item.memoryId === memoryId);
				if (memory) memory.lastVerifiedAt = plan.verifiedAt;
			}
		}
		this.save();
		return structuredClone(plan);
	}

	getCollectedReviews(candidateId: string): AutoresearchReviewerResult[] {
		const normalizedCandidateId = requireString(candidateId, "candidate_id");
		const byRole = new Map<AutoresearchReviewerRole, AutoresearchReviewerResult>();
		for (const item of this.state.collectedReviews) {
			if (item.candidateId === normalizedCandidateId) byRole.set(item.reviewer.role, item.reviewer);
		}
		return [...byRole.values()].map((reviewer) => structuredClone(reviewer));
	}

	ingestAgentMessage(messageId: string, text: string): AutoresearchAgentPayload | undefined {
		const normalizedMessageId = requireString(messageId, "message_id");
		if (this.state.ingestedAgentMessageIds.includes(normalizedMessageId)) return undefined;
		const payload = parseAutoresearchAgentPayload(text, this.now());
		if (!payload) return undefined;
		if (payload.kind === "review") {
			const duplicate = this.state.collectedReviews.some(
				(item) => item.candidateId === payload.candidateId && item.reviewer.role === payload.reviewer.role,
			);
			if (duplicate)
				throw new Error(`candidate ${payload.candidateId} already has a ${payload.reviewer.role} review`);
			this.state.collectedReviews.push({
				messageId: normalizedMessageId,
				candidateId: payload.candidateId,
				recordedAt: this.now(),
				reviewer: payload.reviewer,
			});
		} else {
			this.recordSupervision(payload.supervision, false);
		}
		this.state.ingestedAgentMessageIds.push(normalizedMessageId);
		this.save();
		return structuredClone(payload);
	}

	addClaim(claim: AutoresearchClaim): AutoresearchClaim {
		if (this.state.claims.some((candidate) => candidate.claimId === claim.claimId)) {
			throw new Error(`claim ${claim.claimId} already exists`);
		}
		this.assertEvidenceBindingsExist(claim);
		this.state.claims.push(claim);
		this.save();
		return structuredClone(claim);
	}

	updateClaim(claimId: string, update: AutoresearchClaimUpdate): AutoresearchClaim {
		const claim = this.state.claims.find((candidate) => candidate.claimId === requireString(claimId, "claim_id"));
		if (!claim) throw new Error(`claim ${claimId} was not found`);
		const candidate: AutoresearchClaim = {
			...claim,
			supportingEvidence: [...claim.supportingEvidence, ...update.supportingEvidence],
			contradictingEvidence: [...claim.contradictingEvidence, ...update.contradictingEvidence],
			confidence: update.confidence ?? claim.confidence,
			unresolvedObjections: normalizeList([...claim.unresolvedObjections, ...update.unresolvedObjections]),
		};
		this.assertEvidenceBindingsExist(candidate);
		claim.supportingEvidence = candidate.supportingEvidence;
		claim.contradictingEvidence = candidate.contradictingEvidence;
		claim.confidence = candidate.confidence;
		claim.unresolvedObjections = candidate.unresolvedObjections;
		if (claim.status === "canonical" && claim.contradictingEvidence.length > 0) claim.status = "contested";
		claim.lastVerifiedAt = this.now();
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			recordedAt: claim.lastVerifiedAt,
			kind: "claim_revised",
			summary: `Revised ${claim.claimId} with new evidence or objections; status is ${claim.status}.`,
			referenceId: claim.claimId,
		});
		this.save();
		return structuredClone(claim);
	}

	private assertEvidenceBindingsExist(claim: AutoresearchClaim): void {
		for (const binding of [...claim.supportingEvidence, ...claim.contradictingEvidence]) {
			if (binding.sourceType === "publication") {
				const publication = this.state.publications.find(
					(paper) => paper.paperId.toLowerCase() === binding.sourceId.toLowerCase(),
				);
				if (!publication) throw new Error(`evidence source ${binding.sourceId} is not in the publication ledger`);
				if (!publication.metadataVerifiedBy?.length) {
					throw new Error(`publication evidence ${binding.sourceId} requires metadata_verified_by`);
				}
			}
			if (binding.sourceType === "experiment") {
				const experiment = this.state.experiments.find((item) => item.experimentId === binding.sourceId);
				if (!experiment || (experiment.status !== "completed" && experiment.status !== "failed")) {
					throw new Error(
						`experiment evidence ${binding.sourceId} must reference a completed or failed experiment`,
					);
				}
			}
		}
	}

	promoteClaim(claimId: string): AutoresearchClaim {
		const claim = this.state.claims.find((candidate) => candidate.claimId === requireString(claimId, "claim_id"));
		if (!claim) throw new Error(`claim ${claimId} was not found`);
		if (claim.supportingEvidence.length === 0) throw new Error("canonical claims require supporting evidence");
		const literatureTypes = new Set<AutoresearchClaimType>([
			"FIELD_PRACTICE",
			"SHARED_ASSUMPTION",
			"KNOWN_LIMITATION",
			"CONTRADICTION",
			"PRIOR_ART",
		]);
		if (
			literatureTypes.has(claim.claimType) &&
			!claim.supportingEvidence.some((item) => item.sourceType === "publication")
		) {
			throw new Error(`${claim.claimType} claims require at least one publication evidence binding`);
		}
		this.assertEvidenceBindingsExist(claim);
		claim.status = claim.contradictingEvidence.length > 0 ? "contested" : "canonical";
		claim.lastVerifiedAt = this.now();
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			recordedAt: claim.lastVerifiedAt,
			kind: "claim_promoted",
			summary: `Promoted ${claim.claimId}: ${claim.claimText}`,
			referenceId: claim.claimId,
		});
		this.save();
		return structuredClone(claim);
	}

	invalidateClaim(claimId: string, reason: string): AutoresearchClaim {
		const claim = this.state.claims.find((candidate) => candidate.claimId === requireString(claimId, "claim_id"));
		if (!claim) throw new Error(`claim ${claimId} was not found`);
		const normalizedReason = requireString(reason, "reason");
		claim.status = "rejected";
		claim.unresolvedObjections = normalizeList([...claim.unresolvedObjections, normalizedReason]);
		const recordedAt = this.now();
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			recordedAt,
			kind: "claim_invalidated",
			summary: `Invalidated ${claim.claimId}: ${normalizedReason}`,
			referenceId: claim.claimId,
		});
		this.save();
		return structuredClone(claim);
	}

	recordCycle(input: AutoresearchCycleInput): AutoresearchCycleResult {
		if (!this.state.objective) throw new Error("initialize autoresearch before completing a cycle");
		for (const publication of input.publications) {
			const index = this.state.publications.findIndex((paper) => samePublication(paper, publication));
			if (index >= 0) this.state.publications[index] = publication;
			else this.state.publications.push(publication);
		}
		const checkpointedPublicationKeys = new Set(this.state.checkpointedPublicationKeys);
		const newPublications = this.state.publications.filter(
			(publication) => !checkpointedPublicationKeys.has(publicationKey(publication)),
		);
		for (const publication of newPublications) checkpointedPublicationKeys.add(publicationKey(publication));
		this.state.checkpointedPublicationKeys = [...checkpointedPublicationKeys];
		const previousMaps = JSON.stringify(this.state.fieldMaps);
		const nextMaps = JSON.stringify(input.fieldMaps);
		const fieldMapChanged = previousMaps !== nextMaps;
		this.state.fieldMaps = structuredClone(input.fieldMaps);
		for (const claimId of input.canonicalPromotionIds) {
			const claim = this.state.claims.find((candidate) => candidate.claimId === claimId);
			if (!claim || (claim.status !== "canonical" && claim.status !== "contested")) {
				throw new Error(`canonical_promotion_ids contains non-canonical claim ${claimId}`);
			}
		}
		for (const paperId of [...input.motivationPaperIds, ...input.closestPriorWorkPaperIds]) {
			const publication = this.state.publications.find((paper) => paper.paperId === paperId);
			if (!publication?.metadataVerifiedBy?.length) {
				throw new Error(`cycle paper reference ${paperId} is missing from the verified publication ledger`);
			}
		}
		for (const experimentId of input.preliminaryEvidenceExperimentIds) {
			const experiment = this.state.experiments.find((item) => item.experimentId === experimentId);
			if (!experiment || experiment.candidateId !== input.candidate.candidateId) {
				throw new Error(`preliminary evidence ${experimentId} is not recorded for this candidate`);
			}
			if (input.outcome === "promoted" && experiment.status !== "completed") {
				throw new Error(`promoted candidate evidence ${experimentId} must be a completed experiment`);
			}
		}
		const cycle: AutoresearchCycle = {
			cycleId: `cycle-${randomUUID()}`,
			completedAt: this.now(),
			candidate: input.candidate,
			outcome: input.outcome,
			rejectionReason: input.rejectionReason,
			priorArtCluster: input.priorArtCluster,
			explicitStuck: input.explicitStuck,
			trajectoryFingerprint: input.trajectoryFingerprint,
			papersAdded: newPublications.length,
			paperIds: normalizeList([
				...newPublications.map((publication) => publication.paperId),
				...input.publications.map((publication) => publication.paperId),
			]),
			fieldMapChanged,
			reviewers: input.reviewers,
			gates: input.gates,
			searchCoverage: input.searchCoverage,
			motivationPaperIds: input.motivationPaperIds,
			closestPriorWorkPaperIds: input.closestPriorWorkPaperIds,
			preliminaryEvidenceExperimentIds: input.preliminaryEvidenceExperimentIds,
			canonicalPromotionIds: input.canonicalPromotionIds,
		};
		this.state.cycles.push(cycle);
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			recordedAt: cycle.completedAt,
			kind: "cycle_completed",
			summary: `Completed ${cycle.cycleId}: ${cycle.outcome} — ${cycle.candidate.statement}`,
			referenceId: cycle.cycleId,
		});
		if (cycle.outcome === "rejected" || cycle.outcome === "experiment_failed") {
			this.state.memories.push({
				memoryId: `memory-${randomUUID()}`,
				type: cycle.outcome === "rejected" ? "FAILED_DIRECTION" : "EXPERIMENT_RESULT",
				title: `${cycle.outcome}: ${cycle.candidate.candidateId}`,
				content: `${cycle.candidate.statement}\nReason: ${cycle.rejectionReason ?? cycle.outcome}`,
				tags: normalizeList([cycle.candidate.candidateId, cycle.priorArtCluster ?? ""]),
				importance: 7,
				sourceIds: [cycle.cycleId],
				currentStateReferences: [`cycle:${cycle.cycleId}`],
				createdAt: cycle.completedAt,
			});
		}
		const reviewerObjections = cycle.reviewers.flatMap((reviewer) => reviewer.objections);
		if (reviewerObjections.length > 0) {
			this.state.memories.push({
				memoryId: `memory-${randomUUID()}`,
				type: "REVIEWER_OBJECTION",
				title: `Reviewer objections for ${cycle.candidate.candidateId}`,
				content: reviewerObjections.join("\n"),
				tags: [cycle.candidate.candidateId],
				importance: 6,
				sourceIds: [cycle.cycleId],
				currentStateReferences: [`cycle:${cycle.cycleId}`],
				createdAt: cycle.completedAt,
			});
		}
		const checkpoint = evaluateAutoresearchCheckpoint(this.state.cycles);
		const packet = this.buildSupervisorPacket(cycle, checkpoint);
		this.save();
		return { cycle: structuredClone(cycle), checkpoint, packet };
	}

	recordSupervision(supervision: AutoresearchSupervision, persist = true): AutoresearchSupervision {
		if (!this.state.cycles.some((cycle) => cycle.cycleId === supervision.cycleId)) {
			throw new Error(`supervision references unknown cycle ${supervision.cycleId}`);
		}
		if (this.state.supervision.some((item) => item.cycleId === supervision.cycleId)) {
			throw new Error(`cycle ${supervision.cycleId} already has recorded supervision`);
		}
		this.state.supervision.push(supervision);
		if (supervision.interventionNeeded) {
			this.state.lineage.push({
				lineageId: `lineage-${randomUUID()}`,
				recordedAt: supervision.recordedAt,
				kind: "supervisor_intervention",
				summary: supervision.diagnosis ?? supervision.reason,
				referenceId: supervision.supervisionId,
			});
			this.state.memories.push({
				memoryId: `memory-${randomUUID()}`,
				type: "SUPERVISOR_INTERVENTION",
				title: `Supervisor intervention for ${supervision.cycleId}`,
				content: `${supervision.diagnosis}\nDirections: ${supervision.alternativeDirections
					.map((direction) => direction.direction)
					.join("; ")}`,
				tags: [supervision.cycleId, supervision.detectedPattern],
				importance: 8,
				sourceIds: [supervision.supervisionId],
				currentStateReferences: [`cycle:${supervision.cycleId}`],
				createdAt: supervision.recordedAt,
			});
		}
		if (persist) this.save();
		return structuredClone(supervision);
	}

	private buildSupervisorPacket(
		cycle: AutoresearchCycle,
		checkpoint: AutoresearchCheckpoint,
	): Record<string, unknown> {
		return {
			packet_version: 1,
			cycle_id: cycle.cycleId,
			objective: this.state.objective,
			topic: this.state.topic,
			canonical_findings: canonicalClaimSummaries(this.state),
			current_candidate: cycle.candidate,
			recent_trajectory: this.state.cycles.slice(-5).map((item) => ({
				cycle_id: item.cycleId,
				candidate: item.candidate.statement,
				outcome: item.outcome,
				rejection_reason: item.rejectionReason,
				prior_art_cluster: item.priorArtCluster,
				papers_added: item.papersAdded,
				papers_read: item.paperIds,
				field_map_changed: item.fieldMapChanged,
				reviewer_objections: item.reviewers.flatMap((reviewer) => reviewer.objections),
			})),
			memory_summary: {
				failed_directions: this.state.cycles
					.filter((item) => item.outcome === "rejected" || item.outcome === "experiment_failed")
					.slice(-10)
					.map((item) => ({ candidate: item.candidate.statement, reason: item.rejectionReason ?? item.outcome })),
				novelty_collisions: this.state.cycles
					.filter((item) => item.priorArtCluster)
					.slice(-10)
					.map((item) => ({ candidate: item.candidate.statement, cluster: item.priorArtCluster })),
				previous_interventions: this.state.supervision
					.filter((item) => item.interventionNeeded)
					.slice(-5)
					.map((item) => ({ diagnosis: item.diagnosis, directions: item.alternativeDirections })),
			},
			field_maps: compactFieldMaps(this.state),
			experiments: this.state.experiments.slice(-10).map((experiment) => ({
				experiment_id: experiment.experimentId,
				candidate_id: experiment.candidateId,
				status: experiment.status,
				results: experiment.results,
				interpretation: experiment.interpretation,
				confounds: experiment.confounds,
			})),
			progress_indicators: checkpoint.progressIndicators,
			host_checkpoint: {
				status: checkpoint.status,
				reason: checkpoint.reason,
				detected_pattern: checkpoint.detectedPattern,
				intervention_needed: checkpoint.interventionNeeded,
				triggered_heuristics: checkpoint.triggeredHeuristics,
			},
		};
	}

	evaluateStopGate(): AutoresearchStopGate {
		const promoted = [...this.state.cycles].reverse().find((cycle) => cycle.outcome === "promoted");
		const motivationPublications = promoted
			? promoted.motivationPaperIds
					.map((paperId) => this.state.publications.find((publication) => publication.paperId === paperId))
					.filter((publication): publication is AutoresearchPublication => publication !== undefined)
			: [];
		const promotedClaimPublicationIds = new Set(
			(promoted?.canonicalPromotionIds ?? []).flatMap((claimId) => {
				const claim = this.state.claims.find((item) => item.claimId === claimId);
				return (
					claim?.supportingEvidence
						.filter((binding) => binding.sourceType === "publication")
						.map((binding) => binding.sourceId) ?? []
				);
			}),
		);
		const preliminaryExperiments = promoted
			? promoted.preliminaryEvidenceExperimentIds
					.map((experimentId) =>
						this.state.experiments.find((experiment) => experiment.experimentId === experimentId),
					)
					.filter((experiment): experiment is AutoresearchExperiment => experiment !== undefined)
			: [];
		const supervision = promoted
			? [...this.state.supervision].reverse().find((item) => item.cycleId === promoted.cycleId)
			: undefined;
		const hostCheckpoint = evaluateAutoresearchCheckpoint(this.state.cycles);
		const checks: AutoresearchStopGate["checks"] = {
			promotedCandidate: promoted !== undefined,
			clearProblemStatement: !!promoted?.candidate.statement.trim(),
			multipleRealPublications:
				motivationPublications.length >= 2 &&
				motivationPublications.every(
					(publication) =>
						!!publication.metadataVerifiedBy?.length &&
						publication.publicationStatus !== "published_status_unclear" &&
						promotedClaimPublicationIds.has(publication.paperId),
				) &&
				motivationPublications.some((publication) => publication.publicationStatus === "peer_reviewed"),
			latestPreprintCheck: promoted?.searchCoverage.recentPreprints === true,
			strongClosestPriorWorkComparison:
				!!promoted?.candidate.closestPriorArt.trim() && (promoted?.closestPriorWorkPaperIds.length ?? 0) > 0,
			mechanisticExplanation: !!promoted?.candidate.mechanisticMotivation.trim(),
			falsifiableHypothesis: promoted?.gates.falsifiable === true && !!promoted.candidate.falsifier.trim(),
			feasibleExperiment: promoted?.gates.feasible === true && !!promoted.candidate.experimentDesign.trim(),
			preliminaryEvidence:
				preliminaryExperiments.length > 0 &&
				preliminaryExperiments.every((experiment) => experiment.status === "completed"),
			strongBaselinePlan: !!promoted?.candidate.baselinePlan.trim(),
			broaderRelevance: promoted?.gates.broaderRelevance === true && !!promoted.candidate.broaderRelevance.trim(),
			fourReviewSurvival:
				promoted?.reviewers.length === REVIEWER_ROLES.length &&
				REVIEWER_ROLES.every((role) =>
					promoted.reviewers.some((reviewer) => reviewer.role === role && reviewer.verdict === "pass"),
				),
			supervisorProgressing:
				hostCheckpoint.status === "progressing" &&
				supervision?.status === "progressing" &&
				!supervision.interventionNeeded,
		};
		const labels: Record<keyof typeof checks, string> = {
			promotedCandidate: "no candidate has been promoted",
			clearProblemStatement: "the final problem statement is missing",
			multipleRealPublications:
				"fewer than two status-verified publications (including a peer-reviewed work) are bound to promoted motivation claims",
			latestPreprintCheck: "the latest-preprint search is incomplete",
			strongClosestPriorWorkComparison: "the closest-prior-work comparison is incomplete",
			mechanisticExplanation: "the mechanistic explanation is missing",
			falsifiableHypothesis: "the hypothesis is not falsifiable",
			feasibleExperiment: "the experiment is not demonstrably feasible",
			preliminaryEvidence: "no completed preliminary experiment supports the candidate",
			strongBaselinePlan: "the baseline plan is missing",
			broaderRelevance: "broader relevance has not passed",
			fourReviewSurvival: "the candidate has not survived all four reviewers",
			supervisorProgressing: "the retained supervisor has not cleared the promoted cycle as progressing",
		};
		const reasons = (Object.keys(checks) as Array<keyof typeof checks>)
			.filter((key) => !checks[key])
			.map((key) => labels[key]);
		return {
			passed: reasons.length === 0,
			candidateId: promoted?.candidate.candidateId,
			checks,
			reasons,
		};
	}

	exportDeliverable(requireStopGate = false): Record<string, unknown> {
		const stopGate = this.evaluateStopGate();
		if (requireStopGate && !stopGate.passed) {
			throw new Error(`final autoresearch deliverable is blocked: ${stopGate.reasons.join("; ")}`);
		}
		const rejectedCycles = this.state.cycles.filter(
			(cycle) => cycle.outcome === "rejected" || cycle.outcome === "experiment_failed",
		);
		return {
			deliverable_version: 1,
			stop_gate: stopGate,
			final_problem_statement:
				[...this.state.cycles].reverse().find((cycle) => cycle.outcome === "promoted")?.candidate ?? null,
			publication_table: this.state.publications,
			claim_evidence_provenance_ledger: this.state.claims,
			literature_map: this.state.fieldMaps,
			assumption_matrix: this.state.fieldMaps.assumptions,
			limitation_matrix: this.state.fieldMaps.limitations,
			contradiction_matrix: this.state.fieldMaps.contradictions,
			closest_prior_work_matrix: this.state.fieldMaps.closest_prior_work,
			rejected_idea_log: rejectedCycles.map((cycle) => ({
				candidate: cycle.candidate,
				reason: cycle.rejectionReason ?? cycle.outcome,
				prior_art_cluster: cycle.priorArtCluster,
			})),
			novelty_threats: this.state.cycles
				.filter((cycle) => cycle.priorArtCluster)
				.map((cycle) => ({ candidate_id: cycle.candidate.candidateId, cluster: cycle.priorArtCluster })),
			research_questions: this.state.cycles.flatMap((cycle) => cycle.candidate.unresolvedQuestions),
			objectives: this.state.objective ? [this.state.objective] : [],
			contribution_hypotheses: this.state.claims.filter((claim) => claim.claimType === "MECHANISTIC_HYPOTHESIS"),
			falsifiers: this.state.cycles.map((cycle) => ({
				candidate_id: cycle.candidate.candidateId,
				falsifier: cycle.candidate.falsifier,
			})),
			experiment_design: {
				candidate_designs: this.state.cycles.map((cycle) => ({
					candidate_id: cycle.candidate.candidateId,
					design: cycle.candidate.experimentDesign,
					baselines: cycle.candidate.baselinePlan,
				})),
				experiment_ledger: this.state.experiments,
			},
			required_apis_data_compute: normalizeList([
				...this.state.cycles.flatMap((cycle) => cycle.candidate.requirements),
				...this.state.experiments.flatMap((experiment) => [
					...experiment.dataRequirements,
					...experiment.codeRequirements,
					...experiment.computeRequirements,
				]),
			]),
			supervisor_intervention_history: this.state.supervision,
			canonical_research_lineage: this.state.lineage,
		};
	}
}

export function buildAutoresearchSupervisorPrompt(objective: string, topic?: string): string {
	return [
		"You are the retained AVO-style supervisor for a publication-grounded autonomous research run.",
		`Objective: ${objective}`,
		topic ? `Topic: ${topic}` : undefined,
		"Monitor trajectory health, not the local quality of one candidate. The host will send one compact JSON packet after every major research cycle.",
		"Look specifically for: idea repetition; recurring prior-art collisions; literature reading that does not change field maps; weak or benchmark-only problems; experimental dead ends; claims stronger than their evidence; search-space collapse around one mechanism or vocabulary; and contradictions that the root ignores.",
		"Treat these as desk-reject trajectory warnings: only model X on dataset Y, an A+B combination, closest work already contains the core idea, a performance gap without mechanism, no reason the field should care, no discriminating falsifier, one-preprint-only evidence, unavailable ground truth, or benchmark-specific contribution.",
		"Never declare novelty, mutate canonical research state, fabricate citations, or override evidence. The root research agent retains those responsibilities.",
		"For every packet, reply to the parent with the literal line AUTORESEARCH_SUPERVISION_JSON:<cycle_id>, then one JSON object using keys: status, reason, detected_pattern, intervention_needed, cycle_id, diagnosis, failed_search_pattern, assumption_to_question, alternative_directions.",
		"status is progressing, watch, or intervene. When status is intervene, alternative_directions must contain exactly three objects with direction, why_different, kill_search, falsifier, and integer priority.",
		"When intervention is unnecessary, use an empty alternative_directions array. Do not repeat an earlier direction unless new evidence makes revisiting it rational.",
		"Send the marker and JSON together with await agent_message.send(marked_json_text, receiver_role='parent').",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n\n");
}

export function buildAutoresearchReviewerPrompts(
	candidate: AutoresearchCandidate,
	state: AutoresearchState,
): Record<AutoresearchReviewerRole, string> {
	const shared = JSON.stringify(
		{
			objective: state.objective,
			topic: state.topic,
			candidate,
			canonical_findings: canonicalClaimSummaries(state),
			field_maps: state.fieldMaps,
			publications: state.publications.slice(-50),
		},
		null,
		2,
	);
	const response = `Reply to the parent with the literal line AUTORESEARCH_REVIEW_JSON:${candidate.candidateId}, then one JSON object with candidate_id, role, verdict (pass|revise|reject), summary, and objections. Send it with agent_message.send. Treat missing evidence as missing; never invent a source.`;
	return {
		literature_auditor: `Act as Reviewer A, the Literature Auditor. Verify whether every problem-statement claim is supported and whether wording exceeds the evidence. Inspect full text when available.\n\n${shared}\n\n${response}`,
		prior_art_killer: `Act as Reviewer B, the Prior-Art Killer. Use Prime's native search/web tools to search synonyms, adjacent terminology, backward references, forward citations, related work, and recent preprints for the same mechanism. Try to kill novelty aggressively.\n\n${shared}\n\n${response}`,
		experimental_critic: `Act as Reviewer C, the Experimental Critic. Test falsifiability, feasibility, confounds, data access, baseline strength, hypothesis separation, validation, reproducibility, and general applicability.\n\n${shared}\n\n${response}`,
		top_tier_editor: `Act as Reviewer D, the Top-Tier Editor. Apply a demanding editorial filter: technical soundness, strength of evidence, novelty, field importance, a real technical challenge, comparison with previous approaches, broad relevance, and whether this is more than an incremental A+B or benchmark-only result. These are hostile review questions, not an acceptance guarantee.\n\n${shared}\n\n${response}`,
	};
}
