import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	type HostRequestHandlers,
	KernelManager,
	type KernelSentAgentMessage,
} from "../src/core/kernel/index.js";
import { RootForegroundLease } from "../src/core/root-foreground-lease.js";

async function waitForCalls(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (mock.mock.calls.length >= count) {
			return;
		}
		await Promise.resolve();
	}
	expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

function sentMessageTypes(mock: { mock: { calls: unknown[][] } }): string[] {
	return mock.mock.calls.flatMap((call) => {
		const frames = call[0];
		if (!Array.isArray(frames) || !Buffer.isBuffer(frames[2])) return [];
		const header = JSON.parse(frames[2].toString()) as { msg_type?: unknown };
		return typeof header.msg_type === "string" ? [header.msg_type] : [];
	});
}

function mockRunningManager(
	hostHandlers?: HostRequestHandlers,
	foregroundLease?: RootForegroundLease,
): {
	manager: KernelManager;
	shellSend: ReturnType<typeof vi.fn>;
	controlSend: ReturnType<typeof vi.fn>;
} {
	const manager = new KernelManager({ cwd: process.cwd(), hostHandlers, foregroundLease });
	const shellSend = vi.fn(async (_frames: Buffer[]) => {});
	const controlSend = vi.fn(async (_frames: Buffer[]) => {});
	Object.assign(manager as unknown as Record<string, unknown>, {
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
	});
	return { manager, shellSend, controlSend };
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
		await waitForCalls(controlSend, 1);
		expect(sentMessageTypes(controlSend)).toContain("interrupt_request");
		await vi.advanceTimersByTimeAsync(1000);

		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });
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

	it("lets the Act host request delay interruption for its correlated execution", async () => {
		vi.useFakeTimers();
		let hostStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			hostStarted = resolve;
		});
		const foreground = new RootForegroundLease();
		const { manager, shellSend, controlSend } = mockRunningManager(
			{
				"rlm.act": async (_payload, signal, channel) => {
					hostStarted();
					await new Promise<void>((resolve) => {
						const abort = () => {
							channel?.interruptAfterGrace?.(100);
							resolve();
						};
						signal?.addEventListener("abort", abort, { once: true });
						if (signal?.aborted) abort();
					});
					return { outcome: "cancelled" };
				},
			},
			foreground,
		);
		const controller = new AbortController();
		const execution = manager.execute("await rlm.act('block')", { signal: controller.signal });
		let settlements = 0;
		void execution.then(
			() => settlements++,
			() => settlements++,
		);
		await waitForCalls(shellSend, 1);
		const internals = manager as unknown as {
			activeExecution?: { requestMsgId: string };
			startHostRequestFromComm(commId: string, data: unknown, parentMessageId?: string): void;
			handleExecutionMessage(incoming: {
				header: { msg_type: string };
				parent_header: Record<string, unknown>;
				metadata: Record<string, unknown>;
				content: Record<string, unknown>;
			}): void;
		};
		const requestMsgId = internals.activeExecution?.requestMsgId;
		if (!requestMsgId) throw new Error("expected active execution");
		internals.startHostRequestFromComm("act-comm", { type: "rlm.act", prompt: "block" }, requestMsgId);
		await started;

		controller.abort();
		expect(sentMessageTypes(controlSend)).not.toContain("interrupt_request");
		await vi.advanceTimersByTimeAsync(99);
		expect(sentMessageTypes(controlSend)).not.toContain("interrupt_request");
		await vi.advanceTimersByTimeAsync(1);
		expect(sentMessageTypes(controlSend).filter((type) => type === "interrupt_request")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(900);
		expect(settlements).toBe(0);
		expect(foreground.actActive).toBe(true);

		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: requestMsgId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		expect(settlements).toBe(1);
		expect(foreground.actActive).toBe(false);
		manager.disposeSync();
	});

	it("restores immediate interrupt after the Act host request settles", async () => {
		vi.useFakeTimers();
		const { manager, shellSend, controlSend } = mockRunningManager({
			"rlm.act": async () => ({ outcome: "done" }),
		});
		const controller = new AbortController();
		const execution = manager.execute("await rlm.act('finish')\nwhile True: pass", { signal: controller.signal });
		await waitForCalls(shellSend, 1);
		const internals = manager as unknown as {
			activeExecution?: { requestMsgId: string; interruptOwnerCommId?: string };
			startHostRequestFromComm(commId: string, data: unknown, parentMessageId?: string): void;
			handleExecutionMessage(incoming: {
				header: { msg_type: string };
				parent_header: Record<string, unknown>;
				metadata: Record<string, unknown>;
				content: Record<string, unknown>;
			}): void;
		};
		const requestMsgId = internals.activeExecution?.requestMsgId;
		if (!requestMsgId) throw new Error("expected active execution");
		internals.startHostRequestFromComm("act-comm", { type: "rlm.act", prompt: "finish" }, requestMsgId);
		for (let index = 0; index < 20 && internals.activeExecution?.interruptOwnerCommId; index++) {
			await Promise.resolve();
		}
		expect(internals.activeExecution?.interruptOwnerCommId).toBeUndefined();

		controller.abort();
		await waitForCalls(controlSend, 2);
		expect(sentMessageTypes(controlSend)).toContain("interrupt_request");
		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: requestMsgId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		manager.disposeSync();
	});

	it("does not deliver a delayed Act interrupt to a later root execution", async () => {
		vi.useFakeTimers();
		let hostStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			hostStarted = resolve;
		});
		const { manager, shellSend, controlSend } = mockRunningManager({
			"rlm.act": async (_payload, signal, channel) => {
				hostStarted();
				await new Promise<void>((resolve) => {
					const abort = () => {
						channel?.interruptAfterGrace?.(100);
						resolve();
					};
					signal?.addEventListener("abort", abort, { once: true });
					if (signal?.aborted) abort();
				});
				return { outcome: "cancelled" };
			},
		});
		const controller = new AbortController();
		const first = manager.execute("await rlm.act('block')", { signal: controller.signal });
		await waitForCalls(shellSend, 1);
		const internals = manager as unknown as {
			activeExecution?: { requestMsgId: string };
			startHostRequestFromComm(commId: string, data: unknown, parentMessageId?: string): void;
			handleExecutionMessage(incoming: {
				header: { msg_type: string };
				parent_header: Record<string, unknown>;
				metadata: Record<string, unknown>;
				content: Record<string, unknown>;
			}): void;
		};
		const firstRequestId = internals.activeExecution?.requestMsgId;
		if (!firstRequestId) throw new Error("expected first execution");
		internals.startHostRequestFromComm("act-comm", { type: "rlm.act", prompt: "block" }, firstRequestId);
		await started;
		controller.abort();
		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: firstRequestId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await expect(first).resolves.toMatchObject({ status: "aborted" });

		const second = manager.execute("x = 1");
		for (let index = 0; index < 20; index++) {
			const activeRequestId = internals.activeExecution?.requestMsgId;
			if (activeRequestId && activeRequestId !== firstRequestId) break;
			await Promise.resolve();
		}
		const secondRequestId = internals.activeExecution?.requestMsgId;
		if (!secondRequestId || secondRequestId === firstRequestId) throw new Error("expected later execution");
		await vi.advanceTimersByTimeAsync(100);
		expect(sentMessageTypes(controlSend)).not.toContain("interrupt_request");
		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: secondRequestId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await expect(second).resolves.toMatchObject({ status: "ok" });
		manager.disposeSync();
	});

	it("preserves an aborted result when foreground admission is cancelled", async () => {
		const foreground = new RootForegroundLease();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const active = foreground.run("root-turn", () => gate);
		const { manager, shellSend } = mockRunningManager(undefined, foreground);
		const controller = new AbortController();
		const execution = manager.execute("never_sent = True", { signal: controller.signal });
		controller.abort();
		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		expect(shellSend).not.toHaveBeenCalled();
		release();
		await active;
		manager.disposeSync();
	});

	it("releases kernel foreground ownership when shutdown rejects an active execution", async () => {
		const foreground = new RootForegroundLease();
		const { manager, shellSend } = mockRunningManager(undefined, foreground);
		const execution = manager.execute("await never_finishes()");
		await waitForCalls(shellSend, 1);
		const later = vi.fn(async () => {});
		const queued = foreground.run("root-turn", later);
		manager.disposeSync();
		await expect(execution).rejects.toThrow();
		await queued;
		expect(later).toHaveBeenCalledTimes(1);
		expect(foreground.busy).toBe(false);
	});

	it("shares FIFO foreground admission with root turns and later root cells", async () => {
		const foreground = new RootForegroundLease();
		const { manager, shellSend } = mockRunningManager(undefined, foreground);
		const order: string[] = [];
		const first = manager.execute("x = 1");
		await waitForCalls(shellSend, 1);
		const internals = manager as unknown as {
			activeExecution?: { requestMsgId: string };
			handleExecutionMessage(incoming: {
				header: { msg_type: string };
				parent_header: Record<string, unknown>;
				metadata: Record<string, unknown>;
				content: Record<string, unknown>;
			}): void;
		};
		const firstRequestId = internals.activeExecution?.requestMsgId;
		if (!firstRequestId) throw new Error("expected first execution");
		const turn = foreground.run("root-turn", async () => {
			order.push("turn");
		});
		const second = manager.execute("x = 2").then((result) => {
			order.push("cell");
			return result;
		});
		await Promise.resolve();
		expect(shellSend).toHaveBeenCalledTimes(1);

		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: firstRequestId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await first;
		await turn;
		await waitForCalls(shellSend, 2);
		expect(order).toEqual(["turn"]);
		const secondRequestId = internals.activeExecution?.requestMsgId;
		if (!secondRequestId || secondRequestId === firstRequestId) throw new Error("expected second execution");
		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: secondRequestId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await second;
		expect(order).toEqual(["turn", "cell"]);
		manager.disposeSync();
	});

	it("projects Act only while its correlated host request owns the root cell", async () => {
		let finishHost!: () => void;
		const hostGate = new Promise<void>((resolve) => {
			finishHost = resolve;
		});
		const foreground = new RootForegroundLease();
		const { manager, shellSend } = mockRunningManager(
			{
				"rlm.act": async () => {
					await hostGate;
					return { outcome: "done" };
				},
			},
			foreground,
		);
		const execution = manager.execute("await rlm.act('work')");
		await waitForCalls(shellSend, 1);
		const internals = manager as unknown as {
			activeExecution?: { requestMsgId: string };
			startHostRequestFromComm(commId: string, data: unknown, parentMessageId?: string): void;
			handleExecutionMessage(incoming: {
				header: { msg_type: string };
				parent_header: Record<string, unknown>;
				metadata: Record<string, unknown>;
				content: Record<string, unknown>;
			}): void;
		};
		const requestMsgId = internals.activeExecution?.requestMsgId;
		if (!requestMsgId) throw new Error("expected active execution");
		internals.startHostRequestFromComm("act-comm", { type: "rlm.act", prompt: "work" }, requestMsgId);
		for (let index = 0; index < 20 && !foreground.actActive; index++) await Promise.resolve();
		expect(foreground.actActive).toBe(true);
		finishHost();
		for (let index = 0; index < 20; index++) await Promise.resolve();
		expect(foreground.actActive).toBe(true);
		expect(foreground.busy).toBe(true);
		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: requestMsgId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await execution;
		expect(foreground.actActive).toBe(false);
		expect(foreground.busy).toBe(false);
		manager.disposeSync();
	});
});
