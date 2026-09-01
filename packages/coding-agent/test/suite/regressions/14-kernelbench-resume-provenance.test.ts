import { describe, expect, it } from "vitest";
import {
	KERNELBENCH_EVALUATOR_VERSION,
	KERNELBENCH_RESULT_SCHEMA_VERSION,
	type KernelBenchRunProvenance,
	parseKernelBenchResumeResult,
} from "../../../src/evals/kernelbench/runner.js";

function provenance(): KernelBenchRunProvenance {
	return {
		schemaVersion: 1,
		evaluatorVersion: KERNELBENCH_EVALUATOR_VERSION,
		kernelbenchRevision: "a".repeat(40),
		catalogDigest: "b".repeat(64),
		problem: {
			id: 1,
			name: "matrix multiply",
			sourceDigest: "c".repeat(64),
		},
		provider: "google-vertex",
		model: "gemini-test",
		configuration: {
			hardening: true,
			maxTurns: 20,
			timeoutMs: 60_000,
			agentExecutableDigest: "d".repeat(64),
			configDigest: "e".repeat(64),
		},
	};
}

function result(runProvenance = provenance()): Record<string, unknown> {
	return {
		schemaVersion: KERNELBENCH_RESULT_SCHEMA_VERSION,
		provenance: runProvenance,
		problemId: runProvenance.problem.id,
		problemName: runProvenance.problem.name,
		hardware: "test GPU",
		compiled: true,
		correct: true,
		staticValid: true,
		staticErrors: [],
		staticWarnings: [],
		referenceRuntimeMs: 2,
		kernelRuntimeMs: 1,
		speedup: 2,
		fast0: true,
		fast1: true,
		agentExitCode: 0,
		agentTimedOut: false,
		protectedChanges: [],
		durationMs: 100,
		trace: { costUsd: 0, totalTokens: 0 },
		workspacePath: "/tmp/workspace",
		transcriptPath: "/tmp/transcript.log",
	};
}

function changed(
	mutateStored: (stored: KernelBenchRunProvenance) => void,
	mutateExpected?: (expected: KernelBenchRunProvenance) => void,
): () => unknown {
	const stored = structuredClone(provenance());
	const expected = structuredClone(provenance());
	mutateStored(stored);
	mutateExpected?.(expected);
	return () => parseKernelBenchResumeResult(JSON.stringify(result(stored)), expected);
}

describe("issue #14: KernelBench resume provenance", () => {
	it("accepts a complete result only when every provenance field matches", () => {
		const expected = provenance();
		expect(parseKernelBenchResumeResult(JSON.stringify(result(expected)), expected)).toMatchObject({
			problemId: 1,
			problemName: "matrix multiply",
			provenance: expected,
		});
	});

	it("rejects provider and model mismatches", () => {
		expect(changed((stored) => (stored.provider = "openai-codex"))).toThrow(/mismatch for provider/);
		expect(changed((stored) => (stored.model = "different-model"))).toThrow(/mismatch for model/);
	});

	it("rejects configuration and evaluator-version mismatches", () => {
		expect(changed((stored) => (stored.configuration.timeoutMs += 1))).toThrow(
			/mismatch for configuration\.timeoutMs/,
		);
		expect(changed((stored) => (stored.evaluatorVersion = "old-evaluator"))).toThrow(/mismatch for evaluatorVersion/);
	});

	it("rejects catalog and KernelBench revision mismatches", () => {
		expect(changed((stored) => (stored.catalogDigest = "f".repeat(64)))).toThrow(/mismatch for catalogDigest/);
		expect(changed((stored) => (stored.kernelbenchRevision = "0".repeat(40)))).toThrow(
			/mismatch for kernelbenchRevision/,
		);
	});

	it("rejects problem source and result identity mismatches", () => {
		expect(changed((stored) => (stored.problem.sourceDigest = "f".repeat(64)))).toThrow(
			/mismatch for problem\.sourceDigest/,
		);
		const expected = provenance();
		const storedResult = result(expected);
		storedResult.problemId = 2;
		expect(() => parseKernelBenchResumeResult(JSON.stringify(storedResult), expected)).toThrow(
			/resume problem mismatch/,
		);
	});

	it("rejects malformed and legacy result files clearly", () => {
		expect(() => parseKernelBenchResumeResult("{", provenance())).toThrow(/malformed JSON/);
		expect(() => parseKernelBenchResumeResult(JSON.stringify({ problemId: 1 }), provenance())).toThrow(
			/schema mismatch/,
		);
		const malformed = result();
		malformed.trace = { costUsd: "free", totalTokens: 0 };
		expect(() => parseKernelBenchResumeResult(JSON.stringify(malformed), provenance())).toThrow(
			/trace\.costUsd must be a finite number/,
		);
	});
});
