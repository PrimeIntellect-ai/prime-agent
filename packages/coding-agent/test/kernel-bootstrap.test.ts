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
	resolveKernelVenvDir,
	resolveRuntimeIdentity,
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
}

function venvFromPython(python: string): string {
	return dirname(dirname(python));
}

async function createWarmVenv(
	baseVenv: string,
	pythonSkills: readonly KernelPythonSkill[] = [],
): Promise<{ python: string; venv: string }> {
	process.env.PRIME_AGENT_KERNEL_VENV = baseVenv;
	const environmentDir = await resolveKernelVenvDir(pythonSkills);
	const venv = join(environmentDir, "generation-test");
	const python = join(venv, "bin", "python");
	mkdirSync(join(venv, "bin"), { recursive: true });
	return { python, venv };
}

function writeBootstrapVersion(venv: string, pythonSkills: readonly KernelPythonSkill[] = []): void {
	writeFileSync(
		join(venv, ".bootstrap-version"),
		`${JSON.stringify({
			schema: 8,
			ipykernel: "ipykernel",
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
}

function installFakeUv(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	const extraImportCases = DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`);
	process.env.UV_LOG = logPath;
	process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
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
			'    "import ipykernel"|"import rlm") exit 0 ;;',
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
			'      if [ "$UV_FAIL_STDERR" != "" ]; then printf "%s\n" "$UV_FAIL_STDERR" >&2; fi',
			"      exit 1",
			"    fi",
			"  done",
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
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

	it("bootstraps a missing venv with uv, ipykernel, prime-agent-runtime, and default extra packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const python = await ensureKernelPython();
		const installedVenv = venvFromPython(python);
		expect(installedVenv).toMatch(new RegExp(`^${venv}-[a-f0-9]+/generation-`));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("python install 3.11");
		expect(log).toContain(`venv ${installedVenv} --python 3.11 --seed`);
		expect(log).toContain("pip install --python");
		expect(log).toContain("ipykernel");
		expect(log).toContain("prime-agent-runtime");
		expect(log).toContain("dill");
		for (const uvArg of DEFAULT_RLM_EXTRA_UV_ARGS) {
			expect(log).toContain(uvArg);
		}
		const version = JSON.parse(readFileSync(join(installedVenv, ".bootstrap-version"), "utf8"));
		expect(version).toEqual({
			schema: 8,
			ipykernel: "ipykernel",
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
			await expect(ensureKernelPython({ onProgress: (message) => progress.push(message) })).resolves.toContain(
				`${venv}-`,
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

		const python = await ensureKernelPython({ pythonSkills: [pythonSkill] });
		const installedVenv = venvFromPython(python);

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(installedVenv, ".bootstrap-version"), "utf8"));
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

		const python = await ensureKernelPython({ pythonSkills: [dependentSkill] });
		const installedVenv = venvFromPython(python);

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(installedVenv, ".bootstrap-version"), "utf8"));
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

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toContain(`${venv}-`);

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

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toContain(`${venv}-`);

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("isolates environments when a Python skill pyproject changes", async () => {
		installFakeUv();
		const baseVenv = join(tempDir, "kernel-venv");
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = baseVenv;

		const firstPython = await ensureKernelPython({ pythonSkills: [pythonSkill] });
		writeFileSync(
			pythonSkill.pyprojectPath,
			`[project]
name = "${pythonSkill.name}"
version = "0.1.0"
dependencies = ["httpx"]
`,
		);
		const secondPython = await ensureKernelPython({ pythonSkills: [pythonSkill] });

		expect(secondPython).not.toBe(firstPython);
		expect(firstPython).toMatch(new RegExp(`^${baseVenv}-[a-f0-9]+/generation-`));
		expect(secondPython).toMatch(new RegExp(`^${baseVenv}-[a-f0-9]+/generation-`));
		expect(readFileSync(firstPython, "utf8")).toContain("#!/bin/sh");
	});

	it("surfaces a bounded, redacted stderr tail when bootstrap fails", async () => {
		installFakeUv();
		const baseVenv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = baseVenv;
		process.env.UV_FAIL_ARG = "ipykernel";
		process.env.UV_FAIL_STDERR = [
			"discarded first line",
			...Array.from({ length: 20 }, (_, index) => `diagnostic ${index + 1}`),
			"index https://build-user:build-password@example.com/simple?token=super-secret-token",
		].join("\n");

		const error = await ensureKernelPython().catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toContain("stderr (tail):");
		expect(message).toContain("diagnostic 20");
		expect(message).toContain("https://[redacted]@example.com/simple?token=[redacted]");
		expect(message).not.toContain("discarded first line");
		expect(message).not.toContain("build-password");
		expect(message).not.toContain("super-secret-token");
	});

	it("continues when a Python skill editable install fails and retries it next startup", async () => {
		const logPath = installFakeUv();
		const baseVenv = join(tempDir, "kernel-venv");
		const goodSkill = createPythonSkill("good-skill");
		const brokenSkill = createPythonSkill("broken-skill");
		process.env.PRIME_AGENT_KERNEL_VENV = baseVenv;
		process.env.UV_FAIL_ARG = brokenSkill.packagePath;

		const firstPython = await ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] });
		const firstVenv = venvFromPython(firstPython);
		const version = JSON.parse(readFileSync(join(firstVenv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: goodSkill.importName,
				packagePath: goodSkill.packagePath,
				pyprojectPath: goodSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(goodSkill.pyprojectPath),
			},
		]);

		const secondPython = await ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] });

		expect(secondPython).not.toBe(firstPython);
		const retryLog = readFileSync(logPath, "utf8");
		expect(
			retryLog.split("\n").filter((line) => line.includes(`--editable ${brokenSkill.packagePath}`)),
		).toHaveLength(2);
	});

	it("shares concurrent bootstrap work in one process", async () => {
		const logPath = installFakeUv();
		const baseVenv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = baseVenv;

		const pythons = await Promise.all([ensureKernelPython(), ensureKernelPython()]);

		expect(pythons[0]).toBe(pythons[1]);
		const installedVenv = venvFromPython(pythons[0]);
		const log = readFileSync(logPath, "utf8");
		expect(log.split("\n").filter((line) => line.startsWith(`venv ${installedVenv} `))).toHaveLength(1);
	});

	it("reuses a current warm venv without invoking uv", async () => {
		const baseVenv = join(tempDir, "kernel-venv");
		const { python, venv } = await createWarmVenv(baseVenv);
		writeFakePython(python, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv);

		await expect(ensureKernelPython()).resolves.toBe(python);
	});

	it("preserves a stale generation while publishing its replacement", async () => {
		const logPath = installFakeUv();
		const baseVenv = join(tempDir, "kernel-venv");
		const { python: stalePython, venv: staleVenv } = await createWarmVenv(baseVenv);
		writeFakePython(stalePython, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(staleVenv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 8,
				ipykernel: "ipykernel",
				runtime: "sha256:stale",
				snapshot: "dill",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [],
			})}\n`,
		);

		const replacementPython = await ensureKernelPython();

		expect(replacementPython).not.toBe(stalePython);
		expect(readFileSync(stalePython, "utf8")).toContain("#!/bin/sh");
		const replacementVenv = venvFromPython(replacementPython);
		expect(readFileSync(logPath, "utf8")).toContain(`venv ${replacementVenv} --python 3.11 --seed`);
		const version = JSON.parse(readFileSync(join(replacementVenv, ".bootstrap-version"), "utf8"));
		expect(version.runtime).toBe(runtimeIdentity);
	});

	it("replaces a generation with a legacy unhashed Python skill manifest", async () => {
		installFakeUv();
		const baseVenv = join(tempDir, "kernel-venv");
		const pythonSkill = createPythonSkill();
		const { python: legacyPython, venv: legacyVenv } = await createWarmVenv(baseVenv);
		writeFakePython(legacyPython, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(legacyVenv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 4,
				ipykernel: "ipykernel",
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

		const replacementPython = await ensureKernelPython();

		expect(replacementPython).not.toBe(legacyPython);
		expect(readFileSync(legacyPython, "utf8")).toContain("#!/bin/sh");
	});

	it("replaces a generation with a stale rlm runtime", async () => {
		installFakeUv();
		const baseVenv = join(tempDir, "kernel-venv");
		const { python: stalePython, venv: staleVenv } = await createWarmVenv(baseVenv);
		writeFakePython(stalePython, ["ipykernel"]);
		writeBootstrapVersion(staleVenv);

		const replacementPython = await ensureKernelPython();

		expect(replacementPython).not.toBe(stalePython);
		expect(readFileSync(stalePython, "utf8")).toContain("#!/bin/sh");
	});

	it("preserves a broken generation while publishing its replacement", async () => {
		installFakeUv();
		const baseVenv = join(tempDir, "kernel-venv");
		const { python: brokenPython, venv: brokenVenv } = await createWarmVenv(baseVenv);
		writeBootstrapVersion(brokenVenv);

		const replacementPython = await ensureKernelPython();

		expect(replacementPython).not.toBe(brokenPython);
		expect(readFileSync(join(brokenVenv, ".bootstrap-version"), "utf8")).toContain(runtimeIdentity);
	});

	it("uses PRIME_AGENT_KERNEL_PYTHON as an override contract", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).resolves.toBe(overridePython);
	});

	it("allows PRIME_AGENT_KERNEL_PYTHON missing Python skill imports", async () => {
		const overridePython = join(tempDir, "override-python");
		const pythonSkill = createPythonSkill();
		writeFakePython(overridePython, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(overridePython);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON missing default extra packages", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, [
			"ipykernel",
			"rlm",
			...DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter((name) => name !== "yaml"),
		]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/default Python packages \(yaml \(PyYAML\)\)/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a stale rlm runtime", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["ipykernel"]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a legacy harness API", async () => {
		const overridePython = join(tempDir, "override-python");
		writeExecutable(
			overridePython,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import ipykernel"|"import rlm") exit 0 ;;',
				'    *"_harness_methods"*) exit 1 ;;',
				"    *\"assert not hasattr(rlm.rlm, 'background')\"*) exit 0 ;;",
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("fails an invalid PRIME_AGENT_KERNEL_PYTHON without bootstrapping", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, []);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/missing ipykernel/);
	});
});
