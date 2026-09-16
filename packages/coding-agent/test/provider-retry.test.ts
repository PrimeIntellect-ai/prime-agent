import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	completeWithProviderRetry,
	DEFAULT_PROVIDER_WAIT_POLICY,
	type ProviderWaitPolicy,
	parseProviderResetMs,
	providerParkDecision,
	providerRetryDelay,
	providerWaitClass,
	providerWaitDecision,
	providerWaitJitter,
	providerWaitPingDelay,
} from "../src/core/provider-retry.js";

function providerError(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "500 Internal Server Error",
		timestamp: Date.now(),
	};
}

describe("completeWithProviderRetry", () => {
	it("returns an aborted result instead of the provider error when cancelled during backoff", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);

		const result = await completeWithProviderRetry(async () => providerError(), {
			policy: { enabled: true, maxRetries: 3, baseDelayMs: 60_000, maxRetryDelayMs: 0 },
			signal: controller.signal,
		});

		expect(result.stopReason).toBe("aborted");
	});

	it("makes a single attempt when the policy disables retries", async () => {
		let attempts = 0;
		const result = await completeWithProviderRetry(
			async () => {
				attempts++;
				return providerError();
			},
			{ policy: { enabled: false, maxRetries: 3, baseDelayMs: 1, maxRetryDelayMs: 60_000 } },
		);

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("clamps uncapped server delays to Node's max timer instead of overflowing setTimeout", () => {
		const ninetyDaysMs = 90 * 24 * 3600 * 1000;
		expect(providerRetryDelay(1, ninetyDaysMs, { baseDelayMs: 2000, maxRetryDelayMs: 0 })).toEqual({
			kind: "wait",
			delayMs: 2_147_483_647,
		});
	});
});

const TEST_WAIT_POLICY: ProviderWaitPolicy = {
	enabled: true,
	baseDelayMs: 1000,
	maxDelayMs: 300_000,
	maxAttempts: 30,
	maxWaitMs: 900_000,
	pauseUntilReset: true,
	maxPauseMs: 86_400_000,
	maxParks: 8,
};

describe("providerWaitClass", () => {
	it("classifies quota/subscription exhaustion shapes as quota", () => {
		// Real shapes from daemon logs (2026-09-10): ChatGPT-plan usage limit, prime-inference throttle.
		expect(providerWaitClass("rate_limit", 429)).toBe("quota");
		expect(providerWaitClass("rate_limit", undefined)).toBe("quota");
		// Forward compatibility with a dedicated quota kind (as proposed in #795).
		expect(providerWaitClass("quota", 402)).toBe("quota");
	});

	it("classifies unavailability shapes as transient", () => {
		// 503 "Service temporarily at capacity" burst observed 2026-09-13.
		expect(providerWaitClass("server_error", 503)).toBe("transient");
		expect(providerWaitClass("overloaded", 529)).toBe("transient");
		expect(providerWaitClass("unknown", undefined)).toBe("transient"); // network errors carry no kind
		// A live model briefly 404s on routing blips (observed killing active sessions).
		expect(providerWaitClass("invalid_request", 404)).toBe("transient");
	});

	it("classifies permanent failures", () => {
		expect(providerWaitClass("auth", 401)).toBe("permanent");
		expect(providerWaitClass("permission", 403)).toBe("permanent");
		expect(providerWaitClass("refusal", undefined)).toBe("permanent");
		expect(providerWaitClass("safety", undefined)).toBe("permanent");
		expect(providerWaitClass("invalid_request", 400)).toBe("permanent");
		expect(providerWaitClass("invalid_request", undefined)).toBe("permanent");
		expect(providerWaitClass("malformed_response", undefined)).toBe("permanent");
		expect(providerWaitClass(undefined, undefined)).toBe("permanent");
	});
});

describe("providerWaitPingDelay", () => {
	it("grows exponentially from the base delay", () => {
		expect(providerWaitPingDelay(1, TEST_WAIT_POLICY)).toBe(1000);
		expect(providerWaitPingDelay(2, TEST_WAIT_POLICY)).toBe(2000);
		expect(providerWaitPingDelay(3, TEST_WAIT_POLICY)).toBe(4000);
		expect(providerWaitPingDelay(9, TEST_WAIT_POLICY)).toBe(256_000);
	});

	it("caps at maxDelayMs", () => {
		expect(providerWaitPingDelay(10, TEST_WAIT_POLICY)).toBe(300_000);
		expect(providerWaitPingDelay(50, TEST_WAIT_POLICY)).toBe(300_000);
	});
});

describe("providerWaitJitter", () => {
	it("stays within +/-25% of the delay", () => {
		expect(providerWaitJitter(1000, () => 0)).toBe(750);
		expect(providerWaitJitter(1000, () => 1)).toBe(1250);
		expect(providerWaitJitter(1000, () => 0.5)).toBe(1000);
	});
});

