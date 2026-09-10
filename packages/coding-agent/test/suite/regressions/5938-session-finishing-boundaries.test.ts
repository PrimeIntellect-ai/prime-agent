import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageController, AgentSessionMessageReceipt } from "../../../src/core/agent-messages.js";
import type { AgentObserveAgentSnapshot, AgentObserveController } from "../../../src/core/agent-observe.js";
import type { AgentRlmHeartbeatController } from "../../../src/core/cron-jobs.js";
import { createHarness, type Harness } from "../harness.js";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()?.cleanup();
});

describe("session finishing boundaries", () => {
	it("keeps compact status on live public usage and rejects invalid instructions synchronously", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		vi.spyOn(harness.session, "getContextUsage").mockReturnValue({ tokens: 7, contextWindow: 70, percent: 10 });
		expect(harness.session.handleCompactHostRequest("compact.status")).toEqual({
			tokens: 7,
			context_window: 70,
			percent: 10,
			scheduled: false,
		});
		expect(() => harness.session.handleCompactHostRequest("compact.run", { instructions: 9 })).toThrow(
			"compact.run instructions must be a string when provided",
		);
		expect(harness.session.handleCompactHostRequest("compact.run")).toMatchObject({ scheduled: false });
	});

	it("keeps the heartbeat controller captured before payload getters replace the binding", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const unavailable = () => {
			throw new Error("unused heartbeat operation");
		};
		const first: AgentRlmHeartbeatController = {
			listRlmHeartbeats(options) {
				expect(this).toBe(first);
				expect(options).toEqual({ includeInactive: true });
				return [];
			},
			createRlmHeartbeat: unavailable,
			updateRlmHeartbeat: unavailable,
			deleteRlmHeartbeat: unavailable,
		};
		const second: AgentRlmHeartbeatController = { ...first, listRlmHeartbeats: vi.fn(() => []) };
		harness.session.setRlmHeartbeatController(first);
		const result = harness.session.handleRlmHeartbeatHostRequest("rlm_heartbeat.list", {
			get include_inactive() {
				harness.session.setRlmHeartbeatController(second);
				return true;
			},
		});
		expect(result).toEqual({ heartbeats: [] });
		expect(second.listRlmHeartbeats).not.toHaveBeenCalled();
	});

	it("preserves observation controller capture, receiver and the returned promise", async () => {
		const failure = new Error("observation failed");
		const pending = Promise.reject<AgentObserveAgentSnapshot>(failure);
		void pending.catch(() => {});
		const unused = () => {
			throw new Error("unused observation operation");
		};
		const controller: AgentObserveController = {
			listAgents: unused,
			recentMessages: unused,
			getAgent(target) {
				expect(this).toBe(controller);
				expect(target).toBe("child");
				return pending;
			},
		};
		const harness = await createHarness({ tools: [], agentObserveController: controller });
		harnesses.push(harness);
		const result = harness.session.handleAgentObserveHostRequest("agent_observe.get", {
			get target() {
				Object.defineProperty(harness.session, "_agentObserveController", { value: undefined });
				return "child";
			},
		});
		expect(result).toBe(pending);
		await expect(result).rejects.toBe(failure);
	});

	it("keeps each messaging-controller read live and preserves receiver and promise identity", async () => {
		const failure = new Error("send failed");
		const pending = Promise.reject<AgentSessionMessageReceipt>(failure);
		void pending.catch(() => {});
		const unused = () => {
			throw new Error("unused messaging operation");
		};
		const first: AgentSessionMessageController = { listAgents: unused, sendAgentMessage: unused };
		const second: AgentSessionMessageController = {
			...first,
			sendAgentMessage(input) {
				expect(this).toBe(second);
				expect(input).toEqual({ target: "child", message: "hello" });
				return pending;
			},
		};
		const harness = await createHarness({ tools: [], agentMessageController: first });
		harnesses.push(harness);
		let reads = 0;
		Object.defineProperty(harness.session, "_agentMessageController", {
			get: () => (++reads === 1 ? first : second),
		});
		const result = harness.session.handleAgentMessageHostRequest("agent_message.send", {
			target: "child",
			message: "hello",
		});
		expect(reads).toBe(2);
		expect(result).toBe(pending);
		await expect(result).rejects.toBe(failure);
	});

	it("uses the live public parent model for child defaults without an auth request", async () => {
		const harness = await createHarness({ tools: [], models: [{ id: "one" }, { id: "two" }] });
		harnesses.push(harness);
		const parent = harness.getModel("two")!;
		vi.spyOn(harness.session, "model", "get").mockReturnValue(parent);
		const auth = vi.spyOn(harness.session.modelRegistry, "getApiKeyAndHeaders");
		const catalog = vi.spyOn(harness.session.modelRegistry, "getExecutableModels");
		const session = harness.session as unknown as {
			_resolveRlmSubagentModel(reference?: string): Promise<{ model: Model<Api> }>;
		};
		expect((await session._resolveRlmSubagentModel()).model).toBe(parent);
		expect((await session._resolveRlmSubagentModel(`${parent.provider}/${parent.id}`)).model).toBe(parent);
		expect(auth).not.toHaveBeenCalled();
		expect(catalog).not.toHaveBeenCalled();
	});
});
