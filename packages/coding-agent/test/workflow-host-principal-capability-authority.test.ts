import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import {
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	type DurableApprovalSecretProof,
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostPrincipalCapabilityAuthorizer,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowJournalHead,
	type WorkflowRuntimeStore,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
	type PersistedWorkflowCompletionReadinessAuthority,
	type PersistedWorkflowCompletionReceiptIssuer,
} from "../src/core/workflow/session-host-factory.js";

const WORKFLOW_ID = "workflow-host-principal-authority";
const ROOT_SESSION_ID = "session-host-principal-authority";
const NOW = "2026-08-17T16:00:00.000Z";
const GENESIS_EPOCH: WorkflowEpochRef = { storeEpoch: 3, coordinatorEpoch: 4 };

/**
 * Durable RED manifest. Each assertion is intentionally public-boundary and maps to one protected outcome:
 * - arbitrary issuer strings cannot grant principal authority;
 * - one signed receipt cannot request a different capability;
 * - stale generation, epoch, head/state, or revision is rejected;
 * - foreign workflows, revoked keys, forged owners, and execution/session mismatches are rejected;
 * - one-use consumption remains durable and separate from authorization;
 * - reopening the persisted host reconstructs the same authority;
 * - structurally valid caller-forged principal/capability data cannot self-authorize.
 */

type HostPrincipalCapabilityAuthorizationInput = WorkflowHostPrincipalCapabilityAuthorizationInput;
type HostPrincipalCapabilityAuthorizer = WorkflowHostPrincipalCapabilityAuthorizer;

interface CapturedHostAuthority {
	runtimeStore: WorkflowRuntimeStore;
	receiptContext: WorkflowHostReceiptConsumerContext;
	issueReceipt: PersistedWorkflowCompletionReceiptIssuer;
}

interface FactoryMutationProbe {
	readonly replacementAccepted: { value: boolean };
	readonly mutationRejected: { value: boolean };
}

