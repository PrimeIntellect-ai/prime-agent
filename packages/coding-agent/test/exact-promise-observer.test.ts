import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import {
	captureExactPromiseContext,
	isExactPromiseForContext,
	observeExactPromise,
	observeExactPromiseCall,
} from "../src/core/exact-promise-observer.js";

function fulfilled(value: unknown): Promise<unknown> {
	return (async (): Promise<unknown> => value)();
}

function rejected(): Promise<unknown> {
	return (async (): Promise<unknown> => {
		throw new Error("rejected");
	})();
}

describe("exact Promise observer", () => {
	it("creates fresh frozen ordinary opaque context markers", () => {
		const first = captureExactPromiseContext();
		const second = captureExactPromiseContext();
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(first).not.toBe(second);
		if (first === null) return;
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
		expect(Reflect.ownKeys(first)).toEqual([]);
	});

	it("accepts a genuine Promise with its exact same-context marker", () => {
		const marker = captureExactPromiseContext();
		const raw = fulfilled(7);
		expect(isExactPromiseForContext(raw, marker)).toBe(true);
	});

	it("observes fulfillment and returns a fresh frozen result", async () => {
		const marker = captureExactPromiseContext();
		const result = await observeExactPromise(fulfilled(7), marker);
		expect(result).toEqual({ fulfilled: true, value: 7 });
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("observes rejection without leaking the rejection", async () => {
		const marker = captureExactPromiseContext();
		const result = await observeExactPromise(rejected(), marker);
		expect(result).toEqual({ fulfilled: false });
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("captures, invokes, and observes within one ALS context", async () => {
		const storage = new AsyncLocalStorage<object>();
		const observation = storage.run({}, () => observeExactPromiseCall(() => fulfilled("ok")));
		expect(await observation).toEqual({ fulfilled: true, value: "ok" });
	});

	it("rejects a Promise created in a different ALS context", () => {
		const first = new AsyncLocalStorage<object>();
		const second = new AsyncLocalStorage<object>();
		const marker = first.run({}, () => captureExactPromiseContext());
		const raw = second.run({}, () => fulfilled(1));
		const hasEngineSymbols = Object.getOwnPropertySymbols(raw).length > 0;
		expect(isExactPromiseForContext(raw, marker)).toBe(!hasEngineSymbols);
		void observeExactPromise(raw, marker);
	});

	it("rejects custom own symbols even with engine-like flags", () => {
		const marker = captureExactPromiseContext();
		const raw = fulfilled(1);
		Object.defineProperty(raw, Symbol("custom"), {
			value: 1,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		expect(isExactPromiseForContext(raw, marker)).toBe(false);
		void observeExactPromise(raw, marker);
	});

	it("rejects modified engine descriptor flags", () => {
		const marker = captureExactPromiseContext();
		const raw = fulfilled(1);
		const symbols = Object.getOwnPropertySymbols(raw);
		if (symbols.length === 0) return;
		const descriptor = Object.getOwnPropertyDescriptor(raw, symbols[0]);
		if (descriptor === undefined || !("value" in descriptor)) return;
		Object.defineProperty(raw, symbols[0], { ...descriptor, enumerable: !descriptor.enumerable });
		expect(isExactPromiseForContext(raw, marker)).toBe(false);
		void observeExactPromise(raw, marker);
	});

	it("rejects own string properties", () => {
		const marker = captureExactPromiseContext();
		const raw = fulfilled(1);
		Object.defineProperty(raw, "hidden", { value: 1 });
		expect(isExactPromiseForContext(raw, marker)).toBe(false);
		void observeExactPromise(raw, marker);
	});

	it("rejects Promise subclasses", () => {
		class DerivedPromise<T> extends Promise<T> {}
		const marker = captureExactPromiseContext();
		const raw = new DerivedPromise<number>((resolve) => resolve(1));
		expect(isExactPromiseForContext(raw, marker)).toBe(false);
		void observeExactPromise(raw, marker);
	});

	it("rejects Proxy wrappers", async () => {
		const marker = captureExactPromiseContext();
		const raw = fulfilled(1);
		const wrapped = new Proxy(raw, {});
		expect(isExactPromiseForContext(wrapped, marker)).toBe(false);
		expect(await observeExactPromise(wrapped, marker)).toEqual({ fulfilled: false });
	});

	it("rejects caller-forged marker objects", () => {
		const raw = fulfilled(1);
		const hasEngineSymbols = Object.getOwnPropertySymbols(raw).length > 0;
		expect(isExactPromiseForContext(raw, Object.freeze({}))).toBe(!hasEngineSymbols);
	});
});
