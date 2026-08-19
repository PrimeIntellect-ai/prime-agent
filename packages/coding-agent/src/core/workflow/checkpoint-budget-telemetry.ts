import type {
	WorkflowArtifactRef,
	WorkflowCheckpointBudgetObservationPayload,
	WorkflowCheckpointBudgetRequiredStatePayload,
	WorkflowEpochRef,
	WorkflowHostPrincipalCapabilityAuthorization,
	WorkflowHostPrincipalCapabilityAuthorizer,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowRuntimeStore,
	WorkflowStoreCommitResult,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { digestObject } from "./contracts.js";
import { assertWorkflowRuntimeVersion, MIN_WORKFLOW_RUNTIME_VERSION } from "./runtime-store-adapter.js";

export const WORKFLOW_CHECKPOINT_BUDGET_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const MAX_CHECKPOINT_TELEMETRY_BYTES = 256 * 1024 * 1024;
export const MAX_CHECKPOINT_RETAINED_VALUES = 256;
export const MAX_CHECKPOINT_TELEMETRY_EVENTS = 1024;
export const MAX_CHECKPOINT_TELEMETRY_CUMULATIVE_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_CHECKPOINT_TELEMETRY_CUMULATIVE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CHECKPOINT_TELEMETRY_STRING_BYTES = 256;
export const MAX_CHECKPOINT_TELEMETRY_PATH_BYTES = 512;
export const MAX_CHECKPOINT_TELEMETRY_PUBLIC_BOUNDARY_BYTES = 128;
export const MIN_CHECKPOINT_TELEMETRY_RUNTIME_VERSION = MIN_WORKFLOW_RUNTIME_VERSION;

export type WorkflowCheckpointRetentionClass =
	| "durable_fact"
	| "artifact_ref"
	| "transient_tool_output"
	| "transient_dataframe"
	| "transient_log_tail"
	| "reproducible_cache";

export type WorkflowCheckpointRepresentation = "durable" | "transient" | "unavailable";

export type WorkflowCheckpointRetentionReasonCode =
	| "transient"
	| "not_serializable"
	| "missing"
	| "restore_failed"
	| "reproducible";

export interface WorkflowCheckpointTelemetryBinding {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly processGenerationId: string;
	readonly runtimeVersion: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
}

export interface WorkflowCheckpointTelemetryHostBinding {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly processGenerationId: string;
	readonly runtimeVersion: string;
}

export interface WorkflowCheckpointRequiredStateDefinition {
	readonly valueId: string;
	readonly type: string;
	readonly classification: "durable_fact" | "artifact_ref";
}

export interface WorkflowCheckpointRetainedValueInput {
	readonly valueId: string;
	readonly type: string;
	readonly bytes: number;
	readonly classification: WorkflowCheckpointRetentionClass;
	readonly representation: WorkflowCheckpointRepresentation;
	readonly digest: string | null;
	readonly artifactRef: WorkflowArtifactRef | null;
	readonly reasonCode: WorkflowCheckpointRetentionReasonCode | null;
}

export interface WorkflowCheckpointRetainedValue extends WorkflowCheckpointRetainedValueInput {
	readonly required: boolean;
}

export interface WorkflowCheckpointBudgetTelemetryObservationInput {
	readonly schemaVersion: 1;
	readonly checkpointTurn: number;
	readonly serializeStartedAtMonotonicMs: number;
	readonly serializeEndedAtMonotonicMs: number;
	readonly restoreStartedAtMonotonicMs: number | null;
	readonly restoreEndedAtMonotonicMs: number | null;
	readonly bytesWritten: number;
	readonly retainedValues: readonly WorkflowCheckpointRetainedValueInput[];
}

export type WorkflowCheckpointBudgetTelemetryEventInput = WorkflowCheckpointBudgetTelemetryObservationInput;
export type WorkflowCheckpointBudgetTelemetryEvent = WorkflowCheckpointBudgetObservationPayload;

export interface WorkflowCheckpointBudgetTelemetryHostState {
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly stateDigest: string;
	readonly revision: number;
	readonly executionIdentity?: string;
	readonly sessionId?: string;
}

export interface WorkflowCheckpointBudgetTelemetryReceiptIssueInput {
	readonly receiptKind: "capability";
	readonly workflowId: string;
	readonly bindingDigest: string;
	readonly capability: "workflow_checkpoint_budget_observation";
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly executionIdentity?: string;
	readonly sessionId?: string;
	readonly stateDigest: string;
	readonly revision: number;
}

export type WorkflowCheckpointBudgetTelemetryReceiptIssuer = (
	input: WorkflowCheckpointBudgetTelemetryReceiptIssueInput,
) => Promise<WorkflowVerifiedHostReceipt>;

export interface WorkflowCheckpointBudgetTelemetryHost {
	readonly binding: WorkflowCheckpointTelemetryHostBinding;
	readonly requiredStateRegistry: readonly WorkflowCheckpointRequiredStateDefinition[];
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly principalAuthorizer: WorkflowHostPrincipalCapabilityAuthorizer;
	readonly issueReceipt: WorkflowCheckpointBudgetTelemetryReceiptIssuer;
	readonly resolveState: () => Promise<WorkflowCheckpointBudgetTelemetryHostState>;
	readonly publicBoundary: string;
}

export interface WorkflowCheckpointBudgetTelemetryHostContract {
	readonly recordCheckpoint: (
		input: WorkflowCheckpointBudgetTelemetryObservationInput,
	) => Promise<WorkflowCheckpointBudgetTelemetryEvent>;
}

export interface WorkflowCheckpointLargestRetainedValue {
	readonly valueId: string;
	readonly type: string;
	readonly bytes: number;
	readonly classification: "durable_fact" | "artifact_ref";
}

export interface WorkflowCheckpointBudgetTelemetryProjection {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly processGenerationId: string;
	readonly runtimeVersion: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly bindings: readonly WorkflowCheckpointTelemetryBinding[];
	readonly eventIds: readonly string[];
	readonly eventDigests: readonly string[];
	readonly receiptDigests: readonly string[];
	readonly authorizationDigests: readonly string[];
	readonly fenceDigests: readonly string[];
	readonly requiredStateRegistryDigest: string;
	readonly requiredStateIds: readonly string[];
	readonly missingRequiredStateIds: readonly string[];
	readonly checkpointCount: number;
	readonly serializationDurationMs: number;
	readonly restoreDurationMs: number;
	readonly bytesWritten: number;
	readonly durableBytes: number;
	readonly growthBytesPerTurn: number | null;
	readonly largestRetainedValues: readonly WorkflowCheckpointLargestRetainedValue[];
	readonly durabilityOutcome: "durable";
	readonly failureReason: null;
	readonly progressClaim: "none";
	readonly schedulerEffect: "advisory_only";
	readonly projectionDigest: string;
}

export class WorkflowCheckpointBudgetTelemetryError extends Error {
	readonly code: string;

	public constructor(code: string, message: string) {
		super(message);
		this.name = "WorkflowCheckpointBudgetTelemetryError";
		this.code = code;
	}
}

const EVENT_KEYS = [
	"schemaVersion",
	"eventId",
	"idempotencyKey",
	"kind",
	"workflowId",
	"taskId",
	"attemptId",
	"processGenerationId",
	"runtimeVersion",
	"head",
	"epochRef",
	"source",
	"authority",
	"classificationAuthority",
	"completionEvidence",
	"mockOnly",
	"publicBoundary",
	"bindingDigest",
	"resourceDigest",
	"operationDigest",
	"receiptDigest",
	"authorizationDigest",
	"fenceDigest",
	"requiredStateRegistryDigest",
	"requiredStateRegistry",
	"requiredStateIds",
	"missingRequiredStateIds",
	"checkpointTurn",
	"serializeStartedAtMonotonicMs",
	"serializeEndedAtMonotonicMs",
	"restoreStartedAtMonotonicMs",
	"restoreEndedAtMonotonicMs",
	"observedAtMonotonicMs",
	"bytesWritten",
	"durableBytes",
	"retainedValues",
	"previousObservationDigest",
	"previousCheckpointTurn",
	"previousDurableBytes",
	"durabilityOutcome",
	"failureReason",
	"observationDigest",
] as const;

const RETAINED_INPUT_KEYS = [
	"valueId",
	"type",
	"bytes",
	"classification",
	"representation",
	"digest",
	"artifactRef",
	"reasonCode",
] as const;

const RETAINED_OUTPUT_KEYS = [...RETAINED_INPUT_KEYS, "required"] as const;
const RETENTION_CLASSES: readonly WorkflowCheckpointRetentionClass[] = [
	"durable_fact",
	"artifact_ref",
	"transient_tool_output",
	"transient_dataframe",
	"transient_log_tail",
	"reproducible_cache",
];
const RETENTION_REASON_CODES: readonly WorkflowCheckpointRetentionReasonCode[] = [
	"transient",
	"not_serializable",
	"missing",
	"restore_failed",
	"reproducible",
];
const TRANSIENT_TYPE_PATTERN =
	/^(?:dataframe|data_frame|tool_output|tool-output|stdout|stderr|log_tail|log-tail|cache|reproducible_cache)$/iu;

function fail(code: string, message: string): never {
	throw new WorkflowCheckpointBudgetTelemetryError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Reflect.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) fail("invalid_record", `${label} must be a plain object.`);
	return value;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const expected = new Set(keys);
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== expected.size || ownKeys.some((key) => typeof key !== "string" || !expected.has(key)))
		fail("unknown_event_field", `${label} contains an unknown or missing field.`);
}

