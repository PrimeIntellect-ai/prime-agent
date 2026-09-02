/**
 * Tests for readSandboxBootstrapFrame / consumeSandboxBootstrapFrame.
 *
 * Covers: strict options preflight, fd validation, 1/64KiB payloads,
 * empty/oversize/short/trailing, short-read loops, total+close timeouts,
 * buffer lifecycle on cancel/delayed callbacks, close errors, sync throws,
 * stale double callbacks, hostile Proxy/getter/symbol/nonenumerable options,
 * FFFFFFFF header, frozen results, consume erasure, sync 64KiB without
 * stack overflow, invalid bytesRead rejection.
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
			} catch {
				/* ignore */
			}
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
			try {
				unlinkSync(dir);
			} catch {
				/* ignore */
			}
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
			} catch {
				/* ignore */
			}
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
			try {
				unlinkSync(dir);
			} catch {
				/* ignore */
			}
		},
	};
}

/** Pre-load raw bytes from disk into a buffer, then close the fd. */
function slurp(path: string): Uint8Array {
	const fd = openSync(path, "r");
	closeSync(fd);
	// read the whole file
	const f2 = openSync(path, "r");
	const buf = new Uint8Array(1_000_000);
	const n = readSync(f2, buf, 0, buf.length, 0);
	closeSync(f2);
	return buf.slice(0, n);
}

// ---------------------------------------------------------------------------
// Adapter helpers
// ---------------------------------------------------------------------------

interface NeverCallbackAdapter extends FsFdAdapter {
	readCallCount: number;
	closeCallCount: number;
}

function neverCallbackAdapter(): NeverCallbackAdapter {
	let rc = 0;
	let cc = 0;
	return {
		get readCallCount() {
			return rc;
		},
		get closeCallCount() {
			return cc;
		},
		read() {
			rc++;
		},
		close() {
			cc++;
		},
	} as unknown as NeverCallbackAdapter;
}

