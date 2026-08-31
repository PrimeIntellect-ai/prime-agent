import { existsSync } from "node:fs";
import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import type { ExtensionFactory } from "../../src/core/extensions/types.js";
import type { GoalHostResponse } from "../../src/core/goals.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";

function assistantWithUsage(message: string | AssistantMessage, usage: Partial<Usage>): AssistantMessage {
	const base = typeof message === "string" ? fauxAssistantMessage(message) : message;
	return {
		...base,
		usage: {
			...base.usage,
			...usage,
			cost: {
				...base.usage.cost,
				...usage.cost,
			},
		},
	};
}

function goalContextMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "goal_context",
	);
}

function visibleAssistantTexts(harness: Harness): string[] {
	return getAssistantTexts(harness).filter(Boolean);
}

function currentAgentContext(harness: Harness): AgentContext {
	const state = harness.session.agent.state;
	return {
		systemPrompt: state.systemPrompt,
		messages: [...state.messages],
		tools: [...state.tools],
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not met");
}

/**
 * Stand-in for the real ipython tool. Goal calls reach the host over the
 * kernel comm bridge while an ipython cell executes; this stub mirrors that
 * timing by dispatching `goal.*` host requests from inside tool execution.
 *
 * Cell format: `goal.<op>` optionally followed by a JSON payload, e.g.
 * `goal.create {"objective": "write a note"}`.
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

const COMPLETE_GOAL_CELL = { code: "goal.complete" };

function createWaitingTool(): {
	tool: AgentTool;
	release: () => void;
	waitForStart: (harness: Harness) => Promise<void>;
} {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			await new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				const abort = () => reject(new Error("aborted"));
				signal?.addEventListener("abort", abort, { once: true });
				toolRelease.then(() => {
					signal?.removeEventListener("abort", abort);
					resolve();
				});
			});
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
				terminate: true,
			};
		},
	};
	return {
		tool,
		release: () => releaseToolExecution?.(),
		waitForStart: (harness) =>
			new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "tool_execution_start" && event.toolName === "wait") {
						unsubscribe();
						resolve();
					}
				});
			}),
	};
}

describe("AgentSession goals", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createGoalHarness(extraTools: AgentTool[] = []): Promise<Harness> {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({ tools: [createFauxIpythonTool(sessionRef), ...extraTools] });
		sessionRef.current = harness.session;
		harnesses.push(harness);
		return harness;
	}

	it("keeps continuing until the model completes the goal through ipython", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("I need another step."),
			fauxAssistantMessage("The work is complete."),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(visibleAssistantTexts(harness)).toEqual([
			"I need another step.",
			"The work is complete.",
			"Goal complete.",
		]);
		expect(goalContextMessages(harness)).toHaveLength(3);
		expect(getMessageText(goalContextMessages(harness)[0])).toContain("<goal_context>");
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 2,
			lastReason: "Goal achieved",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("counts tokens from the goal completion turn", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{
					input: 4,
					output: 2,
					totalTokens: 6,
				},
			),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
		expect(harness.session.goalState.tokensUsed).toBeGreaterThan(0);
	});

	it("does not count post-completion turns against the finished goal", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{ input: 4, output: 2, totalTokens: 6 },
			),
			assistantWithUsage(
				"Goal complete; here is a long closing summary that must not be billed to the finished goal.",
				{ input: 20, output: 10, totalTokens: 30 },
			),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(harness.session.goalState.status).toBe("complete");
		const completeUpdates = harness.eventsOfType("goal_update").filter((event) => event.goal.status === "complete");
		expect(completeUpdates.length).toBeGreaterThan(0);
		const tokensAtCompletion = completeUpdates[0].goal.tokensUsed;
		expect(tokensAtCompletion).toBeGreaterThan(0);
		// The closing-summary turn runs after goal.complete() over the host bridge;
		// it must not increase the finished goal's token usage.
		expect(harness.session.goalState.tokensUsed).toBe(tokensAtCompletion);
	});

	it("returns the goal snapshot and completion report over the host bridge", async () => {
		const harness = await createGoalHarness();

		expect(harness.session.handleGoalHostRequest("goal.get")).toEqual({
			goal: null,
			remaining_tokens: null,
			completion_budget_report: null,
		});

		const created = harness.session.handleGoalHostRequest("goal.create", {
			objective: "write a benchmark note",
			token_budget: 50,
		});
		expect(created.goal).toMatchObject({
			objective: "write a benchmark note",
			status: "active",
			token_budget: 50,
			tokens_used: 0,
		});
		expect(created.remaining_tokens).toBe(50);

		const completed = harness.session.handleGoalHostRequest("goal.complete");
		expect(completed.goal).toMatchObject({ status: "complete" });
		expect(completed.completion_budget_report).toContain("tokens used: 0 of 50");
	});

	it("rejects malformed and unknown goal host requests", async () => {
		const harness = await createGoalHarness();

		expect(() => harness.session.handleGoalHostRequest("goal.create", {})).toThrow(
			"goal.create objective must be a string",
		);
		expect(() => harness.session.handleGoalHostRequest("goal.nonsense")).toThrow(
			'unknown goal request type "goal.nonsense"',
		);
		expect(() => harness.session.handleGoalHostRequest("goal.complete")).toThrow(
			"cannot complete goal because this thread has no goal",
		);

		harness.session.handleGoalHostRequest("goal.create", { objective: "first goal" });
		expect(() => harness.session.handleGoalHostRequest("goal.create", { objective: "second goal" })).toThrow(
			"already has an active goal",
		);
	});

	it("lets the model create a fresh goal after the previous one completed", async () => {
		const harness = await createGoalHarness();

		const first = harness.session.handleGoalHostRequest("goal.create", { objective: "first goal" });
		harness.session.handleGoalHostRequest("goal.complete");

		const second = harness.session.handleGoalHostRequest("goal.create", { objective: "second goal" });
		expect(second.goal).toMatchObject({ objective: "second goal", status: "active", tokens_used: 0 });
		expect(second.goal?.goal_id).not.toBe(first.goal?.goal_id);
		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
			objective: "second goal",
			continuationsUsed: 0,
		});
	});

	it("rejects goal.create while a goal is paused", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal long task");
		await waitForStart;
		await harness.session.prompt("/goal pause");
		waiting.release();
		await promptPromise;

		expect(harness.session.goalState.status).toBe("paused");
		expect(() => harness.session.handleGoalHostRequest("goal.create", { objective: "replacement" })).toThrow(
			"a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
		);
	});

	it("activates ipython when a slash goal starts from an inactive tool set", async () => {
		const harness = await createGoalHarness();
		harness.session.setActiveToolsByName([]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(harness.session.getActiveToolNames()).toEqual(["ipython"]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
	});

	it("adds ipython to the live continuation context when inactive at run start", async () => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });
		harness.session.setActiveToolsByName([]);
		harness.setResponses([
			fauxAssistantMessage("Still working."),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("continue");

		expect(visibleAssistantTexts(harness)).toEqual(["Still working.", "Goal complete."]);
		expect(harness.session.getActiveToolNames()).toEqual(["ipython"]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
	});

	it("does not re-add deactivated tools on runtime rebuild without an active goal", async () => {
		const harness = await createGoalHarness();
		expect(harness.session.getActiveToolNames()).toEqual(["ipython"]);

		harness.session.setActiveToolsByName([]);
		await harness.session.reload();

		expect(harness.session.getActiveToolNames()).toEqual([]);
	});

	it("keeps ipython active on active-goal runtime rebuild", async () => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });

		await harness.session.reload();

		expect(harness.session.getActiveToolNames()).toEqual(["ipython"]);
	});

	it("does not reject continuation when goal error update listeners throw", async () => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });
		harness.session.subscribe((event) => {
			if (event.type === "goal_update") {
				throw new Error("listener failed");
			}
		});
		harness.setResponses([fauxAssistantMessage("Still working.")]);

		await expect(harness.session.prompt("continue")).resolves.toBeUndefined();
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "error",
		});
	});

	it("does not infer completion from an assistant claim without goal.complete", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("Done."),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal write a greeting");

		expect(visibleAssistantTexts(harness)).toEqual(["Done.", "Goal complete."]);
		expect(goalContextMessages(harness)).toHaveLength(2);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 1,
		});
	});

	it("lets the model create a persistent goal through ipython", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ipython", { code: 'goal.create {"objective": "write a benchmark note"}' }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("Started the note."),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("Create a goal to write a benchmark note.");

		expect(visibleAssistantTexts(harness)).toEqual(["Started the note.", "Goal complete."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			objective: "write a benchmark note",
			continuationsUsed: 1,
		});
	});

	it("reloads goal state after tree navigation", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([fauxAssistantMessage("before goal")]);
		await harness.session.prompt("normal prompt");
		const beforeGoalEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!beforeGoalEntry) {
			throw new Error("expected assistant entry before goal");
		}

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);
		await harness.session.prompt("/goal finish the task");
		expect(harness.session.goalState.status).toBe("complete");

		await harness.session.navigateTree(beforeGoalEntry.id, { summarize: false });

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "idle",
		});
	});

	it("normalizes queued goal context text and images", async () => {
		const harness = await createGoalHarness();
		const image = { type: "image" as const, data: "image-data", mimeType: "image/png" };
		let preparedText: string | undefined;
		let preparedImages: unknown;
		harness.setResponses([fauxAssistantMessage("goal handled")]);
		vi.spyOn(harness.session.extensionRunner, "emitBeforeAgentStart").mockImplementationOnce(async (text, images) => {
			preparedText = text;
			preparedImages = images;
			return undefined;
		});

		await harness.session.prompt("/goal inspect the image", { images: [image] });

		expect(preparedText).toContain("<goal_context>");
		expect(preparedText).not.toContain("[object Object]");
		expect(preparedImages).toEqual([image]);
	});

	it("keeps active goals sticky across normal user prompts", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("answered the side question"),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("answer a side question", { streamingBehavior: "followUp" });
		waiting.release();
		await promptPromise;

		expect(visibleAssistantTexts(harness)).toEqual(["answered the side question", "Goal complete."]);
		expect(
			harness.session.messages.some((message) => getMessageText(message).includes("answer a side question")),
		).toBe(true);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 1,
		});
	});

	it.each([
		{ command: "/goal clear", status: "idle" },
		{ command: "/goal pause", status: "paused" },
	])("removes queued goal context after $command while streaming", async ({ command, status }) => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("stale goal response"),
		]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("start a blocking turn");
		await waitForStart;
		await harness.session.prompt("/goal stale goal");
		await harness.session.prompt(command);
		waiting.release();
		await promptPromise;

		expect(goalContextMessages(harness)).toHaveLength(0);
		expect(visibleAssistantTexts(harness)).toEqual([]);
		expect(harness.session.goalState.status).toBe(status);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("pauses an active goal with /goal pause", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("/goal pause");
		waiting.release();
		await promptPromise;

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "paused",
			lastReason: "Paused by user",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resumes a paused goal with /goal resume", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("/goal pause");
		waiting.release();
		await promptPromise;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);
		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 0,
		});
	});

	it("does not resume a completed goal", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.prompt("/goal finish the task");
		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not resume an errored goal", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.prompt("/goal do work");
		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "error",
		});
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("reports active goal elapsed time on status reads and goal.get", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const waiting = createWaitingTool();
			const harness = await createGoalHarness([waiting.tool]);
			harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

			const waitForStart = waiting.waitForStart(harness);
			const promptPromise = harness.session.prompt("/goal track elapsed time");
			await waitForStart;
			vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));

			expect(harness.session.goalState.timeUsedSeconds).toBe(5);
			const response: GoalHostResponse = harness.session.handleGoalHostRequest("goal.get");
			expect(response.goal?.time_used_seconds).toBe(5);

			await harness.session.prompt("/goal pause");
			waiting.release();
			await promptPromise;
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears a goal with /goal clear without consuming a provider response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt("/goal clear");

		expect(
			harness.session.messages.map((message) => (message.role === "custom" ? message.customType : message.role)),
		).toEqual(["session_slash_command", "session_slash_command_result"]);
		expect(harness.eventsOfType("goal_update").at(-1)?.goal.status).toBe("idle");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not persist a goal when start preflight fails", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await harness.session.prompt("/goal do task");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "idle",
		});
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "session_slash_command_result",
			details: { success: false },
		});
	});

	it("completes a goal whose completing turn crosses the budget without a stale budget-limit steer", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{ input: 6, output: 5, totalTokens: 11 },
			),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal --budget 10 finish the task");

		expect(visibleAssistantTexts(harness)).toEqual(["Goal complete."]);
		const contextKinds = goalContextMessages(harness).map(
			(message) => (message as { details?: { kind?: string } }).details?.kind,
		);
		expect(contextKinds).not.toContain("budget_limit");
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			tokenBudget: 10,
			lastReason: "Goal achieved",
		});
		expect(harness.session.goalState.tokensUsed).toBeGreaterThanOrEqual(10);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("marks an active goal budget_limited when token budget is reached", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			assistantWithUsage("Spent the budget.", { input: 6, output: 5, totalTokens: 11 }),
			fauxAssistantMessage("Wrapping up."),
		]);

		await harness.session.prompt("/goal --budget 10 do work");

		expect(visibleAssistantTexts(harness)).toEqual(["Spent the budget.", "Wrapping up."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "budget_limited",
			tokenBudget: 10,
			continuationsUsed: 0,
		});
		expect(harness.session.goalState.tokensUsed).toBeGreaterThanOrEqual(10);
	});

	it("checks goal budget before continuation while event processing is delayed", async () => {
		let releaseMessageEnd: (() => void) | undefined;
		const blockedMessageEnd = new Promise<void>((resolve) => {
			releaseMessageEnd = resolve;
		});
		let didBlock = false;
		const extension: ExtensionFactory = (pi) => {
			pi.on("message_end", async (event) => {
				if (event.message.role === "assistant" && !didBlock) {
					didBlock = true;
					await blockedMessageEnd;
				}
			});
		};
		const harness = await createHarness({ extensionFactories: [extension] });
		harnesses.push(harness);
		harness.setResponses([
			assistantWithUsage("Spent the budget.", { input: 6, output: 5, totalTokens: 11 }),
			fauxAssistantMessage("Wrapping up."),
			fauxAssistantMessage("Should not continue."),
		]);

		const promptPromise = harness.session.prompt("/goal --budget 10 do work");
		try {
			await waitForCondition(() => harness.session.goalState.status === "budget_limited");
		} finally {
			releaseMessageEnd?.();
		}
		await promptPromise;
		await harness.session.waitForIdle();
		await vi.waitFor(() => expect(visibleAssistantTexts(harness)).toHaveLength(2));

		expect(visibleAssistantTexts(harness)).toEqual(["Spent the budget.", "Wrapping up."]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "budget_limited",
			tokenBudget: 10,
			continuationsUsed: 0,
		});
	});

	it.each(["/goal --budget=1abc task", "/goal --budget 1.5 task", "/goal --budget 1e6 task"])(
		"rejects malformed goal budget %s",
		async (command) => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("unused")]);

			await harness.session.prompt(command);
			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "custom",
				customType: "session_slash_command_result",
				details: { success: false, error: "Goal token budget must be a positive integer." },
			});

			expect(harness.session.goalState).toMatchObject({
				active: false,
				status: "idle",
			});
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("marks the goal as errored on terminal provider errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("/goal do work");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "error",
			lastError: "invalid_api_key\n\nRun /login to update credentials.",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not continue when a terminal error reaches the continuation hook", async () => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });
		const errorMessage = fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" });

		const continuationMessages = await harness.session.agent.getContinuationMessages?.({
			message: errorMessage,
			toolResults: [],
			context: currentAgentContext(harness),
			newMessages: [errorMessage],
		});

		expect(continuationMessages).toEqual([]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "error",
			lastError: "invalid_api_key",
		});
	});

	it("keeps the goal active on aborted provider turns", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);

		await harness.session.prompt("/goal do work");

		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("lets the user abort a goal turn, prompt in between, then resume the goal", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.abort();
		await promptPromise;

		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
		});

		harness.setResponses([
			fauxAssistantMessage("answered the interjection"),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("answer this before continuing the goal");

		expect(visibleAssistantTexts(harness)).toEqual(["answered the interjection", "Goal complete."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
	});

	it("reports status without consuming a provider response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt("/goal status");

		expect(
			harness.session.messages.map((message) => (message.role === "custom" ? message.customType : message.role)),
		).toEqual(["session_slash_command", "session_slash_command_result"]);
		expect(harness.eventsOfType("goal_update").at(-1)?.goal.status).toBe("idle");
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});

describe("initial goal seeding from config", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("seeds an active goal from initialGoal config on a fresh top-level session", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "Write tests", tokenBudget: 50000 },
		});
		harnesses.push(harness);

		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
			objective: "Write tests",
			tokenBudget: 50000,
		});

		// Goal is persisted before first prompt
		const { GOAL_STATE_CUSTOM_TYPE } = await import("../../src/core/goals.js");
		const branch = harness.sessionManager.getBranch();
		const goalEntry = branch.find((e) => e.type === "custom" && e.customType === GOAL_STATE_CUSTOM_TYPE);
		expect(goalEntry).toBeDefined();

		// The seeded goal context must reach the model before its first reply.
		harness.setResponses([fauxAssistantMessage("ack")]);
		await harness.session.prompt("hello");
		const messages = harness.session.messages;
		const firstContextIndex = messages.findIndex(
			(message) => message.role === "custom" && message.customType === "goal_context",
		);
		const firstAssistantIndex = messages.findIndex((message) => message.role === "assistant");
		expect(firstContextIndex).toBeGreaterThanOrEqual(0);
		expect(firstContextIndex).toBeLessThan(firstAssistantIndex);
		expect(getMessageText(messages[firstContextIndex])).toContain("Write tests");
		expect(currentAgentContext(harness).messages).toContain(messages[firstContextIndex]);
	});

	it("drops the seeded goal context when the goal is cleared before the first prompt", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "Write tests", tokenBudget: 50000 },
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("ack")]);
		await harness.session.prompt("/goal clear");
		expect(harness.session.goalState.status).toBe("idle");
		await harness.session.prompt("hello");
		expect(goalContextMessages(harness)).toHaveLength(0);
	});

	it("does not seed initialGoal for subagent sessions (rlmDepth > 0)", async () => {
		const harness = await createHarness({
			persistSession: true,
			rlmDepth: 1,
			initialGoal: { objective: "Subagent goal" },
		});
		harnesses.push(harness);

		expect(harness.session.goalState.status).toBe("idle");
		expect(harness.session.goalState.active).toBe(false);
	});

	function createRestartSession(harness: Harness): AgentSession {
		const sessionFile = harness.sessionManager.getSessionFile()!;
		expect(existsSync(sessionFile)).toBe(true);
		const newSessionManager = SessionManager.open(sessionFile);

		// Assert the reopened branch contains a thread_goal_state custom entry
		// before constructing the new AgentSession. This proves the goal was
		// persisted to disk.
		const reopenedBranch = newSessionManager.getBranch();
		const goalEntries = reopenedBranch.filter(
			(e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "thread_goal_state",
		);
		expect(goalEntries.length).toBeGreaterThan(0);

		const model = harness.getModel();
		const newAuth = AuthStorage.inMemory();
		newAuth.setRuntimeApiKey(model.provider, "faux-key");
		const newRegistry = ModelRegistry.inMemory(newAuth);
		const newSettings = SettingsManager.inMemory();

		const newAgent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model,
				systemPrompt: "You are a test assistant.",
				tools: [],
			},
		});

		return new AgentSession({
			agent: newAgent,
			sessionManager: newSessionManager,
			settingsManager: newSettings,
			cwd: harness.tempDir,
			modelRegistry: newRegistry,
			resourceLoader: createTestResourceLoader(),
			rlmDepth: 0,
			initialGoal: { objective: "Should not reseed" },
		});
	}

	it("does not reseed after goal is cleared (idempotent restart)", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "Initial goal" },
		});
		harnesses.push(harness);

		expect(harness.session.goalState.status).toBe("active");

		// Clear the goal via /goal clear (slash command)
		harness.setResponses([fauxAssistantMessage("unused")]);
		await harness.session.prompt("/goal clear");
		expect(harness.session.goalState.status).toBe("idle");

		// Simulate restart: reopen the same session file
		const newSession = createRestartSession(harness);

		// Goal should remain idle (cleared), not reseeded
		expect(newSession.goalState.status).toBe("idle");
		expect(newSession.goalState.objective).toBeUndefined();
		newSession.dispose();
	});

	it("does not reseed after goal is completed (idempotent restart)", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "Complete me" },
		});
		harnesses.push(harness);

		expect(harness.session.goalState.status).toBe("active");

		// Complete the goal via host request
		harness.session.handleGoalHostRequest("goal.complete");
		expect(harness.session.goalState.status).toBe("complete");

		// Simulate restart on the same session file
		const newSession = createRestartSession(harness);

		// Goal should remain complete, not reseeded
		expect(newSession.goalState.status).toBe("complete");
		expect(newSession.goalState.objective).toBe("Complete me");
		newSession.dispose();
	});

	it("does not reseed when branch has messages (idempotent restart after use)", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "Initial goal" },
		});
		harnesses.push(harness);

		expect(harness.session.goalState.status).toBe("active");

		// Append user and assistant messages directly via sessionManager
		// to avoid triggering autonomous goal continuation loop.
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "do something" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		// Simulate restart on the same session file
		const newSession = createRestartSession(harness);

		// Goal should be the persisted active goal, not the new initialGoal
		expect(newSession.goalState.status).toBe("active");
		expect(newSession.goalState.objective).toBe("Initial goal");
		newSession.dispose();
	});
});
