import { describe, expect, it, vi } from "vitest";

import type {
	WorkflowAdaptiveAllocationState,
	WorkflowControlCapacityVector,
	WorkflowEpochRef,
	WorkflowLeaseReconciliation,
	WorkflowLeaseRef,
	WorkflowLeaseReleaseResult,
	WorkflowResourceEnvelope,
	WorkflowResourceLease,
	WorkflowResourceVector,
	WorkflowRevisionBoundaryContext,
	WorkflowRuntimeStore,
	WorkflowTask,
} from "../../src/core/workflow/contracts.js";
import { digestObject } from "../../src/core/workflow/contracts.js";
import type {
	WorkflowCanonicalDispatchInput,
	WorkflowDispatcher,
	WorkflowDispatchReadiness,
	WorkflowDispatchResult,
} from "../../src/core/workflow/dispatch.js";
import type {
	WorkflowLeaseManager,
	WorkflowLeaseRequest,
	WorkflowOwnershipLeaseRequest,
} from "../../src/core/workflow/leases.js";
import {
	createWorkflowScheduler,
	type WorkflowSchedulerDependencies,
	type WorkflowSchedulerLeaseTransaction,
	type WorkflowSchedulerState,
	type WorkflowSchedulerStateStore,
} from "../../src/core/workflow/scheduler.js";
import type { WorkflowTaskGraph } from "../../src/core/workflow/task-graph.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const ZERO_CONTROL: WorkflowControlCapacityVector = {
	processSlots: 0,
	childSessionSlots: 0,
	modelCallSlots: 0,
	modelInputTokens: 0,
	modelOutputTokens: 0,
	verificationSlots: 0,
	redTeamSlots: 0,
	recoverySlots: 0,
};

function vector(overrides: Partial<WorkflowResourceVector> = {}): WorkflowResourceVector {
	return {
		cpuMilliCores: 1,
		memoryBytes: 1,
		diskBytes: 1,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 1,
		monetaryMicrounits: 0,
		...overrides,
	};
}

function zeroVector(): WorkflowResourceVector {
	return vector({
		cpuMilliCores: 0,
		memoryBytes: 0,
		diskBytes: 0,
		ioWeight: 0,
		wallMilliseconds: 0,
	});
}

function task(taskId: string, overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		taskId,
		planRevision: 1,
		objective: taskId,
		requirementIds: [`requirement-${taskId}`],
		completionCriteria: ["verified"],
		dependencyTaskIds: [],
		ownedPaths: [],
		ownedContracts: [],
		requiredSkillSnapshotDigests: [],
		verificationCommandDigests: [],
		authority: [],
		declaredResourceVector: vector(),
		declaredControlCapacity: ZERO_CONTROL,
		status: "ready",
		attemptIds: [],
		...overrides,
	};
}

function graph(tasks: readonly WorkflowTask[]): WorkflowTaskGraph {
	return {
		graphRevision: 1,
		tasks,
		byId: new Map(tasks.map((item) => [item.taskId, item])),
		allowedAuthority: [],
		ownershipPaths: ["workspace"],
		generatedOutputPaths: [],
		lockPaths: [],
		namedContracts: [],
		graphDigest: "graph-digest",
	};
}

function leaseRef(leaseId: string, attemptId: string): WorkflowLeaseRef {
	return {
		...EPOCH,
		leaseId,
		acquisitionEventSequence: 1,
		processIdentity: `process-${attemptId}`,
		rootDigest: "root-digest",
		writerIdentity: "writer",
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T01:00:00.000Z",
	};
}

