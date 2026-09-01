import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseKernelBenchArgs } from "../../../src/evals/kernelbench/runner.js";
import { parsePrimeIntegrityArgs } from "../../../src/evals/prime-integrity/runner.js";
import { parseSpecBenchArgs } from "../../../src/evals/specbench/runner.js";

interface ParserCase {
	name: string;
	parse: (argv: string[]) => unknown;
	pathFlags: string[];
	numericFlags: string[];
	otherValueFlags: string[];
}

const PARSERS: ParserCase[] = [
	{
		name: "Prime Integrity",
		parse: parsePrimeIntegrityArgs,
		pathFlags: ["--agent-command", "--config-source", "--output"],
		numericFlags: ["--limit", "--timeout-ms", "--max-turns"],
		otherValueFlags: ["--case", "--provider", "--model", "--hardening"],
	},
	{
		name: "KernelBench",
		parse: parseKernelBenchArgs,
		pathFlags: ["--agent-command", "--config-source", "--kernelbench-root", "--output"],
		numericFlags: ["--problem", "--limit", "--max-turns", "--timeout-ms"],
		otherValueFlags: ["--provider", "--model", "--hardening"],
	},
	{
		name: "SpecBench",
		parse: parseSpecBenchArgs,
		pathFlags: ["--agent-command", "--config-source", "--specbench-root", "--output"],
		numericFlags: ["--limit", "--max-turns", "--timeout-ms", "--repetitions"],
		otherValueFlags: ["--task", "--provider", "--model", "--hardening", "--condition", "--experiment-seed"],
	},
];

describe("issue #16: evaluator CLI option operands", () => {
	for (const parser of PARSERS) {
		it(`${parser.name} rejects missing and flag-like operands before parsing`, () => {
			for (const flag of [...parser.pathFlags, ...parser.numericFlags, ...parser.otherValueFlags]) {
				expect(() => parser.parse([flag]), `${flag} without an operand`).toThrow(flag);
				expect(() => parser.parse([flag, "--help"]), `${flag} followed by another flag`).toThrow(flag);
				expect(() => parser.parse([flag, "-h"]), `${flag} followed by a short flag`).toThrow(flag);
				expect(() => parser.parse([flag, ""]), `${flag} followed by an empty operand`).toThrow(flag);
			}
		});
	}

	it("resolves valid path operands only after validation", () => {
		expect(parsePrimeIntegrityArgs(["--output", "results"]).outputDir).toBe(resolve("results"));
		expect(parseKernelBenchArgs(["--kernelbench-root", "KernelBench"]).kernelbenchRoot).toBe(resolve("KernelBench"));
		expect(parseSpecBenchArgs(["--specbench-root", "SpecBench"]).specbenchRoot).toBe(resolve("SpecBench"));
	});
});