function assertNonEmptyString(
	value: unknown,
	label: string,
	maxBytes = MAX_CHECKPOINT_TELEMETRY_STRING_BYTES,
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) fail("invalid_metadata", `${label} must be non-empty.`);
	if (new TextEncoder().encode(value).byteLength > maxBytes) fail("metadata_bound", `${label} exceeds its bound.`);
	if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
		fail("unsafe_metadata", `${label} contains control characters.`);
}

function assertSafeIdentifier(value: unknown, label: string): asserts value is string {
	assertNonEmptyString(value, label);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail("unsafe_metadata", `${label} is not a safe identifier.`);
}

function assertSafePath(value: unknown, label: string): asserts value is string {
	assertNonEmptyString(value, label, MAX_CHECKPOINT_TELEMETRY_PATH_BYTES);
	if (
		value.startsWith("/") ||
		value.includes("\\") ||
		/^[A-Za-z]:/u.test(value) ||
		value.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
		value.split("/").some((part) => !/^[A-Za-z0-9._:-]+$/u.test(part))
	)
		fail("unsafe_path", `${label} is not a safe relative path.`);
}

function assertDigest(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
		fail("invalid_digest", `${label} is not a SHA-256 digest.`);
}

function assertNullableDigest(value: unknown, label: string): asserts value is string | null {
	if (value !== null) assertDigest(value, label);
}

function assertSafeNonNegativeInteger(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) fail("invalid_metric", `${label} must be non-negative.`);
}

function assertEpochRef(value: unknown, label: string): asserts value is WorkflowEpochRef {
	const candidate = record(value, label);
	assertExactKeys(candidate, ["storeEpoch", "coordinatorEpoch"], label);
	if (!Number.isSafeInteger(candidate.storeEpoch) || (candidate.storeEpoch as number) < 1)
		fail("invalid_epoch", `${label}.storeEpoch is invalid.`);
	if (!Number.isSafeInteger(candidate.coordinatorEpoch) || (candidate.coordinatorEpoch as number) < 1)
		fail("invalid_epoch", `${label}.coordinatorEpoch is invalid.`);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function sameHead(left: WorkflowJournalHead, right: WorkflowJournalHead): boolean {
	return (
		left.workflowId === right.workflowId &&
		left.sequence === right.sequence &&
		left.eventDigest === right.eventDigest &&
		sameEpoch(left.epochRef, right.epochRef)
	);
}

function assertHead(
	value: unknown,
	workflowId: string,
	epochRef: WorkflowEpochRef,
): asserts value is WorkflowJournalHead {
	const candidate = record(value, "head");
	assertExactKeys(candidate, ["workflowId", "sequence", "eventDigest", "epochRef"], "head");
	assertSafeIdentifier(candidate.workflowId, "head.workflowId");
	if (candidate.workflowId !== workflowId) fail("conflicting_binding", "head.workflowId is foreign.");
	assertSafeNonNegativeInteger(candidate.sequence, "head.sequence");
	if (candidate.eventDigest !== null) assertDigest(candidate.eventDigest, "head.eventDigest");
	assertEpochRef(candidate.epochRef, "head.epochRef");
	if (!sameEpoch(candidate.epochRef, epochRef)) fail("conflicting_binding", "head epoch is foreign.");
}

function assertArtifactRef(value: unknown, label: string): asserts value is WorkflowArtifactRef {
	const candidate = record(value, label);
	assertExactKeys(candidate, ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"], label);
	assertSafeIdentifier(candidate.artifactId, `${label}.artifactId`);
	assertSafePath(candidate.relativePath, `${label}.relativePath`);
	assertDigest(candidate.digest, `${label}.digest`);
	assertSafeNonNegativeInteger(candidate.sizeBytes, `${label}.sizeBytes`);
	assertSafeNonNegativeInteger(candidate.sourceEventSequence, `${label}.sourceEventSequence`);
	if (candidate.sizeBytes > MAX_CHECKPOINT_TELEMETRY_BYTES) fail("metric_bound", `${label}.sizeBytes is too large.`);
}

function assertInterval(start: unknown, end: unknown, label: string): number {
	assertSafeNonNegativeInteger(start, `${label}.start`);
	assertSafeNonNegativeInteger(end, `${label}.end`);
	if ((end as number) < (start as number)) fail("invalid_timestamp", `${label} ends before it starts.`);
	return (end as number) - (start as number);
}

function assertNullableInterval(start: unknown, end: unknown, label: string): number {
	if (start === null || end === null) {
		if (start !== null || end !== null) fail("invalid_timestamp", `${label} must provide both bounds or neither.`);
		return 0;
	}
	return assertInterval(start, end, label);
}

function assertDenseArray(value: unknown, label: string, maxLength: number): asserts value is readonly unknown[] {
	if (!Array.isArray(value)) fail("invalid_array", `${label} must be an array.`);
	if (value.length > maxLength) fail("metric_bound", `${label} exceeds its bound.`);
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || !keys.includes("length")) fail("sparse_array", `${label} must be dense.`);
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.hasOwn(value, String(index))) fail("sparse_array", `${label} must be dense.`);
	}
}

function compareStableStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function assertSortedUniqueIds(value: readonly string[], label: string): void {
	for (let index = 0; index < value.length; index += 1) assertSafeIdentifier(value[index], `${label}[${index}]`);
	for (let index = 1; index < value.length; index += 1) {
		if (compareStableStrings(value[index - 1]!, value[index]!) >= 0)
			fail("noncanonical_order", `${label} must be sorted and unique.`);
	}
}

function assertPublicBoundary(value: unknown): asserts value is string {
	assertNonEmptyString(value, "publicBoundary", MAX_CHECKPOINT_TELEMETRY_PUBLIC_BOUNDARY_BYTES);
	if (
		value.startsWith("private/") ||
		value.includes("_for_test") ||
		value.includes("mock") ||
		value.includes("..") ||
		!value.startsWith("public/")
	)
		fail("unsafe_boundary", "checkpoint telemetry must use a public host boundary.");
}

function isRetentionClass(value: unknown): value is WorkflowCheckpointRetentionClass {
	return typeof value === "string" && RETENTION_CLASSES.includes(value as WorkflowCheckpointRetentionClass);
}

function isReasonCode(value: unknown): value is WorkflowCheckpointRetentionReasonCode {
	return typeof value === "string" && RETENTION_REASON_CODES.includes(value as WorkflowCheckpointRetentionReasonCode);
}

function assertRetainedInput(value: unknown, label: string): WorkflowCheckpointRetainedValueInput {
	const candidate = record(value, label);
	assertExactKeys(candidate, RETAINED_INPUT_KEYS, label);
	assertSafeIdentifier(candidate.valueId, `${label}.valueId`);
	assertSafeIdentifier(candidate.type, `${label}.type`);
	assertSafeNonNegativeInteger(candidate.bytes, `${label}.bytes`);
	if (candidate.bytes > MAX_CHECKPOINT_TELEMETRY_BYTES) fail("metric_bound", `${label}.bytes is too large.`);
	if (!isRetentionClass(candidate.classification))
		fail("invalid_classification", `${label}.classification is not closed.`);
	if (!(["durable", "transient", "unavailable"] as const).includes(candidate.representation as never))
		fail("invalid_classification", `${label}.representation is not closed.`);
	if (candidate.reasonCode !== null && !isReasonCode(candidate.reasonCode))
		fail("invalid_classification", `${label}.reasonCode is not closed.`);
	const durableClass = candidate.classification === "durable_fact" || candidate.classification === "artifact_ref";
	if (!durableClass && candidate.representation === "durable") fail("transient_not_durable", `${label} is transient.`);
	if (candidate.representation === "durable") {
		if (TRANSIENT_TYPE_PATTERN.test(candidate.type)) fail("transient_not_durable", `${label} has a transient type.`);
		if (candidate.reasonCode !== null)
			fail("invalid_classification", `${label}.reasonCode must be null when durable.`);
		assertDigest(candidate.digest, `${label}.digest`);
		if (candidate.classification === "artifact_ref") {
			assertArtifactRef(candidate.artifactRef, `${label}.artifactRef`);
			if (candidate.digest !== candidate.artifactRef.digest || candidate.bytes !== candidate.artifactRef.sizeBytes)
				fail("conflicting_artifact", `${label} is not bound to its artifact reference.`);
		} else if (candidate.artifactRef !== null) {
			fail("invalid_classification", `${label}.artifactRef must be null for a durable fact.`);
		}
	} else {
		if (candidate.digest !== null || candidate.artifactRef !== null || candidate.reasonCode === null)
			fail("invalid_classification", `${label} lacks a transient reason or carries durable evidence.`);
	}
	return candidate as unknown as WorkflowCheckpointRetainedValueInput;
}

function assertRequiredDefinition(value: unknown, label: string): WorkflowCheckpointRequiredStateDefinition {
	const candidate = record(value, label);
	assertExactKeys(candidate, ["valueId", "type", "classification"], label);
	assertSafeIdentifier(candidate.valueId, `${label}.valueId`);
	assertSafeIdentifier(candidate.type, `${label}.type`);
	if (candidate.classification !== "durable_fact" && candidate.classification !== "artifact_ref")
		fail("invalid_required_registry", `${label}.classification must be durable.`);
	return candidate as unknown as WorkflowCheckpointRequiredStateDefinition;
}

function normalizeRequiredState(
	values: readonly WorkflowCheckpointRequiredStateDefinition[],
): readonly WorkflowCheckpointRequiredStateDefinition[] {
	assertDenseArray(values, "requiredStateRegistry", MAX_CHECKPOINT_RETAINED_VALUES);
	const definitions = values.map((value, index) => assertRequiredDefinition(value, `requiredStateRegistry[${index}]`));
	const sorted = [...definitions].sort((left, right) => compareStableStrings(left.valueId, right.valueId));
	assertSortedUniqueIds(
		sorted.map((definition) => definition.valueId),
		"requiredStateRegistry IDs",
	);
	return sorted;
}

function durableBytes(values: readonly WorkflowCheckpointRetainedValueInput[]): number {
	return values.reduce((total, value) => {
		if (value.representation !== "durable") return total;
		const next = total + value.bytes;
		if (!Number.isSafeInteger(next) || next > MAX_CHECKPOINT_TELEMETRY_BYTES)
			fail("metric_bound", "durable retained bytes exceed the checkpoint limit.");
		return next;
	}, 0);
}

