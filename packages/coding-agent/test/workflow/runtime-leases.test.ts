import { expect, it } from "vitest";
import type {
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalCommit,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowResourceVector,
	WorkflowRuntimeStore,
	WorkflowStoreCommitInput,
} from "../../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject } from "../../src/core/workflow/contracts.js";
import { leaseRefOf } from "../../src/core/workflow/dispatch.js";
import {
	createWorkflowLeaseManager,
	WorkflowLeaseError,
	type WorkflowLeaseManagerDependencies,
	type WorkflowLeaseRequest,
} from "../../src/core/workflow/leases.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const CONTROL_ZERO = {
	processSlots: 0,
	childSessionSlots: 0,
	modelCallSlots: 0,
	modelInputTokens: 0,
	modelOutputTokens: 0,
	verificationSlots: 0,
	redTeamSlots: 0,
	recoverySlots: 0,
} as const;

it("requires replay hydration before admitting a lease", async () => {
	const fixture = createFixture();
	const leases = createWorkflowLeaseManager(fixture.dependencies);

	await expect(leases.acquireResource(fixture.request())).rejects.toMatchObject({
		code: "workflow_lease_replay_required",
	});
});

it("binds resource admission to every vector and control-capacity component", async () => {
	const fixture = createFixture();
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();

	const admitted = await leases.acquireResource(
		fixture.request({
			vector: resourceVector({ cpuMilliCores: 300, memoryBytes: 1_024 }),
			controlCapacity: { ...CONTROL_ZERO, processSlots: 1, modelInputTokens: 512 },
			processSlots: 1,
			controlPlane: true,
		}),
	);
	expect(admitted.resourceAdmission.declaredVector.cpuMilliCores).toBe(300);
	expect(admitted.controlCapacity.modelInputTokens).toBe(512);
	expect(await leases.activeVector("wf-fixture")).toEqual(resourceVector({ cpuMilliCores: 300, memoryBytes: 1_024 }));
	expect(await leases.activeControlCapacity("wf-fixture")).toEqual({
		...CONTROL_ZERO,
		processSlots: 1,
		modelInputTokens: 512,
	});

	await expect(
		leases.acquireResource(
			fixture.request({
				attemptId: "attempt-saturated",
				vector: resourceVector({ cpuMilliCores: 701 }),
				controlCapacity: CONTROL_ZERO,
				processSlots: 0,
				controlPlane: true,
			}),
		),
	).rejects.toMatchObject({ code: "workflow_resource_limit" });

	await expect(
		leases.acquireResource(
			fixture.request({
				attemptId: "attempt-binding",
				controlCapacity: { ...CONTROL_ZERO, processSlots: 1 },
				processSlots: 0,
			}),
		),
	).rejects.toMatchObject({ code: "workflow_control_capacity_binding_mismatch" });
});

it("rejects canonical-path overlap and authority-bound ownership", async () => {
	const fixture = createFixture();
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();

	const first = await leases.acquireOwnership({
		...fixture.request(),
		ownedPaths: ["workspace/src"],
		ownedContracts: ["contract-a"],
	});
	expect(first.ownedPaths).toEqual(["workspace/src"]);

	await expect(
		leases.acquireOwnership({
			...fixture.request({ attemptId: "attempt-owner-2" }),
			ownedPaths: ["workspace/src/nested"],
			ownedContracts: [],
		}),
	).rejects.toMatchObject({ code: "workflow_ownership_overlap" });

	await expect(
		leases.acquireOwnership({
			...fixture.request({ attemptId: "attempt-owner-3" }),
			ownedPaths: ["workspace/../escape"],
			ownedContracts: [],
		}),
	).rejects.toMatchObject({ code: "workflow_ownership_path_invalid" });
});

it("counts a resource and its matching ownership lease once", async () => {
	const fixture = createFixture();
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();
	const request = fixture.request({
		vector: resourceVector({ cpuMilliCores: 300 }),
		controlPlane: false,
	});
	await leases.acquireResource(request);
	await leases.acquireOwnership({
		...request,
		ownedPaths: ["workspace/src"],
		ownedContracts: ["contract-a"],
	});

	expect(await leases.activeVector("wf-fixture")).toEqual(resourceVector({ cpuMilliCores: 300 }));
	expect(await leases.activeControlCapacity("wf-fixture")).toEqual(CONTROL_ZERO);
});

