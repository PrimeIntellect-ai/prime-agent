import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import type {
	WorkflowEpochRef,
	WorkflowHostPrincipalCapabilityAuthorization,
	WorkflowHostPrincipalCapabilityAuthorizationInput,
	WorkflowHostPrincipalCapabilityAuthorizer,
	WorkflowHostReceiptCapability,
	WorkflowHostReceiptConsumerContext,
	WorkflowRuntimeStore,
	WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import { digestObject } from "../src/core/workflow/contracts.js";
import {
	type CoordinatorStatusInput,
	type CoordinatorStatusPendingDecision,
	coordinatorStatusPendingDecisionBindingDigest,
	createCoordinatorStatusProjector,
	projectCoordinatorStatus,
} from "../src/core/workflow/coordinator-status.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
	type PersistedWorkflowCompletionReadinessAuthority,
	type PersistedWorkflowCompletionReceiptIssuer,
} from "../src/core/workflow/session-host-factory.js";

const RUNTIME_VERSION = "0.147.0-alpha.10";

type CurrentBinding = {
	readonly workflowId: string;
	readonly journalHeadDigest: string;
	readonly storeEpoch: number;
	readonly coordinatorEpoch: number;
	readonly revision: number;
	readonly sourceEventSequence: number;
	readonly sourceEventTime: string;
	readonly trustedNow: string;
	readonly generation: number;
	readonly fenceToken: string;
};

const CURRENT: CurrentBinding = {
	workflowId: "workflow-1",
	journalHeadDigest: "head-1",
	storeEpoch: 7,
	coordinatorEpoch: 11,
	revision: 42,
	sourceEventSequence: 99,
	sourceEventTime: "2026-08-17T15:00:00.000Z",
	trustedNow: "2026-08-17T15:01:00.000Z",
	generation: 5,
	fenceToken: "fence-5",
};

type PayloadParts = {
	scheduler?: Record<string, unknown>;
	children?: Record<string, unknown>;
};

function payload(parts: PayloadParts = {}): Record<string, unknown> {
	return {
		scheduler: {
			activeWorkerIds: [],
			readyTaskIds: [],
			pendingMessageIds: [],
			scheduledWakeAt: null,
			authenticatedCapacity: 2,
			rawCapacity: 2,
			blockingReasons: [],
			...parts.scheduler,
		},
		children: {
			obligations: [],
			...parts.children,
		},
	};
}

function evidence(
	payloadValue: Record<string, unknown> = payload(),
	current: CurrentBinding = CURRENT,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		payload: payloadValue,
		payloadDigest: digestObject(payloadValue),
		workflowId: current.workflowId,
		journalHeadDigest: current.journalHeadDigest,
		storeEpoch: current.storeEpoch,
		coordinatorEpoch: current.coordinatorEpoch,
		revision: current.revision,
		sourceEventSequence: current.sourceEventSequence,
		sourceEventTime: current.sourceEventTime,
		generation: current.generation,
		fenceToken: current.fenceToken,
		...overrides,
	};
}

function snapshot(
	payloadValue: Record<string, unknown> = payload(),
	current: CurrentBinding = CURRENT,
): Record<string, unknown> {
	return { current, evidence: evidence(payloadValue, current) };
}

const PENDING_DECISION_CAPABILITY: WorkflowHostReceiptCapability = "workflow_coordinator_status_projection";

const PERSISTED_WORKFLOW_ID = "workflow-coordinator-status-authority";
const PERSISTED_ROOT_SESSION_ID = "session-coordinator-status-authority";
const PERSISTED_NOW = "2026-08-17T16:00:00.000Z";
const PERSISTED_GENESIS_EPOCH: WorkflowEpochRef = { storeEpoch: 3, coordinatorEpoch: 4 };

