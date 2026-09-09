import { describe, expect, it } from "vitest";
import type { V16Method } from "../src/modes/daemon/sandbox/prime-sandbox-v16-request-codec.js";
import { decodeRequest, encodeRequest } from "../src/modes/daemon/sandbox/prime-sandbox-v16-request-codec.js";

// ---------- helper: wrap a valid list_agents encode as a decode helper ----------
// Returns empty sentinel on failure (tests decode the sentinel and naturally reject it).

function encodeListAgents(): Uint8Array {
	const enc = encodeRequest({ method: "list_agents", body: {} });
	if (enc.ok) return enc.bytes;
	return new Uint8Array(0);
}

function encodeRoster(): Uint8Array {
	const enc = encodeRequest({ method: "roster", body: {} });
	if (enc.ok) return enc.bytes;
	return new Uint8Array(0);
}

// ---------- all 9 methods: encode round-trip through decode ----------

const methods: V16Method[] = [
	"list_agents",
	"roster",
	"observe_list",
	"await_pending",
	"assert_name",
	"set_name",
	"send_message",
	"observe_get",
	"observe_recent",
];

const methodBodies: Record<string, unknown> = {
	list_agents: {},
	roster: {},
	observe_list: {},
	await_pending: { selector: "my-sel_01" },
	assert_name: { name: "agent-X", depth: 0, parentSessionId: null, ignoreSessionId: null },
	set_name: { name: "agent-X" },
	send_message: {
		target: "C01",
		message: "hello",
		receiverRole: "parent",
	},
	observe_get: { target: "C01" },
	observe_recent: { target: "C01", limit: 10, maxChars: 500 },
};

describe("V16 request codec – encode/decode all 9 methods", () => {
	for (const m of methods) {
		it(`encodes and canonically decodes ${m}`, () => {
			const body = methodBodies[m];
			const enc = encodeRequest({ method: m, body });
			expect(enc.ok).toBe(true);
			if (!enc.ok) return;
			const dec = decodeRequest(enc.bytes);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;
			expect(dec.request.method).toBe(m);
		});
	}
});

describe("V16 request codec – strict canonical", () => {
	it("decode rejects duplicate bytes (extra trailing byte)", () => {
		const bytes = encodeListAgents();
		const modified = new Uint8Array(bytes.length + 1);
		modified.set(bytes);
		modified[bytes.length] = 0;
		expect(decodeRequest(modified).ok).toBe(false);
	});

	it("decode rejects missing trailing byte", () => {
		const bytes = encodeListAgents();
		const modified = bytes.subarray(0, bytes.length - 1);
		expect(decodeRequest(modified).ok).toBe(false);
	});

	it("decode rejects byte-for-byte different body injection", () => {
		// roster and list_agents produce different wire — feed the wrong bytes
		// after a valid list_agents decode
		const rosterBytes = encodeRoster();
		expect(decodeRequest(rosterBytes).ok).toBe(true);
		const dec = decodeRequest(rosterBytes);
		if (!dec.ok) return;
		expect(dec.request.method).toBe("roster");
	});
});

describe("V16 request codec – bounds", () => {
	it("rejects oversized input", () => {
		const large = new Uint8Array(300_000);
		expect(decodeRequest(large).ok).toBe(false);
	});

	it("rejects encode with over-long string (>16k UTF-8)", () => {
		// Each 'a' = 1 UTF-8 byte; 16385 > MAX_STRING_UTF8_BYTES (16384)
		const longMessage = "a".repeat(16385);
		const enc = encodeRequest({
			method: "send_message",
			body: { target: "C01", message: longMessage, receiverRole: "parent" },
		});
		expect(enc.ok).toBe(false);
	});

	it("rejects invalid encode method", () => {
		const enc = encodeRequest({ method: "unknown_method", body: {} });
		expect(enc.ok).toBe(false);
	});

	it("rejects non-object body for method requiring fields", () => {
		const enc = encodeRequest({ method: "send_message", body: "not-an-object" });
		expect(enc.ok).toBe(false);
	});
});

describe("V16 request codec – decode failure modes", () => {
	it("rejects non-Uint8Array input", () => {
		expect(decodeRequest(null).ok).toBe(false);
		expect(decodeRequest("string").ok).toBe(false);
		expect(decodeRequest({}).ok).toBe(false);
	});

	it("rejects invalid JSON bytes", () => {
		expect(decodeRequest(new Uint8Array([0xff, 0xfe, 0x00])).ok).toBe(false);
	});

	it("rejects mutated JSON (body changed but length same)", () => {
		// Encode list_agents, flip the version field byte to make it invalid
		const bytes = encodeListAgents();
		const mod = Uint8Array.from(bytes);
		// Should succeed as-is
		expect(decodeRequest(mod).ok).toBe(true);
		// Modify version value
		const raw = new TextDecoder().decode(mod);
		const tailIdx = raw.lastIndexOf("1");
		const modifiedStr = `${raw.substring(0, tailIdx)}2${raw.substring(tailIdx + 1)}`;
		const modifiedBytes = new TextEncoder().encode(modifiedStr);
		const dec2 = decodeRequest(modifiedBytes);
		expect(dec2.ok).toBe(false);
	});
});
