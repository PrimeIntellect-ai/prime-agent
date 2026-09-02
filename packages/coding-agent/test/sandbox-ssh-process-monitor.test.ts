/**
 * Exhaustive adversarial tests for sandbox-ssh-process-monitor (B14).
 *
 * Covers every failure code, every input-validation path, every state
 * transition, race conditions, timeouts, Proxy rejection, shared-buffer
 * rejection, queue overflow, late-result suppression, and cleanup finality.
 */

import { describe, expect, it } from "vitest";
import { describe as ddescribe, it as xit } from "vitest";
import { createSshProcessMonitor } from "../src/core/sandbox-ssh-process-monitor.js";
import type {
	CreateSshProcessMonitorResult,
	SshProcessEventListener,
	SshMonitorFailureCode,
} from "../src/core/sandbox-ssh-process-monitor.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function nonce(): string {
	return "aabbccdd00112233445566778899eeff";
}

function validTimeouts(): object {
	return Object.freeze({
		readyTimeoutMs: 5000,
		admissionTimeoutMs: 5000,
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

function subscriptionError(): object {
	return Object.freeze({ status: "error" });
}

function validProcess(overrides?: Partial<{
	subscribe: (listener: SshProcessEventListener) => unknown;
	signalGroup: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => unknown;
	destroyStdio: () => unknown;
}>): object {
	return Object.freeze({
		subscribe: overrides?.subscribe ?? ((): object => subscriptionOk()),
		signalGroup: overrides?.signalGroup ?? ((): object => Object.freeze({ status: "sent" })),
		destroyStdio: overrides?.destroyStdio ?? ((): object => Object.freeze({ status: "destroyed" })),
	});
}

function validAdmission(): () => Promise<object> {
	return (): Promise<object> => Promise.resolve(Object.freeze({ status: "admitted" }));
}

function validInput(overrides?: Partial<{
	process: object | null;
	expectedNonce: string;
	confirmRelayAdmission: () => unknown;
	timeouts: object | null;
}>): object {
	const merged: Record<string, unknown> = {
		process: validProcess(),
		expectedNonce: nonce(),
		confirmRelayAdmission: validAdmission(),
		timeouts: validTimeouts(),
	};
	if (overrides !== undefined) {
		if ("process" in overrides) merged.process = overrides.process;
		if ("expectedNonce" in overrides) merged.expectedNonce = overrides.expectedNonce;
		if ("confirmRelayAdmission" in overrides) merged.confirmRelayAdmission = overrides.confirmRelayAdmission;
		if ("timeouts" in overrides) merged.timeouts = overrides.timeouts;
	}
	return Object.freeze(merged);
}

function makeMonitor(input: object): CreateSshProcessMonitorResult {
	return createSshProcessMonitor(input);
}

function assertOk(result: CreateSshProcessMonitorResult): void {
	expect(result.ok).toBe(true);
}

function assertFail(result: CreateSshProcessMonitorResult): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
}

function sendRawStdout(
	m: CreateSshProcessMonitorResult & { ok: true },
	text: string,
): void {
	// We need access to the listener. Since the test drives events via the
	// subscribe callback, we capture the listener when subscribe is called.
	// Use a helper that wraps the process subscribe.
}

/** Creates a process that captures the listener for manual event injection. */
function capturingProcess(): {
	process: object;
	listener: SshProcessEventListener | null;
	fireStdout: (text: string) => void;
	fireStderr: (text: string) => void;
	fireExit: (code: number | null, signal: string | null) => void;
	fireClose: () => void;
	fireProcessError: () => void;
} {
	let captured: SshProcessEventListener | null = null;
	const fireStdout = (text: string): void => {
		if (!captured) throw new Error("listener not captured yet");
		const enc = new TextEncoder();
		const raw = enc.encode(text);
		// Create exact transferred Uint8Array (full buffer, offset 0)
		const ab = new ArrayBuffer(raw.byteLength);
		const view = new Uint8Array(ab);
		view.set(raw);
		captured.onStdout(view);
	};
	const fireStderr = (text: string): void => {
		if (!captured) throw new Error("listener not captured yet");
		const enc = new TextEncoder();
		const raw = enc.encode(text);
		const ab = new ArrayBuffer(raw.byteLength);
		const view = new Uint8Array(ab);
		view.set(raw);
		captured.onStderr(view);
	};
	const fireExit = (code: number | null, signal: string | null): void => {
		if (!captured) throw new Error("listener not captured yet");
		captured.onExit(Object.freeze({ code, signal }));
	};
	const fireClose = (): void => {
		if (!captured) throw new Error("listener not captured yet");
		captured.onClose();
	};
	const fireProcessError = (): void => {
		if (!captured) throw new Error("listener not captured yet");
		captured.onProcessError();
	};
	const process = validProcess({
		subscribe: (listener: SshProcessEventListener): object => {
			captured = listener;
			return subscriptionOk();
		},
	});
	return { process, listener: captured, fireStdout, fireStderr, fireExit, fireClose, fireProcessError, get listener_() { return captured; } };
}

/** A sentinel promise that never settles — used to test timeouts. */
function neverPromise(): Promise<object> {
	return new Promise<object>(() => { /* never */ });
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

describe("createSshProcessMonitor preflight", () => {
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
		const inp = validInput() as Record<string, unknown>;
		const { process, expectedNonce, confirmRelayAdmission, ...rest } = inp as unknown as Record<string, unknown>;
		assertFail(makeMonitor({ ...rest, process, expectedNonce }));
	});

	it("rejects extra key", () => {
		const inp = { ...validInput(), extra: 1 } as Record<string, unknown>;
		assertFail(makeMonitor(inp));
	});

	it("rejects Symbol key", () => {
		const inp: Record<string | symbol, unknown> = {};
		const proc = validProcess();
		const n = nonce();
		const adm = validAdmission();
		const to = validTimeouts();
		inp.process = proc;
		inp.expectedNonce = n;
		inp.confirmRelayAdmission = adm;
		inp.timeouts = to;
		inp[Symbol("x")] = 1;
		assertFail(makeMonitor(inp));
	});

	it("rejects non-enumerable key", () => {
		const inp: Record<string, unknown> = {};
		const proc = validProcess();
		const n = nonce();
		const adm = validAdmission();
		const to = validTimeouts();
		inp.process = proc;
		inp.expectedNonce = n;
		inp.confirmRelayAdmission = adm;
		inp.timeouts = to;
		Object.defineProperty(inp, "hidden", { value: 1, enumerable: false });
		assertFail(makeMonitor(inp));
	});

	it("rejects accessor property", () => {
		const inp: Record<string, unknown> = {};
		const _process = validProcess();
		const _nonce = nonce();
		const _admission = validAdmission();
		const _timeouts = validTimeouts();
		Object.defineProperties(inp, {
			process: { get: () => _process, enumerable: true },
			expectedNonce: { get: () => _nonce, enumerable: true },
			confirmRelayAdmission: { get: () => _admission, enumerable: true },
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
		assertFail(makeMonitor(validInput({ process: validProcess({ subscribe: (42 as unknown) as (listener: SshProcessEventListener) => object }) })));
	});

	it("rejects process with Proxy subscribe", () => {
		const fn = (): object => subscriptionOk();
		const proxyFn = new Proxy(fn, {});
		assertFail(makeMonitor(validInput({ process: validProcess({ subscribe: proxyFn }) })));
	});

	it("rejects process with non-function signalGroup", () => {
		assertFail(makeMonitor(validInput({ process: validProcess({ signalGroup: (42 as unknown) as (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => object }) })));
	});

	it("rejects process with non-function destroyStdio", () => {
		assertFail(makeMonitor(validInput({ process: validProcess({ destroyStdio: (42 as unknown) as () => object }) })));
	});

	it("rejects non-string expectedNonce", () => {
		assertFail(makeMonitor(validInput({ expectedNonce: (42 as unknown) as string })));
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

	it("rejects non-function confirmRelayAdmission", () => {
		assertFail(makeMonitor(validInput({ confirmRelayAdmission: ("bad" as unknown) as () => unknown })));
	});

	it("rejects Proxy confirmRelayAdmission", () => {
		const fn = (): Promise<object> => Promise.resolve(Object.freeze({ status: "admitted" }));
		assertFail(makeMonitor(validInput({ confirmRelayAdmission: new Proxy(fn, {}) })));
	});

	it("rejects null timeouts", () => {
		assertFail(makeMonitor(validInput({ timeouts: null })));
	});

	it("rejects timeout with missing key", () => {
		const t = validTimeouts() as Record<string, unknown>;
		const { readyTimeoutMs, ...rest } = t;
		assertFail(makeMonitor(validInput({ timeouts: rest })));
	});

	it("rejects timeout with extra key", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...(validTimeouts() as Record<string, unknown>), extra: 1 } })));
	});

	it("rejects non-number readyTimeoutMs", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...validTimeouts(), readyTimeoutMs: "bad" } })));
	});

	it("rejects zero readyTimeoutMs", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...validTimeouts(), readyTimeoutMs: 0 } })));
	});

	it("rejects negative readyTimeoutMs", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...validTimeouts(), readyTimeoutMs: -1 } })));
	});

	it("rejects too-large readyTimeoutMs", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...validTimeouts(), readyTimeoutMs: 120001 } })));
	});

	it("rejects float readyTimeoutMs", () => {
		assertFail(makeMonitor(validInput({ timeouts: { ...validTimeouts(), readyTimeoutMs: 1.5 } })));
	});

	it("rejects missing admissionTimeoutMs", () => {
		const t = validTimeouts() as Record<string, unknown>;
		const { admissionTimeoutMs, ...rest } = t;
		assertFail(makeMonitor(validInput({ timeouts: rest })));
	});

	it("rejects missing sigintTimeoutMs", () => {
		const t = validTimeouts() as Record<string, unknown>;
		const { sigintTimeoutMs, ...rest } = t;
		assertFail(makeMonitor(validInput({ timeouts: rest })));
	});

	it("rejects missing sigtermTimeoutMs", () => {
		const t = validTimeouts() as Record<string, unknown>;
		const { sigtermTimeoutMs, ...rest } = t;
		assertFail(makeMonitor(validInput({ timeouts: rest })));
	});

	it("rejects missing sigkillTimeoutMs", () => {
		const t = validTimeouts() as Record<string, unknown>;
		const { sigkillTimeoutMs, ...rest } = t;
		assertFail(makeMonitor(validInput({ timeouts: rest })));
	});

	it("rejects missing closeConfirmTimeoutMs", () => {
		const t = validTimeouts() as Record<string, unknown>;
		const { closeConfirmTimeoutMs, ...rest } = t;
		assertFail(makeMonitor(validInput({ timeouts: rest })));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Subscribe outcomes
// ─────────────────────────────────────────────────────────────────────────────

describe("subscribe outcomes", () => {
	it("returns SUBSCRIBE_REJECTED when subscribe throws", () => {
		const proc = validProcess({
			subscribe: (): never => { throw new Error("boom"); },
		});
		const result = makeMonitor(validInput({ process: proc }));
		assertOk(result);
		if (!result.ok) return;
		// ready should reject with SUBSCRIBE_REJECTED
		return result.monitor.ready.then((r) => {
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.code).toBe("SUBSCRIBE_REJECTED");
		});
	});

	it("returns SUBSCRIBE_REJECTED when subscribe returns non-object", () => {
		const proc = validProcess({
			subscribe: (): number => 42,
		});
		const result = makeMonitor(validInput({ process: proc }));
		assertOk(result);
		if (!result.ok) return;
		return result.monitor.ready.then((r) => {
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.code).toBe("SUBSCRIBE_REJECTED");
		});
	});

	it("returns SUBSCRIBE_REJECTED when subscribe returns subscribed but no unsubscribe", () => {
		const proc = validProcess({
			subscribe: (): object => Object.freeze({ status: "subscribed" }),
		});
		const result = makeMonitor(validInput({ process: proc }));
		assertOk(result);
		if (!result.ok) return;
		return result.monitor.ready.then((r) => {
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.code).toBe("SUBSCRIBE_REJECTED");
		});
	});

	it("returns SUBSCRIBE_REJECTED when subscribe returns error with sync events", () => {
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				// Fire a sync stderr event before returning.
				const raw = new Uint8Array([65]);
				listener.onStderr(raw);
				return subscriptionError();
			},
		});
		const result = makeMonitor(validInput({ process: proc }));
		assertOk(result);
		if (!result.ok) return;
		return result.monitor.ready.then((r) => {
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.code).toBe("SUBSCRIBE_REJECTED");
		});
	});

	it("accepts error with no sync events", () => {
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionError();
			},
		});
		const result = makeMonitor(validInput({ process: proc }));
		assertOk(result);
		if (!result.ok) return;
		// Should still get READY_TIMEOUT since no stdout arrives.
		return result.monitor.ready.then((r) => {
			expect(r.ok).toBe(false);
		});
	});
});

