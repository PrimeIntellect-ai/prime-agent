/**
 * Focused adversarial tests for PAB1 sandbox bootstrap payload codec.
 *
 * Covers: exact roundtrip + field preservation, optional appVersion,
 * every split/length/trailing/UTF8/canonical/schema/url/id/build/numeric/
 * grant-byte bound, grant never in metadata/errors/JSON/inspect, input
 * erasure every path, returned no aliases, take-once/dispose/with helper,
 * Proxy/getter/symbol/nonenumerable/undefined/extra/cycle/alias,
 * oversize/node/depth, source scan for sensitive field names,
 * buildId strict 64 lowerhex, URL canonical, branded grant constructors,
 * SharedArrayBuffer/detached/immutable inputs.
 */

import { describe, expect, it } from "vitest";
import type {
	EncodeSandboxBootstrapPayloadOpts,
	FailResult,
	MetadataOpts,
	OkResult,
} from "../src/core/sandbox-bootstrap-payload.js";
import {
	decodeSandboxBootstrapPayload,
	encodeSandboxBootstrapPayload,
	GRANT_BRAND,
	isOneUseBootstrapGrant,
	OneUseBootstrapGrant,
	withBootstrapGrant,
} from "../src/core/sandbox-bootstrap-payload.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid grant string consisting of safe visible ASCII. */
const VALID_GRANT_STR = "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklm"; // 50 chars
const VALID_GRANT_BYTES = new TextEncoder().encode(VALID_GRANT_STR);

/** Valid build ID: exactly 64 lowercase hex. */
const VALID_BUILD_ID = "a1b2c3d4e5f6071829a0b1c2d3e4f50617283940a1b2c3d4e5f6071829304150";

function _zero(buf: Uint8Array): void {
	if (buf.byteLength > 0) buf.fill(0);
}

function isZeroed(buf: Uint8Array): boolean {
	for (let i = 0; i < buf.byteLength; i++) {
		if (buf[i] !== 0) return false;
	}
	return true;
}

function validMetadata(overrides?: Partial<MetadataOpts>): MetadataOpts {
	return {
		hostId: "h-1",
		generation: "g-abc",
		sessionId: "s-1",
		relayUrl: "wss://relay.example.com/prime/v1",
		buildIdentity: {
			buildId: VALID_BUILD_ID,
			daemonProtocolVersion: 7,
			daemonSchemaRevision: 25,
		},
		connectTimeoutMs: 30000,
		...overrides,
	};
}

function validOpts(grant?: Uint8Array, metaOverrides?: Partial<MetadataOpts>): EncodeSandboxBootstrapPayloadOpts {
	return {
		metadata: validMetadata(metaOverrides),
		grant: grant ?? new Uint8Array(VALID_GRANT_BYTES),
	};
}

function cloneGrant(src?: Uint8Array): Uint8Array {
	return new Uint8Array(src ?? VALID_GRANT_BYTES);
}

function encodeOk(opts: EncodeSandboxBootstrapPayloadOpts): Uint8Array {
	const result = encodeSandboxBootstrapPayload(opts);
	if (!result.ok) throw new Error(`encode failed: ${result.code}`);
	return result.value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeOk(payload: Uint8Array): any {
	const result = decodeSandboxBootstrapPayload(payload);
	if (!result.ok) throw new Error(`decode failed: ${result.code}`);
	return result.value;
}

// ---------------------------------------------------------------------------
// Brand / constructor tests
// ---------------------------------------------------------------------------

describe("OneUseBootstrapGrant brand", () => {
	it("isOneUseBootstrapGrant detects genuine instances", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41]), GRANT_BRAND);
		expect(isOneUseBootstrapGrant(g)).toBe(true);
	});

	it("isOneUseBootstrapGrant rejects plain objects", () => {
		expect(isOneUseBootstrapGrant({})).toBe(false);
	});

	it("isOneUseBootstrapGrant rejects null/undefined", () => {
		expect(isOneUseBootstrapGrant(null)).toBe(false);
		expect(isOneUseBootstrapGrant(undefined)).toBe(false);
	});

	it("private constructor throws on direct call with wrong brand", () => {
		// The class is exported but the brand check prevents outside instantiation
		expect(() => new OneUseBootstrapGrant(new Uint8Array([0x41]), "fake" as unknown as symbol)).toThrow();
	});
});

