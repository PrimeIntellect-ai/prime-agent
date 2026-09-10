import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateRlmSubagentRuntimeOptions } from "../../../src/core/rlm-runtime.js";
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
