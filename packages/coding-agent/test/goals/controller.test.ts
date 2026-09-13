import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { emptyGoalState, type GoalState } from "../../src/core/goals.js";
import { GoalController } from "../../src/goals/controller.js";

function createController(initial = emptyGoalState()) {
	let persisted = initial;
	const save = vi.fn((goal: GoalState) => {
		persisted = goal;
	});
	const onUpdate = vi.fn();
	let now = 1_000;
	const goals = new GoalController({ load: () => persisted, save }, onUpdate, () => now);
	goals.restartAccounting();
	return {
		goals,
		save,
		onUpdate,
		persisted: () => persisted,
		setTime: (time: number) => {
			now = time;
		},
	};
}

function assistant(input: number, output: number, stopReason: AssistantMessage["stopReason"] = "stop") {
	const message = fauxAssistantMessage("step", { stopReason });
	return { ...message, usage: { ...message.usage, input, output, cacheRead: 100, cacheWrite: 100 } };
}

describe("GoalController", () => {
	it("counts active time across pause and resume without persisting status reads", () => {
		const { goals, save, setTime } = createController();
		goals.start("finish the task", undefined);
		setTime(6_500);
		expect(goals.current.timeUsedSeconds).toBe(5);
		expect(save).toHaveBeenCalledTimes(1);
		goals.pause();
		setTime(60_000);
		expect(goals.current.timeUsedSeconds).toBe(5);
		expect(goals.resume()).toBe(true);
		setTime(63_000);
		expect(goals.current.timeUsedSeconds).toBe(8);
		const visible = goals.current;
		visible.tokensUsed = 999;
		expect(goals.current.tokensUsed).toBe(0);
	});

	it("counts each assistant message once and excludes cached tokens", () => {
		const { goals } = createController();
		goals.start("finish the task", 10);
		const first = assistant(4, 2);
		expect(goals.accountAssistantMessage(first)).toBe(false);
		expect(goals.accountAssistantMessage(first)).toBe(false);
		expect(goals.current.tokensUsed).toBe(6);
		expect(goals.accountAssistantMessage(assistant(3, 2))).toBe(true);
		expect(goals.current).toMatchObject({ status: "budget_limited", tokensUsed: 11 });
		expect(goals.resume()).toBe(false);
	});

	it("keeps completion usage and clears queued context before persisting completion", () => {
		const { goals, persisted } = createController();
		goals.start("finish the task", 10);
		goals.accountAssistantMessage(assistant(6, 5, "toolUse"));
		const clearQueuedContexts = vi.fn(() => {
			expect(persisted().status).toBe("budget_limited");
		});
		goals.complete(clearQueuedContexts);
		expect(clearQueuedContexts).toHaveBeenCalledOnce();
		goals.accountAssistantMessage(assistant(20, 10));
		expect(persisted()).toMatchObject({ status: "complete", tokensUsed: 11 });
		expect(goals.resume()).toBe(false);
	});

	it("excludes aborted and errored messages, and accounts time on terminal failure", () => {
		const { goals, setTime } = createController();
		goals.start("finish the task", undefined);
		expect(goals.accountAssistantMessage(assistant(3, 2, "error"))).toBe(false);
		expect(goals.accountAssistantMessage(assistant(3, 2, "aborted"))).toBe(false);
		setTime(4_000);
		goals.fail("provider failed");
		setTime(9_000);
		expect(goals.current).toMatchObject({ status: "error", tokensUsed: 0, timeUsedSeconds: 3 });
		expect(goals.resume()).toBe(false);
	});

	it("restores the continuation count and accounting clock when admission loses a race", () => {
		const { goals, persisted, setTime } = createController();
		goals.start("finish the task", undefined);
		const checkpoint = goals.checkpoint();
		setTime(6_000);
		goals.recordContinuation();
		goals.pause();
		goals.restore(checkpoint);
		setTime(8_000);
		expect(goals.current).toMatchObject({ status: "active", continuationsUsed: 0, timeUsedSeconds: 7 });
		expect(persisted().continuationsUsed).toBe(0);
	});

	it("reloads the selected branch without counting time spent away", () => {
		const { goals, save, setTime } = createController();
		goals.start("first branch", undefined);
		goals.accountAssistantMessage(assistant(2, 3));
		const firstBranch = goals.current;
		goals.start("second branch", undefined);
		setTime(50_000);
		save(firstBranch);
		goals.reload();
		setTime(52_000);
		expect(goals.current).toMatchObject({ objective: "first branch", tokensUsed: 5, timeUsedSeconds: 2 });
	});

	it("does not publish a successful update when persistence fails", () => {
		const { goals, save, onUpdate } = createController();
		goals.start("finish the task", undefined);
		onUpdate.mockClear();
		save.mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		expect(() => goals.pause()).toThrow("disk full");
		expect(onUpdate).not.toHaveBeenCalled();
	});
});
