import { expect, it } from "vitest";
import type { WorkflowAdmissionResult } from "../../src/core/workflow/admission.js";
import type {
	WorkflowChildProcessBinding,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowLeaseRef,
	WorkflowProcessGroupIdentity,
	WorkflowRuntimeEventPayload,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreIdentity,
	WorkflowStoreCommitResult,
	WorkflowStoreReplayResult,
} from "../../src/core/workflow/contracts.js";
import { digestObject } from "../../src/core/workflow/contracts.js";
import {
	canonicalWorkflowBindingDigest,
	canonicalWorkflowIdentityDigest,
	canonicalWorkflowProcessGroupDigest,
	createWorkflowProcessGroupController,
	type WorkflowProcessGroupControllerDependencies,
	type WorkflowProcessGroupPlatform,
} from "../../src/core/workflow/process-groups.js";

const epoch: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const lease: WorkflowLeaseRef = {
	...epoch,
	leaseId: "lease-recovery-test",
	acquisitionEventSequence: 1,
	processIdentity: "process-recovery-test",
	rootDigest: "root-recovery-test",
	writerIdentity: "writer-recovery-test",
	acquiredAt: "2030-01-01T00:00:00.000Z",
	expiresAt: "2030-01-01T00:10:00.000Z",
};

function group(): WorkflowProcessGroupIdentity {
	const base = { pid: 42, processStartId: "start-42", processGroupId: "group-42", parentPid: 1 };
	return { ...base, identityDigest: canonicalWorkflowProcessGroupDigest(base) };
}

function binding(): WorkflowChildProcessBinding {
	const processGroup = group();
	const childBase = {
		admissionId: "admission-recovery-test",
		childSessionId: "child-recovery-test",
		executionKey: "execution-recovery-test",
		epochRef: epoch,
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-recovery-test",
		agentRole: "worker",
		modelId: "model-recovery-test",
		reasoningEffort: "medium",
		launchConfigDigest: "launch-recovery-test",
		processGroupId: processGroup.processGroupId,
	};
	const childIdentity = { ...childBase, identityDigest: canonicalWorkflowIdentityDigest(childBase) };
	return {
		workflowId: "workflow-recovery-test",
		taskId: "task-recovery-test",
		attemptId: "attempt-recovery-test",
		childIdentity,
		processGroup,
		bindingDigest: canonicalWorkflowBindingDigest({ childIdentity, processGroup }),
	};
}

function admissionFor(binding: WorkflowChildProcessBinding): WorkflowAdmissionResult {
	return {
		admissionId: binding.childIdentity.admissionId,
		context: {
			workflowId: binding.workflowId,
			taskId: binding.taskId,
			attemptId: binding.attemptId,
			executionKey: binding.childIdentity.executionKey,
			epochRef: binding.childIdentity.epochRef,
			runtimeVersion: binding.childIdentity.runtimeVersion,
			hostCapabilityRevision: binding.childIdentity.hostCapabilityRevision,
			agentRole: binding.childIdentity.agentRole,
			modelId: binding.childIdentity.modelId,
			reasoningEffort: binding.childIdentity.reasoningEffort,
			launchConfigDigest: binding.childIdentity.launchConfigDigest,
		} as never,
		childIdentity: binding.childIdentity,
		processBinding: binding,
		terminalEventSequence: null,
	} as never;
}

function storeFor(events: WorkflowRuntimeEventPayload[]): WorkflowRuntimeStore {
	const identity: WorkflowRuntimeStoreIdentity = {
		storeKind: "workflow",
		namespace: "test",
		rootDir: "/tmp/workflow-recovery-test",
		storeId: "store-recovery-test",
		workflowId: "workflow-recovery-test",
		identityDigest: "store-recovery-test-digest",
	};
	return {
		identity,
		commit: async <TPayload extends WorkflowEventPayload>(): Promise<WorkflowStoreCommitResult<TPayload>> =>
			undefined as unknown as WorkflowStoreCommitResult<TPayload>,
		replay: async (): Promise<WorkflowStoreReplayResult> => ({
			workflowId: identity.workflowId,
			executionKey: null,
			events: events.map((payload, index) => ({ payload, idempotencyKey: `event-${index}` })) as never,
			head: { workflowId: identity.workflowId, sequence: events.length, eventDigest: null, epochRef: epoch },
			quarantined: false,
			quarantineReason: null,
		}),
		publishArtifact: async () => undefined as never,
		publishSnapshot: async () => undefined as never,
		compareAndSwapProjection: async () => "applied",
		appendOutbox: async () => undefined as never,
		replaceCoordinatorEpoch: async () => undefined as never,
		replaceStoreEpoch: async () => undefined as never,
	};
}

