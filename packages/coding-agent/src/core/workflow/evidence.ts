import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	WORKFLOW_EVIDENCE_LIMITS,
	type WorkflowArtifactCodec,
	type WorkflowArtifactPayloadKind,
	type WorkflowArtifactReadResult,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowAttemptHandoff,
	type WorkflowBlockerClaim,
	type WorkflowBlockerRecord,
	type WorkflowDecisionRef,
	type WorkflowEvidenceEnvelope,
	type WorkflowEvidenceEnvelopeRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowJournalHead,
	type WorkflowProgressLedger,
	type WorkflowRequirementEvidence,
	type WorkflowRevisionTuple,
	type WorkflowRuntimeStore,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { parseWorkflowCanonicalPath } from "./task-graph.js";

export type WorkflowEvidenceValidationCode =
	| "accepted"
	| "envelope_too_large"
	| "field_too_large"
	| "count_limit"
	| "artifact_missing"
	| "artifact_digest_mismatch"
	| "artifact_size_mismatch"
	| "receipt_unavailable"
	| "command_exit_invalid"
	| "command_output_unbounded"
	| "scanner_blocked"
	| "redaction_invalid"
	| "stale_workspace"
	| "stale_config"
	| "stale_revision"
	| "stale_evaluator"
	| "stale_observation"
	| "invalidated"
	| "regressed"
	| "mock_only"
	| "proxy_only"
	| "hardcoded_success"
	| "not_run"
	| "audit_reference_invalid"
	| "independent_evidence_required"
	| "fresh_red_team_required"
	| "state_digest_required"
	| "blocker_identity_not_repeated"
	| "blocker_alternatives_remaining";

export interface WorkflowEvidenceValidationInput {
	workflowId: string;
	evidence: WorkflowEvidenceEnvelope;
	trustedClockReceipt: WorkflowVerifiedHostReceipt;
	currentWorkspaceDigest: string;
	currentConfigDigest: string;
	currentParserDigest: string;
	currentEvaluatorDigest: string;
	currentGuardDigest: string;
	currentRevisions: WorkflowRevisionTuple;
	requiredFreshnessMilliseconds: number;
	artifactResolver: WorkflowArtifactResolver;
	receiptContext: WorkflowHostReceiptConsumerContext;
	currentStateDigest: string;
	currentRevision: number;
}

export interface WorkflowEvidenceValidationResult {
	accepted: boolean;
	code: WorkflowEvidenceValidationCode;
	evidenceDigest: string;
	findings: readonly { code: WorkflowEvidenceValidationCode; message: string }[];
}

export interface WorkflowEvidenceEnvelopeRefValidationInput extends WorkflowEvidenceValidationInput {
	reference: WorkflowEvidenceEnvelopeRef;
}

export interface WorkflowProgressAuditInput {
	workflowId: string;
	handoff: WorkflowAttemptHandoff;
	independentEvidence: readonly WorkflowEvidenceEnvelope[];
	currentWorkspaceDigest: string;
	currentConfigDigest: string;
	currentParserDigest: string;
	currentEvaluatorDigest: string;
	currentGuardDigest: string;
	currentRevisions: WorkflowRevisionTuple;
	currentBlocker: WorkflowBlockerRecord | null;
	goalTurnIds: readonly string[];
	blockerRegistry: WorkflowBlockerHostRegistry;
	freshRedTeamReceipt: WorkflowVerifiedHostReceipt;
	trustedClockReceipt: WorkflowVerifiedHostReceipt;
	requiredFreshnessMilliseconds: number;
	artifactResolver: WorkflowArtifactResolver;
	receiptContext: WorkflowHostReceiptConsumerContext;
	currentStateDigest: string;
	currentRevision: number;
	priorLedger?: WorkflowProgressLedger;
	independentAuditRefs?: readonly {
		receipt: WorkflowVerifiedHostReceipt;
		requirementIds: readonly string[];
		evidenceDigest: string;
	}[];
}

export interface WorkflowBlockerHostRegistry {
	resolve(input: {
		workflowId: string;
		currentStateDigest: string;
		goalTurnIds: readonly string[];
		evidence: readonly WorkflowEvidenceEnvelope[];
		observedBlocker: WorkflowBlockerRecord | null;
	}): Promise<WorkflowBlockerRecord | null>;
}

export interface WorkflowBlockerIssueInput {
	workflowId: string;
	goalTurnId: string;
	goalTurnSequence: number;
	claim: WorkflowBlockerClaim;
	prior: WorkflowBlockerRecord | null;
	auditDecisionRef: WorkflowDecisionRef;
}

export interface WorkflowProgressAuditResult {
	independent: boolean;
	workspaceDigest: string;
	currentWorkspaceDigest: string;
	currentContractRevision: number;
	currentScorecardRevision: number;
	currentPlanRevision: number;
	revisions: WorkflowRevisionTuple;
	acceptedRequirementIds: readonly string[];
	regressedRequirementIds: readonly string[];
	evidenceDigest: string;
	validatedEvidenceDigests: readonly string[];
	evidenceValidationDigest: string;
	currentStateDigest: string;
	blockerProof: WorkflowBlockerRecord | null;
	findings: readonly { code: string; message: string }[];
}

export interface WorkflowProgressAuditArtifactRef {
	artifactRef: WorkflowArtifactRef;
	receipt: WorkflowVerifiedHostReceipt;
}

export interface WorkflowProgressAuditArtifactPayload {
	kind: "workflow_progress_audit";
	workflowId: string;
	headDigest: string;
	journalHead: WorkflowJournalHead;
	progressDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	currentRevision: number;
	evidenceDigest: string;
	auditDigest: string;
	audit: WorkflowProgressAuditResult;
}

export interface WorkflowEvidenceValidator {
	validate(input: WorkflowEvidenceValidationInput): Promise<WorkflowEvidenceValidationResult>;
	auditProgress(input: WorkflowProgressAuditInput): Promise<WorkflowProgressAuditResult>;
}

function freezeClone<T>(value: T): T {
	const clone = structuredClone(value);
	const freeze = (candidate: unknown): unknown => {
		if (typeof candidate !== "object" || candidate === null || Object.isFrozen(candidate)) return candidate;
		for (const child of Object.values(candidate)) freeze(child);
		return Object.freeze(candidate);
	};
	return freeze(clone) as T;
}

function freezeCanonicalClone<T>(value: T): T {
	return freezeClone(parseCanonicalJsonBytes(canonicalJsonBytes(value)) as T);
}

function sameArtifactRef(
	left: WorkflowArtifactReadResult["envelope"]["ref"],
	right: WorkflowArtifactReadResult["envelope"]["ref"],
): boolean {
	return digestObject(left) === digestObject(right);
}

function assertCanonicalArtifactRef(ref: WorkflowArtifactRef): void {
	const expectedKeys = ["artifactId", "digest", "relativePath", "sizeBytes", "sourceEventSequence"];
	if (
		typeof ref !== "object" ||
		ref === null ||
		Array.isArray(ref) ||
		JSON.stringify(Object.keys(ref).sort()) !== JSON.stringify(expectedKeys) ||
		typeof ref.artifactId !== "string" ||
		ref.artifactId.trim().length === 0 ||
		!/^([0-9a-f]{64})$/.test(ref.digest) ||
		!Number.isSafeInteger(ref.sizeBytes) ||
		ref.sizeBytes < 0 ||
		ref.sizeBytes > WORKFLOW_EVIDENCE_LIMITS.maxArtifactSizeBytes ||
		!Number.isSafeInteger(ref.sourceEventSequence) ||
		ref.sourceEventSequence < 0
	) {
		throw new Error("Workflow artifact reference is not canonical or content-addressed.");
	}
	parseWorkflowCanonicalPath(ref.relativePath);
}

function sameArtifactRefSet(left: readonly WorkflowArtifactRef[], right: readonly WorkflowArtifactRef[]): boolean {
	const leftDigests = left.map((ref) => digestObject(ref)).sort();
	const rightDigests = right.map((ref) => digestObject(ref)).sort();
	return (
		leftDigests.length > 0 &&
		rightDigests.length > 0 &&
		new Set(leftDigests).size === leftDigests.length &&
		new Set(rightDigests).size === rightDigests.length &&
		digestObject(leftDigests) === digestObject(rightDigests)
	);
}

async function resolveVerifiedArtifact(
	resolver: WorkflowArtifactResolver,
	ref: WorkflowArtifactReadResult["envelope"]["ref"],
	expectedPayloadKind: WorkflowArtifactPayloadKind = "evidence",
): Promise<WorkflowArtifactReadResult> {
	assertCanonicalArtifactRef(ref);
	const resolved = await resolver.resolve(ref);
	if (
		!resolved.exists ||
		!resolved.envelope.immutable ||
		resolved.envelope.payloadKind !== expectedPayloadKind ||
		!sameArtifactRef(resolved.envelope.ref, ref)
	) {
		throw new Error("Workflow artifact is missing or envelope-bound to a different reference.");
	}
	if (resolved.verifiedDigest !== ref.digest || sha256Hex(resolved.bytes) !== ref.digest) {
		throw new Error("Workflow artifact is not content-addressed to its reference digest.");
	}
	if (resolved.verifiedSizeBytes !== ref.sizeBytes || resolved.bytes.byteLength !== ref.sizeBytes) {
		throw new Error("Workflow artifact size does not match its reference.");
	}
	return Object.freeze({
		...resolved,
		envelope: freezeCanonicalClone(resolved.envelope),
		bytes: Uint8Array.from(resolved.bytes),
	});
}

export interface WorkflowVerifiedArtifactResolutionInput {
	resolver: WorkflowArtifactResolver;
	ref: WorkflowArtifactRef;
	expectedPayloadKind?: WorkflowArtifactPayloadKind;
	expectedCodec?: WorkflowArtifactCodec;
	expectedSourceEventSequence?: number;
}

/**
 * Resolve an immutable artifact envelope and copy its authenticated bytes for a host boundary.
 *
 * Args:
 * input: Resolver, canonical reference, and optional envelope constraints.
 * Return: Resolver result with a detached byte copy and frozen envelope for host-boundary revalidation.
 */
export async function resolveVerifiedWorkflowArtifact(
	input: WorkflowVerifiedArtifactResolutionInput,
): Promise<WorkflowArtifactReadResult> {
	assertCanonicalArtifactRef(input.ref);
	if (
		input.expectedSourceEventSequence !== undefined &&
		input.ref.sourceEventSequence !== input.expectedSourceEventSequence
	) {
		throw new Error("Workflow artifact source event sequence is not bound to the expected host event.");
	}
	const artifact = await resolveVerifiedArtifact(input.resolver, input.ref, input.expectedPayloadKind);
	if (
		(input.expectedPayloadKind !== undefined && artifact.envelope.payloadKind !== input.expectedPayloadKind) ||
		(input.expectedCodec !== undefined && artifact.envelope.codec !== input.expectedCodec)
	) {
		throw new Error("Workflow artifact envelope is not bound to the expected payload or codec.");
	}
	return artifact;
}

