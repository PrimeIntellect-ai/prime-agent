import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../../src/core/goals.js";
import type { WorkflowAdmissionResult } from "../../src/core/workflow/admission.js";
import type {
	WorkflowAutoResearchEventPayload,
	WorkflowChildIdentity,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalCommit,
	WorkflowLeaseRef,
	WorkflowProcessGroupIdentity,
	WorkflowRuntimeEventPayload,
	WorkflowRuntimeStore,
	WorkflowStoreReplayResult,
} from "../../src/core/workflow/contracts.js";
import { digestObject } from "../../src/core/workflow/contracts.js";
import { createPrimeWorkflowNoActiveAttemptRecovery } from "../../src/core/workflow/prime-loop.js";
import {
	canonicalWorkflowBindingDigest,
	canonicalWorkflowIdentityDigest,
	canonicalWorkflowProcessGroupDigest,
} from "../../src/core/workflow/process-groups.js";
import type { WorkflowRecoveryRequest } from "../../src/core/workflow/recovery.js";
import type { WorkflowDeferredEventOwnerValidators } from "../../src/core/workflow/reducer.js";
import {
	createWorkflowRuntimeRecoveryAdapter,
	type WorkflowRuntimeRecoveryAdapterInput,
} from "../../src/core/workflow/runtime-recovery-adapter.js";
import type { PersistedSessionWorkflowRecoveryConstructionInput } from "../../src/core/workflow/session-host-factory.js";
import { createPersistedSessionWorkflowHost } from "../../src/core/workflow/session-host-factory.js";

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
	return {
		autoresearch: validate,
		runtime: validate,
		effect: validate,
		recovery: validate,
	};
}

function goalProjection(initial: GoalState = emptyGoalState()): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	let current = structuredClone(initial);
	return {
		read: () => structuredClone(current),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
			current = structuredClone(next);
			return true;
		},
	};
}

const RECOVERY_FOLD_WORKFLOW_ID = "workflow-recovery-fold";
const RECOVERY_FOLD_ROOT_SESSION_ID = "session-recovery-fold";
const RECOVERY_FOLD_EPOCH = { storeEpoch: 1, coordinatorEpoch: 1 } as const;

const recoveryFoldDecisionRef = {
	decisionScope: {
		kind: "workflow" as const,
		workflowId: RECOVERY_FOLD_WORKFLOW_ID,
		rootSessionId: RECOVERY_FOLD_ROOT_SESSION_ID,
	},
	decisionId: "decision:recovery-fold",
	revision: 1,
	storeEpoch: RECOVERY_FOLD_EPOCH.storeEpoch,
	decisionDigest: "decision-recovery-fold",
};

const recoveryFoldLeaseRef: WorkflowLeaseRef = {
	...RECOVERY_FOLD_EPOCH,
	leaseId: "lease:recovery-fold",
	acquisitionEventSequence: 1,
	processIdentity: "process:recovery-fold",
	rootDigest: "root:recovery-fold",
	writerIdentity: "writer:recovery-fold",
	acquiredAt: "2030-01-01T00:00:00.000Z",
	expiresAt: "2030-01-01T00:05:00.000Z",
};

const recoveryFoldProcessGroup: WorkflowProcessGroupIdentity = {
	pid: 42,
	processStartId: "start:recovery-fold",
	processGroupId: "group:recovery-fold",
	parentPid: 1,
	identityDigest: canonicalWorkflowProcessGroupDigest({
		pid: 42,
		processStartId: "start:recovery-fold",
		processGroupId: "group:recovery-fold",
		parentPid: 1,
	}),
};

const recoveryFoldSiblingProcessGroup: WorkflowProcessGroupIdentity = {
	pid: 43,
	processStartId: "start:recovery-fold-sibling",
	processGroupId: "group:recovery-fold-sibling",
	parentPid: 1,
	identityDigest: canonicalWorkflowProcessGroupDigest({
		pid: 43,
		processStartId: "start:recovery-fold-sibling",
		processGroupId: "group:recovery-fold-sibling",
		parentPid: 1,
	}),
};

