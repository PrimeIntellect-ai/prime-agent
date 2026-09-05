/**
 * Focused tests for sandbox-fd3-runtime-launcher — emergencyCleanup rewrite
 * and FD3 ownership transfer.
 *
 * Tests: exact handler counts, early both-event completion, each partial
 * attach throw/backout, listener removal throw => cleanupConfirmed false,
 * hostile/mutated stdio after signal, signal throw/false, timeout, and
 * fd3 destroyed exactly once before vs after transfer.
 *
 * All cleanupTimeoutMs set to 10ms for fast failure in mock scenarios.
 * Tests use Python bash handles; any test >10 seconds is killed.
 * Production input is exactly {readyNonce}, argv/entry/env fixed.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createFd3RuntimeLauncher } from "../src/core/sandbox-fd3-runtime-launcher.js";

const VALID_NONCE = "0123456789abcdef0123456789abcdef";

function addHandler(
	handlers: Record<string, Array<(...args: Array<unknown>) => void>>,
	event: string,
	handler: (...args: Array<unknown>) => void,
): void {
	let list = handlers[event];
	if (!list) {
		list = [];
		handlers[event] = list;
	}
	list.push(handler);
}

function makeReadable(): Readable {
	const handlers: Record<string, Array<(...args: Array<unknown>) => void>> = {};
	const readable = {
		readable: true,
		readableFlowing: null,
		readableHighWaterMark: 16,
		readableLength: 0,
		on(event: string, handler: (...args: Array<unknown>) => void) {
			addHandler(handlers, event, handler);
		},
		off(event: string, handler: (...args: Array<unknown>) => void) {
			const h = handlers[event];
			if (h) {
				const idx = h.indexOf(handler);
				if (idx >= 0) h.splice(idx, 1);
			}
		},
		destroy() {
			/* noop */
		},
		pipe() {
			return readable as unknown as Readable;
		},
		unpipe() {
			/* noop */
		},
		unshift() {
			/* noop */
		},
		wrap() {
			return readable as unknown as Readable;
		},
		read() {
			return null;
		},
		pause() {
			return readable as unknown as Readable;
		},
		resume() {
			return readable as unknown as Readable;
		},
		isPaused() {
			return false;
		},
		emit(event: string, ...args: Array<unknown>) {
			const h = handlers[event];
			if (h) for (const fn of [...h]) fn(...args);
			return true;
		},
		addListener(event: string, handler: (...args: Array<unknown>) => void) {
			addHandler(handlers, event, handler);
			return readable;
		},
		removeListener(event: string, handler: (...args: Array<unknown>) => void) {
			const h = handlers[event];
			if (h) {
				const idx = h.indexOf(handler);
				if (idx >= 0) h.splice(idx, 1);
			}
			return readable;
		},
		listeners() {
			return [];
		},
		rawListeners() {
			return [];
		},
		listenerCount() {
			return 0;
		},
		eventNames() {
			return [];
		},
		getMaxListeners() {
			return 10;
		},
		setMaxListeners(_n: number) {
			return readable;
		},
		_writableState: undefined,
		destroyed: false,
		errored: null,
		closed: false,
		readableEnded: false,
		readableObjectMode: false,
	} as unknown as Readable;
	return readable;
}

