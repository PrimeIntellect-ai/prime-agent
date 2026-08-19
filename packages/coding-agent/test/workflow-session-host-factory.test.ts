import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it, vi } from "vitest";

import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
} from "../src/core/workflow/contracts.js";
import type { WorkflowGenerationContextOpener } from "../src/core/workflow/journal.js";
import {
	createLocalAppendLease,
	createLocalAppendLeaseProcessIdentity,
} from "../src/core/workflow/local-append-lease.js";
import type { WorkflowCommand, WorkflowPhaseHost } from "../src/core/workflow/phase-host.js";
import { type WorkflowDeferredEventOwnerValidators, WorkflowStore } from "../src/core/workflow/reducer.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHostInput,
	resolvePersistedSessionWorkflowAuthority,
	type WorkflowGoalAuthoritySourceResolver,
} from "../src/core/workflow/session-host-factory.js";

const GENESIS_EPOCH = { storeEpoch: 1, coordinatorEpoch: 1 } as const;

function createDeferredOwnerValidators(): WorkflowDeferredEventOwnerValidators {
	return {
		autoresearch: () => undefined,
		runtime: () => undefined,
		effect: () => undefined,
		recovery: () => undefined,
	};
}

function createGoalProjection(): { read(): GoalState; compareAndSwap(expected: GoalState, next: GoalState): boolean } {
	let goal: GoalState = emptyGoalState();
	return {
		read: (): GoalState => structuredClone(goal),
		compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
}

it("passes deferred owner validators through every production store open", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-validators-"));
	const deferredOwnerValidators = createDeferredOwnerValidators();
	const open = vi.spyOn(WorkflowStore, "open");
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-validators",
			workflowId: "workflow-validators",
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
			deferredOwnerValidators,
		} as PersistedSessionWorkflowHostInput);
		expect(open).toHaveBeenCalled();
		for (const call of open.mock.calls) expect(call[2]).toBe(deferredOwnerValidators);
	} finally {
		await host?.dispose?.();
		open.mockRestore();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("retains the composed runtime-store bridge on the persisted host", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-bridge-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-bridge",
			workflowId: "workflow-bridge",
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		const replay = await host.runtimeStore.replay({
			workflowId: "workflow-bridge",
			fromSequence: 1,
			expectedStoreEpoch: GENESIS_EPOCH.storeEpoch,
		});
		expect(host.runtimeStore.identity).toMatchObject({
			storeKind: "workflow",
			namespace: "session",
			rootDir: artifactRoot,
			storeId: "session-workflow:workflow-bridge",
			workflowId: "workflow-bridge",
		});
		expect(replay.quarantined).toBe(false);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rejects fresh construction when no authenticated genesis epoch is supplied", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-genesis-"));
	try {
		await expect(
			createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "session-genesis",
				workflowId: "workflow-genesis",
				goalProjection: createGoalProjection(),
			}),
		).rejects.toThrow("workflow_genesis_epoch_unavailable");
	} finally {
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("returns no authority for a fresh root instead of fabricating a genesis epoch", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-authority-fresh-"));
	try {
		await expect(
			resolvePersistedSessionWorkflowAuthority({
				artifactRoot,
				rootSessionId: "session-authority-fresh",
				workflowId: "workflow-authority-fresh",
			}),
		).resolves.toBeNull();
	} finally {
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("resolves the exact epoch and writer from authenticated bootstrap state", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-authority-"));
	const workflowId = "workflow-authority";
	const rootSessionId = "session-authority";
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		await host.dispose?.();
		host = undefined;

		await expect(
			resolvePersistedSessionWorkflowAuthority({ artifactRoot, rootSessionId, workflowId }),
		).resolves.toEqual({
			genesisEpoch: GENESIS_EPOCH,
			writerIdentity: `workflow-coordinator:${rootSessionId}:${workflowId}`,
		});
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("returns no authority when the workflow descriptor has no active generation", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-authority-missing-"));
	try {
		await mkdir(join(artifactRoot, "workflows", "workflow-authority-missing"), {
			recursive: true,
			mode: 0o700,
		});
		await expect(
			resolvePersistedSessionWorkflowAuthority({
				artifactRoot,
				rootSessionId: "session-authority-missing",
				workflowId: "workflow-authority-missing",
			}),
		).resolves.toBeNull();
	} finally {
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rejects a foreign authenticated active-generation authority", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-authority-foreign-"));
	const workflowId = "workflow-authority-foreign";
	const rootSessionId = "session-authority-foreign";
	const activePath = join(artifactRoot, "workflows", workflowId, "side-records", "active-generation.json");
	const keyPath = join(artifactRoot, "keyring", "workflows", workflowId, "side-records", "key.json");
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		await host.dispose?.();
		host = undefined;
		const active = requireRecord(parseCanonicalJsonBytes(await readFile(activePath)), "active generation");
		const key = requireRecord(parseCanonicalJsonBytes(await readFile(keyPath)), "workflow key");
		const unsigned = { ...active, workflowId: "foreign-workflow", sideRecordMac: "" };
		await writeFile(
			activePath,
			canonicalJsonBytes({
				...unsigned,
				sideRecordMac: hmacJsonHex(
					Buffer.from(requireString(key.secretBase64, "workflow key secret"), "base64"),
					unsigned,
				),
			}),
		);

		await expect(
			resolvePersistedSessionWorkflowAuthority({ artifactRoot, rootSessionId, workflowId }),
		).rejects.toThrow("workflow_persisted_authority_corrupt");
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rejects a stale authenticated active-generation epoch", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-authority-stale-"));
	const workflowId = "workflow-authority-stale";
	const rootSessionId = "session-authority-stale";
	const activePath = join(artifactRoot, "workflows", workflowId, "side-records", "active-generation.json");
	const keyPath = join(artifactRoot, "keyring", "workflows", workflowId, "side-records", "key.json");
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		await host.dispose?.();
		host = undefined;
		const active = requireRecord(parseCanonicalJsonBytes(await readFile(activePath)), "active generation");
		const key = requireRecord(parseCanonicalJsonBytes(await readFile(keyPath)), "workflow key");
		const epochRef = requireRecord(active.epochRef, "active epoch");
		const unsigned = {
			...active,
			epochRef: {
				...epochRef,
				coordinatorEpoch: (epochRef.coordinatorEpoch as number) + 1,
			},
			sideRecordMac: "",
		};
		await writeFile(
			activePath,
			canonicalJsonBytes({
				...unsigned,
				sideRecordMac: hmacJsonHex(
					Buffer.from(requireString(key.secretBase64, "workflow key secret"), "base64"),
					unsigned,
				),
			}),
		);

		await expect(
			resolvePersistedSessionWorkflowAuthority({ artifactRoot, rootSessionId, workflowId }),
		).rejects.toThrow("workflow_persisted_authority_corrupt");
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("opens one persisted provider-free host and recovers status, objective, and acceptance", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-"));
	let goal: GoalState = emptyGoalState();
	const goalProjection = {
		read: (): GoalState => structuredClone(goal),
		compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
	const successorContextOpener: WorkflowGenerationContextOpener = {
		openSuccessor: async () => {
			throw new Error("successor rotation is not part of this worker-free test");
		},
	};

	try {
		const first = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-1",
			workflowId: "workflow-1",
			goalProjection,
			successorContextOpener,
			genesisEpoch: GENESIS_EPOCH,
		});
		const started = await first.execute({
			kind: "start",
			request: {
				workflowId: "workflow-1",
				objective: "persist the workflow host",
				acceptanceChecks: ["status-recovers"],
				protectedInvariants: ["no-provider"],
			},
		});
		expect(started.status).toBe("awaiting_user");
		expect(started.goal.objective).toBe("persist the workflow host");
		expect(started.acceptanceCheckIds).toEqual(["status-recovers"]);
		expect(started.protectedInvariantIds).toEqual(["no-provider"]);
		await first.dispose?.();

		const reopened = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-1",
			workflowId: "workflow-1",
			goalProjection,
			successorContextOpener,
			genesisEpoch: GENESIS_EPOCH,
		});
		try {
			const status = await reopened.execute({ kind: "status" });
			expect(status.status).toBe("awaiting_user");
			expect(status.goal.objective).toBe("persist the workflow host");
			expect(status.acceptanceCheckIds).toEqual(["status-recovers"]);
			expect(status.protectedInvariantIds).toEqual(["no-provider"]);
		} finally {
			await reopened.dispose?.();
		}
	} finally {
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("persists the exact user-approved causal metrics, guards, non-goals, and budgets across reopen", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-contract-"));
	const goalProjection = createGoalProjection();
	const workflowId = "workflow-goal-contract";
	const rootSessionId = "session-goal-contract";
	const objective = "recover the exact durable goal contract";
	const requestedContract = {
		authoritativeSource: {
			kind: "immutable_object",
			uri: "gs://rl-forex-research-20260615-data/research/modeling-program/v1/documents/sha256=d7250784cf60e8ed51d3c794a61c0d2f3f84717ce990246cbf9bc0e6f6c412b8/rl-forex-non-cheated-q25-modeling-program.md",
			objectGeneration: "1786938985509738",
			objectDigest: "d7250784cf60e8ed51d3c794a61c0d2f3f84717ce990246cbf9bc0e6f6c412b8",
			objectSizeBytes: 44_227,
			parsedObjective: objective,
			boundaryIds: ["no-provider"],
			gateIds: ["status-recovers"],
		},
		successMetrics: [
			{
				metricId: "restart-recovery",
				requirementId: "status-recovers",
				direction: "at_least",
				target: 1,
				tolerance: 0,
				measurement: "fresh_process",
				guardIds: ["no-provider"],
			},
		],
		nonGoalIds: ["test-count-is-not-completion"],
		budgets: {
			tokenLimit: 10_000,
			wallTimeLimitSeconds: 3_600,
			spendLimitMicrounits: 1_000_000,
		},
	};
	let sourceResolutionCount = 0;
	const goalAuthoritySourceResolver: WorkflowGoalAuthoritySourceResolver = {
		resolve: async () => {
			sourceResolutionCount += 1;
			return {
				objectGeneration: "1786938985509738",
				bytes: new Uint8Array(
					await readFile(join(process.cwd(), "../../tmp/rl-forex-non-cheated-q25-modeling-program.md")),
				),
				parsedObjective: objective,
				boundaryIds: ["no-provider"],
				gateIds: ["status-recovers"],
			};
		},
	};
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection,
			genesisEpoch: GENESIS_EPOCH,
			goalAuthoritySourceResolver,
		});
		const command = {
			kind: "start",
			request: {
				workflowId,
				objective,
				acceptanceChecks: ["status-recovers"],
				protectedInvariants: ["no-provider"],
				goalContract: requestedContract,
			},
		} as unknown as WorkflowCommand;
		const started = await host.execute(command);
		const startedContract = started.goalContract;
		expect(startedContract).toMatchObject({
			objective,
			acceptanceCheckIds: ["status-recovers"],
			protectedInvariantIds: ["no-provider"],
			...requestedContract,
			authoritativeSource: {
				...requestedContract.authoritativeSource,
				parsedProgramDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
				sourceBindingDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
			},
			antiGaming: {
				activityDoesNotCount: true,
				testCountsDoNotProveCompletion: true,
				guardFailureBlocksProgress: true,
				metricSelectionFixedAtApproval: true,
			},
		});
		expect(startedContract?.contractDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(started.approvalRequest?.question).toContain("causal metrics");
		const startedReplay = await host.runtimeStore.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: GENESIS_EPOCH.storeEpoch,
		});
		const goalProposal = startedReplay.events.find((event) => event.payload.kind === "goal_contract_proposed");
		expect(goalProposal?.payload).toMatchObject({
			kind: "goal_contract_proposed",
			contractDigest: startedContract?.contractDigest,
		});
		expect(started.decisionRefs.some((ref) => ref.decisionId === `goal_contract:${workflowId}`)).toBe(true);
		await host.dispose?.();
		host = undefined;

		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection,
			genesisEpoch: GENESIS_EPOCH,
			goalAuthoritySourceResolver,
		});
		const reopened = await host.execute({ kind: "status" });
		expect(Reflect.get(reopened, "goalContract")).toEqual(startedContract);
		expect(sourceResolutionCount).toBe(2);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rejects a forged immutable goal-source digest before journal mutation", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-source-forgery-"));
	const workflowId = "workflow-goal-source-forgery";
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-goal-source-forgery",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		const before = await host.execute({ kind: "status" });
		await expect(
			host.execute({
				kind: "start",
				request: {
					workflowId,
					objective: "preserve the immutable program authority",
					acceptanceChecks: ["program-gate"],
					protectedInvariants: ["goal-source"],
					goalContract: {
						authoritativeSource: {
							kind: "immutable_object",
							uri: "gs://example/program.md",
							objectGeneration: "1786938985509738",
							objectDigest: "forged",
							objectSizeBytes: 44_227,
							parsedObjective: "preserve the immutable program authority",
							boundaryIds: ["goal-source"],
							gateIds: ["program-gate"],
						},
						successMetrics: [
							{
								metricId: "program-gate-transition",
								requirementId: "program-gate",
								direction: "at_least",
								target: 1,
								tolerance: 0,
								measurement: "authenticated_artifact",
								guardIds: ["goal-source"],
							},
						],
						nonGoalIds: ["prerequisite-is-not-completion"],
						budgets: { tokenLimit: 1_000, wallTimeLimitSeconds: 60, spendLimitMicrounits: 0 },
					},
				},
			}),
		).rejects.toThrow(/goal source.*digest|object digest/i);
		expect(await host.execute({ kind: "status" })).toEqual(before);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("fails closed when an immutable goal source cannot be rehydrated before journal mutation", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-source-unavailable-"));
	const workflowId = "workflow-goal-source-unavailable";
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-goal-source-unavailable",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		await expect(
			host.execute({
				kind: "start",
				request: {
					workflowId,
					objective: "advance the immutable program gate",
					acceptanceChecks: ["program-gate"],
					protectedInvariants: ["goal-source"],
					goalContract: {
						authoritativeSource: {
							kind: "immutable_object",
							uri: "fixture://goal-source/program.md",
							objectGeneration: "1",
							objectDigest: "39368a9b4b46084f37ab63e2e9b0a693a1aab09bdd6407037f2c8260545ccf98",
							objectSizeBytes: 11,
							parsedObjective: "advance the immutable program gate",
							boundaryIds: ["goal-source"],
							gateIds: ["program-gate"],
						},
						successMetrics: [
							{
								metricId: "program-gate-transition",
								requirementId: "program-gate",
								direction: "at_least",
								target: 1,
								tolerance: 0,
								measurement: "authenticated_artifact",
								guardIds: ["goal-source"],
							},
						],
						nonGoalIds: ["prerequisite-is-not-completion"],
						budgets: { tokenLimit: 1_000, wallTimeLimitSeconds: 60, spendLimitMicrounits: 0 },
					},
				},
			}),
		).rejects.toThrow("workflow_goal_source_rehydration_unavailable");
		const replay = await host.runtimeStore.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: GENESIS_EPOCH.storeEpoch,
		});
		expect(replay.events).toEqual([]);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rejects rehydrated goal bytes that do not match the immutable source before journal mutation", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-source-mismatch-"));
	const workflowId = "workflow-goal-source-mismatch";
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-goal-source-mismatch",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
			goalAuthoritySourceResolver: {
				resolve: async () => ({
					objectGeneration: "1",
					bytes: new TextEncoder().encode("goal sourcf"),
					parsedObjective: "advance the immutable program gate",
					boundaryIds: ["goal-source"],
					gateIds: ["program-gate"],
				}),
			},
		});
		await expect(
			host.execute({
				kind: "start",
				request: {
					workflowId,
					objective: "advance the immutable program gate",
					acceptanceChecks: ["program-gate"],
					protectedInvariants: ["goal-source"],
					goalContract: {
						authoritativeSource: {
							kind: "immutable_object",
							uri: "fixture://goal-source/program.md",
							objectGeneration: "1",
							objectDigest: "39368a9b4b46084f37ab63e2e9b0a693a1aab09bdd6407037f2c8260545ccf98",
							objectSizeBytes: 11,
							parsedObjective: "advance the immutable program gate",
							boundaryIds: ["goal-source"],
							gateIds: ["program-gate"],
						},
						successMetrics: [
							{
								metricId: "program-gate-transition",
								requirementId: "program-gate",
								direction: "at_least",
								target: 1,
								tolerance: 0,
								measurement: "authenticated_artifact",
								guardIds: ["goal-source"],
							},
						],
						nonGoalIds: ["prerequisite-is-not-completion"],
						budgets: { tokenLimit: 1_000, wallTimeLimitSeconds: 60, spendLimitMicrounits: 0 },
					},
				},
			}),
		).rejects.toThrow("workflow_goal_source_rehydration_mismatch");
		const replay = await host.runtimeStore.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: GENESIS_EPOCH.storeEpoch,
		});
		expect(replay.events).toEqual([]);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rejects a metric whose anti-gaming guard is outside the approved invariant set before journal mutation", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-contract-guard-"));
	const workflowId = "workflow-goal-contract-guard";
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-goal-contract-guard",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		const command = {
			kind: "start",
			request: {
				workflowId,
				objective: "reject metric gaming",
				acceptanceChecks: ["observable-outcome"],
				protectedInvariants: ["preserve-safety"],
				goalContract: {
					authoritativeSource: {
						kind: "immutable_object",
						uri: "fixture://goal-contract-guard/objective",
						objectGeneration: "1",
						objectDigest: "1111111111111111111111111111111111111111111111111111111111111111",
						objectSizeBytes: 1,
						parsedObjective: "reject metric gaming",
						boundaryIds: ["preserve-safety"],
						gateIds: ["observable-outcome"],
					},
					successMetrics: [
						{
							metricId: "proxy-score",
							requirementId: "observable-outcome",
							direction: "at_least",
							target: 1,
							tolerance: 0,
							measurement: "public_integration",
							guardIds: ["disable-safety"],
						},
					],
					nonGoalIds: [],
					budgets: { tokenLimit: 1_000, wallTimeLimitSeconds: 60, spendLimitMicrounits: 0 },
				},
			},
		} as unknown as WorkflowCommand;
		await expect(host.execute(command)).rejects.toThrow(/metric.*guard.*approved invariant/i);
		const replay = await host.runtimeStore.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: GENESIS_EPOCH.storeEpoch,
		});
		expect(replay.events).toEqual([]);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("snapshots a public command before a persisted host awaits", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-command-snapshot-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-command-snapshot",
			workflowId: "workflow-command-snapshot",
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		const command: WorkflowCommand = {
			kind: "start",
			request: {
				workflowId: "workflow-command-snapshot",
				objective: "preserve the command intent",
				maxWorkers: 1,
			},
		};
		const pending = host.execute(command);
		command.request.maxWorkers = 999;
		const status = await pending;
		const cloudApproval = status.approvalRequest?.options.find((option) => option.optionId === "approve_cloud");
		expect(cloudApproval?.label).toContain("1 workers");
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rebases goal accounting when authenticated heartbeat movement makes its journal head stale", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-accounting-rebase-"));
	const workflowId = "workflow-goal-accounting-rebase";
	let approvalDelivery:
		| Parameters<NonNullable<PersistedSessionWorkflowHostInput["approvalSecretDelivery"]>>[0]
		| undefined;
	let host: PersistedSessionWorkflowHost | undefined;
	let commitSpy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-goal-accounting-rebase",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
			approvalSecretDelivery: (delivery) => {
				approvalDelivery = delivery;
			},
		});
		const started = await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "keep goal accounting authoritative during heartbeat movement",
				acceptanceChecks: ["accounting-rebases"],
				protectedInvariants: ["no-generic-pause"],
			},
		});
		if (started.approvalRequest === null || approvalDelivery === undefined)
			throw new Error("goal accounting race fixture did not receive the durable approval request");
		const approve = started.approvalRequest.options.find((option) => option.optionId === "approve");
		if (approve === undefined) throw new Error("goal accounting race fixture did not receive the approve option");
		await host.execute({
			kind: "respond",
			approvalRequestId: started.approvalRequest.approvalRequestId,
			optionId: approve.optionId,
			proof: approvalDelivery.proof,
		});

		const originalCommit = WorkflowStore.prototype.commit;
		let staleCommitCount = 0;
		commitSpy = vi.spyOn(WorkflowStore.prototype, "commit").mockImplementation(function (
			this: WorkflowStore,
			payload,
			precondition,
		) {
			if (payload.kind === "goal_projection_applied" && staleCommitCount === 0) {
				staleCommitCount += 1;
				return Promise.reject(
					new Error(
						"Workflow store compare-and-swap precondition is stale or is not bound to the active writer and lease.",
					),
				);
			}
			return originalCommit.call(this, payload, precondition);
		});

		if (host.accountAssistantUsage === undefined)
			throw new Error("persisted workflow host did not expose public goal accounting");
		const accounted = await host.accountAssistantUsage({
			tokenDelta: 17,
			wallTimeDeltaSeconds: 2,
			continuationDelta: 0,
		});
		const status = await host.execute({ kind: "status" });

		expect(staleCommitCount).toBe(1);
		expect(accounted.tokensUsed).toBe(17);
		expect(accounted.timeUsedSeconds).toBe(2);
		expect(status.status).toBe("active");
		expect(status.goal).toMatchObject({ active: true, status: "active", tokensUsed: 17 });
	} finally {
		commitSpy?.mockRestore();
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("keeps goal accounting active through a burst of authenticated head movement", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-accounting-burst-"));
	const workflowId = "workflow-goal-accounting-burst";
	let approvalDelivery:
		| Parameters<NonNullable<PersistedSessionWorkflowHostInput["approvalSecretDelivery"]>>[0]
		| undefined;
	let host: PersistedSessionWorkflowHost | undefined;
	let reloadSpy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-goal-accounting-burst",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
			approvalSecretDelivery: (delivery) => {
				approvalDelivery = delivery;
			},
		});
		const started = await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "keep the durable goal active through an authenticated heartbeat burst",
				acceptanceChecks: ["accounting-survives-heartbeat-burst"],
				protectedInvariants: ["no-generic-pause"],
			},
		});
		if (started.approvalRequest === null || approvalDelivery === undefined)
			throw new Error("goal accounting burst fixture did not receive the durable approval request");
		const approve = started.approvalRequest.options.find((option) => option.optionId === "approve");
		if (approve === undefined) throw new Error("goal accounting burst fixture did not receive the approve option");
		await host.execute({
			kind: "respond",
			approvalRequestId: started.approvalRequest.approvalRequestId,
			optionId: approve.optionId,
			proof: approvalDelivery.proof,
		});

		const originalReload = WorkflowStore.prototype.reload;
		let reloadCount = 0;
		let movedHeadCount = 0;
		reloadSpy = vi.spyOn(WorkflowStore.prototype, "reload").mockImplementation(async function (this: WorkflowStore) {
			const state = await originalReload.call(this);
			reloadCount += 1;
			if (state !== null && movedHeadCount < 20 && reloadCount % 2 === 1) {
				movedHeadCount += 1;
				return {
					...state,
					sourceJournalSequence: state.sourceJournalSequence + movedHeadCount,
					sourceJournalDigest: movedHeadCount.toString(16).padStart(64, "0"),
				};
			}
			return state;
		});

		if (host.accountAssistantUsage === undefined)
			throw new Error("persisted workflow host did not expose public goal accounting");
		const accounted = await host.accountAssistantUsage({
			tokenDelta: 23,
			wallTimeDeltaSeconds: 4,
			continuationDelta: 0,
		});
		const status = await host.execute({ kind: "status" });

		expect(movedHeadCount).toBe(20);
		expect(accounted.tokensUsed).toBe(23);
		expect(accounted.timeUsedSeconds).toBe(4);
		expect(status.status).toBe("active");
		expect(status.goal).toMatchObject({ active: true, status: "active", tokensUsed: 23 });
	} finally {
		reloadSpy?.mockRestore();
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 90_000);

