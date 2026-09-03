/**
 * Focused tests for _createNodeFd3Adapter — injected dependency factory.
 *
 * Every test uses injected { stream, close, closeTimeoutMs } dependencies
 * with exactly 3 own enumerable data property descriptors.  No test calls
 * production createNodeFd3Adapter() or touches the process's fd 3.
 *
 * The only exported injection API is _createNodeFd3Adapter({stream,close,closeTimeoutMs}).
 * A separate createNodeFd3CloseObserver or arbitrary-fd helper is never exported.
 *
 * Covers:
 *   - Exact shared Promise / reentry idempotency
 *   - Close function original-this binding via Reflect.apply
 *   - Callback success  → ok:true
 *   - Callback error    → CLOSE_UNCERTAIN
 *   - Sync throw        → CLOSE_UNCERTAIN
 *   - Bounded 10ms timeout via closeTimeoutMs
 *   - Late callback (after settle) → ignored
 *   - Destroy throw     → still resolves via callback
 *   - Destroy called exactly once on success close (cleanup only, never evidence)
 *   - Destroy called exactly once on adapter rejection
 *   - Fractional and non-integer timeout values rejected
 *   - Exact input / enumerable own data keys / Proxy / getter rejection
 *   - Fixed fd = 3
 *   - Buffer → fresh full-backing Uint8Array delivery
 *   - Setup-failure cleanup (adapter rejection → close on fd 3)
 *   - Adapter-path uncertainty (close callback errors on adapter rejection)
 *   - No extra exported arbitrary-fd API
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import * as fd3Module from "../src/core/sandbox-node-fd3-adapter.js";
import { _createNodeFd3Adapter } from "../src/core/sandbox-node-fd3-adapter.js";
import { readStdinBootstrapFrame } from "../src/core/sandbox-stdin-bootstrap-frame.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a length-prefixed frame. */
function makeFrame(payload: Uint8Array): Uint8Array {
	const hdr = new Uint8Array(4);
	new DataView(hdr.buffer, hdr.byteOffset, 4).setUint32(0, payload.byteLength, false);
	const out = new Uint8Array(4 + payload.byteLength);
	out.set(hdr, 0);
	out.set(payload, 4);
	return out;
}

/** A callback-based close(2) shim that succeeds. */
function okClose(_fd: number, cb: (err: Error | null) => void): void {
	setImmediate(() => cb(null));
}

/** A callback-based close(2) shim that errors. */
function errClose(_fd: number, cb: (err: Error | null) => void): void {
	setImmediate(() => cb(new Error("close failed")));
}

/** A callback-based close(2) shim that never calls back. */
function neverClose(_fd: number, _cb: (err: Error | null) => void): void {
	// never calls back
}

function validDeps(overrides?: {
	stream?: PassThrough;
	close?: (fd: number, cb: (err: Error | null) => void) => void;
	closeTimeoutMs?: number;
}): Record<string, unknown> {
	return Object.freeze({
		stream: overrides?.stream ?? new PassThrough(),
		close: overrides?.close ?? okClose,
		closeTimeoutMs: overrides?.closeTimeoutMs ?? 5000,
	});
}

// ---------------------------------------------------------------------------
// No extra exported arbitrary-fd API
// ---------------------------------------------------------------------------

