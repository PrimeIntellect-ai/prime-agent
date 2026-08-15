import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, StreamOptions, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BashExecutionMessage } from "../../../src/core/messages.js";
import {
	type SideQuestionDependencies,
	type SideQuestionEvent,
	startSideQuestion,
} from "../../../src/core/side-question.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import { BashExecutionComponent } from "../../../src/modes/interactive/components/bash-execution.js";
import { SideQuestionComponent } from "../../../src/modes/interactive/components/side-question.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { getEditorTheme, initTheme, theme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText } from "../harness.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function sideQuestionDependencies(harness: Awaited<ReturnType<typeof createHarness>>): SideQuestionDependencies {
	return {
		getCompactionSettings: () => harness.settingsManager.getCompactionSettings(),
		getRequestAuth: (model) => harness.session.getRequestAuth(model),
	};
}

function contextUser(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function contextAssistant(text: string, totalTokens: number): AssistantMessage {
	const message = fauxAssistantMessage(text);
	return {
		...message,
		usage: {
			...message.usage,
			input: totalTokens,
			totalTokens,
		},
	};
}

describe("ENG-4509 side questions", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("uses the current context without tools or session persistence", async () => {
		const harness = await createHarness({ systemPrompt: "Remember relevant project context." });
		try {
			harness.setResponses([fauxAssistantMessage("The codename is kestrel.")]);
			await harness.session.prompt("The project codename is kestrel.");
			harness.session.agent.sessionId = "cache-session";
			const systemPromptBefore = harness.session.agent.state.systemPrompt;
			const messagesBefore = structuredClone(harness.session.messages);
			const entriesBefore = structuredClone(harness.sessionManager.getEntries());
			const events: SideQuestionEvent[] = [];
			let observedTransport: string | undefined;
			let observedSessionId: string | undefined;

			harness.setResponses([
				(context, options) => {
					expect(context.systemPrompt).toBe(systemPromptBefore);
					expect(context.tools).toEqual([]);
					expect(context.messages.map(getMessageText)).toEqual([
						"The project codename is kestrel.",
						"The codename is kestrel.",
						expect.stringContaining("What is the project codename?"),
					]);
					observedTransport = options?.transport;
					observedSessionId = options?.sessionId;
					return fauxAssistantMessage("kestrel");
				},
			]);

			const run = startSideQuestion(
				harness.session.agent,
				"question-1",
				"What is the project codename?",
				(event) => {
					events.push(event);
				},
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "kestrel" });
			expect(observedTransport).toBe("sse");
			expect(observedSessionId).toBe("cache-session");
			expect(harness.session.messages).toEqual(messagesBefore);
			expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		} finally {
			harness.cleanup();
		}
	});

	it("seeds follow-up turns with the prior side conversation and fresh main context", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("main answer")]);
			await harness.session.prompt("Main context message.");

			harness.setResponses([
				(context) => {
					const texts = context.messages.map(getMessageText);
					expect(texts).toEqual([
						"Main context message.",
						"main answer",
						expect.stringContaining("First side question?"),
						"first side answer",
						expect.stringContaining("Second side question?"),
					]);
					expect(context.tools).toEqual([]);
					// Each turn carries the instruction so compaction cannot discard it.
					expect(texts[2]).toContain("Answer this side question");
					expect(texts[4]).toContain("Answer this side question");
					return fauxAssistantMessage("second side answer");
				},
			]);

			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"turn-2",
				"Second side question?",
				(event) => {
					events.push(event);
				},
				[{ question: "First side question?", answer: "first side answer" }],
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "second side answer" });
		} finally {
			harness.cleanup();
		}
	});

	it("leaves under-threshold side-question context unchanged", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 20000 }],
			settings: { compaction: { enabled: true, reserveTokens: 20000, keepRecentTokens: 50 } },
		});
		try {
			harness.session.agent.state.messages = [
				contextUser("small main context"),
				contextAssistant("small main answer", 100),
			];
			const messagesBefore = structuredClone(harness.session.messages);
			harness.setResponses([
				(context) => {
					expect(context.messages.map(getMessageText)).toEqual([
						"small main context",
						"small main answer",
						expect.stringContaining("What is still in context?"),
					]);
					return fauxAssistantMessage("everything");
				},
			]);

			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"under-threshold",
				"What is still in context?",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "everything" });
			expect(harness.session.messages).toEqual(messagesBefore);
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("respects disabled automatic compaction for over-threshold context", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 20000 }],
			settings: { compaction: { enabled: false, reserveTokens: 20000, keepRecentTokens: 50 } },
		});
		try {
			harness.session.agent.state.messages = [
				contextUser("large context remains verbatim"),
				contextAssistant("large answer remains verbatim", 90000),
			];
			harness.setResponses([
				(context) => {
					expect(context.messages.map(getMessageText)).toEqual([
						"large context remains verbatim",
						"large answer remains verbatim",
						expect.stringContaining("Do not compact this side question"),
					]);
					return fauxAssistantMessage("not compacted");
				},
			]);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"disabled-compaction",
				"Do not compact this side question",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "not compacted" });
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("ignores provider-excluded bash output when sizing side context", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 20_000 }],
			settings: { compaction: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 50 } },
		});
		try {
			const excludedBash: BashExecutionMessage = {
				role: "bashExecution",
				command: "dump-noisy-output",
				output: "x".repeat(400_000),
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
				excludeFromContext: true,
			};
			harness.session.agent.state.messages = [
				contextUser("small visible context"),
				contextAssistant("small visible answer", 100),
				excludedBash,
			];
			harness.setResponses([
				(context) => {
					const text = context.messages.map(getMessageText).join("\n");
					expect(text).not.toContain("dump-noisy-output");
					expect(text).toContain("Does excluded output affect sizing?");
					return fauxAssistantMessage("no");
				},
			]);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"excluded-sizing",
				"Does excluded output affect sizing?",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "no" });
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("applies extension context and payload hooks to summary requests", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 20_000 }],
			settings: { compaction: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 50 } },
		});
		try {
			const secret = "extension-redacted-secret";
			harness.session.agent.state.messages = [
				contextUser(`${secret} ${"x".repeat(340_000)}`),
				contextAssistant("large visible answer", 85_000),
			];
			const previousTransform = harness.session.agent.transformContext;
			const transformContext = vi.fn(async (messages: AgentMessage[], signal?: AbortSignal) => {
				const transformed = previousTransform ? await previousTransform(messages, signal) : messages;
				return transformed.filter((message) => !getMessageText(message).includes(secret));
			});
			const onPayload = vi.fn((payload: unknown) => payload);
			let summarySawPayloadHook = false;
			harness.session.agent.transformContext = transformContext;
			harness.session.agent.onPayload = onPayload;
			harness.setResponses(
				Array.from({ length: 12 }, () => (context: Context, options: StreamOptions | undefined) => {
					const text = context.messages.map(getMessageText).join("\n");
					expect(text).not.toContain(secret);
					if (options?.maxTokens !== undefined) {
						expect(options.onPayload).toBe(onPayload);
						summarySawPayloadHook = true;
						return fauxAssistantMessage("redacted context summary");
					}
					return fauxAssistantMessage("hook-safe answer");
				}),
			);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"summary-hooks",
				"Answer without the redacted context",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "hook-safe answer" });
			expect(transformContext).toHaveBeenCalled();
			expect(summarySawPayloadHook).toBe(true);
			expect(harness.faux.state.callCount).toBeGreaterThan(1);
		} finally {
			harness.cleanup();
		}
	});

	it("ignores retained pre-compaction usage when sizing side context", async () => {
		const contextWindow = 32_768;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow, maxTokens: 8_192 }],
			settings: { compaction: { enabled: true } },
		});
		try {
			const compactionTimestamp = Date.now();
			const retainedAssistant = contextAssistant("retained visual answer", 32_000);
			retainedAssistant.timestamp = compactionTimestamp - 1_000;
			const image = { type: "image" as const, data: "retained-image", mimeType: "image/png" as const };
			harness.session.agent.state.messages = [
				{
					role: "compactionSummary",
					summary: "Earlier work was compacted.",
					tokensBefore: 32_000,
					timestamp: compactionTimestamp,
				},
				{
					role: "user",
					content: [{ type: "text", text: `Retain this visual turn ${"v".repeat(40_000)}` }, image],
					timestamp: compactionTimestamp - 2_000,
				},
				retainedAssistant,
				contextUser(`Later removable context ${"r".repeat(60_000)}`),
			];
			const enforcing = (context: Context, options: StreamOptions | undefined) => {
				if (options?.maxTokens !== undefined) return fauxAssistantMessage("bounded stale-context summary");
				const textTokens = Math.ceil(
					context.messages.reduce((total, message) => total + getMessageText(message).length, 0) / 4,
				);
				if (textTokens + 1_200 + 8_192 > contextWindow) {
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "stale usage prevented compaction",
					});
				}
				expect(
					context.messages.some(
						(message) =>
							message.role === "user" &&
							Array.isArray(message.content) &&
							message.content.some((block) => block.type === "image" && block.data === "retained-image"),
					),
				).toBe(true);
				return fauxAssistantMessage("answered from compacted visual context");
			};
			harness.setResponses(Array.from({ length: 12 }, () => enforcing));
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"stale-compaction-usage",
				"What survives the compacted context?",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({
				status: "complete",
				answer: "answered from compacted visual context",
			});
			expect(harness.faux.state.callCount).toBeGreaterThan(1);
		} finally {
			harness.cleanup();
		}
	});

	it("compacts over-threshold context in memory before answering", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 32_768, maxTokens: 8_192 }],
			settings: { compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 50 } },
		});
		try {
			harness.session.agent.state.messages = [
				contextUser(`old request ${"x".repeat(60_000)}`),
				contextAssistant("old answer", 15_100),
				contextUser(`recent request ${"r".repeat(40_000)}`),
				contextAssistant(`recent answer ${"a".repeat(80)}`, 25_200),
			];
			const messagesBefore = structuredClone(harness.session.messages);
			vi.spyOn(harness.session, "getRequestAuth").mockResolvedValue({
				apiKey: "faux-key",
				headers: { "x-side-summary": "present" },
			});
			let summaryCalls = 0;
			const response = (context: Context, options: StreamOptions | undefined) => {
				if (options?.maxTokens !== undefined) {
					summaryCalls++;
					expect(options.headers).toMatchObject({ "x-side-summary": "present" });
					return fauxAssistantMessage(`summary checkpoint ${summaryCalls}`);
				}
				expect(context.tools).toEqual([]);
				return fauxAssistantMessage("compacted answer");
			};
			harness.setResponses(Array.from({ length: 12 }, () => response));

			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"threshold",
				"Answer from the compact context",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "compacted answer" });
			expect(harness.session.messages).toEqual(messagesBefore);
			expect(summaryCalls).toBeGreaterThan(0);
		} finally {
			harness.cleanup();
		}
	});

	it("bounds and chunks side summaries to the selected model context", async () => {
		const contextWindow = 32_768;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow, maxTokens: 8_192 }],
			settings: { compaction: { enabled: true } },
			systemPrompt: "s".repeat(25_000),
		});
		try {
			harness.session.agent.state.messages = [
				contextUser(`old five-thousand-token turn ${"o".repeat(20_000)}`),
				contextAssistant("old answer", 5_000),
				contextUser(`recent twenty-thousand-token turn ${"r".repeat(80_000)}`),
				contextAssistant("recent answer", 25_000),
			];
			let summaryRequests = 0;
			const enforcingSummary = (context: Context, options: StreamOptions | undefined) => {
				summaryRequests++;
				const promptChars =
					(context.systemPrompt?.length ?? 0) +
					context.messages.reduce((total, message) => total + getMessageText(message).length, 0);
				const estimatedInput = Math.ceil(promptChars / 4);
				if (estimatedInput + (options?.maxTokens ?? 0) > contextWindow) {
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "provider rejected oversized summary request",
					});
				}
				return fauxAssistantMessage(`bounded summary ${summaryRequests}`);
			};
			const enforcingRequest = (context: Context, options: StreamOptions | undefined) => {
				if (options?.maxTokens !== undefined) return enforcingSummary(context, options);
				expect(context.messages.map(getMessageText).join("\n")).toContain("bounded summary");
				return fauxAssistantMessage("bounded answer");
			};
			harness.setResponses(Array.from({ length: 12 }, () => enforcingRequest));
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"bounded-summary",
				"Answer after bounded summarization",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;

			expect(summaryRequests).toBeGreaterThan(1);
			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "bounded answer" });
		} finally {
			harness.cleanup();
		}
	});

	it("splits CJK summaries by UTF-8 bytes and bounds the final answer", async () => {
		const contextWindow = 32_768;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow, maxTokens: 8_192 }],
			settings: { compaction: { enabled: true } },
		});
		try {
			harness.session.agent.state.messages = [
				contextUser(`CJK history ${"漢".repeat(30_000)}`),
				contextAssistant("CJK answer", 20_000),
			];
			let summaries = 0;
			const enforcing = (context: Context, options: StreamOptions | undefined) => {
				const promptBytes =
					new TextEncoder().encode(context.systemPrompt ?? "").length +
					context.messages.reduce(
						(total, message) => total + new TextEncoder().encode(getMessageText(message)).length,
						0,
					);
				if (promptBytes + (options?.maxTokens ?? 8_192) > contextWindow) {
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "oversized CJK request" });
				}
				if (options?.maxTokens !== undefined) {
					summaries++;
					return fauxAssistantMessage(`CJK summary ${summaries}`);
				}
				return fauxAssistantMessage("CJK bounded answer");
			};
			harness.setResponses(Array.from({ length: 12 }, () => enforcing));
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"cjk-budget",
				"Answer after CJK compaction",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;
			expect(summaries).toBeGreaterThan(1);
			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "CJK bounded answer" });
		} finally {
			harness.cleanup();
		}
	});

	it("retains image-bearing tool turns verbatim across compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 5_000 }],
			settings: { compaction: { enabled: true, reserveTokens: 5_000, keepRecentTokens: 50 } },
		});
		try {
			const toolCallId = "image-tool-call";
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: "inspect_image",
				content: [{ type: "image", data: "preserved-image-data", mimeType: "image/png" }],
				isError: false,
				timestamp: Date.now(),
			};
			harness.session.agent.state.messages = [
				contextUser(`Inspect this image with the tool. ${"i".repeat(20_000)}`),
				fauxAssistantMessage(fauxToolCall("inspect_image", {}, { id: toolCallId })),
				toolResult,
				contextAssistant("The image was inspected.", 1_000),
				contextUser(`later removable text ${"z".repeat(90_000)}`),
				contextAssistant("later answer", 90_000),
			];
			const imageRequest = (context: Context, options: StreamOptions | undefined) => {
				if (options?.maxTokens !== undefined) return fauxAssistantMessage("later-text summary");

				const retainedCall = context.messages.find(
					(message) =>
						message.role === "assistant" &&
						message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
				);
				const retainedResult = context.messages.find(
					(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
				);
				expect(retainedCall).toBeDefined();
				expect(retainedResult?.content).toEqual([
					{ type: "image", data: "preserved-image-data", mimeType: "image/png" },
				]);
				return fauxAssistantMessage("image-aware answer");
			};
			harness.setResponses(Array.from({ length: 12 }, () => imageRequest));
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"image-context",
				"What did the image show?",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "image-aware answer" });
		} finally {
			harness.cleanup();
		}
	});

	it("keeps removable-gap summaries in chronological position", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 32_768, maxTokens: 8_192 }],
			settings: { compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 500 } },
		});
		try {
			harness.session.agent.state.messages = [
				{
					role: "user",
					content: [
						{ type: "text", text: "PROTECTED_IMAGE_A" },
						{ type: "image", data: "image-a", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				} satisfies UserMessage,
				contextAssistant("A acknowledged", 1_300),
				contextUser(`CORRECTION_B ${"b".repeat(12_000)}`),
				contextAssistant("B acknowledged", 4_400),
				{
					role: "user",
					content: [
						{ type: "text", text: "RETAINED_C" },
						{ type: "image", data: "image-c", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				} satisfies UserMessage,
				contextAssistant("C acknowledged", 25_000),
			];
			let summaryCalls = 0;
			const response = (context: Context, options: StreamOptions | undefined) => {
				if (options?.maxTokens !== undefined) {
					summaryCalls++;
					expect(context.messages.map(getMessageText).join("\n")).toContain("CORRECTION_B");
					return fauxAssistantMessage("SUMMARY_OF_B");
				}
				const texts = context.messages.map(getMessageText);
				const protectedIndex = texts.findIndex((text) => text.includes("PROTECTED_IMAGE_A"));
				const summaryIndex = texts.findIndex((text) => text.includes("SUMMARY_OF_B"));
				const retainedIndex = texts.findIndex((text) => text.includes("RETAINED_C"));
				expect(protectedIndex).toBeGreaterThanOrEqual(0);
				expect(summaryIndex).toBeGreaterThan(protectedIndex);
				expect(retainedIndex).toBeGreaterThan(summaryIndex);
				return fauxAssistantMessage("chronological answer");
			};
			harness.setResponses(Array.from({ length: 8 }, () => response));
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"chronology",
				"Use the corrected chronology",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;
			expect(summaryCalls).toBeGreaterThan(0);
			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "chronological answer" });
		} finally {
			harness.cleanup();
		}
	});

	it("cancels an in-flight side-question summary", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 20000 }],
			settings: { compaction: { enabled: true, reserveTokens: 20000, keepRecentTokens: 50 } },
		});
		const summaryStarted = deferred();
		try {
			harness.session.agent.state.messages = [
				contextUser(`old request ${"x".repeat(600)}`),
				contextAssistant("old answer", 180),
				contextUser(`recent request ${"r".repeat(160)}`),
				contextAssistant(`recent answer ${"a".repeat(80)}`, 90000),
			];
			const messagesBefore = structuredClone(harness.session.messages);
			harness.setResponses([
				async (_context, options) => {
					summaryStarted.resolve();
					await new Promise<void>((resolve) => {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					return fauxAssistantMessage("must not be used");
				},
			]);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"cancel-summary",
				"Cancel while summarizing",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await summaryStarted.promise;
			run.abort();
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "cancelled" });
			expect(harness.session.messages).toEqual(messagesBefore);
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("compacts and retries an overflow only once", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 20000 }],
			settings: { compaction: { enabled: true, reserveTokens: 20000, keepRecentTokens: 50 } },
		});
		try {
			harness.session.agent.state.messages = [
				contextUser(`old request ${"x".repeat(300)}`),
				contextAssistant("old answer", 100),
				contextUser(`recent request ${"r".repeat(160)}`),
				contextAssistant(`recent answer ${"a".repeat(80)}`, 200),
			];
			harness.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Your input exceeds the context window of this model",
				}),
				fauxAssistantMessage("overflow recovery summary"),
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Your input exceeds the context window of this model",
				}),
				fauxAssistantMessage("must not run"),
			]);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"overflow",
				"Trigger the overflow backstop",
				(event) => {
					events.push(event);
				},
				[],
				sideQuestionDependencies(harness),
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({
				status: "error",
				errorMessage: "Your input exceeds the context window of this model",
			});
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("retains side-turn continuity and instructions across compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 32_768, maxTokens: 8_192 }],
			settings: { compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 50 } },
		});
		try {
			harness.session.agent.state.messages = [
				contextUser(`main request ${"x".repeat(100_000)}`),
				contextAssistant("main answer", 25_100),
			];
			let summaryCalls = 0;
			const response = (context: Context, options: StreamOptions | undefined) => {
				if (options?.maxTokens !== undefined) {
					summaryCalls++;
					return fauxAssistantMessage("main-context summary: the chosen color was ultraviolet");
				}
				expect(context.tools).toEqual([]);
				return fauxAssistantMessage("because it was visible");
			};
			harness.setResponses(Array.from({ length: 12 }, () => response));
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"continuity",
				"Why was that color chosen?",
				(event) => {
					events.push(event);
				},
				[{ question: "What color was chosen?", answer: "ultraviolet" }],
				sideQuestionDependencies(harness),
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "because it was visible" });
			expect(summaryCalls).toBeGreaterThan(0);
		} finally {
			harness.cleanup();
		}
	});

	it("can finish while the main agent is still working", async () => {
		const harness = await createHarness();
		const mainStarted = deferred();
		const releaseMain = deferred();
		try {
			harness.setResponses([
				async () => {
					mainStarted.resolve();
					await releaseMain.promise;
					return fauxAssistantMessage("main complete");
				},
				(context) => {
					expect(context.tools).toEqual([]);
					expect(context.messages.map(getMessageText)).toEqual([
						"Run the main task.",
						expect.stringContaining("Can I ask this concurrently?"),
					]);
					return fauxAssistantMessage("yes");
				},
			]);

			const mainRun = harness.session.prompt("Run the main task.");
			await mainStarted.promise;
			const events: SideQuestionEvent[] = [];
			const sideRun = startSideQuestion(
				harness.session.agent,
				"question-2",
				"Can I ask this concurrently?",
				(event) => {
					events.push(event);
				},
			);
			await sideRun.done;

			expect(harness.session.isStreaming).toBe(true);
			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "yes" });
			releaseMain.resolve();
			await mainRun;
		} finally {
			releaseMain.resolve();
			await harness.session.agent.waitForIdle();
			harness.cleanup();
		}
	});

	it("cancels independently of the main agent", async () => {
		const harness = await createHarness();
		const sideStarted = deferred();
		try {
			harness.setResponses([
				async (_context, options) => {
					sideStarted.resolve();
					await new Promise<void>((resolve) => {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					return fauxAssistantMessage("");
				},
			]);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(harness.session.agent, "question-3", "Wait here", (event) => {
				events.push(event);
			});
			await sideStarted.promise;
			run.abort();
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "cancelled" });
			expect(harness.session.isStreaming).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("emits completion at message end and again when the run settles", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("settled answer")]);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(harness.session.agent, "redundant-complete", "Will this settle?", (event) => {
				events.push(event);
			});
			await run.done;

			expect(events.filter((event) => event.status === "complete")).toHaveLength(2);
			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "settled answer" });
		} finally {
			harness.cleanup();
		}
	});

	it("emits a terminal event after a transient event delivery failure", async () => {
		const harness = await createHarness();
		try {
			const events: SideQuestionEvent[] = [];
			let shouldFail = true;
			const run = startSideQuestion(harness.session.agent, "question-4", "Can this recover?", (event) => {
				if (shouldFail) {
					shouldFail = false;
					throw new Error("event delivery failed");
				}
				events.push(event);
			});

			await run.done;

			expect(events).toEqual([expect.objectContaining({ status: "error", errorMessage: "event delivery failed" })]);
		} finally {
			harness.cleanup();
		}
	});

	it("aborts daemon side questions when the session runtime is replaced", () => {
		const clients = [{ id: "client-1" }, { id: "client-2" }];
		const sessionState = {
			activeSessionId: "session-1",
			clients: new Set(clients),
			summaryState: undefined,
			runtime: {
				metadata: { kind: "primary" },
				session: { setCurrentRecap: vi.fn() },
			},
		};
		const abortSideQuestionsFor = vi.fn();
		const fakeThis = Object.assign(Object.create(AgentDaemon.prototype), {
			abortSideQuestionsFor,
			options: { worker: false },
			summarizer: { forget: vi.fn(), seed: vi.fn() },
			rebindCronJobsToState: vi.fn(),
		});
		const refreshReplacedSessionState = (
			AgentDaemon.prototype as unknown as {
				refreshReplacedSessionState(this: typeof fakeThis, state: typeof sessionState): void;
			}
		).refreshReplacedSessionState;

		refreshReplacedSessionState.call(fakeThis, sessionState);

		expect(abortSideQuestionsFor).toHaveBeenCalledTimes(2);
		expect(abortSideQuestionsFor).toHaveBeenNthCalledWith(1, clients[0], "session-1");
		expect(abortSideQuestionsFor).toHaveBeenNthCalledWith(2, clients[1], "session-1");
	});

	it("limits daemon side questions to one run per client and session", () => {
		const client = { id: "client-1" };
		const otherClient = { id: "client-2" };
		const fakeThis = Object.assign(Object.create(AgentDaemon.prototype), {
			sideQuestionRuns: new Map([
				["question-1", { client, activeSessionId: "session-1", run: { abort: vi.fn(), done: Promise.resolve() } }],
			]),
		});
		const hasActiveSideQuestionFor = (
			AgentDaemon.prototype as unknown as {
				hasActiveSideQuestionFor(this: typeof fakeThis, candidate: typeof client, activeSessionId: string): boolean;
			}
		).hasActiveSideQuestionFor;

		expect(hasActiveSideQuestionFor.call(fakeThis, client, "session-1")).toBe(true);
		expect(hasActiveSideQuestionFor.call(fakeThis, client, "session-2")).toBe(false);
		expect(hasActiveSideQuestionFor.call(fakeThis, otherClient, "session-1")).toBe(false);
	});

	it("renders the complete side-question answer", () => {
		const component = new SideQuestionComponent({
			id: "question-4",
			question: "What changed?",
			answer: "First line\n\nSecond line\n\nThird line\n\nFourth line",
			status: "complete",
		});
		const lines = component.render(40);
		const rendered = stripAnsi(lines.join("\n"));
		const blankPopupLine = theme.getPopupBackgroundColor()(" ".repeat(40));

		expect(lines.every((line) => line.includes("\x1b[48"))).toBe(true);
		expect(lines[0]).toBe(blankPopupLine);
		expect(getEditorTheme().autocompleteBackgroundColor?.(" ".repeat(40))).toBe(blankPopupLine);
		expect(rendered).toContain("  /btw  What changed?");
		expect(rendered).not.toContain("  answer");
		expect(rendered).toContain("First line");
		expect(rendered).toContain("Fourth line");
		expect(rendered).not.toContain("…");
	});

	it("renders follow-up turns as standard user bubbles with a visible escape hint", () => {
		const component = new SideQuestionComponent({
			id: "turn-1",
			question: "First?",
			answer: "First answer",
			status: "complete",
		});
		component.addTurn({ id: "turn-2", question: "Second?", answer: "", status: "running" });
		component.update({ id: "turn-2", question: "Second?", answer: "Second answer", status: "complete" });
		const lines = component.render(60);
		const rendered = stripAnsi(lines.join("\n"));

		expect(rendered).toContain("/btw  First?");
		expect(rendered).toContain("First answer");
		expect(rendered).toContain("Second?");
		expect(rendered).not.toContain("↳");
		expect(rendered).toContain("Second answer");
		expect(rendered).toContain("reply to follow up · esc to return to session");
		// The follow-up question is a user-message bubble: its padding rows carry
		// the user-message background rather than the popup surface.
		expect(lines).toContain(theme.getUserMessageBackgroundColor()(" ".repeat(60)));
		const questionLine = lines.find((line) => stripAnsi(line).includes("Second?"));
		expect(questionLine).not.toContain("/btw");
	});

	it("shows a cancel hint while a turn is running", () => {
		const component = new SideQuestionComponent({
			id: "turn-1",
			question: "Still going?",
			answer: "",
			status: "running",
		});
		const rendered = stripAnsi(component.render(60).join("\n"));

		expect(rendered).toContain("esc to cancel and return to session");
	});

	it("mounts bash runs in the pane with the main-thread component and hint gating", () => {
		const component = new SideQuestionComponent({
			id: "turn-1",
			question: "First?",
			answer: "done",
			status: "complete",
		});
		const bash = {
			render: () => ["$ sleep 5", "Running..."],
			invalidate: vi.fn(),
		};
		component.addBash(bash);
		let rendered = stripAnsi(component.render(60).join("\n"));

		// The pane renders whatever the shared bash component renders — no
		// pane-specific bash presentation.
		expect(rendered).toContain("$ sleep 5");
		expect(rendered).toContain("Running...");
		expect(rendered).toContain("esc to cancel and return to session");

		component.finishBash();
		rendered = stripAnsi(component.render(60).join("\n"));
		expect(rendered).toContain("reply to follow up · esc to return to session");

		component.invalidate();
		expect(bash.invalidate).toHaveBeenCalled();
	});

	it("continues the side conversation when the pane is open", async () => {
		const startSideQuestion = vi.fn(async () => {});
		const addTurn = vi.fn();
		const firstTurn = { id: "turn-1", question: "First?", answer: "First answer", status: "complete" as const };
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			activeSideQuestionId: undefined,
			sideQuestionEvent: firstTurn,
			sideQuestionTurns: [firstTurn],
			sideQuestionComponent: { addTurn },
			agentConnection: { startSideQuestion },
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
		});
		const handleSideQuestion = (
			InteractiveMode.prototype as unknown as {
				handleSideQuestion(this: typeof fakeThis, question: string): Promise<void>;
			}
		).handleSideQuestion;

		await handleSideQuestion.call(fakeThis, "And a follow-up?");

		expect(addTurn).toHaveBeenCalledTimes(1);
		expect(startSideQuestion).toHaveBeenCalledWith(expect.any(String), "And a follow-up?", [
			{ question: "First?", answer: "First answer" },
		]);
		expect(fakeThis.sideQuestionTurns).toHaveLength(2);
		expect(fakeThis.activeSideQuestionId).toBe(fakeThis.sideQuestionTurns[1].id);
	});

	it("restores the draft when a follow-up is submitted while a turn is still running", async () => {
		const setText = vi.fn();
		const addToHistory = vi.fn();
		const showWarning = vi.fn();
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			defaultEditor,
			editor: { getText: () => "", setText, addToHistory },
			promptStashState: { stash: undefined },
			clearShortcutGuide: vi.fn(),
			sideQuestionComponent: {},
			activeSideQuestionId: "turn-1",
			showWarning,
		});
		(
			InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof fakeThis): void }
		).setupEditorSubmitHandler.call(fakeThis);

		await defaultEditor.onSubmit?.("Queued follow-up?");

		// The editor clears its buffer before onSubmit fires, so the handler must
		// put the rejected draft back rather than merely skip clearing it.
		expect(setText).toHaveBeenCalledWith("Queued follow-up?");
		expect(addToHistory).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith("Wait for the current side question to finish or cancel it first.");
	});

	it("keeps path-like replies in the side conversation", async () => {
		const handleSideQuestion = vi.fn(async () => {});
		const prompt = vi.fn(async () => {});
		const addToHistory = vi.fn();
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			defaultEditor,
			editor: { getText: () => "", setText: vi.fn(), addToHistory },
			uiServices: { settingsManager: { getTelemetryEnabled: vi.fn(() => false) } },
			promptStashState: { stash: undefined },
			clearShortcutGuide: vi.fn(),
			sideQuestionComponent: {},
			activeSideQuestionId: undefined,
			connectionCommands: [],
			collectImagesFor: () => undefined,
			handleSideQuestion,
			agentConnection: { prompt },
		});
		(
			InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof fakeThis): void }
		).setupEditorSubmitHandler.call(fakeThis);

		await defaultEditor.onSubmit?.("/tmp/report.md can you summarize this?");

		expect(handleSideQuestion).toHaveBeenCalledWith("/tmp/report.md can you summarize this?");
		expect(addToHistory).toHaveBeenCalledWith("/tmp/report.md can you summarize this?");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("rejects slash commands in side conversations with an in-pane notice", async () => {
		const cases = [
			{ text: "/context", connectionCommands: [] },
			{ text: "/btw another question?", connectionCommands: [] },
			{ text: "/mycmd do it", connectionCommands: [{ name: "mycmd", source: "extension", sourceInfo: {} }] },
		];
		for (const { text, connectionCommands } of cases) {
			const handleSideQuestion = vi.fn(async () => {});
			const clearSideQuestion = vi.fn();
			const prompt = vi.fn(async () => {});
			const addTurn = vi.fn();
			const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
			const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
				defaultEditor,
				editor: { getText: () => "", setText: vi.fn(), addToHistory: vi.fn() },
				promptStashState: { stash: undefined },
				clearShortcutGuide: vi.fn(),
				sideQuestionComponent: { addTurn },
				sideQuestionTurns: [],
				activeSideQuestionId: undefined,
				connectionCommands,
				handleSideQuestion,
				clearSideQuestion,
				ui: { requestRender: vi.fn() },
				agentConnection: { prompt },
			});
			(
				InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof fakeThis): void }
			).setupEditorSubmitHandler.call(fakeThis);

			await defaultEditor.onSubmit?.(text);

			expect(addTurn).toHaveBeenCalledWith(
				expect.objectContaining({
					question: text,
					answer:
						"Slash commands are not available in side conversations. Press esc to return to the main thread.",
					status: "complete",
				}),
			);
			// The notice is pane-only: it never seeds follow-up context.
			expect(fakeThis.sideQuestionTurns).toEqual([]);
			expect(handleSideQuestion).not.toHaveBeenCalled();
			expect(clearSideQuestion).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
		}
	});

	it("runs bash inside the side conversation without closing it", async () => {
		const finishBash = vi.fn();
		const clearSideQuestion = vi.fn();
		const executeBash = vi.fn(async () => {});
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			defaultEditor,
			editor: { getText: () => "", setText: vi.fn(), addToHistory: vi.fn() },
			promptStashState: { stash: undefined },
			clearShortcutGuide: vi.fn(),
			sideQuestionComponent: { finishBash },
			sideQuestionTurns: [],
			activeSideQuestionId: undefined,
			connectionCommands: [],
			isBashRunning: () => false,
			clearSideQuestion,
			patchConnectionState: vi.fn(),
			ui: { requestRender: vi.fn() },
			agentConnection: { executeBash },
		});
		(
			InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof fakeThis): void }
		).setupEditorSubmitHandler.call(fakeThis);

		await defaultEditor.onSubmit?.("!ls");

		expect(executeBash).toHaveBeenCalledWith("ls", {
			excludeFromContext: true,
			transient: true,
			runId: expect.any(String),
		});
		expect(clearSideQuestion).not.toHaveBeenCalled();
		expect(fakeThis.sideQuestionBash).toMatchObject({
			runId: expect.any(String),
			input: "!ls",
			seedTranscript: true,
		});

		const finishSideQuestionBash = (
			InteractiveMode.prototype as unknown as {
				finishSideQuestionBash(
					this: typeof fakeThis,
					event: { exitCode?: number; cancelled: boolean; truncated: boolean; errorMessage?: string },
					rawOutput: string,
				): void;
			}
		).finishSideQuestionBash;
		finishSideQuestionBash.call(fakeThis, { exitCode: 0, cancelled: false, truncated: false }, "README.md\nsrc\n");

		expect(finishBash).toHaveBeenCalled();
		// A plain ! run seeds follow-up side questions with the output.
		expect(fakeThis.sideQuestionTurns).toHaveLength(1);
		expect(fakeThis.sideQuestionTurns[0]).toMatchObject({
			question: "!ls",
			answer: "```\nREADME.md\nsrc\n```",
			status: "complete",
		});
		expect(fakeThis.sideQuestionBash).toBeUndefined();
	});

	it("bounds side-bash output before seeding follow-up context", () => {
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			sideQuestionComponent: { finishBash: vi.fn() },
			sideQuestionTurns: [],
			sideQuestionBash: { runId: "side-run-1", input: "!generate-output", seedTranscript: true },
		});
		const finishSideQuestionBash = (
			InteractiveMode.prototype as unknown as {
				finishSideQuestionBash(
					this: typeof fakeThis,
					event: {
						exitCode?: number;
						cancelled: boolean;
						truncated: boolean;
						fullOutputPath?: string;
						errorMessage?: string;
					},
					rawOutput: string,
				): void;
			}
		).finishSideQuestionBash;
		const rawOutput = Array.from({ length: 2101 }, (_, index) => `line-${index}`).join("\n");

		finishSideQuestionBash.call(
			fakeThis,
			{
				exitCode: 0,
				cancelled: false,
				truncated: true,
				fullOutputPath: "/tmp/full-output.log",
			},
			rawOutput,
		);

		const answer = fakeThis.sideQuestionTurns[0].answer;
		expect(answer).not.toContain("line-0\n");
		expect(answer).toContain("line-2100");
		expect(answer).toContain("[Output truncated. Full output: /tmp/full-output.log]");
		expect(Buffer.byteLength(answer)).toBeLessThan(50 * 1024);
	});

	it("uses a safe markdown fence for side-bash output containing backticks", () => {
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			sideQuestionComponent: { finishBash: vi.fn() },
			sideQuestionTurns: [],
			sideQuestionBash: { runId: "side-run-1", input: "!show-fence", seedTranscript: true },
		});
		const finishSideQuestionBash = (
			InteractiveMode.prototype as unknown as {
				finishSideQuestionBash(
					this: typeof fakeThis,
					event: { exitCode?: number; cancelled: boolean; truncated: boolean; errorMessage?: string },
					rawOutput: string,
				): void;
			}
		).finishSideQuestionBash;

		finishSideQuestionBash.call(
			fakeThis,
			{ exitCode: 0, cancelled: false, truncated: false },
			"before\n```\nafter\n",
		);

		expect(fakeThis.sideQuestionTurns[0].answer).toBe("````\nbefore\n```\nafter\n````");
	});

	it("keeps the cancel hint while an earlier turn streams behind a notice", () => {
		const component = new SideQuestionComponent({
			id: "turn-1",
			question: "Still thinking?",
			answer: "",
			status: "running",
		});
		component.addTurn({
			id: "side-notice-1",
			question: "/context",
			answer: "Slash commands are not available in side conversations. Press esc to return to the main thread.",
			status: "complete",
		});
		const rendered = stripAnsi(component.render(60).join("\n"));

		expect(rendered).toContain("esc to cancel and return to session");
		expect(rendered).not.toContain("reply to follow up");
	});

	it("blocks bash while a side question is still streaming", async () => {
		const executeBash = vi.fn(async () => {});
		const addTurn = vi.fn();
		const setText = vi.fn();
		const showWarning = vi.fn();
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			defaultEditor,
			editor: { getText: () => "", setText, addToHistory: vi.fn() },
			promptStashState: { stash: undefined },
			clearShortcutGuide: vi.fn(),
			sideQuestionComponent: { addTurn },
			sideQuestionTurns: [],
			activeSideQuestionId: "turn-1",
			connectionCommands: [],
			isBashRunning: () => false,
			showWarning,
			agentConnection: { executeBash },
		});
		(
			InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof fakeThis): void }
		).setupEditorSubmitHandler.call(fakeThis);

		await defaultEditor.onSubmit?.("!ls");

		expect(setText).toHaveBeenCalledWith("!ls");
		expect(showWarning).toHaveBeenCalledWith("Wait for the current side question to finish or cancel it first.");
		expect(executeBash).not.toHaveBeenCalled();
		expect(addTurn).not.toHaveBeenCalled();
		expect(fakeThis.sideQuestionBash).toBeUndefined();
	});

	it("blocks follow-ups while a side-conversation bash is running", async () => {
		const handleSideQuestion = vi.fn(async () => {});
		const setText = vi.fn();
		const showWarning = vi.fn();
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			defaultEditor,
			editor: { getText: () => "", setText, addToHistory: vi.fn() },
			promptStashState: { stash: undefined },
			clearShortcutGuide: vi.fn(),
			sideQuestionComponent: {},
			sideQuestionTurns: [],
			sideQuestionBash: { runId: "side-run-1", input: "!ls", seedTranscript: true },
			activeSideQuestionId: undefined,
			connectionCommands: [],
			handleSideQuestion,
			showWarning,
		});
		(
			InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof fakeThis): void }
		).setupEditorSubmitHandler.call(fakeThis);

		await defaultEditor.onSubmit?.("what are those files?");

		expect(setText).toHaveBeenCalledWith("what are those files?");
		expect(showWarning).toHaveBeenCalledWith("Wait for the running command to finish or cancel it first.");
		expect(handleSideQuestion).not.toHaveBeenCalled();
	});

	it("rejects image follow-ups on text-only models with an in-pane notice and keeps the draft", async () => {
		const handleSideQuestion = vi.fn(async () => {});
		const addTurn = vi.fn();
		const setText = vi.fn();
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			defaultEditor,
			editor: { getText: () => "", setText, addToHistory: vi.fn() },
			promptStashState: { stash: undefined },
			clearShortcutGuide: vi.fn(),
			sideQuestionComponent: { addTurn },
			sideQuestionTurns: [],
			activeSideQuestionId: undefined,
			connectionCommands: [],
			pastedImages: new Map([[1, { type: "image", data: "abc", mimeType: "image/png" }]]),
			getCurrentModel: () => ({ input: ["text"] }),
			handleSideQuestion,
			ui: { requestRender: vi.fn() },
		});
		(
			InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof fakeThis): void }
		).setupEditorSubmitHandler.call(fakeThis);

		await defaultEditor.onSubmit?.("what is in [image #1]?");

		expect(addTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				question: "what is in [image #1]?",
				answer: "Images are not supported in side conversations. Press esc to return to the main thread.",
				status: "complete",
			}),
		);
		expect(setText).toHaveBeenCalledWith("what is in [image #1]?");
		expect(fakeThis.sideQuestionTurns).toEqual([]);
		expect(handleSideQuestion).not.toHaveBeenCalled();
	});

	it("waits for a pending side bash to claim the slot before aborting it", () => {
		const abortBash = vi.fn(async () => {});
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			sideQuestionEvent: { id: "turn-1", question: "First?", answer: "done", status: "complete" },
			sideQuestionTurns: [],
			sideQuestionComponent: {},
			sideQuestionContainer: new Container(),
			sideQuestionBash: { runId: "side-run-1", input: "!sleep 5", seedTranscript: true },
			sideQuestionBashDiscarded: undefined,
			activeSideQuestionId: undefined,
			agentConnection: { abortBash },
			isInitialized: false,
		});
		const clearSideQuestion = (
			InteractiveMode.prototype as unknown as {
				clearSideQuestion(this: typeof fakeThis, options?: { abort?: boolean }): void;
			}
		).clearSideQuestion;

		clearSideQuestion.call(fakeThis, { abort: true });

		// bash_start may not have been observed yet: the marker must swallow the
		// run's remaining events so cancelled side output never reaches the chat.
		expect(fakeThis.sideQuestionBash).toBeUndefined();
		expect(fakeThis.sideQuestionBashDiscarded).toBe("side-run-1");
		expect(abortBash).not.toHaveBeenCalled();
	});

	it("aborts a side bash immediately after observing its matching start", () => {
		const abortBash = vi.fn(async () => {});
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			sideQuestionEvent: { id: "turn-1", question: "First?", answer: "done", status: "complete" },
			sideQuestionTurns: [],
			sideQuestionComponent: {},
			sideQuestionContainer: new Container(),
			sideQuestionBash: { runId: "side-run-1", input: "!sleep 5", seedTranscript: true },
			sideQuestionBashComponent: {},
			sideQuestionBashDiscarded: undefined,
			activeSideQuestionId: undefined,
			agentConnection: { abortBash },
			isInitialized: false,
		});
		const clearSideQuestion = (
			InteractiveMode.prototype as unknown as {
				clearSideQuestion(this: typeof fakeThis, options?: { abort?: boolean }): void;
			}
		).clearSideQuestion;

		clearSideQuestion.call(fakeThis, { abort: true });

		expect(fakeThis.sideQuestionBashDiscarded).toBe("side-run-1");
		expect(fakeThis.sideQuestionBashComponent).toBeUndefined();
		expect(abortBash).toHaveBeenCalledOnce();
	});

	it("runs side bash through the real pipeline without recording into the session", async () => {
		const harness = await createHarness();
		try {
			const addBash = vi.fn();
			const finishBash = vi.fn();
			const executeBash = (
				command: string,
				options?: { excludeFromContext?: boolean; transient?: boolean; runId?: string },
			) => harness.session.runUserBash(command, options);
			const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
			const chatContainer = new Container();
			const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
				defaultEditor,
				editor: { getText: () => "", setText: vi.fn(), addToHistory: vi.fn() },
				promptStashState: { stash: undefined },
				clearShortcutGuide: vi.fn(),
				sideQuestionComponent: { addBash, finishBash },
				sideQuestionTurns: [],
				sideQuestionEvent: { id: "turn-1", question: "First?", answer: "done", status: "complete" },
				activeSideQuestionId: undefined,
				connectionCommands: [],
				isBashRunning: () => false,
				patchConnectionState: vi.fn(),
				ui: { requestRender: vi.fn() },
				agentConnection: { executeBash },
				// handleEvent preamble stubs
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				updateConnectionStateFromEvent: vi.fn(),
				activityTracker: { handleEvent: vi.fn(), getStatus: () => ({ tokens: 0 }) },
				updateWorkingLoaderMessage: vi.fn(),
				isAgentStreaming: () => false,
				chatContainer,
				pendingMessagesContainer: new Container(),
				pendingBashComponents: [],
			});
			(
				InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof fakeThis): void }
			).setupEditorSubmitHandler.call(fakeThis);
			const handleEvent = (
				InteractiveMode.prototype as unknown as {
					handleEvent(this: typeof fakeThis, event: unknown): Promise<void>;
				}
			).handleEvent;

			// Route real session events through the real handler, like subscribeToAgent does.
			const bashEvents: { type: string; transient?: boolean; runId?: string }[] = [];
			harness.session.subscribe(async (event) => {
				if (event.type === "bash_start" || event.type === "bash_end") {
					bashEvents.push(event);
				}
				await handleEvent.call(fakeThis, event);
			});

			await defaultEditor.onSubmit?.("!echo hello from side");

			// The wire events carry the transient marker and echoed runId, so other
			// clients suppress the run and this client correlates it by identity.
			const runId = bashEvents.at(0)?.runId;
			expect(runId).toEqual(expect.any(String));
			expect(bashEvents).toMatchObject([
				{ type: "bash_start", transient: true, runId },
				{ type: "bash_end", transient: true, runId },
			]);
			// The run mounted the main-thread bash component in the pane, not the chat.
			const component = addBash.mock.calls.at(0)?.[0] as BashExecutionComponent;
			expect(component).toBeInstanceOf(BashExecutionComponent);
			expect(component.getOutput()).toContain("hello from side");
			expect(finishBash).toHaveBeenCalled();
			expect(fakeThis.activeBashComponent).toBeUndefined();
			expect(fakeThis.sideQuestionBash).toBeUndefined();
			expect(fakeThis.sideQuestionTurns).toHaveLength(1);
			expect(fakeThis.sideQuestionTurns[0].answer).toContain("hello from side");
			// Transient: nothing recorded, so reloads cannot resurface the side run.
			expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

			// A normal-mode run of the same command is recorded as usual and lands
			// in the chat like any main-thread bash execution.
			await harness.session.runUserBash("echo main thread");
			expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);
			expect(chatContainer.children.some((child) => child instanceof BashExecutionComponent)).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("releases side-bash state when a resync proves the run ended", async () => {
		const bashComponent = { setComplete: vi.fn() };
		const finishBash = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			sideQuestionBash: { runId: "side-run-1", input: "!sleep 5", seedTranscript: true },
			sideQuestionBashComponent: bashComponent,
			sideQuestionBashDiscarded: undefined,
			sideQuestionComponent: { finishBash },
			activeBashComponent: bashComponent,
			isAgentCompacting: () => false,
			isBashRunning: () => true,
			applyConnectionStateSnapshot: vi.fn(),
			replaceSubagentSummary: vi.fn(),
			getSessionContextFromConnectionSnapshot: vi.fn(() => ({
				messages: [],
				thinkingLevel: "medium",
				model: null,
			})),
			renderSessionContext: vi.fn(async () => {}),
			restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
			refreshConnectionQueue: vi.fn(async () => {}),
			flushCompactionQueue: vi.fn(async () => {}),
			flushPendingBashComponents: vi.fn(),
			updateTerminalTitle: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			syncGoalTray: vi.fn(),
			syncWorkingLoader: vi.fn(),
			getGoalState: () => ({ status: "none" }),
		});
		const renderResyncedSession = (
			InteractiveMode.prototype as unknown as {
				renderResyncedSession(
					this: typeof fakeThis,
					snapshot: {
						state: { isCompacting: boolean; isBashRunning: boolean; isStreaming: boolean };
						messages: [];
					},
				): Promise<void>;
			}
		).renderResyncedSession;

		await renderResyncedSession.call(fakeThis, {
			state: { isCompacting: false, isBashRunning: false, isStreaming: false },
			messages: [],
		});

		expect(bashComponent.setComplete).toHaveBeenCalledWith(undefined, false);
		expect(finishBash).toHaveBeenCalledOnce();
		expect(fakeThis.activeBashComponent).toBeUndefined();
		expect(fakeThis.sideQuestionBash).toBeUndefined();
		expect(fakeThis.sideQuestionBashComponent).toBeUndefined();
	});

	it("re-aborts a discarded side bash when its bash_start arrives late", async () => {
		const abortBash = vi.fn(async () => {});
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			sideQuestionBash: undefined,
			sideQuestionBashDiscarded: "side-run-1",
			activeBashComponent: undefined,
			agentConnection: { abortBash },
			// handleEvent preamble stubs
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			updateConnectionStateFromEvent: vi.fn(),
			activityTracker: { handleEvent: vi.fn(), getStatus: () => ({ tokens: 0 }) },
			updateWorkingLoaderMessage: vi.fn(),
			isAgentStreaming: () => false,
			ui: { requestRender: vi.fn() },
			chatContainer: new Container(),
			pendingMessagesContainer: new Container(),
			pendingBashComponents: [],
		});
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeThis, event: unknown): Promise<void>;
			}
		).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "bash_start",
			command: "sleep 5",
			excludeFromContext: true,
			transient: true,
			runId: "side-run-1",
		});

		// No session-scoped abort is sent until this matching run claims the slot.
		expect(abortBash).toHaveBeenCalled();
		expect(fakeThis.activeBashComponent).toBeUndefined();

		await handleEvent.call(fakeThis, {
			type: "bash_end",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			transient: true,
			runId: "side-run-1",
		});
		expect(fakeThis.sideQuestionBashDiscarded).toBeUndefined();
	});

	it("does not abort or swallow another client's run after a discard", async () => {
		const abortBash = vi.fn(async () => {});
		const chatContainer = new Container();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			// Our side bash was discarded at pane close but never claimed the slot.
			sideQuestionBash: undefined,
			sideQuestionBashDiscarded: "side-run-1",
			activeBashComponent: undefined,
			agentConnection: { abortBash },
			// handleEvent preamble stubs
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			updateConnectionStateFromEvent: vi.fn(),
			activityTracker: { handleEvent: vi.fn(), getStatus: () => ({ tokens: 0 }) },
			updateWorkingLoaderMessage: vi.fn(),
			isAgentStreaming: () => false,
			ui: { requestRender: vi.fn() },
			chatContainer,
			pendingMessagesContainer: new Container(),
			pendingBashComponents: [],
		});
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeThis, event: unknown): Promise<void>;
			}
		).handleEvent;

		// Another client won the bash slot; its run must render, not be aborted.
		await handleEvent.call(fakeThis, { type: "bash_start", command: "make build", excludeFromContext: false });

		expect(abortBash).not.toHaveBeenCalled();
		expect(fakeThis.sideQuestionBashDiscarded).toBeUndefined();
		expect(chatContainer.children.some((child) => child instanceof BashExecutionComponent)).toBe(true);

		await handleEvent.call(fakeThis, { type: "bash_output", chunk: "compiling\n" });
		expect((fakeThis.activeBashComponent as BashExecutionComponent).getOutput()).toContain("compiling");
	});

	it("keeps foreign runs out of the pane and suppresses foreign transient runs", async () => {
		const addBash = vi.fn();
		const finishBash = vi.fn();
		const showError = vi.fn();
		const chatContainer = new Container();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			// Our side bash is pending; its runId has not appeared yet.
			sideQuestionBash: { runId: "side-run-1", input: "!ls", seedTranscript: true },
			sideQuestionBashComponent: undefined,
			sideQuestionBashDiscarded: undefined,
			sideQuestionComponent: { addBash, finishBash },
			sideQuestionTurns: [],
			activeBashComponent: undefined,
			showError,
			// handleEvent preamble stubs
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			updateConnectionStateFromEvent: vi.fn(),
			activityTracker: { handleEvent: vi.fn(), getStatus: () => ({ tokens: 0 }) },
			updateWorkingLoaderMessage: vi.fn(),
			isAgentStreaming: () => false,
			ui: { requestRender: vi.fn() },
			chatContainer,
			pendingMessagesContainer: new Container(),
			pendingBashComponents: [],
		});
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeThis, event: unknown): Promise<void>;
			}
		).handleEvent;

		// A foreign main-chat run — even with the identical command string —
		// renders in the chat, never in the pane.
		await handleEvent.call(fakeThis, { type: "bash_start", command: "ls", excludeFromContext: false });
		expect(addBash).not.toHaveBeenCalled();
		expect(chatContainer.children.some((child) => child instanceof BashExecutionComponent)).toBe(true);
		await handleEvent.call(fakeThis, { type: "bash_end", exitCode: 0, cancelled: false, truncated: false });
		// The foreign run neither seeds the side transcript nor consumes the
		// still-pending side bash (the rejected executeBash call clears it).
		expect(fakeThis.sideQuestionTurns).toEqual([]);
		expect(fakeThis.sideQuestionBash).toMatchObject({ runId: "side-run-1" });

		// A foreign transient run (another client's side conversation) is
		// suppressed entirely: no chat mount, no output, no failure toast.
		chatContainer.clear();
		await handleEvent.call(fakeThis, {
			type: "bash_start",
			command: "ls secret-dir",
			excludeFromContext: true,
			transient: true,
			runId: "other-client-run",
		});
		expect(chatContainer.children).toEqual([]);
		expect(fakeThis.activeBashComponent).toBeUndefined();
		await handleEvent.call(fakeThis, {
			type: "bash_end",
			exitCode: undefined,
			cancelled: false,
			truncated: false,
			errorMessage: "spawn failed",
			transient: true,
			runId: "other-client-run",
		});
		expect(showError).not.toHaveBeenCalled();
		expect(fakeThis.sideQuestionTurns).toEqual([]);
	});

	it("keeps !! side-conversation bash display-only", async () => {
		const finishBash = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			sideQuestionComponent: { finishBash },
			sideQuestionTurns: [],
			sideQuestionBash: { runId: "side-run-1", input: "!!pwd", seedTranscript: false },
		});
		const finishSideQuestionBash = (
			InteractiveMode.prototype as unknown as {
				finishSideQuestionBash(
					this: typeof fakeThis,
					event: { exitCode?: number; cancelled: boolean; truncated: boolean; errorMessage?: string },
					rawOutput: string,
				): void;
			}
		).finishSideQuestionBash;

		finishSideQuestionBash.call(fakeThis, { exitCode: 0, cancelled: false, truncated: false }, "/repo\n");

		expect(finishBash).toHaveBeenCalled();
		expect(fakeThis.sideQuestionBash).toBeUndefined();
		expect(fakeThis.sideQuestionTurns).toEqual([]);
	});

	it("aligns the thinking placeholder with the streamed response", () => {
		const running = new SideQuestionComponent(
			{ id: "question-5", question: "Still running?", answer: "", status: "running" },
			4,
		);
		const complete = new SideQuestionComponent(
			{ id: "question-5", question: "Still running?", answer: "Aligned response", status: "complete" },
			4,
		);
		const runningLines = running.render(40).map(stripAnsi);
		const completeLines = complete.render(40).map(stripAnsi);
		const thinkingLine = runningLines.find((line) => line.includes("Thinking…"));
		const responseLine = completeLines.find((line) => line.includes("Aligned response"));
		const rawThinkingLine = running.render(40).find((line) => line.includes("Thinking…"));

		expect(thinkingLine?.indexOf("Thinking…")).toBe(responseLine?.indexOf("Aligned response"));
		expect(rawThinkingLine).toContain("\x1b[39mThinking…");
	});

	it("uses the user-message foreground for pane content", () => {
		const component = new SideQuestionComponent({
			id: "question-5",
			question: "Readable question",
			answer: "Readable response",
			status: "complete",
		});
		const rendered = component.render(40).join("\n");

		expect(rendered).toContain("\x1b[39mReadable question\x1b[39m");
		expect(rendered).toContain("\x1b[39mReadable response");
	});

	it("shows the failure reason beneath partial output", () => {
		const component = new SideQuestionComponent({
			id: "side-bash-1",
			question: "!flaky-build",
			answer: "```\ncompiling...\n```",
			status: "error",
			errorMessage: "spawn failed: exit 127",
		});
		const rendered = stripAnsi(component.render(60).join("\n"));

		expect(rendered).toContain("compiling...");
		expect(rendered).toContain("spawn failed: exit 127");
	});

	it("keeps streamed text when a side question is cancelled", () => {
		const component = new SideQuestionComponent({
			id: "question-5",
			question: "Partial?",
			answer: "Useful partial response",
			status: "cancelled",
		});
		const rendered = stripAnsi(component.render(40).join("\n"));

		expect(rendered).toContain("Useful partial response");
		expect(rendered).not.toContain("Cancelled");
	});

	it("closes and cancels a running pane before handling other Escape actions", () => {
		const abortSideQuestion = vi.fn(async () => true);
		const takeEscapeRepeatAction = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			activeSideQuestionId: "question-5",
			sideQuestionEvent: {
				id: "question-5",
				question: "Still running?",
				answer: "",
				status: "running",
			},
			sideQuestionComponent: {},
			sideQuestionContainer: new Container(),
			agentConnection: { abortSideQuestion },
			isInitialized: false,
			clearCtrlCExitHint: vi.fn(),
			clearEscapeRepeat: vi.fn(),
			takeEscapeRepeatAction,
			armEscapeRepeat: vi.fn(),
			interruptOrClearInput: vi.fn(),
		});
		const handleEscape = (InteractiveMode.prototype as unknown as { handleEscape(this: typeof fakeThis): void })
			.handleEscape;

		handleEscape.call(fakeThis);

		expect(abortSideQuestion).toHaveBeenCalledWith("question-5");
		expect(fakeThis.sideQuestionEvent).toBeUndefined();
		expect(fakeThis.activeSideQuestionId).toBe("question-5");
		expect(takeEscapeRepeatAction).not.toHaveBeenCalled();
	});

	it("waits for a cancelled run to settle before starting another side question", async () => {
		const showWarning = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			activeSideQuestionId: "question-5",
			showWarning,
		});
		const handleSideQuestion = (
			InteractiveMode.prototype as unknown as {
				handleSideQuestion(this: typeof fakeThis, question: string): Promise<void>;
			}
		).handleSideQuestion;

		await handleSideQuestion.call(fakeThis, "Can this overlap?");

		expect(showWarning).toHaveBeenCalledWith("Wait for the current side question to finish or cancel it first.");
	});

	it("reports side-question abort failures without rejecting the interrupt path", async () => {
		const showError = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			activeSideQuestionId: "question-6",
			sideQuestionEvent: {
				id: "question-6",
				question: "Still running?",
				answer: "",
				status: "running",
			},
			agentConnection: { abortSideQuestion: vi.fn(async () => Promise.reject(new Error("daemon unavailable"))) },
			showError,
			getRetryAttempt: () => 0,
			isAgentCompacting: () => false,
			isBashRunning: () => false,
			isAgentStreaming: () => false,
		});
		const interruptOrClearInput = (
			InteractiveMode.prototype as unknown as { interruptOrClearInput(this: typeof fakeThis): void }
		).interruptOrClearInput;

		interruptOrClearInput.call(fakeThis);

		await vi.waitFor(() => expect(showError).toHaveBeenCalledWith("daemon unavailable"));
	});

	it("dismisses the side-question pane after successful tree navigation", async () => {
		const clearSideQuestion = vi.fn();
		const setText = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			clearSideQuestion,
			chatContainer: new Container(),
			renderInitialMessages: vi.fn(async () => undefined),
			editor: { getText: () => "", setText },
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn(async () => undefined),
		});
		const renderTreeNavigation = (
			InteractiveMode.prototype as unknown as {
				renderTreeNavigation(this: typeof fakeThis, result: { editorText?: string }): Promise<void>;
			}
		).renderTreeNavigation;

		await renderTreeNavigation.call(fakeThis, { editorText: "restored draft" });

		expect(clearSideQuestion).toHaveBeenCalledWith({ abort: true });
		expect(setText).toHaveBeenCalledWith("restored draft");
	});
});
