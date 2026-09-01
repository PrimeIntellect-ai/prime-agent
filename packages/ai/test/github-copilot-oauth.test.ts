import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginGitHubCopilot } from "../src/utils/oauth/github-copilot.js";

/** Flush microtask queue so async continuations run */
async function flush(times = 10): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
	}
}

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
	throw new Error(`Unsupported fetch input: \${String(input)}`);
}

describe("GitHub Copilot OAuth device flow", () => {
	let origFetchGH: typeof globalThis.fetch | undefined;
	afterEach(() => {
		if (origFetchGH !== undefined) {
			globalThis.fetch = origFetchGH;
			origFetchGH = undefined;
		}
		vi.useRealTimers();
	});

	it("waits before the first poll and increases the safety margin after slow_down", async () => {
		vi.useFakeTimers();
		const baseTime = Date.now();

		const accessTokenPollTimes: number[] = [];
		const accessTokenResponses = [
			jsonResponse({ error: "authorization_pending", error_description: "pending" }),
			jsonResponse({ error: "slow_down", error_description: "slow down", interval: 10 }),
			jsonResponse({ access_token: "ghu_refresh_token" }),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/login/device/code")) {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				});
				expect(String(init?.body)).toContain("client_id=");
				expect(String(init?.body)).toContain("scope=read%3Auser");
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 900,
				});
			}

			if (url.endsWith("/login/oauth/access_token")) {
				accessTokenPollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				});
				expect(String(init?.body)).toContain("client_id=");
				expect(String(init?.body)).toContain("device_code=device-code");
				expect(String(init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
				const response = accessTokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra access token poll");
				}
				return response;
			}

			if (url.includes("/copilot_internal/v2/token")) {
				return jsonResponse({
					token: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
					expires_at: 9999999999,
				});
			}

			if (url.includes("/models/") && url.endsWith("/policy")) {
				return new Response("", { status: 200 });
			}

			throw new Error(`Unexpected fetch URL: \${url}`);
		});

		origFetchGH = globalThis.fetch;
		globalThis.fetch = fetchMock;

		const loginPromise = loginGitHubCopilot({
			onAuth: () => {},
			onPrompt: async () => "",
			onProgress: () => {},
		});

		// Let loginGitHubCopilot initialize and enter the poll loop
		await flush(30);

		expect(accessTokenPollTimes).toHaveLength(0);

		vi.advanceTimersByTime(5999);
		await flush();
		expect(accessTokenPollTimes).toHaveLength(0);

		vi.advanceTimersByTime(1);
		await flush();
		expect(accessTokenPollTimes).toHaveLength(1);

		vi.advanceTimersByTime(5999);
		await flush();
		expect(accessTokenPollTimes).toHaveLength(1);

		vi.advanceTimersByTime(1);
		await flush();
		expect(accessTokenPollTimes).toHaveLength(2);

		vi.advanceTimersByTime(13999);
		await flush();
		expect(accessTokenPollTimes).toHaveLength(2);

		vi.advanceTimersByTime(1);
		await flush();
		await loginPromise;

		expect(accessTokenPollTimes).toEqual([baseTime + 6000, baseTime + 12000, baseTime + 26000]);
	});

	it("uses the remaining lifetime for a final poll before timing out after repeated slow_down responses", async () => {
		vi.useFakeTimers();
		const baseTime = Date.now();

		const accessTokenPollTimes: number[] = [];
		const accessTokenResponses = [
			jsonResponse({ error: "slow_down", error_description: "slow down", interval: 10 }),
			jsonResponse({ error: "slow_down", error_description: "still too fast", interval: 15 }),
			jsonResponse({ error: "authorization_pending", error_description: "pending" }),
		];

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 25,
				});
			}
			if (url.endsWith("/login/oauth/access_token")) {
				accessTokenPollTimes.push(Date.now());
				const response = accessTokenResponses.shift();
				if (!response) throw new Error("Unexpected extra access token poll");
				return response;
			}
			throw new Error(`Unexpected fetch URL: \${url}`);
		});

		origFetchGH = globalThis.fetch;
		globalThis.fetch = fetchMock;

		const loginPromise = loginGitHubCopilot({
			onAuth: () => {},
			onPrompt: async () => "",
		});
		// Let loginGitHubCopilot initialize and enter the poll loop
		await flush(30);

		// First wait: ceil(5000 * 1.2) = 6000ms
		vi.advanceTimersByTime(6000);
		await flush();
		expect(accessTokenPollTimes).toEqual([baseTime + 6000]);

		// After slow_down: ceil(10000 * 1.4) = 14000ms
		vi.advanceTimersByTime(14000);
		await flush();
		expect(accessTokenPollTimes).toEqual([baseTime + 6000, baseTime + 20000]);

		// After second slow_down: min(ceil(15000*1.4), remaining=5000) = 5000ms
		vi.advanceTimersByTime(4999);
		await flush();
		expect(accessTokenPollTimes).toEqual([baseTime + 6000, baseTime + 20000]);

		// Deadline crossed, loop exits, slowDownResponses>0 -> throws
		vi.advanceTimersByTime(1);
		await flush();
		try {
			await loginPromise;
			expect.unreachable("should have thrown");
		} catch (e) {
			expect((e as Error).message).toMatch(/Device flow timed out after one or more slow_down responses/);
		}

		expect(accessTokenPollTimes).toEqual([baseTime + 6000, baseTime + 20000, baseTime + 25000]);
	});
});
