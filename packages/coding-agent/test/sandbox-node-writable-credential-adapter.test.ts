/**
 * Tests for sandbox-node-writable-credential-adapter.
 *
 * Composes with createCredentialFrameWrite from the accepted credential-writer
 * protocol to assert exact frame ownership, erasure timing, and release
 * semantics.
 */

import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { createCredentialFrameWrite } from "../src/core/sandbox-credential-writer.js";
import { createNodeWritableCredentialAdapter } from "../src/core/sandbox-node-writable-credential-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function payload(...bytes: number[]): Uint8Array {
	return new Uint8Array(bytes);
}

/** Advance pending timers so pending Node stream callbacks settle. */
async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Adapter creation tests
// ---------------------------------------------------------------------------

describe("createNodeWritableCredentialAdapter input", () => {
	test.each([undefined, null, 1, "x", [], () => {}])("rejects invalid outer input %#", (raw) => {
		expect(createNodeWritableCredentialAdapter(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("rejects {writable} without the right shape", () => {
		expect(createNodeWritableCredentialAdapter({ writable: {} })).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("rejects Proxy writable", () => {
		const proxy = new Proxy(new Writable({ write() {} }), {});
		expect(createNodeWritableCredentialAdapter({ writable: proxy })).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("rejects outer symbols and proxied methods", () => {
		const stream = new Writable({ write() {} });
		const outer = { writable: stream, [Symbol("extra")]: true };
		expect(createNodeWritableCredentialAdapter(outer)).toEqual({ ok: false, code: "INVALID_INPUT" });
		const write = new Proxy((_chunk: Uint8Array, _callback: (error?: unknown) => void): boolean => true, {});
		const hostile = { write, end: (_callback: (error?: unknown) => void): void => {} };
		expect(createNodeWritableCredentialAdapter({ writable: hostile })).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("accepts a genuine Node Writable", () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const result = createNodeWritableCredentialAdapter({ writable: stream });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(Object.isFrozen(result.writable)).toBe(true);
			expect(typeof result.writable.write).toBe("function");
			expect(typeof result.writable.release).toBe("function");
			expect(typeof result.writable.end).toBe("function");
		}
	});

	test("WritableCapability write/release/end are frozen", () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const result = createNodeWritableCredentialAdapter({ writable: stream });
		if (!result.ok) throw new Error("unexpected");
		expect(Object.isFrozen(result.writable)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Composed with createCredentialFrameWrite
// ---------------------------------------------------------------------------

describe("composed write lifecycle", () => {
	test("sync callback completes write+end successfully", async () => {
		let written: Uint8Array | undefined;
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				written = chunk;
				callback(); // sync
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		const frame = payload(1, 2, 3);
		const result = createCredentialFrameWrite({ writable: adapter.writable, payload: frame, timeoutMs: 100 });
		if (!result.ok) throw new Error("unexpected");

		// Frame erased by createCredentialFrameWrite after copy
		expect([...frame]).toEqual([0, 0, 0]);

		// Wait for completion
		const completion = await result.handle.completion;
		expect(completion).toEqual({ ok: true, code: "WRITTEN" });
		expect(written).toBeDefined();
		expect(written?.every((byte) => byte === 0)).toBe(true);
	});

	test("async callback still succeeds", async () => {
		let writeCallback: ((error?: Error | null) => void) | undefined;
		const stream = new Writable({
			write(_chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void): void {
				writeCallback = callback;
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		const result = createCredentialFrameWrite({
			writable: adapter.writable,
			payload: payload(4, 5),
			timeoutMs: 1000,
		});
		if (!result.ok) throw new Error("unexpected");

		// Not settled yet
		expect(await Promise.race([result.handle.completion.then(() => "done"), tick().then(() => "pending")])).toBe(
			"pending",
		);

		// Fire node callback
		writeCallback!();
		await tick();

		const completion = await result.handle.completion;
		expect(completion).toEqual({ ok: true, code: "WRITTEN" });
	});

	test("Node backpressure false still returns started and succeeds", async () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				setTimeout(callback, 10);
				return false; // backpressure
			},
			highWaterMark: 1,
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		// Write a large-ish frame to trigger backpressure
		const data = new Uint8Array(100);
		const result = createCredentialFrameWrite({ writable: adapter.writable, payload: data, timeoutMs: 5000 });
		if (!result.ok) throw new Error("unexpected");

		const completion = await result.handle.completion;
		expect(completion).toEqual({ ok: true, code: "WRITTEN" });
	});

	test("Node write callback error propagates", async () => {
		const stream = new Writable({
			write(_chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void): void {
				callback(new Error("disk full"));
			},
		});
		stream.on("error", () => {}); // suppress Node's auto-emit
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		const result = createCredentialFrameWrite({ writable: adapter.writable, payload: payload(7), timeoutMs: 100 });
		if (!result.ok) throw new Error("unexpected");

		const completion = await result.handle.completion;
		expect(completion).toEqual({ ok: false, code: "WRITE_FAILED" });
	});

	test("Node write() throw retains frame and release stays pending (RELEASE_UNCONFIRMED)", async () => {
		let captured: Uint8Array | undefined;
		const stream = new Writable({
			write(chunk: unknown, _encoding: unknown, _callback: (error?: Error | null) => void): void {
				captured = chunk as Uint8Array;
				throw new Error("raw transport error");
			},
		});
		// Need to also make end() available — but if write() throws, the adapter
		// should not call end() and release stays pending.
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		const result = createCredentialFrameWrite({ writable: adapter.writable, payload: payload(8, 9), timeoutMs: 100 });
		if (!result.ok) throw new Error("unexpected");

		// The credential writer will attempt release but since the adapter's
		// node callback never fires, release stays pending forever and the
		// completion never settles.  Bytes are preserved.
		// We can't await completion (it hangs), so check that it's not settled.
		const settled = await Promise.race([result.handle.completion.then(() => true), tick().then(() => false)]);
		expect(settled).toBe(false);
		expect(captured?.some((b) => b !== 0)).toBe(true);
	});

	test("callback before throw uses definitive result", async () => {
		const stream = new Writable({
			write(_chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void): void {
				callback(); // sync — fires successfully before throw
				throw new Error("bang");
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		const result = createCredentialFrameWrite({ writable: adapter.writable, payload: payload(1), timeoutMs: 100 });
		if (!result.ok) throw new Error("unexpected");

		// The sync callback has already been processed — write was successful,
		// so completion should eventually resolve to WRITTEN.
		const completion = await result.handle.completion;
		expect(completion).toEqual({ ok: true, code: "WRITTEN" });
	});

	test("duplicate write callback is hostile and ignored", async () => {
		// Use cap directly so Node's ERR_MULTIPLE_CALLBACK state doesn't
		// interfere with the credential writer's subsequent end() call.
		let nodeCb: ((error?: Error | null) => void) | undefined;
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				nodeCb = callback;
			},
		});
		stream.on("error", () => {}); // suppress Node's auto-emit
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");
		const cap = adapter.writable;

		let writeCbResult: unknown;
		cap.write(new Uint8Array([2]), (r) => {
			writeCbResult = r;
		});

		// Fire node callback twice (duplicate is hostile and ignored by adapter)
		nodeCb!();
		nodeCb!(); // hostile duplicate
		nodeCb!(new Error("late")); // hostile duplicate with error

		await tick();
		expect(writeCbResult).toEqual({ status: "written" });
	});

	test("end throw before node callback returns error", async () => {
		// Write succeeds, but end throws
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		// Override end so extractWriteEnd picks up the own property
		(stream as unknown as Record<string, unknown>).end = function endOverride(
			_callback: (err?: unknown) => void,
		): unknown {
			throw new Error("end transport error");
		};
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		const result = createCredentialFrameWrite({ writable: adapter.writable, payload: payload(3), timeoutMs: 100 });
		if (!result.ok) throw new Error("unexpected");

		const completion = await result.handle.completion;
		expect(completion).toEqual({ ok: false, code: "END_FAILED" });
	});

	test("end callback then throw keeps definitive ended", async () => {
		const stream = new Writable({
			write(_chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void): void {
				callback();
			},
		});
		// Override end so extractWriteEnd picks up the own property
		(stream as unknown as Record<string, unknown>).end = function endOverride(
			callback: (err?: unknown) => void,
		): unknown {
			callback(); // sync
			throw new Error("end throw after callback");
		};
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		const result = createCredentialFrameWrite({ writable: adapter.writable, payload: payload(5), timeoutMs: 100 });
		if (!result.ok) throw new Error("unexpected");

		const completion = await result.handle.completion;
		expect(completion).toEqual({ ok: true, code: "WRITTEN" });
	});

	test("end never called — result stays pending", async () => {
		// Stream whose _final never calls back, so end hangs
		const stream = new Writable({
			write(_chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void): void {
				callback();
			},
			final(_callback: (error?: Error | null) => void): void {
				// never calls callback
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		const result = createCredentialFrameWrite({ writable: adapter.writable, payload: payload(6), timeoutMs: 100 });
		if (!result.ok) throw new Error("unexpected");

		// Write succeeds, but end hangs because _final never calls back.
		// Timeout should fire.
		const settled = await result.handle.completion;
		expect(settled).toEqual({ ok: false, code: "TIMEOUT" });
	});

	test("double end call returns error", async () => {
		// Test the cap directly.
		let writeCb: ((error?: Error | null) => void) | undefined;
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				writeCb = callback;
			},
			final(callback) {
				callback(); // sync _final
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");
		const cap = adapter.writable;

		// Write first
		cap.write(new Uint8Array([1, 2, 3]), () => {});
		writeCb!();

		// Wait for Node to process end callback
		let endCbCalled = false;
		const firstEnd = cap.end(() => {
			endCbCalled = true;
		});
		expect(firstEnd).toEqual({ status: "started" });
		await tick();
		expect(endCbCalled).toBe(true);

		// Second end call returns error
		const secondEnd = cap.end(() => {});
		expect(secondEnd).toEqual({ status: "error" });
	});

	test("double release via cap returns error", async () => {
		const stream = new Writable({
			write(_chunk, _encoding) {
				// never callback
			},
		});
		const adapterResult = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapterResult.ok) throw new Error("unexpected");
		const cap = adapterResult.writable;

		// Start a write that will never complete
		cap.write(new Uint8Array([1]), () => {});

		// First release returns started (pending)
		const r1 = cap.release(() => {});
		expect(r1).toEqual({ status: "started" });

		// Second release returns error (double)
		const r2 = cap.release(() => {});
		expect(r2).toEqual({ status: "error" });
	});
});

// ---------------------------------------------------------------------------
// Direct cap semantics (without createCredentialFrameWrite)
// ---------------------------------------------------------------------------

describe("cap method contracts", () => {
	test("write rejects invalid frame", () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		expect(adapter.writable.write("not-a-uint8array" as unknown as Uint8Array, () => {})).toEqual({
			status: "error",
		});
		expect(adapter.writable.write(null as unknown as Uint8Array, () => {})).toEqual({ status: "error" });
		expect(adapter.writable.write(new Uint8Array([1]), null as unknown as () => void)).toEqual({ status: "error" });
	});

	test("write rejects non-function callback", () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		expect(adapter.writable.write(new Uint8Array([1]), "not-function" as unknown as () => void)).toEqual({
			status: "error",
		});
	});

	test("release callback gets released when write already done", async () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		// Use the cap write (not through credential writer) to have direct control
		let writeCbResult: unknown;
		adapter.writable.write(new Uint8Array([1]), (r) => {
			writeCbResult = r;
		});
		// Node defers user callbacks even for sync _write; await a tick.
		await tick();
		expect(writeCbResult).toEqual({ status: "written" });

		// Release now (write already done) should be immediate
		let releaseResult: unknown;
		const ret = adapter.writable.release((r) => {
			releaseResult = r;
		});
		expect(ret).toEqual({ status: "released" });
		expect(releaseResult).toEqual({ status: "released" });
	});

	test("release before write callback returns started, fires later", async () => {
		let nodeCb: ((error?: Error | null) => void) | undefined;
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				nodeCb = callback;
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		adapter.writable.write(new Uint8Array([2]), () => {});

		// Release while write pending
		let releaseResult: unknown;
		const ret = adapter.writable.release((r) => {
			releaseResult = r;
		});
		expect(ret).toEqual({ status: "started" });
		expect(releaseResult).toBeUndefined();

		// Fire node callback
		nodeCb!();
		expect(releaseResult).toEqual({ status: "released" });
	});

	test("release during idle state returns released immediately", () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		let releaseResult: unknown;
		const ret = adapter.writable.release((r) => {
			releaseResult = r;
		});
		expect(ret).toEqual({ status: "released" });
		expect(releaseResult).toEqual({ status: "released" });
	});

	test("end throw before callback returns error", () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		// Override end after construction so extractWriteEnd picks up the own property
		(stream as unknown as Record<string, unknown>).end = function endOverride(
			_callback: (err?: unknown) => void,
		): unknown {
			throw new Error("end transport error");
		};
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		// Write first
		adapter.writable.write(new Uint8Array([1]), () => {});

		// end() throws -> should return error
		const ret = adapter.writable.end(() => {});
		expect(ret).toEqual({ status: "error" });
	});

	test("write return boolean true maps to started", () => {
		let _capturedCb: ((error?: Error | null) => void) | undefined;
		const stream = new Writable({
			write(_chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void): boolean {
				_capturedCb = callback;
				return true;
			},
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		const ret = adapter.writable.write(new Uint8Array([1]), () => {});
		expect(ret).toEqual({ status: "started" });
	});

	test("write return boolean false maps to started", () => {
		const stream = new Writable({
			write(_chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void): boolean {
				setTimeout(callback, 10);
				return false;
			},
			highWaterMark: 1,
		});
		const adapter = createNodeWritableCredentialAdapter({ writable: stream });
		if (!adapter.ok) throw new Error("unexpected");

		const ret = adapter.writable.write(new Uint8Array(100), () => {});
		expect(ret).toEqual({ status: "started" });
	});
});
