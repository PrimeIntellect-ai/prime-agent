/**
 * Tests for the SandboxCommandRecordV1 codec — four variants, encode/decode,
 * byte validation, digest verification, state/outcome constraints, bounds.
 */

import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";
import {
	decodeSandboxCommandRecordV1,
	encodeSandboxCommandRecordV1,
} from "../src/modes/daemon/sandbox-command-record-codec.js";

// ===========================================================================
// Helpers
// ===========================================================================

function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function makeCommandEnvelope(commandId: string): Record<string, unknown> {
	return {
		type: "command",
		commandId,
		body: { type: "prompt", message: "hello world" },
	};
}

function digestOfEnvelope(env: Record<string, unknown>): string {
	const r = canonicalDigest(env);
	if (!r.ok) throw new Error("canonicalDigest failed");
	return r.value;
}

function makePendingInput(commandId: string, sessionId?: string): Record<string, unknown> {
	const cmd = makeCommandEnvelope(commandId);
	const bodyDigest = digestOfEnvelope(cmd);
	return {
		version: 1,
		recordKind: "pending",
		recordSeq: 1,
		commandId,
		hostId: "h-1",
		generation: "g-1",
		sessionId: sessionId ?? "sess-1",
		recordedAt: "2025-01-15T10:30:00.000Z",
		bodyDigest,
		commandType: "prompt",
		command: cmd,
	};
}

function makeStartedInput(commandId: string, sessionId?: string): Record<string, unknown> {
	const cmd = makeCommandEnvelope(commandId);
	const bodyDigest = digestOfEnvelope(cmd);
	return {
		version: 1,
		recordKind: "started",
		recordSeq: 2,
		commandId,
		hostId: "h-1",
		generation: "g-1",
		sessionId: sessionId ?? "sess-1",
		recordedAt: "2025-01-15T10:30:01.000Z",
		bodyDigest,
		commandType: "prompt",
		command: cmd,
	};
}

function makeCompletedInput(commandId: string, sessionId?: string): Record<string, unknown> {
	const cmd = makeCommandEnvelope(commandId);
	const bodyDigest = digestOfEnvelope(cmd);
	return {
		version: 1,
		recordKind: "completed",
		recordSeq: 3,
		commandId,
		hostId: "h-1",
		generation: "g-1",
		sessionId: sessionId ?? "sess-1",
		recordedAt: "2025-01-15T10:30:02.000Z",
		bodyDigest,
		commandType: "prompt",
		command: cmd,
		outcome: "COMPLETED",
	};
}

function makeInterruptedInput(commandId: string, outcome?: string, sessionId?: string): Record<string, unknown> {
	const cmd = makeCommandEnvelope(commandId);
	const bodyDigest = digestOfEnvelope(cmd);
	return {
		version: 1,
		recordKind: "interrupted",
		recordSeq: 4,
		commandId,
		hostId: "h-1",
		generation: "g-1",
		sessionId: sessionId ?? "sess-1",
		recordedAt: "2025-01-15T10:30:03.000Z",
		bodyDigest,
		commandType: "prompt",
		command: cmd,
		outcome: outcome ?? "INTERRUPTED",
	};
}

// ===========================================================================
// 1. All four variants roundtrip + determinism
// ===========================================================================

