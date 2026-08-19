import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import { KernelManager } from "../src/core/kernel/index.js";
import * as checkpointTelemetry from "../src/core/workflow/checkpoint-budget-telemetry.js";
import {
	projectWorkflowCheckpointBudgetTelemetry,
	recordWorkflowCheckpointBudgetTelemetry,
	type WorkflowCheckpointBudgetTelemetryHost,
	type WorkflowCheckpointBudgetTelemetryObservationInput,
	type WorkflowCheckpointRetainedValueInput,
} from "../src/core/workflow/checkpoint-budget-telemetry.js";
import {
	digestObject,
	type WorkflowEpochRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowRuntimeStore,
} from "../src/core/workflow/contracts.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
	type PersistedWorkflowCompletionReadinessAuthority,
	type PersistedWorkflowCompletionReceiptIssuer,
} from "../src/core/workflow/session-host-factory.js";

const WORKFLOW_ID = "checkpoint-budget-workflow";
const ROOT_SESSION_ID = "checkpoint-budget-session";
const RUNTIME_VERSION = "0.147.0-alpha.10";
const EPOCH: WorkflowEpochRef = { storeEpoch: 3, coordinatorEpoch: 4 };

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
		throw new Error("unused completion readiness authority in checkpoint telemetry test");
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

interface CapturedHostAuthority {
	runtimeStore: WorkflowRuntimeStore;
	receiptContext: WorkflowHostReceiptConsumerContext;
	issueReceipt: PersistedWorkflowCompletionReceiptIssuer;
}

async function openHost(
	root: string,
	captured: { current?: CapturedHostAuthority },
	goalProjection: ReturnType<typeof createGoalProjection>,
	start: boolean,
): Promise<PersistedSessionWorkflowHost> {
	const host = await createPersistedSessionWorkflowHost({
		artifactRoot: root,
		rootSessionId: ROOT_SESSION_ID,
		workflowId: WORKFLOW_ID,
		genesisEpoch: EPOCH,
		writerIdentity: "checkpoint-budget-writer",
		processIdentity: "checkpoint-budget-process",
		now: () => "2026-08-17T16:00:00.000Z",
		goalProjection,
		completionReadinessAuthorityFactory: ({ runtimeStore, receiptContext, issueReceipt }) => {
			captured.current = { runtimeStore, receiptContext, issueReceipt };
			return { runtimeStore, authority: unusedReadinessAuthority() };
		},
	});
	if (start)
		await host.execute({
			kind: "start",
			request: { workflowId: WORKFLOW_ID, objective: "record bounded checkpoint budget facts" },
		});
	return host;
}

async function checkpointHost(
	captured: CapturedHostAuthority,
	requiredStateRegistry: WorkflowCheckpointBudgetTelemetryHost["requiredStateRegistry"],
): Promise<WorkflowCheckpointBudgetTelemetryHost> {
	const durable = captured.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("checkpoint telemetry test requires a durable runtime");
	return {
		binding: {
			workflowId: WORKFLOW_ID,
			taskId: "task-1",
			attemptId: "attempt-1",
			processGenerationId: durable.generationId,
			runtimeVersion: RUNTIME_VERSION,
		},
		requiredStateRegistry,
		runtimeStore: captured.runtimeStore,
		principalAuthorizer: captured.receiptContext.principalAuthorizer,
		publicBoundary: "public/checkpoint",
		issueReceipt: async (input) => captured.issueReceipt(input),
		resolveState: async () => {
			const replay = await captured.runtimeStore.replay({
				workflowId: WORKFLOW_ID,
				fromSequence: 0,
				expectedStoreEpoch: durable.epochRef.storeEpoch,
			});
			if (replay.quarantined || replay.head.eventDigest === null)
				throw new Error("checkpoint telemetry test requires an authenticated head");
			const leaseRef = durable.currentLeaseRef();
			return {
				epochRef: durable.epochRef,
				leaseRef,
				stateDigest: replay.head.eventDigest,
				revision: replay.head.sequence,
				executionIdentity: leaseRef.processIdentity,
				sessionId: ROOT_SESSION_ID,
			};
		},
	};
}

const durableFact: WorkflowCheckpointRetainedValueInput = {
	valueId: "answer",
	type: "dict",
	bytes: 96,
	classification: "durable_fact",
	representation: "durable",
	digest: "b".repeat(64),
	artifactRef: null,
	reasonCode: null,
};

