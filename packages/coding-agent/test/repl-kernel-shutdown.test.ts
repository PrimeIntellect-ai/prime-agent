import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type HostRequestHandlers, ReplKernelManager } from "../src/core/kernel/index.js";

type ShutdownInternals = {
	state: "running";
	writeLine: (request: Record<string, unknown>) => Promise<void>;
	handleEvent: (event: Record<string, unknown>) => void;
	wireChild: (child: ShutdownInternals["child"]) => void;
	pendingDoneWaiters: Map<string, () => void>;
	inFlightHostRequests: Set<Promise<void>>;
	kernelStderr: string;
	child: EventEmitter & {
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
		kill: (signal?: NodeJS.Signals | number) => boolean;
		pid?: number;
		stdin: { destroyed: boolean; destroy: () => void };
		stdout?: { destroy: () => void; on: (event: string, listener: (...args: unknown[]) => void) => void };
		stderr?: { destroy: () => void; on: (event: string, listener: (...args: unknown[]) => void) => void };
	};
};

function configuredManager(
	onSend: (request: Record<string, unknown>, internals: ShutdownInternals) => void | Promise<void>,
	hostHandlers?: HostRequestHandlers,
	withSnapshot = false,
): {
	manager: ReplKernelManager;
	internals: ShutdownInternals;
} {
	const manager = new ReplKernelManager({
		cwd: process.cwd(),
		hostHandlers,
		snapshot: withSnapshot ? { path: "/tmp/shutdown-test.dill", manifestPath: "/tmp/shutdown-test.json" } : undefined,
	});
	const internals = manager as unknown as ShutdownInternals;
	const child = Object.assign(new EventEmitter(), {
		exitCode: null,
		signalCode: null,
		kill: vi.fn(() => true),
		pid: undefined,
		stdin: { destroyed: false, destroy: vi.fn() },
		stdout: { destroy: vi.fn(), on: vi.fn() },
		stderr: { destroy: vi.fn(), on: vi.fn() },
	});
	Object.assign(internals, {
		state: "running",
		writeLine: vi.fn(async (request: Record<string, unknown>) => onSend(request, internals)),
		child,
	});
	// Attach the real exit/error handlers so teardown-ownership races are exercised.
	internals.wireChild(child);
	return { manager, internals };
}

