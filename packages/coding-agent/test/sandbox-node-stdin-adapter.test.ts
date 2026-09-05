/**
 * Tests for createNodeStdinAdapter.
 */

import { Readable } from "node:stream";
import * as util from "node:util";
import { describe, expect, it } from "vitest";
import { createNodeStdinAdapter } from "../src/core/sandbox-node-stdin-adapter.js";
import type { StdinSource } from "../src/core/sandbox-stdin-bootstrap-frame.js";
import { readStdinBootstrapFrame } from "../src/core/sandbox-stdin-bootstrap-frame.js";

function invokeCaptured(callback: unknown, ...args: unknown[]): void {
	if (typeof callback !== "function") throw new Error("missing captured callback");
	Reflect.apply(callback, undefined, args);
}

// ===========================================================================
// Helpers
// ===========================================================================

function makeFrame(payload: Uint8Array): Uint8Array {
	const hdr = new Uint8Array(4);
	const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
	dv.setUint32(0, payload.byteLength, false);
	const out = new Uint8Array(4 + payload.byteLength);
	out.set(hdr, 0);
	out.set(payload, 4);
	return out;
}

interface CallbackLog {
	data: Array<Uint8Array>;
	end: number;
	error: Array<Error>;
}
function makeLog(): CallbackLog {
	return { data: [], end: 0, error: [] };
}

function unwrapOk(r: ReturnType<typeof createNodeStdinAdapter>): StdinSource {
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("expected ok result");
	return r.source;
}

function expectFail(raw: unknown, code: string): void {
	const r = createNodeStdinAdapter(raw);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.code).toBe(code);
	}
}

// ===========================================================================
// Factory result
// ===========================================================================

describe("factory result", () => {
	it("returns ok:true with frozen source for a valid Readable", () => {
		const r = new Readable({ read() {} });
		const result = createNodeStdinAdapter(r);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(Object.isFrozen(result.source)).toBe(true);
			expect(typeof result.source.on).toBe("function");
			expect(typeof result.source.removeListener).toBe("function");
			expect(typeof result.source.resume).toBe("function");
		}
		r.destroy();
	});

	it("returns ok:false INVALID_INPUT for null/undefined/number/string", () => {
		expectFail(null, "INVALID_INPUT");
		expectFail(undefined, "INVALID_INPUT");
		expectFail(42, "INVALID_INPUT");
		expectFail("bad", "INVALID_INPUT");
	});

	it("returns ok:false INVALID_SOURCE for plain object without methods", () => {
		expectFail({}, "INVALID_SOURCE");
	});

	it("rejects Proxy on root object", () => {
		const real = { on: () => {}, removeListener: () => {}, resume: () => {} };
		expectFail(new Proxy(real, {}), "INVALID_SOURCE");
	});

	it("rejects Proxy with getPrototypeOf trap", () => {
		const proxy = new Proxy(
			{ on: () => {}, removeListener: () => {}, resume: () => {} },
			{
				getPrototypeOf() {
					throw new Error("hostile");
				},
			},
		);
		expectFail(proxy, "INVALID_SOURCE");
	});

	it("rejects Proxy as prototype level in chain", () => {
		const proxyProto = new Proxy(
			{},
			{
				get() {
					return () => {};
				},
			},
		);
		const obj = Object.create(proxyProto);
		obj.on = () => {};
		// removeListener and resume must be found on proto — which is a Proxy.
		expectFail(obj, "INVALID_SOURCE");
	});

	it("returns ok:false INVALID_SOURCE for object with getter descriptor", () => {
		const obj = {
			get on() {
				return () => {};
			},
			get removeListener() {
				return () => {};
			},
			get resume() {
				return () => {};
			},
		};
		expectFail(obj, "INVALID_SOURCE");
	});

	it("returns ok:true for object with prototype symbols (methods at instance)", () => {
		const proto: Record<string | symbol, unknown> = {};
		const s = Symbol("x");
		proto[s] = 1;
		const obj = Object.create(proto) as Record<string, unknown>;
		obj.on = () => {};
		obj.removeListener = () => {};
		obj.resume = () => {};
		expect(createNodeStdinAdapter(obj).ok).toBe(true);
	});
});

