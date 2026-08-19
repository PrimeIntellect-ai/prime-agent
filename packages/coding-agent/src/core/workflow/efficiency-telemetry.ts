import type { WorkflowEpochRef, WorkflowJournalHead } from "./contracts.js";
import { digestObject } from "./contracts.js";

export type WorkflowEfficiencyTelemetryEventKind =
	| "dispatch_latency_observed"
	| "child_wait_observed"
	| "child_idle_observed"
	| "duplicate_scan_observed"
	| "focused_test_runtime_observed"
	| "checkpoint_probe_observed"
	| "capacity_observed";

export interface WorkflowEfficiencyTelemetryEventBinding {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly processGenerationId: string;
	readonly head: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
}

interface WorkflowEfficiencyTelemetryEventBase extends WorkflowEfficiencyTelemetryEventBinding {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly kind: WorkflowEfficiencyTelemetryEventKind;
	readonly observedAtMonotonicMs: number;
	readonly source: "host";
	readonly authority: "host_committed";
	readonly progressClaim: "none";
	readonly schedulerEffect: "advisory_only";
}

export type WorkflowEfficiencyTelemetryEventInput =
	| (WorkflowEfficiencyTelemetryEventBase & {
			readonly kind: "dispatch_latency_observed";
			readonly dispatchStartedAtMonotonicMs: number;
			readonly dispatchEndedAtMonotonicMs: number;
	  })
	| (WorkflowEfficiencyTelemetryEventBase & {
			readonly kind: "child_wait_observed";
			readonly childWaitStartedAtMonotonicMs: number;
			readonly childWaitEndedAtMonotonicMs: number;
	  })
	| (WorkflowEfficiencyTelemetryEventBase & {
			readonly kind: "child_idle_observed";
			readonly childIdleStartedAtMonotonicMs: number;
			readonly childIdleEndedAtMonotonicMs: number;
	  })
	| (WorkflowEfficiencyTelemetryEventBase & {
			readonly kind: "duplicate_scan_observed";
			readonly scanStartedAtMonotonicMs: number;
			readonly scanEndedAtMonotonicMs: number;
			readonly scannedItemCount: number;
			readonly duplicateItemCount: number;
	  })
	| (WorkflowEfficiencyTelemetryEventBase & {
			readonly kind: "focused_test_runtime_observed";
			readonly testStartedAtMonotonicMs: number;
			readonly testEndedAtMonotonicMs: number;
			readonly focusedTestCount: number;
	  })
	| (WorkflowEfficiencyTelemetryEventBase & {
			readonly kind: "checkpoint_probe_observed";
			readonly lastCheckpointAtMonotonicMs: number;
			readonly probeRequestedAtMonotonicMs: number;
			readonly probeQueuedAtMonotonicMs: number;
			readonly probeDeliveredAtMonotonicMs: number;
			readonly disposition: "non_cancelling_safe_boundary";
			readonly blockedReason: string | null;
	  })
	| (WorkflowEfficiencyTelemetryEventBase & {
			readonly kind: "capacity_observed";
			readonly approvedCapacity: number;
			readonly eligibleCapacity: number;
			readonly blockedCapacity: number;
			readonly blockedReason: string | null;
	  });

export type WorkflowEfficiencyTelemetryEvent = WorkflowEfficiencyTelemetryEventInput & {
	readonly eventDigest: string;
};

export interface WorkflowEfficiencyTelemetryProjection {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly head: WorkflowJournalHead;
	readonly bindings: readonly WorkflowEfficiencyTelemetryEventBinding[];
	readonly eventIds: readonly string[];
	readonly eventDigests: readonly string[];
	readonly dispatchLatencyMs: number;
	readonly childWaitTimeMs: number;
	readonly childIdleTimeMs: number;
	readonly duplicateScanCount: number;
	readonly duplicateItemCount: number;
	readonly focusedTestRuntimeMs: number;
	readonly focusedTestCount: number;
	readonly lastCheckpointAgeMs: number;
	readonly probeRequestedToQueuedMs: number;
	readonly probeQueuedToDeliveredMs: number;
	readonly probeRequestedToDeliveredMs: number;
	readonly probeDisposition: "non_cancelling_safe_boundary" | null;
	readonly probeBlockedReason: string | null;
	readonly checkpointProbeCount: number;
	readonly approvedCapacity: number;
	readonly eligibleCapacity: number;
	readonly blockedCapacity: number;
	readonly blockedReason: string | null;
	readonly capacityObservationCount: number;
	readonly progressClaim: "none";
	readonly schedulerEffect: "advisory_only";
	readonly projectionDigest: string;
}

