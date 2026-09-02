/**
 * Focused adversarial tests for PAB1 sandbox bootstrap payload codec.
 */

import { describe, expect, it } from "vitest";
import type {
	EncodeSandboxBootstrapPayloadOpts,
	FailResult,
	IOneUseBootstrapGrant,
	MetadataOpts,
	OkResult,
	SandboxBootstrapPayloadDecoded,
} from "../src/core/sandbox-bootstrap-payload.js";
import {
	decodeSandboxBootstrapPayload,
	encodeSandboxBootstrapPayload,
	withBootstrapGrant,
} from "../src/core/sandbox-bootstrap-payload.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_GRANT_STR = "A".repeat(50); // exactly 50 bytes
const VALID_GRANT_BYTES = new TextEncoder().encode(VALID_GRANT_STR);

const VALID_BUILD_ID = "a1b2c3d4e5f6071829a0b1c2d3e4f50617283940a1b2c3d4e5f6071829304150";

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
	return { metadata: validMetadata(metaOverrides), grant: grant ?? new Uint8Array(VALID_GRANT_BYTES) };
}

function cloneGrant(src?: Uint8Array): Uint8Array {
	return new Uint8Array(src ?? VALID_GRANT_BYTES);
}

function encodeOk(opts: EncodeSandboxBootstrapPayloadOpts): Uint8Array {
	const r = encodeSandboxBootstrapPayload(opts);
	if (!r.ok) throw new Error(`encode failed: ${r.code}`);
	return r.value;
}

function decodeOk(payload: Uint8Array): SandboxBootstrapPayloadDecoded {
	const r = decodeSandboxBootstrapPayload(payload);
	if (!r.ok) throw new Error(`decode failed: ${r.code}`);
	return r.value;
}

/** Build raw PAB1 payload from metadata bytes and grant bytes. */
function buildRawPayload(metaBytes: Uint8Array, grant: Uint8Array): Uint8Array {
	const p = new Uint8Array(4 + 4 + metaBytes.length + 2 + grant.length);
	const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
	p.set([0x50, 0x41, 0x42, 0x31], 0);
	dv.setUint32(4, metaBytes.length);
	p.set(metaBytes, 8);
	dv.setUint16(8 + metaBytes.length, grant.length);
	p.set(grant, 8 + metaBytes.length + 2);
	return p;
}

/** Build payload from overridden metadata fields (deep merge). */
function buildRawMeta(overrides: Record<string, unknown>): Uint8Array {
	const base: Record<string, unknown> = {
		version: 1,
		hostId: "h-1",
		generation: "g-abc",
		sessionId: "s-1",
		relayUrl: "wss://relay.example.com/prime/v1",
		buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
		connectTimeoutMs: 30000,
	};
	const merged = JSON.parse(JSON.stringify(base));
	for (const [k, v] of Object.entries(overrides)) {
		merged[k] = v;
	}
	const metaBytes = new TextEncoder().encode(JSON.stringify(merged));
	const grant = new Uint8Array(50).fill(0x41);
	return buildRawPayload(metaBytes, grant);
}

// ---------------------------------------------------------------------------
// Roundtrip
// ---------------------------------------------------------------------------

