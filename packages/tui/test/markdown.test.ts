import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Chalk } from "chalk";
import { Markdown } from "../src/components/markdown.js";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.js";
import { TUI } from "../src/tui.js";
import { hyperlinkAtColumn, stripAnsi } from "../src/utils.js";
import { defaultMarkdownTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const chalk = new Chalk({ level: 3 });

function render(text: string, width = 80, paddingX = 0): string[] {
	return new Markdown(text, paddingX, 0, defaultMarkdownTheme).render(width);
}

function renderPlain(text: string, width = 80, paddingX = 0): string[] {
	return render(text, width, paddingX).map((line) => stripAnsi(line).trimEnd());
}

function getCellUnderline(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isUnderline();
}

describe("Markdown component", () => {
	it("keeps labeled links clickable when the visible URL fallback is shown (ENG-6126)", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const url = "https://www.google.com";
			const line = render(`[Google](${url})`)[0]!;

			assert.strictEqual(hyperlinkAtColumn(line, 0), url);
			assert.strictEqual(stripAnsi(line).trimEnd(), `Google (${url})`);
		} finally {
			resetCapabilitiesCache();
		}
	});

	describe("Table layout", () => {
		const table = (header: string, separator: string, ...rows: string[]) => [header, separator, ...rows].join("\n");
		const longWord = "superlongword";
		const url = "https://example.com/this/is/a/very/long/url/that/should/wrap";

		/** [name, markdown, width, columns, paddingX] - every rendered line must fit the width and keep its borders. */
		const layoutCases: [name: string, text: string, width: number, columns: number, paddingX?: number][] = [
			["fits naturally", table("| A | B |", "| --- | --- |", "| 1 | 2 |"), 80, 2],
			[
				"wraps cells when the table exceeds the width",
				table(
					"| Command | Description | Example |",
					"| --- | --- | --- |",
					"| npm install | Install all dependencies | npm install |",
					"| npm run build | Build the project | npm run build |",
				),
				50,
				3,
			],
			[
				"wraps a long cell to multiple rows",
				table("| Header |", "| --- |", "| This is a very long cell content that should wrap |"),
				25,
				1,
			],
			["wraps long unbroken tokens inside cells", table("| Value |", "| --- |", `| prefix ${url} |`), 30, 1],
			[
				"wraps styled inline code inside cells",
				table("| Code |", "| --- |", "| `averyveryveryverylongidentifier` |"),
				20,
				1,
			],
			["handles an extremely narrow width", table("| A | B | C |", "| --- | --- | --- |", "| 1 | 2 | 3 |"), 15, 3],
			[
				"respects paddingX when calculating the width",
				table("| Column One | Column Two |", "| --- | --- |", "| Data 1 | Data 2 |"),
				40,
				2,
				2,
			],
		];

		for (const [name, text, width, columns, paddingX] of layoutCases) {
			it(`${name} without exceeding the width or breaking borders`, () => {
				setCapabilities({ images: null, trueColor: false, hyperlinks: false });
				const plainLines = renderPlain(text, width, paddingX);
				resetCapabilitiesCache();

				for (const line of plainLines) {
					assert.ok(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`);
				}
				const rowLines = plainLines.filter((line) => line.trimStart().startsWith("│"));
				assert.ok(rowLines.length > 0, "Expected table rows to render");
				for (const line of rowLines) {
					assert.strictEqual(line.split("│").length - 1, columns + 1, `Wrong border count in "${line}"`);
				}
			});
		}

		it("wraps a long cell across several data rows and keeps the words intact", () => {
			const plainLines = renderPlain(
				"| Header |\n| --- |\n| This is a very long cell content that should wrap |",
				25,
			);
			const dataRows = plainLines.filter((line) => line.startsWith("│") && !line.includes("─"));

			assert.ok(dataRows.length > 2, `Expected wrapped rows, got ${dataRows.length} rows`);
			const joined = plainLines.join(" ");
			for (const fragment of ["very long", "cell content", "should wrap"]) {
				assert.ok(joined.includes(fragment), `Should preserve "${fragment}"`);
			}
		});

		it("keeps a column at least as wide as its longest word", () => {
			const plainLines = renderPlain(
				`| Column One | Column Two |\n| --- | --- |\n| ${longWord} short | otherword |`,
				32,
			);
			const dataLine = plainLines.find((line) => line.includes(longWord));
			assert.ok(dataLine, "Expected data row containing longest word");

			const firstSegment = dataLine.split("│")[1];
			assert.ok(firstSegment, "Expected first column segment");
			const firstColumnWidth = firstSegment.length - 2;

			assert.ok(
				firstColumnWidth >= longWord.length,
				`Expected width >= ${longWord.length}, got ${firstColumnWidth}`,
			);
		});

		it("exposes wrapped table cell boundaries without changing rendered text", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const cellUrl = "https://example.com/this/is/a/long/path";
			const markdown = new Markdown(
				`| URL | Status |\n| --- | --- |\n| ${cellUrl} | ready |`,
				0,
				0,
				defaultMarkdownTheme,
			);
			const lines = markdown.render(32);
			resetCapabilitiesCache();

			const regions = markdown.getSelectionRegions();
			const urlRegions = regions.filter((region) => region.row === 1 && region.column === 0);
			const statusRegions = regions.filter((region) => region.row === 1 && region.column === 1);

			assert.ok(urlRegions.length > 1, "URL cell should wrap across physical lines");
			assert.strictEqual(statusRegions.length, urlRegions.length);
			assert.ok(
				lines.every((line) => !line.includes("\x1b_pi:table:")),
				"metadata markers must be stripped",
			);
			assert.ok(urlRegions.every((region) => region.table === urlRegions[0].table));
			assert.ok(urlRegions.every((region) => region.content === cellUrl));
			for (let i = 0; i < urlRegions.length; i++) {
				assert.strictEqual(urlRegions[i].line, statusRegions[i].line);
				assert.ok(urlRegions[i].col + urlRegions[i].width < statusRegions[i].col);
			}
		});
	});

	describe("Style leaks", () => {
		const thinking = { color: (text: string) => chalk.gray(text), italic: true };
		const GRAY = "\x1b[90m";
		const ITALIC = "\x1b[3m";
		const BOLD = "\x1b[1m";
		const CYAN = "\x1b[36m";
		const UNDERLINE = "\x1b[4m";
		const CODE = "\x1b[33m";

		/** [name, markdown, token that follows the styled span, styles that must be re-applied before it] */
		const reapplyCases: [name: string, text: string, after: string, styles: string[]][] = [
			["h1 after inline code", "# Title with `code` inside", "inside", [BOLD, CYAN, UNDERLINE]],
			["h2 after bold text", "## Heading with **bold** and more", "and more", [BOLD, CYAN]],
			[
				"h3 after inline code",
				"### Why `sourceInfo` should not be optional",
				"should not be optional",
				[BOLD, CYAN],
			],
		];

		for (const [name, text, after, styles] of reapplyCases) {
			it(`re-applies heading styling for ${name}`, () => {
				const output = render(text).join("\n");
				const afterIndex = output.indexOf(after);
				assert.ok(afterIndex > 0, `Should contain text after the styled span: ${output}`);

				const precedingChunk = output.slice(Math.max(0, afterIndex - 40), afterIndex);
				for (const style of styles) {
					assert.ok(precedingChunk.includes(style), `Missing ${JSON.stringify(style)} in ${precedingChunk}`);
				}
			});
		}

		/** Pre-styled thinking traces must keep their own style around inline spans. */
		const preStyledCases: [name: string, text: string, inner: string][] = [
			["inline code", "This is thinking with `inline code` and more text after", CODE],
			["bold text", "This is thinking with **bold text** and more after", BOLD],
		];

		for (const [name, text, inner] of preStyledCases) {
			it(`preserves gray italic styling around ${name}`, () => {
				const output = new Markdown(text, 1, 0, defaultMarkdownTheme, thinking).render(80).join("\n");

				assert.ok(output.includes(GRAY), "Should have gray color code");
				assert.ok(output.includes(ITALIC), "Should have italic code");
				assert.ok(output.includes(inner), "Should style the inline span");
			});
		}

		it("does not leak the h1 underline into the trailing padding", async () => {
			const markdown = new Markdown("# Important distinction from `open()`", 0, 0, defaultMarkdownTheme);
			const terminal = new VirtualTerminal(80, 4);
			const tui = new TUI(terminal);
			tui.addChild(markdown);
			tui.start();
			await terminal.waitForRender();

			const renderedLine = markdown.render(80)[0];
			assert.ok(renderedLine, "Should render heading line");
			const contentWidth = stripAnsi(renderedLine).trimEnd().length;
			assert.ok(contentWidth > 0, "Should have visible heading content");

			for (let col = contentWidth; col < 80; col++) {
				assert.strictEqual(getCellUnderline(terminal, 0, col), 0, `Expected no underline in padding at col ${col}`);
			}
			tui.stop();
		});
	});

	describe("Math delimiter detection", () => {
		/** [name, markdown, expected fragments, fragments that must not appear] */
		const mathCases: [name: string, text: string, expected: string[], absent?: string[]][] = [
			[
				"display math in \\[ ... \\]",
				"Intro:\n\n\\[\ny_t = \\sum_{k=0}^{W-1} w_k \\odot x_{t-k}\n\\]\n\nAfter.",
				["yₜ = ∑ₖ₌₀ᵂ⁻¹ wₖ ⊙ xₜ₋ₖ", "After."],
				["\\sum"],
			],
			["display math in $$ ... $$", "$$\nE = mc^2\n$$", ["E = mc²"]],
			["display math with CRLF line endings", "\\[\r\nE = mc^2\r\n\\]\r\n", ["E = mc²"]],
			["inline math in \\( ... \\)", "where the weights \\(w_k\\) are shared", ["where the weights wₖ are shared"]],
			["inline math in $ ... $", "the value $x_i \\cdot y$ grows", ["the value xᵢ · y grows"]],
			["underscores inside math stay out of emphasis", "\\[ a_k = b_k + x_k \\]", ["aₖ = bₖ + xₖ"]],
			["dollar amounts are not math", "between $5 and $10 total", ["between $5 and $10 total"]],
			["a closing dollar followed by a digit is not math", "prices $5,$10 listed", ["prices $5,$10 listed"]],
			["unterminated display math stays plain while streaming", "$$\ny_t = \\sum", ["$$"]],
			["math inside list items", "- gradient \\(\\nabla_\\theta J\\) step", ["- gradient ∇_θ J step"]],
			[
				"display math inside list items",
				"1. The sum:\n\n   \\[\n   \\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n   \\]\n\n2. Next item",
				["∑ₖ₌₁ⁿ k = (n(n+1))/2", "2. Next item"],
				["\\sum"],
			],
			[
				"indented display math is not treated as code",
				"Math:\n\n    \\[\n    E = mc^2\n    \\]\n\n    $$\n    a^2 + b^2 = c^2\n    $$",
				["E = mc²", "a² + b² = c²"],
				["\\["],
			],
			[
				"indented code that is not math stays a code block",
				"Code:\n\n    const x = 1;\n    return x;",
				["const x = 1;"],
			],
			["fenced code blocks are immune", "```latex\n\\[\nE = mc^2\n\\]\n```", ["\\[", "E = mc^2"], ["E = mc²"]],
			["inline code spans are immune", "run `echo $PATH$HOME` and `$x_i$` now", ["echo $PATH$HOME", "$x_i$"]],
			["multi-line inline math joins with spaces", "a \\(x +\ny\\) b", ["a x + y b"]],
		];

		for (const [name, text, expected, absent] of mathCases) {
			it(name, () => {
				const lines = renderPlain(text);

				for (const fragment of expected) {
					assert.ok(
						lines.some((line) => line.includes(fragment)),
						`Missing ${JSON.stringify(fragment)} in ${JSON.stringify(lines)}`,
					);
				}
				for (const fragment of absent ?? []) {
					assert.ok(
						!lines.some((line) => line.includes(fragment)),
						`Unexpected ${JSON.stringify(fragment)} in ${JSON.stringify(lines)}`,
					);
				}
			});
		}

		it("falls back to the code theme style for math blocks", () => {
			const mathLine = render("$$x + y$$").find((line) => stripAnsi(line).includes("x + y"));

			assert.ok(mathLine);
			assert.ok(mathLine.includes("\x1b[32m"));
		});
	});

	describe("Streaming identity", () => {
		const assertStreamingIdentity = (corpus: string, chunkSize: number, width: number) => {
			const streaming = new Markdown("", 1, 1, defaultMarkdownTheme);
			let text = "";
			for (let offset = 0; offset < corpus.length; offset += chunkSize) {
				text += corpus.slice(offset, offset + chunkSize);
				streaming.setText(text);
				const incremental = streaming.render(width);
				const fresh = new Markdown(text, 1, 1, defaultMarkdownTheme).render(width);
				assert.deepStrictEqual(
					incremental,
					fresh,
					`Streaming render diverged at ${text.length}/${corpus.length} chars`,
				);
			}
		};

		const corpus = [
			"# Title",
			"",
			"Intro paragraph with **bold**, *italic*, and `code` that wraps at narrow widths.",
			"",
			"- item one",
			"- item two",
			"  - nested",
			"- item three",
			"",
			"```ts",
			"function f(x: number) {",
			"  return x * 2;",
			"}",
			"```",
			"",
			"| a | b |",
			"| - | - |",
			"| 1 | 2 |",
			"| 3 | 4 |",
			"",
			"> quote line that is long enough to wrap when rendered at narrow widths",
			"",
			"$$",
			"y_t = \\sum_{k=0}^{W-1} w_k",
			"$$",
			"",
			"Closing paragraph with inline \\(x_i\\) math.",
		].join("\n");

		const streamCases: [name: string, corpus: string, chunkSize: number, width: number][] = [
			["renders identically when streamed in 3-char chunks", corpus, 3, 60],
			["renders identically when streamed in 7-char chunks", corpus, 7, 100],
			[
				"handles a code fence that stays unterminated then closes",
				"Some text\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nAfter fence.",
				4,
				80,
			],
			["handles a paragraph that becomes a setext heading", "Heading text\n===\n\nBody paragraph.", 2, 80],
			[
				"handles math that stays unterminated then closes",
				"Intro.\n\n$$\ny_t = \\sum_{k=0}^{W-1} w_k\n$$\n\nAfter math.",
				4,
				80,
			],
		];

		for (const [name, streamCorpus, chunkSize, width] of streamCases) {
			it(name, () => assertStreamingIdentity(streamCorpus, chunkSize, width));
		}

		it("handles width changes mid-stream", () => {
			const streaming = new Markdown("", 1, 1, defaultMarkdownTheme);
			const widths = [40, 80, 60, 100];
			let text = "";
			for (let offset = 0, i = 0; offset < corpus.length; offset += 16, i++) {
				text += corpus.slice(offset, offset + 16);
				streaming.setText(text);
				const width = widths[i % widths.length];
				const incremental = streaming.render(width);
				const fresh = new Markdown(text, 1, 1, defaultMarkdownTheme).render(width);
				assert.deepStrictEqual(incremental, fresh, `Diverged at ${text.length} chars, width ${width}`);
			}
		});

		it("handles invalidate mid-stream", () => {
			const streaming = new Markdown("", 1, 1, defaultMarkdownTheme);
			let text = "";
			for (let offset = 0, i = 0; offset < corpus.length; offset += 16, i++) {
				text += corpus.slice(offset, offset + 16);
				streaming.setText(text);
				if (i % 5 === 4) streaming.invalidate();
				const incremental = streaming.render(80);
				const fresh = new Markdown(text, 1, 1, defaultMarkdownTheme).render(80);
				assert.deepStrictEqual(incremental, fresh, `Diverged at ${text.length} chars`);
			}
		});
	});
});
