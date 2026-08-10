import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	BENCHMARK_NAME,
	estimateCorpusPlan,
	MAX_CORPUS_BYTES,
	MAX_REPETITIONS,
	parseBenchmarkOptions,
} from "./streaming-json-parse-cpu-bench.js";

const tsxPath = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const benchmarkPath = fileURLToPath(new URL("./streaming-json-parse-cpu-bench.ts", import.meta.url));
const packagePath = fileURLToPath(new URL("../", import.meta.url));

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("streaming JSON CPU benchmark CLI", () => {
	it("parses requested corpus options and writes a content-free atomic JSON result", () => {
		const directory = mkdtempSync(join(tmpdir(), "n01-benchmark-"));
		temporaryDirectories.push(directory);
		const output = join(directory, "result.json");
		execFileSync(
			process.execPath,
			[
				tsxPath,
				benchmarkPath,
				"--name",
				BENCHMARK_NAME,
				"--json",
				output,
				"--escaped-bytes",
				"4096",
				"--unicode-bytes",
				"4096",
				"--repetitions",
				"3",
			],
			{ cwd: packagePath, stdio: "pipe" },
		);
		const result = JSON.parse(readFileSync(output, "utf8")) as {
			name: string;
			results: Array<{ name: string; repetitions: number; inputBytes: number; inputLength: number; order: string }>;
		};
		expect(result.name).toBe("N01-streaming-structured-output-parse-cpu");
		expect(result.results).toHaveLength(2);
		expect(result.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ repetitions: 3, order: "alternating legacy/incremental by repetition" }),
			]),
		);
		expect(result.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "escaped-nested-4096-64", inputBytes: 4096, inputLength: 4096 }),
				expect.objectContaining({ name: "unicode-nested-4096-7", inputBytes: 4096 }),
			]),
		);
		expect(result.results.find(({ name }) => name.startsWith("unicode"))?.inputLength).toBeLessThan(4096);
		expect(JSON.stringify(result)).not.toContain('"outer"');
	});

	it("rejects corpus and repetition limits before estimating or allocating", () => {
		const base = ["--name", BENCHMARK_NAME, "--json", "result.json"];
		expect(() => parseBenchmarkOptions([...base, "--escaped-bytes", String(MAX_CORPUS_BYTES + 1)])).toThrow(
			`--escaped-bytes must be a positive safe integer no greater than ${MAX_CORPUS_BYTES}`,
		);
		expect(() => parseBenchmarkOptions([...base, "--unicode-bytes", String(Number.MAX_SAFE_INTEGER)])).toThrow(
			`--unicode-bytes must be a positive safe integer no greater than ${MAX_CORPUS_BYTES}`,
		);
		expect(() => parseBenchmarkOptions([...base, "--repetitions", String(MAX_REPETITIONS + 1)])).toThrow(
			`--repetitions must be a positive safe integer no greater than ${MAX_REPETITIONS}`,
		);
	});

	it("accepts the fixed corpus boundary in the estimator without allocating the corpus", () => {
		const plan = estimateCorpusPlan(MAX_CORPUS_BYTES, false);
		expect(plan.estimatedBytes).toBeLessThanOrEqual(MAX_CORPUS_BYTES);
		expect(plan.entries).toBeGreaterThan(0);
	});

	it("keeps the nested corpus structural minimum unchanged", () => {
		expect(() => estimateCorpusPlan(67, false)).toThrow("requested 67 bytes is below structural minimum 68");
		expect(estimateCorpusPlan(68, false).structuralMinimum).toBe(68);
	});

	it("rejects a target below the nested corpus structural minimum before measuring", () => {
		const directory = mkdtempSync(join(tmpdir(), "n01-benchmark-"));
		temporaryDirectories.push(directory);
		expect(() =>
			execFileSync(
				process.execPath,
				[
					tsxPath,
					benchmarkPath,
					"--name",
					"N01-streaming-structured-output-parse-cpu",
					"--json",
					join(directory, "result.json"),
					"--escaped-bytes",
					"1",
				],
				{ cwd: packagePath, stdio: "pipe" },
			),
		).toThrow(/below structural minimum/);
	});
});
