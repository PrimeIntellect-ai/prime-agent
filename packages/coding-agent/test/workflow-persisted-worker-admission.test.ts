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
	workerModelReasoningFor,
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

// Builds a real persisted host, a faux provider and a discovery server, and takes 15-25s alone. The
// 30s default is not a bound on this test's correctness, only on the machine's spare capacity: under a
// parallel run it times out at 30004ms and then reads as a defect, which is exactly how I misdiagnosed
// it. Give it room rather than excluding it from the default run.
it("composes persisted allowlisted admission from authenticated host availability", { timeout: 180_000 }, async () => {
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

		// Compute tiering sends deep tasks to a second selector. What the receipt attests has to be
		// the model the child will actually run: attesting the default while spawning sol would make
		// the whole admission chain decorative for every non-default tier.
		const deepAdmission = await host.admitWorkerModel!({
			workflowId,
			taskId: "architect",
			attemptId: "attempt-architect-1",
			executionKey: "execution-architect-1",
			epochRef,
			prompt: "plan the pipeline",
			sessionName: "architect-worker",
			selector: `${WORKER_MODEL_PROVIDER}/gpt-5.6-sol`,
			provider: WORKER_MODEL_PROVIDER,
			model: "gpt-5.6-sol",
			// The deep tier runs at its own level; requesting max here is refused, not silently coerced.
			reasoning: workerModelReasoningFor("gpt-5.6-sol")!,
			allowFallback: false,
		});
		expect(deepAdmission.intent).toMatchObject({
			policy: { model: "gpt-5.6-sol" },
			childModel: { provider: WORKER_MODEL_PROVIDER, model: "gpt-5.6-sol", allowFallback: false },
		});
		await expect(deepAdmission.handshake(deepAdmission.intent.childModel)).resolves.toMatchObject({
			status: "accepted",
		});

		// The set stays closed: a selector the host never vetted is refused, not admitted.
		await expect(
			host.admitWorkerModel!({
				workflowId,
				taskId: "architect",
				attemptId: "attempt-architect-2",
				executionKey: "execution-architect-2",
				epochRef,
				prompt: "plan the pipeline",
				sessionName: "architect-worker-2",
				selector: "openrouter/some/other-model",
				provider: WORKER_MODEL_PROVIDER,
				model: "some-other-model",
				reasoning: WORKER_MODEL_REASONING,
				allowFallback: false,
			}),
		).rejects.toThrow("worker_model_policy_selector_denied");

		// An admitted model at a level the host never vetted is refused too: the tier is the pair,
		// not just the model id.
		await expect(
			host.admitWorkerModel!({
				workflowId,
				taskId: "architect",
				attemptId: "attempt-architect-3",
				executionKey: "execution-architect-3",
				epochRef,
				prompt: "plan the pipeline",
				sessionName: "architect-worker-3",
				selector: `${WORKER_MODEL_PROVIDER}/gpt-5.6-sol`,
				provider: WORKER_MODEL_PROVIDER,
				model: "gpt-5.6-sol",
				reasoning: "low",
				allowFallback: false,
			}),
		).rejects.toThrow("worker_model_policy_reasoning_denied");
	} finally {
		await host.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});