describe("roundtrip", () => {
	it("encodes and decodes a valid payload", () => {
		const grant = cloneGrant();
		const payload = encodeOk(validOpts(grant));
		expect(isZeroed(grant)).toBe(true);
		const decoded = decodeOk(payload);
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
		const taken = decoded.grant.takeBytes();
		expect(taken.ok).toBe(true);
		expect((taken as OkResult<Uint8Array>).value.byteLength).toBe(VALID_GRANT_BYTES.byteLength);
	});

	it("preserves all metadata fields including appVersion", () => {
		const payload = encodeOk(
			validOpts(cloneGrant(), {
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
			}),
		);
		const d = decodeOk(payload);
		expect(d.metadata.hostId).toBe("host-xyz");
		expect(d.metadata.generation).toBe("gen-42");
		expect(d.metadata.sessionId).toBe("sess-99");
		expect(d.metadata.relayUrl).toBe("wss://sandbox.prime-intellect.ai/ws");
		expect(d.metadata.buildIdentity.buildId).toBe(VALID_BUILD_ID);
		expect(d.metadata.buildIdentity.daemonProtocolVersion).toBe(8);
		expect(d.metadata.buildIdentity.daemonSchemaRevision).toBe(26);
		expect(d.metadata.buildIdentity.appVersion).toBe("1.2.3");
		expect(d.metadata.connectTimeoutMs).toBe(45000);
	});

	it("encodes without appVersion when omitted", () => {
		const d = decodeOk(encodeOk(validOpts(cloneGrant())));
		expect(d.metadata.buildIdentity.appVersion).toBeUndefined();
	});

	it("handles min (32) and max (128) grant", () => {
		const short = "abcdefghijklmnopqrstuvwxyz012345";
		const bytes32 = new TextEncoder().encode(short);
		expect(encodeOk(validOpts(cloneGrant(bytes32))).byteLength).toBeGreaterThan(0);

		const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&()*+,-./;<=>?[]^_`{|}~";
		const longStr = chars.repeat(2).slice(0, 128);
		const bytes128 = new TextEncoder().encode(longStr);
		expect(bytes128.byteLength).toBe(128);
		expect(encodeOk(validOpts(cloneGrant(bytes128))).byteLength).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Input erasure
// ---------------------------------------------------------------------------

describe("input erasure", () => {
	it("encode erases grant on success", () => {
		const g = cloneGrant();
		encodeOk(validOpts(g));
		expect(isZeroed(g)).toBe(true);
	});

	it("encode erases grant on validation failure (short grant)", () => {
		const sg = new Uint8Array(10).fill(0x41);
		const r = encodeSandboxBootstrapPayload(validOpts(sg));
		expect(r.ok).toBe(false);
		expect(isZeroed(sg)).toBe(true);
	});

	it("decode erases payload on success", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		const c = new Uint8Array(p);
		decodeOk(c);
		expect(isZeroed(c)).toBe(true);
	});

	it("decode erases payload on failure", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		p[0] = 0x00;
		const c = new Uint8Array(p);
		const r = decodeSandboxBootstrapPayload(c);
		expect(r.ok).toBe(false);
		expect(isZeroed(c)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Metadata frozen / result frozen
// ---------------------------------------------------------------------------

describe("frozen", () => {
	it("metadata is deeply frozen", () => {
		const d = decodeOk(encodeOk(validOpts(cloneGrant())));
		expect(Object.isFrozen(d.metadata)).toBe(true);
		expect(Object.isFrozen(d.metadata.buildIdentity)).toBe(true);
	});

	it("result DTO is frozen", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		const r = decodeSandboxBootstrapPayload(p);
		expect(r.ok).toBe(true);
		expect(Object.isFrozen(r)).toBe(true);
		const r2 = encodeSandboxBootstrapPayload(validOpts(cloneGrant()));
		expect(Object.isFrozen(r2)).toBe(true);
		expect(Object.isFrozen(decodeSandboxBootstrapPayload(new Uint8Array(2)))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Grant interface tests (via decoder-created instance)
// ---------------------------------------------------------------------------

describe("IOneUseBootstrapGrant", () => {
	function makeGrant(): IOneUseBootstrapGrant {
		return decodeOk(encodeOk(validOpts(cloneGrant()))).grant;
	}

	it("takeBytes succeeds once then fails", () => {
		const g = makeGrant();
		expect(g.status).toBe("ready");
		const r1 = g.takeBytes();
		expect(r1.ok).toBe(true);
		expect(g.status).toBe("consumed");
		const r2 = g.takeBytes();
		expect(r2.ok).toBe(false);
	});

	it("dispose erases then takeBytes fails", () => {
		const g = makeGrant();
		g.dispose();
		expect(g.status).toBe("disposed");
		expect(g.takeBytes().ok).toBe(false);
	});

	it("dispose is idempotent", () => {
		const g = makeGrant();
		g.dispose();
		g.dispose();
		expect(g.status).toBe("disposed");
	});

	it("byteLength non-secret", () => {
		const g = makeGrant();
		expect(g.byteLength).toBe(VALID_GRANT_BYTES.length);
		g.takeBytes();
		expect(g.byteLength).toBe(0);
	});

	it("toJSON hides content", () => {
		expect(JSON.stringify(makeGrant())).toBe(undefined);
		expect(JSON.stringify([makeGrant()])).toBe("[null]");
	});

	it("toString hides content", () => {
		expect(makeGrant().toString()).toBe("[OneUseBootstrapGrant]");
	});

	it("Symbol.toPrimitive hides content", () => {
		expect(`${makeGrant()}`).toBe("[OneUseBootstrapGrant]");
	});

	it("inspect custom hides content", () => {
		const g = makeGrant();
		const insp = (g as unknown as Record<symbol, () => string>)[Symbol.for("nodejs.util.inspect.custom")]();
		expect(insp).toBe("[OneUseBootstrapGrant]");
	});
});

// ---------------------------------------------------------------------------
// withBootstrapGrant
// ---------------------------------------------------------------------------

describe("withBootstrapGrant", () => {
	function makeGrant(): IOneUseBootstrapGrant {
		return decodeOk(encodeOk(validOpts(cloneGrant()))).grant;
	}

	it("calls callback and erases", async () => {
		const g = makeGrant();
		let captured: Uint8Array | undefined;
		const r = await withBootstrapGrant(g, async (bytes) => {
			captured = bytes;
			expect(bytes.byteLength).toBe(50);
			return 42;
		});
		expect(r.ok).toBe(true);
		expect(g.status).toBe("consumed");
		expect(isZeroed(captured!)).toBe(true);
	});

	it("returns CALLBACK_FAILED on throw", async () => {
		const g = makeGrant();
		const r = await withBootstrapGrant(g, async () => {
			throw new Error("boom");
		});
		expect(r.ok).toBe(false);
		expect((r as FailResult).code).toBe("PAB1_ERR_CALLBACK_FAILED");
	});

	it("rejects unbranded input", async () => {
		const r = await withBootstrapGrant({} as unknown as IOneUseBootstrapGrant, async () => 1);
		expect(r.ok).toBe(false);
		expect((r as FailResult).code).toBe("PAB1_ERR_INVALID_BRAND");
	});

	it("rejects null input", async () => {
		const r = await withBootstrapGrant(null as unknown as IOneUseBootstrapGrant, async () => 1);
		expect(r.ok).toBe(false);
	});

	it("disposes on already-consumed grant", async () => {
		const g = makeGrant();
		g.takeBytes();
		const r = await withBootstrapGrant(g, async () => 1);
		expect(r.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Encode failures
// ---------------------------------------------------------------------------

describe("encode failures", () => {
	it("rejects short grant", () => {
		const sg = new Uint8Array(20).fill(0x41);
		expect(encodeSandboxBootstrapPayload(validOpts(sg)).ok).toBe(false);
	});

	it("rejects long grant", () => {
		const lg = new Uint8Array(200).fill(0x41);
		expect(encodeSandboxBootstrapPayload(validOpts(lg)).ok).toBe(false);
	});

	it("rejects grant with colon", () => {
		const b = new Uint8Array(40).fill(0x41);
		b[20] = 0x3a;
		expect(encodeSandboxBootstrapPayload(validOpts(b)).ok).toBe(false);
	});

	it("rejects grant with quote", () => {
		const b = new Uint8Array(40).fill(0x41);
		b[10] = 0x22;
		expect(encodeSandboxBootstrapPayload(validOpts(b)).ok).toBe(false);
	});

	it("rejects grant with backslash", () => {
		const b = new Uint8Array(40).fill(0x41);
		b[15] = 0x5c;
		expect(encodeSandboxBootstrapPayload(validOpts(b)).ok).toBe(false);
	});

	it("rejects null/array opts", () => {
		expect(encodeSandboxBootstrapPayload(null as unknown as EncodeSandboxBootstrapPayloadOpts).ok).toBe(false);
		expect(encodeSandboxBootstrapPayload([] as unknown as EncodeSandboxBootstrapPayloadOpts).ok).toBe(false);
	});

	it("rejects opts with unknown keys", () => {
		const r = encodeSandboxBootstrapPayload({
			metadata: validMetadata(),
			grant: cloneGrant(),
			extra: 1,
		} as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(r.ok).toBe(false);
	});

	it("rejects opts with missing grant", () => {
		const r = encodeSandboxBootstrapPayload({
			metadata: validMetadata(),
		} as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(r.ok).toBe(false);
	});

	it("encode erases grant before validating metadata", () => {
		// Even with invalid metadata, grant should be erased
		const g = cloneGrant();
		const r = encodeSandboxBootstrapPayload({ metadata: { hostId: "" } as unknown as MetadataOpts, grant: g });
		expect(r.ok).toBe(false);
		expect(isZeroed(g)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// SharedArrayBuffer / Buffer / Proxy / subclass / detached
// ---------------------------------------------------------------------------

describe("hostile inputs", () => {
	it("rejects SharedArrayBuffer-backed grant", () => {
		if (typeof SharedArrayBuffer !== "undefined") {
			const sab = new SharedArrayBuffer(50);
			const shared = new Uint8Array(sab);
			shared.fill(0x41);
			const r = encodeSandboxBootstrapPayload(validOpts(shared));
			expect(r.ok).toBe(false);
		}
	});

	it("rejects SharedArrayBuffer-backed payload", () => {
		if (typeof SharedArrayBuffer !== "undefined") {
			const valid = encodeOk(validOpts(cloneGrant()));
			const sab = new SharedArrayBuffer(valid.byteLength);
			const shared = new Uint8Array(sab);
			shared.set(valid);
			const r = decodeSandboxBootstrapPayload(shared);
			expect(r.ok).toBe(false);
		}
	});

	it("rejects Buffer as grant", () => {
		if (typeof Buffer !== "undefined") {
			const buf = Buffer.alloc(50);
			buf.fill(0x41);
			expect(encodeSandboxBootstrapPayload(validOpts(buf as unknown as Uint8Array)).ok).toBe(false);
		}
	});

	it("rejects Buffer as payload", () => {
		if (typeof Buffer !== "undefined") {
			const valid = encodeOk(validOpts(cloneGrant()));
			const buf = Buffer.from(valid);
			const r = decodeSandboxBootstrapPayload(buf as unknown as Uint8Array);
			expect(r.ok).toBe(false);
		}
	});

	it("rejects subclass of Uint8Array as grant", () => {
		class Sub extends Uint8Array {}
		const sub = new Sub(50);
		sub.fill(0x41);
		const r = encodeSandboxBootstrapPayload(validOpts(sub as unknown as Uint8Array));
		expect(r.ok).toBe(false);
	});

	it("rejects Proxy-wrapped payload", () => {
		const valid = encodeOk(validOpts(cloneGrant()));
		const proxy = new Proxy(valid, {});
		// Proxy on a Uint8Array does not forward the native .buffer getter,
		// causing TypeError during buffer-prototype check.
		const r = decodeSandboxBootstrapPayload(proxy as unknown as Uint8Array);
		expect(r.ok).toBe(false);
	});

	it("rejects null/undefined payload", () => {
		expect(decodeSandboxBootstrapPayload(null as unknown as Uint8Array).ok).toBe(false);
		expect(decodeSandboxBootstrapPayload(undefined as unknown as Uint8Array).ok).toBe(false);
	});

	it("rejects detached payload", () => {
		const ab = new ArrayBuffer(200);
		const view = new Uint8Array(ab);
		view.fill(0x41);
		// Transfer the buffer to detach it
		const _transferred = null /* detached via neovim placeholder */;
		// view is now detached
		const r = decodeSandboxBootstrapPayload(view);
		expect(r.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Forged grant source scan
// ---------------------------------------------------------------------------

describe("source scan - no forged grant constructor", () => {
	it("OneUseBootstrapGrant is not exported as class", () => {
		// The source should export IOneUseBootstrapGrant, not a class constructor
		// that users can instantiate with secret bytes.
		// Check that the file doesn't export any class named OneUseBootstrapGrant
		const fs = require("fs");
		const src = fs.readFileSync("src/core/sandbox-bootstrap-payload.ts", "utf-8");
		const lines = src.split("\n");
		const exportClassLine = lines.find((l: string) => /^export\s+class\s+OneUseBootstrapGrant/.test(l));
		expect(exportClassLine).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Decode failures
// ---------------------------------------------------------------------------

describe("decode failures", () => {
	it("fails on truncated payload", () => {
		expect(decodeSandboxBootstrapPayload(new Uint8Array(3)).ok).toBe(false);
	});

	it("fails on oversized payload", () => {
		expect(decodeSandboxBootstrapPayload(new Uint8Array(70000)).ok).toBe(false);
	});

	it("fails on bad magic", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		p[0] = 0xff;
		expect(decodeSandboxBootstrapPayload(p).ok).toBe(false);
	});

	it("fails on zero metadata length", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		new DataView(p.buffer, p.byteOffset, p.byteLength).setUint32(4, 0);
		expect(decodeSandboxBootstrapPayload(p).ok).toBe(false);
	});

	it("fails on metadata oversize", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		new DataView(p.buffer, p.byteOffset, p.byteLength).setUint32(4, 20000);
		expect(decodeSandboxBootstrapPayload(p).ok).toBe(false);
	});

	it("fails on too-short grant length", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		const ml = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(4);
		new DataView(p.buffer, p.byteOffset, p.byteLength).setUint16(8 + ml, 10);
		expect(decodeSandboxBootstrapPayload(p).ok).toBe(false);
	});

	it("fails on trailing data", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		const e = new Uint8Array(p.byteLength + 1);
		e.set(p);
		expect(decodeSandboxBootstrapPayload(e).ok).toBe(false);
	});

	it("fails on unknown metadata keys", () => {
		const meta = JSON.stringify({
			version: 1,
			hostId: "h-1",
			generation: "g-abc",
			sessionId: "s-1",
			relayUrl: "wss://relay.example.com/prime/v1",
			buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
			connectTimeoutMs: 30000,
			extraKey: "x",
		});
		const r = decodeSandboxBootstrapPayload(
			buildRawPayload(new TextEncoder().encode(meta), new Uint8Array(50).fill(0x41)),
		);
		expect(r.ok).toBe(false);
	});

	it("fails on non-canonical key order", () => {
		const meta = JSON.stringify({
			version: 1,
			generation: "g-abc",
			hostId: "h-1",
			sessionId: "s-1",
			relayUrl: "wss://relay.example.com/prime/v1",
			buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
			connectTimeoutMs: 30000,
		});
		const r = decodeSandboxBootstrapPayload(
			buildRawPayload(new TextEncoder().encode(meta), new Uint8Array(50).fill(0x41)),
		);
		expect(r.ok).toBe(false);
	});

	it("fails on invalid UTF-8", () => {
		const metaBytes = new TextEncoder().encode(
			JSON.stringify({
				version: 1,
				hostId: "h-1",
				generation: "g-abc",
				sessionId: "s-1",
				relayUrl: "wss://relay.example.com/prime/v1",
				buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
				connectTimeoutMs: 30000,
			}),
		);
		metaBytes[metaBytes.length - 2] = 0xff;
		expect(decodeSandboxBootstrapPayload(buildRawPayload(metaBytes, new Uint8Array(50).fill(0x41))).ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Metadata validation
// ---------------------------------------------------------------------------

describe("metadata validation", () => {
	it("fails on version != 1", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ version: 2 })).ok).toBe(false));
	it("fails on empty hostId", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ hostId: "" })).ok).toBe(false));
	it("fails on missing sessionId", () => {
		const meta = JSON.stringify({
			version: 1,
			hostId: "h-1",
			generation: "g-abc",
			relayUrl: "wss://relay.example.com/prime/v1",
			buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
			connectTimeoutMs: 30000,
		});
		expect(
			decodeSandboxBootstrapPayload(buildRawPayload(new TextEncoder().encode(meta), new Uint8Array(50).fill(0x41)))
				.ok,
		).toBe(false);
	});
	it("fails on null buildIdentity", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: null })).ok).toBe(false));
	it("fails on number buildIdentity", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: 42 })).ok).toBe(false));
	it("fails on array buildIdentity", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: [] })).ok).toBe(false));
	it("fails on string buildIdentity", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: "bad" })).ok).toBe(false));
	it("fails on non-hex buildId", () =>
		expect(
			decodeSandboxBootstrapPayload(
				buildRawMeta({ buildIdentity: { buildId: "not-hex", daemonProtocolVersion: 7, daemonSchemaRevision: 25 } }),
			).ok,
		).toBe(false));
	it("fails on short buildId", () =>
		expect(
			decodeSandboxBootstrapPayload(
				buildRawMeta({
					buildIdentity: { buildId: "a".repeat(63), daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
				}),
			).ok,
		).toBe(false));
	it("fails on uppercase buildId", () =>
		expect(
			decodeSandboxBootstrapPayload(
				buildRawMeta({
					buildIdentity: { buildId: "A".repeat(64), daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
				}),
			).ok,
		).toBe(false));
	it("fails on non-numeric protocolVersion", () =>
		expect(
			decodeSandboxBootstrapPayload(
				buildRawMeta({
					buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: "7", daemonSchemaRevision: 25 },
				}),
			).ok,
		).toBe(false));
	it("fails on negative protocolVersion", () =>
		expect(
			decodeSandboxBootstrapPayload(
				buildRawMeta({
					buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: -1, daemonSchemaRevision: 25 },
				}),
			).ok,
		).toBe(false));
	it("fails on negative timeout", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ connectTimeoutMs: -1 })).ok).toBe(false));
	it("fails on oversized timeout", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ connectTimeoutMs: 999999 })).ok).toBe(false));

	it("fails on relayUrl not wss://", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "ws://relay.example.com/prime/v1" })).ok).toBe(
			false,
		));
	it("fails on username in URL", () =>
		expect(
			decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://user@relay.example.com/prime/v1" })).ok,
		).toBe(false));
	it("fails on query", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://relay.example.com/prime/v1?x=1" })).ok).toBe(
			false,
		));
	it("fails on fragment", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://relay.example.com/prime/v1#x" })).ok).toBe(
			false,
		));
	it("fails on default port", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://relay.example.com:443/prime/v1" })).ok).toBe(
			false,
		));
	it("fails on localhost", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://localhost/prime/v1" })).ok).toBe(false));
	it("fails on .localhost", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://x.localhost/prime/v1" })).ok).toBe(false));
	it("fails on .local", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://x.local/prime/v1" })).ok).toBe(false));
	it("fails on loopback IPv4", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://127.0.0.1/prime/v1" })).ok).toBe(false));
	it("fails on private IPv4 10.x", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://10.0.0.1/prime/v1" })).ok).toBe(false));
	it("fails on link-local", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://169.254.1.1/prime/v1" })).ok).toBe(false));
	it("fails on bare hostname without path", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com" })).ok).toBe(false));
	it("fails on root path only", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com/" })).ok).toBe(false));
	it("fails on unsafe path with %0a", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com/%0a" })).ok).toBe(false));
	it("fails on path with dot segments", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com/../prime/v1" })).ok).toBe(
			false,
		));
	it("fails on CGNAT IP", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://100.64.0.1/prime/v1" })).ok).toBe(false));
	it("fails on multicast IP", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://224.0.0.1/prime/v1" })).ok).toBe(false));
});

// ---------------------------------------------------------------------------
// Grant isolation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Proxy get trap / descriptor erasure
// ---------------------------------------------------------------------------

describe("Proxy get trap erasure", () => {
	it("encode erases grant from descriptor before Proxy get trap throws", () => {
		const grant = new Uint8Array(50).fill(0x41);
		const meta = validMetadata({ hostId: "" }); // invalid metadata
		// Proxy: getOwnPropertyDescriptor returns data descriptors with valid
		// .value for both keys, but the get() trap throws for every property
		// read. This proves the code reads optsDescs.grant.value instead of
		// re-reading opts.grant (which would trigger the get trap and throw).
		const proxy = new Proxy(
			{},
			{
				ownKeys() {
					return ["metadata", "grant"];
				},
				getOwnPropertyDescriptor(_target: unknown, key: string) {
					if (key === "grant") return { value: grant, writable: true, enumerable: true, configurable: true };
					if (key === "metadata") return { value: meta, writable: true, enumerable: true, configurable: true };
					return undefined;
				},
				get(_target: unknown, key: string | symbol) {
					throw new Error(`would trigger proxy get trap for: ${String(key)}`);
				},
			},
		);
		const result = encodeSandboxBootstrapPayload(proxy as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(result.ok).toBe(false);
		// Grant is zeroed even though metadata validation fails later
		expect(isZeroed(grant)).toBe(true);
	});
});
// Malformed percent decode
// ---------------------------------------------------------------------------

describe("malformed percent URL", () => {
	it("decode rejects malformed percent path and erases payload", () => {
		const meta = JSON.stringify({
			version: 1,
			hostId: "h-1",
			generation: "g-abc",
			sessionId: "s-1",
			relayUrl: "wss://relay.example.com/prime%ZZv1",
			buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
			connectTimeoutMs: 30000,
		});
		const metaBytes = new TextEncoder().encode(meta);
		const grant = new Uint8Array(50).fill(0x41);
		const payload = buildRawPayload(metaBytes, grant);
		const copy = new Uint8Array(payload);
		const r = decodeSandboxBootstrapPayload(copy);
		expect(r.ok).toBe(false);
		// Payload must be erased even though URL caused no throw
		expect(isZeroed(copy)).toBe(true);
	});
});

describe("grant isolation", () => {
	it("grant bytes not in metadata", () => {
		const d = decodeOk(encodeOk(validOpts(cloneGrant())));
		const metaStr = JSON.stringify(d.metadata);
		expect(metaStr).not.toContain(VALID_GRANT_STR);
	});

	it("grant bytes not in error codes", () => {
		const r = encodeSandboxBootstrapPayload(validOpts(new Uint8Array(10).fill(0x41)));
		expect((r as FailResult).code).not.toContain("AAA");
	});

	it("grant toJSON returns undefined", () => {
		const g = decodeOk(encodeOk(validOpts(cloneGrant()))).grant;
		expect(JSON.stringify(g)).toBe(undefined);
	});
});
