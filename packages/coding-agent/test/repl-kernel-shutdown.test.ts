import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

type ShutdownInternals = {
	state: "running";
	writeLine: (request: Record<string, unknown>) => Promise<void>;
	handleEvent: (event: Record<string, unknown>) => void;
	pendingDoneWaiters: Map<string, () => void>;
	child: EventEmitter & {
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
		kill: (signal?: NodeJS.Signals | number) => boolean;
		pid?: number;
		stdin: { destroyed: boolean; destroy: () => void };
		stdout?: { destroy: () => void };
		stderr?: { destroy: () => void };
	};
};

function configuredManager(
	onSend: (request: Record<string, unknown>, internals: ShutdownInternals) => void | Promise<void>,
): {
	manager: ReplKernelManager;
	internals: ShutdownInternals;
} {
	const manager = new ReplKernelManager({ cwd: process.cwd() });
	const internals = manager as unknown as ShutdownInternals;
	const child = Object.assign(new EventEmitter(), {
		exitCode: null,
		signalCode: null,
		kill: vi.fn(() => true),
		pid: undefined,
		stdin: { destroyed: false, destroy: vi.fn() },
		stdout: { destroy: vi.fn() },
		stderr: { destroy: vi.fn() },
	});
	Object.assign(internals, {
		state: "running",
		writeLine: vi.fn(async (request: Record<string, unknown>) => onSend(request, internals)),
		child,
	});
	return { manager, internals };
}

describe("ReplKernelManager graceful shutdown", () => {
	it("bounds a stuck stdin write with the aggregate shutdown deadline", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals } = configuredManager(() => new Promise<void>(() => {}));
			const shutdown = manager.shutdown();
			await vi.advanceTimersByTimeAsync(5_000);
			await shutdown;
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
});
