import { describe, expect, it } from "vitest";
import { magicRejection } from "../src/core/tools/ipython-cell-code.js";

describe("magicRejection", () => {
	it("rejects a %%bash cell with the bash() teaching message", () => {
		expect(magicRejection("%%bash\necho hi")).toBe(
			"%%bash cells are not supported; use bash('cmd') / await bash('cmd')",
		);
	});

	it("rejects other %% cell magics", () => {
		expect(magicRejection("%%timeit\nx = 1")).toBe("%% cell magics are not supported; this is a plain Python REPL");
	});

	it("rejects %cd with the os.chdir teaching message", () => {
		expect(magicRejection("%cd /tmp/dir")).toBe("%cd is not supported; use os.chdir(...)");
	});

	it("rejects %env with the os.environ teaching message", () => {
		expect(magicRejection("%env FOO=bar")).toBe("%env is not supported; use os.environ[...]");
	});

	it("rejects other % line magics", () => {
		expect(magicRejection("%timeit x = 1")).toBe("% line magics are not supported; this is a plain Python REPL");
	});

	it("rejects ! shell escapes with the bash() teaching message", () => {
		expect(magicRejection("!ls -la")).toBe("! shell escapes are not supported; use bash('cmd') / await bash('cmd')");
	});

	it("tolerates leading blank lines before the magic", () => {
		expect(magicRejection("\n\n  \n%%bash\necho hi")).toBe(
			"%%bash cells are not supported; use bash('cmd') / await bash('cmd')",
		);
	});

	it("passes through plain Python", () => {
		expect(magicRejection("x = 1\nprint(x)")).toBeUndefined();
	});

	it("passes through mid-cell % (modulo) and !=", () => {
		expect(magicRejection("x = 7 % 3")).toBeUndefined();
		expect(magicRejection("if x != 1:\n    print(x)")).toBeUndefined();
	});

	it("passes through an empty cell", () => {
		expect(magicRejection("")).toBeUndefined();
		expect(magicRejection("\n  \n")).toBeUndefined();
	});
});
