/**
 * Benchmark: streaming-style AssistantMessageComponent updates.
 *
 * Mimics the interactive-mode `message_update` handler: for each token chunk,
 * call updateContent() with the grown message and render(). Run with:
 *
 *   bun test/assistant-message-streaming-bench.ts
 */
import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const SECTION = `## Section heading

Some explanatory paragraph text that wraps across multiple lines when rendered at
typical terminal widths, including **bold**, *italic*, and \`inline code\` spans.

- First list item with enough text to wrap when rendered
- Second list item

\`\`\`typescript
function example(value: number): string {
	return \`result: \${value * 2}\`;
}
\`\`\`

> A blockquote with some content that also wraps when the line is long enough.

`;

function buildCorpus(sections: number): string {
	let corpus = "";
	for (let i = 0; i < sections; i++) {
		corpus += SECTION.replace("Section heading", `Section heading ${i + 1}`);
	}
	return corpus;
}

function createMessage(thinking: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking },
			{ type: "text", text },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function percentile(sorted: number[], p: number): number {
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

function run(label: string, corpus: string, chunkSize: number, width: number): void {
	const thinking = "Considering the request and outlining the response structure before writing.";
	const component = new AssistantMessageComponent(createMessage(thinking, ""));
	const durations: number[] = [];
	let text = "";
	let offset = 0;

	const totalStart = performance.now();
	while (offset < corpus.length) {
		text += corpus.slice(offset, offset + chunkSize);
		offset += chunkSize;
		const start = performance.now();
		component.updateContent(createMessage(thinking, text));
		component.render(width);
		durations.push(performance.now() - start);
	}
	const totalMs = performance.now() - totalStart;

	const sorted = [...durations].sort((a, b) => a - b);
	const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
	const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

	console.log(`\n${label}`);
	console.log(`  updates:        ${durations.length}`);
	console.log(`  total:          ${totalMs.toFixed(1)} ms`);
	console.log(`  mean/update:    ${mean.toFixed(3)} ms`);
	console.log(`  p50/update:     ${percentile(sorted, 50).toFixed(3)} ms`);
	console.log(`  p99/update:     ${percentile(sorted, 99).toFixed(3)} ms`);
	console.log(`  first 100 avg:  ${avg(durations.slice(0, 100)).toFixed(3)} ms`);
	console.log(`  last 100 avg:   ${avg(durations.slice(-100)).toFixed(3)} ms  (growth = O(n) sign if >> first)`);
}

initTheme("dark");
const corpus = buildCorpus(16);
console.log(`corpus length: ${corpus.length} chars`);
run("streaming 4-char chunks @ width 120", corpus, 4, 120);
run("streaming 16-char chunks @ width 120", corpus, 16, 120);
