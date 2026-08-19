import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	type WorkflowArtifactReadResult,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizer,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowJournalHead,
	type WorkflowRuntimeStore,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { assertWorkflowRuntimeVersion } from "./runtime-store-adapter.js";

export const WORKFLOW_DECISION_PACKET_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_DECISION_PACKET_CAPABILITY = "workflow_decision_packet_delivery" as const;

export const WORKFLOW_DECISION_PACKET_LIMITS = Object.freeze({
	maxPacketBytes: 12_288,
	/** Leave framing room below the session message limit. */
	maxTriadBytes: 15_360,
	framingHeadroomBytes: 1_024,
	sessionMessageLimitBytes: 16_384,
	maxIdentifierBytes: 256,
	maxShortTextBytes: 512,
	maxTextBytes: 4_096,
	maxSummaryBytes: 512,
	maxBlockers: 32,
	maxFindingsPerBlocker: 16,
	maxRequirements: 64,
	maxUncertainty: 16,
	maxAmendments: 32,
	maxDependencies: 64,
	maxWriteScope: 64,
	maxAcceptanceChecks: 32,
	maxClosureMappings: 32,
	maxSectionRefs: 128,
	maxSelectedSections: 16,
	maxSectionBytes: 65_536,
	maxReportBytes: 8_388_608,
	maxContentTypeBytes: 128,
	/** A byte can consume a token in the worst case; UTF-8 density is not assumed. */
	bytesPerToken: 1,
	defaultBlockerReserveTokens: 256,
});

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const FORBIDDEN_PACKET_KEYS = new Set([
	"body",
	"bytes",
	"fullReport",
	"fullReportBytes",
	"rawReport",
	"rawReportBytes",
	"reportBytes",
]);

const HOST_AUTHORITY_BRAND: unique symbol = Symbol("workflow-decision-packet-host-authority");
const hostAuthorities = new WeakSet<object>();

export class WorkflowDecisionPacketError extends Error {
	readonly code: string;

	public constructor(code: string, message: string) {
		super(message);
		this.name = "WorkflowDecisionPacketError";
		this.code = code;
	}
}

/**
 * Opaque host authority issued only after a durable workflow host has authenticated the
 * capability and persisted its binding. The brand is intentionally not exported.
 */
export interface WorkflowDecisionPacketHostAuthority {
	readonly [HOST_AUTHORITY_BRAND]: true;
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly principalAuthorizer: WorkflowHostPrincipalCapabilityAuthorizer;
	readonly registry: WorkflowDecisionPacketHostRegistry;
	readonly capabilityReceipt: WorkflowVerifiedHostReceipt;
	readonly bindingDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly stateDigest: string;
	readonly revision: number;
	readonly generationId: string;
	readonly receiptContext: WorkflowHostReceiptConsumerContext | null;
	readonly expectedReportGeneration: number | null;
	readonly expectedSectionGenerations: Readonly<Record<string, number>>;
}

export type WorkflowDecisionPacketLifecycle = "provisional" | "terminal";

export interface WorkflowDecisionProducerFence {
	readonly generationId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly fencingDigest: string;
}

export interface WorkflowDecisionPacketTerminalSectionSeal {
	readonly sectionId: string;
	readonly generation: number;
	readonly artifactRef: WorkflowArtifactRef;
	readonly digest: string;
}

/**
 * Host-verifiable receipt for a terminal packet set.
 * A digest without this receipt and host verification is never terminal authority.
 */
export interface WorkflowDecisionPacketTerminalSeal {
	readonly kind: "verified_artifact_seal";
	readonly sealRef: WorkflowArtifactRef;
	readonly reportRef: WorkflowArtifactRef;
	readonly reportGeneration: number;
	readonly sectionRefs: readonly WorkflowDecisionPacketTerminalSectionSeal[];
	readonly producer: {
		readonly workflowId: string;
		readonly taskId: string;
		readonly attemptId: string;
		readonly epochRef: WorkflowEpochRef;
		readonly outputObligationId: string;
		readonly producerFence: WorkflowDecisionProducerFence;
	};
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly sealDigest: string;
}

export interface WorkflowDecisionPacketBinding {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly runtimeVersion: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly capability: typeof WORKFLOW_DECISION_PACKET_CAPABILITY;
}

export interface WorkflowDecisionPacketBase extends WorkflowDecisionPacketBinding {
	readonly schemaVersion: typeof WORKFLOW_DECISION_PACKET_SCHEMA_VERSION;
	readonly packetId: string;
	readonly lifecycle: WorkflowDecisionPacketLifecycle;
	readonly packetDigest: string;
}

export type WorkflowDecisionGateVerdict = "accepted" | "rejected" | "blocked" | "inconclusive";
export type WorkflowDecisionRequiredDisposition = "accept" | "dispatch_amendment" | "selective_expansion" | "hold";

export interface WorkflowDecisionPacketBlocker {
	readonly blockerId: string;
	readonly findingIds: readonly string[];
	readonly summary: string;
	readonly sectionIds: readonly string[];
	readonly disposition: "open" | "resolved" | "uncertain";
}

export interface WorkflowDecisionVerdictPacket extends WorkflowDecisionPacketBase {
	readonly kind: "verdict_packet";
	readonly verdict: WorkflowDecisionGateVerdict;
	readonly topBlockers: readonly WorkflowDecisionPacketBlocker[];
	readonly requirementIds: readonly string[];
	readonly confidence: "high" | "medium" | "low";
	readonly uncertainty: readonly string[];
	readonly requiredDisposition: WorkflowDecisionRequiredDisposition;
	/** Worker metadata only. Host validation recomputes expansionRequired. */
	readonly expansionRequired: boolean;
}

export interface WorkflowDecisionRemediationAmendment {
	readonly amendmentId: string;
	readonly text: string;
	readonly targetSectionIds: readonly string[];
	readonly targetFileRefs: readonly string[];
}

export interface WorkflowDecisionRemediationPacket extends WorkflowDecisionPacketBase {
	readonly kind: "remediation_packet";
	readonly amendments: readonly WorkflowDecisionRemediationAmendment[];
	readonly dependencies: readonly string[];
	readonly ownership: {
		readonly owner: string;
		readonly writeScope: readonly string[];
	};
	readonly requiredNextAction: string;
	readonly publicAcceptanceChecks: readonly {
		readonly checkId: string;
		readonly publicBoundary: string;
		readonly description: string;
	}[];
	readonly blockerClosureMapping: readonly {
		readonly blockerId: string;
		readonly amendmentIds: readonly string[];
		readonly requiredEvidenceSectionIds: readonly string[];
	}[];
	readonly requirementClosureMapping: readonly {
		readonly requirementId: string;
		readonly amendmentIds: readonly string[];
		readonly blockedAction: string | null;
	}[];
}

export interface WorkflowDecisionEvidenceSectionRef {
	readonly sectionId: string;
	readonly ordinal: number;
	readonly title: string;
	/** Byte offsets in the immutable full report. */
	readonly startOffset: number;
	readonly endOffset: number;
	readonly artifactRef: WorkflowArtifactRef;
	readonly digest: string;
	readonly sizeBytes: number;
	readonly sourceEventSequence: number;
	readonly contentType: string;
}

export interface WorkflowDecisionEvidenceManifest extends WorkflowDecisionPacketBase {
	readonly kind: "evidence_manifest";
	readonly fullReportRef: WorkflowArtifactRef;
	readonly fullReportContentType: string;
	readonly sectionRefs: readonly WorkflowDecisionEvidenceSectionRef[];
}

export type WorkflowDecisionPacket =
	| WorkflowDecisionVerdictPacket
	| WorkflowDecisionRemediationPacket
	| WorkflowDecisionEvidenceManifest;

export interface WorkflowDecisionPacketTriad {
	readonly verdict: WorkflowDecisionVerdictPacket;
	readonly remediation: WorkflowDecisionRemediationPacket;
	readonly evidenceManifest: WorkflowDecisionEvidenceManifest;
	readonly lifecycle: WorkflowDecisionPacketLifecycle;
	readonly terminalSeal: WorkflowDecisionPacketTerminalSeal | null;
	/** Digest of the packet this correction supersedes, when applicable. */
	readonly supersedesPacketDigest: string | null;
	readonly packetDigest: string;
	readonly packetBytes: number;
}

export interface WorkflowDecisionVerdictPacketInput {
	readonly packetId: string;
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly lifecycle?: WorkflowDecisionPacketLifecycle;
	readonly runtimeVersion: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly verdict: WorkflowDecisionGateVerdict;
	readonly topBlockers: readonly WorkflowDecisionPacketBlocker[];
	readonly requirementIds: readonly string[];
	readonly confidence: "high" | "medium" | "low";
	readonly uncertainty: readonly string[];
	readonly requiredDisposition: WorkflowDecisionRequiredDisposition;
	readonly expansionRequired: boolean;
}

export interface WorkflowDecisionRemediationPacketInput {
	readonly packetId: string;
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly lifecycle?: WorkflowDecisionPacketLifecycle;
	readonly runtimeVersion: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly amendments: readonly WorkflowDecisionRemediationAmendment[];
	readonly dependencies: readonly string[];
	readonly ownership: {
		readonly owner: string;
		readonly writeScope: readonly string[];
	};
	readonly requiredNextAction: string;
	readonly publicAcceptanceChecks: readonly {
		readonly checkId: string;
		readonly publicBoundary: string;
		readonly description: string;
	}[];
	readonly blockerClosureMapping: readonly {
		readonly blockerId: string;
		readonly amendmentIds: readonly string[];
		readonly requiredEvidenceSectionIds: readonly string[];
	}[];
	readonly requirementClosureMapping: readonly {
		readonly requirementId: string;
		readonly amendmentIds: readonly string[];
		readonly blockedAction: string | null;
	}[];
}

export interface WorkflowDecisionEvidenceManifestInput {
	readonly packetId: string;
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly lifecycle?: WorkflowDecisionPacketLifecycle;
	readonly runtimeVersion: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly fullReportRef: WorkflowArtifactRef;
	readonly fullReportContentType: string;
	readonly sectionRefs: readonly WorkflowDecisionEvidenceSectionRef[];
}

export interface WorkflowDecisionPacketExpectedBlocker {
	readonly blockerId: string;
	readonly findingIds: readonly string[];
	readonly requiredSectionIds: readonly string[];
}

export interface WorkflowDecisionPacketExpectedSet {
	readonly blockers: readonly WorkflowDecisionPacketExpectedBlocker[];
	readonly requirementIds: readonly string[];
}

export interface WorkflowDecisionPacketHostRegistry {
	readonly recomputeExpectedSet: (input: {
		readonly workflowId: string;
		readonly taskId: string;
		readonly attemptId: string;
		readonly head: WorkflowJournalHead;
		readonly epochRef: WorkflowEpochRef;
	}) => WorkflowDecisionPacketExpectedSet | Promise<WorkflowDecisionPacketExpectedSet>;
}

export interface WorkflowDecisionPacketCapabilityAuthorizationInput {
	readonly capability: typeof WORKFLOW_DECISION_PACKET_CAPABILITY;
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly packetDigest: string;
}

export interface WorkflowDecisionPacketCurrentBinding {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly runtimeVersion?: string;
}

export interface WorkflowDecisionPacketTerminalSealVerificationInput {
	readonly seal: WorkflowDecisionPacketTerminalSeal;
	readonly packets: WorkflowDecisionPacketTriad;
	readonly currentBinding: WorkflowDecisionPacketCurrentBinding;
}

export interface WorkflowDecisionPacketDeliveryInput {
	readonly packets: WorkflowDecisionPacketTriad;
	readonly currentBinding: WorkflowDecisionPacketCurrentBinding;
	/** Issued by a persisted host after generic capability authorization. */
	readonly hostAuthority: WorkflowDecisionPacketHostAuthority;
	/** Optional prior result used to enforce terminal supersession across attempts. */
	readonly priorTerminalPacket?: WorkflowDecisionPacketTriad;
}

export interface WorkflowDecisionPacketDeliveryResult {
	readonly accepted: boolean;
	readonly lifecycle: WorkflowDecisionPacketLifecycle;
	readonly terminalSealVerified: boolean;
	/** Host-derived; worker expansionRequired is never used for this field. */
	readonly expansionRequired: boolean;
	readonly workerExpansionRequested: boolean;
	readonly missingBlockerIds: readonly string[];
	readonly contradictedBlockerIds: readonly string[];
	readonly missingRequirementIds: readonly string[];
	readonly contradictedRequirementIds: readonly string[];
	readonly requiredSectionIds: readonly string[];
	readonly authoritativeBlockerIds: readonly string[];
	readonly authoritativeRequirementIds: readonly string[];
	readonly packetDigest: string;
	readonly capability: typeof WORKFLOW_DECISION_PACKET_CAPABILITY;
}

export type WorkflowDecisionExpansionReason =
	| "ambiguous_finding"
	| "missing_blocker"
	| "cross_lens_conflict"
	| "contradicted_finding";

export interface WorkflowDecisionExpandedSection {
	readonly sectionId: string;
	readonly ordinal: number;
	readonly contentType: string;
	readonly digest: string;
	readonly sizeBytes: number;
	readonly sourceEventSequence: number;
	readonly text: string;
}

export interface WorkflowDecisionSynthesisRemediationCorrection {
	readonly kind: "synthesis_remediation_correction";
	readonly sectionIds: readonly string[];
	readonly blockerIds: readonly string[];
	readonly summary: string;
	readonly requiredNextAction: string;
	readonly correctionDigest: string;
}

export interface WorkflowDecisionSelectiveExpansionInput {
	readonly manifest: WorkflowDecisionEvidenceManifest;
	readonly sectionIds: readonly string[];
	/** For conflict expansion, the host may bind the request to exactly these disputed sections. */
	readonly disputedSectionIds?: readonly string[];
	readonly hostContradictionPlan?: WorkflowDecisionHostContradictionPlan;
	readonly lensIdentity?: WorkflowDecisionLensIdentity;
	readonly resolver: WorkflowArtifactResolver;
	readonly reason: WorkflowDecisionExpansionReason;
	readonly synthesize: (input: {
		readonly reason: WorkflowDecisionExpansionReason;
		readonly sectionIds: readonly string[];
		readonly sections: readonly WorkflowDecisionExpandedSection[];
	}) => WorkflowDecisionSynthesisRemediationCorrection;
}

export interface WorkflowDecisionLensIdentity {
	readonly lensId: string;
	readonly contradictionId: string;
}

export interface WorkflowDecisionHostContradictionPlan {
	readonly planId: string;
	readonly disputedSectionIds: readonly string[];
	readonly lensIdentities: readonly WorkflowDecisionLensIdentity[];
	readonly maxSectionCount: number;
	readonly planDigest: string;
}

export interface WorkflowDecisionSelectiveExpansionResult {
	readonly reason: WorkflowDecisionExpansionReason;
	readonly sectionIds: readonly string[];
	readonly sections: readonly WorkflowDecisionExpandedSection[];
	readonly correction: WorkflowDecisionSynthesisRemediationCorrection;
	readonly fullReportResolved: false;
	readonly expansionDigest: string;
}

export interface WorkflowDecisionAmendmentTask {
	readonly taskId: string;
	readonly workflowId: string;
	readonly parentTaskId: string;
	readonly attemptId: string;
	readonly objective: string;
	readonly blockerIds: readonly string[];
	readonly requirementIds: readonly string[];
	readonly dependencies: readonly string[];
	readonly owner: string;
	readonly ownedPaths: readonly string[];
	readonly requiredNextAction: string;
	readonly publicAcceptanceChecks: readonly {
		readonly checkId: string;
		readonly publicBoundary: string;
		readonly description: string;
	}[];
	readonly blockerClosureMapping: readonly {
		readonly blockerId: string;
		readonly amendmentIds: readonly string[];
		readonly requiredEvidenceSectionIds: readonly string[];
	}[];
	readonly requirementClosureMapping: readonly {
		readonly requirementId: string;
		readonly amendmentIds: readonly string[];
		readonly blockedAction: string | null;
	}[];
	readonly dispatchDigest: string;
}

export interface WorkflowDecisionAmendmentTaskInput {
	readonly verdict: WorkflowDecisionVerdictPacket;
	readonly remediation: WorkflowDecisionRemediationPacket;
}

export type WorkflowDecisionIngestDisposition = "accepted" | "section_required" | "child_synthesis_required";
export type WorkflowDecisionPermittedRead = "packet_only" | "declared_sections";