function deriveRetention(
	values: readonly WorkflowCheckpointRetainedValueInput[],
	definitions: readonly WorkflowCheckpointRequiredStateDefinition[],
): { readonly retainedValues: readonly WorkflowCheckpointRetainedValue[]; readonly durableBytes: number } {
	const byId = new Map(definitions.map((definition) => [definition.valueId, definition]));
	const seen = new Set<string>();
	const retainedValues = values
		.map((value) => {
			if (seen.has(value.valueId)) fail("duplicate_value_id", "retained value IDs must be unique.");
			seen.add(value.valueId);
			const definition = byId.get(value.valueId);
			if (definition !== undefined) {
				if (
					value.classification !== definition.classification ||
					value.type !== definition.type ||
					value.representation !== "durable"
				)
					fail("required_state_not_durable", `${value.valueId} is not represented by durable host state.`);
			}
			return { ...value, required: definition !== undefined };
		})
		.sort((left, right) => compareStableStrings(left.valueId, right.valueId));
	for (const definition of definitions) {
		if (!seen.has(definition.valueId))
			fail("required_state_closure", `required state ${definition.valueId} is absent from the checkpoint.`);
	}
	return { retainedValues, durableBytes: durableBytes(values) };
}

function freezeDeep<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const key of Reflect.ownKeys(value)) {
		const child = Object.getOwnPropertyDescriptor(value, key)?.value;
		if (child !== undefined) freezeDeep(child);
	}
	return Object.freeze(value) as T;
}

function withoutObservationDigest(value: WorkflowCheckpointBudgetTelemetryEvent): Record<string, unknown> {
	const { observationDigest: _observationDigest, ...preimage } = value;
	return preimage;
}

function assertEvent(value: unknown, requireDigest: boolean): WorkflowCheckpointBudgetTelemetryEvent {
	const candidate = record(value, "checkpoint telemetry event");
	assertExactKeys(candidate, EVENT_KEYS, "checkpoint telemetry event");
	if (candidate.schemaVersion !== 1 || candidate.kind !== "checkpoint_budget_observed")
		fail("event_kind", "checkpoint telemetry event kind is unsupported.");
	assertSafeIdentifier(candidate.eventId, "eventId");
	assertSafeIdentifier(candidate.idempotencyKey, "idempotencyKey");
	assertSafeIdentifier(candidate.workflowId, "workflowId");
	assertSafeIdentifier(candidate.taskId, "taskId");
	assertSafeIdentifier(candidate.attemptId, "attemptId");
	assertSafeIdentifier(candidate.processGenerationId, "processGenerationId");
	assertNonEmptyString(candidate.runtimeVersion, "runtimeVersion");
	assertWorkflowRuntimeVersion(candidate.runtimeVersion);
	const epochRef = candidate.epochRef as WorkflowEpochRef;
	assertEpochRef(epochRef, "epochRef");
	assertHead(candidate.head, candidate.workflowId, epochRef);
	if (
		candidate.source !== "host" ||
		candidate.authority !== "host_committed" ||
		candidate.classificationAuthority !== "host" ||
		candidate.completionEvidence !== "none" ||
		candidate.mockOnly !== false
	)
		fail("worker_self_report", "checkpoint telemetry is host-only.");
	assertPublicBoundary(candidate.publicBoundary);
	for (const key of [
		"bindingDigest",
		"resourceDigest",
		"operationDigest",
		"receiptDigest",
		"authorizationDigest",
		"fenceDigest",
		"requiredStateRegistryDigest",
	] as const)
		assertDigest(candidate[key], key);
	assertDenseArray(candidate.requiredStateRegistry, "requiredStateRegistry", MAX_CHECKPOINT_RETAINED_VALUES);
	const definitions = normalizeRequiredState(
		candidate.requiredStateRegistry.map((value, index) =>
			assertRequiredDefinition(value, `requiredStateRegistry[${index}]`),
		),
	);
	if (candidate.requiredStateRegistryDigest !== digestObject(definitions))
		fail("required_state_registry_digest", "required-state registry digest does not match its canonical values.");
	const requiredStateIds = [...definitions.map((definition) => definition.valueId)];
	assertDenseArray(candidate.requiredStateIds, "requiredStateIds", MAX_CHECKPOINT_RETAINED_VALUES);
	assertDenseArray(candidate.missingRequiredStateIds, "missingRequiredStateIds", MAX_CHECKPOINT_RETAINED_VALUES);
	assertSortedUniqueIds(candidate.requiredStateIds as readonly string[], "requiredStateIds");
	assertSortedUniqueIds(candidate.missingRequiredStateIds as readonly string[], "missingRequiredStateIds");
	if (digestObject(requiredStateIds) !== digestObject(candidate.requiredStateIds))
		fail("required_state_registry", "requiredStateIds do not match the host registry.");
	if ((candidate.missingRequiredStateIds as readonly string[]).length !== 0)
		fail("required_state_closure", "a committed checkpoint cannot omit required state.");
	assertSafeNonNegativeInteger(candidate.checkpointTurn, "checkpointTurn");
	assertInterval(
		candidate.serializeStartedAtMonotonicMs,
		candidate.serializeEndedAtMonotonicMs,
		"checkpoint serialization",
	);
	assertNullableInterval(
		candidate.restoreStartedAtMonotonicMs,
		candidate.restoreEndedAtMonotonicMs,
		"checkpoint restore",
	);
	const restoreEnd = candidate.restoreEndedAtMonotonicMs as number | null;
	if (candidate.observedAtMonotonicMs !== Math.max(candidate.serializeEndedAtMonotonicMs as number, restoreEnd ?? 0))
		fail("invalid_timestamp", "observedAtMonotonicMs is not the final checkpoint boundary.");
	assertSafeNonNegativeInteger(candidate.observedAtMonotonicMs, "observedAtMonotonicMs");
	assertSafeNonNegativeInteger(candidate.bytesWritten, "bytesWritten");
	if (candidate.bytesWritten > MAX_CHECKPOINT_TELEMETRY_BYTES) fail("metric_bound", "bytesWritten is too large.");
	assertDenseArray(candidate.retainedValues, "retainedValues", MAX_CHECKPOINT_RETAINED_VALUES);
	const retainedValues = candidate.retainedValues.map((value, index) => {
		const retained = record(value, `retainedValues[${index}]`);
		assertExactKeys(retained, RETAINED_OUTPUT_KEYS, `retainedValues[${index}]`);
		const input = assertRetainedInput(
			Object.fromEntries(RETAINED_INPUT_KEYS.map((key) => [key, retained[key]])),
			`retainedValues[${index}]`,
		);
		if (typeof retained.required !== "boolean") fail("required_state_registry", "required flags must be booleans.");
		return { ...input, required: retained.required };
	});
	const derived = deriveRetention(retainedValues, definitions);
	if (candidate.durableBytes !== derived.durableBytes) fail("metric_mismatch", "durableBytes is not host-derived.");
	if (candidate.bytesWritten < derived.durableBytes) fail("metric_inflated", "bytesWritten is below durable bytes.");
	if (candidate.durabilityOutcome !== "durable" || candidate.failureReason !== null)
		fail("metric_mismatch", "checkpoint durability outcome is not closed.");
	assertNullableDigest(candidate.previousObservationDigest, "previousObservationDigest");
	if (candidate.previousCheckpointTurn === null || candidate.previousDurableBytes === null) {
		if (candidate.previousCheckpointTurn !== null || candidate.previousDurableBytes !== null)
			fail("invalid_chain", "previous checkpoint fields must be supplied together.");
	} else {
		assertSafeNonNegativeInteger(candidate.previousCheckpointTurn, "previousCheckpointTurn");
		assertSafeNonNegativeInteger(candidate.previousDurableBytes, "previousDurableBytes");
		if (candidate.previousObservationDigest === null)
			fail("invalid_chain", "previous checkpoint digest is required.");
	}
	assertDigest(candidate.observationDigest, "observationDigest");
	if (
		requireDigest &&
		candidate.observationDigest !==
			digestObject(withoutObservationDigest(candidate as unknown as WorkflowCheckpointBudgetTelemetryEvent))
	)
		fail("observation_digest_mismatch", "checkpoint observation digest does not match immutable facts.");
	return freezeDeep(candidate as unknown as WorkflowCheckpointBudgetTelemetryEvent);
}

