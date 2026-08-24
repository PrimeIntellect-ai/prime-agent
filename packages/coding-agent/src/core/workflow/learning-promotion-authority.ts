import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowJournalHead,
	type WorkflowLearningPromotionDurableContext,
	type WorkflowRuntimeStoreDurableContext,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";

export const WORKFLOW_LEARNING_PROMOTION_RECEIPT_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_LEARNING_PROMOTION_RECEIPT_RECORD = "workflow-learning-promotion-receipts.v1" as const;
export const WORKFLOW_LEARNING_REFINEMENT_RECORD = "workflow-learning-refinement.v1" as const;
const PROMOTION_RECEIPT_TTL_MILLISECONDS = 300_000;
const MAX_STRING_BYTES = 4096;
const MAX_ARTIFACT_REFS = 64;
const MAX_REFINEMENT_BYTES = 256 * 1024;

export type WorkflowLearningPromotionStage = "shadow" | "canary" | "red_team";

export interface WorkflowLearningPromotionGoalRevision {
	readonly revision: number;
	readonly digest: string;
}

export interface WorkflowLearningPromotionAcceptedStage {
	readonly stage: WorkflowLearningPromotionStage;
	readonly resultRef: WorkflowArtifactRef;
	readonly resultDigest: string;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly evidenceDigest: string;
	readonly accepted: true;
	readonly hostAuthenticated: true;
	readonly sessionId: string;
	readonly executionIdentity: string;
}

export interface WorkflowLearningPromotionIndependentConfirmation {
	readonly resultRef: WorkflowArtifactRef;
	readonly resultDigest: string;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly evidenceDigest: string;
	readonly provenanceRef: WorkflowArtifactRef;
	readonly provenanceReceiptId: string;
	readonly provenanceDigest: string;
	readonly independent: true;
	readonly hostAuthenticated: true;
	readonly sessionId: string;
	readonly executionIdentity: string;
	readonly confirmedAt: string;
}

/** Host-owned source tuple from which a refinement capability may be minted. */
export interface WorkflowLearningPromotionAuthoritySource {
	readonly schemaVersion: typeof WORKFLOW_LEARNING_PROMOTION_RECEIPT_SCHEMA_VERSION;
	readonly workflowId: string;
	readonly status: "active";
	readonly generationId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly trustedNow: string;
	readonly stateDigest: string;
	readonly currentRevision: number;
	readonly goalRevision: WorkflowLearningPromotionGoalRevision;
	readonly inputDigest: string;
	readonly graphDigest: string;
	readonly acceptedHead: WorkflowJournalHead;
	readonly candidateId: string;
	readonly promotionId: string;
	readonly revisionId: string;
	readonly policyDigest: string;
	readonly proposalDigest: string;
	readonly proposalRef: WorkflowArtifactRef;
	readonly transferDigest: string;
	readonly acceptedStage: WorkflowLearningPromotionAcceptedStage;
	readonly independentConfirmation: WorkflowLearningPromotionIndependentConfirmation;
}

export interface WorkflowLearningPromotionReceipt extends WorkflowLearningPromotionAuthoritySource {
	readonly receiptKind: "learning_promotion";
	readonly receiptId: string;
	readonly nonce: string;
	readonly rollbackToken: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly payloadDigest: string;
	readonly bindingDigest: string;
	readonly hostReceipt: WorkflowVerifiedHostReceipt;
	readonly receiptDigest: string;
}

export interface WorkflowLearningPromotionReceiptConsumption {
	readonly receiptId: string;
	readonly workflowId: string;
	readonly candidateId: string;
	readonly proposalDigest: string;
	readonly transferDigest: string;
	readonly acceptedHead: WorkflowJournalHead;
	readonly rollbackToken: string;
	readonly receipt: WorkflowLearningPromotionReceipt;
}

export type WorkflowLearningPromotionRefinementKind = "prompt" | "memory" | "skill" | "subagent";

/** Untrusted, closed refinement edit accepted by the host apply boundary. */
export interface WorkflowLearningPromotionRefinementInput {
	readonly schemaVersion: 1;
	readonly action: "create" | "update" | "delete";
	readonly kind: WorkflowLearningPromotionRefinementKind;
	readonly id: string;
	readonly title?: string;
	readonly content?: string;
	readonly path?: string;
	readonly reference?: Readonly<Record<string, unknown>>;
	readonly arguments?: Readonly<Record<string, unknown>>;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly reason?: string;
	readonly how?: string;
	readonly why?: string;
}

/** Host-authenticated canonical refinement bytes produced by consumeAndApply. */
export interface WorkflowLearningPromotionCanonicalRefinementRecord {
	readonly schemaVersion: 1;
	readonly recordKind: "workflow_learning_refinement";
	readonly applicationId: string;
	readonly workflowId: string;
	readonly generationId: string;
	readonly receiptId: string;
	readonly receiptDigest: string;
	readonly action: WorkflowLearningPromotionRefinementInput["action"];
	readonly kind: WorkflowLearningPromotionRefinementKind;
	readonly id: string;
	readonly title?: string;
	readonly content?: string;
	readonly path?: string;
	readonly reference?: Readonly<Record<string, unknown>>;
	readonly arguments?: Readonly<Record<string, unknown>>;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly reason?: string;
	readonly how: string;
	readonly why: string;
	readonly goalRevision: WorkflowLearningPromotionGoalRevision;
	readonly inputDigest: string;
	readonly graphDigest: string;
	readonly acceptedHead: WorkflowJournalHead;
	readonly candidateId: string;
	readonly promotionId: string;
	readonly revisionId: string;
	readonly policyDigest: string;
	readonly proposalDigest: string;
	readonly proposalRef: WorkflowArtifactRef;
	readonly transferDigest: string;
	readonly acceptedStage: WorkflowLearningPromotionAcceptedStage;
	readonly independentConfirmation: WorkflowLearningPromotionIndependentConfirmation;
	readonly rollbackToken: string;
}

export interface WorkflowLearningPromotionConsumeAndApplyInput extends WorkflowLearningPromotionReceiptConsumeInput {
	readonly refinement: WorkflowLearningPromotionRefinementInput;
	/** Optional CAS guard for the host-owned canonical refinement bytes. */
	readonly expectedPreviousBytesDigest?: string | null;
}

export interface WorkflowLearningPromotionApplication {
	readonly applicationId: string;
	readonly workflowId: string;
	readonly receiptId: string;
	readonly record: WorkflowLearningPromotionCanonicalRefinementRecord;
	readonly previousBytesDigest: string | null;
	readonly appliedBytesDigest: string;
	readonly rollbackToken: string;
	readonly receipt: WorkflowLearningPromotionReceipt;
}

export interface WorkflowLearningPromotionRollbackInput {
	readonly workflowId: string;
	readonly receiptId: string;
	readonly rollbackToken: string;
	readonly expectedAppliedBytesDigest: string;
}

export interface WorkflowLearningPromotionRollbackResult {
	readonly status: "rolled_back";
	readonly applicationId: string;
	readonly receiptId: string;
	readonly restoredBytesDigest: string | null;
	readonly rollbackToken: string;
}

export interface WorkflowLearningPromotionReceiptIssueInput {
	readonly candidateId: string;
	readonly proposalDigest: string;
	readonly inputDigest: string;
	readonly graphDigest: string;
	readonly goalRevisionDigest: string;
}

export interface WorkflowLearningPromotionReceiptConsumeInput {
	readonly receipt: WorkflowLearningPromotionReceipt;
	readonly proposalDigest: string;
	readonly inputDigest: string;
	readonly graphDigest: string;
	readonly goalRevisionDigest: string;
}

export type WorkflowLearningPromotionHostReceiptIssuer = (input: {
	readonly receiptKind: WorkflowVerifiedHostReceipt["receiptKind"];
	readonly workflowId: string;
	readonly bindingDigest: string;
	readonly payloadDigest: string;
	readonly receiptId: string;
	readonly oneUse: true;
	readonly issuedAt: string;
	readonly stateDigest: string;
	readonly revision: number;
	readonly payloadKind: "workflow-learning";
}) => Promise<WorkflowVerifiedHostReceipt>;

export interface WorkflowLearningPromotionReceiptAuthorityInput {
	readonly workflowId: string;
	readonly durableContext: WorkflowLearningPromotionDurableContext;
	readonly artifactResolver: WorkflowHostReceiptConsumerContext["artifactResolver"];
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly issueReceipt: WorkflowLearningPromotionHostReceiptIssuer;
	readonly now: () => string;
	/** Reads the host-authenticated active promotion and stage evidence. */
	readonly readCurrent: () => Promise<WorkflowLearningPromotionAuthoritySource | null>;
}