export interface WorkflowDecisionPacketIngestAdmissionInput {
	readonly currentEstimatedContextTokens: number;
	readonly reserveTokens: number;
	readonly headroomTokens: number;
	readonly packetEstimateBytes: number;
	readonly artifactSizeBytes: number;
	readonly sectionSizeBytes: number;
	readonly hardIngestBudgetTokens: number;
	readonly selectiveExpansionOverheadTokens?: number;
	readonly compactionOverheadTokens?: number;
	readonly blockerReserveTokens?: number;
	readonly runtimeStore?: WorkflowRuntimeStore;
}

export interface WorkflowDecisionPacketIngestAdmissionResult {
	readonly disposition: WorkflowDecisionIngestDisposition;
	readonly permittedRead: WorkflowDecisionPermittedRead;
	readonly fullReportRead: "forbidden";
	readonly availableTokens: number;
	readonly packetTokens: number;
	readonly artifactTokens: number;
	readonly sectionTokens: number;
	readonly overheadTokens: number;
	readonly blockerReserveTokens: number;
}

const COMMON_PACKET_KEYS = [
	"schemaVersion",
	"kind",
	"packetId",
	"lifecycle",
	"workflowId",
	"taskId",
	"attemptId",
	"runtimeVersion",
	"head",
	"epochRef",
	"capability",
	"packetDigest",
] as const;

const VERDICT_PACKET_KEYS = [
	...COMMON_PACKET_KEYS,
	"verdict",
	"topBlockers",
	"requirementIds",
	"confidence",
	"uncertainty",
	"requiredDisposition",
	"expansionRequired",
] as const;

const REMEDIATION_PACKET_KEYS = [
	...COMMON_PACKET_KEYS,
	"amendments",
	"dependencies",
	"ownership",
	"requiredNextAction",
	"publicAcceptanceChecks",
	"blockerClosureMapping",
	"requirementClosureMapping",
] as const;

const EVIDENCE_MANIFEST_KEYS = [
	...COMMON_PACKET_KEYS,
	"fullReportRef",
	"fullReportContentType",
	"sectionRefs",
] as const;

const TRIAD_KEYS = [
	"verdict",
	"remediation",
	"evidenceManifest",
	"lifecycle",
	"terminalSeal",
	"supersedesPacketDigest",
	"packetDigest",
	"packetBytes",
] as const;

const TERMINAL_SEAL_KEYS = [
	"kind",
	"sealRef",
	"reportRef",
	"reportGeneration",
	"sectionRefs",
	"producer",
	"receipt",
	"sealDigest",
] as const;

const TERMINAL_SECTION_SEAL_KEYS = ["sectionId", "generation", "artifactRef", "digest"] as const;
const PRODUCER_FENCE_KEYS = ["generationId", "epochRef", "fencingDigest"] as const;
const TERMINAL_PRODUCER_KEYS = [
	"workflowId",
	"taskId",
	"attemptId",
	"epochRef",
	"outputObligationId",
	"producerFence",
] as const;
const RECEIPT_REQUIRED_KEYS = [
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
] as const;

function fail(code: string, message: string): never {
	throw new WorkflowDecisionPacketError(code, message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertDataDescriptors(value: object, label: string): void {
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
			fail("accessor_forbidden", `${label} contains an accessor.`);
		}
	}
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isPlainRecord(value)) fail("custom_prototype", `${label} must be a plain object.`);
	assertDataDescriptors(value, label);
}

function assertDenseArray(value: unknown, label: string): asserts value is readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
		fail("array_invalid", `${label} must be an ordinary array.`);
	}
	assertDataDescriptors(value, label);
	if (Reflect.ownKeys(value).some((key) => typeof key === "symbol") || Object.keys(value).length !== value.length)
		fail("sparse_array", `${label} must not be sparse.`);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.some((key) => typeof key === "symbol")) fail("closed_contract", `${label} contains a symbol field.`);
	const actual = ownKeys.filter((key): key is string => typeof key === "string");
	if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
		fail("closed_contract", `${label} violates the closed contract with an unknown or missing field.`);
	}
}

function assertString(value: unknown, label: string, maxBytes: number, allowEmpty = false): asserts value is string {
	if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
		fail("text_invalid", `${label} must be a non-empty string.`);
	}
	if (new TextEncoder().encode(value).byteLength > maxBytes)
		fail("text_too_large", `${label} exceeds its byte bound.`);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
	assertString(value, label, WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes);
}

function assertSafeSectionId(value: unknown, label: string): asserts value is string {
	assertIdentifier(value, label);
	if (value.includes("/") || value.includes("\\") || value === "." || value === "..")
		fail("section_id_invalid", `${label} must be a non-path section identity.`);
}

function assertSafeRelativePath(value: unknown, label: string): asserts value is string {
	assertString(value, label, WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes);
	if (
		value.startsWith("/") ||
		value.startsWith("\\") ||
		value.includes("\\") ||
		value.split("/").some((component) => component.length === 0 || component === "." || component === "..")
	)
		fail("path_traversal", `${label} must be a safe relative path.`);
}

function assertSafeNonNegativeInteger(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		fail("integer_invalid", `${label} must be a non-negative safe integer.`);
	}
}

function assertDigest(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !DIGEST_PATTERN.test(value))
		fail("digest_invalid", `${label} must be a lowercase SHA-256 digest.`);
}

function assertContentType(value: unknown, label: string): asserts value is string {
	assertString(value, label, WORKFLOW_DECISION_PACKET_LIMITS.maxContentTypeBytes);
	if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(value))
		fail("content_type_invalid", `${label} must be a MIME content type.`);
}

function assertLifecycle(value: unknown, label: string): asserts value is WorkflowDecisionPacketLifecycle {
	if (value !== "provisional" && value !== "terminal") fail("lifecycle_invalid", `${label} is unsupported.`);
}

function assertVerifiedArtifactReceipt(
	value: unknown,
	label: string,
	expectedKind: "artifact" | "capability" = "artifact",
): asserts value is WorkflowVerifiedHostReceipt {
	assertPlainRecord(value, label);
	const actual = Reflect.ownKeys(value);
	if (
		actual.some(
			(key) =>
				typeof key !== "string" ||
				(!RECEIPT_REQUIRED_KEYS.includes(key as (typeof RECEIPT_REQUIRED_KEYS)[number]) &&
					key !== "capabilityBinding"),
		) ||
		RECEIPT_REQUIRED_KEYS.some((key) => !actual.includes(key))
	) {
		fail("receipt_closed_contract", `${label} contains unknown or missing receipt fields.`);
	}
	if (value.receiptKind !== expectedKind) fail("receipt_kind_invalid", `${label} must be a ${expectedKind} receipt.`);
	if (typeof value.oneUse !== "boolean") fail("receipt_invalid", `${label}.oneUse must be boolean.`);
	assertIdentifier(value.receiptId, `${label}.receiptId`);
	assertIdentifier(value.issuerId, `${label}.issuerId`);
	assertIdentifier(value.workflowId, `${label}.workflowId`);
	assertDigest(value.bindingDigest, `${label}.bindingDigest`);
	assertDigest(value.payloadDigest, `${label}.payloadDigest`);
	assertArtifactRef(value.artifactRef, `${label}.artifactRef`);
	assertString(value.issuedAt, `${label}.issuedAt`, WORKFLOW_DECISION_PACKET_LIMITS.maxShortTextBytes);
	assertString(value.validUntil, `${label}.validUntil`, WORKFLOW_DECISION_PACKET_LIMITS.maxShortTextBytes);
	assertIdentifier(value.keyId, `${label}.keyId`);
	if (value.signatureAlgorithm !== "ed25519")
		fail("receipt_algorithm_invalid", `${label}.signatureAlgorithm must be ed25519.`);
	assertDigest(value.artifactBytesDigest, `${label}.artifactBytesDigest`);
	assertString(value.stateDigest, `${label}.stateDigest`, WORKFLOW_DECISION_PACKET_LIMITS.maxShortTextBytes);
	assertSafeNonNegativeInteger(value.revision, `${label}.revision`);
	assertString(value.signature, `${label}.signature`, WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes);
	assertDigest(value.verificationDigest, `${label}.verificationDigest`);
	if (value.artifactBytesDigest !== value.artifactRef.digest)
		fail("receipt_artifact_mismatch", `${label}.artifactBytesDigest does not match artifactRef.digest.`);
	if (value.capabilityBinding !== undefined) {
		assertPlainRecord(value.capabilityBinding, `${label}.capabilityBinding`);
		assertExactKeys(
			value.capabilityBinding,
			["capability", "resourceDigest", "operationDigest", "executionIdentity", "sessionId"],
			`${label}.capabilityBinding`,
		);
		assertIdentifier(value.capabilityBinding.capability, `${label}.capabilityBinding.capability`);
		assertDigest(value.capabilityBinding.resourceDigest, `${label}.capabilityBinding.resourceDigest`);
		assertDigest(value.capabilityBinding.operationDigest, `${label}.capabilityBinding.operationDigest`);
		if (value.capabilityBinding.executionIdentity !== null)
			assertIdentifier(value.capabilityBinding.executionIdentity, `${label}.capabilityBinding.executionIdentity`);
		if (value.capabilityBinding.sessionId !== null)
			assertIdentifier(value.capabilityBinding.sessionId, `${label}.capabilityBinding.sessionId`);
	}
}

function assertProducerFence(value: unknown, label: string): asserts value is WorkflowDecisionProducerFence {
	assertPlainRecord(value, label);
	assertExactKeys(value, PRODUCER_FENCE_KEYS, label);
	assertIdentifier(value.generationId, `${label}.generationId`);
	assertEpochRef(value.epochRef, `${label}.epochRef`);
	assertDigest(value.fencingDigest, `${label}.fencingDigest`);
	if (value.fencingDigest !== digestObject({ generationId: value.generationId, epochRef: value.epochRef }))
		fail("producer_fence_mismatch", `${label}.fencingDigest does not cover its generation and epoch.`);
}

function assertTerminalSeal(
	value: unknown,
	label = "terminalSeal",
): asserts value is WorkflowDecisionPacketTerminalSeal {
	assertPlainRecord(value, label);
	assertExactKeys(value, TERMINAL_SEAL_KEYS, label);
	if (value.kind !== "verified_artifact_seal") fail("terminal_seal_kind_invalid", `${label}.kind is unsupported.`);
	assertArtifactRef(value.sealRef, `${label}.sealRef`);
	assertArtifactRef(value.reportRef, `${label}.reportRef`);
	assertSafeNonNegativeInteger(value.reportGeneration, `${label}.reportGeneration`);
	assertDenseArray(value.sectionRefs, `${label}.sectionRefs`);
	if (value.sectionRefs.length > WORKFLOW_DECISION_PACKET_LIMITS.maxSectionRefs)
		fail("count_limit", `${label}.sectionRefs exceeds its count bound.`);
	for (const [index, section] of value.sectionRefs.entries()) {
		assertPlainRecord(section, `${label}.sectionRefs[${index}]`);
		assertExactKeys(section, TERMINAL_SECTION_SEAL_KEYS, `${label}.sectionRefs[${index}]`);
		assertSafeSectionId(section.sectionId, `${label}.sectionRefs[${index}].sectionId`);
		assertSafeNonNegativeInteger(section.generation, `${label}.sectionRefs[${index}].generation`);
		assertArtifactRef(section.artifactRef, `${label}.sectionRefs[${index}].artifactRef`);
		assertDigest(section.digest, `${label}.sectionRefs[${index}].digest`);
		if (section.digest !== section.artifactRef.digest)
			fail("terminal_section_mismatch", `${label}.sectionRefs[${index}] digest does not match its artifact ref.`);
	}
	const sectionIds = (value.sectionRefs as readonly { readonly sectionId: string }[]).map(
		(section) => section.sectionId,
	);
	if (new Set(sectionIds).size !== sectionIds.length)
		fail("duplicate_reference", `${label}.sectionRefs contains duplicate section IDs.`);
	assertPlainRecord(value.producer, `${label}.producer`);
	assertExactKeys(value.producer, TERMINAL_PRODUCER_KEYS, `${label}.producer`);
	assertIdentifier(value.producer.workflowId, `${label}.producer.workflowId`);
	assertIdentifier(value.producer.taskId, `${label}.producer.taskId`);
	assertIdentifier(value.producer.attemptId, `${label}.producer.attemptId`);
	assertEpochRef(value.producer.epochRef, `${label}.producer.epochRef`);
	assertIdentifier(value.producer.outputObligationId, `${label}.producer.outputObligationId`);
	assertProducerFence(value.producer.producerFence, `${label}.producer.producerFence`);
	if (!epochsEqual(value.producer.epochRef, value.producer.producerFence.epochRef))
		fail("producer_fence_mismatch", `${label}.producer fence epoch does not match producer epoch.`);
	assertVerifiedArtifactReceipt(value.receipt, `${label}.receipt`);
	if (!sameJson(value.receipt.artifactRef, value.sealRef))
		fail("terminal_receipt_mismatch", `${label}.receipt.artifactRef does not match sealRef.`);
	if (value.receipt.workflowId !== value.producer.workflowId)
		fail("terminal_receipt_mismatch", `${label}.receipt.workflowId does not match producer workflow.`);
	assertDigest(value.sealDigest, `${label}.sealDigest`);
	const unsigned = { ...value, sealDigest: "" };
	if (digestObject(unsigned) !== value.sealDigest)
		fail("terminal_seal_digest_mismatch", `${label}.sealDigest does not cover the seal.`);
}

function assertEpochRef(value: unknown, label: string): asserts value is WorkflowEpochRef {
	assertPlainRecord(value, label);
	assertExactKeys(value, ["storeEpoch", "coordinatorEpoch"], label);
	assertSafeNonNegativeInteger(value.storeEpoch, `${label}.storeEpoch`);
	assertSafeNonNegativeInteger(value.coordinatorEpoch, `${label}.coordinatorEpoch`);
}

