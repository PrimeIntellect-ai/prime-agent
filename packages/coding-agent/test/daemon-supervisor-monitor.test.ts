import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { CommandRecoveryJournal } from "../src/modes/daemon/command-recovery-journal.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_UPDATE_RESTART_FORMAT_VERSION,
	type DaemonAttachResult,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import {
	DAEMON_WORKER_STARTUP_GATE_COMMIT,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	type DaemonWorkerFrameHeader,
} from "../src/modes/daemon/daemon-worker-protocol.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";
import * as childProcessModule from "../src/utils/child-process.js";
import { createDeferred } from "./suite/scheduling.js";

const workerLaunchTestState = vi.hoisted(() => ({
	capture: false,
	forceMissingProcessStartId: false,
	fixtureMode: "worker" as "worker" | "close-gate" | "rollback-gate" | "successful-gate",
	gateMarkerPath: "",
	tsxCliPath: "",
	cliEntrypoint: "",
	spawned: [] as Array<{ child: ChildProcess; args: readonly string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown> & {
		spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
	};
	return {
		...actual,
		spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
			const child = actual.spawn(command, args, options);
			if (workerLaunchTestState.capture) {
				workerLaunchTestState.spawned.push({ child, args });
			}
			return child;
		},
	};
});

vi.mock("../src/cli/subprocess-launch.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createCliSubprocessLaunchSpec(args: readonly string[]) {
			if (!workerLaunchTestState.capture) {
				return (actual.createCliSubprocessLaunchSpec as (args: readonly string[]) => unknown)(args);
			}
			if (workerLaunchTestState.fixtureMode === "rollback-gate") {
				const markerPath = JSON.stringify(workerLaunchTestState.gateMarkerPath);
				const commitMarker = JSON.stringify(DAEMON_WORKER_STARTUP_GATE_COMMIT);
				return {
					command: process.execPath,
					args: [
						"--eval",
						`const fs = require("node:fs"); const marker = fs.readFileSync(3, "utf8"); if (marker === ${commitMarker}) { fs.writeFileSync(${markerPath}, marker); setInterval(() => {}, 1000); }`,
						"--",
						...args,
					],
				};
			}
			if (workerLaunchTestState.fixtureMode === "close-gate") {
				return {
					command: process.execPath,
					args: ["--eval", 'require("node:fs").closeSync(3)'],
				};
			}
			if (workerLaunchTestState.fixtureMode === "successful-gate") {
				const markerPath = JSON.stringify(workerLaunchTestState.gateMarkerPath);
				return {
					command: process.execPath,
					args: [
						"--eval",
						`const fs = require("node:fs"); const marker = fs.readFileSync(3, "utf8"); fs.writeFileSync(${markerPath}, marker); setInterval(() => {}, 1000);`,
					],
				};
			}
			return {
				command: process.execPath,
				args: [workerLaunchTestState.tsxCliPath, workerLaunchTestState.cliEntrypoint, ...args],
			};
		},
	};
});

vi.mock("../src/core/session-lease.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown> & {
		getProcessStartId(pid: number): string | undefined;
	};
	return {
		...actual,
		getProcessStartId(pid: number): string | undefined {
			return workerLaunchTestState.forceMissingProcessStartId ? undefined : actual.getProcessStartId(pid);
		},
	};
});

const supervisorRegistryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const previousSupervisorRegistryDir = process.env[supervisorRegistryDirEnv];
const supervisorRegistryDirs = new Set<string>();

interface SupervisorMonitorHarness {
	options: { worker: object };
	clients: Set<{ authenticated: boolean }>;
	supervisorClaims: Map<object, object>;
	shuttingDown: boolean;
	supervisorMonitorTimer?: ReturnType<typeof setTimeout>;
	canConnectToSupervisor: (socketPath: string) => Promise<boolean>;
	launchReplacementSupervisor: (socketPath: string) => Promise<void>;
	scheduleSupervisorAvailabilityCheck: (socketPath: string, delayMs: number) => void;
}

interface DeferredRecoveryWorker {
	descriptor: {
		workerId: string;
		pid: number;
		rootActiveSessionId: string;
		lifecycle: "ready" | "recovering";
		lastError?: string;
		stopRequestedAt?: string;
	};
	client?: object;
	snapshotCache: Map<string, DaemonAttachResult>;
	incomingTranscriptActiveSessionIds: Set<string>;
	transcriptCaches: Map<string, { markFailed(error: Error): void }>;
	duplicateIncomingTranscriptChunkIndexes: Map<string, number>;
	snapshotTransferFrames: Map<string, never>;
	recovery?: Promise<void>;
	deferredRecovery?: Promise<void>;
	intentionalStop: boolean;
	stopRevision: number;
}

interface DeferredRecoveryHarness {
	workers: Map<string, DeferredRecoveryWorker>;
	shuttingDown: boolean;
	assertRecoveryAllowed: ReturnType<typeof vi.fn>;
	persistWorker: ReturnType<typeof vi.fn>;
	recoverWorker: ReturnType<typeof vi.fn>;
	handleWorkerClose(worker: DeferredRecoveryWorker, client: object, error: Error): Promise<void>;
	deferWorkerRecovery(worker: DeferredRecoveryWorker, error: Error): void;
}

function recoveryDeniedError(code: "supervisor_recovery_cancelled" | "supervisor_generation_stale"): Error {
	return Object.assign(new Error(code), { code });
}

async function waitForCapturedChildClose(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	if (!existsSync(path)) {
		throw new Error(`Timed out waiting for ${path}`);
	}
}

function createExistingLaunchWorker(root: string, descriptorDir: string) {
	const workerId = "existing-worker";
	const now = new Date().toISOString();
	return {
		descriptor: {
			version: 1 as const,
			workerId,
			pid: 999_999,
			processStartId: undefined as string | undefined,
			socketPath: join(root, `${workerId}.sock`),
			recoveryJournalPath: join(descriptorDir, `${workerId}.recovery.jsonl`),
			orphanProcessJournalPath: join(descriptorDir, `${workerId}.orphans.jsonl`),
			supervisorSocketPath: join(root, "supervisor.sock"),
			authenticationToken: "existing-worker-token",
			rootActiveSessionId: "existing-root-session",
			createdAt: now,
			updatedAt: now,
			lifecycle: "recovering" as const,
			stopRequestedAt: undefined as string | undefined,
			createCommand: { type: "create" as const, config: { cwd: root, agentDir: root } },
			consecutiveFailures: 0,
		},
		descriptorPath: join(descriptorDir, `${workerId}.json`),
		summaries: new Map<string, SessionSummary>(),
		snapshotCache: new Map<string, DaemonAttachResult>(),
		transcriptCaches: new Map<string, never>(),
		incomingTranscriptActiveSessionIds: new Set<string>(),
		duplicateIncomingTranscriptChunkIndexes: new Map<string, number>(),
		snapshotTransferFrames: new Map<string, never>(),
		snapshotLoads: new Map<string, Promise<DaemonAttachResult>>(),
		intentionalStop: false,
		stopRevision: 0,
	};
}

function createSupervisorSnapshotState() {
	return {
		clients: new Set<object>(),
		sessionInputPauses: new Map(),
		pendingReplacementSnapshots: new WeakMap<object, Map<string, unknown>>(),
	};
}

const recoveryEligibilityInvalidations: Array<{
	name: string;
	invalidate(supervisor: DeferredRecoveryHarness, worker: DeferredRecoveryWorker): void;
}> = [
	{
		name: "the worker reconnects",
		invalidate: (_supervisor, worker) => {
			worker.client = {};
		},
	},
	{
		name: "the worker is stopped",
		invalidate: (_supervisor, worker) => {
			worker.intentionalStop = true;
			worker.descriptor.stopRequestedAt = new Date().toISOString();
		},
	},
	{
		name: "the worker is replaced",
		invalidate: (supervisor, worker) => supervisor.workers.set(worker.descriptor.workerId, { ...worker }),
	},
	{
		name: "supervisor cleanup begins",
		invalidate: (supervisor) => {
			supervisor.shuttingDown = true;
		},
	},
	{
		name: "another recovery begins",
		invalidate: (_supervisor, worker) => {
			worker.recovery = Promise.resolve();
		},
	},
];

function createHarness(canConnect: () => Promise<boolean>): SupervisorMonitorHarness {
	const registryDir = mkdtempSync(join(tmpdir(), "prime-supervisor-registry-test-"));
	supervisorRegistryDirs.add(registryDir);
	process.env[supervisorRegistryDirEnv] = registryDir;
	return Object.assign(Object.create(AgentDaemon.prototype), {
		options: { worker: {} },
		clients: new Set<{ authenticated: boolean }>(),
		supervisorClaims: new Map<object, object>(),
		shuttingDown: false,
		canConnectToSupervisor: vi.fn(canConnect),
		launchReplacementSupervisor: vi.fn(async () => undefined),
	}) as SupervisorMonitorHarness;
}

