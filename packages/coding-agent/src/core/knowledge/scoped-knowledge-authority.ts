import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
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
	type WorkflowJournalHead,
	type WorkflowTrustedPrincipal,
	type WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";
import type { WorkflowLearningHostWitness } from "../workflow/learning-controller.js";
import {
	freezeKnowledgeValue,
	type KnowledgeProvenance,
	type KnowledgeRecord,
	validateKnowledgeRecord,
} from "./records.js";

export const SCOPED_KNOWLEDGE_SCOPES = Object.freeze(["goal", "domain", "global", "never"] as const);
export type ScopedKnowledgeScope = (typeof SCOPED_KNOWLEDGE_SCOPES)[number];
export type ScopedKnowledgePromotableScope = Exclude<ScopedKnowledgeScope, "never">;
export type ScopedKnowledgeRecordStatus = "active" | "superseded" | "retracted";
export type ScopedKnowledgeTombstoneReason = "never" | "source-retracted" | "source-revoked" | "source-quarantined";

const PROMOTION_CAPABILITY = "workflow_learning_knowledge_promotion" as const;
const SCOPED_KNOWLEDGE_SCHEMA_VERSION = 1 as const;
const MAX_RECORDS = 100_000;
const MAX_TOMBSTONES = 100_000;
const MAX_OUTBOX = 100_000;
const MAX_IDEMPOTENCY = 100_000;
const MAX_TRANSFER_EVIDENCE = 2_048;
const MAX_STRING_BYTES = 65_536;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_QUERY_BYTES = 65_536;
const MAX_RECALL_RECORDS = 10_000;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_REFS = 4_096;
const MAX_SCAN_DEPTH = 32;
const SECRET_PATTERNS: readonly RegExp[] = [
	/\b(?:api[_ -]?key|access[_ -]?key|secret|password|passphrase|private[_ -]?key|auth[_ -]?token)\s*[:=]\s*[^\s,;]+/i,
	/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]{12,}\b/i,
	/\bAKIA[0-9A-Z]{16}\b/,
];
const RAW_TRANSFER_KEY =
	/(?:holdout|per[_ -]?case|raw[_ -]?(?:row|outcome|result|input)|transcript|thread|conversation|secret|password|api[_ -]?key|access[_ -]?key|private[_ -]?key|auth[_ -]?token)/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface ScopedKnowledgeTarget {
	scope: ScopedKnowledgeScope;
	trustDomainId: string;
	tenantId: string;
	namespace: string;
	goalId: string | null;
	domainId: string | null;
	workspaceId: string | null;
	userId: string | null;
}

export interface ScopedKnowledgeSourceBinding {
	sourceWorkflowId: string;
	sourceHead: WorkflowJournalHead;
	sourceEpochRef: WorkflowEpochRef;
	sourceEventSequence: number;
	sourceEventDigest: string;
	sourceArtifactRefs: readonly WorkflowArtifactRef[];
	sourceReceipt: WorkflowVerifiedHostReceipt;
	sourceWitness: WorkflowLearningHostWitness;
}

export interface ScopedKnowledgeCanonicalSource {
	record: KnowledgeRecord;
	binding: ScopedKnowledgeSourceBinding;
}

export interface ScopedKnowledgeTransferEvidence {
	evidenceId: string;
	kind: "goal-transfer" | "domain-transfer" | "global-transfer";
	artifactRefs: readonly WorkflowArtifactRef[];
	receipt: WorkflowVerifiedHostReceipt;
	witness: WorkflowLearningHostWitness;
	evidenceDigest: string;
	independence: "independent";
}

export interface ScopedKnowledgeGlobalApproval {
	approvalId: string;
	policyRevision: string;
	principal: WorkflowTrustedPrincipal;
	receipt: WorkflowVerifiedHostReceipt;
	witness: WorkflowLearningHostWitness;
	signedApprovalDigest: string;
}

export type ScopedKnowledgeTransferEvidenceDigestInput = Pick<
	ScopedKnowledgeTransferEvidence,
	"evidenceId" | "kind" | "artifactRefs" | "receipt" | "witness" | "independence"
>;

/**
 * Derive the immutable digest for independently witnessed scope-transfer evidence.
 *
 * Args:
 * input: Evidence identity, artifact references, receipt, witness, and independence marker.
 * Return: Content digest bound to the complete evidence tuple.
 */
export function scopedKnowledgeTransferEvidenceDigest(input: ScopedKnowledgeTransferEvidenceDigestInput): string {
	return digestObject({
		kind: "scoped-knowledge-transfer-evidence",
		evidenceId: input.evidenceId,
		transferKind: input.kind,
		artifactRefs: input.artifactRefs,
		receipt: input.receipt,
		witness: input.witness,
		independence: input.independence,
	});
}

/**
 * Derive the signed fields digest for a global promotion approval.
 *
 * Args:
 * input: Approval identity, policy revision, and authenticated principal.
 * Return: Digest that the signed approval must carry.
 */
export function scopedKnowledgeGlobalApprovalDigest(
	input: Pick<ScopedKnowledgeGlobalApproval, "approvalId" | "policyRevision" | "principal">,
): string {
	return digestObject({
		kind: "scoped-knowledge-global-approval",
		approvalId: input.approvalId,
		policyRevision: input.policyRevision,
		principal: input.principal,
	});
}

function expectedTransferKind(scope: ScopedKnowledgePromotableScope): ScopedKnowledgeTransferEvidence["kind"] {
	return scope === "goal" ? "goal-transfer" : scope === "domain" ? "domain-transfer" : "global-transfer";
}

export interface ScopedKnowledgeScopeAdmissionInput {
	requestedScope: ScopedKnowledgeScope;
	policyRevision: string;
	source: ScopedKnowledgeCanonicalSource;
	target: ScopedKnowledgeTarget;
	transferEvidence: readonly ScopedKnowledgeTransferEvidence[];
}

export interface ScopedKnowledgeScopeAdmission {
	requestedScope: ScopedKnowledgeScope;
	effectiveScope: ScopedKnowledgeScope;
	canPromote: boolean;
	policyRevision: string;
	transferEvidenceDigest: string;
	decisionDigest: string;
	executionIdentity: string;
	sessionId: string;
}

export interface ScopedKnowledgeSourceResolution {
	status: "active" | "retracted" | "revoked" | "quarantined";
	record: KnowledgeRecord | null;
}

export interface ScopedKnowledgeRecallAuthorization {
	workflowId: string;
	trustDomainId: string;
	tenantId: string;
	goalId: string | null;
	domainId: string | null;
	workspaceId: string | null;
	userId: string | null;
	policyRevision: string;
	authorizationDigest: string;
	allowedScopes?: readonly ScopedKnowledgePromotableScope[];
}

export interface ScopedKnowledgeHostBoundary {
	/** Host-owned trust-domain identity. It is never derived from a caller namespace. */
	readonly trustDomainId: string;
	/** Host-owned tenant identity for the first local trust-domain release. */
	readonly tenantId: string;
	/** Sealed central receipt context; callers never provide one per operation. */
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly trustedNow: () => string;
	readonly currentPolicyRevision: () => string;
	resolveTarget(input: {
		requestedScope: ScopedKnowledgeScope;
		sourceWorkflowId: string;
		requested: ScopedKnowledgeTarget;
	}): Promise<ScopedKnowledgeTarget>;
	admitLearningScope(input: ScopedKnowledgeScopeAdmissionInput): Promise<ScopedKnowledgeScopeAdmission>;
	resolveSource(input: {
		binding: ScopedKnowledgeSourceBinding;
		expectedContentDigest: string;
	}): Promise<ScopedKnowledgeSourceResolution>;
	readWorkflowKnowledge(input: { workflowId: string }): Promise<readonly KnowledgeRecord[]>;
	authorizeRecall(input: {
		workflowId: string;
		requestedScope: ScopedKnowledgePromotableScope;
		requested: ScopedKnowledgeTarget;
		policyRevision: string;
	}): Promise<ScopedKnowledgeRecallAuthorization>;
	verifyGlobalApproval?(input: {
		approval: ScopedKnowledgeGlobalApproval;
		source: ScopedKnowledgeCanonicalSource;
		target: ScopedKnowledgeTarget;
		policyRevision: string;
	}): Promise<void>;
}

export interface ScopedKnowledgePromotionInput {
	source: ScopedKnowledgeCanonicalSource;
	requestedScope: ScopedKnowledgeScope;
	target: ScopedKnowledgeTarget;
	transferEvidence: readonly ScopedKnowledgeTransferEvidence[];
	policyRevision: string;
	promotionReceipt?: WorkflowVerifiedHostReceipt;
	globalApproval?: ScopedKnowledgeGlobalApproval;
	crashHook?: ScopedKnowledgeCrashHook;
}

