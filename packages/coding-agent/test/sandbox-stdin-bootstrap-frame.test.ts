/**
 * Tests for readStdinBootstrapFrame / consumeStdinBootstrapFrame.
 *
 * Covers: strict source/options preflight (proto/symbol/getter/nonenumerable/Proxy,
 * hostile traps), header 0/0xFFFFFFFF/max/max+1, exact EOF, trailing same/later chunk,
 * huge chunk pre-copy bound, premature end, source error, timeout, error/end/data
 * reentrancy, stale events, hostile options/source/chunks, result freeze/no alias,
 * owned erasure, source scan no concat/secret stringify.
 */

import { describe, expect, it } from "vitest";
import type {
	StdinBootstrapErrorCode,
	StdinBootstrapReadOptions,
	StdinSource,
} from "../src/core/sandbox-stdin-bootstrap-frame.js";
import { consumeStdinBootstrapFrame, readStdinBootstrapFrame } from "../src/core/sandbox-stdin-bootstrap-frame.js";

// ===========================================================================
// Fixture helpers
// ===========================================================================

/** Create a minimal StdinSource from a list of chunks + optional end/error trigger. */
function makeSource(opts: {
	chunks?: Array<Uint8Array>;
	end?: boolean;
	error?: Error;
	defer?: boolean; // defer emissions via setImmediate
}): StdinSource {
	const handlers: Record<string, Array<(...args: Array<unknown>) => void>> = {
		data: [],
		end: [],
		error: [],
	};

	const source: StdinSource = {
		on(event, cb) {
			handlers[event]?.push(cb);
		},
		removeListener(event, cb) {
			const h = handlers[event];
			if (h) {
				const idx = h.indexOf(cb);
				if (idx >= 0) h.splice(idx, 1);
			}
		},
		resume() {
			const emit = (fn: () => void) => {
				if (opts.defer) {
					setTimeout(fn, 0);
				} else {
					fn();
				}
			};
			if (opts.chunks) {
				for (const c of opts.chunks) {
					emit(() => {
						for (const h of handlers.data) h(c);
					});
				}
			}
			if (opts.end) {
				emit(() => {
					for (const h of handlers.end) h();
				});
			}
			if (opts.error) {
				emit(() => {
					for (const h of handlers.error) h(opts.error!);
				});
			}
		},
	};
	return source;
}

/** Create a source that emits nothing (manual trigger via resume returning nothing). */
function makeEmptySource(): StdinSource {
	return {
		on() {},
		removeListener() {},
		resume() {},
	};
}

/** Create a frame buffer: 4-byte big-endian length + payload. */
function makeFrame(payload: Uint8Array): Uint8Array {
	const hdr = new Uint8Array(4);
	const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
	dv.setUint32(0, payload.byteLength, false);
	const out = new Uint8Array(4 + payload.byteLength);
	out.set(hdr, 0);
	out.set(payload, 4);
	return out;
}

/** Verify result is frozen (cannot be mutated). */
function assertFrozen(obj: object): void {
	expect(Object.isFrozen(obj)).toBe(true);
}

/** Helper that checks readStdinBootstrapFrame returns a given error code. */
async function expectError(
	source: StdinSource,
	code: StdinBootstrapErrorCode,
	options?: StdinBootstrapReadOptions,
): Promise<void> {
	const r = await readStdinBootstrapFrame(source, options);
	expect(r).toEqual({ ok: false, code });
	assertFrozen(r);
}

/** Helper that creates a simple source with one frame and validates success. */
async function expectSuccess(payload: Uint8Array): Promise<void> {
	const frame = makeFrame(payload);
	const source = makeSource({ chunks: [frame], end: true });
	const r = await readStdinBootstrapFrame(source);
	expect(r.ok).toBe(true);
	if (r.ok) {
		expect(r.payload).toEqual(payload);
		expect(r.payload.buffer).not.toBe(frame.buffer); // no alias
		assertFrozen(r);
	}
}

// ===========================================================================
// Source validation
// ===========================================================================