it("does not double-count a pre-existing matching ownership reservation when resource admission follows", async () => {
	const fixture = createFixture();
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();
	const request = fixture.request({ vector: resourceVector({ cpuMilliCores: 300 }) });
	await leases.acquireOwnership({
		...request,
		ownedPaths: ["workspace/src"],
		ownedContracts: ["contract-a"],
	});
	await leases.acquireResource(request);

	expect(await leases.activeVector(request.workflowId)).toEqual(resourceVector({ cpuMilliCores: 300 }));
});

it("does not reuse a released lease identity", async () => {
	const fixture = createFixture();
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();
	const request = fixture.request();
	const admitted = await leases.acquireResource(request);
	const leaseRef = fixture.leaseRef(
		admitted.leaseId,
		admitted.acquisitionEventSequence,
		admitted.expiresAt,
		admitted.resourceAdmission.admissionDigest,
	);
	const outcomeDigest = fixture.appendOutcome(request.attemptId, request.executionKey);
	await leases.release({
		workflowId: request.workflowId,
		attemptId: request.attemptId,
		leaseRef,
		epochRef: EPOCH,
		outcomeDigest,
		store: fixture.store as unknown as WorkflowRuntimeStore,
	});

	await expect(leases.acquireResource(fixture.request())).rejects.toMatchObject({
		code: "workflow_lease_reuse_forbidden",
	});
});

it("excludes a lease after the trusted monotonic TTL and admits the next attempt", async () => {
	const fixture = createFixture();
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();
	const admitted = await leases.acquireResource(fixture.request({ attemptId: "attempt-expired" }));
	const leaseRef = fixture.leaseRef(
		admitted.leaseId,
		admitted.acquisitionEventSequence,
		admitted.expiresAt,
		admitted.resourceAdmission.admissionDigest,
	);
	fixture.setMonotonicNow(30_100);

	expect(await leases.activeVector("wf-fixture")).toEqual(resourceVector());
	expect(await leases.lookupByLease("wf-fixture", leaseRef)).toMatchObject({ leaseStatus: "expired" });
	await expect(leases.acquireResource(fixture.request({ attemptId: "attempt-expired" }))).rejects.toMatchObject({
		code: "workflow_lease_expired",
	});
	const reopened = createWorkflowLeaseManager(fixture.dependencies);
	await reopened.hydrateFromReplay();
	expect(await reopened.activeVector("wf-fixture")).toEqual(resourceVector());
	await expect(leases.acquireResource(fixture.request({ attemptId: "attempt-after-expiry" }))).resolves.toMatchObject({
		attemptId: "attempt-after-expiry",
	});
});

it("releases a pre-dispatch lease without requiring a child outcome", async () => {
	const fixture = createFixture();
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();
	const request = fixture.request({ attemptId: "attempt-rollback", vector: resourceVector({ cpuMilliCores: 300 }) });
	const resourceLease = await leases.acquireResource(request);
	const ownershipLease = await leases.acquireOwnership({
		...request,
		ownedPaths: ["workspace/src"],
		ownedContracts: ["contract-a"],
	});
	const leaseRef = fixture.leaseRef(
		resourceLease.leaseId,
		resourceLease.acquisitionEventSequence,
		resourceLease.expiresAt,
		resourceLease.resourceAdmission.admissionDigest,
	);

	if (leases.releasePreDispatch === undefined) throw new Error("pre-dispatch release is unavailable");
	await leases.releasePreDispatch({
		workflowId: request.workflowId,
		attemptId: request.attemptId,
		executionKey: request.executionKey,
		epochRef: EPOCH,
		resourceLease,
		ownershipLease,
	});

	expect(await leases.activeVector(request.workflowId)).toEqual(resourceVector());
	expect(fixture.events.map((event) => event.payload.kind)).toEqual([
		"workflow_resource_lease_acquired",
		"workflow_ownership_lease_acquired",
		"workflow_lease_release_recorded",
		"workflow_lease_release_recorded",
	]);
	expect((await leases.lookupByLease(request.workflowId, leaseRef))?.leaseStatus).toBe("released");
});