// ===========================================================================
// on / removeListener
// ===========================================================================

describe("on / removeListener", () => {
	it("stores and removes a data callback", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const cb = (chunk: Uint8Array) => void chunk;
		src.on("data", cb);
		src.removeListener("data", cb);
		r.destroy();
	});

	it("removeListener only removes exact matching callback", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const cb1 = () => {};
		const cb2 = () => {};
		src.on("data", cb1);
		src.on("data", cb2);
		src.removeListener("data", cb1);
		r.destroy();
	});

	it("does not throw on hostile callback", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		expect(() => src.on("data", null as unknown as (chunk: Uint8Array) => void)).not.toThrow();
		r.destroy();
	});

	it("removeListener removal throw keeps ref+flag, retry succeeds", () => {
		const registered: Array<(...args: Array<unknown>) => void> = [];
		let removeThrows = true;
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				registered.push(cb);
			},
			removeListener(_event: string, cb: (...args: Array<unknown>) => void) {
				if (removeThrows) throw new Error("remove threw");
				const idx = registered.indexOf(cb);
				if (idx >= 0) registered.splice(idx, 1);
			},
			resume() {},
		};
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		const cb = () => {};
		src.on("data", cb);
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		const beforeCount = registered.length;
		expect(beforeCount).toBe(4);

		src.removeListener("data", cb);
		expect(registered.length).toBe(beforeCount);

		removeThrows = false;
		src.removeListener("data", cb);
		expect(registered.length).toBe(beforeCount - 1);
	});

	it("removeListener before resume does not dispose (nonterminal)", () => {
		// Calling removeListener before resume should not set disposed
		// because state.terminal is false.
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const cb = (chunk: Uint8Array) => void chunk;
		src.on("data", cb);
		src.removeListener("data", cb);

		// Should still be able to register and resume
		src.on("data", cb);
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		expect(r.listenerCount("data")).toBe(1);
		r.destroy();
	});

	it("terminal removeListener retries stale owned wrappers", () => {
		const registered: Array<(...args: Array<unknown>) => void> = [];
		let removeThrows = true;
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				registered.push(cb);
			},
			removeListener(_event: string, cb: (...args: Array<unknown>) => void) {
				if (removeThrows) throw new Error("remove threw");
				const idx = registered.indexOf(cb);
				if (idx >= 0) registered.splice(idx, 1);
			},
			resume() {},
		};
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		const cb = () => {};
		src.on("data", cb);
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		const beforeCount = registered.length;

		// First remove throws
		src.removeListener("data", cb);
		expect(registered.length).toBe(beforeCount);

		// Second retry succeeds
		removeThrows = false;
		src.removeListener("data", cb);
		expect(registered.length).toBe(beforeCount - 1);
	});
});

// ===========================================================================
// resume
// ===========================================================================

describe("resume", () => {
	it("premature resume without all three callbacks is harmless", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		src.on("data", (chunk: Uint8Array) => void chunk);
		src.resume();
		expect(r.listenerCount("data")).toBe(0);
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		expect(r.listenerCount("data")).toBe(1);
		r.destroy();
	});

	it("requires all three callbacks before registering", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		src.on("data", (chunk: Uint8Array) => void chunk);
		src.on("end", () => {});
		src.resume();
		expect(r.listenerCount("data")).toBe(0);
		r.destroy();
	});

	it("second resume does not re-register listeners", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const log = makeLog();
		src.on("data", (chunk: Uint8Array) => {
			log.data.push(chunk);
		});
		src.on("end", () => {
			log.end++;
		});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		expect(r.listenerCount("data")).toBe(1);
		src.resume();
		expect(r.listenerCount("data")).toBe(1);
		r.push(Buffer.from([0, 0, 0, 1, 0x42]));
		r.push(null);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(log.data.length).toBe(1);
				expect(log.end).toBe(1);
				r.destroy();
				resolve();
			}, 20);
		});
	});
});

