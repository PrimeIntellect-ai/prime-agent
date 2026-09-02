import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type CredentialWriteCompletion, createCredentialFrameWrite } from "../src/core/sandbox-credential-writer.js";

interface FakeWritable {
	write(frame: Uint8Array, callback: (result: unknown) => void): unknown;
	release(callback: (result: unknown) => void): unknown;
	end(callback: (result: unknown) => void): unknown;
}

function payload(...bytes: number[]): Uint8Array {
	return new Uint8Array(bytes);
}

function makeFake() {
	let frame: Uint8Array | undefined;
	let writeCallback: ((result: unknown) => void) | undefined;
	let releaseCallback: ((result: unknown) => void) | undefined;
	let endCallback: ((result: unknown) => void) | undefined;
	const calls = { write: 0, release: 0, end: 0 };
	const fake: FakeWritable = {
		write(value, callback) {
			calls.write += 1;
			frame = value;
			writeCallback = callback;
			return { status: "started" };
		},
		release(callback) {
			calls.release += 1;
			releaseCallback = callback;
			return { status: "started" };
		},
		end(callback) {
			calls.end += 1;
			endCallback = callback;
			return { status: "started" };
		},
	};
	return {
		fake,
		calls,
		get frame() {
			return frame;
		},
		get writeCallback() {
			return writeCallback;
		},
		get releaseCallback() {
			return releaseCallback;
		},
		get endCallback() {
			return endCallback;
		},
	};
}

