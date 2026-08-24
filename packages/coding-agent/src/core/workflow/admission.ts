import type {
	DurableDecisionRef,
	WorkflowArtifactRef,
	WorkflowAttemptLifecycle,
	WorkflowAttemptStatus,
	WorkflowBlockerClaim,
	WorkflowChildAuthority,
	WorkflowChildIdentity,
	WorkflowChildProcessBinding,
	WorkflowControlCapacityVector,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalCommit,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowOwnershipLease,
	WorkflowPhaseOutcomeRecord,
	WorkflowProcessGroupIdentity,
	WorkflowResourceLease,
	WorkflowRevisionBoundaryContext,
	WorkflowRevisionTuple,
	WorkflowRuntimeStore,
	WorkflowSemanticMutationBinding,
	WorkflowStoreCommitResult,
} from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes, sha256Hex } from "./contracts.js";
import {
	assertRevisionBoundary as assertDispatchRevisionBoundary,
	deriveWorkflowExecutionKey as deriveDispatchExecutionKey,
	type WorkflowCanonicalDispatchInput,
	WorkflowDispatchError,
	type WorkflowRevisionBoundaryReader,
	type WorkflowRevisionRegistryAdapter,
} from "./dispatch.js";
import { type WorkflowCoordinatorLease, WorkflowEpochError, type WorkflowEpochManager } from "./epochs.js";
import {
	assertWorkflowProcessContainmentAttestation,
	assertWorkflowProcessGroupIdentity,
	type WorkflowProcessContainmentVerifier,
} from "./process-groups.js";

export type { WorkflowCanonicalDispatchInput, WorkflowRevisionBoundaryReader } from "./dispatch.js";
export { WorkflowDispatchError } from "./dispatch.js";

/** Error raised when the pinned revision tuple is not the active tuple. */
export class WorkflowRevisionError extends WorkflowDispatchError {
	constructor(code: string) {
		super(code);
		this.name = "WorkflowRevisionError";
	}
}

export type WorkflowAdmissionRevisionRegistry = WorkflowRevisionRegistryAdapter;

export interface WorkflowAdmissionRevisionReader extends WorkflowRevisionBoundaryReader {
	readonly readActiveLeaseContext?: () => Promise<WorkflowActiveLeaseContext>;
	readonly activeLease?: WorkflowActiveLeaseContext;
	readonly readCurrentEpoch?: (workflowId: string) => Promise<WorkflowEpochRef>;
}

export interface WorkflowActiveLeaseContext {
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly writerIdentity: string;
	readonly generationId: string;
	readonly revisionBoundary: WorkflowRevisionBoundaryContext;
}

export interface WorkflowBindingAcknowledgementExpectation {
	readonly workflowId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly epochRef: WorkflowEpochRef;
	readonly resourceLeaseRef: WorkflowLeaseRef;
	readonly ownershipLeaseRef: WorkflowLeaseRef | null;
	readonly revisionBoundary: WorkflowRevisionBoundaryContext;
	readonly identityDigest: string;
	readonly bindingDigest: string;
	readonly processGroupId: string;
	readonly nonce: string;
	readonly rootSessionId: string;
	readonly configSnapshotDigest: string;
	readonly expectedEffectDigest: string;
}

export interface WorkflowBindingReceiptStore {
	readonly assertActive?: (expectation: WorkflowBindingAcknowledgementExpectation) => Promise<void>;
	readonly assertCurrent?: (expectation: WorkflowBindingAcknowledgementExpectation) => Promise<void>;
}

export interface WorkflowInternalAdmissionContext {
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly idempotencyKey: string;
	readonly decisionRef: DurableDecisionRef;
	readonly resourceLeaseRef: WorkflowLeaseRef;
	readonly controlCapacity: WorkflowControlCapacityVector;
	readonly ownershipLeaseRef: WorkflowLeaseRef | null;
	readonly childAuthority: WorkflowChildAuthority;
	readonly launchConfigDigest: string;
	readonly runtimeVersion: string;
	readonly hostCapabilityRevision: string;
	readonly agentRole: string;
	readonly modelId: string;
	readonly reasoningEffort: string;
	readonly expectedEffectDigest: string;
	readonly epochRef: WorkflowEpochRef;
	readonly configSnapshotDigest: string;
	readonly revisionTuple: WorkflowRevisionTuple;
	readonly revisionRegistryRef: WorkflowArtifactRef;
	readonly revisionRegistryDigest: string;
	readonly writerIdentity: string;
}

export interface WorkflowAdmissionResult {
	readonly context: WorkflowInternalAdmissionContext;
	readonly admissionId: string;
	readonly lifecycle: WorkflowAttemptLifecycle;
	readonly status: WorkflowAttemptStatus;
	readonly childIdentity: WorkflowChildIdentity | null;
	readonly processBinding: WorkflowChildProcessBinding | null;
	readonly admissionEventSequence: number;
	readonly terminalEventSequence: number | null;
	readonly outcomeDigest: string | null;
}

export interface WorkflowOutcomeAdmissionBinding {
	readonly workflowId: string;
	readonly phaseAttemptId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly invocationToken: string;
	readonly epochRef: WorkflowEpochRef;
	readonly resourceLeaseRef: WorkflowLeaseRef;
	readonly ownershipLeaseRef: WorkflowLeaseRef | null;
	readonly revisionBoundary: WorkflowRevisionBoundaryContext;
	readonly outcomeDigest: string;
	readonly rootSessionId: string;
	readonly configSnapshotDigest: string;
	readonly expectedEffectDigest: string;
}

export interface WorkflowAdmissionProcessVerificationInput {
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly admissionId: string;
	readonly executionKey: string;
	readonly nonce: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly launchConfigDigest: string;
	readonly runtimeVersion: string;
	readonly hostCapabilityRevision: string;
	readonly agentRole: string;
	readonly modelId: string;
	readonly reasoningEffort: string;
	readonly expectedEffectDigest: string;
	readonly configSnapshotDigest: string;
	readonly revisionTuple: WorkflowRevisionTuple;
	readonly revisionRegistryRef: WorkflowArtifactRef;
	readonly revisionRegistryDigest: string;
	readonly binding: WorkflowChildProcessBinding;
}

export type WorkflowAdmissionLaunchChildIdentity = Omit<WorkflowChildIdentity, "identityDigest">;

/** Host-issued launch authority; callers cannot mint a binding by copying its public fields. */
export interface WorkflowAdmissionLaunchReservation {
	readonly reservationId: string;
	readonly reservationDigest: string;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly admissionId: string;
	readonly executionKey: string;
	readonly nonce: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly childIdentity: WorkflowAdmissionLaunchChildIdentity;
	readonly processGroup: WorkflowProcessGroupIdentity;
	readonly currentProcessGroup: WorkflowProcessGroupIdentity;
}

export interface WorkflowAdmissionLaunchReservationSpawnInput {
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly admissionId: string;
	readonly childSessionId: string;
	readonly executionKey: string;
	readonly nonce: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly runtimeVersion: string;
	readonly hostCapabilityRevision: string;
	readonly agentRole: string;
	readonly modelId: string;
	readonly reasoningEffort: string;
	readonly launchConfigDigest: string;
	readonly requestDigest: string;
}

export interface WorkflowAdmissionLaunchReservationReader {
	readonly readLaunchReservation: (
		input: WorkflowAdmissionProcessVerificationInput,
	) => Promise<WorkflowAdmissionLaunchReservation | null>;
	readonly readLaunchReservationForSpawn?: (
		input: WorkflowAdmissionLaunchReservationSpawnInput,
	) => Promise<WorkflowAdmissionLaunchReservation | null>;
}

export interface WorkflowAdmissionProcessIdentityObservation {
	readonly hostAuthenticated: true;
	readonly liveness: "live";
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly admissionId: string;
	readonly executionKey: string;
	readonly nonce: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly pid: number;
	readonly processStartId: string;
	readonly processGroupId: string;
	readonly parentPid: number;
}

export interface WorkflowAdmissionProcessVerificationResult {
	readonly verified: true;
	readonly hostAuthenticated: true;
	readonly liveness: "live";
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly admissionId: string;
	readonly executionKey: string;
	readonly nonce: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly pid: number;
	readonly processStartId: string;
	readonly processGroupId: string;
	readonly parentPid: number;
	readonly proofDigest: string;
}

/** Host-owned proof that the binding is a separate, start-identified process group. */
type WorkflowAdmissionHostProcessIdentity = Pick<
	WorkflowProcessGroupIdentity,
	"pid" | "processStartId" | "processGroupId"
>;

export interface WorkflowAdmissionProcessVerifier {
	readonly readCurrentHostIdentity: () => Promise<WorkflowAdmissionHostProcessIdentity>;
	readonly readCurrentChildIdentity: (
		input: WorkflowAdmissionProcessVerificationInput,
	) => Promise<WorkflowAdmissionProcessIdentityObservation>;
	readonly verify: (
		input: WorkflowAdmissionProcessVerificationInput,
		observation: WorkflowAdmissionProcessIdentityObservation,
	) => Promise<WorkflowAdmissionProcessVerificationResult>;
}

function createAdmissionProcessVerifierFromContainment(
	containment: WorkflowProcessContainmentVerifier,
	reservations: WorkflowAdmissionLaunchReservationReader,
): WorkflowAdmissionProcessVerifier {
	const readReservation = async (
		input: WorkflowAdmissionProcessVerificationInput,
	): Promise<WorkflowAdmissionLaunchReservation> => {
		const reservation = await reservations.readLaunchReservation(input);
		assertWorkflowAdmissionLaunchReservation(reservation);
		if (
			reservation.workflowId !== input.workflowId ||
			reservation.rootSessionId !== input.rootSessionId ||
			reservation.taskId !== input.taskId ||
			reservation.attemptId !== input.attemptId ||
			reservation.admissionId !== input.admissionId ||
			reservation.executionKey !== input.executionKey ||
			reservation.nonce !== input.nonce ||
			!sameEpoch(reservation.epochRef, input.epochRef) ||
			digestObject(reservation.head) !== digestObject(input.head) ||
			!workflowProcessGroupStableIdentityMatches(reservation.processGroup, input.binding.processGroup) ||
			!workflowProcessGroupStableIdentityMatches(reservation.currentProcessGroup, input.binding.processGroup) ||
			reservation.childIdentity.childSessionId !== input.binding.childIdentity.childSessionId ||
			reservation.childIdentity.runtimeVersion !== input.binding.childIdentity.runtimeVersion ||
			reservation.childIdentity.hostCapabilityRevision !== input.binding.childIdentity.hostCapabilityRevision ||
			reservation.childIdentity.agentRole !== input.binding.childIdentity.agentRole ||
			reservation.childIdentity.modelId !== input.binding.childIdentity.modelId ||
			reservation.childIdentity.reasoningEffort !== input.binding.childIdentity.reasoningEffort ||
			reservation.childIdentity.launchConfigDigest !== input.binding.childIdentity.launchConfigDigest ||
			reservation.childIdentity.processGroupId !== input.binding.childIdentity.processGroupId
		)
			throw new WorkflowDispatchError("workflow_child_process_unverified");
		return reservation;
	};
	const verifyChild = async (input: WorkflowAdmissionProcessVerificationInput) => {
		const reservation = await readReservation(input);
		const observation = await containment.verify(reservation.currentProcessGroup);
		try {
			assertWorkflowProcessContainmentAttestation(observation.containment);
			assertWorkflowProcessGroupIdentity(observation.identity);
		} catch {
			throw new WorkflowDispatchError("workflow_child_process_unverified");
		}
		if (
			!observation.verified ||
			!workflowProcessGroupStableIdentityMatches(observation.identity, input.binding.processGroup) ||
			(input.binding.processGroup.parentPid !== reservation.processGroup.parentPid &&
				input.binding.processGroup.parentPid !== observation.identity.parentPid)
		)
			throw new WorkflowDispatchError("workflow_child_process_unverified");
		return { identity: observation.identity, reservation };
	};
	return {
		readCurrentHostIdentity: async () => {
			const identity = await containment.readCurrentHostIdentity();
			assertWorkflowProcessGroupIdentity(identity);
			return {
				pid: identity.pid,
				processStartId: identity.processStartId,
				processGroupId: identity.processGroupId,
			};
		},
		readCurrentChildIdentity: async (input) => {
			const { identity, reservation } = await verifyChild(input);
			return {
				hostAuthenticated: true,
				liveness: "live",
				workflowId: reservation.workflowId,
				taskId: reservation.taskId,
				attemptId: reservation.attemptId,
				admissionId: reservation.admissionId,
				executionKey: reservation.executionKey,
				nonce: reservation.nonce,
				epochRef: reservation.epochRef,
				head: reservation.head,
				pid: identity.pid,
				processStartId: identity.processStartId,
				processGroupId: identity.processGroupId,
				parentPid: identity.parentPid,
			};
		},
		verify: async (input, observation) => {
			const { identity } = await verifyChild(input);
			if (
				identity.pid !== observation.pid ||
				identity.processStartId !== observation.processStartId ||
				identity.processGroupId !== observation.processGroupId ||
				identity.parentPid !== observation.parentPid
			)
				throw new WorkflowDispatchError("workflow_child_process_unverified");
			const proof = { verified: true as const, ...observation };
			return { ...proof, proofDigest: digestObject(proof) };
		},
	};
}

function workflowProcessGroupStableIdentityMatches(
	left: Pick<WorkflowProcessGroupIdentity, "pid" | "processStartId" | "processGroupId" | "parentPid">,
	right: Pick<WorkflowProcessGroupIdentity, "pid" | "processStartId" | "processGroupId" | "parentPid">,
): boolean {
	return (
		left.pid === right.pid &&
		left.processStartId === right.processStartId &&
		left.processGroupId === right.processGroupId &&
		left.parentPid === right.parentPid
	);
}

