import { describe, expect, test } from "vitest";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.js";

describe("applyEditsToNormalizedContent occurrence counting", () => {
	test("exact match is unique even if fuzzy normalization would collapse other occurrences", () => {
		// "it's" appears exactly once, but normalizing the smart quote in "it’s"
		// would make it look like a second occurrence.
		const content = "it’s here\nit's there\n";
		const result = applyEditsToNormalizedContent(content, [{ oldText: "it's", newText: "ITS" }], "file.txt");
		expect(result.newContent).toBe("it’s here\nITS there\n");
	});

	test("fuzzy match still counts occurrences in normalized space", () => {
		// oldText needs fuzzy matching (smart quotes in content) and normalizes
		// to two occurrences.
		const content = "it’s here\nit’s there\n";
		expect(() => applyEditsToNormalizedContent(content, [{ oldText: "it's", newText: "x" }], "file.txt")).toThrow(
			/must be unique/,
		);
	});

	test("genuinely duplicated exact text is rejected", () => {
		expect(() => applyEditsToNormalizedContent("a\nb\na\n", [{ oldText: "a", newText: "x" }], "file.txt")).toThrow(
			/must be unique/,
		);
	});
});