function epochsEqual(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function assertJournalHead(
	value: unknown,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	label: string,
): asserts value is WorkflowJournalHead {
	assertPlainRecord(value, label);
	assertExactKeys(value, ["workflowId", "sequence", "eventDigest", "epochRef"], label);
	assertIdentifier(value.workflowId, `${label}.workflowId`);
	if (value.workflowId !== workflowId) fail("binding_mismatch", `${label}.workflowId does not match workflowId.`);
	assertSafeNonNegativeInteger(value.sequence, `${label}.sequence`);
	if (value.eventDigest !== null) assertDigest(value.eventDigest, `${label}.eventDigest`);
	assertEpochRef(value.epochRef, `${label}.epochRef`);
	if (!epochsEqual(value.epochRef, epochRef)) fail("binding_mismatch", `${label}.epochRef does not match epochRef.`);
}

function assertArtifactRef(value: unknown, label: string): asserts value is WorkflowArtifactRef {
	assertPlainRecord(value, label);
	assertExactKeys(value, ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"], label);
	assertIdentifier(value.artifactId, `${label}.artifactId`);
	assertSafeRelativePath(value.relativePath, `${label}.relativePath`);
	assertDigest(value.digest, `${label}.digest`);
	assertSafeNonNegativeInteger(value.sizeBytes, `${label}.sizeBytes`);
	assertSafeNonNegativeInteger(value.sourceEventSequence, `${label}.sourceEventSequence`);
	if (value.sizeBytes > WORKFLOW_DECISION_PACKET_LIMITS.maxReportBytes)
		fail("artifact_too_large", `${label} exceeds the report size bound.`);
}

function assertStringArray(
	value: unknown,
	label: string,
	maxCount: number,
	maxBytes: number,
): asserts value is readonly string[] {
	assertDenseArray(value, label);
	if (value.length > maxCount) fail("count_limit", `${label} exceeds its count bound.`);
	for (const [index, item] of value.entries()) assertString(item, `${label}[${index}]`, maxBytes);
}

function assertSectionIdArray(value: unknown, label: string, maxCount: number): asserts value is readonly string[] {
	assertDenseArray(value, label);
	if (value.length > maxCount) fail("count_limit", `${label} exceeds its count bound.`);
	for (const [index, item] of value.entries()) assertSafeSectionId(item, `${label}[${index}]`);
}

function assertNoRawBody(value: unknown, path = "packet", seen: WeakSet<object> = new WeakSet<object>()): void {
	if (typeof value !== "object" || value === null) {
		if (value instanceof Uint8Array || value instanceof ArrayBuffer)
			fail("raw_body_forbidden", `${path} contains raw bytes.`);
		return;
	}
	if (seen.has(value)) fail("cycle_forbidden", `${path} contains a cycle.`);
	seen.add(value);
	try {
		if (value instanceof Uint8Array || value instanceof ArrayBuffer)
			fail("raw_body_forbidden", `${path} contains raw bytes.`);
		if (Array.isArray(value)) {
			assertDataDescriptors(value, path);
			if (
				Reflect.ownKeys(value).some((key) => typeof key === "symbol") ||
				Object.keys(value).length !== value.length
			)
				fail("sparse_array", `${path} must not be sparse.`);
			for (const [index, child] of value.entries()) assertNoRawBody(child, `${path}[${index}]`, seen);
			return;
		}
		if (!isPlainRecord(value)) fail("custom_prototype", `${path} has a custom prototype.`);
		assertDataDescriptors(value, path);
		for (const [key, child] of Object.entries(value)) {
			if (FORBIDDEN_PACKET_KEYS.has(key)) fail("raw_body_forbidden", `${path}.${key} is not permitted.`);
			assertNoRawBody(child, `${path}.${key}`, seen);
		}
	} finally {
		seen.delete(value);
	}
}

function freezeDeep<T>(value: T, seen: WeakSet<object> = new WeakSet<object>()): T {
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) freezeDeep(child, seen);
	return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
	return freezeDeep(structuredClone(value));
}

function sameJson(left: unknown, right: unknown): boolean {
	return digestObject(left) === digestObject(right);
}

function safeAdd(left: number, right: number, label: string): number {
	if (
		!Number.isSafeInteger(left) ||
		!Number.isSafeInteger(right) ||
		left < 0 ||
		right < 0 ||
		left > Number.MAX_SAFE_INTEGER - right
	)
		fail("size_overflow", `${label} exceeds the safe integer bound.`);
	return left + right;
}

function packetDigestPreimage(packet: Omit<WorkflowDecisionPacket, "packetDigest">): unknown {
	return { ...packet, packetDigest: "" };
}

function assertPacketDigest(packet: unknown, label: string): void {
	assertPlainRecord(packet, label);
	assertDigest(packet.packetDigest, `${label}.packetDigest`);
	const { packetDigest, ...withoutDigest } = packet;
	if (
		digestObject(packetDigestPreimage(withoutDigest as Omit<WorkflowDecisionPacket, "packetDigest">)) !== packetDigest
	) {
		fail("packet_digest_mismatch", `${label}.packetDigest does not cover the packet.`);
	}
	if (canonicalJsonBytes(packet).byteLength > WORKFLOW_DECISION_PACKET_LIMITS.maxPacketBytes) {
		fail("packet_too_large", `${label} exceeds the packet byte bound.`);
	}
}

function commonPacketInputKeys(): readonly string[] {
	return ["packetId", "workflowId", "taskId", "attemptId", "runtimeVersion", "head", "epochRef"];
}

function assertCommonPacketFields(packet: Record<string, unknown>, label: string): void {
	assertIdentifier(packet.packetId, `${label}.packetId`);
	assertLifecycle(packet.lifecycle, `${label}.lifecycle`);
	assertIdentifier(packet.workflowId, `${label}.workflowId`);
	assertIdentifier(packet.taskId, `${label}.taskId`);
	assertIdentifier(packet.attemptId, `${label}.attemptId`);
	assertWorkflowRuntimeVersion(typeof packet.runtimeVersion === "string" ? packet.runtimeVersion : undefined);
	assertEpochRef(packet.epochRef, `${label}.epochRef`);
	assertJournalHead(packet.head, packet.workflowId, packet.epochRef, `${label}.head`);
	if (packet.schemaVersion !== WORKFLOW_DECISION_PACKET_SCHEMA_VERSION)
		fail("schema_invalid", `${label}.schemaVersion is unsupported.`);
	if (packet.capability !== WORKFLOW_DECISION_PACKET_CAPABILITY)
		fail("capability_required", `${label} lacks the packet-delivery capability.`);
}

function assertBlocker(value: unknown, label: string): asserts value is WorkflowDecisionPacketBlocker {
	assertPlainRecord(value, label);
	assertExactKeys(value, ["blockerId", "findingIds", "summary", "sectionIds", "disposition"], label);
	assertIdentifier(value.blockerId, `${label}.blockerId`);
	assertStringArray(
		value.findingIds,
		`${label}.findingIds`,
		WORKFLOW_DECISION_PACKET_LIMITS.maxFindingsPerBlocker,
		WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
	);
	assertString(value.summary, `${label}.summary`, WORKFLOW_DECISION_PACKET_LIMITS.maxSummaryBytes);
	assertSectionIdArray(value.sectionIds, `${label}.sectionIds`, WORKFLOW_DECISION_PACKET_LIMITS.maxSectionRefs);
	if (value.disposition !== "open" && value.disposition !== "resolved" && value.disposition !== "uncertain") {
		fail("disposition_invalid", `${label}.disposition is unsupported.`);
	}
}

function assertVerdictPacket(value: unknown, label = "verdict"): asserts value is WorkflowDecisionVerdictPacket {
	assertPlainRecord(value, label);
	assertExactKeys(value, VERDICT_PACKET_KEYS, label);
	assertCommonPacketFields(value, label);
	if (value.kind !== "verdict_packet") fail("kind_invalid", `${label}.kind is not verdict_packet.`);
	if (!new Set(["accepted", "rejected", "blocked", "inconclusive"]).has(value.verdict as string))
		fail("verdict_invalid", `${label}.verdict is unsupported.`);
	assertDenseArray(value.topBlockers, `${label}.topBlockers`);
	if (value.topBlockers.length > WORKFLOW_DECISION_PACKET_LIMITS.maxBlockers)
		fail("count_limit", `${label}.topBlockers exceeds its count bound.`);
	for (const [index, blocker] of value.topBlockers.entries()) assertBlocker(blocker, `${label}.topBlockers[${index}]`);
	assertStringArray(
		value.requirementIds,
		`${label}.requirementIds`,
		WORKFLOW_DECISION_PACKET_LIMITS.maxRequirements,
		WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
	);
	assertString(value.confidence, `${label}.confidence`, WORKFLOW_DECISION_PACKET_LIMITS.maxShortTextBytes);
	if (value.confidence !== "high" && value.confidence !== "medium" && value.confidence !== "low")
		fail("confidence_invalid", `${label}.confidence is unsupported.`);
	assertStringArray(
		value.uncertainty,
		`${label}.uncertainty`,
		WORKFLOW_DECISION_PACKET_LIMITS.maxUncertainty,
		WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes,
	);
	if (
		!new Set(["accept", "dispatch_amendment", "selective_expansion", "hold"]).has(value.requiredDisposition as string)
	) {
		fail("disposition_invalid", `${label}.requiredDisposition is unsupported.`);
	}
	if (typeof value.expansionRequired !== "boolean")
		fail("expansion_invalid", `${label}.expansionRequired must be boolean.`);
	assertPacketDigest(value, label);
}

function assertRemediationPacket(
	value: unknown,
	label = "remediation",
): asserts value is WorkflowDecisionRemediationPacket {
	assertPlainRecord(value, label);
	assertExactKeys(value, REMEDIATION_PACKET_KEYS, label);
	assertCommonPacketFields(value, label);
	if (value.kind !== "remediation_packet") fail("kind_invalid", `${label}.kind is not remediation_packet.`);
	assertDenseArray(value.amendments, `${label}.amendments`);
	if (value.amendments.length > WORKFLOW_DECISION_PACKET_LIMITS.maxAmendments)
		fail("count_limit", `${label}.amendments exceeds its count bound.`);
	for (const [index, amendment] of value.amendments.entries()) {
		assertPlainRecord(amendment, `${label}.amendments[${index}]`);
		assertExactKeys(
			amendment,
			["amendmentId", "text", "targetSectionIds", "targetFileRefs"],
			`${label}.amendments[${index}]`,
		);
		assertIdentifier(amendment.amendmentId, `${label}.amendments[${index}].amendmentId`);
		assertString(amendment.text, `${label}.amendments[${index}].text`, WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes);
		assertSectionIdArray(
			amendment.targetSectionIds,
			`${label}.amendments[${index}].targetSectionIds`,
			WORKFLOW_DECISION_PACKET_LIMITS.maxSectionRefs,
		);
		assertStringArray(
			amendment.targetFileRefs,
			`${label}.amendments[${index}].targetFileRefs`,
			WORKFLOW_DECISION_PACKET_LIMITS.maxWriteScope,
			WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes,
		);
		for (const path of amendment.targetFileRefs)
			assertSafeRelativePath(path, `${label}.amendments[${index}].targetFileRefs`);
	}
	assertStringArray(
		value.dependencies,
		`${label}.dependencies`,
		WORKFLOW_DECISION_PACKET_LIMITS.maxDependencies,
		WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
	);
	assertPlainRecord(value.ownership, `${label}.ownership`);
	assertExactKeys(value.ownership, ["owner", "writeScope"], `${label}.ownership`);
	assertIdentifier(value.ownership.owner, `${label}.ownership.owner`);
	assertStringArray(
		value.ownership.writeScope,
		`${label}.ownership.writeScope`,
		WORKFLOW_DECISION_PACKET_LIMITS.maxWriteScope,
		WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes,
	);
	for (const path of value.ownership.writeScope) assertSafeRelativePath(path, `${label}.ownership.writeScope`);
	assertString(value.requiredNextAction, `${label}.requiredNextAction`, WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes);
	assertDenseArray(value.publicAcceptanceChecks, `${label}.publicAcceptanceChecks`);
	if (value.publicAcceptanceChecks.length > WORKFLOW_DECISION_PACKET_LIMITS.maxAcceptanceChecks)
		fail("count_limit", `${label}.publicAcceptanceChecks exceeds its count bound.`);
	for (const [index, check] of value.publicAcceptanceChecks.entries()) {
		assertPlainRecord(check, `${label}.publicAcceptanceChecks[${index}]`);
		assertExactKeys(check, ["checkId", "publicBoundary", "description"], `${label}.publicAcceptanceChecks[${index}]`);
		assertIdentifier(check.checkId, `${label}.publicAcceptanceChecks[${index}].checkId`);
		assertString(
			check.publicBoundary,
			`${label}.publicAcceptanceChecks[${index}].publicBoundary`,
			WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
		);
		assertString(
			check.description,
			`${label}.publicAcceptanceChecks[${index}].description`,
			WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes,
		);
	}
	assertDenseArray(value.blockerClosureMapping, `${label}.blockerClosureMapping`);
	if (value.blockerClosureMapping.length > WORKFLOW_DECISION_PACKET_LIMITS.maxClosureMappings)
		fail("count_limit", `${label}.blockerClosureMapping exceeds its count bound.`);
	for (const [index, mapping] of value.blockerClosureMapping.entries()) {
		assertPlainRecord(mapping, `${label}.blockerClosureMapping[${index}]`);
		assertExactKeys(
			mapping,
			["blockerId", "amendmentIds", "requiredEvidenceSectionIds"],
			`${label}.blockerClosureMapping[${index}]`,
		);
		assertIdentifier(mapping.blockerId, `${label}.blockerClosureMapping[${index}].blockerId`);
		assertStringArray(
			mapping.amendmentIds,
			`${label}.blockerClosureMapping[${index}].amendmentIds`,
			WORKFLOW_DECISION_PACKET_LIMITS.maxAmendments,
			WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
		);
		assertSectionIdArray(
			mapping.requiredEvidenceSectionIds,
			`${label}.blockerClosureMapping[${index}].requiredEvidenceSectionIds`,
			WORKFLOW_DECISION_PACKET_LIMITS.maxSectionRefs,
		);
	}
	assertDenseArray(value.requirementClosureMapping, `${label}.requirementClosureMapping`);
	if (value.requirementClosureMapping.length > WORKFLOW_DECISION_PACKET_LIMITS.maxClosureMappings)
		fail("count_limit", `${label}.requirementClosureMapping exceeds its count bound.`);
	for (const [index, mapping] of value.requirementClosureMapping.entries()) {
		assertPlainRecord(mapping, `${label}.requirementClosureMapping[${index}]`);
		assertExactKeys(
			mapping,
			["requirementId", "amendmentIds", "blockedAction"],
			`${label}.requirementClosureMapping[${index}]`,
		);
		assertIdentifier(mapping.requirementId, `${label}.requirementClosureMapping[${index}].requirementId`);
		assertStringArray(
			mapping.amendmentIds,
			`${label}.requirementClosureMapping[${index}].amendmentIds`,
			WORKFLOW_DECISION_PACKET_LIMITS.maxAmendments,
			WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
		);
		if (mapping.blockedAction !== null)
			assertString(
				mapping.blockedAction,
				`${label}.requirementClosureMapping[${index}].blockedAction`,
				WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes,
			);
		if (mapping.amendmentIds.length === 0 && mapping.blockedAction === null)
			fail(
				"requirement_closure_invalid",
				`${label}.requirementClosureMapping[${index}] needs an amendment or blocked action.`,
			);
	}
	assertPacketDigest(value, label);
}

function assertSectionRef(
	value: unknown,
	label: string,
	fullReportSizeBytes: number,
): asserts value is WorkflowDecisionEvidenceSectionRef {
	assertPlainRecord(value, label);
	assertExactKeys(
		value,
		[
			"sectionId",
			"ordinal",
			"title",
			"startOffset",
			"endOffset",
			"artifactRef",
			"digest",
			"sizeBytes",
			"sourceEventSequence",
			"contentType",
		],
		label,
	);
	assertSafeSectionId(value.sectionId, `${label}.sectionId`);
	assertSafeNonNegativeInteger(value.ordinal, `${label}.ordinal`);
	assertString(value.title, `${label}.title`, WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes);
	assertSafeNonNegativeInteger(value.startOffset, `${label}.startOffset`);
	assertSafeNonNegativeInteger(value.endOffset, `${label}.endOffset`);
	if (value.endOffset < value.startOffset || value.endOffset > fullReportSizeBytes)
		fail("section_offset_invalid", `${label} has invalid report offsets.`);
	assertArtifactRef(value.artifactRef, `${label}.artifactRef`);
	assertDigest(value.digest, `${label}.digest`);
	assertSafeNonNegativeInteger(value.sizeBytes, `${label}.sizeBytes`);
	assertSafeNonNegativeInteger(value.sourceEventSequence, `${label}.sourceEventSequence`);
	if (
		value.digest !== value.artifactRef.digest ||
		value.sizeBytes !== value.artifactRef.sizeBytes ||
		value.sourceEventSequence !== value.artifactRef.sourceEventSequence
	) {
		fail("section_reference_mismatch", `${label} repeats reference fields inconsistently.`);
	}
	if (value.sizeBytes !== value.endOffset - value.startOffset)
		fail("section_offset_invalid", `${label} size does not match its offsets.`);
	assertContentType(value.contentType, `${label}.contentType`);
}

function assertEvidenceManifest(
	value: unknown,
	label = "evidenceManifest",
): asserts value is WorkflowDecisionEvidenceManifest {
	assertPlainRecord(value, label);
	assertExactKeys(value, EVIDENCE_MANIFEST_KEYS, label);
	assertCommonPacketFields(value, label);
	if (value.kind !== "evidence_manifest") fail("kind_invalid", `${label}.kind is not evidence_manifest.`);
	assertArtifactRef(value.fullReportRef, `${label}.fullReportRef`);
	assertContentType(value.fullReportContentType, `${label}.fullReportContentType`);
	assertDenseArray(value.sectionRefs, `${label}.sectionRefs`);
	if (value.sectionRefs.length > WORKFLOW_DECISION_PACKET_LIMITS.maxSectionRefs)
		fail("count_limit", `${label}.sectionRefs exceeds its count bound.`);
	let priorEndOffset = 0;
	for (const [index, section] of value.sectionRefs.entries()) {
		assertSectionRef(section, `${label}.sectionRefs[${index}]`, value.fullReportRef.sizeBytes);
		if (section.ordinal !== index)
			fail("section_order_invalid", `${label}.sectionRefs must have contiguous ordinals.`);
		if (section.startOffset < priorEndOffset)
			fail("section_order_invalid", `${label}.sectionRefs overlap or are reordered.`);
		priorEndOffset = section.endOffset;
	}
	const sectionIds = (value.sectionRefs as readonly WorkflowDecisionEvidenceSectionRef[]).map(
		(section) => section.sectionId,
	);
	if (new Set(sectionIds).size !== sectionIds.length)
		fail("duplicate_reference", `${label}.sectionRefs contains duplicate section IDs.`);
	assertPacketDigest(value, label);
}

function assertPacket(value: unknown, label: string): asserts value is WorkflowDecisionPacket {
	assertPlainRecord(value, label);
	assertNoRawBody(value, label);
	if (value.kind === "verdict_packet") assertVerdictPacket(value, label);
	else if (value.kind === "remediation_packet") assertRemediationPacket(value, label);
	else if (value.kind === "evidence_manifest") assertEvidenceManifest(value, label);
	else fail("kind_invalid", `${label}.kind is not a closed packet kind.`);
}

function createPacket<T extends WorkflowDecisionPacket>(packet: Omit<T, "packetDigest">): T {
	assertNoRawBody(packet);
	const digest = digestObject(packetDigestPreimage(packet as Omit<WorkflowDecisionPacket, "packetDigest">));
	const completed = { ...packet, packetDigest: digest } as T;
	/* Validate metadata and size before structuredClone can copy an oversized manifest. */
	assertPacket(completed, "packet");
	const serializedBytes = canonicalJsonBytes(completed);
	if (serializedBytes.byteLength > WORKFLOW_DECISION_PACKET_LIMITS.maxPacketBytes)
		fail("packet_too_large", "packet exceeds the packet byte bound.");
	return cloneAndFreeze(completed);
}

function assertPacketInputWithOptionalLifecycle(
	value: unknown,
	expected: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	assertPlainRecord(value, label);
	assertNoRawBody(value, label);
	const actual = Reflect.ownKeys(value);
	if (
		actual.some((key) => typeof key !== "string" || (!expected.includes(key) && key !== "lifecycle")) ||
		expected.some((key) => !actual.includes(key))
	) {
		fail("closed_contract", `${label} violates the closed contract with an unknown or missing field.`);
	}
	if (Object.hasOwn(value, "lifecycle") && value.lifecycle !== undefined)
		assertLifecycle(value.lifecycle, `${label}.lifecycle`);
}

function assertPacketInputBinding(input: Record<string, unknown>, label: string): void {
	assertIdentifier(input.packetId, `${label}.packetId`);
	assertIdentifier(input.workflowId, `${label}.workflowId`);
	assertIdentifier(input.taskId, `${label}.taskId`);
	assertIdentifier(input.attemptId, `${label}.attemptId`);
	if (input.lifecycle !== undefined) assertLifecycle(input.lifecycle, `${label}.lifecycle`);
	assertWorkflowRuntimeVersion(typeof input.runtimeVersion === "string" ? input.runtimeVersion : undefined);
	assertEpochRef(input.epochRef, `${label}.epochRef`);
	assertJournalHead(input.head, input.workflowId, input.epochRef, `${label}.head`);
}

function normalizeExpectedSet(value: WorkflowDecisionPacketExpectedSet): WorkflowDecisionPacketExpectedSet {
	assertPlainRecord(value, "host expected set");
	assertExactKeys(value, ["blockers", "requirementIds"], "host expected set");
	assertDenseArray(value.blockers, "host expected set.blockers");
	if (value.blockers.length > WORKFLOW_DECISION_PACKET_LIMITS.maxBlockers)
		fail("count_limit", "host blocker set exceeds its count bound.");
	for (const [index, blocker] of value.blockers.entries()) {
		assertPlainRecord(blocker, `host expected set.blockers[${index}]`);
		assertExactKeys(
			blocker,
			["blockerId", "findingIds", "requiredSectionIds"],
			`host expected set.blockers[${index}]`,
		);
		assertIdentifier(blocker.blockerId, `host expected set.blockers[${index}].blockerId`);
		assertStringArray(
			blocker.findingIds,
			`host expected set.blockers[${index}].findingIds`,
			WORKFLOW_DECISION_PACKET_LIMITS.maxFindingsPerBlocker,
			WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
		);
		assertSectionIdArray(
			blocker.requiredSectionIds,
			`host expected set.blockers[${index}].requiredSectionIds`,
			WORKFLOW_DECISION_PACKET_LIMITS.maxSectionRefs,
		);
		if (blocker.requiredSectionIds.length === 0)
			fail("host_registry_invalid", `Host expected blocker ${blocker.blockerId} must declare required sections.`);
		if (new Set(blocker.requiredSectionIds).size !== blocker.requiredSectionIds.length)
			fail("duplicate_reference", `Host expected blocker ${blocker.blockerId} repeats required sections.`);
	}
	assertStringArray(
		value.requirementIds,
		"host expected set.requirementIds",
		WORKFLOW_DECISION_PACKET_LIMITS.maxRequirements,
		WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
	);
	const blockerIds = value.blockers.map((blocker) => blocker.blockerId);
	if (new Set(blockerIds).size !== blockerIds.length)
		fail("duplicate_reference", "host expected blocker set contains duplicate IDs.");
	if (new Set(value.requirementIds).size !== value.requirementIds.length)
		fail("duplicate_reference", "host expected requirement set contains duplicate IDs.");
	return cloneAndFreeze(value);
}

function assertCurrentBinding(input: WorkflowDecisionPacketCurrentBinding): void {
	assertIdentifier(input.workflowId, "currentBinding.workflowId");
	assertIdentifier(input.taskId, "currentBinding.taskId");
	assertIdentifier(input.attemptId, "currentBinding.attemptId");
	assertEpochRef(input.epochRef, "currentBinding.epochRef");
	assertJournalHead(input.head, input.workflowId, input.epochRef, "currentBinding.head");
	if (input.runtimeVersion !== undefined) assertWorkflowRuntimeVersion(input.runtimeVersion);
}

function assertSamePacketBinding(packets: WorkflowDecisionPacketTriad): void {
	const binding = packets.verdict;
	for (const packet of [packets.remediation, packets.evidenceManifest]) {
		if (
			packet.workflowId !== binding.workflowId ||
			packet.taskId !== binding.taskId ||
			packet.attemptId !== binding.attemptId ||
			packet.runtimeVersion !== binding.runtimeVersion ||
			!epochsEqual(packet.epochRef, binding.epochRef) ||
			!sameJson(packet.head, binding.head)
		) {
			fail("binding_mismatch", "Decision packets do not share one workflow/task/attempt/head/epoch binding.");
		}
	}
}

function normalizeTriad(value: unknown): WorkflowDecisionPacketTriad {
	assertPlainRecord(value, "packet triad");
	assertNoRawBody(value, "packet triad");
	assertExactKeys(value, TRIAD_KEYS, "packet triad");
	assertVerdictPacket(value.verdict, "packet triad.verdict");
	assertRemediationPacket(value.remediation, "packet triad.remediation");
	assertEvidenceManifest(value.evidenceManifest, "packet triad.evidenceManifest");
	assertLifecycle(value.lifecycle, "packet triad.lifecycle");
	if (
		value.lifecycle !== value.verdict.lifecycle ||
		value.lifecycle !== value.remediation.lifecycle ||
		value.lifecycle !== value.evidenceManifest.lifecycle
	)
		fail("lifecycle_mismatch", "Decision packets in one triad must share one lifecycle.");
	if (value.lifecycle === "terminal") {
		if (value.terminalSeal === null)
			fail("terminal_seal_required", "Terminal packet triads require a verified artifact seal.");
		assertTerminalSeal(value.terminalSeal, "packet triad.terminalSeal");
	} else if (value.terminalSeal !== null) {
		fail("terminal_seal_unexpected", "Provisional packet triads cannot carry a terminal seal.");
	}
	if (value.supersedesPacketDigest !== null)
		assertDigest(value.supersedesPacketDigest, "packet triad.supersedesPacketDigest");
	const packets = value as unknown as WorkflowDecisionPacketTriad;
	assertSamePacketBinding(packets);
	if (packets.terminalSeal !== null) assertTerminalSealMatchesManifest(packets.terminalSeal, packets);
	assertDigest(value.packetDigest, "packet triad.packetDigest");
	assertSafeNonNegativeInteger(value.packetBytes, "packet triad.packetBytes");
	let packetBytes = canonicalJsonBytes(value.verdict).byteLength;
	packetBytes = safeAdd(packetBytes, canonicalJsonBytes(value.remediation).byteLength, "packet triad bytes");
	packetBytes = safeAdd(packetBytes, canonicalJsonBytes(value.evidenceManifest).byteLength, "packet triad bytes");
	packetBytes = safeAdd(
		packetBytes,
		value.terminalSeal === null ? 0 : canonicalJsonBytes(value.terminalSeal).byteLength,
		"packet triad bytes",
	);
	if (value.packetBytes !== packetBytes) fail("packet_size_mismatch", "packet triad packetBytes is not exact.");
	if (packetBytes > WORKFLOW_DECISION_PACKET_LIMITS.maxTriadBytes)
		fail("packet_too_large", "packet triad exceeds the session-message bound.");
	const unsigned = {
		kind: "workflow_decision_packet_triad",
		schemaVersion: WORKFLOW_DECISION_PACKET_SCHEMA_VERSION,
		lifecycle: value.lifecycle,
		supersedesPacketDigest: value.supersedesPacketDigest,
		packetDigests: [value.verdict.packetDigest, value.remediation.packetDigest, value.evidenceManifest.packetDigest],
		terminalSeal: value.terminalSeal,
	};
	if (digestObject(unsigned) !== value.packetDigest)
		fail("packet_digest_mismatch", "packet triad digest is forged or stale.");
	if (canonicalJsonBytes(value).byteLength > WORKFLOW_DECISION_PACKET_LIMITS.maxTriadBytes)
		fail("packet_too_large", "packet triad exceeds the session-message bound including framing headroom.");
	return cloneAndFreeze(value as unknown as WorkflowDecisionPacketTriad);
}

function assertSectionIdsDeclared(
	manifest: WorkflowDecisionEvidenceManifest,
	sectionIds: readonly string[],
): readonly WorkflowDecisionEvidenceSectionRef[] {
	assertSectionIdArray(sectionIds, "sectionIds", WORKFLOW_DECISION_PACKET_LIMITS.maxSelectedSections);
	if (new Set(sectionIds).size !== sectionIds.length) fail("duplicate_reference", "sectionIds contains duplicates.");
	const declared = new Map(manifest.sectionRefs.map((section) => [section.sectionId, section]));
	const ordered = manifest.sectionRefs.filter((section) => sectionIds.includes(section.sectionId));
	if (
		ordered.length !== sectionIds.length ||
		ordered.some((section, index) => section.sectionId !== sectionIds[index])
	) {
		fail("section_not_declared", "Selective expansion must request declared sections in manifest order.");
	}
	for (const sectionId of sectionIds)
		if (!declared.has(sectionId)) fail("section_not_declared", `Section ${sectionId} is not declared.`);
	return ordered;
}

function assertResolvedSection(
	resolved: WorkflowArtifactReadResult,
	section: WorkflowDecisionEvidenceSectionRef,
): Uint8Array {
	assertPlainRecord(resolved.envelope, `section ${section.sectionId}.envelope`);
	assertExactKeys(
		resolved.envelope,
		["ref", "payloadKind", "codec", "immutable"],
		`section ${section.sectionId}.envelope`,
	);
	assertArtifactRef(resolved.envelope.ref, `section ${section.sectionId}.envelope.ref`);
	if (
		!resolved.exists ||
		(resolved.envelope.payloadKind !== "evidence" && resolved.envelope.payloadKind !== "handoff") ||
		resolved.envelope.codec !== "utf8" ||
		resolved.envelope.immutable !== true
	) {
		fail("artifact_invalid", `Section ${section.sectionId} is not an immutable UTF-8 evidence artifact.`);
	}
	if (
		!sameJson(resolved.envelope.ref, section.artifactRef) ||
		resolved.verifiedDigest !== section.digest ||
		resolved.verifiedSizeBytes !== section.sizeBytes
	) {
		fail("artifact_reference_mismatch", `Section ${section.sectionId} does not resolve to its declared reference.`);
	}
	if (!(resolved.bytes instanceof Uint8Array))
		fail("artifact_invalid", `Section ${section.sectionId} bytes are not a byte array.`);
	const bytes = Uint8Array.from(resolved.bytes);
	if (bytes.byteLength !== section.sizeBytes || sha256Hex(bytes) !== section.digest)
		fail("artifact_digest_mismatch", `Section ${section.sectionId} bytes are forged or stale.`);
	if (bytes.byteLength > WORKFLOW_DECISION_PACKET_LIMITS.maxSectionBytes)
		fail("section_too_large", `Section ${section.sectionId} exceeds the selective expansion bound.`);
	return bytes;
}

async function resolveExactArtifact(
	resolver: WorkflowArtifactResolver,
	ref: WorkflowArtifactRef,
	label: string,
	allowedPayloadKinds: readonly ("evidence" | "handoff")[],
	allowedCodecs: readonly ("utf8" | "canonical_json")[],
	maxBytes: number,
): Promise<Uint8Array> {
	const resolved = await resolver.resolve(ref);
	assertPlainRecord(resolved, `${label}.resolved`);
	assertPlainRecord(resolved.envelope, `${label}.envelope`);
	assertExactKeys(resolved.envelope, ["ref", "payloadKind", "codec", "immutable"], `${label}.envelope`);
	assertArtifactRef(resolved.envelope.ref, `${label}.envelope.ref`);
	if (
		resolved.exists !== true ||
		resolved.envelope.immutable !== true ||
		!allowedPayloadKinds.includes(resolved.envelope.payloadKind as (typeof allowedPayloadKinds)[number]) ||
		!allowedCodecs.includes(resolved.envelope.codec as (typeof allowedCodecs)[number])
	)
		fail("artifact_invalid", `${label} is not an immutable host evidence artifact.`);
	if (
		!sameJson(resolved.envelope.ref, ref) ||
		resolved.verifiedDigest !== ref.digest ||
		resolved.verifiedSizeBytes !== ref.sizeBytes
	)
		fail("artifact_reference_mismatch", `${label} does not resolve to its declared artifact reference.`);
	if (!(resolved.bytes instanceof Uint8Array)) fail("artifact_invalid", `${label} did not return bytes.`);
	if (resolved.bytes.byteLength !== ref.sizeBytes || sha256Hex(resolved.bytes) !== ref.digest)
		fail("artifact_digest_mismatch", `${label} bytes are forged or stale.`);
	if (resolved.bytes.byteLength > maxBytes) fail("artifact_too_large", `${label} exceeds its host read bound.`);
	return Uint8Array.from(resolved.bytes);
}

async function assertDurableCurrent(
	authority: WorkflowDecisionPacketHostAuthority,
	binding: WorkflowDecisionPacketCurrentBinding,
): Promise<void> {
	const durable = authority.runtimeStore.durableContext;
	if (durable === undefined)
		fail("durable_host_required", "Decision packet delivery requires a persisted runtime context.");
	if (!epochsEqual(durable.epochRef, binding.epochRef))
		fail("stale_epoch", "Decision packet epoch is not the active persisted epoch.");
	const lease = durable.currentLeaseRef();
	if (!epochsEqual(lease, durable.epochRef)) fail("stale_epoch", "Decision packet lease epoch is stale.");
	const replay = await authority.runtimeStore.replay({
		workflowId: binding.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: binding.epochRef.storeEpoch,
	});
	if (replay.workflowId !== binding.workflowId || replay.quarantined || !sameJson(replay.head, binding.head))
		fail("stale_head", "Decision packet head is not the persisted current journal head.");
}

function validateRemediationClosure(
	verdict: WorkflowDecisionVerdictPacket,
	remediation: WorkflowDecisionRemediationPacket,
	expected: WorkflowDecisionPacketExpectedSet,
	manifest: WorkflowDecisionEvidenceManifest,
): void {
	const amendments = new Map<string, WorkflowDecisionRemediationAmendment>();
	for (const amendment of remediation.amendments) {
		if (amendments.has(amendment.amendmentId))
			fail("duplicate_reference", "Remediation amendments contain duplicate IDs.");
		if (amendment.targetSectionIds.length === 0 && amendment.targetFileRefs.length === 0)
			fail("amendment_actionable_required", `Amendment ${amendment.amendmentId} has no target scope.`);
		for (const path of amendment.targetFileRefs) assertSafeRelativePath(path, "remediation amendment targetFileRefs");
		amendments.set(amendment.amendmentId, amendment);
	}
	const manifestSectionIds = new Set(manifest.sectionRefs.map((section) => section.sectionId));
	const blockerMappings = new Map<string, WorkflowDecisionRemediationPacket["blockerClosureMapping"][number]>();
	for (const mapping of remediation.blockerClosureMapping) {
		if (blockerMappings.has(mapping.blockerId))
			fail("duplicate_reference", "Blocker closure mapping contains duplicate IDs.");
		blockerMappings.set(mapping.blockerId, mapping);
		for (const amendmentId of mapping.amendmentIds)
			if (!amendments.has(amendmentId)) fail("amendment_reference_invalid", `Unknown amendment ${amendmentId}.`);
		for (const sectionId of mapping.requiredEvidenceSectionIds)
			if (!manifestSectionIds.has(sectionId)) fail("section_not_declared", `Unknown closure section ${sectionId}.`);
	}
	for (const expectedBlocker of expected.blockers) {
		const mapping = blockerMappings.get(expectedBlocker.blockerId);
		if (mapping === undefined)
			fail("blocker_closure_missing", `Remediation does not close blocker ${expectedBlocker.blockerId}.`);
		if (!sameJson(mapping.requiredEvidenceSectionIds, expectedBlocker.requiredSectionIds))
			fail(
				"blocker_section_closure_invalid",
				`Remediation section closure for ${expectedBlocker.blockerId} is not exact.`,
			);
	}
	const expectedBlockerIds = new Set(expected.blockers.map((blocker) => blocker.blockerId));
	for (const mapping of remediation.blockerClosureMapping)
		if (!expectedBlockerIds.has(mapping.blockerId))
			fail("blocker_closure_invalid", `Unknown blocker ${mapping.blockerId}.`);

	const requirementMappings = new Map<
		string,
		WorkflowDecisionRemediationPacket["requirementClosureMapping"][number]
	>();
	for (const mapping of remediation.requirementClosureMapping) {
		if (requirementMappings.has(mapping.requirementId))
			fail("duplicate_reference", "Requirement closure mapping contains duplicate IDs.");
		requirementMappings.set(mapping.requirementId, mapping);
		for (const amendmentId of mapping.amendmentIds)
			if (!amendments.has(amendmentId)) fail("amendment_reference_invalid", `Unknown amendment ${amendmentId}.`);
	}
	const expectedRequirements = new Set(expected.requirementIds);
	for (const requirementId of requirementMappings.keys())
		if (!expectedRequirements.has(requirementId))
			fail("requirement_closure_invalid", `Unknown requirement ${requirementId}.`);
	if (verdict.verdict === "rejected" || verdict.requiredDisposition === "dispatch_amendment") {
		for (const requirementId of expected.requirementIds) {
			const mapping = requirementMappings.get(requirementId);
			if (mapping === undefined || (mapping.amendmentIds.length === 0 && mapping.blockedAction === null))
				fail(
					"requirement_closure_missing",
					`Requirement ${requirementId} lacks an actionable amendment or blocked action.`,
				);
		}
	}
}

async function verifyTerminalSealAtHost(
	authority: WorkflowDecisionPacketHostAuthority,
	seal: WorkflowDecisionPacketTerminalSeal,
	packets: WorkflowDecisionPacketTriad,
	binding: WorkflowDecisionPacketCurrentBinding,
): Promise<void> {
	const durable = authority.runtimeStore.durableContext;
	if (durable === undefined)
		fail("durable_host_required", "Terminal seal verification requires persisted runtime context.");
	if (seal.producer.producerFence.generationId !== durable.generationId)
		fail("generation_mismatch", "Terminal seal producer fence is not the active persisted generation.");
	if (authority.expectedReportGeneration === null)
		fail("generation_authority_required", "Terminal seal delivery requires the host report generation authority.");
	if (seal.reportGeneration !== authority.expectedReportGeneration)
		fail("generation_mismatch", "Terminal report generation is stale.");
	for (const section of seal.sectionRefs) {
		const expectedGeneration = authority.expectedSectionGenerations[section.sectionId];
		if (expectedGeneration === undefined)
			fail(
				"generation_authority_required",
				`Terminal seal lacks host generation authority for ${section.sectionId}.`,
			);
		if (section.generation !== expectedGeneration)
			fail("generation_mismatch", `Terminal section generation is stale for ${section.sectionId}.`);
	}
	const sealBytes = await resolveExactArtifact(
		authority.artifactResolver,
		seal.sealRef,
		"terminal seal",
		["evidence", "handoff"],
		["utf8", "canonical_json"],
		WORKFLOW_DECISION_PACKET_LIMITS.maxPacketBytes,
	);
	await resolveExactArtifact(
		authority.artifactResolver,
		seal.reportRef,
		"terminal report",
		["evidence", "handoff"],
		["utf8", "canonical_json"],
		WORKFLOW_DECISION_PACKET_LIMITS.maxReportBytes,
	);
	for (const section of seal.sectionRefs)
		await resolveExactArtifact(
			authority.artifactResolver,
			section.artifactRef,
			`terminal section ${section.sectionId}`,
			["evidence", "handoff"],
			["utf8"],
			WORKFLOW_DECISION_PACKET_LIMITS.maxSectionBytes,
		);
	if (authority.receiptContext === null)
		fail("terminal_seal_verification_required", "Terminal delivery requires the host receipt verification context.");
	const verifiedReceipt = await authority.receiptContext.receiptResolver.resolve({
		receipt: seal.receipt,
		workflowId: binding.workflowId,
		expectedBindingDigest: seal.receipt.bindingDigest,
		artifactBytes: sealBytes,
		currentStateDigest: authority.stateDigest,
		currentRevision: authority.revision,
		trustedNow: seal.receipt.issuedAt,
		keyResolver: authority.receiptContext.keyResolver,
		revokedReceiptIds: authority.receiptContext.revokedReceiptIds,
	});
	if (!sameJson(verifiedReceipt, seal.receipt))
		fail("terminal_receipt_mismatch", "Host receipt verification changed the terminal seal receipt.");
	if (packets.evidenceManifest.fullReportRef.digest !== seal.reportRef.digest)
		fail("terminal_report_mismatch", "Terminal report digest is not bound to the evidence manifest.");
}

async function verifyDeclaredManifestSections(
	authority: WorkflowDecisionPacketHostAuthority,
	manifest: WorkflowDecisionEvidenceManifest,
): Promise<void> {
	for (const section of manifest.sectionRefs)
		await resolveExactArtifact(
			authority.artifactResolver,
			section.artifactRef,
			`manifest section ${section.sectionId}`,
			["evidence", "handoff"],
			["utf8"],
			WORKFLOW_DECISION_PACKET_LIMITS.maxSectionBytes,
		);
}

function normalizeCorrection(
	value: WorkflowDecisionSynthesisRemediationCorrection,
	sectionIds: readonly string[],
): WorkflowDecisionSynthesisRemediationCorrection {
	assertPlainRecord(value, "synthesis correction");
	assertExactKeys(
		value,
		["kind", "sectionIds", "blockerIds", "summary", "requiredNextAction", "correctionDigest"],
		"synthesis correction",
	);
	if (value.kind !== "synthesis_remediation_correction")
		fail("correction_invalid", "Synthesis correction kind is unsupported.");
	assertStringArray(
		value.sectionIds,
		"synthesis correction.sectionIds",
		WORKFLOW_DECISION_PACKET_LIMITS.maxSelectedSections,
		WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
	);
	if (!sameJson(value.sectionIds, sectionIds))
		fail("correction_binding_mismatch", "Synthesis correction section IDs do not match the expansion.");
	assertStringArray(
		value.blockerIds,
		"synthesis correction.blockerIds",
		WORKFLOW_DECISION_PACKET_LIMITS.maxBlockers,
		WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
	);
	assertString(value.summary, "synthesis correction.summary", WORKFLOW_DECISION_PACKET_LIMITS.maxSummaryBytes);
	assertString(
		value.requiredNextAction,
		"synthesis correction.requiredNextAction",
		WORKFLOW_DECISION_PACKET_LIMITS.maxTextBytes,
	);
	assertDigest(value.correctionDigest, "synthesis correction.correctionDigest");
	const unsigned = { ...value, correctionDigest: "" };
	if (digestObject(unsigned) !== value.correctionDigest)
		fail("correction_digest_mismatch", "Synthesis correction digest is forged or stale.");
	return cloneAndFreeze(value);
}

function assertLensIdentity(value: unknown, label: string): asserts value is WorkflowDecisionLensIdentity {
	assertPlainRecord(value, label);
	assertExactKeys(value, ["lensId", "contradictionId"], label);
	assertIdentifier(value.lensId, `${label}.lensId`);
	assertIdentifier(value.contradictionId, `${label}.contradictionId`);
}

function assertContradictionPlan(
	value: unknown,
	label = "hostContradictionPlan",
): asserts value is WorkflowDecisionHostContradictionPlan {
	assertPlainRecord(value, label);
	assertExactKeys(value, ["planId", "disputedSectionIds", "lensIdentities", "maxSectionCount", "planDigest"], label);
	assertIdentifier(value.planId, `${label}.planId`);
	assertSectionIdArray(
		value.disputedSectionIds,
		`${label}.disputedSectionIds`,
		WORKFLOW_DECISION_PACKET_LIMITS.maxSelectedSections,
	);
	if (value.disputedSectionIds.length === 0)
		fail("conflict_scope_invalid", `${label} must declare a disputed section.`);
	assertSafeNonNegativeInteger(value.maxSectionCount, `${label}.maxSectionCount`);
	if (value.maxSectionCount !== value.disputedSectionIds.length)
		fail("conflict_scope_invalid", `${label}.maxSectionCount does not match disputed sections.`);
	assertDenseArray(value.lensIdentities, `${label}.lensIdentities`);
	if (value.lensIdentities.length < 2 || value.lensIdentities.length > 25)
		fail("lens_identity_invalid", `${label}.lensIdentities must model two through twenty-five lenses.`);
	for (const [index, identity] of value.lensIdentities.entries())
		assertLensIdentity(identity, `${label}.lensIdentities[${index}]`);
	const lensIdentities = value.lensIdentities as readonly WorkflowDecisionLensIdentity[];
	if (new Set(lensIdentities.map((identity) => identity.lensId)).size !== lensIdentities.length)
		fail("lens_identity_invalid", `${label}.lensIdentities must have distinct lens IDs.`);
	assertDigest(value.planDigest, `${label}.planDigest`);
	const unsigned = { ...value, planDigest: "" };
	if (digestObject(unsigned) !== value.planDigest)
		fail("conflict_plan_digest_mismatch", `${label}.planDigest is forged or stale.`);
}

const HOST_AUTHORITY_RECORD = "workflow-decision-packet-authority.json";
const HOST_PUBLICATION_RECORD = "workflow-decision-packet-publication.json";

function assertPublicationRecord(value: unknown): asserts value is Record<string, unknown> {
	assertPlainRecord(value, "persisted packet publication");
	assertExactKeys(
		value,
		[
			"version",
			"packetDigest",
			"lifecycle",
			"supersedesPacketDigest",
			"workflowId",
			"taskId",
			"attemptId",
			"artifactRef",
		],
		"persisted packet publication",
	);
	if (value.version !== 1) fail("publication_record_invalid", "Persisted packet publication version is unsupported.");
	assertDigest(value.packetDigest, "persisted packet publication.packetDigest");
	assertLifecycle(value.lifecycle, "persisted packet publication.lifecycle");
	if (value.supersedesPacketDigest !== null)
		assertDigest(value.supersedesPacketDigest, "persisted packet publication.supersedesPacketDigest");
	assertIdentifier(value.workflowId, "persisted packet publication.workflowId");
	assertIdentifier(value.taskId, "persisted packet publication.taskId");
	assertIdentifier(value.attemptId, "persisted packet publication.attemptId");
	assertArtifactRef(value.artifactRef, "persisted packet publication.artifactRef");
}

export interface WorkflowDecisionPacketHostAuthorityInput {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly principalAuthorizer: WorkflowHostPrincipalCapabilityAuthorizer;
	readonly registry: WorkflowDecisionPacketHostRegistry;
	readonly capabilityReceipt: WorkflowVerifiedHostReceipt;
	readonly bindingDigest: string;
	readonly resourceDigest?: string;
	readonly operationDigest: string;
	readonly stateDigest: string;
	readonly revision: number;
	readonly receiptContext?: WorkflowHostReceiptConsumerContext;
	readonly expectedReportGeneration?: number;
	readonly expectedSectionGenerations?: Readonly<Record<string, number>>;
}

function assertHostAuthority(
	value: unknown,
	label = "hostAuthority",
): asserts value is WorkflowDecisionPacketHostAuthority {
	if (typeof value !== "object" || value === null || !hostAuthorities.has(value))
		fail("authority_invalid", `${label} was not issued by a persisted workflow host.`);
}

function assertHostCapabilityReceipt(value: unknown, label: string): asserts value is WorkflowVerifiedHostReceipt {
	assertVerifiedArtifactReceipt(value, label, "capability");
	if (
		value.capabilityBinding === undefined ||
		value.capabilityBinding.capability !== WORKFLOW_DECISION_PACKET_CAPABILITY
	)
		fail("capability_required", `${label} is not bound to workflow decision packet delivery.`);
}

function assertHostService(value: unknown, label: string, method: string): void {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		fail("host_service_invalid", `${label} must be a host-owned service object.`);
	assertDataDescriptors(value, label);
	if (typeof (value as Record<string, unknown>)[method] !== "function")
		fail("host_service_invalid", `${label}.${method} must be a host method.`);
}

function assertAuthorityInput(input: WorkflowDecisionPacketHostAuthorityInput): void {
	if (typeof input !== "object" || input === null) fail("authority_invalid", "Host authority input is invalid.");
	assertDataDescriptors(input, "host authority input");
	assertHostService(input.runtimeStore, "runtimeStore", "publishArtifact");
	assertHostService(input.artifactResolver, "artifactResolver", "resolve");
	assertHostService(input.principalAuthorizer, "principalAuthorizer", "authorize");
	assertHostService(input.registry, "registry", "recomputeExpectedSet");
	assertHostCapabilityReceipt(input.capabilityReceipt, "capabilityReceipt");
	assertDigest(input.bindingDigest, "bindingDigest");
	if (input.resourceDigest !== undefined) assertDigest(input.resourceDigest, "resourceDigest");
	assertDigest(input.operationDigest, "operationDigest");
	assertString(input.stateDigest, "stateDigest", WORKFLOW_DECISION_PACKET_LIMITS.maxShortTextBytes);
	assertSafeNonNegativeInteger(input.revision, "revision");
	if (input.expectedReportGeneration !== undefined)
		assertSafeNonNegativeInteger(input.expectedReportGeneration, "expectedReportGeneration");
	if (input.expectedSectionGenerations !== undefined) {
		assertPlainRecord(input.expectedSectionGenerations, "expectedSectionGenerations");
		for (const [sectionId, generation] of Object.entries(input.expectedSectionGenerations)) {
			assertSafeSectionId(sectionId, "expectedSectionGenerations.sectionId");
			assertSafeNonNegativeInteger(generation, `expectedSectionGenerations.${sectionId}`);
		}
	}
	if (input.receiptContext !== undefined) {
		if (typeof input.receiptContext !== "object" || input.receiptContext === null)
			fail("host_service_invalid", "receiptContext must be a host-owned service object.");
		assertDataDescriptors(input.receiptContext, "receiptContext");
		assertHostService(input.receiptContext.receiptResolver, "receiptContext.receiptResolver", "resolve");
		assertHostService(input.receiptContext.keyResolver, "receiptContext.keyResolver", "resolve");
		assertHostService(input.receiptContext.principalAuthorizer, "receiptContext.principalAuthorizer", "authorize");
	}
}

function authorityRecord(input: {
	readonly workflowId: string;
	readonly generationId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly bindingDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly stateDigest: string;
	readonly revision: number;
	readonly receiptDigest: string;
}): Record<string, unknown> {
	return {
		version: 1,
		workflowId: input.workflowId,
		generationId: input.generationId,
		epochRef: input.epochRef,
		bindingDigest: input.bindingDigest,
		resourceDigest: input.resourceDigest,
		operationDigest: input.operationDigest,
		stateDigest: input.stateDigest,
		revision: input.revision,
		receiptDigest: input.receiptDigest,
	};
}

function assertAuthorityRecord(value: unknown): asserts value is Record<string, unknown> {
	assertPlainRecord(value, "persisted host authority");
	assertExactKeys(
		value,
		[
			"version",
			"workflowId",
			"generationId",
			"epochRef",
			"bindingDigest",
			"resourceDigest",
			"operationDigest",
			"stateDigest",
			"revision",
			"receiptDigest",
		],
		"persisted host authority",
	);
	if (value.version !== 1) fail("authority_record_invalid", "Persisted host authority version is unsupported.");
	assertIdentifier(value.workflowId, "persisted host authority.workflowId");
	assertIdentifier(value.generationId, "persisted host authority.generationId");
	assertEpochRef(value.epochRef, "persisted host authority.epochRef");
	assertDigest(value.bindingDigest, "persisted host authority.bindingDigest");
	assertDigest(value.resourceDigest, "persisted host authority.resourceDigest");
	assertDigest(value.operationDigest, "persisted host authority.operationDigest");
	assertString(
		value.stateDigest,
		"persisted host authority.stateDigest",
		WORKFLOW_DECISION_PACKET_LIMITS.maxShortTextBytes,
	);
	assertSafeNonNegativeInteger(value.revision, "persisted host authority.revision");
	assertDigest(value.receiptDigest, "persisted host authority.receiptDigest");
}

function assertCapabilityAuthorization(
	authorization: WorkflowHostPrincipalCapabilityAuthorization,
	input: {
		readonly workflowId: string;
		readonly bindingDigest: string;
		readonly resourceDigest: string;
		readonly operationDigest: string;
		readonly stateDigest: string;
		readonly revision: number;
		readonly epochRef: WorkflowEpochRef;
		readonly receipt: WorkflowVerifiedHostReceipt;
	},
): void {
	if (typeof authorization !== "object" || authorization === null)
		fail("authorization_invalid", "Host authorization is invalid.");
	assertDataDescriptors(authorization, "host authorization");
	if (
		authorization.capability !== WORKFLOW_DECISION_PACKET_CAPABILITY ||
		authorization.workflowId !== input.workflowId ||
		authorization.bindingDigest !== input.bindingDigest ||
		authorization.stateDigest !== input.stateDigest ||
		authorization.revision !== input.revision ||
		!epochsEqual(authorization.epochRef, input.epochRef) ||
		!sameJson(authorization.receipt, input.receipt)
	)
		fail("authorization_binding_mismatch", "Host authorization is not bound to this workflow authority.");
	if (input.receipt.bindingDigest !== input.bindingDigest || input.receipt.workflowId !== input.workflowId)
		fail("authorization_binding_mismatch", "Capability receipt is not bound to this workflow authority.");
	assertString(
		authorization.authenticatedPrincipal,
		"host authorization.authenticatedPrincipal",
		WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
	);
	assertString(
		authorization.keyOwnerPrincipal,
		"host authorization.keyOwnerPrincipal",
		WORKFLOW_DECISION_PACKET_LIMITS.maxIdentifierBytes,
	);
	assertDigest(authorization.authorizationDigest, "host authorization.authorizationDigest");
	if (authorization.receipt.capabilityBinding === undefined)
		fail("authorization_invalid", "Host authorization lacks capability binding.");
	if (
		authorization.receipt.capabilityBinding.resourceDigest !== input.resourceDigest ||
		authorization.receipt.capabilityBinding.operationDigest !== input.operationDigest
	)
		fail("authorization_binding_mismatch", "Host authorization resource or operation binding is stale.");
}

async function authorizeHostAuthority(
	input: WorkflowDecisionPacketHostAuthorityInput,
	durableEpoch: WorkflowEpochRef,
	resourceDigest: string,
): Promise<void> {
	const capabilityBinding = input.capabilityReceipt.capabilityBinding;
	if (capabilityBinding === undefined)
		fail("capability_required", "Host capability receipt lacks capability binding.");
	const authorizationInput = {
		receipt: input.capabilityReceipt,
		workflowId: input.runtimeStore.identity.workflowId,
		bindingDigest: input.bindingDigest,
		resourceDigest,
		operationDigest: input.operationDigest,
		stateDigest: input.stateDigest,
		revision: input.revision,
		epochRef: durableEpoch,
		capability: WORKFLOW_DECISION_PACKET_CAPABILITY,
		...(capabilityBinding.executionIdentity === null
			? {}
			: { executionIdentity: capabilityBinding.executionIdentity }),
		...(capabilityBinding.sessionId === null ? {} : { sessionId: capabilityBinding.sessionId }),
	};
	const authorization = await input.principalAuthorizer.authorize(authorizationInput);
	assertCapabilityAuthorization(authorization, { ...authorizationInput, receipt: input.capabilityReceipt });
}

/**
 * Issue host authority only from a durable workflow runtime and central principal authorizer.
 * Args: Persisted runtime store, host resolver/registry, and verified capability receipt.
 * Return: Opaque authority whose marker is persisted before it can be used for delivery.
 */
export async function issueWorkflowDecisionPacketHostAuthority(
	input: WorkflowDecisionPacketHostAuthorityInput,
): Promise<WorkflowDecisionPacketHostAuthority> {
	assertAuthorityInput(input);
	if (input.runtimeStore.identity.storeKind !== "workflow")
		fail("authority_invalid", "Decision packets require a workflow runtime store.");
	if (input.capabilityReceipt.capabilityBinding === undefined)
		fail("capability_required", "Host capability receipt lacks capability binding.");
	if (input.runtimeStore.identity.workflowId !== input.capabilityReceipt.workflowId)
		fail("binding_mismatch", "Runtime store and capability receipt identify different workflows.");
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined)
		fail("durable_host_required", "Decision packet authority requires a persisted runtime context.");
	assertDataDescriptors(durable, "runtimeStore.durableContext");
	assertHostService(durable.auxiliaryStore, "runtimeStore.durableContext.auxiliaryStore", "read");
	assertHostService(durable.auxiliaryStore, "runtimeStore.durableContext.auxiliaryStore", "write");
	if (typeof durable.withExclusiveLease !== "function" || typeof durable.recoverJournal !== "function")
		fail("durable_host_required", "Persisted runtime context lacks exclusive lease and recovery operations.");
	if (!epochsEqual(durable.epochRef, durable.currentLeaseRef()))
		fail("stale_epoch", "Persisted runtime lease is not bound to its current epoch.");
	const resourceDigest = input.resourceDigest ?? input.capabilityReceipt.capabilityBinding!.resourceDigest;
	assertDigest(resourceDigest, "resourceDigest");
	const marker = authorityRecord({
		workflowId: input.runtimeStore.identity.workflowId,
		generationId: durable.generationId,
		epochRef: durable.epochRef,
		bindingDigest: input.bindingDigest,
		resourceDigest,
		operationDigest: input.operationDigest,
		stateDigest: input.stateDigest,
		revision: input.revision,
		receiptDigest: digestObject(input.capabilityReceipt),
	});
	await durable.recoverJournal();
	await authorizeHostAuthority(input, durable.epochRef, resourceDigest);
	await durable.withExclusiveLease("workflow-decision-packet-authority", async () => {
		const persisted = await durable.auxiliaryStore.read(HOST_AUTHORITY_RECORD);
		if (persisted === null) {
			await durable.auxiliaryStore.write(HOST_AUTHORITY_RECORD, canonicalJsonBytes(marker));
			return;
		}
		const parsed = parseCanonicalJsonBytes(Uint8Array.from(persisted));
		assertAuthorityRecord(parsed);
		if (!sameJson(parsed, marker))
			fail("authority_record_stale", "Persisted host authority binding differs from this host.");
	});
	const registry = Object.freeze({ recomputeExpectedSet: input.registry.recomputeExpectedSet });
	const principalAuthorizer = Object.freeze({ authorize: input.principalAuthorizer.authorize });
	const artifactResolver = Object.freeze({ resolve: input.artifactResolver.resolve });
	const receiptContext =
		input.receiptContext === undefined
			? null
			: Object.freeze({
					...input.receiptContext,
					receiptResolver: Object.freeze({ ...input.receiptContext.receiptResolver }),
					keyResolver: Object.freeze({ ...input.receiptContext.keyResolver }),
					artifactResolver: Object.freeze({ ...input.receiptContext.artifactResolver }),
					principalAuthorizer: Object.freeze({ ...input.receiptContext.principalAuthorizer }),
				});
	const authority = Object.freeze({
		[HOST_AUTHORITY_BRAND]: true as const,
		runtimeStore: input.runtimeStore,
		artifactResolver,
		principalAuthorizer,
		registry,
		capabilityReceipt: cloneAndFreeze(input.capabilityReceipt),
		bindingDigest: input.bindingDigest,
		resourceDigest,
		operationDigest: input.operationDigest,
		stateDigest: input.stateDigest,
		revision: input.revision,
		generationId: durable.generationId,
		receiptContext,
		expectedReportGeneration: input.expectedReportGeneration ?? null,
		expectedSectionGenerations: cloneAndFreeze(input.expectedSectionGenerations ?? {}),
	}) as WorkflowDecisionPacketHostAuthority;
	hostAuthorities.add(authority as unknown as object);
	return authority;
}

