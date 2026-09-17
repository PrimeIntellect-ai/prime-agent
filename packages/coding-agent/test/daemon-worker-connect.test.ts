import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_PROTOCOL_INFO } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor, isDaemonSupervisorCommandType } from "../src/modes/daemon/daemon-supervisor.js";
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
	return { worker, connect: (timeout = 100) => supervisor.connectWorker(worker, timeout) };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

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

describe("daemon worker probe retries", () => {
	it("keeps the platform retry cadence and bounds the last delay by the deadline", async () => {
		vi.useFakeTimers();
		const started = Date.now();
		const attempts: number[] = [];
		vi.spyOn(DaemonWorkerClient.prototype, "connect").mockImplementation(async () => {
			attempts.push(Date.now() - started);
			throw new Error("pipe not ready");
		});
		const probe = createProbe();
		const failure = expect(probe.connect(100)).rejects.toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		await vi.advanceTimersByTimeAsync(100);
		await failure;
		expect(attempts).toEqual(process.platform === "win32" ? [0, 25, 75] : [0, 25, 50, 75]);
		expect(Date.now() - started).toBe(100);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("daemon worker request progress", () => {
	it("admits every cloud command at the supervisor boundary", () => {
		for (const type of [
			"cloud_delegate",
			"cloud_delegations_list",
			"cloud_delegation_stop",
			"cloud_delegation_apply",
		]) {
			expect(isDaemonSupervisorCommandType(type)).toBe(true);
		}
	});

	it("forwards worker progress through the supervisor request callback", async () => {
		const progress = {
			id: "worker_1",
			type: "cloud_delegate_progress" as const,
			command: "cloud_delegate" as const,
			activeSessionId: "active",
			delegationId: "sess_cloud-1",
			phase: "running" as const,
			message: "running",
		};
		const request = vi.fn(async (_command, _timeout, options) => {
			options.onProgress(progress);
			return { type: "response" as const, command: "cloud_delegate", success: true as const };
		});
		const worker = { descriptor: { lifecycle: "ready" }, client: { request } };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			canRetryFailedWorker: () => false,
			requireAvailableWorkerClient: () => worker.client,
		}) as unknown as {
			forwardToWorker(
				worker: unknown,
				command: unknown,
				timeoutMs: number,
				onProgress: (value: typeof progress) => void,
			): Promise<unknown>;
		};
		const onProgress = vi.fn();
		await supervisor.forwardToWorker(
			worker,
			{ type: "cloud_delegate", activeSessionId: "active", delegationId: "sess_cloud-1", prompt: "fix" },
			100,
			onProgress,
		);
		expect(onProgress).toHaveBeenCalledWith(progress);
	});

	it("correlates cloud progress with the pending direct request", () => {
		const client = new DaemonWorkerClient("unused");
		const onProgress = vi.fn();
		const timeout = setTimeout(() => {}, 10_000);
		const internals = client as unknown as {
			pending: Map<
				string,
				{
					resolve: () => void;
					reject: () => void;
					timeout: ReturnType<typeof setTimeout>;
					onProgress: typeof onProgress;
				}
			>;
			handleFrame(frame: unknown): void;
		};
		internals.pending.set("worker_1", { resolve: () => {}, reject: () => {}, timeout, onProgress });
		internals.handleFrame({
			header: {
				kind: "outbound",
				outboundType: "cloud_delegate_progress",
				requestId: "worker_1",
				payloadEncoding: "jsonl",
			},
			payload: Buffer.from(
				JSON.stringify({
					id: "worker_1",
					type: "cloud_delegate_progress",
					command: "cloud_delegate",
					activeSessionId: "active",
					delegationId: "sess_cloud-1",
					phase: "running",
					message: "running",
				}),
			),
		});
		clearTimeout(timeout);
		expect(onProgress).toHaveBeenCalledWith(
			expect.objectContaining({ type: "cloud_delegate_progress", delegationId: "sess_cloud-1", phase: "running" }),
		);
	});
});
