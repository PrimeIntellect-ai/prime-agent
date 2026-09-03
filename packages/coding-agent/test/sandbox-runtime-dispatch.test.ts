/**
 * Focused tests for detectReservedArgv — argv[0] check, always hand on match.
 *
 * Covers:
 *   - Pass through: empty argv, -- separator, normal args, flag at argv[1+]
 *   - Reserved flag at argv[0] ALWAYS hands (exact, standalone, 2-arg, extras)
 *   - Malformed reserved argv returns INVALID_RUNTIME_ARGUMENTS
 *   - Valid exact reserved argv returns ORCHESTRATION_UNAVAILABLE
 *   - Both fail closed with exitCode 1
 *   - Result immutability
 */

import { describe, expect, it } from "vitest";
import { detectReservedArgv } from "../src/cli/sandbox-runtime-dispatch.js";

// ===========================================================================
// Pass-through
// ===========================================================================

describe("pass-through (no reserved flag at argv[0])", () => {
	it("returns handed:false for empty argv", () => {
		const result = detectReservedArgv([]);
		expect(result).toEqual({ ok: false, handed: false });
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("returns handed:false for -- separator at argv[0]", () => {
		const result = detectReservedArgv(["--", "hello"]);
		expect(result).toEqual({ ok: false, handed: false });
	});

	it("returns handed:false for normal CLI args", () => {
		const result = detectReservedArgv(["--provider", "openai"]);
		expect(result).toEqual({ ok: false, handed: false });
	});

	it("returns handed:false for --help", () => {
		const result = detectReservedArgv(["--help"]);
		expect(result).toEqual({ ok: false, handed: false });
	});

	it("returns handed:false for --version", () => {
		const result = detectReservedArgv(["--version"]);
		expect(result).toEqual({ ok: false, handed: false });
	});

	it("returns handed:false when reserved flag is at argv[1] (not argv[0])", () => {
		const result = detectReservedArgv(["node", "--prime-agent-runtime-fd3"]);
		expect(result).toEqual({ ok: false, handed: false });
	});

	it("returns handed:false when reserved flag is at argv[2]", () => {
		const result = detectReservedArgv(["normal", "args", "--prime-agent-runtime-fd3"]);
		expect(result).toEqual({ ok: false, handed: false });
	});
});

// ===========================================================================
// Reserved flag at argv[0] — ALWAYS hands
// ===========================================================================

describe("reserved flag at argv[0] always hands", () => {
	const R = "--prime-agent-runtime-fd3";
	const W = "--prime-agent-fd3-bootstrap";
	const HEX = "0123456789abcdef0123456789abcdef";

	it("hands exact 3-element form (ORCHESTRATION_UNAVAILABLE)", () => {
		const result = detectReservedArgv([R, "--ready-nonce", HEX]);
		expect(result).toEqual({ ok: true, handed: true, code: "ORCHESTRATION_UNAVAILABLE", exitCode: 1 });
	});

	it("hands exact 3-element for wrapper flag (ORCHESTRATION_UNAVAILABLE)", () => {
		const result = detectReservedArgv([W, "--ready-nonce", HEX]);
		expect(result).toEqual({ ok: true, handed: true, code: "ORCHESTRATION_UNAVAILABLE", exitCode: 1 });
	});

	it("hands standalone flag (INVALID_RUNTIME_ARGUMENTS)", () => {
		const result = detectReservedArgv([R]);
		expect(result).toEqual({ ok: true, handed: true, code: "INVALID_RUNTIME_ARGUMENTS", exitCode: 1 });
	});

	it("hands 2-element form (INVALID_RUNTIME_ARGUMENTS)", () => {
		const result = detectReservedArgv([R, "--ready-nonce"]);
		expect(result).toEqual({ ok: true, handed: true, code: "INVALID_RUNTIME_ARGUMENTS", exitCode: 1 });
	});

	it("hands 4-element argv with extra trailing arg (INVALID_RUNTIME_ARGUMENTS)", () => {
		const result = detectReservedArgv([R, "--ready-nonce", HEX, "extra"]);
		expect(result).toEqual({ ok: true, handed: true, code: "INVALID_RUNTIME_ARGUMENTS", exitCode: 1 });
	});

	it("hands 2-element argv with wrong nonce flag (INVALID_RUNTIME_ARGUMENTS)", () => {
		const result = detectReservedArgv([R, "--wrong-flag", "abc"]);
		expect(result).toEqual({ ok: true, handed: true, code: "INVALID_RUNTIME_ARGUMENTS", exitCode: 1 });
	});

	it("hands argv with invalid hex nonce (INVALID_RUNTIME_ARGUMENTS)", () => {
		const result = detectReservedArgv([R, "--ready-nonce", "nothex"]);
		expect(result).toEqual({ ok: true, handed: true, code: "INVALID_RUNTIME_ARGUMENTS", exitCode: 1 });
	});

	it("hands argv with short nonce (INVALID_RUNTIME_ARGUMENTS)", () => {
		const result = detectReservedArgv([R, "--ready-nonce", "abc"]);
		expect(result).toEqual({ ok: true, handed: true, code: "INVALID_RUNTIME_ARGUMENTS", exitCode: 1 });
	});

	it("hands argv with wrong second flag (INVALID_RUNTIME_ARGUMENTS)", () => {
		const result = detectReservedArgv([R, "--not-ready-nonce", HEX]);
		expect(result).toEqual({ ok: true, handed: true, code: "INVALID_RUNTIME_ARGUMENTS", exitCode: 1 });
	});
});

// ===========================================================================
// Both exit codes are 1
// ===========================================================================
describe("exit codes", () => {
	it("ORCHESTRATION_UNAVAILABLE has exitCode 1", () => {
		const result = detectReservedArgv([
			"--prime-agent-runtime-fd3",
			"--ready-nonce",
			"0123456789abcdef0123456789abcdef",
		]);
		if (!result.ok) throw new Error("expected handed");
		expect(result.exitCode).toBe(1);
	});

	it("INVALID_RUNTIME_ARGUMENTS has exitCode 1", () => {
		const result = detectReservedArgv(["--prime-agent-runtime-fd3"]);
		if (!result.ok) throw new Error("expected handed");
		expect(result.exitCode).toBe(1);
	});
});

// ===========================================================================
// Result immutability
// ===========================================================================

describe("result immutability", () => {
	it("returns frozen result for ORCHESTRATION_UNAVAILABLE", () => {
		const result = detectReservedArgv([
			"--prime-agent-runtime-fd3",
			"--ready-nonce",
			"0123456789abcdef0123456789abcdef",
		]);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("returns frozen result for INVALID_RUNTIME_ARGUMENTS", () => {
		const result = detectReservedArgv(["--prime-agent-runtime-fd3"]);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("returns frozen result for pass-through", () => {
		const result = detectReservedArgv(["--help"]);
		expect(Object.isFrozen(result)).toBe(true);
	});
});

// ===========================================================================
// Edge: -- separator before reserved flag at argv[0]
// ===========================================================================

describe("-- separator at argv[0] passes through", () => {
	it("even when argv[1] is a reserved flag", () => {
		const result = detectReservedArgv(["--", "--prime-agent-runtime-fd3", "--ready-nonce", "a".repeat(32)]);
		expect(result).toEqual({ ok: false, handed: false });
	});

	it("even with -- alone", () => {
		const result = detectReservedArgv(["--"]);
		expect(result).toEqual({ ok: false, handed: false });
	});
});
