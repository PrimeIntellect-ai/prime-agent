import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonCommand, DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

type ClientFixture = {
	id: string;
	socket: { destroy: ReturnType<typeof vi.fn> };
	attachedActiveSessionIds: Set<string>;
	capabilities: Set<string>;
};

type WorkerFixture = {
	descriptor: { workerId: string };
	client?: { close: ReturnType<typeof vi.fn> };
};

type PauseEntry = { owner: ClientFixture; worker: WorkerFixture; pauseId: string };

type SupervisorInternals = {
	clients: Set<ClientFixture>;
	workers: Map<string, WorkerFixture>;
	connectionIds: WeakMap<ClientFixture, string>;
	protocolClientIds: WeakMap<ClientFixture, string>;
	sessionInputPauseEpochs: WeakMap<ClientFixture, number>;
	detachingInputPauseSessions: WeakMap<ClientFixture, Set<string>>;
	sessionInputPauses: Map<string, PauseEntry>;
	findWorkerForClient: ReturnType<typeof vi.fn>;
	forwardToWorker: ReturnType<typeof vi.fn>;
	attachClient: ReturnType<typeof vi.fn>;
	reserveSnapshotStream: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	detachClient: ReturnType<typeof vi.fn>;
	handleCommand(client: ClientFixture, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	invalidateWorkerSessionInputPauses(worker: WorkerFixture, reason: string): void;
	handleWorkerClose(worker: WorkerFixture, client: { close: ReturnType<typeof vi.fn> }, error: Error): Promise<void>;
};

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createHarness() {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-input-pause-"));
	tempDirs.push(directory);
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	const worker: WorkerFixture = { descriptor: { workerId: "worker-1" }, client: { close: vi.fn() } };
	supervisor.workers.set(worker.descriptor.workerId, worker);
	supervisor.findWorkerForClient = vi.fn(async () => ({
		worker,
		summary: { id: "active-1", activeSessionId: "active-1" },
	}));
	let pauseSequence = 0;
	supervisor.forwardToWorker = vi.fn(async (_worker: WorkerFixture, command: DaemonCommand) => {
		if (command.type === "acquire_session_input_pause") {
			pauseSequence++;
			return {
				type: "response",
				command: command.type,
				success: true,
				data: { pauseId: `pause-${pauseSequence}` },
			} satisfies DaemonResponse;
		}
		return { type: "response", command: command.type, success: true } satisfies DaemonResponse;
	});
	supervisor.attachClient = vi.fn(async () => ({ worker, result: { activeSessionId: "active-1" } }));
	supervisor.reserveSnapshotStream = vi.fn(() => vi.fn());
	supervisor.write = vi.fn();
	supervisor.detachClient = vi.fn((client: ClientFixture, activeSessionId?: string) => {
		if (activeSessionId) client.attachedActiveSessionIds.delete(activeSessionId);
		else client.attachedActiveSessionIds.clear();
	});
	supervisor.handleWorkerClose = vi.fn(async (closedWorker: WorkerFixture, workerClient, error: Error) => {
		if (closedWorker.client !== workerClient) return;
		closedWorker.client = undefined;
		supervisor.invalidateWorkerSessionInputPauses(closedWorker, error.message);
	});
	return { supervisor, worker };
}

function addClient(supervisor: SupervisorInternals, socketId: string, protocolId: string): ClientFixture {
	const client = {
		id: protocolId,
		socket: { destroy: vi.fn() },
		attachedActiveSessionIds: new Set(["active-1"]),
		capabilities: new Set<string>(),
	};
	supervisor.clients.add(client);
	supervisor.connectionIds.set(client, socketId);
	supervisor.protocolClientIds.set(client, protocolId);
	supervisor.sessionInputPauseEpochs.set(client, 0);
	supervisor.detachingInputPauseSessions.set(client, new Set());
	return client;
}

function acquireCommand(id: string): DaemonCommand {
	return { id, type: "acquire_session_input_pause", activeSessionId: "active-1", leaseKey: "shared-key" };
}

describe("daemon supervisor session input pause ownership", () => {
	it("keeps identical public lease keys independent across client sockets", async () => {
		const { supervisor } = createHarness();
		const first = addClient(supervisor, "socket-a", "protocol-a");
		const second = addClient(supervisor, "socket-b", "protocol-b");

		const firstResponse = await supervisor.handleCommand(first, acquireCommand("acquire-a"));
		const secondResponse = await supervisor.handleCommand(second, acquireCommand("acquire-b"));
		expect(firstResponse).toMatchObject({ success: true, data: { pauseId: "pause-1" } });
		expect(secondResponse).toMatchObject({ success: true, data: { pauseId: "pause-2" } });
		expect(
			supervisor.forwardToWorker.mock.calls
				.map((call) => call[1] as DaemonCommand)
				.filter((command) => command.type === "acquire_session_input_pause")
				.map((command) => command.leaseKey),
		).toEqual([
			JSON.stringify(["socket-a", "protocol-a", "shared-key"]),
			JSON.stringify(["socket-b", "protocol-b", "shared-key"]),
		]);

		await supervisor.handleCommand(first, {
			id: "release-a",
			type: "release_session_input_pause",
			activeSessionId: "active-1",
			pauseId: "pause-1",
		});
		expect(supervisor.sessionInputPauses.has("pause-1")).toBe(false);
		expect(supervisor.sessionInputPauses.has("pause-2")).toBe(true);
	});

	it("clears stable and live detach selectors after reattach", async () => {
		const { supervisor } = createHarness();
		const client = addClient(supervisor, "socket-a", "protocol-a");
		const detachingSessions = supervisor.detachingInputPauseSessions.get(client)!;
		detachingSessions.add("stable-id");

		await supervisor.handleCommand(client, {
			id: "reattach",
			type: "reattach",
			activeSessionId: "old-active",
			targetActiveSessionId: "stable-id",
		});

		expect(detachingSessions.has("stable-id")).toBe(false);
		await expect(
			supervisor.handleCommand(client, {
				id: "acquire",
				type: "acquire_session_input_pause",
				activeSessionId: "stable-id",
				leaseKey: "shared-key",
			}),
		).resolves.toMatchObject({ success: true, data: { pauseId: "pause-1" } });
	});

	it("reacquires a fresh worker pause while the prior pause is releasing", async () => {
		const { supervisor } = createHarness();
		const client = addClient(supervisor, "socket-a", "protocol-a");
		await supervisor.handleCommand(client, acquireCommand("acquire-1"));
		let finishRelease!: () => void;
		const releaseGate = new Promise<void>((resolve) => {
			finishRelease = resolve;
		});
		supervisor.forwardToWorker.mockImplementationOnce(async (_worker: WorkerFixture, command: DaemonCommand) => {
			await releaseGate;
			return { type: "response", command: command.type, success: true } satisfies DaemonResponse;
		});

		const release = supervisor.handleCommand(client, {
			id: "release-1",
			type: "release_session_input_pause",
			activeSessionId: "active-1",
			pauseId: "pause-1",
		});
		const reacquired = await supervisor.handleCommand(client, acquireCommand("acquire-2"));
		expect(reacquired).toMatchObject({ success: true, data: { pauseId: "pause-2" } });

		finishRelease();
		await release;
		expect(supervisor.sessionInputPauses.has("pause-1")).toBe(false);
		expect(supervisor.sessionInputPauses.has("pause-2")).toBe(true);
	});

	it("deduplicates retries and releases the client lease on detach", async () => {
		const { supervisor } = createHarness();
		const client = addClient(supervisor, "socket-a", "protocol-a");

		const first = await supervisor.handleCommand(client, acquireCommand("acquire-1"));
		const retry = await supervisor.handleCommand(client, acquireCommand("acquire-2"));
		expect(first).toMatchObject({ success: true, data: { pauseId: "pause-1" } });
		expect(retry).toMatchObject({ success: true, data: { pauseId: "pause-1" } });
		expect(
			supervisor.forwardToWorker.mock.calls.filter(
				(call) => (call[1] as DaemonCommand).type === "acquire_session_input_pause",
			),
		).toHaveLength(1);

		await supervisor.handleCommand(client, { id: "detach", type: "detach", activeSessionId: "active-1" });
		expect(supervisor.sessionInputPauses.size).toBe(0);
		expect(supervisor.detachClient).toHaveBeenCalledWith(client, "active-1");
		const releaseCalls = supervisor.forwardToWorker.mock.calls.filter(
			(call) => (call[1] as DaemonCommand).type === "release_session_input_pause",
		);
		expect(releaseCalls).toHaveLength(1);
		expect(releaseCalls[0]?.[2]).toBe(5_000);
	});

	it("blocks new acquisitions before detach waits for cleanup", async () => {
		const { supervisor } = createHarness();
		const client = addClient(supervisor, "socket-a", "protocol-a");
		await supervisor.handleCommand(client, acquireCommand("acquire"));
		let releaseCleanup!: () => void;
		const cleanupGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		supervisor.forwardToWorker.mockImplementationOnce(async (_worker: WorkerFixture, command: DaemonCommand) => {
			await cleanupGate;
			return { type: "response", command: command.type, success: true } as DaemonResponse;
		});

		const detach = supervisor.handleCommand(client, {
			id: "detach",
			type: "detach",
			activeSessionId: "active-1",
		});
		await vi.waitFor(() => expect(supervisor.detachClient).toHaveBeenCalledWith(client, "active-1"));
		await expect(supervisor.handleCommand(client, acquireCommand("late-acquire"))).rejects.toThrow(
			"Session is detaching",
		);
		releaseCleanup();
		await expect(detach).resolves.toMatchObject({ success: true });
		expect(supervisor.sessionInputPauses.size).toBe(0);
	});

	it("fails closed for every owner when detach cannot release the worker pause", async () => {
		const { supervisor, worker } = createHarness();
		const client = addClient(supervisor, "socket-a", "protocol-a");
		const other = addClient(supervisor, "socket-b", "protocol-b");
		await supervisor.handleCommand(client, acquireCommand("acquire-a"));
		await supervisor.handleCommand(other, acquireCommand("acquire-b"));
		supervisor.forwardToWorker.mockRejectedValueOnce(new Error("worker unavailable"));

		await expect(
			supervisor.handleCommand(client, { id: "detach", type: "detach", activeSessionId: "active-1" }),
		).rejects.toThrow("worker unavailable");
		expect(supervisor.sessionInputPauses.size).toBe(0);
		expect(supervisor.handleWorkerClose).toHaveBeenCalledTimes(1);
		expect(worker.client).toBeUndefined();
		expect(client.socket.destroy).toHaveBeenCalled();
		expect(other.socket.destroy).toHaveBeenCalled();
	});

	it("releases all client pauses when detach omits a session id", async () => {
		const { supervisor } = createHarness();
		const client = addClient(supervisor, "socket-a", "protocol-a");
		await supervisor.handleCommand(client, acquireCommand("acquire"));

		await supervisor.handleCommand(client, { id: "detach-all", type: "detach" });

		expect(supervisor.sessionInputPauses.size).toBe(0);
		expect(client.attachedActiveSessionIds.size).toBe(0);
		expect(supervisor.detachClient).toHaveBeenCalledWith(client, undefined);
	});

	it("rejects release from a different public client", async () => {
		const { supervisor } = createHarness();
		const owner = addClient(supervisor, "socket-a", "protocol-a");
		const other = addClient(supervisor, "socket-b", "protocol-b");
		await supervisor.handleCommand(owner, acquireCommand("acquire"));

		await expect(
			supervisor.handleCommand(other, {
				id: "release",
				type: "release_session_input_pause",
				activeSessionId: "active-1",
				pauseId: "pause-1",
			}),
		).rejects.toThrow("owned by another client");
	});

	it("invalidates every public owner when the worker connection closes", async () => {
		const { supervisor, worker } = createHarness();
		const first = addClient(supervisor, "socket-a", "protocol-a");
		const second = addClient(supervisor, "socket-b", "protocol-b");
		await supervisor.handleCommand(first, acquireCommand("acquire-a"));
		await supervisor.handleCommand(second, acquireCommand("acquire-b"));

		supervisor.invalidateWorkerSessionInputPauses(worker, "worker pause invalidated");

		expect(supervisor.sessionInputPauses.size).toBe(0);
		expect(first.socket.destroy).toHaveBeenCalledWith(
			expect.objectContaining({ message: "worker pause invalidated" }),
		);
		expect(second.socket.destroy).toHaveBeenCalledWith(
			expect.objectContaining({ message: "worker pause invalidated" }),
		);
	});

	it("releases an acquire that completes after its socket is invalidated", async () => {
		const { supervisor } = createHarness();
		const client = addClient(supervisor, "socket-a", "protocol-a");
		let releaseAcquire!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseAcquire = resolve;
		});
		const forward = supervisor.forwardToWorker;
		forward.mockImplementationOnce(async (_worker: WorkerFixture, command: DaemonCommand) => {
			await gate;
			return {
				type: "response",
				command: command.type,
				success: true,
				data: { pauseId: "pause-late" },
			} as DaemonResponse;
		});

		const acquisition = supervisor.handleCommand(client, acquireCommand("acquire"));
		await vi.waitFor(() => expect(forward).toHaveBeenCalledTimes(1));
		supervisor.sessionInputPauseEpochs.set(client, 1);
		supervisor.clients.delete(client);
		releaseAcquire();

		await expect(acquisition).rejects.toThrow("invalidated before completion");
		expect(forward.mock.calls.map((call) => (call[1] as DaemonCommand).type)).toEqual([
			"acquire_session_input_pause",
			"release_session_input_pause",
		]);
		expect(supervisor.sessionInputPauses.size).toBe(0);
	});
});
