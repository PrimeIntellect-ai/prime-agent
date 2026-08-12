import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";
import { buildRlmBootstrapCode } from "../src/core/tools/ipython.js";

describe("IPython RLM bootstrap", () => {
	it("pre-imports asyncio so the prompt's subagent patterns work without a manual import", () => {
		expect(buildRlmBootstrapCode()).toMatch(/^import asyncio$/m);
	});

	it("gives subagent registry operations the actionable missing-runtime fallback", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain('async def find_models(self, query="", limit=8)');
		expect(code).toContain("async def list_subagents(self)");
		expect(code).toContain("async def delete_subagent(self, target)");
		expect(code).toContain("self._raise_missing()");
	});

	it("disables colored output for subprocesses launched by the kernel", () => {
		expect(buildRlmBootstrapCode()).toContain('_prime_agent_os.environ["NO_COLOR"] = "1"');
	});

	it("bounds async bash output and cleans process groups on exceptional exits", () => {
		const code = buildRlmBootstrapCode();
		expect(code).not.toContain("proc.communicate()");
		expect(code).toContain("_PrimeAgentBoundedBytes");
		expect(code).toContain("start_new_session");
		expect(code).toContain("killpg");
		expect(code).toContain("except BaseException");
		expect(code).toContain("isinstance(max_output_bytes, bool)");
		expect(code).toContain("captured {self.stdout_total_bytes} raw bytes; showing a bounded decoded tail");
		expect(code).not.toContain("of {self.stdout_total_bytes} bytes");
		expect(code).not.toContain("taskkill");
	});

	it("guards Python skill imports so a broken skill does not abort bootstrap", () => {
		const code = buildRlmBootstrapCode([
			{
				name: "broken-skill",
				importName: "broken_skill",
				packagePath: "/tmp/broken-skill",
				pyprojectPath: "/tmp/broken-skill/pyproject.toml",
			},
		]);

		expect(code).toContain("except Exception as _prime_agent_skill_error");
		expect(code).toContain("_PrimeAgentUnavailableSkill");
		expect(code).toContain("_PRIME_AGENT_SKILL_IMPORT_ERRORS");
		expect(code).toContain("globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill");
	});
});

