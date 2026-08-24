import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { rewriteCellMagics } from "../src/core/tools/ipython-cell-code.js";

function assertValidPython(code: string): void {
	execFileSync("python3", ["-c", `x = "X"\n${code}`], { stdio: "pipe" });
}

describe("rewriteCellMagics", () => {
	it("rewrites a %%bash cell into an awaited bash() stanza", () => {
		const rewritten = rewriteCellMagics("%%bash\necho hi\nls -la");
		expect(rewritten).toContain(`_prime_agent_bash = await bash(${JSON.stringify("echo hi\nls -la")})`);
		expect(rewritten).toContain('print(_prime_agent_bash.output, end="")');
		expect(rewritten).toContain('raise RuntimeError(f"bash exited with code {_prime_agent_bash.exit_code}")');
	});

	it("drops %%bash magic arguments (shell settings flow via env)", () => {
		const rewritten = rewriteCellMagics("%%bash --login\necho hi");
		expect(rewritten).toContain(`await bash(${JSON.stringify("echo hi")})`);
		expect(rewritten).not.toContain("--login");
	});

	it("preserves leading blank lines before a %%bash cell", () => {
		const rewritten = rewriteCellMagics("\n\n%%bash\necho hi");
		expect(rewritten.startsWith("\n\n_prime_agent_bash")).toBe(true);
	});

	it("rewrites %cd with a target directory, tracks the previous cwd, and echoes the new cwd", () => {
		expect(rewriteCellMagics("%cd /tmp/dir")).toBe(
			'_prime_agent_cd_old = __import__("os").getcwd(); __import__("os").chdir(__import__("os").path.expanduser("/tmp/dir")); _prime_agent_prev_cd = _prime_agent_cd_old; print(__import__("os").getcwd())',
		);
	});

	it("rewrites bare %cd to the home directory", () => {
		expect(rewriteCellMagics("%cd")).toBe(
			'_prime_agent_cd_old = __import__("os").getcwd(); __import__("os").chdir(__import__("os").path.expanduser("~")); _prime_agent_prev_cd = _prime_agent_cd_old; print(__import__("os").getcwd())',
		);
	});

	it("keeps _prime_agent_prev_cd untouched when %cd fails", () => {
		const failedCd = rewriteCellMagics("%cd /prime-agent-test-missing-dir");
		const check = [
			'_prime_agent_prev_cd = "/pre-existing"',
			"try:",
			...failedCd.split("\n").map((line) => `    ${line}`),
			"except OSError:",
			"    pass",
			'assert _prime_agent_prev_cd == "/pre-existing", _prime_agent_prev_cd',
		].join("\n");
		execFileSync("python3", ["-c", check], { stdio: "pipe" });
	});

	it("expands ~ in %cd targets", () => {
		expect(rewriteCellMagics("%cd ~/projects")).toContain('__import__("os").path.expanduser("~/projects")');
	});

	it("strips matching outer quotes from %cd targets", () => {
		expect(rewriteCellMagics("%cd 'dir with spaces'")).toContain(
			'__import__("os").path.expanduser("dir with spaces")',
		);
		expect(rewriteCellMagics('%cd "dir with spaces"')).toContain(
			'__import__("os").path.expanduser("dir with spaces")',
		);
	});

	it("keeps mismatched quotes in %cd targets literal", () => {
		expect(rewriteCellMagics("%cd 'dir\"")).toContain('__import__("os").path.expanduser("\'dir\\"")');
	});

	it("rewrites %cd - to the previous directory with a helpful error", () => {
		const rewritten = rewriteCellMagics("%cd -");
		expect(rewritten).toContain('globals().get("_prime_agent_prev_cd")');
		expect(rewritten).toContain('raise RuntimeError("No previous directory to change to")');
		expect(rewritten).toContain(
			'__import__("os").chdir(_prime_agent_cd_target); _prime_agent_prev_cd = _prime_agent_cd_old; print(__import__("os").getcwd())',
		);
	});

	it("rewrites %cd with a tab separator and tolerates a trailing carriage return", () => {
		expect(rewriteCellMagics("%cd\t/tmp")).toContain('__import__("os").path.expanduser("/tmp")');
		expect(rewriteCellMagics("%cd /tmp\r")).toContain('__import__("os").path.expanduser("/tmp")');
	});

	it("rewrites bare %cd and bare %env on CRLF lines", () => {
		expect(rewriteCellMagics("%cd\r\n")).toContain('__import__("os").path.expanduser("~")');
		expect(rewriteCellMagics("%env\r\n")).toContain('"[REDACTED]"');
	});

	it("rewrites %env NAME=value to an environ assignment", () => {
		expect(rewriteCellMagics("%env FOO=bar baz")).toBe('__import__("os").environ["FOO"] = "bar baz"');
	});

	it("rewrites %env NAME value (space-separated) to an environ assignment", () => {
		expect(rewriteCellMagics("%env FOO bar")).toBe('__import__("os").environ["FOO"] = "bar"');
	});

	it("splits %env at the first '=' even with surrounding spaces", () => {
		expect(rewriteCellMagics("%env FOO = bar")).toBe('__import__("os").environ["FOO"] = "bar"');
	});

	it("keeps '=' in the value when the assignment is space-separated", () => {
		expect(rewriteCellMagics("%env FOO bar=baz")).toBe('__import__("os").environ["FOO"] = "bar=baz"');
	});

	it("expands $var values in %env assignments from Python variables", () => {
		expect(rewriteCellMagics("%env FOO=$bar")).toBe('__import__("os").environ["FOO"] = f"{bar}"');
	});

	it("expands braced and embedded $var occurrences in %env values", () => {
		expect(rewriteCellMagics("%env FOO=$" + "{bar}")).toBe('__import__("os").environ["FOO"] = f"{bar}"');
		expect(rewriteCellMagics("%env FOO=$bar.suffix")).toBe('__import__("os").environ["FOO"] = f"{bar}.suffix"');
		expect(rewriteCellMagics("%env FOO=a$b-c")).toBe('__import__("os").environ["FOO"] = f"a{b}-c"');
	});

	it("keeps non-identifier braced forms in %env values literal", () => {
		const rewritten = rewriteCellMagics("%env FOO=$" + "{1abc}$x");
		expect(rewritten).toBe('__import__("os").environ["FOO"] = f"$' + '{{1abc}}{x}"');
		assertValidPython(rewritten);
	});

	it("escapes control characters in %env f-string values", () => {
		const rewritten = rewriteCellMagics("%env FOO=a\r$x");
		expect(rewritten).toBe('__import__("os").environ["FOO"] = f"a\\r{x}"');
		assertValidPython(rewritten);
		expect(rewriteCellMagics("%env FOO=a\tb$x")).toBe('__import__("os").environ["FOO"] = f"a\\tb{x}"');
	});

	it("translates $$ in %env values to a literal $", () => {
		expect(rewriteCellMagics("%env FOO=$$PATH")).toBe('__import__("os").environ["FOO"] = f"$PATH"');
	});

	it("escapes literal braces, quotes, and backslashes in expanded %env values", () => {
		expect(rewriteCellMagics("%env FOO=has{braces}$x")).toBe('__import__("os").environ["FOO"] = f"has{{braces}}{x}"');
		expect(rewriteCellMagics('%env FOO=say "hi"\\$x')).toBe(
			'__import__("os").environ["FOO"] = f"say \\"hi\\"\\\\{x}"',
		);
	});

	it("splits %env names on UTF-16 indices for non-BMP names", () => {
		expect(rewriteCellMagics("%env \u{1F40D}=x")).toBe('__import__("os").environ["\u{1F40D}"] = "x"');
	});

	it("rewrites %env NAME to an environ read", () => {
		expect(rewriteCellMagics("%env FOO")).toBe('print(__import__("os").environ["FOO"])');
	});

	it("rewrites bare %env to a credential-redacting environ listing", () => {
		const rewritten = rewriteCellMagics("%env");
		expect(rewritten).toBe(
			'print({k: ("[REDACTED]" if any(marker in k.lower() for marker in ("key", "token", "secret")) else v) for k, v in __import__("os").environ.items()})',
		);
		assertValidPython(rewritten);
	});

	it("rewrites magics only at column 0 and keeps other lines untouched", () => {
		const code = 'x = 1\n%cd /tmp\ny = "  %cd /other"\n    %cd indented';
		const rewritten = rewriteCellMagics(code);
		expect(rewritten).toContain('__import__("os").path.expanduser("/tmp")');
		expect(rewritten).toContain('y = "  %cd /other"');
		expect(rewritten).toContain("    %cd indented");
	});

	it("passes plain Python through untouched", () => {
		const code = "import os\nprint(os.getcwd())";
		expect(rewriteCellMagics(code)).toBe(code);
	});

	it("passes unknown magics through untouched", () => {
		expect(rewriteCellMagics("%timeit x = 1")).toBe("%timeit x = 1");
	});
});
