import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, test } from "vitest";
import { previewPythonCode, pythonStatementLines } from "../../../src/core/tools/code-preview.js";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.js";
import { IPythonCellComponent } from "../../../src/modes/interactive/components/ipython-cell.js";
import {
	readAssignedShellCommand,
	readBackgroundShellHandle,
} from "../../../src/modes/interactive/components/shell-completion.js";
import {
	initTheme,
	loadThemeFromPath,
	preloadCodeHighlighter,
	preloadThemeValidator,
	setThemeInstance,
	theme,
} from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

describe("conversation rendering review regressions", () => {
	test.each([
		['print("""text\n""")', 'print("""text'],
		['print(["""text\n"""])', 'print(["""text'],
		['print(("""text\n"""));', 'print(("""text'],
		['print("""text\n""") # finished', 'print("""text'],
	])("ignores punctuation-only string closer suffixes in previews (%s)", (code, expected) => {
		expect(previewPythonCode(code)).toEqual({ language: "python", text: expected });
		expect(previewPythonCode(`${code}\npublish()`)).toEqual({ language: "python", text: "publish()" });
	});

	test.each(['"""', "'''", 'r"""', 'f"""'])(
		"preserves statements after a multiline string closes (%s)",
		async (opener) => {
			initTheme("dark");
			await preloadCodeHighlighter();
			const closer = opener.slice(-3);
			const code = `body = ${opener}draft\n!not_a_command\n${closer}; publish(body)\n!echo done`;
			const statements = pythonStatementLines(code);
			expect(statements).toHaveLength(4);
			expect(statements[1]).toBe("");
			expect(statements[2]?.trim()).toBe("; publish(body)");
			expect(statements[3]).toBe("!echo done");
			expect(previewPythonCode(code)).toEqual({ language: "python", text: "publish(body)" });
			expect(previewPythonCode(`body = ${opener}draft\n${closer}; bash('git status')`)).toEqual({
				language: "bash",
				text: "git status",
			});
			expect(pythonStatementLines(`body = ${opener}draft\nnot closed`)[1]).toBe("");
			const rows = new IPythonCellComponent({
				code,
				expanded: true,
				argsComplete: true,
				details: { status: "ok" },
			}).render(120);
			const stringRow = rows.find((row) => stripAnsi(row).includes("!not_a_command"))!;
			const commandRow = rows.find((row) => stripAnsi(row).trim() === "!echo done")!;
			expect(stringRow).toContain(theme.getFgAnsi("syntaxString"));
			expect(commandRow).toContain(theme.getFgAnsi("bashMode"));
			expect(rows.some((row) => stripAnsi(row).includes(`${closer}; publish(body)`))).toBe(true);
		},
	);

	test("loads custom themes without mdBody before and after validator initialization", async () => {
		harness = await createHarness();
		const custom = JSON.parse(
			readFileSync(new URL("../../../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
		) as { name: string; colors: Record<string, string | number> };
		custom.name = "optional-body";
		custom.colors.text = "#123456";
		delete custom.colors.mdBody;
		const path = join(harness.tempDir, "optional-body.json");
		const source = JSON.stringify(custom);
		writeFileSync(path, source);
		for (const validate of [false, true]) {
			if (validate) await preloadThemeValidator();
			setThemeInstance(loadThemeFromPath(path));
			expect(theme.fg("mdBody", "Body")).toBe(theme.fg("text", "Body"));
			const rendered = new AssistantMessageComponent(fauxAssistantMessage("Body")).render(80).join("\n");
			expect(stripAnsi(rendered)).toContain("Body");
			expect(rendered).toContain(theme.getFgAnsi("text"));
		}
		expect(readFileSync(path, "utf8")).toBe(source);
		custom.colors.mdBody = "#abcdef";
		writeFileSync(path, JSON.stringify(custom));
		const explicit = loadThemeFromPath(path);
		expect(explicit.fg("mdBody", "Body")).not.toBe(explicit.fg("text", "Body"));
	});

	test("renders large sent agent messages without exceeding the JavaScript argument limit", () => {
		initTheme("dark");
		const message = `${"x\n".repeat(140000)}final message line`;
		const state = {
			code: "await agent_message.send('child', message)",
			executionStarted: true,
			details: {
				status: "ok",
				sentAgentMessages: [
					{
						id: "huge",
						message,
						deliveryStatus: "delivered",
						receiverRole: "child",
						target: { activeSessionId: "child", sessionId: "child" },
					},
				],
			},
		};
		const cell = new IPythonCellComponent(state);
		expect(cell.render(80)).toHaveLength(2);
		cell.update({ ...state, expanded: true });
		const rows = cell.render(80);
		expect(rows.filter((row) => stripAnsi(row).trim() === "x")).toHaveLength(139999);
		expect(rows.some((row) => stripAnsi(row).includes("final message line"))).toBe(true);
		cell.update(state);
		expect(cell.render(80)).toHaveLength(2);
	});

	test("matches literal launches across blank import lines and rejects malformed or additional code", () => {
		const details = { status: "ok", result: "<BashHandle pid=42 running command='printf done'>" };
		for (const prefix of ["from rlm import bash\n\n", "import rlm\n \n", ""]) {
			expect(readBackgroundShellHandle(`${prefix}job = bash('printf done')\n\njob`, details)).toEqual({
				pid: 42,
				command: "printf done",
				exitCode: undefined,
			});
			expect(readAssignedShellCommand(`${prefix}job = bash('printf done')\n\n`, { status: "ok" })).toBe(
				"printf done",
			);
		}
		for (const code of [
			"bash('printf done'); other()",
			"bash('printf done')\nother()",
			"bash('printf done' + extra)",
			"bash('printf done', other)",
			`bash(${"\t".repeat(100000)}x`,
			`bash(${"\t".repeat(100000)}x)`,
			"job = bash('printf done')\nother",
		]) {
			expect(readBackgroundShellHandle(code, details)).toBeUndefined();
			expect(readAssignedShellCommand(code, { status: "ok" })).toBeUndefined();
		}
	});
});