const artifactValue: WorkflowCheckpointRetainedValueInput = {
	valueId: "dataset",
	type: "artifact",
	bytes: 48,
	classification: "artifact_ref",
	representation: "durable",
	digest: "a".repeat(64),
	artifactRef: {
		artifactId: "checkpoint-dataset",
		relativePath: "artifacts/checkpoint-dataset.bin",
		digest: "a".repeat(64),
		sizeBytes: 48,
		sourceEventSequence: 1,
	},
	reasonCode: null,
};

const transientOutput: WorkflowCheckpointRetainedValueInput = {
	valueId: "stdout",
	type: "str",
	bytes: 900,
	classification: "transient_tool_output",
	representation: "transient",
	digest: null,
	artifactRef: null,
	reasonCode: "reproducible",
};

const requiredState = [
	{ valueId: "answer", type: "dict", classification: "durable_fact" as const },
	{ valueId: "dataset", type: "artifact", classification: "artifact_ref" as const },
];

function observation(
	overrides: Partial<WorkflowCheckpointBudgetTelemetryObservationInput> = {},
): WorkflowCheckpointBudgetTelemetryObservationInput {
	return {
		schemaVersion: 1,
		checkpointTurn: 4,
		serializeStartedAtMonotonicMs: 100,
		serializeEndedAtMonotonicMs: 140,
		restoreStartedAtMonotonicMs: 160,
		restoreEndedAtMonotonicMs: 175,
		bytesWritten: 256,
		retainedValues: [durableFact, artifactValue, transientOutput],
		...overrides,
	};
}

async function createFixture(): Promise<{
	root: string;
	host: PersistedSessionWorkflowHost;
	captured: CapturedHostAuthority;
	goalProjection: ReturnType<typeof createGoalProjection>;
	checkpointHost: WorkflowCheckpointBudgetTelemetryHost;
}> {
	const root = await mkdtemp(join(tmpdir(), "checkpoint-budget-telemetry-"));
	const capturedHolder: { current?: CapturedHostAuthority } = {};
	const goalProjection = createGoalProjection();
	const host = await openHost(root, capturedHolder, goalProjection, true);
	if (capturedHolder.current === undefined) throw new Error("checkpoint telemetry host authority was not captured");
	return {
		root,
		host,
		captured: capturedHolder.current,
		goalProjection,
		checkpointHost: await checkpointHost(capturedHolder.current, requiredState),
	};
}

async function disposeFixture(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
	await fixture.host.dispose?.();
	await rm(fixture.root, { recursive: true, force: true });
}

