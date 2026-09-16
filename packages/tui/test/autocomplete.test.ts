import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.js";
import { getSlashCommandContext } from "../src/slash-command-context.js";

const resolveFdPath = (): string | null => {
	const command = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(command, ["fd"], { encoding: "utf-8" });
	if (result.status !== 0 || !result.stdout) {
		return null;
	}
	const firstLine = result.stdout.split(/\r?\n/).find(Boolean);
	return firstLine ? firstLine.trim() : null;
};

const fdPath = resolveFdPath();
const isFdInstalled = Boolean(fdPath);

const requireFdPath = (): string => {
	if (!fdPath) {
		throw new Error("fd is not available");
	}
	return fdPath;
};

type FolderStructure = {
	dirs?: string[];
	files?: Record<string, string>;
};

const setupFolder = (baseDir: string, structure: FolderStructure = {}): void => {
	for (const dir of structure.dirs ?? []) {
		mkdirSync(join(baseDir, dir), { recursive: true });
	}
	for (const [filePath, contents] of Object.entries(structure.files ?? {})) {
		const fullPath = join(baseDir, filePath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, contents);
	}
};

const getSuggestions = (
	provider: CombinedAutocompleteProvider,
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	force: boolean = false,
) => provider.getSuggestions(lines, cursorLine, cursorCol, { signal: new AbortController().signal, force });

describe("slash command context", () => {
	it("finds inline command tokens on any line", () => {
		assert.deepStrictEqual(getSlashCommandContext(["Please use /skill:brain"], 0, 23), {
			kind: "name",
			prefix: "/skill:brain",
			isAtPromptStart: false,
		});
		assert.deepStrictEqual(getSlashCommandContext(["First line", "Then /he"], 1, 8), {
			kind: "name",
			prefix: "/he",
			isAtPromptStart: false,
		});
	});

	it("keeps standalone command arguments distinct from inline references", () => {
		assert.deepStrictEqual(getSlashCommandContext(["/model gpt"], 0, 10), {
			kind: "argument",
			commandName: "model",
			prefix: "gpt",
			isAtPromptStart: true,
		});
	});

	it("ignores URLs and path fragments", () => {
		assert.strictEqual(getSlashCommandContext(["Visit https://example.com"], 0, 25), null);
		assert.strictEqual(getSlashCommandContext(["Open src/components"], 0, 19), null);
	});
});