it("reserves capacity and records one dispatch intent under the durable admission gate", async () => {
	const fixture = createFixture();
	const durableStore = fixture.store as unknown as {
		durableContext: { withExclusiveLease<T>(boundary: string, operation: () => Promise<T>): Promise<T> };
	};
	durableStore.durableContext = {
		withExclusiveLease: async (_boundary, operation) => operation(),
	};
	let admissionResult: unknown;
	const admission = fixture.dependencies.admission as unknown as {
		admit(context: unknown): Promise<unknown>;
	};
	admission.admit = async (context: unknown) => {
		if (admissionResult !== undefined) return admissionResult;
		const typed = context as {
			workflowId: string;
			taskId: string;
			attemptId: string;
			executionKey: string;
			epochRef: WorkflowEpochRef;
			decisionRef: never;
			resourceLeaseRef: WorkflowLeaseRef;
			ownershipLeaseRef: WorkflowLeaseRef | null;
			childAuthority: never;
			launchConfigDigest: string;
			expectedEffectDigest: string;
		};
		fixture.store.append({
			kind: "workflow_dispatch_intent",
			workflowId: typed.workflowId,
			taskId: typed.taskId,
			attemptId: typed.attemptId,
			executionKey: typed.executionKey,
			admissionId: `admission:${typed.executionKey}`,
			epochRef: typed.epochRef,
			decisionRef: typed.decisionRef,
			resourceLeaseRef: typed.resourceLeaseRef,
			ownershipLeaseRef: typed.ownershipLeaseRef,
			childAuthority: typed.childAuthority,
			launchConfigDigest: typed.launchConfigDigest,
			expectedEffectDigest: typed.expectedEffectDigest,
		});
		admissionResult = { context, admissionId: `admission:${typed.executionKey}` };
		return admissionResult;
	};
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();
	const request = fixture.request({ attemptId: "attempt-dispatch" });
	const result = await leases.reserveDispatch?.({
		workflowId: request.workflowId,
		epochRef: request.epochRef,
		resource: request,
		ownership: null,
		createAdmissionContext: (resourceLease) =>
			({
				workflowId: request.workflowId,
				rootSessionId: "root-fixture",
				taskId: request.taskId,
				attemptId: request.attemptId,
				executionKey: request.executionKey,
				idempotencyKey: "fixture-2",
				decisionRef: {} as never,
				resourceLeaseRef: leaseRefOf(resourceLease),
				controlCapacity: request.controlCapacity,
				ownershipLeaseRef: null,
				childAuthority: {} as never,
				launchConfigDigest: "launch-fixture",
				expectedEffectDigest: "effect-fixture",
				epochRef: request.epochRef,
				configSnapshotDigest: "config-fixture",
				revisionTuple: {} as never,
				revisionRegistryRef: {} as never,
				revisionRegistryDigest: "revision-fixture",
				writerIdentity: "writer-root",
			}) as never,
	});

	expect(result?.resourceLease.attemptId).toBe(request.attemptId);
	expect(fixture.events.map((event) => event.payload.kind)).toEqual([
		"workflow_resource_lease_acquired",
		"workflow_dispatch_intent",
	]);
});

it("fails closed and rolls leases back when admission returns without a durable intent", async () => {
	const fixture = createFixture();
	const durableStore = fixture.store as unknown as {
		durableContext: { withExclusiveLease<T>(boundary: string, operation: () => Promise<T>): Promise<T> };
	};
	durableStore.durableContext = {
		withExclusiveLease: async (_boundary, operation) => operation(),
	};
	const admission = fixture.dependencies.admission as unknown as {
		admit(context: unknown): Promise<unknown>;
	};
	admission.admit = async (context: unknown) => ({
		context,
		admissionId: `admission:${(context as { executionKey: string }).executionKey}`,
	});
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();
	const request = fixture.request({ attemptId: "attempt-no-intent" });

	await expect(
		leases.reserveDispatch?.({
			workflowId: request.workflowId,
			epochRef: request.epochRef,
			resource: request,
			ownership: null,
			createAdmissionContext: (resourceLease) =>
				({
					workflowId: request.workflowId,
					rootSessionId: "root-fixture",
					taskId: request.taskId,
					attemptId: request.attemptId,
					executionKey: request.executionKey,
					idempotencyKey: "fixture-2",
					resourceLeaseRef: leaseRefOf(resourceLease),
					controlCapacity: request.controlCapacity,
					ownershipLeaseRef: null,
					epochRef: request.epochRef,
					writerIdentity: "writer-root",
				}) as never,
		}),
	).rejects.toMatchObject({ code: "workflow_dispatch_intent_missing" });

	expect(await leases.activeVector(request.workflowId)).toEqual(resourceVector());
	expect(fixture.events.map((event) => event.payload.kind)).toEqual([
		"workflow_resource_lease_acquired",
		"workflow_lease_release_recorded",
	]);
});

