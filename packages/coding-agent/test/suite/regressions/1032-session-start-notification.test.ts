import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import {
	bindActiveSessionState,
	MAX_PENDING_EXTENSION_UI_NOTIFICATIONS,
} from "../../../src/modes/daemon/daemon-extension-binding.js";
import { AgentDaemon, detachClientFromActiveSession } from "../../../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
} from "../../../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import {
	type DaemonWorkerCommand,
	type DaemonWorkerFrameHeader,
	isDaemonWorkerFrameHeader,
} from "../../../src/modes/daemon/daemon-worker-protocol.js";
import { PrivateFrameDecoder } from "../../../src/modes/session-worker/private-framing.js";
import { createHarness, type Harness } from "../harness.js";

interface DaemonInternals {
	sessions: Map<string, ActiveSessionState>;
	broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
	createAttachResult(
		client: DaemonSocketClient,
		state: ActiveSessionState,
		command: Extract<DaemonCommand, { type: "attach" }>,
	): Promise<DaemonAttachResult>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleWorkerCommand(client: DaemonSocketClient, command: DaemonWorkerCommand): Promise<void>;
	closeSession(state: ActiveSessionState, reason: "killed"): Promise<void>;
	schedulePendingExtensionUiNotifications(state: ActiveSessionState, client: DaemonSocketClient): void;
}

