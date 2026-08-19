import { expect, it } from "vitest";
import type {
	WorkflowEpochRef,
	WorkflowRuntimeStore,
	WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import { digestObject } from "../src/core/workflow/contracts.js";
import {
	createWorkerModelCapabilityGate,
	WORKER_MODEL_CAPABILITY,
	type WorkerModelCapabilityAuthorizationInput,
	type WorkerModelCapabilityGateOptions,
	type WorkerModelCapabilityHost,
	type WorkerModelCapabilityInspection,
	type WorkerModelCapabilityInspectionInput,
	type WorkerModelPolicyInput,
} from "../src/core/workflow/worker-model-capability-gate.js";

it("rejects an omitted worker model before host or durable preflight activity", async () => {
	let inspectCalls = 0;
	const gate = createWorkerModelCapabilityGate({
		runtimeStore: {} as unknown as WorkflowRuntimeStore,
		workflowId: "workflow-worker-model-red",
		runtimeVersion: "0.147.0-alpha.10",
		policy: {
			provider: "openai-codex",
			reasoning: "max",
			allowFallback: false,
			policyRevision: "policy-1",
		},
		host: {
			inspect: async () => {
				inspectCalls += 1;
				return Promise.reject(new Error("host inspection must not run"));
			},
			authorize: async () => Promise.reject(new Error("authorization must not run")),
		},
	});

	await expect(
		gate.preflight({
			stateDigest: "state-1",
			revision: 1,
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
		}),
	).rejects.toThrow(/model/i);
	expect(inspectCalls).toBe(0);
});

it("rejects a non-Luna worker selector before host inspection", async () => {
	const fixture = createFixture({ authenticated: false, safeReason: "catalog_unavailable" });
	const gate = createWorkerModelCapabilityGate({
		...fixture.options,
		policy: { ...fixture.options.policy, model: "gpt-5.6-sol" },
	});

	await expect(gate.preflight(fixture.context)).rejects.toThrow("worker_model_policy_selector_denied");
});

it("keeps unavailable Luna preflight read-only and never invokes a substitute worker", async () => {
	let authorizationCalls = 0;
	let inspectCalls = 0;
	const fixture = createFixture({ authenticated: false, safeReason: "Luna unavailable" });
	if (fixture.host.authorize === undefined) throw new Error("fixture authorizer missing");
	const gate = createWorkerModelCapabilityGate({
		...fixture.options,
		host: {
			inspect: async (input) => {
				inspectCalls += 1;
				return fixture.host.inspect(input);
			},
			authorize: async (input) => {
				authorizationCalls += 1;
				return fixture.host.authorize?.(input) ?? Promise.reject(new Error("fixture authorizer missing"));
			},
		},
	});

	const preflight = await gate.preflight(fixture.context);

	expect(preflight).toMatchObject({ status: "blocked", authenticated: false, safeReason: "Luna unavailable" });
	expect(preflight.receipt).toBeNull();
	expect(preflight.receiptDigest).toBeNull();
	expect(inspectCalls).toBe(1);
	expect(authorizationCalls).toBe(0);
	expect(fixture.readCalls).toBe(0);
	expect(fixture.writeCalls).toBe(0);
});

it("redacts credential-shaped inspection details before public projection", async () => {
	const fixture = createFixture({
		authenticated: false,
		safeReason: "catalog_unavailable token=sk-secret-value-123456789",
	});
	const gate = createWorkerModelCapabilityGate(fixture.options);
	const preflight = await gate.preflight(fixture.context);

	expect(preflight.safeReason).toBe("catalog_unavailable token=[redacted]");
	expect(preflight.safeReason).not.toContain("sk-secret-value");
});

it("reports a finite contract change when the sealed worker-model authorizer is absent", async () => {
	const fixture = createFixture({
		authenticated: true,
		safeReason: "available",
		receipt: fakeReceipt("luna-receipt-contract"),
	});
	const gate = createWorkerModelCapabilityGate({
		...fixture.options,
		host: { inspect: fixture.host.inspect },
	});

	const preflight = await gate.preflight(fixture.context);

	expect(preflight.status).toBe("contract_change");
	expect(preflight.safeReason).toMatch(/^CONTRACT_CHANGE:/u);
});

it("rejects a signed receipt carrying a different capability instead of aliasing it", async () => {
	const fixture = createFixture({
		authenticated: true,
		safeReason: "available",
		receipt: fakeReceipt("luna-receipt-wrong-capability"),
	});
	fixture.host.inspect = async (input) => ({
		authenticated: true,
		authRevision: fixture.authRevision,
		capabilityRevision: fixture.capabilityRevision,
		policyRevision: input.policy.policyRevision,
		safeReason: "available",
		receipt: {
			...fixture.availability.receipt,
			capabilityBinding: {
				...fixture.availability.receipt?.capabilityBinding,
				capability: "workflow_recursive_delegation_plan",
			},
		} as unknown as WorkflowVerifiedHostReceipt,
	});

	const gate = createWorkerModelCapabilityGate(fixture.options);
	const preflight = await gate.preflight(fixture.context);

	expect(preflight.status).toBe("contract_change");
	expect(preflight.safeReason).toMatch(/^CONTRACT_CHANGE:/u);
});

it("revalidates a stale preflight under the host lease and durably preserves the queued goal", async () => {
	const firstReceipt = fakeReceipt("luna-receipt-1");
	const secondReceipt = fakeReceipt("luna-receipt-2");
	const fixture = createFixture({ authenticated: true, safeReason: "available", receipt: firstReceipt });
	let inspectCount = 0;
	fixture.host.inspect = async (input) => {
		inspectCount += 1;
		return {
			authenticated: true,
			authRevision: "auth-1",
			capabilityRevision: "capability-1",
			policyRevision: input.policy.policyRevision,
			safeReason: "available",
			receipt: inspectCount === 1 ? firstReceipt : secondReceipt,
		};
	};
	const gate = createWorkerModelCapabilityGate(fixture.options);
	const preflight = await gate.preflight(fixture.context);
	const result = await gate.dispatch({
		...fixture.context,
		taskId: "task-stale",
		goalId: "goal-stale",
		enqueuedAt: "2026-08-17T17:00:00.000Z",
		preflight,
	});

	expect(result.status).toBe("blocked");
	if (result.status !== "blocked") throw new Error("expected a durable blocker");
	expect(result.blocker.safeReason).toBe("worker_model_preflight_stale");
	expect(result.queuedWork.taskId).toBe("task-stale");
	expect(result.blocker.projection.queueState).toBe("queued");
	expect(inspectCount).toBe(2);
	expect(fixture.authorizeCalls).toBe(0);
	const snapshot = await gate.readState();
	expect(snapshot.queuedWork).toHaveLength(1);
	expect(snapshot.blocker?.taskId).toBe("task-stale");
});

it("rejects a caller-mutated signed receipt before dispatch admission", async () => {
	const fixture = createFixture({
		authenticated: true,
		safeReason: "available",
		receipt: fakeReceipt("luna-receipt-forged-preflight"),
	});
	const gate = createWorkerModelCapabilityGate(fixture.options);
	const preflight = await gate.preflight(fixture.context);
	if (preflight.receipt === null) throw new Error("expected a signed receipt");
	const forged = structuredClone(preflight);
	(forged.receipt as { receiptId: string }).receiptId = "forged-receipt";

	await expect(
		gate.dispatch({
			...fixture.context,
			taskId: "task-forged-preflight",
			goalId: "goal-forged-preflight",
			enqueuedAt: "2026-08-17T17:00:00.000Z",
			preflight: forged,
		}),
	).rejects.toThrow(/receipt_digest_invalid/u);
	expect(fixture.authorizeCalls).toBe(0);
});

it("reconstructs a blocked queue after restart and grants one retry lease for a trusted revision", async () => {
	const fixture = createFixture({ authenticated: false, safeReason: "Luna unavailable" });
	const firstGate = createWorkerModelCapabilityGate(fixture.options);
	const firstPreflight = await firstGate.preflight(fixture.context);
	const blocked = await firstGate.dispatch({
		...fixture.context,
		taskId: "task-retry",
		goalId: "goal-retry",
		enqueuedAt: "2026-08-17T17:00:00.000Z",
		preflight: firstPreflight,
	});
	if (blocked.status !== "blocked") throw new Error("expected a durable blocker");

	fixture.availability = { authenticated: true, safeReason: "available", receipt: fakeReceipt("luna-receipt-3") };
	fixture.authRevision = "auth-2";
	fixture.capabilityRevision = "capability-2";
	const restartedGate = createWorkerModelCapabilityGate(fixture.options);
	const restarted = await restartedGate.readState();
	expect(restarted.queuedWork.map((work) => work.taskId)).toEqual(["task-retry"]);
	expect(restarted.blocker?.safeReason).toBe("Luna unavailable");
	const secondPreflight = await restartedGate.preflight(fixture.context);
	const retries = await Promise.all([
		restartedGate.retry({ ...fixture.context, blockerId: blocked.blocker.blockerDigest, preflight: secondPreflight }),
		restartedGate.retry({ ...fixture.context, blockerId: blocked.blocker.blockerDigest, preflight: secondPreflight }),
	]);

	expect(retries.map((retry) => retry.status).sort()).toEqual(["already_leased", "retry_leased"]);
	const lease = retries.find((retry) => retry.status === "retry_leased");
	expect(lease?.status).toBe("retry_leased");
	const admitted = await restartedGate.dispatch({
		...fixture.context,
		taskId: "task-retry",
		goalId: "goal-retry",
		enqueuedAt: "2026-08-17T17:00:00.000Z",
		preflight: secondPreflight,
	});
	expect(admitted.status).toBe("admitted");
	const afterAdmission = await restartedGate.readState();
	expect(afterAdmission.queuedWork).toHaveLength(0);
	expect(afterAdmission.blockers).toHaveLength(0);
});

it("accepts the exact Luna handshake and quarantines a live fallback artifact", async () => {
	const fixture = createFixture({
		authenticated: true,
		safeReason: "available",
		receipt: fakeReceipt("luna-receipt-handshake"),
	});
	const gate = createWorkerModelCapabilityGate(fixture.options);
	const preflight = await gate.preflight(fixture.context);
	const dispatch = await gate.dispatch({
		...fixture.context,
		taskId: "task-handshake",
		goalId: "goal-handshake",
		enqueuedAt: "2026-08-17T17:00:00.000Z",
		preflight,
	});
	if (dispatch.status !== "admitted") throw new Error("expected model admission");
	const accepted = await gate.handshake({ admission: dispatch.intent, actual: dispatch.intent.childModel });
	expect(accepted).toEqual({ status: "accepted", admissionDigest: dispatch.intent.admissionDigest });
	const quarantined = await gate.handshake({
		admission: dispatch.intent,
		actual: {
			...dispatch.intent.childModel,
			model: "openai-codex/gpt-5.6-sol",
			allowFallback: true,
			artifactDigests: ["a".repeat(64)],
		},
	});

	expect(quarantined.status).toBe("terminate_quarantine");
	if (quarantined.status !== "terminate_quarantine") throw new Error("expected quarantine");
	expect(quarantined.quarantine.reason).toBe("fallback_forbidden");
	expect(quarantined.quarantine.inadmissibleArtifactDigests).toEqual(["a".repeat(64)]);
	expect(fixture.quarantineCalls).toBe(1);
	const snapshot = await gate.readState();
	expect(snapshot.quarantines).toHaveLength(1);
});

interface MutableFixture {
	options: WorkerModelCapabilityGateOptions;
	context: { readonly stateDigest: string; readonly revision: number; readonly epochRef: WorkflowEpochRef };
	host: WorkerModelCapabilityHost;
	availability: { authenticated: boolean; safeReason: string; receipt: WorkflowVerifiedHostReceipt | null };
	authRevision: string;
	capabilityRevision: string;
	authorizeCalls: number;
	quarantineCalls: number;
	readCalls: number;
	writeCalls: number;
}

function createFixture(input: {
	authenticated: boolean;
	safeReason: string;
	receipt?: WorkflowVerifiedHostReceipt;
}): MutableFixture {
	const epochRef: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
	let stateBytes: Uint8Array | null = null;
	let leaseTail: Promise<unknown> = Promise.resolve();
	const fixture = {} as MutableFixture;
	fixture.context = { stateDigest: "state-1", revision: 1, epochRef };
	fixture.availability = {
		authenticated: input.authenticated,
		safeReason: input.safeReason,
		receipt: input.receipt ?? null,
	};
	fixture.authRevision = "auth-1";
	fixture.capabilityRevision = "capability-1";
	fixture.authorizeCalls = 0;
	fixture.quarantineCalls = 0;
	fixture.readCalls = 0;
	fixture.writeCalls = 0;
	const durable = {
		generationId: "generation-worker-model",
		epochRef,
		currentLeaseRef: () => ({
			leaseId: "lease-worker-model",
			workflowId: "workflow-worker-model-red",
			storeEpoch: 1,
			coordinatorEpoch: 1,
			writerIdentity: "writer-worker-model",
			rootDigest: "root-worker-model",
			processIdentity: "process-worker-model",
			acquiredAt: "2026-08-17T17:00:00.000Z",
			expiresAt: "2026-08-17T18:00:00.000Z",
			acquisitionEventSequence: 1,
		}),
		outbox: {} as never,
		auxiliaryStore: {
			read: async () => {
				fixture.readCalls += 1;
				return stateBytes;
			},
			write: async (_name: string, bytes: Readonly<Uint8Array>) => {
				fixture.writeCalls += 1;
				stateBytes = new Uint8Array(bytes);
			},
		},
		withExclusiveLease: async <T>(_: string, operation: () => Promise<T>): Promise<T> => {
			const prior = leaseTail;
			let resolveTail: (() => void) | undefined;
			leaseTail = new Promise<void>((resolve) => {
				resolveTail = resolve;
			});
			await prior;
			try {
				return await operation();
			} finally {
				resolveTail?.();
			}
		},
		recoverJournal: async () => ({ status: "healthy", reason: null }),
	};
	fixture.host = {
		inspect: async (input: WorkerModelCapabilityInspectionInput): Promise<WorkerModelCapabilityInspection> => ({
			authenticated: fixture.availability.authenticated,
			authRevision: fixture.authRevision,
			capabilityRevision: fixture.capabilityRevision,
			policyRevision: input.policy.policyRevision,
			safeReason: fixture.availability.safeReason,
			receipt: fixture.availability.receipt,
		}),
		authorize: async (input: WorkerModelCapabilityAuthorizationInput) => {
			fixture.authorizeCalls += 1;
			const receiptWithoutVerification = {
				...input.receipt,
				receiptId: `${input.receipt.receiptId}-dispatch`,
				bindingDigest: input.bindingDigest,
				capabilityBinding: {
					capability: input.capability,
					resourceDigest: input.resourceDigest,
					operationDigest: input.operationDigest,
					executionIdentity: null,
					sessionId: null,
				},
				verificationDigest: "",
			};
			const receipt = {
				...receiptWithoutVerification,
				verificationDigest: digestObject(receiptWithoutVerification),
			};
			return {
				authenticatedPrincipal: "host-worker-model",
				capability: input.capability,
				workflowId: input.workflowId,
				bindingDigest: input.bindingDigest,
				resourceDigest: input.resourceDigest,
				operationDigest: input.operationDigest,
				receipt,
				authRevision: fixture.authRevision,
				capabilityRevision: fixture.capabilityRevision,
				policyRevision: input.policy.policyRevision,
				authorizationDigest: digestObject({ bindingDigest: input.bindingDigest, receipt }),
			};
		},
	};
	fixture.options = {
		runtimeStore: {
			identity: {
				storeKind: "workflow",
				namespace: "test",
				rootDir: "/tmp/worker-model-workflow",
				storeId: "store-worker-model",
				workflowId: "workflow-worker-model-red",
				identityDigest: "identity-worker-model",
			},
			durableContext: durable,
		} as unknown as WorkflowRuntimeStore,
		workflowId: "workflow-worker-model-red",
		runtimeVersion: "0.147.0-alpha.10",
		policy: {
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			reasoning: "max",
			allowFallback: false,
			policyRevision: "policy-1",
		} satisfies WorkerModelPolicyInput,
		host: fixture.host,
		quarantine: async () => {
			fixture.quarantineCalls += 1;
		},
		now: () => "2026-08-17T17:00:00.000Z",
	};
	return fixture;
}

function fakeReceipt(receiptId: string): WorkflowVerifiedHostReceipt {
	return {
		receiptKind: "capability",
		oneUse: false,
		receiptId,
		issuerId: "host-worker-model",
		workflowId: "workflow-worker-model-red",
		bindingDigest: digestObject({ receiptId }),
		payloadDigest: digestObject({ receiptId, payload: "worker-model" }),
		artifactRef: {
			artifactId: `artifact-${receiptId}`,
			relativePath: `receipts/${receiptId}`,
			sourceEventSequence: 1,
			digest: "b".repeat(64),
			sizeBytes: 1,
		},
		issuedAt: "2026-08-17T17:00:00.000Z",
		validUntil: "2026-08-17T18:00:00.000Z",
		keyId: "key-worker-model",
		signatureAlgorithm: "ed25519",
		artifactBytesDigest: "c".repeat(64),
		stateDigest: "state-1",
		revision: 1,
		capabilityBinding: {
			capability: WORKER_MODEL_CAPABILITY as never,
			resourceDigest: digestObject({ receiptId, resource: "worker-model" }),
			operationDigest: digestObject({ receiptId, operation: "worker-model-dispatch" }),
			executionIdentity: null,
			sessionId: null,
		},
		signature: "signed-worker-model",
		verificationDigest: digestObject({ receiptId, signed: true }),
	};
}