export const createWorkflowDecisionPacketHostAuthority = issueWorkflowDecisionPacketHostAuthority;

/**
 * Create a bounded, digest-bound verdict packet without report bytes.
 * Args: Bounded worker/reviewer verdict fields and causal binding.
 * Return: Detached, deeply frozen verdict packet.
 */
export function createWorkflowVerdictPacket(input: WorkflowDecisionVerdictPacketInput): WorkflowDecisionVerdictPacket {
	assertPacketInputWithOptionalLifecycle(
		input,
		[
			...commonPacketInputKeys(),
			"verdict",
			"topBlockers",
			"requirementIds",
			"confidence",
			"uncertainty",
			"requiredDisposition",
			"expansionRequired",
		],
		"verdict input",
	);
	assertPacketInputBinding(input, "verdict input");
	const packet = createPacket<WorkflowDecisionVerdictPacket>({
		schemaVersion: WORKFLOW_DECISION_PACKET_SCHEMA_VERSION,
		kind: "verdict_packet",
		...input,
		lifecycle: input.lifecycle ?? "provisional",
		capability: WORKFLOW_DECISION_PACKET_CAPABILITY,
	} as Omit<WorkflowDecisionVerdictPacket, "packetDigest">);
	return packet;
}

/**
 * Create bounded exact remediation instructions that can dispatch without a full report.
 * Args: Amendment, ownership, dependency, acceptance, and blocker-closure fields.
 * Return: Detached, deeply frozen remediation packet.
 */
