import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import type { CreateRlmSubagentRuntimeOptions, RlmSubagentRegistryEntry } from "../../../src/core/rlm-runtime.js";
import { IpythonKernelProvisioner } from "../../../src/core/tools/ipython.js";
import { createHarness, type Harness } from "../harness.js";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("ENG-5939 child owner boundaries", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.reverse()) {
			await harness.session.disposeAsync();
			harness.cleanup();
		}
		harnesses.length = 0;
		vi.restoreAllMocks();
	});

	it("dispatches both missing-selector listings through the live facade", async () => {
		const parent = await createHarness();
		harnesses.push(parent);
		const list = vi.spyOn(parent.session, "listRlmSubagents");
		await expect(parent.session.deleteRlmSubagent("missing-child")).rejects.toThrow("No direct RLM subagent");
		expect(list).toHaveBeenCalledTimes(2);
		expect(list.mock.contexts).toEqual([parent.session, parent.session]);
	});

	it("uses each descendant facade when resolving an inactive child", async () => {
		const parent = await createHarness();
		const child = await createHarness();
		harnesses.push(child, parent);
		parent.session.registerRlmChildSession("retained-child", child.session);
		const subagent: RlmSubagentRegistryEntry = {
			rlm_child_id: "passive-grandchild",
			active_session_id: null,
			session_id: null,
			session_name: "passive-grandchild",
			session_dir: child.tempDir,
			status: "completed",
		};
		const list = vi.spyOn(child.session, "listRlmSubagents").mockResolvedValue({ subagents: [subagent] });
		const deleteRuntime = vi.fn(async () => {});
		child.session.setSubagentRuntimeHost({
			createRlmSubagentRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			deleteRlmSubagentRuntime: deleteRuntime,
		});
		await expect(parent.session.deleteInactiveRlmSubagent(subagent.rlm_child_id)).resolves.toBe("deleted");
		expect(list.mock.contexts).toEqual([child.session]);
		expect(deleteRuntime).toHaveBeenCalledWith(subagent.rlm_child_id, undefined);
	});

	it("dispatches compaction cleanup retries through the current delete facade", async () => {
		const parent = await createHarness();
		const child = await createHarness();
		harnesses.push(child, parent);
		parent.session.registerRlmChildSession("retry-child", child.session);
		vi.spyOn(parent.session, "listRlmSubagents").mockResolvedValueOnce({
			subagents: [
				{
					rlm_child_id: "retry-child",
					active_session_id: null,
					session_id: child.session.sessionId,
					session_name: "retry-child",
					session_dir: child.tempDir,
					status: "completed",
				},
			],
		});
		const deleteRuntime = vi.fn(async () => {});
		deleteRuntime.mockRejectedValueOnce(new Error("cleanup failed"));
		parent.session.setSubagentRuntimeHost({
			createRlmSubagentRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			deleteRlmSubagentRuntime: deleteRuntime,
		});
		await expect(parent.session.deleteRlmSubagent("retry-child")).rejects.toThrow("cleanup failed");
		const remove = vi.spyOn(parent.session, "deleteRlmSubagent");
		const lifecycle = parent.session as unknown as {
			_reapDeletedRlmSubagentRuntimesAfterCompaction(): Promise<void>;
		};
		await lifecycle._reapDeletedRlmSubagentRuntimesAfterCompaction();
		expect(remove).toHaveBeenCalledWith("retry-child");
		expect(remove.mock.contexts).toEqual([parent.session]);
		expect(deleteRuntime).toHaveBeenCalledTimes(2);
	});

	it("propagates a facade listing rejection before deletion or fallback resolution", async () => {
		const parent = await createHarness();
		harnesses.push(parent);
		const failure = new Error("listing rejected");
		const list = vi.spyOn(parent.session, "listRlmSubagents").mockRejectedValue(failure);
		const remove = vi.fn(async () => {});
		parent.session.setSubagentRuntimeHost({
			createRlmSubagentRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			deleteRlmSubagentRuntime: remove,
		});
		await expect(parent.session.deleteRlmSubagent("missing-child")).rejects.toBe(failure);
		expect(list).toHaveBeenCalledOnce();
		expect(remove).not.toHaveBeenCalled();
	});

	it("reads the live status facade after global max-depth settings finish", async () => {
		const parent = await createHarness();
		harnesses.push(parent);
		const pendingFlush = deferred();
		vi.spyOn(parent.settingsManager, "flush").mockImplementationOnce(() => pendingFlush.promise);
		const setting = parent.session.setRlmMaxDepth(3, { global: true });
		const status = vi
			.spyOn(parent.session, "getRlmMaxDepthStatus")
			.mockReturnValue({ maxDepth: 7, source: "global" });
		expect(status).not.toHaveBeenCalled();
		pendingFlush.resolve();
		await expect(setting).resolves.toEqual({ maxDepth: 7, source: "global", globalSaved: true });
		expect(status.mock.contexts).toEqual([parent.session]);
		expect(parent.session.rlmMaxDepth).toBe(3);
	});

	it("starts parent kernel disposal synchronously when there are no children", async () => {
		const parent = await createHarness();
		harnesses.push(parent);
		const kernel = deferred();
		const order: string[] = [];
		const lifecycle = parent.session as unknown as {
			_disposeAsyncOnce(kernelSnapshot: boolean): Promise<void>;
		};
		const dispose = vi.spyOn(IpythonKernelProvisioner.prototype, "dispose").mockImplementation(async (options) => {
			const snapshot = options?.snapshot;
			expect(snapshot).toBe(false);
			order.push("kernel");
			await kernel.promise;
		});
		parent.session.registerDisposeCallback(() => {
			order.push("callback");
		});
		const disposing = lifecycle._disposeAsyncOnce(false);
		order.push("caller");
		expect(order).toEqual(["kernel", "caller"]);
		kernel.resolve();
		await disposing;
		expect(order).toEqual(["kernel", "caller", "callback"]);
		dispose.mockRestore();
	});

	it("reads the runtime host and inherited settings after asynchronous name preflight", async () => {
		const preflight = deferred();
		const child = await createHarness();
		harnesses.push(child);
		child.setResponses([fauxAssistantMessage("child result")]);
		const initialCreate = vi.fn(async () => ({ session: child.session }));
		const checkName = vi.fn(() => preflight.promise);
		const parent = await createHarness({
			persistSession: true,
			rlmMaxDepth: 2,
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async () => {
					throw new Error("unexpected explicit reply");
				},
				assertSessionNameAvailable: checkName,
			},
			subagentRuntimeHost: { createRlmSubagentRuntime: initialCreate, deleteRlmSubagentRuntime: async () => {} },
		});
		harnesses.push(parent);
		parent.setResponses([fauxAssistantMessage("parent consumed result")]);
		const spawning = parent.session.runRlmChild("child task", { name: "live-settings-worker" });
		expect(checkName).toHaveBeenCalledOnce();
		const create = vi.fn(async (_options: CreateRlmSubagentRuntimeOptions) => ({ session: child.session }));
		parent.session.setSubagentRuntimeHost({
			createRlmSubagentRuntime: create,
			deleteRlmSubagentRuntime: async () => {},
		});
		await parent.session.setRlmMaxDepth(3);
		preflight.resolve();
		const spawned = await spawning;
		await parent.session.waitForRlmQuiescence();
		expect(initialCreate).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledOnce();
		expect(create.mock.calls[0]?.[0]).toMatchObject({
			rlmDepth: 1,
			rlmMaxDepth: 3,
			sessionName: "live-settings-worker",
		});
		expect(parent.session.getRlmChildSession(spawned.rlm_child_id)).toBe(child.session);
	});

	it("uses the current host for completion and release after delayed runtime publication", async () => {
		const publication = deferred();
		const child = await createHarness();
		harnesses.push(child);
		child.setResponses([fauxAssistantMessage("child result")]);
		const originalComplete = vi.fn(() => true);
		const create = vi.fn(async () => {
			await publication.promise;
			return { session: child.session };
		});
		const parent = await createHarness({
			persistSession: true,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: create,
				completeRlmSubagentRuntime: originalComplete,
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		harnesses.push(parent);
		parent.setResponses([fauxAssistantMessage("parent consumed result")]);
		const spawned = await parent.session.runRlmChild("delayed child");
		expect(create).toHaveBeenCalledOnce();
		const originalRegister = parent.session.registerRlmChildSession;
		const register = vi.spyOn(parent.session, "registerRlmChildSession").mockImplementation(function (
			this: AgentSession,
			id,
			session,
			unsubscribe,
		) {
			expect(this).toBe(parent.session);
			return originalRegister.call(this, id, session, unsubscribe);
		});
		const complete = vi.fn(() => false);
		const release = vi.fn(async () => {
			await child.session.disposeAsync();
		});
		parent.session.setSubagentRuntimeHost({
			createRlmSubagentRuntime: async () => {
				throw new Error("unexpected second create");
			},
			completeRlmSubagentRuntime: complete,
			releaseRlmSubagentRuntime: release,
			deleteRlmSubagentRuntime: async () => {},
		});
		publication.resolve();
		await parent.session.waitForRlmQuiescence();
		expect(originalComplete).not.toHaveBeenCalled();
		expect(register).toHaveBeenCalledWith(spawned.rlm_child_id, child.session);
		expect(complete).toHaveBeenCalledWith(spawned.rlm_child_id, child.session);
		expect(release).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith(
			{ session: child.session },
			expect.objectContaining({ id: spawned.rlm_child_id }),
			"error",
		);
		expect(parent.session.getRlmChildSession(spawned.rlm_child_id)).toBeUndefined();
		expect(parent.session.getRlmChildSnapshots()).toEqual([]);
	});
});