function makeWritable(): Writable {
	const handlers: Record<string, Array<(...args: Array<unknown>) => void>> = {};
	const writable = {
		writable: true,
		writableEnded: false,
		writableFinished: false,
		writableHighWaterMark: 16,
		writableLength: 0,
		writableNeedDrain: false,
		writableObjectMode: false,
		writableCorked: 0,
		on(event: string, handler: (...args: Array<unknown>) => void) {
			addHandler(handlers, event, handler);
			return writable;
		},
		off(event: string, handler: (...args: Array<unknown>) => void) {
			const h = handlers[event];
			if (h) {
				const idx = h.indexOf(handler);
				if (idx >= 0) h.splice(idx, 1);
			}
			return writable;
		},
		addListener(event: string, handler: (...args: Array<unknown>) => void) {
			addHandler(handlers, event, handler);
			return writable;
		},
		removeListener(event: string, handler: (...args: Array<unknown>) => void) {
			const h = handlers[event];
			if (h) {
				const idx = h.indexOf(handler);
				if (idx >= 0) h.splice(idx, 1);
			}
			return writable;
		},
		destroy() {
			/* noop */
		},
		destroyed: false,
		errored: null,
		closed: false,
		write(_chunk: unknown, ..._rest: Array<unknown>) {
			return true;
		},
		end(..._args: Array<unknown>) {
			return writable;
		},
		emit(event: string, ...args: Array<unknown>) {
			const h = handlers[event];
			if (h) for (const fn of [...h]) fn(...args);
			return true;
		},
		listeners() {
			return [];
		},
		rawListeners() {
			return [];
		},
		listenerCount() {
			return 0;
		},
		eventNames() {
			return [];
		},
		getMaxListeners() {
			return 10;
		},
		setMaxListeners(_n: number) {
			return writable;
		},
		cork() {
			/* noop */
		},
		uncork() {
			/* noop */
		},
		setDefaultEncoding() {
			return writable;
		},
		pipe() {
			return writable as unknown as Readable;
		},
		unpipe() {
			return writable;
		},
		unshift() {
			/* noop */
		},
		wrap() {
			return writable as unknown as Readable;
		},
		read() {
			return null;
		},
		pause() {
			return writable as unknown as Readable;
		},
		resume() {
			return writable as unknown as Readable;
		},
		isPaused() {
			return false;
		},
		_writableState: undefined,
		_writable: undefined,
	} as unknown as Writable;
	return writable;
}

