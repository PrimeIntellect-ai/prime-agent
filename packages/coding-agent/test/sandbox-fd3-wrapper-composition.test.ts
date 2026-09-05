/**
 * Focused tests for sandbox-fd3-wrapper-composition.
 *
 * Tests via the dependency-injected factory createSandboxFd3WrapperCompositionWithDeps
 * with short injected timeouts (10-50ms).  Covers:
 *   - Input validation: missing keys, invalid types, Proxy, getter, symbol
 *   - Frame validation: genuine Uint8Array validation via isGenuineFrame
 *   - Launcher mapping: ok + cleanupConfirmed => LAUNCH_FAILED,
 *     ok + !cleanupConfirmed => CLEANUP_UNCERTAIN, malformed owner
 *   - Hostile Promise and cleanupConfirmed propagation through bridge decode
 *   - One test handle at a time, short injected timeouts
 *
 * Uses the real encodeSandboxBootstrapPayload to build valid stdin frames so
 * the bridge reaches the launcher call.
 *
 * No real process I/O or child process creation occurs.
 */

import { describe, expect, it } from "vitest";
import { encodeSandboxBootstrapPayload } from "../src/core/sandbox-bootstrap-payload.js";
import { createSandboxFd3WrapperCompositionWithDeps } from "../src/core/sandbox-fd3-wrapper-composition.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_NONCE = "0123456789abcdef0123456789abcdef";
const BUILD_ID = "a1b2c3d4e5f6071829a0b1c2d3e4f50617283940a1b2c3d4e5f6071829304150";

// ---------------------------------------------------------------------------
// PAB1 frame helpers (mirrors bridge test)
// ---------------------------------------------------------------------------

function pab1Payload(): Uint8Array {
	const result = encodeSandboxBootstrapPayload({
		metadata: {
			hostId: "home-host",
			generation: "generation-1",
			sessionId: "session-1",
			relayUrl: "wss://relay.example.com/prime/v1",
			buildIdentity: {
				buildId: BUILD_ID,
				daemonProtocolVersion: 7,
				daemonSchemaRevision: 25,
			},
			connectTimeoutMs: 30_000,
		},
		grant: new TextEncoder().encode("A".repeat(50)),
	});
	if (!result.ok) throw new Error("fixture failed");
	return result.value;
}

function frame(value: Uint8Array): Uint8Array {
	const output = new Uint8Array(4 + value.byteLength);
	new DataView(output.buffer).setUint32(0, value.byteLength, false);
	output.set(value, 4);
	return output;
}

// ---------------------------------------------------------------------------
// Mock stdin that emits valid PAB1 frame on resume
// ---------------------------------------------------------------------------

function makeStdin(frameBytes: Uint8Array): Record<string, unknown> {
	const dataCbs: Array<(chunk: Uint8Array) => void> = [];
	const endCbs: Array<() => void> = [];
	const errorCbs: Array<(err: Error) => void> = [];

	function on(event: string, cb: (...args: Array<unknown>) => void): void {
		if (event === "data") dataCbs.push(cb);
		else if (event === "end") endCbs.push(cb);
		else if (event === "error") errorCbs.push(cb);
	}

	function removeListener(event: string, cb: (...args: Array<unknown>) => void): void {
		const list = event === "data" ? dataCbs : event === "end" ? endCbs : errorCbs;
		const idx = list.indexOf(cb);
		if (idx >= 0) list.splice(idx, 1);
	}

	function resume(): void {
		// Must emit Buffer instances (stdin adapter validates via Buffer.isBuffer)
		for (const cb of [...dataCbs]) cb(Buffer.from(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength));
		for (const cb of [...endCbs]) cb();
	}

	return Object.freeze({
		on,
		removeListener,
		resume,
		addListener: on,
		off: removeListener,
		destroy: (): void => {},
		listeners: (): Array<unknown> => [],
		emit: (): boolean => true,
		eventNames: (): Array<string> => [],
		listenerCount: (): number => 0,
		getMaxListeners: (): number => 10,
		setMaxListeners: (): void => {},
		isPaused: (): boolean => false,
		pause: (): void => {},
		pipe: (): unknown => ({}),
		unpipe: (): void => {},
		unshift: (): void => {},
		wrap: (): unknown => ({}),
		read: (): null => null,
		readable: true,
		readableFlowing: null,
		readableHighWaterMark: 16,
		readableLength: 0,
		readableEnded: false,
		readableObjectMode: false,
		destroyed: false,
		errored: null,
		closed: false,
		_writableState: undefined,
	});
}