export function assertWorkflowAdmissionLaunchReservation(
	value: unknown,
): asserts value is WorkflowAdmissionLaunchReservation {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"reservationId",
			"reservationDigest",
			"workflowId",
			"rootSessionId",
			"taskId",
			"attemptId",
			"admissionId",
			"executionKey",
			"nonce",
			"epochRef",
			"head",
			"childIdentity",
			"processGroup",
			"currentProcessGroup",
		]) ||
		!isNonEmptyString(value.reservationId) ||
		!isNonEmptyString(value.reservationDigest) ||
		!isNonEmptyString(value.workflowId) ||
		!isNonEmptyString(value.rootSessionId) ||
		!isNonEmptyString(value.taskId) ||
		!isNonEmptyString(value.attemptId) ||
		!isNonEmptyString(value.admissionId) ||
		!isNonEmptyString(value.executionKey) ||
		!isNonEmptyString(value.nonce) ||
		!isEpochValue(value.epochRef) ||
		!isWorkflowJournalHeadValue(value.head) ||
		!isRecord(value.childIdentity) ||
		!exactKeys(value.childIdentity, [
			"admissionId",
			"childSessionId",
			"executionKey",
			"epochRef",
			"runtimeVersion",
			"hostCapabilityRevision",
			"agentRole",
			"modelId",
			"reasoningEffort",
			"launchConfigDigest",
			"processGroupId",
		]) ||
		!isNonEmptyString(value.childIdentity.admissionId) ||
		!isNonEmptyString(value.childIdentity.childSessionId) ||
		!isNonEmptyString(value.childIdentity.executionKey) ||
		!isEpochValue(value.childIdentity.epochRef) ||
		!isNonEmptyString(value.childIdentity.runtimeVersion) ||
		!isNonEmptyString(value.childIdentity.hostCapabilityRevision) ||
		!isNonEmptyString(value.childIdentity.agentRole) ||
		!isNonEmptyString(value.childIdentity.modelId) ||
		!isNonEmptyString(value.childIdentity.reasoningEffort) ||
		!isNonEmptyString(value.childIdentity.launchConfigDigest) ||
		!isNonEmptyString(value.childIdentity.processGroupId) ||
		!isRecord(value.processGroup) ||
		!isRecord(value.currentProcessGroup)
	)
		throw new WorkflowDispatchError("workflow_child_process_unverified");
	try {
		assertWorkflowProcessGroupIdentity(value.processGroup);
		assertWorkflowProcessGroupIdentity(value.currentProcessGroup);
	} catch {
		throw new WorkflowDispatchError("workflow_child_process_unverified");
	}
	const { reservationDigest: _reservationDigest, ...unsigned } = value;
	if (
		value.head.workflowId !== value.workflowId ||
		!sameEpoch(value.head.epochRef, value.epochRef) ||
		value.childIdentity.admissionId !== value.admissionId ||
		value.childIdentity.executionKey !== value.executionKey ||
		!sameEpoch(value.childIdentity.epochRef, value.epochRef) ||
		value.childIdentity.processGroupId !== value.processGroup.processGroupId ||
		!workflowProcessGroupStableIdentityMatches(value.processGroup, value.currentProcessGroup) ||
		value.reservationDigest !== digestObject(unsigned)
	)
		throw new WorkflowDispatchError("workflow_child_process_unverified");
}

/**
 * Create the admission verifier from the host's canonical process-group containment seam.
 *
 * Args:
 * containment: Host-owned process-group verifier that independently re-reads process identity and liveness.
 * Return: A verifier that binds the host proof to the complete admission tuple.
 */
export function createHostAuthenticatedWorkflowAdmissionProcessVerifier(
	containment: WorkflowProcessContainmentVerifier,
	reservations: WorkflowAdmissionLaunchReservationReader,
): WorkflowAdmissionProcessVerifier {
	return createAdmissionProcessVerifierFromContainment(containment, reservations);
}

export interface WorkflowAdmissionBindingConsumptionInput {
	readonly workflowId: string;
	readonly admissionId: string;
	readonly bindingDigest: string;
	readonly expectedHead: WorkflowJournalHead;
	readonly nonce: string;
}

export interface WorkflowAdmissionBindingConsumption {
	consume(input: WorkflowAdmissionBindingConsumptionInput): Promise<"consumed" | "already_consumed">;
	assertConsumed(input: WorkflowAdmissionBindingConsumptionInput): Promise<void>;
}

export interface WorkflowAdmissionAuthorityVerificationInput {
	readonly context: WorkflowInternalAdmissionContext;
	readonly revisionBoundary: WorkflowRevisionBoundaryContext;
	readonly outcome?: WorkflowPhaseOutcomeRecord;
}

/** Optional authority ports used to re-check lease, effect, and outcome state at each boundary. */
export interface WorkflowAdmissionAuthorityVerifier {
	readonly assertLease?: (input: WorkflowAdmissionAuthorityVerificationInput) => Promise<void>;
	readonly assertEffect?: (input: WorkflowAdmissionAuthorityVerificationInput) => Promise<void>;
	readonly assertOutcome?: (input: WorkflowAdmissionAuthorityVerificationInput) => Promise<void>;
}

export interface WorkflowAdmissionReplayContextReader {
	readonly readAdmissionContext: (
		commit: WorkflowJournalCommit<WorkflowEventPayload>,
		payload: Extract<WorkflowEventPayload, { kind: "workflow_dispatch_intent" }>,
	) => Promise<WorkflowInternalAdmissionContext | null>;
}

export interface WorkflowAdmissionQuarantineEvidence {
	readonly workflowId: string;
	readonly taskId: string | null;
	readonly attemptId: string | null;
	readonly admissionId: string | null;
	readonly executionKey: string | null;
	readonly leaseRef: WorkflowLeaseRef;
	readonly epochRef: WorkflowEpochRef;
	readonly revisionBoundary: WorkflowRevisionBoundaryContext;
	readonly reason: string;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly evidenceDigest: string;
}

export interface WorkflowAdmissionReplayFold {
	readonly head: WorkflowJournalHead;
	readonly admissions: readonly WorkflowAdmissionResult[];
	readonly quarantine: readonly WorkflowAdmissionQuarantineEvidence[];
	readonly terminalDigests: ReadonlyMap<string, string>;
	readonly conflicts: readonly WorkflowAdmissionQuarantineEvidence[];
}

export interface WorkflowQuarantineRegistryReplayFold {
	readonly head: WorkflowJournalHead;
	readonly entries: readonly WorkflowAdmissionQuarantineEvidence[];
	readonly conflicts: readonly WorkflowAdmissionQuarantineEvidence[];
}

export interface WorkflowAdmissionRegistryDependencies extends WorkflowAdmissionRevisionReader {
	readonly store: WorkflowRuntimeStore;
	readonly epochs: WorkflowEpochManager;
	readonly bindingConsumption: WorkflowAdmissionBindingConsumption;
	readonly launchReservationReader: WorkflowAdmissionLaunchReservationReader;
	readonly processContainmentVerifier: WorkflowProcessContainmentVerifier;
	readonly callbackFenceStore?: WorkflowBindingReceiptStore;
	readonly authorityVerifier?: WorkflowAdmissionAuthorityVerifier;
	readonly leaseVerifier?: Pick<WorkflowAdmissionAuthorityVerifier, "assertLease">;
	readonly effectVerifier?: Pick<WorkflowAdmissionAuthorityVerifier, "assertEffect">;
	readonly outcomeVerifier?: Pick<WorkflowAdmissionAuthorityVerifier, "assertOutcome">;
	readonly replayContextReader?: WorkflowAdmissionReplayContextReader;
	readonly workflowRoot?: string;
	readonly writerIdentity: string;
}

export interface WorkflowAdmissionRegistry {
	admit(
		context: WorkflowInternalAdmissionContext,
		expectedHead?: WorkflowJournalHead,
	): Promise<WorkflowAdmissionResult>;
	bindChild(admissionId: string, binding: WorkflowChildProcessBinding): Promise<WorkflowAdmissionResult>;
	recordOutcome(
		admissionId: string,
		outcome: WorkflowPhaseOutcomeRecord,
		expectedStatusDigest: string,
	): Promise<WorkflowAdmissionResult>;
	recordOutcomeFrom(
		coordinator: WorkflowCoordinatorLease,
		admissionId: string,
		outcome: WorkflowPhaseOutcomeRecord,
		expectedStatusDigest: string,
	): Promise<WorkflowAdmissionResult>;
	lookupByExecutionKey(workflowId: string, executionKey: string): Promise<WorkflowAdmissionResult | undefined>;
	listByWorkflow(workflowId: string): Promise<readonly WorkflowAdmissionResult[]>;
	listDescendants(workflowId: string, rootAttemptId: string | null): Promise<readonly WorkflowAdmissionResult[]>;
	hydrateFromReplay(): Promise<void>;
	hydrateQuarantineFromReplay(): Promise<void>;
	listQuarantine(workflowId: string): Promise<readonly WorkflowAdmissionQuarantineEvidence[]>;
	quarantine(admissionId: string, reason: string): Promise<WorkflowAdmissionResult>;
}

interface AdmissionRecord extends WorkflowAdmissionResult {
	readonly hydratedPartial: boolean;
}

