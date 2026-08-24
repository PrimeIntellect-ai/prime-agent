import { describe, expect, it } from "vitest";
import type { WorkflowAdmissionResult } from "../../src/core/workflow/admission.js";
import type {
	WorkflowChildAuthority,
	WorkflowChildIdentity,
	WorkflowChildProcessBinding,
	WorkflowEpochRef,
	WorkflowLeaseRef,
	WorkflowPhaseOutcomeRecord,
	WorkflowProcessGroupIdentity,
	WorkflowRuntimeEventPayload,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreIdentity,
	WorkflowStoreReplayResult,
} from "../../src/core/workflow/contracts.js";
import { digestObject } from "../../src/core/workflow/contracts.js";
import {
	canonicalWorkflowEffectOwnershipTokenDigest,
	type WorkflowEffectExecutionContext,
} from "../../src/core/workflow/effect-broker.js";
import type { WorkflowLeaseAdmissionState } from "../../src/core/workflow/leases.js";
import {
	canonicalWorkflowBindingDigest,
	canonicalWorkflowIdentityDigest,
	canonicalWorkflowProcessGroupDigest,
} from "../../src/core/workflow/process-groups.js";
import {
	createWorkflowRuntimeRecoveryCoordinator,
	type WorkflowReconciliationOutcome,
	type WorkflowRecoveryRequest,
	type WorkflowRuntimeRecoveryDependencies,
	type WorkflowRuntimeRecoveryNoStartEvidence,
} from "../../src/core/workflow/runtime-recovery.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const WORKFLOW_ID = "workflow-runtime-recovery";
const LEASE: WorkflowLeaseRef = {
	...EPOCH,
	leaseId: "lease-runtime-recovery",
	acquisitionEventSequence: 1,
	processIdentity: "process-runtime-recovery",
	rootDigest: "root-runtime-recovery",
	writerIdentity: "writer-runtime-recovery",
	acquiredAt: "2030-01-01T00:00:00.000Z",
	expiresAt: "2030-01-01T00:10:00.000Z",
};

function group(overrides: Partial<WorkflowProcessGroupIdentity> = {}): WorkflowProcessGroupIdentity {
	const base = {
		pid: 42,
		processStartId: "start-42",
		processGroupId: "group-42",
		parentPid: 1,
		...overrides,
	};
	return { ...base, identityDigest: canonicalWorkflowProcessGroupDigest(base) };
}

function childIdentity(overrides: Partial<WorkflowChildIdentity> = {}): WorkflowChildIdentity {
	const base = {
		admissionId: "admission:execution-runtime-recovery",
		childSessionId: "child-runtime-recovery",
		processGroupId: "group-42",
		executionKey: "execution-runtime-recovery",
		epochRef: EPOCH,
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-runtime-recovery",
		agentRole: "worker",
		modelId: "model-runtime-recovery",
		reasoningEffort: "medium",
		launchConfigDigest: "launch-runtime-recovery",
		...overrides,
	};
	return { ...base, identityDigest: canonicalWorkflowIdentityDigest(base) };
}

function binding(): WorkflowChildProcessBinding {
	const identity = childIdentity();
	const processGroup = group();
	return {
		workflowId: WORKFLOW_ID,
		taskId: "task-runtime-recovery",
		attemptId: "attempt-runtime-recovery",
		childIdentity: identity,
		processGroup,
		bindingDigest: canonicalWorkflowBindingDigest({ childIdentity: identity, processGroup }),
	};
}

function context(
	overrides: Pick<Partial<WorkflowAdmissionResult["context"]>, "ownershipLeaseRef"> = {},
): WorkflowAdmissionResult["context"] {
	return {
		workflowId: WORKFLOW_ID,
		rootSessionId: "session-runtime-recovery",
		taskId: "task-runtime-recovery",
		attemptId: "attempt-runtime-recovery",
		executionKey: "execution-runtime-recovery",
		idempotencyKey: "admission-runtime-recovery",
		decisionRef: {
			decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: "session-runtime-recovery" },
			decisionId: "decision-runtime-recovery",
			revision: 1,
			storeEpoch: EPOCH.storeEpoch,
			decisionDigest: "decision-runtime-recovery",
		},
		resourceLeaseRef: LEASE,
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
			capabilities: ["read_only"],
			writeClass: "read_only",
			parentAttemptId: null,
			rootSpawned: true,
		} satisfies WorkflowChildAuthority,
		launchConfigDigest: "launch-runtime-recovery",
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-runtime-recovery",
		agentRole: "worker",
		modelId: "model-runtime-recovery",
		reasoningEffort: "medium",
		expectedEffectDigest: "expected-effect-runtime-recovery",
		epochRef: EPOCH,
		configSnapshotDigest: "config-runtime-recovery",
		revisionTuple: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			configRevision: 1,
			evidenceRevision: 1,
		},
		revisionRegistryRef: {
			artifactId: "revision-runtime-recovery",
			relativePath: "revision/runtime-recovery",
			digest: "revision-runtime-recovery",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		revisionRegistryDigest: "revision-registry-runtime-recovery",
		writerIdentity: LEASE.writerIdentity,
		...overrides,
	};
}

function admission(overrides: Partial<WorkflowAdmissionResult> = {}): WorkflowAdmissionResult {
	const currentContext = context(overrides.context === undefined ? {} : overrides.context);
	const currentBinding = overrides.processBinding === undefined ? null : overrides.processBinding;
	return {
		admissionId: "admission:execution-runtime-recovery",
		lifecycle: {
			workflowId: WORKFLOW_ID,
			taskId: currentContext.taskId,
			attemptId: currentContext.attemptId,
			status: overrides.status ?? (currentBinding === null ? "admitted" : "running"),
			childIdentity: currentBinding?.childIdentity ?? null,
			childAuthority: currentContext.childAuthority,
			admissionEventSequence: 1,
			terminalEventSequence: overrides.terminalEventSequence ?? null,
			epochRef: EPOCH,
			statusDigest: "status-runtime-recovery",
		},
		status: overrides.status ?? (currentBinding === null ? "admitted" : "running"),
		childIdentity: currentBinding?.childIdentity ?? null,
		processBinding: currentBinding,
		admissionEventSequence: 1,
		terminalEventSequence: overrides.terminalEventSequence ?? null,
		outcomeDigest: overrides.outcomeDigest ?? null,
		...overrides,
		context: currentContext,
	};
}

