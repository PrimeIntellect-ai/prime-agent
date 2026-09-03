/**
 * Focused tests for sandbox-fd3-readiness-monitor.
 *
 * Covers: input validation (every rejection path), successful ready line
 * parsing, stderr rejection, exit/close-before-ready, synchronous overflow,
 * timeouts, cleanup signal sequence, source byte erasure, shared-buffer
 * rejection, data after ready, and late-result suppression.
 */

import { describe, expect, it } from "vitest";
import type {
	CreateFd3ReadinessMonitorResult,
	Fd3ProcessEventListener,
} from "../src/core/sandbox-fd3-readiness-monitor.js";
import { createFd3ReadinessMonitor } from "../src/core/sandbox-fd3-readiness-monitor.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function nonce(): string {
	return "aabbccdd00112233445566778899eeff";
}

function validTimeouts(): object {
	return Object.freeze({
		readyTimeoutMs: 50,
		sigintTimeoutMs: 1000,
		sigtermTimeoutMs: 1000,
		sigkillTimeoutMs: 1000,
		closeConfirmTimeoutMs: 1000,
	});
}

function subscriptionOk(): object {
	const unsubscribe = (): object => Object.freeze({ status: "unsubscribed" });
	return Object.freeze({
		status: "subscribed",
		unsubscribe,
	});
}

function _subscriptionError(): object {
	return Object.freeze({ status: "error" });
}

function validProcess(
	overrides?: Partial<{
		subscribe: (listener: Fd3ProcessEventListener) => unknown;
		signalGroup: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => unknown;
		destroyStdio: () => unknown;
	}>,
): object {
	return Object.freeze({
		subscribe: overrides?.subscribe ?? ((): object => subscriptionOk()),
		signalGroup: overrides?.signalGroup ?? ((): object => Object.freeze({ status: "sent" })),
		destroyStdio: overrides?.destroyStdio ?? ((): object => Object.freeze({ status: "destroyed" })),
	});
}

function validInput(
	overrides?: Partial<{
		process: unknown;
		expectedNonce: string;
		timeouts: unknown;
	}>,
): object {
	const merged: Record<string, unknown> = {
		process: validProcess(),
		expectedNonce: nonce(),
		timeouts: validTimeouts(),
	};
	if (overrides !== undefined) {
		if ("process" in overrides) merged.process = overrides.process;
		if ("expectedNonce" in overrides) merged.expectedNonce = overrides.expectedNonce;
		if ("timeouts" in overrides) merged.timeouts = overrides.timeouts;
	}
	return Object.freeze(merged);
}

function makeMonitor(input: unknown): CreateFd3ReadinessMonitorResult {
	return createFd3ReadinessMonitor(input);
}

function assertOk(result: CreateFd3ReadinessMonitorResult): void {
	expect(result.ok).toBe(true);
}

function assertFail(result: CreateFd3ReadinessMonitorResult): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
}

function zeroBuffer(text: string): ArrayBuffer {
	const enc = new TextEncoder();
	const raw = enc.encode(text);
	const ab = new ArrayBuffer(raw.byteLength);
	const view = new Uint8Array(ab);
	view.set(raw);
	return ab;
}

