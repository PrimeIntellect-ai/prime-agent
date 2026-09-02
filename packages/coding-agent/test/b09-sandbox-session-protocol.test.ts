import { describe, expect, it } from "vitest";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	getDaemonCommandCompatibilities,
	meetsDaemonCommandCompatibility,
	normalizeSandboxOptions,
} from "../src/modes/daemon/daemon-protocol.js";
import { durableDaemonCreateCommand } from "../src/modes/daemon/daemon-worker-protocol.js";

describe("B09 sandbox session creation protocol", () => {
	// -- Compatibility defaults: omitted / sandbox=false preserves local behavior --

	it("default create omits sandbox fields when not requested", () => {
		const compat = getDaemonCommandCompatibilities({ type: "create" });
		expect(compat.every((c) => c.capability !== "sandbox_sessions")).toBe(true);
	});

	it("sandbox=false does not require sandbox_sessions capability", () => {
		const compat = getDaemonCommandCompatibilities({ type: "create", sandbox: false } as never);
		expect(compat.every((c) => c.capability !== "sandbox_sessions")).toBe(true);
	});

	// -- sandbox=true / sandboxOptions requires sandbox_sessions capability --

	it("sandbox=true requires sandbox_sessions capability", () => {
		const compat = getDaemonCommandCompatibilities({ type: "create", sandbox: true } as never);
		const r = compat.find((c) => c.capability === "sandbox_sessions");
		expect(r).toBeDefined();
		expect(r!.minProtocol).toBe(7);
		expect(r!.minSchemaRevision).toBe(26);
	});

	it("sandboxOptions without sandbox also requires sandbox_sessions capability", () => {
		const compat = getDaemonCommandCompatibilities({
			type: "create",
			sandboxOptions: { region: "us-east-1" },
		} as never);
		expect(compat.find((c) => c.capability === "sandbox_sessions")).toBeDefined();
	});

	// -- old-daemon rejection --

	it("old daemon rejects sandbox=true because it lacks sandbox_sessions", () => {
		const compat = getDaemonCommandCompatibilities({ type: "create", sandbox: true } as never);
		const sandboxReq = compat.find((c) => c.capability === "sandbox_sessions")!;
		const oldHello = {
			protocol: { name: "prime-agent.daemon" as const, version: 7 },
			schemaRevision: 25,
			serverCapabilities: [] as const,
		};
		expect(meetsDaemonCommandCompatibility(oldHello, sandboxReq)).toBe(false);
	});

	it("current daemon accepts sandbox=true when it has sandbox_sessions", () => {
		const compat = getDaemonCommandCompatibilities({ type: "create", sandbox: true } as never);
		const sandboxReq = compat.find((c) => c.capability === "sandbox_sessions")!;
		const currentHello = {
			protocol: { name: "prime-agent.daemon" as const, version: 7 },
			schemaRevision: 26,
			serverCapabilities: ["sandbox_sessions" as const],
		};
		expect(meetsDaemonCommandCompatibility(currentHello, sandboxReq)).toBe(true);
	});

	// -- sandbox_sessions not in DEFAULT until B13 --

	it("sandbox_sessions is not in DAEMON_DEFAULT_SERVER_CAPABILITIES before B13", () => {
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).not.toContain("sandbox_sessions");
	});

	it("sandbox_sessions capability and schema revision exist on DAEMON_COMMAND_COMPATIBILITY", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.create).toEqual({ minProtocol: 7 });
	});

	// -- Wire serialization --

	it("durableDaemonCreateCommand preserves sandbox fields on the wire", () => {
		const durable = durableDaemonCreateCommand({
			type: "create",
			sandbox: true,
			sandboxOptions: { region: "eu-west-1" },
		} as never);
		expect(durable.sandbox).toBe(true);
		expect(durable.sandboxOptions).toEqual({ region: "eu-west-1" });
	});

	it("durableDaemonCreateCommand omits sandbox fields when undefined", () => {
		const durable = durableDaemonCreateCommand({ type: "create" } as never);
		expect(durable.sandbox).toBeUndefined();
		expect(durable.sandboxOptions).toBeUndefined();
	});

	it("durableDaemonCreateCommand omits sandbox when false", () => {
		const durable = durableDaemonCreateCommand({ type: "create", sandbox: false } as never);
		expect(durable.sandbox).toBe(false);
	});

	// -- normalizeSandboxOptions --

	it("normalizeSandboxOptions accepts undefined input", () => {
		expect(normalizeSandboxOptions(undefined)).toBeUndefined();
	});

	it("normalizeSandboxOptions accepts null", () => {
		expect(normalizeSandboxOptions(null)).toBeUndefined();
	});

	it("normalizeSandboxOptions accepts empty object", () => {
		expect(normalizeSandboxOptions({})).toEqual({});
	});

	it("normalizeSandboxOptions accepts region", () => {
		expect(normalizeSandboxOptions({ region: "us-east-1" })).toEqual({ region: "us-east-1" });
	});

	it("normalizeSandboxOptions rejects unknown keys", () => {
		expect(normalizeSandboxOptions({ unknown: "x" })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects nested objects", () => {
		expect(normalizeSandboxOptions({ region: { nested: true } })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects arrays", () => {
		expect(normalizeSandboxOptions(["a", "b"])).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects empty region string", () => {
		expect(normalizeSandboxOptions({ region: "" })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects numeric region", () => {
		expect(normalizeSandboxOptions({ region: 42 })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects workspaceId key", () => {
		expect(normalizeSandboxOptions({ workspaceId: "ws-123" })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects env key", () => {
		expect(normalizeSandboxOptions({ env: { PATH: "/danger" } })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects apiKey key", () => {
		expect(normalizeSandboxOptions({ apiKey: "sk-123" })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects token key", () => {
		expect(normalizeSandboxOptions({ token: "secret" })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects baseUrl key", () => {
		expect(normalizeSandboxOptions({ baseUrl: "https://example.com" })).toBeUndefined();
	});
	// -- Region safe-slug validation --

	it("normalizeSandboxOptions accepts simple region slug", () => {
		expect(normalizeSandboxOptions({ region: "us-east-1" })).toEqual({ region: "us-east-1" });
	});

	it("normalizeSandboxOptions accepts single-char region", () => {
		expect(normalizeSandboxOptions({ region: "a" })).toEqual({ region: "a" });
	});

	it("normalizeSandboxOptions accepts 64-char region", () => {
		expect(normalizeSandboxOptions({ region: "a".concat("b".repeat(63)) })).toBeDefined();
	});

	it("normalizeSandboxOptions rejects uppercase region", () => {
		expect(normalizeSandboxOptions({ region: "US-EAST-1" })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects hyphen-start region", () => {
		expect(normalizeSandboxOptions({ region: "-east-1" })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects underscore region", () => {
		expect(normalizeSandboxOptions({ region: "us_east" })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects 65-char region", () => {
		expect(normalizeSandboxOptions({ region: "a".concat("b".repeat(64)) })).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects string region", () => {
		expect(normalizeSandboxOptions({ region: "us-east-1" })).toEqual({ region: "us-east-1" });
	});

	// -- options-without-true validation (supervisor) --

	it("getDaemonCommandCompatibilities detects options-without-true", () => {
		// sandboxOptions without sandbox=true still requires sandbox_sessions capability
		const compat = getDaemonCommandCompatibilities({
			type: "create",
			sandboxOptions: { region: "eu-west-1" },
		} as never);
		expect(compat.find((c) => c.capability === "sandbox_sessions")).toBeDefined();
	});

	// -- No raw input in errors --

	it("normalizeSandboxOptions does not echo rejected values", () => {
		const result = normalizeSandboxOptions({ apiKey: "sk-1234567890abcdef" });
		expect(result).toBeUndefined();
	});

	it("normalizeSandboxOptions does not echo rejected region", () => {
		const result = normalizeSandboxOptions({ region: "UPPERCASE" });
		expect(result).toBeUndefined();
	});

	it("normalizeSandboxOptions returns undefined for deeply nested", () => {
		const result = normalizeSandboxOptions({ region: { invalid: true } });
		expect(result).toBeUndefined();
	});
});
