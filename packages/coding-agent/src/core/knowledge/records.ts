import {
	type DurableDecisionRef,
	digestObject,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowEvidenceEnvelopeRef,
	type WorkflowKnowledgeCommitRef,
	type WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";

export const KNOWLEDGE_KINDS = Object.freeze(["how", "why", "procedure"] as const);
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_STATUSES = Object.freeze(["active", "superseded", "retracted"] as const);
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

const KNOWLEDGE_ACTIONS = Object.freeze(["create", "supersede", "retract", "rollback"] as const);
export const KNOWLEDGE_PRIVACY_CLASSES = Object.freeze(["public", "internal", "private", "restricted"] as const);
export const KNOWLEDGE_RETENTION_CLASSES = Object.freeze(["session", "until-superseded", "indefinite"] as const);
export const KNOWLEDGE_TOMBSTONE_REASONS = Object.freeze([
	"user-forgotten",
	"retention-expired",
	"superseded",
	"secret-detected",
	"scope-revoked",
	"corrupt-source",
	"rollback",
	"import-rejected",
] as const);

export type KnowledgeConfidence = "audited" | "user-confirmed";
export type KnowledgeScope = "session" | "workspace" | "user";
export type KnowledgeAction = "create" | "supersede" | "retract" | "rollback";
export type KnowledgePrivacyClass = (typeof KNOWLEDGE_PRIVACY_CLASSES)[number];
export type KnowledgeRetentionClass = (typeof KNOWLEDGE_RETENTION_CLASSES)[number];
export type KnowledgeTombstoneReason = (typeof KNOWLEDGE_TOMBSTONE_REASONS)[number];

export interface KnowledgePrivacy {
	class: KnowledgePrivacyClass;
	secretScan: WorkflowVerifiedHostReceipt;
}

export interface KnowledgeRetention {
	class: KnowledgeRetentionClass;
	expiresAt?: string;
}

export interface KnowledgeProcedure {
	inputs: Record<string, string>;
	steps: string[];
	successChecks: string[];
	failureChecks: string[];
}

export interface KnowledgeProvenance {
	source: "host" | "user";
	producerId: string;
}

export interface KnowledgeApplicability {
	namespace: string;
	scope: KnowledgeScope;
	sessionId?: string;
	workspaceId?: string;
	userId?: string;
	pathPrefix?: string;
}

export interface KnowledgeProposal {
	proposalId: string;
	recordId: string;
	kind: KnowledgeKind;
	title: string;
	statement: string;
	procedure?: KnowledgeProcedure;
	provenance: KnowledgeProvenance;
	applicability: KnowledgeApplicability;
	privacy: KnowledgePrivacy;
	retention: KnowledgeRetention;
	confidence: KnowledgeConfidence;
	decisionRef: DurableDecisionRef;
	evidenceRefs: WorkflowEvidenceEnvelopeRef[];
	epochRef: WorkflowEpochRef;
	action: KnowledgeAction;
	expectedRevision: number | null;
	rollbackRevision: number | null;
	tombstoneReason?: KnowledgeTombstoneReason;
}

export interface KnowledgeTombstone {
	reason: KnowledgeTombstoneReason;
	deletionFingerprint: string;
	proposalDigest: string;
}

export interface KnowledgeRecord extends KnowledgeProposal {
	revision: number;
	status: KnowledgeStatus;
	contentDigest: string;
	sourceDigest: string;
	commitRef: WorkflowKnowledgeCommitRef;
	createdAt: string;
	updatedAt: string;
	tombstone?: KnowledgeTombstone;
}

export interface KnowledgeCommitEvent {
	kind: "knowledge_record_committed";
	idempotencyKey: string;
	record: KnowledgeRecord;
	previous: KnowledgeRecord | null;
	previousDigest: string | null;
	proposalDigest: string;
}

export type KnowledgeEvent = KnowledgeCommitEvent;

export interface KnowledgeProjection {
	namespace: string;
	records: Record<string, KnowledgeRecord>;
	history: KnowledgeRecord[];
	sequence: number;
	digest: string | null;
}

export type KnowledgeMutationProposal = KnowledgeProposal;
export type CanonicalKnowledgeRecord = KnowledgeRecord;

const PROPOSAL_KEYS = Object.freeze([
	"action",
	"applicability",
	"confidence",
	"decisionRef",
	"epochRef",
	"evidenceRefs",
	"expectedRevision",
	"kind",
	"procedure",
	"recordId",
	"retention",
	"privacy",
	"rollbackRevision",
	"statement",
	"title",
	"proposalId",
	"provenance",
	"tombstoneReason",
] as const);

const RECORD_KEYS = Object.freeze([
	...PROPOSAL_KEYS,
	"revision",
	"status",
	"contentDigest",
	"sourceDigest",
	"commitRef",
	"createdAt",
	"updatedAt",
	"tombstone",
] as const);

const EVENT_KEYS = Object.freeze([
	"kind",
	"idempotencyKey",
	"record",
	"previous",
	"previousDigest",
	"proposalDigest",
] as const);

const SECRET_PATTERNS: readonly RegExp[] = [
	/\b(?:api[_ -]?key|access[_ -]?key|secret|password|passphrase|private[_ -]?key|auth[_ -]?token)\s*[:=]\s*[^\s,;]+/i,
	/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]{12,}\b/i,
	/\bAKIA[0-9A-Z]{16}\b/,
];
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_STRING_BYTES = 65_536;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_REFERENCE_ARRAY_LENGTH = 256;
const MAX_PROCEDURE_BYTES = 65_536;
const MAX_PROCEDURE_ITEMS = 256;
const MAX_HISTORY_LENGTH = 100_000;
const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_BYTES = 1_000_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty.`);
	if (new TextEncoder().encode(value).byteLength > MAX_STRING_BYTES)
		throw new Error(`${label} exceeds the bounded size.`);
}

function assertBoundedIdentifier(value: unknown, label: string): asserts value is string {
	assertNonEmptyString(value, label);
	if (new TextEncoder().encode(value).byteLength > MAX_IDENTIFIER_BYTES)
		throw new Error(`${label} exceeds the bounded identifier size.`);
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		throw new Error(`${label} must be a safe integer >= ${minimum}.`);
}

function parseTimestamp(value: unknown, label: string): number {
	assertNonEmptyString(value, label);
	if (!ISO_TIMESTAMP_PATTERN.test(value)) throw new Error(`${label} must be an ISO timestamp.`);
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp.`);
	return parsed;
}

