import { describe, expect, it } from "vitest";
import { SessionCommitFence } from "../../src/session/input/commit-fence.js";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("SessionCommitFence", () => {
	it("grants leases in arrival order and reports pending work between owners", async () => {
		const fence = new SessionCommitFence();
		const first = await fence.acquire();
		const order: string[] = [];
		const secondPromise = fence.acquire().then((lease) => {
			order.push("second");
			return lease;
		});
		const thirdPromise = fence.acquire().then((lease) => {
			order.push("third");
			return lease;
		});
		await yieldToEventLoop();
		expect(order).toEqual([]);
		first.release();
		expect(fence.hasPendingWork).toBe(true);
		const second = await secondPromise;
		expect(order).toEqual(["second"]);
		first.release();
		await yieldToEventLoop();
		expect(order).toEqual(["second"]);
		second.release();
		const third = await thirdPromise;
		expect(order).toEqual(["second", "third"]);
		third.release();
		expect(fence.hasPendingWork).toBe(false);
	});

	it("cancels a middle waiter without allowing later work to overtake its predecessor", async () => {
		const fence = new SessionCommitFence();
		const first = await fence.acquire();
		const controller = new AbortController();
		const cancelled = fence.acquire(controller.signal);
		const rejection = expect(cancelled).rejects.toThrow("Update restart preparation cancelled");
		let lastAcquired = false;
		const lastPromise = fence.acquire().then((lease) => {
			lastAcquired = true;
			return lease;
		});
		controller.abort();
		await rejection;
		await yieldToEventLoop();
		expect(lastAcquired).toBe(false);
		expect(fence.hasPendingWork).toBe(true);
		first.release();
		const last = await lastPromise;
		last.release();
		expect(fence.hasPendingWork).toBe(false);
	});

	it("rejects pre-aborted acquisition without blocking subsequent work", async () => {
		const fence = new SessionCommitFence();
		const controller = new AbortController();
		controller.abort();
		await expect(fence.acquire(controller.signal)).rejects.toThrow("Update restart preparation cancelled");
		expect(fence.hasPendingWork).toBe(false);
		const lease = await fence.acquire();
		lease.release();
		expect(fence.hasPendingWork).toBe(false);
	});

	it("re-enters through an asynchronous hook without releasing the outer lease", async () => {
		const fence = new SessionCommitFence();
		const outer = await fence.acquire();
		let unrelatedAcquired = false;
		const unrelated = fence.acquire().then((lease) => {
			unrelatedAcquired = true;
			return lease;
		});
		await fence.run(outer, async () => {
			await yieldToEventLoop();
			expect(fence.isHeldByCurrentContext).toBe(true);
			const nested = await fence.acquire();
			expect(nested.owner).toBe(outer.owner);
			nested.release();
			await yieldToEventLoop();
			expect(unrelatedAcquired).toBe(false);
			expect(fence.hasPendingWork).toBe(true);
		});
		expect(fence.isHeldByCurrentContext).toBe(false);
		outer.release();
		const next = await unrelated;
		next.release();
	});

	it("queues a stale asynchronous context behind the current owner", async () => {
		const fence = new SessionCommitFence();
		const first = await fence.acquire();
		const delayedHook = deferred();
		let staleAcquired = false;
		const stale = fence.run(first, async () => {
			await delayedHook.promise;
			expect(fence.isHeldByCurrentContext).toBe(false);
			const lease = await fence.acquire();
			staleAcquired = true;
			return lease;
		});
		first.release();
		const second = await fence.acquire();
		delayedHook.resolve();
		await yieldToEventLoop();
		expect(staleAcquired).toBe(false);
		second.release();
		const third = await stale;
		expect(third.owner).not.toBe(first.owner);
		expect(third.owner).not.toBe(second.owner);
		third.release();
	});

	it("retains ownership when the acquiring caller's signal is aborted after acquisition", async () => {
		const fence = new SessionCommitFence();
		const controller = new AbortController();
		const first = await fence.acquire(controller.signal);
		controller.abort();
		let nextAcquired = false;
		const next = fence.acquire().then((lease) => {
			nextAcquired = true;
			return lease;
		});
		await yieldToEventLoop();
		expect(nextAcquired).toBe(false);
		first.release();
		(await next).release();
	});

	it("rejects pending and future acquisitions on disposal without revoking a held lease", async () => {
		const fence = new SessionCommitFence();
		const first = await fence.acquire();
		const second = expect(fence.acquire()).rejects.toThrow("session is disposing or disposed");
		const third = expect(fence.acquire()).rejects.toThrow("session is disposing or disposed");
		fence.dispose();
		fence.dispose();
		await Promise.all([second, third]);
		expect(fence.disposeSignal.aborted).toBe(true);
		expect(fence.hasPendingWork).toBe(true);
		await expect(fence.acquire()).rejects.toThrow("session is disposing or disposed");
		first.release();
		expect(fence.hasPendingWork).toBe(false);
	});

	it("preserves reentrant acquisition for an existing owner even when its wait signal is aborted", async () => {
		const fence = new SessionCommitFence();
		const outer = await fence.acquire();
		const controller = new AbortController();
		controller.abort();
		await fence.run(outer, async () => {
			const nested = await fence.acquire(controller.signal);
			expect(nested.owner).toBe(outer.owner);
			nested.release();
		});
		outer.release();
	});

	it("restores the caller's context after a hook throws and allows explicit cleanup", async () => {
		const fence = new SessionCommitFence();
		const lease = await fence.acquire();
		expect(() =>
			fence.run(lease, () => {
				throw new Error("hook failed");
			}),
		).toThrow("hook failed");
		expect(fence.isHeldByCurrentContext).toBe(false);
		expect(fence.hasPendingWork).toBe(true);
		lease.release();
		(await fence.acquire()).release();
		expect(fence.hasPendingWork).toBe(false);
	});
});