describe("CombinedAutocompleteProvider", () => {
	describe("slash commands", () => {
		const commands = [
			{ name: "new", aliases: ["clear"], description: "Start a new session" },
			{ name: "help", description: "Show help" },
			{ name: "model", description: "Select model" },
			{ name: "goal", description: "Set a goal", takesArgument: true },
			{ name: "skill:brainstorm", description: "Brainstorm approaches" },
		];
		const provider = () => new CombinedAutocompleteProvider(commands, "/tmp");

		/** [name, lines, cursor line, cursor col, expected prefix, expected item values] */
		const suggestionCases: [
			name: string,
			lines: string[],
			line: number,
			col: number,
			prefix: string,
			values: string[],
		][] = [
			["matches a command alias and completes the canonical name", ["/clear"], 0, 6, "/clear", ["new"]],
			[
				"suggests skill commands for inline references",
				["Please use /skill:brain"],
				0,
				23,
				"/skill:brain",
				["skill:brainstorm"],
			],
			["suggests commands on later prompt lines", ["First line", "Then /he"], 1, 8, "/he", ["help"]],
		];

		for (const [name, lines, line, col, prefix, values] of suggestionCases) {
			it(name, async () => {
				const result = await getSuggestions(provider(), lines, line, col);

				assert.strictEqual(result?.kind, "slash-command");
				assert.strictEqual(result?.prefix, prefix);
				assert.deepStrictEqual(
					result?.items.map((item) => item.value),
					values,
				);
			});
		}

		it("marks argument-taking commands so the editor can complete into the parameter", async () => {
			const result = await getSuggestions(provider(), ["/goal"], 0, 5);

			assert.deepStrictEqual(
				result?.items.map((item) => [item.value, item.takesArgument]),
				[["goal", true]],
			);
		});

		it("does not fall back to file suggestions for unmatched command tokens", async () => {
			const result = await getSuggestions(new CombinedAutocompleteProvider([], "/tmp"), ["/tm"], 0, 3);

			assert.strictEqual(result, null);
		});

		it("replaces only the inline command token without duplicating whitespace", async () => {
			const line = "Please use /he later";
			const cursorCol = line.indexOf(" later");
			const result = await getSuggestions(provider(), [line], 0, cursorCol);
			const item = result?.items[0];
			assert.ok(result && item);

			const applied = provider().applyCompletion([line], 0, cursorCol, item, result.prefix);

			assert.deepStrictEqual(applied, {
				lines: ["Please use /help later"],
				cursorLine: 0,
				cursorCol: "Please use /help".length,
			});
		});

		it("completes argument-taking commands into the parameter position and others bare", () => {
			const bare = provider().applyCompletion(["/mo"], 0, 3, { value: "model", label: "model" }, "/mo");
			assert.deepStrictEqual(bare, { lines: ["/model"], cursorLine: 0, cursorCol: "/model".length });

			const spaced = provider().applyCompletion(["/go"], 0, 3, { value: "goal", label: "goal" }, "/go");
			assert.deepStrictEqual(spaced, { lines: ["/goal "], cursorLine: 0, cursorCol: "/goal ".length });
		});
	});

	describe("path prefix extraction", () => {
		/** [name, line, cursor col, expected prefix (null means no suggestions)] */
		const prefixCases: [name: string, line: string, col: number, prefix: string | null][] = [
			["extracts / from 'hey /' when forced", "hey /", 5, "/"],
			["does not trigger for slash commands", "/model", 6, null],
			["triggers for absolute paths after a slash command argument", "/command /", 10, "/"],
		];

		for (const [name, line, col, prefix] of prefixCases) {
			it(name, async () => {
				const result = await getSuggestions(new CombinedAutocompleteProvider([], "/tmp"), [line], 0, col, true);

				if (prefix === null) {
					assert.strictEqual(result, null);
				} else {
					assert.strictEqual(result?.prefix, prefix);
					assert.strictEqual(result?.kind, "file");
				}
			});
		}
	});

	describe("fd @ file suggestions", { skip: !isFdInstalled }, () => {
		let rootDir = "";
		let baseDir = "";
		let outsideDir = "";

		beforeEach(() => {
			rootDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-root-"));
			baseDir = join(rootDir, "cwd");
			outsideDir = join(rootDir, "outside");
			mkdirSync(baseDir, { recursive: true });
			mkdirSync(outsideDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(rootDir, { recursive: true, force: true });
		});

		interface FdCase {
			name: string;
			base?: FolderStructure;
			outside?: FolderStructure;
			/** [target, link path relative to the cwd] */
			symlinks?: [target: string, link: string][];
			query: string;
			/** Cursor offset from the end of the query, for completions inside closing quotes. */
			cursorBack?: number;
			values?: string[];
			first?: string;
			includes?: string[];
			excludes?: string[];
			excludedPrefixes?: string[];
		}

		const fdCases: FdCase[] = [
			{
				name: "returns all files and folders for an empty @ query",
				base: { dirs: ["src"], files: { "README.md": "readme" } },
				query: "@",
				values: ["@README.md", "@src/"],
			},
			{
				name: "filters case-insensitively",
				base: { dirs: ["src"], files: { "README.md": "readme" } },
				query: "@re",
				values: ["@README.md"],
			},
			{
				name: "ranks directories before files",
				base: { dirs: ["src"], files: { "src.txt": "text" } },
				query: "@src",
				first: "@src/",
				includes: ["@src.txt"],
			},
			{
				name: "matches deeply nested paths",
				base: {
					files: {
						"packages/tui/src/autocomplete.ts": "export {};",
						"packages/ai/src/autocomplete.ts": "export {};",
					},
				},
				query: "@tui/src/auto",
				includes: ["@packages/tui/src/autocomplete.ts"],
				excludes: ["@packages/ai/src/autocomplete.ts"],
			},
			{
				name: "matches a directory in the middle of a path",
				base: { files: { "src/components/Button.tsx": "export {};", "src/utils/helpers.ts": "export {};" } },
				query: "@components/",
				includes: ["@src/components/Button.tsx"],
				excludes: ["@src/utils/helpers.ts"],
			},
			{
				name: "scopes fuzzy search to relative directories and searches recursively",
				outside: {
					files: {
						"nested/alpha.ts": "export {};",
						"nested/deeper/also-alpha.ts": "export {};",
						"nested/deeper/zzz.ts": "export {};",
					},
				},
				query: "@../outside/a",
				includes: ["@../outside/nested/alpha.ts", "@../outside/nested/deeper/also-alpha.ts"],
				excludes: ["@../outside/nested/deeper/zzz.ts"],
			},
			{
				name: "quotes paths with spaces",
				base: { dirs: ["my folder"], files: { "my folder/test.txt": "content" } },
				query: "@my",
				includes: ['@"my folder/"'],
			},
			{
				name: "includes hidden paths but excludes .git",
				base: {
					dirs: [".pi", ".github", ".git"],
					files: { ".pi/config.json": "{}", ".github/workflows/ci.yml": "name: ci", ".git/config": "[core]" },
				},
				query: "@",
				includes: ["@.pi/", "@.github/"],
				excludes: ["@.git"],
				excludedPrefixes: ["@.git/"],
			},
			{
				name: "follows symlinked directories for fuzzy search",
				base: { files: { "dir/some_file.txt": "real" } },
				outside: { files: { "some_file.txt": "symlinked" } },
				symlinks: [["../outside", "symlinked_dir"]],
				query: "@some",
				includes: ["@dir/some_file.txt", "@symlinked_dir/some_file.txt"],
			},
			{
				name: "returns symlinked directories when matching their name",
				outside: { files: { "nested/file.txt": "symlinked" } },
				symlinks: [["../outside", "symlinked_dir"]],
				query: "@symlinked",
				includes: ["@symlinked_dir/"],
			},
			{
				name: "returns symlinked files without requiring type l",
				base: { files: { "original.txt": "content" } },
				symlinks: [["original.txt", "link.txt"]],
				query: "@link",
				includes: ["@link.txt"],
			},
			{
				name: "continues autocomplete inside quoted paths",
				base: { files: { "my folder/test.txt": "content", "my folder/other.txt": "content" } },
				query: '@"my folder/"',
				cursorBack: 1,
				includes: ['@"my folder/test.txt"', '@"my folder/other.txt"'],
			},
		];

		for (const testCase of fdCases) {
			it(testCase.name, async () => {
				setupFolder(baseDir, testCase.base);
				setupFolder(outsideDir, testCase.outside);
				for (const [target, link] of testCase.symlinks ?? []) {
					symlinkSync(target, join(baseDir, link));
				}

				const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
				const cursorCol = testCase.query.length - (testCase.cursorBack ?? 0);
				const result = await getSuggestions(provider, [testCase.query], 0, cursorCol);
				const values = result?.items.map((item) => item.value) ?? [];

				if (testCase.values) assert.deepStrictEqual(values.slice().sort(), testCase.values.slice().sort());
				if (testCase.first) assert.strictEqual(values[0], testCase.first);
				for (const value of testCase.includes ?? []) {
					assert.ok(values.includes(value), `Expected ${value} in ${JSON.stringify(values)}`);
				}
				for (const value of testCase.excludes ?? []) {
					assert.ok(!values.includes(value), `Unexpected ${value} in ${JSON.stringify(values)}`);
				}
				for (const prefix of testCase.excludedPrefixes ?? []) {
					assert.ok(!values.some((value) => value.startsWith(prefix)), `Unexpected ${prefix}* suggestion`);
				}
			});
		}

		it("applies a quoted @ completion without duplicating the closing quote", async () => {
			setupFolder(baseDir, { files: { "my folder/test.txt": "content" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = '@"my folder/te"';
			const cursorCol = line.length - 1;

			const result = await getSuggestions(provider, [line], 0, cursorCol);
			const item = result?.items.find((entry) => entry.value === '@"my folder/test.txt"');
			assert.ok(result && item, "Should find test.txt suggestion");

			const applied = provider.applyCompletion([line], 0, cursorCol, item, result.prefix);

			assert.strictEqual(applied.lines[0], '@"my folder/test.txt" ');
		});

		it("returns the same @ suggestions when the cwd path contains the query", async () => {
			const normalBaseDir = join(rootDir, "cwd-normal");
			const queryInPathBaseDir = join(rootDir, "cwd-plan-repro");
			mkdirSync(normalBaseDir, { recursive: true });
			mkdirSync(queryInPathBaseDir, { recursive: true });
			const structure = {
				dirs: ["packages/coding-agent/examples/extensions/plan-mode"],
				files: {
					"packages/coding-agent/examples/extensions/plan-mode/README.md": "readme",
					"packages/agent/docs/plan.md": "plan",
				},
			};
			setupFolder(normalBaseDir, structure);
			setupFolder(queryInPathBaseDir, structure);

			const query = "@plan";
			const normalize = (result: Awaited<ReturnType<typeof getSuggestions>>) =>
				(result?.items ?? []).map((item) => `${item.label} :: ${item.description ?? ""}`).sort();
			const normalResult = normalize(
				await getSuggestions(
					new CombinedAutocompleteProvider([], normalBaseDir, requireFdPath()),
					[query],
					0,
					query.length,
				),
			);
			const queryInPathResult = normalize(
				await getSuggestions(
					new CombinedAutocompleteProvider([], queryInPathBaseDir, requireFdPath()),
					[query],
					0,
					query.length,
				),
			);

			assert.deepStrictEqual(queryInPathResult, normalResult);
			assert.ok(normalResult.includes("plan-mode/ :: packages/coding-agent/examples/extensions/plan-mode"));
			assert.ok(normalResult.includes("plan.md :: packages/agent/docs/plan.md"));
		});
	});

	describe("forced path completion", () => {
		let baseDir = "";

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		/** [name, folder structure, typed line, cursor offset from the end, expected values] */
		const pathCases: [
			name: string,
			structure: FolderStructure,
			line: string,
			cursorBack: number,
			includes: string[],
		][] = [
			[
				"preserves the ./ prefix when completing files",
				{ files: { "update.sh": "#!/bin/bash", "utils.ts": "export {};" } },
				"./up",
				0,
				["./update.sh"],
			],
			[
				"preserves the ./ prefix for directory completions",
				{ dirs: ["src"], files: { "src/index.ts": "export {};" } },
				"./sr",
				0,
				["./src/"],
			],
			[
				"quotes paths with spaces for direct completion",
				{ dirs: ["my folder"], files: { "my folder/test.txt": "content" } },
				"my",
				0,
				['"my folder/"'],
			],
			[
				"continues completion inside quoted paths",
				{ files: { "my folder/test.txt": "content", "my folder/other.txt": "content" } },
				'"my folder/"',
				1,
				['"my folder/test.txt"', '"my folder/other.txt"'],
			],
		];

		for (const [name, structure, line, cursorBack, includes] of pathCases) {
			it(name, async () => {
				setupFolder(baseDir, structure);
				const provider = new CombinedAutocompleteProvider([], baseDir);

				const result = await getSuggestions(provider, [line], 0, line.length - cursorBack, true);
				const values = result?.items.map((item) => item.value) ?? [];

				for (const value of includes) {
					assert.ok(values.includes(value), `Expected ${value} in ${JSON.stringify(values)}`);
				}
			});
		}

		it("applies a quoted completion without duplicating the closing quote", async () => {
			setupFolder(baseDir, { files: { "my folder/test.txt": "content" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '"my folder/te"';
			const cursorCol = line.length - 1;

			const result = await getSuggestions(provider, [line], 0, cursorCol, true);
			const item = result?.items.find((entry) => entry.value === '"my folder/test.txt"');
			assert.ok(result && item, "Should find test.txt suggestion");

			const applied = provider.applyCompletion([line], 0, cursorCol, item, result.prefix);

			assert.strictEqual(applied.lines[0], '"my folder/test.txt"');
		});
	});
});
