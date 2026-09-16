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
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

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

	it("aborts immediately when the provider-reported reset exceeds the wait bound", async () => {
		const harness = await createHarness({
			settings: waitSettings({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 5, maxWaitMs: 1_000 }),
		});
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
