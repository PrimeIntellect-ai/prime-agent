import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeInFlightToolCalls } from "../../../src/core/agent-observe.js";
import { createHarness, type Harness } from "../harness.js";

function blockingTool(name: string, release: Promise<void>): AgentTool {
	return {
		name,
		label: name,
		description: "Blocks until the test releases it",
		parameters: Type.Object({}),
		execute: async () => {
			await release;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
}

/**
 * `agent_observe` reported that a child was executing a tool call but never for how
 * long, so a child three seconds into a fast command and a child forty minutes into a
 * blocked one produced byte-identical summaries. The `bash` tool's timeout is optional
 * with no default, so an indefinitely blocking call is ordinary behaviour.
 */
describe("issue #822 agent_observe in-flight tool call progress", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reports nothing in flight for an empty map", () => {
		expect(summarizeInFlightToolCalls(new Map())).toEqual({ pendingToolCallCount: 0 });
	});

	it("measures elapsed time from the longest-running call", () => {
		const now = 1_800_000_000_000;
		const summary = summarizeInFlightToolCalls(
			new Map([
				["call-recent", now - 3_000],
				["call-oldest", now - 2_400_000],
				["call-middle", now - 60_000],
			]),
			now,
		);

		expect(summary).toEqual({
			pendingToolCallCount: 3,
			oldestPendingToolCallStartedAt: now - 2_400_000,
			pendingToolCallElapsedMs: 2_400_000,
		});
	});

	it("never reports a negative duration when the clock moves backwards", () => {
		const summary = summarizeInFlightToolCalls(new Map([["call", 2_000]]), 1_000);

		expect(summary.pendingToolCallElapsedMs).toBe(0);
	});

	it("tracks start times across tool execution and clears them when the run ends", async () => {
		let releaseFirst = () => {};
		let releaseSecond = () => {};
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const second = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const harness = await createHarness({
			tools: [blockingTool("slow", first), blockingTool("slower", second)],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", {}), fauxToolCall("slower", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawBothStart = new Promise<void>((resolve) => {
			let started = 0;
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && ++started === 2) {
					unsubscribe();
					resolve();
				}
			});
		});

		const before = Date.now();
		const turn = harness.session.prompt("start");
		await sawBothStart;

		const state = harness.session.agent.state;
		expect(state.pendingToolCallStartedAt.size).toBe(2);
		expect([...state.pendingToolCallStartedAt.keys()].sort()).toEqual([...state.pendingToolCalls].sort());
		for (const startedAt of state.pendingToolCallStartedAt.values()) {
			expect(startedAt).toBeGreaterThanOrEqual(before);
		}

		const inFlight = summarizeInFlightToolCalls(state.pendingToolCallStartedAt);
		expect(inFlight.pendingToolCallCount).toBe(2);
		expect(inFlight.pendingToolCallElapsedMs).toBeGreaterThanOrEqual(0);

		releaseFirst();
		releaseSecond();
		await turn;
		await harness.session.waitForIdle();

		expect(harness.session.agent.state.pendingToolCallStartedAt.size).toBe(0);
		expect(summarizeInFlightToolCalls(harness.session.agent.state.pendingToolCallStartedAt)).toEqual({
			pendingToolCallCount: 0,
		});
	});
});
