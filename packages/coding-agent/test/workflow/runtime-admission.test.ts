import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../../src/core/goals.js";
import {
	assertWorkflowChildBinding,
	assertWorkflowOutcomeAdmissionBinding,
	canonicalWorkflowBindingDigest,
	canonicalWorkflowIdentityDigest,
	commitAuthenticated,
	createWorkflowAdmissionBindingConsumption,
	createWorkflowAdmissionRegistry,
	deriveWorkflowAdmissionBindingNonce,
	deriveWorkflowExecutionKey,
	digestWorkflowOutcome,
	hydrateAdmissionFromReplay,
	isWorkflowPhaseOutcomeRecord,
	type WorkflowAdmissionBindingConsumption,
	type WorkflowAdmissionLaunchReservation,
	type WorkflowAdmissionLaunchReservationReader,
	type WorkflowAdmissionRegistry,
	type WorkflowAdmissionRegistryDependencies,
	WorkflowDispatchError,
	type WorkflowInternalAdmissionContext,
	type WorkflowOutcomeAdmissionBinding,
} from "../../src/core/workflow/admission.js";
import type {
	WorkflowArtifactRef,
	WorkflowChildAuthority,
	WorkflowChildIdentity,
	WorkflowChildProcessBinding,
	WorkflowControlCapacityVector,
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalCommit,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowPhaseOutcome,
	WorkflowPhaseOutcomeRecord,
	WorkflowRevisionBoundaryContext,
	WorkflowRevisionTuple,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreIdentity,
	WorkflowStoreCommitInput,
	WorkflowStoreCommitResult,
} from "../../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject, sha256Hex } from "../../src/core/workflow/contracts.js";
import {
	readVerifiedWorkflowProcessGroupIdentity,
	type WorkflowProcessContainmentVerifier,
} from "../../src/core/workflow/process-groups.js";
import { createPersistedSessionWorkflowHost } from "../../src/core/workflow/session-host-factory.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const CONTROL_CAPACITY: WorkflowControlCapacityVector = {
	processSlots: 1,
	childSessionSlots: 1,
	modelCallSlots: 1,
	modelInputTokens: 10,
	modelOutputTokens: 10,
	verificationSlots: 0,
	redTeamSlots: 0,
	recoverySlots: 0,
};
const REVISION_TUPLE: WorkflowRevisionTuple = {
	contractRevision: 1,
	scorecardRevision: 1,
	planRevision: 1,
	configRevision: 1,
	evidenceRevision: 1,
};

it("commits one stable dispatch intent before any child binding", async () => {
	const workflowId = "workflow-admission-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context);

	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);

	expect(admitted.status).toBe("admitted");
	expect(admitted.context.executionKey).toBe(context.executionKey);
	expect(store.payloads.map((payload) => payload.kind)).toEqual(["workflow_dispatch_intent"]);
	expect(store.payloads[0]).toMatchObject({
		kind: "workflow_dispatch_intent",
		workflowId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
	});
});

it("derives execution keys from the immutable dispatch tuple and de-duplicates the intent", async () => {
	const workflowId = "workflow-admission-key-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context);

	expect(context.executionKey).toBe(
		sha256Hex(
			`${workflowId}:${context.taskId}:${context.attemptId}:${context.decisionRef.decisionDigest}:${context.launchConfigDigest}`,
		),
	);
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const first = await registry.admit(context);
	const second = await registry.admit(context);

	expect(second.admissionId).toBe(first.admissionId);
	expect(store.payloads).toHaveLength(1);
	await expect(registry.admit({ ...context, expectedEffectDigest: "different-effect" })).rejects.toMatchObject({
		code: "workflow_admission_conflict",
	});
	expect(store.payloads.map((payload) => payload.kind)).toEqual([
		"workflow_dispatch_intent",
		"workflow_lease_quarantined",
	]);
});

it("rejects every child binding identity mismatch before committing a binding", async () => {
	const workflowId = "workflow-child-binding-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context);
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);
	const valid = createChildBinding(context);
	expect(() =>
		assertWorkflowChildBinding(
			{
				workflowId: context.workflowId,
				taskId: context.taskId,
				attemptId: context.attemptId,
				admissionId: admitted.admissionId,
				executionKey: context.executionKey,
				epochRef: context.epochRef,
				launchConfigDigest: context.launchConfigDigest,
			},
			valid,
		),
	).not.toThrow();

	const cases: readonly [string, WorkflowChildProcessBinding, string][] = [
		["workflow", { ...valid, workflowId: "other-workflow" }, "workflow_child_binding_invalid"],
		["attempt", { ...valid, attemptId: "other-attempt" }, "workflow_child_binding_invalid"],
		[
			"execution",
			createChildBinding(context, { identity: { executionKey: "other-execution" } }),
			"workflow_child_binding_invalid",
		],
		[
			"epoch",
			createChildBinding(context, { identity: { epochRef: { storeEpoch: 1, coordinatorEpoch: 2 } } }),
			"workflow_epoch_stale",
		],
		[
			"identity digest",
			{ ...valid, childIdentity: { ...valid.childIdentity, identityDigest: "wrong" } },
			"workflow_child_binding_invalid",
		],
		[
			"process digest",
			{ ...valid, processGroup: { ...valid.processGroup, identityDigest: "wrong" } },
			"workflow_child_binding_invalid",
		],
		["binding digest", { ...valid, bindingDigest: "wrong" }, "workflow_child_binding_invalid"],
	];

	for (const [label, binding, code] of cases) {
		await expect(registry.bindChild(admitted.admissionId, binding), label).rejects.toMatchObject({ code });
		expect(store.payloads).toHaveLength(1);
	}
});

it("quarantines a missing process-start identity and never admits a child", async () => {
	const workflowId = "workflow-child-quarantine-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context);
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);
	const invalid = createChildBinding(context, { processGroup: { processStartId: "" } });

	await expect(registry.bindChild(admitted.admissionId, invalid)).rejects.toMatchObject({
		code: "workflow_child_identity_unavailable",
	});
	expect((await registry.lookupByExecutionKey(workflowId, context.executionKey))?.status).toBe("quarantined");
	expect(store.payloads.map((payload) => payload.kind)).toEqual([
		"workflow_dispatch_intent",
		"workflow_lease_quarantined",
	]);
});

it("does not resurrect a quarantined admission with a later child binding", async () => {
	const workflowId = "workflow-child-quarantine-resurrection-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context);
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);
	await expect(
		registry.bindChild(admitted.admissionId, createChildBinding(context, { processGroup: { processStartId: "" } })),
	).rejects.toMatchObject({ code: "workflow_child_identity_unavailable" });

	await expect(registry.bindChild(admitted.admissionId, createChildBinding(context))).rejects.toMatchObject({
		code: "workflow_attempt_transition_invalid",
	});
	expect(store.payloads.map((payload) => payload.kind)).toEqual([
		"workflow_dispatch_intent",
		"workflow_lease_quarantined",
	]);
});

