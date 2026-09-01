import { afterEach, describe, expect, it, vi } from "vitest";
import { computeStoredExpiry, loginXai, refreshXaiToken } from "../src/utils/oauth/xai.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

describe("computeStoredExpiry", () => {
	it("refreshes long-lived tokens a full hour early", () => {
		const now = 1_000_000_000;
		// 6h token: expiry skewed by the full 1h REFRESH_SKEW_MS.
		expect(computeStoredExpiry(now, 6 * 60 * 60)).toBe(now + 5 * 60 * 60 * 1000);
	});

	it("scales the skew down for short-lived tokens", () => {
		const now = 1_000_000_000;
		// 15-minute JWT: skew is a quarter of the lifetime (~3.75 min).
		const life = 15 * 60 * 1000;
		expect(computeStoredExpiry(now, 15 * 60)).toBe(now + life - Math.floor(life / 4));
	});
});

describe("xAI OAuth device flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("completes the device flow and returns skewed credentials", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));
		const now = Date.now();

		const tokenResponses = [
			jsonResponse({ error: "authorization_pending" }),
			jsonResponse({ error: "authorization_pending" }),
			jsonResponse({
				access_token: "xai-access",
				refresh_token: "xai-refresh",
				id_token: "xai-id",
				expires_in: 6 * 60 * 60,
				token_type: "Bearer",
			}),
		];
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/oauth2/device/code")) {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				});
				expect(String(init?.body)).toContain("client_id=");
				expect(String(init?.body)).toContain("grok-cli%3Aaccess");
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.x.ai/device",
					verification_uri_complete: "https://auth.x.ai/device?code=ABCD-EFGH",
					interval: 1,
					expires_in: 900,
				});
			}

			if (url.endsWith("/oauth2/token")) {
				expect(String(init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
				const response = tokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra token poll");
				}
				return response;
			}

			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const onAuth = vi.fn();
		const credentialsPromise = loginXai({ onAuth });
		// Let the polling sleeps advance.
		await vi.advanceTimersByTimeAsync(10_000);

		const credentials = await credentialsPromise;
		expect(onAuth).toHaveBeenCalledWith("https://auth.x.ai/device?code=ABCD-EFGH", "Enter code: ABCD-EFGH");
		expect(credentials.access).toBe("xai-access");
		expect(credentials.refresh).toBe("xai-refresh");
		// 6h token -> stored expiry is 5h out (1h refresh skew) from the
		// token response time (three 1s polls: issued at now + 3s).
		expect(credentials.expires).toBe(now + 3000 + 5 * 60 * 60 * 1000);
	});

	it("honors slow_down responses by widening the poll interval", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const pollTimes: number[] = [];
		let lastPoll = Date.now();
		const tokenResponses = [
			jsonResponse({ error: "slow_down", interval: 3 }),
			jsonResponse({ access_token: "xai-access", refresh_token: "xai-refresh", expires_in: 3600 }),
		];
		const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/oauth2/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.x.ai/device",
					interval: 1,
					expires_in: 900,
				});
			}
			if (url.endsWith("/oauth2/token")) {
				const now = Date.now();
				pollTimes.push(now - lastPoll);
				lastPoll = now;
				const response = tokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra token poll");
				}
				return response;
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const promise = loginXai({ onAuth: vi.fn() });
		await vi.advanceTimersByTimeAsync(15_000);
		const credentials = await promise;

		expect(credentials.access).toBe("xai-access");
		// First poll after ~1s; slow_down bumps the interval to 3s.
		expect(pollTimes[0]).toBeGreaterThanOrEqual(1000);
		expect(pollTimes[1]).toBeGreaterThanOrEqual(3000);
	});

	it("surfaces a missing refresh token as an error", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/oauth2/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.x.ai/device",
					interval: 1,
					expires_in: 900,
				});
			}
			return jsonResponse({ access_token: "xai-access", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const captured = loginXai({ onAuth: vi.fn() }).then(
			() => new Error("expected rejection"),
			(error: Error) => error,
		);
		await vi.advanceTimersByTimeAsync(10_000);
		const error = await captured;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("did not include a refresh token");
	});
});

