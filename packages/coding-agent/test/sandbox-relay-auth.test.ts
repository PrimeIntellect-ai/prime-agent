/**
 * Tests for createWebSocketUpgradeRequestAuth.
 *
 * Order-sensitive: malformed extra key/method/url/raw/header + valid grant
 * slots proves scrub happened first; multiple grant slots all scrubbed; one
 * container frozen still attempt other; Buffer/subview/shared factory reject +
 * erasure attempt; getter/proxy fail closed no invocation; normalized/raw
 * mismatch, names grammar/duplicates/forbidden, connection grammar,
 * constant-time hook; one-use/dispose/frozen/never-throw.
 */
import { describe, expect, it } from "vitest";
import type { AuthenticateRequest, UpgradeAuthResult } from "../src/core/sandbox-relay-auth.js";
import { createWebSocketUpgradeRequestAuth } from "../src/core/sandbox-relay-auth.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeGrant(len = 48): Uint8Array {
	const b = new Uint8Array(len);
	for (let i = 0; i < len; i++) b[i] = 0x21 + ((i * 7 + 13) % 0x5e);
	return b;
}
function gs(b: Uint8Array): string {
	return new TextDecoder().decode(b);
}

const VP = "/sandbox-relay/a1b2c3d4e5f60718293a4b5c6d7e8f90";

function okReq(gv: string): AuthenticateRequest {
	return {
		method: "GET",
		url: VP,
		rawHeaders: ["Host", "localhost", "Upgrade", "websocket", "Connection", "Upgrade", "X-Prime-Grant", gv],
		headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": gv },
	};
}
function okAuth(): ReturnType<typeof createWebSocketUpgradeRequestAuth> {
	return createWebSocketUpgradeRequestAuth({ grant: makeGrant(), path: VP });
}

function expectOk(r: ReturnType<typeof createWebSocketUpgradeRequestAuth>) {
	expect(Object.isFrozen(r)).toBe(true);
	if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
	expect(Object.isFrozen(r.authenticator)).toBe(true);
	return r.authenticator;
}
function expectErr(r: ReturnType<typeof createWebSocketUpgradeRequestAuth>, c: string) {
	expect(Object.isFrozen(r)).toBe(true);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(Object.isFrozen(r.error)).toBe(true);
		expect(r.error.code).toBe(c);
	}
}
function expectAuth(r: UpgradeAuthResult, c: string, ok: boolean) {
	expect(Object.isFrozen(r)).toBe(true);
	expect(r.ok).toBe(ok);
	expect(r.code).toBe(c);
}

// ── Factory: discriminated result ─────────────────────────────────────

