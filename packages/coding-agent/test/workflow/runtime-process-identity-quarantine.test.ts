import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../../src/core/goals.js";
import type { WorkflowAdmissionResult } from "../../src/core/workflow/admission.js";

import type {
	WorkflowAutoResearchEventPayload,
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
	type WorkflowProcessOwnershipMarker,
	type WorkflowProcessOwnershipReservationInput,
} from "../../src/core/workflow/process-groups.js";
import type { WorkflowDeferredEventOwnerValidators } from "../../src/core/workflow/reducer.js";
import { createPersistedSessionWorkflowHost } from "../../src/core/workflow/session-host-factory.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const LEASE: WorkflowLeaseRef = {
	...EPOCH,
	leaseId: "lease-process-identity-quarantine",
	acquisitionEventSequence: 1,
	processIdentity: "process-process-identity-quarantine",
	rootDigest: "root-process-identity-quarantine",
	writerIdentity: "writer-process-identity-quarantine",
	acquiredAt: "2030-01-01T00:00:00.000Z",
	expiresAt: "2030-01-01T00:10:00.000Z",
};
const WORKFLOW_ID = "workflow-process-identity-quarantine";
const ROOT_SESSION_ID = "session-process-identity-quarantine";

function processGroupIdentity(child: ChildProcess): WorkflowProcessGroupIdentity {
	const pid = child.pid;
	if (pid === undefined) throw new Error("child pid unavailable");
	const processStartId = `test-start-${pid}`;
	const processGroupId = `test-group-${pid}`;
	const parentPid = process.pid;
	const unsigned = { pid, processStartId, processGroupId, parentPid };
	return { ...unsigned, identityDigest: digestObject(unsigned) };
}

function childBinding(processGroup: WorkflowProcessGroupIdentity): WorkflowChildProcessBinding {
	const childIdentityBase = {
		admissionId: "admission-process-identity-quarantine",
		childSessionId: "child-process-identity-quarantine",
		executionKey: "execution-process-identity-quarantine",
		epochRef: EPOCH,
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-process-identity-quarantine",
		agentRole: "worker",
		modelId: "model-process-identity-quarantine",
		reasoningEffort: "medium",
		launchConfigDigest: "launch-process-identity-quarantine",
		processGroupId: processGroup.processGroupId,
	};
	const childIdentity = {
		...childIdentityBase,
		identityDigest: canonicalWorkflowIdentityDigest(childIdentityBase),
	};
	return {
		workflowId: WORKFLOW_ID,
		taskId: "task-process-identity-quarantine",
		attemptId: "attempt-process-identity-quarantine",
		childIdentity,
		processGroup,
		bindingDigest: canonicalWorkflowBindingDigest({ childIdentity, processGroup }),
	};
}

function bindingWithAdmissionId(
	binding: WorkflowChildProcessBinding,
	admissionId: string,
): WorkflowChildProcessBinding {
	const { identityDigest: _identityDigest, ...unsignedChildIdentity } = binding.childIdentity;
	const childIdentity = {
		...unsignedChildIdentity,
		admissionId,
		identityDigest: canonicalWorkflowIdentityDigest({ ...unsignedChildIdentity, admissionId }),
	};
	return {
		...binding,
		childIdentity,
		bindingDigest: canonicalWorkflowBindingDigest({ childIdentity, processGroup: binding.processGroup }),
	};
}

