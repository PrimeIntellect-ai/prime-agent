import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import {
	formatFileChangeSummaryLine,
	formatTotalChangeSummary,
	getToolFileChanges,
	mergeTurnFileChanges,
} from "../src/modes/interactive/components/edit-summary.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function result(toolCallId: string, toolName: string, details: unknown, isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [], details, isError, timestamp: 0 };
}

describe("edit summaries", () => {
	beforeAll(() => initTheme("dark"));

	test("only reports successful edits that changed lines", () => {
		expect(getToolFileChanges("edit", { path: "a.ts" }, { details: { diff: "" }, isError: false }, "/tmp")).toEqual(
			[],
		);
		expect(
			getToolFileChanges("edit", { path: "a.ts" }, { details: { diff: "-1 old\n+1 new" }, isError: true }, "/tmp"),
		).toEqual([]);
		expect(
			getToolFileChanges("edit", { path: "a.ts" }, { details: { diff: "-1 old\n+1 new" }, isError: false }, "/tmp"),
		).toEqual([{ path: "a.ts", added: 1, removed: 1 }]);
		expect(
			getToolFileChanges(
				"ipython",
				{},
				{ details: { diffs: [{ path: "b.ts", oldStr: "old", newStr: "new" }] }, isError: true },
				"/tmp",
			),
		).toEqual([{ path: "b.ts", added: 1, removed: 1 }]);
	});

	test("renders one total line for all changed files in an agent run", () => {
		const line = formatTotalChangeSummary([
			{ path: "a.ts", added: 2, removed: 1 },
			{ path: "b.ts", added: 3, removed: 4 },
		]);
		expect(stripAnsi(line)).toBe("2 files changed | +5 -5");
	});

	test("coalesces direct and IPython edits by file", () => {
		const message = assistant([
			{ type: "toolCall", id: "one", name: "edit", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "two", name: "ipython", arguments: {} },
		]);
		const changes = new Map();
		mergeTurnFileChanges(
			changes,
			message,
			[
				result("one", "edit", { diff: "-1 old\n+1 new" }),
				result("two", "ipython", { diffs: [{ path: "a.ts", oldStr: "new", newStr: "newer" }] }),
			],
			"/tmp",
		);
		expect([...changes.values()]).toEqual([{ path: "a.ts", added: 2, removed: 2 }]);
	});

	test("coalesces home-relative and absolute paths", () => {
		const absolutePath = `${homedir()}/same.ts`;
		const message = assistant([
			{ type: "toolCall", id: "one", name: "edit", arguments: { path: "~/same.ts" } },
			{ type: "toolCall", id: "two", name: "ipython", arguments: {} },
		]);
		const changes = new Map();
		mergeTurnFileChanges(
			changes,
			message,
			[
				result("one", "edit", { diff: "-1 old\n+1 new" }),
				result("two", "ipython", { diffs: [{ path: absolutePath, oldStr: "new", newStr: "newer" }] }),
			],
			"/tmp",
		);
		expect([...changes.values()]).toEqual([{ path: "~/same.ts", added: 2, removed: 2 }]);
	});

	test("coalesces canonical paths across a symlinked cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "edit-summary-symlink-"));
		try {
			const realCwd = join(root, "real");
			const linkedCwd = join(root, "linked");
			const file = join(realCwd, "same.ts");
			mkdirSync(realCwd);
			writeFileSync(file, "old");
			symlinkSync(realCwd, linkedCwd, "dir");

			const message = assistant([
				{ type: "toolCall", id: "one", name: "ipython", arguments: {} },
				{ type: "toolCall", id: "two", name: "edit", arguments: { path: "same.ts" } },
			]);
			const changes = new Map();
			mergeTurnFileChanges(
				changes,
				message,
				[
					result("one", "ipython", { diffs: [{ path: realpathSync(file), oldStr: "old", newStr: "new" }] }),
					result("two", "edit", { diff: "-1 new\n+1 newer" }),
				],
				linkedCwd,
			);

			expect([...changes.values()]).toEqual([{ path: realpathSync(file), added: 2, removed: 2 }]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("formatFileChangeSummaryLine", () => {
	beforeAll(() => initTheme("dark"));

	test("keeps the truncated path stable when the ctrl+j hint flips", () => {
		const change = { added: 3, removed: 1 };
		const path = "src/some/deeply/nested/directory/with-a-long-file-name.ts";
		const width = 44;
		const pathPart = (line: string) => stripAnsi(line).replace(/\s*\+\d+ -\d+.*$/, "");
		const expanded = formatFileChangeSummaryLine(path, undefined, change, true, width);
		const collapsed = formatFileChangeSummaryLine(path, undefined, change, false, width);
		expect(stripAnsi(expanded)).toContain("…");
		expect(pathPart(expanded)).toBe(pathPart(collapsed));
	});
});
