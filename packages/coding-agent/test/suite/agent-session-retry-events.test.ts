import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentContinueError, type AgentEvent, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	type Model,
	type ServiceTier,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore } from "../../src/core/cron-jobs.js";
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.js";

function normalizeEventOrder(events: Harness["events"]): string[] {
	const normalized: string[] = [];
	for (const event of events) {
		const label =
			event.type === "message_start" || event.type === "message_end"
				? `${event.type}:${event.message.role}`
				: event.type === "tool_execution_start" || event.type === "tool_execution_end"
					? `${event.type}:${event.toolName}`
					: event.type;
		if (label === "message_update" && normalized[normalized.length - 1] === "message_update") {
			continue;
		}
		normalized.push(label);
	}
	return normalized;
}

function structuredProviderFailure(kind: "auth" | "invalid_request" | "refusal" | "permission"): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: `provider ${kind} failure`,
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind },
			},
		],
	};
}

function rateLimitedFailure(retryAfterMs: number): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limited" }),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "rate_limit", status: 429, retryAfterMs },
			},
		],
	};
}

type SessionRetryCompactionInternals = {
	_retryAttempt: number;
	_retryPromise: Promise<void> | undefined;
	_retryResolve: (() => void) | undefined;
	_autoCompactionAbortController: AbortController | undefined;
	_postCompactionContinuationScheduled: boolean;
	_processAgentEvent: (event: AgentEvent) => Promise<void>;
	_checkCompaction: (message: AssistantMessage) => Promise<boolean>;
	_schedulePostCompactionContinue: () => void;
	_cancelPostCompactionContinue: () => void;
};