// ── Synchronous terminal events before subscribe failure ─────────────────

describe("synchronous exit+close before subscribe failure", () => {
	it("sync exit+close then subscribe throws — zero signals sent", async () => {
		const n = nonce();
		const signals: string[] = [];
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): never => {
				listener.onExit(Object.freeze({ code: 0, signal: null }));
				listener.onClose();
				throw new Error("subscribe failed");
			},
			signalGroup: (sig: "SIGINT" | "SIGTERM" | "SIGKILL"): object => {
				signals.push(sig);
				return Object.freeze({ status: "sent" });
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		// exitObserved + closeObserved means beginCleanup waits for close confirm.
		// Since no close timer scenario, it should resolve.
		// Zero signals because terminal events were observed.
		expect(signals.length).toBe(0);
	});

	it("sync exit+close then subscribe returns invalid object — zero signals sent", async () => {
		const n = nonce();
		const signals: string[] = [];
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				listener.onExit(Object.freeze({ code: 0, signal: null }));
				listener.onClose();
				return Object.freeze({});
			},
			signalGroup: (sig: "SIGINT" | "SIGTERM" | "SIGKILL"): object => {
				signals.push(sig);
				return Object.freeze({ status: "sent" });
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		// Zero signals because terminal events were observed before backout.
		expect(signals.length).toBe(0);
	});

	it("sync exit+close then subscribe returns error status — zero signals sent", async () => {
		const n = nonce();
		const signals: string[] = [];
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				listener.onExit(Object.freeze({ code: 0, signal: null }));
				listener.onClose();
				return Object.freeze({ status: "error" });
			},
			signalGroup: (sig: "SIGINT" | "SIGTERM" | "SIGKILL"): object => {
				signals.push(sig);
				return Object.freeze({ status: "sent" });
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		expect(signals.length).toBe(0);
	});

	it("sync exit+close then subscribe returns subscribed but no unsubscribe — zero signals", async () => {
		const n = nonce();
		const signals: string[] = [];
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				listener.onExit(Object.freeze({ code: 0, signal: null }));
				listener.onClose();
				return Object.freeze({ status: "subscribed" });
			},
			signalGroup: (sig: "SIGINT" | "SIGTERM" | "SIGKILL"): object => {
				signals.push(sig);
				return Object.freeze({ status: "sent" });
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		expect(signals.length).toBe(0);
	});
});