export function createWorkflowRemediationPacket(
	input: WorkflowDecisionRemediationPacketInput,
): WorkflowDecisionRemediationPacket {
	assertPacketInputWithOptionalLifecycle(
		input,
		[
			...commonPacketInputKeys(),
			"amendments",
			"dependencies",
			"ownership",
			"requiredNextAction",
			"publicAcceptanceChecks",
			"blockerClosureMapping",
			"requirementClosureMapping",
		],
		"remediation input",
	);
	assertPacketInputBinding(input, "remediation input");
	return createPacket<WorkflowDecisionRemediationPacket>({
		schemaVersion: WORKFLOW_DECISION_PACKET_SCHEMA_VERSION,
		kind: "remediation_packet",
		...input,
		lifecycle: input.lifecycle ?? "provisional",
		capability: WORKFLOW_DECISION_PACKET_CAPABILITY,
	} as Omit<WorkflowDecisionRemediationPacket, "packetDigest">);
}

/**
 * Create an immutable selective-expansion manifest for a full report artifact.
 * Args: Full report reference and ordered section references bound to one causal head.
 * Return: Detached, deeply frozen evidence manifest; no report bytes are accepted.
 */
export function createWorkflowEvidenceManifest(
	input: WorkflowDecisionEvidenceManifestInput,
): WorkflowDecisionEvidenceManifest {
	assertPacketInputWithOptionalLifecycle(
		input,
		[...commonPacketInputKeys(), "fullReportRef", "fullReportContentType", "sectionRefs"],
		"evidence manifest input",
	);
	assertPacketInputBinding(input, "evidence manifest input");
	return createPacket<WorkflowDecisionEvidenceManifest>({
		schemaVersion: WORKFLOW_DECISION_PACKET_SCHEMA_VERSION,
		kind: "evidence_manifest",
		...input,
		lifecycle: input.lifecycle ?? "provisional",
		capability: WORKFLOW_DECISION_PACKET_CAPABILITY,
	} as Omit<WorkflowDecisionEvidenceManifest, "packetDigest">);
}