it("keeps goal accounting active through a transient append-guard timeout", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-accounting-guard-"));
	const workflowId = "workflow-goal-accounting-guard";
	let approvalDelivery:
		| Parameters<NonNullable<PersistedSessionWorkflowHostInput["approvalSecretDelivery"]>>[0]
		| undefined;
	let host: PersistedSessionWorkflowHost | undefined;
	let commitSpy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-goal-accounting-guard",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
			approvalSecretDelivery: (delivery) => {
				approvalDelivery = delivery;
			},
		});
		const started = await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "keep goal accounting active through transient append-guard contention",
				acceptanceChecks: ["accounting-retries-append-guard"],
				protectedInvariants: ["no-generic-pause"],
			},
		});
		if (started.approvalRequest === null || approvalDelivery === undefined)
			throw new Error("goal accounting guard fixture did not receive the durable approval request");
		const approve = started.approvalRequest.options.find((option) => option.optionId === "approve");
		if (approve === undefined) throw new Error("goal accounting guard fixture did not receive the approve option");
		await host.execute({
			kind: "respond",
			approvalRequestId: started.approvalRequest.approvalRequestId,
			optionId: approve.optionId,
			proof: approvalDelivery.proof,
		});

		const originalCommit = WorkflowStore.prototype.commit;
		let guardTimeoutCount = 0;
		commitSpy = vi.spyOn(WorkflowStore.prototype, "commit").mockImplementation(function (
			this: WorkflowStore,
			payload,
			precondition,
		) {
			if (payload.kind === "goal_projection_applied" && guardTimeoutCount === 0) {
				guardTimeoutCount += 1;
				return Promise.reject(new Error("workflow_append_lease_guard_timeout"));
			}
			return originalCommit.call(this, payload, precondition);
		});

		if (host.accountAssistantUsage === undefined)
			throw new Error("persisted workflow host did not expose public goal accounting");
		const accounted = await host.accountAssistantUsage({
			tokenDelta: 29,
			wallTimeDeltaSeconds: 5,
			continuationDelta: 0,
		});
		const status = await host.execute({ kind: "status" });

		expect(guardTimeoutCount).toBe(1);
		expect(accounted.tokensUsed).toBe(29);
		expect(status.status).toBe("active");
		expect(status.blocked).toBeUndefined();
	} finally {
		commitSpy?.mockRestore();
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("serializes delayed host work after the lease operation that registered it has ended", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-delayed-operation-"));
	const workflowId = "workflow-delayed-operation";
	let approvalDelivery:
		| Parameters<NonNullable<PersistedSessionWorkflowHostInput["approvalSecretDelivery"]>>[0]
		| undefined;
	let host: PersistedSessionWorkflowHost | undefined;
	let commitSpy: ReturnType<typeof vi.spyOn> | undefined;
	let releaseDelayed: (() => void) | undefined;
	let releaseBlockingCommit: (() => void) | undefined;
	let blockingCommitEntered: (() => void) | undefined;
	let delayedCommitObserved: (() => void) | undefined;
	const delayedSignal = new Promise<void>((resolve) => {
		releaseDelayed = resolve;
	});
	const blockingCommitSignal = new Promise<void>((resolve) => {
		blockingCommitEntered = resolve;
	});
	const blockingCommitGate = new Promise<void>((resolve) => {
		releaseBlockingCommit = resolve;
	});
	const delayedCommitSignal = new Promise<void>((resolve) => {
		delayedCommitObserved = resolve;
	});
	let delayedOperation: Promise<unknown> | undefined;
	let delayedCommitEntered = false;
	let delayedCallActive = false;
	let delayedCallRegistered = false;
	let registerDelayedDuringCall = false;
	let blockingCallActive = false;
	let blockingCommitHeld = false;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-delayed-operation",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
			approvalSecretDelivery: (delivery) => {
				approvalDelivery = delivery;
			},
		});
		const started = await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "serialize delayed host work behind the current append owner",
				acceptanceChecks: ["delayed-work-is-serialized"],
				protectedInvariants: ["single-append-owner"],
			},
		});
		if (started.approvalRequest === null || approvalDelivery === undefined)
			throw new Error("delayed operation fixture did not receive the durable approval request");
		const approve = started.approvalRequest.options.find((option) => option.optionId === "approve");
		if (approve === undefined) throw new Error("delayed operation fixture did not receive the approve option");
		await host.execute({
			kind: "respond",
			approvalRequestId: started.approvalRequest.approvalRequestId,
			optionId: approve.optionId,
			proof: approvalDelivery.proof,
		});
		if (host.accountAssistantUsage === undefined)
			throw new Error("persisted workflow host did not expose public goal accounting");

		const originalCommit = WorkflowStore.prototype.commit;
		commitSpy = vi.spyOn(WorkflowStore.prototype, "commit").mockImplementation(async function (
			this: WorkflowStore,
			payload,
			precondition,
		) {
			if (payload.kind === "goal_projection_applied") {
				if (!delayedCallRegistered && registerDelayedDuringCall) {
					delayedCallRegistered = true;
					delayedOperation = new Promise((resolve, reject) => {
						setTimeout(async () => {
							await delayedSignal;
							delayedCallActive = true;
							try {
								resolve(
									await host!.accountAssistantUsage!({
										tokenDelta: 3,
										wallTimeDeltaSeconds: 1,
										continuationDelta: 0,
									}),
								);
							} catch (error) {
								reject(error);
							} finally {
								delayedCallActive = false;
							}
						}, 0);
					});
				}
				if (!blockingCommitHeld && blockingCallActive && !delayedCallActive) {
					blockingCommitHeld = true;
					blockingCommitEntered?.();
					await blockingCommitGate;
				}
				if (delayedCallActive) {
					delayedCommitEntered = true;
					delayedCommitObserved?.();
				}
			}
			return originalCommit.call(this, payload, precondition);
		});

		registerDelayedDuringCall = true;
		await host.accountAssistantUsage({
			tokenDelta: 5,
			wallTimeDeltaSeconds: 1,
			continuationDelta: 0,
		});
		registerDelayedDuringCall = false;
		blockingCallActive = true;
		const blockingOperation = host
			.accountAssistantUsage({
				tokenDelta: 7,
				wallTimeDeltaSeconds: 1,
				continuationDelta: 0,
			})
			.finally(() => {
				blockingCallActive = false;
			});
		await Promise.race([
			blockingCommitSignal,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("blocking goal projection commit was not reached")), 30_000),
			),
		]);
		releaseDelayed?.();
		const delayedCommittedBeforeRelease = await Promise.race([
			delayedCommitSignal.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000)),
		]);

		releaseBlockingCommit?.();
		await Promise.allSettled([blockingOperation, delayedOperation]);
		expect(delayedCommittedBeforeRelease).toBe(false);
		expect(delayedCommitEntered).toBe(true);
	} finally {
		releaseDelayed?.();
		releaseBlockingCommit?.();
		commitSpy?.mockRestore();
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 90_000);