function assertFreshTimestampRange(issuedAt: string, validUntil: string, now: string | undefined): void {
	const issuedAtMs = parseTimestamp(issuedAt, "evidenceRef.validationReceipt.issuedAt");
	const validUntilMs = parseTimestamp(validUntil, "evidenceRef.validationReceipt.validUntil");
	if (validUntilMs < issuedAtMs) throw new Error("Knowledge evidence validity interval is inverted or stale.");
	if (now !== undefined) {
		const nowMs = parseTimestamp(now, "knowledge validation now");
		if (nowMs < issuedAtMs || nowMs > validUntilMs) throw new Error("Knowledge evidence is stale or not yet valid.");
	}
}

function validatePrivacy(privacy: KnowledgePrivacy): void {
	if (!isPlainRecord(privacy)) throw new Error("Knowledge privacy policy is invalid.");
	assertClosedKeys(privacy, ["class", "secretScan"], "privacy");
	if (!KNOWLEDGE_PRIVACY_CLASSES.includes(privacy.class)) throw new Error("Knowledge privacy class is invalid.");
	if (!isPlainRecord(privacy.secretScan)) throw new Error("Knowledge privacy secret scan receipt is invalid.");
	assertClosedKeys(
		privacy.secretScan,
		[
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
		],
		"privacy.secretScan",
	);
	if (privacy.secretScan.receiptKind !== "artifact")
		throw new Error("Knowledge privacy requires a host secret-scan artifact receipt.");
	validateArtifactRef(privacy.secretScan.artifactRef, "privacy.secretScan.artifactRef");
	for (const [label, value] of [
		["receiptId", privacy.secretScan.receiptId],
		["issuerId", privacy.secretScan.issuerId],
		["workflowId", privacy.secretScan.workflowId],
		["bindingDigest", privacy.secretScan.bindingDigest],
		["payloadDigest", privacy.secretScan.payloadDigest],
		["issuedAt", privacy.secretScan.issuedAt],
		["validUntil", privacy.secretScan.validUntil],
		["keyId", privacy.secretScan.keyId],
		["artifactBytesDigest", privacy.secretScan.artifactBytesDigest],
		["stateDigest", privacy.secretScan.stateDigest],
		["signature", privacy.secretScan.signature],
		["verificationDigest", privacy.secretScan.verificationDigest],
	] as const) {
		assertBoundedIdentifier(value, `privacy.secretScan.${label}`);
	}
	if (privacy.secretScan.signatureAlgorithm !== "ed25519" || typeof privacy.secretScan.oneUse !== "boolean")
		throw new Error("Knowledge privacy secret scan receipt authentication is invalid.");
	assertSafeInteger(privacy.secretScan.revision, "privacy.secretScan.revision", 1);
	assertFreshTimestampRange(privacy.secretScan.issuedAt, privacy.secretScan.validUntil, undefined);
}

function validateRetention(retention: KnowledgeRetention, now: string | undefined): void {
	if (!isPlainRecord(retention)) throw new Error("Knowledge retention policy is invalid.");
	assertClosedKeys(retention, ["class", "expiresAt"], "retention");
	if (!KNOWLEDGE_RETENTION_CLASSES.includes(retention.class)) throw new Error("Knowledge retention class is invalid.");
	if (retention.expiresAt !== undefined) {
		const expiryMs = parseTimestamp(retention.expiresAt, "retention.expiresAt");
		if (now !== undefined && expiryMs <= parseTimestamp(now, "knowledge validation now"))
			throw new Error("Knowledge retention has expired.");
	}
}

function assertClosedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}.`);
	}
}

function assertNoSecretStrings(
	value: unknown,
	path = "proposal",
	depth = 0,
	budget: { bytes: number } = { bytes: 0 },
): void {
	if (depth > MAX_SCAN_DEPTH) throw new Error("Knowledge secret scan exceeded the bounded nesting depth.");
	if (typeof value === "string") {
		budget.bytes += new TextEncoder().encode(value).byteLength;
		if (budget.bytes > MAX_SCAN_BYTES) throw new Error("Knowledge secret scan exceeded the bounded byte budget.");
		if (SECRET_PATTERNS.some((pattern) => pattern.test(value)))
			throw new Error(`Secret material is not allowed in ${path}.`);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_REFERENCE_ARRAY_LENGTH) throw new Error(`${path} exceeds the bounded array length.`);
		for (const [index, item] of value.entries()) assertNoSecretStrings(item, `${path}[${index}]`, depth + 1, budget);
		return;
	}
	if (isPlainRecord(value)) {
		if (Object.keys(value).length > MAX_REFERENCE_ARRAY_LENGTH)
			throw new Error(`${path} exceeds the bounded object field count.`);
		for (const [key, child] of Object.entries(value)) {
			if (
				key !== "secretScan" &&
				/(?:api[_ -]?key|access[_ -]?key|secret|password|passphrase|private[_ -]?key|auth[_ -]?token|credential)/i.test(
					key,
				)
			)
				throw new Error(`Secret material is not allowed in ${path}.${key}.`);
			assertNoSecretStrings(child, `${path}.${key}`, depth + 1, budget);
		}
	}
}

function freezeDeep<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
	return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
	return freezeDeep(structuredClone(value));
}

function validateArtifactRef(ref: WorkflowArtifactRef, label: string): void {
	if (!isPlainRecord(ref)) throw new Error(`${label} is invalid.`);
	assertClosedKeys(ref, ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"], label);
	assertBoundedIdentifier(ref.artifactId, `${label}.artifactId`);
	assertNonEmptyString(ref.relativePath, `${label}.relativePath`);
	if (
		ref.relativePath.startsWith("/") ||
		ref.relativePath.includes("\\") ||
		ref.relativePath.split("/").some((segment) => segment === ".." || segment === "")
	)
		throw new Error(`${label}.relativePath must stay beneath the evidence root.`);
	assertNonEmptyString(ref.digest, `${label}.digest`);
	assertSafeInteger(ref.sizeBytes, `${label}.sizeBytes`);
	assertSafeInteger(ref.sourceEventSequence, `${label}.sourceEventSequence`);
}

function validateDecisionRef(ref: DurableDecisionRef): void {
	if (!isPlainRecord(ref) || !isPlainRecord(ref.decisionScope))
		throw new Error("Knowledge decision reference is invalid.");
	assertClosedKeys(ref, ["decisionScope", "decisionId", "revision", "storeEpoch", "decisionDigest"], "decisionRef");
	assertClosedKeys(ref.decisionScope, ["kind", "namespace"], "decisionRef.decisionScope");
	if (ref.decisionScope.kind !== "knowledge") throw new Error("Knowledge decision reference has the wrong scope.");
	assertNonEmptyString(ref.decisionScope.namespace, "decisionRef.decisionScope.namespace");
	assertNonEmptyString(ref.decisionId, "decisionRef.decisionId");
	assertSafeInteger(ref.revision, "decisionRef.revision", 1);
	assertSafeInteger(ref.storeEpoch, "decisionRef.storeEpoch", 0);
	assertNonEmptyString(ref.decisionDigest, "decisionRef.decisionDigest");
}

function validateEvidenceRef(ref: WorkflowEvidenceEnvelopeRef, now?: string): void {
	if (!isPlainRecord(ref)) throw new Error("Knowledge evidence reference is invalid.");
	assertClosedKeys(
		ref,
		["workflowId", "envelopeId", "envelopeDigest", "evidenceRevision", "artifactRefs", "validationReceipt"],
		"evidenceRef",
	);
	assertNonEmptyString(ref.workflowId, "evidenceRef.workflowId");
	assertNonEmptyString(ref.envelopeId, "evidenceRef.envelopeId");
	assertNonEmptyString(ref.envelopeDigest, "evidenceRef.envelopeDigest");
	assertSafeInteger(ref.evidenceRevision, "evidenceRef.evidenceRevision", 1);
	if (
		!Array.isArray(ref.artifactRefs) ||
		ref.artifactRefs.length === 0 ||
		ref.artifactRefs.length > MAX_REFERENCE_ARRAY_LENGTH
	)
		throw new Error("Knowledge evidence requires immutable artifact references.");
	for (const [index, artifactRef] of ref.artifactRefs.entries())
		validateArtifactRef(artifactRef, `evidenceRef.artifactRefs[${index}]`);
	if (!isPlainRecord(ref.validationReceipt)) throw new Error("Knowledge evidence validation receipt is invalid.");
	assertClosedKeys(
		ref.validationReceipt,
		[
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
		],
		"evidenceRef.validationReceipt",
	);
	if (ref.validationReceipt.receiptKind !== "artifact")
		throw new Error("Knowledge evidence requires a host artifact-validation receipt.");
	validateArtifactRef(ref.validationReceipt.artifactRef, "evidenceRef.validationReceipt.artifactRef");
	assertBoundedIdentifier(ref.validationReceipt.receiptId, "evidenceRef.validationReceipt.receiptId");
	assertBoundedIdentifier(ref.validationReceipt.issuerId, "evidenceRef.validationReceipt.issuerId");
	assertBoundedIdentifier(ref.validationReceipt.workflowId, "evidenceRef.validationReceipt.workflowId");
	if (ref.validationReceipt.workflowId !== ref.workflowId)
		throw new Error("Knowledge evidence receipt belongs to a different workflow.");
	for (const [label, value] of [
		["bindingDigest", ref.validationReceipt.bindingDigest],
		["payloadDigest", ref.validationReceipt.payloadDigest],
		["issuedAt", ref.validationReceipt.issuedAt],
		["validUntil", ref.validationReceipt.validUntil],
		["keyId", ref.validationReceipt.keyId],
		["artifactBytesDigest", ref.validationReceipt.artifactBytesDigest],
		["stateDigest", ref.validationReceipt.stateDigest],
		["signature", ref.validationReceipt.signature],
		["verificationDigest", ref.validationReceipt.verificationDigest],
	] as const) {
		assertNonEmptyString(value, `evidenceRef.validationReceipt.${label}`);
	}
	if (ref.validationReceipt.signatureAlgorithm !== "ed25519")
		throw new Error("Knowledge evidence receipt signature algorithm is invalid.");
	if (typeof ref.validationReceipt.oneUse !== "boolean")
		throw new Error("Knowledge evidence receipt oneUse flag is invalid.");
	assertSafeInteger(ref.validationReceipt.revision, "evidenceRef.validationReceipt.revision", 1);
	if (/(?:^|[-_:])(self|model|worker|proposal|caller)(?:[-_: ]|$)/i.test(ref.validationReceipt.issuerId))
		throw new Error("Self-authored evidence cannot validate canonical knowledge.");
	assertFreshTimestampRange(ref.validationReceipt.issuedAt, ref.validationReceipt.validUntil, now);
}

function validateApplicability(applicability: KnowledgeApplicability): void {
	if (!isPlainRecord(applicability)) throw new Error("Knowledge applicability is invalid.");
	assertClosedKeys(
		applicability,
		["namespace", "scope", "sessionId", "workspaceId", "userId", "pathPrefix"],
		"applicability",
	);
	assertNonEmptyString(applicability.namespace, "applicability.namespace");
	if (!["session", "workspace", "user"].includes(applicability.scope))
		throw new Error("Knowledge applicability scope is invalid.");
	if (applicability.scope === "session") assertNonEmptyString(applicability.sessionId, "applicability.sessionId");
	if (applicability.scope === "workspace")
		assertNonEmptyString(applicability.workspaceId, "applicability.workspaceId");
	if (applicability.scope === "user") assertNonEmptyString(applicability.userId, "applicability.userId");
	if (applicability.sessionId !== undefined) assertNonEmptyString(applicability.sessionId, "applicability.sessionId");
	if (applicability.workspaceId !== undefined)
		assertNonEmptyString(applicability.workspaceId, "applicability.workspaceId");
	if (applicability.userId !== undefined) assertNonEmptyString(applicability.userId, "applicability.userId");
	if (applicability.pathPrefix !== undefined)
		assertNonEmptyString(applicability.pathPrefix, "applicability.pathPrefix");
	if (
		applicability.pathPrefix?.startsWith("/") ||
		applicability.pathPrefix?.includes("\\") ||
		applicability.pathPrefix?.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	)
		throw new Error("applicability.pathPrefix must be a normalized relative path.");
}

function validateProcedure(procedure: KnowledgeProcedure): void {
	if (!isPlainRecord(procedure)) throw new Error("Knowledge procedure is invalid.");
	assertClosedKeys(procedure, ["failureChecks", "inputs", "steps", "successChecks"], "procedure");
	if (!isPlainRecord(procedure.inputs)) throw new Error("procedure.inputs must be an object.");
	if (Object.keys(procedure.inputs).length > MAX_PROCEDURE_ITEMS)
		throw new Error("procedure.inputs exceeds the bounded item count.");
	let procedureBytes = 0;
	for (const [key, value] of Object.entries(procedure.inputs)) {
		assertBoundedIdentifier(key, "procedure input name");
		assertNonEmptyString(value, `procedure.inputs.${key}`);
		procedureBytes += new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength;
	}
	for (const [label, values] of [
		["steps", procedure.steps],
		["successChecks", procedure.successChecks],
		["failureChecks", procedure.failureChecks],
	] as const) {
		if (
			!Array.isArray(values) ||
			values.length === 0 ||
			values.length > MAX_PROCEDURE_ITEMS ||
			values.some((value) => typeof value !== "string" || value.trim() === "")
		)
			throw new Error(`procedure.${label} must contain non-empty strings.`);
		for (const value of values) {
			assertNonEmptyString(value, `procedure.${label} item`);
			procedureBytes += new TextEncoder().encode(value).byteLength;
		}
	}
	if (procedureBytes > MAX_PROCEDURE_BYTES) throw new Error("Knowledge procedure exceeds the bounded byte size.");
}

function validateEpoch(epochRef: WorkflowEpochRef): void {
	if (!isPlainRecord(epochRef)) throw new Error("Knowledge epoch reference is invalid.");
	assertClosedKeys(epochRef, ["storeEpoch", "coordinatorEpoch"], "epochRef");
	assertSafeInteger(epochRef.storeEpoch, "epochRef.storeEpoch", 0);
	assertSafeInteger(epochRef.coordinatorEpoch, "epochRef.coordinatorEpoch", 0);
}

/**
 * Validate and clone a host knowledge proposal before durable admission.
 *
 * Args:
 * proposal: Candidate reusable how/why/procedure record.
 * Return: Deep-frozen proposal detached from caller aliases.
 */
export interface KnowledgeValidationOptions {
	now?: string;
	allowRedactedProcedure?: boolean;
	allowRedactedEvidence?: boolean;
}

export function validateKnowledgeProposal(
	proposal: KnowledgeProposal,
	options: KnowledgeValidationOptions = {},
): KnowledgeProposal {
	return validateKnowledgeProposalAt(proposal, options);
}

/**
 * Validate a knowledge proposal against an optional trusted host clock.
 *
 * Args:
 * proposal: Candidate reusable how/why/procedure record.
 * options: Trusted clock used for retention and evidence freshness checks.
 * Return: Deep-frozen proposal detached from caller aliases.
 */
export function validateKnowledgeProposalAt(
	proposal: KnowledgeProposal,
	options: KnowledgeValidationOptions = {},
): KnowledgeProposal {
	if (!isPlainRecord(proposal)) throw new Error("Knowledge proposal must be a plain object.");
	assertClosedKeys(proposal, PROPOSAL_KEYS, "knowledge proposal");
	assertBoundedIdentifier(proposal.proposalId, "proposalId");
	assertBoundedIdentifier(proposal.recordId, "recordId");
	if (!KNOWLEDGE_KINDS.includes(proposal.kind)) throw new Error("Knowledge kind is not allowed.");
	assertNonEmptyString(proposal.title, "title");
	assertNonEmptyString(proposal.statement, "statement");
	if (new TextEncoder().encode(proposal.statement).byteLength > 4_000)
		throw new Error("Knowledge statement exceeds the bounded limit.");
	if (proposal.kind === "procedure") {
		if (proposal.procedure === undefined) {
			if (proposal.action !== "retract" && options.allowRedactedProcedure !== true)
				throw new Error("Procedure knowledge requires a procedure payload.");
		} else validateProcedure(proposal.procedure);
	} else if (proposal.procedure !== undefined) {
		throw new Error("Only procedure knowledge may carry a procedure payload.");
	}
	if (!isPlainRecord(proposal.provenance)) throw new Error("Knowledge provenance is invalid.");
	assertClosedKeys(proposal.provenance, ["producerId", "source"], "provenance");
	if (proposal.provenance.source !== "host" && proposal.provenance.source !== "user")
		throw new Error("Knowledge provenance source is invalid.");
	assertBoundedIdentifier(proposal.provenance.producerId, "provenance.producerId");
	validateApplicability(proposal.applicability);
	validatePrivacy(proposal.privacy);
	validateRetention(proposal.retention, options.now);
	if (proposal.confidence !== "audited" && proposal.confidence !== "user-confirmed")
		throw new Error("Knowledge confidence must be audited or user-confirmed.");
	if (!KNOWLEDGE_ACTIONS.includes(proposal.action)) throw new Error("Knowledge action is not allowed.");
	if (proposal.tombstoneReason !== undefined && !KNOWLEDGE_TOMBSTONE_REASONS.includes(proposal.tombstoneReason))
		throw new Error("Knowledge tombstone reason is invalid.");
	if (proposal.tombstoneReason !== undefined && proposal.action !== "retract")
		throw new Error("Only retract knowledge may carry a tombstone reason.");
	if (proposal.privacy.class === "restricted" && proposal.applicability.scope !== "session")
		throw new Error("Restricted knowledge must remain session-scoped.");
	validateDecisionRef(proposal.decisionRef);
	if (!Array.isArray(proposal.evidenceRefs) || proposal.evidenceRefs.length > MAX_REFERENCE_ARRAY_LENGTH)
		throw new Error("Knowledge proposal evidence references are invalid.");
	if (proposal.evidenceRefs.length === 0 && options.allowRedactedEvidence !== true)
		throw new Error("Knowledge proposal requires host-validated evidence.");
	for (const evidenceRef of proposal.evidenceRefs) validateEvidenceRef(evidenceRef, options.now);
	if (new Set(proposal.evidenceRefs.map((ref) => ref.envelopeId)).size !== proposal.evidenceRefs.length)
		throw new Error("Knowledge evidence references must be unique.");
	validateEpoch(proposal.epochRef);
	if (!Object.hasOwn(proposal, "expectedRevision") || proposal.expectedRevision !== null) {
		if (proposal.expectedRevision !== null) assertSafeInteger(proposal.expectedRevision, "expectedRevision", 1);
	}
	if (proposal.action === "create") {
		if (proposal.expectedRevision !== null || proposal.rollbackRevision !== null)
			throw new Error("Create knowledge cannot carry a prior revision.");
	} else {
		if (proposal.expectedRevision === null) throw new Error("Revision action requires expectedRevision.");
		if (proposal.action === "rollback") {
			if (proposal.rollbackRevision === null) throw new Error("Rollback requires rollbackRevision.");
			assertSafeInteger(proposal.rollbackRevision, "rollbackRevision", 1);
		} else if (proposal.rollbackRevision !== null) {
			throw new Error("Only rollback may carry rollbackRevision.");
		}
	}
	assertNoSecretStrings(proposal);
	const normalizedApplicability = {
		namespace: proposal.applicability.namespace,
		scope: proposal.applicability.scope,
		...(proposal.applicability.sessionId === undefined ? {} : { sessionId: proposal.applicability.sessionId }),
		...(proposal.applicability.workspaceId === undefined ? {} : { workspaceId: proposal.applicability.workspaceId }),
		...(proposal.applicability.userId === undefined ? {} : { userId: proposal.applicability.userId }),
		...(proposal.applicability.pathPrefix === undefined ? {} : { pathPrefix: proposal.applicability.pathPrefix }),
	};
	const normalizedRetention = {
		class: proposal.retention.class,
		...(proposal.retention.expiresAt === undefined ? {} : { expiresAt: proposal.retention.expiresAt }),
	};
	return cloneAndFreeze({
		...proposal,
		applicability: normalizedApplicability,
		privacy: { class: proposal.privacy.class, secretScan: proposal.privacy.secretScan },
		retention: normalizedRetention,
		...(proposal.procedure === undefined ? {} : { procedure: proposal.procedure }),
	});
}

/**
 * Compute the immutable content digest used by a committed revision.
 *
 * Args:
 * proposal: Validated knowledge proposal.
 * Return: Deterministic content digest.
 */
export function knowledgeContentDigest(proposal: KnowledgeProposal): string {
	return digestObject({
		applicability: proposal.applicability,
		kind: proposal.kind,
		privacy: proposal.privacy,
		procedure: proposal.procedure ?? null,
		recordId: proposal.recordId,
		retention: proposal.retention,
		statement: proposal.statement,
		title: proposal.title,
	});
}

function knowledgeTombstoneDigest(record: Pick<KnowledgeRecord, "recordId" | "kind" | "tombstone">): string {
	if (record.tombstone === undefined) throw new Error("Knowledge tombstone metadata is missing.");
	return digestObject({ kind: record.kind, recordId: record.recordId, tombstone: record.tombstone });
}

/**
 * Compute the source digest for the exact host evidence set.
 *
 * Args:
 * evidenceRefs: Host-validated evidence references.
 * Return: Deterministic source digest.
 */
export function knowledgeSourceDigest(evidenceRefs: readonly WorkflowEvidenceEnvelopeRef[]): string {
	return digestObject(evidenceRefs);
}

/**
 * Deep-freeze a canonical value after it has been reconstructed from durable bytes.
 *
 * Args:
 * value: Canonical record or projection value.
 * Return: Detached immutable value.
 */
export function freezeKnowledgeValue<T>(value: T): T {
	return cloneAndFreeze(value);
}

function proposalFromRecord(record: KnowledgeRecord): KnowledgeProposal {
	return {
		proposalId: record.proposalId,
		recordId: record.recordId,
		kind: record.kind,
		title: record.title,
		statement: record.statement,
		...(record.procedure === undefined ? {} : { procedure: record.procedure }),
		provenance: record.provenance,
		applicability: {
			namespace: record.applicability.namespace,
			scope: record.applicability.scope,
			...(record.applicability.sessionId === undefined ? {} : { sessionId: record.applicability.sessionId }),
			...(record.applicability.workspaceId === undefined ? {} : { workspaceId: record.applicability.workspaceId }),
			...(record.applicability.userId === undefined ? {} : { userId: record.applicability.userId }),
			...(record.applicability.pathPrefix === undefined ? {} : { pathPrefix: record.applicability.pathPrefix }),
		},
		privacy: record.privacy,
		retention: record.retention,
		confidence: record.confidence,
		decisionRef: record.decisionRef,
		evidenceRefs: record.evidenceRefs,
		epochRef: record.epochRef,
		action: record.action,
		expectedRevision: record.expectedRevision,
		rollbackRevision: record.rollbackRevision,
		...(record.tombstoneReason === undefined ? {} : { tombstoneReason: record.tombstoneReason }),
	};
}

export function knowledgeProposalFromRecord(record: KnowledgeRecord): KnowledgeProposal {
	return proposalFromRecord(record);
}

export function redactKnowledgeRecordForHistory(
	record: KnowledgeRecord,
	tombstoneRecord: Pick<KnowledgeRecord, "recordId" | "status" | "tombstone">,
): KnowledgeRecord {
	if (
		tombstoneRecord.status !== "retracted" ||
		tombstoneRecord.recordId !== record.recordId ||
		tombstoneRecord.tombstone === undefined
	)
		throw new Error("Knowledge history redaction requires the canonical tombstone record.");
	const { reason, deletionFingerprint } = tombstoneRecord.tombstone;
	if (!/^[0-9a-f]{64}$/.test(deletionFingerprint))
		throw new Error("Knowledge history redaction requires a host-keyed opaque fingerprint.");
	return redactedHistoryRecord(
		record,
		reason,
		historyAuditFingerprint(record, reason, deletionFingerprint),
		"superseded",
	);
}

function historyAuditFingerprint(
	record: KnowledgeRecord,
	reason: KnowledgeTombstoneReason,
	deletionFingerprint: string,
): string {
	return digestObject({
		kind: "knowledge-history-audit",
		recordId: record.recordId,
		revision: record.revision,
		reason,
		deletionFingerprint,
	});
}

function redactedHistoryReceipt(fingerprint: string): WorkflowVerifiedHostReceipt {
	const artifactRef: WorkflowArtifactRef = {
		artifactId: `history-redacted-${fingerprint}`,
		relativePath: `history/${fingerprint}.json`,
		digest: fingerprint,
		sizeBytes: 0,
		sourceEventSequence: 0,
	};
	return {
		receiptKind: "artifact",
		oneUse: false,
		receiptId: `history-redacted-${fingerprint}`,
		issuerId: "history-redaction",
		workflowId: "history-redacted",
		bindingDigest: fingerprint,
		payloadDigest: fingerprint,
		artifactRef,
		issuedAt: "1970-01-01T00:00:00.000Z",
		validUntil: "9999-12-31T23:59:59.000Z",
		keyId: "history-redaction",
		signatureAlgorithm: "ed25519",
		artifactBytesDigest: fingerprint,
		stateDigest: fingerprint,
		revision: 1,
		signature: fingerprint,
		verificationDigest: fingerprint,
	};
}

function redactedHistoryRecord(
	record: KnowledgeRecord,
	reason: KnowledgeTombstoneReason,
	historyFingerprint: string,
	status: "superseded" | "retracted",
): KnowledgeRecord {
	const tombstone: KnowledgeTombstone = {
		reason,
		deletionFingerprint: historyFingerprint,
		proposalDigest: historyFingerprint,
	};
	const decisionRef: DurableDecisionRef = {
		decisionScope: { kind: "knowledge", namespace: record.applicability.namespace },
		decisionId: "history-redaction",
		revision: 1,
		storeEpoch: 0,
		decisionDigest: historyFingerprint,
	};
	const redacted: KnowledgeRecord = {
		proposalId: `history-redacted-${historyFingerprint}`,
		recordId: record.recordId,
		kind: record.kind,
		title: "[retracted]",
		statement: "[retracted]",
		provenance: { source: "host", producerId: "history-redaction" },
		applicability: {
			namespace: record.applicability.namespace,
			scope: "workspace",
			workspaceId: `history-redacted-${historyFingerprint}`,
		},
		privacy: { class: "public", secretScan: redactedHistoryReceipt(historyFingerprint) },
		retention: { class: "indefinite" },
		confidence: "audited",
		decisionRef,
		evidenceRefs: [],
		epochRef: { storeEpoch: 0, coordinatorEpoch: 0 },
		action: status === "retracted" ? "retract" : "supersede",
		expectedRevision: status === "retracted" ? Math.max(1, record.revision - 1) : Math.max(1, record.revision - 1),
		rollbackRevision: null,
		revision: record.revision,
		status,
		contentDigest: knowledgeTombstoneDigest({ recordId: record.recordId, kind: record.kind, tombstone }),
		sourceDigest: historyFingerprint,
		commitRef: {
			knowledgeStoreId: "history-redaction",
			workflowEpochRef: { storeEpoch: 0, coordinatorEpoch: 0 },
			knowledgeStoreEpoch: 0,
			proposalId: `history-redacted-${historyFingerprint}`,
			decisionRef,
			knowledgeJournalSequence: record.revision,
			knowledgeJournalDigest: historyFingerprint,
			transactionDigest: historyFingerprint,
		},
		createdAt: "1970-01-01T00:00:00.000Z",
		updatedAt: "1970-01-01T00:00:00.000Z",
		tombstone,
	};
	return freezeKnowledgeValue(redacted);
}

export function redactKnowledgeRecordForReplay(
	record: KnowledgeRecord,
	tombstoneRecord: Pick<KnowledgeRecord, "recordId" | "status" | "tombstone">,
): KnowledgeRecord {
	if (record.status !== "retracted") return redactKnowledgeRecordForHistory(record, tombstoneRecord);
	if (
		tombstoneRecord.status !== "retracted" ||
		tombstoneRecord.recordId !== record.recordId ||
		tombstoneRecord.tombstone === undefined
	)
		throw new Error("Knowledge replay redaction requires the canonical tombstone record.");
	return redactedHistoryRecord(
		record,
		record.tombstone!.reason,
		historyAuditFingerprint(record, tombstoneRecord.tombstone.reason, tombstoneRecord.tombstone.deletionFingerprint),
		"retracted",
	);
}

export function validateKnowledgeRecord(record: KnowledgeRecord): KnowledgeRecord {
	if (!isPlainRecord(record)) throw new Error("Knowledge record must be a plain object.");
	assertClosedKeys(record, RECORD_KEYS, "knowledge record");
	const proposal = proposalFromRecord(record);
	const isRedactedHistoricalRevision = record.status === "superseded" && record.tombstone !== undefined;
	const isRedactedTombstoneView =
		record.tombstone !== undefined && record.title === "[retracted]" && record.statement === "[retracted]";
	validateKnowledgeProposal(proposal, {
		allowRedactedProcedure: isRedactedHistoricalRevision || isRedactedTombstoneView,
		allowRedactedEvidence: isRedactedTombstoneView,
	});
	assertSafeInteger(record.revision, "revision", 1);
	if (!KNOWLEDGE_STATUSES.includes(record.status)) throw new Error("Knowledge record status is invalid.");
	if (record.status === "retracted" && record.action !== "retract")
		throw new Error("Retracted knowledge must come from a retract action.");
	if (record.status !== "retracted" && record.action === "retract")
		throw new Error("Retract knowledge must carry a tombstone status.");
	assertNonEmptyString(record.contentDigest, "contentDigest");
	assertNonEmptyString(record.sourceDigest, "sourceDigest");
	if (record.status === "retracted" || isRedactedHistoricalRevision) {
		if (record.tombstone === undefined || !isPlainRecord(record.tombstone))
			throw new Error("Retracted knowledge must carry a tombstone.");
		assertClosedKeys(record.tombstone, ["reason", "deletionFingerprint", "proposalDigest"], "knowledge tombstone");
		if (!KNOWLEDGE_TOMBSTONE_REASONS.includes(record.tombstone.reason))
			throw new Error("Knowledge tombstone reason is invalid.");
		assertNonEmptyString(record.tombstone.deletionFingerprint, "tombstone.deletionFingerprint");
		assertNonEmptyString(record.tombstone.proposalDigest, "tombstone.proposalDigest");
		if (!/^[0-9a-f]{64}$/.test(record.tombstone.deletionFingerprint))
			throw new Error("Knowledge tombstone fingerprint is not a host-keyed opaque digest.");
		if (!/^[0-9a-f]{64}$/.test(record.tombstone.proposalDigest))
			throw new Error("Knowledge tombstone proposal digest is malformed.");
		if (record.title !== "[retracted]" || record.statement !== "[retracted]" || record.procedure !== undefined)
			throw new Error("Knowledge tombstones cannot retain canonical content.");
		if (record.contentDigest !== knowledgeTombstoneDigest(record))
			throw new Error("Knowledge tombstone content digest is stale.");
		if (record.sourceDigest !== record.tombstone.deletionFingerprint)
			throw new Error("Knowledge tombstone source digest is exposed.");
	} else if (record.tombstone !== undefined) {
		throw new Error("Only retracted knowledge may carry a tombstone.");
	}
	if (!isPlainRecord(record.commitRef)) throw new Error("Knowledge record is missing its commit reference.");
	assertClosedKeys(
		record.commitRef,
		[
			"knowledgeStoreId",
			"workflowEpochRef",
			"knowledgeStoreEpoch",
			"proposalId",
			"decisionRef",
			"knowledgeJournalSequence",
			"knowledgeJournalDigest",
			"transactionDigest",
		],
		"commitRef",
	);
	validateEpoch(record.commitRef.workflowEpochRef);
	validateDecisionRef(record.commitRef.decisionRef);
	assertNonEmptyString(record.commitRef.knowledgeStoreId, "commitRef.knowledgeStoreId");
	assertNonEmptyString(record.commitRef.proposalId, "commitRef.proposalId");
	assertSafeInteger(record.commitRef.knowledgeStoreEpoch, "commitRef.knowledgeStoreEpoch", 0);
	assertSafeInteger(record.commitRef.knowledgeJournalSequence, "commitRef.knowledgeJournalSequence", 1);
	assertNonEmptyString(record.commitRef.knowledgeJournalDigest, "commitRef.knowledgeJournalDigest");
	assertNonEmptyString(record.commitRef.transactionDigest, "commitRef.transactionDigest");
	if (record.commitRef.proposalId !== proposal.proposalId)
		throw new Error("Knowledge commit reference has the wrong proposal.");
	if (record.commitRef.knowledgeStoreEpoch !== proposal.epochRef.storeEpoch)
		throw new Error("Knowledge commit reference has the wrong store epoch.");
	if (digestObject(record.commitRef.workflowEpochRef) !== digestObject(proposal.epochRef))
		throw new Error("Knowledge commit reference has the wrong workflow epoch.");
	if (digestObject(record.commitRef.decisionRef) !== digestObject(proposal.decisionRef))
		throw new Error("Knowledge commit reference has the wrong decision.");
	if (record.tombstone === undefined && record.contentDigest !== knowledgeContentDigest(proposal))
		throw new Error("Knowledge content digest is stale.");
	if (
		record.status !== "retracted" &&
		!isRedactedHistoricalRevision &&
		record.sourceDigest !== knowledgeSourceDigest(proposal.evidenceRefs)
	)
		throw new Error("Knowledge source digest is stale.");
	const createdAt = parseTimestamp(record.createdAt, "createdAt");
	const updatedAt = parseTimestamp(record.updatedAt, "updatedAt");
	if (updatedAt < createdAt) throw new Error("Knowledge record timestamps are not monotonic.");
	return cloneAndFreeze(record);
}

/**
 * Validate a reconstructed canonical knowledge projection.
 *
 * Args:
 * state: Projection loaded from the durable store.
 * Return: Deep-frozen projection detached from durable-store aliases.
 */
export function validateKnowledgeProjection(state: KnowledgeProjection): KnowledgeProjection {
	if (!isPlainRecord(state)) throw new Error("Knowledge projection must be a plain object.");
	assertClosedKeys(state, ["namespace", "records", "history", "sequence", "digest"], "knowledge projection");
	assertNonEmptyString(state.namespace, "knowledge projection namespace");
	assertSafeInteger(state.sequence, "knowledge projection sequence", 0);
	if (state.sequence === 0 && state.digest !== null)
		throw new Error("Empty knowledge projection cannot carry a digest.");
	if (state.sequence > 0 && state.digest === null)
		throw new Error("Knowledge projection is missing its chain digest.");
	if (state.digest !== null) assertNonEmptyString(state.digest, "knowledge projection digest");
	if (!isPlainRecord(state.records) || !Array.isArray(state.history))
		throw new Error("Knowledge projection collections are invalid.");
	if (Object.keys(state.records).length > MAX_HISTORY_LENGTH || state.history.length > MAX_HISTORY_LENGTH)
		throw new Error("Knowledge projection exceeds the bounded record history.");
	if (state.history.length !== state.sequence)
		throw new Error("Knowledge projection sequence does not match history length.");
	const historyById = new Map<string, KnowledgeRecord[]>();
	for (const [recordId, current] of Object.entries(state.records)) {
		const validated = validateKnowledgeRecord(current);
		if (validated.recordId !== recordId) throw new Error("Knowledge projection record key is not canonical.");
		if (validated.status === "superseded") throw new Error("Knowledge projection current record is superseded.");
		if (validated.applicability.namespace !== state.namespace)
			throw new Error("Knowledge projection record crossed its namespace boundary.");
	}
	for (const entry of state.history) {
		const validated = validateKnowledgeRecord(entry);
		if (validated.applicability.namespace !== state.namespace)
			throw new Error("Knowledge projection history crossed its namespace boundary.");
		const entries = historyById.get(validated.recordId) ?? [];
		if (entries.some((prior) => prior.revision === validated.revision))
			throw new Error("Knowledge projection history contains a duplicate revision.");
		entries.push(validated);
		historyById.set(validated.recordId, entries);
	}
	for (const [recordId, current] of Object.entries(state.records)) {
		const entries = historyById.get(recordId) ?? [];
		entries.sort((left, right) => left.revision - right.revision);
		if (entries[0]?.revision !== 1) throw new Error("Knowledge projection history must begin at revision one.");
		for (let index = 1; index < entries.length; index += 1) {
			if (entries[index]!.revision !== entries[index - 1]!.revision + 1)
				throw new Error("Knowledge projection history has a revision gap.");
		}
		const last = entries.at(-1);
		if (last === undefined || last.revision !== current.revision || digestObject(last) !== digestObject(current))
			throw new Error("Knowledge projection current record is not the canonical history tail.");
		for (const entry of entries.slice(0, -1)) {
			if (entry.status !== "superseded")
				throw new Error("Knowledge projection history has a live non-tail revision.");
		}
	}
	for (const recordId of historyById.keys()) {
		if (state.records[recordId] === undefined) throw new Error("Knowledge projection history has no current record.");
	}
	return cloneAndFreeze(state);
}

/**
 * Validate a durable knowledge event before replay or projection.
 *
 * Args:
 * event: Serialized semantic knowledge event.
 * Return: Deep-frozen event detached from the durable-store buffer.
 */
export function validateKnowledgeEvent(event: KnowledgeEvent): KnowledgeEvent {
	if (!isPlainRecord(event)) throw new Error("Knowledge event must be a plain object.");
	assertClosedKeys(event, EVENT_KEYS, "knowledge event");
	if (event.kind !== "knowledge_record_committed") throw new Error("Knowledge event kind is invalid.");
	assertNonEmptyString(event.idempotencyKey, "knowledge event idempotencyKey");
	assertNonEmptyString(event.proposalDigest, "knowledge event proposalDigest");
	if (event.previousDigest !== null) assertNonEmptyString(event.previousDigest, "knowledge event previousDigest");
	const record = validateKnowledgeRecord(event.record);
	if (event.previous !== null) validateKnowledgeRecord(event.previous);
	if (record.action === "create") {
		if (event.previous !== null || event.previousDigest !== null || record.revision !== 1)
			throw new Error("Knowledge create event has an invalid canonical predecessor.");
	} else if (event.previous === null || event.previous.recordId !== record.recordId || event.previousDigest === null) {
		throw new Error("Knowledge revision event is missing its canonical predecessor.");
	} else if (event.previous.revision + 1 !== record.revision) {
		throw new Error("Knowledge revision event has a non-contiguous revision.");
	}
	if (record.action !== "retract" && event.previous !== null && event.previousDigest !== digestObject(event.previous))
		throw new Error("Knowledge event predecessor digest is stale or forged.");
	if (record.action === "retract" && record.status !== "retracted")
		throw new Error("Knowledge retract event must produce a tombstone.");
	const redactedHistoricalRecord = record.status === "superseded" && record.tombstone !== undefined;
	if (record.action !== "retract" && record.status !== "active" && !redactedHistoricalRecord)
		throw new Error("Only a retract event may produce a tombstone status.");
	const eventProposalDigest =
		record.tombstone === undefined ? digestObject(proposalFromRecord(record)) : record.tombstone.proposalDigest;
	if (eventProposalDigest !== event.proposalDigest)
		throw new Error("Knowledge event proposal digest is stale or forged.");
	return cloneAndFreeze(event);
}

/**
 * Purely project one canonical knowledge event into its read projection.
 *
 * Args:
 * state: Prior projection.
 * event: Authenticated semantic knowledge event.
 * Return: New projection with no mutation of inputs.
 */
export function reduceKnowledgeEvent(state: KnowledgeProjection, event: KnowledgeEvent): KnowledgeProjection {
	const validatedState = validateKnowledgeProjection(state);
	const validatedEvent = validateKnowledgeEvent(event);
	const record = validatedEvent.record;
	const prior = validatedEvent.previous === null ? null : validatedEvent.previous;
	if (record.commitRef.knowledgeJournalSequence <= validatedState.sequence)
		throw new Error("Knowledge event sequence does not advance the canonical chain.");
	if (record.applicability.namespace !== validatedState.namespace)
		throw new Error("Knowledge event crossed its namespace boundary.");
	if (prior === null) {
		if (validatedState.records[record.recordId] !== undefined)
			throw new Error("Knowledge create event would overwrite a canonical record.");
	} else {
		const current = validatedState.records[record.recordId];
		if (
			prior.recordId !== record.recordId ||
			prior.revision + 1 !== record.revision ||
			current === undefined ||
			(record.action === "retract"
				? validatedEvent.previousDigest !== digestObject(current)
				: digestObject(current) !== digestObject(prior))
		)
			throw new Error("Knowledge event prior revision is not the canonical current revision.");
	}
	if (prior !== null && prior.status === "retracted")
		throw new Error("Knowledge event cannot revise a tombstoned record.");
	if (record.action === "create" && prior !== null)
		throw new Error("Knowledge create event cannot supersede a record.");
	if (record.action !== "create" && prior === null)
		throw new Error("Knowledge revision event cannot omit its predecessor.");
	const history = validatedState.history.map((entry) => entry);
	if (prior !== null) {
		if (record.action === "retract") {
			for (const [index, entry] of history.entries()) {
				if (entry.recordId === prior.recordId) history[index] = redactKnowledgeRecordForHistory(entry, record);
			}
		} else {
			const priorIndex = history.findIndex(
				(entry) => entry.recordId === prior.recordId && entry.revision === prior.revision,
			);
			if (priorIndex < 0) throw new Error("Knowledge projection is missing the prior canonical revision.");
			history[priorIndex] = freezeKnowledgeValue({ ...history[priorIndex], status: "superseded" });
		}
	}
	history.push(record);
	return freezeKnowledgeValue({
		namespace: validatedState.namespace,
		records: { ...validatedState.records, [record.recordId]: record },
		history,
		sequence: validatedState.sequence + 1,
		digest: digestObject({ prior: validatedState.digest, event: validatedEvent }),
	});
}