export function requireWorkflowLearningPromotionDurableContext(
	durableContext: WorkflowRuntimeStoreDurableContext,
): WorkflowLearningPromotionDurableContext {
	const auxiliaryStore = durableContext.auxiliaryStore as unknown as Record<string, unknown>;
	if (typeof auxiliaryStore.remove !== "function")
		throw new Error("Workflow learning promotion requires the authenticated auxiliary-store delete capability.");
	return durableContext as WorkflowLearningPromotionDurableContext;
}

/** Opaque host capability exposed to refinement; it carries no receipt keys or store handles. */
export interface WorkflowLearningPromotionReceiptCapability {
	issue(input: WorkflowLearningPromotionReceiptIssueInput): Promise<WorkflowLearningPromotionReceipt>;
	consume(input: WorkflowLearningPromotionReceiptConsumeInput): Promise<WorkflowLearningPromotionReceiptConsumption>;
	consumeAndApply(input: WorkflowLearningPromotionConsumeAndApplyInput): Promise<WorkflowLearningPromotionApplication>;
	rollback(input: WorkflowLearningPromotionRollbackInput): Promise<WorkflowLearningPromotionRollbackResult>;
}

export type WorkflowLearningPromotionReceiptAuthority = WorkflowLearningPromotionReceiptCapability;

export type WorkflowLearningPromotionTransferInput = {
	readonly workflowId: string;
	readonly candidateId: string;
	readonly proposalDigest: string;
	readonly proposalRef: WorkflowArtifactRef;
	readonly proposal: unknown;
};

interface WorkflowLearningPromotionReceiptRecord {
	readonly schemaVersion: typeof WORKFLOW_LEARNING_PROMOTION_RECEIPT_SCHEMA_VERSION;
	readonly workflowId: string;
	readonly generationId: string;
	readonly receipts: Readonly<Record<string, WorkflowLearningPromotionReceipt>>;
	readonly consumptions: Readonly<Record<string, { receiptDigest: string; consumedAt: string }>>;
	readonly consumedPromotions: Readonly<
		Record<string, { receiptId: string; receiptDigest: string; consumedAt: string }>
	>;
	readonly applications: Readonly<Record<string, WorkflowLearningPromotionApplicationJournal>>;
}

interface WorkflowLearningPromotionApplicationJournal {
	readonly applicationId: string;
	readonly receiptId: string;
	readonly receiptDigest: string;
	readonly sourceBindingDigest: string;
	readonly refinementDigest: string;
	readonly previousBytes: readonly number[] | null;
	readonly previousBytesDigest: string | null;
	readonly appliedBytesDigest: string;
	readonly record: WorkflowLearningPromotionCanonicalRefinementRecord;
	readonly state: "prepared" | "applied" | "rollback_prepared" | "rolled_back";
	readonly rollbackToken: string;
	readonly rolledBackAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string, maxBytes = MAX_STRING_BYTES): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0 || new TextEncoder().encode(value).byteLength > maxBytes)
		throw new Error(`${label} is invalid.`);
}

function assertClosedKeys(
	value: unknown,
	keys: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be a plain record.`);
	const allowed = new Set(keys);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key) || !allowed.has(key))
			throw new Error(`${label} contains an unknown or non-enumerable field.`);
	}
}

const REFINEMENT_INPUT_KEYS = Object.freeze([
	"schemaVersion",
	"action",
	"kind",
	"id",
	"title",
	"content",
	"path",
	"reference",
	"arguments",
	"metadata",
	"reason",
	"how",
	"why",
] as const);
const REFINEMENT_PROTECTED_KEY =
	/(?:thread|chronology|conversation|transcript|history|turn|message|outcome|status|result|protected)/iu;
const REFINEMENT_PATH_KEY = /(?:path|uri|file|directory|root|cwd)/iu;

function isAbsoluteRefinementPath(value: string): boolean {
	return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("~/");
}

function assertSafeRefinementValue(value: unknown, label: string, seen = new WeakSet<object>(), depth = 0): void {
	if (depth > 16) throw new Error(`${label} exceeds the bounded refinement depth.`);
	if (typeof value === "string") {
		if (new TextEncoder().encode(value).byteLength > MAX_REFINEMENT_BYTES)
			throw new Error(`${label} exceeds the bounded refinement size.`);
		return;
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") return;
	if (typeof value === "function" || value instanceof Uint8Array || value instanceof ArrayBuffer)
		throw new Error(`${label} contains unsupported refinement data.`);
	if (Array.isArray(value)) {
		if (value.length > 256) throw new Error(`${label} exceeds the bounded refinement array length.`);
		if (seen.has(value)) throw new Error(`${label} contains a cycle.`);
		seen.add(value);
		for (const [index, child] of value.entries())
			assertSafeRefinementValue(child, `${label}[${index}]`, seen, depth + 1);
		return;
	}
	if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype)
		throw new Error(`${label} is not canonical.`);
	if (seen.has(value)) throw new Error(`${label} contains a cycle.`);
	seen.add(value);
	for (const [key, child] of Object.entries(value)) {
		const normalizedKey = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
		if (REFINEMENT_PROTECTED_KEY.test(normalizedKey))
			throw new Error(`${label}.${key} contains protected workflow outcome or chronology data.`);
		if (typeof child === "string" && REFINEMENT_PATH_KEY.test(normalizedKey) && isAbsoluteRefinementPath(child))
			throw new Error(`${label}.${key} contains an absolute path.`);
		assertSafeRefinementValue(child, `${label}.${key}`, seen, depth + 1);
	}
}

function assertRelativeRefinementPath(value: string, label: string): void {
	if (isAbsoluteRefinementPath(value) || value.includes("\\")) throw new Error(`${label} must be relative.`);
	if (value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === ".."))
		throw new Error(`${label} must be normalized.`);
}

function assertRefinementInput(value: WorkflowLearningPromotionRefinementInput): void {
	assertClosedKeys(value, REFINEMENT_INPUT_KEYS, "Learning refinement input");
	if (value.schemaVersion !== 1) throw new Error("Learning refinement input schema is invalid.");
	if (!(value.action === "create" || value.action === "update" || value.action === "delete"))
		throw new Error("Learning refinement action is invalid.");
	if (!(value.kind === "prompt" || value.kind === "memory" || value.kind === "skill" || value.kind === "subagent"))
		throw new Error("Learning refinement kind is invalid.");
	assertString(value.id, "Learning refinement id", 256);
	if (value.id.includes("/") || value.id.includes("\\")) throw new Error("Learning refinement id is not canonical.");
	if (value.action === "delete") {
		assertString(value.reason, "Learning refinement delete reason", 2048);
	} else {
		assertString(value.title, "Learning refinement title", 2048);
		assertString(value.content, "Learning refinement content", MAX_REFINEMENT_BYTES);
	}
	if (value.path !== undefined) {
		assertString(value.path, "Learning refinement path", 1024);
		assertRelativeRefinementPath(value.path, "Learning refinement path");
	}
	for (const [label, nested] of [
		["reference", value.reference],
		["arguments", value.arguments],
		["metadata", value.metadata],
	] as const) {
		if (nested !== undefined) assertSafeRefinementValue(nested, `Learning refinement ${label}`);
	}
	if (value.reason !== undefined) assertString(value.reason, "Learning refinement reason", 2048);
	if (value.how !== undefined) assertString(value.how, "Learning refinement how", 2048);
	if (value.why !== undefined) assertString(value.why, "Learning refinement why", 2048);
	assertSafeRefinementValue(value, "Learning refinement input");
}

function assertDigest(value: unknown, label: string): asserts value is string {
	assertString(value, label, 128);
	if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} is not a canonical digest.`);
}

function assertEpoch(value: unknown, label: string): asserts value is WorkflowEpochRef {
	if (
		!isRecord(value) ||
		!Number.isSafeInteger(value.storeEpoch) ||
		(value.storeEpoch as number) < 1 ||
		!Number.isSafeInteger(value.coordinatorEpoch) ||
		(value.coordinatorEpoch as number) < 1
	)
		throw new Error(`${label} is invalid.`);
}