const TERMINAL_STATUSES: ReadonlySet<WorkflowAttemptStatus> = new Set([
	"completed",
	"needs_fix",
	"blocked",
	"failed",
	"cancelled",
	"quarantined",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function sameLease(left: WorkflowLeaseRef | null, right: WorkflowLeaseRef | null): boolean {
	return digestObject(left) === digestObject(right);
}

function assertEpoch(epochRef: WorkflowEpochRef): void {
	if (
		!Number.isSafeInteger(epochRef.storeEpoch) ||
		epochRef.storeEpoch <= 0 ||
		!Number.isSafeInteger(epochRef.coordinatorEpoch) ||
		epochRef.coordinatorEpoch <= 0
	)
		throw new WorkflowEpochError("workflow_epoch_invalid");
}

function assertLeaseRef(leaseRef: WorkflowLeaseRef, epochRef: WorkflowEpochRef): void {
	assertEpoch(leaseRef);
	if (
		!sameEpoch(leaseRef, epochRef) ||
		!isNonEmptyString(leaseRef.leaseId) ||
		!Number.isSafeInteger(leaseRef.acquisitionEventSequence) ||
		leaseRef.acquisitionEventSequence <= 0 ||
		!isNonEmptyString(leaseRef.processIdentity) ||
		!isNonEmptyString(leaseRef.rootDigest) ||
		!isNonEmptyString(leaseRef.writerIdentity) ||
		!isNonEmptyString(leaseRef.acquiredAt) ||
		!isNonEmptyString(leaseRef.expiresAt) ||
		!Number.isFinite(Date.parse(leaseRef.acquiredAt)) ||
		!Number.isFinite(Date.parse(leaseRef.expiresAt)) ||
		Date.parse(leaseRef.expiresAt) <= Date.parse(leaseRef.acquiredAt)
	)
		throw new WorkflowDispatchError("workflow_lease_ref_invalid");
}

function assertRevisionTuple(revisionTuple: WorkflowRevisionTuple): void {
	const values = [
		revisionTuple.contractRevision,
		revisionTuple.scorecardRevision,
		revisionTuple.planRevision,
		revisionTuple.configRevision,
		revisionTuple.evidenceRevision,
	];
	if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
		throw new WorkflowRevisionError("workflow_revision_tuple_invalid");
}

function assertArtifactRef(artifactRef: WorkflowArtifactRef): void {
	if (
		!isNonEmptyString(artifactRef.artifactId) ||
		!isNonEmptyString(artifactRef.relativePath) ||
		!isNonEmptyString(artifactRef.digest) ||
		!Number.isSafeInteger(artifactRef.sizeBytes) ||
		artifactRef.sizeBytes < 0 ||
		!Number.isSafeInteger(artifactRef.sourceEventSequence) ||
		artifactRef.sourceEventSequence <= 0
	)
		throw new WorkflowRevisionError("workflow_revision_registry_ref_invalid");
}

function assertControlCapacity(controlCapacity: WorkflowControlCapacityVector): void {
	const values = [
		controlCapacity.processSlots,
		controlCapacity.childSessionSlots,
		controlCapacity.modelCallSlots,
		controlCapacity.modelInputTokens,
		controlCapacity.modelOutputTokens,
		controlCapacity.verificationSlots,
		controlCapacity.redTeamSlots,
		controlCapacity.recoverySlots,
	];
	if (values.some((value) => !Number.isFinite(value) || value < 0))
		throw new WorkflowDispatchError("workflow_control_capacity_invalid");
}

function assertChildAuthority(childAuthority: WorkflowChildAuthority): void {
	if (
		!Array.isArray(childAuthority.capabilities) ||
		childAuthority.capabilities.length === 0 ||
		!childAuthority.capabilities.every(isNonEmptyString) ||
		(childAuthority.writeClass !== "read_only" && childAuthority.writeClass !== "write_capable") ||
		(childAuthority.parentAttemptId !== null && !isNonEmptyString(childAuthority.parentAttemptId)) ||
		typeof childAuthority.rootSpawned !== "boolean"
	)
		throw new WorkflowDispatchError("workflow_child_authority_invalid");
}

function assertContext(context: WorkflowInternalAdmissionContext): void {
	if (
		!isNonEmptyString(context.workflowId) ||
		!isNonEmptyString(context.rootSessionId) ||
		!isNonEmptyString(context.taskId) ||
		!isNonEmptyString(context.attemptId) ||
		!isNonEmptyString(context.executionKey) ||
		!isNonEmptyString(context.idempotencyKey) ||
		!isNonEmptyString(context.launchConfigDigest) ||
		!isNonEmptyString(context.runtimeVersion) ||
		!isNonEmptyString(context.hostCapabilityRevision) ||
		!isNonEmptyString(context.agentRole) ||
		!isNonEmptyString(context.modelId) ||
		!isNonEmptyString(context.reasoningEffort) ||
		!isNonEmptyString(context.expectedEffectDigest) ||
		!isNonEmptyString(context.configSnapshotDigest) ||
		!isNonEmptyString(context.revisionRegistryDigest) ||
		!isNonEmptyString(context.writerIdentity) ||
		context.decisionRef.storeEpoch !== context.epochRef.storeEpoch
	)
		throw new WorkflowDispatchError("workflow_admission_context_invalid");
	assertEpoch(context.epochRef);
	assertLeaseRef(context.resourceLeaseRef, context.epochRef);
	if (
		context.resourceLeaseRef.writerIdentity !== context.writerIdentity ||
		(context.ownershipLeaseRef !== null && context.ownershipLeaseRef.writerIdentity !== context.writerIdentity)
	)
		throw new WorkflowDispatchError("workflow_writer_identity_mismatch");
	if (context.ownershipLeaseRef !== null) assertLeaseRef(context.ownershipLeaseRef, context.epochRef);
	assertControlCapacity(context.controlCapacity);
	assertChildAuthority(context.childAuthority);
	assertRevisionTuple(context.revisionTuple);
	assertArtifactRef(context.revisionRegistryRef);
	const canonicalExecutionKey = deriveWorkflowExecutionKey(context);
	if (context.executionKey !== canonicalExecutionKey)
		throw new WorkflowDispatchError("workflow_noncanonical_execution_key");
	const canonicalIdempotencyKey = deriveAdmissionIdempotencyKey(context);
	if (context.idempotencyKey !== canonicalIdempotencyKey)
		throw new WorkflowDispatchError("workflow_noncanonical_idempotency_key");
}

function boundaryTupleDigest(boundary: WorkflowRevisionBoundaryContext): string {
	return digestObject({
		workflowId: boundary.workflowId,
		epochRef: boundary.epochRef,
		leaseRef: boundary.leaseRef,
		executionKey: boundary.executionKey,
		revisionTuple: boundary.revisionTuple,
		revisionRegistryRef: boundary.revisionRegistryRef,
		revisionRegistryDigest: boundary.revisionRegistryDigest,
		configSnapshotDigest: boundary.configSnapshotDigest,
	});
}

function assertBoundaryShape(
	boundary: WorkflowRevisionBoundaryContext,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	executionKey: string | null,
): void {
	if (
		boundary.workflowId !== workflowId ||
		!sameEpoch(boundary.epochRef, epochRef) ||
		boundary.executionKey !== executionKey ||
		boundary.tupleDigest !== boundaryTupleDigest(boundary)
	)
		throw new WorkflowRevisionError("workflow_revision_boundary_mismatch");
	assertLeaseRef(boundary.leaseRef, epochRef);
	assertRevisionTuple(boundary.revisionTuple);
	assertArtifactRef(boundary.revisionRegistryRef);
	if (!isNonEmptyString(boundary.revisionRegistryDigest) || !isNonEmptyString(boundary.configSnapshotDigest))
		throw new WorkflowRevisionError("workflow_revision_boundary_mismatch");
}

function revisionBoundaryForContext(context: WorkflowInternalAdmissionContext): WorkflowRevisionBoundaryContext {
	const unsigned = {
		workflowId: context.workflowId,
		epochRef: context.epochRef,
		leaseRef: context.resourceLeaseRef,
		executionKey: context.executionKey,
		revisionTuple: context.revisionTuple,
		revisionRegistryRef: context.revisionRegistryRef,
		revisionRegistryDigest: context.revisionRegistryDigest,
		configSnapshotDigest: context.configSnapshotDigest,
	};
	return { ...unsigned, tupleDigest: digestObject(unsigned) };
}

function assertBoundaryMatchesContext(
	boundary: WorkflowRevisionBoundaryContext,
	context: WorkflowInternalAdmissionContext,
): void {
	assertBoundaryShape(boundary, context.workflowId, context.epochRef, context.executionKey);
	if (
		digestObject(boundary.leaseRef) !== digestObject(context.resourceLeaseRef) ||
		digestObject(boundary.revisionTuple) !== digestObject(context.revisionTuple) ||
		digestObject(boundary.revisionRegistryRef) !== digestObject(context.revisionRegistryRef) ||
		boundary.revisionRegistryDigest !== context.revisionRegistryDigest ||
		boundary.configSnapshotDigest !== context.configSnapshotDigest
	)
		throw new WorkflowRevisionError("workflow_revision_boundary_mismatch");
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Uint8Array) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

function publicAdmission(record: AdmissionRecord): WorkflowAdmissionResult {
	return cloneAndFreeze({
		context: record.context,
		admissionId: record.admissionId,
		lifecycle: record.lifecycle,
		status: record.status,
		childIdentity: record.childIdentity,
		processBinding: record.processBinding,
		admissionEventSequence: record.admissionEventSequence,
		terminalEventSequence: record.terminalEventSequence,
		outcomeDigest: record.outcomeDigest,
	});
}

/** Verify the complete pinned revision boundary before a mutation. */
export async function assertRevisionBoundary(
	dependencies: WorkflowRevisionBoundaryReader,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	executionKey: string | null,
): Promise<WorkflowRevisionBoundaryContext> {
	const boundary = await assertDispatchRevisionBoundary(dependencies, workflowId, epochRef, executionKey);
	assertBoundaryShape(boundary, workflowId, epochRef, executionKey);
	return boundary;
}

/** Derive the stable attempt identity from immutable dispatch inputs. */
export function deriveWorkflowExecutionKey(input: {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly decisionRef: Pick<DurableDecisionRef, "decisionDigest">;
	readonly launchConfigDigest: string;
}): string {
	return deriveDispatchExecutionKey(
		input as Pick<
			WorkflowCanonicalDispatchInput,
			"workflowId" | "taskId" | "attemptId" | "decisionRef" | "launchConfigDigest"
		>,
	);
}

export function deriveAdmissionIdempotencyKey(
	context: Pick<WorkflowInternalAdmissionContext, "executionKey" | "epochRef">,
): string {
	return sha256Hex(
		[context.executionKey, String(context.epochRef.storeEpoch), String(context.epochRef.coordinatorEpoch)]
			.join(":")
			.toString(),
	);
}

function isWorkflowLeaseRef(value: unknown): value is WorkflowLeaseRef {
	if (!isRecord(value)) return false;
	return (
		Number.isSafeInteger(value.storeEpoch) &&
		Number.isSafeInteger(value.coordinatorEpoch) &&
		isNonEmptyString(value.leaseId) &&
		Number.isSafeInteger(value.acquisitionEventSequence) &&
		isNonEmptyString(value.processIdentity) &&
		isNonEmptyString(value.rootDigest) &&
		isNonEmptyString(value.writerIdentity) &&
		isNonEmptyString(value.acquiredAt) &&
		isNonEmptyString(value.expiresAt)
	);
}

/** Return an already complete K lease reference; never synthesize one from a lease ID. */
export function leaseRefOf(value: WorkflowResourceLease | WorkflowLeaseRef): WorkflowLeaseRef {
	if (isWorkflowLeaseRef(value)) return value;
	void value;
	throw new WorkflowDispatchError("workflow_lease_ref_unavailable");
}

function leaseRefFromInput(
	value: WorkflowResourceLease | WorkflowLeaseRef,
	supplied: WorkflowLeaseRef | undefined,
): WorkflowLeaseRef {
	if (supplied !== undefined) return supplied;
	void value;
	throw new WorkflowDispatchError("workflow_lease_ref_unavailable");
}

function ownershipLeaseRefOf(value: WorkflowOwnershipLease | WorkflowLeaseRef): WorkflowLeaseRef {
	if (isWorkflowLeaseRef(value)) return value;
	throw new WorkflowDispatchError("workflow_lease_ref_unavailable");
}

/** Convert the canonical dispatcher input into the immutable admission context. */
export function toAdmissionContext(input: WorkflowCanonicalDispatchInput): WorkflowInternalAdmissionContext {
	const extras = input as WorkflowCanonicalDispatchInput & {
		readonly resourceLeaseRef?: WorkflowLeaseRef;
		readonly ownershipLeaseRef?: WorkflowLeaseRef | null;
		readonly controlCapacity?: WorkflowControlCapacityVector;
	};
	const resourceLeaseRef = leaseRefFromInput(input.resourceLease, extras.resourceLeaseRef);
	const ownershipLeaseRef =
		input.ownershipLease === null
			? (extras.ownershipLeaseRef ?? null)
			: (extras.ownershipLeaseRef ?? ownershipLeaseRefOf(input.ownershipLease));
	const resourceLease = input.resourceLease as Partial<WorkflowResourceLease>;
	if (
		(resourceLease.workflowId !== undefined && resourceLease.workflowId !== input.workflowId) ||
		(resourceLease.taskId !== undefined && resourceLease.taskId !== input.taskId) ||
		(resourceLease.attemptId !== undefined && resourceLease.attemptId !== input.attemptId) ||
		(resourceLease.storeEpoch !== undefined && resourceLease.storeEpoch !== input.epochRef.storeEpoch) ||
		(resourceLease.coordinatorEpoch !== undefined &&
			resourceLease.coordinatorEpoch !== input.epochRef.coordinatorEpoch)
	)
		throw new WorkflowDispatchError("workflow_control_capacity_binding_mismatch");
	const executionKey = deriveWorkflowExecutionKey(input);
	if (input.executionKey !== executionKey) throw new WorkflowDispatchError("workflow_noncanonical_execution_key");
	const context: WorkflowInternalAdmissionContext = {
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		taskId: input.taskId,
		attemptId: input.attemptId,
		executionKey,
		idempotencyKey: deriveAdmissionIdempotencyKey({ executionKey, epochRef: input.epochRef }),
		decisionRef: input.decisionRef,
		resourceLeaseRef,
		controlCapacity: extras.controlCapacity ?? resourceLease.controlCapacity ?? zeroControlCapacity(),
		ownershipLeaseRef,
		childAuthority: input.childAuthority,
		launchConfigDigest: input.launchConfigDigest,
		runtimeVersion: input.runtimeVersion,
		hostCapabilityRevision: input.hostCapabilityRevision,
		agentRole: input.agentRole,
		modelId: input.modelId,
		reasoningEffort: input.reasoningLevel,
		expectedEffectDigest: input.expectedEffectDigest,
		epochRef: input.epochRef,
		configSnapshotDigest: input.configSnapshotDigest,
		revisionTuple: input.revisionTuple,
		revisionRegistryRef: input.revisionRegistryRef,
		revisionRegistryDigest: input.revisionRegistryDigest,
		writerIdentity: input.writerIdentity,
	};
	assertContext(context);
	return context;
}

function zeroControlCapacity(): WorkflowControlCapacityVector {
	return {
		processSlots: 0,
		childSessionSlots: 0,
		modelCallSlots: 0,
		modelInputTokens: 0,
		modelOutputTokens: 0,
		verificationSlots: 0,
		redTeamSlots: 0,
		recoverySlots: 0,
	};
}

export function canonicalWorkflowIdentityDigest(
	identity: Omit<WorkflowChildIdentity, "identityDigest"> | WorkflowChildIdentity,
): string {
	const { identityDigest: _identityDigest, ...withoutDigest } = identity as WorkflowChildIdentity;
	return digestObject(withoutDigest);
}

export function canonicalWorkflowProcessGroupDigest(
	processGroup: Omit<WorkflowProcessGroupIdentity, "identityDigest"> | WorkflowProcessGroupIdentity,
): string {
	const { identityDigest: _identityDigest, ...withoutDigest } = processGroup as WorkflowProcessGroupIdentity;
	return digestObject(withoutDigest);
}

export function canonicalWorkflowBindingDigest(
	binding: Pick<WorkflowChildProcessBinding, "childIdentity" | "processGroup">,
): string {
	return digestObject({ childIdentity: binding.childIdentity, processGroup: binding.processGroup });
}

export function deriveWorkflowAdmissionBindingNonce(
	input: Pick<
		WorkflowAdmissionProcessVerificationInput,
		"workflowId" | "admissionId" | "epochRef" | "head" | "binding"
	>,
): string {
	return digestObject({
		workflowId: input.workflowId,
		admissionId: input.admissionId,
		epochRef: input.epochRef,
		head: input.head,
		bindingDigest: canonicalWorkflowBindingDigest(input.binding),
	});
}

interface WorkflowAdmissionBindingConsumptionRecord {
	readonly version: 1;
	readonly workflowId: string;
	readonly admissionId: string;
	readonly bindingDigest: string;
	readonly expectedHead: WorkflowJournalHead;
	readonly nonce: string;
}

function workflowAdmissionBindingConsumptionName(nonce: string): string {
	return `admission-binding-${sha256Hex(nonce).slice(0, 48)}`;
}

function isWorkflowAdmissionBindingConsumptionRecord(
	value: unknown,
): value is WorkflowAdmissionBindingConsumptionRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const expectedHead = record.expectedHead;
	if (!isRecord(expectedHead)) return false;
	const sequence = expectedHead.sequence;
	const eventDigest = expectedHead.eventDigest;
	const epochRef = expectedHead.epochRef;
	return (
		Object.keys(record).sort().join(",") === "admissionId,bindingDigest,expectedHead,nonce,version,workflowId" &&
		record.version === 1 &&
		isNonEmptyString(record.workflowId) &&
		isNonEmptyString(record.admissionId) &&
		isNonEmptyString(record.bindingDigest) &&
		isNonEmptyString(record.nonce) &&
		isNonEmptyString(expectedHead.workflowId) &&
		typeof sequence === "number" &&
		Number.isSafeInteger(sequence) &&
		sequence >= 0 &&
		(eventDigest === null || isNonEmptyString(eventDigest)) &&
		isEpochValue(epochRef)
	);
}

export function createWorkflowAdmissionBindingConsumption(
	store: WorkflowRuntimeStore,
): WorkflowAdmissionBindingConsumption {
	const durable = store.durableContext;
	if (durable === undefined) throw new WorkflowDispatchError("workflow_admission_consumption_unavailable");
	const read = async (
		input: WorkflowAdmissionBindingConsumptionInput,
	): Promise<WorkflowAdmissionBindingConsumptionRecord | null> => {
		const bytes = await durable.auxiliaryStore.read(workflowAdmissionBindingConsumptionName(input.nonce));
		if (bytes === null) return null;
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!isWorkflowAdmissionBindingConsumptionRecord(parsed))
			throw new WorkflowDispatchError("workflow_admission_consumption_corrupt");
		return parsed;
	};
	const assertMatches = (
		record: WorkflowAdmissionBindingConsumptionRecord,
		input: WorkflowAdmissionBindingConsumptionInput,
	): void => {
		if (
			record.workflowId !== input.workflowId ||
			record.admissionId !== input.admissionId ||
			record.bindingDigest !== input.bindingDigest ||
			record.nonce !== input.nonce ||
			digestObject(record.expectedHead) !== digestObject(input.expectedHead)
		)
			throw new WorkflowDispatchError("workflow_admission_consumption_conflict");
	};
	const write = async (input: WorkflowAdmissionBindingConsumptionInput): Promise<void> => {
		const record: WorkflowAdmissionBindingConsumptionRecord = {
			version: 1,
			workflowId: input.workflowId,
			admissionId: input.admissionId,
			bindingDigest: input.bindingDigest,
			expectedHead: input.expectedHead,
			nonce: input.nonce,
		};
		await durable.auxiliaryStore.write(
			workflowAdmissionBindingConsumptionName(input.nonce),
			canonicalJsonBytes(record),
		);
	};
	return {
		consume: async (input) =>
			durable.withExclusiveLease(`workflow-admission-binding:${input.nonce}`, async () => {
				const current = await read(input);
				if (current !== null) {
					assertMatches(current, input);
					return "already_consumed";
				}
				await write(input);
				return "consumed";
			}),
		assertConsumed: async (input) =>
			durable.withExclusiveLease(`workflow-admission-binding-read:${input.nonce}`, async () => {
				const current = await read(input);
				if (current === null) throw new WorkflowDispatchError("workflow_admission_replay_invalid");
				assertMatches(current, input);
			}),
	};
}

