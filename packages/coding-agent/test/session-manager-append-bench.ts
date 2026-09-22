/**
 * Benchmark: SessionManager append/fork hot paths.
 *
 * - _persist append cost at growing session sizes (the flip-once
 *   has-assistant cache keeps per-append cost flat as entries grow).
 * - forkFrom wall time for source sessions of growing entry counts
 *   (the whole fork flows through one open descriptor).
 *
 * Run with:
 *
 *   npx tsx test/session-manager-append-bench.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "../src/core/session-manager.js";

const SIZES = [1_000, 5_000, 20_000];
const MEASURED_APPENDS = 100;
const FORK_RUNS = 3;

// Session files are built without any assistant entry for the pre-assistant
// scenario (the guard then suppresses every append via the O(1) cache), and
// with an early assistant entry for the steady-state scenario.

function percentile(sorted: number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function buildSourceSession(dir: string, entries: number, firstEntryRole: "user" | "assistant" = "assistant"): string {
	const lines: string[] = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "bench-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		}),
	];
	let parentId: string | null = null;
	for (let i = 0; i < entries; i++) {
		const id = `m${i}`;
		const role = firstEntryRole === "assistant" && (i === 0 || i % 3 === 0) ? "assistant" : "user";
		const text = `benchmark payload ${i} `.repeat(role === "assistant" ? 12 : 5);
		lines.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: new Date(1_767_225_600_000 + i).toISOString(),
				message: {
					role,
					content: [{ type: "text", text }],
					timestamp: 1_767_225_600_000 + i,
					...(role === "assistant"
						? {
								api: "openai-completions",
								provider: "openai",
								model: "test",
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 2,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								stopReason: "stop",
							}
						: {}),
				},
			}),
		);
		parentId = id;
	}
	const file = join(dir, `source-${entries}-${firstEntryRole}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function benchAppend(label: string, sourceFile: string, entries: number): void {
	const mgr = SessionManager.open(sourceFile);
	let leafId = mgr.getLeafId();
	const durations: number[] = [];
	for (let i = 0; i < MEASURED_APPENDS; i++) {
		const start = performance.now();
		mgr.appendMessage({ role: "user", content: `append probe ${i}`, timestamp: Date.now() });
		durations.push(performance.now() - start);
		leafId = mgr.getLeafId();
	}
	const sorted = [...durations].sort((a, b) => a - b);
	const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
	console.log(`\n${label}: append x${MEASURED_APPENDS} into session with ${entries} entries (leaf ${leafId})`);
	console.log(`  mean:   ${mean.toFixed(3)} ms`);
	console.log(`  p50:    ${percentile(sorted, 50).toFixed(3)} ms`);
	console.log(`  p99:    ${percentile(sorted, 99).toFixed(3)} ms`);
}

function benchFork(dir: string, sourceFile: string, entries: number): void {
	const times: number[] = [];
	for (let i = 0; i < FORK_RUNS; i++) {
		const targetDir = mkdtempSync(join(tmpdir(), `pi-fork-bench-target-${entries}-`));
		const start = performance.now();
		SessionManager.forkFrom(sourceFile, dir, targetDir);
		times.push(performance.now() - start);
		rmSync(targetDir, { recursive: true, force: true });
	}
	console.log(
		`\nforkFrom ${entries}-entry source, ${FORK_RUNS} runs: ${times.map((t) => `${t.toFixed(1)} ms`).join(", ")}`,
	);
	console.log(`  best: ${Math.min(...times).toFixed(1)} ms`);
}

const root = mkdtempSync(join(tmpdir(), "pi-session-manager-bench-"));
try {
	for (const entries of SIZES) {
		const sourceFile = buildSourceSession(root, entries);
		benchAppend("post-assistant (append path)", sourceFile, entries);
		benchFork(root, sourceFile, entries);
	}
	for (const entries of SIZES) {
		const sourceFile = buildSourceSession(root, entries, "user");
		benchAppend("pre-assistant (guard path)", sourceFile, entries);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