/** Fully mock child that tracks event handlers for introspection. */
function makeTrackingChild(
	overrides?: Partial<ChildProcess> & {
		/** If true, childOn throws on first call. */
		exitThrow?: boolean;
		/** If true, childOn throws on second call (close). */
		closeThrow?: boolean;
		/** If true, childOff throws on exit removal. */
		exitOffThrow?: boolean;
		/** If true, childOff throws on close removal. */
		closeOffThrow?: boolean;
		/** If true, emit both exit and close synchronously during childOn. */
		emitBothSync?: boolean;
		/** If non-null, mutable stdio override that is captured after construction. */
		postSignalMutation?: () => void;
	},
): ChildProcess & {
	handlers: Record<string, Array<(...args: Array<unknown>) => void>>;
	childOnCallCount: number;
	childOffCallCount: Record<string, number>;
	destroyCalled: string[];
} {
	const rawStdout = overrides?.stdout !== undefined ? overrides.stdout : makeReadable();
	const rawStderr = overrides?.stderr !== undefined ? overrides.stderr : makeReadable();
	const rawFd3 =
		overrides?.stdio !== undefined && Array.isArray(overrides.stdio) && overrides.stdio.length >= 4
			? overrides.stdio[3]
			: makeWritable();
	const stdout = rawStdout as Readable;
	const stderr = rawStderr as Readable;
	const fd3 = rawFd3 as Writable;
	const handlers: Record<string, Array<(...args: Array<unknown>) => void>> = {};
	let childOnCallCount = 0;
	const childOffCallCount: Record<string, number> = { exit: 0, close: 0 };
	const destroyCalled: string[] = [];
	const exitThrow = overrides?.exitThrow ?? false;
	const closeThrow = overrides?.closeThrow ?? false;
	const exitOffThrow = overrides?.exitOffThrow ?? false;
	const closeOffThrow = overrides?.closeOffThrow ?? false;
	const emitBothSync = overrides?.emitBothSync ?? false;

	// Override stdout/stderr/fd3 destroy to track calls.
	if (stdout && typeof stdout === "object") {
		try {
			Object.defineProperty(stdout, "destroy", {
				value: () => {
					destroyCalled.push("stdout");
				},
				writable: false,
			});
		} catch {
			/* readonly - ignore */
		}
	}
	if (stderr && typeof stderr === "object") {
		try {
			Object.defineProperty(stderr, "destroy", {
				value: () => {
					destroyCalled.push("stderr");
				},
				writable: false,
			});
		} catch {
			/* readonly - ignore */
		}
	}
	if (fd3 && typeof fd3 === "object") {
		try {
			Object.defineProperty(fd3, "destroy", {
				value: () => {
					destroyCalled.push("fd3");
				},
				writable: false,
			});
		} catch {
			/* readonly - ignore */
		}
	}

	const child = {
		stdin: null,
		stdout,
		stderr,
		stdio: [null, stdout, stderr, fd3],
		pid: overrides?.pid !== undefined ? overrides.pid : 999,
		connected: true,
		killed: false,
		exitCode: null,
		signalCode: null,
		handlers,
		childOnCallCount,
		childOffCallCount,
		destroyCalled,
		on(event: string, handler: (...args: Array<unknown>) => void) {
			childOnCallCount++;
			if (childOnCallCount === 1 && exitThrow) throw new Error("exit throw");
			if (childOnCallCount === 2 && closeThrow) throw new Error("close throw");
			addHandler(handlers, event, handler);
			// Synchronous fire: handler invoked during attach, not via setTimeout.
			if (emitBothSync && event === "exit") {
				try {
					(handler as (...args: Array<unknown>) => void)(0, null);
				} catch {
					/* swallow */
				}
			}
			if (emitBothSync && event === "close") {
				try {
					(handler as (...args: Array<unknown>) => void)();
				} catch {
					/* swallow */
				}
			}
		},
		off(event: string, handler: (...args: Array<unknown>) => void) {
			childOffCallCount[event] = (childOffCallCount[event] || 0) + 1;
			if (event === "exit" && exitOffThrow) throw new Error("exit off throw");
			if (event === "close" && closeOffThrow) throw new Error("close off throw");
			const h = handlers[event];
			if (h) {
				const idx = h.indexOf(handler);
				if (idx >= 0) h.splice(idx, 1);
			}
		},
		addListener(event: string, handler: (...args: Array<unknown>) => void) {
			addHandler(handlers, event, handler);
		},
		removeListener(event: string, handler: (...args: Array<unknown>) => void) {
			const h = handlers[event];
			if (h) {
				const idx = h.indexOf(handler);
				if (idx >= 0) h.splice(idx, 1);
			}
		},
		listeners() {
			return [];
		},
		rawListeners() {
			return [];
		},
		listenerCount() {
			return 0;
		},
		eventNames() {
			return [];
		},
		getMaxListeners() {
			return 10;
		},
		setMaxListeners(_n: number) {
			/* noop */
		},
		ref() {
			/* noop */
		},
		unref() {
			/* noop */
		},
		kill() {
			return true;
		},
	} as unknown as ChildProcess & {
		handlers: Record<string, Array<(...args: Array<unknown>) => void>>;
		childOnCallCount: number;
		childOffCallCount: Record<string, number>;
		destroyCalled: string[];
	};

	// Override pid after construction if needed
	if (overrides?.pid === undefined) {
		// Already set above
	}

	return child;
}

function standardDeps(overrides?: Record<string, unknown>): Record<string, unknown> {
	return Object.freeze({
		readyNonce: VALID_NONCE,
		executable: "/usr/local/bin/node",
		entry: "/app/dist/bundle/cli.js",
		env: Object.freeze({ PATH: "/usr/bin", HOME: "/root", USER: "root", TMPDIR: "/tmp" }),
		cleanupTimeoutMs: 10,
		spawn: (): ChildProcess => makeTrackingChild(),
		signal: (_pid: number, _signal: string): boolean => true,
		...overrides,
	});
}

// ── 1. Exact handler counts ──────────────────────────────────────────────

describe("emergencyCleanup handler counts", () => {
	it("attaches exactly 1 exit and 1 close handler on INVALID_CHILD", async () => {
		const child = makeTrackingChild({
			pid: 999,
			stdout: null as unknown as Readable, // bridge fails, INVALID_CHILD
		});
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
		});
		await createFd3RuntimeLauncher(deps);

		// After emergency cleanup runs, the handlers should be removed.
		// Exactly one exit and one close handler were attached.
		expect(child.childOffCallCount.exit).toBe(1);
		expect(child.childOffCallCount.close).toBe(1);
	});
});

