import { existsSync } from "node:fs";
import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import type { ExtensionFactory } from "../../src/core/extensions/types.js";
import { GOAL_STATE_CUSTOM_TYPE } from "../../src/core/goals.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";
import {
	conversationMessages,
	createHarness,
	getAssistantTexts,
	getMessageText,
	type Harness,
	type HarnessOptions,
} from "./harness.js";

function assistantWithUsage(message: string | AssistantMessage, usage: Partial<Usage>): AssistantMessage {
	const base = typeof message === "string" ? fauxAssistantMessage(message) : message;
	return {
		...base,
		usage: { ...base.usage, ...usage, cost: { ...base.usage.cost, ...usage.cost } },
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
			return { content: [{ type: "text", text }], details: {} };
		},
	};
}

const COMPLETE_GOAL_CELL = { code: "goal.complete" };

function completeGoalResponses(): AssistantMessage[] {
	return [
		fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
		fauxAssistantMessage("Goal complete."),
	];
}

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
			return { content: [{ type: "text", text: "released" }], details: {}, terminate: true };
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

	async function createGoalHarness(
		extraTools: AgentTool[] = [],
		settings?: HarnessOptions["settings"],
	): Promise<Harness> {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({ tools: [createFauxIpythonTool(sessionRef), ...extraTools], settings });
		sessionRef.current = harness.session;
		harnesses.push(harness);
		return harness;
	}

	it("keeps continuing until the model completes the goal through ipython", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("I need another step."),
			fauxAssistantMessage("The work is complete."),
			...completeGoalResponses(),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(visibleAssistantTexts(harness)).toEqual([
			"I need another step.",
			"The work is complete.",
			"Goal complete.",
		]);
		expect(goalContextMessages(harness)).toHaveLength(3);
		expect(getMessageText(goalContextMessages(harness)[0])).toMatch(/^\[goal: continuation\]\n\n/);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 2,
			lastReason: "Goal achieved",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("returns goal snapshots over the host bridge and allows a fresh goal after completion", async () => {
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

		const second = harness.session.handleGoalHostRequest("goal.create", { objective: "second goal" });
		expect(second.goal).toMatchObject({ objective: "second goal", status: "active", tokens_used: 0 });
		expect(second.goal?.goal_id).not.toBe(created.goal?.goal_id);
		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
			objective: "second goal",
			continuationsUsed: 0,
		});
	});

	it.each([
		{
			name: "goal.create without an objective",
			type: "goal.create",
			payload: {},
			active: false,
			error: "goal.create objective must be a string",
		},
		{
			name: "an unknown request type",
			type: "goal.nonsense",
			payload: {},
			active: false,
			error: 'unknown goal request type "goal.nonsense"',
		},
		{
			name: "goal.complete without a goal",
			type: "goal.complete",
			payload: {},
			active: false,
			error: "cannot complete goal because this thread has no goal",
		},
		{
			name: "goal.create while a goal is active",
			type: "goal.create",
			payload: { objective: "second" },
			active: true,
			error: "already has an active goal",
		},
	])("rejects $name", async ({ type, payload, active, error }) => {
		const harness = await createGoalHarness();
		if (active) {
			harness.session.handleGoalHostRequest("goal.create", { objective: "first goal" });
		}

		expect(() => harness.session.handleGoalHostRequest(type, payload)).toThrow(error);
	});

	it("does not count post-completion turns against the finished goal", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{ input: 4, output: 2, totalTokens: 6 },
			),
			assistantWithUsage("Goal complete; here is a long closing summary.", {
				input: 20,
				output: 10,
				totalTokens: 30,
			}),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(harness.session.goalState.status).toBe("complete");
		const completeUpdates = harness.eventsOfType("goal_update").filter((event) => event.goal.status === "complete");
		const tokensAtCompletion = completeUpdates[0]?.goal.tokensUsed ?? 0;
		expect(tokensAtCompletion).toBeGreaterThan(0);
		// The closing-summary turn runs after goal.complete() over the host bridge;
		// it must not increase the finished goal's token usage.
		expect(harness.session.goalState.tokensUsed).toBe(tokensAtCompletion);
	});

	it.each([
		{ name: "without an active goal", withGoal: false, expected: [] as string[] },
		{ name: "with an active goal", withGoal: true, expected: ["ipython"] },
	])("runtime rebuild restores tools $name", async ({ withGoal, expected }) => {
		const harness = await createGoalHarness();
		if (withGoal) {
			harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });
		} else {
			harness.session.setActiveToolsByName([]);
		}

		await harness.session.reload();

		expect(harness.session.getActiveToolNames()).toEqual(expected);
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

		harness.setResponses(completeGoalResponses());
		await harness.session.prompt("/goal finish the task");
		expect(harness.session.goalState.status).toBe("complete");

		await harness.session.navigateTree(beforeGoalEntry.id, { summarize: false });

		expect(harness.session.goalState).toMatchObject({ active: false, status: "idle" });
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

	it("pauses a goal, rejects a replacement, then resumes it with /goal resume", async () => {
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
		expect(() => harness.session.handleGoalHostRequest("goal.create", { objective: "replacement" })).toThrow(
			"a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
		);

		harness.setResponses(completeGoalResponses());
		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 0,
		});
	});

	it.each([
		{
			name: "completed",
			status: "complete",
			start: async (harness: Harness) => {
				harness.setResponses([...completeGoalResponses(), fauxAssistantMessage("should not run")]);
				await harness.session.prompt("/goal finish the task");
			},
			expected: {},
		},
		{
			name: "errored",
			status: "error",
			start: async (harness: Harness) => {
				harness.setResponses([
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
					fauxAssistantMessage("should not run"),
				]);
				await harness.session.prompt("/goal do work");
			},
			expected: { lastError: "invalid_api_key\n\nRun /login to update credentials." },
		},
	])("does not resume a $name goal", async ({ status, start, expected }) => {
		const harness = await createGoalHarness([], { retry: { enabled: false } });
		await start(harness);

		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({ active: false, status, ...expected });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["/goal clear", "/goal status"])("runs %s without consuming a provider response", async (command) => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt(command);

		expect(
			conversationMessages(harness.session).map((message) =>
				message.role === "custom" ? message.customType : message.role,
			),
		).toEqual(["session_slash_command", "session_slash_command_result"]);
		expect(harness.eventsOfType("goal_update").at(-1)?.goal.status).toBe("idle");
		expect(harness.getPendingResponseCount()).toBe(1);
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
			expect(harness.session.goalState).toMatchObject({ active: false, status: "idle" });
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("does not persist a goal when start preflight fails", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await harness.session.prompt("/goal do task");

		expect(harness.session.goalState).toMatchObject({ active: false, status: "idle" });
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
		expect(harness.getPendingResponseCount()).toBe(0);
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

		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "budget_limited",
			tokenBudget: 10,
			continuationsUsed: 0,
		});
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

		// An aborted provider turn leaves the goal active.
		expect(harness.session.goalState).toMatchObject({ active: true, status: "active" });

		harness.setResponses([fauxAssistantMessage("answered the interjection"), ...completeGoalResponses()]);
		await harness.session.prompt("answer this before continuing the goal");

		expect(visibleAssistantTexts(harness)).toEqual(["answered the interjection", "Goal complete."]);
		expect(harness.session.goalState).toMatchObject({ active: false, status: "complete" });
	});
});

