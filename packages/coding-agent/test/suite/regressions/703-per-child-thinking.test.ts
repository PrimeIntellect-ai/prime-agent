import { describe, expect, it } from "vitest";
import { normalizeRequestedRlmSubagentThinkingLevel } from "../../../src/core/rlm-runtime.js";

describe("issue #703 per-child thinking level on rlm.run", () => {
	it.each(["minimal", "low", "medium", "high", "xhigh", "max"])("accepts %s", (level) => {
		expect(normalizeRequestedRlmSubagentThinkingLevel(level)).toBe(level);
	});

	it("returns undefined when omitted so the child inherits the parent level", () => {
		expect(normalizeRequestedRlmSubagentThinkingLevel(undefined)).toBeUndefined();
	});

	it("trims surrounding whitespace", () => {
		expect(normalizeRequestedRlmSubagentThinkingLevel("  max  ")).toBe("max");
	});

	it.each([null, 3, true, {}, []])("rejects the non-string %s", (value) => {
		expect(() => normalizeRequestedRlmSubagentThinkingLevel(value)).toThrow("thinking must be a string");
	});

	// "off" is deliberately excluded: the child runtime options type is ThinkingLevel, not
	// ModelThinkingLevel, so accepting it here would widen the subagent contract.
	it.each(["", "off", "highest", "MAX", "ultra"])("rejects the unsupported level %s", (value) => {
		expect(() => normalizeRequestedRlmSubagentThinkingLevel(value)).toThrow("thinking must be one of");
	});

	it("names the supported levels in the error so the agent can correct itself", () => {
		expect(() => normalizeRequestedRlmSubagentThinkingLevel("turbo")).toThrow(
			"minimal, low, medium, high, xhigh, max",
		);
	});
});