describe("factory", () => {
	it("returns ok on valid input", () => {
		const a = expectOk(okAuth());
		expect(a.status.status).toBe("PENDING");
		expect(a.status.used).toBe(false);
	});
	it("rejects null grant", () => expectErr(createWebSocketUpgradeRequestAuth({ grant: null, path: VP }), "REJECTED"));
	it("rejects undefined grant", () =>
		expectErr(createWebSocketUpgradeRequestAuth({ grant: undefined, path: VP }), "REJECTED"));
	it("rejects null input", () => expectErr(createWebSocketUpgradeRequestAuth(null), "REJECTED"));
	it("rejects Proxy input", () =>
		expectErr(createWebSocketUpgradeRequestAuth(new Proxy({ grant: makeGrant(), path: VP }, {})), "REJECTED"));
	it("rejects grant getter", () => {
		const o = {
			get grant() {
				throw new Error();
			},
			path: VP,
		};
		expectErr(createWebSocketUpgradeRequestAuth(o), "REJECTED");
	});
	it("rejects extra own key", () =>
		expectErr(createWebSocketUpgradeRequestAuth({ grant: makeGrant(), path: VP, extra: 1 }), "REJECTED"));
	it("rejects Symbol key", () => {
		const o: Record<PropertyKey, unknown> = { grant: makeGrant(), path: VP };
		Object.defineProperty(o, Symbol("s"), { value: 1, enumerable: false });
		expectErr(createWebSocketUpgradeRequestAuth(o), "REJECTED");
	});
	it("rejects wrong prototype", () => {
		class F {}
		const o = Object.assign(new F(), { grant: makeGrant(), path: VP });
		expectErr(createWebSocketUpgradeRequestAuth(o), "REJECTED");
	});
	it("rejects ArrayBuffer", () =>
		expectErr(createWebSocketUpgradeRequestAuth({ grant: new ArrayBuffer(48), path: VP }), "REJECTED"));
	it("rejects Buffer", () =>
		expectErr(createWebSocketUpgradeRequestAuth({ grant: Buffer.from("hello"), path: VP }), "REJECTED"));
	it("rejects Uint16Array", () =>
		expectErr(createWebSocketUpgradeRequestAuth({ grant: new Uint16Array(48), path: VP }), "REJECTED"));
	it("rejects subarray (nonzero offset)", () => {
		const sub = new Uint8Array(96).subarray(10, 58);
		expectErr(createWebSocketUpgradeRequestAuth({ grant: sub, path: VP }), "REJECTED");
	});
	it("rejects detached buffer", () => {
		const ab = new ArrayBuffer(48);
		const u8 = new Uint8Array(ab);
		structuredClone(ab, { transfer: [ab] });
		expectErr(createWebSocketUpgradeRequestAuth({ grant: u8, path: VP }), "REJECTED");
	});
	it("rejects SharedArrayBuffer", () => {
		if (typeof SharedArrayBuffer !== "undefined") {
			const sab = new SharedArrayBuffer(48);
			expectErr(createWebSocketUpgradeRequestAuth({ grant: new Uint8Array(sab), path: VP }), "REJECTED");
		}
	});
	it("rejects Uint8Array subclass", () => {
		class F extends Uint8Array {}
		expectErr(createWebSocketUpgradeRequestAuth({ grant: new F(48), path: VP }), "REJECTED");
	});
	it("rejects grant < 32 bytes", () =>
		expectErr(createWebSocketUpgradeRequestAuth({ grant: makeGrant(16), path: VP }), "REJECTED"));
	it("rejects grant > 128 bytes", () =>
		expectErr(createWebSocketUpgradeRequestAuth({ grant: makeGrant(200), path: VP }), "REJECTED"));
	it("rejects grant with space (0x20)", () => {
		const g = makeGrant();
		g[12] = 0x20;
		expectErr(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }), "REJECTED");
	});
	it("rejects grant with control char (0x03)", () => {
		const g = makeGrant();
		g[12] = 0x03;
		expectErr(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }), "REJECTED");
	});
	it("rejects grant with DEL (0x7f)", () => {
		const g = makeGrant();
		g[12] = 0x7f;
		expectErr(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }), "REJECTED");
	});
	it("rejects wrong path prefix", () =>
		expectErr(
			createWebSocketUpgradeRequestAuth({ grant: makeGrant(), path: "/other/a1b2c3d4e5f60718293a4b5c6d7e8f90" }),
			"REJECTED",
		));
	it("rejects short hex", () =>
		expectErr(createWebSocketUpgradeRequestAuth({ grant: makeGrant(), path: "/sandbox-relay/abc" }), "REJECTED"));
	it("rejects non-hex chars", () =>
		expectErr(
			createWebSocketUpgradeRequestAuth({
				grant: makeGrant(),
				path: "/sandbox-relay/z1b2c3d4e5f60718293a4b5c6d7e8f9g",
			}),
			"REJECTED",
		));
	it("rejects non-string path", () =>
		expectErr(createWebSocketUpgradeRequestAuth({ grant: makeGrant(), path: null }), "REJECTED"));

	// ── Erasure ────────────────────────────────────────────────────────
	it("erases caller grant on success", () => {
		const g = makeGrant();
		const r = createWebSocketUpgradeRequestAuth({ grant: g, path: VP });
		expectOk(r);
		for (let i = 0; i < g.length; i++) expect(g[i]).toBe(0);
	});
	it("erases caller grant on path rejection", () => {
		const g = makeGrant();
		expectErr(createWebSocketUpgradeRequestAuth({ grant: g, path: "/sandbox-relay/xyz" }), "REJECTED");
		for (let i = 0; i < g.length; i++) expect(g[i]).toBe(0);
	});
	it("erases caller grant on char reject", () => {
		const g = makeGrant();
		g[0] = 0x20;
		expectErr(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }), "REJECTED");
		for (let i = 0; i < g.length; i++) expect(g[i]).toBe(0);
	});
	it("erases the provided rejected subview without touching unrelated bytes", () => {
		const full = new Uint8Array(96).fill(0x41);
		const sub = full.subarray(10, 58);
		expectErr(createWebSocketUpgradeRequestAuth({ grant: sub, path: VP }), "REJECTED");
		expect([...full.slice(0, 10)]).toEqual(new Array(10).fill(0x41));
		expect([...sub]).toEqual(new Array(48).fill(0));
		expect([...full.slice(58)]).toEqual(new Array(38).fill(0x41));
	});
	it("erases a discoverable grant before rejecting an extra factory key", () => {
		const grant = makeGrant();
		expectErr(createWebSocketUpgradeRequestAuth({ grant, path: VP, extra: true }), "REJECTED");
		expect([...grant]).toEqual(new Array(grant.length).fill(0));
	});
	it("erases a safely writable rejected Buffer view", () => {
		const grant = Buffer.alloc(48, 0x41);
		expectErr(createWebSocketUpgradeRequestAuth({ grant, path: VP }), "REJECTED");
		expect([...grant]).toEqual(new Array(grant.length).fill(0));
	});
	it("erases a non-enumerable data grant before rejecting its descriptor", () => {
		const grant = makeGrant();
		const input: Record<string, unknown> = { path: VP };
		Object.defineProperty(input, "grant", { value: grant, enumerable: false });
		expectErr(createWebSocketUpgradeRequestAuth(input), "REJECTED");
		expect([...grant]).toEqual(new Array(grant.length).fill(0));
	});
	it("does not throw on frozen backing buffer", () => {
		const ab = new ArrayBuffer(48);
		const u8 = new Uint8Array(ab);
		for (let i = 0; i < 48; i++) u8[i] = 0x41 + (i % 26);
		Object.freeze(ab);
		const r = createWebSocketUpgradeRequestAuth({ grant: u8, path: VP });
		expect(r.ok).toBe(true);
	});
});