export class WorkflowEfficiencyTelemetryError extends Error {
	readonly code: string;

	public constructor(code: string, message: string) {
		super(message);
		this.name = "WorkflowEfficiencyTelemetryError";
		this.code = code;
	}
}

const COMMON_EVENT_KEYS = [
	"schemaVersion",
	"eventId",
	"kind",
	"workflowId",
	"taskId",
	"attemptId",
	"processGenerationId",
	"head",
	"epochRef",
	"observedAtMonotonicMs",
	"source",
	"authority",
	"progressClaim",
	"schedulerEffect",
] as const;

const PAYLOAD_EVENT_KEYS: Readonly<Record<WorkflowEfficiencyTelemetryEventKind, readonly string[]>> = {
	dispatch_latency_observed: ["dispatchStartedAtMonotonicMs", "dispatchEndedAtMonotonicMs"],
	child_wait_observed: ["childWaitStartedAtMonotonicMs", "childWaitEndedAtMonotonicMs"],
	child_idle_observed: ["childIdleStartedAtMonotonicMs", "childIdleEndedAtMonotonicMs"],
	duplicate_scan_observed: [
		"scanStartedAtMonotonicMs",
		"scanEndedAtMonotonicMs",
		"scannedItemCount",
		"duplicateItemCount",
	],
	focused_test_runtime_observed: ["testStartedAtMonotonicMs", "testEndedAtMonotonicMs", "focusedTestCount"],
	checkpoint_probe_observed: [
		"lastCheckpointAtMonotonicMs",
		"probeRequestedAtMonotonicMs",
		"probeQueuedAtMonotonicMs",
		"probeDeliveredAtMonotonicMs",
		"disposition",
		"blockedReason",
	],
	capacity_observed: ["approvedCapacity", "eligibleCapacity", "blockedCapacity", "blockedReason"],
};

function fail(code: string, message: string): never {
	throw new WorkflowEfficiencyTelemetryError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) fail("invalid_record", `${label} must be a plain object.`);
	return value;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.getOwnPropertySymbols(value).length > 0)
		fail("unknown_event_field", `${label} contains symbol fields outside the closed contract.`);
	const expected = new Set(keys);
	const actual = Object.keys(value);
	if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
		fail("unknown_event_field", `${label} contains an unknown or missing field.`);
	}
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) fail("invalid_identity", `${label} must be non-empty.`);
}

function assertSafeNonNegativeInteger(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		fail("invalid_metric", `${label} must be a finite non-negative safe integer.`);
}

