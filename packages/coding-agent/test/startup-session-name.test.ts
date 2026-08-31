import { describe, expect, it } from "vitest";
import { sanitizeAutoSessionName } from "../src/core/agent-session.js";

describe("sanitizeAutoSessionName", () => {
	it("removes thinking output and surrounding quotes", () => {
		expect(sanitizeAutoSessionName('<think>internal</think>\n"Fix login timeout"')).toBe("Fix login timeout");
	});
	it("truncates long titles", () => {
		const name = sanitizeAutoSessionName("a".repeat(101));
		expect(name).toHaveLength(100);
		expect(name?.endsWith("...")).toBe(true);
	});
	it("rejects empty output", () => {
		expect(sanitizeAutoSessionName("  ")).toBeUndefined();
	});
});
