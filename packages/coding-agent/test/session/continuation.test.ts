import { AgentContinueError, type AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SessionCommitFence } from "../../src/session/input/commit-fence.js";
import { SessionContinuation, type SessionContinuationHost } from "../../src/session/turns/continuation.js";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function turn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function setup() {
	const fence = new SessionCommitFence();
	const waiters = new Set<() => void>();
	const host = {
		waitForAgentIdle: vi.fn(async () => {}),
		waitForRetry: vi.fn(async () => {}),
		waitForRefinement: vi.fn(async () => {}),
		queuedWorkPauseCount: vi.fn(() => 0),
		addCheckpointWaiter: (waiter: () => void) => {
			waiters.add(waiter);
		},
		removeCheckpointWaiter: (waiter: () => void) => {
			waiters.delete(waiter);
		},
		notifyCheckpoints: vi.fn(() => {
			for (const waiter of waiters) waiter();
		}),
		compactionOperation: vi.fn<SessionContinuationHost["compactionOperation"]>(() => undefined),
		isRefinementApplying: vi.fn(() => false),
		acquireCommitFence: () => fence.acquire(),
		scheduleRefinement: vi.fn(),
		unfinishedActionCount: vi.fn(() => 0),
		isInputRequested: vi.fn(() => false),
		scheduleInput: vi.fn(),
		continue: vi.fn<SessionContinuationHost["continue"]>(async () => {}),
		waitForIdleOrSettlement: vi.fn<SessionContinuationHost["waitForIdleOrSettlement"]>(async () => {}),
		removeQueuedMessages: vi.fn<SessionContinuationHost["removeQueuedMessages"]>(() => []),
		followUp: vi.fn<SessionContinuationHost["followUp"]>(),
		onMessageConsumed: vi.fn<SessionContinuationHost["onMessageConsumed"]>(),
	} satisfies SessionContinuationHost;
	return { continuation: new SessionContinuation(host), host, fence, waiters };
}

describe("SessionContinuation boundaries", () => {
	it("settles cancelled paused work and removes its checkpoint waiter", async () => {
		const { continuation, host, waiters } = setup();
		host.queuedWorkPauseCount.mockReturnValue(1);
		continuation.schedule();
		const token = continuation.current!;
		await turn();
		expect(waiters.size).toBe(1);
		continuation.cancel();
		await token.promise;
		await turn();
		expect(waiters.size).toBe(0);
		expect(continuation.current).toBeUndefined();
		expect(host.continue).not.toHaveBeenCalled();
	});

	it("releases the commit fence before waiting for the continued turn", async () => {
		const { continuation, host, fence } = setup();
		const running = deferred();
		host.continue.mockReturnValue(running.promise);
		continuation.schedule();
		const token = continuation.current!;
		await turn();
		expect(host.continue).toHaveBeenCalledOnce();
		expect(fence.hasPendingWork).toBe(false);
		const lease = await fence.acquire();
		lease.release();
		expect(continuation.current).toBe(token);
		running.resolve();
		await token.promise;
		expect(continuation.current).toBeUndefined();
	});

	it("does not expose an old rejection or consume replacement messages after cancellation", async () => {
		const { continuation, host } = setup();
		const oldRun = deferred();
		const replacementRun = deferred();
		const message = fauxAssistantMessage("owned continuation");
		continuation.track(message);
		host.continue.mockReturnValueOnce(oldRun.promise).mockReturnValueOnce(replacementRun.promise);
		continuation.schedule();
		await turn();
		const oldToken = continuation.current!;
		continuation.cancel();
		continuation.schedule();
		const replacement = continuation.current!;
		await turn();
		oldRun.reject(new Error("old turn failed"));
		await oldToken.promise;
		await turn();
		expect(continuation.current).toBe(replacement);
		expect(continuation.messages).toEqual([message]);
		expect(host.onMessageConsumed).not.toHaveBeenCalled();
		replacementRun.resolve();
		await replacement.promise;
		expect(continuation.messages).toEqual([]);
		expect(host.onMessageConsumed).toHaveBeenCalledExactlyOnceWith(message);
	});

	it("rechecks a refinement that starts while waiting for the commit fence", async () => {
		const { continuation, host, fence } = setup();
		const held = await fence.acquire();
		const refinement = deferred();
		continuation.schedule();
		const token = continuation.current!;
		await turn();
		host.isRefinementApplying.mockReturnValue(true);
		host.waitForRefinement.mockReturnValue(refinement.promise);
		held.release();
		await turn();
		expect(host.continue).not.toHaveBeenCalled();
		expect(fence.hasPendingWork).toBe(false);
		host.isRefinementApplying.mockReturnValue(false);
		refinement.resolve();
		await token.promise;
		expect(host.continue).toHaveBeenCalledOnce();
	});

	it.each([false, true])("honors continue-after-input=%s after the input pump completes", async (shouldContinue) => {
		const { continuation, host } = setup();
		host.unfinishedActionCount.mockReturnValue(1);
		host.waitForIdleOrSettlement.mockImplementation(async () => {
			host.unfinishedActionCount.mockReturnValue(0);
		});
		continuation.schedule(shouldContinue);
		await continuation.current!.promise;
		expect(host.scheduleInput).toHaveBeenCalledOnce();
		expect(host.continue).toHaveBeenCalledTimes(shouldContinue ? 1 : 0);
		expect(continuation.isScheduled).toBe(false);
	});

	it("retains messages still in the agent queue after a busy continuation retries", async () => {
		const { continuation, host } = setup();
		const message = fauxAssistantMessage("queued continuation");
		const stillQueued: AgentMessage[] = [message];
		continuation.track(message);
		host.continue.mockRejectedValueOnce(new AgentContinueError("busy", "running"));
		host.removeQueuedMessages.mockImplementation((predicate) => stillQueued.filter(predicate));
		continuation.schedule();
		await continuation.current!.promise;
		expect(host.continue).toHaveBeenCalledTimes(2);
		expect(host.followUp).toHaveBeenCalledExactlyOnceWith(message);
		expect(host.onMessageConsumed).not.toHaveBeenCalled();
		expect(continuation.messages).toEqual([message]);
	});
});
