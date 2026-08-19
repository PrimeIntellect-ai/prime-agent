import {
	type DurableDecisionRef,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	type WorkflowActiveLeaseContext,
	type WorkflowArtifactReadResult,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowCanonicalPoolLedger,
	type WorkflowCapacityGrant,
	type WorkflowChildAuthority,
	type WorkflowChildCapability,
	type WorkflowControlCapacityVector,
	type WorkflowDispatchBlockingReason,
	type WorkflowEfficiencyRedTeamWindowState,
	type WorkflowEfficiencyReviewSchedule,
	type WorkflowEpochRef,
	type WorkflowImprovementReviewBudget,
	type WorkflowJournalHead,
	type WorkflowLeaseRef,
	type WorkflowOwnershipLease,
	type WorkflowProcessSpawnRequest,
	type WorkflowResourceEnvelope,
	type WorkflowResourceGrantLedger,
	type WorkflowResourceLease,
	type WorkflowRevisionBoundaryContext,
	type WorkflowRevisionTuple,
	type WorkflowRuntimeConfigSnapshot,
	type WorkflowTask,
} from "./contracts.js";
import { assertWorkflowRuntimeVersion } from "./runtime-store-adapter.js";
import type { WorkflowTaskGraph } from "./task-graph.js";

/** A canonical fixture projection of K's worker and control grant ledger. */
export interface WorkflowAdmissionGrantLedgerFixture {
	readonly worker: readonly Extract<WorkflowCapacityGrant, { kind: "worker" }>[];
	readonly control: readonly Extract<WorkflowCapacityGrant, { kind: "control" }>[];
	readonly canonical: WorkflowResourceGrantLedger;
	readonly digest: string;
}

/** Opaque fixture fields are carried by K and never interpreted as authority here. */
export interface WorkflowCanonicalAdmissionFixture {
	readonly [key: string]: unknown;
}

export type WorkflowEfficiencyRedTeamSchedule = WorkflowEfficiencyReviewSchedule;

export class WorkflowDispatchError extends Error {
	readonly code: string;

	public constructor(code: string) {
		super(code);
		this.name = "WorkflowDispatchError";
		this.code = code;
	}
}

export interface WorkflowControlReserveProof {
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly envelopeDigest: string;
	readonly canonicalLedgerRef: WorkflowArtifactRef;
	readonly canonicalLedgerDigest: string;
	readonly controlCapacity: WorkflowControlCapacityVector;
	readonly controlPlaneReserveCapacity: WorkflowControlCapacityVector;
	readonly proofDigest: string;
}

export interface WorkflowCanonicalAdmissionBundle {
	readonly ledger: WorkflowCanonicalPoolLedger;
	readonly grantLedger: WorkflowAdmissionGrantLedgerFixture;
	readonly grant: WorkflowCapacityGrant;
	readonly window: WorkflowEfficiencyRedTeamWindowState;
	readonly admission: WorkflowCanonicalAdmissionFixture;
	readonly budget: WorkflowImprovementReviewBudget;
	readonly schedule: WorkflowEfficiencyRedTeamSchedule;
	readonly envelope: WorkflowResourceEnvelope;
	readonly resourceLease: WorkflowResourceLease;
	readonly snapshot: WorkflowRuntimeConfigSnapshot;
	readonly refs: Readonly<Record<string, WorkflowArtifactRef>>;
	readonly controlReserveProof: WorkflowControlReserveProof;
}

export interface WorkflowApprovedDispatchConfiguration {
	readonly snapshot: WorkflowRuntimeConfigSnapshot;
	readonly envelope: WorkflowResourceEnvelope;
	readonly decisionRef: DurableDecisionRef;
	readonly configArtifactRef: WorkflowArtifactRef;
	readonly canonicalAdmissionBundleRef: WorkflowArtifactRef;
	readonly canonicalAdmissionBundle: WorkflowCanonicalAdmissionBundle;
	readonly canonicalAdmissionBundleDigest: string;
}

export interface WorkflowReadinessObservation {
	readonly readiness: WorkflowDispatchReadiness;
	readonly currentHead: WorkflowJournalHead;
}

export interface WorkflowDispatchReadiness {
	workflowId: string;
	epochRef: WorkflowEpochRef;
	rootLeaseRef: WorkflowLeaseRef;
	leaseRef: WorkflowLeaseRef;
	executionKey: string;
	revisionTuple: WorkflowRevisionTuple;
	revisionRegistryRef: WorkflowArtifactRef;
	revisionRegistryDigest: string;
	readinessDigest: string;
	canDispatch: boolean;
	childSpawnPath: "separate_process" | "same_process_rlm" | "unavailable";
	processStartIdentity: "verified" | "missing";
	processGroup: "enforceable" | "unavailable";
	artifactRoot: string;
	canonicalArtifactRoot: string;
	artifactRootRelativePath: string;
	artifactRootPathDigest: string;
	activeGenerationDigest: string;
	configSnapshotDigest: string;
	currentHeadDigest: string;
	currentHead: WorkflowJournalHead | null;
	checks: WorkflowDispatchReadinessChecks;
	blockingReasons: readonly WorkflowDispatchBlockingReason[];
	observedAt: string;
}

export interface WorkflowDispatchReadinessChecks {
	artifactRootVerified: boolean;
	rootLeaseVerified: boolean;
	currentEpochVerified: boolean;
	approvedConfigVerified: boolean;
	canonicalAdmissionBundleVerified: boolean;
	approvedEnvelopeVerified: boolean;
	kernelAdapterAvailable: boolean;
	authorityClosureVerified: boolean;
	workerCapabilityVerified: boolean;
}

export interface WorkflowReadinessInput {
	canonicalInput: WorkflowCanonicalDispatchInput;
	rootLeaseRef: WorkflowLeaseRef;
	leaseRef: WorkflowLeaseRef;
	executionKey: string;
	revisionTuple: WorkflowRevisionTuple;
	revisionRegistryRef: WorkflowArtifactRef;
	revisionRegistryDigest: string;
	configSnapshotDigest: string;
	effectReadiness: {
		canExecute: boolean;
		blockingReasons: readonly WorkflowDispatchBlockingReason[];
	};
	authority: WorkflowChildAuthority;
	task: WorkflowTask;
	graph: WorkflowTaskGraph;
}

export interface WorkflowDispatchReadinessProvider {
	observe(input: WorkflowReadinessInput): Promise<WorkflowDispatchReadiness>;
}

export interface WorkflowCanonicalDispatchInput {
	workflowId: string;
	rootSessionId: string;
	taskId: string;
	attemptId: string;
	executionKey: string;
	decisionRef: DurableDecisionRef;
	epochRef: WorkflowEpochRef;
	rootLeaseRef: WorkflowLeaseRef;
	resourceLease: WorkflowResourceLease;
	ownershipLease: WorkflowOwnershipLease | null;
	childAuthority: WorkflowChildAuthority;
	launchConfigDigest: string;
	configSnapshotDigest: string;
	canonicalAdmissionBundleRef: WorkflowArtifactRef;
	canonicalAdmissionBundleDigest: string;
	canonicalAdmissionBundle: WorkflowCanonicalAdmissionBundle;
	readonly ownershipLeaseRef?: WorkflowLeaseRef | null;
	readonly ownershipLeaseDigest?: string | null;
	revisionTuple: WorkflowRevisionTuple;
	revisionRegistryRef: WorkflowArtifactRef;
	revisionRegistryDigest: string;
	writerIdentity: string;
	expectedEffectDigest: string;
	promptArtifactRef: WorkflowArtifactRef;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	cwd: string;
	modelProvider: string;
	modelId: string;
	reasoningLevel: string;
	serviceTier: string;
	runtimeVersion: string;
	hostCapabilityRevision: string;
	agentRole: string;
	processGroupRequest: WorkflowProcessSpawnRequest;
}

export interface WorkflowWorkerReadinessObservation {
	status: "verified" | "same_process_child_session" | "unavailable";
	artifact: WorkflowWorkerReadyArtifact | null;
	capabilityAttestation: WorkflowWorkerCapabilityAttestation | null;
}

export interface WorkflowWorkerReadyArtifact {
	readonly [key: string]: unknown;
}

export interface WorkflowWorkerCapabilityAttestation {
	readonly kind: "workflow_worker_capability_attestation";
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly artifactRoot: string;
	readonly workerEntrypoint: string;
	readonly runtimeVersion: string;
	readonly hostCapabilityRevision: string;
	readonly runtimeDigest: string;
	readonly platformGroupKind: "posix_process_group" | "windows_job_object";
	readonly canSpawnDetached: true;
	readonly artifactRef: WorkflowArtifactRef;
	readonly artifactDigest: string;
	readonly signature: string;
	readonly signingKeyId: string;
}

export interface WorkflowWorkerReadinessSource {
	observe(input: WorkflowCanonicalDispatchInput): Promise<WorkflowWorkerReadinessObservation>;
}

