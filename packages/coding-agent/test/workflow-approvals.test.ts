import { createHash, generateKeyPairSync, type KeyObject, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
	WorkflowApprovalBindingInput,
	WorkflowApprovalDecisionContext,
	WorkflowApprovalInvalidation,
	WorkflowApprovalManagerWithOutcome,
	WorkflowApprovalRequestInput,
	WorkflowApprovalSecretIssuance,
	WorkflowApprovalStore,
} from "../src/core/workflow/approvals.js";
import { approvalBindingDigest, createDurableApprovalManager } from "../src/core/workflow/approvals.js";
import type {
	WorkflowApprovalConsumptionResult,
	WorkflowApprovalRequest,
	WorkflowApprovalResponse,
	WorkflowApprovalResumeTransition,
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowSignedApprovalArtifact,
} from "../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
} from "../src/core/workflow/contracts.js";
import { loadPersistedEpochFixture } from "./workflow-fixtures.js";

const EPOCH: WorkflowEpochRef = loadPersistedEpochFixture().acquired;
const PRINCIPAL = {
	kind: "interactive_ui" as const,
	principalId: "user-1",
	credentialDigest: "credential-1",
};
const CLIENT_SESSION_ID = "client-1";
const WORKFLOW_ID = "workflow-1";

interface ApprovalStoreFixture {
	store: WorkflowApprovalStore;
	getPending(): WorkflowApprovalRequest | null;
	getConsumed(): WorkflowApprovalConsumptionResult | null;
	getReconcileCalls(): number;
	getLastResumeTransition(): WorkflowApprovalResumeTransition | null;
	setHead(head: { stateDigest: string; epochRef: WorkflowEpochRef; headDigest: string; revision: number }): void;
}

