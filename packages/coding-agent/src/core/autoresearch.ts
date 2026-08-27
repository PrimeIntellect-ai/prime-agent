import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const AUTORESEARCH_SKILL_NAME = "autoresearch";
export const AUTORESEARCH_STATE_VERSION = 4;

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
const EVIDENCE_KINDS = ["text", "figure", "table", "result", "code", "dataset"] as const;
const PUBLICATION_STATUSES = ["preprint", "published", "peer_reviewed_verified", "published_status_unclear"] as const;
const PUBLICATION_VERIFICATION_SOURCES = ["crossref", "arxiv"] as const;
const SEARCH_COVERAGE_KINDS = [
	"mechanism_queries",
	"synonyms_and_adjacent",
	"backward_references",
	"forward_citations",
	"related_recommendations",
	"recent_12_to_24_months",
	"recent_preprints",
	"surveys_or_reviews",
] as const;
const SEARCH_SOURCES = [
	"google_search",
	"arxiv",
	"crossref",
	"publisher",
	"repository",
	"citation_graph",
	"other",
] as const;
const CYCLE_OUTCOMES = ["rejected", "revised", "survived", "experiment_failed", "promoted"] as const;
const REVIEWER_ROLES = ["literature_auditor", "prior_art_killer", "experimental_critic", "top_tier_editor"] as const;
const REVIEWER_VERDICTS = ["pass", "revise", "reject"] as const;
const SUPERVISOR_STATUSES = ["progressing", "watch", "intervene"] as const;
const SUPERVISION_SOURCES = ["retained_supervisor_message", "manual_recovery"] as const;
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

const AUTORESEARCH_BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	AUTORESEARCH_BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["100::", 64],
	["100:0:0:1::", 64],
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
	["5f00::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const) {
	AUTORESEARCH_BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

export function isPublicAutoresearchAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return !AUTORESEARCH_BLOCKED_ADDRESSES.check(address, "ipv4");
	if (family === 6) {
		return !AUTORESEARCH_BLOCKED_ADDRESSES.check(address.toLowerCase().split("%", 1)[0]!, "ipv6");
	}
	return false;
}

export type AutoresearchFieldMapKind = (typeof FIELD_MAP_KINDS)[number];
export type AutoresearchClaimType = (typeof CLAIM_TYPES)[number];
export type AutoresearchSourceType = (typeof SOURCE_TYPES)[number];
export type AutoresearchEvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type AutoresearchPublicationStatus = (typeof PUBLICATION_STATUSES)[number];
export type AutoresearchPublicationVerificationSource = (typeof PUBLICATION_VERIFICATION_SOURCES)[number];
export type AutoresearchSearchCoverageKind = (typeof SEARCH_COVERAGE_KINDS)[number];
export type AutoresearchSearchSource = (typeof SEARCH_SOURCES)[number];
export type AutoresearchCycleOutcome = (typeof CYCLE_OUTCOMES)[number];
export type AutoresearchReviewerRole = (typeof REVIEWER_ROLES)[number];
export type AutoresearchReviewerVerdict = (typeof REVIEWER_VERDICTS)[number];
export type AutoresearchSupervisorStatus = (typeof SUPERVISOR_STATUSES)[number];
export type AutoresearchSupervisionSource = (typeof SUPERVISION_SOURCES)[number];
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

export interface AutoresearchPublicationVerification {
	verificationId: string;
	paperId: string;
	source: AutoresearchPublicationVerificationSource;
	publicationStatus: AutoresearchPublicationStatus;
	verifiedAt: string;
	metadataDigest: string;
	resolvedMetadata: {
		title: string;
		authors: string[];
		year?: number;
		venue?: string;
		doi?: string;
		preprintId?: string;
		fullTextUrl?: string;
	};
}

export interface AutoresearchPeerReviewVerification {
	verificationId: string;
	paperId: string;
	source: "publisher";
	evidenceUrl: string;
	exactQuote: string;
	verifiedAt: string;
	evidenceDigest: string;
}

export interface AutoresearchEvidenceBinding {
	sourceType: AutoresearchSourceType;
	sourceId: string;
	exactPointer: string;
	evidenceKind: AutoresearchEvidenceKind;
	exactQuote?: string;
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
	queries: string[];
	inspectedPaperIds: string[];
	evidenceBindings: Array<{
		paperId: string;
		exactPointer: string;
		finding: string;
	}>;
	collisionPaperIds: string[];
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

export interface AutoresearchSearchReceipt {
	receiptId: string;
	candidateId: string;
	candidateDigest: string;
	coverageKind: AutoresearchSearchCoverageKind;
	query: string;
	source: AutoresearchSearchSource;
	resultUrls: string[];
	inspectedPaperIds: string[];
	recordedAt: string;
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
	artifactReceipts: AutoresearchArtifactReceipt[];
	metrics: Record<string, number | string | boolean>;
	results?: string;
	interpretation?: string;
	confounds: string[];
	status: AutoresearchExperimentStatus;
	createdAt: string;
	updatedAt: string;
}

export interface AutoresearchArtifactReceipt {
	path: string;
	sha256: string;
	size: number;
	verifiedAt: string;
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

export interface AutoresearchMemoryReflection {
	reflectionId: string;
	trigger: "five_cycles" | "supervisor_intervention" | "candidate_promotion" | "manual";
	cycleId?: string;
	report: Record<string, number | string | boolean>;
	archivedMemoryIds: string[];
	recordedAt: string;
}

export interface AutoresearchCollectedReview {
	messageId: string;
	candidateId: string;
	assignmentId: string;
	reviewerChildId: string;
	reviewerName: string;
	recordedAt: string;
	reviewer: AutoresearchReviewerResult;
}

export interface AutoresearchReviewerAssignment {
	assignmentId: string;
	candidateId: string;
	candidateDigest: string;
	role: AutoresearchReviewerRole;
	rlmChildId: string;
	name: string;
	assignedAt: string;
}

export interface AutoresearchAgentSender {
	activeSessionId?: string;
	sessionId?: string;
	sessionName?: string;
	clientId?: string;
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
	searchReceiptIds: string[];
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
	source: AutoresearchSupervisionSource;
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
	publicationVerifications: AutoresearchPublicationVerification[];
	peerReviewVerifications: AutoresearchPeerReviewVerification[];
	checkpointedPublicationKeys: string[];
	claims: AutoresearchClaim[];
	experiments: AutoresearchExperiment[];
	memories: AutoresearchMemory[];
	memoryReusePlans: AutoresearchMemoryReusePlan[];
	memoryReflections: AutoresearchMemoryReflection[];
	searchReceipts: AutoresearchSearchReceipt[];
	reviewerAssignments: AutoresearchReviewerAssignment[];
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
		publicationVerifications: [],
		peerReviewVerifications: [],
		checkpointedPublicationKeys: [],
		claims: [],
		experiments: [],
		memories: [],
		memoryReusePlans: [],
		memoryReflections: [],
		searchReceipts: [],
		reviewerAssignments: [],
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

function requirePublicHttpsUrl(value: unknown, label: string): string {
	const raw = requireString(value, label);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`${label} must be a valid URL`);
	}
	const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		!hostname ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".test") ||
		hostname.endsWith(".invalid") ||
		isIP(hostname) !== 0
	) {
		throw new Error(`${label} must be a credential-free public HTTPS URL`);
	}
	return parsed.toString();
}

