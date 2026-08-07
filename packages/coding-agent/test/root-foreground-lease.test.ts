import { describe, expect, it, vi } from "vitest";
import { RootForegroundLease } from "../src/core/root-foreground-lease.js";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("RootForegroundLease", () => {
	it("admits root mutations in FIFO order and permits nested work from the current actor", async () => {
		const lease = new RootForegroundLease();
		const firstGate = deferred();
		const order: string[] = [];
		const first = lease.run("root-cell", async () => {
			order.push("first:start");
			await lease.run("root-turn", async () => {
				order.push("first:nested");
			});
			await firstGate.promise;
			order.push("first:end");
		});
		const second = lease.run("root-turn", async () => {
			order.push("second");
		});
		const third = lease.run("compaction", async () => {
			order.push("third");
		});
		await tick();
		expect(order).toEqual(["first:start", "first:nested"]);
		firstGate.resolve();
		await Promise.all([first, second, third]);
		expect(order).toEqual(["first:start", "first:nested", "first:end", "second", "third"]);
	});

	it("releases the holder once when foreground work fails", async () => {
		const lease = new RootForegroundLease();
		const failed = lease.run("root-cell", async () => {
			throw new Error("boom");
		});
		const later = vi.fn(async () => {});
		const queued = lease.run("root-turn", later);
		await expect(failed).rejects.toThrow("boom");
		await queued;
		expect(later).toHaveBeenCalledTimes(1);
		expect(lease.busy).toBe(false);
	});

	it("reports one captured-actor release while later work begins", async () => {
		const lease = new RootForegroundLease();
		const firstGate = deferred();
		const secondGate = deferred();
		const first = lease.run("root-cell", () => firstGate.promise);
		await tick();
		let releases = 0;
		const released = lease.waitForCurrentActorRelease().then(() => {
			releases++;
		});
		const second = lease.run("root-turn", () => secondGate.promise);
		firstGate.resolve();
		await released;
		expect(releases).toBe(1);
		expect(lease.busy).toBe(true);
		secondGate.resolve();
		await Promise.all([first, second]);
		expect(releases).toBe(1);
	});

	it("projects the correlated Act actor without creating a second lease", async () => {
		const lease = new RootForegroundLease();
		await lease.run("root-cell", async () => {
			const token = lease.currentToken;
			expect(token).toBeDefined();
			const exit = lease.enterAct(token!);
			expect(lease.actActive).toBe(true);
			exit();
			exit();
			expect(lease.actActive).toBe(false);
		});
		expect(lease.busy).toBe(false);
	});

	it("rejects queued admission on abort or disposal without running work", async () => {
		const changes = vi.fn();
		const lease = new RootForegroundLease(changes);
		const gate = deferred();
		const active = lease.run("root-cell", () => gate.promise);
		const abort = new AbortController();
		const abortedWork = vi.fn(async () => {});
		const aborted = lease.run("root-turn", abortedWork, abort.signal);
		abort.abort();
		await expect(aborted).rejects.toThrow("admission aborted");
		const disposedWork = vi.fn(async () => {});
		const disposed = lease.run("compaction", disposedWork);
		lease.dispose(new Error("session gone"));
		await expect(disposed).rejects.toThrow("session gone");
		expect(abortedWork).not.toHaveBeenCalled();
		expect(disposedWork).not.toHaveBeenCalled();
		gate.resolve();
		await active;
		expect(lease.busy).toBe(false);
		expect(changes).toHaveBeenCalled();
	});
});
