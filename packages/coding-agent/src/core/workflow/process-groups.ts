import type {
	WorkflowAdmissionLaunchReservation,
	WorkflowAdmissionLaunchReservationReader,
	WorkflowAdmissionLaunchReservationSpawnInput,
	WorkflowAdmissionRegistry,
	WorkflowAdmissionResult,
} from "./admission.js";
import { assertWorkflowAdmissionLaunchReservation } from "./admission.js";
import type {
	WorkflowChildIdentity,
	WorkflowChildProcessBinding,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowProcessGroupIdentity,
	WorkflowProcessSpawnRequest,
	WorkflowRuntimeEventPayload,
	WorkflowRuntimeStore,
	WorkflowSemanticMutationBinding,
	WorkflowStoreCommitInput,
	WorkflowStoreCommitResult,
} from "./contracts.js";
import { digestObject } from "./contracts.js";
import {
	createPosixProcessGroupPlatform,
	readVerifiedPosixProcessGroupIdentity,
	readVerifiedPosixWorkflowProcessGroupIdentity,
} from "./process-groups-posix.js";
import { createWindowsJobObjectPlatform } from "./process-groups-windows.js";

export type { WorkflowProcessGroupIdentity, WorkflowProcessSpawnRequest } from "./contracts.js";
export {
	createPosixProcessGroupPlatform,
	readVerifiedPosixProcessGroupIdentity,
	readVerifiedPosixWorkflowProcessGroupIdentity,
} from "./process-groups-posix.js";
export { createWindowsJobObjectPlatform } from "./process-groups-windows.js";

export interface WorkflowProcessNetworkPolicy {
	readonly mode: "deny" | "allow";
	readonly allowedHosts: readonly string[];
	readonly egressBytes: number;
	readonly enforcement: "host_verified";
}

export interface WorkflowProcessSpawnDescriptor extends WorkflowProcessSpawnRequest {
	readonly shell: false;
	readonly env: Readonly<Record<string, string>>;
	readonly networkPolicy: WorkflowProcessNetworkPolicy;
}

export interface WorkflowProcessContainmentAttestation {
	readonly membershipVerified: true;
	readonly descendantsContained: true;
	readonly killOnClose: true;
	readonly attestationDigest: string;
}

export class WorkflowProcessError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "WorkflowProcessError";
		this.code = code;
	}
}

const FORBIDDEN_ENVIRONMENT_KEYS = new Set([
	"BASH_ENV",
	"CDPATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"ENV",
	"LD_LIBRARY_PATH",
	"LD_PRELOAD",
	"NODE_OPTIONS",
	"PERL5OPT",
	"PYTHONPATH",
	"RUBYOPT",
]);

export function assertWorkflowProcessSpawnDescriptor(request: WorkflowProcessSpawnDescriptor): void {
	if (
		!request.detached ||
		!request.requireProcessStartId ||
		request.shell !== false ||
		request.executable.length === 0 ||
		request.cwd.length === 0 ||
		!Array.isArray(request.arguments) ||
		request.arguments.some((argument) => typeof argument !== "string" || argument.includes("\u0000"))
	)
		throw new WorkflowProcessError("workflow_spawn_descriptor_invalid");
	if (
		request.env === null ||
		typeof request.env !== "object" ||
		Object.getPrototypeOf(request.env) !== Object.prototype
	)
		throw new WorkflowProcessError("workflow_spawn_environment_invalid");
	for (const [key, value] of Object.entries(request.env)) {
		if (
			key.length === 0 ||
			key.includes("=") ||
			key.includes("\u0000") ||
			value.includes("\u0000") ||
			FORBIDDEN_ENVIRONMENT_KEYS.has(key)
		)
			throw new WorkflowProcessError("workflow_spawn_environment_invalid");
	}
	const networkPolicy = request.networkPolicy;
	if (
		networkPolicy === null ||
		typeof networkPolicy !== "object" ||
		(networkPolicy.mode !== "deny" && networkPolicy.mode !== "allow") ||
		networkPolicy.enforcement !== "host_verified" ||
		!Number.isSafeInteger(networkPolicy.egressBytes) ||
		networkPolicy.egressBytes < 0 ||
		!Array.isArray(networkPolicy.allowedHosts) ||
		networkPolicy.allowedHosts.some(
			(host) => typeof host !== "string" || host.length === 0 || host.includes("\u0000"),
		)
	)
		throw new WorkflowProcessError("workflow_network_policy_unavailable");
	if (networkPolicy.mode === "deny" && networkPolicy.egressBytes !== 0)
		throw new WorkflowProcessError("workflow_network_policy_unavailable");
}

export function assertWorkflowProcessContainmentAttestation(
	attestation: WorkflowProcessContainmentAttestation | undefined,
): asserts attestation is WorkflowProcessContainmentAttestation {
	if (
		attestation === undefined ||
		attestation.membershipVerified !== true ||
		attestation.descendantsContained !== true ||
		attestation.killOnClose !== true ||
		typeof attestation.attestationDigest !== "string" ||
		attestation.attestationDigest.length === 0
	)
		throw new WorkflowProcessError("workflow_process_containment_unavailable");
}

export interface WorkflowPlatformProcessIdentity {
	readonly pid: number;
	readonly processStartId: string;
	readonly processGroupId: string;
	readonly platformGroupKind: "posix_process_group" | "windows_job_object";
	readonly platformInspectionDigest: string;
}

export interface WorkflowProcessGroupObservation {
	readonly identity: WorkflowProcessGroupIdentity;
	readonly verified: boolean;
	readonly remainingPids: readonly number[];
	readonly evidenceDigest: string;
	readonly containment?: WorkflowProcessContainmentAttestation;
}

/** Host-authenticated full containment proof shared by admission and recovery. */
export interface WorkflowProcessContainmentVerifier {
	readCurrentHostIdentity(): Promise<WorkflowProcessGroupIdentity>;
	verify(identity: WorkflowProcessGroupIdentity): Promise<WorkflowProcessGroupObservation>;
}

export interface WorkflowProcessContainmentVerifierDependencies {
	readonly platform: WorkflowProcessGroupPlatform;
	readonly readProcessGroupIdentity: (pid: number) => Promise<WorkflowProcessGroupIdentity | null>;
}

export interface WorkflowProcessContainmentHost {
	verifyContainment(): Promise<WorkflowProcessContainmentAttestation>;
	spawnAndAssign(request: WorkflowProcessSpawnDescriptor): Promise<{
		pid: number;
		identity: WorkflowPlatformProcessIdentity;
	}>;
	inspect(
		pid: number,
		processStartId: string,
		processGroupId: string,
		expectedGroupIdentityDigest: string,
	): Promise<WorkflowProcessGroupObservation>;
	terminate(identity: WorkflowProcessGroupIdentity, signal: NodeJS.Signals): Promise<void>;
	reap(identity: WorkflowProcessGroupIdentity): Promise<{
		remainingPids: readonly number[];
		reapDigest: string;
	}>;
	scanGroups(): Promise<readonly WorkflowProcessGroupIdentity[]>;
	quarantine(identity: WorkflowProcessGroupIdentity, workflowRoot: string, reason: string): Promise<void>;
}

export interface WorkflowWindowsJobObjectHost extends WorkflowProcessContainmentHost {}

export interface WorkflowPosixProcessGroupHost extends WorkflowProcessContainmentHost {}