describe("AgentSession retry and event characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("retries after a transient error and succeeds", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "end:true"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("ends the retry when the scheduled continue cannot run", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}:${event.finalError}`);
		});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		vi.spyOn(harness.session.agent, "continue").mockRejectedValue(
			new AgentContinueError("nothing-to-continue", "Nothing to continue"),
		);

		const markStale = vi.spyOn(
			harness.session as unknown as { _markProviderAuthStaleForRetryFailure: () => void },
			"_markProviderAuthStaleForRetryFailure",
		);

		// Pre-fix this hangs: the swallowed rejection leaves the retry unresolved forever.
		await harness.session.prompt("test");

		expect(harness.session.isRetrying).toBe(false);
		expect(retryEvents).toEqual(["start:1", "end:false:Nothing to continue"]);
		// Terminal like every other retry end: a captured auth failure goes stale.
		expect(markStale).toHaveBeenCalled();
	});

	it("ignores a stale continue rejection after the retry was aborted and a newer one runs", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}:${event.finalError}`);
		});
		let rejectStale: (error: Error) => void = () => {};
		let rejectFresh: (error: Error) => void = () => {};
		const continueSpy = vi
			.spyOn(harness.session.agent, "continue")
			.mockReturnValueOnce(new Promise((_resolve, reject) => (rejectStale = reject)))
			.mockReturnValueOnce(new Promise((_resolve, reject) => (rejectFresh = reject)));

		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const first = harness.session.prompt("one");
		await vi.waitFor(() => expect(continueSpy.mock.calls.length).toBe(1));
		harness.session.abortRetry();
		await first;

		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const second = harness.session.prompt("two");
		await vi.waitFor(() => expect(continueSpy.mock.calls.length).toBe(2));
		// The aborted retry's parked continue settles while the NEWER retry runs:
		// it must not clear the new retry's state or emit its end event.
		rejectStale(new AgentContinueError("busy", "Busy"));
		rejectFresh(new AgentContinueError("nothing-to-continue", "Nothing to continue"));
		await second;

		expect(retryEvents).toEqual(["start:1", "end:false:Retry cancelled", "start:1", "end:false:Nothing to continue"]);
	});

	it("retries multiple transient failures and succeeds on the final attempt", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("success"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:true"]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("exhausts max retries and emits a failure event", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:false"]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant") {
							await new Promise((resolve) => setTimeout(resolve, 40));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("accepted agent message prompts keep retry state queued after returning", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 40 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		await harness.session.acceptAgentMessagePrompt("agent-to-agent payload", { expandPromptTemplates: false });
		await sawRetryStart;

		expect(harness.session.isRetrying).toBe(true);
		expect(harness.session.hasAcceptedPromptInFlight).toBe(true);
		await expect(
			harness.session.prompt("second", { queueIfBusy: true, streamingBehavior: "followUp" }),
		).resolves.toBeUndefined();
		expect(harness.session.queuedActionCount).toBe(1);
	});

	it("does not retry when retry is disabled", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("does not retry faux provider queue exhaustion", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("does not retry local agent lifecycle listener failures", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		let unsubscribe = () => {};
		unsubscribe = harness.session.agent.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				unsubscribe();
				throw new Error("local listener failed");
			}
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("retry should not happen")]);

		await harness.session.prompt("test");

		const lastMessage = harness.session.messages.at(-1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.isRetrying).toBe(false);
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.diagnostics?.some((diagnostic) => diagnostic.type === "agent_lifecycle_failure")).toBe(
				true,
			);
		}
	});

	for (const [name, errorMessage] of [
		["network finish reason", "Provider finish_reason: network_error"],
		["content-filter finish reason", "Provider finish_reason: content_filter"],
		["empty response", "Provider returned an empty response"],
		["cybersecurity policy flag", "Your request was flagged for cybersecurity risk and cannot be processed."],
		["usage policy flag", "flagged as potentially violating our usage policy"],
		["prose-form transient 5xx", "An error occurred while processing your request. You can retry your request."],
	] as const) {
		it(`retries ${name}`, async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("recovered"),
			]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
			expect(harness.session.isRetrying).toBe(false);
		});
	}

	it("retries generic provider errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});

	it("retries structured provider auth failures once", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			structuredProviderFailure("auth"),
			structuredProviderFailure("auth"),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
		expect(harness.session.isRetrying).toBe(false);
	});

	for (const kind of ["invalid_request", "refusal", "permission"] as const) {
		it(`does not retry structured permanent provider ${kind} failures`, async () => {
			const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
			harnesses.push(harness);
			harness.setResponses([structuredProviderFailure(kind), fauxAssistantMessage("unused")]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.session.isRetrying).toBe(false);
		});
	}

	it("waits at least the provider-requested Retry-After delay before retrying", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([rateLimitedFailure(50), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([50]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});

	it("fails without retrying when the provider-requested delay exceeds maxRetryDelayMs and wait-for-usage is disabled", async () => {
		const harness = await createHarness({
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					provider: {
						maxRetryDelayMs: 100,
						// With the wait loop enabled (the default), quota failures are
						// governed by its own bounds instead of this quick-retry cap.
						waitForUsage: { enabled: false },
					},
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([rateLimitedFailure(3_600_000), fauxAssistantMessage("unused")]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		const retryEnd = harness.eventsOfType("auto_retry_end");
		expect(retryEnd).toHaveLength(1);
		expect(retryEnd[0]?.success).toBe(false);
		expect(retryEnd[0]?.finalError).toContain("maxRetryDelayMs");
		expect(harness.session.isRetrying).toBe(false);
	});

	it("keeps retry state active when overflow compaction will retry", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionRetryCompactionInternals;
		const originalCheckCompaction = internals._checkCompaction.bind(harness.session);
		const overflowMessage = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "prompt is too long",
		});
		internals._retryAttempt = 1;
		internals._retryPromise = new Promise<void>((resolve) => {
			internals._retryResolve = resolve;
		});
		internals._checkCompaction = async () => true;

		try {
			await internals._processAgentEvent({ type: "agent_end", messages: [overflowMessage] } as AgentEvent);

			expect(internals._retryAttempt).toBe(1);
			expect(harness.session.isRetrying).toBe(true);
			expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
		} finally {
			internals._checkCompaction = originalCheckCompaction;
			harness.session.abortRetry();
		}
	});

	it("cancels overflow-compaction retry continuation when abortRetry is called", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionRetryCompactionInternals;
		const compactionAbortController = new AbortController();
		internals._retryAttempt = 1;
		internals._retryPromise = new Promise<void>((resolve) => {
			internals._retryResolve = resolve;
		});
		internals._autoCompactionAbortController = compactionAbortController;
		internals._schedulePostCompactionContinue();

		try {
			expect(internals._postCompactionContinuationScheduled).toBe(true);

			harness.session.abortRetry();

			expect(compactionAbortController.signal.aborted).toBe(true);
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._retryAttempt).toBe(0);
			expect(harness.session.isRetrying).toBe(false);
			expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
				success: false,
				attempt: 1,
				finalError: "Retry cancelled",
			});
		} finally {
			internals._autoCompactionAbortController = undefined;
			internals._cancelPostCompactionContinue();
		}
	});

	it("cancels retry sleep when abortRetry is called", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("test");
		await sawRetryStart;
		harness.session.abortRetry();
		await promptPromise;

		expect(harness.session.isRetrying).toBe(false);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toContain("Retry cancelled");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("waits for the full loop when retry recovery produces tool calls", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.isStreaming).toBe(false);
		harness.appendResponses([fauxAssistantMessage("follow-up answer")]);
		await harness.session.prompt("follow-up");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("emits extension events before public event subscribers", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_start", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
					pi.on("message_end", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_start" || event.type === "message_end") {
				order.push(`public:${event.type}:${event.message.role}`);
			}
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hi");

		expect(order).toEqual([
			// Leading custom pair: the session-start harness digest rides the first turn.
			"extension:message_start:custom",
			"public:message_start:custom",
			"extension:message_end:custom",
			"public:message_end:custom",
			"extension:message_start:user",
			"public:message_start:user",
			"extension:message_end:user",
			"public:message_end:user",
			"extension:message_start:assistant",
			"public:message_start:assistant",
			"extension:message_end:assistant",
			"public:message_end:assistant",
		]);
	});

	it("emits the expected event order for a single prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:custom",
			"message_end:custom",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
		]);
	});

	it("emits the expected event order for a tool call turn", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		expect(toolRuns).toEqual(["hello"]);
		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:custom",
			"message_end:custom",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"tool_execution_start:echo",
			"tool_execution_end:echo",
			"message_start:toolResult",
			"message_end:toolResult",
			"turn_end",
			"turn_start",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
		]);
	});

	it("emits streaming deltas for text, thinking, and tool calls in message_update events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxThinking("plan"), { type: "text", text: "answer" }, fauxToolCall("echo", { text: "hello" })],
				{
					stopReason: "toolUse",
				},
			),
		]);

		await harness.session.prompt("hi").catch(() => {});

		const updateTypes = harness.eventsOfType("message_update").map((event) => event.assistantMessageEvent.type);
		expect(updateTypes).toContain("thinking_delta");
		expect(updateTypes).toContain("text_delta");
		expect(updateTypes).toContain("toolcall_delta");
	});

	it("emits agent_end for error responses", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "broken" })]);

		await harness.session.prompt("hi");

		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_end");
	});

	it("emits agent_end for aborted runs and persists the aborted assistant message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_end");
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});

	function quotaFailure(options?: { retryAfterMs?: number; errorMessage?: string }): AssistantMessage {
		return {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: options?.errorMessage ?? "429 You have hit your ChatGPT usage limit",
			}),
			diagnostics: [
				{
					type: "provider_stream_failure",
					timestamp: Date.now(),
					details: {
						kind: "rate_limit",
						status: 429,
						...(options?.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
					},
				},
			],
		};
	}

	function transientUnavailableFailure(): AssistantMessage {
		return {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "404 Not Found" }),
			diagnostics: [
				{
					type: "provider_stream_failure",
					timestamp: Date.now(),
					details: { kind: "invalid_request", providerErrorType: "not_found_error", status: 404 },
				},
			],
		};
	}

	function waitSettings(wait: {
		enabled?: boolean;
		baseDelayMs?: number;
		maxDelayMs?: number;
		maxAttempts?: number;
		maxWaitMs?: number;
		pauseUntilReset?: boolean;
		maxPauseMs?: number;
		maxParks?: number;
	}): Partial<Settings> {
		return {
			retry: {
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 1,
				provider: { waitForUsage: wait },
			},
		};
	}

	it("waits for quota recovery with bounded pings and resumes automatically", async () => {
		const harness = await createHarness({
			settings: waitSettings({ baseDelayMs: 1, maxDelayMs: 4, maxAttempts: 5, maxWaitMs: 10_000 }),
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure(), quotaFailure(), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("test");

		const starts = harness.eventsOfType("auto_retry_start");
		expect(starts.map((event) => [event.reason, event.attempt, event.maxAttempts])).toEqual([
			["usage", 1, 5],
			["usage", 2, 5],
		]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([{ type: "auto_retry_end", success: true, attempt: 2 }]);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("resumes a quota wait at the provider-reported reset time", async () => {
		const harness = await createHarness({
			settings: waitSettings({ baseDelayMs: 1, maxDelayMs: 4, maxAttempts: 5, maxWaitMs: 10_000 }),
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure({ retryAfterMs: 40 }), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("test");

		const starts = harness.eventsOfType("auto_retry_start");
		expect(starts.map((event) => [event.reason, event.delayMs])).toEqual([["usage", 40]]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});

	it("aborts the quota wait at the configured ping bound", async () => {
		const harness = await createHarness({
			settings: waitSettings({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 2, maxWaitMs: 10_000 }),
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure(), quotaFailure(), quotaFailure()]);

		await harness.session.prompt("test");

		const starts = harness.eventsOfType("auto_retry_start");
		expect(starts.map((event) => [event.reason, event.attempt])).toEqual([
			["usage", 1],
			["usage", 2],
		]);
		expect(harness.faux.state.callCount).toBe(3);
		const retryEnd = harness.eventsOfType("auto_retry_end");
		expect(retryEnd).toHaveLength(1);
		expect(retryEnd[0]?.success).toBe(false);
		expect(retryEnd[0]?.finalError).toContain("maxAttempts");
		expect(harness.session.isRetrying).toBe(false);
	});

	it("aborts immediately when the provider-reported reset exceeds the wait bound and parking is disabled", async () => {
		const harness = await createHarness({ settings: parkSettings({ pauseUntilReset: false }) });
		harnesses.push(harness);
		harness.setResponses([quotaFailure({ retryAfterMs: 3_600_000 }), fauxAssistantMessage("unused")]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		const retryEnd = harness.eventsOfType("auto_retry_end");
		expect(retryEnd).toHaveLength(1);
		expect(retryEnd[0]?.success).toBe(false);
		expect(retryEnd[0]?.finalError).toContain("maxWaitMs");
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.isQuotaParked).toBe(false);
	});

	type QuotaParkInternals = {
		_quotaPark: { parkCount: number; resumeAtMs: number; jobId?: string; waking?: boolean } | undefined;
		_resumeFromQuotaPark: () => Promise<void>;
		_agentEventQueue: Promise<void>;
	};

	const quotaPark = (harness: Harness): QuotaParkInternals["_quotaPark"] =>
		(harness.session as unknown as QuotaParkInternals)._quotaPark;

	const parkSettings = (wait: Parameters<typeof waitSettings>[0]): Partial<Settings> =>
		waitSettings({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 5, maxWaitMs: 1_000, ...wait });

	const parkHarness = async (settings: Partial<Settings>, persist = false): Promise<Harness> => {
		const harness = await createHarness({ persistSession: persist, settings });
		harnesses.push(harness);
		if (persist) harness.sessionManager.materializeSessionFile();
		return harness;
	};

	const farReset = (): AssistantMessage => quotaFailure({ retryAfterMs: 3_600_000 });
	const promptParked = async (harness: Harness, text: string, ends = 1): Promise<void> => {
		const parked = waitForRetryEnds(harness, ends);
		await harness.session.prompt(text);
		await parked;
	};

	const quotaEntries = (harness: Harness, customType: string): Array<Record<string, unknown>> =>
		harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === customType)
			.map((entry) => (entry as { data?: Record<string, unknown> }).data ?? {});

	const assistantTurns = (harness: Harness): (() => Promise<AssistantMessage>) => {
		const buffered: AssistantMessage[] = [];
		const waiters: Array<(message: AssistantMessage) => void> = [];
		harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const message = event.message as AssistantMessage;
			const waiter = waiters.shift();
			if (waiter) waiter(message);
			else buffered.push(message);
		});
		return async () => buffered.shift() ?? (await new Promise<AssistantMessage>((resolve) => waiters.push(resolve)));
	};

	const waitFor = (harness: Harness, ready: () => boolean): Promise<void> =>
		new Promise((resolve) => {
			const settle = (): void => {
				if (!ready()) return;
				unsubscribe();
				resolve();
			};
			const unsubscribe = harness.session.subscribe(settle);
			settle();
		});
	const waitForRetryEnds = (harness: Harness, count: number): Promise<void> =>
		waitFor(harness, () => harness.eventsOfType("auto_retry_end").length >= count);

	const fireQuotaWake = async (harness: Harness): Promise<void> => {
		const internals = harness.session as unknown as QuotaParkInternals;
		if (!internals._quotaPark) throw new Error("the session is not parked");
		internals._quotaPark.resumeAtMs = Date.now() - 1;
		await internals._resumeFromQuotaPark();
	};
	const wakeQuotaProbe = (harness: Harness): (() => Promise<AssistantMessage>) => {
		const turn = assistantTurns(harness);
		return () => fireQuotaWake(harness).then(turn);
	};

	const readQuotaWakeJob = (harness: Harness, jobId: string | undefined) =>
		(
			JSON.parse(
				readFileSync(join(harness.sessionManager.getSessionArtifactDir()!, "scheduled-jobs.json"), "utf-8"),
			) as {
				jobs?: Array<{ id: string; status: string; prompt: string; schedule: { kind: string } }>;
			}
		).jobs?.find((job) => job.id === jobId);
	const lastUserEntryId = (harness: Harness): string =>
		harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.at(-1)!.id;

	it("parks a quota-blocked session until the provider reset and resumes automatically", async () => {
		const harness = await parkHarness(parkSettings({ maxPauseMs: 2_000 }), true);
		harness.setResponses([farReset(), farReset(), fauxAssistantMessage("recovered")]);
		await promptParked(harness, "do the work");
		expect([harness.session.isQuotaParked, harness.faux.state.callCount]).toEqual([true, 1]);
		const wakeJob = readQuotaWakeJob(harness, quotaPark(harness)?.jobId);
		expect([wakeJob?.status, wakeJob?.schedule.kind]).toEqual(["active", "once"]);
		expect(wakeJob?.prompt).toContain("<provider_quota_resumed>");
		await promptParked(harness, "second task", 2);
		expect([quotaPark(harness)?.parkCount, quotaPark(harness)?.jobId]).toEqual([1, wakeJob?.id]);
		await wakeQuotaProbe(harness)();
		expect(harness.session.isQuotaParked).toBe(false);
		expect(getUserTexts(harness).join("\n")).toContain("<provider_quota_resumed>");
		expect(quotaEntries(harness, "provider_quota_resume")[0]?.outcome).toBe("wake");
		expect(readQuotaWakeJob(harness, wakeJob?.id)?.status).toBe("cancelled");
	});

	it("re-parks at the wake with the newly reported reset and stops at the park bound", async () => {
		const harness = await parkHarness(parkSettings({ maxPauseMs: 2_000, maxParks: 2 }));
		harness.setResponses([farReset(), farReset(), farReset()]);
		await promptParked(harness, "/goal finish the task");
		const reparked = waitForRetryEnds(harness, 2);
		await fireQuotaWake(harness);
		await reparked;
		expect([harness.session.isQuotaParked, quotaPark(harness)?.parkCount]).toEqual([true, 2]);
		expect(harness.session.goalState.status).toBe("active");
		const spent = waitForRetryEnds(harness, 3);
		const goalErrored = waitFor(harness, () => harness.session.goalState.status === "error");
		await fireQuotaWake(harness);
		await spent;
		await goalErrored;
		expect(harness.session.isQuotaParked).toBe(false);
		expect(harness.eventsOfType("auto_retry_end").at(-1)?.finalError).toContain("maxWaitMs");
	});

	it("resumes early and cancels the scheduled wake when quota returns via another turn", async () => {
		const harness = await parkHarness(parkSettings({ maxPauseMs: 2_000 }), true);
		harness.setResponses([farReset(), fauxAssistantMessage("side answer"), fauxAssistantMessage("recovered")]);
		await promptParked(harness, "do the work");
		const wakeJobId = quotaPark(harness)?.jobId;
		const answered = assistantTurns(harness);
		await harness.session.prompt("side question");
		await answered();
		expect(harness.session.isQuotaParked).toBe(false);
		expect(getUserTexts(harness).join("\n")).toContain("<provider_quota_resumed>");
		expect(quotaEntries(harness, "provider_quota_resume")[0]?.outcome).toBe("early");
		expect(readQuotaWakeJob(harness, wakeJobId)?.status).toBe("cancelled");
	});

	it("stands down when the daemon already delivered the durable wake", async () => {
		const harness = await parkHarness(parkSettings({ maxPauseMs: 2_000 }), true);
		harness.setResponses([farReset(), fauxAssistantMessage("delivered")]);
		await promptParked(harness, "do the work");
		const jobId = quotaPark(harness)?.jobId;
		const artifactDir = harness.sessionManager.getSessionArtifactDir()!;

		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(harness.sessionManager.getSessionId(), artifactDir);
		const [dispatch] = store.claimDue(new Date(Date.now() + 60_000));
		store.recordDispatchResult(dispatch!.id, { outcome: "ran" });
		await fireQuotaWake(harness);
		expect([quotaPark(harness)?.waking, harness.faux.state.callCount]).toEqual([true, 1]);
		expect(readQuotaWakeJob(harness, jobId)?.status).toBe("completed");
	});

	it("keeps the park, re-arms the wake, and restores the re-arm across a restart", async () => {
		const settings = parkSettings({ maxPauseMs: 60_000 });
		const abortedHarness = await parkHarness(settings, true);
		abortedHarness.setResponses([farReset(), fauxAssistantMessage("", { stopReason: "aborted" })]);
		await promptParked(abortedHarness, "do the work");
		const parkedAtMs = quotaPark(abortedHarness)?.resumeAtMs ?? 0;

		// An aborted probe is no evidence the quota is back: the park re-arms.
		const aborted = assistantTurns(abortedHarness);
		await fireQuotaWake(abortedHarness);
		expect((await aborted()).stopReason).toBe("aborted");
		const reArmed = quotaPark(abortedHarness);
		expect([reArmed?.waking, (reArmed?.resumeAtMs ?? 0) > parkedAtMs]).toEqual([false, true]);

		// The re-armed wake is recorded, so a restart restores the park with the retry job still owned.
		const restarted = await createHarness({ existingSessionFile: abortedHarness.session.sessionFile!, settings });
		harnesses.push(restarted);
		expect([restarted.session.isQuotaParked, quotaPark(restarted)?.parkCount]).toEqual([true, 1]);
		expect(readQuotaWakeJob(abortedHarness, reArmed?.jobId)?.status).toBe("active");
		restarted.setResponses([fauxAssistantMessage("recovered")]);
		await wakeQuotaProbe(restarted)();
		expect(readQuotaWakeJob(abortedHarness, reArmed?.jobId)?.status).toBe("cancelled");
		expect(restarted.session.isQuotaParked).toBe(false);

		// A refused admission re-arms too, and gives the park up once spent.
		const refusedHarness = await parkHarness(parkSettings({ maxPauseMs: 2_000 }));
		refusedHarness.setResponses([farReset(), fauxAssistantMessage("unused")]);
		await promptParked(refusedHarness, "do the work");
		const refusedAtMs = quotaPark(refusedHarness)?.resumeAtMs ?? 0;
		const pause = refusedHarness.session.acquireSessionInputPause();
		try {
			await fireQuotaWake(refusedHarness);
			expect(quotaPark(refusedHarness)?.resumeAtMs).toBeGreaterThan(refusedAtMs);
			for (let attempt = 0; attempt < 3; attempt += 1) await fireQuotaWake(refusedHarness);
		} finally {
			pause.release();
		}
		expect(refusedHarness.session.isQuotaParked).toBe(false);
	});

	it("re-arms the wake when the resume probe dies a plain error", async () => {
		const harness = await parkHarness(parkSettings({ maxPauseMs: 2_000 }), true);
		harness.setResponses([farReset(), structuredProviderFailure("invalid_request")]);
		await promptParked(harness, "do the work");
		const parkedAtMs = quotaPark(harness)?.resumeAtMs ?? 0;

		// The wake was consumed and the probe errored: without a re-arm the park
		// sits `waking` with no timer or job left, and the session never resumes.
		const probeEnded = waitFor(harness, () => harness.eventsOfType("agent_end").length >= 2);
		const errored = assistantTurns(harness);
		await fireQuotaWake(harness);
		expect((await errored()).stopReason).toBe("error");
		// The re-arm runs at the probe turn's terminal tail: settle the agent_end
		// event and the agent event queue before reading the park.
		await probeEnded;
		await (harness.session as unknown as QuotaParkInternals)._agentEventQueue;
		const reArmed = quotaPark(harness);
		expect([reArmed?.waking, (reArmed?.resumeAtMs ?? 0) > parkedAtMs]).toEqual([false, true]);
		expect(readQuotaWakeJob(harness, reArmed?.jobId)?.status).toBe("active");
	});

	it("restores a park across a restart, and honours a cancelled wake", async () => {
		const settings = parkSettings({ maxPauseMs: 60_000 });
		const harness = await parkHarness(settings, true);
		harness.setResponses([farReset()]);
		await promptParked(harness, "do the work");
		const sessionFile = harness.session.sessionFile!;

		// A restart rebuilds the park, and the wake still bounds the episode.
		const restarted = await createHarness({ existingSessionFile: sessionFile, settings });
		harnesses.push(restarted);
		expect([restarted.session.isQuotaParked, quotaPark(restarted)?.parkCount]).toEqual([true, 1]);
		restarted.setResponses([farReset()]);
		const reparked = waitForRetryEnds(restarted, 1);
		await fireQuotaWake(restarted);
		await reparked;
		expect(quotaPark(restarted)?.parkCount).toBe(2);

		// A wake the user cancelled stays cancelled, through a navigation and a restart.
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(
			restarted.sessionManager.getSessionId(),
			restarted.sessionManager.getSessionArtifactDir()!,
		);
		store.cancel(quotaPark(restarted)!.jobId!);
		await restarted.session.navigateTree(lastUserEntryId(restarted));
		await restarted.session.navigateTree(restarted.sessionManager.getLeafId()!);
		expect(restarted.session.isQuotaParked).toBe(false);
		const afterCancel = await createHarness({ existingSessionFile: sessionFile, settings });
		harnesses.push(afterCancel);
		expect(afterCancel.session.isQuotaParked).toBe(false);
	});

	it("moves the park with branch navigation", async () => {
		const settings = parkSettings({ maxPauseMs: 2_000 });
		const harness = await parkHarness(settings, true);
		harness.setResponses([farReset(), fauxAssistantMessage("recovered")]);
		await promptParked(harness, "do the work");
		const parkedLeaf = harness.sessionManager.getLeafId()!;
		await harness.session.navigateTree(lastUserEntryId(harness));
		expect([harness.session.isQuotaParked, harness.faux.state.callCount]).toEqual([false, 1]);

		await harness.session.navigateTree(parkedLeaf);
		expect(harness.session.isQuotaParked).toBe(true);
		const wakeJob = readQuotaWakeJob(harness, quotaPark(harness)?.jobId);
		expect(wakeJob?.status).toBe("active");

		const restarted = await createHarness({ existingSessionFile: harness.session.sessionFile!, settings });
		harnesses.push(restarted);
		expect(restarted.session.isQuotaParked).toBe(true);

		await wakeQuotaProbe(harness)();
		expect(harness.session.isQuotaParked).toBe(false);
	});

	it("preserves an active goal across a quota park and resumes its continuation", async () => {
		const harness = await parkHarness(parkSettings({ maxPauseMs: 2_000 }));
		const completeGoal = (): AssistantMessage => {
			harness.session.handleGoalHostRequest("goal.complete", {});
			return fauxAssistantMessage("Goal complete.");
		};
		harness.setResponses([farReset(), fauxAssistantMessage("recovered"), completeGoal]);
		await promptParked(harness, "/goal finish the task");
		// The parked turn is the park's pause, not the goal's death.
		expect([harness.session.isQuotaParked, harness.session.goalState.status]).toEqual([true, "active"]);
		const goalTurns = assistantTurns(harness);
		await fireQuotaWake(harness);
		await goalTurns(); // the wake's resume probe
		await goalTurns(); // the resumed goal-driven continuation completes the goal
		expect([harness.session.isQuotaParked, harness.session.goalState.status]).toEqual([false, "complete"]);
	});

	it("does not park while a backup model is configured and available", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: { providerBackupModel: "faux/faux-backup", ...parkSettings({}) },
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure({ retryAfterMs: 3_600_000 }), fauxAssistantMessage("backup answer")]);
		await harness.session.prompt("do the work");
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.reason)).toEqual(["backup"]);
		expect(harness.session.isQuotaParked).toBe(false);
	});

	it("waits for an unavailable provider after quick retries exhaust", async () => {
		const harness = await createHarness({
			settings: {
				retry: {
					enabled: true,
					maxRetries: 2,
					baseDelayMs: 1,
					provider: { waitForUsage: { baseDelayMs: 1, maxDelayMs: 4, maxAttempts: 5, maxWaitMs: 10_000 } },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			transientUnavailableFailure(),
			transientUnavailableFailure(),
			transientUnavailableFailure(),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		const starts = harness.eventsOfType("auto_retry_start");
		expect(starts.map((event) => [event.reason, event.attempt, event.maxAttempts])).toEqual([
			[undefined, 1, 2],
			[undefined, 2, 2],
			["unavailable", 1, 5],
		]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});

	it("routes quota-blocked turns to the configured backup model and returns to the primary", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: {
				providerBackupModel: "faux/faux-backup",
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure(), fauxAssistantMessage("backup answer")]);

		await harness.session.prompt("test");

		const starts = harness.eventsOfType("auto_retry_start");
		expect(starts).toEqual([
			{
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 0,
				errorMessage: "429 You have hit your ChatGPT usage limit",
				reason: "backup",
				backupModel: "faux/faux-backup",
			},
		]);
		const lastAssistant = [...harness.session.messages].reverse().find((message) => message.role === "assistant");
		expect(lastAssistant?.role).toBe("assistant");
		if (lastAssistant?.role === "assistant") {
			// The retry really ran on the backup model.
			expect(lastAssistant.model).toBe("faux-backup");
		}
		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			{ type: "auto_retry_end", success: true, attempt: 1, restoredModel: "faux/faux-1" },
		]);
		// Auto-return: the session is back on the primary model.
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("probes the primary again on the next turn after a backup success", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: {
				providerBackupModel: "faux/faux-backup",
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure(), fauxAssistantMessage("backup answer")]);
		await harness.session.prompt("one");
		harness.appendResponses([quotaFailure(), fauxAssistantMessage("backup answer two")]);
		await harness.session.prompt("two");

		const backupStarts = harness.eventsOfType("auto_retry_start").filter((event) => event.reason === "backup");
		expect(backupStarts).toHaveLength(2);
		const restoredEnds = harness
			.eventsOfType("auto_retry_end")
			.filter((event) => event.restoredModel === "faux/faux-1");
		expect(restoredEnds).toHaveLength(2);
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("routes transiently unavailable providers to the backup model", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: {
				providerBackupModel: "faux/faux-backup",
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([transientUnavailableFailure(), fauxAssistantMessage("backup answer")]);

		await harness.session.prompt("test");

		const starts = harness.eventsOfType("auto_retry_start");
		expect(starts.map((event) => [event.reason, event.backupModel])).toEqual([["backup", "faux/faux-backup"]]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => [event.success, event.restoredModel])).toEqual([
			[true, "faux/faux-1"],
		]);
	});

	it("does not route permanent failures to the backup model", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: {
				providerBackupModel: "faux/faux-backup",
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([structuredProviderFailure("invalid_request"), fauxAssistantMessage("unused")]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("falls back to the bounded wait when the backup model cannot be resolved", async () => {
		const harness = await createHarness({
			settings: {
				providerBackupModel: "faux/does-not-exist",
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					provider: { waitForUsage: { baseDelayMs: 1, maxDelayMs: 4, maxAttempts: 5, maxWaitMs: 10_000 } },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure({ retryAfterMs: 40 }), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("test");

		const starts = harness.eventsOfType("auto_retry_start");
		expect(starts.map((event) => [event.reason, event.delayMs])).toEqual([["usage", 40]]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => [event.success, event.restoredModel])).toEqual([
			[true, undefined],
		]);
	});

	it("restores the primary model when a backup-model retry is cancelled mid-wait", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: {
				providerBackupModel: "faux/faux-backup",
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					provider: { waitForUsage: { baseDelayMs: 200, maxDelayMs: 200, maxAttempts: 3, maxWaitMs: 10_000 } },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure(), quotaFailure()]);
		const sawWaitStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start" && event.reason === "usage") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("test");
		await sawWaitStart;
		// Waiting happens on the backup after the primary routed to it.
		expect(harness.session.model?.id).toBe("faux-backup");

		harness.session.abortRetry();
		await promptPromise;

		expect(harness.session.model?.id).toBe("faux-1");
		const retryEnd = harness.eventsOfType("auto_retry_end").at(-1);
		expect(retryEnd?.finalError).toBe("Retry cancelled");
		expect(retryEnd?.restoredModel).toBe("faux/faux-1");
	});

	it("restores the primary model when quick retries exhaust on the backup model", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: {
				providerBackupModel: "faux/faux-backup",
				retry: {
					enabled: true,
					maxRetries: 2,
					baseDelayMs: 1,
					provider: { waitForUsage: { enabled: false } },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure(), quotaFailure(), quotaFailure()]);

		await harness.session.prompt("test");

		expect(harness.session.model?.id).toBe("faux-1");
		const retryEnd = harness.eventsOfType("auto_retry_end").at(-1);
		expect(retryEnd?.success).toBe(false);
		expect(retryEnd?.restoredModel).toBe("faux/faux-1");
	});

	it("restores the primary model when the bounded wait aborts on the backup model", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: {
				providerBackupModel: "faux/faux-backup",
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					provider: { waitForUsage: { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 2, maxWaitMs: 10_000 } },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure(), quotaFailure(), quotaFailure(), quotaFailure()]);

		await harness.session.prompt("test");

		expect(harness.session.model?.id).toBe("faux-1");
		const retryEnd = harness.eventsOfType("auto_retry_end").at(-1);
		expect(retryEnd?.success).toBe(false);
		expect(retryEnd?.finalError).toContain("maxAttempts");
		expect(retryEnd?.restoredModel).toBe("faux/faux-1");
	});

	it("restores the saved service tier after a backup retry, not the backup-clamped one", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: {
				providerBackupModel: "faux/faux-backup",
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		const clampSpy = vi.spyOn(
			harness.session as unknown as { _clampServiceTierForModel: (serviceTier?: string) => void },
			"_clampServiceTierForModel",
		);
		const tierBeforeSwitch = harness.session.serviceTier;
		harness.setResponses([quotaFailure(), fauxAssistantMessage("backup answer")]);

		await harness.session.prompt("test");

		// The restore clamp must pass the tier captured at switch time, not
		// re-derive it from the (possibly clamped) current state.
		const restoreCall = clampSpy.mock.calls.at(-1);
		expect(restoreCall?.[0]).toBe(tierBeforeSwitch);
		expect(harness.session.serviceTier).toBe(tierBeforeSwitch);
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("restores the primary model when the scheduled backup retry continue cannot run", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: {
				providerBackupModel: "faux/faux-backup",
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([quotaFailure()]);
		vi.spyOn(harness.session.agent, "continue").mockRejectedValueOnce(
			new AgentContinueError("nothing-to-continue", "Nothing to continue"),
		);

		await harness.session.prompt("test");

		const retryEnd = harness.eventsOfType("auto_retry_end").at(-1);
		expect(retryEnd?.success).toBe(false);
		expect(retryEnd?.finalError).toBe("Nothing to continue");
		expect(retryEnd?.restoredModel).toBe("faux/faux-1");
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("does not re-issue a wait retry cancelled between the delay and the scheduled continue", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-backup" }],
			settings: {
				providerBackupModel: "faux/faux-backup",
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");
		const backupModel = harness.getModel("faux-backup");
		const primaryModel = harness.models[0];
		if (!backupModel || !primaryModel) throw new Error("faux models missing");
		const internals = harness.session as unknown as {
			_backupModel: {
				backup: Model<string>;
				primary: Model<string>;
				thinkingLevel: ThinkingLevel;
				serviceTier: ServiceTier;
			};
			_retryAttempt: number;
			_retryPromise: Promise<void> | undefined;
			_retryResolve: (() => void) | undefined;
			_retryAfterDelay: (
				message: AssistantMessage,
				options: unknown,
				emitStart: {
					type: "auto_retry_start";
					attempt: number;
					maxAttempts: number;
					delayMs: number;
					errorMessage: string;
					reason?: "usage" | "unavailable" | "backup";
				},
				delayMs: number,
			) => Promise<boolean>;
		};

		// Simulate a wait retry after a backup route: the session is on the
		// backup, the retry state is active, and the wait delay has resolved.
		const thinkingLevel = harness.session.agent.state.thinkingLevel;
		const serviceTier = harness.session.agent.state.serviceTier;
		internals._retryAttempt = 1;
		internals._retryPromise = new Promise<void>((resolve) => {
			internals._retryResolve = resolve;
		});
		harness.session.agent.state.model = backupModel;
		internals._backupModel = { backup: backupModel, primary: primaryModel, thinkingLevel, serviceTier };

		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 usage limited" });
		const didRetry = await internals._retryAfterDelay(
			message,
			undefined,
			{
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 30,
				delayMs: 0,
				errorMessage: "429 usage limited",
				reason: "usage",
			},
			0,
		);
		expect(didRetry).toBe(true);

		// The scheduled continue is a pending 0ms timer. Cancel synchronously:
		// microtasks run before timers, so the cancel lands between the wait
		// and the scheduled start.
		harness.session.abortRetry();
		await new Promise((resolve) => setTimeout(resolve, 10));

		// The cancelled retry's scheduled continue never re-issued the turn.
		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.session.model?.id).toBe("faux-1");
		const retryEnd = harness.eventsOfType("auto_retry_end").at(-1);
		expect(retryEnd?.finalError).toBe("Retry cancelled");
		expect(retryEnd?.restoredModel).toBe("faux/faux-1");
	});
});

describe("AgentSession retry regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it('#3317: retries transient "Network connection lost." failures', async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Network connection lost." }),
			fauxAssistantMessage("recovered after reconnect"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([
			"Network connection lost.",
		]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(getAssistantTexts(harness)).toContain("recovered after reconnect");
	});
});