it("records a typed contention blocker when public goal accounting exhausts append-guard retries", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-guard-blocker-"));
	const workflowId = "workflow-goal-guard-blocker";
	let approvalDelivery:
		| Parameters<NonNullable<PersistedSessionWorkflowHostInput["approvalSecretDelivery"]>>[0]
		| undefined;
	let host: PersistedSessionWorkflowHost | undefined;
	let commitSpy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-goal-guard-blocker",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
			approvalSecretDelivery: (delivery) => {
				approvalDelivery = delivery;
			},
		});
		const started = await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "fail closed with a typed accounting-contention blocker",
				acceptanceChecks: ["accounting-contention-is-typed"],
				protectedInvariants: ["no-generic-pause"],
			},
		});
		if (started.approvalRequest === null || approvalDelivery === undefined)
			throw new Error("goal accounting blocker fixture did not receive the durable approval request");
		const approve = started.approvalRequest.options.find((option) => option.optionId === "approve");
		if (approve === undefined) throw new Error("goal accounting blocker fixture did not receive the approve option");
		await host.execute({
			kind: "respond",
			approvalRequestId: started.approvalRequest.approvalRequestId,
			optionId: approve.optionId,
			proof: approvalDelivery.proof,
		});

		const originalCommit = WorkflowStore.prototype.commit;
		let blockerGuardTimeoutCount = 0;
		commitSpy = vi.spyOn(WorkflowStore.prototype, "commit").mockImplementation(function (
			this: WorkflowStore,
			payload,
			precondition,
		) {
			if (payload.kind === "goal_projection_applied" && payload.goalDelta.status === "active")
				return Promise.reject(new Error("workflow_append_lease_guard_timeout"));
			if (payload.kind === "workflow_external_blocker_recorded" && blockerGuardTimeoutCount === 0) {
				blockerGuardTimeoutCount += 1;
				return Promise.reject(new Error("workflow_append_lease_guard_timeout"));
			}
			return originalCommit.call(this, payload, precondition);
		});

		if (host.accountAssistantUsage === undefined)
			throw new Error("persisted workflow host did not expose public goal accounting");
		await expect(
			host.accountAssistantUsage({
				tokenDelta: 29,
				wallTimeDeltaSeconds: 5,
				continuationDelta: 0,
			}),
		).rejects.toThrow(/workflow_goal_accounting_rebase_exhausted/);
		const status = await host.execute({ kind: "status" });

		expect(status.status).toBe("blocked");
		expect(blockerGuardTimeoutCount).toBe(1);
		expect(status.goal.active).toBe(false);
		expect(status.blocked).toMatchObject({
			owner: "workflow_host",
			reason: "workflow_append_contention_reconciled",
			resumeEventKind: "workflow_append_contention_reconciled",
		});
	} finally {
		commitSpy?.mockRestore();
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 90_000);

