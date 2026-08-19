import { digestObject } from "./contracts.js";

export const COMPACTION_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_COMPACTION_CHECKPOINT_BUDGET_BYTES = 64 * 1024 * 1024;
export const MAX_COMPACTION_TRANSIENT_VALUES = 256;
export const MAX_COMPACTION_VALUE_BYTES = 256 * 1024 * 1024;

const DIGEST = /^[0-9a-f]{64}$/u;
const ARTIFACT_REF = /^artifact:\/\/sha256\/[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DURABLE_KINDS = ["goal", "authority", "evidence", "queue"] as const;
const TRANSIENT_KINDS = ["notebook", "dataframe", "tool_output", "log_tail", "reproducible_cache"] as const;

export type CompactionDurableStateKind = (typeof DURABLE_KINDS)[number];
export type CompactionTransientStateKind = (typeof TRANSIENT_KINDS)[number];

export type CompactionAuthorityPhase =
	| "idle"
	| "externalizing"
	| "checkpointing"
	| "compacting"
	| "recovering"
	| "completed"
	| "failed";

export type CompactionAuthorityErrorCode =
	| "authority_busy"
	| "authority_input_invalid"
	| "context_input_invalid"
	| "durable_state_invalid"
	| "durable_state_over_budget"
	| "required_durable_state_missing"
	| "required_durable_state_over_budget"
	| "queue_state_required"
	| "transient_state_invalid"
	| "transient_raw_value_forbidden"
	| "transient_state_unhandled"
	| "checkpoint_invalid"
	| "checkpoint_unverifiable"
	| "lease_invalid"
	| "lease_expired"
	| "host_phase_failed"
	| "compaction_output_invalid"
	| "no_useful_progress"
	| "recovery_failed"
	| "wake_failed"
	| "admission_not_owned";

export interface CompactionLease {
	readonly workflowId: string;
	readonly leaseId: string;
	readonly acquiredAtMs: number;
	readonly deadlineAtMs: number;
}

export interface CompactionDurableStateRef {
	readonly stateId: string;
	readonly kind: CompactionDurableStateKind;
	readonly bytes: number;
	readonly digest: string;
	readonly artifactRef: string;
}

export interface CompactionTransientStateRef {
	readonly stateId: string;
	readonly kind: CompactionTransientStateKind;
	readonly bytes: number;
	readonly digest: string | null;
}

export interface CompactionAdmissionInput {
	readonly workflowId: string;
	readonly contextTokens: number;
	readonly contextWindowTokens: number;
	readonly reserveTokens: number;
	readonly transientBytes: number;
	readonly durableState: readonly CompactionDurableStateRef[];
	readonly requiredStateIds: readonly string[];
	readonly transientState: readonly CompactionTransientStateRef[];
	/** Compatibility input accepted only to prove that status flags do not authorize progress. */
	readonly isCompacting?: boolean;
}

export interface CompactionExternalizedState {
	readonly stateId: string;
	readonly artifactRef: string;
}

export interface CompactionCheckpoint {
	readonly workflowId: string;
	readonly checkpointRef: string;
	readonly durableBytes: number;
	readonly retainedStateIds: readonly string[];
	readonly requiredStateIds: readonly string[];
	readonly queueStateId: string;
	readonly stateDigest: string;
	readonly externalizedState: readonly CompactionExternalizedState[];
	readonly evictedStateIds: readonly string[];
	readonly remainingTransientBytes: 0;
}

export interface CompactionExternalizationResult {
	readonly externalizedState: readonly CompactionExternalizedState[];
	readonly evictedStateIds: readonly string[];
	readonly remainingTransientBytes: 0;
}

export interface CompactionCheckpointRequest {
	readonly workflowId: string;
	readonly durableState: readonly CompactionDurableStateRef[];
	readonly requiredStateIds: readonly string[];
	readonly queueStateId: string;
	readonly externalizedState: readonly CompactionExternalizedState[];
	readonly evictedStateIds: readonly string[];
	readonly maxBytes: number;
	readonly deadlineAtMs: number;
}

export interface CompactionExternalizationRequest {
	readonly workflowId: string;
	readonly transientState: readonly CompactionTransientStateRef[];
	readonly deadlineAtMs: number;
}

export interface CompactionCompactRequest {
	readonly workflowId: string;
	readonly checkpoint: CompactionCheckpoint;
	readonly initialContextTokens: number;
	readonly initialTransientBytes: 0;
	readonly deadlineAtMs: number;
	readonly signal: AbortSignal;
}

export interface CompactionCompactResult {
	readonly status: "completed" | "failed";
	readonly contextTokensAfter: number;
	readonly transientBytesAfter: 0;
	readonly durableBytesAfter: number;
	readonly failureReason: string | null;
}

export type CompactionRecoveryReason = "lease_expired" | "host_failure" | "no_useful_progress";

export interface CompactionRecoveryRequest {
	readonly workflowId: string;
	readonly checkpointRef: string;
	readonly requiredStateIds: readonly string[];
	readonly reason: CompactionRecoveryReason;
	readonly deadlineAtMs: number;
}

export interface CompactionRecoveryIntent {
	readonly recoveryId: string;
	readonly workflowId: string;
	readonly checkpointRef: string;
	readonly requiredStateIds: readonly string[];
	readonly action: "restore_durable_checkpoint";
}

export interface CompactionWakeRequest {
	readonly workflowId: string;
	readonly queueStateId: string;
	readonly wakeIdempotencyKey: string;
	readonly reason: "compaction_completed" | "compaction_recovery";
}

export interface CompactionWakeOwnership {
	readonly wakeIdempotencyKey: string;
	readonly status: "owned" | "already_owned";
}

export interface CompactionAuthorityHost {
	readonly lease: CompactionLease;
	readonly nowMs: () => number;
	readonly externalizeTransient: (input: CompactionExternalizationRequest) => Promise<CompactionExternalizationResult>;
	readonly checkpointDurable: (input: CompactionCheckpointRequest) => Promise<CompactionCheckpoint>;
	readonly readDurableCheckpoint: (input: {
		readonly workflowId: string;
		readonly checkpointRef: string;
	}) => Promise<CompactionCheckpoint>;
	readonly compactContext: (input: CompactionCompactRequest) => Promise<CompactionCompactResult>;
	readonly recoverFromCheckpoint: (input: CompactionRecoveryRequest) => Promise<CompactionRecoveryIntent>;
	readonly wakeCoordinator: (input: CompactionWakeRequest) => Promise<CompactionWakeOwnership>;
}

export interface CompactionAuthorityOptions {
	readonly host: CompactionAuthorityHost;
	readonly checkpointBudgetBytes?: number;
}

export interface CompactionPublicState {
	readonly phase: CompactionAuthorityPhase;
	readonly blocked_on: "compaction" | null;
	readonly elapsed_ms: number;
	readonly lease_deadline_ms: number | null;
	readonly useful_progress: boolean;
	readonly checkpoint_ref: string | null;
	readonly recovery_intent_ref: string | null;
	readonly wake_ownership: "none" | "owned" | "already_owned";
}

export interface CompactionAdmission {
	readonly schemaVersion: typeof COMPACTION_AUTHORITY_SCHEMA_VERSION;
	readonly workflowId: string;
	readonly lease: CompactionLease;
	readonly contextTokens: number;
	readonly transientBytesBefore: number;
	readonly checkpoint: CompactionCheckpoint;
	readonly queueStateId: string;
	readonly wakeIdempotencyKey: string;
	readonly admissionDigest: string;
}

export interface CompactionAdmissionResult {
	readonly status: "not_needed" | "admitted";
	readonly admission: CompactionAdmission | null;
	readonly state: CompactionPublicState;
}

export interface CompactionResumeInput {
	readonly workflowId: string;
	readonly checkpointRef: string;
	readonly contextTokens: number;
}

export interface CompactionRunResult {
	readonly status: "completed" | "recovery_required";
	readonly usefulProgress: boolean;
	readonly admission: CompactionAdmission;
	readonly compaction: CompactionCompactResult | null;
	readonly recoveryIntent: CompactionRecoveryIntent | null;
	readonly wake: CompactionWakeOwnership;
	readonly state: CompactionPublicState;
}

export interface CompactionAuthority {
	admit(input: CompactionAdmissionInput): Promise<CompactionAdmissionResult>;
	resume(input: CompactionResumeInput): Promise<CompactionAdmissionResult>;
	run(admission: CompactionAdmission): Promise<CompactionRunResult>;
	projectState(): CompactionPublicState;
}

export class CompactionAuthorityError extends Error {
	readonly code: CompactionAuthorityErrorCode;

	public constructor(code: CompactionAuthorityErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CompactionAuthorityError";
		this.code = code;
	}
}

interface MutableState {
	phase: CompactionAuthorityPhase;
	acquiredAtMs: number | null;
	deadlineAtMs: number | null;
	usefulProgress: boolean;
	checkpointRef: string | null;
	recoveryIntentRef: string | null;
	wakeOwnership: "none" | "owned" | "already_owned";
}

interface InternalAdmission {
	readonly admission: CompactionAdmission;
	readonly requiredStateIds: readonly string[];
	readonly requiredDurableBytes: number;
	readonly initialContextTokens: number;
	readonly initialTransientBytes: number;
}

const exactKeys = (
	value: Record<string, unknown>,
	expected: readonly string[],
	code: CompactionAuthorityErrorCode,
): void => {
	const allowed = new Set(expected);
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new CompactionAuthorityError(code, `${code}: unexpected field`);
};

const recordValue = (value: unknown, code: CompactionAuthorityErrorCode): Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new CompactionAuthorityError(code, `${code}: expected object`);
	return value as Record<string, unknown>;
};