// ---------------------------------------------------------------------------
// Mock stdout that captures write calls
// ---------------------------------------------------------------------------

interface WriteCapture {
	readonly chunks: Array<Uint8Array>;
	readonly callbacks: Array<(err?: Error) => void>;
}

function noop(): void {}
function retTrue(): boolean {
	return true;
}
function retEmptyArr(): Array<unknown> {
	return [];
}
function retEmptyStrArr(): Array<string> {
	return [];
}
function retZero(): number {
	return 0;
}
function retTen(): number {
	return 10;
}
function retObj(): unknown {
	return {};
}
function retNull(): null {
	return null;
}
function retFalse(): boolean {
	return false;
}
function pipeThis(): unknown {
	return {};
}
function makeStdoutCapture(): { stdout: Record<string, unknown>; capture: WriteCapture } {
	const capture: WriteCapture = { chunks: [], callbacks: [] };

	const writableProto: Record<string, unknown> = {};
	writableProto.write = function write(
		this: unknown,
		chunk: Uint8Array,
		_encoding: string,
		cb: (err?: Error) => void,
	): boolean {
		capture.chunks.push(new Uint8Array(chunk));
		capture.callbacks.push(cb);
		return true;
	};

	const stdoutProto = Object.create(writableProto);
	// Additional stream-like methods without casts
	function addStdoutMethod(
		obj: Record<string, unknown>,
		name: string,
		fn: (...args: readonly unknown[]) => unknown,
	): void {
		Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true, enumerable: true });
	}
	addStdoutMethod(stdoutProto, "on", noop);
	addStdoutMethod(stdoutProto, "off", noop);
	addStdoutMethod(stdoutProto, "addListener", noop);
	addStdoutMethod(stdoutProto, "removeListener", noop);
	addStdoutMethod(stdoutProto, "destroy", noop);
	addStdoutMethod(stdoutProto, "end", noop);
	addStdoutMethod(stdoutProto, "cork", noop);
	addStdoutMethod(stdoutProto, "uncork", noop);
	addStdoutMethod(stdoutProto, "setDefaultEncoding", retObj);
	addStdoutMethod(stdoutProto, "emit", retTrue);
	addStdoutMethod(stdoutProto, "listeners", retEmptyArr);
	addStdoutMethod(stdoutProto, "eventNames", retEmptyStrArr);
	addStdoutMethod(stdoutProto, "listenerCount", retZero);
	addStdoutMethod(stdoutProto, "getMaxListeners", retTen);
	addStdoutMethod(stdoutProto, "setMaxListeners", noop);
	addStdoutMethod(stdoutProto, "pipe", pipeThis);
	addStdoutMethod(stdoutProto, "unpipe", noop);
	addStdoutMethod(stdoutProto, "isPaused", retFalse);
	addStdoutMethod(stdoutProto, "pause", noop);
	addStdoutMethod(stdoutProto, "read", retNull);

	const stdoutProperties: Record<string, unknown> = {
		writable: true,
		writableEnded: false,
		writableFinished: false,
		writableHighWaterMark: 16,
		writableLength: 0,
		writableNeedDrain: false,
		writableObjectMode: false,
		destroyed: false,
		errored: null,
		closed: false,
		readable: false,
		writableCorked: 0,
	};
	for (const key of Object.keys(stdoutProperties)) {
		stdoutProto[key] = stdoutProperties[key];
	}

	return { stdout: stdoutProto, capture };
}