it("reissues goal accounting receipts when authenticated head movement races receipt issuance", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-receipt-rebase-"));
	const workflowId = "workflow-goal-receipt-rebase";
	let approvalDelivery:
		| Parameters<NonNullable<PersistedSessionWorkflowHostInput["approvalSecretDelivery"]>>[0]
		| undefined;
	let host: PersistedSessionWorkflowHost | undefined;
	let reloadSpy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-goal-receipt-rebase",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
			approvalSecretDelivery: (delivery) => {
				approvalDelivery = delivery;
			},
		});
		const started = await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "keep goal accounting active when receipt issuance races a heartbeat",
				acceptanceChecks: ["receipt-reissued"],
				protectedInvariants: ["no-generic-pause"],
			},
		});
		if (started.approvalRequest === null || approvalDelivery === undefined)
			throw new Error("goal receipt race fixture did not receive the durable approval request");
		const approve = started.approvalRequest.options.find((option) => option.optionId === "approve");
		if (approve === undefined) throw new Error("goal receipt race fixture did not receive the approve option");
		await host.execute({
			kind: "respond",
			approvalRequestId: started.approvalRequest.approvalRequestId,
			optionId: approve.optionId,
			proof: approvalDelivery.proof,
		});

		const originalReload = WorkflowStore.prototype.reload;
		let reloadCount = 0;
		let injectedReceiptRace = false;
		reloadSpy = vi.spyOn(WorkflowStore.prototype, "reload").mockImplementation(async function (this: WorkflowStore) {
			const state = await originalReload.call(this);
			reloadCount += 1;
			if (!injectedReceiptRace && reloadCount === 2 && state !== null) {
				injectedReceiptRace = true;
				return {
					...state,
					sourceJournalSequence: state.sourceJournalSequence + 1,
					sourceJournalDigest: "f".repeat(64),
				};
			}
			return state;
		});

		if (host.accountAssistantUsage === undefined)
			throw new Error("persisted workflow host did not expose public goal accounting");
		const accounted = await host.accountAssistantUsage({
			tokenDelta: 19,
			wallTimeDeltaSeconds: 3,
			continuationDelta: 0,
		});
		const status = await host.execute({ kind: "status" });

		expect(injectedReceiptRace).toBe(true);
		expect(accounted.tokensUsed).toBe(19);
		expect(accounted.timeUsedSeconds).toBe(3);
		expect(status.status).toBe("active");
		expect(status.goal).toMatchObject({ active: true, status: "active", tokensUsed: 19 });
	} finally {
		reloadSpy?.mockRestore();
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("fails goal accounting with typed evidence when authenticated head contention never settles", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-goal-accounting-contention-"));
	const workflowId = "workflow-goal-accounting-contention";
	let approvalDelivery:
		| Parameters<NonNullable<PersistedSessionWorkflowHostInput["approvalSecretDelivery"]>>[0]
		| undefined;
	let host: PersistedSessionWorkflowHost | undefined;
	let commitSpy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-goal-accounting-contention",
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
			approvalSecretDelivery: (delivery) => {
				approvalDelivery = delivery;
			},
		});
		const started = await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "fail closed when goal accounting contention persists",
				acceptanceChecks: ["typed-contention"],
				protectedInvariants: ["bounded-rebase"],
			},
		});
		if (started.approvalRequest === null || approvalDelivery === undefined)
			throw new Error("goal accounting contention fixture did not receive the durable approval request");
		const approve = started.approvalRequest.options.find((option) => option.optionId === "approve");
		if (approve === undefined)
			throw new Error("goal accounting contention fixture did not receive the approve option");
		await host.execute({
			kind: "respond",
			approvalRequestId: started.approvalRequest.approvalRequestId,
			optionId: approve.optionId,
			proof: approvalDelivery.proof,
		});

		const originalCommit = WorkflowStore.prototype.commit;
		let staleCommitCount = 0;
		commitSpy = vi.spyOn(WorkflowStore.prototype, "commit").mockImplementation(function (
			this: WorkflowStore,
			payload,
			precondition,
		) {
			if (payload.kind !== "goal_projection_applied" || payload.goalDelta.status !== "active")
				return originalCommit.call(this, payload, precondition);
			staleCommitCount += 1;
			return Promise.reject(
				new Error(
					"Workflow store compare-and-swap precondition is stale or is not bound to the active writer and lease.",
				),
			);
		});

		if (host.accountAssistantUsage === undefined)
			throw new Error("persisted workflow host did not expose public goal accounting");
		await expect(
			host.accountAssistantUsage({ tokenDelta: 1, wallTimeDeltaSeconds: 0, continuationDelta: 0 }),
		).rejects.toThrow("workflow_goal_accounting_rebase_exhausted");
		expect(staleCommitCount).toBeGreaterThan(1);
		expect(staleCommitCount).toBeLessThanOrEqual(32);
		const status = await host.execute({ kind: "status" });
		expect(status).toMatchObject({
			status: "blocked",
			blocked: {
				owner: "workflow_host",
				reason: "workflow_append_contention_reconciled",
			},
		});
	} finally {
		commitSpy?.mockRestore();
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 90_000);

it("replaces a genesis acceptance intent after a pre-start crash", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-genesis-intent-"));
	const persistedGoal = createGoalProjection();
	let failGoalRead = false;
	const goalProjection = {
		read: (): GoalState => {
			if (failGoalRead) {
				failGoalRead = false;
				throw new Error("simulated crash before workflow_started");
			}
			return persistedGoal.read();
		},
		compareAndSwap: persistedGoal.compareAndSwap,
	};
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-genesis-intent",
			workflowId: "workflow-genesis-intent",
			goalProjection,
			genesisEpoch: GENESIS_EPOCH,
		});
		failGoalRead = true;
		await expect(
			host.execute({
				kind: "start",
				request: {
					workflowId: "workflow-genesis-intent",
					objective: "aborted first objective",
					acceptanceChecks: ["aborted"],
				},
			}),
		).rejects.toThrow("simulated crash before workflow_started");
		await host.dispose?.();
		failGoalRead = false;
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-genesis-intent",
			workflowId: "workflow-genesis-intent",
			goalProjection,
			genesisEpoch: GENESIS_EPOCH,
		});
		const status = await host.execute({
			kind: "start",
			request: {
				workflowId: "workflow-genesis-intent",
				objective: "replacement objective",
				acceptanceChecks: ["replacement"],
			},
		});
		expect(status.acceptanceCheckIds).toEqual(["replacement"]);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("blocks reopening when workflow_started committed before goal binding", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-incomplete-start-"));
	let goalReadCount = 0;
	let crashAtBinding = true;
	const goalProjection = {
		read: (): GoalState => {
			goalReadCount += 1;
			if (crashAtBinding && goalReadCount === 3) throw new Error("simulated crash after workflow_started");
			return emptyGoalState();
		},
		compareAndSwap: (): boolean => false,
	};
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-incomplete-start",
			workflowId: "workflow-incomplete-start",
			goalProjection,
			genesisEpoch: GENESIS_EPOCH,
		});
		await expect(
			host.execute({
				kind: "start",
				request: { workflowId: "workflow-incomplete-start", objective: "must bind atomically" },
			}),
		).rejects.toThrow("simulated crash after workflow_started");
		await host.dispose?.();
		host = undefined;
		crashAtBinding = false;
		await expect(
			createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "session-incomplete-start",
				workflowId: "workflow-incomplete-start",
				goalProjection,
				genesisEpoch: GENESIS_EPOCH,
			}),
		).rejects.toThrow(/incomplete.*start|start.*incomplete/i);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("reopens twice after SIGKILL and preserves the logical head across epoch-three append", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-killed-"));
	const factoryModule = pathToFileURL(join(process.cwd(), "src/core/workflow/session-host-factory.ts")).href;
	const goalsModule = pathToFileURL(join(process.cwd(), "src/core/goals.ts")).href;
	const childSource = `
import { createPersistedSessionWorkflowHost } from ${JSON.stringify(factoryModule)};
import { emptyGoalState } from ${JSON.stringify(goalsModule)};
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const artifactRoot = process.argv[1];
const goalPath = join(artifactRoot, "goal.json");
const approvalProofPath = join(artifactRoot, "approval-proof.json");
const readGoal = () => {
  try { return JSON.parse(readFileSync(goalPath, "utf8")); }
  catch { const initial = emptyGoalState(); writeFileSync(goalPath, JSON.stringify(initial)); return initial; }
};
const goalProjection = {
  read: () => readGoal(),
  compareAndSwap: (expected, next) => { if (JSON.stringify(readGoal()) !== JSON.stringify(expected)) return false; writeFileSync(goalPath, JSON.stringify(next)); return true; },
};
const host = await createPersistedSessionWorkflowHost({
  artifactRoot,
  rootSessionId: "session-killed",
  workflowId: "workflow-killed",
  goalProjection,
  approvalSecretDelivery: ({ request, proof }) => writeFileSync(approvalProofPath, JSON.stringify({ request, proof })),
  genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
});

const mode = process.argv[2] ?? "start";
const report = mode === "start"
  ? await (async () => {
      const started = await host.execute({ kind: "start", request: { workflowId: "workflow-killed", objective: "recover after kill", acceptanceChecks: ["reopens"], protectedInvariants: ["preserves-owner"] } });
      if (started.status !== "awaiting_user" || started.approvalRequest === null) throw new Error("first worker did not receive the durable approval request");
      const delivered = JSON.parse(readFileSync(approvalProofPath, "utf8"));
      if (delivered.request?.approvalRequestId !== started.approvalRequest.approvalRequestId) throw new Error("first worker received a proof for a different approval request");
      const approveOption = started.approvalRequest.options.find((option) => option.optionId === "approve");
      if (approveOption === undefined) throw new Error("first worker did not receive the exact approve option");
      const approved = await host.execute({ kind: "respond", approvalRequestId: started.approvalRequest.approvalRequestId, optionId: approveOption.optionId, proof: delivered.proof });
      if (approved.status !== "active" || approved.phase !== "planning") throw new Error("first worker did not consume the host-delivered approval proof");
      return approved;
    })()
  : await (async () => {
      const status = await host.execute({ kind: "status" });
      if (status.status !== "active" || status.phase !== "planning" || status.goal.objective !== "recover after kill" || JSON.stringify(status.acceptanceCheckIds) !== JSON.stringify(["reopens"]) || JSON.stringify(status.protectedInvariantIds) !== JSON.stringify(["preserves-owner"])) throw new Error("second worker did not recover the approved workflow contract");
      return host.execute({ kind: "pause", reason: "verify reclaimed append" });
    })();
if (mode !== "start" && (report.status !== "paused" || report.goal.objective !== "recover after kill" || JSON.stringify(report.acceptanceCheckIds) !== JSON.stringify(["reopens"]) || JSON.stringify(report.protectedInvariantIds) !== JSON.stringify(["preserves-owner"]))) throw new Error("second worker did not persist the reclaimed pause");
console.log("ready:" + JSON.stringify({ status: report.status, objective: report.goal.objective, acceptanceCheckIds: report.acceptanceCheckIds, protectedInvariantIds: report.protectedInvariantIds, stateDigest: report.stateDigest }));
process.stdin.resume();
`;

	type ChildReport = {
		status: string;
		objective: string | null;
		acceptanceCheckIds: readonly string[];
		protectedInvariantIds: readonly string[];
		stateDigest: string | null;
	};
	const workers: Array<ReturnType<typeof spawnWorker>> = [];
	const spawnWorker = (mode: "start" | "pause") => {
		const child = spawn(
			process.execPath,
			["--import", "tsx/esm", "--input-type=module", "-e", childSource, artifactRoot, mode],
			{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		const ready = new Promise<ChildReport>((resolveReady, rejectReady) => {
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				const line = stdout.split("\n").find((value) => value.startsWith("ready:"));
				if (line !== undefined) resolveReady(JSON.parse(line.slice("ready:".length)) as ChildReport);
			});
			child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
			child.once("error", rejectReady);
			child.once("close", (code, signal) =>
				rejectReady(
					new Error(`workflow worker exited before ready (${code ?? "null"}/${signal ?? "none"}): ${stderr}`),
				),
			);
		});
		const waitForExit = (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
			new Promise((resolveExit, rejectExit) => {
				child.once("error", rejectExit);
				child.once("close", (code, signal) => resolveExit({ code, signal }));
			});
		return {
			child,
			ready,
			stderr: () => stderr,
			waitForExit,
		};
	};
	const stopWorker = async (worker: ReturnType<typeof spawnWorker>): Promise<void> => {
		if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
		worker.child.kill("SIGKILL");
		const exit = await worker.waitForExit();
		expect(exit.signal).toBe("SIGKILL");
		if (worker.stderr().length > 0) throw new Error(`workflow worker failed before SIGKILL: ${worker.stderr()}`);
	};

	try {
		const firstWorker = spawnWorker("start");
		workers.push(firstWorker);
		const firstReport = await firstWorker.ready;
		expect(firstReport).toMatchObject({
			status: "active",
			objective: "recover after kill",
			acceptanceCheckIds: ["reopens"],
			protectedInvariantIds: ["preserves-owner"],
		});
		const initialActiveGeneration = parseCanonicalJsonBytes(
			await readFile(join(artifactRoot, "workflows", "workflow-killed", "side-records", "active-generation.json")),
		);
		if (
			initialActiveGeneration === null ||
			typeof initialActiveGeneration !== "object" ||
			Array.isArray(initialActiveGeneration) ||
			typeof initialActiveGeneration.generationId !== "string"
		)
			throw new Error("killed workflow did not publish an authenticated generation");
		const initialGenerationId = initialActiveGeneration.generationId;
		await stopWorker(firstWorker);

		const secondWorker = spawnWorker("pause");
		workers.push(secondWorker);
		const secondReport = await secondWorker.ready;
		expect(secondReport).toMatchObject({
			status: "paused",
			objective: "recover after kill",
			acceptanceCheckIds: ["reopens"],
			protectedInvariantIds: ["preserves-owner"],
		});
		if (secondReport.stateDigest === null)
			throw new Error("reclaimed pause did not return its authenticated head digest");
		await stopWorker(secondWorker);

		const goalProjection = createFileGoalProjection(join(artifactRoot, "goal.json"));
		const reopened = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-killed",
			workflowId: "workflow-killed",
			goalProjection,
			genesisEpoch: GENESIS_EPOCH,
		});
		let resumedStateDigest: string | null = null;
		try {
			const status = await reopened.execute({ kind: "status" });
			expect(status.status).toBe("paused");
			expect(status.goal.objective).toBe("recover after kill");
			expect(status.acceptanceCheckIds).toEqual(["reopens"]);
			expect(status.protectedInvariantIds).toEqual(["preserves-owner"]);
			expect(status.stateDigest).not.toBe(secondReport.stateDigest);
			const resumed = await reopened.execute({ kind: "resume", note: "verify epoch-three append" });
			expect(resumed.status).toBe("active");
			expect(resumed.goal.objective).toBe("recover after kill");
			expect(resumed.acceptanceCheckIds).toEqual(["reopens"]);
			expect(resumed.protectedInvariantIds).toEqual(["preserves-owner"]);
			expect(resumed.stateDigest).not.toBe(status.stateDigest);
			resumedStateDigest = resumed.stateDigest;
		} finally {
			await reopened.dispose?.();
		}

		const reopenedAgain = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-killed",
			workflowId: "workflow-killed",
			goalProjection,
			genesisEpoch: GENESIS_EPOCH,
		});
		try {
			const resumed = await reopenedAgain.execute({ kind: "status" });
			expect(resumed.status).toBe("active");
			expect(resumed.goal.objective).toBe("recover after kill");
			expect(resumed.acceptanceCheckIds).toEqual(["reopens"]);
			expect(resumed.protectedInvariantIds).toEqual(["preserves-owner"]);
			expect(resumed.stateDigest).toBe(resumedStateDigest);
			const activeGeneration = parseCanonicalJsonBytes(
				await readFile(
					join(artifactRoot, "workflows", "workflow-killed", "side-records", "active-generation.json"),
				),
			);
			const appendLease = parseCanonicalJsonBytes(
				await readFile(join(artifactRoot, "workflows", "workflow-killed", "append-lease.json")),
			);
			if (activeGeneration === null || typeof activeGeneration !== "object" || Array.isArray(activeGeneration))
				throw new Error("recovered workflow did not publish an active generation record");
			expect(activeGeneration).toMatchObject({ generationId: expect.any(String) });
			expect(activeGeneration).not.toMatchObject({ generationId: initialGenerationId });
			expect(activeGeneration).toMatchObject({
				generationId: expect.any(String),
				epochRef: { storeEpoch: 1, coordinatorEpoch: 3 },
				generationBinding: {
					writerIdentity: "workflow-coordinator:session-killed:workflow-killed",
					ownerIdentity: "workflow-coordinator:session-killed:workflow-killed",
					processGenerationId: expect.any(String),
				},
				sourceHead: {
					workflowId: "workflow-killed",
					sequence: expect.any(Number),
					eventDigest: secondReport.stateDigest,
					epochRef: { storeEpoch: 1, coordinatorEpoch: 2 },
				},
			});
			expect(appendLease).toMatchObject({ status: "active", leaseRef: activeGeneration.leaseRef });
		} finally {
			await reopenedAgain.dispose?.();
		}
	} finally {
		for (const worker of workers) await stopWorker(worker).catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 60_000);

