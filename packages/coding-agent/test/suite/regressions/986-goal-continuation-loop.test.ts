import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import {
	GOAL_CONTEXT_CUSTOM_TYPE,
	goalContinuationIsStalled,
	MAX_STALLED_GOAL_CONTINUATIONS,
} from "../../../src/core/goals.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

/**
 * Regression for https://github.com/PrimeIntellect-ai/prime-agent/issues/986.
 *
 * A goal whose continuations repeatedly produce no tool calls (the model is
 * blocked on user approval, credentials, or an unanswered question) must pause
 * as waiting for user input instead of injecting identical goal contexts
 * forever, and must resume when the user actually replies.
 *
 * Test design and fixtures are @romankhadka's from #1113 (closed, unmerged),
 * ported here against current main alongside the matching goals.ts /
 * agent-session.ts changes -- see that PR's final revision for the original.
 */

/**
 * Stand-in for the real ipython tool. `goal.*` cells are dispatched to the
 * session's goal host-request handler, mirroring the kernel comm bridge;
 * any other cell is a plain successful execution.
 */
function createFauxIpythonTool(sessionRef: { current?: AgentSession }): AgentTool {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python code in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId, params) => {
			const session = sessionRef.current;
			if (!session) {
				throw new Error("test session is not initialized");
			}
			const code = (params as { code: string }).code.trim();
			let text = "";
			if (code.startsWith("goal.")) {
				const spaceIndex = code.indexOf(" ");
				const type = spaceIndex < 0 ? code : code.slice(0, spaceIndex);
				const payload = spaceIndex < 0 ? {} : JSON.parse(code.slice(spaceIndex + 1));
				text = JSON.stringify(session.handleGoalHostRequest(type, payload));
			}
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	};
}

function goalContextMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === GOAL_CONTEXT_CUSTOM_TYPE,
	);
}

function fauxGoalContext(): AgentMessage {
	return {
		role: "custom",
		customType: GOAL_CONTEXT_CUSTOM_TYPE,
		content: "<goal_context>continue</goal_context>",
		display: true,
		timestamp: 0,
	};
}

function waitingReplies(count: number, text: string) {
	return Array.from({ length: count }, () => fauxAssistantMessage(text));
}

describe("regression #986: goal continuation loop", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createGoalHarness(options: { initialGoal?: { objective: string } } = {}): Promise<Harness> {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			initialGoal: options.initialGoal,
		});
		sessionRef.current = harness.session;
		harnesses.push(harness);
		return harness;
	}

	async function createStallPausedHarness(): Promise<Harness> {
		const harness = await createGoalHarness();
		harness.setResponses(waitingReplies(MAX_STALLED_GOAL_CONTINUATIONS, "Still waiting for approval."));
		await harness.session.prompt("/goal ship the release after approval");
		expect(harness.session.goalState).toMatchObject({ status: "paused", pausedBy: "host" });
		return harness;
	}

	it("pauses the goal as waiting for user input after repeated continuations without tool calls", async () => {
		const harness = await createGoalHarness();
		harness.setResponses(
			waitingReplies(MAX_STALLED_GOAL_CONTINUATIONS, "State unchanged: still waiting for the sandbox key."),
		);

		await harness.session.prompt("/goal run the evidence harness once the sandbox key arrives");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "paused",
			pausedBy: "host",
			continuationsUsed: MAX_STALLED_GOAL_CONTINUATIONS - 1,
		});
		expect(harness.session.goalState.lastReason).toContain("Waiting for user input");
		// Initial context plus the allowed continuations; the loop must not run on.
		expect(goalContextMessages(harness)).toHaveLength(MAX_STALLED_GOAL_CONTINUATIONS);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resets the stall window when a continuation turn makes a tool call", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			...waitingReplies(MAX_STALLED_GOAL_CONTINUATIONS - 1, "Still thinking."),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "print('working')" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Ran the script; waiting for review."),
			...waitingReplies(MAX_STALLED_GOAL_CONTINUATIONS, "State unchanged: waiting for review."),
		]);

		await harness.session.prompt("/goal run the script and wait for review");

		expect(harness.session.goalState).toMatchObject({
			status: "paused",
			pausedBy: "host",
		});
		// The tool-call turn resets the stall count, so a full round of toolless
		// continuations is needed again before the goal pauses.
		expect(goalContextMessages(harness)).toHaveLength(MAX_STALLED_GOAL_CONTINUATIONS * 2);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resumes a stall-paused goal on the next user prompt and keeps continuing", async () => {
		const harness = await createStallPausedHarness();

		harness.appendResponses([
			fauxAssistantMessage("Approval received, shipping."),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "goal.complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Shipped."),
		]);

		await harness.session.prompt("Approved, go ahead.");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			lastReason: "Goal achieved",
		});
		// The user prompt reactivated continuations: one more goal context was
		// injected after the reply before the model completed the goal.
		expect(goalContextMessages(harness)).toHaveLength(MAX_STALLED_GOAL_CONTINUATIONS + 1);
		const statusHistory = harness.eventsOfType("goal_update").map((event) => event.goal.status);
		expect(statusHistory.indexOf("paused")).toBeGreaterThanOrEqual(0);
		expect(statusHistory.lastIndexOf("active")).toBeGreaterThan(statusHistory.indexOf("paused"));
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resumes a stall-paused goal for user input delivered via followUp", async () => {
		const harness = await createStallPausedHarness();

		harness.appendResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "goal.complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Shipped."),
		]);

		await harness.session.followUp("Approved, go ahead.", undefined, { resumeIfIdle: true });
		await harness.session.waitForSessionInputIdle();

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			lastReason: "Goal achieved",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not resume an explicitly paused goal on a user prompt", async () => {
		const harness = await createGoalHarness({ initialGoal: { objective: "hold until told otherwise" } });
		await harness.session.prompt("/goal pause");
		expect(harness.session.goalState).toMatchObject({ status: "paused", pausedBy: "user" });

		harness.setResponses([fauxAssistantMessage("Hello!")]);
		await harness.session.prompt("Hi there.");

		expect(harness.session.goalState).toMatchObject({ status: "paused", pausedBy: "user" });
		expect(goalContextMessages(harness)).toHaveLength(0);
		expect(getAssistantTexts(harness)).toEqual(["Hello!"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("detects stalled continuation windows only when they are consecutive and trailing", () => {
		const text = () => fauxAssistantMessage("no progress");
		const toolCall = () =>
			fauxAssistantMessage(fauxToolCall("ipython", { code: "print('x')" }), { stopReason: "toolUse" });
		const userReply: AgentMessage = { role: "user", content: "new information", timestamp: 0 };

		const stalledRun = Array.from({ length: MAX_STALLED_GOAL_CONTINUATIONS }, () => [
			fauxGoalContext(),
			text(),
		]).flat();
		expect(goalContinuationIsStalled(stalledRun)).toBe(true);

		const oneWindowShort = stalledRun.slice(2);
		expect(goalContinuationIsStalled(oneWindowShort)).toBe(false);

		const userInLastWindow = [...stalledRun, userReply];
		expect(goalContinuationIsStalled(userInLastWindow)).toBe(false);

		const toolCallInMiddleWindow = [
			fauxGoalContext(),
			text(),
			fauxGoalContext(),
			toolCall(),
			fauxGoalContext(),
			text(),
		];
		expect(goalContinuationIsStalled(toolCallInMiddleWindow)).toBe(false);
	});
});