export interface WorkflowDecisionPacketTriadInput {
	readonly verdict: WorkflowDecisionVerdictPacket;
	readonly remediation: WorkflowDecisionRemediationPacket;
	readonly evidenceManifest: WorkflowDecisionEvidenceManifest;
	readonly supersedesPacketDigest?: string | null;
}

export interface WorkflowDecisionTerminalPacketTriadInput {
	readonly verdict: WorkflowDecisionVerdictPacket;
	readonly remediation: WorkflowDecisionRemediationPacket;
	readonly evidenceManifest: WorkflowDecisionEvidenceManifest;
	readonly terminalSeal: WorkflowDecisionPacketTerminalSeal;
	readonly supersedesPacketDigest?: string | null;
}

function assertTriadParts(
	input: {
		readonly verdict: WorkflowDecisionVerdictPacket;
		readonly remediation: WorkflowDecisionRemediationPacket;
		readonly evidenceManifest: WorkflowDecisionEvidenceManifest;
	},
	terminalSeal: WorkflowDecisionPacketTerminalSeal | null,
): WorkflowDecisionPacketLifecycle {
	assertVerdictPacket(input.verdict);
	assertRemediationPacket(input.remediation);
	assertEvidenceManifest(input.evidenceManifest);
	assertSamePacketBinding({
		verdict: input.verdict,
		remediation: input.remediation,
		evidenceManifest: input.evidenceManifest,
		lifecycle: input.verdict.lifecycle,
		terminalSeal,
		supersedesPacketDigest: null,
		packetDigest: "0".repeat(64),
		packetBytes: 0,
	});
	const lifecycle = input.verdict.lifecycle;
	if (input.remediation.lifecycle !== lifecycle || input.evidenceManifest.lifecycle !== lifecycle)
		fail("lifecycle_mismatch", "Decision packets in one triad must share one lifecycle.");
	if (lifecycle === "terminal") {
		if (terminalSeal === null)
			fail("terminal_seal_required", "Terminal packet triads require a verified artifact seal.");
		assertTerminalSeal(terminalSeal);
	} else if (terminalSeal !== null) {
		fail("terminal_seal_unexpected", "Provisional packet triads cannot carry a terminal seal.");
	}
	return lifecycle;
}

function assertTerminalSealMatchesManifest(
	seal: WorkflowDecisionPacketTerminalSeal,
	packets: {
		readonly verdict: WorkflowDecisionVerdictPacket;
		readonly evidenceManifest: WorkflowDecisionEvidenceManifest;
	},
): void {
	if (!sameJson(seal.reportRef, packets.evidenceManifest.fullReportRef))
		fail("terminal_report_mismatch", "Terminal seal reportRef does not match the evidence manifest report.");
	if (
		seal.producer.workflowId !== packets.verdict.workflowId ||
		seal.producer.taskId !== packets.verdict.taskId ||
		seal.producer.attemptId !== packets.verdict.attemptId ||
		!epochsEqual(seal.producer.epochRef, packets.verdict.epochRef)
	) {
		fail("terminal_producer_mismatch", "Terminal seal producer binding does not match the packet triad.");
	}
	if (!sameJson(seal.producer.producerFence.epochRef, packets.verdict.epochRef))
		fail("producer_fence_mismatch", "Terminal producer fence is not bound to the packet epoch.");
	if (seal.sectionRefs.length !== packets.evidenceManifest.sectionRefs.length)
		fail("terminal_section_mismatch", "Terminal seal must cover every declared evidence section.");
	for (const [index, section] of seal.sectionRefs.entries()) {
		const declared = packets.evidenceManifest.sectionRefs[index];
		if (
			declared === undefined ||
			section.sectionId !== declared.sectionId ||
			!sameJson(section.artifactRef, declared.artifactRef) ||
			section.digest !== declared.digest
		) {
			fail("terminal_section_mismatch", "Terminal seal section refs do not exactly match the manifest.");
		}
	}
}

function createTriad(
	input: {
		readonly verdict: WorkflowDecisionVerdictPacket;
		readonly remediation: WorkflowDecisionRemediationPacket;
		readonly evidenceManifest: WorkflowDecisionEvidenceManifest;
	},
	terminalSeal: WorkflowDecisionPacketTerminalSeal | null,
	supersedesPacketDigest: string | null,
): WorkflowDecisionPacketTriad {
	assertNoRawBody(input);
	const lifecycle = assertTriadParts(input, terminalSeal);
	if (supersedesPacketDigest !== null) assertDigest(supersedesPacketDigest, "supersedesPacketDigest");
	if (terminalSeal !== null) assertTerminalSealMatchesManifest(terminalSeal, input);
	let packetBytes = canonicalJsonBytes(input.verdict).byteLength;
	packetBytes = safeAdd(packetBytes, canonicalJsonBytes(input.remediation).byteLength, "packet triad bytes");
	packetBytes = safeAdd(packetBytes, canonicalJsonBytes(input.evidenceManifest).byteLength, "packet triad bytes");
	packetBytes = safeAdd(
		packetBytes,
		terminalSeal === null ? 0 : canonicalJsonBytes(terminalSeal).byteLength,
		"packet triad bytes",
	);
	if (packetBytes > WORKFLOW_DECISION_PACKET_LIMITS.maxTriadBytes)
		fail("packet_too_large", "packet triad exceeds the session-message bound.");
	const packetDigest = digestObject({
		kind: "workflow_decision_packet_triad",
		schemaVersion: WORKFLOW_DECISION_PACKET_SCHEMA_VERSION,
		lifecycle,
		supersedesPacketDigest,
		packetDigests: [input.verdict.packetDigest, input.remediation.packetDigest, input.evidenceManifest.packetDigest],
		terminalSeal,
	});
	const candidate = {
		...input,
		lifecycle,
		terminalSeal,
		supersedesPacketDigest,
		packetDigest,
		packetBytes,
	};
	const wireBytes = canonicalJsonBytes(candidate);
	if (wireBytes.byteLength > WORKFLOW_DECISION_PACKET_LIMITS.maxTriadBytes)
		fail("packet_too_large", "packet triad exceeds the session-message bound including framing headroom.");
	return cloneAndFreeze(candidate);
}

