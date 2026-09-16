import { describe, expect, it } from "vitest";
import { parseIpythonBashCell } from "../../../src/core/tools/ipython-cell-code.js";

/** `%%bash` is a kernel input contract: the cell magic may be preceded by blank lines and CRLF. */
describe("ENG-4529 leading newline before %%bash", () => {
	it.each([
		{
			name: "blank lines, indentation, arguments, and CRLF",
			code: " \r\n\t\r\n  %%bash --noprofile\r\necho ok",
			expected: { body: "echo ok" },
		},
		{ name: "a plain leading newline", code: "\n%%bash\ncd /tmp", expected: { body: "cd /tmp" } },
		{ name: "a multi-line body", code: "\n\n%%bash\ncd /tmp\necho done", expected: { body: "cd /tmp\necho done" } },
		{ name: "a python cell", code: "\nprint('python')", expected: undefined },
		{ name: "a cell that only mentions the magic later", code: "print('x')\n%%bash\necho no", expected: undefined },
	])("parses $name", ({ code, expected }) => {
		expect(parseIpythonBashCell(code)).toEqual(expected);
	});
});
