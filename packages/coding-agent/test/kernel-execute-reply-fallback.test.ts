import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

interface JupyterWireMessage {
	header: { msg_type: string };
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
}

interface ActiveExecutionInternals {
	requestMsgId: string;
	opts: { internal?: boolean };
}

interface ManagerInternals {
	activeExecution?: ActiveExecutionInternals;
	handleShellMessage: (incoming: JupyterWireMessage) => void;
	handleExecutionMessage: (incoming: JupyterWireMessage) => void;
	startHostRequestFromComm: (commId: string, data: unknown, parentMessageId?: string) => void;
	hostRequestsByCommId: Map<string, unknown>;
}

const FAKE_CONNECTION = {
	ip: "127.0.0.1",
	transport: "tcp",
	shell_port: 1,
	iopub_port: 2,
	stdin_port: 3,
	control_port: 4,
	hb_port: 5,
	signature_scheme: "hmac-sha256",
	key: "test-key",
	kernel_name: "python3",
};

async function waitForCalls(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (mock.mock.calls.length >= count) return;
		await Promise.resolve();
	}
	expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

function makeManager(): {
	manager: KernelManager;
	internals: ManagerInternals;
	shellSend: ReturnType<typeof vi.fn>;
	shellClose: ReturnType<typeof vi.fn>;
} {
	const manager = new KernelManager({ cwd: process.cwd() });
	const shellSend = vi.fn(async (_frames: Buffer[]) => {});
	const shellClose = vi.fn();
	Object.assign(manager as unknown as Record<string, unknown>, {
		state: "running",
		connection: FAKE_CONNECTION,
		shell: { send: shellSend, close: shellClose },
		control: { send: vi.fn(async (_frames: Buffer[]) => {}), close: vi.fn() },
		start: async () => {},
	});
	return { manager, internals: manager as unknown as ManagerInternals, shellSend, shellClose };
}

function executeReply(requestMsgId: string, content: Record<string, unknown> = { status: "ok" }): JupyterWireMessage {
	return {
		header: { msg_type: "execute_reply" },
		parent_header: { msg_id: requestMsgId },
		metadata: {},
		content,
	};
}

function iopubMessage(requestMsgId: string, msgType: string, content: Record<string, unknown>): JupyterWireMessage {
	return {
		header: { msg_type: msgType },
		parent_header: { msg_id: requestMsgId },
		metadata: {},
		content,
	};
}

function iopubIdle(requestMsgId: string): JupyterWireMessage {
	return iopubMessage(requestMsgId, "status", { execution_state: "idle" });
}

async function remainsPending<T>(promise: Promise<T>): Promise<boolean> {
	let settled = false;
	void promise.finally(() => {
		settled = true;
	});
	await Promise.resolve();
	return !settled;
}

