import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider } from "../src/utils/oauth/index.js";
import { loginXai, refreshXaiToken, xaiOAuthProvider } from "../src/utils/oauth/xai.js";

const DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const device = {
	device_code: "secret-device",
	user_code: "ABCD-1234",
	verification_uri: "https://accounts.x.ai/oauth2/device",
	expires_in: 900,
	interval: 5,
};
const token = { access_token: "secret-access", refresh_token: "secret-refresh", expires_in: 21600 };
function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function login(onAuth: Parameters<typeof loginXai>[0]["onAuth"] = vi.fn(), signal?: AbortSignal) {
	return loginXai({ onAuth, onPrompt: vi.fn(), signal });
}
function pendingFetch(_input: unknown, init?: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new Error("abort")), { once: true });
	});
}

describe("xAI device OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("registers the subscription provider", () => {
		expect(getOAuthProvider("xai")).toBe(xaiOAuthProvider);
		expect(xaiOAuthProvider.getApiKey({ access: "access", refresh: "refresh", expires: 0 })).toBe("access");
	});

	it("uses the device grant, first-poll delay, pending and slow_down", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const times: number[] = [];
		const replies = [
			json({ error: "authorization_pending" }, 400),
			json({ error: "slow_down", interval: 10 }, 400),
			json(token),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				expect(init.redirect).toBe("error");
				const form = new URLSearchParams(String(init.body));
				expect(form.get("client_id")).toBe(CLIENT_ID);
				if (url === DEVICE_URL) {
					expect(form.get("scope")).toBe("openid profile email offline_access grok-cli:access api:access");
					expect(form.get("referrer")).toBe("pi");
					return json(device);
				}
				expect(url).toBe(TOKEN_URL);
				expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(form.get("device_code")).toBe("secret-device");
				times.push(Date.now());
				return replies.shift()!;
			}),
		);
		const onAuth = vi.fn();
		const result = login(onAuth);
		await vi.advanceTimersByTimeAsync(0);
		expect(onAuth).toHaveBeenCalledWith({ url: device.verification_uri, instructions: "Enter code: ABCD-1234" });
		expect(times).toEqual([]);
		await vi.advanceTimersByTimeAsync(20000);
		expect(times).toEqual([5000, 10000, 20000]);
		expect(await result).toEqual({
			access: token.access_token,
			refresh: token.refresh_token,
			expires: 20000 + 21600000 - 300000,
		});
	});

	it.each([undefined, 0, -1, "bad"])("defaults invalid interval %s to five seconds", async (interval) => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json({ ...device, interval }))
			.mockResolvedValueOnce(json(token));
		vi.stubGlobal("fetch", fetchMock);
		const result = login();
		await vi.advanceTimersByTimeAsync(4999);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await result;
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each([
		"http://accounts.x.ai/device",
		"file:///etc/passwd",
		"https://accounts.x.ai/\ncontrol",
		"https://user@accounts.x.ai/device",
		"bad",
	])("rejects unsafe verification URI %s", async (verification_uri) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...device, verification_uri })));
		const onAuth = vi.fn();
		await expect(login(onAuth)).rejects.toThrow("Untrusted verification URI");
		expect(onAuth).not.toHaveBeenCalled();
	});

	it("accepts an HTTPS verification URL issued on another host", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(json({ ...device, verification_uri: "https://grok.com/device" })),
		);
		const onAuth = vi.fn(() => controller.abort());
		await expect(login(onAuth, controller.signal)).rejects.toThrow("Login cancelled");
		expect(onAuth).toHaveBeenCalledWith({ url: "https://grok.com/device", instructions: "Enter code: ABCD-1234" });
	});

	it("rejects terminal control characters in user codes", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...device, user_code: "ABC\u001b[31m" })));
		await expect(login()).rejects.toThrow("user_code");
	});

	it.each(["access_denied", "authorization_denied", "expired_token"])(
		"fails device authorization on %s",
		async (error) => {
			vi.useFakeTimers();
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValueOnce(json(device)).mockResolvedValueOnce(json({ error }, 400)),
			);
			const assertion = expect(login()).rejects.toThrow(error === "expired_token" ? "expired" : "denied");
			await vi.advanceTimersByTimeAsync(5000);
			await assertion;
		},
	);

	it("expires without polling beyond the deadline", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn().mockResolvedValue(json({ ...device, expires_in: 2 }));
		vi.stubGlobal("fetch", fetchMock);
		const assertion = expect(login()).rejects.toThrow("expired");
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("cancels before login and during the first wait", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn().mockResolvedValue(json(device));
		vi.stubGlobal("fetch", fetchMock);
		await expect(login(() => controller.abort(), controller.signal)).rejects.toThrow("Login cancelled");
		await expect(login(vi.fn(), controller.signal)).rejects.toThrow("Login cancelled");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("cancels an in-flight request", async () => {
		const controller = new AbortController();
		vi.stubGlobal("fetch", vi.fn(pendingFetch));
		const result = login(vi.fn(), controller.signal);
		controller.abort();
		await expect(result).rejects.toThrow("Login cancelled");
	});

	it("bounds a hung device request", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", vi.fn(pendingFetch));
		const assertion = expect(login()).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(30000);
		await assertion;
	});

	it("bounds token polling by remaining device lifetime", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(json({ ...device, expires_in: 6 }))
				.mockImplementation(pendingFetch),
		);
		const assertion = expect(login()).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(6000);
		await assertion;
	});

	it("refreshes and preserves an omitted refresh token", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			expect(url).toBe(TOKEN_URL);
			const form = new URLSearchParams(String(init.body));
			expect(form.get("grant_type")).toBe("refresh_token");
			expect(form.get("client_id")).toBe(CLIENT_ID);
			expect(form.get("refresh_token")).toBe("old-refresh");
			return json({ access_token: "new-access" });
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await refreshXaiToken("old-refresh")).toEqual({
			access: "new-access",
			refresh: "old-refresh",
			expires: 3300000,
		});
		fetchMock.mockResolvedValue(json(token));
		expect((await refreshXaiToken("old-refresh")).refresh).toBe("secret-refresh");
	});

	it("does not immediately expire short-lived tokens", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...token, expires_in: 60 })));
		expect((await refreshXaiToken("old-refresh")).expires).toBe(30000);
	});

	it.each([
		{ access_token: "" },
		{ refresh_token: "" },
		{ expires_in: -1 },
		{ expires_in: "3600" },
		{ expires_in: null },
	])("rejects malformed tokens %j", async (override) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...token, ...override })));
		await expect(refreshXaiToken("old-refresh")).rejects.toThrow("Invalid xAI OAuth response field");
	});

	it("requires an initial refresh token", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(json(device))
				.mockResolvedValueOnce(json({ access_token: "access" })),
		);
		const assertion = expect(login()).rejects.toThrow("refresh_token");
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;
	});

	it("reports revoked tokens without echoing provider text or credentials", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(json({ error: "invalid_grant", error_description: "secret-refresh\u001b[31m" }, 400)),
		);
		await expect(refreshXaiToken("secret-refresh")).rejects.toThrow(
			"xAI OAuth token refresh failed (HTTP 400): authorization expired or revoked; sign in again",
		);
	});

	it("reports invalid JSON without echoing response bodies", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret-access", { status: 502 })));
		await expect(refreshXaiToken("refresh")).rejects.toThrow("xAI OAuth returned invalid JSON (HTTP 502)");
	});
});