function terminalOutcome(): WorkflowPhaseOutcomeRecord {
	return {
		attemptStatus: "completed",
		outcome: {
			workflowId: WORKFLOW_ID,
			phaseAttemptId: "attempt-runtime-recovery",
			epochRef: EPOCH,
			invocationToken: "execution-runtime-recovery",
			inputStateDigest: "expected-effect-runtime-recovery",
			status: "complete",
			outputStateDigest: "output-runtime-recovery",
			artifactRefs: [],
			evidenceRefs: [],
		},
	};
}

function effectContextFor(current: WorkflowAdmissionResult, idempotencyKey: string): WorkflowEffectExecutionContext {
	const revisionBoundary = {
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		leaseRef: LEASE,
		executionKey: current.context.executionKey,
		revisionTuple: current.context.revisionTuple,
		revisionRegistryRef: current.context.revisionRegistryRef,
		revisionRegistryDigest: current.context.revisionRegistryDigest,
		configSnapshotDigest: current.context.configSnapshotDigest,
	};
	const ownershipToken = {
		tokenId: "effect-context-token",
		workflowId: WORKFLOW_ID,
		taskId: current.context.taskId,
		attemptId: current.context.attemptId,
		executionKey: current.context.executionKey,
		epochRef: EPOCH,
		resourceLeaseRef: LEASE,
		ownershipLeaseRef: LEASE,
	};
	return {
		workflowId: WORKFLOW_ID,
		taskId: current.context.taskId,
		attemptId: current.context.attemptId,
		executionKey: current.context.executionKey,
		epochRef: EPOCH,
		idempotencyKey,
		decisionRef: current.context.decisionRef,
		revisionBoundary: { ...revisionBoundary, tupleDigest: digestObject(revisionBoundary) },
		approvalResponse: null,
		leaseRef: LEASE,
		resourceLeaseRef: LEASE,
		ownershipLeaseRef: LEASE,
		ownershipToken: {
			...ownershipToken,
			tokenDigest: canonicalWorkflowEffectOwnershipTokenDigest(ownershipToken),
		},
	};
}

function runtimeEventStore(
	events: readonly WorkflowRuntimeEventPayload[],
	commitError?: Error,
	eventsRef?: { current: readonly WorkflowRuntimeEventPayload[] },
): WorkflowRuntimeStore {
	const identity: WorkflowRuntimeStoreIdentity = {
		storeKind: "workflow",
		namespace: "test",
		rootDir: "/tmp/workflow-runtime-recovery",
		storeId: "store-runtime-recovery",
		workflowId: WORKFLOW_ID,
		identityDigest: "store-runtime-recovery",
	};
	return {
		identity,
		commit: async (input) => {
			if (commitError !== undefined) throw commitError;
			const eventDigest = digestObject({
				priorEventDigest: input.expectedHead.eventDigest,
				payload: input.payload,
			});
			return {
				status: "committed",
				payload: input.payload,
				commit: {
					workflowId: input.workflowId,
					sequence: input.expectedHead.sequence + 1,
					payload: input.payload,
					payloadBytes: new Uint8Array(),
					payloadDigest: digestObject(input.payload),
					priorEventDigest: input.expectedHead.eventDigest,
					eventDigest,
					recordVersion: 1,
					generationId: "generation-runtime-recovery",
					recordMac: "mac-runtime-recovery",
					recordChecksum: "checksum-runtime-recovery",
					expectedHead: input.expectedHead,
					epochRef: input.epochRef,
					leaseRef: input.leaseRef,
					idempotencyKey: input.idempotencyKey,
					returnProofId: "return-proof-runtime-recovery",
					commitReturnProof: {} as never,
					preparedFrameDigest: "prepared-frame-runtime-recovery",
					committedFrameDigest: "committed-frame-runtime-recovery",
					keyId: "key-runtime-recovery",
					preparedFrameMac: "prepared-mac-runtime-recovery",
					committedFrameMac: "committed-mac-runtime-recovery",
					preparedFrameChecksum: "prepared-checksum-runtime-recovery",
					committedFrameChecksum: "committed-checksum-runtime-recovery",
					semanticBinding: input.semanticBinding,
					executionKey: input.executionKey,
					writerIdentity: input.writerIdentity,
				},
				state: null,
				head: {
					...input.expectedHead,
					sequence: input.expectedHead.sequence + 1,
					eventDigest,
				},
			} as never;
		},
		replay: async (): Promise<WorkflowStoreReplayResult> => {
			const currentEvents = eventsRef?.current ?? events;
			return {
				workflowId: WORKFLOW_ID,
				executionKey: null,
				events: currentEvents.map((payload, index) => ({ payload, idempotencyKey: `event-${index}` })) as never,
				head: {
					workflowId: WORKFLOW_ID,
					sequence: currentEvents.length,
					eventDigest: currentEvents.length === 0 ? null : digestObject(currentEvents.at(-1)),
					epochRef: EPOCH,
				},
				quarantined: false,
				quarantineReason: null,
			};
		},
		publishArtifact: async () => undefined as never,
		publishSnapshot: async () => undefined as never,
		compareAndSwapProjection: async () => "applied",
		appendOutbox: async () => undefined as never,
		replaceCoordinatorEpoch: async () => undefined as never,
		replaceStoreEpoch: async () => undefined as never,
	};
}