it("rejects an unstructured host launch reservation before binding a child", async () => {
	const workflowId = "workflow-process-proof-rejection-test";
	const context = createContext(workflowId);

	for (const invalidReservation of [undefined, true] as const) {
		const store = createRecordingStore(workflowId, EPOCH);
		const registry = createRegistry(store, workflowId, context, {
			launchReservationReader: {
				readLaunchReservation: async () => invalidReservation as never,
			} as unknown as WorkflowAdmissionLaunchReservationReader,
		});
		await registry.hydrateFromReplay();
		await registry.hydrateQuarantineFromReplay();
		const admitted = await registry.admit(context);

		await expect(registry.bindChild(admitted.admissionId, createChildBinding(context))).rejects.toMatchObject({
			code: "workflow_child_process_unverified",
		});
		expect(store.payloads.map((payload) => payload.kind)).toEqual(["workflow_dispatch_intent"]);
	}
});

it("requires a host launch reservation to bind the root session identity", async () => {
	const workflowId = "workflow-process-proof-root-session-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context, {
		launchReservationReader: createSyntheticLaunchReservationReader("foreign-root-session"),
	});
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);

	await expect(registry.bindChild(admitted.admissionId, createChildBinding(context))).rejects.toMatchObject({
		code: "workflow_child_process_unverified",
	});
	expect(store.payloads.map((payload) => payload.kind)).toEqual(["workflow_dispatch_intent"]);
});

it("rejects a containment observation that does not independently match the launch reservation", async () => {
	const workflowId = "workflow-process-proof-independent-read-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const verifier: WorkflowProcessContainmentVerifier = {
		readCurrentHostIdentity: async () => ({
			pid: process.pid,
			processStartId: "host-start",
			processGroupId: "host-group",
			parentPid: process.pid,
			identityDigest: digestObject({
				pid: process.pid,
				processStartId: "host-start",
				processGroupId: "host-group",
				parentPid: process.pid,
			}),
		}),
		verify: async (identity) => ({
			identity: { ...identity, processStartId: "wrong-start" },
			verified: true,
			remainingPids: [identity.pid],
			evidenceDigest: "wrong-observation",
		}),
	};
	const registry = createRegistry(store, workflowId, context, { processContainmentVerifier: verifier });
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);

	await expect(registry.bindChild(admitted.admissionId, createChildBinding(context))).rejects.toMatchObject({
		code: "workflow_child_process_unverified",
	});
	expect(store.payloads.map((payload) => payload.kind)).toEqual(["workflow_dispatch_intent"]);
});

it("rejects live child metadata copied from a foreign workflow launch", async () => {
	const workflowId = "workflow-process-proof-foreign-metadata-test";
	const context = createContext(workflowId);
	const foreignContext = createContext("foreign-workflow-process-proof");
	const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	});
	try {
		if (child.pid === undefined) throw new Error("child process did not expose a pid");
		let identity: Awaited<ReturnType<typeof readVerifiedWorkflowProcessGroupIdentity>> = null;
		for (let attempt = 0; attempt < 100 && identity === null; attempt += 1) {
			identity = await readVerifiedWorkflowProcessGroupIdentity(child.pid);
			if (identity === null) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (identity === null) {
			const store = createRecordingStore(workflowId, EPOCH);
			const registry = createRegistry(store, workflowId, context, {
				processContainmentVerifier: createTestProcessContainmentVerifier(),
			});
			await registry.hydrateFromReplay();
			await registry.hydrateQuarantineFromReplay();
			const admitted = await registry.admit(context);
			await expect(
				registry.bindChild(
					admitted.admissionId,
					createChildBinding(context, {
						processGroup: {
							pid: child.pid,
							processStartId: "unsupported-start",
							processGroupId: "unsupported-group",
						},
						identity: { childSessionId: "foreign-child-session" },
					}),
				),
			).rejects.toMatchObject({ code: "workflow_child_process_unverified" });
			expect(store.payloads.map((payload) => payload.kind)).toEqual(["workflow_dispatch_intent"]);
			return;
		}
		const foreign = createChildBinding(foreignContext, {
			processGroup: identity,
			identity: {
				launchConfigDigest: context.launchConfigDigest,
				childSessionId: "foreign-child-session",
				runtimeVersion: "0.147.0-alpha.10",
				hostCapabilityRevision: "host-a",
				agentRole: "worker",
				modelId: "model-a",
				reasoningEffort: "medium",
			},
		});
		const binding = {
			...foreign,
			workflowId,
			taskId: context.taskId,
			attemptId: context.attemptId,
			childIdentity: {
				...foreign.childIdentity,
				admissionId: `admission:${context.executionKey}`,
				executionKey: context.executionKey,
				epochRef: context.epochRef,
				launchConfigDigest: context.launchConfigDigest,
				identityDigest: canonicalWorkflowIdentityDigest({
					...foreign.childIdentity,
					admissionId: `admission:${context.executionKey}`,
					executionKey: context.executionKey,
					epochRef: context.epochRef,
					launchConfigDigest: context.launchConfigDigest,
				}),
			},
		};
		const validBinding = {
			...binding,
			bindingDigest: canonicalWorkflowBindingDigest(binding),
		};
		const store = createRecordingStore(workflowId, EPOCH);
		const registry = createRegistry(store, workflowId, context, {
			processContainmentVerifier: createTestProcessContainmentVerifier(),
			launchReservationReader: createHostBackedLaunchReservationReader(),
		});
		await registry.hydrateFromReplay();
		await registry.hydrateQuarantineFromReplay();
		const admitted = await registry.admit(context);

		await expect(registry.bindChild(admitted.admissionId, validBinding)).rejects.toMatchObject({
			code: "workflow_child_process_unverified",
		});
		expect(store.payloads.map((payload) => payload.kind)).toEqual(["workflow_dispatch_intent"]);
	} finally {
		child.kill("SIGTERM");
		child.unref();
	}
});

it("rejects a replay that tries to apply the same-head child binding twice", async () => {
	const workflowId = "workflow-process-proof-replay-consumption-test";
	const context = createContext(workflowId);
	const dispatch = createReplayCommit(context);
	const binding = createChildBinding(context);
	const childPayload: Extract<WorkflowEventPayload, { kind: "workflow_child_identity_bound" }> = {
		kind: "workflow_child_identity_bound",
		workflowId,
		attemptId: context.attemptId,
		admissionId: `admission:${context.executionKey}`,
		identity: binding.childIdentity,
		processBinding: binding,
		epochRef: context.epochRef,
	};
	const bindingCommit = createReplayEvent(dispatch, childPayload, {
		sequence: 2,
		expectedHead: { workflowId, sequence: 1, eventDigest: dispatch.eventDigest, epochRef: context.epochRef },
		eventDigest: "bound-event",
	});
	const duplicateCommit = {
		...bindingCommit,
		sequence: 3,
		priorEventDigest: bindingCommit.eventDigest,
		eventDigest: "duplicate-bound-event",
	};
	const bindingConsumption = createMemoryBindingConsumption();
	await bindingConsumption.consume({
		workflowId,
		admissionId: `admission:${context.executionKey}`,
		bindingDigest: canonicalWorkflowBindingDigest(binding),
		expectedHead: bindingCommit.expectedHead,
		nonce: deriveWorkflowAdmissionBindingNonce({
			workflowId,
			admissionId: `admission:${context.executionKey}`,
			epochRef: context.epochRef,
			head: bindingCommit.expectedHead,
			binding,
		}),
	});

	await expect(
		hydrateAdmissionFromReplay({
			commits: [dispatch, bindingCommit, duplicateCommit],
			activeLease: {
				workflowId,
				epochRef: context.epochRef,
				leaseRef: context.resourceLeaseRef,
				writerIdentity: context.writerIdentity,
				generationId: "generation",
				revisionBoundary: createBoundary(workflowId, context),
			},
			contextReader: { readAdmissionContext: async () => context },
			processContainmentVerifier: createSyntheticProcessContainmentVerifier(),
			launchReservationReader: createSyntheticLaunchReservationReader(),
			bindingConsumption,
			persistQuarantine: async () => undefined,
		}),
	).rejects.toMatchObject({ code: "workflow_admission_replay_invalid" });
});

