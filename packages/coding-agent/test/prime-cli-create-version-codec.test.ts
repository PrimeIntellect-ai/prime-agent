import { describe, expect, it } from "bun:test";
import {
	parsePrimeCliCreateOutput,
	parsePrimeCliVersionOutput,
} from "../src/modes/daemon/sandbox/prime-cli-create-version-codec.js";
import fixture from "./fixtures/prime-cli-0.6.21-create-version-fixture.json";

const INVALID = Object.freeze({ ok: false, code: "INVALID_OUTPUT" });

function expectOpaqueFailure(result: unknown): void {
	expect(result).toEqual(INVALID);
	expect(Object.isFrozen(result)).toBe(true);
	if (typeof result === "object" && result !== null) {
		expect(Object.keys(result)).toEqual(["ok", "code"]);
	}
}

describe("Prime CLI 0.6.21 version codec", () => {
	it("accepts only the exact source-backed line", () => {
		const result = parsePrimeCliVersionOutput(fixture.versionStdout);
		expect(result).toEqual({ ok: true, value: { version: "0.6.21" } });
		expect(Object.isFrozen(result)).toBe(true);
		if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
	});

	for (const output of [
		"Prime CLI version: 0.6.21",
		"Prime CLI version: 0.6.21\n\n",
		" Prime CLI version: 0.6.21\n",
		"Prime CLI version: 0.6.22\n",
		"warning\nPrime CLI version: 0.6.21\n",
		"",
	]) {
		it(`rejects non-exact output ${JSON.stringify(output)}`, () => {
			expectOpaqueFailure(parsePrimeCliVersionOutput(output));
		});
	}
});

describe("Prime CLI 0.6.21 create codec", () => {
	it("accepts the source output with the same ID repeated", () => {
		const result = parsePrimeCliCreateOutput(fixture.createPlainStdout);
		expect(result).toEqual({ ok: true, value: { id: "sb_abc123" } });
		expect(Object.isFrozen(result)).toBe(true);
		if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
	});

	it("accepts one hexadecimal digit without inventing a fixed provider length", () => {
		expect(parsePrimeCliCreateOutput("Successfully created sandbox sb_a\n")).toEqual({
			ok: true,
			value: { id: "sb_a" },
		});
	});

	it("accepts a 128-byte total ID", () => {
		const id = `sb_${"a".repeat(125)}`;
		expect(parsePrimeCliCreateOutput(`Successfully created sandbox ${id}\n`)).toEqual({
			ok: true,
			value: { id },
		});
	});

	for (const output of [
		"",
		"Successfully created sandbox sb_\n",
		"Successfully created sandbox sb_xyz\n",
		"Successfully created sandbox sb_abcg\n",
		"Successfully created sandbox xsb_abc\n",
		"Successfully created sandbox sb_abc_extra\n",
		"Successfully created sandbox sb_abcé\n",
		"Successfully created sandbox sb_abc-def\n",
		"Successfully created sandbox sb_abc\nUse 'prime sandbox get sb_def'\n",
		"Successfully created sandbox sb_abc\nSuccessfully created sandbox sb_abc\n",
		"Created sandbox sb_abc\n",
		`Successfully created sandbox sb_${"a".repeat(126)}\n`,
		"Successfully created sandbox sb_abc\ud800\n",
	]) {
		it(`rejects ambiguous or malformed output ${output.length}`, () => {
			expectOpaqueFailure(parsePrimeCliCreateOutput(output));
		});
	}

	it("bounds output by UTF-8 bytes rather than UTF-16 units", () => {
		const prefix = "Successfully created sandbox sb_a\n";
		const output = `${prefix}${"é".repeat(524_280)}`;
		expect(output.length).toBeLessThan(1_048_576);
		expectOpaqueFailure(parsePrimeCliCreateOutput(output));
	});

	it("never reflects provider output in failures", () => {
		const secret = "do-not-reflect-this";
		const result = parsePrimeCliCreateOutput(`Successfully created sandbox sb_abc\n${secret} sb_def\n`);
		expectOpaqueFailure(result);
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(JSON.stringify(result)).not.toContain("sb_abc");
	});
});
