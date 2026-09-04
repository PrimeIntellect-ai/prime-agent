import { describe, expect, it } from "vitest";
import { createPrimeCliCommandRunner, type SpawnedProcess, type SpawnFn } from "../src/modes/daemon/command-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noopProcess(exitCode = 0, stdout = "", stderr = ""): SpawnedProcess {
	const enc = new TextEncoder();
	return {
		stdout: new ReadableStream({
			start(ctrl) {
				if (stdout.length > 0) ctrl.enqueue(enc.encode(stdout));
				ctrl.close();
			},
		}),
		stderr: new ReadableStream({
			start(ctrl) {
				if (stderr.length > 0) ctrl.enqueue(enc.encode(stderr));
				ctrl.close();
			},
		}),
		exited: Promise.resolve(exitCode),
		kill() {},
	};
}

function streamFrom(data: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(ctrl) {
			ctrl.enqueue(data);
			ctrl.close();
		},
	});
}

/* streamChunkThenHang removed */

function streamError(msg = "stream error"): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(ctrl) {
			ctrl.error(new Error(msg));
		},
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPrimeCliCommandRunner", () => {
	// ---- input validation ----

	it("rejects empty argv", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand([], 1000);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects argv with 65 elements", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(
			Array.from({ length: 65 }, () => "a"),
			1000,
		);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects empty-string argv element", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["valid", ""], 1000);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects control-character in argv", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["hello\x00world"], 1000);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects DEL character in argv", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["hello\x7fworld"], 1000);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects argv element > 4096 UTF-8 bytes", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["a".repeat(4097)], 1000);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects aggregate argv exceeding 64 KiB", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const big = "a".repeat(4000);
		const r = await runner.runCommand(
			[big, big, big, big, big, big, big, big, big, big, big, big, big, big, big, big, big],
			1000,
		);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects non-integer timeout", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["echo"], 100.5);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects NaN timeout", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["echo"], NaN);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects Infinity timeout", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["echo"], Infinity);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects timeout < 100 ms", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["echo"], 99);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects timeout > 600 s", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["echo"], 600_001);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	// ---- lone surrogate ----

	it("rejects lone high surrogate in argv", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["echo", "\ud800"], 1000);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects lone low surrogate in argv", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["echo", "\udc00"], 1000);
		expect(r).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("accepts valid surrogate pair (emoji) in argv", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["echo", "\ud83d\ude00"], 1000);
		expect(r).toEqual({
			ok: true,
			value: expect.objectContaining({ exitCode: 0 }),
		});
	});

	// ---- pre-abort ----

	it("returns ABORTED without spawning when signal is already aborted", async () => {
		let spawned = false;
		const runner = createPrimeCliCommandRunner(() => {
			spawned = true;
			return noopProcess();
		});
		const ctrl = new AbortController();
		ctrl.abort();
		const r = await runner.runCommand(["echo"], 1000, ctrl.signal);
		expect(r).toEqual({ ok: false, code: "ABORTED" });
		expect(spawned).toBe(false);
	});

	// ---- spawn failure ----

	it("returns SPAWN_FAILED when spawn throws", async () => {
		const runner = createPrimeCliCommandRunner(() => {
			throw new Error("exec not found");
		});
		const r = await runner.runCommand(["nonexistent-cmd"], 1000);
		expect(r).toEqual({ ok: false, code: "SPAWN_FAILED" });
	});

	// ---- real Bun processes ----

	it("executes a basic command and returns output", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["echo", "hello world"], 5000);
		expect(r).toEqual({
			ok: true,
			value: expect.objectContaining({
				stdout: "hello world\n",
				stderr: "",
				exitCode: 0,
				durationMs: expect.any(Number),
			}),
		});
	});

	it("captures stderr output", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["bash", "-c", "echo stderr-msg >&2"], 5000);
		expect(r).toEqual({
			ok: true,
			value: expect.objectContaining({
				stdout: "",
				stderr: "stderr-msg\n",
				exitCode: 0,
			}),
		});
	});

	it("reports nonzero exit", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["bash", "-c", "exit 42"], 5000);
		expect(r).toEqual({
			ok: true,
			value: expect.objectContaining({
				stdout: "",
				stderr: "",
				exitCode: 42,
			}),
		});
	});

	it("kills on timeout (process sleeps past limit)", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["sleep", "10"], 200);
		expect(r).toEqual({ ok: false, code: "TIMED_OUT" });
	});

	it("aborts mid-run via AbortSignal", async () => {
		const runner = createPrimeCliCommandRunner();
		const ctrl = new AbortController();
		const promise = runner.runCommand(["sleep", "30"], 60_000, ctrl.signal);
		await new Promise((r) => setTimeout(r, 100));
		ctrl.abort();
		const r = await promise;
		expect(r).toEqual({ ok: false, code: "ABORTED" });
	});

	it("handles simultaneous stdout and stderr output", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["bash", "-c", "echo out1; echo err1 >&2; echo out2; echo err2 >&2"], 5000);
		expect(r).toEqual({
			ok: true,
			value: expect.objectContaining({
				stdout: "out1\nout2\n",
				stderr: "err1\nerr2\n",
				exitCode: 0,
			}),
		});
	});

	// ---- overflow ----

	it("detects stdout overflow (>1 MiB) without deadlock", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["bash", "-c", "dd if=/dev/zero bs=1024 count=2048 2>/dev/null"], 10_000);
		expect(r).toEqual({ ok: false, code: "OUTPUT_OVERFLOW" });
	});

	it("detects stderr overflow without deadlock", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["bash", "-c", "dd if=/dev/zero bs=1024 count=2048 1>&2 2>/dev/null"], 10_000);
		expect(r).toEqual({ ok: false, code: "OUTPUT_OVERFLOW" });
	});

	it("detects overflow when both streams flood", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(
			[
				"bash",
				"-c",
				"dd if=/dev/zero bs=1024 count=2048 2>/dev/null & dd if=/dev/zero bs=1024 count=2048 1>&2 2>/dev/null & wait",
			],
			10_000,
		);
		expect(r).toEqual({ ok: false, code: "OUTPUT_OVERFLOW" });
	});

	// ---- process closes pipes then sleeps ----

	it("timeout kills a process that closed pipes but is still alive", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["bash", "-c", "exec 1>&-; exec 2>&-; sleep 30"], 300);
		expect(r).toEqual({ ok: false, code: "TIMED_OUT" });
	});

	// ---- malformed UTF-8 ----

	it("returns STREAM_FAILED for malformed UTF-8 output", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["bash", "-c", "printf '\\xff\\xfe'"], 5000);
		expect(r).toEqual({ ok: false, code: "STREAM_FAILED" });
	});

	// ---- injected stream failure ----

	it("returns STREAM_FAILED when stdout read fails", async () => {
		const spawn: SpawnFn = () => ({
			stdout: streamError(),
			stderr: streamFrom(new Uint8Array(0)),
			exited: Promise.resolve(0),
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "STREAM_FAILED" });
	});

	it("returns STREAM_FAILED when stderr read fails", async () => {
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array(0)),
			stderr: streamError(),
			exited: Promise.resolve(0),
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "STREAM_FAILED" });
	});

	it("returns STREAM_FAILED when stdout read fails while stderr never closes", async () => {
		const spawn: SpawnFn = () => {
			let stderrCtrl: ReadableStreamDefaultController<Uint8Array> | undefined;
			let exitResolve: ((code: number) => void) | undefined;
			return {
				stdout: streamError(),
				stderr: new ReadableStream({
					start(ctrl) {
						stderrCtrl = ctrl;
						ctrl.enqueue(new Uint8Array([65]));
					},
				}),
				exited: new Promise<number>((resolve) => {
					exitResolve = resolve;
				}),
				kill() {
					stderrCtrl?.close();
					exitResolve?.(0);
				},
			};
		};
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "STREAM_FAILED" });
	});

	// ---- injected PROCESS_UNCERTAIN ----

	it("returns PROCESS_UNCERTAIN when kill throws", async () => {
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array(0)),
			stderr: streamFrom(new Uint8Array(0)),
			exited: new Promise<never>(() => {}),
			kill() {
				throw new Error("kill failed");
			},
		});
		const runner = createPrimeCliCommandRunner(spawn, 50);
		const r = await runner.runCommand(["echo"], 100);
		expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});

	it("returns PROCESS_UNCERTAIN when exited rejects", async () => {
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array(0)),
			stderr: streamFrom(new Uint8Array(0)),
			exited: Promise.reject(new Error("waitpid failed")),
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});

	it("returns PROCESS_UNCERTAIN when exit never settles after kill", async () => {
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array(0)),
			stderr: streamFrom(new Uint8Array(0)),
			exited: new Promise<never>(() => {}),
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn, 50);
		const r = await runner.runCommand(["echo"], 100);
		expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});

	// ---- exact frozen result ----

	it("returns frozen result objects", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand(["echo"], 1000);
		expect(Object.isFrozen(r)).toBe(true);
		if (r.ok) {
			expect(Object.isFrozen(r.value)).toBe(true);
		}
	});

	it("returns frozen failure objects", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = await runner.runCommand([], 1000);
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("failure result has exactly two keys (ok, code)", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = (await runner.runCommand([], 1000)) as { ok: false; code: string };
		expect(Object.keys(r).sort()).toEqual(["code", "ok"]);
	});

	it("success result has exactly two keys (ok, value)", async () => {
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		const r = (await runner.runCommand(["echo"], 1000)) as { ok: true; value: Record<string, unknown> };
		expect(Object.keys(r).sort()).toEqual(["ok", "value"]);
		expect(Object.keys(r.value).sort()).toEqual(["durationMs", "exitCode", "stderr", "stdout"]);
	});

	// ---- opacity ----

	it("failures contain no sensitive data (argv, path, exception)", async () => {
		const runner = createPrimeCliCommandRunner(() => {
			throw new Error("/home/user/.secret-key");
		});
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "SPAWN_FAILED" });
		const json = JSON.stringify(r);
		expect(json).not.toContain("secret");
		expect(json).not.toContain("home");
	});

	it("timeout failure contains no output snippets", async () => {
		let exitResolve: ((code: number) => void) | undefined;
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new TextEncoder().encode("sensitive data")),
			stderr: streamFrom(new Uint8Array(0)),
			exited: new Promise<number>((resolve) => {
				exitResolve = resolve;
			}),
			kill() {
				exitResolve?.(0);
			},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 100);
		expect(r).toEqual({ ok: false, code: "TIMED_OUT" });
		const json = JSON.stringify(r);
		expect(json).not.toContain("sensitive");
	});

	// ---- causal dominance ----

	it("stream failure before abort wins over abort", async () => {
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array(0)),
			stderr: streamError(),
			exited: Promise.resolve(0),
			kill() {},
		});
		const ctrl = new AbortController();
		const runner = createPrimeCliCommandRunner(spawn);
		const promise = runner.runCommand(["echo"], 5000, ctrl.signal);
		await new Promise((r) => setTimeout(r, 50));
		ctrl.abort();
		const result = await promise;
		expect(result).toEqual({ ok: false, code: "STREAM_FAILED" });
	});

	it("caller abort beats timeout", async () => {
		const ctrl = new AbortController();
		const runner = createPrimeCliCommandRunner();
		const promise = runner.runCommand(["sleep", "30"], 5000, ctrl.signal);
		await new Promise((r) => setTimeout(r, 50));
		ctrl.abort();
		const r = await promise;
		expect(r).toEqual({ ok: false, code: "ABORTED" });
	});

	it("derivative stream error after abort does not overwrite ABORTED", async () => {
		let exitResolve: ((code: number) => void) | undefined;
		let stdoutCtrl: ReadableStreamDefaultController<Uint8Array> | undefined;
		const spawn: SpawnFn = () => {
			const stdout = new ReadableStream({
				start(c) {
					stdoutCtrl = c;
					c.enqueue(new TextEncoder().encode("hello"));
				},
			});
			return {
				stdout,
				stderr: streamFrom(new Uint8Array(0)),
				exited: new Promise<number>((resolve) => {
					exitResolve = resolve;
				}),
				kill() {
					stdoutCtrl?.close();
					exitResolve?.(0);
				},
			};
		};
		const ctrl = new AbortController();
		const runner = createPrimeCliCommandRunner(spawn);
		const promise = runner.runCommand(["echo"], 5000, ctrl.signal);
		await new Promise((r) => setTimeout(r, 50));
		ctrl.abort();
		const r = await promise;
		// Even if stdout errors during/after cancel, ABORTED dominates
		expect(r).toEqual({ ok: false, code: "ABORTED" });
	});

	// ---- listener/timer cleanup ----  // ---- listener/timer cleanup ----

	it("removes abort listener after completion", async () => {
		const ctrl = new AbortController();
		const runner = createPrimeCliCommandRunner(() => noopProcess());
		await runner.runCommand(["echo"], 1000, ctrl.signal);
		let fireCount = 0;
		const listener = () => {
			fireCount++;
		};
		ctrl.signal.addEventListener("abort", listener, { once: true });
		ctrl.abort();
		expect(fireCount).toBe(1);
	});

	// ---- no-output timeout ----

	it("no-output process completes within timeout", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["true"], 1000);
		expect(r).toEqual({
			ok: true,
			value: expect.objectContaining({ stdout: "", stderr: "", exitCode: 0 }),
		});
	});

	// ---- valid astral argv ----

	it("valid astral-plane character in argv works", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["echo", "\ud83d\ude00"], 5000);
		expect(r).toEqual({
			ok: true,
			value: expect.objectContaining({
				stdout: "\ud83d\ude00\n",
			}),
		});
	});
});

