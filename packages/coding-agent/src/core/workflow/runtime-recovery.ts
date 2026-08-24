import type { WorkflowAdmissionRegistry, WorkflowAdmissionResult } from "./admission.js";
import { commitAuthenticated, digestWorkflowOutcome } from "./admission.js";
import type {
	WorkflowArtifactRef,
	WorkflowAttemptStatus,
	WorkflowChildIdentity,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowLeaseRef,
	WorkflowProcessGroupIdentity,
	WorkflowRuntimeEventPayload,
	WorkflowRuntimeStore,
	WorkflowStoreReplayResult,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { canonicalJsonBytes, digestObject, sha256Hex } from "./contracts.js";
import type { WorkflowDispatchRecoveryBinding } from "./dispatch.js";
import {
	canonicalWorkflowEffectOwnershipTokenDigest,
	type WorkflowEffectBroker,
	type WorkflowEffectExecutionContext,
} from "./effect-broker.js";
import type { WorkflowEpochManager } from "./epochs.js";
import type { WorkflowLeaseManager } from "./leases.js";
import type {
	WorkflowProcessContainmentVerifier,
	WorkflowProcessGroupController,
	WorkflowUnknownDescendant,
} from "./process-groups.js";
import { workflowProcessGroupIdentityMatches } from "./process-groups.js";
import type { WorkflowReconciliationOutcome, WorkflowRecoveryPort, WorkflowRecoveryRequest } from "./recovery.js";
import { assertWorkflowRuntimeVersion } from "./runtime-store-adapter.js";

export type { WorkflowReconciliationOutcome, WorkflowRecoveryPort, WorkflowRecoveryRequest } from "./recovery.js";

export interface WorkflowRuntimeRecoveryCapabilities {
	readonly processIdentity?: boolean;
	readonly effectResolution?: boolean;
	readonly capabilityDigest?: string;
}

export interface WorkflowRuntimeRecoveryObservation {
	readonly artifactRef: WorkflowArtifactRef;
	readonly workspaceDigest: string;
	readonly observedAt: string;
	readonly journalHeadDigest: string;
}

export interface WorkflowRuntimeRecoveryNoStartEvidence {
	readonly preExecutionBaseline: WorkflowRuntimeRecoveryObservation;
	readonly postObservation: WorkflowRuntimeRecoveryObservation;
	readonly effectIdentityDigest: string;
	readonly trustedNow: string;
	readonly hostReceipt: WorkflowVerifiedHostReceipt;
	readonly proofDigest: string;
}

export interface WorkflowRuntimeRecoveryStartResult {
	readonly status: "started" | "blocked";
	readonly binding: WorkflowDispatchRecoveryBinding | null;
	readonly nonExecutionProof: string | null;
	readonly journalHeadDigest: string | null;
}

export interface WorkflowRuntimeRecoveryClaimInput {
	readonly claimId: string;
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly stateDigest: string;
	readonly headDigest: string;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly writerIdentity: string;
}

export interface WorkflowRuntimeRecoveryClaimStore {
	acquire(
		input: WorkflowRuntimeRecoveryClaimInput,
	): Promise<
		| { readonly status: "acquired" }
		| { readonly status: "held" }
		| { readonly status: "conflict" }
		| { readonly status: "completed"; readonly outcome: WorkflowReconciliationOutcome }
	>;
	complete(input: WorkflowRuntimeRecoveryClaimInput, outcome: WorkflowReconciliationOutcome): Promise<void>;
	release(input: WorkflowRuntimeRecoveryClaimInput): Promise<void>;
}

export interface WorkflowRuntimeRecoveryReadiness {
	readonly canRecover: boolean;
	readonly blockingReasons: readonly string[];
}

export interface WorkflowRuntimeRecoveryDependencies {
	readonly workflowId: string;
	readonly store: WorkflowRuntimeStore;
	readonly epochs: Pick<WorkflowEpochManager, "assertCurrent">;
	readonly admission: Pick<
		WorkflowAdmissionRegistry,
		"hydrateFromReplay" | "hydrateQuarantineFromReplay" | "lookupByExecutionKey" | "quarantine"
	>;
	readonly leases: Pick<WorkflowLeaseManager, "hydrateFromReplay" | "lookupByLease" | "release" | "quarantine">;
	readonly groups: Pick<
		WorkflowProcessGroupController,
		"hydrateFromReplay" | "verify" | "inspect" | "terminate" | "reap" | "quarantine" | "scanUnknownDescendants"
	>;
	/** Host-authenticated process identity and containment evidence; recovery never trusts a PID-only check. */
	readonly processContainmentVerifier?: WorkflowProcessContainmentVerifier;
	readonly effects: Pick<WorkflowEffectBroker, "reconcile">;
	/** Durable CAS claim; process-local locks are only an optimization around this authority. */
	readonly recoveryClaims?: WorkflowRuntimeRecoveryClaimStore;
	/** Serialize the authenticated replay snapshot used to bind a durable claim. */
	readonly withRecoveryReadBoundary?: <T>(boundary: string, operation: () => Promise<T>) => Promise<T>;
	/** Resolve the complete lease, revision, decision, and ownership context required by effect reconciliation. */
	readonly readEffectReconciliationContext?: (
		request: WorkflowRecoveryRequest,
		effectIntent: Extract<WorkflowRuntimeEventPayload, { kind: "workflow_effect_intent" }>,
		admission: WorkflowAdmissionResult | undefined,
	) => Promise<WorkflowEffectExecutionContext | null>;
	readonly readKnownRecoveryBindings?: (request: WorkflowRecoveryRequest) => Promise<{
		readonly admission?: WorkflowAdmissionResult;
		readonly processGroups: readonly WorkflowProcessGroupIdentity[];
	}>;
	readonly readNoStartEvidence?: (
		request: WorkflowRecoveryRequest,
		replay: WorkflowStoreReplayResult,
	) => Promise<WorkflowRuntimeRecoveryNoStartEvidence | null>;
	readonly verifyNoStartEvidence?: (
		request: WorkflowRecoveryRequest,
		replay: WorkflowStoreReplayResult,
		evidence: WorkflowRuntimeRecoveryNoStartEvidence,
	) => Promise<boolean>;
	readonly resolveUnknownDescendantIdentity?: (
		descendant: WorkflowUnknownDescendant,
		workflowId: string,
	) => Promise<WorkflowProcessGroupIdentity | null>;
	readonly writerIdentity?: string;
	readonly activeLeaseRef?: WorkflowLeaseRef;
	readonly readActiveLeaseRef?: () => Promise<WorkflowLeaseRef | null>;
	readonly readWorkspaceDigest?: (request: WorkflowRecoveryRequest) => Promise<string>;
	readonly readTranscriptDigest?: (request: WorkflowRecoveryRequest) => Promise<string | null>;
	readonly runtimeVersion?: string;
	readonly hostCapabilityRevision?: string;
	readonly readCurrentHostCapabilityRevision?: () => Promise<string>;
	readonly readTrustedNow?: () => Promise<string>;
	readonly capabilities?: WorkflowRuntimeRecoveryCapabilities;
	readonly enabled?: boolean;
}

export interface WorkflowRuntimeRecoveryCoordinator extends WorkflowRecoveryPort {
	readiness(): WorkflowRuntimeRecoveryReadiness;
	startRecovery(request?: WorkflowRecoveryRequest): Promise<WorkflowRuntimeRecoveryStartResult>;
	beginRecovery(request?: WorkflowRecoveryRequest): Promise<WorkflowRuntimeRecoveryStartResult>;
}

export class WorkflowRuntimeRecoveryError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "WorkflowRuntimeRecoveryError";
		this.code = code;
	}
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function nonEmpty(value: string): boolean {
	return value.length > 0 && !value.includes("\u0000");
}

function canonicalChildIdentityDigest(identity: WorkflowChildIdentity): string {
	const { identityDigest: _identityDigest, ...unsignedIdentity } = identity;
	return digestObject(unsignedIdentity);
}

function validProcessGroupIdentity(identity: WorkflowProcessGroupIdentity): boolean {
	const { identityDigest: _identityDigest, ...unsignedIdentity } = identity;
	return (
		Number.isSafeInteger(identity.pid) &&
		identity.pid > 0 &&
		Number.isSafeInteger(identity.parentPid) &&
		identity.parentPid >= 0 &&
		nonEmpty(identity.processStartId) &&
		nonEmpty(identity.processGroupId) &&
		identity.identityDigest === digestObject(unsignedIdentity)
	);
}

function sameIdentity(left: WorkflowChildIdentity, right: WorkflowChildIdentity): boolean {
	return (
		left.identityDigest === canonicalChildIdentityDigest(left) &&
		right.identityDigest === canonicalChildIdentityDigest(right) &&
		left.identityDigest === right.identityDigest &&
		left.executionKey === right.executionKey &&
		sameEpoch(left.epochRef, right.epochRef)
	);
}

function uniqueEvidenceRefs(refs: readonly WorkflowArtifactRef[]): readonly WorkflowArtifactRef[] {
	const seen = new Set<string>();
	const result: WorkflowArtifactRef[] = [];
	for (const ref of refs) {
		if (seen.has(ref.digest)) continue;
		seen.add(ref.digest);
		result.push(ref);
	}
	return result;
}

function eventPayloads(replay: WorkflowStoreReplayResult): readonly WorkflowRuntimeEventPayload[] {
	return replay.events.map((event) => event.payload).filter(isRuntimeEventPayload);
}

