import { describe, expect, test } from "vitest";
import { parseNewSessionCommand } from "../src/core/new-session-command.js";
import { expandPromptTemplate, type PromptTemplate, substituteArgs } from "../src/core/prompt-templates.js";
import {
	BUILTIN_SLASH_COMMANDS,
	builtinSlashCommandTakesArgument,
	isBuiltinSlashCommandName,
	isSessionSlashCommandName,
	parseRefineCommandOptions,
	parseSessionSlashCommand,
	parseSlashCommand,
	resolveBuiltinSlashCommandName,
	resolveSlashCommand,
	SESSION_SLASH_COMMAND_NAMES,
} from "../src/core/slash-commands.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

describe("slash command aliases", () => {
	// [input, canonical name, args, alias used]
	test.each([
		["/rename my session", "name", "my session", "rename"],
		["/clear", "new", "", "clear"],
		["/thinking", "effort", "", "thinking"],
		["/usage latest turn", "context", "latest turn", "usage"],
		["/side Is this cached?", "btw", "Is this cached?", "side"],
	])("resolves %s to its canonical command while preserving arguments", (input, name, args, originalName) => {
		const parsed = parseSlashCommand(input);

		expect(parsed).toEqual({ name: originalName, args });
		expect(isBuiltinSlashCommandName(originalName)).toBe(true);
		expect(resolveBuiltinSlashCommandName(originalName)).toBe(name);
		expect(resolveSlashCommand(parsed!)).toEqual({ name, args, originalName, isAlias: true });
		// Aliases are reachable but never listed as their own command entry.
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === originalName)).toBeUndefined();
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === name)?.aliases).toContain(originalName);
	});

	test("carries the alias argument requirement over to the canonical command", () => {
		expect(builtinSlashCommandTakesArgument("side")).toBe(builtinSlashCommandTakesArgument("btw"));
		expect(builtinSlashCommandTakesArgument("thinking")).toBe(builtinSlashCommandTakesArgument("effort"));
		expect(builtinSlashCommandTakesArgument("clear")).toBe(false);
		expect(builtinSlashCommandTakesArgument("new")).toBe(true);
	});

	test("parses /new names, prompts, and option errors", () => {
		expect(parseSlashCommand("/new\n  multiline prompt")).toEqual({ name: "new", args: "multiline prompt" });
		expect(parseNewSessionCommand(" write a\n  multiline prompt  ")).toEqual({
			prompt: "write a\n  multiline prompt  ",
		});
		expect(parseNewSessionCommand(" --name stable")).toEqual({ name: "stable" });
		expect(parseNewSessionCommand(' --name "stable name" --  \n  --keep\nformat  ')).toEqual({
			name: "stable name",
			prompt: "  --keep\nformat  ",
		});
		expect(() => parseNewSessionCommand(" --name")).toThrow("Missing value");
		expect(() => parseNewSessionCommand(' --name "one" --name "two"')).toThrow("Duplicate");
		expect(() => parseNewSessionCommand(" --other value")).toThrow("Unknown /new option");
		expect(() => parseNewSessionCommand(' --name "broken')).toThrow("Unterminated quote");
	});
});