function assertIdentifier(value: unknown, code: CompactionAuthorityErrorCode): asserts value is string {
	if (typeof value !== "string" || !IDENTIFIER.test(value))
		throw new CompactionAuthorityError(code, `${code}: invalid identifier`);
}

function assertDigest(value: unknown, code: CompactionAuthorityErrorCode): asserts value is string {
	if (typeof value !== "string" || !DIGEST.test(value))
		throw new CompactionAuthorityError(code, `${code}: invalid digest`);
}

function assertArtifactRef(value: unknown, code: CompactionAuthorityErrorCode): asserts value is string {
	if (typeof value !== "string" || !ARTIFACT_REF.test(value))
		throw new CompactionAuthorityError(code, `${code}: artifact reference is not content addressed`);
}

function assertBytes(value: unknown, code: CompactionAuthorityErrorCode, maximum: number): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw new CompactionAuthorityError(code, `${code}: invalid byte count`);
}

function assertExactUniqueIds(values: readonly string[], code: CompactionAuthorityErrorCode): void {
	if (values.length !== new Set(values).size) throw new CompactionAuthorityError(code, `${code}: duplicate state id`);
	for (const value of values) assertIdentifier(value, code);
}

function assertLease(lease: CompactionLease): void {
	const value = recordValue(lease, "lease_invalid");
	exactKeys(value, ["workflowId", "leaseId", "acquiredAtMs", "deadlineAtMs"], "lease_invalid");
	assertIdentifier(value.workflowId, "lease_invalid");
	assertIdentifier(value.leaseId, "lease_invalid");
	if (
		!Number.isSafeInteger(value.acquiredAtMs) ||
		!Number.isSafeInteger(value.deadlineAtMs) ||
		(value.deadlineAtMs as number) <= (value.acquiredAtMs as number)
	)
		throw new CompactionAuthorityError("lease_invalid", "lease_invalid: deadline must follow acquisition");
}

