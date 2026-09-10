import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionMessage } from "../src/core/agent-messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import { cloneUsage, emptyUsage } from "../src/core/usage.js";
import { type ChildUsageHost, type ChildUsageTracker, SessionChildUsage } from "../src/session/child-usage.js";

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function record(tracker: ChildUsageTracker, childUsage: Usage, prompt?: AgentMessage): void {
	const assistant: AssistantMessage = { ...fauxAssistantMessage("child completion"), usage: childUsage };
	tracker.record(prompt ? [prompt, assistant] : [assistant], assistant);
}

function unindexedUsage(owner: SessionChildUsage, parent: AssistantMessage): Usage | undefined {
	// Exact snapshots distinguish retained zero entries from missing entries and avoid subtraction's token clamp.
	return (
		owner as unknown as { _rlmUnindexedChildUsage: WeakMap<AssistantMessage, Usage> }
	)._rlmUnindexedChildUsage.get(parent);
}

function setup(appendParent = true) {
	const manager = SessionManager.inMemory();
	const parent: AssistantMessage = { ...fauxAssistantMessage("spawn children"), usage: usage(2, 1) };
	if (appendParent) manager.appendMessage(parent);
	const drains: Array<() => void> = [];
	const host = {
		sessionManager: manager,
		afterParentDrain: vi.fn((flush: () => void) => drains.push(flush)),
		invalidateOwnUsage: vi.fn(),
	} satisfies ChildUsageHost;
	const owner = new SessionChildUsage(host);
	const attributions = () => manager.getEntries().filter((entry) => entry.type === "child_usage_attributed");
	return { manager, parent, drains, host, owner, attributions };
}