it("does not resurrect an invalidated approval after dead-owner generation rotation", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-approval-invalidation-rotation-"));
	const factoryModule = pathToFileURL(join(process.cwd(), "src/core/workflow/session-host-factory.ts")).href;
	const goalsModule = pathToFileURL(join(process.cwd(), "src/core/goals.ts")).href;
	const childSource = `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPersistedSessionWorkflowHost } from ${JSON.stringify(factoryModule)};
import { emptyGoalState } from ${JSON.stringify(goalsModule)};

const artifactRoot = process.argv[1];
const mode = process.argv[2] ?? "invalidate";
const workflowId = "workflow-invalidated-rotation";
const rootSessionId = "session-invalidated-rotation";
const goalPath = join(artifactRoot, "goal.json");
const approvalProofPath = join(artifactRoot, "approval-proof.json");
const readGoal = () => {
  try { return JSON.parse(readFileSync(goalPath, "utf8")); }
  catch { const initial = emptyGoalState(); writeFileSync(goalPath, JSON.stringify(initial)); return initial; }
};
const goalProjection = {
  read: () => readGoal(),
  compareAndSwap: (expected, next) => { if (JSON.stringify(readGoal()) !== JSON.stringify(expected)) return false; writeFileSync(goalPath, JSON.stringify(next)); return true; },
};
const host = await createPersistedSessionWorkflowHost({
  artifactRoot,
  rootSessionId,
  workflowId,
  goalProjection,
  approvalSecretDelivery: ({ request, proof }) => writeFileSync(approvalProofPath, JSON.stringify({ request, proof })),
  genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
});
if (mode === "invalidate") {
  const started = await host.execute({ kind: "start", request: { workflowId, objective: "invalidate before owner death", acceptanceChecks: ["rotation"] } });
  if (started.status !== "awaiting_user" || started.approvalRequest === null) throw new Error("invalidation worker did not receive approval");
  const invalidated = await host.approvals.invalidate(started.approvalRequest.approvalRequestId, "owner-death invalidation");
  if (invalidated.status !== "invalidated") throw new Error("invalidation worker did not persist invalidation");
  console.log("invalidated:" + JSON.stringify({ status: started.status, approvalRequestId: started.approvalRequest.approvalRequestId }));
} else {
  const status = await host.execute({ kind: "status" });
  if (status.status !== "awaiting_user") throw new Error("reopened workflow changed status after invalidation");
  if (await host.approvals.pending(workflowId) !== null) throw new Error("invalidated approval was resurrected as pending");
  const delivered = JSON.parse(readFileSync(approvalProofPath, "utf8"));
  const request = status.approvalRequest;
  if (request === null) throw new Error("reopened workflow lost its durable request");
  const option = request.options.find((candidate) => candidate.optionId === "approve");
  if (option === undefined) throw new Error("reopened workflow lost its approve option");
  let consumed = false;
  try {
    await host.execute({ kind: "respond", approvalRequestId: request.approvalRequestId, optionId: option.optionId, proof: delivered.proof });
    consumed = true;
  } catch {}
  if (consumed) throw new Error("invalidated approval was consumed after owner rotation");
  const replay = await host.runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: 1 });
  if (replay.events.some((event) => event.payload.kind === "approval_consumed")) throw new Error("invalidated approval appended approval_consumed");
  console.log("reopened:" + JSON.stringify({ status: status.status, coordinatorEpoch: host.runtimeStore.durableContext?.epochRef.coordinatorEpoch, pending: await host.approvals.pending(workflowId) }));
}
process.stdin.resume();
setInterval(() => undefined, 1_000);
`;
	type Worker = { child: ReturnType<typeof spawn>; waitFor(prefix: string): Promise<string>; stderr(): string };
	const workers: Worker[] = [];
	const spawnWorker = (mode: "invalidate" | "reopen"): Worker => {
		const child = spawn(
			process.execPath,
			["--import", "tsx/esm", "--input-type=module", "-e", childSource, artifactRoot, mode],
			{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		const waiters = new Map<string, { resolve(line: string): void; reject(error: Error): void }>();
		const find = (prefix: string): string | undefined => stdout.split("\\n").find((line) => line.startsWith(prefix));
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			for (const [prefix, waiter] of waiters) {
				const line = find(prefix);
				if (line === undefined) continue;
				waiters.delete(prefix);
				waiter.resolve(line);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.once("close", (code, signal) => {
			for (const [prefix, waiter] of waiters)
				waiter.reject(
					new Error(
						`approval rotation worker closed before ${prefix} (${code ?? "null"}/${signal ?? "none"}): ${stderr}`,
					),
				);
		});
		return {
			child,
			stderr: () => stderr,
			waitFor: (prefix) =>
				new Promise((resolve, reject) => {
					const line = find(prefix);
					if (line !== undefined) return resolve(line);
					waiters.set(prefix, { resolve, reject });
				}),
		};
	};
	const stopWorker = async (worker: Worker): Promise<void> => {
		if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
		worker.child.kill("SIGKILL");
		await new Promise<void>((resolve) => worker.child.once("close", () => resolve()));
		if (worker.stderr().length > 0) throw new Error(`approval rotation worker failed: ${worker.stderr()}`);
	};
	try {
		const owner = spawnWorker("invalidate");
		workers.push(owner);
		const invalidated = await owner.waitFor("invalidated:");
		expect(JSON.parse(invalidated.slice("invalidated:".length))).toMatchObject({ status: "awaiting_user" });
		await stopWorker(owner);
		const successor = spawnWorker("reopen");
		workers.push(successor);
		const reopened = await successor.waitFor("reopened:");
		expect(JSON.parse(reopened.slice("reopened:".length))).toMatchObject({
			status: "awaiting_user",
			coordinatorEpoch: 2,
			pending: null,
		});
	} finally {
		for (const worker of workers) await stopWorker(worker).catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 60_000);

it("recovers a coordinator rotation killed after successor lease CAS before active publication", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-rotation-killed-"));
	const factoryModule = pathToFileURL(join(process.cwd(), "src/core/workflow/session-host-factory.ts")).href;
	const goalsModule = pathToFileURL(join(process.cwd(), "src/core/goals.ts")).href;
	const contractsModule = pathToFileURL(join(process.cwd(), "src/core/workflow/contracts.ts")).href;
	const journalModule = pathToFileURL(join(process.cwd(), "src/core/workflow/journal.ts")).href;
	const keyringModule = pathToFileURL(join(process.cwd(), "src/core/workflow/local-journal-keyring.ts")).href;
	const leaseModule = pathToFileURL(join(process.cwd(), "src/core/workflow/local-append-lease.ts")).href;
	const descriptorModule = pathToFileURL(join(process.cwd(), "src/core/workflow/node-descriptor-fs.ts")).href;
	const reducerModule = pathToFileURL(join(process.cwd(), "src/core/workflow/reducer.ts")).href;
	const boundaryWorkerSource = `
import { constants as fsConstants, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPersistedSessionWorkflowHost } from ${JSON.stringify(factoryModule)};
import { emptyGoalState } from ${JSON.stringify(goalsModule)};
	import { DurableStoreCrashBoundary, digestObject, parseCanonicalJsonBytes } from ${JSON.stringify(contractsModule)};
import { createWorkflowDescriptorRootAdapters, createWorkflowOwnerValidators, createWorkflowSessionPublicationFactory } from ${JSON.stringify(journalModule)};
import { createLocalWorkflowJournalKeyProvider } from ${JSON.stringify(keyringModule)};
import { createLocalAppendLease, createLocalAppendLeaseProcessIdentity } from ${JSON.stringify(leaseModule)};
import { createNodeWorkflowDescriptorFs } from ${JSON.stringify(descriptorModule)};
import { WorkflowStore } from ${JSON.stringify(reducerModule)};

const artifactRoot = process.argv[1];
const workflowId = "workflow-rotation-killed";
const rootSessionId = "session-rotation-killed";
const workflowDir = join(artifactRoot, "workflows", workflowId);
const goalPath = join(artifactRoot, "goal.json");
const approvalProofPath = join(artifactRoot, "approval-proof.json");
const readGoal = () => {
  try { return JSON.parse(readFileSync(goalPath, "utf8")); }
  catch { const initial = emptyGoalState(); writeFileSync(goalPath, JSON.stringify(initial)); return initial; }
};
const goalProjection = {
  read: () => readGoal(),
  compareAndSwap: (expected, next) => { if (JSON.stringify(readGoal()) !== JSON.stringify(expected)) return false; writeFileSync(goalPath, JSON.stringify(next)); return true; },
};
const readCanonical = async (path) => parseCanonicalJsonBytes(await readFile(path));
const readActive = () => readCanonical(join(workflowDir, "side-records", "active-generation.json"));
const readLease = () => readCanonical(join(workflowDir, "append-lease.json"));
const readRotations = () => readCanonical(join(workflowDir, "side-records", "rotations", "records.json"));

const host = await createPersistedSessionWorkflowHost({ artifactRoot, rootSessionId, workflowId, goalProjection, approvalSecretDelivery: ({ request, proof }) => writeFileSync(approvalProofPath, JSON.stringify({ request, proof })), genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 } });
const started = await host.execute({ kind: "start", request: { workflowId, objective: "recover a successor lease kill", acceptanceChecks: ["rotation-continuity"], protectedInvariants: ["owner-fencing"] } });
if (started.status !== "awaiting_user" || started.approvalRequest === null) throw new Error("boundary worker did not receive the durable approval request");
const delivered = JSON.parse(readFileSync(approvalProofPath, "utf8"));
if (delivered.request?.approvalRequestId !== started.approvalRequest.approvalRequestId) throw new Error("boundary worker received a proof for a different approval request");
const approveOption = started.approvalRequest.options.find((option) => option.optionId === "approve");
if (approveOption === undefined) throw new Error("boundary worker did not receive the exact approve option");
const approved = await host.execute({ kind: "respond", approvalRequestId: started.approvalRequest.approvalRequestId, optionId: approveOption.optionId, proof: delivered.proof });
if (approved.status !== "active" || approved.phase !== "planning") throw new Error("boundary worker did not consume the host-delivered approval proof");
console.log("started:" + JSON.stringify(approved));
await host.dispose?.();

const active = await readActive();
const leaseRecord = await readLease();
const epoch = active.epochRef;
const leaseRef = leaseRecord.leaseRef;
const processIdentity = createLocalAppendLeaseProcessIdentity();
const writerIdentity = "workflow-coordinator:" + rootSessionId + ":" + workflowId;
const descriptorFs = createNodeWorkflowDescriptorFs();
const descriptorRoot = await descriptorFs.openRoot(artifactRoot);
const workflows = await descriptorFs.openAt(descriptorRoot, "workflows", fsConstants.O_RDONLY | fsConstants.O_DIRECTORY, 0o700);
const workflow = await descriptorFs.openAt(workflows, workflowId, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY, 0o700);
const descriptorRoots = createWorkflowDescriptorRootAdapters({ sessionArtifactRoot: artifactRoot, workflowDir, rootSessionId, workflowId, sessionIdentityDigest: descriptorRoot.identityDigest, workflowIdentityDigest: workflow.identityDigest });
const keyProvider = createLocalWorkflowJournalKeyProvider({ sessionArtifactRoot: artifactRoot, rootSessionId });
const previousKey = await keyProvider.current(workflowId, epoch);
const appendLease = createLocalAppendLease({
  sessionArtifactRoot: artifactRoot,
  rootDigest: leaseRef.rootDigest,
  storeEpoch: epoch.storeEpoch,
  secret: previousKey.secret,
  ttlMilliseconds: 300000,
  clock: { now: () => new Date().toISOString(), addMilliseconds: (base, milliseconds) => new Date(Date.parse(base) + milliseconds).toISOString() },
  writerIdentity,
  processIdentity,
});
const publication = await createWorkflowSessionPublicationFactory({
  artifactRoot,
  sessionArtifactRoot: artifactRoot,
  workflowDir,
  descriptorRoots,
  storeKind: "workflow",
  namespace: "session",
  storeId: "session-workflow:" + workflowId,
  workflowId,
  rootSessionId,
  epoch,
  writerIdentity,
  keyProvider,
  appendLease,
  leaseRef,
  descriptorFs,
  ownerValidators: createWorkflowOwnerValidators(),
  now: () => new Date().toISOString(),
  successorContextOpener: { openSuccessor: async () => { throw new Error("successor must not publish before the kill"); } },
});
const store = await WorkflowStore.open(publication.journal, rootSessionId);
const hook = {
  checkpoint: DurableStoreCrashBoundary.afterRotationFenceBeforeLeaseTransfer,
  before: async () => undefined,
  after: async (input) => {
    console.log("rotation-after-lease-cas:" + JSON.stringify({ input, active: await readActive(), lease: await readLease(), rotations: await readRotations() }));
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once("data", resolve));
  },
};
const rotateGeneration = publication.journal.rotateGeneration.bind(publication.journal);
publication.journal.rotateGeneration = (input) => rotateGeneration(input, hook);
const state = store.snapshot();
if (state === null) throw new Error("rotation worker opened no persisted state");
const nextEpoch = { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch + 1 };
const nextKey = await keyProvider.rotateGeneration({
  workflowId,
  previousEpoch: epoch,
  nextEpoch,
  rotationId: "coordinator:" + workflowId + ":" + nextEpoch.coordinatorEpoch,
  priorHeadDigest: digestObject({ workflowId: state.workflowId, sequence: state.sourceJournalSequence, eventDigest: state.sourceJournalDigest, epochRef: epoch }),
});
appendLease.prepareSecretRotation(nextKey.secret);
await store.replaceCoordinatorEpoch(
  nextEpoch,
  { writerIdentity, processGenerationId: processIdentity, ownerIdentity: writerIdentity },
);
`;
	const recoveryWorkerSource = `
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPersistedSessionWorkflowHost } from ${JSON.stringify(factoryModule)};
import { parseCanonicalJsonBytes } from ${JSON.stringify(contractsModule)};
import { createLocalAppendLeaseProcessIdentity } from ${JSON.stringify(leaseModule)};

const artifactRoot = process.argv[1];
const mode = process.argv[2] ?? "recover";
const workflowId = "workflow-rotation-killed";
const rootSessionId = "session-rotation-killed";
const workflowDir = join(artifactRoot, "workflows", workflowId);
const goalPath = join(artifactRoot, "goal.json");
const approvalProofPath = join(artifactRoot, "approval-proof.json");
const readGoal = () => JSON.parse(readFileSync(goalPath, "utf8"));
const goalProjection = {
  read: () => readGoal(),
  compareAndSwap: (expected, next) => { if (JSON.stringify(readGoal()) !== JSON.stringify(expected)) return false; writeFileSync(goalPath, JSON.stringify(next)); return true; },
};
if (mode === "compete") {
  try {
    await createPersistedSessionWorkflowHost({ artifactRoot, rootSessionId, workflowId, goalProjection, processIdentity: "process-unverifiable", genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 } });
    console.log("competing-opened");
  } catch (error) {
    console.log("competing-error:" + (error instanceof Error ? error.message : String(error)));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.exit(0);
}
const host = await createPersistedSessionWorkflowHost({ artifactRoot, rootSessionId, workflowId, goalProjection, genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 } });
const recovered = await host.execute({ kind: "status" });
if (recovered.status !== "active" || recovered.phase !== "planning" || recovered.approvalRequest !== null) throw new Error("recovery worker did not recover the approved workflow contract");
const paused = await host.execute({ kind: "pause", reason: "persist post-recovery append" });
await host.dispose?.();
const reopened = await createPersistedSessionWorkflowHost({ artifactRoot, rootSessionId, workflowId, goalProjection, genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 } });
const persisted = await reopened.execute({ kind: "status" });
await reopened.dispose?.();
const readCanonical = async (path) => parseCanonicalJsonBytes(await readFile(path));
console.log("recovered:" + JSON.stringify({ recovered, paused, persisted, active: await readCanonical(join(workflowDir, "side-records", "active-generation.json")), lease: await readCanonical(join(workflowDir, "append-lease.json")), rotations: await readCanonical(join(workflowDir, "side-records", "rotations", "records.json")), processIdentity: createLocalAppendLeaseProcessIdentity() }));
process.stdin.resume();
await new Promise(() => undefined);
`;
	type RotationWorker = {
		child: ReturnType<typeof spawn>;
		waitFor(prefix: string): Promise<string>;
		waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
		stderr(): string;
	};
	const workers: RotationWorker[] = [];
	const spawnRotationWorker = (source: string, args: readonly string[] = []): RotationWorker => {
		const child = spawn(
			process.execPath,
			["--import", "tsx/esm", "--input-type=module", "-e", source, artifactRoot, ...args],
			{ cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		const waiters = new Map<string, { resolve(line: string): void; reject(error: Error): void }>();
		const findLine = (prefix: string): string | undefined =>
			stdout.split("\n").find((line) => line.startsWith(prefix));
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			for (const [prefix, waiter] of waiters) {
				const line = findLine(prefix);
				if (line === undefined) continue;
				waiters.delete(prefix);
				waiter.resolve(line);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.once("close", (code, signal) => {
			for (const [prefix, waiter] of waiters) {
				waiter.reject(
					new Error(`worker closed before ${prefix} (${code ?? "null"}/${signal ?? "none"}): ${stderr}`),
				);
			}
		});
		const waitFor = (prefix: string): Promise<string> =>
			new Promise((resolve, reject) => {
				const line = findLine(prefix);
				if (line !== undefined) return resolve(line);
				waiters.set(prefix, { resolve, reject });
			});
		const waitForExit = (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
			new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve({ code, signal }));
			});
		return { child, waitFor, waitForExit, stderr: () => stderr };
	};
	const stopWorker = async (worker: RotationWorker): Promise<void> => {
		if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
		worker.child.kill("SIGKILL");
		const exit = await worker.waitForExit();
		expect(exit.signal).toBe("SIGKILL");
		if (worker.stderr().length > 0)
			throw new Error(`workflow rotation worker failed before SIGKILL: ${worker.stderr()}`);
	};
	try {
		const boundaryWorker = spawnRotationWorker(boundaryWorkerSource);
		workers.push(boundaryWorker);
		const started = JSON.parse((await boundaryWorker.waitFor("started:")).slice("started:".length)) as Record<
			string,
			unknown
		>;
		expect(started).toMatchObject({
			status: "active",
			phase: "planning",
			goal: { objective: "recover a successor lease kill" },
			acceptanceCheckIds: ["rotation-continuity"],
			protectedInvariantIds: ["owner-fencing"],
		});
		const workflowDir = join(artifactRoot, "workflows", "workflow-rotation-killed");
		const activePath = join(workflowDir, "side-records", "active-generation.json");
		const leasePath = join(workflowDir, "append-lease.json");
		const rotationsPath = join(workflowDir, "side-records", "rotations", "records.json");
		const activeBefore = parseCanonicalJsonBytes(await readFile(activePath));
		expect(activeBefore).toMatchObject({ epochRef: { storeEpoch: 1, coordinatorEpoch: 1 } });
		const hookEvidence = JSON.parse(
			(await boundaryWorker.waitFor("rotation-after-lease-cas:")).slice("rotation-after-lease-cas:".length),
		) as Record<string, unknown>;
		const activeAtCas = parseCanonicalJsonBytes(await readFile(activePath));
		const leaseAtCas = parseCanonicalJsonBytes(await readFile(leasePath));
		const rotationsAtCas = parseCanonicalJsonBytes(await readFile(rotationsPath));
		expect(activeAtCas).toEqual(activeBefore);
		expect(hookEvidence).toMatchObject({ input: { checkpoint: "after_rotation_fence_before_lease_transfer" } });
		const rotationMap = requireRecord(rotationsAtCas, "rotation records");
		const rotationIds = Object.keys(rotationMap);
		expect(rotationIds).toHaveLength(1);
		const prepared = requireRecord(rotationMap[rotationIds[0]], "prepared rotation");
		expect(prepared).toMatchObject({ state: "prepared", lastCheckpoint: "after_rotation_prepare_before_fence" });
		const request = requireRecord(prepared.request, "rotation request");
		const leaseRecord = requireRecord(leaseAtCas, "successor lease");
		expect(leaseRecord.status).toBe("active");
		expect(leaseRecord.leaseRef).toEqual(request.nextLeaseRef);
		const predecessorGenerationId = requireString(
			requireRecord(activeBefore, "predecessor active").generationId,
			"predecessor generation",
		);
		const successorGenerationId = requireString(request.generationId, "successor generation");
		const previousKeyRecord = requireRecord(
			parseCanonicalJsonBytes(
				await readFile(
					join(
						artifactRoot,
						"keyring",
						"workflows",
						"workflow-rotation-killed",
						"generations",
						predecessorGenerationId,
						"side-records",
						"key.json",
					),
				),
			),
			"predecessor key",
		);
		const successorKeyRecord = requireRecord(
			parseCanonicalJsonBytes(
				await readFile(
					join(
						artifactRoot,
						"keyring",
						"workflows",
						"workflow-rotation-killed",
						"generations",
						successorGenerationId,
						"side-records",
						"key.json",
					),
				),
			),
			"successor key",
		);
		const leaseRef = requireRecord(leaseRecord.leaseRef, "successor lease ref");
		const leaseOptions = {
			sessionArtifactRoot: artifactRoot,
			rootDigest: requireString(leaseRef.rootDigest, "lease root digest"),
			storeEpoch: 1,
			ttlMilliseconds: 300000,
			clock: {
				now: () => new Date().toISOString(),
				addMilliseconds: (base: string, milliseconds: number) =>
					new Date(Date.parse(base) + milliseconds).toISOString(),
			},
			writerIdentity: requireString(leaseRef.writerIdentity, "lease writer"),
			processIdentity: "process-unverifiable",
		};
		const previousLeaseReader = createLocalAppendLease({
			...leaseOptions,
			secret: Buffer.from(requireString(previousKeyRecord.secretBase64, "predecessor secret"), "base64"),
		});
		await stopWorker(boundaryWorker);
		await expect(previousLeaseReader.observe("workflow-rotation-killed")).rejects.toThrow(
			"workflow_append_lease_authentication_invalid",
		);
		const successorLeaseReader = createLocalAppendLease({
			...leaseOptions,
			secret: Buffer.from(requireString(successorKeyRecord.secretBase64, "successor secret"), "base64"),
		});
		await expect(successorLeaseReader.observe("workflow-rotation-killed")).resolves.toMatchObject({
			leaseRef: request.nextLeaseRef,
		});
		const originalLeaseBytes = await readFile(leasePath);
		const originalRotationArtifactPath = join(workflowDir, "side-records", "rotations", `${rotationIds[0]}.json`);
		const originalRotationArtifactBytes = await readFile(originalRotationArtifactPath);
		const originalRotationsBytes = await readFile(rotationsPath);
		const liveProcessIdentity = createLocalAppendLeaseProcessIdentity();
		await tamperPendingSuccessorBinding({
			leasePath,
			rotationsPath,
			rotationArtifactPath: originalRotationArtifactPath,
			workflowId: "workflow-rotation-killed",
			rotationId: rotationIds[0],
			liveProcessIdentity,
			foreignWriterIdentity: "workflow-coordinator:foreign-writer",
			previousSecret: Buffer.from(requireString(previousKeyRecord.secretBase64, "predecessor secret"), "base64"),
			successorSecret: Buffer.from(requireString(successorKeyRecord.secretBase64, "successor secret"), "base64"),
		});
		let tamperedHost: WorkflowPhaseHost | undefined;
		let tamperedError: unknown;
		try {
			tamperedHost = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "session-rotation-killed",
				workflowId: "workflow-rotation-killed",
				goalProjection: createFileGoalProjection(join(artifactRoot, "goal.json")),
				processIdentity: liveProcessIdentity,
				writerIdentity: requireString(leaseRef.writerIdentity, "configured writer"),
				genesisEpoch: GENESIS_EPOCH,
			});
		} catch (error) {
			tamperedError = error;
		} finally {
			await tamperedHost?.dispose?.();
			await writeFile(leasePath, originalLeaseBytes);
			await writeFile(originalRotationArtifactPath, originalRotationArtifactBytes);
			await writeFile(rotationsPath, originalRotationsBytes);
		}
		if (tamperedError === undefined) throw new Error("live same-process successor with a foreign writer was adopted");
		expect(tamperedError).toMatchObject({ message: "workflow_append_lease_foreign_owner" });

		const recoveryWorker = spawnRotationWorker(recoveryWorkerSource);
		workers.push(recoveryWorker);
		const recoveredEvidence = JSON.parse(
			(await recoveryWorker.waitFor("recovered:")).slice("recovered:".length),
		) as Record<string, unknown>;
		const recovered = requireRecord(recoveredEvidence.recovered, "recovered status");
		const paused = requireRecord(recoveredEvidence.paused, "paused status");
		const persisted = requireRecord(recoveredEvidence.persisted, "persisted status");
		const finalActive = requireRecord(recoveredEvidence.active, "final active generation");
		const finalLease = requireRecord(recoveredEvidence.lease, "final append lease");
		const finalRotations = requireRecord(recoveredEvidence.rotations, "final rotations");
		expect(recovered).toMatchObject({
			status: "active",
			phase: "planning",
			goal: { objective: "recover a successor lease kill" },
			acceptanceCheckIds: ["rotation-continuity"],
			protectedInvariantIds: ["owner-fencing"],
		});
		expect(paused).toMatchObject({
			status: "paused",
			goal: { objective: "recover a successor lease kill" },
			acceptanceCheckIds: ["rotation-continuity"],
			protectedInvariantIds: ["owner-fencing"],
		});
		expect(persisted).toEqual(paused);
		expect(finalActive.epochRef).toEqual({ storeEpoch: 1, coordinatorEpoch: 3 });
		expect(finalActive.leaseRef).toEqual(finalLease.leaseRef);
		expect(finalActive).toMatchObject({
			generationBinding: {
				writerIdentity: "workflow-coordinator:session-rotation-killed:workflow-rotation-killed",
				ownerIdentity: "workflow-coordinator:session-rotation-killed:workflow-rotation-killed",
			},
		});
		expect(finalLease.leaseRef).toMatchObject({
			storeEpoch: 1,
			coordinatorEpoch: 3,
			processIdentity: recoveredEvidence.processIdentity,
		});
		expect(Object.keys(finalRotations).sort()).toEqual([
			"coordinator:workflow-rotation-killed:2",
			"coordinator:workflow-rotation-killed:3",
		]);
		const firstCommitted = requireRecord(
			finalRotations["coordinator:workflow-rotation-killed:2"],
			"first committed rotation",
		);
		const secondCommitted = requireRecord(
			finalRotations["coordinator:workflow-rotation-killed:3"],
			"second committed rotation",
		);
		expect(firstCommitted.state).toBe("committed");
		expect(secondCommitted.state).toBe("committed");
		const firstFenceSequence = firstCommitted.fenceEventSequence;
		const secondFenceSequence = secondCommitted.fenceEventSequence;
		if (typeof firstFenceSequence !== "number" || typeof secondFenceSequence !== "number")
			throw new Error("committed rotations must retain their authenticated fence sequence");
		expect(secondFenceSequence).toBeGreaterThan(firstFenceSequence);
		expect(requireRecord(secondCommitted.rotation, "second rotation").nextLeaseRef).toEqual(finalLease.leaseRef);
		await expect(previousLeaseReader.observe("workflow-rotation-killed")).rejects.toThrow(
			"workflow_append_lease_authentication_invalid",
		);
		await expect(successorLeaseReader.observe("workflow-rotation-killed")).rejects.toThrow(
			"workflow_append_lease_authentication_invalid",
		);
		const competingWorker = spawnRotationWorker(recoveryWorkerSource, ["compete"]);
		workers.push(competingWorker);
		const competingLine = await competingWorker.waitFor("competing-error:");
		expect(competingLine).toContain("workflow_append_lease_foreign_owner");
		expect((await competingWorker.waitForExit()).code).toBe(0);
	} finally {
		for (const worker of workers) await stopWorker(worker).catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 60_000);

it("keeps a live owner unstealable when a replacement identity is unverifiable", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-live-"));
	let goal: GoalState = emptyGoalState();
	const goalProjection = {
		read: (): GoalState => structuredClone(goal),
		compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
	let owner: WorkflowPhaseHost | undefined;
	try {
		owner = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId: "session-live",
			workflowId: "workflow-live",
			goalProjection,
			genesisEpoch: GENESIS_EPOCH,
			successorContextOpener: {
				openSuccessor: async () => {
					throw new Error("successor rotation is not part of this test");
				},
			},
		});
		await owner.execute({
			kind: "start",
			request: {
				workflowId: "workflow-live",
				objective: "keep live owner",
				acceptanceChecks: [],
				protectedInvariants: [],
			},
		});
		await expect(
			createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "session-live",
				workflowId: "workflow-live",
				goalProjection,
				processIdentity: "process-unverifiable",
				genesisEpoch: GENESIS_EPOCH,
				successorContextOpener: {
					openSuccessor: async () => {
						throw new Error("successor rotation is not part of this test");
					},
				},
			}),
		).rejects.toThrow("workflow_append_lease_foreign_owner");
	} finally {
		await owner?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rejects an HMAC-valid acceptance projection bound to a stale journal head", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-acceptance-head-"));
	const workflowId = "workflow-acceptance-head";
	const rootSessionId = "session-acceptance-head";
	const workflowDir = join(artifactRoot, "workflows", workflowId);
	const acceptancePath = join(workflowDir, "side-records", "acceptance.json");
	const keyPath = join(artifactRoot, "keyring", "workflows", workflowId, "side-records", "key.json");
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "bind acceptance to the current head",
				acceptanceChecks: ["head-bound"],
				protectedInvariants: ["journal-bound"],
			},
		});
		await host.dispose?.();
		host = undefined;

		const acceptance = requireRecord(
			parseCanonicalJsonBytes(await readFile(acceptancePath)),
			"acceptance projection",
		);
		const key = requireRecord(parseCanonicalJsonBytes(await readFile(keyPath)), "workflow key");
		const unsigned = {
			...acceptance,
			head: {
				...requireRecord(acceptance.head, "acceptance head"),
				sequence: 0,
				eventDigest: null,
			},
			mac: undefined,
		};
		delete unsigned.mac;
		await writeFile(
			acceptancePath,
			canonicalJsonBytes({
				...unsigned,
				mac: hmacJsonHex(Buffer.from(requireString(key.secretBase64, "workflow key secret"), "base64"), unsigned),
			}),
		);

		await expect(
			createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: createGoalProjection(),
				genesisEpoch: GENESIS_EPOCH,
			}),
		).rejects.toThrow("workflow_acceptance_projection_corrupt");
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rejects an HMAC-valid acceptance projection with a foreign generation binding", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-acceptance-generation-"));
	const workflowId = "workflow-acceptance-generation";
	const rootSessionId = "session-acceptance-generation";
	const acceptancePath = join(artifactRoot, "workflows", workflowId, "side-records", "acceptance.json");
	const keyPath = join(artifactRoot, "keyring", "workflows", workflowId, "side-records", "key.json");
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "bind acceptance to its generation",
				acceptanceChecks: ["generation-bound"],
				protectedInvariants: ["generation-bound"],
			},
		});
		await host.dispose?.();
		host = undefined;

		const acceptance = requireRecord(
			parseCanonicalJsonBytes(await readFile(acceptancePath)),
			"acceptance projection",
		);
		const key = requireRecord(parseCanonicalJsonBytes(await readFile(keyPath)), "workflow key");
		const unsigned = { ...acceptance, generationId: `generation-${"f".repeat(32)}`, mac: undefined };
		delete unsigned.mac;
		await writeFile(
			acceptancePath,
			canonicalJsonBytes({
				...unsigned,
				mac: hmacJsonHex(Buffer.from(requireString(key.secretBase64, "workflow key secret"), "base64"), unsigned),
			}),
		);

		await expect(
			createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: createGoalProjection(),
				genesisEpoch: GENESIS_EPOCH,
			}),
		).rejects.toThrow("workflow_acceptance_projection_corrupt");
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rejects an HMAC-valid acceptance intent with a foreign generation binding", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-acceptance-intent-generation-"));
	const workflowId = "workflow-acceptance-intent-generation";
	const rootSessionId = "session-acceptance-intent-generation";
	const workflowDir = join(artifactRoot, "workflows", workflowId);
	const acceptancePath = join(workflowDir, "side-records", "acceptance.json");
	const intentPath = join(workflowDir, "side-records", "acceptance-intent.json");
	const keyPath = join(artifactRoot, "keyring", "workflows", workflowId, "side-records", "key.json");
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "bind acceptance intent to its generation",
				acceptanceChecks: ["intent-generation-bound"],
				protectedInvariants: ["intent-generation-bound"],
			},
		});
		await host.dispose?.();
		host = undefined;
		await rm(acceptancePath, { force: true });

		const intent = requireRecord(parseCanonicalJsonBytes(await readFile(intentPath)), "acceptance intent");
		const key = requireRecord(parseCanonicalJsonBytes(await readFile(keyPath)), "workflow key");
		const unsigned = { ...intent, generationId: `generation-${"e".repeat(32)}`, mac: undefined };
		delete unsigned.mac;
		await writeFile(
			intentPath,
			canonicalJsonBytes({
				...unsigned,
				mac: hmacJsonHex(Buffer.from(requireString(key.secretBase64, "workflow key secret"), "base64"), unsigned),
			}),
		);

		await expect(
			createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: createGoalProjection(),
				genesisEpoch: GENESIS_EPOCH,
			}),
		).rejects.toThrow("workflow_acceptance_projection_corrupt");
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it.each(["keyId", "epoch"] as const)(
	"rejects an HMAC-valid acceptance projection with a foreign %s binding",
	async (field) => {
		await expectAcceptanceBindingMutationRejected({ kind: "projection", field });
	},
);