describe("durable workflow approvals", () => {
	it("consumes an interactive approval exactly once without persisting the secret", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(createApprovalInput());
		await expect(fixture.manager.pending(WORKFLOW_ID)).resolves.toEqual(request);

		const response = createInteractiveResponse(request, "approve", "one-use-secret");
		const consumed = await fixture.manager.consumeInteractive(response);
		expect(consumed).toMatchObject({ status: "consumed", receipt: { optionId: "approve" } });
		const resumeTransition = {
			status: "active" as const,
			phase: "planning" as const,
			plannerEventDigest: "planner-event",
			expectedHeadDigest: consumed.receipt.headDigest,
			expectedStateDigest: consumed.receipt.stateDigest,
			expectedEpoch: {
				storeEpoch: consumed.receipt.storeEpoch,
				coordinatorEpoch: consumed.receipt.coordinatorEpoch,
			},
		};
		const journalBytes = new TextDecoder().decode(
			canonicalJsonBytes({ kind: "approval_consumed", receipt: consumed.receipt, resumeTransition }),
		);
		const artifactBytes = new TextDecoder().decode(canonicalJsonBytes(consumed.receipt));
		expect(journalBytes).not.toContain("one-use-secret");
		expect(artifactBytes).not.toContain("one-use-secret");
		await expect(fixture.manager.consumeInteractive(response)).rejects.toThrow(/consumed|duplicate/i);
	});

	it("preserves the selected option instead of consuming the first option", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(
			createApprovalInput([
				{ optionId: "approve", label: "Approve", effectDigest: "effect-approve" },
				{ optionId: "decline", label: "Decline", effectDigest: "effect-decline" },
			]),
		);

		const consumed = await fixture.manager.consumeInteractive(
			createInteractiveResponse(request, "decline", "one-use-secret"),
		);

		expect(consumed).toMatchObject({
			status: "consumed",
			receipt: { optionId: "decline", effectDigest: "effect-decline" },
		});
	});

	it("returns a distinct declined host outcome without resuming planning", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(
			createApprovalInput([
				{ optionId: "approve", label: "Approve", effectDigest: "effect-approve" },
				{ optionId: "decline", label: "Decline", effectDigest: "effect-decline" },
			]),
		);

		const consumed = await fixture.manager.consumeInteractive(
			createInteractiveResponse(request, "decline", "one-use-secret"),
		);

		expect(consumed).toMatchObject({
			status: "consumed",
			outcome: { action: "decline", disposition: "declined" },
		});
		expect(fixture.getLastResumeTransition()).toBeNull();
	});

	it.each([
		["approve", "approved", "resume_planning"],
		["decline", "declined", "remain_awaiting_user"],
		["cancel", "cancelled", "cancelled"],
	] as const)("binds the %s action to a distinct host outcome", async (optionId, disposition, transition) => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(
			createApprovalInput([{ optionId, label: "Misleading display label", effectDigest: `effect-${optionId}` }]),
		);

		const consumed = await fixture.manager.consumeInteractive(
			createInteractiveResponse(request, optionId, "one-use-secret"),
		);

		expect(consumed).toMatchObject({
			status: "consumed",
			outcome: { action: optionId, disposition, transition, optionId },
			receipt: { optionId, effectDigest: `effect-${optionId}` },
		});
		expect(fixture.getLastResumeTransition()).toEqual(optionId === "approve" ? expect.any(Object) : null);
	});

	it("rejects action substitution even when the replacement option is valid", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(
			createApprovalInput([
				{ optionId: "approve", label: "Approve", effectDigest: "effect-approve" },
				{ optionId: "decline", label: "Decline", effectDigest: "effect-decline" },
			]),
		);
		const response = createInteractiveResponse(request, "approve", "one-use-secret");

		await expect(fixture.manager.consumeInteractive({ ...response, optionId: "decline" })).rejects.toThrow(
			/binding|bound|secret/i,
		);
		expect(fixture.getConsumed()).toBeNull();
	});

	it("rejects a stale epoch before consuming the request", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(createApprovalInput());
		fixture.setHead({
			stateDigest: request.stateDigest,
			epochRef: { storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch + 1 },
			headDigest: digestObject({
				workflowId: request.workflowId,
				stateDigest: request.stateDigest,
				storeEpoch: request.storeEpoch,
				coordinatorEpoch: request.coordinatorEpoch + 1,
			}),
			revision: 1,
		});

		await expect(
			fixture.manager.consumeInteractive(createInteractiveResponse(request, "approve", "one-use-secret")),
		).rejects.toThrow(/stale|epoch|head/i);
		expect(fixture.getConsumed()).toBeNull();
	});

	it("invalidates pending approval explicitly and keeps invalidation across reopen", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(createApprovalInput());
		const response = createInteractiveResponse(request, "approve", "one-use-secret");

		await expect(fixture.manager.invalidate(request.approvalRequestId, "proposal superseded")).resolves.toMatchObject(
			{
				status: "invalidated",
				invalidation: {
					approvalRequestId: request.approvalRequestId,
					reason: "proposal superseded",
				},
			},
		);
		await expect(fixture.manager.pending(WORKFLOW_ID)).resolves.toBeNull();
		await expect(fixture.manager.consumeInteractive(response)).rejects.toThrow(/invalidated/i);

		const reopened = await fixture.manager.reopen(fixture.store);
		await expect(reopened.pending(WORKFLOW_ID)).resolves.toBeNull();
		await expect(reopened.consumeInteractive(response)).rejects.toThrow(/invalidated/i);
		fixture.setHead({
			stateDigest: "new-state",
			epochRef: EPOCH,
			headDigest: digestObject("new-head"),
			revision: 2,
		});
		await expect(reopened.invalidate(request.approvalRequestId, "same invalidation replay")).resolves.toMatchObject({
			status: "already_invalidated",
		});
	});

	it("does not cancel an approval after its one-use response was consumed", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(createApprovalInput());
		await fixture.manager.consumeInteractive(createInteractiveResponse(request, "approve", "one-use-secret"));

		await expect(fixture.manager.cancel(request.approvalRequestId)).rejects.toThrow(/consumed|cancel/i);
	});

	it("serializes invalidation and consumption so only one wins", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(createApprovalInput());
		const response = createInteractiveResponse(request, "approve", "one-use-secret");
		const [consumeResult, invalidateResult] = await Promise.allSettled([
			fixture.manager.consumeInteractive(response),
			fixture.manager.invalidate(request.approvalRequestId, "operator cancelled"),
		]);

		expect([consumeResult.status, invalidateResult.status].sort()).toEqual(["fulfilled", "rejected"]);
	});

	it("rejects a response from a different trusted principal without consuming", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(createApprovalInput());
		const response = createInteractiveResponse(request, "approve", "one-use-secret");
		const foreignResponse = {
			...response,
			trustedPrincipal: {
				kind: "interactive_ui" as const,
				principalId: "user-2",
				credentialDigest: "credential-2",
			},
		};

		await expect(fixture.manager.consumeInteractive(foreignResponse)).rejects.toThrow(/bound|principal/i);
		expect(fixture.getPending()).toEqual(request);
		expect(fixture.getConsumed()).toBeNull();
	});

	it("rejects caller-supplied decision refs that are not the current host decision context", async () => {
		const fixture = createApprovalManagerFixture();
		const input = createApprovalInput();
		const arbitraryGoal = { ...input.decisionRefs[0], decisionDigest: "caller-arbitrary" };
		const arbitraryInput: WorkflowApprovalRequestInput = {
			...input,
			decisionRefs: [arbitraryGoal, input.decisionRefs[1], input.decisionRefs[2]],
			decisionRoles: { ...input.decisionRoles, goal: arbitraryGoal },
		};

		await expect(fixture.manager.createRequest(arbitraryInput)).rejects.toThrow(/current|decision|receipt/i);
		expect(fixture.getPending()).toBeNull();
	});

	it("rejects a stale decision revision even when the workflow epoch is current", async () => {
		const fixture = createApprovalManagerFixture();
		const input = createApprovalInput();
		const staleResource = { ...input.decisionRef, revision: input.decisionRef.revision + 1 };
		const staleInput: WorkflowApprovalRequestInput = {
			...input,
			decisionRef: staleResource,
			decisionRefs: [input.decisionRefs[0], input.decisionRefs[1], staleResource],
			decisionRoles: { ...input.decisionRoles, resource: staleResource },
		};

		await expect(fixture.manager.createRequest(staleInput)).rejects.toThrow(/current|revision|decision/i);
		expect(fixture.getPending()).toBeNull();
	});

	it("reconciles a prepared request when secret delivery fails", async () => {
		const fixture = createApprovalManagerFixture(true);

		await expect(fixture.manager.createRequest(createApprovalInput())).rejects.toThrow(/delivery/i);
		expect(fixture.getReconcileCalls()).toBe(1);
	});

	it.each([
		"decisionRef",
		"decisionRefs",
		"decisionRoles",
		"stateDigest",
		"configDigest",
		"profileDigest",
		"artifactDigest",
		"storeEpoch",
		"coordinatorEpoch",
		"clientSessionId",
		"responseSequence",
		"optionId",
		"expiresAt",
	] as const)("rejects a signed-headless mutation of %s after restart", async (field) => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(createApprovalInput());
		const reopened = await fixture.manager.reopen(fixture.store);
		const response = createSignedHeadlessResponse(request, fixture.privateKey);
		const signed = {
			...response.signedHeadlessArtifact,
			[field]: mutateSignedApprovalField(field, response.signedHeadlessArtifact[field]),
		} as unknown as WorkflowSignedApprovalArtifact;

		await expect(reopened.consumeSignedHeadless({ ...response, signedHeadlessArtifact: signed })).rejects.toThrow(
			/signature|bound|expired|principal|digest/i,
		);
		expect(fixture.getConsumed()).toBeNull();
	});

	it("consumes one fully bound Ed25519 response and rejects a racing duplicate", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(createApprovalInput());
		const response = createSignedHeadlessResponse(request, fixture.privateKey);
		const [left, right] = await Promise.allSettled([
			fixture.manager.consumeSignedHeadless(response),
			fixture.manager.consumeSignedHeadless(response),
		]);

		expect([left.status, right.status].sort()).toEqual(["fulfilled", "rejected"]);
		expect(fixture.getConsumed()?.status).toBe("consumed");
	});

	it("rejects a signature over the artifact instead of the exact approval binding", async () => {
		const fixture = createApprovalManagerFixture();
		const request = await fixture.manager.createRequest(createApprovalInput());
		const response = createSignedHeadlessResponse(request, fixture.privateKey, true);

		await expect(fixture.manager.consumeSignedHeadless(response)).rejects.toThrow(/signature/i);
		expect(fixture.getConsumed()).toBeNull();
	});
});