function assertLeaseBound(host: CompactionAuthorityHost, workflowId: string): void {
	assertLease(host.lease);
	if (host.lease.workflowId !== workflowId)
		throw new CompactionAuthorityError("lease_invalid", "lease_invalid: workflow binding");
	const now = host.nowMs();
	if (!Number.isSafeInteger(now) || now < 0)
		throw new CompactionAuthorityError("lease_invalid", "lease_invalid: trusted clock");
}

function assertDurableStateRef(value: unknown): CompactionDurableStateRef {
	const record = recordValue(value, "durable_state_invalid");
	exactKeys(record, ["stateId", "kind", "bytes", "digest", "artifactRef"], "durable_state_invalid");
	assertIdentifier(record.stateId, "durable_state_invalid");
	if (!(DURABLE_KINDS as readonly string[]).includes(String(record.kind)))
		throw new CompactionAuthorityError("durable_state_invalid", "durable_state_invalid: kind");
	assertBytes(record.bytes, "durable_state_invalid", MAX_COMPACTION_VALUE_BYTES);
	assertDigest(record.digest, "durable_state_invalid");
	assertArtifactRef(record.artifactRef, "durable_state_invalid");
	return {
		stateId: record.stateId,
		kind: record.kind as CompactionDurableStateKind,
		bytes: record.bytes,
		digest: record.digest,
		artifactRef: record.artifactRef,
	};
}

function assertTransientStateRef(value: unknown): CompactionTransientStateRef {
	const record = recordValue(value, "transient_state_invalid");
	if (Object.keys(record).some((key) => key === "value" || key === "rawValue" || key === "raw"))
		throw new CompactionAuthorityError(
			"transient_raw_value_forbidden",
			"transient_raw_value_forbidden: raw values are not admitted",
		);
	exactKeys(record, ["stateId", "kind", "bytes", "digest"], "transient_state_invalid");
	assertIdentifier(record.stateId, "transient_state_invalid");
	if (!(TRANSIENT_KINDS as readonly string[]).includes(String(record.kind)))
		throw new CompactionAuthorityError("transient_state_invalid", "transient_state_invalid: kind");
	assertBytes(record.bytes, "transient_state_invalid", MAX_COMPACTION_VALUE_BYTES);
	if (record.digest !== null) assertDigest(record.digest, "transient_state_invalid");
	return {
		stateId: record.stateId,
		kind: record.kind as CompactionTransientStateKind,
		bytes: record.bytes,
		digest: record.digest as string | null,
	};
}

function assertExternalizedState(value: unknown): CompactionExternalizedState {
	const record = recordValue(value, "checkpoint_invalid");
	exactKeys(record, ["stateId", "artifactRef"], "checkpoint_invalid");
	assertIdentifier(record.stateId, "checkpoint_invalid");
	assertArtifactRef(record.artifactRef, "checkpoint_invalid");
	return { stateId: record.stateId, artifactRef: record.artifactRef };
}

function assertCheckpoint(value: unknown, expectedWorkflowId: string): CompactionCheckpoint {
	const record = recordValue(value, "checkpoint_invalid");
	exactKeys(
		record,
		[
			"workflowId",
			"checkpointRef",
			"durableBytes",
			"retainedStateIds",
			"requiredStateIds",
			"queueStateId",
			"stateDigest",
			"externalizedState",
			"evictedStateIds",
			"remainingTransientBytes",
		],
		"checkpoint_invalid",
	);
	if (record.workflowId !== expectedWorkflowId)
		throw new CompactionAuthorityError("checkpoint_unverifiable", "checkpoint_unverifiable: workflow binding");
	assertArtifactRef(record.checkpointRef, "checkpoint_invalid");
	assertBytes(record.durableBytes, "checkpoint_invalid", MAX_COMPACTION_VALUE_BYTES);
	assertDigest(record.stateDigest, "checkpoint_invalid");
	if (
		!Array.isArray(record.retainedStateIds) ||
		!Array.isArray(record.requiredStateIds) ||
		!Array.isArray(record.evictedStateIds)
	)
		throw new CompactionAuthorityError("checkpoint_invalid", "checkpoint_invalid: state ids");
	assertExactUniqueIds(record.retainedStateIds as string[], "checkpoint_invalid");
	assertExactUniqueIds(record.requiredStateIds as string[], "checkpoint_invalid");
	assertIdentifier(record.queueStateId, "checkpoint_invalid");
	assertExactUniqueIds(record.evictedStateIds as string[], "checkpoint_invalid");
	if (!Array.isArray(record.externalizedState))
		throw new CompactionAuthorityError("checkpoint_invalid", "checkpoint_invalid: artifacts");
	const externalizedState = record.externalizedState.map(assertExternalizedState);
	const externalizedIds = externalizedState.map((item) => item.stateId);
	assertExactUniqueIds(externalizedIds, "checkpoint_invalid");
	if (record.remainingTransientBytes !== 0)
		throw new CompactionAuthorityError(
			"checkpoint_unverifiable",
			"checkpoint_unverifiable: transient state remained in checkpoint",
		);
	return {
		workflowId: record.workflowId,
		checkpointRef: record.checkpointRef,
		durableBytes: record.durableBytes,
		retainedStateIds: [...(record.retainedStateIds as string[])],
		requiredStateIds: [...(record.requiredStateIds as string[])],
		queueStateId: record.queueStateId,
		stateDigest: record.stateDigest,
		externalizedState,
		evictedStateIds: [...(record.evictedStateIds as string[])],
		remainingTransientBytes: 0,
	};
}