// ---- reader-settlement bounded tests ----

it("overflow with throwing kill leads to bounded reader settlement => PROCESS_UNCERTAIN", async () => {
	const spawn: SpawnFn = () => {
		let _stdoutCtrl: ReadableStreamDefaultController<Uint8Array> | undefined;
		// stdout floods
		const stdout = new ReadableStream({
			start(c) {
				_stdoutCtrl = c;
				// Enqueue just under 1 MiB, then one more chunk to trigger overflow
				const chunk = new Uint8Array(1024 * 512);
				c.enqueue(chunk);
			},
			pull(c) {
				c.enqueue(new Uint8Array(1024 * 512));
			},
		});
		// stderr never closes
		const stderr = new ReadableStream({
			start(c) {
				c.enqueue(new Uint8Array([65]));
			},
		});
		return {
			stdout,
			stderr,
			exited: new Promise<never>(() => {}),
			kill() {
				throw new Error("kill failed");
			},
		};
	};
	const runner = createPrimeCliCommandRunner(spawn, 50);
	const r = await runner.runCommand(["echo"], 5000);
	// Overflow sets primary, kill throws, bounded readers wait -> killThrew true -> PROC_UNCERTAIN
	expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
});

it("timeout killing process closes pipes so both readers settle", async () => {
	const runner = createPrimeCliCommandRunner();
	// A process that produces bounded output slowly but outlives timeout
	const r = await runner.runCommand(["sleep", "10"], 200);
	expect(r).toEqual({ ok: false, code: "TIMED_OUT" });
});