async function resolveEvidenceArtifacts(
	resolver: WorkflowArtifactResolver,
	evidence: readonly WorkflowEvidenceEnvelope[],
): Promise<readonly WorkflowArtifactRef[]> {
	const refs: WorkflowArtifactRef[] = [];
	for (const envelope of evidence) {
		for (const observation of envelope.artifactObservations) {
			if (!observation.exists) throw new Error("Workflow evidence artifact is missing at the host CAS boundary.");
			const resolved = await resolveVerifiedArtifact(resolver, observation.artifactRef);
			if (
				observation.verifiedDigest !== observation.artifactRef.digest ||
				observation.verifiedSizeBytes !== observation.artifactRef.sizeBytes ||
				resolved.bytes.byteLength !== observation.artifactRef.sizeBytes
			) {
				throw new Error("Workflow evidence artifact verification is stale at the host CAS boundary.");
			}
			refs.push(observation.artifactRef);
		}
	}
	if (refs.length === 0 || new Set(refs.map((ref) => digestObject(ref))).size !== refs.length) {
		throw new Error(
			"Workflow progress acceptance requires a distinct immutable reference for every evidence artifact.",
		);
	}
	return freezeClone(refs);
}

function sameArtifactRefSequence(left: readonly WorkflowArtifactRef[], right: readonly WorkflowArtifactRef[]): boolean {
	return left.length === right.length && digestObject(left) === digestObject(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRevisionTuple(value: unknown): value is WorkflowRevisionTuple {
	return (
		isRecord(value) &&
		isPositiveSafeInteger(value.contractRevision) &&
		isPositiveSafeInteger(value.scorecardRevision) &&
		isPositiveSafeInteger(value.planRevision) &&
		isPositiveSafeInteger(value.configRevision) &&
		isPositiveSafeInteger(value.evidenceRevision)
	);
}

function isProgressAuditResult(value: unknown): value is WorkflowProgressAuditResult {
	if (!isRecord(value)) return false;
	const findings = value.findings;
	const validFindings =
		Array.isArray(findings) &&
		findings.every(
			(finding) => isRecord(finding) && typeof finding.code === "string" && typeof finding.message === "string",
		);
	return (
		typeof value.independent === "boolean" &&
		typeof value.workspaceDigest === "string" &&
		typeof value.currentWorkspaceDigest === "string" &&
		isPositiveSafeInteger(value.currentContractRevision) &&
		isPositiveSafeInteger(value.currentScorecardRevision) &&
		isPositiveSafeInteger(value.currentPlanRevision) &&
		isRevisionTuple(value.revisions) &&
		isStringArray(value.acceptedRequirementIds) &&
		isStringArray(value.regressedRequirementIds) &&
		typeof value.evidenceDigest === "string" &&
		isStringArray(value.validatedEvidenceDigests) &&
		typeof value.evidenceValidationDigest === "string" &&
		typeof value.currentStateDigest === "string" &&
		(value.blockerProof === null || isRecord(value.blockerProof)) &&
		validFindings
	);
}

function isProgressAuditArtifactPayload(value: unknown): value is WorkflowProgressAuditArtifactPayload {
	if (!isRecord(value)) return false;
	const journalHead = value.journalHead;
	return (
		value.kind === "workflow_progress_audit" &&
		typeof value.workflowId === "string" &&
		typeof value.headDigest === "string" &&
		isRecord(journalHead) &&
		typeof journalHead.workflowId === "string" &&
		typeof journalHead.sequence === "number" &&
		Number.isSafeInteger(journalHead.sequence) &&
		journalHead.sequence >= 0 &&
		(journalHead.eventDigest === null || typeof journalHead.eventDigest === "string") &&
		isRecord(journalHead.epochRef) &&
		isPositiveSafeInteger(journalHead.epochRef.storeEpoch) &&
		isPositiveSafeInteger(journalHead.epochRef.coordinatorEpoch) &&
		typeof value.progressDigest === "string" &&
		isPositiveSafeInteger(value.storeEpoch) &&
		isPositiveSafeInteger(value.coordinatorEpoch) &&
		isPositiveSafeInteger(value.currentRevision) &&
		typeof value.evidenceDigest === "string" &&
		typeof value.auditDigest === "string" &&
		isProgressAuditResult(value.audit)
	);
}

async function resolveProgressAuditArtifact(
	resolver: WorkflowArtifactResolver,
	reference: WorkflowProgressAuditArtifactRef,
): Promise<WorkflowProgressAuditArtifactPayload> {
	const artifact = await resolveVerifiedArtifact(resolver, reference.artifactRef);
	if (artifact.envelope.codec !== "canonical_json") {
		throw new Error("Progress audit artifact must be immutable canonical JSON.");
	}
	let parsed: unknown;
	try {
		parsed = parseCanonicalJsonBytes(artifact.bytes);
	} catch (_error: unknown) {
		throw new Error("Progress audit artifact bytes are not canonical JSON.");
	}
	if (!isProgressAuditArtifactPayload(parsed)) {
		throw new Error("Progress audit artifact has an invalid host-produced payload.");
	}
	const canonicalBytes = canonicalJsonBytes(parsed);
	if (parsed.auditDigest !== digestObject(parsed.audit) || !sameBytes(canonicalBytes, artifact.bytes)) {
		throw new Error("Progress audit artifact digest or canonical bytes are not self-bound.");
	}
	return freezeClone(parsed);
}

export function computeWorkflowProgressAuditReceiptBinding(input: {
	workflowId: string;
	headDigest: string;
	journalHead: WorkflowJournalHead;
	progressDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	currentRevision: number;
	evidenceDigest: string;
	auditArtifactRef: WorkflowArtifactRef;
	expectedLedger: WorkflowProgressLedger;
	nextLedger: WorkflowProgressLedger;
	evidenceRefs: readonly WorkflowArtifactRef[];
}): string {
	return digestObject({
		kind: "progress_acceptance",
		workflowId: input.workflowId,
		headDigest: input.headDigest,
		journalHead: input.journalHead,
		progressDigest: input.progressDigest,
		storeEpoch: input.storeEpoch,
		coordinatorEpoch: input.coordinatorEpoch,
		currentRevision: input.currentRevision,
		evidenceDigest: input.evidenceDigest,
		auditArtifactRef: input.auditArtifactRef,
		expectedLedger: input.expectedLedger,
		expectedLedgerDigest: digestObject(input.expectedLedger),
		nextLedger: input.nextLedger,
		nextLedgerDigest: digestObject(input.nextLedger),
		evidenceRefs: input.evidenceRefs,
	});
}

function assertProgressAuditArtifactBinding(input: {
	payload: WorkflowProgressAuditArtifactPayload;
	workflowId: string;
	headDigest: string;
	journalHead: WorkflowJournalHead;
	progressDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	currentRevision: number;
	evidenceDigest: string;
}): void {
	if (
		input.payload.workflowId !== input.workflowId ||
		input.payload.headDigest !== input.headDigest ||
		digestObject(input.payload.journalHead) !== digestObject(input.journalHead) ||
		input.payload.progressDigest !== input.progressDigest ||
		input.payload.storeEpoch !== input.storeEpoch ||
		input.payload.coordinatorEpoch !== input.coordinatorEpoch ||
		input.payload.currentRevision !== input.currentRevision ||
		input.payload.evidenceDigest !== input.evidenceDigest
	) {
		throw new Error("Progress audit artifact is stale, foreign, or not bound to the current workflow head.");
	}
}

function assertLedgerEpochBinding(ledger: WorkflowProgressLedger, storeEpoch: number, coordinatorEpoch: number): void {
	if (
		ledger.entries.some(
			(entry) =>
				entry.auditorDecisionRef.storeEpoch !== storeEpoch ||
				entry.auditorDecisionRef.coordinatorEpoch !== coordinatorEpoch,
		)
	) {
		throw new Error("Progress ledger decision epochs are stale or foreign to the current host epoch.");
	}
}

async function verifyHostReceipt(input: {
	context: WorkflowHostReceiptConsumerContext;
	workflowId: string;
	expectedBindingDigest: string;
	receipt: WorkflowVerifiedHostReceipt;
	currentStateDigest: string;
	currentRevision: number;
	trustedNow: string;
}): Promise<WorkflowVerifiedHostReceipt> {
	const artifact = await resolveVerifiedArtifact(input.context.artifactResolver, input.receipt.artifactRef);
	return input.context.receiptResolver.resolve({
		receipt: input.receipt,
		workflowId: input.workflowId,
		expectedBindingDigest: input.expectedBindingDigest,
		artifactBytes: artifact.bytes,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
		keyResolver: input.context.keyResolver,
		revokedReceiptIds: input.context.revokedReceiptIds,
	});
}

async function consumeOneUseReceipt(input: {
	context: WorkflowHostReceiptConsumerContext;
	workflowId: string;
	expectedBindingDigest: string;
	receipt: WorkflowVerifiedHostReceipt;
	currentRevision: number;
}): Promise<void> {
	if (!input.receipt.oneUse) return;
	await input.context.receiptResolver.consumeIfOneUse({
		receipt: input.receipt,
		workflowId: input.workflowId,
		expectedBindingDigest: input.expectedBindingDigest,
		currentRevision: input.currentRevision,
	});
}

function assertFreshReceipt(
	receipt: WorkflowVerifiedHostReceipt,
	trustedNow: string,
	maximumAgeMilliseconds: number,
): void {
	const issuedAt = Date.parse(receipt.issuedAt);
	const validUntil = Date.parse(receipt.validUntil);
	const now = Date.parse(trustedNow);
	if (
		!Number.isFinite(issuedAt) ||
		!Number.isFinite(validUntil) ||
		!Number.isFinite(now) ||
		issuedAt > now ||
		now >= validUntil ||
		now - issuedAt > maximumAgeMilliseconds
	) {
		throw new Error("Workflow host receipt is stale or outside its required freshness window.");
	}
}

/**
 * Reduce a validated envelope to the requirement evidence shape accepted by handoffs.
 *
 * Args:
 * envelope: Full host-observed evidence envelope.
 * Return: Compact requirement evidence projection with immutable artifact references.
 */
export function projectRequirementEvidence(envelope: WorkflowEvidenceEnvelope): WorkflowRequirementEvidence {
	return freezeClone({
		evidenceId: envelope.evidenceId,
		requirementId: envelope.requirementId,
		claim: envelope.claim,
		result: envelope.result,
		method: envelope.method,
		artifactRefs: envelope.artifactObservations.map((observation) => observation.artifactRef),
		confidence: envelope.confidence,
		limitations: envelope.limitations,
		workspaceDigest: envelope.workspaceDigest,
		observedAt: envelope.observedAt,
	});
}

/**
 * Validate one evidence envelope against host receipts, immutable artifacts, and current revisions.
 *
 * Args:
 * input: Envelope and host context used to validate its currentness and provenance.
 * Return: Closed validation result containing a deterministic envelope digest and findings.
 */
export async function validateWorkflowEvidenceEnvelope(
	input: WorkflowEvidenceValidationInput,
): Promise<WorkflowEvidenceValidationResult> {
	const findings: { code: WorkflowEvidenceValidationCode; message: string }[] = [];
	const evidence = input.evidence;
	const evidenceDigest = digestObject(evidence);
	const reject = (code: WorkflowEvidenceValidationCode, message: string): void => {
		findings.push({ code, message });
	};
	const bounded = (value: string, limit: number, field: string): void => {
		if (new TextEncoder().encode(value).byteLength > limit) reject("field_too_large", field);
	};
	let trustedClockVerified = false;

	try {
		if (input.trustedClockReceipt.receiptKind !== "clock" || input.trustedClockReceipt.issuerId.trim().length === 0) {
			throw new Error("Trusted evidence time must come from an identified clock receipt.");
		}
		await verifyHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest: digestObject({
				evidenceId: evidence.evidenceId,
				workspaceDigest: input.currentWorkspaceDigest,
				configDigest: input.currentConfigDigest,
				revisions: input.currentRevisions,
			}),
			receipt: input.trustedClockReceipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: input.trustedClockReceipt.issuedAt,
		});
		trustedClockVerified = true;
	} catch (_error: unknown) {
		reject("stale_observation", evidence.evidenceId);
	}
	if (trustedClockVerified && input.trustedClockReceipt.oneUse) {
		try {
			await consumeOneUseReceipt({
				context: input.receiptContext,
				workflowId: input.workflowId,
				expectedBindingDigest: digestObject({
					evidenceId: evidence.evidenceId,
					workspaceDigest: input.currentWorkspaceDigest,
					configDigest: input.currentConfigDigest,
					revisions: input.currentRevisions,
				}),
				receipt: input.trustedClockReceipt,
				currentRevision: input.currentRevision,
			});
		} catch (_error: unknown) {
			reject("receipt_unavailable", evidence.evidenceId);
		}
	}

	try {
		if (canonicalJsonBytes(evidence).byteLength > WORKFLOW_EVIDENCE_LIMITS.maxEnvelopeBytes) {
			reject("envelope_too_large", evidence.evidenceId);
		}
	} catch (_error: unknown) {
		reject("envelope_too_large", evidence.evidenceId);
	}

	bounded(evidence.evidenceId, WORKFLOW_EVIDENCE_LIMITS.maxIdentifierBytes, "evidenceId");
	bounded(evidence.requirementId, WORKFLOW_EVIDENCE_LIMITS.maxIdentifierBytes, "requirementId");
	bounded(evidence.claim, WORKFLOW_EVIDENCE_LIMITS.maxClaimBytes, "claim");
	bounded(evidence.result, WORKFLOW_EVIDENCE_LIMITS.maxResultBytes, "result");
	bounded(evidence.method, WORKFLOW_EVIDENCE_LIMITS.maxMethodBytes, "method");
	if (
		evidence.limitations.length > WORKFLOW_EVIDENCE_LIMITS.maxLimitations ||
		evidence.artifactObservations.length > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations ||
		evidence.scanner.findingCodes.length > WORKFLOW_EVIDENCE_LIMITS.maxScannerFindings
	) {
		reject("count_limit", evidence.evidenceId);
	}
	for (const limitation of evidence.limitations) {
		bounded(limitation, WORKFLOW_EVIDENCE_LIMITS.maxLimitationBytes, "limitation");
	}
	for (const findingCode of evidence.scanner.findingCodes) {
		bounded(findingCode, WORKFLOW_EVIDENCE_LIMITS.maxScannerFindingCodeBytes, "scanner.findingCodes");
	}

	for (const observation of evidence.artifactObservations) {
		bounded(
			observation.artifactRef.artifactId,
			WORKFLOW_EVIDENCE_LIMITS.maxIdentifierBytes,
			"artifactRef.artifactId",
		);
		bounded(
			observation.artifactRef.relativePath,
			WORKFLOW_EVIDENCE_LIMITS.maxIdentifierBytes,
			"artifactRef.relativePath",
		);
		bounded(observation.artifactRef.digest, WORKFLOW_EVIDENCE_LIMITS.maxCommandDigestBytes, "artifactRef.digest");
		bounded(observation.verifiedDigest, WORKFLOW_EVIDENCE_LIMITS.maxCommandDigestBytes, "verifiedDigest");
		if (observation.artifactRef.sizeBytes > WORKFLOW_EVIDENCE_LIMITS.maxArtifactSizeBytes) {
			reject("count_limit", observation.artifactRef.artifactId);
		}
		try {
			if (!observation.exists) {
				reject("artifact_missing", observation.artifactRef.artifactId);
				continue;
			}
			const resolved = await resolveVerifiedArtifact(input.artifactResolver, observation.artifactRef);
			if (observation.verifiedDigest !== observation.artifactRef.digest) {
				reject("artifact_digest_mismatch", observation.artifactRef.artifactId);
			}
			if (observation.verifiedSizeBytes !== observation.artifactRef.sizeBytes) {
				reject("artifact_size_mismatch", observation.artifactRef.artifactId);
			}
			if (resolved.bytes.byteLength !== observation.artifactRef.sizeBytes) {
				reject("artifact_size_mismatch", observation.artifactRef.artifactId);
			}
		} catch (_error: unknown) {
			const message = _error instanceof Error ? _error.message : "";
			reject(
				message.includes("size does not match")
					? "artifact_size_mismatch"
					: message.includes("content-addressed") || message.includes("envelope-bound")
						? "artifact_digest_mismatch"
						: "artifact_missing",
				observation.artifactRef.artifactId,
			);
		}
	}

	if (evidence.command !== null) {
		const command = evidence.command;
		const validExitStates = new Set(["exited", "signaled", "timed_out", "spawn_failed", "not_run"]);
		const validSignals = new Set(["SIGABRT", "SIGHUP", "SIGINT", "SIGKILL", "SIGTERM", "unknown"]);
		bounded(command.commandDigest, WORKFLOW_EVIDENCE_LIMITS.maxCommandDigestBytes, "command.commandDigest");
		bounded(command.outputDigest, WORKFLOW_EVIDENCE_LIMITS.maxCommandDigestBytes, "command.outputDigest");
		const stdoutBytes = new TextEncoder().encode(command.stdout).byteLength;
		const stderrBytes = new TextEncoder().encode(command.stderr).byteLength;
		const outputDigest = digestObject({ stdout: command.stdout, stderr: command.stderr });
		if (
			command.commandDigest.trim().length === 0 ||
			!validExitStates.has(command.exitState) ||
			(command.signal !== null && !validSignals.has(command.signal)) ||
			stdoutBytes !== command.stdoutBytes ||
			stderrBytes !== command.stderrBytes ||
			stdoutBytes + stderrBytes > WORKFLOW_EVIDENCE_LIMITS.maxCommandOutputBytes ||
			(command.stdout + command.stderr).split(/\r?\n/).length > WORKFLOW_EVIDENCE_LIMITS.maxCommandOutputLines ||
			command.outputTruncated ||
			command.outputDigest !== outputDigest
		) {
			reject("command_output_unbounded", evidence.evidenceId);
		}
		if (command.exitState === "not_run") reject("not_run", evidence.evidenceId);
		if (
			(command.exitState === "exited" &&
				(command.exitCode === null ||
					!Number.isSafeInteger(command.exitCode) ||
					command.exitCode < 0 ||
					command.signal !== null)) ||
			(command.exitState === "signaled" && (command.exitCode !== null || command.signal === null)) ||
			((command.exitState === "timed_out" || command.exitState === "spawn_failed") &&
				(command.exitCode !== null || command.signal !== null))
		) {
			reject("command_exit_invalid", evidence.evidenceId);
		}
		const exitedZero = command.exitState === "exited" && command.exitCode === 0;
		const claimsSuccess = /^(?:exit-zero|passed|success|successful)$/i.test(evidence.result);
		const claimsFailure = /^(?:failed|failure|error|non[-_ ]?zero|timed[-_ ]?out|spawn[-_ ]?failed)$/i.test(
			evidence.result,
		);
		if ((claimsSuccess && !exitedZero) || (claimsFailure && exitedZero)) {
			reject("command_exit_invalid", evidence.evidenceId);
		}
	}
	if (evidence.command === null && /^(?:exit-zero|passed|success|successful)$/i.test(evidence.result)) {
		reject("command_exit_invalid", evidence.evidenceId);
	}

	bounded(evidence.scanner.scannerDigest, WORKFLOW_EVIDENCE_LIMITS.maxCommandDigestBytes, "scanner.scannerDigest");
	bounded(evidence.scanner.findingDigest, WORKFLOW_EVIDENCE_LIMITS.maxCommandDigestBytes, "scanner.findingDigest");
	if (evidence.scanner.scanStatus === "blocked") reject("scanner_blocked", evidence.evidenceId);
	if (
		evidence.scanner.redactionStatus === "blocked" ||
		(evidence.scanner.scanStatus === "redacted" && evidence.scanner.redactionStatus !== "applied")
	) {
		reject("redaction_invalid", evidence.evidenceId);
	}
	if (evidence.workspaceDigest !== input.currentWorkspaceDigest) reject("stale_workspace", evidence.evidenceId);
	if (evidence.configDigest !== input.currentConfigDigest) reject("stale_config", evidence.evidenceId);
	if (
		Object.values(evidence.revisions).some((revision) => !Number.isSafeInteger(revision) || revision < 1) ||
		Object.values(input.currentRevisions).some((revision) => !Number.isSafeInteger(revision) || revision < 1) ||
		digestObject(evidence.revisions) !== digestObject(input.currentRevisions) ||
		evidence.evidenceRevision !== input.currentRevisions.evidenceRevision
	) {
		reject("stale_revision", evidence.evidenceId);
	}
	if (
		evidence.parserDigest !== input.currentParserDigest ||
		evidence.evaluatorDigest !== input.currentEvaluatorDigest ||
		evidence.guardDigest !== input.currentGuardDigest
	) {
		reject("stale_evaluator", evidence.evidenceId);
	}
	const observedAt = Date.parse(evidence.observedAt);
	const freshUntil = Date.parse(evidence.freshUntil);
	const now = Date.parse(input.trustedClockReceipt.issuedAt);
	if (
		!Number.isFinite(observedAt) ||
		!Number.isFinite(freshUntil) ||
		!Number.isFinite(now) ||
		observedAt > now ||
		now > freshUntil ||
		freshUntil - observedAt !== evidence.freshnessWindowMilliseconds ||
		evidence.freshnessWindowMilliseconds > WORKFLOW_EVIDENCE_LIMITS.maxFreshnessMilliseconds ||
		evidence.freshnessWindowMilliseconds < input.requiredFreshnessMilliseconds
	) {
		reject("stale_observation", evidence.evidenceId);
	}
	if (evidence.invalidatedByDecisionRef !== null) reject("invalidated", evidence.evidenceId);
	if (evidence.regressed) reject("regressed", evidence.evidenceId);
	if (evidence.method === "mock-only") reject("mock_only", evidence.evidenceId);
	if (evidence.scanner.findingCodes.includes("proxy") || evidence.scanner.findingCodes.includes("proxy-utilization")) {
		reject("proxy_only", evidence.evidenceId);
	}
	if (evidence.result === "hardcoded-success") reject("hardcoded_success", evidence.evidenceId);
	if (/^(?:worker|self[-_ ]?report|self[-_ ]?authored)/i.test(evidence.method)) {
		reject("independent_evidence_required", evidence.evidenceId);
	}

	const code = findings[0]?.code ?? "accepted";
	return freezeClone({
		accepted: findings.length === 0,
		code,
		evidenceDigest,
		findings: findings.slice(0, WORKFLOW_EVIDENCE_LIMITS.maxScannerFindings),
	});
}