it("rejects replayed bindings with foreign task and child authority metadata", async () => {
	const workflowId = "workflow-process-proof-replay-foreign-binding-test";
	const context = createContext(workflowId);
	const dispatch = createReplayCommit(context);
	const foreignBinding = createChildBinding(context, {
		identity: {
			childSessionId: "foreign-child-session",
			modelId: "foreign-model",
			launchConfigDigest: "foreign-launch",
		},
	});
	const childPayload: Extract<WorkflowEventPayload, { kind: "workflow_child_identity_bound" }> = {
		kind: "workflow_child_identity_bound",
		workflowId,
		attemptId: context.attemptId,
		admissionId: `admission:${context.executionKey}`,
		identity: foreignBinding.childIdentity,
		processBinding: { ...foreignBinding, taskId: "foreign-task" },
		epochRef: context.epochRef,
	};
	const bindingCommit = createReplayEvent(dispatch, childPayload, {
		sequence: 2,
		expectedHead: { workflowId, sequence: 1, eventDigest: dispatch.eventDigest, epochRef: context.epochRef },
		eventDigest: "foreign-bound-event",
	});

	await expect(
		hydrateAdmissionFromReplay({
			commits: [dispatch, bindingCommit],
			activeLease: {
				workflowId,
				epochRef: context.epochRef,
				leaseRef: context.resourceLeaseRef,
				writerIdentity: context.writerIdentity,
				generationId: "generation",
				revisionBoundary: createBoundary(workflowId, context),
			},
			contextReader: { readAdmissionContext: async () => context },
			processContainmentVerifier: createSyntheticProcessContainmentVerifier(),
			launchReservationReader: createSyntheticLaunchReservationReader(),
			bindingConsumption: createMemoryBindingConsumption(),
			persistQuarantine: async () => undefined,
		}),
	).rejects.toMatchObject({ code: "workflow_child_binding_invalid" });
});

it("rejects a replayed child event when its identity does not equal its process binding", async () => {
	const workflowId = "workflow-process-proof-replay-identity-mismatch-test";
	const context = createContext(workflowId);
	const dispatch = createReplayCommit(context);
	const binding = createChildBinding(context);
	const mismatchedIdentityBase = { ...binding.childIdentity, childSessionId: "different-child-session" };
	const mismatchedIdentity = {
		...mismatchedIdentityBase,
		identityDigest: canonicalWorkflowIdentityDigest(mismatchedIdentityBase),
	};
	const childPayload: Extract<WorkflowEventPayload, { kind: "workflow_child_identity_bound" }> = {
		kind: "workflow_child_identity_bound",
		workflowId,
		attemptId: context.attemptId,
		admissionId: `admission:${context.executionKey}`,
		identity: mismatchedIdentity,
		processBinding: binding,
		epochRef: context.epochRef,
	};
	const bindingCommit = createReplayEvent(dispatch, childPayload, {
		sequence: 2,
		expectedHead: { workflowId, sequence: 1, eventDigest: dispatch.eventDigest, epochRef: context.epochRef },
		eventDigest: "mismatched-identity-event",
	});

	await expect(
		hydrateAdmissionFromReplay({
			commits: [dispatch, bindingCommit],
			activeLease: {
				workflowId,
				epochRef: context.epochRef,
				leaseRef: context.resourceLeaseRef,
				writerIdentity: context.writerIdentity,
				generationId: "generation",
				revisionBoundary: createBoundary(workflowId, context),
			},
			contextReader: { readAdmissionContext: async () => context },
			processContainmentVerifier: createSyntheticProcessContainmentVerifier(),
			launchReservationReader: createSyntheticLaunchReservationReader(),
			bindingConsumption: createMemoryBindingConsumption(),
			persistQuarantine: async () => undefined,
		}),
	).rejects.toMatchObject({ code: "workflow_admission_replay_invalid" });
});

it("rejects a replayed child event after the admission is quarantined", async () => {
	const workflowId = "workflow-process-proof-replay-quarantine-test";
	const context = createContext(workflowId);
	const dispatch = createReplayCommit(context);
	const quarantinePayload: Extract<WorkflowEventPayload, { kind: "workflow_lease_quarantined" }> = {
		kind: "workflow_lease_quarantined",
		workflowId,
		leaseRef: context.resourceLeaseRef,
		epochRef: context.epochRef,
		reason: "workflow_child_process_unverified:quarantine-evidence",
	};
	const quarantineCommit = createReplayEvent(dispatch, quarantinePayload, {
		sequence: 2,
		expectedHead: { workflowId, sequence: 1, eventDigest: dispatch.eventDigest, epochRef: context.epochRef },
		eventDigest: "quarantine-event",
	});
	const binding = createChildBinding(context);
	const childPayload: Extract<WorkflowEventPayload, { kind: "workflow_child_identity_bound" }> = {
		kind: "workflow_child_identity_bound",
		workflowId,
		attemptId: context.attemptId,
		admissionId: `admission:${context.executionKey}`,
		identity: binding.childIdentity,
		processBinding: binding,
		epochRef: context.epochRef,
	};
	const childCommit = createReplayEvent(quarantineCommit, childPayload, {
		sequence: 3,
		expectedHead: { workflowId, sequence: 2, eventDigest: quarantineCommit.eventDigest, epochRef: context.epochRef },
		eventDigest: "child-after-quarantine-event",
	});

	await expect(
		hydrateAdmissionFromReplay({
			commits: [dispatch, quarantineCommit, childCommit],
			activeLease: {
				workflowId,
				epochRef: context.epochRef,
				leaseRef: context.resourceLeaseRef,
				writerIdentity: context.writerIdentity,
				generationId: "generation",
				revisionBoundary: createBoundary(workflowId, context),
			},
			contextReader: { readAdmissionContext: async () => context },
			processContainmentVerifier: createSyntheticProcessContainmentVerifier(),
			launchReservationReader: createSyntheticLaunchReservationReader(),
			bindingConsumption: createMemoryBindingConsumption(),
			persistQuarantine: async () => undefined,
		}),
	).rejects.toMatchObject({ code: "workflow_admission_replay_invalid" });
});