function recoveryFoldStore(payloads: readonly WorkflowRuntimeEventPayload[]): WorkflowRuntimeStore {
	const identity = {
		storeKind: "workflow" as const,
		namespace: "session",
		rootDir: "/tmp/recovery-fold",
		storeId: `session-workflow:${RECOVERY_FOLD_WORKFLOW_ID}`,
		workflowId: RECOVERY_FOLD_WORKFLOW_ID,
	};
	const events = payloads.map(
		(payload, index) =>
			({
				workflowId: RECOVERY_FOLD_WORKFLOW_ID,
				sequence: index + 1,
				payload,
			}) as unknown as WorkflowJournalCommit<WorkflowEventPayload>,
	);
	const replay: WorkflowStoreReplayResult = {
		workflowId: RECOVERY_FOLD_WORKFLOW_ID,
		executionKey: null,
		events,
		head: {
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			sequence: events.length,
			eventDigest: events.length === 0 ? null : "recovery-fold-head",
			epochRef: RECOVERY_FOLD_EPOCH,
		},
		quarantined: false,
		quarantineReason: null,
	};
	return {
		identity: { ...identity, identityDigest: digestObject(identity) },
		replay: async () => replay,
	} as unknown as WorkflowRuntimeStore;
}

function recoveryFoldEffectEvents(): readonly WorkflowRuntimeEventPayload[] {
	const effect = {
		kind: "file_read" as const,
		operationId: "operation:recovery-fold",
		path: "workspace/input.txt",
		pathDigest: "path:recovery-fold",
	};
	return [
		{
			kind: "workflow_effect_intent",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			attemptId: "attempt:recovery-fold",
			executionKey: "execution:recovery-fold",
			effectDigest: digestObject(effect),
			decisionRef: recoveryFoldDecisionRef,
			epochRef: RECOVERY_FOLD_EPOCH,
			idempotencyKey: "effect:recovery-fold",
			effect,
		},
		{
			kind: "workflow_effect_ambiguous",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			attemptId: "attempt:recovery-fold",
			executionKey: "execution:recovery-fold",
			effectDigest: digestObject(effect),
			idempotencyKey: "effect:recovery-fold",
			epochRef: RECOVERY_FOLD_EPOCH,
			reason: "unknown_external_outcome" as const,
		},
	];
}

function recoveryFoldLeaseEvents(): readonly WorkflowRuntimeEventPayload[] {
	return [
		{
			kind: "workflow_ownership_lease_acquired",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			lease: {
				leaseId: recoveryFoldLeaseRef.leaseId,
				workflowId: RECOVERY_FOLD_WORKFLOW_ID,
				taskId: "task:recovery-fold",
				attemptId: "attempt:recovery-fold",
				ownedPaths: ["workspace"],
				ownedContracts: ["contract:recovery-fold"],
				status: "active" as const,
				storeEpoch: RECOVERY_FOLD_EPOCH.storeEpoch,
				coordinatorEpoch: RECOVERY_FOLD_EPOCH.coordinatorEpoch,
				acquisitionEventSequence: 1,
				releaseEventSequence: null,
			},
			epochRef: RECOVERY_FOLD_EPOCH,
		},
		{
			kind: "workflow_lease_quarantined",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			leaseRef: recoveryFoldLeaseRef,
			epochRef: RECOVERY_FOLD_EPOCH,
			reason: "uncertain-recovery-fold",
		},
	];
}

function recoveryFoldFencedProcessEvents(): readonly WorkflowRuntimeEventPayload[] {
	return [
		{
			kind: "workflow_process_group_owned",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			attemptId: "attempt:recovery-fold",
			processGroup: recoveryFoldProcessGroup,
			epochRef: RECOVERY_FOLD_EPOCH,
		},
		{
			kind: "workflow_process_group_fenced",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			attemptId: "attempt:recovery-fold",
			processGroup: recoveryFoldProcessGroup,
			epochRef: RECOVERY_FOLD_EPOCH,
			reason: "workflow-cancel",
		},
	];
}

function recoveryFoldReapedProcessEvents(
	remainingPids: readonly number[],
	processGroup: WorkflowProcessGroupIdentity = recoveryFoldProcessGroup,
): readonly WorkflowRuntimeEventPayload[] {
	return [
		...recoveryFoldFencedProcessEvents(),
		{
			kind: "workflow_process_group_reaped",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			attemptId: "attempt:recovery-fold",
			processGroupId: processGroup.processGroupId,
			epochRef: RECOVERY_FOLD_EPOCH,
			remainingPids,
			reapDigest: "reap:recovery-fold",
		},
	];
}

function recoveryFoldTwoProcessGroupsWithOneReaped(): readonly WorkflowRuntimeEventPayload[] {
	return [
		...recoveryFoldFencedProcessEvents(),
		{
			kind: "workflow_process_group_owned",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			attemptId: "attempt:recovery-fold",
			processGroup: recoveryFoldSiblingProcessGroup,
			epochRef: RECOVERY_FOLD_EPOCH,
		},
		{
			kind: "workflow_process_group_reaped",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			attemptId: "attempt:recovery-fold",
			processGroupId: recoveryFoldProcessGroup.processGroupId,
			epochRef: RECOVERY_FOLD_EPOCH,
			remainingPids: [],
			reapDigest: "reap:recovery-fold",
		},
	];
}

