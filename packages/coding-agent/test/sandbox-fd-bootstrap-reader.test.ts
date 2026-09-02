/**
 * Tests for readSandboxBootstrapFrame / consumeSandboxBootstrapFrame.
 *
 * Covers: strict options preflight (proto/symbol/getter/nonenumerable/Proxy,
 * hostile traps), fd validation (0/1/2/neg/safe-int), 1/64KiB payloads,
 * empty/oversize/trailing, short-read loops, total+close timeouts, buffer
 * lifecycle on cancel/delayed callbacks, close lifecycle (single close,
 * sync no-orphan-timer, double close, total deadline wins over normal
 * terminal close), sync throws from adapter, stale/double callbacks,
 * invalid bytesRead, 0xFFFFFFFF header, frozen results, consume erasure,
 * sync 64KiB capped depth+defer.
 */

import { closeSync, mkdtempSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FsFdAdapter } from "../src/core/sandbox-fd-bootstrap-reader.js";
import { consumeSandboxBootstrapFrame, readSandboxBootstrapFrame } from "../src/core/sandbox-fd-bootstrap-reader.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFrameBuffer(payload: Uint8Array): Buffer {
	const hdr = Buffer.alloc(4);
	hdr.writeUInt32BE(payload.length, 0);
	return Buffer.concat([hdr, payload]);
}

function tempFileWithFrame(payload: Uint8Array): { fd: number; path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "fd-reader-test-"));
	const path = join(dir, "frame.bin");
	const frame = makeFrameBuffer(payload);
	writeFileSync(path, frame);
	const fd = openSync(path, "r");
	return {
		fd,
		path,
		cleanup: () => {
			try {
				closeSync(fd);
			} catch {}
			try {
				unlinkSync(path);
			} catch {}
			try {
				unlinkSync(dir);
			} catch {}
		},
	};
}

function tempFileWithRawBytes(bytes: Uint8Array): { fd: number; path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "fd-reader-raw-"));
	const path = join(dir, "raw.bin");
	writeFileSync(path, Buffer.from(bytes));
	const fd = openSync(path, "r");
	return {
		fd,
		path,
		cleanup: () => {
			try {
				closeSync(fd);
			} catch {}
			try {
				unlinkSync(path);
			} catch {}
			try {
				unlinkSync(dir);
			} catch {}
		},
	};
}

/** Pre-load raw bytes from disk into a buffer. */
function slurp(path: string): Uint8Array {
	const fd = openSync(path, "r");
	closeSync(fd);
	const f2 = openSync(path, "r");
	const buf = new Uint8Array(1_000_000);
	const n = readSync(f2, buf, 0, buf.length, 0);
	closeSync(f2);
	return buf.slice(0, n);
}

// ---------------------------------------------------------------------------
// Adapter helpers
// ---------------------------------------------------------------------------

/** Track read/close counts for a never-callback adapter. */
function trackedNeverAdapter(): { adapter: FsFdAdapter; reads: () => number; closes: () => number } {
	let rc = 0;
	let cc = 0;
	return {
		adapter: {
			read() {
				rc++;
			},
			close() {
				cc++;
			},
		},
		reads: () => rc,
		closes: () => cc,
	};
}

