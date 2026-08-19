import { describe, expect, it } from "vitest";
import type {
	WorkflowCapacityGrant,
	WorkflowCommitReturnProof,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowGenerationBinding,
	WorkflowJournalEvent,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowResourceAdmission,
	WorkflowResourceLease,
	WorkflowResourceVector,
	WorkflowSemanticMutationBinding,
} from "../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject } from "../src/core/workflow/contracts.js";
import type { WorkflowQuarantineRecord, WorkflowRecoveryResult } from "../src/core/workflow/recovery.js";
import { reduceWorkflowEvent, type WorkflowDeferredEventOwnerValidators } from "../src/core/workflow/reducer.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const LEASE: WorkflowLeaseRef = {
	...EPOCH,
	leaseId: "lease-1",
	acquisitionEventSequence: 1,
	processIdentity: "process-1",
	rootDigest: "root-1",
	writerIdentity: "writer-1",
	acquiredAt: "2026-08-15T00:00:00.000Z",
	expiresAt: "2026-08-15T01:00:00.000Z",
};

describe("workflow reducer", () => {
	it("initializes a deterministic state from the only valid empty-store event", () => {
		const payload: Extract<WorkflowEventPayload, { kind: "workflow_started" }> = {
			kind: "workflow_started",
			workflowId: "workflow-1",
			rootSessionId: "session-1",
			objective: "Ship the durable loop",
		};
		const commit = createEvent(payload, 1, null, EPOCH, LEASE, "start-1", null);

		const state = reduceWorkflowEvent(null, payload, commit);

		expect(state).toMatchObject({
			workflowId: "workflow-1",
			rootSessionId: "session-1",
			status: "active",
			phase: "hardening_goal",
			objective: "Ship the durable loop",
			goalStatus: "idle",
			sourceJournalSequence: 1,
			sourceJournalDigest: commit.eventDigest,
			storeEpoch: 1,
			coordinatorEpoch: 1,
			generationBinding: {
				writerIdentity: "writer-1",
				processGenerationId: "writer-1",
				ownerIdentity: "writer-1",
			},
		});
	});

	it("replays the manager-shaped resource lease acquisition only when its admission is internally bound", () => {
		const started = createStartedState();
		const payload = managerResourceLeasePayload();
		const commit = createEvent(payload, 2, started.sourceJournalDigest, EPOCH, LEASE, "resource-lease-1", null);
		const validators = noOpDeferredValidators();

		const replayed = reduceWorkflowEvent(started, payload, commit, validators);
		expect(replayed.sourceJournalSequence).toBe(2);

		const mutations: Array<[string, (lease: WorkflowResourceLease) => void]> = [
			[
				"foreign grant",
				(lease) => {
					lease.resourceAdmission.capacityGrant = {
						...lease.resourceAdmission.capacityGrant,
						resourceVector: resourceVector({ cpuMilliCores: 99 }),
					};
				},
			],
			[
				"foreign ledger",
				(lease) => {
					lease.resourceAdmission.canonicalPoolLedgerRef = reducerArtifactRef("foreign-ledger");
				},
			],
			[
				"foreign control",
				(lease) => {
					lease.resourceAdmission.controlCapacity = {
						...lease.resourceAdmission.controlCapacity,
						processSlots: 1,
					};
				},
			],
			[
				"foreign projection digest",
				(lease) => {
					lease.resourceAdmission.controlCapacityProjectionDigest = digestObject({ processSlots: 1 });
				},
			],
			[
				"unadmitted",
				(lease) => {
					lease.resourceAdmission.admitted = false;
				},
			],
			[
				"omitted grant",
				(lease) => {
					delete (lease.resourceAdmission as unknown as Record<string, unknown>).capacityGrant;
				},
			],
		];

		for (const [label, mutate] of mutations) {
			const mutatedLease = structuredClone(payload.lease);
			mutate(mutatedLease);
			const mutatedPayload = { ...payload, lease: mutatedLease };
			const mutatedCommit = createEvent(
				mutatedPayload,
				2,
				started.sourceJournalDigest,
				EPOCH,
				LEASE,
				`resource-lease-${label.replaceAll(" ", "-")}`,
				null,
			);
			expect(() => reduceWorkflowEvent(started, mutatedPayload, mutatedCommit, validators), label).toThrow(
				/lease|admission|capacity|ledger|control/i,
			);
		}
	});

	it("enforces closed status transitions and predecessor-qualified fencing", () => {
		const started = createStartedState();
		const statusPayload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
			kind: "workflow_status_changed",
			status: "awaiting_user",
			phase: "adjudicating",
			reason: "approval required",
			goalDelta: createGoalDelta("awaiting_user"),
		};
		const statusCommit = createEvent(statusPayload, 2, started.sourceJournalDigest, EPOCH, LEASE, "status-1", null);
		const awaiting = reduceWorkflowEvent(started, statusPayload, statusCommit);
		expect(awaiting.status).toBe("awaiting_user");
		expect(awaiting.phase).toBe("adjudicating");

		const invalidPayload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
			...statusPayload,
			status: "complete",
			phase: "auditing_completion",
		};
		const invalidCommit = createEvent(invalidPayload, 3, statusCommit.eventDigest, EPOCH, LEASE, "status-2", null);
		expect(() => reduceWorkflowEvent(awaiting, invalidPayload, invalidCommit)).toThrow(/status transition/i);

		const successorEpoch: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 2 };
		const successorLease: WorkflowLeaseRef = {
			...LEASE,
			...successorEpoch,
			leaseId: "lease-2",
			processIdentity: "process-2",
			writerIdentity: "writer-2",
		};
		const binding: WorkflowGenerationBinding = {
			writerIdentity: "writer-2",
			processGenerationId: "process-2",
			ownerIdentity: "owner-2",
		};
		const fencePayload: Extract<WorkflowEventPayload, { kind: "coordinator_epoch_fenced" }> = {
			kind: "coordinator_epoch_fenced",
			workflowId: "workflow-1",
			coordinatorEpoch: 2,
			priorEpoch: EPOCH,
			nextEpoch: successorEpoch,
			priorLeaseRef: LEASE,
			nextLeaseRef: successorLease,
			generationId: "generation-2",
			generationBinding: binding,
		};
		const fenceCommit = createEvent(fencePayload, 3, statusCommit.eventDigest, EPOCH, LEASE, "fence-1", null);
		const fenced = reduceWorkflowEvent(awaiting, fencePayload, fenceCommit);
		expect(fenced.coordinatorEpoch).toBe(2);
		expect(fenced.generationBinding).toEqual(binding);

		const stalePayload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
			...statusPayload,
			status: "paused",
			phase: "recovering",
		};
		const staleCommit = createEvent(stalePayload, 4, fenceCommit.eventDigest, EPOCH, LEASE, "stale-1", null);
		expect(() => reduceWorkflowEvent(fenced, stalePayload, staleCommit)).toThrow(/epoch|writer|lease/i);
	});

	it("rejects a tampered authenticated return proof", () => {
		const started = createStartedState();
		const payload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
			kind: "workflow_status_changed",
			status: "paused",
			phase: "recovering",
			reason: "operator pause",
			goalDelta: createGoalDelta("active"),
		};
		const commit = createEvent(payload, 2, started.sourceJournalDigest, EPOCH, LEASE, "tampered-1", null);
		const tamperedCommit: WorkflowJournalEvent = {
			...commit,
			commitReturnProof: {
				...commit.commitReturnProof,
				proofDigest: "0".repeat(64),
			},
		};

		expect(() => reduceWorkflowEvent(started, payload, tamperedCommit)).toThrow(/return proof/i);
	});

	it("rejects a workflow status with a forbidden goal status mapping", () => {
		const started = createStartedState();
		const payload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
			kind: "workflow_status_changed",
			status: "paused",
			phase: "recovering",
			reason: "operator pause",
			goalDelta: createGoalDelta("active"),
		};
		const commit = createEvent(payload, 2, started.sourceJournalDigest, EPOCH, LEASE, "mapping-1", null);

		expect(() => reduceWorkflowEvent(started, payload, commit)).toThrow(/goal mutation|status mapping/i);
	});

	it("rejects goal counter regression", () => {
		const started = createStartedState();
		const bindingPayload: Extract<WorkflowEventPayload, { kind: "goal_binding_committed" }> = {
			kind: "goal_binding_committed",
			workflowId: "workflow-1",
			goalId: "goal-1",
			objective: "Ship the durable loop",
			goalDelta: createGoalDelta("active", { tokensUsed: 4, timeUsedSeconds: 4, continuationsUsed: 1 }),
		};
		const bindingCommit = createEvent(
			bindingPayload,
			2,
			started.sourceJournalDigest,
			EPOCH,
			LEASE,
			"binding-1",
			null,
		);
		const bound = reduceWorkflowEvent(started, bindingPayload, bindingCommit);
		const regressedPayload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
			kind: "workflow_status_changed",
			status: "paused",
			phase: "recovering",
			reason: "operator pause",
			goalDelta: createGoalDelta("paused", { tokensUsed: 3, timeUsedSeconds: 3, continuationsUsed: 0 }),
		};
		const regressedCommit = createEvent(
			regressedPayload,
			3,
			bindingCommit.eventDigest,
			EPOCH,
			LEASE,
			"regressed-1",
			null,
		);

		expect(() => reduceWorkflowEvent(bound, regressedPayload, regressedCommit)).toThrow(/counter/i);
		const forgedPayload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
			...regressedPayload,
			goalDelta: createGoalDelta("paused", { tokensUsed: 11, timeUsedSeconds: 4, continuationsUsed: 1 }),
		};
		const forgedCommit = createEvent(forgedPayload, 3, bindingCommit.eventDigest, EPOCH, LEASE, "forged-1", null);
		expect(() => reduceWorkflowEvent(bound, forgedPayload, forgedCommit)).toThrow(/counter|budget/i);
	});

	it("returns the existing state for an exact event-digest replay", () => {
		const started = createStartedState();
		const bindingPayload: Extract<WorkflowEventPayload, { kind: "goal_binding_committed" }> = {
			kind: "goal_binding_committed",
			workflowId: "workflow-1",
			goalId: "goal-1",
			objective: "Ship the durable loop",
			goalDelta: createGoalDelta("active", { tokensUsed: 4, timeUsedSeconds: 4, continuationsUsed: 1 }),
		};
		const bindingCommit = createEvent(
			bindingPayload,
			2,
			started.sourceJournalDigest,
			EPOCH,
			LEASE,
			"binding-replay-1",
			null,
		);
		const bound = reduceWorkflowEvent(started, bindingPayload, bindingCommit);
		const statusPayload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
			kind: "workflow_status_changed",
			status: "paused",
			phase: "recovering",
			reason: "operator pause",
			goalDelta: createGoalDelta("paused", { tokensUsed: 4, timeUsedSeconds: 4, continuationsUsed: 1 }),
		};
		const statusCommit = createEvent(
			statusPayload,
			3,
			bindingCommit.eventDigest,
			EPOCH,
			LEASE,
			"status-replay-1",
			null,
		);
		const paused = reduceWorkflowEvent(bound, statusPayload, statusCommit);
		expect(reduceWorkflowEvent(paused, statusPayload, statusCommit)).toEqual(paused);
	});

	it("rejects stale or different event digests instead of treating them as retries", () => {
		const started = createStartedState();
		const payload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
			kind: "workflow_status_changed",
			status: "paused",
			phase: "recovering",
			reason: "operator pause",
			goalDelta: createGoalDelta("paused"),
		};
		const commit = createEvent(payload, 2, started.sourceJournalDigest, EPOCH, LEASE, "digest-1", null);
		const paused = reduceWorkflowEvent(started, payload, commit);
		const differentCommit = createEvent(
			{ ...payload, reason: "different reason" },
			2,
			started.sourceJournalDigest,
			EPOCH,
			LEASE,
			"digest-2",
			null,
		);
		const staleCommit = createEvent(payload, 1, null, EPOCH, LEASE, "stale-1", null);

		expect(() => reduceWorkflowEvent(paused, { ...payload, reason: "different reason" }, differentCommit)).toThrow(
			/head|stale/i,
		);
		expect(() => reduceWorkflowEvent(paused, payload, staleCommit)).toThrow(/head|stale/i);
	});

	it("rejects a foreign workflow before applying a specialization event", () => {
		const started = createStartedState();
		const payload: Extract<WorkflowEventPayload, { kind: "target_reached" }> = {
			kind: "target_reached",
			workflowId: "foreign-workflow",
			epochRef: EPOCH,
			executionKey: "execution-1",
			runId: "run-1",
			source: "approved_baseline",
			metric: 1,
			target: 1,
			frontierDigest: "frontier-1",
			status: "target_pending_verification",
		};
		const commit = createEvent(payload, 2, started.sourceJournalDigest, EPOCH, LEASE, "target-1", "execution-1");

		expect(() => reduceWorkflowEvent(started, payload, commit)).toThrow(/foreign|identity/i);
	});

	it("keeps quarantine outcomes closed and typed", () => {
		const quarantine: WorkflowQuarantineRecord = {
			workflowId: "workflow-1",
			status: "quarantined",
			reason: "stale_epoch",
			source: { artifactRef: null, relativePath: "events.log", digest: "digest-1", sizeBytes: 1 },
			epochRef: EPOCH,
			eventSequence: 2,
		};
		const recovery: WorkflowRecoveryResult = {
			workflowId: "workflow-1",
			status: "quarantined",
			reason: quarantine.reason,
			source: quarantine.source,
			epochRef: quarantine.epochRef,
			reconciliation: null,
			quarantine,
		};

		expect(recovery.quarantine?.reason).toBe("stale_epoch");
		expect(recovery.status).toBe("quarantined");
	});
});