function isPositivePeerReviewEvidenceQuote(value: string): boolean {
	const normalized = value.toLowerCase().replace(/\s+/g, " ");
	const uncertaintyOrNegation =
		/\b(?:no|not|never|nobody|neither|nor|without|non[\s-]?peer|unrefereed|exempt(?:ed)?|exclude[ds]?|waiv(?:e|ed)|bypass(?:ed)?|may|might|could|possibly|perhaps|uncertain|but|however|although|despite|distinct)\b/i;
	if (uncertaintyOrNegation.test(normalized)) return false;
	const item = String.raw`(?:this|the)\s+(?:article|paper|manuscript|study|work|item)`;
	const publicationTiming = String.raw`(?:\s+(?:before|prior\s+to)\s+publication)?`;
	const directReview = new RegExp(
		String.raw`^${item}\s+(?:was|is|has\s+been|had\s+been)\s+(?:independently\s+|externally\s+)?(?:peer[\s-]?reviewed|refereed)(?:\s+by\s+(?:independent|external)\s+reviewers)?${publicationTiming}[.!]$`,
		"i",
	);
	const reviewProcess = new RegExp(
		String.raw`^${item}\s+(?:underwent|has\s+undergone|had\s+undergone|was\s+subjected\s+to)\s+(?:an?\s+)?(?:independent\s+|external\s+)?peer[\s-]?review${publicationTiming}[.!]$`,
		"i",
	);
	return directReview.test(normalized) || reviewProcess.test(normalized);
}

