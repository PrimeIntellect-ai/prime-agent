// ENG-5344: untrusted Markdown must not carry terminal control sequences or
// unsafe OSC 8 targets into rendered lines.
import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.js";
import { sanitizeTerminalText, stripAnsi } from "../src/utils.js";
import { defaultMarkdownTheme } from "./test-themes.js";

const ESC = "\x1b";
const BEL = "\x07";
const OSC52 = `${ESC}]52;c;U0VOVElORUw=${BEL}`;
const CSI_CLEAR = `${ESC}[2J${ESC}[H${ESC}[3J`;
const OSC_TITLE = `${ESC}]0;evil-title${BEL}`;
const KITTY_APC = `${ESC}_Ga=q,i=1${ESC}\\`;
const DCS = `${ESC}Pq${ESC}\\`;
const C1 = "\x9b2J\x90q\x9c\x9d0;x\x9c";

function render(markdown: string, hyperlinks = false, baseUrl?: string): string {
	setCapabilities({ images: null, trueColor: true, hyperlinks });
	return new Markdown(markdown, 0, 0, defaultMarkdownTheme, undefined, { baseUrl }).render(80).join("\n");
}

/** Every ESC in the output must belong to renderer-owned SGR or OSC 8. */
function assertOnlyRendererSequences(output: string): void {
	const remainder = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, "");
	assert.strictEqual(remainder.indexOf(ESC), -1, `unexpected escape in ${JSON.stringify(output)}`);
	assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(remainder), `control byte in ${JSON.stringify(output)}`);
}

function linkTargets(output: string): string[] {
	return [...output.matchAll(/\x1b\]8;;([^\x1b\x07]+)(?:\x1b\\|\x07)/g)].map((match) => match[1]);
}

describe("sanitizeTerminalText", () => {
	it("returns safe text unchanged", () => {
		const text = "plain text\twith tabs\nand newlines, ünïcödé and emoji 🎉";
		assert.strictEqual(sanitizeTerminalText(text), text);
	});

	it("strips C0 controls except tab and newline, DEL, and C1 controls", () => {
		assert.strictEqual(
			sanitizeTerminalText("a\x00b\x07c\x08d\re\x0bf\x0cg\x7fh\x80i\x9bj\x9fk\tl\nm"),
			"abcdefghijk\tl\nm",
		);
	});

	it("makes every escape-initiated sequence visible instead of executable", () => {
		const sanitized = sanitizeTerminalText(`${OSC52}${CSI_CLEAR}${OSC_TITLE}${KITTY_APC}${DCS}${ESC}N!${ESC}(B`);
		assert.strictEqual(sanitized.indexOf(ESC), -1);
		assert.strictEqual(sanitized, "␛]52;c;U0VOVElORUw=␛[2J␛[H␛[3J␛]0;evil-title␛_Ga=q,i=1␛\\␛Pq␛\\␛N!␛(B");
	});
});