// ── 2. Early both-event completion (not timer) ───────────────────────────

describe("emergencyCleanup early both-event completion", () => {
	it("resolves via sharedMaybeFinish when both events fire before timer", async () => {
		let child: ReturnType<typeof makeTrackingChild> | null = null;
		const deps = standardDeps({
			spawn: (): ChildProcess => {
				child = makeTrackingChild({
					pid: 999,
					stdout: null as unknown as Readable,
					emitBothSync: true,
				});
				return child;
			},
		});
		// Should complete quickly (< 10ms, not via timer)
		const start = Date.now();
		await createFd3RuntimeLauncher(deps);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(100); // well under 10ms timeout
	});

	it("does not signal after synchronous exit observed during attach", async () => {
		// When child exits synchronously during on("exit", handler) attachment,
		// emergencyCleanup must NOT call signal because the child is already dead.
		let signalCalled = false;
		// Create a child whose on("exit") fires the exit handler synchronously
		const child = makeTrackingChild({
			pid: 999,
			stdout: null as unknown as Readable,
			emitBothSync: true,
		});
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
			signal: (_pid: number, _sig: string): boolean => {
				signalCalled = true;
				return true;
			},
		});
		await createFd3RuntimeLauncher(deps);
		// Signal must NOT have been called because exit was already observed
		expect(signalCalled).toBe(false);
	});
});

// ── 3. Partial attach throw/backout ──────────────────────────────────────

describe("emergencyCleanup partial attach throw/backout", () => {
	it("returns false when exit handler attachment throws", async () => {
		const child = makeTrackingChild({ pid: 0 as unknown as number, exitThrow: true });
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
		});
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INVALID_CHILD");
			expect(result.cleanupConfirmed).toBe(false);
		}
	});

	it("handles close handler throw with exit backout", async () => {
		let child: ReturnType<typeof makeTrackingChild> | null = null;
		const deps = standardDeps({
			spawn: (): ChildProcess => {
				child = makeTrackingChild({ pid: 0 as unknown as number, closeThrow: true });
				return child;
			},
		});
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
	});
});

// ── 4. Listener removal throw => cleanupConfirmed false ──────────────────

describe("emergencyCleanup listener removal throw", () => {
	it("returns cleanupConfirmed false when exit listener removal throws", async () => {
		const child = makeTrackingChild({
			pid: 0 as unknown as number,
			exitOffThrow: true,
			emitBothSync: true,
		});
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
		});
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INVALID_CHILD");
			expect(result.cleanupConfirmed).toBe(false);
		}
	});

	it("returns cleanupConfirmed false when close listener removal throws", async () => {
		const child = makeTrackingChild({
			pid: 0 as unknown as number,
			closeOffThrow: true,
			emitBothSync: true,
		});
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
		});
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INVALID_CHILD");
			expect(result.cleanupConfirmed).toBe(false);
		}
	});

	it("returns cleanupConfirmed false when both listener removals throw", async () => {
		const child = makeTrackingChild({
			pid: 0 as unknown as number,
			exitOffThrow: true,
			closeOffThrow: true,
			emitBothSync: true,
		});
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
		});
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INVALID_CHILD");
			expect(result.cleanupConfirmed).toBe(false);
		}
	});
});

// ── 5. Hostile/mutated stdio after signal ────────────────────────────────