export interface WorkflowProcessGroupPlatform {
	spawn(request: WorkflowProcessSpawnDescriptor): Promise<{
		pid: number;
		identity: WorkflowPlatformProcessIdentity;
	}>;
	inspect(
		pid: number,
		processStartId: string,
		processGroupId: string,
		expectedGroupIdentityDigest: string,
	): Promise<WorkflowProcessGroupObservation>;
	signal(identity: WorkflowProcessGroupIdentity, signal: NodeJS.Signals): Promise<void>;
	reap(identity: WorkflowProcessGroupIdentity): Promise<{
		remainingPids: readonly number[];
		reapDigest: string;
	}>;
	scanGroups(): Promise<readonly WorkflowProcessGroupIdentity[]>;
	quarantineSpawn(identity: WorkflowProcessGroupIdentity, reason: string): Promise<void>;
}

export interface WorkflowProcessGroupPlatformDependencies {
	readonly workflowRoot: string;
	readonly trustedNow?: () => string;
	readonly posixProcessGroupHost?: WorkflowPosixProcessGroupHost;
	readonly windowsJobObjectHost?: WorkflowWindowsJobObjectHost;
}

export interface WorkflowProcessOwnershipReservation {
	readonly reservationId: string;
	readonly reservationDigest: string;
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
	readonly processGroup: WorkflowProcessGroupIdentity;
	readonly currentProcessGroup: WorkflowProcessGroupIdentity;
	readonly launchReservation: WorkflowAdmissionLaunchReservation;
	readonly leaseRef: WorkflowLeaseRef;
}

export interface WorkflowProcessOwnershipReservationInput {
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
	readonly leaseRef: WorkflowLeaseRef;
	readonly requestDigest: string;
	readonly processGroup: WorkflowProcessGroupIdentity;
	readonly currentProcessGroup: WorkflowProcessGroupIdentity;
	readonly launchReservation: WorkflowAdmissionLaunchReservation;
}

export type WorkflowProcessLaunchReservationInput = WorkflowAdmissionLaunchReservationSpawnInput;
export type WorkflowProcessLaunchReservationReader = Pick<
	WorkflowAdmissionLaunchReservationReader,
	"readLaunchReservationForSpawn"
>;

export interface WorkflowProcessEpochManager {
	assertCurrent(workflowId: string, epochRef: WorkflowEpochRef): Promise<void>;
}

export interface WorkflowProcessRevisionBoundaryReader {
	readonly readRevisionBoundaryContext?: (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		executionKey: string | null,
	) => Promise<{
		workflowId: string;
		epochRef: WorkflowEpochRef;
		executionKey: string | null;
		tupleDigest: string;
		leaseRef: WorkflowLeaseRef;
	}>;
	readonly revisionRegistry?: {
		assertActive(context: unknown): Promise<void>;
	};
}

export interface WorkflowOwnedProcessSpawnInput {
	readonly request: WorkflowProcessSpawnDescriptor;
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
}

export interface WorkflowProcessOwnershipMarker {
	readonly workflowId: string;
	readonly attemptId: string;
	readonly processGroupId: string;
	readonly identityDigest: string;
	readonly processStartId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly markerDigest: string;
}

export interface WorkflowUnknownDescendant {
	readonly descendantId: string;
	readonly processGroupId: string | null;
	readonly pid: number | null;
	readonly processStartId: string | null;
	readonly evidenceDigest: string | null;
}

export interface WorkflowProcessGroupControllerDependencies extends WorkflowProcessRevisionBoundaryReader {
	readonly workflowRoot: string;
	readonly processStartId: (pid: number) => string | undefined;
	readonly epochs: WorkflowProcessEpochManager;
	readonly readCurrentStoreEpoch: () => Promise<number>;
	readonly platform: WorkflowProcessGroupPlatform;
	readonly store: WorkflowRuntimeStore;
	readonly workflowId: string;
	readonly writerIdentity: string;
	readonly resolveAttemptLeaseRef: (attemptId: string) => Promise<WorkflowLeaseRef>;
	readonly reserveProcessOwnership: (
		input: WorkflowProcessOwnershipReservationInput,
	) => Promise<WorkflowProcessOwnershipReservation>;
	readonly bindProcessOwnership: (input: {
		readonly reservation: WorkflowProcessOwnershipReservation;
		readonly binding: WorkflowChildProcessBinding;
	}) => Promise<void>;
	readonly quarantineProcessOwnership: (input: {
		readonly reservation: WorkflowProcessOwnershipReservation;
		readonly reason: string;
	}) => Promise<void>;
	readonly readPersistedOwnershipMarkers: (workflowId: string) => Promise<readonly WorkflowProcessOwnershipMarker[]>;
	readonly readPersistedProcessBindings: (workflowId: string) => Promise<readonly WorkflowChildProcessBinding[]>;
	readonly writePersistedOwnershipMarker: (marker: WorkflowProcessOwnershipMarker) => Promise<void>;
	readonly admissionRegistry: Pick<WorkflowAdmissionRegistry, "lookupByExecutionKey">;
	readonly launchReservationReader: WorkflowAdmissionLaunchReservationReader;
}

export interface WorkflowProcessGroupController {
	hydrateFromReplay(): Promise<void>;
	spawn(input: WorkflowOwnedProcessSpawnInput): Promise<{ binding: WorkflowChildProcessBinding }>;
	verify(identity: WorkflowProcessGroupIdentity): Promise<boolean>;
	inspect(identity: WorkflowProcessGroupIdentity): Promise<WorkflowProcessGroupObservation>;
	terminate(identity: WorkflowProcessGroupIdentity, reason: string): Promise<void>;
	reap(identity: WorkflowProcessGroupIdentity): Promise<{
		remainingPids: readonly number[];
		reapDigest: string;
		reapEventSequence: number;
	}>;
	scanUnknownDescendants(workflowId: string): Promise<readonly WorkflowUnknownDescendant[]>;
	quarantine(identity: WorkflowProcessGroupIdentity, reason: string): Promise<void>;
}

export function readCanonicalParentPid(): number {
	if (!Number.isSafeInteger(process.pid) || process.pid <= 0)
		throw new WorkflowProcessError("workflow_parent_pid_unavailable");
	return process.pid;
}

export function canonicalWorkflowPlatformInspectionDigest(
	identity: Omit<WorkflowPlatformProcessIdentity, "platformInspectionDigest">,
): string {
	return digestObject(identity);
}

export function canonicalWorkflowProcessGroupDigest(
	identity: Omit<WorkflowProcessGroupIdentity, "identityDigest"> | WorkflowProcessGroupIdentity,
): string {
	const { identityDigest: _identityDigest, ...unsignedIdentity } = identity as WorkflowProcessGroupIdentity;
	return digestObject(unsignedIdentity);
}

export function canonicalWorkflowIdentityDigest(
	identity: Omit<WorkflowChildIdentity, "identityDigest"> | WorkflowChildIdentity,
): string {
	const { identityDigest: _identityDigest, ...unsignedIdentity } = identity as WorkflowChildIdentity;
	return digestObject(unsignedIdentity);
}

export function canonicalWorkflowBindingDigest(input: {
	readonly childIdentity: WorkflowChildIdentity;
	readonly processGroup: WorkflowProcessGroupIdentity;
}): string {
	return digestObject(input);
}

