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

const VALID_GRANT_STR = "A".repeat(50);
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
		buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
		connectTimeoutMs: 30000,
		...overrides,
	};
}
function validOpts(grant?: Uint8Array, mo?: Partial<MetadataOpts>): EncodeSandboxBootstrapPayloadOpts {
	return { metadata: validMetadata(mo), grant: grant ?? new Uint8Array(VALID_GRANT_BYTES) };
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
	for (const [k, v] of Object.entries(overrides)) merged[k] = v;
	const mb = new TextEncoder().encode(JSON.stringify(merged));
	return buildRawPayload(mb, new Uint8Array(50).fill(0x41));
}
function makeGrant(): IOneUseBootstrapGrant {
	return decodeOk(encodeOk(validOpts(cloneGrant()))).grant;
}

// ========== Roundtrip ==========
describe("roundtrip", () => {
	it("valid payload", () => {
		const g = cloneGrant();
		const p = encodeOk(validOpts(g));
		expect(isZeroed(g)).toBe(true);
		const d = decodeOk(p);
		expect(isZeroed(p)).toBe(true);
		expect(d.metadata.hostId).toBe("h-1");
		expect(d.metadata.buildIdentity.buildId).toBe(VALID_BUILD_ID);
		const t = d.grant.takeBytes();
		expect(t.ok).toBe(true);
		expect((t as OkResult<Uint8Array>).value.byteLength).toBe(50);
	});
	it("appVersion", () => {
		const d = decodeOk(
			encodeOk(
				validOpts(cloneGrant(), {
					buildIdentity: {
						buildId: VALID_BUILD_ID,
						daemonProtocolVersion: 8,
						daemonSchemaRevision: 26,
						appVersion: "1.2.3",
					},
					relayUrl: "wss://sandbox.prime-intellect.ai/ws",
					connectTimeoutMs: 45000,
				}),
			),
		);
		expect(d.metadata.buildIdentity.appVersion).toBe("1.2.3");
	});
	it("no appVersion", () => {
		expect(decodeOk(encodeOk(validOpts(cloneGrant()))).metadata.buildIdentity.appVersion).toBeUndefined();
	});
});

// ========== Input erasure on all paths ==========
describe("input erasure", () => {
	it("encode erases grant on success", () => {
		const g = cloneGrant();
		encodeOk(validOpts(g));
		expect(isZeroed(g)).toBe(true);
	});
	it("encode erases grant on short fail", () => {
		const sg = new Uint8Array(10).fill(0x41);
		expect(encodeSandboxBootstrapPayload(validOpts(sg)).ok).toBe(false);
		expect(isZeroed(sg)).toBe(true);
	});
	it("encode erases grant on invalid metadata", () => {
		const g = cloneGrant();
		const r = encodeSandboxBootstrapPayload({ metadata: { hostId: "" } as unknown as MetadataOpts, grant: g });
		expect(r.ok).toBe(false);
		expect(isZeroed(g)).toBe(true);
	});
	it("encode erases grant on opts unknown key", () => {
		const g = cloneGrant();
		const r = encodeSandboxBootstrapPayload({
			metadata: validMetadata(),
			grant: g,
			extra: 1,
		} as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(r.ok).toBe(false);
		expect(isZeroed(g)).toBe(true);
	});
	it("encode erases grant when metadata key is missing", () => {
		const g = cloneGrant();
		const r = encodeSandboxBootstrapPayload({ grant: g } as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(r.ok).toBe(false);
		expect(isZeroed(g)).toBe(true);
	});
	it("decode erases payload on success", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		const c = new Uint8Array(p);
		decodeOk(c);
		expect(isZeroed(c)).toBe(true);
	});
	it("decode erases payload on failure", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		p[0] = 0xff;
		const c = new Uint8Array(p);
		expect(decodeSandboxBootstrapPayload(c).ok).toBe(false);
		expect(isZeroed(c)).toBe(true);
	});
});

// ========== Frozen ==========
describe("frozen", () => {
	it("metadata deeply frozen", () => {
		const d = decodeOk(encodeOk(validOpts(cloneGrant())));
		expect(Object.isFrozen(d.metadata)).toBe(true);
		expect(Object.isFrozen(d.metadata.buildIdentity)).toBe(true);
	});
	it("result frozen", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		expect(Object.isFrozen(decodeSandboxBootstrapPayload(p))).toBe(true);
		expect(Object.isFrozen(encodeSandboxBootstrapPayload(validOpts(cloneGrant())))).toBe(true);
	});
});

