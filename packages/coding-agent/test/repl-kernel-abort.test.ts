import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	type KernelSentAgentMessage,
	ReplKernelManager,
} from "../src/core/kernel/index.js";

async function waitForCalls(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (mock.mock.calls.length >= count) {
			return;
		}
		await Promise.resolve();
	}
	expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

type ReplInternals = {
	state: string;
	writeLine: (request: Record<string, unknown>) => Promise<void>;
	start: () => Promise<void>;
	handleEvent: (event: Record<string, unknown>) => void;
	activeExecution?: { requestId: string };
	child?: { kill: (signal?: NodeJS.Signals | number) => boolean; pid?: number; stdin?: unknown };
};

function runningManagerWith(writeLine: (request: Record<string, unknown>) => Promise<void>): {
	manager: ReplKernelManager;
	internals: ReplInternals;
	kernelKill: ReturnType<typeof vi.fn>;
} {
	const manager = new ReplKernelManager({ cwd: process.cwd() });
	const kernelKill = vi.fn((_signal?: NodeJS.Signals | number) => true);
	const internals = manager as unknown as ReplInternals;
	Object.assign(internals, {
		state: "running",
		writeLine,
		start: async () => {},
		child: { kill: kernelKill, pid: undefined, stdin: undefined },
	});
	return { manager, internals, kernelKill };
}