interface SupervisorInternals {
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleWorkerFrame(worker: unknown, frame: { header: DaemonWorkerFrameHeader; payload: Buffer }): void;
}

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("Issue #1032 daemon session_start notifications", () => {
	it("delivers startup notifications once to the first extension-UI client", async () => {
		let notifyAfterAttach: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						ctx.ui.notify("startup one");
						expect(await ctx.ui.confirm("Confirm", "Continue?")).toBe(false);
						expect(await ctx.ui.select("Select", ["one", "two"])).toBeUndefined();
						expect(await ctx.ui.input("Input", "value")).toBeUndefined();
						ctx.ui.notify("startup two", "warning");
						notifyAfterAttach = () => ctx.ui.notify("attached notification");
					});
				},
			],
		});
		harnesses.push(harness);

		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);

		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		const incapable = createClient("incapable");
		await attach(internals, incapable.client, state.activeSessionId, false);
		await waitForImmediate();
		expect(extensionUiRequests(incapable.outbound)).toEqual([]);

		const first = createClient("first");
		const second = createClient("second");
		await attach(internals, first.client, state.activeSessionId, true);
		await attach(internals, second.client, state.activeSessionId, true);
		await waitForImmediate();

		expect(extensionUiRequests(first.outbound)).toEqual([
			expect.objectContaining({ method: "notify", payload: { message: "startup one" } }),
			expect.objectContaining({
				method: "notify",
				payload: { message: "startup two", notifyType: "warning" },
			}),
		]);

		expect(extensionUiRequests(second.outbound)).toEqual([]);

		notifyAfterAttach?.();
		expect(extensionUiRequests(first.outbound).at(-1)).toMatchObject({
			method: "notify",
			payload: { message: "attached notification" },
		});
		expect(extensionUiRequests(second.outbound).at(-1)).toMatchObject({
			method: "notify",
			payload: { message: "attached notification" },
		});
		expect(extensionUiRequests(incapable.outbound)).toEqual([]);
	});

	it("retains startup notifications across an incapable client's detach", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => ctx.ui.notify("survives detach"));
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		const incapable = createClient("incapable-detach");
		await attach(internals, incapable.client, state.activeSessionId, false);
		detachClientFromActiveSession(incapable.client, state);

		const first = createClient("first-capable");
		await attach(internals, first.client, state.activeSessionId, true);
		await waitForImmediate();
		expect(extensionUiRequests(first.outbound)).toEqual([
			expect.objectContaining({ method: "notify", payload: { message: "survives detach" } }),
		]);

		const second = createClient("second-capable");
		await attach(internals, second.client, state.activeSessionId, true);
		await waitForImmediate();
		expect(extensionUiRequests(second.outbound)).toEqual([]);
	});

	it("reselects a recipient if the first capable client disconnects before replay", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => ctx.ui.notify("recipient fallback"));
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		const disconnected = createClient("disconnected-recipient");
		await attach(internals, disconnected.client, state.activeSessionId, true);
		detachClientFromActiveSession(disconnected.client, state);
		(disconnected.client.socket as unknown as { destroyed: boolean }).destroyed = true;

		const fallback = createClient("fallback-recipient");
		await attach(internals, fallback.client, state.activeSessionId, true);
		await waitForImmediate();

		expect(extensionUiRequests(disconnected.outbound)).toEqual([]);
		expect(extensionUiRequests(fallback.outbound)).toEqual([
			expect.objectContaining({ method: "notify", payload: { message: "recipient fallback" } }),
		]);
	});

	it("keeps undelivered notifications while the selected client is backpressured", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						ctx.ui.notify("backpressure one");
						ctx.ui.notify("backpressure two");
					});
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		const client = createClient("backpressured-recipient");
		client.client.backpressured = true;
		await attach(internals, client.client, state.activeSessionId, true);
		await waitForImmediate();
		expect(extensionUiRequests(client.outbound)).toEqual([]);
		expect(state.pendingExtensionUiNotifications).toHaveLength(2);

		client.client.backpressured = false;
		internals.schedulePendingExtensionUiNotifications(state, client.client);
		await waitForImmediate();
		expect(extensionUiRequests(client.outbound).map((message) => message.payload.message)).toEqual([
			"backpressure one",
			"backpressure two",
		]);
		expect(state.pendingExtensionUiNotifications).toEqual([]);
	});

	it("does not replay notifications emitted after the initial bind", async () => {
		let notifyLater: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						ctx.ui.notify("initial startup");
						notifyLater = () => ctx.ui.notify("later background failure");
					});
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		notifyLater?.();
		const client = createClient("after-background-notify");
		await attach(internals, client.client, state.activeSessionId, true);
		await waitForImmediate();

		expect(extensionUiRequests(client.outbound).map((message) => message.payload.message)).toEqual([
			"initial startup",
		]);
	});

	it("drops pending notifications when the session closes", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => ctx.ui.notify("do not leak"));
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		await internals.closeSession(state, "killed");

		expect(state.pendingExtensionUiNotifications).toEqual([]);
		expect(internals.sessions.has(state.activeSessionId)).toBe(false);
	});

	it("does not leak notifications across a session rebind", async () => {
		let startCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						startCount++;
						ctx.ui.notify(`startup ${startCount}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);
		const callbacks = {
			broadcast: (targetState: ActiveSessionState, message: DaemonOutbound) =>
				internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		};

		await bindActiveSessionState(state, callbacks);
		await bindActiveSessionState(state, callbacks);
		const client = createClient("after-rebind");
		await attach(internals, client.client, state.activeSessionId, true);
		await waitForImmediate();

		expect(extensionUiRequests(client.outbound)).toEqual([]);
	});

	it("bounds pending startup notifications and preserves retained order", async () => {
		const notificationCount = MAX_PENDING_EXTENSION_UI_NOTIFICATIONS + 3;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						for (let index = 0; index < notificationCount; index++) {
							ctx.ui.notify(`startup ${index}`);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		const client = createClient("bounded");
		await attach(internals, client.client, state.activeSessionId, true);
		await waitForImmediate();
		const messages = extensionUiRequests(client.outbound).map((message) => message.payload.message);

		expect(messages).toHaveLength(MAX_PENDING_EXTENSION_UI_NOTIFICATIONS);
		expect(messages[0]).toBe("startup 3");
		expect(messages.at(-1)).toBe(`startup ${notificationCount - 1}`);
	});

	it("replays through worker subscription when the supervisor enables extension UI", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => ctx.ui.notify("worker startup"));
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});
		const workerClient = createClient("supervisor-worker");

		await internals.handleWorkerCommand(workerClient.client, {
			type: "worker_subscribe",
			activeSessionId: state.activeSessionId,
			capabilities: ["extension_ui"],
			supportsExtensionUi: true,
		});
		await waitForImmediate();

		expect(extensionUiRequests(workerClient.outbound)).toEqual([
			expect.objectContaining({ method: "notify", payload: { message: "worker startup" } }),
		]);
	});

	it("routes worker startup replay once after the public chunked snapshot", async () => {
		let notifyAfterBind: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						ctx.ui.notify("worker startup one");
						ctx.ui.notify("worker startup two");
						notifyAfterBind = () => ctx.ui.notify("worker live");
					});
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const workerInternals = daemon as unknown as DaemonInternals;
		workerInternals.sessions.set(state.activeSessionId, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => workerInternals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		let finishSnapshot: () => void = () => {};
		const snapshot = new Promise<void>((resolve) => {
			finishSnapshot = resolve;
		});
		const attachResult = {
			activeSessionId: "active-1032",
			snapshot: { messages: [] },
		} as unknown as DaemonAttachResult;
		const first = createClient("public-first");
		const second = createClient("public-second");
		second.client.supportsExtensionUi = true;
		second.client.capabilities.add("extension_ui");
		second.client.attachedActiveSessionIds.add(state.activeSessionId);
		const clients = new Set<DaemonSocketClient>([second.client]);
		let supervisor!: SupervisorInternals;
		let workerResponse: DaemonResponse | undefined;
		const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
		const workerClient = createClient("supervisor-worker").client;
		workerClient.transport = "private-framed";
		workerClient.socket = {
			destroyed: false,
			write(data: string | Uint8Array) {
				for (const frame of decoder.push(typeof data === "string" ? Buffer.from(data) : data)) {
					if (frame.header.kind === "outbound" && frame.header.outboundType === "response") {
						workerResponse = JSON.parse(frame.payload.toString("utf8")) as DaemonResponse;
					} else {
						supervisor.handleWorkerFrame(worker, frame);
					}
				}
				return true;
			},
		} as unknown as Socket;
		const worker = {
			client: {
				requestWorker: vi.fn(
					async (command: Omit<Extract<DaemonWorkerCommand, { type: "worker_subscribe" }>, "id">) => {
						workerResponse = undefined;
						await workerInternals.handleWorkerCommand(workerClient, { ...command, id: "worker-request" });
						if (!workerResponse) throw new Error("Worker did not return a response");
						return workerResponse;
					},
				),
			},
			snapshotCache: new Map(),
		};
		supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			clients,
			workers: new Map(),
			startupNotificationRecipients: new Map(),
			startupNotificationRoutingSessions: new Set(),
			pendingStartupNotificationFrames: new Map(),
			workerExtensionUiSyncs: new Map(),
			matchWorkers: vi.fn(() => [{ worker, summary: { id: state.activeSessionId } }]),
			attachClient: vi.fn(
				async (client: DaemonSocketClient, command: Extract<DaemonCommand, { type: "attach" }>) => {
					client.capabilities = new Set(command.capabilities ?? []);
					client.supportsExtensionUi = client.capabilities.has("extension_ui");
					client.attachedActiveSessionIds.add(state.activeSessionId);
					clients.add(client);
					return { result: attachResult, worker, transcript: {} };
				},
			),
			createStreamedAttachResult: vi.fn(() => attachResult),
			streamSnapshot: vi.fn(() => snapshot),
			write: (client: DaemonSocketClient, message: DaemonOutbound) =>
				client.socket.write(`${JSON.stringify(message)}\n`),
			writeSerialized: (client: DaemonSocketClient, data: string | Uint8Array) => client.socket.write(data),
			log: vi.fn(),
		}) as unknown as SupervisorInternals;

		await supervisor.handleCommand(first.client, {
			type: "attach",
			activeSessionId: "active-1032",
			capabilities: ["extension_ui", "chunked_snapshot"],
			supportsExtensionUi: true,
		});
		expect(extensionUiRequests(first.outbound)).toEqual([]);
		expect(extensionUiRequests(second.outbound)).toEqual([]);
		expect(state.pendingExtensionUiNotifications).toHaveLength(2);

		finishSnapshot();
		await snapshot;
		await vi.waitFor(() => expect(extensionUiRequests(first.outbound)).toHaveLength(2));
		expect(extensionUiRequests(first.outbound).map((message) => message.payload.message)).toEqual([
			"worker startup one",
			"worker startup two",
		]);
		expect(extensionUiRequests(second.outbound)).toEqual([]);

		notifyAfterBind?.();
		expect(extensionUiRequests(first.outbound).at(-1)?.payload.message).toBe("worker live");
		expect(extensionUiRequests(second.outbound).at(-1)?.payload.message).toBe("worker live");
	});
});

function createState(harness: Harness): ActiveSessionState {
	const runtime = {
		session: harness.session,
		cwd: harness.tempDir,
		metadata: { kind: "top-level", createdAt: Date.now() },
		diagnostics: [],
		setRuntimeEnvScope: vi.fn(),
		setSubagentRuntimeHost: vi.fn(),
		setRebindSession: vi.fn(),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntime;
	return {
		activeSessionId: "active-1032",
		runtime,
		clients: new Set(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "generation-1032",
		lastEventSequence: 0,
	};
}

function createDaemon(harness: Harness): AgentDaemon {
	return new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
		defaultSessionConfig: { agentDir: harness.tempDir, cwd: harness.tempDir },
		createRuntime: async () => {
			throw new Error("Unexpected runtime creation");
		},
	});
}

function stubAttachResult(internals: DaemonInternals, state: ActiveSessionState): void {
	internals.createAttachResult = vi.fn(async (client) => {
		return {
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId: state.activeSessionId,
			snapshot: {},
			replay: { status: "complete", toSequence: state.lastEventSequence },
			lastEventSequence: state.lastEventSequence,
			client: { id: client.id, capabilities: [...client.capabilities] },
		} as unknown as DaemonAttachResult;
	});
}

function createClient(id: string): { client: DaemonSocketClient; outbound: DaemonOutbound[] } {
	const outbound: DaemonOutbound[] = [];
	const socket = {
		destroyed: false,
		write(data: string | Uint8Array) {
			outbound.push(JSON.parse(String(data)) as DaemonOutbound);
			return true;
		},
	} as unknown as Socket;
	return {
		client: {
			id,
			socket,
			attachedActiveSessionIds: new Set(),
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(),
			transport: "jsonl",
		},
		outbound,
	};
}

async function attach(
	internals: DaemonInternals,
	client: DaemonSocketClient,
	activeSessionId: string,
	supportsExtensionUi: boolean,
): Promise<void> {
	await internals.handleCommand(client, {
		type: "attach",
		activeSessionId,
		supportsExtensionUi,
		capabilities: supportsExtensionUi ? ["extension_ui"] : [],
	});
}

function extensionUiRequests(
	outbound: DaemonOutbound[],
): Array<Extract<DaemonOutbound, { type: "extension_ui_request" }>> {
	return outbound.filter(
		(message): message is Extract<DaemonOutbound, { type: "extension_ui_request" }> =>
			message.type === "extension_ui_request",
	);
}

function waitForImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
