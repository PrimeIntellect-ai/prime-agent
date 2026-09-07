import { describe, expect, it, vi } from "vitest";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	convertToLlm,
	createAsyncBashCompletionMessage,
} from "../src/core/messages.js";
import { createAsyncBashCompletionHostHandler } from "../src/core/rlm-runtime.js";

describe("async bash completion", () => {
	it("creates a model-visible instruction to inspect the saved handle", () => {
		const message = createAsyncBashCompletionMessage({
			pid: 42,
			command: "npm test",
			exitCode: 1,
		});

		expect(message.customType).toBe(ASYNC_BASH_COMPLETION_CUSTOM_TYPE);
		expect(message.content).toContain("pid 42, exit code 1");
		expect(message.content).toContain("npm test");
		expect(message.content).toContain(".poll(), .output(), or .tail()");
		expect(convertToLlm([message])).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: message.content }],
				timestamp: message.timestamp,
			},
		]);
	});

	it("validates and forwards kernel completion payloads", async () => {
		const completion = vi.fn();
		const handler = createAsyncBashCompletionHostHandler(completion);
		const payload = { pid: 42, command: "npm test", exitCode: 0 };

		await expect(handler(payload)).resolves.toEqual({});
		expect(completion).toHaveBeenCalledWith(payload);
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