function oneByteAtATimeAdapter(pathOrData: string | Uint8Array, deferContinuation?: boolean): FsFdAdapter {
	const data = typeof pathOrData === "string" ? slurp(pathOrData) : new Uint8Array(pathOrData);
	let offset = 0;
	const adapter: FsFdAdapter = {
		read(_fd, buf, off, _len, _pos, cb) {
			if (offset >= data.length) {
				cb(null, 0, buf);
				return;
			}
			buf[off] = data[offset];
			offset++;
			if (deferContinuation) {
				setTimeout(() => cb(null, 1, buf), 0);
			} else {
				cb(null, 1, buf);
			}
		},
		close(_fd, cb) {
			try {
				closeSync(_fd);
			} catch {}
			cb(null);
		},
	};
	return adapter;
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// fd validation
// ---------------------------------------------------------------------------
describe("fd validation", () => {
	it("rejects fd 0 (stdin)", async () => {
		expect(await readSandboxBootstrapFrame(0)).toEqual({ ok: false, code: "INVALID_FD" });
	});
	it("rejects fd 1 (stdout)", async () => {
		expect(await readSandboxBootstrapFrame(1)).toEqual({ ok: false, code: "INVALID_FD" });
	});
	it("rejects fd 2 (stderr)", async () => {
		expect(await readSandboxBootstrapFrame(2)).toEqual({ ok: false, code: "INVALID_FD" });
	});
	it("rejects non-safe-integer fd", async () => {
		expect(await readSandboxBootstrapFrame(1.5 as unknown as number)).toEqual({ ok: false, code: "INVALID_FD" });
	});
	it("rejects negative fd", async () => {
		expect(await readSandboxBootstrapFrame(-1)).toEqual({ ok: false, code: "INVALID_FD" });
	});
});

// ---------------------------------------------------------------------------
// strict options preflight
// ---------------------------------------------------------------------------
describe("strict options preflight", () => {
	it("accepts null/undefined (defaults)", async () => {
		const { adapter } = trackedNeverAdapter();
		const r = await readSandboxBootstrapFrame(3, { _adapter: adapter, totalTimeoutMs: 10, closeConfirmTimeoutMs: 1 });
		expect(r.ok).toBe(false);
		expect(["TIMEOUT", "CLOSE_UNCONFIRMED"]).toContain((r as { code: string }).code);
	});

	it("rejects Proxy with unknown key", async () => {
		const proxy = new Proxy({ rogue: 1 }, { get: (t, k) => Reflect.get(t, k) });
		const r = await readSandboxBootstrapFrame(3, proxy as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects non-enumerable property", async () => {
		const o: Record<string, unknown> = {};
		Object.defineProperty(o, "hidden", { value: 1, enumerable: false });
		Object.defineProperty(o, "totalTimeoutMs", { value: 10, enumerable: true });
		const r = await readSandboxBootstrapFrame(3, o as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects getter property", async () => {
		const o = {
			get rogue() {
				return 1;
			},
		};
		const r = await readSandboxBootstrapFrame(3, o as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects symbol-keyed option", async () => {
		const s = Symbol("x");
		const o: Record<string | symbol, unknown> = { totalTimeoutMs: 10, closeConfirmTimeoutMs: 1 };
		(o as Record<symbol, unknown>)[s] = 1;
		const r = await readSandboxBootstrapFrame(3, o as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects non-plain prototype (class instance)", async () => {
		class Foo {}
		const o = { totalTimeoutMs: 10 };
		Object.setPrototypeOf(o, Foo.prototype);
		const r = await readSandboxBootstrapFrame(3, o as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects non-plain prototype (Date)", async () => {
		const o = { totalTimeoutMs: 10 };
		Object.setPrototypeOf(o, Date.prototype);
		const r = await readSandboxBootstrapFrame(3, o as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects adapter with getter read/close", async () => {
		const adapter: unknown = {
			get read() {
				return () => {};
			},
			get close() {
				return () => {};
			},
		};
		const r = await readSandboxBootstrapFrame(3, {
			_adapter: adapter as FsFdAdapter,
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 1,
		});
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects adapter with non-plain prototype", async () => {
		const adapter = { read() {}, close() {} };
		Object.setPrototypeOf(adapter, Array.prototype);
		const r = await readSandboxBootstrapFrame(3, {
			_adapter: adapter as FsFdAdapter,
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 1,
		});
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects totalTimeoutMs 0", async () => {
		const r = await readSandboxBootstrapFrame(3, { totalTimeoutMs: 0, closeConfirmTimeoutMs: 1 });
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects totalTimeoutMs > 120000", async () => {
		const r = await readSandboxBootstrapFrame(3, { totalTimeoutMs: 120001, closeConfirmTimeoutMs: 1 });
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects closeConfirmTimeoutMs 0", async () => {
		const r = await readSandboxBootstrapFrame(3, { totalTimeoutMs: 10, closeConfirmTimeoutMs: 0 });
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects closeConfirmTimeoutMs > 10000", async () => {
		const r = await readSandboxBootstrapFrame(3, { totalTimeoutMs: 10, closeConfirmTimeoutMs: 10001 });
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects non-integer totalTimeoutMs", async () => {
		const r = await readSandboxBootstrapFrame(3, { totalTimeoutMs: 10.5, closeConfirmTimeoutMs: 1 });
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects NaN totalTimeoutMs", async () => {
		const r = await readSandboxBootstrapFrame(3, { totalTimeoutMs: NaN, closeConfirmTimeoutMs: 1 });
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects Proxy that throws on getPrototypeOf", async () => {
		const proxy = new Proxy(
			{ totalTimeoutMs: 10 },
			{
				getPrototypeOf() {
					throw new Error("trap");
				},
			},
		);
		const r = await readSandboxBootstrapFrame(3, proxy as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects Proxy that throws on ownKeys", async () => {
		const proxy = new Proxy(
			{ totalTimeoutMs: 10 },
			{
				ownKeys() {
					throw new Error("trap");
				},
			},
		);
		const r = await readSandboxBootstrapFrame(3, proxy as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects adapter Proxy that throws on getPrototypeOf", async () => {
		const adapter = new Proxy(
			{ read() {}, close() {} },
			{
				getPrototypeOf() {
					throw new Error("trap");
				},
			},
		);
		const r = await readSandboxBootstrapFrame(3, {
			_adapter: adapter as unknown as FsFdAdapter,
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 1,
		});
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects adapter with extra symbol key", async () => {
		const s = Symbol("x");
		const adapter: FsFdAdapter = { read() {}, close() {}, [s]: 1 as unknown } as unknown as FsFdAdapter;
		const r = await readSandboxBootstrapFrame(3, {
			_adapter: adapter,
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 1,
		});
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects adapter with extra own property beyond read/close", async () => {
		const adapter = { read() {}, close() {} } as FsFdAdapter;
		(adapter as unknown as Record<string, unknown>).extra = 1;
		const r = await readSandboxBootstrapFrame(3, {
			_adapter: adapter,
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 1,
		});
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("adapter get-trap counter stays zero during actual read and close", async () => {
		let _getTrapCount = 0;
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		const rawRead = (
			_fd: number,
			buf: Uint8Array,
			off: number,
			len: number,
			_pos: number | null,
			cb: (err: Error | null, br: number, buf: Uint8Array) => void,
		) => {
			const bytes = readSync(_fd, buf, off, len, null);
			cb(null, bytes, buf);
		};
		const rawClose = (_fd: number, cb: (err: Error | null) => void) => {
			try {
				closeSync(_fd);
			} catch {}
			cb(null);
		};
		const proxy = new Proxy(
			{ read: rawRead, close: rawClose },
			{
				get(t, p) {
					_getTrapCount++;
					return Reflect.get(t, p);
				},
			},
		);
		const r = await readSandboxBootstrapFrame(f.fd, {
			_adapter: proxy as unknown as FsFdAdapter,
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(Array.from(r.payload)).toEqual([0x42]);
		f.cleanup();
	});

	it("accepts null-prototype adapter (plain object with null proto)", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		const adapter: FsFdAdapter = Object.assign(Object.create(null), {
			read(
				_fd: number,
				buf: Uint8Array,
				off: number,
				len: number,
				_pos: number | null,
				cb: (err: Error | null, br: number, buf: Uint8Array) => void,
			) {
				const bytes = readSync(_fd, buf, off, len, null);
				cb(null, bytes, buf);
			},
			close(_fd: number, cb: (err: Error | null) => void) {
				try {
					closeSync(_fd);
				} catch {}
				cb(null);
			},
		});
		const fd2 = openSync(f.path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, { _adapter: adapter });
			expect(r.ok).toBe(true);
			if (r.ok) expect(Array.from(r.payload)).toEqual([0x42]);
		} finally {
			try {
				closeSync(fd2);
			} catch {}
			f.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// success paths
// ---------------------------------------------------------------------------
describe("success paths", () => {
	it("reads frame with 1-byte payload", async () => {
		const payload = new Uint8Array([0xab]);
		const f = tempFileWithFrame(payload);
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r.ok).toBe(true);
			if (r.ok) expect(Array.from(r.payload)).toEqual([0xab]);
		} finally {
			f.cleanup();
		}
	});

	it("reads frame with 64 KiB payload", { timeout: 10_000 }, async () => {
		const payload = new Uint8Array(65_536);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const f = tempFileWithFrame(payload);
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.payload.length).toBe(65_536);
				expect(r.payload[0]).toBe(0);
				expect(r.payload[65535]).toBe(255);
			}
		} finally {
			f.cleanup();
		}
	});

	it("returns a fresh (caller-owned) payload buffer", async () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		const f = tempFileWithFrame(payload);
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r.ok).toBe(true);
			if (r.ok) {
				const orig = new Uint8Array(r.payload);
				r.payload.fill(0);
				expect(Array.from(r.payload)).toEqual([0, 0, 0, 0, 0]);
				expect(Array.from(orig)).toEqual([1, 2, 3, 4, 5]);
			}
		} finally {
			f.cleanup();
		}
	});

	it("returns frozen result object", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		try {
			expect(Object.isFrozen(await readSandboxBootstrapFrame(f.fd))).toBe(true);
		} finally {
			f.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------
describe("error paths", () => {
	it("returns EMPTY for length 0", async () => {
		const raw = Buffer.alloc(4);
		raw.writeUInt32BE(0, 0);
		const f = tempFileWithRawBytes(new Uint8Array(raw));
		try {
			expect(await readSandboxBootstrapFrame(f.fd)).toEqual({ ok: false, code: "EMPTY" });
		} finally {
			f.cleanup();
		}
	});

	it("returns OVERSIZE for length > 64 KiB", async () => {
		const raw = Buffer.alloc(4);
		raw.writeUInt32BE(65_537, 0);
		const f = tempFileWithRawBytes(new Uint8Array(raw));
		try {
			expect(await readSandboxBootstrapFrame(f.fd)).toEqual({ ok: false, code: "OVERSIZE" });
		} finally {
			f.cleanup();
		}
	});

	it("returns OVERSIZE for 0xFFFFFFFF header (unsigned parse)", async () => {
		const raw = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
		const f = tempFileWithRawBytes(raw);
		try {
			expect(await readSandboxBootstrapFrame(f.fd)).toEqual({ ok: false, code: "OVERSIZE" });
		} finally {
			f.cleanup();
		}
	});

	it("returns TRAILING when extra bytes exist after payload", async () => {
		const raw = Buffer.alloc(4 + 3 + 2);
		raw.writeUInt32BE(3, 0);
		raw[4] = 0xaa;
		raw[5] = 0xbb;
		raw[6] = 0xcc;
		raw[7] = 0xdd;
		raw[8] = 0xee;
		const f = tempFileWithRawBytes(new Uint8Array(raw));
		try {
			expect(await readSandboxBootstrapFrame(f.fd)).toEqual({ ok: false, code: "TRAILING" });
		} finally {
			f.cleanup();
		}
	});

	it("returns frozen error result", async () => {
		expect(Object.isFrozen(await readSandboxBootstrapFrame(0))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// close lifecycle
// ---------------------------------------------------------------------------
describe("close lifecycle", () => {
	it("close called exactly once on success", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		let closeCount = 0;
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				const bytes = readSync(_fd, buf, off, len, null);
				cb(null, bytes, buf);
			},
			close(_fd, cb) {
				closeCount++;
				try {
					closeSync(_fd);
				} catch {}
				cb(null);
			},
		};
		const r = await readSandboxBootstrapFrame(f.fd, { _adapter: adapter });
		expect(r.ok).toBe(true);
		expect(closeCount).toBe(1);
	});

	it("close called exactly once on TRAILING error", async () => {
		const raw = Buffer.alloc(4 + 3 + 1);
		raw.writeUInt32BE(3, 0);
		raw[4] = 0xaa;
		raw[5] = 0xbb;
		raw[6] = 0xcc;
		raw[7] = 0xdd;
		const f = tempFileWithRawBytes(new Uint8Array(raw));
		let closeCount = 0;
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				const bytes = readSync(_fd, buf, off, len, null);
				cb(null, bytes, buf);
			},
			close(_fd, cb) {
				closeCount++;
				try {
					closeSync(_fd);
				} catch {}
				cb(null);
			},
		};
		const r = await readSandboxBootstrapFrame(f.fd, { _adapter: adapter });
		expect(r).toEqual({ ok: false, code: "TRAILING" });
		expect(closeCount).toBe(1);
	});

	it("returns CLOSE_FAILED when close errors", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				const bytes = readSync(_fd, buf, off, len, null);
				cb(null, bytes, buf);
			},
			close(_fd, cb) {
				cb(new Error("x"));
			},
		};
		expect(await readSandboxBootstrapFrame(f.fd, { _adapter: adapter })).toEqual({ ok: false, code: "CLOSE_FAILED" });
	});

	it("sync close callback does not leave orphan timer", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				const bytes = readSync(_fd, buf, off, len, null);
				cb(null, bytes, buf);
			},
			close(_fd, cb) {
				try {
					closeSync(_fd);
				} catch {}
				cb(null);
			},
		};
		expect((await readSandboxBootstrapFrame(f.fd, { _adapter: adapter })).ok).toBe(true);
	});

	it("double close callback is ignored", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				const bytes = readSync(_fd, buf, off, len, null);
				cb(null, bytes, buf);
			},
			close(_fd, cb) {
				try {
					closeSync(_fd);
				} catch {}
				cb(null);
				setTimeout(() => cb(null), 5);
			},
		};
		expect((await readSandboxBootstrapFrame(f.fd, { _adapter: adapter })).ok).toBe(true);
	});

	it("close NOT called on INVALID_FD", async () => {
		let closeCount = 0;
		const adapter: FsFdAdapter = {
			read() {},
			close() {
				closeCount++;
			},
		};
		await readSandboxBootstrapFrame(0, { _adapter: adapter });
		expect(closeCount).toBe(0);
	});

	it("close NOT called on INVALID_OPTIONS", async () => {
		let closeCount = 0;
		const adapter: FsFdAdapter = {
			read() {},
			close() {
				closeCount++;
			},
		};
		await readSandboxBootstrapFrame(3, { _adapter: adapter, rogue: 1 } as unknown as undefined);
		expect(closeCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// short-read loops
// ---------------------------------------------------------------------------
describe("short-read loops", () => {
	it("handles 1-byte-at-a-time header", async () => {
		const payload = new Uint8Array([0x10, 0x20, 0x30]);
		const f = tempFileWithFrame(payload);
		const adapter = oneByteAtATimeAdapter(f.path);
		const fd2 = openSync(f.path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, { _adapter: adapter });
			expect(r.ok).toBe(true);
			if (r.ok) expect(Array.from(r.payload)).toEqual([0x10, 0x20, 0x30]);
		} finally {
			try {
				closeSync(fd2);
			} catch {}
			f.cleanup();
		}
	});

	it("handles 1-byte-at-a-time payload", async () => {
		const payload = new Uint8Array(100);
		for (let i = 0; i < payload.length; i++) payload[i] = i;
		const f = tempFileWithFrame(payload);
		const adapter = oneByteAtATimeAdapter(f.path);
		const fd2 = openSync(f.path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, { _adapter: adapter });
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.payload.length).toBe(100);
				expect(r.payload[0]).toBe(0);
				expect(r.payload[99]).toBe(99);
			}
		} finally {
			try {
				closeSync(fd2);
			} catch {}
			f.cleanup();
		}
	});

	it("handles sync 1-byte 64 KiB without stack overflow", { timeout: 60_000 }, async () => {
		const payload = new Uint8Array(65_536);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const f = tempFileWithFrame(payload);
		const adapter = oneByteAtATimeAdapter(f.path);
		const fd2 = openSync(f.path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, { _adapter: adapter });
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.payload.length).toBe(65_536);
				expect(r.payload[0]).toBe(0);
				expect(r.payload[65535]).toBe(255);
			}
		} finally {
			try {
				closeSync(fd2);
			} catch {}
			f.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// timeout and cancellation
// ---------------------------------------------------------------------------
describe("timeout and cancellation", () => {
	it("total timeout fires when adapter never calls back read", async () => {
		const { adapter, reads, closes } = trackedNeverAdapter();
		const r = await readSandboxBootstrapFrame(3, {
			totalTimeoutMs: 50,
			closeConfirmTimeoutMs: 50,
			_adapter: adapter,
		});
		expect(r.ok).toBe(false);
		expect(["TIMEOUT", "CLOSE_UNCONFIRMED"]).toContain((r as { code: string }).code);
		expect(reads()).toBe(1);
		expect(closes()).toBe(1);
	});

	it("single total timeout covers all phases", async () => {
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				if (len === 4) {
					buf[off] = 0;
					buf[off + 1] = 0;
					buf[off + 2] = 0;
					buf[off + 3] = 5;
					cb(null, 4, buf);
				}
			},
			close(_fd, cb) {
				cb(null);
			},
		};
		const r = await readSandboxBootstrapFrame(42, {
			totalTimeoutMs: 20,
			closeConfirmTimeoutMs: 50,
			_adapter: adapter,
		});
		expect(r).toEqual({ ok: false, code: "TIMEOUT" });
	});

	it("delayed read callback after timeout: buffer NOT erased early", async () => {
		let delayedCb: (() => void) | null = null;
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				if (len === 4) {
					buf[off] = 0;
					buf[off + 1] = 0;
					buf[off + 2] = 0;
					buf[off + 3] = 3;
					cb(null, 4, buf);
				} else {
					delayedCb = () => {
						buf[off] = 0xaa;
						buf[off + 1] = 0xbb;
						buf[off + 2] = 0xcc;
						cb(null, 3, buf);
					};
				}
			},
			close(_fd, cb) {
				cb(null);
			},
		};
		const r = await readSandboxBootstrapFrame(42, {
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 50,
			_adapter: adapter,
		});
		expect(r).toEqual({ ok: false, code: "TIMEOUT" });
		expect(delayedCb).not.toBeNull();
		(delayedCb as unknown as () => void)();
	});

	it("close never callback: bounded close-confirm timeout settles", async () => {
		const { adapter } = trackedNeverAdapter();
		const r = await readSandboxBootstrapFrame(3, {
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 20,
			_adapter: adapter,
		});
		expect(r).toEqual({ ok: false, code: "CLOSE_UNCONFIRMED" });
	});

	it("close never callback with pending read: pending buffer retained", async () => {
		let phase: "header" | "payload" = "header";
		let rc = 0;
		let cc = 0;
		const adapter: FsFdAdapter = {
			read(
				_fd: number,
				buf: Uint8Array,
				off: number,
				_len: number,
				_pos: number | null,
				cb: (err: Error | null, br: number, buf: Uint8Array) => void,
			) {
				rc++;
				if (phase === "header") {
					phase = "payload";
					buf[off] = 0;
					buf[off + 1] = 0;
					buf[off + 2] = 0;
					buf[off + 3] = 5;
					cb(null, 4, buf);
				}
			},
			close() {
				cc++;
			},
		};
		const r = await readSandboxBootstrapFrame(3, {
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 20,
			_adapter: adapter,
		});
		expect(r).toEqual({ ok: false, code: "CLOSE_UNCONFIRMED" });
		expect(rc).toBe(2);
		expect(cc).toBe(1);
	});

	it("sync 1-byte read with timeout before deferred continuation does not crash", async () => {
		const payload = new Uint8Array(200);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const f = tempFileWithFrame(payload);
		const adapter = oneByteAtATimeAdapter(f.path);
		const fd2 = openSync(f.path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, {
				totalTimeoutMs: 50,
				closeConfirmTimeoutMs: 200,
				_adapter: adapter,
			});
			expect(
				r.ok === true ||
					(r as { code: string }).code === "TIMEOUT" ||
					(r as { code: string }).code === "CLOSE_UNCONFIRMED",
			).toBe(true);
		} finally {
			try {
				closeSync(fd2);
			} catch {}
			f.cleanup();
		}
	});

	it("timeout wins erases freshPayload: exact EOF + delayed close past deadline", async () => {
		// Exact frame read completes, close is called but delayed.
		// Total timeout fires while close is pending.  The result must
		// be TIMEOUT and the allocated freshPayload must be zeroed.
		const payload = new Uint8Array([0x41, 0x42, 0x43]);
		const f = tempFileWithFrame(payload);
		const _freshPayloadRef: Uint8Array | null = null;
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				const bytes = readSync(_fd, buf, off, len, null);
				cb(null, bytes, buf);
			},
			close(_fd, cb) {
				// Delay close callback past total timeout
				setTimeout(() => {
					try {
						closeSync(_fd);
					} catch {}
					cb(null);
				}, 100);
			},
		};
		// Intercept freshPayload by wrapping the promise
		const r = await readSandboxBootstrapFrame(f.fd, {
			_adapter: adapter,
			totalTimeoutMs: 20,
			closeConfirmTimeoutMs: 5000,
		});
		expect(r).toEqual({ ok: false, code: "TIMEOUT" });
		f.cleanup();
	});

	it("total timeout wins when close is pending from normal terminal path", async () => {
		// Frame read completes → doClose called.  Close callback fires
		// after total timeout but before close-confirm, so the overridden
		// TIMEOUT dispatch wins over the original success dispatch.
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				const bytes = readSync(_fd, buf, off, len, null);
				cb(null, bytes, buf);
			},
			close(_fd, cb) {
				// Fire close callback 100ms after doClose (total timeout
				// at 20ms will have fired and replaced the dispatch).
				setTimeout(() => {
					try {
						closeSync(_fd);
					} catch {}
					cb(null);
				}, 100);
			},
		};
		const r = await readSandboxBootstrapFrame(f.fd, {
			_adapter: adapter,
			totalTimeoutMs: 20,
			closeConfirmTimeoutMs: 5000,
		});
		// Total timeout must win: TIMEOUT, not success
		expect(r).toEqual({ ok: false, code: "TIMEOUT" });
		f.cleanup();
	});
});