/**
 * Validate the complete process-group identity before any host operation.
 *
 * Args:
 * identity: Untrusted process-group identity supplied by replay or recovery.
 * Return: Nothing when the identity is canonical and complete.
 */
export function assertWorkflowProcessGroupIdentity(
	identity: unknown,
): asserts identity is WorkflowProcessGroupIdentity {
	if (
		identity === null ||
		typeof identity !== "object" ||
		Array.isArray(identity) ||
		!Number.isSafeInteger((identity as WorkflowProcessGroupIdentity).pid) ||
		(identity as WorkflowProcessGroupIdentity).pid <= 0 ||
		!Number.isSafeInteger((identity as WorkflowProcessGroupIdentity).parentPid) ||
		(identity as WorkflowProcessGroupIdentity).parentPid < 0 ||
		typeof (identity as WorkflowProcessGroupIdentity).processStartId !== "string" ||
		(identity as WorkflowProcessGroupIdentity).processStartId.length === 0 ||
		(identity as WorkflowProcessGroupIdentity).processStartId.includes("\u0000") ||
		typeof (identity as WorkflowProcessGroupIdentity).processGroupId !== "string" ||
		(identity as WorkflowProcessGroupIdentity).processGroupId.length === 0 ||
		(identity as WorkflowProcessGroupIdentity).processGroupId.includes("\u0000") ||
		typeof (identity as WorkflowProcessGroupIdentity).identityDigest !== "string" ||
		(identity as WorkflowProcessGroupIdentity).identityDigest !==
			canonicalWorkflowProcessGroupDigest({
				pid: (identity as WorkflowProcessGroupIdentity).pid,
				processStartId: (identity as WorkflowProcessGroupIdentity).processStartId,
				processGroupId: (identity as WorkflowProcessGroupIdentity).processGroupId,
				parentPid: (identity as WorkflowProcessGroupIdentity).parentPid,
			})
	)
		throw new WorkflowProcessError("workflow_process_identity_invalid");
}

export function workflowProcessGroupIdentityMatches(
	left: WorkflowProcessGroupIdentity,
	right: WorkflowProcessGroupIdentity,
): boolean {
	return (
		left.pid === right.pid &&
		left.processStartId === right.processStartId &&
		left.processGroupId === right.processGroupId &&
		left.parentPid === right.parentPid &&
		left.identityDigest === right.identityDigest
	);
}

export function createWorkflowProcessContainmentVerifier(
	dependencies: WorkflowProcessContainmentVerifierDependencies,
): WorkflowProcessContainmentVerifier {
	const readIdentity = async (pid: number): Promise<WorkflowProcessGroupIdentity> => {
		const identity = await dependencies.readProcessGroupIdentity(pid);
		if (identity === null) throw new WorkflowProcessError("workflow_process_identity_unavailable");
		assertWorkflowProcessGroupIdentity(identity);
		return identity;
	};
	return {
		readCurrentHostIdentity: async (): Promise<WorkflowProcessGroupIdentity> => readIdentity(process.pid),
		verify: async (identity): Promise<WorkflowProcessGroupObservation> => {
			assertWorkflowProcessGroupIdentity(identity);
			const observation = await dependencies.platform.inspect(
				identity.pid,
				identity.processStartId,
				identity.processGroupId,
				identity.identityDigest,
			);
			assertWorkflowProcessContainmentAttestation(observation.containment);
			assertVerifiedProcessGroupObservation(identity, observation);
			return observation;
		},
	};
}

function assertVerifiedProcessGroupObservation(
	identity: WorkflowProcessGroupIdentity,
	observation: WorkflowProcessGroupObservation,
): void {
	try {
		assertWorkflowProcessGroupIdentity(observation.identity);
	} catch {
		throw new WorkflowProcessError("workflow_process_identity_mismatch");
	}
	if (!observation.verified || !workflowProcessGroupIdentityMatches(observation.identity, identity))
		throw new WorkflowProcessError("workflow_process_identity_mismatch");
}

function admissionAuthorizesBinding(
	admission: WorkflowAdmissionResult | undefined,
	binding: WorkflowChildProcessBinding,
): boolean {
	if (admission === undefined || typeof admission !== "object" || admission === null) return false;
	try {
		const { context, processBinding, childIdentity } = admission;
		if (
			context === null ||
			typeof context !== "object" ||
			processBinding === null ||
			typeof processBinding !== "object" ||
			childIdentity === null ||
			typeof childIdentity !== "object" ||
			admission.admissionId !== binding.childIdentity.admissionId ||
			context.workflowId !== binding.workflowId ||
			context.taskId !== binding.taskId ||
			context.attemptId !== binding.attemptId ||
			context.executionKey !== binding.childIdentity.executionKey ||
			context.epochRef.storeEpoch !== binding.childIdentity.epochRef.storeEpoch ||
			context.epochRef.coordinatorEpoch !== binding.childIdentity.epochRef.coordinatorEpoch ||
			context.runtimeVersion !== binding.childIdentity.runtimeVersion ||
			context.hostCapabilityRevision !== binding.childIdentity.hostCapabilityRevision ||
			context.agentRole !== binding.childIdentity.agentRole ||
			context.modelId !== binding.childIdentity.modelId ||
			context.reasoningEffort !== binding.childIdentity.reasoningEffort ||
			context.launchConfigDigest !== binding.childIdentity.launchConfigDigest
		)
			return false;
		return (
			childIdentity.identityDigest === binding.childIdentity.identityDigest &&
			processBinding.workflowId === binding.workflowId &&
			processBinding.taskId === binding.taskId &&
			processBinding.attemptId === binding.attemptId &&
			digestObject(processBinding) === digestObject(binding)
		);
	} catch {
		return false;
	}
}

function admissionMatchesSpawnInput(
	admission: WorkflowAdmissionResult | undefined,
	input: WorkflowOwnedProcessSpawnInput,
): boolean {
	if (admission === undefined || typeof admission !== "object" || admission === null) return false;
	try {
		const context = admission.context as WorkflowAdmissionResult["context"] &
			Pick<
				WorkflowChildIdentity,
				"runtimeVersion" | "hostCapabilityRevision" | "agentRole" | "modelId" | "reasoningEffort"
			>;
		return (
			context !== null &&
			typeof context === "object" &&
			admission.admissionId === input.admissionId &&
			context.workflowId === input.workflowId &&
			context.rootSessionId === input.rootSessionId &&
			context.taskId === input.taskId &&
			context.attemptId === input.attemptId &&
			context.executionKey === input.executionKey &&
			context.epochRef.storeEpoch === input.epochRef.storeEpoch &&
			context.epochRef.coordinatorEpoch === input.epochRef.coordinatorEpoch &&
			context.runtimeVersion === input.runtimeVersion &&
			context.hostCapabilityRevision === input.hostCapabilityRevision &&
			context.agentRole === input.agentRole &&
			context.modelId === input.modelId &&
			context.reasoningEffort === input.reasoningEffort &&
			context.launchConfigDigest === input.launchConfigDigest
		);
	} catch {
		return false;
	}
}

