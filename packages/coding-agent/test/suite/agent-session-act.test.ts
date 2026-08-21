import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { actCancellationCapability, actContextLabel } from "../../src/core/act-cancellation.js";
import {
	ACT_EVENT_CELL_TEXT_MAX_CHARS,
	ACT_EVENT_ERROR_MAX_CHARS,
	ACT_EVENT_PROMPT_MAX_CHARS,
	type ActProjectionEvent,
} from "../../src/core/act-events.js";
import { AgentSession } from "../../src/core/agent-session.js";
import type { HostRequestChannel } from "../../src/core/kernel/index.js";
import type { CustomMessage } from "../../src/core/messages.js";
import type { RootForegroundLease } from "../../src/core/root-foreground-lease.js";
import { createHarness } from "./harness.js";

const provider = "faux-act-lane";

function _customMessage(content: string): CustomMessage {
	return {
		role: "custom",
		customType: "prime-agent.act-steering-test",
		content,
		display: false,
		timestamp: Date.now(),
	};
}

function usage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

class TestActChannel implements HostRequestChannel {
	readonly outerToolCallId = "test-root-ipython";
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	readonly cells: string[] = [];
	private readonly responses: Record<string, unknown>[] = [];

	async send(event: Record<string, unknown>): Promise<void> {
		if (event.type !== "cell" || typeof event.code !== "string") throw new Error("invalid cell event");
		this.cells.push(event.code);
		this.responses.push(
			event.code.includes("rlm.done")
				? { type: "done" }
				: { type: "cell_result", stdout: "cell output\n", stderr: "", result: "42", error: null },
		);
	}

	async receive(): Promise<Record<string, unknown>> {
		const response = this.responses.shift();
		if (!response) throw new Error("Act channel has no response");
		return response;
	}
}

class BlockingActChannel implements HostRequestChannel {
	readonly outerToolCallId: string;
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	readonly cellSent: Promise<void>;
	cellsSent = 0;
	private resolveCellSent: () => void = () => {};
	private readonly response: Promise<Record<string, unknown>>;
	private resolveResponse: (response: Record<string, unknown>) => void = () => {};

	constructor(outerToolCallId = "test-root-ipython") {
		this.outerToolCallId = outerToolCallId;
		this.cellSent = new Promise((resolve) => {
			this.resolveCellSent = resolve;
		});
		this.response = new Promise((resolve) => {
			this.resolveResponse = resolve;
		});
	}

	async send(event: Record<string, unknown>): Promise<void> {
		if (event.type !== "cell") throw new Error("invalid cell event");
		this.cellsSent++;
		this.resolveCellSent();
	}

	receive(): Promise<Record<string, unknown>> {
		return this.response;
	}

	complete(response: Record<string, unknown>): void {
		this.resolveResponse(response);
	}
}

class SequencedActChannel implements HostRequestChannel {
	readonly outerToolCallId = "test-root-ipython";
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	readonly cells: string[] = [];
	private readonly responses: Array<Promise<Record<string, unknown>>> = [];
	private readonly responseResolvers: Array<(response: Record<string, unknown>) => void> = [];
	private receiveIndex = 0;

	async send(event: Record<string, unknown>): Promise<void> {
		if (event.type !== "cell" || typeof event.code !== "string") throw new Error("invalid cell event");
		this.cells.push(event.code);
		this.responses.push(
			new Promise((resolve) => {
				this.responseResolvers.push(resolve);
			}),
		);
	}

	receive(): Promise<Record<string, unknown>> {
		const response = this.responses[this.receiveIndex++];
		if (!response) throw new Error("Act channel has no pending cell");
		return response;
	}

	complete(index: number, response: Record<string, unknown>): void {
		const resolve = this.responseResolvers[index];
		if (!resolve) throw new Error(`Act cell ${index} was not sent`);
		resolve(response);
	}
}

class AbortableActChannel implements HostRequestChannel {
	readonly outerToolCallId = "test-root-ipython";
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	readonly interruptController = new AbortController();
	readonly interruptSignal = this.interruptController.signal;
	readonly cellSent: Promise<void>;
	readonly interruptDelays: number[] = [];
	private resolveCellSent: () => void = () => {};

	constructor() {
		this.cellSent = new Promise((resolve) => {
			this.resolveCellSent = resolve;
		});
	}

	async send(event: Record<string, unknown>): Promise<void> {
		if (event.type !== "cell") throw new Error("invalid cell event");
		this.resolveCellSent();
	}

	interruptAfterGrace(graceMs = 100): void {
		this.interruptDelays.push(graceMs);
	}