describe("session slash commands", () => {
	test("keeps the authoritative names and built-in execution metadata in sync", () => {
		expect(
			BUILTIN_SLASH_COMMANDS.filter((command) => command.execution === "session").map((command) => command.name),
		).toEqual([...SESSION_SLASH_COMMAND_NAMES]);
		for (const name of SESSION_SLASH_COMMAND_NAMES) expect(isSessionSlashCommandName(name)).toBe(true);
		expect(isSessionSlashCommandName("settings")).toBe(false);
	});

	test("splits at the first horizontal Unicode whitespace and preserves the raw text", () => {
		for (const text of ["/goal ship it", "/goal\tship it", "/goal\u00a0ship it", "/goal\u2003ship it"]) {
			expect(parseSlashCommand(text)).toEqual({ name: "goal", args: "ship it" });
			expect(parseSessionSlashCommand(text)).toEqual({ name: "goal", args: "ship it", text });
		}
		expect(parseSlashCommand("/goal\t  ship it  ")).toEqual({ name: "goal", args: "ship it" });
		for (const lineTerminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
			expect(parseSessionSlashCommand(`/goal${lineTerminator}ship it`)).toBeUndefined();
			expect(parseSessionSlashCommand(`/goal\t${lineTerminator}ship it`)).toBeUndefined();
			expect(parseSessionSlashCommand(`/autonomous\t${lineTerminator}on`)).toBeUndefined();
		}
	});

	test("parses refine rollback ids and --global placement without consuming instruction text", () => {
		expect(parseRefineCommandOptions("rollback refine_123")).toEqual({ rollbackId: "refine_123", global: false });
		expect(parseRefineCommandOptions("rollback refine_456 --global")).toEqual({
			rollbackId: "refine_456",
			global: true,
		});
		expect(parseRefineCommandOptions("--global rollback refine_789")).toEqual({
			rollbackId: "refine_789",
			global: true,
		});
		expect(parseRefineCommandOptions("--global focus on validation")).toEqual({
			instructions: "focus on validation",
			global: true,
		});
		expect(parseRefineCommandOptions("update docs to explain --global")).toEqual({
			instructions: "update docs to explain --global",
			global: false,
		});
		for (const args of ["rollback", "rollback --global"]) {
			expect(() => parseRefineCommandOptions(args)).toThrow("Usage: /refine rollback <refinement-id>");
		}
	});

	test("classifies only exact leading session-owned commands", () => {
		expect(parseSessionSlashCommand("/compact focus on tests")).toEqual({
			name: "compact",
			args: "focus on tests",
			text: "/compact focus on tests",
		});
		expect(parseSessionSlashCommand("/refine")).toEqual({ name: "refine", args: "", text: "/refine" });
		expect(parseSessionSlashCommand("/goal ship it")).toEqual({
			name: "goal",
			args: "ship it",
			text: "/goal ship it",
		});
		expect(parseSessionSlashCommand("/autonomous status")).toEqual({
			name: "autonomous",
			args: "status",
			text: "/autonomous status",
		});
		expect(parseSessionSlashCommand("/rlm-max-depth 3 --global")).toBeUndefined();
		expect(parseSessionSlashCommand("Explain /compact")).toBeUndefined();
		expect(parseSessionSlashCommand(" /compact")).toBeUndefined();
		expect(parseSessionSlashCommand("/compaction")).toBeUndefined();
		expect(parseSessionSlashCommand("/settings")).toBeUndefined();
	});
});

describe("ENG-6014 literal prompt arguments", () => {
	const explainTemplate: PromptTemplate = {
		name: "explain",
		description: "Explain the argument",
		content: "Explain: $ARGUMENTS",
		sourceInfo: createSyntheticSourceInfo("/tmp/explain.md", { source: "test" }),
		filePath: "/tmp/explain.md",
	};

	test.each(["$$", "$&", "$`", "$'", "$1", "$10", "$ARGUMENTS", "$@", `\${@:2}`, `\${@:1:2}`])(
		"preserves %s in every placeholder form",
		(literal) => {
			const args = [literal, "tail"];
			expect(substituteArgs("Before $1 after", args)).toBe(`Before ${literal} after`);
			expect(substituteArgs("Before $ARGUMENTS after", args)).toBe(`Before ${literal} tail after`);
			expect(substituteArgs("Before $@ after", args)).toBe(`Before ${literal} tail after`);
			expect(substituteArgs(`Before \${@:1} after`, args)).toBe(`Before ${literal} tail after`);
			expect(substituteArgs(`Before \${@:2:1} after`, ["head", literal, "tail"])).toBe(`Before ${literal} after`);
		},
	);

	test("does not expand placeholders formed across insertion boundaries", () => {
		expect(substituteArgs("$1ARGUMENTS|$1@|$1{@:2}", ["$", "tail"])).toBe(`$ARGUMENTS|$@|\${@:2}`);
	});

	test("expands mixed and repeated template placeholders without expanding inserted arguments", () => {
		expect(substituteArgs(`$1|$2|\${@:2:1}|$@|$ARGUMENTS|$1`, ["$@", `\${@:1}`, "$ARGUMENTS"])).toBe(
			`$@|\${@:1}|\${@:1}|$@ \${@:1} $ARGUMENTS|$@ \${@:1} $ARGUMENTS|$@`,
		);
	});

	test.each([
		{ input: "$$", expected: "Explain: $$" },
		{ input: "$&", expected: "Explain: $&" },
		{ input: "$@ tail", expected: "Explain: $@ tail" },
		{ input: '"$`"', expected: "Explain: $`" },
		{ input: '"$\'"', expected: "Explain: $'" },
		{ input: "ordinary text", expected: "Explain: ordinary text" },
	])("preserves $input through an expanded prompt template", ({ input, expected }) => {
		expect(expandPromptTemplate(`/explain ${input}`, [explainTemplate])).toBe(expected);
	});
});
