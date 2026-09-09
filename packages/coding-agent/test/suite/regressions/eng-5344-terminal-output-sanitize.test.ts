// ENG-5344: assistant text, thinking and tool output must not carry terminal
// control sequences or unsafe OSC 8 targets into rendered lines.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { getCapabilities, setCapabilities, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.js";
import { IPythonCellComponent } from "../../../src/modes/interactive/components/ipython-cell.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness } from "../harness.js";

const ESC = "\x1b";
const BEL = "\x07";
const OSC52 = `${ESC}]52;c;U0VOVElORUw=${BEL}`;
const CSI_CLEAR = `${ESC}[2J${ESC}[H${ESC}[3J`;
const OSC_TITLE = `${ESC}]0;evil-title${BEL}`;
const KITTY_APC = `${ESC}_Ga=q,i=1${ESC}\\`;
const C1 = "\x9b2J\x90q\x9c";
const OSC133_ZONE_START = `${ESC}]133;A${BEL}`;

const cwd = resolve("/tmp/eng-5344/project");
let message: AssistantMessage;

/** Everything except renderer-owned SGR, OSC 8 links and OSC 133 zone markers. */
function foreignSequences(output: string): string[] {
	const stripped = output
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, "")
		.replace(/\x1b\]133;[ABC]\x07/g, "");
	return [...stripped.matchAll(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g)].map((match) => JSON.stringify(match[0]));
}

function linkTargets(output: string): string[] {
	return [...output.matchAll(/\x1b\]8;;([^\x1b\x07]+)(?:\x1b\\|\x07)/g)].map((match) => match[1]);
}

function renderAssistant(content: AssistantMessage["content"], hideThinking = false): string {
	const component = new AssistantMessageComponent({ ...message, content }, hideThinking, undefined, undefined, {
		cwd,
	});
	return component.render(80).join("\n");
}

describe("ENG-5344 terminal output sanitization", () => {
	const capabilities = getCapabilities();

	beforeAll(async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage([
					fauxThinking(`I will ${OSC_TITLE} proceed\n\n**Plan**: ${OSC52} done`),
					fauxText(`Result: ${OSC52}${CSI_CLEAR} done, see [the report](file:///etc/passwd) and **bold**`),
				]),
			]);
			await harness.session.prompt("Summarize.");
			const response = harness.session.messages.find((entry) => entry.role === "assistant");
			if (!response || response.role !== "assistant") throw new Error("Missing faux assistant response");
			message = response;
		} finally {
			harness.cleanup();
		}
	});
	beforeEach(() => setCapabilities({ images: null, trueColor: true, hyperlinks: true }));
	afterEach(() => setCapabilities(capabilities));

	test("the faux transcript carries the raw payload into the assistant message", () => {
		const text = message.content.find((block) => block.type === "text");
		expect(text?.type === "text" && text.text.includes(OSC52)).toBe(true);
	});

	test("assistant text keeps bold SGR and zone markers but no foreign sequences", () => {
		const output = renderAssistant(message.content);
		expect(output).toContain(`${ESC}[1m`);
		expect(output).toContain(OSC133_ZONE_START);
		expect(output).not.toContain(`${ESC}]52;`);
		expect(output).not.toContain(`${ESC}[2J`);
		expect(foreignSequences(output)).toEqual([]);
		expect(stripAnsi(output)).toContain("Result: ␛]52;c;U0VOVElORUw=␛[2J␛[H␛[3J done");
	});

	test("expanded thinking and the collapsed recap are sanitized", () => {
		const expanded = renderAssistant(message.content, false);
		expect(expanded).not.toContain(`${ESC}]0;`);
		expect(foreignSequences(expanded)).toEqual([]);

		const collapsed = renderAssistant(message.content, true);
		expect(collapsed).not.toContain(`${ESC}]52;`);
		expect(foreignSequences(collapsed)).toEqual([]);
		expect(stripAnsi(collapsed)).toContain("I will ␛]0;evil-title proceed");
	});

	test("fenced code blocks, headings and C1 controls are sanitized", () => {
		const output = renderAssistant([
			{ type: "text", text: `# Title ${C1}\n\n\`\`\`sh\necho ${OSC_TITLE} ${KITTY_APC}\n\`\`\`` },
		]);
		expect(output).not.toContain("\x9b");
		expect(output).not.toContain(`${ESC}_G`);
		expect(foreignSequences(output)).toEqual([]);
	});

	test("link targets follow the scheme allowlist and fall back to text", () => {
		const output = renderAssistant([
			{
				type: "text",
				text: [
					"[docs](https://good.example/path)",
					"[run](javascript:alert(1))",
					"[passwd](file:///etc/passwd)",
					"[report](audit-out/report.md)",
					"[share](//attacker.example/share)",
					`[inject](https://good.example/${ESC}\\${OSC52})`,
				].join(" "),
			},
		]);
		expect(linkTargets(output)).toEqual([
			"https://good.example/path",
			pathToFileURL(resolve(cwd, "audit-out/report.md")).href,
			"https://good.example/%E2%90%9B%E2%90%9B]52;c;U0VOVElORUw=",
		]);
		expect(output).not.toContain(`${ESC}]52;`);
		expect(foreignSequences(output)).toEqual([]);
		const plain = stripAnsi(output).replace(/\s+/g, " ");
		expect(plain).toContain("run (javascript:alert(1))");
		expect(plain).toContain("passwd (file:///etc/passwd)");
		expect(plain).toContain("share (//attacker.example/share)");
	});

	test("assistant error text is sanitized", () => {
		const failed = new AssistantMessageComponent({
			...message,
			content: [],
			stopReason: "error",
			errorMessage: `Provider failed ${OSC52}${C1}`,
		});
		const lines = failed.render(80).join("\n");
		expect(lines).not.toContain(`${ESC}]52;`);
		expect(foreignSequences(lines)).toEqual([]);
		expect(stripAnsi(lines)).toContain("Provider failed ␛]52;c;U0VOVElORUw=2Jq");
	});

	test("ipython cell code, output and tracebacks are sanitized", () => {
		const component = new IPythonCellComponent({
			code: `print("hi") ${OSC52}\n!echo ${CSI_CLEAR}`,
			content: [{ type: "text", text: `out ${OSC_TITLE}` }],
			details: {
				status: "error",
				stdout: `stdout ${OSC52}${C1}`,
				stderr: `stderr ${KITTY_APC}`,
				result: `result ${CSI_CLEAR}`,
				error: {
					ename: `Boom${OSC52}`,
					evalue: `value ${OSC_TITLE}`,
					traceback: [`Traceback ${OSC52}`, `  File ${C1}`],
				},
				diffs: [{ path: `file${OSC52}.py`, oldStr: `a ${OSC52}`, newStr: `b ${CSI_CLEAR}` }],
			},
			isError: true,
			expanded: true,
			editDiffsExpanded: true,
			executionStarted: true,
			argsComplete: true,
			showImages: true,
			cwd,
		});
		const output = component.render(100).join("\n");
		expect(output).not.toContain(`${ESC}]52;`);
		expect(output).not.toContain(`${ESC}[2J`);
		expect(output).not.toContain(`${ESC}]0;`);
		expect(output).not.toContain(`${ESC}_G`);
		expect(foreignSequences(output)).toEqual([]);
		expect(stripAnsi(output)).toContain("Boom␛]52;c;U0VOVElORUw=");
	});
});
