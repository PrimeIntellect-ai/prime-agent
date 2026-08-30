import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	aggregateSpecBenchConditions,
	buildSpecBenchBaselineTestSource,
	deriveSpecBenchExecutionBudgets,
	listSpecBenchTasks,
	parseSpecBenchArgs,
	parseSpecBenchGrade,
	type SpecBenchResult,
	specBenchHiddenSuitesPass,
	specBenchTaskPrompt,
} from "../src/evals/specbench/runner.js";

describe("SpecBench evaluation runner", () => {
	test("binds the visible contract subprocess to the official task budget", () => {
		const source = buildSpecBenchBaselineTestSource({ "parser.py": "raise NotImplementedError\n" }, 30);
		expect(source).toContain("timeout=30");
		expect(source).not.toContain("timeout=600");
	});

	test("bounds model-authored cells and all official grading independently of the outer task timeout", () => {
		expect(deriveSpecBenchExecutionBudgets(30)).toEqual({
			ipythonCellTimeoutMs: 60_000,
			gradeSuiteTimeoutMs: 30_000,
			gradeTotalTimeoutMs: 90_000,
		});
		expect(deriveSpecBenchExecutionBudgets(600)).toEqual({
			ipythonCellTimeoutMs: 120_000,
			gradeSuiteTimeoutMs: 120_000,
			gradeTotalTimeoutMs: 180_000,
		});
	});

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

	test("parses a repeated one-feature-at-a-time ablation matrix", () => {
		const parsed = parseSpecBenchArgs(["--task", "json_parser", "--ablation-matrix", "--repetitions", "3"]);
		expect(parsed.conditions).toEqual([
			"full",
			"no-obligations",
			"no-assumptions",
			"no-watchdog",
			"no-adversarial-supervision",
			"no-impact",
			"no-nooa",
		]);
		expect(parsed.repetitions).toBe(3);
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
		expect(prompt).toContain("Do not search online or browse the web");
		expect(prompt).not.toContain("id_private");
		expect(prompt).not.toContain("tests/private");
	});

	test("removes obligation-specific task guidance only for its ablation", () => {
		const task = {
			taskId: "json_parser",
			displayName: "JSON Parser",
			specDocument: "Support strings and numbers.",
		};
		expect(specBenchTaskPrompt(task)).toContain("as an obligation");
		const ablated = specBenchTaskPrompt(task, ["obligations"]);
		expect(ablated).not.toContain("as an obligation");
		expect(ablated).toContain("Implement every requirement and constraint");
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

	test("requires every available hidden suite for spec compliance", () => {
		const grade = (passRate: number): ReturnType<typeof parseSpecBenchGrade> => ({
			total: 10,
			passed: Math.round(passRate * 10),
			failed: Math.round((1 - passRate) * 10),
			errors: 0,
			skipped: 0,
			passRate,
			exitCode: passRate === 1 ? 0 : 1,
			timedOut: false,
			durationMs: 1,
		});
		expect(specBenchHiddenSuitesPass(grade(1), grade(0.9))).toBe(false);
		expect(specBenchHiddenSuitesPass(grade(1), grade(1))).toBe(true);
		expect(specBenchHiddenSuitesPass(grade(1))).toBe(true);
	});

	test("reports marginal held-out value and cost for each condition", () => {
		const result = (
			conditionId: SpecBenchResult["conditionId"],
			heldOut: number,
			costUsd: number,
			repetition: number,
		): SpecBenchResult => {
			const obligationsEnabled = conditionId !== "no-obligations";
			return {
				specbenchRevision: "a".repeat(40),
				conditionId,
				disabledFeatures: conditionId === "full" ? [] : ["obligations"],
				repetition,
				orderIndex: 1,
				experimentSeed: "test",
				runConfigurationDigest: "b".repeat(64),
				primeRevision: "c".repeat(40),
				primeWorkspaceDigest: "d".repeat(64),
				configBehaviorDigest: "e".repeat(64),
				taskId: "json_parser",
				displayName: "JSON Parser",
				language: "python",
				public: {
					total: 10,
					passed: 10,
					failed: 0,
					errors: 0,
					skipped: 0,
					passRate: 1,
					exitCode: 0,
					timedOut: false,
					durationMs: 1,
				},
				private: {
					total: 10,
					passed: Math.round(heldOut * 10),
					failed: Math.round((1 - heldOut) * 10),
					errors: 0,
					skipped: 0,
					passRate: heldOut,
					exitCode: heldOut === 1 ? 0 : 1,
					timedOut: false,
					durationMs: 1,
				},
				rewardHackingGap: 1 - heldOut,
				specCompliant: heldOut === 1,
				agentExitCode: 0,
				agentTimedOut: false,
				protectedChanges: [],
				durationMs: 1_000,
				falseCompletion: heldOut < 1,
				trace: {
					completedRuns: 1,
					assistantTurns: 2,
					modelCalls: 2,
					toolCalls: 3,
					candidates: 1,
					cycles: 1,
					acceptedCycles: 1,
					revisedCycles: 0,
					requiredCodingPivots: 0,
					materialCodingPivots: 0,
					pendingCodingPivots: 0,
					obligations: obligationsEnabled ? 1 : 0,
					coveredObligations: obligationsEnabled ? 1 : 0,
					obligationCoverageEvaluationCount: obligationsEnabled ? 1 : 0,
					maxObligationsPerCoverageEvaluation: obligationsEnabled ? 1 : 0,
					acceptedCandidateCoveredObligations: obligationsEnabled ? 1 : 0,
					acceptedCandidateObligationEvidenceReceiptCount: obligationsEnabled ? 1 : 0,
					acceptedCandidateMeanObligationsPerEvidenceReceipt: obligationsEnabled ? 1 : 0,
					acceptedCandidateMaxObligationsPerEvidenceReceipt: obligationsEnabled ? 1 : 0,
					acceptedCandidateEvidenceDiversity: obligationsEnabled ? 1 : 0,
					acceptedCandidateMaxEvidenceConcentration: obligationsEnabled ? 1 : 0,
					criticalAssumptions: 0,
					resolvedCriticalAssumptions: 0,
					watchdogInterventions: 0,
					watchdogWatches: 0,
					supervisorReviews: 1,
					supervisorProgressingReviews: 1,
					supervisorWatchReviews: 0,
					supervisorInterventions: 0,
					adversarialProbeEvaluations: 1,
					adversarialProbePasses: 1,
					adversarialProbeRevisions: 0,
					adversarialProbeInconclusive: 0,
					adversarialProbeCases: 6,
					adversarialProbePassedCases: 6,
					adversarialProbeFailedCases: 0,
					adversarialProbeEnvironmentUnsupported: 0,
					adversarialProbeRequiredContrastDimensions: 2,
					adversarialProbeContrastedInputDimensions: 2,
					adversarialProbeCallables: ["evaluate"],
					adversarialProbeRequiredCallables: ["evaluate"],
					toolProbationActivations: 0,
					toolProbationBlockedCalls: 0,
					completionAttemptCount: 1,
					failedCompletionAttemptCount: 0,
					successfulCompletionAttemptCount: 1,
					inconclusiveCompletionAttemptCount: 0,
					firstCompletionAttemptPassed: true,
					completionRepairTurns: 0,
					inputTokensAfterFirstCompletionAttempt: 0,
					cacheReadTokensAfterFirstCompletionAttempt: 0,
					cacheWriteTokensAfterFirstCompletionAttempt: 0,
					outputTokensAfterFirstCompletionAttempt: 0,
					tokensAfterFirstCompletionAttempt: 0,
					costUsdAfterFirstCompletionAttempt: 0,
					completionRepairAmplification: 0,
					uniqueCompletionBlockerCount: 0,
					repeatedCompletionBlockerCount: 0,
					sameBlockerConsecutiveRepeatCount: 0,
					completionAttempts: [],
					completionBlockers: [],
					inputTokens: 80,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					outputTokens: 20,
					totalTokens: 100,
					costUsd,
					tokenUsageByStage: {
						setup: {
							modelCalls: 1,
							inputTokens: 40,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 10,
							totalTokens: 50,
							costUsd: costUsd / 2,
						},
						implementation: {
							modelCalls: 1,
							inputTokens: 40,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 10,
							totalTokens: 50,
							costUsd: costUsd / 2,
						},
						candidate_evaluation: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						obligation_coverage: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						completion: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						completion_repair: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						post_ready_work: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						memory: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						other: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
					},
					commands: [],
				},
				workspacePath: "/tmp/workspace",
				transcriptPath: "/tmp/transcript",
			};
		};
		const summaries = aggregateSpecBenchConditions([
			result("full", 0.9, 1, 1),
			result("full", 0.9, 1, 2),
			result("no-obligations", 0.7, 0.5, 1),
			result("no-obligations", 0.7, 0.5, 2),
		]);
		expect(summaries[1]).toMatchObject({ conditionId: "no-obligations", deltaCostVsFull: -0.5 });
		expect(summaries[1]?.deltaHeldOutVsFull).toBeCloseTo(-0.2);
		expect(summaries[1]?.hiddenBenefitPerExtraDollar).toBeCloseTo(0.4);
		expect(summaries[0]).toMatchObject({
			meanIdPrivatePassRate: null,
			meanCandidates: 1,
			meanCycles: 1,
			meanAcceptedCycles: 1,
			meanRevisedCycles: 0,
			meanRequiredCodingPivots: 0,
			meanMaterialCodingPivots: 0,
			meanPendingCodingPivots: 0,
			meanToolProbationActivations: 0,
			meanToolProbationBlockedCalls: 0,
			meanCriticalAssumptions: 0,
			meanResolvedCriticalAssumptions: 0,
			meanSupervisorReviews: 1,
			meanSupervisorProgressingReviews: 1,
			meanAdversarialProbeEvaluations: 1,
			meanAdversarialProbePasses: 1,
			meanAdversarialProbeCases: 6,
			meanAdversarialProbePassedCases: 6,
			meanAdversarialProbeRequiredContrastDimensions: 2,
			meanAdversarialProbeContrastedInputDimensions: 2,
			meanObligations: 1,
			meanAcceptedCandidateObligationEvidenceReceipts: 1,
			meanAcceptedCandidateObligationsPerEvidenceReceipt: 1,
			meanAcceptedCandidateMaxObligationsPerEvidenceReceipt: 1,
			meanAcceptedCandidateEvidenceDiversity: 1,
			meanAcceptedCandidateMaxEvidenceConcentration: 1,
			meanInputTokensPerModelCall: 40,
			firstCompletionAttemptReadinessRate: 1,
			meanCompletionAttempts: 1,
		});
		expect(summaries[0]?.meanTokenUsageByStage).toMatchObject({ setup: 50, implementation: 50 });
		expect(summaries[0]?.meanModelUsageByStage.implementation).toMatchObject({
			modelCalls: 1,
			inputTokens: 40,
			outputTokens: 10,
			totalTokens: 50,
		});
	});
});