function assertArtifactRef(value: unknown, label: string): asserts value is WorkflowArtifactRef {
	if (
		!isRecord(value) ||
		typeof value.artifactId !== "string" ||
		typeof value.relativePath !== "string" ||
		typeof value.digest !== "string" ||
		!Number.isSafeInteger(value.sizeBytes) ||
		(value.sizeBytes as number) < 0 ||
		!Number.isSafeInteger(value.sourceEventSequence) ||
		(value.sourceEventSequence as number) < 0
	)
		throw new Error(`${label} is invalid.`);
	assertString(value.artifactId, `${label} id`);
	assertString(value.relativePath, `${label} path`, 1024);
	assertDigest(value.digest, `${label} digest`);
	if (
		value.relativePath.startsWith("/") ||
		value.relativePath.includes("\\") ||
		value.relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
	)
		throw new Error(`${label} path is not canonical.`);
}

function assertArtifactRefs(value: unknown, label: string): asserts value is readonly WorkflowArtifactRef[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARTIFACT_REFS)
		throw new Error(`${label} must be bounded and non-empty.`);
	for (const [index, ref] of value.entries()) assertArtifactRef(ref, `${label}[${index}]`);
	if (new Set(value.map((ref) => digestObject(ref))).size !== value.length)
		throw new Error(`${label} contains duplicate references.`);
}

function assertHead(value: unknown, workflowId: string, label: string): asserts value is WorkflowJournalHead {
	if (
		!isRecord(value) ||
		value.workflowId !== workflowId ||
		!Number.isSafeInteger(value.sequence) ||
		(value.sequence as number) < 1 ||
		(value.eventDigest !== null && typeof value.eventDigest !== "string")
	)
		throw new Error(`${label} is invalid.`);
	if (value.eventDigest !== null) assertDigest(value.eventDigest, `${label} digest`);
	assertEpoch(value.epochRef, `${label} epoch`);
}