/**
 * Bundle the normal reviewer triad and bind its exact packet order and sizes.
 * Args: Host/reviewer-produced verdict, remediation, and evidence manifest packets.
 * Return: Detached, deeply frozen packet triad with a canonical delivery digest.
 */
export function createWorkflowDecisionPacketTriad(
	input: WorkflowDecisionPacketTriadInput,
): WorkflowDecisionPacketTriad {
	assertPlainRecord(input, "packet triad input");
	const actualKeys = Reflect.ownKeys(input);
	if (
		actualKeys.some(
			(key) =>
				typeof key !== "string" ||
				(key !== "verdict" &&
					key !== "remediation" &&
					key !== "evidenceManifest" &&
					key !== "supersedesPacketDigest"),
		) ||
		!actualKeys.includes("verdict") ||
		!actualKeys.includes("remediation") ||
		!actualKeys.includes("evidenceManifest")
	) {
		fail("closed_contract", "packet triad input violates its closed contract.");
	}
	return createTriad(input, null, input.supersedesPacketDigest ?? null);
}

/**
 * Bundle a terminal result and its host-verifiable artifact seal.
 * Args: Terminal-lifecycle verdict, remediation, manifest, and exact seal receipt.
 * Return: Detached terminal triad; host seal verification remains mandatory at delivery.
 */
export function createWorkflowTerminalDecisionPacketTriad(
	input: WorkflowDecisionTerminalPacketTriadInput,
): WorkflowDecisionPacketTriad {
	assertPlainRecord(input, "terminal packet triad input");
	const actualKeys = Reflect.ownKeys(input);
	if (
		actualKeys.some(
			(key) =>
				typeof key !== "string" ||
				(key !== "verdict" &&
					key !== "remediation" &&
					key !== "evidenceManifest" &&
					key !== "terminalSeal" &&
					key !== "supersedesPacketDigest"),
		) ||
		!actualKeys.includes("verdict") ||
		!actualKeys.includes("remediation") ||
		!actualKeys.includes("evidenceManifest") ||
		!actualKeys.includes("terminalSeal")
	) {
		fail("closed_contract", "terminal packet triad input violates its closed contract.");
	}
	return createTriad(input, input.terminalSeal, input.supersedesPacketDigest ?? null);
}

/**
 * Parse one canonical packet triad at the public transport boundary.
 * Args: Canonical UTF-8 JSON bytes containing only the bounded triad.
 * Return: Detached, deeply frozen packet triad after closed-contract validation.
 */
export function parseWorkflowDecisionPacketTriad(bytes: Readonly<Uint8Array>): WorkflowDecisionPacketTriad {
	if (!(bytes instanceof Uint8Array)) fail("transport_invalid", "Decision packet transport must be UTF-8 bytes.");
	if (bytes.byteLength > WORKFLOW_DECISION_PACKET_LIMITS.maxTriadBytes)
		fail("packet_too_large", "Packet transport exceeds the session-message bound including framing headroom.");
	const parsed = parseCanonicalJsonBytes(Uint8Array.from(bytes));
	return normalizeTriad(parsed);
}

/**
 * Serialize a validated packet triad without admitting report bytes.
 * Args: Immutable packet triad.
 * Return: Canonical UTF-8 JSON bytes bounded by the session-message limit.
 */
export function serializeWorkflowDecisionPacketTriad(triad: WorkflowDecisionPacketTriad): Readonly<Uint8Array> {
	const normalized = normalizeTriad(triad);
	const bytes = canonicalJsonBytes(normalized);
	if (bytes.byteLength > WORKFLOW_DECISION_PACKET_LIMITS.maxTriadBytes)
		fail("packet_too_large", "packet triad exceeds the session-message bound.");
	return Uint8Array.from(bytes);
}

/**
 * Validate delivery using only an opaque authority issued by a persisted host.
 * Args: Packet triad, current causal binding, and host-issued authority.
 * Return: Host-authoritative admission or selective-expansion requirements.
 */
export async function validateWorkflowDecisionPacketDelivery(
	input: WorkflowDecisionPacketDeliveryInput,
): Promise<WorkflowDecisionPacketDeliveryResult> {
	if (typeof input !== "object" || input === null) fail("delivery_invalid", "Packet delivery input is invalid.");
	assertDataDescriptors(input, "packet delivery input");
	assertCurrentBinding(input.currentBinding);
	assertHostAuthority(input.hostAuthority);
	const packets = normalizeTriad(input.packets);
	if (input.hostAuthority.runtimeStore.identity.workflowId !== input.currentBinding.workflowId)
		fail("binding_mismatch", "Runtime store workflow identity does not match packet delivery.");
	const binding = packets.verdict;
	if (
		binding.workflowId !== input.currentBinding.workflowId ||
		binding.taskId !== input.currentBinding.taskId ||
		binding.attemptId !== input.currentBinding.attemptId ||
		!epochsEqual(binding.epochRef, input.currentBinding.epochRef) ||
		!sameJson(binding.head, input.currentBinding.head) ||
		(input.currentBinding.runtimeVersion !== undefined &&
			binding.runtimeVersion !== input.currentBinding.runtimeVersion)
	)
		fail("stale_binding", "Decision packet delivery is stale for the current head, epoch, or task attempt.");
	await assertDurableCurrent(input.hostAuthority, input.currentBinding);
	const authorizationInput = {
		receipt: input.hostAuthority.capabilityReceipt,
		workflowId: binding.workflowId,
		bindingDigest: input.hostAuthority.bindingDigest,
		resourceDigest: input.hostAuthority.resourceDigest,
		operationDigest: input.hostAuthority.operationDigest,
		stateDigest: input.hostAuthority.stateDigest,
		revision: input.hostAuthority.revision,
		epochRef: binding.epochRef,
		capability: WORKFLOW_DECISION_PACKET_CAPABILITY,
		...(input.hostAuthority.capabilityReceipt.capabilityBinding?.executionIdentity === null
			? {}
			: { executionIdentity: input.hostAuthority.capabilityReceipt.capabilityBinding?.executionIdentity }),
		...(input.hostAuthority.capabilityReceipt.capabilityBinding?.sessionId === null
			? {}
			: { sessionId: input.hostAuthority.capabilityReceipt.capabilityBinding?.sessionId }),
	};
	const authorization = await input.hostAuthority.principalAuthorizer.authorize(authorizationInput);
	assertCapabilityAuthorization(authorization, {
		...authorizationInput,
		receipt: input.hostAuthority.capabilityReceipt,
	});
	/* Section refs are host-verified without resolving the immutable full report. */
	await verifyDeclaredManifestSections(input.hostAuthority, packets.evidenceManifest);
	let terminalSealVerified = false;
	if (packets.lifecycle === "terminal") {
		if (packets.supersedesPacketDigest !== null && input.priorTerminalPacket === undefined)
			fail("terminal_supersession_required", "Terminal update must provide the prior result for host supersession.");
		if (input.priorTerminalPacket !== undefined) {
			const prior = normalizeTriad(input.priorTerminalPacket);
			if (prior.lifecycle !== "terminal")
				fail("terminal_supersession_invalid", "A terminal packet cannot supersede a provisional result.");
			if (prior.verdict.attemptId === binding.attemptId)
				fail("terminal_supersession_requires_attempt", "A terminal update requires a new producer attempt.");
			if (packets.supersedesPacketDigest !== prior.packetDigest)
				fail("terminal_supersession_required", "Terminal update must declare the prior terminal packet digest.");
		}
		if (packets.terminalSeal === null) fail("terminal_seal_required", "Terminal packet triads require a seal.");
		await verifyTerminalSealAtHost(input.hostAuthority, packets.terminalSeal, packets, input.currentBinding);
		terminalSealVerified = true;
	}
	const expected = normalizeExpectedSet(
		await input.hostAuthority.registry.recomputeExpectedSet({
			workflowId: binding.workflowId,
			taskId: binding.taskId,
			attemptId: binding.attemptId,
			head: binding.head,
			epochRef: binding.epochRef,
		}),
	);
	const manifestSectionIds = new Set(packets.evidenceManifest.sectionRefs.map((section) => section.sectionId));
	for (const blocker of packets.verdict.topBlockers)
		for (const sectionId of blocker.sectionIds)
			if (!manifestSectionIds.has(sectionId))
				fail("section_not_declared", `Verdict blocker ${blocker.blockerId} names an undeclared section.`);
	for (const expectedBlocker of expected.blockers) {
		if (expectedBlocker.requiredSectionIds.some((sectionId) => !manifestSectionIds.has(sectionId)))
			fail(
				"host_registry_invalid",
				`Host blocker ${expectedBlocker.blockerId} names an undeclared required section.`,
			);
	}
	const actualBlockerIds = packets.verdict.topBlockers.map((blocker) => blocker.blockerId);
	const expectedBlockerIds = expected.blockers.map((blocker) => blocker.blockerId);
	const missingBlockerIds = expectedBlockerIds.filter((id) => !actualBlockerIds.includes(id));
	const contradictedBlockerIds = actualBlockerIds.filter((id) => !expectedBlockerIds.includes(id));
	if (
		missingBlockerIds.length === 0 &&
		contradictedBlockerIds.length === 0 &&
		actualBlockerIds.some((id, index) => id !== expectedBlockerIds[index])
	)
		for (const id of expectedBlockerIds) if (!contradictedBlockerIds.includes(id)) contradictedBlockerIds.push(id);
	for (const expectedBlocker of expected.blockers) {
		const actual = packets.verdict.topBlockers.find((blocker) => blocker.blockerId === expectedBlocker.blockerId);
		if (actual === undefined) continue;
		if (
			actual.disposition === "resolved" ||
			expectedBlocker.findingIds.some((findingId) => !actual.findingIds.includes(findingId)) ||
			actual.findingIds.some((findingId) => !expectedBlocker.findingIds.includes(findingId)) ||
			expectedBlocker.requiredSectionIds.some((sectionId) => !actual.sectionIds.includes(sectionId))
		)
			if (!contradictedBlockerIds.includes(expectedBlocker.blockerId))
				contradictedBlockerIds.push(expectedBlocker.blockerId);
	}
	const missingRequirementIds = expected.requirementIds.filter((id) => !packets.verdict.requirementIds.includes(id));
	const contradictedRequirementIds = packets.verdict.requirementIds.filter(
		(id) => !expected.requirementIds.includes(id),
	);
	if (
		missingRequirementIds.length === 0 &&
		contradictedRequirementIds.length === 0 &&
		packets.verdict.requirementIds.some((id, index) => id !== expected.requirementIds[index])
	)
		for (const id of expected.requirementIds)
			if (!contradictedRequirementIds.includes(id)) contradictedRequirementIds.push(id);
	validateRemediationClosure(packets.verdict, packets.remediation, expected, packets.evidenceManifest);
	const requiredSectionIds = expected.blockers
		.filter(
			(blocker) =>
				missingBlockerIds.includes(blocker.blockerId) || contradictedBlockerIds.includes(blocker.blockerId),
		)
		.flatMap((blocker) => blocker.requiredSectionIds)
		.filter((sectionId, index, all) => all.indexOf(sectionId) === index);
	const expansionRequired =
		missingBlockerIds.length > 0 ||
		contradictedBlockerIds.length > 0 ||
		missingRequirementIds.length > 0 ||
		contradictedRequirementIds.length > 0;
	return cloneAndFreeze({
		accepted: !expansionRequired,
		lifecycle: packets.lifecycle,
		terminalSealVerified,
		expansionRequired,
		workerExpansionRequested: packets.verdict.expansionRequired,
		missingBlockerIds,
		contradictedBlockerIds,
		missingRequirementIds,
		contradictedRequirementIds,
		requiredSectionIds,
		authoritativeBlockerIds: expectedBlockerIds,
		authoritativeRequirementIds: expected.requirementIds,
		packetDigest: packets.packetDigest,
		capability: WORKFLOW_DECISION_PACKET_CAPABILITY,
	});
}

/**
 * Resolve only declared evidence sections and ask the host to synthesize a bounded correction.
 * Args: Evidence manifest, ordered section IDs, artifact resolver, expansion reason, and host synthesis callback.
 * Return: Selected section text plus a bounded host correction; the full report is never resolved.
 */
export async function selectivelyExpandWorkflowDecisionEvidence(
	input: WorkflowDecisionSelectiveExpansionInput,
): Promise<WorkflowDecisionSelectiveExpansionResult> {
	if (typeof input !== "object" || input === null) fail("expansion_invalid", "Selective expansion input is invalid.");
	assertDataDescriptors(input, "selective expansion input");
	assertNoRawBody(input, "selective expansion input");
	assertEvidenceManifest(input.manifest);
	if (typeof input.resolver !== "object" || input.resolver === null || typeof input.resolver.resolve !== "function")
		fail("resolver_invalid", "Selective expansion requires a host artifact resolver.");
	if (typeof input.synthesize !== "function")
		fail("synthesis_invalid", "Selective expansion requires a synthesis operation.");
	const selectedSectionIds = cloneAndFreeze(input.sectionIds);
	const declaredSections = assertSectionIdsDeclared(input.manifest, selectedSectionIds);
	if (input.reason === "cross_lens_conflict") {
		if (input.lensIdentity !== undefined) assertLensIdentity(input.lensIdentity, "lensIdentity");
		if (input.hostContradictionPlan === undefined) {
			if (input.disputedSectionIds === undefined)
				fail("conflict_scope_invalid", "Conflict expansion requires host-declared disputed scope.");
			const disputedSectionIds = cloneAndFreeze(input.disputedSectionIds);
			assertSectionIdArray(
				disputedSectionIds,
				"disputedSectionIds",
				WORKFLOW_DECISION_PACKET_LIMITS.maxSelectedSections,
			);
			if (disputedSectionIds.length !== 1)
				fail("conflict_scope_invalid", "Conflict expansion defaults to exactly one disputed section.");
			assertSectionIdsDeclared(input.manifest, disputedSectionIds);
			if (!sameJson(selectedSectionIds, disputedSectionIds))
				fail(
					"conflict_scope_invalid",
					"Conflict expansion must retrieve exactly the host-declared disputed section.",
				);
		} else {
			assertContradictionPlan(input.hostContradictionPlan);
			if (
				input.lensIdentity !== undefined &&
				!input.hostContradictionPlan.lensIdentities.some(
					(identity) =>
						identity.lensId === input.lensIdentity?.lensId &&
						identity.contradictionId === input.lensIdentity?.contradictionId,
				)
			)
				fail("lens_identity_invalid", "Lens identity is not included in the host contradiction plan.");
			const disputedSectionIds = cloneAndFreeze(input.hostContradictionPlan.disputedSectionIds);
			assertSectionIdsDeclared(input.manifest, disputedSectionIds);
			if (!sameJson(selectedSectionIds, disputedSectionIds))
				fail(
					"conflict_scope_invalid",
					"Conflict expansion must retrieve exactly the host contradiction plan scope.",
				);
			if (input.disputedSectionIds !== undefined && !sameJson(input.disputedSectionIds, disputedSectionIds))
				fail("conflict_scope_invalid", "Declared disputed sections disagree with the host contradiction plan.");
		}
	} else if (
		input.disputedSectionIds !== undefined ||
		input.hostContradictionPlan !== undefined ||
		input.lensIdentity !== undefined
	) {
		fail("conflict_scope_invalid", "Lens contradiction metadata is only valid for conflict expansion.");
	}
	const sections: WorkflowDecisionExpandedSection[] = [];
	for (const section of declaredSections) {
		const resolved = await input.resolver.resolve(section.artifactRef);
		const bytes = assertResolvedSection(resolved, section);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error: unknown) {
			const cause = error instanceof Error ? `: ${error.message}` : "";
			throw new WorkflowDecisionPacketError(
				"section_encoding_invalid",
				`Section ${section.sectionId} is not valid UTF-8${cause}.`,
			);
		}
		assertString(text, `section ${section.sectionId}.text`, WORKFLOW_DECISION_PACKET_LIMITS.maxSectionBytes, true);
		sections.push({
			sectionId: section.sectionId,
			ordinal: section.ordinal,
			contentType: section.contentType,
			digest: section.digest,
			sizeBytes: section.sizeBytes,
			sourceEventSequence: section.sourceEventSequence,
			text,
		});
	}
	const frozenSections = cloneAndFreeze(sections);
	const correction = normalizeCorrection(
		input.synthesize({ reason: input.reason, sectionIds: selectedSectionIds, sections: frozenSections }),
		selectedSectionIds,
	);
	return cloneAndFreeze({
		reason: input.reason,
		sectionIds: selectedSectionIds,
		sections: frozenSections,
		correction,
		fullReportResolved: false,
		expansionDigest: digestObject({
			kind: "workflow-decision-selective-expansion",
			manifestDigest: input.manifest.packetDigest,
			sectionIds: selectedSectionIds,
			sectionDigests: sections.map((section) => section.digest),
			correctionDigest: correction.correctionDigest,
		}),
	});
}