interface ManagerFixture {
	manager: WorkflowApprovalManagerWithOutcome;
	store: WorkflowApprovalStore;
	privateKey: KeyObject;
	getPending(): WorkflowApprovalRequest | null;
	getConsumed(): WorkflowApprovalConsumptionResult | null;
	getReconcileCalls(): number;
	getLastResumeTransition(): WorkflowApprovalResumeTransition | null;
	setHead(head: { stateDigest: string; epochRef: WorkflowEpochRef; headDigest: string; revision: number }): void;
}

function createApprovalManagerFixture(failDelivery = false): ManagerFixture {
	const keyPair = generateKeyPairSync("ed25519");
	const fixture = createApprovalStoreFixture();
	const currentDecisionRefs = createDecisionRefs();
	const dependencies = (store: WorkflowApprovalStore) => ({
		store,
		keyResolver: {
			resolve: async () => ({
				verify: (artifact: { signature: string }, signedDigest: string) =>
					verifyBytes(
						null,
						Buffer.from(signedDigest),
						keyPair.publicKey,
						Buffer.from(artifact.signature, "base64"),
					),
			}),
		},
		secretProvider: {
			prepare: async (input: {
				workflowId: string;
				clientSessionId: string;
				trustedPrincipal: typeof PRINCIPAL;
				requestDigest: string;
			}): Promise<WorkflowApprovalSecretIssuance> => ({
				issuanceId: "issuance-1",
				workflowId: input.workflowId,
				clientSessionId: input.clientSessionId,
				trustedPrincipal: input.trustedPrincipal,
				tokenHash: sha256Secret("one-use-secret"),
				tokenHashAlgorithm: "sha256",
				deliveryProof: "delivered-to-client-1",
			}),
			deliver: async () => {
				if (failDelivery) throw new Error("delivery failed");
			},
		},
		decisionAuthority: {
			resolveCurrent: async (current: {
				workflowId: string;
				stateDigest: string;
				epochRef: WorkflowEpochRef;
				currentRevision: number;
			}): Promise<WorkflowApprovalDecisionContext> => {
				if (
					current.workflowId !== WORKFLOW_ID ||
					current.stateDigest !== "state" ||
					current.epochRef.storeEpoch !== EPOCH.storeEpoch ||
					current.epochRef.coordinatorEpoch !== EPOCH.coordinatorEpoch ||
					current.currentRevision !== 1
				)
					throw new Error("Current decision context is unavailable.");
				const decisionRef = currentDecisionRefs[2];
				const decisionRoles = {
					goal: currentDecisionRefs[0],
					scorecard: currentDecisionRefs[1],
					resource: currentDecisionRefs[2],
				};
				const decisionRefs = [...currentDecisionRefs] as readonly WorkflowDecisionRef[];
				return {
					decisionRef,
					decisionRefs,
					decisionRoles,
					hostReceipt: createDecisionContextReceipt(
						current.workflowId,
						current.stateDigest,
						current.epochRef,
						decisionRef,
						decisionRefs,
						decisionRoles,
					),
				};
			},
		},
		trustedPrincipal: PRINCIPAL,
		clientSessionId: CLIENT_SESSION_ID,
		trustedClock: {
			receipt: async ({ workflowId, bindingDigest }: { workflowId: string; bindingDigest: string }) =>
				createFixtureHostReceipt({
					receiptKind: "clock",
					receiptId: "approval-clock",
					issuerId: "approval-host",
					workflowId,
					bindingDigest,
					payloadDigest: "clock-payload",
					artifactRef: {
						artifactId: "approval-clock",
						relativePath: "receipts/approval-clock",
						digest: "clock",
						sizeBytes: 1,
						sourceEventSequence: 0,
					},
					issuedAt: "2030-01-01T00:00:01.000Z",
					validUntil: "2030-01-01T00:05:00.000Z",
					keyId: "approval-clock-key",
					signature: "approval-clock-signature",
					stateDigest: "state",
				}),
		},
		maxTtlMilliseconds: 300_000,
		receiptContext: createFixtureHostReceiptConsumerContext(),
		currentRevision: 1,
	});
	const manager = createDurableApprovalManager(dependencies(fixture.store));
	return {
		manager,
		store: fixture.store,
		privateKey: keyPair.privateKey,
		getPending: fixture.getPending,
		getConsumed: fixture.getConsumed,
		getReconcileCalls: fixture.getReconcileCalls,
		getLastResumeTransition: fixture.getLastResumeTransition,
		setHead: fixture.setHead,
	};
}