/**
 * Validate a persisted evidence reference against its resolver-bound envelope and receipt.
 *
 * Args:
 * input: Envelope validation context and consumer-facing envelope reference.
 * Return: The exact reference after host validation.
 */
export async function validateWorkflowEvidenceEnvelopeRef(
	input: WorkflowEvidenceEnvelopeRefValidationInput,
): Promise<WorkflowEvidenceEnvelopeRef> {
	const validation = await validateWorkflowEvidenceEnvelope(input);
	const expectedArtifactRefs = input.evidence.artifactObservations.map((observation) => observation.artifactRef);
	try {
		if (input.reference.validationReceipt.receiptKind !== "artifact") {
			throw new Error("Workflow evidence validation receipt has an invalid kind.");
		}
		await verifyHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest: validation.evidenceDigest,
			receipt: input.reference.validationReceipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.evidence.evidenceRevision,
			trustedNow: input.trustedClockReceipt.issuedAt,
		});
		await consumeOneUseReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest: validation.evidenceDigest,
			receipt: input.reference.validationReceipt,
			currentRevision: input.evidence.evidenceRevision,
		});
	} catch (_error: unknown) {
		throw new Error("Workflow evidence envelope validation receipt is not host-verified.");
	}
	if (
		!validation.accepted ||
		input.reference.workflowId !== input.workflowId ||
		input.reference.envelopeId !== input.evidence.evidenceId ||
		input.reference.envelopeDigest !== validation.evidenceDigest ||
		input.reference.evidenceRevision !== input.evidence.evidenceRevision ||
		digestObject(input.reference.artifactRefs) !== digestObject(expectedArtifactRefs)
	) {
		throw new Error(
			"Workflow evidence envelope reference is not resolver-validated or is not bound to the current envelope artifact scope.",
		);
	}
	return freezeClone(input.reference);
}