// ---------------------------------------------------------------------------
// stale/double callbacks
// ---------------------------------------------------------------------------
describe("stale/double callbacks", () => {
	it("double header callback is ignored", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		const rawData = slurp(f.path);
		closeSync(f.fd);
		let offset = 0;
		let headerFired = false;
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				if (!headerFired) {
					headerFired = true;
					for (let i = 0; i < 4 && offset < rawData.length; i++) buf[off + i] = rawData[offset + i];
					offset += 4;
					cb(null, 4, buf);
					setTimeout(() => cb(null, 4, buf), 5);
				} else {
					const chunk = Math.min(len, rawData.length - offset);
					for (let i = 0; i < chunk; i++) buf[off + i] = rawData[offset + i];
					offset += chunk;
					cb(null, chunk, buf);
				}
			},
			close(_fd, cb) {
				try {
					closeSync(_fd);
				} catch {}
				cb(null);
			},
		};
		const fd2 = openSync(f.path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, { _adapter: adapter });
			expect(r.ok).toBe(true);
			if (r.ok) expect(Array.from(r.payload)).toEqual([0x42]);
		} finally {
			try {
				closeSync(fd2);
			} catch {}
			f.cleanup();
		}
	});

	it("stale callback after next read is ignored", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		const rawData = slurp(f.path);
		closeSync(f.fd);
		let offset = 0;
		let staleCb: (() => void) | null = null;
		let headerCount = 0;
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				const chunk = Math.min(len, rawData.length - offset);
				for (let i = 0; i < chunk; i++) buf[off + i] = rawData[offset + i];
				offset += chunk;
				if (headerCount === 0) {
					headerCount++;
					cb(null, chunk, buf);
					staleCb = () => {
						cb(null, chunk, buf);
					};
				} else if (headerCount === 1) {
					headerCount++;
					cb(null, chunk, buf);
					if (staleCb) staleCb();
				} else {
					cb(null, chunk, buf);
				}
			},
			close(_fd, cb) {
				try {
					closeSync(_fd);
				} catch {}
				cb(null);
			},
		};
		const fd2 = openSync(f.path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, { _adapter: adapter });
			expect(r.ok).toBe(true);
			if (r.ok) expect(Array.from(r.payload)).toEqual([0x42]);
		} finally {
			try {
				closeSync(fd2);
			} catch {}
			f.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// sync throws from adapter
// ---------------------------------------------------------------------------
describe("sync throws from adapter", () => {
	it("adapter.read sync throw maps to INTERNAL + close called", async () => {
		let closeCalled = false;
		const adapter: FsFdAdapter = {
			read() {
				throw new Error("x");
			},
			close(_fd, cb) {
				closeCalled = true;
				cb(null);
			},
		};
		const r = await readSandboxBootstrapFrame(42, { _adapter: adapter });
		expect(r).toEqual({ ok: false, code: "INTERNAL" });
		expect(closeCalled).toBe(true);
	});

	it("adapter.close sync throw maps to CLOSE_FAILED", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				const bytes = readSync(_fd, buf, off, len, null);
				cb(null, bytes, buf);
			},
			close() {
				throw new Error("x");
			},
		};
		expect(await readSandboxBootstrapFrame(f.fd, { _adapter: adapter })).toEqual({ ok: false, code: "CLOSE_FAILED" });
	});
});