describe("KernelManager execute_reply completion fallback", () => {
	it("finishes the exact execution after the idle grace and drains the serial queue", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals, shellSend } = makeManager();
			const firstPromise = manager.execute("print('first')");
			await waitForCalls(shellSend, 1);
			const first = internals.activeExecution;
			expect(first).toBeDefined();

			internals.handleShellMessage(executeReply(first!.requestMsgId));
			await vi.advanceTimersByTimeAsync(1999);
			expect(await remainsPending(firstPromise)).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			await expect(firstPromise).resolves.toMatchObject({ status: "ok" });

			const secondPromise = manager.execute("print('second')");
			await waitForCalls(shellSend, 2);
			const second = internals.activeExecution;
			expect(second?.requestMsgId).not.toBe(first?.requestMsgId);
			internals.handleExecutionMessage(iopubIdle(second!.requestMsgId));
			await expect(secondPromise).resolves.toMatchObject({ status: "ok" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps matching IOPub idle authoritative and preserves trailing output", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals, shellSend } = makeManager();
			const firstPromise = manager.execute("print('complete')");
			await waitForCalls(shellSend, 1);
			const first = internals.activeExecution;
			internals.handleShellMessage(executeReply(first!.requestMsgId));
			internals.handleExecutionMessage(
				iopubMessage(first!.requestMsgId, "stream", { name: "stdout", text: "complete\n" }),
			);
			internals.handleExecutionMessage(iopubIdle(first!.requestMsgId));
			await expect(firstPromise).resolves.toMatchObject({ status: "ok", stdout: "complete\n" });

			const secondPromise = manager.execute("print('next')");
			await waitForCalls(shellSend, 2);
			const second = internals.activeExecution;
			internals.handleShellMessage(executeReply(first!.requestMsgId));
			await vi.advanceTimersByTimeAsync(5000);
			expect(internals.activeExecution).toBe(second);
			expect(await remainsPending(secondPromise)).toBe(true);
			internals.handleExecutionMessage(iopubIdle(second!.requestMsgId));
			await expect(secondPromise).resolves.toMatchObject({ status: "ok" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("ignores execute_reply for a different request", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals, shellSend } = makeManager();
			const executePromise = manager.execute("print('active')");
			await waitForCalls(shellSend, 1);
			const execution = internals.activeExecution;
			internals.handleShellMessage(executeReply("stale-request"));
			await vi.advanceTimersByTimeAsync(5000);
			expect(internals.activeExecution).toBe(execution);
			expect(await remainsPending(executePromise)).toBe(true);
			internals.handleExecutionMessage(iopubIdle(execution!.requestMsgId));
			await expect(executePromise).resolves.toMatchObject({ status: "ok" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears the fallback timer when the execution is aborted", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals, shellSend } = makeManager();
			const controller = new AbortController();
			const executePromise = manager.execute("while True: pass", { signal: controller.signal });
			await waitForCalls(shellSend, 1);
			const execution = internals.activeExecution;
			internals.handleShellMessage(executeReply(execution!.requestMsgId));
			controller.abort();
			await vi.advanceTimersByTimeAsync(1000);
			await expect(executePromise).resolves.toMatchObject({ status: "aborted" });
			await vi.advanceTimersByTimeAsync(5000);
			expect(internals.activeExecution).toBe(execution);
			internals.handleExecutionMessage(iopubIdle(execution!.requestMsgId));
			expect(internals.activeExecution).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears the fallback timer when the manager is disposed", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals, shellSend, shellClose } = makeManager();
			const executePromise = manager.execute("print('pending')");
			void executePromise.catch(() => undefined);
			await waitForCalls(shellSend, 1);
			const execution = internals.activeExecution;
			internals.handleShellMessage(executeReply(execution!.requestMsgId));
			await manager.dispose();
			await expect(executePromise).rejects.toThrow("Kernel has been shut down");
			await vi.advanceTimersByTimeAsync(5000);
			expect(internals.activeExecution).toBeUndefined();
			expect(shellClose).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("propagates a terminal execute_reply error when IOPub idle is lost", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals, shellSend } = makeManager();
			const executePromise = manager.execute("raise RuntimeError('boom')");
			await waitForCalls(shellSend, 1);
			const execution = internals.activeExecution;
			internals.handleShellMessage(
				executeReply(execution!.requestMsgId, {
					status: "error",
					ename: "RuntimeError",
					evalue: "boom",
					traceback: ["Traceback: boom"],
				}),
			);
			await vi.advanceTimersByTimeAsync(2000);
			await expect(executePromise).resolves.toMatchObject({
				status: "error",
				error: { ename: "RuntimeError", evalue: "boom" },
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const check = spawnSync(candidate, ["-c", "import ipykernel, dill"], { encoding: "utf8" });
		if (check.status === 0) return candidate;
	}
	return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) globalThis.clearTimeout(timer);
	}
}

const kernelPython = resolveKernelPython();
const describeIfKernel = kernelPython ? describe : describe.skip;

describeIfKernel("auto-snapshot lost-idle queue regression (real kernel)", { tags: ["kernel-heavy"] }, () => {
	let dir = "";

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-snapshot-reply-fallback-"));
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("drains a written internal snapshot before the next user cell", async () => {
		const snapshotPath = join(dir, "kernel-state.dill");
		const manifestPath = join(dir, "kernel-state.json");
		const manager = new KernelManager({
			python: kernelPython as string,
			cwd: dir,
			snapshot: { path: snapshotPath, manifestPath, debounceMs: 20 },
		});
		const internals = manager as unknown as ManagerInternals;
		const handleShellMessage = internals.handleShellMessage.bind(manager);
		const handleExecutionMessage = internals.handleExecutionMessage.bind(manager);
		const startHostRequestFromComm = internals.startHostRequestFromComm.bind(manager);
		let hostRequestCount = 0;
		let droppedInternalIdle = false;
		let droppedInternalRequestId: string | undefined;
		let internalRequestId: string | undefined;
		let resolveInternalReply: () => void = () => {};
		const internalReply = new Promise<void>((resolve) => {
			resolveInternalReply = resolve;
		});

		internals.startHostRequestFromComm = (commId, data, parentMessageId) => {
			hostRequestCount++;
			startHostRequestFromComm(commId, data, parentMessageId);
		};
		internals.handleShellMessage = (incoming) => {
			handleShellMessage(incoming);
			const active = internals.activeExecution;
			if (
				incoming.header.msg_type === "execute_reply" &&
				active?.opts.internal === true &&
				incoming.parent_header.msg_id === active.requestMsgId
			) {
				internalRequestId = active.requestMsgId;
				resolveInternalReply();
			}
		};
		internals.handleExecutionMessage = (incoming) => {
			const active = internals.activeExecution;
			if (
				!droppedInternalIdle &&
				active?.opts.internal === true &&
				incoming.header.msg_type === "status" &&
				incoming.parent_header.msg_id === active.requestMsgId &&
				incoming.content.execution_state === "idle"
			) {
				droppedInternalIdle = true;
				droppedInternalRequestId = active.requestMsgId;
				return;
			}
			handleExecutionMessage(incoming);
		};

		try {
			const first = await manager.execute("snapshot_value = 41");
			expect(first.status).toBe("ok");
			await withTimeout(internalReply, 10_000, "internal snapshot execute_reply did not arrive");
			expect(internalRequestId).toBeDefined();
			await expect.poll(() => droppedInternalIdle, { timeout: 1000 }).toBe(true);
			expect(droppedInternalRequestId).toBe(internalRequestId);
			await expect.poll(() => existsSync(snapshotPath), { timeout: 1000 }).toBe(true);
			expect(existsSync(manifestPath)).toBe(true);

			const second = await withTimeout(
				manager.execute("snapshot_value += 1\nprint(snapshot_value)"),
				5000,
				"second user cell stayed queued behind the internal snapshot",
			);
			expect(second).toMatchObject({ status: "ok", stdout: "42\n" });
			expect(hostRequestCount).toBe(0);
			expect(internals.hostRequestsByCommId.size).toBe(0);

			const third = await withTimeout(
				manager.execute("print('queue-drained')"),
				5000,
				"serial execution queue did not drain",
			);
			expect(third).toMatchObject({ status: "ok", stdout: "queue-drained\n" });
		} finally {
			await manager.kill();
		}
	}, 60_000);
});
