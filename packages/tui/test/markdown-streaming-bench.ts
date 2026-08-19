import { performance } from "node:perf_hooks";
import { Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

const SECTION = `## Section heading

Some explanatory paragraph text that wraps across multiple lines when rendered at
typical terminal widths, including **bold**, *italic*, and \`inline code\` spans.

- First list item with enough text to wrap when rendered
- Second list item
  - Nested item one
  - Nested item two
- Third list item

\`\`\`typescript
function example(value: number): string {
	const doubled = value * 2;
	return \`result: \${doubled}\`;
}
\`\`\`

| Column A | Column B | Column C |
| -------- | -------- | -------- |
| one      | two      | three    |
| four     | five     | six      |

> A blockquote with some content that also wraps when the line is long enough to
> exceed the available width.

`;

function buildCorpus(sections: number): string {
	let corpus = "";
	for (let i = 0; i < sections; i++) {
		corpus += SECTION.replace("Section heading", `Section heading ${i + 1}`);
	}
	return corpus;
}

function percentile(sorted: number[], p: number): number {
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

function run(label: string, corpus: string, chunkSize: number, width: number): void {
	const md = new Markdown("", 1, 0, defaultMarkdownTheme);
	const durations: number[] = [];
	let text = "";
	let offset = 0;

	const totalStart = performance.now();
	while (offset < corpus.length) {
		text += corpus.slice(offset, offset + chunkSize);
		offset += chunkSize;
		const start = performance.now();
		md.setText(text);
		md.render(width);
		durations.push(performance.now() - start);
	}
	const totalMs = performance.now() - totalStart;

	const sorted = [...durations].sort((a, b) => a - b);
	const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
	const firstN = durations.slice(0, 100);
	const lastN = durations.slice(-100);
	const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

	console.log(`\n${label}`);
	console.log(`  updates:        ${durations.length}`);
	console.log(`  total:          ${totalMs.toFixed(1)} ms`);
	console.log(`  mean/update:    ${mean.toFixed(3)} ms`);
	console.log(`  p50/update:     ${percentile(sorted, 50).toFixed(3)} ms`);
	console.log(`  p99/update:     ${percentile(sorted, 99).toFixed(3)} ms`);
	console.log(`  first 100 avg:  ${avg(firstN).toFixed(3)} ms`);
	console.log(`  last 100 avg:   ${avg(lastN).toFixed(3)} ms  (growth = O(n) sign if >> first)`);
}

const corpus = buildCorpus(12);
console.log(`corpus length: ${corpus.length} chars`);
run("streaming 4-char chunks @ width 120", corpus, 4, 120);
run("streaming 16-char chunks @ width 120", corpus, 16, 120);