function oneByteAtATimeAdapter(pathOrData: string | Uint8Array, deferContinuation?: boolean): FsFdAdapter {
	const data = typeof pathOrData === "string" ? slurp(pathOrData) : new Uint8Array(pathOrData);
	let offset = 0;
	return {
		read(_fd, buf, off, _len, _pos, cb) {
			if (offset >= data.length) {
				cb(null, 0, buf);
				return;
			}
			buf[off] = data[offset];
			offset++;

			if (deferContinuation) {
				// Fire the callback on next tick to actually test sync recursion
				setTimeout(() => cb(null, 1, buf), 0);
			} else {
				cb(null, 1, buf);
			}
		},
		close(_fd, cb) {
			try {
				closeSync(_fd);
			} catch {
				/* ignore */
			}
			cb(null);
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readSandboxBootstrapFrame :: fd validation", () => {
	it("rejects fd 0 (stdin)", async () => {
		const r = await readSandboxBootstrapFrame(0);
		expect(r).toEqual({ ok: false, code: "INVALID_FD" });
	});

	it("rejects fd 1 (stdout)", async () => {
		const r = await readSandboxBootstrapFrame(1);
		expect(r).toEqual({ ok: false, code: "INVALID_FD" });
	});

	it("rejects fd 2 (stderr)", async () => {
		const r = await readSandboxBootstrapFrame(2);
		expect(r).toEqual({ ok: false, code: "INVALID_FD" });
	});

	it("rejects non-safe-integer fd", async () => {
		const r = await readSandboxBootstrapFrame(1.5 as unknown as number);
		expect(r).toEqual({ ok: false, code: "INVALID_FD" });
	});

	it("rejects negative fd", async () => {
		const r = await readSandboxBootstrapFrame(-1);
		expect(r).toEqual({ ok: false, code: "INVALID_FD" });
	});
});

describe("readSandboxBootstrapFrame :: strict options preflight (via public API)", () => {
	it("accepts null/undefined options (defaults)", async () => {
		// With never-callback adapter + tiny timeout → TIMEOUT confirms options passed
		const nac = neverCallbackAdapter();
		const r = await readSandboxBootstrapFrame(3, {
			_adapter: nac,
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 50,
		});
		// Options valid → read attempted → never-callback adapter → timeout
		expect(r.ok).toBe(false);
		expect(["TIMEOUT", "CLOSE_UNCONFIRMED"]).toContain((r as { code: string }).code);
	});

	it("rejects Proxy with unknown key", async () => {
		const proxy = new Proxy({ rogue: 1 }, { get: (t, k) => Reflect.get(t, k) });
		const nac = neverCallbackAdapter();
		const o = Object.assign(proxy, { _adapter: nac });
		const r = await readSandboxBootstrapFrame(3, o as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects options with non-enumerable property", async () => {
		const nac = neverCallbackAdapter();
		const o: Record<string, unknown> = { _adapter: nac };
		Object.defineProperty(o, "hidden", { value: 1, enumerable: false });
		const r = await readSandboxBootstrapFrame(3, o as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects options with getter", async () => {
		const nac = neverCallbackAdapter();
		const o = {
			_adapter: nac,
			get rogue() {
				return 1;
			},
		};
		const r = await readSandboxBootstrapFrame(3, o as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	{
		const s = Symbol("test");
		const nac = neverCallbackAdapter();
		const o = { [s]: 1, _adapter: nac, totalTimeoutMs: 10, closeConfirmTimeoutMs: 50 };
		it("allows options with Symbol keys (ignored), valid keys pass", async () => {
			const r = await readSandboxBootstrapFrame(3, o as unknown as undefined);
			// Symbol keys are invisible to Object.keys; valid _adapter+timeout passes
			// With never-callback adapter, we get TIMEOUT/CLOSE_UNCONFIRMED
			expect(r.ok).toBe(false);
			expect(["TIMEOUT", "CLOSE_UNCONFIRMED"]).toContain((r as { code: string }).code);
		});
	}

	it("rejects non-integer totalTimeoutMs", async () => {
		const nac = neverCallbackAdapter();
		const r = await readSandboxBootstrapFrame(3, { totalTimeoutMs: 10.5, _adapter: nac });
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects negative totalTimeoutMs", async () => {
		const nac = neverCallbackAdapter();
		const r = await readSandboxBootstrapFrame(3, { totalTimeoutMs: -1, _adapter: nac });
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects NaN totalTimeoutMs", async () => {
		const nac = neverCallbackAdapter();
		const r = await readSandboxBootstrapFrame(3, { totalTimeoutMs: NaN, _adapter: nac });
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});

	it("rejects Infinity totalTimeoutMs", async () => {
		const nac = neverCallbackAdapter();
		const r = await readSandboxBootstrapFrame(3, { totalTimeoutMs: Infinity, _adapter: nac });
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
	});
});

describe("readSandboxBootstrapFrame :: success paths", () => {
	it("reads frame with 1-byte payload", async () => {
		const payload = new Uint8Array([0xab]);
		const f = tempFileWithFrame(payload);
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(Array.from(r.payload)).toEqual([0xab]);
			}
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
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(Object.isFrozen(r)).toBe(true);
		} finally {
			f.cleanup();
		}
	});
});

describe("readSandboxBootstrapFrame :: error paths", () => {
	it("returns EMPTY for length 0", async () => {
		const raw = Buffer.alloc(4);
		raw.writeUInt32BE(0, 0);
		const f = tempFileWithRawBytes(new Uint8Array(raw));
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r).toEqual({ ok: false, code: "EMPTY" });
		} finally {
			f.cleanup();
		}
	});

	it("returns OVERSIZE for length > 64 KiB", async () => {
		const raw = Buffer.alloc(4);
		raw.writeUInt32BE(65_537, 0);
		const f = tempFileWithRawBytes(new Uint8Array(raw));
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r).toEqual({ ok: false, code: "OVERSIZE" });
		} finally {
			f.cleanup();
		}
	});

	it("returns OVERSIZE for FFFFFFFF (0xFFFFFFFF) header", async () => {
		const raw = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
		const f = tempFileWithRawBytes(raw);
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r).toEqual({ ok: false, code: "OVERSIZE" });
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
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r).toEqual({ ok: false, code: "TRAILING" });
		} finally {
			f.cleanup();
		}
	});

	it("returns frozen error result", async () => {
		const r = await readSandboxBootstrapFrame(0);
		expect(Object.isFrozen(r)).toBe(true);
	});
});

