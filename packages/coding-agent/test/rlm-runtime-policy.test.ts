import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	createPolicyControlledSubagentRuntimeHost,
	RlmSubagentCapacityPool,
	type RlmSubagentRuntime,
	type SubagentRuntimeHost,
} from "../src/core/rlm-runtime.js";

function options(id: string): CreateRlmSubagentRuntimeOptions {
	return {
		id,
		sessionName: id,
		thinkingLevel: "medium",
	} as CreateRlmSubagentRuntimeOptions;
}

function runtime(): RlmSubagentRuntime {
	return { session: {} as AgentSession };
}

describe("policy-controlled RLM subagent runtime host", () => {
	it("serializes admission and rejects concurrent work beyond policy capacity", async () => {
		let finishCreate: ((value: RlmSubagentRuntime) => void) | undefined;
		const delegate: SubagentRuntimeHost = {
			createRlmSubagentRuntime: vi.fn(
				() =>
					new Promise<RlmSubagentRuntime>((resolve) => {
						finishCreate = resolve;
					}),
			),
			deleteRlmSubagentRuntime: vi.fn(async () => undefined),
		};
		const host = createPolicyControlledSubagentRuntimeHost(delegate, ({ snapshot }) =>
			snapshot.activeChildren < 1 ? { allowed: true } : { allowed: false, reason: "wave capacity reached" },
		);

		const first = host.createRlmSubagentRuntime(options("first"));
		await vi.waitFor(() => expect(delegate.createRlmSubagentRuntime).toHaveBeenCalledTimes(1));
		await expect(host.createRlmSubagentRuntime(options("second"))).rejects.toEqual(
			expect.objectContaining({
				name: "RlmSubagentAdmissionError",
				reason: "wave capacity reached",
			}),
		);
		expect(host.getSnapshot()).toMatchObject({ activeChildren: 1, totalChildren: 1 });

		finishCreate?.(runtime());
		await first;
		expect(host.getSnapshot().children[0]?.status).toBe("running");
	});

	it("applies admitted overrides and tracks lifecycle transitions", async () => {
		const child = runtime();
		const delegate: SubagentRuntimeHost = {
			createRlmSubagentRuntime: vi.fn(async () => child),
			completeRlmSubagentRuntime: vi.fn(() => true),
			releaseRlmSubagentRuntime: vi.fn(async () => undefined),
			deleteRlmSubagentRuntime: vi.fn(async () => undefined),
			disposeRlmSubagentRuntimes: vi.fn(async () => undefined),
		};
		const host = createPolicyControlledSubagentRuntimeHost(delegate, () => ({
			allowed: true,
			overrides: { thinkingLevel: "high", rlmMaxDepth: 1 },
		}));

		await host.createRlmSubagentRuntime(options("child"));
		expect(delegate.createRlmSubagentRuntime).toHaveBeenCalledWith(
			expect.objectContaining({ thinkingLevel: "high", rlmMaxDepth: 1 }),
		);
		expect(host.completeRlmSubagentRuntime("child", child.session)).toBe(true);
		expect(host.getSnapshot().children[0]?.status).toBe("completed");

		await host.releaseRlmSubagentRuntime(child, options("child"), "cancelled");
		expect(host.getSnapshot().children[0]?.status).toBe("cancelled");
		await host.deleteRlmSubagentRuntime("child", child.session);
		expect(host.getSnapshot()).toMatchObject({ activeChildren: 0, totalChildren: 1 });
		expect(host.getSnapshot().children[0]?.status).toBe("deleted");
	});

	it("does not complete a child when the delegate refuses completion", async () => {
		const child = runtime();
		const delegate: SubagentRuntimeHost = {
			createRlmSubagentRuntime: vi.fn(async () => child),
			completeRlmSubagentRuntime: vi.fn(() => false),
			deleteRlmSubagentRuntime: vi.fn(async () => undefined),
		};
		const host = createPolicyControlledSubagentRuntimeHost(delegate, () => ({ allowed: true }));

		await host.createRlmSubagentRuntime(options("child"));
		expect(host.completeRlmSubagentRuntime("child", child.session)).toBe(false);
		expect(host.getSnapshot().children[0]?.status).toBe("running");
	});

	it("creates runtimes immediately and shares turn capacity without holding slots while idle", async () => {
		const delegate: SubagentRuntimeHost = {
			createRlmSubagentRuntime: vi.fn(async () => runtime()),
			deleteRlmSubagentRuntime: vi.fn(async () => undefined),
		};
		const host = createPolicyControlledSubagentRuntimeHost(delegate, () => ({ allowed: true }), {
			maxConcurrentChildren: 1,
		});

		await Promise.all([
			host.createRlmSubagentRuntime(options("first")),
			host.createRlmSubagentRuntime(options("second")),
		]);
		expect(delegate.createRlmSubagentRuntime).toHaveBeenCalledTimes(2);
		const firstOptions = vi.mocked(delegate.createRlmSubagentRuntime).mock.calls[0]?.[0];
		const secondOptions = vi.mocked(delegate.createRlmSubagentRuntime).mock.calls[1]?.[0];
		expect(firstOptions?.turnCapacityPool).toBeDefined();
		expect(secondOptions?.turnCapacityPool).toBe(firstOptions?.turnCapacityPool);
	});

	it("cancels a queued turn without consuming execution capacity", async () => {
		const capacityPool = new RlmSubagentCapacityPool(1);
		await capacityPool.acquire("first-turn");
		const abortController = new AbortController();
		const queued = capacityPool.acquire("queued-turn", abortController.signal);
		abortController.abort();
		await expect(queued).rejects.toThrow("cancelled while queued");
		capacityPool.release("first-turn");
		await expect(capacityPool.acquire("next-turn")).resolves.toBeUndefined();
	});

	it("shares FIFO execution capacity across independent recursive turns", async () => {
		const calls: string[] = [];
		const capacityPool = new RlmSubagentCapacityPool(1);
		await capacityPool.acquire("first-turn");
		const second = capacityPool.acquire("second-turn").then(() => calls.push("second-turn"));
		const third = capacityPool.acquire("third-turn").then(() => calls.push("third-turn"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toEqual([]);
		capacityPool.release("first-turn");
		await second;
		expect(calls).toEqual(["second-turn"]);
		capacityPool.release("second-turn");
		await third;
		expect(calls).toEqual(["second-turn", "third-turn"]);
	});
});
