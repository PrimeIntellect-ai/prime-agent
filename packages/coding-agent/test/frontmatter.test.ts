import { describe, expect, it } from "vitest";
import { parseFrontmatter, stripFrontmatter } from "../src/utils/frontmatter.js";

describe("parseFrontmatter", () => {
	it.each([
		["plain", "---\nname: test\n---\n\nBody text", { name: "test" }, "Body text"],
		["a UTF-8 BOM", "\uFEFF---\nname: test\n---\nBody text", { name: "test" }, "Body text"],
		["CRLF newlines", "---\r\nname: test\r\n---\r\nBody\r\ntext", { name: "test" }, "Body\ntext"],
		["a BOM and CRLF", "\uFEFF---\r\nname: test\r\n---\r\nBody text", { name: "test" }, "Body text"],
		[
			"quoted and hyphenated keys",
			"---\nname: \"test\"\ndescription: 'A desc'\nfoo-bar: value\n---\nBody text",
			{ name: "test", description: "A desc", "foo-bar": "value" },
			"Body text",
		],
		[
			"a | multiline block",
			"---\ndescription: |\n  Line one\n  Line two\n---\nBody text",
			{ description: "Line one\nLine two\n" },
			"Body text",
		],
		["comment-only frontmatter", "---\n# just a comment\n---\nBody text", {}, "Body text"],
		["a BOM but no frontmatter", "\uFEFFBody text", {}, "Body text"],
		["no frontmatter", "Body text\nsecond line", {}, "Body text\nsecond line"],
		["unterminated frontmatter", "---\nname: test\nBody text", {}, "---\nname: test\nBody text"],
	])("parses %s", (_label, input, frontmatter, body) => {
		const result = parseFrontmatter<Record<string, string>>(input);
		expect(result.frontmatter).toEqual(frontmatter);
		expect(result.body).toBe(body);
	});

	it("throws on invalid YAML frontmatter", () => {
		expect(() => parseFrontmatter("---\nfoo: [bar\n---\nBody")).toThrow(/at line 1, column 10/);
	});
});

describe("stripFrontmatter", () => {
	it("removes frontmatter and trims the body", () => {
		expect(stripFrontmatter("---\nkey: value\n---\n\nBody\n")).toBe("Body");
	});

	it("leaves content without frontmatter untouched", () => {
		expect(stripFrontmatter("\n  No frontmatter body  \n")).toBe("\n  No frontmatter body  \n");
	});
});