describe("roundtrip all four variants", () => {
	it("pending roundtrip", () => {
		const raw = makePendingInput("cmd-p1");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "pending") {
			expect(enc.record.recordKind).toBe("pending");
			return;
		}
		const r = enc.record;
		expect(r.command.type).toBe("command");
		expect(r.command.commandId).toBe("cmd-p1");
		expect(r.command.body).toEqual({ type: "prompt", message: "hello world" });
		expect(r.sessionId).toBe("sess-1");
		expect(r.commandType).toBe("prompt");
		// Decode from the encoded bytes.
		const dec = decodeSandboxCommandRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "pending") {
			expect(dec.record.recordKind).toBe("pending");
			return;
		}
		const d = dec.record;
		expect(d.command.type).toBe("command");
		expect(d.command.body).toEqual(r.command.body);
		expect(d.sessionId).toBe("sess-1");
		expect(d.commandType).toBe("prompt");
	});

	it("started roundtrip", () => {
		const raw = makeStartedInput("cmd-s1");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "started") {
			expect(enc.record.recordKind).toBe("started");
			return;
		}
		const r = enc.record;
		expect(r.command.type).toBe("command");
		expect(r.command.commandId).toBe("cmd-s1");
		const dec = decodeSandboxCommandRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "started") {
			expect(dec.record.recordKind).toBe("started");
			return;
		}
		const d = dec.record;
		expect(d.command).toEqual(r.command);
	});

	it("completed roundtrip with COMPLETED outcome", () => {
		const raw = makeCompletedInput("cmd-c1");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "completed") {
			expect(enc.record.recordKind).toBe("completed");
			return;
		}
		const r = enc.record;
		expect(r.outcome).toBe("COMPLETED");
		const dec = decodeSandboxCommandRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "completed") {
			expect(dec.record.recordKind).toBe("completed");
			return;
		}
		const d = dec.record;
		expect(d.outcome).toBe("COMPLETED");
		expect(d.command).toEqual(r.command);
	});

	it("interrupted roundtrip with INTERRUPTED outcome", () => {
		const raw = makeInterruptedInput("cmd-i1", "INTERRUPTED");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "interrupted") {
			expect(enc.record.recordKind).toBe("interrupted");
			return;
		}
		const r = enc.record;
		expect(r.outcome).toBe("INTERRUPTED");
		const dec = decodeSandboxCommandRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "interrupted") {
			expect(dec.record.recordKind).toBe("interrupted");
			return;
		}
		const d = dec.record;
		expect(d.outcome).toBe("INTERRUPTED");
		expect(d.command).toEqual(r.command);
	});

	it("interrupted roundtrip with CRASH outcome", () => {
		const raw = makeInterruptedInput("cmd-cr1", "CRASH");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "interrupted") {
			expect(enc.record.recordKind).toBe("interrupted");
			return;
		}
		const r = enc.record;
		expect(r.outcome).toBe("CRASH");
		const dec = decodeSandboxCommandRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "interrupted") {
			expect(dec.record.recordKind).toBe("interrupted");
			return;
		}
		const d = dec.record;
		expect(d.outcome).toBe("CRASH");
	});

	it("encode is deterministic", () => {
		const raw = makePendingInput("cmd-det");
		const enc1 = encodeSandboxCommandRecordV1(raw);
		const enc2 = encodeSandboxCommandRecordV1(raw);
		expect(enc1.ok).toBe(true);
		expect(enc2.ok).toBe(true);
		if (!enc1.ok || !enc2.ok) return;
		expect(enc1.bytes).toEqual(enc2.bytes);
	});
});

// ===========================================================================
// 2. All body types (prompt, execute_bash, abort, create_session, etc.)
// ===========================================================================

describe("all body types", () => {
	const bodyTypes: Record<string, Record<string, unknown>> = {
		prompt: { type: "prompt", message: "hello" },
		execute_bash: { type: "execute_bash", command: "ls" },
		abort: { type: "abort" },
		create_session: { type: "create_session", workspaceId: "ws-1" },
		destroy_session: { type: "destroy_session" },
		steer: { type: "steer", message: "steer" },
		abort_bash: { type: "abort_bash" },
		compact: { type: "compact" },
		compact_abort: { type: "compact_abort" },
		checkpoint: { type: "checkpoint" },
		shutdown: { type: "shutdown" },
	};

	for (const [label, body] of Object.entries(bodyTypes)) {
		it(`encodes/decodes body type: ${label}`, () => {
			const cmd = { type: "command" as const, commandId: `cmd-${label}`, body };
			const bodyDigest = (() => {
				const r = canonicalDigest(cmd);
				if (!r.ok) throw new Error("digest");
				return r.value;
			})();
			const raw = {
				version: 1,
				recordKind: "pending" as const,
				recordSeq: 1,
				commandId: `cmd-${label}`,
				hostId: "h-1",
				generation: "g-1",
				sessionId: "sess-1",
				recordedAt: "2025-01-15T10:30:00.000Z",
				bodyDigest,
				commandType: label,
				command: cmd,
			};
			const enc = encodeSandboxCommandRecordV1(raw);
			expect(enc.ok).toBe(true);
			if (!enc.ok) return;
			const dec = decodeSandboxCommandRecordV1(enc.bytes);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;
			if (dec.record.recordKind !== "pending") {
				expect(dec.record.recordKind).toBe("pending");
				return;
			}
			const d = dec.record;
			expect(d.command.body).toEqual(body);
		});
	}
});

