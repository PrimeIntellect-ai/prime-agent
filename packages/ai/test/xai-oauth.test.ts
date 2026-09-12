import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginXai, refreshXaiToken } from "../src/utils/oauth/xai.js";

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
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("uses the device grant, first-poll delay, pending and slow_down", async () => {
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

	it("cancels an in-flight request", async () => {
		const controller = new AbortController();
		vi.stubGlobal("fetch", vi.fn(pendingFetch));
		const result = login(vi.fn(), controller.signal);
		controller.abort();
		await expect(result).rejects.toThrow("Login cancelled");
	});

	it("bounds token polling by the remaining device lifetime", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json({ ...device, expires_in: 6 }))
			.mockImplementation(pendingFetch);
		vi.stubGlobal("fetch", fetchMock);
		const assertion = expect(login()).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(6000);
		await assertion;
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("refreshes with the device client and preserves an omitted refresh token", async () => {
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			expect(url).toBe(TOKEN_URL);
			expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: "old-refresh",
			});
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

	it("rejects an unsafe verification URL before exposing it to the UI", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...device, verification_uri: "file:///etc/passwd" })));
		const onAuth = vi.fn();
		await expect(login(onAuth)).rejects.toThrow("Untrusted verification URI");
		expect(onAuth).not.toHaveBeenCalled();
	});

	it("rejects malformed tokens and redacts provider failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(json({ ...token, access_token: "" }))
				.mockResolvedValueOnce(
					json({ error: "invalid_grant", error_description: "secret-refresh\u001b[31m" }, 400),
				),
		);
		await expect(refreshXaiToken("secret-refresh")).rejects.toThrow("Invalid xAI OAuth response field");
		await expect(refreshXaiToken("secret-refresh")).rejects.toEqual(
			new Error("xAI OAuth token refresh failed (HTTP 400): authorization expired or revoked; sign in again"),
		);
	});
});