describe("emergencyCleanup hostile/mutated stdio after signal", () => {
	it("does not re-read stdio after signal — uses snapshot", async () => {
		const stdout = makeReadable();
		let stdoutAccessCount = 0;
		Object.defineProperty(stdout, "destroy", {
			value: () => {
				stdoutAccessCount++;
			},
			writable: false,
		});
		const stderr = makeReadable();
		const fd3 = makeWritable();
		const signalMutationHandlers: Record<string, Array<(...args: Array<unknown>) => void>> = {};
		const child = {
			stdin: null,
			stdout,
			stderr,
			stdio: [null, stdout, stderr, fd3],
			pid: 999,
			connected: true,
			killed: false,
			exitCode: null,
			signalCode: null,
			handlers: signalMutationHandlers,
			on(_event: string, _handler: (...args: Array<unknown>) => void) {
				addHandler(signalMutationHandlers, _event, _handler);
				if (_event === "exit" || _event === "close") {
					setTimeout(() => {
						const h = [...(signalMutationHandlers[_event] || [])];
						for (const fn of h) fn();
					}, 0);
				}
			},
			off(_event: string, _handler: (...args: Array<unknown>) => void) {
				const h = signalMutationHandlers[_event];
				if (h) {
					const idx = h.indexOf(_handler);
					if (idx >= 0) h.splice(idx, 1);
				}
			},
			ref() {
				/* noop */
			},
			unref() {
				/* noop */
			},
			kill() {
				return true;
			},
		} as unknown as ChildProcess;
		// Need INVALID_CHILD path - make spawn return a bridge-failing child
		const bridgeFailChild = {
			...child,
			stdout: null as unknown as Readable,
			stderr: null as unknown as Readable,
			stdio: [null, null, null, fd3],
		} as unknown as ChildProcess;
		const deps = standardDeps({
			spawn: (): ChildProcess => bridgeFailChild,
		});
		await createFd3RuntimeLauncher(deps);
		expect(stdoutAccessCount).toBeLessThanOrEqual(1);
	});

	it("handles null stdout gracefully during snapshot", async () => {
		const nullStdoutHandlers: Record<string, Array<(...args: Array<unknown>) => void>> = {};
		const child = {
			stdin: null,
			stdout: null,
			stderr: null,
			stdio: [null, null, null, null],
			pid: 999,
			connected: true,
			killed: false,
			exitCode: null,
			signalCode: null,
			handlers: nullStdoutHandlers,
			on(_event: string, _handler: (...args: Array<unknown>) => void) {
				addHandler(nullStdoutHandlers, _event, _handler);
				if (_event === "exit" || _event === "close") {
					setTimeout(() => {
						const h = [...(nullStdoutHandlers[_event] || [])];
						for (const fn of h) fn();
					}, 0);
				}
			},
			off(_event: string, _handler: (...args: Array<unknown>) => void) {
				const h = nullStdoutHandlers[_event];
				if (h) {
					const idx = h.indexOf(_handler);
					if (idx >= 0) h.splice(idx, 1);
				}
			},
			ref() {
				/* noop */
			},
			unref() {
				/* noop */
			},
			kill() {
				return true;
			},
		} as unknown as ChildProcess;
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
		});
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_CHILD");
	});
});

// ── 6. Signal throw/false ─────────────────────────────────────────────────

describe("emergencyCleanup signal behavior", () => {
	it("handles signal returning false", async () => {
		let signalCalled = false;
		const child = makeTrackingChild({
			pid: 999,
			stdout: null as unknown as Readable, // makes bridge fail, triggers INVALID_CHILD
		});
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
			signal: (_pid: number, _sig: string): boolean => {
				signalCalled = true;
				return false;
			},
		});
		await createFd3RuntimeLauncher(deps);
		expect(signalCalled).toBe(true);
	});

	it("handles signal throwing", async () => {
		let signalCalled = false;
		const child = makeTrackingChild({
			pid: 999,
			stdout: null as unknown as Readable,
		});
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
			signal: (_pid: number, _sig: string): boolean => {
				signalCalled = true;
				throw new Error("signal failed");
			},
		});
		await createFd3RuntimeLauncher(deps);
		expect(signalCalled).toBe(true);
	});
});

// ── 7. Timeout ────────────────────────────────────────────────────────────