function assertExternalization(value: unknown, expectedIds: readonly string[]): CompactionExternalizationResult {
	const record = recordValue(value, "transient_state_unhandled");
	exactKeys(record, ["externalizedState", "evictedStateIds", "remainingTransientBytes"], "transient_state_unhandled");
	if (!Array.isArray(record.externalizedState) || !Array.isArray(record.evictedStateIds))
		throw new CompactionAuthorityError("transient_state_unhandled", "transient_state_unhandled: result shape");
	const externalizedState = record.externalizedState.map(assertExternalizedState);
	const evictedStateIds = [...(record.evictedStateIds as string[])];
	assertExactUniqueIds(evictedStateIds, "transient_state_unhandled");
	const handledIds = [...externalizedState.map((item) => item.stateId), ...evictedStateIds];
	assertExactUniqueIds(handledIds, "transient_state_unhandled");
	if (handledIds.length !== expectedIds.length || handledIds.some((id) => !expectedIds.includes(id)))
		throw new CompactionAuthorityError(
			"transient_state_unhandled",
			"transient_state_unhandled: every transient value must be evicted or externalized",
		);
	if (record.remainingTransientBytes !== 0)
		throw new CompactionAuthorityError(
			"transient_state_unhandled",
			"transient_state_unhandled: transient bytes remain",
		);
	return { externalizedState, evictedStateIds, remainingTransientBytes: 0 };
}

function assertRecoveryIntent(value: unknown, request: CompactionRecoveryRequest): CompactionRecoveryIntent {
	const record = recordValue(value, "recovery_failed");
	exactKeys(record, ["recoveryId", "workflowId", "checkpointRef", "requiredStateIds", "action"], "recovery_failed");
	assertIdentifier(record.recoveryId, "recovery_failed");
	if (record.workflowId !== request.workflowId || record.checkpointRef !== request.checkpointRef)
		throw new CompactionAuthorityError("recovery_failed", "recovery_failed: checkpoint binding");
	if (record.action !== "restore_durable_checkpoint")
		throw new CompactionAuthorityError("recovery_failed", "recovery_failed: restore action missing");
	if (!Array.isArray(record.requiredStateIds))
		throw new CompactionAuthorityError("recovery_failed", "recovery_failed: required closure missing");
	assertExactUniqueIds(record.requiredStateIds as string[], "recovery_failed");
	if (
		record.requiredStateIds.length !== request.requiredStateIds.length ||
		(request.requiredStateIds as readonly string[]).some((id) => !(record.requiredStateIds as string[]).includes(id))
	)
		throw new CompactionAuthorityError("recovery_failed", "recovery_failed: required closure changed");
	return {
		recoveryId: record.recoveryId,
		workflowId: record.workflowId,
		checkpointRef: record.checkpointRef,
		requiredStateIds: [...(record.requiredStateIds as string[])],
		action: "restore_durable_checkpoint",
	};
}

function assertWakeOwnership(value: unknown, key: string): CompactionWakeOwnership {
	const record = recordValue(value, "wake_failed");
	exactKeys(record, ["wakeIdempotencyKey", "status"], "wake_failed");
	if (record.wakeIdempotencyKey !== key || (record.status !== "owned" && record.status !== "already_owned"))
		throw new CompactionAuthorityError("wake_failed", "wake_failed: ownership response invalid");
	return { wakeIdempotencyKey: key, status: record.status };
}

