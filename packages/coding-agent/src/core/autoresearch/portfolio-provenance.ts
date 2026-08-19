import {
	canonicalJsonBytes,
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowJournalHead,
	type WorkflowRuntimeStore,
	type WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";
import {
	AUTO_RESEARCH_PROVENANCE,
	type AutoResearchProvenanceRecord,
	validateCleanRoomManifest,
} from "./provenance.js";
import { parseV2Events, parseV2Run } from "./types.js";

/** The only schema accepted for a legacy provenance import envelope. */
export const AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_SCHEMA_VERSION = 1 as const;

/** The only legacy run schema that may be retained as provenance evidence. */
export const AUTO_RESEARCH_LEGACY_SCALAR_RUN_SCHEMA_VERSION = 2 as const;

const MAX_IMPORT_BYTES = 4_000_000;
const MAX_EVENT_RECORDS = 4_096;
const MAX_TEXT_BYTES = 16_384;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const PRODUCTION_EVIDENCE_ARTIFACT_ID = /^evidence:[0-9a-f]{64}$/u;
const PRODUCTION_EVIDENCE_ARTIFACT_PATH = /^artifacts\/evidence\/[0-9a-f]{64}$/u;

const IMPORT_KEYS = [
	"schemaVersion",
	"kind",
	"operation",
	"artifact",
	"legacyArtifactRef",
	"provenance",
	"receipt",
	"receiptContext",
	"workflowId",
	"hostContext",
] as const;

const ARTIFACT_KEYS = ["schemaVersion", "runJson", "eventsJsonl", "contentDigest"] as const;
const PROVENANCE_KEYS = [
	"source",
	"commit",
	"treeDigest",
	"locatorDigest",
	"approvalDigest",
	"noGrantScanDigest",
	"license",
	"copyright",
	"reuse",
] as const;
const RECEIPT_KEYS = [
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
const RECEIPT_CAPABILITY_BINDING_KEYS = [
	"capability",
	"resourceDigest",
	"operationDigest",
	"executionIdentity",
	"sessionId",
] as const;
const ARTIFACT_REF_KEYS = ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"] as const;
const HOST_CONTEXT_KEYS = ["runtimeStore", "now", "executionIdentity", "sessionId"] as const;

export const AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_CAPABILITY =
	"autoresearch.legacy_scalar_provenance_import" as const;

const AUTO_RESEARCH_LEGACY_PROVENANCE_OPERATION = "import" as const;

export interface AutoResearchLegacyProvenanceTrustedHostContext {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly now: () => string;
	readonly executionIdentity: string;
	readonly sessionId: string;
}

export interface AutoResearchLegacyScalarRunArtifact {
	readonly schemaVersion: typeof AUTO_RESEARCH_LEGACY_SCALAR_RUN_SCHEMA_VERSION;
	readonly runJson: string;
	readonly eventsJsonl: string;
	readonly contentDigest: string;
}

export interface AutoResearchLegacyProvenanceBindingInput {
	readonly legacyArtifactRef: WorkflowArtifactRef;
	readonly contentDigest: string;
	readonly legalProvenanceDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly executionIdentity: string;
	readonly sessionId: string;
	readonly workflowEpoch: WorkflowEpochRef;
	readonly journalHead: WorkflowJournalHead;
	readonly stateDigest: string;
	readonly revision: number;
}

export interface AutoResearchLegacyProvenanceResourceInput {
	readonly legacyArtifactRef: WorkflowArtifactRef;
	readonly contentDigest: string;
	readonly legalProvenanceDigest: string;
}

export interface AutoResearchLegacyProvenanceOperationInput {
	readonly workflowId: string;
	readonly resourceDigest: string;
	readonly executionIdentity: string;
	readonly sessionId: string;
}

/**
 * Derive the canonical resource binding presented to the generic host authorizer.
 *
 * Args:
 * input: The canonical legacy artifact, content digest, and approved legal manifest digest.
 * Return: SHA-256 resource digest for the read-only import capability.
 */
export function computeAutoResearchLegacyProvenanceResourceDigest(
	input: AutoResearchLegacyProvenanceResourceInput,
): string {
	return digestObject({
		kind: "autoresearch.legacy_scalar_run_provenance.resource",
		legacyArtifactRef: input.legacyArtifactRef,
		contentDigest: input.contentDigest,
		legalProvenanceDigest: input.legalProvenanceDigest,
	});
}

/**
 * Derive the operation/execution/session binding presented to the generic host authorizer.
 *
 * Args:
 * input: Workflow identity, resource digest, and trusted execution/session identities.
 * Return: SHA-256 operation digest for the read-only import capability.
 */
export function computeAutoResearchLegacyProvenanceOperationDigest(
	input: AutoResearchLegacyProvenanceOperationInput,
): string {
	return digestObject({
		kind: "autoresearch.legacy_scalar_run_provenance.operation",
		capability: AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_CAPABILITY,
		operation: AUTO_RESEARCH_LEGACY_PROVENANCE_OPERATION,
		workflowId: input.workflowId,
		resourceDigest: input.resourceDigest,
		executionIdentity: input.executionIdentity,
		sessionId: input.sessionId,
	});
}

/**
 * Derive the receipt binding for one legacy provenance import.
 *
 * Args:
 * input: The immutable legacy artifact, legal provenance, current epoch/head, and workflow state.
 * Return: Canonical SHA-256 binding digest for host receipt authorization.
 */
export function computeAutoResearchLegacyProvenanceBindingDigest(
	input: AutoResearchLegacyProvenanceBindingInput,
): string {
	return digestObject({
		capability: AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_CAPABILITY,
		operation: AUTO_RESEARCH_LEGACY_PROVENANCE_OPERATION,
		legacyArtifactRef: input.legacyArtifactRef,
		contentDigest: input.contentDigest,
		legalProvenanceDigest: input.legalProvenanceDigest,
		resourceDigest: input.resourceDigest,
		operationDigest: input.operationDigest,
		executionIdentity: input.executionIdentity,
		sessionId: input.sessionId,
		workflowEpoch: input.workflowEpoch,
		journalHead: input.journalHead,
		stateDigest: input.stateDigest,
		revision: input.revision,
	});
}

export interface AutoResearchLegacyProvenanceImportInput {
	readonly schemaVersion: typeof AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_SCHEMA_VERSION;
	readonly kind: "legacy_scalar_run_provenance_import";
	readonly operation: "import";
	readonly artifact: AutoResearchLegacyScalarRunArtifact;
	readonly legacyArtifactRef: WorkflowArtifactRef;
	readonly provenance: AutoResearchProvenanceRecord;
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly workflowId: string;
	readonly hostContext: AutoResearchLegacyProvenanceTrustedHostContext;
}

export interface AutoResearchLegacyProvenanceEvidence {
	readonly schemaVersion: typeof AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_SCHEMA_VERSION;
	readonly kind: "legacy_scalar_run_provenance_evidence";
	readonly legacyRunId: string;
	readonly contentDigest: string;
	readonly contentBytes: readonly number[];
	readonly legacyArtifactRef: WorkflowArtifactRef;
	readonly provenance: AutoResearchProvenanceRecord;
	readonly hostReceipt: WorkflowVerifiedHostReceipt;
}

interface ParsedArtifactRef {
	readonly ref: WorkflowArtifactRef;
}

interface ParsedImport {
	readonly artifact: AutoResearchLegacyScalarRunArtifact;
	readonly artifactBytes: Uint8Array;
	readonly legacyArtifactRef: WorkflowArtifactRef;
	readonly runId: string;
	readonly provenance: AutoResearchProvenanceRecord;
	readonly bindingDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly executionIdentity: string;
	readonly sessionId: string;
	readonly currentEpoch: WorkflowEpochRef;
	readonly currentStateDigest: string;
	readonly currentRevision: number;
	readonly trustedNow: string;
}

function fail(label: string, detail: string): never {
	throw new Error(`AutoResearch legacy provenance ${label}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) fail(label, "must be a plain object");
	return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const ownKeys = Reflect.ownKeys(value);
	const nonStringKey = ownKeys.find((key) => typeof key !== "string");
	if (nonStringKey !== undefined) fail(label, "contains a symbol or non-string field");
	const nonEnumerableKey = ownKeys.find(
		(key) => typeof key === "string" && !Object.prototype.propertyIsEnumerable.call(value, key),
	);
	if (nonEnumerableKey !== undefined) fail(label, `field ${String(nonEnumerableKey)} must be enumerable`);
	const actual = ownKeys as string[];
	actual.sort();
	const keys = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(keys)) {
		const unknown = actual.filter((key) => !keys.includes(key));
		fail(label, unknown.length > 0 ? `unknown field(s): ${unknown.join(", ")}` : "has an incomplete field set");
	}
}

function text(value: unknown, label: string, maximumBytes = MAX_TEXT_BYTES): string {
	if (typeof value !== "string" || value.length === 0 || value.trim().length === 0)
		fail(label, "must be non-empty text");
	if (new TextEncoder().encode(value).byteLength > maximumBytes) fail(label, `exceeds ${maximumBytes} UTF-8 bytes`);
	return value;
}

function digest(value: unknown, label: string): string {
	const result = text(value, label, 64);
	if (!SHA256.test(result)) fail(label, "must be a lowercase SHA-256 digest");
	return result;
}

function safeInteger(value: unknown, label: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		fail(label, `must be a safe integer greater than or equal to ${minimum}`);
	return value;
}

function positiveInteger(value: unknown, label: string): number {
	return safeInteger(value, label, 1);
}

function finiteDate(value: unknown, label: string): string {
	const result = text(value, label, 128);
	if (!Number.isFinite(Date.parse(result))) fail(label, "must be an ISO date");
	return result;
}

function parseJsonText(value: string, label: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch (error) {
		fail(label, `is not valid JSON: ${String(error)}`);
	}
}

function cloneAndFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Object.isFrozen(value)) return value;
	for (const key of Reflect.ownKeys(value)) {
		cloneAndFreeze(Reflect.get(value, key));
	}
	return Object.freeze(value);
}

function parseProvenance(value: unknown): AutoResearchProvenanceRecord {
	const item = record(value, "provenance");
	exactKeys(item, PROVENANCE_KEYS, "provenance");
	const source = text(item.source, "provenance.source", 128);
	if (source !== "autoresearch-behavior" && source !== "linked-workflow-design")
		fail("provenance.source", "is not an approved provenance source");
	const commit = text(item.commit, "provenance.commit", 40);
	if (!COMMIT.test(commit)) fail("provenance.commit", "must be a 40-character lowercase commit");
	const optionalDigest = (entry: unknown, label: string): string | null =>
		entry === null ? null : digest(entry, label);
	const copyright = item.copyright === null ? null : text(item.copyright, "provenance.copyright", 512);
	const license = text(item.license, "provenance.license", 512);
	if (item.reuse !== "behavioral-notes-and-fixtures-only" && item.reuse !== "no-source-reuse")
		fail("provenance.reuse", "is not an approved reuse disposition");
	const parsed = cloneAndFreeze({
		source,
		commit,
		treeDigest: optionalDigest(item.treeDigest, "provenance.treeDigest"),
		locatorDigest: optionalDigest(item.locatorDigest, "provenance.locatorDigest"),
		approvalDigest: optionalDigest(item.approvalDigest, "provenance.approvalDigest"),
		noGrantScanDigest: optionalDigest(item.noGrantScanDigest, "provenance.noGrantScanDigest"),
		license,
		copyright,
		reuse: item.reuse,
	} satisfies AutoResearchProvenanceRecord);
	try {
		validateCleanRoomManifest();
	} catch (error) {
		fail("provenance", `approved clean-room manifest is invalid: ${String(error)}`);
	}
	if (!AUTO_RESEARCH_PROVENANCE.some((approved) => digestObject(approved) === digestObject(parsed)))
		fail("provenance", "does not match the approved legal clean-room manifest");
	return parsed;
}

function parseArtifact(value: unknown): {
	artifact: AutoResearchLegacyScalarRunArtifact;
	runId: string;
	artifactBytes: Uint8Array;
} {
	const item = record(value, "artifact");
	exactKeys(item, ARTIFACT_KEYS, "artifact");
	if (item.schemaVersion !== AUTO_RESEARCH_LEGACY_SCALAR_RUN_SCHEMA_VERSION)
		fail("artifact.schemaVersion", "only legacy scalar schema version 2 is accepted");
	const runJson = text(item.runJson, "artifact.runJson", MAX_IMPORT_BYTES);
	const eventsJsonl = text(item.eventsJsonl, "artifact.eventsJsonl", MAX_IMPORT_BYTES);
	const artifactBytes = canonicalJsonBytes({ runJson, eventsJsonl });
	if (artifactBytes.byteLength > MAX_IMPORT_BYTES) fail("artifact", `exceeds ${MAX_IMPORT_BYTES} bytes`);
	const eventLines = eventsJsonl.split(/\r?\n/u);
	if (eventLines.at(-1) === "") eventLines.pop();
	if (eventLines.some((line) => line.length === 0)) fail("artifact.eventsJsonl", "contains an empty event record");
	if (eventLines.length === 0 || eventLines.length > MAX_EVENT_RECORDS)
		fail("artifact.eventsJsonl", "must contain a bounded non-empty event list");
	const contentDigest = digest(item.contentDigest, "artifact.contentDigest");
	if (contentDigest !== sha256Hex(artifactBytes))
		fail("artifact.contentDigest", "does not match the exact artifact bytes");
	const run = parseV2Run(parseJsonText(runJson, "artifact.runJson"));
	const events = parseV2Events(eventsJsonl);
	if (events.length !== eventLines.length) fail("artifact.eventsJsonl", "contains an unsupported event line ending");
	const firstEvent = events[0];
	if (firstEvent?.event !== "baseline") fail("artifact.eventsJsonl", "must begin with the legacy baseline event");
	if (run.schema_version !== AUTO_RESEARCH_LEGACY_SCALAR_RUN_SCHEMA_VERSION)
		fail("artifact", "run schema is not legacy scalar v2");
	if (events.some((event) => event.run_id !== run.run_id))
		fail("artifact.eventsJsonl", "run IDs do not match run.json");
	return {
		artifact: { schemaVersion: 2, runJson, eventsJsonl, contentDigest },
		runId: run.run_id,
		artifactBytes,
	};
}

function parseArtifactId(value: unknown, label: string, artifactDigest: string): string {
	const artifactId = text(value, label, 128);
	if (
		artifactId === "." ||
		artifactId === ".." ||
		CONTROL.test(artifactId) ||
		artifactId.includes("/") ||
		artifactId.includes("\\")
	)
		fail(label, "must be a safe relative artifact identifier");
	if (!PRODUCTION_EVIDENCE_ARTIFACT_ID.test(artifactId) || artifactId !== `evidence:${artifactDigest}`)
		fail(label, "must be the canonical production evidence artifact identifier");
	return artifactId;
}

function parseArtifactPath(value: unknown, label: string, artifactDigest: string): string {
	const relativePath = text(value, label, 512);
	if (
		CONTROL.test(relativePath) ||
		relativePath.startsWith("/") ||
		relativePath.startsWith("\\") ||
		relativePath.includes("\\")
	)
		fail(label, "must be a safe relative artifact path");
	if (!PRODUCTION_EVIDENCE_ARTIFACT_PATH.test(relativePath) || relativePath !== `artifacts/evidence/${artifactDigest}`)
		fail(label, "must be the canonical production evidence artifact path");
	return relativePath;
}

function parseArtifactRef(value: unknown, label: string): ParsedArtifactRef {
	const item = record(value, label);
	exactKeys(item, ARTIFACT_REF_KEYS, label);
	const artifactDigest = digest(item.digest, `${label}.digest`);
	const ref: WorkflowArtifactRef = {
		artifactId: parseArtifactId(item.artifactId, `${label}.artifactId`, artifactDigest),
		relativePath: parseArtifactPath(item.relativePath, `${label}.relativePath`, artifactDigest),
		digest: artifactDigest,
		sizeBytes: safeInteger(item.sizeBytes, `${label}.sizeBytes`, 0),
		sourceEventSequence: safeInteger(item.sourceEventSequence, `${label}.sourceEventSequence`, 0),
	};
	if (ref.sizeBytes > MAX_IMPORT_BYTES) fail(`${label}.sizeBytes`, `exceeds ${MAX_IMPORT_BYTES} bytes`);
	return { ref };
}

function parseEpoch(value: unknown, label: string): WorkflowEpochRef {
	const item = record(value, label);
	exactKeys(item, ["storeEpoch", "coordinatorEpoch"], label);
	return {
		storeEpoch: safeInteger(item.storeEpoch, `${label}.storeEpoch`, 0),
		coordinatorEpoch: safeInteger(item.coordinatorEpoch, `${label}.coordinatorEpoch`, 0),
	};
}

function parseJournalHead(
	value: unknown,
	workflowId: string,
	epoch: WorkflowEpochRef,
	label: string,
): WorkflowJournalHead {
	const item = record(value, label);
	exactKeys(item, ["workflowId", "sequence", "eventDigest", "epochRef"], label);
	const headWorkflowId = text(item.workflowId, `${label}.workflowId`, 256);
	if (headWorkflowId !== workflowId) fail(`${label}.workflowId`, "does not match workflowId");
	const eventDigest = item.eventDigest === null ? null : digest(item.eventDigest, `${label}.eventDigest`);
	const headEpoch = parseEpoch(item.epochRef, `${label}.epochRef`);
	if (digestObject(headEpoch) !== digestObject(epoch))
		fail(`${label}.epochRef`, "does not match the authenticated host epoch");
	return {
		workflowId: headWorkflowId,
		sequence: safeInteger(item.sequence, `${label}.sequence`, 0),
		eventDigest,
		epochRef: headEpoch,
	};
}

function validateReceiptShape(receipt: WorkflowVerifiedHostReceipt): void {
	const item = record(receipt, "receipt");
	exactKeys(item, [...RECEIPT_KEYS, "capabilityBinding"], "receipt");
	if (receipt.receiptKind !== "capability") fail("receipt.receiptKind", "must be capability");
	if (receipt.oneUse !== true) fail("receipt.oneUse", "must be a one-use host receipt");
	text(receipt.receiptId, "receipt.receiptId", 256);
	text(receipt.issuerId, "receipt.issuerId", 256);
	text(receipt.workflowId, "receipt.workflowId", 256);
	digest(receipt.bindingDigest, "receipt.bindingDigest");
	digest(receipt.payloadDigest, "receipt.payloadDigest");
	const capabilityBinding = record(receipt.capabilityBinding, "receipt.capabilityBinding");
	exactKeys(capabilityBinding, RECEIPT_CAPABILITY_BINDING_KEYS, "receipt.capabilityBinding");
	if (capabilityBinding.capability !== AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_CAPABILITY)
		fail("receipt.capabilityBinding.capability", "is not the legacy provenance import capability");
	digest(capabilityBinding.resourceDigest, "receipt.capabilityBinding.resourceDigest");
	digest(capabilityBinding.operationDigest, "receipt.capabilityBinding.operationDigest");
	if (typeof capabilityBinding.executionIdentity !== "string" || capabilityBinding.executionIdentity.length === 0)
		fail("receipt.capabilityBinding.executionIdentity", "must be a non-empty execution identity");
	if (typeof capabilityBinding.sessionId !== "string" || capabilityBinding.sessionId.length === 0)
		fail("receipt.capabilityBinding.sessionId", "must be a non-empty session identity");
	const receiptArtifactRef = parseArtifactRef(receipt.artifactRef, "receipt.artifactRef").ref;
	finiteDate(receipt.issuedAt, "receipt.issuedAt");
	finiteDate(receipt.validUntil, "receipt.validUntil");
	text(receipt.keyId, "receipt.keyId", 256);
	if (receipt.signatureAlgorithm !== "ed25519") fail("receipt.signatureAlgorithm", "must be ed25519");
	digest(receipt.artifactBytesDigest, "receipt.artifactBytesDigest");
	digest(receipt.stateDigest, "receipt.stateDigest");
	positiveInteger(receipt.revision, "receipt.revision");
	if (receipt.artifactBytesDigest !== receiptArtifactRef.digest)
		fail("receipt.artifactBytesDigest", "does not match the receipt envelope artifact digest");
	if (receiptArtifactRef.sourceEventSequence !== receipt.revision)
		fail("receipt.artifactRef.sourceEventSequence", "does not match the receipt revision");
	if (typeof receipt.signature !== "string" || !BASE64.test(receipt.signature) || receipt.signature.length === 0)
		fail("receipt.signature", "must contain a non-empty signature");
	digest(receipt.verificationDigest, "receipt.verificationDigest");
}

function validatePrincipalAuthorizationDecision(
	decision: WorkflowHostPrincipalCapabilityAuthorization,
	expected: WorkflowHostPrincipalCapabilityAuthorizationInput,
): void {
	const item = record(decision, "principalAuthorization");
	exactKeys(
		item,
		[
			"authenticatedPrincipal",
			"keyOwnerPrincipal",
			"capability",
			"workflowId",
			"bindingDigest",
			"receipt",
			"stateDigest",
			"revision",
			"epochRef",
			"validity",
			"executionIdentity",
			"sessionId",
			"authorizationDigest",
		],
		"principalAuthorization",
	);
	const authenticatedPrincipal = text(
		decision.authenticatedPrincipal,
		"principalAuthorization.authenticatedPrincipal",
		256,
	);
	const keyOwnerPrincipal = text(decision.keyOwnerPrincipal, "principalAuthorization.keyOwnerPrincipal", 256);
	if (authenticatedPrincipal !== keyOwnerPrincipal)
		fail("principalAuthorization", "authenticated principal and key owner are not cross-bound");
	if (
		decision.capability !== expected.capability ||
		decision.workflowId !== expected.workflowId ||
		decision.bindingDigest !== expected.bindingDigest ||
		decision.stateDigest !== expected.stateDigest ||
		decision.revision !== expected.revision ||
		decision.executionIdentity !== expected.executionIdentity ||
		decision.sessionId !== expected.sessionId ||
		digestObject(decision.receipt) !== digestObject(expected.receipt)
	)
		fail("principalAuthorization", "is detached from the import authorization tuple");
	const epoch = parseEpoch(decision.epochRef, "principalAuthorization.epochRef");
	if (digestObject(epoch) !== digestObject(expected.epochRef))
		fail("principalAuthorization.epochRef", "is detached from the live host epoch");
	const validity = record(decision.validity, "principalAuthorization.validity");
	exactKeys(validity, ["issuedAt", "validUntil"], "principalAuthorization.validity");
	if (validity.issuedAt !== expected.receipt.issuedAt || validity.validUntil !== expected.receipt.validUntil) {
		fail("principalAuthorization.validity", "is detached from the verified host receipt");
	}
	finiteDate(validity.issuedAt, "principalAuthorization.validity.issuedAt");
	finiteDate(validity.validUntil, "principalAuthorization.validity.validUntil");
	digest(decision.authorizationDigest, "principalAuthorization.authorizationDigest");
}

interface TrustedCurrentWorkflowTuple {
	readonly epoch: WorkflowEpochRef;
	readonly journalHead: WorkflowJournalHead;
	readonly stateDigest: string;
	readonly revision: number;
	readonly trustedNow: string;
	readonly executionIdentity: string;
	readonly sessionId: string;
}

async function resolveTrustedCurrentWorkflowTuple(
	hostContext: AutoResearchLegacyProvenanceTrustedHostContext,
	workflowId: string,
): Promise<TrustedCurrentWorkflowTuple> {
	const contextRecord = record(hostContext, "hostContext");
	exactKeys(contextRecord, HOST_CONTEXT_KEYS, "hostContext");
	if (typeof hostContext.now !== "function") fail("hostContext.now", "must be a host-owned clock function");
	const executionIdentity = text(hostContext.executionIdentity, "hostContext.executionIdentity", 256);
	const sessionId = text(hostContext.sessionId, "hostContext.sessionId", 256);
	const runtimeStoreValue: unknown = hostContext.runtimeStore;
	if (
		runtimeStoreValue === null ||
		typeof runtimeStoreValue !== "object" ||
		typeof Reflect.get(runtimeStoreValue, "replay") !== "function"
	)
		fail("hostContext.runtimeStore", "is not bound to the import workflow");
	const runtimeStoreIdentity: unknown = hostContext.runtimeStore.identity;
	if (!isRecord(runtimeStoreIdentity) || runtimeStoreIdentity.workflowId !== workflowId)
		fail("hostContext.runtimeStore", "is not bound to the import workflow");
	const runtimeStore = hostContext.runtimeStore;
	const durable = runtimeStore.durableContext;
	if (durable === undefined || typeof durable !== "object")
		fail("hostContext.runtimeStore", "does not expose durable authenticated workflow state");
	const epoch = parseEpoch(durable.epochRef, "hostContext.runtimeStore.durableContext.epochRef");
	if (typeof durable.currentLeaseRef !== "function")
		fail("hostContext.runtimeStore.durableContext.currentLeaseRef", "must be a host-owned lease reader");
	const currentLease = durable.currentLeaseRef();
	if (currentLease === null || typeof currentLease !== "object")
		fail("hostContext.runtimeStore.durableContext.currentLeaseRef", "did not return a lease reference");
	const leaseEpoch = parseEpoch(
		{ storeEpoch: currentLease.storeEpoch, coordinatorEpoch: currentLease.coordinatorEpoch },
		"hostContext.runtimeStore.durableContext.currentLeaseRef.epochRef",
	);
	if (digestObject(leaseEpoch) !== digestObject(epoch))
		fail("hostContext.runtimeStore", "does not expose the current lease epoch");
	const leaseExecutionIdentity = text(
		currentLease.processIdentity,
		"hostContext.runtimeStore.durableContext.currentLeaseRef.processIdentity",
		256,
	);
	if (leaseExecutionIdentity !== executionIdentity)
		fail("hostContext.executionIdentity", "is not the live runtime execution identity");
	let replay: Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>;
	try {
		replay = await runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epoch.storeEpoch });
	} catch (error) {
		throw new Error(`AutoResearch legacy provenance host context replay failed: ${String(error)}`, { cause: error });
	}
	if (
		replay.workflowId !== workflowId ||
		replay.quarantined !== false ||
		replay.head.eventDigest === null ||
		replay.head.sequence < 1
	)
		fail("hostContext.runtimeStore", "does not expose an authenticated, non-quarantined current head");
	const journalHead = parseJournalHead(replay.head, workflowId, epoch, "hostContext.currentJournalHead");
	if (journalHead.eventDigest === null) fail("hostContext.currentJournalHead.eventDigest", "must be authenticated");
	const trustedNow = hostContext.now();
	finiteDate(trustedNow, "hostContext.now");
	return {
		epoch,
		journalHead,
		stateDigest: journalHead.eventDigest,
		revision: positiveInteger(journalHead.sequence, "hostContext.currentRevision"),
		trustedNow,
		executionIdentity,
		sessionId,
	};
}

function validateConsumptionWitness(
	witness: WorkflowHostReceiptConsumptionWitness,
	receipt: WorkflowVerifiedHostReceipt,
	workflowId: string,
	bindingDigest: string,
): void {
	const item = record(witness, "receiptConsumptionWitness");
	exactKeys(
		item,
		["receiptId", "workflowId", "bindingDigest", "consumedAt", "consumptionSequence"],
		"receiptConsumptionWitness",
	);
	if (witness.receiptId !== receipt.receiptId) fail("receiptConsumptionWitness.receiptId", "does not match receipt");
	if (witness.workflowId !== workflowId) fail("receiptConsumptionWitness.workflowId", "does not match workflow");
	if (witness.bindingDigest !== bindingDigest)
		fail("receiptConsumptionWitness.bindingDigest", "does not match the derived import binding");
	finiteDate(witness.consumedAt, "receiptConsumptionWitness.consumedAt");
	positiveInteger(witness.consumptionSequence, "receiptConsumptionWitness.consumptionSequence");
}

function bytesEqual(left: Readonly<Uint8Array>, right: Readonly<Uint8Array>): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function resolveAndVerifyArtifact(
	context: WorkflowHostReceiptConsumerContext,
	ref: WorkflowArtifactRef,
	expectedBytes: Readonly<Uint8Array> | null,
	label: string,
): Promise<Readonly<Uint8Array>> {
	const artifact = await context.artifactResolver.resolve(ref);
	const readResult = record(artifact, `${label}.resolverResult`);
	exactKeys(
		readResult,
		["envelope", "exists", "bytes", "verifiedDigest", "verifiedSizeBytes"],
		`${label}.resolverResult`,
	);
	const envelope = record(artifact.envelope, `${label}.envelope`);
	exactKeys(envelope, ["ref", "payloadKind", "codec", "immutable"], `${label}.envelope`);
	const envelopeRef = parseArtifactRef(artifact.envelope.ref, `${label}.envelope.ref`).ref;
	if (
		!artifact.exists ||
		artifact.envelope.immutable !== true ||
		artifact.envelope.payloadKind !== "evidence" ||
		artifact.envelope.codec !== "canonical_json" ||
		!(artifact.bytes instanceof Uint8Array) ||
		digestObject(envelopeRef) !== digestObject(ref) ||
		artifact.verifiedDigest !== ref.digest ||
		artifact.verifiedSizeBytes !== ref.sizeBytes ||
		artifact.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(artifact.bytes) !== ref.digest
	)
		fail(label, "is not resolver-verified and content-addressed");
	if (expectedBytes !== null && !bytesEqual(artifact.bytes, expectedBytes))
		fail(label, "does not contain the exact canonical legacy bytes");
	return artifact.bytes;
}

async function validateImportInput(input: AutoResearchLegacyProvenanceImportInput): Promise<ParsedImport> {
	const item = record(input, "import");
	exactKeys(item, IMPORT_KEYS, "import");
	if (input.schemaVersion !== AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_SCHEMA_VERSION)
		fail("schemaVersion", "only import schema version 1 is accepted");
	if (input.kind !== "legacy_scalar_run_provenance_import") fail("kind", "is not the strict legacy import kind");
	if (input.operation !== "import")
		fail("operation", "legacy scalar runs are read-only provenance and cannot be resumed");
	const workflowId = text(input.workflowId, "workflowId", 256);
	const parsedArtifact = parseArtifact(input.artifact);
	const legacyArtifactRef = parseArtifactRef(input.legacyArtifactRef, "legacyArtifactRef").ref;
	if (legacyArtifactRef.digest !== parsedArtifact.artifact.contentDigest)
		fail("legacyArtifactRef.digest", "does not match the exact canonical legacy bytes");
	if (legacyArtifactRef.sizeBytes !== parsedArtifact.artifactBytes.byteLength)
		fail("legacyArtifactRef.sizeBytes", "does not match the exact canonical legacy bytes");
	const provenance = parseProvenance(input.provenance);
	const current = await resolveTrustedCurrentWorkflowTuple(input.hostContext, workflowId);
	const legalProvenanceDigest = digestObject(provenance);
	const resourceDigest = computeAutoResearchLegacyProvenanceResourceDigest({
		legacyArtifactRef,
		contentDigest: parsedArtifact.artifact.contentDigest,
		legalProvenanceDigest,
	});
	const operationDigest = computeAutoResearchLegacyProvenanceOperationDigest({
		workflowId,
		resourceDigest,
		executionIdentity: current.executionIdentity,
		sessionId: current.sessionId,
	});
	validateReceiptShape(input.receipt);
	if (input.receipt.workflowId !== workflowId) fail("receipt.workflowId", "does not match the import workflow");
	if (input.receipt.stateDigest !== current.stateDigest)
		fail("receipt.stateDigest", "does not match current workflow state");
	if (input.receipt.revision !== current.revision)
		fail("receipt.revision", "does not match current workflow revision");
	const capabilityBinding = input.receipt.capabilityBinding!;
	if (
		capabilityBinding.resourceDigest !== resourceDigest ||
		capabilityBinding.operationDigest !== operationDigest ||
		capabilityBinding.executionIdentity !== current.executionIdentity ||
		capabilityBinding.sessionId !== current.sessionId
	)
		fail("receipt.capabilityBinding", "does not match the canonical import resource and live host identities");
	const bindingDigest = computeAutoResearchLegacyProvenanceBindingDigest({
		legacyArtifactRef,
		contentDigest: parsedArtifact.artifact.contentDigest,
		legalProvenanceDigest,
		resourceDigest,
		operationDigest,
		executionIdentity: current.executionIdentity,
		sessionId: current.sessionId,
		workflowEpoch: current.epoch,
		journalHead: current.journalHead,
		stateDigest: current.stateDigest,
		revision: current.revision,
	});
	if (input.receipt.bindingDigest !== bindingDigest)
		fail("receipt.bindingDigest", "does not match the derived import binding");
	return {
		artifact: parsedArtifact.artifact,
		artifactBytes: parsedArtifact.artifactBytes,
		legacyArtifactRef,
		runId: parsedArtifact.runId,
		provenance,
		bindingDigest,
		resourceDigest,
		operationDigest,
		executionIdentity: current.executionIdentity,
		sessionId: current.sessionId,
		currentEpoch: current.epoch,
		currentStateDigest: current.stateDigest,
		currentRevision: current.revision,
		trustedNow: current.trustedNow,
	};
}

/**
 * Import one legacy scalar run as immutable, non-authorizing provenance evidence.
 *
 * Args:
 * input: Exact schema-v1 import envelope with legacy v2 bytes and a host receipt.
 * Return: Verified opaque provenance evidence; the result cannot authorize portfolio operations or resume.
 */
export async function importAutoResearchLegacyScalarRunProvenance(
	input: AutoResearchLegacyProvenanceImportInput,
): Promise<AutoResearchLegacyProvenanceEvidence> {
	const parsed = await validateImportInput(input);
	await resolveAndVerifyArtifact(
		input.receiptContext,
		parsed.legacyArtifactRef,
		parsed.artifactBytes,
		"legacyArtifact",
	);
	await resolveAndVerifyArtifact(input.receiptContext, input.receipt.artifactRef, null, "receiptArtifact");
	let hostReceipt: WorkflowVerifiedHostReceipt;
	try {
		hostReceipt = await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest: parsed.bindingDigest,
			receipt: input.receipt,
			currentStateDigest: parsed.currentStateDigest,
			currentRevision: parsed.currentRevision,
			trustedNow: parsed.trustedNow,
		});
	} catch (error) {
		throw new Error(`AutoResearch legacy provenance receipt is unsigned or unverifiable: ${String(error)}`, {
			cause: error,
		});
	}
	validateReceiptShape(hostReceipt);
	if (hostReceipt.bindingDigest !== parsed.bindingDigest)
		fail("receipt.bindingDigest", "verified receipt is detached");
	if (digestObject(hostReceipt) !== digestObject(input.receipt))
		fail("receipt", "verified resolver returned a different signed record");
	const principalAuthorizer = input.receiptContext.principalAuthorizer;
	if (principalAuthorizer === undefined || typeof principalAuthorizer.authorize !== "function")
		throw new Error(
			"CONTRACT_CHANGE: portfolio provenance import requires the generic host principalAuthorizer seam.",
		);
	const principalAuthorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput = {
		receipt: hostReceipt,
		workflowId: input.workflowId,
		bindingDigest: parsed.bindingDigest,
		resourceDigest: parsed.resourceDigest,
		operationDigest: parsed.operationDigest,
		stateDigest: parsed.currentStateDigest,
		revision: parsed.currentRevision,
		epochRef: parsed.currentEpoch,
		capability: AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_CAPABILITY,
		executionIdentity: parsed.executionIdentity,
		sessionId: parsed.sessionId,
	};
	let principalAuthorization: WorkflowHostPrincipalCapabilityAuthorization;
	try {
		principalAuthorization = await principalAuthorizer.authorize(principalAuthorizationInput);
		validatePrincipalAuthorizationDecision(principalAuthorization, principalAuthorizationInput);
	} catch (error) {
		throw new Error(`AutoResearch legacy provenance host capability authorization failed: ${String(error)}`, {
			cause: error,
		});
	}
	try {
		await input.receiptContext.receiptResolver.consumeIfOneUse({
			receipt: hostReceipt,
			workflowId: input.workflowId,
			expectedBindingDigest: parsed.bindingDigest,
			currentRevision: parsed.currentRevision,
		});
		const witness = await input.receiptContext.receiptResolver.resolveConsumptionWitness({
			receiptId: hostReceipt.receiptId,
			workflowId: input.workflowId,
			expectedBindingDigest: parsed.bindingDigest,
		});
		validateConsumptionWitness(witness, hostReceipt, input.workflowId, parsed.bindingDigest);
	} catch (error) {
		throw new Error(`AutoResearch legacy provenance receipt consumption failed: ${String(error)}`, {
			cause: error,
		});
	}
	const evidence: AutoResearchLegacyProvenanceEvidence = {
		schemaVersion: AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_SCHEMA_VERSION,
		kind: "legacy_scalar_run_provenance_evidence",
		legacyRunId: parsed.runId,
		contentDigest: parsed.artifact.contentDigest,
		contentBytes: Array.from(parsed.artifactBytes),
		legacyArtifactRef: structuredClone(parsed.legacyArtifactRef),
		provenance: parsed.provenance,
		hostReceipt: structuredClone(hostReceipt),
	};
	return cloneAndFreeze(evidence);
}