/**
 * Create the host evidence validator used by workflow consumers.
 *
 * Args: None.
 * Return: Validator for envelopes and independently audited progress.
 */
export function createWorkflowEvidenceValidator(): WorkflowEvidenceValidator {
	return { validate: validateWorkflowEvidenceEnvelope, auditProgress: auditWorkflowProgress };
}

/**
 * Audit worker handoff progress using host-verified evidence, receipts, and blocker state.
 *
 * Args:
 * input: Handoff, independent evidence, current revisions, and host receipt context.
 * Return: Host-recomputed progress projection with accepted and regressed requirements.
 */
export async function auditWorkflowProgress(input: WorkflowProgressAuditInput): Promise<WorkflowProgressAuditResult> {
	const findings: { code: string; message: string }[] = [];
	const validatedEvidenceDigests: string[] = [];
	if (
		input.independentEvidence.length > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations ||
		input.handoff.requirementEvidence.length > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations ||
		input.handoff.verificationEvidenceRefs.length > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations ||
		input.goalTurnIds.length > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations ||
		(input.independentAuditRefs?.length ?? 0) > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations
	) {
		findings.push({ code: "count_limit", message: "Progress audit evidence and references exceed bounded limits." });
	}
	let registeredBlocker: WorkflowBlockerRecord | null = null;
	try {
		registeredBlocker = await input.blockerRegistry.resolve({
			workflowId: input.workflowId,
			currentStateDigest: input.currentStateDigest,
			goalTurnIds: input.goalTurnIds,
			evidence: input.independentEvidence,
			observedBlocker: null,
		});
	} catch (_error: unknown) {
		findings.push({ code: "audit_reference_invalid", message: "The host blocker registry could not be resolved." });
	}
	if (
		input.currentBlocker !== null &&
		(registeredBlocker === null || digestObject(input.currentBlocker) !== digestObject(registeredBlocker))
	) {
		findings.push({
			code: "audit_reference_invalid",
			message: "Caller blocker observations cannot replace the host registry blocker proof.",
		});
	}
	if (input.handoff.requirementEvidence.length === 0 || input.independentEvidence.length === 0) {
		findings.push({ code: "independent_evidence_required", message: "Worker self-report is not sufficient." });
	}
	const independentRequirementIds = [...new Set(input.independentEvidence.map((item) => item.requirementId))].sort();
	const handoffRequirementIds = [
		...new Set(input.handoff.requirementEvidence.map((item) => item.requirementId)),
	].sort();
	if (
		handoffRequirementIds.length > 0 &&
		digestObject(handoffRequirementIds) !== digestObject(independentRequirementIds)
	) {
		findings.push({
			code: "independent_evidence_required",
			message: "Handoff requirement evidence is not bound to host evidence.",
		});
	}
	const envelopeIds = input.independentEvidence.map((item) => item.evidenceId);
	const handoffEvidenceIds = input.handoff.requirementEvidence.map((item) => item.evidenceId);
	if (
		new Set(envelopeIds).size !== envelopeIds.length ||
		new Set(handoffEvidenceIds).size !== handoffEvidenceIds.length ||
		digestObject([...envelopeIds].sort()) !== digestObject([...handoffEvidenceIds].sort())
	) {
		findings.push({
			code: "independent_evidence_required",
			message: "Handoff evidence IDs are not bound one-to-one to host envelopes.",
		});
	}
	for (const envelope of input.independentEvidence) {
		if (envelope.artifactObservations.length === 0) {
			findings.push({
				code: "independent_evidence_required",
				message: `Evidence ${envelope.evidenceId} has no immutable evidence reference.`,
			});
			continue;
		}
		const handoffEvidence = input.handoff.requirementEvidence.find((item) => item.evidenceId === envelope.evidenceId);
		if (
			handoffEvidence === undefined ||
			digestObject(handoffEvidence) !== digestObject(projectRequirementEvidence(envelope))
		) {
			findings.push({
				code: "independent_evidence_required",
				message: `Handoff evidence ${envelope.evidenceId} is not an exact projection of the host envelope.`,
			});
		}
	}
	const independentlyObservedArtifactRefs = input.independentEvidence.flatMap((envelope) =>
		envelope.artifactObservations.map((observation) => observation.artifactRef),
	);
	if (!sameArtifactRefSet(input.handoff.verificationEvidenceRefs, independentlyObservedArtifactRefs)) {
		findings.push({
			code: "independent_evidence_required",
			message: "Handoff verification references must exactly equal independently validated artifacts.",
		});
	}
	if (input.handoff.postWorkspaceDigest !== input.currentWorkspaceDigest) {
		findings.push({
			code: "independent_evidence_required",
			message: "Handoff post-workspace digest is not bound to the current workspace.",
		});
	}

	const freshRedTeamBindingDigest = digestObject({
		kind: "progress_red_team",
		workflowId: input.workflowId,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		workspaceDigest: input.currentWorkspaceDigest,
		configDigest: input.currentConfigDigest,
		revisions: input.currentRevisions,
		goalTurnIds: input.goalTurnIds,
		evidenceDigest: digestObject(input.independentEvidence),
		blockerDigest: registeredBlocker === null ? null : digestObject(registeredBlocker),
	});
	let freshRedTeamVerified = false;
	try {
		if (
			input.freshRedTeamReceipt.receiptKind !== "decision" ||
			input.freshRedTeamReceipt.issuerId.trim().length === 0
		) {
			throw new Error("Progress red-team receipt has an invalid host identity or kind.");
		}
		assertFreshReceipt(
			input.freshRedTeamReceipt,
			input.trustedClockReceipt.issuedAt,
			input.requiredFreshnessMilliseconds,
		);
		await verifyHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest: freshRedTeamBindingDigest,
			receipt: input.freshRedTeamReceipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: input.trustedClockReceipt.issuedAt,
		});
		freshRedTeamVerified = true;
	} catch (_error: unknown) {
		findings.push({ code: "fresh_red_team_required", message: "A fresh host-signed red-team receipt is required." });
	}
	if (freshRedTeamVerified && input.freshRedTeamReceipt.oneUse) {
		try {
			await consumeOneUseReceipt({
				context: input.receiptContext,
				workflowId: input.workflowId,
				expectedBindingDigest: freshRedTeamBindingDigest,
				receipt: input.freshRedTeamReceipt,
				currentRevision: input.currentRevision,
			});
		} catch (_error: unknown) {
			findings.push({
				code: "receipt_unavailable",
				message: "Fresh red-team receipt is unavailable for one-use consumption.",
			});
		}
	}
	if (input.freshRedTeamReceipt.receiptKind !== "decision") {
		findings.push({
			code: "fresh_red_team_required",
			message: "The progress red-team receipt must be a host decision receipt.",
		});
	}
	if (
		input.freshRedTeamReceipt.issuerId === input.trustedClockReceipt.issuerId ||
		input.freshRedTeamReceipt.receiptId === input.trustedClockReceipt.receiptId
	) {
		findings.push({
			code: "fresh_red_team_required",
			message: "The fresh red-team receipt must have a distinct host identity from the trusted clock.",
		});
	}
	if (input.independentAuditRefs === undefined || input.independentAuditRefs.length === 0) {
		findings.push({ code: "audit_reference_invalid", message: "Independent signed audit references are required." });
	}
	const auditIssuers = new Set<string>();
	const auditReceiptIds = new Set<string>();
	for (const reference of input.independentAuditRefs ?? []) {
		if (
			reference.receipt.receiptKind !== "adjudication" ||
			reference.receipt.issuerId.trim().length === 0 ||
			reference.receipt.receiptId.trim().length === 0 ||
			reference.receipt.issuerId === input.freshRedTeamReceipt.issuerId ||
			reference.receipt.issuerId === input.trustedClockReceipt.issuerId ||
			reference.receipt.receiptId === input.freshRedTeamReceipt.receiptId ||
			reference.receipt.receiptId === input.trustedClockReceipt.receiptId ||
			auditIssuers.has(reference.receipt.issuerId) ||
			auditReceiptIds.has(reference.receipt.receiptId)
		) {
			findings.push({
				code: "audit_reference_invalid",
				message: "Independent audit receipt identity or kind is not distinct from other host stages.",
			});
		}
		auditIssuers.add(reference.receipt.issuerId);
		auditReceiptIds.add(reference.receipt.receiptId);
		let auditReceiptVerified = false;
		try {
			const auditBindingDigest = digestObject({
				kind: "progress_audit",
				workflowId: input.workflowId,
				currentStateDigest: input.currentStateDigest,
				currentRevision: input.currentRevision,
				requirementIds: [...reference.requirementIds].sort(),
				evidenceDigest: digestObject(input.independentEvidence),
			});
			assertFreshReceipt(reference.receipt, input.trustedClockReceipt.issuedAt, input.requiredFreshnessMilliseconds);
			await verifyHostReceipt({
				context: input.receiptContext,
				workflowId: input.workflowId,
				expectedBindingDigest: auditBindingDigest,
				receipt: reference.receipt,
				currentStateDigest: input.currentStateDigest,
				currentRevision: input.currentRevision,
				trustedNow: input.trustedClockReceipt.issuedAt,
			});
			auditReceiptVerified = true;
		} catch (_error: unknown) {
			findings.push({ code: "audit_reference_invalid", message: "Independent audit receipt is not host-verified." });
		}
		if (auditReceiptVerified && reference.receipt.oneUse) {
			try {
				await consumeOneUseReceipt({
					context: input.receiptContext,
					workflowId: input.workflowId,
					expectedBindingDigest: digestObject({
						kind: "progress_audit",
						workflowId: input.workflowId,
						currentStateDigest: input.currentStateDigest,
						currentRevision: input.currentRevision,
						requirementIds: [...reference.requirementIds].sort(),
						evidenceDigest: digestObject(input.independentEvidence),
					}),
					receipt: reference.receipt,
					currentRevision: input.currentRevision,
				});
			} catch (_error: unknown) {
				findings.push({
					code: "receipt_unavailable",
					message: "Independent audit receipt is unavailable for one-use consumption.",
				});
			}
		}
		if (
			reference.requirementIds.length === 0 ||
			reference.evidenceDigest !== digestObject(input.independentEvidence) ||
			digestObject([...reference.requirementIds].sort()) !== digestObject(independentRequirementIds)
		) {
			findings.push({
				code: "audit_reference_invalid",
				message: "Independent audit reference is not bound to current evidence and requirements.",
			});
		}
	}
	if (registeredBlocker !== null) {
		const observedIds = registeredBlocker.observedGoalTurnIds;
		const sequenceIsContiguous =
			registeredBlocker.lastObservedGoalTurnSequence - registeredBlocker.firstObservedGoalTurnSequence + 1 ===
			registeredBlocker.consecutiveGoalTurnCount;
		let blockerProofComplete = true;
		try {
			assertBlockerRecordIntegrity(registeredBlocker, input.workflowId, true);
			const independentArtifactRefs = new Set(
				input.independentEvidence.flatMap((evidence) =>
					evidence.artifactObservations.map((observation) => digestObject(observation.artifactRef)),
				),
			);
			if (
				registeredBlocker.evidenceRefs.some((ref) => !independentArtifactRefs.has(digestObject(ref))) ||
				registeredBlocker.alternativeResults.some((alternative) =>
					alternative.evidenceRefs.some((ref) => !independentArtifactRefs.has(digestObject(ref))),
				)
			) {
				blockerProofComplete = false;
			}
		} catch (_error: unknown) {
			blockerProofComplete = false;
		}
		if (
			registeredBlocker.workflowId !== input.workflowId ||
			registeredBlocker.consecutiveGoalTurnCount < 3 ||
			observedIds.length !== registeredBlocker.consecutiveGoalTurnCount ||
			new Set(observedIds).size !== observedIds.length ||
			registeredBlocker.firstObservedGoalTurnId !== observedIds[0] ||
			registeredBlocker.lastObservedGoalTurnId !== observedIds[observedIds.length - 1] ||
			!sequenceIsContiguous ||
			input.goalTurnIds.length !== observedIds.length ||
			observedIds.some((goalTurnId, index) => input.goalTurnIds[index] !== goalTurnId) ||
			!blockerProofComplete ||
			!hasDistinctDecisionRefs(registeredBlocker)
		) {
			findings.push({
				code: "blocker_identity_not_repeated",
				message: "The same host-issued blocker identity must survive three consecutive audited goal turns.",
			});
		}
		if (registeredBlocker.remainingSafeAlternativeIds.length > 0) {
			findings.push({
				code: "blocker_alternatives_remaining",
				message: "A blocker cannot be confirmed while safe alternatives remain.",
			});
		}
	}

	for (const item of input.independentEvidence) {
		const validation = await validateWorkflowEvidenceEnvelope({
			workflowId: input.workflowId,
			evidence: item,
			trustedClockReceipt: input.trustedClockReceipt,
			currentWorkspaceDigest: input.currentWorkspaceDigest,
			currentConfigDigest: input.currentConfigDigest,
			currentParserDigest: input.currentParserDigest,
			currentEvaluatorDigest: input.currentEvaluatorDigest,
			currentGuardDigest: input.currentGuardDigest,
			currentRevisions: input.currentRevisions,
			requiredFreshnessMilliseconds: input.requiredFreshnessMilliseconds,
			artifactResolver: input.artifactResolver,
			receiptContext: input.receiptContext,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
		});
		if (validation.accepted) validatedEvidenceDigests.push(validation.evidenceDigest);
		if (!validation.accepted) findings.push(...validation.findings);
	}
	if (input.currentStateDigest.length === 0) {
		findings.push({
			code: "state_digest_required",
			message: "Progress acceptance requires a host-recomputed current state digest.",
		});
	}
	const acceptedRequirementIds = findings.length === 0 ? independentRequirementIds : [];
	const observedRequirementIds = new Set(input.independentEvidence.map((item) => item.requirementId));
	const regressedRequirementIds = (input.priorLedger?.entries ?? [])
		.filter((entry) => entry.status === "proven" && !observedRequirementIds.has(entry.requirementId))
		.map((entry) => entry.requirementId)
		.sort();
	const boundedValidatedEvidenceDigests = validatedEvidenceDigests.slice(
		0,
		WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations,
	);
	const boundedRegressedRequirementIds = regressedRequirementIds.slice(
		0,
		WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations,
	);
	return freezeClone({
		independent: findings.length === 0,
		workspaceDigest: input.currentWorkspaceDigest,
		currentWorkspaceDigest: input.currentWorkspaceDigest,
		currentContractRevision: input.currentRevisions.contractRevision,
		currentScorecardRevision: input.currentRevisions.scorecardRevision,
		currentPlanRevision: input.currentRevisions.planRevision,
		revisions: input.currentRevisions,
		acceptedRequirementIds,
		regressedRequirementIds: boundedRegressedRequirementIds,
		evidenceDigest: digestObject(input.independentEvidence),
		validatedEvidenceDigests: boundedValidatedEvidenceDigests,
		evidenceValidationDigest: digestObject([...boundedValidatedEvidenceDigests].sort()),
		currentStateDigest: input.currentStateDigest,
		blockerProof: registeredBlocker,
		findings: findings.slice(0, WORKFLOW_EVIDENCE_LIMITS.maxScannerFindings),
	});
}