export interface WorkflowDecisionPacketPublicationInput {
	readonly hostAuthority: WorkflowDecisionPacketHostAuthority;
	readonly packets: WorkflowDecisionPacketTriad;
	readonly currentBinding: WorkflowDecisionPacketCurrentBinding;
	readonly priorTerminalPacket?: WorkflowDecisionPacketTriad;
}

export interface WorkflowDecisionPacketPublicationResult {
	readonly status: "published";
	readonly packetDigest: string;
	readonly lifecycle: WorkflowDecisionPacketLifecycle;
	readonly supersedesPacketDigest: string | null;
	readonly packetBytes: number;
	readonly artifactRef: WorkflowArtifactRef;
	readonly artifactEnvelope: {
		readonly ref: WorkflowArtifactRef;
		readonly payloadKind: "handoff";
		readonly codec: "utf8";
		readonly immutable: true;
	};
}

/**
 * Publish a validated packet triad through the real runtime artifact journal.
 * Args: Host authority, current binding, and optional prior terminal result.
 * Return: Durable handoff artifact identity; an idempotent duplicate is rejected.
 */
export async function publishWorkflowDecisionPacketTriad(
	input: WorkflowDecisionPacketPublicationInput,
): Promise<WorkflowDecisionPacketPublicationResult> {
	if (typeof input !== "object" || input === null) fail("publication_invalid", "Publication input is invalid.");
	assertDataDescriptors(input, "publication input");
	assertHostAuthority(input.hostAuthority);
	assertCurrentBinding(input.currentBinding);
	const delivery = await validateWorkflowDecisionPacketDelivery({
		packets: input.packets,
		currentBinding: input.currentBinding,
		hostAuthority: input.hostAuthority,
		priorTerminalPacket: input.priorTerminalPacket,
	});
	if (!delivery.accepted) fail("delivery_not_accepted", "A packet requiring selective expansion cannot be published.");
	const packets = normalizeTriad(input.packets);
	const bytes = serializeWorkflowDecisionPacketTriad(packets);
	const durable = input.hostAuthority.runtimeStore.durableContext;
	if (durable === undefined) fail("durable_host_required", "Packet publication requires a persisted runtime context.");
	const idempotencyKey = `workflow-decision-packet:${packets.packetDigest}`;
	const published = await durable.withExclusiveLease("workflow-decision-packet-publish", async () => {
		const persistedBytes = await durable.auxiliaryStore.read(HOST_PUBLICATION_RECORD);
		if (persistedBytes !== null) {
			const persisted = parseCanonicalJsonBytes(Uint8Array.from(persistedBytes));
			assertPublicationRecord(persisted);
			if (persisted.packetDigest === packets.packetDigest)
				fail("duplicate_packet", "The packet triad was already durably published.");
			if (persisted.lifecycle === "terminal") {
				if (packets.lifecycle !== "terminal" || packets.supersedesPacketDigest !== persisted.packetDigest)
					fail(
						"terminal_supersession_required",
						"A terminal publication must supersede the persisted terminal result.",
					);
				if (packets.verdict.attemptId === persisted.attemptId)
					fail(
						"terminal_supersession_requires_attempt",
						"A terminal publication requires a new producer attempt.",
					);
			}
		}
		const result = await input.hostAuthority.runtimeStore.publishArtifact({
			workflowId: input.currentBinding.workflowId,
			payloadKind: "handoff",
			bytes: Uint8Array.from(bytes),
			codec: "utf8",
			sourceEventSequence: input.currentBinding.head.sequence,
			idempotencyKey,
		});
		if (result.status === "published") {
			await durable.auxiliaryStore.write(
				HOST_PUBLICATION_RECORD,
				canonicalJsonBytes({
					version: 1,
					packetDigest: packets.packetDigest,
					lifecycle: packets.lifecycle,
					supersedesPacketDigest: packets.supersedesPacketDigest,
					workflowId: packets.verdict.workflowId,
					taskId: packets.verdict.taskId,
					attemptId: packets.verdict.attemptId,
					artifactRef: result.envelope.ref,
				}),
			);
		}
		return result;
	});
	if (published.status !== "published") fail("duplicate_packet", "The packet triad was already durably published.");
	if (
		published.envelope.payloadKind !== "handoff" ||
		published.envelope.codec !== "utf8" ||
		published.envelope.immutable !== true ||
		published.envelope.ref.sizeBytes !== bytes.byteLength ||
		published.envelope.ref.digest !== sha256Hex(bytes)
	)
		fail("publication_invalid", "Runtime publication returned an envelope that does not match packet bytes.");
	const reopened = await input.hostAuthority.artifactResolver.resolve(published.envelope.ref);
	const reopenedBytes = await resolveExactArtifact(
		input.hostAuthority.artifactResolver,
		published.envelope.ref,
		"published packet",
		["handoff"],
		["utf8"],
		WORKFLOW_DECISION_PACKET_LIMITS.maxTriadBytes,
	);
	if (!sameJson(parseWorkflowDecisionPacketTriad(reopenedBytes), packets) || reopened.exists !== true)
		fail("publication_reopen_mismatch", "Published packet bytes do not reopen to the same triad.");
	return cloneAndFreeze({
		status: "published",
		packetDigest: packets.packetDigest,
		lifecycle: packets.lifecycle,
		supersedesPacketDigest: packets.supersedesPacketDigest,
		packetBytes: packets.packetBytes,
		artifactRef: published.envelope.ref,
		artifactEnvelope: {
			ref: published.envelope.ref,
			payloadKind: "handoff",
			codec: "utf8",
			immutable: true,
		},
	});
}

export async function readWorkflowDecisionPacketPublication(input: {
	readonly hostAuthority: WorkflowDecisionPacketHostAuthority;
	readonly artifactRef: WorkflowArtifactRef;
}): Promise<WorkflowDecisionPacketTriad> {
	if (typeof input !== "object" || input === null) fail("publication_invalid", "Publication read input is invalid.");
	assertDataDescriptors(input, "publication read input");
	assertHostAuthority(input.hostAuthority);
	assertArtifactRef(input.artifactRef, "publication artifactRef");
	const bytes = await resolveExactArtifact(
		input.hostAuthority.artifactResolver,
		input.artifactRef,
		"published packet",
		["handoff"],
		["utf8"],
		WORKFLOW_DECISION_PACKET_LIMITS.maxTriadBytes,
	);
	return parseWorkflowDecisionPacketTriad(bytes);
}

/**
 * Project a rejected review into an amendment task using only verdict and remediation packets.
 * Args: Host-validated rejected verdict and bounded remediation packet.
 * Return: Dispatchable task projection with no full-report dependency.
 */
export function deriveWorkflowAmendmentTask(input: WorkflowDecisionAmendmentTaskInput): WorkflowDecisionAmendmentTask {
	assertPlainRecord(input, "amendment task input");
	assertExactKeys(input, ["verdict", "remediation"], "amendment task input");
	assertVerdictPacket(input.verdict);
	assertRemediationPacket(input.remediation);
	assertSamePacketBinding({
		verdict: input.verdict,
		remediation: input.remediation,
		evidenceManifest: {
			...input.remediation,
			kind: "evidence_manifest",
			fullReportRef: {
				artifactId: "placeholder",
				relativePath: "placeholder",
				digest: "0".repeat(64),
				sizeBytes: 0,
				sourceEventSequence: 0,
			},
			fullReportContentType: "text/plain",
			sectionRefs: [],
		} as unknown as WorkflowDecisionEvidenceManifest,
		lifecycle: input.verdict.lifecycle,
		terminalSeal: null,
		supersedesPacketDigest: null,
		packetDigest: "0".repeat(64),
		packetBytes: 0,
	});
	if (input.verdict.verdict !== "rejected" || input.verdict.requiredDisposition !== "dispatch_amendment") {
		fail(
			"dispatch_disposition_invalid",
			"Only a rejected verdict requiring amendment dispatch can produce an amendment task.",
		);
	}
	const blockerIds = input.verdict.topBlockers.map((blocker) => blocker.blockerId);
	const closureIds = input.remediation.blockerClosureMapping.map((mapping) => mapping.blockerId);
	for (const blockerId of blockerIds)
		if (!closureIds.includes(blockerId))
			fail("blocker_closure_missing", `Remediation does not close blocker ${blockerId}.`);
	const amendmentIds = new Set(input.remediation.amendments.map((amendment) => amendment.amendmentId));
	const requirementMappings = new Map(
		input.remediation.requirementClosureMapping.map((mapping) => [mapping.requirementId, mapping]),
	);
	for (const requirementId of input.verdict.requirementIds) {
		const mapping = requirementMappings.get(requirementId);
		if (
			mapping === undefined ||
			(mapping.amendmentIds.length === 0 && mapping.blockedAction === null) ||
			mapping.amendmentIds.some((amendmentId) => !amendmentIds.has(amendmentId))
		)
			fail(
				"requirement_closure_missing",
				`Requirement ${requirementId} lacks an exact actionable amendment or blocked action.`,
			);
	}
	const unsigned = {
		kind: "workflow-decision-amendment-task",
		workflowId: input.verdict.workflowId,
		parentTaskId: input.verdict.taskId,
		attemptId: input.verdict.attemptId,
		objective: input.remediation.requiredNextAction,
		blockerIds,
		requirementIds: input.verdict.requirementIds,
		dependencies: input.remediation.dependencies,
		owner: input.remediation.ownership.owner,
		ownedPaths: input.remediation.ownership.writeScope,
		requiredNextAction: input.remediation.requiredNextAction,
		publicAcceptanceChecks: input.remediation.publicAcceptanceChecks,
		blockerClosureMapping: input.remediation.blockerClosureMapping,
		requirementClosureMapping: input.remediation.requirementClosureMapping,
	};
	return cloneAndFreeze({
		taskId: `${input.verdict.taskId}:amendment`,
		workflowId: input.verdict.workflowId,
		parentTaskId: input.verdict.taskId,
		attemptId: input.verdict.attemptId,
		objective: input.remediation.requiredNextAction,
		blockerIds,
		requirementIds: input.verdict.requirementIds,
		dependencies: input.remediation.dependencies,
		owner: input.remediation.ownership.owner,
		ownedPaths: input.remediation.ownership.writeScope,
		requiredNextAction: input.remediation.requiredNextAction,
		publicAcceptanceChecks: input.remediation.publicAcceptanceChecks,
		blockerClosureMapping: input.remediation.blockerClosureMapping,
		requirementClosureMapping: input.remediation.requirementClosureMapping,
		dispatchDigest: digestObject(unsigned),
	});
}

function assertTokenCount(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0)
		fail("token_budget_invalid", `${label} must be a non-negative safe integer.`);
}

function bytesToTokens(bytes: number): number {
	if (!Number.isSafeInteger(bytes) || bytes < 0) fail("byte_budget_invalid", "Byte count is invalid.");
	return safeAdd(bytes, 0, "token estimate");
}

/**
 * Estimate bytes as bounded context tokens for admission without permitting full report reads.
 * Args: Non-negative artifact or packet byte count.
 * Return: Conservative worst-case token estimate where every byte may consume a token.
 */
export function estimateWorkflowDecisionPacketTokens(bytes: number): number {
	if (!Number.isSafeInteger(bytes) || bytes < 0)
		fail("byte_budget_invalid", "Byte estimate must be a non-negative safe integer.");
	return bytesToTokens(bytes);
}

/**
 * Admit a packet into the coordinator context budget while preserving selective-expansion reserve.
 * Args: Current context estimate, reserve/headroom, packet/report/section sizes, and hard budget.
 * Return: Host admission disposition; full-report read_text is always forbidden.
 */
export function admitWorkflowDecisionPacketIngest(
	input: WorkflowDecisionPacketIngestAdmissionInput,
): WorkflowDecisionPacketIngestAdmissionResult {
	for (const [label, value] of [
		["currentEstimatedContextTokens", input.currentEstimatedContextTokens],
		["reserveTokens", input.reserveTokens],
		["headroomTokens", input.headroomTokens],
		["packetEstimateBytes", input.packetEstimateBytes],
		["artifactSizeBytes", input.artifactSizeBytes],
		["sectionSizeBytes", input.sectionSizeBytes],
		["hardIngestBudgetTokens", input.hardIngestBudgetTokens],
	] as const) {
		if (label.endsWith("Bytes")) {
			if (!Number.isSafeInteger(value) || value < 0)
				fail("byte_budget_invalid", `${label} must be a non-negative safe integer.`);
		} else assertTokenCount(value, label);
	}
	const selectiveExpansionOverheadTokens = input.selectiveExpansionOverheadTokens ?? 0;
	const compactionOverheadTokens = input.compactionOverheadTokens ?? 0;
	const blockerReserveTokens =
		input.blockerReserveTokens ?? WORKFLOW_DECISION_PACKET_LIMITS.defaultBlockerReserveTokens;
	assertTokenCount(selectiveExpansionOverheadTokens, "selectiveExpansionOverheadTokens");
	assertTokenCount(compactionOverheadTokens, "compactionOverheadTokens");
	assertTokenCount(blockerReserveTokens, "blockerReserveTokens");
	if (input.runtimeStore !== undefined && input.runtimeStore.identity.workflowId.trim().length === 0)
		fail("binding_invalid", "Runtime store workflow identity is empty.");
	const packetTokens = bytesToTokens(input.packetEstimateBytes);
	const artifactTokens = bytesToTokens(input.artifactSizeBytes);
	const sectionTokens = bytesToTokens(input.sectionSizeBytes);
	let overheadTokens = safeAdd(selectiveExpansionOverheadTokens, compactionOverheadTokens, "ingest overhead");
	overheadTokens = safeAdd(overheadTokens, blockerReserveTokens, "ingest overhead");
	let committedTokens = safeAdd(input.currentEstimatedContextTokens, input.reserveTokens, "ingest committed tokens");
	committedTokens = safeAdd(committedTokens, input.headroomTokens, "ingest committed tokens");
	committedTokens = safeAdd(committedTokens, overheadTokens, "ingest committed tokens");
	const availableTokens = input.hardIngestBudgetTokens - committedTokens;
	const packetFits = availableTokens >= packetTokens;
	const sectionFits = packetFits && availableTokens - packetTokens >= sectionTokens;
	const artifactFits = packetFits && availableTokens - packetTokens >= artifactTokens;
	const disposition: WorkflowDecisionIngestDisposition = !packetFits
		? "child_synthesis_required"
		: !artifactFits && sectionFits
			? "section_required"
			: !sectionFits
				? "child_synthesis_required"
				: "accepted";
	return cloneAndFreeze({
		disposition,
		permittedRead: disposition === "child_synthesis_required" ? "packet_only" : "declared_sections",
		fullReportRead: "forbidden",
		availableTokens,
		packetTokens,
		artifactTokens,
		sectionTokens,
		overheadTokens,
		blockerReserveTokens,
	});
}

export const createWorkflowVerdictDecisionPacket = createWorkflowVerdictPacket;
export const createWorkflowRemediationDecisionPacket = createWorkflowRemediationPacket;
export const createWorkflowEvidenceDecisionManifest = createWorkflowEvidenceManifest;
export const createWorkflowTerminalDecisionPacket = createWorkflowTerminalDecisionPacketTriad;
export const validateWorkflowDecisionPackets = validateWorkflowDecisionPacketDelivery;
export const selectivelyExpandWorkflowDecisionPacket = selectivelyExpandWorkflowDecisionEvidence;
export const admitWorkflowDecisionIngest = admitWorkflowDecisionPacketIngest;
