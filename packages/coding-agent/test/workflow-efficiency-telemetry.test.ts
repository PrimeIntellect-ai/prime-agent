import { describe, expect, it } from "vitest";
import type { WorkflowEpochRef, WorkflowJournalHead } from "../src/core/workflow/contracts.js";
import {
	createWorkflowEfficiencyTelemetryEvent,
	projectWorkflowEfficiencyTelemetry,
	type WorkflowEfficiencyTelemetryEvent,
	type WorkflowEfficiencyTelemetryEventInput,
} from "../src/core/workflow/efficiency-telemetry.js";

const epochRef: WorkflowEpochRef = { storeEpoch: 3, coordinatorEpoch: 7 };
const head: WorkflowJournalHead = {
	workflowId: "workflow-1",
	sequence: 12,
	eventDigest: "head-digest",
	epochRef,
};

function eventInput(
	kind: WorkflowEfficiencyTelemetryEventInput["kind"],
	overrides: Record<string, unknown> = {},
): WorkflowEfficiencyTelemetryEventInput {
	const common = {
		schemaVersion: 1 as const,
		eventId: `${kind}-1`,
		kind,
		workflowId: "workflow-1",
		taskId: "task-1",
		attemptId: "attempt-1",
		processGenerationId: "process-generation-1",
		head,
		epochRef,
		observedAtMonotonicMs: 100,
		source: "host" as const,
		authority: "host_committed" as const,
		progressClaim: "none" as const,
		schedulerEffect: "advisory_only" as const,
	};
	const payloadByKind: Record<WorkflowEfficiencyTelemetryEventInput["kind"], Record<string, unknown>> = {
		dispatch_latency_observed: {
			dispatchStartedAtMonotonicMs: 80,
			dispatchEndedAtMonotonicMs: 100,
		},
		child_wait_observed: {
			childWaitStartedAtMonotonicMs: 40,
			childWaitEndedAtMonotonicMs: 100,
		},
		child_idle_observed: {
			childIdleStartedAtMonotonicMs: 70,
			childIdleEndedAtMonotonicMs: 100,
		},
		duplicate_scan_observed: {
			scanStartedAtMonotonicMs: 90,
			scanEndedAtMonotonicMs: 100,
			scannedItemCount: 10,
			duplicateItemCount: 2,
		},
		focused_test_runtime_observed: {
			testStartedAtMonotonicMs: 50,
			testEndedAtMonotonicMs: 100,
			focusedTestCount: 1,
		},
		capacity_observed: {
			approvedCapacity: 8,
			eligibleCapacity: 3,
			blockedCapacity: 2,
			blockedReason: "resource_wait",
		},
		checkpoint_probe_observed: {
			lastCheckpointAtMonotonicMs: 0,
			probeRequestedAtMonotonicMs: 290,
			probeQueuedAtMonotonicMs: 297,
			probeDeliveredAtMonotonicMs: 304,
			disposition: "non_cancelling_safe_boundary",
			blockedReason: "overlapping_writer",
		},
	};
	return { ...common, ...payloadByKind[kind], ...overrides } as WorkflowEfficiencyTelemetryEventInput;
}

function event(
	kind: WorkflowEfficiencyTelemetryEventInput["kind"],
	overrides: Record<string, unknown> = {},
): WorkflowEfficiencyTelemetryEvent {
	return createWorkflowEfficiencyTelemetryEvent(eventInput(kind, overrides));
}

