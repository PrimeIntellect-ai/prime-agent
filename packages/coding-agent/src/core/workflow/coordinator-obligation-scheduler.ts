import type { ChildAttemptState, ChildCoordinatorWakeKind } from "../child-output-contract.js";
import type {
	WorkflowArtifactRef,
	WorkflowEpochRef,
	WorkflowHostPrincipalCapabilityAuthorization,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowRuntimeStore,
} from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes, sameWorkflowLeaseIdentity } from "./contracts.js";
import { assertWorkflowRuntimeVersion } from "./runtime-store-adapter.js";

const COORDINATOR_OBLIGATION_RECORD = "coordinator-obligation-scheduler-v2.json";
const COORDINATOR_OBLIGATION_STATE_VERSION = 2 as const;
const COORDINATOR_OBLIGATION_RECORD_VERSION = 1 as const;
const MAX_PARKED_OBLIGATIONS = 64;
const MAX_WAKE_KEYS_PER_PARK = 8;
const MAX_WAKE_KEYS_PER_EPISODE = 32;
const MAX_WAKE_FAILURE_DIAGNOSTICS = 3;
const MAX_LOCAL_SNAPSHOT_BYTES = 1_048_576;
const MAX_SCHEDULER_RECORD_BYTES = 4 * 1_048_576;
const MAX_SCHEDULER_STRING_BYTES = 256;
const MAX_SCHEDULER_REASON_BYTES = 512;
const DEFAULT_DIAGNOSTIC = "deadline_expired" as const;
const WAKE_FAILURE_DIAGNOSTIC = "wake_delivery_failed" as const;

export const COORDINATOR_OBLIGATION_HOST_CAPABILITY = "workflow_coordinator_obligation_scheduler" as const;

export interface CoordinatorObligationTrustedTime {
	readonly monotonicMilliseconds: number;
	readonly wallTime: string;
}

export type CoordinatorObligationWakeKind = ChildCoordinatorWakeKind;

export type CoordinatorObligationDeadlineStatus =
	| "pending"
	| "expired"
	| "discharged"
	| "cancelled"
	| "terminal_failed"
	| "scope_changed";

export type CoordinatorObligationActivityKind = "heartbeat" | "whitespace" | "activity" | "compaction_progress";

export type CoordinatorObligationOperation =
	| "park"
	| "snapshot"
	| "child_output"
	| "activity"
	| "deadline_expiry"
	| "wake_claim"
	| "wake_acknowledge"
	| "wake_failure"
	| "safe_boundary"
	| "retention_gc";

export interface CoordinatorObligationParkBinding {
	readonly parkId: string | null;
	readonly parentId: string;
	readonly childId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly outputObligationId: string;
	readonly baseHead: WorkflowJournalHead;
	readonly independentReadyWork: boolean;
}

export interface CoordinatorObligationChildOutputRecord {
	readonly eventId: string;
	readonly stateDigest: string;
	readonly head: WorkflowJournalHead;
	readonly independentReadyWork: boolean;
	readonly wakeKey: string | null;
	readonly wakeKind: CoordinatorObligationWakeKind | null;
	readonly terminalStatus: Exclude<CoordinatorObligationDeadlineStatus, "pending" | "expired">;
	readonly terminalReason: string;
}

export interface CoordinatorObligationAuthorizationContext {
	readonly capability: typeof COORDINATOR_OBLIGATION_HOST_CAPABILITY;
	readonly operation: CoordinatorObligationOperation;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly currentHead: WorkflowJournalHead;
	readonly recordRevision: number;
	readonly stateDigest: string;
	readonly park: CoordinatorObligationParkBinding | null;
	readonly childStateDigest: string | null;
	readonly baseHead: WorkflowJournalHead | null;
	readonly independentReadyWork: boolean | null;
	readonly childOutputDigest: string | null;
}

export interface CoordinatorObligationRecordSealInput {
	readonly recordName: string;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly revision: number;
	readonly payload: Readonly<Uint8Array>;
	readonly previousPayloadDigest: string | null;
}

export interface CoordinatorObligationRecordAuthority {
	seal(input: CoordinatorObligationRecordSealInput): Promise<{
		readonly mac: string;
		readonly receiptDigest: string;
	}>;
	verify(
		input: CoordinatorObligationRecordSealInput & { readonly mac: string; readonly receiptDigest: string },
	): Promise<void>;
	compareAndSwap(input: {
		readonly recordName: string;
		readonly expectedRevision: number | null;
		readonly nextRevision: number;
		readonly recordBytes: Readonly<Uint8Array>;
		readonly leaseRef: WorkflowLeaseRef;
	}): Promise<void>;
}

export interface CoordinatorObligationHostAdapter {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly runtimeVersion: string;
	readonly maxWaitMilliseconds: number;
	readonly capability: WorkflowHostPrincipalCapabilityAuthorization;
	readonly readTrustedTime: () => CoordinatorObligationTrustedTime | Promise<CoordinatorObligationTrustedTime>;
	readonly readCurrentLeaseRef: () => WorkflowLeaseRef;
	readonly readCurrentHead: () => WorkflowJournalHead | Promise<WorkflowJournalHead>;
	readonly readChildAttemptState: (input: {
		readonly attemptId: string;
		readonly childId: string;
		readonly outputObligationId: string;
	}) => ChildAttemptState | null | Promise<ChildAttemptState | null>;
	readonly authorize: (
		input: CoordinatorObligationAuthorizationContext,
	) => Promise<WorkflowHostPrincipalCapabilityAuthorization>;
	readonly readRetentionWatermark: () => number | Promise<number>;
	readonly recordAuthority: CoordinatorObligationRecordAuthority;
}

export interface CoordinatorObligationDeadlinePolicy {
	readonly durationMilliseconds: number;
	readonly maxWaitMilliseconds: number;
	readonly startedAtMonotonicMilliseconds: number;
	readonly startedAtWallTime: string;
	readonly deadlineAtMonotonicMilliseconds: number;
	readonly deadlineAtWallTime: string;
}

export interface CoordinatorObligationDeadlineTransition {
	readonly status: CoordinatorObligationDeadlineStatus;
	readonly transitionEventId: string | null;
	readonly transitionReason: string | null;
}

export interface CoordinatorObligationLocalSnapshot {
	readonly digest: string;
	readonly ref: string | WorkflowArtifactRef;
	readonly sizeBytes: number;
}

export interface CoordinatorObligationActivity {
	readonly kind: CoordinatorObligationActivityKind;
	readonly stateDigest: string;
	readonly progressDigest: string | null;
	readonly observedAt: CoordinatorObligationTrustedTime;
}

export interface CoordinatorObligationWakeRecord {
	readonly deliveryId: string;
	readonly parkId: string;
	readonly attemptId: string;
	readonly wakeKey: string;
	readonly kind: CoordinatorObligationWakeKind;
	readonly createdByEventId: string;
	readonly episodeId: string | null;
}

export interface CoordinatorObligationParkToken {
	readonly parkId: string;
	readonly workflowId: string;
	readonly parentId: string;
	readonly childId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly outputObligationId: string;
	readonly baseHead: WorkflowJournalHead;
	readonly baseEpoch: WorkflowEpochRef;
	readonly stateDigest: string;
	readonly latestStateDigest: string;
	readonly independentReadyWork: boolean;
	readonly deadlinePolicy: CoordinatorObligationDeadlinePolicy;
	readonly deadline: CoordinatorObligationDeadlineTransition;
	readonly terminalRetentionRevision: number | null;
	readonly snapshot: CoordinatorObligationLocalSnapshot | null;
	readonly activity: CoordinatorObligationActivity | null;
	readonly childOutput: CoordinatorObligationChildOutputRecord | null;
	readonly quarantineReason: string | null;
	readonly wakes: readonly CoordinatorObligationWakeRecord[];
}

export type CoordinatorObligationWakeEpisodeStatus = "pending" | "claimed" | "acknowledged" | "stalled";

export interface CoordinatorObligationWakeRef {
	readonly deliveryId: string;
	readonly parkId: string;
	readonly attemptId: string;
	readonly wakeKey: string;
	readonly outputObligationId: string;
	readonly kind: CoordinatorObligationWakeKind;
	readonly createdByEventId: string;
}

export interface CoordinatorObligationWakeClaim {
	readonly claimId: string;
	readonly leaseRef: WorkflowLeaseRef;
	readonly claimedAt: CoordinatorObligationTrustedTime;
}

export interface CoordinatorObligationWakeEpisode {
	readonly episodeId: string;
	readonly wakeRefs: readonly CoordinatorObligationWakeRef[];
	readonly wakeKeys: readonly string[];
	readonly outputObligationIds: readonly string[];
	readonly priority: "normal" | "urgent";
	readonly status: CoordinatorObligationWakeEpisodeStatus;
	readonly claim: CoordinatorObligationWakeClaim | null;
	readonly safeBoundaryHandled: boolean;
	readonly packetDigest: string;
	readonly failureCount: number;
	readonly diagnostic: string | null;
}

export interface CoordinatorObligationSchedulerState {
	readonly version: typeof COORDINATOR_OBLIGATION_STATE_VERSION;
	readonly workflowId: string;
	readonly generationId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly nextWakeEpisodeSequence: number;
	readonly parks: readonly CoordinatorObligationParkToken[];
	readonly wakeEpisodes: readonly CoordinatorObligationWakeEpisode[];
	readonly urgentBoundaryPending: boolean;
	readonly urgentDiagnostic: string | null;
	readonly diagnosticCount: number;
	readonly stateDigest: string;
}

export interface CoordinatorObligationParkInput {
	readonly parentId: string;
	readonly childId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly outputObligationId: string;
	readonly baseHead: WorkflowJournalHead;
	readonly baseEpoch: WorkflowEpochRef;
	readonly stateDigest: string;
	readonly deadlineMilliseconds?: number;
	readonly independentReadyWork: boolean;
}

export interface CoordinatorObligationParkFromChildInput {
	readonly parentId: string;
	readonly child: ChildAttemptState;
	readonly deadlineMilliseconds?: number;
	readonly independentReadyWork: boolean;
}

export interface CoordinatorObligationSnapshotInput {
	readonly outputObligationId: string;
	readonly digest: string;
	readonly ref: string | WorkflowArtifactRef;
	readonly sizeBytes: number;
}

export interface CoordinatorObligationChildOutputInput {
	readonly outputObligationId: string;
	readonly stateDigest: string;
	readonly eventId: string;
	readonly head: WorkflowJournalHead;
	readonly independentReadyWork?: boolean;
	readonly wakeKey?: string | null;
	readonly wakeKind?: CoordinatorObligationWakeKind;
	readonly terminalStatus?: Exclude<CoordinatorObligationDeadlineStatus, "pending" | "expired">;
	readonly terminalReason?: string;
}

export interface CoordinatorObligationChildOutputFromChildInput {
	readonly child: ChildAttemptState;
}

export interface CoordinatorObligationActivityInput {
	readonly outputObligationId: string;
	readonly stateDigest: string;
	readonly kind: CoordinatorObligationActivityKind;
	readonly progressDigest?: string | null;
	readonly independentReadyWork?: boolean;
}

export interface CoordinatorModelTurnAdmission {
	readonly status: "parked" | "admitted";
	readonly reason: "child_obligation" | "no_parked_obligation";
	readonly parkIds: readonly string[];
	readonly outputObligationIds: readonly string[];
	readonly independentDispatchAllowed: boolean;
	readonly unrelatedWorkflowDispatchAllowed: boolean;
}

export interface CoordinatorObligationSchedulerStatus {
	readonly status: "working" | "waiting_on_children" | "idle";
	readonly pendingObligationCount: number;
	readonly independentReadyWork: boolean;
	readonly pendingWake: boolean;
	readonly urgentDiagnostic: string | null;
}