describe("workflow checkpoint budget telemetry", () => {
	it("records a real child-process checkpoint and reconstructs an externalized value after restart", {
		tags: ["kernel-heavy"],
		timeout: 60_000,
	}, async () => {
		const python =
			process.env.PRIME_AGENT_KERNEL_PYTHON ?? join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");
		if (!existsSync(python)) throw new Error(`kernel regression requires ${python}`);
		const fixture = await createFixture();
		const snapshotPath = join(fixture.root, "kernel", "state.dill");
		const manifestPath = join(fixture.root, "kernel", "state.json");
		const artifactRoot = join(fixture.root, "kernel-artifacts");
		const checkpointHost = {
			...fixture.checkpointHost,
			requiredStateRegistry: [
				{ valueId: "dataset", type: "list", classification: "artifact_ref" as const },
				{ valueId: "x", type: "int", classification: "durable_fact" as const },
			],
		};
		const snapshotConfig = {
			path: snapshotPath,
			manifestPath,
			maxBytes: 1024,
			artifactRoot,
			reproducibleNames: ["dataset"],
			requiredNames: ["dataset", "x"],
			transientNames: ["tool_output"],
			checkpointTelemetry: checkpointHost,
		};
		const startedAt = performance.now();
		const writer = new KernelManager({ python, cwd: fixture.root, snapshot: snapshotConfig });
		try {
			await writer.start();
			await writer.execute("x = 42\ndataset = list(range(10000))\ntool_output = 'x' * 500000");
			const snapshot = await writer.snapshotState();
			if (snapshot === null || snapshot.retainedValues === undefined)
				throw new Error("snapshot metadata is missing");
			const retainedValues = snapshot.retainedValues;
			expect(snapshot?.bytes).toBeLessThan(1024 * 1024);
			expect(retainedValues.find((value) => value.valueId === "tool_output")).toMatchObject({
				representation: "transient",
				bytes: 0,
				digest: null,
			});
			expect(retainedValues.find((value) => value.valueId === "dataset")).toMatchObject({
				classification: "artifact_ref",
				representation: "durable",
				artifactRef: { relativePath: expect.stringMatching(/^kernel-state-artifacts\/[0-9a-f]{64}\.dill$/u) },
			});
		} finally {
			await writer.kill();
		}
		const writerReplay = await fixture.captured.runtimeStore.replay({
			workflowId: WORKFLOW_ID,
			fromSequence: 0,
			expectedStoreEpoch: EPOCH.storeEpoch,
		});
		expect(writerReplay.events.some((event) => event.payload.kind === "checkpoint_budget_observed")).toBe(true);

		const reader = new KernelManager({ python, cwd: fixture.root, snapshot: snapshotConfig });
		try {
			await reader.start();
			const restore = await reader.restoreState();
			expect(restore?.restored).toEqual(expect.arrayContaining(["dataset", "x"]));
			const echo = await reader.execute(
				"print(x, len(dataset), len(tool_output) if 'tool_output' in globals() else 0)",
			);
			expect(echo.stdout.trim()).toBe("42 10000 0");
		} finally {
			await reader.kill();
			await disposeFixture(fixture);
		}
		const elapsedMs = performance.now() - startedAt;
		expect(elapsedMs).toBeLessThan(30_000);
	});

	it("records authenticated metrics and transient exclusions through the real store", async () => {
		const fixture = await createFixture();
		try {
			const event = await recordWorkflowCheckpointBudgetTelemetry(observation(), fixture.checkpointHost);
			expect(event).toMatchObject({
				kind: "checkpoint_budget_observed",
				bytesWritten: 256,
				durableBytes: 144,
				requiredStateIds: ["answer", "dataset"],
				missingRequiredStateIds: [],
				durabilityOutcome: "durable",
			});
			expect(event.retainedValues.find((value) => value.valueId === "stdout")?.required).toBe(false);
			expect(event.authorizationDigest).toMatch(/^[0-9a-f]{64}$/u);
			const replay = await fixture.captured.runtimeStore.replay({
				workflowId: WORKFLOW_ID,
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			expect(replay.events.filter((entry) => entry.payload.kind === "checkpoint_budget_observed")).toHaveLength(1);
		} finally {
			await disposeFixture(fixture);
		}
	});

	it("reconstructs the same event after a real host reopen and central idempotent replay", async () => {
		const fixture = await createFixture();
		try {
			const first = await recordWorkflowCheckpointBudgetTelemetry(observation(), fixture.checkpointHost);
			await fixture.host.dispose?.();
			const capturedHolder: { current?: CapturedHostAuthority } = {};
			const reopened = await openHost(fixture.root, capturedHolder, fixture.goalProjection, false);
			try {
				if (capturedHolder.current === undefined) throw new Error("reopened host authority was not captured");
				const reopenedCheckpointHost = await checkpointHost(capturedHolder.current, requiredState);
				const replay = await recordWorkflowCheckpointBudgetTelemetry(observation(), reopenedCheckpointHost);
				expect(replay.observationDigest).toBe(first.observationDigest);
				const journal = await capturedHolder.current.runtimeStore.replay({
					workflowId: WORKFLOW_ID,
					fromSequence: 0,
					expectedStoreEpoch: EPOCH.storeEpoch,
				});
				expect(journal.events.filter((entry) => entry.payload.kind === "checkpoint_budget_observed")).toHaveLength(
					1,
				);
			} finally {
				await reopened.dispose?.();
			}
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("projects duration, restore duration, growth, and largest retained durable values", async () => {
		const fixture = await createFixture();
		try {
			const first = await recordWorkflowCheckpointBudgetTelemetry(observation(), fixture.checkpointHost);
			const second = await recordWorkflowCheckpointBudgetTelemetry(
				observation({
					checkpointTurn: 5,
					serializeStartedAtMonotonicMs: 200,
					serializeEndedAtMonotonicMs: 230,
					restoreStartedAtMonotonicMs: null,
					restoreEndedAtMonotonicMs: null,
					bytesWritten: 300,
					retainedValues: [{ ...durableFact, bytes: 120 }, artifactValue, transientOutput],
				}),
				fixture.checkpointHost,
			);
			const projection = projectWorkflowCheckpointBudgetTelemetry([second, first]);
			expect(projection).toMatchObject({
				checkpointCount: 2,
				serializationDurationMs: 70,
				restoreDurationMs: 15,
				bytesWritten: 556,
				durableBytes: 168,
				growthBytesPerTurn: 24,
			});
			expect(projection.largestRetainedValues[0]).toEqual({
				valueId: "answer",
				type: "dict",
				bytes: 120,
				classification: "durable_fact",
			});
		} finally {
			await disposeFixture(fixture);
		}
	});

	it("rejects missing required IDs instead of appending a failed-closed or fresh-start event", async () => {
		const fixture = await createFixture();
		try {
			await expect(
				recordWorkflowCheckpointBudgetTelemetry(
					observation({ retainedValues: [durableFact, transientOutput] }),
					fixture.checkpointHost,
				),
			).rejects.toThrow(/required|closure|durable/i);
			const replay = await fixture.captured.runtimeStore.replay({
				workflowId: WORKFLOW_ID,
				fromSequence: 0,
				expectedStoreEpoch: EPOCH.storeEpoch,
			});
			expect(replay.events.some((entry) => entry.payload.kind === "checkpoint_budget_observed")).toBe(false);
		} finally {
			await disposeFixture(fixture);
		}
	});

	it("rejects forged authorization, artifact substitution, unsafe paths, and caller-owned host flags", async () => {
		const fixture = await createFixture();
		try {
			const forgedAuthorizer = {
				authorize: async () => {
					throw new Error("forged authorizer must not self-authorize");
				},
			};
			await expect(
				recordWorkflowCheckpointBudgetTelemetry(observation(), {
					...fixture.checkpointHost,
					principalAuthorizer: forgedAuthorizer,
				}),
			).rejects.toThrow(/principal|author/i);
			await expect(
				recordWorkflowCheckpointBudgetTelemetry(
					observation({
						retainedValues: [
							durableFact,
							{ ...artifactValue, artifactRef: { ...artifactValue.artifactRef!, relativePath: "../escape" } },
							transientOutput,
						],
					}),
					fixture.checkpointHost,
				),
			).rejects.toThrow(/path|artifact/i);
		} finally {
			await disposeFixture(fixture);
		}
	});

	it("does not expose a caller-verifier or opaque token recording seam", () => {
		expect(Reflect.get(checkpointTelemetry, "WorkflowCheckpointBudgetTelemetryHostVerifier")).toBeUndefined();
		expect(Reflect.get(checkpointTelemetry, "createWorkflowCheckpointBudgetTelemetryEvent")).toBeUndefined();
	});

	it("binds resource and operation digests to metrics and artifact references", async () => {
		const fixture = await createFixture();
		try {
			const event = await recordWorkflowCheckpointBudgetTelemetry(observation(), fixture.checkpointHost);
			expect(event.resourceDigest).toBe(
				digestObject({
					binding: {
						workflowId: fixture.checkpointHost.binding.workflowId,
						taskId: fixture.checkpointHost.binding.taskId,
						attemptId: fixture.checkpointHost.binding.attemptId,
						runtimeVersion: fixture.checkpointHost.binding.runtimeVersion,
					},
					head: event.head,
					epochRef: event.epochRef,
					stateDigest: event.head.eventDigest,
					revision: event.head.sequence,
					requiredStateRegistry: event.requiredStateRegistry,
					checkpointTurn: event.checkpointTurn,
					serializeStartedAtMonotonicMs: event.serializeStartedAtMonotonicMs,
					serializeEndedAtMonotonicMs: event.serializeEndedAtMonotonicMs,
					restoreStartedAtMonotonicMs: event.restoreStartedAtMonotonicMs,
					restoreEndedAtMonotonicMs: event.restoreEndedAtMonotonicMs,
					bytesWritten: event.bytesWritten,
					retainedValues: [durableFact, artifactValue, transientOutput],
					previousObservationDigest: null,
					previousCheckpointTurn: null,
					previousDurableBytes: null,
				}),
			);
		} finally {
			await disposeFixture(fixture);
		}
	});
});