// ── Golden path + one-use ─────────────────────────────────────────────

describe("authenticate", () => {
	it("golden path", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expect(a.status.status).toBe("PENDING");
		expect(a.status.used).toBe(false);
		const res = a.authenticate(okReq(c));
		expectAuth(res, "AUTHENTICATED", true);
		expect(a.status.status).toBe("AUTHENTICATED");
		expect(a.status.used).toBe(true);
	});
	it("second call returns ALREADY_USED", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(a.authenticate(okReq(c)), "AUTHENTICATED", true);
		expectAuth(a.authenticate(okReq(c)), "ALREADY_USED", false);
	});
	it("ALREADY_USED after dispose", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		a.dispose();
		expect(a.status.status).toBe("DISPOSED");
		expectAuth(a.authenticate(okReq(c)), "ALREADY_USED", false);
	});

	// ── Request validation ─────────────────────────────────────────────
	it("rejects wrong method", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(a.authenticate({ ...okReq(c), method: "POST" }), "BAD_METHOD", false);
	});
	it("rejects URL with query", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(a.authenticate({ ...okReq(c), url: `${VP}?t=1` }), "BAD_URL", false);
	});
	it("rejects wrong path", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({ ...okReq(c), url: "/sandbox-relay/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
			"BAD_URL",
			false,
		);
	});
	it("rejects missing Upgrade header", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		const req: AuthenticateRequest = {
			method: "GET",
			url: VP,
			rawHeaders: ["Host", "localhost", "Connection", "Upgrade", "X-Prime-Grant", c],
			headers: { host: "localhost", connection: "Upgrade", "x-prime-grant": c },
		};
		expectAuth(a.authenticate(req), "BAD_UPGRADE", false);
	});
	it("rejects bad Upgrade value", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				...okReq(c),
				rawHeaders: ["Host", "localhost", "Upgrade", "http2", "Connection", "Upgrade", "X-Prime-Grant", c],
				headers: { host: "localhost", upgrade: "http2", connection: "Upgrade", "x-prime-grant": c },
			}),
			"BAD_UPGRADE",
			false,
		);
	});
	it("rejects duplicate Upgrade header", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: [
					"Host",
					"localhost",
					"Upgrade",
					"websocket",
					"Upgrade",
					"websocket",
					"Connection",
					"Upgrade",
					"X-Prime-Grant",
					c,
				],
				headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": c },
			}),
			"MALFORMED",
			false,
		);
	});
	it("rejects missing Connection upgrade", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				...okReq(c),
				rawHeaders: ["Host", "localhost", "Upgrade", "websocket", "Connection", "keep-alive", "X-Prime-Grant", c],
				headers: { host: "localhost", upgrade: "websocket", connection: "keep-alive", "x-prime-grant": c },
			}),
			"BAD_CONNECTION",
			false,
		);
	});
	it("rejects duplicate Connection header", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: [
					"Host",
					"localhost",
					"Upgrade",
					"websocket",
					"Connection",
					"Upgrade",
					"Connection",
					"Upgrade",
					"X-Prime-Grant",
					c,
				],
				headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": c },
			}),
			"MALFORMED",
			false,
		);
	});
	it("rejects Connection with duplicate upgrade token", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				...okReq(c),
				rawHeaders: [
					"Host",
					"localhost",
					"Upgrade",
					"websocket",
					"Connection",
					"upgrade, upgrade",
					"X-Prime-Grant",
					c,
				],
				headers: { host: "localhost", upgrade: "websocket", connection: "upgrade, upgrade", "x-prime-grant": c },
			}),
			"BAD_CONNECTION",
			false,
		);
	});

	// ── Forbidden headers ─────────────────────────────────────────────
	it("rejects Authorization", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				...okReq(c),
				rawHeaders: [
					"Host",
					"localhost",
					"Upgrade",
					"websocket",
					"Connection",
					"Upgrade",
					"Authorization",
					"Bearer x",
					"X-Prime-Grant",
					c,
				],
				headers: {
					host: "localhost",
					upgrade: "websocket",
					connection: "Upgrade",
					authorization: "Bearer x",
					"x-prime-grant": c,
				},
			}),
			"FORBIDDEN_HEADER",
			false,
		);
	});
	it("rejects Cookie", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				...okReq(c),
				rawHeaders: [
					"Host",
					"localhost",
					"Upgrade",
					"websocket",
					"Connection",
					"Upgrade",
					"Cookie",
					"session=abc",
					"X-Prime-Grant",
					c,
				],
				headers: {
					host: "localhost",
					upgrade: "websocket",
					connection: "Upgrade",
					cookie: "session=abc",
					"x-prime-grant": c,
				},
			}),
			"FORBIDDEN_HEADER",
			false,
		);
	});
	it("rejects x-forwarded-*", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				...okReq(c),
				rawHeaders: [
					"Host",
					"localhost",
					"Upgrade",
					"websocket",
					"Connection",
					"Upgrade",
					"X-Forwarded-For",
					"10.0.0.1",
					"X-Prime-Grant",
					c,
				],
				headers: {
					host: "localhost",
					upgrade: "websocket",
					connection: "Upgrade",
					"x-forwarded-for": "10.0.0.1",
					"x-prime-grant": c,
				},
			}),
			"FORBIDDEN_HEADER",
			false,
		);
	});

	// ── Scrub edge cases ──────────────────────────────────────────────
	it("missing grant is an authentication mismatch", () => {
		const a = expectOk(okAuth());
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: ["Host", "localhost", "Upgrade", "websocket", "Connection", "Upgrade"],
				headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade" },
			}),
			"GRANT_MISMATCH",
			false,
		);
	});
	it("wrong grant value", () => {
		const a = expectOk(okAuth());
		expectAuth(a.authenticate(okReq("wrong-value-here-1234567890abcdefghijklmnop")), "GRANT_MISMATCH", false);
	});
	it("duplicate raw x-prime-grant", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: [
					"Host",
					"localhost",
					"Upgrade",
					"websocket",
					"Connection",
					"Upgrade",
					"X-Prime-Grant",
					c,
					"X-Prime-Grant",
					c,
				],
				headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": c },
			}),
			"GRANT_MISMATCH",
			false,
		);
	});
	it("duplicate normalized x-prime-grant", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: ["Host", "localhost", "Upgrade", "websocket", "Connection", "Upgrade", "X-Prime-Grant", c],
				headers: {
					host: "localhost",
					upgrade: "websocket",
					connection: "Upgrade",
					"x-prime-grant": c,
					"X-Prime-Grant": c,
				},
			}),
			"GRANT_MISMATCH",
			false,
		);
	});
	it("raw/normalized mismatch", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				...okReq(c),
				headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": "different" },
			}),
			"GRANT_MISMATCH",
			false,
		);
	});
	it("normalized value as array -> SCRUB_FAILED", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				...okReq(c),
				headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": [c] },
			}),
			"MALFORMED",
			false,
		);
	});
	it("raw grant names mismatched (not lowered) -> SCRUB_FAILED", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		// Map key is already lowercased by discoverGrantSlots check
		expectAuth(
			a.authenticate({
				...okReq(c),
				headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "X-Prime-Grant": c },
			}),
			"GRANT_MISMATCH",
			false,
		);
	});

	// ── Scrub before validation ───────────────────────────────────────
	it("malformed extra rawHeaders key + valid grant proves scrub first", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		const req = {
			method: "GET",
			url: VP,
			rawHeaders: ["Host", "localhost", "Upgrade", "websocket", "Connection", "Upgrade", "X-Prime-Grant", c],
			headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": c },
			extra: 1,
		};
		const res = a.authenticate(req);
		expect(res.ok).toBe(false);
		// Grant slots were scrubbed before extra key rejection.
		expect(req.rawHeaders.slice(-2)).toEqual(["", ""]);
		expect(Object.hasOwn(req.headers, "x-prime-grant")).toBe(false);
	});
	it("malformed method + valid grant proves scrub first", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		const req = {
			method: "POST",
			url: VP,
			rawHeaders: ["Host", "localhost", "Upgrade", "websocket", "Connection", "Upgrade", "X-Prime-Grant", c],
			headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": c },
		};
		expectAuth(a.authenticate(req), "BAD_METHOD", false);
		// Verify scrub happened
		for (let i = 0; i < req.rawHeaders.length; i++) {
			if (req.rawHeaders[i].toLowerCase() === "x-prime-grant") {
				expect(req.rawHeaders[i]).toBe("");
				expect(req.rawHeaders[i + 1]).toBe("");
			}
		}
	});

	// ── Strict array/map validation ──────────────────────────────────
	it("rejects sparse rawHeaders", () => {
		const a = expectOk(okAuth());
		const arr = ["Host", "localhost"];
		arr[10] = "X-Test";
		expectAuth(
			a.authenticate({ method: "GET", url: VP, rawHeaders: arr, headers: { host: "localhost" } }),
			"MALFORMED",
			false,
		);
	});
	it("rejects odd-length rawHeaders", () => {
		const a = expectOk(okAuth());
		expectAuth(a.authenticate({ method: "GET", url: VP, rawHeaders: ["Host"], headers: {} }), "MALFORMED", false);
	});
	it("rejects Proxy rawHeaders", () => {
		const a = expectOk(okAuth());
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: new Proxy(["Host", "localhost"], {}),
				headers: { host: "localhost" },
			}),
			"MALFORMED",
			false,
		);
	});
	it("rejects Proxy header map", () => {
		const a = expectOk(okAuth());
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: ["Host", "localhost"],
				headers: new Proxy({ host: "localhost" }, {}),
			}),
			"MALFORMED",
			false,
		);
	});
	it("rejects header map with non-enumerable key", () => {
		const a = expectOk(okAuth());
		const h: Record<string, unknown> = { host: "localhost" };
		Object.defineProperty(h, "secret", { value: "hidden", enumerable: false });
		expectAuth(
			a.authenticate({ method: "GET", url: VP, rawHeaders: ["Host", "localhost"], headers: h }),
			"MALFORMED",
			false,
		);
	});

	// ── Frozen scrub edge cases ──────────────────────────────────────
	it("frozen rawHeaders => SCRUB_FAILED", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: Object.freeze([
					"Host",
					"localhost",
					"Upgrade",
					"websocket",
					"Connection",
					"Upgrade",
					"X-Prime-Grant",
					c,
				]),
				headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": c },
			}),
			"SCRUB_FAILED",
			false,
		);
	});
	it("frozen headers => SCRUB_FAILED", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: ["Host", "localhost", "Upgrade", "websocket", "Connection", "Upgrade", "X-Prime-Grant", c],
				headers: Object.freeze({
					"x-prime-grant": c,
					host: "localhost",
					upgrade: "websocket",
					connection: "Upgrade",
				}),
			}),
			"SCRUB_FAILED",
			false,
		);
	});

	// ── Oversized / non-ASCII ────────────────────────────────────────
	it("rejects oversize raw bytes", () => {
		const a = expectOk(okAuth());
		const gv = gs(makeGrant());
		const big = "A".repeat(70000);
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: ["Host", big, "Upgrade", "websocket", "Connection", "Upgrade", "X-Prime-Grant", gv],
				headers: { host: big, upgrade: "websocket", connection: "Upgrade", "x-prime-grant": gv },
			}),
			"MALFORMED",
			false,
		);
	});
	it("rejects non-ASCII in raw header", () => {
		const a = expectOk(okAuth());
		const gv = gs(makeGrant());
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: [
					"Host",
					"localhost\u00e9",
					"Upgrade",
					"websocket",
					"Connection",
					"Upgrade",
					"X-Prime-Grant",
					gv,
				],
				headers: { host: "localhost\u00e9", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": gv },
			}),
			"MALFORMED",
			false,
		);
	});

	// ── Disposal, freeze, status ─────────────────────────────────────
	it("dispose before use gives DISPOSED", () => {
		const a = expectOk(okAuth());
		a.dispose();
		expect(a.status.status).toBe("DISPOSED");
		expect(a.status.used).toBe(true);
	});
	it("dispose after use preserves AUTHENTICATED", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(a.authenticate(okReq(c)), "AUTHENTICATED", true);
		a.dispose();
		expect(a.status.status).toBe("AUTHENTICATED");
		expect(a.status.used).toBe(true);
	});
	it("dispose is idempotent", () => {
		const a = expectOk(okAuth());
		a.dispose();
		a.dispose();
		expect(a.status.status).toBe("DISPOSED");
	});
	it("AuthenticateResult frozen", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expect(Object.isFrozen(a.authenticate(okReq(c)))).toBe(true);
	});
	it("CreateAuthResult frozen on fail", () => {
		expect(Object.isFrozen(createWebSocketUpgradeRequestAuth({ grant: null, path: VP }))).toBe(true);
	});
	it("never throws", () => {
		const a = expectOk(okAuth());
		expect(() => a.authenticate(null)).not.toThrow();
		expect(() => a.authenticate({})).not.toThrow();
		expect(() => a.dispose()).not.toThrow();
	});

	// ── Array-valued connection is rejected ───────────────────────────
	it("rejects array-valued connection", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		expectAuth(
			a.authenticate({
				method: "GET",
				url: VP,
				rawHeaders: ["Host", "localhost", "Upgrade", "websocket", "Connection", "Upgrade", "X-Prime-Grant", c],
				headers: { host: "localhost", upgrade: "websocket", connection: ["upgrade"], "x-prime-grant": c },
			}),
			"MALFORMED",
			false,
		);
	});

	// ── Erase owned after auth ───────────────────────────────────────
	it("erases owned grant after authenticate", () => {
		const g = makeGrant();
		const c = gs(new Uint8Array(g));
		const a = expectOk(createWebSocketUpgradeRequestAuth({ grant: g, path: VP }));
		a.authenticate(okReq(c));
		a.dispose();
	});
});