function noOpDeferredValidators(): WorkflowDeferredEventOwnerValidators {
	return {
		autoresearch: () => undefined,
		runtime: () => undefined,
		effect: () => undefined,
		recovery: () => undefined,
	};
}

function managerResourceLeasePayload(): Extract<WorkflowEventPayload, { kind: "workflow_resource_lease_acquired" }> {
	const vector = resourceVector({ cpuMilliCores: 10, memoryBytes: 20 });
	const controlCapacity = {
		processSlots: 0,
		childSessionSlots: 0,
		modelCallSlots: 0,
		modelInputTokens: 0,
		modelOutputTokens: 0,
		verificationSlots: 0,
		redTeamSlots: 0,
		recoverySlots: 0,
	} as const;
	const canonicalPoolLedgerRef = reducerArtifactRef("canonical-pool-ledger");
	const capacityGrant: WorkflowCapacityGrant = {
		kind: "worker",
		grantId: "grant:attempt-1",
		resourceVector: vector,
		controlCapacity,
		canonicalPoolLedgerRef,
		grantDigest: digestObject({ kind: "worker", vector, canonicalPoolLedgerRef }),
	};
	const admission: WorkflowResourceAdmission = {
		capacityGrant,
		canonicalPoolLedgerRef,
		controlCapacity,
		controlCapacityProjectionDigest: digestObject(controlCapacity),
		declaredVector: vector,
		hostDerivedConservativeVector: vector,
		reservedVector: vector,
		declaredControlCapacity: controlCapacity,
		hostDerivedControlCapacity: controlCapacity,
		reservedControlCapacity: controlCapacity,
		derivationPolicyDigest: digestObject({ enforcementClass: "isolated_metered", controlPlane: false }),
		enforcementClass: "isolated_metered",
		unknownPoolIds: [],
		canonicalLedgerRef: canonicalPoolLedgerRef,
		canonicalLedgerDigest: canonicalPoolLedgerRef.digest,
		admitted: true,
		admissionDigest: digestObject({ capacityGrant }),
	};
	const lease: WorkflowResourceLease = {
		leaseId: "resource:workflow-1:attempt-1",
		workflowId: "workflow-1",
		taskId: "task-1",
		attemptId: "attempt-1",
		holderIdentity: LEASE.writerIdentity,
		resourceAdmission: admission,
		controlCapacity,
		workerCapacity: controlCapacity,
		status: "active",
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		acquisitionEventSequence: 2,
		idempotencyKey: "resource:attempt-1",
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T00:01:00.000Z",
		releaseEventSequence: null,
	};
	return {
		kind: "workflow_resource_lease_acquired",
		workflowId: "workflow-1",
		lease,
		epochRef: EPOCH,
	};
}