/** Validate the complete child identity and its separately observed process identity. */
export function assertWorkflowChildBinding(
	input: {
		readonly workflowId?: string;
		readonly taskId?: string;
		readonly attemptId?: string;
		readonly admissionId?: string;
		readonly executionKey: string;
		readonly epochRef: WorkflowEpochRef;
		readonly launchConfigDigest?: string;
		readonly runtimeVersion?: string;
		readonly hostCapabilityRevision?: string;
		readonly agentRole?: string;
		readonly modelId?: string;
		readonly reasoningEffort?: string;
		readonly approvedIdentity?: Partial<WorkflowChildIdentity>;
	},
	binding: WorkflowChildProcessBinding,
): void {
	const identity = binding.childIdentity;
	const processGroup = binding.processGroup;
	if (
		!Number.isSafeInteger(processGroup.pid) ||
		processGroup.pid <= 0 ||
		!isNonEmptyString(processGroup.processStartId) ||
		!isNonEmptyString(processGroup.processGroupId)
	)
		throw new WorkflowDispatchError("workflow_child_identity_unavailable");
	if (
		(input.workflowId !== undefined && binding.workflowId !== input.workflowId) ||
		(input.taskId !== undefined && binding.taskId !== input.taskId) ||
		(input.attemptId !== undefined && binding.attemptId !== input.attemptId) ||
		(input.admissionId !== undefined && identity.admissionId !== input.admissionId) ||
		identity.executionKey !== input.executionKey ||
		!sameEpoch(identity.epochRef, input.epochRef) ||
		(input.launchConfigDigest !== undefined && identity.launchConfigDigest !== input.launchConfigDigest) ||
		(input.runtimeVersion !== undefined && identity.runtimeVersion !== input.runtimeVersion) ||
		(input.hostCapabilityRevision !== undefined &&
			identity.hostCapabilityRevision !== input.hostCapabilityRevision) ||
		(input.agentRole !== undefined && identity.agentRole !== input.agentRole) ||
		(input.modelId !== undefined && identity.modelId !== input.modelId) ||
		(input.reasoningEffort !== undefined && identity.reasoningEffort !== input.reasoningEffort) ||
		identity.processGroupId !== processGroup.processGroupId ||
		!isNonEmptyString(identity.admissionId) ||
		!isNonEmptyString(identity.childSessionId) ||
		!isNonEmptyString(identity.executionKey) ||
		!isNonEmptyString(identity.runtimeVersion) ||
		!isNonEmptyString(identity.hostCapabilityRevision) ||
		!isNonEmptyString(identity.agentRole) ||
		!isNonEmptyString(identity.modelId) ||
		!isNonEmptyString(identity.reasoningEffort) ||
		!isNonEmptyString(identity.launchConfigDigest) ||
		identity.identityDigest !== canonicalWorkflowIdentityDigest(identity) ||
		processGroup.identityDigest !== canonicalWorkflowProcessGroupDigest(processGroup) ||
		binding.bindingDigest !== canonicalWorkflowBindingDigest(binding)
	)
		throw new WorkflowDispatchError("workflow_child_binding_invalid");
	const approved = input.approvedIdentity;
	if (
		approved !== undefined &&
		((approved.admissionId !== undefined && identity.admissionId !== approved.admissionId) ||
			(approved.childSessionId !== undefined && identity.childSessionId !== approved.childSessionId) ||
			(approved.runtimeVersion !== undefined && identity.runtimeVersion !== approved.runtimeVersion) ||
			(approved.hostCapabilityRevision !== undefined &&
				identity.hostCapabilityRevision !== approved.hostCapabilityRevision) ||
			(approved.agentRole !== undefined && identity.agentRole !== approved.agentRole) ||
			(approved.modelId !== undefined && identity.modelId !== approved.modelId) ||
			(approved.reasoningEffort !== undefined && identity.reasoningEffort !== approved.reasoningEffort) ||
			(approved.launchConfigDigest !== undefined && identity.launchConfigDigest !== approved.launchConfigDigest))
	)
		throw new WorkflowDispatchError("workflow_child_binding_invalid");
}

async function assertWorkflowChildProcessProof(
	dependencies: WorkflowAdmissionRegistryDependencies,
	context: WorkflowInternalAdmissionContext,
	binding: WorkflowChildProcessBinding,
	head: WorkflowJournalHead,
): Promise<void> {
	const verifier = createHostAuthenticatedWorkflowAdmissionProcessVerifier(
		dependencies.processContainmentVerifier,
		dependencies.launchReservationReader,
	);
	await assertWorkflowChildProcessProofWithVerifier(verifier, context, binding, head);
}

async function assertWorkflowChildProcessProofWithVerifier(
	verifier: WorkflowAdmissionProcessVerifier,
	context: WorkflowInternalAdmissionContext,
	binding: WorkflowChildProcessBinding,
	head: WorkflowJournalHead,
): Promise<void> {
	if (binding.processGroup.pid === process.pid) throw new WorkflowDispatchError("same_process_child_session");
	let currentHost: Awaited<ReturnType<WorkflowAdmissionProcessVerifier["readCurrentHostIdentity"]>>;
	try {
		currentHost = await verifier.readCurrentHostIdentity();
	} catch {
		throw new WorkflowDispatchError("workflow_child_process_unverified");
	}
	if (
		!Number.isSafeInteger(currentHost.pid) ||
		currentHost.pid <= 0 ||
		!isNonEmptyString(currentHost.processStartId) ||
		!isNonEmptyString(currentHost.processGroupId) ||
		binding.processGroup.pid === currentHost.pid ||
		binding.processGroup.processStartId === currentHost.processStartId ||
		binding.processGroup.processGroupId === currentHost.processGroupId
	)
		throw new WorkflowDispatchError("same_process_child_session");
	const admissionId = `admission:${context.executionKey}`;
	const nonce = deriveWorkflowAdmissionBindingNonce({
		workflowId: context.workflowId,
		admissionId,
		epochRef: context.epochRef,
		head,
		binding,
	});
	const verificationInput: WorkflowAdmissionProcessVerificationInput = {
		workflowId: context.workflowId,
		rootSessionId: context.rootSessionId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		admissionId,
		executionKey: context.executionKey,
		nonce,
		epochRef: context.epochRef,
		head,
		launchConfigDigest: context.launchConfigDigest,
		runtimeVersion: context.runtimeVersion,
		hostCapabilityRevision: context.hostCapabilityRevision,
		agentRole: context.agentRole,
		modelId: context.modelId,
		reasoningEffort: context.reasoningEffort,
		expectedEffectDigest: context.expectedEffectDigest,
		configSnapshotDigest: context.configSnapshotDigest,
		revisionTuple: context.revisionTuple,
		revisionRegistryRef: context.revisionRegistryRef,
		revisionRegistryDigest: context.revisionRegistryDigest,
		binding,
	};
	let observation: WorkflowAdmissionProcessIdentityObservation;
	try {
		observation = await verifier.readCurrentChildIdentity(verificationInput);
	} catch {
		throw new WorkflowDispatchError("workflow_child_process_unverified");
	}
	if (
		!isRecord(observation) ||
		!exactKeys(observation, [
			"hostAuthenticated",
			"liveness",
			"workflowId",
			"taskId",
			"attemptId",
			"admissionId",
			"executionKey",
			"nonce",
			"epochRef",
			"head",
			"pid",
			"processStartId",
			"processGroupId",
			"parentPid",
		])
	)
		throw new WorkflowDispatchError("workflow_child_process_unverified");
	const verifiedObservation = observation as unknown as WorkflowAdmissionProcessIdentityObservation;
	if (
		verifiedObservation.hostAuthenticated !== true ||
		verifiedObservation.liveness !== "live" ||
		verifiedObservation.workflowId !== context.workflowId ||
		verifiedObservation.taskId !== context.taskId ||
		verifiedObservation.attemptId !== context.attemptId ||
		verifiedObservation.admissionId !== admissionId ||
		verifiedObservation.executionKey !== context.executionKey ||
		verifiedObservation.nonce !== nonce ||
		!isEpochValue(verifiedObservation.epochRef) ||
		!sameEpoch(verifiedObservation.epochRef, context.epochRef) ||
		digestObject(verifiedObservation.head) !== digestObject(head) ||
		verifiedObservation.pid !== binding.processGroup.pid ||
		verifiedObservation.processStartId !== binding.processGroup.processStartId ||
		verifiedObservation.processGroupId !== binding.processGroup.processGroupId ||
		!Number.isSafeInteger(verifiedObservation.parentPid) ||
		verifiedObservation.parentPid !== process.pid
	)
		throw new WorkflowDispatchError("workflow_child_process_unverified");
	let proof: WorkflowAdmissionProcessVerificationResult;
	try {
		proof = await verifier.verify(verificationInput, verifiedObservation);
	} catch {
		throw new WorkflowDispatchError("workflow_child_process_unverified");
	}
	if (
		!isRecord(proof) ||
		!exactKeys(proof, [
			"verified",
			"hostAuthenticated",
			"liveness",
			"workflowId",
			"taskId",
			"attemptId",
			"admissionId",
			"executionKey",
			"nonce",
			"epochRef",
			"head",
			"pid",
			"processStartId",
			"processGroupId",
			"parentPid",
			"proofDigest",
		])
	)
		throw new WorkflowDispatchError("workflow_child_process_unverified");
	const verifiedProof = proof as unknown as WorkflowAdmissionProcessVerificationResult;
	const { proofDigest: _proofDigest, ...proofWithoutDigest } = verifiedProof;
	if (
		verifiedProof.verified !== true ||
		verifiedProof.hostAuthenticated !== true ||
		verifiedProof.liveness !== "live" ||
		verifiedProof.workflowId !== context.workflowId ||
		verifiedProof.taskId !== context.taskId ||
		verifiedProof.attemptId !== context.attemptId ||
		verifiedProof.admissionId !== admissionId ||
		verifiedProof.executionKey !== context.executionKey ||
		verifiedProof.nonce !== nonce ||
		!isEpochValue(verifiedProof.epochRef) ||
		!sameEpoch(verifiedProof.epochRef, context.epochRef) ||
		digestObject(verifiedProof.head) !== digestObject(head) ||
		verifiedProof.pid !== binding.processGroup.pid ||
		verifiedProof.processStartId !== binding.processGroup.processStartId ||
		verifiedProof.processGroupId !== binding.processGroup.processGroupId ||
		!Number.isSafeInteger(verifiedProof.parentPid) ||
		verifiedProof.parentPid !== process.pid ||
		verifiedProof.parentPid !== verifiedObservation.parentPid ||
		verifiedProof.hostAuthenticated !== verifiedObservation.hostAuthenticated ||
		verifiedProof.liveness !== verifiedObservation.liveness ||
		digestObject(proofWithoutDigest) !== digestObject({ ...verifiedObservation, verified: true }) ||
		!isNonEmptyString(verifiedProof.proofDigest) ||
		verifiedProof.proofDigest !== digestObject(proofWithoutDigest)
	)
		throw new WorkflowDispatchError("workflow_child_process_unverified");
}

function replayConflictEvidence(
	_activeLease: WorkflowActiveLeaseContext,
	admission: AdmissionRecord,
	reason: string,
): WorkflowAdmissionQuarantineEvidence {
	const base = {
		workflowId: admission.context.workflowId,
		taskId: admission.context.taskId,
		attemptId: admission.context.attemptId,
		admissionId: admission.admissionId,
		executionKey: admission.context.executionKey,
		leaseRef: admission.context.resourceLeaseRef,
		epochRef: admission.context.epochRef,
		revisionBoundary: revisionBoundaryForContext(admission.context),
		reason,
		evidenceRefs: [] as readonly WorkflowArtifactRef[],
	};
	return { ...base, evidenceDigest: digestObject(base) };
}

function replayQuarantineEvidence(
	activeLease: WorkflowActiveLeaseContext,
	admission: AdmissionRecord | undefined,
	commit: WorkflowJournalCommit<WorkflowEventPayload>,
	payload: Extract<WorkflowEventPayload, { kind: "workflow_lease_quarantined" }>,
): WorkflowAdmissionQuarantineEvidence {
	const base = {
		workflowId: payload.workflowId,
		taskId: admission?.context.taskId ?? null,
		attemptId: admission?.context.attemptId ?? null,
		admissionId: admission?.admissionId ?? null,
		executionKey: admission?.context.executionKey ?? commit.executionKey,
		leaseRef: payload.leaseRef,
		epochRef: payload.epochRef,
		revisionBoundary:
			admission === undefined ? activeLease.revisionBoundary : revisionBoundaryForContext(admission.context),
		reason: payload.reason,
		evidenceRefs: [] as readonly WorkflowArtifactRef[],
	};
	const suffix = payload.reason.slice(payload.reason.lastIndexOf(":") + 1);
	return { ...base, evidenceDigest: /^[0-9a-f]{64}$/u.test(suffix) ? suffix : digestObject(base) };
}

function foldQuarantineEvidence(
	commit: WorkflowJournalCommit<WorkflowEventPayload>,
	payload: Extract<WorkflowEventPayload, { kind: "workflow_lease_quarantined" }>,
): WorkflowAdmissionQuarantineEvidence {
	const revisionRegistryRef: WorkflowArtifactRef = {
		artifactId: `replay-revision:${commit.sequence}`,
		relativePath: `replay/revision-${commit.sequence}`,
		digest: digestObject({ commit: commit.sequence, leaseRef: payload.leaseRef }),
		sizeBytes: 0,
		sourceEventSequence: commit.sequence,
	};
	const boundaryBase = {
		workflowId: payload.workflowId,
		epochRef: payload.epochRef,
		leaseRef: payload.leaseRef,
		executionKey: commit.executionKey,
		revisionTuple: {
			contractRevision: 0,
			scorecardRevision: 0,
			planRevision: 0,
			configRevision: 0,
			evidenceRevision: 0,
		},
		revisionRegistryRef,
		revisionRegistryDigest: "replay-revision",
		configSnapshotDigest: "replay-config",
	};
	const base = {
		workflowId: payload.workflowId,
		taskId: null,
		attemptId: null,
		admissionId: null,
		executionKey: commit.executionKey,
		leaseRef: payload.leaseRef,
		epochRef: payload.epochRef,
		revisionBoundary: { ...boundaryBase, tupleDigest: digestObject(boundaryBase) },
		reason: payload.reason,
		evidenceRefs: [] as readonly WorkflowArtifactRef[],
	};
	const suffix = payload.reason.slice(payload.reason.lastIndexOf(":") + 1);
	return { ...base, evidenceDigest: /^[0-9a-f]{64}$/u.test(suffix) ? suffix : digestObject(base) };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const observed = Object.keys(value).sort();
	const expected = [...keys].sort();
	return observed.length === expected.length && observed.every((key, index) => key === expected[index]);
}