function deriveBlockerId(workflowId: string, claim: WorkflowBlockerClaim): string {
	return digestObject({
		workflowId,
		dependencyId: claim.dependencyId,
		conditionDigest: claim.conditionDigest,
		registeredAlternativeSetDigest: claim.registeredAlternativeSetDigest,
	});
}

function computeRemainingSafeAlternativeIds(claim: WorkflowBlockerClaim): string[] {
	return claim.alternativeResults
		.filter(
			(alternative) =>
				alternative.disposition !== "failed_with_evidence" &&
				alternative.disposition !== "unsafe" &&
				alternative.disposition !== "outside_authority" &&
				alternative.disposition !== "external_state_unavailable",
		)
		.map((alternative) => alternative.alternativeId)
		.sort();
}

function assertWorkflowDecisionRef(ref: WorkflowDecisionRef, workflowId: string): void {
	if (
		ref.decisionId.trim().length === 0 ||
		ref.decisionDigest.trim().length === 0 ||
		!Number.isSafeInteger(ref.revision) ||
		ref.revision < 1 ||
		!Number.isSafeInteger(ref.storeEpoch) ||
		ref.storeEpoch < 1 ||
		!Number.isSafeInteger(ref.coordinatorEpoch) ||
		ref.coordinatorEpoch < 1 ||
		ref.decisionScope.kind !== "workflow" ||
		ref.decisionScope.workflowId !== workflowId ||
		ref.decisionScope.rootSessionId.trim().length === 0
	) {
		throw new Error("Workflow blocker proof requires a positive, workflow-scoped decision reference.");
	}
}

function assertConcreteBlockerClaim(claim: WorkflowBlockerClaim): void {
	if (
		claim.dependencyId.trim().length === 0 ||
		claim.conditionDigest.trim().length === 0 ||
		claim.requiredChange.trim().length === 0 ||
		claim.registeredAlternativeSetDigest.trim().length === 0 ||
		claim.evidenceRefs.length === 0 ||
		claim.evidenceRefs.length > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations ||
		claim.evidenceRefs.some((ref) => ref.digest.trim().length === 0 || ref.sizeBytes <= 0) ||
		claim.alternativeResults.length === 0 ||
		claim.alternativeResults.length > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations ||
		new Set(claim.alternativeResults.map((alternative) => alternative.alternativeId)).size !==
			claim.alternativeResults.length ||
		claim.alternativeResults.some(
			(alternative) =>
				alternative.alternativeId.trim().length === 0 ||
				alternative.strategyDigest.trim().length === 0 ||
				alternative.attemptedStateDigest.trim().length === 0 ||
				alternative.evidenceRefs.length === 0 ||
				alternative.evidenceRefs.length > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations ||
				alternative.evidenceRefs.some((ref) => ref.digest.trim().length === 0 || ref.sizeBytes <= 0),
		)
	) {
		throw new Error("Blocker proof requires concrete obstruction evidence and tried alternatives.");
	}
}

function hasDistinctDecisionRefs(record: WorkflowBlockerRecord, workflowId = record.workflowId): boolean {
	return (
		Number.isSafeInteger(record.consecutiveGoalTurnCount) &&
		record.consecutiveGoalTurnCount > 0 &&
		record.auditDecisionRefs.length === record.consecutiveGoalTurnCount &&
		record.auditDecisionRefs.every((ref) => {
			try {
				assertWorkflowDecisionRef(ref, workflowId);
				return true;
			} catch (_error: unknown) {
				return false;
			}
		}) &&
		new Set(record.auditDecisionRefs.map((ref) => ref.decisionId)).size === record.auditDecisionRefs.length &&
		new Set(record.auditDecisionRefs.map((ref) => ref.decisionDigest)).size === record.auditDecisionRefs.length
	);
}

function assertBlockerRecordIntegrity(
	record: WorkflowBlockerRecord,
	workflowId: string,
	requireConfirmed: boolean,
): void {
	assertConcreteBlockerClaim(record);
	const dispositionValid =
		record.consecutiveGoalTurnCount >= 3
			? record.disposition === "confirmed"
			: !requireConfirmed && record.disposition === "claimed";
	if (
		record.workflowId !== workflowId ||
		record.workflowId.trim().length === 0 ||
		record.blockerId !== deriveBlockerId(record.workflowId, record) ||
		!Number.isSafeInteger(record.firstObservedGoalTurnSequence) ||
		record.firstObservedGoalTurnSequence < 1 ||
		!Number.isSafeInteger(record.lastObservedGoalTurnSequence) ||
		record.lastObservedGoalTurnSequence < 1 ||
		!Number.isSafeInteger(record.consecutiveGoalTurnCount) ||
		record.consecutiveGoalTurnCount < 1 ||
		record.lastObservedGoalTurnSequence - record.firstObservedGoalTurnSequence + 1 !==
			record.consecutiveGoalTurnCount ||
		record.observedGoalTurnIds.length !== record.consecutiveGoalTurnCount ||
		record.observedGoalTurnIds.some((goalTurnId) => goalTurnId.trim().length === 0) ||
		new Set(record.observedGoalTurnIds).size !== record.observedGoalTurnIds.length ||
		record.firstObservedGoalTurnId !== record.observedGoalTurnIds[0] ||
		record.lastObservedGoalTurnId !== record.observedGoalTurnIds.at(-1) ||
		new Set(record.remainingSafeAlternativeIds).size !== record.remainingSafeAlternativeIds.length ||
		record.remainingSafeAlternativeIds.some((alternativeId) => alternativeId.trim().length === 0) ||
		digestObject([...record.remainingSafeAlternativeIds].sort()) !==
			digestObject(computeRemainingSafeAlternativeIds(record)) ||
		(record.disposition === "confirmed" && record.remainingSafeAlternativeIds.length > 0) ||
		!hasDistinctDecisionRefs(record, workflowId) ||
		!dispositionValid
	) {
		throw new Error("Workflow blocker proof identity, epochs, turns, or disposition is invalid.");
	}
}