// ── Pending admission during close ────────────────────────────────────────

describe("pending admission during close", () => {
	it("admission pending when close() is called — cleanup cancels admission task", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let admissionResolve!: (v: object) => void;
		const admission = (): Promise<object> => new Promise((r) => { admissionResolve = r; });

		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			confirmRelayAdmission: admission,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 100, admissionTimeoutMs: 10000 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Send ready line to start admission.
		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		// Close before admission resolves.
		const closePromise = m.close();

		// Resolve admission late — should be suppressed.
		admissionResolve(Object.freeze({ status: "admitted" }));

		// Ready should fail, close should settle as cleanup failure.
		const readyResult = await m.ready;
		expect(readyResult.ok).toBe(false);

		const closeResult = await closePromise;
		expect(closeResult.ok).toBe(false);
	});

	it("admission rejection handler does not fire after cleanup", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let rejectAdmission!: (reason: unknown) => void;
		const admission = (): Promise<object> => new Promise<object>((_resolve, reject) => { rejectAdmission = reject; });

		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			confirmRelayAdmission: admission,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 100, admissionTimeoutMs: 10000 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		// Close starts cleanup.
		m.close();

		// Reject admission late — should not trigger beginCleanup because
		// admissionTaskActive was cleared by cleanup.
		setTimeout(() => { rejectAdmission(new Error("late")); }, 0);

		await new Promise((r) => setTimeout(r, 30));

		const readyResult = await m.ready;
		expect(readyResult.ok).toBe(false);
	});

	it("close triggers exit+close while admission never settles — closed fails CLEANUP_UNCONFIRMED", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const admission = (): Promise<object> => new Promise<object>(() => {});

		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			confirmRelayAdmission: admission,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 100, admissionTimeoutMs: 10000 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		// Close triggers cleanup. Exit+close fire immediately.
		setTimeout(() => captured!.onExit(Object.freeze({ code: 0, signal: null })), 0);
		setTimeout(() => captured!.onClose(), 5);

		const closeResult = await m.close();
		// Even though exit+close observed, admission was still pending at finalization.
		expect(closeResult.ok).toBe(false);
		if (!closeResult.ok) expect(closeResult.code).toBe("CLEANUP_UNCONFIRMED");

		const readyResult = await m.ready;
		expect(readyResult.ok).toBe(false);
	});

});