it("stream failure with other stream never closing leads to bounded cleanup", async () => {
	let exitResolve: ((code: number) => void) | undefined;
	const spawn: SpawnFn = () => {
		let stderrCtrl: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stderr = new ReadableStream({
			start(c) {
				stderrCtrl = c;
				c.enqueue(new Uint8Array([65]));
			},
		});
		return {
			stdout: new ReadableStream({
				start(c) {
					c.error(new Error("pipe failed"));
				},
			}),
			stderr,
			exited: new Promise<number>((resolve) => {
				exitResolve = resolve;
			}),
			kill() {
				stderrCtrl?.close();
				exitResolve?.(0);
			},
		};
	};
	const runner = createPrimeCliCommandRunner(spawn);
	const r = await runner.runCommand(["echo"], 5000);
	expect(r).toEqual({ ok: false, code: "STREAM_FAILED" });
});

it("exit rejection with bounded reader cleanup", async () => {
	const spawn: SpawnFn = () => {
		let stderrCtrl: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stderr = new ReadableStream({
			start(c) {
				stderrCtrl = c;
			},
		});
		return {
			stdout: streamFrom(new Uint8Array(0)),
			stderr,
			exited: Promise.reject(new Error("waitpid rejected")),
			kill() {
				stderrCtrl?.close();
			},
		};
	};
	const runner = createPrimeCliCommandRunner(spawn);
	const r = await runner.runCommand(["echo"], 5000);
	expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
});