it("hydrates only persisted process bindings with matching ownership events", async () => {
	const persistedBinding = binding();
	const persistedMarker = {
		workflowId: persistedBinding.workflowId,
		attemptId: persistedBinding.attemptId,
		processGroupId: persistedBinding.processGroup.processGroupId,
		identityDigest: persistedBinding.processGroup.identityDigest,
		processStartId: persistedBinding.processGroup.processStartId,
		epochRef: epoch,
		markerDigest: digestObject({
			workflowId: persistedBinding.workflowId,
			attemptId: persistedBinding.attemptId,
			processGroupId: persistedBinding.processGroup.processGroupId,
			identityDigest: persistedBinding.processGroup.identityDigest,
			processStartId: persistedBinding.processGroup.processStartId,
			epochRef: epoch,
		}),
	};
	const platform: WorkflowProcessGroupPlatform = {
		spawn: async () => {
			throw new Error("not used");
		},
		inspect: async () => ({ identity: group(), verified: false, remainingPids: [], evidenceDigest: "evidence" }),
		signal: async () => undefined,
		reap: async () => ({ remainingPids: [], reapDigest: "reap" }),
		scanGroups: async () => [group()],
		quarantineSpawn: async () => undefined,
	};
	const ownedEvent: WorkflowRuntimeEventPayload = {
		kind: "workflow_process_group_owned",
		workflowId: persistedBinding.workflowId,
		attemptId: persistedBinding.attemptId,
		processGroup: persistedBinding.processGroup,
		epochRef: epoch,
	};
	const dependencies: WorkflowProcessGroupControllerDependencies = {
		workflowRoot: "/tmp/workflow-recovery-test",
		processStartId: () => persistedBinding.processGroup.processStartId,
		epochs: { assertCurrent: async (): Promise<void> => undefined },
		readCurrentStoreEpoch: async () => epoch.storeEpoch,
		platform,
		store: storeFor([ownedEvent]),
		workflowId: persistedBinding.workflowId,
		writerIdentity: lease.writerIdentity,
		resolveAttemptLeaseRef: async () => lease,
		launchReservationReader: {
			readLaunchReservation: async () => null,
			readLaunchReservationForSpawn: async () => null,
		},
		reserveProcessOwnership: async (input) => ({
			...input,
			reservationId: "reservation-recovery-test",
			reservationDigest: digestObject(input),
		}),
		bindProcessOwnership: async () => undefined,
		quarantineProcessOwnership: async () => undefined,
		readPersistedOwnershipMarkers: async () => [persistedMarker],
		readPersistedProcessBindings: async () => [persistedBinding],
		writePersistedOwnershipMarker: async () => undefined,
		admissionRegistry: {
			lookupByExecutionKey: async () => admissionFor(persistedBinding),
		},
	};
	const controller = createWorkflowProcessGroupController(dependencies);

	await controller.hydrateFromReplay();

	expect(await controller.verify(persistedBinding.processGroup)).toBe(false);
	expect(await controller.scanUnknownDescendants(persistedBinding.workflowId)).toMatchObject([
		{ pid: persistedBinding.processGroup.pid, processGroupId: persistedBinding.processGroup.processGroupId },
	]);
});