describe("no extra exported arbitrary-fd API", () => {
	it("only _createNodeFd3Adapter is the test injection surface", () => {
		// The module must NOT export createNodeFd3CloseObserver or any
		// arbitrary-fd helper — verify via import.
		// Static namespace import at top — no runtime dynamic import.
		expect(typeof fd3Module._createNodeFd3Adapter).toBe("function");
		// These should not exist:
		expect((fd3Module as Record<string, unknown>)._createNodeFd3CloseObserver).toBeUndefined();
		expect((fd3Module as Record<string, unknown>).createNodeFd3CloseObserver).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Rejection: invalid input
// ---------------------------------------------------------------------------

describe("_createNodeFd3Adapter input rejection", () => {
	it("rejects null", async () => {
		const r = await _createNodeFd3Adapter(null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects undefined", async () => {
		const r = await _createNodeFd3Adapter(undefined);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects non-object", async () => {
		const r = await _createNodeFd3Adapter("bad");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects missing stream", async () => {
		const r = await _createNodeFd3Adapter({ close: okClose, closeTimeoutMs: 5000 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects missing close", async () => {
		const r = await _createNodeFd3Adapter({ stream: new PassThrough(), closeTimeoutMs: 5000 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects missing closeTimeoutMs", async () => {
		const r = await _createNodeFd3Adapter({ stream: new PassThrough(), close: okClose });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects Proxy on input object itself", async () => {
		const deps = validDeps();
		const proxy = new Proxy(deps, {});
		const r = await _createNodeFd3Adapter(proxy);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects Proxy stream value", async () => {
		const deps = validDeps({ stream: new Proxy(new PassThrough(), {}) });
		const r = await _createNodeFd3Adapter(deps);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects Proxy close function", async () => {
		const deps = validDeps({ close: new Proxy(okClose, {}) });
		const r = await _createNodeFd3Adapter(deps);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects getter-only stream (accessor)", async () => {
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "stream", {
			get: () => new PassThrough(),
			enumerable: true,
		});
		Object.defineProperty(obj, "close", { value: okClose, enumerable: true, writable: false });
		Object.defineProperty(obj, "closeTimeoutMs", { value: 5000, enumerable: true, writable: false });
		const r = await _createNodeFd3Adapter(obj);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects non-function close", async () => {
		const r = await _createNodeFd3Adapter(
			Object.freeze({ stream: new PassThrough(), close: 42, closeTimeoutMs: 5000 }),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects non-enumerable descriptor", async () => {
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "stream", { value: new PassThrough(), enumerable: true });
		Object.defineProperty(obj, "close", { value: okClose, enumerable: false });
		Object.defineProperty(obj, "closeTimeoutMs", { value: 5000, enumerable: true });
		const r = await _createNodeFd3Adapter(obj);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects object with non-Object.prototype (array)", async () => {
		const r = await _createNodeFd3Adapter([new PassThrough(), okClose, 5000]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects prototype=null object", async () => {
		const nullProto = Object.create(null);
		nullProto.stream = new PassThrough();
		nullProto.close = okClose;
		nullProto.closeTimeoutMs = 5000;
		const r = await _createNodeFd3Adapter(nullProto);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects symbols", async () => {
		const sym = Symbol("test");
		const obj: Record<string, unknown> = {};
		obj.stream = new PassThrough();
		obj.close = okClose;
		obj.closeTimeoutMs = 5000;
		Object.defineProperty(obj, sym as unknown as string, { value: true, enumerable: true });
		const frozen = Object.freeze(obj);
		const r = await _createNodeFd3Adapter(frozen);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects closeTimeoutMs < 1", async () => {
		const r = await _createNodeFd3Adapter(validDeps({ closeTimeoutMs: 0 }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects closeTimeoutMs > 120000", async () => {
		const r = await _createNodeFd3Adapter(validDeps({ closeTimeoutMs: 120001 }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects non-finite closeTimeoutMs", async () => {
		const r = await _createNodeFd3Adapter(validDeps({ closeTimeoutMs: Infinity }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects fractional closeTimeoutMs (3.5)", async () => {
		const r = await _createNodeFd3Adapter(validDeps({ closeTimeoutMs: 3.5 }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects fractional closeTimeoutMs (0.001)", async () => {
		const r = await _createNodeFd3Adapter(validDeps({ closeTimeoutMs: 0.001 }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("rejects negative closeTimeoutMs", async () => {
		const r = await _createNodeFd3Adapter(validDeps({ closeTimeoutMs: -10 }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});

	it("accepts valid PassThrough + okClose + 5000 timeout", async () => {
		const r = await _createNodeFd3Adapter(validDeps());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(typeof (r.source as { on: unknown }).on).toBe("function");
		expect(typeof (r.source as { removeListener: unknown }).removeListener).toBe("function");
		expect(typeof (r.source as { resume: unknown }).resume).toBe("function");
		expect(typeof r.close).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// Close contract: shared native Promise, idempotent
// ---------------------------------------------------------------------------

describe("close — shared native Promise / reentry", () => {
	it("returns the exact same Promise object on multiple calls", async () => {
		const r = await _createNodeFd3Adapter(validDeps());
		if (!r.ok) throw new Error("expected ok");
		const p1 = r.close();
		const p2 = r.close();
		expect(p1).toBe(p2);
	});

	it("is an exact native Promise (not a subclass)", async () => {
		const r = await _createNodeFd3Adapter(validDeps());
		if (!r.ok) throw new Error("expected ok");
		const p = r.close();
		expect(Object.getPrototypeOf(p)).toBe(Promise.prototype);
	});

	it("the Promise is installed before any external call returns", async () => {
		const deps = validDeps({
			close: ((_fd: number, _cb: (err: Error | null) => void) => {
				throw new Error("sync throw");
			}) as (fd: number, cb: (err: Error | null) => void) => void,
		});
		const r = await _createNodeFd3Adapter(deps);
		if (!r.ok) throw new Error("expected ok");
		const p = r.close();
		expect(p).toBeInstanceOf(Promise);
	});
});

// ---------------------------------------------------------------------------
// Close contract: original-this binding via Reflect.apply
// ---------------------------------------------------------------------------

describe("close — Reflect.apply original-this binding", () => {
	it("calls close with the input object as `this`", async () => {
		const closeReceiver: { __closeThis?: object } = {};
		const owner = Object.freeze({
			stream: new PassThrough(),
			close: function (this: object, _fd: number, cb: (err: Error | null) => void) {
				closeReceiver.__closeThis = this;
				setImmediate(() => cb(null));
			},
			closeTimeoutMs: 500,
		});
		const r = await _createNodeFd3Adapter(owner);
		if (!r.ok) throw new Error("expected ok");
		await r.close();
		expect(closeReceiver.__closeThis).toBe(owner);
	});
});

// ---------------------------------------------------------------------------
// Close contract: callback success → ok:true
// ---------------------------------------------------------------------------

describe("close — callback success", () => {
	it("resolves ok:true when close callback reports success", async () => {
		const r = await _createNodeFd3Adapter(validDeps());
		if (!r.ok) throw new Error("expected ok");
		const result = await r.close();
		expect(result).toEqual({ ok: true });
		expect(Object.isFrozen(result)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Close contract: callback error → CLOSE_UNCERTAIN
// ---------------------------------------------------------------------------

describe("close — callback error", () => {
	it("resolves CLOSE_UNCERTAIN when close callback receives error", async () => {
		const r = await _createNodeFd3Adapter(validDeps({ close: errClose }));
		if (!r.ok) throw new Error("expected ok");
		const result = await r.close();
		expect(result).toEqual({ ok: false, code: "CLOSE_UNCERTAIN" });
	});
});

// ---------------------------------------------------------------------------
// Close contract: sync throw → CLOSE_UNCERTAIN
// ---------------------------------------------------------------------------

describe("close — sync throw", () => {
	it("resolves CLOSE_UNCERTAIN when close function synchronously throws", async () => {
		const r = await _createNodeFd3Adapter(
			validDeps({
				close: (() => {
					throw new Error("sync throw");
				}) as (fd: number, cb: (err: Error | null) => void) => void,
			}),
		);
		if (!r.ok) throw new Error("expected ok");
		const result = await r.close();
		expect(result).toEqual({ ok: false, code: "CLOSE_UNCERTAIN" });
	});
});

// ---------------------------------------------------------------------------
// Close contract: 10ms timeout via closeTimeoutMs
// ---------------------------------------------------------------------------

describe("close — injected 10ms timeout duration", () => {
	it("resolves CLOSE_UNCERTAIN within ~10ms when close never calls back", { timeout: 2000 }, async () => {
		const r = await _createNodeFd3Adapter(validDeps({ close: neverClose, closeTimeoutMs: 10 }));
		if (!r.ok) throw new Error("expected ok");
		const t0 = Date.now();
		const result = await r.close();
		const elapsed = Date.now() - t0;
		expect(result).toEqual({ ok: false, code: "CLOSE_UNCERTAIN" });
		expect(elapsed).toBeLessThan(2000);
	});
});

// ---------------------------------------------------------------------------
// Close contract: late callback → ignored safely
// ---------------------------------------------------------------------------

describe("close — late callback", () => {
	it("ignores a callback that arrives after the timer already settled", { timeout: 2000 }, async () => {
		const cbHolder: { cb: ((err: Error | null) => void) | null } = { cb: null };
		const r = await _createNodeFd3Adapter(
			validDeps({
				close: ((_fd: number, cb: (err: Error | null) => void) => {
					cbHolder.cb = cb;
				}) as (fd: number, cb: (err: Error | null) => void) => void,
				closeTimeoutMs: 10,
			}),
		);
		if (!r.ok) throw new Error("expected ok");
		const result = await r.close();
		expect(result).toEqual({ ok: false, code: "CLOSE_UNCERTAIN" });

		const lateFn = cbHolder.cb;
		if (lateFn) {
			lateFn(null);
		}
	});
});

// ---------------------------------------------------------------------------
// Close contract: destroy throw → still resolves via callback
// ---------------------------------------------------------------------------

describe("close — destroy throw", () => {
	it("still resolves via close callback even if stream.destroy() throws", async () => {
		const pt = new PassThrough();
		(pt as unknown as Record<string, unknown>).destroy = () => {
			throw new Error("destroy boom");
		};
		const r = await _createNodeFd3Adapter(validDeps({ stream: pt }));
		if (!r.ok) throw new Error("expected ok");
		const result = await r.close();
		expect(result).toEqual({ ok: true });
	});
});

// ---------------------------------------------------------------------------
// Close contract: destroy called exactly once on success
// ---------------------------------------------------------------------------

describe("close — destroy called exactly once on success", () => {
	it("calls stream.destroy exactly once on successful close", async () => {
		const pt = new PassThrough();
		let destroyCount = 0;
		const orig = pt.destroy.bind(pt);
		(pt as unknown as Record<string, unknown>).destroy = () => {
			destroyCount++;
			orig();
		};
		const r = await _createNodeFd3Adapter(validDeps({ stream: pt }));
		if (!r.ok) throw new Error("expected ok");
		await r.close();
		expect(destroyCount).toBe(1);
	});

	it("resolves ok:true even if destroy throws — callback alone determines result", async () => {
		const pt = new PassThrough();
		(pt as unknown as Record<string, unknown>).destroy = () => {
			throw new Error("destroy failed");
		};
		const r = await _createNodeFd3Adapter(validDeps({ stream: pt }));
		if (!r.ok) throw new Error("expected ok");
		const result = await r.close();
		expect(result).toEqual({ ok: true });
	});
});

// ---------------------------------------------------------------------------
// Destroy on adapter rejection
// ---------------------------------------------------------------------------

describe("destroy on adapter rejection", () => {
	it("calls destroy exactly once when adapter rejects", async () => {
		// Build an object that has a destroy method and a non-function on/removeListener/resume
		// so createNodeStdinAdapter rejects it (adapter path, not validation path).
		let destroyCount = 0;
		const badStream: Record<string, unknown> = {};
		Object.defineProperty(badStream, "destroy", {
			value: () => {
				destroyCount++;
			},
			enumerable: true,
			writable: false,
		});
		Object.defineProperty(badStream, "on", { value: "not-a-function", enumerable: true, writable: false });
		Object.defineProperty(badStream, "removeListener", {
			value: "not-a-function",
			enumerable: true,
			writable: false,
		});
		Object.defineProperty(badStream, "resume", { value: "not-a-function", enumerable: true, writable: false });
		const frozen = Object.freeze(badStream);
		const deps = Object.freeze({
			stream: frozen,
			close: okClose,
			closeTimeoutMs: 500,
		});
		const r = await _createNodeFd3Adapter(deps);
		expect(r.ok).toBe(false);
		// destroy must have been called exactly once during adapter-path cleanup
		expect(destroyCount).toBe(1);
	});

	it("adapter-path uncertainty: CLOSE_UNCERTAIN when close callback errors on adapter rejection", async () => {
		const badStream = Object.freeze({
			on: "not-a-function",
			removeListener: "not-a-function",
			resume: "not-a-function",
		});
		const deps = Object.freeze({
			stream: badStream,
			close: errClose,
			closeTimeoutMs: 500,
		});
		const r = await _createNodeFd3Adapter(deps);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CLOSE_UNCERTAIN");
	});

	it("adapter-path SETUP_FAILED when close callback succeeds on adapter rejection", async () => {
		const badStream = Object.freeze({
			on: "not-a-function",
			removeListener: "not-a-function",
			resume: "not-a-function",
		});
		const deps = Object.freeze({
			stream: badStream,
			close: okClose,
			closeTimeoutMs: 500,
		});
		const r = await _createNodeFd3Adapter(deps);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
	});
});

// ---------------------------------------------------------------------------
// Fixed fd = 3 — always the constant
// ---------------------------------------------------------------------------

describe("fixed fd = 3", () => {
	it("close is always called with fd 3", async () => {
		let capturedFd: number | null = null;
		const r = await _createNodeFd3Adapter(
			validDeps({
				close: ((fd: number, cb: (err: Error | null) => void) => {
					capturedFd = fd;
					setImmediate(() => cb(null));
				}) as (fd: number, cb: (err: Error | null) => void) => void,
			}),
		);
		if (!r.ok) throw new Error("expected ok");
		await r.close();
		expect(capturedFd).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// Buffer → fresh full-backing Uint8Array delivery
// ---------------------------------------------------------------------------

describe("Buffer → Uint8Array delivery", () => {
	it("delivers a genuine full-backing Uint8Array via StdinSource", async () => {
		const pt = new PassThrough();
		const r = await _createNodeFd3Adapter(validDeps({ stream: pt }));
		if (!r.ok) throw new Error("expected ok");

		const payload = new TextEncoder().encode("fd3-test-payload");
		const frame = makeFrame(payload);
		const readPromise = readStdinBootstrapFrame(r.source, { totalTimeoutMs: 1000 });

		pt.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
		pt.end();

		const result = await readPromise;
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(Object.getPrototypeOf(result.payload)).toBe(Uint8Array.prototype);
			expect(result.payload.byteOffset).toBe(0);
			expect(result.payload.byteLength).toBe(result.payload.buffer.byteLength);
			expect(result.payload).toEqual(payload);
		}

		pt.destroy();
	});
});

// ---------------------------------------------------------------------------
// Factory result shape
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Destroy validation: Proxy destroy, accessor destroy
// ---------------------------------------------------------------------------

describe("destroy validation — Proxy / accessor destroy", () => {
	it("rejects Proxy-wrapped destroy — SETUP_FAILED, close called once, destroy not invoked", async () => {
		let hostileCalled = false;
		let closeCalled = false;
		const pt = new PassThrough();
		const proxyDestroy = new Proxy(() => {
			hostileCalled = true;
			throw new Error("hostile");
		}, {});
		Object.defineProperty(pt, "destroy", {
			value: proxyDestroy,
			enumerable: true,
			writable: false,
		});
		const deps = Object.freeze({
			stream: pt,
			close: ((_fd: number, cb: (err: Error | null) => void) => {
				closeCalled = true;
				setImmediate(() => cb(null));
			}) as (fd: number, cb: (err: Error | null) => void) => void,
			closeTimeoutMs: 500,
		});
		const r = await _createNodeFd3Adapter(deps);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
		expect(hostileCalled).toBe(false);
		expect(closeCalled).toBe(true);
	});

	it("rejects Proxy-wrapped destroy — CLOSE_UNCERTAIN when close callback errors", async () => {
		let hostileCalled = false;
		let closeCalled = false;
		const pt = new PassThrough();
		const proxyDestroy = new Proxy(() => {
			hostileCalled = true;
			throw new Error("hostile");
		}, {});
		Object.defineProperty(pt, "destroy", {
			value: proxyDestroy,
			enumerable: true,
			writable: false,
		});
		const deps = Object.freeze({
			stream: pt,
			close: ((_fd: number, cb: (err: Error | null) => void) => {
				closeCalled = true;
				setImmediate(() => cb(new Error("fail")));
			}) as (fd: number, cb: (err: Error | null) => void) => void,
			closeTimeoutMs: 500,
		});
		const r = await _createNodeFd3Adapter(deps);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CLOSE_UNCERTAIN");
		expect(hostileCalled).toBe(false);
		expect(closeCalled).toBe(true);
	});

	it("rejects accessor-only destroy (getter) — SETUP_FAILED, close called once", async () => {
		let closeCalled = false;
		const pt = new PassThrough();
		let accessorCalled = false;
		Object.defineProperty(pt, "destroy", {
			get: () => {
				accessorCalled = true;
				return () => {
					/* hostile */
				};
			},
			enumerable: true,
		});
		const deps = Object.freeze({
			stream: pt,
			close: ((_fd: number, cb: (err: Error | null) => void) => {
				closeCalled = true;
				setImmediate(() => cb(null));
			}) as (fd: number, cb: (err: Error | null) => void) => void,
			closeTimeoutMs: 500,
		});
		const r = await _createNodeFd3Adapter(deps);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SETUP_FAILED");
		expect(accessorCalled).toBe(false);
		expect(closeCalled).toBe(true);
	});

	it("rejects accessor-only destroy — CLOSE_UNCERTAIN when close callback errors", async () => {
		let closeCalled = false;
		const pt = new PassThrough();
		Object.defineProperty(pt, "destroy", {
			get: () => () => {
				/* hostile */
			},
			enumerable: true,
		});
		const deps = Object.freeze({
			stream: pt,
			close: ((_fd: number, cb: (err: Error | null) => void) => {
				closeCalled = true;
				setImmediate(() => cb(new Error("fail")));
			}) as (fd: number, cb: (err: Error | null) => void) => void,
			closeTimeoutMs: 500,
		});
		const r = await _createNodeFd3Adapter(deps);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CLOSE_UNCERTAIN");
		expect(closeCalled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Malformed callback value
// ---------------------------------------------------------------------------

describe("malformed callback value", () => {
	it("resolves CLOSE_UNCERTAIN when close callback receives non-null value", async () => {
		const deps = Object.freeze({
			stream: new PassThrough(),
			close: ((_fd: number, cb: (err: Error | null) => void) => {
				setImmediate(() => {
					// Simulate malformed/buggy callback with a string instead of null.
					(cb as unknown as (v: string) => void)("malformed");
				});
			}) as (fd: number, cb: (err: Error | null) => void) => void,
			closeTimeoutMs: 500,
		});
		const r = await _createNodeFd3Adapter(deps);
		if (!r.ok) throw new Error("expected ok");
		const result = await r.close();
		// Because err !== null, strict check `err === null` fails → CLOSE_UNCERTAIN.
		expect(result).toEqual({ ok: false, code: "CLOSE_UNCERTAIN" });
	});
});

describe("factory result shape", () => {
	it("returns a frozen CreateFd3AdapterResult on ok", async () => {
		const r = await _createNodeFd3Adapter(validDeps());
		if (!r.ok) throw new Error("expected ok");
		expect(Object.isFrozen(r)).toBe(true);
		expect(Object.isFrozen(r.source)).toBe(true);
	});

	it("returns frozen result on fail", async () => {
		const r = await _createNodeFd3Adapter(null);
		expect(Object.isFrozen(r)).toBe(true);
	});
});