function autoresearchHtmlAttribute(attributes: string, name: string): string | undefined {
	const match = new RegExp(String.raw`(?:^|\s)${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))`, "i").exec(
		attributes,
	);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

const SUPPRESSED_AUTORESEARCH_HTML_TAGS = new Set([
	"head",
	"script",
	"style",
	"template",
	"noscript",
	"svg",
	"math",
	"iframe",
	"object",
	"canvas",
	"nav",
	"footer",
	"aside",
	"s",
	"strike",
	"del",
]);

function suppressAutoresearchHtmlElement(tag: string, attributes: string): boolean {
	if (SUPPRESSED_AUTORESEARCH_HTML_TAGS.has(tag)) return true;
	if (/(?:^|\s)hidden(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/i.test(attributes)) return true;
	if (autoresearchHtmlAttribute(attributes, "aria-hidden")?.trim().toLowerCase() === "true") return true;
	const style = autoresearchHtmlAttribute(attributes, "style")?.toLowerCase().replace(/\s+/g, "");
	if (style?.includes("display:none") || style?.includes("visibility:hidden")) return true;
	const excludedToken =
		/^(?:hidden|is-hidden|u-hidden|visually-hidden|sr-only|d-none|display-none|related(?:-content|-articles?)?|recommended|recommendations|also-read|more-like-this|reference-list|citation-list)(?:[-_].*)?$/;
	for (const attribute of ["class", "id"]) {
		const tokens = autoresearchHtmlAttribute(attributes, attribute)?.toLowerCase().split(/\s+/) ?? [];
		if (tokens.some((token) => excludedToken.test(token))) return true;
	}
	return false;
}

function autoresearchHtmlTagEnd(source: string, start: number): number {
	let quote: '"' | "'" | undefined;
	for (let index = start + 1; index < source.length; index++) {
		const character = source[index];
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === ">") return index;
	}
	return -1;
}

export function visibleAutoresearchEvidenceText(source: string, lowercase = true): string {
	const asciiLowerSource = source.replace(/[A-Z]/g, (character) => character.toLowerCase());
	const suppressedTags = new Set(["script", "style"]);
	const blockTags = new Set([
		"article",
		"main",
		"section",
		"div",
		"p",
		"li",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"br",
		"hr",
		"tr",
		"td",
		"th",
		"blockquote",
		"dd",
		"dt",
	]);
	const voidTags = new Set([
		"area",
		"base",
		"br",
		"col",
		"embed",
		"hr",
		"img",
		"input",
		"link",
		"meta",
		"param",
		"source",
		"track",
		"wbr",
	]);
	const stack: Array<{ tag: string; startsSuppression: boolean; block: boolean }> = [];
	const chunks: string[] = [];
	let suppressionDepth = 0;
	let cursor = 0;
	while (cursor < source.length) {
		const top = stack.at(-1);
		if (top && top.startsSuppression && suppressedTags.has(top.tag)) {
			const closeIndex = asciiLowerSource.indexOf(`</${top.tag}`, cursor);
			if (closeIndex < 0) break;
			cursor = closeIndex;
		}
		const tagStart = source.indexOf("<", cursor);
		if (tagStart < 0) {
			if (suppressionDepth === 0) chunks.push(source.slice(cursor));
			break;
		}
		if (suppressionDepth === 0 && tagStart > cursor) chunks.push(source.slice(cursor, tagStart));
		if (source.startsWith("<!--", tagStart)) {
			const commentEnd = source.indexOf("-->", tagStart + 4);
			cursor = commentEnd < 0 ? source.length : commentEnd + 3;
			continue;
		}
		const tagEnd = autoresearchHtmlTagEnd(source, tagStart);
		if (tagEnd < 0) {
			if (suppressionDepth === 0) chunks.push(source.slice(tagStart));
			break;
		}
		const token = source.slice(tagStart + 1, tagEnd).trim();
		const closing = /^\/\s*([a-z][\w:-]*)/i.exec(token);
		if (closing) {
			const tag = closing[1]!.toLowerCase();
			let matchIndex = -1;
			for (let index = stack.length - 1; index >= 0; index--) {
				if (stack[index]?.tag === tag) {
					matchIndex = index;
					break;
				}
			}
			if (matchIndex >= 0) {
				let closedBlock = false;
				while (stack.length > matchIndex) {
					const frame = stack.pop()!;
					if (frame.startsSuppression) suppressionDepth--;
					closedBlock ||= frame.block;
				}
				if (suppressionDepth === 0 && closedBlock) chunks.push("\n");
			}
			cursor = tagEnd + 1;
			continue;
		}
		const opening = /^([a-z][\w:-]*)/i.exec(token);
		if (!opening) {
			cursor = tagEnd + 1;
			continue;
		}
		const tag = opening[1]!.toLowerCase();
		const attributes = token.slice(opening[0].length).replace(/\/\s*$/, "");
		const block = blockTags.has(tag);
		const startsSuppression = suppressAutoresearchHtmlElement(tag, attributes);
		if (suppressionDepth === 0 && block) chunks.push("\n");
		if (startsSuppression) suppressionDepth++;
		const selfClosing = /\/\s*$/.test(token) || voidTags.has(tag);
		if (selfClosing) {
			if (startsSuppression) suppressionDepth--;
		} else {
			stack.push({ tag, startsSuppression, block });
		}
		cursor = tagEnd + 1;
	}
	const decodeCodePoint = (value: string, radix: number): string => {
		const codePoint = Number.parseInt(value, radix);
		return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
			? String.fromCodePoint(codePoint)
			: " ";
	};
	const visible = chunks
		.join("")
		.replace(/&#x([0-9a-f]+);/gi, (_match, value: string) => decodeCodePoint(value, 16))
		.replace(/&#(\d+);/g, (_match, value: string) => decodeCodePoint(value, 10))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{2,}/g, "\n")
		.trim();
	return lowercase ? visible.toLowerCase() : visible;
}

export function hasApplicablePeerReviewEvidence(documentText: string, exactQuote: string): boolean {
	if (!isPositivePeerReviewEvidenceQuote(exactQuote)) return false;
	const visible = visibleAutoresearchEvidenceText(documentText);
	const quote = exactQuote.toLowerCase().replace(/\s+/g, " ").trim();
	const hostileContext =
		/\b(?:false|not\s+true|incorrect|inaccurate|misleading|unverified|unconfirmed|disputed|hypothetical|example|sample|template|alleged|den(?:y|ies|ied)|retract(?:ed|ion)?|no|not|never|nobody|neither|nor|without|may|might|could|possibly|perhaps|uncertain|but|however|although|despite|distinct)\b/i;
	let offset = 0;
	while (offset <= visible.length - quote.length) {
		const index = visible.indexOf(quote, offset);
		if (index < 0) return false;
		const lineStart = visible.lastIndexOf("\n", index - 1) + 1;
		const punctuationStart = Math.max(
			visible.lastIndexOf(".", index - 1),
			visible.lastIndexOf("!", index - 1),
			visible.lastIndexOf("?", index - 1),
		);
		const sentenceStart = Math.max(lineStart, punctuationStart + 1);
		const leadingClause = visible.slice(sentenceStart, index).trim();
		const context = visible.slice(
			Math.max(0, sentenceStart - 160),
			Math.min(visible.length, index + quote.length + 80),
		);
		if (!leadingClause && !hostileContext.test(context)) return true;
		offset = index + 1;
	}
	return false;
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
	const suppliedStatus = source.publication_status ?? source.publicationStatus;
	if (suppliedStatus !== undefined && suppliedStatus !== "published_status_unclear") {
		throw new Error("publication status is host-verified; callers may only submit published_status_unclear");
	}
	const suppliedVerifiers = optionalStringArray(
		source.metadata_verified_by ?? source.metadataVerifiedBy,
		"publication.metadata_verified_by",
	);
	if (suppliedVerifiers.length > 0) {
		throw new Error("publication metadata verification is host-owned; callers cannot submit metadata_verified_by");
	}
	const year = source.year;
	if (year !== undefined && (!Number.isInteger(year) || (year as number) < 1000 || (year as number) > 9999)) {
		throw new Error("publication.year must be a four-digit integer when provided");
	}
	const publication: AutoresearchPublication = {
		paperId: requireString(source.paper_id ?? source.paperId, "publication.paper_id"),
		title: requireString(source.title, "publication.title"),
		authors: stringArray(source.authors, "publication.authors"),
		publicationStatus: "published_status_unclear",
		lastVerifiedAt: now,
	};
	if (publication.authors.length === 0) throw new Error("publication.authors must contain at least one author");
	if (year !== undefined) publication.year = year as number;
	const venue = optionalString(source.venue, "publication.venue");
	const paperDoi = publication.paperId.toLowerCase().startsWith("doi:") ? publication.paperId.slice(4) : undefined;
	const paperPreprintId = publication.paperId.toLowerCase().startsWith("arxiv:")
		? publication.paperId.slice(6)
		: undefined;
	const suppliedDoi = optionalString(source.doi, "publication.doi");
	const suppliedPreprintId = optionalString(source.preprint_id ?? source.preprintId, "publication.preprint_id");
	if (paperDoi && suppliedDoi && paperDoi.toLowerCase() !== suppliedDoi.toLowerCase()) {
		throw new Error("publication.paper_id and publication.doi must identify the same DOI");
	}
	if (paperPreprintId && suppliedPreprintId && paperPreprintId.toLowerCase() !== suppliedPreprintId.toLowerCase()) {
		throw new Error("publication.paper_id and publication.preprint_id must identify the same preprint");
	}
	const doi = suppliedDoi ?? paperDoi;
	const preprintId = suppliedPreprintId ?? paperPreprintId;
	const fullTextUrl = optionalString(source.full_text_url ?? source.fullTextUrl, "publication.full_text_url");
	if (venue) publication.venue = venue;
	if (doi) publication.doi = doi;
	if (preprintId) publication.preprintId = preprintId;
	if (fullTextUrl) publication.fullTextUrl = fullTextUrl;
	if (!publication.doi && !publication.preprintId && !publication.fullTextUrl) {
		throw new Error("publication must include a DOI, preprint ID, or full-text URL");
	}
	return publication;
}

export function parseAutoresearchPeerReviewEvidenceInput(value: unknown): {
	paperId: string;
	evidenceUrl: string;
	exactQuote: string;
} {
	const source = requireRecord(value, "peer_review_evidence");
	const exactQuote = requireString(source.exact_quote ?? source.exactQuote, "peer_review_evidence.exact_quote");
	if (!isPositivePeerReviewEvidenceQuote(exactQuote)) {
		throw new Error("peer_review_evidence.exact_quote must positively establish that the item was peer reviewed");
	}
	return {
		paperId: requireString(source.paper_id ?? source.paperId, "peer_review_evidence.paper_id"),
		evidenceUrl: requirePublicHttpsUrl(
			source.evidence_url ?? source.evidenceUrl,
			"peer_review_evidence.evidence_url",
		),
		exactQuote,
	};
}

function parseEvidenceBinding(value: unknown, label: string): AutoresearchEvidenceBinding {
	const source = requireRecord(value, label);
	const sourceType = enumValue(source.source_type ?? source.sourceType, SOURCE_TYPES, `${label}.source_type`);
	const evidenceKind = enumValue(
		source.evidence_kind ?? source.evidenceKind ?? "text",
		EVIDENCE_KINDS,
		`${label}.evidence_kind`,
	);
	const exactQuote = optionalString(source.exact_quote ?? source.exactQuote, `${label}.exact_quote`);
	if (sourceType === "publication" && evidenceKind === "text" && !exactQuote) {
		throw new Error(`${label}.exact_quote is required for textual publication evidence`);
	}
	const binding: AutoresearchEvidenceBinding = {
		sourceType,
		sourceId: requireString(source.source_id ?? source.sourceId, `${label}.source_id`),
		exactPointer: requireString(source.exact_pointer ?? source.exactPointer, `${label}.exact_pointer`),
		evidenceKind,
		demonstrates: requireString(source.demonstrates, `${label}.demonstrates`),
		interpretation: requireString(source.interpretation, `${label}.interpretation`),
	};
	if (exactQuote) binding.exactQuote = exactQuote;
	return binding;
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

export function parseAutoresearchSearchReceiptInput(
	candidate: AutoresearchCandidate,
	value: unknown,
	now = new Date().toISOString(),
): AutoresearchSearchReceipt {
	const source = requireRecord(value, "search_receipt");
	const resultUrls = normalizeList(
		stringArray(source.result_urls ?? source.resultUrls, "search_receipt.result_urls").map((url, index) =>
			requirePublicHttpsUrl(url, `search_receipt.result_urls[${index}]`),
		),
	);
	const inspectedPaperIds = normalizeList(
		stringArray(source.inspected_paper_ids ?? source.inspectedPaperIds, "search_receipt.inspected_paper_ids"),
	);
	if (resultUrls.length === 0) throw new Error("search_receipt.result_urls must not be empty");
	if (inspectedPaperIds.length === 0) throw new Error("search_receipt.inspected_paper_ids must not be empty");
	return {
		receiptId: `search-receipt-${randomUUID()}`,
		candidateId: candidate.candidateId,
		candidateDigest: candidateDigest(candidate),
		coverageKind: enumValue(
			source.coverage_kind ?? source.coverageKind,
			SEARCH_COVERAGE_KINDS,
			"search_receipt.coverage_kind",
		),
		query: requireString(source.query, "search_receipt.query"),
		source: enumValue(source.source, SEARCH_SOURCES, "search_receipt.source"),
		resultUrls,
		inspectedPaperIds,
		recordedAt: now,
	};
}

function parseReviewer(value: unknown, index: number): AutoresearchReviewerResult {
	const source = requireRecord(value, `cycle.reviewers[${index}]`);
	const rawBindings = source.evidence_bindings ?? source.evidenceBindings ?? [];
	if (!Array.isArray(rawBindings)) throw new Error(`cycle.reviewers[${index}].evidence_bindings must be an array`);
	return {
		role: enumValue(source.role, REVIEWER_ROLES, `cycle.reviewers[${index}].role`),
		verdict: enumValue(source.verdict, REVIEWER_VERDICTS, `cycle.reviewers[${index}].verdict`),
		summary: requireString(source.summary, `cycle.reviewers[${index}].summary`),
		objections: optionalStringArray(source.objections, `cycle.reviewers[${index}].objections`),
		queries: optionalStringArray(source.queries, `cycle.reviewers[${index}].queries`),
		inspectedPaperIds: normalizeList(
			optionalStringArray(
				source.inspected_paper_ids ?? source.inspectedPaperIds,
				`cycle.reviewers[${index}].inspected_paper_ids`,
			),
		),
		evidenceBindings: rawBindings.map((binding, bindingIndex) => {
			const record = requireRecord(binding, `cycle.reviewers[${index}].evidence_bindings[${bindingIndex}]`);
			return {
				paperId: requireString(
					record.paper_id ?? record.paperId,
					`cycle.reviewers[${index}].evidence_bindings[${bindingIndex}].paper_id`,
				),
				exactPointer: requireString(
					record.exact_pointer ?? record.exactPointer,
					`cycle.reviewers[${index}].evidence_bindings[${bindingIndex}].exact_pointer`,
				),
				finding: requireString(
					record.finding,
					`cycle.reviewers[${index}].evidence_bindings[${bindingIndex}].finding`,
				),
			};
		}),
		collisionPaperIds: normalizeList(
			optionalStringArray(
				source.collision_paper_ids ?? source.collisionPaperIds,
				`cycle.reviewers[${index}].collision_paper_ids`,
			),
		),
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

function emptySearchCoverage(): AutoresearchSearchCoverage {
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
		artifactReceipts: [],
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
	if (source.reviewers !== undefined) {
		throw new Error("cycle.reviewers is host-owned; use autoresearch.review_candidate before completing the cycle");
	}
	if (source.search_coverage !== undefined || source.searchCoverage !== undefined) {
		throw new Error(
			"cycle.search_coverage is host-owned; record candidate-bound search receipts before completing the cycle",
		);
	}
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
		gates:
			source.gates === undefined
				? {
						important: false,
						unresolved: false,
						publicationBacked: false,
						mechanisticallyMotivated: false,
						falsifiable: false,
						feasible: false,
						closestPriorWorkAnalyzed: false,
						broaderRelevance: false,
					}
				: parseGates(source.gates),
		searchCoverage: emptySearchCoverage(),
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

function validateCycleGate(input: AutoresearchCycleInput, reviewers?: AutoresearchReviewerResult[]): void {
	const roles = new Set((reviewers ?? []).map((reviewer) => reviewer.role));
	if (reviewers && roles.size !== reviewers.length) {
		throw new Error("host-collected reviews must not repeat a reviewer role");
	}
	if (input.outcome === "rejected" && !input.rejectionReason) {
		throw new Error("a rejected cycle requires rejection_reason");
	}
	if (input.outcome === "promoted" && input.canonicalPromotionIds.length === 0) {
		throw new Error("a promoted cycle requires canonical_promotion_ids");
	}
	if (!reviewers) return;
	const missingRoles = REVIEWER_ROLES.filter((role) => !roles.has(role));
	if (missingRoles.length > 0) {
		throw new Error(
			`every completed major cycle requires all four reviewer roles; missing: ${missingRoles.join(", ")}`,
		);
	}
	if (input.outcome !== "survived" && input.outcome !== "promoted") return;
	const failedReview = reviewers.find((reviewer) => reviewer.verdict !== "pass");
	if (failedReview) throw new Error(`surviving candidates require passing reviews; ${failedReview.role} did not pass`);
	const missingCoverage = Object.entries(input.searchCoverage).find(([, covered]) => !covered);
	if (missingCoverage) {
		throw new Error(
			`surviving candidates require complete literature-search coverage; ${missingCoverage[0]} is missing`,
		);
	}
	const failedGate = Object.entries(input.gates).find(([, passed]) => !passed);
	if (failedGate) throw new Error(`surviving candidates require every problem gate; ${failedGate[0]} did not pass`);
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
	provenance: AutoresearchSupervisionSource = "manual_recovery",
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
		source: provenance,
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
	const supervision = parseAutoresearchSupervisionInput(source, now, "retained_supervisor_message");
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
		Array.isArray(value.publicationVerifications) &&
		Array.isArray(value.peerReviewVerifications) &&
		Array.isArray(value.checkpointedPublicationKeys) &&
		Array.isArray(value.claims) &&
		Array.isArray(value.experiments) &&
		Array.isArray(value.memories) &&
		Array.isArray(value.memoryReusePlans) &&
		Array.isArray(value.memoryReflections) &&
		Array.isArray(value.searchReceipts) &&
		Array.isArray(value.reviewerAssignments) &&
		Array.isArray(value.collectedReviews) &&
		Array.isArray(value.ingestedAgentMessageIds) &&
		FIELD_MAP_KINDS.every((kind) => Array.isArray(fieldMaps[kind])) &&
		Array.isArray(value.cycles) &&
		Array.isArray(value.supervision) &&
		Array.isArray(value.lineage)
	);
}

function migrateAutoresearchState(value: unknown): unknown {
	if (!isRecord(value)) return value;
	if (value.schemaVersion === 3) {
		const publications = Array.isArray(value.publications)
			? value.publications.map((item) =>
					isRecord(item) && item.publicationStatus === "peer_reviewed"
						? { ...item, publicationStatus: "published" }
						: item,
				)
			: [];
		const publicationVerifications = Array.isArray(value.publicationVerifications)
			? value.publicationVerifications.map((item) =>
					isRecord(item) && item.publicationStatus === "peer_reviewed"
						? { ...item, publicationStatus: "published" }
						: item,
				)
			: [];
		const cycles = Array.isArray(value.cycles)
			? value.cycles.map((item) =>
					isRecord(item) ? { ...item, searchCoverage: emptySearchCoverage(), searchReceiptIds: [] } : item,
				)
			: [];
		return {
			...value,
			schemaVersion: AUTORESEARCH_STATE_VERSION,
			publications,
			publicationVerifications,
			peerReviewVerifications: [],
			memoryReflections: [],
			searchReceipts: [],
			cycles,
		};
	}
	if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return value;
	const cycles = Array.isArray(value.cycles)
		? value.cycles.map((item) => {
				if (!isRecord(item)) return item;
				return {
					...item,
					searchCoverage: emptySearchCoverage(),
					searchReceiptIds: [],
					motivationPaperIds: item.motivationPaperIds ?? [],
					closestPriorWorkPaperIds: item.closestPriorWorkPaperIds ?? [],
					preliminaryEvidenceExperimentIds: item.preliminaryEvidenceExperimentIds ?? [],
				};
			})
		: value.cycles;
	const publications = Array.isArray(value.publications)
		? value.publications.map((item) =>
				isRecord(item)
					? {
							...item,
							publicationStatus: "published_status_unclear",
							metadataVerifiedBy: undefined,
						}
					: item,
			)
		: [];
	const experiments = Array.isArray(value.experiments)
		? value.experiments.map((item) => (isRecord(item) ? { ...item, artifactReceipts: [] } : item))
		: [];
	const claims = Array.isArray(value.claims)
		? value.claims.map((item) => {
				if (!isRecord(item)) return item;
				const migrateBindings = (bindings: unknown): unknown =>
					Array.isArray(bindings)
						? bindings.map((binding) => (isRecord(binding) ? { evidenceKind: "text", ...binding } : binding))
						: bindings;
				return {
					...item,
					supportingEvidence: migrateBindings(item.supportingEvidence),
					contradictingEvidence: migrateBindings(item.contradictingEvidence),
				};
			})
		: [];
	const supervision = Array.isArray(value.supervision)
		? value.supervision.map((item) => (isRecord(item) ? { ...item, source: item.source ?? "manual_recovery" } : item))
		: [];
	return migrateAutoresearchState({
		...value,
		schemaVersion: 3,
		publications,
		publicationVerifications: [],
		claims,
		experiments,
		memories: Array.isArray(value.memories) ? value.memories : [],
		memoryReusePlans: Array.isArray(value.memoryReusePlans) ? value.memoryReusePlans : [],
		reviewerAssignments: [],
		collectedReviews: [],
		ingestedAgentMessageIds: Array.isArray(value.ingestedAgentMessageIds) ? value.ingestedAgentMessageIds : [],
		cycles,
		supervision,
	});
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

function candidateDigest(candidate: AutoresearchCandidate): string {
	return createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
}

function searchCoverageProperty(kind: AutoresearchSearchCoverageKind): keyof AutoresearchSearchCoverage {
	switch (kind) {
		case "mechanism_queries":
			return "mechanismQueries";
		case "synonyms_and_adjacent":
			return "synonymsAndAdjacent";
		case "backward_references":
			return "backwardReferences";
		case "forward_citations":
			return "forwardCitations";
		case "related_recommendations":
			return "relatedRecommendations";
		case "recent_12_to_24_months":
			return "recent12To24Months";
		case "recent_preprints":
			return "recentPreprints";
		case "surveys_or_reviews":
			return "surveysOrReviews";
	}
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
		private readonly workspaceDir: string = process.cwd(),
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
		if (existing >= 0) {
			const current = this.state.publications[existing]!;
			const isVerified = this.state.publicationVerifications.some((item) => item.paperId === current.paperId);
			this.state.publications[existing] = isVerified
				? {
						...current,
						doi: current.doi ?? publication.doi,
						preprintId: current.preprintId ?? publication.preprintId,
						fullTextUrl: current.fullTextUrl ?? publication.fullTextUrl,
					}
				: publication;
		} else this.state.publications.push(publication);
		this.save();
		return structuredClone(this.state.publications[existing >= 0 ? existing : this.state.publications.length - 1]!);
	}

	recordPublicationVerification(
		verification: AutoresearchPublicationVerification,
	): AutoresearchPublicationVerification {
		const publication = this.state.publications.find((item) => item.paperId === verification.paperId);
		if (!publication) throw new Error(`publication verification references unknown paper ${verification.paperId}`);
		if (!/^[a-f0-9]{64}$/i.test(verification.metadataDigest)) {
			throw new Error("publication verification metadata digest must be SHA-256");
		}
		if (verification.publicationStatus === "peer_reviewed_verified") {
			throw new Error("publication metadata cannot establish peer review; use publisher evidence verification");
		}
		if (verification.source === "crossref" && verification.publicationStatus === "preprint") {
			throw new Error("Crossref metadata verification cannot classify an item as a preprint");
		}
		if (verification.source === "arxiv" && verification.publicationStatus !== "preprint") {
			throw new Error("arXiv metadata verification may only classify an item as a preprint");
		}
		if (
			verification.source === "crossref" &&
			(!verification.resolvedMetadata.doi ||
				(!!publication.doi && verification.resolvedMetadata.doi.toLowerCase() !== publication.doi.toLowerCase()))
		) {
			throw new Error("Crossref verification must resolve the publication DOI");
		}
		if (
			verification.source === "arxiv" &&
			(!verification.resolvedMetadata.preprintId ||
				(!!publication.preprintId &&
					verification.resolvedMetadata.preprintId.toLowerCase() !== publication.preprintId.toLowerCase()))
		) {
			throw new Error("arXiv verification must resolve the publication preprint ID");
		}
		if (this.state.publicationVerifications.some((item) => item.verificationId === verification.verificationId)) {
			throw new Error(`publication verification ${verification.verificationId} already exists`);
		}
		const metadata = verification.resolvedMetadata;
		publication.title = requireString(metadata.title, "publication verification title");
		publication.authors = normalizeList(metadata.authors);
		if (publication.authors.length === 0) throw new Error("publication verification requires at least one author");
		publication.publicationStatus = verification.publicationStatus;
		publication.lastVerifiedAt = verification.verifiedAt;
		publication.metadataVerifiedBy = normalizeList([...(publication.metadataVerifiedBy ?? []), verification.source]);
		if (metadata.year !== undefined) publication.year = metadata.year;
		if (metadata.venue) publication.venue = metadata.venue;
		if (metadata.doi) publication.doi = metadata.doi;
		if (metadata.preprintId) publication.preprintId = metadata.preprintId;
		if (metadata.fullTextUrl) publication.fullTextUrl = metadata.fullTextUrl;
		this.state.publicationVerifications.push(structuredClone(verification));
		this.save();
		return structuredClone(verification);
	}

	recordPeerReviewVerification(verification: AutoresearchPeerReviewVerification): AutoresearchPeerReviewVerification {
		const publication = this.state.publications.find((item) => item.paperId === verification.paperId);
		if (!publication) throw new Error(`peer-review verification references unknown paper ${verification.paperId}`);
		if (publication.publicationStatus !== "published") {
			throw new Error("peer-review verification requires a host-verified published item");
		}
		if (!this.state.publicationVerifications.some((item) => item.paperId === verification.paperId)) {
			throw new Error("peer-review verification requires a publication metadata receipt");
		}
		if (!/^[a-f0-9]{64}$/i.test(verification.evidenceDigest)) {
			throw new Error("peer-review evidence digest must be SHA-256");
		}
		if (!isPositivePeerReviewEvidenceQuote(verification.exactQuote)) {
			throw new Error("peer-review evidence must positively establish that the item was peer reviewed");
		}
		if (this.state.peerReviewVerifications.some((item) => item.paperId === verification.paperId)) {
			throw new Error(`publication ${verification.paperId} already has peer-review verification`);
		}
		publication.publicationStatus = "peer_reviewed_verified";
		publication.lastVerifiedAt = verification.verifiedAt;
		publication.metadataVerifiedBy = normalizeList([
			...(publication.metadataVerifiedBy ?? []),
			"publisher_peer_review_evidence",
		]);
		this.state.peerReviewVerifications.push(structuredClone(verification));
		this.save();
		return structuredClone(verification);
	}

	recordSearchReceipt(receipt: AutoresearchSearchReceipt): AutoresearchSearchReceipt {
		const existing = this.state.searchReceipts.find(
			(item) => item.candidateId === receipt.candidateId && item.coverageKind === receipt.coverageKind,
		);
		if (existing) {
			if (existing.candidateDigest !== receipt.candidateDigest) {
				throw new Error(`candidate ${receipt.candidateId} changed after search receipts were recorded`);
			}
			throw new Error(`candidate ${receipt.candidateId} already has ${receipt.coverageKind} search evidence`);
		}
		for (const paperId of receipt.inspectedPaperIds) {
			const publication = this.state.publications.find((item) => item.paperId === paperId);
			const verification = this.state.publicationVerifications.find((item) => item.paperId === paperId);
			if (!publication || !verification) {
				throw new Error(`search receipt inspected paper ${paperId} is not in the verified publication ledger`);
			}
		}
		this.state.searchReceipts.push(structuredClone(receipt));
		this.save();
		return structuredClone(receipt);
	}

	getSearchReceipts(candidate: AutoresearchCandidate): AutoresearchSearchReceipt[] {
		const digest = candidateDigest(candidate);
		return this.state.searchReceipts
			.filter((item) => item.candidateId === candidate.candidateId && item.candidateDigest === digest)
			.map((item) => structuredClone(item));
	}

	private deriveSearchCoverage(candidate: AutoresearchCandidate): {
		coverage: AutoresearchSearchCoverage;
		receipts: AutoresearchSearchReceipt[];
	} {
		const coverage = emptySearchCoverage();
		const receipts = this.getSearchReceipts(candidate);
		for (const receipt of receipts) coverage[searchCoverageProperty(receipt.coverageKind)] = true;
		return { coverage, receipts };
	}

	recordExperiment(experiment: AutoresearchExperiment): AutoresearchExperiment {
		experiment.artifactReceipts =
			experiment.status === "completed" ? this.createArtifactReceipts(experiment.artifactPaths) : [];
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

	private createArtifactReceipts(paths: string[]): AutoresearchArtifactReceipt[] {
		return paths.map((path) => {
			const base = this.workspaceDir;
			const resolvedPath = realpathSync(isAbsolute(path) ? path : resolve(base, path));
			const stats = statSync(resolvedPath);
			if (!stats.isFile()) throw new Error(`experiment artifact is not a file: ${path}`);
			return {
				path: resolvedPath,
				sha256: createHash("sha256").update(readFileSync(resolvedPath)).digest("hex"),
				size: stats.size,
				verifiedAt: this.now(),
			};
		});
	}

	private experimentArtifactsAreCurrent(experiment: AutoresearchExperiment): boolean {
		if (experiment.status !== "completed" || experiment.artifactReceipts.length === 0) return false;
		try {
			return experiment.artifactReceipts.every((receipt) => {
				const stats = statSync(receipt.path);
				return (
					stats.isFile() &&
					stats.size === receipt.size &&
					createHash("sha256").update(readFileSync(receipt.path)).digest("hex") === receipt.sha256
				);
			});
		} catch {
			return false;
		}
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

	recordMemoryReflection(input: {
		trigger: AutoresearchMemoryReflection["trigger"];
		cycleId?: string;
		report: Record<string, number | string | boolean>;
		archivedMemoryIds: string[];
	}): AutoresearchMemoryReflection {
		if (input.cycleId && !this.state.cycles.some((cycle) => cycle.cycleId === input.cycleId)) {
			throw new Error(`memory reflection references unknown cycle ${input.cycleId}`);
		}
		const cycleIndex = input.cycleId ? this.state.cycles.findIndex((cycle) => cycle.cycleId === input.cycleId) : -1;
		const cycle = cycleIndex >= 0 ? this.state.cycles[cycleIndex] : undefined;
		if (input.trigger !== "manual" && !cycle) {
			throw new Error(`${input.trigger} memory reflection requires a cycle_id`);
		}
		if (input.trigger === "five_cycles" && (cycleIndex + 1) % 5 !== 0) {
			throw new Error("five_cycles memory reflection requires the fifth cycle in a milestone block");
		}
		if (input.trigger === "candidate_promotion" && cycle?.outcome !== "promoted") {
			throw new Error("candidate_promotion memory reflection requires a promoted cycle");
		}
		if (input.trigger === "supervisor_intervention") {
			const supervisedIntervention = this.state.supervision.some(
				(item) => item.cycleId === input.cycleId && item.interventionNeeded,
			);
			const hostCheckpointIntervention =
				cycleIndex === this.state.cycles.length - 1 &&
				evaluateAutoresearchCheckpoint(this.state.cycles).interventionNeeded;
			if (!supervisedIntervention && !hostCheckpointIntervention) {
				throw new Error("supervisor_intervention memory reflection requires an intervention checkpoint");
			}
		}
		const archivedMemoryIds = normalizeList(input.archivedMemoryIds);
		for (const memoryId of archivedMemoryIds) {
			const memory = this.state.memories.find((item) => item.memoryId === memoryId);
			if (!memory) throw new Error(`memory reflection archived unknown memory ${memoryId}`);
		}
		const reflection: AutoresearchMemoryReflection = {
			reflectionId: `memory-reflection-${randomUUID()}`,
			trigger: input.trigger,
			report: structuredClone(input.report),
			archivedMemoryIds,
			recordedAt: this.now(),
		};
		if (input.cycleId) reflection.cycleId = input.cycleId;
		this.state.memoryReflections.push(reflection);
		this.save();
		return structuredClone(reflection);
	}

	getCollectedReviews(candidateId: string): AutoresearchReviewerResult[] {
		const normalizedCandidateId = requireString(candidateId, "candidate_id");
		const byRole = new Map<AutoresearchReviewerRole, AutoresearchReviewerResult>();
		for (const item of this.state.collectedReviews) {
			if (item.candidateId === normalizedCandidateId) byRole.set(item.reviewer.role, item.reviewer);
		}
		return [...byRole.values()].map((reviewer) => structuredClone(reviewer));
	}

	registerReviewerAssignment(
		candidate: AutoresearchCandidate,
		role: AutoresearchReviewerRole,
		child: { rlmChildId: string; name: string },
	): AutoresearchReviewerAssignment {
		const normalizedCandidateId = requireIdentifier(candidate.candidateId, "candidate_id");
		const digest = candidateDigest(candidate);
		const existing = this.state.reviewerAssignments.find(
			(item) => item.candidateId === normalizedCandidateId && item.role === role,
		);
		if (existing) {
			if (existing.candidateDigest !== digest) {
				throw new Error(`candidate ${normalizedCandidateId} changed after reviewer assignment`);
			}
			const rlmChildId = requireString(child.rlmChildId, "reviewer rlm_child_id");
			const name = requireString(child.name, "reviewer name");
			if (existing.rlmChildId === rlmChildId && existing.name === name) return structuredClone(existing);
			const collected = this.state.collectedReviews.some(
				(item) => item.candidateId === normalizedCandidateId && item.reviewer.role === role,
			);
			if (collected) {
				throw new Error(`candidate ${normalizedCandidateId} already has a collected ${role} review`);
			}
			existing.assignmentId = `review-assignment-${randomUUID()}`;
			existing.rlmChildId = rlmChildId;
			existing.name = name;
			existing.assignedAt = this.now();
			this.save();
			return structuredClone(existing);
		}
		const assignment: AutoresearchReviewerAssignment = {
			assignmentId: `review-assignment-${randomUUID()}`,
			candidateId: normalizedCandidateId,
			candidateDigest: digest,
			role,
			rlmChildId: requireString(child.rlmChildId, "reviewer rlm_child_id"),
			name: requireString(child.name, "reviewer name"),
			assignedAt: this.now(),
		};
		this.state.reviewerAssignments.push(assignment);
		this.save();
		return structuredClone(assignment);
	}

	getReviewerAssignments(candidateId: string): AutoresearchReviewerAssignment[] {
		const normalizedCandidateId = requireIdentifier(candidateId, "candidate_id");
		return this.state.reviewerAssignments
			.filter((item) => item.candidateId === normalizedCandidateId)
			.map((item) => structuredClone(item));
	}

	private senderMatchesChild(
		sender: AutoresearchAgentSender | undefined,
		child: { rlmChildId: string; name: string },
	): boolean {
		if (!sender) return false;
		return (
			sender.sessionName === child.name ||
			[sender.activeSessionId, sender.sessionId, sender.clientId].some((value) => value === child.rlmChildId)
		);
	}

	ingestAgentMessage(
		messageId: string,
		text: string,
		sender?: AutoresearchAgentSender,
	): AutoresearchAgentPayload | undefined {
		const normalizedMessageId = requireString(messageId, "message_id");
		if (this.state.ingestedAgentMessageIds.includes(normalizedMessageId)) return undefined;
		const payload = parseAutoresearchAgentPayload(text, this.now());
		if (!payload) return undefined;
		if (payload.kind === "review") {
			const assignment = this.state.reviewerAssignments.find(
				(item) => item.candidateId === payload.candidateId && item.role === payload.reviewer.role,
			);
			if (!assignment) {
				throw new Error(`no host-owned ${payload.reviewer.role} assignment exists for ${payload.candidateId}`);
			}
			if (!this.senderMatchesChild(sender, assignment)) {
				throw new Error(`review for ${payload.candidateId} did not come from its assigned reviewer child`);
			}
			const duplicate = this.state.collectedReviews.some(
				(item) => item.candidateId === payload.candidateId && item.reviewer.role === payload.reviewer.role,
			);
			if (duplicate)
				throw new Error(`candidate ${payload.candidateId} already has a ${payload.reviewer.role} review`);
			this.state.collectedReviews.push({
				messageId: normalizedMessageId,
				candidateId: payload.candidateId,
				assignmentId: assignment.assignmentId,
				reviewerChildId: assignment.rlmChildId,
				reviewerName: assignment.name,
				recordedAt: this.now(),
				reviewer: payload.reviewer,
			});
		} else {
			if (!this.state.supervisor || !this.senderMatchesChild(sender, this.state.supervisor)) {
				throw new Error("supervision did not come from the retained supervisor child");
			}
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
				if (!this.state.publicationVerifications.some((receipt) => receipt.paperId === publication.paperId)) {
					throw new Error(`publication evidence ${binding.sourceId} requires a host verification receipt`);
				}
			}
			if (binding.sourceType === "experiment") {
				const experiment = this.state.experiments.find((item) => item.experimentId === binding.sourceId);
				if (!experiment || (experiment.status !== "completed" && experiment.status !== "failed")) {
					throw new Error(
						`experiment evidence ${binding.sourceId} must reference a completed or failed experiment`,
					);
				}
				if (experiment.status === "completed" && !this.experimentArtifactsAreCurrent(experiment)) {
					throw new Error(`experiment evidence ${binding.sourceId} has missing or modified artifact receipts`);
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

	private deriveProblemGates(
		input: AutoresearchCycleInput,
		reviewers: AutoresearchReviewerResult[],
	): AutoresearchProblemGates {
		const verifiedPaperIds = new Set(this.state.publicationVerifications.map((receipt) => receipt.paperId));
		const motivationVerified =
			input.motivationPaperIds.length >= 2 &&
			input.motivationPaperIds.every((paperId) => verifiedPaperIds.has(paperId));
		const closestVerified =
			input.closestPriorWorkPaperIds.length > 0 &&
			input.closestPriorWorkPaperIds.every((paperId) => verifiedPaperIds.has(paperId));
		const literature = reviewers.find((reviewer) => reviewer.role === "literature_auditor");
		const priorArt = reviewers.find((reviewer) => reviewer.role === "prior_art_killer");
		const experimental = reviewers.find((reviewer) => reviewer.role === "experimental_critic");
		const editor = reviewers.find((reviewer) => reviewer.role === "top_tier_editor");
		const completeSearchCoverage = Object.values(input.searchCoverage).every(Boolean);
		const promotedClaimsCoverMotivation =
			input.outcome !== "promoted" ||
			input.motivationPaperIds.every((paperId) =>
				input.canonicalPromotionIds.some((claimId) =>
					this.state.claims
						.find((claim) => claim.claimId === claimId)
						?.supportingEvidence.some(
							(binding) => binding.sourceType === "publication" && binding.sourceId === paperId,
						),
				),
			);
		return {
			important: motivationVerified && editor?.verdict === "pass" && input.candidate.motivation.trim().length > 0,
			unresolved:
				completeSearchCoverage &&
				priorArt?.verdict === "pass" &&
				priorArt.collisionPaperIds.length === 0 &&
				input.candidate.unresolvedQuestions.length > 0,
			publicationBacked: motivationVerified && promotedClaimsCoverMotivation && literature?.verdict === "pass",
			mechanisticallyMotivated:
				experimental?.verdict === "pass" && input.candidate.mechanisticMotivation.trim().length > 0,
			falsifiable: experimental?.verdict === "pass" && input.candidate.falsifier.trim().length > 0,
			feasible:
				experimental?.verdict === "pass" &&
				input.candidate.experimentDesign.trim().length > 0 &&
				input.candidate.baselinePlan.trim().length > 0,
			closestPriorWorkAnalyzed:
				closestVerified &&
				priorArt?.verdict === "pass" &&
				input.closestPriorWorkPaperIds.every((paperId) => priorArt.inspectedPaperIds.includes(paperId)) &&
				input.candidate.closestPriorArt.trim().length > 0,
			broaderRelevance: editor?.verdict === "pass" && input.candidate.broaderRelevance.trim().length > 0,
		};
	}

	private validateReviewerEvidenceForSurvival(
		input: AutoresearchCycleInput,
		reviewers: AutoresearchReviewerResult[],
	): void {
		if (input.outcome !== "survived" && input.outcome !== "promoted") return;
		const verifiedPaperIds = new Set(this.state.publicationVerifications.map((receipt) => receipt.paperId));
		const priorArt = reviewers.find((reviewer) => reviewer.role === "prior_art_killer");
		const literature = reviewers.find((reviewer) => reviewer.role === "literature_auditor");
		if (!priorArt || priorArt.queries.length === 0 || priorArt.inspectedPaperIds.length === 0) {
			throw new Error("surviving candidates require prior-art reviewer queries and inspected_paper_ids");
		}
		if (!literature || literature.evidenceBindings.length === 0) {
			throw new Error("surviving candidates require literature reviewer evidence_bindings");
		}
		for (const reviewer of reviewers) {
			for (const paperId of [
				...reviewer.inspectedPaperIds,
				...reviewer.collisionPaperIds,
				...reviewer.evidenceBindings.map((binding) => binding.paperId),
			]) {
				if (!verifiedPaperIds.has(paperId)) {
					throw new Error(`reviewer evidence references unverified paper ${paperId}`);
				}
			}
			if (reviewer.collisionPaperIds.some((paperId) => !reviewer.inspectedPaperIds.includes(paperId))) {
				throw new Error(`${reviewer.role} collision_paper_ids must be included in inspected_paper_ids`);
			}
		}
	}

	recordCycle(input: AutoresearchCycleInput): AutoresearchCycleResult {
		if (!this.state.objective) throw new Error("initialize autoresearch before completing a cycle");
		const reviewers = this.getCollectedReviews(input.candidate.candidateId);
		const searchEvidence = this.deriveSearchCoverage(input.candidate);
		input.searchCoverage = searchEvidence.coverage;
		input.gates = this.deriveProblemGates(input, reviewers);
		validateCycleGate(input, reviewers);
		this.validateReviewerEvidenceForSurvival(input, reviewers);
		const digest = candidateDigest(input.candidate);
		for (const reviewer of reviewers) {
			const assignment = this.state.reviewerAssignments.find(
				(item) => item.candidateId === input.candidate.candidateId && item.role === reviewer.role,
			);
			if (!assignment || assignment.candidateDigest !== digest) {
				throw new Error(`host-collected ${reviewer.role} review does not match the completed candidate`);
			}
		}
		for (const publication of input.publications) {
			this.addPublication(publication);
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
			const verification = this.state.publicationVerifications.find((receipt) => receipt.paperId === paperId);
			if (!publication?.metadataVerifiedBy?.length || !verification) {
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
			if (input.outcome === "promoted" && !this.experimentArtifactsAreCurrent(experiment)) {
				throw new Error(`promoted candidate evidence ${experimentId} has missing or modified artifacts`);
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
			reviewers,
			gates: input.gates,
			searchCoverage: input.searchCoverage,
			searchReceiptIds: searchEvidence.receipts.map((receipt) => receipt.receiptId),
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

	getSupervisorCheckpoint(cycleId: string): {
		cycle: AutoresearchCycle;
		checkpoint: AutoresearchCheckpoint;
		packet: Record<string, unknown>;
	} {
		const normalizedCycleId = requireIdentifier(cycleId, "cycle_id");
		const cycleIndex = this.state.cycles.findIndex((cycle) => cycle.cycleId === normalizedCycleId);
		if (cycleIndex < 0) throw new Error(`supervisor retry references unknown cycle ${normalizedCycleId}`);
		if (cycleIndex !== this.state.cycles.length - 1) {
			throw new Error("supervisor retry is only allowed for the latest durable cycle");
		}
		if (this.state.supervision.some((item) => item.cycleId === normalizedCycleId)) {
			throw new Error(`cycle ${normalizedCycleId} already has supervision`);
		}
		const cycle = this.state.cycles[cycleIndex]!;
		const checkpoint = evaluateAutoresearchCheckpoint(this.state.cycles.slice(0, cycleIndex + 1));
		return {
			cycle: structuredClone(cycle),
			checkpoint,
			packet: this.buildSupervisorPacket(cycle, checkpoint),
		};
	}

	recordSupervision(supervision: AutoresearchSupervision, persist = true): AutoresearchSupervision {
		if (!this.state.cycles.some((cycle) => cycle.cycleId === supervision.cycleId)) {
			throw new Error(`supervision references unknown cycle ${supervision.cycleId}`);
		}
		if (
			this.state.supervision.some(
				(item) => item.cycleId === supervision.cycleId && item.source === supervision.source,
			)
		) {
			throw new Error(`cycle ${supervision.cycleId} already has ${supervision.source} supervision`);
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
			search_receipts: this.state.searchReceipts
				.filter((receipt) => cycle.searchReceiptIds.includes(receipt.receiptId))
				.map((receipt) => ({
					coverage_kind: receipt.coverageKind,
					query: receipt.query,
					source: receipt.source,
					inspected_paper_ids: receipt.inspectedPaperIds,
					recorded_at: receipt.recordedAt,
				})),
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
			? [...this.state.supervision]
					.reverse()
					.find((item) => item.cycleId === promoted.cycleId && item.source === "retained_supervisor_message")
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
						this.state.publicationVerifications.some(
							(receipt) =>
								receipt.paperId === publication.paperId &&
								(receipt.publicationStatus === publication.publicationStatus ||
									(publication.publicationStatus === "peer_reviewed_verified" &&
										receipt.publicationStatus === "published")),
						) &&
						promotedClaimPublicationIds.has(publication.paperId) &&
						(promoted?.canonicalPromotionIds ?? []).some((claimId) => {
							const claim = this.state.claims.find((item) => item.claimId === claimId);
							return claim?.supportingEvidence.some(
								(binding) =>
									binding.sourceType === "publication" &&
									binding.sourceId === publication.paperId &&
									(binding.evidenceKind !== "text" || !!binding.exactQuote?.trim()),
							);
						}),
				) &&
				motivationPublications.some(
					(publication) =>
						publication.publicationStatus === "peer_reviewed_verified" &&
						this.state.peerReviewVerifications.some((receipt) => receipt.paperId === publication.paperId),
				),
			latestPreprintCheck: promoted?.searchCoverage.recentPreprints === true,
			strongClosestPriorWorkComparison:
				!!promoted?.candidate.closestPriorArt.trim() && (promoted?.closestPriorWorkPaperIds.length ?? 0) > 0,
			mechanisticExplanation: !!promoted?.candidate.mechanisticMotivation.trim(),
			falsifiableHypothesis: promoted?.gates.falsifiable === true && !!promoted.candidate.falsifier.trim(),
			feasibleExperiment: promoted?.gates.feasible === true && !!promoted.candidate.experimentDesign.trim(),
			preliminaryEvidence:
				preliminaryExperiments.length > 0 &&
				preliminaryExperiments.every(
					(experiment) => experiment.status === "completed" && this.experimentArtifactsAreCurrent(experiment),
				),
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
			publication_verification_receipts: this.state.publicationVerifications,
			peer_review_verification_receipts: this.state.peerReviewVerifications,
			search_receipt_ledger: this.state.searchReceipts,
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
			memory_reflection_history: this.state.memoryReflections,
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
		"For every packet, your first and only Python action is to build a plain dict, json.dumps it, and call await agent_message.send(marked_json_text, receiver_role='parent'). Do not inspect APIs, define Pydantic classes, or merely print the response. The marked text starts with the literal line AUTORESEARCH_SUPERVISION_JSON:<cycle_id>, then one JSON object using keys: status, reason, detected_pattern, intervention_needed, cycle_id, diagnosis, failed_search_pattern, assumption_to_question, alternative_directions.",
		'status is progressing, watch, or intervene. When status is intervene, alternative_directions must contain exactly three objects like {"direction":"one string","why_different":"one string","kill_search":"one search string","falsifier":"one string","priority":1}. kill_search MUST be a string, never a boolean.',
		"When intervention is unnecessary, use an empty alternative_directions array. Do not repeat an earlier direction unless new evidence makes revisiting it rational.",
		"Send the marker and JSON together with await agent_message.send(marked_json_text, receiver_role='parent').",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n\n");
}

export function buildAutoresearchSupervisorBootstrapPrompt(): string {
	return [
		"You are being reserved as a retained autoresearch supervisor.",
		"Do not inspect APIs, list agents, read files, or begin research during this bootstrap turn. The only permitted tool action is one agent_message.send of the readiness marker to the parent.",
		"Reply with or send exactly AUTORESEARCH_SUPERVISOR_READY and nothing else. The complete supervisor contract and checkpoint will arrive in the next parent message.",
	].join("\n");
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
	const response = (role: AutoresearchReviewerRole): string =>
		`Your task succeeds only after agent_message.send delivers the marked verdict to the parent; a final chat response alone does not count. Send the literal line AUTORESEARCH_REVIEW_JSON:${candidate.candidateId}, then exactly one JSON object matching this shape: {"candidate_id":"${candidate.candidateId}","role":"${role}","verdict":"revise","summary":"one concise string","queries":["query actually run"],"inspected_paper_ids":["verified paper_id"],"evidence_bindings":[{"paper_id":"verified paper_id","exact_pointer":"section/page/result","finding":"what this evidence establishes"}],"collision_paper_ids":[],"objections":["one objection string","another objection string"]}. queries, inspected_paper_ids, evidence_bindings, collision_paper_ids, and objections MUST be arrays—never null. In particular, objections MUST be an array of strings. Use empty arrays when genuinely inapplicable. The role value MUST be the literal machine identifier "${role}"—never a reviewer label such as "Reviewer A" or "reviewer_c". verdict must be exactly pass, revise, or reject. A prior_art_killer pass requires actual queries and inspected papers; a literature_auditor pass requires evidence bindings. collision_paper_ids must be a subset of inspected_paper_ids. Call await agent_message.send(marked_json_text, receiver_role='parent') before finishing; if delivery errors, correct the marked JSON and retry once. Treat missing evidence as missing; never invent a source.`;
	return {
		literature_auditor: `Act as Reviewer A, the Literature Auditor. Verify whether every problem-statement claim is supported and whether wording exceeds the evidence. Inspect full text when available.\n\n${shared}\n\n${response("literature_auditor")}`,
		prior_art_killer: `Act as Reviewer B, the Prior-Art Killer. Use Prime's native search/web tools to search synonyms, adjacent terminology, backward references, forward citations, related work, and recent preprints for the same mechanism. Try to kill novelty aggressively.\n\n${shared}\n\n${response("prior_art_killer")}`,
		experimental_critic: `Act as Reviewer C, the Experimental Critic. Test falsifiability, feasibility, confounds, data access, baseline strength, hypothesis separation, validation, reproducibility, and general applicability.\n\n${shared}\n\n${response("experimental_critic")}`,
		top_tier_editor: `Act as Reviewer D, the Top-Tier Editor. Apply a demanding editorial filter: technical soundness, strength of evidence, novelty, field importance, a real technical challenge, comparison with previous approaches, broad relevance, and whether this is more than an incremental A+B or benchmark-only result. These are hostile review questions, not an acceptance guarantee.\n\n${shared}\n\n${response("top_tier_editor")}`,
	};
}
