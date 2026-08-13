import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

/**
 * Drive executeInner without a Python kernel: stub startup, hand it a connection and a
 * shell whose send resolves, and never deliver an iopub reply. The cell then settles only
 * through the abort or timeout path, which is exactly what these tests exercise.
 */
function stubKernel(manager: KernelManager): void {
	Object.assign(manager as unknown as Record<string, unknown>, {
		doStart: async () => {
			(manager as unknown as { state: string }).state = "running";
		},
		connection: { key: "test-key" },
		// interrupt() returns early without a control channel, so it is a no-op here.
		control: undefined,
		shell: { send: async () => undefined },
	});
}

describe("KernelManager execute timeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("settles a never-replying cell as a timeout instead of hanging", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		stubKernel(manager);

		const execution = manager.execute("while True: pass", { timeoutMs: 5_000 });
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(1_000);

		const result = await execution;
		expect(result.status).toBe("timeout");
		expect(result.stderr).toContain("timed out after 5s");
	});

	it("keeps a user abort labelled aborted when a timeout fires inside the grace window", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		stubKernel(manager);
		const controller = new AbortController();

		// A generous timeout that lands mid-grace once the abort starts settling.
		const execution = manager.execute("while True: pass", { timeoutMs: 500, signal: controller.signal });
		// Let startup and the request send settle first; aborting during startup takes a
		// different path (raceStartupWithAbort) and would not exercise the latch.
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(1_000);

		const result = await execution;
		expect(result.status).toBe("aborted");
		expect(result.stderr).not.toContain("timed out");
	});

	it("keeps a timeout labelled timeout when the user aborts afterwards", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		stubKernel(manager);
		const controller = new AbortController();

		const execution = manager.execute("while True: pass", { timeoutMs: 100, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(100);
		controller.abort();
		await vi.advanceTimersByTimeAsync(1_000);

		const result = await execution;
		expect(result.status).toBe("timeout");
	});

	// Point 3 from review: the skip guard used to cover only "aborted", so a timeout fell
	// through to `await sendPromise` and a send that never settles hung exactly as before.
	it("settles on timeout even when shell.send never settles", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		stubKernel(manager);
		Object.assign(manager as unknown as Record<string, unknown>, {
			shell: { send: () => new Promise<void>(() => {}) },
		});

		const execution = manager.execute("while True: pass", { timeoutMs: 200 });
		await vi.advanceTimersByTimeAsync(200);
		await vi.advanceTimersByTimeAsync(1_000);

		const result = await execution;
		expect(result.status).toBe("timeout");
	});

	it("leaves a cell unbounded when no timeout is set", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		stubKernel(manager);

		let settled = false;
		void manager.execute("while True: pass", {}).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(600_000);

		expect(settled).toBe(false);
	});
});