it("does not release a pre-existing resource lease when ownership rollback fails admission", async () => {
	const fixture = createFixture();
	const durableStore = fixture.store as unknown as {
		durableContext: { withExclusiveLease<T>(boundary: string, operation: () => Promise<T>): Promise<T> };
	};
	durableStore.durableContext = {
		withExclusiveLease: async (_boundary, operation) => operation(),
	};
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();
	const request = fixture.request({ attemptId: "attempt-existing-resource" });
	const resourceLease = await leases.acquireResource(request);

	await expect(
		leases.reserveDispatch?.({
			workflowId: request.workflowId,
			epochRef: request.epochRef,
			resource: request,
			ownership: { ...request, ownedPaths: ["workspace/src"], ownedContracts: ["contract-a"] },
			createAdmissionContext: () => {
				throw new Error("admission rejected");
			},
		}),
	).rejects.toThrow("admission rejected");

	expect(await leases.activeVector(request.workflowId)).toEqual(resourceLease.resourceAdmission.reservedVector);
	expect(fixture.events.map((event) => event.payload.kind)).toEqual([
		"workflow_resource_lease_acquired",
		"workflow_ownership_lease_acquired",
		"workflow_lease_release_recorded",
	]);
});

it("releases a terminal lease exactly once and fences stale epochs", async () => {
	const fixture = createFixture();
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();
	const lease = await leases.acquireResource(fixture.request({ attemptId: "attempt-release" }));
	const leaseRef = fixture.leaseRef(
		lease.leaseId,
		lease.acquisitionEventSequence,
		lease.expiresAt,
		lease.resourceAdmission.admissionDigest,
	);

	await expect(
		leases.release({
			workflowId: "wf-fixture",
			attemptId: "attempt-release",
			leaseRef,
			epochRef: EPOCH,
			outcomeDigest: "missing-outcome",
			store: fixture.store as unknown as WorkflowRuntimeStore,
		}),
	).rejects.toMatchObject({ code: "workflow_outcome_required" });

	const outcomeDigest = fixture.appendOutcome("attempt-release", "execution-attempt-release");
	const releaseInput = {
		workflowId: "wf-fixture",
		attemptId: "attempt-release",
		leaseRef,
		epochRef: EPOCH,
		outcomeDigest,
		store: fixture.store as unknown as WorkflowRuntimeStore,
	};
	const first = await leases.release(releaseInput);
	const second = await leases.release(releaseInput);
	expect(first.status).toBe("released");
	expect(second).toEqual({ ...first, status: "already_released" });
	expect(fixture.events.filter((event) => event.payload.kind === "workflow_lease_release_recorded")).toHaveLength(1);
	expect(await leases.activeVector("wf-fixture")).toEqual(resourceVector());

	fixture.currentEpoch = { storeEpoch: 1, coordinatorEpoch: 2 };
	await expect(leases.release(releaseInput)).rejects.toMatchObject({ code: "workflow_epoch_stale" });
});