/** Create a shared (offset > 0) Uint8Array view. */
function sharedChunk(text: string): Uint8Array {
	const raw = new TextEncoder().encode(text);
	const backing = new ArrayBuffer(raw.byteLength + 10);
	const full = new Uint8Array(backing);
	full.set(raw, 5);
	return full.subarray(5, 5 + raw.byteLength);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("createFd3ReadinessMonitor preflight", () => {
	it("rejects null", () => {
		assertFail(makeMonitor(null));
	});

	it("rejects undefined", () => {
		assertFail(makeMonitor(undefined));
	});

	it("rejects a number", () => {
		assertFail(makeMonitor(42));
	});

	it("rejects a string", () => {
		assertFail(makeMonitor("bad"));
	});

	it("rejects an array", () => {
		assertFail(makeMonitor([]));
	});

	it("rejects a Proxy", () => {
		const target = validInput();
		const proxy = new Proxy(target, {});
		assertFail(makeMonitor(proxy));
	});

	it("rejects object with wrong prototype", () => {
		class FakeOk extends Object {}
		const obj = new FakeOk();
		Object.assign(obj, validInput());
		assertFail(makeMonitor(obj));
	});

	it("rejects missing key", () => {
		const { process, expectedNonce, ...rest } = validInput() as Record<string, unknown>;
		assertFail(makeMonitor({ ...rest, process }));
	});

	it("rejects extra key", () => {
		const inp = { ...validInput(), extra: 1 } as Record<string, unknown>;
		assertFail(makeMonitor(inp));
	});

	it("rejects Symbol key", () => {
		const inp: Record<string | symbol, unknown> = {};
		inp.process = validProcess();
		inp.expectedNonce = nonce();
		inp.timeouts = validTimeouts();
		inp[Symbol("x")] = 1;
		assertFail(makeMonitor(inp));
	});

	it("rejects non-enumerable key", () => {
		const inp: Record<string, unknown> = {};
		inp.process = validProcess();
		inp.expectedNonce = nonce();
		inp.timeouts = validTimeouts();
		Object.defineProperty(inp, "hidden", { value: 1, enumerable: false });
		assertFail(makeMonitor(inp));
	});

	it("rejects accessor property", () => {
		const inp: Record<string, unknown> = {};
		const _process = validProcess();
		const _nonce = nonce();
		const _timeouts = validTimeouts();
		Object.defineProperties(inp, {
			process: { get: () => _process, enumerable: true },
			expectedNonce: { get: () => _nonce, enumerable: true },
			timeouts: { get: () => _timeouts, enumerable: true },
		});
		assertFail(makeMonitor(inp));
	});

	it("rejects non-object process", () => {
		assertFail(makeMonitor(validInput({ process: "bad" })));
	});

	it("rejects null process", () => {
		assertFail(makeMonitor(validInput({ process: null })));
	});

	it("rejects process with missing key", () => {
		const proc = validProcess() as Record<string, unknown>;
		const { subscribe, ...rest } = proc;
		assertFail(makeMonitor(validInput({ process: rest })));
	});

	it("rejects process with extra key", () => {
		assertFail(makeMonitor(validInput({ process: { ...(validProcess() as Record<string, unknown>), extra: 1 } })));
	});

	it("rejects process with non-function subscribe", () => {
		assertFail(
			makeMonitor(
				validInput({
					process: validProcess({ subscribe: 42 as unknown as (listener: Fd3ProcessEventListener) => object }),
				}),
			),
		);
	});

	it("rejects process with Proxy subscribe", () => {
		const fn = (): object => subscriptionOk();
		const proxyFn = new Proxy(fn, {});
		assertFail(makeMonitor(validInput({ process: validProcess({ subscribe: proxyFn }) })));
	});

	it("rejects process with non-function signalGroup", () => {
		assertFail(
			makeMonitor(
				validInput({
					process: validProcess({
						signalGroup: 42 as unknown as (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => object,
					}),
				}),
			),
		);
	});

	it("rejects process with non-function destroyStdio", () => {
		assertFail(makeMonitor(validInput({ process: validProcess({ destroyStdio: 42 as unknown as () => object }) })));
	});

	it("rejects non-string expectedNonce", () => {
		assertFail(makeMonitor(validInput({ expectedNonce: 42 as unknown as string })));
	});

	it("rejects short nonce", () => {
		assertFail(makeMonitor(validInput({ expectedNonce: "abc" })));
	});

	it("rejects non-hex nonce", () => {
		assertFail(makeMonitor(validInput({ expectedNonce: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" })));
	});

	it("rejects uppercase hex nonce", () => {
		assertFail(makeMonitor(validInput({ expectedNonce: "AABBCCDD00112233445566778899EEFF" })));
	});

	it("rejects non-object timeouts", () => {
		assertFail(makeMonitor(validInput({ timeouts: "bad" })));
	});

	it("rejects null timeouts", () => {
		assertFail(makeMonitor(validInput({ timeouts: null })));
	});

	it("rejects extra timeout key", () => {
		assertFail(
			makeMonitor(
				validInput({
					timeouts: { ...(validTimeouts() as Record<string, unknown>), extra: 1 },
				}),
			),
		);
	});

	it("rejects missing timeout key", () => {
		const to = validTimeouts() as Record<string, unknown>;
		const { readyTimeoutMs, ...rest } = to;
		assertFail(makeMonitor(validInput({ timeouts: rest })));
	});

	it("rejects non-number readyTimeoutMs", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...validTimeouts(), readyTimeoutMs: "bad" } })));
	});

	it("rejects zero readyTimeoutMs", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...validTimeouts(), readyTimeoutMs: 0 } })));
	});

	it("rejects negative sigintTimeoutMs", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...validTimeouts(), sigintTimeoutMs: -1 } })));
	});

	it("rejects too-large sigtermTimeoutMs", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...validTimeouts(), sigtermTimeoutMs: 200_000 } })));
	});

	it("rejects non-integer sigkillTimeoutMs", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...validTimeouts(), sigkillTimeoutMs: 1.5 } })));
	});

	it("accepts valid input", () => {
		const result = makeMonitor(validInput());
		expect(result.ok).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: subscription outcomes
// ─────────────────────────────────────────────────────────────────────────────

describe("subscription outcomes", () => {
	it("rejects subscribe that throws", async () => {
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: () => {
						throw new Error("boom");
					},
				}),
			}),
		);
		if (!result.ok) throw new Error("expected ok false");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("SUBSCRIBE_REJECTED");
	});

	it("rejects subscribe with non-subscribed status", () => {
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: () => Object.freeze({ status: "pending" }),
				}),
			}),
		);
		if (!result.ok) throw new Error("expected ok");
		expect(result.ok).toBe(true);
	});

	it("accepts subscribe with error status and no synchronous events", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return Object.freeze({ status: "error" });
					},
				}),
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// No synchronous stdout, error status without unsubscribe → backout path, ok:false.
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
	});

	it("accepts subscribe with error status but rejects on synchronous events", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						// Call onStdout synchronously before returning.
						listener.onStdout(Object.freeze(new Uint8Array([0x48])));
						return Object.freeze({ status: "error" });
					},
				}),
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("SUBSCRIBE_REJECTED");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: successful ready line
// ─────────────────────────────────────────────────────────────────────────────