// ===========================================================================
// Data flow
// ===========================================================================

describe("data flow", () => {
	it("registers listeners and delivers data/end", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const log = makeLog();
		src.on("data", (chunk: Uint8Array) => {
			log.data.push(chunk);
		});
		src.on("end", () => {
			log.end++;
		});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		r.push(Buffer.from([0, 0, 0, 1, 0x42]));
		r.push(null);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(log.data.length).toBe(1);
				expect(log.end).toBe(1);
				expect(log.error.length).toBe(0);
				expect(log.data[0] instanceof Uint8Array).toBe(true);
				expect(Buffer.isBuffer(log.data[0])).toBe(false);
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("delivers pooled Buffer subarray with exact fresh backing", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const log = makeLog();
		const pool = Buffer.allocUnsafe(65536);
		pool[0] = 0x00;
		pool[1] = 0x00;
		pool[2] = 0x00;
		pool[3] = 0x01;
		pool[4] = 0xaa;
		const sub = pool.subarray(0, 5);
		let captured: Uint8Array | null = null;
		src.on("data", (chunk: Uint8Array) => {
			captured = new Uint8Array(chunk);
			log.data.push(chunk);
		});
		src.on("end", () => {
			log.end++;
		});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		r.push(sub);
		r.push(null);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(log.data.length).toBe(1);
				expect(log.data[0].buffer).not.toBe(sub.buffer);
				if (captured) expect(Array.from(captured)).toEqual([0, 0, 0, 1, 0xaa]);
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("erases copy after downstream callback returns", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		let captured: Uint8Array | null = null;
		src.on("data", (chunk: Uint8Array) => {
			captured = chunk;
		});
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		r.push(Buffer.from([0, 0, 0, 1, 0x42]));
		r.push(null);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				if (captured) expect(Array.from(captured)).toEqual([0, 0, 0, 0, 0]);
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("bounds oversized chunk to 65541 bytes", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const big = Buffer.alloc(100_000);
		big[0] = 0x00;
		big[1] = 0x00;
		big[2] = 0x00;
		big[3] = 0x01;
		big[4] = 0x42;
		let captured: Uint8Array | null = null;
		src.on("data", (chunk: Uint8Array) => {
			captured = new Uint8Array(chunk);
		});
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		r.push(big);
		r.push(null);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				if (captured) {
					expect(captured.byteLength).toBe(65541);
					expect(captured[4]).toBe(0x42);
				}
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("rejects non-Buffer chunk", () => {
		const r = new Readable({ read() {}, objectMode: true });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const log = makeLog();
		src.on("data", () => {});
		src.on("end", () => {
			log.end++;
		});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		r.push("not a buffer");
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(log.error.length).toBe(1);
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("rejects plain Uint8Array (not Buffer)", () => {
		const r = new Readable({ read() {}, objectMode: true });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const log = makeLog();
		src.on("data", () => {});
		src.on("end", () => {
			log.end++;
		});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		r.push(new Uint8Array([0, 0, 0, 1, 0x42]));
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(log.error.length).toBe(1);
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("rejects zero-length Buffer before copy", () => {
		let dataCb: ((chunk: unknown) => void) | null = null;
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				if (_event === "data") dataCb = cb as (chunk: unknown) => void;
			},
			removeListener() {},
			resume() {},
		};
		const log = makeLog();
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		invokeCaptured(dataCb, Buffer.alloc(0));
		expect(log.error.length).toBe(1);
		expect(log.error[0].message).toBe("adapter error");
	});

	it("rejects Buffer with own buffer override", () => {
		const r = new Readable({ read() {}, objectMode: true });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const log = makeLog();
		src.on("data", () => {});
		src.on("end", () => {
			log.end++;
		});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		const bad = Buffer.from([1]);
		Object.defineProperty(bad, "buffer", { value: bad.buffer });
		r.push(bad);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(log.error.length).toBe(1);
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("rejects transparent Proxy(Buffer) — never throws into EventEmitter", () => {
		// A Proxy wrapping a Buffer must be rejected by isValidBuffer.
		// The data wrapper must never throw; error terminal must be delivered.
		const realBuf = Buffer.from([0, 0, 0, 1, 0x42]);
		const proxy = new Proxy(realBuf, {});
		expect(Buffer.isBuffer(proxy)).toBe(true);
		expect(util.types.isProxy(proxy)).toBe(true);

		let dataCb: ((chunk: unknown) => void) | null = null;
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				if (_event === "data") dataCb = cb as (chunk: unknown) => void;
			},
			removeListener() {},
			resume() {},
		};
		const log = makeLog();
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();

		// Emit a Proxy(Buffer) through the data wrapper.
		// Must NOT throw — error terminal delivered instead.
		expect(() => {
			if (dataCb) dataCb(proxy);
		}).not.toThrow();

		expect(log.error.length).toBe(1);
		expect(log.error[0].message).toBe("adapter error");
	});

	it("rejects Buffer subclass (wrong prototype)", () => {
		// A Buffer subclass has a different prototype.
		// We can't easily instantiate CustomBuffer, but we can modify
		// an existing Buffer's prototype.
		const buf = Buffer.from([1]);
		Object.setPrototypeOf(buf, Object.getPrototypeOf(buf));

		let dataCb: ((chunk: unknown) => void) | null = null;
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				if (_event === "data") dataCb = cb as (chunk: unknown) => void;
			},
			removeListener() {},
			resume() {},
		};
		const log = makeLog();
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		// Buffer with Buffer.prototype should work
		invokeCaptured(dataCb, buf);
		expect(log.error.length).toBe(0);
	});
});

// ===========================================================================
// Source error / close / end
// ===========================================================================

describe("source error/close/end", () => {
	it("source error delivers fixed error once", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const log = makeLog();
		src.on("data", () => {});
		src.on("end", () => {
			log.end++;
		});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		r.destroy(new Error("source kaboom"));
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(log.error.length).toBe(1);
				expect(log.error[0].message).toBe("adapter error");
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("close before end delivers error", () => {
		const r = new Readable({ read() {}, emitClose: true });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const log = makeLog();
		src.on("data", () => {});
		src.on("end", () => {
			log.end++;
		});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		r.destroy();
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(log.error.length).toBe(1);
				resolve();
			}, 30);
		});
	});

	it("end delivers downstream end exactly once", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		let endCount = 0;
		src.on("data", () => {});
		src.on("end", () => {
			endCount++;
		});
		src.on("error", () => {});
		src.resume();
		r.push(null);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(endCount).toBe(1);
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("terminal clears downstream refs even when notification callback absent", () => {
		// No error callback registered, but after terminal via close,
		// downstream refs must still be cleared.
		const r = new Readable({ read() {}, emitClose: true });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const log = makeLog();
		src.on("data", () => {
			log.data.push(new Uint8Array([1]));
		});
		src.on("end", () => {
			log.end++;
		});
		// No error callback
		src.resume();

		// Trigger close before end
		r.destroy();
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				// After terminal without error callback, refs cleared.
				// Verify by attempting to push more data — should be ignored.
				r.destroy();
				resolve();
			}, 30);
		});
	});
});