it("accepts a live process-start proof through the production identity seam or fails closed when unsupported", async () => {
	const workflowId = "workflow-process-proof-test";
	const context = createContext(workflowId);
	const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	});
	try {
		if (child.pid === undefined) throw new Error("child process did not expose a pid");
		let identity: Awaited<ReturnType<typeof readVerifiedWorkflowProcessGroupIdentity>> = null;
		for (let attempt = 0; attempt < 100 && identity === null; attempt += 1) {
			identity = await readVerifiedWorkflowProcessGroupIdentity(child.pid);
			if (identity === null) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const binding = createChildBinding(context, {
			processGroup:
				identity === null
					? { pid: child.pid, processStartId: "unsupported-start", processGroupId: "unsupported-group" }
					: {
							pid: identity.pid,
							processStartId: identity.processStartId,
							processGroupId: identity.processGroupId,
							parentPid: identity.parentPid,
						},
		});
		const store = createRecordingStore(workflowId, EPOCH);
		const registry = createRegistry(store, workflowId, context, {
			processContainmentVerifier: createTestProcessContainmentVerifier(),
			launchReservationReader: createHostBackedLaunchReservationReader(),
		});
		await registry.hydrateFromReplay();
		await registry.hydrateQuarantineFromReplay();
		const admitted = await registry.admit(context);
		if (identity === null) {
			await expect(registry.bindChild(admitted.admissionId, binding)).rejects.toMatchObject({
				code: "workflow_child_process_unverified",
			});
			expect(store.payloads.map((payload) => payload.kind)).toEqual(["workflow_dispatch_intent"]);
			return;
		}

		const bound = await registry.bindChild(admitted.admissionId, binding);
		expect(bound.status).toBe("running");
		expect(store.payloads.map((payload) => payload.kind)).toEqual([
			"workflow_dispatch_intent",
			"workflow_child_identity_bound",
		]);
	} finally {
		child.kill("SIGTERM");
		child.unref();
	}
});

it("reopens a persisted admission and replays its durable child binding", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-admission-reopen-"));
	const workflowId = "workflow-admission-reopen-test";
	const rootSessionId = "session-admission-reopen-test";
	const goalProjection = createTestGoalProjection();
	const deferredOwnerValidators = {
		autoresearch: () => undefined,
		runtime: () => undefined,
		effect: () => undefined,
		recovery: () => undefined,
	};
	const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	});
	let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
	let reopened: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
	try {
		if (child.pid === undefined) throw new Error("child process did not expose a pid");
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection,
			genesisEpoch: EPOCH,
			deferredOwnerValidators,
		});
		const durable = host.runtimeStore.durableContext;
		if (durable === undefined) throw new Error("persisted workflow store did not expose durable context");
		const leaseRef = durable.currentLeaseRef();
		const initialReplay = await host.runtimeStore.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: durable.epochRef.storeEpoch,
		});
		const startedPayload: Extract<WorkflowEventPayload, { kind: "workflow_started" }> = {
			kind: "workflow_started",
			workflowId,
			rootSessionId,
			objective: "reopen the admission",
		};
		const startIdempotencyKey = `workflow-start:${workflowId}`;
		const baselineDigest = digestObject(initialReplay.head);
		await host.runtimeStore.commit({
			workflowId,
			payload: startedPayload,
			expectedHead: initialReplay.head,
			semanticBinding: {
				mutationId: startIdempotencyKey,
				baselineDigest,
				expectedGenerations: { workflow: durable.epochRef.storeEpoch },
				ownerId: "workflow-coordinator",
				phase: "hardening_goal",
				reducerDigest: digestObject(startedPayload),
				semanticHead: {
					workflowId,
					sequence: initialReplay.head.sequence,
					eventDigest: initialReplay.head.eventDigest,
					stateDigest: baselineDigest,
					epochRef: durable.epochRef,
					generation: durable.epochRef.storeEpoch,
				},
				expectedHead: initialReplay.head,
				idempotencyKey: startIdempotencyKey,
				executionKey: null,
				writerIdentity: leaseRef.writerIdentity,
				leaseRef,
				epochRef: durable.epochRef,
			},
			epochRef: durable.epochRef,
			leaseRef,
			idempotencyKey: startIdempotencyKey,
			writerIdentity: leaseRef.writerIdentity,
			executionKey: null,
		});
		const replayAfterStart = await host.runtimeStore.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: durable.epochRef.storeEpoch,
		});
		expect(replayAfterStart.quarantined).toBe(false);
		const context = createContext(workflowId, {
			rootSessionId,
			epochRef: durable.epochRef,
			resourceLeaseRef: leaseRef,
			writerIdentity: leaseRef.writerIdentity,
		});
		let identity: Awaited<ReturnType<typeof readVerifiedWorkflowProcessGroupIdentity>> = null;
		for (let attempt = 0; attempt < 100 && identity === null; attempt += 1) {
			identity = await readVerifiedWorkflowProcessGroupIdentity(child.pid);
			if (identity === null) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const binding = createChildBinding(context, {
			processGroup:
				identity === null
					? { pid: child.pid, processStartId: "unsupported-start", processGroupId: "unsupported-group" }
					: {
							pid: identity.pid,
							processStartId: identity.processStartId,
							processGroupId: identity.processGroupId,
							parentPid: identity.parentPid,
						},
		});
		const processContainmentVerifier = createTestProcessContainmentVerifier();
		const registry = createRegistry(host.runtimeStore, workflowId, context, {
			processContainmentVerifier,
			launchReservationReader: createHostBackedLaunchReservationReader(),
			bindingConsumption: createWorkflowAdmissionBindingConsumption(host.runtimeStore),
			replayContextReader: { readAdmissionContext: async () => context },
		});
		await registry.hydrateFromReplay();
		await registry.hydrateQuarantineFromReplay();
		const admitted = await registry.admit(context);
		if (identity === null) {
			await expect(registry.bindChild(admitted.admissionId, binding)).rejects.toMatchObject({
				code: "workflow_child_process_unverified",
			});
			expect(
				(
					await host.runtimeStore.replay({
						workflowId,
						fromSequence: 0,
						expectedStoreEpoch: durable.epochRef.storeEpoch,
					})
				).events.map((event) => event.payload.kind),
			).toEqual(["workflow_started", "workflow_dispatch_intent"]);
			return;
		}

		const bound = await registry.bindChild(admitted.admissionId, binding);
		expect(bound.status).toBe("running");
		await host.dispose?.();
		host = undefined;
		reopened = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection,
			genesisEpoch: EPOCH,
			deferredOwnerValidators,
		});
		const reopenedDurable = reopened.runtimeStore.durableContext;
		if (reopenedDurable === undefined) throw new Error("reopened workflow store did not expose durable context");
		const replayed = createRegistry(reopened.runtimeStore, workflowId, context, {
			processContainmentVerifier,
			launchReservationReader: createHostBackedLaunchReservationReader(),
			bindingConsumption: createWorkflowAdmissionBindingConsumption(reopened.runtimeStore),
			replayContextReader: { readAdmissionContext: async () => context },
		});
		await replayed.hydrateFromReplay();
		await replayed.hydrateQuarantineFromReplay();
		await expect(replayed.lookupByExecutionKey(workflowId, context.executionKey)).resolves.toMatchObject({
			status: "running",
			processBinding: binding,
		});
	} finally {
		await reopened?.dispose?.();
		await host?.dispose?.();
		child.kill("SIGTERM");
		child.unref();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("requires an exact bound child before accepting a terminal outcome", async () => {
	const workflowId = "workflow-outcome-binding-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context);
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);
	const outcome = createOutcome(context);
	expect(isWorkflowPhaseOutcomeRecord(outcome)).toBe(true);

	await expect(
		registry.recordOutcome(admitted.admissionId, outcome, admitted.lifecycle.statusDigest),
	).rejects.toMatchObject({ code: "workflow_callback_binding_missing" });
	expect(store.payloads).toHaveLength(1);

	const bound = await registry.bindChild(admitted.admissionId, createChildBinding(context));
	const committed = await registry.recordOutcome(bound.admissionId, outcome, bound.lifecycle.statusDigest);
	const repeated = await registry.recordOutcome(bound.admissionId, outcome, committed.lifecycle.statusDigest);

	expect(committed.status).toBe("completed");
	expect(repeated.outcomeDigest).toBe(digestWorkflowOutcome(outcome));
	expect(store.payloads.map((payload) => payload.kind)).toEqual([
		"workflow_dispatch_intent",
		"workflow_child_identity_bound",
		"workflow_child_outcome_committed",
	]);
});

