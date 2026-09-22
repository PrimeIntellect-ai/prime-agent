import { describe, expect, it, vi } from "vitest";
import type { AgentObserveController } from "../../src/core/agent-observe.js";
import { createHarness } from "./harness.js";

function agentStub(activeSessionId: string) {
	return {
		activeSessionId,
		sessionId: `session-${activeSessionId}`,
		cwd: "/tmp/project",
		status: "idle" as const,
		isCurrent: false,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		queuedCount: 0,
		isSessionActive: false,
	};
}

function createController(): AgentObserveController {
	return {
		listAgents: vi.fn(() => ({ current: agentStub("alpha"), agents: [] })),
		getAgent: vi.fn((target: string) => ({ agent: agentStub(target) })),
		recentMessages: vi.fn((input: { target: string; limit?: number; maxChars?: number }) => ({
			agent: agentStub(input.target),
			messages: [{ index: 2, role: "assistant" as const, text: "working", truncated: false }],
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
			harness.session.handleAgentObserveHostRequest("agent_observe.list");
			harness.session.handleAgentObserveHostRequest("agent_observe.get", { target: "beta" });
			harness.session.handleAgentObserveHostRequest("agent_observe.recent", {
				target: "beta",
				limit: 3,
				max_chars: 120,
			});
			expect(controller.listAgents).toHaveBeenCalledTimes(1);
			expect(controller.getAgent).toHaveBeenCalledWith("beta");
			expect(controller.recentMessages).toHaveBeenCalledWith({ target: "beta", limit: 3, maxChars: 120 });
		} finally {
			harness.cleanup();
		}
	});

	it.each([
		["agent_observe.get", {}, "target must be a string"],
		["agent_observe.recent", { target: "beta", limit: 0 }, "between 1 and 50"],
		["agent_observe.delete", undefined, "unknown agent observe request"],
	] as const)("rejects malformed request %s", async (method, params, message) => {
		const harness = await createHarness({ agentObserveController: createController() });
		try {
			expect(() => harness.session.handleAgentObserveHostRequest(method, params)).toThrow(message);
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