function dependencies(
	input: {
		admissionResult?: WorkflowAdmissionResult;
		events?: readonly WorkflowRuntimeEventPayload[];
		eventsRef?: { current: readonly WorkflowRuntimeEventPayload[] };
		verifyChild?: boolean;
		verifyChildRef?: { current: boolean };
		verifyGate?: Promise<void>;
		verifyStarted?: () => void;
		lookupError?: Error;
		reapRemainingPids?: readonly number[];
		effectStatus?: "already_completed" | "completed" | "ambiguous" | "quarantined";
		staleEpoch?: boolean;
		scanUnknownDescendantsError?: Error;
		groupQuarantineError?: Error;
		admissionQuarantineError?: Error;
		leaseQuarantineError?: Error;
		storeCommitError?: Error;
		effectContext?: WorkflowEffectExecutionContext;
		effectContextObserved?: (context: WorkflowEffectExecutionContext | undefined) => void;
	} = {},
): {
	dependencies: WorkflowRuntimeRecoveryDependencies;
	counts: {
		verify: number;
		hydrate: number;
		reconcile: number;
		release: number;
		quarantine: number;
		groupQuarantine: number;
		terminate: number;
		reap: number;
		admissionQuarantine: number;
	};
} {
	const counts = {
		verify: 0,
		hydrate: 0,
		reconcile: 0,
		release: 0,
		quarantine: 0,
		groupQuarantine: 0,
		terminate: 0,
		reap: 0,
		admissionQuarantine: 0,
	};
	let leaseStatus: WorkflowLeaseAdmissionState["leaseStatus"] = "active";
	const currentAdmission = input.admissionResult;
	const recoveryClaims = new Map<
		string,
		{ readonly status: "held" } | { readonly status: "completed"; readonly outcome: WorkflowReconciliationOutcome }
	>();
	const dependencies: WorkflowRuntimeRecoveryDependencies = {
		workflowId: WORKFLOW_ID,
		store: runtimeEventStore(input.events ?? [], input.storeCommitError, input.eventsRef),
		epochs: {
			assertCurrent: async () => {
				if (input.staleEpoch === true) throw new Error("workflow_epoch_stale");
			},
		},
		admission: {
			hydrateFromReplay: async () => {
				counts.hydrate += 1;
			},
			hydrateQuarantineFromReplay: async () => {
				counts.hydrate += 1;
			},
			lookupByExecutionKey: async () => {
				if (input.lookupError !== undefined) throw input.lookupError;
				return currentAdmission;
			},
			quarantine: async () => {
				if (input.admissionQuarantineError !== undefined) throw input.admissionQuarantineError;
				counts.admissionQuarantine += 1;
				return currentAdmission ?? admission();
			},
		},
		leases: {
			hydrateFromReplay: async () => {
				counts.hydrate += 1;
			},
			lookupByLease: async (): Promise<WorkflowLeaseAdmissionState | undefined> =>
				currentAdmission === undefined
					? undefined
					: {
							terminalEventSequence: currentAdmission.terminalEventSequence,
							executionKey: currentAdmission.context.executionKey,
							outcomeDigest: currentAdmission.outcomeDigest,
							leaseStatus,
						},
			release: async () => {
				counts.release += 1;
				leaseStatus = "released";
				return { status: "released", leaseRef: LEASE, releaseEventSequence: 2, epochRef: EPOCH };
			},
			quarantine: async () => {
				if (input.leaseQuarantineError !== undefined) throw input.leaseQuarantineError;
				counts.quarantine += 1;
				leaseStatus = "quarantined";
				return { leaseRef: LEASE, status: "quarantined", reason: "runtime-recovery-test" };
			},
		},
		groups: {
			hydrateFromReplay: async () => {
				counts.hydrate += 1;
			},
			verify: async () => {
				counts.verify += 1;
				input.verifyStarted?.();
				await input.verifyGate;
				return input.verifyChild ?? false;
			},
			inspect: async (identity) => ({
				identity,
				verified: input.verifyChild ?? false,
				remainingPids: [],
				evidenceDigest: "inspection-runtime-recovery",
			}),
			terminate: async () => {
				counts.terminate += 1;
			},
			reap: async () => {
				counts.reap += 1;
				return {
					remainingPids: input.reapRemainingPids ?? [],
					reapDigest: "reap-runtime-recovery",
					reapEventSequence: 1,
				};
			},
			quarantine: async () => {
				if (input.groupQuarantineError !== undefined) throw input.groupQuarantineError;
				counts.groupQuarantine += 1;
			},
			scanUnknownDescendants: async () => {
				if (input.scanUnknownDescendantsError !== undefined) throw input.scanUnknownDescendantsError;
				return [];
			},
		},
		processContainmentVerifier: {
			readCurrentHostIdentity: async () => group({ pid: process.pid, processGroupId: "host-runtime-recovery" }),
			verify: async (identity) => {
				input.verifyStarted?.();
				await input.verifyGate;
				return {
					identity,
					verified: input.verifyChildRef?.current ?? input.verifyChild ?? false,
					remainingPids: [],
					evidenceDigest: "containment-runtime-recovery",
					containment: {
						membershipVerified: true,
						descendantsContained: true,
						killOnClose: true,
						attestationDigest: "attestation-runtime-recovery",
					},
				};
			},
		},
		effects: {
			reconcile: async (_effect, _idempotencyKey, _epochRef, context?: WorkflowEffectExecutionContext) => {
				input.effectContextObserved?.(context);
				counts.reconcile += 1;
				return { status: input.effectStatus ?? "ambiguous", resultDigest: null, evidenceArtifact: null };
			},
		},
		recoveryClaims: {
			acquire: async (claim) => {
				const existing = recoveryClaims.get(claim.claimId);
				if (existing?.status === "completed") return existing;
				if (existing?.status === "held") return existing;
				recoveryClaims.set(claim.claimId, { status: "held" });
				return { status: "acquired" };
			},
			complete: async (claim, outcome) => {
				recoveryClaims.set(claim.claimId, { status: "completed", outcome });
			},
			release: async (claim) => {
				recoveryClaims.delete(claim.claimId);
			},
		},
		readKnownRecoveryBindings: async () => ({
			admission: currentAdmission,
			processGroups:
				currentAdmission?.processBinding?.processGroup === undefined
					? []
					: [currentAdmission.processBinding.processGroup],
		}),
		readEffectReconciliationContext:
			input.effectContext === undefined ? undefined : async () => input.effectContext ?? null,
		writerIdentity: LEASE.writerIdentity,
		activeLeaseRef: LEASE,
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-runtime-recovery",
		readCurrentHostCapabilityRevision: async () => "host-runtime-recovery",
		readTrustedNow: async () => "2030-01-01T00:05:00.000Z",
		capabilities: {
			processIdentity: true,
			effectResolution: true,
			capabilityDigest: "capability-runtime-recovery",
		},
		readWorkspaceDigest: async () => "workspace-runtime-recovery",
	};
	return { dependencies, counts };
}