function validateAuthenticatedReplay(replay: WorkflowStoreReplayResult): void {
	const hasAuthenticatedEnvelope = replay.events.some(
		(event) => event.recordVersion !== undefined || event.payloadBytes !== undefined,
	);
	if (!hasAuthenticatedEnvelope) return;
	let priorEventDigest: string | null = null;
	const idempotencyKeys = new Set<string>();
	for (const [index, event] of replay.events.entries()) {
		if (
			event.workflowId !== replay.workflowId ||
			event.sequence !== index + 1 ||
			event.recordVersion !== 1 ||
			event.payloadBytes === undefined ||
			event.payloadDigest !== digestObject(event.payload) ||
			canonicalJsonBytes(event.payload).some((byte, payloadIndex) => event.payloadBytes[payloadIndex] !== byte) ||
			event.payloadBytes.byteLength !== canonicalJsonBytes(event.payload).byteLength ||
			event.priorEventDigest !== priorEventDigest ||
			!nonEmpty(event.idempotencyKey) ||
			!nonEmpty(event.generationId) ||
			!nonEmpty(event.recordMac) ||
			!nonEmpty(event.recordChecksum) ||
			!nonEmpty(event.preparedFrameDigest) ||
			!nonEmpty(event.committedFrameDigest) ||
			!nonEmpty(event.keyId) ||
			!nonEmpty(event.preparedFrameMac) ||
			!nonEmpty(event.committedFrameMac) ||
			!nonEmpty(event.preparedFrameChecksum) ||
			!nonEmpty(event.committedFrameChecksum) ||
			!nonEmpty(event.writerIdentity) ||
			!nonEmpty(event.leaseRef.leaseId) ||
			!nonEmpty(event.leaseRef.processIdentity) ||
			!nonEmpty(event.leaseRef.rootDigest) ||
			!nonEmpty(event.leaseRef.writerIdentity) ||
			event.leaseRef.writerIdentity !== event.writerIdentity ||
			!sameEpoch(event.leaseRef, event.epochRef) ||
			!Number.isSafeInteger(event.leaseRef.acquisitionEventSequence) ||
			event.leaseRef.acquisitionEventSequence < 1 ||
			!Number.isFinite(Date.parse(event.leaseRef.acquiredAt)) ||
			!Number.isFinite(Date.parse(event.leaseRef.expiresAt)) ||
			Date.parse(event.leaseRef.expiresAt) <= Date.parse(event.leaseRef.acquiredAt) ||
			idempotencyKeys.has(event.idempotencyKey) ||
			digestObject(event.expectedHead) !==
				digestObject({
					workflowId: replay.workflowId,
					sequence: index,
					eventDigest: priorEventDigest,
					epochRef: event.expectedHead.epochRef,
				}) ||
			event.expectedHead.sequence !== index ||
			!sameEpoch(event.epochRef, event.expectedHead.epochRef) ||
			digestObject(event.semanticBinding.expectedHead) !== digestObject(event.expectedHead) ||
			digestObject(event.semanticBinding.epochRef) !== digestObject(event.epochRef) ||
			digestObject(event.semanticBinding.leaseRef) !== digestObject(event.leaseRef) ||
			event.semanticBinding.writerIdentity !== event.writerIdentity ||
			event.semanticBinding.idempotencyKey !== event.idempotencyKey ||
			event.semanticBinding.executionKey !== event.executionKey
		)
			throw new WorkflowRuntimeRecoveryError("workflow_authenticated_journal_invalid");
		const eventDigest = sha256Hex(
			canonicalJsonBytes({
				workflowId: event.workflowId,
				sequence: event.sequence,
				payloadBytes: Array.from(event.payloadBytes),
				priorEventDigest: event.priorEventDigest,
				idempotencyKey: event.idempotencyKey,
				semanticBinding: event.semanticBinding,
			}),
		);
		if (event.eventDigest !== eventDigest)
			throw new WorkflowRuntimeRecoveryError("workflow_authenticated_journal_invalid");
		const proof = event.commitReturnProof;
		const { proofDigest: _proofDigest, ...proofWithoutDigest } = proof ?? {};
		if (
			proof === undefined ||
			!nonEmpty(proof.mutationId) ||
			!nonEmpty(proof.generationId) ||
			!nonEmpty(proof.writerIdentity) ||
			!nonEmpty(proof.keyId) ||
			!nonEmpty(proof.frameMac) ||
			!nonEmpty(proof.frameChecksum) ||
			!nonEmpty(proof.recordMac) ||
			!nonEmpty(proof.recordChecksum) ||
			!nonEmpty(proof.returnedAt) ||
			!Number.isFinite(Date.parse(proof.returnedAt)) ||
			proof.mutationId !== event.returnProofId ||
			proof.sequence !== event.sequence ||
			proof.eventDigest !== event.eventDigest ||
			proof.committedFrameDigest !== event.committedFrameDigest ||
			digestObject(proof.expectedHead) !== digestObject(event.expectedHead) ||
			digestObject(proof.epochRef) !== digestObject(event.epochRef) ||
			digestObject(proof.leaseRef) !== digestObject(event.leaseRef) ||
			proof.writerIdentity !== event.writerIdentity ||
			proof.idempotencyKey !== event.idempotencyKey ||
			proof.keyId !== event.keyId ||
			proof.frameMac !== event.committedFrameMac ||
			proof.frameChecksum !== event.committedFrameChecksum ||
			proof.recordMac !== event.recordMac ||
			proof.recordChecksum !== event.recordChecksum ||
			proof.priorRecordDigest !== event.priorEventDigest ||
			(proof.proofDigest !== digestObject(proofWithoutDigest) &&
				proof.proofDigest !== digestObject({ ...proof, proofDigest: "" }))
		)
			throw new WorkflowRuntimeRecoveryError("workflow_authenticated_journal_invalid");
		idempotencyKeys.add(event.idempotencyKey);
		priorEventDigest = event.eventDigest;
	}
	const lastEvent = replay.events.at(-1);
	if (
		lastEvent === undefined ||
		replay.head.sequence !== lastEvent.sequence ||
		replay.head.eventDigest !== lastEvent.eventDigest ||
		digestObject(replay.head.epochRef) !== digestObject(lastEvent.epochRef)
	)
		throw new WorkflowRuntimeRecoveryError("workflow_authenticated_journal_invalid");
}

function isRuntimeEventPayload(payload: WorkflowEventPayload): payload is WorkflowRuntimeEventPayload {
	return (
		payload.kind === "workflow_dispatch_intent" ||
		payload.kind === "workflow_child_identity_bound" ||
		payload.kind === "workflow_child_outcome_committed" ||
		payload.kind === "workflow_effect_intent" ||
		payload.kind === "workflow_effect_completed" ||
		payload.kind === "workflow_effect_ambiguous" ||
		payload.kind === "workflow_process_group_owned" ||
		payload.kind === "workflow_process_group_fenced" ||
		payload.kind === "workflow_process_group_reaped" ||
		payload.kind === "workflow_lease_release_recorded" ||
		payload.kind === "workflow_lease_quarantined" ||
		payload.kind === "workflow_recovery_started" ||
		payload.kind === "workflow_reconciliation_recorded"
	);
}

function recoveryAttemptStateDigest(request: WorkflowRecoveryRequest): string {
	return digestObject({
		workflowId: request.workflowId,
		taskId: request.taskId,
		attemptId: request.attemptId,
		executionKey: request.executionKey,
		persistedChildIdentity: request.persistedChildIdentity,
		evidenceRefs: request.evidenceRefs,
	});
}

function recoveryAttemptId(request: WorkflowRecoveryRequest, headDigest = "head-unavailable"): string {
	return [
		"reconciliation",
		request.workflowId,
		request.taskId,
		request.attemptId,
		request.executionKey,
		recoveryAttemptStateDigest(request),
		headDigest,
		request.epochRef.storeEpoch,
		request.epochRef.coordinatorEpoch,
	].join(":");
}

function defaultWorkspaceDigest(request: WorkflowRecoveryRequest): string {
	return digestObject({
		workflowId: request.workflowId,
		taskId: request.taskId,
		attemptId: request.attemptId,
		executionKey: request.executionKey,
		epochRef: request.epochRef,
	});
}

function validRequest(request: WorkflowRecoveryRequest, workflowId: string): void {
	if (
		request.workflowId !== workflowId ||
		![request.workflowId, request.taskId, request.attemptId, request.executionKey].every(nonEmpty) ||
		!Number.isSafeInteger(request.epochRef.storeEpoch) ||
		request.epochRef.storeEpoch < 1 ||
		!Number.isSafeInteger(request.epochRef.coordinatorEpoch) ||
		request.epochRef.coordinatorEpoch < 1
	)
		throw new WorkflowRuntimeRecoveryError("workflow_recovery_request_invalid");
}

function findAdmissionIdentity(admission: WorkflowAdmissionResult | undefined): WorkflowChildIdentity | null {
	return admission?.processBinding?.childIdentity ?? admission?.childIdentity ?? null;
}

function findAdmissionBoundIdentity(admission: WorkflowAdmissionResult | undefined): WorkflowChildIdentity | null {
	return admission?.processBinding?.childIdentity ?? null;
}

function processGroupOf(admission: WorkflowAdmissionResult | undefined): WorkflowProcessGroupIdentity | null {
	return admission?.processBinding?.processGroup ?? null;
}

function terminalAdmission(admission: WorkflowAdmissionResult | undefined): boolean {
	return (
		admission !== undefined &&
		(admission.terminalEventSequence !== null ||
			admission.status === "completed" ||
			admission.status === "needs_fix" ||
			admission.status === "blocked" ||
			admission.status === "failed" ||
			admission.status === "cancelled" ||
			admission.status === "quarantined")
	);
}

function admissionMatchesRequest(
	admission: WorkflowAdmissionResult | undefined,
	request: WorkflowRecoveryRequest,
): boolean {
	if (admission === undefined) return true;
	return (
		admission.context.workflowId === request.workflowId &&
		admission.context.taskId === request.taskId &&
		admission.context.attemptId === request.attemptId &&
		admission.context.executionKey === request.executionKey &&
		sameEpoch(admission.context.epochRef, request.epochRef)
	);
}

function outcomeEvidence(outcome: WorkflowRuntimeEventPayload | undefined): readonly WorkflowArtifactRef[] {
	if (outcome?.kind !== "workflow_child_outcome_committed") return [];
	const phaseOutcome = outcome.outcome.outcome;
	if ("artifactRefs" in phaseOutcome && "evidenceRefs" in phaseOutcome)
		return uniqueEvidenceRefs([...phaseOutcome.artifactRefs, ...phaseOutcome.evidenceRefs]);
	return [];
}

function eventForAttempt(
	payloads: readonly WorkflowRuntimeEventPayload[],
	request: WorkflowRecoveryRequest,
): readonly WorkflowRuntimeEventPayload[] {
	return payloads.filter((payload) => {
		if (payload.workflowId !== request.workflowId) return false;
		if ("attemptId" in payload && payload.attemptId !== request.attemptId) return false;
		if ("executionKey" in payload && payload.executionKey !== request.executionKey) return false;
		return sameEpoch(payload.epochRef, request.epochRef);
	});
}

function processGroupForReconciliationEvidence(
	payloads: readonly WorkflowRuntimeEventPayload[],
): WorkflowProcessGroupIdentity | null {
	const groups = payloads.flatMap((payload) => {
		if (payload.kind === "workflow_process_group_owned") return [payload.processGroup];
		if (payload.kind === "workflow_child_identity_bound") return [payload.processBinding.processGroup];
		return [];
	});
	const unique = new Map(groups.map((group) => [group.identityDigest, group] as const));
	return unique.size === 1 ? (unique.values().next().value ?? null) : null;
}

function effectIntentsForAttempt(
	payloads: readonly WorkflowRuntimeEventPayload[],
): readonly Extract<WorkflowRuntimeEventPayload, { kind: "workflow_effect_intent" }>[] {
	return payloads.filter(
		(payload): payload is Extract<WorkflowRuntimeEventPayload, { kind: "workflow_effect_intent" }> =>
			payload.kind === "workflow_effect_intent",
	);
}

function terminalEventsForAttempt(
	payloads: readonly WorkflowRuntimeEventPayload[],
): readonly Extract<WorkflowRuntimeEventPayload, { kind: "workflow_child_outcome_committed" }>[] {
	return payloads.filter(
		(payload): payload is Extract<WorkflowRuntimeEventPayload, { kind: "workflow_child_outcome_committed" }> =>
			payload.kind === "workflow_child_outcome_committed",
	);
}

type WorkflowProcessGroupEvent = Extract<
	WorkflowRuntimeEventPayload,
	{ kind: "workflow_process_group_owned" | "workflow_process_group_fenced" }
>;

function processOwnedEventsForAttempt(
	payloads: readonly WorkflowRuntimeEventPayload[],
): readonly WorkflowProcessGroupEvent[] {
	return payloads.filter(
		(payload): payload is WorkflowProcessGroupEvent =>
			payload.kind === "workflow_process_group_owned" || payload.kind === "workflow_process_group_fenced",
	);
}

function childIdentityBoundEventsForAttempt(
	payloads: readonly WorkflowRuntimeEventPayload[],
): readonly Extract<WorkflowRuntimeEventPayload, { kind: "workflow_child_identity_bound" }>[] {
	return payloads.filter(
		(payload): payload is Extract<WorkflowRuntimeEventPayload, { kind: "workflow_child_identity_bound" }> =>
			payload.kind === "workflow_child_identity_bound",
	);
}

function processReapedEventsForAttempt(
	payloads: readonly WorkflowRuntimeEventPayload[],
): readonly Extract<WorkflowRuntimeEventPayload, { kind: "workflow_process_group_reaped" }>[] {
	return payloads.filter(
		(payload): payload is Extract<WorkflowRuntimeEventPayload, { kind: "workflow_process_group_reaped" }> =>
			payload.kind === "workflow_process_group_reaped",
	);
}

function effectResolutionEventsForAttempt(
	payloads: readonly WorkflowRuntimeEventPayload[],
): readonly Extract<
	WorkflowRuntimeEventPayload,
	{ kind: "workflow_effect_completed" | "workflow_effect_ambiguous" }
