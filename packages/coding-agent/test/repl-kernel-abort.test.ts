import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	type KernelSentAgentMessage,
	ReplKernelManager,
} from "../src/core/kernel/index.js";

type ExecuteResult = Awaited<ReturnType<ReplKernelManager["execute"]>>;

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

/** The manager's queue/teardown internals are private; these tests drive them directly. */
function stub(manager: ReplKernelManager, overrides: Record<string, unknown>): void {
	Object.assign(manager as unknown as Record<string, unknown>, overrides);
}

const noStart = { start: async (): Promise<void> => {} };

function runningManagerWith(writeLine: (request: Record<string, unknown>) => Promise<void>): {
	manager: ReplKernelManager;
	internals: ReplInternals;
	kernelKill: ReturnType<typeof vi.fn>;
} {
	const manager = new ReplKernelManager({ cwd: process.cwd() });
	const kernelKill = vi.fn((_signal?: NodeJS.Signals | number) => true);
	stub(manager, {
		state: "running",
		writeLine,
		...noStart,
		child: { kill: kernelKill, pid: undefined, stdin: undefined },
	});
	return { manager, internals: manager as unknown as ReplInternals, kernelKill };
}

function requireExecution(internals: ReplInternals): { requestId: string } {
	const execution = internals.activeExecution;
	if (!execution) {
		throw new Error("Expected an active execution");
	}
	return execution;
}

const OK_RESULT = { stdout: "", stderr: "", status: "ok" as const, durationMs: 0 };