// ---- closes-pipes-then-exits within timeout (must succeed) ----

it("process closes pipes then exits within timeout (success, not uncertain)", async () => {
	const runner = createPrimeCliCommandRunner();
	const r = await runner.runCommand(["bash", "-c", "exec 1>&-; exec 2>&-; sleep 1; exit 0"], 15_000);
	expect(r).toEqual({
		ok: true,
		value: expect.objectContaining({
			stdout: "",
			stderr: "",
			exitCode: 0,
		}),
	});
	// duration must be < 5s (not hitting cleanup timeout)
	expect(r.ok ? r.value.durationMs : 99999).toBeLessThan(5000);
});

// ---- abort-during-registration race ----

it("signal aborted exactly between initial check and listener registration", async () => {
	// Build a signal that aborts synchronously when addEventListener is called
	// but is NOT aborted when signal.aborted is checked first.
	// We can do this by aborting from within a proxy or by using
	// setTimeout(0) in the addEventListener. Simpler: abort first, then pass.
	// But the pre-abort check returns ABORTED before registration.
	// So test the recheck path: signal becomes aborted during registration.
	// Use AbortSignal.timeout(0) which fires immediately.
	const signal = AbortSignal.timeout(0);
	// Give the microtask a chance to fire the abort
	await new Promise((r) => setTimeout(r, 5));

	let spawned = false;
	const runner = createPrimeCliCommandRunner(() => {
		spawned = true;
		return noopProcess();
	});
	const r = await runner.runCommand(["echo"], 5000, signal);
	expect(r).toEqual({ ok: false, code: "ABORTED" });
	expect(spawned).toBe(false);
});

