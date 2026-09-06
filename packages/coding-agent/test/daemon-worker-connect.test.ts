import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_PROTOCOL_INFO } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { DaemonWorkerClient, DaemonWorkerProbeTimeoutError } from "../src/modes/daemon/daemon-worker-client.js";

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
	return { worker, connect: () => supervisor.connectWorker(worker, 100) };
}

afterEach(() => vi.restoreAllMocks());

describe("daemon worker connection deadline", () => {
	it.each(["hello", "authentication"])("bounds %s by time remaining after earlier stages", async (stage) => {
		let now = Date.now();
		const started = now;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(DaemonWorkerClient.prototype, "connect").mockImplementation(async () => {
			now += 75;
		});
		const waitForHello = vi
			.spyOn(DaemonWorkerClient.prototype, "waitForHello")
			.mockImplementation(async (timeout = 0) => {
				if (stage === "hello") {
					now += timeout;
					throw new DaemonWorkerProbeTimeoutError("hello timed out");
				}
				now += 5;
				return hello;
			});
		const authenticate = vi
			.spyOn(DaemonWorkerClient.prototype, "authenticateWorker")
			.mockImplementation(async (_token, _owner, timeout = 0) => {
				now += timeout;
				throw new DaemonWorkerProbeTimeoutError("authentication timed out");
			});
		const close = vi.spyOn(DaemonWorkerClient.prototype, "close");
		const probe = createProbe();
		await expect(probe.connect()).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		expect(now - started).toBe(100);
		expect(waitForHello).toHaveBeenCalledWith(25);
		if (stage === "authentication") expect(authenticate.mock.calls[0]?.[2]).toBe(20);
		else expect(authenticate).not.toHaveBeenCalled();
		expect(probe.worker.pendingClient).toBeUndefined();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it.each(["connect", "hello"])("does not start another stage after %s exhausts the budget", async (stage) => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(DaemonWorkerClient.prototype, "connect").mockImplementation(async () => {
			now += stage === "connect" ? 100 : 75;
		});
		const waitForHello = vi.spyOn(DaemonWorkerClient.prototype, "waitForHello").mockImplementation(async () => {
			now += 25;
			return hello;
		});
		const authenticate = vi
			.spyOn(DaemonWorkerClient.prototype, "authenticateWorker")
			.mockRejectedValue(new Error("unexpected authentication"));
		const close = vi.spyOn(DaemonWorkerClient.prototype, "close");
		await expect(createProbe().connect()).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		if (stage === "connect") expect(waitForHello).not.toHaveBeenCalled();
		expect(authenticate).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
	});
});
