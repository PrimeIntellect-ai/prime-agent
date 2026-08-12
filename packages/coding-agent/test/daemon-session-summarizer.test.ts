import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import type { AgentStatus } from "../src/core/session-manager.js";
import {
	agentStatusChanged,
	buildStatusContext,
	parseAgentStatusResponse,
} from "../src/modes/daemon/daemon-session-summarizer.js";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

function assistantMessage(text: string, tools: string[] = []): AgentMessage {
	const content = [{ type: "text", text }, ...tools.map((name) => ({ type: "tool_use", name, id: name, input: {} }))];
	return { role: "assistant", content, timestamp: 0 } as unknown as AgentMessage;
}

describe("daemon session summarizer", () => {
	describe("parseAgentStatusResponse", () => {
		test("parses recap and completion verdict for an idle session", () => {
			const result = parseAgentStatusResponse(
				"<recap>Added the API reference page</recap>\n<status>COMPLETED</status>",
				false,
			);
			expect(result).toEqual({ summary: "Added the API reference page", taskState: "completed" });
		});

		test("maps NEEDS_INPUT for idle sessions", () => {
			const result = parseAgentStatusResponse(
				"<recap>Asked which database to target</recap>\n<status>NEEDS_INPUT</status>",
				false,
			);
			expect(result?.taskState).toBe("needs_input");
		});

		test("omits the verdict while working and ignores any status tag", () => {
			const result = parseAgentStatusResponse(
				"<recap>Refactoring token validation</recap>\n<status>COMPLETED</status>",
				true,
			);
			expect(result).toEqual({ summary: "Refactoring token validation" });
		});

		test("does not fabricate needs_input from a missing or unrecognized idle verdict", () => {
			expect(
				parseAgentStatusResponse("<recap>Doing something</recap>\n<status>MAYBE</status>", false),
			).toBeUndefined();
			expect(parseAgentStatusResponse("<recap>Doing something</recap>", false)).toBeUndefined();
		});

		test("ignores narration outside the tags and never leaks free-form text", () => {
			// A chatty/reasoning model that narrates instead of using tags yields no recap.
			expect(parseAgentStatusResponse("Investigating the failing test.", true)).toBeUndefined();
			expect(
				parseAgentStatusResponse(
					"Recap: . So: <recap>Curating a niche list of Muon optimizer papers</recap>",
					true,
				),
			).toEqual({ summary: "Curating a niche list of Muon optimizer papers" });
		});

		test("ignores reasoning prose around the tags", () => {
			const text =
				"Let me decide. The agent finished editing.\n<recap>Updated the login handler</recap>\n<status>COMPLETED</status>";
			expect(parseAgentStatusResponse(text, false)).toEqual({
				summary: "Updated the login handler",
				taskState: "completed",
			});
		});

		test("rejects an echoed prompt template", () => {
			const echoed =
				"<recap>a present-tense clause, at most 12 words, no trailing period</recap>\n<status>COMPLETED</status>";
			expect(parseAgentStatusResponse(echoed, true)).toBeUndefined();
		});

		test("returns undefined when no recap tag is present", () => {
			expect(parseAgentStatusResponse("", false)).toBeUndefined();
			expect(parseAgentStatusResponse("<status>COMPLETED</status>", false)).toBeUndefined();
		});

		test("drops chain-of-thought that falls outside the closing recap tag", () => {
			const text =
				"<recap>Sending SSH auth retry to tcg-autoresearch-rl</recap> That's 5 words? Count: Sending(1) SSH(2) = 6 words.\n<status>NEEDS_INPUT</status>";
			expect(parseAgentStatusResponse(text, true)).toEqual({
				summary: "Sending SSH auth retry to tcg-autoresearch-rl",
			});
		});

		test("rejects a recap body that is nothing but counting artifacts", () => {
			expect(parseAgentStatusResponse("<recap>(1) word(2) count(3) = 3 words</recap>", true)).toBeUndefined();
		});

		test("rejects a rambling recap that blows past the word ceiling", () => {
			const text =
				"<recap>this is a very long rambling sentence that just keeps going and going well past any reasonable recap length</recap>";
			expect(parseAgentStatusResponse(text, true)).toBeUndefined();
		});

		test("strips wrapping quotes the model adds around the recap", () => {
			const text = '<recap>"Wiring the recap line"</recap>\n<status>COMPLETED</status>';
			expect(parseAgentStatusResponse(text, false)).toEqual({
				summary: "Wiring the recap line",
				taskState: "completed",
			});
		});

		test("ignores an open recap tag with no close", () => {
			expect(
				parseAgentStatusResponse("<recap>Editing the parser\n<status>NEEDS_INPUT</status>", true),
			).toBeUndefined();
		});

		test("takes the last recap tag when a draft is corrected", () => {
			const text = "<recap>Draft recap</recap>\n<recap>Final corrected recap</recap>";
			expect(parseAgentStatusResponse(text, true)).toEqual({ summary: "Final corrected recap" });
		});

		test("takes the last status tag when a draft is corrected", () => {
			const text = "<recap>Editing the parser</recap>\n<status>NEEDS_INPUT</status>\n<status>COMPLETED</status>";
			expect(parseAgentStatusResponse(text, false)?.taskState).toBe("completed");
		});

		test("normalizes unicode angle-bracket lookalikes around the tags", () => {
			// The model sometimes emits › ‹ instead of > < ; normalize so the tag still parses.
			const text = "‹recap›Curating a niche list of Muon optimizer papers‹/recap›";
			expect(parseAgentStatusResponse(text, true)).toEqual({
				summary: "Curating a niche list of Muon optimizer papers",
			});
		});
	});

	describe("buildStatusContext", () => {
		test("includes the agent state and the trailing conversation with tool names", () => {
			const context = buildStatusContext(
				[userMessage("add a login endpoint"), assistantMessage("Editing the router", ["Edit", "Bash"])],
				true,
			);
			expect(context).toContain("<agent-state>working</agent-state>");
			expect(context).toContain("user: add a login endpoint");
			expect(context).toContain("assistant: Editing the router [tools: Edit, Bash]");
		});

		test("marks idle sessions as finished", () => {
			expect(buildStatusContext([userMessage("hi")], false)).toContain("idle (finished its turn)");
		});

		test("only keeps the most recent messages", () => {
			const messages = Array.from({ length: 20 }, (_, i) => userMessage(`message ${i}`));
			const context = buildStatusContext(messages, false);
			expect(context).toContain("message 19");
			expect(context).not.toContain("message 0\n");
		});
	});

	describe("agentStatusChanged", () => {
		const base: AgentStatus = { summary: "Working on it", taskState: "needs_input", basedOnMessageCount: 4 };
		test("is true when there is no previous status", () => {
			expect(agentStatusChanged(undefined, { summary: "x" })).toBe(true);
		});
		test("detects summary and verdict changes", () => {
			expect(agentStatusChanged(base, { summary: "Working on it", taskState: "needs_input" })).toBe(false);
			expect(agentStatusChanged(base, { summary: "Done", taskState: "needs_input" })).toBe(true);
			expect(agentStatusChanged(base, { summary: "Working on it", taskState: "completed" })).toBe(true);
		});
	});
});