export interface ScopedKnowledgeTombstone {
	tombstoneId: string;
	scope: ScopedKnowledgeScope;
	trustDomainId: string;
	tenantId: string;
	namespace: string;
	sourceRecordId: string;
	sourceContentDigest: string;
	policyRevision: string;
	reason: ScopedKnowledgeTombstoneReason;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface ScopedKnowledgeRecord {
	scopedRecordId: string;
	scope: ScopedKnowledgePromotableScope;
	target: ScopedKnowledgeTarget;
	sourceRecord: KnowledgeRecord | null;
	source: ScopedKnowledgeSourceBinding;
	provenance: KnowledgeProvenance;
	transferEvidence: readonly ScopedKnowledgeTransferEvidence[];
	transferEvidenceDigest: string;
	policyRevision: string;
	approvalDigest: string | null;
	globalApproval: ScopedKnowledgeGlobalApproval | null;
	contradictionKey: string;
	status: ScopedKnowledgeRecordStatus;
	revision: number;
	contentDigest: string;
	sourceDigest: string;
	createdAt: string;
	updatedAt: string;
	tombstone: ScopedKnowledgeTombstone | null;
}

export interface ScopedKnowledgeOutboxEntry {
	idempotencyKey: string;
	operation: "upsert" | "delete";
	scopedRecordId: string;
	revision: number;
	recordDigest: string | null;
	sourceDigest: string | null;
	fenceDigest: string;
}

export interface ScopedKnowledgeState {
	version: typeof SCOPED_KNOWLEDGE_SCHEMA_VERSION;
	trustDomainId: string;
	sequence: number;
	records: Record<string, ScopedKnowledgeRecord>;
	tombstones: Record<string, ScopedKnowledgeTombstone>;
	outbox: Record<string, ScopedKnowledgeOutboxEntry>;
	idempotency: Record<
		string,
		{
			payloadDigest: string;
			scopedRecordId: string;
			status: "committed" | "denied";
			entry: ScopedKnowledgeOutboxEntry;
		}
	>;
	digest: string;
}

export interface ScopedKnowledgeAtomicCommitInput {
	expectedDigest: string;
	idempotencyKey: string;
	idempotencyPayloadDigest: string;
	operation: "promote" | "retract" | "deny";
	record: ScopedKnowledgeRecord | null;
	tombstone: ScopedKnowledgeTombstone;
	outbox: ScopedKnowledgeOutboxEntry;
	crashHook?: ScopedKnowledgeCrashHook;
}

export type ScopedKnowledgeCrashPoint = "before-commit" | "after-commit";
export type ScopedKnowledgeCrashHook = (point: ScopedKnowledgeCrashPoint) => void | Promise<void>;

export interface ScopedKnowledgeStorageCommitResult {
	status: "committed" | "replayed";
	state: ScopedKnowledgeState;
	entry: ScopedKnowledgeOutboxEntry;
}

export interface ScopedKnowledgeDurableStorage {
	read(): Promise<ScopedKnowledgeState>;
	commit(input: ScopedKnowledgeAtomicCommitInput): Promise<ScopedKnowledgeStorageCommitResult>;
	pendingOutbox(): Promise<readonly ScopedKnowledgeOutboxEntry[]>;
	acknowledgeOutbox(input: { idempotencyKey: string; expectedFenceDigest: string }): Promise<void>;
	recover(): Promise<{ status: "healthy" | "recovered" | "quarantined"; reason: string | null }>;
}

export interface ScopedKnowledgeRecallRecord {
	source: "workflow" | "scoped";
	scope: "workflow" | ScopedKnowledgePromotableScope;
	namespace: string;
	recordId: string;
	kind: "how" | "why";
	title: string;
	statement: string;
	provenance: KnowledgeProvenance;
	contentDigest: string;
	sourceDigest: string;
	revision: number;
	contradictionKey: string;
	status: "active" | "superseded";
}

export interface ScopedKnowledgeRecallInput {
	workflowId: string;
	query: string;
	requestedScope: ScopedKnowledgePromotableScope;
	target: ScopedKnowledgeTarget;
	policyRevision: string;
}

export interface ScopedKnowledgeProjection {
	upsert(record: ScopedKnowledgeRecallRecord): Promise<void>;
	delete(scopedRecordId: string): Promise<void>;
}

export interface ScopedKnowledgeOutboxDrainResult {
	status: "disabled" | "healthy" | "degraded";
	pending: number;
	projected: number;
	reason: string | null;
}

export interface ScopedKnowledgePromotionResult {
	status: "committed" | "replayed" | "denied";
	record: ScopedKnowledgeRecord | null;
	tombstone: ScopedKnowledgeTombstone | null;
	authorization: WorkflowHostPrincipalCapabilityAuthorization | null;
}

export interface ScopedKnowledgeAuthority {
	promote(input: ScopedKnowledgePromotionInput): Promise<ScopedKnowledgePromotionResult>;
	recall(input: ScopedKnowledgeRecallInput): Promise<readonly ScopedKnowledgeRecallRecord[]>;
	read(): Promise<ScopedKnowledgeState>;
	revalidate(): Promise<void>;
	drainOutbox(projection?: ScopedKnowledgeProjection): Promise<ScopedKnowledgeOutboxDrainResult>;
	recover(): Promise<{ status: "healthy" | "recovered" | "quarantined"; reason: string | null }>;
}

export interface ScopedKnowledgeAuthorityConstructionInput {
	storage: ScopedKnowledgeDurableStorage;
	host: ScopedKnowledgeHostBoundary;
}

export interface ScopedKnowledgePromotionAuthorizationDigestInput {
	scope: ScopedKnowledgePromotableScope;
	target: ScopedKnowledgeTarget;
	source: ScopedKnowledgeSourceBinding;
	sourceContentDigest: string;
	transferEvidenceDigest: string;
	policyRevision: string;
	approvalDigest: string | null;
	executionIdentity: string;
	sessionId: string;
}

export interface ScopedKnowledgePromotionAuthorizationDigests {
	resourceDigest: string;
	operationDigest: string;
	bindingDigest: string;
}

/**
 * Derive the host capability digests used by a scoped knowledge promotion.
 *
 * Args:
 * input: Canonical source, target, transfer, policy, and host execution tuple.
 * Return: Resource, operation, and receipt binding digests.
 */
export function scopedKnowledgePromotionAuthorizationDigests(
	input: ScopedKnowledgePromotionAuthorizationDigestInput,
): ScopedKnowledgePromotionAuthorizationDigests {
	const resourceDigest = digestObject({
		kind: "scoped-knowledge-promotion-resource",
		capability: PROMOTION_CAPABILITY,
		scope: input.scope,
		target: input.target,
		source: input.source,
		sourceContentDigest: input.sourceContentDigest,
		transferEvidenceDigest: input.transferEvidenceDigest,
		policyRevision: input.policyRevision,
		approvalDigest: input.approvalDigest,
	});
	const operationDigest = digestObject({
		kind: "scoped-knowledge-promotion-operation",
		capability: PROMOTION_CAPABILITY,
		resourceDigest,
		sourceWorkflowId: input.source.sourceWorkflowId,
		sourceHead: input.source.sourceHead,
		sourceEpochRef: input.source.sourceEpochRef,
		sourceEventSequence: input.source.sourceEventSequence,
		sourceEventDigest: input.source.sourceEventDigest,
		stateDigest: input.source.sourceReceipt.stateDigest,
		revision: input.source.sourceReceipt.revision,
		executionIdentity: input.executionIdentity,
		sessionId: input.sessionId,
	});
	return {
		resourceDigest,
		operationDigest,
		bindingDigest: digestObject({
			kind: "scoped-knowledge-promotion-binding",
			capability: PROMOTION_CAPABILITY,
			resourceDigest,
			operationDigest,
			scope: input.scope,
			policyRevision: input.policyRevision,
		}),
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertSealedReceiptContext(context: WorkflowHostReceiptConsumerContext): void {
	if (
		!Object.isFrozen(context) ||
		!Object.isFrozen(context.receiptResolver) ||
		!Object.isFrozen(context.keyResolver) ||
		!Object.isFrozen(context.artifactResolver) ||
		!Object.isFrozen(context.principalAuthorizer)
	)
		throw new Error("CONTRACT_CHANGE: scoped knowledge requires the canonical sealed host receipt context.");
}

interface ScopedKnowledgeHostIdentity {
	trustDomainId: string;
	tenantId: string | null;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const expected = new Set(keys);
	for (const key of Object.keys(value))
		if (!expected.has(key)) throw new Error(`${label} contains unknown field ${key}.`);
}

function assertString(value: unknown, label: string, maxBytes = MAX_STRING_BYTES): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty.`);
	if (new TextEncoder().encode(value).byteLength > maxBytes) throw new Error(`${label} exceeds its bounded size.`);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
	assertString(value, label, MAX_IDENTIFIER_BYTES);
}

function assertDigest(value: unknown, label: string): asserts value is string {
	assertString(value, label, MAX_IDENTIFIER_BYTES);
	if (!SHA256.test(value)) throw new Error(`${label} must be a sha256 digest.`);
}

function assertTimestamp(value: unknown, label: string): void {
	assertString(value, label, MAX_IDENTIFIER_BYTES);
	if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)))
		throw new Error(`${label} must be an ISO timestamp.`);
}

function assertInteger(value: unknown, label: string, minimum = 0): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be a safe integer.`);
}

function sameValue(left: unknown, right: unknown): boolean {
	return digestObject(left) === digestObject(right);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function assertNoRawTransferData(value: unknown, path = "transferEvidence", depth = 0): void {
	if (depth > MAX_SCAN_DEPTH) throw new Error("Scoped knowledge transfer evidence exceeded the nesting limit.");
	if (typeof value === "string") {
		if (SECRET_PATTERNS.some((pattern) => pattern.test(value)))
			throw new Error(`Secret material is not allowed in ${path}.`);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_TRANSFER_EVIDENCE) throw new Error(`${path} exceeds the bounded array length.`);
		for (const [index, item] of value.entries()) assertNoRawTransferData(item, `${path}[${index}]`, depth + 1);
		return;
	}
	if (!isPlainRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (RAW_TRANSFER_KEY.test(key) && key !== "sourceDigest")
			throw new Error(
				`Scoped knowledge transfer evidence cannot contain raw holdout, per-case, or secret data (${path}.${key}).`,
			);
		assertNoRawTransferData(child, `${path}.${key}`, depth + 1);
	}
}

function assertArtifactRef(ref: WorkflowArtifactRef, label: string): void {
	if (!isPlainRecord(ref)) throw new Error(`${label} is invalid.`);
	assertExactKeys(ref, ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"], label);
	assertIdentifier(ref.artifactId, `${label}.artifactId`);
	assertString(ref.relativePath, `${label}.relativePath`);
	if (
		ref.relativePath.startsWith("/") ||
		ref.relativePath.includes("\\") ||
		ref.relativePath.split("/").some((segment) => segment === ".." || segment === "." || segment.length === 0)
	)
		throw new Error(`${label}.relativePath must stay within the host artifact root.`);
	assertDigest(ref.digest, `${label}.digest`);
	assertInteger(ref.sizeBytes, `${label}.sizeBytes`);
	assertInteger(ref.sourceEventSequence, `${label}.sourceEventSequence`, 1);
}

function artifactKey(ref: WorkflowArtifactRef): string {
	return `${ref.artifactId}:${ref.digest}:${ref.sizeBytes}:${ref.sourceEventSequence}`;
}

function validateTransferEvidence(
	value: ScopedKnowledgeTransferEvidence,
	sourceWorkflowId: string,
	label: string,
): ScopedKnowledgeTransferEvidence {
	if (!isPlainRecord(value)) throw new Error(`${label} is invalid.`);
	assertExactKeys(
		value,
		["evidenceId", "kind", "artifactRefs", "receipt", "witness", "evidenceDigest", "independence"],
		label,
	);
	assertIdentifier(value.evidenceId, `${label}.evidenceId`);
	if (value.kind !== "goal-transfer" && value.kind !== "domain-transfer" && value.kind !== "global-transfer")
		throw new Error(`${label}.kind is invalid.`);
	if (
		!Array.isArray(value.artifactRefs) ||
		value.artifactRefs.length === 0 ||
		value.artifactRefs.length > MAX_ARTIFACT_REFS
	)
		throw new Error(`${label}.artifactRefs must contain bounded immutable evidence.`);
	for (const ref of value.artifactRefs) assertArtifactRef(ref, `${label}.artifactRef`);
	assertIdentifier(value.receipt.receiptId, `${label}.receipt id`);
	if (value.receipt.workflowId !== sourceWorkflowId) throw new Error(`${label} crossed its source workflow.`);
	if (!value.artifactRefs.some((ref) => sameValue(ref, value.receipt.artifactRef)))
		throw new Error(`${label} receipt is not bound to its artifact set.`);
	assertVerifiedWitness(value.receipt, value.witness, sourceWorkflowId, label);
	assertDigest(value.evidenceDigest, `${label}.evidenceDigest`);
	if (value.independence !== "independent") throw new Error(`${label} is not independently witnessed.`);
	if (
		value.evidenceDigest !==
		scopedKnowledgeTransferEvidenceDigest({
			evidenceId: value.evidenceId,
			kind: value.kind,
			artifactRefs: value.artifactRefs,
			receipt: value.receipt,
			witness: value.witness,
			independence: value.independence,
		})
	)
		throw new Error(`${label} digest is not bound to its receipt, witness, and artifacts.`);
	return freezeKnowledgeValue(value);
}

function assertTarget(target: ScopedKnowledgeTarget, host: ScopedKnowledgeHostIdentity): void {
	if (!isPlainRecord(target)) throw new Error("Scoped knowledge target is invalid.");
	assertExactKeys(
		target,
		["scope", "trustDomainId", "tenantId", "namespace", "goalId", "domainId", "workspaceId", "userId"],
		"scoped knowledge target",
	);
	if (!SCOPED_KNOWLEDGE_SCOPES.includes(target.scope)) throw new Error("Scoped knowledge target scope is invalid.");
	assertIdentifier(target.trustDomainId, "scoped knowledge target trust domain");
	assertIdentifier(target.tenantId, "scoped knowledge target tenant");
	assertIdentifier(target.namespace, "scoped knowledge target namespace");
	if (target.trustDomainId !== host.trustDomainId || (host.tenantId !== null && target.tenantId !== host.tenantId))
		throw new Error("Scoped knowledge target is outside the authenticated host trust domain.");
	if (!target.namespace.startsWith(`${target.scope}:`))
		throw new Error("Scoped knowledge namespace is not host-canonical.");
	if (target.scope === "goal" && target.goalId === null)
		throw new Error("Goal-scoped knowledge requires a canonical goal identity.");
	if (target.scope === "domain" && target.domainId === null)
		throw new Error("Domain-scoped knowledge requires a canonical domain identity.");
	if (target.scope === "domain" && target.goalId !== null)
		throw new Error("Domain-scoped knowledge cannot retain a goal identity.");
	if (target.scope === "global" && (target.goalId !== null || target.domainId !== null))
		throw new Error("Global-scoped knowledge cannot retain a goal or domain identity.");
	if (target.scope === "never" && (target.goalId !== null || target.domainId !== null))
		throw new Error("Never-scoped knowledge cannot retain a goal or domain identity.");
	for (const [label, value] of [
		["goalId", target.goalId],
		["domainId", target.domainId],
		["workspaceId", target.workspaceId],
		["userId", target.userId],
	] as const)
		if (value !== null) assertIdentifier(value, `scoped knowledge target ${label}`);
}

function validateSourceBinding(source: ScopedKnowledgeCanonicalSource, trustedNow: string): void {
	const record = validateKnowledgeRecord(clone(source.record));
	if (record.status !== "active")
		throw new Error("Scoped knowledge promotion requires an active canonical source record.");
	if (record.kind !== "how" && record.kind !== "why" && record.kind !== "procedure")
		throw new Error("Scoped knowledge source kind is invalid.");
	const binding = source.binding;
	if (!isPlainRecord(binding)) throw new Error("Scoped knowledge source binding is invalid.");
	assertIdentifier(binding.sourceWorkflowId, "source workflow id");
	if (!isPlainRecord(binding.sourceHead)) throw new Error("source workflow head is invalid.");
	assertExactKeys(binding.sourceHead, ["workflowId", "sequence", "eventDigest", "epochRef"], "source workflow head");
	if (binding.sourceHead.workflowId !== binding.sourceWorkflowId || binding.sourceHead.eventDigest === null)
		throw new Error("Scoped knowledge source head is not bound to the source workflow.");
	assertInteger(binding.sourceHead.sequence, "source workflow head sequence", 1);
	if (!sameValue(binding.sourceHead.epochRef, binding.sourceEpochRef))
		throw new Error("Scoped knowledge source head epoch is not bound to the source event.");
	if (
		binding.sourceHead.sequence !== binding.sourceEventSequence ||
		binding.sourceHead.eventDigest !== binding.sourceEventDigest
	)
		throw new Error("Scoped knowledge source event is not the exact authenticated source head.");
	assertInteger(binding.sourceEventSequence, "source event sequence", 1);
	assertDigest(binding.sourceEventDigest, "source event digest");
	if (
		!sameValue(record.epochRef, binding.sourceEpochRef) ||
		record.commitRef.knowledgeJournalSequence !== binding.sourceEventSequence
	)
		throw new Error("Scoped knowledge source record epoch or event sequence is stale.");
	if (record.commitRef.knowledgeJournalDigest !== binding.sourceEventDigest)
		throw new Error("Scoped knowledge source record is not bound to the source event digest.");
	if (record.evidenceRefs.some((ref) => ref.workflowId !== binding.sourceWorkflowId))
		throw new Error("Scoped knowledge source evidence crossed its workflow boundary.");
	const recordArtifacts = record.evidenceRefs.flatMap((ref) => ref.artifactRefs);
	if (
		binding.sourceArtifactRefs.length === 0 ||
		binding.sourceArtifactRefs.length > MAX_ARTIFACT_REFS ||
		new Set(binding.sourceArtifactRefs.map(artifactKey)).size !== binding.sourceArtifactRefs.length ||
		!sameValue(binding.sourceArtifactRefs, recordArtifacts)
	)
		throw new Error("Scoped knowledge source artifacts are not the exact canonical evidence set.");
	for (const ref of binding.sourceArtifactRefs) assertArtifactRef(ref, "source artifact");
	assertVerifiedWitness(binding.sourceReceipt, binding.sourceWitness, binding.sourceWorkflowId, "source");
	assertTimestamp(trustedNow, "trusted host clock");
	if (binding.sourceReceipt.workflowId !== binding.sourceWorkflowId)
		throw new Error("Scoped knowledge source receipt belongs to a different workflow.");
	if (
		binding.sourceReceipt.artifactRef === undefined ||
		!binding.sourceArtifactRefs.some((ref) => sameValue(ref, binding.sourceReceipt.artifactRef))
	)
		throw new Error("Scoped knowledge source receipt is not bound to the source artifact set.");
	if (binding.sourceReceipt.oneUse && binding.sourceWitness.oneUse !== true)
		throw new Error("One-use source receipts require a one-use witness.");
	if (!binding.sourceReceipt.oneUse && binding.sourceWitness.oneUse !== false)
		throw new Error("Source receipt witness does not match the receipt one-use policy.");
}

function assertVerifiedWitness(
	receipt: WorkflowVerifiedHostReceipt,
	witness: WorkflowLearningHostWitness,
	workflowId: string,
	label: string,
): void {
	if (!isPlainRecord(receipt) || !isPlainRecord(witness)) throw new Error(`${label} receipt witness is invalid.`);
	if (
		receipt.workflowId !== workflowId ||
		witness.workflowId !== workflowId ||
		witness.witnessKind !== "receipt" ||
		witness.evidenceRef.artifactId !== receipt.artifactRef.artifactId ||
		witness.evidenceRef.digest !== receipt.artifactRef.digest ||
		witness.evidenceRef.sizeBytes !== receipt.artifactRef.sizeBytes ||
		witness.evidenceRef.sourceEventSequence !== receipt.artifactRef.sourceEventSequence ||
		witness.payloadDigest !== receipt.bindingDigest ||
		witness.bytesDigest !== receipt.artifactRef.digest ||
		witness.bytesSize !== receipt.artifactRef.sizeBytes ||
		witness.revision !== receipt.revision ||
		!Number.isSafeInteger(witness.storeEpoch) ||
		witness.storeEpoch < 1 ||
		!Number.isSafeInteger(witness.coordinatorEpoch) ||
		witness.coordinatorEpoch < 1 ||
		witness.stateHeadDigest.length === 0 ||
		witness.trustedNow !== receipt.issuedAt ||
		witness.oneUse !== receipt.oneUse
	)
		throw new Error(`${label} receipt witness is not bound to its receipt.`);
	assertIdentifier(witness.witnessId, `${label} witness id`);
}

async function resolveArtifact(
	resolver: WorkflowArtifactResolver,
	ref: WorkflowArtifactRef,
	label: string,
): Promise<Uint8Array> {
	assertArtifactRef(ref, label);
	const resolved = await resolver.resolve(ref);
	const bytes = new Uint8Array(resolved.bytes);
	if (
		resolved.exists !== true ||
		resolved.envelope.immutable !== true ||
		!sameValue(resolved.envelope.ref, ref) ||
		resolved.verifiedDigest !== ref.digest ||
		resolved.verifiedSizeBytes !== ref.sizeBytes ||
		bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(bytes) !== ref.digest ||
		bytes.byteLength > MAX_ARTIFACT_BYTES
	)
		throw new Error(`${label} is not an immutable content-addressed host artifact.`);
	return bytes;
}

async function verifyReceipt(
	context: WorkflowHostReceiptConsumerContext,
	resolver: WorkflowArtifactResolver,
	receipt: WorkflowVerifiedHostReceipt,
	trustedNow: string,
	label: string,
): Promise<WorkflowVerifiedHostReceipt> {
	if (!isPlainRecord(receipt)) throw new Error(`${label} is invalid.`);
	assertIdentifier(receipt.receiptId, `${label} id`);
	assertIdentifier(receipt.workflowId, `${label} workflow`);
	assertDigest(receipt.bindingDigest, `${label} binding`);
	assertTimestamp(receipt.issuedAt, `${label} issuedAt`);
	assertTimestamp(receipt.validUntil, `${label} validUntil`);
	if (
		Date.parse(trustedNow) < Date.parse(receipt.issuedAt) ||
		Date.parse(trustedNow) >= Date.parse(receipt.validUntil)
	)
		throw new Error(`${label} is stale or not yet valid.`);
	await resolveArtifact(resolver, receipt.artifactRef, `${label} artifact`);
	const verified = await resolveAndVerifyWorkflowHostReceipt({
		context,
		workflowId: receipt.workflowId,
		expectedBindingDigest: receipt.bindingDigest,
		receipt,
		currentStateDigest: receipt.stateDigest,
		currentRevision: receipt.revision,
		trustedNow,
	});
	if (!sameValue(verified, receipt)) throw new Error(`${label} resolver returned a different receipt.`);
	return verified;
}

async function requireConsumedWitness(
	context: WorkflowHostReceiptConsumerContext,
	receipt: WorkflowVerifiedHostReceipt,
	label: string,
): Promise<void> {
	if (!receipt.oneUse) return;
	const witness = await context.receiptResolver.resolveConsumptionWitness({
		receiptId: receipt.receiptId,
		workflowId: receipt.workflowId,
		expectedBindingDigest: receipt.bindingDigest,
	});
	if (
		witness.receiptId !== receipt.receiptId ||
		witness.workflowId !== receipt.workflowId ||
		witness.bindingDigest !== receipt.bindingDigest ||
		!Number.isSafeInteger(witness.consumptionSequence) ||
		witness.consumptionSequence < 1
	)
		throw new Error(`${label} one-use witness is invalid.`);
}

async function consumeReceipt(
	context: WorkflowHostReceiptConsumerContext,
	receipt: WorkflowVerifiedHostReceipt,
	label: string,
): Promise<void> {
	if (!receipt.oneUse) return;
	try {
		await requireConsumedWitness(context, receipt, label);
		return;
	} catch {
		await context.receiptResolver.consumeIfOneUse({
			receipt,
			workflowId: receipt.workflowId,
			expectedBindingDigest: receipt.bindingDigest,
			currentRevision: receipt.revision,
		});
	}
	await requireConsumedWitness(context, receipt, label);
}

function isDefinitiveSourceRevocationError(error: unknown): boolean {
	return error instanceof Error && /\b(?:revoked|retracted|quarantined)\b/iu.test(error.message);
}

function validateAdmission(
	input: ScopedKnowledgeScopeAdmissionInput,
	admission: ScopedKnowledgeScopeAdmission,
	currentPolicyRevision: string,
	transferEvidenceDigest: string,
): void {
	assertIdentifier(admission.executionIdentity, "scoped knowledge admission execution identity");
	assertIdentifier(admission.sessionId, "scoped knowledge admission session");
	assertDigest(admission.decisionDigest, "scoped knowledge admission decision");
	if (
		admission.requestedScope !== input.requestedScope ||
		admission.policyRevision !== currentPolicyRevision ||
		admission.transferEvidenceDigest !== transferEvidenceDigest ||
		admission.effectiveScope !== input.requestedScope ||
		!admission.canPromote ||
		admission.executionIdentity.length === 0 ||
		admission.sessionId.length === 0
	)
		throw new Error("Scoped knowledge learning-scope admission is stale, rejected, or not host-authenticated.");
}

function validatePrincipalAuthorization(
	decision: WorkflowHostPrincipalCapabilityAuthorization,
	input: WorkflowHostPrincipalCapabilityAuthorizationInput,
): void {
	if (
		!isPlainRecord(decision) ||
		decision.authenticatedPrincipal.length === 0 ||
		decision.keyOwnerPrincipal !== decision.authenticatedPrincipal ||
		decision.capability !== PROMOTION_CAPABILITY ||
		decision.workflowId !== input.workflowId ||
		decision.bindingDigest !== input.bindingDigest ||
		decision.stateDigest !== input.stateDigest ||
		decision.revision !== input.revision ||
		!sameValue(decision.epochRef, input.epochRef) ||
		!sameValue(decision.receipt, input.receipt) ||
		decision.validity.issuedAt !== input.receipt.issuedAt ||
		decision.validity.validUntil !== input.receipt.validUntil ||
		decision.executionIdentity !== input.executionIdentity ||
		decision.sessionId !== input.sessionId ||
		!SHA256.test(decision.authorizationDigest)
	)
		throw new Error("Scoped knowledge principal capability authorization is not bound to the promotion tuple.");
}

function createTombstone(input: {
	scope: ScopedKnowledgeScope;
	target: ScopedKnowledgeTarget;
	source: ScopedKnowledgeCanonicalSource;
	policyRevision: string;
	reason: ScopedKnowledgeTombstoneReason;
	revision: number;
	now: string;
}): ScopedKnowledgeTombstone {
	return freezeKnowledgeValue({
		tombstoneId: digestObject({
			kind: "scoped-knowledge-tombstone",
			scope: input.scope,
			target: input.target,
			sourceRecordId: input.source.record.recordId,
			sourceContentDigest: input.source.record.contentDigest,
			reason: input.reason,
		}),
		scope: input.scope,
		trustDomainId: input.target.trustDomainId,
		tenantId: input.target.tenantId,
		namespace: input.target.namespace,
		sourceRecordId: input.source.record.recordId,
		sourceContentDigest: input.source.record.contentDigest,
		policyRevision: input.policyRevision,
		reason: input.reason,
		revision: input.revision,
		createdAt: input.now,
		updatedAt: input.now,
	});
}

function createRetractedRecord(
	record: ScopedKnowledgeRecord,
	tombstone: ScopedKnowledgeTombstone,
): ScopedKnowledgeRecord {
	return freezeKnowledgeValue({
		...record,
		sourceRecord: null,
		status: "retracted" as const,
		revision: record.revision + 1,
		updatedAt: tombstone.updatedAt,
		contentDigest: tombstone.sourceContentDigest,
		sourceDigest: tombstone.tombstoneId,
		tombstone,
	});
}

function createRecallRecord(
	source: "workflow" | "scoped",
	scope: "workflow" | ScopedKnowledgePromotableScope,
	namespace: string,
	record: KnowledgeRecord,
	metadata: { contradictionKey: string; status: "active" | "superseded"; revision: number },
): ScopedKnowledgeRecallRecord | null {
	if (record.kind !== "how" && record.kind !== "why") return null;
	return freezeKnowledgeValue({
		source,
		scope,
		namespace,
		recordId: record.recordId,
		kind: record.kind,
		title: record.title,
		statement: record.statement,
		provenance: record.provenance,
		contentDigest: record.contentDigest,
		sourceDigest: record.sourceDigest,
		revision: metadata.revision,
		contradictionKey: metadata.contradictionKey,
		status: metadata.status,
	});
}

function emptyState(trustDomainId: string): ScopedKnowledgeState {
	return finalizeState({
		version: SCOPED_KNOWLEDGE_SCHEMA_VERSION,
		trustDomainId,
		sequence: 0,
		records: {},
		tombstones: {},
		outbox: {},
		idempotency: {},
	});
}

function finalizeState(input: Omit<ScopedKnowledgeState, "digest">): ScopedKnowledgeState {
	return freezeKnowledgeValue({ ...input, digest: digestObject(input) });
}

function scopedRecordIdFor(
	scope: ScopedKnowledgePromotableScope,
	target: ScopedKnowledgeTarget,
	sourceRecordId: string,
	sourceRevision: number,
	sourceContentDigest: string,
): string {
	return digestObject({
		kind: "scoped-knowledge-record",
		scope,
		target,
		sourceRecordId,
		sourceRevision,
		sourceContentDigest,
	});
}

function contradictionKeyFor(target: ScopedKnowledgeTarget, sourceRecordId: string): string {
	return digestObject({
		kind: "scoped-knowledge-contradiction",
		target,
		recordId: sourceRecordId,
	});
}

function validateScopedTombstone(
	value: ScopedKnowledgeTombstone,
	host: ScopedKnowledgeHostIdentity,
): ScopedKnowledgeTombstone {
	if (!isPlainRecord(value)) throw new Error("Scoped knowledge tombstone is invalid.");
	assertExactKeys(
		value,
		[
			"tombstoneId",
			"scope",
			"trustDomainId",
			"tenantId",
			"namespace",
			"sourceRecordId",
			"sourceContentDigest",
			"policyRevision",
			"reason",
			"revision",
			"createdAt",
			"updatedAt",
		],
		"scoped knowledge tombstone",
	);
	assertDigest(value.tombstoneId, "scoped knowledge tombstone id");
	if (!SCOPED_KNOWLEDGE_SCOPES.includes(value.scope)) throw new Error("Scoped knowledge tombstone scope is invalid.");
	assertIdentifier(value.trustDomainId, "scoped knowledge tombstone trust domain");
	assertIdentifier(value.tenantId, "scoped knowledge tombstone tenant");
	if (value.trustDomainId !== host.trustDomainId || (host.tenantId !== null && value.tenantId !== host.tenantId))
		throw new Error("Scoped knowledge tombstone crossed its host boundary.");
	assertIdentifier(value.namespace, "scoped knowledge tombstone namespace");
	assertIdentifier(value.sourceRecordId, "scoped knowledge tombstone source record");
	assertDigest(value.sourceContentDigest, "scoped knowledge tombstone source content");
	assertIdentifier(value.policyRevision, "scoped knowledge tombstone policy revision");
	if (
		!(
			"never" === value.reason ||
			"source-retracted" === value.reason ||
			"source-revoked" === value.reason ||
			"source-quarantined" === value.reason
		)
	)
		throw new Error("Scoped knowledge tombstone reason is invalid.");
	if ((value.reason === "never") !== (value.scope === "never"))
		throw new Error("Scoped knowledge tombstone reason and scope are mismatched.");
	assertInteger(value.revision, "scoped knowledge tombstone revision", 1);
	assertTimestamp(value.createdAt, "scoped knowledge tombstone createdAt");
	assertTimestamp(value.updatedAt, "scoped knowledge tombstone updatedAt");
	return freezeKnowledgeValue(value);
}

function validateScopedRecord(value: ScopedKnowledgeRecord, host: ScopedKnowledgeHostIdentity): ScopedKnowledgeRecord {
	if (!isPlainRecord(value)) throw new Error("Scoped knowledge record is invalid.");
	assertExactKeys(
		value,
		[
			"scopedRecordId",
			"scope",
			"target",
			"sourceRecord",
			"source",
			"provenance",
			"transferEvidence",
			"transferEvidenceDigest",
			"policyRevision",
			"approvalDigest",
			"globalApproval",
			"contradictionKey",
			"status",
			"revision",
			"contentDigest",
			"sourceDigest",
			"createdAt",
			"updatedAt",
			"tombstone",
		],
		"scoped knowledge record",
	);
	assertDigest(value.scopedRecordId, "scoped knowledge record id");
	if (!SCOPED_KNOWLEDGE_SCOPES.includes(value.scope)) throw new Error("Scoped knowledge record scope is invalid.");
	assertTarget(value.target, host);
	if (value.target.scope !== value.scope) throw new Error("Scoped knowledge record target scope is mismatched.");
	if (!Array.isArray(value.transferEvidence) || value.transferEvidence.length === 0)
		throw new Error("Scoped knowledge record must retain independently witnessed transfer evidence.");
	assertNoRawTransferData(value.transferEvidence, "scoped knowledge transferEvidence");
	for (const [index, evidence] of value.transferEvidence.entries())
		validateTransferEvidence(evidence, value.source.sourceWorkflowId, `scoped knowledge transfer evidence[${index}]`);
	if (value.transferEvidence.some((evidence) => evidence.kind !== expectedTransferKind(value.scope)))
		throw new Error("Scoped knowledge transfer evidence kind does not match its promotion scope.");
	if (value.transferEvidenceDigest !== digestObject(value.transferEvidence))
		throw new Error("Scoped knowledge transfer evidence digest is stale.");
	if (value.status === "active" || value.status === "superseded") {
		if (value.sourceRecord === null) throw new Error("Active scoped knowledge cannot omit its source record.");
		validateKnowledgeRecord(clone(value.sourceRecord));
		if (value.sourceRecord.status !== "active") throw new Error("Active scoped knowledge source is not active.");
		validateSourceBinding({ record: value.sourceRecord, binding: value.source }, value.updatedAt);
		if (value.tombstone !== null) throw new Error("Active scoped knowledge cannot carry a tombstone.");
		if (
			value.scopedRecordId !==
			scopedRecordIdFor(
				value.scope as ScopedKnowledgePromotableScope,
				value.target,
				value.sourceRecord.recordId,
				value.sourceRecord.revision,
				value.sourceRecord.contentDigest,
			)
		)
			throw new Error("Scoped knowledge record id is not canonical.");
		if (value.contradictionKey !== contradictionKeyFor(value.target, value.sourceRecord.recordId))
			throw new Error("Scoped knowledge contradiction key is not canonical.");
		if (
			value.contentDigest !== value.sourceRecord.contentDigest ||
			value.sourceDigest !== value.sourceRecord.sourceDigest
		)
			throw new Error("Scoped knowledge content or source digest is stale.");
	} else if (value.status === "retracted") {
		if (value.sourceRecord !== null || value.tombstone === null)
			throw new Error("Retracted scoped knowledge is not redacted.");
		validateScopedTombstone(value.tombstone, host);
		if (value.contradictionKey !== contradictionKeyFor(value.target, value.tombstone.sourceRecordId))
			throw new Error("Retracted scoped knowledge contradiction key is not canonical.");
		if (
			value.contentDigest !== value.tombstone.sourceContentDigest ||
			value.sourceDigest !== value.tombstone.tombstoneId
		)
			throw new Error("Retracted scoped knowledge tombstone digests are stale.");
	} else throw new Error("Scoped knowledge record status is invalid.");
	if (!isPlainRecord(value.provenance) || (value.provenance.source !== "host" && value.provenance.source !== "user"))
		throw new Error("Scoped knowledge provenance is invalid.");
	assertIdentifier(value.provenance.producerId, "scoped knowledge producer");
	assertDigest(value.transferEvidenceDigest, "scoped knowledge transfer evidence digest");
	assertIdentifier(value.policyRevision, "scoped knowledge policy revision");
	if (value.approvalDigest !== null) assertDigest(value.approvalDigest, "scoped knowledge approval digest");
	if (value.globalApproval === null) {
		if (value.approvalDigest !== null) throw new Error("Scoped knowledge approval digest has no canonical approval.");
		if (value.scope === "global") throw new Error("Global scoped knowledge requires its canonical approval.");
	} else {
		if (value.scope !== "global") throw new Error("Non-global scoped knowledge cannot carry a global approval.");
		if (value.approvalDigest !== digestObject(value.globalApproval))
			throw new Error("Scoped knowledge global approval digest is stale.");
		if (value.globalApproval.policyRevision !== value.policyRevision)
			throw new Error("Scoped knowledge global approval policy is stale.");
		assertDigest(value.globalApproval.signedApprovalDigest, "scoped knowledge signed approval digest");
		if (value.globalApproval.signedApprovalDigest !== scopedKnowledgeGlobalApprovalDigest(value.globalApproval))
			throw new Error("Scoped knowledge signed approval digest is not canonical.");
		assertVerifiedWitness(
			value.globalApproval.receipt,
			value.globalApproval.witness,
			value.source.sourceWorkflowId,
			"scoped global approval",
		);
	}
	assertDigest(value.contradictionKey, "scoped knowledge contradiction key");
	assertInteger(value.revision, "scoped knowledge revision", 1);
	assertDigest(value.contentDigest, "scoped knowledge content digest");
	assertDigest(value.sourceDigest, "scoped knowledge source digest");
	assertTimestamp(value.createdAt, "scoped knowledge createdAt");
	assertTimestamp(value.updatedAt, "scoped knowledge updatedAt");
	return freezeKnowledgeValue(value);
}

function validateState(value: ScopedKnowledgeState, host: ScopedKnowledgeHostIdentity): ScopedKnowledgeState {
	if (!isPlainRecord(value)) throw new Error("Scoped knowledge durable state is invalid.");
	assertExactKeys(
		value,
		["version", "trustDomainId", "sequence", "records", "tombstones", "outbox", "idempotency", "digest"],
		"scoped knowledge state",
	);
	if (value.version !== SCOPED_KNOWLEDGE_SCHEMA_VERSION)
		throw new Error("Scoped knowledge durable schema version is unsupported.");
	assertIdentifier(value.trustDomainId, "scoped knowledge state trust domain");
	if (value.trustDomainId !== host.trustDomainId) throw new Error("Scoped knowledge state crossed its trust domain.");
	assertInteger(value.sequence, "scoped knowledge state sequence");
	if (
		!isPlainRecord(value.records) ||
		!isPlainRecord(value.tombstones) ||
		!isPlainRecord(value.outbox) ||
		!isPlainRecord(value.idempotency)
	)
		throw new Error("Scoped knowledge durable maps are invalid.");
	if (Object.keys(value.records).length > MAX_RECORDS) throw new Error("Scoped knowledge record history is bounded.");
	if (Object.keys(value.tombstones).length > MAX_TOMBSTONES)
		throw new Error("Scoped knowledge tombstones are bounded.");
	if (Object.keys(value.outbox).length > MAX_OUTBOX) throw new Error("Scoped knowledge outbox is bounded.");
	if (Object.keys(value.idempotency).length > MAX_IDEMPOTENCY)
		throw new Error("Scoped knowledge idempotency history is bounded.");
	for (const [id, record] of Object.entries(value.records)) {
		const checked = validateScopedRecord(record, host);
		if (id !== checked.scopedRecordId) throw new Error("Scoped knowledge record map key is not canonical.");
	}
	for (const [id, tombstone] of Object.entries(value.tombstones)) {
		const checked = validateScopedTombstone(tombstone, host);
		if (id !== checked.tombstoneId) throw new Error("Scoped knowledge tombstone map key is not canonical.");
	}
	for (const entry of Object.values(value.outbox)) {
		if (!isPlainRecord(entry)) throw new Error("Scoped knowledge outbox entry is invalid.");
		assertExactKeys(
			entry,
			["idempotencyKey", "operation", "scopedRecordId", "revision", "recordDigest", "sourceDigest", "fenceDigest"],
			"scoped knowledge outbox",
		);
		assertDigest(entry.idempotencyKey, "scoped knowledge outbox idempotency key");
		if (entry.operation !== "upsert" && entry.operation !== "delete")
			throw new Error("Scoped knowledge outbox operation is invalid.");
		assertDigest(entry.scopedRecordId, "scoped knowledge outbox record id");
		assertInteger(entry.revision, "scoped knowledge outbox revision", 1);
		if (entry.recordDigest !== null) assertDigest(entry.recordDigest, "scoped knowledge outbox record digest");
		if (entry.sourceDigest !== null) assertDigest(entry.sourceDigest, "scoped knowledge outbox source digest");
		assertDigest(entry.fenceDigest, "scoped knowledge outbox fence");
	}
	for (const [key, entry] of Object.entries(value.idempotency)) {
		assertDigest(key, "scoped knowledge idempotency key");
		if (!isPlainRecord(entry)) throw new Error("Scoped knowledge idempotency entry is invalid.");
		assertExactKeys(entry, ["payloadDigest", "scopedRecordId", "status", "entry"], "scoped knowledge idempotency");
		assertDigest(entry.payloadDigest, "scoped knowledge idempotency payload");
		assertDigest(entry.scopedRecordId, "scoped knowledge idempotency record");
		if (entry.status !== "committed" && entry.status !== "denied")
			throw new Error("Scoped knowledge idempotency status is invalid.");
		if (!isPlainRecord(entry.entry)) throw new Error("Scoped knowledge idempotency outbox entry is invalid.");
		assertExactKeys(
			entry.entry,
			["idempotencyKey", "operation", "scopedRecordId", "revision", "recordDigest", "sourceDigest", "fenceDigest"],
			"scoped knowledge idempotency outbox",
		);
		if (entry.entry.idempotencyKey !== key || entry.entry.scopedRecordId !== entry.scopedRecordId)
			throw new Error("Scoped knowledge idempotency outbox binding is stale.");
		assertInteger(entry.entry.revision, "scoped knowledge idempotency outbox revision", 1);
		assertDigest(entry.entry.fenceDigest, "scoped knowledge idempotency outbox fence");
	}
	assertDigest(value.digest, "scoped knowledge state digest");
	const { digest: _digest, ...withoutDigest } = value;
	if (digestObject(withoutDigest) !== value.digest) throw new Error("Scoped knowledge durable state digest is stale.");
	return freezeKnowledgeValue(value);
}

/**
 * Create an authenticated-host-owned file store for the shared scoped ledger.
 *
 * Args:
 * input: Absolute host-selected state path and trust-domain identity.
 * Return: Atomic compare-and-swap storage with durable outbox obligations.
 */
export function createFileScopedKnowledgeStorage(input: {
	filePath: string;
	trustDomainId: string;
}): ScopedKnowledgeDurableStorage {
	if (!isAbsolute(input.filePath)) throw new Error("Scoped knowledge storage path must be absolute.");
	assertIdentifier(input.trustDomainId, "scoped knowledge storage trust domain");
	const lockPath = `${input.filePath}.lock`;
	const lockOwnerPath = join(lockPath, "owner");
	const LOCK_WAIT_MILLISECONDS = 30_000;
	const LOCK_STALE_MILLISECONDS = 30_000;
	let operation = Promise.resolve();
	const withLock = <T>(callback: () => Promise<T>): Promise<T> => {
		const next = operation.then(
			() => withFileLock(callback),
			() => withFileLock(callback),
		);
		operation = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
	const sleep = async (milliseconds: number): Promise<void> => {
		await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
	};
	const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
	const isExists = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "EEXIST";
	const reclaimDeadLock = async (): Promise<boolean> => {
		try {
			const owner = Number.parseInt(await readFile(lockOwnerPath, "utf8"), 10);
			if (!Number.isSafeInteger(owner) || owner < 1) return false;
			try {
				process.kill(owner, 0);
				return false;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return false;
				await rm(lockPath, { recursive: true, force: true });
				return true;
			}
		} catch (error) {
			if (!isMissing(error)) return false;
			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MILLISECONDS) return false;
				await rm(lockPath, { recursive: true, force: true });
				return true;
			} catch (statError) {
				return isMissing(statError);
			}
		}
	};
	const acquireFileLock = async (): Promise<void> => {
		await mkdir(dirname(input.filePath), { recursive: true, mode: 0o700 });
		const startedAt = Date.now();
		while (true) {
			try {
				await mkdir(lockPath, { mode: 0o700 });
				try {
					await writeFile(lockOwnerPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
				} catch (error) {
					await rm(lockPath, { recursive: true, force: true });
					throw error;
				}
				return;
			} catch (error) {
				if (!isExists(error)) throw error;
				if (await reclaimDeadLock()) continue;
				if (Date.now() - startedAt >= LOCK_WAIT_MILLISECONDS)
					throw new Error("Scoped knowledge storage lock could not be acquired before its bounded deadline.");
				await sleep(10);
			}
		}
	};
	const withFileLock = async <T>(callback: () => Promise<T>): Promise<T> => {
		await acquireFileLock();
		try {
			return await callback();
		} finally {
			await rm(lockPath, { recursive: true, force: true });
		}
	};
	const readRaw = async (): Promise<ScopedKnowledgeState> => {
		try {
			const bytes = await readFile(input.filePath);
			const parsed = parseCanonicalJsonBytes(bytes);
			if (!isPlainRecord(parsed) || parsed.kind !== "scoped-knowledge-file" || parsed.state === undefined)
				throw new Error("Scoped knowledge storage envelope is malformed.");
			return parsed.state as unknown as ScopedKnowledgeState;
		} catch (error) {
			if (isMissing(error)) return emptyState(input.trustDomainId);
			throw error;
		}
	};
	const writeRaw = async (state: ScopedKnowledgeState): Promise<void> => {
		await mkdir(dirname(input.filePath), { recursive: true, mode: 0o700 });
		const tempPath = `${input.filePath}.${randomUUID()}.tmp`;
		try {
			await writeFile(tempPath, canonicalJsonBytes({ kind: "scoped-knowledge-file", version: 1, state }), {
				mode: 0o600,
			});
			await rename(tempPath, input.filePath);
		} finally {
			try {
				await unlink(tempPath);
			} catch {
				// The atomic rename already removed the temporary path.
			}
		}
	};
	const storage: ScopedKnowledgeDurableStorage = {
		read: async () => validateState(await readRaw(), { trustDomainId: input.trustDomainId, tenantId: null }),
		commit: (commitInput) =>
			withLock(async () => {
				const host: ScopedKnowledgeHostIdentity = { trustDomainId: input.trustDomainId, tenantId: null };
				const current = validateState(await readRaw(), host);
				const prior = current.idempotency[commitInput.idempotencyKey];
				if (prior !== undefined) {
					if (prior.payloadDigest !== commitInput.idempotencyPayloadDigest)
						throw new Error("Scoped knowledge idempotency key conflicts with a different payload.");
					return { status: "replayed" as const, state: current, entry: prior.entry };
				}
				if (current.digest !== commitInput.expectedDigest)
					throw new Error("Scoped knowledge CAS expected digest is stale.");
				const nextRecords = { ...current.records };
				const nextTombstones = { ...current.tombstones };
				if (commitInput.record !== null) nextRecords[commitInput.record.scopedRecordId] = commitInput.record;
				if (commitInput.tombstone.scope === "never")
					nextTombstones[commitInput.tombstone.tombstoneId] = commitInput.tombstone;
				const next = finalizeState({
					version: SCOPED_KNOWLEDGE_SCHEMA_VERSION,
					trustDomainId: current.trustDomainId,
					sequence: current.sequence + 1,
					records: nextRecords,
					tombstones: nextTombstones,
					outbox: { ...current.outbox, [commitInput.outbox.idempotencyKey]: commitInput.outbox },
					idempotency: {
						...current.idempotency,
						[commitInput.idempotencyKey]: {
							payloadDigest: commitInput.idempotencyPayloadDigest,
							scopedRecordId: commitInput.record?.scopedRecordId ?? commitInput.tombstone.tombstoneId,
							status: commitInput.operation === "deny" ? "denied" : "committed",
							entry: commitInput.outbox,
						},
					},
				});
				const checkedNext = validateState(next, host);
				await commitInput.crashHook?.("before-commit");
				await writeRaw(checkedNext);
				await commitInput.crashHook?.("after-commit");
				return { status: "committed" as const, state: checkedNext, entry: commitInput.outbox };
			}),
		pendingOutbox: async () =>
			Object.values(await storage.read().then((state) => state.outbox)).sort(
				(left, right) => left.revision - right.revision,
			),
		acknowledgeOutbox: (ackInput) =>
			withLock(async () => {
				const host: ScopedKnowledgeHostIdentity = { trustDomainId: input.trustDomainId, tenantId: null };
				const current = validateState(await readRaw(), host);
				const entry = current.outbox[ackInput.idempotencyKey];
				if (entry === undefined) return;
				if (entry.fenceDigest !== ackInput.expectedFenceDigest)
					throw new Error("Scoped knowledge outbox acknowledgement fence is stale.");
				const outbox = { ...current.outbox };
				delete outbox[ackInput.idempotencyKey];
				await writeRaw(
					finalizeState({
						version: current.version,
						trustDomainId: current.trustDomainId,
						sequence: current.sequence + 1,
						records: current.records,
						tombstones: current.tombstones,
						outbox,
						idempotency: current.idempotency,
					}),
				);
			}),
		recover: async () => {
			try {
				await storage.read();
				return { status: "healthy" as const, reason: null };
			} catch (error) {
				return {
					status: "quarantined" as const,
					reason: error instanceof Error ? error.message : "storage is quarantined",
				};
			}
		},
	};
	return storage;
}

function createRecord(
	input: ScopedKnowledgePromotionInput,
	target: ScopedKnowledgeTarget,
	now: string,
	transferEvidenceDigest: string,
	approvalDigest: string | null,
): ScopedKnowledgeRecord {
	const source = input.source;
	const scopedRecordId = scopedRecordIdFor(
		input.requestedScope as ScopedKnowledgePromotableScope,
		target,
		source.record.recordId,
		source.record.revision,
		source.record.contentDigest,
	);
	const contradictionKey = contradictionKeyFor(target, source.record.recordId);
	return freezeKnowledgeValue({
		scopedRecordId,
		scope: input.requestedScope as ScopedKnowledgePromotableScope,
		target,
		sourceRecord: clone(source.record),
		source: clone(source.binding),
		provenance: clone(source.record.provenance),
		transferEvidence: clone(input.transferEvidence),
		transferEvidenceDigest,
		policyRevision: input.policyRevision,
		approvalDigest,
		globalApproval: input.globalApproval === undefined ? null : clone(input.globalApproval),
		contradictionKey,
		status: "active" as const,
		revision: 1,
		contentDigest: source.record.contentDigest,
		sourceDigest: source.record.sourceDigest,
		createdAt: now,
		updatedAt: now,
		tombstone: null,
	});
}

function createOutboxEntry(
	record: ScopedKnowledgeRecord,
	sequence: number,
	idempotencyKey?: string,
): ScopedKnowledgeOutboxEntry {
	const operation = record.status === "retracted" ? "delete" : "upsert";
	const entry: Omit<ScopedKnowledgeOutboxEntry, "fenceDigest"> = {
		idempotencyKey:
			idempotencyKey ??
			digestObject({
				kind: "scoped-knowledge-outbox",
				recordId: record.scopedRecordId,
				revision: record.revision,
				operation,
			}),
		operation,
		scopedRecordId: record.scopedRecordId,
		revision: record.revision,
		recordDigest: operation === "upsert" ? digestObject(record) : null,
		sourceDigest: operation === "upsert" ? record.sourceDigest : null,
	};
	return freezeKnowledgeValue({ ...entry, fenceDigest: digestObject({ ...entry, sequence }) });
}

function neverTombstoneKey(source: KnowledgeRecord, host: ScopedKnowledgeHostBoundary): string {
	return digestObject({
		kind: "scoped-knowledge-never",
		trustDomainId: host.trustDomainId,
		sourceRecordId: source.recordId,
		sourceContentDigest: source.contentDigest,
	});
}

function accessAllows(
	record: ScopedKnowledgeRecord,
	authorization: ScopedKnowledgeRecallAuthorization,
	policyRevision: string,
): boolean {
	if (record.status !== "active" || record.policyRevision !== policyRevision) return false;
	if (record.target.trustDomainId !== authorization.trustDomainId || record.target.tenantId !== authorization.tenantId)
		return false;
	const allowed = authorization.allowedScopes ?? ["goal", "domain", "global"];
	if (!allowed.includes(record.scope)) return false;
	if (record.scope === "goal" && authorization.goalId !== record.target.goalId) return false;
	if (record.scope === "domain" && authorization.domainId !== record.target.domainId) return false;
	if (record.target.workspaceId !== null && authorization.workspaceId !== record.target.workspaceId) return false;
	if (record.target.userId !== null && authorization.userId !== record.target.userId) return false;
	return true;
}

function queryMatches(record: KnowledgeRecord, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (normalized.length === 0) return true;
	const haystack = `${record.title}\n${record.statement}`.toLowerCase();
	return normalized.split(/\s+/u).every((token) => haystack.includes(token));
}

function sortRecall(left: ScopedKnowledgeRecallRecord, right: ScopedKnowledgeRecallRecord): number {
	const ranks: Record<ScopedKnowledgeRecallRecord["scope"], number> = { workflow: 0, goal: 1, domain: 2, global: 3 };
	return (
		ranks[left.scope] - ranks[right.scope] ||
		left.contentDigest.localeCompare(right.contentDigest) ||
		left.recordId.localeCompare(right.recordId) ||
		left.revision - right.revision ||
		left.source.localeCompare(right.source) ||
		left.namespace.localeCompare(right.namespace)
	);
}

/**
 * Bind scoped knowledge promotion and recall to the authenticated host authority.
 *
 * Args:
 * input: Host receipt, artifact, admission, source, workflow, and durable-storage boundaries.
 * Return: Authority for atomic promotion, deterministic recall, revalidation, projection, and recovery.
 */
export function createScopedKnowledgeAuthority(
	input: ScopedKnowledgeAuthorityConstructionInput,
): ScopedKnowledgeAuthority {
	if (typeof input !== "object" || input === null || input.storage === null || input.host === null)
		throw new Error("Scoped knowledge authority input is required.");
	const host = input.host;
	if (typeof host !== "object" || host === null || typeof input.storage !== "object" || input.storage === null)
		throw new Error("Scoped knowledge authority host boundary is invalid.");
	assertIdentifier(host.trustDomainId, "scoped knowledge host trust domain");
	assertIdentifier(host.tenantId, "scoped knowledge host tenant");
	if (
		host.receiptContext === null ||
		typeof host.receiptContext !== "object" ||
		typeof host.receiptContext.receiptResolver?.resolve !== "function" ||
		typeof host.receiptContext.receiptResolver?.consumeIfOneUse !== "function" ||
		typeof host.receiptContext.receiptResolver?.resolveConsumptionWitness !== "function" ||
		typeof host.receiptContext.principalAuthorizer?.authorize !== "function" ||
		typeof host.receiptContext.artifactResolver?.resolve !== "function" ||
		typeof host.artifactResolver?.resolve !== "function"
	)
		throw new Error("Scoped knowledge authority requires the sealed host receipt and artifact boundaries.");
	assertSealedReceiptContext(host.receiptContext);
	for (const method of [
		"trustedNow",
		"currentPolicyRevision",
		"resolveTarget",
		"admitLearningScope",
		"resolveSource",
		"readWorkflowKnowledge",
		"authorizeRecall",
	] as const)
		if (typeof host[method] !== "function") throw new Error(`Scoped knowledge host boundary is missing ${method}.`);
	for (const method of ["read", "commit", "pendingOutbox", "acknowledgeOutbox", "recover"] as const)
		if (typeof input.storage[method] !== "function")
			throw new Error(`Scoped knowledge storage is missing ${method}.`);

	const read = async (): Promise<ScopedKnowledgeState> => validateState(await input.storage.read(), host);

	const reconcile = async (): Promise<void> => {
		let state = await read();
		for (const candidate of Object.values(state.records)) {
			if (candidate.status !== "active") continue;
			const resolution = await host.resolveSource({
				binding: candidate.source,
				expectedContentDigest: candidate.contentDigest,
			});
			let reason: ScopedKnowledgeTombstoneReason | null = null;
			if (resolution.status === "active") {
				try {
					if (resolution.record === null) throw new Error("active source omitted its canonical record");
					validateKnowledgeRecord(clone(resolution.record));
					if (!sameValue(resolution.record, candidate.sourceRecord))
						throw new Error("source changed without a canonical revision");
					for (const ref of candidate.source.sourceArtifactRefs)
						await resolveArtifact(host.artifactResolver, ref, "scoped source artifact");
					await verifyReceipt(
						host.receiptContext,
						host.artifactResolver,
						candidate.source.sourceReceipt,
						host.trustedNow(),
						"scoped source receipt",
					);
					await requireConsumedWitness(
						host.receiptContext,
						candidate.source.sourceReceipt,
						"scoped source receipt",
					);
					for (const evidence of candidate.transferEvidence) {
						const checkedEvidence = validateTransferEvidence(
							evidence,
							candidate.source.sourceWorkflowId,
							"scoped transfer evidence",
						);
						await verifyReceipt(
							host.receiptContext,
							host.artifactResolver,
							checkedEvidence.receipt,
							host.trustedNow(),
							"scoped transfer receipt",
						);
						await requireConsumedWitness(host.receiptContext, checkedEvidence.receipt, "scoped transfer receipt");
						for (const ref of checkedEvidence.artifactRefs)
							await resolveArtifact(host.artifactResolver, ref, "scoped transfer artifact");
					}
					if (candidate.globalApproval !== null) {
						if (host.verifyGlobalApproval === undefined) throw new Error("global approval verifier unavailable");
						assertVerifiedWitness(
							candidate.globalApproval.receipt,
							candidate.globalApproval.witness,
							candidate.source.sourceWorkflowId,
							"scoped global approval",
						);
						await verifyReceipt(
							host.receiptContext,
							host.artifactResolver,
							candidate.globalApproval.receipt,
							host.trustedNow(),
							"scoped global approval receipt",
						);
						await requireConsumedWitness(
							host.receiptContext,
							candidate.globalApproval.receipt,
							"scoped global approval receipt",
						);
						await host.verifyGlobalApproval({
							approval: candidate.globalApproval,
							source: { record: candidate.sourceRecord as KnowledgeRecord, binding: candidate.source },
							target: candidate.target,
							policyRevision: candidate.policyRevision,
						});
					}
				} catch (error) {
					if (!isDefinitiveSourceRevocationError(error)) throw error;
					reason =
						error instanceof Error && /\bquarantined\b/iu.test(error.message)
							? "source-quarantined"
							: error instanceof Error && /\bretracted\b/iu.test(error.message)
								? "source-retracted"
								: "source-revoked";
				}
			} else {
				reason =
					resolution.status === "retracted"
						? "source-retracted"
						: resolution.status === "revoked"
							? "source-revoked"
							: "source-quarantined";
			}
			if (reason === null) continue;
			const now = host.trustedNow();
			const tombstone = createTombstone({
				scope: candidate.scope,
				target: candidate.target,
				source: { record: candidate.sourceRecord as KnowledgeRecord, binding: candidate.source },
				policyRevision: candidate.policyRevision,
				reason,
				revision: candidate.revision + 1,
				now,
			});
			const retracted = createRetractedRecord(candidate, tombstone);
			const idempotencyKey = digestObject({
				kind: "scoped-knowledge-source-revocation",
				scopedRecordId: candidate.scopedRecordId,
				reason: tombstone.reason,
				sourceContentDigest: candidate.contentDigest,
			});
			const commit = await input.storage.commit({
				expectedDigest: state.digest,
				idempotencyKey,
				idempotencyPayloadDigest: digestObject({ idempotencyKey, tombstone }),
				operation: "retract",
				record: retracted,
				tombstone,
				outbox: createOutboxEntry(retracted, state.sequence + 1, idempotencyKey),
			});
			state = validateState(commit.state, host);
		}
	};

	const promote = async (promotion: ScopedKnowledgePromotionInput): Promise<ScopedKnowledgePromotionResult> => {
		if (!SCOPED_KNOWLEDGE_SCOPES.includes(promotion.requestedScope))
			throw new Error("Scoped knowledge promotion scope is invalid.");
		const currentPolicyRevision = host.currentPolicyRevision();
		assertIdentifier(currentPolicyRevision, "scoped knowledge current policy revision");
		if (promotion.policyRevision !== currentPolicyRevision)
			throw new Error("Scoped knowledge promotion policy revision is stale.");
		assertTarget(promotion.target, host);
		validateSourceBinding(promotion.source, host.trustedNow());
		assertNoRawTransferData(promotion.transferEvidence);
		if (promotion.transferEvidence.length > MAX_TRANSFER_EVIDENCE)
			throw new Error("Scoped knowledge transfer evidence is bounded.");
		const sourceResolution = await host.resolveSource({
			binding: promotion.source.binding,
			expectedContentDigest: promotion.source.record.contentDigest,
		});
		if (
			sourceResolution.status !== "active" ||
			sourceResolution.record === null ||
			!sameValue(sourceResolution.record, promotion.source.record)
		)
			throw new Error("Scoped knowledge promotion source is retracted, revoked, quarantined, or stale.");
		for (const ref of promotion.source.binding.sourceArtifactRefs)
			await resolveArtifact(host.artifactResolver, ref, "source evidence artifact");
		await verifyReceipt(
			host.receiptContext,
			host.artifactResolver,
			promotion.source.binding.sourceReceipt,
			host.trustedNow(),
			"source receipt",
		);
		await requireConsumedWitness(host.receiptContext, promotion.source.binding.sourceReceipt, "source receipt");
		const target = await host.resolveTarget({
			requestedScope: promotion.requestedScope,
			sourceWorkflowId: promotion.source.binding.sourceWorkflowId,
			requested: clone(promotion.target),
		});
		assertTarget(target, host);
		if (promotion.requestedScope !== "never" && target.scope !== promotion.requestedScope)
			throw new Error("Host canonical target scope does not match the requested scope.");
		const transferEvidenceDigest = digestObject(promotion.transferEvidence);
		const admissionInput: ScopedKnowledgeScopeAdmissionInput = {
			requestedScope: promotion.requestedScope,
			policyRevision: promotion.policyRevision,
			source: clone(promotion.source),
			target,
			transferEvidence: clone(promotion.transferEvidence),
		};
		const admission = await host.admitLearningScope(admissionInput);
		validateAdmission(admissionInput, admission, currentPolicyRevision, transferEvidenceDigest);
		if (promotion.requestedScope === "never") {
			const current = await read();
			const key = neverTombstoneKey(promotion.source.record, host);
			const existing = Object.values(current.tombstones).find(
				(candidate) =>
					candidate.reason === "never" &&
					candidate.tombstoneId === key &&
					candidate.trustDomainId === host.trustDomainId &&
					candidate.tenantId === host.tenantId,
			);
			if (existing !== undefined)
				return { status: "denied", record: null, tombstone: existing, authorization: null };
			const now = host.trustedNow();
			const tombstone = freezeKnowledgeValue({
				...createTombstone({
					scope: "never",
					target,
					source: promotion.source,
					policyRevision: promotion.policyRevision,
					reason: "never",
					revision: current.sequence + 1,
					now,
				}),
				tombstoneId: key,
			});
			const commit = await input.storage.commit({
				expectedDigest: current.digest,
				idempotencyKey: key,
				idempotencyPayloadDigest: digestObject({ key, tombstone }),
				operation: "deny",
				record: null,
				tombstone,
				outbox: {
					idempotencyKey: key,
					operation: "delete",
					scopedRecordId: key,
					revision: tombstone.revision,
					recordDigest: null,
					sourceDigest: null,
					fenceDigest: digestObject({ key, sequence: current.sequence + 1 }),
				},
			});
			return {
				status: commit.status === "replayed" ? "denied" : "denied",
				record: null,
				tombstone: commit.state.tombstones[tombstone.tombstoneId] ?? tombstone,
				authorization: null,
			};
		}
		if (promotion.transferEvidence.length === 0)
			throw new Error("Scoped knowledge promotion requires independently witnessed transfer evidence.");
		for (const evidence of promotion.transferEvidence) {
			const checkedEvidence = validateTransferEvidence(
				evidence,
				promotion.source.binding.sourceWorkflowId,
				"transfer evidence",
			);
			if (checkedEvidence.kind !== expectedTransferKind(promotion.requestedScope))
				throw new Error("Scoped knowledge transfer evidence kind does not match its promotion scope.");
			await verifyReceipt(
				host.receiptContext,
				host.artifactResolver,
				checkedEvidence.receipt,
				host.trustedNow(),
				"transfer evidence receipt",
			);
			await requireConsumedWitness(host.receiptContext, checkedEvidence.receipt, "transfer evidence receipt");
			for (const ref of checkedEvidence.artifactRefs)
				await resolveArtifact(host.artifactResolver, ref, "transfer evidence artifact");
		}
		let approvalDigest: string | null = null;
		if (promotion.requestedScope === "global") {
			const approval = promotion.globalApproval;
			if (approval === undefined || host.verifyGlobalApproval === undefined)
				throw new Error("Global scoped knowledge requires signed host/user approval.");
			if (approval.policyRevision !== promotion.policyRevision || approval.receipt.oneUse !== true)
				throw new Error("Global scoped knowledge approval is stale or not one-use.");
			assertDigest(approval.signedApprovalDigest, "global approval digest");
			if (approval.signedApprovalDigest !== scopedKnowledgeGlobalApprovalDigest(approval))
				throw new Error("Global scoped knowledge approval signature is not bound to its signed fields.");
			if (approval.receipt.workflowId !== promotion.source.binding.sourceWorkflowId)
				throw new Error("Global scoped knowledge approval crossed its source workflow.");
			assertVerifiedWitness(approval.receipt, approval.witness, approval.receipt.workflowId, "global approval");
			await verifyReceipt(
				host.receiptContext,
				host.artifactResolver,
				approval.receipt,
				host.trustedNow(),
				"global approval receipt",
			);
			await requireConsumedWitness(host.receiptContext, approval.receipt, "global approval receipt");
			await host.verifyGlobalApproval({
				approval,
				source: promotion.source,
				target,
				policyRevision: promotion.policyRevision,
			});
			approvalDigest = digestObject(approval);
		}
		const digests = scopedKnowledgePromotionAuthorizationDigests({
			scope: promotion.requestedScope,
			target,
			source: promotion.source.binding,
			sourceContentDigest: promotion.source.record.contentDigest,
			transferEvidenceDigest,
			policyRevision: promotion.policyRevision,
			approvalDigest,
			executionIdentity: admission.executionIdentity,
			sessionId: admission.sessionId,
		});
		const receipt = promotion.promotionReceipt;
		if (receipt === undefined) throw new Error("Scoped knowledge promotion requires a host capability receipt.");
		if (
			receipt.receiptKind !== "capability" ||
			receipt.oneUse !== true ||
			receipt.workflowId !== promotion.source.binding.sourceWorkflowId ||
			receipt.bindingDigest !== digests.bindingDigest ||
			receipt.capabilityBinding === undefined ||
			receipt.capabilityBinding.capability !== PROMOTION_CAPABILITY ||
			receipt.capabilityBinding.resourceDigest !== digests.resourceDigest ||
			receipt.capabilityBinding.operationDigest !== digests.operationDigest ||
			receipt.capabilityBinding.executionIdentity !== admission.executionIdentity ||
			receipt.capabilityBinding.sessionId !== admission.sessionId
		)
			throw new Error(
				"Scoped knowledge promotion receipt is not bound to the host scope, source, and policy tuple.",
			);
		const verifiedReceipt = await verifyReceipt(
			host.receiptContext,
			host.artifactResolver,
			receipt,
			host.trustedNow(),
			"promotion receipt",
		);
		const authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput = {
			receipt: verifiedReceipt,
			workflowId: promotion.source.binding.sourceWorkflowId,
			bindingDigest: digests.bindingDigest,
			resourceDigest: digests.resourceDigest,
			operationDigest: digests.operationDigest,
			stateDigest: verifiedReceipt.stateDigest,
			revision: verifiedReceipt.revision,
			epochRef: promotion.source.binding.sourceEpochRef,
			capability: PROMOTION_CAPABILITY,
			executionIdentity: admission.executionIdentity,
			sessionId: admission.sessionId,
		};
		const authorization = await host.receiptContext.principalAuthorizer.authorize(authorizationInput);
		validatePrincipalAuthorization(authorization, authorizationInput);
		const current = await read();
		const denyKey = neverTombstoneKey(promotion.source.record, host);
		const deny = Object.values(current.tombstones).find(
			(candidate) => candidate.reason === "never" && candidate.tombstoneId === denyKey,
		);
		if (deny !== undefined) return { status: "denied", record: null, tombstone: deny, authorization };
		const record = createRecord(promotion, target, host.trustedNow(), transferEvidenceDigest, approvalDigest);
		const idempotencyKey = digestObject({
			kind: "scoped-knowledge-promotion",
			recordId: record.scopedRecordId,
			transferEvidenceDigest,
			policyRevision: promotion.policyRevision,
			approvalDigest,
		});
		const commit = await input.storage.commit({
			expectedDigest: current.digest,
			idempotencyKey,
			idempotencyPayloadDigest: digestObject({ idempotencyKey, record }),
			operation: "promote",
			record,
			tombstone: createTombstone({
				scope: promotion.requestedScope,
				target,
				source: promotion.source,
				policyRevision: promotion.policyRevision,
				reason: "source-retracted",
				revision: record.revision,
				now: record.createdAt,
			}),
			outbox: createOutboxEntry(record, current.sequence + 1, idempotencyKey),
			crashHook: promotion.crashHook,
		});
		await consumeReceipt(host.receiptContext, verifiedReceipt, "promotion receipt");
		if (promotion.globalApproval !== undefined)
			await consumeReceipt(host.receiptContext, promotion.globalApproval.receipt, "global approval receipt");
		const committed = commit.state.records[record.scopedRecordId] ?? record;
		return { status: commit.status, record: committed, tombstone: null, authorization };
	};

	const recall = async (recallInput: ScopedKnowledgeRecallInput): Promise<readonly ScopedKnowledgeRecallRecord[]> => {
		assertIdentifier(recallInput.workflowId, "scoped knowledge recall workflow");
		assertString(recallInput.query, "scoped knowledge recall query", MAX_QUERY_BYTES);
		if (!SCOPED_KNOWLEDGE_SCOPES.includes(recallInput.requestedScope))
			throw new Error("Scoped knowledge recall scope is invalid.");
		const currentPolicyRevision = host.currentPolicyRevision();
		assertIdentifier(currentPolicyRevision, "scoped knowledge current policy revision");
		if (recallInput.policyRevision !== currentPolicyRevision)
			throw new Error("Scoped knowledge recall policy revision is stale.");
		assertTarget(recallInput.target, host);
		if (recallInput.target.scope !== recallInput.requestedScope)
			throw new Error("Scoped knowledge recall target scope does not match the requested scope.");
		const authorization = await host.authorizeRecall({
			workflowId: recallInput.workflowId,
			requestedScope: recallInput.requestedScope,
			requested: clone(recallInput.target),
			policyRevision: recallInput.policyRevision,
		});
		if (
			authorization.workflowId !== recallInput.workflowId ||
			authorization.trustDomainId !== host.trustDomainId ||
			authorization.tenantId !== host.tenantId ||
			authorization.goalId !== recallInput.target.goalId ||
			authorization.domainId !== recallInput.target.domainId ||
			authorization.workspaceId !== recallInput.target.workspaceId ||
			authorization.userId !== recallInput.target.userId ||
			authorization.policyRevision !== recallInput.policyRevision ||
			!SHA256.test(authorization.authorizationDigest)
		)
			throw new Error("Scoped knowledge recall authorization is foreign or stale.");
		await reconcile();
		const state = await read();
		const recalls: ScopedKnowledgeRecallRecord[] = [];
		const appendRecall = (view: ScopedKnowledgeRecallRecord | null): void => {
			if (view === null) return;
			if (recalls.length >= MAX_RECALL_RECORDS)
				throw new Error("Scoped knowledge recall exceeded its bounded result size.");
			recalls.push(view);
		};
		for (const candidate of Object.values(state.records)) {
			if (
				!accessAllows(candidate, authorization, recallInput.policyRevision) ||
				candidate.sourceRecord === null ||
				!queryMatches(candidate.sourceRecord, recallInput.query)
			)
				continue;
			const view = createRecallRecord(
				"scoped",
				candidate.scope,
				candidate.target.namespace,
				candidate.sourceRecord,
				{
					contradictionKey: candidate.contradictionKey,
					status: candidate.status === "superseded" ? "superseded" : "active",
					revision: candidate.revision,
				},
			);
			appendRecall(view);
		}
		const currentWorkflowRecords = await host.readWorkflowKnowledge({ workflowId: recallInput.workflowId });
		if (currentWorkflowRecords.length > MAX_RECALL_RECORDS)
			throw new Error("Scoped workflow knowledge recall exceeded its bounded result size.");
		for (const record of currentWorkflowRecords) {
			const validated = validateKnowledgeRecord(clone(record));
			if (validated.status !== "active" || !queryMatches(validated, recallInput.query)) continue;
			const view = createRecallRecord("workflow", "workflow", validated.applicability.namespace, validated, {
				contradictionKey: digestObject({
					kind: "workflow-knowledge-contradiction",
					recordId: validated.recordId,
					contentDigest: validated.contentDigest,
				}),
				status: "active",
				revision: validated.revision,
			});
			appendRecall(view);
		}
		return freezeKnowledgeValue(recalls.sort(sortRecall));
	};

	const drainOutbox = async (projection?: ScopedKnowledgeProjection): Promise<ScopedKnowledgeOutboxDrainResult> => {
		if (projection === undefined)
			return {
				status: "disabled",
				pending: (await input.storage.pendingOutbox()).length,
				projected: 0,
				reason: null,
			};
		await reconcile();
		let pending = [...(await input.storage.pendingOutbox())];
		let projected = 0;
		for (const entry of pending) {
			try {
				const state = await read();
				if (entry.operation === "upsert") {
					const record = state.records[entry.scopedRecordId];
					if (record === undefined || record.status !== "active" || record.sourceRecord === null) {
						await projection.delete(entry.scopedRecordId);
					} else {
						const view = createRecallRecord(
							"scoped",
							record.scope,
							record.target.namespace,
							record.sourceRecord,
							{
								contradictionKey: record.contradictionKey,
								status: "active",
								revision: record.revision,
							},
						);
						if (view === null) await projection.delete(entry.scopedRecordId);
						else await projection.upsert(view);
					}
				} else await projection.delete(entry.scopedRecordId);
				await input.storage.acknowledgeOutbox({
					idempotencyKey: entry.idempotencyKey,
					expectedFenceDigest: entry.fenceDigest,
				});
				projected += 1;
			} catch (error) {
				pending = [...(await input.storage.pendingOutbox())];
				return {
					status: "degraded",
					pending: pending.length,
					projected,
					reason: error instanceof Error ? error.message : "scoped knowledge projection failed",
				};
			}
			pending = [...(await input.storage.pendingOutbox())];
		}
		return { status: "healthy", pending: pending.length, projected, reason: null };
	};

	return Object.freeze({
		promote,
		recall,
		read,
		revalidate: reconcile,
		drainOutbox,
		recover: input.storage.recover,
	});
}