>[] {
	return payloads.filter(
		(
			payload,
		): payload is Extract<
			WorkflowRuntimeEventPayload,
			{ kind: "workflow_effect_completed" | "workflow_effect_ambiguous" }
		> => payload.kind === "workflow_effect_completed" || payload.kind === "workflow_effect_ambiguous",
	);
}

function hasConflictingEvents<T>(events: readonly T[], digest: (event: T) => string = digestObject): boolean {
	return new Set(events.map(digest)).size > 1;
}

function startedForAttempt(payloads: readonly WorkflowRuntimeEventPayload[]): boolean {
	return payloads.some(
		(payload) =>
			payload.kind === "workflow_child_identity_bound" ||
			payload.kind === "workflow_effect_intent" ||
			payload.kind === "workflow_effect_completed" ||
			payload.kind === "workflow_effect_ambiguous" ||
			payload.kind === "workflow_process_group_owned" ||
			payload.kind === "workflow_process_group_fenced" ||
			payload.kind === "workflow_process_group_reaped",
	);
}

function effectContextMatchesRequest(
	context: WorkflowEffectExecutionContext,
	request: WorkflowRecoveryRequest,
	effectIntent: Extract<WorkflowRuntimeEventPayload, { kind: "workflow_effect_intent" }>,
	admission: WorkflowAdmissionResult | undefined,
): boolean {
	const revisionBoundary = context.revisionBoundary;
	const ownershipToken = context.ownershipToken;
	const admissionContext = admission?.context;
	if (admissionContext === undefined) return false;
	const { tupleDigest: revisionTupleDigest, ...unsignedRevisionBoundary } = revisionBoundary;
	return (
		nonEmpty(context.workflowId) &&
		nonEmpty(context.taskId) &&
		nonEmpty(context.attemptId) &&
		nonEmpty(context.executionKey) &&
		sameEpoch(context.epochRef, request.epochRef) &&
		context.workflowId === request.workflowId &&
		context.taskId === request.taskId &&
		context.attemptId === request.attemptId &&
		context.executionKey === request.executionKey &&
		context.idempotencyKey === effectIntent.idempotencyKey &&
		digestObject(effectIntent.effect) === effectIntent.effectDigest &&
		context.decisionRef !== undefined &&
		context.approvalResponse !== undefined &&
		digestObject(context.decisionRef) === digestObject(effectIntent.decisionRef) &&
		digestObject(context.decisionRef) === digestObject(admissionContext.decisionRef) &&
		revisionBoundary !== undefined &&
		revisionBoundary.workflowId === request.workflowId &&
		revisionBoundary.executionKey === request.executionKey &&
		sameEpoch(revisionBoundary.epochRef, request.epochRef) &&
		revisionBoundary.leaseRef !== undefined &&
		sameEpoch(revisionBoundary.leaseRef, request.epochRef) &&
		digestObject(revisionBoundary.leaseRef) === digestObject(context.leaseRef) &&
		digestObject(revisionBoundary.revisionTuple) === digestObject(admissionContext.revisionTuple) &&
		digestObject(revisionBoundary.revisionRegistryRef) === digestObject(admissionContext.revisionRegistryRef) &&
		revisionBoundary.revisionRegistryDigest === admissionContext.revisionRegistryDigest &&
		revisionBoundary.configSnapshotDigest === admissionContext.configSnapshotDigest &&
		revisionTupleDigest === digestObject(unsignedRevisionBoundary) &&
		context.leaseRef !== undefined &&
		sameEpoch(context.leaseRef, request.epochRef) &&
		digestObject(context.leaseRef) === digestObject(admissionContext.resourceLeaseRef) &&
		context.resourceLeaseRef !== undefined &&
		sameEpoch(context.resourceLeaseRef, request.epochRef) &&
		digestObject(context.resourceLeaseRef) === digestObject(admissionContext.resourceLeaseRef) &&
		context.ownershipLeaseRef !== undefined &&
		sameEpoch(context.ownershipLeaseRef, request.epochRef) &&
		admissionContext.ownershipLeaseRef !== null &&
		digestObject(context.ownershipLeaseRef) === digestObject(admissionContext.ownershipLeaseRef) &&
		ownershipToken !== undefined &&
		nonEmpty(ownershipToken.tokenId) &&
		ownershipToken.workflowId === request.workflowId &&
		ownershipToken.taskId === request.taskId &&
		ownershipToken.attemptId === request.attemptId &&
		ownershipToken.executionKey === request.executionKey &&
		sameEpoch(ownershipToken.epochRef, request.epochRef) &&
		ownershipToken.resourceLeaseRef !== undefined &&
		ownershipToken.ownershipLeaseRef !== undefined &&
		digestObject(ownershipToken.resourceLeaseRef) === digestObject(context.resourceLeaseRef) &&
		digestObject(ownershipToken.ownershipLeaseRef) === digestObject(context.ownershipLeaseRef) &&
		ownershipToken.tokenDigest ===
			canonicalWorkflowEffectOwnershipTokenDigest({
				tokenId: ownershipToken.tokenId,
				workflowId: ownershipToken.workflowId,
				taskId: ownershipToken.taskId,
				attemptId: ownershipToken.attemptId,
				executionKey: ownershipToken.executionKey,
				epochRef: ownershipToken.epochRef,
				resourceLeaseRef: ownershipToken.resourceLeaseRef,
				ownershipLeaseRef: ownershipToken.ownershipLeaseRef,
			})
	);
}

function noStartProofDigest(
	request: WorkflowRecoveryRequest,
	evidence: WorkflowRuntimeRecoveryNoStartEvidence,
): string {
	return digestObject({
		workflowId: request.workflowId,
		taskId: request.taskId,
		attemptId: request.attemptId,
		executionKey: request.executionKey,
		epochRef: request.epochRef,
		preExecutionBaseline: evidence.preExecutionBaseline,
		postObservation: evidence.postObservation,
		effectIdentityDigest: evidence.effectIdentityDigest,
		trustedNow: evidence.trustedNow,
		hostReceipt: evidence.hostReceipt,
	});
}

function recoveryEffectIdentityDigest(input: {
	admissionId: string;
	expectedEffectDigest: string;
	decisionRef: unknown;
	resourceLeaseRef: WorkflowLeaseRef;
	ownershipLeaseRef: WorkflowLeaseRef | null;
	launchConfigDigest: string;
}): string {
	return digestObject(input);
}

function replayHeadDigestAtSequence(replay: WorkflowStoreReplayResult, sequence: number): string | null {
	if (sequence === 0)
		return digestObject({
			workflowId: replay.workflowId,
			sequence: 0,
			eventDigest: null,
			epochRef: replay.head.epochRef,
		});
	const commit = replay.events.find((event) => event.sequence === sequence);
	if (commit === undefined) return null;
	return digestObject({
		workflowId: commit.workflowId,
		sequence: commit.sequence,
		eventDigest: commit.eventDigest,
		epochRef: commit.epochRef,
	});
}

export function digestWorkflowRuntimeNoStartProof(
	request: WorkflowRecoveryRequest,
	evidence: WorkflowRuntimeRecoveryNoStartEvidence,
): string {
	return noStartProofDigest(request, evidence);
}

function validNoStartEvidence(
	request: WorkflowRecoveryRequest,
	replay: WorkflowStoreReplayResult,
	evidence: WorkflowRuntimeRecoveryNoStartEvidence | null,
	workspaceDigest: string | undefined,
	expectedEffectIdentityDigest: string,
): evidence is WorkflowRuntimeRecoveryNoStartEvidence {
	if (evidence === null || evidence.proofDigest !== noStartProofDigest(request, evidence)) return false;
	const pre = evidence.preExecutionBaseline;
	const post = evidence.postObservation;
	const receipt = evidence.hostReceipt;
	const preTime = Date.parse(pre.observedAt);
	const postTime = Date.parse(post.observedAt);
	const trustedTime = Date.parse(evidence.trustedNow);
	const witnessBindingDigest = digestObject({
		workflowId: request.workflowId,
		taskId: request.taskId,
		attemptId: request.attemptId,
		executionKey: request.executionKey,
		epochRef: request.epochRef,
		preExecutionBaseline: pre,
		postObservation: post,
	});
	const witnessPayloadDigest = digestObject({
		preExecutionBaseline: pre,
		postObservation: post,
		trustedNow: evidence.trustedNow,
	});
	return (
		nonEmpty(evidence.trustedNow) &&
		nonEmpty(evidence.effectIdentityDigest) &&
		evidence.effectIdentityDigest === expectedEffectIdentityDigest &&
		Number.isFinite(trustedTime) &&
		nonEmpty(pre.workspaceDigest) &&
		nonEmpty(post.workspaceDigest) &&
		(workspaceDigest === undefined || post.workspaceDigest === workspaceDigest) &&
		nonEmpty(pre.journalHeadDigest) &&
		pre.journalHeadDigest === replayHeadDigestAtSequence(replay, pre.artifactRef.sourceEventSequence) &&
		post.journalHeadDigest === digestObject(replay.head) &&
		nonEmpty(pre.artifactRef.artifactId) &&
		nonEmpty(pre.artifactRef.relativePath) &&
		nonEmpty(pre.artifactRef.digest) &&
		nonEmpty(post.artifactRef.artifactId) &&
		nonEmpty(post.artifactRef.relativePath) &&
		nonEmpty(post.artifactRef.digest) &&
		Number.isSafeInteger(pre.artifactRef.sizeBytes) &&
		pre.artifactRef.sizeBytes >= 0 &&
		Number.isSafeInteger(post.artifactRef.sizeBytes) &&
		post.artifactRef.sizeBytes >= 0 &&
		pre.artifactRef.sourceEventSequence < post.artifactRef.sourceEventSequence &&
		post.artifactRef.sourceEventSequence === replay.head.sequence &&
		Number.isFinite(preTime) &&
		Number.isFinite(postTime) &&
		postTime >= preTime &&
		receipt.workflowId === request.workflowId &&
		receipt.receiptKind === "artifact" &&
		nonEmpty(receipt.receiptId) &&
		nonEmpty(receipt.issuerId) &&
		nonEmpty(receipt.bindingDigest) &&
		receipt.bindingDigest === witnessBindingDigest &&
		nonEmpty(receipt.payloadDigest) &&
		receipt.payloadDigest === witnessPayloadDigest &&
		digestObject(receipt.artifactRef) === digestObject(post.artifactRef) &&
		receipt.artifactBytesDigest === post.artifactRef.digest &&
		receipt.stateDigest === post.journalHeadDigest &&
		nonEmpty(receipt.issuedAt) &&
		nonEmpty(receipt.validUntil) &&
		Date.parse(receipt.issuedAt) <= trustedTime &&
		Date.parse(receipt.validUntil) > trustedTime &&
		nonEmpty(receipt.keyId) &&
		receipt.signatureAlgorithm === "ed25519" &&
		Number.isSafeInteger(receipt.revision) &&
		receipt.revision > 0 &&
		nonEmpty(receipt.signature) &&
		receipt.verificationDigest === digestObject({ ...receipt, verificationDigest: "" })
	);
}

function terminalDisposition(
	status: WorkflowAttemptStatus | "complete",
	phaseStatus?: "complete" | "pause" | "blocked" | "failed",
): WorkflowReconciliationOutcome["disposition"] {
	if (status === "failed" || phaseStatus === "failed") return "failed";
	if ((status === "completed" || status === "complete") && (phaseStatus === undefined || phaseStatus === "complete"))
		return "completed";
	return "corrective_work_required";
}