describe("Markdown control sequence sanitization", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("keeps renderer-owned styling as the positive control", () => {
		const output = render("plain **bold** text");
		assert.ok(output.includes(`${ESC}[1m`), "bold SGR expected");
		assertOnlyRendererSequences(output);
	});

	it("neutralizes OSC 52 clipboard writes in paragraphs", () => {
		const output = render(`Here is text ${OSC52} after`);
		assert.ok(!output.includes(`${ESC}]52;`));
		assert.ok(stripAnsi(output).includes("Here is text ␛]52;c;U0VOVElORUw= after"));
		assertOnlyRendererSequences(output);
	});

	it("neutralizes CSI clear-screen and cursor moves", () => {
		const output = render(`before ${CSI_CLEAR} after`);
		assert.ok(!output.includes(`${ESC}[2J`) && !output.includes(`${ESC}[H`));
		assertOnlyRendererSequences(output);
	});

	it("neutralizes OSC title and kitty APC inside fenced code blocks", () => {
		const output = render(`\`\`\`\ncode ${OSC_TITLE} and ${KITTY_APC}\n\`\`\``);
		assert.ok(!output.includes(`${ESC}]0;`) && !output.includes(`${ESC}_G`));
		assert.ok(stripAnsi(output).includes("code ␛]0;evil-title and ␛_Ga=q,i=1␛\\"));
		assertOnlyRendererSequences(output);
	});

	it("neutralizes DCS and C1 controls in headings", () => {
		const output = render(`# Title ${DCS}${C1}`);
		assert.ok(!output.includes(`${ESC}P`) && !output.includes("\x9b") && !output.includes("\x90"));
		assert.ok(stripAnsi(output).includes("Title ␛Pq␛\\2Jq0;x"));
		assertOnlyRendererSequences(output);
	});

	it("neutralizes sequences in code spans, table cells, blockquotes, lists and raw html", () => {
		const output = render(
			[
				`inline \`${OSC52}\` code`,
				"",
				`| a | b |`,
				`| - | - |`,
				`| ${CSI_CLEAR} | ${C1} |`,
				"",
				`> quoted ${OSC_TITLE}`,
				"",
				`- item ${KITTY_APC}`,
				"",
				`<div>${OSC52}</div>`,
			].join("\n"),
		);
		assert.ok(!output.includes(`${ESC}]52;`) && !output.includes(`${ESC}[2J`) && !output.includes(`${ESC}_G`));
		assertOnlyRendererSequences(output);
	});

	it("sanitizes text supplied through setText while streaming", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const markdown = new Markdown("streaming", 0, 0, defaultMarkdownTheme);
		markdown.render(80);
		markdown.setText(`streaming ${OSC52} more`);
		const output = markdown.render(80).join("\n");
		assert.ok(!output.includes(`${ESC}]52;`));
		assertOnlyRendererSequences(output);
	});
});

describe("Markdown hyperlink target allowlist", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	const baseUrl = "file:///home/user/project/";

	it("keeps http, https and mailto targets", () => {
		assert.deepStrictEqual(linkTargets(render("[docs](https://good.example/path)", true)), [
			"https://good.example/path",
		]);
		assert.deepStrictEqual(linkTargets(render("[docs](http://good.example/)", true)), ["http://good.example/"]);
		assert.deepStrictEqual(linkTargets(render("[mail](mailto:user@example.com)", true)), ["mailto:user@example.com"]);
		assert.deepStrictEqual(linkTargets(render("see https://example.com now", true)), ["https://example.com"]);
	});

	it("resolves relative and absolute paths to file links only through baseUrl", () => {
		assert.deepStrictEqual(linkTargets(render("[report](docs/report.md)", true, baseUrl)), [
			"file:///home/user/project/docs/report.md",
		]);
		assert.deepStrictEqual(linkTargets(render("[passwd](/etc/passwd)", true, baseUrl)), ["file:///etc/passwd"]);
		assert.deepStrictEqual(linkTargets(render("[rel](../../etc/passwd)", true)), []);
		assert.ok(stripAnsi(render("[rel](../../etc/passwd)", true)).includes("rel (../../etc/passwd)"));
	});

	it("rejects javascript, explicit file, host-bearing file and anchor targets", () => {
		for (const markdown of [
			"[click](javascript:alert(1))",
			"[passwd](file:///etc/passwd)",
			"[passwd](FILE:///etc/passwd)",
			"[share](//attacker.example/share/x)",
			"[anchor](#overview)",
			"[data](data:text/html,hi)",
		]) {
			for (const base of [undefined, baseUrl]) {
				const output = render(markdown, true, base);
				assert.deepStrictEqual(linkTargets(output), [], `${markdown} with base ${base}`);
				assertOnlyRendererSequences(output);
			}
		}
		const fallback = stripAnsi(render("[click](javascript:alert(1))", true));
		assert.ok(fallback.includes("click (javascript:alert(1))"), "rejected links show the URL as text");
	});

	it("cannot terminate the OSC 8 early through an injected href", () => {
		const output = render(`[click](https://good.example/${ESC}\\${ESC}]52;c;QUFB${BEL})`, true);
		assert.ok(!output.includes(`${ESC}]52;`));
		const [target] = linkTargets(output);
		assert.ok(target?.startsWith("https://good.example/"), `unexpected target ${target}`);
		assert.ok(/^[\x21-\x7e]+$/.test(target), "OSC 8 target must be printable ASCII");
		assertOnlyRendererSequences(output);
	});

	it("rejects unparseable targets", () => {
		const output = render("[bad](https://[invalid)", true);
		assert.deepStrictEqual(linkTargets(output), []);
		assert.ok(stripAnsi(output).includes("bad (https://[invalid)"));
	});
});
