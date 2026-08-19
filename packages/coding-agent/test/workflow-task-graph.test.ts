import { describe, expect, it } from "vitest";
import {
	digestObject,
	type WorkflowAcceleratorResource,
	type WorkflowControlCapacityVector,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowProviderResource,
	type WorkflowResourceEnvelope,
	type WorkflowResourceVector,
} from "../src/core/workflow/contracts.js";
import {
	computeReadyTaskIds,
	computeTaskReadiness,
	parseWorkflowCanonicalPath,
	transitionWorkflowTask,
	validateWorkflowTaskGraph,
	type WorkflowTask,
	type WorkflowTaskGraph,
	type WorkflowTaskGraphContext,
} from "../src/core/workflow/task-graph.js";
import { loadPersistedEpochFixture } from "./workflow-fixtures.js";

const baseResourceVector: WorkflowResourceVector = {
	cpuMilliCores: 1,
	memoryBytes: 1,
	diskBytes: 1,
	ioWeight: 1,
	accelerators: [],
	providers: [],
	networkEgressBytes: 0,
	wallMilliseconds: 1,
	monetaryMicrounits: 1,
};

const baseControlCapacity: WorkflowControlCapacityVector = {
	processSlots: 0,
	childSessionSlots: 0,
	modelCallSlots: 0,
	modelInputTokens: 0,
	modelOutputTokens: 0,
	verificationSlots: 0,
	redTeamSlots: 0,
	recoverySlots: 0,
};

function task(taskId: string, overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		taskId,
		planRevision: 1,
		objective: taskId,
		requirementIds: [],
		completionCriteria: [],
		dependencyTaskIds: [],
		ownedPaths: [`src/${taskId}.ts`],
		ownedContracts: [],
		requiredSkillSnapshotDigests: [],
		verificationCommandDigests: [],
		authority: ["read_workspace"],
		declaredResourceVector: { ...baseResourceVector },
		declaredControlCapacity: { ...baseControlCapacity },
		status: "ready",
		attemptIds: [],
		...overrides,
	};
}

function graphContext(overrides: Partial<WorkflowTaskGraphContext> = {}): WorkflowTaskGraphContext {
	return {
		knownSkillSnapshotDigests: ["skill:known"],
		allowedAuthority: ["read_workspace", "write_owned_paths"],
		workspacePaths: ["src"],
		generatedOutputPaths: ["artifacts/out"],
		namedContracts: ["contract:known"],
		...overrides,
	};
}

function workflowDecision(): WorkflowDecisionRef {
	return {
		decisionScope: { kind: "workflow", workflowId: "workflow-1", rootSessionId: "session-1" },
		decisionId: "decision-1",
		revision: 1,
		storeEpoch: 1,
		coordinatorEpoch: 1,
		decisionDigest: "decision-digest",
	};
}