function previousCheckpoint(
	events: readonly { readonly payload: unknown }[],
	workflowId: string,
	taskId: string,
	attemptId: string,
	excludedIdempotencyKey: string | null = null,
): WorkflowCheckpointBudgetTelemetryEvent | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const payload = events[index]?.payload;
		if (!isRecord(payload) || payload.kind !== "checkpoint_budget_observed") continue;
		if (payload.workflowId !== workflowId || payload.taskId !== taskId || payload.attemptId !== attemptId) continue;
		if (payload.idempotencyKey === excludedIdempotencyKey) continue;
		return assertEvent(payload, true);
	}
	return null;
}

async function commitCheckpoint(
	host: WorkflowCheckpointBudgetTelemetryHost,
	payload: WorkflowCheckpointBudgetTelemetryEvent,
	state: WorkflowCheckpointBudgetTelemetryHostState,
): Promise<WorkflowStoreCommitResult<WorkflowCheckpointBudgetTelemetryEvent>> {
	const replay = await host.runtimeStore.replay({
		workflowId: payload.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: state.epochRef.storeEpoch,
	});
	if (replay.quarantined)
		fail("runtime_store_quarantined", "checkpoint telemetry runtime store replay is quarantined.");
	if (!sameHead(replay.head, payload.head)) fail("stale_head", "checkpoint telemetry head advanced before append.");
	const baselineDigest = digestObject(replay.head);
	return host.runtimeStore.commit({
		workflowId: payload.workflowId,
		payload,
		expectedHead: replay.head,
		epochRef: state.epochRef,
		leaseRef: state.leaseRef,
		idempotencyKey: payload.idempotencyKey,
		writerIdentity: state.leaseRef.writerIdentity,
		executionKey: null,
		semanticBinding: {
			mutationId: payload.idempotencyKey,
			baselineDigest,
			expectedGenerations: { workflow: state.epochRef.storeEpoch },
			ownerId: state.leaseRef.writerIdentity,
			phase: "recovering",
			reducerDigest: digestObject(payload),
			semanticHead: {
				workflowId: payload.workflowId,
				sequence: replay.head.sequence,
				eventDigest: replay.head.eventDigest,
				stateDigest: state.stateDigest,
				epochRef: state.epochRef,
				generation: state.epochRef.storeEpoch,
			},
			expectedHead: replay.head,
			idempotencyKey: payload.idempotencyKey,
			executionKey: null,
			writerIdentity: state.leaseRef.writerIdentity,
			leaseRef: state.leaseRef,
			epochRef: state.epochRef,
		},
	});
}

function assertReceiptBinding(
	receipt: WorkflowVerifiedHostReceipt,
	input: {
		readonly workflowId: string;
		readonly bindingDigest: string;
		readonly resourceDigest: string;
		readonly operationDigest: string;
		readonly stateDigest: string;
		readonly revision: number;
		readonly executionIdentity?: string;
		readonly sessionId?: string;
	},
): void {
	if (
		receipt.receiptKind !== "capability" ||
		receipt.workflowId !== input.workflowId ||
		receipt.bindingDigest !== input.bindingDigest ||
		receipt.stateDigest !== input.stateDigest ||
		receipt.revision !== input.revision
	)
		fail("receipt_binding", "host receipt is not bound to the checkpoint tuple.");
	assertDigest(receipt.verificationDigest, "receipt.verificationDigest");
	if (
		receipt.capabilityBinding === undefined ||
		receipt.capabilityBinding.capability !== "workflow_checkpoint_budget_observation" ||
		receipt.capabilityBinding.resourceDigest !== input.resourceDigest ||
		receipt.capabilityBinding.operationDigest !== input.operationDigest ||
		receipt.capabilityBinding.executionIdentity !== (input.executionIdentity ?? null) ||
		receipt.capabilityBinding.sessionId !== (input.sessionId ?? null)
	)
		fail("receipt_binding", "host receipt capability binding is not exact.");
}

function assertAuthorization(
	authorization: WorkflowHostPrincipalCapabilityAuthorization,
	receipt: WorkflowVerifiedHostReceipt,
	input: {
		readonly workflowId: string;
		readonly bindingDigest: string;
		readonly stateDigest: string;
		readonly revision: number;
		readonly epochRef: WorkflowEpochRef;
		readonly executionIdentity?: string;
		readonly sessionId?: string;
	},
): void {
	if (
		authorization.capability !== "workflow_checkpoint_budget_observation" ||
		authorization.workflowId !== input.workflowId ||
		authorization.bindingDigest !== input.bindingDigest ||
		authorization.receipt.receiptId !== receipt.receiptId ||
		authorization.stateDigest !== input.stateDigest ||
		authorization.revision !== input.revision ||
		!sameEpoch(authorization.epochRef, input.epochRef) ||
		authorization.executionIdentity !== input.executionIdentity ||
		authorization.sessionId !== input.sessionId
	)
		fail("principal_authorization", "typed host principal authorization is not exact.");
	assertDigest(authorization.authorizationDigest, "authorization.authorizationDigest");
}