it("quarantines uncertain leases and keeps their capacity unavailable after replay", async () => {
	const fixture = createFixture();
	const leases = createWorkflowLeaseManager(fixture.dependencies);
	await leases.hydrateFromReplay();
	const lease = await leases.acquireResource(
		fixture.request({ attemptId: "attempt-quarantine", vector: resourceVector({ cpuMilliCores: 25 }) }),
	);
	const leaseRef = fixture.leaseRef(
		lease.leaseId,
		lease.acquisitionEventSequence,
		lease.expiresAt,
		lease.resourceAdmission.admissionDigest,
	);

	const result = await leases.quarantine({
		workflowId: "wf-fixture",
		attemptId: "attempt-quarantine",
		leaseRef,
		epochRef: EPOCH,
		store: fixture.store as unknown as WorkflowRuntimeStore,
		executionKey: "execution-attempt-fixture",
		reason: "uncertain-process",
	});
	expect(result).toMatchObject({ status: "quarantined", reason: "uncertain-process" });
	expect(await leases.activeVector("wf-fixture")).toEqual(resourceVector({ cpuMilliCores: 25 }));

	const reopened = createWorkflowLeaseManager(fixture.dependencies);
	await reopened.hydrateFromReplay();
	expect(await reopened.lookupByLease("wf-fixture", leaseRef)).toMatchObject({
		leaseStatus: "quarantined",
	});
});