function createApprovalStoreFixture(): ApprovalStoreFixture {
	let pending: WorkflowApprovalRequest | null = null;
	let consumed: WorkflowApprovalConsumptionResult | null = null;
	let invalidation: WorkflowApprovalInvalidation | null = null;
	let lastResumeTransition: WorkflowApprovalResumeTransition | null = null;
	let reconcileCalls = 0;
	let currentHead = {
		stateDigest: "state",
		epochRef: { ...EPOCH },
		headDigest: digestObject({
			workflowId: WORKFLOW_ID,
			stateDigest: "state",
			storeEpoch: EPOCH.storeEpoch,
			coordinatorEpoch: EPOCH.coordinatorEpoch,
		}),
		revision: 1,
	};
	const store: WorkflowApprovalStore = {
		prepareRequest: async ({
			request,
			requestEventDigest,
			awaitingUserTransition,
			expectedHeadDigest,
			expectedStateDigest,
			expectedEpoch,
		}) => {
			if (
				requestEventDigest.length === 0 ||
				awaitingUserTransition.status !== "awaiting_user" ||
				awaitingUserTransition.phase !== "adjudicating" ||
				awaitingUserTransition.expectedHeadDigest !== expectedHeadDigest ||
				request.stateDigest !== expectedStateDigest ||
				digestObject(awaitingUserTransition.expectedEpoch) !== digestObject(expectedEpoch)
			)
				throw new Error("Approval fixture refused a non-atomic awaiting_user transition.");
			pending = structuredClone(request);
		},
		markSecretDelivered: async ({ approvalRequestId, deliveryProof, expectedStateDigest, expectedEpoch }) => {
			if (
				pending?.approvalRequestId !== approvalRequestId ||
				pending.stateDigest !== expectedStateDigest ||
				pending.storeEpoch !== expectedEpoch.storeEpoch ||
				pending.coordinatorEpoch !== expectedEpoch.coordinatorEpoch ||
				deliveryProof.length === 0
			)
				throw new Error("Approval delivery is not bound to the prepared request.");
		},
		read: async (approvalRequestId) =>
			pending?.approvalRequestId === approvalRequestId ? structuredClone(pending) : null,
		readPending: async (workflowId) =>
			pending?.workflowId === workflowId && consumed === null && invalidation === null
				? structuredClone(pending)
				: null,
		readInvalidation: async (approvalRequestId) =>
			invalidation?.approvalRequestId === approvalRequestId ? structuredClone(invalidation) : null,
		readCurrentHead: async (workflowId) => {
			if (workflowId !== WORKFLOW_ID) throw new Error("Approval current head is unavailable.");
			return structuredClone(currentHead);
		},
		consume: async (input) => {
			if (consumed !== null) return { status: "already_consumed", receipt: consumed.receipt };
			if (pending === null) throw new Error("Approval request is missing.");
			if (invalidation !== null) throw new Error("Approval request has been invalidated.");
			if (
				input.expectedHeadDigest !== currentHead.headDigest ||
				input.expectedStateDigest !== currentHead.stateDigest ||
				digestObject(input.expectedEpoch) !== digestObject(currentHead.epochRef) ||
				input.approvalConsumedEventDigest.length === 0 ||
				input.outcomeDigest.length === 0 ||
				(input.optionId === "approve" &&
					(input.resumeTransition === null ||
						input.resumeTransition.status !== "active" ||
						input.resumeTransition.phase !== "planning" ||
						input.resumeTransition.expectedHeadDigest !== input.expectedHeadDigest ||
						input.resumeTransition.expectedStateDigest !== pending.stateDigest ||
						input.resumeTransition.expectedEpoch.storeEpoch !== pending.storeEpoch ||
						input.resumeTransition.expectedEpoch.coordinatorEpoch !== pending.coordinatorEpoch ||
						input.resumeTransition.plannerEventDigest.length === 0)) ||
				(input.optionId !== "approve" && input.resumeTransition !== null)
			)
				throw new Error(
					"Approval consumption must atomically resume a fresh planner from the current prepared head.",
				);
			lastResumeTransition = input.resumeTransition;
			const option = pending.options.find((candidate) => candidate.optionId === input.optionId);
			if (option === undefined) throw new Error("Approval fixture could not resolve the selected option.");
			const decisionRefs = pending.decisionRefs as readonly WorkflowDecisionRef[];
			const receipt = {
				approvalRequestId: pending.approvalRequestId,
				workflowId: pending.workflowId,
				decisionRef: pending.decisionRef,
				decisionRefs,
				decisionRoles: pending.decisionRoles,
				headDigest: pending.headDigest,
				stateDigest: pending.stateDigest,
				configDigest: pending.configDigest,
				profileDigest: pending.profileDigest,
				artifactDigest: pending.artifactDigest,
				storeEpoch: pending.storeEpoch,
				coordinatorEpoch: pending.coordinatorEpoch,
				clientSessionId: pending.requestingClientSessionId,
				trustedPrincipal: pending.trustedPrincipal,
				responseSequence: pending.expectedResponseSequence,
				optionId: option.optionId,
				effectDigest: input.effectDigest,
				mode: "interactive_secret" as const,
				responseDigest: input.responseDigest,
				consumedAt: "2030-01-01T00:00:02.000Z",
				consumptionEventSequence: 2,
				trustedClockReceipt: input.trustedClockReceipt,
			};
			const result: WorkflowApprovalConsumptionResult = { status: "consumed", receipt };
			consumed = result;
			return result;
		},
		invalidate: async (input) => {
			if (consumed !== null) return { status: "already_consumed", receipt: consumed.receipt };
			if (invalidation !== null)
				return { status: "already_invalidated", invalidation: structuredClone(invalidation) };
			if (
				pending === null ||
				pending.approvalRequestId !== input.approvalRequestId ||
				pending.expectedResponseSequence !== input.expectedResponseSequence ||
				pending.stateDigest !== input.expectedStateDigest ||
				pending.storeEpoch !== input.expectedEpoch.storeEpoch ||
				pending.coordinatorEpoch !== input.expectedEpoch.coordinatorEpoch ||
				pending.headDigest !== input.expectedHeadDigest
			)
				throw new Error("Approval invalidation is not bound to the prepared request.");
			invalidation = structuredClone(input.invalidation);
			return { status: "invalidated", invalidation: structuredClone(invalidation) };
		},
		reconcile: async () => {
			reconcileCalls += 1;
		},
	};
	return {
		store,
		getPending: () => pending,
		getConsumed: () => consumed,
		getReconcileCalls: () => reconcileCalls,
		getLastResumeTransition: () => lastResumeTransition,
		setHead: (head) => {
			currentHead = structuredClone(head);
		},
	};
}