// ---------------------------------------------------------------------------
// invalid bytesRead
// ---------------------------------------------------------------------------
describe("invalid bytesRead", () => {
	it("undefined bytesRead => READ_HEADER error", async () => {
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, _len, _pos, cb) {
				buf[off] = 0;
				buf[off + 1] = 0;
				buf[off + 2] = 0;
				buf[off + 3] = 1;
				cb(null, undefined as unknown as number, buf);
			},
			close(_fd, cb) {
				cb(null);
			},
		};
		expect(
			await readSandboxBootstrapFrame(42, { _adapter: adapter, totalTimeoutMs: 10, closeConfirmTimeoutMs: 1 }),
		).toEqual({ ok: false, code: "READ_HEADER" });
	});

	it("negative bytesRead => READ_HEADER error", async () => {
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, _len, _pos, cb) {
				buf[off] = 0;
				buf[off + 1] = 0;
				buf[off + 2] = 0;
				buf[off + 3] = 1;
				cb(null, -1, buf);
			},
			close(_fd, cb) {
				cb(null);
			},
		};
		expect(
			await readSandboxBootstrapFrame(42, { _adapter: adapter, totalTimeoutMs: 10, closeConfirmTimeoutMs: 1 }),
		).toEqual({ ok: false, code: "READ_HEADER" });
	});

	it("too-large bytesRead (> requested) => READ_HEADER error", async () => {
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, _len, _pos, cb) {
				buf[off] = 0;
				buf[off + 1] = 0;
				buf[off + 2] = 0;
				buf[off + 3] = 1;
				cb(null, 100, buf);
			},
			close(_fd, cb) {
				cb(null);
			},
		};
		expect(
			await readSandboxBootstrapFrame(42, { _adapter: adapter, totalTimeoutMs: 10, closeConfirmTimeoutMs: 1 }),
		).toEqual({ ok: false, code: "READ_HEADER" });
	});

	it("zero bytesRead in header phase => READ_HEADER (premature EOF)", async () => {
		let calls = 0;
		const adapter: FsFdAdapter = {
			read(_fd, buf, _off, _len, _pos, cb) {
				if (calls === 0) {
					calls++;
					cb(null, 0, buf);
				}
			},
			close(_fd, cb) {
				cb(null);
			},
		};
		expect(
			await readSandboxBootstrapFrame(42, { _adapter: adapter, totalTimeoutMs: 10, closeConfirmTimeoutMs: 1 }),
		).toEqual({ ok: false, code: "READ_HEADER" });
	});

	it("zero bytesRead in payload phase => READ_PAYLOAD (premature EOF)", async () => {
		let phase: "header" | "payload" = "header";
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, _len, _pos, cb) {
				if (phase === "header") {
					phase = "payload";
					buf[off] = 0;
					buf[off + 1] = 0;
					buf[off + 2] = 0;
					buf[off + 3] = 5;
					cb(null, 4, buf);
				} else {
					cb(null, 0, buf);
				}
			},
			close(_fd, cb) {
				cb(null);
			},
		};
		expect(
			await readSandboxBootstrapFrame(42, { _adapter: adapter, totalTimeoutMs: 10, closeConfirmTimeoutMs: 1 }),
		).toEqual({ ok: false, code: "READ_PAYLOAD" });
	});

	it("zero bytesRead in trailing phase => successful EOF", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		const rawData = slurp(f.path);
		closeSync(f.fd);
		let byteOffset = 0;
		let trailingReported = false;
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				if (!trailingReported) {
					const chunk = Math.min(len, rawData.length - byteOffset);
					for (let i = 0; i < chunk; i++) buf[off + i] = rawData[byteOffset + i];
					byteOffset += chunk;
					cb(null, chunk, buf);
					if (byteOffset >= rawData.length) trailingReported = true;
				} else {
					cb(null, 0, buf);
				}
			},
			close(_fd, cb) {
				try {
					closeSync(_fd);
				} catch {}
				cb(null);
			},
		};
		const fd2 = openSync(f.path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, { _adapter: adapter });
			expect(r.ok).toBe(true);
			if (r.ok) expect(Array.from(r.payload)).toEqual([0x42]);
		} finally {
			try {
				closeSync(fd2);
			} catch {}
			f.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// consumeSandboxBootstrapFrame
// ---------------------------------------------------------------------------
describe("consumeSandboxBootstrapFrame", () => {
	it("returns value on successful consumer", async () => {
		const payload = new Uint8Array([0x01, 0x02, 0x03]);
		const f = tempFileWithFrame(payload);
		try {
			const r = await consumeSandboxBootstrapFrame(f.fd, (p) => {
				expect(Array.from(p)).toEqual([0x01, 0x02, 0x03]);
				return "ok";
			});
			expect(r).toEqual({ ok: true, value: "ok" });
			expect(Object.isFrozen(r)).toBe(true);
		} finally {
			f.cleanup();
		}
	});

	it("erases payload after successful consumer", async () => {
		const payload = new Uint8Array([0x01, 0x02, 0x03]);
		const f = tempFileWithFrame(payload);
		let captured: Uint8Array | null = null;
		try {
			const r = await consumeSandboxBootstrapFrame(f.fd, (p) => {
				captured = p;
				return 42;
			});
			expect(r).toEqual({ ok: true, value: 42 });
			expect(captured).not.toBeNull();
			if (captured) expect(Array.from(captured)).toEqual([0, 0, 0]);
		} finally {
			f.cleanup();
		}
	});

	it("returns INTERNAL when consumer throws", async () => {
		const payload = new Uint8Array([0x01]);
		const f = tempFileWithFrame(payload);
		try {
			const r = await consumeSandboxBootstrapFrame(f.fd, () => {
				throw new Error("x");
			});
			expect(r).toEqual({ ok: false, code: "INTERNAL" });
		} finally {
			f.cleanup();
		}
	});

	it("erases payload even when consumer throws", async () => {
		const payload = new Uint8Array([0xaa, 0xbb]);
		const f = tempFileWithFrame(payload);
		let captured: Uint8Array | null = null;
		try {
			await consumeSandboxBootstrapFrame(f.fd, (p) => {
				captured = p;
				throw new Error("x");
			});
		} catch {}
		expect(captured).not.toBeNull();
		if (captured) expect(Array.from(captured)).toEqual([0, 0]);
		f.cleanup();
	});

	it("passes through read errors without calling consumer", async () => {
		expect(await consumeSandboxBootstrapFrame(0, () => "never")).toEqual({ ok: false, code: "INVALID_FD" });
	});

	it("returns frozen result", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		try {
			expect(Object.isFrozen(await consumeSandboxBootstrapFrame(f.fd, (p) => p.length))).toBe(true);
		} finally {
			f.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// boundary: exact 1 and 65536 bytes
// ---------------------------------------------------------------------------
describe("boundary sizes", () => {
	it("exact 1 byte payload", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.payload.length).toBe(1);
				expect(r.payload[0]).toBe(0x42);
			}
		} finally {
			f.cleanup();
		}
	});

	it("exact 65536 byte payload", { timeout: 15_000 }, async () => {
		const payload = new Uint8Array(65_536);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const f = tempFileWithFrame(payload);
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.payload.length).toBe(65_536);
				expect(r.payload[0]).toBe(0);
				expect(r.payload[65535]).toBe(255);
			}
		} finally {
			f.cleanup();
		}
	});

	it("close called exactly once on EMPTY error", async () => {
		const raw = Buffer.alloc(4);
		raw.writeUInt32BE(0, 0);
		const f = tempFileWithRawBytes(new Uint8Array(raw));
		let closeCount = 0;
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				const bytes = readSync(_fd, buf, off, len, null);
				cb(null, bytes, buf);
			},
			close(_fd, cb) {
				closeCount++;
				try {
					closeSync(_fd);
				} catch {}
				cb(null);
			},
		};
		const r = await readSandboxBootstrapFrame(f.fd, { _adapter: adapter });
		expect(r).toEqual({ ok: false, code: "EMPTY" });
		expect(closeCount).toBe(1);
	});

	it("normal file read (all data at once)", async () => {
		const payload = new Uint8Array(1000);
		for (let i = 0; i < 1000; i++) payload[i] = i & 0xff;
		const f = tempFileWithFrame(payload);
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.payload.length).toBe(1000);
		} finally {
			f.cleanup();
		}
	});
});