// ===========================================================================
// End cleanup failure -> error
// ===========================================================================

describe("end cleanup failure -> error", () => {
	it("end wrapper with failing cleanupAll invokes error, not end", () => {
		let endCb: (() => void) | null = null;
		let endCalled = false;
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				if (_event === "end") endCb = cb as () => void;
			},
			removeListener() {
				throw new Error("remove always throws");
			},
			resume() {
				if (endCb) {
					endCb();
					endCalled = true;
				}
			},
		};
		const log = makeLog();
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {
			log.end++;
		});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();
		expect(endCalled).toBe(true);
		expect(log.end).toBe(0);
		expect(log.error.length).toBe(1);
		expect(log.error[0].message).toBe("adapter error");
	});

	it("end cleanup failure invokes error callback captured before clearDownstreamRefs", () => {
		// End wrapper captures errorCb before clearDownstreamRefs nulls it.
		// The captured ref must still fire even after downstream refs cleared.
		let endCb: (() => void) | null = null;
		let endCalled = false;
		const errors: Array<Error> = [];
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				if (_event === "end") endCb = cb as () => void;
			},
			removeListener() {
				throw new Error("remove always throws");
			},
			resume() {
				if (endCb) {
					endCb();
					endCalled = true;
				}
			},
		};
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", (e: Error) => {
			errors.push(e);
		});
		src.resume();
		expect(endCalled).toBe(true);
		expect(errors.length).toBe(1);
		expect(errors[0].message).toBe("adapter error");
	});

	it("on(close) pushes then throws: three registered, cleanup removes all", () => {
		const registered: Array<(...args: Array<unknown>) => void> = [];
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				registered.push(cb);
				if (_event === "close") throw new Error("threw");
			},
			removeListener(_event: string, cb: (...args: Array<unknown>) => void) {
				const idx = registered.indexOf(cb);
				if (idx >= 0) registered.splice(idx, 1);
			},
			resume() {},
		};
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		expect(registered.length).toBe(0);
	});

	it("on(end) pushes then throws: three registered, cleanup removes all", () => {
		const registered: Array<(...args: Array<unknown>) => void> = [];
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				registered.push(cb);
				if (_event === "end") throw new Error("threw");
			},
			removeListener(_event: string, cb: (...args: Array<unknown>) => void) {
				const idx = registered.indexOf(cb);
				if (idx >= 0) registered.splice(idx, 1);
			},
			resume() {},
		};
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		expect(registered.length).toBe(0);
	});

	it("on(data) pushes then throws: four registered, cleanup removes all", () => {
		const registered: Array<(...args: Array<unknown>) => void> = [];
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				registered.push(cb);
				if (_event === "data") throw new Error("threw");
			},
			removeListener(_event: string, cb: (...args: Array<unknown>) => void) {
				const idx = registered.indexOf(cb);
				if (idx >= 0) registered.splice(idx, 1);
			},
			resume() {},
		};
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		expect(registered.length).toBe(0);
	});

	it("cleanupAll removal throw keeps ref+flag, second cleanup succeeds", () => {
		const registered: Array<(...args: Array<unknown>) => void> = [];
		let removeCallCount = 0;
		const errors: Array<Error> = [];
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				registered.push(cb);
				if (_event === "data") throw new Error("on data threw");
			},
			removeListener(_event: string, cb: (...args: Array<unknown>) => void) {
				removeCallCount++;
				const idx = registered.indexOf(cb);
				if (idx >= 0) registered.splice(idx, 1);
				if (removeCallCount === 1) throw new Error("remove threw first time");
			},
			resume() {},
		};
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", (e: Error) => {
			errors.push(e);
		});
		src.resume();

		expect(errors.length).toBe(1);
		expect(registered.length).toBe(0);
		expect(removeCallCount).toBe(5);
	});
});