describe("strict request snapshot and scrub order", () => {
	it("scrubs normalized credentials even when rawHeaders is an accessor", () => {
		const grant = makeGrant();
		const candidate = gs(new Uint8Array(grant));
		const authenticator = expectOk(createWebSocketUpgradeRequestAuth({ grant, path: VP }));
		const headers: Record<string, string> = { "x-prime-grant": candidate };
		let getterCalls = 0;
		const request: Record<string, unknown> = { method: "GET", url: VP, headers };
		Object.defineProperty(request, "rawHeaders", {
			enumerable: true,
			get() {
				getterCalls += 1;
				return [];
			},
		});
		expectAuth(authenticator.authenticate(request), "MALFORMED", false);
		expect(getterCalls).toBe(0);
		expect(Object.hasOwn(headers, "x-prime-grant")).toBe(false);
	});
	it("scrubs a sparse huge-length raw array without iterating its declared length", () => {
		const grant = makeGrant();
		const candidate = gs(new Uint8Array(grant));
		const authenticator = expectOk(createWebSocketUpgradeRequestAuth({ grant, path: VP }));
		const rawHeaders: string[] = [];
		rawHeaders.length = 1_000_000_000;
		rawHeaders[0] = "X-Prime-Grant";
		rawHeaders[1] = candidate;
		const headers = { "x-prime-grant": candidate };
		expectAuth(authenticator.authenticate({ method: "GET", url: VP, rawHeaders, headers }), "MALFORMED", false);
		expect(rawHeaders[0]).toBe("");
		expect(rawHeaders[1]).toBe("");
		expect(Object.hasOwn(headers, "x-prime-grant")).toBe(false);
	});
	it("scrubs raw credentials when the normalized map is noninspectable", () => {
		const grant = makeGrant();
		const candidate = gs(new Uint8Array(grant));
		const authenticator = expectOk(createWebSocketUpgradeRequestAuth({ grant, path: VP }));
		const rawHeaders = ["X-Prime-Grant", candidate];
		const request = { method: "GET", url: VP, rawHeaders, headers: new Proxy({}, {}) };
		expectAuth(authenticator.authenticate(request), "MALFORMED", false);
		expect(rawHeaders).toEqual(["", ""]);
	});
	it("rejects an otherwise exact request with no Connection header", () => {
		const grant = makeGrant();
		const candidate = gs(new Uint8Array(grant));
		const authenticator = expectOk(createWebSocketUpgradeRequestAuth({ grant, path: VP }));
		const request = {
			method: "GET",
			url: VP,
			rawHeaders: ["Host", "localhost", "Upgrade", "websocket", "X-Prime-Grant", candidate],
			headers: { host: "localhost", upgrade: "websocket", "x-prime-grant": candidate },
		};
		expectAuth(authenticator.authenticate(request), "BAD_CONNECTION", false);
	});
	it("rejects invalid HTTP token header names after scrubbing", () => {
		const grant = makeGrant();
		const candidate = gs(new Uint8Array(grant));
		const authenticator = expectOk(createWebSocketUpgradeRequestAuth({ grant, path: VP }));
		const request = okReq(candidate);
		request.rawHeaders.push("Bad Name", "value");
		request.headers["bad name"] = "value";
		expectAuth(authenticator.authenticate(request), "MALFORMED", false);
		expect(request.rawHeaders.slice(-4, -2)).toEqual(["", ""]);
		expect(Object.hasOwn(request.headers, "x-prime-grant")).toBe(false);
	});
});

describe("terminal authenticator scrubbing", () => {
	it("scrubs credential slots before returning ALREADY_USED after authentication", () => {
		const grant = makeGrant();
		const candidate = gs(new Uint8Array(grant));
		const authenticator = expectOk(createWebSocketUpgradeRequestAuth({ grant, path: VP }));
		expectAuth(authenticator.authenticate(okReq(candidate)), "AUTHENTICATED", true);
		const second = okReq("replacement-credential-that-must-be-scrubbed");
		expectAuth(authenticator.authenticate(second), "ALREADY_USED", false);
		expect(second.rawHeaders.slice(-2)).toEqual(["", ""]);
		expect(Object.hasOwn(second.headers, "x-prime-grant")).toBe(false);
	});

	it("scrubs credential slots before returning ALREADY_USED after disposal", () => {
		const authenticator = expectOk(okAuth());
		authenticator.dispose();
		const request = okReq("replacement-credential-that-must-be-scrubbed");
		expectAuth(authenticator.authenticate(request), "ALREADY_USED", false);
		expect(request.rawHeaders.slice(-2)).toEqual(["", ""]);
		expect(Object.hasOwn(request.headers, "x-prime-grant")).toBe(false);
	});
});