function authenticatedAdaptiveState(
	overrides: Partial<WorkflowAdaptiveAllocationState> = {},
): WorkflowAdaptiveAllocationState {
	return {
		workflowId: "workflow-scheduler-test",
		allocationRevision: 1,
		acceptedObservation: {
			artifactId: "accepted-observation",
			relativePath: "accepted-observation",
			digest: "accepted-observation-digest",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		allocationEntries: [],
		limitingPool: "cpu",
		fairness: {
			taskLastServedAt: {},
			priorityBucketByTask: {},
			promotionCountByWindow: {},
			policy: {
				priorityBucketOrder: [],
				promotionEnabled: false,
				agingQuantumMilliseconds: 1_000,
				starvationDeadlineMilliseconds: 0,
				maxAgingBoost: 0,
				maxPromotionBuckets: 0,
				maxPromotionsPerWindow: 0,
				explorationQuotaPerWindow: 0,
				policyDigest: "fairness-policy-digest",
			},
			agingPolicyDigest: "aging-policy-digest",
			explorationQuotaRemaining: 0,
			explorationQuotaWindow: 0,
			lastServedTaskId: null,
			fairnessDigest: "fairness-digest",
		},
		reviewQueueState: {} as never,
		hysteresisPolicy: {} as never,
		minimumWindowEvents: 1,
		minimumWindowMilliseconds: 1,
		benefitMetricDigest: "benefit-metric-digest",
		benefitThreshold: 0,
		minimumDwellMilliseconds: 1,
		maxTransitionsPerWindow: 1,
		transitionsInWindow: 0,
		lastDecisionRef: null,
		safetyOverride: "none",
		cooldownUntil: null,
		cooldownMonotonicMilliseconds: null,
		rollbackAllocationRef: null,
		allocationStatus: "stable",
		allocationDigest: "allocation-digest",
		revision: 1,
		currentEpoch: EPOCH,
		stateDigest: "state-digest",
		criticalPathTaskIds: [],
		readyQueue: [],
		runningQueue: [],
		evidenceGaps: [],
		blockers: [],
		throughputPerMinute: 0,
		latencyMilliseconds: 0,
		marginalVerifiedProgressByResource: {},
		uncertainty: {},
		criticalPathCertificateRef: {
			artifactId: "critical-path-certificate",
			relativePath: "critical-path-certificate",
			digest: "critical-path-certificate-digest",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		criticalPathProofDigest: "critical-path-proof-digest",
		controlPlaneReserve: zeroVector(),
		controlCapacity: ZERO_CONTROL,
		workerCapacity: ZERO_CONTROL,
		policyRevision: 1,
		policyDigest: "policy-digest",
		monotonicObservation: {} as never,
		observedAt: "2030-01-01T00:00:00.000Z",
		observationWindowMilliseconds: 1,
		minimumObservationWindowMilliseconds: 1,
		executionCeilings: {} as never,
		rollbackState: "none",
		hysteresisThreshold: 0,
		hysteresisDwellMilliseconds: 1,
		maxHysteresisTransitions: 1,
		fairnessAgingMilliseconds: 0,
		fairnessDebtByTask: {},
		explorationQuota: 0,
		hysteresisRevision: 1,
		lastAllocationDigest: null,
		acceptedObservationDigest: null,
		acceptedAllocationEntries: [],
		lastSafeAllocationDigest: null,
		lastSafeAllocationTupleDigest: null,
		lastSafeLedgerHeadDigest: null,
		lastSafeLeaseTupleDigest: null,
		reviewQueue: [],
		sourceJournalSequence: 1,
		sourceJournalDigest: "source-journal-digest",
		capacityBindingRefs: [],
		pendingObservationDigest: null,
		supersededObservationDigests: [],
		staleObservationDigests: [],
		cancellationDigest: null,
		controllerRecoveryDigest: null,
		...overrides,
	} as unknown as WorkflowAdaptiveAllocationState;
}

function revisionContext(executionKey: string | null): WorkflowRevisionBoundaryContext {
	const context = {
		workflowId: "workflow-scheduler-test",
		epochRef: EPOCH,
		leaseRef: leaseRef("revision", "revision-attempt"),
		executionKey,
		revisionTuple: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			configRevision: 1,
			evidenceRevision: 1,
		},
		revisionRegistryRef: {
			artifactId: "revision-registry",
			relativePath: "revision-registry",
			digest: "revision-registry-digest",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		revisionRegistryDigest: "revision-registry-digest",
		configSnapshotDigest: "config-digest",
	};
	return { ...context, tupleDigest: digestObject(context) };
}

function releasedLease(): WorkflowLeaseReleaseResult {
	return {
		status: "released",
		leaseRef: leaseRef("resource", "attempt"),
		releaseEventSequence: 2,
		epochRef: EPOCH,
	};
}

function reconciledLease(): WorkflowLeaseReconciliation {
	return {
		leaseRef: leaseRef("resource", "attempt"),
		status: "quarantined",
		reason: null,
	};
}

function input(taskId: string, attemptId = `${taskId}-attempt`): WorkflowCanonicalDispatchInput {
	return {
		workflowId: "workflow-scheduler-test",
		taskId,
		attemptId,
		executionKey: `${taskId}-execution`,
		epochRef: EPOCH,
		resourceLease: { leaseId: `${attemptId}-resource`, ...vectorLease(attemptId) },
		ownershipLease: null,
	} as unknown as WorkflowCanonicalDispatchInput;
}

function vectorLease(attemptId: string): Partial<WorkflowResourceLease> {
	return {
		workflowId: "workflow-scheduler-test",
		taskId: attemptId.replace(/-attempt$/, ""),
		attemptId,
		status: "active",
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
	};
}

function cloudEnvelope(
	provider: WorkflowResourceVector["providers"][number],
	mode: "valid" | "expired" | "foreign",
): WorkflowResourceEnvelope {
	const workflowId = mode === "foreign" ? "foreign-workflow" : "workflow-scheduler-test";
	const decision = {
		decisionScope: { kind: "workflow", workflowId: "workflow-scheduler-test", rootSessionId: "session" },
		decisionId: "cloud-decision",
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		decisionDigest: "cloud-decision-digest",
	} as WorkflowResourceEnvelope["approvalDecisionRef"];
	const responseArtifactRef = {
		artifactId: "cloud-response",
		relativePath: "cloud-response",
		digest: "cloud-response-digest",
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
	const receipt = {
		workflowId,
		requestDigest: "cloud-request-digest",
		capacityArtifactRef: responseArtifactRef,
		pricingArtifactRef: responseArtifactRef,
		credentialArtifactRef: responseArtifactRef,
		quotaArtifactRef: responseArtifactRef,
		rateLimitArtifactRef: responseArtifactRef,
		billingArtifactRef: responseArtifactRef,
		egressArtifactRef: responseArtifactRef,
		terminationArtifactRef: responseArtifactRef,
		responseArtifactRef,
		responseReceipt: {
			receiptKind: "artifact",
			workflowId,
			payloadDigest: responseArtifactRef.digest,
		} as never,
		capacityVector: vector({ providers: [provider] }),
		trustedClockReceipt: {
			receiptKind: "clock",
			workflowId,
			bindingDigest: "cloud-request-digest",
			issuedAt: "2030-01-01T00:00:00.000Z",
		} as never,
		observedAt: "2030-01-01T00:00:00.000Z",
		validUntil: mode === "expired" ? "2030-01-01T00:05:00.000Z" : "2030-01-02T00:00:00.000Z",
		ttlMilliseconds: mode === "expired" ? 300_000 : 86_400_000,
		finalEnvelopeDecisionRef: decision,
		finalEnvelopeDigest: "",
		receiptDigest: "",
	} as NonNullable<WorkflowResourceEnvelope["capacityReceipt"]>;
	const envelope = {
		envelopeId: "cloud-envelope",
		resources: vector({ providers: [provider] }),
		controlPlaneReserve: zeroVector(),
		controlPlaneReserveCapacity: ZERO_CONTROL,
		controlCapacity: { ...ZERO_CONTROL, processSlots: 1 },
		workerCapacity: { ...ZERO_CONTROL, processSlots: 1 },
		processSlots: 1,
		childSessionSlots: 1,
		candidateSlots: 1,
		executionCeilings: {} as never,
		providerQuotaSnapshotRef: responseArtifactRef,
		inventoryDigest: "inventory",
		pricingDigest: "pricing",
		terminationPolicyDigest: "termination",
		billingReconciliationPolicyDigest: "billing",
		egressPolicyDigest: "egress",
		validFrom: "2030-01-01T00:00:00.000Z",
		validUntil: "2030-01-02T00:00:00.000Z",
		capacityReceipt: receipt,
		approvalDecisionRef: decision,
		canonicalLedgerRef: responseArtifactRef,
		canonicalLedgerDigest: "ledger",
		envelopeDigest: "",
	} as WorkflowResourceEnvelope;
	const envelopeDigest = digestObject({ ...envelope, capacityReceipt: { ...receipt }, envelopeDigest: "" });
	receipt.finalEnvelopeDigest = envelopeDigest;
	receipt.receiptDigest = digestObject({ ...receipt, receiptDigest: "" });
	envelope.envelopeDigest = envelopeDigest;
	return envelope;
}

function readiness(inputValue: WorkflowCanonicalDispatchInput): WorkflowDispatchReadiness {
	return {
		workflowId: inputValue.workflowId,
		epochRef: EPOCH,
		rootLeaseRef: leaseRef("root", "root"),
		leaseRef: leaseRef(`${inputValue.attemptId}-resource`, inputValue.attemptId),
		executionKey: inputValue.executionKey,
		revisionTuple: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			configRevision: 1,
			evidenceRevision: 1,
		},
		revisionRegistryRef: {
			artifactId: "revision",
			relativePath: "revision",
			digest: "revision-digest",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		revisionRegistryDigest: "revision-digest",
		readinessDigest: "readiness-digest",
		canDispatch: true,
		childSpawnPath: "separate_process",
		processStartIdentity: "verified",
		processGroup: "enforceable",
		artifactRoot: "workflow",
		canonicalArtifactRoot: "workflow",
		artifactRootRelativePath: "workflow",
		artifactRootPathDigest: "path-digest",
		activeGenerationDigest: "generation-digest",
		configSnapshotDigest: "config-digest",
		currentHeadDigest: "head-digest",
		currentHead: null,
		checks: {
			artifactRootVerified: true,
			rootLeaseVerified: true,
			currentEpochVerified: true,
			approvedConfigVerified: true,
			canonicalAdmissionBundleVerified: true,
			approvedEnvelopeVerified: true,
			kernelAdapterAvailable: true,
			authorityClosureVerified: true,
			workerCapabilityVerified: true,
		},
		blockingReasons: [],
		observedAt: "2030-01-01T00:00:00.000Z",
	};
}

function stateStore(
	initial: WorkflowSchedulerState,
): WorkflowSchedulerStateStore & { current: WorkflowSchedulerState } {
	const store = {
		current: structuredClone(initial),
		read: vi.fn(async () => structuredClone(store.current)),
		write: vi.fn(async (next: WorkflowSchedulerState) => {
			store.current = structuredClone(next);
		}),
	};
	return store;
}

function createFixture(
	tasks: readonly WorkflowTask[],
	overrides: Partial<WorkflowSchedulerDependencies> = {},
): {
	scheduler: ReturnType<typeof createWorkflowScheduler>;
	state: WorkflowSchedulerStateStore & { current: WorkflowSchedulerState };
	dispatched: WorkflowCanonicalDispatchInput[];
	leaseTransaction: WorkflowSchedulerLeaseTransaction;
	setGraphTasks: (nextTasks: readonly WorkflowTask[]) => void;
} {
	let graphValue = graph(tasks);
	const firstInput = input(tasks[0]?.taskId ?? "task");
	const initial: WorkflowSchedulerState = {
		workflowId: firstInput.workflowId,
		epochRef: EPOCH,
		entries: [],
		pausedReason: null,
		activeAttemptIds: [],
	};
	const state = stateStore(initial);
	const dispatched: WorkflowCanonicalDispatchInput[] = [];
	const dispatcher: WorkflowDispatcher = {
		observe: vi.fn(async (dispatchInput) => readiness(dispatchInput)),
		dispatch: vi.fn(async (dispatchInput): Promise<WorkflowDispatchResult> => {
			dispatched.push(dispatchInput);
			return { status: "disabled", phase: "readiness", admission: null, readiness: readiness(dispatchInput) };
		}),
	};
	const leases: WorkflowLeaseManager = {
		canAdmit: vi.fn(async () => true),
		acquireResource: vi.fn(
			async (request) =>
				({
					...request,
					leaseId: `${request.attemptId}-resource`,
					status: "active",
					resourceAdmission: { reservedVector: request.vector, controlCapacity: request.controlCapacity },
				}) as unknown as WorkflowResourceLease,
		),
		acquireOwnership: vi.fn(async (request) => ({
			...request,
			leaseId: `${request.attemptId}-ownership`,
			status: "active",
		})),
		hydrateFromReplay: vi.fn(async () => undefined),
		release: vi.fn(async (): Promise<WorkflowLeaseReleaseResult> => releasedLease()),
		quarantine: vi.fn(async (): Promise<WorkflowLeaseReconciliation> => reconciledLease()),
		reconcile: vi.fn(async (): Promise<WorkflowLeaseReconciliation> => reconciledLease()),
		activeVector: vi.fn(async () => zeroVector()),
		activeControlCapacity: vi.fn(async () => ZERO_CONTROL),
		lookupByLease: vi.fn(async () => undefined),
	};
	const leaseTransaction = {
		acquire: vi.fn(async (request: WorkflowLeaseRequest, ownership: WorkflowOwnershipLeaseRequest | null) => ({
			resourceLease: await leases.acquireResource(request),
			ownershipLease: ownership === null ? null : await leases.acquireOwnership(ownership),
		})),
		releasePreDispatch: vi.fn(async () => undefined),
	};
	const dependencies = {
		graph: graphValue,
		readGraph: () => graphValue,
		queueState: state,
		dispatcher,
		leases,
		readCurrentEpoch: async () => EPOCH,
		readRootLeaseRef: async () => leaseRef("root", "root"),
		clock: { now: () => "2030-01-01T00:10:00.000Z" },
		maxConcurrentAttempts: 1,
		writerIdentity: "writer",
		workerPartition: { controlCapacity: ZERO_CONTROL, resourceVector: vector({ cpuMilliCores: 10 }) },
		controlPartition: { capacity: ZERO_CONTROL, resourceVector: vector({ cpuMilliCores: 10 }) },
		controlPlaneReserve: { ...zeroVector(), cpuMilliCores: 1 },
		leaseTransaction,
		readRevisionBoundaryContext: async (
			_workflowId: string,
			_epochRef: WorkflowEpochRef,
			executionKey: string | null,
		) => revisionContext(executionKey),
		revisionRegistry: { assertActive: vi.fn(async () => undefined) },
		...overrides,
	} as unknown as WorkflowSchedulerDependencies;
	return {
		scheduler: createWorkflowScheduler(dependencies),
		state,
		dispatched,
		leaseTransaction,
		setGraphTasks: (nextTasks) => {
			graphValue = graph(nextTasks);
		},
	};
}

describe("workflow scheduler", () => {
	it("orders only currently ready work by priority, age, and task id", async () => {
		const fixture = createFixture([task("old"), task("young")]);
		await fixture.scheduler.enqueue(input("young"), "2030-01-01T00:09:00.000Z");
		await fixture.scheduler.enqueue(input("old"), "2030-01-01T00:01:00.000Z");

		const observed = await fixture.scheduler.observe("workflow-scheduler-test");
		expect(observed.map((entry) => entry.taskId)).toEqual(["old", "young"]);
		await fixture.scheduler.onEvent({
			kind: "task_ready",
			workflowId: "workflow-scheduler-test",
			epochRef: EPOCH,
			eventSequence: 1,
		});
		expect(fixture.dispatched[0]?.taskId).toBe("old");
	});

	it("rejects a queued task when the graph ready set changes", async () => {
		const fixture = createFixture([task("ready")]);
		await fixture.scheduler.enqueue(input("ready"), "2030-01-01T00:01:00.000Z");
		fixture.setGraphTasks([task("ready", { status: "pending" })]);

		await expect(fixture.scheduler.refill("workflow-scheduler-test", EPOCH)).rejects.toMatchObject({
			code: "workflow_scheduler_ready_set_mismatch",
		});
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("preserves the worker control reserve and provider idempotency ceiling", async () => {
		const reservedTask = task("reserved", {
			declaredControlCapacity: { ...ZERO_CONTROL, processSlots: 1 },
		});
		const providerTask = task("provider", {
			declaredResourceVector: vector({
				providers: [
					{
						poolId: "provider",
						concurrentRequests: 1,
						requestsPerMinute: 1,
						totalRequests: 1,
						inputTokens: 1,
						outputTokens: 1,
						idempotency: "provider_native",
					},
				],
			}),
		});
		const envelope: WorkflowResourceEnvelope = {
			envelopeId: "envelope",
			resources: vector(),
			controlPlaneReserve: vector(),
			controlPlaneReserveCapacity: ZERO_CONTROL,
			controlCapacity: ZERO_CONTROL,
			workerCapacity: ZERO_CONTROL,
			processSlots: 1,
			childSessionSlots: 1,
			candidateSlots: 1,
			executionCeilings: {
				maxWorkflowWallMilliseconds: 1,
				maxWorkflowTokens: 1,
				maxModelCalls: 1,
				maxTaskAttempts: 1,
				maxPlannerCycles: 1,
				maxDistinctStrategiesPerRequirement: 1,
				maxAnalysisAttemptsPerRequirement: 1,
				maxRecoveryAttemptsPerEffectClass: 1,
				renewalRequiresUserApproval: true,
			},
			providerQuotaSnapshotRef: {
				artifactId: "provider-quota",
				relativePath: "provider-quota",
				digest: "provider-quota-digest",
				sizeBytes: 1,
				sourceEventSequence: 1,
			},
			inventoryDigest: "inventory",
			pricingDigest: "pricing",
			terminationPolicyDigest: "termination",
			billingReconciliationPolicyDigest: "billing",
			egressPolicyDigest: "egress",
			validFrom: "2030-01-01T00:00:00.000Z",
			validUntil: "2030-01-02T00:00:00.000Z",
			capacityReceipt: null,
			approvalDecisionRef: {} as WorkflowResourceEnvelope["approvalDecisionRef"],
			canonicalLedgerRef: {
				artifactId: "ledger",
				relativePath: "ledger",
				digest: "ledger-digest",
				sizeBytes: 1,
				sourceEventSequence: 1,
			},
			canonicalLedgerDigest: "ledger-digest",
			envelopeDigest: "envelope-digest",
		};
		const fixture = createFixture([reservedTask, providerTask], {
			resourceEnvelope: {
				...envelope,
				resources: vector({
					providers: [
						{
							poolId: "provider",
							concurrentRequests: 1,
							requestsPerMinute: 1,
							totalRequests: 1,
							inputTokens: 1,
							outputTokens: 1,
							idempotency: "host_reconciled",
						},
					],
				}),
				controlPlaneReserveCapacity: { ...ZERO_CONTROL, processSlots: 1 },
			},
		});
		await fixture.scheduler.enqueue(input("reserved"), "2030-01-01T00:01:00.000Z");
		await fixture.scheduler.enqueue(input("provider"), "2030-01-01T00:01:00.000Z");

		const results = await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);
		expect(results).toHaveLength(0);
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("does not enqueue the same attempt twice after a replayed event", async () => {
		const fixture = createFixture([task("once")]);
		const candidate = input("once");
		await fixture.scheduler.enqueue(candidate, "2030-01-01T00:01:00.000Z");
		await fixture.scheduler.enqueue(candidate, "2030-01-01T00:01:00.000Z");

		expect(fixture.state.current.entries).toHaveLength(1);
	});

	it("prefers a bounded critical-path value-of-information signal", async () => {
		const fixture = createFixture([task("z-critical"), task("a-background")], {
			resolveAuthenticatedAdaptiveState: async () =>
				authenticatedAdaptiveState({ criticalPathTaskIds: ["z-critical"], limitingPool: "cpu" }),
			policyWeights: { priority: 0, age: 0, value: 1, uncertainty: 0, cost: 0 },
			readTaskValue: (candidate) => ({
				marginalValidatedImprovement: candidate.taskId === "a-background" ? Number.MAX_SAFE_INTEGER : 0,
				uncertainty: 0,
				cost: 0,
				timeToVerifiedOutcome: 0,
				valueOfInformation: candidate.taskId === "z-critical" ? 100 : 0,
			}),
		});
		await fixture.scheduler.enqueue(input("z-critical"), "2030-01-01T00:01:00.000Z");
		await fixture.scheduler.enqueue(input("a-background"), "2030-01-01T00:01:00.000Z");

		const observed = await fixture.scheduler.observe("workflow-scheduler-test");

		expect(observed[0]?.taskId).toBe("z-critical");
	});

	it("reorders work when a measured bottleneck changes", async () => {
		const provider = {
			poolId: "provider",
			concurrentRequests: 1,
			requestsPerMinute: 1,
			totalRequests: 1,
			inputTokens: 1,
			outputTokens: 1,
			idempotency: "provider_native" as const,
		};
		const fixture = createFixture(
			[task("z-provider", { declaredResourceVector: vector({ providers: [provider] }) }), task("a-cpu")],
			{
				resolveAuthenticatedAdaptiveState: async () =>
					authenticatedAdaptiveState({ criticalPathTaskIds: [], limitingPool: "provider" }),
				policyWeights: { priority: 0, age: 0, value: 0, uncertainty: 0, cost: 0 },
			},
		);
		await fixture.scheduler.enqueue(input("z-provider"), "2030-01-01T00:01:00.000Z");
		await fixture.scheduler.enqueue(input("a-cpu"), "2030-01-01T00:01:00.000Z");

		const observed = await fixture.scheduler.observe("workflow-scheduler-test");

		expect(observed[0]?.taskId).toBe("z-provider");
	});

	it("does not dispatch without an authoritative approved capacity source", async () => {
		const fixture = createFixture([task("unapproved")], {
			resourceEnvelope: undefined,
			workerPartition: undefined,
			controlPartition: undefined,
		});
		await fixture.scheduler.enqueue(input("unapproved"), "2030-01-01T00:01:00.000Z");

		const results = await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);

		expect(results).toHaveLength(0);
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("does not admit skill-bound work without a host-approved recipe binding", async () => {
		const fixture = createFixture([task("skill-bound", { requiredSkillSnapshotDigests: ["skill-digest"] })]);
		await fixture.scheduler.enqueue(input("skill-bound"), "2030-01-01T00:01:00.000Z");

		const results = await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);

		expect(results).toHaveLength(0);
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("does not treat a boolean recipe probe as immutable admission", async () => {
		const fixture = createFixture([task("skill-bound", { requiredSkillSnapshotDigests: ["skill-digest"] })], {
			verifyRecipeAdmission: async () => true,
		} as unknown as Partial<WorkflowSchedulerDependencies>);
		await fixture.scheduler.enqueue(input("skill-bound"), "2030-01-01T00:01:00.000Z");

		const results = await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);

		expect(results).toHaveLength(0);
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("rejects a boolean admission artifact before acquiring a lease", async () => {
		const fixture = createFixture([task("skill-bound", { requiredSkillSnapshotDigests: ["skill-digest"] })], {
			resolveRecipeAdmissionArtifact: async () => true as never,
			resolveRecipeSkillBindings: async () => [],
		});
		await fixture.scheduler.enqueue(input("skill-bound"), "2030-01-01T00:01:00.000Z");

		const results = await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);

		expect(results).toHaveLength(0);
		expect(fixture.dispatched).toHaveLength(0);
		expect(fixture.leaseTransaction.acquire).not.toHaveBeenCalled();
	});

	it("does not use provider capacity without explicit cloud approval", async () => {
		const provider = {
			poolId: "provider",
			concurrentRequests: 1,
			requestsPerMinute: 1,
			totalRequests: 1,
			inputTokens: 1,
			outputTokens: 1,
			idempotency: "provider_native" as const,
		};
		const fixture = createFixture([task("cloud", { declaredResourceVector: vector({ providers: [provider] }) })], {
			workerPartition: {
				controlCapacity: ZERO_CONTROL as never,
				resourceVector: vector({ providers: [provider] }),
			},
		});
		await fixture.scheduler.enqueue(input("cloud"), "2030-01-01T00:01:00.000Z");

		const results = await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);

		expect(results).toHaveLength(0);
		expect(fixture.dispatched).toHaveLength(0);
	});

	it.each(["missing", "expired", "foreign"] as const)(
		"does not let a boolean cloud approval bypass a %s capacity receipt",
		async (mode) => {
			const provider = {
				poolId: "provider",
				concurrentRequests: 1,
				requestsPerMinute: 1,
				totalRequests: 1,
				inputTokens: 1,
				outputTokens: 1,
				idempotency: "provider_native" as const,
			};
			const fixture = createFixture([task("cloud", { declaredResourceVector: vector({ providers: [provider] }) })], {
				resourceEnvelope: mode === "missing" ? undefined : cloudEnvelope(provider, mode),
				workerPartition: {
					controlCapacity: ZERO_CONTROL as never,
					resourceVector: vector({ providers: [provider] }),
				},
			});
			await fixture.scheduler.enqueue(input("cloud"), "2030-01-01T00:01:00.000Z");

			const results = await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);

			expect(results).toHaveLength(0);
			expect(fixture.dispatched).toHaveLength(0);
			expect(fixture.leaseTransaction.acquire).not.toHaveBeenCalled();
		},
	);

	it("dispatches provider work only with a receipt bound to the current task envelope", async () => {
		const provider = {
			poolId: "provider",
			concurrentRequests: 1,
			requestsPerMinute: 1,
			totalRequests: 1,
			inputTokens: 1,
			outputTokens: 1,
			idempotency: "provider_native" as const,
		};
		const fixture = createFixture([task("cloud", { declaredResourceVector: vector({ providers: [provider] }) })], {
			resourceEnvelope: cloudEnvelope(provider, "valid"),
			workerPartition: {
				controlCapacity: ZERO_CONTROL as never,
				resourceVector: vector({ providers: [provider] }),
			},
		});
		await fixture.scheduler.enqueue(input("cloud"), "2030-01-01T00:01:00.000Z");

		const results = await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);

		expect(results).toHaveLength(1);
		expect(fixture.dispatched).toHaveLength(1);
		expect(fixture.leaseTransaction.acquire).toHaveBeenCalledTimes(1);
	});

	it("keeps worker dispatch below the reserved process slot", async () => {
		const fixture = createFixture([task("first"), task("second")], {
			maxConcurrentAttempts: 2,
			resourceEnvelope: {
				resources: vector({ cpuMilliCores: 4 }),
				controlPlaneReserve: zeroVector(),
				controlPlaneReserveCapacity: { ...ZERO_CONTROL, processSlots: 1, verificationSlots: 1, redTeamSlots: 1 },
				workerCapacity: { ...ZERO_CONTROL, processSlots: 2, verificationSlots: 1, redTeamSlots: 1 },
				processSlots: 2,
				candidateSlots: 2,
				capacityReceipt: null,
			} as never,
		});
		await fixture.scheduler.enqueue(input("first"), "2030-01-01T00:01:00.000Z");
		await fixture.scheduler.enqueue(input("second"), "2030-01-01T00:01:00.000Z");

		const results = await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);

		expect(results).toHaveLength(1);
		expect(fixture.dispatched).toHaveLength(1);
	});

	it("rejects an approved worker profile with no candidate slots", async () => {
		const fixture = createFixture([task("capacity-gap")], {
			resourceEnvelope: {
				resources: vector({ cpuMilliCores: 4 }),
				controlPlaneReserve: zeroVector(),
				controlPlaneReserveCapacity: ZERO_CONTROL,
				workerCapacity: { ...ZERO_CONTROL, processSlots: 1 },
				processSlots: 1,
				candidateSlots: 0,
				capacityReceipt: null,
			} as never,
		});
		await fixture.scheduler.enqueue(input("capacity-gap"), "2030-01-01T00:01:00.000Z");

		await expect(fixture.scheduler.refill("workflow-scheduler-test", EPOCH)).rejects.toMatchObject({
			code: "workflow_scheduler_capacity_gap",
		});
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("rejects reserve partitions that exceed the approved worker profile", async () => {
		const fixture = createFixture([task("reserve-theft")], {
			resourceEnvelope: {
				resources: vector({ cpuMilliCores: 4 }),
				controlPlaneReserve: zeroVector(),
				controlPlaneReserveCapacity: { ...ZERO_CONTROL, processSlots: 2 },
				workerCapacity: { ...ZERO_CONTROL, processSlots: 1 },
				processSlots: 1,
				candidateSlots: 1,
				capacityReceipt: null,
			} as never,
		});
		await fixture.scheduler.enqueue(input("reserve-theft"), "2030-01-01T00:01:00.000Z");

		await expect(fixture.scheduler.refill("workflow-scheduler-test", EPOCH)).rejects.toMatchObject({
			code: "workflow_scheduler_reserve_partition_invalid",
		});
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("does not let caller task values reorder work without authenticated evidence", async () => {
		const readTaskValue = vi.fn((candidate: WorkflowTask) => ({
			marginalValidatedImprovement: candidate.taskId === "a-untrusted" ? Number.MAX_SAFE_INTEGER : 0,
			uncertainty: 0,
			cost: 0,
			timeToVerifiedOutcome: 0,
		}));
		const fixture = createFixture([task("z-priority", { planRevision: 2 }), task("a-untrusted")], {
			policyWeights: { priority: 1, age: 0, value: 4, uncertainty: 0, cost: 0 },
			adaptiveState: {
				workflowId: "workflow-scheduler-test",
				criticalPathTaskIds: ["a-untrusted"],
				limitingPool: "cpu",
			} as never,
			readTaskValue,
		});
		await fixture.scheduler.enqueue(input("z-priority"), "2030-01-01T00:01:00.000Z");
		await fixture.scheduler.enqueue(input("a-untrusted"), "2030-01-01T00:01:00.000Z");

		const observed = await fixture.scheduler.observe("workflow-scheduler-test");

		expect(observed.map((entry) => entry.taskId)).toEqual(["z-priority", "a-untrusted"]);
		expect(readTaskValue).not.toHaveBeenCalled();
	});

	it("fails closed when durable scheduling has no authenticated adaptive artifact", async () => {
		const fixture = createFixture([task("adaptive")], {
			store: {
				identity: {
					storeKind: "workflow",
					namespace: "test",
					rootDir: "/tmp/workflow-scheduler-test",
					storeId: "scheduler-store",
					workflowId: "workflow-scheduler-test",
					identityDigest: "scheduler-store-digest",
				},
				replay: async () => ({
					workflowId: "workflow-scheduler-test",
					executionKey: null,
					events: [],
					head: { workflowId: "workflow-scheduler-test", sequence: 0, eventDigest: null, epochRef: EPOCH },
					quarantined: false,
					quarantineReason: null,
				}),
			} as unknown as WorkflowRuntimeStore,
			durableAdmissionTransaction: {
				commit: vi.fn(async () => ({ resourceLease: {} as WorkflowResourceLease, ownershipLease: null })),
				rollback: vi.fn(async () => undefined),
			} as never,
		});
		fixture.state.current = {
			...fixture.state.current,
			entries: [{ input: input("adaptive"), queuedAt: "2030-01-01T00:01:00.000Z", priority: 1, blockedBy: [] }],
		};

		await expect(fixture.scheduler.refill("workflow-scheduler-test", EPOCH)).rejects.toMatchObject({
			code: "workflow_scheduler_adaptive_state_invalid",
		});
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("orders ties by Unicode code point rather than locale", async () => {
		const fixture = createFixture([task("ä"), task("z")]);
		await fixture.scheduler.enqueue(input("ä"), "2030-01-01T00:01:00.000Z");
		await fixture.scheduler.enqueue(input("z"), "2030-01-01T00:01:00.000Z");

		const observed = await fixture.scheduler.observe("workflow-scheduler-test");

		expect(observed.map((entry) => entry.taskId)).toEqual(["z", "ä"]);
	});

	it("removes a terminal attempt exactly once and never redispatches it", async () => {
		const fixture = createFixture([task("terminal")]);
		await fixture.scheduler.enqueue(input("terminal"), "2030-01-01T00:01:00.000Z");
		await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);
		expect(fixture.dispatched).toHaveLength(1);

		const terminalEvent = {
			kind: "attempt_completed" as const,
			workflowId: "workflow-scheduler-test",
			epochRef: EPOCH,
			eventSequence: 1,
			attemptId: "terminal-attempt",
		};
		await fixture.scheduler.onEvent(terminalEvent);
		await fixture.scheduler.onEvent({ ...terminalEvent, eventSequence: 2 });

		expect(fixture.dispatched).toHaveLength(1);
		expect(fixture.state.current.entries).toHaveLength(0);
		expect(fixture.state.current.activeAttemptIds).toHaveLength(0);
	});

	it("requires an attempt id for terminal events while an attempt is active", async () => {
		const fixture = createFixture([task("missing-attempt")]);
		await fixture.scheduler.enqueue(input("missing-attempt"), "2030-01-01T00:01:00.000Z");
		await fixture.scheduler.refill("workflow-scheduler-test", EPOCH);

		await expect(
			fixture.scheduler.onEvent({
				kind: "lease_released",
				workflowId: "workflow-scheduler-test",
				epochRef: EPOCH,
				eventSequence: 1,
			}),
		).rejects.toMatchObject({ code: "workflow_scheduler_attempt_id_required" });
	});

	it("does not wake unrelated work for an unknown terminal attempt", async () => {
		const fixture = createFixture([task("queued"), task("foreign")]);
		await fixture.scheduler.enqueue(input("queued"), "2030-01-01T00:01:00.000Z");

		await expect(
			fixture.scheduler.onEvent({
				kind: "attempt_completed",
				workflowId: "workflow-scheduler-test",
				epochRef: EPOCH,
				eventSequence: 1,
				attemptId: "foreign-attempt",
			}),
		).resolves.toEqual([]);

		expect(fixture.dispatched).toHaveLength(0);
		expect(fixture.state.current.entries).toHaveLength(1);
		await expect(
			fixture.scheduler.enqueue(input("foreign", "foreign-attempt"), "2030-01-01T00:01:00.000Z"),
		).rejects.toMatchObject({
			code: "workflow_scheduler_attempt_terminal",
		});
	});

	it("fails closed instead of composing resource and ownership leases", async () => {
		const fixture = createFixture([task("owned", { ownedPaths: ["workspace/owned"] })], {
			leaseTransaction: undefined,
		});
		await fixture.scheduler.enqueue(input("owned"), "2030-01-01T00:01:00.000Z");

		await expect(fixture.scheduler.refill("workflow-scheduler-test", EPOCH)).rejects.toMatchObject({
			code: "workflow_scheduler_atomic_lease_transaction_required",
		});
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("requires immutable recipe admission before runtime-backed enqueue", async () => {
		const fixture = createFixture([task("durable")], {
			store: {} as WorkflowRuntimeStore,
		});
		await expect(fixture.scheduler.enqueue(input("durable"), "2030-01-01T00:01:00.000Z")).rejects.toMatchObject({
			code: "workflow_scheduler_recipe_admission_required",
		});
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("uses one host lease transaction and rolls back both leases before dispatch", async () => {
		const observe = vi.fn(async () => ({
			...readiness(input("owned")),
			canDispatch: false,
			blockingReasons: ["protocol_review_required" as const],
		}));
		const transaction = {
			acquire: vi.fn(async (request: WorkflowLeaseRequest, ownership: WorkflowOwnershipLeaseRequest | null) => ({
				resourceLease: {
					...request,
					leaseId: `${request.attemptId}-resource`,
					status: "active",
				} as unknown as WorkflowResourceLease,
				ownershipLease:
					ownership === null
						? null
						: ({ ...ownership, leaseId: `${request.attemptId}-ownership`, status: "active" } as never),
			})),
			releasePreDispatch: vi.fn(async () => undefined),
		};
		const fixture = createFixture([task("owned", { ownedPaths: ["workspace/owned"] })], {
			dispatcher: { observe, dispatch: vi.fn() } as unknown as WorkflowDispatcher,
			leaseTransaction: transaction,
		});
		await fixture.scheduler.enqueue(input("owned"), "2030-01-01T00:01:00.000Z");

		await expect(fixture.scheduler.refill("workflow-scheduler-test", EPOCH)).resolves.toEqual([]);
		expect(transaction.acquire).toHaveBeenCalledOnce();
		expect(transaction.releasePreDispatch).toHaveBeenCalledOnce();
		expect(fixture.dispatched).toHaveLength(0);
	});

	it("rolls back the acquired lease pair when dispatch fails", async () => {
		const transaction = {
			acquire: vi.fn(async (request: WorkflowLeaseRequest, ownership: WorkflowOwnershipLeaseRequest | null) => ({
				resourceLease: {
					...request,
					leaseId: `${request.attemptId}-resource`,
					status: "active",
				} as unknown as WorkflowResourceLease,
				ownershipLease:
					ownership === null
						? null
						: ({ ...ownership, leaseId: `${request.attemptId}-ownership`, status: "active" } as never),
			})),
			releasePreDispatch: vi.fn(async () => undefined),
		};
		const dispatcher: WorkflowDispatcher = {
			observe: vi.fn(async (dispatchInput) => readiness(dispatchInput)),
			dispatch: vi.fn(async () => {
				throw new Error("dispatcher failed");
			}),
		};
		const fixture = createFixture([task("dispatch-failure")], { dispatcher, leaseTransaction: transaction });
		await fixture.scheduler.enqueue(input("dispatch-failure"), "2030-01-01T00:01:00.000Z");

		await expect(fixture.scheduler.refill("workflow-scheduler-test", EPOCH)).rejects.toThrow("dispatcher failed");
		expect(transaction.releasePreDispatch).toHaveBeenCalledOnce();
	});

	it("rolls back the acquired lease pair when durable scheduler state cannot be written", async () => {
		const transaction = {
			acquire: vi.fn(async (request: WorkflowLeaseRequest, ownership: WorkflowOwnershipLeaseRequest | null) => ({
				resourceLease: {
					...request,
					leaseId: `${request.attemptId}-resource`,
					status: "active",
				} as unknown as WorkflowResourceLease,
				ownershipLease:
					ownership === null
						? null
						: ({ ...ownership, leaseId: `${request.attemptId}-ownership`, status: "active" } as never),
			})),
			releasePreDispatch: vi.fn(async () => undefined),
		};
		const fixture = createFixture([task("state-failure")], { leaseTransaction: transaction });
		await fixture.scheduler.enqueue(input("state-failure"), "2030-01-01T00:01:00.000Z");
		vi.mocked(fixture.state.write).mockRejectedValueOnce(new Error("state failed"));

		await expect(fixture.scheduler.refill("workflow-scheduler-test", EPOCH)).rejects.toThrow("state failed");
		expect(transaction.releasePreDispatch).toHaveBeenCalledOnce();
	});

	it("fails closed when only one revision boundary dependency is supplied", async () => {
		const fixture = createFixture([task("revision")], {
			readRevisionBoundaryContext: vi.fn(),
			revisionRegistry: undefined,
		});
		await expect(fixture.scheduler.enqueue(input("revision"), "2030-01-01T00:01:00.000Z")).rejects.toMatchObject({
			code: "workflow_scheduler_revision_boundary_missing",
		});
	});

	it("serializes concurrent refills for the same workflow", async () => {
		const dispatchCalls: string[] = [];
		let releaseDispatch: (() => void) | undefined;
		let markDispatchStarted: (() => void) | undefined;
		const dispatchStarted = new Promise<void>((resolve) => {
			markDispatchStarted = resolve;
		});
		const dispatcher: WorkflowDispatcher = {
			observe: vi.fn(async (dispatchInput) => readiness(dispatchInput)),
			dispatch: vi.fn(async (dispatchInput) => {
				dispatchCalls.push(dispatchInput.attemptId);
				markDispatchStarted?.();
				await new Promise<void>((resolveDispatch) => {
					releaseDispatch = resolveDispatch;
				});
				return {
					status: "disabled",
					phase: "readiness",
					admission: null,
					readiness: readiness(dispatchInput),
				} as WorkflowDispatchResult;
			}),
		};
		const fixture = createFixture([task("race")], { dispatcher });
		await fixture.scheduler.enqueue(input("race"), "2030-01-01T00:01:00.000Z");

		const first = fixture.scheduler.refill("workflow-scheduler-test", EPOCH);
		await dispatchStarted;
		const second = fixture.scheduler.refill("workflow-scheduler-test", EPOCH);
		expect(dispatchCalls).toEqual(["race-attempt"]);
		releaseDispatch?.();
		await Promise.all([first, second]);
		expect(dispatchCalls).toEqual(["race-attempt"]);
	});
});
