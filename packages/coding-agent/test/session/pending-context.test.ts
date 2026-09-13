import { describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../../src/core/messages.js";
import { ActionStore } from "../../src/core/session-action-store.js";
import { SessionPendingContext } from "../../src/session/context/pending-context.js";
import { SessionCommitFence } from "../../src/session/input/commit-fence.js";
import { SessionInputScheduler } from "../../src/session/input/input-scheduler.js";
import type { QueuedSessionAction } from "../../src/session/prepared-actions.js";

function createOwner() {
	const actions = new ActionStore<QueuedSessionAction>();
	const scheduler = new SessionInputScheduler({ canSchedule: () => false, run: async () => {} });
	const fence = new SessionCommitFence();
	const schedule = vi.fn();
	const owner = new SessionPendingContext(actions, {
		getScheduler: () => scheduler,
		getFence: () => fence,
		isDisposed: () => false,
		isDisposing: () => false,
		admit: (action) => {
			actions.enqueue(action);
			return { accepted: true };
		},
		scheduleInput: schedule,
		addCheckpointWaiter: () => {},
		removeCheckpointWaiter: () => {},
		acquireFence: (signal) => fence.acquire(signal),
		cancelActions: (predicate) => actions.remove(predicate),
	});
	return { owner, schedule };
}

function message(content: string): CustomMessage {
	return { role: "custom", customType: "context", content, display: false, timestamp: 1, details: { content } };
}

describe("pending context ownership", () => {
	it("keeps rollback message identities and order without cloning or waking input", () => {
		const { owner, schedule } = createOwner();
		const first = message("first");
		const last = message("last");
		owner.appendMessages(last);
		owner.prependMessages([first]);
		const taken = owner.takePendingNextTurnMessages();
		expect(taken).toEqual([first, last]);
		expect(taken[0]).toBe(first);
		expect(taken[1]).toBe(last);
		owner.appendMessages(message("next"));
		expect(taken).toEqual([first, last]);
		expect(owner.takePendingNextTurnMessages()).toHaveLength(1);
		expect(schedule).not.toHaveBeenCalled();
	});

	it("removes matching context without cloning survivors, while recovery clones and wakes", () => {
		const { owner, schedule } = createOwner();
		const keep = message("keep");
		owner.appendMessages(message("drop"), keep);
		owner.removeMessagesMatching((item) => item.content === "drop");
		expect(owner.takePendingNextTurnMessages()[0]).toBe(keep);
		expect(schedule).not.toHaveBeenCalled();
		owner.restorePendingNextTurnMessages([keep]);
		const restored = owner.takePendingNextTurnMessages()[0];
		expect(restored).toEqual(keep);
		expect(restored).not.toBe(keep);
		expect(restored.details).toBe(keep.details);
		expect(schedule).toHaveBeenCalledOnce();
	});

	it("tracks terminal-notice retention independently from pending-message disposal", () => {
		const { owner } = createOwner();
		owner.retainTerminalNotice("notice");
		owner.appendMessages(message("pending"));
		owner.dispose();
		expect(owner.takePendingNextTurnMessages()).toEqual([]);
		expect(owner.isRetainedTerminalNotice("notice")).toBe(true);
		owner.releaseTerminalNotice("notice");
		expect(owner.isRetainedTerminalNotice("notice")).toBe(false);
	});
});