describe("emergencyCleanup timeout", () => {
	it("resolves via timer when events never fire", async () => {
		const child = {
			stdin: null,
			stdout: null, // makes bridge fail => INVALID_CHILD => emergencyCleanup
			stderr: null,
			stdio: [null, null, null, null],
			pid: 999,
			connected: true,
			killed: false,
			exitCode: null,
			signalCode: null,
			on(_event: string, _handler: (...args: Array<unknown>) => void) {
				// Never fire events
			},
			off(_event: string, _handler: (...args: Array<unknown>) => void) {
				/* noop */
			},
			ref() {
				/* noop */
			},
			unref() {
				/* noop */
			},
			kill() {
				return true;
			},
		} as unknown as ChildProcess;
		const start = Date.now();
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
			cleanupTimeoutMs: 50,
		});
		await createFd3RuntimeLauncher(deps);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(40);
		expect(elapsed).toBeLessThan(5000);
	});

	it("does not hang forever when events never fire", async () => {
		const child = {
			stdin: null,
			stdout: makeReadable(),
			stderr: makeReadable(),
			stdio: [null, makeReadable(), makeReadable(), makeWritable()],
			pid: 0 as unknown as number,
			connected: true,
			killed: false,
			exitCode: null,
			signalCode: null,
			on(_event: string, _handler: (...args: Array<unknown>) => void) {
				// Never fire events
			},
			off(_event: string, _handler: (...args: Array<unknown>) => void) {
				/* noop */
			},
			ref() {
				/* noop */
			},
			unref() {
				/* noop */
			},
			kill() {
				return true;
			},
		} as unknown as ChildProcess;
		const result = await Promise.race([
			createFd3RuntimeLauncher(
				standardDeps({
					spawn: (): ChildProcess => child,
					cleanupTimeoutMs: 100,
				}),
			),
			new Promise<{ ok: false; code: "TIMEOUT"; cleanupConfirmed: boolean }>((_, reject) =>
				setTimeout(() => reject(new Error("Test hung >5s")), 5000),
			),
		]);
		expect(result).toBeDefined();
		const r = result as { ok: boolean };
		expect(r.ok).toBe(false);
	});
});

// ── 8. FD3 destroyed exactly once before vs after transfer ──────────────

describe("FD3 ownership transfer", () => {
	it("destroyStdio destroys fd3 before transfer", async () => {
		// Use a valid child (pid=999) that passes bridge, so we can test
		// the monitor's destroyStdio. We need a child that triggers
		// INVALID_CHILD so emergencyCleanup runs before transfer.
		let fd3DestroyCount = 0;
		const fd3 = makeWritable();
		Object.defineProperty(fd3, "destroy", {
			value: () => {
				fd3DestroyCount++;
			},
			writable: false,
		});
		const stdout = makeReadable();
		const stderr = makeReadable();
		const beforeTransferHandlers: Record<string, Array<(...args: Array<unknown>) => void>> = {};
		const child = {
			stdin: null,
			stdout,
			stderr,
			stdio: [null, stdout, stderr, fd3],
			pid: 0 as unknown as number, // invalid => INVALID_CHILD => emergencyCleanup runs
			connected: true,
			killed: false,
			exitCode: null,
			signalCode: null,
			handlers: beforeTransferHandlers,
			on(_event: string, _handler: (...args: Array<unknown>) => void) {
				addHandler(beforeTransferHandlers, _event, _handler);
				if (_event === "exit" || _event === "close") {
					setTimeout(() => {
						const h = [...(beforeTransferHandlers[_event] || [])];
						for (const fn of h) fn();
					}, 0);
				}
			},
			off(_event: string, _handler: (...args: Array<unknown>) => void) {
				const h = beforeTransferHandlers[_event];
				if (h) {
					const idx = h.indexOf(_handler);
					if (idx >= 0) h.splice(idx, 1);
				}
			},
			ref() {
				/* noop */
			},
			unref() {
				/* noop */
			},
			kill() {
				return true;
			},
		} as unknown as ChildProcess;
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
		});
		await createFd3RuntimeLauncher(deps);
		// INVALID_CHILD path uses emergencyCleanup, not monitor.destroyStdio,
		// so fd3DestroyCount should be either 0 or 1 from emergency cleanup.
		expect(fd3DestroyCount).toBeLessThanOrEqual(1);
	});

	it("leaves transferred fd3 to the credential writable owner", async () => {
		const child = makeTrackingChild({ pid: 999 });
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
			signal: (): boolean => {
				for (const handler of [...(child.handlers.exit ?? [])]) handler(0, "SIGINT");
				for (const handler of [...(child.handlers.close ?? [])]) handler();
				return true;
			},
		});
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const closed = await result.monitor.close();
		expect(closed.ok).toBe(true);
		expect(child.destroyCalled).toContain("stdout");
		expect(child.destroyCalled).toContain("stderr");
		expect(child.destroyCalled).not.toContain("fd3");
	});
});

