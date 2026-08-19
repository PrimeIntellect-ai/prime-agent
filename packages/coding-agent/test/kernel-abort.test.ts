import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_DISPLAY_MIME, KernelManager, type KernelSentAgentMessage } from "../src/core/kernel/index.js";

async function waitForCalls(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (mock.mock.calls.length >= count) {
			return;
		}
		await Promise.resolve();
	}
	expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

describe("KernelManager abort handling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not poison startup after a caller starts with an aborted signal", async () => {
		const manager = new KernelManager({ cwd: process.cwd() });
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
		const manager = new KernelManager({ cwd: process.cwd() });
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

	it("settles an aborted execution when the kernel never reports idle", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		const shellSend = vi.fn(async (_frames: Buffer[]) => {});
		const controlSend = vi.fn(async (_frames: Buffer[]) => {});
		const kernelKill = vi.fn((_signal?: NodeJS.Signals | number) => true);
		Object.assign(
			manager as unknown as {
				state: "running";
				connection: {
					ip: "127.0.0.1";
					transport: "tcp";
					shell_port: number;
					iopub_port: number;
					stdin_port: number;
					control_port: number;
					hb_port: number;
					signature_scheme: "hmac-sha256";
					key: string;
					kernel_name: string;
				};
				shell: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				control: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				kernel: { kill: (signal?: NodeJS.Signals | number) => boolean };
				start: () => Promise<void>;
			},
			{
				state: "running",
				connection: {
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
				},
				shell: { send: shellSend, close: vi.fn() },
				control: { send: controlSend, close: vi.fn() },
				kernel: { kill: kernelKill },
				start: async () => {},
			},
		);
		const controller = new AbortController();
		const lateSentAgentMessages: KernelSentAgentMessage[] = [];

		const executePromise = manager.execute("while True: pass", {
			signal: controller.signal,
			onLateSentAgentMessage: (message) => lateSentAgentMessages.push(message),
		});
		await waitForCalls(shellSend, 1);
		expect(shellSend).toHaveBeenCalledTimes(1);

		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);

		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });
		expect(controlSend).toHaveBeenCalled();
		expect(kernelKill).not.toHaveBeenCalled();

		const internals = manager as unknown as {
			activeExecution?: { requestMsgId: string };
			handleExecutionMessage: (incoming: {
				header: { msg_type: string };
				parent_header: Record<string, unknown>;
				metadata: Record<string, unknown>;
				content: Record<string, unknown>;
			}) => void;
		};
		const activeExecution = internals.activeExecution;
		expect(activeExecution).toBeDefined();
		if (!activeExecution) {
			throw new Error("Expected active execution to remain until kernel idle");
		}
		internals.handleExecutionMessage({
			header: { msg_type: "display_data" },
			parent_header: { msg_id: activeExecution.requestMsgId },
			metadata: {},
			content: {
				data: {
					[AGENT_MESSAGE_DISPLAY_MIME]: {
						id: "agentmsg-after-abort",
						message: "still sent",
						deliveryStatus: "delivered",
						target: { activeSessionId: "beta", sessionId: "session-beta" },
					},
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
		const secondExecutePromise = manager.execute("x = 1");
		await Promise.resolve();
		expect(shellSend).toHaveBeenCalledTimes(1);

		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: activeExecution.requestMsgId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await waitForCalls(shellSend, 2);
		expect(shellSend).toHaveBeenCalledTimes(2);

		const secondExecution = internals.activeExecution;
		expect(secondExecution).toBeDefined();
		if (!secondExecution) {
			throw new Error("Expected second execution to start after previous cell went idle");
		}
		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: secondExecution.requestMsgId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await expect(secondExecutePromise).resolves.toMatchObject({ status: "ok" });

		manager.disposeSync();
		expect(kernelKill).toHaveBeenCalledWith("SIGTERM");
	});

	it("settles an aborted execution when shell send never resolves", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		const shellSend = vi.fn((_frames: Buffer[]) => new Promise<void>(() => {}));
		const controlSend = vi.fn(async (_frames: Buffer[]) => {});
		Object.assign(
			manager as unknown as {
				state: "running";
				connection: {
					ip: "127.0.0.1";
					transport: "tcp";
					shell_port: number;
					iopub_port: number;
					stdin_port: number;
					control_port: number;
					hb_port: number;
					signature_scheme: "hmac-sha256";
					key: string;
					kernel_name: string;
				};
				shell: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				control: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				start: () => Promise<void>;
			},
			{
				state: "running",
				connection: {
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
				},
				shell: { send: shellSend, close: vi.fn() },
				control: { send: controlSend, close: vi.fn() },
				start: async () => {},
			},
		);
		const controller = new AbortController();

		const executePromise = manager.execute("while True: pass", { signal: controller.signal });
		await waitForCalls(shellSend, 1);
		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);

		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });
		expect(controlSend).toHaveBeenCalled();
	});

	it("fails a later execution fast when the interrupted cell never idles", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		const shellSend = vi.fn(async (_frames: Buffer[]) => {});
		const controlSend = vi.fn(async (_frames: Buffer[]) => {});
		Object.assign(
			manager as unknown as {
				state: "running";
				connection: {
					ip: "127.0.0.1";
					transport: "tcp";
					shell_port: number;
					iopub_port: number;
					stdin_port: number;
					control_port: number;
					hb_port: number;
					signature_scheme: "hmac-sha256";
					key: string;
					kernel_name: string;
				};
				shell: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				control: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				start: () => Promise<void>;
			},
			{
				state: "running",
				connection: {
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
				},
				shell: { send: shellSend, close: vi.fn() },
				control: { send: controlSend, close: vi.fn() },
				start: async () => {},
			},
		);
		const controller = new AbortController();

		const executePromise = manager.execute("while True: pass", { signal: controller.signal });
		await waitForCalls(shellSend, 1);
		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);
		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });

		const secondExecutePromise = manager.execute("x = 1");
		const secondExecuteExpectation = expect(secondExecutePromise).rejects.toThrow(
			"IPython kernel is still running the previously interrupted cell",
		);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(5000);

		await secondExecuteExpectation;
		expect(shellSend).toHaveBeenCalledTimes(1);
		expect(controlSend).toHaveBeenCalled();
		manager.disposeSync();
	});

	it("starts the snapshot timeout after earlier kernel work finishes", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({
			cwd: process.cwd(),
			snapshot: { path: "/tmp/test-state.dill", manifestPath: "/tmp/test-state.json" },
		});
		let releaseQueue: () => void = () => {};
		const previousExecution = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		const executeInner = vi.fn(
			async (_code: string, opts: { signal?: AbortSignal }) =>
				await new Promise<{ stdout: string; stderr: string; status: "aborted"; durationMs: number }>((resolve) => {
					opts.signal?.addEventListener(
						"abort",
						() => resolve({ stdout: "", stderr: "", status: "aborted", durationMs: 5000 }),
						{ once: true },
					);
				}),
		);
		Object.assign(
			manager as unknown as {
				state: "running";
				executionQueue: Promise<void>;
				executeInner: typeof executeInner;
				start: () => Promise<void>;
			},
			{ state: "running", executionQueue: previousExecution, executeInner, start: async () => {} },
		);

		const snapshot = (
			manager as unknown as {
				captureSnapshot: (options?: { executionTimeoutMs?: number }) => Promise<unknown>;
			}
		).captureSnapshot({ executionTimeoutMs: 5000 });
		await vi.advanceTimersByTimeAsync(5000);
		expect(executeInner).not.toHaveBeenCalled();

		releaseQueue();
		await waitForCalls(executeInner, 1);
		const signal = executeInner.mock.calls[0]?.[1].signal;
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(4999);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signal?.aborted).toBe(true);
		await expect(snapshot).resolves.toBeNull();
	});
});