function recoveryFoldReleasedDispatchEvents(): readonly WorkflowRuntimeEventPayload[] {
	return [
		{
			kind: "workflow_dispatch_intent",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			taskId: "task:recovery-fold",
			attemptId: "attempt:recovery-fold",
			executionKey: "execution:recovery-fold",
			admissionId: "admission:recovery-fold",
			epochRef: RECOVERY_FOLD_EPOCH,
			decisionRef: recoveryFoldDecisionRef,
			resourceLeaseRef: recoveryFoldLeaseRef,
			ownershipLeaseRef: null,
			childAuthority: {
				capabilities: ["read_only" as const],
				writeClass: "read_only" as const,
				parentAttemptId: null,
				rootSpawned: true,
			},
			launchConfigDigest: "launch:recovery-fold",
			expectedEffectDigest: "effect:recovery-fold",
		},
		{
			kind: "workflow_lease_release_recorded",
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			releaseRef: {
				leaseRef: recoveryFoldLeaseRef,
				attemptId: "attempt:recovery-fold",
				terminalOutcomeDigest: "outcome:recovery-fold",
				releaseEventSequence: 2,
				releaseProof: "proof:recovery-fold",
			},
			epochRef: RECOVERY_FOLD_EPOCH,
			status: "released" as const,
		},
	];
}