describe("daemon worker supervisor monitoring", () => {
	afterEach(async () => {
		for (const { child } of workerLaunchTestState.spawned) {
			if (child.exitCode === null && child.signalCode === null) {
				const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
				child.kill("SIGKILL");
				await closed;
			}
		}
		workerLaunchTestState.capture = false;
		workerLaunchTestState.forceMissingProcessStartId = false;
		workerLaunchTestState.fixtureMode = "worker";
		workerLaunchTestState.gateMarkerPath = "";
		workerLaunchTestState.tsxCliPath = "";
		workerLaunchTestState.cliEntrypoint = "";
		workerLaunchTestState.spawned.length = 0;
		vi.useRealTimers();
		for (const registryDir of supervisorRegistryDirs) {
			rmSync(registryDir, { recursive: true, force: true });
		}
		supervisorRegistryDirs.clear();
		if (previousSupervisorRegistryDir === undefined) {
			delete process.env[supervisorRegistryDirEnv];
		} else {
			process.env[supervisorRegistryDirEnv] = previousSupervisorRegistryDir;
		}
	});

	it("schedules recovery when the sole supervisor fails a fence check", async () => {
		const previousSocketPath = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = "/tmp/supervisor.sock";
		try {
			const daemon = new AgentDaemon("/tmp/worker.sock", {
				defaultSessionConfig: { agentDir: "/tmp/agent", cwd: "/tmp" },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
				worker: { authenticationToken: "token" },
			});
			const socket = Object.assign(new EventEmitter(), {
				destroyed: false,
				write: vi.fn(() => true),
				end: vi.fn(function (this: EventEmitter) {
					this.emit("close");
				}),
			}) as unknown as Socket;
			const internals = daemon as unknown as {
				clients: Set<DaemonSocketClient>;
				supervisorClaims: Map<DaemonSocketClient, object>;
				handleConnection(socket: Socket): void;
				checkSupervisorFences(): Promise<void>;
				assertSupervisorClaimCurrent: ReturnType<typeof vi.fn>;
				scheduleSupervisorAvailabilityCheck: ReturnType<typeof vi.fn>;
			};
			internals.handleConnection(socket);
			const client = [...internals.clients][0]!;
			client.authenticated = true;
			internals.supervisorClaims.set(client, {
				claim: {},
				ownerFingerprint: "old",
			});
			internals.assertSupervisorClaimCurrent = vi.fn(async () => {
				throw new Error("stale fence");
			});
			internals.scheduleSupervisorAvailabilityCheck = vi.fn();

			await internals.checkSupervisorFences();

			expect(internals.supervisorClaims.has(client)).toBe(false);
			expect(client.authenticated).toBe(true);
			expect(internals.scheduleSupervisorAvailabilityCheck).toHaveBeenCalledOnce();
			expect(internals.scheduleSupervisorAvailabilityCheck).toHaveBeenCalledWith("/tmp/supervisor.sock", 100);
		} finally {
			if (previousSocketPath === undefined) delete process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			else process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = previousSocketPath;
		}
	});

	it("does not revoke a newer same-client claim when an older periodic fence fails", async () => {
		const assertionReached = createDeferred<void>();
		const assertionGate = createDeferred<void>();
		const client = {
			authenticated: true,
			socket: { destroyed: false, end: vi.fn() },
		} as unknown as DaemonSocketClient;
		const oldClaim = { claim: {}, ownerFingerprint: "old" };
		const newerClaim = { claim: {}, ownerFingerprint: "new" };
		const transaction = {
			id: Symbol("update-restart"),
			owner: client,
			abort: new AbortController(),
			phase: "prepared",
		};
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			supervisorClaims: new Map([[client, oldClaim]]),
			updateRestart: transaction,
			shuttingDown: false,
			scheduleSupervisorFenceCheck: vi.fn(),
			assertSupervisorClaimCurrent: vi.fn(async () => {
				assertionReached.resolve();
				await assertionGate.promise;
				throw new Error("stale fence");
			}),
		}) as unknown as {
			supervisorClaims: Map<DaemonSocketClient, object>;
			updateRestart: object;
			checkSupervisorFences(): Promise<void>;
		};

		const check = daemon.checkSupervisorFences();
		await assertionReached.promise;
		daemon.supervisorClaims.set(client, newerClaim);
		assertionGate.resolve();
		await check;

		expect(daemon.supervisorClaims.get(client)).toBe(newerClaim);
		expect(daemon.updateRestart).toBe(transaction);
		expect(client.socket.end).not.toHaveBeenCalled();
	});

	it("does not revoke a newer same-client claim when an older command fence fails", async () => {
		const assertionReached = createDeferred<void>();
		const assertionGate = createDeferred<void>();
		const client = {
			id: "supervisor",
			authenticated: true,
			socket: { destroyed: false, write: vi.fn(() => true), end: vi.fn() },
			attachedActiveSessionIds: new Set(),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		} as unknown as DaemonSocketClient;
		const oldClaim = { claim: {}, ownerFingerprint: "old" };
		const newerClaim = { claim: {}, ownerFingerprint: "new" };
		const transaction = {
			id: Symbol("update-restart"),
			owner: client,
			abort: new AbortController(),
			phase: "prepared",
		};
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			supervisorClaims: new Map([[client, oldClaim]]),
			updateRestart: transaction,
			handleWorkerCommand: vi.fn(async () => undefined),
			assertSupervisorClaimCurrent: vi.fn(async () => {
				assertionReached.resolve();
				await assertionGate.promise;
				throw new Error("stale fence");
			}),
		}) as unknown as {
			supervisorClaims: Map<DaemonSocketClient, object>;
			updateRestart: object;
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};

		const command = daemon.handleLine(
			client,
			JSON.stringify({ type: "worker_subscribe", activeSessionId: "active-1" }),
		);
		await assertionReached.promise;
		daemon.supervisorClaims.set(client, newerClaim);
		assertionGate.resolve();
		await command;

		expect(daemon.supervisorClaims.get(client)).toBe(newerClaim);
		expect(daemon.updateRestart).toBe(transaction);
		expect(client.socket.end).not.toHaveBeenCalled();
	});

	it("revokes an old supervisor before ending its socket when a replacement authenticates", async () => {
		let markOldAssertionReached = () => {};
		const oldAssertionReached = new Promise<void>((resolve) => {
			markOldAssertionReached = resolve;
		});
		let releaseOldAssertion = () => {};
		const oldAssertionGate = new Promise<void>((resolve) => {
			releaseOldAssertion = resolve;
		});
		let assertionCount = 0;
		const handleWorkerCommand = vi.fn(async () => undefined);
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			supervisorClaims: new Map(),
			shuttingDown: false,
			clearSupervisorAvailabilityCheck: vi.fn(),
			scheduleSupervisorFenceCheck: vi.fn(),
			handleWorkerCommand,
			assertSupervisorClaimCurrent: vi.fn(async () => {
				assertionCount++;
				if (assertionCount === 2) {
					markOldAssertionReached();
					await oldAssertionGate;
				}
				return `fingerprint-${assertionCount}`;
			}),
		}) as unknown as {
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};
		const makeClient = () =>
			({
				id: "supervisor",
				authenticated: false,
				socket: { destroyed: false, write: vi.fn(() => true), end: vi.fn() },
				attachedActiveSessionIds: new Set(),
				detachInput: vi.fn(),
				supportsExtensionUi: false,
				capabilities: new Set(),
			}) as unknown as DaemonSocketClient;
		const auth = (generation: string) =>
			JSON.stringify({
				type: "worker_auth",
				token: "token",
				supervisorGeneration: generation,
				supervisorPid: 123,
				supervisorSocketPath: "/tmp/supervisor.sock",
			});
		const oldClient = makeClient();
		const replacementClient = makeClient();

		await daemon.handleLine(oldClient, auth("old"));
		const staleCommand = daemon.handleLine(
			oldClient,
			JSON.stringify({ type: "worker_subscribe", activeSessionId: "active-1" }),
		);
		await oldAssertionReached;
		await daemon.handleLine(replacementClient, auth("replacement"));

		expect(oldClient.authenticated).toBe(true);
		expect(oldClient.socket.end).toHaveBeenCalledOnce();
		releaseOldAssertion();
		await staleCommand;
		expect(handleWorkerCommand).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "first post-spawn ownership check",
			assertionCall: 3,
			error: recoveryDeniedError("supervisor_generation_stale"),
		},
		{
			name: "pre-publication ownership check",
			assertionCall: 4,
			error: recoveryDeniedError("supervisor_generation_stale"),
		},
		{ name: "descriptor persistence", persistFailure: true, error: new Error("descriptor persistence failed") },
	] as const)("keeps unidentifiable workers gated after $name fails", async (scenario) => {
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "rollback-gate";
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-launch-gate-test-"));
		const gateMarkerPath = join(root, "committed-gate");
		workerLaunchTestState.gateMarkerPath = gateMarkerPath;
		const descriptorDir = join(root, "descriptors");
		const registryDir = join(root, "registry");
		mkdirSync(descriptorDir, { recursive: true });
		mkdirSync(registryDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		process.env[supervisorRegistryDirEnv] = registryDir;
		let assertionCount = 0;
		const workers = new Map<string, unknown>();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			assertRecoveryAllowed: vi.fn(async () => {
				assertionCount++;
				if ("assertionCall" in scenario && assertionCount === scenario.assertionCall) {
					throw scenario.error;
				}
			}),
			...("persistFailure" in scenario
				? {
						persistWorker: vi.fn(() => {
							throw scenario.error;
						}),
					}
				: {}),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		await expect(supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })).rejects.toBe(
			scenario.error,
		);

		expect(assertionCount).toBe("assertionCall" in scenario ? scenario.assertionCall : 4);
		expect(workerLaunchTestState.spawned).toHaveLength(1);
		const { child, args } = workerLaunchTestState.spawned[0]!;
		const socketFlagIndex = args.indexOf("--daemon-socket");
		expect(socketFlagIndex).toBeGreaterThanOrEqual(0);
		const workerSocketPath = args[socketFlagIndex + 1];
		expect(workerSocketPath).toBeDefined();

		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		expect(existsSync(gateMarkerPath)).toBe(false);
		expect(existsSync(workerSocketPath!)).toBe(false);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toEqual([]);
		expect(readdirSync(registryDir)).toEqual([]);
		expect(workers.size).toBe(0);
	});

	it("rolls back promptly when the child closes its startup gate before commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-closed-gate-test-"));
		const descriptorDir = join(root, "descriptors");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "close-gate";
		let assertionCount = 0;
		const workers = new Map<string, unknown>();
		const connectWorker = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => {
				assertionCount++;
				if (assertionCount === 3) {
					const child = workerLaunchTestState.spawned.at(-1)?.child;
					if (!child) {
						throw new Error("Worker child was not captured");
					}
					await waitForCapturedChildClose(child);
				}
			}),
			connectWorker,
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		const timeoutError = new Error("startup gate rejection timed out");
		const result = await Promise.race([
			supervisor
				.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })
				.then(() => ({ value: "resolved" as const, error: undefined }))
				.catch((error: unknown) => ({ value: "rejected" as const, error })),
			new Promise<{ value: "timed-out"; error: Error }>((resolveTimeout) =>
				setTimeout(() => resolveTimeout({ value: "timed-out", error: timeoutError }), 1000),
			),
		]);

		expect(result.value).toBe("rejected");
		expect(result.error).not.toBe(timeoutError);
		expect(result.error).toBeInstanceOf(Error);
		expect(connectWorker).not.toHaveBeenCalled();
		expect(workers.size).toBe(0);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toEqual([]);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
	});

	it("commits the startup marker after durable worker publication", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-committed-gate-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const workers = new Map<string, unknown>();
		const connectWorker = vi.fn(async (worker: { descriptor: { rootActiveSessionId: string } }) => {
			await waitForFile(markerPath);
			return {
				request: vi.fn(async () => ({
					success: true,
					data: {
						id: worker.descriptor.rootActiveSessionId,
						activeSessionId: worker.descriptor.rootActiveSessionId,
						sessionId: "session-committed-gate",
						cwd: root,
					},
				})),
			};
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			subscribeWorker: vi.fn(async () => undefined),
			refreshWorkerSummaries: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as {
			launchWorker(command: {
				type: "create";
				config: { cwd: string; agentDir: string };
			}): Promise<{ descriptor: { lifecycle: string } }>;
		};

		const worker = await supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } });

		expect(readFileSync(markerPath, "utf8")).toBe("start\n");
		expect(connectWorker).toHaveBeenCalledOnce();
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(workers.size).toBe(1);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		if (!child) {
			throw new Error("Worker child was not captured");
		}
		const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
		child.kill("SIGKILL");
		await closed;
	});

	it("rolls back a published worker when shutdown admission and rollback persistence fail", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-cancelled-launch-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const cancellation = recoveryDeniedError("supervisor_recovery_cancelled");
		const rollbackPersistenceError = new Error("rollback persistence failed");
		const persistWorker = Reflect.get(DaemonSupervisor.prototype, "persistWorker");
		if (typeof persistWorker !== "function") {
			throw new Error("Could not access worker persistence");
		}
		let persistenceCalls = 0;
		const workers = new Map<string, unknown>();
		const connectWorker = vi.fn(async () => {
			await waitForFile(markerPath);
			throw cancellation;
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			persistWorker: vi.fn(function (this: object, worker: object) {
				persistenceCalls++;
				if (persistenceCalls === 2) {
					throw rollbackPersistenceError;
				}
				Reflect.apply(persistWorker, this, [worker]);
			}),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		await expect(supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })).rejects.toBe(
			cancellation,
		);

		expect(readFileSync(markerPath, "utf8")).toBe("start\n");
		expect(connectWorker).toHaveBeenCalledOnce();
		expect(persistenceCalls).toBe(2);
		expect(workers.size).toBe(0);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toEqual([]);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
	});

	it("defers an eligible existing recovery when descriptor restoration fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-existing-restore-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const cancellation = recoveryDeniedError("supervisor_recovery_cancelled");
		const restorationError = new Error("descriptor restoration failed");
		const persistWorker = Reflect.get(DaemonSupervisor.prototype, "persistWorker");
		if (typeof persistWorker !== "function") {
			throw new Error("Could not access worker persistence");
		}
		let persistenceCalls = 0;
		const existing = createExistingLaunchWorker(root, descriptorDir);
		const previousDescriptor = existing.descriptor;
		const workers = new Map<string, object>([[existing.descriptor.workerId, existing]]);
		const deferWorkerRecovery = vi.fn();
		const connectWorker = vi.fn(async () => {
			await waitForFile(markerPath);
			throw cancellation;
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			persistWorker: vi.fn(function (this: object, worker: object) {
				persistenceCalls++;
				if (persistenceCalls === 3) {
					throw restorationError;
				}
				Reflect.apply(persistWorker, this, [worker]);
			}),
			deferWorkerRecovery,
			log: vi.fn(),
		}) as {
			launchWorker(
				command: { type: "create"; config: { cwd: string; agentDir: string } },
				existing: object,
			): Promise<unknown>;
		};

		await expect(
			supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } }, existing),
		).rejects.toBe(cancellation);

		expect(persistenceCalls).toBe(3);
		expect(existing.descriptor).toBe(previousDescriptor);
		expect(workers.get(existing.descriptor.workerId)).toBe(existing);
		expect(deferWorkerRecovery).toHaveBeenCalledOnce();
		expect(deferWorkerRecovery).toHaveBeenCalledWith(existing, cancellation);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
	});

	it("does not restore an existing recovery invalidated during rollback", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-existing-stop-race-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const cancellation = recoveryDeniedError("supervisor_recovery_cancelled");
		const existing = createExistingLaunchWorker(root, descriptorDir);
		const workers = new Map<string, object>([[existing.descriptor.workerId, existing]]);
		const deferWorkerRecovery = vi.fn();
		const stopWorker = Reflect.get(DaemonSupervisor.prototype, "stopWorker");
		if (typeof stopWorker !== "function") {
			throw new Error("Could not access worker shutdown");
		}
		let markRollbackStarted = () => {};
		const rollbackStarted = new Promise<void>((resolveStarted) => {
			markRollbackStarted = resolveStarted;
		});
		let releaseRollback = () => {};
		const rollbackRelease = new Promise<void>((resolveRelease) => {
			releaseRollback = resolveRelease;
		});
		const controlledStopWorker = vi.fn(async function (
			this: object,
			worker: object,
			removeDescriptor: boolean,
			force = false,
			archiveSession = false,
			recoveryCleanup = false,
			directChild?: object,
		) {
			if (recoveryCleanup) {
				markRollbackStarted();
				await rollbackRelease;
				return;
			}
			await Reflect.apply(stopWorker, this, [
				worker,
				removeDescriptor,
				force,
				archiveSession,
				recoveryCleanup,
				directChild,
			]);
		});
		const connectWorker = vi.fn(async () => {
			await waitForFile(markerPath);
			throw cancellation;
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			stopWorker: controlledStopWorker,
			deferWorkerRecovery,
			log: vi.fn(),
		}) as {
			shuttingDown: boolean;
			launchWorker(
				command: { type: "create"; config: { cwd: string; agentDir: string } },
				existing: object,
			): Promise<unknown>;
			stopWorker(worker: object, removeDescriptor: boolean, force: boolean): Promise<void>;
		};

		const launchResult = supervisor
			.launchWorker({ type: "create", config: { cwd: root, agentDir: root } }, existing)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		await rollbackStarted;
		supervisor.shuttingDown = true;
		workerLaunchTestState.forceMissingProcessStartId = false;
		existing.descriptor.processStartId = getProcessStartId(existing.descriptor.pid);
		if (existing.descriptor.processStartId === undefined) {
			throw new Error("Could not identify launched worker before shutdown");
		}
		await supervisor.stopWorker(existing, true, true);
		releaseRollback();

		expect(await launchResult).toBe(cancellation);
		expect(existing.stopRevision).toBe(1);
		expect(existing.descriptor.stopRequestedAt).toBeDefined();
		expect(workers.size).toBe(0);
		expect(existsSync(existing.descriptorPath)).toBe(false);
		expect(deferWorkerRecovery).not.toHaveBeenCalled();
	});

	it("attempts every shutdown cleanup step before exiting", async () => {
		const cleanupSocket = vi.fn(() => {
			throw new Error("daemon socket cleanup failed");
		});
		const leaseRelease = vi.fn(async () => {
			throw new Error("lease cleanup failed");
		});
		const ownershipRelease = vi.fn(async () => undefined);
		const log = vi.fn();
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		type ShutdownHarness = {
			socketLease?: { release(): Promise<void> };
			ownership?: { release(): Promise<void> };
			shutdown(exitCode: number, stopWorkers: boolean, relaunch?: boolean, forceWorkers?: boolean): Promise<never>;
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			shuttingDown: false,
			signalCleanupHandlers: [],
			workers: new Map(),
			clients: new Set(),
			catalog: { stop: vi.fn(async () => undefined) },
			cleanupSocket,
			snapshotCacheRoot: "\0",
			socketLease: { release: leaseRelease },
			ownership: { release: ownershipRelease },
			log,
		}) as ShutdownHarness;

		try {
			await expect(supervisor.shutdown(42, false)).rejects.toThrow("exit 42");
			expect(cleanupSocket).toHaveBeenCalledOnce();
			expect(leaseRelease).toHaveBeenCalledOnce();
			expect(ownershipRelease).toHaveBeenCalledOnce();
			expect(log).toHaveBeenCalledWith(expect.stringContaining("daemon socket"));
			expect(log).toHaveBeenCalledWith(expect.stringContaining("supervisor cache"));
			expect(log).toHaveBeenCalledWith(expect.stringContaining("daemon socket lock"));
			expect(supervisor.socketLease).toBeUndefined();
			expect(supervisor.ownership).toBeUndefined();
			expect(exit).toHaveBeenCalledWith(42);
		} finally {
			exit.mockRestore();
		}
	});

	it("completes shutdown without awaiting an unsignalable worker finalizer", async () => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-shutdown-finalization-test-"));
		supervisorRegistryDirs.add(root);
		const worker = {
			descriptor: {
				workerId: "worker-shutdown-finalization",
				pid: 111_123,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: true,
			},
			client: undefined,
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: true,
			stopRevision: 1,
			stopFinalization: new Promise<void>(() => {}),
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const catalogStop = vi.fn(async () => undefined);
		const log = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			shuttingDown: false,
			signalCleanupHandlers: [],
			workers,
			clients: new Set(),
			persistWorkerStopTombstone: vi.fn(),
			hasPersistedWorkerDescriptors: vi.fn(() => true),
			catalog: { stop: catalogStop },
			cleanupSocket: vi.fn(),
			snapshotCacheRoot: join(root, "cache"),
			log,
		}) as {
			shutdown(exitCode: number, stopWorkers: boolean, relaunch?: boolean, forceWorkers?: boolean): Promise<never>;
		};

		try {
			const shutdown = supervisor.shutdown(0, true, false, true).then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(2000);
			await expect(shutdown).resolves.toEqual(new Error("exit 0"));

			expect(workers.has(worker.descriptor.workerId)).toBe(true);
			expect(killSpy).not.toHaveBeenCalled();
			expect(catalogStop).toHaveBeenCalledOnce();
			expect(log).toHaveBeenCalledWith(expect.stringContaining("remains tombstoned for recovery"));
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			exit.mockRestore();
			killSpy.mockRestore();
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("does not poll a healthy supervisor after the startup check", async () => {
		vi.useFakeTimers();
		let resolveProbe: () => void = () => undefined;
		const probeCompleted = new Promise<void>((resolve) => {
			resolveProbe = resolve;
		});
		const daemon = createHarness(async () => {
			resolveProbe();
			return true;
		});

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 1500);
		await vi.advanceTimersByTimeAsync(1500);
		await probeCompleted;
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();
		expect(daemon.supervisorMonitorTimer).toBeUndefined();
	});

	it("skips socket probes while an authenticated supervisor connection is active", async () => {
		vi.useFakeTimers();
		const daemon = createHarness(async () => true);
		daemon.clients.add({ authenticated: true });
		daemon.supervisorClaims.set({}, {});

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 0);
		await vi.runAllTimersAsync();

		expect(daemon.canConnectToSupervisor).not.toHaveBeenCalled();
	});

	it("retries when shutdown admission lookup fails", async () => {
		vi.useFakeTimers();
		let resolveProbe: () => void = () => undefined;
		const probeCompleted = new Promise<void>((resolve) => {
			resolveProbe = resolve;
		});
		const daemon = createHarness(async () => {
			resolveProbe();
			return true;
		});
		const registryDir = process.env[supervisorRegistryDirEnv];
		if (!registryDir) throw new Error("Supervisor registry test directory was not set");
		rmSync(registryDir, { recursive: true, force: true });
		writeFileSync(registryDir, "not a directory");

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 0);
		await vi.advanceTimersByTimeAsync(0);
		expect(daemon.canConnectToSupervisor).not.toHaveBeenCalled();
		expect(daemon.supervisorMonitorTimer).toBeDefined();

		rmSync(registryDir, { force: true });
		mkdirSync(registryDir, { recursive: true });
		await vi.advanceTimersByTimeAsync(5000);
		await probeCompleted;
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();
	});

	it("recovers exactly once after shutdown admission clears", async () => {
		vi.useFakeTimers();
		const client = {};
		const worker: DeferredRecoveryWorker = {
			descriptor: {
				workerId: "worker-deferred-recovery",
				pid: process.pid,
				rootActiveSessionId: "active-deferred-recovery",
				lifecycle: "ready",
			},
			client,
			snapshotCache: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			transcriptCaches: new Map(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map<string, never>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		let admissionActive = true;
		const assertRecoveryAllowed = vi.fn(async () => {
			if (admissionActive) {
				throw recoveryDeniedError("supervisor_recovery_cancelled");
			}
		});
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed,
			persistWorker,
			recoverWorker,
		}) as DeferredRecoveryHarness;

		await supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
		const deferredRecovery = worker.deferredRecovery;
		expect(deferredRecovery).toBeDefined();
		supervisor.deferWorkerRecovery(worker, new Error("duplicate close"));
		expect(worker.deferredRecovery).toBe(deferredRecovery);
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();

		admissionActive = false;
		await vi.advanceTimersByTimeAsync(5000);
		await deferredRecovery;

		expect(worker.descriptor.lifecycle).toBe("recovering");
		expect(worker.descriptor.lastError).toBe("worker disconnected");
		expect(persistWorker).toHaveBeenCalledOnce();
		expect(recoverWorker).toHaveBeenCalledOnce();
		expect(worker.deferredRecovery).toBeUndefined();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(recoverWorker).toHaveBeenCalledOnce();
	});

	it("resumes deferred recovery after a concurrent recovery is denied", async () => {
		vi.useFakeTimers();
		const client = {};
		const worker: DeferredRecoveryWorker = {
			descriptor: {
				workerId: "worker-concurrent-recovery",
				pid: process.pid,
				rootActiveSessionId: "active-concurrent-recovery",
				lifecycle: "ready",
			},
			client,
			snapshotCache: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			transcriptCaches: new Map(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map<string, never>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		let admissionActive = true;
		const assertRecoveryAllowed = vi.fn(async () => {
			if (admissionActive) {
				throw recoveryDeniedError("supervisor_recovery_cancelled");
			}
		});
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed,
			persistWorker,
			recoverWorker,
		}) as DeferredRecoveryHarness;

		await supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
		const deferredRecovery = worker.deferredRecovery;
		expect(deferredRecovery).toBeDefined();
		let startConcurrentRecovery: () => void = () => undefined;
		const concurrentRecoveryBarrier = new Promise<void>((resolve) => {
			startConcurrentRecovery = resolve;
		});
		const concurrentRecovery = (async () => {
			await concurrentRecoveryBarrier;
			await expect(assertRecoveryAllowed()).rejects.toMatchObject({ code: "supervisor_recovery_cancelled" });
		})().finally(() => {
			worker.recovery = undefined;
		});
		worker.recovery = concurrentRecovery;

		await vi.advanceTimersByTimeAsync(5000);
		expect(worker.deferredRecovery).toBe(deferredRecovery);
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();

		startConcurrentRecovery();
		await concurrentRecovery;
		expect(worker.recovery).toBeUndefined();
		admissionActive = false;
		await vi.advanceTimersByTimeAsync(5000);
		await deferredRecovery;

		expect(assertRecoveryAllowed).toHaveBeenCalledTimes(3);
		expect(worker.descriptor.lifecycle).toBe("recovering");
		expect(worker.descriptor.lastError).toBe("worker disconnected");
		expect(persistWorker).toHaveBeenCalledOnce();
		expect(recoverWorker).toHaveBeenCalledOnce();
		expect(worker.deferredRecovery).toBeUndefined();
	});

	it("cancels deferred recovery permanently after ownership loss", async () => {
		vi.useFakeTimers();
		const client = {};
		const worker: DeferredRecoveryWorker = {
			descriptor: {
				workerId: "worker-stale-recovery",
				pid: process.pid,
				rootActiveSessionId: "active-stale-recovery",
				lifecycle: "ready",
			},
			client,
			snapshotCache: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			transcriptCaches: new Map(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map<string, never>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		let stale = false;
		const assertRecoveryAllowed = vi.fn(async () => {
			throw recoveryDeniedError(stale ? "supervisor_generation_stale" : "supervisor_recovery_cancelled");
		});
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed,
			persistWorker,
			recoverWorker,
		}) as DeferredRecoveryHarness;

		await supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
		const deferredRecovery = worker.deferredRecovery;
		expect(deferredRecovery).toBeDefined();
		stale = true;
		await vi.advanceTimersByTimeAsync(5000);
		await deferredRecovery;

		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(worker.descriptor.lastError).toBeUndefined();
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();
		expect(worker.deferredRecovery).toBeUndefined();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(recoverWorker).not.toHaveBeenCalled();
	});

	it.each(recoveryEligibilityInvalidations)(
		"does not recover when $name during the ownership assertion",
		async ({ invalidate }) => {
			const client = {};
			const worker: DeferredRecoveryWorker = {
				descriptor: {
					workerId: "worker-eligibility-race",
					pid: process.pid,
					rootActiveSessionId: "active-eligibility-race",
					lifecycle: "ready",
				},
				client,
				snapshotCache: new Map(),
				incomingTranscriptActiveSessionIds: new Set(),
				transcriptCaches: new Map(),
				duplicateIncomingTranscriptChunkIndexes: new Map(),
				snapshotTransferFrames: new Map<string, never>(),
				intentionalStop: false,
				stopRevision: 0,
			};
			let resolveAssertion: () => void = () => undefined;
			const assertion = new Promise<void>((resolve) => {
				resolveAssertion = resolve;
			});
			const persistWorker = vi.fn();
			const recoverWorker = vi.fn(async () => undefined);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				...createSupervisorSnapshotState(),
				workers: new Map([[worker.descriptor.workerId, worker]]),
				shuttingDown: false,
				assertRecoveryAllowed: vi.fn(() => assertion),
				persistWorker,
				recoverWorker,
			}) as DeferredRecoveryHarness;

			const handling = supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
			invalidate(supervisor, worker);
			resolveAssertion();
			await handling;

			expect(worker.descriptor.lifecycle).toBe("ready");
			expect(worker.descriptor.lastError).toBeUndefined();
			expect(persistWorker).not.toHaveBeenCalled();
			expect(recoverWorker).not.toHaveBeenCalled();
		},
	);

	it("clears an intentional-stop tombstone before retrying a worker", async () => {
		type RetryWorker = {
			descriptor: {
				workerId: string;
				rootActiveSessionId: string;
				rootSessionId: string;
				lifecycle: "ready" | "recovering";
				consecutiveFailures: number;
				stopRequestedAt?: string;
				archiveOnStop?: boolean;
			};
			intentionalStop: boolean;
			summaries: Map<string, SessionSummary>;
		};
		type RetryHarness = {
			workers: Map<string, RetryWorker>;
			persistWorker: ReturnType<typeof vi.fn>;
			recoverWorker: ReturnType<typeof vi.fn>;
			handleCommand(
				client: DaemonSocketClient,
				command: { type: "retry_worker"; activeSessionId: string },
			): Promise<unknown>;
		};
		const worker: RetryWorker = {
			descriptor: {
				workerId: "worker-1",
				rootActiveSessionId: "active-1",
				rootSessionId: "session-1",
				lifecycle: "ready",
				consecutiveFailures: 2,
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: true,
			},
			intentionalStop: true,
			summaries: new Map(),
		};
		const persistWorker = vi.fn(() => {
			expect(worker.intentionalStop).toBe(false);
			expect(worker.descriptor.stopRequestedAt).toBeUndefined();
			expect(worker.descriptor.archiveOnStop).toBeUndefined();
			expect(worker.descriptor.lifecycle).toBe("recovering");
			expect(worker.descriptor.consecutiveFailures).toBe(0);
		});
		const recoverWorker = vi.fn(async () => {
			worker.descriptor.lifecycle = "ready";
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			persistWorker,
			recoverWorker,
			assertWorkerAccessibleToClient: vi.fn(),
		}) as RetryHarness;

		await supervisor.handleCommand({} as DaemonSocketClient, {
			type: "retry_worker",
			activeSessionId: worker.descriptor.rootSessionId,
		});

		expect(persistWorker).toHaveBeenCalledOnce();
		expect(recoverWorker).toHaveBeenCalledWith(worker);
		expect(persistWorker.mock.invocationCallOrder[0]).toBeLessThan(recoverWorker.mock.invocationCallOrder[0]!);
	});

	it("rejects retry while the worker is actively stopping", async () => {
		type RetryWorker = {
			descriptor: {
				workerId: string;
				rootActiveSessionId: string;
				rootSessionId: string;
				lifecycle: "ready";
				consecutiveFailures: number;
				stopRequestedAt: string;
				archiveOnStop: boolean;
			};
			intentionalStop: boolean;
			summaries: Map<string, SessionSummary>;
		};
		type RetryHarness = {
			stopWorker(worker: RetryWorker, removeDescriptor: boolean): Promise<void>;
			handleCommand(
				client: DaemonSocketClient,
				command: { type: "retry_worker"; activeSessionId: string },
			): Promise<unknown>;
		};
		const worker: RetryWorker = {
			descriptor: {
				workerId: "worker-stopping",
				rootActiveSessionId: "active-stopping",
				rootSessionId: "session-stopping",
				lifecycle: "ready",
				consecutiveFailures: 2,
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: true,
			},
			intentionalStop: true,
			summaries: new Map(),
		};
		const stopStarted = createDeferred<void>();
		const releaseStop = createDeferred<void>();
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			workerStopCounts: new Map(),
			stopWorkerUntracked: vi.fn(async () => {
				stopStarted.resolve();
				await releaseStop.promise;
			}),
			persistWorker,
			recoverWorker,
			assertWorkerAccessibleToClient: vi.fn(),
		}) as RetryHarness;

		const stopping = supervisor.stopWorker(worker, true);
		await stopStarted.promise;
		await expect(
			supervisor.handleCommand({} as DaemonSocketClient, {
				type: "retry_worker",
				activeSessionId: worker.descriptor.rootSessionId,
			}),
		).rejects.toThrow("Session worker is stopping; retry after it finishes");

		expect(worker.intentionalStop).toBe(true);
		expect(worker.descriptor.stopRequestedAt).toBeDefined();
		expect(worker.descriptor.archiveOnStop).toBe(true);
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();
		releaseStop.resolve();
		await stopping;
	});

	it("keeps a root kill registration through a synchronous shutdown event until exact cleanup", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-root-kill",
				pid: 123_456,
				processStartId: "proc:entry",
				rootActiveSessionId: "root-active",
				lifecycle: "ready" as const,
			},
			summaries: new Map<string, SessionSummary>([
				[
					"root-active",
					{ id: "root-active", sessionId: "root-session", activeSessionId: "root-active" } as SessionSummary,
				],
			]),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const deleteWorkerDescriptor = vi.fn();
		const stopWorkerUntracked = vi.fn(async (target: typeof worker, removeDescriptor: boolean) => {
			// The root-kill ownership and this exact stop are both active here.
			expect(supervisor.workerStopCounts.get(target)).toBe(2);
			expect(workers.get(target.descriptor.workerId)).toBe(target);
			workers.delete(target.descriptor.workerId);
			if (removeDescriptor) deleteWorkerDescriptor(target);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			workerStopCounts: new Map(),
			clients: new Set(),
			shuttingDown: false,
			streamReconstructor: { observe: vi.fn() },
			invalidateWorkerSnapshot: vi.fn(),
			refreshWorkerSummaries: vi.fn(async () => undefined),
			persistWorkerStopTombstone: vi.fn(),
			deleteWorkerDescriptor,
			broadcastHeartbeatsChanged: vi.fn(),
			findWorkerForClient: vi.fn(async () => ({
				worker,
				summary: worker.summaries.get("root-active"),
			})),
			forwardToWorker: vi.fn(async () => {
				supervisor.handleWorkerFrame(worker, {
					header: { kind: "outbound", outboundType: "session_closed", activeSessionId: "root-active" },
					payload: Buffer.from(JSON.stringify({ type: "session_closed", reason: "shutdown" })),
				});
				// The event arrives before the forwarded kill resolves.
				expect(workers.get(worker.descriptor.workerId)).toBe(worker);
				expect(deleteWorkerDescriptor).not.toHaveBeenCalled();
				return success(undefined, "kill");
			}),
			stopWorkerUntracked,
		}) as {
			workers: typeof workers;
			workerStopCounts: Map<typeof worker, number>;
			handleCommand(
				client: DaemonSocketClient,
				command: { type: "kill"; activeSessionId: string },
			): Promise<unknown>;
			handleWorkerFrame(target: typeof worker, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};

		await expect(
			supervisor.handleCommand({} as DaemonSocketClient, { type: "kill", activeSessionId: "root-active" }),
		).resolves.toEqual(success(undefined, "kill"));
		expect(stopWorkerUntracked).toHaveBeenCalledWith(worker, true, false, true, false, undefined);
		expect(workers.has(worker.descriptor.workerId)).toBe(false);
		expect(deleteWorkerDescriptor).toHaveBeenCalledWith(worker);
		expect(supervisor.workerStopCounts.has(worker)).toBe(false);
	});

	it("cancels an in-flight recovery after an intentional stop tombstone", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				rootActiveSessionId: string;
				stopRequestedAt?: string;
			};
			intentionalStop: boolean;
			recovery?: Promise<void>;
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: { workerId: "worker-1", pid: process.pid, rootActiveSessionId: "active-1" },
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		worker.intentionalStop = true;
		worker.descriptor.stopRequestedAt = new Date().toISOString();
		await vi.advanceTimersByTimeAsync(250);
		await recovery;

		expect(worker.recovery).toBeUndefined();
	});

	it("fails closed after pid reuse without fresh runtime context", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				processStartId: string;
				rootActiveSessionId: string;
				ownerClientId?: string;
				lifecycle?: string;
				consecutiveFailures: number;
				lastError?: string;
			};
			intentionalStop: boolean;
			stopRevision: number;
			recovery?: Promise<void>;
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			connectWorker: ReturnType<typeof vi.fn>;
			recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
			launchWorker: ReturnType<typeof vi.fn>;
			persistWorker: ReturnType<typeof vi.fn>;
			assertRecoveryAllowed: ReturnType<typeof vi.fn>;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-reused-pid",
				pid: process.pid,
				processStartId: "different-process-start",
				rootActiveSessionId: "active-1",
				consecutiveFailures: 0,
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			connectWorker: vi.fn(),
			recoverUncertainWorkerOperations: vi.fn(async () => {}),
			launchWorker: vi.fn(async () => worker),
			persistWorker: vi.fn(),
			assertRecoveryAllowed: vi.fn(async () => {}),
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		await vi.advanceTimersByTimeAsync(250);
		await recovery;

		expect(supervisor.connectWorker).not.toHaveBeenCalled();
		expect(supervisor.recoverUncertainWorkerOperations).toHaveBeenCalledWith(worker, false);
		expect(supervisor.launchWorker).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("failed");
		expect(supervisor.persistWorker).toHaveBeenCalledWith(worker);
	});

	it("rejects create reuse when a failed worker cannot be safely reclaimed", async () => {
		const worker = {
			descriptor: {
				workerId: "failed-unreclaimed",
				rootActiveSessionId: "active-failed",
				lifecycle: "failed",
			},
		};
		const supervisor = Object.create(DaemonSupervisor.prototype) as {
			reuseWorkerForCreate(
				target: typeof worker,
				ownerClientId: undefined,
				sessionPath: string,
			): Promise<typeof worker>;
		};

		await expect(supervisor.reuseWorkerForCreate(worker, undefined, "/tmp/failed.jsonl")).rejects.toThrow(
			/failed worker/,
		);
	});

	it("waits for worker recovery before reusing a saved session", async () => {
		const root = { id: "active-root", activeSessionId: "active-root", sessionId: "session-root", cwd: "/tmp" };
		const recovery = createDeferred<void>();
		const worker = {
			descriptor: {
				workerId: "recovering-worker",
				rootActiveSessionId: root.activeSessionId,
				lifecycle: "recovering",
			},
			client: undefined as object | undefined,
			summaries: new Map<string, SessionSummary>(),
			recovery: recovery.promise,
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
		}) as {
			reuseWorkerForCreate(
				target: typeof worker,
				ownerClientId: undefined,
				sessionPath: string,
			): Promise<typeof worker>;
		};

		let settled = false;
		const reused = supervisor.reuseWorkerForCreate(worker, undefined, "/tmp/session.jsonl").finally(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		worker.descriptor.lifecycle = "ready";
		worker.client = {};
		worker.summaries.set(root.activeSessionId, root as SessionSummary);
		recovery.resolve();

		await expect(reused).resolves.toBe(worker);
	});

	it("starts recovery before reusing a persisted recovering worker", async () => {
		const root = { id: "active-root", activeSessionId: "active-root", sessionId: "session-root", cwd: "/tmp" };
		const worker = {
			descriptor: {
				workerId: "persisted-recovering-worker",
				rootActiveSessionId: root.activeSessionId,
				lifecycle: "recovering",
			},
			client: undefined as object | undefined,
			summaries: new Map<string, SessionSummary>(),
			intentionalStop: false,
		};
		const recoverWorker = vi.fn(async () => {
			worker.descriptor.lifecycle = "ready";
			worker.client = {};
			worker.summaries.set(root.activeSessionId, root as SessionSummary);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			recoverWorker,
		}) as {
			reuseWorkerForCreate(
				target: typeof worker,
				ownerClientId: undefined,
				sessionPath: string,
			): Promise<typeof worker>;
		};

		await expect(supervisor.reuseWorkerForCreate(worker, undefined, "/tmp/session.jsonl")).resolves.toBe(worker);
		expect(recoverWorker).toHaveBeenCalledOnce();
	});

	it("starts recovery for a disconnected worker still marked ready", async () => {
		const root = { id: "active-root", activeSessionId: "active-root", sessionId: "session-root", cwd: "/tmp" };
		const worker = {
			descriptor: {
				workerId: "disconnected-ready-worker",
				rootActiveSessionId: root.activeSessionId,
				lifecycle: "ready",
			},
			client: undefined as object | undefined,
			summaries: new Map([[root.activeSessionId, root as SessionSummary]]),
			intentionalStop: false,
		};
		const recoverWorker = vi.fn(async () => {
			worker.client = {};
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			recoverWorker,
		}) as {
			reuseWorkerForCreate(
				target: typeof worker,
				ownerClientId: undefined,
				sessionPath: string,
			): Promise<typeof worker>;
		};

		await expect(supervisor.reuseWorkerForCreate(worker, undefined, "/tmp/session.jsonl")).resolves.toBe(worker);
		expect(recoverWorker).toHaveBeenCalledOnce();
	});

	it("rejects recovered workers whose assigned root is still missing", async () => {
		const worker = {
			descriptor: {
				workerId: "rootless-worker",
				rootActiveSessionId: "active-root",
				lifecycle: "ready",
			},
			client: {},
			summaries: new Map<string, SessionSummary>(),
			recovery: Promise.resolve(),
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
		}) as {
			reuseWorkerForCreate(
				target: typeof worker,
				ownerClientId: undefined,
				sessionPath: string,
			): Promise<typeof worker>;
		};

		await expect(supervisor.reuseWorkerForCreate(worker, undefined, "/tmp/session.jsonl")).rejects.toThrow(
			"assigned root session is missing",
		);
	});

	it("preserves cached summaries when recovery omits the assigned root", async () => {
		const root = { id: "active-root", activeSessionId: "active-root", sessionId: "session-root", cwd: "/tmp" };
		const worker = {
			descriptor: {
				workerId: "root-omitting-worker",
				rootActiveSessionId: root.activeSessionId,
			},
			client: {
				request: vi.fn(async () =>
					success(undefined, "list", {
						sessions: [{ id: "other", activeSessionId: "other", sessionId: "session-other", cwd: "/tmp" }],
					}),
				),
			},
			summaries: new Map([[root.activeSessionId, root as SessionSummary]]),
			intentionalStop: false,
		};
		const supervisor = Object.create(DaemonSupervisor.prototype) as {
			refreshWorkerSummaries(target: typeof worker, recovery: boolean): Promise<void>;
		};

		await expect(supervisor.refreshWorkerSummaries(worker, true)).rejects.toThrow(
			"Session worker omitted its root session during recovery",
		);
		expect(worker.summaries.get(root.activeSessionId)).toBe(root);
	});

	it("ignores conflicting paths on workers unrelated to a session lookup", () => {
		const unrelated = {
			descriptor: {
				workerId: "unrelated",
				sessionFile: "/tmp/unrelated-a.jsonl",
				createCommand: { type: "create" as const, sessionPath: "/tmp/unrelated-b.jsonl" },
			},
			summaries: new Map(),
		};
		const target = {
			descriptor: {
				workerId: "target",
				sessionFile: "/tmp/target.jsonl",
				createCommand: { type: "create" as const, sessionPath: "/tmp/target.jsonl" },
			},
			summaries: new Map(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([
				[unrelated.descriptor.workerId, unrelated],
				[target.descriptor.workerId, target],
			]),
		}) as {
			findWorkerBySessionFile(sessionFile: string): typeof target | undefined;
		};

		expect(supervisor.findWorkerBySessionFile("/tmp/target.jsonl")).toBe(target);
	});

	it("reclaims a dead failed resident so a fresh create can reopen its session", async () => {
		const worker = {
			descriptor: { workerId: "failed-resident", pid: 42, lifecycle: "failed" as const },
			intentionalStop: false,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const recoverUncertainWorkerOperations = vi.fn(async () => {});
		const deleteWorkerDescriptor = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			sessionInputPauses: new Map(),
			processIdentity: vi.fn(() => "gone"),
			recoverUncertainWorkerOperations,
			deleteWorkerDescriptor,
		}) as {
			reclaimStaleWorkerRegistration(target: typeof worker): Promise<boolean>;
		};

		await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(true);
		expect(recoverUncertainWorkerOperations).toHaveBeenCalledWith(worker, false);
		expect(deleteWorkerDescriptor).toHaveBeenCalledWith(worker);
		expect(workers.has(worker.descriptor.workerId)).toBe(false);
	});

	it("stops only an identity-verified failed resident when a fresh create arrives", async () => {
		const worker = {
			descriptor: {
				workerId: "failed-live-resident",
				pid: 42,
				processStartId: "verified-start",
				lifecycle: "failed" as const,
			},
			intentionalStop: false,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			processIdentity: vi.fn(() => "current"),
			stopWorker,
		}) as {
			reclaimStaleWorkerRegistration(target: typeof worker, freshCreate?: boolean): Promise<boolean>;
		};

		await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(false);
		expect(stopWorker).not.toHaveBeenCalled();
		await expect(supervisor.reclaimStaleWorkerRegistration(worker, true)).resolves.toBe(true);
		expect(stopWorker).toHaveBeenCalledWith(worker, true, true);
	});

	it("does not relaunch a live worker whose process identity is unknown", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				rootActiveSessionId: string;
				createCommand: { type: "create" };
				lifecycle?: string;
				consecutiveFailures: number;
				lastFailureAt?: string;
				lastError?: string;
			};
			intentionalStop: boolean;
			stopRevision: number;
			recovery?: Promise<void>;
			client?: { close(): void };
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			connectWorker: ReturnType<typeof vi.fn>;
			recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
			launchWorker: ReturnType<typeof vi.fn>;
			persistWorker: ReturnType<typeof vi.fn>;
			broadcastHeartbeatsChanged: ReturnType<typeof vi.fn>;
			log: ReturnType<typeof vi.fn>;
			assertRecoveryAllowed: ReturnType<typeof vi.fn>;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-unknown-identity",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				createCommand: { type: "create" },
				consecutiveFailures: 0,
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			connectWorker: vi.fn(async () => {
				throw new Error("worker socket unavailable");
			}),
			recoverUncertainWorkerOperations: vi.fn(async () => {}),
			launchWorker: vi.fn(async () => worker),
			persistWorker: vi.fn(),
			log: vi.fn(),
			assertRecoveryAllowed: vi.fn(async () => {}),
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		await vi.runAllTimersAsync();
		await recovery;

		expect(supervisor.connectWorker).toHaveBeenCalledTimes(3);
		expect(supervisor.recoverUncertainWorkerOperations).not.toHaveBeenCalled();
		expect(supervisor.launchWorker).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("failed");
	});

	it("reports a stop-tombstoned worker as stopping, not ready", () => {
		const worker = {
			descriptor: {
				workerId: "worker-tombstoned",
				pid: process.pid,
				lifecycle: "ready" as const,
				stopRequestedAt: new Date().toISOString(),
			},
			client: {},
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {}) as {
			effectiveWorkerState(target: object): string;
		};

		expect(supervisor.effectiveWorkerState(worker)).toBe("stopping");
	});

	it("never reports a disconnected worker as ready", () => {
		const worker = {
			descriptor: { workerId: "worker-disconnected", pid: process.pid, lifecycle: "ready" as const },
			client: undefined,
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {}) as {
			effectiveWorkerState(target: object): string;
		};

		expect(supervisor.effectiveWorkerState(worker)).toBe("recovering");
	});

	it("reports a connected ready worker as ready", () => {
		const worker = {
			descriptor: { workerId: "worker-live", pid: process.pid, lifecycle: "ready" as const },
			client: {},
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {}) as {
			effectiveWorkerState(target: object): string;
		};

		expect(supervisor.effectiveWorkerState(worker)).toBe("ready");
	});

	it("keeps stopping workers listed with an honest state for busy-daemon checks", async () => {
		const makeWorker = (workerId: string, stopRequestedAt?: string) => ({
			descriptor: {
				workerId,
				pid: process.pid,
				rootActiveSessionId: `${workerId}-active`,
				lifecycle: "ready" as const,
				...(stopRequestedAt ? { stopRequestedAt } : {}),
			},
			client: {},
			intentionalStop: false,
			summaries: new Map([
				[
					`${workerId}-active`,
					{
						id: `${workerId}-active`,
						activeSessionId: `${workerId}-active`,
						sessionId: `${workerId}-session`,
						cwd: "/tmp",
					} as unknown as SessionSummary,
				],
			]),
		});
		const liveWorker = makeWorker("worker-live");
		const stoppingWorker = makeWorker("worker-stopping", new Date().toISOString());
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([
				[liveWorker.descriptor.workerId, liveWorker],
				[stoppingWorker.descriptor.workerId, stoppingWorker],
			]),
			clients: new Set(),
			refreshWorkerSummaries: vi.fn(async () => {}),
			log: vi.fn(),
		}) as {
			handleList(
				client: object,
				command: { id: string; type: "list" },
			): Promise<{
				success: boolean;
				data?: { sessions: Array<{ activeSessionId?: string; id: string; workerState?: string }> };
			}>;
		};

		const response = await supervisor.handleList({}, { id: "list-1", type: "list" });

		expect(response.success).toBe(true);
		const sessions = response.data?.sessions ?? [];
		expect(sessions.map((session) => [session.activeSessionId ?? session.id, session.workerState]).sort()).toEqual([
			["worker-live-active", "ready"],
			["worker-stopping-active", "stopping"],
		]);
	});

	it("adopts a tombstoned worker through identity-aware stop handling", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-adopted-stop",
				pid: 111_123,
				processStartId: "proc:original",
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: true,
			},
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: vi.fn(async () => undefined),
			stopWorker,
			log: vi.fn(),
		}) as {
			adoptOrRecoverWorker(target: object): Promise<void>;
		};
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		try {
			await supervisor.adoptOrRecoverWorker(worker);

			expect(killSpy).not.toHaveBeenCalled();
			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, true);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("captures the live process identity before an adoption stop when the descriptor has none", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-adopted-legacy",
				pid: process.pid,
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: false,
			} as { processStartId?: string },
		};
		const stopOrder: string[] = [];
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker: vi.fn(async () => {
				stopOrder.push("connect");
			}),
			persistWorker: vi.fn(() => {
				stopOrder.push("persist");
			}),
			stopWorker: vi.fn(async () => {
				stopOrder.push("stop");
			}),
			log: vi.fn(),
		}) as {
			adoptOrRecoverWorker(target: object): Promise<void>;
		};

		await supervisor.adoptOrRecoverWorker(worker);

		// Identity is captured and persisted before the stop runs, so stopWorker
		// and its finalizer can signal the live process instead of waiting forever.
		expect(worker.descriptor.processStartId).toBe(getProcessStartId(process.pid));
		expect(stopOrder).toEqual(["connect", "persist", "stop"]);
	});

	it("keeps an unverifiable identity untrusted when the adoption connect fails", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-adopted-unverified",
				pid: process.pid,
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: false,
			} as { processStartId?: string },
		};
		const persistWorker = vi.fn();
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker: vi.fn(async () => {
				throw new Error("connect refused");
			}),
			persistWorker,
			stopWorker,
			log: vi.fn(),
		}) as {
			adoptOrRecoverWorker(target: object): Promise<void>;
		};

		await supervisor.adoptOrRecoverWorker(worker);

		// The pid could belong to anything; never adopt an identity the socket
		// handshake did not confirm.
		expect(worker.descriptor.processStartId).toBeUndefined();
		expect(persistWorker).not.toHaveBeenCalled();
		expect(stopWorker).toHaveBeenCalledWith(worker, true, true, false);
	});

	it("finalizes a timed-out stop once the worker process dies", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-timed-out-stop",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		let alive = true;
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockImplementation(() => alive);
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;
			expect(finalization).toBeDefined();

			await vi.advanceTimersByTimeAsync(500);
			expect(stopWorker).not.toHaveBeenCalled();

			alive = false;
			await vi.advanceTimersByTimeAsync(500);
			await finalization;

			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, false);
			expect(worker.stopFinalization).toBeUndefined();
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("escalates a stuck stop to SIGKILL before finalizing", async () => {
		vi.useFakeTimers();
		const processStartId = getProcessStartId(process.pid);
		if (processStartId === undefined) {
			throw new Error("Could not identify test process");
		}
		const worker = {
			descriptor: {
				workerId: "worker-stuck-stop",
				pid: process.pid,
				processStartId,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: true,
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		let alive = true;
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockImplementation(() => alive);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation((_pid, signal) => {
			if (signal === "SIGKILL") {
				alive = false;
			}
		});
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			await vi.advanceTimersByTimeAsync(10_000);
			await finalization;

			expect(killSpy).toHaveBeenCalledWith(worker.descriptor.pid, "SIGKILL");
			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, true);
		} finally {
			aliveSpy.mockRestore();
			killSpy.mockRestore();
		}
	});

	it("never follows a relaunched worker pid after a retry rescinds the stop", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-relaunched",
				pid: 111_111,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString() as string | undefined,
			},
			intentionalStop: true,
			stopRevision: 3,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			// An explicit retry rescinds the stop and relaunches with a new pid
			// while the old process is still wedged.
			await vi.advanceTimersByTimeAsync(1000);
			worker.descriptor.stopRequestedAt = undefined;
			worker.intentionalStop = false;
			worker.stopRevision = 4;
			worker.descriptor.pid = 222_222;

			await vi.advanceTimersByTimeAsync(20_000);
			await finalization;

			// The healthy relaunched worker must never be signalled or stopped.
			expect(killSpy).not.toHaveBeenCalledWith(222_222, "SIGKILL");
			expect(killSpy).not.toHaveBeenCalled();
			expect(stopWorker).not.toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
		}
	});

	it("treats a recycled pid as gone instead of killing its new owner", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-recycled-pid",
				pid: 111_112,
				processStartId: "proc:original",
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const sessionLeaseModule = await import("../src/core/session-lease.js");
		// The pid is alive, but it now belongs to an unrelated process.
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		const startIdSpy = vi.spyOn(sessionLeaseModule, "getProcessStartId").mockReturnValue("proc:recycled");
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			await vi.advanceTimersByTimeAsync(20_000);
			await finalization;

			// The original worker is gone, so the stop is finalized without ever
			// signalling the unrelated pid owner.
			expect(killSpy).not.toHaveBeenCalled();
			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, false);
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
			startIdSpy.mockRestore();
		}
	});

	it("aborts stale stop cleanup when the worker was relaunched during an await", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-relaunched-during-stop",
				pid: 111_115,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString() as string | undefined,
				archiveOnStop: true,
			},
			client: undefined,
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: true,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			persistWorker: vi.fn(),
			persistWorkerStopTombstone: vi.fn(),
			reclaimStoppedWorkerCronLock: vi.fn(),
			// Archival yields, and a retry relaunches the worker meanwhile.
			finalizeArchivedWorkerStop: vi.fn(async () => {
				worker.descriptor.pid = 222_222;
				worker.descriptor.stopRequestedAt = undefined;
			}),
			deleteWorkerDescriptor: vi.fn(),
			broadcastHeartbeatsChanged: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as unknown as {
			stopWorker(
				target: object,
				removeDescriptor: boolean,
				force?: boolean,
				archiveSession?: boolean,
			): Promise<void>;
			deleteWorkerDescriptor: ReturnType<typeof vi.fn>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(false);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			await expect(supervisor.stopWorker(worker, true, true, true)).rejects.toThrow("was relaunched during stop");

			// The relaunched worker's registration and descriptor must survive.
			expect(workers.has(worker.descriptor.workerId)).toBe(true);
			expect(supervisor.deleteWorkerDescriptor).not.toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("aborts stale stop cleanup when the stop is rescinded before the relaunch lands", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-rescinded-during-stop",
				pid: 111_120,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString() as string | undefined,
				archiveOnStop: true,
			},
			client: undefined,
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: true,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			persistWorker: vi.fn(),
			persistWorkerStopTombstone: vi.fn(),
			reclaimStoppedWorkerCronLock: vi.fn(),
			// A retry rescinds the tombstone while archival yields, before
			// recoverWorker has assigned the successor pid.
			finalizeArchivedWorkerStop: vi.fn(async () => {
				worker.descriptor.stopRequestedAt = undefined;
			}),
			deleteWorkerDescriptor: vi.fn(),
			broadcastHeartbeatsChanged: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as unknown as {
			stopWorker(
				target: object,
				removeDescriptor: boolean,
				force?: boolean,
				archiveSession?: boolean,
			): Promise<void>;
			deleteWorkerDescriptor: ReturnType<typeof vi.fn>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(false);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			await expect(supervisor.stopWorker(worker, true, true, true)).rejects.toThrow("was relaunched during stop");

			// The revived registration and descriptor must survive for recovery.
			expect(workers.has(worker.descriptor.workerId)).toBe(true);
			expect(supervisor.deleteWorkerDescriptor).not.toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("never signals an identity-less worker pid during a forced stop", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-force-missing-identity",
				pid: 111_122,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: true,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			persistWorker: vi.fn(),
			persistWorkerStopTombstone: vi.fn(),
			scheduleWorkerStopFinalization: vi.fn(),
			broadcastHeartbeatsChanged: vi.fn(),
		}) as unknown as {
			stopWorker(target: object, removeDescriptor: boolean, force?: boolean): Promise<void>;
			scheduleWorkerStopFinalization: ReturnType<typeof vi.fn>;
		};
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		try {
			const stopping = supervisor.stopWorker(worker, true, true).then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(2000);

			const error = await stopping;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("Session worker worker-force-missing-identity did not stop");
			expect(killSpy).not.toHaveBeenCalled();
			expect(supervisor.scheduleWorkerStopFinalization).toHaveBeenCalledWith(worker);
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
		}
	});

	it("re-verifies identity at SIGKILL time even within the throttle window", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-kill-window-recycle",
				pid: 111_118,
				processStartId: "proc:original",
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(worker.descriptor.workerId);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const sessionLeaseModule = await import("../src/core/session-lease.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		// The worker is current on the throttled polls, but the pid is recycled
		// by the time the SIGKILL deadline arrives.
		const startIdSpy = vi.spyOn(sessionLeaseModule, "getProcessStartId").mockReturnValue("proc:original");
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			await vi.advanceTimersByTimeAsync(4900);
			startIdSpy.mockReturnValue("proc:recycled");
			await vi.advanceTimersByTimeAsync(2000);

			// The fresh check at signal time sees the recycled pid and holds fire.
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
			startIdSpy.mockRestore();
		}
	});

	it("retries SIGKILL after a transient identity outage at the deadline", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-kill-retry",
				pid: 111_119,
				processStartId: "proc:original",
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(worker.descriptor.workerId);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const sessionLeaseModule = await import("../src/core/session-lease.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		let alive = true;
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockImplementation(() => alive);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation((_pid, signal) => {
			if (signal === "SIGKILL") {
				alive = false;
			}
		});
		// Identity observation is down when the SIGKILL deadline passes...
		const startIdSpy = vi.spyOn(sessionLeaseModule, "getProcessStartId").mockReturnValue(undefined);
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			await vi.advanceTimersByTimeAsync(8000);
			expect(killSpy).not.toHaveBeenCalled();

			// ...but once identity is observable again, escalation still fires.
			startIdSpy.mockReturnValue("proc:original");
			await vi.advanceTimersByTimeAsync(5000);
			await finalization;
			expect(killSpy).toHaveBeenCalledWith(worker.descriptor.pid, "SIGKILL");
			expect(stopWorker).toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
			startIdSpy.mockRestore();
		}
	});

	it("keeps waiting when process identity is transiently unobservable", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-unknown-identity-stop",
				pid: 111_114,
				processStartId: "proc:original",
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const sessionLeaseModule = await import("../src/core/session-lease.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		// Identity observation fails transiently (e.g. ps unavailable).
		const startIdSpy = vi.spyOn(sessionLeaseModule, "getProcessStartId").mockReturnValue(undefined);
		try {
			supervisor.scheduleWorkerStopFinalization(worker);

			await vi.advanceTimersByTimeAsync(20_000);

			// The possibly-live worker is neither signalled nor cleaned up.
			expect(killSpy).not.toHaveBeenCalled();
			expect(stopWorker).not.toHaveBeenCalled();
			expect(worker.stopFinalization).toBeDefined();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
			startIdSpy.mockRestore();
		}
	});

	it("never SIGKILLs an identity-less worker pid", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-missing-identity",
				pid: 111_121,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const sessionLeaseModule = await import("../src/core/session-lease.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		const startIdSpy = vi.spyOn(sessionLeaseModule, "getProcessStartId").mockReturnValue("proc:unrelated");
		try {
			supervisor.scheduleWorkerStopFinalization(worker);

			await vi.advanceTimersByTimeAsync(20_000);

			expect(killSpy).not.toHaveBeenCalled();
			expect(stopWorker).not.toHaveBeenCalled();
			expect(worker.stopFinalization).toBeDefined();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
			startIdSpy.mockRestore();
		}
	});

	it("retries finalization after a transient cleanup failure", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-transient-cleanup",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi
			.fn(async () => {
				workers.delete(worker.descriptor.workerId);
			})
			.mockImplementationOnce(async () => {
				throw new Error("archive temporarily unavailable");
			});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			await vi.advanceTimersByTimeAsync(20_000);
			await finalization;

			// The first attempt failed transiently; the registration is still
			// cleaned up by a retry instead of being stranded forever.
			expect(stopWorker).toHaveBeenCalledTimes(2);
			expect(workers.size).toBe(0);
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("leaves a rescinded stop to the retry flow instead of finalizing it", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-rescinded-stop",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString() as string | undefined,
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		let alive = true;
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockImplementation(() => alive);
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			// An explicit retry revives the worker while its process is exiting.
			worker.descriptor.stopRequestedAt = undefined;
			worker.intentionalStop = false;
			alive = false;
			await vi.advanceTimersByTimeAsync(500);
			await finalization;

			expect(stopWorker).not.toHaveBeenCalled();
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("reclaims a stale tombstoned registration whose process is gone", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-stale-registration",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(worker.descriptor.workerId);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(true);
			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, false);
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("reclaims a stale registration whose pid was recycled by another process", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-recycled-registration",
				pid: 111_113,
				processStartId: "proc:original",
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(worker.descriptor.workerId);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const sessionLeaseModule = await import("../src/core/session-lease.js");
		// The pid is alive, but it belongs to an unrelated process now.
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const startIdSpy = vi.spyOn(sessionLeaseModule, "getProcessStartId").mockReturnValue("proc:recycled");
		try {
			await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(true);
			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, false);
		} finally {
			aliveSpy.mockRestore();
			startIdSpy.mockRestore();
		}
	});

	it("waits for an in-flight stop finalization instead of stopping twice", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-finalizing",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		let releaseFinalization!: () => void;
		worker.stopFinalization = new Promise<void>((resolveFinalization) => {
			releaseFinalization = () => {
				workers.delete(worker.descriptor.workerId);
				resolveFinalization();
			};
		});
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};

		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			const reclaim = supervisor.reclaimStaleWorkerRegistration(worker);
			releaseFinalization();

			// The reclaim defers to the finalizer's cleanup instead of duplicating it.
			await expect(reclaim).resolves.toBe(true);
			expect(stopWorker).not.toHaveBeenCalled();
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("fails resume honestly when confirmed-dead cleanup outlasts the bounded wait", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-slow-cleanup",
				pid: 111_117,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			// Cleanup hangs past the bounded reclaim wait.
			stopWorker: vi.fn(() => new Promise<void>(() => {})),
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			const reclaim = supervisor.reclaimStaleWorkerRegistration(worker);
			const outcome = reclaim.then(
				() => "reused",
				() => "failed",
			);
			await vi.advanceTimersByTimeAsync(60_000);

			// The dead registration is never handed back to the resume path.
			await expect(outcome).resolves.toBe("failed");
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("shares one stop between concurrent resume reclaims", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-concurrent-reclaim",
				pid: 111_116,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(worker.descriptor.workerId);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			const results = await Promise.all([
				supervisor.reclaimStaleWorkerRegistration(worker),
				supervisor.reclaimStaleWorkerRegistration(worker),
			]);

			expect(results).toEqual([true, true]);
			// Both concurrent resumes share the single-flighted finalizer stop.
			expect(stopWorker).toHaveBeenCalledTimes(1);
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("does not reclaim a stopping worker whose process is still alive", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-still-alive",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		try {
			await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(false);
			expect(stopWorker).not.toHaveBeenCalled();
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("does not reclaim a healthy connected worker", async () => {
		const worker = {
			descriptor: { workerId: "worker-healthy", pid: process.pid, rootActiveSessionId: "active-1" },
			client: {},
			recovery: undefined,
			intentionalStop: false,
			stopRevision: 0,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};

		await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(false);
		expect(stopWorker).not.toHaveBeenCalled();
	});

	it("ignores malformed persisted worker descriptors", () => {
		const descriptorDir = mkdtempSync(join(tmpdir(), "prime-supervisor-descriptor-test-"));
		try {
			writeFileSync(
				join(descriptorDir, "malformed.json"),
				`${JSON.stringify({
					version: 1,
					supervisorSocketPath: "/tmp/supervisor.sock",
					workerId: "worker-1",
					rootActiveSessionId: "active-1",
				})}\n`,
			);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				descriptorDir,
				socketPath: "/tmp/supervisor.sock",
				workers: new Map(),
				log: vi.fn(),
			}) as {
				workers: Map<string, unknown>;
				loadWorkerDescriptors(): void;
			};

			supervisor.loadWorkerDescriptors();

			expect(supervisor.workers.size).toBe(0);
		} finally {
			rmSync(descriptorDir, { recursive: true, force: true });
		}
	});

	it("merges persisted host settings into fresh runtime defaults", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-config-merge-"));
		const descriptorDir = join(root, "workers");
		const socketPath = join(root, "supervisor.sock");
		const agentDir = join(root, "agent");
		mkdirSync(descriptorDir, { recursive: true });
		writeFileSync(
			join(descriptorDir, "supervisor-config"),
			JSON.stringify({
				version: 1,
				socketPath: `${root}//supervisor.sock`,
				defaultSessionConfig: { agentDir, cwd: "/persisted/cwd", telemetryDisabled: true },
			}),
		);

		try {
			const supervisor = new DaemonSupervisor(socketPath, {
				descriptorDir,
				defaultSessionConfig: {
					agentDir,
					cwd: "/fresh/cwd",
					provider: "fresh-provider",
					model: "fresh-model",
					apiKey: "fresh-key",
				},
			});
			const config = (supervisor as unknown as { defaultSessionConfig: Record<string, unknown> })
				.defaultSessionConfig;

			expect(config).toMatchObject({
				agentDir,
				cwd: "/persisted/cwd",
				telemetryDisabled: true,
				provider: "fresh-provider",
				model: "fresh-model",
				apiKey: "fresh-key",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("migrates v1 descriptors by lifting only safe host policy fields", () => {
		const descriptorDir = mkdtempSync(join(tmpdir(), "prime-supervisor-v1-migration-"));
		const descriptorPath = join(descriptorDir, "worker-v1.json");
		try {
			writeFileSync(
				descriptorPath,
				`${JSON.stringify({
					version: 1,
					workerId: "worker-v1",
					pid: 42,
					socketPath: "/tmp/worker-v1.sock",
					recoveryJournalPath: join(descriptorDir, "worker-v1.recovery.jsonl"),
					supervisorSocketPath: "/tmp/supervisor.sock",
					authenticationToken: "local-token",
					rootActiveSessionId: "active-v1",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					lifecycle: "ready",
					createCommand: {
						type: "create",
						config: {
							sessionDir: "/safe/sessions",
							telemetryDisabled: true,
							apiKey: "secret-api-key",
							extensionFlagValues: { providerSecretKey: "secret-provider-key" },
						},
						launchEnv: { PROVIDER_TOKEN: "secret-env" },
					},
					launchEnv: { PROVIDER_TOKEN: "secret-top-level-env" },
					consecutiveFailures: 0,
				})}\n`,
			);
			const workers = new Map<string, { descriptor: Record<string, unknown> }>();
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				descriptorDir,
				socketPath: "/tmp/supervisor.sock",
				workers,
				log: vi.fn(),
			}) as {
				loadWorkerDescriptors(): void;
				persistWorker(target: unknown): void;
			};

			supervisor.loadWorkerDescriptors();

			const migrated = JSON.parse(readFileSync(descriptorPath, "utf8"));
			expect(migrated).toMatchObject({
				version: 2,
				sessionDir: "/safe/sessions",
				telemetryDisabled: true,
				createCommand: { type: "create" },
			});
			expect(JSON.stringify(migrated)).not.toContain("secret-");
			const runtimeWorker = workers.get("worker-v1");
			expect(runtimeWorker?.descriptor).toMatchObject({
				sessionDir: "/safe/sessions",
				telemetryDisabled: true,
			});
			if (!runtimeWorker) throw new Error("missing migrated worker");
			runtimeWorker.descriptor.lifecycle = "failed";
			runtimeWorker.descriptor.lastError = "secret-runtime-diagnostic";
			supervisor.persistWorker(runtimeWorker);
			expect(runtimeWorker.descriptor.lastError).toBe("secret-runtime-diagnostic");
			expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toMatchObject({
				lastError: "Waiting for a client with fresh runtime context",
			});
			expect(readFileSync(descriptorPath, "utf8")).not.toContain("secret-runtime-diagnostic");
		} finally {
			rmSync(descriptorDir, { recursive: true, force: true });
		}
	});

	it("adopts persisted worker descriptors recorded with a non-canonical supervisor socket path", () => {
		if (process.platform === "win32") {
			return;
		}
		const descriptorDir = mkdtempSync(join(tmpdir(), "prime-supervisor-descriptor-heal-"));
		try {
			const now = new Date().toISOString();
			writeFileSync(
				join(descriptorDir, "worker-1.json"),
				`${JSON.stringify({
					version: 2,
					workerId: "worker-1",
					pid: 999_999,
					socketPath: join(descriptorDir, "worker-1.sock"),
					supervisorSocketPath: "/tmp//supervisor.sock",
					authenticationToken: "token-1",
					rootActiveSessionId: "active-1",
					createdAt: now,
					updatedAt: now,
					lifecycle: "running",
					sessionDir: "/safe/sessions",
					telemetryDisabled: true,
					createCommand: {
						type: "create",
						config: { cwd: descriptorDir, agentDir: descriptorDir, apiKey: "secret-api-key" },
						launchEnv: { PROVIDER_TOKEN: "secret-command-env" },
					},
					launchEnv: { PROVIDER_TOKEN: "secret-worker-env" },
					consecutiveFailures: 0,
				})}\n`,
			);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				descriptorDir,
				socketPath: "/tmp/supervisor.sock",
				workers: new Map(),
				log: vi.fn(),
			}) as {
				workers: Map<string, unknown>;
				loadWorkerDescriptors(): void;
			};

			supervisor.loadWorkerDescriptors();

			expect(supervisor.workers.size).toBe(1);
			const loaded = supervisor.workers.get("worker-1") as {
				descriptor: Record<string, unknown>;
			};
			expect(loaded.descriptor).toMatchObject({
				version: 2,
				supervisorSocketPath: "/tmp/supervisor.sock",
				sessionDir: "/safe/sessions",
				telemetryDisabled: true,
			});
			expect(JSON.stringify(loaded.descriptor)).not.toContain("secret-");
			const persisted = readFileSync(join(descriptorDir, "worker-1.json"), "utf8");
			expect(persisted).not.toContain("secret-");
			expect(JSON.parse(persisted)).toMatchObject({
				version: 2,
				supervisorSocketPath: "/tmp/supervisor.sock",
			});
		} finally {
			rmSync(descriptorDir, { recursive: true, force: true });
		}
	});

	it("derives the same worker descriptor namespace for equivalent socket path spellings", () => {
		if (process.platform === "win32") {
			return;
		}
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-namespace-"));
		try {
			const canonical = new DaemonSupervisor(join(root, "supervisor.sock"), {
				defaultSessionConfig: { cwd: root, agentDir: root },
			}) as unknown as { descriptorDir: string };
			const doubled = new DaemonSupervisor(`${root}//supervisor.sock`, {
				defaultSessionConfig: { cwd: root, agentDir: root },
			}) as unknown as { descriptorDir: string };

			expect(doubled.descriptorDir).toBe(canonical.descriptorDir);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("seeds compact attach streaming from the in-flight assistant message", async () => {
		const assistant = (text: string): AgentMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		const activeSessionId = "active-1";
		const finalizedMessage = assistant("finalized");
		const streamingMessage = assistant("in flight");
		const summary: SessionSummary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "working",
			isSessionActive: true,
			sessionId: "session-1",
			cwd: "/tmp/project",
			isStreaming: true,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 1,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			streamingMessage,
		};
		const result = {
			activeSessionId,
			snapshot: { summary, messages: [finalizedMessage] },
		} as unknown as DaemonAttachResult;
		const worker = {
			descriptor: { workerId: "worker-1", lifecycle: "ready", pid: 1234 },
			client: {},
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map([[activeSessionId, result]]),
			snapshotTransferFrames: new Map(),
			snapshotLoads: new Map(),
		};
		const client = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const seed = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			streamReconstructor: { seed },
			syncWorkerExtensionUi: vi.fn(async () => {}),
		}) as {
			attachClient(
				client: {
					id: string;
					capabilities: Set<string>;
					supportsExtensionUi: boolean;
					attachedActiveSessionIds: Set<string>;
				},
				command: { type: "attach"; activeSessionId: string },
			): Promise<unknown>;
		};

		await supervisor.attachClient(client, { type: "attach", activeSessionId });

		expect(seed).toHaveBeenCalledWith(activeSessionId, streamingMessage);
	});

	it("reconstructs a client-owned recovery command from fresh attach context", async () => {
		const activeSessionId = "active-owned-recovery";
		const worker = {
			descriptor: {
				workerId: "worker-owned-recovery",
				ownerClientId: "client-1",
				rootActiveSessionId: activeSessionId,
				lifecycle: "failed",
				consecutiveFailures: 1,
				telemetryDisabled: true,
				createCommand: { type: "create" as const, sessionPath: "/tmp/session.jsonl" },
			},
			summaries: new Map(),
			intentionalStop: false,
			stopRevision: 0,
			launchEnv: undefined as Record<string, string> | undefined,
			transientCreateCommand: undefined as Record<string, unknown> | undefined,
		};
		const client = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const recoverWorker = vi.fn(async () => {
			throw new Error("stop after reconstruction");
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			protocolClientIds: new WeakMap(),
			persistWorker: vi.fn(),
			recoverWorker,
		}) as {
			attachClient(
				attachClient: typeof client,
				command: {
					type: "attach";
					activeSessionId: string;
					recoveryConfig: { cwd: string };
					launchEnv: Record<string, string>;
					env: Record<string, string>;
				},
			): Promise<unknown>;
		};

		await expect(
			supervisor.attachClient(client, {
				type: "attach",
				activeSessionId,
				recoveryConfig: { cwd: "/tmp/fresh-owner" },
				launchEnv: { OWNER_SECRET: "fresh" },
				env: { HERDR_PANE_ID: "pane-1" },
			}),
		).rejects.toThrow("stop after reconstruction");
		expect(worker.transientCreateCommand).toEqual({
			type: "create",
			sessionPath: "/tmp/session.jsonl",
			config: { cwd: "/tmp/fresh-owner", telemetryDisabled: true },
			env: { HERDR_PANE_ID: "pane-1" },
			launchEnv: { OWNER_SECRET: "fresh" },
			lifecycle: "client_owned",
		});
		expect(worker.launchEnv).toEqual({ OWNER_SECRET: "fresh" });
		expect(recoverWorker).toHaveBeenCalledWith(worker);
	});

	it("rejects an opted-out attach to a telemetry-enabled worker", async () => {
		const activeSessionId = "active-telemetry-enabled";
		const summary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			sessionId: "session-telemetry-enabled",
			cwd: "/tmp/project",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		} satisfies SessionSummary;
		const worker = {
			descriptor: {
				workerId: "worker-telemetry-enabled",
				lifecycle: "ready",
				pid: 1234,
				createCommand: { type: "create", config: {} },
			},
			summaries: new Map([[activeSessionId, summary]]),
		};
		const client = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
		}) as {
			attachClient(
				attachClient: typeof client,
				command: { type: "attach"; activeSessionId: string; telemetryDisabled?: true },
			): Promise<unknown>;
		};

		await expect(
			supervisor.attachClient(client, { type: "attach", activeSessionId, telemetryDisabled: true }),
		).rejects.toThrow("Cannot attach to this active agent while telemetry is disabled");
		expect(client.attachedActiveSessionIds).toEqual(new Set());
	});

	it("does not reveal an owned session's telemetry policy to another client", async () => {
		const activeSessionId = "private-owned-active";
		const worker = {
			descriptor: {
				workerId: "private-owned-worker",
				ownerClientId: "owner-client",
				rootActiveSessionId: activeSessionId,
				lifecycle: "ready",
				pid: 1234,
				createCommand: { type: "create", config: {} },
			},
		};
		const client = {
			id: "other-client",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			protocolClientIds: new Map(),
		}) as {
			attachClient(
				attachClient: typeof client,
				command: { type: "attach"; activeSessionId: string; telemetryDisabled?: true },
			): Promise<unknown>;
		};

		await expect(
			supervisor.attachClient(client, { type: "attach", activeSessionId, telemetryDisabled: true }),
		).rejects.toThrow(`Unknown active session: ${activeSessionId}`);
	});

	it("catches up only after worker events are skipped behind a backpressured write", async () => {
		const activeSessionId = "active-backpressure";
		const writes: string[] = [];
		const write = vi.fn((data: unknown) => {
			writes.push(String(data));
			return false;
		});
		const client = {
			id: "client-1",
			socket: { destroyed: false, write },
			attachedActiveSessionIds: new Set([activeSessionId]),
			catchupActiveSessionIds: new Set<string>(),
			backpressured: false,
			supportsExtensionUi: false,
			capabilities: new Set(),
		} as unknown as DaemonSocketClient;
		const worker = {
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map(),
		};
		const catchUpClient = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			clients: new Set([client]),
			streamReconstructor: { observe: vi.fn() },
			catchUpClient,
			invalidateWorkerSnapshot: vi.fn(),
		}) as {
			handleWorkerFrame(residentWorker: typeof worker, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		const frame = (error: string, extensionPath: string): PrivateFrame<DaemonWorkerFrameHeader> => ({
			header: { kind: "outbound", outboundType: "extension_error", activeSessionId },
			payload: Buffer.from(
				`${JSON.stringify({ type: "extension_error", activeSessionId, extensionPath, event: "load", error })}\n`,
			),
		});

		supervisor.handleWorkerFrame(worker, frame("first", "x".repeat(1024 * 1024)));

		expect(client.backpressured).toBe(true);
		expect(client.catchupActiveSessionIds).toEqual(new Set());
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain('"error":"first"');

		supervisor.handleWorkerFrame(worker, frame("skipped", "/tmp/extension.ts"));

		expect(writes).toHaveLength(1);
		expect(client.catchupActiveSessionIds).toEqual(new Set([activeSessionId]));
		expect(catchUpClient).not.toHaveBeenCalled();
	});

	it("subscribes to worker updates with chunked snapshots", async () => {
		type SubscriptionWorker = {
			client: { requestWorker: (command: unknown) => Promise<{ success: boolean }> };
		};
		const requestWorker = vi.fn(async () => ({ success: true }));
		const worker: SubscriptionWorker = { client: { requestWorker } };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			clients: new Set(),
		}) as {
			subscribeWorker(worker: SubscriptionWorker, activeSessionId: string): Promise<void>;
		};

		await supervisor.subscribeWorker(worker, "active-1");

		expect(requestWorker).toHaveBeenCalledWith({
			type: "worker_subscribe",
			activeSessionId: "active-1",
			capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
			supportsExtensionUi: false,
		});
	});

	it("does not retain an attachment when snapshot loading fails", async () => {
		type AttachClient = {
			id: string;
			capabilities: Set<string>;
			supportsExtensionUi: boolean;
			attachedActiveSessionIds: Set<string>;
		};
		const activeSessionId = "active-failed-attach";
		const summary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			sessionId: "session-failed-attach",
			cwd: "/tmp/project",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		} satisfies SessionSummary;
		const worker = {
			descriptor: { workerId: "worker-1", lifecycle: "ready", pid: 1234 },
			client: {
				request: vi.fn(async () => {
					throw new Error("snapshot failed");
				}),
			},
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			snapshotTransferFrames: new Map(),
			snapshotLoads: new Map(),
		};
		const client: AttachClient = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
		}) as {
			attachClient(client: AttachClient, command: { type: "attach"; activeSessionId: string }): Promise<unknown>;
		};

		await expect(supervisor.attachClient(client, { type: "attach", activeSessionId })).rejects.toThrow(
			"snapshot failed",
		);
		expect(client.attachedActiveSessionIds).toEqual(new Set());
	});

	it("marks each busy worker session interrupted independently", async () => {
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				rootActiveSessionId: string;
				recoveryJournalPath: string;
				orphanProcessJournalPath: string;
			};
		};
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-recovery-test-"));
		const journalPath = join(root, "worker.recovery.jsonl");
		const orphanJournalPath = join(root, "worker.orphans.jsonl");
		writeFileSync(
			orphanJournalPath,
			`${JSON.stringify({
				version: 1,
				pid: 987_654,
				ownerPid: process.pid,
				processStartId: "reused-process",
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);
		const journal = new WorkerRecoveryJournal(journalPath);
		journal.record({
			activeSessionId: "root-active",
			sessionId: "root-session",
			sessionFile: "/tmp/root.jsonl",
			busy: true,
			operation: "model_stream",
		});
		journal.record({
			activeSessionId: "child-active",
			sessionId: "child-session",
			sessionFile: "/tmp/child.jsonl",
			busy: true,
			operation: "tool_execution",
		});
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-1",
				pid: process.pid,
				rootActiveSessionId: "root-active",
				recoveryJournalPath: journalPath,
				orphanProcessJournalPath: orphanJournalPath,
			},
		};
		const markInterrupted = vi.fn(async () => undefined);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			catalog: { markInterrupted },
			log: vi.fn(),
			assertRecoveryAllowed: vi.fn(async () => {}),
		}) as {
			recoverUncertainWorkerOperations(worker: RecoveryWorker, killWorkerProcess: boolean): Promise<void>;
		};

		try {
			await supervisor.recoverUncertainWorkerOperations(worker, false);
			expect(kill).not.toHaveBeenCalled();
			expect(markInterrupted).toHaveBeenCalledTimes(2);
			expect(markInterrupted).toHaveBeenCalledWith("/tmp/root.jsonl", "root-active", ["model_stream"]);
			expect(markInterrupted).toHaveBeenCalledWith("/tmp/child.jsonl", "child-active", ["tool_execution"]);
		} finally {
			kill.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it.each([
		{ name: "malformed data", data: undefined, error: /invalid update manifest/ },
		{
			name: "missing root disposition",
			data: { formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION, createdAt: "now", sessions: [] },
			error: /root disposition/,
		},
	])("cancels a prepare acknowledgement with $name", async ({ data, error }) => {
		const client = {
			requestWorker: vi.fn(async ({ type }: { type: string }) =>
				type === "worker_prepare_update" ? { success: true, data } : { success: true },
			),
			close: vi.fn(),
		};
		const worker = {
			descriptor: { workerId: "worker", lifecycle: "ready", rootActiveSessionId: "root" },
			client,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([["worker", worker]]),
		}) as { prepareUpdateRestartFenced(): Promise<unknown> };
		await expect(supervisor.prepareUpdateRestartFenced()).rejects.toThrow(error);
		expect(client.requestWorker).toHaveBeenCalledWith({ type: "worker_cancel_update" }, 5000);
	});

	it("accepts an explicitly discarded empty root", async () => {
		const client = {
			requestWorker: vi.fn(async ({ type }: { type: string }) =>
				type === "worker_prepare_update"
					? {
							success: true,
							data: {
								formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION,
								createdAt: "now",
								sessions: [],
								discardedActiveSessionIds: ["root"],
							},
						}
					: { success: true },
			),
		};
		const worker = {
			descriptor: { workerId: "worker", lifecycle: "ready", rootActiveSessionId: "root" },
			client,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([["worker", worker]]),
			validateAndPersistUpdateManifest: vi.fn(),
			stopWorker: vi.fn(async () => undefined),
		}) as { prepareUpdateRestartFenced(): Promise<{ discardedActiveSessionIds?: string[] }> };
		await expect(supervisor.prepareUpdateRestartFenced()).resolves.toMatchObject({
			discardedActiveSessionIds: ["root"],
		});
	});

	it("replays completed journaled mutations during restart preparation without taking a mutation lease", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-command-replay-"));
		const commandJournal = new CommandRecoveryJournal(join(root, "commands.jsonl"));
		const response = success("command-1", "kill");
		commandJournal.begin("client-1", "command-1", "kill");
		commandJournal.recordResult("client-1", "command-1", response);
		const writes: string[] = [];
		const client = {
			id: "socket-client",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			},
		} as unknown as DaemonSocketClient;
		const mutationDrain = { begin: vi.fn(), end: vi.fn() };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			workers: new Map(),
			protocolClientIds: new WeakMap(),
			commandJournal,
			mutationDrain,
			updateRestartPhase: "fencing",
			assertCurrentOwnership: vi.fn(async () => undefined),
			cancelOwnedWorkerCleanup: vi.fn(),
			handleCommand: vi.fn(async () => {
				throw new Error("completed command was dispatched again");
			}),
		}) as unknown as {
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};

		try {
			await supervisor.handleLine(
				client,
				JSON.stringify(
					createDaemonCommandEnvelope({ type: "kill", activeSessionId: "session-1" }, "command-1", "client-1"),
				),
			);
			expect(writes).toEqual([`${JSON.stringify(response)}\n`]);
			expect(mutationDrain.begin).not.toHaveBeenCalled();
			expect(mutationDrain.end).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects genuinely new mutations during restart preparation without journaling or leasing them", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-command-reject-"));
		const commandJournal = new CommandRecoveryJournal(join(root, "commands.jsonl"));
		const writes: string[] = [];
		const client = {
			id: "socket-client",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			},
		} as unknown as DaemonSocketClient;
		const mutationDrain = { begin: vi.fn(), end: vi.fn() };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			workers: new Map(),
			protocolClientIds: new WeakMap(),
			commandJournal,
			mutationDrain,
			updateRestartPhase: "fencing",
			assertCurrentOwnership: vi.fn(async () => undefined),
			cancelOwnedWorkerCleanup: vi.fn(),
		}) as unknown as {
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};

		try {
			await supervisor.handleLine(
				client,
				JSON.stringify(
					createDaemonCommandEnvelope({ type: "kill", activeSessionId: "session-1" }, "command-2", "client-1"),
				),
			);
			expect(writes.join(" ")).toContain("Daemon is preparing an update restart");
			expect(commandJournal.lookup("client-1", "command-2")).toBeUndefined();
			expect(mutationDrain.begin).not.toHaveBeenCalled();
			expect(mutationDrain.end).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fences and drains a mutation admitted at the first drain boundary before worker prepare", async () => {
		const mutationDrain = new MutationDrainLatch();
		const firstDrain = createDeferred();
		const originalWaitForDrain = mutationDrain.waitForDrain.bind(mutationDrain);
		vi.spyOn(mutationDrain, "waitForDrain").mockImplementationOnce(async (...args) => {
			await originalWaitForDrain(...args);
			mutationDrain.begin();
			firstDrain.resolve();
		});
		mutationDrain.begin(); // The prepare command itself remains in flight at the supervisor boundary.
		const prepareFenced = vi.fn(async () => ({
			formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION,
			createdAt: "now",
			sessions: [],
		}));
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			mutationDrain,
			workers: new Map(),
			prepareUpdateRestartFenced: prepareFenced,
		}) as {
			updateRestartPhase?: "draining" | "fencing" | "prepared";
			prepareUpdateRestart(): Promise<unknown>;
		};

		const prepare = supervisor.prepareUpdateRestart();
		await firstDrain.promise;
		await Promise.resolve();

		expect(supervisor.updateRestartPhase).toBe("fencing");
		expect(prepareFenced).not.toHaveBeenCalled();

		mutationDrain.end();
		await prepare;
		expect(prepareFenced).toHaveBeenCalledOnce();
		mutationDrain.end();
	});

	it("limits abort admission to mutation drain", async () => {
		const root = mkdtempSync(`/tmp/prime-update-drain-${process.pid}-`);
		const socketPath = join(root, "supervisor.sock");
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir: join(root, "workers"),
		});
		const client = new DaemonClient(socketPath);
		vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();
		try {
			await supervisor.start();
			await client.connect();
			const prepare = client.request({ type: "prepare_update_restart" });
			expect(await client.request({ type: "abort", activeSessionId: "missing" })).not.toMatchObject({
				error: "Daemon is preparing an update restart",
			});
			await prepare;
			await expect(client.request({ type: "abort", activeSessionId: "missing" })).resolves.toMatchObject({
				error: "Daemon is preparing an update restart",
			});
		} finally {
			client.close();
			await Reflect.apply(Reflect.get(supervisor, "cleanupSupervisorResources"), supervisor, []);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects update prepare when a resident worker is recovering or disconnected", async () => {
		const requestWorker = vi.fn();
		const worker = {
			descriptor: { workerId: "resident-1", lifecycle: "recovering" },
			client: undefined,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([["resident-1", worker]]),
		}) as {
			prepareUpdateRestartFenced(): Promise<unknown>;
		};

		await expect(supervisor.prepareUpdateRestartFenced()).rejects.toThrow(/resident-1.*recovering.*disconnected/);
		expect(requestWorker).not.toHaveBeenCalled();
	});
});