export function createWorkflowRuntimeRecoveryCoordinator(
	dependencies: WorkflowRuntimeRecoveryDependencies,
): WorkflowRuntimeRecoveryCoordinator {
	const reconciliationLocks = new Map<string, Promise<WorkflowReconciliationOutcome>>();

	const readiness = (): WorkflowRuntimeRecoveryReadiness => {
		const blockingReasons: string[] = [];
		if (dependencies.enabled === false) blockingReasons.push("workflow_runtime_disabled");
		if (!nonEmpty(dependencies.runtimeVersion ?? "")) blockingReasons.push("workflow_runtime_version_unavailable");
		else {
			try {
				assertWorkflowRuntimeVersion(dependencies.runtimeVersion);
			} catch (error) {
				blockingReasons.push(error instanceof Error ? error.message : "workflow_runtime_version_unsupported");
			}
		}
		if (!nonEmpty(dependencies.writerIdentity ?? "")) blockingReasons.push("workflow_writer_identity_unavailable");
		if (dependencies.activeLeaseRef === undefined && dependencies.readActiveLeaseRef === undefined)
			blockingReasons.push("workflow_append_lease_unavailable");
		if (dependencies.processContainmentVerifier === undefined) {
			blockingReasons.push("workflow_process_containment_unavailable");
			if (dependencies.capabilities?.processIdentity !== true)
				blockingReasons.push("process_start_identity_unavailable");
		}
		if (dependencies.capabilities?.effectResolution !== true) blockingReasons.push("effect_hook_unbrokered");
		if (!nonEmpty(dependencies.capabilities?.capabilityDigest ?? ""))
			blockingReasons.push("workflow_capability_digest_unavailable");
		if (dependencies.recoveryClaims === undefined) blockingReasons.push("workflow_recovery_claim_unavailable");
		if (dependencies.readTrustedNow === undefined) blockingReasons.push("workflow_trusted_clock_unavailable");
		if (dependencies.readCurrentHostCapabilityRevision === undefined)
			blockingReasons.push("workflow_capability_revision_unavailable");
		return { canRecover: blockingReasons.length === 0, blockingReasons };
	};

	const hydrate = async (): Promise<void> => {
		await dependencies.admission.hydrateFromReplay();
		await dependencies.admission.hydrateQuarantineFromReplay();
		await dependencies.leases.hydrateFromReplay();
		await dependencies.groups.hydrateFromReplay();
	};

	const activeLeaseRef = async (): Promise<WorkflowLeaseRef | null> => {
		if (dependencies.readActiveLeaseRef !== undefined) return dependencies.readActiveLeaseRef();
		return dependencies.activeLeaseRef ?? null;
	};

	const verifyCurrentProcessContainment = async (identity: WorkflowProcessGroupIdentity): Promise<boolean> => {
		const verifier = dependencies.processContainmentVerifier;
		if (verifier === undefined || !validProcessGroupIdentity(identity)) return false;
		try {
			const observation = await verifier.verify(identity);
			const containment = observation.containment;
			return (
				observation.verified &&
				validProcessGroupIdentity(observation.identity) &&
				observation.identity.pid === identity.pid &&
				observation.identity.processStartId === identity.processStartId &&
				observation.identity.processGroupId === identity.processGroupId &&
				observation.identity.parentPid === identity.parentPid &&
				observation.identity.identityDigest === identity.identityDigest &&
				containment?.membershipVerified === true &&
				containment.descendantsContained === true &&
				containment.killOnClose === true &&
				nonEmpty(containment.attestationDigest)
			);
		} catch {
			return false;
		}
	};

	const priorOutcomeMatchesCurrentIdentity = async (
		prior: WorkflowReconciliationOutcome,
		admission: WorkflowAdmissionResult | undefined,
		request: WorkflowRecoveryRequest,
		priorProcessGroup: WorkflowProcessGroupIdentity | null,
	): Promise<boolean> => {
		const currentIdentity = findAdmissionBoundIdentity(admission);
		const currentGroup = processGroupOf(admission);
		const baseMatches =
			prior.workflowId === request.workflowId &&
			prior.taskId === request.taskId &&
			prior.attemptId === request.attemptId &&
			sameEpoch(prior.epochRef, request.epochRef) &&
			admissionMatchesRequest(admission, request) &&
			!terminalAdmission(admission) &&
			(request.persistedChildIdentity === null ||
				(currentIdentity !== null && sameIdentity(request.persistedChildIdentity, currentIdentity))) &&
			(currentGroup === null || (await verifyCurrentProcessContainment(currentGroup)));
		if (!baseMatches) return false;
		if (prior.disposition !== "reattached") return true;
		return (
			currentIdentity !== null &&
			prior.observedChildIdentity !== null &&
			sameIdentity(prior.observedChildIdentity, currentIdentity) &&
			currentGroup !== null &&
			priorProcessGroup !== null &&
			workflowProcessGroupIdentityMatches(priorProcessGroup, currentGroup) &&
			prior.observedProcessGroupId === currentGroup.processGroupId
		);
	};

	const workspaceEvidence = async (
		request: WorkflowRecoveryRequest,
	): Promise<{ digest: string; available: boolean }> => {
		if (dependencies.readWorkspaceDigest === undefined)
			return { digest: defaultWorkspaceDigest(request), available: false };
		try {
			const digest = await dependencies.readWorkspaceDigest(request);
			return nonEmpty(digest) && digest !== defaultWorkspaceDigest(request)
				? { digest, available: true }
				: { digest: defaultWorkspaceDigest(request), available: false };
		} catch {
			return { digest: defaultWorkspaceDigest(request), available: false };
		}
	};

	const safeTranscriptDigest = async (request: WorkflowRecoveryRequest): Promise<string | null> => {
		if (dependencies.readTranscriptDigest === undefined) return null;
		try {
			return await dependencies.readTranscriptDigest(request);
		} catch {
			return null;
		}
	};

	const quarantineLeases = async (
		admission: WorkflowAdmissionResult | undefined,
		request: WorkflowRecoveryRequest,
		reason: string,
		extraRefs: readonly WorkflowLeaseRef[] = [],
	): Promise<void> => {
		const refs = [
			...(admission === undefined ? [] : [admission.context.resourceLeaseRef, admission.context.ownershipLeaseRef]),
			...extraRefs,
		].filter((ref): ref is WorkflowLeaseRef => ref !== null);
		const seen = new Set<string>();
		let firstError: Error | null = null;
		for (const leaseRef of refs) {
			if (seen.has(leaseRef.leaseId)) continue;
			seen.add(leaseRef.leaseId);
			try {
				await dependencies.leases.quarantine({
					workflowId: request.workflowId,
					attemptId: request.attemptId,
					leaseRef,
					epochRef: request.epochRef,
					store: dependencies.store,
					executionKey: request.executionKey,
					reason,
				});
			} catch (error) {
				if (firstError === null)
					firstError =
						error instanceof Error ? error : new WorkflowRuntimeRecoveryError("workflow_lease_quarantine_failed");
			}
		}
		if (firstError !== null) throw firstError;
	};

	const quarantineAttempt = async (
		admission: WorkflowAdmissionResult | undefined,
		binding: WorkflowProcessGroupIdentity | null,
		request: WorkflowRecoveryRequest,
		reason: string,
		extraGroups: readonly WorkflowProcessGroupIdentity[] = [],
		extraLeaseRefs: readonly WorkflowLeaseRef[] = [],
	): Promise<void> => {
		const groups = [binding, ...extraGroups].filter((group): group is WorkflowProcessGroupIdentity => group !== null);
		const seenGroups = new Set<string>();
		let firstError: Error | null = null;
		for (const processGroup of groups) {
			if (seenGroups.has(processGroup.identityDigest)) continue;
			seenGroups.add(processGroup.identityDigest);
			try {
				await dependencies.groups.quarantine(processGroup, reason);
			} catch (error) {
				if (firstError === null)
					firstError =
						error instanceof Error ? error : new WorkflowRuntimeRecoveryError("workflow_group_quarantine_failed");
			}
		}
		// Terminal admissions reject the admission quarantine API. Fence groups and leases first;
		// durable reconciliation records the terminal uncertainty without skipping cleanup.
		try {
			await quarantineLeases(admission, request, reason, extraLeaseRefs);
		} catch (error) {
			if (firstError === null)
				firstError =
					error instanceof Error ? error : new WorkflowRuntimeRecoveryError("workflow_lease_quarantine_failed");
		}
		if (admission !== undefined && !terminalAdmission(admission)) {
			try {
				await dependencies.admission.quarantine(admission.admissionId, reason);
			} catch (error) {
				if (firstError === null)
					firstError =
						error instanceof Error
							? error
							: new WorkflowRuntimeRecoveryError("workflow_admission_quarantine_failed");
			}
		}
		if (firstError !== null) throw firstError;
	};

	const releaseLeases = async (
		admission: WorkflowAdmissionResult,
		request: WorkflowRecoveryRequest,
		outcomeDigest: string,
	): Promise<boolean> => {
		const refs = [admission.context.resourceLeaseRef, admission.context.ownershipLeaseRef].filter(
			(ref): ref is WorkflowLeaseRef => ref !== null,
		);
		const seen = new Set<string>();
		for (const leaseRef of refs) {
			if (seen.has(leaseRef.leaseId)) continue;
			seen.add(leaseRef.leaseId);
			try {
				const state = await dependencies.leases.lookupByLease(request.workflowId, leaseRef);
				if (
					state === undefined ||
					state.executionKey !== request.executionKey ||
					state.terminalEventSequence === null
				) {
					await quarantineLeases(admission, request, "workflow_lease_release_state_uncertain", [leaseRef]);
					return false;
				}
				if (state.leaseStatus === "released") continue;
				if (state.leaseStatus !== "active") {
					await quarantineLeases(admission, request, "workflow_lease_release_state_uncertain", [leaseRef]);
					return false;
				}
				await dependencies.leases.release({
					workflowId: request.workflowId,
					attemptId: request.attemptId,
					leaseRef,
					epochRef: request.epochRef,
					outcomeDigest,
					store: dependencies.store,
				});
			} catch {
				await quarantineLeases(admission, request, "workflow_lease_release_uncertain");
				return false;
			}
		}
		return true;
	};

	const uniqueProcessGroups = (
		persistedGroup: WorkflowProcessGroupIdentity | null,
		ownedEvents: readonly WorkflowProcessGroupEvent[],
		boundEvents: readonly Extract<WorkflowRuntimeEventPayload, { kind: "workflow_child_identity_bound" }>[] = [],
	): readonly WorkflowProcessGroupIdentity[] => {
		const groups = [
			persistedGroup,
			...ownedEvents.map((event) => event.processGroup),
			...boundEvents.map((event) => event.processBinding.processGroup),
		].filter((group): group is WorkflowProcessGroupIdentity => group !== null);
		const seen = new Set<string>();
		return groups.filter((group) => {
			if (seen.has(group.identityDigest)) return false;
			seen.add(group.identityDigest);
			return true;
		});
	};

	const reconcileTerminalProcessGroups = async (
		groups: readonly WorkflowProcessGroupIdentity[],
	): Promise<{ safe: boolean; error: Error | null }> => {
		let safe = true;
		let firstError: Error | null = null;
		const rememberError = (error: unknown, fallback: string): void => {
			if (firstError === null)
				firstError = error instanceof Error ? error : new WorkflowRuntimeRecoveryError(fallback);
		};
		for (const processGroup of groups) {
			const live = await verifyCurrentProcessContainment(processGroup);
			if (!live) {
				// A boolean verification miss cannot distinguish a dead group from a foreign or reused PID.
				// Inspecting may classify the observation, but it is not an authenticated admission binding and
				// must never be passed to a side-effecting quarantine or signal operation.
				try {
					await dependencies.groups.inspect(processGroup);
				} catch (error) {
					rememberError(error, "workflow_process_inspection_failed");
				}
				try {
					await dependencies.groups.quarantine(processGroup, "workflow_terminal_process_verification_uncertain");
				} catch (error) {
					rememberError(error, "workflow_group_quarantine_failed");
				}
				safe = false;
				continue;
			}
			try {
				await dependencies.groups.terminate(processGroup, "workflow_terminal_recovery");
				const reap = await dependencies.groups.reap(processGroup);
				if (reap.remainingPids.length > 0) {
					try {
						await dependencies.groups.quarantine(processGroup, "workflow_terminal_process_reap_incomplete");
					} catch (error) {
						rememberError(error, "workflow_group_quarantine_failed");
					}
					safe = false;
				}
			} catch (error) {
				try {
					await dependencies.groups.quarantine(processGroup, "workflow_terminal_process_recovery_uncertain");
				} catch (quarantineError) {
					rememberError(quarantineError, "workflow_group_quarantine_failed");
				}
				rememberError(error, "workflow_process_recovery_failed");
				safe = false;
			}
		}
		return { safe, error: firstError };
	};

	const quarantineUnknownDescendants = async (workflowId: string, reason: string): Promise<boolean> => {
		const unknown = await dependencies.groups.scanUnknownDescendants(workflowId);
		if (unknown.length === 0) return true;
		if (dependencies.resolveUnknownDescendantIdentity === undefined)
			throw new WorkflowRuntimeRecoveryError("workflow_unknown_descendant_quarantine_unavailable");
		let firstError: Error | null = null;
		for (const descendant of unknown) {
			try {
				const identity = await dependencies.resolveUnknownDescendantIdentity(descendant, workflowId);
				if (identity === null || !validProcessGroupIdentity(identity)) {
					firstError ??= new WorkflowRuntimeRecoveryError("workflow_unknown_descendant_identity_unavailable");
					continue;
				}
				await dependencies.groups.quarantine(identity, reason);
			} catch (error) {
				firstError ??=
					error instanceof Error ? error : new WorkflowRuntimeRecoveryError("workflow_group_quarantine_failed");
			}
		}
		if (firstError !== null) throw firstError;
		return false;
	};

	const reconcileEffectIntents = async (input: {
		request: WorkflowRecoveryRequest;
		admission: WorkflowAdmissionResult | undefined;
		effectIntents: readonly Extract<WorkflowRuntimeEventPayload, { kind: "workflow_effect_intent" }>[];
		effectResolutions: readonly Extract<
			WorkflowRuntimeEventPayload,
			{ kind: "workflow_effect_completed" | "workflow_effect_ambiguous" }
		>[];
	}): Promise<boolean> => {
		let safe = true;
		const seenEffectIntents = new Set<string>();
		for (const effectIntent of input.effectIntents) {
			if (seenEffectIntents.has(effectIntent.idempotencyKey)) continue;
			seenEffectIntents.add(effectIntent.idempotencyKey);
			if (digestObject(effectIntent.effect) !== effectIntent.effectDigest) {
				safe = false;
				continue;
			}
			const resolution = input.effectResolutions.find(
				(candidate) => candidate.idempotencyKey === effectIntent.idempotencyKey,
			);
			if (resolution !== undefined) {
				if (
					resolution.effectDigest !== effectIntent.effectDigest ||
					resolution.epochRef.storeEpoch !== effectIntent.epochRef.storeEpoch ||
					resolution.epochRef.coordinatorEpoch !== effectIntent.epochRef.coordinatorEpoch
				) {
					safe = false;
				}
			}
			let effectContext: WorkflowEffectExecutionContext | null = null;
			try {
				effectContext =
					dependencies.readEffectReconciliationContext === undefined
						? null
						: await dependencies.readEffectReconciliationContext(input.request, effectIntent, input.admission);
				if (
					effectContext === null ||
					!effectContextMatchesRequest(effectContext, input.request, effectIntent, input.admission)
				)
					throw new WorkflowRuntimeRecoveryError("workflow_effect_reconciliation_context_missing");
				const effectResult = await dependencies.effects.reconcile(
					effectIntent.effect,
					effectIntent.idempotencyKey,
					input.request.epochRef,
					effectContext,
				);
				const brokerCompleted = effectResult.status === "already_completed" || effectResult.status === "completed";
				if (!brokerCompleted) safe = false;
				if (resolution !== undefined) {
					if (resolution.kind === "workflow_effect_ambiguous" || !brokerCompleted) safe = false;
					if (
						resolution.kind === "workflow_effect_completed" &&
						(effectResult.resultDigest === null || resolution.resultDigest !== effectResult.resultDigest)
					)
						safe = false;
				}
			} catch {
				safe = false;
			}
		}
		const intentKeys = new Set(input.effectIntents.map((effectIntent) => effectIntent.idempotencyKey));
		if (input.effectResolutions.some((resolution) => !intentKeys.has(resolution.idempotencyKey))) safe = false;
		return safe;
	};

	const recordEvent = async (
		payload: WorkflowRuntimeEventPayload,
		request: WorkflowRecoveryRequest,
		replay: WorkflowStoreReplayResult,
		leaseRef: WorkflowLeaseRef | null,
		idempotencyKey: string,
	): Promise<void> => {
		if (leaseRef === null) throw new WorkflowRuntimeRecoveryError("workflow_append_lease_unavailable");
		const writerIdentity = dependencies.writerIdentity;
		if (typeof writerIdentity !== "string" || !nonEmpty(writerIdentity))
			throw new WorkflowRuntimeRecoveryError("workflow_writer_identity_unavailable");
		if (!sameEpoch(leaseRef, request.epochRef))
			throw new WorkflowRuntimeRecoveryError("workflow_append_lease_epoch_mismatch");
		if (leaseRef.writerIdentity !== writerIdentity)
			throw new WorkflowRuntimeRecoveryError("workflow_append_lease_writer_mismatch");
		try {
			await commitAuthenticated(dependencies.store, {
				workflowId: request.workflowId,
				payload,
				expectedHead: replay.head,
				epochRef: request.epochRef,
				leaseRef,
				idempotencyKey,
				writerIdentity,
				executionKey: request.executionKey,
			});
		} catch (error) {
			if (error instanceof Error) throw error;
			throw new WorkflowRuntimeRecoveryError("workflow_reconciliation_commit_failed");
		}
	};

	const outcome = async (input: {
		request: WorkflowRecoveryRequest;
		disposition: WorkflowReconciliationOutcome["disposition"];
		admission: WorkflowAdmissionResult | undefined;
		observedChildIdentity: WorkflowChildIdentity | null;
		observedProcessGroupId: string | null;
		observedTranscriptDigest: string | null;
		evidenceRefs: readonly WorkflowArtifactRef[];
		workspaceDigest: string;
	}): Promise<WorkflowReconciliationOutcome> => {
		const evidenceRefs = uniqueEvidenceRefs([...input.request.evidenceRefs, ...input.evidenceRefs]);
		const stateDigest = digestObject({
			workflowId: input.request.workflowId,
			taskId: input.request.taskId,
			attemptId: input.request.attemptId,
			executionKey: input.request.executionKey,
			epochRef: input.request.epochRef,
			disposition: input.disposition,
			persistedChildIdentity: input.request.persistedChildIdentity,
			observedChildIdentity: input.observedChildIdentity,
			observedProcessGroupId: input.observedProcessGroupId,
			observedTranscriptDigest: input.observedTranscriptDigest,
			observedWorkspaceDigest: input.workspaceDigest,
			evidenceRefs,
		});
		return {
			workflowId: input.request.workflowId,
			reconciliationAttemptId: recoveryAttemptId(input.request),
			taskId: input.request.taskId,
			attemptId: input.request.attemptId,
			disposition: input.disposition,
			persistedChildIdentity: input.request.persistedChildIdentity,
			observedChildIdentity: input.observedChildIdentity,
			observedProcessGroupId: input.observedProcessGroupId,
			observedTranscriptDigest: input.observedTranscriptDigest,
			observedWorkspaceDigest: input.workspaceDigest,
			epochRef: input.request.epochRef,
			evidenceRefs,
			stateDigest,
		};
	};

	const disabledOutcome = async (request: WorkflowRecoveryRequest): Promise<WorkflowReconciliationOutcome> =>
		outcome({
			request,
			disposition: "user_input_required",
			admission: undefined,
			observedChildIdentity: null,
			observedProcessGroupId: null,
			observedTranscriptDigest: null,
			evidenceRefs: request.evidenceRefs,
			workspaceDigest: defaultWorkspaceDigest(request),
		});

	const recoveryBinding = async (
		request: WorkflowRecoveryRequest,
		admission: WorkflowAdmissionResult | undefined,
		workspaceEvidenceInput?: { digest: string; available: boolean },
	): Promise<WorkflowDispatchRecoveryBinding | null> => {
		const identity = findAdmissionIdentity(admission) ?? request.persistedChildIdentity;
		const leaseRef = admission?.context.resourceLeaseRef;
		const writerIdentity = dependencies.writerIdentity;
		const runtimeVersion = dependencies.runtimeVersion;
		const capabilityDigest = dependencies.capabilities?.capabilityDigest;
		const hostCapabilityRevision = identity?.hostCapabilityRevision ?? dependencies.hostCapabilityRevision;
		if (
			admission === undefined ||
			terminalAdmission(admission) ||
			!admissionMatchesRequest(admission, request) ||
			leaseRef === undefined ||
			typeof writerIdentity !== "string" ||
			!nonEmpty(writerIdentity) ||
			typeof runtimeVersion !== "string" ||
			!nonEmpty(runtimeVersion) ||
			typeof capabilityDigest !== "string" ||
			!nonEmpty(capabilityDigest) ||
			typeof hostCapabilityRevision !== "string" ||
			!nonEmpty(hostCapabilityRevision) ||
			admission?.context.writerIdentity !== writerIdentity ||
			leaseRef.writerIdentity !== writerIdentity ||
			(identity !== null && (!nonEmpty(identity.runtimeVersion) || identity.runtimeVersion !== runtimeVersion))
		)
			return null;
		const leaseRefs = [admission.context.resourceLeaseRef, admission.context.ownershipLeaseRef].filter(
			(ref): ref is WorkflowLeaseRef => ref !== null,
		);
		let trustedNow: string | null = null;
		if (dependencies.readTrustedNow !== undefined) {
			try {
				trustedNow = await dependencies.readTrustedNow();
			} catch {
				return null;
			}
		}
		if (trustedNow === null || trustedNow === undefined) return null;
		const trustedTime = Date.parse(trustedNow);
		if (!Number.isFinite(trustedTime)) return null;
		const seenLeaseIds = new Set<string>();
		for (const candidateLeaseRef of leaseRefs) {
			if (seenLeaseIds.has(candidateLeaseRef.leaseId)) continue;
			seenLeaseIds.add(candidateLeaseRef.leaseId);
			const leaseState = await dependencies.leases
				.lookupByLease(request.workflowId, candidateLeaseRef)
				.catch(() => null);
			if (
				leaseState === undefined ||
				leaseState === null ||
				leaseState.leaseStatus !== "active" ||
				leaseState.executionKey !== request.executionKey ||
				leaseState.terminalEventSequence !== null ||
				Date.parse(candidateLeaseRef.acquiredAt) > trustedTime ||
				Date.parse(candidateLeaseRef.expiresAt) <= trustedTime
			)
				return null;
		}
		let currentCapabilityRevision: string | null = null;
		if (dependencies.readCurrentHostCapabilityRevision !== undefined) {
			try {
				currentCapabilityRevision = await dependencies.readCurrentHostCapabilityRevision();
			} catch {
				return null;
			}
		}
		if (currentCapabilityRevision === null || currentCapabilityRevision === undefined) return null;
		if (currentCapabilityRevision !== hostCapabilityRevision) return null;
		const processGroup = processGroupOf(admission);
		if (processGroup !== null) {
			const processLive = await verifyCurrentProcessContainment(processGroup);
			if (!processLive) return null;
		}
		const workspace = workspaceEvidenceInput ?? (await workspaceEvidence(request));
		if (!workspace.available) return null;
		const context = admission.context;
		return {
			workflowId: request.workflowId,
			taskId: request.taskId,
			attemptId: request.attemptId,
			executionKey: request.executionKey,
			epochRef: request.epochRef,
			leaseRef,
			leaseDigest: digestObject(leaseRef),
			writerIdentity,
			runtimeVersion,
			hostCapabilityRevision,
			capabilityDigest,
			revisionTuple: context.revisionTuple,
			revisionRegistryRef: context.revisionRegistryRef,
			revisionRegistryDigest: context.revisionRegistryDigest,
			workspaceDigest: workspace.digest,
		};
	};

	const readNoStartEvidence = async (
		request: WorkflowRecoveryRequest,
		replay: WorkflowStoreReplayResult,
		workspaceDigest: string | undefined,
		expectedEffectIdentityDigest: string,
	): Promise<WorkflowRuntimeRecoveryNoStartEvidence | null> => {
		if (dependencies.readNoStartEvidence === undefined) return null;
		if (dependencies.verifyNoStartEvidence === undefined) return null;
		try {
			const evidence = await dependencies.readNoStartEvidence(request, replay);
			if (!validNoStartEvidence(request, replay, evidence, workspaceDigest, expectedEffectIdentityDigest))
				return null;
			return (await dependencies.verifyNoStartEvidence(request, replay, evidence)) ? evidence : null;
		} catch {
			return null;
		}
	};

	const quarantineKnownAdmissionState = async (
		request: WorkflowRecoveryRequest,
	): Promise<{
		admission: WorkflowAdmissionResult | undefined;
		processGroups: readonly WorkflowProcessGroupIdentity[];
		leaseRef: WorkflowLeaseRef | null;
		stateError: Error | null;
	}> => {
		let knownAdmission: WorkflowAdmissionResult | undefined;
		let knownGroups: readonly WorkflowProcessGroupIdentity[] = [];
		let stateError: Error | null = null;
		if (dependencies.readKnownRecoveryBindings !== undefined) {
			try {
				const known = await dependencies.readKnownRecoveryBindings(request);
				knownAdmission = known.admission;
				knownGroups = known.processGroups.filter(validProcessGroupIdentity);
				if (knownGroups.length !== known.processGroups.length)
					stateError = new WorkflowRuntimeRecoveryError("workflow_process_identity_unavailable");
			} catch (error) {
				knownAdmission = undefined;
				knownGroups = [];
				stateError =
					error instanceof Error
						? error
						: new WorkflowRuntimeRecoveryError("workflow_admission_state_unavailable");
			}
		}
		let knownLease: WorkflowLeaseRef | null = null;
		try {
			knownLease = await activeLeaseRef();
		} catch (error) {
			if (stateError === null)
				stateError =
					error instanceof Error ? error : new WorkflowRuntimeRecoveryError("workflow_active_lease_unavailable");
		}
		const knownAdmissionGroup = processGroupOf(knownAdmission);
		const safeAdmissionGroup =
			knownAdmissionGroup === null || validProcessGroupIdentity(knownAdmissionGroup) ? knownAdmissionGroup : null;
		if (knownAdmissionGroup !== safeAdmissionGroup && stateError === null)
			stateError = new WorkflowRuntimeRecoveryError("workflow_process_identity_unavailable");
		await quarantineAttempt(
			knownAdmission,
			null,
			request,
			"workflow_admission_lookup_uncertain",
			[...knownGroups, ...(safeAdmissionGroup === null ? [] : [safeAdmissionGroup])],
			knownLease === null || !sameEpoch(knownLease, request.epochRef) ? [] : [knownLease],
		);
		return { admission: knownAdmission, processGroups: knownGroups, leaseRef: knownLease, stateError };
	};

	const startRecovery = async (request?: WorkflowRecoveryRequest): Promise<WorkflowRuntimeRecoveryStartResult> => {
		if (!readiness().canRecover)
			return { status: "blocked", binding: null, nonExecutionProof: null, journalHeadDigest: null };
		if (request !== undefined) validRequest(request, dependencies.workflowId);
		await hydrate();
		const active = await activeLeaseRef();
		const writerIdentity = dependencies.writerIdentity;
		let trustedNow: string | null = null;
		if (dependencies.readTrustedNow !== undefined) {
			try {
				trustedNow = await dependencies.readTrustedNow();
			} catch {
				return { status: "blocked", binding: null, nonExecutionProof: null, journalHeadDigest: null };
			}
		}
		if (
			active === null ||
			typeof writerIdentity !== "string" ||
			!nonEmpty(writerIdentity) ||
			active.writerIdentity !== writerIdentity ||
			(request !== undefined && !sameEpoch(active, request.epochRef)) ||
			trustedNow === null ||
			!Number.isFinite(Date.parse(trustedNow)) ||
			Date.parse(active.acquiredAt) > Date.parse(trustedNow) ||
			Date.parse(active.expiresAt) <= Date.parse(trustedNow)
		)
			return { status: "blocked", binding: null, nonExecutionProof: null, journalHeadDigest: null };
		let replay = await dependencies.store.replay({
			workflowId: dependencies.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: active?.storeEpoch ?? 1,
		});
		try {
			validateAuthenticatedReplay(replay);
		} catch (error) {
			if (request === undefined) throw error;
			const known = await quarantineKnownAdmissionState(request);
			const quarantined = await outcome({
				request,
				disposition: "user_input_required",
				admission: known.admission,
				observedChildIdentity: findAdmissionIdentity(known.admission),
				observedProcessGroupId:
					known.processGroups[0]?.processGroupId ?? processGroupOf(known.admission)?.processGroupId ?? null,
				observedTranscriptDigest: null,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest: (await workspaceEvidence(request)).digest,
			});
			await recordReconciliation(quarantined, replay, known.admission, request, known.leaseRef);
			if (known.stateError !== null) throw known.stateError;
			return {
				status: "blocked",
				binding: null,
				nonExecutionProof: null,
				journalHeadDigest: digestObject(replay.head),
			};
		}
		if (
			!replay.events.some(
				(event) =>
					event.payload.kind === "workflow_recovery_started" &&
					sameEpoch(event.payload.epochRef, replay.head.epochRef),
			)
		) {
			const leaseRef = await activeLeaseRef();
			if (leaseRef === null)
				return {
					status: "blocked",
					binding: null,
					nonExecutionProof: null,
					journalHeadDigest: digestObject(replay.head),
				};
			await recordEvent(
				{
					kind: "workflow_recovery_started",
					workflowId: dependencies.workflowId,
					epochRef: replay.head.epochRef,
					journalHeadDigest: digestObject(replay.head),
				},
				{
					workflowId: dependencies.workflowId,
					taskId: "recovery",
					attemptId: "recovery",
					executionKey: "recovery",
					epochRef: replay.head.epochRef,
					persistedChildIdentity: null,
					evidenceRefs: [],
				},
				replay,
				leaseRef,
				`workflow-recovery-started:${dependencies.workflowId}:${replay.head.epochRef.storeEpoch}:${replay.head.epochRef.coordinatorEpoch}`,
			);
			replay = await dependencies.store.replay({
				workflowId: dependencies.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: replay.head.epochRef.storeEpoch,
			});
			validateAuthenticatedReplay(replay);
		}
		if (request === undefined)
			return {
				status: "started",
				binding: null,
				nonExecutionProof: null,
				journalHeadDigest: digestObject(replay.head),
			};
		let admission: WorkflowAdmissionResult | undefined;
		try {
			admission = await dependencies.admission.lookupByExecutionKey(request.workflowId, request.executionKey);
		} catch {
			const known = await quarantineKnownAdmissionState(request);
			const quarantined = await outcome({
				request,
				disposition: "user_input_required",
				admission: known.admission,
				observedChildIdentity: findAdmissionIdentity(known.admission),
				observedProcessGroupId:
					known.processGroups[0]?.processGroupId ?? processGroupOf(known.admission)?.processGroupId ?? null,
				observedTranscriptDigest: null,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest: (await workspaceEvidence(request)).digest,
			});
			await recordReconciliation(quarantined, replay, known.admission, request, known.leaseRef);
			if (known.stateError !== null) throw known.stateError;
			const currentReplay = await dependencies.store.replay({
				workflowId: request.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: request.epochRef.storeEpoch,
			});
			validateAuthenticatedReplay(currentReplay);
			return {
				status: "blocked",
				binding: null,
				nonExecutionProof: null,
				journalHeadDigest: digestObject(currentReplay.head),
			};
		}
		if (admission === undefined) {
			const known = await quarantineKnownAdmissionState(request);
			const quarantined = await outcome({
				request,
				disposition: "user_input_required",
				admission: known.admission,
				observedChildIdentity: findAdmissionIdentity(known.admission),
				observedProcessGroupId:
					known.processGroups[0]?.processGroupId ?? processGroupOf(known.admission)?.processGroupId ?? null,
				observedTranscriptDigest: null,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest: (await workspaceEvidence(request)).digest,
			});
			await recordReconciliation(quarantined, replay, known.admission, request, known.leaseRef);
			if (known.stateError !== null) throw known.stateError;
			const currentReplay = await dependencies.store.replay({
				workflowId: request.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: request.epochRef.storeEpoch,
			});
			validateAuthenticatedReplay(currentReplay);
			return {
				status: "blocked",
				binding: null,
				nonExecutionProof: null,
				journalHeadDigest: digestObject(currentReplay.head),
			};
		}
		if (request.persistedChildIdentity !== null) {
			const boundIdentity = findAdmissionBoundIdentity(admission);
			if (boundIdentity === null || !sameIdentity(request.persistedChildIdentity, boundIdentity)) {
				await quarantineAttempt(admission, processGroupOf(admission), request, "workflow_child_identity_unbound");
				return {
					status: "blocked",
					binding: null,
					nonExecutionProof: null,
					journalHeadDigest: digestObject(replay.head),
				};
			}
		}
		const workspace = await workspaceEvidence(request);
		const binding = await recoveryBinding(request, admission, workspace);
		if (binding === null)
			return {
				status: "blocked",
				binding: null,
				nonExecutionProof: null,
				journalHeadDigest: digestObject(replay.head),
			};
		const persistedGroup = processGroupOf(admission);
		if (persistedGroup !== null && !(await verifyCurrentProcessContainment(persistedGroup))) {
			await quarantineAttempt(admission, persistedGroup, request, "workflow_process_identity_lost");
			return {
				status: "blocked",
				binding: null,
				nonExecutionProof: null,
				journalHeadDigest: digestObject(replay.head),
			};
		}
		const evidence = await readNoStartEvidence(
			request,
			replay,
			workspace.digest,
			recoveryEffectIdentityDigest({
				admissionId: admission.admissionId,
				expectedEffectDigest: admission.context.expectedEffectDigest,
				decisionRef: admission.context.decisionRef,
				resourceLeaseRef: admission.context.resourceLeaseRef,
				ownershipLeaseRef: admission.context.ownershipLeaseRef,
				launchConfigDigest: admission.context.launchConfigDigest,
			}),
		);
		return {
			status: "started",
			binding,
			nonExecutionProof: evidence?.proofDigest ?? null,
			journalHeadDigest: digestObject(replay.head),
		};
	};

	const reconcileUnlocked = async (request: WorkflowRecoveryRequest): Promise<WorkflowReconciliationOutcome> => {
		validRequest(request, dependencies.workflowId);
		if (!readiness().canRecover) return disabledOutcome(request);
		await hydrate();
		if ((await activeLeaseRef()) === null) return disabledOutcome(request);
		let admission: WorkflowAdmissionResult | undefined;
		try {
			admission = await dependencies.admission.lookupByExecutionKey(request.workflowId, request.executionKey);
		} catch {
			const known = await quarantineKnownAdmissionState(request);
			const knownAdmission = known.admission;
			const quarantined = await outcome({
				request,
				disposition: "user_input_required",
				admission: knownAdmission,
				observedChildIdentity: findAdmissionIdentity(knownAdmission),
				observedProcessGroupId:
					known.processGroups[0]?.processGroupId ?? processGroupOf(knownAdmission)?.processGroupId ?? null,
				observedTranscriptDigest: null,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest: (await workspaceEvidence(request)).digest,
			});
			await recordReconciliation(quarantined, undefined, knownAdmission, request, known.leaseRef);
			if (known.stateError !== null) throw known.stateError;
			return quarantined;
		}
		if (request.persistedChildIdentity !== null) {
			const boundIdentity = findAdmissionBoundIdentity(admission);
			if (boundIdentity === null || !sameIdentity(request.persistedChildIdentity, boundIdentity)) {
				const workspace = await workspaceEvidence(request);
				await quarantineAttempt(admission, processGroupOf(admission), request, "workflow_child_identity_unbound");
				return outcome({
					request,
					disposition: "user_input_required",
					admission,
					observedChildIdentity: findAdmissionIdentity(admission),
					observedProcessGroupId: processGroupOf(admission)?.processGroupId ?? null,
					observedTranscriptDigest: null,
					evidenceRefs: request.evidenceRefs,
					workspaceDigest: workspace.digest,
				});
			}
		}
		let current = true;
		try {
			await dependencies.epochs.assertCurrent(request.workflowId, request.epochRef);
		} catch {
			current = false;
		}
		const workspace = await workspaceEvidence(request);
		const workspaceDigest = workspace.digest;
		const transcriptDigest = await safeTranscriptDigest(request);
		if (!current) {
			await quarantineAttempt(admission, processGroupOf(admission), request, "workflow_epoch_stale");
			return outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: findAdmissionIdentity(admission),
				observedProcessGroupId: processGroupOf(admission)?.processGroupId ?? null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
		}
		let replay: WorkflowStoreReplayResult;
		try {
			replay = await dependencies.store.replay({
				workflowId: request.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: request.epochRef.storeEpoch,
			});
			validateAuthenticatedReplay(replay);
		} catch {
			await quarantineAttempt(admission, processGroupOf(admission), request, "workflow_replay_unavailable");
			return outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: findAdmissionIdentity(admission),
				observedProcessGroupId: processGroupOf(admission)?.processGroupId ?? null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
		}
		if (replay.quarantined) {
			await quarantineAttempt(
				admission,
				processGroupOf(admission),
				request,
				replay.quarantineReason ?? "workflow_replay_quarantined",
			);
			return outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: findAdmissionIdentity(admission),
				observedProcessGroupId: processGroupOf(admission)?.processGroupId ?? null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
		}

		const payloads = eventForAttempt(eventPayloads(replay), request);
		const priorReconciliations = payloads.filter(
			(payload): payload is Extract<WorkflowRuntimeEventPayload, { kind: "workflow_reconciliation_recorded" }> =>
				payload.kind === "workflow_reconciliation_recorded",
		);
		if (priorReconciliations.length > 0) {
			const first = priorReconciliations[0];
			if (
				first === undefined ||
				first.outcomeDigest !== digestObject(first.outcome) ||
				priorReconciliations.some(
					(candidate) =>
						candidate.outcomeDigest !== digestObject(candidate.outcome) ||
						digestObject(candidate.outcome) !== digestObject(first.outcome),
				)
			)
				throw new WorkflowRuntimeRecoveryError("workflow_reconciliation_record_conflict");
			const currentIdentity = findAdmissionIdentity(admission);
			const currentGroup = processGroupOf(admission);
			if (
				!(await priorOutcomeMatchesCurrentIdentity(
					first.outcome,
					admission,
					request,
					processGroupForReconciliationEvidence(payloads),
				))
			) {
				await quarantineAttempt(admission, currentGroup, request, "workflow_process_identity_lost");
				return outcome({
					request,
					disposition: "user_input_required",
					admission,
					observedChildIdentity: currentIdentity,
					observedProcessGroupId: currentGroup?.processGroupId ?? null,
					observedTranscriptDigest: null,
					evidenceRefs: request.evidenceRefs,
					workspaceDigest: (await workspaceEvidence(request)).digest,
				});
			}
			return first.outcome;
		}
		const persistedIdentity = findAdmissionIdentity(admission);
		const persistedGroup = processGroupOf(admission);
		const dispatchIntents = payloads.filter(
			(payload): payload is Extract<WorkflowRuntimeEventPayload, { kind: "workflow_dispatch_intent" }> =>
				payload.kind === "workflow_dispatch_intent",
		);
		const terminalEvents = terminalEventsForAttempt(payloads);
		const processOwnedEvents = processOwnedEventsForAttempt(payloads);
		const childBoundEvents = childIdentityBoundEventsForAttempt(payloads);
		const processReapedEvents = processReapedEventsForAttempt(payloads);
		const effectIntents = effectIntentsForAttempt(payloads);
		const effectResolutions = effectResolutionEventsForAttempt(payloads);

		if (admission === undefined) {
			const currentLease = await activeLeaseRef();
			await quarantineAttempt(
				undefined,
				null,
				request,
				"workflow_admission_missing",
				uniqueProcessGroups(null, processOwnedEvents, childBoundEvents),
				currentLease === null || !sameEpoch(currentLease, request.epochRef) ? [] : [currentLease],
			);
			const reconciled = await outcome({
				request,
				disposition: "user_input_required",
				admission: undefined,
				observedChildIdentity: null,
				observedProcessGroupId:
					processOwnedEvents[0]?.processGroup.processGroupId ??
					childBoundEvents[0]?.processBinding.processGroup.processGroupId ??
					null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
			await recordReconciliation(reconciled, replay, undefined, request, currentLease);
			return reconciled;
		}

		if (admission?.status === "quarantined") {
			await quarantineAttempt(admission, persistedGroup, request, "workflow_admission_quarantined", [
				...processOwnedEvents.map((event) => event.processGroup),
				...childBoundEvents.map((event) => event.processBinding.processGroup),
			]);
			return outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: persistedIdentity,
				observedProcessGroupId: persistedGroup?.processGroupId ?? null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
		}

		const persistedOwnershipConflict =
			persistedGroup !== null &&
			[
				...processOwnedEvents.map((event) => event.processGroup),
				...childBoundEvents.map((event) => event.processBinding.processGroup),
			].some((processGroup) => processGroup.identityDigest !== persistedGroup.identityDigest);
		const processGroupIdentityConflict = [
			persistedGroup,
			...processOwnedEvents.map((event) => event.processGroup),
			...childBoundEvents.map((event) => event.processBinding.processGroup),
		].some(
			(processGroup): processGroup is WorkflowProcessGroupIdentity =>
				processGroup !== null && !validProcessGroupIdentity(processGroup),
		);
		const persistedBindingGroupConflict =
			persistedIdentity !== null &&
			persistedGroup !== null &&
			persistedIdentity.processGroupId !== persistedGroup.processGroupId;
		const childIdentityEventConflict = childBoundEvents.some(
			(event) =>
				event.admissionId !== admission?.admissionId ||
				!sameIdentity(event.identity, event.processBinding.childIdentity) ||
				event.processBinding.workflowId !== request.workflowId ||
				event.processBinding.taskId !== request.taskId ||
				event.processBinding.attemptId !== request.attemptId ||
				event.processBinding.childIdentity.processGroupId !== event.processBinding.processGroup.processGroupId ||
				!validProcessGroupIdentity(event.processBinding.processGroup) ||
				event.processBinding.bindingDigest !==
					digestObject({
						childIdentity: event.processBinding.childIdentity,
						processGroup: event.processBinding.processGroup,
					}),
		);
		const persistedChildBindingConflict =
			persistedIdentity !== null &&
			childBoundEvents.some((event) => !sameIdentity(event.identity, persistedIdentity));
		const processOwnedChildBindingConflict =
			childBoundEvents.length > 0 &&
			processOwnedEvents.some(
				(ownedEvent) =>
					!childBoundEvents.some(
						(boundEvent) =>
							ownedEvent.processGroup.identityDigest === boundEvent.processBinding.processGroup.identityDigest,
					),
			);
		const knownProcessGroupIds = new Set([
			persistedGroup?.processGroupId,
			...processOwnedEvents.map((event) => event.processGroup.processGroupId),
			...childBoundEvents.map((event) => event.processBinding.processGroup.processGroupId),
		]);
		const processReapedIdentityConflict = processReapedEvents.some(
			(event) => !knownProcessGroupIds.has(event.processGroupId),
		);
		if (
			hasConflictingEvents(dispatchIntents) ||
			hasConflictingEvents(terminalEvents) ||
			hasConflictingEvents(processOwnedEvents, (event) => digestObject(event.processGroup)) ||
			hasConflictingEvents(childBoundEvents) ||
			hasConflictingEvents(effectIntents) ||
			hasConflictingEvents(effectResolutions) ||
			persistedOwnershipConflict ||
			processGroupIdentityConflict ||
			persistedBindingGroupConflict ||
			childIdentityEventConflict ||
			persistedChildBindingConflict ||
			processOwnedChildBindingConflict ||
			processReapedIdentityConflict
		) {
			await quarantineAttempt(
				admission,
				null,
				request,
				"workflow_duplicate_event_conflict",
				uniqueProcessGroups(persistedGroup, processOwnedEvents, childBoundEvents),
			);
			return outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: persistedIdentity,
				observedProcessGroupId:
					processOwnedEvents[0]?.processGroup.processGroupId ??
					childBoundEvents[0]?.processBinding.processGroup.processGroupId ??
					persistedGroup?.processGroupId ??
					null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
		}

		const dispatchIntent = dispatchIntents[0];
		if (
			dispatchIntent !== undefined &&
			(admission === undefined ||
				dispatchIntent.taskId !== request.taskId ||
				dispatchIntent.admissionId !== admission.admissionId ||
				digestObject(dispatchIntent.decisionRef) !== digestObject(admission.context.decisionRef) ||
				digestObject(dispatchIntent.resourceLeaseRef) !== digestObject(admission.context.resourceLeaseRef) ||
				digestObject(dispatchIntent.ownershipLeaseRef) !== digestObject(admission.context.ownershipLeaseRef) ||
				dispatchIntent.launchConfigDigest !== admission.context.launchConfigDigest ||
				dispatchIntent.expectedEffectDigest !== admission.context.expectedEffectDigest)
		) {
			await quarantineAttempt(admission, persistedGroup, request, "workflow_dispatch_intent_conflict");
			return outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: persistedIdentity,
				observedProcessGroupId: persistedGroup?.processGroupId ?? null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
		}

		if (
			!admissionMatchesRequest(admission, request) ||
			(request.persistedChildIdentity !== null &&
				(persistedIdentity === null || !sameIdentity(request.persistedChildIdentity, persistedIdentity))) ||
			(persistedIdentity !== null &&
				(!sameEpoch(persistedIdentity.epochRef, request.epochRef) ||
					persistedIdentity.executionKey !== request.executionKey))
		) {
			await quarantineAttempt(admission, persistedGroup, request, "workflow_child_identity_conflict");
			return outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: persistedIdentity,
				observedProcessGroupId: persistedGroup?.processGroupId ?? null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
		}

		if (effectResolutions.length > 0 && effectIntents.length === 0) {
			await quarantineAttempt(admission, null, request, "workflow_effect_resolution_without_intent");
			const reconciled = await outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: null,
				observedProcessGroupId: null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
			await recordReconciliation(reconciled, replay, admission, request);
			return reconciled;
		}

		const terminal = terminalEvents[0];
		const terminalDigest = terminal?.outcomeDigest ?? admission?.outcomeDigest;
		const terminalDigestConflict =
			terminal !== undefined &&
			(terminal.outcomeDigest !== digestWorkflowOutcome(terminal.outcome) ||
				(admission?.outcomeDigest !== null &&
					admission?.outcomeDigest !== undefined &&
					admission.outcomeDigest !== terminal.outcomeDigest));
		if (terminal !== undefined || terminalAdmission(admission)) {
			if (
				admission === undefined ||
				terminalDigest === null ||
				terminalDigest === undefined ||
				terminalDigestConflict
			) {
				await quarantineAttempt(admission, persistedGroup, request, "workflow_terminal_binding_missing");
				return outcome({
					request,
					disposition: "user_input_required",
					admission,
					observedChildIdentity: persistedIdentity,
					observedProcessGroupId: persistedGroup?.processGroupId ?? null,
					observedTranscriptDigest: transcriptDigest,
					evidenceRefs: request.evidenceRefs,
					workspaceDigest,
				});
			}
			const terminalGroups = uniqueProcessGroups(persistedGroup, processOwnedEvents, childBoundEvents);
			const processGroupResult = await reconcileTerminalProcessGroups(terminalGroups);
			const processGroupsSafe = processGroupResult.safe;
			const unknownDescendantsSafe = await quarantineUnknownDescendants(
				request.workflowId,
				"workflow_terminal_foreign_child",
			);
			const effectsSafe = await reconcileEffectIntents({
				request,
				admission,
				effectIntents,
				effectResolutions,
			});
			if (!processGroupsSafe || !unknownDescendantsSafe || !effectsSafe) {
				await quarantineAttempt(
					admission,
					null,
					request,
					!processGroupsSafe || !unknownDescendantsSafe
						? "workflow_terminal_process_recovery_uncertain"
						: "workflow_effect_reconciliation_uncertain",
				);
				const reconciled = await outcome({
					request,
					disposition: "user_input_required",
					admission,
					observedChildIdentity: persistedIdentity,
					observedProcessGroupId: persistedGroup?.processGroupId ?? null,
					observedTranscriptDigest: transcriptDigest,
					evidenceRefs: [...request.evidenceRefs, ...outcomeEvidence(terminal)],
					workspaceDigest,
				});
				await recordReconciliation(reconciled, replay, admission, request);
				if (processGroupResult.error !== null) throw processGroupResult.error;
				return reconciled;
			}
			const released = await releaseLeases(admission, request, terminalDigest);
			const terminalStatus =
				admission.status === "completed" ? (terminal?.outcome.attemptStatus ?? admission.status) : admission.status;
			const disposition: WorkflowReconciliationOutcome["disposition"] = released
				? terminalDisposition(terminalStatus, terminal?.outcome.outcome.status)
				: "corrective_work_required";
			const terminalEvidence = outcomeEvidence(terminal);
			const reconciled = await outcome({
				request,
				disposition,
				admission,
				observedChildIdentity: persistedIdentity,
				observedProcessGroupId: persistedGroup?.processGroupId ?? null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: [...request.evidenceRefs, ...terminalEvidence],
				workspaceDigest,
			});
			await recordReconciliation(reconciled, replay, admission, request);
			return reconciled;
		}

		const childBound = childBoundEvents[0];
		if (childBound !== undefined && (persistedGroup === null || persistedIdentity === null)) {
			await quarantineAttempt(
				admission,
				childBound.processBinding.processGroup,
				request,
				"workflow_child_binding_unattached",
			);
			const reconciled = await outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: childBound.identity,
				observedProcessGroupId: childBound.processBinding.processGroup.processGroupId,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
			await recordReconciliation(reconciled, replay, admission, request);
			return reconciled;
		}

		if (persistedGroup !== null && persistedIdentity !== null) {
			const live = await verifyCurrentProcessContainment(persistedGroup);
			if (live) {
				const reconciled = await outcome({
					request,
					disposition: "reattached",
					admission,
					observedChildIdentity: persistedIdentity,
					observedProcessGroupId: persistedGroup.processGroupId,
					observedTranscriptDigest: transcriptDigest,
					evidenceRefs: request.evidenceRefs,
					workspaceDigest,
				});
				await recordReconciliation(reconciled, replay, admission, request);
				return reconciled;
			}
			await quarantineAttempt(admission, persistedGroup, request, "workflow_process_identity_lost");
			const reconciled = await outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: persistedIdentity,
				observedProcessGroupId: persistedGroup.processGroupId,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
			await recordReconciliation(reconciled, replay, admission, request);
			return reconciled;
		}

		const owned = processOwnedEvents[0];
		if (owned !== undefined) {
			await quarantineAttempt(admission, owned.processGroup, request, "workflow_process_identity_unbound");
			const reconciled = await outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: null,
				observedProcessGroupId: owned.processGroup.processGroupId,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
			await recordReconciliation(reconciled, replay, admission, request);
			return reconciled;
		}

		const effectIntent = effectIntents[0];
		if (effectIntent !== undefined) {
			const effectsSafe = await reconcileEffectIntents({
				request,
				admission,
				effectIntents,
				effectResolutions,
			});
			const effectDisposition = effectsSafe ? "corrective_work_required" : "user_input_required";
			if (!effectsSafe)
				await quarantineAttempt(admission, null, request, "workflow_effect_reconciliation_uncertain");
			const reconciled = await outcome({
				request,
				disposition: effectDisposition,
				admission,
				observedChildIdentity: null,
				observedProcessGroupId: null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
			await recordReconciliation(reconciled, replay, admission, request);
			return reconciled;
		}

		const unknown = await dependencies.groups.scanUnknownDescendants(request.workflowId);
		if (unknown.length > 0) {
			await quarantineUnknownDescendants(request.workflowId, "workflow_foreign_child");
			const reconciled = await outcome({
				request,
				disposition: "user_input_required",
				admission,
				observedChildIdentity: null,
				observedProcessGroupId: null,
				observedTranscriptDigest: transcriptDigest,
				evidenceRefs: request.evidenceRefs,
				workspaceDigest,
			});
			await recordReconciliation(reconciled, replay, admission, request);
			return reconciled;
		}

		const noStartEvidence =
			dispatchIntent !== undefined && admission !== undefined && workspace.available && !startedForAttempt(payloads)
				? await readNoStartEvidence(
						request,
						replay,
						workspaceDigest,
						recoveryEffectIdentityDigest({
							admissionId: dispatchIntent.admissionId,
							expectedEffectDigest: dispatchIntent.expectedEffectDigest,
							decisionRef: dispatchIntent.decisionRef,
							resourceLeaseRef: dispatchIntent.resourceLeaseRef,
							ownershipLeaseRef: dispatchIntent.ownershipLeaseRef,
							launchConfigDigest: dispatchIntent.launchConfigDigest,
						}),
					)
				: null;
		const noStartProven = noStartEvidence !== null;
		const noStartEvidenceRefs =
			noStartEvidence === null
				? []
				: [noStartEvidence.preExecutionBaseline.artifactRef, noStartEvidence.postObservation.artifactRef];
		const reconciled = await outcome({
			request,
			disposition: startedForAttempt(payloads)
				? "corrective_work_required"
				: noStartProven
					? "proven_not_executed"
					: "user_input_required",
			admission,
			observedChildIdentity: null,
			observedProcessGroupId: null,
			observedTranscriptDigest: transcriptDigest,
			evidenceRefs: [...request.evidenceRefs, ...noStartEvidenceRefs],
			workspaceDigest,
		});
		await recordReconciliation(reconciled, replay, admission, request);
		return reconciled;
	};

	const recordReconciliation = async (
		reconciled: WorkflowReconciliationOutcome,
		_replay: WorkflowStoreReplayResult | undefined,
		admission: WorkflowAdmissionResult | undefined,
		request: WorkflowRecoveryRequest,
		leaseOverride: WorkflowLeaseRef | null = null,
	): Promise<void> => {
		const leaseRef = leaseOverride ?? (await activeLeaseRef()) ?? admission?.context.resourceLeaseRef ?? null;
		const currentReplay = await dependencies.store.replay({
			workflowId: request.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: request.epochRef.storeEpoch,
		});
		validateAuthenticatedReplay(currentReplay);
		await recordEvent(
			{
				kind: "workflow_reconciliation_recorded",
				workflowId: request.workflowId,
				attemptId: request.attemptId,
				epochRef: request.epochRef,
				outcome: reconciled,
				outcomeDigest: digestObject(reconciled),
			},
			request,
			currentReplay,
			leaseRef,
			`workflow-reconciliation:${digestObject({
				logicalId: reconciled.reconciliationAttemptId,
				expectedHead: currentReplay.head,
			})}`,
		);
	};

	const reconcile = async (request: WorkflowRecoveryRequest): Promise<WorkflowReconciliationOutcome> => {
		validRequest(request, dependencies.workflowId);
		let headDigest = "head-unavailable";
		let preflightReplay: WorkflowStoreReplayResult | null = null;
		if (readiness().canRecover) {
			const readPreflight = async (): Promise<void> => {
				try {
					preflightReplay = await dependencies.store.replay({
						workflowId: request.workflowId,
						fromSequence: 0,
						expectedStoreEpoch: request.epochRef.storeEpoch,
					});
					validateAuthenticatedReplay(preflightReplay);
					headDigest = digestObject(preflightReplay.head);
				} catch {
					preflightReplay = null;
					headDigest = "head-unavailable";
				}
			};
			if (dependencies.withRecoveryReadBoundary !== undefined)
				await dependencies.withRecoveryReadBoundary("workflow-recovery-preflight-replay", readPreflight);
			else await readPreflight();
		}
		const lockKey = recoveryAttemptId(request, headDigest);
		const existing = reconciliationLocks.get(lockKey);
		if (existing !== undefined) return existing;
		const current = (async (): Promise<WorkflowReconciliationOutcome> => {
			const claims = dependencies.recoveryClaims;
			if (claims === undefined || preflightReplay === null) return reconcileUnlocked(request);
			const leaseRef = await activeLeaseRef();
			const writerIdentity = dependencies.writerIdentity;
			if (
				leaseRef === null ||
				!sameEpoch(leaseRef, request.epochRef) ||
				typeof writerIdentity !== "string" ||
				!nonEmpty(writerIdentity) ||
				leaseRef.writerIdentity !== writerIdentity
			)
				return reconcileUnlocked(request);
			const claimInput: WorkflowRuntimeRecoveryClaimInput = {
				claimId: lockKey,
				workflowId: request.workflowId,
				taskId: request.taskId,
				attemptId: request.attemptId,
				executionKey: request.executionKey,
				stateDigest: recoveryAttemptStateDigest(request),
				headDigest,
				epochRef: request.epochRef,
				leaseRef,
				writerIdentity,
			};
			const claim = await claims.acquire(claimInput);
			if (claim.status === "completed") {
				let admission: WorkflowAdmissionResult | undefined;
				try {
					admission = await dependencies.admission.lookupByExecutionKey(request.workflowId, request.executionKey);
				} catch {
					admission = undefined;
				}
				const priorProcessGroup =
					preflightReplay === null
						? null
						: processGroupForReconciliationEvidence(eventForAttempt(eventPayloads(preflightReplay), request));
				if (await priorOutcomeMatchesCurrentIdentity(claim.outcome, admission, request, priorProcessGroup))
					return claim.outcome;
				return reconcileUnlocked(request);
			}
			if (claim.status !== "acquired")
				return outcome({
					request,
					disposition: "user_input_required",
					admission: undefined,
					observedChildIdentity: null,
					observedProcessGroupId: null,
					observedTranscriptDigest: null,
					evidenceRefs: request.evidenceRefs,
					workspaceDigest: defaultWorkspaceDigest(request),
				});
			let reconciled: WorkflowReconciliationOutcome;
			try {
				reconciled = await reconcileUnlocked(request);
			} catch (error) {
				await claims.release(claimInput);
				throw error;
			}
			await claims.complete(claimInput, reconciled);
			return reconciled;
		})();
		let tracked!: Promise<WorkflowReconciliationOutcome>;
		tracked = current.finally(() => {
			if (reconciliationLocks.get(lockKey) === tracked) reconciliationLocks.delete(lockKey);
		});
		reconciliationLocks.set(lockKey, tracked);
		return tracked;
	};

	return {
		readiness,
		startRecovery,
		beginRecovery: startRecovery,
		reconcile,
	};
}

export const createWorkflowRecoveryCoordinator = createWorkflowRuntimeRecoveryCoordinator;