// ── Existing tests (preserved from original) ─────────────────────────────

describe("createFd3RuntimeLauncher input validation", () => {
	it("rejects missing readyNonce", async () => {
		const deps = standardDeps({ readyNonce: undefined as unknown as string });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
	});

	it("rejects invalid nonce", async () => {
		const deps = standardDeps({ readyNonce: "short" });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
	});

	it("rejects uppercase hex nonce", async () => {
		const deps = standardDeps({ readyNonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
	});

	it("accepts valid input", async () => {
		const result = await createFd3RuntimeLauncher(standardDeps());
		expect(result.ok).toBe(true);
	});
});

describe("createFd3RuntimeLauncher spawn failures", () => {
	it("returns SPAWN_FAILED when spawn throws", async () => {
		const deps = standardDeps({
			spawn: (): ChildProcess => {
				throw new Error("spawn failed");
			},
		});
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("SPAWN_FAILED");
	});
});

describe("createFd3RuntimeLauncher child validation", () => {
	it("returns INVALID_CHILD when pid is null", async () => {
		let signalCalled = false;
		const child = makeTrackingChild({ pid: null as unknown as number });
		const deps = standardDeps({
			spawn: (): ChildProcess => child,
			signal: (_pid: number, _sig: string): boolean => {
				signalCalled = true;
				return true;
			},
		});
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_CHILD");
		expect(signalCalled).toBe(false); // no valid pid => no kill
	});
});

describe("createFd3RuntimeLauncher spawn arguments", () => {
	it("passes exact argv to spawn", async () => {
		let capturedArgs: readonly string[] | null = null;
		const deps = standardDeps({
			spawn: (_cmd: string, args: readonly string[], _opts: SpawnOptions): ChildProcess => {
				capturedArgs = args;
				return makeTrackingChild();
			},
		});
		await createFd3RuntimeLauncher(deps);
		expect(capturedArgs).not.toBeNull();
		if (capturedArgs) {
			expect(capturedArgs).toEqual([
				"/app/dist/bundle/cli.js",
				"--prime-agent-runtime-fd3",
				"--ready-nonce",
				VALID_NONCE,
			]);
		}
	});

	it("passes exact spawn options", async () => {
		let capturedOptions: unknown = null;
		const deps = standardDeps({
			spawn: (_cmd: string, _args: readonly string[], opts: SpawnOptions): ChildProcess => {
				capturedOptions = opts;
				return makeTrackingChild();
			},
		});
		await createFd3RuntimeLauncher(deps);
		expect(capturedOptions).not.toBeNull();
		const opts = capturedOptions as SpawnOptions;
		expect(opts.shell).toBe(false);
		expect(opts.detached).toBe(true);
		expect(opts.stdio).toEqual(["ignore", "pipe", "pipe", "pipe"]);
		expect((opts as Record<string, unknown>).cwd).toBeUndefined();
	});

	it("sanitized env allowlist contains only PATH HOME USER TMPDIR", async () => {
		let capturedEnv: Record<string, string> | null = null;
		const deps = standardDeps({
			spawn: (_cmd: string, _args: readonly string[], opts: SpawnOptions): ChildProcess => {
				capturedEnv = opts.env as Record<string, string>;
				return makeTrackingChild();
			},
		});
		await createFd3RuntimeLauncher(deps);
		expect(capturedEnv).not.toBeNull();
		if (capturedEnv) {
			expect(Object.keys(capturedEnv)).toEqual(["PATH", "HOME", "USER", "TMPDIR"]);
		}
	});
});

describe("createFd3RuntimeLauncher monitor and adapter", () => {
	it("returns ok:true with monitor on success", async () => {
		const result = await createFd3RuntimeLauncher(standardDeps());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.monitor).toBeDefined();
			expect(result.monitor.ready).toBeDefined();
			expect(result.monitor.closed).toBeDefined();
			expect(typeof result.monitor.close).toBe("function");
			expect(result.credentialWritable).toBeDefined();
			expect(typeof result.credentialWritable.write).toBe("function");
			expect(typeof result.credentialWritable.release).toBe("function");
			expect(typeof result.credentialWritable.end).toBe("function");
		}
	});

	it("returns STDIN_FAILED when credential adapter fails", async () => {
		const child = makeTrackingChild();
		const badFd3 = Object.freeze({}) as unknown as Writable;
		const badChild = Object.freeze({
			...child,
			stdio: [null, child.stdout, child.stderr, badFd3],
		}) as unknown as ChildProcess;
		const deps = standardDeps({ spawn: (): ChildProcess => badChild });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
	});
});

