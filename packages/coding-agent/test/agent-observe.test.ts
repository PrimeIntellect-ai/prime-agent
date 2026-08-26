import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/faux";
import { describe, expect, it } from "vitest";
import {
	createAgentObserveMessagePreview,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
} from "../src/core/agent-observe.js";

describe("agent observe helpers", () => {
	it("creates bounded text previews", () => {
		const preview = createAgentObserveMessagePreview(
			{
				role: "user",
				content: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz" }],
				timestamp: 123,
			},
			4,
			8,
		);

		expect(preview).toEqual({
			index: 4,
			role: "user",
			timestamp: 123,
			text: "abcdefgh",
			truncated: true,
		});
	});

	it("includes assistant tool call names without exposing arguments", () => {
		const preview = createAgentObserveMessagePreview(
			fauxAssistantMessage(fauxToolCall("bash", { command: "secret" }), { stopReason: "toolUse" }),
			2,
			200,
		);

		expect(preview.text).toBe("[tool_call:bash]");
		expect(preview.toolCalls).toEqual(["bash"]);
		expect(preview.text).not.toContain("secret");
	});

	it("includes assistant thinking text in previews", () => {
		const preview = createAgentObserveMessagePreview(
			fauxAssistantMessage(fauxThinking("working through the plan")),
			1,
			200,
		);

		expect(preview.text).toBe("working through the plan");
		expect(preview.truncated).toBe(false);
	});

	it("validates bounds", () => {
		expect(normalizeObserveLimit(undefined)).toBe(8);
		expect(normalizeObserveLimit(50)).toBe(50);
		expect(() => normalizeObserveLimit(0)).toThrow("between 1 and 50");
		expect(normalizeObserveMaxChars(undefined)).toBe(800);
		expect(normalizeObserveMaxChars(80)).toBe(80);
		expect(() => normalizeObserveMaxChars(2_001)).toThrow("between 80 and 2000");
	});
});