function start(fake: FakeWritable, value = payload(9, 8, 7), timeoutMs = 100) {
	return createCredentialFrameWrite({ writable: fake, payload: value, timeoutMs });
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	promise.then(() => {
		done = true;
	});
	await Promise.resolve();
	return done;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("createCredentialFrameWrite input and erasure", () => {
	test.each([undefined, null, 1, "x", {}, [], () => {}])("rejects invalid outer input %#", (raw) => {
		expect(createCredentialFrameWrite(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("erases a safely discovered payload before unrelated writable rejection", () => {
		const value = payload(1, 2, 3);
		const result = createCredentialFrameWrite({ writable: {}, payload: value, timeoutMs: 10 });
		expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect([...value]).toEqual([0, 0, 0]);
	});

	test("erases Buffer and rejects it", () => {
		const value = Buffer.from([1, 2, 3]);
		const { fake } = makeFake();
		expect(start(fake, value)).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect([...value]).toEqual([0, 0, 0]);
	});

	test("attempts erasure of a subview and rejects it", () => {
		const backing = new Uint8Array([7, 6, 5, 4]);
		const view = backing.subarray(1, 3);
		const { fake } = makeFake();
		expect(start(fake, view)).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect([...backing]).toEqual([7, 0, 0, 4]);
	});

	test("rejects and attempts erasure of shared backing", () => {
		const view = new Uint8Array(new SharedArrayBuffer(3));
		view.set([3, 2, 1]);
		const { fake } = makeFake();
		expect(start(fake, view)).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect([...view]).toEqual([0, 0, 0]);
	});

	test("rejects a payload Proxy without invoking its traps", () => {
		let reads = 0;
		const proxy = new Proxy(payload(1), {
			get() {
				reads += 1;
				throw new Error("secret");
			},
		});
		const { fake } = makeFake();
		expect(start(fake, proxy as unknown as Uint8Array)).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(reads).toBe(0);
	});

	test("rejects getters without invoking them", () => {
		let reads = 0;
		const input = { writable: makeFake().fake, timeoutMs: 10 } as Record<string, unknown>;
		Object.defineProperty(input, "payload", {
			enumerable: true,
			get() {
				reads += 1;
				return payload(1);
			},
		});
		expect(createCredentialFrameWrite(input)).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(reads).toBe(0);
	});

	test.each([0, -1, 1.5, 300_001, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects timeout %s and erases payload",
		(timeoutMs) => {
			const value = payload(4);
			const result = start(makeFake().fake, value, timeoutMs);
			expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
			expect(value[0]).toBe(0);
		},
	);

	test("builds one exact full-backing big-endian frame and erases caller", () => {
		const box = makeFake();
		const value = payload(4, 5, 6);
		const result = start(box.fake, value);
		expect(result.ok).toBe(true);
		expect([...value]).toEqual([0, 0, 0]);
		expect(box.frame).toBeInstanceOf(Uint8Array);
		expect(Object.getPrototypeOf(box.frame!)).toBe(Uint8Array.prototype);
		expect(box.frame!.byteOffset).toBe(0);
		expect(box.frame!.byteLength).toBe(box.frame!.buffer.byteLength);
		expect([...box.frame!]).toEqual([0, 0, 0, 3, 4, 5, 6]);
		expect(Object.isFrozen(result)).toBe(true);
		if (result.ok) expect(Object.isFrozen(result.handle)).toBe(true);
	});

	test.each([1, 65_536])("accepts payload boundary %s", (size) => {
		const box = makeFake();
		const result = start(box.fake, new Uint8Array(size));
		expect(result.ok).toBe(true);
		expect(box.frame?.byteLength).toBe(size + 4);
	});
});

describe("credential write ownership", () => {
	test("write callback and end callback are both required for success", async () => {
		const box = makeFake();
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		expect(await isSettled(result.handle.completion)).toBe(false);
		box.writeCallback?.({ status: "written" });
		expect([...box.frame!]).toEqual(new Array(7).fill(0));
		expect(box.calls.end).toBe(1);
		expect(await isSettled(result.handle.completion)).toBe(false);
		box.endCallback?.({ status: "ended" });
		expect(await result.handle.completion).toEqual({ ok: true, code: "WRITTEN" });
		expect(vi.getTimerCount()).toBe(0);
	});

	test("same completion promise identity is stable", () => {
		const result = start(makeFake().fake);
		if (!result.ok) throw new Error("unexpected");
		expect(result.handle.completion).toBe(result.handle.completion);
	});

	test("synchronous callbacks before method returns succeed and leave no timer", async () => {
		const fake: FakeWritable = {
			write(_frame, callback) {
				callback({ status: "written" });
				return { status: "started" };
			},
			release() {
				return { status: "started" };
			},
			end(callback) {
				callback({ status: "ended" });
				return { status: "started" };
			},
		};
		const result = start(fake);
		if (!result.ok) throw new Error("unexpected");
		expect(await result.handle.completion).toEqual({ ok: true, code: "WRITTEN" });
		expect(vi.getTimerCount()).toBe(0);
	});

	test("write callback does not override an inconsistent error return", async () => {
		const fake: FakeWritable = {
			write(_frame, callback) {
				callback({ status: "written" });
				return { status: "error" };
			},
			release() {
				return { status: "started" };
			},
			end() {
				throw new Error("must not run");
			},
		};
		const result = start(fake);
		if (!result.ok) throw new Error("unexpected");
		expect(await result.handle.completion).toEqual({ ok: false, code: "WRITE_FAILED" });
	});

	test.each([{ status: "error" }, { status: "written", extra: 1 }, { status: "bad" }, null])(
		"write callback %j fails closed",
		async (callbackResult) => {
			const box = makeFake();
			const result = start(box.fake);
			if (!result.ok) throw new Error("unexpected");
			box.writeCallback?.(callbackResult);
			if (callbackResult && Object.keys(callbackResult).length === 1 && callbackResult.status === "error") {
				expect(await result.handle.completion).toEqual({ ok: false, code: "WRITE_FAILED" });
			} else {
				expect(await isSettled(result.handle.completion)).toBe(false);
				expect(box.calls.release).toBe(1);
				box.releaseCallback?.({ status: "released" });
				expect(await result.handle.completion).toEqual({ ok: false, code: "WRITE_FAILED" });
			}
		},
	);

	test("write throw starts release and retains bytes until explicit release", async () => {
		let frame: Uint8Array | undefined;
		let releaseCallback: ((raw: unknown) => void) | undefined;
		const fake: FakeWritable = {
			write(value) {
				frame = value;
				throw new Error("raw secret");
			},
			release(callback) {
				releaseCallback = callback;
				return { status: "started" };
			},
			end() {
				return { status: "error" };
			},
		};
		const result = start(fake);
		if (!result.ok) throw new Error("unexpected");
		expect(await isSettled(result.handle.completion)).toBe(false);
		expect(frame?.some((byte) => byte !== 0)).toBe(true);
		releaseCallback?.({ status: "released" });
		expect(frame?.every((byte) => byte === 0)).toBe(true);
		expect(await result.handle.completion).toEqual({ ok: false, code: "WRITE_FAILED" });
	});

	test("release error retains frame until late write callback", async () => {
		const box = makeFake();
		box.fake.write = (frame, callback) => {
			Reflect.set(box, "captured", frame);
			Reflect.set(box, "lateWrite", callback);
			return { status: "error" };
		};
		box.fake.release = (callback) => {
			callback({ status: "error" });
			return { status: "error" };
		};
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		expect(await isSettled(result.handle.completion)).toBe(false);
		const captured = Reflect.get(box, "captured") as Uint8Array;
		expect(captured.some((byte) => byte !== 0)).toBe(true);
		const lateWrite = Reflect.get(box, "lateWrite") as (raw: unknown) => void;
		lateWrite({ status: "error" });
		expect(captured.every((byte) => byte === 0)).toBe(true);
		expect(await result.handle.completion).toEqual({ ok: false, code: "WRITE_FAILED" });
	});

	test("immediate release return confirms ownership", async () => {
		const box = makeFake();
		box.fake.write = (frame) => {
			Reflect.set(box, "captured", frame);
			return { status: "error" };
		};
		box.fake.release = () => ({ status: "released" });
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		expect(await result.handle.completion).toEqual({ ok: false, code: "WRITE_FAILED" });
		expect((Reflect.get(box, "captured") as Uint8Array).every((byte) => byte === 0)).toBe(true);
	});

	test("timeout requests release and does not erase until confirmation", async () => {
		const box = makeFake();
		const result = start(box.fake, payload(1, 2), 10);
		if (!result.ok) throw new Error("unexpected");
		await vi.advanceTimersByTimeAsync(10);
		expect(box.calls.release).toBe(1);
		expect(box.frame?.some((byte) => byte !== 0)).toBe(true);
		expect(await isSettled(result.handle.completion)).toBe(false);
		box.releaseCallback?.({ status: "released" });
		expect(await result.handle.completion).toEqual({ ok: false, code: "TIMEOUT" });
		expect(box.frame?.every((byte) => byte === 0)).toBe(true);
	});

	test("cancel is idempotent and waits for release", async () => {
		const box = makeFake();
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		result.handle.cancel();
		result.handle.cancel();
		expect(box.calls.release).toBe(1);
		expect(await isSettled(result.handle.completion)).toBe(false);
		box.releaseCallback?.({ status: "released" });
		expect(await result.handle.completion).toEqual({ ok: false, code: "CANCELLED" });
		expect(vi.getTimerCount()).toBe(0);
	});

	test("timeout during end fails without calling release", async () => {
		const box = makeFake();
		const result = start(box.fake, payload(1), 10);
		if (!result.ok) throw new Error("unexpected");
		box.writeCallback?.({ status: "written" });
		await vi.advanceTimersByTimeAsync(10);
		expect(box.calls.release).toBe(0);
		expect(await result.handle.completion).toEqual({ ok: false, code: "TIMEOUT" });
	});

	test("cancel during end fails safely without release", async () => {
		const box = makeFake();
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		box.writeCallback?.({ status: "written" });
		result.handle.cancel();
		expect(box.calls.release).toBe(0);
		expect(await result.handle.completion).toEqual({ ok: false, code: "CANCELLED" });
	});

	test.each([{ status: "error" }, { status: "ended", extra: true }, null])(
		"end callback %j fails closed",
		async (endResult) => {
			const box = makeFake();
			const result = start(box.fake);
			if (!result.ok) throw new Error("unexpected");
			box.writeCallback?.({ status: "written" });
			box.endCallback?.(endResult);
			expect(await result.handle.completion).toEqual({ ok: false, code: "END_FAILED" });
		},
	);

	test("end throw fails after frame was already erased", async () => {
		const box = makeFake();
		box.fake.end = () => {
			throw new Error("raw");
		};
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		box.writeCallback?.({ status: "written" });
		expect(box.frame?.every((byte) => byte === 0)).toBe(true);
		expect(await result.handle.completion).toEqual({ ok: false, code: "END_FAILED" });
	});

	test("mutating writable methods after factory does not affect bound methods", async () => {
		const box = makeFake();
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		box.fake.end = () => ({ status: "error" });
		box.writeCallback?.({ status: "written" });
		box.endCallback?.({ status: "ended" });
		expect(await result.handle.completion).toEqual({ ok: true, code: "WRITTEN" });
	});

	test("callback getter is never invoked", async () => {
		const box = makeFake();
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		let reads = 0;
		const hostile = {} as Record<string, unknown>;
		Object.defineProperty(hostile, "status", {
			enumerable: true,
			get() {
				reads += 1;
				return "written";
			},
		});
		box.writeCallback?.(hostile);
		expect(reads).toBe(0);
		expect(box.calls.release).toBe(1);
		box.releaseCallback?.({ status: "released" });
		expect(await result.handle.completion).toEqual({ ok: false, code: "WRITE_FAILED" });
	});

	test("late and duplicate callbacks cannot overwrite terminal result", async () => {
		const box = makeFake();
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		box.writeCallback?.({ status: "written" });
		box.writeCallback?.({ status: "error" });
		box.endCallback?.({ status: "ended" });
		box.endCallback?.({ status: "error" });
		const outcome: CredentialWriteCompletion = await result.handle.completion;
		expect(outcome).toEqual({ ok: true, code: "WRITTEN" });
	});

	test("release throw keeps completion pending until write callback releases ownership", async () => {
		let writeCallback: ((raw: unknown) => void) | undefined;
		let captured: Uint8Array | undefined;
		const fake: FakeWritable = {
			write(frame, callback) {
				captured = frame;
				writeCallback = callback;
				return { status: "error" };
			},
			release() {
				throw new Error("raw");
			},
			end() {
				return { status: "error" };
			},
		};
		const result = start(fake);
		if (!result.ok) throw new Error("unexpected");
		expect(await isSettled(result.handle.completion)).toBe(false);
		expect(captured?.some((byte) => byte !== 0)).toBe(true);
		writeCallback?.({ status: "written" });
		expect(captured?.every((byte) => byte === 0)).toBe(true);
		expect(await result.handle.completion).toEqual({ ok: false, code: "WRITE_FAILED" });
	});

	test("timeout may be released by the late write callback", async () => {
		const box = makeFake();
		const result = start(box.fake, payload(1), 5);
		if (!result.ok) throw new Error("unexpected");
		await vi.advanceTimersByTimeAsync(5);
		box.writeCallback?.({ status: "written" });
		expect(await result.handle.completion).toEqual({ ok: false, code: "TIMEOUT" });
		expect(box.calls.end).toBe(0);
	});

	test("cancel after terminal is inert", async () => {
		const box = makeFake();
		box.fake.end = () => ({ status: "ended" });
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		box.writeCallback?.({ status: "written" });
		expect(await result.handle.completion).toEqual({ ok: true, code: "WRITTEN" });
		result.handle.cancel();
		expect(box.calls.release).toBe(0);
	});

	test("immediate ended return succeeds without callback", async () => {
		const box = makeFake();
		box.fake.end = () => ({ status: "ended" });
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		box.writeCallback?.({ status: "written" });
		expect(await result.handle.completion).toEqual({ ok: true, code: "WRITTEN" });
	});

	test("an error callback cannot be overridden by ended return", async () => {
		const box = makeFake();
		box.fake.end = (callback) => {
			callback({ status: "error" });
			return { status: "ended" };
		};
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		box.writeCallback?.({ status: "written" });
		expect(await result.handle.completion).toEqual({ ok: false, code: "END_FAILED" });
	});

	test("end error return fails without waiting for callback", async () => {
		const box = makeFake();
		box.fake.end = () => ({ status: "error" });
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		box.writeCallback?.({ status: "written" });
		expect(await result.handle.completion).toEqual({ ok: false, code: "END_FAILED" });
	});

	test("malformed write return starts exactly one release", async () => {
		const box = makeFake();
		box.fake.write = (frame, callback) => {
			Reflect.set(box, "captured", frame);
			Reflect.set(box, "late", callback);
			return { status: "started", extra: true };
		};
		const result = start(box.fake);
		if (!result.ok) throw new Error("unexpected");
		result.handle.cancel();
		expect(box.calls.release).toBe(1);
		box.releaseCallback?.({ status: "released" });
		expect(await result.handle.completion).toEqual({ ok: false, code: "WRITE_FAILED" });
	});

	test.each(["throw", "error", "started"])(
		"release %s without a callback retains ownership and stays unresolved",
		async (mode) => {
			let captured: Uint8Array | undefined;
			const fake: FakeWritable = {
				write(frame) {
					captured = frame;
					return { status: "error" };
				},
				release() {
					if (mode === "throw") throw new Error("raw");
					return { status: mode };
				},
				end() {
					return { status: "error" };
				},
			};
			const result = start(fake, payload(3, 4), 5);
			if (!result.ok) throw new Error("unexpected");
			await vi.advanceTimersByTimeAsync(5);
			expect(await isSettled(result.handle.completion)).toBe(false);
			expect(captured?.some((byte) => byte !== 0)).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