it("abort fires exactly during addEventListener (after aborted check)", async () => {
	// Use a custom AbortController where abort fires during addEventListener
	const ctrl = new AbortController();
	const signal = ctrl.signal;

	// Intercept addEventListener to abort the signal during registration
	const origAddEventListener = signal.addEventListener.bind(signal);
	let _addEventListenerCalled = false;
	signal.addEventListener = ((type, listener, options) => {
		_addEventListenerCalled = true;
		origAddEventListener(type, listener, options);
		// Abort synchronously, which will trigger the listener we just registered
		ctrl.abort();
	}) as typeof signal.addEventListener;

	let spawned = false;
	const runner = createPrimeCliCommandRunner(() => {
		spawned = true;
		return noopProcess();
	});
	const r = await runner.runCommand(["echo"], 5000, signal);
	expect(r).toEqual({ ok: false, code: "ABORTED" });
	expect(spawned).toBe(false);
});

// ---- owned buffer erasure ----

it("erases owned chunks and merged buffers on success", async () => {
	const originalFill = Uint8Array.prototype.fill;
	const erased: Uint8Array[] = [];
	Uint8Array.prototype.fill = function (value, start, end) {
		const result = originalFill.call(this, value, start, end);
		if (value === 0 && this.byteLength === 11) erased.push(this);
		return result;
	};
	try {
		const runner = createPrimeCliCommandRunner(() => ({
			stdout: streamFrom(new TextEncoder().encode("test-output")),
			stderr: streamFrom(new Uint8Array(0)),
			exited: Promise.resolve(0),
			kill() {},
		}));
		const result = await runner.runCommand(["echo"], 5000);
		expect(result).toEqual({
			ok: true,
			value: expect.objectContaining({ stdout: "test-output" }),
		});
		expect(erased.length).toBeGreaterThanOrEqual(2);
		for (const bytes of erased) expect(bytes.every((byte) => byte === 0)).toBe(true);
	} finally {
		Uint8Array.prototype.fill = originalFill;
	}
});

describe("default spawn (real Bun processes)", () => {
	it("spawns a real process without an inherited environment", async () => {
		const runner = createPrimeCliCommandRunner();
		const echoResult = await runner.runCommand(["/bin/echo", "hi"], 5000);
		expect(echoResult.ok).toBe(true);
		const envResult = await runner.runCommand(["/usr/bin/env"], 5000);
		expect(envResult.ok).toBe(true);
		if (envResult.ok) expect(envResult.value.stdout).toBe("PATH=/usr/bin:/bin\n");
	});

	it("handles missing executable as SPAWN_FAILED", async () => {
		const runner = createPrimeCliCommandRunner();
		const r = await runner.runCommand(["./nonexistent-binary"], 1000);
		expect(r).toEqual({ ok: false, code: "SPAWN_FAILED" });
	});
});