/** Snapshot execution that never finishes on its own: it only settles when aborted. */
function abortOnlyExecuteInner() {
	return vi.fn(
		async (
			_requestFields: Record<string, unknown> & { type: string },
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
}

describe("ReplKernelManager abort handling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not poison startup after a caller starts with an aborted signal", async () => {
		const manager = new ReplKernelManager({ cwd: process.cwd() });
		let startCount = 0;
		stub(manager, {
			doStart: async () => {
				startCount++;
			},
		});
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
		stub(manager, {
			doStart: async () => {
				startCount++;
				await new Promise<void>((resolve) => {
					releaseStart = resolve;
				});
			},
		});
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
		expect(writeLine.mock.calls[0]?.[0]).toMatchObject({ type: "execute" });

		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);

		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });
		// The abort listener interrupted the runtime out-of-band.
		expect(writeLine.mock.calls.some((call) => (call[0] as { type?: string }).type === "interrupt")).toBe(true);
		expect(kernelKill).not.toHaveBeenCalled();

		// The stale cell stays active until the runtime's done arrives.
		const activeExecution = requireExecution(internals);
		// A late display event for the aborted cell still dispatches the sent message.
		const sentMessage = {
			id: "agentmsg-after-abort",
			message: "still sent",
			deliveryStatus: "delivered",
			target: { activeSessionId: "beta", sessionId: "session-beta" },
		};
		internals.handleEvent({
			event: "display",
			id: activeExecution.requestId,
			data: { [AGENT_MESSAGE_DISPLAY_MIME]: sentMessage },
		});
		expect(lateSentAgentMessages).toEqual([sentMessage]);

		// The next execute waits for the stale cell's done before sending.
		const executeCount = (): number =>
			writeLine.mock.calls.filter((call) => (call[0] as { type?: string }).type === "execute").length;
		const secondExecutePromise = manager.execute("x = 1");
		await Promise.resolve();
		expect(executeCount()).toBe(1);

		internals.handleEvent({ event: "done", id: activeExecution.requestId, status: "error" });
		await vi.waitFor(() => {
			expect(executeCount()).toBe(2);
		});

		internals.handleEvent({ event: "done", id: requireExecution(internals).requestId, status: "ok" });
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
		manager.disposeSync();
	});

	it("settles an aborted execution promptly while the lazy re-bootstrap is still running", async () => {
		const manager = new ReplKernelManager({ cwd: process.cwd(), bootstrapCode: "boot-code" });
		let releaseBootstrap: () => void = () => {};
		const bootstrapBlocked = new Promise<void>((resolve) => {
			releaseBootstrap = resolve;
		});
		const executeInner = vi.fn(async (_requestFields: Record<string, unknown> & { type: string }, code: string) => {
			if (code === "boot-code") {
				await bootstrapBlocked;
			}
			return OK_RESULT;
		});
		stub(manager, { state: "running", pendingRebootstrap: true, executeInner, ...noStart });

		const controller = new AbortController();
		const cell = manager.execute("user-cell", { signal: controller.signal });
		await waitForCalls(executeInner, 1);

		// Aborted mid-wait: the cell must not ride out the bootstrap bound.
		controller.abort();
		await expect(cell).resolves.toMatchObject({ status: "aborted" });
		releaseBootstrap();
	});

	describe("final snapshot flush", () => {
		const snapshotManager = (): ReplKernelManager =>
			new ReplKernelManager({
				cwd: process.cwd(),
				snapshot: { path: "/tmp/test-state.dill", manifestPath: "/tmp/test-state.json" },
			});

		it("cancels a hung final snapshot execution before teardown", async () => {
			vi.useFakeTimers();
			const manager = snapshotManager();
			let releaseQueue: () => void = () => {};
			const previousExecution = new Promise<void>((resolve) => {
				releaseQueue = resolve;
			});
			const executeInner = abortOnlyExecuteInner();
			const cleanupResources = vi.fn();
			stub(manager, {
				state: "running",
				executionQueue: previousExecution,
				executeInner,
				cleanupResources,
				...noStart,
			});

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
			const manager = snapshotManager();
			const executeInner = vi.fn();
			const interrupt = vi.fn(async () => {});
			const cleanupResources = vi.fn();
			stub(manager, {
				state: "running",
				executionQueue: new Promise<void>(() => {}),
				activeExecution: {},
				executeInner,
				interrupt,
				cleanupResources,
			});

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
			const manager = snapshotManager();
			let releaseQueue: () => void = () => {};
			const previousExecution = new Promise<void>((resolve) => {
				releaseQueue = resolve;
			});
			const executeInner = abortOnlyExecuteInner();
			const cleanupResources = vi.fn();
			stub(manager, {
				state: "running",
				executionQueue: previousExecution,
				executeInner,
				cleanupResources,
				...noStart,
			});

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
			const executeInner = vi.fn(async (requestFields: Record<string, unknown> & { type: string }, code: string) => {
				if (requestFields.type === "snapshot") {
					calls.push("snapshot");
					await snapshotBlocked;
					return { ...OK_RESULT, doneFields: { saved: [], skipped: [], bytes: 0 } };
				}
				calls.push(code === "boot-code" ? "bootstrap" : "cell");
				if (code === "boot-code") await bootstrapBlocked;
				return OK_RESULT;
			});
			const cleanupResources = vi.fn();
			stub(manager, { state: "running", pendingRebootstrap: true, executeInner, cleanupResources, ...noStart });

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

		it("rejects restart() during the final snapshot flush instead of deadlocking the teardown", async () => {
			const manager = snapshotManager();
			// Taking a queue slot here and joining the owning shutdown would leave the
			// flush's snapshot parked behind the slot forever (mutual wait).
			stub(manager, { state: "running", flushingSnapshotForDispose: true, ...noStart });

			await expect(manager.restart()).rejects.toThrow("Kernel is shutting down");
		});

		it("joins concurrent teardowns into a single final snapshot flush", async () => {
			const manager = snapshotManager();
			const executeInner = vi.fn(async (_requestFields: Record<string, unknown> & { type: string }) => OK_RESULT);
			const cleanupResources = vi.fn();
			stub(manager, {
				state: "running",
				executionQueue: Promise.resolve(),
				executeInner,
				cleanupResources,
				...noStart,
			});

			// A session dispose racing a signal-handler shutdown must share one final
			// flush instead of queueing a second snapshot behind the first.
			await Promise.all([
				manager.shutdown({ snapshot: true, drainHostRequests: true }),
				manager.shutdown({ snapshot: true }),
			]);

			expect(executeInner.mock.calls.filter((call) => call[0].type === "snapshot")).toHaveLength(1);
			expect(cleanupResources).toHaveBeenCalled();
		});

		it("writes a protocol shutdown request before hard-killing the child", async () => {
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

			expect(writeLine.mock.calls.map((call) => (call[0] as { type?: string }).type)).toContain("shutdown");
			expect(killSignals).toContain("SIGTERM");
		});
	});

	// Output that is not owned by the running cell must never leak into its stdout.
	it.each<{
		label: string;
		before?: (internals: ReplInternals) => void;
		during?: (internals: ReplInternals, requestId: string) => void;
		check: (result: ExecuteResult) => void;
	}>([
		{
			label: "routes null-id and stale-id stream events into backgroundOutput, not stdout",
			during: (internals, requestId) => {
				internals.handleEvent({ event: "stdout", id: requestId, text: "own\n" });
				internals.handleEvent({ event: "stdout", id: null, text: "SECRET-null\n" });
				internals.handleEvent({ event: "stdout", id: "stale-cell", text: "SECRET-stale\n" });
			},
			check: (result) => {
				expect(result.stdout).toBe("own\n");
				expect(result.backgroundOutput).toBe("SECRET-null\nSECRET-stale\n");
			},
		},
		{
			label: "carries between-cell background output into the next execution's result",
			before: (internals) => internals.handleEvent({ event: "stdout", id: null, text: "between-cells\n" }),
			check: (result) => {
				expect(result.stdout).toBe("");
				expect(result.backgroundOutput).toBe("between-cells\n");
			},
		},
		{
			label: "marks between-cell background output as truncated once the pending cap is hit",
			before: (internals) => internals.handleEvent({ event: "stdout", id: null, text: "x".repeat(70 * 1024) }),
			check: (result) => {
				expect(result.backgroundOutput).toContain("background output truncated at");
				expect(result.backgroundOutput?.length).toBeLessThan(70 * 1024);
			},
		},
	])("$label", async ({ before, during, check }) => {
		const writeLine = vi.fn(async (_request: Record<string, unknown>) => {});
		const { manager, internals } = runningManagerWith(writeLine);

		before?.(internals);
		const executePromise = manager.execute("print('own')");
		await waitForCalls(writeLine, 1);
		const execution = requireExecution(internals);
		during?.(internals, execution.requestId);
		internals.handleEvent({ event: "done", id: execution.requestId, status: "ok" });

		check(await executePromise);
		manager.disposeSync();
	});
});
