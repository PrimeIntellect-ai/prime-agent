import { describe, expect, it } from "vitest";
import { createSessionSearchText, matchesSearchText } from "../src/modes/agents-view/session-view-search.js";

describe("session view search", () => {
	it("matches fuzzy tokens, normalized phrases, and case-insensitive regexes", () => {
		const text = createSessionSearchText(["Release Planner", "/work/widget", "fixed the node\n  CVE"]);
		expect(matchesSearchText(text, "rls plnr")).toBe(true);
		expect(matchesSearchText(text, '"node cve"')).toBe(true);
		expect(matchesSearchText(text, "re:/WORK/\\w+")).toBe(true);
		expect(matchesSearchText(text, "re:(")).toBe(false);
	});

	it("rejects noisy fuzzy matches that only scatter across the corpus", () => {
		const text = createSessionSearchText(["Release Planner", "/work/widget", "fixed the node\n  CVE"]);
		expect(matchesSearchText(text, "planner")).toBe(true);
		expect(matchesSearchText(text, "rwfxce")).toBe(false);
	});
});