function isEpochValue(value: unknown): value is WorkflowEpochRef {
	if (!isRecord(value)) return false;
	return (
		typeof value.storeEpoch === "number" &&
		Number.isSafeInteger(value.storeEpoch) &&
		value.storeEpoch > 0 &&
		typeof value.coordinatorEpoch === "number" &&
		Number.isSafeInteger(value.coordinatorEpoch) &&
		value.coordinatorEpoch > 0
	);
}

function isWorkflowJournalHeadValue(value: unknown): value is WorkflowJournalHead {
	if (!isRecord(value) || !exactKeys(value, ["workflowId", "sequence", "eventDigest", "epochRef"])) return false;
	return (
		isNonEmptyString(value.workflowId) &&
		typeof value.sequence === "number" &&
		Number.isSafeInteger(value.sequence) &&
		value.sequence >= 0 &&
		(value.eventDigest === null || isNonEmptyString(value.eventDigest)) &&
		isEpochValue(value.epochRef)
	);
}

function isArtifactRefArray(value: unknown): value is readonly WorkflowArtifactRef[] {
	return (
		Array.isArray(value) &&
		value.every(
			(ref) =>
				isRecord(ref) &&
				isNonEmptyString(ref.artifactId) &&
				isNonEmptyString(ref.relativePath) &&
				isNonEmptyString(ref.digest) &&
				typeof ref.sizeBytes === "number" &&
				Number.isSafeInteger(ref.sizeBytes) &&
				ref.sizeBytes >= 0 &&
				typeof ref.sourceEventSequence === "number" &&
				Number.isSafeInteger(ref.sourceEventSequence) &&
				ref.sourceEventSequence > 0,
		)
	);
}

function isWorkflowBlockerClaim(value: unknown): value is WorkflowBlockerClaim {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"dependencyId",
			"conditionDigest",
			"requiredChange",
			"registeredAlternativeSetDigest",
			"alternativeResults",
			"evidenceRefs",
		]) ||
		!isNonEmptyString(value.dependencyId) ||
		!isNonEmptyString(value.conditionDigest) ||
		!isNonEmptyString(value.requiredChange) ||
		!isNonEmptyString(value.registeredAlternativeSetDigest) ||
		!Array.isArray(value.alternativeResults) ||
		!isArtifactRefArray(value.evidenceRefs)
	)
		return false;
	return value.alternativeResults.every(
		(result) =>
			isRecord(result) &&
			exactKeys(result, [
				"alternativeId",
				"strategyDigest",
				"disposition",
				"attemptedStateDigest",
				"evidenceRefs",
			]) &&
			isNonEmptyString(result.alternativeId) &&
			isNonEmptyString(result.strategyDigest) &&
			(result.disposition === "failed_with_evidence" ||
				result.disposition === "unsafe" ||
				result.disposition === "outside_authority" ||
				result.disposition === "external_state_unavailable") &&
			isNonEmptyString(result.attemptedStateDigest) &&
			isArtifactRefArray(result.evidenceRefs),
	);
}

/** Validate K's closed phase-outcome record without widening its discriminated union. */
export function isWorkflowPhaseOutcomeRecord(value: unknown): value is WorkflowPhaseOutcomeRecord {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["outcome", "attemptStatus"]) ||
		!isNonEmptyString(value.attemptStatus) ||
		!isRecord(value.outcome)
	)
		return false;
	if (!["completed", "cancelled", "failed", "blocked", "interrupted"].includes(value.attemptStatus)) return false;
	const outcome = value.outcome;
	if (
		!isEpochValue(outcome.epochRef) ||
		!isNonEmptyString(outcome.workflowId) ||
		!isNonEmptyString(outcome.phaseAttemptId) ||
		!isNonEmptyString(outcome.invocationToken) ||
		!isNonEmptyString(outcome.inputStateDigest) ||
		!isNonEmptyString(outcome.status)
	)
		return false;
	if (outcome.status === "complete")
		return (
			exactKeys(outcome, [
				"workflowId",
				"phaseAttemptId",
				"epochRef",
				"invocationToken",
				"inputStateDigest",
				"status",
				"outputStateDigest",
				"artifactRefs",
				"evidenceRefs",
			]) &&
			isNonEmptyString(outcome.outputStateDigest) &&
			isArtifactRefArray(outcome.artifactRefs) &&
			isArtifactRefArray(outcome.evidenceRefs)
		);
	if (outcome.status === "pause")
		return (
			exactKeys(outcome, [
				"workflowId",
				"phaseAttemptId",
				"epochRef",
				"invocationToken",
				"inputStateDigest",
				"status",
				"approvalRequestId",
				"artifactRefs",
				"evidenceRefs",
			]) &&
			isNonEmptyString(outcome.approvalRequestId) &&
			isArtifactRefArray(outcome.artifactRefs) &&
			isArtifactRefArray(outcome.evidenceRefs)
		);
	if (outcome.status === "blocked")
		return (
			exactKeys(outcome, [
				"workflowId",
				"phaseAttemptId",
				"epochRef",
				"invocationToken",
				"inputStateDigest",
				"status",
				"blockerClaim",
			]) && isWorkflowBlockerClaim(outcome.blockerClaim)
		);
	if (outcome.status === "failed")
		return (
			exactKeys(outcome, [
				"workflowId",
				"phaseAttemptId",
				"epochRef",
				"invocationToken",
				"inputStateDigest",
				"status",
				"errorCode",
				"retryable",
				"artifactRefs",
				"evidenceRefs",
			]) &&
			isNonEmptyString(outcome.errorCode) &&
			typeof outcome.retryable === "boolean" &&
			isArtifactRefArray(outcome.artifactRefs) &&
			isArtifactRefArray(outcome.evidenceRefs)
		);
	return false;
}

export function digestWorkflowOutcome(outcome: WorkflowPhaseOutcomeRecord): string {
	return digestObject(outcome);
}

/** Verify every attempt, lease, epoch, revision, and digest field of a worker outcome. */
export function assertWorkflowOutcomeAdmissionBinding(
	binding: WorkflowOutcomeAdmissionBinding,
	context: WorkflowInternalAdmissionContext,
	outcome: WorkflowPhaseOutcomeRecord,
): void {
	if (!isWorkflowPhaseOutcomeRecord(outcome)) throw new WorkflowDispatchError("workflow_child_outcome_invalid");
	const nested = outcome.outcome;
	const revisionBoundary = binding.revisionBoundary;
	if (
		binding.workflowId !== context.workflowId ||
		binding.phaseAttemptId !== context.attemptId ||
		binding.attemptId !== context.attemptId ||
		binding.executionKey !== context.executionKey ||
		binding.invocationToken !== context.executionKey ||
		nested.workflowId !== context.workflowId ||
		nested.phaseAttemptId !== context.attemptId ||
		nested.invocationToken !== context.executionKey ||
		nested.inputStateDigest !== context.expectedEffectDigest ||
		!sameEpoch(binding.epochRef, context.epochRef) ||
		!sameEpoch(nested.epochRef, context.epochRef) ||
		!sameLease(binding.resourceLeaseRef, context.resourceLeaseRef) ||
		!sameLease(binding.ownershipLeaseRef, context.ownershipLeaseRef) ||
		revisionBoundary.workflowId !== context.workflowId ||
		revisionBoundary.executionKey !== context.executionKey ||
		!sameEpoch(revisionBoundary.epochRef, context.epochRef) ||
		!sameLease(revisionBoundary.leaseRef, context.resourceLeaseRef) ||
		digestObject(revisionBoundary.revisionTuple) !== digestObject(context.revisionTuple) ||
		digestObject(revisionBoundary.revisionRegistryRef) !== digestObject(context.revisionRegistryRef) ||
		revisionBoundary.revisionRegistryDigest !== context.revisionRegistryDigest ||
		revisionBoundary.configSnapshotDigest !== context.configSnapshotDigest ||
		binding.outcomeDigest !== digestWorkflowOutcome(outcome) ||
		binding.rootSessionId !== context.rootSessionId ||
		binding.configSnapshotDigest !== context.configSnapshotDigest ||
		binding.expectedEffectDigest !== context.expectedEffectDigest
	)
		throw new WorkflowDispatchError("workflow_outcome_boundary_mismatch");
	assertBoundaryShape(revisionBoundary, context.workflowId, context.epochRef, context.executionKey);
}

function createDispatchIntent(
	context: WorkflowInternalAdmissionContext,
): Extract<WorkflowEventPayload, { kind: "workflow_dispatch_intent" }> {
	return {
		kind: "workflow_dispatch_intent",
		workflowId: context.workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		admissionId: `admission:${context.executionKey}`,
		epochRef: context.epochRef,
		decisionRef: context.decisionRef,
		resourceLeaseRef: context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
		childAuthority: context.childAuthority,
		launchConfigDigest: context.launchConfigDigest,
		expectedEffectDigest: context.expectedEffectDigest,
	};
}

export interface WorkflowAuthenticatedCommitInput<TPayload extends WorkflowEventPayload> {
	readonly workflowId: string;
	readonly payload: TPayload;
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly idempotencyKey: string;
	readonly writerIdentity: string;
	readonly executionKey: string | null;
}

function assertAuthenticatedCommitResult<TPayload extends WorkflowEventPayload>(
	input: WorkflowAuthenticatedCommitInput<TPayload>,
	result: WorkflowStoreCommitResult<TPayload>,
	semanticBinding: WorkflowSemanticMutationBinding,
): void {
	const commit = result.commit;
	if (
		(result.status !== "committed" && result.status !== "already_committed") ||
		digestObject(result.payload) !== digestObject(input.payload) ||
		commit.workflowId !== input.workflowId ||
		digestObject(commit.payload) !== digestObject(input.payload) ||
		commit.payloadDigest !== digestObject(input.payload) ||
		digestObject(commit.expectedHead) !== digestObject(input.expectedHead) ||
		digestObject(commit.epochRef) !== digestObject(input.epochRef) ||
		digestObject(commit.leaseRef) !== digestObject(input.leaseRef) ||
		commit.idempotencyKey !== input.idempotencyKey ||
		commit.writerIdentity !== input.writerIdentity ||
		commit.executionKey !== input.executionKey ||
		digestObject(commit.semanticBinding) !== digestObject(semanticBinding) ||
		result.head.workflowId !== input.workflowId ||
		!sameEpoch(result.head.epochRef, input.epochRef) ||
		result.head.sequence < commit.sequence ||
		(result.head.sequence === commit.sequence && result.head.eventDigest !== commit.eventDigest)
	)
		throw new WorkflowDispatchError("workflow_authenticated_commit_result_mismatch");
}

/** The only store-commit spelling used by admission; it supplies the complete K tuple. */
export async function commitAuthenticated<TPayload extends WorkflowEventPayload>(
	store: WorkflowRuntimeStore,
	input: WorkflowAuthenticatedCommitInput<TPayload>,
): Promise<WorkflowStoreCommitResult<TPayload>> {
	if (
		input.expectedHead.workflowId !== input.workflowId ||
		!sameEpoch(input.expectedHead.epochRef, input.epochRef) ||
		!sameEpoch(input.leaseRef, input.epochRef) ||
		!isNonEmptyString(input.idempotencyKey) ||
		!isNonEmptyString(input.writerIdentity)
	)
		throw new WorkflowDispatchError("workflow_authenticated_commit_binding_mismatch");
	const baselineDigest = digestObject(input.expectedHead);
	const semanticBinding: WorkflowSemanticMutationBinding = {
		mutationId: input.idempotencyKey,
		baselineDigest,
		expectedGenerations: { workflow: input.expectedHead.epochRef.storeEpoch },
		ownerId: input.writerIdentity,
		phase: input.payload.kind === "workflow_child_outcome_committed" ? "executing" : "dispatching",
		reducerDigest: digestObject(input.payload),
		semanticHead: {
			workflowId: input.workflowId,
			sequence: input.expectedHead.sequence,
			eventDigest: input.expectedHead.eventDigest,
			stateDigest: baselineDigest,
			epochRef: input.expectedHead.epochRef,
			generation: input.expectedHead.epochRef.storeEpoch,
		},
		expectedHead: input.expectedHead,
		idempotencyKey: input.idempotencyKey,
		executionKey: input.executionKey,
		writerIdentity: input.writerIdentity,
		leaseRef: input.leaseRef,
		epochRef: input.epochRef,
	};
	const result = await store.commit({
		workflowId: input.workflowId,
		payload: input.payload,
		expectedHead: input.expectedHead,
		semanticBinding,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		idempotencyKey: input.idempotencyKey,
		writerIdentity: input.writerIdentity,
		executionKey: input.executionKey,
	});
	assertAuthenticatedCommitResult(input, result, semanticBinding);
	return result;
}

function statusDigest(result: WorkflowAdmissionResult, sequence: number, extra: unknown): string {
	return digestObject({ prior: result.lifecycle.statusDigest, sequence, extra });
}

function resultForIntent(
	context: WorkflowInternalAdmissionContext,
	sequence: number,
	hydratedPartial = false,
): AdmissionRecord {
	const stableContext = cloneAndFreeze(context);
	const lifecycle: WorkflowAttemptLifecycle = {
		workflowId: stableContext.workflowId,
		taskId: stableContext.taskId,
		attemptId: stableContext.attemptId,
		status: "admitted",
		childIdentity: null,
		childAuthority: stableContext.childAuthority,
		admissionEventSequence: sequence,
		terminalEventSequence: null,
		epochRef: stableContext.epochRef,
		statusDigest: digestObject({ context: stableContext, sequence }),
	};
	return {
		context: stableContext,
		admissionId: `admission:${stableContext.executionKey}`,
		lifecycle,
		status: lifecycle.status,
		childIdentity: null,
		processBinding: null,
		admissionEventSequence: sequence,
		terminalEventSequence: null,
		outcomeDigest: null,
		hydratedPartial,
	};
}

function outcomeStatusAllowed(outcome: WorkflowPhaseOutcomeRecord): boolean {
	if (outcome.outcome.status === "complete")
		return outcome.attemptStatus === "completed" || outcome.attemptStatus === "cancelled";
	if (outcome.outcome.status === "failed")
		return outcome.attemptStatus === "failed" || outcome.attemptStatus === "cancelled";
	if (outcome.outcome.status === "blocked")
		return outcome.attemptStatus === "blocked" || outcome.attemptStatus === "cancelled";
	return outcome.attemptStatus === "interrupted";
}