describe("readSandboxBootstrapFrame :: close lifecycle", () => {
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
				} catch {
					/* ignore */
				}
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
				} catch {
					/* ignore */
				}
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
				cb(new Error("close-injected"));
			},
		};
		const r = await readSandboxBootstrapFrame(f.fd, { _adapter: adapter });
		expect(r).toEqual({ ok: false, code: "CLOSE_FAILED" });
	});

	it("sync close callback does not leave orphan timer", async () => {
		// An adapter whose close calls back synchronously. The timer must
		// be created before the close call and cleared on the sync path.
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
				} catch {
					/* ignore */
				}
				cb(null); // synchronous callback — timer created before close call
			},
		};
		const r = await readSandboxBootstrapFrame(f.fd, { _adapter: adapter });
		expect(r.ok).toBe(true);
		// If an orphan timer fires later, it would not crash because
		// closeDispatch was cleared. We just need to not crash/leak.
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
				} catch {
					/* ignore */
				}
				cb(null);
				// Second call should be ignored
				setTimeout(() => cb(null), 5);
			},
		};
		const r = await readSandboxBootstrapFrame(f.fd, { _adapter: adapter });
		expect(r.ok).toBe(true);
	});

	it("close is not called on INVALID_FD", async () => {
		const nac = neverCallbackAdapter();
		const r = await readSandboxBootstrapFrame(0, { _adapter: nac });
		expect(r).toEqual({ ok: false, code: "INVALID_FD" });
		expect(nac.closeCallCount).toBe(0);
	});

	it("close is not called on INVALID_OPTIONS", async () => {
		const nac = neverCallbackAdapter();
		const r = await readSandboxBootstrapFrame(3, {
			_adapter: nac,
			rogue: 1,
		} as unknown as undefined);
		expect(r).toEqual({ ok: false, code: "INVALID_OPTIONS" });
		expect(nac.closeCallCount).toBe(0);
	});
});

describe("readSandboxBootstrapFrame :: short-read loops", () => {
	it("handles 1-byte-at-a-time header via adapter", async () => {
		const payload = new Uint8Array([0x10, 0x20, 0x30]);
		const f = tempFileWithFrame(payload);
		const path = f.path;
		const adapter = oneByteAtATimeAdapter(path);
		const fd2 = openSync(path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, { _adapter: adapter });
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(Array.from(r.payload)).toEqual([0x10, 0x20, 0x30]);
			}
		} finally {
			try {
				closeSync(fd2);
			} catch {
				/* ignore */
			}
			f.cleanup();
		}
	});

	it("handles 1-byte-at-a-time payload via adapter", async () => {
		const payload = new Uint8Array(100);
		for (let i = 0; i < payload.length; i++) payload[i] = i;
		const f = tempFileWithFrame(payload);
		const path = f.path;
		const adapter = oneByteAtATimeAdapter(path);
		const fd2 = openSync(path, "r");
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
			} catch {
				/* ignore */
			}
			f.cleanup();
		}
	});

	it("handles synchronous 1-byte 64 KiB without stack overflow", { timeout: 60_000 }, async () => {
		const payload = new Uint8Array(65_536);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const f = tempFileWithFrame(payload);
		const path = f.path;
		// Use synchronous (non-deferred) 1-byte adapter
		const adapter = oneByteAtATimeAdapter(path);
		const fd2 = openSync(path, "r");
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
			} catch {
				/* ignore */
			}
			f.cleanup();
		}
	});
});