export interface CoordinatorObligationWakePacket {
	readonly episodeId: string;
	readonly claimId: string;
	readonly wakeRefs: readonly CoordinatorObligationWakeRef[];
	readonly wakeKeys: readonly string[];
	readonly outputObligationIds: readonly string[];
	readonly priority: "normal" | "urgent";
	readonly packetDigest: string;
	readonly diagnostic: string | null;
}

export interface CoordinatorObligationScheduler {
	parkChildObligation(input: CoordinatorObligationParkInput): Promise<CoordinatorObligationParkToken>;
	parkChildAttempt(input: CoordinatorObligationParkFromChildInput): Promise<CoordinatorObligationParkToken>;
	recordLocalSnapshot(input: CoordinatorObligationSnapshotInput): Promise<"recorded" | "already_recorded">;
	recordChildOutput(input: CoordinatorObligationChildOutputInput): Promise<CoordinatorObligationWakeEpisode | null>;
	recordChildAttemptOutput(
		input: CoordinatorObligationChildOutputFromChildInput,
	): Promise<CoordinatorObligationWakeEpisode | null>;
	observeChildActivity(input: CoordinatorObligationActivityInput): Promise<void>;
	onHostTimer(): Promise<CoordinatorObligationSchedulerState>;
	modelTurnAdmission(): Promise<CoordinatorModelTurnAdmission>;
	admitIndependentDispatch(): Promise<{ readonly allowed: true }>;
	claimWake(): Promise<CoordinatorObligationWakePacket | null>;
	acknowledgeWake(input: { readonly episodeId: string; readonly claimId: string }): Promise<void>;
	handleUrgentSafeBoundary(input: { readonly episodeId: string }): Promise<void>;
	recordWakeFailure(input: {
		readonly episodeId: string;
		readonly claimId: string;
		readonly reason: string;
	}): Promise<void>;
	readState(): Promise<CoordinatorObligationSchedulerState>;
	status(): Promise<CoordinatorObligationSchedulerStatus>;
}

interface CoordinatorObligationPersistedRecord {
	readonly version: typeof COORDINATOR_OBLIGATION_RECORD_VERSION;
	readonly revision: number;
	readonly previousPayloadDigest: string | null;
	readonly payload: readonly number[];
	readonly payloadDigest: string;
	readonly mac: string;
	readonly receiptDigest: string;
}

interface CoordinatorObligationLoadedRecord {
	readonly state: CoordinatorObligationSchedulerState;
	readonly revision: number;
	readonly payloadDigest: string;
}

interface CoordinatorObligationMutationResult<TValue> {
	readonly state: CoordinatorObligationSchedulerState;
	readonly value: TValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	const allowed = new Set(keys);
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("coordinator_obligation_state_invalid");
}

function assertNonEmptyString(
	value: unknown,
	label: string,
	maxBytes = MAX_SCHEDULER_STRING_BYTES,
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes)
		throw new Error(`${label}_invalid`);
}