function processSpawnInputMatchesBinding(
	binding: WorkflowChildProcessBinding,
	input: WorkflowOwnedProcessSpawnInput,
): boolean {
	return (
		binding.workflowId === input.workflowId &&
		binding.taskId === input.taskId &&
		binding.attemptId === input.attemptId &&
		binding.childIdentity.admissionId === input.admissionId &&
		binding.childIdentity.childSessionId === input.childSessionId &&
		binding.childIdentity.executionKey === input.executionKey &&
		binding.childIdentity.epochRef.storeEpoch === input.epochRef.storeEpoch &&
		binding.childIdentity.epochRef.coordinatorEpoch === input.epochRef.coordinatorEpoch &&
		binding.childIdentity.runtimeVersion === input.runtimeVersion &&
		binding.childIdentity.hostCapabilityRevision === input.hostCapabilityRevision &&
		binding.childIdentity.agentRole === input.agentRole &&
		binding.childIdentity.modelId === input.modelId &&
		binding.childIdentity.reasoningEffort === input.reasoningEffort &&
		binding.childIdentity.launchConfigDigest === input.launchConfigDigest
	);
}

function assertWorkflowProcessLaunchReservation(
	reservation: unknown,
): asserts reservation is WorkflowAdmissionLaunchReservation {
	try {
		assertWorkflowAdmissionLaunchReservation(reservation);
	} catch {
		throw new WorkflowProcessError("workflow_process_launch_reservation_invalid");
	}
}

function launchReservationMatchesSpawnInput(
	reservation: WorkflowAdmissionLaunchReservation,
	input: WorkflowOwnedProcessSpawnInput,
	requestDigest: string,
): boolean {
	try {
		return (
			reservation.workflowId === input.workflowId &&
			reservation.rootSessionId === input.rootSessionId &&
			reservation.taskId === input.taskId &&
			reservation.attemptId === input.attemptId &&
			reservation.admissionId === input.admissionId &&
			reservation.executionKey === input.executionKey &&
			reservation.nonce === input.nonce &&
			digestObject(reservation.epochRef) === digestObject(input.epochRef) &&
			digestObject(reservation.head) === digestObject(input.head) &&
			reservation.childIdentity.admissionId === input.admissionId &&
			reservation.childIdentity.childSessionId === input.childSessionId &&
			reservation.childIdentity.executionKey === input.executionKey &&
			digestObject(reservation.childIdentity.epochRef) === digestObject(input.epochRef) &&
			reservation.childIdentity.runtimeVersion === input.runtimeVersion &&
			reservation.childIdentity.hostCapabilityRevision === input.hostCapabilityRevision &&
			reservation.childIdentity.agentRole === input.agentRole &&
			reservation.childIdentity.modelId === input.modelId &&
			reservation.childIdentity.reasoningEffort === input.reasoningEffort &&
			reservation.childIdentity.launchConfigDigest === input.launchConfigDigest &&
			reservation.childIdentity.processGroupId === reservation.processGroup.processGroupId &&
			reservation.processGroup.parentPid === readCanonicalParentPid() &&
			requestDigest === digestObject(input.request)
		);
	} catch {
		return false;
	}
}

export function canonicalWorkflowProcessOwnershipReservationDigest(
	reservation: Omit<WorkflowProcessOwnershipReservation, "reservationDigest">,
): string {
	return digestObject(reservation);
}

function ownershipReservationMatchesInput(
	reservation: WorkflowProcessOwnershipReservation,
	input: WorkflowProcessOwnershipReservationInput,
): boolean {
	try {
		const { reservationDigest: _reservationDigest, ...unsigned } = reservation;
		return (
			typeof reservation.reservationId === "string" &&
			reservation.reservationId.length > 0 &&
			typeof reservation.reservationDigest === "string" &&
			reservation.reservationDigest === canonicalWorkflowProcessOwnershipReservationDigest(unsigned) &&
			reservation.workflowId === input.workflowId &&
			reservation.rootSessionId === input.rootSessionId &&
			reservation.taskId === input.taskId &&
			reservation.attemptId === input.attemptId &&
			reservation.admissionId === input.admissionId &&
			reservation.childSessionId === input.childSessionId &&
			reservation.executionKey === input.executionKey &&
			reservation.nonce === input.nonce &&
			digestObject(reservation.epochRef) === digestObject(input.epochRef) &&
			digestObject(reservation.head) === digestObject(input.head) &&
			reservation.runtimeVersion === input.runtimeVersion &&
			reservation.hostCapabilityRevision === input.hostCapabilityRevision &&
			reservation.agentRole === input.agentRole &&
			reservation.modelId === input.modelId &&
			reservation.reasoningEffort === input.reasoningEffort &&
			reservation.launchConfigDigest === input.launchConfigDigest &&
			reservation.requestDigest === input.requestDigest &&
			digestObject(reservation.leaseRef) === digestObject(input.leaseRef) &&
			digestObject(reservation.processGroup) === digestObject(input.processGroup) &&
			digestObject(reservation.currentProcessGroup) === digestObject(input.currentProcessGroup) &&
			digestObject(reservation.launchReservation) === digestObject(input.launchReservation)
		);
	} catch {
		return false;
	}
}

export function createWorkflowProcessGroupPlatform(
	input: WorkflowProcessGroupPlatformDependencies,
): WorkflowProcessGroupPlatform {
	if (input.workflowRoot.length === 0) throw new WorkflowProcessError("workflow_artifact_root_unavailable");
	return process.platform === "win32" ? createWindowsJobObjectPlatform(input) : createPosixProcessGroupPlatform(input);
}

export async function readVerifiedProcessGroupIdentity(pid: number): Promise<WorkflowPlatformProcessIdentity | null> {
	return process.platform === "win32" ? null : readVerifiedPosixProcessGroupIdentity(pid);
}

export async function readVerifiedWorkflowProcessGroupIdentity(
	pid: number,
): Promise<WorkflowProcessGroupIdentity | null> {
	return process.platform === "win32" ? null : readVerifiedPosixWorkflowProcessGroupIdentity(pid);
}

export async function signalVerifiedProcessGroup(
	identity: WorkflowProcessGroupIdentity,
	signal: NodeJS.Signals,
): Promise<void> {
	if (process.platform === "win32") throw new WorkflowProcessError("workflow_platform_unsupported");
	const platform = createPosixProcessGroupPlatform({ workflowRoot: process.cwd() });
	await platform.signal(identity, signal);
}

export async function assertWorkflowProcessRevisionBoundary(
	dependencies: WorkflowProcessRevisionBoundaryReader,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	executionKey: string | null,
): Promise<void> {
	if (dependencies.readRevisionBoundaryContext === undefined) return;
	const context = await dependencies.readRevisionBoundaryContext(workflowId, epochRef, executionKey);
	if (
		context.workflowId !== workflowId ||
		context.epochRef.storeEpoch !== epochRef.storeEpoch ||
		context.epochRef.coordinatorEpoch !== epochRef.coordinatorEpoch ||
		context.executionKey !== executionKey ||
		context.tupleDigest.length === 0
	)
		throw new WorkflowProcessError("workflow_revision_boundary_mismatch");
	if (dependencies.revisionRegistry !== undefined) await dependencies.revisionRegistry.assertActive(context);
}

function markerDigest(marker: Omit<WorkflowProcessOwnershipMarker, "markerDigest">): string {
	return digestObject(marker);
}