function createApprovalInput(
	options: readonly { optionId: string; label: string; effectDigest: string }[] = [
		{ optionId: "approve", label: "Approve", effectDigest: "effect" },
	],
): WorkflowApprovalRequestInput {
	const decisionRefs = createDecisionRefs();
	const headDigest = digestObject({
		workflowId: WORKFLOW_ID,
		stateDigest: "state",
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
	});
	return {
		workflowId: WORKFLOW_ID,
		decisionRef: decisionRefs[2],
		decisionRefs,
		decisionRoles: { goal: decisionRefs[0], scorecard: decisionRefs[1], resource: decisionRefs[2] },
		headDigest,
		stateDigest: "state",
		configDigest: "config",
		profileDigest: "profile",
		artifactDigest: "artifact",
		...EPOCH,
		expectedResponseSequence: 1,
		ttlMilliseconds: 60_000,
		question: "Approve?",
		options,
		awaitingUserTransition: {
			status: "awaiting_user",
			phase: "adjudicating",
			goalDelta: {
				goalId: "goal-1",
				objective: "objective",
				active: false,
				status: "paused",
				tokenBudget: 100,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				continuationsUsed: 0,
				createdAt: 0,
				updatedAt: 0,
				lastReason: "awaiting approval",
				lastError: null,
			},
			expectedHeadDigest: headDigest,
			expectedEpoch: { ...EPOCH },
		},
	};
}

