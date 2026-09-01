import { describe, expect, test } from "vitest";
import {
	createSpecBenchGradeDeadline,
	deriveSpecBenchExecutionBudgets,
	SPECBENCH_TIMEOUT_DEFAULTS,
	specBenchRemainingGradeTimeoutMs,
} from "../../../src/evals/specbench/runner.js";

describe("issue #15 SpecBench shared grading timeout", () => {
	test("keeps documented timeout defaults in one source", () => {
		expect(SPECBENCH_TIMEOUT_DEFAULTS).toEqual({
			ipythonCellMinimumMs: 60_000,
			ipythonCellMaximumMs: 120_000,
			gradeSuiteMinimumMs: 30_000,
			gradeSuiteMaximumMs: 120_000,
			gradeTotalMaximumMs: 180_000,
		});
		expect(deriveSpecBenchExecutionBudgets(30)).toEqual({
			ipythonCellTimeoutMs: 60_000,
			gradeSuiteTimeoutMs: 30_000,
			gradeTotalTimeoutMs: 180_000,
		});
	});

	test("caps every sequential suite by the remaining monotonic budget", () => {
		const deadline = createSpecBenchGradeDeadline(180_000, 120_000, 5_000);

		expect(specBenchRemainingGradeTimeoutMs(deadline, 5_000)).toBe(120_000);
		expect(specBenchRemainingGradeTimeoutMs(deadline, 125_000)).toBe(60_000);
		expect(specBenchRemainingGradeTimeoutMs(deadline, 185_000)).toBe(0);
		expect(specBenchRemainingGradeTimeoutMs(deadline, 200_000)).toBe(0);
	});
});