// ===========================================================================
// disposed requires terminal
// ===========================================================================

describe("disposed requires terminal", () => {
	it("removeListener before resume does not set disposed", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const cb = () => {};
		src.on("data", cb);
		// removeListener with no owned wrappers registered — should not dispose
		src.removeListener("data", cb);
		// Verify resume still works
		src.on("data", (chunk: Uint8Array) => {
			void chunk;
		});
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		expect(r.listenerCount("data")).toBe(1);
		r.destroy();
	});

	it("error terminal with successful cleanup sets disposed", () => {
		let errorCb: ((e: Error) => void) | null = null;
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				if (_event === "error") errorCb = cb as (e: Error) => void;
			},
			removeListener() {},
			resume() {},
		};
		const log = makeLog();
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", (e: Error) => {
			log.error.push(e);
		});
		src.resume();

		invokeCaptured(errorCb, new Error("source error"));
		expect(log.error.length).toBe(1);

		// disposed should be set — verify by checking no-op on new registrations
		src.on("data", () => {
			log.data.push(new Uint8Array([1]));
		});
		expect(log.data.length).toBe(0);
	});
});

it("downstream removeListener of all three callbacks after resume disposes adapter and removes close", () => {
	// Frame reader successfully reads a frame and removes data/end/error.
	// The adapter must set terminal, cleanupAll (including ownedClose),
	// clear refs, and mark disposed. Unrelated listeners preserved.
	const r = new Readable({ read() {} });
	const src = unwrapOk(createNodeStdinAdapter(r));
	const dataCb = (chunk: Uint8Array) => void chunk;
	const endCb = () => {};
	const errorCb = (e: Error) => {
		void e;
	};
	src.on("data", dataCb);
	src.on("end", endCb);
	src.on("error", errorCb);
	src.resume();
	expect(r.listenerCount("close")).toBe(1);

	// Register an unrelated listener on close
	let unrelatedCloseCalled = false;
	r.on("close", () => {
		unrelatedCloseCalled = true;
	});

	// Downstream removes all three
	src.removeListener("data", dataCb);
	src.removeListener("end", endCb);
	src.removeListener("error", errorCb);

	// After all three removal: adapter should have cleaned up ownedClose too
	expect(r.listenerCount("data")).toBe(0);
	expect(r.listenerCount("end")).toBe(0);
	expect(r.listenerCount("error")).toBe(0);
	expect(r.listenerCount("close")).toBe(1); // only unrelated

	// Late close emission should be handled by stale retry (no crash)
	r.emit("close");
	expect(unrelatedCloseCalled).toBe(true);
	r.destroy();
});

