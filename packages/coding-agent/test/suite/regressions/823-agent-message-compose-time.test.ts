import { describe, expect, it } from "vitest";
import {
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
	isAgentSessionMessagePrompt,
	parseAgentSessionMessagePromptId,
} from "../../../src/core/agent-messages.js";

function payload(overrides: Partial<AgentSessionMessagePayload> = {}): AgentSessionMessagePayload {
	return {
		id: "agentmsg_demo",
		source: "agent_message",
		message: "Please inspect the latest result.",
		from: { activeSessionId: "active-parent", sessionId: "parent-id", sessionName: "lead" },
		fromRelationship: "parent",
		target: { activeSessionId: "active-child", sessionId: "child-id", sessionName: "worker" },
		...overrides,
	};
}

/**
 * A steered agent message can wait an unbounded number of turns behind the target's
 * own work, but the delivered prompt rendered sender, route, and message id and no
 * time of any kind. The recipient could not tell a message composed seconds ago from
 * one that had waited 90 minutes, so it could not judge whether "the latest result"
 * still meant what the sender meant.
 */
describe("issue #823 agent message compose time", () => {
	it("renders the compose time in the delivered prompt", () => {
		const prompt = createAgentSessionMessagePrompt(payload({ composedAt: "2026-08-11T10:15:00.000Z" }));

		expect(prompt).toContain("Composed: 2026-08-11T10:15:00.000Z");
		expect(prompt.endsWith("\n\nPlease inspect the latest result.")).toBe(true);
	});

	it("keeps the fixed-offset header parser working", () => {
		// parseAgentSessionMessagePromptId walks the header by index, so the new line
		// must sit strictly after the id line it stops on.
		const withTime = createAgentSessionMessagePrompt(payload({ composedAt: "2026-08-11T10:15:00.000Z" }));
		const withoutTime = createAgentSessionMessagePrompt(payload());

		expect(parseAgentSessionMessagePromptId(withTime)).toBe("agentmsg_demo");
		expect(parseAgentSessionMessagePromptId(withoutTime)).toBe("agentmsg_demo");
		expect(isAgentSessionMessagePrompt(withTime)).toBe(true);

		const lines = withTime.split("\n");
		expect(lines.indexOf("Composed: 2026-08-11T10:15:00.000Z")).toBeGreaterThan(
			lines.findIndex((line) => line.startsWith("Message id: ")),
		);
	});

	it("parses ids for senders with no relationship or sender block", () => {
		const bare = createAgentSessionMessagePrompt(
			payload({ composedAt: "2026-08-11T10:15:00.000Z", from: undefined, fromRelationship: undefined }),
		);

		expect(parseAgentSessionMessagePromptId(bare)).toBe("agentmsg_demo");
		expect(bare).toContain("Composed: 2026-08-11T10:15:00.000Z");
	});

	it("omits the line entirely when no compose time is known", () => {
		const prompt = createAgentSessionMessagePrompt(payload());

		expect(prompt).not.toContain("Composed:");
		// Unstamped messages keep the exact pre-existing wire text.
		expect(prompt).toBe(
			[
				"[from parent]",
				"Agent-to-agent message received.",
				"Source: agent_message",
				"From: lead, active active-parent, session parent-id",
				"To: worker, active active-child, session child-id",
				"Message id: agentmsg_demo",
				"",
				"Please inspect the latest result.",
			].join("\n"),
		);
	});

	it("carries the compose time into transcript details", () => {
		const stamped = createAgentSessionMessage(payload({ composedAt: "2026-08-11T10:15:00.000Z" }));
		const unstamped = createAgentSessionMessage(payload());

		expect(stamped.details).toMatchObject({ id: "agentmsg_demo", composedAt: "2026-08-11T10:15:00.000Z" });
		expect(unstamped.details).not.toHaveProperty("composedAt");
	});
});