describe("xAI token refresh", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the rotated refresh token from the response", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));
		const now = Date.now();

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://auth.x.ai/oauth2/token");
			expect(init?.method).toBe("POST");
			const body = String(init?.body);
			expect(body).toContain("grant_type=refresh_token");
			expect(body).toContain("refresh_token=old-refresh");
			expect(body).toContain("client_id=");
			return jsonResponse({
				access_token: "new-access",
				refresh_token: "rotated-refresh",
				expires_in: 6 * 60 * 60,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshXaiToken("old-refresh");
		expect(credentials.access).toBe("new-access");
		expect(credentials.refresh).toBe("rotated-refresh");
		expect(credentials.expires).toBe(now + 5 * 60 * 60 * 1000);
	});

	it("keeps the previous refresh token when the response omits one", async () => {
		const fetchMock = vi.fn(
			async (): Promise<Response> => jsonResponse({ access_token: "new-access", expires_in: 6 * 60 * 60 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshXaiToken("kept-refresh");
		expect(credentials.refresh).toBe("kept-refresh");
	});

	it("explains the tier gate on 403 without suggesting re-login", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse({ error: "access_denied" }, 403));
		vi.stubGlobal("fetch", fetchMock);

		const error = await refreshXaiToken("some-refresh").catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("403");
		expect(error.message).toContain("XAI_API_KEY");
		expect(error.message).toContain("not entitled");
	});

	it("suggests re-login on 400/401", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse({ error: "invalid_grant" }, 400));
		vi.stubGlobal("fetch", fetchMock);

		await expect(refreshXaiToken("bad-refresh")).rejects.toThrow("/login");
	});

	it("rejects empty refresh tokens before any network call", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(refreshXaiToken("  ")).rejects.toThrow("missing a refresh token");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("xAI device flow error handling", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	function deviceResponse() {
		return jsonResponse({
			device_code: "device-code",
			user_code: "ABCD-EFGH",
			verification_uri: "https://auth.x.ai/device",
			interval: 1,
			expires_in: 900,
		});
	}

	it("throws immediately for a terminal OAuth error delivered as 200+JSON", async () => {
		vi.useFakeTimers();
		const polls: number[] = [];
		const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/oauth2/device/code")) return deviceResponse();
			if (url.endsWith("/oauth2/token")) {
				polls.push(Date.now());
				return jsonResponse({ error: "access_denied", error_description: "user denied" });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const captured = loginXai({ onAuth: vi.fn() }).then(
			() => new Error("expected rejection"),
			(error: Error) => error,
		);
		await vi.advanceTimersByTimeAsync(10_000);
		const error = await captured;
		expect((error as Error).message).toContain("access_denied");
		expect((error as Error).message).toContain("user denied");
		expect(polls).toHaveLength(1);
	});

	it("throws immediately for a terminal OAuth error delivered as HTTP 400+JSON", async () => {
		vi.useFakeTimers();
		const polls: number[] = [];
		const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/oauth2/device/code")) return deviceResponse();
			if (url.endsWith("/oauth2/token")) {
				polls.push(Date.now());
				return jsonResponse({ error: "expired_token" }, 400);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const captured = loginXai({ onAuth: vi.fn() }).then(
			() => new Error("expected rejection"),
			(error: Error) => error,
		);
		await vi.advanceTimersByTimeAsync(10_000);
		const error = await captured;
		expect((error as Error).message).toContain("expired_token");
		expect(polls).toHaveLength(1);
	});

	it("treats non-JSON HTTP 500 responses as transient and keeps polling", async () => {
		vi.useFakeTimers();
		const polls: number[] = [];
		const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/oauth2/device/code")) return deviceResponse();
			if (url.endsWith("/oauth2/token")) {
				polls.push(Date.now());
				if (polls.length === 1) {
					return new Response("<html>proxy error</html>", { status: 500 });
				}
				return jsonResponse({ access_token: "xai-access", refresh_token: "xai-refresh", expires_in: 3600 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const promise = loginXai({ onAuth: vi.fn() });
		await vi.advanceTimersByTimeAsync(10_000);
		const credentials = await promise;
		expect(credentials.access).toBe("xai-access");
		expect(polls.length).toBe(2);
	});

	it("reports a timeout when polling never succeeds before the deadline", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/oauth2/device/code")) return deviceResponse();
			return jsonResponse({ error: "authorization_pending" });
		});
		vi.stubGlobal("fetch", fetchMock);

		const captured = loginXai({ onAuth: vi.fn() }).then(
			() => new Error("expected rejection"),
			(error: Error) => error,
		);
		await vi.advanceTimersByTimeAsync(900_000);
		const error = await captured;
		expect((error as Error).message).toContain("timed out");
	});

	it("surfaces cancellation as 'Login cancelled' when aborted mid-fetch", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/oauth2/device/code")) return deviceResponse();
			if (url.endsWith("/oauth2/token")) {
				// Abort while the fetch is in flight.
				controller.abort();
				throw new DOMException("This operation was aborted", "AbortError");
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const captured = loginXai({ onAuth: vi.fn(), signal: controller.signal }).then(
			() => new Error("expected rejection"),
			(error: Error) => error,
		);
		await vi.advanceTimersByTimeAsync(10_000);
		const error = await captured;
		expect((error as Error).message).toBe("Login cancelled");
	});

	it("widens the interval after slow_down even when the server echo is smaller", async () => {
		vi.useFakeTimers();
		const pollTimes: number[] = [];
		let lastPoll = Date.now();
		const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/oauth2/device/code")) return deviceResponse();
			if (url.endsWith("/oauth2/token")) {
				const now = Date.now();
				pollTimes.push(now - lastPoll);
				lastPoll = now;
				if (pollTimes.length === 1) {
					// Malformed hint: interval smaller than the original.
					return jsonResponse({ error: "slow_down", interval: 1 });
				}
				return jsonResponse({ access_token: "xai-access", refresh_token: "xai-refresh", expires_in: 3600 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const promise = loginXai({ onAuth: vi.fn() });
		await vi.advanceTimersByTimeAsync(30_000);
		await promise;
		// interval starts at 1s; slow_down must add at least 5s -> >=6s gap.
		expect(pollTimes[0]).toBeGreaterThanOrEqual(1000);
		expect(pollTimes[1]).toBeGreaterThanOrEqual(6000);
	});

	it("rejects a verification URI from a foreign origin", async () => {
		const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/oauth2/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://evil.example.com/device",
					interval: 1,
					expires_in: 900,
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(loginXai({ onAuth: vi.fn() })).rejects.toThrow("unexpected verification URL");
	});
});

describe("xAI token refresh validation", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("rejects a refresh response without a valid expires_in", async () => {
		const fetchMock = vi.fn(
			async (): Promise<Response> => jsonResponse({ access_token: "new-access", refresh_token: "new-refresh" }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(refreshXaiToken("old-refresh")).rejects.toThrow("expires_in");
	});
});