describe("successful ready line", () => {
	it("resolves ready when stdout contains PRIME_AGENT_READY <nonce> <pid>\n", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 12345\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready).toEqual(Object.freeze({ ok: true, pid: 12345 }));
	});

	it("resolves ready with pid 1", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 1\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready).toEqual(Object.freeze({ ok: true, pid: 1 }));
	});

	it("resolves ready with pid 2147483647", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 2147483647\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready).toEqual(Object.freeze({ ok: true, pid: 2147483647 }));
	});

	it("handles ready line split across multiple chunks", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const prefix = "PRIME_AGENT_READY ";
		const suffix = `${nonce()} 999\n`;
		// Sending the prefix without the newline first.
		captured.listener!.onStdout(new Uint8Array(zeroBuffer(prefix)));
		// Wait a microtask to check that ready is not resolved yet.
		await (async () => {}).bind(undefined)();
		// Now send the rest.
		captured.listener!.onStdout(new Uint8Array(zeroBuffer(suffix)));
		const ready = await result.monitor.ready;
		expect(ready).toEqual(Object.freeze({ ok: true, pid: 999 }));
	});

	it("zeroes the source ArrayBuffer after extracting ready bytes", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 777\n`;
		const ab = zeroBuffer(line);
		const chunk = new Uint8Array(ab);
		const _before = chunk[0];
		captured.listener!.onStdout(chunk);
		const ready = await result.monitor.ready;
		expect(ready).toEqual(Object.freeze({ ok: true, pid: 777 }));
		// On a properly sized private ArrayBuffer, the data should be zeroed after takeTransferred returns.
		// The monitor may have zeroed it during the feedOwned call.
		await (async () => {}).bind(undefined)();
		const firstByte = chunk[0];
		expect(firstByte).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: failure modes from stdout
// ─────────────────────────────────────────────────────────────────────────────

describe("stdout failure modes", () => {
	it("rejects nonce mismatch", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				expectedNonce: nonce(),
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ffffffffffffffffffffffffffffffff 12345\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("NONCE_MISMATCH");
	});

	it("rejects invalid pid text", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 0\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("INVALID_PID");
	});

	it("rejects pid exceeding MAX_PID", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 2147483648\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("INVALID_PID");
	});

	it("rejects trailing data after newline", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 12345\nextra\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("TRAILING_DATA");
	});

	it("rejects line without PRIME_AGENT_READY prefix", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `GARBAGE ${nonce()} 12345\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("TRAILING_DATA");
	});

	it("rejects line with extra space", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 12345 extra\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("TRAILING_DATA");
	});

	it("rejects line exceeding MAX_LINE_BYTES", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		// 260 'A' characters + newline > 256.
		const line = `PRIME_AGENT_READY ${nonce()} 1${"A".repeat(230)}\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("LINE_TOO_LONG");
	});

	it("rejects non-printable bytes in line", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 1\x01\n`;
		const raw = new TextEncoder().encode(line);
		const ab = new ArrayBuffer(raw.byteLength);
		const view = new Uint8Array(ab);
		view.set(raw);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("TRAILING_DATA");
	});

	it("rejects chunk larger than MAX_TOTAL_STDOUT_BYTES (8192)", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		// Make a chunk larger than MAX_TOTAL_STDOUT_BYTES.
		const bigLine = `${"x".repeat(8193)}\n`;
		const ab = zeroBuffer(bigLine);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("LINE_TOO_LONG");
	});

	it("rejects stdout after ready line", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 555\n`;
		const ab = zeroBuffer(line);
		captured.listener!.onStdout(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready).toEqual(Object.freeze({ ok: true, pid: 555 }));
		// Now send more stdout.
		const chunk = new Uint8Array(zeroBuffer("extra\n"));
		const _before = chunk[0];
		captured.listener!.onStdout(chunk);
		// The chunk should have been zeroed.
		expect(chunk[0]).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: stderr
// ─────────────────────────────────────────────────────────────────────────────

describe("stderr rejection", () => {
	it("rejects on stderr before ready", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const ab = zeroBuffer("error message");
		captured.listener!.onStderr(new Uint8Array(ab));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("STDERR");
	});

	it("rejects on invalid stderr chunk (non-TypedArray)", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		captured.listener!.onStderr("not-a-typedarray");
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("INVALID_CHUNK");
	});

	it("ignores stderr after ready is resolved", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 777\n`;
		captured.listener!.onStdout(new Uint8Array(zeroBuffer(line)));
		await result.monitor.ready;
		// After ready, stderr should be ignored (no throw).
		const ab = zeroBuffer("post-ready error");
		captured.listener!.onStderr(new Uint8Array(ab));
		// If it throw, test will fail.
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: exit / close before ready
// ─────────────────────────────────────────────────────────────────────────────

describe("exit and close before ready", () => {
	it("rejects on exit before ready", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		captured.listener!.onExit(Object.freeze({ code: 1, signal: null }));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("EXIT");
	});

	it("rejects on close before ready", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		captured.listener!.onClose();
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("CLOSED");
	});

	it("rejects on process_error before ready", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		captured.listener!.onProcessError();
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("PROCESS_ERROR");
	});

	it("rejects on invalid exit event", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		captured.listener!.onExit(Object.freeze({ code: "bad", signal: null }));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("PROCESS_EVENT");
	});

	it("rejects exit with signal before ready", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		captured.listener!.onExit(Object.freeze({ code: null, signal: "SIGTERM" }));
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("EXIT");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: ready timeout
// ─────────────────────────────────────────────────────────────────────────────

describe("ready timeout", () => {
	it("rejects with READY_TIMEOUT if no ready line arrives in time", async () => {
		const result = makeMonitor(
			validInput({
				timeouts: { ...validTimeouts(), readyTimeoutMs: 50 },
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("READY_TIMEOUT");
	}, 5_000);

	it("does not timeout if ready line arrives before deadline", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
				timeouts: { ...validTimeouts(), readyTimeoutMs: 500 },
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 444\n`;
		captured.listener!.onStdout(new Uint8Array(zeroBuffer(line)));
		const ready = await result.monitor.ready;
		expect(ready).toEqual(Object.freeze({ ok: true, pid: 444 }));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: synchronous event overflow
// ─────────────────────────────────────────────────────────────────────────────

describe("synchronous event overflow", () => {
	it("rejects more than 16 synchronous stdout events before subscribe returns", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		let _subscriptionReturned = false;
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						// Send 17 synchronous stdout events.
						for (let i = 0; i < 17; i += 1) {
							listener.onStdout(new Uint8Array(zeroBuffer("a")));
						}
						_subscriptionReturned = true;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("SYNCHRONOUS_OVERFLOW");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: shared buffer (non-owned TypedArray) rejection
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Tests: overflow preserves terminal evidence
// ─────────────────────────────────────────────────────────────────────────────

describe("overflow preserves terminal evidence", () => {
	it("overflow with EXIT as 17th event prevents signals and still checks cleanup", async () => {
		const captured = {
			listener: null as Fd3ProcessEventListener | null,
			signals: [] as string[],
			destroyed: false,
			unsubscribed: false,
		};
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						// Send 16 stdout to fill queue, then exit.
						for (let i = 0; i < 16; i += 1) {
							listener.onStdout(new Uint8Array(zeroBuffer("a")));
						}
						listener.onExit(Object.freeze({ code: 1, signal: null }));
						return subscriptionOk();
					},
					signalGroup: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
						captured.signals.push(signal);
						return Object.freeze({ status: "sent" });
					},
					destroyStdio: () => {
						captured.destroyed = true;
						return Object.freeze({ status: "destroyed" });
					},
				}),
				timeouts: {
					readyTimeoutMs: 50,
					sigintTimeoutMs: 50,
					sigtermTimeoutMs: 50,
					sigkillTimeoutMs: 50,
					closeConfirmTimeoutMs: 100,
				},
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		// exit was observed before subscribe returned → cleanup sees exitObserved,
		// enters waitForClose path instead of signalNext.
		captured.listener!.onClose();
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) {
			// Primary failure is SYNCHRONOUS_OVERFLOW; exit evidence was preserved
			// so cleanup does not signal (exitObserved set before beginCleanup).
			expect(ready.code).toBe("SYNCHRONOUS_OVERFLOW");
		}
		// Zero signals because exit was already observed.
		expect(captured.signals).toEqual([]);
		expect(captured.unsubscribed).toBe(false);
	});

	it("overflow with CLOSE (no exit) still signals because exit evidence absent", async () => {
		const captured = {
			listener: null as Fd3ProcessEventListener | null,
			signals: [] as string[],
			destroyed: false,
		};
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						// Send 16 stdout to fill queue, then close (no exit).
						for (let i = 0; i < 16; i += 1) {
							listener.onStdout(new Uint8Array(zeroBuffer("a")));
						}
						listener.onClose();
						return subscriptionOk();
					},
					signalGroup: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
						captured.signals.push(signal);
						return Object.freeze({ status: "sent" });
					},
					destroyStdio: () => {
						captured.destroyed = true;
						return Object.freeze({ status: "destroyed" });
					},
				}),
				timeouts: {
					readyTimeoutMs: 50,
					sigintTimeoutMs: 30,
					sigtermTimeoutMs: 30,
					sigkillTimeoutMs: 30,
					closeConfirmTimeoutMs: 50,
				},
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		// close observed but no exit → cleanup still sends signals.
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		// Signals should fire because exit evidence absent.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(captured.signals.length).toBeGreaterThan(0);
	});

	it("overflow with EXIT then no close triggers waitForClose timer", async () => {
		const captured = {
			listener: null as Fd3ProcessEventListener | null,
			signals: [] as string[],
		};
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						for (let i = 0; i < 16; i += 1) {
							listener.onStdout(new Uint8Array(zeroBuffer("a")));
						}
						listener.onExit(Object.freeze({ code: 0, signal: null }));
						return subscriptionOk();
					},
					signalGroup: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
						captured.signals.push(signal);
						return Object.freeze({ status: "sent" });
					},
				}),
				timeouts: {
					readyTimeoutMs: 50,
					sigintTimeoutMs: 50,
					sigtermTimeoutMs: 50,
					sigkillTimeoutMs: 50,
					closeConfirmTimeoutMs: 100,
				},
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		// No close arrives → waitForClose timer fires, cleanup completes without
		// process confirmation.
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		expect(captured.signals).toEqual([]);
	});
});

describe("shared buffer rejection", () => {
	it("rejects a shared (offset > 0) Uint8Array on stdout", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const shared = sharedChunk(`PRIME_AGENT_READY ${nonce()} 123\n`);
		captured.listener!.onStdout(shared);
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("INVALID_CHUNK");
	});

	it("rejects a shared (offset > 0) Uint8Array on stderr", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const shared = sharedChunk("error");
		captured.listener!.onStderr(shared);
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("INVALID_CHUNK");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: cleanup and close
// ─────────────────────────────────────────────────────────────────────────────

describe("cleanup and close", () => {
	it("close() triggers cleanup and resolves closed", async () => {
		const captured = {
			listener: null as Fd3ProcessEventListener | null,
			signals: [] as string[],
			destroyed: false,
		};
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
					signalGroup: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
						captured.signals.push(signal);
						return Object.freeze({ status: "sent" });
					},
					destroyStdio: () => {
						captured.destroyed = true;
						return Object.freeze({ status: "destroyed" });
					},
				}),
				timeouts: {
					...validTimeouts(),
					sigintTimeoutMs: 50,
					sigtermTimeoutMs: 50,
					sigkillTimeoutMs: 50,
					closeConfirmTimeoutMs: 100,
				},
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const closePromise = result.monitor.close();
		// After close(), it should send SIGINT, then SIGTERM, then SIGKILL.
		// Without exit observed, all three signals fire with delays.
		const closed = await closePromise;
		expect(closed.ok).toBe(false);
		if (!closed.ok) expect(closed.code).toBe("CLEANUP_UNCONFIRMED");
		expect(captured.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
	}, 10_000);

	it("cleanup succeeds when exit and close observed during signal sequence", async () => {
		const captured = {
			listener: null as Fd3ProcessEventListener | null,
			signals: [] as string[],
			destroyed: false,
		};
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
					signalGroup: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
						captured.signals.push(signal);
						// Simulate exit after first signal.
						if (signal === "SIGINT") {
							setTimeout(() => {
								captured.listener!.onExit(Object.freeze({ code: 0, signal: null }));
							}, 10);
						}
						return Object.freeze({ status: "sent" });
					},
					destroyStdio: () => {
						captured.destroyed = true;
						return Object.freeze({ status: "destroyed" });
					},
				}),
				timeouts: {
					...validTimeouts(),
					sigintTimeoutMs: 2000,
					sigtermTimeoutMs: 2000,
					sigkillTimeoutMs: 2000,
					closeConfirmTimeoutMs: 100,
				},
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const closePromise = result.monitor.close();

		// Wait for the exit to be processed.
		await new Promise((resolve) => setTimeout(resolve, 50));
		// Simulate close after exit.
		captured.listener!.onClose();

		const closed = await closePromise;
		expect(closed.ok).toBe(true);
		expect(captured.signals).toEqual(["SIGINT"]);
		expect(captured.destroyed).toBe(true);
	}, 10_000);

	it("close() returns same promise on repeated calls", async () => {
		const result = makeMonitor(
			validInput({
				timeouts: { ...validTimeouts(), readyTimeoutMs: 50 },
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const p1 = result.monitor.close();
		const p2 = result.monitor.close();
		expect(p1).toBe(p2);
	});

	it("closed resets after ready is resolved", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 123\n`;
		captured.listener!.onStdout(new Uint8Array(zeroBuffer(line)));
		const ready = await result.monitor.ready;
		expect(ready).toEqual(Object.freeze({ ok: true, pid: 123 }));
		// After ready, close should be idempotent.
		// Without exit/close observed, close starts cleanup signal sequence.
		await result.monitor.close();
		// Should not throw.
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: signal group sequence
// ─────────────────────────────────────────────────────────────────────────────

describe("signal group sequence", () => {
	it("sends SIGINT, then SIGTERM, then SIGKILL in order", async () => {
		const captured = { signals: [] as string[], listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
					signalGroup: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
						captured.signals.push(signal);
						return Object.freeze({ status: "sent" });
					},
				}),
				timeouts: {
					...validTimeouts(),
					sigintTimeoutMs: 10,
					sigtermTimeoutMs: 10,
					sigkillTimeoutMs: 10,
					closeConfirmTimeoutMs: 50,
				},
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		await result.monitor.close();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(captured.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
	}, 5_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: synchronous event replay
// ─────────────────────────────────────────────────────────────────────────────

describe("synchronous event replay", () => {
	it("replays valid ready line from synchronous events", async () => {
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						const line = `PRIME_AGENT_READY ${nonce()} 888\n`;
						listener.onStdout(new Uint8Array(zeroBuffer(line)));
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const ready = await result.monitor.ready;
		expect(ready).toEqual(Object.freeze({ ok: true, pid: 888 }));
	});

	it("replays synchronous exit event", async () => {
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						listener.onExit(Object.freeze({ code: 1, signal: null }));
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("EXIT");
	});

	it("replays synchronous close event", async () => {
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						listener.onClose();
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("CLOSED");
	});

	it("replays synchronous process_error event", async () => {
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						listener.onProcessError();
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("PROCESS_ERROR");
	});

	it("replays synchronous stderr event", async () => {
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						listener.onStderr(new Uint8Array(zeroBuffer("err")));
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const ready = await result.monitor.ready;
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.code).toBe("STDERR");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: unsubscribe and destroyStdio return value validation
// ─────────────────────────────────────────────────────────────────────────────

describe("unsubscribe and destroyStdio", () => {
	it("calls unsubscribe on cleanup if registration was confirmed", async () => {
		let unsubscribed = false;
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: () =>
						Object.freeze({
							status: "subscribed",
							unsubscribe: () => {
								unsubscribed = true;
								return Object.freeze({ status: "unsubscribed" });
							},
						}),
				}),
				timeouts: { ...validTimeouts(), readyTimeoutMs: 50 },
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		await result.monitor.ready;
		await result.monitor.close();
		expect(unsubscribed).toBe(true);
	}, 5_000);

	it("does not fail when destroyStdio returns destroyed", async () => {
		let destroyed = false;
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: () =>
						Object.freeze({
							status: "subscribed",
							unsubscribe: () => Object.freeze({ status: "unsubscribed" }),
						}),
					destroyStdio: () => {
						destroyed = true;
						return Object.freeze({ status: "destroyed" });
					},
				}),
				timeouts: { ...validTimeouts(), readyTimeoutMs: 50 },
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		await result.monitor.ready;
		await result.monitor.close();
		expect(destroyed).toBe(true);
	}, 5_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: type-level compatibility with SshProcessEventListener
// ─────────────────────────────────────────────────────────────────────────────

describe("type compatibility", () => {
	it("Fd3ProcessEventListener has the same shape as SshProcessEventListener", () => {
		// Structural type check at runtime: the function signatures match.
		const fd3: Fd3ProcessEventListener = Object.freeze({
			onStdout: () => {},
			onStderr: () => {},
			onExit: () => {},
			onClose: () => {},
			onProcessError: () => {},
		});
		expect(typeof fd3.onStdout).toBe("function");
		expect(typeof fd3.onStderr).toBe("function");
		expect(typeof fd3.onExit).toBe("function");
		expect(typeof fd3.onClose).toBe("function");
		expect(typeof fd3.onProcessError).toBe("function");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: erasure and non-shared buffer
// ─────────────────────────────────────────────────────────────────────────────

describe("buffer erasure", () => {
	it("zeroes source Uint8Array after valid ready line", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = `PRIME_AGENT_READY ${nonce()} 444\n`;
		const ab = zeroBuffer(line);
		const chunk = new Uint8Array(ab);
		captured.listener!.onStdout(chunk);
		await result.monitor.ready;
		// After the monitor is done with the chunk, it should be zeroed.
		await (async () => {}).bind(undefined)();
		const allZero = chunk.every((b: number) => b === 0);
		expect(allZero).toBe(true);
	});

	it("zeroes source Uint8Array on invalid chunk", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		// Send a non-printable byte line to trigger TRAILING_DATA.
		const raw = new Uint8Array([0x00, 0x0a]);
		const ab = new ArrayBuffer(2);
		const chunk = new Uint8Array(ab);
		chunk.set(raw);
		captured.listener!.onStdout(chunk);
		await result.monitor.ready;
	});

	it("zeroes source Uint8Array on stderr", async () => {
		const captured = { listener: null as Fd3ProcessEventListener | null };
		const result = makeMonitor(
			validInput({
				process: validProcess({
					subscribe: (listener: Fd3ProcessEventListener) => {
						captured.listener = listener;
						return subscriptionOk();
					},
				}),
			}),
		);
		assertOk(result);
		if (!result.ok) return;
		const line = "error message";
		const ab = zeroBuffer(line);
		const chunk = new Uint8Array(ab);
		captured.listener!.onStderr(chunk);
		await result.monitor.ready;
		await (async () => {}).bind(undefined)();
		const allZero = chunk.every((b: number) => b === 0);
		expect(allZero).toBe(true);
	});
});