function buildBindingExpectation(
	admission: WorkflowAdmissionResult,
	revisionBoundary: WorkflowRevisionBoundaryContext,
): WorkflowBindingAcknowledgementExpectation {
	if (admission.processBinding === null) throw new WorkflowDispatchError("workflow_callback_binding_missing");
	const identityDigest = canonicalWorkflowIdentityDigest(admission.processBinding.childIdentity);
	const bindingDigest = admission.processBinding.bindingDigest;
	const processGroupId = admission.processBinding.processGroup.processGroupId;
	return {
		workflowId: admission.context.workflowId,
		attemptId: admission.context.attemptId,
		executionKey: admission.context.executionKey,
		epochRef: admission.context.epochRef,
		resourceLeaseRef: admission.context.resourceLeaseRef,
		ownershipLeaseRef: admission.context.ownershipLeaseRef,
		revisionBoundary,
		identityDigest,
		bindingDigest,
		processGroupId,
		rootSessionId: admission.context.rootSessionId,
		configSnapshotDigest: admission.context.configSnapshotDigest,
		expectedEffectDigest: admission.context.expectedEffectDigest,
		nonce: digestObject({
			workflowId: admission.context.workflowId,
			attemptId: admission.context.attemptId,
			executionKey: admission.context.executionKey,
			resourceLeaseRef: admission.context.resourceLeaseRef,
			ownershipLeaseRef: admission.context.ownershipLeaseRef,
			revisionBoundary,
			identityDigest,
			bindingDigest,
			processGroupId,
			rootSessionId: admission.context.rootSessionId,
			configSnapshotDigest: admission.context.configSnapshotDigest,
			expectedEffectDigest: admission.context.expectedEffectDigest,
		}),
	};
}

async function assertCallbackTokenActive(
	store: WorkflowBindingReceiptStore | undefined,
	expectation: WorkflowBindingAcknowledgementExpectation,
): Promise<void> {
	if (store === undefined) throw new WorkflowDispatchError("workflow_callback_binding_unavailable");
	if (store.assertActive !== undefined) {
		await store.assertActive(expectation);
		return;
	}
	if (store.assertCurrent !== undefined) {
		await store.assertCurrent(expectation);
		return;
	}
	throw new WorkflowDispatchError("workflow_callback_binding_unavailable");
}

async function assertLeaseAuthority(
	dependencies: WorkflowAdmissionRegistryDependencies,
	input: WorkflowAdmissionAuthorityVerificationInput,
): Promise<void> {
	await dependencies.authorityVerifier?.assertLease?.(input);
	await dependencies.leaseVerifier?.assertLease?.(input);
}

async function assertEffectAuthority(
	dependencies: WorkflowAdmissionRegistryDependencies,
	input: WorkflowAdmissionAuthorityVerificationInput,
): Promise<void> {
	await dependencies.authorityVerifier?.assertEffect?.(input);
	await dependencies.effectVerifier?.assertEffect?.(input);
}

async function assertOutcomeAuthority(
	dependencies: WorkflowAdmissionRegistryDependencies,
	input: WorkflowAdmissionAuthorityVerificationInput,
): Promise<void> {
	await dependencies.authorityVerifier?.assertOutcome?.(input);
	await dependencies.outcomeVerifier?.assertOutcome?.(input);
}

function assertDispatchIntentMatchesContext(
	commit: WorkflowJournalCommit<WorkflowEventPayload>,
	payload: Extract<WorkflowEventPayload, { kind: "workflow_dispatch_intent" }>,
	context: WorkflowInternalAdmissionContext,
): void {
	assertContext(context);
	if (
		commit.workflowId !== context.workflowId ||
		commit.writerIdentity !== context.writerIdentity ||
		commit.idempotencyKey !== context.idempotencyKey ||
		commit.executionKey !== context.executionKey ||
		digestObject(commit.epochRef) !== digestObject(context.epochRef) ||
		payload.workflowId !== context.workflowId ||
		payload.taskId !== context.taskId ||
		payload.attemptId !== context.attemptId ||
		payload.executionKey !== context.executionKey ||
		payload.admissionId !== `admission:${context.executionKey}` ||
		digestObject(payload.epochRef) !== digestObject(context.epochRef) ||
		digestObject(payload.decisionRef) !== digestObject(context.decisionRef) ||
		digestObject(payload.resourceLeaseRef) !== digestObject(context.resourceLeaseRef) ||
		digestObject(payload.ownershipLeaseRef) !== digestObject(context.ownershipLeaseRef) ||
		digestObject(payload.childAuthority) !== digestObject(context.childAuthority) ||
		payload.launchConfigDigest !== context.launchConfigDigest ||
		payload.expectedEffectDigest !== context.expectedEffectDigest
	)
		throw new WorkflowDispatchError("workflow_admission_replay_invalid");
}

function assertReplayCommitEnvelope(commit: WorkflowJournalCommit<WorkflowEventPayload>): void {
	if (
		!isNonEmptyString(commit.workflowId) ||
		!Number.isSafeInteger(commit.sequence) ||
		commit.sequence <= 0 ||
		commit.payloadDigest !== digestObject(commit.payload) ||
		commit.commitReturnProof === undefined ||
		commit.recordVersion !== 1 ||
		!isNonEmptyString(commit.writerIdentity) ||
		!isNonEmptyString(commit.idempotencyKey) ||
		!isNonEmptyString(commit.generationId) ||
		!isNonEmptyString(commit.eventDigest)
	)
		throw new WorkflowDispatchError("workflow_admission_replay_invalid");
}

function hydratedContextFromIntent(
	_commit: WorkflowJournalCommit<WorkflowEventPayload>,
	_payload: Extract<WorkflowEventPayload, { kind: "workflow_dispatch_intent" }>,
): null {
	return null;
}

function recordForCommit(
	commit: WorkflowJournalCommit<WorkflowEventPayload>,
	current: AdmissionRecord | undefined,
): AdmissionRecord | undefined {
	const payload = commit.payload;
	if (payload.kind === "workflow_dispatch_intent") {
		if (payload.workflowId !== commit.workflowId) return undefined;
		const context = hydratedContextFromIntent(commit, payload);
		return context === null ? undefined : resultForIntent(context, commit.sequence);
	}
	if (current === undefined) return undefined;
	if (payload.kind === "workflow_child_identity_bound") {
		if (
			payload.workflowId !== current.context.workflowId ||
			payload.attemptId !== current.context.attemptId ||
			payload.admissionId !== current.admissionId ||
			!sameEpoch(payload.epochRef, current.context.epochRef) ||
			current.terminalEventSequence !== null ||
			TERMINAL_STATUSES.has(current.status) ||
			digestObject(payload.identity) !== digestObject(payload.processBinding.childIdentity)
		)
			return undefined;
		const nextLifecycle: WorkflowAttemptLifecycle = {
			...current.lifecycle,
			status: "running",
			childIdentity: cloneAndFreeze(payload.identity),
			statusDigest: digestObject({ binding: payload.processBinding, sequence: commit.sequence }),
		};
		const stableBinding = cloneAndFreeze(payload.processBinding);
		return {
			...current,
			lifecycle: nextLifecycle,
			status: nextLifecycle.status,
			childIdentity: stableBinding.childIdentity,
			processBinding: stableBinding,
		};
	}
	if (payload.kind === "workflow_child_outcome_committed") {
		if (
			payload.workflowId !== current.context.workflowId ||
			payload.attemptId !== current.context.attemptId ||
			payload.executionKey !== current.context.executionKey ||
			!sameEpoch(payload.epochRef, current.context.epochRef) ||
			payload.outcomeDigest !== digestWorkflowOutcome(payload.outcome) ||
			current.terminalEventSequence !== null ||
			TERMINAL_STATUSES.has(current.status)
		)
			return undefined;
		const nextLifecycle: WorkflowAttemptLifecycle = {
			...current.lifecycle,
			status: payload.outcome.attemptStatus,
			terminalEventSequence: commit.sequence,
			statusDigest: digestObject({ outcomeDigest: payload.outcomeDigest, sequence: commit.sequence }),
		};
		return {
			...current,
			lifecycle: nextLifecycle,
			status: nextLifecycle.status,
			terminalEventSequence: commit.sequence,
			outcomeDigest: payload.outcomeDigest,
		};
	}
	return current;
}

function replayHead(commits: readonly WorkflowJournalCommit<WorkflowEventPayload>[]): WorkflowJournalHead {
	const last = commits.at(-1);
	if (last !== undefined) {
		return {
			workflowId: last.workflowId,
			sequence: last.sequence,
			eventDigest: last.eventDigest,
			epochRef: last.epochRef,
		};
	}
	return {
		workflowId: "",
		sequence: 0,
		eventDigest: null,
		epochRef: { storeEpoch: 0, coordinatorEpoch: 0 },
	};
}

/** Fold the K admission events into a replayable attempt index. */
export function foldWorkflowAdmissionCommits(
	commits: readonly WorkflowJournalCommit<WorkflowEventPayload>[],
): WorkflowAdmissionReplayFold {
	const records = new Map<string, AdmissionRecord>();
	const terminalDigests = new Map<string, string>();
	const conflicts: WorkflowAdmissionQuarantineEvidence[] = [];
	for (const commit of commits) {
		if (commit.payload.kind === "workflow_lease_quarantined") {
			const quarantinePayload = commit.payload;
			const evidence = foldQuarantineEvidence(commit, quarantinePayload);
			conflicts.push(evidence);
			const current = [...records.values()].find(
				(record) =>
					record.context.workflowId === quarantinePayload.workflowId &&
					digestObject(record.context.resourceLeaseRef) === digestObject(quarantinePayload.leaseRef),
			);
			if (current !== undefined && current.terminalEventSequence === null && current.status !== "quarantined") {
				const nextLifecycle: WorkflowAttemptLifecycle = {
					...current.lifecycle,
					status: "quarantined",
					statusDigest: digestObject({ prior: current.lifecycle.statusDigest, reason: quarantinePayload.reason }),
				};
				records.set(current.admissionId, {
					...current,
					lifecycle: nextLifecycle,
					status: "quarantined",
				});
			}
			continue;
		}
		if (!isAdmissionPayload(commit.payload)) continue;
		const payload = commit.payload;
		if (payload.kind === "workflow_dispatch_intent") {
			if (hydratedContextFromIntent(commit, payload) === null) continue;
			const existing = [...records.values()].find((record) => record.context.executionKey === payload.executionKey);
			if (existing !== undefined) continue;
			const result = recordForCommit(commit, undefined);
			if (result !== undefined) records.set(result.admissionId, result);
			continue;
		}
		const admissionId =
			payload.kind === "workflow_child_identity_bound"
				? payload.admissionId
				: [...records.values()].find((record) => record.context.attemptId === payload.attemptId)?.admissionId;
		if (admissionId === undefined) continue;
		const current = records.get(admissionId);
		const result = recordForCommit(commit, current);
		if (result !== undefined) {
			records.set(admissionId, result);
			if (payload.kind === "workflow_child_outcome_committed")
				terminalDigests.set(admissionId, payload.outcomeDigest);
		}
	}
	return {
		head: replayHead(commits),
		admissions: [...records.values()],
		quarantine: [],
		terminalDigests,
		conflicts,
	};
}

export function foldWorkflowQuarantineRegistryCommits(
	commits: readonly WorkflowJournalCommit<WorkflowEventPayload>[],
): WorkflowQuarantineRegistryReplayFold {
	const entries: WorkflowAdmissionQuarantineEvidence[] = [];
	for (const commit of commits) {
		if (commit.payload.kind !== "workflow_lease_quarantined") continue;
		const evidence = foldQuarantineEvidence(commit, commit.payload);
		if (!entries.some((entry) => entry.evidenceDigest === evidence.evidenceDigest)) entries.push(evidence);
	}
	return { head: replayHead(commits), entries, conflicts: [] };
}

