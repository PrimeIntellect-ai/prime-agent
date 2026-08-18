import { readFileSync, writeFileSync } from "node:fs";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDaemonUpdateRestartManifestPath } from "../../../src/config.js";
import type { SessionActionRecoverySnapshot } from "../../../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import type { AgentCronJob, AgentCronJobStore, AgentCronScheduler } from "../../../src/core/cron-jobs.js";
import { type CustomMessage, createSessionSlashCommandMessage } from "../../../src/core/messages.js";
import { parseSessionSlashCommand } from "../../../src/core/slash-commands.js";
import type { BashOperations } from "../../../src/core/tools/bash.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import type { DaemonUpdateRestartManifest } from "../../../src/modes/daemon/daemon-protocol.js";
import { MutationDrainLatch } from "../../../src/modes/daemon/mutation-drain-latch.js";
import { prepareDaemonUpdateRestart } from "../../../src/package-manager-cli.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

type AgentDaemonUpdateInternals = {
	sessions: Map<string, ActiveSessionState>;
	cronStore: AgentCronJobStore;
	cronScheduler: AgentCronScheduler;
	runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
	prepareUpdateRestart(): Promise<DaemonUpdateRestartManifest>;
	beginUpdateRestartTransaction(owner?: DaemonSocketClient): NonNullable<AgentDaemonUpdateInternals["updateRestart"]>;
	runUpdateRestartPreparation(
		transaction: NonNullable<AgentDaemonUpdateInternals["updateRestart"]>,
	): Promise<DaemonUpdateRestartManifest>;
	prepareUpdateRestartCheckpoint(
		transaction: NonNullable<AgentDaemonUpdateInternals["updateRestart"]>,
	): Promise<DaemonUpdateRestartManifest>;
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
	handleWorkerCommand(client: DaemonSocketClient, command: { id: string; type: string }): Promise<void>;
	mutationDrain: { begin(): void; end(): void };
	updateRestart?: {
		id: symbol;
		abort: AbortController;
		phase: "preparing" | "fencing" | "prepared" | "publishing";
		manifest?: DaemonUpdateRestartManifest;
		owner?: DaemonSocketClient;
		deferredClientEnv: Array<{
			client: DaemonSocketClient;
			state: ActiveSessionState;
			env: Record<string, string>;
		}>;
	};
	supervisorClaims: Map<DaemonSocketClient, unknown>;
	revokeSupervisorClaim(client: DaemonSocketClient): boolean;
	shutdown(exitCode: number): Promise<never>;
	getShutdownClosingReason(): "update" | "shutdown";
	cancelPreparedUpdateRestart(transactionId?: symbol): void;
	commitPreparedUpdateRestart(transactionId: symbol): Promise<DaemonUpdateRestartManifest>;
};

