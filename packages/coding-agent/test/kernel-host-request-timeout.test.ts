import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { type HostRequestHandler, KernelManager } from "../src/core/kernel/index.js";

interface TestCommMessage {
	header: { msg_type: string };
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
}

interface KernelHostRequestTestApi {
	handleCommMessage(incoming: TestCommMessage): void;
	sendCommMessage(commId: string, data: Record<string, unknown>): Promise<void>;
	inFlightHostRequests: Set<Promise<void>>;
	hostRequestsByCommId: Map<string, unknown>;
}

function commClose(commId: string): TestCommMessage {
	return {
		header: { msg_type: "comm_close" },
		parent_header: {},
		metadata: {},
		content: { comm_id: commId },
	};
}

function commOpen(commId: string, data: Record<string, unknown>, parentMessageId?: string): TestCommMessage {
	return {
		header: { msg_type: "comm_open" },
		parent_header: parentMessageId === undefined ? {} : { msg_id: parentMessageId },
		metadata: {},
		content: {
			comm_id: commId,
			target_name: "host.request",
			data,
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`condition did not become true within ${timeoutMs}ms`);
		}
		await sleep(1);
	}
}

describe("KernelManager host request deadlines", () => {
	it("times out a stalled handler and ignores its late result", async () => {
		let started = false;
		let signal: AbortSignal | undefined;
		let release: (value: Record<string, unknown>) => void = () => {};
		const handler: HostRequestHandler = async (_payload, context) => {
			started = true;
			signal = context?.signal;
			return new Promise<Record<string, unknown>>((resolve) => {
				release = resolve;
			});
		};
		const manager = new KernelManager({
			hostHandlers: { "goal.complete": handler },
		});
		const kernel = manager as unknown as KernelHostRequestTestApi;
		const replies: Record<string, unknown>[] = [];
		kernel.sendCommMessage = async (_commId, data) => {
			replies.push(data);
		};

		try {
			kernel.handleCommMessage(
				commOpen("comm-timeout", {
					type: "goal.complete",
					_prime_agent_timeout_ms: 10,
				}),
			);
			await waitFor(() => started);
			await waitFor(() => replies.length === 1);

			expect(replies[0]).toEqual({
				status: "error",
				error_type: "timeout",
				error: 'host request "goal.complete" timed out after 10ms',
			});
			expect(signal?.aborted).toBe(true);
			expect(kernel.inFlightHostRequests.size).toBe(0);

			release({ goal: { status: "complete" } });
			await sleep(0);
			expect(replies).toHaveLength(1);
		} finally {
			release({});
			await manager.dispose();
		}
	});

	it("observes a late handler rejection after timeout", async () => {
		let rejectHandler: (error: Error) => void = () => {};
		const manager = new KernelManager({
			hostHandlers: {
				"goal.get": async () =>
					new Promise<Record<string, unknown>>((_resolve, reject) => {
						rejectHandler = reject;
					}),
			},
		});
		const kernel = manager as unknown as KernelHostRequestTestApi;
		const replies: Array<Record<string, unknown>> = [];
		kernel.sendCommMessage = async (_commId, data) => {
			replies.push(data);
		};

		try {
			kernel.handleCommMessage(commOpen("comm-late-rejection", { type: "goal.get", _prime_agent_timeout_ms: 10 }));
			await waitFor(() => replies.length === 1);
			rejectHandler(new Error("late handler failure"));
			await sleep(0);
			expect(replies).toHaveLength(1);
		} finally {
			await manager.dispose();
		}
	});

	it("aborts host work without replying when the kernel closes the Comm", async () => {
		let started = false;
		let signal: AbortSignal | undefined;
		let release: () => void = () => {};
		const manager = new KernelManager({
			hostHandlers: {
				"goal.complete": async (_payload, context) => {
					started = true;
					signal = context?.signal;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return { late: true };
				},
			},
		});
		const kernel = manager as unknown as KernelHostRequestTestApi;
		const replies: Record<string, unknown>[] = [];
		kernel.sendCommMessage = async (_commId, data) => {
			replies.push(data);
		};

		try {
			kernel.handleCommMessage(
				commOpen("comm-close", {
					type: "goal.complete",
					_prime_agent_timeout_ms: 1_000,
				}),
			);
			await waitFor(() => started);
			kernel.handleCommMessage(commClose("comm-close"));
			await waitFor(() => signal?.aborted === true && kernel.inFlightHostRequests.size === 0);

			expect(replies).toEqual([]);
			expect(kernel.hostRequestsByCommId.size).toBe(0);
			release();
			await sleep(0);
			expect(replies).toEqual([]);
		} finally {
			release();
			await manager.dispose();
		}
	});

	it("does not link a detached request to an unrelated active execution", async () => {
		let started = false;
		let signal: AbortSignal | undefined;
		let release: () => void = () => {};
		const manager = new KernelManager({
			hostHandlers: {
				"goal.get": async (_payload, context) => {
					started = true;
					signal = context?.signal;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return {};
				},
			},
		});
		const kernel = manager as unknown as KernelHostRequestTestApi & {
			activeExecution?: { requestMsgId: string; opts: { signal: AbortSignal } };
		};
		const unrelatedExecution = new AbortController();
		kernel.activeExecution = {
			requestMsgId: "active-cell",
			opts: { signal: unrelatedExecution.signal },
		};
		kernel.sendCommMessage = async () => {};

		try {
			kernel.handleCommMessage(
				commOpen("comm-detached", { type: "goal.get", _prime_agent_timeout_ms: 1_000 }, "detached-cell"),
			);
			await waitFor(() => started);
			unrelatedExecution.abort();
			await sleep(0);
			expect(signal?.aborted).toBe(false);

			kernel.handleCommMessage(commClose("comm-detached"));
			await waitFor(() => signal?.aborted === true);
		} finally {
			kernel.activeExecution = undefined;
			release();
			await manager.dispose();
		}
	});

	it("rejects an invalid kernel-supplied deadline before dispatch", async () => {
		let called = false;
		const manager = new KernelManager({
			hostHandlers: {
				"goal.get": async () => {
					called = true;
					return {};
				},
			},
		});
		const kernel = manager as unknown as KernelHostRequestTestApi;
		const replies: Record<string, unknown>[] = [];
		kernel.sendCommMessage = async (_commId, data) => {
			replies.push(data);
		};

		try {
			kernel.handleCommMessage(
				commOpen("comm-invalid", {
					type: "goal.get",
					_prime_agent_timeout_ms: 0,
				}),
			);
			await waitFor(() => replies.length === 1);
			expect(called).toBe(false);
			expect(replies[0]).toEqual({
				status: "error",
				error: "_prime_agent_timeout_ms must be an integer from 1 to 3600000",
			});
		} finally {
			await manager.dispose();
		}
	});

	it("rejects an invalid execution ownership marker before dispatch", async () => {
		const handler = vi.fn(async () => ({}));
		const manager = new KernelManager({ hostHandlers: { "goal.get": handler } });
		const kernel = manager as unknown as KernelHostRequestTestApi;
		const replies: Array<Record<string, unknown>> = [];
		kernel.sendCommMessage = async (_commId, data) => {
			replies.push(data);
		};

		try {
			kernel.handleCommMessage(
				commOpen("comm-invalid-owner", {
					type: "goal.get",
					_prime_agent_execution_owned: "yes",
				}),
			);
			await waitFor(() => replies.length === 1);

			expect(replies[0]).toEqual({
				status: "error",
				error: "_prime_agent_execution_owned must be a boolean",
			});
			expect(handler).not.toHaveBeenCalled();
		} finally {
			await manager.dispose();
		}
	});

	it("bounds dispose when a legacy handler never settles", async () => {
		vi.useFakeTimers();
		let started = false;
		let signal: AbortSignal | undefined;
		let release: () => void = () => {};
		const manager = new KernelManager({
			hostHandlers: {
				"goal.get": async (_payload, context) => {
					started = true;
					signal = context?.signal;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return {};
				},
			},
		});
		const kernel = manager as unknown as KernelHostRequestTestApi;
		kernel.sendCommMessage = async () => {};

		try {
			kernel.handleCommMessage(commOpen("comm-dispose", { type: "goal.get" }));
			for (let i = 0; i < 10 && !started; i++) await Promise.resolve();
			expect(started).toBe(true);

			const dispose = manager.dispose();
			await vi.advanceTimersByTimeAsync(5_000);
			await dispose;

			expect(signal?.aborted).toBe(true);
			expect(kernel.inFlightHostRequests.size).toBe(0);
			expect(kernel.hostRequestsByCommId.size).toBe(0);
		} finally {
			release();
			vi.useRealTimers();
			await manager.dispose();
		}
	});
});
