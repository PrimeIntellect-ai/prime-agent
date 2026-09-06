import { afterEach, describe, expect, it, vi } from "bun:test";
import { refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex.js";

describe("OpenAI Codex OAuth", () => {
	let origFetchCodex: typeof globalThis.fetch | undefined;
	afterEach(() => {
		vi.restoreAllMocks();
		if (origFetchCodex !== undefined) {
			globalThis.fetch = origFetchCodex;
			origFetchCodex = undefined;
		}
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		origFetchCodex = globalThis.fetch;
		globalThis.fetch = vi.fn(async (): Promise<Response> => {
			return new Response(
				JSON.stringify({
					error: {
						message: "Could not validate your token. Please try signing in again.",
						type: "invalid_request_error",
					},
				}),
				{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
			);
		});

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
		);
		expect(consoleError).not.toHaveBeenCalled();
	});
});