function createFixture(): {
	dependencies: WorkflowLeaseManagerDependencies;
	store: RecordingStore;
	events: RecordingStore["events"];
	request(overrides?: Partial<WorkflowLeaseRequest>): WorkflowLeaseRequest;
	leaseRef(leaseId: string, acquisitionEventSequence: number, expiresAt: string, rootDigest: string): WorkflowLeaseRef;
	appendOutcome(attemptId: string, executionKey: string): string;
	setMonotonicNow(value: number): void;
	currentEpoch: WorkflowEpochRef;
} {
	const store = new RecordingStore();
	const rootLeaseRef: WorkflowLeaseRef = {
		...EPOCH,
		leaseId: "root-lease",
		acquisitionEventSequence: 1,
		processIdentity: "process-root",
		rootDigest: "root-digest",
		writerIdentity: "writer-root",
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T00:05:00.000Z",
	};
	let currentEpoch = EPOCH;
	let latestRequest: WorkflowLeaseRequest | null = null;
	const outcomeAdmissions = new Map<
		string,
		{ executionKey: string; outcomeDigest: string; terminalEventSequence: number }
	>();
	const revisionBoundary = {
		workflowId: "wf-fixture",
		epochRef: EPOCH,
		leaseRef: rootLeaseRef,
		executionKey: null,
		revisionTuple: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			evidenceRevision: 1,
			configRevision: 1,
		},
		revisionRegistryRef: artifactRef("revision-registry"),
		revisionRegistryDigest: "revision-digest",
		configSnapshotDigest: "config-digest",
		tupleDigest: "",
	};
	revisionBoundary.tupleDigest = digestObject({
		workflowId: revisionBoundary.workflowId,
		epochRef: revisionBoundary.epochRef,
		leaseRef: revisionBoundary.leaseRef,
		executionKey: revisionBoundary.executionKey,
		revisionTuple: revisionBoundary.revisionTuple,
		revisionRegistryRef: revisionBoundary.revisionRegistryRef,
		revisionRegistryDigest: revisionBoundary.revisionRegistryDigest,
		configSnapshotDigest: revisionBoundary.configSnapshotDigest,
	});
	let monotonicNow = 100;
	const dependencies = {
		store,
		workflowRoot: process.cwd(),
		controlPlaneReserve: resourceVector({ cpuMilliCores: 100 }),
		controlPartition: {
			capacity: { ...CONTROL_ZERO, processSlots: 2, modelInputTokens: 1_024 },
			resourceVector: resourceVector({ cpuMilliCores: 1_000, memoryBytes: 10_000 }),
			canonicalPoolLedgerRef: artifactRef("ledger"),
			partitionDigest: "control-partition",
		},
		workerPartition: {
			resourceVector: resourceVector({ cpuMilliCores: 900, memoryBytes: 9_000 }),
			controlCapacity: CONTROL_ZERO,
			enforcementClass: "isolated_metered" as const,
			canonicalPoolLedgerRef: artifactRef("ledger"),
			partitionDigest: "worker-partition",
		},
		observedControlCapacity: { ...CONTROL_ZERO, processSlots: 2, modelInputTokens: 1_024 },
		poolMap: { accelerators: new Map(), providers: new Map(), digest: "pools" },
		resourceCeiling: resourceVector({ cpuMilliCores: 1_000, memoryBytes: 10_000 }),
		writerIdentity: "writer-root",
		rootLeaseRef,
		canonicalPoolLedgerRef: artifactRef("ledger"),
		trustedNow: () => "2030-01-01T00:00:00.000Z",
		trustedMonotonicNow: () => monotonicNow,
		resourceLeaseTtlMilliseconds: 30_000,
		leaseTtlStore: {
			values: new Map<string, { sequence: number; observedAtMonotonicMs: number; expiresAtMonotonicMs: number }>(),
			read(leaseId: string) {
				return Promise.resolve(this.values.get(leaseId) ?? null);
			},
			write(
				leaseId: string,
				value: { sequence: number; observedAtMonotonicMs: number; expiresAtMonotonicMs: number },
			) {
				this.values.set(leaseId, value);
				return Promise.resolve();
			},
		},
		epochs: {
			assertCurrent: async (_workflowId: string, epoch: WorkflowEpochRef) => {
				if (
					epoch.storeEpoch !== currentEpoch.storeEpoch ||
					epoch.coordinatorEpoch !== currentEpoch.coordinatorEpoch
				)
					throw new WorkflowLeaseError("workflow_epoch_stale");
			},
		},
		readActiveLeaseContext: async () => ({
			workflowId: "wf-fixture",
			epochRef: currentEpoch,
			leaseRef: rootLeaseRef,
			writerIdentity: "writer-root",
			generationId: "generation-1",
			revisionBoundary,
		}),
		readRevisionBoundaryContext: async (
			_workflowId: string,
			epochRef: WorkflowEpochRef,
			executionKey: string | null,
		) => {
			const context = { ...revisionBoundary, epochRef, executionKey };
			return {
				...context,
				tupleDigest: digestObject({
					workflowId: context.workflowId,
					epochRef: context.epochRef,
					leaseRef: context.leaseRef,
					executionKey: context.executionKey,
					revisionTuple: context.revisionTuple,
					revisionRegistryRef: context.revisionRegistryRef,
					revisionRegistryDigest: context.revisionRegistryDigest,
					configSnapshotDigest: context.configSnapshotDigest,
				}),
			};
		},
		revisionBoundary,
		activeLease: {
			workflowId: "wf-fixture",
			epochRef: EPOCH,
			leaseRef: rootLeaseRef,
			writerIdentity: "writer-root",
			generationId: "generation-1",
			revisionBoundary,
		},
		admission: {
			listByWorkflow: async () =>
				[...outcomeAdmissions.entries()].map(
					([attemptId, outcome]) =>
						({
							context: { attemptId, executionKey: outcome.executionKey },
							terminalEventSequence: outcome.terminalEventSequence,
							outcomeDigest: outcome.outcomeDigest,
						}) as never,
				),
		},
		readAdmissionBinding: async (workflowId: string, taskId: string, attemptId: string, executionKey: string) => {
			if (
				latestRequest === null ||
				latestRequest.workflowId !== workflowId ||
				latestRequest.taskId !== taskId ||
				latestRequest.attemptId !== attemptId ||
				latestRequest.executionKey !== executionKey
			)
				return null;
			return {
				workflowId,
				taskId,
				attemptId,
				executionKey,
				epochRef: EPOCH,
				controlCapacity: latestRequest.controlCapacity,
			};
		},
		readTask: async (_workflowId: string, taskId: string) =>
			latestRequest === null || latestRequest.taskId !== taskId
				? null
				: {
						taskId,
						planRevision: 1,
						objective: "exercise lease authority",
						requirementIds: ["lease-authority"],
						completionCriteria: ["lease released or quarantined"],
						dependencyTaskIds: [],
						ownedPaths: ["workspace/src", "workspace/src/nested"],
						ownedContracts: ["contract-a"],
						requiredSkillSnapshotDigests: [],
						verificationCommandDigests: [],
						authority: ["observe_workflow"],
						declaredResourceVector: latestRequest.vector,
						declaredControlCapacity: latestRequest.controlCapacity,
						status: "ready" as const,
						attemptIds: [],
					},
		readGrant: async (request: WorkflowLeaseRequest) => ({
			workflowId: request.workflowId,
			taskId: request.taskId,
			attemptId: request.attemptId,
			executionKey: request.executionKey,
			epochRef: request.epochRef,
			vector: request.vector,
			controlCapacity: request.controlCapacity,
			grantDigest: digestObject(request),
			canonicalLedgerDigest: artifactRef("ledger").digest,
		}),
		callbackFenceStore: {},
		revisionRegistry: { assertActive: async () => undefined },
	} as unknown as WorkflowLeaseManagerDependencies;

	const result = {
		dependencies,
		store,
		events: store.events,
		request(overrides: Partial<WorkflowLeaseRequest> = {}) {
			const request = {
				workflowId: "wf-fixture",
				taskId: "task-fixture",
				attemptId: "attempt-fixture",
				executionKey: "execution-attempt-fixture",
				epochRef: EPOCH,
				vector: resourceVector({ cpuMilliCores: 1, memoryBytes: 1 }),
				controlCapacity: CONTROL_ZERO,
				enforcementClass: "isolated_metered" as const,
				processSlots: 0,
				conflictKey: "workspace-fixture",
				queuePriority: 1,
				queuedAt: "2030-01-01T00:00:00.000Z",
				controlPlane: false,
				...overrides,
			};
			latestRequest = request;
			return request;
		},
		leaseRef(leaseId: string, acquisitionEventSequence: number, expiresAt: string, rootDigest: string) {
			return {
				...EPOCH,
				leaseId,
				acquisitionEventSequence,
				processIdentity: "writer-root",
				rootDigest,
				writerIdentity: "writer-root",
				acquiredAt: "2030-01-01T00:00:00.000Z",
				expiresAt,
			};
		},
		appendOutcome(attemptId: string, executionKey: string) {
			const payload = {
				kind: "workflow_child_outcome_committed" as const,
				workflowId: "wf-fixture",
				attemptId,
				executionKey,
				outcome: {} as never,
				outcomeDigest: `outcome-${attemptId}`,
				epochRef: EPOCH,
			};
			store.append(payload);
			outcomeAdmissions.set(attemptId, {
				executionKey,
				outcomeDigest: payload.outcomeDigest,
				terminalEventSequence: store.events[store.events.length - 1]!.sequence,
			});
			return payload.outcomeDigest;
		},
		setMonotonicNow(value: number) {
			monotonicNow = value;
		},
		get currentEpoch() {
			return currentEpoch;
		},
		set currentEpoch(value: WorkflowEpochRef) {
			currentEpoch = value;
		},
	};
	return result;
}

