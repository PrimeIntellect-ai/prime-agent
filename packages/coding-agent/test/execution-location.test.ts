import { describe, expect, it } from "vitest";
import {
	ExecutionLocationError,
	isValidISODateString,
	normalizeExecutionLocation,
	normalizeRemoteModelDescriptor,
	normalizeRemoteSessionDescriptor,
	normalizeSandboxConnectionHealth,
	validateExecutionLocation,
	validateRemoteModelDescriptor,
	validateRemoteSessionDescriptor,
	validateSandboxConnectionHealth,
} from "../src/core/execution-location.js";

describe("isValidISODateString", () => {
	it("accepts full ISO with Z suffix", () => {
		expect(isValidISODateString("2026-09-02T06:44:00Z")).toBe(true);
	});

	it("accepts ISO with positive offset", () => {
		expect(isValidISODateString("2026-09-02T06:44:00+00:00")).toBe(true);
	});

	it("accepts ISO with negative offset", () => {
		expect(isValidISODateString("2026-09-02T06:44:00-04:00")).toBe(true);
	});

	it("accepts ISO with milliseconds and Z", () => {
		expect(isValidISODateString("2026-09-02T06:44:00.123Z")).toBe(true);
	});

	it("rejects bare date (no time)", () => {
		expect(isValidISODateString("2026-09-02")).toBe(false);
	});

	it("rejects ISO without timezone suffix", () => {
		expect(isValidISODateString("2026-09-02T06:44:00")).toBe(false);
	});

	it("rejects date with impossible month", () => {
		expect(isValidISODateString("2026-13-01T00:00:00Z")).toBe(false);
	});

	it("rejects non-string", () => {
		expect(isValidISODateString(12345 as unknown as string)).toBe(false);
	});

	it("rejects empty string", () => {
		expect(isValidISODateString("")).toBe(false);
	});

	it("rejects garbage", () => {
		expect(isValidISODateString("not-a-date")).toBe(false);
	});
});

describe("normalizeExecutionLocation", () => {
	it("returns local for { type: 'local' }", () => {
		expect(normalizeExecutionLocation({ type: "local" })).toEqual({ type: "local" });
	});

	it("returns undefined for null", () => {
		expect(normalizeExecutionLocation(null)).toBeUndefined();
	});

	it("returns undefined for non-object", () => {
		expect(normalizeExecutionLocation("local")).toBeUndefined();
	});

	it("returns undefined for unknown type", () => {
		expect(normalizeExecutionLocation({ type: "remote" })).toBeUndefined();
	});

	it("returns prime-sandbox with sandboxId and region", () => {
		const result = normalizeExecutionLocation({
			type: "prime-sandbox",
			sandboxId: "sbx-abc",
			region: "us-west",
		});
		expect(result).toEqual({ type: "prime-sandbox", sandboxId: "sbx-abc", region: "us-west" });
	});

	it("returns prime-sandbox without optional region", () => {
		const result = normalizeExecutionLocation({
			type: "prime-sandbox",
			sandboxId: "sbx-abc",
		});
		expect(result).toEqual({ type: "prime-sandbox", sandboxId: "sbx-abc" });
	});

	it("returns undefined when sandboxId is missing", () => {
		expect(normalizeExecutionLocation({ type: "prime-sandbox" })).toBeUndefined();
	});

	it("returns undefined when sandboxId is empty", () => {
		expect(normalizeExecutionLocation({ type: "prime-sandbox", sandboxId: "" })).toBeUndefined();
	});

	it("extra keys like apiKey do not break normaliser", () => {
		const result = normalizeExecutionLocation({
			type: "prime-sandbox",
			sandboxId: "sbx-1",
			apiKey: "sk-xxx",
		});
		expect(result).toEqual({ type: "prime-sandbox", sandboxId: "sbx-1" });
	});
});

describe("normalizeSandboxConnectionHealth", () => {
	it("returns connected with ISO timestamp", () => {
		expect(normalizeSandboxConnectionHealth({ status: "connected", connectedAt: "2026-09-02T06:44:00Z" })).toEqual({
			status: "connected",
			connectedAt: "2026-09-02T06:44:00Z",
		});
	});

	it("returns connecting", () => {
		expect(normalizeSandboxConnectionHealth({ status: "connecting", startedAt: "2026-09-02T06:44:00Z" })).toEqual({
			status: "connecting",
			startedAt: "2026-09-02T06:44:00Z",
		});
	});

	it("returns reconnecting", () => {
		expect(
			normalizeSandboxConnectionHealth({ status: "reconnecting", attempt: 2, since: "2026-09-02T06:44:00Z" }),
		).toEqual({ status: "reconnecting", attempt: 2, since: "2026-09-02T06:44:00Z" });
	});

	it("returns unreachable", () => {
		expect(
			normalizeSandboxConnectionHealth({
				status: "unreachable",
				error: "timeout",
				failedAt: "2026-09-02T06:44:00Z",
			}),
		).toEqual({ status: "unreachable", error: "timeout", failedAt: "2026-09-02T06:44:00Z" });
	});

	it("returns closed", () => {
		expect(normalizeSandboxConnectionHealth({ status: "closed" })).toEqual({ status: "closed" });
	});

	it("returns undefined for unknown status", () => {
		expect(normalizeSandboxConnectionHealth({ status: "disconnected" })).toBeUndefined();
	});

	it("returns undefined when connectedAt has no timezone", () => {
		expect(
			normalizeSandboxConnectionHealth({ status: "connected", connectedAt: "2026-09-02T06:44:00" }),
		).toBeUndefined();
	});

	it("returns undefined when reconnecting attempt is negative", () => {
		expect(
			normalizeSandboxConnectionHealth({ status: "reconnecting", attempt: -1, since: "2026-09-02T06:44:00Z" }),
		).toBeUndefined();
	});

	it("returns undefined for null", () => {
		expect(normalizeSandboxConnectionHealth(null)).toBeUndefined();
	});
});