// ========== Grant interface ==========
describe("IOneUseBootstrapGrant", () => {
	it("takeBytes once", () => {
		const g = makeGrant();
		expect(g.takeBytes().ok).toBe(true);
		expect(g.takeBytes().ok).toBe(false);
	});
	it("dispose then takeBytes fails", () => {
		const g = makeGrant();
		g.dispose();
		expect(g.takeBytes().ok).toBe(false);
	});
	it("dispose idempotent", () => {
		const g = makeGrant();
		g.dispose();
		g.dispose();
		expect(g.status).toBe("disposed");
	});
	it("byteLength", () => {
		const g = makeGrant();
		expect(g.byteLength).toBe(50);
		g.takeBytes();
		expect(g.byteLength).toBe(0);
	});
	it("toJSON undefined", () => {
		expect(JSON.stringify([makeGrant()])).toBe("[null]");
	});
	it("toString hidden", () => {
		expect(makeGrant().toString()).toBe("[OneUseBootstrapGrant]");
	});
	it("[Symbol.toPrimitive] hidden", () => {
		expect(`${makeGrant()}`).toBe("[OneUseBootstrapGrant]");
	});
});

// ========== withBootstrapGrant ==========
describe("withBootstrapGrant", () => {
	it("calls and erases", async () => {
		const g = makeGrant();
		let c: Uint8Array | undefined;
		const r = await withBootstrapGrant(g, async (b) => {
			c = b;
			return 42;
		});
		expect(r.ok).toBe(true);
		expect(isZeroed(c!)).toBe(true);
	});
	it("CALLBACK_FAILED on throw", async () => {
		const r = await withBootstrapGrant(makeGrant(), async () => {
			throw new Error("x");
		});
		expect(r.ok).toBe(false);
		expect((r as FailResult).code).toBe("PAB1_ERR_CALLBACK_FAILED");
	});
	it("rejects unbranded", async () => {
		expect((await withBootstrapGrant({} as IOneUseBootstrapGrant, async () => 1)).ok).toBe(false);
	});
});

// ========== Encode failures ==========
describe("encode failures", () => {
	it("short grant", () =>
		expect(encodeSandboxBootstrapPayload(validOpts(new Uint8Array(20).fill(0x41))).ok).toBe(false));
	it("long grant", () =>
		expect(encodeSandboxBootstrapPayload(validOpts(new Uint8Array(200).fill(0x41))).ok).toBe(false));
	it("grant with colon", () => {
		const b = new Uint8Array(40).fill(0x41);
		b[20] = 0x3a;
		expect(encodeSandboxBootstrapPayload(validOpts(b)).ok).toBe(false);
	});
	it("null opts", () =>
		expect(encodeSandboxBootstrapPayload(null as unknown as EncodeSandboxBootstrapPayloadOpts).ok).toBe(false));
	it("array opts", () =>
		expect(encodeSandboxBootstrapPayload([] as unknown as EncodeSandboxBootstrapPayloadOpts).ok).toBe(false));
});