/**
 * Issue a host-derived blocker record for one audited goal turn.
 *
 * Args:
 * input: Blocker claim, prior host record, goal-turn identity, and audit decision.
 * Return: Blocker record with stable identity and host-owned repetition fields.
 */
export function issueWorkflowBlockerRecord(input: WorkflowBlockerIssueInput): WorkflowBlockerRecord {
	if (
		input.workflowId.trim().length === 0 ||
		input.goalTurnId.trim().length === 0 ||
		!Number.isSafeInteger(input.goalTurnSequence) ||
		input.goalTurnSequence < 1
	) {
		throw new Error("Blocker proof requires a host-issued goal-turn sequence and audit decision.");
	}
	assertConcreteBlockerClaim(input.claim);
	assertWorkflowDecisionRef(input.auditDecisionRef, input.workflowId);
	if (input.prior !== null) assertBlockerRecordIntegrity(input.prior, input.workflowId, false);
	const blockerId = deriveBlockerId(input.workflowId, input.claim);
	const same =
		input.prior !== null &&
		input.prior.blockerId === blockerId &&
		input.prior.conditionDigest === input.claim.conditionDigest &&
		input.prior.registeredAlternativeSetDigest === input.claim.registeredAlternativeSetDigest;
	if (same && input.goalTurnSequence !== input.prior!.lastObservedGoalTurnSequence + 1) {
		throw new Error("Blocker proof requires consecutive host goal turns.");
	}
	const observedGoalTurnIds = same ? [...input.prior!.observedGoalTurnIds, input.goalTurnId] : [input.goalTurnId];
	if (new Set(observedGoalTurnIds).size !== observedGoalTurnIds.length) {
		throw new Error("A blocker observation must use a distinct host goal turn.");
	}
	const auditDecisionRefs = same
		? [...input.prior!.auditDecisionRefs, input.auditDecisionRef]
		: [input.auditDecisionRef];
	if (
		new Set(auditDecisionRefs.map((ref) => ref.decisionId)).size !== auditDecisionRefs.length ||
		new Set(auditDecisionRefs.map((ref) => ref.decisionDigest)).size !== auditDecisionRefs.length
	) {
		throw new Error("Blocker proof requires a distinct host audit decision for every goal turn.");
	}
	const remainingSafeAlternativeIds = computeRemainingSafeAlternativeIds(input.claim);
	return freezeClone({
		...input.claim,
		blockerId,
		workflowId: input.workflowId,
		firstObservedGoalTurnId: observedGoalTurnIds[0] ?? input.goalTurnId,
		lastObservedGoalTurnId: input.goalTurnId,
		firstObservedGoalTurnSequence: same ? input.prior!.firstObservedGoalTurnSequence : input.goalTurnSequence,
		lastObservedGoalTurnSequence: input.goalTurnSequence,
		consecutiveGoalTurnCount: observedGoalTurnIds.length,
		observedGoalTurnIds,
		remainingSafeAlternativeIds,
		auditDecisionRefs,
		disposition:
			observedGoalTurnIds.length >= 3 && remainingSafeAlternativeIds.length === 0 ? "confirmed" : "claimed",
	});
}

function assertPositiveRevisionTuple(revisions: WorkflowRevisionTuple, source: string): void {
	if (Object.values(revisions).some((revision) => !Number.isSafeInteger(revision) || revision < 1)) {
		throw new Error(`Progress ${source} revisions must be positive safe integers.`);
	}
}

function assertLedgerDecisionRef(ref: WorkflowDecisionRef, workflowId: string): void {
	if (
		ref.decisionId.trim().length === 0 ||
		ref.decisionDigest.trim().length === 0 ||
		!Number.isSafeInteger(ref.revision) ||
		ref.revision < 1 ||
		!Number.isSafeInteger(ref.storeEpoch) ||
		ref.storeEpoch < 1 ||
		!Number.isSafeInteger(ref.coordinatorEpoch) ||
		ref.coordinatorEpoch < 1 ||
		ref.decisionScope.kind !== "workflow" ||
		ref.decisionScope.workflowId !== workflowId ||
		ref.decisionScope.rootSessionId.trim().length === 0
	) {
		throw new Error("Progress ledger contains a non-positive or unscoped auditor decision reference.");
	}
}

function assertProgressMetadata(
	ledger: WorkflowProgressLedger,
	evidence: readonly WorkflowEvidenceEnvelope[],
	audit: WorkflowProgressAuditResult,
): WorkflowRevisionTuple {
	const firstEvidence = evidence[0];
	if (firstEvidence === undefined) throw new Error("Progress acceptance requires validated evidence envelopes.");
	if (ledger.workflowId.trim().length === 0) throw new Error("Progress acceptance requires a workflow-bound ledger.");
	const currentRevisions = firstEvidence.revisions;
	assertPositiveRevisionTuple(currentRevisions, "evidence");
	assertPositiveRevisionTuple(audit.revisions, "audit");
	if (
		firstEvidence.workspaceDigest.trim().length === 0 ||
		firstEvidence.configDigest.trim().length === 0 ||
		firstEvidence.parserDigest.trim().length === 0 ||
		firstEvidence.evaluatorDigest.trim().length === 0 ||
		firstEvidence.guardDigest.trim().length === 0
	) {
		throw new Error("Progress acceptance evidence is missing current workspace or configuration metadata.");
	}
	for (const item of evidence) {
		if (
			item.workspaceDigest !== firstEvidence.workspaceDigest ||
			item.configDigest !== firstEvidence.configDigest ||
			item.parserDigest !== firstEvidence.parserDigest ||
			item.evaluatorDigest !== firstEvidence.evaluatorDigest ||
			item.guardDigest !== firstEvidence.guardDigest ||
			digestObject(item.revisions) !== digestObject(currentRevisions) ||
			item.evidenceRevision !== currentRevisions.evidenceRevision
		) {
			throw new Error("Progress acceptance evidence envelopes do not share the current host metadata.");
		}
	}
	if (
		audit.workspaceDigest !== firstEvidence.workspaceDigest ||
		audit.currentWorkspaceDigest !== firstEvidence.workspaceDigest ||
		audit.currentContractRevision !== currentRevisions.contractRevision ||
		audit.currentScorecardRevision !== currentRevisions.scorecardRevision ||
		audit.currentPlanRevision !== currentRevisions.planRevision ||
		digestObject(audit.revisions) !== digestObject(currentRevisions)
	) {
		throw new Error("Progress audit metadata is not host-derived from current evidence.");
	}
	assertPositiveRevisionTuple(ledger.revisions, "ledger");
	if (
		ledger.contractRevision !== ledger.revisions.contractRevision ||
		ledger.scorecardRevision !== ledger.revisions.scorecardRevision ||
		ledger.planRevision !== ledger.revisions.planRevision ||
		ledger.configRevision !== ledger.revisions.configRevision ||
		ledger.evidenceRevision !== ledger.revisions.evidenceRevision ||
		ledger.contractRevision !== currentRevisions.contractRevision ||
		ledger.scorecardRevision !== currentRevisions.scorecardRevision ||
		ledger.planRevision !== currentRevisions.planRevision ||
		ledger.configRevision !== currentRevisions.configRevision ||
		ledger.evidenceRevision > currentRevisions.evidenceRevision
	) {
		throw new Error("Progress ledger revisions are not bound to the current host metadata.");
	}
	for (const entry of ledger.entries) assertLedgerDecisionRef(entry.auditorDecisionRef, ledger.workflowId);
	return currentRevisions;
}

function applyRequirementProgress(
	ledger: WorkflowProgressLedger,
	evidence: readonly WorkflowEvidenceEnvelope[],
	audit: WorkflowProgressAuditResult,
): WorkflowProgressLedger {
	if (
		!audit.independent ||
		audit.workspaceDigest !== audit.currentWorkspaceDigest ||
		audit.currentStateDigest.length === 0 ||
		audit.findings.length > 0
	) {
		throw new Error("Progress audit is not current and independent.");
	}
	const currentRevisions = assertProgressMetadata(ledger, evidence, audit);
	const recomputedEvidenceDigests = evidence.map((item) => digestObject(item)).sort();
	const recomputedEvidenceDigest = digestObject(evidence);
	const derivedAcceptedRequirementIds = [...new Set(evidence.map((item) => item.requirementId))].sort();
	const derivedRegressedRequirementIds = ledger.entries
		.filter((entry) => entry.status === "proven" && !derivedAcceptedRequirementIds.includes(entry.requirementId))
		.map((entry) => entry.requirementId)
		.sort();
	if (
		digestObject(recomputedEvidenceDigests) !== audit.evidenceValidationDigest ||
		digestObject([...audit.validatedEvidenceDigests].sort()) !== audit.evidenceValidationDigest ||
		audit.evidenceDigest !== recomputedEvidenceDigest ||
		digestObject([...audit.acceptedRequirementIds].sort()) !== digestObject(derivedAcceptedRequirementIds) ||
		digestObject([...audit.regressedRequirementIds].sort()) !== digestObject(derivedRegressedRequirementIds)
	) {
		throw new Error("Progress acceptance evidence validation digest is stale or forged.");
	}
	const ledgerRequirementIds = new Set(ledger.entries.map((entry) => entry.requirementId));
	if (evidence.some((item) => !ledgerRequirementIds.has(item.requirementId))) {
		throw new Error("Progress acceptance evidence references an unrelated requirement.");
	}
	const artifactObservationCount = evidence.reduce((count, item) => count + item.artifactObservations.length, 0);
	if (
		evidence.length === 0 ||
		evidence.length > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations ||
		artifactObservationCount > WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations ||
		evidence.some((item) => item.artifactObservations.length === 0)
	) {
		throw new Error("Progress acceptance requires immutable evidence artifact references.");
	}
	if (
		evidence.some(
			(item) =>
				item.result === "hardcoded-success" ||
				item.method === "mock-only" ||
				/^(?:worker|self[-_ ]?report|self[-_ ]?authored)/i.test(item.method) ||
				(item.command !== null && item.command.commandDigest.trim().length === 0) ||
				(item.command === null && /^(?:exit-zero|passed|success|successful)$/i.test(item.result)),
		)
	) {
		throw new Error("Progress acceptance rejects self-asserted or unbound success evidence.");
	}
	if (audit.blockerProof !== null) {
		try {
			assertBlockerRecordIntegrity(audit.blockerProof, audit.blockerProof.workflowId, true);
		} catch (_error: unknown) {
			throw new Error("Progress blocker proof is not host-issued and complete.");
		}
	}
	const accepted = new Set(derivedAcceptedRequirementIds);
	const regressed = new Set(derivedRegressedRequirementIds);
	if (
		derivedAcceptedRequirementIds.some((requirementId) => regressed.has(requirementId)) ||
		new Set(derivedRegressedRequirementIds).size !== derivedRegressedRequirementIds.length
	) {
		throw new Error("Progress regression set is not host-recomputed.");
	}
	const updatedEntries = ledger.entries.map((entry) => {
		const currentEvidence = evidence.filter((item) => item.requirementId === entry.requirementId);
		if (regressed.has(entry.requirementId)) {
			return {
				...entry,
				status: "regressed" as const,
				regressionReason: "current-audit-regression",
				invalidatedByDecisionId: entry.auditorDecisionRef.decisionId,
				workspaceDigest: audit.currentWorkspaceDigest,
				observedAt: currentEvidence.at(-1)?.observedAt ?? entry.observedAt,
				evidenceRefs: currentEvidence.flatMap((item) =>
					item.artifactObservations.map((observation) => observation.artifactRef),
				),
				evidenceRevisions: currentEvidence.map((item) => item.evidenceRevision),
			};
		}
		if (!accepted.has(entry.requirementId)) return entry;
		return {
			...entry,
			status: "proven" as const,
			evidenceRefs: currentEvidence.flatMap((item) =>
				item.artifactObservations.map((observation) => observation.artifactRef),
			),
			evidenceRevisions: currentEvidence.map((item) => item.evidenceRevision),
			invalidatedByDecisionId: null,
			regressionReason: null,
			workspaceDigest: audit.currentWorkspaceDigest,
			observedAt: currentEvidence.at(-1)?.observedAt ?? entry.observedAt,
		};
	});
	const revisions: WorkflowRevisionTuple = {
		...currentRevisions,
		evidenceRevision: Math.max(ledger.evidenceRevision, currentRevisions.evidenceRevision) + 1,
	};
	return freezeClone({
		...ledger,
		...revisions,
		revisions,
		entries: updatedEntries,
		progressDigest: digestObject({
			workflowId: ledger.workflowId,
			revisions,
			entries: updatedEntries,
			evidenceDigest: recomputedEvidenceDigest,
		}),
	});
}