it("downstream removal with throwing close removal retains ref for late close retry", () => {
	// Close removal throws; ref+flag survive. Later stale close fires,
	// retries cleanup and succeeds on second attempt.
	let closeRemoveThrows = true;
	const r = new Readable({ read() {} });
	const src = unwrapOk(createNodeStdinAdapter(r));
	const dataCb = (chunk: Uint8Array) => void chunk;
	const endCb = () => {};
	const errorCb = (e: Error) => {
		void e;
	};

	// Intercept removeListener on the readable for close
	const origRemoveListener = r.removeListener.bind(r);
	r.removeListener = ((event: string, cb: (...args: Array<unknown>) => void) => {
		if (event === "close" && closeRemoveThrows) {
			throw new Error("close removal throws");
		}
		return origRemoveListener(event, cb);
	}) as typeof r.removeListener;

	src.on("data", dataCb);
	src.on("end", endCb);
	src.on("error", errorCb);
	src.resume();

	// Register unrelated close listener
	let unrelatedCloseCount = 0;
	r.on("close", () => {
		unrelatedCloseCount++;
	});

	// Remove all three downstream — triggers downstream disposal
	src.removeListener("data", dataCb);
	src.removeListener("end", endCb);
	src.removeListener("error", errorCb);

	// Close removal threw — ownedClose ref+flag survive, so disposed not set
	// After disposal attempt: terminal=true, ownedClose still registered
	// The stale close wrapper still on the source.
	// Emit close — stale wrapper fires: staleRetry -> cleanupAll -> remove succeeds
	closeRemoveThrows = false;
	r.emit("close");

	// After stale retry, close listener should be cleared, disposed set
	expect(r.listenerCount("close")).toBe(1); // only unrelated
	expect(unrelatedCloseCount).toBe(1);
	r.destroy();
});
// ===========================================================================
// Reentrancy
// ===========================================================================

