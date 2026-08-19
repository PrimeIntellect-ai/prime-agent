import { expect, it, vi } from "vitest";

import type { WorkflowEpochRef } from "../../src/core/workflow/contracts.js";
import { createDefaultPrimeTaskRuntime } from "../../src/core/workflow/default-task-runtime.js";
import type { WorkflowSchedulerState } from "../../src/core/workflow/scheduler.js";
import type {
	WorkflowTaskRuntimeAudit,
	WorkflowTaskRuntimeAuthority,
	WorkflowTaskRuntimeEvidenceClassification,
	WorkflowTaskRuntimeStatus,
} from "../../src/core/workflow/task-runtime-authority.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const SCHEDULER_STATE: WorkflowSchedulerState = {
	workflowId: "workflow-default-task-runtime-boundary",
	epochRef: EPOCH,
	entries: [],
	pausedReason: null,
	activeAttemptIds: [],
	terminalAttemptIds: [],
	lastEventSequence: 0,
};
const STATUS: WorkflowTaskRuntimeStatus = {
	status: "waiting_on_children",
	goalRevisionDigest: "0".repeat(64),
	activeWorkers: 1,
	eligibleReadyTasks: 0,
	idleCapacity: 1,
	idleReason: "none",
	progressCutHeadDigest: null,
	lastAuthoritativeProgressAt: null,
	progressLeaseOwner: null,
	progressLeaseDeadline: null,
	progressPredicateDigest: null,
	nextWakeAt: null,
	progressRecoveryCount: 0,
	readyTaskSetDigest: null,
	nextGate: null,
	progressStallReason: null,
};
const AUDIT: WorkflowTaskRuntimeAudit = {
	scheduler: SCHEDULER_STATE,
	terminalTaskIds: [],
	launchEvidenceRefs: [],
	workerResults: [],
};
const CLASSIFICATION: WorkflowTaskRuntimeEvidenceClassification = {
	boundary: "public_boundary",
	verification: "host_verified",
	evidenceKind: "real_integration",
	authorizesTerminalization: true,
};

function authorityFixture(): {
	readonly authority: WorkflowTaskRuntimeAuthority;
	readonly start: ReturnType<typeof vi.fn>;
	readonly assertStageAcceptable: ReturnType<typeof vi.fn>;
	readonly acceptStage: ReturnType<typeof vi.fn>;
	readonly readStatus: ReturnType<typeof vi.fn>;
} {
	const scheduler = {} as WorkflowTaskRuntimeAuthority["scheduler"];
	const prime = {} as WorkflowTaskRuntimeAuthority["prime"];
	const start = vi.fn(async () => []);
	const assertStageAcceptable = vi.fn(async () => undefined);
	const acceptStage = vi.fn(async () => undefined);
	const readStatus = vi.fn(async () => STATUS);
	const authority = {
		workflowId: SCHEDULER_STATE.workflowId,
		epochRef: EPOCH,
		graph: {} as WorkflowTaskRuntimeAuthority["graph"],
		runtimeStore: {} as WorkflowTaskRuntimeAuthority["runtimeStore"],
		scheduler,
		dispatcher: {} as WorkflowTaskRuntimeAuthority["dispatcher"],
		leases: {} as WorkflowTaskRuntimeAuthority["leases"],
		effects: {} as WorkflowTaskRuntimeAuthority["effects"],
		recovery: {} as WorkflowTaskRuntimeAuthority["recovery"],
		prime,
		failureOutbox: {} as WorkflowTaskRuntimeAuthority["failureOutbox"],
		start,
		dispatch: vi.fn(async () => []),
		onEvent: vi.fn(async () => []),
		onTerminal: vi.fn(async () => []),
		readStatus,
		recordTelemetry: vi.fn(async () => undefined),
		assertStageAcceptable,
		acceptStage,
		readState: vi.fn(async () => SCHEDULER_STATE),
		readAudit: vi.fn(async () => AUDIT),
		recover: vi.fn(async () => {
			throw new Error("fixture_recovery_not_used");
		}),
		reassign: vi.fn(async () => []),
	} as unknown as WorkflowTaskRuntimeAuthority;
	return { authority, start, assertStageAcceptable, acceptStage, readStatus };
}

it("requires the generic authority at the public task-runtime boundary", () => {
	expect(() => createDefaultPrimeTaskRuntime({})).toThrow("default_prime_task_runtime_authority_required");
});

it("delegates the Prime surface and authenticated status to the generic authority", async () => {
	const fixture = authorityFixture();
	const runtime = createDefaultPrimeTaskRuntime({ authority: fixture.authority });

	expect(runtime.authority).toBe(fixture.authority);
	expect(runtime.scheduler).toBe(fixture.authority.scheduler);
	expect(runtime.prime).toBe(fixture.authority.prime);
	await runtime.start();
	await runtime.assertStageAcceptable({ stageId: "stage-1", classification: CLASSIFICATION });
	await runtime.acceptStage({ stageId: "stage-1", classification: CLASSIFICATION });
	await expect(runtime.readStatus()).resolves.toBe(STATUS);
	await expect(runtime.read()).resolves.toBe(SCHEDULER_STATE);
	await expect(runtime.readAudit()).resolves.toBe(AUDIT);

	expect(fixture.start).toHaveBeenCalledTimes(1);
	expect(fixture.assertStageAcceptable).toHaveBeenCalledWith({ stageId: "stage-1", classification: CLASSIFICATION });
	expect(fixture.acceptStage).toHaveBeenCalledWith({ stageId: "stage-1", classification: CLASSIFICATION });
	expect(fixture.readStatus).toHaveBeenCalledTimes(1);
});
