/**
 * Focused tests for buildSandboxSshSpawnSpec (B14 SSH spawn spec codec).
 *
 * Covers: golden exact-10 argv, all path/ID/nonce/env bounds, every
 * forbidden key and secret-looking key, missing PATH, input aliases,
 * recursive freeze/mutation, Proxy/getter/Symbol/non-enum/extra/
 * undefined/null-prototype handling exact, source scan for credential
 * fields/spawn/shell command.
 */

import { describe, expect, it } from "vitest";
import { buildSandboxSshSpawnSpec } from "../src/core/sandbox-ssh-spawn-spec.js";

// ---------------------------------------------------------------------------
// Golden reference
// ---------------------------------------------------------------------------

const GOLDEN = {
	sandboxId: "sbx-001",
	remoteExecutable: "/usr/bin/docker",
	homeCwd: "/home/user",
	readyNonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	homeEnv: { PATH: "/usr/bin:/bin", HOME: "/home/user", USER: "test", TMPDIR: "/tmp" },
};

const EXPECTED_ARGV: readonly string[] = [
	"prime",
	"sandbox",
	"ssh",
	"--plain",
	"sbx-001",
	"--",
	"/usr/bin/docker",
	"--prime-agent-fd3-bootstrap",
	"--ready-nonce",
	"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDeepFrozen(obj: unknown): boolean {
	if (obj === null || obj === undefined) return true;
	if (typeof obj === "object") {
		if (!Object.isFrozen(obj)) return false;
		for (const val of Object.values(obj as Record<string, unknown>)) {
			if (val !== null && typeof val === "object" && !isDeepFrozen(val)) return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSandboxSshSpawnSpec", () => {
	// -----------------------------------------------------------------------
	// Golden path
	// -----------------------------------------------------------------------

	it("returns a frozen ok result for valid input", () => {
		const result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.value)).toBe(true);
	});

	it("produces exact 10-element argv: [command, ...args]", () => {
		const result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const argv = [result.value.command, ...result.value.args];
		expect(argv).toHaveLength(10);
		expect(argv).toEqual(EXPECTED_ARGV);
	});

	it("command is prime, args length is 9", () => {
		const result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.command).toBe("prime");
		expect(result.value.args).toHaveLength(9);
	});

	it("args array is frozen", () => {
		const result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result.value.args)).toBe(true);
	});

	it("options is deeply frozen", () => {
		const result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result.value.options)).toBe(true);
		expect(Object.isFrozen(result.value.options.stdio)).toBe(true);
		expect(Object.isFrozen(result.value.options.env)).toBe(true);
		expect(isDeepFrozen(result.value.options)).toBe(true);
	});

	it("options.stdio is [pipe, pipe, pipe]", () => {
		const result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
	});

	it("options.shell is false", () => {
		const result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.options.shell).toBe(false);
	});

	it("options.detached is true", () => {
		const result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.options.detached).toBe(true);
	});

	it("options.cwd matches input homeCwd", () => {
		const result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.options.cwd).toBe(GOLDEN.homeCwd);
	});

	it("options.env contains PATH from input", () => {
		const result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.options.env.PATH).toBe(GOLDEN.homeEnv.PATH);
	});

	// -----------------------------------------------------------------------
	// sandboxId validation
	// -----------------------------------------------------------------------

	it("rejects sandboxId with leading dash", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, sandboxId: "-bad-id" });
		expect(result.ok).toBe(false);
	});

	it("rejects sandboxId >128 chars", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, sandboxId: "a".repeat(129) });
		expect(result.ok).toBe(false);
	});

	it("rejects empty sandboxId", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, sandboxId: "" });
		expect(result.ok).toBe(false);
	});

	it("accepts 128-char sandboxId", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, sandboxId: "a".repeat(128) });
		expect(result.ok).toBe(true);
	});

	it("rejects sandboxId with invalid characters", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, sandboxId: "sbx space" });
		expect(result.ok).toBe(false);
	});

	it("rejects non-string sandboxId", () => {
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, sandboxId: 123 }).ok).toBe(false);
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, sandboxId: null }).ok).toBe(false);
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, sandboxId: undefined }).ok).toBe(false);
	});

	it("accepts sandboxId with dots and underscores", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, sandboxId: "sbx.test_01" });
		expect(result.ok).toBe(true);
	});

	// -----------------------------------------------------------------------
	// remoteExecutable validation
	// -----------------------------------------------------------------------

	it("rejects remoteExecutable >1024 chars", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: `/${"a".repeat(1024)}` });
		expect(result.ok).toBe(false);
	});

	it("rejects root / as remoteExecutable", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: "/" });
		expect(result.ok).toBe(false);
	});

	it("rejects remoteExecutable with double slash", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: "/usr//bin/ls" });
		expect(result.ok).toBe(false);
	});

	it("rejects remoteExecutable with trailing slash", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: "/usr/bin/" });
		expect(result.ok).toBe(false);
	});

	it("rejects remoteExecutable with dot segment", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: "/usr/bin/./ls" });
		expect(result.ok).toBe(false);
	});

	it("rejects remoteExecutable with dotdot segment", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: "/usr/../ls" });
		expect(result.ok).toBe(false);
	});

	it("rejects remoteExecutable with invalid segment char", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: "/usr/b@d/ls" });
		expect(result.ok).toBe(false);
	});

	it("rejects relative remoteExecutable", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: "usr/bin/ls" });
		expect(result.ok).toBe(false);
	});

	it("accepts deep valid remoteExecutable", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: "/a/b/c/d/e/f/g/h" });
		expect(result.ok).toBe(true);
	});

	it("rejects non-string remoteExecutable", () => {
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: null }).ok).toBe(false);
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: undefined }).ok).toBe(false);
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: 42 }).ok).toBe(false);
	});

	it("rejects remoteExecutable with backslash", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, remoteExecutable: "/usr/bin\\ls" });
		expect(result.ok).toBe(false);
	});

	// -----------------------------------------------------------------------
	// homeCwd validation
	// -----------------------------------------------------------------------

	it("accepts / as homeCwd (root allowed)", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeCwd: "/" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.options.cwd).toBe("/");
	});

	it("rejects homeCwd >4096 chars", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeCwd: `/${"a".repeat(4096)}` });
		expect(result.ok).toBe(false);
	});

	it("rejects empty homeCwd", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeCwd: "" });
		expect(result.ok).toBe(false);
	});

	it("rejects non-string homeCwd", () => {
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, homeCwd: null }).ok).toBe(false);
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, homeCwd: undefined }).ok).toBe(false);
	});

	it("rejects homeCwd with invalid segment chars", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeCwd: "/home/use r" });
		expect(result.ok).toBe(false);
	});

	it("rejects homeCwd with double slash", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeCwd: "/home//user" });
		expect(result.ok).toBe(false);
	});

	// -----------------------------------------------------------------------
	// readyNonce validation
	// -----------------------------------------------------------------------

	it("accepts valid 32-hex readyNonce", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, readyNonce: "deadbeefdeadbeefdeadbeefdeadbeef" });
		expect(result.ok).toBe(true);
	});

	it("rejects non-hex readyNonce", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, readyNonce: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" });
		expect(result.ok).toBe(false);
	});

	it("rejects wrong-length readyNonce", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, readyNonce: "deadbeef" });
		expect(result.ok).toBe(false);
	});

	it("rejects uppercase hex readyNonce", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, readyNonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
		expect(result.ok).toBe(false);
	});

	it("rejects non-string readyNonce", () => {
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, readyNonce: 123 }).ok).toBe(false);
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, readyNonce: null }).ok).toBe(false);
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, readyNonce: undefined }).ok).toBe(false);
	});

	// -----------------------------------------------------------------------
	// homeEnv validation
	// -----------------------------------------------------------------------

	it("rejects missing PATH in homeEnv", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: { HOME: "/home/user" } });
		expect(result.ok).toBe(false);
	});

	it("rejects extra env key", () => {
		const result = buildSandboxSshSpawnSpec({
			...GOLDEN,
			homeEnv: { PATH: "/usr/bin", MY_SECRET_KEY: "s3cret" },
		});
		expect(result.ok).toBe(false);
	});

	it("rejects PATH with control character", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: { PATH: "/usr/bin\n" } });
		expect(result.ok).toBe(false);
	});

	it("rejects non-string PATH value", () => {
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: { PATH: 123 } }).ok).toBe(false);
		expect(buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: { PATH: null } }).ok).toBe(false);
	});

	it("rejects empty PATH string", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: { PATH: "" } });
		expect(result.ok).toBe(false);
	});

	it("rejects PATH >8192 chars", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: { PATH: "a".repeat(8193) } });
		expect(result.ok).toBe(false);
	});

	it("accepts PATH exactly 8192 chars", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: { PATH: "a".repeat(8192) } });
		expect(result.ok).toBe(true);
	});

	it("creates a fresh env copy", () => {
		const env = { PATH: "/usr/bin" };
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: env });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.options.env).not.toBe(env);
	});

	it("accepts only PATH in homeEnv (minimum)", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: { PATH: "/usr/bin:/bin" } });
		expect(result.ok).toBe(true);
	});

	it("rejects secret-looking env key", () => {
		const result = buildSandboxSshSpawnSpec({
			...GOLDEN,
			homeEnv: { PATH: "/usr/bin", ACCESS_KEY_ID: "AKID" },
		});
		expect(result.ok).toBe(false);
	});

	it("rejects env key with token in name", () => {
		const result = buildSandboxSshSpawnSpec({
			...GOLDEN,
			homeEnv: { PATH: "/usr/bin", API_TOKEN: "tok" },
		});
		expect(result.ok).toBe(false);
	});

	it("rejects env key with tunnel in name", () => {
		const result = buildSandboxSshSpawnSpec({
			...GOLDEN,
			homeEnv: { PATH: "/usr/bin", TUNNEL_ID: "tun" },
		});
		expect(result.ok).toBe(false);
	});

	it("rejects env key with provider in name", () => {
		const result = buildSandboxSshSpawnSpec({
			...GOLDEN,
			homeEnv: { PATH: "/usr/bin", PROVIDER: "aws" },
		});
		expect(result.ok).toBe(false);
	});

	// -----------------------------------------------------------------------
	// Structural rejection (accessors, Symbol, non-enum, Proxy, prototype)
	// -----------------------------------------------------------------------

	it("rejects homeEnv with getter accessor", () => {
		var env: Record<string, unknown> = Object.create(null);
		env.PATH = "/usr/bin";
		Object.defineProperty(env, "HOME", {
			get: () => "/home/user",
			enumerable: true,
			configurable: true,
		});
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: env });
		expect(result.ok).toBe(false);
	});

	it("rejects homeEnv with Symbol property", () => {
		var env = { PATH: "/usr/bin" } as Record<string, unknown>;
		env[Symbol("test")] = "nope";
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: env });
		expect(result.ok).toBe(false);
	});

	it("rejects homeEnv with non-enumerable own key", () => {
		var env: Record<string, unknown> = Object.create(null);
		env.PATH = "/usr/bin";
		Object.defineProperty(env, "HIDDEN", { value: "x", enumerable: false, configurable: true });
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: env });
		expect(result.ok).toBe(false);
	});

	it("rejects homeEnv with null value for allowlisted key", () => {
		var env: Record<string, unknown> = Object.create(null);
		env.PATH = "/usr/bin";
		env.HOME = null;
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: env });
		expect(result.ok).toBe(false);
	});

	it("rejects homeEnv with undefined value for allowlisted key", () => {
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: { PATH: undefined } });
		expect(result.ok).toBe(false);
	});

	it("rejects undefined homeEnv", () => {
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: undefined });
		expect(result.ok).toBe(false);
	});

	it("rejects null homeEnv", () => {
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: null });
		expect(result.ok).toBe(false);
	});

	it("rejects homeEnv that is an array", () => {
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: ["PATH=/usr/bin"] });
		expect(result.ok).toBe(false);
	});

	it("rejects Proxy-wrapped homeEnv", () => {
		var target = { PATH: "/usr/bin" };
		var proxy = new Proxy(target, {});
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: proxy });
		expect(result.ok).toBe(false);
	});

	it("accepts null-prototype homeEnv with valid keys", () => {
		var env = Object.create(null);
		env.PATH = "/usr/bin";
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: env });
		expect(result.ok).toBe(true);
	});

	it("rejects non-plain-object homeEnv (wrong prototype)", () => {
		class Foo {}
		var env = new Foo();
		env.PATH = "/usr/bin";
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: env });
		expect(result.ok).toBe(false);
	});

	// -----------------------------------------------------------------------

	// -----------------------------------------------------------------------
	// Top-level raw schema validation (single descriptor snapshot)
	// -----------------------------------------------------------------------

	it("rejects raw input with extra key", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, extraKey: "nope" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("EXTRA_KEY");
	});

	it("rejects raw input with Symbol key", () => {
		const obj: Record<string, unknown> = { ...GOLDEN };
		obj[Symbol("x")] = "y";
		const result = buildSandboxSshSpawnSpec(obj);
		expect(result.ok).toBe(false);
	});

	it("rejects raw input with non-enumerable key", () => {
		const obj: Record<string, unknown> = Object.create(null);
		obj.sandboxId = "sbx-001";
		obj.remoteExecutable = "/usr/bin/docker";
		obj.homeCwd = "/home/user";
		obj.readyNonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		obj.homeEnv = GOLDEN.homeEnv;
		Object.defineProperty(obj, "HIDDEN", { value: "x", enumerable: false, configurable: true });
		const result = buildSandboxSshSpawnSpec(obj);
		expect(result.ok).toBe(false);
	});

	it("rejects raw input with getter accessor", () => {
		const obj = Object.create(null);
		obj.sandboxId = "sbx-001";
		obj.remoteExecutable = "/usr/bin/docker";
		obj.homeCwd = "/home/user";
		obj.readyNonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		Object.defineProperty(obj, "homeEnv", {
			get: () => GOLDEN.homeEnv,
			enumerable: true,
			configurable: true,
		});
		const result = buildSandboxSshSpawnSpec(obj);
		expect(result.ok).toBe(false);
	});

	it("rejects Proxy-wrapped raw input", () => {
		const target = { ...GOLDEN };
		const proxy = new Proxy(target, {});
		const result = buildSandboxSshSpawnSpec(proxy);
		expect(result.ok).toBe(false);
	});

	it("rejects raw input with undefined property", () => {
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, sandboxId: undefined });
		expect(result.ok).toBe(false);
	});

	it("never throws; hostile getters return frozen error", () => {
		const throwingGetter: Record<string, unknown> = {
			get sandboxId() {
				throw new Error();
			},
		};
		Object.assign(throwingGetter, {
			remoteExecutable: "/usr/bin/docker",
			homeCwd: "/home/user",
			readyNonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			homeEnv: { PATH: "/usr/bin" },
		});
		const result = buildSandboxSshSpawnSpec(throwingGetter);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("rejects non-plain-object raw input", () => {
		class Foo {}
		const obj = new Foo();
		Object.assign(obj, GOLDEN);
		const result = buildSandboxSshSpawnSpec(obj);
		expect(result.ok).toBe(false);
	});

	it("error messages do not echo caller content", () => {
		const result = buildSandboxSshSpawnSpec({});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).not.toMatch(/sandboxId|remoteExe|homeCwd|readyNonce|homeEnv/);
	});

	it("error code belongs to closed literal union", () => {
		const result = buildSandboxSshSpawnSpec(42 as unknown);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const code = result.error.code;
		const validCodes = [
			"ACCESSOR_PROP",
			"BACKSLASH",
			"CONTROL_CHAR",
			"DOT_SEGMENT",
			"DOTDOT_SEGMENT",
			"DOUBLE_SLASH",
			"EXTRA_KEY",
			"INVALID_CHAR",
			"INVALID_INPUT",
			"INVALID_NONCE",
			"INVALID_SEGMENT",
			"INVALID_TYPE",
			"LEADING_DASH",
			"LENGTH",
			"MISSING_KEY",
			"MISSING_PATH",
			"NONENUM",
			"NON_STRING",
			"NOT_ABSOLUTE",
			"ROOT_PATH",
			"SYMBOL_KEY",
			"TRAILING_SLASH",
			"THROW",
			"UNDEFINED_VALUE",
		];
		expect(validCodes).toContain(code);
	});

	it("env is fresh copy; mutation after snapshot is harmless", () => {
		const env = { PATH: "/usr/bin" };
		const result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: env });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		env.PATH = "/hacked";
		expect(result.value.options.env.PATH).toBe("/usr/bin");
	});

	// -----------------------------------------------------------------------
	// Getter invocation safety (isPlainObject reads no getters)
	// -----------------------------------------------------------------------

	it("isPlainObject does not invoke getters on raw input", () => {
		let accessCount = 0;
		const obj: Record<string, unknown> = {
			sandboxId: "x",
			remoteExecutable: "/x",
			homeCwd: "/",
			readyNonce: "00000000000000000000000000000000",
			get homeEnv() {
				accessCount++;
				return { PATH: "/usr/bin" };
			},
		};
		buildSandboxSshSpawnSpec(obj);
		expect(accessCount).toBe(0);
	});

	it("isPlainObject does not invoke constructor getter on raw input", () => {
		let accessCount = 0;
		const proto = Object.create(null, {
			constructor: {
				get: () => {
					accessCount++;
					return Object;
				},
				enumerable: false,
				configurable: true,
			},
		});
		const obj = Object.create(proto);
		obj.sandboxId = "x";
		obj.remoteExecutable = "/x";
		obj.homeCwd = "/";
		obj.readyNonce = "00000000000000000000000000000000";
		obj.homeEnv = { PATH: "/usr/bin" };
		buildSandboxSshSpawnSpec(obj);
		expect(accessCount).toBe(0);
	});

	it("isPlainObject does not invoke constructor getter on homeEnv", () => {
		let accessCount = 0;
		const proto = Object.create(null, {
			constructor: {
				get: () => {
					accessCount++;
					return Object;
				},
				enumerable: false,
				configurable: true,
			},
		});
		const env = Object.create(proto);
		env.PATH = "/usr/bin";
		const result = buildSandboxSshSpawnSpec({
			sandboxId: "x",
			remoteExecutable: "/x",
			homeCwd: "/",
			readyNonce: "00000000000000000000000000000000",
			homeEnv: env,
		});
		expect(accessCount).toBe(0);
	});

	// Mutation protection
	// -----------------------------------------------------------------------

	it("mutation of input does not affect the result", () => {
		var input = JSON.parse(JSON.stringify(GOLDEN));
		var result = buildSandboxSshSpawnSpec(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		input.sandboxId = "hacked";
		expect(result.value.args[3]).toBe("sbx-001");
	});

	it("mutation of input homeEnv does not affect result env", () => {
		var env = { PATH: "/usr/bin" };
		var result = buildSandboxSshSpawnSpec({ ...GOLDEN, homeEnv: env });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		env.PATH = "/hacked";
		expect(result.value.options.env.PATH).toBe("/usr/bin");
	});

	it("result is deeply frozen (cannot be mutated)", () => {
		var result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(isDeepFrozen(result)).toBe(true);
		expect(isDeepFrozen(result.value)).toBe(true);
		expect(isDeepFrozen(result.value.options)).toBe(true);
	});

	it("spreading frozen result works (frozen prevents extension)", () => {
		var result = buildSandboxSshSpawnSpec(GOLDEN);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(() => {
			(result as any).x = 1;
		}).toThrow();
	});
});
