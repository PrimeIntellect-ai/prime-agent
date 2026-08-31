import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildKernelBenchGradeSandboxArgs,
	kernelBenchGradeCommand,
	kernelBenchGradeEnvironment,
} from "../../../src/evals/kernelbench/runner.js";

describe("issue #9: KernelBench authoritative grader sandbox", () => {
	it("isolates credentials, home, runtime, network, and host writes", () => {
		if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3")) {
			return;
		}
		const root = mkdtempSync(join(tmpdir(), "prime-kernelbench-grade-"));
		const homeCanary = mkdtempSync(join(homedir(), ".prime-kernelbench-grade-canary-"));
		const workspace = join(root, "workspace");
		const buildCache = join(root, "build-cache");
		const kernelbenchRoot = join(root, "KernelBench");
		const hostTarget = join(root, "host-target.txt");
		const runtimeRoot = process.env.XDG_RUNTIME_DIR;
		const runtimeCanary =
			runtimeRoot && existsSync(runtimeRoot)
				? mkdtempSync(join(runtimeRoot, "prime-kernelbench-grade-canary-"))
				: undefined;
		try {
			mkdirSync(workspace, { recursive: true });
			mkdirSync(buildCache, { recursive: true });
			mkdirSync(join(kernelbenchRoot, ".venv", "bin"), { recursive: true });
			symlinkSync("/usr/bin/python3", join(kernelbenchRoot, ".venv", "bin", "python"));
			writeFileSync(join(workspace, "solution.py"), "VALUE = 42\n");
			writeFileSync(join(workspace, "test_kernel.py"), "CONTROL = 'host-owned'\n");
			writeFileSync(join(homeCanary, "secret.txt"), "home-secret\n");
			if (runtimeCanary) writeFileSync(join(runtimeCanary, "socket-token"), "runtime-secret\n");
			writeFileSync(hostTarget, "safe\n");

			const probe = `import json
import os
import pathlib
import socket

workspace = pathlib.Path(${JSON.stringify(workspace)})
build_cache = pathlib.Path(${JSON.stringify(buildCache)})
host_target = pathlib.Path(${JSON.stringify(hostTarget)})
results = {
	"capabilities_dropped": int(next(line.split()[1] for line in pathlib.Path("/proc/self/status").read_text().splitlines() if line.startswith("CapEff:")), 16) == 0,
    "credential_hidden": "VERTEX_API_KEY" not in os.environ and "SSH_AUTH_SOCK" not in os.environ,
    "home_hidden": not pathlib.Path(${JSON.stringify(homeCanary)}).exists(),
	"runtime_hidden": not pathlib.Path(${JSON.stringify(runtimeCanary ?? "/run/prime-kernelbench-missing")}).exists(),
	"control_file_read_only": False,
    "workspace_read_only": False,
    "network_blocked": False,
}
try:
    (workspace / "solution.py").write_text("compromised\\n", encoding="utf-8")
except OSError:
    results["workspace_read_only"] = True
try:
    (workspace / "test_kernel.py").write_text("compromised\\n", encoding="utf-8")
except OSError:
    results["control_file_read_only"] = True
try:
    host_target.write_text("compromised\\n", encoding="utf-8")
except OSError:
    pass
(build_cache / "sandbox-output.txt").write_text("allowed\\n", encoding="utf-8")
try:
    socket.create_connection(("8.8.8.8", 53), timeout=0.2)
except OSError:
    results["network_blocked"] = True
print(json.dumps(results, sort_keys=True))
`;
			const environment = kernelBenchGradeEnvironment(
				{ ...process.env, VERTEX_API_KEY: "secret", SSH_AUTH_SOCK: "/run/host-agent.sock" },
				kernelbenchRoot,
				buildCache,
			);
			const args = buildKernelBenchGradeSandboxArgs(
				["/usr/bin/python3", "-I", "-c", probe],
				workspace,
				buildCache,
				kernelbenchRoot,
				environment,
			);
			expect(args).toEqual(
				expect.arrayContaining([
					"--unshare-net",
					"--unshare-user",
					"--unshare-pid",
					"--unshare-ipc",
					"--unshare-uts",
					"--disable-userns",
					"--assert-userns-disabled",
					"--new-session",
					"--cap-drop",
					"ALL",
					"--clearenv",
				]),
			);
			const serializedArgs = args.join("\0");
			expect(serializedArgs).toContain(`--tmpfs\0${homedir()}`);
			expect(serializedArgs).toContain("--tmpfs\0/run");
			expect(serializedArgs).toContain(`--tmpfs\0${root}`);
			expect(serializedArgs).toContain(`--ro-bind\0${workspace}\0${workspace}`);
			expect(serializedArgs).toContain(`--bind\0${buildCache}\0${buildCache}`);
			expect(environment.VERTEX_API_KEY).toBeUndefined();
			expect(environment.SSH_AUTH_SOCK).toBeUndefined();

			const result = spawnSync(args[0]!, args.slice(1), {
				cwd: workspace,
				encoding: "utf8",
				env: environment,
				timeout: 30_000,
			});
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(JSON.parse(result.stdout.trim())).toEqual({
				capabilities_dropped: true,
				control_file_read_only: true,
				credential_hidden: true,
				home_hidden: true,
				network_blocked: true,
				runtime_hidden: true,
				workspace_read_only: true,
			});
			expect(readFileSync(join(workspace, "solution.py"), "utf8")).toBe("VALUE = 42\n");
			expect(readFileSync(join(workspace, "test_kernel.py"), "utf8")).toBe("CONTROL = 'host-owned'\n");
			expect(readFileSync(hostTarget, "utf8")).toBe("safe\n");
			expect(readFileSync(join(buildCache, "sandbox-output.txt"), "utf8")).toBe("allowed\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(homeCanary, { recursive: true, force: true });
			if (runtimeCanary) rmSync(runtimeCanary, { recursive: true, force: true });
		}
	});

	it("rejects a model-replaced writable output directory", () => {
		if (process.platform !== "linux" || !existsSync("/usr/bin/python3")) return;
		const root = mkdtempSync(join(tmpdir(), "prime-kernelbench-grade-symlink-"));
		const workspace = join(root, "workspace");
		const buildCache = join(root, "build-cache");
		const outside = join(root, "outside");
		const kernelbenchRoot = join(root, "KernelBench");
		try {
			mkdirSync(workspace, { recursive: true });
			mkdirSync(outside, { recursive: true });
			mkdirSync(join(kernelbenchRoot, ".venv", "bin"), { recursive: true });
			symlinkSync("/usr/bin/python3", join(kernelbenchRoot, ".venv", "bin", "python"));
			symlinkSync(outside, buildCache);

			expect(() =>
				buildKernelBenchGradeSandboxArgs(
					["/usr/bin/python3", "-c", "pass"],
					workspace,
					buildCache,
					kernelbenchRoot,
				),
			).toThrow(/grade build cache must be a host-owned directory/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a writable output directory outside the masked case root", () => {
		if (process.platform !== "linux" || !existsSync("/usr/bin/python3")) return;
		const root = mkdtempSync(join(tmpdir(), "prime-kernelbench-grade-output-"));
		const workspace = join(root, "case", "workspace");
		const buildCache = join(root, "outside-build-cache");
		const kernelbenchRoot = join(root, "KernelBench");
		try {
			mkdirSync(workspace, { recursive: true });
			mkdirSync(buildCache, { recursive: true });
			mkdirSync(join(kernelbenchRoot, ".venv", "bin"), { recursive: true });
			symlinkSync("/usr/bin/python3", join(kernelbenchRoot, ".venv", "bin", "python"));

			expect(() =>
				buildKernelBenchGradeSandboxArgs(
					["/usr/bin/python3", "-c", "pass"],
					workspace,
					buildCache,
					kernelbenchRoot,
				),
			).toThrow(/dedicated sibling of the workspace/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs the trusted host assertion without importing pytest", () => {
		if (!existsSync("/usr/bin/python3")) return;
		const workspace = mkdtempSync(join(tmpdir(), "prime-kernelbench-grade-bootstrap-"));
		try {
			writeFileSync(
				join(workspace, "test_kernel.py"),
				'def test_kernelbench_correctness():\n    print("trusted-bootstrap-ok")\n',
			);
			const result = spawnSync(kernelBenchGradeCommand(true)[0]!, kernelBenchGradeCommand(true).slice(1), {
				cwd: workspace,
				encoding: "utf8",
				env: { PATH: "/usr/bin:/bin" },
			});
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("trusted-bootstrap-ok");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
