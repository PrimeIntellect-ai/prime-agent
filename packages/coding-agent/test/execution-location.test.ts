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

	it("accepts opaque prime-sandbox", () => {
		expect(normalizeExecutionLocation({ type: "prime-sandbox" })).toEqual({ type: "prime-sandbox" });
	});

	it("rejects prime-sandbox with sandboxId", () => {
		expect(normalizeExecutionLocation({ type: "prime-sandbox", sandboxId: "sbx-abc" })).toBeUndefined();
	});

	it("rejects prime-sandbox with region", () => {
		expect(normalizeExecutionLocation({ type: "prime-sandbox", region: "us-west" })).toBeUndefined();
	});

	it("rejects prime-sandbox with extra keys", () => {
		expect(normalizeExecutionLocation({ type: "prime-sandbox", apiKey: "sk-xxx" })).toBeUndefined();
	});

	it("rejects Proxy-wrapped input", () => {
		const target = { type: "prime-sandbox" };
		const proxy = new Proxy(target, {});
		expect(normalizeExecutionLocation(proxy)).toBeUndefined();
	});

	it("rejects input with getter descriptors", () => {
		const obj = {};
		Object.defineProperty(obj, "type", { get: () => "prime-sandbox", enumerable: true });
		expect(normalizeExecutionLocation(obj)).toBeUndefined();
	});

	it("rejects input with Symbol keys", () => {
		const obj = { type: "prime-sandbox" };
		Object.defineProperty(obj, Symbol("extra"), { value: 1, enumerable: true });
		expect(normalizeExecutionLocation(obj)).toBeUndefined();
	});

	it("rejects non-plain prototype", () => {
		class FakeLocation {}
		expect(normalizeExecutionLocation(new FakeLocation())).toBeUndefined();
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

	it("accepts all safe unreachable error codes", () => {
		const codes = ["timeout", "auth_failed", "not_found", "provider_error", "network_error", "unknown"];
		const iso = "2026-09-02T06:44:00Z";
		for (const code of codes) {
			const result = normalizeSandboxConnectionHealth({ status: "unreachable", error: code, failedAt: iso });
			expect(result).toBeDefined();
			if (result?.status === "unreachable") {
				expect(result.error).toBe(code);
			}
		}
	});

	it("rejects arbitrary exception text in unreachable error", () => {
		expect(
			normalizeSandboxConnectionHealth({
				status: "unreachable",
				error: "API key 'sk-abc123' invalid",
				failedAt: "2026-09-02T06:44:00Z",
			}),
		).toBeUndefined();
		expect(
			normalizeSandboxConnectionHealth({
				status: "unreachable",
				error: "Error: connection refused",
				failedAt: "2026-09-02T06:44:00Z",
			}),
		).toBeUndefined();
	});

	it("rejects unreachable with empty error string", () => {
		expect(
			normalizeSandboxConnectionHealth({ status: "unreachable", error: "", failedAt: "2026-09-02T06:44:00Z" }),
		).toBeUndefined();
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

	it("returns undefined when reconnecting attempt is NaN", () => {
		expect(
			normalizeSandboxConnectionHealth({ status: "reconnecting", attempt: NaN, since: "2026-09-02T06:44:00Z" }),
		).toBeUndefined();
	});

	it("returns undefined when reconnecting attempt is Infinity", () => {
		expect(
			normalizeSandboxConnectionHealth({ status: "reconnecting", attempt: Infinity, since: "2026-09-02T06:44:00Z" }),
		).toBeUndefined();
	});

	it("returns undefined when reconnecting attempt is a fraction", () => {
		expect(
			normalizeSandboxConnectionHealth({ status: "reconnecting", attempt: 1.5, since: "2026-09-02T06:44:00Z" }),
		).toBeUndefined();
	});

	it("returns undefined for null", () => {
		expect(normalizeSandboxConnectionHealth(null)).toBeUndefined();
	});

	it("rejects Proxy-wrapped connected status", () => {
		const target = { status: "connected", connectedAt: "2026-09-02T06:44:00Z" };
		const proxy = new Proxy(target, {});
		expect(normalizeSandboxConnectionHealth(proxy)).toBeUndefined();
	});

	it("rejects getter-based accessor for status", () => {
		const obj = {};
		Object.defineProperty(obj, "status", { get: () => "closed", enumerable: true });
		expect(normalizeSandboxConnectionHealth(obj)).toBeUndefined();
	});

	it("rejects extra unknown key in connected", () => {
		expect(
			normalizeSandboxConnectionHealth({ status: "connected", connectedAt: "2026-09-02T06:44:00Z", extra: true }),
		).toBeUndefined();
	});

	it("rejects Symbol-keyed input", () => {
		const obj = { status: "closed" };
		Object.defineProperty(obj, Symbol("x"), { value: 1, enumerable: true });
		expect(normalizeSandboxConnectionHealth(obj)).toBeUndefined();
	});

	it("rejects non-plain prototype", () => {
		class FakeHealth {}
		expect(normalizeSandboxConnectionHealth(new FakeHealth())).toBeUndefined();
	});

	it("rejects non-enumerable status", () => {
		const obj = {};
		Object.defineProperty(obj, "status", { value: "closed", enumerable: false });
		expect(normalizeSandboxConnectionHealth(obj)).toBeUndefined();
	});

	it("rejects unreachable with missing failedAt", () => {
		expect(normalizeSandboxConnectionHealth({ status: "unreachable", error: "timeout" })).toBeUndefined();
	});

	it("rejects reconnecting with missing since", () => {
		expect(normalizeSandboxConnectionHealth({ status: "reconnecting", attempt: 1 })).toBeUndefined();
	});

	it("rejects connected with missing connectedAt", () => {
		expect(normalizeSandboxConnectionHealth({ status: "connected" })).toBeUndefined();
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

	it("rejects present name that is undefined", () => {
		expect(
			normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", name: undefined }),
		).toBeUndefined();
	});

	it("rejects present name that is empty string", () => {
		expect(normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", name: "" })).toBeUndefined();
	});

	it("rejects present name that is non-string (number)", () => {
		expect(normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", name: 42 })).toBeUndefined();
	});

	it("rejects null", () => {
		expect(normalizeRemoteModelDescriptor(null)).toBeUndefined();
	});

	it("rejects Proxy-wrapped input", () => {
		const target = { provider: "anthropic", modelId: "claude-sonnet-4" };
		const proxy = new Proxy(target, {});
		expect(normalizeRemoteModelDescriptor(proxy)).toBeUndefined();
	});

	it("rejects getter-based accessor for provider", () => {
		const obj = {};
		Object.defineProperty(obj, "provider", { get: () => "anthropic", enumerable: true });
		Object.defineProperty(obj, "modelId", { value: "claude-3", enumerable: true });
		expect(normalizeRemoteModelDescriptor(obj)).toBeUndefined();
	});

	it("rejects unknown extra key", () => {
		expect(normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", unknown: "x" })).toBeUndefined();
	});

	it("rejects Symbol-keyed input", () => {
		const obj = { provider: "o", modelId: "m" };
		Object.defineProperty(obj, Symbol("x"), { value: 1, enumerable: true });
		expect(normalizeRemoteModelDescriptor(obj)).toBeUndefined();
	});

	it("rejects non-plain prototype", () => {
		class FakeModel {}
		expect(normalizeRemoteModelDescriptor(new FakeModel())).toBeUndefined();
	});

	it("rejects non-enumerable modelId", () => {
		const obj = {};
		Object.defineProperty(obj, "provider", { value: "o", enumerable: true });
		Object.defineProperty(obj, "modelId", { value: "m", enumerable: false });
		expect(normalizeRemoteModelDescriptor(obj)).toBeUndefined();
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

	it("rejects Proxy-wrapped input", () => {
		const target = {
			sessionId: "sess-1",
			createdAt: "2026-09-02T06:44:00Z",
			lastActiveAt: "2026-09-02T06:45:00Z",
			executionLocation: { type: "local" },
		};
		const proxy = new Proxy(target, {});
		expect(normalizeRemoteSessionDescriptor(proxy)).toBeUndefined();
	});

	it("rejects getter-based accessor for sessionId", () => {
		const obj = {};
		Object.defineProperty(obj, "sessionId", { get: () => "sess-1", enumerable: true });
		Object.defineProperty(obj, "createdAt", { value: "2026-09-02T06:44:00Z", enumerable: true });
		Object.defineProperty(obj, "lastActiveAt", { value: "2026-09-02T06:45:00Z", enumerable: true });
		Object.defineProperty(obj, "executionLocation", { value: { type: "local" }, enumerable: true });
		expect(normalizeRemoteSessionDescriptor(obj)).toBeUndefined();
	});

	it("rejects unknown extra key", () => {
		expect(normalizeRemoteSessionDescriptor({ ...SESSION, unknown: "x" })).toBeUndefined();
	});

	it("rejects Symbol-keyed input", () => {
		const obj = {
			sessionId: "sess-1",
			createdAt: "2026-09-02T06:44:00Z",
			lastActiveAt: "2026-09-02T06:45:00Z",
			executionLocation: { type: "local" },
		};
		Object.defineProperty(obj, Symbol("x"), { value: 1, enumerable: true });
		expect(normalizeRemoteSessionDescriptor(obj)).toBeUndefined();
	});

	it("rejects non-plain prototype", () => {
		class FakeSession {}
		const s = new FakeSession();
		(s as Record<string, unknown>).sessionId = "s1";
		(s as Record<string, unknown>).createdAt = "2026-09-02T06:44:00Z";
		(s as Record<string, unknown>).lastActiveAt = "2026-09-02T06:45:00Z";
		(s as Record<string, unknown>).executionLocation = { type: "local" };
		expect(normalizeRemoteSessionDescriptor(s as unknown)).toBeUndefined();
	});

	it("rejects model with credential leak at session level", () => {
		expect(
			normalizeRemoteSessionDescriptor({
				...SESSION,
				model: { provider: "anthropic", modelId: "claude", apiKey: "sk-xxx" },
			}),
		).toBeUndefined();
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