describe("workflow runtime recovery", () => {
	it("reattaches the exact live child without spawning or executing an effect", async () => {
		const persisted = binding();
		const fixture = dependencies({ admissionResult: admission({ processBinding: persisted }), verifyChild: true });
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			executionKey: persisted.childIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		});
		expect(result.disposition).toBe("reattached");
		expect(result.observedChildIdentity).toEqual(persisted.childIdentity);
		expect(result.observedProcessGroupId).toBe(persisted.processGroup.processGroupId);
		expect(fixture.counts.reconcile).toBe(0);
	});

	it("does not replay a prior reattachment after the current identity stops verifying", async () => {
		const persisted = binding();
		const priorOutcome: WorkflowReconciliationOutcome = {
			workflowId: WORKFLOW_ID,
			reconciliationAttemptId: "prior-reconciliation",
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			disposition: "reattached",
			persistedChildIdentity: persisted.childIdentity,
			observedChildIdentity: persisted.childIdentity,
			observedProcessGroupId: persisted.processGroup.processGroupId,
			observedTranscriptDigest: null,
			observedWorkspaceDigest: "workspace-runtime-recovery",
			epochRef: EPOCH,
			evidenceRefs: [],
			stateDigest: "prior-reconciliation-state",
		};
		const fixture = dependencies({
			admissionResult: admission({ processBinding: persisted }),
			events: [
				{
					kind: "workflow_process_group_owned",
					workflowId: WORKFLOW_ID,
					attemptId: persisted.attemptId,
					processGroup: persisted.processGroup,
					epochRef: EPOCH,
				},
				{
					kind: "workflow_reconciliation_recorded",
					workflowId: WORKFLOW_ID,
					attemptId: persisted.attemptId,
					epochRef: EPOCH,
					outcome: priorOutcome,
					outcomeDigest: digestObject(priorOutcome),
				},
			],
			verifyChild: false,
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			executionKey: persisted.childIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.groupQuarantine).toBe(1);
	});

	it("does not reuse a completed reattachment claim after the identity changes", async () => {
		const persisted = binding();
		const verifyChildRef = { current: true };
		const eventsRef: { current: readonly WorkflowRuntimeEventPayload[] } = { current: [] };
		const fixture = dependencies({
			admissionResult: admission({ processBinding: persisted }),
			eventsRef,
			verifyChildRef,
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);
		const request: WorkflowRecoveryRequest = {
			workflowId: WORKFLOW_ID,
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			executionKey: persisted.childIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		};

		expect((await coordinator.reconcile(request)).disposition).toBe("reattached");
		verifyChildRef.current = false;
		eventsRef.current = [
			{
				kind: "workflow_process_group_owned",
				workflowId: WORKFLOW_ID,
				attemptId: persisted.attemptId,
				processGroup: persisted.processGroup,
				epochRef: EPOCH,
			},
		];

		const result = await coordinator.reconcile(request);

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.groupQuarantine).toBe(1);
	});

	it("does not accept a persisted child identity without an exact admission binding", async () => {
		const orphanIdentity = childIdentity();
		const priorOutcome: WorkflowReconciliationOutcome = {
			workflowId: WORKFLOW_ID,
			reconciliationAttemptId: "orphan-prior-reconciliation",
			taskId: "task-runtime-recovery",
			attemptId: "attempt-runtime-recovery",
			disposition: "completed",
			persistedChildIdentity: orphanIdentity,
			observedChildIdentity: null,
			observedProcessGroupId: null,
			observedTranscriptDigest: null,
			observedWorkspaceDigest: "workspace-runtime-recovery",
			epochRef: EPOCH,
			evidenceRefs: [],
			stateDigest: "orphan-prior-state",
		};
		const fixture = dependencies({
			admissionResult: admission({ childIdentity: orphanIdentity, processBinding: null }),
			events: [
				{
					kind: "workflow_reconciliation_recorded",
					workflowId: WORKFLOW_ID,
					attemptId: "attempt-runtime-recovery",
					epochRef: EPOCH,
					outcome: priorOutcome,
					outcomeDigest: digestObject(priorOutcome),
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: "task-runtime-recovery",
			attemptId: "attempt-runtime-recovery",
			executionKey: orphanIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: orphanIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
	});

	it("rechecks a cached non-reattached outcome against live containment", async () => {
		const persisted = binding();
		const priorOutcome: WorkflowReconciliationOutcome = {
			workflowId: WORKFLOW_ID,
			reconciliationAttemptId: "cached-corrective-reconciliation",
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			disposition: "corrective_work_required",
			persistedChildIdentity: persisted.childIdentity,
			observedChildIdentity: persisted.childIdentity,
			observedProcessGroupId: persisted.processGroup.processGroupId,
			observedTranscriptDigest: null,
			observedWorkspaceDigest: "workspace-runtime-recovery",
			epochRef: EPOCH,
			evidenceRefs: [],
			stateDigest: "cached-corrective-state",
		};
		const fixture = dependencies({
			admissionResult: admission({ processBinding: persisted }),
			verifyChild: false,
			events: [
				{
					kind: "workflow_process_group_owned",
					workflowId: WORKFLOW_ID,
					attemptId: persisted.attemptId,
					processGroup: persisted.processGroup,
					epochRef: EPOCH,
				},
				{
					kind: "workflow_reconciliation_recorded",
					workflowId: WORKFLOW_ID,
					attemptId: persisted.attemptId,
					epochRef: EPOCH,
					outcome: priorOutcome,
					outcomeDigest: digestObject(priorOutcome),
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			executionKey: persisted.childIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.groupQuarantine).toBe(1);
	});

	it("blocks start recovery when its caller identity is not admission-bound", async () => {
		const orphanIdentity = childIdentity();
		const fixture = dependencies({
			admissionResult: admission({ childIdentity: orphanIdentity, processBinding: null }),
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.startRecovery({
			workflowId: WORKFLOW_ID,
			taskId: "task-runtime-recovery",
			attemptId: "attempt-runtime-recovery",
			executionKey: orphanIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: orphanIdentity,
			evidenceRefs: [],
		});

		expect(result.status).toBe("blocked");
	});

	it("rejects a same-group-id replay when the persisted pid and start identity changed", async () => {
		const persisted = binding();
		const replacementGroup = group({ pid: 43, processStartId: "start-43" });
		const replacementBinding: WorkflowChildProcessBinding = {
			...persisted,
			processGroup: replacementGroup,
			bindingDigest: canonicalWorkflowBindingDigest({
				childIdentity: persisted.childIdentity,
				processGroup: replacementGroup,
			}),
		};
		const priorOutcome: WorkflowReconciliationOutcome = {
			workflowId: WORKFLOW_ID,
			reconciliationAttemptId: "same-group-id-prior",
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			disposition: "reattached",
			persistedChildIdentity: persisted.childIdentity,
			observedChildIdentity: persisted.childIdentity,
			observedProcessGroupId: persisted.processGroup.processGroupId,
			observedTranscriptDigest: null,
			observedWorkspaceDigest: "workspace-runtime-recovery",
			epochRef: EPOCH,
			evidenceRefs: [],
			stateDigest: "same-group-id-prior-state",
		};
		const fixture = dependencies({
			admissionResult: admission({ processBinding: replacementBinding }),
			events: [
				{
					kind: "workflow_process_group_owned",
					workflowId: WORKFLOW_ID,
					attemptId: persisted.attemptId,
					processGroup: persisted.processGroup,
					epochRef: EPOCH,
				},
				{
					kind: "workflow_reconciliation_recorded",
					workflowId: WORKFLOW_ID,
					attemptId: persisted.attemptId,
					epochRef: EPOCH,
					outcome: priorOutcome,
					outcomeDigest: digestObject(priorOutcome),
				},
			],
			verifyChild: true,
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			executionKey: persisted.childIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.groupQuarantine).toBe(1);
	});

	it("does not reattach a live child from a quarantined admission", async () => {
		const persisted = binding();
		const fixture = dependencies({
			admissionResult: admission({ status: "quarantined", processBinding: persisted }),
			verifyChild: true,
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			executionKey: persisted.childIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.verify).toBe(0);
	});

	it("folds a committed terminal outcome and releases each lease once across duplicate restart", async () => {
		const outcome = terminalOutcome();
		const current = admission({
			status: "completed",
			terminalEventSequence: 2,
			outcomeDigest: digestObject(outcome),
		});
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_child_outcome_committed",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					outcome,
					outcomeDigest: digestObject(outcome),
					epochRef: EPOCH,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);
		const request: WorkflowRecoveryRequest = {
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		};

		expect((await coordinator.reconcile(request)).disposition).toBe("completed");
		expect((await coordinator.reconcile(request)).disposition).toBe("completed");
		expect(fixture.counts.release).toBe(1);
	});

	it("reaps a live terminal process group before releasing its leases", async () => {
		const persisted = binding();
		const outcome = terminalOutcome();
		const current = admission({
			status: "completed",
			processBinding: persisted,
			terminalEventSequence: 2,
			outcomeDigest: digestObject(outcome),
		});
		const fixture = dependencies({
			admissionResult: current,
			verifyChild: true,
			events: [
				{
					kind: "workflow_child_outcome_committed",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					outcome,
					outcomeDigest: digestObject(outcome),
					epochRef: EPOCH,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("completed");
		expect(fixture.counts.terminate).toBe(1);
		expect(fixture.counts.reap).toBe(1);
		expect(fixture.counts.release).toBe(1);
	});

	it("does not release terminal leases while an effect result remains ambiguous", async () => {
		const outcome = terminalOutcome();
		const current = admission({
			status: "completed",
			context: context({ ownershipLeaseRef: LEASE }),
			terminalEventSequence: 3,
			outcomeDigest: digestObject(outcome),
		});
		const effect = {
			kind: "file_read" as const,
			operationId: "terminal-ambiguous-effect",
			path: "workspace/input.txt",
			pathDigest: "terminal-ambiguous-path",
		};
		const effectIdempotencyKey = "terminal-ambiguous-effect-key";
		const fixture = dependencies({
			admissionResult: current,
			effectStatus: "ambiguous",
			effectContext: effectContextFor(current, effectIdempotencyKey),
			events: [
				{
					kind: "workflow_effect_intent",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					effectDigest: digestObject(effect),
					decisionRef: current.context.decisionRef,
					epochRef: EPOCH,
					idempotencyKey: effectIdempotencyKey,
					effect,
				},
				{
					kind: "workflow_child_outcome_committed",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					outcome,
					outcomeDigest: digestObject(outcome),
					epochRef: EPOCH,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.reconcile).toBe(1);
		expect(fixture.counts.release).toBe(0);
		expect(fixture.counts.quarantine).toBe(1);
	});

	it.each(["failed", "blocked", "needs_fix", "cancelled"] as const)(
		"does not classify terminal %s as completed",
		async (status) => {
			const outcome = { ...terminalOutcome(), attemptStatus: status } as WorkflowPhaseOutcomeRecord;
			const current = admission({
				status,
				terminalEventSequence: 2,
				outcomeDigest: digestObject(outcome),
			});
			const fixture = dependencies({
				admissionResult: current,
				events: [
					{
						kind: "workflow_child_outcome_committed",
						workflowId: WORKFLOW_ID,
						attemptId: current.context.attemptId,
						executionKey: current.context.executionKey,
						outcome,
						outcomeDigest: digestObject(outcome),
						epochRef: EPOCH,
					},
				],
			});
			const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

			const result = await coordinator.reconcile({
				workflowId: WORKFLOW_ID,
				taskId: current.context.taskId,
				attemptId: current.context.attemptId,
				executionKey: current.context.executionKey,
				epochRef: EPOCH,
				persistedChildIdentity: null,
				evidenceRefs: [],
			});

			expect(result.disposition).toBe(status === "failed" ? "failed" : "corrective_work_required");
		},
	);

	it("quarantines a terminal event whose authenticated outcome digest conflicts", async () => {
		const outcome = terminalOutcome();
		const current = admission({
			status: "completed",
			terminalEventSequence: 2,
			outcomeDigest: digestObject(outcome),
		});
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_child_outcome_committed",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					outcome,
					outcomeDigest: "forged-terminal-digest",
					epochRef: EPOCH,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.release).toBe(0);
		expect(fixture.counts.quarantine).toBe(1);
	});

	it("does not accept caller-authenticated no-start evidence without a host resolver", async () => {
		const current = admission();
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_dispatch_intent",
					workflowId: WORKFLOW_ID,
					taskId: current.context.taskId,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					admissionId: "admission:execution-runtime-recovery",
					epochRef: EPOCH,
					decisionRef: current.context.decisionRef,
					resourceLeaseRef: LEASE,
					ownershipLeaseRef: null,
					childAuthority: current.context.childAuthority,
					launchConfigDigest: current.context.launchConfigDigest,
					expectedEffectDigest: current.context.expectedEffectDigest,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator({
			...fixture.dependencies,
			readNoStartEvidence: async () =>
				({
					preExecutionBaseline: { authenticated: true },
					postObservation: { authenticated: true },
					proofDigest: "caller-self-hash",
				}) as unknown as WorkflowRuntimeRecoveryNoStartEvidence,
		});

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.verify).toBe(0);
		expect(fixture.counts.reconcile).toBe(0);
		expect(fixture.counts.release).toBe(0);
	});

	it("does not infer no-start from a dispatch intent when workspace evidence is unavailable", async () => {
		const current = admission();
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_dispatch_intent",
					workflowId: WORKFLOW_ID,
					taskId: current.context.taskId,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					admissionId: current.admissionId,
					epochRef: EPOCH,
					decisionRef: current.context.decisionRef,
					resourceLeaseRef: LEASE,
					ownershipLeaseRef: null,
					childAuthority: current.context.childAuthority,
					launchConfigDigest: current.context.launchConfigDigest,
					expectedEffectDigest: current.context.expectedEffectDigest,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator({
			...fixture.dependencies,
			readWorkspaceDigest: undefined,
		});

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
	});

	it("does not infer no-start from the coordinator's synthetic workspace digest", async () => {
		const current = admission();
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_dispatch_intent",
					workflowId: WORKFLOW_ID,
					taskId: current.context.taskId,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					admissionId: current.admissionId,
					epochRef: EPOCH,
					decisionRef: current.context.decisionRef,
					resourceLeaseRef: LEASE,
					ownershipLeaseRef: null,
					childAuthority: current.context.childAuthority,
					launchConfigDigest: current.context.launchConfigDigest,
					expectedEffectDigest: current.context.expectedEffectDigest,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator({
			...fixture.dependencies,
			readWorkspaceDigest: async (request) =>
				digestObject({
					workflowId: request.workflowId,
					taskId: request.taskId,
					attemptId: request.attemptId,
					executionKey: request.executionKey,
					epochRef: request.epochRef,
				}),
		});

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
	});

	it("does not treat an arbitrary workspace digest as proof of non-execution", async () => {
		const current = admission();
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_dispatch_intent",
					workflowId: WORKFLOW_ID,
					taskId: current.context.taskId,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					admissionId: current.admissionId,
					epochRef: EPOCH,
					decisionRef: current.context.decisionRef,
					resourceLeaseRef: LEASE,
					ownershipLeaseRef: null,
					childAuthority: current.context.childAuthority,
					launchConfigDigest: current.context.launchConfigDigest,
					expectedEffectDigest: current.context.expectedEffectDigest,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator({
			...fixture.dependencies,
			readWorkspaceDigest: async () => "authenticated-workspace-observation",
		});

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
	});

	it("exposes an integration-ready recovery binding and non-execution proof slot", async () => {
		const persisted = binding();
		const current = admission({ processBinding: persisted });
		const fixture = dependencies({ admissionResult: current, verifyChild: true });
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);
		const request: WorkflowRecoveryRequest = {
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		};

		const result = await (
			coordinator.startRecovery as unknown as (request: WorkflowRecoveryRequest) => Promise<{
				binding: { workflowId: string; taskId: string; attemptId: string; executionKey: string } | null;
				nonExecutionProof: string | null;
			}>
		)(request);

		expect(result).toMatchObject({
			binding: {
				workflowId: WORKFLOW_ID,
				taskId: current.context.taskId,
				attemptId: current.context.attemptId,
				executionKey: current.context.executionKey,
			},
			nonExecutionProof: null,
		});
	});

	it("proves a crash before admission did not execute anything", async () => {
		const fixture = dependencies();
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: "task-runtime-recovery",
			attemptId: "attempt-before-admission",
			executionKey: "execution-before-admission",
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.verify).toBe(0);
		expect(fixture.counts.reconcile).toBe(0);
		expect(fixture.counts.release).toBe(0);
	});

	it("quarantines known ownership when admission lookup fails", async () => {
		const persisted = binding();
		const current = admission({ processBinding: persisted });
		const fixture = dependencies({ admissionResult: current, lookupError: new Error("admission store unavailable") });
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.groupQuarantine).toBe(1);
		expect(fixture.counts.quarantine).toBe(1);
		expect(fixture.counts.release).toBe(0);
	});

	it("quarantines a process group owned before child binding", async () => {
		const current = admission({ status: "running" });
		const processGroup = group();
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_process_group_owned",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					processGroup,
					epochRef: EPOCH,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(result.observedProcessGroupId).toBe(processGroup.processGroupId);
		expect(fixture.counts.groupQuarantine).toBe(1);
		expect(fixture.counts.release).toBe(0);
	});

	it("quarantines every process group when persisted ownership disagrees with an owned event", async () => {
		const persisted = binding();
		const current = admission({ processBinding: persisted });
		const foreignGroup = group({ processGroupId: "foreign-owned-group" });
		const fixture = dependencies({
			admissionResult: current,
			verifyChild: true,
			events: [
				{
					kind: "workflow_process_group_owned",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					processGroup: foreignGroup,
					epochRef: EPOCH,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.groupQuarantine).toBe(2);
		expect(fixture.counts.verify).toBe(0);
	});

	it("quarantines an effect intent with no committed result and never re-executes it", async () => {
		const current = admission({ status: "running" });
		const effect = {
			kind: "file_read" as const,
			operationId: "effect-runtime-recovery",
			path: "workspace/input.txt",
			pathDigest: "path-runtime-recovery",
		};
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_effect_intent",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					effectDigest: digestObject(effect),
					decisionRef: current.context.decisionRef,
					epochRef: EPOCH,
					idempotencyKey: "effect-runtime-recovery",
					effect,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.reconcile).toBe(0);
		expect(fixture.counts.quarantine).toBe(1);
		expect(fixture.counts.release).toBe(0);
	});

	it("folds an idempotently completed effect without executing or releasing it", async () => {
		const current = admission({ status: "running" });
		const effect = {
			kind: "file_read" as const,
			operationId: "effect-completed-runtime-recovery",
			path: "workspace/input.txt",
			pathDigest: "path-completed-runtime-recovery",
		};
		const fixture = dependencies({
			admissionResult: current,
			effectStatus: "already_completed",
			events: [
				{
					kind: "workflow_effect_intent",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					effectDigest: digestObject(effect),
					decisionRef: current.context.decisionRef,
					epochRef: EPOCH,
					idempotencyKey: "effect-completed-runtime-recovery",
					effect,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.reconcile).toBe(0);
		expect(fixture.counts.quarantine).toBe(1);
		expect(fixture.counts.release).toBe(0);
	});

	it("passes the complete effect reconciliation context when available", async () => {
		const current = admission({ status: "running", context: context({ ownershipLeaseRef: LEASE }) });
		const effect = {
			kind: "file_read" as const,
			operationId: "effect-context-runtime-recovery",
			path: "workspace/input.txt",
			pathDigest: "path-context-runtime-recovery",
		};
		const revisionBoundary = {
			workflowId: WORKFLOW_ID,
			epochRef: EPOCH,
			leaseRef: LEASE,
			executionKey: current.context.executionKey,
			revisionTuple: current.context.revisionTuple,
			revisionRegistryRef: current.context.revisionRegistryRef,
			revisionRegistryDigest: current.context.revisionRegistryDigest,
			configSnapshotDigest: current.context.configSnapshotDigest,
		};
		const ownershipToken = {
			tokenId: "effect-context-token",
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			resourceLeaseRef: LEASE,
			ownershipLeaseRef: LEASE,
		};
		const effectContext = {
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			idempotencyKey: "effect-context-runtime-recovery",
			decisionRef: current.context.decisionRef,
			revisionBoundary: { ...revisionBoundary, tupleDigest: digestObject(revisionBoundary) },
			approvalResponse: null,
			leaseRef: LEASE,
			resourceLeaseRef: LEASE,
			ownershipLeaseRef: LEASE,
			ownershipToken: {
				...ownershipToken,
				tokenDigest: canonicalWorkflowEffectOwnershipTokenDigest(ownershipToken),
			},
		} as WorkflowEffectExecutionContext;
		let observedContext: WorkflowEffectExecutionContext | undefined;
		const fixture = dependencies({
			admissionResult: current,
			effectStatus: "already_completed",
			effectContext,
			effectContextObserved: (observed) => {
				observedContext = observed;
			},
			events: [
				{
					kind: "workflow_effect_intent",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					effectDigest: digestObject(effect),
					decisionRef: current.context.decisionRef,
					epochRef: EPOCH,
					idempotencyKey: "effect-context-runtime-recovery",
					effect,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("corrective_work_required");
		expect(observedContext).toBe(effectContext);
		expect(fixture.counts.reconcile).toBe(1);
	});

	it("quarantines a foreign persisted child identity instead of reattaching it", async () => {
		const persisted = binding();
		const foreignIdentity = childIdentity({ modelId: "foreign-model" });
		const fixture = dependencies({ admissionResult: admission({ processBinding: persisted }), verifyChild: true });
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			executionKey: persisted.childIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: foreignIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.verify).toBe(0);
		expect(fixture.counts.quarantine).toBe(1);
	});

	it("quarantines stale epochs before inspecting or releasing a child", async () => {
		const persisted = binding();
		const fixture = dependencies({
			admissionResult: admission({ processBinding: persisted }),
			staleEpoch: true,
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			executionKey: persisted.childIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.verify).toBe(0);
		expect(fixture.counts.groupQuarantine).toBe(1);
		expect(fixture.counts.quarantine).toBe(1);
		expect(fixture.counts.release).toBe(0);
	});

	it("quarantines a lost process-start identity instead of reattaching", async () => {
		const persisted = binding();
		const fixture = dependencies({ admissionResult: admission({ processBinding: persisted }), verifyChild: false });
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: persisted.taskId,
			attemptId: persisted.attemptId,
			executionKey: persisted.childIdentity.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.groupQuarantine).toBe(1);
		expect(fixture.counts.quarantine).toBe(1);
	});

	it("does not infer no-start from a completed effect event without an effect intent", async () => {
		const current = admission({ status: "running" });
		const terminal = terminalOutcome();
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_effect_completed",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					effectDigest: "orphan-effect",
					resultDigest: "orphan-result",
					idempotencyKey: "orphan-effect",
					epochRef: EPOCH,
					disposition: "completed",
				},
				{
					kind: "workflow_child_outcome_committed",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					outcome: terminal,
					outcomeDigest: digestObject(terminal),
					epochRef: EPOCH,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.quarantine).toBe(1);
	});

	it("quarantines conflicting duplicate effect intents without reconciling one arbitrarily", async () => {
		const current = admission({ status: "running" });
		const firstEffect = {
			kind: "file_read" as const,
			operationId: "duplicate-effect",
			path: "workspace/first.txt",
			pathDigest: "first-path",
		};
		const secondEffect = { ...firstEffect, path: "workspace/second.txt", pathDigest: "second-path" };
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_effect_intent",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					effectDigest: digestObject(firstEffect),
					decisionRef: current.context.decisionRef,
					epochRef: EPOCH,
					idempotencyKey: "duplicate-effect-first",
					effect: firstEffect,
				},
				{
					kind: "workflow_effect_intent",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					effectDigest: digestObject(secondEffect),
					decisionRef: current.context.decisionRef,
					epochRef: EPOCH,
					idempotencyKey: "duplicate-effect-second",
					effect: secondEffect,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.reconcile).toBe(0);
	});

	it("quarantines conflicting duplicate process ownership events", async () => {
		const current = admission({ status: "running" });
		const fixture = dependencies({
			admissionResult: current,
			events: [
				{
					kind: "workflow_process_group_owned",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					processGroup: group({ processGroupId: "group-first" }),
					epochRef: EPOCH,
				},
				{
					kind: "workflow_process_group_owned",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					processGroup: group({ processGroupId: "group-second" }),
					epochRef: EPOCH,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		const result = await coordinator.reconcile({
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: null,
			evidenceRefs: [],
		});

		expect(result.disposition).toBe("user_input_required");
		expect(fixture.counts.groupQuarantine).toBe(2);
	});

	it("surfaces quarantine failures", async () => {
		const current = admission({ status: "running" });
		const fixture = dependencies({
			admissionResult: current,
			groupQuarantineError: new Error("group quarantine failed"),
			events: [
				{
					kind: "workflow_process_group_owned",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					processGroup: group(),
					epochRef: EPOCH,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		await expect(
			coordinator.reconcile({
				workflowId: WORKFLOW_ID,
				taskId: current.context.taskId,
				attemptId: current.context.attemptId,
				executionKey: current.context.executionKey,
				epochRef: EPOCH,
				persistedChildIdentity: null,
				evidenceRefs: [],
			}),
		).rejects.toThrow("group quarantine failed");
	});

	it("surfaces reconciliation commit failures", async () => {
		const current = admission({ status: "running" });
		const fixture = dependencies({
			admissionResult: current,
			storeCommitError: new Error("reconciliation commit failed"),
			events: [
				{
					kind: "workflow_process_group_owned",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					processGroup: group(),
					epochRef: EPOCH,
				},
			],
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		await expect(
			coordinator.reconcile({
				workflowId: WORKFLOW_ID,
				taskId: current.context.taskId,
				attemptId: current.context.attemptId,
				executionKey: current.context.executionKey,
				epochRef: EPOCH,
				persistedChildIdentity: null,
				evidenceRefs: [],
			}),
		).rejects.toThrow("reconciliation commit failed");
	});

	it("serializes concurrent reconciliation calls for one attempt", async () => {
		const current = admission({ processBinding: binding() });
		let releaseVerify!: () => void;
		let markVerifyStarted!: () => void;
		const verifyStarted = new Promise<void>((resolve) => {
			markVerifyStarted = resolve;
		});
		const verifyGate = new Promise<void>((resolve) => {
			releaseVerify = resolve;
		});
		const fixture = dependencies({
			admissionResult: current,
			verifyChild: true,
			verifyGate,
			verifyStarted: markVerifyStarted,
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);
		const request = {
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: current.processBinding?.childIdentity ?? null,
			evidenceRefs: [],
		};

		const first = coordinator.reconcile(request);
		await verifyStarted;
		const second = coordinator.reconcile(request);
		releaseVerify();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult).toEqual(secondResult);
	});

	it("hydrates the authenticated runtime head again after a restart attempt", async () => {
		const fixture = dependencies();
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);

		await coordinator.startRecovery();
		await coordinator.startRecovery();

		expect(fixture.counts.hydrate).toBe(8);
	});

	it("does not let an in-flight lock hide a newer persisted head", async () => {
		const persisted = binding();
		const current = admission({ processBinding: persisted });
		let releaseVerify!: () => void;
		let markVerifyStarted!: () => void;
		const verifyStarted = new Promise<void>((resolve) => {
			markVerifyStarted = resolve;
		});
		const verifyGate = new Promise<void>((resolve) => {
			releaseVerify = resolve;
		});
		const eventsRef = { current: [] as readonly WorkflowRuntimeEventPayload[] };
		const fixture = dependencies({
			admissionResult: current,
			verifyChild: true,
			verifyGate,
			verifyStarted: markVerifyStarted,
			eventsRef,
		});
		const coordinator = createWorkflowRuntimeRecoveryCoordinator(fixture.dependencies);
		const request = {
			workflowId: WORKFLOW_ID,
			taskId: current.context.taskId,
			attemptId: current.context.attemptId,
			executionKey: current.context.executionKey,
			epochRef: EPOCH,
			persistedChildIdentity: persisted.childIdentity,
			evidenceRefs: [],
		};

		const first = coordinator.reconcile(request);
		await verifyStarted;
		eventsRef.current = [
			{
				kind: "workflow_process_group_owned",
				workflowId: WORKFLOW_ID,
				attemptId: current.context.attemptId,
				processGroup: group({ processGroupId: "newer-owned-group" }),
				epochRef: EPOCH,
			},
		];
		const second = coordinator.reconcile(request);
		releaseVerify();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult.disposition).toBe("reattached");
		expect(secondResult.disposition).toBe("user_input_required");
	});
});