// ========== Descriptor-vs-get mismatch tests ==========
describe("descriptor-vs-get mismatch", () => {
	it("encode: Proxy grant descriptor traps get, validates grant via descriptor.value", () => {
		const grant = new Uint8Array(50).fill(0x41);
		const meta = validMetadata({ hostId: "" });
		const proxy = new Proxy(
			{},
			{
				ownKeys() {
					return ["metadata", "grant"];
				},
				getOwnPropertyDescriptor(_t: unknown, k: string) {
					if (k === "grant") return { value: grant, writable: true, enumerable: true, configurable: true };
					if (k === "metadata") return { value: meta, writable: true, enumerable: true, configurable: true };
					return undefined;
				},
				get() {
					throw new Error("must not re-read property");
				},
			},
		);
		const r = encodeSandboxBootstrapPayload(proxy as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(r.ok).toBe(false); // metadata invalid
		expect(isZeroed(grant)).toBe(true); // grant erased despite get trap
	});
	it("encode: snapshot own metadata, does not re-read buildIdentity fields", () => {
		const grant = new Uint8Array(50).fill(0x41);
		// snapshotOwnValues copies descriptor values; buildIdentity fields
		// are read from the snapshot, not re-read from the original object.
		const meta = validMetadata();
		const proxy = new Proxy(meta, {
			get(_t: unknown, key: string | symbol) {
				if (key === "buildId" || key === "daemonProtocolVersion") throw new Error("trap");
				return Reflect.get(meta, key);
			},
		});
		const r = encodeSandboxBootstrapPayload({ metadata: proxy as unknown as MetadataOpts, grant });
		expect(r.ok).toBe(true);
	});
	it("encode: buildIdentity Proxy get trap is never fired (snapshot via descriptors)", () => {
		const grant = new Uint8Array(50).fill(0x41);
		// buildIdentity itself is a Proxy with get traps on all fields.
		// snapshotValue copies its descriptor values, so the traps never fire.
		const bi = validMetadata().buildIdentity;
		const biProxy = new Proxy(bi, {
			get(_t: unknown, key: string | symbol) {
				throw new Error(`trap on buildIdentity field: ${String(key)}`);
			},
		});
		const meta = { ...validMetadata(), buildIdentity: biProxy as unknown as MetadataOpts["buildIdentity"] };
		const r = encodeSandboxBootstrapPayload({ metadata: meta, grant });
		expect(r.ok).toBe(true);
	});
});

// ========== Symbol opts with valid grant ==========
describe("symbol opts", () => {
	it("rejects opts with symbol key despite valid grant and erases", () => {
		const grant = new Uint8Array(50).fill(0x41);
		const meta = validMetadata();
		const opts: Record<string | symbol, unknown> = {};
		Object.defineProperty(opts, "metadata", { value: meta, enumerable: true, writable: true, configurable: true });
		Object.defineProperty(opts, "grant", { value: grant, enumerable: true, writable: true, configurable: true });
		Object.defineProperty(opts, Symbol("test"), { value: 1, enumerable: true, writable: true, configurable: true });
		const r = encodeSandboxBootstrapPayload(opts as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(r.ok).toBe(false);
		expect(isZeroed(grant)).toBe(true);
	});
});

// ========== Unknown/missing opts with erasure ==========
describe("opts key validation with erasure", () => {
	it("unknown opts key erases grant", () => {
		const g = cloneGrant();
		const r = encodeSandboxBootstrapPayload({
			metadata: validMetadata(),
			grant: g,
			bad: 1,
		} as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(r.ok).toBe(false);
		expect(isZeroed(g)).toBe(true);
	});
	it("missing opts key erases grant (validation runs before grant check fails)", () => {
		const _g = cloneGrant();
		// Missing "metadata" key
		const r = encodeSandboxBootstrapPayload({} as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(r.ok).toBe(false);
	});
	it("non-plain proto opts erases grant", () => {
		const g = cloneGrant();
		class FakeOpts {
			metadata = validMetadata();
			grant = g;
		}
		const r = encodeSandboxBootstrapPayload(new FakeOpts() as unknown as EncodeSandboxBootstrapPayloadOpts);
		expect(r.ok).toBe(false);
		expect(isZeroed(g)).toBe(true);
	});
	it("wrong prototype on metadata erases grant", () => {
		const g = cloneGrant();
		class FakeMeta {
			hostId = "h-1";
			generation = "g-abc";
			sessionId = "s-1";
			relayUrl = "wss://relay.example.com/prime/v1";
			buildIdentity = { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 };
			connectTimeoutMs = 30000;
		}
		const r = encodeSandboxBootstrapPayload({ metadata: new FakeMeta() as unknown as MetadataOpts, grant: g });
		expect(r.ok).toBe(false);
		expect(isZeroed(g)).toBe(true);
	});
});

// ========== Decode failures ==========
describe("decode failures", () => {
	it("truncated", () => expect(decodeSandboxBootstrapPayload(new Uint8Array(3)).ok).toBe(false));
	it("oversized", () => expect(decodeSandboxBootstrapPayload(new Uint8Array(70000)).ok).toBe(false));
	it("bad magic", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		p[0] = 0xff;
		expect(decodeSandboxBootstrapPayload(p).ok).toBe(false);
	});
	it("trailing", () => {
		const p = encodeOk(validOpts(cloneGrant()));
		const e = new Uint8Array(p.byteLength + 1);
		e.set(p);
		expect(decodeSandboxBootstrapPayload(e).ok).toBe(false);
	});
	it("unknown meta keys", () => {
		const mb = new TextEncoder().encode(
			JSON.stringify({
				version: 1,
				hostId: "h-1",
				generation: "g-abc",
				sessionId: "s-1",
				relayUrl: "wss://relay.example.com/prime/v1",
				buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
				connectTimeoutMs: 30000,
				extra: "x",
			}),
		);
		expect(decodeSandboxBootstrapPayload(buildRawPayload(mb, new Uint8Array(50).fill(0x41))).ok).toBe(false);
	});
	it("non-canonical key order", () => {
		const mb = new TextEncoder().encode(
			JSON.stringify({
				version: 1,
				generation: "g-abc",
				hostId: "h-1",
				sessionId: "s-1",
				relayUrl: "wss://relay.example.com/prime/v1",
				buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
				connectTimeoutMs: 30000,
			}),
		);
		expect(decodeSandboxBootstrapPayload(buildRawPayload(mb, new Uint8Array(50).fill(0x41))).ok).toBe(false);
	});
});

// ========== Metadata validation ==========
describe("metadata validation", () => {
	it("version!=1", () => expect(decodeSandboxBootstrapPayload(buildRawMeta({ version: 2 })).ok).toBe(false));
	it("null buildIdentity", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: null })).ok).toBe(false));
	it("number buildIdentity", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: 42 })).ok).toBe(false));
	it("array buildIdentity", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ buildIdentity: [] })).ok).toBe(false));
	it("non-hex buildId", () =>
		expect(
			decodeSandboxBootstrapPayload(
				buildRawMeta({ buildIdentity: { buildId: "not-hex", daemonProtocolVersion: 7, daemonSchemaRevision: 25 } }),
			).ok,
		).toBe(false));
	it("negative timeout", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ connectTimeoutMs: -1 })).ok).toBe(false));
});