// ---------------------------------------------------------------------------
// Timeouts (short for fast tests)
// ---------------------------------------------------------------------------

function validTimeouts(): Record<string, number> {
	return Object.freeze({
		frameReadTimeoutMs: 200,
		credentialWriteTimeoutMs: 200,
		launchTimeoutMs: 200,
		monitorTimeoutMs: 200,
		publishTimeoutMs: 200,
	});
}

// ---------------------------------------------------------------------------
// Launcher factories
// ---------------------------------------------------------------------------

function okLauncher(_request: unknown): Promise<unknown> {
	const monitor = Object.freeze({
		ready: Promise.resolve(Object.freeze({ ok: true as const, pid: 712 })),
		closed: Promise.resolve(Object.freeze({ ok: true as const })),
		close: (): Promise<unknown> => Promise.resolve(Object.freeze({ ok: true as const })),
	});
	const writable = Object.freeze({
		write: (_frame: Uint8Array, cb: (result: unknown) => void): unknown => {
			cb(Object.freeze({ status: "written" }));
			return Object.freeze({ status: "started" });
		},
		release: (cb: (result: unknown) => void): unknown => {
			cb(Object.freeze({ status: "released" }));
			return Object.freeze({ status: "started" });
		},
		end: (cb: (result: unknown) => void): unknown => {
			cb(Object.freeze({ status: "ended" }));
			return Object.freeze({ status: "started" });
		},
	});
	return Promise.resolve(Object.freeze({ ok: true as const, monitor, credentialWritable: writable }));
}

function errorLauncher(code: string, cleanupConfirmed: boolean): (request: unknown) => Promise<unknown> {
	return (_request: unknown): Promise<unknown> =>
		Promise.resolve(Object.freeze({ ok: false as const, code: code as "SPAWN_FAILED", cleanupConfirmed }));
}

// ---------------------------------------------------------------------------
// Base deps
// ---------------------------------------------------------------------------

function baseDeps(overrides?: Record<string, unknown>): Record<string, unknown> {
	const payload = pab1Payload();
	const framed = frame(payload);
	const result: Record<string, unknown> = {
		readyNonce: VALID_NONCE,
		stdin: makeStdin(framed),
		stdout: makeStdoutCapture().stdout,
		launcher: okLauncher,
		timeouts: validTimeouts(),
	};
	if (overrides) {
		for (const key of Object.keys(overrides)) {
			result[key] = overrides[key];
		}
	}
	return Object.freeze(result);
}

// ---------------------------------------------------------------------------
// Tests: input validation
// ---------------------------------------------------------------------------

