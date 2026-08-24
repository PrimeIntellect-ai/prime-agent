import { describe, expect, it } from "vitest";
import { rewriteCellMagics } from "../src/core/tools/ipython-cell-code.js";

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

	it("rewrites %cd with a target directory and tracks the previous cwd", () => {
		expect(rewriteCellMagics("%cd /tmp/dir")).toBe(
			'_prime_agent_prev_cd = __import__("os").getcwd(); __import__("os").chdir(__import__("os").path.expanduser("/tmp/dir"))',
		);
	});

	it("rewrites bare %cd to the home directory", () => {
		expect(rewriteCellMagics("%cd")).toBe(
			'_prime_agent_prev_cd = __import__("os").getcwd(); __import__("os").chdir(__import__("os").path.expanduser("~"))',
		);
	});

	it("expands ~ in %cd targets", () => {
		expect(rewriteCellMagics("%cd ~/projects")).toContain('__import__("os").path.expanduser("~/projects")');
	});

	it("rewrites %cd - to the previous directory with a helpful error", () => {
		const rewritten = rewriteCellMagics("%cd -");
		expect(rewritten).toContain('globals().get("_prime_agent_prev_cd")');
		expect(rewritten).toContain('raise RuntimeError("No previous directory to change to")');
		expect(rewritten).toContain('__import__("os").chdir(_prime_agent_cd_target)');
	});

	it("rewrites %cd with a tab separator and tolerates a trailing carriage return", () => {
		expect(rewriteCellMagics("%cd\t/tmp")).toContain('__import__("os").path.expanduser("/tmp")');
		expect(rewriteCellMagics("%cd /tmp\r")).toContain('__import__("os").path.expanduser("/tmp")');
	});

	it("rewrites bare %cd and bare %env on CRLF lines", () => {
		expect(rewriteCellMagics("%cd\r\n")).toContain('__import__("os").path.expanduser("~")');
		expect(rewriteCellMagics("%env\r\n")).toContain('print(dict(__import__("os").environ))');
	});

	it("rewrites %env NAME=value to an environ assignment", () => {
		expect(rewriteCellMagics("%env FOO=bar baz")).toBe('__import__("os").environ["FOO"] = "bar baz"');
	});

	it("rewrites %env NAME value (space-separated) to an environ assignment", () => {
		expect(rewriteCellMagics("%env FOO bar")).toBe('__import__("os").environ["FOO"] = "bar"');
	});

	it("expands $var values in %env assignments from Python variables", () => {
		expect(rewriteCellMagics("%env FOO=$bar")).toBe('__import__("os").environ["FOO"] = str(bar)');
	});

	it("rewrites %env NAME to an environ read", () => {
		expect(rewriteCellMagics("%env FOO")).toBe('print(__import__("os").environ["FOO"])');
	});

	it("rewrites bare %env to an environ listing", () => {
		expect(rewriteCellMagics("%env")).toBe('print(dict(__import__("os").environ))');
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