it("reserves ownership before spawn and kills/quarantines a bind race", async () => {
	const spawnedIdentity = {
		pid: 43,
		processStartId: "start-43",
		processGroupId: "group-43",
		platformGroupKind: "posix_process_group" as const,
		platformInspectionDigest: "platform-43",
	};
	const calls: string[] = [];
	const platform: WorkflowProcessGroupPlatform = {
		spawn: async () => {
			calls.push("spawn");
			return { pid: 43, identity: spawnedIdentity };
		},
		inspect: async () => ({ identity: group(), verified: false, remainingPids: [], evidenceDigest: "evidence" }),
		signal: async () => {
			calls.push("kill");
		},
		reap: async () => ({ remainingPids: [], reapDigest: "reap" }),
		scanGroups: async () => [],
		quarantineSpawn: async () => {
			calls.push("quarantine-spawn");
		},
	};
	const spawnInput = {
		request: {
			executable: process.execPath,
			arguments: [],
			cwd: process.cwd(),
			detached: true,
			requireProcessStartId: true,
			shell: false as const,
			env: { PATH: process.env.PATH ?? "" },
			networkPolicy: {
				mode: "deny" as const,
				allowedHosts: [],
				egressBytes: 0,
				enforcement: "host_verified" as const,
			},
		},
		workflowId: "workflow-recovery-test",
		rootSessionId: "root-race",
		taskId: "task-race",
		attemptId: "attempt-race",
		admissionId: "admission-race",
		childSessionId: "child-race",
		executionKey: "execution-race",
		nonce: "nonce-race",
		epochRef: epoch,
		head: { workflowId: "workflow-recovery-test", sequence: 0, eventDigest: null, epochRef: epoch },
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host",
		agentRole: "worker",
		modelId: "model",
		reasoningEffort: "medium",
		launchConfigDigest: "launch",
	};
	const dependencies: WorkflowProcessGroupControllerDependencies = {
		workflowRoot: "/tmp/workflow-recovery-test",
		processStartId: () => spawnedIdentity.processStartId,
		epochs: { assertCurrent: async (): Promise<void> => undefined },
		readCurrentStoreEpoch: async () => epoch.storeEpoch,
		platform,
		store: storeFor([]),
		workflowId: "workflow-recovery-test",
		writerIdentity: lease.writerIdentity,
		resolveAttemptLeaseRef: async () => lease,
		launchReservationReader: {
			readLaunchReservation: async () => null,
			readLaunchReservationForSpawn: async (input) => {
				const processGroupBase = {
					pid: spawnedIdentity.pid,
					processStartId: spawnedIdentity.processStartId,
					processGroupId: spawnedIdentity.processGroupId,
					parentPid: process.pid,
				};
				const processGroup = {
					...processGroupBase,
					identityDigest: digestObject(processGroupBase),
				};
				const childIdentity = {
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
				const unsigned = {
					reservationId: "launch-reservation-43",
					workflowId: input.workflowId,
					rootSessionId: input.rootSessionId,
					taskId: input.taskId,
					attemptId: input.attemptId,
					admissionId: input.admissionId,
					executionKey: input.executionKey,
					nonce: input.nonce,
					epochRef: input.epochRef,
					head: input.head,
					childIdentity,
					processGroup,
					currentProcessGroup: processGroup,
				};
				return { ...unsigned, reservationDigest: digestObject(unsigned) };
			},
		},
		reserveProcessOwnership: async (input) => {
			const unsigned = { reservationId: "reservation-43", ...input };
			return { ...unsigned, reservationDigest: digestObject(unsigned) };
		},
		bindProcessOwnership: async () => {
			calls.push("bind");
			throw new Error("ownership_race");
		},
		quarantineProcessOwnership: async () => {
			calls.push("quarantine-ownership");
		},
		readPersistedOwnershipMarkers: async () => [],
		readPersistedProcessBindings: async () => [],
		writePersistedOwnershipMarker: async () => undefined,
		admissionRegistry: {
			lookupByExecutionKey: async () =>
				({
					admissionId: spawnInput.admissionId,
					context: {
						workflowId: spawnInput.workflowId,
						rootSessionId: spawnInput.rootSessionId,
						taskId: spawnInput.taskId,
						attemptId: spawnInput.attemptId,
						executionKey: spawnInput.executionKey,
						epochRef: spawnInput.epochRef,
						runtimeVersion: spawnInput.runtimeVersion,
						hostCapabilityRevision: spawnInput.hostCapabilityRevision,
						agentRole: spawnInput.agentRole,
						modelId: spawnInput.modelId,
						reasoningEffort: spawnInput.reasoningEffort,
						launchConfigDigest: spawnInput.launchConfigDigest,
					} as never,
					status: "admitted",
					childIdentity: null,
					processBinding: null,
					terminalEventSequence: null,
				}) as never as WorkflowAdmissionResult,
		},
	};
	const controller = createWorkflowProcessGroupController(dependencies);
	const attempts = await Promise.allSettled([controller.spawn(spawnInput), controller.spawn(spawnInput)]);
	expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true);
	expect(calls.filter((call) => call === "spawn")).toHaveLength(1);
	expect(calls).toEqual(["spawn", "bind", "kill", "quarantine-spawn", "quarantine-ownership"]);
});
