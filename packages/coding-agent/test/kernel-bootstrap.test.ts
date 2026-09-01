import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	getKernelVenvDir,
	type KernelPythonSkill,
	resolveRuntimeIdentity,
	venvPythonPath,
} from "../src/core/kernel/bootstrap.js";

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let runtimeIdentity = "";

function pyprojectHash(pyprojectPath: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(pyprojectPath)).digest("hex")}`;
}

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
	if (process.platform === "win32" && !filePath.endsWith(".cmd")) {
		// node's spawn with shell:false resolves uv.exe/.cmd via PATHEXT on
		// Windows; create the .cmd companion so the fake uv/python resolves.
		writeFileSync(
			`${filePath}.cmd`,
			`@echo off\r\n${content
				.split("\n")
				.map((l) => `rem ${l}`)
				.join("\r\n")}\r\nexit /b 0\r\n`,
		);
	}
}

function writeBootstrapVersion(venv: string, pythonSkills: readonly KernelPythonSkill[] = []): void {
	writeFileSync(
		join(venv, ".bootstrap-version"),
		`${JSON.stringify({
			schema: 9,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: pythonSkills.map((skill) => ({
				importName: skill.importName,
				packagePath: skill.packagePath,
				pyprojectPath: skill.pyprojectPath,
				pyprojectHash: pyprojectHash(skill.pyprojectPath),
			})),
		})}\n`,
	);
}

function createPythonSkill(name = "web-search"): KernelPythonSkill {
	const packagePath = join(tempDir, "skills", name);
	const importName = name.replaceAll("-", "_");
	const pyprojectPath = join(packagePath, "pyproject.toml");
	mkdirSync(join(packagePath, "src", importName), { recursive: true });
	writeFileSync(
		pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
`,
	);
	writeFileSync(join(packagePath, "src", importName, "__init__.py"), "async def run():\n    return 'ok'\n");
	return {
		name,
		importName,
		packagePath,
		pyprojectPath,
	};
}