async function waitForLive(child: ChildProcess): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error("recovery child exited early");
		try {
			process.kill(child.pid ?? -1, 0);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error("recovery child did not become live");
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGKILL");
	await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function terminalAdmission(
	construction: PersistedSessionWorkflowRecoveryConstructionInput,
	request: WorkflowRecoveryRequest,
	processGroup: WorkflowProcessGroupIdentity,
): WorkflowAdmissionResult {
	const childIdentityBase = {
		admissionId: "admission:recovery-identity-mismatch",
		childSessionId: "child:recovery-identity-mismatch",
		executionKey: request.executionKey,
		epochRef: request.epochRef,
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-recovery-process",
		agentRole: "worker",
		modelId: "model-recovery-identity-mismatch",
		reasoningEffort: "medium",
		launchConfigDigest: "launch-recovery-identity-mismatch",
		processGroupId: processGroup.processGroupId,
	};
	const childIdentity: WorkflowChildIdentity = {
		...childIdentityBase,
		identityDigest: canonicalWorkflowIdentityDigest(childIdentityBase),
	};
	const processBinding = {
		workflowId: request.workflowId,
		taskId: request.taskId,
		attemptId: request.attemptId,
		childIdentity,
		processGroup,
		bindingDigest: canonicalWorkflowBindingDigest({ childIdentity, processGroup }),
	};
	const context = {
		workflowId: request.workflowId,
		rootSessionId: construction.rootSessionId,
		taskId: request.taskId,
		attemptId: request.attemptId,
		executionKey: request.executionKey,
		idempotencyKey: "admission:recovery-identity-mismatch",
		decisionRef: {
			decisionScope: {
				kind: "workflow" as const,
				workflowId: request.workflowId,
				rootSessionId: construction.rootSessionId,
			},
			decisionId: "decision:recovery-identity-mismatch",
			revision: 1,
			storeEpoch: request.epochRef.storeEpoch,
			decisionDigest: "decision-recovery-identity-mismatch",
		},
		resourceLeaseRef: construction.leaseRef,
		controlCapacity: {
			processSlots: 1,
			childSessionSlots: 1,
			modelCallSlots: 1,
			modelInputTokens: 1,
			modelOutputTokens: 1,
			verificationSlots: 0,
			redTeamSlots: 0,
			recoverySlots: 0,
		},
		ownershipLeaseRef: null,
		childAuthority: {
			capabilities: ["read_only"] as const,
			writeClass: "read_only" as const,
			parentAttemptId: null,
			rootSpawned: true,
		},
		launchConfigDigest: childIdentityBase.launchConfigDigest,
		runtimeVersion: childIdentityBase.runtimeVersion,
		hostCapabilityRevision: childIdentityBase.hostCapabilityRevision,
		agentRole: childIdentityBase.agentRole,
		modelId: childIdentityBase.modelId,
		reasoningEffort: childIdentityBase.reasoningEffort,
		expectedEffectDigest: "expected-effect-recovery-identity-mismatch",
		epochRef: request.epochRef,
		configSnapshotDigest: "config-recovery-identity-mismatch",
		revisionTuple: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			configRevision: 1,
			evidenceRevision: 1,
		},
		revisionRegistryRef: {
			artifactId: "revision-recovery-identity-mismatch",
			relativePath: "revision/recovery-identity-mismatch",
			digest: "revision-recovery-identity-mismatch",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		revisionRegistryDigest: "revision-registry-recovery-identity-mismatch",
		writerIdentity: construction.writerIdentity,
	};
	return {
		context,
		admissionId: context.idempotencyKey,
		lifecycle: {
			workflowId: request.workflowId,
			taskId: request.taskId,
			attemptId: request.attemptId,
			status: "completed",
			childIdentity,
			childAuthority: context.childAuthority,
			admissionEventSequence: 1,
			terminalEventSequence: 2,
			epochRef: request.epochRef,
			statusDigest: "status-recovery-identity-mismatch",
		},
		status: "completed",
		childIdentity,
		processBinding,
		admissionEventSequence: 1,
		terminalEventSequence: 2,
		outcomeDigest: "outcome-recovery-identity-mismatch",
	};
}

function readProcessGroupIdentity(child: ChildProcess): WorkflowProcessGroupIdentity {
	if (child.pid === undefined) throw new Error("recovery child pid unavailable");
	const unsigned = {
		pid: child.pid,
		processStartId: `test-start-${child.pid}`,
		processGroupId: `test-group-${child.pid}`,
		parentPid: process.pid,
	};
	return { ...unsigned, identityDigest: canonicalWorkflowProcessGroupDigest(unsigned) };
}

function recoveryDependencies(
	construction: PersistedSessionWorkflowRecoveryConstructionInput,
	options: {
		readonly admission?: () => WorkflowAdmissionResult | undefined;
		readonly observedProcessGroup?: WorkflowProcessGroupIdentity;
		readonly quarantinedProcessGroups?: WorkflowProcessGroupIdentity[];
	} = {},
): Omit<WorkflowRuntimeRecoveryAdapterInput, "runtimeStore" | "workflowId"> {
	const { runtimeStore, workflowId, writerIdentity, leaseRef, epochRef } = construction;
	const replay = async () =>
		runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
	const quarantineLease = async (input: {
		readonly leaseRef: WorkflowLeaseRef;
		readonly reason: string;
	}): Promise<{ readonly leaseRef: WorkflowLeaseRef; readonly status: "quarantined"; readonly reason: string }> => {
		const current = await replay();
		await runtimeStore.commit({
			workflowId,
			payload: {
				kind: "workflow_lease_quarantined",
				workflowId,
				leaseRef: input.leaseRef,
				epochRef,
				reason: input.reason,
			},
			expectedHead: current.head,
			epochRef,
			leaseRef,
			idempotencyKey: `workflow-lease-quarantined:${input.leaseRef.leaseId}:${input.reason}`,
			writerIdentity,
			executionKey: "attempt-recovery-process",
			semanticBinding: {
				mutationId: `workflow-lease-quarantined:${input.leaseRef.leaseId}:${input.reason}`,
				baselineDigest: digestObject(current.head),
				expectedGenerations: { workflow: epochRef.storeEpoch },
				ownerId: writerIdentity,
				phase: "executing",
				reducerDigest: digestObject({ workflowId, phase: "executing" }),
				semanticHead: {
					workflowId,
					sequence: current.head.sequence,
					eventDigest: current.head.eventDigest,
					stateDigest: digestObject(current.head),
					epochRef,
					generation: epochRef.storeEpoch,
				},
				expectedHead: current.head,
				idempotencyKey: `workflow-lease-quarantined:${input.leaseRef.leaseId}:${input.reason}`,
				executionKey: "attempt-recovery-process",
				writerIdentity,
				leaseRef,
				epochRef,
			},
		});
		return { leaseRef: input.leaseRef, status: "quarantined", reason: input.reason };
	};
	return {
		epochs: {
			assertCurrent: async (checkedWorkflowId: string, checkedEpoch: WorkflowEpochRef) => {
				const current = await replay();
				if (checkedWorkflowId !== workflowId || digestObject(current.head.epochRef) !== digestObject(checkedEpoch))
					throw new Error("workflow_epoch_stale");
			},
		},
		admission: {
			hydrateFromReplay: async () => {
				await replay();
			},
			hydrateQuarantineFromReplay: async () => {
				await replay();
			},
			lookupByExecutionKey: async () => options.admission?.(),
			quarantine: async () => {
				throw new Error("workflow_admission_not_expected");
			},
		},
		leases: {
			hydrateFromReplay: async () => {
				await replay();
			},
			lookupByLease: async () => undefined,
			release: async () => {
				throw new Error("workflow_lease_release_not_expected");
			},
			quarantine: async (input) => quarantineLease(input),
		},
		groups: {
			hydrateFromReplay: async () => {
				await replay();
			},
			verify: async (_identity: WorkflowProcessGroupIdentity) => false,
			inspect: async (identity: WorkflowProcessGroupIdentity) => ({
				identity: options.observedProcessGroup ?? identity,
				verified: false,
				remainingPids: [options.observedProcessGroup?.pid ?? identity.pid],
				evidenceDigest: digestObject({ expected: identity, observed: options.observedProcessGroup ?? identity }),
			}),
			terminate: async () => {
				throw new Error("workflow_group_terminate_not_expected");
			},
			reap: async () => ({ remainingPids: [], reapDigest: "reap-not-used", reapEventSequence: 0 }),
			quarantine: async (identity) => {
				options.quarantinedProcessGroups?.push(identity);
				if (identity.identityDigest === options.observedProcessGroup?.identityDigest)
					process.kill(identity.pid, "SIGKILL");
			},
			scanUnknownDescendants: async () => [],
		},
		processContainmentVerifier: {
			readCurrentHostIdentity: async () => readProcessGroupIdentity({ pid: process.pid } as ChildProcess),
			verify: async (identity) => {
				const observed = options.observedProcessGroup ?? identity;
				return {
					identity: observed,
					verified: observed.identityDigest === identity.identityDigest,
					remainingPids: observed.identityDigest === identity.identityDigest ? [identity.pid] : [observed.pid],
					evidenceDigest: digestObject({ expected: identity, observed }),
					containment: {
						membershipVerified: true,
						descendantsContained: true,
						killOnClose: true,
						attestationDigest: "containment-recovery-process",
					},
				};
			},
		},
		effects: {
			reconcile: async () => {
				throw new Error("workflow_effect_reconcile_not_expected");
			},
		},
		readKnownRecoveryBindings: async () => {
			const currentAdmission = options.admission?.();
			const processGroup = currentAdmission?.processBinding?.processGroup;
			return {
				admission: currentAdmission,
				processGroups: processGroup === undefined ? [] : [processGroup],
			};
		},
		writerIdentity,
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-recovery-process",
		readCurrentHostCapabilityRevision: async () => "host-recovery-process",
		readTrustedNow: async () => new Date().toISOString(),
		capabilities: {
			processIdentity: true,
			effectResolution: true,
			capabilityDigest: "capability-recovery-process",
		},
		readWorkspaceDigest: async () => digestObject({ workflowId, workspace: "real" }),
	};
}

async function initializeDurableWorkflow(
	host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>>,
	workflowId: string,
	rootSessionId: string,
): Promise<WorkflowEpochRef> {
	const durable = host.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("runtime store did not expose its authenticated durability");
	const epochRef = durable.epochRef;
	const replay = await host.runtimeStore.replay({
		workflowId,
		fromSequence: 0,
		expectedStoreEpoch: epochRef.storeEpoch,
	});
	const leaseRef = durable.currentLeaseRef();
	const baselineDigest = digestObject(replay.head);
	const semanticBinding = {
		mutationId: `workflow-start:${workflowId}`,
		baselineDigest,
		expectedGenerations: { workflow: epochRef.storeEpoch },
		ownerId: "workflow-coordinator",
		phase: "hardening_goal" as const,
		reducerDigest: digestObject({ kind: "workflow_started", workflowId, rootSessionId }),
		semanticHead: {
			workflowId,
			sequence: replay.head.sequence,
			eventDigest: replay.head.eventDigest,
			stateDigest: baselineDigest,
			epochRef,
			generation: epochRef.storeEpoch,
		},
		expectedHead: replay.head,
		idempotencyKey: `workflow-start:${workflowId}`,
		executionKey: null,
		writerIdentity: leaseRef.writerIdentity,
		leaseRef,
		epochRef,
	};
	await host.runtimeStore.commit({
		workflowId,
		payload: { kind: "workflow_started", workflowId, rootSessionId, objective: "durable recovery claim test" },
		expectedHead: replay.head,
		semanticBinding,
		epochRef,
		leaseRef,
		idempotencyKey: `workflow-start:${workflowId}`,
		writerIdentity: leaseRef.writerIdentity,
		executionKey: null,
	});
	return epochRef;
}

async function persistOwnedProcessGroup(
	host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>>,
	request: WorkflowRecoveryRequest,
	processGroup: WorkflowProcessGroupIdentity,
): Promise<void> {
	const durable = host.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("runtime store did not expose its authenticated durability");
	const replay = await host.runtimeStore.replay({
		workflowId: request.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: request.epochRef.storeEpoch,
	});
	const leaseRef = durable.currentLeaseRef();
	const idempotencyKey = `workflow-process-group-owned:${request.attemptId}:${processGroup.identityDigest}`;
	const payload = {
		kind: "workflow_process_group_owned" as const,
		workflowId: request.workflowId,
		attemptId: request.attemptId,
		processGroup,
		epochRef: request.epochRef,
	};
	const baselineDigest = digestObject(replay.head);
	await host.runtimeStore.commit({
		workflowId: request.workflowId,
		payload,
		expectedHead: replay.head,
		epochRef: request.epochRef,
		leaseRef,
		idempotencyKey,
		writerIdentity: leaseRef.writerIdentity,
		executionKey: request.executionKey,
		semanticBinding: {
			mutationId: idempotencyKey,
			baselineDigest,
			expectedGenerations: { workflow: request.epochRef.storeEpoch },
			ownerId: leaseRef.writerIdentity,
			phase: "executing",
			reducerDigest: digestObject(payload),
			semanticHead: {
				workflowId: request.workflowId,
				sequence: replay.head.sequence,
				eventDigest: replay.head.eventDigest,
				stateDigest: baselineDigest,
				epochRef: request.epochRef,
				generation: request.epochRef.storeEpoch,
			},
			expectedHead: replay.head,
			idempotencyKey,
			executionKey: request.executionKey,
			writerIdentity: leaseRef.writerIdentity,
			leaseRef,
			epochRef: request.epochRef,
		},
	});
}

describe("persisted workflow recovery process boundary", () => {
	it("blocks an ambiguous effect after replay instead of treating it as completed", async () => {
		const recovery = createPrimeWorkflowNoActiveAttemptRecovery({
			runtimeStore: recoveryFoldStore(recoveryFoldEffectEvents()),
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			epochRef: RECOVERY_FOLD_EPOCH,
			allowNoActiveAttemptRecovery: true,
		});

		await expect(recovery.recoverBeforeResume()).resolves.toMatchObject({ status: "blocked" });
		expect(recovery.readiness()).toMatchObject({ canRecover: false });
		expect(recovery.readiness().blockingReasons).toContain("workflow_effect_intent_outstanding");
	});

	it("blocks a quarantined lease after replay instead of treating it as released", async () => {
		const recovery = createPrimeWorkflowNoActiveAttemptRecovery({
			runtimeStore: recoveryFoldStore(recoveryFoldLeaseEvents()),
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			epochRef: RECOVERY_FOLD_EPOCH,
			allowNoActiveAttemptRecovery: true,
		});

		await expect(recovery.recoverBeforeResume()).resolves.toMatchObject({ status: "blocked" });
		expect(recovery.readiness()).toMatchObject({ canRecover: false });
		expect(recovery.readiness().blockingReasons).toContain("workflow_lease_outstanding");
	});

	it("blocks a fenced process group until an empty reaped proof is replayed", async () => {
		const recovery = createPrimeWorkflowNoActiveAttemptRecovery({
			runtimeStore: recoveryFoldStore(recoveryFoldFencedProcessEvents()),
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			epochRef: RECOVERY_FOLD_EPOCH,
			allowNoActiveAttemptRecovery: true,
		});

		await expect(recovery.recoverBeforeResume()).resolves.toMatchObject({ status: "blocked" });
		expect(recovery.readiness()).toMatchObject({ canRecover: false });
		expect(recovery.readiness().blockingReasons).toContain("workflow_process_binding_outstanding");
	});

	it("keeps a process group blocked when reaping leaves descendants", async () => {
		const recovery = createPrimeWorkflowNoActiveAttemptRecovery({
			runtimeStore: recoveryFoldStore(recoveryFoldReapedProcessEvents([43])),
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			epochRef: RECOVERY_FOLD_EPOCH,
			allowNoActiveAttemptRecovery: true,
		});

		await expect(recovery.recoverBeforeResume()).resolves.toMatchObject({ status: "blocked" });
		expect(recovery.readiness()).toMatchObject({ canRecover: false });
		expect(recovery.readiness().blockingReasons).toContain("workflow_process_binding_outstanding");
	});

	it("clears exactly one process group only after an empty reaped proof", async () => {
		const recovery = createPrimeWorkflowNoActiveAttemptRecovery({
			runtimeStore: recoveryFoldStore(recoveryFoldReapedProcessEvents([])),
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			epochRef: RECOVERY_FOLD_EPOCH,
			allowNoActiveAttemptRecovery: true,
		});

		await expect(recovery.recoverBeforeResume()).resolves.toMatchObject({ status: "started" });
		expect(recovery.readiness()).toMatchObject({ canRecover: true, blockingReasons: [] });
	});

	it("keeps a sibling process group blocked when only one exact group is reaped", async () => {
		const recovery = createPrimeWorkflowNoActiveAttemptRecovery({
			runtimeStore: recoveryFoldStore(recoveryFoldTwoProcessGroupsWithOneReaped()),
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			epochRef: RECOVERY_FOLD_EPOCH,
			allowNoActiveAttemptRecovery: true,
		});

		await expect(recovery.recoverBeforeResume()).resolves.toMatchObject({ status: "blocked" });
		expect(recovery.readiness()).toMatchObject({ canRecover: false });
		expect(recovery.readiness().blockingReasons).toContain("workflow_process_binding_outstanding");
	});

	it("keeps dispatch intent blocked when a lease release lacks a terminal outcome event", async () => {
		const recovery = createPrimeWorkflowNoActiveAttemptRecovery({
			runtimeStore: recoveryFoldStore(recoveryFoldReleasedDispatchEvents()),
			workflowId: RECOVERY_FOLD_WORKFLOW_ID,
			epochRef: RECOVERY_FOLD_EPOCH,
			allowNoActiveAttemptRecovery: true,
		});

		await expect(recovery.recoverBeforeResume()).resolves.toMatchObject({ status: "blocked" });
		expect(recovery.readiness()).toMatchObject({ canRecover: false });
		expect(recovery.readiness().blockingReasons).toContain("workflow_dispatch_intent_outstanding");
	});

	it("fails closed after reopen when the canonical production dependency seam is absent", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-runtime-recovery-process-"));
		await chmod(artifactRoot, 0o700);
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		let reopened: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: process.cwd(),
			detached: true,
			stdio: "ignore",
		});
		try {
			await waitForLive(child);
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "recovery-process-session",
				workflowId: "recovery-process-workflow",
				goalProjection: goalProjection(),
				genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
			});
			await host.dispose?.();
			host = undefined;
			reopened = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "recovery-process-session",
				workflowId: "recovery-process-workflow",
				goalProjection: goalProjection(),
				genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
			});

			expect(reopened.recoveryReadiness()).toMatchObject({ canRecover: false });
			expect(reopened.recoveryReadiness().blockingReasons).toContain(
				"workflow_recovery_dependency_seam_unavailable",
			);
			await expect(reopened.recoverBeforeResume()).rejects.toMatchObject({ code: "workflow_recovery_blocked" });
			await expect(reopened.recoverBeforeResumeResult()).resolves.toMatchObject({
				status: "blocked",
				binding: null,
				nonExecutionProof: null,
			});
			process.kill(child.pid ?? -1, 0);
		} finally {
			await stopChild(child).catch(() => undefined);
			await reopened?.dispose?.().catch(() => undefined);
			await host?.dispose?.().catch(() => undefined);
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("serializes concurrent reconciliation through the authenticated durable store claim", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-runtime-recovery-claim-"));
		await chmod(artifactRoot, 0o700);
		const workflowId = "w";
		const rootSessionId = "s";
		let lastConstruction: PersistedSessionWorkflowRecoveryConstructionInput | undefined;
		const makeDependencies = (construction: PersistedSessionWorkflowRecoveryConstructionInput) => {
			lastConstruction = construction;
			return recoveryDependencies(construction);
		};
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: goalProjection(),
				genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
				deferredOwnerValidators: deferredOwnerValidators(),
				runtimeRecoveryDependenciesFactory: makeDependencies,
			});
			const epochRef = await initializeDurableWorkflow(host, workflowId, rootSessionId);
			const request: WorkflowRecoveryRequest = {
				workflowId,
				taskId: "t",
				attemptId: "a",
				executionKey: "e",
				epochRef,
				persistedChildIdentity: null,
				evidenceRefs: [],
			};
			if (host.recovery === null) throw new Error("recovery adapter was not constructed");
			if (lastConstruction === undefined) throw new Error("recovery construction was not captured");
			const second = createWorkflowRuntimeRecoveryAdapter({
				...recoveryDependencies(lastConstruction),
				workflowId,
				runtimeStore: host.runtimeStore,
			});
			const [firstResult, secondResult] = await Promise.all([
				host.recovery.coordinator.reconcile(request),
				second.coordinator.reconcile(request),
			]);
			expect(firstResult.disposition).toBe("user_input_required");
			expect(secondResult.disposition).toBe("user_input_required");
			const third = createWorkflowRuntimeRecoveryAdapter({
				...recoveryDependencies(lastConstruction),
				workflowId,
				runtimeStore: host.runtimeStore,
			});
			await expect(third.coordinator.reconcile(request)).resolves.toMatchObject({
				disposition: "user_input_required",
			});
			const firstReplay = await host.runtimeStore.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: epochRef.storeEpoch,
			});
			expect(
				firstReplay.events.filter((event) => event.payload.kind === "workflow_reconciliation_recorded"),
			).toHaveLength(1);
			expect(firstReplay.events.filter((event) => event.payload.kind === "workflow_lease_quarantined")).toHaveLength(
				1,
			);
		} finally {
			await host?.dispose?.().catch(() => undefined);
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("keeps an observed foreign process alive when a persisted binding is stale after restart", async () => {
		if (process.platform === "win32") return;
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-runtime-recovery-identity-"));
		await chmod(artifactRoot, 0o700);
		const workflowId = "workflow-recovery-identity";
		const rootSessionId = "session-recovery-identity";
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: process.cwd(),
			detached: true,
			stdio: "ignore",
		});
		const quarantinedProcessGroups: WorkflowProcessGroupIdentity[] = [];
		let observedProcessGroup: WorkflowProcessGroupIdentity | undefined;
		let expectedProcessGroup: WorkflowProcessGroupIdentity | undefined;
		let currentAdmission: WorkflowAdmissionResult | undefined;
		let latestConstruction: PersistedSessionWorkflowRecoveryConstructionInput | undefined;
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		let reopened: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			await waitForLive(child);
			observedProcessGroup = readProcessGroupIdentity(child);
			const staleBase = {
				...observedProcessGroup,
				processStartId: `reused-${observedProcessGroup.processStartId}`,
			};
			expectedProcessGroup = {
				...staleBase,
				identityDigest: canonicalWorkflowProcessGroupDigest(staleBase),
			};
			const makeDependencies = (construction: PersistedSessionWorkflowRecoveryConstructionInput) => {
				latestConstruction = construction;
				return recoveryDependencies(construction, {
					admission: () => currentAdmission,
					observedProcessGroup,
					quarantinedProcessGroups,
				});
			};
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: goalProjection(),
				genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
				deferredOwnerValidators: deferredOwnerValidators(),
				runtimeRecoveryDependenciesFactory: makeDependencies,
			});
			await host.execute({
				kind: "start",
				request: {
					workflowId,
					objective: "recover a stale process binding",
					acceptanceChecks: ["foreign identities remain untouched"],
					protectedInvariants: ["the persisted expected identity is quarantined"],
				},
			});
			if (latestConstruction === undefined) throw new Error("recovery construction was not captured");
			const epochRef = latestConstruction.epochRef;
			const request: WorkflowRecoveryRequest = {
				workflowId,
				taskId: "task-recovery-identity",
				attemptId: "attempt-recovery-identity",
				executionKey: "execution-recovery-identity",
				epochRef,
				persistedChildIdentity: null,
				evidenceRefs: [],
			};
			if (
				latestConstruction === undefined ||
				expectedProcessGroup === undefined ||
				observedProcessGroup === undefined
			)
				throw new Error("recovery construction was not captured");
			currentAdmission = terminalAdmission(latestConstruction, request, expectedProcessGroup);
			await persistOwnedProcessGroup(host, request, expectedProcessGroup);
			await host.dispose?.();
			host = undefined;

			reopened = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: goalProjection(),
				genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
				deferredOwnerValidators: deferredOwnerValidators(),
				runtimeRecoveryDependenciesFactory: makeDependencies,
			});
			if (latestConstruction === undefined) throw new Error("reopened recovery construction was not captured");
			currentAdmission = terminalAdmission(latestConstruction, request, expectedProcessGroup);
			if (reopened.recovery === null) throw new Error("recovery adapter was not constructed after restart");

			const result = await reopened.recovery.coordinator.reconcile(request);

			expect(result.disposition).toBe("user_input_required");
			expect(quarantinedProcessGroups.map((identity) => identity.identityDigest)).not.toContain(
				observedProcessGroup.identityDigest,
			);
			expect(quarantinedProcessGroups.map((identity) => identity.identityDigest)).toContain(
				expectedProcessGroup.identityDigest,
			);
			process.kill(observedProcessGroup.pid, 0);
			const replay = await reopened.runtimeStore.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: epochRef.storeEpoch,
			});
			expect(replay.events.some((event) => event.payload.kind === "workflow_reconciliation_recorded")).toBe(true);
			const leaseQuarantine = replay.events.find((event) => event.payload.kind === "workflow_lease_quarantined");
			expect(leaseQuarantine?.payload).toMatchObject({
				kind: "workflow_lease_quarantined",
				reason: "workflow_terminal_process_recovery_uncertain",
			});
		} finally {
			await stopChild(child).catch(() => undefined);
			await reopened?.dispose?.().catch(() => undefined);
			await host?.dispose?.().catch(() => undefined);
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});
});
