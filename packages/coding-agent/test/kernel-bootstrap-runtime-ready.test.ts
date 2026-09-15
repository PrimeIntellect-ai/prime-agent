import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_READY_CHECK } from "../src/core/kernel/bootstrap.js";

const runtimePython = resolve("../../prime-agent-runtime/.venv/bin/python");
const fallbackPython = join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");

function resolveKernelPython(): string | null {
	for (const python of [process.env.PRIME_AGENT_KERNEL_PYTHON, runtimePython, fallbackPython]) {
		if (!python || !existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, mcp, rlm"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

/**
 * The ready check is the gate that decides whether a cached kernel venv can be
 * reused or must be rebuilt. These regressions execute the exact shipped check
 * string against a real runtime: it must accept the current runtime, and it must
 * reject a runtime that predates the MCP discovery surface by simulating each
 * missing method in-process.
 */
describeIfKernel("kernel bootstrap runtime ready check", () => {
	it("accepts the current runtime", () => {
		const result = spawnSync(python as string, ["-c", RUNTIME_READY_CHECK], {
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.stderr, result.stderr).toBe("");
		expect(result.status).toBe(0);
	});

	it("rejects a runtime missing any MCP discovery method", () => {
		for (const method of ["list_plugins", "search_plugins", "list_connections", "search_tools", "describe_tool"]) {
			// Simulate an old runtime: delete one discovery method from the
			// already-imported module, then execute the exact ready check.
			const source = [
				"import os, rlm.mcp as mcp",
				`delattr(mcp, ${JSON.stringify(method)})`,
				'exec(os.environ["PRIME_AGENT_TEST_READY_CHECK"])',
			].join("; ");
			const result = spawnSync(python as string, ["-c", source], {
				encoding: "utf8",
				timeout: 30_000,
				env: { ...process.env, PRIME_AGENT_TEST_READY_CHECK: RUNTIME_READY_CHECK },
			});
			expect(result.status, `a runtime without ${method} must fail the ready check`).not.toBe(0);
			expect(result.stderr).toContain("MCP discovery");
		}
	});
});