class RecordingStore {
	readonly identity = {
		storeKind: "workflow" as const,
		namespace: "test",
		rootDir: "/tmp/workflow-fixture",
		storeId: "store-fixture",
		workflowId: "wf-fixture",
		identityDigest: "store-digest",
	};
	readonly events: WorkflowJournalCommit<WorkflowEventPayload>[] = [];
	private head: WorkflowJournalHead = { workflowId: "wf-fixture", sequence: 0, eventDigest: null, epochRef: EPOCH };

	async commit<TPayload extends WorkflowEventPayload>(input: WorkflowStoreCommitInput<TPayload>) {
		const prior = this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
		if (prior)
			return {
				status: "already_committed" as const,
				payload: prior.payload as TPayload,
				commit: prior as WorkflowJournalCommit<TPayload>,
				state: {},
				head: this.head,
			};
		if (input.expectedHead.sequence !== this.head.sequence) throw new Error("conflict");
		const sequence = this.head.sequence + 1;
		const eventDigest = digestObject({ sequence, payload: input.payload });
		const commit = this.commitRecord(input, sequence, eventDigest);
		this.events.push(commit);
		this.head = {
			workflowId: "wf-fixture",
			sequence,
			eventDigest,
			epochRef: payloadEpoch(input.payload),
		};
		return {
			status: "committed" as const,
			payload: input.payload,
			commit,
			state: {},
			head: this.head,
		};
	}