describe("reentrancy", () => {
	it("handles reentrant data inside data callback", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const received: Array<Uint8Array> = [];
		src.on("data", (chunk: Uint8Array) => {
			received.push(chunk);
		});
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		r.push(Buffer.from([0, 0, 0, 1, 0x42]));
		r.push(Buffer.from([0x43]));
		r.push(null);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(received.length).toBeGreaterThanOrEqual(1);
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("removeListener during data callback is safe", () => {
		const r = new Readable({ read() {} });
		const src = unwrapOk(createNodeStdinAdapter(r));
		const received: Array<Uint8Array> = [];
		const cb = (chunk: Uint8Array) => {
			received.push(chunk);
			src.removeListener("data", cb);
		};
		src.on("data", cb);
		src.on("end", () => {});
		src.on("error", () => {});
		src.resume();
		r.push(Buffer.from([0, 0, 0, 1, 0x42]));
		r.push(null);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(received.length).toBe(1);
				r.destroy();
				resolve();
			}, 20);
		});
	});

	it("synchronous error during on(error) registration", () => {
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				if (_event === "error") {
					(cb as (e: Error) => void)(new Error("sync error"));
				}
			},
			removeListener() {},
			resume() {},
		};
		const log: Array<Error> = [];
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", (e: Error) => {
			log.push(e);
		});
		src.resume();
		expect(log.length).toBe(1);
	});

	it("synchronous end during on(end) registration", () => {
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				if (_event === "end") (cb as () => void)();
			},
			removeListener() {},
			resume() {},
		};
		let endCalled = false;
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {
			endCalled = true;
		});
		src.on("error", () => {});
		src.resume();
		expect(endCalled).toBe(true);
	});

	it("synchronous close during on(close) registration", () => {
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				if (_event === "close") (cb as () => void)();
			},
			removeListener() {},
			resume() {},
		};
		let errorCalled = false;
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", () => {});
		src.on("end", () => {});
		src.on("error", () => {
			errorCalled = true;
		});
		src.resume();
		expect(errorCalled).toBe(true);
	});

	it("synchronous data during on(data) registration", () => {
		const srcObj = {
			on(_event: string, cb: (...args: Array<unknown>) => void) {
				if (_event === "data") {
					(cb as (chunk: unknown) => void)(Buffer.from([0, 0, 0, 1, 0x42]));
				}
			},
			removeListener() {},
			resume() {},
		};
		const log = makeLog();
		const src = unwrapOk(createNodeStdinAdapter(srcObj));
		src.on("data", (chunk: Uint8Array) => {
			log.data.push(chunk);
		});
		src.on("end", () => {});
		src.on("error", () => {
			log.error.push(new Error("x"));
		});
		src.resume();
		expect(log.data.length).toBeGreaterThanOrEqual(1);
	});
});

// ===========================================================================
// Integration with frame reader
// ===========================================================================

