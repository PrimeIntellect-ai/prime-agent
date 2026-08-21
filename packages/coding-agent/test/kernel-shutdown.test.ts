import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

type TestMessage = {
	header: { msg_type: string };
	parent_header: { msg_id: string };
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
};

type ShutdownInternals = {
	state: "running";
	connection: { key: string };
	control: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
	kernel: EventEmitter & {
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
		kill: (signal?: NodeJS.Signals | number) => boolean;
	};
	pendingControlReplies: Map<string, (message: TestMessage) => void>;
};

function shutdownReply(parentMessageId: string, msgType = "shutdown_reply"): TestMessage {
	return {
		header: { msg_type: msgType },
		parent_header: { msg_id: parentMessageId },
		metadata: {},
		content: { status: "ok", restart: false },
	};
}

function configuredManager(onSend: (internals: ShutdownInternals) => void | Promise<void>): {
	manager: KernelManager;
	internals: ShutdownInternals;
} {
	const manager = new KernelManager({ cwd: process.cwd() });
	const internals = manager as unknown as ShutdownInternals;
	const kernel = Object.assign(new EventEmitter(), {
		exitCode: null,
		signalCode: null,
		kill: vi.fn(() => true),
	});
	Object.assign(internals, {
		state: "running",
		connection: { key: "test-key" },
		control: {
			send: vi.fn(async () => onSend(internals)),
			close: vi.fn(),
		},
		kernel,
	});
	return { manager, internals };
}

describe("KernelManager graceful shutdown", () => {
	it("bounds a stuck control send with the aggregate shutdown deadline", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals } = configuredManager(() => new Promise<void>(() => {}));
			const shutdown = manager.shutdown();
			await vi.advanceTimersByTimeAsync(5_000);
			await shutdown;
			expect(internals.kernel).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not finish shutdown before the control send settles", async () => {
		let finishSend: (() => void) | undefined;
		const sendBlocked = new Promise<void>((resolve) => {
			finishSend = resolve;
		});
		const { manager, internals } = configuredManager(async (state) => {
			const [requestMessageId, dispatch] = [...state.pendingControlReplies.entries()][0] ?? [];
			if (!requestMessageId || !dispatch) throw new Error("missing shutdown reply listener");
			dispatch(shutdownReply(requestMessageId));
			await sendBlocked;
			state.kernel.exitCode = 0;
			state.kernel.emit("exit", 0, null);
		});

		let finished = false;
		const shutdown = manager.shutdown().then(() => {
			finished = true;
		});
		await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
		expect(finished).toBe(false);
		finishSend?.();
		await shutdown;
		expect(internals.pendingControlReplies.size).toBe(0);
	});

	it("finishes promptly when the kernel exits without sending shutdown_reply", async () => {
		const { manager, internals } = configuredManager((state) => {
			state.kernel.exitCode = 0;
			state.kernel.emit("exit", 0, null);
		});
		vi.useFakeTimers();
		try {
			const shutdown = manager.shutdown();
			await vi.advanceTimersByTimeAsync(100);
			// True = this call performed the cleanup: startup-failure recovery relies on it to resurrect to idle.
			await expect(shutdown).resolves.toBe(true);
			expect(internals.kernel).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits for the matching shutdown reply and removes its listener", async () => {
		const { manager, internals } = configuredManager(async (state) => {
			const [requestMessageId, dispatch] = [...state.pendingControlReplies.entries()][0] ?? [];
			expect(requestMessageId).toBeTypeOf("string");
			expect(dispatch).toBeTypeOf("function");
			if (!requestMessageId || !dispatch) throw new Error("missing shutdown reply listener");
			dispatch(shutdownReply("unrelated"));
			dispatch(shutdownReply(requestMessageId, "interrupt_reply"));
			expect(state.pendingControlReplies.size).toBe(1);
			dispatch(shutdownReply(requestMessageId));
			queueMicrotask(() => {
				state.kernel.exitCode = 0;
				state.kernel.emit("exit", 0, null);
			});
		});

		await manager.shutdown();

		expect(internals.pendingControlReplies.size).toBe(0);
		expect(internals.kernel).toBeUndefined();
	});

	it("keeps the kernel MCP close budget strictly inside the host shutdown deadline", () => {
		const source = readFileSync(resolve(__dirname, "../../../prime-agent-runtime/src/rlm/mcp.py"), "utf8");
		const match = source.match(/^_SHUTDOWN_TIMEOUT = ([\d.]+)$/m);
		expect(match).not.toBeNull();
		// +1s dispatch slack in mcp.py close(); the sum must undercut the host's 5s kill deadline.
		expect((Number(match![1]) + 1) * 1000).toBeLessThan(5000);
	});
});
