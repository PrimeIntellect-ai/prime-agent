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

	it("rewrites %cd with a target directory", () => {
		expect(rewriteCellMagics("%cd /tmp/dir")).toBe('__import__("os").chdir("/tmp/dir")');
	});

	it("rewrites bare %cd to the home directory", () => {
		expect(rewriteCellMagics("%cd")).toBe('__import__("os").chdir(__import__("os").path.expanduser("~"))');
	});

	it("rewrites %env NAME=value to an environ assignment", () => {
		expect(rewriteCellMagics("%env FOO=bar baz")).toBe('__import__("os").environ["FOO"] = "bar baz"');
	});

	it("rewrites %env NAME to an environ read", () => {
		expect(rewriteCellMagics("%env FOO")).toBe('print(__import__("os").environ["FOO"])');
	});

	it("rewrites magics only at column 0 and keeps other lines untouched", () => {
		const code = 'x = 1\n%cd /tmp\ny = "  %cd /other"\n    %cd indented';
		const rewritten = rewriteCellMagics(code);
		expect(rewritten).toContain('__import__("os").chdir("/tmp")');
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
