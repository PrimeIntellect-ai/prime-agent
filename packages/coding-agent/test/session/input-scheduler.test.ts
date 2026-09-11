import { describe, expect, it, vi } from "vitest";
import { SessionInputScheduler } from "../../src/session/input/input-scheduler.js";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("SessionInputScheduler", () => {
	it("coalesces pending requests and serializes work scheduled during a run", async () => {
		const firstRun = deferred();
		const firstStarted = deferred();
		const secondRun = deferred();
		const secondStarted = deferred();
		const run = vi.fn(async () => {
			if (run.mock.calls.length === 1) {
				firstStarted.resolve();
				await firstRun.promise;
			} else {
				secondStarted.resolve();
				await secondRun.promise;
			}
		});
		const scheduler = new SessionInputScheduler({ canSchedule: () => true, run });
		scheduler.schedule();
		scheduler.schedule();
		await firstStarted.promise;
		expect(run).toHaveBeenCalledTimes(1);
		let idle = false;
		const waiting = scheduler.waitForIdle().then(() => {
			idle = true;
		});
		scheduler.schedule();
		scheduler.schedule();
		await Promise.resolve();
		expect(run).toHaveBeenCalledTimes(1);
		firstRun.resolve();
		await secondStarted.promise;
		expect(idle).toBe(false);
		secondRun.resolve();
		await waiting;
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("checks session eligibility before scheduling", async () => {
		let eligible = false;
		const run = vi.fn(async () => {});
		const scheduler = new SessionInputScheduler({ canSchedule: () => eligible, run });
		scheduler.schedule();
		await scheduler.waitForIdle();
		expect(run).not.toHaveBeenCalled();
		eligible = true;
		scheduler.schedule();
		await scheduler.waitForIdle();
		expect(run).toHaveBeenCalledOnce();
	});

	it("keeps queued work paused until every lease releases, including duplicate releases", async () => {
		const run = vi.fn(async () => {});
		const scheduler = new SessionInputScheduler({ canSchedule: () => true, run });
		const onRelease = vi.fn(() => scheduler.schedule());
		const first = scheduler.acquireQueuedWorkPause(onRelease);
		const second = scheduler.acquireQueuedWorkPause(onRelease);
		first.release();
		first.release();
		await scheduler.waitForIdle();
		expect(scheduler.queuedWorkPauseCount).toBe(1);
		expect(run).not.toHaveBeenCalled();
		second.release();
		second.release();
		await scheduler.waitForIdle();
		expect(scheduler.queuedWorkPauseCount).toBe(0);
		expect(onRelease).toHaveBeenCalledTimes(2);
		expect(run).toHaveBeenCalledOnce();
	});

	it("keeps overlapping admission pauses independent from already admitted work", async () => {
		const run = vi.fn(async () => {});
		const scheduler = new SessionInputScheduler({ canSchedule: () => true, run });
		const first = scheduler.acquireAdmissionPause(() => scheduler.schedule());
		const second = scheduler.acquireAdmissionPause(() => scheduler.schedule());
		first.release();
		first.release();
		expect(scheduler.admissionPaused).toBe(true);
		await scheduler.waitForIdle();
		expect(run).toHaveBeenCalledOnce();
		second.release();
		expect(scheduler.admissionPaused).toBe(false);
		await scheduler.waitForIdle();
	});

	it("invalidates preparation even when an admission pause ends before preparation resolves", async () => {
		const prepared = deferred();
		const started = deferred();
		const delivered = vi.fn();
		const scheduler = new SessionInputScheduler({
			canSchedule: () => true,
			run: async (epoch) => {
				started.resolve();
				await prepared.promise;
				if (epoch === scheduler.epoch) delivered();
			},
		});
		scheduler.schedule();
		await started.promise;
		const pause = scheduler.acquireAdmissionPause(() => {});
		pause.release();
		prepared.resolve();
		await scheduler.waitForIdle();
		expect(delivered).not.toHaveBeenCalled();
		scheduler.schedule();
		await scheduler.waitForIdle();
		expect(delivered).toHaveBeenCalledOnce();
	});

	it.each(["abort", "update-restart"] as const)(
		"keeps %s suspension until resumed and retains outstanding pause leases",
		async (reason) => {
			const run = vi.fn(async () => {});
			const scheduler = new SessionInputScheduler({ canSchedule: () => true, run });
			const pause = scheduler.acquireQueuedWorkPause(() => scheduler.schedule());
			const admission = scheduler.acquireAdmissionPause(() => scheduler.schedule());
			scheduler.suspend(reason);
			admission.release();
			await scheduler.waitForIdle();
			expect(scheduler.suspended).toBe(true);
			expect(scheduler.suspendedForUpdateRestart).toBe(reason === "update-restart");
			expect(run).not.toHaveBeenCalled();
			expect(scheduler.resume()).toBe(true);
			expect(scheduler.suspendedForUpdateRestart).toBe(false);
			expect(scheduler.resume()).toBe(false);
			scheduler.schedule();
			await scheduler.waitForIdle();
			expect(run).not.toHaveBeenCalled();
			pause.release();
			await scheduler.waitForIdle();
			expect(run).toHaveBeenCalledOnce();
		},
	);

	it("preserves the captured epoch so a pending runner can reject work invalidated by abort", async () => {
		const run = vi.fn(async () => {});
		const scheduler = new SessionInputScheduler({ canSchedule: () => true, run });
		const epoch = scheduler.epoch;
		scheduler.schedule();
		scheduler.suspend("abort");
		scheduler.schedule();
		await scheduler.waitForIdle();
		expect(run).toHaveBeenCalledExactlyOnceWith(epoch);
		expect(scheduler.epoch).not.toBe(epoch);
		expect(scheduler.suspended).toBe(true);
	});

	it("lets idle callers observe failure and schedules later work after a failed run", async () => {
		const run = vi.fn(async () => {}).mockRejectedValueOnce(new Error("preparation failed"));
		const scheduler = new SessionInputScheduler({ canSchedule: () => true, run });
		scheduler.schedule();
		await expect(scheduler.waitForIdle()).rejects.toThrow("preparation failed");
		scheduler.schedule();
		await expect(scheduler.waitForIdle()).resolves.toBeUndefined();
		expect(run).toHaveBeenCalledTimes(2);
	});
});