function assertSafeInteger(value: unknown, label: string, minimum: number): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label}_invalid`);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function assertEpoch(epochRef: WorkflowEpochRef): void {
	if (!Number.isSafeInteger(epochRef.storeEpoch) || epochRef.storeEpoch < 1)
		throw new Error("coordinator_obligation_epoch_invalid");
	if (!Number.isSafeInteger(epochRef.coordinatorEpoch) || epochRef.coordinatorEpoch < 1)
		throw new Error("coordinator_obligation_epoch_invalid");
}

function assertTrustedTime(value: CoordinatorObligationTrustedTime): CoordinatorObligationTrustedTime {
	if (
		!Number.isSafeInteger(value.monotonicMilliseconds) ||
		value.monotonicMilliseconds < 0 ||
		typeof value.wallTime !== "string" ||
		!Number.isFinite(Date.parse(value.wallTime))
	)
		throw new Error("coordinator_obligation_trusted_time_invalid");
	return { monotonicMilliseconds: value.monotonicMilliseconds, wallTime: value.wallTime };
}

function assertHead(head: WorkflowJournalHead, workflowId: string, epochRef: WorkflowEpochRef): void {
	if (
		head.workflowId !== workflowId ||
		!Number.isSafeInteger(head.sequence) ||
		head.sequence < 0 ||
		(head.eventDigest !== null && typeof head.eventDigest !== "string") ||
		!sameEpoch(head.epochRef, epochRef)
	)
		throw new Error("coordinator_obligation_head_invalid");
}

function sameHead(left: WorkflowJournalHead, right: WorkflowJournalHead): boolean {
	return (
		left.workflowId === right.workflowId &&
		left.sequence === right.sequence &&
		left.eventDigest === right.eventDigest &&
		sameEpoch(left.epochRef, right.epochRef)
	);
}

function assertHeadLineage(
	baseHead: WorkflowJournalHead,
	childHead: WorkflowJournalHead,
	currentHead: WorkflowJournalHead,
): void {
	if (childHead.sequence < baseHead.sequence || childHead.sequence > currentHead.sequence)
		throw new Error("coordinator_obligation_head_lineage_invalid");
	if (childHead.sequence === baseHead.sequence && childHead.eventDigest !== baseHead.eventDigest)
		throw new Error("coordinator_obligation_head_lineage_invalid");
	if (childHead.sequence === currentHead.sequence && childHead.eventDigest !== currentHead.eventDigest)
		throw new Error("coordinator_obligation_head_lineage_invalid");
}

function assertLease(leaseRef: WorkflowLeaseRef, epochRef: WorkflowEpochRef): void {
	if (
		!sameEpoch(leaseRef, epochRef) ||
		!leaseRef.leaseId ||
		!leaseRef.processIdentity ||
		!leaseRef.writerIdentity ||
		!Number.isSafeInteger(leaseRef.acquisitionEventSequence) ||
		leaseRef.acquisitionEventSequence < 0 ||
		!Number.isFinite(Date.parse(leaseRef.acquiredAt)) ||
		!Number.isFinite(Date.parse(leaseRef.expiresAt))
	)
		throw new Error("coordinator_obligation_lease_fenced");
}

function leaseAlive(leaseRef: WorkflowLeaseRef, now: CoordinatorObligationTrustedTime): boolean {
	return Date.parse(leaseRef.expiresAt) > Date.parse(now.wallTime);
}

function wallDeadline(startedAtWallTime: string, durationMilliseconds: number): string {
	const timestamp = Date.parse(startedAtWallTime) + durationMilliseconds;
	if (!Number.isFinite(timestamp)) throw new Error("coordinator_obligation_deadline_policy_invalid");
	return new Date(timestamp).toISOString();
}

function deadlineDue(policy: CoordinatorObligationDeadlinePolicy, now: CoordinatorObligationTrustedTime): boolean {
	return (
		now.monotonicMilliseconds >= policy.deadlineAtMonotonicMilliseconds ||
		Date.parse(now.wallTime) >= Date.parse(policy.deadlineAtWallTime)
	);
}

function withStateDigest(
	state: Omit<CoordinatorObligationSchedulerState, "stateDigest">,
): CoordinatorObligationSchedulerState {
	const { stateDigest: _priorStateDigest, ...withoutDigest } = state as CoordinatorObligationSchedulerState;
	return { ...withoutDigest, stateDigest: digestObject(withoutDigest) };
}

function emptyState(
	workflowId: string,
	generationId: string,
	epochRef: WorkflowEpochRef,
): CoordinatorObligationSchedulerState {
	return withStateDigest({
		version: COORDINATOR_OBLIGATION_STATE_VERSION,
		workflowId,
		generationId,
		epochRef: structuredClone(epochRef),
		nextWakeEpisodeSequence: 1,
		parks: [],
		wakeEpisodes: [],
		urgentBoundaryPending: false,
		urgentDiagnostic: null,
		diagnosticCount: 0,
	});
}

function packetDigest(episode: Omit<CoordinatorObligationWakeEpisode, "packetDigest">): string {
	return digestObject({
		episodeId: episode.episodeId,
		wakeRefs: episode.wakeRefs,
		wakeKeys: episode.wakeKeys,
		outputObligationIds: episode.outputObligationIds,
		priority: episode.priority,
		status: episode.status,
		claim: episode.claim,
		safeBoundaryHandled: episode.safeBoundaryHandled,
		failureCount: episode.failureCount,
		diagnostic: episode.diagnostic,
	});
}

function cloneState(state: CoordinatorObligationSchedulerState): CoordinatorObligationSchedulerState {
	return structuredClone(state);
}

function incrementDiagnostic(
	state: CoordinatorObligationSchedulerState,
	diagnostic: string,
): CoordinatorObligationSchedulerState {
	return withStateDigest({
		...state,
		urgentDiagnostic: diagnostic,
		diagnosticCount: Math.min(MAX_WAKE_FAILURE_DIAGNOSTICS, state.diagnosticCount + 1),
	});
}

function hasUnresolvedUrgentBoundary(state: Pick<CoordinatorObligationSchedulerState, "wakeEpisodes">): boolean {
	return state.wakeEpisodes.some(
		(episode) =>
			episode.priority === "urgent" &&
			!episode.safeBoundaryHandled &&
			["pending", "claimed", "acknowledged", "stalled"].includes(episode.status),
	);
}

function createDeadlinePolicy(
	durationMilliseconds: number,
	maxWaitMilliseconds: number,
	now: CoordinatorObligationTrustedTime,
): CoordinatorObligationDeadlinePolicy {
	if (
		!Number.isSafeInteger(durationMilliseconds) ||
		durationMilliseconds < 1 ||
		durationMilliseconds > maxWaitMilliseconds ||
		!Number.isSafeInteger(now.monotonicMilliseconds + durationMilliseconds)
	)
		throw new Error("coordinator_obligation_deadline_policy_invalid");
	return {
		durationMilliseconds,
		maxWaitMilliseconds,
		startedAtMonotonicMilliseconds: now.monotonicMilliseconds,
		startedAtWallTime: now.wallTime,
		deadlineAtMonotonicMilliseconds: now.monotonicMilliseconds + durationMilliseconds,
		deadlineAtWallTime: wallDeadline(now.wallTime, durationMilliseconds),
	};
}

function immutableParkBinding(input: CoordinatorObligationParkInput, workflowId: string): Record<string, unknown> {
	return {
		workflowId,
		parentId: input.parentId,
		childId: input.childId,
		taskId: input.taskId,
		attemptId: input.attemptId,
		outputObligationId: input.outputObligationId,
		baseHead: input.baseHead,
		baseEpoch: input.baseEpoch,
	};
}

function parkIdFor(input: CoordinatorObligationParkInput, workflowId: string): string {
	return digestObject(immutableParkBinding(input, workflowId));
}

function wakeDeliveryId(
	parkId: string,
	attemptId: string,
	wakeKey: string,
	kind: CoordinatorObligationWakeKind,
	createdByEventId: string,
): string {
	return digestObject({
		parkId,
		attemptId,
		wakeKey,
		kind,
		createdByEventId: kind === "gating" ? createdByEventId : null,
	});
}

function normalizeParkInput(
	input: CoordinatorObligationParkInput,
	workflowId: string,
	epochRef: WorkflowEpochRef,
): void {
	for (const value of [
		input.parentId,
		input.childId,
		input.taskId,
		input.attemptId,
		input.outputObligationId,
		input.stateDigest,
	] as const)
		assertNonEmptyString(value, "coordinator_obligation_identity");
	assertEpoch(input.baseEpoch);
	if (!sameEpoch(input.baseEpoch, epochRef)) throw new Error("coordinator_obligation_epoch_fenced");
	assertHead(input.baseHead, workflowId, epochRef);
	if (typeof input.independentReadyWork !== "boolean") throw new Error("coordinator_obligation_ready_work_invalid");
}

function normalizeSnapshot(input: CoordinatorObligationSnapshotInput): CoordinatorObligationLocalSnapshot {
	assertNonEmptyString(input.outputObligationId, "coordinator_obligation_output_obligation");
	assertNonEmptyString(input.digest, "coordinator_obligation_snapshot_digest");
	if (typeof input.ref === "string") assertNonEmptyString(input.ref, "coordinator_obligation_snapshot_ref");
	else if (!isRecord(input.ref)) throw new Error("coordinator_obligation_snapshot_ref_invalid");
	assertSafeInteger(input.sizeBytes, "coordinator_obligation_snapshot_size", 0);
	if (input.sizeBytes > MAX_LOCAL_SNAPSHOT_BYTES) throw new Error("coordinator_obligation_snapshot_too_large");
	return { digest: input.digest, ref: structuredClone(input.ref), sizeBytes: input.sizeBytes };
}

function assertDeadlinePolicy(value: unknown): asserts value is CoordinatorObligationDeadlinePolicy {
	if (!isRecord(value)) throw new Error("coordinator_obligation_state_invalid");
	assertExactKeys(value, [
		"durationMilliseconds",
		"maxWaitMilliseconds",
		"startedAtMonotonicMilliseconds",
		"startedAtWallTime",
		"deadlineAtMonotonicMilliseconds",
		"deadlineAtWallTime",
	]);
	assertSafeInteger(value.durationMilliseconds, "coordinator_obligation_deadline_duration", 1);
	assertSafeInteger(value.maxWaitMilliseconds, "coordinator_obligation_deadline_max_wait", value.durationMilliseconds);
	assertSafeInteger(value.startedAtMonotonicMilliseconds, "coordinator_obligation_deadline_started", 0);
	assertSafeInteger(value.deadlineAtMonotonicMilliseconds, "coordinator_obligation_deadline_at", 0);
	if (
		typeof value.startedAtWallTime !== "string" ||
		!Number.isFinite(Date.parse(value.startedAtWallTime)) ||
		typeof value.deadlineAtWallTime !== "string" ||
		!Number.isFinite(Date.parse(value.deadlineAtWallTime)) ||
		value.deadlineAtMonotonicMilliseconds < value.startedAtMonotonicMilliseconds
	)
		throw new Error("coordinator_obligation_state_invalid");
}

function assertDeadlineTransition(value: unknown): asserts value is CoordinatorObligationDeadlineTransition {
	if (!isRecord(value)) throw new Error("coordinator_obligation_state_invalid");
	assertExactKeys(value, ["status", "transitionEventId", "transitionReason"]);
	if (
		!(
			["pending", "discharged", "cancelled", "terminal_failed", "scope_changed", "expired"] as readonly string[]
		).includes(String(value.status))
	)
		throw new Error("coordinator_obligation_state_invalid");
	if (value.transitionEventId !== null && typeof value.transitionEventId !== "string")
		throw new Error("coordinator_obligation_state_invalid");
	if (value.transitionReason !== null && typeof value.transitionReason !== "string")
		throw new Error("coordinator_obligation_state_invalid");
	if (value.status === "pending" && (value.transitionEventId !== null || value.transitionReason !== null))
		throw new Error("coordinator_obligation_state_invalid");
}

function assertWakeRecord(
	value: unknown,
	parkId: string,
	attemptId: string,
): asserts value is CoordinatorObligationWakeRecord {
	if (!isRecord(value)) throw new Error("coordinator_obligation_state_invalid");
	assertExactKeys(value, ["deliveryId", "parkId", "attemptId", "wakeKey", "kind", "createdByEventId", "episodeId"]);
	for (const key of ["deliveryId", "parkId", "attemptId", "wakeKey", "createdByEventId"] as const)
		assertNonEmptyString(value[key], `coordinator_obligation_wake_${key}`);
	if (value.parkId !== parkId || value.attemptId !== attemptId)
		throw new Error("coordinator_obligation_state_invalid");
	if (!(["final_output", "error", "gating"] as readonly string[]).includes(String(value.kind)))
		throw new Error("coordinator_obligation_state_invalid");
	if (value.episodeId !== null && typeof value.episodeId !== "string")
		throw new Error("coordinator_obligation_state_invalid");
}

function assertPersistedWakeClaim(value: unknown): asserts value is CoordinatorObligationWakeClaim {
	if (!isRecord(value)) throw new Error("coordinator_obligation_state_invalid");
	assertExactKeys(value, ["claimId", "leaseRef", "claimedAt"]);
	assertNonEmptyString(value.claimId, "coordinator_obligation_claim");
	if (!isRecord(value.leaseRef)) throw new Error("coordinator_obligation_state_invalid");
	assertExactKeys(value.leaseRef, [
		"storeEpoch",
		"coordinatorEpoch",
		"leaseId",
		"acquisitionEventSequence",
		"processIdentity",
		"rootDigest",
		"writerIdentity",
		"acquiredAt",
		"expiresAt",
	]);
	const leaseRef = value.leaseRef as unknown as WorkflowLeaseRef;
	assertEpoch(leaseRef);
	assertLease(leaseRef, leaseRef);
	assertTrustedTime(value.claimedAt as CoordinatorObligationTrustedTime);
}

function assertPersistedActivity(value: unknown): asserts value is CoordinatorObligationActivity {
	if (!isRecord(value)) throw new Error("coordinator_obligation_state_invalid");
	assertExactKeys(value, ["kind", "stateDigest", "progressDigest", "observedAt"]);
	if (
		!(["heartbeat", "whitespace", "activity", "compaction_progress"] as readonly string[]).includes(
			String(value.kind),
		)
	)
		throw new Error("coordinator_obligation_state_invalid");
	assertNonEmptyString(value.stateDigest, "coordinator_obligation_activity_state_digest");
	if (value.progressDigest !== null && typeof value.progressDigest !== "string")
		throw new Error("coordinator_obligation_state_invalid");
	assertTrustedTime(value.observedAt as CoordinatorObligationTrustedTime);
}

function assertChildOutputRecord(
	value: unknown,
	workflowId: string,
	epochRef: WorkflowEpochRef,
): asserts value is CoordinatorObligationChildOutputRecord {
	if (!isRecord(value)) throw new Error("coordinator_obligation_state_invalid");
	assertExactKeys(value, [
		"eventId",
		"stateDigest",
		"head",
		"independentReadyWork",
		"wakeKey",
		"wakeKind",
		"terminalStatus",
		"terminalReason",
	]);
	assertNonEmptyString(value.eventId, "coordinator_obligation_child_output_event");
	assertNonEmptyString(value.stateDigest, "coordinator_obligation_child_output_state_digest");
	if (!isRecord(value.head)) throw new Error("coordinator_obligation_state_invalid");
	assertHead(value.head as unknown as WorkflowJournalHead, workflowId, epochRef);
	if (typeof value.independentReadyWork !== "boolean") throw new Error("coordinator_obligation_state_invalid");
	if (value.wakeKey !== null) assertNonEmptyString(value.wakeKey, "coordinator_obligation_child_output_wake_key");
	if (
		value.wakeKind !== null &&
		!(["final_output", "error", "gating"] as readonly string[]).includes(String(value.wakeKind))
	)
		throw new Error("coordinator_obligation_state_invalid");
	if (
		!(["discharged", "cancelled", "terminal_failed", "scope_changed"] as readonly string[]).includes(
			String(value.terminalStatus),
		)
	)
		throw new Error("coordinator_obligation_state_invalid");
	assertNonEmptyString(value.terminalReason, "coordinator_obligation_child_output_reason", MAX_SCHEDULER_REASON_BYTES);
}

function sameChildOutput(
	left: CoordinatorObligationChildOutputRecord,
	right: CoordinatorObligationChildOutputRecord,
): boolean {
	return (
		left.eventId === right.eventId &&
		left.stateDigest === right.stateDigest &&
		sameHead(left.head, right.head) &&
		left.independentReadyWork === right.independentReadyWork &&
		left.wakeKey === right.wakeKey &&
		left.wakeKind === right.wakeKind &&
		left.terminalStatus === right.terminalStatus &&
		left.terminalReason === right.terminalReason
	);
}

function assertWakeEpisode(value: unknown): asserts value is CoordinatorObligationWakeEpisode {
	if (!isRecord(value)) throw new Error("coordinator_obligation_state_invalid");
	assertExactKeys(value, [
		"episodeId",
		"wakeRefs",
		"wakeKeys",
		"outputObligationIds",
		"priority",
		"status",
		"claim",
		"safeBoundaryHandled",
		"packetDigest",
		"failureCount",
		"diagnostic",
	]);
	assertNonEmptyString(value.episodeId, "coordinator_obligation_episode");
	if (
		!Array.isArray(value.wakeRefs) ||
		value.wakeRefs.length === 0 ||
		value.wakeRefs.length > MAX_WAKE_KEYS_PER_EPISODE
	)
		throw new Error("coordinator_obligation_state_invalid");
	if (!Array.isArray(value.wakeKeys) || value.wakeKeys.length !== value.wakeRefs.length)
		throw new Error("coordinator_obligation_state_invalid");
	if (!Array.isArray(value.outputObligationIds) || value.outputObligationIds.length !== value.wakeRefs.length)
		throw new Error("coordinator_obligation_state_invalid");
	for (const ref of value.wakeRefs) {
		if (!isRecord(ref)) throw new Error("coordinator_obligation_state_invalid");
		assertExactKeys(ref, [
			"deliveryId",
			"parkId",
			"attemptId",
			"wakeKey",
			"outputObligationId",
			"kind",
			"createdByEventId",
		]);
		for (const key of [
			"deliveryId",
			"parkId",
			"attemptId",
			"wakeKey",
			"outputObligationId",
			"createdByEventId",
		] as const)
			assertNonEmptyString(ref[key], `coordinator_obligation_wake_ref_${key}`);
		if (!(["final_output", "error", "gating"] as readonly string[]).includes(String(ref.kind)))
			throw new Error("coordinator_obligation_state_invalid");
	}
	const wakeRefs = value.wakeRefs as readonly Record<string, unknown>[];
	const wakeKeys = value.wakeKeys as readonly unknown[];
	const outputObligationIds = value.outputObligationIds as readonly unknown[];
	if (
		!wakeRefs.every(
			(ref, index) => ref.wakeKey === wakeKeys[index] && ref.outputObligationId === outputObligationIds[index],
		)
	)
		throw new Error("coordinator_obligation_state_invalid");
	if (!(["normal", "urgent"] as readonly string[]).includes(String(value.priority)))
		throw new Error("coordinator_obligation_state_invalid");
	if (!(["pending", "claimed", "acknowledged", "stalled"] as readonly string[]).includes(String(value.status)))
		throw new Error("coordinator_obligation_state_invalid");
	assertSafeInteger(value.failureCount, "coordinator_obligation_failure_count", 0);
	if (typeof value.safeBoundaryHandled !== "boolean") throw new Error("coordinator_obligation_state_invalid");
	if (value.failureCount > MAX_WAKE_FAILURE_DIAGNOSTICS || typeof value.packetDigest !== "string")
		throw new Error("coordinator_obligation_state_invalid");
	if (value.diagnostic !== null && typeof value.diagnostic !== "string")
		throw new Error("coordinator_obligation_state_invalid");
	if (value.status === "pending" && value.claim !== null) throw new Error("coordinator_obligation_state_invalid");
	if (value.status === "stalled" && value.claim !== null) throw new Error("coordinator_obligation_state_invalid");
	if (value.status === "claimed" || value.status === "acknowledged") assertPersistedWakeClaim(value.claim);
}

function assertPersistedState(
	value: unknown,
	workflowId: string,
	generationId: string,
	epochRef: WorkflowEpochRef,
): CoordinatorObligationSchedulerState {
	if (!isRecord(value)) throw new Error("coordinator_obligation_state_invalid");
	assertExactKeys(value, [
		"version",
		"workflowId",
		"generationId",
		"epochRef",
		"nextWakeEpisodeSequence",
		"parks",
		"wakeEpisodes",
		"urgentBoundaryPending",
		"urgentDiagnostic",
		"diagnosticCount",
		"stateDigest",
	]);
	if (
		value.version !== COORDINATOR_OBLIGATION_STATE_VERSION ||
		value.workflowId !== workflowId ||
		value.generationId !== generationId ||
		!isRecord(value.epochRef) ||
		!sameEpoch(value.epochRef as unknown as WorkflowEpochRef, epochRef) ||
		!Array.isArray(value.parks) ||
		value.parks.length > MAX_PARKED_OBLIGATIONS ||
		!Array.isArray(value.wakeEpisodes) ||
		!Number.isSafeInteger(value.nextWakeEpisodeSequence) ||
		(value.nextWakeEpisodeSequence as number) < 1 ||
		typeof value.urgentBoundaryPending !== "boolean" ||
		(value.urgentDiagnostic !== null && typeof value.urgentDiagnostic !== "string") ||
		!Number.isSafeInteger(value.diagnosticCount) ||
		(value.diagnosticCount as number) < 0 ||
		(value.diagnosticCount as number) > MAX_WAKE_FAILURE_DIAGNOSTICS ||
		typeof value.stateDigest !== "string"
	)
		throw new Error("coordinator_obligation_state_invalid");
	const parkIds = new Set<string>();
	const outputIds = new Set<string>();
	const deliveryIds = new Set<string>();
	for (const parkValue of value.parks) {
		if (!isRecord(parkValue)) throw new Error("coordinator_obligation_state_invalid");
		assertExactKeys(parkValue, [
			"parkId",
			"workflowId",
			"parentId",
			"childId",
			"taskId",
			"attemptId",
			"outputObligationId",
			"baseHead",
			"baseEpoch",
			"stateDigest",
			"latestStateDigest",
			"independentReadyWork",
			"deadlinePolicy",
			"deadline",
			"terminalRetentionRevision",
			"snapshot",
			"activity",
			"childOutput",
			"quarantineReason",
			"wakes",
		]);
		const park = parkValue as unknown as CoordinatorObligationParkToken;
		for (const key of [
			"parkId",
			"workflowId",
			"parentId",
			"childId",
			"taskId",
			"attemptId",
			"outputObligationId",
			"stateDigest",
			"latestStateDigest",
		] as const)
			assertNonEmptyString(parkValue[key], `coordinator_obligation_${key}`);
		if (
			park.workflowId !== workflowId ||
			park.parkId !==
				digestObject({
					workflowId,
					parentId: park.parentId,
					childId: park.childId,
					taskId: park.taskId,
					attemptId: park.attemptId,
					outputObligationId: park.outputObligationId,
					baseHead: park.baseHead,
					baseEpoch: park.baseEpoch,
				}) ||
			!sameEpoch(park.baseEpoch, epochRef) ||
			typeof park.independentReadyWork !== "boolean" ||
			(park.quarantineReason !== null && typeof park.quarantineReason !== "string") ||
			!Array.isArray(park.wakes) ||
			park.wakes.length > MAX_WAKE_KEYS_PER_PARK ||
			(park.terminalRetentionRevision !== null &&
				(!Number.isSafeInteger(park.terminalRetentionRevision) || park.terminalRetentionRevision < 1))
		)
			throw new Error("coordinator_obligation_state_invalid");
		if (parkIds.has(park.parkId) || outputIds.has(park.outputObligationId))
			throw new Error("coordinator_obligation_state_invalid");
		parkIds.add(park.parkId);
		outputIds.add(park.outputObligationId);
		assertHead(park.baseHead, workflowId, epochRef);
		if (park.quarantineReason !== null)
			assertNonEmptyString(
				park.quarantineReason,
				"coordinator_obligation_quarantine_reason",
				MAX_SCHEDULER_REASON_BYTES,
			);
		assertDeadlinePolicy(park.deadlinePolicy);
		assertDeadlineTransition(park.deadline);
		if (park.deadline.status === "pending" && park.terminalRetentionRevision !== null)
			throw new Error("coordinator_obligation_state_invalid");
		if (park.deadline.status !== "pending" && (park.terminalRetentionRevision === null || park.wakes.length === 0))
			throw new Error("coordinator_obligation_state_invalid");
		if (park.snapshot !== null) {
			if (!isRecord(park.snapshot)) throw new Error("coordinator_obligation_state_invalid");
			assertExactKeys(park.snapshot, ["digest", "ref", "sizeBytes"]);
			assertNonEmptyString(park.snapshot.digest, "coordinator_obligation_snapshot_digest");
			assertSafeInteger(park.snapshot.sizeBytes, "coordinator_obligation_snapshot_size", 0);
			if (
				park.snapshot.sizeBytes > MAX_LOCAL_SNAPSHOT_BYTES ||
				(!isRecord(park.snapshot.ref) && typeof park.snapshot.ref !== "string")
			)
				throw new Error("coordinator_obligation_state_invalid");
		}
		if (park.activity !== null) assertPersistedActivity(park.activity);
		if (park.childOutput !== null) {
			assertChildOutputRecord(park.childOutput, workflowId, epochRef);
			assertHeadLineage(park.baseHead, park.childOutput.head, park.childOutput.head);
			if (
				park.deadline.status !== park.childOutput.terminalStatus ||
				park.deadline.transitionEventId !== park.childOutput.eventId ||
				park.deadline.transitionReason !== park.childOutput.terminalReason ||
				park.childOutput.independentReadyWork !== park.independentReadyWork
			)
				throw new Error("coordinator_obligation_state_invalid");
		}
		for (const wake of park.wakes) {
			assertWakeRecord(wake, park.parkId, park.attemptId);
			if (
				wake.deliveryId !==
				wakeDeliveryId(park.parkId, park.attemptId, wake.wakeKey, wake.kind, wake.createdByEventId)
			)
				throw new Error("coordinator_obligation_state_invalid");
			if (deliveryIds.has(wake.deliveryId)) throw new Error("coordinator_obligation_state_invalid");
			deliveryIds.add(wake.deliveryId);
		}
	}
	const episodeIds = new Set<string>();
	for (const episodeValue of value.wakeEpisodes) {
		assertWakeEpisode(episodeValue);
		const episode = episodeValue as unknown as CoordinatorObligationWakeEpisode;
		if (episodeIds.has(episode.episodeId)) throw new Error("coordinator_obligation_state_invalid");
		episodeIds.add(episode.episodeId);
		if (episode.claim !== null && !sameEpoch(episode.claim.leaseRef, epochRef))
			throw new Error("coordinator_obligation_state_invalid");
		if (episode.packetDigest !== packetDigest(episode)) throw new Error("coordinator_obligation_state_invalid");
		for (const ref of episode.wakeRefs) {
			if (!deliveryIds.has(ref.deliveryId)) throw new Error("coordinator_obligation_state_invalid");
			const park = value.parks.find((candidate) => isRecord(candidate) && candidate.parkId === ref.parkId) as
				| CoordinatorObligationParkToken
				| undefined;
			const wake = park?.wakes.find((candidate) => candidate.deliveryId === ref.deliveryId);
			if (
				park === undefined ||
				wake === undefined ||
				park.attemptId !== ref.attemptId ||
				wake.episodeId !== episode.episodeId ||
				wake.wakeKey !== ref.wakeKey ||
				wake.kind !== ref.kind ||
				park.outputObligationId !== ref.outputObligationId
			)
				throw new Error("coordinator_obligation_state_invalid");
		}
	}
	for (const parkValue of value.parks) {
		const park = parkValue as unknown as CoordinatorObligationParkToken;
		for (const wake of park.wakes) {
			if (wake.episodeId !== null && !episodeIds.has(wake.episodeId))
				throw new Error("coordinator_obligation_state_invalid");
		}
	}
	const { stateDigest: _ignoredStateDigest, ...withoutDigest } =
		value as unknown as CoordinatorObligationSchedulerState;
	if (value.stateDigest !== digestObject(withoutDigest)) throw new Error("coordinator_obligation_state_invalid");
	const unresolvedUrgentBoundary = hasUnresolvedUrgentBoundary(
		value as unknown as Pick<CoordinatorObligationSchedulerState, "wakeEpisodes">,
	);
	if (value.urgentBoundaryPending !== unresolvedUrgentBoundary)
		throw new Error("coordinator_obligation_state_invalid");
	return structuredClone(value as unknown as CoordinatorObligationSchedulerState);
}

function assertPersistedRecord(value: unknown): asserts value is CoordinatorObligationPersistedRecord {
	if (!isRecord(value)) throw new Error("coordinator_obligation_record_invalid");
	assertExactKeys(value, [
		"version",
		"revision",
		"previousPayloadDigest",
		"payload",
		"payloadDigest",
		"mac",
		"receiptDigest",
	]);
	if (
		value.version !== COORDINATOR_OBLIGATION_RECORD_VERSION ||
		!Number.isSafeInteger(value.revision) ||
		(value.revision as number) < 1 ||
		(value.previousPayloadDigest !== null && typeof value.previousPayloadDigest !== "string") ||
		!Array.isArray(value.payload) ||
		value.payload.length > MAX_SCHEDULER_RECORD_BYTES ||
		value.payload.some((byte) => !Number.isSafeInteger(byte) || (byte as number) < 0 || (byte as number) > 255) ||
		typeof value.payloadDigest !== "string" ||
		typeof value.mac !== "string" ||
		typeof value.receiptDigest !== "string" ||
		value.mac.length === 0 ||
		value.receiptDigest.length === 0 ||
		value.payloadDigest !== digestObject(value.payload)
	)
		throw new Error("coordinator_obligation_record_invalid");
}

function reconcileWakeClaims(
	state: CoordinatorObligationSchedulerState,
	leaseRef: WorkflowLeaseRef,
	now: CoordinatorObligationTrustedTime,
): CoordinatorObligationSchedulerState {
	let changed = false;
	const wakeEpisodes = state.wakeEpisodes.map((episode) => {
		if (episode.status !== "claimed" || episode.claim === null) return episode;
		if (sameWorkflowLeaseIdentity(episode.claim.leaseRef, leaseRef) && leaseAlive(leaseRef, now)) return episode;
		changed = true;
		const pending: Omit<CoordinatorObligationWakeEpisode, "packetDigest"> = {
			...episode,
			status: "pending",
			claim: null,
		};
		return { ...pending, packetDigest: packetDigest(pending) };
	});
	return changed ? withStateDigest({ ...state, wakeEpisodes }) : state;
}

function activeParks(state: CoordinatorObligationSchedulerState): readonly CoordinatorObligationParkToken[] {
	const pendingEpisodeIds = new Set(
		state.wakeEpisodes
			.filter(
				(episode) => episode.status === "pending" || episode.status === "claimed" || episode.status === "stalled",
			)
			.map((episode) => episode.episodeId),
	);
	return state.parks.filter(
		(park) =>
			park.deadline.status === "pending" ||
			park.wakes.some((wake) => wake.episodeId !== null && pendingEpisodeIds.has(wake.episodeId)),
	);
}

function packetFromEpisode(episode: CoordinatorObligationWakeEpisode): CoordinatorObligationWakePacket {
	if (episode.claim === null) throw new Error("coordinator_obligation_wake_claim_missing");
	return {
		episodeId: episode.episodeId,
		claimId: episode.claim.claimId,
		wakeRefs: structuredClone(episode.wakeRefs),
		wakeKeys: [...episode.wakeKeys],
		outputObligationIds: [...episode.outputObligationIds],
		priority: episode.priority,
		packetDigest: episode.packetDigest,
		diagnostic: episode.diagnostic,
	};
}

function assertHostCapability(
	capability: WorkflowHostPrincipalCapabilityAuthorization,
	workflowId: string,
	epochRef: WorkflowEpochRef,
): void {
	if (
		capability.capability !== COORDINATOR_OBLIGATION_HOST_CAPABILITY ||
		capability.workflowId !== workflowId ||
		!sameEpoch(capability.epochRef, epochRef) ||
		!capability.authenticatedPrincipal ||
		!capability.keyOwnerPrincipal ||
		!capability.authorizationDigest ||
		!capability.receipt.receiptId ||
		capability.receipt.capabilityBinding?.capability !== COORDINATOR_OBLIGATION_HOST_CAPABILITY
	)
		throw new Error("CONTRACT_CHANGE: coordinator obligation scheduler capability is not centrally authorized");
}

function assertLiveChild(
	child: ChildAttemptState | null,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	binding: CoordinatorObligationParkBinding,
	expectedStateDigest: string | null,
): asserts child is ChildAttemptState {
	if (
		child === null ||
		child.workflowId !== workflowId ||
		child.childId !== binding.childId ||
		child.taskId !== binding.taskId ||
		child.attemptId !== binding.attemptId ||
		child.outputObligation.obligationId !== binding.outputObligationId ||
		!sameEpoch(child.epochRef, epochRef) ||
		(expectedStateDigest !== null && child.stateDigest !== expectedStateDigest)
	)
		throw new Error("coordinator_obligation_child_state_stale");
}

function assertParkBindingInput(
	input: CoordinatorObligationParkInput,
	workflowId: string,
): CoordinatorObligationParkBinding {
	return {
		parkId: parkIdFor(input, workflowId),
		parentId: input.parentId,
		childId: input.childId,
		taskId: input.taskId,
		attemptId: input.attemptId,
		outputObligationId: input.outputObligationId,
		baseHead: structuredClone(input.baseHead),
		independentReadyWork: input.independentReadyWork,
	};
}

export interface CreateCoordinatorObligationSchedulerInput {
	readonly host: CoordinatorObligationHostAdapter;
}

/**
 * Create one durable host-local coordinator obligation park/wake state machine.
 *
 * Args:
 * input: Host adapter carrying the runtime lease, trusted clock, live projections, principal capability, and record CAS.
 * Return: Durable scheduler operations; provider admission is never called by this module.
 */
export function createCoordinatorObligationScheduler(
	input: CreateCoordinatorObligationSchedulerInput,
): CoordinatorObligationScheduler {
	const host = input.host;
	if (typeof host !== "object" || host === null)
		throw new Error("CONTRACT_CHANGE: coordinator obligation host adapter is required");
	assertWorkflowRuntimeVersion(host.runtimeVersion);
	if (!Number.isSafeInteger(host.maxWaitMilliseconds) || host.maxWaitMilliseconds < 1)
		throw new Error("coordinator_obligation_deadline_policy_invalid");
	const runtimeStore = host.runtimeStore;
	const durable = runtimeStore.durableContext;
	if (durable === undefined)
		throw new Error("CONTRACT_CHANGE: coordinator obligation scheduler requires durable runtime");
	const workflowId = runtimeStore.identity.workflowId;
	assertNonEmptyString(workflowId, "coordinator_obligation_workflow");
	assertEpoch(durable.epochRef);
	assertHostCapability(host.capability, workflowId, durable.epochRef);
	if (
		typeof host.authorize !== "function" ||
		typeof host.recordAuthority !== "object" ||
		host.recordAuthority === null
	)
		throw new Error("CONTRACT_CHANGE: coordinator obligation host authorization and record authority are required");

	let hydrated = false;
	let hydration: Promise<void> | null = null;
	let inMemory = emptyState(workflowId, durable.generationId, durable.epochRef);
	let inMemoryRevision = 0;

	const trustedTime = async (): Promise<CoordinatorObligationTrustedTime> =>
		assertTrustedTime(await host.readTrustedTime());

	const currentLease = (): WorkflowLeaseRef => {
		const leaseRef = host.readCurrentLeaseRef();
		assertLease(leaseRef, durable.epochRef);
		return structuredClone(leaseRef);
	};

	const readPersisted = async (): Promise<CoordinatorObligationLoadedRecord | null> => {
		const bytes = await durable.auxiliaryStore.read(COORDINATOR_OBLIGATION_RECORD);
		if (bytes === null) return null;
		try {
			const parsed = parseCanonicalJsonBytes(bytes);
			assertPersistedRecord(parsed);
			const payload = Uint8Array.from(parsed.payload);
			const leaseRef = currentLease();
			await host.recordAuthority.verify({
				recordName: COORDINATOR_OBLIGATION_RECORD,
				workflowId,
				epochRef: durable.epochRef,
				leaseRef,
				revision: parsed.revision,
				payload,
				previousPayloadDigest: parsed.previousPayloadDigest,
				mac: parsed.mac,
				receiptDigest: parsed.receiptDigest,
			});
			const state = assertPersistedState(
				parseCanonicalJsonBytes(payload),
				workflowId,
				durable.generationId,
				durable.epochRef,
			);
			return { state, revision: parsed.revision, payloadDigest: parsed.payloadDigest };
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("coordinator_obligation_")) throw error;
			throw new Error("coordinator_obligation_record_invalid");
		}
	};

	const writeState = async (
		state: CoordinatorObligationSchedulerState,
		expectedRevision: number | null,
		previousPayloadDigest: string | null,
	): Promise<number> => {
		assertPersistedState(state, workflowId, durable.generationId, durable.epochRef);
		const revision = (expectedRevision ?? 0) + 1;
		const payload = canonicalJsonBytes(state);
		if (payload.byteLength > MAX_SCHEDULER_RECORD_BYTES)
			throw new Error("coordinator_obligation_record_bound_exceeded");
		const leaseRef = currentLease();
		const sealed = await host.recordAuthority.seal({
			recordName: COORDINATOR_OBLIGATION_RECORD,
			workflowId,
			epochRef: durable.epochRef,
			leaseRef,
			revision,
			payload,
			previousPayloadDigest,
		});
		if (!sealed.mac || !sealed.receiptDigest)
			throw new Error("CONTRACT_CHANGE: coordinator obligation record seal is incomplete");
		const record: CoordinatorObligationPersistedRecord = {
			version: COORDINATOR_OBLIGATION_RECORD_VERSION,
			revision,
			previousPayloadDigest,
			payload: [...payload],
			payloadDigest: digestObject([...payload]),
			mac: sealed.mac,
			receiptDigest: sealed.receiptDigest,
		};
		await host.recordAuthority.compareAndSwap({
			recordName: COORDINATOR_OBLIGATION_RECORD,
			expectedRevision,
			nextRevision: revision,
			recordBytes: canonicalJsonBytes(record),
			leaseRef,
		});
		inMemory = cloneState(state);
		inMemoryRevision = revision;
		return revision;
	};

	const retentionGc = async (
		state: CoordinatorObligationSchedulerState,
		recordRevision: number,
	): Promise<CoordinatorObligationSchedulerState> => {
		const watermark = await host.readRetentionWatermark();
		assertSafeInteger(watermark, "coordinator_obligation_retention_watermark", 0);
		const removableParkIds = new Set(
			state.parks
				.filter(
					(park) =>
						park.deadline.status !== "pending" &&
						park.terminalRetentionRevision !== null &&
						park.terminalRetentionRevision <= watermark &&
						park.wakes.every((wake) => {
							const episode =
								wake.episodeId === null
									? null
									: state.wakeEpisodes.find((candidate) => candidate.episodeId === wake.episodeId);
							return (
								episode?.status === "acknowledged" &&
								(episode.priority !== "urgent" || episode.safeBoundaryHandled)
							);
						}),
				)
				.map((park) => park.parkId),
		);
		if (removableParkIds.size === 0) return state;
		const now = await trustedTime();
		const leaseRef = currentLease();
		const currentHead = await host.readCurrentHead();
		assertHead(currentHead, workflowId, durable.epochRef);
		const stateDigest = currentHead.eventDigest ?? digestObject(currentHead);
		const authorization = await host.authorize({
			capability: COORDINATOR_OBLIGATION_HOST_CAPABILITY,
			operation: "retention_gc",
			workflowId,
			epochRef: durable.epochRef,
			leaseRef,
			currentHead: structuredClone(currentHead),
			recordRevision,
			stateDigest,
			park: null,
			childStateDigest: null,
			baseHead: null,
			independentReadyWork: null,
			childOutputDigest: null,
		});
		assertHostCapability(authorization, workflowId, durable.epochRef);
		if (authorization.stateDigest !== stateDigest || authorization.revision !== currentHead.sequence)
			throw new Error("CONTRACT_CHANGE: coordinator obligation retention authorization is stale");
		if (!leaseAlive(leaseRef, now)) throw new Error("coordinator_obligation_lease_expired");
		const wakeEpisodes = state.wakeEpisodes.flatMap((episode) => {
			const wakeRefs = episode.wakeRefs.filter((ref) => !removableParkIds.has(ref.parkId));
			if (wakeRefs.length === 0) return [];
			const unsigned: Omit<CoordinatorObligationWakeEpisode, "packetDigest"> = {
				...episode,
				wakeRefs,
				wakeKeys: wakeRefs.map((ref) => ref.wakeKey),
				outputObligationIds: wakeRefs.map((ref) => ref.outputObligationId),
			};
			return [{ ...unsigned, packetDigest: packetDigest(unsigned) }];
		});
		return withStateDigest({
			...state,
			parks: state.parks.filter((park) => !removableParkIds.has(park.parkId)),
			wakeEpisodes,
			urgentBoundaryPending: hasUnresolvedUrgentBoundary({ wakeEpisodes }),
		});
	};

	const ensureHydrated = async (): Promise<void> => {
		if (hydrated) return;
		if (hydration !== null) return hydration;
		hydration = durable.withExclusiveLease("coordinator-obligation-hydrate", async () => {
			const loaded = await readPersisted();
			const state = loaded?.state ?? emptyState(workflowId, durable.generationId, durable.epochRef);
			const now = await trustedTime();
			const leaseRef = currentLease();
			if (!leaseAlive(leaseRef, now)) throw new Error("coordinator_obligation_lease_expired");
			let reconciled = reconcileWakeClaims(state, leaseRef, now);
			reconciled = await retentionGc(reconciled, loaded?.revision ?? 0);
			if (loaded === null || reconciled.stateDigest !== state.stateDigest) {
				await writeState(reconciled, loaded?.revision ?? null, loaded?.payloadDigest ?? null);
			} else {
				inMemory = cloneState(reconciled);
				inMemoryRevision = loaded.revision;
			}
			hydrated = true;
		});
		try {
			await hydration;
		} finally {
			hydration = null;
		}
	};

	const authorizeTransition = async (
		operation: CoordinatorObligationOperation,
		recordRevision: number,
		park: CoordinatorObligationParkBinding | null,
		expectedChildStateDigest: string | null,
		options: {
			readonly expectedChildHead?: WorkflowJournalHead;
			readonly childOutputDigest?: string | null;
			readonly allowMissingChild?: boolean;
		} = {},
	): Promise<{
		readonly now: CoordinatorObligationTrustedTime;
		readonly leaseRef: WorkflowLeaseRef;
		readonly child: ChildAttemptState | null;
	}> => {
		const now = await trustedTime();
		const leaseRef = currentLease();
		const currentHead = await host.readCurrentHead();
		assertHead(currentHead, workflowId, durable.epochRef);
		let child: ChildAttemptState | null = null;
		if (park !== null) {
			const observedChild = await host.readChildAttemptState({
				attemptId: park.attemptId,
				childId: park.childId,
				outputObligationId: park.outputObligationId,
			});
			if (observedChild === null && options.allowMissingChild) {
				child = null;
			} else {
				assertLiveChild(observedChild, workflowId, durable.epochRef, park, expectedChildStateDigest);
				assertHead(observedChild.head, workflowId, durable.epochRef);
				assertHeadLineage(park.baseHead, observedChild.head, currentHead);
				if (options.expectedChildHead !== undefined && !sameHead(observedChild.head, options.expectedChildHead))
					throw new Error("coordinator_obligation_head_lineage_invalid");
				child = observedChild;
			}
		}
		const stateDigest = child?.stateDigest ?? currentHead.eventDigest ?? digestObject(currentHead);
		const authorization = await host.authorize({
			capability: COORDINATOR_OBLIGATION_HOST_CAPABILITY,
			operation,
			workflowId,
			epochRef: durable.epochRef,
			leaseRef,
			currentHead: structuredClone(currentHead),
			recordRevision,
			stateDigest,
			park: park === null ? null : structuredClone(park),
			childStateDigest: child?.stateDigest ?? null,
			baseHead: park?.baseHead ?? null,
			independentReadyWork: park?.independentReadyWork ?? null,
			childOutputDigest: options.childOutputDigest ?? null,
		});
		assertHostCapability(authorization, workflowId, durable.epochRef);
		if (
			authorization.stateDigest !== stateDigest ||
			authorization.revision !== currentHead.sequence ||
			authorization.receipt.capabilityBinding?.capability !== COORDINATOR_OBLIGATION_HOST_CAPABILITY
		)
			throw new Error("CONTRACT_CHANGE: coordinator obligation authorization is stale");
		return { now, leaseRef, child };
	};

	const mutate = async <TValue>(
		boundary: string,
		operation: (
			state: CoordinatorObligationSchedulerState,
			now: CoordinatorObligationTrustedTime,
			leaseRef: WorkflowLeaseRef,
			recordRevision: number,
		) => Promise<CoordinatorObligationMutationResult<TValue>>,
	): Promise<TValue> => {
		await ensureHydrated();
		return durable.withExclusiveLease(boundary, async () => {
			const loaded = await readPersisted();
			const current = loaded?.state ?? inMemory;
			const recordRevision = loaded?.revision ?? inMemoryRevision;
			const now = await trustedTime();
			const leaseRef = currentLease();
			if (!leaseAlive(leaseRef, now)) throw new Error("coordinator_obligation_lease_expired");
			let reconciled = reconcileWakeClaims(current, leaseRef, now);
			reconciled = await retentionGc(reconciled, recordRevision);
			const preOperationChanged = reconciled.stateDigest !== current.stateDigest;
			const result = await operation(cloneState(reconciled), now, leaseRef, recordRevision);
			const next = result.state;
			if (preOperationChanged || next.stateDigest !== reconciled.stateDigest || recordRevision === 0) {
				await writeState(
					next,
					loaded?.revision ?? (recordRevision === 0 ? null : recordRevision),
					loaded?.payloadDigest ?? null,
				);
			} else {
				inMemory = cloneState(next);
				inMemoryRevision = recordRevision;
			}
			return result.value;
		});
	};

	const parkChildObligation = async (input: CoordinatorObligationParkInput): Promise<CoordinatorObligationParkToken> =>
		mutate("coordinator-obligation-park", async (state, now, _leaseRef, recordRevision) => {
			normalizeParkInput(input, workflowId, durable.epochRef);
			const binding = assertParkBindingInput(input, workflowId);
			await authorizeTransition("park", recordRevision, binding, input.stateDigest);
			const parkId = binding.parkId as string;
			const existing = state.parks.find((park) => park.parkId === parkId);
			if (existing !== undefined) {
				const next = withStateDigest({
					...state,
					parks: state.parks.map((park) =>
						park.parkId === parkId ? { ...park, independentReadyWork: input.independentReadyWork } : park,
					),
				});
				return {
					state: next,
					value: structuredClone(
						next.parks.find((park) => park.parkId === parkId) as CoordinatorObligationParkToken,
					),
				};
			}
			if (state.parks.some((park) => park.outputObligationId === input.outputObligationId))
				throw new Error("coordinator_obligation_output_obligation_conflict");
			if (state.parks.length >= MAX_PARKED_OBLIGATIONS)
				throw new Error("coordinator_obligation_park_bound_exceeded");
			const durationMilliseconds = input.deadlineMilliseconds ?? host.maxWaitMilliseconds;
			const park: CoordinatorObligationParkToken = {
				parkId,
				workflowId,
				parentId: input.parentId,
				childId: input.childId,
				taskId: input.taskId,
				attemptId: input.attemptId,
				outputObligationId: input.outputObligationId,
				baseHead: structuredClone(input.baseHead),
				baseEpoch: structuredClone(input.baseEpoch),
				stateDigest: input.stateDigest,
				latestStateDigest: input.stateDigest,
				independentReadyWork: input.independentReadyWork,
				deadlinePolicy: createDeadlinePolicy(durationMilliseconds, host.maxWaitMilliseconds, now),
				deadline: { status: "pending", transitionEventId: null, transitionReason: null },
				terminalRetentionRevision: null,
				snapshot: null,
				activity: null,
				childOutput: null,
				quarantineReason: null,
				wakes: [],
			};
			const next = withStateDigest({ ...state, parks: [...state.parks, park] });
			return { state: next, value: structuredClone(park) };
		});

	const parkChildAttempt = async (
		input: CoordinatorObligationParkFromChildInput,
	): Promise<CoordinatorObligationParkToken> => {
		await parkChildObligation({
			parentId: input.parentId,
			childId: input.child.childId,
			taskId: input.child.taskId,
			attemptId: input.child.attemptId,
			outputObligationId: input.child.outputObligation.obligationId,
			baseHead: input.child.head,
			baseEpoch: input.child.epochRef,
			stateDigest: input.child.stateDigest,
			deadlineMilliseconds: input.deadlineMilliseconds,
			independentReadyWork: input.independentReadyWork,
		});
		await recordChildAttemptOutput({ child: input.child });
		const state = await readState();
		const park = state.parks.find(
			(candidate) => candidate.outputObligationId === input.child.outputObligation.obligationId,
		);
		if (park === undefined) throw new Error("coordinator_obligation_park_missing");
		return park;
	};

	const recordLocalSnapshot = async (
		input: CoordinatorObligationSnapshotInput,
	): Promise<"recorded" | "already_recorded"> =>
		mutate("coordinator-obligation-snapshot", async (state, _now, _leaseRef, recordRevision) => {
			const snapshot = normalizeSnapshot(input);
			const park = state.parks.find((candidate) => candidate.outputObligationId === input.outputObligationId);
			if (park === undefined) throw new Error("coordinator_obligation_park_missing");
			await authorizeTransition(
				"snapshot",
				recordRevision,
				{
					parkId: park.parkId,
					parentId: park.parentId,
					childId: park.childId,
					taskId: park.taskId,
					attemptId: park.attemptId,
					outputObligationId: park.outputObligationId,
					baseHead: park.baseHead,
					independentReadyWork: park.independentReadyWork,
				},
				park.latestStateDigest,
			);
			if (park.snapshot !== null) {
				if (digestObject(park.snapshot) !== digestObject(snapshot))
					throw new Error("coordinator_obligation_snapshot_conflict");
				return { state, value: "already_recorded" };
			}
			const next = withStateDigest({
				...state,
				parks: state.parks.map((candidate) =>
					candidate.outputObligationId === input.outputObligationId ? { ...candidate, snapshot } : candidate,
				),
			});
			return { state: next, value: "recorded" };
		});

	const enqueueWake = (
		state: CoordinatorObligationSchedulerState,
		park: CoordinatorObligationParkToken,
		wake: CoordinatorObligationWakeRecord,
	): { readonly state: CoordinatorObligationSchedulerState; readonly episodeId: string } => {
		const ref: CoordinatorObligationWakeRef = {
			deliveryId: wake.deliveryId,
			parkId: park.parkId,
			attemptId: park.attemptId,
			wakeKey: wake.wakeKey,
			outputObligationId: park.outputObligationId,
			kind: wake.kind,
			createdByEventId: wake.createdByEventId,
		};
		let episodeIndex = -1;
		for (let index = state.wakeEpisodes.length - 1; index >= 0; index -= 1) {
			if (state.wakeEpisodes[index]?.status === "pending") {
				episodeIndex = index;
				break;
			}
		}
		if (
			episodeIndex < 0 ||
			(state.wakeEpisodes[episodeIndex]?.wakeRefs.length ?? MAX_WAKE_KEYS_PER_EPISODE) >= MAX_WAKE_KEYS_PER_EPISODE
		) {
			const episodeId = digestObject({ workflowId, sequence: state.nextWakeEpisodeSequence });
			const unsigned: Omit<CoordinatorObligationWakeEpisode, "packetDigest"> = {
				episodeId,
				wakeRefs: [ref],
				wakeKeys: [wake.wakeKey],
				outputObligationIds: [park.outputObligationId],
				priority: wake.kind === "gating" ? "urgent" : "normal",
				status: "pending",
				claim: null,
				safeBoundaryHandled: false,
				failureCount: 0,
				diagnostic: null,
			};
			return {
				state: withStateDigest({
					...state,
					nextWakeEpisodeSequence: state.nextWakeEpisodeSequence + 1,
					wakeEpisodes: [...state.wakeEpisodes, { ...unsigned, packetDigest: packetDigest(unsigned) }],
				}),
				episodeId,
			};
		}
		const episode = state.wakeEpisodes[episodeIndex] as CoordinatorObligationWakeEpisode;
		const unsigned: Omit<CoordinatorObligationWakeEpisode, "packetDigest"> = {
			...episode,
			wakeRefs: [...episode.wakeRefs, ref],
			wakeKeys: [...episode.wakeKeys, wake.wakeKey],
			outputObligationIds: [...episode.outputObligationIds, park.outputObligationId],
			priority: episode.priority === "urgent" || wake.kind === "gating" ? "urgent" : "normal",
			safeBoundaryHandled: wake.kind === "gating" ? false : episode.safeBoundaryHandled,
		};
		const wakeEpisodes = state.wakeEpisodes.map((candidate, index) =>
			index === episodeIndex ? { ...unsigned, packetDigest: packetDigest(unsigned) } : candidate,
		);
		return { state: withStateDigest({ ...state, wakeEpisodes }), episodeId: episode.episodeId };
	};

	const attachWakeToPark = (
		state: CoordinatorObligationSchedulerState,
		parkId: string,
		wake: CoordinatorObligationWakeRecord,
		episodeId: string,
	): CoordinatorObligationSchedulerState =>
		withStateDigest({
			...state,
			parks: state.parks.map((park) =>
				park.parkId === parkId ? { ...park, wakes: [...park.wakes, { ...wake, episodeId }] } : park,
			),
		});

	const escalatePendingWake = (
		state: CoordinatorObligationSchedulerState,
		park: CoordinatorObligationParkToken,
		wake: CoordinatorObligationWakeRecord,
	): CoordinatorObligationSchedulerState | null => {
		const existing = park.wakes.find(
			(candidate) =>
				candidate.parkId === park.parkId &&
				candidate.attemptId === park.attemptId &&
				candidate.wakeKey === wake.wakeKey,
		);
		if (existing === undefined || existing.kind === "gating" || wake.kind !== "gating") return null;
		const episode =
			existing.episodeId === null
				? undefined
				: state.wakeEpisodes.find((candidate) => candidate.episodeId === existing.episodeId);
		if (episode?.status === "pending") {
			const wakeEpisodes = state.wakeEpisodes.map((candidate) => {
				if (candidate.episodeId !== episode.episodeId) return candidate;
				const wakeRefs = candidate.wakeRefs.map((ref) =>
					ref.deliveryId === existing.deliveryId
						? {
								...ref,
								deliveryId: wake.deliveryId,
								kind: "gating" as const,
								createdByEventId: wake.createdByEventId,
							}
						: ref,
				);
				const unsigned: Omit<CoordinatorObligationWakeEpisode, "packetDigest"> = {
					...candidate,
					wakeRefs,
					priority: "urgent",
					safeBoundaryHandled: false,
				};
				return { ...unsigned, packetDigest: packetDigest(unsigned) };
			});
			return withStateDigest({
				...state,
				wakeEpisodes,
				parks: state.parks.map((candidate) =>
					candidate.parkId === park.parkId
						? {
								...candidate,
								wakes: candidate.wakes.map((item) =>
									item.deliveryId === existing.deliveryId
										? {
												...item,
												deliveryId: wake.deliveryId,
												kind: "gating" as const,
												createdByEventId: wake.createdByEventId,
											}
										: item,
								),
							}
						: candidate,
				),
				urgentBoundaryPending: true,
			});
		}
		return null;
	};

	const recordChildOutput = async (
		input: CoordinatorObligationChildOutputInput,
	): Promise<CoordinatorObligationWakeEpisode | null> =>
		mutate("coordinator-obligation-child-output", async (state, _now, _leaseRef, recordRevision) => {
			assertNonEmptyString(input.outputObligationId, "coordinator_obligation_output_obligation");
			assertNonEmptyString(input.stateDigest, "coordinator_obligation_state_digest");
			assertNonEmptyString(input.eventId, "coordinator_obligation_event");
			assertHead(input.head, workflowId, durable.epochRef);
			if (input.wakeKey !== undefined && input.wakeKey !== null) {
				assertNonEmptyString(input.wakeKey, "coordinator_obligation_wake_key");
				if (input.wakeKind === undefined) throw new Error("coordinator_obligation_wake_kind_missing");
			} else if (input.wakeKind !== undefined) {
				throw new Error("coordinator_obligation_wake_kind_invalid");
			}
			if (input.terminalStatus !== undefined) {
				if (input.wakeKey === undefined || input.wakeKey === null)
					throw new Error("coordinator_obligation_terminal_wake_missing");
				if (input.terminalReason !== undefined)
					assertNonEmptyString(
						input.terminalReason,
						"coordinator_obligation_terminal_reason",
						MAX_SCHEDULER_REASON_BYTES,
					);
			}
			const parkIndex = state.parks.findIndex(
				(candidate) => candidate.outputObligationId === input.outputObligationId,
			);
			if (parkIndex < 0) throw new Error("coordinator_obligation_park_missing");
			const currentPark = state.parks[parkIndex] as CoordinatorObligationParkToken;
			if (
				input.independentReadyWork !== undefined &&
				input.independentReadyWork !== currentPark.independentReadyWork
			)
				throw new Error("coordinator_obligation_ready_work_host_only");
			const terminalStatus = input.terminalStatus;
			const childOutput =
				terminalStatus === undefined
					? null
					: {
							eventId: input.eventId,
							stateDigest: input.stateDigest,
							head: structuredClone(input.head),
							independentReadyWork: currentPark.independentReadyWork,
							wakeKey: input.wakeKey ?? null,
							wakeKind: input.wakeKind ?? null,
							terminalStatus,
							terminalReason: input.terminalReason ?? terminalStatus,
						};
			if (
				childOutput !== null &&
				currentPark.childOutput !== null &&
				!sameChildOutput(currentPark.childOutput, childOutput)
			)
				throw new Error("coordinator_obligation_terminal_transition_conflict");
			if (childOutput !== null && currentPark.childOutput === null && currentPark.deadline.status !== "pending")
				throw new Error("coordinator_obligation_terminal_transition_conflict");
			await authorizeTransition(
				"child_output",
				recordRevision,
				{
					parkId: currentPark.parkId,
					parentId: currentPark.parentId,
					childId: currentPark.childId,
					taskId: currentPark.taskId,
					attemptId: currentPark.attemptId,
					outputObligationId: currentPark.outputObligationId,
					baseHead: currentPark.baseHead,
					independentReadyWork: currentPark.independentReadyWork,
				},
				input.stateDigest,
				{
					expectedChildHead: input.head,
					childOutputDigest: childOutput === null ? null : digestObject(childOutput),
				},
			);
			let next = withStateDigest({
				...state,
				parks: state.parks.map((candidate) => {
					if (candidate.outputObligationId !== input.outputObligationId) return candidate;
					if (childOutput === null) return { ...candidate, latestStateDigest: input.stateDigest };
					return {
						...candidate,
						latestStateDigest: input.stateDigest,
						...(candidate.childOutput === null
							? {
									childOutput,
									deadline: {
										status: terminalStatus as Exclude<
											CoordinatorObligationDeadlineStatus,
											"pending" | "expired"
										>,
										transitionEventId: input.eventId,
										transitionReason: childOutput.terminalReason,
									},
									terminalRetentionRevision: recordRevision + 1,
								}
							: {}),
					};
				}),
			});
			let episodeId: string | null = null;
			if (input.wakeKey !== undefined && input.wakeKey !== null) {
				const existingByKey = currentPark.wakes.find(
					(wake) =>
						wake.parkId === currentPark.parkId &&
						wake.attemptId === currentPark.attemptId &&
						wake.wakeKey === input.wakeKey,
				);
				const candidateWake: CoordinatorObligationWakeRecord = {
					deliveryId: wakeDeliveryId(
						currentPark.parkId,
						currentPark.attemptId,
						input.wakeKey,
						input.wakeKind as CoordinatorObligationWakeKind,
						input.eventId,
					),
					parkId: currentPark.parkId,
					attemptId: currentPark.attemptId,
					wakeKey: input.wakeKey,
					kind: input.wakeKind as CoordinatorObligationWakeKind,
					createdByEventId: input.eventId,
					episodeId: null,
				};
				const existingByEvent = currentPark.wakes.find(
					(wake) =>
						wake.parkId === currentPark.parkId &&
						wake.attemptId === currentPark.attemptId &&
						wake.wakeKey === input.wakeKey &&
						wake.kind === "gating" &&
						wake.createdByEventId === input.eventId,
				);
				if (existingByEvent !== undefined) {
					episodeId = existingByEvent.episodeId;
				} else if (
					existingByKey === undefined ||
					(input.wakeKind === "gating" && existingByKey.kind === "gating")
				) {
					if (currentPark.wakes.length >= MAX_WAKE_KEYS_PER_PARK)
						throw new Error("coordinator_obligation_wake_bound_exceeded");
					const queued = enqueueWake(next, currentPark, candidateWake);
					next = queued.state;
					episodeId = queued.episodeId;
					next = attachWakeToPark(next, currentPark.parkId, candidateWake, queued.episodeId);
				} else if (input.wakeKind === "gating") {
					const escalated = escalatePendingWake(next, currentPark, candidateWake);
					if (escalated !== null) {
						next = escalated;
						episodeId = existingByKey.episodeId;
					} else {
						const queued = enqueueWake(next, currentPark, candidateWake);
						next = attachWakeToPark(queued.state, currentPark.parkId, candidateWake, queued.episodeId);
						episodeId = queued.episodeId;
					}
				} else {
					episodeId = existingByKey?.episodeId ?? null;
				}
			}
			next = withStateDigest({ ...next, urgentBoundaryPending: hasUnresolvedUrgentBoundary(next) });
			const episode =
				episodeId === null
					? null
					: (next.wakeEpisodes.find((candidate) => candidate.episodeId === episodeId) ?? null);
			return { state: next, value: episode };
		});

	const recordChildAttemptOutput = async (
		input: CoordinatorObligationChildOutputFromChildInput,
	): Promise<CoordinatorObligationWakeEpisode | null> => {
		const child = input.child;
		const wake = child.coordinator.wake;
		return recordChildOutput({
			outputObligationId: child.outputObligation.obligationId,
			stateDigest: child.stateDigest,
			eventId: child.lastEventId ?? child.attemptId,
			head: child.head,
			wakeKey: wake?.wakeKey ?? null,
			wakeKind: wake?.kind,
			...(child.status === "completed" ||
			child.status === "cancelled" ||
			child.status === "terminal_failed" ||
			child.status === "scope_changed"
				? {
						terminalStatus:
							child.status === "completed"
								? "discharged"
								: child.status === "cancelled"
									? "cancelled"
									: child.status,
						terminalReason: child.reason ?? child.status,
					}
				: {}),
		});
	};

	const observeChildActivity = async (input: CoordinatorObligationActivityInput): Promise<void> => {
		await mutate("coordinator-obligation-activity", async (state, now, _leaseRef, recordRevision) => {
			assertNonEmptyString(input.outputObligationId, "coordinator_obligation_output_obligation");
			assertNonEmptyString(input.stateDigest, "coordinator_obligation_state_digest");
			if (
				!(["heartbeat", "whitespace", "activity", "compaction_progress"] as readonly string[]).includes(input.kind)
			)
				throw new Error("coordinator_obligation_activity_kind_invalid");
			const park = state.parks.find((candidate) => candidate.outputObligationId === input.outputObligationId);
			if (park === undefined) throw new Error("coordinator_obligation_park_missing");
			if (input.independentReadyWork !== undefined && input.independentReadyWork !== park.independentReadyWork)
				throw new Error("coordinator_obligation_ready_work_host_only");
			await authorizeTransition(
				"activity",
				recordRevision,
				{
					parkId: park.parkId,
					parentId: park.parentId,
					childId: park.childId,
					taskId: park.taskId,
					attemptId: park.attemptId,
					outputObligationId: park.outputObligationId,
					baseHead: park.baseHead,
					independentReadyWork: park.independentReadyWork,
				},
				input.stateDigest,
			);
			const next = withStateDigest({
				...state,
				parks: state.parks.map((candidate) =>
					candidate.outputObligationId === input.outputObligationId
						? {
								...candidate,
								latestStateDigest: input.stateDigest,
								independentReadyWork: candidate.independentReadyWork,
								activity: {
									kind: input.kind,
									stateDigest: input.stateDigest,
									progressDigest: input.progressDigest ?? null,
									observedAt: now,
								},
							}
						: candidate,
				),
			});
			return { state: next, value: undefined };
		});
	};

	const onHostTimer = async (): Promise<CoordinatorObligationSchedulerState> =>
		mutate("coordinator-obligation-host-timer", async (state, now, _leaseRef, recordRevision) => {
			let next = state;
			for (const park of state.parks) {
				if (park.deadline.status !== "pending" || !deadlineDue(park.deadlinePolicy, now)) continue;
				const authorization = await authorizeTransition(
					"deadline_expiry",
					recordRevision,
					{
						parkId: park.parkId,
						parentId: park.parentId,
						childId: park.childId,
						taskId: park.taskId,
						attemptId: park.attemptId,
						outputObligationId: park.outputObligationId,
						baseHead: park.baseHead,
						independentReadyWork: park.independentReadyWork,
					},
					null,
					{ allowMissingChild: true },
				);
				if (authorization.child === null) {
					next = withStateDigest({
						...next,
						parks: next.parks.map((candidate) =>
							candidate.parkId === park.parkId
								? { ...candidate, quarantineReason: "child_state_missing" }
								: candidate,
						),
					});
					continue;
				}
				const deadlineEventId = `deadline:${park.parkId}`;
				const terminalPark: CoordinatorObligationParkToken = {
					...park,
					latestStateDigest: authorization.child?.stateDigest ?? park.latestStateDigest,
					deadline: {
						status: "terminal_failed",
						transitionEventId: deadlineEventId,
						transitionReason: "host_deadline_elapsed",
					},
					terminalRetentionRevision: recordRevision + 1,
				};
				next = withStateDigest({
					...next,
					parks: next.parks.map((candidate) => (candidate.parkId === park.parkId ? terminalPark : candidate)),
				});
				const wake: CoordinatorObligationWakeRecord = {
					deliveryId: wakeDeliveryId(
						park.parkId,
						park.attemptId,
						`deadline:${park.parkId}`,
						"error",
						deadlineEventId,
					),
					parkId: park.parkId,
					attemptId: park.attemptId,
					wakeKey: `deadline:${park.parkId}`,
					kind: "error",
					createdByEventId: deadlineEventId,
					episodeId: null,
				};
				const queued = enqueueWake(next, terminalPark, wake);
				next = attachWakeToPark(queued.state, park.parkId, wake, queued.episodeId);
				next = incrementDiagnostic(next, DEFAULT_DIAGNOSTIC);
			}
			return { state: withStateDigest(next), value: cloneState(next) };
		});

	const revalidateHostEvidence = async (): Promise<void> => {
		const now = await trustedTime();
		const leaseRef = currentLease();
		if (!leaseAlive(leaseRef, now)) throw new Error("coordinator_obligation_lease_expired");
		const currentHead = await host.readCurrentHead();
		assertHead(currentHead, workflowId, durable.epochRef);
	};

	const readState = async (): Promise<CoordinatorObligationSchedulerState> => {
		await ensureHydrated();
		await revalidateHostEvidence();
		const loaded = await readPersisted();
		if (loaded === null) return cloneState(inMemory);
		inMemory = cloneState(loaded.state);
		inMemoryRevision = loaded.revision;
		return cloneState(loaded.state);
	};

	const modelTurnAdmission = async (): Promise<CoordinatorModelTurnAdmission> => {
		const state = await readState();
		const active = activeParks(state);
		const independent = active.some((park) => park.independentReadyWork);
		if (active.length === 0 && !state.urgentBoundaryPending)
			return {
				status: "admitted",
				reason: "no_parked_obligation",
				parkIds: [],
				outputObligationIds: [],
				independentDispatchAllowed: true,
				unrelatedWorkflowDispatchAllowed: true,
			};
		return {
			status: "parked",
			reason: "child_obligation",
			parkIds: active.map((park) => park.parkId),
			outputObligationIds: active.map((park) => park.outputObligationId),
			independentDispatchAllowed: independent,
			unrelatedWorkflowDispatchAllowed: independent || state.urgentBoundaryPending,
		};
	};

	const admitIndependentDispatch = async (): Promise<{ readonly allowed: true }> => {
		const admission = await modelTurnAdmission();
		if (!admission.independentDispatchAllowed) throw new Error("coordinator_obligation_no_independent_ready_work");
		return { allowed: true };
	};

	const episodeParkBinding = (
		state: CoordinatorObligationSchedulerState,
		episode: CoordinatorObligationWakeEpisode,
	): CoordinatorObligationParkBinding | null => {
		const ref = episode.wakeRefs[0];
		if (ref === undefined) return null;
		const park = state.parks.find((candidate) => candidate.parkId === ref.parkId);
		if (park === undefined) throw new Error("coordinator_obligation_park_missing");
		return {
			parkId: park.parkId,
			parentId: park.parentId,
			childId: park.childId,
			taskId: park.taskId,
			attemptId: park.attemptId,
			outputObligationId: park.outputObligationId,
			baseHead: park.baseHead,
			independentReadyWork: park.independentReadyWork,
		};
	};

	const claimWake = async (): Promise<CoordinatorObligationWakePacket | null> =>
		mutate("coordinator-obligation-wake-claim", async (state, now, leaseRef, recordRevision) => {
			const pendingIndex = state.wakeEpisodes.findIndex((episode) => episode.status === "pending");
			if (pendingIndex < 0) {
				const claimed = state.wakeEpisodes.find(
					(episode) =>
						episode.status === "claimed" &&
						episode.claim !== null &&
						sameWorkflowLeaseIdentity(episode.claim.leaseRef, leaseRef) &&
						leaseAlive(leaseRef, now),
				);
				if (claimed === undefined) return { state, value: null };
				await authorizeTransition("wake_claim", recordRevision, episodeParkBinding(state, claimed), null);
				return { state, value: packetFromEpisode(claimed) };
			}
			await authorizeTransition(
				"wake_claim",
				recordRevision,
				episodeParkBinding(state, state.wakeEpisodes[pendingIndex] as CoordinatorObligationWakeEpisode),
				null,
			);
			if (!leaseAlive(leaseRef, now)) throw new Error("coordinator_obligation_lease_expired");
			const episode = state.wakeEpisodes[pendingIndex] as CoordinatorObligationWakeEpisode;
			const claim: CoordinatorObligationWakeClaim = {
				claimId: digestObject({ episodeId: episode.episodeId, leaseRef }),
				leaseRef: structuredClone(leaseRef),
				claimedAt: now,
			};
			const unsigned: Omit<CoordinatorObligationWakeEpisode, "packetDigest"> = {
				...episode,
				status: "claimed",
				claim,
			};
			const next = withStateDigest({
				...state,
				wakeEpisodes: state.wakeEpisodes.map((candidate, index) =>
					index === pendingIndex ? { ...unsigned, packetDigest: packetDigest(unsigned) } : candidate,
				),
			});
			return {
				state: next,
				value: packetFromEpisode(next.wakeEpisodes[pendingIndex] as CoordinatorObligationWakeEpisode),
			};
		});

	const acknowledgeWake = async (input: { readonly episodeId: string; readonly claimId: string }): Promise<void> => {
		await mutate("coordinator-obligation-wake-ack", async (state, _now, leaseRef, recordRevision) => {
			assertNonEmptyString(input.episodeId, "coordinator_obligation_episode");
			assertNonEmptyString(input.claimId, "coordinator_obligation_claim");
			const index = state.wakeEpisodes.findIndex((episode) => episode.episodeId === input.episodeId);
			if (index < 0) throw new Error("coordinator_obligation_wake_missing");
			const episode = state.wakeEpisodes[index] as CoordinatorObligationWakeEpisode;
			await authorizeTransition("wake_acknowledge", recordRevision, episodeParkBinding(state, episode), null);
			if (episode.status === "acknowledged") {
				if (episode.claim?.claimId !== input.claimId) throw new Error("coordinator_obligation_wake_claim_conflict");
				return { state, value: undefined };
			}
			if (episode.status !== "claimed" || episode.claim?.claimId !== input.claimId)
				throw new Error("coordinator_obligation_wake_claim_conflict");
			if (!sameWorkflowLeaseIdentity(episode.claim.leaseRef, leaseRef))
				throw new Error("coordinator_obligation_wake_claim_fenced");
			const unsigned: Omit<CoordinatorObligationWakeEpisode, "packetDigest"> = {
				...episode,
				status: "acknowledged",
			};
			const urgent = episode.priority === "urgent";
			return {
				state: withStateDigest({
					...state,
					urgentBoundaryPending: state.urgentBoundaryPending || urgent,
					wakeEpisodes: state.wakeEpisodes.map((candidate, candidateIndex) =>
						candidateIndex === index ? { ...unsigned, packetDigest: packetDigest(unsigned) } : candidate,
					),
				}),
				value: undefined,
			};
		});
	};

	const handleUrgentSafeBoundary = async (input: { readonly episodeId: string }): Promise<void> => {
		await mutate("coordinator-obligation-safe-boundary", async (state, _now, _leaseRef, recordRevision) => {
			assertNonEmptyString(input.episodeId, "coordinator_obligation_episode");
			const episode = state.wakeEpisodes.find((candidate) => candidate.episodeId === input.episodeId);
			if (episode === undefined || episode.priority !== "urgent" || episode.status !== "acknowledged")
				throw new Error("coordinator_obligation_safe_boundary_required");
			await authorizeTransition("safe_boundary", recordRevision, episodeParkBinding(state, episode), null);
			const wakeEpisodes = state.wakeEpisodes.map((candidate) => {
				if (candidate.episodeId !== input.episodeId) return candidate;
				const unsigned: Omit<CoordinatorObligationWakeEpisode, "packetDigest"> = {
					...candidate,
					safeBoundaryHandled: true,
				};
				return { ...unsigned, packetDigest: packetDigest(unsigned) };
			});
			return {
				state: withStateDigest({
					...state,
					wakeEpisodes,
					urgentBoundaryPending: hasUnresolvedUrgentBoundary({ wakeEpisodes }),
				}),
				value: undefined,
			};
		});
	};

	const recordWakeFailure = async (input: {
		readonly episodeId: string;
		readonly claimId: string;
		readonly reason: string;
	}): Promise<void> => {
		await mutate("coordinator-obligation-wake-failure", async (state, _now, leaseRef, recordRevision) => {
			assertNonEmptyString(input.episodeId, "coordinator_obligation_episode");
			assertNonEmptyString(input.claimId, "coordinator_obligation_claim");
			assertNonEmptyString(input.reason, "coordinator_obligation_wake_failure_reason");
			const index = state.wakeEpisodes.findIndex((episode) => episode.episodeId === input.episodeId);
			if (index < 0) throw new Error("coordinator_obligation_wake_missing");
			const episode = state.wakeEpisodes[index] as CoordinatorObligationWakeEpisode;
			await authorizeTransition("wake_failure", recordRevision, episodeParkBinding(state, episode), null);
			if (episode.status !== "claimed" || episode.claim?.claimId !== input.claimId)
				throw new Error("coordinator_obligation_wake_claim_conflict");
			if (!sameWorkflowLeaseIdentity(episode.claim.leaseRef, leaseRef))
				throw new Error("coordinator_obligation_wake_claim_fenced");
			const failureCount = Math.min(MAX_WAKE_FAILURE_DIAGNOSTICS, episode.failureCount + 1);
			const status: CoordinatorObligationWakeEpisodeStatus =
				failureCount >= MAX_WAKE_FAILURE_DIAGNOSTICS ? "stalled" : "pending";
			const unsigned: Omit<CoordinatorObligationWakeEpisode, "packetDigest"> = {
				...episode,
				status,
				claim: null,
				failureCount,
				diagnostic: input.reason,
			};
			let next = withStateDigest({
				...state,
				wakeEpisodes: state.wakeEpisodes.map((candidate, candidateIndex) =>
					candidateIndex === index ? { ...unsigned, packetDigest: packetDigest(unsigned) } : candidate,
				),
			});
			next = incrementDiagnostic(next, WAKE_FAILURE_DIAGNOSTIC);
			return { state: next, value: undefined };
		});
	};

	const status = async (): Promise<CoordinatorObligationSchedulerStatus> => {
		const state = await readState();
		const active = activeParks(state);
		const independent = active.some((park) => park.independentReadyWork);
		return {
			status:
				active.length === 0
					? state.urgentBoundaryPending
						? "waiting_on_children"
						: "idle"
					: independent
						? "working"
						: "waiting_on_children",
			pendingObligationCount: active.length,
			independentReadyWork: independent,
			pendingWake: state.wakeEpisodes.some(
				(episode) => episode.status === "pending" || episode.status === "claimed" || episode.status === "stalled",
			),
			urgentDiagnostic: state.urgentDiagnostic,
		};
	};

	return {
		parkChildObligation,
		parkChildAttempt,
		recordLocalSnapshot,
		recordChildOutput,
		recordChildAttemptOutput,
		observeChildActivity,
		onHostTimer,
		modelTurnAdmission,
		admitIndependentDispatch,
		claimWake,
		acknowledgeWake,
		handleUrgentSafeBoundary,
		recordWakeFailure,
		readState,
		status,
	};
}