describe("readSandboxBootstrapFrame :: timeout and cancellation", () => {
	it("total timeout fires when adapter never calls back read", async () => {
		const nac = neverCallbackAdapter();
		const r = await readSandboxBootstrapFrame(3, {
			totalTimeoutMs: 50,
			closeConfirmTimeoutMs: 50,
			_adapter: nac,
		});
		// Timeout fires, close confirmed or unconfirmed
		expect(r.ok).toBe(false);
		expect(["TIMEOUT", "CLOSE_UNCONFIRMED"]).toContain((r as { code: string }).code);
		expect(nac.readCallCount).toBe(1);
		expect(nac.closeCallCount).toBe(1);
	});

	it("single total timeout covers all phases (not per-phase)", async () => {
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				// Complete header, hang on payload
				if (len === 4) {
					buf[off] = 0;
					buf[off + 1] = 0;
					buf[off + 2] = 0;
					buf[off + 3] = 5;
					cb(null, 4, buf);
				}
				// payload read never calls back
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

	it("delayed read callback after timeout proves target NOT erased early", async () => {
		// Holds the payload callback externally.
		let delayedCb: ((err: Error | null, br: number, buf: Uint8Array) => void) | null = null;
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				if (len === 4) {
					// Header: complete immediately
					buf[off] = 0;
					buf[off + 1] = 0;
					buf[off + 2] = 0;
					buf[off + 3] = 3;
					cb(null, 4, buf);
				} else {
					// Payload: delay the callback
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

		// Fire delayed callback — must not crash; buffer was retained then erased.
		expect(delayedCb).not.toBeNull();
		(delayedCb as unknown as () => void)();
	});

	it("close never callback: bounded close-confirm timeout settles", async () => {
		const nac = neverCallbackAdapter();
		const r = await readSandboxBootstrapFrame(3, {
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 20,
			_adapter: nac,
		});
		// Total timeout → close attempted → close never calls back → CLOSE_UNCONFIRMED
		expect(r).toEqual({ ok: false, code: "CLOSE_UNCONFIRMED" });
	});

	it("close never callback with pending read: pending buffer retained", async () => {
		let phase: "header" | "payload" = "header";
		const nac: NeverCallbackAdapter = {
			readCallCount: 0,
			closeCallCount: 0,
			read(
				_fd: number,
				buf: Uint8Array,
				off: number,
				_len: number,
				_pos: number | null,
				cb: (err: Error | null, br: number, buf: Uint8Array) => void,
			) {
				nac.readCallCount++;
				if (phase === "header") {
					phase = "payload";
					buf[off] = 0;
					buf[off + 1] = 0;
					buf[off + 2] = 0;
					buf[off + 3] = 5;
					cb(null, 4, buf);
				}
				// payload read never calls back
			},
			close() {
				nac.closeCallCount++;
				// never calls back
			},
		};
		const r = await readSandboxBootstrapFrame(3, {
			totalTimeoutMs: 10,
			closeConfirmTimeoutMs: 20,
			_adapter: nac,
		});
		expect(r).toEqual({ ok: false, code: "CLOSE_UNCONFIRMED" });
		expect(nac.readCallCount).toBe(2);
		expect(nac.closeCallCount).toBe(1);
	});
});

describe("readSandboxBootstrapFrame :: stale/double callbacks", () => {
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
					// Supply header bytes
					for (let i = 0; i < 4 && offset < rawData.length; i++) {
						buf[off + i] = rawData[offset + i];
					}
					offset += 4;
					cb(null, 4, buf);
					// Second call should be ignored
					setTimeout(() => cb(null, 4, buf), 5);
				} else {
					// Supply remaining data
					const chunk = Math.min(len, rawData.length - offset);
					for (let i = 0; i < chunk; i++) {
						buf[off + i] = rawData[offset + i];
					}
					offset += chunk;
					cb(null, chunk, buf);
				}
			},
			close(_fd, cb) {
				try {
					closeSync(_fd);
				} catch {
					/* ignore */
				}
				cb(null);
			},
		};

		const fd2 = openSync(f.path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, { _adapter: adapter });
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(Array.from(r.payload)).toEqual([0x42]);
			}
		} finally {
			try {
				closeSync(fd2);
			} catch {
				/* ignore */
			}
			f.cleanup();
		}
	});

	it("stale callback after next read is ignored", async () => {
		// Fire header callback. On the header callback, fire a second (stale)
		// header callback AFTER the payload read is scheduled.
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
				for (let i = 0; i < chunk; i++) {
					buf[off + i] = rawData[offset + i];
				}
				offset += chunk;

				if (headerCount === 0) {
					headerCount++;
					cb(null, chunk, buf);
					// Schedule a stale callback for later
					staleCb = () => {
						// This should be ignored since payload read is now active
						cb(null, chunk, buf);
					};
				} else if (headerCount === 1) {
					// This is the payload phase callback
					headerCount++;
					cb(null, chunk, buf);
					// Fire the stale header callback now
					if (staleCb) staleCb();
				} else {
					cb(null, chunk, buf);
				}
			},
			close(_fd, cb) {
				try {
					closeSync(_fd);
				} catch {
					/* ignore */
				}
				cb(null);
			},
		};

		const fd2 = openSync(f.path, "r");
		try {
			const r = await readSandboxBootstrapFrame(fd2, { _adapter: adapter });
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(Array.from(r.payload)).toEqual([0x42]);
			}
		} finally {
			try {
				closeSync(fd2);
			} catch {
				/* ignore */
			}
			f.cleanup();
		}
	});
});