/**
 * Reject direct progress authorization from caller-supplied audit values.
 *
 * Args:
 * ledger: Current durable requirement ledger, retained for the stable public signature.
 * evidence: Evidence envelopes retained for the stable public signature.
 * audit: Caller-supplied audit values, which never authorize progress.
 * Return: Never; progress must pass the host artifact and CAS boundary.
 */
export function acceptRequirementProgress(
	_ledger: WorkflowProgressLedger,
	_evidence: readonly WorkflowEvidenceEnvelope[],
	_audit: WorkflowProgressAuditResult,
): WorkflowProgressLedger {
	throw new Error(
		"Raw progress acceptance is non-authorizing: a host-produced audit artifact, one-use receipt, current workflow head, epochs, evidence binding, and CAS are required; caller self-asserted digests, artifacts, decisions, revisions, and metadata are rejected.",
	);
}

export interface WorkflowProgressRuntimeSnapshot {
	workflowId: string;
	journalHead: WorkflowJournalHead;
	stateDigest: string;
	currentWorkspaceDigest: string;
	currentRevision: number;
	ledger: WorkflowProgressLedger;
}

export interface WorkflowProgressHostCommitInput {
	expected: WorkflowProgressRuntimeSnapshot;
	evidence: readonly WorkflowEvidenceEnvelope[];
	evidenceRefs: readonly WorkflowArtifactRef[];
	expectedLedgerDigest: string;
	nextLedgerDigest: string;
	audit: WorkflowProgressAuditResult;
	auditArtifactRef: WorkflowArtifactRef;
	auditReceipt: WorkflowVerifiedHostReceipt;
	receiptBindingDigest: string;
	nextLedger: WorkflowProgressLedger;
}

export interface WorkflowProgressHostReceiptCommitPort {
	/** The authenticated commit port must invoke this while its durable lease/transaction is held. */
	verifyAndConsume(input: {
		current: WorkflowProgressRuntimeSnapshot;
		commitInput: WorkflowProgressHostCommitInput;
	}): Promise<WorkflowVerifiedHostReceipt>;
}

const workflowProgressHostAuthorizerBrand: unique symbol = Symbol("workflow-progress-host-authorizer");

export interface WorkflowProgressHostAuthorizer {
	readonly [workflowProgressHostAuthorizerBrand]: true;
	readonly workflowId: string;
}

interface WorkflowProgressHostAuthorizerOperations {
	readCurrent(): Promise<WorkflowProgressRuntimeSnapshot>;
	readTrustedNow(): Promise<string>;
	commit(
		input: WorkflowProgressHostCommitInput,
		revalidate: () => Promise<WorkflowProgressHostCommitInput>,
		receiptContext: WorkflowHostReceiptConsumerContext,
	): Promise<WorkflowProgressLedger>;
}

const workflowProgressHostAuthorizerOperations = new WeakMap<object, WorkflowProgressHostAuthorizerOperations>();

function assertWorkflowProgressRuntimeSnapshot(
	snapshot: WorkflowProgressRuntimeSnapshot,
	runtimeStore: WorkflowRuntimeStore,
): void {
	const durable = runtimeStore.durableContext;
	if (
		snapshot.workflowId !== runtimeStore.identity.workflowId ||
		snapshot.journalHead.workflowId !== snapshot.workflowId ||
		snapshot.ledger.workflowId !== snapshot.workflowId ||
		durable === undefined ||
		digestObject(snapshot.journalHead.epochRef) !== digestObject(durable.epochRef) ||
		!Number.isSafeInteger(snapshot.journalHead.sequence) ||
		snapshot.journalHead.sequence < 0 ||
		(snapshot.journalHead.eventDigest !== null && typeof snapshot.journalHead.eventDigest !== "string") ||
		!isPositiveSafeInteger(snapshot.journalHead.epochRef.storeEpoch) ||
		!isPositiveSafeInteger(snapshot.journalHead.epochRef.coordinatorEpoch) ||
		!isPositiveSafeInteger(snapshot.currentRevision) ||
		typeof snapshot.stateDigest !== "string" ||
		typeof snapshot.currentWorkspaceDigest !== "string" ||
		snapshot.stateDigest.trim().length === 0 ||
		snapshot.currentWorkspaceDigest.trim().length === 0
	) {
		throw new Error("Workflow progress runtime snapshot is foreign, stale, or not bound to the authenticated store.");
	}
}

/**
 * Create the opaque host authorizer used by the public progress boundary.
 *
 * Args:
 * input: Exact runtime store plus composition-owned read and atomic commit ports.
 * Return: Frozen branded capability; its runtime operations stay private to this module.
 */
export function createWorkflowProgressHostAuthorizer(input: {
	runtimeStore: WorkflowRuntimeStore;
	trustedNow: () => string | Promise<string>;
	readCurrent: (
		runtimeStore: WorkflowRuntimeStore,
		journalHead: WorkflowJournalHead,
	) => Promise<Omit<WorkflowProgressRuntimeSnapshot, "journalHead">>;
	commit: (
		runtimeStore: WorkflowRuntimeStore,
		input: WorkflowProgressHostCommitInput,
		receiptCommit: WorkflowProgressHostReceiptCommitPort,
	) => Promise<WorkflowProgressLedger>;
}): WorkflowProgressHostAuthorizer {
	if (input.runtimeStore.durableContext === undefined) {
		throw new Error("workflow_progress_authority_requires_persisted_runtime");
	}
	const readCurrent = async (): Promise<WorkflowProgressRuntimeSnapshot> => {
		const durable = input.runtimeStore.durableContext;
		if (durable === undefined) throw new Error("workflow_progress_authority_requires_persisted_runtime");
		const replay = await input.runtimeStore.replay({
			workflowId: input.runtimeStore.identity.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: durable.epochRef.storeEpoch,
		});
		if (replay.quarantined) throw new Error("workflow_progress_runtime_journal_quarantined");
		const read = await input.readCurrent(input.runtimeStore, replay.head);
		const snapshot = freezeCanonicalClone({
			...read,
			workflowId: input.runtimeStore.identity.workflowId,
			journalHead: replay.head,
		});
		assertWorkflowProgressRuntimeSnapshot(snapshot, input.runtimeStore);
		return snapshot;
	};
	const commit = async (
		commitInput: WorkflowProgressHostCommitInput,
		revalidate: () => Promise<WorkflowProgressHostCommitInput>,
		receiptContext: WorkflowHostReceiptConsumerContext,
	): Promise<WorkflowProgressLedger> => {
		const expected = freezeCanonicalClone(commitInput.expected);
		assertWorkflowProgressRuntimeSnapshot(expected, input.runtimeStore);
		const current = await readCurrent();
		if (digestObject(current) !== digestObject(expected)) {
			throw new Error("Workflow progress runtime snapshot is stale before its authenticated CAS.");
		}
		const revalidated = freezeCanonicalClone(await revalidate());
		if (digestObject(revalidated.expected) !== digestObject(expected)) {
			throw new Error("Workflow progress runtime snapshot changed during final artifact revalidation.");
		}
		if (
			revalidated.expectedLedgerDigest !== digestObject(revalidated.expected.ledger) ||
			revalidated.nextLedgerDigest !== digestObject(revalidated.nextLedger)
		) {
			throw new Error("Workflow progress ledger digest is not canonical at the authenticated CAS.");
		}
		let receiptConsumed = false;
		const receiptCommit: WorkflowProgressHostReceiptCommitPort = Object.freeze({
			verifyAndConsume: async ({
				current,
				commitInput: candidate,
			}: {
				current: WorkflowProgressRuntimeSnapshot;
				commitInput: WorkflowProgressHostCommitInput;
			}) => {
				const authoritativeCurrent = freezeCanonicalClone(current);
				const rereadCurrent = await readCurrent();
				const canonicalCandidate = freezeCanonicalClone(candidate);
				assertWorkflowProgressRuntimeSnapshot(authoritativeCurrent, input.runtimeStore);
				if (digestObject(rereadCurrent) !== digestObject(authoritativeCurrent)) {
					throw new Error("Workflow progress receipt transaction observed a changed runtime head.");
				}
				if (
					digestObject(authoritativeCurrent) !== digestObject(expected) ||
					digestObject(canonicalCandidate) !== digestObject(revalidated)
				) {
					throw new Error("Workflow progress receipt transaction observed a stale or foreign runtime tuple.");
				}
				const verified = await verifyHostReceipt({
					context: receiptContext,
					workflowId: authoritativeCurrent.workflowId,
					expectedBindingDigest: canonicalCandidate.receiptBindingDigest,
					receipt: canonicalCandidate.auditReceipt,
					currentStateDigest: authoritativeCurrent.stateDigest,
					currentRevision: authoritativeCurrent.currentRevision,
					trustedNow: await input.trustedNow(),
				});
				await consumeOneUseReceipt({
					context: receiptContext,
					workflowId: authoritativeCurrent.workflowId,
					expectedBindingDigest: canonicalCandidate.receiptBindingDigest,
					receipt: verified,
					currentRevision: authoritativeCurrent.currentRevision,
				});
				receiptConsumed = true;
				return verified;
			},
		});
		const committed = freezeCanonicalClone(
			await input.commit(input.runtimeStore, { ...revalidated, expected }, receiptCommit),
		);
		if (revalidated.auditReceipt.oneUse && !receiptConsumed) {
			throw new Error("Workflow progress host CAS did not consume its one-use receipt atomically.");
		}
		if (digestObject(committed) !== digestObject(revalidated.nextLedger)) {
			throw new Error("Workflow progress host CAS returned an unbound ledger.");
		}
		return committed;
	};
	const readOnlyAuthorizer: WorkflowProgressHostAuthorizer = Object.freeze({
		[workflowProgressHostAuthorizerBrand]: true as const,
		workflowId: input.runtimeStore.identity.workflowId,
	});
	workflowProgressHostAuthorizerOperations.set(readOnlyAuthorizer, {
		readCurrent,
		readTrustedNow: async () => {
			const trustedNow = await input.trustedNow();
			if (typeof trustedNow !== "string" || !Number.isFinite(Date.parse(trustedNow))) {
				throw new Error("Workflow progress host clock is invalid.");
			}
			return trustedNow;
		},
		commit,
	});
	return readOnlyAuthorizer;
}

