import { describe, expect, it, vi } from "vitest";
import { startsAgentRun } from "../src/core/agent-messages.js";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	convertToLlm,
	createAsyncBashCompletionMessage,
} from "../src/core/messages.js";
import { createAsyncBashCompletionHostHandler, createAsyncBashConsumedHostHandler } from "../src/core/rlm-runtime.js";

describe("async bash completion", () => {
	it("creates a bracket-grammar completion notice without a standing handle hint", () => {
		const message = createAsyncBashCompletionMessage({
			pid: 42,
			command: "npm test",
			exitCode: 1,
		});

		expect(message.customType).toBe(ASYNC_BASH_COMPLETION_CUSTOM_TYPE);
		expect(message.content).toBe('[bash-done pid:42 exit:1]\n\nCommand: "npm test"');
		expect(convertToLlm([message])).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: message.content }],
				timestamp: message.timestamp,
			},
		]);
	});

	it("starts a new agent run for a background completion follow-up", () => {
		const message = createAsyncBashCompletionMessage({ pid: 42, command: "long-running-tool", exitCode: 0 });
		expect(startsAgentRun(message)).toBe(true);
	});

	it("validates and forwards kernel completion payloads", async () => {
		const completion = vi.fn();
		const handler = createAsyncBashCompletionHostHandler(completion);
		const payload = { pid: 42, command: "npm test", exitCode: 0 };

		await expect(handler(payload)).resolves.toEqual({});
		expect(completion).toHaveBeenCalledWith(payload);
	});

	it("validates and forwards kernel result-read payloads", async () => {
		const consumed = vi.fn();
		const handler = createAsyncBashConsumedHostHandler(consumed);
		const payload = { pid: 42, command: "npm test" };

		await expect(handler(payload)).resolves.toEqual({});
		expect(consumed).toHaveBeenCalledWith(payload);
		await expect(handler({ pid: 0, command: "npm test" })).rejects.toThrow("positive integer");
		await expect(handler({ pid: 42, command: "" })).rejects.toThrow("non-empty string");
	});

	it.each([
		[{ pid: 0, command: "ok", exitCode: 0 }, "positive integer"],
		[{ pid: 1, command: "", exitCode: 0 }, "non-empty string"],
		[{ pid: 1, command: "ok", exitCode: 0.5 }, "exitCode"],
	])("rejects an invalid payload %#", async (payload, error) => {
		const handler = createAsyncBashCompletionHostHandler(() => undefined);
		await expect(handler(payload)).rejects.toThrow(error);
	});
});