it("fails closed on mismatched outcome workflow, attempt, execution, epoch, lease, revision, and digest", async () => {
	const workflowId = "workflow-outcome-mismatch-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context);
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);
	const bound = await registry.bindChild(admitted.admissionId, createChildBinding(context));
	const outcome = createOutcome(context);
	const boundary = createBoundary(workflowId, context);

	const mismatches: readonly [string, WorkflowOutcomeBindingOverride][] = [
		["workflow", { workflowId: "other-workflow" }],
		["attempt", { phaseAttemptId: "other-attempt" }],
		["execution", { invocationToken: "other-execution" }],
		["epoch", { epochRef: { storeEpoch: 1, coordinatorEpoch: 2 } }],
		["lease", { resourceLeaseRef: { ...context.resourceLeaseRef, leaseId: "other-lease" } }],
		[
			"revision",
			{ revisionBoundary: { ...boundary, revisionRegistryDigest: "other-revision", tupleDigest: "wrong" } },
		],
		["digest", { outcomeDigest: "wrong-digest" }],
	];

	for (const [label, override] of mismatches) {
		const binding = createOutcomeBinding(context, outcome, boundary, override);
		expect(() => assertWorkflowOutcomeAdmissionBinding(binding, context, outcome), label).toThrow(
			"workflow_outcome_boundary_mismatch",
		);
	}
	await expect(
		registry.recordOutcome(
			bound.admissionId,
			{ ...outcome, outcome: { ...outcome.outcome, workflowId: "other-workflow" } },
			bound.lifecycle.statusDigest,
		),
	).rejects.toMatchObject({ code: "workflow_outcome_boundary_mismatch" });
	expect(store.payloads).toHaveLength(2);
});

it("durably quarantines a duplicate execution key whose admitted context differs", async () => {
	const workflowId = "workflow-duplicate-quarantine-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context);
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);

	await expect(registry.admit({ ...context, expectedEffectDigest: "different-effect" })).rejects.toMatchObject({
		code: "workflow_admission_conflict",
	});
	await expect(registry.lookupByExecutionKey(workflowId, context.executionKey)).resolves.toMatchObject({
		status: "quarantined",
	});
	expect(store.payloads.map((payload) => payload.kind)).toEqual([
		"workflow_dispatch_intent",
		"workflow_lease_quarantined",
	]);
	expect((await registry.listQuarantine(workflowId))[0]).toMatchObject({
		admissionId: admitted.admissionId,
		executionKey: context.executionKey,
	});
});

it("validates the current boundary and callback token before a terminal duplicate", async () => {
	const workflowId = "workflow-terminal-validation-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	let callbackAllowed = true;
	let revisionAllowed = true;
	const registry = createRegistry(store, workflowId, context, {
		callbackFenceStore: {
			assertActive: async () => {
				if (!callbackAllowed) throw new Error("callback fence stale");
			},
		},
		revisionRegistry: {
			assertActive: async () => {
				if (!revisionAllowed) throw new Error("revision revoked");
			},
		},
	});
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);
	const bound = await registry.bindChild(admitted.admissionId, createChildBinding(context));
	const outcome = createOutcome(context);
	const terminal = await registry.recordOutcome(bound.admissionId, outcome, bound.lifecycle.statusDigest);

	callbackAllowed = false;
	await expect(registry.recordOutcome(terminal.admissionId, outcome, terminal.lifecycle.statusDigest)).rejects.toThrow(
		"callback fence stale",
	);
	callbackAllowed = true;
	revisionAllowed = false;
	await expect(registry.recordOutcome(terminal.admissionId, outcome, terminal.lifecycle.statusDigest)).rejects.toThrow(
		"workflow_revision_boundary_stale",
	);
});

it("does not overwrite a terminal attempt when quarantine is requested", async () => {
	const workflowId = "workflow-terminal-quarantine-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context);
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);
	const bound = await registry.bindChild(admitted.admissionId, createChildBinding(context));
	const terminal = await registry.recordOutcome(
		bound.admissionId,
		createOutcome(context),
		bound.lifecycle.statusDigest,
	);

	await expect(registry.quarantine(terminal.admissionId, "late-quarantine")).rejects.toMatchObject({
		code: "workflow_terminal_quarantine_forbidden",
	});
	await expect(registry.lookupByExecutionKey(workflowId, context.executionKey)).resolves.toMatchObject({
		status: "completed",
	});
	expect(store.payloads.map((payload) => payload.kind)).not.toContain("workflow_lease_quarantined");
});

it("returns detached frozen admission projections", async () => {
	const workflowId = "workflow-frozen-projection-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const registry = createRegistry(store, workflowId, context);
	await registry.hydrateFromReplay();
	await registry.hydrateQuarantineFromReplay();
	const admitted = await registry.admit(context);
	const listed = await registry.listByWorkflow(workflowId);
	const lookedUp = await registry.lookupByExecutionKey(workflowId, context.executionKey);

	expect(Object.isFrozen(admitted)).toBe(true);
	expect(Object.isFrozen(admitted.context)).toBe(true);
	expect(Object.isFrozen(listed[0])).toBe(true);
	expect(Object.isFrozen(lookedUp)).toBe(true);
	if (lookedUp === undefined) throw new Error("expected lookup result");
	expect(() => {
		(listed[0]!.context as { taskId: string }).taskId = "mutated";
	}).toThrow();
	expect(lookedUp.context.taskId).toBe(context.taskId);
});

it("rejects replayed intents without a complete authenticated admission context", async () => {
	const workflowId = "workflow-replay-context-test";
	const context = createContext(workflowId);
	const store = createReplayableStore(workflowId, EPOCH, [createReplayCommit(context)]);
	const registry = createRegistry(store, workflowId, context);

	await expect(registry.hydrateFromReplay()).rejects.toMatchObject({
		code: "workflow_admission_replay_context_unavailable",
	});
});

