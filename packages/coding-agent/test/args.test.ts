import { describe, expect, test } from "vitest";
import { type Args, INTERNAL_RUNTIME_COMMAND_MARKER, parseArgs } from "../src/cli/args.js";

type Expected = Partial<Omit<Args, "unknownFlags" | "diagnostics">>;

const FRONTMATTER = "---\ntitle: hello\n---\nSay hi.";

/** argv -> parsed fields, for inputs that must produce no diagnostics. */
const parseCases: Array<[string, string[], Expected]> = [
	["--version", ["--version"], { version: true }],
	["-v", ["-v"], { version: true }],
	[
		"--version does not suppress later args",
		["--version", "--help", "x"],
		{ version: true, help: true, messages: ["x"] },
	],
	["--help", ["--help"], { help: true }],
	["-h", ["-h"], { help: true }],
	["--print", ["--print"], { print: true }],
	["-p", ["-p"], { print: true }],
	["-p keeps a frontmatter prompt positional", ["-p", FRONTMATTER], { print: true, messages: [FRONTMATTER] }],
	[
		"-p does not swallow later options",
		["-p", "--provider", "openai", "hi"],
		{ print: true, provider: "openai", messages: ["hi"] },
	],
	["--continue", ["--continue"], { continue: true }],
	["-c", ["-c"], { continue: true }],
	["bare --resume", ["--resume"], { resume: true }],
	["bare -r", ["-r"], { resume: true }],
	[
		"--resume with a session path",
		["--resume", "/path/to/session.jsonl"],
		{ resume: "/path/to/session.jsonl", messages: [] },
	],
	[
		"--resume with a windows session path",
		["--resume", "C:\\Users\\me\\session.jsonl"],
		{ resume: "C:\\Users\\me\\session.jsonl", messages: [] },
	],
	[
		"--resume with a relative session path",
		["--resume", "sessions/current"],
		{ resume: "sessions/current", messages: [] },
	],
	["-r with a session id", ["-r", "1234abcd"], { resume: "1234abcd", messages: [] }],
	["--resume=value", ["--resume=1234abcd"], { resume: "1234abcd", messages: [] }],
	[
		"--resume value is an authoritative selector",
		["--resume", "fix", "the", "bug"],
		{ resume: "fix", messages: ["the", "bug"] },
	],
	[
		"--resume -- keeps the picker and a prompt",
		["--resume", "--", "continue", "it"],
		{ resume: true, messages: ["continue", "it"] },
	],
	["empty --resume value is the picker", ["--resume", ""], { resume: true, messages: [] }],
	["empty --resume= value is the picker", ["--resume="], { resume: true, messages: [] }],
	["--cwd", ["--cwd", "/tmp/project"], { cwd: "/tmp/project" }],
	["--provider", ["--provider", "openai"], { provider: "openai" }],
	["--model", ["--model", "gpt-4o"], { model: "gpt-4o" }],
	["--api-key", ["--api-key", "sk-test-key"], { apiKey: "sk-test-key" }],
	["--system-prompt", ["--system-prompt", "be helpful"], { systemPrompt: "be helpful" }],
	[
		"--system-prompt accepts a dash-leading value",
		["--system-prompt", "- only JSON"],
		{ systemPrompt: "- only JSON" },
	],
	["--system-prompt accepts frontmatter", ["--system-prompt", FRONTMATTER], { systemPrompt: FRONTMATTER }],
	// Prompt text is arbitrary: a short-option-looking value is still the value.
	["--system-prompt accepts a short-option-looking value", ["--system-prompt", "-x"], { systemPrompt: "-x" }],
	["--append-system-prompt", ["--append-system-prompt", "A"], { appendSystemPrompt: ["A"] }],
	[
		"repeated --append-system-prompt",
		["--append-system-prompt", "A", "--append-system-prompt", "B"],
		{ appendSystemPrompt: ["A", "B"] },
	],
	[
		"--append-system-prompt accepts frontmatter",
		["--append-system-prompt", FRONTMATTER],
		{ appendSystemPrompt: [FRONTMATTER] },
	],
	["--mode json", ["--mode", "json"], { mode: "json" }],
	["--mode rpc", ["--mode", "rpc"], { mode: "rpc" }],
	["--fork", ["--fork", "1234abcd"], { fork: "1234abcd", messages: [] }],
	["--thinking", ["--thinking", "high"], { thinking: "high" }],
	["--models is comma separated", ["--models", "gpt-4o,claude-sonnet"], { models: ["gpt-4o", "claude-sonnet"] }],
	["--no-session", ["--no-session"], { noSession: true }],
	["--extension", ["--extension", "./a.ts"], { extensions: ["./a.ts"] }],
	["-e", ["-e", "./a.ts"], { extensions: ["./a.ts"] }],
	["repeated extension flags", ["--extension", "./a.ts", "-e", "./b.ts"], { extensions: ["./a.ts", "./b.ts"] }],
	[
		"--no-extensions keeps explicit -e",
		["--no-extensions", "-e", "a.ts"],
		{ noExtensions: true, extensions: ["a.ts"] },
	],
	["--skill", ["--skill", "./s"], { skills: ["./s"] }],
	["repeated --skill", ["--skill", "./a", "--skill", "./b"], { skills: ["./a", "./b"] }],
	[
		"--prompt-template",
		["--prompt-template", "./one", "--prompt-template", "./two"],
		{ promptTemplates: ["./one", "./two"] },
	],
	["--theme", ["--theme", "./dark.json", "--theme", "./light.json"], { themes: ["./dark.json", "./light.json"] }],
	["--no-skills", ["--no-skills"], { noSkills: true }],
	["--no-prompt-templates", ["--no-prompt-templates"], { noPromptTemplates: true }],
	["--no-themes", ["--no-themes"], { noThemes: true }],
	["--no-context-files", ["--no-context-files"], { noContextFiles: true }],
	["-nc", ["-nc"], { noContextFiles: true }],
	["--verbose", ["--verbose"], { verbose: true }],
	["--offline", ["--offline"], { offline: true }],
	["--no-tools", ["--no-tools"], { noTools: true }],
	["-nt", ["-nt"], { noTools: true }],
	["--no-builtin-tools", ["--no-builtin-tools"], { noBuiltinTools: true }],
	["-nbt", ["-nbt"], { noBuiltinTools: true }],
	["--tools", ["--tools", "ipython,dynamic_tool"], { tools: ["ipython", "dynamic_tool"] }],
	["-t", ["-t", "ipython,dynamic_tool"], { tools: ["ipython", "dynamic_tool"] }],
	["--no-tools keeps explicit --tools", ["--no-tools", "--tools", "ipython"], { noTools: true, tools: ["ipython"] }],
	["--autonomous", ["--autonomous"], { autonomous: true }],
	[
		"autonomous gate flags",
		[
			"--autonomous",
			"--autonomous-gate",
			"npm test",
			"--autonomous-gate",
			"npm run lint",
			"--autonomous-gate-retries",
			"2",
			"--autonomous-gate-timeout-ms",
			"1000",
		],
		{
			autonomous: true,
			autonomousGates: ["npm test", "npm run lint"],
			autonomousGateRetries: 2,
			autonomousGateTimeoutMs: 1000,
		},
	],
	[
		"autonomous limit flags",
		[
			"--autonomous",
			"--autonomous-max-continuations",
			"20",
			"--autonomous-max-turns",
			"80",
			"--autonomous-max-tokens",
			"500000",
			"--autonomous-timeout-ms",
			"1800000",
		],
		{
			autonomous: true,
			autonomousMaxContinuations: 20,
			autonomousMaxTurns: 80,
			autonomousMaxTokens: 500000,
			autonomousTimeoutMs: 1800000,
		},
	],
	[
		"autonomous sub-options auto-enable autonomous mode",
		["--autonomous-max-turns", "1", "--autonomous-gate", "npm test"],
		{ autonomous: true, autonomousMaxTurns: 1, autonomousGates: ["npm test"] },
	],
	[
		"a gate command may start with an unknown short flag",
		["--autonomous-gate", "-x npm test"],
		{ autonomousGates: ["-x npm test"] },
	],
	["--goal", ["--goal", "Write a paper"], { goal: "Write a paper" }],
	["--goal accepts a dash-prefixed objective", ["--goal", "-p"], { goal: "-p", print: undefined }],
	[
		"--goal with --goal-token-budget",
		["--goal", "g", "--goal-token-budget", "50000"],
		{ goal: "g", goalTokenBudget: 50000 },
	],
	[
		"session export needs the internal marker",
		[INTERNAL_RUNTIME_COMMAND_MARKER, "--export", "s.jsonl"],
		{ export: "s.jsonl" },
	],
	[
		"model list needs the internal marker",
		[INTERNAL_RUNTIME_COMMAND_MARKER, "--list-models", "sonnet"],
		{ listModels: "sonnet" },
	],
	["plain messages", ["hello", "world"], { messages: ["hello", "world"] }],
	["@file arguments", ["@README.md", "@src/main.ts"], { fileArgs: ["README.md", "src/main.ts"] }],
	[
		"mixed messages and file args",
		["@f.txt", "explain", "@i.png"],
		{ fileArgs: ["f.txt", "i.png"], messages: ["explain"] },
	],
	[
		"many flags together",
		["--provider", "anthropic", "--model", "claude-sonnet", "--print", "--thinking", "high", "@prompt.md", "Do it"],
		{
			provider: "anthropic",
			model: "claude-sonnet",
			print: true,
			thinking: "high",
			fileArgs: ["prompt.md"],
			messages: ["Do it"],
		},
	],
	["-- keeps a dash-leading prompt positional", ["--", "- weights.pt ..."], { messages: ["- weights.pt ..."] }],
	[
		"-- stops option parsing",
		["--", "--provider", "openai"],
		{ provider: undefined, messages: ["--provider", "openai"] },
	],
	[
		"flags before -- still parse",
		["--provider", "openai", "--", "-p", "@file"],
		{ provider: "openai", print: undefined, fileArgs: [], messages: ["-p", "@file"] },
	],
	["a lone --", ["--"], { messages: [] }],
	[
		"--values are consumed when present",
		["--model", "claude-sonnet-4-5", "--fork", "abc"],
		{ model: "claude-sonnet-4-5", fork: "abc" },
	],
];

