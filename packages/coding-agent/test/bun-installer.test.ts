import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const installer = join(repoRoot, "install.sh");
const installerText = readFileSync(installer, "utf-8");

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
		{ encoding: "utf-8", env: process.env as any },
	);
	return result.trim();
}

// ============================================================================
describe("install.sh shell syntax", () => {
	it("passes POSIX shell syntax check", () => {
		expect(() => execFileSync("sh", ["-n", installer], { stdio: "pipe" })).not.toThrow();
	});

	it("supports compiled binary installs and updates only", () => {
		expect(installerText).toContain("prime_agent_binary_fresh_install");
		expect(installerText).toContain("prime_agent_binary_update");
		expect(installerText).toContain("--update");
		expect(installerText).not.toContain("prime_agent_npm_install");
		expect(installerText).not.toContain("install_node_npm");
		expect(installerText).not.toContain("npm install");
		expect(installerText).not.toContain("NPM Install Path");
		expect(installerText).not.toContain("prime_agent_package");
		expect(installerText).not.toContain("prime_agent_original_path");
		expect(installerText).not.toContain("prime_agent_bootstrap_kernel_on_install");
		expect(installerText).not.toContain("prime_agent_screen_question");
		expect(installerText).toContain("prime_agent_binary_acquire_lock");
		expect(installerText).toContain('grep -F -q -- "$_bin_dir"');
	});

	it("rejects removed package-manager method flags", () => {
		expect(installerText).toContain("--method is no longer supported");
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
			{ encoding: "utf-8", env: process.env as any },
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
			{ encoding: "utf-8", env: process.env as any },
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
			{ encoding: "utf-8", env: process.env as any },
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
		const cmd =
			'eval "$(sed \'s/^main "$@"$/# &/\' "$1")" 2>/dev/null' +
			"; mkdir -p " +
			v1 +
			" " +
			v2 +
			"; touch " +
			v1 +
			"/pi " +
			v2 +
			"/pi" +
			"; chmod +x " +
			v1 +
			"/pi " +
			v2 +
			"/pi" +
			"; mkdir -p " +
			tmp +
			"/bin" +
			"; prime_agent_binary_symlink=" +
			link +
			"; prime_agent_binary_atomic_symlink " +
			v1 +
			"/pi " +
			link +
			"; prime_agent_binary_atomic_symlink " +
			v2 +
			"/pi " +
			link +
			'; [ "$(readlink ' +
			link +
			')" = "' +
			v2 +
			"/pi\" ] && printf 'OK'";
		const result = execFileSync("sh", ["-c", cmd, "--", installer], {
			encoding: "utf-8",
			env: process.env as any,
		}).trim();
		expect(result).toBe("OK");
	});
});

// ============================================================================
describe("config dir isolation", () => {
	it("does not use ~/.prime for binary install paths", () => {
		const versionsLine = installerText.match(/^prime_agent_binary_versions_dir=.*$/m);
		const symlinkLine = installerText.match(/^prime_agent_binary_symlink=.*$/m);
		if (versionsLine) expect(versionsLine[0]).not.toContain(".prime");
		if (symlinkLine) expect(symlinkLine[0]).not.toContain(".prime");
	});

	it("uses XDG data dir for versions", () => {
		expect(installerText).toContain("XDG_DATA_HOME");
	});

	it("uses separate bin dir for symlink", () => {
		expect(installerText).toContain("prime_agent_binary_symlink");
	});

	it("does not copy sidecars into ~/.prime", () => {
		const freshSection = installerText.match(/prime_agent_binary_fresh_install[^}]*}/s)?.[0] || "";
		expect(freshSection).not.toContain(".prime");
	});
});

// ============================================================================
describe("install.sh sidecar", () => {
	it("ensures install.sh is made executable in versioned dir", () => {
		expect(installerText).toContain('chmod +x "$_version_dir/install.sh"');
	});

	it("appears in both fresh_install and update paths", () => {
		const matches = installerText.match(/chmod \+x "\$_version_dir\/install\.sh"/g);
		expect(matches).not.toBeNull();
		expect(matches!.length).toBe(2);
	});
});