function resourceVector(overrides: Partial<WorkflowResourceVector> = {}): WorkflowResourceVector {
	return {
		cpuMilliCores: 0,
		memoryBytes: 0,
		diskBytes: 0,
		ioWeight: 0,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 0,
		monetaryMicrounits: 0,
		...overrides,
	};
}

function reducerArtifactRef(artifactId: string) {
	return {
		artifactId,
		relativePath: `artifacts/${artifactId}.json`,
		digest: digestObject({ artifactId }),
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
}

function createStartedState() {
	const payload: Extract<WorkflowEventPayload, { kind: "workflow_started" }> = {
		kind: "workflow_started",
		workflowId: "workflow-1",
		rootSessionId: "session-1",
		objective: "Ship the durable loop",
	};
	return reduceWorkflowEvent(null, payload, createEvent(payload, 1, null, EPOCH, LEASE, "start-1", null));
}

function createGoalDelta(
	status: "active" | "awaiting_user" | "paused",
	overrides: Partial<Extract<WorkflowEventPayload, { kind: "goal_binding_committed" }>["goalDelta"]> = {},
): Extract<WorkflowEventPayload, { kind: "goal_binding_committed" }>["goalDelta"] {
	return {
		goalId: "goal-1",
		objective: "Ship the durable loop",
		active: status === "active",
		status: status === "active" ? "active" : "paused",
		tokenBudget: 10,
		tokensUsed: 1,
		timeUsedSeconds: 1,
		continuationsUsed: 0,
		createdAt: 1,
		updatedAt: 2,
		lastReason: null,
		lastError: null,
		...overrides,
	};
}

function createEvent(
	payload: WorkflowEventPayload,
	sequence: number,
	priorEventDigest: string | null,
	epochRef: WorkflowEpochRef,
	leaseRef: WorkflowLeaseRef,
	idempotencyKey: string,
	executionKey: string | null,
): WorkflowJournalEvent {
	const expectedHead: WorkflowJournalHead = {
		workflowId: "workflowId" in payload ? payload.workflowId : "workflow-1",
		sequence: sequence - 1,
		eventDigest: priorEventDigest,
		epochRef,
	};
	const semanticBinding: WorkflowSemanticMutationBinding = {
		mutationId: idempotencyKey,
		baselineDigest: digestObject(expectedHead),
		expectedGenerations: { generation: epochRef.storeEpoch },
		ownerId: "workflow-test",
		phase: "planning",
		reducerDigest: digestObject(payload),
		semanticHead: {
			workflowId: expectedHead.workflowId,
			sequence: expectedHead.sequence,
			eventDigest: expectedHead.eventDigest,
			stateDigest: digestObject(expectedHead),
			epochRef,
			generation: epochRef.storeEpoch,
		},
		expectedHead,
		idempotencyKey,
		executionKey,
		writerIdentity: leaseRef.writerIdentity,
		leaseRef,
		epochRef,
	};
	const payloadBytes = canonicalJsonBytes(payload);
	const eventDigest = digestObject({
		workflowId: expectedHead.workflowId,
		sequence,
		payloadBytes: Array.from(payloadBytes),
		priorEventDigest,
		idempotencyKey,
		semanticBinding,
	});
	const proofBase: Omit<WorkflowCommitReturnProof, "proofDigest"> = {
		recordVersion: 1,
		generationId: "generation-1",
		mutationId: `return-proof:${idempotencyKey}`,
		workflowId: expectedHead.workflowId,
		sequence,
		eventDigest,
		committedFrameDigest: "committed-frame-1",
		expectedHead,
		epochRef,
		leaseRef,
		writerIdentity: leaseRef.writerIdentity,
		idempotencyKey,
		keyId: "key-1",
		frameMac: "committed-mac-1",
		frameChecksum: "committed-checksum-1",
		recordMac: "record-mac-1",
		recordChecksum: "record-checksum-1",
		priorRecordDigest: priorEventDigest,
		returnedAt: "2026-08-15T00:00:00.000Z",
	};
	return {
		workflowId: expectedHead.workflowId,
		sequence,
		kind: payload.kind,
		eventType: payload.kind,
		payload,
		payloadBytes,
		payloadDigest: digestObject(payload),
		priorEventDigest,
		eventDigest,
		recordVersion: 1,
		generationId: "generation-1",
		recordMac: "record-mac-1",
		recordChecksum: "record-checksum-1",
		idempotencyKey,
		returnProofId: `return-proof:${idempotencyKey}`,
		expectedHead,
		executionKey,
		epochRef,
		leaseRef,
		writerIdentity: leaseRef.writerIdentity,
		preparedFrameDigest: "prepared-frame-1",
		committedFrameDigest: "committed-frame-1",
		keyId: "key-1",
		preparedFrameMac: "prepared-mac-1",
		committedFrameMac: "committed-mac-1",
		preparedFrameChecksum: "prepared-checksum-1",
		committedFrameChecksum: "committed-checksum-1",
		semanticBinding,
		commitReturnProof: { ...proofBase, proofDigest: digestObject(proofBase) },
	};
}