describe("workflow efficiency telemetry", () => {
	it("creates immutable host events and deterministically projects bounded advisory metrics", () => {
		const events = [
			event("capacity_observed"),
			event("focused_test_runtime_observed", {
				eventId: "test-1",
				observedAtMonotonicMs: 120,
				testEndedAtMonotonicMs: 120,
			}),
			event("dispatch_latency_observed", {
				eventId: "dispatch-1",
				observedAtMonotonicMs: 130,
				dispatchEndedAtMonotonicMs: 130,
			}),
			event("child_wait_observed", {
				eventId: "wait-1",
				observedAtMonotonicMs: 140,
				childWaitEndedAtMonotonicMs: 140,
			}),
			event("child_idle_observed", {
				eventId: "idle-1",
				observedAtMonotonicMs: 150,
				childIdleEndedAtMonotonicMs: 150,
			}),
			event("duplicate_scan_observed", {
				eventId: "scan-1",
				observedAtMonotonicMs: 160,
				scanEndedAtMonotonicMs: 160,
			}),
		];

		expect(Object.isFrozen(events[0])).toBe(true);
		expect(Object.isFrozen(events[0].head)).toBe(true);
		expect(projectWorkflowEfficiencyTelemetry([...events].reverse())).toMatchObject({
			dispatchLatencyMs: 50,
			childWaitTimeMs: 100,
			childIdleTimeMs: 80,
			duplicateScanCount: 1,
			duplicateItemCount: 2,
			focusedTestRuntimeMs: 70,
			focusedTestCount: 1,
			eligibleCapacity: 3,
			blockedCapacity: 2,
			blockedReason: "resource_wait",
			schedulerEffect: "advisory_only",
			progressClaim: "none",
		});
	});

	it("rejects worker self-reported authority before projection", () => {
		expect(() =>
			createWorkflowEfficiencyTelemetryEvent(
				eventInput("focused_test_runtime_observed", {
					authority: "worker_self_reported",
				}) as never,
			),
		).toThrow(/worker|self.?report|authority/i);
	});

	it("rejects duplicate and conflicting event identities", () => {
		const first = event("dispatch_latency_observed");
		const duplicate = event("dispatch_latency_observed", { eventId: first.eventId });
		expect(() => projectWorkflowEfficiencyTelemetry([first, duplicate])).toThrow(/duplicate|conflict/i);

		const conflicting = event("dispatch_latency_observed", { eventId: "conflict-1", taskId: "other-task" });
		const conflictingReplay = event("dispatch_latency_observed", {
			eventId: "conflict-1",
			taskId: "other-task",
			dispatchEndedAtMonotonicMs: 101,
			observedAtMonotonicMs: 101,
		});
		expect(() => projectWorkflowEfficiencyTelemetry([conflicting, conflictingReplay])).toThrow(/duplicate|conflict/i);
	});

	it("requires matching journal bindings and rejects mutable replay input", () => {
		expect(() =>
			createWorkflowEfficiencyTelemetryEvent(
				eventInput("dispatch_latency_observed", {
					epochRef: { storeEpoch: 4, coordinatorEpoch: 7 },
				}) as never,
			),
		).toThrow(/binding|epoch|head/i);

		const immutable = event("dispatch_latency_observed");
		const mutableReplay = structuredClone(immutable);
		expect(() => projectWorkflowEfficiencyTelemetry([mutableReplay])).toThrow(/immutable|frozen/i);
	});

	it("rejects negative or inflated capacity and requires an explicit blocked reason", () => {
		expect(() =>
			createWorkflowEfficiencyTelemetryEvent(eventInput("capacity_observed", { eligibleCapacity: -1 }) as never),
		).toThrow(/capacity|negative|invalid/i);
		expect(() =>
			createWorkflowEfficiencyTelemetryEvent(
				eventInput("capacity_observed", { eligibleCapacity: 7, blockedCapacity: 2 }) as never,
			),
		).toThrow(/capacity|inflated|approved/i);
		expect(() =>
			createWorkflowEfficiencyTelemetryEvent(
				eventInput("capacity_observed", { blockedCapacity: 1, blockedReason: null }) as never,
			),
		).toThrow(/blocked|reason/i);
	});

	it("does not turn focused test counts or coverage-shaped fields into progress", () => {
		expect(() =>
			createWorkflowEfficiencyTelemetryEvent(
				eventInput("focused_test_runtime_observed", { coveragePercent: 100 }) as never,
			),
		).toThrow(/field|coverage|progress/i);

		const projection = projectWorkflowEfficiencyTelemetry([
			event("focused_test_runtime_observed", { focusedTestCount: 99 }),
		]);
		expect(projection.progressClaim).toBe("none");
		expect(projection.schedulerEffect).toBe("advisory_only");
	});

	it("records checkpoint age and a non-cancelling probe without treating overlap blocking as progress", () => {
		const projection = projectWorkflowEfficiencyTelemetry([
			event("checkpoint_probe_observed", {
				observedAtMonotonicMs: 304,
			}),
		]);

		expect(projection).toMatchObject({
			lastCheckpointAgeMs: 304,
			probeRequestedToQueuedMs: 7,
			probeQueuedToDeliveredMs: 7,
			probeRequestedToDeliveredMs: 14,
			probeDisposition: "non_cancelling_safe_boundary",
			probeBlockedReason: "overlapping_writer",
			progressClaim: "none",
		});
	});
});
