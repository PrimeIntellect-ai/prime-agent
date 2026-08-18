import { describe, expect, test } from "vitest";
import { INTERNAL_RUNTIME_COMMAND_MARKER, parseArgs } from "../src/cli/args.js";

describe("parseArgs", () => {
	describe("--version flag", () => {
		test("parses --version flag", () => {
			const result = parseArgs(["--version"]);
			expect(result.version).toBe(true);
		});

		test("parses -v shorthand", () => {
			const result = parseArgs(["-v"]);
			expect(result.version).toBe(true);
		});

		test("--version takes precedence over other args", () => {
			const result = parseArgs(["--version", "--help", "some message"]);
			expect(result.version).toBe(true);
			expect(result.help).toBe(true);
			expect(result.messages).toContain("some message");
		});
	});

	describe("--help flag", () => {
		test("parses --help flag", () => {
			const result = parseArgs(["--help"]);
			expect(result.help).toBe(true);
		});

		test("parses -h shorthand", () => {
			const result = parseArgs(["-h"]);
			expect(result.help).toBe(true);
		});
	});

	describe("--print flag", () => {
		test("parses --print flag", () => {
			const result = parseArgs(["--print"]);
			expect(result.print).toBe(true);
		});

		test("parses -p shorthand", () => {
			const result = parseArgs(["-p"]);
			expect(result.print).toBe(true);
		});

		test("parses prompt after -p even when it starts with YAML frontmatter", () => {
			const prompt = "---\ntitle: hello\n---\nSay hi.";
			const result = parseArgs(["-p", prompt]);
			expect(result.print).toBe(true);
			expect(result.messages).toEqual([prompt]);
			expect(result.unknownFlags.size).toBe(0);
		});

		test("does not consume options after -p as prompts", () => {
			const result = parseArgs(["-p", "--provider", "openai", "Say hi."]);
			expect(result.print).toBe(true);
			expect(result.provider).toBe("openai");
			expect(result.messages).toEqual(["Say hi."]);
		});
	});

	describe("--continue flag", () => {
		test("parses --continue flag", () => {
			const result = parseArgs(["--continue"]);
			expect(result.continue).toBe(true);
		});

		test("parses -c shorthand", () => {
			const result = parseArgs(["-c"]);
			expect(result.continue).toBe(true);
		});
	});

	describe("--resume flag", () => {
		test("parses --resume flag", () => {
			const result = parseArgs(["--resume"]);
			expect(result.resume).toBe(true);
		});

		test("parses -r shorthand", () => {
			const result = parseArgs(["-r"]);
			expect(result.resume).toBe(true);
		});

		test("parses --resume with a session selector", () => {
			const result = parseArgs(["--resume", "/path/to/session.jsonl"]);
			expect(result.resume).toBe("/path/to/session.jsonl");
			expect(result.messages).toEqual([]);
		});

		test("parses -r with a session selector", () => {
			const result = parseArgs(["-r", "1234abcd"]);
			expect(result.resume).toBe("1234abcd");
			expect(result.messages).toEqual([]);
		});

		test("parses --resume=value", () => {
			const result = parseArgs(["--resume=1234abcd"]);
			expect(result.resume).toBe("1234abcd");
		});

		test("parses --resume with a windows session path", () => {
			const sessionPath = "C:\\Users\\me\\session.jsonl";
			const result = parseArgs(["--resume", sessionPath]);
			expect(result.resume).toBe(sessionPath);
			expect(result.messages).toEqual([]);
		});

		test("parses --resume with a slash-containing relative session path", () => {
			const result = parseArgs(["--resume", "sessions/current"]);
			expect(result.resume).toBe("sessions/current");
			expect(result.messages).toEqual([]);
		});

		test("treats the value after --resume as an authoritative selector", () => {
			const result = parseArgs(["--resume", "fix", "the", "bug"]);
			expect(result.resume).toBe("fix");
			expect(result.messages).toEqual(["the", "bug"]);
		});

		test("treats the value after --resume= as an authoritative selector", () => {
			const result = parseArgs(["--resume=fix"]);
			expect(result.resume).toBe("fix");
			expect(result.messages).toEqual([]);
		});

		test("supports an initial prompt after the bare resume picker", () => {
			const result = parseArgs(["--resume", "--", "continue", "the", "session"]);
			expect(result.resume).toBe(true);
			expect(result.messages).toEqual(["continue", "the", "session"]);
		});

		test("treats empty --resume values as the bare resume picker flag", () => {
			const separated = parseArgs(["--resume", ""]);
			expect(separated.resume).toBe(true);
			expect(separated.messages).toEqual([]);

			const equals = parseArgs(["--resume="]);
			expect(equals.resume).toBe(true);
			expect(equals.messages).toEqual([]);
		});
	});

	describe("--cwd flag", () => {
		test("parses --cwd flag", () => {
			const result = parseArgs(["--cwd", "/tmp/project"]);
			expect(result.cwd).toBe("/tmp/project");
		});
	});

	describe("flags with values", () => {
		test("parses --provider", () => {
			const result = parseArgs(["--provider", "openai"]);
			expect(result.provider).toBe("openai");
		});

		test("parses --model", () => {
			const result = parseArgs(["--model", "gpt-4o"]);
			expect(result.model).toBe("gpt-4o");
		});

		test("parses --api-key", () => {
			const result = parseArgs(["--api-key", "sk-test-key"]);
			expect(result.apiKey).toBe("sk-test-key");
		});

		test("parses --system-prompt", () => {
			const result = parseArgs(["--system-prompt", "You are a helpful assistant"]);
			expect(result.systemPrompt).toBe("You are a helpful assistant");
		});

		test("parses --append-system-prompt", () => {
			const result = parseArgs(["--append-system-prompt", "Additional context"]);
			expect(result.appendSystemPrompt).toEqual(["Additional context"]);
		});

		test("parses multiple --append-system-prompt flags", () => {
			const result = parseArgs(["--append-system-prompt", "Context A", "--append-system-prompt", "Context B"]);
			expect(result.appendSystemPrompt).toEqual(["Context A", "Context B"]);
		});

		test("parses --mode", () => {
			const result = parseArgs(["--mode", "json"]);
			expect(result.mode).toBe("json");
		});

		test("parses --mode rpc", () => {
			const result = parseArgs(["--mode", "rpc"]);
			expect(result.mode).toBe("rpc");
		});

		test("parses --fork", () => {
			const result = parseArgs(["--fork", "1234abcd"]);
			expect(result.fork).toBe("1234abcd");
			expect(result.messages).toEqual([]);
		});

		test("rejects removed --export syntax", () => {
			const result = parseArgs(["--export", "session.jsonl"]);
			expect(result.export).toBeUndefined();
			expect(result.messages).toEqual([]);
			expect(result.diagnostics).toContainEqual({
				type: "error",
				message: '--export was removed. Use "prime-agent session export <file> [output]".',
			});
		});

		test("parses session export only through the internal command marker", () => {
			const result = parseArgs([INTERNAL_RUNTIME_COMMAND_MARKER, "--export", "session.jsonl"]);
			expect(result.export).toBe("session.jsonl");
		});

		test("rejects removed --list-models syntax", () => {
			const result = parseArgs(["--list-models", "sonnet"]);
			expect(result.listModels).toBeUndefined();
			expect(result.messages).toEqual([]);
			expect(result.diagnostics).toContainEqual({
				type: "error",
				message: '--list-models was removed. Use "prime-agent model list [search]".',
			});
		});

		test("parses model list only through the internal command marker", () => {
			const result = parseArgs([INTERNAL_RUNTIME_COMMAND_MARKER, "--list-models", "sonnet"]);
			expect(result.listModels).toBe("sonnet");
		});

		test("parses --thinking", () => {
			const result = parseArgs(["--thinking", "high"]);
			expect(result.thinking).toBe("high");
		});

		test("parses --models as comma-separated list", () => {
			const result = parseArgs(["--models", "gpt-4o,claude-sonnet,gemini-pro"]);
			expect(result.models).toEqual(["gpt-4o", "claude-sonnet", "gemini-pro"]);
		});
	});

	describe("--no-session flag", () => {
		test("parses --no-session flag", () => {
			const result = parseArgs(["--no-session"]);
			expect(result.noSession).toBe(true);
		});
	});

	describe("--extension flag", () => {
		test("parses single --extension", () => {
			const result = parseArgs(["--extension", "./my-extension.ts"]);
			expect(result.extensions).toEqual(["./my-extension.ts"]);
		});

		test("parses -e shorthand", () => {
			const result = parseArgs(["-e", "./my-extension.ts"]);
			expect(result.extensions).toEqual(["./my-extension.ts"]);
		});

		test("parses multiple --extension flags", () => {
			const result = parseArgs(["--extension", "./ext1.ts", "-e", "./ext2.ts"]);
			expect(result.extensions).toEqual(["./ext1.ts", "./ext2.ts"]);
		});
	});

	describe("--no-extensions flag", () => {
		test("parses --no-extensions flag", () => {
			const result = parseArgs(["--no-extensions"]);
			expect(result.noExtensions).toBe(true);
		});

		test("parses --no-extensions with explicit -e flags", () => {
			const result = parseArgs(["--no-extensions", "-e", "foo.ts", "-e", "bar.ts"]);
			expect(result.noExtensions).toBe(true);
			expect(result.extensions).toEqual(["foo.ts", "bar.ts"]);
		});
	});

	describe("--skill flag", () => {
		test("parses single --skill", () => {
			const result = parseArgs(["--skill", "./skill-dir"]);
			expect(result.skills).toEqual(["./skill-dir"]);
		});

		test("parses multiple --skill flags", () => {
			const result = parseArgs(["--skill", "./skill-a", "--skill", "./skill-b"]);
			expect(result.skills).toEqual(["./skill-a", "./skill-b"]);
		});
	});

	describe("--prompt-template flag", () => {
		test("parses single --prompt-template", () => {
			const result = parseArgs(["--prompt-template", "./prompts"]);
			expect(result.promptTemplates).toEqual(["./prompts"]);
		});

		test("parses multiple --prompt-template flags", () => {
			const result = parseArgs(["--prompt-template", "./one", "--prompt-template", "./two"]);
			expect(result.promptTemplates).toEqual(["./one", "./two"]);
		});
	});

	describe("--theme flag", () => {
		test("parses single --theme", () => {
			const result = parseArgs(["--theme", "./theme.json"]);
			expect(result.themes).toEqual(["./theme.json"]);
		});

		test("parses multiple --theme flags", () => {
			const result = parseArgs(["--theme", "./dark.json", "--theme", "./light.json"]);
			expect(result.themes).toEqual(["./dark.json", "./light.json"]);
		});
	});

	describe("--no-skills flag", () => {
		test("parses --no-skills flag", () => {
			const result = parseArgs(["--no-skills"]);
			expect(result.noSkills).toBe(true);
		});
	});

	describe("--no-prompt-templates flag", () => {
		test("parses --no-prompt-templates flag", () => {
			const result = parseArgs(["--no-prompt-templates"]);
			expect(result.noPromptTemplates).toBe(true);
		});
	});

	describe("--no-themes flag", () => {
		test("parses --no-themes flag", () => {
			const result = parseArgs(["--no-themes"]);
			expect(result.noThemes).toBe(true);
		});
	});

	describe("--no-context-files flag", () => {
		test("parses --no-context-files flag", () => {
			const result = parseArgs(["--no-context-files"]);
			expect(result.noContextFiles).toBe(true);
		});

		test("parses -nc shorthand", () => {
			const result = parseArgs(["-nc"]);
			expect(result.noContextFiles).toBe(true);
		});
	});

	describe("--verbose flag", () => {
		test("parses --verbose flag", () => {
			const result = parseArgs(["--verbose"]);
			expect(result.verbose).toBe(true);
		});
	});

	describe("--offline flag", () => {
		test("parses --offline flag", () => {
			const result = parseArgs(["--offline"]);
			expect(result.offline).toBe(true);
		});
	});

	describe("--autonomous flag", () => {
		test("parses --autonomous flag", () => {
			const result = parseArgs(["--autonomous"]);
			expect(result.autonomous).toBe(true);
		});

		test("parses autonomous gate flags", () => {
			const result = parseArgs([
				"--autonomous",
				"--autonomous-gate",
				"npm test",
				"--autonomous-gate",
				"npm run lint",
				"--autonomous-gate-retries",
				"2",
				"--autonomous-gate-timeout-ms",
				"1000",
			]);
			expect(result.autonomous).toBe(true);
			expect(result.autonomousGates).toEqual(["npm test", "npm run lint"]);
			expect(result.autonomousGateRetries).toBe(2);
			expect(result.autonomousGateTimeoutMs).toBe(1000);
		});

		test("parses autonomous limit flags", () => {
			const result = parseArgs([
				"--autonomous",
				"--autonomous-max-continuations",
				"20",
				"--autonomous-max-turns",
				"80",
				"--autonomous-max-tokens",
				"500000",
				"--autonomous-timeout-ms",
				"1800000",
			]);
			expect(result.autonomous).toBe(true);
			expect(result.autonomousMaxContinuations).toBe(20);
			expect(result.autonomousMaxTurns).toBe(80);
			expect(result.autonomousMaxTokens).toBe(500000);
			expect(result.autonomousTimeoutMs).toBe(1800000);
		});

		test("auto-enables autonomous mode when autonomous sub-options are supplied", () => {
			const result = parseArgs(["--autonomous-max-turns", "1", "--autonomous-gate", "npm test"]);
			expect(result.autonomous).toBe(true);
			expect(result.autonomousMaxTurns).toBe(1);
			expect(result.autonomousGates).toEqual(["npm test"]);
		});

		test("reports missing autonomous option values", () => {
			const result = parseArgs(["--autonomous-max-turns", "--autonomous-gate", "npm test"]);

			expect(result.autonomous).toBe(true);
			expect(result.autonomousMaxTurns).toBeUndefined();
			expect(result.autonomousGates).toEqual(["npm test"]);
			expect(result.unknownFlags.size).toBe(0);
			expect(result.diagnostics).toContainEqual({
				type: "error",
				message: "--autonomous-max-turns requires a value",
			});
		});

		test("does not consume another autonomous flag as a gate value", () => {
			const result = parseArgs(["--autonomous-gate", "--autonomous-max-turns", "3"]);

			expect(result.autonomous).toBe(true);
			expect(result.autonomousGates).toBeUndefined();
			expect(result.autonomousMaxTurns).toBe(3);
			expect(result.diagnostics).toContainEqual({
				type: "error",
				message: "--autonomous-gate requires a value",
			});
		});

		test("accepts a gate command that starts with an unknown short flag", () => {
			const result = parseArgs(["--autonomous-gate", "-x npm test"]);

			expect(result.autonomousGates).toEqual(["-x npm test"]);
			expect(result.diagnostics).toEqual([]);
		});

		test.each([
			"--autonomous-gate",
			"--autonomous-gate-retries",
			"--autonomous-gate-timeout-ms",
			"--autonomous-max-continuations",
			"--autonomous-max-turns",
			"--autonomous-max-tokens",
			"--autonomous-timeout-ms",
		])("reports when %s has no value", (flag) => {
			const result = parseArgs([flag]);

			expect(result.autonomous).toBe(true);
			expect(result.unknownFlags.size).toBe(0);
			expect(result.diagnostics).toContainEqual({ type: "error", message: `${flag} requires a value` });
		});
	});

	describe("tool flags", () => {
		test("parses --no-tools flag", () => {
			const result = parseArgs(["--no-tools"]);
			expect(result.noTools).toBe(true);
		});

		test("parses -nt shorthand", () => {
			const result = parseArgs(["-nt"]);
			expect(result.noTools).toBe(true);
		});

		test("parses --no-builtin-tools flag", () => {
			const result = parseArgs(["--no-builtin-tools"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses -nbt shorthand", () => {
			const result = parseArgs(["-nbt"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses --tools flag", () => {
			const result = parseArgs(["--tools", "ipython,dynamic_tool"]);
			expect(result.tools).toEqual(["ipython", "dynamic_tool"]);
		});

		test("parses -t shorthand", () => {
			const result = parseArgs(["-t", "ipython,dynamic_tool"]);
			expect(result.tools).toEqual(["ipython", "dynamic_tool"]);
		});

		test("parses --no-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-tools", "--tools", "ipython,dynamic_tool"]);
			expect(result.noTools).toBe(true);
			expect(result.tools).toEqual(["ipython", "dynamic_tool"]);
		});

		test("parses --no-builtin-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-builtin-tools", "--tools", "ipython,dynamic_tool"]);
			expect(result.noBuiltinTools).toBe(true);
			expect(result.tools).toEqual(["ipython", "dynamic_tool"]);
		});

		test("rejects removed built-in tools", () => {
			const result = parseArgs(["--tools", "read,bash,edit"]);
			expect(result.tools).toEqual(["read", "bash", "edit"]);
			expect(result.diagnostics).toContainEqual({
				type: "error",
				message: "Unknown built-in tool(s): read. Available built-in tools: ipython",
			});
		});
	});

	describe("messages and file args", () => {
		test("parses plain text messages", () => {
			const result = parseArgs(["hello", "world"]);
			expect(result.messages).toEqual(["hello", "world"]);
		});

		test("parses @file arguments", () => {
			const result = parseArgs(["@README.md", "@src/main.ts"]);
			expect(result.fileArgs).toEqual(["README.md", "src/main.ts"]);
		});

		test("parses mixed messages and file args", () => {
			const result = parseArgs(["@file.txt", "explain this", "@image.png"]);
			expect(result.fileArgs).toEqual(["file.txt", "image.png"]);
			expect(result.messages).toEqual(["explain this"]);
		});

		test("captures unknown long flags with string values", () => {
			const result = parseArgs(["--unknown-flag", "message"]);
			expect(result.messages).toEqual([]);
			expect(result.unknownFlags.get("unknown-flag")).toBe("message");
		});

		test("captures unknown boolean long flags", () => {
			const result = parseArgs(["--unknown-flag"]);
			expect(result.unknownFlags.get("unknown-flag")).toBe(true);
		});

		test("captures unknown long flags with equals syntax", () => {
			const result = parseArgs(["--unknown-flag=value"]);
			expect(result.unknownFlags.get("unknown-flag")).toBe("value");
		});
	});

	describe("complex combinations", () => {
		test("parses multiple flags together", () => {
			const result = parseArgs([
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet",
				"--print",
				"--thinking",
				"high",
				"@prompt.md",
				"Do the task",
			]);
			expect(result.provider).toBe("anthropic");
			expect(result.model).toBe("claude-sonnet");
			expect(result.print).toBe(true);
			expect(result.thinking).toBe("high");
			expect(result.fileArgs).toEqual(["prompt.md"]);
			expect(result.messages).toEqual(["Do the task"]);
		});
	});

	describe("-- end-of-options separator", () => {
		test("treats a dash-leading prompt after -- as a positional message", () => {
			const result = parseArgs(["--", "- You are given a state dictionary (/app/weights.pt)..."]);
			expect(result.messages).toEqual(["- You are given a state dictionary (/app/weights.pt)..."]);
			expect(result.diagnostics).toEqual([]);
			expect(result.unknownFlags.size).toBe(0);
		});

		test("a dash-leading prompt without -- still errors", () => {
			const result = parseArgs(["- do the thing"]);
			expect(result.messages).toEqual([]);
			expect(result.diagnostics).toEqual([{ type: "error", message: "Unknown option: - do the thing" }]);
		});

		test("does not parse flags after -- as options", () => {
			const result = parseArgs(["--", "--provider", "openai"]);
			expect(result.provider).toBeUndefined();
			expect(result.messages).toEqual(["--provider", "openai"]);
			expect(result.unknownFlags.size).toBe(0);
		});

		test("parses flags before -- and treats the rest as messages", () => {
			const result = parseArgs(["--provider", "openai", "--", "-p", "@file"]);
			expect(result.provider).toBe("openai");
			expect(result.print).toBeUndefined();
			expect(result.fileArgs).toEqual([]);
			expect(result.messages).toEqual(["-p", "@file"]);
		});

		test("a lone -- produces no messages and no diagnostics", () => {
			const result = parseArgs(["--"]);
			expect(result.messages).toEqual([]);
			expect(result.diagnostics).toEqual([]);
			expect(result.unknownFlags.size).toBe(0);
		});

		test("parses --goal as a string", () => {
			const result = parseArgs(["--goal", "Write a paper"]);
			expect(result.goal).toBe("Write a paper");
			expect(result.diagnostics).toEqual([]);
		});

		test("parses --goal-token-budget as a positive integer with --goal", () => {
			const result = parseArgs(["--goal", "test goal", "--goal-token-budget", "50000"]);
			expect(result.goalTokenBudget).toBe(50000);
			expect(result.diagnostics).toEqual([]);
		});

		test("rejects non-positive --goal-token-budget", () => {
			const result = parseArgs(["--goal-token-budget", "0"]);
			expect(result.goalTokenBudget).toBeUndefined();
			expect(result.diagnostics).toEqual([
				{ type: "error", message: "--goal-token-budget must be a positive integer" },
			]);
		});

		test("parses --goal and --goal-token-budget together", () => {
			const result = parseArgs(["--goal", "Fix all bugs", "--goal-token-budget", "100000"]);
			expect(result.goal).toBe("Fix all bugs");
			expect(result.goalTokenBudget).toBe(100000);
		});

		test("trailing --goal without value produces an error", () => {
			const result = parseArgs(["--goal"]);
			expect(result.goal).toBeUndefined();
			expect(result.diagnostics).toEqual([{ type: "error", message: "--goal requires a value" }]);
		});

		test("trailing --goal-token-budget without value produces an error", () => {
			const result = parseArgs(["--goal-token-budget"]);
			expect(result.goalTokenBudget).toBeUndefined();
			expect(result.diagnostics).toEqual([{ type: "error", message: "--goal-token-budget requires a value" }]);
		});

		test("--goal followed by --other flag produces an error for --goal", () => {
			const result = parseArgs(["--goal", "--verbose"]);
			expect(result.goal).toBeUndefined();
			expect(result.diagnostics).toEqual([{ type: "error", message: "--goal requires a value" }]);
		});

		test("--goal accepts a dash-prefixed objective", () => {
			const result = parseArgs(["--goal", "-p"]);

			expect(result.goal).toBe("-p");
			expect(result.print).toBeUndefined();
			expect(result.diagnostics).toEqual([]);
		});

		test("--goal-token-budget without --goal produces an error", () => {
			const result = parseArgs(["--goal-token-budget", "50000"]);
			expect(result.diagnostics).toContainEqual({
				type: "error",
				message: "--goal-token-budget requires --goal",
			});
		});

		test("empty --goal value produces an error", () => {
			const result = parseArgs(["--goal", "  "]);
			expect(result.goal).toBeUndefined();
			expect(result.diagnostics).toContainEqual({
				type: "error",
				message: "--goal requires a non-empty objective",
			});
		});
	});
});