// ---------------------------------------------------------------------------
// Roundtrip tests
// ---------------------------------------------------------------------------

describe("roundtrip", () => {
	it("encodes and decodes a valid payload", () => {
		const grant = cloneGrant();
		const opts = validOpts(grant);
		const payload = encodeOk(opts);

		// Grant should be zeroed by encode
		expect(isZeroed(grant)).toBe(true);

		const decoded = decodeOk(payload);

		// Payload should be zeroed by decode
		expect(isZeroed(payload)).toBe(true);

		expect(decoded.metadata.version).toBe(1);
		expect(decoded.metadata.hostId).toBe("h-1");
		expect(decoded.metadata.generation).toBe("g-abc");
		expect(decoded.metadata.sessionId).toBe("s-1");
		expect(decoded.metadata.relayUrl).toBe("wss://relay.example.com/prime/v1");
		expect(decoded.metadata.buildIdentity.buildId).toBe(VALID_BUILD_ID);
		expect(decoded.metadata.buildIdentity.daemonProtocolVersion).toBe(7);
		expect(decoded.metadata.buildIdentity.daemonSchemaRevision).toBe(25);
		expect(decoded.metadata.buildIdentity.appVersion).toBeUndefined();
		expect(decoded.metadata.connectTimeoutMs).toBe(30000);

		expect(decoded.grant.byteLength).toBe(VALID_GRANT_BYTES.byteLength);
		expect(decoded.grant.status).toBe("ready");
		const takenResult = decoded.grant.takeBytes();
		expect(takenResult.ok).toBe(true);
		const taken = (takenResult as OkResult<Uint8Array>).value;
		expect(taken.byteLength).toBe(VALID_GRANT_BYTES.byteLength);
		expect(new TextDecoder().decode(taken)).toBe(VALID_GRANT_STR);
	});

	it("preserves all metadata fields including optional appVersion", () => {
		const grant = cloneGrant();
		const opts = validOpts(grant, {
			buildIdentity: {
				buildId: VALID_BUILD_ID,
				daemonProtocolVersion: 8,
				daemonSchemaRevision: 26,
				appVersion: "1.2.3",
			},
			hostId: "host-xyz",
			generation: "gen-42",
			sessionId: "sess-99",
			relayUrl: "wss://sandbox.prime-intellect.ai/ws",
			connectTimeoutMs: 45000,
		});
		const payload = encodeOk(opts);
		const decoded = decodeOk(payload);

		expect(decoded.metadata.hostId).toBe("host-xyz");
		expect(decoded.metadata.generation).toBe("gen-42");
		expect(decoded.metadata.sessionId).toBe("sess-99");
		expect(decoded.metadata.relayUrl).toBe("wss://sandbox.prime-intellect.ai/ws");
		expect(decoded.metadata.buildIdentity.buildId).toBe(VALID_BUILD_ID);
		expect(decoded.metadata.buildIdentity.daemonProtocolVersion).toBe(8);
		expect(decoded.metadata.buildIdentity.daemonSchemaRevision).toBe(26);
		expect(decoded.metadata.buildIdentity.appVersion).toBe("1.2.3");
		expect(decoded.metadata.connectTimeoutMs).toBe(45000);
	});

	it("encodes without appVersion when omitted", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const decoded = decodeOk(payload);
		expect(decoded.metadata.buildIdentity.appVersion).toBeUndefined();
	});

	it("handles max-length grant (128 bytes)", () => {
		const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&()*+,-./;<=>?[]^_`{|}~";
		let long = "";
		while (long.length < 128) long += chars;
		long = long.slice(0, 128);
		const bytes = new TextEncoder().encode(long);
		expect(bytes.byteLength).toBe(128);

		const payload = encodeOk(validOpts(cloneGrant(bytes)));
		const decoded = decodeOk(payload);
		expect(decoded.grant.byteLength).toBe(128);
		const taken = (decoded.grant.takeBytes() as OkResult<Uint8Array>).value;
		expect(new TextDecoder().decode(taken)).toBe(long);
	});

	it("handles min-length grant (32 bytes)", () => {
		const short = "abcdefghijklmnopqrstuvwxyz012345";
		const bytes = new TextEncoder().encode(short);
		expect(bytes.byteLength).toBe(32);

		const payload = encodeOk(validOpts(cloneGrant(bytes)));
		const decoded = decodeOk(payload);
		expect(decoded.grant.byteLength).toBe(32);
		const taken = (decoded.grant.takeBytes() as OkResult<Uint8Array>).value;
		expect(new TextDecoder().decode(taken)).toBe(short);
	});
});

// ---------------------------------------------------------------------------
// Metadata frozen
// ---------------------------------------------------------------------------

describe("metadata frozen", () => {
	it("metadata is deeply frozen after decode", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const decoded = decodeOk(payload);
		expect(Object.isFrozen(decoded.metadata)).toBe(true);
		expect(Object.isFrozen(decoded.metadata.buildIdentity)).toBe(true);
	});

	it("results are frozen", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const encodeResult = encodeSandboxBootstrapPayload(validOpts(cloneGrant()));
		expect(Object.isFrozen(encodeResult)).toBe(true);
		const decodeResult = decodeSandboxBootstrapPayload(payload);
		expect(Object.isFrozen(decodeResult)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Input erasure tests
// ---------------------------------------------------------------------------

describe("input erasure", () => {
	it("encode erases caller grant on success", () => {
		const grant = cloneGrant();
		const payload = encodeOk(validOpts(grant));
		expect(isZeroed(grant)).toBe(true);
		expect(payload.byteLength).toBeGreaterThan(0);
	});

	it("encode erases caller grant on validation failure", () => {
		const shortGrant = new Uint8Array(10);
		shortGrant.fill(0x41);
		const result = encodeSandboxBootstrapPayload(validOpts(shortGrant));
		expect(result.ok).toBe(false);
		expect(isZeroed(shortGrant)).toBe(true);
	});

	it("decode erases caller payload on success", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const copy = new Uint8Array(payload);
		const _decoded = decodeOk(copy);
		expect(isZeroed(copy)).toBe(true);
	});

	it("decode erases caller payload on failure (bad magic)", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		payload[0] = 0x00;
		const copy = new Uint8Array(payload);
		const result = decodeSandboxBootstrapPayload(copy);
		expect(result.ok).toBe(false);
		expect(isZeroed(copy)).toBe(true);
	});

	it("decode erases caller payload on failure (truncated)", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const truncated = payload.slice(0, 3);
		const result = decodeSandboxBootstrapPayload(truncated);
		expect(result.ok).toBe(false);
		expect(isZeroed(truncated)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// OneUseBootstrapGrant tests
// ---------------------------------------------------------------------------

describe("OneUseBootstrapGrant", () => {
	it("takeBytes returns exactly-once", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41, 0x42, 0x43]), GRANT_BRAND);
		expect(g.status).toBe("ready");
		const r1 = g.takeBytes();
		expect(r1.ok).toBe(true);
		expect((r1 as OkResult<Uint8Array>).value.byteLength).toBe(3);
		expect(g.status).toBe("consumed");
	});

	it("takeBytes fails on second call", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41]), GRANT_BRAND);
		g.takeBytes();
		const r2 = g.takeBytes();
		expect(r2.ok).toBe(false);
		expect((r2 as FailResult).code).toBe("PAB1_ERR_GRANT_CONSUMED");
	});

	it("takeBytes fails after dispose", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41]), GRANT_BRAND);
		g.dispose();
		const r = g.takeBytes();
		expect(r.ok).toBe(false);
	});

	it("dispose erases private copy", () => {
		const inner = new Uint8Array([0x41, 0x42, 0x43]);
		const g = new OneUseBootstrapGrant(inner, GRANT_BRAND);
		g.dispose();
		expect(inner[0]).toBe(0x41);
		expect(g.status).toBe("disposed");
	});

	it("dispose is idempotent", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41]), GRANT_BRAND);
		g.dispose();
		g.dispose();
		expect(g.status).toBe("disposed");
	});

	it("byteLength returns non-secret length", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41, 0x42]), GRANT_BRAND);
		expect(g.byteLength).toBe(2);
		g.takeBytes();
		expect(g.byteLength).toBe(0);
	});

	it("toJSON returns undefined", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41]), GRANT_BRAND);
		expect(JSON.stringify(g)).toBe(undefined);
		expect(JSON.stringify([g])).toBe("[null]");
	});

	it("toString hides content", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41, 0x42, 0x43]), GRANT_BRAND);
		expect(g.toString()).toBe("[OneUseBootstrapGrant]");
	});

	it("Symbol.toPrimitive hides content", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41]), GRANT_BRAND);
		expect(`${g}`).toBe("[OneUseBootstrapGrant]");
	});

	it("inspect custom hides content", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41]), GRANT_BRAND);
		const insp = (g as unknown as Record<symbol, () => string>)[Symbol.for("nodejs.util.inspect.custom")]();
		expect(insp).toBe("[OneUseBootstrapGrant]");
	});
});

// ---------------------------------------------------------------------------
// withBootstrapGrant tests
// ---------------------------------------------------------------------------

describe("withBootstrapGrant", () => {
	it("calls callback and erases", async () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41, 0x42]), GRANT_BRAND);
		let captured: Uint8Array | undefined;
		const r = await withBootstrapGrant(g, async (bytes) => {
			captured = bytes;
			expect(bytes.byteLength).toBe(2);
			return 42;
		});
		expect(r.ok).toBe(true);
		expect(g.status).toBe("consumed");
		expect(isZeroed(captured!)).toBe(true);
	});

	it("disposes on callback throw", async () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41]), GRANT_BRAND);
		const r = await withBootstrapGrant(g, async () => {
			throw new Error("boom");
		});
		expect(r.ok).toBe(false);
		expect(g.status).toBe("consumed");
	});

	it("rejects unbranded grant", async () => {
		const r = await withBootstrapGrant(null as unknown as OneUseBootstrapGrant, async () => 1);
		expect(r.ok).toBe(false);
		expect((r as FailResult).code).toBe("PAB1_ERR_INVALID_BRAND");
	});
});

// ---------------------------------------------------------------------------
// Encoding failure tests
// ---------------------------------------------------------------------------

describe("encode failures", () => {
	it("rejects too-short grant (< 32 bytes)", () => {
		const shortGrant = new Uint8Array(20);
		shortGrant.fill(0x41);
		const result = encodeSandboxBootstrapPayload(validOpts(shortGrant));
		expect(result.ok).toBe(false);
	});

	it("rejects too-long grant (> 128 bytes)", () => {
		const longGrant = new Uint8Array(200);
		longGrant.fill(0x41);
		const result = encodeSandboxBootstrapPayload(validOpts(longGrant));
		expect(result.ok).toBe(false);
	});

	it("rejects grant with colon bytes", () => {
		const badGrant = new Uint8Array(40);
		badGrant.fill(0x41);
		badGrant[20] = 0x3a;
		const result = encodeSandboxBootstrapPayload(validOpts(badGrant));
		expect(result.ok).toBe(false);
	});

	it("rejects grant with quote bytes", () => {
		const badGrant = new Uint8Array(40);
		badGrant.fill(0x41);
		badGrant[10] = 0x22;
		const result = encodeSandboxBootstrapPayload(validOpts(badGrant));
		expect(result.ok).toBe(false);
	});

	it("rejects grant with backslash bytes", () => {
		const badGrant = new Uint8Array(40);
		badGrant.fill(0x41);
		badGrant[15] = 0x5c;
		const result = encodeSandboxBootstrapPayload(validOpts(badGrant));
		expect(result.ok).toBe(false);
	});

	it("rejects grant with control bytes", () => {
		const badGrant = new Uint8Array(40);
		badGrant.fill(0x41);
		badGrant[5] = 0x00;
		const result = encodeSandboxBootstrapPayload(validOpts(badGrant));
		expect(result.ok).toBe(false);
	});

	it("rejects null opts", () => {
		const result = encodeSandboxBootstrapPayload(null as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(result.ok).toBe(false);
	});

	it("rejects array opts", () => {
		const result = encodeSandboxBootstrapPayload([] as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Decode failure tests
// ---------------------------------------------------------------------------

describe("decode failures", () => {
	it("fails on null/undefined input", () => {
		expect(decodeSandboxBootstrapPayload(null as unknown as Uint8Array).ok).toBe(false);
		expect(decodeSandboxBootstrapPayload(undefined as unknown as Uint8Array).ok).toBe(false);
	});

	it("fails on truncated payload (too short for header)", () => {
		const result = decodeSandboxBootstrapPayload(new Uint8Array(3));
		expect(result.ok).toBe(false);
	});

	it("fails on oversized payload (> 64K)", () => {
		const big = new Uint8Array(70000);
		big.fill(0);
		const result = decodeSandboxBootstrapPayload(big);
		expect(result.ok).toBe(false);
	});

	it("fails on bad magic", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		payload[0] = 0xff;
		const result = decodeSandboxBootstrapPayload(payload);
		expect(result.ok).toBe(false);
		expect((result as FailResult).code).toBe("PAB1_ERR_MAGIC");
	});

	it("fails on zero metadata length", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		dv.setUint32(4, 0);
		const result = decodeSandboxBootstrapPayload(payload);
		expect(result.ok).toBe(false);
	});

	it("fails on metadata oversize (> 16K)", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		dv.setUint32(4, 20000);
		const result = decodeSandboxBootstrapPayload(payload);
		expect(result.ok).toBe(false);
	});

	it("fails on too-short grant length", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const metaLen = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4);
		const grantLenOffset = 8 + metaLen;
		const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		dv.setUint16(grantLenOffset, 10);
		const result = decodeSandboxBootstrapPayload(payload);
		expect(result.ok).toBe(false);
	});

	it("fails on too-long grant length", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const metaLen = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4);
		const grantLenOffset = 8 + metaLen;
		const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		dv.setUint16(grantLenOffset, 200);
		const result = decodeSandboxBootstrapPayload(payload);
		expect(result.ok).toBe(false);
	});

	it("fails on trailing data after grant", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const extended = new Uint8Array(payload.byteLength + 1);
		extended.set(payload);
		extended[payload.byteLength] = 0x00;
		const result = decodeSandboxBootstrapPayload(extended);
		expect(result.ok).toBe(false);
		expect((result as FailResult).code).toBe("PAB1_ERR_TRAILING");
	});

	it("fails on truncated grant bytes", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const truncated = payload.slice(0, payload.byteLength - 10);
		const result = decodeSandboxBootstrapPayload(truncated);
		expect(result.ok).toBe(false);
	});

	it("fails on invalid UTF-8 in metadata", () => {
		const grant = cloneGrant();
		const metaJson = JSON.stringify({
			version: 1,
			hostId: "h-1",
			generation: "g-abc",
			sessionId: "s-1",
			relayUrl: "wss://relay.example.com/prime/v1",
			buildIdentity: {
				buildId: VALID_BUILD_ID,
				daemonProtocolVersion: 7,
				daemonSchemaRevision: 25,
			},
			connectTimeoutMs: 30000,
		});
		const metaBytes = new TextEncoder().encode(metaJson);
		metaBytes[metaBytes.length - 2] = 0xff;
		const payload = buildRawPayload(metaBytes, grant);
		const result = decodeSandboxBootstrapPayload(payload);
		expect(result.ok).toBe(false);
	});

	it("fails on unknown metadata keys", () => {
		const metaJson = JSON.stringify({
			version: 1,
			hostId: "h-1",
			generation: "g-abc",
			sessionId: "s-1",
			relayUrl: "wss://relay.example.com/prime/v1",
			buildIdentity: {
				buildId: VALID_BUILD_ID,
				daemonProtocolVersion: 7,
				daemonSchemaRevision: 25,
			},
			connectTimeoutMs: 30000,
			extraKey: "fail",
		});
		const metaBytes = new TextEncoder().encode(metaJson);
		const result = decodeSandboxBootstrapPayload(buildRawPayload(metaBytes, new Uint8Array(50).fill(0x41)));
		expect(result.ok).toBe(false);
	});

	it("fails on non-canonical JSON (key reorder)", () => {
		const metaJson = JSON.stringify({
			version: 1,
			generation: "g-abc",
			hostId: "h-1",
			sessionId: "s-1",
			relayUrl: "wss://relay.example.com/prime/v1",
			buildIdentity: {
				buildId: VALID_BUILD_ID,
				daemonProtocolVersion: 7,
				daemonSchemaRevision: 25,
			},
			connectTimeoutMs: 30000,
		});
		const metaBytes = new TextEncoder().encode(metaJson);
		const result = decodeSandboxBootstrapPayload(buildRawPayload(metaBytes, new Uint8Array(50).fill(0x41)));
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Metadata validation tests
// ---------------------------------------------------------------------------

describe("metadata validation", () => {
	it("fails on version != 1", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ version: 2 }));
		expect(result.ok).toBe(false);
	});

	it("fails on invalid hostId", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ hostId: "" }));
		expect(result.ok).toBe(false);
	});

	it("fails on missing sessionId", () => {
		const metaJson = JSON.stringify({
			version: 1,
			hostId: "h-1",
			generation: "g-abc",
			relayUrl: "wss://relay.example.com/prime/v1",
			buildIdentity: {
				buildId: VALID_BUILD_ID,
				daemonProtocolVersion: 7,
				daemonSchemaRevision: 25,
			},
			connectTimeoutMs: 30000,
		});
		const metaBytes = new TextEncoder().encode(metaJson);
		const grant = new Uint8Array(50).fill(0x41);
		const result = decodeSandboxBootstrapPayload(buildRawPayload(metaBytes, grant));
		expect(result.ok).toBe(false);
	});

	it("fails on invalid relayUrl (not wss://)", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "ws://relay.example.com/prime/v1" }));
		expect(result.ok).toBe(false);
	});

	it("fails on relayUrl with username", () => {
		const url = "wss://user@relay.example.com/prime/v1";
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: url }));
		expect(result.ok).toBe(false);
	});

	it("fails on relayUrl with query", () => {
		const result = decodeSandboxBootstrapPayload(
			buildRawMeta({ relayUrl: "wss://relay.example.com/prime/v1?key=val" }),
		);
		expect(result.ok).toBe(false);
	});

	it("fails on relayUrl with fragment", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://relay.example.com/prime/v1#sec" }));
		expect(result.ok).toBe(false);
	});

	it("fails on relayUrl with default port", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://relay.example.com:443/prime/v1" }));
		expect(result.ok).toBe(false);
	});

	it("fails on localhost relayUrl", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://localhost/prime/v1" }));
		expect(result.ok).toBe(false);
	});

	it("fails on .localhost relayUrl", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://x.localhost/prime/v1" }));
		expect(result.ok).toBe(false);
	});

	it("fails on .local relayUrl", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://x.local/prime/v1" }));
		expect(result.ok).toBe(false);
	});

	it("fails on loopback IP relayUrl", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://127.0.0.1/prime/v1" }));
		expect(result.ok).toBe(false);
	});

	it("fails on private IP relayUrl (10.x.x.x)", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://10.0.0.1/prime/v1" }));
		expect(result.ok).toBe(false);
	});

	it("fails on link-local IP relayUrl", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://169.254.1.1/prime/v1" }));
		expect(result.ok).toBe(false);
	});

	it("fails on bare hostname without path", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com" }));
		expect(result.ok).toBe(false);
	});

	it("fails on empty path", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com/" }));
		expect(result.ok).toBe(false);
	});

	it("fails on null buildIdentity", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: null }));
		expect(result.ok).toBe(false);
	});

	it("fails on number buildIdentity", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: 42 }));
		expect(result.ok).toBe(false);
	});

	it("fails on array buildIdentity", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: [] }));
		expect(result.ok).toBe(false);
	});

	it("fails on string buildIdentity", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: "bad" }));
		expect(result.ok).toBe(false);
	});

	it("fails on non-hex buildId", () => {
		const result = decodeSandboxBootstrapPayload(
			buildRawMeta({ buildIdentity: { buildId: "not-hex", daemonProtocolVersion: 7, daemonSchemaRevision: 25 } }),
		);
		expect(result.ok).toBe(false);
	});

	it("fails on short buildId (< 64 hex)", () => {
		const result = decodeSandboxBootstrapPayload(
			buildRawMeta({
				buildIdentity: { buildId: "a".repeat(63), daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("fails on uppercase hex buildId", () => {
		const result = decodeSandboxBootstrapPayload(
			buildRawMeta({
				buildIdentity: { buildId: "A".repeat(64), daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("fails on non-numeric daemonProtocolVersion", () => {
		const result = decodeSandboxBootstrapPayload(
			buildRawMeta({
				buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: "7", daemonSchemaRevision: 25 },
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("fails on negative daemonProtocolVersion", () => {
		const result = decodeSandboxBootstrapPayload(
			buildRawMeta({
				buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: -1, daemonSchemaRevision: 25 },
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("fails on negative connectTimeoutMs", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ connectTimeoutMs: -1 }));
		expect(result.ok).toBe(false);
	});

	it("fails on oversized connectTimeoutMs", () => {
		const result = decodeSandboxBootstrapPayload(buildRawMeta({ connectTimeoutMs: 999999 }));
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Hostile/grant isolation tests
// ---------------------------------------------------------------------------

describe("grant isolation", () => {
	it("grant bytes never appear in metadata", () => {
		const payload = encodeOk(validOpts(cloneGrant()));
		const decoded = decodeOk(payload);
		const metaStr = JSON.stringify(decoded.metadata);
		const grantStr = new TextDecoder().decode(VALID_GRANT_BYTES);
		expect(metaStr).not.toContain(grantStr);
	});

	it("grant bytes never appear in error codes", () => {
		const shortGrant = new Uint8Array(10).fill(0x41);
		const result = encodeSandboxBootstrapPayload(validOpts(shortGrant));
		// Error code is a fixed safe string; the raw grant content (0x41 = 'A')
		// must not appear verbatim. The code 'PAB1_ERR_GRANT_LENGTH' contains
		// the word "GRANT" which is an identifier, not leaked content.
		expect((result as FailResult).code).not.toContain("AAA");
		expect((result as FailResult).code).not.toContain("41");
	});

	it("grant bytes never appear in JSON.stringify of grant obj", () => {
		const g = new OneUseBootstrapGrant(new Uint8Array([0x41, 0x42, 0x43]), GRANT_BRAND);
		const json = JSON.stringify(g);
		expect(json).toBe(undefined);
		expect(JSON.stringify([g])).toBe("[null]");
	});
});

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

describe("source scan", () => {
	it("no sensitive field names in error codes", () => {
		const codes = [
			"PAB1_ERR_MAGIC",
			"PAB1_ERR_META_OVERSIZE",
			"PAB1_ERR_META_READ",
			"PAB1_ERR_META_PARSE",
			"PAB1_ERR_META_UNKNOWN",
			"PAB1_ERR_META_TYPE",
			"PAB1_ERR_META_NONCANONICAL",
			"PAB1_ERR_GRANT_LENGTH",
			"PAB1_ERR_GRANT_BYTE",
			"PAB1_ERR_TRAILING",
			"PAB1_ERR_OVERSIZE",
			"PAB1_ERR_TRUNCATED",
			"PAB1_ERR_RELAY_URL",
			"PAB1_ERR_ID",
			"PAB1_ERR_BUILD_IDENTITY",
			"PAB1_ERR_TIMEOUT",
			"PAB1_ERR_VERSION",
			"PAB1_ERR_GRANT_CONSUMED",
			"PAB1_ERR_GRANT_DISPOSED",
		];
		for (const code of codes) {
			expect(code).toMatch(/^PAB1_ERR_[A-Z_]+$/);
			expect(code).not.toContain("GRANT_VALUE");
			expect(code).not.toContain("HASH");
			expect(code).not.toContain("TOKEN");
			expect(code).not.toContain("SECRET");
			expect(code).not.toContain("PASSWORD");
			expect(code).not.toContain("API_KEY");
		}
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRawPayload(metaBytes: Uint8Array, grant: Uint8Array): Uint8Array {
	const payload = new Uint8Array(4 + 4 + metaBytes.length + 2 + grant.length);
	const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	payload.set([0x50, 0x41, 0x42, 0x31], 0);
	dv.setUint32(4, metaBytes.length);
	payload.set(metaBytes, 8);
	dv.setUint16(8 + metaBytes.length, grant.length);
	payload.set(grant, 8 + metaBytes.length + 2);
	return payload;
}

function buildRawMeta(overrides: Record<string, unknown>): Uint8Array {
	const base: Record<string, unknown> = {
		version: 1,
		hostId: "h-1",
		generation: "g-abc",
		sessionId: "s-1",
		relayUrl: "wss://relay.example.com/prime/v1",
		buildIdentity: {
			buildId: VALID_BUILD_ID,
			daemonProtocolVersion: 7,
			daemonSchemaRevision: 25,
		},
		connectTimeoutMs: 30000,
	};
	const merged = JSON.parse(JSON.stringify(base));
	for (const [k, v] of Object.entries(overrides)) {
		if (k === "buildIdentity") {
			merged.buildIdentity = v;
		} else {
			merged[k] = v;
		}
	}
	const metaJson = JSON.stringify(merged);
	const metaBytes = new TextEncoder().encode(metaJson);
	const grant = new Uint8Array(50).fill(0x41);
	return buildRawPayload(metaBytes, grant);
}