it.each(["keyId", "epoch"] as const)(
	"rejects an HMAC-valid acceptance intent with a foreign %s binding",
	async (field) => {
		await expectAcceptanceBindingMutationRejected({ kind: "intent", field });
	},
);

it("reopens after a committed start whose acceptance projection was not flushed", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-session-host-factory-acceptance-crash-"));
	const workflowId = "workflow-acceptance-crash";
	const rootSessionId = "session-acceptance-crash";
	const acceptancePath = join(artifactRoot, "workflows", workflowId, "side-records", "acceptance.json");
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "recover an unflushed acceptance contract",
				acceptanceChecks: ["recovered-check"],
				protectedInvariants: ["recovered-invariant"],
			},
		});
		await host.dispose?.();
		host = undefined;
		await rm(acceptancePath, { force: true });

		const reopened = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		try {
			const status = await reopened.execute({ kind: "status" });
			expect(status.acceptanceCheckIds).toEqual(["recovered-check"]);
			expect(status.protectedInvariantIds).toEqual(["recovered-invariant"]);
		} finally {
			await reopened.dispose?.();
		}
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("fails closed before opening a root when the goal projection is missing", async () => {
	await expect(
		createPersistedSessionWorkflowHost({
			artifactRoot: join(tmpdir(), "missing-session-root"),
			rootSessionId: "session-1",
			workflowId: "workflow-1",
			goalProjection: undefined,
			successorContextOpener: {
				openSuccessor: async () => {
					throw new Error("unconfigured");
				},
			},
		}),
	).rejects.toThrow("workflow_goal_projection_unavailable");
});