describe("initial goal seeding from config", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/** Reopen the persisted session file with a fresh AgentSession, as a restart does. */
	function createRestartSession(harness: Harness): AgentSession {
		const sessionFile = harness.sessionManager.getSessionFile()!;
		expect(existsSync(sessionFile)).toBe(true);
		const newSessionManager = SessionManager.open(sessionFile);
		const model = harness.getModel();
		const newAuth = AuthStorage.inMemory();
		newAuth.setRuntimeApiKey(model.provider, "faux-key");

		return new AgentSession({
			agent: new Agent({
				getApiKey: () => "faux-key",
				initialState: { model, systemPrompt: "You are a test assistant.", tools: [] },
			}),
			sessionManager: newSessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: harness.tempDir,
			modelRegistry: ModelRegistry.inMemory(newAuth),
			resourceLoader: createTestResourceLoader(),
			rlmDepth: 0,
			initialGoal: { objective: "Should not reseed" },
		});
	}

	it("seeds and persists an active goal from initialGoal config on a fresh top-level session", async () => {
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
		// The goal reaches disk before the first prompt.
		expect(
			harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE),
		).toBeDefined();

		// The seeded goal context must reach the model before its first reply.
		harness.setResponses([fauxAssistantMessage("ack")]);
		await harness.session.prompt("hello");
		const messages = harness.session.messages;
		const firstContextIndex = messages.findIndex(
			(message) => message.role === "custom" && message.customType === "goal_context",
		);
		expect(firstContextIndex).toBeGreaterThanOrEqual(0);
		expect(firstContextIndex).toBeLessThan(messages.findIndex((message) => message.role === "assistant"));
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

		expect(harness.session.goalState).toMatchObject({ status: "idle", active: false });
	});

	it.each([
		{
			name: "cleared",
			objective: "Initial goal",
			prepare: async (harness: Harness) => {
				harness.setResponses([fauxAssistantMessage("unused")]);
				await harness.session.prompt("/goal clear");
				expect(harness.session.goalState.status).toBe("idle");
			},
			expected: { status: "idle", objective: undefined },
		},
		{
			name: "completed",
			objective: "Complete me",
			prepare: async (harness: Harness) => {
				harness.session.handleGoalHostRequest("goal.complete");
			},
			expected: { status: "complete", objective: "Complete me" },
		},
		{
			name: "used (the branch already has messages)",
			objective: "Initial goal",
			prepare: async (harness: Harness) => {
				// Append directly so no autonomous goal continuation runs.
				harness.sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "do something" }],
					timestamp: Date.now(),
				});
			},
			expected: { status: "active", objective: "Initial goal" },
		},
	])(
		"does not reseed initialGoal after the goal was $name (idempotent restart)",
		async ({ objective, prepare, expected }) => {
			const harness = await createHarness({ persistSession: true, initialGoal: { objective } });
			harnesses.push(harness);
			expect(harness.session.goalState.status).toBe("active");

			await prepare(harness);
			const restarted = createRestartSession(harness);

			try {
				expect(restarted.goalState.status).toBe(expected.status);
				expect(restarted.goalState.objective).toBe(expected.objective);
			} finally {
				restarted.dispose();
			}
		},
	);
});
