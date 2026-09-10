import { AgentContinueError, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionResult } from "../../src/core/compaction/index.js";
import type { SessionCompaction } from "../../src/session/compaction/compaction.js";
import type { CompactionExecutionOptions } from "../../src/session/compaction/compaction-execution.js";
import type { SessionContinuation } from "../../src/session/turns/continuation.js";
import type { SessionRetry } from "../../src/session/turns/retry.js";
import { createHarness, type Harness } from "./harness.js";

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
	_retry: SessionRetry;
	_compaction: SessionCompaction;
	_performCompaction(options: CompactionExecutionOptions): Promise<CompactionResult>;
	_continuation: SessionContinuation;
	_events: { processAgentEvent(event: AgentEvent): Promise<void> };
	_checkCompaction: (message: AssistantMessage) => Promise<boolean>;
	_schedulePostCompactionContinue: () => void;
	_cancelPostCompactionContinue: () => void;
};

describe("AgentSession retry and event characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
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
		harness.setResponses([structuredProviderFailure("auth")]);
		vi.spyOn(harness.session.agent, "continue").mockRejectedValue(
			new AgentContinueError("nothing-to-continue", "Nothing to continue"),
		);

		const markStale = vi.spyOn(harness.session.modelRegistry, "markProviderAuthSourceStale");

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

	it("fails without retrying when the provider-requested delay exceeds maxRetryDelayMs", async () => {
		const harness = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, provider: { maxRetryDelayMs: 100 } },
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
		const continuation = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		await internals._retry.retryError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "transient" }));
		await vi.waitFor(() => expect(continuation).toHaveBeenCalledOnce());
		internals._checkCompaction = async () => true;

		try {
			await internals._events.processAgentEvent({ type: "agent_end", messages: [overflowMessage] } as AgentEvent);

			expect(harness.session.retryAttempt).toBe(1);
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
		let compactionSignal: AbortSignal | undefined;
		const performCompaction = vi.spyOn(internals, "_performCompaction").mockImplementation(({ signal }) => {
			compactionSignal = signal;
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("Compaction cancelled")), { once: true });
			});
		});
		const continuation = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		await internals._retry.retryError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "transient" }));
		await vi.waitFor(() => expect(continuation).toHaveBeenCalledOnce());
		const compaction = internals._compaction.runAutomatic("overflow", true);
		await vi.waitFor(() => expect(compactionSignal).toBeDefined());
		internals._schedulePostCompactionContinue();

		try {
			expect(internals._continuation.isScheduled).toBe(true);

			harness.session.abortRetry();

			expect(compactionSignal?.aborted).toBe(true);
			expect(internals._continuation.isScheduled).toBe(false);
			expect(harness.session.retryAttempt).toBe(0);
			expect(harness.session.isRetrying).toBe(false);
			expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
				success: false,
				attempt: 1,
				finalError: "Retry cancelled",
			});
		} finally {
			internals._compaction.abortAutomatic();
			await compaction;
			performCompaction.mockRestore();
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
});