function assertContextInput(
	input: CompactionAdmissionInput,
	budgetBytes: number,
): {
	readonly durableState: readonly CompactionDurableStateRef[];
	readonly requiredStateIds: readonly string[];
	readonly transientState: readonly CompactionTransientStateRef[];
	readonly requiredDurableBytes: number;
	readonly queueStateId: string;
} {
	assertIdentifier(input.workflowId, "authority_input_invalid");
	if (
		!Number.isSafeInteger(input.contextTokens) ||
		input.contextTokens < 0 ||
		!Number.isSafeInteger(input.contextWindowTokens) ||
		input.contextWindowTokens < 1 ||
		!Number.isSafeInteger(input.reserveTokens) ||
		input.reserveTokens < 0 ||
		input.reserveTokens >= input.contextWindowTokens
	)
		throw new CompactionAuthorityError("context_input_invalid", "context_input_invalid: token threshold");
	if (!Number.isSafeInteger(input.transientBytes) || input.transientBytes < 0)
		throw new CompactionAuthorityError("transient_state_invalid", "transient_state_invalid: aggregate bytes");
	if (!Array.isArray(input.durableState) || input.durableState.length === 0)
		throw new CompactionAuthorityError("durable_state_invalid", "durable_state_invalid: durable refs required");
	if (!Array.isArray(input.requiredStateIds))
		throw new CompactionAuthorityError(
			"required_durable_state_missing",
			"required_durable_state_missing: registry is not an array",
		);
	if (!Array.isArray(input.transientState) || input.transientState.length > MAX_COMPACTION_TRANSIENT_VALUES)
		throw new CompactionAuthorityError("transient_state_invalid", "transient_state_invalid: value bound");
	if (input.isCompacting !== undefined && typeof input.isCompacting !== "boolean")
		throw new CompactionAuthorityError("authority_input_invalid", "authority_input_invalid: status flag");
	const durableState = input.durableState.map(assertDurableStateRef);
	const durableIds = durableState.map((item) => item.stateId);
	assertExactUniqueIds(durableIds, "durable_state_invalid");
	const requiredStateIds = [...input.requiredStateIds];
	assertExactUniqueIds(requiredStateIds, "required_durable_state_missing");
	if (requiredStateIds.some((id) => !durableIds.includes(id)))
		throw new CompactionAuthorityError(
			"required_durable_state_missing",
			"required_durable_state_missing: required ref absent",
		);
	const requiredDurableBytes = durableState
		.filter((item) => requiredStateIds.includes(item.stateId))
		.reduce((total, item) => total + item.bytes, 0);
	const durableBytes = durableState.reduce((total, item) => total + item.bytes, 0);
	if (requiredDurableBytes > budgetBytes)
		throw new CompactionAuthorityError(
			"required_durable_state_over_budget",
			"required_durable_state_over_budget: required refs exceed budget",
		);
	if (durableBytes > budgetBytes)
		throw new CompactionAuthorityError(
			"durable_state_over_budget",
			"durable_state_over_budget: durable refs exceed budget",
		);
	const transientState = input.transientState.map(assertTransientStateRef);
	const transientIds = transientState.map((item) => item.stateId);
	assertExactUniqueIds(transientIds, "transient_state_invalid");
	const transientBytes = transientState.reduce((total, item) => total + item.bytes, 0);
	if (transientBytes !== input.transientBytes)
		throw new CompactionAuthorityError(
			"transient_state_invalid",
			"transient_state_invalid: aggregate does not match metadata",
		);
	const queueRefs = durableState.filter((item) => item.kind === "queue");
	if (queueRefs.length !== 1 || !requiredStateIds.includes(queueRefs[0]?.stateId ?? ""))
		throw new CompactionAuthorityError(
			"queue_state_required",
			"queue_state_required: exactly one required queue ref is required",
		);
	return {
		durableState,
		requiredStateIds,
		transientState,
		requiredDurableBytes,
		queueStateId: queueRefs[0]?.stateId as string,
	};
}

function publicState(state: MutableState, nowMs: number): CompactionPublicState {
	const elapsed = state.acquiredAtMs === null ? 0 : Math.max(0, nowMs - state.acquiredAtMs);
	return Object.freeze({
		phase: state.phase,
		blocked_on:
			state.phase === "externalizing" ||
			state.phase === "checkpointing" ||
			state.phase === "compacting" ||
			state.phase === "recovering"
				? "compaction"
				: null,
		elapsed_ms: elapsed,
		lease_deadline_ms: state.deadlineAtMs,
		useful_progress: state.usefulProgress,
		checkpoint_ref: state.checkpointRef,
		recovery_intent_ref: state.recoveryIntentRef,
		wake_ownership: state.wakeOwnership,
	});
}

function admissionDigest(admission: Omit<CompactionAdmission, "admissionDigest">): string {
	return digestObject({
		schemaVersion: admission.schemaVersion,
		workflowId: admission.workflowId,
		lease: admission.lease,
		contextTokens: admission.contextTokens,
		transientBytesBefore: admission.transientBytesBefore,
		checkpoint: admission.checkpoint,
		queueStateId: admission.queueStateId,
		wakeIdempotencyKey: admission.wakeIdempotencyKey,
	});
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}

function sealAdmission(withoutDigest: Omit<CompactionAdmission, "admissionDigest">): CompactionAdmission {
	return deepFreeze({ ...withoutDigest, admissionDigest: admissionDigest(withoutDigest) });
}

function admissionWithoutDigest(admission: CompactionAdmission): Omit<CompactionAdmission, "admissionDigest"> {
	const { admissionDigest: _admissionDigest, ...withoutDigest } = admission;
	return withoutDigest;
}

function assertAdmission(admission: CompactionAdmission, internal: InternalAdmission | undefined): InternalAdmission {
	if (internal === undefined || internal.admission !== admission)
		throw new CompactionAuthorityError(
			"admission_not_owned",
			"admission_not_owned: use this authority or resume from the host",
		);
	if (admission.admissionDigest !== admissionDigest(admissionWithoutDigest(admission)))
		throw new CompactionAuthorityError("admission_not_owned", "admission_not_owned: admission digest mismatch");
	return internal;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 256);
	return "host phase failed";
}

function recoveryReason(error: unknown): CompactionRecoveryReason {
	if (error instanceof CompactionAuthorityError && error.code === "lease_expired") return "lease_expired";
	if (error instanceof CompactionAuthorityError && error.code === "no_useful_progress") return "no_useful_progress";
	return "host_failure";
}