function workerFreeEnvelope(overrides: Partial<WorkflowResourceEnvelope> = {}): WorkflowResourceEnvelope {
	const scalarResources: WorkflowResourceVector = {
		cpuMilliCores: 10,
		memoryBytes: 10,
		diskBytes: 10,
		ioWeight: 10,
		accelerators: [],
		providers: [],
		networkEgressBytes: 10,
		wallMilliseconds: 100,
		monetaryMicrounits: 10,
	};
	const reserve: WorkflowResourceVector = {
		cpuMilliCores: 1,
		memoryBytes: 1,
		diskBytes: 1,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 1,
		wallMilliseconds: 1,
		monetaryMicrounits: 1,
	};
	const capacity: WorkflowControlCapacityVector = {
		processSlots: 2,
		childSessionSlots: 2,
		modelCallSlots: 2,
		modelInputTokens: 2,
		modelOutputTokens: 2,
		verificationSlots: 2,
		redTeamSlots: 2,
		recoverySlots: 2,
	};
	const ref = {
		artifactId: "ledger-1",
		relativePath: "ledgers/workflow-1/1",
		digest: "ledger-digest",
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
	return {
		envelopeId: "envelope-1",
		resources: scalarResources,
		controlPlaneReserve: reserve,
		controlPlaneReserveCapacity: { ...capacity },
		controlCapacity: { ...capacity },
		workerCapacity: { ...capacity },
		processSlots: 1,
		childSessionSlots: 1,
		candidateSlots: 0,
		executionCeilings: {
			maxWorkflowWallMilliseconds: 100,
			maxWorkflowTokens: 100,
			maxModelCalls: 2,
			maxTaskAttempts: 2,
			maxPlannerCycles: 2,
			maxDistinctStrategiesPerRequirement: 2,
			maxAnalysisAttemptsPerRequirement: 2,
			maxRecoveryAttemptsPerEffectClass: 2,
			renewalRequiresUserApproval: true,
		},
		providerQuotaSnapshotRef: ref,
		inventoryDigest: "inventory",
		pricingDigest: "pricing",
		terminationPolicyDigest: "termination",
		billingReconciliationPolicyDigest: "billing",
		egressPolicyDigest: "egress",
		validFrom: "2026-08-16T00:00:00.000Z",
		validUntil: "2026-08-16T00:01:00.000Z",
		capacityReceipt: null,
		approvalDecisionRef: workflowDecision(),
		canonicalLedgerRef: ref,
		canonicalLedgerDigest: "ledger-digest",
		envelopeDigest: "envelope-digest",
		...overrides,
	};
}

describe("workflow task graph", () => {
	it("accepts only canonical relative paths", () => {
		expect(parseWorkflowCanonicalPath("src/workflow/task.ts")).toEqual(["src", "workflow", "task.ts"]);
		for (const invalidPath of [
			"",
			"/src/task.ts",
			"src/",
			"src//task.ts",
			"src\\task.ts",
			"src/./task.ts",
			"src/../task.ts",
			"C:/task.ts",
			"src/\0task.ts",
		]) {
			expect(() => parseWorkflowCanonicalPath(invalidPath)).toThrow();
		}
	});

	it("rejects duplicate, missing, self, and cyclic dependencies", () => {
		expect(() => validateWorkflowTaskGraph([task("same"), task("same")], graphContext())).toThrow(/duplicate/i);
		expect(() =>
			validateWorkflowTaskGraph([task("missing", { dependencyTaskIds: ["unknown"] })], graphContext()),
		).toThrow(/missing/i);
		expect(() => validateWorkflowTaskGraph([task("self", { dependencyTaskIds: ["self"] })], graphContext())).toThrow(
			/self/i,
		);
		expect(() =>
			validateWorkflowTaskGraph(
				[task("a", { dependencyTaskIds: ["b"] }), task("b", { dependencyTaskIds: ["a"] })],
				graphContext(),
			),
		).toThrow(/cycle/i);
	});

	it("requires known skill snapshots and allowed authority", () => {
		expect(() =>
			validateWorkflowTaskGraph(
				[task("skill", { requiredSkillSnapshotDigests: ["skill:unknown"] })],
				graphContext(),
			),
		).toThrow(/skill snapshot/i);
		expect(() =>
			validateWorkflowTaskGraph([task("authority", { authority: ["invoke_host_effect"] })], graphContext()),
		).toThrow(/unauthorized/i);
	});

	it("requires owned paths inside the workspace and known named contracts", () => {
		expect(() =>
			validateWorkflowTaskGraph([task("outside", { ownedPaths: ["docs/task.md"] })], graphContext()),
		).toThrow(/outside the workspace/i);
		expect(() =>
			validateWorkflowTaskGraph([task("contract", { ownedContracts: ["contract:unknown"] })], graphContext()),
		).toThrow(/unknown contract/i);
	});

	it("requires owned paths to be descendants of a workspace root", () => {
		expect(() =>
			validateWorkflowTaskGraph(
				[task("ancestor", { ownedPaths: ["src"] })],
				graphContext({ workspacePaths: ["src/allowed/file.ts"] }),
			),
		).toThrow(/outside the workspace/i);
	});

	it("rejects hidden task members instead of dropping them from the graph digest", () => {
		const hiddenTask = task("hidden");
		Object.defineProperty(hiddenTask, "forgedAuthority", {
			value: "write_owned_paths",
			enumerable: false,
		});

		expect(() => validateWorkflowTaskGraph([hiddenTask], graphContext())).toThrow(/hidden|canonical|property/i);
	});

	it("rejects non-normalized workspace roots before binding task paths", () => {
		expect(() =>
			validateWorkflowTaskGraph([task("normalized")], graphContext({ workspacePaths: ["src/e\u0301"] })),
		).toThrow(/canonical|normalized|path/i);
	});

	it("rejects independent ancestor or contract ownership overlap", () => {
		expect(() =>
			validateWorkflowTaskGraph(
				[task("parent", { ownedPaths: ["src/shared"] }), task("child", { ownedPaths: ["src/shared/file.ts"] })],
				graphContext(),
			),
		).toThrow(/overlapping/i);
		expect(() =>
			validateWorkflowTaskGraph(
				[task("one", { ownedContracts: ["contract:known"] }), task("two", { ownedContracts: ["contract:known"] })],
				graphContext(),
			),
		).toThrow(/overlapping/i);
	});

	it("produces deterministic order, digest, and base path projections", () => {
		const context = graphContext({ generatedOutputPaths: ["artifacts/z", "artifacts/a", "artifacts/z"] });
		const first = validateWorkflowTaskGraph([task("b"), task("a")], context);
		const second = validateWorkflowTaskGraph([task("a"), task("b")], context);
		expect(first.tasks.map(({ taskId }) => taskId)).toEqual(["a", "b"]);
		expect(first.generatedOutputPaths).toEqual(["artifacts/a", "artifacts/z"]);
		expect(first.lockPaths).toEqual([]);
		expect(first.graphDigest).toBe(second.graphDigest);
		expect([...first.byId.keys()]).toEqual(["a", "b"]);
	});

	it("keeps graph digest and readiness order independent of locale", () => {
		const tasks = [task("ä"), task("z")];
		const first = validateWorkflowTaskGraph(tasks, graphContext());
		const second = validateWorkflowTaskGraph([...tasks].reverse(), graphContext());

		expect(first.tasks.map(({ taskId }) => taskId)).toEqual(["z", "ä"]);
		expect(computeTaskReadiness(first, [], workerFreeEnvelope()).map(({ taskId }) => taskId)).toEqual(["z", "ä"]);
		expect(computeReadyTaskIds(first, [], workerFreeEnvelope())).toEqual(["z", "ä"]);
		expect(first.graphDigest).toBe(second.graphDigest);
	});

	it("reports dependency, ownership, resource, and authority waits without dispatch", () => {
		const graph = validateWorkflowTaskGraph(
			[
				task("dependency", { dependencyTaskIds: ["accepted"] }),
				task("accepted", { status: "ready" }),
				task("ownership"),
				task("resource", { declaredResourceVector: { ...baseResourceVector, cpuMilliCores: 100 } }),
			],
			graphContext(),
		);
		const running = [task("running", { status: "running", ownedPaths: ["src/ownership.ts"] })];
		const readiness = computeTaskReadiness(graph, running, workerFreeEnvelope());
		expect(readiness.find(({ taskId }) => taskId === "dependency")?.waitReasons).toEqual(["dependency_wait"]);
		expect(readiness.find(({ taskId }) => taskId === "ownership")?.waitReasons).toEqual(["ownership_wait"]);
		expect(readiness.find(({ taskId }) => taskId === "resource")?.waitReasons).toEqual(["resource_wait"]);
		const authorityGraph: WorkflowTaskGraph = { ...graph, allowedAuthority: [] };
		expect(
			computeTaskReadiness(authorityGraph, [], workerFreeEnvelope()).find(({ taskId }) => taskId === "accepted")
				?.waitReasons,
		).toContain("authority_wait");
		expect(computeReadyTaskIds(graph, running, workerFreeEnvelope())).toEqual(["accepted"]);
	});

	it("subtracts accelerator and provider reserves before readiness", () => {
		const demandedAccelerator: WorkflowAcceleratorResource = {
			poolId: "gpu",
			deviceType: "A",
			count: 2,
			memoryBytes: 4,
		};
		const demandedProvider: WorkflowProviderResource = {
			poolId: "api",
			concurrentRequests: 2,
			requestsPerMinute: 2,
			totalRequests: 2,
			inputTokens: 2,
			outputTokens: 2,
			idempotency: "provider_native",
		};
		const baseEnvelope = workerFreeEnvelope();
		const envelope = workerFreeEnvelope({
			resources: {
				...baseEnvelope.resources,
				accelerators: [{ ...demandedAccelerator, count: 2, memoryBytes: 8 }],
				providers: [{ ...demandedProvider }],
			},
			controlPlaneReserve: {
				...baseEnvelope.controlPlaneReserve,
				accelerators: [{ ...demandedAccelerator, count: 1, memoryBytes: 4 }],
				providers: [
					{
						...demandedProvider,
						concurrentRequests: 1,
						requestsPerMinute: 1,
						totalRequests: 1,
						inputTokens: 1,
						outputTokens: 1,
					},
				],
			},
		});
		const graph = validateWorkflowTaskGraph(
			[
				task("reserved", {
					declaredResourceVector: {
						...baseResourceVector,
						accelerators: [demandedAccelerator],
						providers: [demandedProvider],
					},
				}),
			],
			graphContext(),
		);
		expect(computeTaskReadiness(graph, [], envelope)[0]?.waitReasons).toContain("resource_wait");
	});

	it("requires a provider idempotency capability at least as strong as the task demand", () => {
		const demand: WorkflowProviderResource = {
			poolId: "api",
			concurrentRequests: 1,
			requestsPerMinute: 1,
			totalRequests: 1,
			inputTokens: 1,
			outputTokens: 1,
			idempotency: "provider_native",
		};
		const graph = validateWorkflowTaskGraph(
			[
				task("provider", {
					declaredResourceVector: { ...baseResourceVector, providers: [demand] },
				}),
			],
			graphContext(),
		);
		const baseEnvelope = workerFreeEnvelope();
		const withoutNative = workerFreeEnvelope({
			resources: { ...baseEnvelope.resources, providers: [{ ...demand, idempotency: "none" }] },
		});
		expect(computeTaskReadiness(graph, [], withoutNative)[0]?.waitReasons).toContain("resource_wait");
		const hostReconciled = workerFreeEnvelope({
			resources: { ...baseEnvelope.resources, providers: [{ ...demand, idempotency: "host_reconciled" }] },
		});
		expect(computeTaskReadiness(graph, [], hostReconciled)[0]?.waitReasons).toContain("resource_wait");
		const native = workerFreeEnvelope({
			resources: { ...baseEnvelope.resources, providers: [{ ...demand, idempotency: "provider_native" }] },
		});
		expect(computeReadyTaskIds(graph, [], native)).toEqual(["provider"]);
	});

	it("deep-clones and freezes graph arrays, tasks, resources, pools, and projections", () => {
		const ownedPaths = ["src/immutable.ts"];
		const generatedOutputPaths = ["artifacts/out"];
		const accelerator: WorkflowAcceleratorResource = { poolId: "gpu", deviceType: "A", count: 1, memoryBytes: 4 };
		const provider: WorkflowProviderResource = {
			poolId: "api",
			concurrentRequests: 1,
			requestsPerMinute: 1,
			totalRequests: 1,
			inputTokens: 1,
			outputTokens: 1,
			idempotency: "provider_native",
		};
		const inputTask = task("immutable", {
			ownedPaths,
			declaredResourceVector: { ...baseResourceVector, accelerators: [accelerator], providers: [provider] },
		});
		const graph = validateWorkflowTaskGraph([inputTask], graphContext({ generatedOutputPaths }));
		const digest = graph.graphDigest;
		ownedPaths.push("src/drift.ts");
		generatedOutputPaths.push("artifacts/drift");
		accelerator.count = 99;
		provider.outputTokens = 99;
		expect(graph.tasks[0]?.ownedPaths).toEqual(["src/immutable.ts"]);
		expect(graph.generatedOutputPaths).toEqual(["artifacts/out"]);
		expect(graph.tasks[0]?.declaredResourceVector.accelerators[0]?.count).toBe(1);
		expect(graph.tasks[0]?.declaredResourceVector.providers[0]?.outputTokens).toBe(1);
		expect(graph.graphDigest).toBe(digest);
		expect(Object.isFrozen(graph.tasks)).toBe(true);
		expect(Object.isFrozen(graph.tasks[0])).toBe(true);
		expect(Object.isFrozen(graph.tasks[0]?.declaredResourceVector)).toBe(true);
		expect(Object.isFrozen(graph.tasks[0]?.declaredResourceVector.accelerators)).toBe(true);
		expect(Object.isFrozen(graph.tasks[0]?.declaredResourceVector.accelerators[0])).toBe(true);
		expect(Object.isFrozen(graph.tasks[0]?.declaredResourceVector.providers[0])).toBe(true);
	});

	it("rejects non-finite or negative task and envelope resource values before readiness", () => {
		expect(() =>
			validateWorkflowTaskGraph(
				[task("nan", { declaredResourceVector: { ...baseResourceVector, cpuMilliCores: Number.NaN } })],
				graphContext(),
			),
		).toThrow(/finite|non-negative/i);
		expect(() =>
			validateWorkflowTaskGraph(
				[task("negative", { declaredResourceVector: { ...baseResourceVector, memoryBytes: -1 } })],
				graphContext(),
			),
		).toThrow(/finite|non-negative/i);
		expect(() =>
			validateWorkflowTaskGraph(
				[
					task("pool", {
						declaredResourceVector: {
							...baseResourceVector,
							accelerators: [{ poolId: "gpu", deviceType: "A", count: -1, memoryBytes: 1 }],
						},
					}),
				],
				graphContext(),
			),
		).toThrow(/finite|non-negative/i);
		expect(() =>
			validateWorkflowTaskGraph(
				[
					task("control", {
						declaredControlCapacity: { ...baseControlCapacity, processSlots: Number.POSITIVE_INFINITY },
					}),
				],
				graphContext(),
			),
		).toThrow(/finite|non-negative/i);
		const graph = validateWorkflowTaskGraph([task("valid")], graphContext());
		const envelope = workerFreeEnvelope({
			resources: { ...workerFreeEnvelope().resources, cpuMilliCores: Number.NaN },
		});
		expect(() => computeTaskReadiness(graph, [], envelope)).toThrow(/finite|non-negative/i);
	});

	it("requires positive epoch shape while the reducer owns freshness CAS", () => {
		const graph = validateWorkflowTaskGraph([task("ready")], graphContext());
		const readyTask = graph.byId.get("ready");
		expect(readyTask).toBeDefined();
		const epoch = loadPersistedEpochFixture().acquired;
		expect(transitionWorkflowTask(readyTask!, "admitted", digestObject(readyTask!), epoch).status).toBe("admitted");
		expect(() => transitionWorkflowTask(readyTask!, "admitted", "stale", epoch)).toThrow(/stale/i);
		expect(() => transitionWorkflowTask(readyTask!, "pending", digestObject(readyTask!), epoch)).toThrow(
			/not allowed/i,
		);
		expect(() =>
			transitionWorkflowTask(readyTask!, "admitted", digestObject(readyTask!), {
				storeEpoch: 0,
				coordinatorEpoch: 1,
			}),
		).toThrow(/epoch/i);
		expect(() =>
			transitionWorkflowTask(readyTask!, "admitted", digestObject(readyTask!), {
				storeEpoch: 1,
				coordinatorEpoch: 0,
			}),
		).toThrow(/epoch/i);
		expect(() =>
			transitionWorkflowTask(readyTask!, "admitted", digestObject(readyTask!), {
				...epoch,
				unexpected: true,
			} as unknown as WorkflowEpochRef),
		).toThrow(/epoch/i);
		expect(() =>
			transitionWorkflowTask(readyTask!, "admitted", digestObject(readyTask!), {
				storeEpoch: -1,
				coordinatorEpoch: 1,
			}),
		).toThrow(/epoch/i);
	});

	it("requires attempt history for cancelled tasks", () => {
		expect(() => validateWorkflowTaskGraph([task("cancelled", { status: "cancelled" })], graphContext())).toThrow(
			/attempt history/i,
		);
	});
});
