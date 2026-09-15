import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveReplPython();
const describeIfKernel = python ? describe : describe.skip;

// ENG-5339: the kernel is spawned with cwd = project directory. Without safe
// path, CPython puts that directory at sys.path[0], so a checkout carrying an
// `rlm/` package, a `dill.py`, or a stdlib-named module runs in place of the
// runtime's own imports (the shadow `rlm/repl.py` executes before the ready
// handshake; a shadow `dill.py` is imported lazily by the first snapshot).
describeIfKernel(
	"repl kernel import resolution from a project directory (real runtime)",
	{ tags: ["kernel-heavy"] },
	() => {
		let projectDir = "";
		let snapshotDir = "";

		function marker(name: string): string {
			return join(projectDir, `MARKER_${name}`);
		}

		function writeShadowModules(): void {
			mkdirSync(join(projectDir, "rlm"), { recursive: true });
			writeFileSync(join(projectDir, "rlm", "__init__.py"), "");
			writeFileSync(
				join(projectDir, "rlm", "repl.py"),
				[
					"import pathlib, sys",
					`pathlib.Path(${JSON.stringify(marker("RLM"))}).write_text('repo-local rlm/repl.py executed')`,
					"sys.exit(3)",
					"",
				].join("\n"),
			);
			writeFileSync(
				join(projectDir, "dill.py"),
				[
					"import pathlib",
					`pathlib.Path(${JSON.stringify(marker("DILL"))}).write_text('repo-local dill.py imported')`,
					"raise ImportError('repo-local dill shadow')",
					"",
				].join("\n"),
			);
			// A stdlib name the runtime imports at startup.
			writeFileSync(
				join(projectDir, "json.py"),
				[
					"import pathlib",
					`pathlib.Path(${JSON.stringify(marker("JSON"))}).write_text('repo-local json.py imported')`,
					"raise ImportError('repo-local json shadow')",
					"",
				].join("\n"),
			);
			writeFileSync(join(projectDir, "repo_local_module.py"), "VALUE = 'project'\n");
		}

		beforeEach(() => {
			projectDir = realpathSync(mkdtempSync(join(tmpdir(), "prime-agent-repl-safe-path-project-")));
			snapshotDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-safe-path-snapshot-"));
			writeShadowModules();
		});

		afterEach(() => {
			if (projectDir) rmSync(projectDir, { recursive: true, force: true });
			if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
			projectDir = "";
			snapshotDir = "";
		});

		it("ignores repository-local rlm/, dill.py, and stdlib-named modules in the kernel cwd", async () => {
			const manager = new ReplKernelManager({
				python: python as string,
				cwd: projectDir,
				snapshot: {
					path: join(snapshotDir, "kernel-state.dill"),
					manifestPath: join(snapshotDir, "kernel-state.json"),
				},
			});
			try {
				const probe = await manager.execute(
					[
						"import json, os, sys",
						"import rlm, rlm.repl, dill",
						"rlm_repl = sys.modules['rlm.repl']",
						"print(json.dumps({",
						"    'safe_path': bool(sys.flags.safe_path),",
						"    'cwd': os.getcwd(),",
						"    'sys_path': sys.path,",
						"    'rlm': rlm.__file__,",
						"    'rlm_repl': rlm_repl.__file__,",
						"    'dill': dill.__file__,",
						"    'json': json.__file__,",
						"    'dill_has_dumps': callable(getattr(dill, 'dumps', None)),",
						"}))",
					].join("\n"),
				);
				expect(probe.status, JSON.stringify(probe)).toBe("ok");
				const report = JSON.parse(probe.stdout) as {
					safe_path: boolean;
					cwd: string;
					sys_path: string[];
					rlm: string;
					rlm_repl: string;
					dill: string;
					json: string;
					dill_has_dumps: boolean;
				};
				expect(realpathSync(report.cwd)).toBe(projectDir);
				expect(report.safe_path).toBe(true);
				expect(report.sys_path).not.toContain("");
				expect(report.sys_path.map((entry) => (existsSync(entry) ? realpathSync(entry) : entry))).not.toContain(
					projectDir,
				);
				for (const file of [report.rlm, report.rlm_repl, report.dill, report.json]) {
					expect(realpathSync(file).startsWith(`${projectDir}/`)).toBe(false);
				}
				expect(report.dill_has_dumps).toBe(true);

				// Project modules are not importable from the kernel: the model is told to
				// run project code through the project's own environment.
				const projectImport = await manager.execute("import repo_local_module");
				expect(projectImport.status).toBe("error");
				expect(projectImport.error?.ename).toBe("ModuleNotFoundError");

				// The lazy snapshot path resolves the real dill, not the repo-local one.
				await manager.execute("snapshot_probe = 42");
				const snapshot = await manager.snapshotState();
				expect(snapshot?.saved).toContain("snapshot_probe");

				expect(existsSync(marker("RLM"))).toBe(false);
				expect(existsSync(marker("DILL"))).toBe(false);
				expect(existsSync(marker("JSON"))).toBe(false);
			} finally {
				await manager.shutdown({ snapshot: false, drainHostRequests: true });
			}
		}, 60_000);
	},
);