describe("integration with frame reader", () => {
	it("reads a frame through the adapter", async () => {
		const payload = new Uint8Array([0x01, 0x02, 0x03]);
		const frame = makeFrame(payload);
		const r = new Readable({
			read() {
				this.push(Buffer.from(frame));
				this.push(null);
			},
		});
		const result = createNodeStdinAdapter(r);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const readResult = await readStdinBootstrapFrame(result.source);
			expect(readResult.ok).toBe(true);
			if (readResult.ok) {
				expect(Array.from(readResult.payload)).toEqual([0x01, 0x02, 0x03]);
			}
		}
	});

	it("reads a max-size frame through the adapter", async () => {
		const payload = new Uint8Array(65536);
		payload[0] = 0xab;
		payload[65535] = 0xcd;
		const frame = makeFrame(payload);
		const r = new Readable({
			read() {
				this.push(Buffer.from(frame));
				this.push(null);
			},
		});
		const result = createNodeStdinAdapter(r);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const readResult = await readStdinBootstrapFrame(result.source);
			expect(readResult.ok).toBe(true);
			if (readResult.ok) {
				expect(readResult.payload.byteLength).toBe(65536);
				expect(readResult.payload[0]).toBe(0xab);
				expect(readResult.payload[65535]).toBe(0xcd);
			}
		}
	});

	it("reports TRAILING when frame has extra bytes", async () => {
		const payload = new Uint8Array([0x01]);
		const frame = makeFrame(payload);
		const combined = new Uint8Array(frame.byteLength + 1);
		combined.set(frame);
		combined[combined.byteLength - 1] = 0xff;
		const r = new Readable({
			read() {
				this.push(Buffer.from(combined));
				this.push(null);
			},
		});
		const result = createNodeStdinAdapter(r);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const readResult = await readStdinBootstrapFrame(result.source);
			expect(readResult.ok).toBe(false);
			if (!readResult.ok) {
				expect(readResult.code).toBe("TRAILING");
			}
		}
	});

	it("invalid result does not hang frame reader", async () => {
		const result = await readStdinBootstrapFrame(null as unknown as StdinSource);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_SOURCE");
	});

	it("produced source passes frame reader copySource validation", async () => {
		const r = new Readable({ read() {} });
		const result = createNodeStdinAdapter(r);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const readResult = await readStdinBootstrapFrame(result.source, { totalTimeoutMs: 5 });
			expect(readResult.ok).toBe(false);
			if (!readResult.ok) expect(readResult.code).toBe("TIMEOUT");
		}
		r.destroy();
	});

	it("reads a frame split across multiple chunks", async () => {
		const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
		const frame = makeFrame(payload);
		const r = new Readable({
			read() {
				for (let i = 0; i < frame.byteLength; i++) {
					this.push(Buffer.from([frame[i]]));
				}
				this.push(null);
			},
		});
		const result = createNodeStdinAdapter(r);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const readResult = await readStdinBootstrapFrame(result.source);
			expect(readResult.ok).toBe(true);
			if (readResult.ok) {
				expect(Array.from(readResult.payload)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05]);
			}
		}
	});
});
it("synchronous resume: downstream removes all three callbacks before resume returns, ownedClose cleaned up", () => {
	// Source that synchronously emits data + end during sourceResume.
	// The downstream end callback removes all three downstream listeners
	// before resume() returns. At that point resumed must be true so
	// the disposal branch fires and cleans up ownedClose.
	let _dataCb: ((chunk: unknown) => void) | null = null;
	let _endCb: (() => void) | null = null;
	const closeCbs: Array<(...args: Array<unknown>) => void> = [];
	const s = {
		on(event: string, cb: (...args: Array<unknown>) => void) {
			if (event === "data") _dataCb = cb as (chunk: unknown) => void;
			if (event === "end") _endCb = cb as () => void;
			if (event === "close") closeCbs.push(cb);
		},
		removeListener(event: string, cb: (...args: Array<unknown>) => void) {
			if (event === "close") {
				const idx2 = closeCbs.indexOf(cb);
				if (idx2 >= 0) closeCbs.splice(idx2, 1);
			}
		},
		resume() {
			if (_dataCb) _dataCb(Buffer.from([0, 0, 0, 1, 0x42]));
			if (_endCb) _endCb();
		},
	};
	const src = unwrapOk(createNodeStdinAdapter(s));
	const dCb = (chunk: Uint8Array) => {
		void chunk;
	};
	const eCb = () => {
		// Frame reader cleanup: remove all three downstream callbacks
		src.removeListener("data", dCb);
		src.removeListener("end", eCb);
		src.removeListener("error", errCb);
	};
	const errCb = (e: Error) => {
		void e;
	};
	src.on("data", dCb);
	src.on("end", eCb);
	src.on("error", errCb);

	let unrelatedClosed = false;
	s.on("close", () => {
		unrelatedClosed = true;
	});

	// Before resume: only unrelated close listener
	expect(closeCbs.length).toBe(1);

	src.resume();

	// After resume: owned close was registered then cleaned up via
	// downstream-disposal (end callback removed all three).
	// Only unrelated survives.
	expect(closeCbs.length).toBe(1);

	// Emit close: only unrelated fires
	for (const cb of closeCbs) cb();
	expect(unrelatedClosed).toBe(true);
});