function admissionFor(binding: WorkflowChildProcessBinding): WorkflowAdmissionResult {
	return {
		admissionId: binding.childIdentity.admissionId,
		context: {
			workflowId: binding.workflowId,
			rootSessionId: ROOT_SESSION_ID,
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

function persistedMarker(binding: WorkflowChildProcessBinding): WorkflowProcessOwnershipMarker {
	const unsigned = {
		workflowId: binding.workflowId,
		attemptId: binding.attemptId,
		processGroupId: binding.processGroup.processGroupId,
		identityDigest: binding.processGroup.identityDigest,
		processStartId: binding.processGroup.processStartId,
		epochRef: EPOCH,
	};
	return { ...unsigned, markerDigest: digestObject(unsigned) };
}

function storeFor(ownedEvent: WorkflowRuntimeEventPayload): WorkflowRuntimeStore {
	const identity: WorkflowRuntimeStoreIdentity = {
		storeKind: "workflow",
		namespace: "test",
		rootDir: "/tmp/workflow-process-identity-quarantine",
		storeId: "store-process-identity-quarantine",
		workflowId: WORKFLOW_ID,
		identityDigest: "store-process-identity-quarantine",
	};
	return {
		identity,
		commit: async <TPayload extends WorkflowEventPayload>(): Promise<WorkflowStoreCommitResult<TPayload>> =>
			undefined as unknown as WorkflowStoreCommitResult<TPayload>,
		replay: async (): Promise<WorkflowStoreReplayResult> => ({
			workflowId: WORKFLOW_ID,
			executionKey: null,
			events: [{ payload: ownedEvent, idempotencyKey: "owned-event" }] as never,
			head: { workflowId: WORKFLOW_ID, sequence: 1, eventDigest: digestObject(ownedEvent), epochRef: EPOCH },
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

function goalProjection(): { read(): GoalState; compareAndSwap(expected: GoalState, next: GoalState): boolean } {
	let state = emptyGoalState();
	return {
		read: () => structuredClone(state),
		compareAndSwap: (expected, next) => {
			if (digestObject(state) !== digestObject(expected)) return false;
			state = structuredClone(next);
			return true;
		},
	};
}

function deferredOwnerValidators(): WorkflowDeferredEventOwnerValidators {
	const validate = (
		payload: WorkflowAutoResearchEventPayload | WorkflowRuntimeEventPayload,
		event: { readonly workflowId: string; readonly eventDigest: string; readonly payload: unknown },
	): void => {
		if (
			payload.workflowId !== event.workflowId ||
			payload.kind !== (event.payload as { readonly kind?: unknown }).kind
		)
			throw new Error("workflow_recovery_owner_binding_mismatch");
		if (event.eventDigest.length === 0) throw new Error("workflow_recovery_event_digest_missing");
	};
	return { autoresearch: validate, runtime: validate, effect: validate, recovery: validate };
}

async function persistOwnedProcessGroup(
	host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>>,
	payload: Extract<WorkflowRuntimeEventPayload, { kind: "workflow_process_group_owned" }>,
): Promise<void> {
	const durable = host.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("persisted workflow store did not expose durable context");
	const replay = await host.runtimeStore.replay({
		workflowId: payload.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: payload.epochRef.storeEpoch,
	});
	const leaseRef = durable.currentLeaseRef();
	const idempotencyKey = `workflow-process-group-owned:${payload.attemptId}:${payload.processGroup.identityDigest}`;
	const baselineDigest = digestObject(replay.head);
	await host.runtimeStore.commit({
		workflowId: payload.workflowId,
		payload,
		expectedHead: replay.head,
		epochRef: payload.epochRef,
		leaseRef,
		idempotencyKey,
		writerIdentity: leaseRef.writerIdentity,
		executionKey: "execution-process-identity-quarantine",
		semanticBinding: {
			mutationId: idempotencyKey,
			baselineDigest,
			expectedGenerations: { workflow: payload.epochRef.storeEpoch },
			ownerId: leaseRef.writerIdentity,
			phase: "executing",
			reducerDigest: digestObject(payload),
			semanticHead: {
				workflowId: payload.workflowId,
				sequence: replay.head.sequence,
				eventDigest: replay.head.eventDigest,
				stateDigest: baselineDigest,
				epochRef: payload.epochRef,
				generation: payload.epochRef.storeEpoch,
			},
			expectedHead: replay.head,
			idempotencyKey,
			executionKey: "execution-process-identity-quarantine",
			writerIdentity: leaseRef.writerIdentity,
			leaseRef,
			epochRef: payload.epochRef,
		},
	});
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForLive(child: ChildProcess): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error("child exited early");
		if (child.pid !== undefined && isProcessAlive(child.pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("child did not become live");
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.pid === undefined || !isProcessAlive(child.pid)) return;
	child.kill("SIGKILL");
	await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function controllerFor(
	binding: WorkflowChildProcessBinding,
	quarantineSpawn: (argument: number | WorkflowProcessGroupIdentity, reason: string) => Promise<void>,
	authoritativeBinding: WorkflowChildProcessBinding = binding,
): ReturnType<typeof createWorkflowProcessGroupController> {
	const ownedEvent: WorkflowRuntimeEventPayload = {
		kind: "workflow_process_group_owned",
		workflowId: WORKFLOW_ID,
		attemptId: binding.attemptId,
		processGroup: binding.processGroup,
		epochRef: EPOCH,
	};
	const marker = persistedMarker(binding);
	const platform: WorkflowProcessGroupPlatform = {
		spawn: async () => {
			throw new Error("spawn not used");
		},
		inspect: async (pid, processStartId, processGroupId, expectedGroupIdentityDigest) => ({
			identity: binding.processGroup,
			verified:
				pid === binding.processGroup.pid &&
				processStartId === binding.processGroup.processStartId &&
				processGroupId === binding.processGroup.processGroupId &&
				expectedGroupIdentityDigest === binding.processGroup.identityDigest &&
				isProcessAlive(pid),
			remainingPids: isProcessAlive(pid) ? [pid] : [],
			evidenceDigest: digestObject({ pid, processStartId, processGroupId, expectedGroupIdentityDigest }),
		}),
		signal: async () => undefined,
		reap: async () => ({ remainingPids: [], reapDigest: "reap" }),
		scanGroups: async () => [],
		quarantineSpawn,
	};
	const dependencies = {
		workflowRoot: "/tmp/workflow-process-identity-quarantine",
		processStartId: (pid: number) =>
			pid === binding.processGroup.pid ? binding.processGroup.processStartId : undefined,
		epochs: { assertCurrent: async (): Promise<void> => undefined },
		readCurrentStoreEpoch: async () => EPOCH.storeEpoch,
		platform,
		store: storeFor(ownedEvent),
		workflowId: WORKFLOW_ID,
		writerIdentity: LEASE.writerIdentity,
		resolveAttemptLeaseRef: async () => LEASE,
		reserveProcessOwnership: async (input: WorkflowProcessOwnershipReservationInput) => ({
			...input,
			reservationId: "reservation-process-identity-quarantine",
			reservationDigest: digestObject(input),
		}),
		bindProcessOwnership: async () => undefined,
		quarantineProcessOwnership: async () => undefined,
		readPersistedOwnershipMarkers: async () => [marker],
		readPersistedProcessBindings: async () => [binding],
		writePersistedOwnershipMarker: async () => undefined,
		admissionRegistry: {
			lookupByExecutionKey: async () => admissionFor(authoritativeBinding),
		},
	} as unknown as WorkflowProcessGroupControllerDependencies;
	return createWorkflowProcessGroupController(dependencies);
}

describe("workflow process identity quarantine", () => {
	it("rejects a foreign or partial identity without touching a live child", async () => {
		if (process.platform === "win32") return;
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: process.cwd(),
			detached: true,
			stdio: "ignore",
		});
		try {
			await waitForLive(child);
			const processGroup = processGroupIdentity(child);
			const binding = childBinding(processGroup);
			const controller = controllerFor(binding, async (argument) => {
				const pid = typeof argument === "number" ? argument : argument.pid;
				process.kill(pid, "SIGKILL");
			});
			const { identityDigest: _identityDigest, ...unsignedProcessGroup } = processGroup;
			const foreignBase = { ...unsignedProcessGroup, processGroupId: `${processGroup.processGroupId}-foreign` };
			const foreignIdentity = {
				...foreignBase,
				identityDigest: canonicalWorkflowProcessGroupDigest(foreignBase),
			};
			const staleBase = { ...unsignedProcessGroup, processStartId: `${processGroup.processStartId}-stale` };
			const staleIdentity = {
				...staleBase,
				identityDigest: canonicalWorkflowProcessGroupDigest(staleBase),
			};

			await expect(controller.quarantine(foreignIdentity, "foreign_identity")).rejects.toMatchObject({
				code: "workflow_process_group_binding_missing",
			});
			await expect(controller.quarantine(staleIdentity, "stale_identity")).rejects.toMatchObject({
				code: "workflow_process_group_binding_missing",
			});
			await expect(
				controller.quarantine({ pid: processGroup.pid } as never, "partial_identity"),
			).rejects.toMatchObject({ code: "workflow_process_identity_invalid" });
			expect(isProcessAlive(processGroup.pid)).toBe(true);
		} finally {
			await stopChild(child);
		}
	});

	it("keeps a valid identity enforceable after controller restart and forwards all identity fields", async () => {
		if (process.platform === "win32") return;
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: process.cwd(),
			detached: true,
			stdio: "ignore",
		});
		try {
			await waitForLive(child);
			const processGroup = processGroupIdentity(child);
			const binding = childBinding(processGroup);
			let forwarded: number | WorkflowProcessGroupIdentity | undefined;
			const quarantineSpawn = async (
				argument: number | WorkflowProcessGroupIdentity,
				_reason: string,
			): Promise<void> => {
				forwarded = argument;
				if (typeof argument !== "object") return;
				if (
					argument.pid !== processGroup.pid ||
					argument.processStartId !== processGroup.processStartId ||
					argument.processGroupId !== processGroup.processGroupId ||
					argument.parentPid !== processGroup.parentPid ||
					argument.identityDigest !== processGroup.identityDigest
				)
					throw new Error("quarantine identity was narrowed");
				process.kill(argument.pid, "SIGKILL");
			};
			const initialController = controllerFor(binding, async () => {
				throw new Error("initial controller must not quarantine during hydration");
			});
			await initialController.hydrateFromReplay();
			const restartedController = controllerFor(binding, quarantineSpawn);

			await restartedController.quarantine(processGroup, "restart_recovery");

			expect(forwarded).toEqual(processGroup);
			for (let attempt = 0; attempt < 50 && isProcessAlive(processGroup.pid); attempt += 1)
				await new Promise((resolve) => setTimeout(resolve, 10));
			expect(isProcessAlive(processGroup.pid)).toBe(false);
		} finally {
			await stopChild(child);
		}
	});

	it("rejects a replay with the same attempt and execution but a different child session", async () => {
		if (process.platform === "win32") return;
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: process.cwd(),
			detached: true,
			stdio: "ignore",
		});
		try {
			await waitForLive(child);
			const processGroup = processGroupIdentity(child);
			const binding = childBinding(processGroup);
			const controller = controllerFor(binding, async () => {
				throw new Error("replay mismatch must not spawn");
			});

			await expect(
				controller.spawn({
					request: {
						executable: process.execPath,
						arguments: [],
						cwd: process.cwd(),
						detached: true,
						requireProcessStartId: true,
						shell: false,
						env: { PATH: process.env.PATH ?? "" },
						networkPolicy: { mode: "deny", allowedHosts: [], egressBytes: 0, enforcement: "host_verified" },
					},
					workflowId: binding.workflowId,
					rootSessionId: ROOT_SESSION_ID,
					taskId: binding.taskId,
					attemptId: binding.attemptId,
					admissionId: binding.childIdentity.admissionId,
					childSessionId: "child-session-replayed-foreign",
					executionKey: binding.childIdentity.executionKey,
					nonce: "nonce-process-identity-quarantine",
					epochRef: binding.childIdentity.epochRef,
					head: {
						workflowId: binding.workflowId,
						sequence: 1,
						eventDigest: digestObject({ kind: "workflow_process_group_owned", binding }),
						epochRef: binding.childIdentity.epochRef,
					},
					runtimeVersion: binding.childIdentity.runtimeVersion,
					hostCapabilityRevision: binding.childIdentity.hostCapabilityRevision,
					agentRole: binding.childIdentity.agentRole,
					modelId: binding.childIdentity.modelId,
					reasoningEffort: binding.childIdentity.reasoningEffort,
					launchConfigDigest: binding.childIdentity.launchConfigDigest,
				}),
			).rejects.toMatchObject({ code: "workflow_process_spawn_replay_mismatch" });
			expect(isProcessAlive(processGroup.pid)).toBe(true);
		} finally {
			await stopChild(child);
		}
	});

	it("rejects a forged admission from persisted replay after store and controller restart", async () => {
		if (process.platform === "win32") return;
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-process-identity-store-"));
		const projection = goalProjection();
		const bindingPath = join(artifactRoot, "process-binding.json");
		const workflowId = WORKFLOW_ID;
		const rootSessionId = "session-process-identity-store";
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: process.cwd(),
			detached: true,
			stdio: "ignore",
		});
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		let reopened: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			await waitForLive(child);
			const processGroup = processGroupIdentity(child);
			const authoritativeBinding = childBinding(processGroup);
			const persistedBinding = bindingWithAdmissionId(authoritativeBinding, "admission-foreign");
			const persistedEvent: WorkflowRuntimeEventPayload = {
				kind: "workflow_process_group_owned",
				workflowId,
				attemptId: persistedBinding.attemptId,
				processGroup: persistedBinding.processGroup,
				epochRef: EPOCH,
			};
			const fixture = {
				binding: persistedBinding,
				marker: persistedMarker(persistedBinding),
				admission: admissionFor(authoritativeBinding),
			};
			await writeFile(bindingPath, JSON.stringify(fixture), "utf8");
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: projection,
				genesisEpoch: EPOCH,
				deferredOwnerValidators: deferredOwnerValidators(),
			});
			await host.execute({
				kind: "start",
				request: {
					workflowId,
					objective: "persist a process identity",
					acceptanceChecks: ["foreign identities remain untouched"],
					protectedInvariants: ["admission identity remains authoritative"],
				},
			});
			const durable = host.runtimeStore.durableContext;
			if (durable === undefined) throw new Error("persisted workflow store did not expose durable context");
			const leaseRef = durable.currentLeaseRef();
			await persistOwnedProcessGroup(host, persistedEvent);
			await host.dispose?.();
			host = undefined;
			reopened = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: projection,
				genesisEpoch: EPOCH,
				deferredOwnerValidators: deferredOwnerValidators(),
			});
			const readFixture = async () => JSON.parse(await readFile(bindingPath, "utf8")) as typeof fixture;
			let quarantineCalls = 0;
			const platform: WorkflowProcessGroupPlatform = {
				spawn: async () => {
					throw new Error("spawn not used");
				},
				inspect: async (pid, processStartId, processGroupId, expectedGroupIdentityDigest) => ({
					identity: persistedBinding.processGroup,
					verified:
						pid === persistedBinding.processGroup.pid &&
						processStartId === persistedBinding.processGroup.processStartId &&
						processGroupId === persistedBinding.processGroup.processGroupId &&
						expectedGroupIdentityDigest === persistedBinding.processGroup.identityDigest &&
						isProcessAlive(pid),
					remainingPids: [pid],
					evidenceDigest: digestObject({ pid, processStartId, processGroupId, expectedGroupIdentityDigest }),
				}),
				signal: async () => undefined,
				reap: async () => ({ remainingPids: [], reapDigest: "reap" }),
				scanGroups: async () => [],
				quarantineSpawn: async () => {
					quarantineCalls += 1;
				},
			};
			const dependencies: WorkflowProcessGroupControllerDependencies = {
				workflowRoot: artifactRoot,
				processStartId: (pid) => (pid === processGroup.pid ? processGroup.processStartId : undefined),
				epochs: { assertCurrent: async (): Promise<void> => undefined },
				readCurrentStoreEpoch: async () => EPOCH.storeEpoch,
				platform,
				store: reopened.runtimeStore,
				workflowId,
				writerIdentity: leaseRef.writerIdentity,
				resolveAttemptLeaseRef: async () => leaseRef,
				launchReservationReader: {
					readLaunchReservation: async () => null,
					readLaunchReservationForSpawn: async () => null,
				},
				reserveProcessOwnership: async (input) => ({
					...input,
					reservationId: "unused",
					reservationDigest: digestObject(input),
				}),
				bindProcessOwnership: async () => undefined,
				quarantineProcessOwnership: async () => undefined,
				readPersistedOwnershipMarkers: async () => [(await readFixture()).marker],
				readPersistedProcessBindings: async () => [(await readFixture()).binding],
				writePersistedOwnershipMarker: async () => undefined,
				admissionRegistry: {
					lookupByExecutionKey: async (checkedWorkflowId, executionKey) => {
						const admission = (await readFixture()).admission;
						return checkedWorkflowId === workflowId && admission.context.executionKey === executionKey
							? admission
							: undefined;
					},
				},
			};
			const controller = createWorkflowProcessGroupController(dependencies);
			await expect(controller.quarantine(processGroup, "foreign_admission")).rejects.toMatchObject({
				code: "workflow_process_admission_binding_missing",
			});
			expect(quarantineCalls).toBe(0);
			expect(isProcessAlive(processGroup.pid)).toBe(true);
		} finally {
			await stopChild(child);
			await reopened?.dispose?.();
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("rejects a persisted binding whose admission identity is not authoritative", async () => {
		if (process.platform === "win32") return;
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: process.cwd(),
			detached: true,
			stdio: "ignore",
		});
		try {
			await waitForLive(child);
			const processGroup = processGroupIdentity(child);
			const authoritativeBinding = childBinding(processGroup);
			const forgedBinding = bindingWithAdmissionId(authoritativeBinding, "admission-foreign");
			const controller = controllerFor(
				forgedBinding,
				async (argument) => {
					process.kill(typeof argument === "number" ? argument : argument.pid, "SIGKILL");
				},
				authoritativeBinding,
			);

			await expect(controller.quarantine(processGroup, "foreign_admission")).rejects.toMatchObject({
				code: "workflow_process_admission_binding_missing",
			});
			expect(isProcessAlive(processGroup.pid)).toBe(true);
		} finally {
			await stopChild(child);
		}
	});
});
