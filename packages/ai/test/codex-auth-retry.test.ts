import { describe, expect, it } from "vitest";
import {
	isNonRetryableAuthStatus,
	isRetryableError,
	NonRetryableProviderError,
} from "../src/providers/openai-codex-responses.js";

describe("issue #1330 codex auth is not retried", () => {
	it.each([401, 403])("treats %i as non-retryable", (status) => {
		expect(isNonRetryableAuthStatus(status)).toBe(true);
	});

	// These must keep retrying: the transport budget exists for exactly these.
	it.each([429, 500, 502, 503, 504, 400, 404])("leaves %i alone", (status) => {
		expect(isNonRetryableAuthStatus(status)).toBe(false);
	});

	// The decision function itself, not just the predicate: a 401 body often contains
	// wording the transient regex would otherwise match, so status has to win.
	it.each([401, 403])("isRetryableError refuses to retry %i", (status) => {
		expect(isRetryableError(status, '{"error":{"message":"Your session has expired"}}')).toBe(false);
	});

	it("isRetryableError refuses a 401 even when the body reads like a rate limit", () => {
		expect(isRetryableError(401, "rate limit exceeded, service unavailable")).toBe(false);
	});

	it.each([429, 500, 502, 503, 504])("isRetryableError still retries %i", (status) => {
		expect(isRetryableError(status, "server error")).toBe(true);
	});

	it("carries the status so callers can mark the right credential stale", () => {
		const error = new NonRetryableProviderError("Unauthorized", 401);
		expect(error.status).toBe(401);
		expect(error.name).toBe("NonRetryableProviderError");
	});

	// The transport catch decides by type, not by message, because an auth message
	// has no reliable marker. Previously only "usage limit" escaped the retry path.
	it("is identifiable by type rather than by message text", () => {
		const error: unknown = new NonRetryableProviderError("Your session has expired", 401);
		expect(error instanceof NonRetryableProviderError).toBe(true);
		expect((error as Error).message).not.toContain("usage limit");
	});
});