	append(payload: WorkflowEventPayload): void {
		const executionKey = "executionKey" in payload ? payload.executionKey : null;
		const leaseRef: WorkflowLeaseRef = {
			...EPOCH,
			leaseId: "root-lease",
			acquisitionEventSequence: 1,
			processIdentity: "process-root",
			rootDigest: "root-digest",
			writerIdentity: "writer-root",
			acquiredAt: "2030-01-01T00:00:00.000Z",
			expiresAt: "2030-01-01T00:05:00.000Z",
		};
		const idempotencyKey = `fixture-${this.head.sequence + 1}`;
		const semanticBinding = {
			mutationId: idempotencyKey,
			baselineDigest: digestObject(this.head),
			expectedGenerations: { workflow: EPOCH.storeEpoch },
			ownerId: "writer-root",
			phase: "executing" as const,
			reducerDigest: digestObject(payload),
			semanticHead: {
				workflowId: "wf-fixture",
				sequence: this.head.sequence,
				eventDigest: this.head.eventDigest,
				stateDigest: digestObject(this.head),
				epochRef: EPOCH,
				generation: EPOCH.storeEpoch,
			},
			expectedHead: this.head,
			idempotencyKey,
			executionKey,
			writerIdentity: "writer-root",
			leaseRef,
			epochRef: EPOCH,
		};
		const input: WorkflowStoreCommitInput<WorkflowEventPayload> = {
			workflowId: "wf-fixture",
			payload,
			expectedHead: this.head,
			semanticBinding,
			epochRef: EPOCH,
			leaseRef,
			idempotencyKey,
			writerIdentity: "writer-root",
			executionKey,
		};
		const sequence = this.head.sequence + 1;
		const eventDigest = digestObject({ sequence, payload });
		const commit = this.commitRecord(input, sequence, eventDigest);
		this.head = {
			...this.head,
			sequence,
			eventDigest,
			epochRef: payloadEpoch(payload),
		};
		this.events.push(commit);
	}

	private commitRecord<TPayload extends WorkflowEventPayload>(
		input: WorkflowStoreCommitInput<TPayload>,
		sequence: number,
		eventDigest: string,
	): WorkflowJournalCommit<TPayload> {
		return {
			workflowId: input.workflowId,
			sequence,
			payload: input.payload,
			payloadBytes: canonicalJsonBytes(input.payload),
			payloadDigest: digestObject(input.payload),
			priorEventDigest: input.expectedHead.eventDigest,
			eventDigest,
			recordVersion: 1,
			generationId: "generation-1",
			recordMac: "record-mac",
			recordChecksum: "record-checksum",
			expectedHead: input.expectedHead,
			epochRef: input.epochRef,
			leaseRef: input.leaseRef,
			idempotencyKey: input.idempotencyKey,
			returnProofId: `return-proof:${input.idempotencyKey}`,
			commitReturnProof: {} as never,
			preparedFrameDigest: "prepared-frame-digest",
			committedFrameDigest: "committed-frame-digest",
			keyId: "key-1",
			preparedFrameMac: "prepared-frame-mac",
			committedFrameMac: "committed-frame-mac",
			preparedFrameChecksum: "prepared-frame-checksum",
			committedFrameChecksum: "committed-frame-checksum",
			semanticBinding: input.semanticBinding,
			executionKey: input.executionKey,
			writerIdentity: input.writerIdentity,
		};
	}

	async replay() {
		return {
			workflowId: "wf-fixture",
			executionKey: null,
			events: this.events,
			head: this.head,
			quarantined: false,
			quarantineReason: null,
		};
	}

	async publishArtifact(input: { idempotencyKey: string }) {
		return {
			status: "published" as const,
			envelope: {
				ref: {
					artifactId: input.idempotencyKey,
					relativePath: `barriers/${input.idempotencyKey}.json`,
					digest: digestObject({ idempotencyKey: input.idempotencyKey }),
					sizeBytes: 1,
					sourceEventSequence: this.head.sequence,
				},
				payloadKind: "barrier" as const,
				codec: "canonical_json" as const,
				immutable: true as const,
			},
		};
	}
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

function payloadEpoch(payload: WorkflowEventPayload): WorkflowEpochRef {
	return "epochRef" in payload ? payload.epochRef : EPOCH;
}

function artifactRef(artifactId: string) {
	return {
		artifactId,
		relativePath: `artifacts/${artifactId}.json`,
		digest: `${artifactId}-digest`,
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
}
