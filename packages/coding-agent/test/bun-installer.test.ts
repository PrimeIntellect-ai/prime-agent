import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const installer = join(repoRoot, "install.sh");

let tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {}
	}
	tempDirs = [];
});
function mkTemp(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-installer-"));
	tempDirs.push(d);
	return d;
}

function sourceVar(v: string): string {
	// Source installer with main call disabled via sed, capture variable
	const result = execFileSync(
		"sh",
		["-c", `eval "$(sed 's/^main "$@"/# &/' "$1")" 2>/dev/null; printf '%s' "$${v}"`, "--", installer],
		{ encoding: "utf-8" },
	);
	return result.trim();
}

// ============================================================================
describe("install.sh shell syntax", () => {
	it("passes POSIX shell syntax check", () => {
		expect(() => execFileSync("sh", ["-n", installer], { stdio: "pipe" })).not.toThrow();
	});

	it("rejects removed package-manager method flags", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-installer-method-"));
		tempDirs.push(root);
		const result = spawnSync("sh", [installer, "--method=npm", "1.2.3"], {
			encoding: "utf8",
			env: {
				HOME: join(root, "home"),
				PATH: process.env.PATH,
				PRIME_AGENT_DOWNLOAD_BASE_URL: "https://downloads.example.test",
				TERM: "dumb",
			},
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("--method is no longer supported");
	});

	it("reports an actionable error when HOME and explicit install paths are absent", () => {
		const result = spawnSync("sh", [installer, "1.2.3"], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				PRIME_AGENT_DOWNLOAD_BASE_URL: "https://downloads.example.test",
				TERM: "dumb",
			},
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("HOME is not set");
		expect(result.stderr).not.toContain("parameter not set");
	});
});

// ============================================================================
describe("versioned-dir variables", () => {
	it("uses XDG_DATA_HOME/prime-agent/versions for versions dir", () => {
		const dir = sourceVar("prime_agent_binary_versions_dir");
		expect(dir).toMatch(/prime-agent.versions$/);
		expect(dir).not.toContain(".prime");
	});

	it("sets symlink to XDG_BIN_HOME/prime-agent", () => {
		const link = sourceVar("prime_agent_binary_symlink");
		expect(link).toMatch(/prime-agent$/);
		expect(link).not.toContain(".prime");
	});

	it("respects PRIME_AGENT_VERSIONS_DIR env var", () => {
		const result = execFileSync(
			"sh",
			[
				"-c",
				"PRIME_AGENT_VERSIONS_DIR=/custom/versions; " +
					'eval "$(sed \'s/^main "$@"$/# &/\' "$1")" 2>/dev/null; ' +
					"printf '%s' $prime_agent_binary_versions_dir",
				"--",
				installer,
			],
			{ encoding: "utf-8" },
		).trim();
		expect(result).toBe("/custom/versions");
	});

	it("respects PRIME_AGENT_BIN_DIR env var for symlink path", () => {
		const result = execFileSync(
			"sh",
			[
				"-c",
				"PRIME_AGENT_BIN_DIR=/custom/bin; " +
					'eval "$(sed \'s/^main "$@"$/# &/\' "$1")" 2>/dev/null; ' +
					"printf '%s' $prime_agent_binary_symlink",
				"--",
				installer,
			],
			{ encoding: "utf-8" },
		).trim();
		expect(result).toBe("/custom/bin/prime-agent");
	});
});

// ============================================================================
describe("platform detection", () => {
	it("detects current platform as a valid binary platform", () => {
		const platform = execFileSync(
			"sh",
			[
				"-c",
				'eval "$(sed \'s/^main "$@"$/# &/\' "$1")" 2>/dev/null; prime_agent_detect_binary_platform',
				"--",
				installer,
			],
			{ encoding: "utf-8" },
		).trim();
		expect(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]).toContain(platform);
	});
});

// ============================================================================
describe("atomic symlink function", () => {
	it("creates and replaces symlink atomically", () => {
		const tmp = mkTemp();
		const v1 = `${tmp}/versions/v1`;
		const v2 = `${tmp}/versions/v2`;
		const link = `${tmp}/bin/prime-agent`;
		// Match installer pwd -P canonicalization (macOS /var -> /private/var).
		const resolvedTmp = realpathSync(tmp);
		const resolvedV2 = `${resolvedTmp}/versions/v2`;
		const helper = `${tmp}/atomic-symlink-helper.sh`;
		writeFileSync(
			helper,
			[
				"#! /bin/sh",
				"set -eu",
				'eval "$(sed \'s/^main "$@"$/# &/\' "$1")" 2>/dev/null',
				'mkdir -p "$2" "$3"',
				'touch "$2/pi" "$3/pi"',
				'chmod +x "$2/pi" "$3/pi"',
				'mkdir -p "$(dirname "$5")"',
				'prime_agent_binary_symlink="$5"',
				'prime_agent_binary_atomic_symlink "$2/pi" "$5"',
				'prime_agent_binary_atomic_symlink "$3/pi" "$5"',
				'[ "$(readlink "$5")" = "$4/pi" ] && printf "OK"',
			].join("\n"),
		);
		chmodSync(helper, 0o755);
		const result = execFileSync("sh", [helper, installer, v1, v2, resolvedV2, link], {
			encoding: "utf-8",
		}).trim();
		expect(result).toBe("OK");
	});
});
