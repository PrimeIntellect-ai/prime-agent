import { expect, it } from "vitest";

import type { WorkflowEpochRef } from "../../src/core/workflow/contracts.js";
import {
	createWorkflowRuntimeRecoveryCoordinator,
	type WorkflowRuntimeRecoveryDependencies,
} from "../../src/core/workflow/runtime-recovery.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };

function fixture(overrides: Partial<WorkflowRuntimeRecoveryDependencies> = {}): {
	dependencies: WorkflowRuntimeRecoveryDependencies;
	calls: { hydrate: number };
} {
	const calls = { hydrate: 0 };
	const dependencies = {
		workflowId: "workflow-startup-compatibility",
		store: {} as WorkflowRuntimeRecoveryDependencies["store"],
		epochs: { assertCurrent: async () => undefined },
		admission: {
			hydrateFromReplay: async () => {
				calls.hydrate += 1;
			},
			hydrateQuarantineFromReplay: async () => {
				calls.hydrate += 1;
			},
			lookupByExecutionKey: async () => undefined,
			quarantine: async () => {
				throw new Error("disabled recovery must not quarantine");
			},
		},
		leases: {
			hydrateFromReplay: async () => {
				calls.hydrate += 1;
			},
			lookupByLease: async () => undefined,
			release: async () => {
				throw new Error("disabled recovery must not release");
			},
			quarantine: async () => {
				throw new Error("disabled recovery must not quarantine leases");
			},
		},
		groups: {
			hydrateFromReplay: async () => {
				calls.hydrate += 1;
			},
			verify: async () => {
				throw new Error("disabled recovery must not inspect children");
			},
			inspect: async () => {
				throw new Error("disabled recovery must not inspect children");
			},
			quarantine: async () => {
				throw new Error("disabled recovery must not quarantine children");
			},
			scanUnknownDescendants: async () => {
				throw new Error("disabled recovery must not scan descendants");
			},
		},
		effects: {
			reconcile: async () => {
				throw new Error("disabled recovery must not reconcile effects");
			},
		},
		enabled: false,
		...overrides,
	} as WorkflowRuntimeRecoveryDependencies;
	return { dependencies, calls };
}

it("keeps ordinary startup disabled without touching workflow runtime ports", async () => {
	const fixtureData = fixture();
	const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixtureData.dependencies);

	expect(coordinator.readiness().canRecover).toBe(false);
	const result = await coordinator.reconcile({
		workflowId: "workflow-startup-compatibility",
		taskId: "task-startup-compatibility",
		attemptId: "attempt-startup-compatibility",
		executionKey: "execution-startup-compatibility",
		epochRef: EPOCH,
		persistedChildIdentity: null,
		evidenceRefs: [],
	});

	expect(result.disposition).toBe("user_input_required");
	expect(fixtureData.calls.hydrate).toBe(0);
});

it("disables recovery when the host does not attest process identity capability", async () => {
	const fixtureData = fixture({ enabled: true, capabilities: { processIdentity: false } });
	const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixtureData.dependencies);

	expect(coordinator.readiness()).toMatchObject({
		canRecover: false,
		blockingReasons: expect.arrayContaining(["process_start_identity_unavailable"]),
	});
	const result = await coordinator.reconcile({
		workflowId: "workflow-startup-compatibility",
		taskId: "task-startup-compatibility",
		attemptId: "attempt-startup-compatibility",
		executionKey: "execution-startup-compatibility",
		epochRef: EPOCH,
		persistedChildIdentity: null,
		evidenceRefs: [],
	});

	expect(result.disposition).toBe("user_input_required");
	expect(fixtureData.calls.hydrate).toBe(0);
});

it("treats omitted recovery capabilities as unavailable", async () => {
	const fixtureData = fixture({ enabled: true, capabilities: {} });
	const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixtureData.dependencies);

	expect(coordinator.readiness()).toMatchObject({
		canRecover: false,
		blockingReasons: expect.arrayContaining(["process_start_identity_unavailable", "effect_hook_unbrokered"]),
	});
});

it("blocks recovery when runtime version, writer identity, or append lease is missing", () => {
	const fixtureData = fixture({ enabled: true, capabilities: { processIdentity: true, effectResolution: true } });
	const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixtureData.dependencies);

	expect(coordinator.readiness()).toMatchObject({
		canRecover: false,
		blockingReasons: expect.arrayContaining([
			"workflow_runtime_version_unavailable",
			"workflow_writer_identity_unavailable",
			"workflow_append_lease_unavailable",
			"workflow_process_containment_unavailable",
		]),
	});
});