export async function hydrateAdmissionFromReplay(input: {
	readonly commits: readonly WorkflowJournalCommit<WorkflowEventPayload>[];
	readonly activeLease: WorkflowActiveLeaseContext;
	readonly contextReader?: WorkflowAdmissionReplayContextReader;
	readonly launchReservationReader: WorkflowAdmissionLaunchReservationReader;
	readonly processContainmentVerifier: WorkflowProcessContainmentVerifier;
	readonly bindingConsumption: WorkflowAdmissionBindingConsumption;
	readonly persistQuarantine: (
		evidence: WorkflowAdmissionQuarantineEvidence,
		activeLease: WorkflowActiveLeaseContext,
	) => Promise<void>;
}): Promise<WorkflowAdmissionReplayFold> {
	const processVerifier = createHostAuthenticatedWorkflowAdmissionProcessVerifier(
		input.processContainmentVerifier,
		input.launchReservationReader,
	);
	const records = new Map<string, AdmissionRecord>();
	const quarantine: WorkflowAdmissionQuarantineEvidence[] = [];
	const terminalDigests = new Map<string, string>();
	const conflicts: WorkflowAdmissionQuarantineEvidence[] = [];
	for (const commit of input.commits) {
		assertReplayCommitEnvelope(commit);
		const payload = commit.payload;
		if (payload.kind === "workflow_dispatch_intent") {
			if (input.contextReader === undefined)
				throw new WorkflowDispatchError("workflow_admission_replay_context_unavailable");
			const context = await input.contextReader.readAdmissionContext(commit, payload);
			if (context === null) throw new WorkflowDispatchError("workflow_admission_replay_context_unavailable");
			assertDispatchIntentMatchesContext(commit, payload, context);
			const result = resultForIntent(context, commit.sequence);
			const prior = [...records.values()].find((record) => record.context.executionKey === context.executionKey);
			if (prior !== undefined && digestObject(prior.context) !== digestObject(context)) {
				const evidence = replayConflictEvidence(input.activeLease, prior, "workflow_admission_replay_conflict");
				conflicts.push(evidence);
				continue;
			}
			records.set(result.admissionId, result);
			continue;
		}
		if (payload.kind === "workflow_child_identity_bound") {
			const current = records.get(payload.admissionId);
			if (current === undefined) throw new WorkflowDispatchError("workflow_admission_replay_invalid");
			if (current.terminalEventSequence !== null || TERMINAL_STATUSES.has(current.status))
				throw new WorkflowDispatchError("workflow_admission_replay_invalid");
			if (current.processBinding !== null) throw new WorkflowDispatchError("workflow_admission_replay_invalid");
			if (
				payload.workflowId !== current.context.workflowId ||
				payload.attemptId !== current.context.attemptId ||
				!sameEpoch(payload.epochRef, current.context.epochRef)
			)
				throw new WorkflowDispatchError("workflow_admission_replay_invalid");
			if (digestObject(payload.identity) !== digestObject(payload.processBinding.childIdentity))
				throw new WorkflowDispatchError("workflow_admission_replay_invalid");
			assertWorkflowChildBinding(
				{
					workflowId: current.context.workflowId,
					taskId: current.context.taskId,
					attemptId: current.context.attemptId,
					admissionId: current.admissionId,
					executionKey: current.context.executionKey,
					epochRef: current.context.epochRef,
					launchConfigDigest: current.context.launchConfigDigest,
					runtimeVersion: current.context.runtimeVersion,
					hostCapabilityRevision: current.context.hostCapabilityRevision,
					agentRole: current.context.agentRole,
					modelId: current.context.modelId,
					reasoningEffort: current.context.reasoningEffort,
				},
				payload.processBinding,
			);
			const expectedHead = commit.expectedHead;
			const bindingConsumptionInput: WorkflowAdmissionBindingConsumptionInput = {
				workflowId: current.context.workflowId,
				admissionId: current.admissionId,
				bindingDigest: canonicalWorkflowBindingDigest(payload.processBinding),
				expectedHead,
				nonce: deriveWorkflowAdmissionBindingNonce({
					workflowId: current.context.workflowId,
					admissionId: current.admissionId,
					epochRef: current.context.epochRef,
					head: expectedHead,
					binding: payload.processBinding,
				}),
			};
			await input.bindingConsumption.assertConsumed(bindingConsumptionInput);
			await assertWorkflowChildProcessProofWithVerifier(
				processVerifier,
				current.context,
				payload.processBinding,
				commit.expectedHead,
			);
			const next = recordForCommit(commit, current);
			if (next === undefined) throw new WorkflowDispatchError("workflow_admission_replay_invalid");
			records.set(next.admissionId, next);
			continue;
		}
		if (payload.kind === "workflow_child_outcome_committed") {
			const current = [...records.values()].find(
				(record) =>
					record.context.attemptId === payload.attemptId && record.context.workflowId === payload.workflowId,
			);
			if (current === undefined || current.processBinding === null)
				throw new WorkflowDispatchError("workflow_admission_replay_invalid");
			if (current.terminalEventSequence !== null || TERMINAL_STATUSES.has(current.status))
				throw new WorkflowDispatchError("workflow_admission_replay_invalid");
			const revisionBoundary = revisionBoundaryForContext(current.context);
			const outcomeDigest = digestWorkflowOutcome(payload.outcome);
			if (
				payload.executionKey !== current.context.executionKey ||
				!sameEpoch(payload.epochRef, current.context.epochRef) ||
				payload.outcomeDigest !== outcomeDigest ||
				!outcomeStatusAllowed(payload.outcome)
			)
				throw new WorkflowDispatchError("workflow_admission_replay_invalid");
			assertWorkflowOutcomeAdmissionBinding(
				{
					workflowId: current.context.workflowId,
					phaseAttemptId: payload.outcome.outcome.phaseAttemptId,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					invocationToken: payload.outcome.outcome.invocationToken,
					epochRef: current.context.epochRef,
					resourceLeaseRef: current.context.resourceLeaseRef,
					ownershipLeaseRef: current.context.ownershipLeaseRef,
					revisionBoundary,
					outcomeDigest,
					rootSessionId: current.context.rootSessionId,
					configSnapshotDigest: current.context.configSnapshotDigest,
					expectedEffectDigest: current.context.expectedEffectDigest,
				},
				current.context,
				payload.outcome,
			);
			const next = recordForCommit(commit, current);
			if (next === undefined) throw new WorkflowDispatchError("workflow_admission_replay_invalid");
			records.set(next.admissionId, next);
			terminalDigests.set(next.admissionId, outcomeDigest);
			continue;
		}
		if (payload.kind === "workflow_lease_quarantined") {
			const current = [...records.values()].find(
				(record) =>
					record.context.workflowId === payload.workflowId &&
					digestObject(record.context.resourceLeaseRef) === digestObject(payload.leaseRef),
			);
			const evidence = replayQuarantineEvidence(input.activeLease, current, commit, payload);
			if (!quarantine.some((entry) => entry.evidenceDigest === evidence.evidenceDigest)) quarantine.push(evidence);
			if (current !== undefined && current.terminalEventSequence === null && current.status !== "quarantined") {
				const nextLifecycle: WorkflowAttemptLifecycle = {
					...current.lifecycle,
					status: "quarantined",
					statusDigest: digestObject({ prior: current.lifecycle.statusDigest, reason: payload.reason }),
				};
				records.set(current.admissionId, {
					...current,
					lifecycle: nextLifecycle,
					status: "quarantined",
				});
			}
		}
	}
	for (const conflict of conflicts) await input.persistQuarantine(conflict, input.activeLease);
	return {
		head: replayHead(input.commits),
		admissions: [...records.values()].map(publicAdmission),
		quarantine: quarantine.map(cloneAndFreeze),
		terminalDigests,
		conflicts: conflicts.map(cloneAndFreeze),
	};
}

export async function hydrateQuarantineRegistryFromReplay(input: {
	readonly commits: readonly WorkflowJournalCommit<WorkflowEventPayload>[];
	readonly activeLease: WorkflowActiveLeaseContext;
	readonly persistQuarantine: (
		evidence: WorkflowAdmissionQuarantineEvidence,
		activeLease: WorkflowActiveLeaseContext,
	) => Promise<void>;
}): Promise<WorkflowQuarantineRegistryReplayFold> {
	const fold = foldWorkflowQuarantineRegistryCommits(input.commits);
	for (const conflict of fold.conflicts) await input.persistQuarantine(conflict, input.activeLease);
	return fold;
}

function isAdmissionPayload(
	payload: WorkflowEventPayload,
): payload is Extract<
	WorkflowEventPayload,
	{ kind: "workflow_dispatch_intent" | "workflow_child_identity_bound" | "workflow_child_outcome_committed" }
> {
	return (
		payload.kind === "workflow_dispatch_intent" ||
		payload.kind === "workflow_child_identity_bound" ||
		payload.kind === "workflow_child_outcome_committed"
	);
}

function replayEpochFromDependencies(
	dependencies: WorkflowAdmissionRegistryDependencies,
	workflowId: string,
): Promise<WorkflowEpochRef> {
	if (dependencies.readActiveLeaseContext !== undefined)
		return dependencies.readActiveLeaseContext().then((active) => active.epochRef);
	if (dependencies.activeLease !== undefined) return Promise.resolve(dependencies.activeLease.epochRef);
	if (dependencies.readCurrentEpoch !== undefined) return dependencies.readCurrentEpoch(workflowId);
	return Promise.reject(new WorkflowEpochError("workflow_active_epoch_unavailable"));
}

async function readActiveLeaseContext(
	dependencies: WorkflowAdmissionRegistryDependencies,
	workflowId: string,
	epochRef: WorkflowEpochRef,
): Promise<WorkflowActiveLeaseContext> {
	if (dependencies.readActiveLeaseContext !== undefined) return dependencies.readActiveLeaseContext();
	if (dependencies.activeLease !== undefined) return dependencies.activeLease;
	const revisionBoundary = await dependencies.readRevisionBoundaryContext(workflowId, epochRef, null);
	return {
		workflowId,
		epochRef,
		leaseRef: revisionBoundary.leaseRef,
		writerIdentity: dependencies.writerIdentity,
		generationId: "replay",
		revisionBoundary,
	};
}

async function persistReplayQuarantine(
	dependencies: WorkflowAdmissionRegistryDependencies,
	evidence: WorkflowAdmissionQuarantineEvidence,
	activeLease: WorkflowActiveLeaseContext,
): Promise<void> {
	if (activeLease.workflowId !== evidence.workflowId)
		throw new WorkflowEpochError("workflow_quarantine_active_lease_mismatch");
	const replay = await dependencies.store.replay({
		workflowId: evidence.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: activeLease.epochRef.storeEpoch,
	});
	if (replay.quarantined) throw new WorkflowEpochError("workflow_store_replay_quarantined");
	const payload: Extract<WorkflowEventPayload, { kind: "workflow_lease_quarantined" }> = {
		kind: "workflow_lease_quarantined",
		workflowId: evidence.workflowId,
		leaseRef: evidence.leaseRef,
		epochRef: evidence.epochRef,
		reason: `${evidence.reason}:${evidence.evidenceDigest}`,
	};
	await commitAuthenticated(dependencies.store, {
		workflowId: evidence.workflowId,
		payload,
		expectedHead: replay.head,
		epochRef: activeLease.epochRef,
		leaseRef: activeLease.leaseRef,
		idempotencyKey: `admission-quarantine:${evidence.evidenceDigest}`,
		writerIdentity: activeLease.writerIdentity,
		executionKey: evidence.executionKey,
	});
}