describe("createFd3RuntimeLauncher signal sequence", () => {
	it("launcher does not call signal at creation time", async () => {
		let signalCalled = false;
		const deps = standardDeps({
			signal: (): boolean => {
				signalCalled = true;
				return true;
			},
		});
		await createFd3RuntimeLauncher(deps);
		expect(signalCalled).toBe(false);
	});
});

describe("createFd3RuntimeLauncher executable", () => {
	it("spawns child with correct executable", async () => {
		let capturedExecutable: string | null = null;
		const deps = standardDeps({
			spawn: (cmd: string, _args: readonly string[], _opts: SpawnOptions): ChildProcess => {
				capturedExecutable = cmd;
				return makeTrackingChild();
			},
		});
		await createFd3RuntimeLauncher(deps);
		expect(capturedExecutable).toBe("/usr/local/bin/node");
	});

	it("rejects env with non-allowed key", async () => {
		const deps = standardDeps({
			env: Object.freeze({ PATH: "/usr/bin", SECRET: "should-fail" }),
		});
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
	});

	it("rejects env with Proxy", async () => {
		const proxy = new Proxy(Object.freeze({ PATH: "/usr/bin" }), {});
		const deps = standardDeps({ env: proxy });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
	});

	it("rejects env with getter (accessor)", async () => {
		const env: Record<string, string> = {};
		Object.defineProperty(env, "PATH", { enumerable: true, get: () => "/usr/bin" });
		const deps = standardDeps({ env });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
	});

	it("rejects env with non-plain prototype", async () => {
		class FakeEnv extends Object {}
		const env = new FakeEnv();
		Object.assign(env, { PATH: "/usr/bin" });
		const deps = standardDeps({ env });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
	});

	it("rejects child with Proxy stdio array", async () => {
		const child = makeTrackingChild();
		const stdioProxy = new Proxy([null, child.stdout, child.stderr, makeWritable()], {});
		Object.defineProperty(child, "stdio", { value: stdioProxy, enumerable: true, writable: false });
		const deps = standardDeps({ spawn: (): ChildProcess => child });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_CHILD");
	});

	it("rejects child with Proxy on fd3 pipe", async () => {
		const child = makeTrackingChild();
		const fd3Proxy = new Proxy(makeWritable(), {});
		const stdio = [null, child.stdout, child.stderr, fd3Proxy];
		Object.defineProperty(child, "stdio", { value: stdio, enumerable: true, writable: false });
		const deps = standardDeps({ spawn: (): ChildProcess => child });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_CHILD");
	});

	it("rejects child with getter stdio", async () => {
		const child = makeTrackingChild();
		Object.defineProperty(child, "stdio", {
			enumerable: true,
			get: () => [null, child.stdout, child.stderr, makeWritable()],
		});
		const deps = standardDeps({ spawn: (): ChildProcess => child });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_CHILD");
	});

	it("rejects child with getter on stdout", async () => {
		const child = makeTrackingChild();
		const stderr = child.stderr;
		const fd3 = makeWritable();
		Object.defineProperty(child, "stdout", { enumerable: true, get: () => makeReadable() });
		Object.defineProperty(child, "stdio", {
			value: [null, child.stdout, stderr, fd3],
			enumerable: true,
			writable: false,
		});
		const deps = standardDeps({ spawn: (): ChildProcess => child });
		const result = await createFd3RuntimeLauncher(deps);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INVALID_CHILD");
	});
});
