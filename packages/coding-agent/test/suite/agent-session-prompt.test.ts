import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { BashResult } from "../../src/core/bash-executor.js";
import {
	convertToLlm,
	createCompactionSummaryMessage,
	createHarnessDigestMessage,
	HARNESS_DIGEST_CUSTOM_TYPE,
	HARNESS_DIGEST_PREFIX,
	HARNESS_DIGEST_SUFFIX,
	REFINEMENT_NOTICE_CUSTOM_TYPE,
} from "../../src/core/messages.js";
import type { PromptTemplate } from "../../src/core/prompt-templates.js";
import { getLocalHarnessStateDir, loadHarnessState, saveHarnessState } from "../../src/core/refinement/index.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.js";
import { createDeferred, createWaitingHarness } from "./scheduling.js";

function gateNextAgentStart(harness: Harness): { reached: Promise<void>; release(): void } {
	let markReached = () => {};
	const reached = new Promise<void>((resolve) => {
		markReached = resolve;
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let unsubscribe = () => {};
	unsubscribe = harness.session.agent.subscribe(async (event) => {
		if (event.type !== "agent_start") return;
		unsubscribe();
		markReached();
		await gate;
	});
	return { reached, release };
}

describe("AgentSession prompt characterization", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("admits concurrent idle prompts in FIFO order with only the waiting action queued", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const firstResponse = createDeferred();
		const secondResponse = createDeferred();
		harness.setResponses([
			async () => {
				await firstResponse.promise;
				return fauxAssistantMessage("first done");
			},
			async () => {
				await secondResponse.promise;
				return fauxAssistantMessage("second done");
			},
		]);

		const first = harness.session.prompt("first");
		let secondSettled = false;
		const second = harness.session.prompt("second").then(() => {
			secondSettled = true;
		});

		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(secondSettled).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.queuedActionCount).toBe(0);

		firstResponse.resolve();
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual(["first", "second"]));
		expect(secondSettled).toBe(false);
		secondResponse.resolve();
		await Promise.all([first, second]);
	});

	it("preserves idle prompt order while the first input handler is pending", async () => {
		const firstInputReached = createDeferred();
		const firstInputGate = createDeferred();
		const inputOrder: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						inputOrder.push(event.text);
						if (event.text === "first") {
							firstInputReached.resolve();
							await firstInputGate.promise;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);

		const first = harness.session.prompt("first");
		await firstInputReached.promise;
		const second = harness.session.prompt("second");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(inputOrder).toEqual(["first"]);

		firstInputGate.resolve();
		await Promise.all([first, second]);
		expect(inputOrder).toEqual(["first", "second"]);
		expect(getUserTexts(harness)).toEqual(["first", "second"]);
	});

	it("admits reentrant hook prompts without deadlocking the active action", async () => {
		let submitted = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						if (submitted) return;
						submitted = true;
						await harness.session.promptUntilAccepted("from hook", {
							expandPromptTemplates: false,
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("outer done"), fauxAssistantMessage("hook done")]);

		await harness.session.prompt("outer");
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["outer", "from hook"]);
	});

	it("runs a tool call turn: parallel tool results then a single follow-up LLM response", async () => {
		const toolRuns: string[] = [];
		const fastCompleted = createDeferred();
		const makeTool = (name: string): AgentTool => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				if (name === "slow") await fastCompleted.promise;
				toolRuns.push(`${name}:${value}`);
				if (name === "fast") fastCompleted.resolve();
				return {
					content: [{ type: "text", text: `${name}:${value}` }],
					details: { value },
				};
			},
		});
		const harness = await createHarness({ tools: [makeTool("slow"), makeTool("fast")] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { value: "a" }), fauxToolCall("fast", { value: "b" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResults = context.messages.filter((message) => message.role === "toolResult");
				return fauxAssistantMessage(`tool results: ${toolResults.length}`);
			},
		]);

		await harness.session.prompt("run tools");

		expect(toolRuns).toEqual(["fast:b", "slow:a"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("assistant");
	});

	it("expands skill commands and prompt templates before sending the prompt", async () => {
		const tempDir = join(tmpdir(), `pi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "test-skill.md");
		writeFileSync(skillPath, "# Test Skill\n\nUse the skill body.");
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						kind: "markdown" as const,
						baseDir: tempDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: tempDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const expandedPrompts: string[] = [];
		const capture = (context: { messages: { role: string }[] }) => {
			const user = context.messages.filter((message) => message.role === "user").at(-1);
			expandedPrompts.push(user ? getMessageText(user) : "");
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([capture, capture]);

		await harness.session.prompt("/skill:test explain this");
		await harness.session.prompt("/review src/index.ts");

		expect(expandedPrompts[0]).toContain('<skill name="test" location="');
		expect(expandedPrompts[0]).toContain("Use the skill body.");
		expect(expandedPrompts[0]).toContain("explain this");
		expect(expandedPrompts[1]).toBe("Review this code: src/index.ts");
	});

	it.each([
		{
			label: "an aborted prompt",
			options: () => {
				const controller = new AbortController();
				controller.abort();
				return { streamingBehavior: "followUp" as const, signal: controller.signal };
			},
			error: "Prompt admission was cancelled.",
		},
		{
			label: "a prompt without streamingBehavior",
			options: () => undefined,
			error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		},
	])("rejects $label while streaming instead of enqueueing it", async ({ options, error }) => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await waitForToolStart;

		await expect(harness.session.prompt("queued while busy", options())).rejects.toThrow(error);
		expect(harness.session.queuedActionCount).toBe(0);

		releaseToolExecution();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("keeps pending nextTurn context separate from accepted agent messages queued while busy", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_next_turn_queued\n\nagent text";
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "queued context", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		const sessionInternals = harness.session as unknown as {
			_compactionAbortController?: AbortController;
		};
		sessionInternals._compactionAbortController = new AbortController();

		await harness.session.acceptAgentMessagePrompt(agentPrompt, {
			expandPromptTemplates: false,
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});
		expect(harness.session.getFollowUpMessages()).toEqual([agentPrompt]);

		sessionInternals._compactionAbortController = undefined;
		let queuedTurnSawSeparateNextTurnContext = false;
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			(context) => {
				const queuedContext = context.messages.find(
					(message) => message.role === "user" && getMessageText(message) === "queued context",
				);
				const queuedUser = context.messages.find(
					(message) => message.role === "user" && getMessageText(message).includes("agentmsg_next_turn_queued"),
				);
				queuedTurnSawSeparateNextTurnContext =
					queuedContext !== undefined &&
					queuedUser !== undefined &&
					!getMessageText(queuedUser).includes("queued context");
				return fauxAssistantMessage("queued turn");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(queuedTurnSawSeparateNextTurnContext).toBe(true);
		expect(harness.session.queuedActionCount).toBe(0);
	});

	it("waits to accept agent messages while queued work is paused without leaking a waiter", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_handoff_busy\n\nqueue at handoff";
		const sessionInternals = harness.session as unknown as {
			_sessionInputCheckpointWaiters: Set<() => void>;
		};
		const pause = harness.session.acquireQueuedWorkPause();
		let acceptedSettled = false;
		const accepted = harness.session
			.acceptAgentMessagePrompt(agentPrompt, {
				expandPromptTemplates: false,
				streamingBehavior: "followUp",
				queueIfBusy: true,
			})
			.then(() => {
				acceptedSettled = true;
			});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(acceptedSettled).toBe(false);
		expect(sessionInternals._sessionInputCheckpointWaiters.size).toBe(1);

		harness.setResponses([fauxAssistantMessage("delivered")]);
		pause.release();
		await accepted;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual([agentPrompt]);
		expect(sessionInternals._sessionInputCheckpointWaiters.size).toBe(0);
	});

	it("restores nextTurn context when handoff busy rejection cannot queue", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "restore after handoff failure", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		let releaseRefine: (() => void) | undefined;
		const refineGate = new Promise<void>((resolve) => {
			releaseRefine = resolve;
		});
		const sessionInternals = harness.session as unknown as {
			_refineInFlight?: Promise<void>;
			_userBashRunning?: boolean;
		};
		sessionInternals._refineInFlight = refineGate;

		const accepted = harness.session.acceptAgentMessagePrompt(
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_handoff_reject\n\nagent text",
			{ expandPromptTemplates: false, queueIfBusy: true },
		);
		await vi.waitFor(() => expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]));
		sessionInternals._userBashRunning = true;
		sessionInternals._refineInFlight = undefined;
		releaseRefine?.();

		await expect(accepted).rejects.toThrow("Agent became busy before prompt delivery");
		sessionInternals._userBashRunning = false;

		let sawRestoredContext = false;
		harness.setResponses([
			(context) => {
				sawRestoredContext = context.messages.some(
					(message) =>
						message.role === "user" && getMessageText(message).includes("restore after handoff failure"),
				);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("normal prompt");

		expect(sawRestoredContext).toBe(true);
	});

	it("flushes pending bash messages before accepted agent messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			recordBashResult(command: string, result: BashResult): void;
			_flushPendingBashMessages(): void;
		};
		const contextRoles: string[][] = [];
		const contextTexts: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage("busy done"),
			(context) => {
				contextRoles.push(context.messages.map((message) => message.role));
				contextTexts.push(context.messages.map((message) => getMessageText(message)));
				return fauxAssistantMessage("agent message response");
			},
		]);

		const busyPrompt = harness.session.agent.prompt("busy");
		sessionInternals.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		await busyPrompt;
		await harness.session.acceptAgentMessagePrompt("agent-to-agent payload", { expandPromptTemplates: false });
		await harness.session.agent.waitForIdle();

		// The direct agent.prompt bypassed the pipeline, so the first pipeline turn injects the digest here.
		expect(contextRoles).toEqual([["user", "assistant", "user", "user", "user"]]);
		expect(contextTexts[0]?.[2]).toContain("Ran `echo hi`");
		expect(contextTexts[0]?.[3]).toContain("The persistent memories produced across this session so far:");
		expect(contextTexts[0]?.[4]).toBe("agent-to-agent payload");
		expect(harness.session.hasPendingBashMessages).toBe(false);
	});

	it("waitForIdle waits for cancelled dispatch cleanup in the session event queue", async () => {
		const eventQueueReached = createDeferred();
		const eventQueueGate = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", async () => {
						eventQueueReached.resolve();
						await eventQueueGate.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("never delivered")]);
		const dispatchGate = gateNextAgentStart(harness);
		const prompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_idle_cleanup\n\ncancel me";
		const accepted = harness.session.acceptAgentMessagePrompt(prompt, { expandPromptTemplates: false });
		const rejected = expect(accepted).rejects.toThrow("cleared before delivery");
		await Promise.all([eventQueueReached.promise, dispatchGate.reached]);

		harness.session.clearQueuedUserMessagesMatching((text) => text === prompt);
		let idle = false;
		const waiting = harness.session.waitForIdle().then(() => {
			idle = true;
		});
		dispatchGate.release();
		await rejected;
		await harness.session.agent.waitForIdle();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const store = (harness.session as unknown as { _actionStore: { ownedActions(): readonly unknown[] } })
			._actionStore;
		expect(idle).toBe(false);
		expect(store.ownedActions()).toHaveLength(1);
		eventQueueGate.resolve();
		await waiting;
		expect(store.ownedActions()).toHaveLength(0);
		expect(harness.session.agent.state.errorMessage).toBeUndefined();
	});

	it("restores drained nextTurn messages when direct agent message acceptance fails before delivery", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "retry me", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		const agent = harness.session.agent as unknown as { prompt(messages: unknown): Promise<void> };
		const originalPrompt = agent.prompt;
		agent.prompt = async () => {
			throw new Error("prompt failed before delivery");
		};

		await expect(
			harness.session.acceptAgentMessagePrompt(
				"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_context_fail\n\nagent text",
				{ expandPromptTemplates: false },
			),
		).rejects.toThrow("prompt failed before delivery");
		agent.prompt = originalPrompt;

		let sawCustomMessage = false;
		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "retry me"),
				);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("normal prompt");

		expect(sawCustomMessage).toBe(true);
	});

	it("does not restore durable nextTurn context after partial agent-message delivery", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "partial-next-turn", content: "deliver once", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_partial_delivery\n\nagent text";
		const unsubscribe = harness.session.agent.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === agentPrompt
			) {
				throw new Error("fail after nextTurn delivery");
			}
		});

		await expect(
			harness.session.acceptAgentMessagePrompt(agentPrompt, { expandPromptTemplates: false }),
		).resolves.toBeUndefined();
		unsubscribe();
		await harness.session.waitForIdle();

		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "partial-next-turn",
			),
		).toHaveLength(1);

		let contextCopies = 0;
		harness.setResponses([
			(context) => {
				contextCopies = context.messages.filter((message) => getMessageText(message) === "deliver once").length;
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("normal prompt");
		expect(contextCopies).toBe(1);
	});

	it("promptAndWait queued behind an active turn stays pending through its own completion", async () => {
		let releaseFirst: (() => void) | undefined;
		let releaseSecond: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await firstGate;
				return fauxAssistantMessage("first done");
			},
			async () => {
				await secondGate;
				return fauxAssistantMessage("second done");
			},
		]);

		const first = harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		let settled = false;
		const queued = harness.session
			.promptAndWait("second", { streamingBehavior: "followUp", queueIfBusy: true, resumeIfIdle: true })
			.then(() => {
				settled = true;
			});
		await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["second"]));
		expect(settled).toBe(false);

		releaseFirst?.();
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual(["first", "second"]));
		expect(settled).toBe(false);

		releaseSecond?.();
		await Promise.all([first, queued]);
		expect(settled).toBe(true);
		expect(getAssistantTexts(harness)).toEqual(["first done", "second done"]);
	});

	it.each([
		{ label: "tab-separated", text: "/autonomous\ton", enabled: true, sentToModel: false },
		{ label: "multiline", text: "/autonomous\t\non", enabled: false, sentToModel: true },
	])(
		"handles $label built-in slash commands when template expansion is disabled",
		async ({ text, enabled, sentToModel }) => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("sent")]);

			await harness.session.prompt(text, { expandPromptTemplates: false });

			expect(harness.session.getAutonomousStatus().enabled).toBe(enabled);
			expect(getUserTexts(harness)).toEqual(sentToModel ? [text] : []);
			expect(harness.getPendingResponseCount()).toBe(sentToModel ? 0 : 1);
		},
	);

	it("does not run built-in slash commands immediately while queueIfBusy backpressure is active", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_compactionAbortController?: AbortController;
		};
		sessionInternals._compactionAbortController = new AbortController();

		await harness.session.prompt("/autonomous on", {
			queueIfBusy: true,
			streamingBehavior: "followUp",
		});

		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual(["/autonomous on"]);
		sessionInternals._compactionAbortController = undefined;
		expect(harness.session.resumeQueuedWork()).toBe(true);
		await harness.session.waitForSessionInputIdle();
		expect(harness.session.getAutonomousStatus().enabled).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("queues accepted agent messages without expanding slash commands or prompt templates", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "expanded template: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const commandRuns: string[] = [];
		const harness = await createHarness({
			resourceLoader,
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.queueAgentMessagePrompt("/review keep literal", "followUp")).resolves.toBe(true);
		await expect(harness.session.queueAgentMessagePrompt("/testcmd keep literal", "followUp")).resolves.toBe(true);

		expect(harness.session.getFollowUpMessages()).toEqual(["/review keep literal", "/testcmd keep literal"]);
		expect(commandRuns).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps an ordinary direct prompt fenced until its primary message starts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.sendCustomMessage(
			{ customType: "earlier-next-turn", content: "earlier", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		const earlierStarted = createDeferred();
		const earlierStartGate = createDeferred();
		const primaryStarted = createDeferred();
		const unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type !== "message_start") return;
			if (event.message.role === "user" && getMessageText(event.message) === "ordinary prompt") {
				primaryStarted.resolve();
				return;
			}
			if (event.message.role === "custom" && event.message.customType === "earlier-next-turn") {
				earlierStarted.resolve();
				await earlierStartGate.promise;
			}
		});

		const prompt = harness.session.prompt("ordinary prompt");
		await earlierStarted.promise;
		let checkpointReleased = false;
		const checkpoint = harness.session.waitForSessionInputCheckpoint().then(() => {
			checkpointReleased = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(checkpointReleased).toBe(false);

		earlierStartGate.resolve();
		await primaryStarted.promise;
		await checkpoint;
		await prompt;
		unsubscribe();
	});

	it("keeps a triggerTurn custom message fenced until its turn starts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const customStarted = createDeferred();
		const dispatchGate = createDeferred();
		const originalPrompt = harness.session.agent.prompt.bind(harness.session.agent);
		const promptCalled = createDeferred();
		const promptSpy = vi
			.spyOn(harness.session.agent, "prompt")
			.mockImplementation(async (messages: Parameters<typeof originalPrompt>[0]) => {
				promptSpy.mockRestore();
				promptCalled.resolve();
				await dispatchGate.promise;
				return originalPrompt(messages);
			});
		const unsubscribe = harness.session.agent.subscribe((event) => {
			if (event.type !== "message_start") return;
			if (event.message.role === "custom" && event.message.customType === "trigger-turn-test") {
				customStarted.resolve();
			}
		});

		const send = harness.session.sendCustomMessage(
			{ customType: "trigger-turn-test", content: "run a turn", display: true, details: {} },
			{ triggerTurn: true },
		);
		await promptCalled.promise;
		let checkpointReleased = false;
		const checkpoint = harness.session.waitForSessionInputCheckpoint().then(() => {
			checkpointReleased = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(checkpointReleased).toBe(false);

		dispatchGate.resolve();
		await customStarted.promise;
		await checkpoint;
		await send;
		unsubscribe();
	});

	it("keeps the restart checkpoint fenced between queued handoff and message dispatch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("queued done")]);
		// Gate agent.prompt itself to hold the window between the handedOff
		// phase flip and dispatch open.
		const dispatchGate = createDeferred();
		const originalPrompt = harness.session.agent.prompt.bind(harness.session.agent);
		const promptSpy = vi
			.spyOn(harness.session.agent, "prompt")
			.mockImplementation(async (messages: Parameters<typeof originalPrompt>[0]) => {
				promptSpy.mockRestore();
				await dispatchGate.promise;
				return originalPrompt(messages);
			});
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("handed off", undefined, { resumeIfIdle: true });
		pause.release();
		await vi.waitFor(() => {
			const store = (
				harness.session as unknown as {
					_actionStore: {
						activeActions(): readonly { lifecycle: { state: string }; payload: { kind: string } }[];
					};
				}
			)._actionStore;
			const active = store.activeActions()[0];
			expect(active?.payload.kind).toBe("turn");
			expect(active?.lifecycle.state).toBe("committing");
		});

		let checkpointReleased = false;
		const checkpoint = harness.session.waitForSessionInputCheckpoint().then(() => {
			checkpointReleased = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(checkpointReleased).toBe(false);

		dispatchGate.resolve();
		await checkpoint;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["handed off"]);
	});

	it("S7: accepted agent messages queue while busy, deliver before completion, and clean up when cleared", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const busyPrompt = (id: string, body: string) =>
			`Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: ${id}\n\n${body}`;

		// Phase 1: accept while streaming -> queues instead of interrupting.
		const busyGate = createDeferred();
		harness.setResponses([
			async () => {
				await busyGate.promise;
				return fauxAssistantMessage("busy done");
			},
			fauxAssistantMessage("queued accepted done"),
		]);
		const running = harness.session.prompt("keep busy");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		const queuedAgentPrompt = busyPrompt("agentmsg_s7_busy", "queued while busy");
		await harness.session.acceptAgentMessagePrompt(queuedAgentPrompt, {
			expandPromptTemplates: false,
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});
		expect(harness.session.getFollowUpMessages()).toEqual([queuedAgentPrompt]);
		busyGate.resolve();
		await running;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["keep busy", queuedAgentPrompt]);

		// Phase 2: accept while idle returns after delivery, before completion; delivered is uncleareable.
		const responseGate = createDeferred();
		harness.setResponses([
			async () => {
				await responseGate.promise;
				return fauxAssistantMessage("delivered");
			},
		]);
		const directAgentPrompt = busyPrompt("agentmsg_s7_direct", "direct delivery");
		await harness.session.acceptAgentMessagePrompt(directAgentPrompt, { expandPromptTemplates: false });
		expect(getUserTexts(harness)).toContain(directAgentPrompt);
		expect(getAssistantTexts(harness)).not.toContain("delivered");
		expect(harness.session.clearQueuedUserMessagesMatching((text) => text.includes("agentmsg_s7_direct"))).toEqual({
			steering: [],
			followUp: [],
		});
		responseGate.resolve();
		await harness.session.agent.waitForIdle();
		expect(getAssistantTexts(harness)).toContain("delivered");
		expect(getUserTexts(harness)).toContain(directAgentPrompt);

		// Phase 3: built-in slash commands stay literal.
		harness.setResponses([fauxAssistantMessage("literal")]);
		await harness.session.acceptAgentMessagePrompt("/autonomous on", { expandPromptTemplates: false });
		await harness.session.agent.waitForIdle();
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(getUserTexts(harness)).toContain("/autonomous on");

		// Phase 4: clear during admission rejects both waiters; late events must not re-persist.
		const persistedBefore = harness.sessionManager.getEntries().filter((entry) => entry.type === "message").length;
		harness.setResponses([fauxAssistantMessage("never delivered")]);
		const clearedAgentPrompt = busyPrompt("agentmsg_s7_cleared", "cleared during admission");
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_s7_cleared");
		const admission = gateNextAgentStart(harness);
		const accepted = harness.session.acceptAgentMessagePrompt(clearedAgentPrompt, {
			expandPromptTemplates: false,
		});
		await admission.reached;
		expect(harness.session.clearQueuedUserMessagesMatching((text) => text.includes("agentmsg_s7_cleared"))).toEqual({
			steering: [],
			followUp: [clearedAgentPrompt],
		});
		admission.release();
		await expect(accepted).rejects.toThrow("cleared before delivery");
		await expect(delivery).rejects.toThrow("cleared before delivery");
		await harness.session.agent.waitForIdle();
		await (harness.session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;
		const persistedAfter = harness.sessionManager.getEntries().filter((entry) => entry.type === "message").length;
		expect(persistedAfter).toBe(persistedBefore);
		expect(getUserTexts(harness)).not.toContain(clearedAgentPrompt);
		expect(harness.session.agent.state.errorMessage).toBeUndefined();
		harness.setResponses([fauxAssistantMessage("clean after")]);
		await harness.session.prompt("normal prompt");
		expect(getAssistantTexts(harness)).toContain("clean after");
	});
});

describe("Harness digest at cold boundaries", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function digestMessages(harness: Harness) {
		return harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === HARNESS_DIGEST_CUSTOM_TYPE,
		);
	}

	it("keeps untouched sessions empty and injects the digest at the first committed turn", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		// Untouched sessions must stay empty for draft cleanup and emptiness checks.
		expect(harness.session.messages).toHaveLength(0);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" || entry.type === "message"),
		).toHaveLength(0);

		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("hello");

		const first = harness.session.messages[0];
		expect(first).toMatchObject({ role: "custom", customType: HARNESS_DIGEST_CUSTOM_TYPE });
		expect(harness.session.messages[1]).toMatchObject({ role: "user" });
		expect(getMessageText(first)).toContain("The persistent memories produced across this session so far:");
		// Passes through to the model as a user message and is durably persisted.
		expect(convertToLlm([first!])[0]?.role).toBe("user");
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === HARNESS_DIGEST_CUSTOM_TYPE),
		).toBe(true);
	});

	it("strips the digest with a cleared first turn and re-delivers it on the next turn", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const agentMessageId = "agentmsg_digest_clear";
		const agentPrompt = `Agent-to-agent message received.\nSource: agent_message\nTo: T, active t, session s\nMessage id: ${agentMessageId}\n\nagent text`;
		harness.setResponses([fauxAssistantMessage("never delivered")]);
		const admission = gateNextAgentStart(harness);

		const accepted = harness.session.acceptAgentMessagePrompt(agentPrompt, { expandPromptTemplates: false });
		const acceptedRejection = expect(accepted).rejects.toThrow("cleared before delivery");
		await admission.reached;
		harness.session.clearQueuedUserMessagesMatching((text) => text.includes(agentMessageId));
		admission.release();
		await acceptedRejection;
		await harness.session.agent.waitForIdle();

		// The cleared first turn takes its digest with it: the session is empty again.
		expect(harness.session.messages).toHaveLength(0);

		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("hello");
		expect(digestMessages(harness)).toHaveLength(1);
		expect(harness.session.messages[0]).toMatchObject({ role: "custom", customType: HARNESS_DIGEST_CUSTOM_TYPE });
	});

	it("exposes the newest digest details, including the state fingerprint", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_latestContextHarnessDigestDetails(): { digest: string; stateFingerprint?: string } | undefined;
		};
		const base = Date.now();
		harness.session.agent.state.messages.push(
			createHarnessDigestMessage("older digest", base + 1000, "fp-older"),
			createCompactionSummaryMessage(
				"summary",
				10,
				new Date(base + 2000).toISOString(),
				undefined,
				1,
				"head digest",
				"fp-head",
			),
		);
		expect(internals._latestContextHarnessDigestDetails()).toMatchObject({
			digest: "head digest",
			stateFingerprint: "fp-head",
		});
	});

	function isolatedAgentDir(prefix: string): string {
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		const agentDir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		tempDirs.push(agentDir);
		process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
		onTestFinished(() => {
			if (previousAgentDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
		});
		return agentDir;
	}

	function seedMemory(
		state: ReturnType<typeof loadHarnessState>,
		id: string,
		title: string,
		content: string,
		scope: "local" | "global" = "local",
	): void {
		state.entries.memory[id] = {
			id,
			kind: "memory",
			title,
			content,
			path: "general",
			scope,
			reference: {},
			arguments: {},
			metadata: {},
			source: "refine",
			created_at: "2026-09-07T00:00:00.000Z",
			updated_at: "2026-09-07T00:00:00.000Z",
			version: 1,
		};
	}

	it("skips digest re-delivery on resume while the fingerprint is fresh and appends a fresh one when state changed", async () => {
		// Hermetic store: the ambient developer harness would crowd the ranked window.
		isolatedAgentDir("pi-digest-resume");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		// Local material whose entries the resume-time query terms re-rank: the
		// fresh render would differ, so only a state fingerprint can dedupe.
		const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir());
		expect(localDir).toBeDefined();
		const state = loadHarnessState(localDir, "local");
		seedMemory(state, "alpha_relevant", "Alpha second turn note", "Mentions second turns.");
		seedMemory(state, "middle_plain", "Middle plain note", "Neutral material about tea varieties.");
		seedMemory(state, "zeta_relevant", "Zeta hello note", "Greets with hello.");
		saveHarnessState(localDir!, state);

		harness.setResponses([fauxAssistantMessage("ack"), fauxAssistantMessage("ack")]);
		await harness.session.prompt("hello");
		await harness.session.prompt("second turn with different wording");
		const before = digestMessages(harness);
		expect(before).toHaveLength(1);
		const digestTextBefore = getMessageText(before[0]);
		expect(digestTextBefore).toContain("[local:alpha_relevant]");
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		harness.session.dispose();

		// Identical disk state, drifted query terms: the fresh render would
		// differ, so only the fingerprint can dedupe. Exactly one byte-identical
		// digest, with no copy stacked by the resume.
		const resumed = await createHarness({ existingSessionFile: sessionFile });
		harnesses.push(resumed);
		const after = digestMessages(resumed);
		expect(after).toHaveLength(1);
		expect(getMessageText(after[0])).toBe(digestTextBefore);
		const freshDigest = (
			resumed.session as unknown as {
				_harnessDigestWithFingerprint(): { digest: string; stateFingerprint: string };
			}
		)._harnessDigestWithFingerprint().digest;
		expect(HARNESS_DIGEST_PREFIX + freshDigest + HARNESS_DIGEST_SUFFIX).not.toBe(getMessageText(after[0]));
		resumed.session.dispose();

		// Stale fingerprint: the local harness changed on disk since the last
		// injection, so the resume appends a fresh digest at the end.
		const reloaded = loadHarnessState(localDir, "local");
		seedMemory(reloaded, "resume_test_memory", "Resume test memory", "Written between resumes.");
		saveHarnessState(localDir!, reloaded);

		const resumedStale = await createHarness({ existingSessionFile: sessionFile });
		harnesses.push(resumedStale);
		const digests = digestMessages(resumedStale);
		expect(digests.length).toBe(2);
		expect(resumedStale.session.messages.at(-1)).toBe(digests.at(-1));
		expect(getMessageText(digests.at(-1))).toContain("[local:resume_test_memory] Resume test memory");
	});

	it("keeps the digest byte-identical when a refinement notice is appended", async () => {
		isolatedAgentDir("pi-digest-refine");
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir());
		expect(localDir).toBeDefined();
		const state = loadHarnessState(localDir, "local");
		seedMemory(state, "notice_base_memory", "Notice base memory", "Baseline material.");
		saveHarnessState(localDir!, state);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		const digestBefore = digestMessages(harness);
		expect(digestBefore).toHaveLength(1);
		const digestTextBefore = getMessageText(digestBefore[0]);

		// Stub only the planner; the apply phase runs for real and appends the
		// durable refinement notice at the end of the context.
		const internals = harness.session as unknown as {
			_planRefine(options: unknown, signal: AbortSignal): Promise<unknown>;
		};
		vi.spyOn(internals, "_planRefine").mockResolvedValue({
			id: "refine_notice_freeze",
			proposal: {
				summary: "Add a notice-applied memory",
				rationale: "Cache stability proof",
				expectedOutcome: "Digest stays byte-identical.",
				edits: [
					{
						action: "create",
						kind: "memory",
						title: "Notice applied memory",
						content: "Written by the refinement.",
						path: "general",
					},
				],
			},
		});
		await harness.session.refine({});

		// The digest in context is untouched: the notice carries the change.
		const digestsAfter = digestMessages(harness);
		expect(digestsAfter).toHaveLength(1);
		expect(digestsAfter[0]).toBe(digestBefore[0]);
		expect(getMessageText(digestsAfter[0])).toBe(digestTextBefore);

		const notice = harness.session.messages.at(-1);
		expect(notice).toMatchObject({ role: "custom", customType: REFINEMENT_NOTICE_CUSTOM_TYPE });
		expect(harness.session.messages.indexOf(digestsAfter[0])).toBeLessThan(harness.session.messages.length - 1);
		// The notice reaches the model as a user message after the digest.
		const noticeLlm = convertToLlm([notice!]);
		expect(noticeLlm).toHaveLength(1);
		expect(noticeLlm[0]?.role).toBe("user");
	});
});