/**
 * Accept audited progress through a host state-and-progress compare-and-swap boundary.
 *
 * Args:
 * input: Caller evidence/audit plus immutable host artifact, receipt context, and branded authorizer.
 * Return: Ledger committed by the host store.
 */
export async function acceptRequirementProgressAtHost(input: {
	evidence: readonly WorkflowEvidenceEnvelope[];
	audit: WorkflowProgressAuditResult;
	auditArtifact: WorkflowProgressAuditArtifactRef;
	receiptContext: WorkflowHostReceiptConsumerContext;
	authorizer: WorkflowProgressHostAuthorizer;
}): Promise<WorkflowProgressLedger> {
	const candidateAuthorizer: unknown = input.authorizer;
	if (typeof candidateAuthorizer !== "object" || candidateAuthorizer === null) {
		throw new Error("Workflow progress acceptance requires the opaque host authorizer.");
	}
	const authorizerOperations = workflowProgressHostAuthorizerOperations.get(candidateAuthorizer);
	const authorizerRecord = candidateAuthorizer as Record<PropertyKey, unknown>;
	if (authorizerRecord[workflowProgressHostAuthorizerBrand] !== true || authorizerOperations === undefined) {
		throw new Error("Workflow progress acceptance requires the opaque host authorizer.");
	}
	const evidence = freezeCanonicalClone(input.evidence);
	const callerAudit = freezeCanonicalClone(input.audit);
	const auditArtifact = freezeCanonicalClone(input.auditArtifact);
	const receiptContext = Object.freeze({
		...input.receiptContext,
		revokedReceiptIds: new Set(input.receiptContext.revokedReceiptIds),
	});
	void callerAudit;
	const runtimeSnapshot = freezeCanonicalClone(await authorizerOperations.readCurrent());
	const trustedNow = await authorizerOperations.readTrustedNow();
	const ledger = runtimeSnapshot.ledger;
	const expectedStateDigest = runtimeSnapshot.stateDigest;
	const currentWorkspaceDigest = runtimeSnapshot.currentWorkspaceDigest;
	const storeEpoch = runtimeSnapshot.journalHead.epochRef.storeEpoch;
	const coordinatorEpoch = runtimeSnapshot.journalHead.epochRef.coordinatorEpoch;
	const currentRevision = runtimeSnapshot.currentRevision;
	const workflowId = runtimeSnapshot.workflowId;
	if (
		!isPositiveSafeInteger(storeEpoch) ||
		!isPositiveSafeInteger(coordinatorEpoch) ||
		!isPositiveSafeInteger(currentRevision) ||
		auditArtifact.receipt.receiptKind !== "adjudication" ||
		auditArtifact.receipt.oneUse !== true ||
		auditArtifact.receipt.payloadDigest !== auditArtifact.artifactRef.digest ||
		auditArtifact.artifactRef.sourceEventSequence !== runtimeSnapshot.journalHead.sequence
	) {
		throw new Error(
			"Progress acceptance requires a signed one-use adjudication receipt bound to its audit artifact.",
		);
	}
	assertLedgerEpochBinding(ledger, storeEpoch, coordinatorEpoch);
	const evidenceDigest = digestObject(evidence);
	const progressDigest = ledger.progressDigest;
	const firstEvidenceRefs = await resolveEvidenceArtifacts(receiptContext.artifactResolver, evidence);
	const firstPayload = await resolveProgressAuditArtifact(receiptContext.artifactResolver, auditArtifact);
	assertProgressAuditArtifactBinding({
		payload: firstPayload,
		workflowId,
		headDigest: expectedStateDigest,
		journalHead: runtimeSnapshot.journalHead,
		progressDigest,
		storeEpoch,
		coordinatorEpoch,
		currentRevision,
		evidenceDigest,
	});
	if (
		firstPayload.audit.evidenceDigest !== evidenceDigest ||
		firstPayload.audit.currentStateDigest !== expectedStateDigest ||
		firstPayload.audit.currentWorkspaceDigest !== currentWorkspaceDigest
	) {
		throw new Error("Progress acceptance audit is not the immutable host-produced audit for this evidence.");
	}
	const nextLedger = applyRequirementProgress(ledger, evidence, firstPayload.audit);
	const expectedLedgerDigest = digestObject(ledger);
	const nextLedgerDigest = digestObject(nextLedger);
	const bindingDigest = computeWorkflowProgressAuditReceiptBinding({
		workflowId,
		headDigest: expectedStateDigest,
		journalHead: runtimeSnapshot.journalHead,
		progressDigest,
		storeEpoch,
		coordinatorEpoch,
		currentRevision,
		evidenceDigest,
		auditArtifactRef: auditArtifact.artifactRef,
		expectedLedger: ledger,
		nextLedger,
		evidenceRefs: firstEvidenceRefs,
	});
	if (
		auditArtifact.receipt.bindingDigest !== bindingDigest ||
		auditArtifact.receipt.workflowId !== workflowId ||
		auditArtifact.receipt.revision !== currentRevision ||
		auditArtifact.receipt.stateDigest !== expectedStateDigest
	) {
		throw new Error("Progress acceptance receipt is stale or foreign to the current workflow head and epochs.");
	}
	await verifyHostReceipt({
		context: receiptContext,
		workflowId,
		expectedBindingDigest: bindingDigest,
		receipt: auditArtifact.receipt,
		currentStateDigest: expectedStateDigest,
		currentRevision,
		trustedNow,
	});
	const secondPayload = await resolveProgressAuditArtifact(receiptContext.artifactResolver, auditArtifact);
	assertProgressAuditArtifactBinding({
		payload: secondPayload,
		workflowId,
		headDigest: expectedStateDigest,
		journalHead: runtimeSnapshot.journalHead,
		progressDigest,
		storeEpoch,
		coordinatorEpoch,
		currentRevision,
		evidenceDigest,
	});
	if (
		digestObject(secondPayload) !== digestObject(firstPayload) ||
		secondPayload.audit.evidenceDigest !== evidenceDigest ||
		secondPayload.audit.currentWorkspaceDigest !== currentWorkspaceDigest
	) {
		throw new Error("Progress acceptance audit artifact changed before the host CAS.");
	}
	const secondEvidenceRefs = await resolveEvidenceArtifacts(receiptContext.artifactResolver, evidence);
	if (!sameArtifactRefSequence(firstEvidenceRefs, secondEvidenceRefs)) {
		throw new Error("Workflow evidence artifact references changed before the host CAS.");
	}
	const finalLedger = applyRequirementProgress(ledger, evidence, secondPayload.audit);
	if (digestObject(finalLedger) !== digestObject(nextLedger)) {
		throw new Error("Workflow progress ledger changed during host audit revalidation.");
	}
	const finalLedgerDigest = digestObject(finalLedger);
	if (finalLedgerDigest !== nextLedgerDigest) {
		throw new Error("Workflow progress ledger digest changed during host audit revalidation.");
	}
	const finalBindingDigest = computeWorkflowProgressAuditReceiptBinding({
		workflowId,
		headDigest: expectedStateDigest,
		journalHead: runtimeSnapshot.journalHead,
		progressDigest,
		storeEpoch,
		coordinatorEpoch,
		currentRevision,
		evidenceDigest,
		auditArtifactRef: auditArtifact.artifactRef,
		expectedLedger: ledger,
		nextLedger: finalLedger,
		evidenceRefs: secondEvidenceRefs,
	});
	if (finalBindingDigest !== bindingDigest) {
		throw new Error("Workflow progress receipt binding changed before the host CAS.");
	}
	const commitInput: WorkflowProgressHostCommitInput = {
		expected: runtimeSnapshot,
		evidence,
		evidenceRefs: secondEvidenceRefs,
		expectedLedgerDigest,
		nextLedgerDigest: finalLedgerDigest,
		audit: secondPayload.audit,
		auditArtifactRef: auditArtifact.artifactRef,
		auditReceipt: auditArtifact.receipt,
		receiptBindingDigest: bindingDigest,
		nextLedger: finalLedger,
	};
	const committed = await authorizerOperations.commit(
		commitInput,
		async () => {
			await verifyHostReceipt({
				context: receiptContext,
				workflowId,
				expectedBindingDigest: bindingDigest,
				receipt: auditArtifact.receipt,
				currentStateDigest: expectedStateDigest,
				currentRevision,
				trustedNow,
			});
			const thirdPayload = await resolveProgressAuditArtifact(receiptContext.artifactResolver, auditArtifact);
			assertProgressAuditArtifactBinding({
				payload: thirdPayload,
				workflowId,
				headDigest: expectedStateDigest,
				journalHead: runtimeSnapshot.journalHead,
				progressDigest,
				storeEpoch,
				coordinatorEpoch,
				currentRevision,
				evidenceDigest,
			});
			if (
				digestObject(thirdPayload) !== digestObject(secondPayload) ||
				thirdPayload.audit.evidenceDigest !== evidenceDigest ||
				thirdPayload.audit.currentWorkspaceDigest !== currentWorkspaceDigest
			) {
				throw new Error("Progress audit artifact changed during final host CAS revalidation.");
			}
			const thirdEvidenceRefs = await resolveEvidenceArtifacts(receiptContext.artifactResolver, evidence);
			if (!sameArtifactRefSequence(secondEvidenceRefs, thirdEvidenceRefs)) {
				throw new Error("Workflow evidence artifact references changed during final host CAS revalidation.");
			}
			const thirdLedger = applyRequirementProgress(ledger, evidence, thirdPayload.audit);
			if (digestObject(thirdLedger) !== digestObject(finalLedger)) {
				throw new Error("Workflow progress ledger changed during final host CAS revalidation.");
			}
			const thirdBindingDigest = computeWorkflowProgressAuditReceiptBinding({
				workflowId,
				headDigest: expectedStateDigest,
				journalHead: runtimeSnapshot.journalHead,
				progressDigest,
				storeEpoch,
				coordinatorEpoch,
				currentRevision,
				evidenceDigest,
				auditArtifactRef: auditArtifact.artifactRef,
				expectedLedger: ledger,
				nextLedger: thirdLedger,
				evidenceRefs: thirdEvidenceRefs,
			});
			if (thirdBindingDigest !== bindingDigest) {
				throw new Error("Workflow progress receipt binding changed during final host CAS revalidation.");
			}
			return {
				...commitInput,
				evidenceRefs: thirdEvidenceRefs,
				audit: thirdPayload.audit,
				nextLedger: thirdLedger,
				nextLedgerDigest: digestObject(thirdLedger),
			};
		},
		receiptContext,
	);
	return freezeClone(committed);
}
