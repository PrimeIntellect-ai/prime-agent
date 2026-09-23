import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import type { AgentSession } from "../../src/core/agent-session.js";
import type { ExtensionFactory } from "../../src/core/extensions/types.js";
import { convertToLlm } from "../../src/core/messages.js";
import { getLocalHarnessStateDir, loadHarnessState, saveHarnessState } from "../../src/core/refinement/index.js";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.js";
import { createDeferred } from "./scheduling.js";

type SessionCompactionInternals = {
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		queueAutonomousContinuation?: boolean,
	) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => Promise<void>;
	_shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	_performCompaction: (options: unknown) => Promise<unknown>;
	_persistCompactionOutcome: (
		reason: "overflow" | "threshold" | "requested",
		outcome: "skipped" | "cancelled" | "failed",
		message: string,
	) => void;
	_schedulePostCompactionContinue: () => void;
	_continueAfterThresholdCompaction: boolean;
	_pendingRequestedCompaction?: object;
};

function internalsOf(harness: Harness): SessionCompactionInternals {
	return harness.session as unknown as SessionCompactionInternals;
}

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	} = {},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp ?? Date.now(),
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function userMessage(text: string, timestamp: number) {
	return { role: "user", content: [{ type: "text", text }], timestamp } satisfies AgentMessage;
}

function largeToolResult(): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "large-context",
		content: [{ type: "text", text: "x".repeat(800_000) }],
		isError: false,
		timestamp: Date.now() + 500,
	};
}

/** Extension that supplies compaction content so no provider call is needed. */
function extensionCompaction(summary = "auto compacted"): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", async (event) => ({
			compaction: {
				summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { source: "extension" },
			},
		}));
	};
}

function failingGateCommand(): string {
	return `${process.execPath} -e "console.error('gate failed'); process.exit(1)"`;
}

const autonomousGateConfig = {
	enabled: true,
	maxContinuations: 2,
	maxTurns: 100,
	gates: { commands: [failingGateCommand()], maxRetries: 5 },
};

/** Model window small enough that one oversized tool result crosses the threshold. */
const thresholdOptions = {
	settings: { compaction: { enabled: true, reserveTokens: 1000 } },
	models: [{ id: "faux-1", contextWindow: 200_000 }],
} satisfies HarnessOptions;

const bigTool = {
	name: "big",
	label: "big",
	description: "returns big text",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "x".repeat(40_000) }], details: {} }),
};

/** Faux ipython tool that services goal.* host requests like the real kernel bridge. */
function createFauxIpythonTool(sessionRef: { current?: AgentSession }) {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python code in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId: string, params: unknown) => {
			const session = sessionRef.current;
			if (!session) throw new Error("test session is not initialized");
			const code = (params as { code: string }).code.trim();
			let text = "";
			if (code.startsWith("goal.")) {
				const spaceIndex = code.indexOf(" ");
				const type = spaceIndex < 0 ? code : code.slice(0, spaceIndex);
				const payload = spaceIndex < 0 ? {} : JSON.parse(code.slice(spaceIndex + 1));
				text = JSON.stringify(session.handleGoalHostRequest(type, payload));
			}
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	};
}

function setStreaming(harness: Harness, streaming: boolean): void {
	(harness.session.agent.state as { isStreaming: boolean }).isStreaming = streaming;
}