export interface WorkflowDispatchCleanup {
	admission: "quarantined";
	processGroup: "none" | "reaped" | "quarantined";
	resourceLease: { status: "released" | "already_released" | "quarantined" };
	ownershipLease: { status: "released" | "already_released" | "quarantined" } | null;
}

export interface WorkflowWorkerLaunchObservation {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly epochRef: WorkflowEpochRef;
	readonly workerId: string;
	readonly executionIdentity: string;
	readonly processStartId: string;
	readonly processGroupId: string;
	readonly launchedAt: string;
	readonly launchEvidenceRef: WorkflowArtifactRef;
}

export interface WorkflowWorkerLaunchRecord extends WorkflowWorkerLaunchObservation {
	readonly launchDigest: string;
}

export type WorkflowDispatchResult =
	| {
			readonly status: "disabled";
			readonly phase: "readiness";
			readonly admission: null;
			readonly readiness: WorkflowDispatchReadiness;
	  }
	| {
			readonly status: "launched";
			readonly phase: "execution";
			readonly admission: null;
			readonly readiness: WorkflowDispatchReadiness;
			readonly worker: WorkflowWorkerLaunchRecord;
	  };

export interface WorkflowRevisionRegistryAdapter {
	assertActive(context: WorkflowRevisionBoundaryContext): Promise<void>;
}

export interface WorkflowRevisionBoundaryReader {
	readonly readRevisionBoundaryContext: (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		executionKey: string | null,
	) => Promise<WorkflowRevisionBoundaryContext>;
	readonly revisionRegistry: WorkflowRevisionRegistryAdapter;
}

export interface WorkflowEpochGuard {
	assertCurrent(workflowId: string, epochRef: WorkflowEpochRef): Promise<void>;
}

export interface WorkflowDispatcherDependencies {
	readonly taskGraph: WorkflowTaskGraph;
	readonly epochs: WorkflowEpochGuard;
	readonly readRevisionBoundaryContext?: WorkflowRevisionBoundaryReader["readRevisionBoundaryContext"];
	readonly revisionRegistry?: WorkflowRevisionRegistryAdapter;
	readonly readinessProvider: WorkflowDispatchReadinessProvider;
	readonly revisionBoundary?: WorkflowRevisionBoundaryReader;
	readonly effectReadiness?: () => {
		canExecute: boolean;
		blockingReasons: readonly WorkflowDispatchBlockingReason[];
	};
	readonly launchWorker?: (
		input: WorkflowCanonicalDispatchInput,
		readiness: WorkflowDispatchReadiness,
	) => Promise<WorkflowWorkerLaunchObservation>;
}

export interface WorkflowDispatcher {
	observe(input: WorkflowCanonicalDispatchInput): Promise<WorkflowDispatchReadiness>;
	dispatch(input: WorkflowCanonicalDispatchInput): Promise<WorkflowDispatchResult>;
}

const CHILD_CAPABILITIES: ReadonlySet<WorkflowChildCapability> = new Set([
	"read_only",
	"shell",
	"ipython",
	"edit",
	"recursive_spawn",
]);

const REVISION_FIELDS: readonly (keyof WorkflowRevisionTuple)[] = [
	"contractRevision",
	"scorecardRevision",
	"planRevision",
	"configRevision",
	"evidenceRevision",
];

const CONTROL_CAPACITY_FIELDS = [
	"processSlots",
	"childSessionSlots",
	"modelCallSlots",
	"modelInputTokens",
	"modelOutputTokens",
	"verificationSlots",
	"redTeamSlots",
	"recoverySlots",
] as const;

const RESOURCE_VECTOR_FIELDS = [
	"cpuMilliCores",
	"memoryBytes",
	"diskBytes",
	"ioWeight",
	"networkEgressBytes",
	"wallMilliseconds",
	"monetaryMicrounits",
] as const;