/** argv -> one diagnostic the parser must report as a hard error. */
const errorCases: Array<[string, string[], string]> = [
	[
		"--export was removed",
		["--export", "session.jsonl"],
		'--export was removed. Use "prime-agent session export <file> [output]".',
	],
	[
		"--list-models was removed",
		["--list-models", "sonnet"],
		'--list-models was removed. Use "prime-agent model list [search]".',
	],
	[
		"invalid thinking level",
		["--thinking", "hig"],
		'Invalid thinking level "hig". Valid values: off, minimal, low, medium, high, xhigh, max',
	],
	[
		"invalid --mode",
		["--mode", "interactive"],
		'Invalid --mode "interactive". Valid values: text, json, rpc, acp, daemon',
	],
	[
		"removed built-in tools",
		["--tools", "read,bash,edit"],
		"Unknown built-in tool(s): read. Available built-in tools: ipython",
	],
	["a dash-leading prompt without --", ["- do the thing"], "Unknown option: - do the thing"],
	["--model without a value", ["--model"], "--model requires a value"],
	["--model followed by a long flag", ["--model", "--provider", "anthropic"], "--model requires a value"],
	["--model followed by a short flag", ["--model", "-t", "ipython"], "--model requires a value"],
	["--thinking followed by a short flag", ["--thinking", "-x"], "--thinking requires a value"],
	["--theme without a value", ["--theme"], "--theme requires a value"],
	["--system-prompt does not eat --", ["--system-prompt", "--", "--model", "foo"], "--system-prompt requires a value"],
	[
		"--append-system-prompt does not eat --",
		["--append-system-prompt", "--", "run"],
		"--append-system-prompt requires a value",
	],
	["--goal followed by a long flag", ["--goal", "--verbose"], "--goal requires a value"],
	["--goal without a value", ["--goal"], "--goal requires a value"],
	["empty --goal objective", ["--goal", "  "], "--goal requires a non-empty objective"],
	[
		"--autonomous-gate rejects a long-option value",
		["--autonomous-gate", "---run"],
		"--autonomous-gate requires a value",
	],
	[
		"--autonomous-gate does not eat another autonomous flag",
		["--autonomous-gate", "--autonomous-max-turns", "3"],
		"--autonomous-gate requires a value",
	],
	["--goal-token-budget without --goal", ["--goal-token-budget", "50000"], "--goal-token-budget requires --goal"],
	["non-positive --goal-token-budget", ["--goal-token-budget", "0"], "--goal-token-budget must be a positive integer"],
	["--goal-token-budget without a value", ["--goal-token-budget"], "--goal-token-budget requires a value"],
];