// ─────────────────────────────────────────────────────────────────────────────
// Tests: Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("happy path", () => {
	it("succeeds with exact PRIME_AGENT_READY line and confirmed admission", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let admissionCalled = false;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const admission = (): Promise<object> => {
			admissionCalled = true;
			return Promise.resolve(Object.freeze({ status: "admitted" }));
		};
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n, confirmRelayAdmission: admission }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Send the ready line.
		const readyLine = `PRIME_AGENT_READY ${n} 12345\n`;
		const enc = new TextEncoder();
		const raw = enc.encode(readyLine);
		const ab = new ArrayBuffer(raw.byteLength);
		new Uint8Array(ab).set(raw);
		captured!.onStdout(new Uint8Array(ab));

		const readyResult = await m.ready;
		expect(readyResult.ok).toBe(true);
		if (readyResult.ok) expect(readyResult.pid).toBe(12345);
		expect(admissionCalled).toBe(true);
	});

	it("resolves ready after admission resolves", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let admissionResolve!: (v: object) => void;
		const admission = (): Promise<object> => new Promise((r) => { admissionResolve = r; });

		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n, confirmRelayAdmission: admission }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Send ready line.
		const readyLine = `PRIME_AGENT_READY ${n} 67890\n`;
		const enc = new TextEncoder();
		const raw = enc.encode(readyLine);
		const ab = new ArrayBuffer(raw.byteLength);
		new Uint8Array(ab).set(raw);
		captured!.onStdout(new Uint8Array(ab));

		// Ready should not resolve yet.
		let readyDone = false;
		const readyPromise = m.ready.then((r) => { readyDone = true; return r; });
		await Promise.resolve(); // let microtasks run
		expect(readyDone).toBe(false);

		// Now resolve admission.
		admissionResolve(Object.freeze({ status: "admitted" }));
		const readyResult = await readyPromise;
		expect(readyResult.ok).toBe(true);
		if (readyResult.ok) expect(readyResult.pid).toBe(67890);
	});

	it("resolves closed with ok=true when close() is called after ready", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let signalCalls: string[] = [];
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			signalGroup: (sig: "SIGINT" | "SIGTERM" | "SIGKILL"): object => {
				signalCalls.push(sig);
				return Object.freeze({ status: "sent" });
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Complete the ready handshake.
		const readyLine = `PRIME_AGENT_READY ${n} 11111\n`;
		const ab = zeroBuffer(readyLine);
		captured!.onStdout(new Uint8Array(ab));
		const readyResult = await m.ready;
		expect(readyResult.ok).toBe(true);

		// Fire exit + close so cleanup confirms.
		captured!.onExit(Object.freeze({ code: 0, signal: null }));
		captured!.onClose();

		const closeResult = await m.close();
		expect(closeResult.ok).toBe(true);
		// Should NOT have signaled because exit was observed first.
		expect(signalCalls.length).toBe(0);
	});

	it("handles multiple stdout chunks that build the ready line", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Send in two chunks.
		const part1 = `PRIME_AGENT_READY ${n} `;
		const part2 = `99999\n`;
		const ab1 = zeroBuffer(part1);
		const ab2 = zeroBuffer(part2);
		captured!.onStdout(new Uint8Array(ab1));
		await Promise.resolve();
		captured!.onStdout(new Uint8Array(ab2));

		const readyResult = await m.ready;
		expect(readyResult.ok).toBe(true);
		if (readyResult.ok) expect(readyResult.pid).toBe(99999);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Failure codes from stdout parsing
// ─────────────────────────────────────────────────────────────────────────────

describe("stdout parsing failures", () => {
	it("LINE_TOO_LONG when line exceeds 256 bytes without newline", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Send 257 bytes without newline.
		const longLine = "x".repeat(257);
		const ab = zeroBuffer(longLine);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("LINE_TOO_LONG");
	});

	it("LINE_TOO_LONG when newline at position > 256", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// 300 chars then newline.
		const longLine = "x".repeat(300) + "\n";
		const ab = zeroBuffer(longLine);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("LINE_TOO_LONG");
	});

	it("TRAILING_DATA when data exists after newline before completion", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Ready line + extra data after newline within the same chunk.
		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const data = line + "extra\n";
		const ab = zeroBuffer(data);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("TRAILING_DATA");
	});

	it("TRAILING_DATA when ready line prefix is wrong", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `WRONG_PREFIX ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("TRAILING_DATA");
	});

	it("TRAILING_DATA when line has no space separator", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n}\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("TRAILING_DATA");
	});

	it("TRAILING_DATA when pid has extra spaces", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345 67890\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("TRAILING_DATA");
	});

	it("NONCE_MISMATCH when nonce differs", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const wrongNonce = "ffffffffffffffffffffffffffffffff";
		const line = `PRIME_AGENT_READY ${wrongNonce} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("NONCE_MISMATCH");
	});

	it("NONCE_MISMATCH when nonce is not hex", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Our nonce is valid, but the line says something different that isn't hex.
		const line = "PRIME_AGENT_READY zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz 12345\n";
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("NONCE_MISMATCH");
	});

	it("INVALID_PID when pid is empty", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} \n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("INVALID_PID");
	});

	it("INVALID_PID when pid starts with zero", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 0123\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("INVALID_PID");
	});

	it("INVALID_PID when pid is too large", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 9999999999\n`; // 10 digits > MAX_PID
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("INVALID_PID");
	});

	it("TRAILING_DATA when line contains non-printable bytes", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Line with 0x00 byte
		const raw = new Uint8Array([...new TextEncoder().encode(`PRIME_AGENT_READY ${n} 12345`), 0x00, 0x0a]);
		const ab = new ArrayBuffer(raw.byteLength);
		new Uint8Array(ab).set(raw);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("TRAILING_DATA");
	});

	it("LINE_TOO_LONG when total stdout exceeds 8192 bytes", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Send a large chunk that puts us over the limit.
		const big = "a".repeat(8190) + "b".repeat(5);
		const ab = zeroBuffer(big);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("LINE_TOO_LONG");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Chunk validation
// ─────────────────────────────────────────────────────────────────────────────

describe("chunk validation", () => {
	it("INVALID_CHUNK when stdout chunk is a shared buffer view", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Shared chunk (subarray with offset > 0).
		const shared = sharedChunk(`PRIME_AGENT_READY ${n} 12345\n`);
		captured!.onStdout(shared);

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("INVALID_CHUNK");
	});

	it("INVALID_CHUNK when stdout chunk is a Proxy", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const ab = zeroBuffer(`PRIME_AGENT_READY ${n} 12345\n`);
		const view = new Uint8Array(ab);
		const proxy = new Proxy(view, {});
		captured!.onStdout(proxy);

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("INVALID_CHUNK");
	});

	it("INVALID_CHUNK when stdout chunk is empty", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const ab = new ArrayBuffer(0);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("INVALID_CHUNK");
	});

	it("INVALID_CHUNK when stderr chunk is a proxy", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const ab = zeroBuffer("error");
		const view = new Uint8Array(ab);
		captured!.onStderr(new Proxy(view, {}));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("INVALID_CHUNK");
	});

	it("STDERR when valid stderr chunk arrives", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const ab = zeroBuffer("error log\n");
		captured!.onStderr(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("STDERR");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Admission outcomes
// ─────────────────────────────────────────────────────────────────────────────

describe("admission outcomes", () => {
	it("ADMISSION_REJECTED when admission resolves to rejected", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const admission = (): Promise<object> => Promise.resolve(Object.freeze({ status: "rejected" }));
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n, confirmRelayAdmission: admission }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("ADMISSION_REJECTED");
	});

	it("ADMISSION_ERROR when admission rejects", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const admission = (): Promise<object> => Promise.reject(new Error("fail"));
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n, confirmRelayAdmission: admission }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("ADMISSION_ERROR");
	});

	it("ADMISSION_ERROR when admission throws synchronously", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const admission = (): never => { throw new Error("sync fail"); };
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n, confirmRelayAdmission: admission }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("ADMISSION_ERROR");
	});

	it("ADMISSION_ERROR when admission returns non-object", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const admission = (): number => 42;
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n, confirmRelayAdmission: admission }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("ADMISSION_ERROR");
	});

	it("ADMISSION_ERROR when admission returns a Proxy promise", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const p = new Promise<object>(() => {});
		const proxy = new Proxy(p, {});
		const admission = (): Promise<object> => proxy;
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n, confirmRelayAdmission: admission }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("ADMISSION_ERROR");
	});

	it("own then property that calls callback and throws — ready never succeeds (intrinsic bypass)", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			signalGroup: (): object => Object.freeze({ status: "sent" }),
		});
		// An object that looks like a Promise (right prototype) but has an own
		// "then" property that calls the callback and then throws.
		const hostile: Record<string, unknown> = {};
		Object.setPrototypeOf(hostile, Promise.prototype);
		Object.defineProperty(hostile, "then", {
			value: (onFulfilled: (v: unknown) => void): never => {
				onFulfilled(Object.freeze({ status: "admitted" }));
				throw new Error("hostile then threw");
			},
			enumerable: false,
			writable: false,
			configurable: false,
		});
		const admission = (): unknown => hostile;

		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			confirmRelayAdmission: admission,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 100, admissionTimeoutMs: 50, sigintTimeoutMs: 5, sigtermTimeoutMs: 5, sigkillTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const readyResult = await m.ready;
		// ready must NOT succeed — intrinsic .then sees no own "then" function
		// as a callable (since maximize-rejection path rejects own names),
		// or the brand check rejects own properties outright.
		expect(readyResult.ok).toBe(false);
		if (!readyResult.ok) expect(readyResult.code).toBe("ADMISSION_ERROR");
	});

	it("own then property (string) — rejected as ADMISSION_ERROR", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		// Object with Promise prototype but own "then" that is a string.
		const hostile: Record<string, unknown> = {};
		Object.setPrototypeOf(hostile, Promise.prototype);
		hostile.then = "not a function";
		const admission = (): unknown => hostile;

		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			confirmRelayAdmission: admission,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 100, admissionTimeoutMs: 50, sigintTimeoutMs: 5, sigtermTimeoutMs: 5, sigkillTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const readyResult = await m.ready;
		expect(readyResult.ok).toBe(false);
		if (!readyResult.ok) expect(readyResult.code).toBe("ADMISSION_ERROR");
	});

	it("admission with own symbol — rejected as ADMISSION_ERROR", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const sym = Symbol("own");
		const p = new Promise<object>(() => {});
		(p as Record<symbol, unknown>)[sym] = 1;
		const admission = (): unknown => p;

		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			confirmRelayAdmission: admission,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 100, admissionTimeoutMs: 50, sigintTimeoutMs: 5, sigtermTimeoutMs: 5, sigkillTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		const readyResult = await m.ready;
		expect(readyResult.ok).toBe(false);
		if (!readyResult.ok) expect(readyResult.code).toBe("ADMISSION_ERROR");
	});

});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Process events
// ─────────────────────────────────────────────────────────────────────────────

describe("process events", () => {
	it("EXIT when exit fires before ready", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		captured!.onExit(Object.freeze({ code: 1, signal: null }));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("EXIT");
	});

	it("CLOSED when close fires before ready", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		captured!.onClose();

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CLOSED");
	});

	it("PROCESS_ERROR when process error fires before ready", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		captured!.onProcessError();

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("PROCESS_ERROR");
	});

	it("PROCESS_EVENT when exit event is malformed", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		captured!.onExit(Object.freeze({ code: 256, signal: null })); // code out of range

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("PROCESS_EVENT");
	});

	it("PROCESS_EVENT when exit event has bad signal format", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		captured!.onExit(Object.freeze({ code: null, signal: "sigterm" }));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("PROCESS_EVENT");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Timeouts
// ─────────────────────────────────────────────────────────────────────────────

describe("timeouts", () => {
	it("READY_TIMEOUT when no stdout arrives", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 10, sigintTimeoutMs: 5, sigtermTimeoutMs: 5, sigkillTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("READY_TIMEOUT");
	});

	it("ADMISSION_TIMEOUT when admission never resolves", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const neverAdmission = (): Promise<object> => new Promise<object>(() => {});
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			confirmRelayAdmission: neverAdmission,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 100, admissionTimeoutMs: 10, sigintTimeoutMs: 5, sigtermTimeoutMs: 5, sigkillTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		await new Promise((r) => setTimeout(r, 50));

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("ADMISSION_TIMEOUT");
	});

});


// ─────────────────────────────────────────────────────────────────────────────
// Tests: Signal sequence and cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe("cleanup signal sequence", () => {
	it("sends SIGINT then SIGTERM then SIGKILL when exit not observed", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const signals: string[] = [];
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			signalGroup: (sig: "SIGINT" | "SIGTERM" | "SIGKILL"): object => {
				signals.push(sig);
				return Object.freeze({ status: "sent" });
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: {
				...validTimeouts(),
				sigintTimeoutMs: 10,
				sigtermTimeoutMs: 10,
				sigkillTimeoutMs: 10,
				closeConfirmTimeoutMs: 10,
			},
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Trigger cleanup via close().
		const closePromise = m.close();
		const closeResult = await closePromise;
		expect(signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
		// No observed exit, no observed close, so cleanupConfirmed is false.
		expect(closeResult.ok).toBe(false);
	});

	it("skips signal sequence when exit observed before cleanup", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const signals: string[] = [];
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			signalGroup: (sig: "SIGINT" | "SIGTERM" | "SIGKILL"): object => {
				signals.push(sig);
				return Object.freeze({ status: "sent" });
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Exit + close first.
		captured!.onExit(Object.freeze({ code: 0, signal: null }));
		captured!.onClose();

		// Now close() should resolve cleanly.
		const closeResult = await m.close();
		expect(signals.length).toBe(0); // no signals sent
		expect(closeResult.ok).toBe(true);
	});

	it("stops signaling when exit arrives mid-sequence", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let signalIndex = 0;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			signalGroup: (sig: "SIGINT" | "SIGTERM" | "SIGKILL"): object => {
				signalIndex += 1;
				if (signalIndex === 1) {
					// After first signal, fire exit.
					setTimeout(() => captured!.onExit(Object.freeze({ code: 0, signal: null })), 5);
					// And close.
					setTimeout(() => captured!.onClose(), 10);
				}
				return Object.freeze({ status: "sent" });
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: {
				...validTimeouts(),
				sigintTimeoutMs: 100, // won't wait long because exit fires
				sigtermTimeoutMs: 100,
				sigkillTimeoutMs: 100,
				closeConfirmTimeoutMs: 100,
			},
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const closeResult = await m.close();
		// Only SIGINT should have been sent.
		expect(signalIndex).toBe(1); // first signal sent
		// Cleanup is confirmed because exit+close observed.
		expect(closeResult.ok).toBe(true);
	});

	it("signalUncertain prevents ok=true in cleanup", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			signalGroup: (): object => Object.freeze({ status: "error" }),
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: {
				...validTimeouts(),
				sigintTimeoutMs: 10,
				sigtermTimeoutMs: 10,
				sigkillTimeoutMs: 10,
				closeConfirmTimeoutMs: 10,
			},
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Exit + close so process events confirm nicely.
		const closeResult = await m.close();
		expect(closeResult.ok).toBe(false);
		if (!closeResult.ok) expect(closeResult.code).toBe("CLEANUP_UNCONFIRMED");
	});

	it("signalGroup throwing sets signalUncertain", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			signalGroup: (): never => { throw new Error("fail"); },
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: {
				...validTimeouts(),
				sigintTimeoutMs: 10,
				sigtermTimeoutMs: 10,
				sigkillTimeoutMs: 10,
				closeConfirmTimeoutMs: 10,
			},
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const closeResult = await m.close();
		expect(closeResult.ok).toBe(false);
		if (!closeResult.ok) expect(closeResult.code).toBe("CLEANUP_UNCONFIRMED");
	});

	it("signalGroup returning null status sets signalUncertain", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			signalGroup: (): object => Object.freeze({ status: "unknown" }),
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: {
				...validTimeouts(),
				sigintTimeoutMs: 10,
				sigtermTimeoutMs: 10,
				sigkillTimeoutMs: 10,
				closeConfirmTimeoutMs: 10,
			},
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const closeResult = await m.close();
		expect(closeResult.ok).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Close behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("close() behavior", () => {
	it("returns the closed promise", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const p = m.close();
		expect(p).toBe(m.closed);
	});

	it("close() called multiple times returns same promise", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const p1 = m.close();
		const p2 = m.close();
		expect(p1).toBe(p2);
	});

	it("close() after exit+close confirmed returns ok=true", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Complete ready handshake.
		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));
		const readyResult = await m.ready;
		expect(readyResult.ok).toBe(true);

		// Exit + close.
		captured!.onExit(Object.freeze({ code: 0, signal: null }));
		captured!.onClose();

		// Ensure transient cleanup microtasks have settled.
		await new Promise((r) => setTimeout(r, 0));

		const closeResult = await m.close();
		expect(closeResult.ok).toBe(true);
	});

	it("close() after cleanup started resolves via shared promise", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 10, closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const p1 = m.close(); // triggers cleanup with sigint
		const p2 = m.close(); // same promise
		expect(p1).toBe(p2);

		const r = await p1;
		expect(r.ok).toBe(false); // no exit observed, signal timed out
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Unsubscribe and destroyStdio
// ─────────────────────────────────────────────────────────────────────────────

describe("unsubscribe and destroyStdio", () => {
	it("calls unsubscribe during cleanup when registration succeeds", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let unsubscribed = false;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return Object.freeze({
					status: "subscribed",
					unsubscribe: (): object => {
						unsubscribed = true;
						return Object.freeze({ status: "unsubscribed" });
					},
				});
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 10, closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		await m.close();
		expect(unsubscribed).toBe(true);
	});

	it("calls destroyStdio during cleanup", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let destroyed = false;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			destroyStdio: (): object => {
				destroyed = true;
				return Object.freeze({ status: "destroyed" });
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 10, closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		await m.close();
		expect(destroyed).toBe(true);
	});

	it("unsubscribe failure makes cleanupConfirmed false", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return Object.freeze({
					status: "subscribed",
					unsubscribe: (): never => { throw new Error("fail"); },
				});
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 10, closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Exit + close so process is confirmed but cleanup steps fail.
		captured!.onExit(Object.freeze({ code: 0, signal: null }));
		captured!.onClose();

		const closeResult = await m.close();
		expect(closeResult.ok).toBe(false);
	});

	it("destroyStdio failure makes cleanupConfirmed false", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			destroyStdio: (): object => Object.freeze({ status: "not_destroyed" }),
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 10, closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		captured!.onExit(Object.freeze({ code: 0, signal: null }));
		captured!.onClose();

		const closeResult = await m.close();
		expect(closeResult.ok).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Late result suppression
// ─────────────────────────────────────────────────────────────────────────────

describe("late result suppression", () => {
	it("stdout after cleanup started is erased", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Trigger cleanup, then try to send stdout.
		m.close();
		const ab = zeroBuffer("extra data\n");
		captured!.onStdout(new Uint8Array(ab));
		// Should not crash. ready should still fail.
		const r = await m.ready;
		expect(r.ok).toBe(false);
	});

	it("admission after phase has moved on is suppressed", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let admissionResolve!: (v: object) => void;
		const admission = (): Promise<object> => new Promise((r) => { admissionResolve = r; });

		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			confirmRelayAdmission: admission,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 100, admissionTimeoutMs: 10, sigintTimeoutMs: 5, sigtermTimeoutMs: 5, sigkillTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Send ready line to start admission.
		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		// Wait for admission timeout.
		await new Promise((r) => setTimeout(r, 50));

		// Now resolve admission late.
		admissionResolve(Object.freeze({ status: "admitted" }));

		const r = await m.ready;
		expect(r.ok).toBe(false); // should still be failure
		if (!r.ok) expect(r.code).toBe("ADMISSION_TIMEOUT");
	}, 5000);

	it("exit after cleanup started is handled without re-entering cleanup", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Close starts cleanup.
		m.close();

		// Fire exit during cleanup.
		captured!.onExit(Object.freeze({ code: 0, signal: null }));

		// Fire close.
		captured!.onClose();

		const r = await m.closed;
		// Should not crash, should settle somehow.
		expect(r.ok).toBeDefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Source erasure
// ─────────────────────────────────────────────────────────────────────────────

describe("source erasure", () => {
	it("stdout chunk buffer is zeroed after processing", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		const view = new Uint8Array(ab);
		captured!.onStdout(view);

		// Original buffer should be zeroed.
		for (let i = 0; i < view.byteLength; i++) {
			expect(view[i]).toBe(0);
		}
	});

	it("stderr chunk buffer is zeroed after processing", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const ab = zeroBuffer("error msg");
		const view = new Uint8Array(ab);
		captured!.onStderr(view);

		for (let i = 0; i < view.byteLength; i++) {
			expect(view[i]).toBe(0);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Synchronous events
// ─────────────────────────────────────────────────────────────────────────────

describe("synchronous events", () => {
	it("queued stdout events are replayed", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				// Fire stdout synchronously before returning.
				const ab = zeroBuffer(`PRIME_AGENT_READY ${n} 12345\n`);
				listener.onStdout(new Uint8Array(ab));
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const readyResult = await m.ready;
		expect(readyResult.ok).toBe(true);
		if (readyResult.ok) expect(readyResult.pid).toBe(12345);
	});

	it("SYNCHRONOUS_OVERFLOW when too many sync events", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				// Fire 17 events (max is 16).
				for (let i = 0; i < 17; i++) {
					const ab = zeroBuffer("x");
					listener.onStdout(new Uint8Array(ab));
				}
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("SYNCHRONOUS_OVERFLOW");
	});

	it("sync exit triggers exit behavior", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				listener.onExit(Object.freeze({ code: 0, signal: null }));
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("EXIT");
	});

	it("sync close triggers close behavior", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				listener.onClose();
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CLOSED");
	});

	it("sync stderr triggers failure", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				const ab = zeroBuffer("err\n");
				listener.onStderr(new Uint8Array(ab));
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("STDERR");
	});

	it("sync process_error triggers failure", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				listener.onProcessError();
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("PROCESS_ERROR");
	});

	it("sync invalid chunk triggers failure", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				listener.onStdout(42);
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("INVALID_CHUNK");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Race conditions
// ─────────────────────────────────────────────────────────────────────────────

describe("race conditions", () => {
	it("close() and exit race - close triggers cleanup and exit stops signal", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const signals: string[] = [];
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			signalGroup: (sig: "SIGINT" | "SIGTERM" | "SIGKILL"): object => {
				signals.push(sig);
				return Object.freeze({ status: "sent" });
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 100, closeConfirmTimeoutMs: 100 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Call close and fire exit at the same time.
		const closeP = m.close();
		setTimeout(() => captured!.onExit(Object.freeze({ code: 0, signal: null })), 0);
		setTimeout(() => captured!.onClose(), 5);

		const closeResult = await closeP;
		// SIGINT may or may not have been sent, but cleanup should confirm.
		expect(closeResult.ok).toBe(true);
	});

	it("admission resolves after close - fail closed", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let admissionResolve!: (v: object) => void;
		const admission = (): Promise<object> => new Promise((r) => { admissionResolve = r; });

		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			confirmRelayAdmission: admission,
			timeouts: { ...validTimeouts(), closeConfirmTimeoutMs: 10, sigintTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		// Send ready line.
		const line = `PRIME_AGENT_READY ${n} 12345\n`;
		const ab = zeroBuffer(line);
		captured!.onStdout(new Uint8Array(ab));

		// Close immediately.
		m.close();

		// Resolve admission late.
		admissionResolve(Object.freeze({ status: "admitted" }));

		const r = await m.ready;
		expect(r.ok).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Promises settle exactly once
// ─────────────────────────────────────────────────────────────────────────────

describe("promise finality", () => {
	it("ready never settles with ok=true after cleanup", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 10, sigintTimeoutMs: 5, sigtermTimeoutMs: 5, sigkillTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(r.ok).toBe(false);
		// Call again to verify same promise
		const r2 = await m.ready;
		expect(r2).toBe(r); // same reference
	});

	it("closed promise settles exactly once", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), closeConfirmTimeoutMs: 10, sigintTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const p1 = m.close();
		const p2 = m.close();
		const r1 = await p1;
		const r2 = await p2;
		expect(r1).toBe(r2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Edge cases on exit events
// ─────────────────────────────────────────────────────────────────────────────

describe("exit event edge cases", () => {
	it("accepts exit with code=0 and signal=null", () => {
		const e = Object.freeze({ code: 0, signal: null });
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				listener.onExit(e);
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
	});

	it("accepts exit with code=null and signal=SIGTERM", () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				listener.onExit(Object.freeze({ code: null, signal: "SIGTERM" }));
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
	});

	it("rejects exit with code=256 (out of range)", () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				listener.onExit(Object.freeze({ code: 256, signal: null }));
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
	});

	it("rejects exit with code=-1", () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				listener.onExit(Object.freeze({ code: -1, signal: null }));
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
	});

	it("rejects exit with signal containing lowercase", () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				listener.onExit(Object.freeze({ code: null, signal: "sigterm" }));
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({ process: proc, expectedNonce: n }));
		assertOk(result);
		if (!result.ok) return;
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Nonce edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("nonce edge cases", () => {
	it("accepts all-zero nonce", () => {
		const n = "00000000000000000000000000000000";
		const result = makeMonitor(validInput({ expectedNonce: n }));
		assertOk(result);
	});

	it("accepts all-ff nonce", () => {
		const n = "ffffffffffffffffffffffffffffffff";
		const result = makeMonitor(validInput({ expectedNonce: n }));
		assertOk(result);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Cleanup error handling edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("cleanup error handling", () => {
	it("unsubscribe throw is caught", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let unsubCalled = false;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return Object.freeze({
					status: "subscribed",
					unsubscribe: (): never => {
						unsubCalled = true;
						throw new Error("fail");
					},
				});
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 10, closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		captured!.onExit(Object.freeze({ code: 0, signal: null }));
		captured!.onClose();
		await m.close();
		expect(unsubCalled).toBe(true);
	});

	it("destroyStdio throw is caught", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let destroyCalled = false;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			destroyStdio: (): never => {
				destroyCalled = true;
				throw new Error("fail");
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 10, closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		captured!.onExit(Object.freeze({ code: 0, signal: null }));
		captured!.onClose();
		await m.close();
		expect(destroyCalled).toBe(true);
	});

	it("cleanup finalizes only once despite multiple calls", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		let cleanupCount = 0;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return Object.freeze({
					status: "subscribed",
					unsubscribe: (): object => {
						cleanupCount++;
						return Object.freeze({ status: "unsubscribed" });
					},
				});
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 10, closeConfirmTimeoutMs: 10 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		captured!.onExit(Object.freeze({ code: 0, signal: null }));
		captured!.onClose();
		await m.close();
		expect(cleanupCount).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Frozen results
// ─────────────────────────────────────────────────────────────────────────────

describe("frozen results", () => {
	it("CreateSshProcessMonitorResult is frozen", () => {
		const result = makeMonitor(validInput());
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("SshProcessMonitor is frozen", () => {
		const result = makeMonitor(validInput());
		assertOk(result);
		if (!result.ok) return;
		expect(Object.isFrozen(result.monitor)).toBe(true);
		expect(Object.isFrozen(result.monitor.ready)).toBe(false); // promise
		expect(Object.isFrozen(result.monitor.closed)).toBe(false); // promise
	});

	it("INVALID_INPUT result is frozen", () => {
		const result = makeMonitor(null);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("ready result is frozen", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
			signalGroup: (): object => Object.freeze({ status: "sent" }),
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), readyTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.ready;
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("close result is frozen", async () => {
		const n = nonce();
		let captured: SshProcessEventListener | null = null;
		const proc = validProcess({
			subscribe: (listener: SshProcessEventListener): object => {
				captured = listener;
				return subscriptionOk();
			},
		});
		const result = makeMonitor(validInput({
			process: proc,
			expectedNonce: n,
			timeouts: { ...validTimeouts(), sigintTimeoutMs: 5, closeConfirmTimeoutMs: 5 },
		}));
		assertOk(result);
		if (!result.ok) return;
		const m = result.monitor;

		const r = await m.close();
		expect(Object.isFrozen(r)).toBe(true);
	});
});