describe("providerWaitDecision", () => {
	it("waits the reported reset time exactly when it fits the bound", () => {
		const decision = providerWaitDecision(1, 0, 50, TEST_WAIT_POLICY, () => 0);
		expect(decision).toEqual({ kind: "wait", delayMs: 50 });
	});

	it("aborts when the reported reset exceeds the total wait bound", () => {
		// Codex-plan windows are reported in hours ("Try again in ~7272 min").
		const decision = providerWaitDecision(1, 0, 3_600_000, TEST_WAIT_POLICY);
		expect(decision.kind).toBe("abort");
		if (decision.kind === "abort") {
			expect(decision.reason).toBe("reset-too-far");
			expect(decision.message).toContain("maxWaitMs");
		}
	});

	it("applies exponential jittered pings bounded by the remaining budget", () => {
		const first = providerWaitDecision(1, 0, undefined, TEST_WAIT_POLICY, () => 1);
		expect(first).toEqual({ kind: "wait", delayMs: 1250 });
		// Jitter range for attempt 2 is [1500, 2500].
		const second = providerWaitDecision(2, 1250, undefined, TEST_WAIT_POLICY, () => 0);
		expect(second).toEqual({ kind: "wait", delayMs: 1500 });
		const jittered = providerWaitDecision(2, 1250, undefined, TEST_WAIT_POLICY, () => 1);
		expect(jittered).toEqual({ kind: "wait", delayMs: 2500 });
	});

	it("aborts after the ping attempt bound", () => {
		const decision = providerWaitDecision(31, 0, undefined, TEST_WAIT_POLICY);
		expect(decision.kind).toBe("abort");
		if (decision.kind === "abort") {
			expect(decision.reason).toBe("attempts");
			expect(decision.message).toContain("maxAttempts");
		}
	});

	it("aborts once the total wait bound is spent", () => {
		const decision = providerWaitDecision(1, 900_000, undefined, TEST_WAIT_POLICY);
		expect(decision.kind).toBe("abort");
		if (decision.kind === "abort") {
			expect(decision.reason).toBe("duration");
			expect(decision.message).toContain("maxWaitMs");
		}
	});

	it("truncates the final ping to the remaining budget", () => {
		const remaining = 2000;
		// Attempt 10 pings at the 300s cap; only 2s of budget is left.
		const decision = providerWaitDecision(
			10,
			TEST_WAIT_POLICY.maxWaitMs - remaining,
			undefined,
			TEST_WAIT_POLICY,
			() => 1,
		);
		expect(decision).toEqual({ kind: "wait", delayMs: remaining });
	});

	it("matches the documented defaults", () => {
		expect(DEFAULT_PROVIDER_WAIT_POLICY).toEqual({
			enabled: true,
			baseDelayMs: 1000,
			maxDelayMs: 300_000,
			maxAttempts: 30,
			maxWaitMs: 900_000,
			pauseUntilReset: true,
			maxPauseMs: 86_400_000,
			maxParks: 8,
		});
	});
});

describe("providerParkDecision", () => {
	it("parks until the reported reset plus a grace when the bounded wait cannot cover it", () => {
		// Subscription windows reported in hours ("Try again in 2 hours").
		const decision = providerParkDecision(0, 2 * 3_600_000, TEST_WAIT_POLICY);
		expect(decision).toEqual({
			kind: "park",
			delayMs: 2 * 3_600_000 + 30_000,
		});
	});

	it("caps the park at maxPauseMs so long-horizon resets still get probed", () => {
		const decision = providerParkDecision(0, 10 * 86_400_000, TEST_WAIT_POLICY);
		expect(decision).toEqual({ kind: "park", delayMs: 86_400_000 });
	});

	it("never parks when the pause setting is disabled", () => {
		const decision = providerParkDecision(0, 3_600_000, { ...TEST_WAIT_POLICY, pauseUntilReset: false });
		expect(decision).toEqual({ kind: "none", reason: "disabled" });
	});

	it("refuses to park once the park budget is spent", () => {
		const decision = providerParkDecision(8, 3_600_000, TEST_WAIT_POLICY);
		expect(decision).toEqual({ kind: "none", reason: "park-budget" });
		// maxParks 0 disables parking outright, including the first park.
		expect(providerParkDecision(0, 3_600_000, { ...TEST_WAIT_POLICY, maxParks: 0 })).toEqual({
			kind: "none",
			reason: "park-budget",
		});
	});

	it("never parks without a provider-reported reset time", () => {
		// Blind parks would guess a wake time; the bounded wait keeps its abort.
		expect(providerParkDecision(0, undefined, TEST_WAIT_POLICY)).toEqual({
			kind: "none",
			reason: "no-reset",
		});
	});
});

describe("parseProviderResetMs", () => {
	it("parses the real ChatGPT-plan usage-limit window", () => {
		expect(
			parseProviderResetMs(
				"You have hit your ChatGPT usage limit (self_serve_business_prolite plan). Try again in ~7272 min.",
			),
		).toBe(7272 * 60_000);
	});

	it("parses other unit shapes", () => {
		expect(parseProviderResetMs("Rate limit reached. Try again in 30 seconds.")).toBe(30_000);
		expect(parseProviderResetMs("Usage limit resets in 2 hours")).toBe(7_200_000);
		expect(parseProviderResetMs("Service available again in 1 day")).toBe(86_400_000);
	});

	it("returns undefined without a reported window", () => {
		expect(
			parseProviderResetMs("429 Too many concurrent requests for this model (limit: 32). Try again shortly."),
		).toBeUndefined();
		expect(parseProviderResetMs(undefined)).toBeUndefined();
	});
});