describe("ReplKernelManager abort handling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not poison startup after a caller starts with an aborted signal", async () => {
		const manager = new ReplKernelManager({ cwd: process.cwd() });
		let startCount = 0;
		Object.assign(
			manager as unknown as {
				doStart: () => Promise<void>;
			},
			{
				doStart: async () => {
					startCount++;
				},
			},
		);
		const controller = new AbortController();
		controller.abort();

		await expect(manager.start({ signal: controller.signal })).rejects.toThrow("Kernel startup aborted");
		await expect(manager.start()).resolves.toBeUndefined();
		expect(startCount).toBe(1);
	});

	it("does not cancel shared startup when one waiting caller aborts", async () => {
		const manager = new ReplKernelManager({ cwd: process.cwd() });
		let releaseStart: () => void = () => {};
		let startCount = 0;
		Object.assign(
			manager as unknown as {
				doStart: () => Promise<void>;
			},
			{
				doStart: async () => {
					startCount++;
					await new Promise<void>((resolve) => {
						releaseStart = resolve;
					});
				},
			},
		);
		const controller = new AbortController();

		const firstStart = manager.start({ signal: controller.signal });
		const secondStart = manager.start();
		controller.abort();

		await expect(firstStart).rejects.toThrow("Kernel startup aborted");
		releaseStart();
		await expect(secondStart).resolves.toBeUndefined();
		expect(startCount).toBe(1);
	});

	it("settles an aborted execution when the runtime never sends done", async () => {
		vi.useFakeTimers();
		const writeLine = vi.fn(async (_request: Record<string, unknown>) => {});
		const { manager, internals, kernelKill } = runningManagerWith(writeLine);
		const controller = new AbortController();
		const lateSentAgentMessages: KernelSentAgentMessage[] = [];

		const executePromise = manager.execute("while True: pass", {
			signal: controller.signal,
			onLateSentAgentMessage: (message) => lateSentAgentMessages.push(message),
		});
		await waitForCalls(writeLine, 1);
		expect(writeLine).toHaveBeenCalledTimes(1);
		expect(writeLine.mock.calls[0]?.[0]).toMatchObject({ type: "execute" });

		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);

		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });
		// The abort listener interrupted the runtime out-of-band.
		expect(writeLine.mock.calls.some((call) => (call[0] as { type?: string }).type === "interrupt")).toBe(true);
		expect(kernelKill).not.toHaveBeenCalled();

		const activeExecution = internals.activeExecution;
		expect(activeExecution).toBeDefined();
		if (!activeExecution) {
			throw new Error("Expected active execution to remain until the runtime's done");
		}
		// A late display event for the aborted cell still dispatches the sent message.
		internals.handleEvent({
			event: "display",
			id: activeExecution.requestId,
			data: {
				[AGENT_MESSAGE_DISPLAY_MIME]: {
					id: "agentmsg-after-abort",
					message: "still sent",
					deliveryStatus: "delivered",
					target: { activeSessionId: "beta", sessionId: "session-beta" },
				},
			},
		});
		expect(lateSentAgentMessages).toEqual([
			{
				id: "agentmsg-after-abort",
				message: "still sent",
				deliveryStatus: "delivered",
				target: { activeSessionId: "beta", sessionId: "session-beta" },
			},
		]);
		// The next execute waits for the stale cell's done before sending.
		const secondExecutePromise = manager.execute("x = 1");
		await Promise.resolve();
		expect(writeLine.mock.calls.filter((call) => (call[0] as { type?: string }).type === "execute")).toHaveLength(1);

		internals.handleEvent({ event: "done", id: activeExecution.requestId, status: "error" });
		await vi.waitFor(() => {
			expect(writeLine.mock.calls.filter((call) => (call[0] as { type?: string }).type === "execute")).toHaveLength(
				2,
			);
		});

		const secondExecution = internals.activeExecution;
		expect(secondExecution).toBeDefined();
		if (!secondExecution) {
			throw new Error("Expected second execution to start after the stale cell settled");
		}
		internals.handleEvent({ event: "done", id: secondExecution.requestId, status: "ok" });
		await expect(secondExecutePromise).resolves.toMatchObject({ status: "ok" });

		manager.disposeSync();
		expect(kernelKill).toHaveBeenCalledWith("SIGTERM");
	});

	it("settles an aborted execution when the stdin write never resolves", async () => {
		vi.useFakeTimers();
		const interruptWrites: Record<string, unknown>[] = [];
		const writeLine = vi.fn((request: Record<string, unknown>) => {
			if (request.type === "interrupt") {
				interruptWrites.push(request);
				return Promise.resolve();
			}
			return new Promise<void>(() => {});
		});
		const { manager } = runningManagerWith(writeLine);
		const controller = new AbortController();

		const executePromise = manager.execute("while True: pass", { signal: controller.signal });
		await waitForCalls(writeLine, 1);
		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);

		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });
		expect(interruptWrites.length).toBeGreaterThan(0);
	});

	it("fails a later execution fast when the interrupted cell never settles", async () => {
		vi.useFakeTimers();
		const writeLine = vi.fn(async (_request: Record<string, unknown>) => {});
		const { manager } = runningManagerWith(writeLine);
		const controller = new AbortController();

		const executePromise = manager.execute("while True: pass", { signal: controller.signal });
		await waitForCalls(writeLine, 1);
		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);
		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });

		const secondExecutePromise = manager.execute("x = 1");
		const secondExecuteExpectation = expect(secondExecutePromise).rejects.toThrow(
			"The Python kernel is still running the previously interrupted cell",
		);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(5000);

		await secondExecuteExpectation;
		expect(writeLine.mock.calls.filter((call) => (call[0] as { type?: string }).type === "execute")).toHaveLength(1);
		expect(writeLine.mock.calls.some((call) => (call[0] as { type?: string }).type === "interrupt")).toBe(true);
		manager.disposeSync();
	});

	it("cancels a hung final snapshot execution before teardown", async () => {
		vi.useFakeTimers();
		const manager = new ReplKernelManager({
			cwd: process.cwd(),
			snapshot: { path: "/tmp/test-state.dill", manifestPath: "/tmp/test-state.json" },
		});
		let releaseQueue: () => void = () => {};
		const previousExecution = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		const executeInner = vi.fn(
			async (
				_requestFields: Record<string, unknown>,
				_code: string,
				opts: { signal?: AbortSignal },
			): Promise<{ stdout: string; stderr: string; status: "aborted"; durationMs: number }> =>
				await new Promise((resolve) => {
					opts.signal?.addEventListener(
						"abort",
						() => resolve({ stdout: "", stderr: "", status: "aborted", durationMs: 5000 }),
						{ once: true },
					);
				}),
		);
		const cleanupResources = vi.fn();
		Object.assign(
			manager as unknown as {
				state: "running";
				executionQueue: Promise<void>;
				executeInner: typeof executeInner;
				start: () => Promise<void>;
				cleanupResources: () => void;
			},
			{ state: "running", executionQueue: previousExecution, executeInner, start: async () => {}, cleanupResources },
		);

		const disposal = manager.shutdown({ snapshot: true, drainHostRequests: true });
		expect(executeInner).not.toHaveBeenCalled();
		releaseQueue();
		await waitForCalls(executeInner, 1);
		const signal = executeInner.mock.calls[0]?.[2].signal;
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(4999);
		expect(signal?.aborted).toBe(false);
		expect(cleanupResources).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(signal?.aborted).toBe(true);
		await expect(disposal).resolves.toBe(true);
		expect(cleanupResources).toHaveBeenCalledOnce();
	});

	it("tears down when the final snapshot is blocked behind a hung execution", async () => {
		vi.useFakeTimers();
		const manager = new ReplKernelManager({
			cwd: process.cwd(),
			snapshot: { path: "/tmp/test-state.dill", manifestPath: "/tmp/test-state.json" },
		});
		const executeInner = vi.fn();
		const interrupt = vi.fn(async () => {});
		const cleanupResources = vi.fn();
		Object.assign(
			manager as unknown as {
				state: "running";
				executionQueue: Promise<void>;
				activeExecution: object;
				executeInner: typeof executeInner;
				interrupt: typeof interrupt;
				cleanupResources: () => void;
			},
			{
				state: "running",
				executionQueue: new Promise<void>(() => {}),
				activeExecution: {},
				executeInner,
				interrupt,
				cleanupResources,
			},
		);

		const disposal = manager.shutdown({ snapshot: true, drainHostRequests: true });
		expect(interrupt).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(4999);
		expect(cleanupResources).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		await expect(disposal).resolves.toBe(true);
		expect(executeInner).not.toHaveBeenCalled();
		expect(cleanupResources).toHaveBeenCalledOnce();
	});

	it("rejects executions enqueued during the final snapshot flush so dispose stays bounded", async () => {
		vi.useFakeTimers();
		const manager = new ReplKernelManager({
			cwd: process.cwd(),
			snapshot: { path: "/tmp/test-state.dill", manifestPath: "/tmp/test-state.json" },
		});
		let releaseQueue: () => void = () => {};
		const previousExecution = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		const executeInner = vi.fn(
			async (
				_requestFields: Record<string, unknown>,
				_code: string,
				opts: { signal?: AbortSignal },
			): Promise<{ stdout: string; stderr: string; status: "aborted"; durationMs: number }> =>
				await new Promise((resolve) => {
					opts.signal?.addEventListener(
						"abort",
						() => resolve({ stdout: "", stderr: "", status: "aborted", durationMs: 5000 }),
						{ once: true },
					);
				}),
		);
		const cleanupResources = vi.fn();
		Object.assign(
			manager as unknown as {
				state: "running";
				executionQueue: Promise<void>;
				executeInner: typeof executeInner;
				start: () => Promise<void>;
				cleanupResources: () => void;
			},
			{ state: "running", executionQueue: previousExecution, executeInner, start: async () => {}, cleanupResources },
		);

		const disposal = manager.shutdown({ snapshot: true, drainHostRequests: true });
		// A cell arriving mid-flush must not splice ahead of the final snapshot.
		await expect(manager.execute("1 + 1")).rejects.toThrow("Kernel is shutting down");
		releaseQueue();
		await waitForCalls(executeInner, 1);
		expect(executeInner.mock.calls[0]?.[0].type).toBe("snapshot");
		await vi.advanceTimersByTimeAsync(5000);

		await expect(disposal).resolves.toBe(true);
		expect(executeInner).toHaveBeenCalledOnce();
		expect(cleanupResources).toHaveBeenCalledOnce();
	});

	it("rejects an execution whose re-bootstrap wait crossed the start of the final flush", async () => {
		const manager = new ReplKernelManager({
			cwd: process.cwd(),
			snapshot: { path: "/tmp/test-state.dill", manifestPath: "/tmp/test-state.json" },
			bootstrapCode: "boot-code",
		});
		let releaseBootstrap: () => void = () => {};
		const bootstrapBlocked = new Promise<void>((resolve) => {
			releaseBootstrap = resolve;
		});
		let releaseSnapshot: () => void = () => {};
		const snapshotBlocked = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		const calls: string[] = [];
		const ok = { stdout: "", stderr: "", status: "ok" as const, durationMs: 0 };
		const executeInner = vi.fn(async (requestFields: Record<string, unknown> & { type: string }, code: string) => {
			if (requestFields.type === "snapshot") {
				calls.push("snapshot");
				await snapshotBlocked;
				return { ...ok, doneFields: { saved: [], skipped: [], bytes: 0 } };
			}
			if (code === "boot-code") {
				calls.push("bootstrap");
				await bootstrapBlocked;
				return ok;
			}
			calls.push("cell");
			return ok;
		});
		const cleanupResources = vi.fn();
		Object.assign(
			manager as unknown as {
				state: "running";
				pendingRebootstrap: boolean;
				executeInner: typeof executeInner;
				start: () => Promise<void>;
				cleanupResources: () => void;
			},
			{ state: "running", pendingRebootstrap: true, executeInner, start: async () => {}, cleanupResources },
		);

		// Admitted before the flush: passes the first guard, then parks on the
		// in-flight lazy re-bootstrap.
		const cell = manager.execute("user-cell");
		cell.catch(() => undefined);
		await waitForCalls(executeInner, 1);
		expect(calls).toEqual(["bootstrap"]);

		// The teardown's final flush starts while the cell is still parked.
		const teardown = manager.shutdown({ snapshot: true });
		await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
		releaseBootstrap();

		// Un-bootstrapped no more, the cell must NOT splice between the flush's
		// captured queue and the final snapshot; the guard re-check rejects it.
		await expect(cell).rejects.toThrow("Kernel is shutting down");
		releaseSnapshot();
		await expect(teardown).resolves.toBe(true);
		expect(calls).toEqual(["bootstrap", "snapshot"]);
	});

	it("settles an aborted execution promptly while the lazy re-bootstrap is still running", async () => {
		const manager = new ReplKernelManager({ cwd: process.cwd(), bootstrapCode: "boot-code" });
		let releaseBootstrap: () => void = () => {};
		const bootstrapBlocked = new Promise<void>((resolve) => {
			releaseBootstrap = resolve;
		});
		const ok = { stdout: "", stderr: "", status: "ok" as const, durationMs: 0 };
		const executeInner = vi.fn(async (_requestFields: Record<string, unknown> & { type: string }, code: string) => {
			if (code === "boot-code") {
				await bootstrapBlocked;
			}
			return ok;
		});
		Object.assign(
			manager as unknown as {
				state: "running";
				pendingRebootstrap: boolean;
				executeInner: typeof executeInner;
				start: () => Promise<void>;
			},
			{ state: "running", pendingRebootstrap: true, executeInner, start: async () => {} },
		);

		const controller = new AbortController();
		const cell = manager.execute("user-cell", { signal: controller.signal });
		await waitForCalls(executeInner, 1);

		// Aborted mid-wait: the cell must not ride out the bootstrap bound.
		controller.abort();
		await expect(cell).resolves.toMatchObject({ status: "aborted" });
		releaseBootstrap();
	});

	it("rejects restart() during the final snapshot flush instead of deadlocking the teardown", async () => {
		const manager = new ReplKernelManager({
			cwd: process.cwd(),
			snapshot: { path: "/tmp/test-state.dill", manifestPath: "/tmp/test-state.json" },
		});
		Object.assign(
			manager as unknown as { state: "running"; flushingSnapshotForDispose: boolean; start: () => Promise<void> },
			{
				state: "running",
				flushingSnapshotForDispose: true,
				start: async () => {},
			},
		);

		// Taking a queue slot here and joining the owning shutdown would leave the
		// flush's snapshot parked behind the slot forever (mutual wait).
		await expect(manager.restart()).rejects.toThrow("Kernel is shutting down");
	});

	it("joins concurrent teardowns into a single final snapshot flush", async () => {
		const manager = new ReplKernelManager({
			cwd: process.cwd(),
			snapshot: { path: "/tmp/test-state.dill", manifestPath: "/tmp/test-state.json" },
		});
		const executeInner = vi.fn(
			async (
				_requestFields: Record<string, unknown> & { type: string },
			): Promise<{ stdout: string; stderr: string; status: "ok"; durationMs: number }> => ({
				stdout: "",
				stderr: "",
				status: "ok",
				durationMs: 0,
			}),
		);
		const cleanupResources = vi.fn();
		Object.assign(
			manager as unknown as {
				state: "running";
				executionQueue: Promise<void>;
				executeInner: typeof executeInner;
				start: () => Promise<void>;
				cleanupResources: () => void;
			},
			{ state: "running", executionQueue: Promise.resolve(), executeInner, start: async () => {}, cleanupResources },
		);

		// A session dispose racing a signal-handler shutdown must share one final
		// flush instead of queueing a second snapshot behind the first.
		await Promise.all([
			manager.shutdown({ snapshot: true, drainHostRequests: true }),
			manager.shutdown({ snapshot: true }),
		]);

		const snapshotRequests = executeInner.mock.calls.filter((call) => call[0].type === "snapshot");
		expect(snapshotRequests).toHaveLength(1);
		expect(cleanupResources).toHaveBeenCalled();
	});

	it("routes null-id and stale-id stream events into backgroundOutput, not stdout", async () => {
		const writeLine = vi.fn(async (_request: Record<string, unknown>) => {});
		const { manager, internals } = runningManagerWith(writeLine);

		const executePromise = manager.execute("print('own')");
		await waitForCalls(writeLine, 1);
		const execution = internals.activeExecution;
		expect(execution).toBeDefined();
		if (!execution) {
			throw new Error("Expected an active execution");
		}

		internals.handleEvent({ event: "stdout", id: execution.requestId, text: "own\n" });
		internals.handleEvent({ event: "stdout", id: null, text: "SECRET-null\n" });
		internals.handleEvent({ event: "stdout", id: "stale-cell", text: "SECRET-stale\n" });
		internals.handleEvent({ event: "done", id: execution.requestId, status: "ok" });

		const result = await executePromise;
		expect(result.stdout).toBe("own\n");
		expect(result.stdout).not.toContain("SECRET");
		expect(result.backgroundOutput).toBe("SECRET-null\nSECRET-stale\n");
		manager.disposeSync();
	});

	it("carries between-cell background output into the next execution's result", async () => {
		const writeLine = vi.fn(async (_request: Record<string, unknown>) => {});
		const { manager, internals } = runningManagerWith(writeLine);

		// No active execution: null-id output parks as pending background output.
		internals.handleEvent({ event: "stdout", id: null, text: "between-cells\n" });

		const executePromise = manager.execute("x = 1");
		await waitForCalls(writeLine, 1);
		const execution = internals.activeExecution;
		expect(execution).toBeDefined();
		if (!execution) {
			throw new Error("Expected an active execution");
		}
		internals.handleEvent({ event: "done", id: execution.requestId, status: "ok" });

		const result = await executePromise;
		expect(result.stdout).toBe("");
		expect(result.backgroundOutput).toBe("between-cells\n");
		manager.disposeSync();
	});

	it("dispose writes a protocol shutdown request before hard-killing the child", async () => {
		const writeLine = vi.fn(async (_request: Record<string, unknown>) => {});
		const { manager, internals } = runningManagerWith(writeLine);
		const killSignals: (NodeJS.Signals | number | undefined)[] = [];
		internals.child = {
			kill: (signal?: NodeJS.Signals | number) => {
				killSignals.push(signal);
				return true;
			},
			pid: undefined,
			stdin: { destroyed: false, destroy: () => undefined },
		};

		await manager.shutdown({ snapshot: true, drainHostRequests: true });
		const types = writeLine.mock.calls.map((call) => (call[0] as { type?: string }).type);
		expect(types).toContain("shutdown");
		expect(killSignals).toContain("SIGTERM");
	});

	it("drops stale between-cell background output on kernel teardown", async () => {
		const writeLine = vi.fn(async (_request: Record<string, unknown>) => {});
		const { manager, internals } = runningManagerWith(writeLine);

		internals.handleEvent({ event: "stdout", id: null, text: "pre-restart-leftover\n" });
		manager.disposeSync();

		// Simulate the restarted kernel: a new execution must start clean.
		Object.assign(internals, { state: "running", start: async () => {} });
		const executePromise = manager.execute("x = 1");
		await waitForCalls(writeLine, 1);
		const execution = internals.activeExecution;
		expect(execution).toBeDefined();
		if (!execution) {
			throw new Error("Expected an active execution");
		}
		internals.handleEvent({ event: "done", id: execution.requestId, status: "ok" });

		const result = await executePromise;
		expect(result.backgroundOutput).toBeUndefined();
		manager.disposeSync();
	});

	it("marks between-cell background output as truncated once the pending cap is hit", async () => {
		const writeLine = vi.fn(async (_request: Record<string, unknown>) => {});
		const { manager, internals } = runningManagerWith(writeLine);

		// Overflow the pending buffer while idle; nothing more arrives during the cell.
		internals.handleEvent({ event: "stdout", id: null, text: "x".repeat(70 * 1024) });

		const executePromise = manager.execute("x = 1");
		await waitForCalls(writeLine, 1);
		const execution = internals.activeExecution;
		expect(execution).toBeDefined();
		if (!execution) {
			throw new Error("Expected an active execution");
		}
		internals.handleEvent({ event: "done", id: execution.requestId, status: "ok" });

		const result = await executePromise;
		expect(result.backgroundOutput).toContain("background output truncated at");
		expect(result.backgroundOutput?.length).toBeLessThan(70 * 1024);
		manager.disposeSync();
	});
});