function createFileGoalProjection(path: string): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	const read = (): GoalState => JSON.parse(readFileSync(path, "utf8")) as GoalState;
	return {
		read,
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(read()) !== JSON.stringify(expected)) return false;
			writeFileSync(path, JSON.stringify(next));
			return true;
		},
	};
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be a record`);
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

async function expectAcceptanceBindingMutationRejected(input: {
	readonly kind: "projection" | "intent";
	readonly field: "keyId" | "epoch";
}): Promise<void> {
	const artifactRoot = await mkdtemp(join(tmpdir(), `workflow-session-host-factory-acceptance-${input.kind}-`));
	const workflowId = `workflow-acceptance-binding-${input.kind}-${input.field}`;
	const rootSessionId = `session-acceptance-binding-${input.kind}-${input.field}`;
	const workflowDir = join(artifactRoot, "workflows", workflowId);
	const acceptancePath = join(workflowDir, "side-records", "acceptance.json");
	const intentPath = join(workflowDir, "side-records", "acceptance-intent.json");
	const keyPath = join(artifactRoot, "keyring", "workflows", workflowId, "side-records", "key.json");
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: createGoalProjection(),
			genesisEpoch: GENESIS_EPOCH,
		});
		await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: `bind acceptance ${input.kind} to its authenticated tuple`,
				acceptanceChecks: ["binding-check"],
				protectedInvariants: ["binding-invariant"],
			},
		});
		await host.dispose?.();
		host = undefined;
		if (input.kind === "intent") await rm(acceptancePath, { force: true });

		const recordPath = input.kind === "projection" ? acceptancePath : intentPath;
		const record = requireRecord(parseCanonicalJsonBytes(await readFile(recordPath)), `${input.kind} record`);
		const key = requireRecord(parseCanonicalJsonBytes(await readFile(keyPath)), "workflow key");
		const unsigned = mutateAcceptanceBinding(record, input.kind, input.field, key);
		delete unsigned.mac;
		await writeFile(
			recordPath,
			canonicalJsonBytes({
				...unsigned,
				mac: hmacJsonHex(Buffer.from(requireString(key.secretBase64, "workflow key secret"), "base64"), unsigned),
			}),
		);

		await expect(
			createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: createGoalProjection(),
				genesisEpoch: GENESIS_EPOCH,
			}),
		).rejects.toThrow("workflow_acceptance_projection_corrupt");
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}

function mutateAcceptanceBinding(
	record: Record<string, unknown>,
	kind: "projection" | "intent",
	field: "keyId" | "epoch",
	key: Record<string, unknown>,
): Record<string, unknown> {
	const unsigned = { ...record };
	if (field === "keyId") {
		const currentKeyId = requireString(key.keyId, "workflow key identity");
		const foreignKeyId = `key-${"0".repeat(64)}`;
		unsigned.keyId = currentKeyId === foreignKeyId ? `key-${"1".repeat(64)}` : foreignKeyId;
		return unsigned;
	}
	const headField = kind === "projection" ? "head" : "baseHead";
	const head = requireRecord(unsigned[headField], `${kind} head`);
	const epochRef = requireRecord(head.epochRef, `${kind} epoch`);
	const coordinatorEpoch = epochRef.coordinatorEpoch;
	if (typeof coordinatorEpoch !== "number") throw new Error(`${kind} epoch must have a coordinator epoch`);
	unsigned[headField] = { ...head, epochRef: { ...epochRef, coordinatorEpoch: coordinatorEpoch + 1 } };
	return unsigned;
}

async function tamperPendingSuccessorBinding(input: {
	readonly leasePath: string;
	readonly rotationsPath: string;
	readonly rotationArtifactPath: string;
	readonly workflowId: string;
	readonly rotationId: string;
	readonly liveProcessIdentity: string;
	readonly foreignWriterIdentity: string;
	readonly previousSecret: Uint8Array;
	readonly successorSecret: Uint8Array;
}): Promise<void> {
	const records = requireRecord(parseCanonicalJsonBytes(await readFile(input.rotationsPath)), "rotation records");
	const record = requireRecord(records[input.rotationId], "rotation record");
	const request = requireRecord(record.request, "rotation request");
	const expectedHead = requireRecord(record.expectedHead, "rotation expected head");
	const nextLeaseRef = {
		...requireRecord(request.nextLeaseRef, "successor lease ref"),
		processIdentity: input.liveProcessIdentity,
		writerIdentity: input.foreignWriterIdentity,
	};
	const generationBinding = {
		...requireRecord(request.generationBinding, "successor generation binding"),
		processGenerationId: input.liveProcessIdentity,
		writerIdentity: input.foreignWriterIdentity,
		ownerIdentity: input.foreignWriterIdentity,
	};
	const authenticatedTuple = {
		workflowId: input.workflowId,
		rotationId: request.rotationId,
		mutationId: request.mutationId,
		idempotencyKey: request.idempotencyKey,
		expectedHeadDigest: request.expectedHeadDigest,
		previousEpoch: request.previousEpoch,
		nextEpoch: request.nextEpoch,
		previousGenerationId: request.previousGenerationId,
		generationId: request.generationId,
		previousWriterIdentity: request.previousWriterIdentity,
		previousLeaseRef: request.previousLeaseRef,
		nextLeaseRef,
		generationBinding,
	};
	const previousFrameBytes = canonicalJsonBytes({ role: "predecessor", authenticatedTuple });
	const successorFrameBytes = canonicalJsonBytes({ role: "successor", authenticatedTuple });
	const previousFrameMac = hmacHex(input.previousSecret, previousFrameBytes);
	const previousFrameChecksum = sha256Hex(previousFrameBytes).slice(0, 8);
	const frameMac = hmacHex(input.successorSecret, successorFrameBytes);
	const frameChecksum = sha256Hex(successorFrameBytes).slice(0, 8);
	const activeGenerationManifestRefInput = requireRecord(
		request.activeGenerationManifestRef,
		"successor active-generation ref",
	);
	const activeGenerationManifestRefForDigest = {
		...activeGenerationManifestRefInput,
		digest: "",
		sizeBytes: 0,
	};
	const manifestDigest = sha256Hex(
		canonicalJsonBytes({
			workflowId: input.workflowId,
			generationId: request.generationId,
			manifestRef: activeGenerationManifestRefForDigest,
			sourceHead: expectedHead,
			epochRef: request.nextEpoch,
			generationBinding,
			leaseRef: nextLeaseRef,
			keyId: request.keyId,
			frameMac,
			frameChecksum,
			priorRecordDigest: request.priorRecordDigest,
			manifestBytesDigest: "",
			sideRecordMac: "",
		}),
	);
	const activeGenerationManifestRef = {
		...activeGenerationManifestRefInput,
		digest: manifestDigest,
	};
	const recordBytes = canonicalJsonBytes({
		authenticatedTuple,
		previousFrameMac,
		previousFrameChecksum,
		frameMac,
		frameChecksum,
		keyId: request.keyId,
	});
	const nextRequest = {
		...request,
		previousFrameMac,
		previousFrameChecksum,
		frameMac,
		frameChecksum,
		recordMac: hmacHex(input.successorSecret, recordBytes),
		recordChecksum: sha256Hex(recordBytes).slice(0, 8),
		nextLeaseRef,
		generationBinding,
		activeGenerationManifestRef,
	};
	const rotationArtifactBytes = canonicalJsonBytes(nextRequest);
	const rotationArtifactRef = {
		...requireRecord(record.rotationArtifactRef, "rotation artifact ref"),
		digest: sha256Hex(rotationArtifactBytes),
		sizeBytes: rotationArtifactBytes.byteLength,
	};
	const nextRecordWithoutMac = {
		...record,
		request: nextRequest,
		rotationArtifactRef,
		activeGenerationManifestRef,
		checkpointDigest: digestObject({
			rotationId: input.rotationId,
			checkpoint: "after_rotation_prepare_before_fence",
			request: nextRequest,
		}),
		sideRecordMac: "",
	};
	const nextRecord = {
		...nextRecordWithoutMac,
		sideRecordMac: hmacJsonHex(input.previousSecret, nextRecordWithoutMac),
	};
	records[input.rotationId] = nextRecord;
	await writeFile(input.rotationArtifactPath, rotationArtifactBytes);
	await writeFile(input.rotationsPath, canonicalJsonBytes(records));

	const lease = requireRecord(parseCanonicalJsonBytes(await readFile(input.leasePath)), "append lease");
	const leaseRef = {
		...requireRecord(lease.leaseRef, "append lease ref"),
		processIdentity: input.liveProcessIdentity,
		writerIdentity: input.foreignWriterIdentity,
	};
	const unsignedLease = {
		version: lease.version,
		workflowId: lease.workflowId,
		status: lease.status,
		leaseRef,
		renewedAt: lease.renewedAt,
		previousLeaseDigest: lease.previousLeaseDigest,
	};
	await writeFile(
		input.leasePath,
		canonicalJsonBytes({
			...unsignedLease,
			authentication: {
				algorithm: "hmac-sha256",
				mac: hmacJsonHex(input.successorSecret, unsignedLease),
			},
		}),
	);
}

function hmacHex(secret: Uint8Array, bytes: Uint8Array): string {
	return createHmac("sha256", secret).update(bytes).digest("hex");
}

function hmacJsonHex(secret: Uint8Array, value: unknown): string {
	return hmacHex(secret, canonicalJsonBytes(value));
}
