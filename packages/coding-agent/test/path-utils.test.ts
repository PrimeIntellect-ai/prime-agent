import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandTildePath } from "../src/config.js";
import { expandPath, resolveReadPath, resolveToCwd } from "../src/core/tools/path-utils.js";

describe("path-utils", () => {
	it.each<[string, typeof expandPath]>([
		["expandPath", expandPath],
		["expandTildePath", expandTildePath],
	])("%s expands tildes with the platform separator", (_name, expand) => {
		const home = homedir();
		const backslashInput = "~\\Documents\\file.txt";

		expect(expand("~/docs/file.txt", "win32")).toBe(win32.join(home, "docs", "file.txt"));
		expect(expand("~/docs/file.txt", "linux")).toBe(posix.join(home, "docs/file.txt"));
		// A backslash tilde prefix is a Windows-only spelling; POSIX keeps it verbatim.
		expect(expand(backslashInput, "win32")).toBe(win32.join(home, "Documents", "file.txt"));
		expect(expand(backslashInput, "linux")).toBe(backslashInput);
		expect(expand("~/Documents\\file.txt", "darwin")).toBe(posix.join(home, "Documents\\file.txt"));
	});

	it("resolves relative paths against the cwd and leaves absolute paths alone", () => {
		expect(resolveToCwd("/absolute/path/file.txt", "/some/cwd")).toBe("/absolute/path/file.txt");
		expect(resolveToCwd("relative/file.txt", "/some/cwd")).toBe(resolve("/some/cwd", "relative/file.txt"));
	});

	describe("resolveReadPath", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "path-utils-test-"));
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		// macOS stores decomposed (NFD) filenames and curly apostrophes while users type
		// composed (NFC) names with straight quotes; resolveReadPath bridges both.
		it.each<[string, string, string]>([
			["an exact name", "test-file.txt", "test-file.txt"],
			["an NFD name requested as NFC", "file\u0065\u0301.txt", "file\u00e9.txt"],
			["a curly apostrophe requested straight", "Capture d\u2019cran.txt", "Capture d'cran.txt"],
			["a French screenshot name", "Capture d\u2019\u00e9cran.txt", "Capture d'\u00e9cran.txt"],
		])("resolves %s", (_name, onDisk, requested) => {
			writeFileSync(join(tempDir, onDisk), "content");

			const result = resolveReadPath(requested, tempDir);

			expect(result.startsWith(tempDir)).toBe(true);
			expect(readFileSync(result, "utf-8")).toBe("content");
			expect(readdirSync(tempDir)).toHaveLength(1);
		});

		it("normalizes Unicode spaces in expanded paths", () => {
			expect(expandPath("file\u00A0name.txt")).toBe("file name.txt");
		});
	});
});
