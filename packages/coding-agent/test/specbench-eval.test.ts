import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	listSpecBenchTasks,
	parseSpecBenchArgs,
	parseSpecBenchGrade,
	specBenchTaskPrompt,
} from "../src/evals/specbench/runner.js";

describe("SpecBench evaluation runner", () => {
	test("parses explicit task and hardening controls", () => {
		const parsed = parseSpecBenchArgs([
			"--task",
			"json_parser,http_server",
			"--max-turns",
			"18",
			"--hardening",
			"on",
		]);
		expect(parsed.tasks).toEqual(["json_parser", "http_server"]);
		expect(parsed.maxTurns).toBe(18);
		expect(parsed.hardening).toBe(true);
	});

	test("discovers only official task-shaped directories", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-catalog-"));
		const tasks = join(root, "benchmarks", "spec_bench", "tasks");
		for (const name of ["json_parser", "http_server"]) {
			mkdirSync(join(tasks, name), { recursive: true });
			writeFileSync(join(tasks, name, "task.py"), "def get_task(): ...\n");
		}
		mkdirSync(join(tasks, "base"), { recursive: true });
		expect(listSpecBenchTasks(root)).toEqual(["http_server", "json_parser"]);
	});

	test("keeps hidden suites out of the model-facing prompt", () => {
		const prompt = specBenchTaskPrompt({
			taskId: "json_parser",
			displayName: "JSON Parser",
			specDocument: "Support strings and numbers.",
		});
		expect(prompt).toContain("Support strings and numbers.");
		expect(prompt).toContain(".specbench-visible/public");
		expect(prompt).not.toContain("id_private");
		expect(prompt).not.toContain("tests/private");
	});

	test("derives pass rate from host pytest output", () => {
		expect(
			parseSpecBenchGrade({
				exitCode: 1,
				timedOut: false,
				durationMs: 25,
				stdout: "8 passed, 2 failed, 1 skipped in 0.2s",
				stderr: "",
			}),
		).toMatchObject({ total: 10, passed: 8, failed: 2, skipped: 1, passRate: 0.8 });
	});

	test("uses the final pytest summary instead of numbers quoted in a failure body", () => {
		expect(
			parseSpecBenchGrade({
				exitCode: 1,
				timedOut: false,
				durationMs: 25,
				stdout: "assert '10 passed' == 'expected'\n7 passed, 3 failed in 0.2s",
				stderr: "",
			}),
		).toMatchObject({ total: 10, passed: 7, failed: 3, passRate: 0.7 });
	});
});