function assertEpochRef(value: unknown, label: string): asserts value is WorkflowEpochRef {
	const candidate = record(value, label);
	assertExactKeys(candidate, ["storeEpoch", "coordinatorEpoch"], label);
	assertSafeNonNegativeInteger(candidate.storeEpoch, `${label}.storeEpoch`);
	assertSafeNonNegativeInteger(candidate.coordinatorEpoch, `${label}.coordinatorEpoch`);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function assertHead(
	value: unknown,
	workflowId: string,
	epochRef: WorkflowEpochRef,
): asserts value is WorkflowJournalHead {
	const candidate = record(value, "head");
	assertExactKeys(candidate, ["workflowId", "sequence", "eventDigest", "epochRef"], "head");
	assertNonEmptyString(candidate.workflowId, "head.workflowId");
	if (candidate.workflowId !== workflowId) fail("conflicting_binding", "head.workflowId does not match workflowId.");
	assertSafeNonNegativeInteger(candidate.sequence, "head.sequence");
	if (candidate.eventDigest !== null) assertNonEmptyString(candidate.eventDigest, "head.eventDigest");
	assertEpochRef(candidate.epochRef, "head.epochRef");
	if (!sameEpoch(candidate.epochRef, epochRef)) fail("conflicting_binding", "head.epochRef does not match epochRef.");
}

function assertMonotonicInterval(start: unknown, end: unknown, label: string): number {
	assertSafeNonNegativeInteger(start, `${label}.start`);
	assertSafeNonNegativeInteger(end, `${label}.end`);
	if ((end as number) < (start as number)) fail("invalid_timestamp", `${label} ends before it starts.`);
	return (end as number) - (start as number);
}

function assertObservedAt(value: unknown, expectedEnd: unknown, label: string): void {
	assertSafeNonNegativeInteger(value, label);
	assertSafeNonNegativeInteger(expectedEnd, `${label}.end`);
	if (value !== expectedEnd) fail("invalid_timestamp", `${label} must equal the interval end.`);
}

function assertCapacity(value: Record<string, unknown>): void {
	assertSafeNonNegativeInteger(value.approvedCapacity, "approvedCapacity");
	assertSafeNonNegativeInteger(value.eligibleCapacity, "eligibleCapacity");
	assertSafeNonNegativeInteger(value.blockedCapacity, "blockedCapacity");
	const total = (value.eligibleCapacity as number) + (value.blockedCapacity as number);
	if (!Number.isSafeInteger(total) || total > (value.approvedCapacity as number)) {
		fail("capacity_inflated", "eligible and blocked capacity exceed approved capacity.");
	}
	if (value.blockedCapacity !== 0) {
		assertNonEmptyString(value.blockedReason, "blockedReason");
	} else if (value.blockedReason !== null) {
		fail("blocked_reason_required", "blockedReason must be null when blockedCapacity is zero.");
	}
}

function assertDeepFrozen(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): void {
	if (typeof value !== "object" || value === null) return;
	if (seen.has(value)) return;
	seen.add(value);
	if (!Object.isFrozen(value))
		fail("event_not_immutable", "workflow efficiency telemetry events must be deeply frozen.");
	for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function validateEvent(value: unknown, requireFrozen: boolean): Record<string, unknown> {
	const candidate = record(value, "telemetry event");
	if (requireFrozen) assertDeepFrozen(candidate);
	if (candidate.schemaVersion !== 1)
		fail("schema_version", "workflow efficiency telemetry schema version is unsupported.");
	assertNonEmptyString(candidate.eventId, "eventId");
	if (typeof candidate.kind !== "string" || !(candidate.kind in PAYLOAD_EVENT_KEYS)) {
		fail("event_kind", "workflow efficiency telemetry event kind is not closed.");
	}
	const kind = candidate.kind as WorkflowEfficiencyTelemetryEventKind;
	const keys = [...COMMON_EVENT_KEYS, ...PAYLOAD_EVENT_KEYS[kind], ...(requireFrozen ? ["eventDigest"] : [])];
	assertExactKeys(candidate, keys, "telemetry event");
	assertNonEmptyString(candidate.workflowId, "workflowId");
	assertNonEmptyString(candidate.taskId, "taskId");
	assertNonEmptyString(candidate.attemptId, "attemptId");
	assertNonEmptyString(candidate.processGenerationId, "processGenerationId");
	assertEpochRef(candidate.epochRef, "epochRef");
	assertHead(candidate.head, candidate.workflowId, candidate.epochRef);
	assertSafeNonNegativeInteger(candidate.observedAtMonotonicMs, "observedAtMonotonicMs");
	if (candidate.source !== "host" || candidate.authority !== "host_committed") {
		fail("worker_self_report", "worker self-reported efficiency telemetry is not authoritative.");
	}
	if (candidate.progressClaim !== "none" || candidate.schedulerEffect !== "advisory_only") {
		fail("metric_authority", "efficiency telemetry cannot claim progress or mutate the scheduler.");
	}

	switch (kind) {
		case "dispatch_latency_observed":
			assertMonotonicInterval(
				candidate.dispatchStartedAtMonotonicMs,
				candidate.dispatchEndedAtMonotonicMs,
				"dispatch latency",
			);
			assertObservedAt(
				candidate.observedAtMonotonicMs,
				candidate.dispatchEndedAtMonotonicMs,
				"observedAtMonotonicMs",
			);
			break;
		case "child_wait_observed":
			assertMonotonicInterval(
				candidate.childWaitStartedAtMonotonicMs,
				candidate.childWaitEndedAtMonotonicMs,
				"child wait",
			);
			assertObservedAt(
				candidate.observedAtMonotonicMs,
				candidate.childWaitEndedAtMonotonicMs,
				"observedAtMonotonicMs",
			);
			break;
		case "child_idle_observed":
			assertMonotonicInterval(
				candidate.childIdleStartedAtMonotonicMs,
				candidate.childIdleEndedAtMonotonicMs,
				"child idle",
			);
			assertObservedAt(
				candidate.observedAtMonotonicMs,
				candidate.childIdleEndedAtMonotonicMs,
				"observedAtMonotonicMs",
			);
			break;
		case "duplicate_scan_observed":
			assertMonotonicInterval(
				candidate.scanStartedAtMonotonicMs,
				candidate.scanEndedAtMonotonicMs,
				"duplicate scan",
			);
			assertObservedAt(candidate.observedAtMonotonicMs, candidate.scanEndedAtMonotonicMs, "observedAtMonotonicMs");
			assertSafeNonNegativeInteger(candidate.scannedItemCount, "scannedItemCount");
			assertSafeNonNegativeInteger(candidate.duplicateItemCount, "duplicateItemCount");
			if ((candidate.duplicateItemCount as number) > (candidate.scannedItemCount as number))
				fail("invalid_metric", "duplicate items cannot exceed scanned items.");
			break;
		case "focused_test_runtime_observed":
			assertMonotonicInterval(
				candidate.testStartedAtMonotonicMs,
				candidate.testEndedAtMonotonicMs,
				"focused test runtime",
			);
			assertObservedAt(candidate.observedAtMonotonicMs, candidate.testEndedAtMonotonicMs, "observedAtMonotonicMs");
			assertSafeNonNegativeInteger(candidate.focusedTestCount, "focusedTestCount");
			if ((candidate.focusedTestCount as number) < 1)
				fail("invalid_metric", "focused test runtime must describe at least one focused test.");
			break;
		case "checkpoint_probe_observed":
			assertSafeNonNegativeInteger(candidate.lastCheckpointAtMonotonicMs, "lastCheckpointAtMonotonicMs");
			assertMonotonicInterval(
				candidate.probeRequestedAtMonotonicMs,
				candidate.probeQueuedAtMonotonicMs,
				"checkpoint probe request to queue",
			);
			assertMonotonicInterval(
				candidate.probeQueuedAtMonotonicMs,
				candidate.probeDeliveredAtMonotonicMs,
				"checkpoint probe queue to delivery",
			);
			assertObservedAt(
				candidate.observedAtMonotonicMs,
				candidate.probeDeliveredAtMonotonicMs,
				"observedAtMonotonicMs",
			);
			if ((candidate.lastCheckpointAtMonotonicMs as number) > (candidate.probeDeliveredAtMonotonicMs as number))
				fail("invalid_timestamp", "last checkpoint cannot occur after probe delivery.");
			if (candidate.disposition !== "non_cancelling_safe_boundary")
				fail("probe_disposition", "checkpoint probes must be non-cancelling safe-boundary requests.");
			if (candidate.blockedReason !== null) assertNonEmptyString(candidate.blockedReason, "blockedReason");
			break;
		case "capacity_observed":
			assertCapacity(candidate);
			break;
		default: {
			const unsupported: never = kind;
			fail("event_kind", `Unsupported efficiency telemetry event kind ${unsupported}.`);
		}
	}
	return candidate;
}

function withoutEventDigest(value: Record<string, unknown>): Record<string, unknown> {
	const { eventDigest: _eventDigest, ...preimage } = value;
	return preimage;
}

function freezeDeep<T>(value: T, seen: WeakSet<object> = new WeakSet<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) freezeDeep(child, seen);
	return Object.freeze(value);
}

function addDuration(total: number, duration: number, label: string): number {
	const next = total + duration;
	if (!Number.isSafeInteger(next)) fail("metric_overflow", `${label} exceeds the safe integer bound.`);
	return next;
}

function eventTimestamp(event: Record<string, unknown>): number {
	return event.observedAtMonotonicMs as number;
}

function compareEvents(left: Record<string, unknown>, right: Record<string, unknown>): number {
	const timestampDifference = eventTimestamp(left) - eventTimestamp(right);
	return timestampDifference !== 0 ? timestampDifference : String(left.eventId).localeCompare(String(right.eventId));
}

/**
 * Creates one immutable, host-authoritative workflow efficiency telemetry event.
 *
 * Args:
 * input: Host-observed event facts bound to one workflow journal head and epoch.
 * Return: Deep-frozen event with a canonical content digest.
 */
export function createWorkflowEfficiencyTelemetryEvent(
	input: WorkflowEfficiencyTelemetryEventInput,
): WorkflowEfficiencyTelemetryEvent {
	const candidate = validateEvent(input, false);
	const detached = structuredClone(candidate);
	const event = {
		...detached,
		eventDigest: digestObject(detached),
	} as WorkflowEfficiencyTelemetryEvent;
	return freezeDeep(event);
}

/**
 * Projects a committed workflow telemetry slice into deterministic advisory metrics.
 *
 * Args:
 * events: Deep-frozen host events from one workflow and epoch.
 * Return: Frozen metric projection with no progress or scheduler authority.
 */
export function projectWorkflowEfficiencyTelemetry(
	events: readonly WorkflowEfficiencyTelemetryEvent[],
): WorkflowEfficiencyTelemetryProjection {
	if (events.length === 0) fail("empty_projection", "workflow efficiency telemetry projection requires events.");
	const validated = events.map((event) => {
		const candidate = validateEvent(event, true);
		if (candidate.eventDigest !== digestObject(withoutEventDigest(candidate)))
			fail(
				"event_digest_mismatch",
				"workflow efficiency telemetry event digest does not match its immutable facts.",
			);
		return candidate;
	});

	const eventIds = new Set<string>();
	const ordered = [...validated].sort(compareEvents);
	const first = ordered[0]!;
	const workflowId = first.workflowId as string;
	const epochRef = first.epochRef as WorkflowEpochRef;
	let previousHeadSequence = -1;
	let previousHeadDigest: string | null = null;
	for (const event of ordered) {
		if (eventIds.has(event.eventId as string))
			fail("duplicate_event_id", "workflow efficiency telemetry event ID is duplicated.");
		eventIds.add(event.eventId as string);
		if (event.workflowId !== workflowId || !sameEpoch(event.epochRef as WorkflowEpochRef, epochRef))
			fail("conflicting_binding", "workflow efficiency telemetry events must share workflow and epoch bindings.");
		const currentHead = event.head as WorkflowJournalHead;
		if (currentHead.sequence < previousHeadSequence)
			fail("conflicting_binding", "workflow efficiency telemetry head sequence regressed.");
		if (currentHead.sequence === previousHeadSequence && currentHead.eventDigest !== previousHeadDigest)
			fail("conflicting_binding", "workflow efficiency telemetry contains conflicting journal heads.");
		previousHeadSequence = currentHead.sequence;
		previousHeadDigest = currentHead.eventDigest;
	}

	let dispatchLatencyMs = 0;
	let childWaitTimeMs = 0;
	let childIdleTimeMs = 0;
	let duplicateScanCount = 0;
	let duplicateItemCount = 0;
	let focusedTestRuntimeMs = 0;
	let focusedTestCount = 0;
	let lastCheckpointAgeMs = 0;
	let probeRequestedToQueuedMs = 0;
	let probeQueuedToDeliveredMs = 0;
	let probeRequestedToDeliveredMs = 0;
	let probeDisposition: "non_cancelling_safe_boundary" | null = null;
	let probeBlockedReason: string | null = null;
	let checkpointProbeCount = 0;
	const capacityEvents: Record<string, unknown>[] = [];
	for (const event of ordered) {
		switch (event.kind as WorkflowEfficiencyTelemetryEventKind) {
			case "dispatch_latency_observed":
				dispatchLatencyMs = addDuration(
					dispatchLatencyMs,
					(event.dispatchEndedAtMonotonicMs as number) - (event.dispatchStartedAtMonotonicMs as number),
					"dispatch latency",
				);
				break;
			case "child_wait_observed":
				childWaitTimeMs = addDuration(
					childWaitTimeMs,
					(event.childWaitEndedAtMonotonicMs as number) - (event.childWaitStartedAtMonotonicMs as number),
					"child wait",
				);
				break;
			case "child_idle_observed":
				childIdleTimeMs = addDuration(
					childIdleTimeMs,
					(event.childIdleEndedAtMonotonicMs as number) - (event.childIdleStartedAtMonotonicMs as number),
					"child idle",
				);
				break;
			case "duplicate_scan_observed":
				duplicateScanCount++;
				duplicateItemCount = addDuration(
					duplicateItemCount,
					event.duplicateItemCount as number,
					"duplicate item count",
				);
				break;
			case "focused_test_runtime_observed":
				focusedTestRuntimeMs = addDuration(
					focusedTestRuntimeMs,
					(event.testEndedAtMonotonicMs as number) - (event.testStartedAtMonotonicMs as number),
					"focused test runtime",
				);
				focusedTestCount = addDuration(focusedTestCount, event.focusedTestCount as number, "focused test count");
				break;
			case "checkpoint_probe_observed": {
				const requestedAt = event.probeRequestedAtMonotonicMs as number;
				const queuedAt = event.probeQueuedAtMonotonicMs as number;
				const deliveredAt = event.probeDeliveredAtMonotonicMs as number;
				const checkpointAt = event.lastCheckpointAtMonotonicMs as number;
				probeRequestedToQueuedMs = addDuration(
					probeRequestedToQueuedMs,
					queuedAt - requestedAt,
					"checkpoint probe request to queue",
				);
				probeQueuedToDeliveredMs = addDuration(
					probeQueuedToDeliveredMs,
					deliveredAt - queuedAt,
					"checkpoint probe queue to delivery",
				);
				probeRequestedToDeliveredMs = addDuration(
					probeRequestedToDeliveredMs,
					deliveredAt - requestedAt,
					"checkpoint probe request to delivery",
				);
				lastCheckpointAgeMs = deliveredAt - checkpointAt;
				probeDisposition = event.disposition as "non_cancelling_safe_boundary";
				probeBlockedReason = event.blockedReason as string | null;
				checkpointProbeCount++;
				break;
			}
			case "capacity_observed":
				capacityEvents.push(event);
				break;
			default: {
				const unsupported: never = event.kind as never;
				fail("event_kind", `Unsupported efficiency telemetry event kind ${unsupported}.`);
			}
		}
	}

	const latestCapacity = capacityEvents.at(-1);
	const projectionWithoutDigest = {
		schemaVersion: 1 as const,
		workflowId,
		epochRef: structuredClone(epochRef),
		head: structuredClone(ordered.at(-1)!.head as WorkflowJournalHead),
		bindings: ordered.map((event) => ({
			workflowId: event.workflowId as string,
			taskId: event.taskId as string,
			attemptId: event.attemptId as string,
			processGenerationId: event.processGenerationId as string,
			head: structuredClone(event.head as WorkflowJournalHead),
			epochRef: structuredClone(event.epochRef as WorkflowEpochRef),
		})),
		eventIds: ordered.map((event) => event.eventId as string),
		eventDigests: ordered.map((event) => event.eventDigest as string),
		dispatchLatencyMs,
		childWaitTimeMs,
		childIdleTimeMs,
		duplicateScanCount,
		duplicateItemCount,
		focusedTestRuntimeMs,
		focusedTestCount,
		lastCheckpointAgeMs,
		probeRequestedToQueuedMs,
		probeQueuedToDeliveredMs,
		probeRequestedToDeliveredMs,
		probeDisposition,
		probeBlockedReason,
		checkpointProbeCount,
		approvedCapacity: (latestCapacity?.approvedCapacity as number | undefined) ?? 0,
		eligibleCapacity: (latestCapacity?.eligibleCapacity as number | undefined) ?? 0,
		blockedCapacity: (latestCapacity?.blockedCapacity as number | undefined) ?? 0,
		blockedReason: (latestCapacity?.blockedReason as string | null | undefined) ?? null,
		capacityObservationCount: capacityEvents.length,
		progressClaim: "none" as const,
		schedulerEffect: "advisory_only" as const,
	};
	const projection = {
		...projectionWithoutDigest,
		projectionDigest: digestObject(projectionWithoutDigest),
	} as WorkflowEfficiencyTelemetryProjection;
	return freezeDeep(projection);
}
