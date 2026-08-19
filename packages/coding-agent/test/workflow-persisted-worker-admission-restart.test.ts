import { expect, it } from "vitest";

import {
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowRuntimeStore,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import {
	createPersistedWorkerModelCapabilityAdmission,
	type PersistedWorkerModelAdmissionInput,
} from "../src/core/workflow/persisted-worker-model-admission.js";
import type { WorkflowState } from "../src/core/workflow/reducer.js";
import type {
	WorkerModelCapabilityLaunchAuthorizer,
	WorkerModelCapabilityLaunchInput,
} from "../src/core/workflow/worker-model-capability-gate.js";
import {
	WORKER_MODEL_ID,
	WORKER_MODEL_PROVIDER,
	WORKER_MODEL_REASONING,
	WORKER_MODEL_SELECTOR,
} from "../src/core/workflow/worker-model-capability-gate.js";

const EPOCH_REF: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const STATE_DIGEST = "state-worker-admission";
const RUNTIME_VERSION = "0.147.0-alpha.10";

it("binds persisted receipts to each task attempt and execution key", async () => {
	const fixture = createFixture();
	const admit = createAdmission(fixture);
	const first = await admit(launch("attempt-1", "execution-1"));
	const second = await admit(launch("attempt-2", "execution-2"));

	expect(second.intent.receiptDigest).not.toBe(first.intent.receiptDigest);
	expect(second.intent.receipt.bindingDigest).not.toBe(first.intent.receipt.bindingDigest);
});

it("revalidates a persisted receipt after adapter restart before accepting the handshake", async () => {
	const fixture = createFixture();
	const firstLaunch = launch("attempt-restart", "execution-restart");
	const first = await createAdmission(fixture)(firstLaunch);
	await expect(first.handshake(first.intent.childModel)).resolves.toMatchObject({ status: "accepted" });

	await fixture.receiptContext.revokeReceipt?.(first.intent.receipt.receiptId);
	fixture.now = "2026-08-17T19:00:00.000Z";
	const restarted = await createAdmission(fixture)(firstLaunch);
	const handshake = await restarted.handshake(restarted.intent.childModel);

	expect(handshake.status).toBe("terminate_quarantine");
	if (handshake.status !== "terminate_quarantine") throw new Error("expected receipt quarantine");
	expect(handshake.quarantine.reason).toBe("receipt_mismatch");
	expect(fixture.receiptResolveCalls).toBeGreaterThan(0);
});

interface AdmissionFixture {
	readonly input: PersistedWorkerModelAdmissionInput;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly receipts: Map<string, WorkflowVerifiedHostReceipt>;
	readonly state: WorkflowState;
	now: string;
	receiptResolveCalls: number;
}

function createAdmission(fixture: AdmissionFixture): WorkerModelCapabilityLaunchAuthorizer {
	return createPersistedWorkerModelCapabilityAdmission(fixture.input);
}

function launch(attemptId: string, executionKey: string): WorkerModelCapabilityLaunchInput {
	return {
		workflowId: "workflow-worker-admission-restart",
		taskId: "task-recon",
		attemptId,
		executionKey,
		epochRef: EPOCH_REF,
		prompt: "recon",
		sessionName: "recon-worker",
		selector: WORKER_MODEL_SELECTOR,
		provider: WORKER_MODEL_PROVIDER,
		model: WORKER_MODEL_ID,
		reasoning: WORKER_MODEL_REASONING,
		allowFallback: false,
	};
}

function createFixture(): AdmissionFixture {
	let durableBytes: Uint8Array | null = null;
	let leaseTail: Promise<void> = Promise.resolve();
	const state: WorkflowState = {
		workflowId: "workflow-worker-admission-restart",
		rootSessionId: "session-worker-admission-restart",
		status: "active",
		phase: "dispatching",
		objective: "admit a worker",
		goalId: "goal-worker-admission-restart",
		goalActive: true,
		goalStatus: "active",
		goalTokenBudget: null,
		goalTokensUsed: 0,
		goalTimeUsedSeconds: 0,
		goalContinuationsUsed: 0,
		goalCreatedAt: null,
		goalUpdatedAt: null,
		goalLastReason: null,
		goalLastError: null,
		sourceJournalSequence: 1,
		sourceJournalDigest: STATE_DIGEST,
		storeEpoch: EPOCH_REF.storeEpoch,
		coordinatorEpoch: EPOCH_REF.coordinatorEpoch,
		goalProjectionDigest: null,
		capacityDigest: null,
		goalContractDigest: null,
		approvalRequest: null,
		decisionRefs: [],
		profileDigest: null,
		configDigest: null,
		skillSnapshotDigests: [],
		cloudAvailabilityDigest: null,
		scorecardDigest: null,
		resourceEnvelopeDigest: null,
		continuityCapsuleDigest: null,
		provenRequirementIds: [],
		unprovenRequirementIds: [],
		regressedRequirementIds: [],
		workspaceDigest: digestObject("workspace"),
		executionProfile: "parallel",
		planRevision: 1,
		acceptedEvidenceRefs: [],
		ownershipLeaseRefs: [],
		resourceLeaseRefs: [],
		failedStrategies: [],
		unresolvedDecisionRefs: [],
		continuationEntryPoint: "dispatch",
		generationBinding: {} as WorkflowState["generationBinding"],
	};
	const baseReceiptContext = createFixtureHostReceiptConsumerContext();
	const receipts = new Map<string, WorkflowVerifiedHostReceipt>();
	let receiptSequence = 0;
	let now = "2026-08-17T17:00:00.000Z";
	let receiptResolveCalls = 0;
	const receiptResolver = baseReceiptContext.receiptResolver;
	const receiptContext: WorkflowHostReceiptConsumerContext = {
		...baseReceiptContext,
		principalAuthorizer: {
			authorize: async (input): Promise<WorkflowHostPrincipalCapabilityAuthorization> => ({
				authenticatedPrincipal: "fixture-host",
				keyOwnerPrincipal: "fixture-host",
				capability: input.capability,
				workflowId: input.workflowId,
				bindingDigest: input.bindingDigest,
				receipt: structuredClone(input.receipt),
				stateDigest: input.stateDigest,
				revision: input.revision,
				epochRef: structuredClone(input.epochRef),
				validity: { issuedAt: input.receipt.issuedAt, validUntil: input.receipt.validUntil },
				...(input.executionIdentity === undefined ? {} : { executionIdentity: input.executionIdentity }),
				...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
				authorizationDigest: digestObject({
					workflowId: input.workflowId,
					bindingDigest: input.bindingDigest,
					receiptId: input.receipt.receiptId,
					resourceDigest: input.resourceDigest,
					operationDigest: input.operationDigest,
				}),
			}),
		},
		receiptResolver: {
			...receiptResolver,
			resolve: async (input) => {
				receiptResolveCalls += 1;
				return receiptResolver.resolve(input);
			},
		},
	};
	const issueReceipt: PersistedWorkerModelAdmissionInput["issueReceipt"] = async (input) => {
		const key = digestObject({
			bindingDigest: input.bindingDigest,
			resourceDigest: input.resourceDigest,
			operationDigest: input.operationDigest,
		});
		const existing = receipts.get(key);
		if (existing !== undefined) return structuredClone(existing);
		receiptSequence += 1;
		const receipt = createFixtureHostReceipt({
			receiptKind: "capability",
			receiptId: `worker-admission-receipt-${receiptSequence}`,
			issuerId: "fixture-host",
			workflowId: input.workflowId,
			bindingDigest: input.bindingDigest,
			payloadDigest: digestObject({ key }),
			artifactRef: {
				artifactId: `worker-admission-artifact-${receiptSequence}`,
				relativePath: `receipts/worker-admission-${receiptSequence}`,
				digest: "0".repeat(64),
				sizeBytes: 0,
				sourceEventSequence: input.revision,
			},
			issuedAt: "2026-08-17T17:00:00.000Z",
			validUntil: "2026-08-17T18:00:00.000Z",
			keyId: "fixture-key",
			capabilityBinding: {
				capability: "workflow_worker_model_dispatch",
				resourceDigest: input.resourceDigest,
				operationDigest: input.operationDigest,
				executionIdentity: null,
				sessionId: null,
			},
			stateDigest: input.stateDigest,
			revision: input.revision,
			oneUse: false,
		});
		receipts.set(key, receipt);
		return structuredClone(receipt);
	};
	const durable = {
		generationId: "fixture-generation",
		epochRef: EPOCH_REF,
		currentLeaseRef: () => ({}) as never,
		outbox: {} as never,
		auxiliaryStore: {
			read: async () => (durableBytes === null ? null : new Uint8Array(durableBytes)),
			write: async (_name: string, bytes: Readonly<Uint8Array>) => {
				durableBytes = new Uint8Array(bytes);
			},
		},
		withExclusiveLease: async <T>(_: string, operation: () => Promise<T>): Promise<T> => {
			const previous = leaseTail;
			let release: (() => void) | undefined;
			leaseTail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
			try {
				return await operation();
			} finally {
				release?.();
			}
		},
		recoverJournal: async () => ({ status: "healthy", reason: null }),
	};
	const runtimeStore = {
		identity: {
			storeKind: "workflow",
			namespace: "test",
			rootDir: "/tmp/workflow-worker-admission-restart",
			storeId: "store-worker-admission-restart",
			workflowId: state.workflowId,
			identityDigest: digestObject("worker-admission-store"),
		},
		durableContext: durable,
	} as unknown as WorkflowRuntimeStore;
	const input: PersistedWorkerModelAdmissionInput = {
		runtimeStore,
		runtimeVersion: RUNTIME_VERSION,
		workflowId: state.workflowId,
		readState: async () => structuredClone(state),
		receiptContext,
		issueReceipt,
		availability: async () => ({
			authenticated: true,
			authRevision: "auth-1",
			capabilityRevision: "capability-1",
			safeReason: "available",
		}),
		now: () => now,
	};
	const fixture: AdmissionFixture = { input, receiptContext, receipts, state, now, receiptResolveCalls };
	Object.defineProperties(fixture, {
		now: {
			get: () => now,
			set: (value: string) => {
				now = value;
			},
		},
		receiptResolveCalls: {
			get: () => receiptResolveCalls,
		},
	});
	return fixture;
}