export function createWorkflowAdmissionRegistry(
	dependencies: WorkflowAdmissionRegistryDependencies,
): WorkflowAdmissionRegistry {
	const records = new Map<string, AdmissionRecord>();
	const quarantineEntries: WorkflowAdmissionQuarantineEvidence[] = [];
	let admissionHydrated = false;
	let quarantineHydrated = false;
	let mutationQueue: Promise<unknown> = Promise.resolve();

	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = mutationQueue.then(operation, operation);
		mutationQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
	const assertHydrated = (): void => {
		if (!admissionHydrated || !quarantineHydrated)
			throw new WorkflowDispatchError("workflow_admission_replay_required");
	};
	const recordForAdmission = (admissionId: string): AdmissionRecord => {
		const record = records.get(admissionId);
		if (record === undefined) throw new WorkflowDispatchError("workflow_admission_not_found");
		return record;
	};
	const readHead = async (workflowId: string, epochRef: WorkflowEpochRef): Promise<WorkflowJournalHead> => {
		const replay = await dependencies.store.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: epochRef.storeEpoch,
		});
		if (replay.quarantined) throw new WorkflowEpochError("workflow_store_replay_quarantined");
		if (replay.head.workflowId !== workflowId || !sameEpoch(replay.head.epochRef, epochRef))
			throw new WorkflowEpochError("workflow_epoch_stale");
		return replay.head;
	};
	const append = async <
		TPayload extends Extract<
			WorkflowEventPayload,
			{
				kind:
					| "workflow_dispatch_intent"
					| "workflow_child_identity_bound"
					| "workflow_child_outcome_committed"
					| "workflow_lease_quarantined";
			}
		>,
	>(
		workflowId: string,
		payload: TPayload,
		epochRef: WorkflowEpochRef,
		idempotencyKey: string,
		executionKey: string | null,
		_leaseRef: WorkflowLeaseRef,
		revisionBoundary?: WorkflowRevisionBoundaryContext,
		expectedHead?: WorkflowJournalHead,
	): Promise<WorkflowStoreCommitResult<TPayload>> => {
		const assertedBoundary = await assertRevisionBoundary(dependencies, workflowId, epochRef, executionKey);
		if (revisionBoundary !== undefined && digestObject(assertedBoundary) !== digestObject(revisionBoundary))
			throw new WorkflowRevisionError("workflow_revision_boundary_changed");
		await dependencies.epochs.assertCurrent(workflowId, epochRef);
		const currentHead = await readHead(workflowId, epochRef);
		if (expectedHead !== undefined && digestObject(currentHead) !== digestObject(expectedHead))
			throw new WorkflowDispatchError("workflow_admission_head_stale");
		const commitHead = expectedHead ?? currentHead;
		const activeLease = await readActiveLeaseContext(dependencies, workflowId, epochRef);
		if (
			activeLease.workflowId !== workflowId ||
			!sameEpoch(activeLease.epochRef, epochRef) ||
			activeLease.writerIdentity !== dependencies.writerIdentity ||
			!sameEpoch(activeLease.leaseRef, epochRef)
		)
			throw new WorkflowEpochError("workflow_active_lease_context_invalid");
		return commitAuthenticated(dependencies.store, {
			workflowId,
			payload,
			expectedHead: commitHead,
			epochRef,
			// The projected lease refs remain in the event payload; the journal
			// commit itself must be authorized by the current root append lease.
			leaseRef: activeLease.leaseRef,
			idempotencyKey,
			writerIdentity: dependencies.writerIdentity,
			executionKey,
		});
	};

	const quarantineInternal = async (admission: AdmissionRecord, reason: string): Promise<AdmissionRecord> => {
		if (admission.status === "quarantined") return admission;
		if (admission.terminalEventSequence !== null || TERMINAL_STATUSES.has(admission.status))
			throw new WorkflowDispatchError("workflow_terminal_quarantine_forbidden");
		const revisionBoundary = await assertRevisionBoundary(
			dependencies,
			admission.context.workflowId,
			admission.context.epochRef,
			admission.context.executionKey,
		);
		assertBoundaryMatchesContext(revisionBoundary, admission.context);
		await assertLeaseAuthority(dependencies, { context: admission.context, revisionBoundary });
		await dependencies.epochs.assertCurrent(admission.context.workflowId, admission.context.epochRef);
		const evidenceBase = {
			workflowId: admission.context.workflowId,
			taskId: admission.context.taskId,
			attemptId: admission.context.attemptId,
			admissionId: admission.admissionId,
			executionKey: admission.context.executionKey,
			leaseRef: admission.context.resourceLeaseRef,
			epochRef: admission.context.epochRef,
			revisionBoundary,
			reason,
			evidenceRefs: [] as readonly WorkflowArtifactRef[],
		};
		const evidence: WorkflowAdmissionQuarantineEvidence = {
			...evidenceBase,
			evidenceDigest: digestObject(evidenceBase),
		};
		if (!quarantineEntries.some((entry) => entry.evidenceDigest === evidence.evidenceDigest))
			quarantineEntries.push(evidence);
		const committed = await append(
			admission.context.workflowId,
			{
				kind: "workflow_lease_quarantined",
				workflowId: admission.context.workflowId,
				leaseRef: admission.context.resourceLeaseRef,
				epochRef: admission.context.epochRef,
				reason: `${reason}:${evidence.evidenceDigest}`,
			},
			admission.context.epochRef,
			`admission-quarantine:${evidence.evidenceDigest}`,
			admission.context.executionKey,
			admission.context.resourceLeaseRef,
			revisionBoundary,
		);
		const nextLifecycle: WorkflowAttemptLifecycle = {
			...admission.lifecycle,
			status: "quarantined",
			statusDigest: statusDigest(admission, committed.commit.sequence, reason),
		};
		const next: AdmissionRecord = { ...admission, lifecycle: nextLifecycle, status: nextLifecycle.status };
		records.set(admission.admissionId, next);
		return next;
	};

	const admit = async (
		context: WorkflowInternalAdmissionContext,
		expectedHead?: WorkflowJournalHead,
	): Promise<WorkflowAdmissionResult> =>
		enqueue(async () => {
			assertHydrated();
			assertContext(context);
			if (context.writerIdentity !== dependencies.writerIdentity)
				throw new WorkflowDispatchError("workflow_writer_identity_mismatch");
			const prior = [...records.values()].find(
				(candidate) => candidate.context.executionKey === context.executionKey,
			);
			if (prior !== undefined) {
				if (digestObject(prior.context) !== digestObject(context)) {
					if (prior.terminalEventSequence === null && prior.status !== "quarantined")
						await quarantineInternal(prior, "workflow_admission_conflict");
					throw new WorkflowDispatchError("workflow_admission_conflict");
				}
				return publicAdmission(prior);
			}
			const revisionBoundary = await assertRevisionBoundary(
				dependencies,
				context.workflowId,
				context.epochRef,
				context.executionKey,
			);
			assertBoundaryMatchesContext(revisionBoundary, context);
			await assertLeaseAuthority(dependencies, { context, revisionBoundary });
			await dependencies.epochs.assertCurrent(context.workflowId, context.epochRef);
			const payload = createDispatchIntent(context);
			const committed = await append(
				context.workflowId,
				payload,
				context.epochRef,
				context.idempotencyKey,
				context.executionKey,
				context.resourceLeaseRef,
				revisionBoundary,
				expectedHead,
			);
			const result = resultForIntent(context, committed.commit.sequence);
			records.set(result.admissionId, result);
			return publicAdmission(result);
		});

	const bindChild = async (
		admissionId: string,
		binding: WorkflowChildProcessBinding,
	): Promise<WorkflowAdmissionResult> =>
		enqueue(async () => {
			assertHydrated();
			const current = recordForAdmission(admissionId);
			if (current.terminalEventSequence !== null || TERMINAL_STATUSES.has(current.status))
				throw new WorkflowDispatchError("workflow_attempt_transition_invalid");
			if (!sameEpoch(binding.childIdentity.epochRef, current.context.epochRef))
				throw new WorkflowEpochError("workflow_epoch_stale");
			const expectedHead = await readHead(current.context.workflowId, current.context.epochRef);
			try {
				assertWorkflowChildBinding(
					{
						workflowId: current.context.workflowId,
						taskId: current.context.taskId,
						attemptId: current.context.attemptId,
						admissionId,
						executionKey: current.context.executionKey,
						epochRef: current.context.epochRef,
						launchConfigDigest: current.context.launchConfigDigest,
						runtimeVersion: current.context.runtimeVersion,
						hostCapabilityRevision: current.context.hostCapabilityRevision,
						agentRole: current.context.agentRole,
						modelId: current.context.modelId,
						reasoningEffort: current.context.reasoningEffort,
					},
					binding,
				);
				await assertWorkflowChildProcessProof(dependencies, current.context, binding, expectedHead);
			} catch (error) {
				if (error instanceof WorkflowDispatchError && error.code === "workflow_child_identity_unavailable") {
					await quarantineInternal(current, error.code);
				}
				throw error;
			}
			if (current.processBinding !== null) {
				if (canonicalWorkflowBindingDigest(current.processBinding) === canonicalWorkflowBindingDigest(binding))
					return publicAdmission(current);
				if (current.terminalEventSequence === null && current.status !== "quarantined")
					await quarantineInternal(current, "workflow_child_identity_conflict");
				throw new WorkflowDispatchError("workflow_child_identity_conflict");
			}
			const bindingConsumptionInput: WorkflowAdmissionBindingConsumptionInput = {
				workflowId: current.context.workflowId,
				admissionId: current.admissionId,
				bindingDigest: canonicalWorkflowBindingDigest(binding),
				expectedHead,
				nonce: deriveWorkflowAdmissionBindingNonce({
					workflowId: current.context.workflowId,
					admissionId: current.admissionId,
					epochRef: current.context.epochRef,
					head: expectedHead,
					binding,
				}),
			};
			if ((await dependencies.bindingConsumption.consume(bindingConsumptionInput)) === "already_consumed")
				throw new WorkflowDispatchError("workflow_child_identity_conflict");
			const revisionBoundary = await assertRevisionBoundary(
				dependencies,
				current.context.workflowId,
				current.context.epochRef,
				current.context.executionKey,
			);
			assertBoundaryMatchesContext(revisionBoundary, current.context);
			await assertLeaseAuthority(dependencies, { context: current.context, revisionBoundary });
			await dependencies.epochs.assertCurrent(current.context.workflowId, current.context.epochRef);
			const committed = await append(
				current.context.workflowId,
				{
					kind: "workflow_child_identity_bound",
					workflowId: current.context.workflowId,
					attemptId: current.context.attemptId,
					admissionId,
					identity: binding.childIdentity,
					processBinding: binding,
					epochRef: current.context.epochRef,
				},
				current.context.epochRef,
				`bind:${current.context.executionKey}`,
				current.context.executionKey,
				current.context.resourceLeaseRef,
				revisionBoundary,
				expectedHead,
			);
			const nextLifecycle: WorkflowAttemptLifecycle = {
				...current.lifecycle,
				status: "running",
				childIdentity: cloneAndFreeze(binding.childIdentity),
				statusDigest: digestObject({ binding, sequence: committed.commit.sequence }),
			};
			const stableBinding = cloneAndFreeze(binding);
			const next: AdmissionRecord = {
				...current,
				lifecycle: nextLifecycle,
				status: nextLifecycle.status,
				childIdentity: stableBinding.childIdentity,
				processBinding: stableBinding,
			};
			records.set(admissionId, next);
			return publicAdmission(next);
		});

	const recordOutcome = async (
		admissionId: string,
		outcome: WorkflowPhaseOutcomeRecord,
		expectedStatusDigest: string,
	): Promise<WorkflowAdmissionResult> =>
		enqueue(async () => {
			assertHydrated();
			const current = recordForAdmission(admissionId);
			const outcomeDigest = digestWorkflowOutcome(outcome);
			if (current.lifecycle.statusDigest !== expectedStatusDigest)
				throw new WorkflowDispatchError("workflow_attempt_status_conflict");
			if (!isWorkflowPhaseOutcomeRecord(outcome)) throw new WorkflowDispatchError("workflow_child_outcome_invalid");
			if (!outcomeStatusAllowed(outcome)) throw new WorkflowDispatchError("workflow_attempt_transition_invalid");
			const revisionBoundary = await assertRevisionBoundary(
				dependencies,
				current.context.workflowId,
				current.context.epochRef,
				current.context.executionKey,
			);
			assertBoundaryMatchesContext(revisionBoundary, current.context);
			await assertLeaseAuthority(dependencies, {
				context: current.context,
				revisionBoundary,
				outcome,
			});
			await dependencies.epochs.assertCurrent(current.context.workflowId, current.context.epochRef);
			if (current.processBinding === null) throw new WorkflowDispatchError("workflow_callback_binding_missing");
			const expectedHead = await readHead(current.context.workflowId, current.context.epochRef);
			await assertWorkflowChildProcessProof(dependencies, current.context, current.processBinding, expectedHead);
			const expectation = buildBindingExpectation(current, revisionBoundary);
			await assertCallbackTokenActive(dependencies.callbackFenceStore, expectation);
			assertWorkflowOutcomeAdmissionBinding(
				{
					workflowId: current.context.workflowId,
					phaseAttemptId: outcome.outcome.phaseAttemptId,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					invocationToken: outcome.outcome.invocationToken,
					epochRef: current.context.epochRef,
					resourceLeaseRef: current.context.resourceLeaseRef,
					ownershipLeaseRef: current.context.ownershipLeaseRef,
					revisionBoundary,
					outcomeDigest,
					rootSessionId: current.context.rootSessionId,
					configSnapshotDigest: current.context.configSnapshotDigest,
					expectedEffectDigest: current.context.expectedEffectDigest,
				},
				current.context,
				outcome,
			);
			await assertEffectAuthority(dependencies, {
				context: current.context,
				revisionBoundary,
				outcome,
			});
			await assertOutcomeAuthority(dependencies, {
				context: current.context,
				revisionBoundary,
				outcome,
			});
			if (current.terminalEventSequence !== null) {
				if (current.outcomeDigest !== outcomeDigest)
					throw new WorkflowDispatchError("workflow_attempt_terminal_conflict");
				return publicAdmission(current);
			}
			if (TERMINAL_STATUSES.has(current.status))
				throw new WorkflowDispatchError("workflow_attempt_transition_invalid");
			const committed = await append(
				current.context.workflowId,
				{
					kind: "workflow_child_outcome_committed",
					workflowId: current.context.workflowId,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					outcome,
					outcomeDigest,
					epochRef: current.context.epochRef,
				},
				current.context.epochRef,
				`outcome:${current.context.executionKey}`,
				current.context.executionKey,
				current.context.resourceLeaseRef,
				revisionBoundary,
				expectedHead,
			);
			const nextLifecycle: WorkflowAttemptLifecycle = {
				...current.lifecycle,
				status: outcome.attemptStatus,
				terminalEventSequence: committed.commit.sequence,
				statusDigest: digestObject({ outcomeDigest, sequence: committed.commit.sequence }),
			};
			const next: AdmissionRecord = {
				...current,
				lifecycle: nextLifecycle,
				status: nextLifecycle.status,
				terminalEventSequence: committed.commit.sequence,
				outcomeDigest,
			};
			records.set(admissionId, next);
			return publicAdmission(next);
		});

	const hydrateFromReplay = async (): Promise<void> => {
		const workflowId = dependencies.store.identity.workflowId;
		const epochRef = await replayEpochFromDependencies(dependencies, workflowId);
		const replay = await dependencies.store.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: epochRef.storeEpoch,
		});
		if (replay.quarantined) throw new WorkflowEpochError("workflow_store_replay_quarantined");
		const activeLease = await readActiveLeaseContext(dependencies, workflowId, epochRef);
		const fold = await hydrateAdmissionFromReplay({
			commits: replay.events,
			activeLease,
			contextReader: dependencies.replayContextReader,
			launchReservationReader: dependencies.launchReservationReader,
			processContainmentVerifier: dependencies.processContainmentVerifier,
			bindingConsumption: dependencies.bindingConsumption,
			persistQuarantine: async (evidence, currentLease): Promise<void> => {
				await persistReplayQuarantine(dependencies, evidence, currentLease);
			},
		});
		records.clear();
		for (const admission of fold.admissions) {
			const record: AdmissionRecord = { ...admission, hydratedPartial: false };
			records.set(record.admissionId, record);
		}
		quarantineEntries.length = 0;
		quarantineEntries.push(...fold.quarantine);
		for (const evidence of fold.conflicts) quarantineEntries.push(evidence);
		admissionHydrated = true;
		quarantineHydrated = true;
	};

	const quarantine = async (admissionId: string, reason: string): Promise<WorkflowAdmissionResult> =>
		enqueue(async () => {
			assertHydrated();
			if (!isNonEmptyString(reason)) throw new WorkflowDispatchError("workflow_quarantine_reason_invalid");
			return publicAdmission(await quarantineInternal(recordForAdmission(admissionId), reason));
		});

	return {
		admit,
		bindChild,
		recordOutcome,
		recordOutcomeFrom: async (
			coordinator,
			admissionId,
			outcome,
			expectedStatusDigest,
		): Promise<WorkflowAdmissionResult> => {
			assertHydrated();
			const current = recordForAdmission(admissionId);
			if (
				coordinator.record.workflowId !== current.context.workflowId ||
				!sameEpoch(coordinator.record.epochRef, current.context.epochRef) ||
				coordinator.record.status === "fenced" ||
				coordinator.record.status === "expired"
			)
				throw new WorkflowEpochError("workflow_epoch_stale");
			const revisionBoundary = await assertRevisionBoundary(
				dependencies,
				current.context.workflowId,
				current.context.epochRef,
				current.context.executionKey,
			);
			assertBoundaryMatchesContext(revisionBoundary, current.context);
			return recordOutcome(admissionId, outcome, expectedStatusDigest);
		},
		lookupByExecutionKey: async (workflowId, executionKey): Promise<WorkflowAdmissionResult | undefined> => {
			assertHydrated();
			const result = [...records.values()].find(
				(candidate) =>
					candidate.context.workflowId === workflowId && candidate.context.executionKey === executionKey,
			);
			return result === undefined ? undefined : publicAdmission(result);
		},
		listByWorkflow: async (workflowId): Promise<readonly WorkflowAdmissionResult[]> => {
			assertHydrated();
			return [...records.values()].filter((record) => record.context.workflowId === workflowId).map(publicAdmission);
		},
		listDescendants: async (workflowId, rootAttemptId): Promise<readonly WorkflowAdmissionResult[]> => {
			assertHydrated();
			const all = [...records.values()].filter((record) => record.context.workflowId === workflowId);
			if (rootAttemptId === null) return all.map(publicAdmission);
			const descendants = new Map<string, AdmissionRecord>();
			const pending = [rootAttemptId];
			while (pending.length > 0) {
				const parentAttemptId = pending.shift();
				if (parentAttemptId === undefined) continue;
				for (const record of all) {
					if (
						record.context.childAuthority.parentAttemptId === parentAttemptId &&
						!descendants.has(record.admissionId)
					) {
						descendants.set(record.admissionId, record);
						pending.push(record.context.attemptId);
					}
				}
			}
			return [...descendants.values()].map(publicAdmission);
		},
		hydrateFromReplay,
		hydrateQuarantineFromReplay: async (): Promise<void> => {
			if (!admissionHydrated) await hydrateFromReplay();
			const workflowId = dependencies.store.identity.workflowId;
			const epochRef = await replayEpochFromDependencies(dependencies, workflowId);
			const activeLease = await readActiveLeaseContext(dependencies, workflowId, epochRef);
			const replay = await dependencies.store.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: epochRef.storeEpoch,
			});
			for (const commit of replay.events) {
				if (commit.payload.kind !== "workflow_lease_quarantined") continue;
				const quarantinePayload = commit.payload;
				const current = [...records.values()].find(
					(record) =>
						record.context.workflowId === workflowId &&
						digestObject(record.context.resourceLeaseRef) === digestObject(quarantinePayload.leaseRef),
				);
				const evidence = replayQuarantineEvidence(activeLease, current, commit, quarantinePayload);
				if (!quarantineEntries.some((entry) => entry.evidenceDigest === evidence.evidenceDigest))
					quarantineEntries.push(evidence);
			}
			quarantineHydrated = true;
		},
		listQuarantine: async (workflowId): Promise<readonly WorkflowAdmissionQuarantineEvidence[]> => {
			assertHydrated();
			return quarantineEntries.filter((entry) => entry.workflowId === workflowId).map(cloneAndFreeze);
		},
		quarantine,
	};
}