const CANONICAL_BUNDLE_FIELDS = [
	"ledger",
	"grantLedger",
	"grant",
	"window",
	"admission",
	"budget",
	"schedule",
	"envelope",
	"resourceLease",
	"snapshot",
	"refs",
	"controlReserveProof",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function assertNonEmptyString(value: unknown, code: string): asserts value is string {
	if (!isNonEmptyString(value)) throw new WorkflowDispatchError(code);
}

function assertCanonicalIdentifier(value: unknown): asserts value is string {
	assertNonEmptyString(value, "workflow_dispatch_input_invalid");
	if (
		value === "." ||
		value === ".." ||
		value.includes("/") ||
		value.includes("\\") ||
		value.split(/[\\/]/u).some((part) => part === "." || part === "..")
	) {
		throw new WorkflowDispatchError("workflow_dispatch_input_invalid");
	}
}

function assertEpoch(epoch: unknown): asserts epoch is WorkflowEpochRef {
	const storeEpoch = isRecord(epoch) ? epoch.storeEpoch : undefined;
	const coordinatorEpoch = isRecord(epoch) ? epoch.coordinatorEpoch : undefined;
	if (
		!isRecord(epoch) ||
		!Number.isSafeInteger(storeEpoch) ||
		(storeEpoch as number) < 1 ||
		!Number.isSafeInteger(coordinatorEpoch) ||
		(coordinatorEpoch as number) < 1
	) {
		throw new WorkflowDispatchError("workflow_epoch_invalid");
	}
}

function assertSameEpoch(...epochs: readonly (WorkflowEpochRef | null | undefined)[]): void {
	const present = epochs.filter((epoch): epoch is WorkflowEpochRef => epoch !== null && epoch !== undefined);
	if (present.length === 0) throw new WorkflowDispatchError("workflow_epoch_invalid");
	const first = present[0];
	if (
		present.some(
			(epoch) => epoch.storeEpoch !== first.storeEpoch || epoch.coordinatorEpoch !== first.coordinatorEpoch,
		)
	) {
		throw new WorkflowDispatchError("workflow_epoch_mismatch");
	}
}

function assertArtifactRef(value: unknown): asserts value is WorkflowArtifactRef {
	const artifact = isRecord(value) ? value.artifactId : undefined;
	const relativePath = isRecord(value) ? value.relativePath : undefined;
	const digest = isRecord(value) ? value.digest : undefined;
	const sizeBytes = isRecord(value) ? value.sizeBytes : undefined;
	const sourceEventSequence = isRecord(value) ? value.sourceEventSequence : undefined;
	if (
		!isRecord(value) ||
		!isNonEmptyString(artifact) ||
		!isNonEmptyString(relativePath) ||
		!isNonEmptyString(digest) ||
		!Number.isSafeInteger(sizeBytes) ||
		(sizeBytes as number) < 0 ||
		!Number.isSafeInteger(sourceEventSequence) ||
		(sourceEventSequence as number) < 1
	) {
		throw new WorkflowDispatchError("workflow_artifact_reference_invalid");
	}
}

/** Resolve and re-hash an immutable artifact before it can support readiness. */
export async function resolveCanonicalDispatchArtifact(
	ref: WorkflowArtifactRef,
	resolver: WorkflowArtifactResolver,
): Promise<Readonly<Uint8Array>> {
	try {
		assertArtifactRef(ref);
	} catch {
		throw new WorkflowDispatchError("workflow_artifact_reference_invalid");
	}
	let result: WorkflowArtifactReadResult;
	try {
		result = await resolver.resolve(ref);
	} catch {
		throw new WorkflowDispatchError("workflow_artifact_unavailable");
	}
	if (
		result.exists !== true ||
		!isRecord(result.envelope) ||
		digestObject(result.envelope.ref) !== digestObject(ref) ||
		result.verifiedDigest !== ref.digest ||
		result.verifiedSizeBytes !== ref.sizeBytes ||
		result.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(new Uint8Array(result.bytes)) !== ref.digest
	) {
		throw new WorkflowDispatchError("workflow_artifact_digest_mismatch");
	}
	return result.bytes;
}

function assertRevisionTuple(tuple: unknown): asserts tuple is WorkflowRevisionTuple {
	if (
		!isRecord(tuple) ||
		REVISION_FIELDS.some((field) => {
			const value = tuple[field];
			return !Number.isSafeInteger(value) || (value as number) < 1;
		})
	) {
		throw new WorkflowDispatchError("workflow_revision_boundary_invalid");
	}
}

function assertLeaseRef(value: unknown, expectedEpoch: WorkflowEpochRef): asserts value is WorkflowLeaseRef {
	if (!isRecord(value)) throw new WorkflowDispatchError("workflow_lease_invalid");
	assertEpoch(value);
	assertSameEpoch(value, expectedEpoch);
	const leaseId = value.leaseId;
	const acquisitionEventSequence = value.acquisitionEventSequence;
	const processIdentity = value.processIdentity;
	const rootDigest = value.rootDigest;
	const writerIdentity = value.writerIdentity;
	const acquiredAt = value.acquiredAt;
	const expiresAt = value.expiresAt;
	assertCanonicalIdentifier(leaseId);
	if (
		!Number.isSafeInteger(acquisitionEventSequence) ||
		(acquisitionEventSequence as number) < 1 ||
		!isNonEmptyString(processIdentity) ||
		!isNonEmptyString(rootDigest) ||
		!isNonEmptyString(writerIdentity) ||
		!isNonEmptyString(acquiredAt) ||
		!isNonEmptyString(expiresAt) ||
		!Number.isFinite(Date.parse(acquiredAt as string)) ||
		!Number.isFinite(Date.parse(expiresAt as string)) ||
		Date.parse(expiresAt as string) <= Date.parse(acquiredAt as string)
	) {
		throw new WorkflowDispatchError("workflow_lease_invalid");
	}
}

function assertControlCapacity(value: unknown): void {
	if (
		!isRecord(value) ||
		CONTROL_CAPACITY_FIELDS.some((field) => !Number.isSafeInteger(value[field]) || (value[field] as number) < 0)
	) {
		throw new WorkflowDispatchError("workflow_resource_lease_invalid");
	}
}

function assertResourceVector(value: unknown): void {
	if (
		!isRecord(value) ||
		RESOURCE_VECTOR_FIELDS.some((field) => !Number.isFinite(value[field]) || (value[field] as number) < 0) ||
		!Array.isArray(value.accelerators) ||
		!Array.isArray(value.providers)
	) {
		throw new WorkflowDispatchError("workflow_resource_lease_invalid");
	}
}

function assertResourceLease(input: WorkflowCanonicalDispatchInput): void {
	const lease = input.resourceLease;
	if (
		!isRecord(lease) ||
		!isNonEmptyString(lease.leaseId) ||
		lease.workflowId !== input.workflowId ||
		lease.taskId !== input.taskId ||
		lease.attemptId !== input.attemptId ||
		(lease.status !== "reserved" && lease.status !== "active") ||
		!isNonEmptyString(lease.idempotencyKey) ||
		!isNonEmptyString(lease.acquiredAt) ||
		!isNonEmptyString(lease.expiresAt) ||
		!Number.isFinite(Date.parse(lease.acquiredAt)) ||
		!Number.isFinite(Date.parse(lease.expiresAt)) ||
		Date.parse(lease.expiresAt) <= Date.parse(lease.acquiredAt)
	) {
		throw new WorkflowDispatchError("workflow_resource_lease_invalid");
	}
	assertSameEpoch(lease, input.epochRef);
	assertControlCapacity(lease.controlCapacity);
	assertControlCapacity(lease.workerCapacity);
	const admission = lease.resourceAdmission;
	if (
		!isRecord(admission) ||
		admission.admitted !== true ||
		!Array.isArray(admission.unknownPoolIds) ||
		admission.unknownPoolIds.length !== 0 ||
		!isNonEmptyString(admission.canonicalLedgerDigest) ||
		!isNonEmptyString(admission.admissionDigest)
	) {
		throw new WorkflowDispatchError("workflow_resource_lease_invalid");
	}
	const grant = admission.capacityGrant;
	if (
		!isRecord(grant) ||
		(grant.kind !== "worker" && grant.kind !== "control") ||
		!isNonEmptyString(grant.grantId) ||
		!isNonEmptyString(grant.grantDigest)
	) {
		throw new WorkflowDispatchError("workflow_resource_lease_invalid");
	}
	assertResourceVector(grant.resourceVector);
	assertControlCapacity(grant.controlCapacity);
	assertArtifactRef(grant.canonicalPoolLedgerRef);
	assertArtifactRef(admission.canonicalLedgerRef);
}

function assertOwnershipLease(input: WorkflowCanonicalDispatchInput, task: WorkflowTask): void {
	const lease = input.ownershipLease;
	if (lease === null) {
		if (input.ownershipLeaseRef !== undefined && input.ownershipLeaseRef !== null)
			throw new WorkflowDispatchError("workflow_ownership_binding_invalid");
		if (input.ownershipLeaseDigest !== undefined && input.ownershipLeaseDigest !== null)
			throw new WorkflowDispatchError("workflow_ownership_binding_invalid");
		return;
	}
	if (
		!isRecord(lease) ||
		lease.workflowId !== input.workflowId ||
		lease.taskId !== input.taskId ||
		lease.attemptId !== input.attemptId ||
		(lease.status !== "reserved" && lease.status !== "active")
	) {
		throw new WorkflowDispatchError("workflow_ownership_lease_invalid");
	}
	assertSameEpoch(lease, input.epochRef);
	if (
		!Array.isArray(lease.ownedPaths) ||
		!Array.isArray(lease.ownedContracts) ||
		digestObject(lease.ownedPaths) !== digestObject(task.ownedPaths) ||
		digestObject(lease.ownedContracts) !== digestObject(task.ownedContracts)
	)
		throw new WorkflowDispatchError("workflow_ownership_binding_invalid");
	const leaseRef = input.ownershipLeaseRef;
	if (
		leaseRef === undefined ||
		leaseRef === null ||
		input.ownershipLeaseDigest === undefined ||
		input.ownershipLeaseDigest === null
	)
		throw new WorkflowDispatchError("workflow_ownership_binding_invalid");
	assertLeaseRef(leaseRef, input.epochRef);
	if (
		leaseRef.leaseId !== lease.leaseId ||
		leaseRef.writerIdentity !== input.writerIdentity ||
		leaseRef.rootDigest !== digestObject(lease) ||
		input.ownershipLeaseDigest !== digestObject(lease)
	)
		throw new WorkflowDispatchError("workflow_ownership_binding_invalid");
}

function assertDecision(input: WorkflowCanonicalDispatchInput): void {
	const decision = input.decisionRef;
	if (
		!isRecord(decision) ||
		!isNonEmptyString(decision.decisionId) ||
		!Number.isSafeInteger(decision.revision) ||
		decision.revision < 1 ||
		!Number.isSafeInteger(decision.storeEpoch) ||
		decision.storeEpoch < 1 ||
		!isNonEmptyString(decision.decisionDigest) ||
		!isRecord(decision.decisionScope) ||
		decision.decisionScope.kind !== "workflow" ||
		decision.decisionScope.workflowId !== input.workflowId ||
		decision.decisionScope.rootSessionId !== input.rootSessionId
	) {
		throw new WorkflowDispatchError("workflow_decision_ref_invalid");
	}
	if (decision.storeEpoch !== input.epochRef.storeEpoch) throw new WorkflowDispatchError("workflow_epoch_mismatch");
	const coordinatorEpoch = decision.coordinatorEpoch;
	if (coordinatorEpoch !== undefined && coordinatorEpoch !== input.epochRef.coordinatorEpoch)
		throw new WorkflowDispatchError("workflow_epoch_mismatch");
}

function assertAuthority(authority: WorkflowChildAuthority, input: WorkflowCanonicalDispatchInput): void {
	if (
		!isRecord(authority) ||
		!Array.isArray(authority.capabilities) ||
		authority.capabilities.length === 0 ||
		new Set(authority.capabilities).size !== authority.capabilities.length ||
		authority.capabilities.some((capability) => !CHILD_CAPABILITIES.has(capability)) ||
		(authority.writeClass !== "read_only" && authority.writeClass !== "write_capable") ||
		authority.rootSpawned !== (authority.parentAttemptId === null) ||
		(authority.rootSpawned && authority.parentAttemptId !== null) ||
		(!authority.rootSpawned &&
			(authority.parentAttemptId === null ||
				authority.parentAttemptId.length === 0 ||
				authority.parentAttemptId === input.attemptId)) ||
		(authority.writeClass === "read_only" &&
			authority.capabilities.some((capability) => capability !== "read_only")) ||
		(!authority.rootSpawned && authority.capabilities.includes("recursive_spawn"))
	) {
		throw new WorkflowDispatchError("workflow_child_authority_invalid");
	}
}

function assertProcessSpawnRequest(request: WorkflowProcessSpawnRequest): void {
	if (
		!isRecord(request) ||
		!isNonEmptyString(request.executable) ||
		!Array.isArray(request.arguments) ||
		request.arguments.some((argument) => typeof argument !== "string" || argument.includes("\u0000")) ||
		!isNonEmptyString(request.cwd) ||
		request.cwd.includes("\u0000") ||
		request.cwd.split(/[\\/]/u).some((part) => part === "." || part === "..") ||
		request.detached !== true
	) {
		throw new WorkflowDispatchError("workflow_process_spawn_request_invalid");
	}
	if (request.requireProcessStartId !== true)
		throw new WorkflowDispatchError("workflow_process_start_identity_required");
}

function assertControlReserveProof(
	input: WorkflowCanonicalDispatchInput,
	bundle: WorkflowCanonicalAdmissionBundle,
): void {
	try {
		const proof = bundle.controlReserveProof;
		if (
			!isRecord(proof) ||
			proof.workflowId !== input.workflowId ||
			!isNonEmptyString(proof.envelopeDigest) ||
			!isNonEmptyString(proof.canonicalLedgerDigest) ||
			!isNonEmptyString(proof.proofDigest)
		)
			throw new WorkflowDispatchError("workflow_control_reserve_proof_invalid");
		assertSameEpoch(proof.epochRef, input.epochRef);
		assertArtifactRef(proof.canonicalLedgerRef);
		assertControlCapacity(proof.controlCapacity);
		assertControlCapacity(proof.controlPlaneReserveCapacity);
		if (
			proof.envelopeDigest !== bundle.envelope.envelopeDigest ||
			proof.canonicalLedgerDigest !== bundle.envelope.canonicalLedgerDigest ||
			digestObject(proof.canonicalLedgerRef) !== digestObject(bundle.envelope.canonicalLedgerRef) ||
			digestObject(proof.controlCapacity) !== digestObject(bundle.envelope.controlCapacity) ||
			digestObject(proof.controlPlaneReserveCapacity) !==
				digestObject(bundle.envelope.controlPlaneReserveCapacity) ||
			proof.proofDigest !==
				digestObject({
					workflowId: proof.workflowId,
					epochRef: proof.epochRef,
					envelopeDigest: proof.envelopeDigest,
					canonicalLedgerRef: proof.canonicalLedgerRef,
					canonicalLedgerDigest: proof.canonicalLedgerDigest,
					controlCapacity: proof.controlCapacity,
					controlPlaneReserveCapacity: proof.controlPlaneReserveCapacity,
				})
		) {
			throw new WorkflowDispatchError("workflow_control_reserve_proof_invalid");
		}
	} catch {
		throw new WorkflowDispatchError("workflow_control_reserve_proof_invalid");
	}
}

function assertCanonicalBundle(input: WorkflowCanonicalDispatchInput): void {
	const bundle = input.canonicalAdmissionBundle;
	if (!isRecord(bundle)) throw new WorkflowDispatchError("workflow_canonical_admission_bundle_invalid");
	if (!isRecord(bundle.controlReserveProof)) throw new WorkflowDispatchError("workflow_control_reserve_proof_invalid");
	for (const field of CANONICAL_BUNDLE_FIELDS) {
		if (!(field in bundle) || bundle[field] === undefined || bundle[field] === null)
			throw new WorkflowDispatchError("workflow_canonical_admission_bundle_invalid");
	}
	assertArtifactRef(input.canonicalAdmissionBundleRef);
	assertNonEmptyString(input.canonicalAdmissionBundleDigest, "workflow_canonical_admission_bundle_invalid");
	let digest: string;
	try {
		digest = digestObject(bundle);
	} catch {
		throw new WorkflowDispatchError("workflow_canonical_admission_bundle_invalid");
	}
	if (digest !== input.canonicalAdmissionBundleDigest)
		throw new WorkflowDispatchError("workflow_canonical_admission_bundle_invalid");
	const snapshot = bundle.snapshot;
	if (
		!isRecord(snapshot) ||
		!isNonEmptyString(snapshot.resolvedConfigDigest) ||
		snapshot.resolvedConfigDigest !== input.configSnapshotDigest ||
		!Number.isSafeInteger(snapshot.configRevision) ||
		snapshot.configRevision < 1
	) {
		throw new WorkflowDispatchError("workflow_config_snapshot_invalid");
	}
	if (!isRecord(bundle.refs)) throw new WorkflowDispatchError("workflow_canonical_admission_bundle_invalid");
	for (const ref of Object.values(bundle.refs)) assertArtifactRef(ref);
	try {
		if (digestObject(bundle.resourceLease) !== digestObject(input.resourceLease))
			throw new WorkflowDispatchError("workflow_resource_lease_invalid");
	} catch (error) {
		if (error instanceof WorkflowDispatchError) throw error;
		throw new WorkflowDispatchError("workflow_resource_lease_invalid");
	}
	const envelope = bundle.envelope;
	if (
		!isRecord(envelope) ||
		!isNonEmptyString(envelope.envelopeDigest) ||
		!isNonEmptyString(envelope.canonicalLedgerDigest) ||
		!isRecord(envelope.approvalDecisionRef) ||
		digestObject(envelope.approvalDecisionRef) !== digestObject(input.decisionRef)
	) {
		throw new WorkflowDispatchError("workflow_resource_envelope_unapproved");
	}
	assertArtifactRef(envelope.canonicalLedgerRef);
	if (
		envelope.canonicalLedgerDigest !== input.resourceLease.resourceAdmission.canonicalLedgerDigest ||
		digestObject(envelope.canonicalLedgerRef) !==
			digestObject(input.resourceLease.resourceAdmission.canonicalLedgerRef)
	) {
		throw new WorkflowDispatchError("workflow_resource_envelope_unapproved");
	}
	assertControlReserveProof(input, bundle);
}

function assertCanonicalFields(input: WorkflowCanonicalDispatchInput): void {
	for (const value of [
		input.workflowId,
		input.rootSessionId,
		input.taskId,
		input.attemptId,
		input.writerIdentity,
		input.launchConfigDigest,
		input.configSnapshotDigest,
		input.revisionRegistryDigest,
		input.writerIdentity,
		input.expectedEffectDigest,
		input.prompt,
		input.sessionName,
		input.sessionDir,
		input.cwd,
		input.modelProvider,
		input.modelId,
		input.reasoningLevel,
		input.serviceTier,
		input.runtimeVersion,
		input.hostCapabilityRevision,
		input.agentRole,
	]) {
		assertNonEmptyString(value, "workflow_dispatch_input_invalid");
	}
	for (const path of [input.sessionDir, input.cwd]) {
		if (path.includes("\u0000") || path.split(/[\\/]/u).some((part) => part === "." || part === ".."))
			throw new WorkflowDispatchError("workflow_artifact_root_unavailable");
	}
	try {
		assertWorkflowRuntimeVersion(input.runtimeVersion);
	} catch {
		throw new WorkflowDispatchError("workflow_runtime_version_unsupported");
	}
	assertCanonicalIdentifier(input.workflowId);
	assertCanonicalIdentifier(input.rootSessionId);
	assertCanonicalIdentifier(input.taskId);
	assertCanonicalIdentifier(input.attemptId);
	assertCanonicalIdentifier(input.sessionName);
	assertArtifactRef(input.promptArtifactRef);
	assertArtifactRef(input.revisionRegistryRef);
}

/** Derive the only execution key accepted by the dispatcher. */
export function deriveWorkflowExecutionKey(
	input: Pick<
		WorkflowCanonicalDispatchInput,
		"workflowId" | "taskId" | "attemptId" | "decisionRef" | "launchConfigDigest"
	>,
): string {
	return sha256Hex(
		[
			input.workflowId,
			input.taskId,
			input.attemptId,
			input.decisionRef.decisionDigest,
			input.launchConfigDigest,
		].join(":"),
	);
}

/** Project a concrete resource lease into the lease reference carried by readiness. */
export function leaseRefOf(lease: WorkflowResourceLease): WorkflowLeaseRef {
	const acquiredAt = typeof lease.acquiredAt === "string" ? Date.parse(lease.acquiredAt) : Number.NaN;
	const expiresAt = Date.parse(lease.expiresAt);
	if (
		!Number.isFinite(acquiredAt) ||
		!Number.isFinite(expiresAt) ||
		expiresAt <= acquiredAt ||
		typeof lease.acquiredAt !== "string" ||
		lease.acquiredAt.length === 0 ||
		lease.expiresAt.length === 0
	)
		throw new WorkflowDispatchError("workflow_lease_ref_invalid");
	return {
		storeEpoch: lease.storeEpoch,
		coordinatorEpoch: lease.coordinatorEpoch,
		leaseId: lease.leaseId,
		acquisitionEventSequence: lease.acquisitionEventSequence,
		processIdentity: lease.holderIdentity,
		rootDigest: lease.resourceAdmission.admissionDigest,
		writerIdentity: lease.holderIdentity,
		acquiredAt: lease.acquiredAt,
		expiresAt: lease.expiresAt,
	};
}

/** Validate the complete canonical input before any readiness or launch callback. */
export function assertCanonicalDispatchInput(input: WorkflowCanonicalDispatchInput, graph: WorkflowTaskGraph): void {
	if (!isRecord(input) || !isRecord(graph) || typeof graph.byId?.get !== "function")
		throw new WorkflowDispatchError("workflow_dispatch_input_invalid");
	assertCanonicalFields(input);
	assertEpoch(input.epochRef);
	assertRevisionTuple(input.revisionTuple);
	assertSameEpoch(input.epochRef, input.rootLeaseRef, input.resourceLease, input.ownershipLease);
	assertLeaseRef(input.rootLeaseRef, input.epochRef);
	if (input.rootLeaseRef.writerIdentity !== input.writerIdentity)
		throw new WorkflowDispatchError("workflow_writer_identity_mismatch");
	const task = graph.byId.get(input.taskId);
	if (task === undefined) throw new WorkflowDispatchError("workflow_task_missing_from_graph");
	if (task.taskId !== input.taskId || task.status !== "ready")
		throw new WorkflowDispatchError("workflow_task_not_ready");
	assertResourceLease(input);
	assertOwnershipLease(input, task);
	assertDecision(input);
	assertAuthority(input.childAuthority, input);
	assertProcessSpawnRequest(input.processGroupRequest);
	assertCanonicalBundle(input);
	const executionKey = deriveWorkflowExecutionKey(input);
	if (input.executionKey !== executionKey) throw new WorkflowDispatchError("workflow_noncanonical_execution_key");
}

function revisionBoundaryDigest(context: WorkflowRevisionBoundaryContext): string {
	return digestObject({
		workflowId: context.workflowId,
		epochRef: context.epochRef,
		leaseRef: context.leaseRef,
		executionKey: context.executionKey,
		revisionTuple: context.revisionTuple,
		revisionRegistryRef: context.revisionRegistryRef,
		revisionRegistryDigest: context.revisionRegistryDigest,
		configSnapshotDigest: context.configSnapshotDigest,
	});
}

/** Re-read and authenticate the complete K revision boundary before readiness. */
export async function assertRevisionBoundary(
	dependencies: WorkflowRevisionBoundaryReader,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	executionKey: string | null,
): Promise<WorkflowRevisionBoundaryContext> {
	let context: WorkflowRevisionBoundaryContext;
	try {
		context = await dependencies.readRevisionBoundaryContext(workflowId, epochRef, executionKey);
		if (
			context.workflowId !== workflowId ||
			context.executionKey !== executionKey ||
			digestObject(context.epochRef) !== digestObject(epochRef) ||
			context.tupleDigest !== revisionBoundaryDigest(context)
		) {
			throw new WorkflowDispatchError("workflow_revision_boundary_mismatch");
		}
		assertEpoch(context.epochRef);
		assertLeaseRef(context.leaseRef, context.epochRef);
		assertRevisionTuple(context.revisionTuple);
		assertArtifactRef(context.revisionRegistryRef);
		assertNonEmptyString(context.revisionRegistryDigest, "workflow_revision_boundary_mismatch");
		assertNonEmptyString(context.configSnapshotDigest, "workflow_revision_boundary_mismatch");
	} catch (error) {
		if (error instanceof WorkflowDispatchError) throw error;
		throw new WorkflowDispatchError("workflow_revision_boundary_unavailable");
	}
	try {
		await dependencies.revisionRegistry.assertActive(context);
	} catch {
		throw new WorkflowDispatchError("workflow_revision_boundary_stale");
	}
	return context;
}

export interface WorkflowDispatchReadinessDependencies {
	readonly readRevisionBoundaryContext?: WorkflowRevisionBoundaryReader["readRevisionBoundaryContext"];
	readonly revisionRegistry?: WorkflowRevisionRegistryAdapter;
	readonly revisionBoundary?: WorkflowRevisionBoundaryReader;
	readonly epochs?: WorkflowEpochGuard;
	readonly artifactRoot?: string;
	readonly canonicalArtifactRoot?: string;
	readonly artifactRootRelativePath?: string;
	readonly artifactRootPathDigest?: string;
	readonly activeGenerationDigest?: string;
	readonly verifyArtifactRoot?: (input: WorkflowCanonicalDispatchInput) => Promise<boolean>;
	readonly artifactResolver?: WorkflowArtifactResolver;
	readonly rootArtifactRef?: (workflowId: string, epochRef: WorkflowEpochRef) => Promise<WorkflowArtifactRef | null>;
	readonly readCurrentEpoch?: (workflowId: string) => Promise<WorkflowEpochRef | null>;
	readonly readCurrentHead?: (workflowId: string) => Promise<WorkflowJournalHead | null>;
	readonly readActiveLeaseContext?: () => Promise<WorkflowActiveLeaseContext | null>;
	readonly readApprovedConfig?: (
		workflowId: string,
		epochRef: WorkflowEpochRef,
	) => Promise<
		WorkflowApprovedDispatchConfiguration | { configSnapshotDigest: string; envelopeDigest: string } | null
	>;
	readonly persistReadinessObservation?: (observation: WorkflowReadinessObservation) => Promise<void>;
	readonly adapterAvailable?: () => Promise<boolean>;
	readonly verifyWorkerCapabilityAttestation?: (
		attestation: WorkflowWorkerCapabilityAttestation,
		input: WorkflowCanonicalDispatchInput,
		artifactRoot: string,
	) => Promise<boolean>;
	readonly verifyWorkerReadyArtifact?: (
		artifact: WorkflowWorkerReadyArtifact,
		input: WorkflowCanonicalDispatchInput,
		artifactRoot: string,
	) => Promise<boolean>;
	readonly authorityClosure?: (input: {
		workflowId: string;
		authority: WorkflowChildAuthority;
		task: WorkflowTask;
		graph: WorkflowTaskGraph;
		epochRef: WorkflowEpochRef;
	}) => Promise<boolean>;
	readonly workerReadiness?: WorkflowWorkerReadinessSource;
	readonly effectReadiness?: () => {
		canExecute: boolean;
		blockingReasons: readonly WorkflowDispatchBlockingReason[];
	};
	readonly now?: () => string;
}

export interface WorkflowDispatchRecoveryBinding {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef | null;
	readonly leaseDigest?: string | null;
	readonly writerIdentity: string;
	readonly runtimeVersion: string;
	readonly hostCapabilityRevision: string;
	readonly capabilityDigest: string;
	readonly revisionTuple: WorkflowRevisionTuple;
	readonly revisionRegistryRef: WorkflowArtifactRef;
	readonly revisionRegistryDigest: string;
	readonly workspaceDigest: string | null;
}

export interface WorkflowDispatchRecoveryObservation {
	readonly binding: WorkflowDispatchRecoveryBinding;
	readonly disposition:
		| "reattached"
		| "still_running"
		| "completed"
		| "proven_not_executed"
		| "corrective_work_required"
		| "user_input_required"
		| "failed";
	readonly observedWorkspaceDigest: string;
	readonly nonExecutionProof: string | null;
}

export interface WorkflowDispatchRecoveryDependencies {
	readonly readCurrentHead?: (workflowId: string) => Promise<WorkflowJournalHead | null>;
	readonly reconcile?: (binding: WorkflowDispatchRecoveryBinding) => Promise<WorkflowDispatchRecoveryObservation>;
}

function assertRecoveryBindingShape(binding: WorkflowDispatchRecoveryBinding): void {
	for (const value of [
		binding.workflowId,
		binding.taskId,
		binding.attemptId,
		binding.executionKey,
		binding.writerIdentity,
		binding.runtimeVersion,
		binding.hostCapabilityRevision,
		binding.capabilityDigest,
		binding.revisionRegistryDigest,
	]) {
		assertNonEmptyString(value, "workflow_recovery_binding_invalid");
	}
	assertCanonicalIdentifier(binding.workflowId);
	assertCanonicalIdentifier(binding.taskId);
	assertCanonicalIdentifier(binding.attemptId);
	assertCanonicalIdentifier(binding.executionKey);
	assertEpoch(binding.epochRef);
	assertWorkflowRuntimeVersion(binding.runtimeVersion);
	assertRevisionTuple(binding.revisionTuple);
	assertArtifactRef(binding.revisionRegistryRef);
	if (binding.leaseRef === null || binding.leaseDigest === null || binding.leaseDigest === undefined)
		throw new WorkflowDispatchError("workflow_recovery_lease_binding_invalid");
	assertLeaseRef(binding.leaseRef, binding.epochRef);
	if (binding.leaseDigest !== digestObject(binding.leaseRef))
		throw new WorkflowDispatchError("workflow_recovery_lease_binding_invalid");
	if (binding.workspaceDigest === null || !isNonEmptyString(binding.workspaceDigest))
		throw new WorkflowDispatchError("workflow_recovery_workspace_evidence_unavailable");
}

/** Validate an exact recovery boundary before invoking a host reconciliation port. */
export async function assertWorkflowRecoveryBinding(
	binding: WorkflowDispatchRecoveryBinding,
	dependencies: WorkflowDispatchRecoveryDependencies = {},
): Promise<void> {
	if (dependencies.reconcile === undefined) throw new WorkflowDispatchError("workflow_recovery_unavailable");
	try {
		assertRecoveryBindingShape(binding);
	} catch (error) {
		if (error instanceof WorkflowDispatchError) throw error;
		throw new WorkflowDispatchError("workflow_recovery_binding_invalid");
	}
	if (dependencies.readCurrentHead === undefined) throw new WorkflowDispatchError("workflow_recovery_unavailable");
	const head = await dependencies.readCurrentHead(binding.workflowId).catch(() => null);
	if (
		head === null ||
		head.workflowId !== binding.workflowId ||
		digestObject(head.epochRef) !== digestObject(binding.epochRef) ||
		!Number.isSafeInteger(head.sequence) ||
		head.sequence < 0
	) {
		throw new WorkflowDispatchError("workflow_recovery_head_unavailable");
	}
}

/** Reconcile through an injected port; no fallback may claim non-execution. */
export async function reconcileWorkflowDispatchRecovery(
	binding: WorkflowDispatchRecoveryBinding,
	dependencies: WorkflowDispatchRecoveryDependencies,
): Promise<WorkflowDispatchRecoveryObservation> {
	await assertWorkflowRecoveryBinding(binding, dependencies);
	const observation = await dependencies.reconcile!(binding).catch(() => {
		throw new WorkflowDispatchError("workflow_recovery_reconciliation_unavailable");
	});
	if (
		digestObject(observation.binding) !== digestObject(binding) ||
		!isNonEmptyString(observation.observedWorkspaceDigest) ||
		observation.observedWorkspaceDigest !== binding.workspaceDigest
	) {
		throw new WorkflowDispatchError("workflow_recovery_binding_invalid");
	}
	if (observation.disposition === "proven_not_executed" && !isNonEmptyString(observation.nonExecutionProof))
		throw new WorkflowDispatchError("workflow_recovery_nonexecution_unproven");
	return observation;
}

function revisionBoundaryReaderOf(
	dependencies: Pick<
		WorkflowDispatcherDependencies,
		"readRevisionBoundaryContext" | "revisionRegistry" | "revisionBoundary"
	>,
): WorkflowRevisionBoundaryReader | undefined {
	if (dependencies.revisionBoundary !== undefined) return dependencies.revisionBoundary;
	if (dependencies.readRevisionBoundaryContext === undefined || dependencies.revisionRegistry === undefined)
		return undefined;
	return {
		readRevisionBoundaryContext: dependencies.readRevisionBoundaryContext,
		revisionRegistry: dependencies.revisionRegistry,
	};
}

function revisionBoundaryOf(
	dependencies: WorkflowDispatchReadinessDependencies,
): WorkflowRevisionBoundaryReader | undefined {
	if (dependencies.revisionBoundary !== undefined) return dependencies.revisionBoundary;
	if (dependencies.readRevisionBoundaryContext === undefined || dependencies.revisionRegistry === undefined)
		return undefined;
	return {
		readRevisionBoundaryContext: dependencies.readRevisionBoundaryContext,
		revisionRegistry: dependencies.revisionRegistry,
	};
}

function assertReadinessInputMatchesCanonical(input: WorkflowReadinessInput): void {
	const dispatch = input.canonicalInput;
	try {
		if (
			digestObject(input.rootLeaseRef) !== digestObject(dispatch.rootLeaseRef) ||
			digestObject(input.leaseRef) !== digestObject(leaseRefOf(dispatch.resourceLease)) ||
			input.executionKey !== dispatch.executionKey ||
			digestObject(input.revisionTuple) !== digestObject(dispatch.revisionTuple) ||
			digestObject(input.revisionRegistryRef) !== digestObject(dispatch.revisionRegistryRef) ||
			input.revisionRegistryDigest !== dispatch.revisionRegistryDigest ||
			input.configSnapshotDigest !== dispatch.configSnapshotDigest ||
			digestObject(input.authority) !== digestObject(dispatch.childAuthority)
		) {
			throw new WorkflowDispatchError("workflow_readiness_input_mismatch");
		}
	} catch (error) {
		if (error instanceof WorkflowDispatchError) throw error;
		throw new WorkflowDispatchError("workflow_readiness_input_mismatch");
	}
}

function isValidWorkerCapabilityAttestation(
	value: WorkflowWorkerCapabilityAttestation | null,
	input: WorkflowCanonicalDispatchInput,
): value is WorkflowWorkerCapabilityAttestation {
	if (
		value === null ||
		typeof value !== "object" ||
		value.kind !== "workflow_worker_capability_attestation" ||
		value.workflowId !== input.workflowId ||
		!isNonEmptyString(value.artifactRoot) ||
		!isNonEmptyString(value.workerEntrypoint) ||
		!isNonEmptyString(value.runtimeVersion) ||
		value.runtimeVersion !== input.runtimeVersion ||
		!isNonEmptyString(value.hostCapabilityRevision) ||
		value.hostCapabilityRevision !== input.hostCapabilityRevision ||
		!isNonEmptyString(value.runtimeDigest) ||
		(value.platformGroupKind !== "posix_process_group" && value.platformGroupKind !== "windows_job_object") ||
		value.canSpawnDetached !== true ||
		!isNonEmptyString(value.artifactDigest) ||
		!isNonEmptyString(value.signature) ||
		!isNonEmptyString(value.signingKeyId)
	) {
		return false;
	}
	try {
		assertWorkflowRuntimeVersion(value.runtimeVersion);
		assertSameEpoch(value.epochRef, input.epochRef);
		assertArtifactRef(value.artifactRef);
	} catch {
		return false;
	}
	return value.artifactDigest === value.artifactRef.digest;
}

function assertRevisionBoundaryMatchesInput(
	boundary: WorkflowRevisionBoundaryContext,
	input: WorkflowCanonicalDispatchInput,
): void {
	try {
		if (
			digestObject(boundary.leaseRef) !== digestObject(input.rootLeaseRef) ||
			digestObject(boundary.revisionTuple) !== digestObject(input.revisionTuple) ||
			digestObject(boundary.revisionRegistryRef) !== digestObject(input.revisionRegistryRef) ||
			boundary.revisionRegistryDigest !== input.revisionRegistryDigest ||
			boundary.configSnapshotDigest !== input.configSnapshotDigest
		) {
			throw new WorkflowDispatchError("workflow_revision_boundary_mismatch");
		}
	} catch (error) {
		if (error instanceof WorkflowDispatchError) throw error;
		throw new WorkflowDispatchError("workflow_revision_boundary_mismatch");
	}
}

function isApprovedDispatchConfiguration(value: unknown): value is WorkflowApprovedDispatchConfiguration {
	return (
		isRecord(value) &&
		isRecord(value.snapshot) &&
		isRecord(value.envelope) &&
		isRecord(value.decisionRef) &&
		isRecord(value.configArtifactRef) &&
		isRecord(value.canonicalAdmissionBundleRef) &&
		isRecord(value.canonicalAdmissionBundle) &&
		isNonEmptyString(value.canonicalAdmissionBundleDigest)
	);
}

function parseCanonicalArtifactRecord(bytes: Readonly<Uint8Array>): Record<string, unknown> | null {
	try {
		const parsed: unknown = parseCanonicalJsonBytes(new Uint8Array(bytes));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function verifyWorkflowRootArtifact(
	bytes: Readonly<Uint8Array>,
	input: WorkflowCanonicalDispatchInput,
	canonicalArtifactRoot: string,
): boolean {
	const root = parseCanonicalArtifactRecord(bytes);
	if (root === null) return false;
	const epoch = root.epochRef;
	const rootPath = root.artifactRoot ?? root.canonicalArtifactRoot;
	return (
		root.workflowId === input.workflowId &&
		root.rootSessionId === input.rootSessionId &&
		rootPath === canonicalArtifactRoot &&
		isRecord(epoch) &&
		epoch.storeEpoch === input.epochRef.storeEpoch &&
		epoch.coordinatorEpoch === input.epochRef.coordinatorEpoch
	);
}

async function verifyAuthenticatedDispatchArtifacts(
	input: WorkflowReadinessInput,
	dependencies: WorkflowDispatchReadinessDependencies,
	approved: WorkflowApprovedDispatchConfiguration | null,
	artifactRoot: string,
	canonicalArtifactRoot: string,
): Promise<boolean> {
	if (
		approved === null ||
		dependencies.artifactResolver === undefined ||
		dependencies.rootArtifactRef === undefined ||
		dependencies.verifyArtifactRoot === undefined
	)
		return false;
	const dispatch = input.canonicalInput;
	try {
		const rootRef = await dependencies.rootArtifactRef(dispatch.workflowId, dispatch.epochRef);
		if (rootRef === null) return false;
		const rootBytes = await resolveCanonicalDispatchArtifact(rootRef, dependencies.artifactResolver);
		if (!verifyWorkflowRootArtifact(rootBytes, dispatch, canonicalArtifactRoot)) return false;
		if (!(await dependencies.verifyArtifactRoot(dispatch))) return false;
		if (
			digestObject(approved.canonicalAdmissionBundleRef) !== digestObject(dispatch.canonicalAdmissionBundleRef) ||
			approved.canonicalAdmissionBundleDigest !== dispatch.canonicalAdmissionBundleDigest ||
			digestObject(approved.envelope) !== digestObject(dispatch.canonicalAdmissionBundle.envelope) ||
			digestObject(approved.snapshot) !== digestObject(dispatch.canonicalAdmissionBundle.snapshot) ||
			digestObject(approved.decisionRef) !== digestObject(dispatch.decisionRef) ||
			approved.snapshot.resolvedConfigDigest !== dispatch.configSnapshotDigest
		)
			return false;
		const bundleBytes = await resolveCanonicalDispatchArtifact(
			approved.canonicalAdmissionBundleRef,
			dependencies.artifactResolver,
		);
		const persistedBundle = parseCanonicalArtifactRecord(bundleBytes);
		if (
			persistedBundle === null ||
			digestObject(persistedBundle) !== approved.canonicalAdmissionBundleDigest ||
			digestObject(persistedBundle) !== digestObject(dispatch.canonicalAdmissionBundle)
		)
			return false;
		const canonicalBundle = dispatch.canonicalAdmissionBundle;
		if (
			!isRecord(canonicalBundle.ledger) ||
			!isRecord(canonicalBundle.grantLedger) ||
			!isRecord(canonicalBundle.grantLedger.canonical) ||
			!isRecord(canonicalBundle.grant) ||
			!isRecord(canonicalBundle.resourceLease) ||
			!isRecord(canonicalBundle.resourceLease.resourceAdmission)
		)
			return false;
		const authenticatedRefs: WorkflowArtifactRef[] = [dispatch.canonicalAdmissionBundleRef];
		for (const ref of Object.values(canonicalBundle.refs)) authenticatedRefs.push(ref);
		for (const value of [
			canonicalBundle.ledger.artifactRef,
			canonicalBundle.grantLedger.canonical.canonicalLedgerRef,
			canonicalBundle.grant.canonicalPoolLedgerRef,
			canonicalBundle.envelope.canonicalLedgerRef,
			canonicalBundle.resourceLease.resourceAdmission.canonicalLedgerRef,
			approved.configArtifactRef,
			approved.envelope.providerQuotaSnapshotRef,
			approved.snapshot.closureManifestRef,
		]) {
			assertArtifactRef(value);
			authenticatedRefs.push(value);
		}
		const seenRefs = new Set<string>();
		for (const ref of authenticatedRefs) {
			const key = `${ref.artifactId}:${ref.digest}:${ref.sizeBytes}`;
			if (seenRefs.has(key)) continue;
			seenRefs.add(key);
			await resolveCanonicalDispatchArtifact(ref, dependencies.artifactResolver);
		}
		const configBytes = await resolveCanonicalDispatchArtifact(
			approved.configArtifactRef,
			dependencies.artifactResolver,
		);
		if (parseCanonicalArtifactRecord(configBytes) === null) return false;
		const quotaBytes = await resolveCanonicalDispatchArtifact(
			approved.envelope.providerQuotaSnapshotRef,
			dependencies.artifactResolver,
		);
		if (parseCanonicalArtifactRecord(quotaBytes) === null) return false;
		const closureBytes = await resolveCanonicalDispatchArtifact(
			approved.snapshot.closureManifestRef,
			dependencies.artifactResolver,
		);
		return parseCanonicalArtifactRecord(closureBytes) !== null && artifactRoot.length > 0;
	} catch {
		return false;
	}
}

function blockedReadiness(
	input: WorkflowReadinessInput,
	checks: WorkflowDispatchReadinessChecks,
	blockingReasons: readonly WorkflowDispatchBlockingReason[],
	child: {
		childSpawnPath: WorkflowDispatchReadiness["childSpawnPath"];
		processStartIdentity: WorkflowDispatchReadiness["processStartIdentity"];
		processGroup: WorkflowDispatchReadiness["processGroup"];
	},
	currentHead: WorkflowJournalHead | null,
	dependencies: WorkflowDispatchReadinessDependencies,
): WorkflowDispatchReadiness {
	const artifactRoot = dependencies.artifactRoot ?? "";
	const canonicalArtifactRoot = dependencies.canonicalArtifactRoot ?? "";
	const artifactRootRelativePath = dependencies.artifactRootRelativePath ?? "";
	const artifactRootPathDigest = dependencies.artifactRootPathDigest ?? "";
	const activeGenerationDigest = dependencies.activeGenerationDigest ?? "";
	const reasons = [...new Set(blockingReasons)];
	const readinessDigest = digestObject({
		workflowId: input.canonicalInput.workflowId,
		epochRef: input.canonicalInput.epochRef,
		rootLeaseRef: input.rootLeaseRef,
		leaseRef: input.leaseRef,
		executionKey: input.executionKey,
		revisionTuple: input.revisionTuple,
		revisionRegistryRef: input.revisionRegistryRef,
		revisionRegistryDigest: input.revisionRegistryDigest,
		configSnapshotDigest: input.configSnapshotDigest,
		artifactRoot,
		canonicalArtifactRoot,
		artifactRootRelativePath,
		artifactRootPathDigest,
		activeGenerationDigest,
		currentHead,
		checks,
		child,
		effectReadiness: input.effectReadiness,
		blockingReasons: reasons,
	});
	return {
		workflowId: input.canonicalInput.workflowId,
		epochRef: input.canonicalInput.epochRef,
		rootLeaseRef: input.rootLeaseRef,
		leaseRef: input.leaseRef,
		executionKey: input.executionKey,
		revisionTuple: input.revisionTuple,
		revisionRegistryRef: input.revisionRegistryRef,
		revisionRegistryDigest: input.revisionRegistryDigest,
		readinessDigest,
		canDispatch: reasons.length === 0,
		childSpawnPath: child.childSpawnPath,
		processStartIdentity: child.processStartIdentity,
		processGroup: child.processGroup,
		artifactRoot,
		canonicalArtifactRoot,
		artifactRootRelativePath,
		artifactRootPathDigest,
		activeGenerationDigest,
		configSnapshotDigest: input.configSnapshotDigest,
		currentHeadDigest: currentHead === null ? "" : digestObject(currentHead),
		currentHead,
		checks,
		blockingReasons: reasons,
		observedAt: dependencies.now?.() ?? "",
	};
}

/** Build the mandatory fail-closed readiness provider without starting a child. */
export function createWorkflowDispatchReadinessProvider(
	dependencies: WorkflowDispatchReadinessDependencies,
): WorkflowDispatchReadinessProvider {
	return {
		observe: async (input): Promise<WorkflowDispatchReadiness> => {
			const dispatch = input.canonicalInput;
			assertReadinessInputMatchesCanonical(input);
			const reasons: WorkflowDispatchBlockingReason[] = [];
			let canonicalInputVerified = true;
			try {
				assertCanonicalDispatchInput(dispatch, input.graph);
			} catch {
				canonicalInputVerified = false;
			}
			let revisionBoundaryVerified = false;
			const revisionBoundary = revisionBoundaryOf(dependencies);
			if (revisionBoundary !== undefined) {
				try {
					const boundary = await assertRevisionBoundary(
						revisionBoundary,
						dispatch.workflowId,
						dispatch.epochRef,
						dispatch.executionKey,
					);
					assertRevisionBoundaryMatchesInput(boundary, dispatch);
					revisionBoundaryVerified = true;
				} catch {
					revisionBoundaryVerified = false;
				}
			}
			let epochGuardVerified = false;
			if (dependencies.epochs !== undefined) {
				try {
					await dependencies.epochs.assertCurrent(dispatch.workflowId, dispatch.epochRef);
					epochGuardVerified = true;
				} catch {
					epochGuardVerified = false;
				}
			}
			let rootLeaseVerified = false;
			if (dependencies.readActiveLeaseContext !== undefined) {
				const active = await dependencies.readActiveLeaseContext().catch(() => null);
				rootLeaseVerified =
					active !== null &&
					active.workflowId === dispatch.workflowId &&
					active.writerIdentity === dispatch.writerIdentity &&
					digestObject(active.leaseRef) === digestObject(dispatch.rootLeaseRef) &&
					digestObject(active.epochRef) === digestObject(dispatch.epochRef);
			}
			let currentEpochVerified = false;
			if (dependencies.readCurrentEpoch !== undefined) {
				const current = await dependencies.readCurrentEpoch(dispatch.workflowId).catch(() => null);
				currentEpochVerified = current !== null && digestObject(current) === digestObject(dispatch.epochRef);
			}
			let currentHead: WorkflowJournalHead | null = null;
			if (dependencies.readCurrentHead !== undefined) {
				const candidate = await dependencies.readCurrentHead(dispatch.workflowId).catch(() => null);
				if (
					candidate !== null &&
					candidate.workflowId === dispatch.workflowId &&
					digestObject(candidate.epochRef) === digestObject(dispatch.epochRef) &&
					Number.isSafeInteger(candidate.sequence) &&
					candidate.sequence >= 0
				) {
					currentHead = candidate;
				}
			}
			let approvedConfigVerified = false;
			let approvedEnvelopeVerified = false;
			let approved:
				| WorkflowApprovedDispatchConfiguration
				| { configSnapshotDigest: string; envelopeDigest: string }
				| null = null;
			if (dependencies.readApprovedConfig !== undefined) {
				approved = await dependencies.readApprovedConfig(dispatch.workflowId, dispatch.epochRef).catch(() => null);
				approvedConfigVerified = isApprovedDispatchConfiguration(approved)
					? approved.snapshot.resolvedConfigDigest === dispatch.configSnapshotDigest
					: approved?.configSnapshotDigest === dispatch.configSnapshotDigest;
				const envelope = isRecord(dispatch.canonicalAdmissionBundle)
					? dispatch.canonicalAdmissionBundle.envelope
					: null;
				approvedEnvelopeVerified =
					(isApprovedDispatchConfiguration(approved)
						? approved.envelope.envelopeDigest
						: approved?.envelopeDigest) !== undefined &&
					isRecord(envelope) &&
					(isApprovedDispatchConfiguration(approved)
						? approved.envelope.envelopeDigest
						: approved?.envelopeDigest) === envelope.envelopeDigest;
			}
			const artifactRoot = dependencies.artifactRoot ?? "";
			const canonicalArtifactRoot = dependencies.canonicalArtifactRoot ?? "";
			const artifactRootRelativePath = dependencies.artifactRootRelativePath ?? "";
			const artifactRootPathDigest = dependencies.artifactRootPathDigest ?? "";
			const activeGenerationDigest = dependencies.activeGenerationDigest ?? "";
			const authenticatedArtifactsVerified = isApprovedDispatchConfiguration(approved)
				? await verifyAuthenticatedDispatchArtifacts(
						input,
						dependencies,
						approved,
						artifactRoot,
						canonicalArtifactRoot,
					)
				: false;
			const artifactRootPathVerified =
				isNonEmptyString(artifactRoot) &&
				isNonEmptyString(canonicalArtifactRoot) &&
				isNonEmptyString(artifactRootRelativePath) &&
				isNonEmptyString(artifactRootPathDigest) &&
				isNonEmptyString(activeGenerationDigest) &&
				dependencies.verifyArtifactRoot !== undefined &&
				(await dependencies.verifyArtifactRoot(dispatch).catch(() => false));
			const artifactRootVerified = artifactRootPathVerified && authenticatedArtifactsVerified;
			const kernelAdapterAvailable =
				dependencies.adapterAvailable !== undefined && (await dependencies.adapterAvailable().catch(() => false));
			const authorityClosureVerified =
				dependencies.authorityClosure !== undefined &&
				(await dependencies
					.authorityClosure({
						workflowId: dispatch.workflowId,
						authority: input.authority,
						task: input.task,
						graph: input.graph,
						epochRef: dispatch.epochRef,
					})
					.catch(() => false));
			const worker =
				dependencies.workerReadiness === undefined
					? { status: "unavailable" as const, artifact: null, capabilityAttestation: null }
					: await dependencies.workerReadiness.observe(dispatch).catch(
							(): WorkflowWorkerReadinessObservation => ({
								status: "unavailable",
								artifact: null,
								capabilityAttestation: null,
							}),
						);
			const workerArtifactVerified =
				worker.status === "verified" &&
				isRecord(worker.artifact) &&
				dependencies.verifyWorkerReadyArtifact !== undefined &&
				(await dependencies.verifyWorkerReadyArtifact(worker.artifact, dispatch, artifactRoot).catch(() => false));
			const workerCapabilityVerified =
				worker.status === "verified" &&
				workerArtifactVerified &&
				isValidWorkerCapabilityAttestation(worker.capabilityAttestation, dispatch) &&
				dependencies.verifyWorkerCapabilityAttestation !== undefined &&
				(await dependencies
					.verifyWorkerCapabilityAttestation(worker.capabilityAttestation, dispatch, artifactRoot)
					.catch(() => false));
			const child =
				worker.status === "verified"
					? {
							childSpawnPath: "separate_process" as const,
							processStartIdentity: workerCapabilityVerified ? ("verified" as const) : ("missing" as const),
							processGroup: workerCapabilityVerified ? ("enforceable" as const) : ("unavailable" as const),
						}
					: {
							childSpawnPath:
								worker.status === "same_process_child_session"
									? ("same_process_rlm" as const)
									: ("unavailable" as const),
							processStartIdentity: "missing" as const,
							processGroup: "unavailable" as const,
						};
			const checks: WorkflowDispatchReadinessChecks = {
				artifactRootVerified,
				rootLeaseVerified,
				currentEpochVerified,
				approvedConfigVerified,
				canonicalAdmissionBundleVerified: canonicalInputVerified && authenticatedArtifactsVerified,
				approvedEnvelopeVerified,
				kernelAdapterAvailable,
				authorityClosureVerified,
				workerCapabilityVerified,
			};
			if (!artifactRootVerified) reasons.push("artifact_root_unavailable");
			if (!revisionBoundaryVerified || !epochGuardVerified) reasons.push("coordinator_epoch_stale");
			if (!rootLeaseVerified) reasons.push("coordinator_epoch_stale");
			if (!currentEpochVerified) reasons.push("coordinator_epoch_stale");
			if (!approvedConfigVerified) reasons.push("config_snapshot_stale");
			if (!canonicalInputVerified || !authenticatedArtifactsVerified || !approvedEnvelopeVerified)
				reasons.push("resource_envelope_unapproved");
			if (!kernelAdapterAvailable) reasons.push("kernel_contract_unavailable");
			if (!authorityClosureVerified) reasons.push("child_authority_invalid");
			if (currentHead === null) reasons.push("coordinator_epoch_stale");
			if (!workerCapabilityVerified)
				reasons.push(
					worker.status === "same_process_child_session"
						? "same_process_child_session"
						: "process_start_identity_unavailable",
				);
			if (child.childSpawnPath === "same_process_rlm") reasons.push("same_process_child_session");
			if (child.processStartIdentity !== "verified") reasons.push("process_start_identity_unavailable");
			if (child.processGroup !== "enforceable") reasons.push("process_group_unenforceable");
			if (!input.effectReadiness.canExecute) reasons.push(...input.effectReadiness.blockingReasons);
			const readiness = blockedReadiness(input, checks, reasons, child, currentHead, {
				...dependencies,
				artifactRoot,
				canonicalArtifactRoot,
				artifactRootRelativePath,
				artifactRootPathDigest,
				activeGenerationDigest,
			});
			if (dependencies.persistReadinessObservation !== undefined && currentHead !== null) {
				try {
					await dependencies.persistReadinessObservation({ readiness, currentHead });
				} catch {
					throw new WorkflowDispatchError("workflow_readiness_observation_persist_failed");
				}
			}
			return readiness;
		},
	};
}

/** Construct the dispatcher that gates canonical input and exposes readiness only. */
export function createWorkflowDispatcher(dependencies: WorkflowDispatcherDependencies): WorkflowDispatcher {
	const boundaryReader = revisionBoundaryReaderOf(dependencies);
	const observe = async (input: WorkflowCanonicalDispatchInput): Promise<WorkflowDispatchReadiness> => {
		const task = dependencies.taskGraph.byId.get(input.taskId);
		if (task === undefined) throw new WorkflowDispatchError("workflow_task_missing_from_graph");
		assertCanonicalDispatchInput(input, dependencies.taskGraph);
		if (boundaryReader === undefined) throw new WorkflowDispatchError("workflow_revision_boundary_unavailable");
		const observedBoundary = await assertRevisionBoundary(
			boundaryReader,
			input.workflowId,
			input.epochRef,
			input.executionKey,
		);
		assertRevisionBoundaryMatchesInput(observedBoundary, input);
		await dependencies.epochs.assertCurrent(input.workflowId, input.epochRef);
		return dependencies.readinessProvider.observe({
			canonicalInput: input,
			rootLeaseRef: input.rootLeaseRef,
			leaseRef: leaseRefOf(input.resourceLease),
			executionKey: input.executionKey,
			revisionTuple: input.revisionTuple,
			revisionRegistryRef: input.revisionRegistryRef,
			revisionRegistryDigest: input.revisionRegistryDigest,
			configSnapshotDigest: input.configSnapshotDigest,
			effectReadiness: dependencies.effectReadiness?.() ?? {
				canExecute: false,
				blockingReasons: ["effect_hook_unbrokered"],
			},
			authority: input.childAuthority,
			task,
			graph: dependencies.taskGraph,
		});
	};
	return {
		observe,
		dispatch: async (input): Promise<WorkflowDispatchResult> => {
			const readiness = await observe(input);
			if (!readiness.canDispatch) return { status: "disabled", phase: "readiness", admission: null, readiness };
			if (dependencies.launchWorker === undefined)
				throw new WorkflowDispatchError("workflow_child_launch_unavailable");
			let launch: WorkflowWorkerLaunchObservation;
			try {
				launch = await dependencies.launchWorker(input, readiness);
				if (
					launch.workflowId !== input.workflowId ||
					launch.taskId !== input.taskId ||
					launch.attemptId !== input.attemptId ||
					launch.executionKey !== input.executionKey ||
					digestObject(launch.epochRef) !== digestObject(input.epochRef)
				)
					throw new WorkflowDispatchError("workflow_child_launch_invalid");
				for (const value of [
					launch.workerId,
					launch.executionIdentity,
					launch.processStartId,
					launch.processGroupId,
					launch.launchedAt,
				])
					assertNonEmptyString(value, "workflow_child_launch_invalid");
				if (!Number.isFinite(Date.parse(launch.launchedAt)))
					throw new WorkflowDispatchError("workflow_child_launch_invalid");
				assertArtifactRef(launch.launchEvidenceRef);
			} catch (error) {
				if (error instanceof WorkflowDispatchError) throw error;
				throw new WorkflowDispatchError("workflow_child_launch_failed");
			}
			const worker: WorkflowWorkerLaunchRecord = Object.freeze({
				...structuredClone(launch),
				launchDigest: digestObject(launch),
			});
			return { status: "launched", phase: "execution", admission: null, readiness, worker };
		},
	};
}