function observationResourceFacts(
	host: WorkflowCheckpointBudgetTelemetryHost,
	state: WorkflowCheckpointBudgetTelemetryHostState,
	head: WorkflowJournalHead,
	definitions: readonly WorkflowCheckpointRequiredStateDefinition[],
	input: WorkflowCheckpointBudgetTelemetryObservationInput,
	previous: WorkflowCheckpointBudgetTelemetryEvent | null,
): Record<string, unknown> {
	return {
		binding: {
			workflowId: host.binding.workflowId,
			taskId: host.binding.taskId,
			attemptId: host.binding.attemptId,
			runtimeVersion: host.binding.runtimeVersion,
		},
		head,
		epochRef: state.epochRef,
		stateDigest: state.stateDigest,
		revision: state.revision,
		requiredStateRegistry: definitions,
		checkpointTurn: input.checkpointTurn,
		serializeStartedAtMonotonicMs: input.serializeStartedAtMonotonicMs,
		serializeEndedAtMonotonicMs: input.serializeEndedAtMonotonicMs,
		restoreStartedAtMonotonicMs: input.restoreStartedAtMonotonicMs,
		restoreEndedAtMonotonicMs: input.restoreEndedAtMonotonicMs,
		bytesWritten: input.bytesWritten,
		retainedValues: input.retainedValues,
		previousObservationDigest: previous?.observationDigest ?? null,
		previousCheckpointTurn: previous?.checkpointTurn ?? null,
		previousDurableBytes: previous?.durableBytes ?? null,
	};
}

function assertIdempotentInput(
	event: WorkflowCheckpointBudgetTelemetryEvent,
	input: WorkflowCheckpointBudgetTelemetryObservationInput,
	retainedValues: readonly WorkflowCheckpointRetainedValueInput[],
	definitions: readonly WorkflowCheckpointRequiredStateDefinition[],
): void {
	const expectedRetainedValues = [...retainedValues].sort((left, right) =>
		compareStableStrings(left.valueId, right.valueId),
	);
	const committedRetainedValues = event.retainedValues
		.map(({ required: _required, ...value }) => value)
		.sort((left, right) => compareStableStrings(left.valueId, right.valueId));
	if (
		event.checkpointTurn !== input.checkpointTurn ||
		event.serializeStartedAtMonotonicMs !== input.serializeStartedAtMonotonicMs ||
		event.serializeEndedAtMonotonicMs !== input.serializeEndedAtMonotonicMs ||
		event.restoreStartedAtMonotonicMs !== input.restoreStartedAtMonotonicMs ||
		event.restoreEndedAtMonotonicMs !== input.restoreEndedAtMonotonicMs ||
		event.bytesWritten !== input.bytesWritten ||
		digestObject(committedRetainedValues) !== digestObject(expectedRetainedValues) ||
		event.requiredStateRegistryDigest !== digestObject(definitions)
	)
		fail("idempotency_conflict", "checkpoint idempotency key has different facts.");
}

/**
 * Records one checkpoint observation through host principal authorization and the canonical runtime store.
 *
 * Args:
 * input: Serialization, restore, bytes, and retained metadata from the public checkpoint boundary.
 * host: Host-owned required-state registry, receipt issuer, principal authorizer, and runtime store.
 * Return: The authenticated immutable payload committed to the canonical journal.
 */