describe("ReplKernelManager graceful shutdown", () => {
	it.each([
		["optional policy", {}],
		["snapshot-and-drain policy", { snapshot: true, drainHostRequests: true }],
	] as const)("uses the same diagnostic deadline for the %s", async (_label, options) => {
		vi.useFakeTimers();
		try {
			const { manager, internals } = configuredManager(() => new Promise<void>(() => {}), undefined, true);
			// The final flush snapshots through the private captureSnapshot (bounded, prune-free).
			vi.spyOn(manager as unknown as { captureSnapshot: () => Promise<null> }, "captureSnapshot").mockResolvedValue(
				null,
			);
			const shutdown = manager.shutdown(options);
			await vi.advanceTimersByTimeAsync(5_000);
			await expect(shutdown).resolves.toBe(true);
			expect(internals.kernelStderr).toContain("Kernel did not shut down within 5000ms");
			expect(internals.child).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not finish shutdown before the stdin write settles", async () => {
		let finishSend: (() => void) | undefined;
		const sendBlocked = new Promise<void>((resolve) => {
			finishSend = resolve;
		});
		const { manager, internals } = configuredManager(async (request, state) => {
			state.handleEvent({ event: "done", id: request.id, status: "ok" });
			await sendBlocked;
			state.child.exitCode = 0;
			state.child.emit("exit", 0, null);
		});

		let finished = false;
		const shutdown = manager.shutdown().then(() => {
			finished = true;
		});
		await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
		expect(finished).toBe(false);
		finishSend?.();
		await shutdown;
		expect(internals.pendingDoneWaiters.size).toBe(0);
	});

	it("finishes promptly when the runtime exits without a shutdown done", async () => {
		const { manager, internals } = configuredManager((_request, state) => {
			state.child.exitCode = 0;
			state.child.emit("exit", 0, null);
		});
		vi.useFakeTimers();
		try {
			const shutdown = manager.shutdown();
			await vi.advanceTimersByTimeAsync(100);
			// True = this call performed the cleanup: startup-failure recovery relies on it to resurrect to idle.
			await expect(shutdown).resolves.toBe(true);
			expect(internals.child).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes a snapshot and drains host requests when session teardown selects both policies", async () => {
		let releaseHandler: (() => void) | undefined;
		const handlerBlocked = new Promise<void>((resolve) => {
			releaseHandler = resolve;
		});
		const sentReplies: Record<string, unknown>[] = [];
		const { manager, internals } = configuredManager(
			async (request, state) => {
				if (request.type === "host_reply") sentReplies.push(request);
				if (request.type === "shutdown") {
					state.handleEvent({ event: "done", id: request.id, status: "ok" });
					state.child.exitCode = 0;
					state.child.emit("exit", 0, null);
				}
			},
			{
				"test.slow": async () => {
					await handlerBlocked;
					return { answer: 42, status: "weird" };
				},
			},
			true,
		);
		const snapshot = vi
			.spyOn(manager as unknown as { captureSnapshot: () => Promise<null> }, "captureSnapshot")
			.mockResolvedValue(null);

		internals.handleEvent({ event: "host_request", id: "hr-1", data: { type: "test.slow" } });
		const shutdown = manager.shutdown({ snapshot: true, drainHostRequests: true });
		await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

		expect(snapshot).toHaveBeenCalledOnce();
		expect(internals.writeLine).not.toHaveBeenCalled();
		releaseHandler?.();
		await shutdown;

		expect(internals.inFlightHostRequests.size).toBe(0);
		expect(sentReplies).toEqual([
			{
				type: "host_reply",
				id: "hr-1",
				data: { status: "ok", result: { answer: 42, status: "weird" } },
			},
		]);
		expect(internals.child).toBeUndefined();
	});

	it("shutdown during an in-flight host request leaves no dangling task once the handler settles", async () => {
		let releaseHandler: (() => void) | undefined;
		const handlerBlocked = new Promise<void>((resolve) => {
			releaseHandler = resolve;
		});
		const { manager, internals } = configuredManager(
			(request, state) => {
				if (request.type !== "shutdown") return;
				state.handleEvent({ event: "done", id: request.id, status: "ok" });
				state.child.exitCode = 0;
				state.child.emit("exit", 0, null);
			},
			{
				"test.slow": async () => {
					await handlerBlocked;
					return { answer: 42 };
				},
			},
			true,
		);
		const snapshot = vi
			.spyOn(manager as unknown as { captureSnapshot: () => Promise<null> }, "captureSnapshot")
			.mockResolvedValue(null);

		internals.handleEvent({ event: "host_request", id: "hr-1", data: { type: "test.slow" } });
		const tracked = [...internals.inFlightHostRequests];
		expect(tracked).toHaveLength(1);

		await manager.shutdown();
		expect(snapshot).not.toHaveBeenCalled();
		expect(internals.child).toBeUndefined();

		// The reply write fails against the torn-down child; the task must still settle.
		releaseHandler?.();
		await Promise.all(tracked);
		expect(internals.inFlightHostRequests.size).toBe(0);
	});

	it("shares one wire exchange across concurrent graceful shutdown calls", async () => {
		let exitKernel: (() => void) | undefined;
		const { manager, internals } = configuredManager((request, state) => {
			state.handleEvent({ event: "done", id: request.id, status: "ok" });
			exitKernel = () => {
				state.child.exitCode = 0;
				state.child.emit("exit", 0, null);
			};
		});

		const owner = manager.shutdown();
		await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
		const concurrent = manager.shutdown();
		exitKernel?.();

		await expect(owner).resolves.toBe(true);
		await expect(concurrent).resolves.toBe(false);
		expect(internals.writeLine).toHaveBeenCalledOnce();
	});

	it("stands down when a hard teardown supersedes the snapshot flush", async () => {
		let releaseSnapshot: (() => void) | undefined;
		const snapshotBlocked = new Promise<null>((resolve) => {
			releaseSnapshot = () => resolve(null);
		});
		const { manager, internals } = configuredManager(() => undefined, undefined, true);
		vi.spyOn(manager as unknown as { captureSnapshot: () => Promise<null> }, "captureSnapshot").mockReturnValue(
			snapshotBlocked,
		);
		const child = internals.child;

		const shutdown = manager.shutdown({ snapshot: true });
		await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
		await manager.kill();
		releaseSnapshot?.();

		await expect(shutdown).resolves.toBe(false);
		expect(child.kill).toHaveBeenCalledOnce();
	});

	it("restart after a graceful shutdown starts the kernel again", async () => {
		const { manager, internals } = configuredManager((request, state) => {
			if (request.type !== "shutdown") return;
			state.handleEvent({ event: "done", id: request.id, status: "ok" });
			// The runtime exits after acking shutdown; the exit handler must not
			// steal teardown ownership from the in-flight graceful shutdown().
			state.child.exitCode = 0;
			state.child.emit("exit", 0, null);
		});
		const start = vi.spyOn(manager, "start").mockResolvedValue(undefined);

		await manager.restart();

		expect(internals.child).toBeUndefined();
		expect(start).toHaveBeenCalledTimes(1);
	});

	it("restart does not resurrect a kernel a concurrent kill superseded", async () => {
		const { manager } = configuredManager((_request, state) => {
			// A concurrent kill supersedes the in-flight graceful shutdown.
			void manager.kill();
			state.child.emit("exit", null, "SIGKILL");
		});
		const start = vi.spyOn(manager, "start").mockResolvedValue(undefined);

		await manager.restart();

		expect(start).not.toHaveBeenCalled();
	});

	it("waits for the matching shutdown done and removes its waiter", async () => {
		const { manager, internals } = configuredManager(async (request, state) => {
			expect(request.type).toBe("shutdown");
			expect(request.id).toBeTypeOf("string");
			// An unrelated done must not release the shutdown waiter.
			state.handleEvent({ event: "done", id: "unrelated", status: "ok" });
			expect(state.pendingDoneWaiters.size).toBe(1);
			state.handleEvent({ event: "done", id: request.id, status: "ok" });
			queueMicrotask(() => {
				state.child.exitCode = 0;
				state.child.emit("exit", 0, null);
			});
		});

		await manager.shutdown();

		expect(internals.pendingDoneWaiters.size).toBe(0);
		expect(internals.child).toBeUndefined();
	});

	it("keeps the kernel MCP close budget strictly inside the host shutdown deadline", () => {
		const source = readFileSync(resolve(__dirname, "../../../prime-agent-runtime/src/rlm/mcp.py"), "utf8");
		const match = source.match(/^_SHUTDOWN_TIMEOUT = ([\d.]+)$/m);
		expect(match).not.toBeNull();
		// +1s dispatch slack in mcp.py close(); the sum must undercut the host's 5s kill deadline.
		expect((Number(match![1]) + 1) * 1000).toBeLessThan(5000);
	});
});
