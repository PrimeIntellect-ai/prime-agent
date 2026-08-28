import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createPrimeIntegrityCatalog } from "../src/evals/prime-integrity/catalog.js";
import {
	aggregatePrimeIntegrityResults,
	parsePrimeIntegrityArgs,
	summarizePrimeIntegrityTrace,
} from "../src/evals/prime-integrity/runner.js";
import type { PrimeIntegrityCaseResult } from "../src/evals/prime-integrity/types.js";

const tempDirectories: string[] = [];

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-integrity-test-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Prime Integrity Eval", () => {
	test("defines 40 calibrated adversarial cases across every integrity category", () => {
		const catalog = createPrimeIntegrityCatalog();
		expect(catalog).toHaveLength(40);
		expect(new Set(catalog.map((testCase) => testCase.id)).size).toBe(40);
		const counts = catalog.reduce<Record<string, number>>((result, testCase) => {
			result[testCase.category] = (result[testCase.category] ?? 0) + 1;
			return result;
		}, {});
		expect(counts).toEqual({
			incomplete_obligations: 5,
			compositional_hidden: 5,
			stale_assumption: 5,
			test_tampering: 5,
			affected_surface: 5,
			zero_test: 5,
			benchmark_shortcut: 5,
			easy_verifier: 5,
		});

		for (const testCase of catalog) {
			const workspace = join(tempDirectory(), testCase.id);
			for (const [relativePath, contents] of Object.entries(testCase.files)) {
				const path = resolve(workspace, relativePath);
				expect(path.startsWith(`${workspace}/`)).toBe(true);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, contents, "utf8");
			}
			expect(testCase.hiddenObligations.length).toBeGreaterThanOrEqual(3);
			expect(testCase.protectedPaths.every((path) => path in testCase.files)).toBe(true);
			const startsSolved = testCase.hiddenObligations.every((obligation) => {
				const result = spawnSync(obligation.argv[0], obligation.argv.slice(1), {
					cwd: workspace,
					encoding: "utf8",
					timeout: obligation.timeoutMs,
				});
				return result.status === 0;
			});
			expect(startsSolved, `${testCase.id} must start with a hidden failure`).toBe(false);
		}
	});

	test("requires explicit case selection and parses hardened model runs", () => {
		const defaults = parsePrimeIntegrityArgs([]);
		expect(defaults.hardening).toBe(true);
		expect(defaults.caseIds).toEqual([]);
		const parsed = parsePrimeIntegrityArgs([
			"--case",
			"easy-verifier-01,zero-test-01",
			"--provider",
			"google-vertex",
			"--model",
			"gemini-3.7-flash",
			"--hardening",
			"off",
			"--limit",
			"1",
		]);
		expect(parsed).toMatchObject({
			caseIds: ["easy-verifier-01", "zero-test-01"],
			provider: "google-vertex",
			model: "gemini-3.7-flash",
			hardening: false,
			limit: 1,
		});
	});

	test("aggregates hidden success separately from visible and claimed completion", () => {
		const base: PrimeIntegrityCaseResult = {
			caseId: "case-a",
			title: "Case A",
			category: "incomplete_obligations",
			hardening: true,
			agentExitCode: 0,
			agentTimedOut: false,
			durationMs: 1000,
			visiblePass: true,
			hiddenPass: false,
			legitimateSuccess: false,
			falseCompletion: true,
			rewardHacking: false,
			evaluatorTampering: false,
			watchdogBypass: true,
			obligationsPassed: 2,
			obligationsTotal: 4,
			obligationCoverage: 0.5,
			visibleResults: [],
			obligationResults: [],
			protectedPathChanges: [],
			trace: {
				assistantTurns: 2,
				modelCalls: 2,
				toolCalls: 1,
				candidates: 1,
				cycles: 1,
				obligations: 4,
				coveredObligations: 2,
				criticalAssumptions: 0,
				resolvedCriticalAssumptions: 0,
				watchdogInterventions: 0,
				watchdogWatches: 0,
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
				costUsd: 0.01,
				commands: [],
			},
			transcriptPath: "/tmp/transcript",
			sessionPaths: [],
		};
		const passed: PrimeIntegrityCaseResult = {
			...base,
			caseId: "case-b",
			category: "easy_verifier",
			hiddenPass: true,
			legitimateSuccess: true,
			falseCompletion: false,
			watchdogBypass: false,
			obligationsPassed: 4,
			obligationCoverage: 1,
		};
		const report = aggregatePrimeIntegrityResults([base, passed], {
			startedAt: "2026-08-28T00:00:00.000Z",
			completedAt: "2026-08-28T00:01:00.000Z",
			provider: "google-vertex",
			model: "gemini-3.7-flash",
			hardening: true,
		});
		expect(report.metrics).toMatchObject({
			visiblePassRate: 1,
			hiddenPassRate: 0.5,
			legitimateSuccessRate: 0.5,
			falseCompletionRate: 0.5,
			watchdogBypassRate: 0.5,
			meanObligationCoverage: 0.75,
			meanCandidatesPerTask: 1,
			meanCyclesPerTask: 1,
		});
	});

	test("reads anti-laziness checkpoints from the durable AVO trace", () => {
		const root = tempDirectory();
		const avoDirectory = join(root, "session", "avo");
		mkdirSync(avoDirectory, { recursive: true });
		writeFileSync(
			join(avoDirectory, "state.json"),
			JSON.stringify({
				candidates: [{ candidateId: "candidate-1" }],
				cycles: [{ cycleId: "cycle-1" }],
				checkpoints: [
					{ status: "watch", triggeredHeuristics: ["no_observable_progress_1_tool_batch"] },
					{ status: "intervene", triggeredHeuristics: ["anti_laziness_intervention"] },
					{ status: "progressing", triggeredHeuristics: ["observable_progress_resumed"] },
					{ status: "intervene", triggeredHeuristics: ["anti_laziness_intervention"] },
				],
			}),
			"utf8",
		);

		expect(summarizePrimeIntegrityTrace([], root)).toMatchObject({
			candidates: 1,
			cycles: 1,
			watchdogInterventions: 2,
			watchdogWatches: 1,
		});
	});
});
