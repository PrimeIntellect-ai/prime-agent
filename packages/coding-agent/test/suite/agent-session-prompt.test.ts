import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashResult } from "../../src/core/bash-executor.js";
import type { PromptTemplate } from "../../src/core/prompt-templates.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.js";
import { createDeferred, createWaitingHarness, gatedHook } from "./scheduling.js";

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

	it("releases action admission when ownership commit throws", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const commitError = new Error("commit failed");

		await expect(
			harness.session.prompt("first", {
				admissionCommitted: () => {
					throw commitError;
				},
			}),
		).rejects.toBe(commitError);
		expect(getUserTexts(harness)).toEqual([]);

		harness.setResponses([fauxAssistantMessage("recovered")]);
		await harness.session.prompt("second");
		expect(getUserTexts(harness)).toEqual(["second"]);
	});

	it("keeps a prompt session-owned when cancellation arrives after admission", async () => {
		const harness = await createHarness({ models: [{ id: "slow-faux" }] });
		harnesses.push(harness);
		let releaseResponse = () => {};
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		harness.setResponses([
			async () => {
				await responseGate;
				return fauxAssistantMessage("owned");
			},
		]);
		const controller = new AbortController();

		const prompt = harness.session.prompt("keep me", { signal: controller.signal });
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual(["keep me"]));
		controller.abort();
		releaseResponse();
		await prompt;

		expect(getUserTexts(harness)).toEqual(["keep me"]);
		expect(getAssistantTexts(harness)).toEqual(["owned"]);
	});

	it("prompts while idle and records a single text response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[0]!)).toBe("hi");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("session_action_update")).toEqual([]);
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

	it("handles a tool call turn and waits for the follow-up LLM response", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(harness.session.messages[2]?.role).toBe("toolResult");
		expect(harness.session.messages[3]?.role).toBe("assistant");
	});

	it("executes multiple tool calls from one response and continues with a single follow-up response", async () => {
		const toolRuns: string[] = [];
		const makeTool = (name: string, delayMs: number): AgentTool => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				toolRuns.push(`${name}:${value}`);
				return {
					content: [{ type: "text", text: `${name}:${value}` }],
					details: { value },
				};
			},
		});
		const harness = await createHarness({ tools: [makeTool("slow", 25), makeTool("fast", 0)] });
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

		expect(toolRuns.sort()).toEqual(["fast:b", "slow:a"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("assistant");
	});

	it("preserves image attachments in the provider context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawImage = false;

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				sawImage =
					user?.role === "user" &&
					typeof user.content !== "string" &&
					user.content.some((part) => part.type === "image");
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("describe", {
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "ZmFrZQ==",
				},
			],
		});

		expect(sawImage).toBe(true);
	});

	it("expands skill commands before sending the prompt", async () => {
		const tempDir = join(tmpdir(), `pi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "test-skill.md");
		writeFileSync(skillPath, "# Test Skill\n\nUse the skill body.");

		const resourceLoader = {
			...createTestResourceLoader(),
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
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/skill:test explain this");

		expect(expandedPrompt).toContain('<skill name="test" location="');
		expect(expandedPrompt).toContain("Use the skill body.");
		expect(expandedPrompt).toContain("explain this");
	});

	it("expands prompt templates before sending the prompt", async () => {
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
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/review src/index.ts");

		expect(expandedPrompt).toBe("Review this code: src/index.ts");
	});

	it("dispatches extension commands without consuming a provider response", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
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
		harness.setResponses([fauxAssistantMessage("should stay queued")]);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("sendUserMessage while idle triggers a turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.sendUserMessage("from extension");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[0]!)).toBe("from extension");
	});

	it("rejects an aborted prompt while streaming instead of enqueueing it", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await waitForToolStart;
		const controller = new AbortController();
		controller.abort();

		await expect(
			harness.session.prompt("stale startup prompt", {
				streamingBehavior: "followUp",
				signal: controller.signal,
			}),
		).rejects.toThrow("Prompt admission was cancelled.");
		expect(harness.session.queuedActionCount).toBe(0);

		releaseToolExecution();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("throws when prompted during streaming without a streamingBehavior", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await waitForToolStart;

		await expect(harness.session.prompt("second")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		releaseToolExecution();
		await promptPromise;
	});

	it("preserves the active extension system prompt when max depth changes mid-run", async () => {
		const responseStarted = createDeferred();
		const responseGate = createDeferred();
		const harness = await createHarness({
			rlmDepth: 1,
			rlmMaxDepth: 1,
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						systemPrompt: `${event.systemPrompt}

active extension doctrine`,
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				responseStarted.resolve();
				await responseGate.promise;
				return fauxAssistantMessage("done");
			},
		]);

		const promptPromise = harness.session.prompt("start");
		await responseStarted.promise;
		expect(harness.session.agent.state.systemPrompt).toContain("active extension doctrine");
		expect(harness.session.agent.state.systemPrompt).not.toContain("A callable `rlm`");

		await harness.session.setRlmMaxDepth(2);

		expect(harness.session.agent.state.systemPrompt).toContain("A callable `rlm`");
		expect(harness.session.agent.state.systemPrompt).toContain("active extension doctrine");
		responseGate.resolve();
		await promptPromise;
	});

	it("resets stale extension system prompt for accepted agent messages", async () => {
		const harness = await createHarness({
			systemPrompt: "base prompt",
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						systemPrompt: `${event.systemPrompt}

stale extension instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		const baseSystemPrompt = harness.session.systemPrompt;
		const providerSystemPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				providerSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("first");
			},
			(context) => {
				providerSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("normal prompt");
		await harness.session.acceptAgentMessagePrompt("agent-to-agent payload", { expandPromptTemplates: false });
		await harness.session.agent.waitForIdle();

		expect(providerSystemPrompts[0]).toContain("stale extension instructions");
		expect(providerSystemPrompts[1]).toBe(baseSystemPrompt);
		expect(providerSystemPrompts[1]).not.toContain("stale extension instructions");
	});

	it("discards a stale extension prompt when refine completes during a normal prompt hook", async () => {
		let signalHookStarted: () => void = () => {};
		const hookStarted = new Promise<void>((resolve) => {
			signalHookStarted = resolve;
		});
		let releaseHook: () => void = () => {};
		const hookRelease = new Promise<void>((resolve) => {
			releaseHook = resolve;
		});
		const harness = await createHarness({
			persistSession: true,
			systemPrompt: "pre-refine base",
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						signalHookStarted();
						await hookRelease;
						return {
							message: {
								customType: "refine-race-proof",
								content: "extension message preserved",
								display: false,
							},
							systemPrompt: `${event.systemPrompt}

stale extension instructions`,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_baseSystemPrompt: string;
			_refineInFlight?: Promise<void>;
			_refineAbortController?: AbortController;
			_planRefine(options: unknown, signal: AbortSignal): Promise<unknown>;
			_applyRefine(plan: unknown, options: unknown, abort: AbortController): Promise<unknown>;
		};
		vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "race-plan", proposal: { edits: [] } });
		vi.spyOn(internals, "_applyRefine").mockImplementation(async () => {
			internals._baseSystemPrompt = "refined $& base";
			harness.session.agent.state.systemPrompt = "refined $& base";
			internals._refineAbortController = undefined;
			return {
				id: "refine_race",
				summary: "refined",
				rationale: "test",
				expectedOutcome: "test",
				appliedEdits: [],
			};
		});
		let providerSystemPrompt = "";
		let providerMessages = "";
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				providerMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage("done");
			},
		]);

		const promptPromise = harness.session.prompt("normal prompt");
		await hookStarted;
		await harness.session.refine({ instructions: "complete while the extension hook is suspended" });
		expect(internals._refineInFlight).toBeUndefined();
		releaseHook();
		await promptPromise;

		expect(providerSystemPrompt).toContain("refined $& base");
		expect(providerSystemPrompt).toContain("stale extension instructions");
		expect(providerMessages).toContain("extension message preserved");
	});

	it("preserves an independent extension prompt when refine completes during its hook", async () => {
		let releaseHook: () => void = () => {};
		const hookRelease = new Promise<void>((resolve) => {
			releaseHook = resolve;
		});
		let signalHookStarted: () => void = () => {};
		const hookStarted = new Promise<void>((resolve) => {
			signalHookStarted = resolve;
		});
		const harness = await createHarness({
			persistSession: true,
			systemPrompt: "pre-refine base",
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						signalHookStarted();
						await hookRelease;
						return { systemPrompt: "independent extension replacement" };
					});
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_baseSystemPrompt: string;
			_refineAbortController?: AbortController;
			_planRefine(options: unknown, signal: AbortSignal): Promise<unknown>;
			_applyRefine(plan: unknown, options: unknown, abort: AbortController): Promise<unknown>;
		};
		vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "race-plan", proposal: { edits: [] } });
		vi.spyOn(internals, "_applyRefine").mockImplementation(async () => {
			internals._baseSystemPrompt = "refined base";
			harness.session.agent.state.systemPrompt = "refined base";
			internals._refineAbortController = undefined;
			return {
				id: "refine_independent",
				summary: "refined",
				rationale: "test",
				expectedOutcome: "test",
				appliedEdits: [],
				harnessStatePath: "",
			};
		});
		let providerSystemPrompt = "";
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("done");
			},
		]);

		const promptPromise = harness.session.prompt("normal prompt");
		await hookStarted;
		await harness.session.refine({ instructions: "refresh the base" });
		releaseHook();
		await promptPromise;

		expect(providerSystemPrompt).toBe("independent extension replacement");
	});

	it("refreshes an extension system prompt when refine completes during an injected prompt hook", async () => {
		let signalHookStarted: () => void = () => {};
		const hookStarted = new Promise<void>((resolve) => {
			signalHookStarted = resolve;
		});
		let releaseHook: () => void = () => {};
		const hookRelease = new Promise<void>((resolve) => {
			releaseHook = resolve;
		});
		const harness = await createHarness({
			persistSession: true,
			systemPrompt: "pre-refine base",
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						signalHookStarted();
						await hookRelease;
						return {
							message: {
								customType: "refine-race-proof",
								content: "injected extension message preserved",
								display: false,
							},
							systemPrompt: `${event.systemPrompt}

stale injected extension instructions`,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_baseSystemPrompt: string;
			_refineInFlight?: Promise<void>;
			_refineAbortController?: AbortController;
			_planRefine(options: unknown, signal: AbortSignal): Promise<unknown>;
			_applyRefine(plan: unknown, options: unknown, abort: AbortController): Promise<unknown>;
			_promptInjectedMessage(
				text: string,
				message: {
					role: "custom";
					customType: string;
					content: string;
					display: boolean;
					details: Record<string, never>;
					timestamp: number;
				},
			): Promise<void>;
		};
		vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "race-plan", proposal: { edits: [] } });
		vi.spyOn(internals, "_applyRefine").mockImplementation(async () => {
			internals._baseSystemPrompt = "refined injected base";
			harness.session.agent.state.systemPrompt = "refined injected base";
			internals._refineAbortController = undefined;
			return {
				id: "refine_race",
				summary: "refined",
				rationale: "test",
				expectedOutcome: "test",
				appliedEdits: [],
			};
		});
		let providerSystemPrompt = "";
		let providerMessages = "";
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				providerMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage("done");
			},
		]);

		const injectedPrompt = internals._promptInjectedMessage("injected prompt", {
			role: "custom",
			customType: "injected-test",
			content: "injected prompt",
			display: true,
			details: {},
			timestamp: Date.now(),
		});
		await hookStarted;
		await harness.session.refine({ instructions: "complete while the injected hook is suspended" });
		expect(internals._refineInFlight).toBeUndefined();
		releaseHook();
		await injectedPrompt;

		expect(providerSystemPrompt).toContain("refined injected base");
		expect(providerSystemPrompt).toContain("stale injected extension instructions");
		expect(providerMessages).toContain("injected extension message preserved");
	});

	it("pumps a follow-up queued while an injected prompt owns the active turn", async () => {
		const hook = gatedHook({ prompt: "injected prompt" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_promptInjectedMessage(
				text: string,
				message: {
					role: "custom";
					customType: string;
					content: string;
					display: boolean;
					details: Record<string, never>;
					timestamp: number;
				},
			): Promise<void>;
		};
		harness.setResponses([fauxAssistantMessage("injected done"), fauxAssistantMessage("follow-up done")]);

		const injectedPrompt = internals._promptInjectedMessage("injected prompt", {
			role: "custom",
			customType: "injected-test",
			content: "injected prompt",
			display: true,
			details: {},
			timestamp: Date.now(),
		});
		await hook.reached;
		await harness.session.followUp("queued follow-up");
		hook.release();

		await injectedPrompt;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["queued follow-up"]);
		expect(getAssistantTexts(harness)).toEqual(["injected done", "follow-up done"]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("preserves an empty extension system prompt across an injected refine handoff wait", async () => {
		let sessionInternals: {
			_refineInFlight?: Promise<void>;
			_promptInjectedMessage(
				text: string,
				message: {
					role: "custom";
					customType: string;
					content: string;
					display: boolean;
					details: Record<string, never>;
					timestamp: number;
				},
			): Promise<void>;
		};
		const harness = await createHarness({
			systemPrompt: "base prompt",
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						let releaseRefine: (() => void) | undefined;
						sessionInternals._refineInFlight = new Promise<void>((resolve) => {
							releaseRefine = resolve;
						});
						setTimeout(() => {
							sessionInternals._refineInFlight = undefined;
							releaseRefine?.();
						}, 0);
						return { systemPrompt: "" };
					});
				},
			],
		});
		harnesses.push(harness);
		sessionInternals = harness.session as unknown as typeof sessionInternals;
		let providerSystemPrompt = "not observed";
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("done");
			},
		]);

		await sessionInternals._promptInjectedMessage("injected prompt", {
			role: "custom",
			customType: "injected-test",
			content: "injected prompt",
			display: true,
			details: {},
			timestamp: Date.now(),
		});

		expect(providerSystemPrompt).toBe("");
	});

	it("preserves an extension system prompt across a refine handoff wait", async () => {
		let sessionInternals: { _refineInFlight?: Promise<void> };
		const harness = await createHarness({
			systemPrompt: "base prompt",
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						let releaseRefine: (() => void) | undefined;
						sessionInternals._refineInFlight = new Promise<void>((resolve) => {
							releaseRefine = resolve;
						});
						setTimeout(() => {
							sessionInternals._refineInFlight = undefined;
							releaseRefine?.();
						}, 0);
						return {
							systemPrompt: `${event.systemPrompt}

extension instructions`,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		sessionInternals = harness.session as unknown as { _refineInFlight?: Promise<void> };
		let providerSystemPrompt = "";
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(providerSystemPrompt).toContain("extension instructions");
	});

	it("discards stale extension prompt when refine completes during post-hook _waitForRefineIdle", async () => {
		// Test C: the extension hook returns an extension prompt while
		// _refineInFlight is still active. During _waitForRefineIdle after
		// the hook, the refine completes and rewrites _baseSystemPrompt.
		// The post-wait guard must detect the base change and discard the
		// stale extension prompt, using the refined base instead.
		let sessionInternals: {
			_baseSystemPrompt: string;
			_refineInFlight?: Promise<void>;
			_refineAbortController?: AbortController;
			_planRefine(options: unknown, signal: AbortSignal): Promise<unknown>;
			_applyRefine(plan: unknown, options: unknown, abort: AbortController): Promise<unknown>;
		};
		let releaseRefine: (() => void) | undefined;
		const harness = await createHarness({
			persistSession: true,
			systemPrompt: "pre-refine base",
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						// Set up _refineInFlight so the post-hook wait triggers.
						sessionInternals._refineInFlight = new Promise<void>((resolve) => {
							releaseRefine = resolve;
						});
						return {
							systemPrompt: `${event.systemPrompt}

stale post-hook extension instructions`,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		sessionInternals = harness.session as unknown as typeof sessionInternals;
		vi.spyOn(sessionInternals, "_planRefine").mockResolvedValue({ id: "race-plan", proposal: { edits: [] } });
		vi.spyOn(sessionInternals, "_applyRefine").mockImplementation(async () => {
			sessionInternals._baseSystemPrompt = "refined post-hook base";
			harness.session.agent.state.systemPrompt = "refined post-hook base";
			sessionInternals._refineAbortController = undefined;
			return {
				id: "refine_post_hook",
				summary: "refined",
				rationale: "test",
				expectedOutcome: "test",
				appliedEdits: [],
			};
		});
		let providerSystemPrompt = "";
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("done");
			},
		]);

		const promptPromise = harness.session.prompt("normal prompt");
		// The extension hook fires, sets _refineInFlight, and returns a stale
		// extension prompt. The prompt path enters _waitForRefineIdle.
		// Wait for the hook to fire and set _refineInFlight.
		await vi.waitFor(() => {
			expect(sessionInternals._refineInFlight).toBeDefined();
		});
		// Complete the refine during the wait: change the base and resolve.
		sessionInternals._baseSystemPrompt = "refined post-hook base";
		releaseRefine?.();
		sessionInternals._refineInFlight = undefined;
		await promptPromise;

		expect(providerSystemPrompt).toContain("refined post-hook base");
		expect(providerSystemPrompt).toContain("stale post-hook extension instructions");
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

		expect(contextRoles).toEqual([["user", "assistant", "user", "user"]]);
		expect(contextTexts[0]?.[2]).toContain("Ran `echo hi`");
		expect(contextTexts[0]?.[3]).toBe("agent-to-agent payload");
		expect(harness.session.hasPendingBashMessages).toBe(false);
	});

	it("clears an accepted agent message before delivery without disturbing later work", async () => {
		let holdAgentStart = true;
		let releaseEventQueue = () => {};
		const eventQueueGate = new Promise<void>((resolve) => {
			releaseEventQueue = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", async () => {
						if (holdAgentStart) await eventQueueGate;
					});
				},
			],
		});
		harnesses.push(harness);
		const agentMessageId = "agentmsg_clear_lifecycle";
		const agentPrompt = `Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: ${agentMessageId}\n\nagent text`;
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		harness.events.splice(0);
		harness.setResponses([fauxAssistantMessage("never delivered")]);

		let markAdmitted = () => {};
		const admitted = new Promise<void>((resolve) => {
			markAdmitted = resolve;
		});
		let releaseAdmission = () => {};
		const admissionGate = new Promise<void>((resolve) => {
			releaseAdmission = resolve;
		});
		let unsubscribe = () => {};
		unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type !== "agent_start") return;
			unsubscribe();
			markAdmitted();
			await admissionGate;
		});

		const delivery = harness.session.waitForAgentMessagePromptDelivery(agentMessageId);
		const accepted = harness.session.acceptAgentMessagePrompt(agentPrompt, { expandPromptTemplates: false });
		const acceptedRejection = expect(accepted).rejects.toThrow("cleared before delivery");
		const deliveryRejection = expect(delivery).rejects.toThrow("cleared before delivery");
		await admitted;

		expect(harness.session.clearQueuedUserMessagesMatching((text) => text.includes(agentMessageId))).toEqual({
			steering: [],
			followUp: [agentPrompt],
		});
		releaseAdmission();
		await Promise.all([acceptedRejection, deliveryRejection]);
		await harness.session.agent.waitForIdle();

		let sawRestoredNextTurn = false;
		harness.setResponses([
			(context) => {
				sawRestoredNextTurn = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "carry this",
				);
				return fauxAssistantMessage("newer response");
			},
		]);
		holdAgentStart = false;
		await harness.session.prompt("newer prompt");
		releaseEventQueue();
		await harness.session.waitForIdle();

		expect(sawRestoredNextTurn).toBe(true);
		expect(getUserTexts(harness)).toEqual(["newer prompt"]);
		expect(getAssistantTexts(harness)).toEqual(["newer response"]);
		const deliveredEventTexts = harness.events
			.filter((event) => event.type === "message_start" || event.type === "message_end")
			.map((event) => getMessageText(event.message));
		expect(deliveredEventTexts).not.toContain(agentPrompt);
		expect(deliveredEventTexts).not.toContain("never delivered");
		await vi.waitFor(() =>
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "message")
					.map((entry) => getMessageText(entry.message)),
			).toEqual(["newer prompt", "newer response"]),
		);
		expect(harness.session.agent.state.errorMessage).toBeUndefined();
		expect(harness.session.unfinishedActionCount).toBe(0);
		expect(harness.session.hasAcceptedPromptInFlight).toBe(false);
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

	it("drops generated prompt-wait outcome entries after completion", async () => {
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await firstGate;
				return fauxAssistantMessage("first done");
			},
			fauxAssistantMessage("second done"),
		]);
		const internals = harness.session as unknown as { _agentMessageOutcomes: Map<string, unknown> };

		const first = harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		// Queued delivery settles the sticky delivered flag; a generated id must
		// still be dropped after completion or long-lived daemons grow one outcome
		// entry per prompt.
		const queued = harness.session.promptAndWait("second", { streamingBehavior: "followUp", queueIfBusy: true });
		releaseFirst?.();
		await Promise.all([first, queued]);

		const keys = [...internals._agentMessageOutcomes.keys()];
		expect(keys.filter((key) => key.startsWith("prompt-wait:"))).toEqual([]);
	});

	it("handles tab-separated autonomous slash commands when template expansion is disabled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("/autonomous	on", { expandPromptTemplates: false });

		expect(harness.session.getAutonomousStatus().enabled).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(true);
	});

	it("sends multiline goal and autonomous variants to the model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("/goal\t\nship it", { expandPromptTemplates: false });
		await harness.session.prompt("/autonomous\t\non", { expandPromptTemplates: false });

		expect(harness.session.goalState.status).toBe("idle");
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(getUserTexts(harness)).toEqual(["/goal\t\nship it", "/autonomous\t\non"]);
		expect(getAssistantTexts(harness)).toEqual(["first", "second"]);
	});

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
	it("promptUntilAccepted waits for delivery but not turn completion", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const responseGate = createDeferred();
		harness.setResponses([
			async () => {
				await responseGate.promise;
				return fauxAssistantMessage("done");
			},
		]);
		let delivered = false;
		const unsubscribe = harness.session.agent.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") delivered = true;
		});

		await harness.session.promptUntilAccepted("accepted prompt");

		expect(delivered).toBe(true);
		expect(harness.session.isStreaming).toBe(true);
		responseGate.resolve();
		await harness.session.waitForIdle();
		unsubscribe();
	});

	it("promptUntilAccepted returns at ownership commit without draining queued work", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const commandStarted = createDeferred();
		const commandGate = createDeferred();
		vi.spyOn(harness.session, "refine").mockImplementation(async () => {
			commandStarted.resolve();
			await commandGate.promise;
			return {
				id: "refine_accepted",
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				appliedEdits: [],
				harnessStatePath: "/tmp/harness_state.json",
			};
		});

		await harness.session.promptUntilAccepted("/refine --local");
		await commandStarted.promise;
		expect(harness.session.isStreaming).toBe(false);

		commandGate.resolve();
		await harness.session.waitForSessionInputIdle();
	});

	it("keeps the restart checkpoint waiting while a queued session command executes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const commandStarted = createDeferred();
		const commandGate = createDeferred();
		vi.spyOn(harness.session, "refine").mockImplementation(async () => {
			commandStarted.resolve();
			await commandGate.promise;
			return {
				id: "refine_checkpoint",
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				appliedEdits: [],
				harnessStatePath: "/tmp/harness_state.json",
			};
		});
		const pause = harness.session.acquireQueuedWorkPause();
		const completion = harness.session.promptAndWait("/refine --local");
		pause.release();
		await commandStarted.promise;

		let checkpointReleased = false;
		const checkpoint = harness.session.waitForSessionInputCheckpoint().then(() => {
			checkpointReleased = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(checkpointReleased).toBe(false);

		commandGate.resolve();
		await completion;
		await checkpoint;
		expect(checkpointReleased).toBe(true);
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

	it("keeps an injected direct prompt fenced until the injected message starts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.sendCustomMessage(
			{ customType: "earlier-next-turn", content: "earlier", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		const injectedMessage = {
			role: "custom" as const,
			customType: "injected-test",
			content: "injected prompt",
			display: true,
			details: {},
			timestamp: Date.now(),
		};
		const earlierStarted = createDeferred();
		const earlierStartGate = createDeferred();
		const injectedStarted = createDeferred();
		const unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type !== "message_start") return;
			if (event.message === injectedMessage) {
				injectedStarted.resolve();
				return;
			}
			if (event.message.role === "custom" && event.message.customType === "earlier-next-turn") {
				earlierStarted.resolve();
				await earlierStartGate.promise;
			}
		});
		const internals = harness.session as unknown as {
			_promptInjectedMessage(text: string, message: typeof injectedMessage): Promise<void>;
		};

		const prompt = internals._promptInjectedMessage("injected prompt", injectedMessage);
		await earlierStarted.promise;
		let checkpointReleased = false;
		const checkpoint = harness.session.waitForSessionInputCheckpoint().then(() => {
			checkpointReleased = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(checkpointReleased).toBe(false);

		earlierStartGate.resolve();
		await injectedStarted.promise;
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

	it("releases a queued prompt checkpoint after handoff while its turn remains active", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const responseGate = createDeferred<ReturnType<typeof fauxAssistantMessage>>();
		harness.setResponses([() => responseGate.promise]);
		const promptStarted = createDeferred();
		const unsubscribe = harness.session.agent.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") promptStarted.resolve();
		});

		await harness.session.restoreFollowUpMessage("queued prompt");
		expect(harness.session.resumeQueuedWork()).toBe(true);
		await promptStarted.promise;

		await expect(harness.session.waitForSessionInputCheckpoint(AbortSignal.timeout(1000))).resolves.toBeUndefined();
		expect(harness.session.isStreaming).toBe(true);
		responseGate.resolve(fauxAssistantMessage("done"));
		await harness.session.waitForIdle();
		unsubscribe();
	});

	it("cancels an invisible idle prompt aborted during preparation", async () => {
		const preparationReached = createDeferred();
		const preparationGate = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						preparationReached.resolve();
						await preparationGate.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const prompt = harness.session.prompt("aborted prompt");
		await preparationReached.promise;

		const abort = harness.session.abort();
		preparationGate.resolve();
		await abort;

		await expect(prompt).rejects.toThrow("Prompt aborted before delivery.");
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [] });
		await harness.session.prompt("next prompt");
		expect(getUserTexts(harness)).toEqual(["next prompt"]);
	});

	it("rejects an invisible prompt cancelled after a handoff rollback", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dispatchReached = createDeferred<void>();
		const rejectDispatch = createDeferred<void>();
		vi.spyOn(harness.session.agent, "prompt").mockImplementationOnce(async () => {
			dispatchReached.resolve();
			await rejectDispatch.promise;
			throw new Error("handoff interrupted");
		});
		const prompt = harness.session.promptUntilAccepted("rolled back prompt");
		const outcome = prompt.then(
			() => ({ error: undefined }),
			(error: unknown) => ({ error }),
		);
		await dispatchReached.promise;

		harness.session.requestAbort();
		rejectDispatch.resolve();
		await harness.session.waitForSessionInputIdle();
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(1);
		harness.session.requestAbort();

		expect((await outcome).error).toEqual(expect.objectContaining({ message: "Prompt aborted before delivery." }));
		await harness.session.waitForSessionInputIdle();
	});

	it("aborts while a queued prompt is still preparing without consuming its snapshot", async () => {
		const preparationReached = createDeferred();
		const preparationGate = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						preparationReached.resolve();
						await preparationGate.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.restoreFollowUpMessage("queued prompt");
		expect(harness.session.resumeQueuedWork()).toBe(true);
		await preparationReached.promise;
		const controller = new AbortController();

		const checkpoint = harness.session.waitForSessionInputCheckpoint(controller.signal);
		controller.abort();

		await expect(checkpoint).rejects.toThrow("Update restart preparation cancelled");
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["queued prompt"] });
		preparationGate.resolve();
		await harness.session.waitForIdle();
	});

	it("aborts while an extension event is pending without flushing or cancelling its queue", async () => {
		const extensionReached = createDeferred();
		const extensionGate = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_start", async (event) => {
						if (event.message.role !== "user") return;
						extensionReached.resolve();
						await extensionGate.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const prompt = harness.session.prompt("pending extension event");
		await extensionReached.promise;
		const eventQueue = (harness.session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;
		let queueDrained = false;
		void eventQueue.then(() => {
			queueDrained = true;
		});
		const flushNow = vi.spyOn(harness.sessionManager, "flushNow");
		const controller = new AbortController();

		const checkpoint = harness.session.waitForSessionInputCheckpoint(controller.signal);
		controller.abort();

		await expect(checkpoint).rejects.toThrow("Update restart preparation cancelled");
		expect(queueDrained).toBe(false);
		expect(flushNow).not.toHaveBeenCalled();
		extensionGate.resolve();
		await prompt;
		await eventQueue;
		expect(queueDrained).toBe(true);
		expect(flushNow).not.toHaveBeenCalled();
	});

	it("propagates a snapshotted event queue rejection without flushing", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		(harness.session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue = Promise.reject(
			new Error("event queue failed"),
		);
		const flushNow = vi.spyOn(harness.sessionManager, "flushNow");

		await expect(harness.session.waitForSessionInputCheckpoint()).rejects.toThrow("event queue failed");
		expect(flushNow).not.toHaveBeenCalled();
	});

	it("releases the injected action checkpoint when dispatch fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_promptInjectedMessage(
				text: string,
				message: {
					role: "custom";
					customType: string;
					content: string;
					display: boolean;
					details: Record<string, never>;
					timestamp: number;
				},
			): Promise<void>;
		};
		vi.spyOn(harness.session.agent, "prompt").mockRejectedValue(new Error("dispatch failed"));

		await expect(
			internals._promptInjectedMessage("injected prompt", {
				role: "custom",
				customType: "injected-test",
				content: "injected prompt",
				display: true,
				details: {},
				timestamp: Date.now(),
			}),
		).rejects.toThrow("dispatch failed");

		// A leaked section would keep update-restart checkpoints waiting forever.
		await expect(harness.session.waitForSessionInputCheckpoint(AbortSignal.timeout(1000))).resolves.toBeUndefined();
	});

	it("releases the prompt action checkpoint when dispatch fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		vi.spyOn(harness.session.agent, "prompt").mockRejectedValue(new Error("dispatch failed"));

		await expect(harness.session.prompt("ordinary prompt")).rejects.toThrow("dispatch failed");
		await expect(harness.session.waitForSessionInputCheckpoint(AbortSignal.timeout(1000))).resolves.toBeUndefined();
	});

	it("throws when prompting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.prompt("hi")).rejects.toThrow("No model selected.");
	});

	it("throws when prompting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const surfacedErrors: string[] = [];
		harness.session.bindExtensions({ onError: (error) => surfacedErrors.push(error.error) });

		await expect(harness.session.prompt("hi")).rejects.toThrow(
			`No API key found for ${harness.getModel().provider}.`,
		);
		expect(surfacedErrors).toEqual([]);
	});

	it("rejects promptUntilAccepted when validation fails", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.promptUntilAccepted("hi")).rejects.toThrow(
			`No API key found for ${harness.getModel().provider}.`,
		);
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
