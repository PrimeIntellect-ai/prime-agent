import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionLease from "../src/core/session-lease.js";
import { DaemonClient, type DaemonCommandBody } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_INFO } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { DaemonWorkerClient, DaemonWorkerProbeTimeoutError } from "../src/modes/daemon/daemon-worker-client.js";
import { DAEMON_WORKER_ROSTER_CAPABILITY } from "../src/modes/daemon/daemon-worker-protocol.js";
import * as childProcess from "../src/utils/child-process.js";

// Load the Windows timing constants without running Windows processes on the test host.
const hostPlatform = vi.hoisted(() => {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "win32" });
	return descriptor;
});
Object.defineProperty(process, "platform", hostPlatform);

const hello = {
	type: "daemon_hello" as const,
	socketPath: "unused-test-socket",
	protocol: DAEMON_PROTOCOL_INFO,
	clientId: "test-client",
	serverCapabilities: [],
};

function createProbe() {
	const worker = {
		descriptor: { socketPath: hello.socketPath, authenticationToken: "test-token" },
		pendingClient: undefined,
	};
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		assertRecoveryAllowed: async () => {},
		supervisorAuthenticationClaim: () => ({}),
	}) as { connectWorker(candidate: typeof worker, timeout: number): Promise<DaemonWorkerClient> };
	return { worker, connect: (timeout: number) => supervisor.connectWorker(worker, timeout) };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	Object.defineProperty(process, "platform", hostPlatform);
});

describe("Windows worker connection timing", () => {
	it("gives hello and authentication the remaining budget, not fixed short probe caps", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const connect = vi.spyOn(DaemonWorkerClient.prototype, "connect").mockImplementation(async () => {
			now += 1500;
		});
		const waitForHello = vi.spyOn(DaemonWorkerClient.prototype, "waitForHello").mockImplementation(async () => {
			now += 20_000;
			return hello;
		});
		const authenticate = vi.spyOn(DaemonWorkerClient.prototype, "authenticateWorker").mockImplementation(async () => {
			now += 20_000;
			return {
				type: "response" as const,
				command: "worker_auth",
				success: true as const,
				data: { capabilities: [DAEMON_WORKER_ROSTER_CAPABILITY] },
			};
		});
		const probe = createProbe();
		const client = await probe.connect(90_000);
		expect(connect).toHaveBeenCalledWith(2000);
		expect(waitForHello).toHaveBeenCalledWith(88_500);
		expect(authenticate.mock.calls[0]?.[2]).toBe(68_500);
		expect(probe.worker.pendingClient).toBeUndefined();
		client.close();
	});

	it("backs off failed pipe probes up to two seconds without exceeding the outer deadline", async () => {
		vi.useFakeTimers();
		const started = Date.now();
		const attempts: number[] = [];
		vi.spyOn(DaemonWorkerClient.prototype, "connect").mockImplementation(async () => {
			attempts.push(Date.now() - started);
			throw new Error("pipe not ready");
		});
		const failed = expect(createProbe().connect(7200)).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		await vi.advanceTimersByTimeAsync(7200);
		await failed;
		expect(attempts).toEqual([0, 25, 75, 175, 375, 775, 1575, 3175, 5175, 7175]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses the 90-second budget when adopting a resident worker", async () => {
		vi.spyOn(childProcess, "isProcessAlive").mockReturnValue(true);
		vi.spyOn(sessionLease, "getProcessStartId").mockReturnValue("start-id");
		const worker = {
			descriptor: { pid: 123, processStartId: "start-id", rootActiveSessionId: "root", lifecycle: "recovering" },
		};
		const connectWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: async () => {},
			connectWorker,
			subscribeWorker: async () => {},
			refreshWorkerSummaries: async () => {},
			persistWorker: () => {},
			broadcastHeartbeatsChanged: () => {},
		}) as { adoptOrRecoverWorker(candidate: typeof worker): Promise<void> };
		await supervisor.adoptOrRecoverWorker(worker);
		expect(connectWorker).toHaveBeenCalledWith(worker, 90_000);
		expect(worker.descriptor.lifecycle).toBe("ready");
	});

	it("throttles Windows identity checks but rechecks before signalling", async () => {
		vi.useFakeTimers();
		const started = Date.now();
		const checks: number[] = [];
		vi.spyOn(childProcess, "processIdExists").mockImplementation(() => Date.now() - started < 6000);
		vi.spyOn(childProcess, "isProcessAlive").mockReturnValue(true);
		vi.spyOn(sessionLease, "getProcessStartId").mockImplementation(() => {
			checks.push(Date.now() - started);
			return "start-id";
		});
		const signal = vi.spyOn(childProcess, "signalProcessGroupOrProcess").mockImplementation(() => {});
		const worker = {
			descriptor: { workerId: "worker", pid: 123, processStartId: "start-id", stopRequestedAt: "stopped" },
			stopRevision: 1,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			log: () => {},
		}) as { finalizeTimedOutWorkerStop(candidate: typeof worker): Promise<void> };
		const stopped = supervisor.finalizeTimedOutWorkerStop(worker);
		await vi.advanceTimersByTimeAsync(6000);
		await stopped;
		expect(checks).toEqual([0, 3000, 5000]);
		expect(signal).toHaveBeenCalledWith(123, "SIGKILL");
		expect(stopWorker).toHaveBeenCalledOnce();
	});
});

describe("daemon request timeouts", () => {
	it.each([
		{ platform: "win32", command: "create", override: undefined, expected: 120_000 },
		{ platform: "win32", command: "list", override: undefined, expected: 30_000 },
		{ platform: "linux", command: "create", override: undefined, expected: 30_000 },
		{ platform: "darwin", command: "create", override: undefined, expected: 30_000 },
		{ platform: "win32", command: "create", override: 1234, expected: 1234 },
	] as const)(
		"times out $platform $command with override=$override after $expected ms",
		async ({ platform, command, override, expected }) => {
			vi.useFakeTimers();
			Object.defineProperty(process, "platform", { value: platform });
			const socket = { destroyed: false, write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as unknown as Socket;
			// Timeouts only: the Windows endpoint identity policy is covered by daemon-endpoint-identity.test.ts.
			const client = new DaemonClient(hello.socketPath, { requirePeerIdentity: false });
			Object.assign(client, { socket, helloMessage: hello });
			let settled = false;
			const request = client.request({ type: command } as DaemonCommandBody, override);
			const failed = expect(request).rejects.toThrow(`Timed out after ${expected}ms`);
			void request.catch(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(expected - 1);
			expect(settled).toBe(false);
			expect(socket.write).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(1);
			await failed;
			expect(settled).toBe(true);
			client.close();
		},
	);
});