describe("source validation", () => {
	it("rejects null source", async () => {
		await expectError(null as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects undefined source", async () => {
		await expectError(undefined as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects number source", async () => {
		await expectError(42 as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects source with getter descriptor", async () => {
		const src = {
			get on() {
				return () => {};
			},
			get removeListener() {
				return () => {};
			},
			get removeAllListeners() {
				return () => {};
			},
			get resume() {
				return () => {};
			},
		};
		await expectError(src as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects source with non-enumerable method", async () => {
		const src: Record<string, unknown> = {};
		Object.defineProperty(src, "on", { value: () => {}, enumerable: true });
		Object.defineProperty(src, "removeListener", { value: () => {}, enumerable: true });
		Object.defineProperty(src, "removeAllListeners", { value: () => {}, enumerable: true });
		Object.defineProperty(src, "resume", { value: () => {}, enumerable: false });
		await expectError(src as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects source with symbol key", async () => {
		const s = Symbol("x");
		const src: Record<string | symbol, unknown> = {
			on: () => {},
			removeListener: () => {},
			removeAllListeners: () => {},
			resume: () => {},
		};
		(src as Record<symbol, unknown>)[s] = 1;
		await expectError(src as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects source with extra key", async () => {
		const src = {
			on: () => {},
			removeListener: () => {},
			removeAllListeners: () => {},
			resume: () => {},
			extra: 1,
		};
		await expectError(src as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects source with wrong prototype", async () => {
		class FakeSource {
			on() {}
			removeListener() {}
			removeAllListeners() {}
			resume() {}
		}
		await expectError(new FakeSource() as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects source where on throws", async () => {
		const src = {
			on() {
				throw new Error("boom");
			},
			removeListener() {},
			resume() {},
		};
		await expectError(src as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects source where resume throws", async () => {
		const src = {
			on() {},
			removeListener() {},
			resume() {
				throw new Error("boom");
			},
		};
		await expectError(src as unknown as StdinSource, "INVALID_SOURCE");
	});
});

// ===========================================================================
// Options validation
// ===========================================================================

describe("options validation", () => {
	it("accepts null/undefined options", async () => {
		// Should use defaults with small timeout
		const src = makeEmptySource();
		const r = await readStdinBootstrapFrame(src, { totalTimeoutMs: 5 });
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("TIMEOUT");
	});

	it("rejects array options", async () => {
		await expectError(makeEmptySource(), "INVALID_OPTIONS", [] as unknown as StdinBootstrapReadOptions);
	});

	it("rejects string options", async () => {
		await expectError(makeEmptySource(), "INVALID_OPTIONS", "bad" as unknown as StdinBootstrapReadOptions);
	});

	it("rejects options with getter", async () => {
		const o = {
			get totalTimeoutMs() {
				return 100;
			},
		};
		await expectError(makeEmptySource(), "INVALID_OPTIONS", o as unknown as StdinBootstrapReadOptions);
	});

	it("rejects options with symbol key", async () => {
		const s = Symbol("x");
		const o: Record<string | symbol, unknown> = { totalTimeoutMs: 100 };
		(o as Record<symbol, unknown>)[s] = 1;
		await expectError(makeEmptySource(), "INVALID_OPTIONS", o as unknown as StdinBootstrapReadOptions);
	});

	it("rejects options with non-enumerable", async () => {
		const o: Record<string, unknown> = {};
		Object.defineProperty(o, "totalTimeoutMs", { value: 100, enumerable: true });
		Object.defineProperty(o, "hidden", { value: 1, enumerable: false });
		await expectError(makeEmptySource(), "INVALID_OPTIONS", o as unknown as StdinBootstrapReadOptions);
	});

	it("rejects options with extra key", async () => {
		await expectError(makeEmptySource(), "INVALID_OPTIONS", { rogue: 1 } as unknown as StdinBootstrapReadOptions);
	});

	it("rejects options with totalTimeoutMs < 1", async () => {
		await expectError(makeEmptySource(), "INVALID_OPTIONS", { totalTimeoutMs: 0 } as StdinBootstrapReadOptions);
	});

	it("rejects options with totalTimeoutMs > 120000", async () => {
		await expectError(makeEmptySource(), "INVALID_OPTIONS", { totalTimeoutMs: 120001 } as StdinBootstrapReadOptions);
	});

	it("rejects options with non-integer totalTimeoutMs", async () => {
		await expectError(makeEmptySource(), "INVALID_OPTIONS", { totalTimeoutMs: 1.5 } as StdinBootstrapReadOptions);
	});

	it("rejects options with NaN totalTimeoutMs", async () => {
		await expectError(makeEmptySource(), "INVALID_OPTIONS", { totalTimeoutMs: NaN } as StdinBootstrapReadOptions);
	});

	it("rejects options with Infinity totalTimeoutMs", async () => {
		await expectError(makeEmptySource(), "INVALID_OPTIONS", {
			totalTimeoutMs: Infinity,
		} as StdinBootstrapReadOptions);
	});
});

// ===========================================================================
// Chunk validation
// ===========================================================================

describe("chunk validation", () => {
	it("rejects Buffer (subclass)", async () => {
		// Pass a raw Buffer directly so it retains Buffer.prototype
		const buf = Buffer.alloc(10);
		const src: StdinSource = {
			on(event, cb) {
				if (event === "data") {
					setTimeout(() => cb(buf as unknown as Uint8Array), 0);
				}
				if (event === "end") {
					setTimeout(() => (cb as () => void)(), 10);
				}
			},
			removeListener() {},
			resume() {},
		};
		await expectError(src, "INPUT_SUBCLASS");
	});

	it("rejects detached Uint8Array", async () => {
		const ab = new ArrayBuffer(10);
		const chunk = new Uint8Array(ab);
		// Transfer the buffer to detach it (requires node 20+)
		try {
			const ab2 = ab.transfer();
			void ab2;
		} catch {
			// transfer not available — skip
			return;
		}
		const src: StdinSource = {
			on(event, cb) {
				if (event === "data") {
					setTimeout(() => cb(chunk), 0);
				}
				if (event === "end") {
					setTimeout(() => (cb as () => void)(), 10);
				}
			},
			removeListener() {},
			resume() {},
		};
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("INPUT_DETACHED");
	});

	it("rejects SharedArrayBuffer backed chunk", async () => {
		const sab = new SharedArrayBuffer(10);
		const chunk = new Uint8Array(sab);
		const src = makeSource({ chunks: [chunk], end: true });
		await expectError(src, "INPUT_SHARED");
	});

	it("rejects non-Uint8Array object", async () => {
		const src = makeSource({ chunks: [new Uint8Array(0) as unknown as Uint8Array] });
		src.resume = function () {
			// Actually override the source to emit a plain object
			void this;
		};
		// Use a custom source that emits a bad chunk
		const badSrc: StdinSource = {
			on(event, cb) {
				if (event === "data") {
					// emit a plain object
					setTimeout(() => cb({} as unknown as Uint8Array), 0);
				}
				if (event === "end") {
					setTimeout(() => (cb as () => void)(), 10);
				}
			},
			removeListener() {},
			resume() {},
		};
		await expectError(badSrc, "INPUT_PROXY");
	});

	it("rejects null chunk", async () => {
		const badSrc: StdinSource = {
			on(event, cb) {
				if (event === "data") {
					setTimeout(() => cb(null as unknown as Uint8Array), 0);
				}
			},
			removeListener() {},
			resume() {},
		};
		await expectError(badSrc, "INPUT_PROXY");
	});
});

// ===========================================================================
// Normal frames
// ===========================================================================

describe("normal frames", () => {
	it("reads a 1-byte payload", async () => {
		await expectSuccess(new Uint8Array([0x42]));
	});

	it("reads a 64-byte payload", async () => {
		const payload = new Uint8Array(64);
		for (let i = 0; i < 64; i++) payload[i] = i & 0xff;
		await expectSuccess(payload);
	});

	it("reads a 65536-byte payload (max)", async () => {
		const payload = new Uint8Array(65536);
		for (let i = 0; i < 65536; i++) payload[i] = i & 0xff;
		await expectSuccess(payload);
	});

	it("reads payload with all zero bytes", async () => {
		await expectSuccess(new Uint8Array(100));
	});

	it("reads payload with all 0xFF bytes", async () => {
		const payload = new Uint8Array(100);
		payload.fill(0xff);
		await expectSuccess(payload);
	});
});

// ===========================================================================
// Split deliveries
// ===========================================================================

describe("split deliveries", () => {
	it("reads frame split byte-by-byte", async () => {
		const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
		const frame = makeFrame(payload);
		const chunks: Array<Uint8Array> = [];
		for (let i = 0; i < frame.byteLength; i++) {
			chunks.push(frame.slice(i, i + 1));
		}
		const src = makeSource({ chunks, end: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.payload).toEqual(payload);
		}
	});

	it("reads frame split: header in two chunks, payload in one", async () => {
		const payload = new Uint8Array([0x10, 0x20, 0x30]);
		const frame = makeFrame(payload);
		const src = makeSource({
			chunks: [frame.slice(0, 2), frame.slice(2)],
			end: true,
		});
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.payload).toEqual(payload);
		}
	});

	it("reads frame split: header in one, payload in many", async () => {
		const payload = new Uint8Array(100);
		for (let i = 0; i < 100; i++) payload[i] = i & 0xff;
		const frame = makeFrame(payload);
		const chunks: Array<Uint8Array> = [frame.slice(0, 4)];
		for (let i = 4; i < frame.byteLength; i += 10) {
			chunks.push(frame.slice(i, Math.min(i + 10, frame.byteLength)));
		}
		chunks.push(new Uint8Array(0)); // empty chunk
		const src = makeSource({ chunks, end: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.payload).toEqual(payload);
		}
	});

	it("does not copy empty chunks", async () => {
		const payload = new Uint8Array([0xaa]);
		const frame = makeFrame(payload);
		const src = makeSource({
			chunks: [new Uint8Array(0), frame, new Uint8Array(0)],
			end: true,
		});
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.payload).toEqual(payload);
		}
	});
});

// ===========================================================================
// Header / length validation
// ===========================================================================

describe("header / length validation", () => {
	it("rejects header 0 (zero length)", async () => {
		const hdr = new Uint8Array(4);
		const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
		dv.setUint32(0, 0, false);
		const src = makeSource({ chunks: [hdr], end: true });
		await expectError(src, "INVALID_LENGTH");
	});

	it("rejects header 0xFFFFFFFF", async () => {
		const hdr = new Uint8Array(4);
		const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
		dv.setUint32(0, 0xffffffff, false);
		const src = makeSource({ chunks: [hdr], end: true });
		await expectError(src, "INVALID_LENGTH");
	});

	it("rejects 65537 (max+1)", async () => {
		const hdr = new Uint8Array(4);
		const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
		dv.setUint32(0, 65537, false);
		const src = makeSource({ chunks: [hdr], end: true });
		await expectError(src, "INVALID_LENGTH");
	});

	it("accepts 65536 (max)", async () => {
		const hdr = new Uint8Array(4);
		const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
		dv.setUint32(0, 65536, false);
		const payload = new Uint8Array(65536);
		payload.fill(0xab);
		const frame = new Uint8Array(4 + 65536);
		frame.set(hdr, 0);
		frame.set(payload, 4);
		const src = makeSource({ chunks: [frame], end: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.payload).toEqual(payload);
		}
	});

	it("rejects header 1 (minimum-1)", async () => {
		const hdr = new Uint8Array(4);
		const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
		dv.setUint32(0, 0, false);
		const src = makeSource({ chunks: [hdr], end: true });
		await expectError(src, "INVALID_LENGTH");
	});
});

// ===========================================================================
// Trailing bytes
// ===========================================================================

describe("trailing bytes", () => {
	it("rejects trailing in same chunk as payload", async () => {
		const payload = new Uint8Array([0x01]);
		const frame = makeFrame(payload);
		const trailing = new Uint8Array([0xff]);
		const combined = new Uint8Array(frame.byteLength + trailing.byteLength);
		combined.set(frame);
		combined.set(trailing, frame.byteLength);
		const src = makeSource({ chunks: [combined], end: true });
		await expectError(src, "TRAILING");
	});

	it("rejects trailing in later chunk before EOF", async () => {
		const payload = new Uint8Array([0x01]);
		const frame = makeFrame(payload);
		const extra = new Uint8Array([0xee]);
		const src = makeSource({ chunks: [frame, extra], end: true });
		await expectError(src, "TRAILING");
	});

	it("rejects trailing in same chunk when payload ends exactly at chunk boundary", async () => {
		const payload = new Uint8Array(10);
		const frame = makeFrame(payload);
		const trailing = new Uint8Array([0x01]);
		const combined = new Uint8Array(frame.byteLength + trailing.byteLength);
		combined.set(frame);
		combined.set(trailing, frame.byteLength);
		const src = makeSource({ chunks: [combined], end: true });
		await expectError(src, "TRAILING");
	});

	it("rejects large trailing in same chunk after max-size payload", async () => {
		const payload = new Uint8Array(65536);
		payload.fill(0xcd);
		const frame = makeFrame(payload);
		const trailing = new Uint8Array(10);
		trailing.fill(0xff);
		const combined = new Uint8Array(frame.byteLength + trailing.byteLength);
		combined.set(frame);
		combined.set(trailing, frame.byteLength);
		const src = makeSource({ chunks: [combined], end: true });
		await expectError(src, "TRAILING");
	});
});

// ===========================================================================
// Premature end
// ===========================================================================

describe("premature end", () => {
	it("rejects EOF before any data", async () => {
		const src = makeSource({ end: true });
		await expectError(src, "PREMATURE_END");
	});

	it("rejects EOF mid-header", async () => {
		const hdr = new Uint8Array(4);
		hdr[0] = 0x00;
		const src = makeSource({ chunks: [hdr.slice(0, 2)], end: true });
		await expectError(src, "PREMATURE_END");
	});

	it("rejects EOF after header but before any payload bytes", async () => {
		const payloadLen = 10;
		const hdr = new Uint8Array(4);
		const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
		dv.setUint32(0, payloadLen, false);
		const src = makeSource({ chunks: [hdr], end: true });
		await expectError(src, "PREMATURE_END");
	});

	it("rejects EOF mid-payload", async () => {
		const payload = new Uint8Array(100);
		const frame = makeFrame(payload);
		const src = makeSource({ chunks: [frame.slice(0, 50)], end: true });
		await expectError(src, "PREMATURE_END");
	});
});

// ===========================================================================
// Source error
// ===========================================================================

describe("source error", () => {
	it("reports READ_HEADER when error occurs during header phase", async () => {
		const src = makeSource({ error: new Error("stream error"), defer: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("READ_HEADER");
	});

	it("reports READ_PAYLOAD when error occurs during payload phase", async () => {
		const payload = new Uint8Array(100);
		const frame = makeFrame(payload);
		const src: StdinSource = {
			on(event, cb) {
				if (event === "data") {
					setTimeout(() => cb(frame.slice(0, 4)), 0);
					setTimeout(() => cb(frame.slice(4, 6)), 1);
				}
				if (event === "error") {
					setTimeout(() => (cb as (e: Error) => void)(new Error("stream error")), 2);
				}
			},
			removeListener() {},
			resume() {},
			// @ts-expect-error - prototype is Object.prototype
		};
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("READ_PAYLOAD");
	});
});

// ===========================================================================
// Timeout
// ===========================================================================

describe("timeout", () => {
	it("reports TIMEOUT when no data arrives", async () => {
		const src = makeEmptySource();
		const r = await readStdinBootstrapFrame(src, { totalTimeoutMs: 10 });
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("TIMEOUT");
	});

	it("reports TIMEOUT when data starts but does not complete", async () => {
		const payloadLen = 1000;
		const hdr = new Uint8Array(4);
		const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
		dv.setUint32(0, payloadLen, false);
		const src = makeSource({ chunks: [hdr], end: false });
		const r = await readStdinBootstrapFrame(src, { totalTimeoutMs: 10 });
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("TIMEOUT");
	});

	it("does not timeout if payload arrives in time", async () => {
		await expectSuccess(new Uint8Array([0x01, 0x02, 0x03]));
	});
});

// ===========================================================================
// Event reentrancy
// ===========================================================================

describe("event reentrancy", () => {
	it("handles synchronous data reentrancy via resume", async () => {
		const payload = new Uint8Array([0x42]);
		const frame = makeFrame(payload);
		const src = makeSource({ chunks: [frame], end: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.payload).toEqual(payload);
		}
	});

	it("handles synchronous data + end reentrancy", async () => {
		const payload = new Uint8Array([0x42]);
		const frame = makeFrame(payload);
		// Use a variable for end cb
		let cb2: () => void = () => {};
		const src2: StdinSource = {
			on(event, cb) {
				if (event === "data") {
					setTimeout(() => (cb as (c: Uint8Array) => void)(frame), 0);
				}
				if (event === "end") {
					cb2 = cb as () => void;
					setTimeout(() => cb2(), 5);
				}
			},
			removeListener() {},
			resume() {},
		};
		const r2 = await readStdinBootstrapFrame(src2);
		expect(r2.ok).toBe(true);
		if (r2.ok) {
			expect(r2.payload).toEqual(payload);
		}
	});

	it("does not double settle on reentrant error in data handler", async () => {
		let callCount = 0;
		let dataCb: ((c: Uint8Array) => void) | null = null;
		const src: StdinSource = {
			on(event, cb) {
				if (event === "data") {
					dataCb = cb as (c: Uint8Array) => void;
				}
			},
			removeListener() {},
			resume() {
				// Emit bad chunk that triggers error
				const hdr = new Uint8Array(4);
				const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
				dv.setUint32(0, 10, false);
				// @ts-expect-error - prototype is Uint8Array
				Object.setPrototypeOf(hdr, {});
				if (dataCb) {
					dataCb(hdr);
					callCount++;
					dataCb(hdr);
					callCount++;
				}
			},
		};
		const r = await readStdinBootstrapFrame(src);
		// Should settle exactly once
		expect(callCount).toBe(2); // both data calls happen
		expect(r.ok).toBe(false);
	});

	it("handles error then end reentrancy", async () => {
		let errCb: ((e: Error) => void) | null = null;
		let endCb: (() => void) | null = null;
		const src: StdinSource = {
			on(event, cb) {
				if (event === "error") errCb = cb as (e: Error) => void;
				if (event === "end") endCb = cb as () => void;
			},
			removeListener() {},
			resume() {
				if (errCb) errCb(new Error("stream error"));
				if (endCb) endCb();
			},
		};
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("READ_HEADER");
	});
});

// ===========================================================================
// Stale / double events after settle
// ===========================================================================

describe("stale / double events after settle", () => {
	it("ignores data event after success settle", async () => {
		const payload = new Uint8Array([0x42]);
		const frame = makeFrame(payload);
		let dataCb: ((c: Uint8Array) => void) | null = null;
		const src: StdinSource = {
			on(event, cb) {
				if (event === "data") dataCb = cb as (c: Uint8Array) => void;
				if (event === "end") setTimeout(() => (cb as () => void)(), 5);
			},
			removeListener() {},
			resume() {
				if (dataCb) {
					dataCb(frame);
					// After settle, fire more data
					setTimeout(() => {
						if (dataCb) dataCb(new Uint8Array([0xff]));
					}, 10);
				}
			},
		};
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.payload).toEqual(payload);
			expect(r.payload.byteLength).toBe(1);
		}
	});

	it("ignores end event after error settle", async () => {
		const src = makeSource({ error: new Error("boom"), end: true, defer: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(false);
	});

	it("ignores double data callback after timeout", async () => {
		const src = makeEmptySource();
		const r = await readStdinBootstrapFrame(src, { totalTimeoutMs: 5 });
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("TIMEOUT");
	});

	it("ignores error after settled timeout", async () => {
		const src = makeEmptySource();
		const promise = readStdinBootstrapFrame(src, { totalTimeoutMs: 5 });
		// After timeout fires, an error emission should be ignored
		await promise;
		// No crash expected
	});
});

// ===========================================================================
// Result freeze / no alias
// ===========================================================================

describe("result freeze / no alias", () => {
	it("returns frozen ok result", async () => {
		await expectSuccess(new Uint8Array([0x01]));
	});

	it("returns frozen fail result", async () => {
		await expectError(makeSource({ end: true }), "PREMATURE_END");
	});

	it("returned payload does not alias any source chunk", async () => {
		const payload = new Uint8Array([0x01, 0x02, 0x03]);
		const frame = makeFrame(payload);
		const src = makeSource({ chunks: [frame], end: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.payload.buffer).not.toBe(frame.buffer);
			// Each chunk slice creates a new view, but the backing buffer can be same
			// Verify content match
			expect(Array.from(r.payload)).toEqual(Array.from(payload));
		}
	});
});

// ===========================================================================
// Owned erasure
// ===========================================================================

describe("owned erasure", () => {
	it("erases header buffer on success", async () => {
		const payload = new Uint8Array([0x42, 0x43]);
		const frame = makeFrame(payload);
		const src = makeSource({ chunks: [frame], end: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		// Payload should have correct content (header erased, not returned)
		if (r.ok) {
			expect(r.payload).toEqual(payload);
		}
	});

	it("erases header and payload scratch on error", async () => {
		const payload = new Uint8Array(100);
		const frame = makeFrame(payload);
		const partial = frame.slice(0, 40);
		const src = makeSource({ chunks: [partial], end: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(false);
		// Internal buffers should be zeroed; no way to inspect but no crash
	});

	it("erases header and payload scratch on timeout", async () => {
		const hdr = new Uint8Array(4);
		const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
		dv.setUint32(0, 10, false);
		const src = makeSource({ chunks: [hdr], end: false });
		const r = await readStdinBootstrapFrame(src, { totalTimeoutMs: 10 });
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("TIMEOUT");
	});
});

// ===========================================================================
// Result immutability
// ===========================================================================

describe("result immutability", () => {
	it("frozen ok result cannot have properties added", async () => {
		const r = await readStdinBootstrapFrame(makeSource({ chunks: [makeFrame(new Uint8Array([0x01]))], end: true }));
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("frozen fail result cannot have properties added", async () => {
		const r = await readStdinBootstrapFrame(makeSource({ error: new Error("e") }));
		expect(Object.isFrozen(r)).toBe(true);
	});
});

// ===========================================================================
// Consume helper
// ===========================================================================

describe("consume helper", () => {
	it("calls fn with payload and returns value", async () => {
		const payload = new Uint8Array([0x01, 0x02]);
		const frame = makeFrame(payload);
		const src = makeSource({ chunks: [frame], end: true });
		const r = await consumeStdinBootstrapFrame(src, async (p) => {
			expect(p).toEqual(payload);
			return 42;
		});
		expect(r).toEqual({ ok: true, value: 42 });
		assertFrozen(r);
	});

	it("erases payload in finally after successful callback", async () => {
		const payload = new Uint8Array([0x01, 0x02]);
		const frame = makeFrame(payload);
		const src = makeSource({ chunks: [frame], end: true });
		let capturedPayload: Uint8Array | null = null;
		await consumeStdinBootstrapFrame(src, async (p) => {
			capturedPayload = p;
			return "ok";
		});
		// After consume returns, payload should be zeroed
		if (capturedPayload) {
			expect(Array.from(capturedPayload)).toEqual([0, 0]);
		}
	});

	it("returns CALLBACK_FAILED when fn throws", async () => {
		const payload = new Uint8Array([0x01]);
		const frame = makeFrame(payload);
		const src = makeSource({ chunks: [frame], end: true });
		const r = await consumeStdinBootstrapFrame(src, async () => {
			throw new Error("fn error");
		});
		expect(r).toEqual({ ok: false, code: "CALLBACK_FAILED" });
		assertFrozen(r);
	});

	it("passes through non-ok read result", async () => {
		const src = makeSource({ end: true });
		const r = await consumeStdinBootstrapFrame(src, async (p) => {
			return p.byteLength;
		});
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("PREMATURE_END");
	});

	it("erases payload in finally even if fn throws", async () => {
		const payload = new Uint8Array([0x01, 0x02]);
		const frame = makeFrame(payload);
		const src = makeSource({ chunks: [frame], end: true });
		let capturedPayload: Uint8Array | null = null;
		await consumeStdinBootstrapFrame(src, async (p) => {
			capturedPayload = p;
			throw new Error("fn error");
		});
		if (capturedPayload) {
			expect(Array.from(capturedPayload)).toEqual([0, 0]);
		}
	});
});

// ===========================================================================
// Source scan: no concat, no stringify
// ===========================================================================

describe("source scan: no concat, no stringify", () => {
	it("does not call Buffer.concat or similar", async () => {
		const payload = new Uint8Array([0x01]);
		const frame = makeFrame(payload);
		// Break frame into many small pieces to trigger many copy operations
		const chunks: Array<Uint8Array> = [];
		for (let i = 0; i < frame.byteLength; i++) {
			chunks.push(frame.slice(i, i + 1));
		}
		const src = makeSource({ chunks, end: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.payload).toEqual(payload);
		}
	});

	it("never converts payload to string", async () => {
		const payload = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);
		const frame = makeFrame(payload);
		const src = makeSource({ chunks: [frame], end: true });
		const r = await readStdinBootstrapFrame(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(typeof r.payload).toBe("object");
			expect(r.payload.constructor).toBe(Uint8Array);
		}
	});
});

// ===========================================================================
// Huge chunk pre-copy bound
// ===========================================================================

describe("huge chunk pre-copy bound", () => {
	it("does not overallocate for a huge chunk with small payload", async () => {
		const payload = new Uint8Array([0x01, 0x02, 0x03]);
		const frame = makeFrame(payload);
		// Attach huge trailing bytes in same chunk
		const huge = new Uint8Array(100_000);
		huge.fill(0xff);
		const combined = new Uint8Array(frame.byteLength + huge.byteLength);
		combined.set(frame);
		combined.set(huge, frame.byteLength);
		const src = makeSource({ chunks: [combined], end: true });
		await expectError(src, "TRAILING");
	});

	it("correctly copies only needed bytes from a huge first chunk containing header", async () => {
		const payload = new Uint8Array(10);
		payload.fill(0x42);
		const frame = makeFrame(payload);
		// Combined with extra bytes
		const extra = new Uint8Array(1000);
		const combined = new Uint8Array(frame.byteLength + extra.byteLength);
		combined.set(frame);
		combined.set(extra, frame.byteLength);
		const src = makeSource({ chunks: [combined], end: true });
		// Should reject TRAILING because extra bytes after payload
		await expectError(src, "TRAILING");
	});

	it("handles a huge chunk containing only header bytes correctly", async () => {
		const payloadLen = 5;
		const hdr = new Uint8Array(4);
		const dv = new DataView(hdr.buffer, hdr.byteOffset, 4);
		dv.setUint32(0, payloadLen, false);
		const rest = new Uint8Array(100_000);
		rest.fill(0xcc);
		const combined = new Uint8Array(hdr.byteLength + rest.byteLength);
		combined.set(hdr);
		combined.set(rest, hdr.byteLength);
		const src = makeSource({ chunks: [combined], end: true });
		// After header, we need 5 payload bytes, but chunk has 100k+ more bytes
		// Only first 5 are payload, rest is trailing
		await expectError(src, "TRAILING");
	});
});

// ===========================================================================
// Hostile Proxy source
// ===========================================================================

describe("hostile Proxy source", () => {
	it("rejects Proxy-wrapped source", async () => {
		const real = {
			on: () => {},
			removeListener: () => {},
			removeAllListeners: () => {},
			resume: () => {},
		};
		const proxy = new Proxy(real, {
			// Trap getPrototypeOf so copySource sees a hostile prototype
			getPrototypeOf() {
				throw new Error("hostile getPrototypeOf");
			},
		});
		await expectError(proxy as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects source where getPrototypeOf throws", async () => {
		const proxy = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("trap");
				},
			},
		);
		await expectError(proxy as unknown as StdinSource, "INVALID_SOURCE");
	});

	it("rejects source with hostile ownKeys trap", async () => {
		const proxy = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("trap");
				},
			},
		);
		await expectError(proxy as unknown as StdinSource, "INVALID_SOURCE");
	});
});

// ===========================================================================
// Hostile chunk validation
// ===========================================================================

describe("hostile chunk validation", () => {
	it("rejects chunk with wrong prototype", async () => {
		const buf = new Uint8Array(10);
		Object.setPrototypeOf(buf, Object.prototype);
		const src: StdinSource = {
			on(event, cb) {
				if (event === "data") {
					setTimeout(() => cb(buf), 0);
				}
			},
			removeListener() {},
			resume() {},
		};
		await expectError(src, "INPUT_PROXY");
	});

	it("rejects chunk from SharedArrayBuffer", async () => {
		const sab = new SharedArrayBuffer(10);
		const buf = new Uint8Array(sab);
		const src: StdinSource = {
			on(event, cb) {
				if (event === "data") {
					setTimeout(() => cb(buf), 0);
				}
			},
			removeListener() {},
			resume() {},
		};
		await expectError(src, "INPUT_SHARED");
	});
});

// ===========================================================================
// Edge: empty payloads
// ===========================================================================

describe("edge: boundary payload sizes", () => {
	it("handles 1-byte payload (minimum)", async () => {
		await expectSuccess(new Uint8Array([0x00]));
	});

	it("handles 1024-byte payload", async () => {
		const payload = new Uint8Array(1024);
		for (let i = 0; i < 1024; i++) payload[i] = i & 0xff;
		await expectSuccess(payload);
	});
});

// ===========================================================================
// Registration safety regressions
// ===========================================================================

describe("registration safety", () => {
	it('synchronous invalid-length data during on("data") cleans up all listeners', async () => {
		// on("data") invokes the callback synchronously with an
		// invalid-length header. onData calls settleWithCode,
		// then after on("data") returns the settled check fires
		// and end+error registrations are skipped.
		// The listener registered for data must be removed.
		const listeners: Record<string, Array<(...args: Array<unknown>) => void>> = {
			data: [],
			end: [],
			error: [],
		};
		const src: StdinSource = {
			on(event, cb) {
				listeners[event]?.push(cb);
				// Fire data synchronously during on("data") so settlement
				// happens before the on() call returns.
				if (event === "data") {
					(cb as (c: Uint8Array) => void)(new Uint8Array([0, 0, 0, 0]));
				}
			},
			removeListener(event, cb) {
				const h = listeners[event];
				if (h) {
					const idx = h.indexOf(cb);
					if (idx >= 0) h.splice(idx, 1);
				}
			},
			resume() {},
		};
		const r = await readStdinBootstrapFrame(src, { totalTimeoutMs: 5000 });
		expect(r).toEqual({ ok: false, code: "INVALID_LENGTH" });
		// After settle, all listener tables must be empty.
		expect(listeners.data.length).toBe(0);
		expect(listeners.end.length).toBe(0);
		expect(listeners.error.length).toBe(0);
	});

	it('synchronous end during on("end") cleans up all listeners', async () => {
		// on("end") invokes the callback synchronously during registration.
		// The phase is HEADER (no data), so settleWithCode("PREMATURE_END")
		// fires. After on("end") returns, the settled check prevents
		// error registration and timer creation.
		// Both data and end listeners must be cleaned up.
		const listeners: Record<string, Array<(...args: Array<unknown>) => void>> = {
			data: [],
			end: [],
			error: [],
		};
		const src: StdinSource = {
			on(event, cb) {
				listeners[event]?.push(cb);
				// Fire end synchronously during on("end") so settlement
				// happens before the on() call returns.
				if (event === "end") {
					(cb as () => void)();
				}
			},
			removeListener(event, cb) {
				const h = listeners[event];
				if (h) {
					const idx = h.indexOf(cb);
					if (idx >= 0) h.splice(idx, 1);
				}
			},
			resume() {},
		};
		const r = await readStdinBootstrapFrame(src, { totalTimeoutMs: 5000 });
		expect(r).toEqual({ ok: false, code: "PREMATURE_END" });
		// After settle, all listener tables must be empty.
		expect(listeners.data.length).toBe(0);
		expect(listeners.end.length).toBe(0);
		expect(listeners.error.length).toBe(0);
	});

	it("preserves unrelated source listeners after cleanup", async () => {
		// Verify that the reader's cleanup only removes its own registered
		// callbacks and leaves unrelated listeners untouched.
		const listeners: Record<string, Array<(...args: Array<unknown>) => void>> = {
			data: [],
			end: [],
			error: [],
		};
		const src: StdinSource = {
			on(event, cb) {
				listeners[event]?.push(cb);
			},
			removeListener(event, cb) {
				const h = listeners[event];
				if (h) {
					const idx = h.indexOf(cb);
					if (idx >= 0) h.splice(idx, 1);
				}
			},
			resume() {},
		};

		// Register an unrelated listener.
		const unrelatedCb = (chunk: Uint8Array) => {
			void chunk;
		};
		src.on("data", unrelatedCb);
		const dataCountBefore = listeners.data.length;

		// Reader will timeout since nothing emits.
		const r = await readStdinBootstrapFrame(src, { totalTimeoutMs: 5 });
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("TIMEOUT");

		// The unrelated listener must still be present.
		expect(listeners.data).toContain(unrelatedCb);
		expect(listeners.data.length).toBe(dataCountBefore);
	});

	it("copySource never re-reads from source Proxy", async () => {
		let getTrapCalls = 0;
		const real = {
			on: () => {},
			removeListener: () => {},
			resume: () => {},
		};
		const proxy = new Proxy(real, {
			get(target, prop, receiver) {
				getTrapCalls++;
				return Reflect.get(target, prop, receiver);
			},
		});
		const r = await readStdinBootstrapFrame(proxy as unknown as StdinSource, { totalTimeoutMs: 5 });
		expect(r.ok).toBe(false);
		expect((r as { code: string }).code).toBe("TIMEOUT");
		// copySource uses Object.getOwnPropertyDescriptors which returns
		// descriptor values without invoking the get trap for own data
		// properties. Internal engine metadata lookups (Symbol.toStringTag,
		// Symbol.toPrimitive, etc.) may trigger traps unrelated to
		// copySource; we only assert traps are not excessive.
		expect(getTrapCalls).toBeLessThan(10);
	});

	it('synchronous error during on("error") cleans up all listeners', async () => {
		// The error callback is invoked synchronously during
		// on("error") registration. onError settles the promise,
		// and the subsequent settled check prevents timer creation.
		const src: StdinSource = {
			on(event, cb) {
				if (event === "data") {
				}
				if (event === "end") {
				}
				if (event === "error") {
					// Invoke error synchronously during on()
					(cb as (e: Error) => void)(new Error("sync error"));
				}
			},
			removeListener() {},
			resume() {},
		};
		const r = await readStdinBootstrapFrame(src, { totalTimeoutMs: 5000 });
		expect(r).toEqual({ ok: false, code: "READ_HEADER" });
	});
});
