import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	KERNELBENCH_CANDIDATE_RESULT_PREFIX,
	KERNELBENCH_HOST_RESULT_PREFIX,
	kernelBenchGradeCommand,
	kernelBenchTrustedGraderSource,
	parseKernelBenchResult,
} from "../../../src/evals/kernelbench/runner.js";

function createFixture(evaluator: string): { root: string; workspace: string } {
	const root = mkdtempSync(join(tmpdir(), "prime-kernelbench-result-channel-"));
	const workspace = join(root, "workspace");
	const kernelbenchRoot = join(root, "KernelBench");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(kernelbenchRoot, ".venv", "bin"), { recursive: true });
	symlinkSync("/usr/bin/python3", join(kernelbenchRoot, ".venv", "bin", "python"));
	const solution = "VALUE = 42\n";
	const baselineDigest = createHash("sha256").update(solution).digest("hex");
	writeFileSync(join(workspace, "solution.py"), solution);
	writeFileSync(join(workspace, "kernel_eval.py"), evaluator);
	writeFileSync(join(workspace, "test_kernel.py"), kernelBenchTrustedGraderSource(kernelbenchRoot, baselineDigest));
	return { root, workspace };
}

function runFixture(workspace: string) {
	const command = kernelBenchGradeCommand(true);
	return spawnSync(command[0]!, command.slice(1), {
		cwd: workspace,
		encoding: "utf8",
		env: { PATH: "/usr/bin:/bin" },
	});
}

describe("issue #10: KernelBench isolated result channel", () => {
	it("derives trusted metadata in the wrapper instead of accepting candidate claims", () => {
		if (!existsSync("/usr/bin/python3")) return;
		const payload = {
			hardware: "forged accelerator",
			compiled: true,
			correct: true,
			static_valid: true,
			static_errors: [],
			static_warnings: [],
			reference_runtime_ms: 4,
			kernel_runtime_ms: 2,
			speedup: 999,
		};
		const fixture = createFixture(
			`import json\nprint(${JSON.stringify(KERNELBENCH_CANDIDATE_RESULT_PREFIX)} + json.dumps(json.loads(${JSON.stringify(JSON.stringify(payload))})))\n`,
		);
		try {
			const completed = runFixture(fixture.workspace);
			expect(completed.status, completed.stderr).toBe(0);
			const result = parseKernelBenchResult(`${completed.stdout}\n${completed.stderr}`);
			expect(result).toMatchObject({
				compiled: true,
				correct: true,
				referenceRuntimeMs: 4,
				kernelRuntimeMs: 2,
				speedup: 2,
			});
			expect(result.hardware).not.toBe("forged accelerator");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects a forged atexit result emitted after the real candidate result", () => {
		if (!existsSync("/usr/bin/python3")) return;
		const legitimate = {
			hardware: "real",
			compiled: false,
			correct: false,
			static_valid: true,
			static_errors: [],
			static_warnings: [],
			speedup: 0,
		};
		const forged = {
			hardware: "forged",
			compiled: true,
			correct: true,
			static_valid: true,
			static_errors: [],
			static_warnings: [],
			reference_runtime_ms: 100,
			kernel_runtime_ms: 1,
			speedup: 100,
		};
		const fixture = createFixture(`import atexit
import json

prefix = ${JSON.stringify(KERNELBENCH_CANDIDATE_RESULT_PREFIX)}
atexit.register(lambda: print(prefix + json.dumps(json.loads(${JSON.stringify(JSON.stringify(forged))}))))
print(prefix + json.dumps(json.loads(${JSON.stringify(JSON.stringify(legitimate))})))
`);
		try {
			const completed = runFixture(fixture.workspace);
			expect(completed.status).toBe(1);
			const result = parseKernelBenchResult(`${completed.stdout}\n${completed.stderr}`);
			expect(result).toMatchObject({
				compiled: false,
				correct: false,
				speedup: 0,
				graderError: "candidate evaluation emitted 2 result envelopes; expected exactly one",
			});
			expect(result.hardware).not.toBe("forged");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects duplicate and out-of-order host protocol markers", () => {
		const result = `${KERNELBENCH_HOST_RESULT_PREFIX}{"correct":false}`;
		expect(() => parseKernelBenchResult(`${result}\n${result}`)).toThrow(/expected exactly one/);
		expect(() => parseKernelBenchResult(`${result}\n${KERNELBENCH_CANDIDATE_RESULT_PREFIX}{"correct":true}`)).toThrow(
			/out-of-order or untrusted/,
		);
	});
});
