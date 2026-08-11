import { describe, expect, it } from "vitest";
import { formatAnthropicQuota, parseAnthropicQuota } from "../examples/extensions/anthropic-quota.js";

describe("Anthropic quota extension", () => {
	it("parses subscription quota windows and reset times", () => {
		const snapshot = parseAnthropicQuota({
			"Anthropic-Ratelimit-Unified-Status": "allowed",
			"Anthropic-Ratelimit-Unified-5h-Utilization": "0.84",
			"Anthropic-Ratelimit-Unified-5h-Reset": "1786421400",
			"Anthropic-Ratelimit-Unified-7d-Utilization": "0.37",
			"Anthropic-Ratelimit-Unified-7d-Reset": "2026-08-16T01:10:00Z",
		});

		expect(snapshot).toEqual({
			status: "allowed",
			windows: [
				{ name: "5h", utilization: 0.84, resetAt: new Date("2026-08-11T04:10:00.000Z") },
				{ name: "7d", utilization: 0.37, resetAt: new Date("2026-08-16T01:10:00.000Z") },
			],
		});
		expect(formatAnthropicQuota(snapshot!)).toBe("Claude quota 5h 84% · 7d 37%");
	});

	it("accepts weekly aliases and percentage utilization", () => {
		const snapshot = parseAnthropicQuota({
			"anthropic-ratelimit-unified-weekly-utilization": "84",
		});
		expect(snapshot?.windows).toEqual([{ name: "7d", utilization: 0.84, resetAt: undefined }]);
	});

	it("ignores unrelated and malformed headers", () => {
		expect(parseAnthropicQuota({ "x-ratelimit-remaining": "10" })).toBeUndefined();
		expect(parseAnthropicQuota({ "anthropic-ratelimit-unified-5h-utilization": "not-a-number" })).toBeUndefined();
	});
});