// ===========================================================================
// 3. ID / digest mismatch
// ===========================================================================

describe("ID and digest mismatch", () => {
	it("rejects commandId mismatch between top-level and envelope", () => {
		const cmd = makeCommandEnvelope("cmd-other");
		const bodyDigest = digestOfEnvelope(cmd);
		const raw = { ...makePendingInput("cmd-mismatch"), command: cmd, bodyDigest };
		// Top-level commandId is "cmd-mismatch" but envelope has "cmd-other"
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("rejects bodyDigest mismatch", () => {
		const raw = makePendingInput("cmd-bd");
		raw.bodyDigest = "f".repeat(64);
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("decode rejects bodyDigest mismatch", () => {
		const raw = makePendingInput("cmd-dbd");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		parsed.bodyDigest = "e".repeat(64);
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeSandboxCommandRecordV1(tampered).ok).toBe(false);
	});
});

// ===========================================================================
// 4. Session mismatch
// ===========================================================================

describe("session identity", () => {
	it("encode rejects missing sessionId", () => {
		const raw: Record<string, unknown> = makePendingInput("cmd-sm2");
		delete raw.sessionId;
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("encode rejects empty sessionId", () => {
		const raw = makePendingInput("cmd-sm3");
		raw.sessionId = "";
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("decode rejects tampered sessionId", () => {
		const raw = makePendingInput("cmd-sm4", "sess-a");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		parsed.sessionId = "";
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeSandboxCommandRecordV1(tampered).ok).toBe(false);
	});

	it("encode rejects invalid sessionId format", () => {
		const raw = makePendingInput("cmd-sm5");
		raw.sessionId = "bad id!";
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("decode roundtrips with sessionId intact", () => {
		const raw = makePendingInput("cmd-sm5", "sess-unique");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "pending") {
			expect(enc.record.recordKind).toBe("pending");
			return;
		}
		expect(enc.record.sessionId).toBe("sess-unique");
		const dec = decodeSandboxCommandRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "pending") {
			expect(dec.record.recordKind).toBe("pending");
			return;
		}
		expect(dec.record.sessionId).toBe("sess-unique");
	});
});

// ===========================================================================
// 5. State/outcome mismatch
// ===========================================================================

describe("state/outcome mismatch", () => {
	it("rejects completed without outcome", () => {
		const raw: Record<string, unknown> = makeCompletedInput("cmd-no");
		delete raw.outcome;
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("rejects completed with wrong outcome", () => {
		const raw = makeCompletedInput("cmd-wo");
		raw.outcome = "CRASH";
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("rejects completed with INTERRUPTED outcome", () => {
		const raw = makeCompletedInput("cmd-ci");
		raw.outcome = "INTERRUPTED";
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("rejects interrupted with COMPLETED outcome", () => {
		const raw = makeInterruptedInput("cmd-ic");
		raw.outcome = "COMPLETED";
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("rejects interrupted with invalid outcome string", () => {
		const raw = makeInterruptedInput("cmd-io");
		raw.outcome = "UNKNOWN";
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("rejects pending with outcome field", () => {
		const raw: Record<string, unknown> = makePendingInput("cmd-po");
		raw.outcome = "COMPLETED";
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("rejects started with outcome field", () => {
		const raw: Record<string, unknown> = makeStartedInput("cmd-so");
		raw.outcome = "COMPLETED";
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("decode rejects outcome COMPLETED on interrupted record", () => {
		const raw = makeInterruptedInput("cmd-dci", "CRASH");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		parsed.outcome = "COMPLETED";
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeSandboxCommandRecordV1(tampered).ok).toBe(false);
	});

	it("decode rejects missing outcome on completed record", () => {
		const raw = makeCompletedInput("cmd-dmo");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		delete parsed.outcome;
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeSandboxCommandRecordV1(tampered).ok).toBe(false);
	});
});

// ===========================================================================
// 5. Canonical reorder / truncate / overflow
// ===========================================================================

describe("canonical encoding verification", () => {
	function makeCanonBytes(commandId?: string): Uint8Array {
		const raw = makePendingInput(commandId ?? "cmd-can");
		const enc = encodeSandboxCommandRecordV1(raw);
		if (!enc.ok) throw new Error("encode failed");
		return enc.bytes;
	}

	it("rejects leading whitespace", () => {
		const canon = makeCanonBytes("cmd-lw");
		const jsonStr = new TextDecoder().decode(canon);
		expect(decodeSandboxCommandRecordV1(utf8(`  \t\n${jsonStr}`)).ok).toBe(false);
	});

	it("rejects trailing whitespace", () => {
		const canon = makeCanonBytes("cmd-tw");
		const jsonStr = new TextDecoder().decode(canon);
		expect(decodeSandboxCommandRecordV1(utf8(`${jsonStr} \n\n`)).ok).toBe(false);
	});

	it("rejects reordered keys", () => {
		const canon = makeCanonBytes("cmd-ro");
		const jsonStr = new TextDecoder().decode(canon);
		const parsed = JSON.parse(jsonStr);
		const reversedKeys = Object.keys(parsed).reverse();
		const reordered: Record<string, unknown> = Object.create(null);
		for (const k of reversedKeys) reordered[k] = parsed[k];
		expect(decodeSandboxCommandRecordV1(utf8(JSON.stringify(reordered))).ok).toBe(false);
	});

	it("rejects truncated bytes", () => {
		const canon = makeCanonBytes("cmd-tr");
		const truncated = canon.slice(0, Math.floor(canon.length / 2));
		expect(decodeSandboxCommandRecordV1(truncated).ok).toBe(false);
	});

	it("rejects oversized input", () => {
		const huge = new Uint8Array(2_000_000);
		expect(decodeSandboxCommandRecordV1(huge).ok).toBe(false);
	});
});

// ===========================================================================
// 6. Hostile encode inputs
// ===========================================================================

describe("hostile encode inputs", () => {
	it("rejects null", () => {
		expect(encodeSandboxCommandRecordV1(null).ok).toBe(false);
	});
	it("rejects non-object", () => {
		expect(encodeSandboxCommandRecordV1(42).ok).toBe(false);
		expect(encodeSandboxCommandRecordV1("s").ok).toBe(false);
		expect(encodeSandboxCommandRecordV1(true).ok).toBe(false);
	});
	it("rejects array", () => {
		expect(encodeSandboxCommandRecordV1([]).ok).toBe(false);
	});
	it("rejects object with accessor", () => {
		const raw = makePendingInput("cmd-ac");
		const bad = Object.defineProperty({ ...raw }, "recordSeq", {
			get: () => 99,
			enumerable: true,
		});
		expect(encodeSandboxCommandRecordV1(bad).ok).toBe(false);
	});
	it("rejects object with symbol key", () => {
		const raw = { ...makePendingInput("cmd-sk"), [Symbol("x")]: "hidden" };
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});
	it("rejects non-enumerable property", () => {
		const raw = makePendingInput("cmd-ne");
		Object.defineProperty(raw, "x", { value: "y", enumerable: false });
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});
	it("rejects undefined field", () => {
		const raw = makePendingInput("cmd-ud");
		delete raw.commandId;
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});
	it("rejects extra field", () => {
		const raw = { ...makePendingInput("cmd-ef"), extra: "x" };
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});
	it("rejects wrong version", () => {
		const raw = { ...makePendingInput("cmd-wv"), version: 2 };
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});
	it("rejects missing required field", () => {
		const raw: Record<string, unknown> = makePendingInput("cmd-mr");
		delete raw.hostId;
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});
	it("rejects revocable proxy after revoke", () => {
		const raw = makePendingInput("cmd-rp");
		const { proxy, revoke } = Proxy.revocable(raw, {});
		revoke();
		expect(encodeSandboxCommandRecordV1(proxy).ok).toBe(false);
	});
	it("rejects proxy wrapping plain object", () => {
		const raw = makePendingInput("cmd-px");
		const proxy = new Proxy(raw, {});
		expect(encodeSandboxCommandRecordV1(proxy).ok).toBe(false);
	});
	it("rejects null proto object", () => {
		const raw: Record<string, unknown> = makePendingInput("cmd-np");
		const nullProto: Record<string, unknown> = Object.create(null);
		for (const k of Object.keys(raw)) {
			nullProto[k] = raw[k];
		}
		expect(encodeSandboxCommandRecordV1(nullProto).ok).toBe(false);
	});
});

// ===========================================================================
// 7. Hostile decode inputs
// ===========================================================================

describe("hostile decode inputs", () => {
	it("rejects empty Uint8Array", () => {
		expect(decodeSandboxCommandRecordV1(new Uint8Array(0)).ok).toBe(false);
	});
	it("rejects Buffer input", () => {
		expect(decodeSandboxCommandRecordV1(Buffer.from("{}")).ok).toBe(false);
	});
	it("rejects Uint8Array subclass", () => {
		class Fake extends Uint8Array {}
		expect(decodeSandboxCommandRecordV1(new Fake(10)).ok).toBe(false);
	});
	it("rejects SharedArrayBuffer-backed Uint8Array", () => {
		const sab = new SharedArrayBuffer(10);
		expect(decodeSandboxCommandRecordV1(new Uint8Array(sab)).ok).toBe(false);
	});
	it("rejects subview (non-zero byteOffset)", () => {
		const buf = new Uint8Array(100);
		const view = new Uint8Array(buf.buffer, 10, 20);
		expect(decodeSandboxCommandRecordV1(view).ok).toBe(false);
	});
	it("rejects invalid UTF-8 bytes", () => {
		expect(decodeSandboxCommandRecordV1(new Uint8Array([0xff, 0xfe, 0x00, 0x00])).ok).toBe(false);
	});
	it("rejects raw number JSON", () => {
		expect(decodeSandboxCommandRecordV1(utf8("42")).ok).toBe(false);
	});
	it("rejects oversized input and zeroes caller bytes", () => {
		const huge = new Uint8Array(2_000_000);
		expect(decodeSandboxCommandRecordV1(huge).ok).toBe(false);
		expect(huge.every((byte) => byte === 0)).toBe(true);
	});
	it("rejects malicious JSON with extra fields", () => {
		const raw = makePendingInput("cmd-ml");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		parsed.extraField = "bad";
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeSandboxCommandRecordV1(tampered).ok).toBe(false);
	});
	it("rejects own byteLength override on decode input", () => {
		const raw = makePendingInput("cmd-dbl");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const bytes = new Uint8Array(enc.bytes);
		Object.defineProperty(bytes, "byteLength", { value: 9999, enumerable: true, configurable: true });
		expect(decodeSandboxCommandRecordV1(bytes).ok).toBe(false);
	});
	it("rejects own buffer override on decode input", () => {
		const raw = makePendingInput("cmd-dbo");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const bytes = new Uint8Array(enc.bytes);
		Object.defineProperty(bytes, "buffer", { value: new ArrayBuffer(5), enumerable: true, configurable: true });
		expect(decodeSandboxCommandRecordV1(bytes).ok).toBe(false);
	});
	it("rejects own extra property on decode input", () => {
		const raw = makePendingInput("cmd-dne");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const bytes = new Uint8Array(enc.bytes);
		Object.defineProperty(bytes, "extraField", { value: "x", enumerable: true });
		expect(decodeSandboxCommandRecordV1(bytes).ok).toBe(false);
	});
	it("rejects own symbol on decode input", () => {
		const raw = makePendingInput("cmd-dsy");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const bytes = new Uint8Array(enc.bytes);
		Object.defineProperty(bytes, Symbol("x"), { value: 1, enumerable: true });
		expect(decodeSandboxCommandRecordV1(bytes).ok).toBe(false);
	});
	it("rejects Proxy wrapping plain object", () => {
		// Pass a valid Uint8Array through a Proxy to verify Proxy rejection.
		const arr = new Uint8Array([123, 34, 97, 34, 125]);
		const proxy = new Proxy(arr, {});
		expect(decodeSandboxCommandRecordV1(proxy).ok).toBe(false);
	});
	it("rejects revoked Proxy on decode", () => {
		const { proxy, revoke } = Proxy.revocable(new Uint8Array(10), {});
		revoke();
		expect(decodeSandboxCommandRecordV1(proxy).ok).toBe(false);
	});
});

// ===========================================================================
// 8. Freeze
// ===========================================================================

describe("deep freeze", () => {
	it("encode returns frozen record", () => {
		const raw = makePendingInput("cmd-fz");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(Object.isFrozen(enc.record)).toBe(true);
	});
	it("decode returns frozen record", () => {
		const raw = makePendingInput("cmd-fz2");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeSandboxCommandRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec.record)).toBe(true);
	});
	it("returns frozen failures", () => {
		const encodeFailure = encodeSandboxCommandRecordV1({});
		expect(encodeFailure.ok).toBe(false);
		expect(Object.isFrozen(encodeFailure)).toBe(true);
		if (encodeFailure.ok) return;
		expect(Object.isFrozen(encodeFailure.error)).toBe(true);

		const decodeFailure = decodeSandboxCommandRecordV1(new Uint8Array(0));
		expect(decodeFailure.ok).toBe(false);
		expect(Object.isFrozen(decodeFailure)).toBe(true);
		if (decodeFailure.ok) return;
		expect(Object.isFrozen(decodeFailure.error)).toBe(true);
	});

	it("command envelope in returned record is frozen", () => {
		const raw = makePendingInput("cmd-fz3");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "pending") {
			expect(enc.record.recordKind).toBe("pending");
			return;
		}
		const r = enc.record;
		expect(Object.isFrozen(r.command)).toBe(true);
		const dec = decodeSandboxCommandRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "pending") {
			expect(dec.record.recordKind).toBe("pending");
			return;
		}
		const d = dec.record;
		expect(Object.isFrozen(d.command)).toBe(true);
	});
});

// ===========================================================================
// 9. Field bounds
// ===========================================================================

describe("field bounds", () => {
	it("rejects recordSeq <= 0", () => {
		expect(encodeSandboxCommandRecordV1({ ...makePendingInput("c"), recordSeq: 0 }).ok).toBe(false);
	});
	it("rejects recordSeq > 20000", () => {
		expect(encodeSandboxCommandRecordV1({ ...makePendingInput("c"), recordSeq: 20001 }).ok).toBe(false);
	});
	it("rejects invalid commandId", () => {
		expect(encodeSandboxCommandRecordV1(makePendingInput("bad id!")).ok).toBe(false);
	});
	it("rejects commandId > 128 chars", () => {
		expect(encodeSandboxCommandRecordV1(makePendingInput("a".repeat(129))).ok).toBe(false);
	});
	it("rejects invalid hostId", () => {
		expect(encodeSandboxCommandRecordV1({ ...makePendingInput("c"), hostId: "" }).ok).toBe(false);
	});
	it("rejects invalid timestamp", () => {
		expect(encodeSandboxCommandRecordV1({ ...makePendingInput("c"), recordedAt: "bad" }).ok).toBe(false);
	});
	it("rejects non-canonical timestamp", () => {
		expect(
			encodeSandboxCommandRecordV1({ ...makePendingInput("c"), recordedAt: "2025-01-15T10:30:00.000+00:00" }).ok,
		).toBe(false);
	});
	it("rejects invalid bodyDigest", () => {
		expect(encodeSandboxCommandRecordV1({ ...makePendingInput("c"), bodyDigest: "bad" }).ok).toBe(false);
	});
});

// ===========================================================================
// 10. Input/result mutation isolation
// ===========================================================================

describe("mutation isolation", () => {
	it("returned bytes are a fresh copy (mutating result does not affect decode)", () => {
		const raw = makePendingInput("cmd-mi");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const encBytesCopy = new Uint8Array(enc.bytes);
		enc.bytes[0] = 0xff;
		const dec = decodeSandboxCommandRecordV1(encBytesCopy);
		expect(dec.ok).toBe(true);
	});
	it("encode record command is a fresh object (no alias to input)", () => {
		const raw = makePendingInput("cmd-na");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "pending") {
			expect(enc.record.recordKind).toBe("pending");
			return;
		}
		const r = enc.record;
		// Mutate the input command — should not affect the record.
		// Mutate input via descriptor override to avoid cast.
		const rawCmdDesc = Object.getOwnPropertyDescriptor(raw, "command");
		if (rawCmdDesc === undefined) throw new Error("command descriptor not found");
		const rawCmd = rawCmdDesc.value;
		rawCmd.commandId = "mutated";
		expect(r.command.commandId).not.toBe("mutated");
	});
	it("decode record command is a fresh object (no alias to parsed JSON)", () => {
		const raw = makePendingInput("cmd-np2");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const _parsed = JSON.parse(jsonStr);
		const dec = decodeSandboxCommandRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "pending") {
			expect(dec.record.recordKind).toBe("pending");
			return;
		}
		const d = dec.record;
		// parsed.command is the raw object from JSON.parse — the decoded record
		// must use a fresh frozen copy.
		expect(Object.isFrozen(d.command)).toBe(true);
	});
});

// ===========================================================================
// 11. Cross-variant rejection
// ===========================================================================

describe("cross-variant rejection", () => {
	it("rejects pending with outcome field", () => {
		const raw = { ...makePendingInput("c-pwf"), outcome: "COMPLETED" };
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});
	it("rejects wrong recordKind string", () => {
		expect(encodeSandboxCommandRecordV1({ ...makePendingInput("c-wr"), recordKind: "bogus" }).ok).toBe(false);
	});
	it("rejects recordKind 'delivered' (wrong codec)", () => {
		expect(encodeSandboxCommandRecordV1({ ...makePendingInput("c-wk"), recordKind: "delivered" }).ok).toBe(false);
	});
});

// ===========================================================================
// 12. Command type mismatch
// ===========================================================================

describe("command type mismatch", () => {
	it("encode rejects commandType mismatch between field and command.body.type", () => {
		const raw = makePendingInput("cmd-ct1");
		raw.commandType = "abort_bash";
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("encode rejects missing commandType", () => {
		const raw: Record<string, unknown> = makePendingInput("cmd-ct2");
		delete raw.commandType;
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});

	it("decode rejects tampered commandType", () => {
		const raw = makePendingInput("cmd-ct3");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		parsed.commandType = "abort";
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeSandboxCommandRecordV1(tampered).ok).toBe(false);
	});

	it("all four variants verify commandType", () => {
		for (const makeFn of [makePendingInput, makeStartedInput, makeCompletedInput, makeInterruptedInput] as const) {
			const raw = makeFn("cmd-ct4");
			raw.commandType = "abort";
			expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
		}
	});
});

// ===========================================================================
// 13. Null prototype rejection
// ===========================================================================

describe("null prototype rejection", () => {
	it("encode rejects null proto record", () => {
		const raw = makePendingInput("cmd-np1");
		const nullProto: Record<string, unknown> = Object.create(null);
		for (const k of Object.keys(raw)) {
			nullProto[k] = raw[k];
		}
		expect(encodeSandboxCommandRecordV1(nullProto).ok).toBe(false);
	});

	it("encode rejects null proto inner command", () => {
		const raw = makePendingInput("cmd-np2");
		const nullCmd: Record<string, unknown> = Object.create(null);
		nullCmd.type = "command";
		nullCmd.commandId = "cmd-np2-inner";
		nullCmd.body = { type: "prompt", message: "x" };
		raw.command = nullCmd;
		expect(encodeSandboxCommandRecordV1(raw).ok).toBe(false);
	});
});

// ===========================================================================
// 14. Caller byte erasure
// ===========================================================================

describe("caller byte erasure", () => {
	it("success path zeroes caller bytes", () => {
		const raw = makePendingInput("cmd-cb1");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const bytes = new Uint8Array(enc.bytes);
		const dec = decodeSandboxCommandRecordV1(bytes);
		expect(dec.ok).toBe(true);
		// After decode, the input bytes should be zeroed.
		for (let i = 0; i < bytes.length; i++) {
			expect(bytes[i]).toBe(0);
		}
	});

	it("failure path zeroes caller bytes", () => {
		const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x00]);
		const dec = decodeSandboxCommandRecordV1(bytes);
		expect(dec.ok).toBe(false);
		// After failed decode, the input bytes should still be zeroed.
		for (let i = 0; i < bytes.length; i++) {
			expect(bytes[i]).toBe(0);
		}
	});

	it("rejects own fill override on decode input", () => {
		const raw = makePendingInput("cmd-cb3");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const bytes = new Uint8Array(enc.bytes);
		// Override fill on the array — isGenuineUint8Array rejects own extras.
		Object.defineProperty(bytes, "fill", { value: () => bytes, enumerable: true, configurable: true });
		const dec = decodeSandboxCommandRecordV1(bytes);
		expect(dec.ok).toBe(false);
	});

	it("rejects own slice override on decode input", () => {
		const raw = makePendingInput("cmd-cb4");
		const enc = encodeSandboxCommandRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const bytes = new Uint8Array(enc.bytes);
		// Override slice — isGenuineUint8Array rejects own extras.
		Object.defineProperty(bytes, "slice", { value: () => new Uint8Array(0), enumerable: true, configurable: true });
		const dec = decodeSandboxCommandRecordV1(bytes);
		expect(dec.ok).toBe(false);
	});
});