function isPersistedProcessBinding(value: unknown): value is WorkflowChildProcessBinding {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Partial<WorkflowChildProcessBinding>;
	const processGroup = candidate.processGroup;
	const childIdentity = candidate.childIdentity;
	if (
		typeof candidate.workflowId !== "string" ||
		typeof candidate.taskId !== "string" ||
		typeof candidate.attemptId !== "string" ||
		typeof candidate.bindingDigest !== "string" ||
		processGroup === undefined ||
		childIdentity === undefined ||
		typeof childIdentity !== "object" ||
		childIdentity === null ||
		typeof childIdentity.admissionId !== "string" ||
		typeof childIdentity.childSessionId !== "string" ||
		typeof childIdentity.executionKey !== "string" ||
		childIdentity.epochRef === null ||
		typeof childIdentity.epochRef !== "object" ||
		!Number.isSafeInteger(childIdentity.epochRef.storeEpoch) ||
		!Number.isSafeInteger(childIdentity.epochRef.coordinatorEpoch) ||
		typeof childIdentity.runtimeVersion !== "string" ||
		typeof childIdentity.hostCapabilityRevision !== "string" ||
		typeof childIdentity.agentRole !== "string" ||
		typeof childIdentity.modelId !== "string" ||
		typeof childIdentity.reasoningEffort !== "string" ||
		typeof childIdentity.launchConfigDigest !== "string" ||
		typeof childIdentity.processGroupId !== "string" ||
		typeof childIdentity.identityDigest !== "string"
	)
		return false;
	try {
		assertWorkflowProcessGroupIdentity(processGroup);
		return (
			childIdentity.identityDigest ===
				canonicalWorkflowIdentityDigest({
					admissionId: childIdentity.admissionId,
					childSessionId: childIdentity.childSessionId,
					executionKey: childIdentity.executionKey,
					epochRef: childIdentity.epochRef,
					runtimeVersion: childIdentity.runtimeVersion,
					hostCapabilityRevision: childIdentity.hostCapabilityRevision,
					agentRole: childIdentity.agentRole,
					modelId: childIdentity.modelId,
					reasoningEffort: childIdentity.reasoningEffort,
					launchConfigDigest: childIdentity.launchConfigDigest,
					processGroupId: childIdentity.processGroupId,
				}) && candidate.bindingDigest === canonicalWorkflowBindingDigest({ childIdentity, processGroup })
		);
	} catch {
		return false;
	}
}

function processGroupOwnedIdempotencyKey(binding: WorkflowChildProcessBinding): string {
	return `process-group-owned:${binding.bindingDigest}`;
}

function processGroupFencedIdempotencyKey(
	attemptId: string,
	identity: WorkflowProcessGroupIdentity,
	reason: string,
): string {
	return `process-group-fenced:${attemptId}:${identity.identityDigest}:${reason}`;
}

function processGroupReapedIdempotencyKey(
	attemptId: string,
	identity: WorkflowProcessGroupIdentity,
	reapDigest: string,
): string {
	return `process-group-reaped:${attemptId}:${identity.processGroupId}:${reapDigest}`;
}

function semanticBinding(input: {
	readonly workflowId: string;
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly idempotencyKey: string;
	readonly writerIdentity: string;
	readonly executionKey: string | null;
	readonly payload: WorkflowEventPayload;
}): WorkflowSemanticMutationBinding {
	const semanticHead = {
		workflowId: input.workflowId,
		sequence: input.expectedHead.sequence,
		eventDigest: input.expectedHead.eventDigest,
		stateDigest: digestObject(input.expectedHead),
		epochRef: input.expectedHead.epochRef,
		generation: 0,
	};
	return {
		mutationId: input.idempotencyKey,
		baselineDigest: digestObject(input.expectedHead),
		expectedGenerations: {},
		ownerId: input.writerIdentity,
		phase: "executing",
		reducerDigest: digestObject({ workflowId: input.workflowId, phase: "executing" }),
		semanticHead,
		expectedHead: input.expectedHead,
		idempotencyKey: input.idempotencyKey,
		executionKey: input.executionKey,
		writerIdentity: input.writerIdentity,
		leaseRef: input.leaseRef,
		epochRef: input.epochRef,
	};
}

export async function commitWorkflowRuntimeEvent<TPayload extends WorkflowRuntimeEventPayload>(
	store: WorkflowRuntimeStore,
	input: {
		readonly workflowId: string;
		readonly payload: TPayload;
		readonly epochRef: WorkflowEpochRef;
		readonly leaseRef: WorkflowLeaseRef;
		readonly idempotencyKey: string;
		readonly writerIdentity: string;
		readonly executionKey: string | null;
	},
): Promise<WorkflowStoreCommitResult<TPayload>> {
	const expectedHead = (
		await store.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		})
	).head;
	const commitInput: WorkflowStoreCommitInput<TPayload> = {
		workflowId: input.workflowId,
		payload: input.payload,
		expectedHead,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		idempotencyKey: input.idempotencyKey,
		writerIdentity: input.writerIdentity,
		executionKey: input.executionKey,
		semanticBinding: semanticBinding({ ...input, expectedHead }),
	};
	return store.commit(commitInput);
}

