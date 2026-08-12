import assert from "node:assert";
import { describe, it } from "node:test";
import { hyperlinkAtColumn, urlAtColumn } from "../src/utils.js";

const ST = "\x1b\\";

function link(url: string, text: string, terminator = ST): string {
	return `\x1b]8;;${url}${terminator}${text}\x1b]8;;${terminator}`;
}

describe("hyperlinkAtColumn", () => {
	it("returns the URL for columns inside the link and null outside", () => {
		const line = `see ${link("https://example.com/docs", "docs")} here`;
		assert.strictEqual(hyperlinkAtColumn(line, 0), null);
		assert.strictEqual(hyperlinkAtColumn(line, 3), null);
		assert.strictEqual(hyperlinkAtColumn(line, 4), "https://example.com/docs");
		assert.strictEqual(hyperlinkAtColumn(line, 7), "https://example.com/docs");
		assert.strictEqual(hyperlinkAtColumn(line, 8), null);
	});

	it("supports BEL-terminated links", () => {
		const line = link("https://example.com/login", "https://example.com/login", "\x07");
		assert.strictEqual(hyperlinkAtColumn(line, 0), "https://example.com/login");
		assert.strictEqual(hyperlinkAtColumn(line, 24), "https://example.com/login");
		assert.strictEqual(hyperlinkAtColumn(line, 25), null);
	});

	it("tracks multiple links on one line", () => {
		const line = `${link("https://a.example", "aa")} ${link("https://b.example", "bb")}`;
		assert.strictEqual(hyperlinkAtColumn(line, 1), "https://a.example");
		assert.strictEqual(hyperlinkAtColumn(line, 2), null);
		assert.strictEqual(hyperlinkAtColumn(line, 3), "https://b.example");
	});

	it("detects bare http URLs when OSC 8 metadata is absent", () => {
		const line = "visit https://example.com/docs, then continue";
		assert.strictEqual(urlAtColumn(line, 6), "https://example.com/docs");
		assert.strictEqual(urlAtColumn(line, 29), "https://example.com/docs");
		assert.strictEqual(urlAtColumn(line, 30), null);
	});

	it("does not include trailing prose punctuation in bare URLs", () => {
		const line = "open (https://example.com/path).";
		assert.strictEqual(urlAtColumn(line, 7), "https://example.com/path");
		assert.strictEqual(urlAtColumn(line, 30), null);
	});

	it("prefers an OSC 8 target over a URL-like label", () => {
		const line = link("https://target.example", "https://label.example");
		assert.strictEqual(urlAtColumn(line, 10), "https://target.example");
	});

	it("resolves a link after its painted tab expansion", () => {
		const line = `   ${link("https://example.com", "docs")}`;
		assert.strictEqual(hyperlinkAtColumn(line, 2), null);
		assert.strictEqual(hyperlinkAtColumn(line, 3), "https://example.com");
		assert.strictEqual(hyperlinkAtColumn(line, 6), "https://example.com");
	});

	it("counts wide graphemes as two columns", () => {
		const line = `\u4f60\u597d ${link("https://example.com", "docs")}`;
		assert.strictEqual(hyperlinkAtColumn(line, 4), null);
		assert.strictEqual(hyperlinkAtColumn(line, 5), "https://example.com");
	});

	it("ignores SGR styling inside the link", () => {
		const line = `x ${link("https://example.com", "\x1b[36mdocs\x1b[39m")}`;
		assert.strictEqual(hyperlinkAtColumn(line, 3), "https://example.com");
	});

	it("returns null past the end of the line and for negative columns", () => {
		const line = link("https://example.com", "docs");
		assert.strictEqual(hyperlinkAtColumn(line, 4), null);
		assert.strictEqual(hyperlinkAtColumn(line, 100), null);
		assert.strictEqual(hyperlinkAtColumn(line, -1), null);
	});
});