function createGoalProjection(): { read(): GoalState; compareAndSwap(expected: GoalState, next: GoalState): boolean } {
	let goal = emptyGoalState();
	return {
		read: (): GoalState => structuredClone(goal),
		compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
}

function unusedReadinessAuthority(): PersistedWorkflowCompletionReadinessAuthority {
	const unused = async (): Promise<never> => {
		throw new Error("unused completion readiness authority in principal authority integration test");
	};
	return {
		resolveReadiness: unused,
		resolveDigestSources: unused,
		resolveDecision: unused,
		validateDecision: unused,
		validateEvidence: unused,
		validateScorecard: unused,
		validateProgress: unused,
		validateResources: unused,
	};
}

async function openHost(
	artifactRoot: string,
	captured: { current?: CapturedHostAuthority },
	goalProjection: ReturnType<typeof createGoalProjection>,
	factoryMutationProbe?: FactoryMutationProbe,
	approvalProofHolder?: { current?: DurableApprovalSecretProof },
): Promise<PersistedSessionWorkflowHost> {
	return createPersistedSessionWorkflowHost({
		artifactRoot,
		rootSessionId: ROOT_SESSION_ID,
		workflowId: WORKFLOW_ID,
		genesisEpoch: GENESIS_EPOCH,
		writerIdentity: "principal-authority-writer",
		processIdentity: "principal-authority-process",
		now: () => NOW,
		goalProjection,
		...(approvalProofHolder === undefined
			? {}
			: {
					approvalSecretDelivery: ({
						proofs,
					}: {
						proofs: Readonly<Record<string, DurableApprovalSecretProof>>;
					}) => {
						approvalProofHolder.current = proofs.approve;
					},
				}),
		completionReadinessAuthorityFactory: ({ runtimeStore, receiptContext, issueReceipt }) => {
			if (factoryMutationProbe !== undefined) {
				const originalPrincipalAuthorizer = receiptContext.principalAuthorizer;
				try {
					Object.assign(receiptContext, {
						principalAuthorizer: Object.freeze({
							authorize: async () => {
								throw new Error("injected principal authorizer");
							},
						}),
					});
				} catch {
					factoryMutationProbe.mutationRejected.value = true;
				}
				factoryMutationProbe.replacementAccepted.value =
					receiptContext.principalAuthorizer !== originalPrincipalAuthorizer;
				if (factoryMutationProbe.replacementAccepted.value)
					Object.assign(receiptContext, { principalAuthorizer: originalPrincipalAuthorizer });
			}
			captured.current = { runtimeStore, receiptContext, issueReceipt };
			return { runtimeStore, authority: unusedReadinessAuthority() };
		},
	});
}

async function currentHostTuple(runtimeStore: WorkflowRuntimeStore): Promise<{
	epochRef: WorkflowEpochRef;
	head: WorkflowJournalHead;
	stateDigest: string;
	revision: number;
	executionIdentity: string;
}> {
	const durable = runtimeStore.durableContext;
	if (durable === undefined) throw new Error("principal authority test requires a durable runtime");
	const replay = await runtimeStore.replay({
		workflowId: WORKFLOW_ID,
		fromSequence: 0,
		expectedStoreEpoch: durable.epochRef.storeEpoch,
	});
	if (replay.quarantined || replay.head.eventDigest === null || replay.head.sequence < 1)
		throw new Error("principal authority test requires an authenticated workflow head");
	return {
		epochRef: durable.epochRef,
		head: replay.head,
		stateDigest: replay.head.eventDigest,
		revision: replay.head.sequence,
		executionIdentity: durable.currentLeaseRef().processIdentity,
	};
}

function principalAuthorizer(context: WorkflowHostReceiptConsumerContext): HostPrincipalCapabilityAuthorizer {
	const candidate = Reflect.get(context, "principalAuthorizer");
	if (typeof candidate !== "object" || candidate === null) {
		throw new Error("RED: persisted receipt context has no typed principal capability authorizer");
	}
	const authorize = Reflect.get(candidate, "authorize");
	if (typeof authorize !== "function") {
		throw new Error("RED: persisted principal capability authorizer has no authorize operation");
	}
	return candidate as HostPrincipalCapabilityAuthorizer;
}

async function createFixture(
	factoryMutationProbe?: FactoryMutationProbe,
	approveStart = false,
): Promise<{
	root: string;
	host: PersistedSessionWorkflowHost;
	captured: CapturedHostAuthority;
	current: Awaited<ReturnType<typeof currentHostTuple>>;
	receipt: WorkflowVerifiedHostReceipt;
	bindingDigest: string;
	resourceDigest: string;
	operationDigest: string;
	goalProjection: ReturnType<typeof createGoalProjection>;
}> {
	const root = await mkdtemp(join(tmpdir(), "workflow-host-principal-authority-"));
	const capturedHolder: { current?: CapturedHostAuthority } = {};
	const goalProjection = createGoalProjection();
	const approvalProofHolder: { current?: DurableApprovalSecretProof } | undefined = approveStart ? {} : undefined;
	const host = await openHost(root, capturedHolder, goalProjection, factoryMutationProbe, approvalProofHolder);
	const started = await host.execute({
		kind: "start",
		request: { workflowId: WORKFLOW_ID, objective: "authorize persisted host receipt" },
	});
	if (approvalProofHolder !== undefined) {
		const approvalRequest = started.approvalRequest;
		const proof = approvalProofHolder.current;
		const approveOption = approvalRequest?.options.find((option) => option.optionId === "approve");
		if (
			approvalRequest === null ||
			approvalRequest === undefined ||
			proof === undefined ||
			approveOption === undefined
		)
			throw new Error("principal authority test approval proof was not delivered");
		await host.execute({
			kind: "respond",
			approvalRequestId: approvalRequest.approvalRequestId,
			optionId: approveOption.optionId,
			proof,
		});
	}
	const captured = capturedHolder.current;
	if (captured === undefined) throw new Error("persisted receipt authority was not captured");
	const current = await currentHostTuple(captured.runtimeStore);
	const resourceDigest = digestObject({ resource: "principal-authority-resource", workflowId: WORKFLOW_ID });
	const operationDigest = digestObject({ operation: "principal-authority-operation", resourceDigest });
	const bindingDigest = digestObject({
		workflowId: WORKFLOW_ID,
		resourceDigest,
		operationDigest,
		epochRef: current.epochRef,
		head: current.head,
		stateDigest: current.stateDigest,
		revision: current.revision,
	});
	const receipt = await captured.issueReceipt({
		receiptKind: "capability",
		workflowId: WORKFLOW_ID,
		bindingDigest,
		capability: "workflow_intent_red_mutation",
		resourceDigest,
		operationDigest,
		executionIdentity: current.executionIdentity,
		sessionId: ROOT_SESSION_ID,
		receiptId: "principal-authority-receipt",
		oneUse: true,
		issuedAt: NOW,
		stateDigest: current.stateDigest,
		revision: current.revision,
	});
	return {
		root,
		host,
		captured,
		current,
		receipt,
		bindingDigest,
		resourceDigest,
		operationDigest,
		goalProjection,
	};
}

function validAuthorizationInput(
	fixture: Awaited<ReturnType<typeof createFixture>>,
): HostPrincipalCapabilityAuthorizationInput {
	return {
		receipt: fixture.receipt,
		workflowId: WORKFLOW_ID,
		bindingDigest: fixture.bindingDigest,
		resourceDigest: fixture.resourceDigest,
		operationDigest: fixture.operationDigest,
		stateDigest: fixture.current.stateDigest,
		revision: fixture.current.revision,
		epochRef: fixture.current.epochRef,
		capability: "workflow_intent_red_mutation",
		executionIdentity: fixture.current.executionIdentity,
		sessionId: ROOT_SESSION_ID,
	};
}

async function verifyReceipt(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	receipt: WorkflowVerifiedHostReceipt = fixture.receipt,
): Promise<WorkflowVerifiedHostReceipt> {
	return resolveAndVerifyWorkflowHostReceipt({
		context: fixture.captured.receiptContext,
		workflowId: WORKFLOW_ID,
		expectedBindingDigest: fixture.bindingDigest,
		receipt,
		currentStateDigest: fixture.current.stateDigest,
		currentRevision: fixture.current.revision,
		trustedNow: NOW,
	});
}

describe("persisted host principal/capability authority", () => {
	it("RED: exposes one typed authorizer instead of caller issuer authority", async () => {
		const fixture = await createFixture();
		try {
			const authorizer = principalAuthorizer(fixture.captured.receiptContext);
			const decision = await authorizer.authorize(validAuthorizationInput(fixture));
			expect(decision.authenticatedPrincipal).toBe("workflow-host");
			expect(decision.keyOwnerPrincipal).toBe("workflow-host");
			expect(decision.capability).toBe("workflow_intent_red_mutation");
			expect(decision.workflowId).toBe(WORKFLOW_ID);
			expect(decision.receipt.receiptId).toBe(fixture.receipt.receiptId);
			expect(decision.stateDigest).toBe(fixture.current.stateDigest);
			expect(decision.revision).toBe(fixture.current.revision);
			expect(decision.epochRef).toEqual(fixture.current.epochRef);
			expect(decision.validity).toEqual({ issuedAt: NOW, validUntil: fixture.receipt.validUntil });
			expect(decision.authorizationDigest).toMatch(/^[0-9a-f]{64}$/u);
		} finally {
			await fixture.host.dispose?.();
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("RED: rejects issuer, capability, workflow, freshness, and execution/session substitution", async () => {
		const fixture = await createFixture();
		try {
			const authorizer = principalAuthorizer(fixture.captured.receiptContext);
			const verified = await verifyReceipt(fixture);
			const valid = validAuthorizationInput(fixture);
			await expect(
				authorizer.authorize({ ...valid, receipt: { ...verified, issuerId: "caller-forged" } }),
			).rejects.toThrow();
			await expect(authorizer.authorize({ ...valid, capability: "child_output_delivery_ack" })).rejects.toThrow();
			await expect(authorizer.authorize({ ...valid, workflowId: "foreign-workflow" })).rejects.toThrow();
			await expect(
				authorizer.authorize({
					...valid,
					epochRef: { ...valid.epochRef, coordinatorEpoch: valid.epochRef.coordinatorEpoch + 1 },
				}),
			).rejects.toThrow();
			await expect(authorizer.authorize({ ...valid, stateDigest: "f".repeat(64) })).rejects.toThrow();
			await expect(authorizer.authorize({ ...valid, revision: valid.revision + 1 })).rejects.toThrow();
			await expect(authorizer.authorize({ ...valid, executionIdentity: "foreign-execution" })).rejects.toThrow();
			await expect(authorizer.authorize({ ...valid, sessionId: "foreign-session" })).rejects.toThrow();
			await expect(verifyReceipt(fixture, { ...verified, issuedAt: "not-a-date" })).rejects.toThrow();
			await expect(
				authorizer.authorize({ ...valid, receipt: { ...verified, keyId: "forged-key-owner" } }),
			).rejects.toThrow();
			const revokedReceiptIds = fixture.captured.receiptContext.revokedReceiptIds as Set<string>;
			revokedReceiptIds.add(verified.receiptId);
			await expect(authorizer.authorize(valid)).rejects.toThrow();
			revokedReceiptIds.delete(verified.receiptId);
		} finally {
			await fixture.host.dispose?.();
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("RED: rejects a structurally valid key-signed receipt with a caller-forged issuer", async () => {
		const context = createFixtureHostReceiptConsumerContext();
		const workflowId = "fixture-principal-authority-workflow";
		const bindingDigest = "1".repeat(64);
		const resourceDigest = "2".repeat(64);
		const operationDigest = "3".repeat(64);
		const receipt = createFixtureHostReceipt({
			receiptKind: "capability",
			receiptId: "fixture-forged-issuer",
			issuerId: "caller-forged",
			workflowId,
			bindingDigest,
			payloadDigest: "4".repeat(64),
			artifactRef: {
				artifactId: "fixture-forged-issuer-artifact",
				relativePath: "artifacts/fixture-forged-issuer.json",
				digest: "5".repeat(64),
				sizeBytes: 0,
				sourceEventSequence: 1,
			},
			issuedAt: NOW,
			validUntil: "2026-08-17T17:00:00.000Z",
			keyId: "fixture-receipt-key",
			stateDigest: "fixture-state",
			revision: 1,
			capabilityBinding: {
				capability: "workflow_intent_red_mutation",
				resourceDigest,
				operationDigest,
				executionIdentity: null,
				sessionId: null,
			},
		});
		await expect(
			context.principalAuthorizer.authorize({
				receipt,
				workflowId,
				bindingDigest,
				resourceDigest,
				operationDigest,
				stateDigest: "fixture-state",
				revision: 1,
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				capability: "workflow_intent_red_mutation",
			}),
		).rejects.toThrow();
	});

	it("RED: authorizes frontier admission and projection commit only as signed capabilities", async () => {
		const fixture = await createFixture();
		try {
			const authorizer = principalAuthorizer(fixture.captured.receiptContext);
			const capabilities = [
				"autoresearch_portfolio_frontier_admission",
				"autoresearch_portfolio_projection_commit",
				"workflow_worker_model_dispatch",
			] as const;
			for (const capability of capabilities) {
				const resourceDigest = digestObject({ resource: capability, workflowId: WORKFLOW_ID });
				const operationDigest = digestObject({ operation: capability, resourceDigest });
				const bindingDigest = digestObject({
					workflowId: WORKFLOW_ID,
					capability,
					resourceDigest,
					operationDigest,
					epochRef: fixture.current.epochRef,
					head: fixture.current.head,
					stateDigest: fixture.current.stateDigest,
					revision: fixture.current.revision,
				});
				const receipt = await fixture.captured.issueReceipt({
					receiptKind: "capability",
					workflowId: WORKFLOW_ID,
					bindingDigest,
					capability,
					resourceDigest,
					operationDigest,
					executionIdentity: fixture.current.executionIdentity,
					sessionId: ROOT_SESSION_ID,
					receiptId: `${capability}-receipt`,
					oneUse: true,
					issuedAt: NOW,
					stateDigest: fixture.current.stateDigest,
					revision: fixture.current.revision,
				});
				const authorization = {
					receipt,
					workflowId: WORKFLOW_ID,
					bindingDigest,
					resourceDigest,
					operationDigest,
					stateDigest: fixture.current.stateDigest,
					revision: fixture.current.revision,
					epochRef: fixture.current.epochRef,
					capability,
					executionIdentity: fixture.current.executionIdentity,
					sessionId: ROOT_SESSION_ID,
				};
				await expect(authorizer.authorize(authorization)).resolves.toMatchObject({ capability });
				const substitutedCapability =
					capability === "autoresearch_portfolio_frontier_admission"
						? "autoresearch_portfolio_projection_commit"
						: "autoresearch_portfolio_frontier_admission";
				await expect(
					authorizer.authorize({ ...authorization, capability: substitutedCapability }),
				).rejects.toThrow();
			}
			const artifactReceipt = await fixture.captured.issueReceipt({
				receiptKind: "artifact",
				workflowId: WORKFLOW_ID,
				bindingDigest: fixture.bindingDigest,
				capability: "workflow_intent_red_mutation",
				resourceDigest: fixture.resourceDigest,
				operationDigest: fixture.operationDigest,
				executionIdentity: fixture.current.executionIdentity,
				sessionId: ROOT_SESSION_ID,
				receiptId: "artifact-kind-capability-receipt",
				oneUse: true,
				issuedAt: NOW,
				stateDigest: fixture.current.stateDigest,
				revision: fixture.current.revision,
			});
			await expect(
				authorizer.authorize({ ...validAuthorizationInput(fixture), receipt: artifactReceipt }),
			).rejects.toThrow();
			await expect(
				fixture.captured.issueReceipt({
					receiptKind: "capability",
					workflowId: WORKFLOW_ID,
					bindingDigest: "invalid-binding-digest",
					capability: "workflow_intent_red_mutation",
					resourceDigest: fixture.resourceDigest,
					operationDigest: fixture.operationDigest,
					receiptId: "invalid-binding-receipt",
					oneUse: true,
					issuedAt: NOW,
					stateDigest: fixture.current.stateDigest,
					revision: fixture.current.revision,
				}),
			).rejects.toThrow();
			await expect(
				fixture.captured.issueReceipt({
					receiptKind: "capability",
					workflowId: WORKFLOW_ID,
					bindingDigest: digestObject({ duplicate: "different-operation" }),
					capability: "workflow_intent_red_mutation",
					resourceDigest: fixture.resourceDigest,
					operationDigest: digestObject({ duplicate: "different-operation", fixture: fixture.operationDigest }),
					receiptId: fixture.receipt.receiptId,
					oneUse: true,
					issuedAt: NOW,
					stateDigest: fixture.current.stateDigest,
					revision: fixture.current.revision,
				}),
			).rejects.toThrow();
			await expect(
				fixture.captured.issueReceipt({
					receiptKind: "capability",
					issuerId: "caller-forged",
					workflowId: WORKFLOW_ID,
					bindingDigest: fixture.bindingDigest,
					capability: "workflow_intent_red_mutation",
					resourceDigest: fixture.resourceDigest,
					operationDigest: fixture.operationDigest,
					receiptId: "caller-forged-issuer-input",
					oneUse: true,
					issuedAt: NOW,
					stateDigest: fixture.current.stateDigest,
					revision: fixture.current.revision,
				} as never),
			).rejects.toThrow(/host-derived|issuer/i);
		} finally {
			await fixture.host.dispose?.();
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("RED: blocks public reserved auxiliary attacks and factory authority replacement across reopen", async () => {
		const factoryMutationProbe: FactoryMutationProbe = {
			replacementAccepted: { value: false },
			mutationRejected: { value: false },
		};
		const fixture = await createFixture(factoryMutationProbe);
		try {
			const durable = fixture.captured.runtimeStore.durableContext;
			if (durable === undefined) throw new Error("principal authority test requires a durable context");
			const keyRecordName = `workflow-host-receipt-key.json.${durable.generationId}`;
			const witnessRecordName = `workflow-host-receipt-consumptions.json.${durable.generationId}`;
			await expect(durable.auxiliaryStore.read(keyRecordName)).rejects.toThrow(/reserved/i);
			await expect(durable.auxiliaryStore.write(keyRecordName, Uint8Array.from([1, 2, 3]))).rejects.toThrow(
				/reserved/i,
			);
			expect(factoryMutationProbe.replacementAccepted.value).toBe(false);
			expect(factoryMutationProbe.mutationRejected.value).toBe(true);

			const verified = await verifyReceipt(fixture);
			await fixture.captured.receiptContext.receiptResolver.consumeIfOneUse({
				receipt: verified,
				workflowId: WORKFLOW_ID,
				expectedBindingDigest: fixture.bindingDigest,
				currentRevision: fixture.current.revision,
			});
			const witness = await fixture.captured.receiptContext.receiptResolver.resolveConsumptionWitness({
				receiptId: verified.receiptId,
				workflowId: WORKFLOW_ID,
				expectedBindingDigest: fixture.bindingDigest,
			});
			expect(witness.capability).toBe("workflow_intent_red_mutation");
			expect(witness.resourceDigest).toBe(fixture.resourceDigest);
			expect(witness.operationDigest).toBe(fixture.operationDigest);
			expect(witness.receiptDigest).toBe(digestObject(verified));
			await expect(durable.auxiliaryStore.read(witnessRecordName)).rejects.toThrow(/reserved/i);
			await expect(durable.auxiliaryStore.write(witnessRecordName, new Uint8Array())).rejects.toThrow(/reserved/i);
		} finally {
			await fixture.host.dispose?.();
		}

		const reopenedHolder: { current?: CapturedHostAuthority } = {};
		const reopened = await openHost(fixture.root, reopenedHolder, fixture.goalProjection);
		try {
			const reopenedCaptured = reopenedHolder.current;
			if (reopenedCaptured === undefined) throw new Error("reopened receipt authority was not captured");
			const reopenedCurrent = await currentHostTuple(reopenedCaptured.runtimeStore);
			const reopenedAuthorizer = principalAuthorizer(reopenedCaptured.receiptContext);
			await expect(
				reopenedAuthorizer.authorize({
					...validAuthorizationInput({ ...fixture, captured: reopenedCaptured, current: reopenedCurrent }),
				}),
			).resolves.toMatchObject({ receipt: { receiptId: fixture.receipt.receiptId } });
			await expect(
				reopenedCaptured.receiptContext.receiptResolver.resolveConsumptionWitness({
					receiptId: fixture.receipt.receiptId,
					workflowId: WORKFLOW_ID,
					expectedBindingDigest: fixture.bindingDigest,
				}),
			).resolves.toMatchObject({ receiptId: fixture.receipt.receiptId });
		} finally {
			await reopened.dispose?.();
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("RED: rejects stale consumption after the authenticated journal head advances", async () => {
		const fixture = await createFixture(undefined, true);
		try {
			const verified = await verifyReceipt(fixture);
			await fixture.host.execute({ kind: "pause", reason: "advance the authenticated journal head" });
			await expect(
				fixture.captured.receiptContext.receiptResolver.consumeIfOneUse({
					receipt: verified,
					workflowId: WORKFLOW_ID,
					expectedBindingDigest: fixture.bindingDigest,
					currentRevision: fixture.current.revision,
				}),
			).rejects.toThrow();
			await expect(
				fixture.captured.receiptContext.receiptResolver.resolveConsumptionWitness({
					receiptId: verified.receiptId,
					workflowId: WORKFLOW_ID,
					expectedBindingDigest: fixture.bindingDigest,
				}),
			).rejects.toThrow();
		} finally {
			await fixture.host.dispose?.();
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("RED: keeps receipt revocation durable across reopen", async () => {
		const fixture = await createFixture();
		try {
			(fixture.captured.receiptContext.revokedReceiptIds as Set<string>).add(fixture.receipt.receiptId);
			await expect(
				principalAuthorizer(fixture.captured.receiptContext).authorize(validAuthorizationInput(fixture)),
			).rejects.toThrow();
			const artifact = await fixture.captured.receiptContext.artifactResolver.resolve(fixture.receipt.artifactRef);
			if (!artifact.exists) throw new Error("revocation test receipt artifact is missing");
			await expect(
				fixture.captured.receiptContext.receiptResolver.resolve({
					receipt: fixture.receipt,
					workflowId: WORKFLOW_ID,
					expectedBindingDigest: fixture.bindingDigest,
					artifactBytes: artifact.bytes,
					currentStateDigest: fixture.current.stateDigest,
					currentRevision: fixture.current.revision,
					trustedNow: NOW,
					keyResolver: fixture.captured.receiptContext.keyResolver,
					revokedReceiptIds: new Set(),
				}),
			).rejects.toThrow(/revocation/i);
		} finally {
			await fixture.host.dispose?.();
		}
		const reopenedHolder: { current?: CapturedHostAuthority } = {};
		const reopened = await openHost(fixture.root, reopenedHolder, fixture.goalProjection);
		try {
			const reopenedCaptured = reopenedHolder.current;
			if (reopenedCaptured === undefined) throw new Error("reopened receipt authority was not captured");
			const reopenedCurrent = await currentHostTuple(reopenedCaptured.runtimeStore);
			await expect(
				principalAuthorizer(reopenedCaptured.receiptContext).authorize({
					...validAuthorizationInput({ ...fixture, captured: reopenedCaptured, current: reopenedCurrent }),
				}),
			).rejects.toThrow();
		} finally {
			await reopened.dispose?.();
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("RED: keeps authorization separate from durable one-use consumption across reopen", async () => {
		const fixture = await createFixture();
		try {
			const authorizer = principalAuthorizer(fixture.captured.receiptContext);
			const verified = await verifyReceipt(fixture);
			const decision = await authorizer.authorize({ ...validAuthorizationInput(fixture), receipt: verified });
			await expect(
				fixture.captured.receiptContext.receiptResolver.resolveConsumptionWitness({
					receiptId: verified.receiptId,
					workflowId: WORKFLOW_ID,
					expectedBindingDigest: fixture.bindingDigest,
				}),
			).rejects.toThrow();
			await fixture.captured.receiptContext.receiptResolver.consumeIfOneUse({
				receipt: verified,
				workflowId: WORKFLOW_ID,
				expectedBindingDigest: fixture.bindingDigest,
				currentRevision: fixture.current.revision,
			});
			await fixture.captured.receiptContext.receiptResolver.consumeIfOneUse({
				receipt: verified,
				workflowId: WORKFLOW_ID,
				expectedBindingDigest: fixture.bindingDigest,
				currentRevision: fixture.current.revision,
			});
			const witness = await fixture.captured.receiptContext.receiptResolver.resolveConsumptionWitness({
				receiptId: verified.receiptId,
				workflowId: WORKFLOW_ID,
				expectedBindingDigest: fixture.bindingDigest,
			});
			expect(witness.receiptId).toBe(verified.receiptId);
			expect(witness.consumptionSequence).toBe(1);
			expect(decision.authorizationDigest).not.toBe("");

			await fixture.host.dispose?.();
			const reopenedHolder: { current?: CapturedHostAuthority } = {};
			const reopened = await openHost(fixture.root, reopenedHolder, fixture.goalProjection);
			try {
				const reopenedCaptured = reopenedHolder.current;
				if (reopenedCaptured === undefined) throw new Error("reopened receipt authority was not captured");
				const reopenedCurrent = await currentHostTuple(reopenedCaptured.runtimeStore);
				const reopenedAuthorizer = principalAuthorizer(reopenedCaptured.receiptContext);
				const reopenedDecision = await reopenedAuthorizer.authorize({
					...validAuthorizationInput({ ...fixture, captured: reopenedCaptured, current: reopenedCurrent }),
				});
				expect(reopenedDecision.authorizationDigest).toBe(decision.authorizationDigest);
				await expect(
					reopenedCaptured.receiptContext.receiptResolver.resolveConsumptionWitness({
						receiptId: verified.receiptId,
						workflowId: WORKFLOW_ID,
						expectedBindingDigest: fixture.bindingDigest,
					}),
				).resolves.toMatchObject({ receiptId: verified.receiptId, workflowId: WORKFLOW_ID });
			} finally {
				await reopened.dispose?.();
			}
		} finally {
			await fixture.host.dispose?.();
			await rm(fixture.root, { recursive: true, force: true });
		}
	});
});