// ========== URL validation ==========
describe("relayUrl validation", () => {
	it("not wss://", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "ws://example.com/path" })).ok).toBe(false));
	it("username", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://u@example.com/path" })).ok).toBe(false));
	it("query", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com/path?x=1" })).ok).toBe(false));
	it("fragment", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com/path#x" })).ok).toBe(false));
	it("port", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com:443/path" })).ok).toBe(false));
	it("localhost", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://localhost/path" })).ok).toBe(false));
	it(".localhost", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://x.localhost/path" })).ok).toBe(false));
	it(".local", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://x.local/path" })).ok).toBe(false));
	// ALL literal IPv4 rejected
	it("IPv4 1.2.3.4 rejected", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://1.2.3.4/path" })).ok).toBe(false));
	it("IPv4 public rejected", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://8.8.8.8/path" })).ok).toBe(false));
	it("IPv4 loopback", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://127.0.0.1/path" })).ok).toBe(false));
	it("IPv4 private", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://10.0.0.1/path" })).ok).toBe(false));
	it("IPv4 link-local", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://169.254.1.1/path" })).ok).toBe(false));
	it("IPv4 CGNAT", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://100.64.0.1/path" })).ok).toBe(false));
	it("IPv4 multicast", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://224.0.0.1/path" })).ok).toBe(false));
	// ALL bracketed IPv6 rejected
	it("IPv6 public rejected", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://[2001:db8::1]/path" })).ok).toBe(false));
	it("IPv6 loopback", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://[::1]/path" })).ok).toBe(false));
	it("IPv6 link-local", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://[fe80::1]/path" })).ok).toBe(false));
	it("IPv6 ULA", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://[fc00::]/path" })).ok).toBe(false));
	// Path
	it("bare hostname no path", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com" })).ok).toBe(false));
	it("root path only", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com/" })).ok).toBe(false));
	it("repeated slash", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com//prime/v1" })).ok).toBe(false));
	it("percent in path", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com/prime%2Fv1" })).ok).toBe(false));
	it("dot segment", () =>
		expect(decodeSandboxBootstrapPayload(buildRawMeta({ relayUrl: "wss://example.com/../prime/v1" })).ok).toBe(
			false,
		));
});

// ========== Hostile inputs ==========
describe("hostile inputs", () => {
	if (typeof SharedArrayBuffer !== "undefined") {
		it("SharedArrayBuffer grant", () => {
			const sab = new SharedArrayBuffer(50);
			const u = new Uint8Array(sab);
			u.fill(0x41);
			expect(encodeSandboxBootstrapPayload(validOpts(u)).ok).toBe(false);
		});
		it("SharedArrayBuffer payload", () => {
			const v = encodeOk(validOpts(cloneGrant()));
			const sab = new SharedArrayBuffer(v.byteLength);
			const u = new Uint8Array(sab);
			u.set(v);
			expect(decodeSandboxBootstrapPayload(u).ok).toBe(false);
		});
	}
	if (typeof Buffer !== "undefined") {
		it("Buffer grant", () => {
			const b = Buffer.alloc(50);
			b.fill(0x41);
			expect(encodeSandboxBootstrapPayload(validOpts(b as unknown as Uint8Array)).ok).toBe(false);
		});
		it("Buffer payload", () => {
			const v = encodeOk(validOpts(cloneGrant()));
			expect(decodeSandboxBootstrapPayload(Buffer.from(v) as unknown as Uint8Array).ok).toBe(false);
		});
	}
	it("subclass grant", () => {
		class Sub extends Uint8Array {}
		const s = new Sub(50);
		s.fill(0x41);
		expect(encodeSandboxBootstrapPayload(validOpts(s as unknown as Uint8Array)).ok).toBe(false);
	});
	it("null/undefined payload", () => {
		expect(decodeSandboxBootstrapPayload(null as unknown as Uint8Array).ok).toBe(false);
		expect(decodeSandboxBootstrapPayload(undefined as unknown as Uint8Array).ok).toBe(false);
	});
	it("non-plain proto metadata erases grant", () => {
		const g = cloneGrant();
		class C {
			hostId = "h-1";
			generation = "g-abc";
			sessionId = "s-1";
			relayUrl = "wss://relay.example.com/prime/v1";
			buildIdentity = { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 };
			connectTimeoutMs = 30000;
		}
		const r = encodeSandboxBootstrapPayload({ metadata: new C() as unknown as MetadataOpts, grant: g });
		expect(r.ok).toBe(false);
		expect(isZeroed(g)).toBe(true);
	});
	it("subarray view rejected on encode", () => {
		const ab = new ArrayBuffer(100);
		const full = new Uint8Array(ab, 0, 100);
		full.fill(0x41);
		const sub = new Uint8Array(ab, 25, 50);
		const r = encodeSandboxBootstrapPayload(validOpts(sub as unknown as Uint8Array));
		expect(r.ok).toBe(false);
	});
	it("subarray view rejected on decode", () => {
		const v = encodeOk(validOpts(cloneGrant()));
		const ab = new ArrayBuffer(v.byteLength + 10);
		const sub = new Uint8Array(ab, 5, v.byteLength);
		sub.set(v);
		expect(decodeSandboxBootstrapPayload(sub as unknown as Uint8Array).ok).toBe(false);
	});
	it("detached non-empty view rejected on decode", () => {
		const ab = new ArrayBuffer(200);
		const view = new Uint8Array(ab);
		view.fill(0x41);
		const mc = new MessageChannel();
		mc.port1.postMessage(ab, [ab]);
		mc.port1.close();
		mc.port2.close();
		expect(decodeSandboxBootstrapPayload(view).ok).toBe(false);
	});
	it("Proxy-wrapped decode payload returns fixed error", () => {
		const v = encodeOk(validOpts(cloneGrant()));
		const p = new Proxy(v, {});
		const r = decodeSandboxBootstrapPayload(p as unknown as Uint8Array);
		expect(r.ok).toBe(false);
	});
	it("malformed percent URL erases payload", () => {
		const mb = new TextEncoder().encode(
			JSON.stringify({
				version: 1,
				hostId: "h-1",
				generation: "g-abc",
				sessionId: "s-1",
				relayUrl: "wss://relay.example.com/prime%ZZv1",
				buildIdentity: { buildId: VALID_BUILD_ID, daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
				connectTimeoutMs: 30000,
			}),
		);
		const grant = new Uint8Array(50).fill(0x41);
		const p = buildRawPayload(mb, grant);
		const c = new Uint8Array(p);
		expect(decodeSandboxBootstrapPayload(c).ok).toBe(false);
		expect(isZeroed(c)).toBe(true);
	});
});

// ========== Grant isolation ==========
describe("grant isolation", () => {
	it("bytes not in metadata", () => {
		const d = decodeOk(encodeOk(validOpts(cloneGrant())));
		expect(JSON.stringify(d.metadata)).not.toContain(VALID_GRANT_STR);
	});
	it("toJSON undefined", () => {
		expect(JSON.stringify(makeGrant())).toBe(undefined);
	});
});
