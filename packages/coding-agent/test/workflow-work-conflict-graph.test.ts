import { describe, expect, it } from "vitest";
import {
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorizer,
	type WorkflowHostReceiptCapability,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import {
	computeWorkConflictOperationDigest,
	planUsefulParallelDispatch,
	type WorkConflictAcceleratorPool,
	type WorkConflictAuthenticatedCapacity,
	type WorkConflictControlVector,
	type WorkConflictGraphInput,
	type WorkConflictHostAuthorization,
	type WorkConflictPathProofContext,
	type WorkConflictProtectedScope,
	type WorkConflictProviderPool,
	type WorkConflictResourceRequest,
	type WorkConflictResourceVector,
	type WorkConflictTask,
} from "../src/core/workflow/work-conflict-graph.js";

const ZERO_RESOURCE: WorkConflictResourceVector = {
	cpuMilliCores: 0,
	memoryBytes: 0,
	diskBytes: 0,
	ioWeight: 0,
	networkEgressBytes: 0,
	wallMilliseconds: 0,
	monetaryMicrounits: 0,
};

const ZERO_CONTROL: WorkConflictControlVector = {
	processSlots: 0,
	childSessionSlots: 0,
	modelCallSlots: 0,
	modelInputTokens: 0,
	modelOutputTokens: 0,
	verificationSlots: 0,
	redTeamSlots: 0,
	recoverySlots: 0,
};

const FIXTURE_RECEIPT_CONTEXT = createFixtureHostReceiptConsumerContext();
const FIXTURE_KEY = await FIXTURE_RECEIPT_CONTEXT.keyResolver.resolve("fixture-key");
const DISPATCH_EPOCH: WorkflowEpochRef = FIXTURE_KEY.epochRef;
const DISPATCH_BINDING_DIGEST = "dispatch-binding";
const DISPATCH_STATE_DIGEST = "dispatch-state";
const FIXTURE_WORKSPACE_ROOT = "/workspace";
const FIXTURE_WORKSPACE_IDENTITY = "fixture-workspace";
const HOST_PRINCIPAL_AUTHORIZER = FIXTURE_RECEIPT_CONTEXT.principalAuthorizer;

function hostReceipt(
	capability: WorkflowHostReceiptCapability,
	payloadDigest: string,
	operationDigest: string,
): WorkflowVerifiedHostReceipt {
	const receiptId = `${capability}:${payloadDigest}`;
	return createFixtureHostReceipt({
		receiptKind: "capability",
		receiptId,
		issuerId: FIXTURE_KEY.ownerPrincipal,
		workflowId: "workflow-dispatch",
		bindingDigest: DISPATCH_BINDING_DIGEST,
		payloadDigest,
		artifactRef: {
			artifactId: receiptId,
			relativePath: `dispatch/${receiptId}`,
			digest: "placeholder",
			sizeBytes: 0,
			sourceEventSequence: 1,
		},
		issuedAt: "2025-12-31T00:00:00.000Z",
		validUntil: "2026-01-02T00:00:00.000Z",
		keyId: "fixture-key",
		stateDigest: DISPATCH_STATE_DIGEST,
		revision: 1,
		capabilityBinding: {
			capability,
			resourceDigest: payloadDigest,
			operationDigest,
			executionIdentity: null,
			sessionId: null,
		},
	});
}

function hostAuthorization(
	capacityDigest: string,
	pathProofDigest: string,
	operationDigest: string,
	pathRelationProof: WorkConflictPathProofContext,
): WorkConflictHostAuthorization {
	return {
		principalAuthorizer: HOST_PRINCIPAL_AUTHORIZER,
		capacityReceipt: hostReceipt("workflow_dispatch_capacity_attestation", capacityDigest, operationDigest),
		pathProofReceipt: hostReceipt("workflow_dispatch_path_attestation", pathProofDigest, operationDigest),
		pathRelationProof,
		workflowId: "workflow-dispatch",
		bindingDigest: DISPATCH_BINDING_DIGEST,
		stateDigest: DISPATCH_STATE_DIGEST,
		revision: 1,
		epochRef: DISPATCH_EPOCH,
		operationDigest,
	};
}

function resource(overrides: Partial<WorkConflictResourceVector> = {}): WorkConflictResourceRequest {
	return {
		resources: { ...ZERO_RESOURCE, ...overrides },
		acceleratorPools: [],
		providerPools: [],
		controlCapacity: { ...ZERO_CONTROL },
	};
}

function task(taskId: string, overrides: Partial<WorkConflictTask> = {}): WorkConflictTask {
	return {
		taskId,
		dependencies: [],
		readArtifacts: [],
		writeArtifacts: [],
		readPaths: [`src/${taskId}.ts`],
		writePaths: [],
		role: "ops_monitor",
		resourceRequest: resource({ cpuMilliCores: 1 }),
		usefulness: 1,
		workKey: `work:${taskId}`,
		...overrides,
	};
}

function capacity(
	overrides: Partial<WorkConflictResourceVector> = {},
	protectedResourceReserve: Partial<WorkConflictResourceVector> = {},
): WorkConflictAuthenticatedCapacity {
	const value = {
		schemaId: "work-conflict-capacity-v1" as const,
		resources: { ...ZERO_RESOURCE, ...overrides },
		acceleratorPools: [],
		providerPools: [],
		controlCapacity: { ...ZERO_CONTROL },
		protectedResourceReserve: { ...ZERO_RESOURCE, ...protectedResourceReserve },
		protectedControlReserve: { ...ZERO_CONTROL },
	};
	const snapshotDigest = digestObject(value);
	return {
		...value,
		snapshotDigest,
	};
}

function capacityWithPools(
	acceleratorPools: readonly WorkConflictAcceleratorPool[],
	providerPools: readonly WorkConflictProviderPool[],
	controlCapacity: WorkConflictControlVector,
	protectedControlReserve: WorkConflictControlVector,
): WorkConflictAuthenticatedCapacity {
	const value = {
		schemaId: "work-conflict-capacity-v1" as const,
		resources: { ...ZERO_RESOURCE, cpuMilliCores: 8 },
		acceleratorPools,
		providerPools,
		controlCapacity,
		protectedResourceReserve: { ...ZERO_RESOURCE },
		protectedControlReserve,
	};
	const snapshotDigest = digestObject(value);
	return {
		...value,
		snapshotDigest,
	};
}

function pathProofContext(
	tasks: readonly WorkConflictTask[],
	protectedScopes: readonly WorkConflictProtectedScope[],
): WorkConflictPathProofContext {
	const paths = new Set<string>();
	for (const taskDeclaration of tasks) {
		for (const path of [...taskDeclaration.readPaths, ...taskDeclaration.writePaths]) paths.add(path);
	}
	for (const scope of protectedScopes) for (const path of scope?.paths ?? []) paths.add(path);
	const proofs = [...paths].sort().map((declaredPath) => {
		const realPath = `${FIXTURE_WORKSPACE_ROOT}/${declaredPath}`;
		const proof = {
			declaredPath,
			workspaceRelativePath: declaredPath,
			canonicalPath: realPath,
			realPath,
			caseFoldedRealPath: realPath.toLowerCase(),
			symlinkResolved: true as const,
			caseResolved: true as const,
		};
		return { ...proof, proofDigest: digestObject(proof) };
	});
	return {
		workspaceRoot: FIXTURE_WORKSPACE_ROOT,
		workspaceIdentity: FIXTURE_WORKSPACE_IDENTITY,
		proofDigest: digestObject({
			workspaceRoot: FIXTURE_WORKSPACE_ROOT,
			workspaceIdentity: FIXTURE_WORKSPACE_IDENTITY,
			proofs,
		}),
		proofs,
	};
}

function input(
	tasks: readonly WorkConflictTask[],
	overrides: Partial<WorkConflictGraphInput> = {},
): WorkConflictGraphInput {
	const protectedScopes = overrides.protectedScopes ?? [];
	const activeTasks = overrides.activeTasks ?? [];
	const completedTaskIds = overrides.completedTaskIds ?? [];
	const authoritativeTaskIds =
		overrides.authoritativeTaskIds ?? [...tasks, ...activeTasks].map(({ taskId }) => taskId);
	const authenticatedCapacity = overrides.authenticatedCapacity ?? capacity({ cpuMilliCores: 8 });
	const proofContext = overrides.pathProofContext ?? pathProofContext([...tasks, ...activeTasks], protectedScopes);
	let operationDigest = overrides.hostAuthorization?.operationDigest;
	if (operationDigest === undefined) {
		try {
			operationDigest = computeWorkConflictOperationDigest({
				tasks,
				activeTasks,
				completedTaskIds,
				authoritativeTaskIds,
				protectedScopes,
				authenticatedCapacity,
				pathProofContext: proofContext,
			});
		} catch {
			// Invalid declarations still need to reach the planner's rejection boundary.
			operationDigest = "invalid-operation-digest";
		}
	}
	return {
		tasks,
		activeTasks,
		completedTaskIds,
		authoritativeTaskIds,
		protectedScopes,
		authenticatedCapacity,
		pathProofContext: proofContext,
		hostAuthorization: hostAuthorization(
			authenticatedCapacity.snapshotDigest,
			proofContext.proofDigest,
			operationDigest,
			proofContext,
		),
		...overrides,
	};
}

describe("workflow work conflict graph", () => {
	it("admits independent reads while serializing write/write and read/write overlap", async () => {
		const result = await planUsefulParallelDispatch(
			input([
				task("writer", { role: "writer", usefulness: 3, writePaths: ["src/shared.ts"] }),
				task("reader", { role: "test_oracle", usefulness: 2, readPaths: ["src/shared.ts"] }),
				task("independent-read", { role: "ops_monitor", usefulness: 1, readPaths: ["src/other.ts"] }),
			]),
		);

		expect(result.selectedTaskIds).toEqual(["independent-read", "writer"]);
		expect(result.blockedTasks).toEqual([{ taskId: "reader", reasons: ["conflict"], conflictsWith: ["writer"] }]);
		expect(result.graph.edges).toEqual([{ leftTaskId: "reader", rightTaskId: "writer", reasons: ["read_write"] }]);
	});

	it("gates unsatisfied dependencies and writes into protected scopes", async () => {
		const result = await planUsefulParallelDispatch(
			input(
				[
					task("waiting", { dependencies: ["upstream"] }),
					task("protected-writer", { role: "writer", writePaths: ["tests/holdout/cases.ts"] }),
					task("free", { readPaths: ["src/free.ts"] }),
				],
				{
					protectedScopes: [{ scopeId: "holdout", paths: ["tests/holdout"] }],
				},
			),
		);

		expect(result.selectedTaskIds).toEqual(["free"]);
		expect(result.blockedTasks).toEqual([
			{ taskId: "protected-writer", reasons: ["protected_scope"], conflictsWith: [] },
			{ taskId: "waiting", reasons: ["dependency_wait"], conflictsWith: [] },
		]);
	});

	it("is stable under task reordering and emits a bounded graph", async () => {
		const tasks = [
			task("z", { usefulness: 2, readPaths: ["src/z.ts"] }),
			task("a", { usefulness: 2, readPaths: ["src/a.ts"] }),
			task("m", { usefulness: 2, readPaths: ["src/m.ts"] }),
		];
		const first = await planUsefulParallelDispatch(input(tasks));
		const second = await planUsefulParallelDispatch(input([...tasks].reverse()));

		expect(first).toEqual(second);
		expect(first.graph.nodes.map(({ taskId }) => taskId)).toEqual(["a", "m", "z"]);
		expect(first.graph.edges).toHaveLength(0);
		expect(first.graph.nodes.length).toBeLessThanOrEqual(tasks.length);
	});

	it("rejects wildcard and unscoped writes before producing a dispatch plan", async () => {
		await expect(
			planUsefulParallelDispatch(input([task("wildcard", { role: "writer", writePaths: ["src/**"] })])),
		).rejects.toThrow(/wildcard|scope/i);
		await expect(planUsefulParallelDispatch(input([task("unscoped", { role: "writer" })]))).rejects.toThrow(
			/unscoped|write scope/i,
		);
	});

	it("blocks inflated resource declarations and reports residual authenticated capacity", async () => {
		const result = await planUsefulParallelDispatch(
			input(
				[
					task("inflated", { usefulness: 10, resourceRequest: resource({ cpuMilliCores: 99 }) }),
					task("small", { usefulness: 1, resourceRequest: resource({ cpuMilliCores: 1 }) }),
				],
				{
					authenticatedCapacity: capacity({ cpuMilliCores: 4 }),
				},
			),
		);

		expect(result.selectedTaskIds).toEqual(["small"]);
		expect(result.blockedTasks).toEqual([{ taskId: "inflated", reasons: ["resource_capacity"], conflictsWith: [] }]);
		expect(result.idleCapacity.resources.cpuMilliCores).toBe(3);
	});

	it("holds scalar capacity reserves for control and does not expose them as idle", async () => {
		const result = await planUsefulParallelDispatch(
			input([task("reserved", { resourceRequest: resource({ cpuMilliCores: 1 }) })], {
				authenticatedCapacity: capacity({ cpuMilliCores: 1 }, { cpuMilliCores: 1 }),
			}),
		);
		expect(result.selectedTaskIds).toEqual([]);
		expect(result.blockedTasks).toEqual([{ taskId: "reserved", reasons: ["resource_capacity"], conflictsWith: [] }]);
		expect(result.idleCapacity.resources.cpuMilliCores).toBe(0);
	});

	it("chooses useful work instead of maximizing raw worker count", async () => {
		const result = await planUsefulParallelDispatch(
			input(
				[
					task("valuable", { usefulness: 100, resourceRequest: resource({ cpuMilliCores: 2 }) }),
					task("cheap-a", { usefulness: 1, resourceRequest: resource({ cpuMilliCores: 1 }) }),
					task("cheap-b", { usefulness: 1, resourceRequest: resource({ cpuMilliCores: 1 }) }),
				],
				{
					authenticatedCapacity: capacity({ cpuMilliCores: 2 }),
				},
			),
		);

		expect(result.selectedTaskIds).toEqual(["valuable"]);
		expect(result.blockedTasks.map(({ taskId }) => taskId)).toEqual(["cheap-a", "cheap-b"]);
	});

	it("honors critical path, age, and fairness before raw usefulness", async () => {
		const critical = await planUsefulParallelDispatch(
			input([task("useful", { usefulness: 100 }), task("critical", { usefulness: 1, criticalPathLength: 1 })], {
				authenticatedCapacity: capacity({ cpuMilliCores: 1 }),
			}),
		);
		expect(critical.selectedTaskIds).toEqual(["critical"]);

		const aged = await planUsefulParallelDispatch(
			input([task("young", { usefulness: 100 }), task("aged", { usefulness: 1, age: 1 })], {
				authenticatedCapacity: capacity({ cpuMilliCores: 1 }),
			}),
		);
		expect(aged.selectedTaskIds).toEqual(["aged"]);

		const fair = await planUsefulParallelDispatch(
			input([task("unfair", { usefulness: 100 }), task("fair", { usefulness: 1, fairness: 1 })], {
				authenticatedCapacity: capacity({ cpuMilliCores: 1 }),
			}),
		);
		expect(fair.selectedTaskIds).toEqual(["fair"]);
	});

	it("accounts for accelerator, provider, and protected control capacity", async () => {
		const acceleratorPools = [{ poolId: "gpu", quantity: 1, memoryBytes: 8 }];
		const providerPools = [
			{
				poolId: "provider",
				concurrentRequests: 1,
				requestsPerMinute: 10,
				totalRequests: 10,
				inputTokens: 100,
				outputTokens: 100,
				idempotency: "host_reconciled" as const,
			},
		];
		const controlCapacity = { ...ZERO_CONTROL, modelCallSlots: 2 };
		const protectedControlReserve = { ...ZERO_CONTROL, modelCallSlots: 1 };
		const result = await planUsefulParallelDispatch(
			input(
				[
					task("gpu", {
						role: "writer",
						writePaths: ["src/gpu.ts"],
						usefulness: 2,
						resourceRequest: {
							...resource(),
							acceleratorPools: [{ poolId: "gpu", quantity: 1, memoryBytes: 8 }],
							providerPools: [{ ...providerPools[0], concurrentRequests: 1 }],
							controlCapacity: { ...ZERO_CONTROL, modelCallSlots: 1 },
						},
					}),
					task("control-only", {
						usefulness: 1,
						readPaths: ["src/control.ts"],
						resourceRequest: { ...resource(), controlCapacity: { ...ZERO_CONTROL, modelCallSlots: 1 } },
					}),
				],
				{
					authenticatedCapacity: capacityWithPools(
						acceleratorPools,
						providerPools,
						controlCapacity,
						protectedControlReserve,
					),
				},
			),
		);

		expect(result.selectedTaskIds).toEqual(["gpu"]);
		expect(result.blockedTasks).toEqual([
			{ taskId: "control-only", reasons: ["resource_capacity"], conflictsWith: [] },
		]);
		expect(result.idleCapacity.controlCapacity.modelCallSlots).toBe(0);
	});

	it("treats provider-native accounting as stronger than host reconciliation", async () => {
		const providerPool = {
			poolId: "provider",
			concurrentRequests: 2,
			requestsPerMinute: 20,
			totalRequests: 20,
			inputTokens: 200,
			outputTokens: 200,
			idempotency: "provider_native" as const,
		};
		const demand = (idempotency: "provider_native" | "host_reconciled"): WorkConflictResourceRequest => ({
			...resource(),
			providerPools: [
				{
					poolId: providerPool.poolId,
					concurrentRequests: 1,
					requestsPerMinute: 10,
					totalRequests: 10,
					inputTokens: 100,
					outputTokens: 100,
					idempotency,
				},
			],
		});
		const nativeCapacity = capacityWithPools([], [providerPool], { ...ZERO_CONTROL }, { ...ZERO_CONTROL });
		const mixed = await planUsefulParallelDispatch(
			input(
				[
					task("native", { resourceRequest: demand("provider_native") }),
					task("host", { resourceRequest: demand("host_reconciled") }),
				],
				{ authenticatedCapacity: nativeCapacity },
			),
		);
		expect(mixed.selectedTaskIds).toEqual(["host", "native"]);

		const hostCapacity = capacityWithPools(
			[],
			[{ ...providerPool, idempotency: "host_reconciled" }],
			{ ...ZERO_CONTROL },
			{ ...ZERO_CONTROL },
		);
		const unsupported = await planUsefulParallelDispatch(
			input([task("native", { resourceRequest: demand("provider_native") })], {
				authenticatedCapacity: hostCapacity,
			}),
		);
		expect(unsupported.blockedTasks).toEqual([
			{ taskId: "native", reasons: ["resource_capacity"], conflictsWith: [] },
		]);
	});

	it("rejects extra resource fields under the closed request schema", async () => {
		await expect(
			planUsefulParallelDispatch(
				input([
					task("bad-schema", {
						resourceRequest: { ...resource(), extraCores: 1 } as unknown as WorkConflictTask["resourceRequest"],
					}),
				]),
			),
		).rejects.toThrow(/closed.schema|resource request/i);
		const hiddenResource = resource();
		Object.defineProperty(hiddenResource, "hiddenCores", { value: 1, enumerable: false });
		await expect(
			planUsefulParallelDispatch(input([task("hidden-schema", { resourceRequest: hiddenResource })])),
		).rejects.toThrow(/closed.schema|resource request/i);
	});

	it("rejects zero-resource, empty-scope, and caller progress no-ops", async () => {
		await expect(
			planUsefulParallelDispatch(input([task("zero", { resourceRequest: resource({ cpuMilliCores: 0 }) })])),
		).rejects.toThrow(/zero.resources|no.op/i);
		await expect(planUsefulParallelDispatch(input([task("empty", { readPaths: [] })]))).rejects.toThrow(
			/empty.scope|no.op/i,
		);
		await expect(planUsefulParallelDispatch(input([task("claimed", { progress: 0.5 })]))).rejects.toThrow(
			/progress|claim/i,
		);
	});

	it("does not let a disguised writer bypass the read-only role contract", async () => {
		await expect(
			planUsefulParallelDispatch(
				input([
					task("implementation", { role: "writer", usefulness: 2, writePaths: ["src/result.ts"] }),
					task("oracle", { role: "test_oracle", usefulness: 1, writePaths: ["src/result.ts"] }),
				]),
			),
		).rejects.toThrow(/read.only|write.capable|role/i);
	});

	it("deduplicates review work even when its read sets are disjoint", async () => {
		const result = await planUsefulParallelDispatch(
			input([
				task("oracle-review", {
					role: "test_oracle",
					usefulness: 3,
					workKey: "review:baseline",
					lensKey: "baseline",
					readPaths: ["src/a.ts"],
				}),
				task("red-review", {
					role: "red_team",
					usefulness: 2,
					workKey: "review:baseline",
					lensKey: "baseline",
					readPaths: ["src/b.ts"],
				}),
				task("ops", { role: "ops_monitor", usefulness: 1, workKey: "review:ops", readPaths: ["src/c.ts"] }),
			]),
		);

		expect(result.selectedTaskIds).toEqual(["ops", "oracle-review", "red-review"]);
		expect(result.blockedTasks).toEqual([]);
	});

	it("requires an authenticated capacity snapshot", async () => {
		await expect(
			planUsefulParallelDispatch(
				input([task("work")], {
					authenticatedCapacity: { ...capacity({ cpuMilliCores: 8 }), snapshotDigest: "forged" },
				}),
			),
		).rejects.toThrow(/authenticated capacity|digest|attestation/i);
	});

	it("requires host-proven canonical real paths with symlink and case proof", async () => {
		const result = await planUsefulParallelDispatch(
			input([
				task("upper", { role: "writer", writePaths: ["src/Result.ts"], usefulness: 1 }),
				task("lower", { role: "test_oracle", readPaths: ["src/result.ts"], usefulness: 2 }),
			]),
		);

		expect(result.selectedTaskIds).toEqual(["lower"]);
	});

	it("rejects a real-path proof that escapes the authenticated workspace root", async () => {
		const declaredPath = "etc/passwd";
		const proof = {
			declaredPath,
			workspaceRelativePath: declaredPath,
			canonicalPath: "/etc/passwd",
			realPath: "/etc/passwd",
			caseFoldedRealPath: "/etc/passwd",
			symlinkResolved: true as const,
			caseResolved: true as const,
		};
		const pathProofContext = {
			workspaceRoot: FIXTURE_WORKSPACE_ROOT,
			workspaceIdentity: FIXTURE_WORKSPACE_IDENTITY,
			proofDigest: digestObject({
				workspaceRoot: FIXTURE_WORKSPACE_ROOT,
				workspaceIdentity: FIXTURE_WORKSPACE_IDENTITY,
				proofs: [{ ...proof, proofDigest: digestObject(proof) }],
			}),
			proofs: [{ ...proof, proofDigest: digestObject(proof) }],
		};
		await expect(
			planUsefulParallelDispatch(input([task("escape", { readPaths: [declaredPath] })], { pathProofContext })),
		).rejects.toThrow(/workspace|contain|root|path/i);
	});

	it("passes the full path relation proof to the host authorizer", async () => {
		const base = input([task("relation-aware")]);
		const relationAwareAuthorizer: WorkflowHostPrincipalCapabilityAuthorizer = {
			async authorize(request) {
				const relationProof = (request as unknown as { pathRelationProof?: unknown }).pathRelationProof;
				if (relationProof === undefined) throw new Error("missing path relation proof");
				return HOST_PRINCIPAL_AUTHORIZER.authorize(request);
			},
		};
		await expect(
			planUsefulParallelDispatch({
				...base,
				hostAuthorization: { ...base.hostAuthorization, principalAuthorizer: relationAwareAuthorizer },
			}),
		).resolves.toMatchObject({ selectedTaskIds: ["relation-aware"] });
	});

	it("rejects active oversubscription instead of clamping residual capacity", async () => {
		await expect(
			planUsefulParallelDispatch(
				input([task("ready")], {
					activeTasks: [task("running", { resourceRequest: resource({ cpuMilliCores: 99 }) })],
					authenticatedCapacity: capacity({ cpuMilliCores: 4 }),
				}),
			),
		).rejects.toThrow(/oversubscription/i);
	});

	it("requires a digest-bound host capability receipt for capacity", async () => {
		await expect(
			planUsefulParallelDispatch({
				...input([task("work")]),
				authenticatedCapacity: { ...capacity({ cpuMilliCores: 8 }), snapshotDigest: "forged-boolean-proof" },
			}),
		).rejects.toThrow(/digest|attestation/i);
	});

	it("rejects reconciled-set contradictions instead of treating a ready dependency as completed", async () => {
		await expect(
			planUsefulParallelDispatch(
				input([task("dependent", { dependencies: ["upstream"] }), task("upstream")], {
					completedTaskIds: ["upstream"],
				}),
			),
		).rejects.toThrow(/reconcil|completed|dependency/i);
	});

	it("rejects completed IDs absent from the authoritative task graph", async () => {
		await expect(planUsefulParallelDispatch(input([task("work")], { completedTaskIds: ["ghost"] }))).rejects.toThrow(
			/authoritative|completed|graph/i,
		);
	});

	it("rejects a host receipt replayed for a graph with forged completion state", async () => {
		const base = input([task("dependent", { dependencies: ["upstream"] })], {
			authoritativeTaskIds: ["dependent", "upstream"],
		});
		await expect(
			planUsefulParallelDispatch({
				...base,
				completedTaskIds: ["upstream"],
				// Reusing the receipt proves it is not authorized for this altered graph state.
				hostAuthorization: base.hostAuthorization,
			}),
		).rejects.toThrow(/operation digest|canonical|graph/i);
	});

	it("binds receipts to canonical task identity, lens, role, scope, dependency, and resources", async () => {
		const baseTask = task("work", { lensKey: "baseline" });
		const base = input([baseTask]);
		const variants: readonly WorkConflictGraphInput[] = [
			{
				...base,
				tasks: [{ ...baseTask, taskId: "renamed" }],
				authoritativeTaskIds: ["renamed"],
				hostAuthorization: base.hostAuthorization,
			},
			{
				...base,
				tasks: [{ ...baseTask, lensKey: "alternate" }],
				hostAuthorization: base.hostAuthorization,
			},
			{
				...base,
				tasks: [{ ...baseTask, role: "test_oracle" }],
				hostAuthorization: base.hostAuthorization,
			},
			{
				...base,
				tasks: [{ ...baseTask, resourceRequest: resource({ cpuMilliCores: 2 }) }],
				hostAuthorization: base.hostAuthorization,
			},
			{
				...base,
				protectedScopes: [{ scopeId: "protected", paths: ["src/work.ts"] }],
				hostAuthorization: base.hostAuthorization,
			},
			{
				...base,
				tasks: [{ ...baseTask, dependencies: ["done"] }],
				completedTaskIds: ["done"],
				authoritativeTaskIds: ["done", "work"],
				hostAuthorization: base.hostAuthorization,
			},
		];
		for (const variant of variants)
			await expect(planUsefulParallelDispatch(variant)).rejects.toThrow(/operation digest|canonical|graph/i);
	});

	it("rejects duplicate protected scope IDs independent of declaration order", async () => {
		const scopes = [
			{ scopeId: "holdout", paths: ["tests/holdout/a.ts"] },
			{ scopeId: "holdout", paths: ["tests/holdout/b.ts"] },
		];
		for (const protectedScopes of [scopes, [...scopes].reverse()]) {
			await expect(planUsefulParallelDispatch(input([task("work")], { protectedScopes }))).rejects.toThrow(
				/duplicate|scope/i,
			);
		}
	});

	it("rejects writes declared by read-only review roles", async () => {
		await expect(
			planUsefulParallelDispatch(input([task("oracle", { role: "test_oracle", writePaths: ["src/result.ts"] })])),
		).rejects.toThrow(/read.only|write.capable|role/i);
	});

	it("rejects every common glob syntax in declared paths", async () => {
		for (const globPath of ["src/[a].ts", "src/{a,b}.ts", "src/(a|b).ts", "src/!important.ts"]) {
			await expect(
				planUsefulParallelDispatch(input([task("glob", { role: "writer", writePaths: [globPath] })])),
			).rejects.toThrow(/glob|wildcard|scope/i);
		}
	});

	it("suppresses duplicate work only for the same review role and lens", async () => {
		const result = await planUsefulParallelDispatch({
			...input([
				task("oracle-one", { role: "test_oracle", workKey: "review", lensKey: "lens-a", readPaths: ["src/a.ts"] }),
				task("oracle-two", { role: "test_oracle", workKey: "review", lensKey: "lens-a", readPaths: ["src/b.ts"] }),
				task("red-team", { role: "red_team", workKey: "review", lensKey: "lens-a", readPaths: ["src/c.ts"] }),
			]),
		});

		expect(result.selectedTaskIds).toEqual(["oracle-one", "red-team"]);
		expect(result.blockedTasks).toEqual([
			{ taskId: "oracle-two", reasons: ["duplicate_work"], conflictsWith: ["oracle-one"] },
		]);
	});

	it("packs the maximum useful combination with bounded exact selection", async () => {
		const result = await planUsefulParallelDispatch(
			input(
				[
					task("large", { usefulness: 10, resourceRequest: resource({ cpuMilliCores: 3 }) }),
					task("small-a", { usefulness: 6, resourceRequest: resource({ cpuMilliCores: 2 }) }),
					task("small-b", { usefulness: 6, resourceRequest: resource({ cpuMilliCores: 2 }) }),
				],
				{
					authenticatedCapacity: capacity({ cpuMilliCores: 4 }),
				},
			),
		);

		expect(result.selectedTaskIds).toEqual(["small-a", "small-b"]);
	});

	it("bounds the exact-packing branch budget at the threshold", async () => {
		const tasks = Array.from({ length: 24 }, (_, index) => task(`threshold-${index.toString().padStart(2, "0")}`));
		const result = await planUsefulParallelDispatch(
			input(tasks, { authenticatedCapacity: capacity({ cpuMilliCores: 12 }) }),
		);
		expect(result.selectedTaskIds).toHaveLength(12);
	});

	it("returns a bounded deterministic plan beyond the exact-packing threshold", async () => {
		const tasks = Array.from({ length: 25 }, (_, index) => task(`candidate-${index.toString().padStart(2, "0")}`));
		const first = await planUsefulParallelDispatch(
			input(tasks, { authenticatedCapacity: capacity({ cpuMilliCores: 25 }) }),
		);
		const second = await planUsefulParallelDispatch(
			input([...tasks].reverse(), { authenticatedCapacity: capacity({ cpuMilliCores: 25 }) }),
		);
		expect(first).toEqual(second);
		expect(first.selectedTaskIds).toHaveLength(25);
	});

	it("documents approximation when scalar dynamic programming cannot prove the packing", async () => {
		const tasks = Array.from({ length: 25 }, (_, index) =>
			task(`multi-${index.toString().padStart(2, "0")}`, {
				resourceRequest: resource({ cpuMilliCores: 1, memoryBytes: 1 }),
			}),
		);
		const result = await planUsefulParallelDispatch(
			input(tasks, { authenticatedCapacity: capacity({ cpuMilliCores: 25, memoryBytes: 25 }) }),
		);
		expect(result.packingCertificate.status).toBe("bounded_approximation");
		expect(result.packingCertificate.method).toBe("beam_search");
		expect(result.packingCertificate.upperBound).not.toBeNull();
	});

	it("does not trade a higher-scoring fitting task for a lower-scoring one past the threshold", async () => {
		const tasks = [
			...Array.from({ length: 200 }, (_, index) =>
				task(`distractor-${index.toString().padStart(2, "0")}`, { usefulness: 1 }),
			),
			task("score-10", { usefulness: 10 }),
			task("score-12", { usefulness: 12 }),
		];
		const result = await planUsefulParallelDispatch(
			input([...tasks].reverse(), { authenticatedCapacity: capacity({ cpuMilliCores: 1 }) }),
		);
		expect(result.selectedTaskIds).toEqual(["score-12"]);
	});

	it("finds the higher feasible scalar-resource packing past the threshold", async () => {
		const expensive = Array.from({ length: 10 }, (_, index) =>
			task(`expensive-${index.toString().padStart(2, "0")}`, {
				usefulness: 10,
				resourceRequest: resource({ cpuMilliCores: 2 }),
			}),
		);
		const cheap = Array.from({ length: 15 }, (_, index) =>
			task(`cheap-${index.toString().padStart(2, "0")}`, {
				usefulness: 9,
				resourceRequest: resource({ cpuMilliCores: 1 }),
			}),
		);
		const result = await planUsefulParallelDispatch(
			input([...expensive, ...cheap], { authenticatedCapacity: capacity({ cpuMilliCores: 10 }) }),
		);
		expect(result.selectedTaskIds).toHaveLength(10);
		expect(result.selectedTaskIds.every((taskId) => taskId.startsWith("cheap-"))).toBe(true);
	});

	it("keeps canonical tie ordering in the bounded heuristic", async () => {
		const tasks = Array.from({ length: 25 }, (_, index) => task(`candidate-${index.toString().padStart(2, "0")}`));
		const result = await planUsefulParallelDispatch(
			input([...tasks].reverse(), { authenticatedCapacity: capacity({ cpuMilliCores: 1 }) }),
		);
		expect(result.selectedTaskIds).toEqual(["candidate-00"]);
	});

	it("bounds active plus ready declarations together", async () => {
		const activeTasks = Array.from({ length: 2048 }, (_, index) =>
			task(`active-${index}`, { resourceRequest: resource({ cpuMilliCores: 1 }) }),
		);
		await expect(planUsefulParallelDispatch(input([task("ready")], { activeTasks }))).rejects.toThrow(
			/bounded|too many/i,
		);
	});

	it("requires an asynchronously verified central host principal boundary", () => {
		expect(planUsefulParallelDispatch(input([task("host-bound")] as readonly WorkConflictTask[]))).toBeInstanceOf(
			Promise,
		);
	});

	it("fails closed with CONTRACT_CHANGE when the central seam is absent", async () => {
		const base = input([task("missing-host-seam")]);
		await expect(
			planUsefulParallelDispatch({
				...base,
				hostAuthorization: {
					...base.hostAuthorization,
					principalAuthorizer: undefined as unknown as WorkflowHostPrincipalCapabilityAuthorizer,
				},
			}),
		).rejects.toThrow(/CONTRACT_CHANGE|principalAuthorizer/i);
	});

	it("freezes caller-supplied host evidence before async authorization", async () => {
		const base = input([task("immutable-host")]);
		const mutableCapacityReceipt = { ...base.hostAuthorization.capacityReceipt };
		const mutableAuthorization = {
			...base.hostAuthorization,
			capacityReceipt: mutableCapacityReceipt,
		};
		const pending = planUsefulParallelDispatch({ ...base, hostAuthorization: mutableAuthorization });
		mutableCapacityReceipt.payloadDigest = "forged-after-admission";
		await expect(pending).resolves.toMatchObject({ selectedTaskIds: ["immutable-host"] });
	});

	it("binds receipts, freshness, and cross-bound principal identity", async () => {
		const base = input([task("fresh")]);
		const staleReceipt = {
			...base.hostAuthorization.capacityReceipt,
			validUntil: "2025-12-31T00:00:00.000Z",
		};
		const staleAuthorizer: WorkflowHostPrincipalCapabilityAuthorizer = {
			async authorize(request) {
				if (request.receipt.validUntil < "2026-01-01T00:00:00.000Z") throw new Error("stale host receipt");
				return HOST_PRINCIPAL_AUTHORIZER.authorize(request);
			},
		};
		await expect(
			planUsefulParallelDispatch({
				...base,
				hostAuthorization: {
					...base.hostAuthorization,
					capacityReceipt: staleReceipt,
					principalAuthorizer: staleAuthorizer,
				},
			}),
		).rejects.toThrow(/stale|freshness/i);
		await expect(
			planUsefulParallelDispatch({
				...base,
				hostAuthorization: {
					...base.hostAuthorization,
					capacityReceipt: { ...base.hostAuthorization.capacityReceipt, signature: "forged-signature" },
				},
			}),
		).rejects.toThrow(/authorization|signature|cryptograph/i);

		const crossBoundAuthorizer: WorkflowHostPrincipalCapabilityAuthorizer = {
			async authorize(request) {
				const decision = await HOST_PRINCIPAL_AUTHORIZER.authorize(request);
				return request.capability === "workflow_dispatch_path_attestation"
					? { ...decision, authenticatedPrincipal: "other-host" }
					: decision;
			},
		};
		await expect(
			planUsefulParallelDispatch({
				...base,
				hostAuthorization: { ...base.hostAuthorization, principalAuthorizer: crossBoundAuthorizer },
			}),
		).rejects.toThrow(/cross-bound|identity|principal/i);
	});
});