export async function recordWorkflowCheckpointBudgetTelemetry(
	input: WorkflowCheckpointBudgetTelemetryObservationInput,
	host: WorkflowCheckpointBudgetTelemetryHost,
): Promise<WorkflowCheckpointBudgetTelemetryEvent> {
	const raw = record(input, "checkpoint telemetry input");
	assertExactKeys(
		raw,
		[
			"schemaVersion",
			"checkpointTurn",
			"serializeStartedAtMonotonicMs",
			"serializeEndedAtMonotonicMs",
			"restoreStartedAtMonotonicMs",
			"restoreEndedAtMonotonicMs",
			"bytesWritten",
			"retainedValues",
		],
		"checkpoint telemetry input",
	);
	if (raw.schemaVersion !== 1) fail("schema_version", "checkpoint telemetry schema version is unsupported.");
	assertSafeIdentifier(host.binding.workflowId, "host.binding.workflowId");
	assertSafeIdentifier(host.binding.taskId, "host.binding.taskId");
	assertSafeIdentifier(host.binding.attemptId, "host.binding.attemptId");
	assertSafeIdentifier(host.binding.processGenerationId, "host.binding.processGenerationId");
	assertNonEmptyString(host.binding.runtimeVersion, "host.binding.runtimeVersion");
	assertWorkflowRuntimeVersion(host.binding.runtimeVersion);
	assertPublicBoundary(host.publicBoundary);
	assertSafeNonNegativeInteger(input.checkpointTurn, "checkpointTurn");
	assertInterval(input.serializeStartedAtMonotonicMs, input.serializeEndedAtMonotonicMs, "checkpoint serialization");
	assertNullableInterval(input.restoreStartedAtMonotonicMs, input.restoreEndedAtMonotonicMs, "checkpoint restore");
	assertSafeNonNegativeInteger(input.bytesWritten, "bytesWritten");
	if (input.bytesWritten > MAX_CHECKPOINT_TELEMETRY_BYTES) fail("metric_bound", "bytesWritten is too large.");
	assertDenseArray(input.retainedValues, "retainedValues", MAX_CHECKPOINT_RETAINED_VALUES);
	const retainedInputs = input.retainedValues.map((value, index) =>
		assertRetainedInput(value, `retainedValues[${index}]`),
	);
	const definitions = normalizeRequiredState(host.requiredStateRegistry);
	const state = await host.resolveState();
	assertEpochRef(state.epochRef, "host state epochRef");
	assertDigest(state.stateDigest, "host state stateDigest");
	assertSafeNonNegativeInteger(state.revision, "host state revision");
	if (state.leaseRef.writerIdentity.length === 0) fail("host_state", "host state writer identity is empty.");
	if (!sameEpoch(state.leaseRef, state.epochRef)) fail("host_state", "host lease epoch is stale.");
	const replay = await host.runtimeStore.replay({
		workflowId: host.binding.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: state.epochRef.storeEpoch,
	});
	if (replay.quarantined)
		fail("runtime_store_quarantined", "checkpoint telemetry runtime store replay is quarantined.");
	if (
		replay.head.workflowId !== host.binding.workflowId ||
		replay.head.eventDigest === null ||
		replay.head.sequence !== state.revision ||
		replay.head.eventDigest !== state.stateDigest ||
		!sameEpoch(replay.head.epochRef, state.epochRef)
	)
		fail("host_state", "host state is not bound to the authenticated runtime head.");
	const idempotencyKey = `checkpoint-budget:${host.binding.workflowId}:${host.binding.taskId}:${host.binding.attemptId}:${input.checkpointTurn}`;
	let existing: WorkflowCheckpointBudgetObservationPayload | undefined;
	for (const event of replay.events) {
		const candidate = event.payload as unknown as Record<string, unknown>;
		if (
			isRecord(candidate) &&
			candidate.kind === "checkpoint_budget_observed" &&
			candidate.idempotencyKey === idempotencyKey
		) {
			existing = candidate as unknown as WorkflowCheckpointBudgetObservationPayload;
			break;
		}
	}
	if (existing !== undefined) {
		const committed = assertEvent(existing, true);
		assertIdempotentInput(committed, input, retainedInputs, definitions);
		return committed;
	}
	const previous = previousCheckpoint(
		replay.events,
		host.binding.workflowId,
		host.binding.taskId,
		host.binding.attemptId,
		idempotencyKey,
	);
	const derived = deriveRetention(retainedInputs, definitions);
	if (input.bytesWritten < derived.durableBytes) fail("metric_inflated", "bytesWritten is below durable bytes.");
	if (previous !== null && input.checkpointTurn < previous.checkpointTurn)
		fail("invalid_chain", "checkpoint turns must advance beyond the journaled checkpoint.");
	const resourceFacts = observationResourceFacts(host, state, replay.head, definitions, input, previous);
	const resourceDigest = digestObject(resourceFacts);
	if (previous !== null && input.checkpointTurn === previous.checkpointTurn)
		fail("invalid_chain", "checkpoint turns must advance beyond the journaled checkpoint.");
	const operationDigest = digestObject({
		capability: "workflow_checkpoint_budget_observation",
		workflowId: host.binding.workflowId,
		idempotencyKey,
		resourceDigest,
	});
	const bindingDigest = digestObject({
		binding: host.binding,
		head: replay.head,
		epochRef: state.epochRef,
		stateDigest: state.stateDigest,
		revision: state.revision,
		leaseRef: state.leaseRef,
		resourceDigest,
		operationDigest,
	});
	const receipt = await host.issueReceipt({
		receiptKind: "capability",
		workflowId: host.binding.workflowId,
		bindingDigest,
		capability: "workflow_checkpoint_budget_observation",
		resourceDigest,
		operationDigest,
		executionIdentity: state.executionIdentity,
		sessionId: state.sessionId,
		stateDigest: state.stateDigest,
		revision: state.revision,
	});
	assertReceiptBinding(receipt, {
		workflowId: host.binding.workflowId,
		bindingDigest,
		resourceDigest,
		operationDigest,
		stateDigest: state.stateDigest,
		revision: state.revision,
		executionIdentity: state.executionIdentity,
		sessionId: state.sessionId,
	});
	let authorization: WorkflowHostPrincipalCapabilityAuthorization;
	try {
		authorization = await host.principalAuthorizer.authorize({
			receipt,
			workflowId: host.binding.workflowId,
			bindingDigest,
			resourceDigest,
			operationDigest,
			stateDigest: state.stateDigest,
			revision: state.revision,
			epochRef: state.epochRef,
			capability: "workflow_checkpoint_budget_observation",
			executionIdentity: state.executionIdentity,
			sessionId: state.sessionId,
		});
	} catch {
		fail("principal_authorization", "typed host principal authorization rejected checkpoint telemetry.");
	}
	assertAuthorization(authorization, receipt, {
		workflowId: host.binding.workflowId,
		bindingDigest,
		stateDigest: state.stateDigest,
		revision: state.revision,
		epochRef: state.epochRef,
		executionIdentity: state.executionIdentity,
		sessionId: state.sessionId,
	});
	const restoreEnd = input.restoreEndedAtMonotonicMs;
	const preimage = {
		schemaVersion: 1 as const,
		eventId: `checkpoint-observation:${digestObject({ idempotencyKey, resourceDigest })}`,
		idempotencyKey,
		kind: "checkpoint_budget_observed" as const,
		workflowId: host.binding.workflowId,
		taskId: host.binding.taskId,
		attemptId: host.binding.attemptId,
		processGenerationId: host.binding.processGenerationId,
		runtimeVersion: host.binding.runtimeVersion,
		head: structuredClone(replay.head),
		epochRef: structuredClone(state.epochRef),
		source: "host" as const,
		authority: "host_committed" as const,
		classificationAuthority: "host" as const,
		completionEvidence: "none" as const,
		mockOnly: false as const,
		publicBoundary: host.publicBoundary,
		bindingDigest,
		resourceDigest,
		operationDigest,
		receiptDigest: receipt.verificationDigest,
		authorizationDigest: authorization.authorizationDigest,
		fenceDigest: digestObject({ head: replay.head, epochRef: state.epochRef, leaseRef: state.leaseRef }),
		requiredStateRegistryDigest: digestObject(definitions),
		requiredStateRegistry: structuredClone(definitions) as readonly WorkflowCheckpointBudgetRequiredStatePayload[],
		requiredStateIds: definitions.map((definition) => definition.valueId),
		missingRequiredStateIds: [] as const,
		checkpointTurn: input.checkpointTurn,
		serializeStartedAtMonotonicMs: input.serializeStartedAtMonotonicMs,
		serializeEndedAtMonotonicMs: input.serializeEndedAtMonotonicMs,
		restoreStartedAtMonotonicMs: input.restoreStartedAtMonotonicMs,
		restoreEndedAtMonotonicMs: input.restoreEndedAtMonotonicMs,
		observedAtMonotonicMs: Math.max(input.serializeEndedAtMonotonicMs, restoreEnd ?? 0),
		bytesWritten: input.bytesWritten,
		durableBytes: derived.durableBytes,
		retainedValues: derived.retainedValues,
		previousObservationDigest: previous?.observationDigest ?? null,
		previousCheckpointTurn: previous?.checkpointTurn ?? null,
		previousDurableBytes: previous?.durableBytes ?? null,
		durabilityOutcome: "durable" as const,
		failureReason: null,
	};
	const payload = freezeDeep({
		...preimage,
		observationDigest: digestObject(preimage),
	} as WorkflowCheckpointBudgetTelemetryEvent);
	const result = await commitCheckpoint(host, payload, state);
	if (result.payload.observationDigest !== payload.observationDigest)
		fail("idempotency_conflict", "runtime store returned a different checkpoint payload for the idempotency key.");
	return assertEvent(result.payload, true);
}

/**
 * Creates a host contract bound to one runtime store and principal authorizer.
 *
 * Args:
 * host: Host-owned checkpoint authority and canonical store.
 * Return: Public checkpoint recording contract.
 */
export function createWorkflowCheckpointBudgetTelemetryHostContract(
	host: WorkflowCheckpointBudgetTelemetryHost,
): WorkflowCheckpointBudgetTelemetryHostContract {
	return {
		recordCheckpoint: (input) => recordWorkflowCheckpointBudgetTelemetry(input, host),
	};
}

function addCumulative(left: number, right: number, label: string, maximum: number): number {
	const next = left + right;
	if (!Number.isSafeInteger(next) || next > maximum)
		fail("projection_bound", `${label} exceeds its cumulative bound.`);
	return next;
}