function createInteractiveResponse(
	request: WorkflowApprovalRequest,
	optionId: string,
	secret: string,
): WorkflowApprovalResponse {
	const decisionRefs = request.decisionRefs as readonly WorkflowDecisionRef[];
	return {
		approvalRequestId: request.approvalRequestId,
		decisionRef: request.decisionRef,
		decisionRefs,
		decisionRoles: request.decisionRoles,
		workflowId: request.workflowId,
		headDigest: request.headDigest,
		stateDigest: request.stateDigest,
		configDigest: request.configDigest,
		profileDigest: request.profileDigest,
		artifactDigest: request.artifactDigest,
		storeEpoch: request.storeEpoch,
		coordinatorEpoch: request.coordinatorEpoch,
		clientSessionId: request.requestingClientSessionId,
		trustedPrincipal: request.trustedPrincipal,
		responseSequence: request.expectedResponseSequence,
		optionId,
		mode: "interactive_secret",
		secretProof: {
			oneUseSecret: secret,
			bindingDigest: approvalBindingDigest(createBindingInput(request, optionId)),
			bindingDigestAlgorithm: "sha256",
		},
	};
}

function createSignedHeadlessResponse(
	request: WorkflowApprovalRequest,
	privateKey: KeyObject,
	signCanonicalArtifact = false,
): Extract<WorkflowApprovalResponse, { mode: "signed_headless" }> {
	const option = request.options[0];
	const decisionRefs = request.decisionRefs as readonly WorkflowDecisionRef[];
	const unsigned = {
		kind: "signed_headless" as const,
		approvalRequestId: request.approvalRequestId,
		workflowId: request.workflowId,
		decisionRef: request.decisionRef,
		decisionRefs,
		decisionRoles: request.decisionRoles,
		headDigest: request.headDigest,
		stateDigest: request.stateDigest,
		configDigest: request.configDigest,
		profileDigest: request.profileDigest,
		artifactDigest: request.artifactDigest,
		optionId: option.optionId,
		principal: request.trustedPrincipal,
		storeEpoch: request.storeEpoch,
		coordinatorEpoch: request.coordinatorEpoch,
		clientSessionId: request.requestingClientSessionId,
		responseSequence: request.expectedResponseSequence,
		expiresAt: request.expiresAt,
		signedRequestDigest: approvalBindingDigest(createBindingInput(request, option.optionId)),
		keyId: "approval-ed25519",
		signatureAlgorithm: "ed25519" as const,
	};
	const signatureDigest = signCanonicalArtifact ? digestObject(unsigned) : unsigned.signedRequestDigest;
	const signature = signBytes(null, Buffer.from(signatureDigest), privateKey).toString("base64");
	return {
		approvalRequestId: request.approvalRequestId,
		decisionRef: request.decisionRef,
		decisionRefs,
		decisionRoles: request.decisionRoles,
		workflowId: request.workflowId,
		headDigest: request.headDigest,
		stateDigest: request.stateDigest,
		configDigest: request.configDigest,
		profileDigest: request.profileDigest,
		artifactDigest: request.artifactDigest,
		storeEpoch: request.storeEpoch,
		coordinatorEpoch: request.coordinatorEpoch,
		clientSessionId: request.requestingClientSessionId,
		trustedPrincipal: request.trustedPrincipal,
		responseSequence: request.expectedResponseSequence,
		optionId: option.optionId,
		mode: "signed_headless",
		signedHeadlessArtifact: { ...unsigned, signature },
	};
}

