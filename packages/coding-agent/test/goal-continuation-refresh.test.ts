import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { createGoalContextMessage, type GoalContextKind, type GoalState } from "../src/core/goals.js";
import type { CustomMessage } from "../src/core/messages.js";

type Harness = {
	_goalState: GoalState;
};

const refresh = Reflect.get(AgentSession.prototype, "_refreshGoalContextMessageAtDelivery") as (
	this: Harness,
	message: AgentMessage,
) => void;

function goalState(overrides: Partial<GoalState> = {}): GoalState {
	return {
		active: true,
		goalId: "goal-1",
		objective: "ship the artifact",
		status: "active",
		tokensUsed: 1_000,
		timeUsedSeconds: 10,
		continuationsUsed: 1,
		createdAt: 1_757_500_000_000,
		updatedAt: 1_757_500_000_000,
		...overrides,
	};
}

function frozenMessage(at: GoalState, kind: GoalContextKind): CustomMessage {
	// Build with the real constructor so the wire format is exercised.
	return createGoalContextMessage(at, kind) as unknown as CustomMessage;
}

function textOf(message: CustomMessage): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("\n");
}

describe("goal continuation delivery-time refresh", () => {
	it("refreshes stale accounting in place, preserving message identity", () => {
		const mode: Harness = { _goalState: goalState({ tokensUsed: 401_869, continuationsUsed: 4 }) };
		const frozen = frozenMessage(goalState({ tokensUsed: 358_712, continuationsUsed: 3 }), "continuation");
		expect(textOf(frozen)).toContain("tokens used: 358712");

		refresh.call(mode, frozen as unknown as AgentMessage);

		expect(textOf(frozen)).toContain("tokens used: 401869");
		expect(textOf(frozen)).not.toContain("tokens used: 358712");
		expect((frozen.details as { continuationsUsed: number }).continuationsUsed).toBe(4);
	});

	it("keeps images from the queued message while refreshing the text", () => {
		const mode: Harness = { _goalState: goalState({ tokensUsed: 9_000 }) };
		const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } as const;
		const frozen = createGoalContextMessage(goalState({ tokensUsed: 1_000 }), "continuation", [
			image as never,
		]) as unknown as CustomMessage;

		refresh.call(mode, frozen as unknown as AgentMessage);

		const blocks = frozen.content as Array<{ type: string }>;
		expect(blocks.some((block) => block.type === "image")).toBe(true);
		expect(textOf(frozen)).toContain("tokens used: 9000");
	});

	it("leaves the message untouched when the goal id no longer matches", () => {
		const mode: Harness = { _goalState: goalState({ goalId: "goal-2", tokensUsed: 9_000 }) };
		const frozen = frozenMessage(goalState({ tokensUsed: 1_000 }), "continuation");

		refresh.call(mode, frozen as unknown as AgentMessage);

		expect(textOf(frozen)).toContain("tokens used: 1000");
	});

	it("leaves the message untouched when the goal is no longer active", () => {
		const mode: Harness = { _goalState: goalState({ status: "paused", active: false }) };
		const frozen = frozenMessage(goalState({ tokensUsed: 1_000 }), "continuation");

		refresh.call(mode, frozen as unknown as AgentMessage);

		expect(textOf(frozen)).toContain("tokens used: 1000");
	});

	it("never refreshes budget_limit or objective_updated kinds", () => {
		const mode: Harness = { _goalState: goalState({ tokensUsed: 9_000 }) };
		const budget = frozenMessage(goalState({ tokensUsed: 1_000 }), "budget_limit");
		const updated = frozenMessage(
			goalState({ tokensUsed: 1_000, objective: "older objective" }),
			"objective_updated",
		);

		refresh.call(mode, budget as unknown as AgentMessage);
		refresh.call(mode, updated as unknown as AgentMessage);

		expect(textOf(budget)).toContain("1000");
		expect(textOf(updated)).toContain("1000");
		expect(textOf(updated)).toContain("older objective");
	});

	it("ignores non-goal-context messages", () => {
		const mode: Harness = { _goalState: goalState() };
		const other: CustomMessage = {
			role: "custom",
			customType: "unrelated_type",
			content: "frozen",
			display: true,
			timestamp: 1,
		};

		expect(() => refresh.call(mode, other as unknown as AgentMessage)).not.toThrow();
		expect(other.content).toBe("frozen");
	});
});