it("fails closed when the authenticated commit result does not echo its identity", async () => {
	const workflowId = "workflow-commit-proof-test";
	const store = createRecordingStore(workflowId, EPOCH);
	const context = createContext(workflowId);
	const payload = {
		kind: "workflow_dispatch_intent",
		workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		admissionId: `admission:${context.executionKey}`,
		epochRef: context.epochRef,
		decisionRef: context.decisionRef,
		resourceLeaseRef: context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
		childAuthority: context.childAuthority,
		launchConfigDigest: context.launchConfigDigest,
		expectedEffectDigest: context.expectedEffectDigest,
	} satisfies Extract<WorkflowEventPayload, { kind: "workflow_dispatch_intent" }>;
	const expectedHead = await store.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: EPOCH.storeEpoch });
	const malformed = createMalformedCommitStore(store, payload, expectedHead.head);

	await expect(
		commitAuthenticated(malformed, {
			workflowId,
			payload,
			expectedHead: expectedHead.head,
			epochRef: EPOCH,
			leaseRef: context.resourceLeaseRef,
			idempotencyKey: context.idempotencyKey,
			writerIdentity: context.writerIdentity,
			executionKey: context.executionKey,
		}),
	).rejects.toMatchObject({ code: "workflow_authenticated_commit_result_mismatch" });
});

interface WorkflowOutcomeBindingOverride {
	readonly workflowId?: string;
	readonly phaseAttemptId?: string;
	readonly invocationToken?: string;
	readonly epochRef?: WorkflowEpochRef;
	readonly resourceLeaseRef?: WorkflowLeaseRef;
	readonly revisionBoundary?: WorkflowRevisionBoundaryContext;
	readonly outcomeDigest?: string;
}

function createRegistry(
	store: WorkflowRuntimeStore,
	workflowId: string,
	context: WorkflowInternalAdmissionContext,
	overrides: Partial<WorkflowAdmissionRegistryDependencies> = {},
): WorkflowAdmissionRegistry {
	const boundary: WorkflowRevisionBoundaryContext = {
		workflowId,
		epochRef: context.epochRef,
		leaseRef: context.resourceLeaseRef,
		executionKey: context.executionKey,
		revisionTuple: context.revisionTuple,
		revisionRegistryRef: context.revisionRegistryRef,
		revisionRegistryDigest: context.revisionRegistryDigest,
		configSnapshotDigest: context.configSnapshotDigest,
		tupleDigest: digestObject({
			workflowId,
			epochRef: context.epochRef,
			leaseRef: context.resourceLeaseRef,
			executionKey: context.executionKey,
			revisionTuple: context.revisionTuple,
			revisionRegistryRef: context.revisionRegistryRef,
			revisionRegistryDigest: context.revisionRegistryDigest,
			configSnapshotDigest: context.configSnapshotDigest,
		}),
	};
	const dependencies: WorkflowAdmissionRegistryDependencies = {
		store,
		epochs: {
			assertCurrent: async () => undefined,
		} as unknown as WorkflowAdmissionRegistryDependencies["epochs"],
		bindingConsumption: createMemoryBindingConsumption(),
		revisionRegistry: { assertActive: async () => undefined },
		readRevisionBoundaryContext: async () => boundary,
		readCurrentEpoch: async () => context.epochRef,
		callbackFenceStore: { assertActive: async () => undefined },
		processContainmentVerifier: createSyntheticProcessContainmentVerifier(),
		launchReservationReader: createSyntheticLaunchReservationReader(),
		workflowRoot: "/tmp/workflow-admission-test",
		writerIdentity: context.writerIdentity,
		...overrides,
	};
	return createWorkflowAdmissionRegistry(dependencies);
}

function createContext(
	workflowId: string,
	overrides: Partial<WorkflowInternalAdmissionContext> = {},
): WorkflowInternalAdmissionContext {
	const taskId = "task-a";
	const attemptId = "attempt-a";
	const launchConfigDigest = "launch-a";
	const rootSessionId = overrides.rootSessionId ?? "root-a";
	const decisionRef: WorkflowDecisionRef = {
		decisionScope: { kind: "workflow", workflowId, rootSessionId },
		decisionId: "decision-a",
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		decisionDigest: "decision-digest-a",
	};
	const resourceLeaseRef = createLeaseRef(workflowId);
	const executionKey = deriveWorkflowExecutionKey({ workflowId, taskId, attemptId, decisionRef, launchConfigDigest });
	return {
		workflowId,
		rootSessionId,
		taskId,
		attemptId,
		executionKey,
		idempotencyKey: sha256Hex([executionKey, String(EPOCH.storeEpoch), String(EPOCH.coordinatorEpoch)].join(":")),
		decisionRef,
		resourceLeaseRef,
		controlCapacity: CONTROL_CAPACITY,
		ownershipLeaseRef: null,
		childAuthority: {
			capabilities: ["read_only"],
			writeClass: "read_only",
			parentAttemptId: null,
			rootSpawned: true,
		} satisfies WorkflowChildAuthority,
		launchConfigDigest,
		expectedEffectDigest: "effect-a",
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-a",
		agentRole: "worker",
		modelId: "model-a",
		reasoningEffort: "medium",
		epochRef: EPOCH,
		configSnapshotDigest: "config-a",
		revisionTuple: REVISION_TUPLE,
		revisionRegistryRef: createArtifactRef("revision-a"),
		revisionRegistryDigest: "revision-registry-a",
		writerIdentity: "writer-a",
		...overrides,
	};
}

function createBoundary(
	workflowId: string,
	context: WorkflowInternalAdmissionContext,
): WorkflowRevisionBoundaryContext {
	const unsigned = {
		workflowId,
		epochRef: context.epochRef,
		leaseRef: context.resourceLeaseRef,
		executionKey: context.executionKey,
		revisionTuple: context.revisionTuple,
		revisionRegistryRef: context.revisionRegistryRef,
		revisionRegistryDigest: context.revisionRegistryDigest,
		configSnapshotDigest: context.configSnapshotDigest,
	};
	return { ...unsigned, tupleDigest: digestObject(unsigned) };
}

function createChildBinding(
	context: WorkflowInternalAdmissionContext,
	overrides: {
		readonly identity?: Partial<WorkflowChildIdentity>;
		readonly processGroup?: Partial<WorkflowChildProcessBinding["processGroup"]>;
	} = {},
): WorkflowChildProcessBinding {
	const processGroupBase = {
		pid: 42,
		processStartId: "start-a",
		processGroupId: "group-a",
		parentPid: process.pid,
	};
	const processGroupWithoutDigest = { ...processGroupBase, ...overrides.processGroup };
	const processGroup = {
		...processGroupWithoutDigest,
		identityDigest: digestObject(processGroupWithoutDigest),
	};
	const identityWithoutDigest = {
		admissionId: `admission:${context.executionKey}`,
		childSessionId: "child-a",
		processGroupId: processGroup.processGroupId,
		executionKey: context.executionKey,
		epochRef: context.epochRef,
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-a",
		agentRole: "worker",
		modelId: "model-a",
		reasoningEffort: "medium",
		launchConfigDigest: context.launchConfigDigest,
		...overrides.identity,
	};
	const childIdentity = {
		...identityWithoutDigest,
		identityDigest: canonicalWorkflowIdentityDigest(identityWithoutDigest),
	};
	return {
		workflowId: context.workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		childIdentity,
		processGroup,
		bindingDigest: canonicalWorkflowBindingDigest({ childIdentity, processGroup }),
	};
}

function createOutcome(context: WorkflowInternalAdmissionContext): WorkflowPhaseOutcomeRecord {
	const outcome: WorkflowPhaseOutcome = {
		workflowId: context.workflowId,
		phaseAttemptId: context.attemptId,
		epochRef: context.epochRef,
		invocationToken: context.executionKey,
		inputStateDigest: context.expectedEffectDigest,
		status: "complete",
		outputStateDigest: "output-a",
		artifactRefs: [createArtifactRef("outcome-a")],
		evidenceRefs: [createArtifactRef("evidence-a")],
	};
	return { outcome, attemptStatus: "completed" };
}

