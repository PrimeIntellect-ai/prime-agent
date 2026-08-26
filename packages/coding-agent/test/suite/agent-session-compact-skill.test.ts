import type { ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

type SessionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => Promise<boolean>;
	_createKernelHostHandlers: () => Record<string, unknown>;
};

function createAssistant(
	harness: Harness,
	options: { stopReason?: AssistantMessage["stopReason"]; errorMessage?: string } = {},
) {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: Date.now(),
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

function setStreaming(harness: Harness, streaming: boolean) {
	(harness.session.agent.state as { isStreaming: boolean }).isStreaming = streaming;
}

/** Extension that supplies compaction content so no provider call is needed. */
function extensionCompaction() {
	return (pi: any) => {
		pi.on("session_before_compact", async (event: any) => ({
			compaction: {
				summary: "requested summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {},
			},
		}));
	};
}

describe("AgentSession compact skill host requests", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("schedules via compact.run and compacts at the turn boundary with reason requested", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		const runResult = harness.session.handleCompactHostRequest("compact.run", { instructions: "keep the plan" });
		setStreaming(harness, false);
		expect(runResult.scheduled).toBe(true);
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(true);

		const internals = harness.session as unknown as SessionInternals;
		const compacted = await internals._checkCompaction(createAssistant(harness));
		expect(compacted).toBe(false); // no retry needed

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start").at(-1)).toMatchObject({
			reason: "requested",
			customInstructions: "keep the plan",
		});
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "requested" });
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
	});

	it("reports skipped when there is nothing to compact", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		setStreaming(harness, true);
		const result = harness.session.handleCompactHostRequest("compact.run");
		setStreaming(harness, false);
		expect(result).toEqual({ scheduled: false, reason: "session is too short to compact" });
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
	});

	it("runs a requested compaction even when auto-compaction is disabled", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		expect(harness.session.handleCompactHostRequest("compact.run").scheduled).toBe(true);
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		await expect(
			internals._shouldStopAfterTurn({ message: createAssistant(harness) } as ShouldStopAfterTurnContext),
		).resolves.toBe(true);
		await internals._checkCompaction(createAssistant(harness));

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
	});

	it("drops a pending requested compaction when the turn is aborted", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		expect(harness.session.handleCompactHostRequest("compact.run").scheduled).toBe(true);
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		const compacted = await internals._checkCompaction(createAssistant(harness, { stopReason: "aborted" }));
		expect(compacted).toBe(false);
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("drops a pending requested compaction on the pre-prompt path after an abort", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		expect(harness.session.handleCompactHostRequest("compact.run").scheduled).toBe(true);
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		const compacted = await internals._checkCompaction(createAssistant(harness, { stopReason: "aborted" }), false);
		expect(compacted).toBe(false);
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("rejects compact.run while no turn is active", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = harness.session.handleCompactHostRequest("compact.run");
		expect(result.scheduled).toBe(false);
		expect(result.reason).toContain("no active turn");
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
	});

	it("prioritizes overflow recovery over a pending requested compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
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
		const internals = harness.session as unknown as SessionInternals;
		const overflow = createAssistant(harness, { stopReason: "error", errorMessage: "prompt is too long" });
		const compacted = await internals._checkCompaction(overflow);
		await vi.advanceTimersByTimeAsync(100);
		vi.useRealTimers();

		expect(compacted).toBe(true); // willRetry
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

		(harness.session as unknown as { _pendingRequestedCompaction?: object })._pendingRequestedCompaction = {};
		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued" }],
			display: false,
			timestamp: Date.now(),
		});
		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		const internals = harness.session as unknown as SessionInternals;
		const compacted = await internals._checkCompaction(createAssistant(harness));
		await vi.advanceTimersByTimeAsync(100);
		vi.useRealTimers();

		expect(compacted).toBe(false);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("Requested compaction skipped");
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps a pending requested compaction when manual compaction fails", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: any) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		expect(harness.session.handleCompactHostRequest("compact.run").scheduled).toBe(true);
		setStreaming(harness, false);

		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(true);
	});

	it("clears a pending requested compaction when manual compaction succeeds", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		expect(harness.session.handleCompactHostRequest("compact.run").scheduled).toBe(true);
		setStreaming(harness, false);

		await harness.session.compact();
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
	});

	it("reports context usage via compact.status", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		const status = harness.session.handleCompactHostRequest("compact.status");
		expect(status.scheduled).toBe(false);
		expect(status.context_window).not.toBeNull();
	});

	it("is gated by the compaction.agentCallable setting", async () => {
		const harness = await createHarness({ settings: { compaction: { agentCallable: false } } });
		harnesses.push(harness);

		expect(() => harness.session.handleCompactHostRequest("compact.run")).toThrow(
			"the compact skill is disabled in this session",
		);
		const internals = harness.session as unknown as SessionInternals;
		expect(Object.keys(internals._createKernelHostHandlers())).not.toContain("compact.run");

		const enabledHarness = await createHarness();
		harnesses.push(enabledHarness);
		const enabledInternals = enabledHarness.session as unknown as SessionInternals;
		expect(Object.keys(enabledInternals._createKernelHostHandlers())).toEqual(
			expect.arrayContaining(["compact.run", "compact.status"]),
		);
	});
});