function createDecisionRef(role: string): WorkflowDecisionRef {
	return {
		decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: "session-1" },
		decisionId: `decision-${role}`,
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		decisionDigest: `decision-${role}-digest`,
	};
}

function createDecisionRefs(): readonly [WorkflowDecisionRef, WorkflowDecisionRef, WorkflowDecisionRef] {
	return [createDecisionRef("goal"), createDecisionRef("scorecard"), createDecisionRef("resource")];
}

function createDecisionContextReceipt(
	workflowId: string,
	stateDigest: string,
	epochRef: WorkflowEpochRef,
	decisionRef: WorkflowDecisionRef,
	decisionRefs: readonly WorkflowDecisionRef[],
	decisionRoles: {
		goal: WorkflowDecisionRef;
		scorecard: WorkflowDecisionRef;
		resource: WorkflowDecisionRef;
	},
) {
	return createFixtureHostReceipt({
		receiptKind: "decision",
		oneUse: false,
		receiptId: "approval-decision",
		issuerId: "approval-decision-host",
		workflowId,
		bindingDigest: digestObject({
			kind: "approval_decision_context",
			workflowId,
			stateDigest,
			epochRef,
			decisionRef,
			decisionRefs,
			decisionRoles,
		}),
		payloadDigest: "decision-payload",
		artifactRef: {
			artifactId: "approval-decision",
			relativePath: "receipts/approval-decision",
			digest: "decision",
			sizeBytes: 1,
			sourceEventSequence: 0,
		},
		issuedAt: "2030-01-01T00:00:01.000Z",
		validUntil: "2030-01-01T00:05:00.000Z",
		keyId: "approval-decision-key",
		signature: "approval-decision-signature",
		stateDigest,
		revision: 1,
	});
}