function createOutcomeBinding(
	context: WorkflowInternalAdmissionContext,
	outcome: WorkflowPhaseOutcomeRecord,
	boundary: WorkflowRevisionBoundaryContext,
	overrides: WorkflowOutcomeBindingOverride = {},
): WorkflowOutcomeAdmissionBinding {
	return {
		workflowId: overrides.workflowId ?? context.workflowId,
		phaseAttemptId: overrides.phaseAttemptId ?? context.attemptId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		invocationToken: overrides.invocationToken ?? context.executionKey,
		epochRef: overrides.epochRef ?? context.epochRef,
		resourceLeaseRef: overrides.resourceLeaseRef ?? context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
		revisionBoundary: overrides.revisionBoundary ?? boundary,
		outcomeDigest: overrides.outcomeDigest ?? digestWorkflowOutcome(outcome),
		rootSessionId: context.rootSessionId,
		configSnapshotDigest: context.configSnapshotDigest,
		expectedEffectDigest: context.expectedEffectDigest,
	};
}

function createLeaseRef(workflowId: string): WorkflowLeaseRef {
	return {
		...EPOCH,
		leaseId: `lease-${workflowId}`,
		acquisitionEventSequence: 1,
		processIdentity: "process-a",
		rootDigest: "root-digest-a",
		writerIdentity: "writer-a",
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T01:00:00.000Z",
	};
}