function compareEvents(
	left: WorkflowCheckpointBudgetTelemetryEvent,
	right: WorkflowCheckpointBudgetTelemetryEvent,
): number {
	const turnDifference = left.checkpointTurn - right.checkpointTurn;
	if (turnDifference !== 0) return turnDifference;
	const timestampDifference = left.observedAtMonotonicMs - right.observedAtMonotonicMs;
	return timestampDifference !== 0 ? timestampDifference : compareStableStrings(left.eventId, right.eventId);
}

function growthBytesPerTurn(event: WorkflowCheckpointBudgetTelemetryEvent): number | null {
	if (event.previousCheckpointTurn === null || event.previousDurableBytes === null) return null;
	const turnDelta = event.checkpointTurn - event.previousCheckpointTurn;
	if (turnDelta <= 0) fail("invalid_chain", "checkpoint turns must advance for growth projection.");
	const result = (event.durableBytes - event.previousDurableBytes) / turnDelta;
	if (!Number.isFinite(result)) fail("metric_overflow", "checkpoint growth per turn is not finite.");
	return result;
}

/**
 * Projects journaled host checkpoint observations into bounded advisory metrics.
 *
 * Args:
 * events: Authenticated checkpoint payloads replayed from the canonical workflow journal.
 * Return: Deterministic projection with cumulative duration, bytes, growth, and largest retained values.
 */
export function projectWorkflowCheckpointBudgetTelemetry(
	events: readonly WorkflowCheckpointBudgetTelemetryEvent[],
): WorkflowCheckpointBudgetTelemetryProjection {
	if (events.length === 0) fail("empty_projection", "checkpoint telemetry projection requires events.");
	assertDenseArray(events, "events", MAX_CHECKPOINT_TELEMETRY_EVENTS);
	const deduplicated = new Map<string, WorkflowCheckpointBudgetTelemetryEvent>();
	for (const event of events) {
		const validated = assertEvent(event, true);
		const prior = deduplicated.get(validated.idempotencyKey);
		if (prior !== undefined) {
			if (prior.observationDigest !== validated.observationDigest)
				fail("duplicate_event_id", "idempotency key conflicts with checkpoint facts.");
			continue;
		}
		deduplicated.set(validated.idempotencyKey, validated);
	}
	const ordered = [...deduplicated.values()].sort(compareEvents);
	const first = ordered[0]!;
	let previous: WorkflowCheckpointBudgetTelemetryEvent | null = null;
	for (const event of ordered) {
		if (
			event.workflowId !== first.workflowId ||
			event.taskId !== first.taskId ||
			event.attemptId !== first.attemptId ||
			event.runtimeVersion !== first.runtimeVersion ||
			!sameEpoch(event.epochRef, first.epochRef)
		)
			fail("conflicting_binding", "checkpoint projection mixes workflow bindings.");
		if (previous === null) {
			if (event.previousObservationDigest !== null) fail("invalid_chain", "first checkpoint has a prior digest.");
		} else {
			if (event.previousObservationDigest !== previous.observationDigest)
				fail("chain_break", "checkpoint previous digest does not chain.");
			if (
				event.previousCheckpointTurn !== previous.checkpointTurn ||
				event.previousDurableBytes !== previous.durableBytes
			)
				fail("chain_break", "checkpoint previous turn or bytes do not chain.");
			if (event.checkpointTurn <= previous.checkpointTurn)
				fail("invalid_chain", "checkpoint turns are not monotonic.");
		}
		previous = event;
	}
	let serializationDurationMs = 0;
	let restoreDurationMs = 0;
	let bytesWritten = 0;
	for (const event of ordered) {
		serializationDurationMs = addCumulative(
			serializationDurationMs,
			event.serializeEndedAtMonotonicMs - event.serializeStartedAtMonotonicMs,
			"serialization duration",
			MAX_CHECKPOINT_TELEMETRY_CUMULATIVE_DURATION_MS,
		);
		if (event.restoreStartedAtMonotonicMs !== null && event.restoreEndedAtMonotonicMs !== null)
			restoreDurationMs = addCumulative(
				restoreDurationMs,
				event.restoreEndedAtMonotonicMs - event.restoreStartedAtMonotonicMs,
				"restore duration",
				MAX_CHECKPOINT_TELEMETRY_CUMULATIVE_DURATION_MS,
			);
		bytesWritten = addCumulative(
			bytesWritten,
			event.bytesWritten,
			"bytes written",
			MAX_CHECKPOINT_TELEMETRY_CUMULATIVE_BYTES,
		);
	}
	const latest = ordered.at(-1)!;
	const largestRetainedValues = latest.retainedValues
		.filter(
			(value) =>
				value.representation === "durable" &&
				(value.classification === "durable_fact" || value.classification === "artifact_ref"),
		)
		.map((value) => ({
			valueId: value.valueId,
			type: value.type,
			bytes: value.bytes,
			classification: value.classification,
		}))
		.sort((left, right) => right.bytes - left.bytes || compareStableStrings(left.valueId, right.valueId));
	const projectionWithoutDigest = {
		schemaVersion: 1 as const,
		workflowId: first.workflowId,
		taskId: first.taskId,
		attemptId: first.attemptId,
		processGenerationId: latest.processGenerationId,
		runtimeVersion: first.runtimeVersion,
		epochRef: structuredClone(first.epochRef),
		head: structuredClone(latest.head),
		bindings: ordered.map((event) => ({
			workflowId: event.workflowId,
			taskId: event.taskId,
			attemptId: event.attemptId,
			processGenerationId: event.processGenerationId,
			runtimeVersion: event.runtimeVersion,
			head: structuredClone(event.head),
			epochRef: structuredClone(event.epochRef),
		})),
		eventIds: ordered.map((event) => event.eventId),
		eventDigests: ordered.map((event) => event.observationDigest),
		receiptDigests: ordered.map((event) => event.receiptDigest),
		authorizationDigests: ordered.map((event) => event.authorizationDigest),
		fenceDigests: ordered.map((event) => event.fenceDigest),
		requiredStateRegistryDigest: latest.requiredStateRegistryDigest,
		requiredStateIds: [...latest.requiredStateIds],
		missingRequiredStateIds: [...latest.missingRequiredStateIds],
		checkpointCount: ordered.length,
		serializationDurationMs,
		restoreDurationMs,
		bytesWritten,
		durableBytes: latest.durableBytes,
		growthBytesPerTurn: growthBytesPerTurn(latest),
		largestRetainedValues,
		durabilityOutcome: "durable" as const,
		failureReason: null,
		progressClaim: "none" as const,
		schedulerEffect: "advisory_only" as const,
	};
	return freezeDeep({
		...projectionWithoutDigest,
		projectionDigest: digestObject(projectionWithoutDigest),
	} as WorkflowCheckpointBudgetTelemetryProjection);
}