interface CapturedPersistedStatusAuthority {
	runtimeStore: WorkflowRuntimeStore;
	receiptContext: WorkflowHostReceiptConsumerContext;
	issueReceipt: PersistedWorkflowCompletionReceiptIssuer;
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
		throw new Error("unused completion readiness authority in coordinator status integration test");
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

async function openPersistedStatusHost(
	artifactRoot: string,
	capturedHolder: { current?: CapturedPersistedStatusAuthority },
	goalProjection: ReturnType<typeof createGoalProjection>,
): Promise<PersistedSessionWorkflowHost> {
	return createPersistedSessionWorkflowHost({
		artifactRoot,
		rootSessionId: PERSISTED_ROOT_SESSION_ID,
		workflowId: PERSISTED_WORKFLOW_ID,
		genesisEpoch: PERSISTED_GENESIS_EPOCH,
		writerIdentity: "coordinator-status-writer",
		processIdentity: "coordinator-status-process",
		now: () => PERSISTED_NOW,
		goalProjection,
		completionReadinessAuthorityFactory: ({ runtimeStore, receiptContext, issueReceipt }) => {
			capturedHolder.current = { runtimeStore, receiptContext, issueReceipt };
			return { runtimeStore, authority: unusedReadinessAuthority() };
		},
	});
}

async function readPersistedStatusBinding(
	runtimeStore: WorkflowRuntimeStore,
): Promise<{ current: CurrentBinding; executionIdentity: string }> {
	const durable = runtimeStore.durableContext;
	if (durable === undefined) throw new Error("coordinator status integration requires durable runtime");
	const replay = await runtimeStore.replay({
		workflowId: PERSISTED_WORKFLOW_ID,
		fromSequence: 0,
		expectedStoreEpoch: durable.epochRef.storeEpoch,
	});
	if (replay.quarantined || replay.head.eventDigest === null || replay.head.sequence < 1) {
		throw new Error("coordinator status integration requires authenticated workflow head");
	}
	const generation = Math.max(1, Number.parseInt(durable.generationId.slice(-12), 16));
	const fenceToken = digestObject({ generationId: durable.generationId, epochRef: durable.epochRef });
	return {
		current: {
			workflowId: PERSISTED_WORKFLOW_ID,
			journalHeadDigest: replay.head.eventDigest,
			storeEpoch: durable.epochRef.storeEpoch,
			coordinatorEpoch: durable.epochRef.coordinatorEpoch,
			revision: replay.head.sequence,
			sourceEventSequence: replay.head.sequence,
			sourceEventTime: PERSISTED_NOW,
			trustedNow: PERSISTED_NOW,
			generation,
			fenceToken,
		},
		executionIdentity: durable.currentLeaseRef().processIdentity,
	};
}

function pendingDecisionEvidence(
	current: CurrentBinding = CURRENT,
	payloadValue: Record<string, unknown> = payload(),
	decisionId = "approval-1",
): Record<string, unknown> {
	const payloadDigest = digestObject(payloadValue);
	const registryMembershipDigest = digestObject({
		workflowId: current.workflowId,
		journalHeadDigest: current.journalHeadDigest,
		revision: current.revision,
		decisionId,
	});
	const decisionDigest = digestObject({
		workflowId: current.workflowId,
		decisionId,
		registryMembershipDigest,
	});
	const receipt: WorkflowVerifiedHostReceipt = {
		receiptKind: "capability",
		oneUse: false,
		receiptId: `receipt:${decisionId}`,
		issuerId: "workflow-host",
		workflowId: current.workflowId,
		bindingDigest: coordinatorStatusPendingDecisionBindingDigest({
			current,
			payloadDigest,
			registryMembershipDigest,
			decisionId,
			decisionDigest,
		}),
		payloadDigest,
		artifactRef: {
			artifactId: `artifact:${decisionId}`,
			relativePath: `receipts/${decisionId}.json`,
			digest: "a".repeat(64),
			sizeBytes: 1,
			sourceEventSequence: current.sourceEventSequence,
		},
		issuedAt: current.sourceEventTime,
		validUntil: current.trustedNow,
		keyId: "workflow-host-ed25519",
		signatureAlgorithm: "ed25519",
		artifactBytesDigest: "b".repeat(64),
		stateDigest: current.journalHeadDigest,
		revision: current.revision,
		capabilityBinding: {
			capability: PENDING_DECISION_CAPABILITY,
			resourceDigest: registryMembershipDigest,
			operationDigest: decisionDigest,
			executionIdentity: null,
			sessionId: null,
		},
		signature: "host-signature",
		verificationDigest: "c".repeat(64),
	};
	return {
		registryMembershipDigest,
		decisionId,
		decisionDigest,
		capability: PENDING_DECISION_CAPABILITY,
		receipt,
	};
}

function input(
	options: {
		runtimeVersion?: string;
		current?: unknown;
		evidence?: unknown;
		snapshot?: unknown;
		decision?: unknown;
		readAtomicSnapshot?: () => Promise<unknown>;
		assertCurrent?: (current: unknown, payloadDigest: unknown) => Promise<unknown>;
		resolvePendingDecision?: (current: unknown, payloadDigest: unknown) => Promise<unknown>;
		authorizePendingDecision?: (
			request: WorkflowHostPrincipalCapabilityAuthorizationInput,
		) => Promise<WorkflowHostPrincipalCapabilityAuthorization>;
		authorizationRequest?: (request: WorkflowHostPrincipalCapabilityAuthorizationInput) => void;
		authorizationDigest?: string;
	} = {},
): CoordinatorStatusInput {
	const current = options.current ?? CURRENT;
	const resolvedSnapshot = options.snapshot ?? {
		current,
		evidence: options.evidence ?? evidence(payload(), current as CurrentBinding),
	};
	const defaultAuthorization: WorkflowHostPrincipalCapabilityAuthorizer = {
		authorize: async (request) => {
			options.authorizationRequest?.(request);
			return options.authorizePendingDecision === undefined
				? {
						authenticatedPrincipal: "workflow-host",
						keyOwnerPrincipal: "workflow-host",
						capability: request.capability,
						workflowId: request.workflowId,
						bindingDigest: request.bindingDigest,
						receipt: request.receipt,
						stateDigest: request.stateDigest,
						revision: request.revision,
						epochRef: request.epochRef,
						validity: {
							issuedAt: request.receipt.issuedAt,
							validUntil: request.receipt.validUntil,
						},
						authorizationDigest: options.authorizationDigest ?? "host-issued-opaque-authorization-witness",
					}
				: options.authorizePendingDecision(request);
		},
	};
	return {
		runtimeVersion: options.runtimeVersion ?? RUNTIME_VERSION,
		host: {
			readAtomicSnapshot: async () =>
				options.readAtomicSnapshot === undefined ? resolvedSnapshot : options.readAtomicSnapshot(),
			assertCurrent: async ({
				current: assertedCurrent,
				payloadDigest,
			}: {
				current: unknown;
				payloadDigest: unknown;
			}) =>
				options.assertCurrent === undefined ? undefined : options.assertCurrent(assertedCurrent, payloadDigest),
			resolvePendingDecision: async ({
				current: resolvedCurrent,
				payloadDigest,
			}: {
				current: unknown;
				payloadDigest: unknown;
			}) =>
				options.resolvePendingDecision === undefined
					? (options.decision ?? null)
					: options.resolvePendingDecision(resolvedCurrent, payloadDigest),
			principalAuthorizer: defaultAuthorization,
		},
	} as unknown as CoordinatorStatusInput;
}

describe("coordinator status projection", () => {
	it("projects an active child as waiting_on_children even when its reported label asks for input", async () => {
		const result = await projectCoordinatorStatus(
			input({
				evidence: evidence(
					payload({
						scheduler: { activeWorkerIds: ["child-1"] },
						children: {
							obligations: [{ childId: "child-1", phase: "running", reportedStatus: "needs_input" }],
						},
					}),
				),
			}),
		);

		expect(result).toEqual({
			status: "waiting_on_children",
			activeWorkers: 1,
			eligibleReadyTasks: 0,
			idleCapacity: 1,
			idleReason: "none",
		});
	});

	it("projects ready work as working and ignores inflated raw capacity telemetry", async () => {
		const result = await projectCoordinatorStatus(
			input({
				evidence: evidence(
					payload({
						scheduler: {
							activeWorkerIds: ["child-1"],
							readyTaskIds: ["task-1", "task-2"],
							authenticatedCapacity: 3,
							rawCapacity: 99,
						},
						children: { obligations: [{ childId: "child-1", phase: "running" }] },
					}),
				),
			}),
		);

		expect(result).toEqual({
			status: "working",
			activeWorkers: 1,
			eligibleReadyTasks: 2,
			idleCapacity: 2,
			idleReason: "none",
		});
	});

	it("keeps the projection stable when worker and child evidence is reordered", async () => {
		const result = await projectCoordinatorStatus(
			input({
				evidence: evidence(
					payload({
						scheduler: {
							activeWorkerIds: ["child-a", "child-b"],
							readyTaskIds: ["task-1"],
							authenticatedCapacity: 3,
						},
						children: {
							obligations: [
								{ childId: "child-b", phase: "running" },
								{ childId: "child-a", phase: "starting" },
							],
						},
					}),
				),
			}),
		);

		expect(result).toEqual({
			status: "working",
			activeWorkers: 2,
			eligibleReadyTasks: 1,
			idleCapacity: 1,
			idleReason: "none",
		});
	});

	it("derives needs_input only from a canonical pending-decision authority receipt", async () => {
		const result = await projectCoordinatorStatus(input({ decision: pendingDecisionEvidence() }));

		expect(result).toEqual({
			status: "needs_input",
			activeWorkers: 0,
			eligibleReadyTasks: 0,
			idleCapacity: 2,
			idleReason: "user_decision",
		});
	});

	it("suppresses needs_input while a durable scheduled wake owns continuation", async () => {
		const payloadValue = payload({
			scheduler: {
				scheduledWakeAt: "2026-08-17T15:02:00.000Z",
			},
		});
		const result = await projectCoordinatorStatus(
			input({
				evidence: evidence(payloadValue),
				decision: pendingDecisionEvidence(CURRENT, payloadValue),
			}),
		);

		expect(result).toEqual({
			status: "waiting_on_children",
			activeWorkers: 0,
			eligibleReadyTasks: 0,
			idleCapacity: 2,
			idleReason: "none",
		});
	});

	it("binds decision authority resolution to the consumed evidence digest and current", async () => {
		let decisionRequest: unknown;
		let authorizationRequest: WorkflowHostPrincipalCapabilityAuthorizationInput | undefined;
		const payloadValue = payload();
		const result = await projectCoordinatorStatus(
			input({
				evidence: evidence(payloadValue),
				decision: pendingDecisionEvidence(),
				resolvePendingDecision: async (current, payloadDigest) => {
					decisionRequest = { current, payloadDigest };
					return pendingDecisionEvidence();
				},
				authorizationRequest: (request) => {
					authorizationRequest = request;
				},
			}),
		);

		expect(result.status).toBe("needs_input");
		expect(decisionRequest).toEqual({ current: CURRENT, payloadDigest: digestObject(payloadValue) });
		expect(authorizationRequest).toMatchObject({
			workflowId: CURRENT.workflowId,
			resourceDigest: expect.any(String),
			operationDigest: expect.any(String),
			stateDigest: CURRENT.journalHeadDigest,
			revision: CURRENT.revision,
			epochRef: { storeEpoch: CURRENT.storeEpoch, coordinatorEpoch: CURRENT.coordinatorEpoch },
			capability: PENDING_DECISION_CAPABILITY,
		});
		expect(authorizationRequest?.receipt.payloadDigest).toBe(digestObject(payloadValue));
		expect(authorizationRequest?.receipt.bindingDigest).toBe(authorizationRequest?.bindingDigest);
	});

	it("requires the generic host principal authorizer for pending decisions", async () => {
		const adapter = input({ decision: pendingDecisionEvidence() }).host;
		const result = await projectCoordinatorStatus({
			runtimeVersion: RUNTIME_VERSION,
			host: { ...adapter, principalAuthorizer: undefined },
		} as unknown as CoordinatorStatusInput);

		expect(result).toMatchObject({ status: "blocked", idleReason: "recovery" });
	});

	it("accepts an opaque authorization witness from the typed host authorizer", async () => {
		const result = await projectCoordinatorStatus(input({ decision: pendingDecisionEvidence() }));

		expect(result).toMatchObject({ status: "needs_input", idleReason: "user_decision" });
	});

	it("accepts a pending decision only through the persisted host principal authorizer", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-coordinator-status-authority-"));
		const capturedHolder: { current?: CapturedPersistedStatusAuthority } = {};
		const goalProjection = createGoalProjection();
		const host = await openPersistedStatusHost(root, capturedHolder, goalProjection);
		try {
			await host.execute({
				kind: "start",
				request: { workflowId: PERSISTED_WORKFLOW_ID, objective: "project persisted host decision" },
			});
			const captured = capturedHolder.current;
			if (captured === undefined) throw new Error("persisted status authority was not captured");
			const { current, executionIdentity } = await readPersistedStatusBinding(captured.runtimeStore);
			const payloadValue = payload();
			const payloadDigest = digestObject(payloadValue);
			const decisionId = "persisted-approval-1";
			const registryMembershipDigest = digestObject({
				workflowId: current.workflowId,
				journalHeadDigest: current.journalHeadDigest,
				revision: current.revision,
				decisionId,
			});
			const decisionDigest = digestObject({
				workflowId: current.workflowId,
				decisionId,
				registryMembershipDigest,
			});
			const bindingDigest = coordinatorStatusPendingDecisionBindingDigest({
				current,
				payloadDigest,
				registryMembershipDigest,
				decisionId,
				decisionDigest,
			});
			const receipt = await captured.issueReceipt({
				receiptKind: "capability",
				workflowId: current.workflowId,
				bindingDigest,
				capability: PENDING_DECISION_CAPABILITY,
				resourceDigest: registryMembershipDigest,
				operationDigest: decisionDigest,
				executionIdentity,
				sessionId: PERSISTED_ROOT_SESSION_ID,
				receiptId: "persisted-status-receipt",
				issuedAt: PERSISTED_NOW,
				stateDigest: current.journalHeadDigest,
				revision: current.revision,
				payloadKind: "workflow-resource-loader",
				payloadDigest,
			});
			const decision: CoordinatorStatusPendingDecision = {
				registryMembershipDigest,
				decisionId,
				decisionDigest,
				capability: PENDING_DECISION_CAPABILITY,
				receipt,
			};
			let persistedAuthorizationDigest: string | undefined;
			const result = await projectCoordinatorStatus({
				runtimeVersion: RUNTIME_VERSION,
				host: {
					readAtomicSnapshot: async () => ({ current, evidence: evidence(payloadValue, current) }),
					resolvePendingDecision: async () => decision,
					assertCurrent: async ({ current: assertedCurrent, payloadDigest: assertedPayloadDigest }) => {
						if (assertedPayloadDigest !== payloadDigest) throw new Error("persisted status payload changed");
						const latest = await readPersistedStatusBinding(captured.runtimeStore);
						if (JSON.stringify(latest.current) !== JSON.stringify(assertedCurrent)) {
							throw new Error("persisted status current binding changed");
						}
					},
					principalAuthorizer: {
						authorize: async (request) => {
							const authorization = await captured.receiptContext.principalAuthorizer.authorize(request);
							persistedAuthorizationDigest = authorization.authorizationDigest;
							return authorization;
						},
					},
				},
			});

			expect(result).toEqual({
				status: "needs_input",
				activeWorkers: 0,
				eligibleReadyTasks: 0,
				idleCapacity: 2,
				idleReason: "user_decision",
			});
			expect(persistedAuthorizationDigest).toMatch(/^[0-9a-f]{64}$/u);
		} finally {
			await host.dispose?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not infer needs_input from self-consistent opaque registry strings", async () => {
		const forgedEvidence = {
			...evidence(),
			pendingDecisionRegistryDigest: "registry-forged",
			pendingDecisionId: "approval-forged",
		};
		const result = await projectCoordinatorStatus(
			input({
				evidence: forgedEvidence,
				decision: null,
			}),
		);

		expect(result).toMatchObject({ status: "blocked", idleReason: "recovery" });
	});

	it("uses a scheduler limiter reason when no work is executable", async () => {
		const result = await projectCoordinatorStatus(
			input({ evidence: evidence(payload({ scheduler: { blockingReasons: ["write_conflict"] } })) }),
		);

		expect(result).toMatchObject({ status: "idle", idleReason: "write_conflict" });
	});

	it("fails closed when the host returns a forged canonical payload digest", async () => {
		const result = await projectCoordinatorStatus(
			input({ evidence: evidence(payload(), CURRENT, { payloadDigest: "forged-payload-digest" }) }),
		);

		expect(result).toMatchObject({ status: "blocked", idleReason: "recovery" });
	});

	it("fails closed when evidence is not bound to the current workflow, head, epoch, revision, or source", async () => {
		for (const [field, value] of [
			["workflowId", "workflow-stale"],
			["journalHeadDigest", "head-stale"],
			["storeEpoch", 8],
			["coordinatorEpoch", 12],
			["revision", 41],
			["sourceEventSequence", 98],
			["sourceEventTime", "2026-08-17T14:59:00.000Z"],
			["generation", 4],
			["fenceToken", "fence-4"],
		] as const) {
			const result = await projectCoordinatorStatus(
				input({ evidence: evidence(payload(), CURRENT, { [field]: value }) }),
			);
			expect(result, field).toMatchObject({ status: "blocked", idleReason: "recovery" });
		}
	});

	it("rejects an A-to-B-to-A replay during read-only atomic current assertion", async () => {
		let snapshotReads = 0;
		let assertCalls = 0;
		let assertedCurrent: unknown;
		const stateB = { ...CURRENT, generation: CURRENT.generation + 1, fenceToken: "fence-6" };
		let observedStates: readonly CurrentBinding[] = [];
		const result = await projectCoordinatorStatus(
			input({
				readAtomicSnapshot: async () => {
					snapshotReads += 1;
					return snapshot();
				},
				assertCurrent: async (current) => {
					assertCalls += 1;
					assertedCurrent = current;
					observedStates = [stateB, CURRENT];
					throw new Error("fence_token_stale_after_aba");
				},
			}),
		);

		expect(result).toMatchObject({ status: "blocked", idleReason: "recovery" });
		expect(snapshotReads).toBe(1);
		expect(assertCalls).toBe(1);
		expect(stateB.journalHeadDigest).toBe(CURRENT.journalHeadDigest);
		expect(stateB.revision).toBe(CURRENT.revision);
		expect(observedStates).toEqual([stateB, CURRENT]);
		expect(assertedCurrent).toMatchObject({
			journalHeadDigest: CURRENT.journalHeadDigest,
			revision: CURRENT.revision,
			generation: CURRENT.generation,
			fenceToken: CURRENT.fenceToken,
		});
	});

	it("rejects the legacy mutation-capable fence seam", async () => {
		const adapter = input().host;
		const result = await projectCoordinatorStatus({
			runtimeVersion: RUNTIME_VERSION,
			host: { ...adapter, consumeFenceToken: async () => evidence() },
		} as unknown as CoordinatorStatusInput);

		expect(result).toMatchObject({ status: "blocked", idleReason: "recovery" });
	});

	it("rejects a stale canonical decision authority bound to an older head", async () => {
		const staleCurrent = { ...CURRENT, journalHeadDigest: "head-stale", revision: 41 };
		const result = await projectCoordinatorStatus(
			input({ decision: pendingDecisionEvidence(staleCurrent), current: CURRENT }),
		);

		expect(result).toMatchObject({ status: "blocked", idleReason: "recovery" });
	});

	it("binds pending decisions to generation, fence, and source sequence/time", async () => {
		for (const [field, value] of [
			["generation", 4],
			["fenceToken", "fence-4"],
			["sourceEventSequence", 98],
			["sourceEventTime", "2026-08-17T14:59:00.000Z"],
		] as const) {
			const staleCurrent = { ...CURRENT, [field]: value };
			const result = await projectCoordinatorStatus(
				input({ decision: pendingDecisionEvidence(staleCurrent), current: CURRENT }),
			);
			expect(result, field).toMatchObject({ status: "blocked", idleReason: "recovery" });
		}
	});

	it("fails closed when the read-only current assertion returns false", async () => {
		const result = await projectCoordinatorStatus(input({ assertCurrent: async () => false }));

		expect(result).toMatchObject({ status: "blocked", idleReason: "recovery" });
	});

	it("fails closed on extra declarative flags, caller counts, aliases, nulls, and unknown states", async () => {
		const cases = [
			evidence(payload({ scheduler: { authenticated: true, activeWorkers: 1, capacity: 99 } })),
			evidence(payload({ scheduler: { authenticatedCapacity: null } })),
			evidence(payload({ children: { obligations: [{ childId: "child-1", phase: "mystery" }] } })),
			evidence(
				payload({
					scheduler: { activeWorkerIds: ["child-1", "child-2"] },
					children: {
						obligations: [
							{ childId: "child-1", phase: "running" },
							{ childId: "child-1", phase: "running" },
						],
					},
				}),
			),
		];

		for (const candidate of cases) {
			const result = await projectCoordinatorStatus(input({ evidence: candidate }));
			expect(result).toMatchObject({ status: "blocked", idleReason: "recovery" });
		}
	});

	it("fails closed when the host atomic snapshot rejects", async () => {
		const result = await projectCoordinatorStatus(
			input({
				readAtomicSnapshot: async () => {
					throw new Error("host unavailable");
				},
			}),
		);

		expect(result).toMatchObject({ status: "blocked", idleReason: "recovery" });
	});

	it("gives recovery precedence over active children and pending user decisions", async () => {
		const result = await projectCoordinatorStatus(
			input({
				evidence: evidence(
					payload({
						scheduler: {
							activeWorkerIds: ["child-1"],
							blockingReasons: ["recovery"],
						},
						children: { obligations: [{ childId: "child-1", phase: "running" }] },
					}),
				),
				decision: pendingDecisionEvidence(),
			}),
		);

		expect(result).toMatchObject({ status: "blocked", idleReason: "recovery" });
	});

	it("exposes a factory for task-runtime-owned adapter composition", async () => {
		const adapter = input().host;
		const project = createCoordinatorStatusProjector(adapter);
		const result = await project({ runtimeVersion: RUNTIME_VERSION });

		expect(result).toEqual({
			status: "idle",
			activeWorkers: 0,
			eligibleReadyTasks: 0,
			idleCapacity: 2,
			idleReason: "no_ready_work",
		});
	});

	it("freezes a successful projection", async () => {
		const result = await projectCoordinatorStatus(input());

		expect(Object.isFrozen(result)).toBe(true);
	});

	it("rejects runtime versions older than the workflow authority minimum", async () => {
		await expect(projectCoordinatorStatus(input({ runtimeVersion: "0.147.0-alpha.9" }))).rejects.toThrow(
			"workflow_runtime_version_unsupported",
		);
	});
});