function createTestGoalProjection(): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	let goal: GoalState = { ...emptyGoalState(), goalId: "goal-admission-reopen" };
	return {
		read: (): GoalState => structuredClone(goal),
		compareAndSwap: (expected, next): boolean => {
			if (digestObject(goal) !== digestObject(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
}

function createArtifactRef(artifactId: string): WorkflowArtifactRef {
	return {
		artifactId,
		relativePath: `artifacts/${artifactId}`,
		digest: `${artifactId}-digest`,
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
}

class RecordingStore {
	readonly payloads: WorkflowEventPayload[] = [];
	readonly identity: WorkflowRuntimeStoreIdentity;
	private head: WorkflowJournalHead;

	constructor(workflowId: string, epochRef: WorkflowEpochRef) {
		this.identity = {
			storeKind: "workflow",
			namespace: "test",
			rootDir: "/tmp/workflow-admission-test",
			storeId: "store-test",
			workflowId,
			identityDigest: digestObject({ workflowId }),
		};
		this.head = { workflowId, sequence: 0, eventDigest: null, epochRef };
	}

	async commit<TPayload extends WorkflowEventPayload>(
		input: WorkflowStoreCommitInput<TPayload>,
	): Promise<WorkflowStoreCommitResult<TPayload>> {
		this.payloads.push(input.payload);
		const sequence = this.head.sequence + 1;
		const payloadBytes = canonicalJsonBytes(input.payload);
		const eventDigest = digestObject({ sequence, payload: input.payload });
		this.head = { ...this.head, sequence, eventDigest };
		const commit = {
			workflowId: input.workflowId,
			sequence,
			payload: input.payload,
			payloadBytes,
			payloadDigest: digestObject(input.payload),
			priorEventDigest: input.expectedHead.eventDigest,
			eventDigest,
			recordVersion: 1 as const,
			generationId: "generation",
			recordMac: "record-mac",
			recordChecksum: "record-checksum",
			expectedHead: input.expectedHead,
			epochRef: input.epochRef,
			leaseRef: input.leaseRef,
			idempotencyKey: input.idempotencyKey,
			returnProofId: `return-proof:${input.idempotencyKey}`,
			commitReturnProof: {} as WorkflowStoreCommitResult<TPayload>["commit"]["commitReturnProof"],
			preparedFrameDigest: "prepared",
			committedFrameDigest: "committed",
			keyId: "key",
			preparedFrameMac: "prepared-mac",
			committedFrameMac: "committed-mac",
			preparedFrameChecksum: "prepared-checksum",
			committedFrameChecksum: "committed-checksum",
			semanticBinding: input.semanticBinding,
			executionKey: input.executionKey,
			writerIdentity: input.writerIdentity,
		};
		return {
			status: "committed",
			payload: input.payload,
			commit,
			state: null,
			head: this.head,
		};
	}

	async replay(): Promise<{
		workflowId: string;
		executionKey: string | null;
		events: readonly never[];
		head: WorkflowJournalHead;
		quarantined: false;
		quarantineReason: null;
	}> {
		return {
			workflowId: this.head.workflowId,
			executionKey: null,
			events: [],
			head: this.head,
			quarantined: false,
			quarantineReason: null,
		};
	}
}

function createRecordingStore(
	workflowId: string,
	epochRef: WorkflowEpochRef,
): WorkflowRuntimeStore & { readonly payloads: WorkflowEventPayload[] } {
	return new RecordingStore(workflowId, epochRef) as unknown as WorkflowRuntimeStore & {
		readonly payloads: WorkflowEventPayload[];
	};
}

function createReplayCommit(context: WorkflowInternalAdmissionContext): WorkflowJournalCommit<WorkflowEventPayload> {
	const payload: Extract<WorkflowEventPayload, { kind: "workflow_dispatch_intent" }> = {
		kind: "workflow_dispatch_intent",
		workflowId: context.workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		admissionId: `admission:${context.executionKey}`,
		epochRef: context.epochRef,
		decisionRef: context.decisionRef,
		resourceLeaseRef: context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
		childAuthority: context.childAuthority,
		launchConfigDigest: context.launchConfigDigest,
		expectedEffectDigest: context.expectedEffectDigest,
	};
	return {
		workflowId: context.workflowId,
		sequence: 1,
		payload,
		payloadBytes: new Uint8Array(),
		payloadDigest: digestObject(payload),
		priorEventDigest: null,
		eventDigest: "event-digest",
		recordVersion: 1,
		generationId: "generation",
		recordMac: "record-mac",
		recordChecksum: "record-checksum",
		expectedHead: { workflowId: context.workflowId, sequence: 0, eventDigest: null, epochRef: context.epochRef },
		epochRef: context.epochRef,
		leaseRef: context.resourceLeaseRef,
		idempotencyKey: context.idempotencyKey,
		returnProofId: `return-proof:${context.idempotencyKey}`,
		commitReturnProof: {} as WorkflowJournalCommit<WorkflowEventPayload>["commitReturnProof"],
		preparedFrameDigest: "prepared",
		committedFrameDigest: "committed",
		keyId: "key",
		preparedFrameMac: "prepared-mac",
		committedFrameMac: "committed-mac",
		preparedFrameChecksum: "prepared-checksum",
		committedFrameChecksum: "committed-checksum",
		semanticBinding: {} as WorkflowJournalCommit<WorkflowEventPayload>["semanticBinding"],
		executionKey: context.executionKey,
		writerIdentity: context.writerIdentity,
	};
}

function createReplayEvent(
	base: WorkflowJournalCommit<WorkflowEventPayload>,
	payload: WorkflowEventPayload,
	overrides: Pick<WorkflowJournalCommit<WorkflowEventPayload>, "sequence" | "expectedHead" | "eventDigest">,
): WorkflowJournalCommit<WorkflowEventPayload> {
	return {
		...base,
		sequence: overrides.sequence,
		payload,
		payloadBytes: canonicalJsonBytes(payload),
		payloadDigest: digestObject(payload),
		priorEventDigest: base.eventDigest,
		eventDigest: overrides.eventDigest,
		expectedHead: overrides.expectedHead,
	};
}

function createSyntheticProcessContainmentVerifier(): WorkflowProcessContainmentVerifier {
	return {
		readCurrentHostIdentity: async () => ({
			pid: process.pid,
			processStartId: "host-start",
			processGroupId: "host-group",
			parentPid: process.pid,
			identityDigest: digestObject({
				pid: process.pid,
				processStartId: "host-start",
				processGroupId: "host-group",
				parentPid: process.pid,
			}),
		}),
		verify: async (identity) => ({
			identity,
			verified: true,
			remainingPids: [identity.pid],
			evidenceDigest: digestObject(identity),
			containment: {
				membershipVerified: true,
				descendantsContained: true,
				killOnClose: true,
				attestationDigest: digestObject({ identity, containment: true }),
			},
		}),
	};
}

function createSyntheticLaunchReservationReader(
	rootSessionIdOverride?: string,
): WorkflowAdmissionLaunchReservationReader {
	return {
		readLaunchReservation: async (input): Promise<WorkflowAdmissionLaunchReservation> => {
			const childIdentity = {
				admissionId: input.admissionId,
				childSessionId: "child-a",
				executionKey: input.executionKey,
				epochRef: input.epochRef,
				runtimeVersion: "0.147.0-alpha.10",
				hostCapabilityRevision: "host-a",
				agentRole: "worker",
				modelId: "model-a",
				reasoningEffort: "medium",
				launchConfigDigest: input.launchConfigDigest,
				processGroupId: input.binding.processGroup.processGroupId,
			};
			const unsigned = {
				reservationId: `reservation:${input.nonce}`,
				workflowId: input.workflowId,
				rootSessionId: rootSessionIdOverride ?? input.rootSessionId,
				taskId: input.taskId,
				attemptId: input.attemptId,
				admissionId: input.admissionId,
				executionKey: input.executionKey,
				nonce: input.nonce,
				epochRef: input.epochRef,
				head: input.head,
				childIdentity,
				processGroup: input.binding.processGroup,
				currentProcessGroup: input.binding.processGroup,
			};
			return { ...unsigned, reservationDigest: digestObject(unsigned) };
		},
		readLaunchReservationForSpawn: async () => null,
	};
}

function createHostBackedLaunchReservationReader(): WorkflowAdmissionLaunchReservationReader {
	return {
		readLaunchReservation: async (input): Promise<WorkflowAdmissionLaunchReservation | null> => {
			const identity = await readVerifiedWorkflowProcessGroupIdentity(input.binding.processGroup.pid);
			if (identity === null) return null;
			const childIdentity = {
				admissionId: input.admissionId,
				childSessionId: "child-a",
				executionKey: input.executionKey,
				epochRef: input.epochRef,
				runtimeVersion: "0.147.0-alpha.10",
				hostCapabilityRevision: "host-a",
				agentRole: "worker",
				modelId: "model-a",
				reasoningEffort: "medium",
				launchConfigDigest: input.launchConfigDigest,
				processGroupId: identity.processGroupId,
			};
			const unsigned = {
				reservationId: `host-reservation:${identity.processStartId}`,
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
				processGroup: identity,
				currentProcessGroup: identity,
			};
			return { ...unsigned, reservationDigest: digestObject(unsigned) };
		},
		readLaunchReservationForSpawn: async () => null,
	};
}

function createTestProcessContainmentVerifier(): WorkflowProcessContainmentVerifier {
	const readIdentity = async (pid: number) => {
		const identity = await readVerifiedWorkflowProcessGroupIdentity(pid);
		if (identity === null) throw new Error("process identity unavailable");
		return identity;
	};
	return {
		readCurrentHostIdentity: async () => readIdentity(process.pid),
		verify: async (expected) => {
			const identity = await readIdentity(expected.pid);
			return {
				identity,
				verified:
					identity.pid === expected.pid &&
					identity.processStartId === expected.processStartId &&
					identity.processGroupId === expected.processGroupId,
				remainingPids: [identity.pid],
				evidenceDigest: digestObject({ identity, expected }),
				containment: {
					membershipVerified: true,
					descendantsContained: true,
					killOnClose: true,
					attestationDigest: digestObject({ identity, expected, containment: true }),
				},
			};
		},
	};
}

function createMemoryBindingConsumption(): WorkflowAdmissionBindingConsumption {
	const consumed = new Map<string, string>();
	return {
		consume: async (input) => {
			const binding = digestObject({
				workflowId: input.workflowId,
				admissionId: input.admissionId,
				bindingDigest: input.bindingDigest,
				expectedHead: input.expectedHead,
				nonce: input.nonce,
			});
			const prior = consumed.get(input.nonce);
			if (prior !== undefined) {
				if (prior !== binding) throw new WorkflowDispatchError("workflow_admission_consumption_conflict");
				return "already_consumed";
			}
			consumed.set(input.nonce, binding);
			return "consumed";
		},
		assertConsumed: async (input) => {
			const expected = digestObject({
				workflowId: input.workflowId,
				admissionId: input.admissionId,
				bindingDigest: input.bindingDigest,
				expectedHead: input.expectedHead,
				nonce: input.nonce,
			});
			if (consumed.get(input.nonce) !== expected)
				throw new WorkflowDispatchError("workflow_admission_replay_invalid");
		},
	};
}

function createReplayableStore(
	workflowId: string,
	epochRef: WorkflowEpochRef,
	events: readonly WorkflowJournalCommit<WorkflowEventPayload>[],
): WorkflowRuntimeStore {
	const base = createRecordingStore(workflowId, epochRef);
	return {
		...base,
		identity: base.identity,
		commit: base.commit.bind(base),
		replay: async () => ({
			workflowId,
			executionKey: null,
			events,
			head:
				events.at(-1) === undefined
					? { workflowId, sequence: 0, eventDigest: null, epochRef }
					: {
							workflowId,
							sequence: events.at(-1)!.sequence,
							eventDigest: events.at(-1)!.eventDigest,
							epochRef,
						},
			quarantined: false,
			quarantineReason: null,
		}),
	} as unknown as WorkflowRuntimeStore;
}

function createMalformedCommitStore(
	base: WorkflowRuntimeStore,
	payload: WorkflowEventPayload,
	expectedHead: WorkflowJournalHead,
): WorkflowRuntimeStore {
	return {
		...base,
		identity: base.identity,
		commit: async (input: WorkflowStoreCommitInput<WorkflowEventPayload>) => {
			const result = await base.commit({ ...input, payload, expectedHead });
			return {
				...result,
				commit: { ...result.commit, workflowId: "wrong-workflow" },
			} as typeof result;
		},
		replay: base.replay.bind(base),
	} as unknown as WorkflowRuntimeStore;
}

void createArtifactRef;
void createLeaseRef;
void createContext;
void createRegistry;
void createRecordingStore;