const VALUE_FLAGS = ["--provider", "--api-key", "--cwd", "--fork", "--session-dir", "--models", "--daemon-socket"];
const AUTONOMOUS_VALUE_FLAGS = [
	"--autonomous-gate",
	"--autonomous-gate-retries",
	"--autonomous-gate-timeout-ms",
	"--autonomous-max-continuations",
	"--autonomous-max-turns",
	"--autonomous-max-tokens",
	"--autonomous-timeout-ms",
];

describe("parseArgs", () => {
	test.each(parseCases)("parses %s", (_label, argv, expected) => {
		const result = parseArgs(argv);
		// An expected `undefined` means the flag must stay unset.
		for (const [field, value] of Object.entries(expected) as Array<[keyof Args, unknown]>) {
			expect(result[field], field).toEqual(value);
		}
		expect(result.diagnostics).toEqual([]);
		expect(result.unknownFlags.size).toBe(0);
	});

	test.each(errorCases)("reports %s", (_label, argv, message) => {
		const result = parseArgs(argv);
		expect(result.diagnostics).toContainEqual({ type: "error", message });
	});

	test("--system-prompt reports a missing value only when its text is absent", () => {
		expect(parseArgs(["--system-prompt"]).diagnostics).toContainEqual({
			type: "error",
			message: "--system-prompt requires a value",
		});
		expect(parseArgs(["--system-prompt"]).unknownFlags.has("system-prompt")).toBe(false);
	});

	test.each(VALUE_FLAGS)("%s reports a missing value instead of becoming an extension flag", (flag) => {
		for (const argv of [[flag], [flag, "-x"]]) {
			const result = parseArgs(argv);
			expect(result.diagnostics).toContainEqual({ type: "error", message: `${flag} requires a value` });
			expect(result.unknownFlags.has(flag.slice(2))).toBe(false);
		}
	});

	test.each(AUTONOMOUS_VALUE_FLAGS)("%s without a value still enables autonomous mode", (flag) => {
		const result = parseArgs([flag]);
		expect(result.autonomous).toBe(true);
		expect(result.unknownFlags.size).toBe(0);
		expect(result.diagnostics).toContainEqual({ type: "error", message: `${flag} requires a value` });
	});

	test("captures unknown flags for extensions", () => {
		expect(parseArgs(["--unknown-flag", "message"]).unknownFlags.get("unknown-flag")).toBe("message");
		expect(parseArgs(["--unknown-flag", "message"]).messages).toEqual([]);
		expect(parseArgs(["--unknown-flag"]).unknownFlags.get("unknown-flag")).toBe(true);
		expect(parseArgs(["--unknown-flag=value"]).unknownFlags.get("unknown-flag")).toBe("value");
	});

	test("removed session/model commands consume their value without leaving messages", () => {
		const exported = parseArgs(["--export", "session.jsonl"]);
		expect(exported.export).toBeUndefined();
		expect(exported.messages).toEqual([]);
		const listed = parseArgs(["--list-models", "sonnet"]);
		expect(listed.listModels).toBeUndefined();
		expect(listed.messages).toEqual([]);
	});
});