function createState(
	harness: Harness,
	activeSessionId: string,
	metadata: AgentSessionRuntime["metadata"],
	options: { clientEnv?: Record<string, string>; onDispose?: () => void } = {},
): ActiveSessionState {
	const runtime = {
		session: harness.session,
		metadata,
		cwd: harness.tempDir,
		runtimeConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
		diagnostics: [],
		dispose: async () => {
			options.onDispose?.();
		},
	} as unknown as AgentSessionRuntime;
	return {
		activeSessionId,
		runtime,
		clients: new Set(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: `generation-${activeSessionId}`,
		lastEventSequence: 0,
		...(options.clientEnv ? { clientEnv: options.clientEnv } : {}),
	};
}

function createDaemonInternals(
	harness: Harness,
	options: { sessionDir?: string; worker?: boolean } = {},
): AgentDaemonUpdateInternals {
	const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
		defaultSessionConfig: {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
		},
		...(options.worker ? { worker: { authenticationToken: "token" } } : {}),
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	return daemon as unknown as AgentDaemonUpdateInternals;
}

function createWriteClient(writes: string[], options: { id?: string; attached?: string[] } = {}): DaemonSocketClient {
	return {
		id: options.id ?? "client-1",
		socket: {
			destroyed: false,
			write: vi.fn((chunk: string) => {
				writes.push(chunk);
				return true;
			}),
		} as unknown as DaemonSocketClient["socket"],
		attachedActiveSessionIds: new Set(options.attached ?? []),
		detachInput: vi.fn(),
		supportsExtensionUi: false,
		capabilities: new Set(),
	} as DaemonSocketClient;
}

function hasArchivedState(harness: Harness): boolean {
	return harness.sessionManager
		.getEntries()
		.some((entry) => entry.type === "session_state" && entry.state.status === "archived");
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not met");
}

function createCustomMessage(content: string): CustomMessage {
	return {
		role: "custom",
		customType: "prime-agent.test",
		content,
		display: false,
		timestamp: Date.now(),
	};
}

describe("issue #4257 update restart resume", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each([
		[undefined, "shutdown"],
		["preparing", "shutdown"],
		["fencing", "shutdown"],
		["prepared", "shutdown"],
		["publishing", "update"],
	] as const)("uses %s restart phase as %s shutdown", async (phase, expected) => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = createDaemonInternals(harness);
		if (phase) {
			internals.updateRestart = {
				id: Symbol("update-restart"),
				abort: new AbortController(),
				phase,
				deferredClientEnv: [],
			};
		}

		expect(internals.getShutdownClosingReason()).toBe(expected);
	});

	it("waits for the admitted prompt event checkpoint before preparing restart", async () => {
		let releaseAssistantMessageEnd: (() => void) | undefined;
		const assistantMessageEndBlocked = new Promise<void>((resolve) => {
			releaseAssistantMessageEnd = resolve;
		});
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant") {
							await assistantMessageEndBlocked;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("restart response")]);
		let promptAdmitted = false;
		const originalPrompt = harness.session.agent.prompt.bind(harness.session.agent);
		vi.spyOn(harness.session.agent, "prompt").mockImplementation((...args) => {
			promptAdmitted = true;
			return originalPrompt(...args);
		});
		await harness.session.restoreFollowUpMessage("admitted restart input");
		expect(harness.session.resumeQueuedWork()).toBe(true);
		await vi.waitFor(() => expect(promptAdmitted).toBe(true));

		const internals = createDaemonInternals(harness);
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);
		let checkpointWaitEntered = false;
		const originalCheckpointWait = harness.session.waitForSessionInputCheckpoint.bind(harness.session);
		vi.spyOn(harness.session, "waitForSessionInputCheckpoint").mockImplementation((signal) => {
			checkpointWaitEntered = true;
			return originalCheckpointWait(signal);
		});
		let prepareSettled = false;
		const prepare = internals.prepareUpdateRestart().then((manifest) => {
			prepareSettled = true;
			return manifest;
		});
		await vi.waitFor(() => expect(checkpointWaitEntered).toBe(true));
		await harness.session.restoreFollowUpMessage("paused restart input");
		await vi.waitFor(() =>
			expect(
				harness.sessionManager
					.getEntries()
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							getMessageText(entry.message) === "admitted restart input",
					),
			).toBe(true),
		);
		expect(prepareSettled).toBe(false);

		releaseAssistantMessageEnd?.();
		const manifest = await prepare;

		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0]).toMatchObject({
			queue: { nextTurn: [], actions: { formatVersion: 1 } },
			shouldResume: true,
			wasStreaming: false,
			wasRetrying: false,
			hadAcceptedPromptInFlight: false,
		});
		expect(manifest.sessions[0]?.queue.actions.actions).toEqual([
			expect.objectContaining({
				delivery: "when_run_idle",
				payload: expect.objectContaining({ kind: "turn", text: "paused restart input" }),
			}),
		]);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						getMessageText(entry.message) === "restart response",
				),
		).toBe(true);
	});

	it.each([
		{ name: "worker cancel releases a prepare blocked on an executing mutation", release: "cancel" },
		{ name: "standalone prepare waits for an executing daemon mutation", release: "drain" },
	] as const)("$name", async ({ release }) => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = createDaemonInternals(harness, { worker: true });
		internals.mutationDrain.begin();
		const writes: string[] = [];
		const client = {
			id: "supervisor",
			socket: {
				destroyed: false,
				write: (chunk: string) => {
					writes.push(chunk);
					return true;
				},
			},
		} as unknown as DaemonSocketClient;

		if (release === "cancel") {
			const prepare = internals.handleWorkerCommand(client, { id: "prepare", type: "worker_prepare_update" });
			await vi.waitFor(() => expect(internals.updateRestart).toBeDefined());
			await internals.handleWorkerCommand(client, { id: "cancel", type: "worker_cancel_update" });
			await prepare;

			expect(internals.updateRestart).toBeUndefined();
			expect(writes.join(" ")).toContain("Update restart preparation cancelled");
			expect(writes.join(" ")).toContain('"command":"worker_cancel_update","success":true');
			return;
		}
		let settled = false;
		const prepare = internals.prepareUpdateRestart().then((manifest) => {
			settled = true;
			return manifest;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		internals.mutationDrain.end();
		await prepare;
		expect(settled).toBe(true);
	});

	it("fences and drains a mutation admitted at the first drain boundary before checkpointing", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = createDaemonInternals(harness);
		const mutationDrain = new MutationDrainLatch();
		const transaction = {
			id: Symbol("update-restart"),
			abort: new AbortController(),
			phase: "preparing" as const,
			deferredClientEnv: [],
		};
		internals.updateRestart = transaction;
		const firstDrain = createDeferred();
		const originalWaitForDrain = mutationDrain.waitForDrain.bind(mutationDrain);
		vi.spyOn(mutationDrain, "waitForDrain").mockImplementationOnce(async (...args) => {
			await originalWaitForDrain(...args);
			mutationDrain.begin();
			firstDrain.resolve();
		});
		Reflect.set(internals, "mutationDrain", mutationDrain);
		const checkpoint = vi.spyOn(internals, "prepareUpdateRestartCheckpoint").mockResolvedValue({
			formatVersion: 1,
			createdAt: "now",
			sessions: [],
		});

		const prepare = internals.runUpdateRestartPreparation(transaction);
		await firstDrain.promise;
		await Promise.resolve();

		expect(internals.updateRestart?.phase).toBe("fencing");
		expect(checkpoint).not.toHaveBeenCalled();

		mutationDrain.end();
		await prepare;
		expect(checkpoint).toHaveBeenCalledOnce();
	});

	it("waits for an already-claimed one-shot dispatch and runs it exactly once", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("scheduled response")]);
		const promptSpy = vi.spyOn(harness.session, "promptUntilAccepted");
		const state = createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() });
		const internals = createDaemonInternals(harness);
		internals.sessions.set(state.activeSessionId, state);
		const now = new Date("2026-01-01T12:00:00.000Z");
		const job = internals.cronStore.create({
			activeSessionId: state.activeSessionId,
			sessionId: harness.session.sessionId,
			sessionFile: harness.session.sessionFile ?? "",
			cwd: harness.tempDir,
			scheduleText: "in 1m",
			prompt: "claimed before restart",
			now,
		});
		let markDispatchReached = () => {};
		const dispatchReached = new Promise<void>((resolve) => {
			markDispatchReached = resolve;
		});
		let releaseDispatch = () => {};
		const dispatchGate = new Promise<void>((resolve) => {
			releaseDispatch = resolve;
		});
		const originalRunCronJob = internals.runCronJob.bind(internals);
		let runResult: "skipped" | undefined;
		vi.spyOn(internals, "runCronJob").mockImplementation(async (claimedJob) => {
			markDispatchReached();
			await dispatchGate;
			runResult = await originalRunCronJob(claimedJob);
			return runResult;
		});

		const dispatch = internals.cronScheduler.runDue(new Date("2026-01-01T12:01:00.000Z"));
		await dispatchReached;
		let prepareSettled = false;
		const prepare = internals.prepareUpdateRestart().then((manifest) => {
			prepareSettled = true;
			return manifest;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(prepareSettled).toBe(false);

		releaseDispatch();
		await dispatch;
		await prepare;
		expect(runResult).toBeUndefined();
		expect(promptSpy).toHaveBeenCalledOnce();
		expect(promptSpy).toHaveBeenCalledWith(
			"claimed before restart",
			expect.objectContaining({ streamingBehavior: "followUp", source: "rpc" }),
		);
		expect(internals.cronStore.list().find((candidate) => candidate.id === job.id)).toMatchObject({
			status: "completed",
			runCount: 1,
		});
	});

	type OwnershipContext = {
		internals: AgentDaemonUpdateInternals;
		makeClient: (id: string) => DaemonSocketClient;
		writes: string[];
	};

	it.each<{ name: string; run: (context: OwnershipContext) => Promise<void> }>([
		...(["worker_commit_update", "worker_cancel_update"] as const).map((type) => ({
			name: `rejects ${type} from a different prepare owner`,
			run: async ({ internals, makeClient, writes }: OwnershipContext) => {
				const owner = makeClient("owner");
				await internals.handleWorkerCommand(owner, { id: "prepare", type: "worker_prepare_update" });
				await internals.handleWorkerCommand(makeClient("other"), { id: "foreign", type });
				expect(writes.at(-1)).toContain("belongs to another supervisor");
				expect(internals.updateRestart?.phase).toBe("prepared");
				await internals.handleWorkerCommand(owner, { id: "cleanup", type: "worker_cancel_update" });
			},
		})),
		{
			name: "rejects a duplicate worker commit while publishing",
			run: async ({ internals, makeClient, writes }) => {
				const owner = makeClient("owner");
				await internals.handleWorkerCommand(owner, { id: "prepare", type: "worker_prepare_update" });
				const transaction = internals.updateRestart;
				expect(transaction).toBeDefined();
				transaction!.phase = "publishing";

				await internals.handleWorkerCommand(owner, { id: "duplicate", type: "worker_commit_update" });

				expect(writes.at(-1)).toContain("already committing");
				transaction!.phase = "prepared";
				internals.cancelPreparedUpdateRestart(transaction?.id);
			},
		},
		{
			name: "finishes cancelled transaction cleanup after a failed publish",
			run: async ({ internals, makeClient }) => {
				const owner = makeClient("owner");
				await internals.handleWorkerCommand(owner, { id: "prepare", type: "worker_prepare_update" });
				const transaction = internals.updateRestart;
				expect(transaction).toBeDefined();
				vi.spyOn(internals, "commitPreparedUpdateRestart").mockImplementationOnce(async () => {
					internals.cancelPreparedUpdateRestart(transaction?.id);
					throw new Error("publish failed");
				});

				await internals.handleWorkerCommand(owner, { id: "commit", type: "worker_commit_update" });

				expect(internals.updateRestart).toBeUndefined();
			},
		},
		{
			name: "finishes publishing then exits when its owning supervisor is replaced",
			run: async ({ internals, makeClient }) => {
				const owner = makeClient("owner");
				internals.supervisorClaims.set(owner, {});
				await internals.handleWorkerCommand(owner, { id: "prepare", type: "worker_prepare_update" });
				const transaction = internals.updateRestart;
				expect(transaction).toBeDefined();
				const publish = createDeferred<DaemonUpdateRestartManifest>();
				vi.spyOn(internals, "commitPreparedUpdateRestart").mockImplementationOnce(() => publish.promise);
				const shutdown = vi.spyOn(internals, "shutdown").mockImplementation(() => new Promise<never>(() => {}));

				const commit = internals.handleWorkerCommand(owner, { id: "commit", type: "worker_commit_update" });
				await vi.waitFor(() => expect(transaction?.phase).toBe("publishing"));
				internals.revokeSupervisorClaim(owner);
				expect(transaction?.phase).toBe("publishing");
				publish.resolve(transaction!.manifest!);
				await commit;
				await new Promise<void>((resolve) => setImmediate(resolve));

				expect(shutdown).toHaveBeenCalledWith(0);
			},
		},
		{
			name: "does not let stale standalone cleanup clear a newer publishing owner",
			run: async ({ internals }) => {
				const newerTransaction = {
					id: Symbol("newer-update-restart"),
					abort: new AbortController(),
					phase: "publishing" as const,
					deferredClientEnv: [],
				};
				vi.spyOn(internals, "commitPreparedUpdateRestart").mockImplementationOnce(async () => {
					internals.updateRestart = newerTransaction;
					throw new Error("stale publish failed");
				});

				await expect(internals.prepareUpdateRestart()).rejects.toThrow("stale publish failed");

				expect(internals.updateRestart).toBe(newerTransaction);
			},
		},
		{
			name: "rejects drain mutations but admits reads after this worker publishes its prepare snapshot",
			run: async ({ internals, makeClient, writes }) => {
				const owner = makeClient("owner");
				await internals.handleWorkerCommand(owner, { id: "prepare", type: "worker_prepare_update" });
				await internals.handleLine(
					owner,
					JSON.stringify({ id: "abort", type: "abort", activeSessionId: "missing" }),
				);
				expect(writes.at(-1)).toContain("Daemon is preparing an update restart");
				await internals.handleLine(owner, JSON.stringify({ id: "late-list", type: "list" }));
				expect(JSON.parse(writes.at(-1) ?? "{}")).toMatchObject({ id: "late-list", success: true });
				await internals.handleWorkerCommand(owner, { id: "cancel", type: "worker_cancel_update" });
			},
		},
	])("$name", async ({ run }) => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = createDaemonInternals(harness);
		const writes: string[] = [];
		const makeClient = (id: string) =>
			({
				id,
				socket: {
					destroyed: false,
					write: (chunk: string) => {
						writes.push(chunk);
						return true;
					},
				},
			}) as unknown as DaemonSocketClient;
		await run({ internals, makeClient, writes });
	});

	it("captures a restart manifest and aborts running bash without archiving the session", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.session.recordBashResult("echo before", {
			output: "before",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				return await new Promise<{ exitCode: number | null }>((resolve) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							resolve({ exitCode: null });
						},
						{ once: true },
					);
				});
			},
		};
		const bashPromise = harness.session.executeBash("sleep", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isBashRunning).toBe(true);
		const abortSpy = vi.spyOn(harness.session, "abort");
		const agentAbortSpy = vi.spyOn(harness.session.agent, "abort");

		let disposed = false;
		let abortedBeforeDispose = false;
		const state = createState(
			harness,
			"active-1",
			{ kind: "top-level", createdAt: Date.now() },
			{
				onDispose: () => {
					abortedBeforeDispose = agentAbortSpy.mock.calls.length > 0;
					disposed = true;
				},
			},
		);
		const internals = createDaemonInternals(harness);
		internals.sessions.set(state.activeSessionId, state);
		const schedulerStopSpy = vi.spyOn(internals.cronScheduler, "stop");
		const now = new Date("2026-01-01T12:00:00.000Z");
		const cron = internals.cronStore.create({
			activeSessionId: state.activeSessionId,
			sessionId: harness.session.sessionId,
			sessionFile: harness.session.sessionFile ?? "",
			cwd: harness.tempDir,
			scheduleText: "in 1h",
			prompt: "check long run",
			now,
		});
		const heartbeat = internals.cronStore.createHeartbeat({
			activeSessionId: state.activeSessionId,
			sessionId: harness.session.sessionId,
			sessionFile: harness.session.sessionFile ?? "",
			cwd: harness.tempDir,
			scheduleText: "every 5m",
			prompt: "keep working",
			now,
		});

		const manifest = await internals.prepareUpdateRestart();
		const bashResult = await bashPromise;

		expect(bashResult.cancelled).toBe(true);
		expect(abortSpy).not.toHaveBeenCalled();
		expect(agentAbortSpy).toHaveBeenCalledOnce();
		expect(abortedBeforeDispose).toBe(true);
		expect(disposed).toBe(true);
		expect(internals.sessions.size).toBe(0);
		expect(schedulerStopSpy).toHaveBeenCalledOnce();
		for (const id of [cron.id, heartbeat.id]) {
			expect(internals.cronStore.list().find((job) => job.id === id)).toMatchObject({ status: "active" });
		}
		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0]).toMatchObject({
			activeSessionId: "active-1",
			sessionFile: harness.session.sessionFile,
			shouldResume: true,
			wasBashRunning: true,
		});
		const persistedManifest = JSON.parse(
			readFileSync(getDaemonUpdateRestartManifestPath(`${harness.tempDir}/daemon.sock`, harness.tempDir), "utf-8"),
		) as DaemonUpdateRestartManifest;
		expect(persistedManifest).toEqual(manifest);
		writeFileSync(
			getDaemonUpdateRestartManifestPath(`${harness.tempDir}/missing.sock`, harness.tempDir),
			JSON.stringify(manifest),
		);
		await expect(prepareDaemonUpdateRestart(`${harness.tempDir}/missing.sock`, harness.tempDir)).resolves.toEqual(
			manifest,
		);
		await expect(prepareDaemonUpdateRestart(`${harness.tempDir}/unrelated.sock`, harness.tempDir)).rejects.toThrow();
		expect(hasArchivedState(harness)).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "prime-agent.update_restart"),
		).toBe(true);
		abortSpy.mockRestore();
		agentAbortSpy.mockRestore();
		schedulerStopSpy.mockRestore();
	});

	it("keeps active goal abort state until update restart abort settles", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the update-safe task" });
		let releaseIdle: (() => void) | undefined;
		const idlePromise = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const waitForIdleSpy = vi.spyOn(harness.session.agent, "waitForIdle").mockReturnValue(idlePromise);
		const agentAbortSpy = vi.spyOn(harness.session.agent, "abort");
		const internals = harness.session as unknown as { _goalAbortInProgress: boolean };

		harness.session.abortForUpdateRestart();

		expect(agentAbortSpy).toHaveBeenCalledOnce();
		expect(internals._goalAbortInProgress).toBe(true);

		releaseIdle?.();
		await waitForCondition(() => !internals._goalAbortInProgress);

		expect(internals._goalAbortInProgress).toBe(false);
		waitForIdleSpy.mockRestore();
		agentAbortSpy.mockRestore();
	});

	it("rolls back a preselected prompt when update restart pauses the pump", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const idleReached = createDeferred();
		const idleGate = createDeferred();
		const originalWaitForIdle = harness.session.agent.waitForIdle.bind(harness.session.agent);
		let gateIdle = true;
		const waitForIdleSpy = vi.spyOn(harness.session.agent, "waitForIdle").mockImplementation(async () => {
			if (gateIdle) {
				gateIdle = false;
				idleReached.resolve();
				await idleGate.promise;
			}
			await originalWaitForIdle();
		});
		const prompt = harness.session.prompt("paused before selection");
		await idleReached.promise;

		const pause = harness.session.acquireQueuedWorkPause();
		const checkpoint = harness.session.waitForSessionInputCheckpoint(AbortSignal.timeout(1000));
		idleGate.resolve();

		await expect(checkpoint).resolves.toBeUndefined();
		expect(harness.session.getSessionActionRecoverySnapshot().actions.map((action) => action.payload.text)).toEqual([
			"paused before selection",
		]);
		pause.release();
		await prompt;
		expect(getUserTexts(harness)).toEqual(["paused before selection"]);
		waitForIdleSpy.mockRestore();
	});

	it("rejects new daemon sessions after update restart preparation starts", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const createRuntime = vi.fn(async () => {
			throw new Error("unexpected runtime creation");
		});
		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime,
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		await internals.prepareUpdateRestart();
		const writes: string[] = [];
		const client = createWriteClient(writes);

		await internals.handleLine(client, JSON.stringify({ id: "late-create", type: "create" }));

		expect(createRuntime).not.toHaveBeenCalled();
		expect(JSON.parse(writes.join("").trim())).toMatchObject({
			id: "late-create",
			type: "response",
			command: "create",
			success: false,
		});
	});

	it("keeps queued draft sessions and subagents resumable", async () => {
		const parentHarness = await createHarness({ persistSession: true });
		const childHarness = await createHarness({ persistSession: true });
		harnesses.push(parentHarness, childHarness);

		const image: ImageContent = { type: "image", data: "ZmFrZQ==", mimeType: "image/png" };
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: "queued work" }, image];
		const queuedContext = createCustomMessage("queued context");
		const followUpContent: TextContent[] = [{ type: "text", text: "heartbeat" }];
		const followUpContext = createCustomMessage("follow-up context");
		const customFollowUp = createCustomMessage("custom heartbeat");
		await parentHarness.session.restoreSteeringMessage("queued work", [image], {
			queueKey: "heartbeat:steer",
			agentMessageId: "agentmsg_steer",
			content,
			prefixMessages: [queuedContext],
		});
		await parentHarness.session.restoreFollowUpMessage("heartbeat", undefined, {
			queueKey: "heartbeat:job-1",
			agentMessageId: "agentmsg_followup",
			content: followUpContent,
			prefixMessages: [followUpContext],
		});
		await parentHarness.session.restoreFollowUpMessage("custom heartbeat", undefined, {
			queueKey: "heartbeat:custom",
			agentMessageId: "agentmsg_custom",
			customMessage: customFollowUp,
		});
		const command = parseSessionSlashCommand("/autonomous on");
		const commandMessage = createSessionSlashCommandMessage(command!);
		await parentHarness.session.restoreFollowUpMessage("/autonomous on", undefined, {
			customMessage: commandMessage,
		});
		childHarness.session.recordBashResult("echo child", {
			output: "child",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		const internals = createDaemonInternals(parentHarness);
		internals.sessions.set(
			"parent-active",
			createState(
				parentHarness,
				"parent-active",
				{ kind: "top-level", createdAt: Date.now() },
				{ clientEnv: { PRIME_SESSION: "pane-1" } },
			),
		);
		internals.sessions.set(
			"child-active",
			createState(childHarness, "child-active", {
				kind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: parentHarness.session.sessionId,
				parentSessionFile: parentHarness.session.sessionFile,
				createdAt: Date.now(),
				rlmChildId: "child-1",
			}),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(internals.sessions.size).toBe(0);
		expect(manifest.sessions).toHaveLength(2);
		expect(manifest.sessions[0]).toMatchObject({
			activeSessionId: "parent-active",
			clientEnv: { PRIME_SESSION: "pane-1" },
			runtimeMetadata: { kind: "top-level" },
			queue: { actions: { formatVersion: 1 }, nextTurn: [] },
			shouldResume: true,
		});
		const recoveredActions = manifest.sessions[0]?.queue.actions.actions ?? [];
		expect(recoveredActions.map((action) => action.payload.text)).toEqual([
			"queued work",
			"heartbeat",
			"custom heartbeat",
			"/autonomous on",
		]);
		expect(recoveredActions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					delivery: "next_turn_boundary",
					wake: "on_lower_boundary",
					queueKey: "heartbeat:steer",
					agentMessageId: "agentmsg_steer",
					payload: expect.objectContaining({ kind: "turn", text: "queued work", content, images: [image] }),
				}),
				expect.objectContaining({
					delivery: "when_run_idle",
					queueKey: "heartbeat:job-1",
					agentMessageId: "agentmsg_followup",
					payload: expect.objectContaining({ kind: "turn", text: "heartbeat", content: followUpContent }),
				}),
				expect.objectContaining({
					queueKey: "heartbeat:custom",
					agentMessageId: "agentmsg_custom",
					payload: expect.objectContaining({
						kind: "turn",
						text: "custom heartbeat",
						customMessage: customFollowUp,
					}),
				}),
				expect.objectContaining({
					payload: expect.objectContaining({ kind: "session_command", text: "/autonomous on", command }),
				}),
			]),
		);
		expect(manifest.sessions[1]).toMatchObject({
			activeSessionId: "child-active",
			sessionFile: childHarness.session.sessionFile,
			runtimeMetadata: {
				kind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: parentHarness.session.sessionId,
				parentSessionFile: parentHarness.session.sessionFile,
				rlmChildId: "child-1",
			},
			queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
			shouldResume: false,
		});
		expect(hasArchivedState(parentHarness)).toBe(false);
		expect(hasArchivedState(childHarness)).toBe(false);
	});

	it("captures next-turn context and full queued actions in the restart manifest", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const pendingNextTurn = createCustomMessage("pending next turn");
		const queuedContext = createCustomMessage("queued prompt context");
		const content: TextContent[] = [{ type: "text", text: "queued work" }];
		await harness.session.restoreFollowUpMessage("queued work", undefined, {
			content,
			agentMessageId: "agentmsg_queued",
			queueKey: "recovery-key",
			prefixMessages: [queuedContext],
		});
		harness.session.restorePendingNextTurnMessages([pendingNextTurn]);

		const internals = createDaemonInternals(harness);
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(manifest.formatVersion).toBe(1);
		expect(manifest.sessions[0]?.queue.nextTurn).toEqual([pendingNextTurn]);
		const recovered = manifest.sessions[0]?.queue.actions.actions[0];
		expect(recovered).toMatchObject({
			id: expect.any(String),
			delivery: "when_run_idle",
			wake: "external_resume",
			queueKey: "recovery-key",
			agentMessageId: "agentmsg_queued",
			payload: {
				kind: "turn",
				text: "queued work",
				content,
				records: expect.arrayContaining([
					expect.objectContaining({ role: "prefix", message: queuedContext, ownerActionId: recovered?.id }),
					expect.objectContaining({ role: "primary", ownerActionId: recovered?.id }),
				]),
			},
		});
	});

	it("materializes queued in-memory drafts before update restart", async () => {
		const harness = await createHarness({ persistSession: false });
		harnesses.push(harness);

		const followUpContent: TextContent[] = [
			{ type: "text", text: "queued context" },
			{ type: "text", text: "queued follow-up" },
		];
		await harness.session.restoreFollowUpMessage("queued follow-up", undefined, {
			queueKey: "heartbeat:job-1",
			agentMessageId: "agentmsg_followup",
			content: followUpContent,
		});

		const sessionDir = `${harness.tempDir}/sessions`;
		const internals = createDaemonInternals(harness, { sessionDir });
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(manifest.sessions).toHaveLength(1);
		const session = manifest.sessions[0];
		expect(session?.sessionFile.startsWith(`${sessionDir}/`)).toBe(true);
		expect(harness.session.sessionFile).toBe(session?.sessionFile);
		expect(readFileSync(session?.sessionFile ?? "", "utf8")).toContain('"type":"session"');
		expect(session?.queue.actions.actions).toEqual([
			expect.objectContaining({
				queueKey: "heartbeat:job-1",
				agentMessageId: "agentmsg_followup",
				payload: expect.objectContaining({ kind: "turn", text: "queued follow-up", content: followUpContent }),
			}),
		]);
		expect(session?.shouldResume).toBe(true);
	});

	it("materializes busy in-memory drafts before update restart", async () => {
		const harness = await createHarness({ persistSession: false });
		harnesses.push(harness);
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;

		const sessionDir = `${harness.tempDir}/sessions`;
		const internals = createDaemonInternals(harness, { sessionDir });
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(manifest.sessions).toHaveLength(1);
		const session = manifest.sessions[0];
		expect(session?.sessionFile.startsWith(`${sessionDir}/`)).toBe(true);
		expect(harness.session.sessionFile).toBe(session?.sessionFile);
		expect(session).toMatchObject({
			shouldResume: true,
			wasStreaming: true,
			queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
		});
	});

	it("restores queued actions through the public recovery API with stable ids and FIFO", async () => {
		const source = await createHarness({ persistSession: true });
		const target = await createHarness({ persistSession: true });
		harnesses.push(source, target);
		await source.session.restoreSteeringMessage("steering one");
		await source.session.restoreSteeringMessage("steering two");
		await source.session.restoreFollowUpMessage("follow-up one", undefined, { queueKey: "job-1" });

		const snapshot = source.session.getSessionActionRecoverySnapshot();
		await target.session.restoreSessionActions(snapshot);

		expect(target.session.getSessionActionRecoverySnapshot()).toEqual(snapshot);
		expect(target.session.getSteeringMessages()).toEqual(["steering one", "steering two"]);
		expect(target.session.getFollowUpMessages()).toEqual(["follow-up one"]);
		await expect(
			target.session.restoreSessionActions({
				formatVersion: 2,
				actions: [],
			} as unknown as SessionActionRecoverySnapshot),
		).rejects.toThrow("Unsupported session action recovery format version: 2");
	});

	it("rejects duplicate recovered action ids without partial admission", async () => {
		const source = await createHarness({ persistSession: true });
		const target = await createHarness({ persistSession: true });
		harnesses.push(source, target);
		await source.session.restoreFollowUpMessage("follow-up");
		const action = source.session.getSessionActionRecoverySnapshot().actions[0]!;

		await expect(
			target.session.restoreSessionActions({ formatVersion: 1, actions: [action, action] }),
		).rejects.toThrow(`Duplicate session action id: ${action.id}`);
		expect(target.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
	});

	it("accepts restore_next_turn through daemon command parsing", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const internals = createDaemonInternals(harness);
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const writes: string[] = [];
		const client = createWriteClient(writes, { attached: ["active-1"] });
		const restoredMessage = createCustomMessage("restored next turn");

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "restore-1",
				type: "restore_next_turn",
				activeSessionId: "active-1",
				messages: [restoredMessage],
			}),
		);

		expect(JSON.parse(writes.join("").trim())).toMatchObject({
			id: "restore-1",
			type: "response",
			command: "restore_next_turn",
			success: true,
		});
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([restoredMessage]);
	});

	it("accepts restored prompt content through daemon command parsing", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("accepted restored prompt")]);

		const internals = createDaemonInternals(harness);
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const promptContent: TextContent[] = [
			{ type: "text", text: "accepted prefix" },
			{ type: "text", text: "accepted work" },
		];
		const writes: string[] = [];
		const client = createWriteClient(writes, { attached: ["active-1"] });

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "active-1",
				message: "accepted work",
				content: promptContent,
				expandPromptTemplates: false,
				agentMessageId: "agentmsg_accepted",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.agent.waitForIdle();

		expect(
			writes
				.join("")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([expect.objectContaining({ id: "prompt-1", command: "prompt", success: true })]);
		expect(harness.session.messages.find((message) => message.role === "user")?.content).toEqual(promptContent);
	});

	it("restores agent-message ids and reports deduped follow-ups", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const internals = createDaemonInternals(harness);
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const restoredSteerContent: TextContent[] = [
			{ type: "text", text: "restored steer context" },
			{ type: "text", text: "restored steer" },
		];
		const restoredFollowUpContent: TextContent[] = [
			{ type: "text", text: "restored follow-up context" },
			{ type: "text", text: "restored follow-up" },
		];
		const restoredPrefix = createCustomMessage("restored custom prefix");
		await harness.session.restoreFollowUpMessage("existing", undefined, {
			queueKey: "heartbeat:job-1",
			agentMessageId: "agentmsg_existing",
		});
		const writes: string[] = [];
		const client = createWriteClient(writes, { attached: ["active-1"] });

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "steer-1",
				type: "steer",
				activeSessionId: "active-1",
				message: "restored steer",
				content: restoredSteerContent,
				queueKey: "heartbeat:steer",
				expandPromptTemplates: false,
				agentMessageId: "agentmsg_restored_steer",
				prefixMessages: [restoredPrefix],
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "follow-up-1",
				type: "follow_up",
				activeSessionId: "active-1",
				message: "duplicate",
				queueKey: "heartbeat:job-1",
				expandPromptTemplates: false,
				agentMessageId: "agentmsg_duplicate",
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "follow-up-2",
				type: "follow_up",
				activeSessionId: "active-1",
				message: "restored follow-up",
				content: restoredFollowUpContent,
				queueKey: "heartbeat:job-2",
				expandPromptTemplates: false,
				agentMessageId: "agentmsg_restored_followup",
			}),
		);

		const responses = writes
			.join("")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(responses).toEqual([
			expect.objectContaining({ id: "steer-1", command: "steer", success: true }),
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true, data: { queued: false } }),
			expect.objectContaining({ id: "follow-up-2", command: "follow_up", success: true, data: { queued: true } }),
		]);
		const recovery = harness.session.getSessionActionRecoverySnapshot().actions;
		expect(recovery.filter((action) => action.delivery === "next_turn_boundary")).toEqual([
			expect.objectContaining({
				queueKey: "heartbeat:steer",
				agentMessageId: "agentmsg_restored_steer",
				payload: expect.objectContaining({ kind: "turn", text: "restored steer", content: restoredSteerContent }),
			}),
		]);
		expect(recovery.filter((action) => action.delivery === "when_run_idle")).toEqual([
			expect.objectContaining({
				agentMessageId: "agentmsg_existing",
				payload: expect.objectContaining({ text: "existing" }),
			}),
			expect.objectContaining({
				agentMessageId: "agentmsg_restored_followup",
				payload: expect.objectContaining({ text: "restored follow-up", content: restoredFollowUpContent }),
			}),
		]);
	});

	it("resumes restored queues without promoting steering messages to prompts", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("seed response"),
			fauxAssistantMessage("handled steer 1"),
			fauxAssistantMessage("handled steer 2"),
			fauxAssistantMessage("handled follow-up"),
		]);
		await harness.session.prompt("start");

		const internals = createDaemonInternals(harness);
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);
		const writes: string[] = [];
		const client = createWriteClient(writes, { attached: ["active-1"] });

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "steer-1",
				type: "steer",
				activeSessionId: "active-1",
				message: "restored steer 1",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "steer-2",
				type: "steer",
				activeSessionId: "active-1",
				message: "restored steer 2",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "follow-up-1",
				type: "follow_up",
				activeSessionId: "active-1",
				message: "restored follow-up",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "resume-1",
				type: "resume_queue",
				activeSessionId: "active-1",
			}),
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.agent.waitForIdle();

		const responses = writes
			.join("")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(responses).toEqual([
			expect.objectContaining({ id: "steer-1", command: "steer", success: true }),
			expect.objectContaining({ id: "steer-2", command: "steer", success: true }),
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true }),
			expect.objectContaining({ id: "resume-1", command: "resume_queue", success: true }),
		]);
		expect(getUserTexts(harness)).toEqual(["start", "restored steer 1", "restored steer 2", "restored follow-up"]);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
	});

	it("drains restored queues when a continuation prompt resumes interrupted work", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled continuation"), fauxAssistantMessage("handled follow-up")]);
		harness.session.agent.state.messages.push(createCustomMessage("update interrupted"));

		const internals = createDaemonInternals(harness);
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);
		const writes: string[] = [];
		const client = createWriteClient(writes, { attached: ["active-1"] });

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "steer-1",
				type: "steer",
				activeSessionId: "active-1",
				message: "restored steer",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "follow-up-1",
				type: "follow_up",
				activeSessionId: "active-1",
				message: "restored follow-up",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "active-1",
				message: "continue interrupted work",
				expandPromptTemplates: false,
			}),
		);

		await vi.waitFor(() =>
			expect(getUserTexts(harness)).toEqual(["restored steer", "restored follow-up", "continue interrupted work"]),
		);
		await harness.session.waitForSessionInputIdle();

		const responses = writes
			.join("")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(responses).toEqual([
			expect.objectContaining({ id: "steer-1", command: "steer", success: true }),
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true }),
			expect.objectContaining({ id: "prompt-1", command: "prompt", success: true }),
		]);
		expect(getUserTexts(harness)).toEqual(["restored steer", "restored follow-up", "continue interrupted work"]);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
	});

	it("resumes restored queues after an update marker without prior transcript messages", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled restored follow-up")]);
		harness.session.agent.state.messages.push(createCustomMessage("update interrupted"));

		const internals = createDaemonInternals(harness);
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);
		const writes: string[] = [];
		const client = createWriteClient(writes, { attached: ["active-1"] });

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "follow-up-1",
				type: "follow_up",
				activeSessionId: "active-1",
				message: "restored follow-up",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "resume-1",
				type: "resume_queue",
				activeSessionId: "active-1",
			}),
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.agent.waitForIdle();

		const responses = writes
			.join("")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(responses).toEqual([
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true }),
			expect.objectContaining({ id: "resume-1", command: "resume_queue", success: true }),
		]);
		expect(getUserTexts(harness)).toEqual(["restored follow-up"]);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
	});

	it("adopts attach env after a fenced update preparation rolls back", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = createDaemonInternals(harness);
		const state = createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() });
		internals.sessions.set(state.activeSessionId, state);
		const transaction = internals.beginUpdateRestartTransaction();
		transaction.phase = "fencing";
		const writes: string[] = [];
		const client = createWriteClient(writes);

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "attach-1",
				type: "attach",
				activeSessionId: state.activeSessionId,
				env: { HERDR_PANE_ID: "w1:p1", PATH: "/ignored" },
			}),
		);

		expect(state.clientEnv).toBeUndefined();
		expect(state.clients.has(client)).toBe(true);
		expect(transaction.deferredClientEnv).toHaveLength(1);
		internals.cancelPreparedUpdateRestart(transaction.id);
		expect(state.clientEnv).toEqual({ HERDR_PANE_ID: "w1:p1" });
		expect(transaction.deferredClientEnv).toEqual([]);
	});

	it("reports resume_queue failure when no work can resume", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const internals = createDaemonInternals(harness);
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);
		const writes: string[] = [];
		const client = createWriteClient(writes, { attached: ["active-1"] });

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "resume-1",
				type: "resume_queue",
				activeSessionId: "active-1",
			}),
		);
		await Promise.resolve();

		const response = JSON.parse(writes.join("").trim());
		expect(response).toMatchObject({ id: "resume-1", command: "resume_queue", success: false });
		expect(JSON.stringify(response)).toContain("No queued work to resume");
	});
});