function createDeadlineSignal(
	host: CompactionAuthorityHost,
	deadlineAtMs: number,
): {
	readonly signal: AbortSignal;
	readonly dispose: () => void;
} {
	const controller = new AbortController();
	const remaining = deadlineAtMs - host.nowMs();
	const timer =
		remaining > 0 ? setTimeout(() => controller.abort("compaction_deadline_expired"), remaining) : undefined;
	return {
		signal: controller.signal,
		dispose: () => {
			if (timer !== undefined) clearTimeout(timer);
		},
	};
}

/**
 * Create a host-bound compaction admission and recovery authority.
 *
 * The host owns the lease and all durable effects. This boundary receives only
 * state references and metadata, so transient kernel values cannot enter a checkpoint.
 *
 * Args:
 * options: Host lease, trusted clock, durable checkpoint, compaction, recovery, and wake adapters.
 * Return: Authority methods for admission, restart resume, compaction, and public projection.
 */
export function createCompactionAuthority(options: CompactionAuthorityOptions): CompactionAuthority {
	const host = options.host;
	const budgetBytes = options.checkpointBudgetBytes ?? DEFAULT_COMPACTION_CHECKPOINT_BUDGET_BYTES;
	if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1 || budgetBytes > MAX_COMPACTION_VALUE_BYTES)
		throw new CompactionAuthorityError("authority_input_invalid", "authority_input_invalid: checkpoint budget");
	assertLease(host.lease);
	const admissions = new WeakMap<object, InternalAdmission>();
	const wakeKeys = new Set<string>();
	const state: MutableState = {
		phase: "idle",
		acquiredAtMs: null,
		deadlineAtMs: null,
		usefulProgress: false,
		checkpointRef: null,
		recoveryIntentRef: null,
		wakeOwnership: "none",
	};
	let lastResult: CompactionRunResult | null = null;

	const assertBeforeDeadline = (deadlineAtMs: number): void => {
		if (host.nowMs() >= deadlineAtMs)
			throw new CompactionAuthorityError("lease_expired", "lease_expired: host deadline elapsed");
	};

	const setLeaseState = (): void => {
		state.acquiredAtMs = host.lease.acquiredAtMs;
		state.deadlineAtMs = host.lease.deadlineAtMs;
	};

	const wakeOnce = async (
		admission: CompactionAdmission,
		reason: "compaction_completed" | "compaction_recovery",
	): Promise<CompactionWakeOwnership> => {
		if (wakeKeys.has(admission.wakeIdempotencyKey) && state.wakeOwnership !== "none") {
			return { wakeIdempotencyKey: admission.wakeIdempotencyKey, status: state.wakeOwnership };
		}
		try {
			const ownership = assertWakeOwnership(
				await host.wakeCoordinator({
					workflowId: admission.workflowId,
					queueStateId: admission.queueStateId,
					wakeIdempotencyKey: admission.wakeIdempotencyKey,
					reason,
				}),
				admission.wakeIdempotencyKey,
			);
			wakeKeys.add(admission.wakeIdempotencyKey);
			state.wakeOwnership = ownership.status;
			return ownership;
		} catch (error) {
			state.phase = "failed";
			throw error instanceof CompactionAuthorityError
				? error
				: new CompactionAuthorityError("wake_failed", `wake_failed: ${errorMessage(error)}`, { cause: error });
		}
	};

	const recover = async (internal: InternalAdmission, error: unknown): Promise<CompactionRunResult> => {
		state.phase = "recovering";
		const request: CompactionRecoveryRequest = {
			workflowId: internal.admission.workflowId,
			checkpointRef: internal.admission.checkpoint.checkpointRef,
			requiredStateIds: internal.requiredStateIds,
			reason: recoveryReason(error),
			deadlineAtMs: internal.admission.lease.deadlineAtMs,
		};
		let intent: CompactionRecoveryIntent;
		try {
			intent = assertRecoveryIntent(await host.recoverFromCheckpoint(request), request);
		} catch (recoveryError) {
			state.phase = "failed";
			throw recoveryError instanceof CompactionAuthorityError
				? recoveryError
				: new CompactionAuthorityError("recovery_failed", `recovery_failed: ${errorMessage(recoveryError)}`, {
						cause: recoveryError,
					});
		}
		state.recoveryIntentRef = intent.recoveryId;
		const wake = await wakeOnce(internal.admission, "compaction_recovery");
		state.phase = "failed";
		const result: CompactionRunResult = Object.freeze({
			status: "recovery_required",
			usefulProgress: state.usefulProgress,
			admission: internal.admission,
			compaction: null,
			recoveryIntent: intent,
			wake,
			state: publicState(state, host.nowMs()),
		});
		lastResult = result;
		return result;
	};

	const makeAdmission = (
		input: CompactionAdmissionInput,
		checkpoint: CompactionCheckpoint,
		validated: ReturnType<typeof assertContextInput>,
	): CompactionAdmission => {
		if (
			checkpoint.requiredStateIds.length !== validated.requiredStateIds.length ||
			validated.requiredStateIds.some((id) => !checkpoint.requiredStateIds.includes(id))
		)
			throw new CompactionAuthorityError(
				"checkpoint_unverifiable",
				"checkpoint_unverifiable: required state closure changed",
			);
		if (
			checkpoint.queueStateId !== validated.queueStateId ||
			!validated.requiredStateIds.includes(checkpoint.queueStateId)
		)
			throw new CompactionAuthorityError(
				"checkpoint_unverifiable",
				"checkpoint_unverifiable: queue state binding changed",
			);
		if (validated.requiredStateIds.some((id) => !checkpoint.retainedStateIds.includes(id)))
			throw new CompactionAuthorityError(
				"checkpoint_unverifiable",
				"checkpoint_unverifiable: required state was dropped",
			);
		if (checkpoint.durableBytes > budgetBytes || checkpoint.durableBytes < validated.requiredDurableBytes)
			throw new CompactionAuthorityError(
				"checkpoint_unverifiable",
				"checkpoint_unverifiable: durable byte claim is outside bounds",
			);
		const wakeIdempotencyKey = digestObject({
			schemaVersion: COMPACTION_AUTHORITY_SCHEMA_VERSION,
			workflowId: input.workflowId,
			checkpointRef: checkpoint.checkpointRef,
			queueStateId: validated.queueStateId,
			event: "compaction_wake",
		});
		const withoutDigest: Omit<CompactionAdmission, "admissionDigest"> = {
			schemaVersion: COMPACTION_AUTHORITY_SCHEMA_VERSION,
			workflowId: input.workflowId,
			lease: structuredClone(host.lease),
			contextTokens: input.contextTokens,
			transientBytesBefore: input.transientBytes,
			checkpoint: structuredClone(checkpoint),
			queueStateId: validated.queueStateId,
			wakeIdempotencyKey,
		};
		return sealAdmission(withoutDigest);
	};

	const admit = async (input: CompactionAdmissionInput): Promise<CompactionAdmissionResult> => {
		if (state.phase !== "idle")
			throw new CompactionAuthorityError(
				"authority_busy",
				"authority_busy: compaction is already terminal or active",
			);
		const validated = assertContextInput(input, budgetBytes);
		assertLeaseBound(host, input.workflowId);
		const threshold = input.contextWindowTokens - input.reserveTokens;
		if (input.contextTokens < threshold)
			return Object.freeze({ status: "not_needed", admission: null, state: publicState(state, host.nowMs()) });
		setLeaseState();
		assertBeforeDeadline(host.lease.deadlineAtMs);
		state.phase = "externalizing";
		let externalized: CompactionExternalizationResult;
		try {
			externalized = assertExternalization(
				await host.externalizeTransient({
					workflowId: input.workflowId,
					transientState: structuredClone(validated.transientState),
					deadlineAtMs: host.lease.deadlineAtMs,
				}),
				validated.transientState.map((item) => item.stateId),
			);
		} catch (error) {
			state.phase = "failed";
			throw error instanceof CompactionAuthorityError
				? error
				: new CompactionAuthorityError("host_phase_failed", `host_phase_failed: ${errorMessage(error)}`, {
						cause: error,
					});
		}
		assertBeforeDeadline(host.lease.deadlineAtMs);
		state.phase = "checkpointing";
		let checkpoint: CompactionCheckpoint;
		try {
			checkpoint = assertCheckpoint(
				await host.checkpointDurable({
					workflowId: input.workflowId,
					durableState: structuredClone(validated.durableState),
					requiredStateIds: structuredClone(validated.requiredStateIds),
					queueStateId: validated.queueStateId,
					externalizedState: structuredClone(externalized.externalizedState),
					evictedStateIds: structuredClone(externalized.evictedStateIds),
					maxBytes: budgetBytes,
					deadlineAtMs: host.lease.deadlineAtMs,
				}),
				input.workflowId,
			);
		} catch (error) {
			state.phase = "failed";
			throw error instanceof CompactionAuthorityError
				? error
				: new CompactionAuthorityError("host_phase_failed", `host_phase_failed: ${errorMessage(error)}`, {
						cause: error,
					});
		}
		const admission = makeAdmission(input, checkpoint, validated);
		admissions.set(admission, {
			admission,
			requiredStateIds: validated.requiredStateIds,
			requiredDurableBytes: validated.requiredDurableBytes,
			initialContextTokens: input.contextTokens,
			initialTransientBytes: input.transientBytes,
		});
		state.phase = "compacting";
		return Object.freeze({ status: "admitted", admission, state: publicState(state, host.nowMs()) });
	};

	const resume = async (input: CompactionResumeInput): Promise<CompactionAdmissionResult> => {
		if (state.phase !== "idle")
			throw new CompactionAuthorityError(
				"authority_busy",
				"authority_busy: compaction is already terminal or active",
			);
		assertIdentifier(input.workflowId, "authority_input_invalid");
		assertArtifactRef(input.checkpointRef, "checkpoint_invalid");
		if (!Number.isSafeInteger(input.contextTokens) || input.contextTokens < 0)
			throw new CompactionAuthorityError("context_input_invalid", "context_input_invalid: resume token count");
		assertLeaseBound(host, input.workflowId);
		let checkpoint: CompactionCheckpoint;
		try {
			checkpoint = assertCheckpoint(
				await host.readDurableCheckpoint({ workflowId: input.workflowId, checkpointRef: input.checkpointRef }),
				input.workflowId,
			);
		} catch (error) {
			state.phase = "failed";
			throw error instanceof CompactionAuthorityError
				? error
				: new CompactionAuthorityError(
						"checkpoint_unverifiable",
						`checkpoint_unverifiable: ${errorMessage(error)}`,
						{ cause: error },
					);
		}
		if (checkpoint.checkpointRef !== input.checkpointRef)
			throw new CompactionAuthorityError("checkpoint_unverifiable", "checkpoint_unverifiable: reference mismatch");
		assertExactUniqueIds(checkpoint.requiredStateIds, "required_durable_state_missing");
		if (checkpoint.requiredStateIds.length === 0)
			throw new CompactionAuthorityError(
				"required_durable_state_missing",
				"required_durable_state_missing: empty closure",
			);
		const queueStateId = checkpoint.queueStateId;
		if (!checkpoint.requiredStateIds.includes(queueStateId))
			throw new CompactionAuthorityError(
				"queue_state_required",
				"queue_state_required: queue ref is not present in checkpoint closure",
			);
		setLeaseState();
		const withoutDigest: Omit<CompactionAdmission, "admissionDigest"> = {
			schemaVersion: COMPACTION_AUTHORITY_SCHEMA_VERSION,
			workflowId: input.workflowId,
			lease: structuredClone(host.lease),
			contextTokens: input.contextTokens,
			transientBytesBefore: checkpoint.remainingTransientBytes,
			checkpoint: structuredClone(checkpoint),
			queueStateId,
			wakeIdempotencyKey: digestObject({
				schemaVersion: COMPACTION_AUTHORITY_SCHEMA_VERSION,
				workflowId: input.workflowId,
				checkpointRef: checkpoint.checkpointRef,
				queueStateId,
				event: "compaction_wake",
			}),
		};
		const admission = sealAdmission(withoutDigest);
		admissions.set(admission, {
			admission,
			requiredStateIds: [...checkpoint.requiredStateIds],
			requiredDurableBytes: checkpoint.durableBytes,
			initialContextTokens: input.contextTokens,
			initialTransientBytes: checkpoint.remainingTransientBytes,
		});
		state.phase = "compacting";
		return Object.freeze({ status: "admitted", admission, state: publicState(state, host.nowMs()) });
	};

	const run = async (admission: CompactionAdmission): Promise<CompactionRunResult> => {
		const internal = assertAdmission(admission, admissions.get(admission));
		if (lastResult !== null) return lastResult;
		let compaction: CompactionCompactResult;
		const deadlineSignal = createDeadlineSignal(host, admission.lease.deadlineAtMs);
		try {
			assertBeforeDeadline(admission.lease.deadlineAtMs);
			compaction = await host.compactContext({
				workflowId: admission.workflowId,
				checkpoint: structuredClone(admission.checkpoint),
				initialContextTokens: internal.initialContextTokens,
				initialTransientBytes: 0,
				deadlineAtMs: admission.lease.deadlineAtMs,
				signal: deadlineSignal.signal,
			});
			assertBeforeDeadline(admission.lease.deadlineAtMs);
			const record = recordValue(compaction, "compaction_output_invalid");
			exactKeys(
				record,
				["status", "contextTokensAfter", "transientBytesAfter", "durableBytesAfter", "failureReason"],
				"compaction_output_invalid",
			);
			const status = record.status;
			if (status !== "completed" && status !== "failed")
				throw new CompactionAuthorityError("compaction_output_invalid", "compaction_output_invalid: status");
			assertBytes(record.contextTokensAfter, "compaction_output_invalid", Number.MAX_SAFE_INTEGER);
			if (record.transientBytesAfter !== 0)
				throw new CompactionAuthorityError(
					"compaction_output_invalid",
					"compaction_output_invalid: transient bytes remain",
				);
			assertBytes(record.durableBytesAfter, "compaction_output_invalid", budgetBytes);
			if (record.durableBytesAfter < internal.requiredDurableBytes)
				throw new CompactionAuthorityError(
					"compaction_output_invalid",
					"compaction_output_invalid: required bytes were dropped",
				);
			if (record.failureReason !== null && typeof record.failureReason !== "string")
				throw new CompactionAuthorityError(
					"compaction_output_invalid",
					"compaction_output_invalid: output is outside the durable budget",
				);
			compaction = {
				status,
				contextTokensAfter: record.contextTokensAfter,
				transientBytesAfter: 0,
				durableBytesAfter: record.durableBytesAfter,
				failureReason: record.failureReason as string | null,
			};
		} catch (error) {
			deadlineSignal.dispose();
			return recover(internal, error);
		} finally {
			deadlineSignal.dispose();
		}
		const actualProgress =
			compaction.contextTokensAfter < internal.initialContextTokens || internal.initialTransientBytes > 0;
		state.usefulProgress = actualProgress;
		if (compaction.status !== "completed")
			return recover(
				internal,
				new CompactionAuthorityError("host_phase_failed", compaction.failureReason ?? "compaction failed"),
			);
		if (!actualProgress)
			return recover(
				internal,
				new CompactionAuthorityError("no_useful_progress", "no_useful_progress: compaction did not reduce state"),
			);
		state.phase = "completed";
		const wake = await wakeOnce(admission, "compaction_completed");
		const result: CompactionRunResult = Object.freeze({
			status: "completed",
			usefulProgress: actualProgress,
			admission,
			compaction,
			recoveryIntent: null,
			wake,
			state: publicState(state, host.nowMs()),
		});
		lastResult = result;
		return result;
	};

	const projectState = (): CompactionPublicState => publicState(state, host.nowMs());

	return Object.freeze({ admit, resume, run, projectState });
}