	receive(signal?: AbortSignal): Promise<Record<string, unknown>> {
		return new Promise((_resolve, reject) => {
			const abort = () => reject(new Error("receive aborted"));
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}
}

class GatedCancelActChannel implements HostRequestChannel {
	readonly outerToolCallId: string;
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	readonly cellSent: Promise<void>;
	readonly abortObserved: Promise<void>;
	private resolveCellSent: () => void = () => {};
	private resolveAbortObserved: () => void = () => {};
	private rejectAbort: ((error: Error) => void) | undefined;
	private released = false;

	constructor(outerToolCallId: string) {
		this.outerToolCallId = outerToolCallId;
		this.cellSent = new Promise((resolve) => {
			this.resolveCellSent = resolve;
		});
		this.abortObserved = new Promise((resolve) => {
			this.resolveAbortObserved = resolve;
		});
	}

	async send(event: Record<string, unknown>): Promise<void> {
		if (event.type !== "cell") throw new Error("invalid cell event");
		this.resolveCellSent();
	}

	receive(signal?: AbortSignal): Promise<Record<string, unknown>> {
		return new Promise((_resolve, reject) => {
			const abort = () => {
				this.resolveAbortObserved();
				this.rejectAbort = reject;
				if (this.released) reject(new Error("receive aborted"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}

	release(): void {
		this.released = true;
		this.rejectAbort?.(new Error("receive aborted"));
	}
}

class ClosingActChannel implements HostRequestChannel {
	readonly outerToolCallId = "test-root-ipython";
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	readonly interruptDelays: number[] = [];

	interruptAfterGrace(graceMs = 100): void {
		this.interruptDelays.push(graceMs);
	}

	async send(event: Record<string, unknown>): Promise<void> {
		if (event.type !== "cell") throw new Error("invalid cell event");
		this.controller.abort();
	}

	async receive(): Promise<Record<string, unknown>> {
		throw new Error("Act channel closed");
	}
}

interface TestMessageDeferred {
	promise: Promise<void>;
	resolve(): void;
	reject(error: Error): void;
}

function _createTestMessageDeferred(): TestMessageDeferred {
	const deferred = {} as TestMessageDeferred;
	deferred.promise = new Promise<void>((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});
	deferred.promise.catch(() => undefined);
	return deferred;
}

type ActSessionInternals = {
	_runAct(
		payload: Record<string, unknown>,
		signal: AbortSignal | undefined,
		channel: HostRequestChannel,
	): Promise<Record<string, unknown>>;
	_activeActStack?: Array<{ actId: string; depth: number }>;
	_actLanes?: Map<
		number,
		{
			session?: AgentSession;
			running: boolean;
			model?: { provider: string; id: string };
			usage: Usage;
		}
	>;
	_actTeardownPromise?: Promise<void>;
	_ipythonKernelProvisioner?: { dispose(): Promise<void> };
	_rootForeground: RootForegroundLease;
	_sessionInputPumpSuspended: boolean;
	_scheduleSessionInputPump(): void;
	_agentMessageOutcomes: Map<
		string,
		{
			delivery?: TestMessageDeferred;
			completion?: TestMessageDeferred;
		}
	>;
	_compactWithLease(customInstructions: string | undefined, hadPostCompactionContinue: boolean): Promise<unknown>;
	_postCompactionContinuationScheduled: boolean;
	_scheduledPostCompactionContinuationMessages: [];
	_runScheduledPostCompactionContinue(): Promise<void>;
};

describe("AgentSession Act lane", () => {
	it("admits queued root prompts, compaction, and cells once in foreground order after Act cleanup", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(42)" }), {
					stopReason: "toolUse",
				}),
				() => {
					order.push("prompt");
					return fauxAssistantMessage("root prompt complete");
				},
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const compact = vi.spyOn(internals, "_compactWithLease").mockImplementation(async () => {
				order.push("compaction");
				return {};
			});
			const abort = vi.spyOn(harness.session, "abort");
			const channel = new BlockingActChannel();
			const act = internals._rootForeground.run("root-cell", async () => {
				const token = internals._rootForeground.currentToken;
				if (!token) throw new Error("missing foreground token");
				const exitAct = internals._rootForeground.enterAct(token);
				try {
					return await internals._runAct({ prompt: "hold foreground" }, undefined, channel);
				} finally {
					exitAct();
				}
			});
			await channel.cellSent;
			const rootState = harness.session.agent.state as { isStreaming: boolean };
			rootState.isStreaming = true;

			const prompt = harness.session.prompt("queued root prompt");
			await vi.waitFor(() => expect(internals._rootForeground.pendingCount).toBe(1));
			const compaction = harness.session.compact();
			await vi.waitFor(() => expect(internals._rootForeground.pendingCount).toBe(2));
			const rootCell = internals._rootForeground.run("root-cell", async () => {
				order.push("cell");
			});
			await vi.waitFor(() => expect(internals._rootForeground.pendingCount).toBe(3));
			expect(order).toEqual([]);

			rootState.isStreaming = false;
			channel.complete({ type: "done" });
			await expect(act).resolves.toEqual({ outcome: "done" });
			await Promise.all([prompt, compaction, rootCell]);
			await vi.waitFor(() => expect(order).toEqual(["prompt", "compaction", "cell"]));
			expect(compact).toHaveBeenCalledTimes(1);
			expect(abort).not.toHaveBeenCalled();
			expect(internals._rootForeground.busy).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("queues ordinary text in order without interrupting the active Act", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(42)" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("steering applied"),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const events: ActProjectionEvent[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "act_event") events.push(event);
			});
			const channel = new BlockingActChannel();
			const act = internals._rootForeground.run("root-cell", () =>
				internals._runAct({ prompt: "hold" }, undefined, channel),
			);
			await channel.cellSent;
			(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
			await harness.session.steer("first queued message");
			await harness.session.steer("second queued message");
			const queued = harness.session.getSessionActionRecoverySnapshot().actions;
			expect(queued.map((action) => action.payload.text)).toEqual(["first queued message", "second queued message"]);
			expect(internals._actLanes?.get(1)?.running).toBe(true);
			channel.complete({ type: "done" });
			await expect(act).resolves.toEqual({ outcome: "done" });
			(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;
			internals._sessionInputPumpSuspended = false;
			internals._scheduleSessionInputPump();
			await vi.waitFor(() => expect(harness.session.queuedActionCount).toBe(0));
		} finally {
			harness.cleanup();
		}
	});

	it("holds ordered user steering until the outermost nested Act returns", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }, { id: "deepseek-model" }],
			settings: {
				rlmActMaxDepth: 2,
				rlmActDefaultModel: ["@luna", "@deepseek"],
				modelRoles: { luna: `${provider}/luna-model`, deepseek: `${provider}/deepseek-model` },
			},
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "await rlm.act('nested')" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(2)" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("queued steering applied"),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const outerChannel = new BlockingActChannel();
			const nestedChannel = new BlockingActChannel();
			const outer = internals._rootForeground.run("root-cell", () =>
				internals._runAct({ prompt: "depth one" }, undefined, outerChannel),
			);
			await outerChannel.cellSent;
			const nested = internals._runAct({ prompt: "depth two" }, undefined, nestedChannel);
			await nestedChannel.cellSent;
			(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
			await harness.session.steer("first nested steering");
			await harness.session.steer("second nested steering");
			expect(
				harness.session.getSessionActionRecoverySnapshot().actions.map((action) => action.payload.text),
			).toEqual(["first nested steering", "second nested steering"]);

			nestedChannel.complete({ type: "done" });
			await expect(nested).resolves.toEqual({ outcome: "done" });
			expect(internals._activeActStack?.map((frame) => frame.depth)).toEqual([1]);
			expect(harness.session.queuedActionCount).toBe(2);
			outerChannel.complete({ type: "done" });
			await expect(outer).resolves.toEqual({ outcome: "done" });
			(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;
			internals._sessionInputPumpSuspended = false;
			internals._scheduleSessionInputPump();
			await vi.waitFor(() => expect(harness.session.queuedActionCount).toBe(0));
		} finally {
			harness.cleanup();
		}
	});

	it("queues automatic continuation behind the foreground Act once", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			const internals = harness.session as unknown as ActSessionInternals;
			const continued = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const foreground = internals._rootForeground.run("root-cell", async () => {
				const token = internals._rootForeground.currentToken;
				if (!token) throw new Error("missing foreground token");
				const exitAct = internals._rootForeground.enterAct(token);
				try {
					await gate;
				} finally {
					exitAct();
				}
			});
			const rootState = harness.session.agent.state as { isStreaming: boolean };
			rootState.isStreaming = true;
			internals._postCompactionContinuationScheduled = true;
			internals._scheduledPostCompactionContinuationMessages = [];
			const continuation = internals._runScheduledPostCompactionContinue();
			await vi.waitFor(() => expect(internals._rootForeground.pendingCount).toBe(1));
			expect(continued).not.toHaveBeenCalled();
			rootState.isStreaming = false;
			release();
			await foreground;
			await continuation;
			expect(continued).toHaveBeenCalledTimes(1);
		} finally {
			harness.cleanup();
		}
	});

	it("releases one queued root mutation after every normal Act terminal", async () => {
		const cases: Array<{
			name: string;
			response: ReturnType<typeof fauxAssistantMessage>;
			channel: HostRequestChannel;
		}> = [
			{
				name: "done",
				response: fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(1)" }), {
					stopReason: "toolUse",
				}),
				channel: new TestActChannel(),
			},
			{
				name: "text",
				response: fauxAssistantMessage("finished without done"),
				channel: new TestActChannel(),
			},
			{
				name: "provider failure",
				response: fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
				channel: new TestActChannel(),
			},
			{
				name: "cancellation",
				response: fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "await blocked" }), {
					stopReason: "toolUse",
				}),
				channel: new ClosingActChannel(),
			},
		];
		for (const testCase of cases) {
			const harness = await createHarness({
				provider,
				models: [{ id: "sol-model" }, { id: "luna-model" }],
				settings: {
					rlmActDefaultModel: "@luna",
					modelRoles: { luna: `${provider}/luna-model` },
					retry: { enabled: false, provider: { maxRetries: 0 } },
				},
			});
			try {
				harness.setResponses([testCase.response]);
				const internals = harness.session as unknown as ActSessionInternals;
				let admitted = 0;
				const act = internals._rootForeground.run("root-cell", () =>
					internals._runAct({ prompt: testCase.name }, undefined, testCase.channel),
				);
				const queued = internals._rootForeground.run("root-turn", async () => {
					admitted++;
				});
				await act.catch(() => undefined);
				await queued;
				expect(admitted, testCase.name).toBe(1);
				expect(internals._rootForeground.busy, testCase.name).toBe(false);
			} finally {
				harness.cleanup();
			}
		}
	});

	it("retains one configured private session across sequential Acts", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			const actEvents: ActProjectionEvent[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "act_event") actEvents.push(event);
			});
			await harness.session.setServiceTier("scale");
			let secondActSawFirst = false;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "first_value = 42" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(first_value)" }), {
					stopReason: "toolUse",
				}),
				(context) => {
					secondActSawFirst = context.messages.some(
						(message) => message.role === "user" && JSON.stringify(message.content).includes("first task"),
					);
					return fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(first_value + 1)" }), {
						stopReason: "toolUse",
					});
				},
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const firstChannel = new TestActChannel();
			await expect(internals._runAct({ prompt: "first task" }, undefined, firstChannel)).resolves.toEqual({
				outcome: "done",
			});
			const laneSession = internals._actLanes?.get(1)?.session;
			expect(laneSession?.model?.id).toBe("luna-model");
			expect(laneSession?.serviceTier).toBe("scale");
			expect(laneSession?.getActiveToolNames()).toEqual(["shared_ipython"]);
			expect(
				(laneSession as unknown as { _ipythonKernelProvisioner?: unknown })._ipythonKernelProvisioner,
			).toBeUndefined();
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);

			const secondChannel = new TestActChannel();
			await expect(internals._runAct({ prompt: "second task" }, undefined, secondChannel)).resolves.toEqual({
				outcome: "done",
			});
			expect(internals._actLanes?.get(1)?.session).toBe(laneSession);
			expect(secondActSawFirst).toBe(true);
			expect(firstChannel.cells).toEqual(["first_value = 42", "rlm.done(first_value)"]);
			expect(secondChannel.cells).toEqual(["rlm.done(first_value + 1)"]);

			harness.appendResponses([fauxAssistantMessage("ordinary child completed")]);
			const child = await harness.session.runRlmChild("ordinary child");
			await vi.waitFor(async () => {
				expect((await harness.session.listRlmSubagents()).subagents).toContainEqual(
					expect.objectContaining({ rlm_child_id: child.rlm_child_id, status: "completed" }),
				);
			});
			expect(harness.session.getRlmChildSession(child.rlm_child_id)).not.toBe(laneSession);
			expect(actEvents.map((event) => event.event)).toEqual([
				"start",
				"cell_start",
				"cell_terminal",
				"cell_start",
				"cell_terminal",
				"terminal",
				"start",
				"cell_start",
				"cell_terminal",
				"terminal",
			]);
			expect(actEvents.every((event) => event.outerToolCallId === "test-root-ipython")).toBe(true);
			harness.session.dispose();
			expect((laneSession as unknown as { _disposed: boolean })._disposed).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes ordered assistant and shared-cell progress without private identities", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			const events: ActProjectionEvent[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "act_event") events.push(event);
			});
			const firstCode = `first_projection_cell = 1\n#${"c".repeat(ACT_EVENT_CELL_TEXT_MAX_CHARS)}`;
			const firstTool = fauxToolCall("shared_ipython", { code: firstCode });
			const secondTool = fauxToolCall("shared_ipython", { code: "rlm.done(first_projection_cell + 1)" });
			harness.setResponses([
				fauxAssistantMessage(
					[
						{ type: "thinking", thinking: "inspect the shared world" },
						{ type: "text", text: "run the first cell" },
						firstTool,
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([{ type: "text", text: "recover and finish" }, secondTool], {
					stopReason: "toolUse",
				}),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const channel = new SequencedActChannel();
			const run = internals._runAct({ prompt: "project two cells" }, undefined, channel);
			await vi.waitFor(() => expect(channel.cells).toHaveLength(1));
			const laneSession = internals._actLanes?.get(1)?.session;
			if (!laneSession) throw new Error("missing retained lane session");
			const privateEventCount = events.length;
			const emitPrivate = laneSession as unknown as { _emit(event: never): void };
			emitPrivate._emit({ type: "recap_update", recap: "private recap" } as never);
			emitPrivate._emit({
				type: "tool_execution_start",
				toolCallId: "private-tool-call-id",
				toolName: "private_tool",
				args: { secret: true },
			} as never);
			expect(events).toHaveLength(privateEventCount);
			emitPrivate._emit({
				type: "message_update",
				message: { role: "assistant", id: "private-assistant-message-id" },
				assistantMessageEvent: {
					type: "text_delta",
					delta: "d".repeat(ACT_EVENT_CELL_TEXT_MAX_CHARS + 1),
				},
			} as never);
			const boundedDelta = events.at(-1);
			expect(boundedDelta).toMatchObject({
				event: "assistant_delta",
				textTruncated: true,
			});
			if (boundedDelta?.event === "assistant_delta") {
				expect(boundedDelta.text).toHaveLength(ACT_EVENT_CELL_TEXT_MAX_CHARS);
			}

			channel.complete(0, {
				type: "cell_result",
				stdout: "o".repeat(ACT_EVENT_CELL_TEXT_MAX_CHARS + 1),
				stderr: "s".repeat(ACT_EVENT_CELL_TEXT_MAX_CHARS + 1),
				result: "r".repeat(ACT_EVENT_CELL_TEXT_MAX_CHARS + 1),
				error: "e".repeat(ACT_EVENT_ERROR_MAX_CHARS + 1),
			});
			await vi.waitFor(() => expect(channel.cells).toHaveLength(2));
			channel.complete(1, { type: "done" });
			await expect(run).resolves.toEqual({ outcome: "done" });
			expect(events[0]).toMatchObject({ event: "start", sequence: 1 });
			expect(events.at(-1)).toMatchObject({ event: "terminal", status: "done" });
			expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
			expect(
				events.every((event) =>
					["start", "assistant_delta", "cell_start", "cell_terminal", "terminal"].includes(event.event),
				),
			).toBe(true);
			const deltas = events.filter((event) => event.event === "assistant_delta");
			expect(deltas.map((event) => event.stream)).toContain("thinking");
			expect(deltas.map((event) => event.stream)).toContain("text");
			expect(deltas.map((event) => event.text).join("")).toContain("recover and finish");
			const firstCellStartIndex = events.findIndex((event) => event.event === "cell_start");
			const firstCellTerminalIndex = events.findIndex((event) => event.event === "cell_terminal");
			const secondCellStartIndex = events.findIndex(
				(event, index) => index > firstCellStartIndex && event.event === "cell_start",
			);
			expect(
				events
					.slice(1, firstCellStartIndex)
					.filter((event) => event.event === "assistant_delta")
					.map((event) => event.text)
					.join(""),
			).toContain("run the first cell");
			expect(
				events
					.slice(firstCellTerminalIndex + 1, secondCellStartIndex)
					.filter((event) => event.event === "assistant_delta")
					.map((event) => event.text)
					.join(""),
			).toContain("recover and finish");
			const starts = events.filter((event) => event.event === "cell_start");
			expect(starts.map((event) => event.cellId)).toEqual(["cell-1", "cell-2"]);
			expect(starts[0]).toMatchObject({
				code: firstCode.slice(0, ACT_EVENT_CELL_TEXT_MAX_CHARS),
				codeTruncated: true,
			});
			const cells = events.filter((event) => event.event === "cell_terminal");
			expect(cells.map((event) => event.cellId)).toEqual(["cell-1", "cell-2"]);
			expect(cells[0]).toMatchObject({
				status: "error",
				stdoutTruncated: true,
				stderrTruncated: true,
				resultTruncated: true,
				errorTruncated: true,
			});
			expect(cells[0]?.stdout).toHaveLength(ACT_EVENT_CELL_TEXT_MAX_CHARS);
			expect(cells[0]?.stderr).toHaveLength(ACT_EVENT_CELL_TEXT_MAX_CHARS);
			expect(cells[0]?.result).toHaveLength(ACT_EVENT_CELL_TEXT_MAX_CHARS);
			expect(cells[0]?.error).toHaveLength(ACT_EVENT_ERROR_MAX_CHARS);
			expect(cells[1]).toMatchObject({ status: "ok", stdout: "", stderr: "" });
			const serialized = JSON.stringify(events);
			expect(serialized).not.toContain("private-tool-call-id");
			expect(serialized).not.toContain("private-assistant-message-id");
			expect(serialized).not.toContain(firstTool.id);
			expect(serialized).not.toContain(secondTool.id);
			for (const message of laneSession.messages) {
				if ("id" in message && typeof message.id === "string") expect(serialized).not.toContain(message.id);
			}
			expect(serialized).not.toContain('"value"');
		} finally {
			harness.cleanup();
		}
	});

	it("emits one bounded journal terminal for every admitted Act outcome", async () => {
		type Scenario = {
			name: string;
			response: ReturnType<typeof fauxAssistantMessage>;
			channel: TestActChannel | AbortableActChannel;
			status: "done" | "cancelled" | "error";
			errorTruncated?: boolean;
			settle?: (channel: TestActChannel | AbortableActChannel) => Promise<void>;
		};
		const providerFailure = fauxAssistantMessage("provider failed", { stopReason: "error" });
		providerFailure.errorMessage = `provider exploded${"e".repeat(5000)}`;
		const scenarios: Scenario[] = [
			{
				name: "done",
				response: fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(1)" }), {
					stopReason: "toolUse",
				}),
				channel: new TestActChannel(),
				status: "done",
			},
			{
				name: "text",
				response: fauxAssistantMessage("forgot to call done"),
				channel: new TestActChannel(),
				status: "error",
			},
			{
				name: "provider-error",
				response: providerFailure,
				channel: new TestActChannel(),
				status: "error",
				errorTruncated: true,
			},
			{
				name: "cancelled-cell",
				response: fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "await pending()" }), {
					stopReason: "toolUse",
				}),
				channel: new AbortableActChannel(),
				status: "cancelled",
				settle: async (channel) => {
					if (!(channel instanceof AbortableActChannel)) throw new Error("expected abortable channel");
					await channel.cellSent;
					channel.controller.abort();
				},
			},
		];

		for (const scenario of scenarios) {
			const harness = await createHarness({
				provider,
				models: [{ id: "sol-model" }, { id: "luna-model" }],
				settings: {
					rlmActDefaultModel: "@luna",
					modelRoles: { luna: `${provider}/luna-model` },
					retry: { enabled: false, provider: { maxRetries: 0 } },
				},
			});
			try {
				const events: ActProjectionEvent[] = [];
				const journalTail: string[] = [];
				harness.session.subscribe((event) => {
					if (event.type !== "act_event") return;
					events.push(event);
					journalTail.push(harness.sessionManager.getBranch().at(-1)?.type ?? "missing");
				});
				harness.setResponses([scenario.response]);
				const prompt = `${scenario.name}:${"p".repeat(ACT_EVENT_PROMPT_MAX_CHARS)}`;
				const run = (harness.session as unknown as ActSessionInternals)._runAct(
					{ prompt },
					undefined,
					scenario.channel,
				);
				await scenario.settle?.(scenario.channel);
				if (scenario.status === "error" && scenario.name === "provider-error") {
					await expect(run).rejects.toThrow("provider exploded");
				} else {
					await expect(run).resolves.toMatchObject({
						outcome: scenario.status === "done" ? "done" : scenario.status === "cancelled" ? "cancelled" : "text",
					});
				}
				const boundaries = events.filter((event) => event.event === "start" || event.event === "terminal");
				expect(
					boundaries.map((event) => event.event),
					scenario.name,
				).toEqual(["start", "terminal"]);
				expect(
					events.map((event) => event.sequence),
					scenario.name,
				).toEqual(events.map((_, index) => index + 1));
				expect(new Set(events.map((event) => event.actId)).size, scenario.name).toBe(1);
				expect(
					events.every((event) => event.outerToolCallId === "test-root-ipython"),
					scenario.name,
				).toBe(true);
				expect(journalTail[0], scenario.name).toBe("act_start");
				expect(journalTail.at(-1), scenario.name).toBe("act_terminal");
				expect(
					journalTail.slice(0, -1).every((type) => type === "act_start"),
					scenario.name,
				).toBe(true);
				expect(boundaries[0], scenario.name).toMatchObject({
					event: "start",
					promptTruncated: true,
					model: { provider, id: "luna-model" },
				});
				expect(boundaries[1], scenario.name).toMatchObject({
					event: "terminal",
					status: scenario.status,
					promptTruncated: true,
					model: { provider, id: "luna-model" },
					errorTruncated: scenario.errorTruncated ?? false,
				});
				expect((events[0] as { prompt: string }).prompt).toHaveLength(ACT_EVENT_PROMPT_MAX_CHARS);
				expect((boundaries[1] as { prompt: string }).prompt).toHaveLength(ACT_EVENT_PROMPT_MAX_CHARS);
				const terminalEntries = harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal");
				expect(terminalEntries).toHaveLength(1);
				if (scenario.errorTruncated) expect(terminalEntries[0]?.error).toHaveLength(ACT_EVENT_ERROR_MAX_CHARS);
			} finally {
				harness.cleanup();
			}
		}
	}, 30_000);

	it("switches one retained transcript across default, role, and concrete Act selectors", async () => {
		const lunaUsage = usage(3, 1, 0.3);
		const deepseekUsage = usage(5, 2, 0.5);
		const directUsage = usage(7, 3, 0.7);
		const returnedDefaultUsage = usage(2, 1, 0.2);
		const done = (code: string, assistantUsage: Usage) => {
			const message = fauxAssistantMessage(fauxToolCall("shared_ipython", { code }), { stopReason: "toolUse" });
			message.usage = assistantUsage;
			return message;
		};
		const harness = await createHarness({
			provider,
			models: [
				{ id: "sol-model" },
				{ id: "luna-model", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
				{ id: "deepseek-model", cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
				{ id: "direct-model", cost: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0 } },
			],
			settings: {
				rlmActDefaultModel: "@luna",
				modelRoles: {
					luna: `${provider}/luna-model`,
					deepseek: `${provider}/deepseek-model`,
				},
			},
		});
		try {
			const actEvents: ActProjectionEvent[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "act_event") actEvents.push(event);
			});
			await harness.session.setServiceTier("scale");
			let deepseekSawLuna = false;
			let directSawBoth = false;
			harness.setResponses([
				done("rlm.done('luna')", lunaUsage),
				(context) => {
					deepseekSawLuna = context.messages.some(
						(message) => message.role === "user" && JSON.stringify(message.content).includes("default task"),
					);
					return done("rlm.done('deepseek')", deepseekUsage);
				},
				(context) => {
					directSawBoth = ["default task", "role task"].every((prompt) =>
						context.messages.some(
							(message) => message.role === "user" && JSON.stringify(message.content).includes(prompt),
						),
					);
					return done("rlm.done('direct')", directUsage);
				},
				done("rlm.done('default-again')", returnedDefaultUsage),
			]);
			const internals = harness.session as unknown as ActSessionInternals;

			await expect(internals._runAct({ prompt: "default task" }, undefined, new TestActChannel())).resolves.toEqual({
				outcome: "done",
			});
			const laneSession = internals._actLanes?.get(1)?.session;
			expect(laneSession?.model?.id).toBe("luna-model");

			await expect(
				internals._runAct({ prompt: "role task", model: "@deepseek" }, undefined, new TestActChannel()),
			).resolves.toEqual({ outcome: "done" });
			expect(internals._actLanes?.get(1)?.session).toBe(laneSession);
			expect(laneSession?.model?.id).toBe("deepseek-model");
			expect(deepseekSawLuna).toBe(true);

			await expect(
				internals._runAct(
					{ prompt: "concrete task", model: `${provider}/direct-model` },
					undefined,
					new TestActChannel(),
				),
			).resolves.toEqual({ outcome: "done" });
			expect(internals._actLanes?.get(1)?.session).toBe(laneSession);
			expect(laneSession?.model?.id).toBe("direct-model");
			expect(directSawBoth).toBe(true);

			await expect(internals._runAct({ prompt: "default again" }, undefined, new TestActChannel())).resolves.toEqual(
				{ outcome: "done" },
			);
			expect(internals._actLanes?.get(1)?.session).toBe(laneSession);
			expect(laneSession?.model?.id).toBe("luna-model");
			expect(laneSession?.serviceTier).toBe("scale");
			expect(harness.session.model?.id).toBe("sol-model");

			harness.appendResponses([fauxAssistantMessage("ordinary child completed")]);
			const child = await harness.session.runRlmChild("ordinary child after model switches");
			await vi.waitFor(async () => {
				expect((await harness.session.listRlmSubagents()).subagents).toContainEqual(
					expect.objectContaining({ rlm_child_id: child.rlm_child_id, status: "completed" }),
				);
			});
			expect(harness.session.getRlmChildSession(child.rlm_child_id)).not.toBe(laneSession);
			expect(harness.session.getRlmChildSession(child.rlm_child_id)?.model?.id).toBe("sol-model");

			const laneModels = laneSession?.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => entry.modelId);
			expect(laneModels).toEqual(["luna-model", "deepseek-model", "direct-model", "luna-model"]);
			const eventsByAct = [...new Set(actEvents.map((event) => event.actId))].map((actId) =>
				actEvents.filter((event) => event.actId === actId),
			);
			expect(eventsByAct.map((events) => events.map((event) => event.event))).toEqual([
				["start", "cell_start", "cell_terminal", "terminal"],
				["start", "cell_start", "cell_terminal", "terminal"],
				["start", "cell_start", "cell_terminal", "terminal"],
				["start", "cell_start", "cell_terminal", "terminal"],
			]);
			expect(eventsByAct.map((events) => events.find((event) => event.event === "cell_start")?.cellId)).toEqual([
				"cell-1",
				"cell-1",
				"cell-1",
				"cell-1",
			]);
			expect(actEvents.filter((event) => event.event === "start").map((event) => event.model.id)).toEqual([
				"luna-model",
				"deepseek-model",
				"direct-model",
				"luna-model",
			]);
			const terminals = harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal");
			expect(terminals.map((entry) => entry.model?.id)).toEqual([
				"luna-model",
				"deepseek-model",
				"direct-model",
				"luna-model",
			]);
			expect(terminals.every((entry) => entry.usage.totalTokens > 0)).toBe(true);
			const deepseekTerminal = terminals[1];
			if (!deepseekTerminal) throw new Error("missing DeepSeek Act terminal");
			harness.sessionManager.branch(deepseekTerminal.id);
			const deepseekProjection = actEvents.filter((event) => event.event === "terminal")[1];
			if (!deepseekProjection || deepseekProjection.event !== "terminal") {
				throw new Error("missing DeepSeek terminal projection");
			}
			const selectedActNode = harness.session.getContextTree().children.find((node) => node.id === "act");
			expect(selectedActNode).toMatchObject({
				model: deepseekProjection.model,
				cancellationCapability: deepseekProjection.cancellationCapability,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("rejects invalid and unavailable Act selectors before provider or cell work", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: {
				claudeCode: { executable: "/configured/claude" },
				rlmActDefaultModel: "@luna",
				modelRoles: {
					luna: `${provider}/luna-model`,
					claude: "claude-code/claude-opus-4-7:high",
				},
			},
		});
		try {
			const actEvents: ActProjectionEvent[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "act_event") actEvents.push(event);
			});
			const internals = harness.session as unknown as ActSessionInternals;
			const uncorrelatedChannel = new TestActChannel();
			Object.defineProperty(uncorrelatedChannel, "outerToolCallId", { value: undefined });
			await expect(internals._runAct({ prompt: "uncorrelated" }, undefined, uncorrelatedChannel)).rejects.toThrow(
				"rlm.act requires outer tool-call correlation",
			);
			const invalidChannel = new TestActChannel();
			await expect(internals._runAct({ prompt: "invalid", model: 7 }, undefined, invalidChannel)).rejects.toThrow(
				"rlm.act model must be a string",
			);
			expect(invalidChannel.cells).toEqual([]);
			expect(internals._actLanes?.get(1)).toBeUndefined();

			const unavailableChannel = new TestActChannel();
			await expect(
				internals._runAct(
					{ prompt: "unavailable", model: `${provider}/missing-model` },
					undefined,
					unavailableChannel,
				),
			).rejects.toThrow("unavailable, unauthenticated, or expired");
			expect(unavailableChannel.cells).toEqual([]);
			expect(internals._actLanes?.get(1)?.session).toBeUndefined();

			const nonNativeChannel = new TestActChannel();
			await expect(
				internals._runAct({ prompt: "non-native", model: "@claude" }, undefined, nonNativeChannel),
			).rejects.toThrow('Act model selector "@claude" must resolve to a native model');
			expect(nonNativeChannel.cells).toEqual([]);
			expect(internals._actLanes?.get(1)?.session).toBeUndefined();
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(actEvents).toEqual([]);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type.startsWith("act_"))).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("restores the private transcript, closes one orphan once, and separates Luna usage", async () => {
		const restartProvider = "faux-act-restart";
		const settings = { rlmActDefaultModel: "@luna", modelRoles: { luna: `${restartProvider}/luna-model` } };
		const solUsage = usage(10, 2, 1);
		const interruptedUsage = usage(7, 1, 0.7);
		let completedUsage: Usage | undefined;
		let completedEntryId: string | undefined;
		let solEntryId: string | undefined;
		const first = await createHarness({
			provider: restartProvider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings,
			persistSession: true,
			preserveTempDir: true,
		});
		const sessionFile = first.session.sessionFile;
		if (!sessionFile) throw new Error("persistent harness has no session file");
		const tempDir = first.tempDir;
		try {
			const rootMessage = fauxAssistantMessage("Sol turn");
			rootMessage.usage = solUsage;
			first.session.agent.state.messages.push(rootMessage);
			solEntryId = first.sessionManager.appendMessage(rootMessage);
			first.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(1)" }), {
					stopReason: "toolUse",
				}),
			]);
			const firstInternals = first.session as unknown as ActSessionInternals;
			await expect(
				firstInternals._runAct({ prompt: "remember this lane fact" }, undefined, new TestActChannel()),
			).resolves.toEqual({
				outcome: "done",
			});
			const facts = first.sessionManager.getBranch().filter((entry) => entry.type.startsWith("act_"));
			expect(facts.map((entry) => entry.type)).toEqual(["act_start", "act_terminal"]);
			const completed = facts[1];
			if (completed?.type !== "act_terminal") throw new Error("missing completed Act fact");
			expect(completed).toMatchObject({ status: "done" });
			expect(completed.usage.totalTokens).toBeGreaterThan(0);
			completedUsage = completed.usage;
			completedEntryId = completed.id;
			expect(completed).not.toHaveProperty("value");

			const orphanId = "synthetic-orphan";
			first.sessionManager.appendActStart(orphanId, completed.usage);
			const laneSession = firstInternals._actLanes?.get(1)?.session;
			if (!laneSession) throw new Error("missing retained lane session");
			expect(laneSession.sessionFile).toBe(
				join(first.sessionManager.getSessionArtifactDir()!, "act", "session.jsonl"),
			);
			const persistedPartial = fauxAssistantMessage("persisted provider work before crash");
			persistedPartial.usage = interruptedUsage;
			laneSession.sessionManager.appendMessage(persistedPartial);
		} finally {
			first.cleanup();
		}

		const historicalLines = readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => {
				const entry = JSON.parse(line) as { type?: string; actId?: string; depth?: number };
				if (entry.type === "act_start" && entry.actId === "synthetic-orphan") delete entry.depth;
				return JSON.stringify(entry);
			});
		writeFileSync(sessionFile, `${historicalLines.join("\n")}\n`);

		let resumed: Awaited<ReturnType<typeof createHarness>> | undefined;
		try {
			resumed = await createHarness({
				provider: restartProvider,
				models: [{ id: "sol-model" }, { id: "luna-model" }],
				settings,
				tempDir,
				sessionFile,
				preserveTempDir: true,
			});
			let retainedPromptSeen = false;
			resumed.setResponses([
				(context) => {
					retainedPromptSeen = context.messages.some(
						(message) =>
							message.role === "user" && JSON.stringify(message.content).includes("remember this lane fact"),
					);
					return fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(2)" }), {
						stopReason: "toolUse",
					});
				},
			]);
			const recovered = resumed.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "act_terminal" && entry.actId === "synthetic-orphan");
			expect(recovered).toHaveLength(1);
			expect(recovered[0]).toMatchObject({ status: "interrupted", usage: interruptedUsage });
			expect(resumed.getPendingResponseCount()).toBe(1);

			const resumedInternals = resumed.session as unknown as ActSessionInternals;
			await expect(
				resumedInternals._runAct({ prompt: "use the retained context" }, undefined, new TestActChannel()),
			).resolves.toEqual({ outcome: "done" });
			expect(retainedPromptSeen).toBe(true);
			const resumedTerminal = resumed.sessionManager
				.getBranch()
				.slice()
				.reverse()
				.find((entry) => entry.type === "act_terminal");
			if (resumedTerminal?.type !== "act_terminal" || !completedUsage) {
				throw new Error("missing resumed Act usage");
			}
			const tree = resumed.session.getContextTree();
			expect(tree.ownUsage).toEqual(solUsage);
			expect(tree.totalUsage.totalTokens).toBe(
				solUsage.totalTokens +
					completedUsage.totalTokens +
					interruptedUsage.totalTokens +
					resumedTerminal.usage.totalTokens,
			);
			expect(tree.contextUsage?.tokens).toBe(solUsage.totalTokens);
			const actNode = tree.children.find((node) => node.id === "act");
			expect(actNode).toMatchObject({
				label: actContextLabel(),
				model: { id: "luna-model" },
				cancellationCapability: actCancellationCapability(),
				status: "done",
			});
			expect(actNode?.totalUsage.totalTokens).toBe(
				completedUsage.totalTokens + interruptedUsage.totalTokens + resumedTerminal.usage.totalTokens,
			);

			if (!completedEntryId) throw new Error("missing first Act terminal id");
			resumed.sessionManager.branch(completedEntryId);
			const branchedTree = resumed.session.getContextTree();
			expect(branchedTree.totalUsage.totalTokens).toBe(solUsage.totalTokens + completedUsage.totalTokens);
			expect(branchedTree.children.find((node) => node.id === "act")?.totalUsage).toEqual(completedUsage);
			if (!solEntryId) throw new Error("missing Sol entry id");
			resumed.sessionManager.branch(solEntryId);
			expect(resumed.session.getContextTree().children.some((node) => node.id === "act")).toBe(false);
		} finally {
			resumed?.cleanup();
		}

		const final = await createHarness({
			provider: restartProvider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings,
			tempDir,
			sessionFile,
		});
		try {
			expect(
				final.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "act_terminal" && entry.actId === "synthetic-orphan"),
			).toHaveLength(1);
		} finally {
			final.cleanup();
		}
	});

	it("recovers an unmatched depth-two start from its own retained transcript once", async () => {
		const restartProvider = "faux-act-depth-restart";
		const settings = {
			rlmActMaxDepth: 2,
			rlmActDefaultModel: ["@luna", "@deepseek"],
			modelRoles: { luna: `${restartProvider}/luna-model`, deepseek: `${restartProvider}/deepseek-model` },
		};
		const interruptedUsage = usage(9, 2, 0.9);
		const first = await createHarness({
			provider: restartProvider,
			models: [{ id: "sol-model" }, { id: "luna-model" }, { id: "deepseek-model" }],
			settings,
			persistSession: true,
			preserveTempDir: true,
		});
		const sessionFile = first.session.sessionFile;
		if (!sessionFile) throw new Error("persistent harness has no session file");
		const tempDir = first.tempDir;
		try {
			first.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "nested = await rlm.act('nested')" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(2)" }), {
					stopReason: "toolUse",
				}),
			]);
			const internals = first.session as unknown as ActSessionInternals;
			const outerChannel = new BlockingActChannel("root-ipython");
			const outer = internals._rootForeground.run("root-cell", () =>
				internals._runAct({ prompt: "outer" }, undefined, outerChannel),
			);
			await outerChannel.cellSent;
			const nestedChannel = new BlockingActChannel("root-ipython");
			const nested = internals._runAct({ prompt: "nested" }, undefined, nestedChannel);
			await nestedChannel.cellSent;
			nestedChannel.complete({ type: "done" });
			await nested;
			const outerActId = first.sessionManager.getBranch().find((entry) => entry.type === "act_start")?.actId;
			if (!outerActId) throw new Error("missing outer Act start");
			const lane = internals._actLanes?.get(2);
			if (!lane?.session) throw new Error("missing depth-two lane");
			first.sessionManager.appendActStart("depth-two-orphan", lane.usage, {
				depth: 2,
				parentActId: outerActId,
			});
			const partial = fauxAssistantMessage("depth two provider work before crash");
			partial.usage = interruptedUsage;
			lane.session.sessionManager.appendMessage(partial);
			outerChannel.complete({ type: "done" });
			await outer;
		} finally {
			first.cleanup();
		}

		const resumed = await createHarness({
			provider: restartProvider,
			models: [{ id: "sol-model" }, { id: "luna-model" }, { id: "deepseek-model" }],
			settings,
			tempDir,
			sessionFile,
		});
		try {
			const recovered = resumed.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "act_terminal" && entry.actId === "depth-two-orphan");
			expect(recovered).toHaveLength(1);
			expect(recovered[0]).toMatchObject({
				depth: 2,
				parentActId: expect.any(String),
				status: "interrupted",
				usage: interruptedUsage,
				model: { id: "deepseek-model" },
			});
			const depthOne = resumed.session.getContextTree().children.find((node) => node.id === "act");
			expect(depthOne?.children[0]).toMatchObject({ id: "act-depth-2", depth: 2, status: "cancelled" });
		} finally {
			resumed.cleanup();
		}
	});

	it("rejects a second Act at the default maximum and completes the admitted one once", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(1)" }), {
					stopReason: "toolUse",
				}),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const channel = new BlockingActChannel();
			const first = internals._runAct({ prompt: "first" }, undefined, channel);
			await channel.cellSent;
			await expect(internals._runAct({ prompt: "second" }, undefined, new TestActChannel())).rejects.toThrow(
				"rlm.act depth 2 exceeds rlmActMaxDepth 1",
			);
			channel.complete({ type: "done" });
			await expect(first).resolves.toEqual({ outcome: "done" });
		} finally {
			harness.cleanup();
		}
	});

	it("retains the lane after a provider failure", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: {
				rlmActDefaultModel: "@luna",
				modelRoles: { luna: `${provider}/luna-model` },
				retry: { enabled: false, provider: { maxRetries: 0 } },
			},
		});
		try {
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider boom" })]);
			const internals = harness.session as unknown as ActSessionInternals;
			await expect(internals._runAct({ prompt: "fail" }, undefined, new TestActChannel())).rejects.toThrow(
				"provider boom",
			);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal")).toEqual([
				expect.objectContaining({ status: "error", error: "provider boom" }),
			]);
			const laneSession = internals._actLanes?.get(1)?.session;
			harness.appendResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done('recovered')" }), {
					stopReason: "toolUse",
				}),
			]);
			await expect(internals._runAct({ prompt: "recover" }, undefined, new TestActChannel())).resolves.toEqual({
				outcome: "done",
			});
			expect(internals._actLanes?.get(1)?.session).toBe(laneSession);
			expect(
				harness.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "act_terminal")
					.map((entry) => (entry.type === "act_terminal" ? entry.status : undefined)),
			).toEqual(["error", "done"]);
		} finally {
			harness.cleanup();
		}
	});

	it("closes an interrupted exchange and reuses the lane", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "await interrupted_work" }), {
					stopReason: "toolUse",
				}),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const closing = new ClosingActChannel();
			await expect(internals._runAct({ prompt: "interrupt" }, closing.signal, closing)).resolves.toEqual({
				outcome: "cancelled",
			});
			expect(closing.interruptDelays).toEqual([]);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal")).toHaveLength(1);
			expect(
				harness.sessionManager
					.getBranch()
					.slice()
					.reverse()
					.find((entry) => entry.type === "act_terminal"),
			).toMatchObject({ status: "cancelled" });
			const laneSession = internals._actLanes?.get(1)?.session;
			harness.appendResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done('later')" }), {
					stopReason: "toolUse",
				}),
			]);
			await expect(internals._runAct({ prompt: "later" }, undefined, new TestActChannel())).resolves.toEqual({
				outcome: "done",
			});
			expect(internals._actLanes?.get(1)?.session).toBe(laneSession);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal")).toHaveLength(2);
		} finally {
			harness.cleanup();
		}
	});

	it("requests one delayed interrupt when the correlated outer execution aborts", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "while True: pass" }), {
					stopReason: "toolUse",
				}),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const channel = new AbortableActChannel();
			const run = internals._runAct({ prompt: "wait for an outer interrupt" }, undefined, channel);
			await channel.cellSent;
			channel.interruptController.abort();
			await expect(run).resolves.toEqual({ outcome: "cancelled" });
			expect(channel.interruptDelays).toEqual([100]);
		} finally {
			harness.cleanup();
		}
	});

	it("cancels a cell reply wait when the root session is disposed", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "await blocked_reply" }), {
					stopReason: "toolUse",
				}),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const channel = new AbortableActChannel();
			const run = internals._rootForeground.run("root-cell", () =>
				internals._runAct({ prompt: "wait for a cell reply" }, undefined, channel),
			);
			await channel.cellSent;
			const queued = internals._rootForeground.run("root-turn", async () => {});
			let kernelDisposals = 0;
			internals._ipythonKernelProvisioner = {
				dispose: async () => {
					kernelDisposals++;
					expect(internals._rootForeground.busy).toBe(false);
					expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal")).toEqual([
						expect.objectContaining({ status: "cancelled" }),
					]);
				},
			};
			const abort = harness.session.abort();
			const disposal = harness.session.disposeAsync();
			const teardown = internals._actTeardownPromise;
			const rejectedAdmission = harness.session.prompt("must not be admitted");
			harness.session.dispose();
			const concurrentDisposal = harness.session.disposeAsync();
			expect(internals._actTeardownPromise).toBe(teardown);
			await expect(rejectedAdmission).rejects.toThrow(/disposing|disposed/);
			await expect(run).resolves.toEqual({ outcome: "cancelled" });
			await Promise.all([abort, disposal, concurrentDisposal]);
			expect(kernelDisposals).toBe(1);
			await expect(queued).rejects.toThrow("Session disposed before foreground admission");
			expect(teardown).toBeDefined();
			expect(internals._rootForeground.busy).toBe(false);
			expect(channel.interruptDelays).toEqual([100]);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal")).toEqual([
				expect.objectContaining({ status: "cancelled" }),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("disposes a private session created after root disposal", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		const root = harness.session as unknown as {
			_resolveRlmSubagentModel(role: string): Promise<unknown>;
		};
		const resolution = await root._resolveRlmSubagentModel("@luna");
		let releaseResolution: (() => void) | undefined;
		root._resolveRlmSubagentModel = () =>
			new Promise((resolve) => {
				releaseResolution = () => resolve(resolution);
			});
		const disposeSession = AgentSession.prototype.dispose;
		const disposedSessions: AgentSession[] = [];
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession) {
			disposedSessions.push(this);
			disposeSession.call(this);
		});
		try {
			const internals = harness.session as unknown as ActSessionInternals;
			const run = internals._runAct({ prompt: "dispose while resolving" }, undefined, new TestActChannel());
			await vi.waitFor(() => expect(releaseResolution).toBeDefined());
			harness.session.dispose();
			releaseResolution?.();
			await expect(run).resolves.toEqual({ outcome: "cancelled" });
			expect(disposedSessions).toContain(harness.session);
			expect(disposedSessions.filter((session) => session !== harness.session)).toHaveLength(1);
			expect(internals._actLanes?.get(1)?.session).toBeUndefined();
		} finally {
			disposeSpy.mockRestore();
			harness.cleanup();
		}
	});

	it("cancels an existing lane when root disposal races a model switch", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }, { id: "deepseek-model" }],
			settings: {
				rlmActDefaultModel: "@luna",
				modelRoles: {
					luna: `${provider}/luna-model`,
					deepseek: `${provider}/deepseek-model`,
				},
			},
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(1)" }), { stopReason: "toolUse" }),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			await internals._runAct({ prompt: "create lane" }, undefined, new TestActChannel());
			let releaseSelection: (() => void) | undefined;
			const lane = internals._actLanes?.get(1);
			if (!lane?.session) throw new Error("missing retained lane");
			const root = harness.session as unknown as {
				_selectActLaneModel(session: AgentSession, model: string | undefined): Promise<void>;
			};
			root._selectActLaneModel = () =>
				new Promise((resolve) => {
					releaseSelection = resolve;
				});
			const run = internals._runAct(
				{ prompt: "switch while disposing", model: "@deepseek" },
				undefined,
				new TestActChannel(),
			);
			await vi.waitFor(() => expect(releaseSelection).toBeDefined());
			harness.session.dispose();
			releaseSelection?.();
			await expect(run).resolves.toEqual({ outcome: "cancelled" });
			expect(internals._actLanes?.get(1)?.session).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("admits one retained lane per Act depth and rejects depth three before side effects", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }, { id: "deepseek-model" }, { id: "review-model" }],
			persistSession: true,
			settings: {
				rlmActMaxDepth: 2,
				rlmActDefaultModel: ["@luna", "@deepseek"],
				modelRoles: {
					luna: `${provider}/luna-model`,
					deepseek: `${provider}/deepseek-model`,
					review: `${provider}/review-model`,
				},
			},
		});
		try {
			const actEvents: Array<{
				actId: string;
				event: string;
				depth?: number;
				parentActId?: string;
				directingModel?: { id: string };
			}> = [];
			harness.session.subscribe((event) => {
				if (event.type === "act_event") actEvents.push(event);
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "nested = await rlm.act('inspect')" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done({'depth': 2})" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done({'override': true})" }), {
					stopReason: "toolUse",
				}),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const resolver = vi.spyOn(
				harness.session as unknown as { _resolveRlmSubagentModel(model: string): Promise<unknown> },
				"_resolveRlmSubagentModel",
			);
			const outerChannel = new BlockingActChannel("root-ipython");
			const outer = internals._rootForeground.run("root-cell", () =>
				internals._runAct({ prompt: "depth one" }, undefined, outerChannel),
			);
			await outerChannel.cellSent;

			const nestedChannel = new BlockingActChannel("root-ipython");
			const nested = internals._runAct({ prompt: "depth two" }, undefined, nestedChannel);
			const nestedAdmission = await Promise.race([
				nestedChannel.cellSent.then(() => "cell" as const),
				nested.then(
					() => "terminal" as const,
					(error) => `error:${error instanceof Error ? error.message : String(error)}` as const,
				),
			]);
			expect(nestedAdmission).toBe("cell");

			const resolverCalls = resolver.mock.calls.length;
			const overDepthChannel = new BlockingActChannel("root-ipython");
			await expect(
				internals._runAct({ prompt: "depth three", model: "@review" }, undefined, overDepthChannel),
			).rejects.toThrow("rlm.act depth 3 exceeds rlmActMaxDepth 2");
			expect(resolver).toHaveBeenCalledTimes(resolverCalls);
			expect(overDepthChannel.cellsSent).toBe(0);

			nestedChannel.complete({ type: "done" });
			await expect(nested).resolves.toEqual({ outcome: "done" });
			const overrideChannel = new BlockingActChannel("root-ipython");
			const override = internals._runAct(
				{ prompt: "depth two override", model: "@review" },
				undefined,
				overrideChannel,
			);
			await overrideChannel.cellSent;
			overrideChannel.complete({ type: "done" });
			await expect(override).resolves.toEqual({ outcome: "done" });

			expect([...(internals._actLanes?.keys() ?? [])]).toEqual([1, 2]);
			const depthOneSession = internals._actLanes?.get(1)?.session;
			const depthTwoSession = internals._actLanes?.get(2)?.session;
			expect(depthOneSession).not.toBe(depthTwoSession);
			expect(depthOneSession?.sessionFile).toBe(
				join(harness.sessionManager.getSessionArtifactDir()!, "act", "session.jsonl"),
			);
			expect(depthTwoSession?.sessionFile).toBe(
				join(harness.sessionManager.getSessionArtifactDir()!, "act-depth-2", "session.jsonl"),
			);
			expect(internals._actLanes?.get(2)?.model?.id).toBe("review-model");
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
			outerChannel.complete({ type: "done" });
			await expect(outer).resolves.toEqual({ outcome: "done" });

			const facts = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "act_start" || entry.type === "act_terminal") as Array<{
				type: "act_start" | "act_terminal";
				actId: string;
				depth?: number;
				parentActId?: string;
			}>;
			const outerActId = facts[0]?.actId;
			expect(facts.map(({ type, depth, parentActId }) => ({ type, depth, parentActId }))).toEqual([
				{ type: "act_start", depth: 1, parentActId: undefined },
				{ type: "act_start", depth: 2, parentActId: outerActId },
				{ type: "act_terminal", depth: 2, parentActId: outerActId },
				{ type: "act_start", depth: 2, parentActId: outerActId },
				{ type: "act_terminal", depth: 2, parentActId: outerActId },
				{ type: "act_terminal", depth: 1, parentActId: undefined },
			]);
			for (const event of actEvents) {
				const fact = facts.find((entry) => entry.actId === event.actId);
				expect(event.depth).toBe(fact?.depth);
				expect(event.parentActId).toBe(fact?.parentActId);
				if (event.event === "start" || event.event === "terminal") {
					expect(event.directingModel?.id).toBe(event.depth === 1 ? "sol-model" : "luna-model");
				}
			}
			const actNode = harness.session.getContextTree().children.find((node) => node.id === "act");
			expect(actNode).toMatchObject({ depth: 1, model: { id: "luna-model" } });
			expect(actNode?.children).toHaveLength(1);
			expect(actNode?.children[0]).toMatchObject({
				id: "act-depth-2",
				depth: 2,
				model: { id: "review-model" },
			});
			const terminals = harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal");
			expect(terminals.map((entry) => [entry.depth, entry.model?.id])).toEqual([
				[2, "deepseek-model"],
				[2, "review-model"],
				[1, "luna-model"],
			]);
			const tokensAtDepth = (depth: number) =>
				terminals
					.filter((entry) => (entry.depth ?? 1) === depth)
					.reduce((total, entry) => total + entry.usage.totalTokens, 0);
			expect(actNode?.totalUsage.totalTokens).toBe(tokensAtDepth(1));
			expect(actNode?.children[0]?.totalUsage.totalTokens).toBe(tokensAtDepth(2));
			const tree = harness.session.getContextTree();
			expect(tree.totalUsage.totalTokens - tree.ownUsage.totalTokens).toBe(tokensAtDepth(1) + tokensAtDepth(2));
		} finally {
			harness.cleanup();
		}
	});

	it("requires an explicit depth-two model when the configured default is scalar", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }, { id: "deepseek-model" }],
			settings: {
				rlmActMaxDepth: 2,
				rlmActDefaultModel: "@luna",
				modelRoles: { luna: `${provider}/luna-model`, deepseek: `${provider}/deepseek-model` },
			},
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "await rlm.act('nested')" }), {
					stopReason: "toolUse",
				}),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			const resolver = vi.spyOn(
				harness.session as unknown as { _resolveRlmSubagentModel(model: string): Promise<unknown> },
				"_resolveRlmSubagentModel",
			);
			const outerChannel = new BlockingActChannel();
			const outer = internals._rootForeground.run("root-cell", () =>
				internals._runAct({ prompt: "depth one" }, undefined, outerChannel),
			);
			await outerChannel.cellSent;
			const resolverCalls = resolver.mock.calls.length;
			const nestedChannel = new BlockingActChannel();
			await expect(internals._runAct({ prompt: "depth two" }, undefined, nestedChannel)).rejects.toThrow(
				"rlm.act requires an explicit model at Act depth 2 because rlmActDefaultModel has no entry",
			);
			expect(resolver).toHaveBeenCalledTimes(resolverCalls);
			expect(nestedChannel.cellsSent).toBe(0);
			outerChannel.complete({ type: "done" });
			await expect(outer).resolves.toEqual({ outcome: "done" });
		} finally {
			harness.cleanup();
		}
	});

	it("cancels a nested chain observably deepest to outermost", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }, { id: "deepseek-model" }],
			settings: {
				rlmActMaxDepth: 2,
				rlmActDefaultModel: ["@luna", "@deepseek"],
				modelRoles: { luna: `${provider}/luna-model`, deepseek: `${provider}/deepseek-model` },
			},
		});
		const outerChannel = new GatedCancelActChannel("root-ipython");
		const nestedChannel = new GatedCancelActChannel("root-ipython");
		let outer: Promise<Record<string, unknown>> | undefined;
		let nested: Promise<Record<string, unknown>> | undefined;
		let cancellation: Promise<void> | undefined;
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "await rlm.act('nested')" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "await nested_gate" }), {
					stopReason: "toolUse",
				}),
			]);
			const internals = harness.session as unknown as ActSessionInternals;
			outer = internals._rootForeground.run("root-cell", () =>
				internals._runAct({ prompt: "depth one" }, undefined, outerChannel),
			);
			await outerChannel.cellSent;
			nested = internals._runAct({ prompt: "depth two" }, undefined, nestedChannel);
			await nestedChannel.cellSent;

			let outerAbortObserved = false;
			void outerChannel.abortObserved.then(() => {
				outerAbortObserved = true;
			});
			cancellation = harness.session.abort();
			await nestedChannel.abortObserved;
			await Promise.resolve();
			expect(outerAbortObserved).toBe(false);

			nestedChannel.release();
			await expect(nested).resolves.toEqual({ outcome: "cancelled" });
			await outerChannel.abortObserved;
			outerChannel.release();
			await expect(outer).resolves.toEqual({ outcome: "cancelled" });
			await cancellation;
			const terminals = harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal");
			expect(terminals.map((entry) => entry.model?.id)).toEqual(["deepseek-model", "luna-model"]);
			expect(internals._rootForeground.busy).toBe(false);
		} finally {
			nestedChannel.release();
			outerChannel.release();
			await Promise.allSettled([
				...(nested ? [nested] : []),
				...(outer ? [outer] : []),
				...(cancellation ? [cancellation] : []),
			]);
			harness.cleanup();
		}
	});

	it("does not register Act on a child session", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
			rlmDepth: 1,
			rlmMaxDepth: 2,
		});
		try {
			const handlers = (
				harness.session as unknown as { _createKernelHostHandlers(): Record<string, unknown> }
			)._createKernelHostHandlers();
			expect(handlers["rlm.act"]).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("requires an explicit model when no Act default is configured", async () => {
		const harness = await createHarness({ provider, models: [{ id: "sol-model" }, { id: "act-model" }] });
		try {
			const internals = harness.session as unknown as ActSessionInternals;
			await expect(internals._runAct({ prompt: "task" }, undefined, new TestActChannel())).rejects.toThrow(
				"rlm.act requires an explicit model when rlmActDefaultModel is not configured",
			);
			expect(internals._actLanes?.get(1)).toBeUndefined();

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(1)" }), { stopReason: "toolUse" }),
			]);
			await expect(
				internals._runAct(
					{ prompt: "explicit task", model: `${provider}/act-model` },
					undefined,
					new TestActChannel(),
				),
			).resolves.toEqual({ outcome: "done" });
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});