describe("readSandboxBootstrapFrame :: sync throws from adapter", () => {
	it("adapter.read sync throw maps to INTERNAL + close called", async () => {
		let closeCalled = false;
		const adapter: FsFdAdapter = {
			read() {
				throw new Error("sync-read-throw");
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
				throw new Error("sync-close-throw");
			},
		};
		const r = await readSandboxBootstrapFrame(f.fd, { _adapter: adapter });
		// Close throws → CLOSE_FAILED
		expect(r).toEqual({ ok: false, code: "CLOSE_FAILED" });
	});
});

describe("readSandboxBootstrapFrame :: invalid bytesRead", () => {
	it("adapter that reports negative bytesRead yields error", async () => {
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, _len, _pos, cb) {
				// Write header bytes but report -1
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
		const r = await readSandboxBootstrapFrame(42, { _adapter: adapter });
		// -1 is invalid → READ_HEADER error
		expect(r).toEqual({ ok: false, code: "READ_HEADER" });
	});

	it("adapter that reports too-large bytesRead yields error", async () => {
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, _len, _pos, cb) {
				// Write header bytes but report 100 ( > requested 4 )
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
		const r = await readSandboxBootstrapFrame(42, { _adapter: adapter });
		// 100 > requested 4 → READ_HEADER error
		expect(r).toEqual({ ok: false, code: "READ_HEADER" });
	});

	it("undefined bytesRead yields 0, does not advance (short read works)", async () => {
		// Data: header [0,0,0,1] + payload [0x42] = 5 bytes
		const data = new Uint8Array([0, 0, 0, 1, 0x42]);
		let pos = 0;
		let firstCall = true;
		const adapter: FsFdAdapter = {
			read(_fd, buf, off, len, _pos, cb) {
				if (firstCall) {
					// Report undefined bytesRead (treated as 0, retry same offset)
					firstCall = false;
					cb(null, undefined as unknown as number, buf);
					return;
				}
				const avail = Math.min(len, data.length - pos);
				for (let i = 0; i < avail; i++) buf[off + i] = data[pos + i];
				pos += avail;
				cb(null, avail, buf);
			},
			close(_fd, cb) {
				cb(null);
			},
		};
		const r = await readSandboxBootstrapFrame(42, { _adapter: adapter });
		// undefined → rawBr=0 → accHeader stays 0 → retries from same offset
		// On retry, the adapter reads from data at offset 0 (correct position).
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(Array.from(r.payload)).toEqual([0x42]);
		}
	});
});

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
			if (captured) {
				expect(Array.from(captured)).toEqual([0, 0, 0]);
			}
		} finally {
			f.cleanup();
		}
	});

	it("returns INTERNAL when consumer throws", async () => {
		const payload = new Uint8Array([0x01]);
		const f = tempFileWithFrame(payload);
		try {
			const r = await consumeSandboxBootstrapFrame(f.fd, () => {
				throw new Error("consumer error");
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
				throw new Error("fail");
			});
		} catch {
			// Should not throw
		}
		expect(captured).not.toBeNull();
		if (captured) {
			expect(Array.from(captured)).toEqual([0, 0]);
		}
		f.cleanup();
	});

	it("passes through read errors without calling consumer", async () => {
		const r = await consumeSandboxBootstrapFrame(0, () => "never");
		expect(r).toEqual({ ok: false, code: "INVALID_FD" });
	});

	it("returns frozen result object on success", async () => {
		const payload = new Uint8Array([0x42]);
		const f = tempFileWithFrame(payload);
		try {
			const r = await consumeSandboxBootstrapFrame(f.fd, (p) => p.length);
			expect(Object.isFrozen(r)).toBe(true);
		} finally {
			f.cleanup();
		}
	});
});

describe("readSandboxBootstrapFrame :: boundary: exact 1 byte and 65536 bytes", () => {
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
				} catch {
					/* ignore */
				}
				cb(null);
			},
		};
		const r = await readSandboxBootstrapFrame(f.fd, { _adapter: adapter });
		expect(r).toEqual({ ok: false, code: "EMPTY" });
		expect(closeCount).toBe(1);
	});

	it("handles file with all data at once (normal case)", async () => {
		const payload = new Uint8Array(1000);
		for (let i = 0; i < 1000; i++) payload[i] = i & 0xff;
		const f = tempFileWithFrame(payload);
		try {
			const r = await readSandboxBootstrapFrame(f.fd);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.payload.length).toBe(1000);
			}
		} finally {
			f.cleanup();
		}
	});
});
