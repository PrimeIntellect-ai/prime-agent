/**
 * Prompt template argument parsing, placeholder substitution, and frontmatter loading.
 */

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, test } from "vitest";
import { getAgentDir } from "../src/config.js";
import { loadPromptTemplates, parseCommandArgs, substituteArgs } from "../src/core/prompt-templates.js";

describe("substituteArgs", () => {
	test.each([
		["Test: $ARGUMENTS", ["a", "b", "c"], "Test: a b c"],
		["Test: $@", ["a", "b", "c"], "Test: a b c"],
		["Test: $ARGUMENTS", [], "Test: "],
		["$1: $@ ($ARGUMENTS)", ["first", "second"], "first: first second (first second)"],
		["$1 $2 $3 $4 $5", ["a", "b"], "a b   "],
		["$0", ["a", "b"], ""],
		["$10 $12 $15", Array.from({ length: 15 }, (_, i) => `val${i}`), "val9 val11 val14"],
		["pre$ARGUMENTS", ["a", "b"], "prea b"],
		["$A $$ $ $ARGS", ["a"], "$A $$ $ $ARGS"],
		["$arguments $Arguments $ARGUMENTS", ["a", "b"], "$arguments $Arguments a b"],
		["$1 $2", ["line1\nline2", "tab\tthere"], "line1\nline2 tab\tthere"],
		["$ARGUMENTS", ["日本語", "🎉", "café"], "日本語 🎉 café"],
		["$ARGUMENTS", ["a", "", "c"], "a  c"],
		[`\${@:2}`, ["a", "b", "c", "d"], "b c d"],
		[`\${@:0}`, ["a", "b", "c"], "a b c"],
		[`\${@:2:2}`, ["a", "b", "c", "d"], "b c"],
		[`\${@:2:0}`, ["a", "b", "c"], ""],
		[`\${@:2:99}`, ["a", "b", "c"], "b c"],
		[`\${@:99}`, ["a", "b"], ""],
		[`\${@:2}`, [], ""],
		[`prefix\${@:2}suffix`, ["a", "b", "c"], "prefixb csuffix"],
		[`$1: \${@:2} vs $@`, ["cmd", "arg1", "arg2"], "cmd: arg1 arg2 vs cmd arg1 arg2"],
		[`\${@:1:1} and \${@:2}`, ["a", "b", "c"], "a and b c"],
	])("substitutes %j", (template, args, expected) => {
		expect(substituteArgs(template, args)).toBe(expected);
	});

	// CRITICAL: placeholder-looking text inside argument values must stay literal.
	test("does not recursively substitute patterns in argument values", () => {
		expect(substituteArgs("$ARGUMENTS", ["$1", "$ARGUMENTS"])).toBe("$1 $ARGUMENTS");
		expect(substituteArgs("$@", ["$100", "$1"])).toBe("$100 $1");
		expect(substituteArgs(`\${@:1}`, [`\${@:2}`, "test"])).toBe(`\${@:2} test`);
		expect(substituteArgs(`\${@:2}`, ["a", `\${@:3}`, "c"])).toBe(`\${@:3} c`);
	});
});

describe("parseCommandArgs", () => {
	test.each<[string, string[]]>([
		["a b c", ["a", "b", "c"]],
		["", []],
		["   a  b   c   ", ["a", "b", "c"]],
		['"first arg" second', ["first arg", "second"]],
		["'first arg' second", ["first arg", "second"]],
		['"double" \'single\' "double again"', ["double", "single", "double again"]],
		["a\tb\tc", ["a", "b", "c"]],
		["first\u2002second", ["first", "second"]],
		// An intentionally quoted "" is an argument (e.g. /mcp add ... -- cmd "").
		['"" " "', ["", " "]],
		['add local -- command ""', ["add", "local", "--", "command", ""]],
		["$100 @user #tag", ["$100", "@user", "#tag"]],
		["日本語 🎉 café", ["日本語", "🎉", "café"]],
		['"line1\nline2" second', ["line1\nline2", "second"]],
		// No escape mechanism exists - backslash is literal.
		['"quoted \\"text\\""', ["quoted \\text\\"]],
	])("parses %j", (input, expected) => {
		expect(parseCommandArgs(input)).toEqual(expected);
	});

	test("parsing feeds substitution", () => {
		const args = parseCommandArgs('Button "onClick handler" "disabled support"');
		expect(substituteArgs("Create component $1 with features: $ARGUMENTS", args)).toBe(
			"Create component Button with features: Button onClick handler disabled support",
		);
	});
});

describe("loadPromptTemplates - argument-hint", () => {
	const testDir = join(tmpdir(), `pi-test-prompts-${Date.now()}`);

	afterAll(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test.each<[string, string, string | undefined, string]>([
		["pr", 'description: Review PRs\nargument-hint: "<PR-URL>"', "<PR-URL>", "Review PRs"],
		["wr", 'description: Wrap up\nargument-hint: "[instructions]"', "[instructions]", "Wrap up"],
		["cl", "description: Audit changelog", undefined, "Audit changelog"],
		["empty-hint", 'description: Empty hint\nargument-hint: ""', undefined, "Empty hint"],
		// Non-string frontmatter metadata falls back to the template body.
		["invalid", "description:\n  - not\n  - a string\nargument-hint: [temporary-value]", undefined, "Body line"],
	])("reads %s frontmatter", (name, frontmatter, argumentHint, description) => {
		mkdirSync(testDir, { recursive: true });
		writeFileSync(join(testDir, `${name}.md`), `---\n${frontmatter}\n---\nBody line`);

		const templates = loadPromptTemplates({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			promptPaths: [testDir],
			includeDefaults: false,
		});

		const template = templates.find((entry) => entry.name === name);
		expect(template).toBeDefined();
		expect(template!.argumentHint).toBe(argumentHint);
		expect(template!.description).toBe(description);
	});
});