describe("normalizeRemoteModelDescriptor", () => {
	it("returns descriptor for valid input", () => {
		expect(normalizeRemoteModelDescriptor({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" })).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-20250514",
		});
	});

	it("includes optional name", () => {
		expect(normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", name: "GPT-4o" })).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
			name: "GPT-4o",
		});
	});

	it("rejects input carrying apiKey", () => {
		expect(
			normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", apiKey: "sk-xxx" }),
		).toBeUndefined();
	});

	it("rejects input carrying baseUrl", () => {
		expect(
			normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", baseUrl: "https://api.openai.com" }),
		).toBeUndefined();
	});

	it("rejects input carrying token", () => {
		expect(
			normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", token: "secret" }),
		).toBeUndefined();
	});

	it("rejects missing provider", () => {
		expect(normalizeRemoteModelDescriptor({ modelId: "gpt-4o" })).toBeUndefined();
	});

	it("rejects null", () => {
		expect(normalizeRemoteModelDescriptor(null)).toBeUndefined();
	});
});

describe("normalizeRemoteSessionDescriptor", () => {
	const SESSION = {
		sessionId: "sess-xyz",
		createdAt: "2026-09-02T06:44:00Z",
		lastActiveAt: "2026-09-02T06:45:00Z",
		executionLocation: { type: "local" as const },
	};

	it("returns a valid session descriptor", () => {
		const result = normalizeRemoteSessionDescriptor(SESSION);
		expect(result).toBeDefined();
		expect(result!.sessionId).toBe("sess-xyz");
	});

	it("includes optional model", () => {
		const result = normalizeRemoteSessionDescriptor({
			...SESSION,
			model: { provider: "anthropic", modelId: "claude-sonnet-4" },
		});
		expect(result!.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4" });
	});

	it("rejects non-ISO createdAt (no timezone)", () => {
		expect(normalizeRemoteSessionDescriptor({ ...SESSION, createdAt: "2026-09-02T06:44:00" })).toBeUndefined();
	});

	it("rejects missing sessionId", () => {
		const { sessionId: _, ...rest } = SESSION;
		expect(normalizeRemoteSessionDescriptor(rest)).toBeUndefined();
	});

	it("rejects missing executionLocation", () => {
		const { executionLocation: _, ...rest } = SESSION;
		expect(normalizeRemoteSessionDescriptor(rest)).toBeUndefined();
	});
});

describe("validateExecutionLocation", () => {
	it("passes for local", () => {
		expect(validateExecutionLocation({ type: "local" })).toEqual({ type: "local" });
	});

	it("throws ExecutionLocationError for invalid input", () => {
		expect(() => validateExecutionLocation(null)).toThrow(ExecutionLocationError);
	});
});

describe("validateSandboxConnectionHealth", () => {
	it("passes for closed", () => {
		expect(validateSandboxConnectionHealth({ status: "closed" })).toEqual({ status: "closed" });
	});

	it("throws for invalid input", () => {
		expect(() => validateSandboxConnectionHealth({ status: "disconnected" })).toThrow(ExecutionLocationError);
	});
});

describe("validateRemoteModelDescriptor", () => {
	it("passes for valid input", () => {
		const result = validateRemoteModelDescriptor({ provider: "p", modelId: "m" });
		expect(result.provider).toBe("p");
	});

	it("throws for input with apiKey", () => {
		expect(() => validateRemoteModelDescriptor({ provider: "p", modelId: "m", apiKey: "sk-xxx" })).toThrow(
			ExecutionLocationError,
		);
	});
});

describe("validateRemoteSessionDescriptor", () => {
	it("passes for valid input", () => {
		const result = validateRemoteSessionDescriptor({
			sessionId: "s-1",
			createdAt: "2026-09-02T06:44:00Z",
			lastActiveAt: "2026-09-02T06:45:00Z",
			executionLocation: { type: "local" },
		});
		expect(result.sessionId).toBe("s-1");
	});

	it("throws for invalid input", () => {
		expect(() => validateRemoteSessionDescriptor(null)).toThrow(ExecutionLocationError);
	});
});

describe("ExecutionLocationError", () => {
	it("is an Error subclass with correct name", () => {
		const err = new ExecutionLocationError("bad");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("ExecutionLocationError");
		expect(err.message).toBe("bad");
	});
});