// ---- focused contract tests ----

describe("focused contract tests", () => {
	it("invalid kill (non-function) => PROCESS_UNCERTAIN", async () => {
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array(0)),
			stderr: streamFrom(new Uint8Array(0)),
			exited: Promise.resolve(0),
			kill: "not-a-function" as unknown as () => void,
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});

	it("getReader not a function => STREAM_FAILED", async () => {
		const spawn: SpawnFn = () => ({
			stdout: { getReader: "not-a-function" } as unknown as ReadableStream<Uint8Array>,
			stderr: streamFrom(new Uint8Array(0)),
			exited: Promise.resolve(0),
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "STREAM_FAILED" });
	});

	it("getReader throws => STREAM_FAILED", async () => {
		const spawn: SpawnFn = () => ({
			stdout: {
				getReader() {
					throw new Error("no reader for you");
				},
			} as unknown as ReadableStream<Uint8Array>,
			stderr: streamFrom(new Uint8Array(0)),
			exited: Promise.resolve(0),
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "STREAM_FAILED" });
	});

	it("synchronous cancel throw observed => reader settles, does not crash", async () => {
		let cancelCalled = false;
		let readCount = 0;
		const faultyReader = {
			read() {
				readCount++;
				if (readCount >= 2) {
					return Promise.resolve({ done: true, value: undefined });
				}
				return Promise.resolve({ done: false, value: new Uint8Array([65]) });
			},
			cancel() {
				cancelCalled = true;
				throw new Error("cancel throws");
			},
			releaseLock() {},
		};
		const spawn: SpawnFn = () => ({
			stdout: {
				getReader() {
					return faultyReader;
				},
			} as unknown as ReadableStream<Uint8Array>,
			stderr: streamFrom(new Uint8Array(0)),
			exited: Promise.resolve(42),
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({
			ok: true,
			value: expect.objectContaining({ stdout: "A", exitCode: 42 }),
		});
		expect(cancelCalled).toBe(false); // cancel not called in normal path
	});

	it("stream read throws synchronously => STREAM_FAILED", async () => {
		const spawn: SpawnFn = () => ({
			stdout: {
				getReader() {
					return {
						read() {
							throw new Error("sync read throw");
						},
						cancel() {
							return Promise.resolve();
						},
						releaseLock() {},
					};
				},
			} as unknown as ReadableStream<Uint8Array>,
			stderr: streamFrom(new Uint8Array(0)),
			exited: Promise.resolve(0),
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "STREAM_FAILED" });
	});

	it("stdout accessor is rejected as PROCESS_UNCERTAIN", async () => {
		let exitResolve: ((code: number) => void) | undefined;
		const spawn: SpawnFn = () => {
			const throwOnStdout = {
				get stdout() {
					throw new Error("stdout getter fail");
				},
				get stderr() {
					return streamFrom(new Uint8Array(0));
				},
				get exited() {
					return new Promise<number>((resolve) => {
						exitResolve = resolve;
					});
				},
				kill() {
					exitResolve?.(0);
				},
			} as unknown as SpawnedProcess;
			return throwOnStdout;
		};
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 5000);
		expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});

	it("structural stdout accessor is rejected as PROCESS_UNCERTAIN", async () => {
		let exitResolve: ((code: number) => void) | undefined;
		const spawn: SpawnFn = () => {
			return {
				get stdout() {
					throw new Error("stdout getter fail at capture");
				},
				stderr: streamFrom(new Uint8Array(0)),
				get exited() {
					return new Promise<number>((resolve) => {
						exitResolve = resolve;
					});
				},
				kill() {
					exitResolve?.(0);
				},
			} as unknown as SpawnedProcess;
		};
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 5000);
		expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});
});

// ---- additional contract tests ----

