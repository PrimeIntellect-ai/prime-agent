import { describe, expect, it, vi } from "vitest";
import type { AgentObserveController } from "../../src/core/agent-observe.js";
import { createHarness } from "./harness.js";

function createController(): AgentObserveController {
	return {
		listAgents: vi.fn(() => ({
			current: {
				activeSessionId: "alpha",
				sessionId: "session-alpha",
				cwd: "/tmp/project",
				status: "idle",
				isCurrent: true,
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				messageCount: 1,
				queuedCount: 0,
				isSessionActive: false,
			},
			agents: [],
		})),
		getAgent: vi.fn((target) => ({
			agent: {
				activeSessionId: target,
				sessionId: "session-beta",
				cwd: "/tmp/project",
				status: "model",
				isCurrent: false,
				isStreaming: true,
				isCompacting: false,
				attachedClients: 1,
				messageCount: 3,
				queuedCount: 0,
				isSessionActive: false,
			},
		})),
		recentMessages: vi.fn((input) => ({
			agent: {
				activeSessionId: input.target,
				sessionId: "session-beta",
				cwd: "/tmp/project",
				status: "model",
				isCurrent: false,
				isStreaming: true,
				isCompacting: false,
				attachedClients: 1,
				messageCount: 3,
				queuedCount: 0,
				isSessionActive: false,
			},
			messages: [{ index: 2, role: "assistant", text: "working", truncated: false }],
			limit: input.limit ?? 8,
			maxChars: input.maxChars ?? 800,
			truncated: false,
		})),
	};
}

describe("AgentSession agent observe host requests", () => {
	it("routes list, get, and recent requests to the read-only controller", async () => {
		const controller = createController();
		const harness = await createHarness({ agentObserveController: controller });
		try {
			expect(harness.session.handleAgentObserveHostRequest("agent_observe.list")).toMatchObject({
				current: { activeSessionId: "alpha" },
			});
			expect(harness.session.handleAgentObserveHostRequest("agent_observe.get", { target: "beta" })).toMatchObject({
				agent: { activeSessionId: "beta", status: "model" },
			});
			expect(
				harness.session.handleAgentObserveHostRequest("agent_observe.recent", {
					target: "beta",
					limit: 3,
					max_chars: 120,
				}),
			).toMatchObject({
				agent: { activeSessionId: "beta" },
				messages: [{ text: "working" }],
				limit: 3,
				maxChars: 120,
			});
			expect(controller.listAgents).toHaveBeenCalledTimes(1);
			expect(controller.getAgent).toHaveBeenCalledWith("beta");
			expect(controller.recentMessages).toHaveBeenCalledWith({ target: "beta", limit: 3, maxChars: 120 });
		} finally {
			harness.cleanup();
		}
	});

	it("rejects malformed and unknown observe requests", async () => {
		const harness = await createHarness({ agentObserveController: createController() });
		try {
			expect(() => harness.session.handleAgentObserveHostRequest("agent_observe.get", {})).toThrow(
				"target must be a string",
			);
			expect(() =>
				harness.session.handleAgentObserveHostRequest("agent_observe.recent", {
					target: "beta",
					limit: 0,
				}),
			).toThrow("between 1 and 50");
			expect(() => harness.session.handleAgentObserveHostRequest("agent_observe.delete")).toThrow(
				"unknown agent observe request",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("is unavailable without a daemon-backed controller", async () => {
		const harness = await createHarness();
		try {
			expect(() => harness.session.handleAgentObserveHostRequest("agent_observe.list")).toThrow(
				"agent observation is not available",
			);
		} finally {
			harness.cleanup();
		}
	});
});