describe("SessionChildUsage boundaries", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("shares durable aggregation across siblings while preserving pending live usage and context size", () => {
		const { manager, parent, owner, attributions } = setup();
		const first = owner.createTracker(parent);
		record(first, usage(7, 3));
		const second = owner.createTracker(parent);
		record(second, usage(11, 5));

		expect(parent.usage).toEqual({ ...usage(20, 9), totalTokens: 3 });
		expect(unindexedUsage(owner, parent)).toEqual(usage(18, 8));
		const own = cloneUsage(parent.usage);
		owner.subtractUnindexed(own, manager.getEntries());
		expect(own).toEqual({ ...usage(2, 1), totalTokens: 0 });

		first.flush();
		expect(attributions().map((entry) => entry.aggregateUsage)).toEqual([{ ...usage(9, 4), totalTokens: 3 }]);
		expect(unindexedUsage(owner, parent)).toEqual(usage(11, 5));
		expect(parent.usage).toEqual({ ...usage(20, 9), totalTokens: 3 });

		second.flush();
		expect(attributions().map((entry) => entry.aggregateUsage)).toEqual([
			{ ...usage(9, 4), totalTokens: 3 },
			{ ...usage(20, 9), totalTokens: 3 },
		]);
		expect(unindexedUsage(owner, parent)).toEqual(emptyUsage());
		expect(vi.getTimerCount()).toBe(0);
	});

	it("returns from settlement flush before a delayed parent append and drains it exactly once", () => {
		const { manager, parent, owner, host, drains, attributions } = setup(false);
		const tracker = owner.createTracker(parent);
		record(tracker, usage(7, 3));

		expect(tracker.flush()).toBeUndefined();
		tracker.flush();
		expect(host.afterParentDrain).toHaveBeenCalledOnce();
		expect(attributions()).toEqual([]);
		expect(unindexedUsage(owner, parent)).toEqual(usage(7, 3));
		expect(vi.getTimerCount()).toBe(0);

		manager.appendMessage(parent);
		drains[0]!();
		tracker.flush();
		expect(attributions()).toHaveLength(1);
		expect(attributions()[0]).toMatchObject({
			childUsage: usage(7, 3),
			aggregateUsage: { ...usage(9, 4), totalTokens: 3 },
		});
		expect(unindexedUsage(owner, parent)).toEqual(emptyUsage());
	});

	it("does not subtract indexed usage twice when append fails after indexing", () => {
		const { manager, parent, owner, host, attributions } = setup();
		const tracker = owner.createTracker(parent);
		const append = manager.appendChildUsageAttribution.bind(manager);
		vi.spyOn(manager, "appendChildUsageAttribution").mockImplementationOnce((...args) => {
			append(...args);
			throw new Error("persist failed after indexing");
		});
		record(tracker, usage(7, 3));
		const liveUsage = parent.usage;

		expect(() => tracker.flush()).not.toThrow();
		expect(attributions()).toHaveLength(1);
		expect(parent.usage).toBe(liveUsage);
		expect(parent.usage).toEqual({ ...usage(9, 4), totalTokens: 3 });
		expect(unindexedUsage(owner, parent)).toEqual(emptyUsage());
		const ownAfterIndexedSubtraction = usage(2, 1);
		owner.subtractUnindexed(ownAfterIndexedSubtraction, manager.getEntries());
		expect(ownAfterIndexedSubtraction).toEqual(usage(2, 1));
		expect(host.invalidateOwnUsage).toHaveBeenCalledTimes(2);
		tracker.flush();
		expect(attributions()).toHaveLength(1);
	});

	it("retains unindexed subtraction when append fails before indexing without breaking settlement", () => {
		const { manager, parent, owner, attributions } = setup();
		const tracker = owner.createTracker(parent);
		vi.spyOn(manager, "appendChildUsageAttribution").mockImplementationOnce(() => {
			throw new Error("append rejected");
		});
		record(tracker, usage(7, 3));
		expect(() => tracker.flush()).not.toThrow();
		expect(attributions()).toEqual([]);
		expect(unindexedUsage(owner, parent)).toEqual(usage(7, 3));
		const own = cloneUsage(parent.usage);
		owner.subtractUnindexed(own, manager.getEntries());
		expect(own.cost.total).toBe(3);
		expect(own.input).toBe(2);
		expect(own.output).toBe(1);
	});

	it("flushes the wall-clock backstop once even without another completion or checkpoint", async () => {
		const { parent, owner, attributions } = setup();
		const tracker = owner.createTracker(parent);
		record(tracker, usage(7, 3));
		await vi.advanceTimersByTimeAsync(59_999);
		expect(attributions()).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(attributions()).toHaveLength(1);
		expect(attributions()[0]?.childUsage).toEqual(usage(7, 3));
		tracker.flush();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(attributions()).toHaveLength(1);
	});

	it.each(["completion", "checkpoint"] as const)("flushes stale usage before a later %s", (boundary) => {
		const { parent, owner, attributions } = setup();
		const tracker = owner.createTracker(parent);
		record(tracker, usage(7, 3));
		vi.setSystemTime(61_000);
		if (boundary === "checkpoint") {
			tracker.flushIfStale();
			expect(attributions().map((entry) => entry.childUsage.cost.total)).toEqual([10]);
			expect(unindexedUsage(owner, parent)).toEqual(emptyUsage());
		}
		record(tracker, usage(11, 5));
		expect(attributions().map((entry) => entry.aggregateUsage.cost.total)).toEqual([13]);
		expect(unindexedUsage(owner, parent)).toEqual(usage(11, 5));
		tracker.flush();
		expect(attributions().map((entry) => entry.aggregateUsage.cost.total)).toEqual([13, 29]);
		expect(attributions().map((entry) => entry.childUsage.cost.total)).toEqual([10, 16]);
	});

	it("tracks future retained-child completions after initial settlement with their own prompt origins", async () => {
		const { parent, owner, attributions } = setup();
		const tracker = owner.createTracker(parent);
		const prompt = (id: string) =>
			createAgentSessionMessage({
				id,
				source: "agent_message",
				message: "child work",
				fromRelationship: "parent",
				target: { activeSessionId: "child-active", sessionId: "child" },
			});
		record(tracker, usage(7, 3), prompt("spawn:child"));
		tracker.flush();
		expect(vi.getTimerCount()).toBe(0);

		record(tracker, usage(11, 5), prompt("follow-up"));
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(60_000);
		record(tracker, usage(2, 2), { role: "user", content: "direct follow-up", timestamp: Date.now() });
		tracker.flush();

		expect(attributions().map((entry) => entry.origin)).toEqual(["spawn_task", "agent_message", "direct_user"]);
		expect(attributions().map((entry) => entry.aggregateUsage.cost.total)).toEqual([13, 29, 33]);
		expect(attributions().map((entry) => entry.childUsage.cost.total)).toEqual([10, 16, 4]);
		expect(parent.usage.totalTokens).toBe(3);
		expect(unindexedUsage(owner, parent)).toEqual(emptyUsage());
		expect(vi.getTimerCount()).toBe(0);
	});
});