function createPythonSkillWithDependency(name: string, dependencyName: string): KernelPythonSkill {
	const skill = createPythonSkill(name);
	writeFileSync(
		skill.pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
dependencies = ["${dependencyName}"]
`,
	);
	return skill;
}

function runnableFakePython(basePath: string): string {
	return process.platform === "win32" ? `${basePath}.cmd` : basePath;
}

function writeFakePython(filePath: string, importableModules: readonly string[]): void {
	const cases = importableModules.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`).join("\n");
	const runtimeCase = importableModules.includes("rlm") ? '    *"_harness_methods"*) exit 0 ;;' : "";
	writeExecutable(
		filePath,
		[
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			cases,
			runtimeCase,
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
	if (process.platform === "win32") {
		// Windows companion: mirror the posix import probe in cmd.exe so
		// hasPrimeAgentRuntime()/missingRlmExtraImportLabels() behave the same.
		const winProbe = [
			"@echo off",
			"setlocal",
			// The full -c payload arrives across several space-delimited args,
			// so match substring tokens over %* (module names in tests never
			// prefix-collide, and the runtime probe is identified by its
			// _harness_methods content).
			'set "P=%*"',
			...importableModules.map((m) => `echo %P%| findstr /C:"import ${m}" >nul && exit /b 0`),
			'echo %P%| findstr /C:"_harness_methods" >nul && exit /b 0',
			"exit /b 1",
			"",
		].join("\r\n");
		writeFileSync(`${filePath}.cmd`, winProbe);
	}
}

function installFakeUv(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	const extraImportCases = DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`);
	process.env.UV_LOG = logPath;
	process.env.PATH = `${binDir}${process.env.PATH ? `${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` : ""}`;
	writeExecutable(
		join(binDir, "uv"),
		[
			"#!/bin/sh",
			"set -e",
			'printf "%s\\n" "$*" >> "$UV_LOG"',
			'if [ "$1" = "python" ]; then',
			"  exit 0",
			"fi",
			'if [ "$1" = "venv" ]; then',
			'  venv="$2"',
			'  mkdir -p "$venv/bin"',
			"  cat > \"$venv/bin/python\" <<'PY'",
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			'    "import rlm") exit 0 ;;',
			...extraImportCases,
			'    *"_harness_methods"*) exit 0 ;;',
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"PY",
			'  chmod +x "$venv/bin/python"',
			"  exit 0",
			"fi",
			'if [ "$1" = "pip" ]; then',
			'  for arg in "$@"; do',
			'    if [ "$UV_FAIL_ARG" != "" ] && [ "$arg" = "$UV_FAIL_ARG" ]; then',
			"      exit 1",
			"    fi",
			"  done",
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
	if (process.platform === "win32") {
		// Windows cannot run the sh fake, so add a cmd.exe fake `uv.cmd` that
		// logs the same way, creates a fake python.cmd under Scripts, and
		// handles the pip failure probe.
		const winScripts = [
			"@echo off",
			"setlocal enableextensions enabledelayedexpansion",
			'if defined UV_LOG (echo %* >> "%UV_LOG%")',
			'if "%1"=="python" exit /b 0',
			'if "%1"=="venv" (',
			'  set "VENV=%~2"',
			'  if not exist "!VENV!" mkdir "!VENV!"',
			'  if not exist "!VENV!\\Scripts" mkdir "!VENV!\\Scripts"',
			'  > "!VENV!\\Scripts\\python.cmd" echo @echo off',
			'  >>"!VENV!\\Scripts\\python.cmd" echo rem fake python',
			'  >>"!VENV!\\Scripts\\python.cmd" echo if "%%1"=="-c" (exit /b 0^)',
			'  >>"!VENV!\\Scripts\\python.cmd" echo exit /b 0',
			"  exit /b 0",
			")",
			'if "%1"=="pip" (',
			"  if defined UV_FAIL_ARG (",
			'    echo %* | findstr /C:"%UV_FAIL_ARG%" >nul && exit /b 1',
			"  )",
			"  exit /b 0",
			")",
			"exit /b 2",
			"",
		].join("\r\n");
		writeFileSync(join(binDir, "uv.cmd"), winScripts);
	}
	return logPath;
}

describe("kernel bootstrap", () => {
	beforeEach(async () => {
		runtimeIdentity = await resolveRuntimeIdentity();
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-bootstrap-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("returns the configured kernel venv directory", () => {
		const venv = join(tempDir, "custom-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		expect(getKernelVenvDir()).toBe(venv);
	});

	it("bootstraps a missing venv with uv, prime-agent-runtime, and default extra packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(venvPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("python install 3.11");
		expect(log).toContain(`venv ${venv} --python 3.11 --seed`);
		expect(log).toContain("pip install --python");
		expect(log).not.toContain("ipykernel");
		expect(log).toContain("prime-agent-runtime");
		expect(log).toContain("dill");
		for (const uvArg of DEFAULT_RLM_EXTRA_UV_ARGS) {
			expect(log).toContain(uvArg);
		}
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version).toEqual({
			schema: 9,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: [],
		});
		expect(version.runtime).toMatch(/^sha256:/);
	});

	it("routes bootstrap progress through the provided callback", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const progress: string[] = [];
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await expect(ensureKernelPython({ onProgress: (message) => progress.push(message) })).resolves.toBe(
				venvPythonPath(venv),
			);
		} finally {
			stderrWrite.mockRestore();
		}

		expect(progress).toEqual(expect.arrayContaining(["› setting up python kernel (one-time, ~30s)…", "✓ ready"]));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("setting up python kernel"));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("ready"));
	});

	it("installs Python skills into the bootstrapped venv", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(venvPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: pythonSkill.importName,
				packagePath: pythonSkill.packagePath,
				pyprojectPath: pythonSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(pythonSkill.pyprojectPath),
			},
		]);
	});

	it("installs sibling Python skill dependencies with dependent editable packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("agent-observe");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "agent-observe");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(venvPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: dependencySkill.importName,
				packagePath: dependencySkill.packagePath,
				pyprojectPath: dependencySkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependencySkill.pyprojectPath),
			},
			{
				importName: dependentSkill.importName,
				packagePath: dependentSkill.packagePath,
				pyprojectPath: dependentSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependentSkill.pyprojectPath),
			},
		]);
	});

	it("installs sibling Python skill dependencies when package and directory names differ", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("attach-image");
		writeFileSync(
			dependencySkill.pyprojectPath,
			`[project]
name = "prime-agent-skill-attach-image"
version = "0.1.0"
`,
		);
		const dependentSkill = createPythonSkillWithDependency(
			"orchestration-heartbeat",
			"prime-agent-skill-attach-image",
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(venvPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("parses Python skill dependencies with extras", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("gidgethub");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "gidgethub[httpx]>4.0.0");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(venvPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it.skipIf(process.platform === "win32")("syncs a warm venv when a Python skill pyproject changes", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = venvPythonPath(venv);
		const pythonSkill = createPythonSkill();
		mkdirSync(dirname(venvPythonPath(venv)), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [pythonSkill]);
		writeFileSync(
			pythonSkill.pyprojectPath,
			`[project]
name = "${pythonSkill.name}"
version = "0.1.0"
dependencies = ["httpx"]
`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(python);

		const log = readFileSync(logPath, "utf8");
		expect(log).not.toContain(`venv ${venv} --python 3.11 --seed`);
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills[0].pyprojectHash).toBe(pyprojectHash(pythonSkill.pyprojectPath));
	});

	it.skipIf(process.platform === "win32")(
		"continues when a Python skill editable install fails and retries it next startup",
		async () => {
			const logPath = installFakeUv();
			const venv = join(tempDir, "kernel-venv");
			const goodSkill = createPythonSkill("good-skill");
			const brokenSkill = createPythonSkill("broken-skill");
			process.env.PRIME_AGENT_KERNEL_VENV = venv;
			process.env.UV_FAIL_ARG = brokenSkill.packagePath;

			await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
				venvPythonPath(venv),
			);

			const log = readFileSync(logPath, "utf8");
			expect(log).toContain(`--editable ${goodSkill.packagePath}`);
			expect(log).toContain(`--editable ${brokenSkill.packagePath}`);
			const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
			expect(version.pythonSkills).toEqual([
				{
					importName: goodSkill.importName,
					packagePath: goodSkill.packagePath,
					pyprojectPath: goodSkill.pyprojectPath,
					pyprojectHash: pyprojectHash(goodSkill.pyprojectPath),
				},
			]);

			await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
				venvPythonPath(venv),
			);

			const retryLog = readFileSync(logPath, "utf8");
			expect(retryLog.split("\n").filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
			expect(
				retryLog.split("\n").filter((line) => line.includes(`--editable ${brokenSkill.packagePath}`)),
			).toHaveLength(2);
		},
	);

	it("rebuilds a warm venv with legacy unhashed Python skill manifest entries", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = venvPythonPath(venv);
		const pythonSkill = createPythonSkill();
		mkdirSync(dirname(venvPythonPath(venv)), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(venv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 4,
				runtime: "prime-agent-runtime",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [
					{
						importName: pythonSkill.importName,
						packagePath: pythonSkill.packagePath,
						pyprojectPath: pythonSkill.pyprojectPath,
					},
				],
			})}\n`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
	});

	it("shares concurrent bootstrap work in one process", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = venvPythonPath(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(Promise.all([ensureKernelPython(), ensureKernelPython()])).resolves.toEqual([python, python]);

		const log = readFileSync(logPath, "utf8");
		expect(log.split("\n").filter((line) => line.startsWith(`venv ${venv} `))).toHaveLength(1);
	});

	it("reuses a current warm venv without invoking uv", async () => {
		const venv = join(tempDir, "kernel-venv");
		const python = venvPythonPath(venv);
		mkdirSync(dirname(venvPythonPath(venv)), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);
	});

	it("rebuilds a warm venv whose recorded runtime hash no longer matches local source", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = venvPythonPath(venv);
		mkdirSync(dirname(venvPythonPath(venv)), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(venv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 9,
				runtime: "sha256:stale",
				snapshot: "dill",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [],
			})}\n`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.runtime).toBe(runtimeIdentity);
	});

	it("rebuilds a warm venv with a stale rlm runtime", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = venvPythonPath(venv);
		mkdirSync(dirname(venvPythonPath(venv)), { recursive: true });
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import rlm") exit 0 ;;',
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
	});

	it("rebuilds a broken venv", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		mkdirSync(dirname(venvPythonPath(venv)), { recursive: true });
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(venvPythonPath(venv));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${venv} --python 3.11 --seed`);
	});

	it.skipIf(process.platform === "win32")("uses PRIME_AGENT_KERNEL_PYTHON as an override contract", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = runnableFakePython(overridePython);

		await expect(ensureKernelPython()).resolves.toBe(runnableFakePython(overridePython));
	});

	it.skipIf(process.platform === "win32")(
		"allows PRIME_AGENT_KERNEL_PYTHON missing Python skill imports",
		async () => {
			const overridePython = join(tempDir, "override-python");
			const pythonSkill = createPythonSkill();
			writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
			process.env.PRIME_AGENT_KERNEL_PYTHON = runnableFakePython(overridePython);

			await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(
				runnableFakePython(overridePython),
			);
		},
	);

	it.skipIf(process.platform === "win32")(
		"rejects PRIME_AGENT_KERNEL_PYTHON missing default extra packages",
		async () => {
			const overridePython = join(tempDir, "override-python");
			writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter((name) => name !== "yaml")]);
			process.env.PRIME_AGENT_KERNEL_PYTHON = runnableFakePython(overridePython);

			await expect(ensureKernelPython()).rejects.toThrow(/default Python packages \(yaml \(PyYAML\)\)/);
		},
	);

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a stale rlm runtime", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["dill"]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = runnableFakePython(overridePython);

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it.skipIf(process.platform === "win32")("rejects PRIME_AGENT_KERNEL_PYTHON with a legacy harness API", async () => {
		const overridePython = join(tempDir, "override-python");
		writeExecutable(
			overridePython,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import rlm") exit 0 ;;',
				'    *"_harness_methods"*) exit 1 ;;',
				"    *\"assert not hasattr(rlm.rlm, 'background')\"*) exit 0 ;;",
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		process.env.PRIME_AGENT_KERNEL_PYTHON = runnableFakePython(overridePython);

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("fails an invalid PRIME_AGENT_KERNEL_PYTHON without bootstrapping", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, []);
		process.env.PRIME_AGENT_KERNEL_PYTHON = runnableFakePython(overridePython);

		await expect(ensureKernelPython()).rejects.toThrow(/PRIME_AGENT_KERNEL_PYTHON points to a Python missing/);
	});

	describe("venvPythonPath", () => {
		it("uses Scripts\\python.exe on Windows", () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
			try {
				Object.defineProperty(process, "platform", { value: "win32" });
				expect(venvPythonPath("C:\\prime\\venv")).toBe("C:\\prime\\venv\\Scripts\\python.exe");
			} finally {
				Object.defineProperty(process, "platform", originalPlatform!);
			}
		});

		it("uses bin/python elsewhere (posix branch)", () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
			try {
				Object.defineProperty(process, "platform", { value: "linux" });
				// node:path still joins with the host separator, so normalize
				// separators before comparing (Windows test hosts use backslashes).
				const p = venvPythonPath("/home/u/venv").replaceAll("\\", "/");
				expect(p).toBe("/home/u/venv/bin/python");
			} finally {
				Object.defineProperty(process, "platform", originalPlatform!);
			}
		});
	});
});
