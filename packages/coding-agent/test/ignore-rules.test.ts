import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIgnoreRules, createIgnoreMatcher } from "../src/core/ignore-rules.js";

describe("addIgnoreRules", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-ignore-rules-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const writeIgnoreFile = (dir: string, content: string, fileName = ".gitignore") => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, fileName), content);
	};
	const matcherFor = (...dirs: string[]) => {
		const ig = createIgnoreMatcher();
		for (const dir of dirs) addIgnoreRules(ig, dir, root);
		return ig;
	};

	it.each([
		{ name: "an empty ignore file", content: "" },
		{ name: "a file of comments and blank lines", content: "# a comment\n\n   \n\t\n" },
	])("ignores nothing for $name", ({ content }) => {
		writeIgnoreFile(root, content);
		const ig = matcherFor(root);
		expect(ig.ignores("kept.ts")).toBe(false);
		expect(ig.ignores("nested/deep.ts")).toBe(false);
	});

	it("treats a backslash-escaped hash as a literal file name", () => {
		writeIgnoreFile(root, "\\#secret.ts\n");
		const ig = matcherFor(root);
		expect(ig.ignores("#secret.ts")).toBe(true);
		expect(ig.ignores("secret.ts")).toBe(false);
	});

	it.each([".gitignore", ".ignore", ".fdignore"])("reads %s", (fileName) => {
		writeIgnoreFile(root, "skipped.ts\n", fileName);
		expect(matcherFor(root).ignores("skipped.ts")).toBe(true);
	});

	it("applies a negation rule after a broader pattern", () => {
		writeIgnoreFile(root, "*.ts\n!kept.ts\n");
		const ig = matcherFor(root);
		expect(ig.ignores("dropped.ts")).toBe(true);
		expect(ig.ignores("kept.ts")).toBe(false);
	});

	it("scopes a nested ignore file to its own directory", () => {
		writeIgnoreFile(join(root, "nested"), "*.ts\n");
		const ig = matcherFor(root, join(root, "nested"));
		expect(ig.ignores("nested/skip.ts")).toBe(true);
		expect(ig.ignores("top.ts")).toBe(false);
	});

	it("scopes a nested negation to the same directory", () => {
		writeIgnoreFile(join(root, "nested"), "*.ts\n!kept.ts\n");
		const ig = matcherFor(join(root, "nested"));
		expect(ig.ignores("nested/skip.ts")).toBe(true);
		expect(ig.ignores("nested/kept.ts")).toBe(false);
		expect(ig.ignores("top.ts")).toBe(false);
	});
});