describe("AgentSession compaction", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	/** Tool-loop turn whose trailing tool result pushes the context past the threshold. */
	function midToolLoopContext(harness: Harness): ShouldStopAfterTurnContext {
		const assistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 250_000 });
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "big",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const messages: AgentMessage[] = [userMessage("hello", Date.now() - 1000), assistant, toolResult];
		harness.session.agent.state.messages = messages;
		return {
			message: assistant,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [assistant, toolResult],
		};
	}

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction("summary from extension")],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const result = await harness.session.compact();

		expect(result.summary).toBe("summary from extension");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("hands session_before_compact a branch snapshot that later appends do not change", async () => {
		let capturedBranchEntries: SessionEntry[] | undefined;
		let capturedLength = -1;
		let appendedEntryId: string | undefined;
		let harness: Harness;
		harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						// getBranch() serves the live leaf-branch cache, so the event must
						// carry a snapshot: an append while this handler is awaited must
						// not show up in the branch the extension received.
						capturedBranchEntries = event.branchEntries;
						capturedLength = event.branchEntries.length;
						appendedEntryId = harness.sessionManager.appendCustomMessageEntry(
							"branch_snapshot_probe",
							"appended during compaction",
							false,
						);
						return {
							compaction: {
								summary: "summary from extension",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "extension" },
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.compact();

		expect(appendedEntryId).toBeDefined();
		// The snapshot never grew in place when the append landed...
		expect(capturedBranchEntries).toHaveLength(capturedLength);
		expect(capturedBranchEntries?.map((entry) => entry.id)).not.toContain(appendedEntryId);
		// ...while the live branch did grow: the probe entry and the compaction are on it.
		const liveBranch = harness.sessionManager.getBranch();
		expect(liveBranch).not.toBe(capturedBranchEntries);
		expect(liveBranch.map((entry) => entry.id)).toContain(appendedEntryId);
		expect(liveBranch.length).toBeGreaterThan(capturedBranchEntries!.length);
	});

	it("compacts through the model summarizer, persists metadata, emits events, and remains usable", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("model-generated summary"),
			fauxAssistantMessage("model-generated turn summary"),
			fauxAssistantMessage("still usable"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const usageBeforeCompaction = harness.session.getOwnUsageSummary();

		const result = await harness.session.compact();
		const entry = harness.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");

		expect(result.tokensBefore).toBeGreaterThan(0);
		expect(result.firstKeptEntryId).toBeTruthy();
		expect(entry).toMatchObject({
			type: "compaction",
			summary: expect.stringContaining("model-generated summary"),
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			fromHook: false,
		});
		const compactionUsage = (entry as { usage: Usage }).usage;
		expect(compactionUsage.input).toBeGreaterThan(0);
		expect(compactionUsage.output).toBeGreaterThan(0);
		// Own spend grows by exactly what the compaction entry recorded.
		const ownUsage = harness.session.getOwnUsageSummary();
		expect((ownUsage?.inputTokens ?? 0) - (usageBeforeCompaction?.inputTokens ?? 0)).toBe(
			compactionUsage.input + compactionUsage.cacheRead + compactionUsage.cacheWrite,
		);
		expect((ownUsage?.outputTokens ?? 0) - (usageBeforeCompaction?.outputTokens ?? 0)).toBe(compactionUsage.output);
		expect((ownUsage?.cost ?? 0) - (usageBeforeCompaction?.cost ?? 0)).toBeCloseTo(compactionUsage.cost.total);
		expect(harness.session.messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("model-generated summary"),
		});
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "manual" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "manual",
				result: expect.objectContaining({ tokensBefore: result.tokensBefore }),
				aborted: false,
				willRetry: false,
			}),
		]);

		await harness.session.prompt("after compaction");
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("prepends the harness digest to the compaction head message on initial and update-merge compactions", async () => {
		// Hermetic global store: the ambient developer harness would crowd the
		// ranked digest window and hide the local fixture entry.
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		const agentDir = join(tmpdir(), `pi-compaction-digest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		tempDirs.push(agentDir);
		process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
		onTestFinished(() => {
			if (previousAgentDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		vi.stubEnv(ENV_AGENT_DIR, harness.tempDir);
		const summarizerInputs: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			(context) => {
				summarizerInputs.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("first summary");
			},
			(context) => {
				summarizerInputs.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("first turn summary");
			},
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		// Written after construction: the compaction digest must be a fresh disk read.
		const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir());
		expect(localDir).toBeDefined();
		const state = loadHarnessState(localDir, "local");
		state.entries.memory.compaction_test_memory = {
			id: "compaction_test_memory",
			kind: "memory",
			title: "Compaction test memory",
			content: "Written before compaction.",
			path: "general",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "refine",
			created_at: "2026-09-07T00:00:00.000Z",
			updated_at: "2026-09-07T00:00:00.000Z",
			version: 1,
		};
		saveHarnessState(localDir!, state);

		await harness.session.compact();

		const head = harness.session.messages[0];
		const digest = (head as { harnessDigest?: string }).harnessDigest;
		expect(digest).toContain("[local:compaction_test_memory] Compaction test memory");
		// Mechanical attachment: the digest never flows through the summarizer.
		expect(summarizerInputs.length).toBeGreaterThan(0);
		for (const input of summarizerInputs) {
			expect(input).not.toContain("# Continual Harness State");
		}
		expect((head as { summary: string }).summary).not.toContain("# Continual Harness State");
		// Memories-first rendering in LLM context: digest preamble before the summary wrapper.
		const text = getMessageText(convertToLlm([head!])[0]);
		expect(text.indexOf("[harness-digest]")).toBe(0);
		expect(text.indexOf("# Continual Harness State")).toBeLessThan(text.indexOf("[compaction-summary]"));

		// Update-merge path: the second compaction head carries the digest too.
		harness.setResponses([
			fauxAssistantMessage("three response"),
			fauxAssistantMessage("merged summary"),
			fauxAssistantMessage("merged turn summary"),
		]);
		await harness.session.prompt("three");
		await harness.session.compact();
		expect((harness.session.messages[0] as { harnessDigest?: string }).harnessDigest).toContain(
			"[local:compaction_test_memory] Compaction test memory",
		);
	});

	it.each([
		{
			name: "manual",
			run: (harness: Harness) => harness.session.compact(undefined, { skipAbort: true }),
		},
		{
			name: "auto",
			run: (harness: Harness) => internalsOf(harness)._runAutoCompaction("threshold", false),
		},
	])("waits for active $name compaction before continuing", async ({ run }) => {
		const compactionStarted = createDeferred();
		const compactionRelease = createDeferred();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionStarted.resolve();
						await compactionRelease.promise;
						return {
							compaction: {
								summary: "summary from extension",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "extension" },
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const pause = harness.session.acquireQueuedWorkPause();
		const continueAgent = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		internalsOf(harness)._schedulePostCompactionContinue();

		const compaction = run(harness);
		await compactionStarted.promise;
		pause.release();
		await new Promise<void>(setImmediate);
		expect(continueAgent).not.toHaveBeenCalled();

		compactionRelease.resolve();
		await compaction;
		await harness.session.waitForHeadlessIdle();
		expect(continueAgent).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			name: "no model is selected",
			options: {} as HarnessOptions,
			prepare: (harness: Harness) => {
				harness.session.agent.state.model = undefined as unknown as Model<any>;
				return "No model selected";
			},
		},
		{
			name: "auth is not configured",
			options: { withConfiguredAuth: false } as HarnessOptions,
			prepare: (harness: Harness) => `No API key found for ${harness.getModel().provider}.`,
		},
	])("throws when compacting while $name", async ({ options, prepare }) => {
		const harness = await createHarness(options);
		harnesses.push(harness);
		const expected = prepare(harness);

		await expect(harness.session.compact()).rejects.toThrow(expected);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	// Threshold decision matrix: which assistant messages trigger auto-compaction.
	it.each([
		{
			name: "an error message backed by the last successful usage",
			options: {} as HarnessOptions,
			triggers: true,
			setup: (harness: Harness) => {
				const successful = createAssistant(harness, { stopReason: "stop", totalTokens: 190_000 });
				const failed = createAssistant(harness, {
					stopReason: "error",
					errorMessage: "529 overloaded",
					timestamp: Date.now() + 1000,
				});
				harness.session.agent.state.messages = [
					userMessage("hello", Date.now() - 1000),
					successful,
					userMessage("retry", Date.now() + 500),
					failed,
				];
				return failed;
			},
		},
		{
			name: "trailing context beyond the model window",
			options: thresholdOptions as HarnessOptions,
			triggers: true,
			setup: (harness: Harness) => {
				const successful = createAssistant(harness, { stopReason: "stop", totalTokens: 10_000 });
				harness.session.agent.state.messages = [
					userMessage("hello", Date.now() - 1000),
					successful,
					{
						role: "custom",
						customType: "large-context",
						content: [{ type: "text", text: "x".repeat(800_000) }],
						display: false,
						timestamp: Date.now() + 500,
					},
				];
				return successful;
			},
		},
		{
			name: "an error message with no prior usage",
			options: {} as HarnessOptions,
			triggers: false,
			setup: (harness: Harness) => {
				const failed = createAssistant(harness, { stopReason: "error", errorMessage: "529 overloaded" });
				harness.session.agent.state.messages = [userMessage("hello", Date.now() - 1000), failed];
				return failed;
			},
		},
		{
			name: "usage from before the latest compaction boundary",
			options: {} as HarnessOptions,
			triggers: false,
			setup: (harness: Harness) => {
				const stale = createAssistant(harness, {
					stopReason: "stop",
					totalTokens: 610_000,
					timestamp: Date.now() - 10_000,
				});
				harness.sessionManager.appendMessage(userMessage("before compaction", Date.now() - 11_000));
				harness.sessionManager.appendMessage(stale);
				harness.sessionManager.appendCompaction(
					"summary",
					harness.sessionManager.getEntries()[0]!.id,
					stale.usage.totalTokens,
					undefined,
					false,
				);
				harness.sessionManager.appendMessage(userMessage("after compaction", Date.now()));
				return stale;
			},
		},
		{
			name: "usage below the threshold",
			options: thresholdOptions as HarnessOptions,
			triggers: false,
			setup: (harness: Harness) => createAssistant(harness, { stopReason: "stop", totalTokens: 1_000 }),
		},
		{
			name: "compaction disabled in settings",
			options: { settings: { compaction: { enabled: false } } } as HarnessOptions,
			triggers: false,
			setup: (harness: Harness) => createAssistant(harness, { stopReason: "stop", totalTokens: 1_000_000 }),
		},
	])("threshold compaction with $name: $triggers", async ({ options, triggers, setup }) => {
		const harness = await createHarness(options);
		harnesses.push(harness);
		const internals = internalsOf(harness);
		const message = setup(harness);
		const runAutoCompaction = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue();

		await internals._checkCompaction(message, false);

		if (triggers) {
			expect(runAutoCompaction).toHaveBeenCalledWith("threshold", false);
		} else {
			expect(runAutoCompaction).not.toHaveBeenCalled();
		}
	});

	it("stops a tool loop for threshold compaction before the next model call", async () => {
		const harness = await createHarness(thresholdOptions);
		harnesses.push(harness);
		const successful = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });
		const toolResult = largeToolResult();
		const messages: AgentMessage[] = [userMessage("hello", Date.now() - 1000), successful, toolResult];
		harness.session.agent.state.messages = messages;

		const shouldStop = await internalsOf(harness)._shouldStopAfterTurn({
			message: successful,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [successful, toolResult],
		});

		expect(shouldStop).toBe(true);
	});

	it.each([
		{ name: "post-turn", queueAutonomousContinuation: true, continuationsUsed: 1 },
		{ name: "pre-prompt", queueAutonomousContinuation: false, continuationsUsed: 0 },
	])(
		"queues $continuationsUsed autonomous gate continuation(s) for $name threshold compaction",
		async ({ queueAutonomousContinuation, continuationsUsed }) => {
			const harness = await createHarness({
				...thresholdOptions,
				autonomous: autonomousGateConfig,
				settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			});
			harnesses.push(harness);
			const internals = internalsOf(harness);
			const successful = createAssistant(harness, { stopReason: "stop", totalTokens: 10_000 });
			harness.session.agent.state.messages = [
				userMessage("hello", Date.now() - 1000),
				successful,
				largeToolResult(),
			];
			const runCompaction = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue();
			const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

			await internals._checkCompaction(successful, false, queueAutonomousContinuation);

			expect(runCompaction).toHaveBeenCalledWith("threshold", false);
			// The continuation is held for the post-compaction runner, never queued on the agent.
			expect(followUpSpy).not.toHaveBeenCalled();
			expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(continuationsUsed);
			if (continuationsUsed > 0) {
				expect(harness.session.getFollowUpMessages()[0] ?? "").toContain(
					"Autonomous quality gate failed (attempt 1/5)",
				);
			}
		},
	);

	it("queues a failing autonomous gate continuation before threshold compaction stops a tool loop", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			...thresholdOptions,
			autonomous: autonomousGateConfig,
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		const internals = internalsOf(harness);
		const successful = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });
		const toolResult = largeToolResult();
		const oldUser = userMessage("old", Date.now() - 3000);
		const oldAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: Date.now() - 2000,
		});
		const currentUser = userMessage("hello", Date.now() - 1000);
		const messages: AgentMessage[] = [currentUser, successful, toolResult];
		for (const message of [oldUser, oldAssistant, currentUser, successful]) {
			harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = [oldUser, oldAssistant, ...messages];

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		const shouldStop = await internals._shouldStopAfterTurn({
			message: successful,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [successful, toolResult],
		});

		expect(shouldStop).toBe(true);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		expect(harness.session.getFollowUpMessages()[0] ?? "").toContain("gate failed");

		// The compaction consumes the queued continuation instead of resuming the loop.
		await internals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("waits for threshold-compaction autonomous continuations before finishing prompt", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			...thresholdOptions,
			autonomous: { ...autonomousGateConfig, maxContinuations: 1 },
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			{ ...fauxAssistantMessage("done"), usage: createUsage(10_000) },
			fauxAssistantMessage("retry"),
		]);
		const promptPromise = harness.session.prompt("make the change");

		await vi.waitFor(() => expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await promptPromise;

		expect(harness.session.getAutonomousStatus()).toMatchObject({ continuationsUsed: 1, turnsUsed: 2 });
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = internalsOf(harness);
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
		});
		const runAutoCompactionSpy = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue();
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await internals._checkCompaction(overflowMessage);
		await internals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });
		await internals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 2 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		const message =
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
		expect(compactionErrors).toContain(message);
		// The failure is disclosed exactly once as a durable custom message.
		expect(
			harness.session.messages.filter(
				(entry) =>
					entry.role === "custom" && entry.customType === "compaction_outcome" && entry.content === message,
			),
		).toHaveLength(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			details: { reason: "overflow", outcome: "failed" },
		});
	});

	it("emits a warning and persists the outcome outside model context when auto-compaction has nothing to summarize", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		const endEvents: Array<{ errorMessage?: string; errorSeverity?: string }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				expect(harness.session.messages.at(-1)).toMatchObject({ customType: "compaction_outcome" });
				endEvents.push({ errorMessage: event.errorMessage, errorSeverity: event.errorSeverity });
			}
		});

		await internalsOf(harness)._runAutoCompaction("threshold", false);

		expect(endEvents).toHaveLength(1);
		expect(endEvents[0].errorSeverity).toBe("warning");
		// The unsuccessful outcome is a durable custom message that stays out of model context.
		const outcome = harness.session.messages.at(-1);
		expect(outcome).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: endEvents[0].errorMessage,
			display: true,
			details: { reason: "threshold", outcome: "skipped" },
		});
		expect(harness.session.agent.convertToLlm([outcome!])).toEqual([]);
	});

	it("rolls back failed outcome persistence without breaking the persisted branch", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("persisted response")]);
		await harness.session.prompt("persist this turn");

		const internals = internalsOf(harness);
		const sessionFile = harness.sessionManager.getSessionFile()!;
		const persistedLeafId = harness.sessionManager.getLeafId();
		const persistedEntries = harness.sessionManager.getEntries();
		vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			appendFileSync(sessionFile, '{"type":"custom_message"');
			throw new Error("disk full");
		});

		expect(() =>
			internals._persistCompactionOutcome("requested", "failed", "Requested compaction failed"),
		).not.toThrow();
		// The live outcome message discloses that it was not saved.
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			details: { reason: "requested", outcome: "failed" },
		});
		// In-memory state is fully rolled back: no outcome entry, same leaf and entries.
		expect(harness.sessionManager.getLeafId()).toBe(persistedLeafId);
		expect(harness.sessionManager.getEntries()).toEqual(persistedEntries);

		// The next append attaches to the persisted leaf and rewrites a coherent file.
		const nextId = harness.sessionManager.appendCustomEntry("after_failed_outcome");
		const reloaded = SessionManager.open(sessionFile);
		expect(reloaded.getEntry(nextId)?.parentId).toBe(persistedLeafId);
		expect(reloaded.getBranch().map((entry) => entry.id)).toEqual(
			harness.sessionManager.getBranch().map((entry) => entry.id),
		);
		expect(reloaded.getEntries()).not.toContainEqual(
			expect.objectContaining({ type: "custom_message", customType: "compaction_outcome" }),
		);
		// The unpersisted disclosure survives context rebuilds and stays ordered
		// before later turns (e.g. thinking toggle rebuilds).
		await new Promise((resolve) => setTimeout(resolve, 5));
		harness.setResponses([fauxAssistantMessage("later response")]);
		await harness.session.prompt("later turn");
		const rebuilt = harness.session.buildSessionContext().messages;
		const outcomeIndex = rebuilt.findIndex(
			(message) => message.role === "custom" && message.customType === "compaction_outcome",
		);
		const laterTurnIndex = rebuilt.findIndex(
			(message) => message.role === "user" && getMessageText(message).includes("later turn"),
		);
		expect(outcomeIndex).toBeGreaterThanOrEqual(0);
		expect(laterTurnIndex).toBeGreaterThan(outcomeIndex);
	});

	it("keeps an unpersisted outcome in agent state after a successful compaction", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction("post-failure summary")],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one response"), fauxAssistantMessage("two response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		internalsOf(harness)._persistCompactionOutcome("requested", "failed", "Requested compaction failed");

		// Compaction reloads agent.state.messages from the session file; the
		// memory-only disclosure must survive.
		await harness.session.compact();

		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "custom", customType: "compaction_outcome" }),
		);
	});

	// Regression (BUG A): a compaction that stopped a tool loop but produced nothing
	// must still resume the interrupted loop.
	it.each([
		{ reason: "threshold" as const, fromThresholdStop: true },
		{ reason: "requested" as const, fromThresholdStop: false },
	])(
		"resumes the interrupted tool loop when a $reason compaction is skipped",
		async ({ reason, fromThresholdStop }) => {
			vi.useFakeTimers();
			const harness = await createHarness(thresholdOptions);
			harnesses.push(harness);
			const internals = internalsOf(harness);
			const context = midToolLoopContext(harness);

			if (fromThresholdStop) {
				// toolResult-last stops the loop for compaction AND marks it for resume.
				expect(await internals._shouldStopAfterTurn(context)).toBe(true);
				expect(internals._continueAfterThresholdCompaction).toBe(true);
			} else {
				internals._continueAfterThresholdCompaction = true;
			}
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

			// The in-memory session has no persisted entries, so the compaction is skipped.
			await internals._runAutoCompaction(reason, false);
			await vi.advanceTimersByTimeAsync(500);

			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(continueSpy).toHaveBeenCalledTimes(1);
		},
	);

	it("e2e: a tool loop interrupted by a skipped threshold compaction resumes", async () => {
		const harness = await createHarness({
			tools: [bigTool],
			// Huge keepRecentTokens: preparation finds nothing to summarize and skips.
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1_000_000 } },
			models: [{ id: "faux-1", contextWindow: 6_000 }],
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer after the tool call"),
		]);

		await harness.session.prompt("run the tool then summarize");
		await harness.session.waitForHeadlessIdle();
		expect(harness.getPendingResponseCount()).toBe(0);

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toContain("threshold");
		expect(harness.eventsOfType("compaction_end")[0]?.errorMessage).toContain("skipped");
	});

	it("e2e: headless idle includes a successful post-compaction continuation", async () => {
		const harness = await createHarness({
			tools: [bigTool],
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 6_000 }],
			persistSession: true,
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer after successful compaction"),
		]);

		await harness.session.prompt("run the tool then summarize");
		await harness.session.waitForHeadlessIdle();

		expect(harness.eventsOfType("compaction_end").find((event) => event.result)?.result).toBeDefined();
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	// Regression (BUG B): an assistant-text threshold stop reads as "task finished",
	// so an active goal must queue its continuation as a session input before compaction.
	it("e2e: an active goal keeps continuing after a successful threshold compaction", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			// Let a running goal continuation cross the threshold while staying below overflow.
			settings: { compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 10_000 }],
			persistSession: true,
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		sessionRef.current = harness.session;
		const largeStep = "x".repeat(3_500);
		harness.setResponses([
			fauxAssistantMessage(`step one done, more to do ${largeStep}`),
			fauxAssistantMessage(`step two done, still more to do ${largeStep}`),
			fauxAssistantMessage(`step three done, still not finished ${largeStep}`),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "goal.complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");
		await harness.session.waitForHeadlessIdle();
		const compactionReasons = harness.eventsOfType("compaction_start").map((event) => event.reason);
		expect(compactionReasons).toContain("threshold");
		expect(compactionReasons).not.toContain("overflow");
		expect(harness.eventsOfType("compaction_end").find((event) => event.result)?.result).toBeDefined();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.goalState.status).toBe("complete");
	});

	it("queues only the goal continuation when a goal and autonomous mode are both active", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			...thresholdOptions,
			tools: [createFauxIpythonTool(sessionRef)],
			autonomous: { enabled: true, maxContinuations: 5 },
		});
		harnesses.push(harness);
		sessionRef.current = harness.session;
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the task" });
		const internals = internalsOf(harness);

		const shouldStop = await internals._shouldStopAfterTurn(midToolLoopContext(harness));

		expect(shouldStop).toBe(true);
		expect(internals._continueAfterThresholdCompaction).toBe(true);
		// The goal continuation takes exclusive priority over the autonomous one.
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("withdraws the queued goal continuation when the threshold compaction is cancelled", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({ ...thresholdOptions, tools: [createFauxIpythonTool(sessionRef)] });
		harnesses.push(harness);
		sessionRef.current = harness.session;
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the task" });
		const internals = internalsOf(harness);
		const context = midToolLoopContext(harness);

		expect(await internals._shouldStopAfterTurn(context)).toBe(true);
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);

		vi.spyOn(internals, "_performCompaction").mockRejectedValue(new Error("Compaction cancelled"));
		await internals._runAutoCompaction("threshold", false);

		expect(harness.eventsOfType("compaction_end")).toEqual([expect.objectContaining({ aborted: true })]);
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.goalState.continuationsUsed).toBe(0);

		// The cancellation must not consume the continuation: the next threshold stop re-queues it.
		expect(await internals._shouldStopAfterTurn(context)).toBe(true);
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);
	});

	describe("compact skill host requests", () => {
		it.each([
			{ name: "auto-compaction enabled", compaction: { keepRecentTokens: 1 } },
			{ name: "auto-compaction disabled", compaction: { enabled: false, keepRecentTokens: 1 } },
		])("schedules compact.run and compacts at the turn boundary with $name", async ({ compaction }) => {
			const harness = await createHarness({
				settings: { compaction },
				extensionFactories: [extensionCompaction("requested summary")],
			});
			harnesses.push(harness);
			await harness.session.prompt("one");
			await harness.session.prompt("two");

			setStreaming(harness, true);
			const runResult = harness.session.handleCompactHostRequest("compact.run", {
				instructions: "keep the plan",
			});
			setStreaming(harness, false);
			expect(runResult.scheduled).toBe(true);
			expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(true);

			const internals = internalsOf(harness);
			// The request stops the loop at the turn boundary, then compacts there.
			await expect(
				internals._shouldStopAfterTurn({ message: createAssistant(harness) } as ShouldStopAfterTurnContext),
			).resolves.toBe(true);
			const compacted = await internals._checkCompaction(createAssistant(harness));

			expect(compacted).toBe(false); // no retry needed
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_start").at(-1)).toMatchObject({
				reason: "requested",
				customInstructions: "keep the plan",
			});
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "requested" });
			expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
		});

		it.each([
			{ name: "turn boundary", skipAbortedCheck: true },
			{ name: "pre-prompt path", skipAbortedCheck: false },
		])("drops a pending requested compaction on the $name after an abort", async ({ skipAbortedCheck }) => {
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [extensionCompaction("requested summary")],
			});
			harnesses.push(harness);
			await harness.session.prompt("one");
			await harness.session.prompt("two");

			setStreaming(harness, true);
			expect(harness.session.handleCompactHostRequest("compact.run").scheduled).toBe(true);
			setStreaming(harness, false);

			const compacted = await internalsOf(harness)._checkCompaction(
				createAssistant(harness, { stopReason: "aborted" }),
				skipAbortedCheck,
			);

			expect(compacted).toBe(false);
			expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		});

		it.each([
			{
				name: "there is nothing to compact",
				options: {} as HarnessOptions,
				prompts: ["one"],
				streaming: true,
				expected: { scheduled: false, reason: "session is too short to compact" },
			},
			{
				name: "no turn is active",
				options: {
					settings: { compaction: { keepRecentTokens: 1 } },
					extensionFactories: [extensionCompaction("requested summary")],
				} as HarnessOptions,
				prompts: ["one", "two"],
				streaming: false,
				expected: { scheduled: false, reason: expect.stringContaining("no active turn") },
			},
		])("rejects compact.run when $name", async ({ options, prompts, streaming, expected }) => {
			const harness = await createHarness(options);
			harnesses.push(harness);
			for (const prompt of prompts) {
				await harness.session.prompt(prompt);
			}

			setStreaming(harness, streaming);
			const result = harness.session.handleCompactHostRequest("compact.run");
			setStreaming(harness, false);

			expect(result).toMatchObject(expected);
			const status = harness.session.handleCompactHostRequest("compact.status");
			expect(status.scheduled).toBe(false);
			expect(status.context_window).not.toBeNull();
		});

		it("prioritizes overflow recovery over a pending requested compaction", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [extensionCompaction("requested summary")],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await harness.session.prompt("one");
			await harness.session.prompt("two");

			setStreaming(harness, true);
			expect(
				harness.session.handleCompactHostRequest("compact.run", { instructions: "keep the todo list" }).scheduled,
			).toBe(true);
			setStreaming(harness, false);

			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
			const overflow = createAssistant(harness, { stopReason: "error", errorMessage: "prompt is too long" });
			const compacted = await internalsOf(harness)._checkCompaction(overflow);
			await vi.advanceTimersByTimeAsync(100);

			expect(compacted).toBe(true); // willRetry
			// The overflow run consumes the request, including its instructions.
			expect(harness.eventsOfType("compaction_start").at(-1)).toMatchObject({
				reason: "overflow",
				customInstructions: "keep the todo list",
			});
			expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
			expect(continueSpy).toHaveBeenCalled();
		});

		it("resumes the loop when a requested compaction is skipped", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			harnesses.push(harness);
			await harness.session.prompt("one");

			const internals = internalsOf(harness);
			internals._pendingRequestedCompaction = {};
			harness.session.agent.followUp({
				role: "custom",
				customType: "test",
				content: [{ type: "text", text: "queued" }],
				display: false,
				timestamp: Date.now(),
			});
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

			const compacted = await internals._checkCompaction(createAssistant(harness));
			await vi.advanceTimersByTimeAsync(100);

			expect(compacted).toBe(false);
			expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("skipped");
			expect(continueSpy).toHaveBeenCalledTimes(1);
		});

		it.each([
			{ name: "fails", cancel: true, stillScheduled: true },
			{ name: "succeeds", cancel: false, stillScheduled: false },
		])(
			"pending requested compaction survives ($stillScheduled) when manual compaction $name",
			async ({ cancel, stillScheduled }) => {
				const harness = await createHarness({
					settings: { compaction: { keepRecentTokens: 1 } },
					extensionFactories: [
						cancel
							? (pi) => {
									pi.on("session_before_compact", async () => ({ cancel: true }));
								}
							: extensionCompaction("requested summary"),
					],
				});
				harnesses.push(harness);
				await harness.session.prompt("one");
				await harness.session.prompt("two");

				setStreaming(harness, true);
				expect(harness.session.handleCompactHostRequest("compact.run").scheduled).toBe(true);
				setStreaming(harness, false);

				if (cancel) {
					await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");
				} else {
					await harness.session.compact();
				}

				expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(stillScheduled);
			},
		);

		it("is gated by the compaction.agentCallable setting", async () => {
			const harness = await createHarness({ settings: { compaction: { agentCallable: false } } });
			harnesses.push(harness);

			expect(() => harness.session.handleCompactHostRequest("compact.run")).toThrow(
				"the compact skill is disabled in this session",
			);
		});
	});
});

describe("AgentSession compaction regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("ENG-6011: retries a token-rate-limit rejection without compacting", async () => {
		const harness = await createHarness({
			models: [{ id: "litellm-fixture", contextWindow: 262144, maxTokens: 8192 }],
			settings: {
				autoRefine: { enabled: false },
				compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 50 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Earlier findings recorded.")]);
		await harness.session.prompt("Earlier context. ".repeat(100));
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit: too many tokens" }),
			fauxAssistantMessage("Recovered after rate limit."),
		]);

		await harness.session.prompt("Continue the task.");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Recovered after rate limit.");
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("#3688: clears branch summary state when session_before_tree cancels navigation", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		const currentLeafId = harness.sessionManager.appendMessage(userMsg("second"));
		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);

		const result = await harness.session.navigateTree(targetId, { summarize: false });

		expect(result).toEqual({ cancelled: true });
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);
	});
});