function createBindingInput(request: WorkflowApprovalRequest, optionId: string): WorkflowApprovalBindingInput {
	const decisionRefs = request.decisionRefs as readonly WorkflowDecisionRef[];
	return {
		approvalRequestId: request.approvalRequestId,
		workflowId: request.workflowId,
		decisionRef: request.decisionRef,
		decisionRefs,
		decisionRoles: request.decisionRoles,
		headDigest: request.headDigest,
		stateDigest: request.stateDigest,
		configDigest: request.configDigest,
		profileDigest: request.profileDigest,
		artifactDigest: request.artifactDigest,
		storeEpoch: request.storeEpoch,
		coordinatorEpoch: request.coordinatorEpoch,
		principal: request.trustedPrincipal,
		clientSessionId: request.requestingClientSessionId,
		responseSequence: request.expectedResponseSequence,
		optionId,
		tokenHash: request.tokenHash,
		expiresAt: request.expiresAt,
	};
}

function mutateSignedApprovalField(field: string, value: unknown): unknown {
	if (field === "decisionRef") return { ...(value as WorkflowDecisionRef), decisionDigest: "tampered" };
	if (field === "decisionRefs") return [...(value as readonly WorkflowDecisionRef[]), createDecisionRef("tampered")];
	if (field === "decisionRoles") return { ...(value as object), resource: createDecisionRef("tampered") };
	if (field === "principal") return { ...PRINCIPAL, principalId: "user-2" };
	if (field === "optionId") return "reject";
	if (field === "expiresAt") return "2030-01-01T00:00:03.000Z";
	if (typeof value === "number") return value + 1;
	if (typeof value === "string") return `${value}-tampered`;
	return value;
}

function sha256Secret(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}
