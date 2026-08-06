import { describe, expect, it } from "vitest";
import { AgentSession, type PromptOptions } from "../src/core/agent-session.js";
import {
	convertToLlm,
	createManualContinueMessage,
	MANUAL_CONTINUE_CUSTOM_TYPE,
	MANUAL_CONTINUE_PROMPT,
} from "../src/core/messages.js";

describe("manual continuation", () => {
	it("normalizes a lone host prompt at the session input boundary", () => {
		const normalize = (
			AgentSession.prototype as unknown as {
				_normalizeManualContinuation(
					text: string,
					options?: PromptOptions,
				): { text: string; options?: PromptOptions };
			}
		)._normalizeManualContinuation;
		const normalized = normalize.call({}, ".");
		expect(normalized).toMatchObject({
			text: MANUAL_CONTINUE_PROMPT,
			options: {
				internalPrompt: true,
				customMessage: { customType: MANUAL_CONTINUE_CUSTOM_TYPE, display: false },
			},
		});
		expect(normalize.call({}, ".", { images: [{ type: "image", data: "x", mimeType: "image/png" }] })).toEqual({
			text: ".",
			options: { images: [{ type: "image", data: "x", mimeType: "image/png" }] },
		});
	});

	it("persists a hidden custom message while giving the model the continuation directive", () => {
		const message = createManualContinueMessage(123);
		expect(message).toMatchObject({
			role: "custom",
			customType: MANUAL_CONTINUE_CUSTOM_TYPE,
			display: false,
			timestamp: 123,
		});
		expect(convertToLlm([message])).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: MANUAL_CONTINUE_PROMPT }],
				timestamp: 123,
			},
		]);
	});
});
