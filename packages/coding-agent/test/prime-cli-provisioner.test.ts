import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
	bindPrimeSandboxProviderWithCredential,
	closePrimeCliAuthority,
	closePrimeCliCredentialAuthority,
	createPrimeCliCredentialAuthority,
	createPrimeCliRunCommand,
	PrimeCliAuthority,
	PrimeCliCredentialAuthority,
	provisionPrimeCliV1,
} from "../src/modes/daemon/sandbox/prime-cli-provisioner.js";
import {
	PRIME_CLI_GITIGNORE_WHEEL_BASE64,
	PRIME_CLI_GITIGNORE_WHEEL_NAME,
	PRIME_CLI_GITIGNORE_WHEEL_SHA256,
	PRIME_CLI_REQUIREMENTS_GZIP_BASE64,
	PRIME_CLI_REQUIREMENTS_GZIP_SHA256,
	PRIME_CLI_REQUIREMENTS_SHA256,
} from "../src/modes/daemon/sandbox/prime-cli-requirements-v1.js";

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("Prime CLI fixed artifacts", () => {
	test("binds the canonical full hash lock and deterministic binary-only wheel", () => {
		const compressed = Buffer.from(PRIME_CLI_REQUIREMENTS_GZIP_BASE64, "base64");
		const wheel = Buffer.from(PRIME_CLI_GITIGNORE_WHEEL_BASE64, "base64");
		expect(compressed.toString("base64")).toBe(PRIME_CLI_REQUIREMENTS_GZIP_BASE64);
		expect(wheel.toString("base64")).toBe(PRIME_CLI_GITIGNORE_WHEEL_BASE64);
		expect(sha256(compressed)).toBe(PRIME_CLI_REQUIREMENTS_GZIP_SHA256);
		expect(sha256(wheel)).toBe(PRIME_CLI_GITIGNORE_WHEEL_SHA256);
		expect(PRIME_CLI_GITIGNORE_WHEEL_NAME).toBe("gitignore_parser-0.1.13-py3-none-any.whl");
		const requirements = gunzipSync(compressed);
		expect(sha256(requirements)).toBe(PRIME_CLI_REQUIREMENTS_SHA256);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(requirements);
		const locked = text
			.split("\n")
			.filter(
				(line) =>
					line.length > 0 && line.charCodeAt(0) !== 0x23 && line.charCodeAt(0) !== 0x20 && line.includes("=="),
			);
		expect(locked).toHaveLength(121);
		expect(locked).toContain("prime==0.6.21 \\");
		expect(locked).toContain("prime-sandboxes==0.2.40 \\");
		compressed.fill(0);
		wheel.fill(0);
		requirements.fill(0);
	});
});

describe("Prime CLI provisioner authority boundary", () => {
	test("rejects forged authorities and hostile path values without traps", async () => {
		expect(() => new PrimeCliAuthority({})).toThrow();
		expect(() => new PrimeCliCredentialAuthority({})).toThrow();
		expect(closePrimeCliAuthority({})).toBe(false);
		expect(closePrimeCliCredentialAuthority({})).toBe(false);
		expect(createPrimeCliRunCommand({}, {})).toBeUndefined();
		let trapped = false;
		const hostile = new Proxy(
			{},
			{
				get() {
					trapped = true;
					throw new Error("trap");
				},
			},
		);
		expect(await provisionPrimeCliV1(hostile, hostile)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(trapped).toBe(false);
	});

	test("copies printable fixed-buffer credentials and rejects hostile storage", () => {
		const source = new TextEncoder().encode("test-only-credential");
		const created = createPrimeCliCredentialAuthority(source);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		source.fill(0);
		expect(bindPrimeSandboxProviderWithCredential({}, {}, created.value)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(closePrimeCliCredentialAuthority(created.value)).toBe(true);
		expect(closePrimeCliCredentialAuthority(created.value)).toBe(false);
		expect(createPrimeCliCredentialAuthority(new Uint8Array(0))).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(createPrimeCliCredentialAuthority(new Uint8Array([0x20]))).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(createPrimeCliCredentialAuthority(new Uint8Array(new ArrayBuffer(4), 1, 2))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		const shadowed = new Uint8Array([0x61]);
		Object.defineProperty(shadowed.buffer, "resizable", { value: false });
		expect(createPrimeCliCredentialAuthority(shadowed)).toEqual({ ok: false, code: "INPUT_INVALID" });
		let trapped = false;
		const hostile = new Proxy(new Uint8Array([0x61]), {
			get() {
				trapped = true;
				throw new Error("trap");
			},
		});
		expect(createPrimeCliCredentialAuthority(hostile)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(trapped).toBe(false);
	});

	test("rejects noncanonical, relative, control-bearing, and oversized paths", async () => {
		for (const value of ["relative", "/tmp/../tmp", "/tmp/line\nbreak", `/${"x".repeat(4_096)}`]) {
			expect(await provisionPrimeCliV1(value, "/usr/bin/python3")).toEqual({
				ok: false,
				code: "INPUT_INVALID",
			});
		}
	});
});