function assertFreshTimestamp(value: unknown, label: string): void {
	assertString(value, label, 64);
	if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is not a timestamp.`);
}

function transferableProposalPayload(input: WorkflowLearningPromotionTransferInput): Record<string, unknown> {
	if (!isRecord(input.proposal)) throw new Error("Learning proposal is not a transferable record.");
	if (input.proposal.workflowId !== input.workflowId || input.proposal.candidateId !== input.candidateId)
		throw new Error("Learning proposal is not bound to the accepted workflow and candidate.");
	const how = typeof input.proposal.how === "string" ? input.proposal.how : input.proposal.solutionFamily;
	const why = typeof input.proposal.why === "string" ? input.proposal.why : input.proposal.sourceEvidenceDigest;
	assertString(how, "Learning proposal how", 2048);
	assertString(why, "Learning proposal why", 2048);
	if (input.proposal.sourceEvidenceDigest !== undefined)
		assertDigest(input.proposal.sourceEvidenceDigest, "Learning proposal source evidence digest");
	if (
		!Array.isArray(input.proposal.candidateStageIds) ||
		input.proposal.candidateStageIds.length === 0 ||
		input.proposal.candidateStageIds.length > MAX_ARTIFACT_REFS ||
		!input.proposal.candidateStageIds.every((stageId): stageId is string => typeof stageId === "string")
	)
		throw new Error("Learning proposal transferable stages are invalid.");
	for (const stageId of input.proposal.candidateStageIds) assertString(stageId, "Learning proposal stage");
	return {
		schemaVersion: 1,
		candidateId: input.candidateId,
		proposalDigest: input.proposalDigest,
		proposalRef: input.proposalRef,
		how,
		why,
		candidateStageIds: [...input.proposal.candidateStageIds],
	};
}

/**
 * Derive the digest for the semantically validated how/why transfer payload.
 * Args:
 * input: Host-provided workflow, candidate, proposal reference, and canonical proposal value.
 * Return: Canonical digest bound to the transferable proposal fields.
 */
export function digestWorkflowLearningPromotionTransfer(input: WorkflowLearningPromotionTransferInput): string {
	assertString(input.workflowId, "Learning transfer workflow id");
	assertString(input.candidateId, "Learning transfer candidate id");
	assertDigest(input.proposalDigest, "Learning transfer proposal digest");
	assertArtifactRef(input.proposalRef, "Learning transfer proposal");
	if (input.proposalDigest !== input.proposalRef.digest)
		throw new Error("Learning transfer proposal digest is not bound to its artifact.");
	return digestObject(transferableProposalPayload(input));
}

function confirmationProvenanceDigest(confirmation: WorkflowLearningPromotionIndependentConfirmation): string {
	return digestObject({
		kind: "workflow_learning_independent_confirmation_provenance",
		resultRef: confirmation.resultRef,
		evidenceRefs: confirmation.evidenceRefs,
		provenanceRef: confirmation.provenanceRef,
		provenanceReceiptId: confirmation.provenanceReceiptId,
		confirmedAt: confirmation.confirmedAt,
	});
}

function assertSource(source: WorkflowLearningPromotionAuthoritySource, workflowId: string): void {
	if (!isRecord(source) || source.schemaVersion !== WORKFLOW_LEARNING_PROMOTION_RECEIPT_SCHEMA_VERSION)
		throw new Error("Learning promotion authority source schema is invalid.");
	if (source.workflowId !== workflowId || source.status !== "active")
		throw new Error("Learning promotion authority is not active for this workflow.");
	assertString(source.generationId, "Learning promotion generation");
	assertEpoch(source.epochRef, "Learning promotion epoch");
	assertFreshTimestamp(source.trustedNow, "Learning promotion trusted time");
	assertDigest(source.stateDigest, "Learning promotion state digest");
	if (!Number.isSafeInteger(source.currentRevision) || source.currentRevision < 1)
		throw new Error("Learning promotion current revision is invalid.");
	if (source.acceptedHead.eventDigest === null || source.acceptedHead.sequence !== source.currentRevision)
		throw new Error("Learning promotion accepted head is incomplete.");
	assertHead(source.acceptedHead, workflowId, "Learning promotion accepted head");
	if (source.acceptedHead.eventDigest !== source.stateDigest)
		throw new Error("Learning promotion state digest is not the accepted head digest.");
	if (digestObject(source.acceptedHead.epochRef) !== digestObject(source.epochRef))
		throw new Error("Learning promotion accepted head epoch is stale.");
	if (
		!isRecord(source.goalRevision) ||
		!Number.isSafeInteger(source.goalRevision.revision) ||
		(source.goalRevision.revision as number) < 1
	)
		throw new Error("Learning promotion goal revision is invalid.");
	assertDigest(source.goalRevision.digest, "Learning promotion goal revision digest");
	assertDigest(source.inputDigest, "Learning promotion input digest");
	assertDigest(source.graphDigest, "Learning promotion graph digest");
	for (const [label, value] of [
		["candidate", source.candidateId],
		["promotion", source.promotionId],
		["revision", source.revisionId],
	] as const)
		assertString(value, `Learning promotion ${label}`);
	assertDigest(source.policyDigest, "Learning promotion policy digest");
	assertDigest(source.proposalDigest, "Learning promotion proposal digest");
	assertArtifactRef(source.proposalRef, "Learning promotion proposal");
	if (source.proposalDigest !== source.proposalRef.digest)
		throw new Error("Learning promotion proposal digest is not bound to its immutable artifact.");
	assertDigest(source.transferDigest, "Learning promotion transfer digest");
	assertStage(source.acceptedStage, source.candidateId, "accepted stage");
	assertConfirmation(source.independentConfirmation, source.acceptedStage, "independent confirmation");
	if (Date.parse(source.independentConfirmation.confirmedAt) > Date.parse(source.trustedNow))
		throw new Error("Learning promotion independent confirmation is from the future.");
}

function assertCurrentAuthority(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	source: WorkflowLearningPromotionAuthoritySource,
): void {
	if (
		input.durableContext.generationId !== source.generationId ||
		digestObject(input.durableContext.epochRef) !== digestObject(source.epochRef)
	)
		throw new Error("Learning promotion authority generation or epoch is stale.");
	const trustedNow = input.now();
	assertFreshTimestamp(trustedNow, "Learning promotion current time");
	if (Date.parse(source.trustedNow) > Date.parse(trustedNow))
		throw new Error("Learning promotion source trusted time is from the future.");
	const lease = input.durableContext.currentLeaseRef();
	if (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= Date.parse(trustedNow))
		throw new Error("Learning promotion authority lease is not active.");
}

function assertStage(stage: WorkflowLearningPromotionAcceptedStage, candidateId: string, label: string): void {
	if (!isRecord(stage) || !(["shadow", "canary", "red_team"] as const).includes(stage.stage))
		throw new Error(`Learning promotion ${label} is invalid.`);
	if (stage.accepted !== true || stage.hostAuthenticated !== true)
		throw new Error(`Learning promotion ${label} is not host-accepted.`);
	assertArtifactRef(stage.resultRef, `${label} result`);
	if (stage.resultDigest !== stage.resultRef.digest) throw new Error(`Learning promotion ${label} result is unbound.`);
	assertArtifactRefs(stage.evidenceRefs, `${label} evidence`);
	if (stage.evidenceDigest !== digestObject(stage.evidenceRefs))
		throw new Error(`Learning promotion ${label} evidence digest is invalid.`);
	assertString(stage.sessionId, `${label} session`);
	assertString(stage.executionIdentity, `${label} execution`);
	assertString(candidateId, "Learning promotion candidate");
}

function assertConfirmation(
	confirmation: WorkflowLearningPromotionIndependentConfirmation,
	acceptedStage: WorkflowLearningPromotionAcceptedStage,
	label: string,
): void {
	if (!isRecord(confirmation) || confirmation.independent !== true || confirmation.hostAuthenticated !== true)
		throw new Error(`Learning promotion ${label} is not fresh and independent.`);
	assertArtifactRef(confirmation.resultRef, `${label} result`);
	if (confirmation.resultDigest !== confirmation.resultRef.digest)
		throw new Error(`Learning promotion ${label} result is unbound.`);
	assertArtifactRefs(confirmation.evidenceRefs, `${label} evidence`);
	if (confirmation.evidenceDigest !== digestObject(confirmation.evidenceRefs))
		throw new Error(`Learning promotion ${label} evidence digest is invalid.`);
	assertArtifactRef(confirmation.provenanceRef, `${label} provenance`);
	assertString(confirmation.provenanceReceiptId, `${label} provenance receipt`);
	assertDigest(confirmation.provenanceDigest, `${label} provenance digest`);
	assertString(confirmation.sessionId, `${label} session`);
	assertString(confirmation.executionIdentity, `${label} execution`);
	if (
		confirmation.sessionId === acceptedStage.sessionId ||
		confirmation.executionIdentity === acceptedStage.executionIdentity
	)
		throw new Error(`Learning promotion ${label} must use a distinct session and execution identity.`);
	const acceptedEvidenceDigests = new Set([
		digestObject(acceptedStage.resultRef),
		...acceptedStage.evidenceRefs.map((ref) => digestObject(ref)),
	]);
	if (
		acceptedEvidenceDigests.has(digestObject(confirmation.resultRef)) ||
		confirmation.evidenceRefs.some((ref) => acceptedEvidenceDigests.has(digestObject(ref)))
	)
		throw new Error(`Learning promotion ${label} must use fresh evidence artifacts.`);
	assertFreshTimestamp(confirmation.confirmedAt, `${label} time`);
	if (confirmation.provenanceDigest !== confirmationProvenanceDigest(confirmation))
		throw new Error(`Learning promotion ${label} provenance is not bound to its evidence.`);
}

async function verifyArtifact(
	resolver: WorkflowLearningPromotionReceiptAuthorityInput["artifactResolver"],
	ref: WorkflowArtifactRef,
	label: string,
): Promise<Uint8Array> {
	const resolved = await resolver.resolve(ref);
	if (
		!resolved.exists ||
		!resolved.envelope.immutable ||
		digestObject(resolved.envelope.ref) !== digestObject(ref) ||
		resolved.verifiedDigest !== ref.digest ||
		resolved.verifiedSizeBytes !== ref.sizeBytes ||
		resolved.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(resolved.bytes) !== ref.digest
	)
		throw new Error(`${label} is not resolver-verified.`);
	return new Uint8Array(resolved.bytes);
}

async function verifySourceArtifacts(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	source: WorkflowLearningPromotionAuthoritySource,
): Promise<{ readonly how: string; readonly why: string }> {
	const proposalBytes = await verifyArtifact(input.artifactResolver, source.proposalRef, "Learning proposal");
	const proposal = parseCanonicalJsonBytes(proposalBytes);
	const transfer = transferableProposalPayload({
		workflowId: source.workflowId,
		candidateId: source.candidateId,
		proposalDigest: source.proposalDigest,
		proposalRef: source.proposalRef,
		proposal,
	});
	if (digestObject(transfer) !== source.transferDigest)
		throw new Error("Learning promotion transfer payload is not semantically bound to its proposal.");
	await verifyArtifact(input.artifactResolver, source.acceptedStage.resultRef, "Learning accepted stage result");
	for (const ref of source.acceptedStage.evidenceRefs)
		await verifyArtifact(input.artifactResolver, ref, "Learning accepted stage evidence");
	const confirmationResultBytes = await verifyArtifact(
		input.artifactResolver,
		source.independentConfirmation.resultRef,
		"Learning confirmation result",
	);
	for (const ref of source.independentConfirmation.evidenceRefs)
		await verifyArtifact(input.artifactResolver, ref, "Learning confirmation evidence");
	const provenanceBytes = await verifyArtifact(
		input.artifactResolver,
		source.independentConfirmation.provenanceRef,
		"Learning confirmation provenance",
	);
	const provenance = parseCanonicalJsonBytes(provenanceBytes);
	if (
		!isRecord(provenance) ||
		provenance.kind !== "workflow-host-receipt" ||
		provenance.workflowId !== source.workflowId ||
		(provenance.receiptId !== undefined &&
			provenance.receiptId !== source.independentConfirmation.provenanceReceiptId) ||
		provenance.issuedAt !== source.independentConfirmation.confirmedAt
	)
		throw new Error("Learning confirmation provenance is not a host-authenticated timestamp.");
	const confirmationResult = parseCanonicalJsonBytes(confirmationResultBytes);
	if (isRecord(confirmationResult) && confirmationResult.confirmedAt !== undefined) {
		if (confirmationResult.confirmedAt !== source.independentConfirmation.confirmedAt)
			throw new Error("Learning confirmation timestamp is not bound to its immutable result evidence.");
	}
	return { how: transfer.how as string, why: transfer.why as string };
}

function receiptPayloadFields(
	receipt: WorkflowLearningPromotionReceipt | Omit<WorkflowLearningPromotionReceipt, "hostReceipt" | "receiptDigest">,
): Record<string, unknown> {
	const {
		hostReceipt: _hostReceipt,
		receiptDigest: _receiptDigest,
		...withoutHostEnvelope
	} = receipt as WorkflowLearningPromotionReceipt;
	return withoutHostEnvelope;
}

function receiptPayloadDigest(
	receipt: WorkflowLearningPromotionReceipt | Omit<WorkflowLearningPromotionReceipt, "hostReceipt" | "receiptDigest">,
): string {
	return digestObject({ ...receiptPayloadFields(receipt), payloadDigest: "", bindingDigest: "" });
}

function receiptBindingDigest(
	receipt: WorkflowLearningPromotionReceipt | Omit<WorkflowLearningPromotionReceipt, "hostReceipt" | "receiptDigest">,
	payloadDigest: string,
): string {
	return digestObject({
		bindingKind: "workflow_learning_promotion_receipt",
		workflowId: receipt.workflowId,
		candidateId: receipt.candidateId,
		promotionId: receipt.promotionId,
		generationId: receipt.generationId,
		nonce: receipt.nonce,
		acceptedHead: receipt.acceptedHead,
		goalRevision: receipt.goalRevision,
		payloadDigest,
	});
}

function receiptDigest(
	receipt: WorkflowLearningPromotionReceipt | Omit<WorkflowLearningPromotionReceipt, "receiptDigest">,
): string {
	return digestObject({ ...receipt, receiptDigest: "" });
}

function freezeValue<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child);
		Object.freeze(value);
	}
	return value;
}

function receiptIdentity(
	input: WorkflowLearningPromotionReceiptIssueInput,
	source: WorkflowLearningPromotionAuthoritySource,
): string {
	return digestObject({
		workflowId: source.workflowId,
		generationId: source.generationId,
		candidateId: source.candidateId,
		promotionId: source.promotionId,
		proposalDigest: input.proposalDigest,
		inputDigest: input.inputDigest,
		graphDigest: input.graphDigest,
		goalRevisionDigest: input.goalRevisionDigest,
		acceptedHead: source.acceptedHead,
	});
}

function sourceBindingDigest(source: WorkflowLearningPromotionAuthoritySource): string {
	return digestObject({
		schemaVersion: source.schemaVersion,
		workflowId: source.workflowId,
		status: source.status,
		generationId: source.generationId,
		epochRef: source.epochRef,
		stateDigest: source.stateDigest,
		currentRevision: source.currentRevision,
		goalRevision: source.goalRevision,
		inputDigest: source.inputDigest,
		graphDigest: source.graphDigest,
		acceptedHead: source.acceptedHead,
		candidateId: source.candidateId,
		promotionId: source.promotionId,
		revisionId: source.revisionId,
		policyDigest: source.policyDigest,
		proposalDigest: source.proposalDigest,
		proposalRef: source.proposalRef,
		transferDigest: source.transferDigest,
		acceptedStage: source.acceptedStage,
		independentConfirmation: source.independentConfirmation,
	});
}

function assertSourceBindingEqual(
	expected: WorkflowLearningPromotionAuthoritySource,
	actual: WorkflowLearningPromotionAuthoritySource,
): void {
	if (sourceBindingDigest(expected) !== sourceBindingDigest(actual))
		throw new Error("Learning promotion accepted head or source authority changed during the operation.");
}

async function readActiveSource(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
): Promise<WorkflowLearningPromotionAuthoritySource> {
	const source = await input.readCurrent();
	if (source === null) throw new Error("Learning promotion requires an accepted active host stage.");
	assertSource(source, input.workflowId);
	assertCurrentAuthority(input, source);
	return source;
}

async function assertIssuedHostReceiptAuthority(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	source: WorkflowLearningPromotionAuthoritySource,
	hostReceipt: WorkflowVerifiedHostReceipt,
	issuedAt: string,
): Promise<void> {
	const key = await input.receiptContext.keyResolver.resolve(hostReceipt.keyId);
	if (
		key.revoked ||
		key.algorithm !== hostReceipt.signatureAlgorithm ||
		key.ownerPrincipal !== hostReceipt.issuerId ||
		key.generationId !== source.generationId ||
		digestObject(key.epochRef) !== digestObject(source.epochRef) ||
		key.fencingDigest !== digestObject({ generationId: source.generationId, epochRef: source.epochRef })
	)
		throw new Error("Learning promotion host receipt signing key is not authenticated by this host authority.");
	await resolveAndVerifyWorkflowHostReceipt({
		context: input.receiptContext,
		workflowId: input.workflowId,
		expectedBindingDigest: hostReceipt.bindingDigest,
		receipt: hostReceipt,
		currentStateDigest: source.stateDigest,
		currentRevision: source.currentRevision,
		trustedNow: issuedAt,
	});
}

function promotionIdentity(source: WorkflowLearningPromotionAuthoritySource): string {
	return digestObject({
		workflowId: source.workflowId,
		generationId: source.generationId,
		candidateId: source.candidateId,
		promotionId: source.promotionId,
		revisionId: source.revisionId,
		proposalDigest: source.proposalDigest,
		transferDigest: source.transferDigest,
	});
}

function recordName(generationId: string): string {
	return `${WORKFLOW_LEARNING_PROMOTION_RECEIPT_RECORD}.${generationId}`;
}

function emptyRecord(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	generationId: string,
): WorkflowLearningPromotionReceiptRecord {
	return {
		schemaVersion: WORKFLOW_LEARNING_PROMOTION_RECEIPT_SCHEMA_VERSION,
		workflowId: input.workflowId,
		generationId,
		receipts: {},
		consumptions: {},
		consumedPromotions: {},
		applications: {},
	};
}

async function readRecord(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	source: WorkflowLearningPromotionAuthoritySource,
): Promise<WorkflowLearningPromotionReceiptRecord> {
	const bytes = await input.durableContext.auxiliaryStore.read(recordName(source.generationId));
	if (bytes === null) return emptyRecord(input, source.generationId);
	const value = parseCanonicalJsonBytes(bytes);
	if (
		!isRecord(value) ||
		value.schemaVersion !== WORKFLOW_LEARNING_PROMOTION_RECEIPT_SCHEMA_VERSION ||
		value.workflowId !== input.workflowId ||
		value.generationId !== source.generationId ||
		!isRecord(value.receipts) ||
		!isRecord(value.consumptions) ||
		(value.consumedPromotions !== undefined && !isRecord(value.consumedPromotions)) ||
		(value.applications !== undefined && !isRecord(value.applications))
	)
		throw new Error("Learning promotion receipt record is corrupt.");
	return {
		...(value as unknown as Omit<WorkflowLearningPromotionReceiptRecord, "consumedPromotions">),
		consumedPromotions:
			value.consumedPromotions === undefined
				? {}
				: (value.consumedPromotions as unknown as WorkflowLearningPromotionReceiptRecord["consumedPromotions"]),
		applications:
			value.applications === undefined
				? {}
				: (value.applications as unknown as WorkflowLearningPromotionReceiptRecord["applications"]),
	};
}

async function writeRecord(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	source: WorkflowLearningPromotionAuthoritySource,
	record: WorkflowLearningPromotionReceiptRecord,
): Promise<void> {
	await input.durableContext.auxiliaryStore.write(recordName(source.generationId), canonicalJsonBytes(record));
}

function assertReceiptShape(receipt: WorkflowLearningPromotionReceipt, workflowId: string): void {
	if (
		!isRecord(receipt) ||
		receipt.schemaVersion !== WORKFLOW_LEARNING_PROMOTION_RECEIPT_SCHEMA_VERSION ||
		receipt.receiptKind !== "learning_promotion" ||
		receipt.workflowId !== workflowId ||
		receipt.hostReceipt === undefined
	)
		throw new Error("Learning promotion receipt shape is invalid.");
	assertString(receipt.receiptId, "Learning promotion receipt id");
	assertString(receipt.nonce, "Learning promotion receipt nonce");
	assertString(receipt.rollbackToken, "Learning promotion rollback token");
	assertFreshTimestamp(receipt.issuedAt, "Learning promotion receipt issued time");
	assertFreshTimestamp(receipt.expiresAt, "Learning promotion receipt expiry");
	if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt))
		throw new Error("Learning promotion receipt expiry is invalid.");
	assertDigest(receipt.payloadDigest, "Learning promotion receipt payload digest");
	assertDigest(receipt.bindingDigest, "Learning promotion receipt binding digest");
	assertDigest(receipt.receiptDigest, "Learning promotion receipt digest");
	assertSource(receipt, workflowId);
	if (
		receipt.payloadDigest !== receiptPayloadDigest(receipt) ||
		receipt.bindingDigest !== receiptBindingDigest(receipt, receipt.payloadDigest) ||
		receipt.receiptDigest !== receiptDigest(receipt)
	)
		throw new Error("Learning promotion receipt digest binding is invalid.");
	if (
		receipt.hostReceipt.workflowId !== workflowId ||
		receipt.hostReceipt.receiptId !== receipt.receiptId ||
		receipt.hostReceipt.receiptKind !== "decision" ||
		receipt.hostReceipt.oneUse !== true ||
		receipt.hostReceipt.bindingDigest !== receipt.bindingDigest ||
		receipt.hostReceipt.payloadDigest !== receipt.payloadDigest ||
		receipt.hostReceipt.validUntil !== receipt.expiresAt ||
		receipt.hostReceipt.issuedAt !== receipt.issuedAt
	)
		throw new Error("Learning promotion host receipt is not bound to the envelope.");
}

function assertReceiptMatchesSource(
	receipt: WorkflowLearningPromotionReceipt,
	source: WorkflowLearningPromotionAuthoritySource,
	expected: WorkflowLearningPromotionReceiptConsumeInput,
): void {
	if (
		receipt.generationId !== source.generationId ||
		digestObject(receipt.epochRef) !== digestObject(source.epochRef) ||
		receipt.currentRevision !== source.currentRevision ||
		receipt.stateDigest !== source.stateDigest ||
		digestObject(receipt.acceptedHead) !== digestObject(source.acceptedHead) ||
		receipt.candidateId !== source.candidateId ||
		receipt.promotionId !== source.promotionId ||
		receipt.revisionId !== source.revisionId ||
		receipt.policyDigest !== source.policyDigest ||
		receipt.proposalDigest !== source.proposalDigest ||
		receipt.transferDigest !== source.transferDigest ||
		digestObject(receipt.acceptedStage) !== digestObject(source.acceptedStage) ||
		digestObject(receipt.independentConfirmation) !== digestObject(source.independentConfirmation) ||
		receipt.goalRevision.revision !== source.goalRevision.revision ||
		receipt.goalRevision.digest !== source.goalRevision.digest ||
		receipt.inputDigest !== source.inputDigest ||
		receipt.graphDigest !== source.graphDigest ||
		receipt.proposalDigest !== expected.proposalDigest ||
		receipt.inputDigest !== expected.inputDigest ||
		receipt.graphDigest !== expected.graphDigest ||
		receipt.goalRevision.digest !== expected.goalRevisionDigest
	)
		throw new Error("Learning promotion receipt is stale, mutated, or foreign to the accepted promotion.");
}

function refinementRecordName(generationId: string): string {
	return `${WORKFLOW_LEARNING_REFINEMENT_RECORD}.${generationId}`;
}

function bytesDigest(bytes: Readonly<Uint8Array> | null): string | null {
	return bytes === null ? null : sha256Hex(bytes);
}

async function readRefinementBytes(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	source: WorkflowLearningPromotionAuthoritySource,
): Promise<Uint8Array | null> {
	const bytes = await input.durableContext.auxiliaryStore.read(refinementRecordName(source.generationId));
	if (bytes === null) return null;
	if (bytes.byteLength > MAX_REFINEMENT_BYTES) throw new Error("Learning refinement record is too large.");
	return new Uint8Array(bytes);
}

async function writeRefinementBytes(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	source: WorkflowLearningPromotionAuthoritySource,
	bytes: Readonly<Uint8Array>,
): Promise<void> {
	if (bytes.byteLength > MAX_REFINEMENT_BYTES) throw new Error("Learning refinement record is too large.");
	await input.durableContext.auxiliaryStore.write(refinementRecordName(source.generationId), bytes);
}

async function removeRefinementBytes(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	source: WorkflowLearningPromotionAuthoritySource,
	expectedBytesDigest: string,
): Promise<void> {
	assertDigest(expectedBytesDigest, "Learning refinement rollback applied bytes digest");
	await input.durableContext.auxiliaryStore.remove(refinementRecordName(source.generationId), expectedBytesDigest);
}

function canonicalRefinementRecord(
	input: WorkflowLearningPromotionRefinementInput,
	source: WorkflowLearningPromotionAuthoritySource,
	receipt: WorkflowLearningPromotionReceipt,
	transfer: { readonly how: string; readonly why: string },
	applicationId: string,
): WorkflowLearningPromotionCanonicalRefinementRecord {
	const record: WorkflowLearningPromotionCanonicalRefinementRecord = {
		schemaVersion: 1,
		recordKind: "workflow_learning_refinement",
		applicationId,
		workflowId: source.workflowId,
		generationId: source.generationId,
		receiptId: receipt.receiptId,
		receiptDigest: receipt.receiptDigest,
		action: input.action,
		kind: input.kind,
		id: input.id,
		how: transfer.how,
		why: transfer.why,
		goalRevision: structuredClone(source.goalRevision),
		inputDigest: source.inputDigest,
		graphDigest: source.graphDigest,
		acceptedHead: structuredClone(source.acceptedHead),
		candidateId: source.candidateId,
		promotionId: source.promotionId,
		revisionId: source.revisionId,
		policyDigest: source.policyDigest,
		proposalDigest: source.proposalDigest,
		proposalRef: structuredClone(source.proposalRef),
		transferDigest: source.transferDigest,
		acceptedStage: structuredClone(source.acceptedStage),
		independentConfirmation: structuredClone(source.independentConfirmation),
		rollbackToken: receipt.rollbackToken,
		...(input.title === undefined ? {} : { title: input.title }),
		...(input.content === undefined ? {} : { content: input.content }),
		...(input.path === undefined ? {} : { path: input.path }),
		...(input.reference === undefined ? {} : { reference: structuredClone(input.reference) }),
		...(input.arguments === undefined ? {} : { arguments: structuredClone(input.arguments) }),
		...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
		...(input.reason === undefined ? {} : { reason: input.reason }),
	};
	return structuredClone(record);
}

function refinementInputDigest(
	input: WorkflowLearningPromotionRefinementInput,
	transfer: {
		readonly how: string;
		readonly why: string;
	},
): string {
	return digestObject({
		kind: "workflow_learning_refinement_input",
		input,
		transfer,
	});
}

function applicationResult(
	journal: WorkflowLearningPromotionApplicationJournal,
	receipt: WorkflowLearningPromotionReceipt,
): WorkflowLearningPromotionApplication {
	return structuredClone({
		applicationId: journal.applicationId,
		workflowId: receipt.workflowId,
		receiptId: journal.receiptId,
		record: journal.record,
		previousBytesDigest: journal.previousBytesDigest,
		appliedBytesDigest: journal.appliedBytesDigest,
		rollbackToken: journal.rollbackToken,
		receipt,
	});
}

function assertApplicationJournal(
	journal: WorkflowLearningPromotionApplicationJournal,
	source: WorkflowLearningPromotionAuthoritySource,
	receipt: WorkflowLearningPromotionReceipt,
): void {
	if (
		!isRecord(journal) ||
		journal.receiptId !== receipt.receiptId ||
		journal.receiptDigest !== receipt.receiptDigest ||
		journal.sourceBindingDigest !== sourceBindingDigest(source) ||
		journal.rollbackToken !== receipt.rollbackToken ||
		(!Array.isArray(journal.previousBytes) && journal.previousBytes !== null)
	)
		throw new Error("Learning refinement application journal is corrupt or foreign.");
	assertDigest(journal.applicationId, "Learning refinement application id");
	assertDigest(journal.refinementDigest, "Learning refinement input digest");
	assertDigest(journal.appliedBytesDigest, "Learning refinement applied bytes digest");
	if (journal.previousBytes !== null) {
		if (journal.previousBytes.some((byte) => !Number.isSafeInteger(byte) || byte < 0 || byte > 255))
			throw new Error("Learning refinement application prior bytes are corrupt.");
		if (sha256Hex(Uint8Array.from(journal.previousBytes)) !== journal.previousBytesDigest)
			throw new Error("Learning refinement application prior bytes digest is invalid.");
	} else if (journal.previousBytesDigest !== null) {
		throw new Error("Learning refinement application prior bytes digest is invalid.");
	}
	if (
		!(
			journal.state === "prepared" ||
			journal.state === "applied" ||
			journal.state === "rollback_prepared" ||
			journal.state === "rolled_back"
		)
	)
		throw new Error("Learning refinement application state is invalid.");
	if (journal.record.recordKind !== "workflow_learning_refinement" || journal.record.workflowId !== source.workflowId)
		throw new Error("Learning refinement canonical record is foreign.");
}

async function receiptConsumptionIsRecorded(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	receipt: WorkflowLearningPromotionReceipt,
): Promise<boolean> {
	try {
		const witness = await input.receiptContext.receiptResolver.resolveConsumptionWitness({
			receiptId: receipt.hostReceipt.receiptId,
			workflowId: input.workflowId,
			expectedBindingDigest: receipt.bindingDigest,
		});
		return (
			witness.receiptId === receipt.hostReceipt.receiptId &&
			witness.workflowId === input.workflowId &&
			witness.bindingDigest === receipt.bindingDigest &&
			witness.receiptDigest === digestObject(receipt.hostReceipt)
		);
	} catch {
		return false;
	}
}

async function consumeHostReceiptIfNeeded(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
	source: WorkflowLearningPromotionAuthoritySource,
	receipt: WorkflowLearningPromotionReceipt,
): Promise<void> {
	if (await receiptConsumptionIsRecorded(input, receipt)) return;
	await input.receiptContext.receiptResolver.consumeIfOneUse({
		receipt: receipt.hostReceipt,
		workflowId: input.workflowId,
		expectedBindingDigest: receipt.bindingDigest,
		currentRevision: source.currentRevision,
	});
}

/**
 * Create the host-owned capability used to transfer one accepted learning promotion into refinement.
 *
 * Args:
 * input: Authenticated durable store, receipt context, issuer, and host source resolver.
 * Return: Minimal issue/consume capability; signing keys and stores remain private to the host.
 */
export function createWorkflowLearningPromotionReceiptAuthority(
	input: WorkflowLearningPromotionReceiptAuthorityInput,
): WorkflowLearningPromotionReceiptAuthority {
	assertString(input.workflowId, "Learning promotion workflow id");
	const issue = async (
		request: WorkflowLearningPromotionReceiptIssueInput,
	): Promise<WorkflowLearningPromotionReceipt> => {
		const initialSource = await readActiveSource(input);
		if (
			request.candidateId !== initialSource.candidateId ||
			request.proposalDigest !== initialSource.proposalDigest ||
			request.inputDigest !== initialSource.inputDigest ||
			request.graphDigest !== initialSource.graphDigest ||
			request.goalRevisionDigest !== initialSource.goalRevision.digest
		)
			throw new Error("Learning promotion request is not bound to the host-accepted candidate and goal.");
		return input.durableContext.withExclusiveLease("workflow-learning-promotion-receipt", async () => {
			const source = await readActiveSource(input);
			assertSourceBindingEqual(initialSource, source);
			if (
				request.candidateId !== source.candidateId ||
				request.proposalDigest !== source.proposalDigest ||
				request.inputDigest !== source.inputDigest ||
				request.graphDigest !== source.graphDigest ||
				request.goalRevisionDigest !== source.goalRevision.digest
			)
				throw new Error("Learning promotion request is not bound to the host-accepted candidate and goal.");
			await verifySourceArtifacts(input, source);
			const identityDigest = receiptIdentity(request, source);
			const receiptId = `learning-promotion-${identityDigest.slice(0, 48)}`;
			const existingRecord = await readRecord(input, source);
			const existing = existingRecord.receipts[receiptId];
			if (existing !== undefined) {
				assertReceiptShape(existing, input.workflowId);
				if (
					sourceBindingDigest(existing) !== sourceBindingDigest(source) ||
					existing.candidateId !== request.candidateId ||
					existing.proposalDigest !== request.proposalDigest ||
					existing.inputDigest !== request.inputDigest ||
					existing.graphDigest !== request.graphDigest ||
					existing.goalRevision.digest !== request.goalRevisionDigest
				)
					throw new Error("Learning promotion receipt identity conflicts with the current source.");
				if (existingRecord.consumptions[receiptId] !== undefined)
					throw new Error("Learning promotion receipt was already consumed.");
				if (Date.parse(input.now()) >= Date.parse(existing.expiresAt))
					throw new Error("Learning promotion receipt has expired.");
				return structuredClone(existing);
			}
			if (existingRecord.consumedPromotions[promotionIdentity(source)] !== undefined)
				throw new Error("Learning promotion was already consumed.");
			const issuedAt = source.trustedNow;
			const expiresAt = new Date(Date.parse(issuedAt) + PROMOTION_RECEIPT_TTL_MILLISECONDS).toISOString();
			const unsigned: Omit<WorkflowLearningPromotionReceipt, "hostReceipt" | "receiptDigest"> = {
				...source,
				receiptKind: "learning_promotion",
				receiptId,
				nonce: identityDigest,
				rollbackToken: digestObject({
					kind: "workflow_learning_rollback",
					identityDigest,
					generationId: source.generationId,
				}),
				issuedAt,
				expiresAt,
				payloadDigest: "",
				bindingDigest: "",
			};
			const payloadDigest = receiptPayloadDigest(unsigned);
			const bindingDigest = receiptBindingDigest(unsigned, payloadDigest);
			const prepared = { ...unsigned, payloadDigest, bindingDigest };
			const hostReceipt = await input.issueReceipt({
				receiptKind: "decision",
				workflowId: input.workflowId,
				bindingDigest,
				payloadDigest,
				receiptId,
				oneUse: true,
				issuedAt,
				stateDigest: source.stateDigest,
				revision: source.currentRevision,
				payloadKind: "workflow-learning",
			});
			if (
				hostReceipt.receiptId !== receiptId ||
				hostReceipt.receiptKind !== "decision" ||
				hostReceipt.oneUse !== true ||
				hostReceipt.workflowId !== input.workflowId ||
				hostReceipt.bindingDigest !== bindingDigest ||
				hostReceipt.payloadDigest !== payloadDigest ||
				hostReceipt.issuedAt !== issuedAt ||
				hostReceipt.validUntil !== expiresAt
			)
				throw new Error("Learning promotion host receipt issuer returned a mismatched envelope.");
			await assertIssuedHostReceiptAuthority(input, source, hostReceipt, issuedAt);
			const receipt = freezeValue({
				...prepared,
				hostReceipt,
				receiptDigest: receiptDigest({ ...prepared, hostReceipt }),
			});
			assertReceiptShape(receipt, input.workflowId);
			const afterIssue = await readActiveSource(input);
			assertSourceBindingEqual(source, afterIssue);
			const current = await readRecord(input, source);
			const currentExisting = current.receipts[receiptId];
			if (currentExisting !== undefined) {
				assertReceiptShape(currentExisting, input.workflowId);
				if (
					sourceBindingDigest(currentExisting) !== sourceBindingDigest(source) ||
					currentExisting.receiptDigest !== receipt.receiptDigest
				)
					throw new Error("Learning promotion receipt identity conflicts with an existing receipt.");
				if (current.consumptions[receiptId] !== undefined)
					throw new Error("Learning promotion receipt was already consumed.");
				return structuredClone(currentExisting);
			}
			await writeRecord(input, source, {
				...current,
				receipts: { ...current.receipts, [receiptId]: receipt },
			});
			return structuredClone(receipt);
		});
	};
	const consume = async (
		request: WorkflowLearningPromotionReceiptConsumeInput,
	): Promise<WorkflowLearningPromotionReceiptConsumption> => {
		assertReceiptShape(request.receipt, input.workflowId);
		const initialSource = await readActiveSource(input);
		assertReceiptMatchesSource(request.receipt, initialSource, request);
		await verifySourceArtifacts(input, initialSource);
		return input.durableContext.withExclusiveLease("workflow-learning-promotion-receipt-consume", async () => {
			const source = await readActiveSource(input);
			assertSourceBindingEqual(initialSource, source);
			assertReceiptMatchesSource(request.receipt, source, request);
			await verifySourceArtifacts(input, source);
			const record = await readRecord(input, source);
			const persisted = record.receipts[request.receipt.receiptId];
			if (persisted === undefined || persisted.receiptDigest !== request.receipt.receiptDigest)
				throw new Error("Learning promotion receipt was not issued by this host generation.");
			if (record.consumptions[request.receipt.receiptId] !== undefined)
				throw new Error("Learning promotion receipt was already consumed.");
			const promotionKey = promotionIdentity(source);
			if (record.consumedPromotions[promotionKey] !== undefined)
				throw new Error("Learning promotion was already consumed.");
			await assertIssuedHostReceiptAuthority(input, source, request.receipt.hostReceipt, input.now());
			await input.receiptContext.receiptResolver.consumeIfOneUse({
				receipt: request.receipt.hostReceipt,
				workflowId: input.workflowId,
				expectedBindingDigest: request.receipt.bindingDigest,
				currentRevision: source.currentRevision,
			});
			const afterConsume = await readActiveSource(input);
			assertSourceBindingEqual(source, afterConsume);
			const consumedAt = input.now();
			await writeRecord(input, source, {
				...record,
				consumptions: {
					...record.consumptions,
					[request.receipt.receiptId]: {
						receiptDigest: request.receipt.receiptDigest,
						consumedAt,
					},
				},
				consumedPromotions: {
					...record.consumedPromotions,
					[promotionKey]: {
						receiptId: request.receipt.receiptId,
						receiptDigest: request.receipt.receiptDigest,
						consumedAt,
					},
				},
			});
			return structuredClone({
				receiptId: request.receipt.receiptId,
				workflowId: input.workflowId,
				candidateId: request.receipt.candidateId,
				proposalDigest: request.receipt.proposalDigest,
				transferDigest: request.receipt.transferDigest,
				acceptedHead: request.receipt.acceptedHead,
				rollbackToken: request.receipt.rollbackToken,
				receipt: request.receipt,
			});
		});
	};
	const consumeAndApply = async (
		rawRequest: WorkflowLearningPromotionConsumeAndApplyInput,
	): Promise<WorkflowLearningPromotionApplication> => {
		const request = structuredClone(rawRequest);
		assertReceiptShape(request.receipt, input.workflowId);
		const initialSource = await readActiveSource(input);
		assertReceiptMatchesSource(request.receipt, initialSource, request);
		const initialTransfer = await verifySourceArtifacts(input, initialSource);
		assertRefinementInput(request.refinement);
		if (request.refinement.how !== undefined && request.refinement.how !== initialTransfer.how)
			throw new Error("Learning refinement how payload is not bound to the accepted transfer.");
		if (request.refinement.why !== undefined && request.refinement.why !== initialTransfer.why)
			throw new Error("Learning refinement why payload is not bound to the accepted transfer.");
		if (request.expectedPreviousBytesDigest !== undefined && request.expectedPreviousBytesDigest !== null)
			assertDigest(request.expectedPreviousBytesDigest, "Learning refinement expected prior bytes digest");
		return input.durableContext.withExclusiveLease("workflow-learning-promotion-refinement-apply", async () => {
			const source = await readActiveSource(input);
			assertSourceBindingEqual(initialSource, source);
			assertReceiptMatchesSource(request.receipt, source, request);
			const transfer = await verifySourceArtifacts(input, source);
			assertRefinementInput(request.refinement);
			if (request.refinement.how !== undefined && request.refinement.how !== transfer.how)
				throw new Error("Learning refinement how payload is not bound to the accepted transfer.");
			if (request.refinement.why !== undefined && request.refinement.why !== transfer.why)
				throw new Error("Learning refinement why payload is not bound to the accepted transfer.");
			await assertIssuedHostReceiptAuthority(input, source, request.receipt.hostReceipt, input.now());
			const refinementDigest = refinementInputDigest(request.refinement, transfer);
			const applicationId = digestObject({
				kind: "workflow_learning_refinement_application",
				receiptId: request.receipt.receiptId,
				receiptDigest: request.receipt.receiptDigest,
				refinementDigest,
				sourceBindingDigest: sourceBindingDigest(source),
			});
			const canonicalRecord = canonicalRefinementRecord(
				request.refinement,
				source,
				request.receipt,
				transfer,
				applicationId,
			);
			const appliedBytes = canonicalJsonBytes(canonicalRecord);
			if (appliedBytes.byteLength > MAX_REFINEMENT_BYTES)
				throw new Error("Learning refinement record is too large.");
			const record = await readRecord(input, source);
			const existing = record.applications[applicationId];
			if (existing !== undefined) {
				assertApplicationJournal(existing, source, request.receipt);
				if (
					existing.refinementDigest !== refinementDigest ||
					digestObject(existing.record) !== digestObject(canonicalRecord)
				)
					throw new Error("Learning refinement replay conflicts with the existing application.");
				const currentBytes = await readRefinementBytes(input, source);
				const expectedCurrentDigest =
					existing.state === "rolled_back" ? existing.previousBytesDigest : existing.appliedBytesDigest;
				if (bytesDigest(currentBytes) !== expectedCurrentDigest)
					throw new Error("Learning refinement replay found a stale or mutated target.");
				return applicationResult(existing, request.receipt);
			}
			if (
				Object.values(record.applications).some(
					(application) => application.receiptId === request.receipt.receiptId,
				)
			)
				throw new Error("Learning refinement receipt was already applied with a different record.");
			if (record.consumptions[request.receipt.receiptId] !== undefined)
				throw new Error("Learning promotion receipt was already consumed.");
			const promotionKey = promotionIdentity(source);
			if (record.consumedPromotions[promotionKey] !== undefined)
				throw new Error("Learning promotion was already consumed.");
			const previousBytes = await readRefinementBytes(input, source);
			const previousBytesDigest = bytesDigest(previousBytes);
			if (
				request.expectedPreviousBytesDigest !== undefined &&
				request.expectedPreviousBytesDigest !== previousBytesDigest
			)
				throw new Error("Learning refinement target is stale or failed its CAS check.");
			const journal: WorkflowLearningPromotionApplicationJournal = {
				applicationId,
				receiptId: request.receipt.receiptId,
				receiptDigest: request.receipt.receiptDigest,
				sourceBindingDigest: sourceBindingDigest(source),
				refinementDigest,
				previousBytes: previousBytes === null ? null : [...previousBytes],
				previousBytesDigest,
				appliedBytesDigest: sha256Hex(appliedBytes),
				record: canonicalRecord,
				state: "prepared",
				rollbackToken: request.receipt.rollbackToken,
			};
			await writeRecord(input, source, {
				...record,
				applications: { ...record.applications, [applicationId]: journal },
			});
			await consumeHostReceiptIfNeeded(input, source, request.receipt);
			const afterConsume = await readActiveSource(input);
			assertSourceBindingEqual(source, afterConsume);
			const currentBeforeWrite = await readRefinementBytes(input, source);
			if (bytesDigest(currentBeforeWrite) !== previousBytesDigest)
				throw new Error("Learning refinement target changed during the apply operation.");
			await writeRefinementBytes(input, source, appliedBytes);
			const consumedAt = input.now();
			const appliedJournal: WorkflowLearningPromotionApplicationJournal = {
				...journal,
				state: "applied",
			};
			await writeRecord(input, source, {
				...record,
				consumptions: {
					...record.consumptions,
					[request.receipt.receiptId]: {
						receiptDigest: request.receipt.receiptDigest,
						consumedAt,
					},
				},
				consumedPromotions: {
					...record.consumedPromotions,
					[promotionKey]: {
						receiptId: request.receipt.receiptId,
						receiptDigest: request.receipt.receiptDigest,
						consumedAt,
					},
				},
				applications: { ...record.applications, [applicationId]: appliedJournal },
			});
			return applicationResult(appliedJournal, request.receipt);
		});
	};
	const rollback = async (
		rawRequest: WorkflowLearningPromotionRollbackInput,
	): Promise<WorkflowLearningPromotionRollbackResult> => {
		const request = structuredClone(rawRequest);
		if (request.workflowId !== input.workflowId)
			throw new Error("Learning refinement rollback crossed the workflow boundary.");
		assertString(request.receiptId, "Learning refinement rollback receipt id");
		assertString(request.rollbackToken, "Learning refinement rollback token");
		assertDigest(request.expectedAppliedBytesDigest, "Learning refinement rollback applied bytes digest");
		return input.durableContext.withExclusiveLease("workflow-learning-promotion-refinement-rollback", async () => {
			const source = await readActiveSource(input);
			const record = await readRecord(input, source);
			const journal = Object.values(record.applications).find(
				(application) => application.receiptId === request.receiptId,
			);
			if (journal === undefined) throw new Error("Learning refinement application was not found.");
			const receipt = record.receipts[request.receiptId];
			if (receipt === undefined) throw new Error("Learning refinement receipt was not found.");
			assertReceiptShape(receipt, input.workflowId);
			assertApplicationJournal(journal, source, receipt);
			if (
				request.rollbackToken !== journal.rollbackToken ||
				request.rollbackToken !== receipt.rollbackToken ||
				request.expectedAppliedBytesDigest !== journal.appliedBytesDigest
			)
				throw new Error("Learning refinement rollback token or CAS digest is stale.");
			const currentBytes = await readRefinementBytes(input, source);
			const currentDigest = bytesDigest(currentBytes);
			if (journal.state === "rolled_back") {
				if (currentDigest !== journal.previousBytesDigest)
					throw new Error("Learning refinement rollback replay found a mutated target.");
				return {
					status: "rolled_back",
					applicationId: journal.applicationId,
					receiptId: journal.receiptId,
					restoredBytesDigest: journal.previousBytesDigest,
					rollbackToken: journal.rollbackToken,
				};
			}
			if (currentDigest !== journal.appliedBytesDigest)
				throw new Error("Learning refinement rollback target changed after apply.");
			const rollbackPrepared: WorkflowLearningPromotionApplicationJournal = {
				...journal,
				state: "rollback_prepared",
			};
			await writeRecord(input, source, {
				...record,
				applications: { ...record.applications, [journal.applicationId]: rollbackPrepared },
			});
			if (journal.previousBytes === null) await removeRefinementBytes(input, source, journal.appliedBytesDigest);
			else await writeRefinementBytes(input, source, Uint8Array.from(journal.previousBytes));
			const rolledBack: WorkflowLearningPromotionApplicationJournal = {
				...rollbackPrepared,
				state: "rolled_back",
				rolledBackAt: input.now(),
			};
			await writeRecord(input, source, {
				...record,
				applications: { ...record.applications, [journal.applicationId]: rolledBack },
			});
			return {
				status: "rolled_back",
				applicationId: rolledBack.applicationId,
				receiptId: rolledBack.receiptId,
				restoredBytesDigest: rolledBack.previousBytesDigest,
				rollbackToken: rolledBack.rollbackToken,
			};
		});
	};
	return Object.freeze({ issue, consume, consumeAndApply, rollback });
}