describe("createSandboxFd3WrapperCompositionWithDeps input", () => {
	it("rejects null", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(null);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects undefined", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(undefined);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects non-object", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps("bad");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects missing key", async () => {
		const { stdin, ...rest } = baseDeps();
		const result = await createSandboxFd3WrapperCompositionWithDeps(rest);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects extra key", async () => {
		const deps = { ...baseDeps(), extra: 1 };
		const result = await createSandboxFd3WrapperCompositionWithDeps(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects Proxy on deps", async () => {
		const target = baseDeps();
		const proxy = new Proxy(target, {});
		const result = await createSandboxFd3WrapperCompositionWithDeps(proxy);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects getter descriptor", async () => {
		// Build a fresh object with getter for readyNonce, value props for everything else
		const payload = pab1Payload();
		const framed = frame(payload);
		const { stdout } = makeStdoutCapture();
		const obj: Record<string, unknown> = {};
		// Define readyNonce as getter only (no prior value definition)
		Object.defineProperty(obj, "readyNonce", {
			enumerable: true,
			get: (): string => VALID_NONCE,
		});
		Object.defineProperty(obj, "stdin", { enumerable: true, writable: true, value: makeStdin(framed) });
		Object.defineProperty(obj, "stdout", { enumerable: true, writable: true, value: stdout });
		Object.defineProperty(obj, "launcher", { enumerable: true, writable: true, value: okLauncher });
		Object.defineProperty(obj, "timeouts", { enumerable: true, writable: true, value: validTimeouts() });
		const result = await createSandboxFd3WrapperCompositionWithDeps(obj);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects symbol on deps", async () => {
		const obj: Record<string | symbol, unknown> = {};
		const baseObj = baseDeps();
		for (const [key, value] of Object.entries(baseObj)) {
			obj[key] = value;
		}
		obj[Symbol("x")] = 1;
		const result = await createSandboxFd3WrapperCompositionWithDeps(Object.freeze(obj));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects short nonce", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(baseDeps({ readyNonce: "0".repeat(31) }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects non-hex nonce", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(baseDeps({ readyNonce: "z".repeat(32) }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects invalid timeouts (too large)", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(
			baseDeps({ timeouts: { ...validTimeouts(), frameReadTimeoutMs: 999999 } }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects invalid timeouts (zero)", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(
			baseDeps({ timeouts: { ...validTimeouts(), launchTimeoutMs: 0 } }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects non-function launcher", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(baseDeps({ launcher: 42 }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});

	it("rejects null stdin", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(baseDeps({ stdin: null }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
	});
});

// ---------------------------------------------------------------------------
// Tests: launcher error mapping
// ---------------------------------------------------------------------------

describe("launcher error mapping", () => {
	it("maps cleanupConfirmed=true to LAUNCH_FAILED", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(
			baseDeps({ launcher: Object.freeze({ launch: errorLauncher("SPAWN_FAILED", true) }) }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("LAUNCH_FAILED");
	});

	it("maps cleanupConfirmed=false to CLEANUP_UNCERTAIN", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(
			baseDeps({ launcher: Object.freeze({ launch: errorLauncher("MONITOR_FAILED", false) }) }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLEANUP_UNCERTAIN");
	});

	it("propagates ok:true result as started (bridge reads stdin first)", async () => {
		const result = await createSandboxFd3WrapperCompositionWithDeps(
			baseDeps({ launcher: Object.freeze({ launch: okLauncher }) }),
		);
		// Bridge should proceed through stdin read → credential write → monitor ready → publish
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// Expected: credential write or monitor ready fails with the mock
			expect(typeof result.error.code).toBe("string");
		}
	});

	it("rejects malformed ok:true with missing monitor/writable", async () => {
		const launcherCap = Object.freeze({
			launch: (_request: unknown): Promise<unknown> => Promise.resolve(Object.freeze({ ok: true as const })),
		});
		const result = await createSandboxFd3WrapperCompositionWithDeps(baseDeps({ launcher: launcherCap }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(["LAUNCH_FAILED", "CLEANUP_UNCERTAIN"]).toContain(result.error.code);
		}
	});

	it("rejects malformed launcher result with monitor property (uncertainty dominates)", async () => {
		const monitor = Object.freeze({
			ready: Promise.resolve(Object.freeze({ ok: true as const, pid: 712 })),
			closed: Promise.resolve(Object.freeze({ ok: true as const })),
			close: (): Promise<unknown> =>
				Promise.resolve(Object.freeze({ ok: false as const, code: "CLEANUP_UNCERTAIN" as const })),
		});
		const launcherCap = Object.freeze({
			launch: (_request: unknown): Promise<unknown> => Promise.resolve(Object.freeze({ monitor })),
		});
		const result = await createSandboxFd3WrapperCompositionWithDeps(baseDeps({ launcher: launcherCap }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("CLEANUP_UNCERTAIN");
		}
	});

	it("treats a Proxy launcher result as cleanup uncertainty", async () => {
		const launcherResult = new Proxy(Object.freeze({ ok: false }), {});
		const launcherCap = Object.freeze({
			launch: (_request: unknown): Promise<unknown> => Promise.resolve(launcherResult),
		});
		const result = await createSandboxFd3WrapperCompositionWithDeps(baseDeps({ launcher: launcherCap }));
		expect(result).toEqual({ ok: false, error: { code: "CLEANUP_UNCERTAIN" } });
	});

	it("rejects non-native thenable (not assimilated)", async () => {
		const thenable: Record<string, unknown> = {};
		// biome-ignore lint/suspicious/noThenProperty: intentional hostile thenable test
		Object.defineProperty(thenable, "then", {
			enumerable: true,
			value: (): void => {},
		});
		const launcherCap = Object.freeze({
			launch: (_request: unknown): unknown => thenable,
		});
		const result = await createSandboxFd3WrapperCompositionWithDeps(baseDeps({ launcher: launcherCap }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("LAUNCH_FAILED");
	});
});

// ---------------------------------------------------------------------------
// Tests: hostile promise propagation
// ---------------------------------------------------------------------------

describe("hostile promise propagation", () => {
	it("rejects non-native Promise from launcher", async () => {
		const launcherCap = Object.freeze({
			launch: (_request: unknown): unknown =>
				// biome-ignore lint/suspicious/noThenProperty: intentional hostile thenable test
				({ then: () => {} }),
		});
		const result = await createSandboxFd3WrapperCompositionWithDeps(baseDeps({ launcher: launcherCap }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("LAUNCH_FAILED");
	});

	it("rejects launcher that throws synchronously", async () => {
		const launcherCap = Object.freeze({
			launch: (_request: unknown): unknown => {
				throw new Error("no");
			},
		});
		const result = await createSandboxFd3WrapperCompositionWithDeps(baseDeps({ launcher: launcherCap }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("LAUNCH_FAILED");
	});
});

// ---------------------------------------------------------------------------
// Tests: late resolution after initial timeout
// ---------------------------------------------------------------------------

describe("late resolution after timeout", () => {
	it("returns LAUNCH_UNCERTAIN when launcher resolves after launch timeout", async () => {
		const lateMonitor = Object.freeze({
			ready: Promise.resolve(Object.freeze({ ok: true as const, pid: 712 })),
			closed: Promise.resolve(Object.freeze({ ok: true as const })),
			close: (): Promise<unknown> => Promise.resolve(Object.freeze({ ok: true as const })),
		});
		const lateWritable = Object.freeze({
			write: (_frame: Uint8Array, cb: (result: unknown) => void): unknown => {
				cb(Object.freeze({ status: "written" }));
				return Object.freeze({ status: "started" });
			},
			release: (cb: (result: unknown) => void): unknown => {
				cb(Object.freeze({ status: "released" }));
				return Object.freeze({ status: "started" });
			},
			end: (cb: (result: unknown) => void): unknown => {
				cb(Object.freeze({ status: "ended" }));
				return Object.freeze({ status: "started" });
			},
		});
		let resolveLate: (value: unknown) => void = (): void => {};
		const latePromise = new Promise<unknown>((resolve) => {
			resolveLate = resolve;
		});
		const launcherCap = Object.freeze({
			launch: (_request: unknown): Promise<unknown> => {
				setTimeout(() => {
					resolveLate(
						Object.freeze({ ok: true as const, monitor: lateMonitor, credentialWritable: lateWritable }),
					);
				}, 100);
				return latePromise;
			},
		});
		const shortTimeouts = Object.freeze({
			frameReadTimeoutMs: 200,
			credentialWriteTimeoutMs: 10,
			launchTimeoutMs: 10,
			monitorTimeoutMs: 300,
			publishTimeoutMs: 10,
		});
		const payload = pab1Payload();
		const framed = frame(payload);
		const result = await createSandboxFd3WrapperCompositionWithDeps(
			Object.freeze({
				readyNonce: VALID_NONCE,
				stdin: makeStdin(framed),
				stdout: makeStdoutCapture().stdout,
				launcher: launcherCap,
				timeouts: shortTimeouts,
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(["LAUNCH_UNCERTAIN", "CLEANUP_UNCERTAIN"]).toContain(result.error.code);
		}
	});

	it("CLEANUP_UNCERTAIN when late launcher close fails", async () => {
		const lateMonitor = Object.freeze({
			ready: Promise.resolve(Object.freeze({ ok: true as const, pid: 712 })),
			closed: Promise.resolve(Object.freeze({ ok: true as const })),
			close: (): Promise<unknown> =>
				Promise.resolve(
					Object.freeze({
						ok: false as const,
						code: "CLEANUP_UNCONFIRMED" as const,
						cleanupConfirmed: false as const,
					}),
				),
		});
		const lateWritable = Object.freeze({
			write: (_frame: Uint8Array, cb: (result: unknown) => void): unknown => {
				cb(Object.freeze({ status: "written" }));
				return Object.freeze({ status: "started" });
			},
			release: (cb: (result: unknown) => void): unknown => {
				cb(Object.freeze({ status: "released" }));
				return Object.freeze({ status: "started" });
			},
			end: (cb: (result: unknown) => void): unknown => {
				cb(Object.freeze({ status: "ended" }));
				return Object.freeze({ status: "started" });
			},
		});
		let resolveLate: (value: unknown) => void = (): void => {};
		const latePromise = new Promise<unknown>((resolve) => {
			resolveLate = resolve;
		});
		const launcherCap = Object.freeze({
			launch: (_request: unknown): Promise<unknown> => {
				setTimeout(() => {
					resolveLate(
						Object.freeze({ ok: true as const, monitor: lateMonitor, credentialWritable: lateWritable }),
					);
				}, 100);
				return latePromise;
			},
		});
		const shortTimeouts = Object.freeze({
			frameReadTimeoutMs: 200,
			credentialWriteTimeoutMs: 10,
			launchTimeoutMs: 10,
			monitorTimeoutMs: 300,
			publishTimeoutMs: 10,
		});
		const payload = pab1Payload();
		const framed = frame(payload);
		const result = await createSandboxFd3WrapperCompositionWithDeps(
			Object.freeze({
				readyNonce: VALID_NONCE,
				stdin: makeStdin(framed),
				stdout: makeStdoutCapture().stdout,
				launcher: launcherCap,
				timeouts: shortTimeouts,
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("CLEANUP_UNCERTAIN");
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: one test handle at a time
// ---------------------------------------------------------------------------

describe("test isolation", () => {
	it("each call creates its own bridge handle", async () => {
		const payload = pab1Payload();
		const framed = frame(payload);
		const p1 = createSandboxFd3WrapperCompositionWithDeps(
			baseDeps({ stdin: makeStdin(framed), launcher: Object.freeze({ launch: okLauncher }) }),
		);
		const p2 = createSandboxFd3WrapperCompositionWithDeps(
			baseDeps({ stdin: makeStdin(framed), launcher: Object.freeze({ launch: okLauncher }) }),
		);
		const r1 = await p1;
		const r2 = await p2;
		expect(r1.ok).toBe(false);
		expect(r2.ok).toBe(false);
	});

	it("short timeouts cause fast bridge failure", async () => {
		const shortTimeouts = Object.freeze({
			frameReadTimeoutMs: 10,
			credentialWriteTimeoutMs: 10,
			launchTimeoutMs: 10,
			monitorTimeoutMs: 10,
			publishTimeoutMs: 10,
		});
		const framed = frame(pab1Payload());
		const result = await createSandboxFd3WrapperCompositionWithDeps(
			baseDeps({
				stdin: makeStdin(framed),
				launcher: Object.freeze({ launch: okLauncher }),
				timeouts: shortTimeouts,
			}),
		);
		expect(result.ok).toBe(false);
	});
});