export function createWorkflowProcessGroupController(
	dependencies: WorkflowProcessGroupControllerDependencies,
): WorkflowProcessGroupController {
	const owned = new Map<string, WorkflowChildProcessBinding>();
	const rejectedAdmissionBindingDigests = new Set<string>();
	const spawnLocks = new Map<string, Promise<void>>();

	const hydrateFromReplay = async (): Promise<void> => {
		const expectedStoreEpoch = await dependencies.readCurrentStoreEpoch();
		const replay = await dependencies.store.replay({
			workflowId: dependencies.workflowId,
			fromSequence: 0,
			expectedStoreEpoch,
		});
		const markers = await dependencies.readPersistedOwnershipMarkers(dependencies.workflowId);
		const bindings = await dependencies.readPersistedProcessBindings(dependencies.workflowId);
		const markerByDigest = new Map(
			markers
				.filter((marker) => {
					if (marker === null || typeof marker !== "object" || typeof marker.markerDigest !== "string")
						return false;
					try {
						const { markerDigest: _markerDigest, ...unsigned } = marker;
						return marker.markerDigest === markerDigest(unsigned);
					} catch {
						return false;
					}
				})
				.map((marker) => [marker.identityDigest, marker] as const),
		);
		const ownedEventEpochs = new Map<string, WorkflowEpochRef>();
		for (const event of replay.events) {
			if (event.payload.kind !== "workflow_process_group_owned") continue;
			ownedEventEpochs.set(
				`${event.payload.attemptId}:${event.payload.processGroup.identityDigest}`,
				event.payload.epochRef,
			);
		}
		owned.clear();
		rejectedAdmissionBindingDigests.clear();
		const conflictedProcessGroupDigests = new Set<string>();
		for (const binding of bindings) {
			if (!isPersistedProcessBinding(binding)) continue;
			const marker = markerByDigest.get(binding.processGroup.identityDigest);
			if (
				marker === undefined ||
				marker.attemptId !== binding.attemptId ||
				marker.processGroupId !== binding.processGroup.processGroupId ||
				marker.processStartId !== binding.processGroup.processStartId ||
				marker.epochRef.storeEpoch !== binding.childIdentity.epochRef.storeEpoch ||
				marker.epochRef.coordinatorEpoch !== binding.childIdentity.epochRef.coordinatorEpoch ||
				binding.workflowId !== dependencies.workflowId ||
				binding.childIdentity.processGroupId !== binding.processGroup.processGroupId ||
				binding.processGroup.identityDigest !==
					canonicalWorkflowProcessGroupDigest({
						pid: binding.processGroup.pid,
						processStartId: binding.processGroup.processStartId,
						processGroupId: binding.processGroup.processGroupId,
						parentPid: binding.processGroup.parentPid,
					}) ||
				binding.childIdentity.identityDigest !==
					canonicalWorkflowIdentityDigest({
						admissionId: binding.childIdentity.admissionId,
						childSessionId: binding.childIdentity.childSessionId,
						executionKey: binding.childIdentity.executionKey,
						epochRef: binding.childIdentity.epochRef,
						runtimeVersion: binding.childIdentity.runtimeVersion,
						hostCapabilityRevision: binding.childIdentity.hostCapabilityRevision,
						agentRole: binding.childIdentity.agentRole,
						modelId: binding.childIdentity.modelId,
						reasoningEffort: binding.childIdentity.reasoningEffort,
						launchConfigDigest: binding.childIdentity.launchConfigDigest,
						processGroupId: binding.childIdentity.processGroupId,
					}) ||
				binding.bindingDigest !==
					canonicalWorkflowBindingDigest({
						childIdentity: binding.childIdentity,
						processGroup: binding.processGroup,
					}) ||
				!ownedEventEpochs.has(`${binding.attemptId}:${binding.processGroup.identityDigest}`) ||
				ownedEventEpochs.get(`${binding.attemptId}:${binding.processGroup.identityDigest}`)?.storeEpoch !==
					binding.childIdentity.epochRef.storeEpoch ||
				ownedEventEpochs.get(`${binding.attemptId}:${binding.processGroup.identityDigest}`)?.coordinatorEpoch !==
					binding.childIdentity.epochRef.coordinatorEpoch
			)
				continue;
			let admission: WorkflowAdmissionResult | undefined;
			try {
				admission = await dependencies.admissionRegistry.lookupByExecutionKey(
					dependencies.workflowId,
					binding.childIdentity.executionKey,
				);
			} catch {
				throw new WorkflowProcessError("workflow_process_admission_registry_unavailable");
			}
			if (!admissionAuthorizesBinding(admission, binding)) {
				rejectedAdmissionBindingDigests.add(binding.processGroup.identityDigest);
				continue;
			}
			try {
				const observation = await dependencies.platform.inspect(
					binding.processGroup.pid,
					binding.processGroup.processStartId,
					binding.processGroup.processGroupId,
					binding.processGroup.identityDigest,
				);
				assertVerifiedProcessGroupObservation(binding.processGroup, observation);
			} catch {
				continue;
			}
			if (conflictedProcessGroupDigests.has(binding.processGroup.identityDigest)) continue;
			const existing = owned.get(binding.processGroup.identityDigest);
			if (existing !== undefined && existing.bindingDigest !== binding.bindingDigest) {
				owned.delete(binding.processGroup.identityDigest);
				conflictedProcessGroupDigests.add(binding.processGroup.identityDigest);
				continue;
			}
			owned.set(binding.processGroup.identityDigest, binding);
		}
	};

	const assertOwnedEpoch = async (identity: WorkflowProcessGroupIdentity): Promise<WorkflowChildProcessBinding> => {
		assertWorkflowProcessGroupIdentity(identity);
		await hydrateFromReplay();
		const binding = owned.get(identity.identityDigest);
		if (binding === undefined) {
			if (rejectedAdmissionBindingDigests.has(identity.identityDigest))
				throw new WorkflowProcessError("workflow_process_admission_binding_missing");
			throw new WorkflowProcessError("workflow_process_group_binding_missing");
		}
		if (!workflowProcessGroupIdentityMatches(binding.processGroup, identity))
			throw new WorkflowProcessError("workflow_process_identity_mismatch");
		await assertWorkflowProcessRevisionBoundary(
			dependencies,
			dependencies.workflowId,
			binding.childIdentity.epochRef,
			binding.childIdentity.executionKey,
		);
		await dependencies.epochs.assertCurrent(dependencies.workflowId, binding.childIdentity.epochRef);
		return binding;
	};

	return {
		hydrateFromReplay,
		async spawn(input): Promise<{ binding: WorkflowChildProcessBinding }> {
			if (input.workflowId !== dependencies.workflowId) throw new WorkflowProcessError("workflow_id_mismatch");
			assertWorkflowProcessSpawnDescriptor(input.request);
			const spawnKey = `${input.attemptId}:${input.executionKey}`;
			const priorSpawn = spawnLocks.get(spawnKey);
			if (priorSpawn !== undefined) await priorSpawn;
			let resolveSpawn!: () => void;
			let rejectSpawn!: (error: unknown) => void;
			let spawnSucceeded = false;
			const currentSpawn = new Promise<void>((resolve, reject) => {
				resolveSpawn = resolve;
				rejectSpawn = reject;
			});
			void currentSpawn.catch(() => undefined);
			spawnLocks.set(spawnKey, currentSpawn);
			try {
				await assertWorkflowProcessRevisionBoundary(
					dependencies,
					input.workflowId,
					input.epochRef,
					input.executionKey,
				);
				await dependencies.epochs.assertCurrent(input.workflowId, input.epochRef);
				await hydrateFromReplay();
				let admission: WorkflowAdmissionResult | undefined;
				try {
					admission = await dependencies.admissionRegistry.lookupByExecutionKey(
						input.workflowId,
						input.executionKey,
					);
				} catch {
					throw new WorkflowProcessError("workflow_process_admission_registry_unavailable");
				}
				if (admission === undefined || !admissionMatchesSpawnInput(admission, input))
					throw new WorkflowProcessError("workflow_process_admission_binding_missing");
				if (admission.status === "quarantined" || admission.terminalEventSequence !== null)
					throw new WorkflowProcessError("workflow_process_admission_terminal");
				const replayCandidates = [...owned.values()].filter(
					(binding) =>
						binding.attemptId === input.attemptId && binding.childIdentity.executionKey === input.executionKey,
				);
				if (replayCandidates.length > 1) throw new WorkflowProcessError("workflow_process_spawn_replay_mismatch");
				const existing = replayCandidates[0];
				if (existing !== undefined) {
					if (!processSpawnInputMatchesBinding(existing, input))
						throw new WorkflowProcessError("workflow_process_spawn_replay_mismatch");
					if (!admissionAuthorizesBinding(admission, existing))
						throw new WorkflowProcessError("workflow_process_admission_binding_missing");
					const observation = await dependencies.platform.inspect(
						existing.processGroup.pid,
						existing.processGroup.processStartId,
						existing.processGroup.processGroupId,
						existing.processGroup.identityDigest,
					);
					assertVerifiedProcessGroupObservation(existing.processGroup, observation);
					resolveSpawn();
					spawnSucceeded = true;
					return { binding: existing };
				}
				if (
					(admission.status !== "admitted" && admission.status !== "starting") ||
					admission.processBinding !== null ||
					admission.childIdentity !== null
				)
					throw new WorkflowProcessError("workflow_process_admission_binding_missing");
				const currentLease = await dependencies.resolveAttemptLeaseRef(input.attemptId);
				const requestDigest = digestObject(input.request);
				const readLaunchReservationForSpawn = dependencies.launchReservationReader.readLaunchReservationForSpawn;
				if (readLaunchReservationForSpawn === undefined)
					throw new WorkflowProcessError("workflow_process_launch_reservation_unavailable");
				const launchReservation = await readLaunchReservationForSpawn({
					workflowId: input.workflowId,
					rootSessionId: input.rootSessionId,
					taskId: input.taskId,
					attemptId: input.attemptId,
					admissionId: input.admissionId,
					childSessionId: input.childSessionId,
					executionKey: input.executionKey,
					nonce: input.nonce,
					epochRef: input.epochRef,
					head: input.head,
					runtimeVersion: input.runtimeVersion,
					hostCapabilityRevision: input.hostCapabilityRevision,
					agentRole: input.agentRole,
					modelId: input.modelId,
					reasoningEffort: input.reasoningEffort,
					launchConfigDigest: input.launchConfigDigest,
					requestDigest,
				});
				if (launchReservation === null)
					throw new WorkflowProcessError("workflow_process_launch_reservation_missing");
				assertWorkflowProcessLaunchReservation(launchReservation);
				if (!launchReservationMatchesSpawnInput(launchReservation, input, requestDigest))
					throw new WorkflowProcessError("workflow_process_launch_reservation_mismatch");
				const reservation = await dependencies.reserveProcessOwnership({
					workflowId: input.workflowId,
					rootSessionId: input.rootSessionId,
					taskId: input.taskId,
					attemptId: input.attemptId,
					admissionId: input.admissionId,
					childSessionId: input.childSessionId,
					executionKey: input.executionKey,
					nonce: input.nonce,
					epochRef: input.epochRef,
					head: input.head,
					runtimeVersion: input.runtimeVersion,
					hostCapabilityRevision: input.hostCapabilityRevision,
					agentRole: input.agentRole,
					modelId: input.modelId,
					reasoningEffort: input.reasoningEffort,
					launchConfigDigest: input.launchConfigDigest,
					leaseRef: currentLease,
					requestDigest,
					processGroup: launchReservation.processGroup,
					currentProcessGroup: launchReservation.currentProcessGroup,
					launchReservation,
				});
				if (
					!ownershipReservationMatchesInput(reservation, {
						workflowId: input.workflowId,
						rootSessionId: input.rootSessionId,
						taskId: input.taskId,
						attemptId: input.attemptId,
						admissionId: input.admissionId,
						childSessionId: input.childSessionId,
						executionKey: input.executionKey,
						nonce: input.nonce,
						epochRef: input.epochRef,
						head: input.head,
						runtimeVersion: input.runtimeVersion,
						hostCapabilityRevision: input.hostCapabilityRevision,
						agentRole: input.agentRole,
						modelId: input.modelId,
						reasoningEffort: input.reasoningEffort,
						launchConfigDigest: input.launchConfigDigest,
						leaseRef: currentLease,
						requestDigest,
						processGroup: launchReservation.processGroup,
						currentProcessGroup: launchReservation.currentProcessGroup,
						launchReservation,
					})
				)
					throw new WorkflowProcessError("workflow_process_ownership_reservation_invalid");
				let spawned: Awaited<ReturnType<WorkflowProcessGroupPlatform["spawn"]>>;
				try {
					spawned = await dependencies.platform.spawn(input.request);
				} catch (error) {
					await dependencies.quarantineProcessOwnership({
						reservation,
						reason: error instanceof Error ? error.message : "workflow_process_spawn_failed",
					});
					throw error;
				}
				const cleanupSpawn = async (reason: string): Promise<void> => {
					const processGroupBase = {
						pid: spawned.pid,
						processStartId: spawned.identity.processStartId,
						processGroupId: spawned.identity.processGroupId,
						parentPid: readCanonicalParentPid(),
					};
					const processGroup: WorkflowProcessGroupIdentity = {
						...processGroupBase,
						identityDigest: canonicalWorkflowProcessGroupDigest(processGroupBase),
					};
					try {
						await dependencies.platform.signal(processGroup, "SIGKILL");
					} catch {
						// Quarantine remains mandatory when the host cannot prove a kill.
					}
					try {
						await dependencies.platform.quarantineSpawn(processGroup, reason);
					} finally {
						await dependencies.quarantineProcessOwnership({ reservation, reason });
					}
				};
				const processStartId = dependencies.processStartId(spawned.pid);
				if (
					processStartId === undefined ||
					processStartId.length === 0 ||
					processStartId !== spawned.identity.processStartId ||
					spawned.identity.processGroupId.length === 0
				) {
					await cleanupSpawn("process_start_identity_unavailable");
					throw new WorkflowProcessError("workflow_process_identity_unavailable");
				}
				const processGroupBase = {
					pid: spawned.pid,
					processStartId,
					processGroupId: spawned.identity.processGroupId,
					parentPid: readCanonicalParentPid(),
				};
				if (
					spawned.pid !== launchReservation.processGroup.pid ||
					processStartId !== launchReservation.processGroup.processStartId ||
					spawned.identity.processGroupId !== launchReservation.processGroup.processGroupId ||
					processGroupBase.parentPid !== launchReservation.processGroup.parentPid
				) {
					await cleanupSpawn("workflow_process_launch_reservation_mismatch");
					throw new WorkflowProcessError("workflow_process_launch_reservation_mismatch");
				}
				const processGroup: WorkflowProcessGroupIdentity = {
					...processGroupBase,
					identityDigest: canonicalWorkflowProcessGroupDigest(processGroupBase),
				};
				const childIdentityBase = {
					admissionId: input.admissionId,
					childSessionId: input.childSessionId,
					executionKey: input.executionKey,
					epochRef: input.epochRef,
					runtimeVersion: input.runtimeVersion,
					hostCapabilityRevision: input.hostCapabilityRevision,
					agentRole: input.agentRole,
					modelId: input.modelId,
					reasoningEffort: input.reasoningEffort,
					launchConfigDigest: input.launchConfigDigest,
					processGroupId: processGroup.processGroupId,
				};
				const childIdentity: WorkflowChildIdentity = {
					...childIdentityBase,
					identityDigest: canonicalWorkflowIdentityDigest(childIdentityBase),
				};
				const binding: WorkflowChildProcessBinding = {
					workflowId: dependencies.workflowId,
					taskId: input.taskId,
					attemptId: input.attemptId,
					childIdentity,
					processGroup,
					bindingDigest: canonicalWorkflowBindingDigest({ childIdentity, processGroup }),
				};
				try {
					await dependencies.bindProcessOwnership({ reservation, binding });
				} catch (error) {
					await cleanupSpawn(error instanceof Error ? error.message : "workflow_process_ownership_bind_failed");
					throw error;
				}
				await assertWorkflowProcessRevisionBoundary(
					dependencies,
					input.workflowId,
					input.epochRef,
					input.executionKey,
				);
				await dependencies.epochs.assertCurrent(input.workflowId, input.epochRef);
				try {
					await commitWorkflowRuntimeEvent(dependencies.store, {
						workflowId: dependencies.workflowId,
						payload: {
							kind: "workflow_process_group_owned",
							workflowId: dependencies.workflowId,
							attemptId: input.attemptId,
							processGroup,
							epochRef: input.epochRef,
						},
						epochRef: input.epochRef,
						leaseRef: currentLease,
						idempotencyKey: processGroupOwnedIdempotencyKey(binding),
						writerIdentity: dependencies.writerIdentity,
						executionKey: input.executionKey,
					});
				} catch (error) {
					await cleanupSpawn(error instanceof Error ? error.message : "workflow_process_group_event_failed");
					throw error;
				}
				const markerWithoutDigest = {
					workflowId: dependencies.workflowId,
					attemptId: input.attemptId,
					processGroupId: processGroup.processGroupId,
					identityDigest: processGroup.identityDigest,
					processStartId: processGroup.processStartId,
					epochRef: input.epochRef,
				};
				try {
					await dependencies.writePersistedOwnershipMarker({
						...markerWithoutDigest,
						markerDigest: markerDigest(markerWithoutDigest),
					});
				} catch (error) {
					await cleanupSpawn(error instanceof Error ? error.message : "workflow_process_marker_failed");
					throw error;
				}
				owned.set(processGroup.identityDigest, binding);
				resolveSpawn();
				spawnSucceeded = true;
				return { binding };
			} catch (error) {
				if (!spawnSucceeded) rejectSpawn(error);
				throw error;
			} finally {
				if (spawnLocks.get(spawnKey) === currentSpawn) spawnLocks.delete(spawnKey);
			}
		},
		verify: async (identity): Promise<boolean> => {
			try {
				assertWorkflowProcessGroupIdentity(identity);
			} catch {
				return false;
			}
			return (
				await dependencies.platform.inspect(
					identity.pid,
					identity.processStartId,
					identity.processGroupId,
					identity.identityDigest,
				)
			).verified;
		},
		inspect: (identity): Promise<WorkflowProcessGroupObservation> =>
			dependencies.platform.inspect(
				identity.pid,
				identity.processStartId,
				identity.processGroupId,
				identity.identityDigest,
			),
		terminate: async (identity, reason): Promise<void> => {
			const binding = await assertOwnedEpoch(identity);
			const observation = await dependencies.platform.inspect(
				identity.pid,
				identity.processStartId,
				identity.processGroupId,
				identity.identityDigest,
			);
			assertVerifiedProcessGroupObservation(identity, observation);
			const currentLease = await dependencies.resolveAttemptLeaseRef(binding.attemptId);
			const idempotencyKey = processGroupFencedIdempotencyKey(binding.attemptId, identity, reason);
			const replay = await dependencies.store.replay({
				workflowId: dependencies.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: binding.childIdentity.epochRef.storeEpoch,
			});
			const alreadyFenced = replay.events.some(
				(event) =>
					event.payload.kind === "workflow_process_group_fenced" && event.idempotencyKey === idempotencyKey,
			);
			if (!alreadyFenced) {
				await assertWorkflowProcessRevisionBoundary(
					dependencies,
					dependencies.workflowId,
					binding.childIdentity.epochRef,
					binding.childIdentity.executionKey,
				);
				await dependencies.epochs.assertCurrent(dependencies.workflowId, binding.childIdentity.epochRef);
				await commitWorkflowRuntimeEvent(dependencies.store, {
					workflowId: dependencies.workflowId,
					payload: {
						kind: "workflow_process_group_fenced",
						workflowId: dependencies.workflowId,
						attemptId: binding.attemptId,
						processGroup: identity,
						epochRef: binding.childIdentity.epochRef,
						reason,
					},
					epochRef: binding.childIdentity.epochRef,
					leaseRef: currentLease,
					idempotencyKey,
					writerIdentity: dependencies.writerIdentity,
					executionKey: binding.childIdentity.executionKey,
				});
			}
			await assertWorkflowProcessRevisionBoundary(
				dependencies,
				dependencies.workflowId,
				binding.childIdentity.epochRef,
				binding.childIdentity.executionKey,
			);
			await dependencies.epochs.assertCurrent(dependencies.workflowId, binding.childIdentity.epochRef);
			await dependencies.platform.signal(identity, reason === "workflow_cancel" ? "SIGTERM" : "SIGKILL");
		},
		reap: async (
			identity,
		): Promise<{
			remainingPids: readonly number[];
			reapDigest: string;
			reapEventSequence: number;
		}> => {
			const binding = await assertOwnedEpoch(identity);
			const result = await dependencies.platform.reap(identity);
			if (result.remainingPids.length !== 0) return { ...result, reapEventSequence: 0 };
			const currentLease = await dependencies.resolveAttemptLeaseRef(binding.attemptId);
			await assertWorkflowProcessRevisionBoundary(
				dependencies,
				dependencies.workflowId,
				binding.childIdentity.epochRef,
				binding.childIdentity.executionKey,
			);
			await dependencies.epochs.assertCurrent(dependencies.workflowId, binding.childIdentity.epochRef);
			const idempotencyKey = processGroupReapedIdempotencyKey(binding.attemptId, identity, result.reapDigest);
			const replay = await dependencies.store.replay({
				workflowId: dependencies.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: binding.childIdentity.epochRef.storeEpoch,
			});
			const existing = replay.events.find(
				(event) =>
					event.payload.kind === "workflow_process_group_reaped" && event.idempotencyKey === idempotencyKey,
			);
			if (existing !== undefined) return { ...result, reapEventSequence: existing.sequence };
			const committed = await commitWorkflowRuntimeEvent(dependencies.store, {
				workflowId: dependencies.workflowId,
				payload: {
					kind: "workflow_process_group_reaped",
					workflowId: dependencies.workflowId,
					attemptId: binding.attemptId,
					processGroupId: identity.processGroupId,
					epochRef: binding.childIdentity.epochRef,
					remainingPids: result.remainingPids,
					reapDigest: result.reapDigest,
				},
				epochRef: binding.childIdentity.epochRef,
				leaseRef: currentLease,
				idempotencyKey,
				writerIdentity: dependencies.writerIdentity,
				executionKey: binding.childIdentity.executionKey,
			});
			return { ...result, reapEventSequence: committed.commit.sequence };
		},
		scanUnknownDescendants: async (workflowId): Promise<readonly WorkflowUnknownDescendant[]> => {
			if (workflowId !== dependencies.workflowId) return [];
			await hydrateFromReplay();
			const markers = await dependencies.readPersistedOwnershipMarkers(workflowId);
			const markerGroupIds = new Set(
				markers
					.filter((marker) => {
						const { markerDigest: _markerDigest, ...unsigned } = marker;
						return marker.markerDigest === markerDigest(unsigned);
					})
					.map((marker) => marker.processGroupId),
			);
			const observed = await dependencies.platform.scanGroups();
			return observed
				.filter((identity) => markerGroupIds.has(identity.processGroupId) && !owned.has(identity.identityDigest))
				.map((identity) => ({
					descendantId: `process-group:${identity.identityDigest}`,
					processGroupId: identity.processGroupId,
					pid: identity.pid,
					processStartId: identity.processStartId,
					evidenceDigest: digestObject(identity),
				}));
		},
		quarantine: async (identity, reason): Promise<void> => {
			const binding = await assertOwnedEpoch(identity);
			const observation = await dependencies.platform.inspect(
				identity.pid,
				identity.processStartId,
				identity.processGroupId,
				identity.identityDigest,
			);
			assertVerifiedProcessGroupObservation(identity, observation);
			const epochRef = binding.childIdentity.epochRef;
			await assertWorkflowProcessRevisionBoundary(
				dependencies,
				dependencies.workflowId,
				epochRef,
				binding?.childIdentity.executionKey ?? null,
			);
			await dependencies.epochs.assertCurrent(dependencies.workflowId, epochRef);
			await dependencies.platform.quarantineSpawn(identity, reason);
		},
	};
}