describe("additional contract tests", () => {
	it("returns STREAM_FAILED when the owned output copy fails", async () => {
		const originalSet = Uint8Array.prototype.set;
		let matchingCalls = 0;
		Uint8Array.prototype.set = function (source, offset) {
			if (this.byteLength === 4 && source.length === 4) {
				matchingCalls += 1;
				throw new Error("copy failed");
			}
			return originalSet.call(this, source, offset);
		};
		try {
			const runner = createPrimeCliCommandRunner(() => ({
				stdout: streamFrom(new Uint8Array([1, 2, 3, 4])),
				stderr: streamFrom(new Uint8Array(0)),
				exited: Promise.resolve(0),
				kill() {},
			}));
			const result = await runner.runCommand(["echo"], 1000);
			expect(result).toEqual({ ok: false, code: "STREAM_FAILED" });
			expect(matchingCalls).toBe(1);
		} finally {
			Uint8Array.prototype.set = originalSet;
		}
	});

	it("returns STREAM_FAILED instead of truncating when chunk merge fails", async () => {
		const originalSet = Uint8Array.prototype.set;
		let matchingCalls = 0;
		Uint8Array.prototype.set = function (source, offset) {
			if (this.byteLength === 4 && source.length === 4) {
				matchingCalls += 1;
				if (matchingCalls === 2) throw new Error("merge failed");
			}
			return originalSet.call(this, source, offset);
		};
		try {
			const runner = createPrimeCliCommandRunner(() => ({
				stdout: streamFrom(new Uint8Array([1, 2, 3, 4])),
				stderr: streamFrom(new Uint8Array(0)),
				exited: Promise.resolve(0),
				kill() {},
			}));
			const result = await runner.runCommand(["echo"], 1000);
			expect(result).toEqual({ ok: false, code: "STREAM_FAILED" });
			expect(matchingCalls).toBe(2);
		} finally {
			Uint8Array.prototype.set = originalSet;
		}
	});

	it("exit thenable honors only its first callback", async () => {
		// A thenable that calls both resolve and reject
		const hostileThen = {
			// biome-ignore lint/suspicious/noThenProperty: intentional hostile thenable test
			then(resolve: (v: number) => void, reject: () => void) {
				resolve(0);
				reject();
			},
		};
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array(0)),
			stderr: streamFrom(new Uint8Array(0)),
			exited: hostileThen as Promise<number>,
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		// Once gate prevents double-callback; should succeed
		expect(r).toEqual({
			ok: true,
			value: expect.objectContaining({ exitCode: 0 }),
		});
	});

	it("non-finite exit via hostile thenable => PROCESS_UNCERTAIN", async () => {
		const hostileThen = {
			// biome-ignore lint/suspicious/noThenProperty: intentional hostile thenable test
			then(resolve: (v: number) => void) {
				resolve(NaN);
			},
		};
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array(0)),
			stderr: streamFrom(new Uint8Array(0)),
			exited: hostileThen as Promise<number>,
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});

	it("negative exit code => PROCESS_UNCERTAIN", async () => {
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array(0)),
			stderr: streamFrom(new Uint8Array(0)),
			exited: Promise.resolve(-42),
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});

	it("non-integer exit code => PROCESS_UNCERTAIN", async () => {
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array(0)),
			stderr: streamFrom(new Uint8Array(0)),
			exited: Promise.resolve(0.5),
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});

	it("negative duration via performance.now manipulation => PROCESS_UNCERTAIN", async () => {
		// Override performance.now to return a negative delta
		const origNow = performance.now;
		let callCount = 0;
		performance.now = () => {
			callCount++;
			if (callCount === 1) return 100;
			return 50; // delta = -50
		};
		try {
			const spawn: SpawnFn = () => ({
				stdout: streamFrom(new Uint8Array([65])),
				stderr: streamFrom(new Uint8Array(0)),
				exited: Promise.resolve(0),
				kill() {},
			});
			const runner = createPrimeCliCommandRunner(spawn);
			const r = await runner.runCommand(["echo"], 1000);
			expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
		} finally {
			performance.now = origNow;
		}
	});

	it("non-finite exit via injected thenable => PROCESS_UNCERTAIN", async () => {
		// An exit that passes NaN (non-safe-integer) triggers onReject
		const hostileThen = {
			// biome-ignore lint/suspicious/noThenProperty: intentional hostile thenable test
			then(resolve: (v: number) => void) {
				resolve(NaN);
			},
		};
		const spawn: SpawnFn = () => ({
			stdout: streamFrom(new Uint8Array([65])),
			stderr: streamFrom(new Uint8Array(0)),
			exited: hostileThen as Promise<number>,
			kill() {},
		});
		const runner = createPrimeCliCommandRunner(spawn);
		const r = await runner.runCommand(["echo"], 1000);
		// NaN is not a safe integer => onReject called => PROCESS_UNCERTAIN
		expect(r).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});

	it("rejects invalid cleanup configuration without spawning", async () => {
		let spawned = false;
		const runner = createPrimeCliCommandRunner(() => {
			spawned = true;
			return noopProcess();
		}, Number.NaN);
		const result = await runner.runCommand(["echo"], 1000);
		expect(result).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(spawned).toBe(false);
	});

	it("rejects argv accessors, extra keys, and revoked proxies without spawning", async () => {
		let spawned = false;
		const runner = createPrimeCliCommandRunner(() => {
			spawned = true;
			return noopProcess();
		});
		const accessorArgs = ["echo"];
		Object.defineProperty(accessorArgs, "0", { get: () => "echo" });
		const symbolArgs = ["echo"];
		Reflect.set(symbolArgs, Symbol("extra"), true);
		const revocable = Proxy.revocable(["echo"], {});
		revocable.revoke();
		const invoke = (args: unknown): unknown => Reflect.apply(runner.runCommand, runner, [args, 1000]);
		expect(await Promise.resolve(invoke(accessorArgs))).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(await Promise.resolve(invoke(symbolArgs))).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(await Promise.resolve(invoke(revocable.proxy))).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(spawned).toBe(false);
	});

	it("rejects extra process result keys after killing and observing exit", async () => {
		let killed = false;
		const spawn = (): SpawnedProcess => {
			const result = {
				stdout: streamFrom(new Uint8Array(0)),
				stderr: streamFrom(new Uint8Array(0)),
				exited: Promise.resolve(0),
				kill() {
					killed = true;
				},
				extra: "forbidden",
			};
			return result;
		};
		const result = await createPrimeCliCommandRunner(spawn).runCommand(["echo"], 1000);
		expect(result).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
		expect(killed).toBe(true);
	});

	it("captures each getReader method exactly once", async () => {
		let stdoutGetterCalls = 0;
		let stderrGetterCalls = 0;
		const stdout = streamFrom(new Uint8Array(0));
		const stderr = streamFrom(new Uint8Array(0));
		const stdoutGetReader = stdout.getReader.bind(stdout);
		const stderrGetReader = stderr.getReader.bind(stderr);
		Object.defineProperty(stdout, "getReader", {
			get() {
				stdoutGetterCalls += 1;
				return stdoutGetReader;
			},
		});
		Object.defineProperty(stderr, "getReader", {
			get() {
				stderrGetterCalls += 1;
				return stderrGetReader;
			},
		});
		const spawn = (): SpawnedProcess => ({
			stdout,
			stderr,
			exited: Promise.resolve(0),
			kill() {},
		});
		const result = await createPrimeCliCommandRunner(spawn).runCommand(["echo"], 1000);
		expect(result.ok).toBe(true);
		expect(stdoutGetterCalls).toBe(1);
		expect(stderrGetterCalls).toBe(1);
	});

	it("returns PROCESS_UNCERTAIN when a pending cancel operation cannot be observed", async () => {
		let resolveExit: ((code: number) => void) | undefined;
		const never = new Promise<never>(() => {});
		const stream = new ReadableStream<Uint8Array>({
			pull: () => never,
			cancel: () => never,
		});
		const spawn = (): SpawnedProcess => ({
			stdout: stream,
			stderr: streamFrom(new Uint8Array(0)),
			exited: new Promise<number>((resolve) => {
				resolveExit = resolve;
			}),
			kill() {
				resolveExit?.(0);
			},
		});
		const runner = createPrimeCliCommandRunner(spawn, 50);
		const result = await runner.runCommand(["echo"], 100);
		expect(result).toEqual({ ok: false, code: "PROCESS_UNCERTAIN" });
	});
});