/** Find a python that can launch an ipykernel, or null to skip. */
function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("IPython RLM bootstrap (real kernel)", () => {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-bootstrap-"));

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("binds asyncio in the user namespace", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			const bootstrap = await manager.execute(buildRlmBootstrapCode());
			expect(bootstrap.status).toBe("ok");

			const result = await manager.execute("_t = asyncio.create_task(asyncio.sleep(0))\nprint(type(_t).__name__)");
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("Task");

			const bashResult = await manager.execute('%%bash\nprintf %s "$NO_COLOR"');
			expect(bashResult.status).toBe("ok");
			expect(bashResult.stdout).toBe("1");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("renders command output when await bash is the final expression", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			expect((await manager.execute(buildRlmBootstrapCode())).status).toBe("ok");
			const result = await manager.execute('await bash("printf visible-output")');
			expect(result.status).toBe("ok");
			expect(result.result).toContain("visible-output");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("runs async bash with bounded stdout and stderr capture", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			expect((await manager.execute(buildRlmBootstrapCode())).status).toBe("ok");
			const code = [
				"import sys",
				'r = await bash("yes A | head -c 200000; yes B | head -c 200000 >&2", max_output_bytes=4096)',
				"print(r.returncode, len(r.stdout), len(r.stderr), r.stdout_truncated, r.stderr_truncated)",
				"print(r.stdout_total_bytes, r.stderr_total_bytes)",
				'print(str(r).count("truncated"))',
			].join("\n");
			const result = await manager.execute(code);
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("0 4096 4096 True True");
			expect(result.stdout).toContain("200000 200000");
			expect(result.stdout).toContain("2");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("preserves valid UTF-8 command output", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			expect((await manager.execute(buildRlmBootstrapCode())).status).toBe("ok");
			const result = await manager.execute(`r = await bash("printf héllo")\nprint(repr(r.stdout))`);
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("héllo");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("keeps malformed byte output within the rendered capture bound", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			expect((await manager.execute(buildRlmBootstrapCode())).status).toBe("ok");
			const result = await manager.execute(
				'r = await bash("yes ÿ | head -c 100000", max_output_bytes=4096)\nprint(len(r.stdout.encode("utf-8")), len(repr(r).encode("utf-8")), r.stdout_truncated)',
			);
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("4096");
			expect(result.stdout).toContain("True");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("cleans background descendants after the shell exits", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		const marker = join(dir, "background-marker");
		try {
			await manager.start();
			expect((await manager.execute(buildRlmBootstrapCode())).status).toBe("ok");
			const result = await manager.execute(`r = await bash("(sleep 1; touch '${marker}') &")\nprint(r.returncode)`);
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("0");
			await new Promise((resolve) => setTimeout(resolve, 1300));
			expect(existsSync(marker)).toBe(false);
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("escalates when a descendant ignores SIGTERM and closes pipes", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		const marker = join(dir, "term-resistant-marker");
		try {
			await manager.start();
			expect((await manager.execute(buildRlmBootstrapCode())).status).toBe("ok");
			const result = await manager.execute(
				`await bash("(trap '' TERM; exec 1>&- 2>&-; sleep 1; touch '${marker}') &")`,
			);
			expect(result.status).toBe("ok");
			await new Promise((resolve) => setTimeout(resolve, 1300));
			expect(existsSync(marker)).toBe(false);
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("kills descendants on timeout and cancellation", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			expect((await manager.execute(buildRlmBootstrapCode())).status).toBe("ok");
			const timeoutMarker = join(dir, "timeout-marker");
			const cancelMarker = join(dir, "cancel-marker");
			const timeout = await manager.execute(
				`try:
    await bash("(sleep 1; touch '${timeoutMarker}') & wait", timeout=0.1)
except TimeoutError:
    print("timed-out")`,
			);
			expect(timeout.status).toBe("ok");
			expect(timeout.stdout).toContain("timed-out");
			const cancelled = await manager.execute(
				`task = asyncio.create_task(bash("(sleep 1; touch '${cancelMarker}') & wait"))
await asyncio.sleep(0.1)
task.cancel()
try:
    await task
except asyncio.CancelledError:
    print("cancelled")`,
			);
			expect(cancelled.status).toBe("ok");
			expect(cancelled.stdout).toContain("cancelled");
			await new Promise((resolve) => setTimeout(resolve, 1300));
			expect(existsSync(timeoutMarker)).toBe(false);
			expect(existsSync(cancelMarker)).toBe(false);
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("emits canonical paths for edits after the kernel changes directories", async () => {
		const firstDir = join(dir, "first");
		const secondDir = join(dir, "second");
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		writeFileSync(join(firstDir, "same.txt"), "old");
		writeFileSync(join(secondDir, "same.txt"), "old");
		const editSkillRoot = join(process.cwd(), "skills", "edit");
		const manager = new KernelManager({
			python: python as string,
			cwd: dir,
			env: { PYTHONPATH: join(editSkillRoot, "src") },
		});
		try {
			await manager.start();
			const bootstrap = await manager.execute(
				buildRlmBootstrapCode([
					{
						name: "edit",
						importName: "edit",
						packagePath: editSkillRoot,
						pyprojectPath: join(editSkillRoot, "pyproject.toml"),
					},
				]),
			);
			expect(bootstrap.status).toBe("ok");

			const first = await manager.execute(
				'import os\nos.chdir("first")\nawait edit(path="same.txt", old_str="old", new_str="new")',
			);
			const second = await manager.execute(
				'os.chdir("../second")\nawait edit(path="same.txt", old_str="old", new_str="new")',
			);

			expect(first.diffs?.[0]?.path).toBe(realpathSync(join(firstDir, "same.txt")));
			expect(second.diffs?.[0]?.path).toBe(realpathSync(join(secondDir, "same.txt")));
			expect(first.diffs?.[0]?.path).not.toBe(second.diffs?.[0]?.path);
		} finally {
			await manager.dispose();
		}
	}, 60_000);
});
