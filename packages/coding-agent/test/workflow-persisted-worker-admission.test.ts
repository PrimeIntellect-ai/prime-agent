import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import type { WorkerModelCapabilityAvailabilityInput } from "../src/core/workflow/persisted-worker-model-admission.js";
import type { PersistedSessionWorkflowHostInput } from "../src/core/workflow/session-host-factory.js";
import { createPersistedSessionWorkflowHost } from "../src/core/workflow/session-host-factory.js";
import {
	WORKER_MODEL_ID,
	WORKER_MODEL_PROVIDER,
	WORKER_MODEL_REASONING,
	WORKER_MODEL_SELECTOR,
} from "../src/core/workflow/worker-model-capability-gate.js";

function createGoalProjection(): { read(): GoalState; compareAndSwap(expected: GoalState, next: GoalState): boolean } {
	let goal = emptyGoalState();
	return {
		read: (): GoalState => structuredClone(goal),
		compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
}

it("composes persisted exact-Luna admission from authenticated host availability", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-persisted-worker-admission-"));
	const workflowId = "workflow-persisted-worker-admission";
	const rootSessionId = "session-persisted-worker-admission";
	const epochRef = { storeEpoch: 1, coordinatorEpoch: 1 } as const;
	const inspected: WorkerModelCapabilityAvailabilityInput[] = [];
	let approvalDelivery:
		| Parameters<NonNullable<PersistedSessionWorkflowHostInput["approvalSecretDelivery"]>>[0]
		| undefined;
	const host = await createPersistedSessionWorkflowHost({
		artifactRoot,
		workflowId,
		rootSessionId,
		genesisEpoch: epochRef,
		goalProjection: createGoalProjection(),
		approvalSecretDelivery: (delivery) => {
			approvalDelivery = delivery;
		},
		workerModelCapabilityAvailability: async (input) => {
			inspected.push(structuredClone(input));
			return {
				authenticated: true,
				authRevision: "auth-revision-1",
				capabilityRevision: "capability-revision-1",
				safeReason: "available",
				desiredWorkers: 1,
				activeWorkers: 0,
				idleCapacity: 1,
				idleReason: null,
				retryAt: null,
			};
		},
	});
	try {
		const started = await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "admit one exact Luna worker",
				acceptanceChecks: ["worker-admitted"],
				protectedInvariants: ["no-fallback"],
			},
		});
		if (started.approvalRequest === null || approvalDelivery === undefined)
			throw new Error("worker admission fixture did not receive an approval request");
		const approve = started.approvalRequest.options.find((option) => option.optionId === "approve");
		if (approve === undefined) throw new Error("worker admission fixture did not receive the approve option");
		await host.execute({
			kind: "respond",
			approvalRequestId: started.approvalRequest.approvalRequestId,
			optionId: approve.optionId,
			proof: approvalDelivery.proof,
		});
		expect(host.admitWorkerModel).toBeTypeOf("function");
		const admission = await host.admitWorkerModel!({
			workflowId,
			taskId: "recon",
			attemptId: "attempt-recon-1",
			executionKey: "execution-recon-1",
			epochRef,
			prompt: "perform bounded recon",
			sessionName: "recon-worker",
			selector: WORKER_MODEL_SELECTOR,
			provider: WORKER_MODEL_PROVIDER,
			model: WORKER_MODEL_ID,
			reasoning: WORKER_MODEL_REASONING,
			allowFallback: false,
		});

		expect(inspected).toHaveLength(2);
		expect(admission.intent).toMatchObject({
			kind: "worker_model_admission_intent",
			workflowId,
			taskId: "recon",
			policy: {
				provider: WORKER_MODEL_PROVIDER,
				model: WORKER_MODEL_ID,
				reasoning: WORKER_MODEL_REASONING,
				allowFallback: false,
			},
			childModel: {
				provider: WORKER_MODEL_PROVIDER,
				model: WORKER_MODEL_ID,
				reasoning: WORKER_MODEL_REASONING,
				allowFallback: false,
			},
		});
		await expect(admission.handshake(admission.intent.childModel)).resolves.toEqual({
			status: "accepted",
			admissionDigest: admission.intent.admissionDigest,
		});
	} finally {
		await host.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});
