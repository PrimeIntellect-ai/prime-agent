import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../../config.js";
import { isOrphanProcessIdentityCurrent } from "../orphan-process-journal.js";
import { compareProcessStartIds, getProcessStartId } from "../session-lease.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";

const BOOTSTRAP_SCHEMA = 8;
const PYTHON_VERSION = "3.11";
const IPYKERNEL_REQUIREMENT = "ipykernel";
const RUNTIME_REQUIREMENT = "prime-agent-runtime";
// Serializes the kernel's user namespace so it can be revived across session
// resume. Internal-only; intentionally not surfaced to the model as an import.
const STATE_SNAPSHOT_REQUIREMENT = "dill";
const DEFAULT_RLM_EXTRA_PACKAGES = [
	{ uvArg: "requests", importName: "requests", promptLabel: "requests" },
	{ uvArg: "httpx", importName: "httpx", promptLabel: "httpx" },
	{ uvArg: "pyyaml", importName: "yaml", promptLabel: "yaml (PyYAML)" },
	{ uvArg: "tomli", importName: "tomli", promptLabel: "tomli" },
	{ uvArg: "python-dotenv", importName: "dotenv", promptLabel: "dotenv (python-dotenv)" },
	{ uvArg: "pandas", importName: "pandas", promptLabel: "pandas" },
	{ uvArg: "numpy", importName: "numpy", promptLabel: "numpy" },
	{ uvArg: "scipy", importName: "scipy", promptLabel: "scipy" },
	{ uvArg: "beautifulsoup4", importName: "bs4", promptLabel: "bs4 (Beautiful Soup)" },
	{ uvArg: "lxml", importName: "lxml", promptLabel: "lxml" },
	{ uvArg: "pydantic", importName: "pydantic", promptLabel: "pydantic" },
	{ uvArg: "tyro", importName: "tyro", promptLabel: "tyro" },
];
export const DEFAULT_RLM_EXTRA_UV_ARGS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.uvArg);
export const DEFAULT_RLM_EXTRA_IMPORT_NAMES = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.importName);
export const DEFAULT_RLM_EXTRA_IMPORT_LABELS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.promptLabel);
const UV_INSTALL_COMMAND = "curl -LsSf https://astral.sh/uv/install.sh | sh";
const REQUIRED_HARNESS_METHODS = [
	"create_memory",
	"update_memory",
	"delete_memory",
	"create_skill",
	"update_skill",
	"delete_skill",
	"create_subagent",
	"update_subagent",
	"delete_subagent",
	"create_prompt_note",
	"update_prompt_note",
	"delete_prompt_note",
	"record_refinement",
];
const RUNTIME_READY_CHECK = `import inspect; import rlm; from rlm import McpIntegration; from rlm.harness import HarnessEntry; _harness_methods = ${JSON.stringify(REQUIRED_HARNESS_METHODS)}; assert hasattr(rlm, 'run'); assert callable(rlm); assert hasattr(rlm, 'rlm'); assert callable(rlm.rlm); assert callable(rlm.host_request); assert callable(rlm.find_models); assert callable(rlm.rlm.find_models); assert hasattr(rlm, 'harness'); assert hasattr(rlm, 'get_harness_state'); assert hasattr(rlm.rlm, 'harness'); assert hasattr(rlm.rlm, 'get_harness_state'); assert all(callable(getattr(_harness, _method, None)) for _harness in (rlm.harness, rlm.rlm.harness) for _method in _harness_methods); assert 'reference' in HarnessEntry.__dataclass_fields__; assert 'scope' in HarnessEntry.__dataclass_fields__; assert 'reference' in inspect.signature(rlm.harness.create_skill).parameters; assert 'reference' in inspect.signature(rlm.harness.update_skill).parameters; assert 'global_' in inspect.signature(rlm.harness.create_memory).parameters; assert 'global_' in inspect.signature(rlm.get_harness_state).parameters; assert not hasattr(rlm, 'background'); assert not hasattr(rlm.rlm, 'background')`;
const BOOTSTRAP_VERSION_FILE = ".bootstrap-version";
const BOOTSTRAP_LOCK_NAME = ".bootstrap.lock";
const BOOTSTRAP_LOCK_RETRY_MS = 100;
const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS = 30_000;
const BOOTSTRAP_STDERR_MAX_CHARS = 2_000;
const BOOTSTRAP_STDERR_MAX_LINES = 20;
const BOOTSTRAP_STDERR_BUFFER_CHARS = 8_000;
const KERNEL_VENV_IDENTITY_CHARS = 20;
const KERNEL_VENV_GENERATION_PREFIX = "generation-";
const MAX_RETAINED_INACTIVE_KERNEL_GENERATIONS = 1;
const KERNEL_GENERATION_LEASE_DIR = ".leases";
const KERNEL_GENERATION_PUBLISHED_FILE = ".generation-published";

let inFlightEnsureKernelPython: { key: string; promise: Promise<string> } | null = null;

export type KernelPythonSkill = PythonSkillRuntimeInfo;
export type KernelBootstrapProgressHandler = (message: string) => void;

export interface EnsureKernelPythonOptions {
	pythonSkills?: readonly KernelPythonSkill[];
	onProgress?: KernelBootstrapProgressHandler;
}

interface BootstrapPythonSkill {
	importName: string;
	packagePath: string;
	pyprojectPath: string;
	pyprojectHash: string;
}

interface BootstrapVersion {
	schema: number;
	ipykernel?: string;
	runtime?: string;
	snapshot?: string;
	extraUvArgs?: string[];
	pythonSkills?: BootstrapPythonSkill[];
	requestedPythonSkills?: BootstrapPythonSkill[];
}

interface KernelGenerationLease {
	version: 1;
	pid: number;
	processStartId: string;
	updatedAt: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function fileContentHash(filePath: string): string {
	try {
		return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
	} catch {
		return "unreadable";
	}
}

function normalizePythonSkills(pythonSkills: readonly KernelPythonSkill[] | undefined): BootstrapPythonSkill[] {
	const byKey = new Map<string, BootstrapPythonSkill>();
	const addSkill = (skill: Pick<KernelPythonSkill, "importName" | "packagePath" | "pyprojectPath">): void => {
		const packagePath = path.resolve(skill.packagePath);
		const pyprojectPath = path.resolve(skill.pyprojectPath);
		const key = `${skill.importName}\0${packagePath}`;
		if (byKey.has(key)) {
			return;
		}
		const bootstrapSkill: BootstrapPythonSkill = {
			importName: skill.importName,
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		byKey.set(key, bootstrapSkill);
		for (const dependencyName of readPythonSkillDependencyNames(bootstrapSkill)) {
			const siblingDependency = resolveSiblingPythonSkillDependency(bootstrapSkill, dependencyName);
			if (siblingDependency) {
				addSkill(siblingDependency);
			}
		}
	};
	for (const skill of pythonSkills ?? []) {
		addSkill(skill);
	}
	return [...byKey.values()].sort((a, b) => {
		const packageCompare = a.packagePath.localeCompare(b.packagePath);
		if (packageCompare !== 0) return packageCompare;
		return a.importName.localeCompare(b.importName);
	});
}

function readTomlProjectSection(pyprojectPath: string): string | undefined {
	try {
		const text = readFileSync(pyprojectPath, "utf-8");
		const match = text.match(/^\s*\[project\]\s*$/m);
		if (!match || match.index === undefined) {
			return undefined;
		}
		const sectionStart = match.index + match[0].length;
		const rest = text.slice(sectionStart);
		const nextSection = rest.search(/^\s*\[/m);
		return nextSection >= 0 ? rest.slice(0, nextSection) : rest;
	} catch {
		return undefined;
	}
}

function readPythonSkillProjectName(skill: BootstrapPythonSkill): string {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	const name = projectSection?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
	return name?.trim() || skill.importName.replaceAll("_", "-");
}

function parseDependencyPackageName(dependency: string): string | undefined {
	const withoutMarker = dependency.split(";")[0]?.trim() ?? "";
	if (!withoutMarker) {
		return undefined;
	}
	const match = withoutMarker.match(/^([A-Za-z0-9_.-]+)/);
	return match?.[1]?.replaceAll("_", "-").toLowerCase();
}

function findTomlArrayEnd(text: string, startIndex: number): number {
	let inQuote: '"' | "'" | undefined;
	let escaped = false;
	for (let index = startIndex; index < text.length; index++) {
		const char = text[index];
		if (inQuote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === inQuote) {
				inQuote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}
		if (char === "]") {
			return index;
		}
	}
	return -1;
}

function readPythonSkillDependencyNames(skill: BootstrapPythonSkill): Set<string> {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	if (!projectSection) {
		return new Set();
	}
	const dependenciesStart = projectSection.search(/^\s*dependencies\s*=\s*\[/m);
	if (dependenciesStart < 0) {
		return new Set();
	}
	const arrayStart = projectSection.indexOf("[", dependenciesStart);
	if (arrayStart < 0) {
		return new Set();
	}
	const arrayEnd = findTomlArrayEnd(projectSection, arrayStart + 1);
	if (arrayEnd < 0) {
		return new Set();
	}
	const dependenciesArray = projectSection.slice(arrayStart, arrayEnd + 1);
	const dependencies = new Set<string>();
	const dependencyPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
	for (const match of dependenciesArray.matchAll(dependencyPattern)) {
		const dependency = (match[1] ?? match[2] ?? "").replaceAll('\\"', '"').replaceAll("\\'", "'");
		const name = parseDependencyPackageName(dependency);
		if (name) {
			dependencies.add(name);
		}
	}
	return dependencies;
}

function resolveSiblingPythonSkillDependency(
	skill: BootstrapPythonSkill,
	dependencyName: string,
): BootstrapPythonSkill | undefined {
	const siblingsDir = path.dirname(skill.packagePath);
	for (const entry of readdirSync(siblingsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const packagePath = path.join(siblingsDir, entry.name);
		const pyprojectPath = path.join(packagePath, "pyproject.toml");
		if (!existsSync(pyprojectPath)) {
			continue;
		}
		const dependency: BootstrapPythonSkill = {
			importName: entry.name.replaceAll("-", "_"),
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		if (readPythonSkillProjectName(dependency).replaceAll("_", "-").toLowerCase() === dependencyName) {
			return dependency;
		}
	}
	return undefined;
}

function sortPythonSkillsForInstall(pythonSkills: readonly BootstrapPythonSkill[]): BootstrapPythonSkill[] {
	const byProjectName = new Map<string, BootstrapPythonSkill>();
	const originalIndex = new Map<BootstrapPythonSkill, number>();
	for (const [index, skill] of pythonSkills.entries()) {
		originalIndex.set(skill, index);
		byProjectName.set(readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill);
	}

	const dependenciesBySkill = new Map<BootstrapPythonSkill, BootstrapPythonSkill[]>();
	for (const skill of pythonSkills) {
		dependenciesBySkill.set(
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						byProjectName.get(dependencyName) ?? resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		);
	}

	const pending = new Set(pythonSkills);
	const sorted: BootstrapPythonSkill[] = [];
	while (pending.size > 0) {
		let progressed = false;
		for (const skill of [...pending].sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))) {
			const dependencies = dependenciesBySkill.get(skill) ?? [];
			if (dependencies.some((dependency) => pending.has(dependency))) {
				continue;
			}
			sorted.push(skill);
			pending.delete(skill);
			progressed = true;
		}
		if (!progressed) {
			// Cyclic local skill dependencies cannot be topologically ordered; keep a
			// deterministic order and let uv surface the packaging error if needed.
			sorted.push(...[...pending].sort((a, b) => a.packagePath.localeCompare(b.packagePath)));
			break;
		}
	}
	return sorted;
}

function formatPythonSkillInstallArgs(skill: BootstrapPythonSkill): string[] {
	return ["--editable", skill.packagePath];
}

function ensureKernelPythonKey(pythonSkills: readonly BootstrapPythonSkill[]): string {
	return [
		process.env.PRIME_AGENT_KERNEL_PYTHON ?? "",
		process.env.PRIME_AGENT_KERNEL_VENV ?? "",
		process.env.PRIME_AGENT_KERNEL_VENV_ROOT ?? "",
		process.env.HOME ?? "",
		process.env.XDG_DATA_HOME ?? "",
		JSON.stringify(pythonSkills),
	].join("\0");
}

export function getKernelVenvDir(): string {
	const override = process.env.PRIME_AGENT_KERNEL_VENV;
	if (override) return path.resolve(expandHome(override));
	return path.join(os.homedir(), ".prime", "agent", "kernel-venv");
}

function getXdgKernelVenvDir(): string {
	const dataHome = process.env.XDG_DATA_HOME
		? path.resolve(expandHome(process.env.XDG_DATA_HOME))
		: path.join(os.homedir(), ".local", "share");
	return path.join(dataHome, "prime", "agent", "kernel-venv");
}

async function resolveWritableKernelVenvDir(): Promise<string> {
	const primary = getKernelVenvDir();
	try {
		await mkdir(path.dirname(primary), { recursive: true });
		return primary;
	} catch (primaryError) {
		if (process.env.PRIME_AGENT_KERNEL_VENV) {
			throw new Error(`couldn't create kernel venv parent directory for ${primary}: ${errorMessage(primaryError)}`);
		}

		const fallback = getXdgKernelVenvDir();
		try {
			await mkdir(path.dirname(fallback), { recursive: true });
			return fallback;
		} catch (fallbackError) {
			throw new Error(
				`couldn't create kernel venv directory at ${primary} or ${fallback}; set PRIME_AGENT_KERNEL_PYTHON to a python with ipykernel installed. ${errorMessage(fallbackError)}`,
			);
		}
	}
}

function sanitizeBootstrapDiagnostic(value: string): string {
	return value
		.replace(/\b(Authorization\s*:\s*)(Basic|Bearer|Token)\s+\S+/gi, "$1$2 [redacted]")
		.replace(/(^|\r?\n)(\s*)(Bearer|Token)\s+\S+/gim, "$1$2$3 [redacted]")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
		.replace(
			/([?&](?:(?:access|refresh|id)[_-]?token|client[_-]?secret|api[_-]?key|password|secret|token)=)[^&\s]+/gi,
			"$1[redacted]",
		)
		.replace(
			/\b((?:(?:access|refresh|id)[_-]?token|client[_-]?secret|api[_-]?key|password|secret|token)\s*[=:]\s*)\S+/gi,
			"$1[redacted]",
		);
}

function boundedStderrTail(value: string, leadingTokenMayBeTruncated = false): string {
	// Sanitize while the authorization marker and URL userinfo are still present;
	// truncating the raw tail first can retain a token after discarding its marker.
	let sanitized = sanitizeBootstrapDiagnostic(value);
	if (leadingTokenMayBeTruncated) sanitized = sanitized.replace(/^\S+/, "[redacted]");
	const lines = sanitized.trimEnd().split(/\r?\n/).slice(-BOOTSTRAP_STDERR_MAX_LINES);
	return lines.join("\n").slice(-BOOTSTRAP_STDERR_MAX_CHARS);
}

function run(command: string, args: string[], options: { stdio?: "ignore" | "inherit" } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const stdio = options.stdio ?? "pipe";
		const child = spawn(command, args, {
			env: process.env,
			stdio,
		});
		let stderrBuffer = "";
		let stderrLeadingTokenMayBeTruncated = false;
		if (stdio === "pipe") {
			child.stdout?.resume();
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				const combined = `${stderrBuffer}${chunk}`;
				if (combined.length > BOOTSTRAP_STDERR_BUFFER_CHARS) stderrLeadingTokenMayBeTruncated = true;
				stderrBuffer = combined.slice(-BOOTSTRAP_STDERR_BUFFER_CHARS);
			});
		}
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			const stderrTail = boundedStderrTail(stderrBuffer, stderrLeadingTokenMayBeTruncated);
			const diagnostic = stderrTail
				? `
stderr (tail):
${stderrTail}`
				: "";
			const renderedCommand = sanitizeBootstrapDiagnostic(`${command} ${args.join(" ")}`);
			reject(new Error(`${renderedCommand} failed with ${reason}${diagnostic}`));
		});
	});
}

async function pythonImports(python: string, moduleName: string): Promise<boolean> {
	try {
		await run(python, ["-c", `import ${moduleName}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function hasIpykernel(python: string): Promise<boolean> {
	return pythonImports(python, "ipykernel");
}

async function hasPrimeAgentRuntime(python: string): Promise<boolean> {
	try {
		await run(python, ["-c", RUNTIME_READY_CHECK], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function missingRlmExtraImportLabels(python: string): Promise<string[]> {
	const missing: string[] = [];
	for (const pkg of DEFAULT_RLM_EXTRA_PACKAGES) {
		if (!(await pythonImports(python, pkg.importName))) {
			missing.push(pkg.promptLabel);
		}
	}
	return missing;
}

async function missingPythonSkillImportLabels(
	python: string,
	pythonSkills: readonly KernelPythonSkill[],
): Promise<string[]> {
	const missing: string[] = [];
	for (const skill of pythonSkills) {
		if (!(await pythonImports(python, skill.importName))) {
			missing.push(`${skill.name} (${skill.importName})`);
		}
	}
	return missing;
}

function reportProgress(options: EnsureKernelPythonOptions, message: string): void {
	if (options.onProgress) {
		options.onProgress(message);
		return;
	}
	process.stderr.write(`${message}\n`);
}

function bootstrapLockDir(venv: string): string {
	return path.join(path.dirname(venv), `${path.basename(venv)}${BOOTSTRAP_LOCK_NAME}`);
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error, "EPERM");
	}
}

async function readLockPid(lockDir: string): Promise<number | null> {
	try {
		const raw = await readFile(path.join(lockDir, "pid"), "utf8");
		const pid = Number.parseInt(raw.trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

async function lockMissingPidIsStale(lockDir: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockDir);
		return Date.now() - lockStat.mtimeMs > BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS;
	} catch {
		return false;
	}
}

async function acquireBootstrapLock(venv: string): Promise<() => Promise<void>> {
	const lockDir = bootstrapLockDir(venv);
	await mkdir(path.dirname(lockDir), { recursive: true });

	for (;;) {
		try {
			await mkdir(lockDir);
			await writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
			return () => rm(lockDir, { recursive: true, force: true });
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) throw error;

			// Besides making lock contention inspectable, this marker gives process
			// tests a deterministic rendezvous at the filesystem-lock boundary.
			await writeFile(path.join(lockDir, `waiter-${process.pid}`), "", "utf8").catch(() => undefined);
			const pid = await readLockPid(lockDir);
			if (pid === null ? await lockMissingPidIsStale(lockDir) : !processIsRunning(pid)) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}

			await sleep(BOOTSTRAP_LOCK_RETRY_MS);
		}
	}
}

async function findExecutable(name: string): Promise<string | null> {
	const pathValue = process.env.PATH;
	if (!pathValue) return null;
	const candidates = process.platform === "win32" ? [name, `${name}.exe`] : [name];
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		for (const candidate of candidates) {
			const fullPath = path.join(dir, candidate);
			if (await isExecutable(fullPath)) return fullPath;
		}
	}
	return null;
}

async function ensureUv(options: EnsureKernelPythonOptions): Promise<string> {
	const fromPath = await findExecutable("uv");
	if (fromPath) return fromPath;

	const localUv = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
	if (await isExecutable(localUv)) return localUv;

	const shouldInstallUv =
		process.env.PRIME_AGENT_INSTALL_UV === "1" || (!options.onProgress && (await confirmUvInstall()));
	if (!shouldInstallUv) {
		throw new Error(
			`uv is required to set up the Python kernel. Install uv yourself: ${UV_INSTALL_COMMAND}, ` +
				"or set PRIME_AGENT_INSTALL_UV=1 to let prime-agent run that installer.",
		);
	}

	reportProgress(options, "› installing uv (one-time)…");
	try {
		await run("sh", ["-c", UV_INSTALL_COMMAND], { stdio: options.onProgress ? "ignore" : "inherit" });
	} catch (error) {
		throw new Error(
			`couldn't install uv from astral.sh; install it yourself: ${UV_INSTALL_COMMAND}, then re-run prime-agent. ${errorMessage(error)}`,
		);
	}

	if (await isExecutable(localUv)) return localUv;
	const installedFromPath = await findExecutable("uv");
	if (installedFromPath) return installedFromPath;
	throw new Error("uv install completed but binary not found at ~/.local/bin/uv");
}

async function confirmUvInstall(): Promise<boolean> {
	if (process.env.PRIME_AGENT_INSTALL_UV === "0") return false;
	if (!stdin.isTTY || !stderr.isTTY) return false;

	const rl = createInterface({ input: stdin, output: stderr });
	try {
		const answer = (await rl.question("Prime Agent needs uv to set up Python. Install uv from astral.sh now? [Y/n] "))
			.trim()
			.toLowerCase();
		return answer !== "n" && answer !== "no";
	} finally {
		rl.close();
	}
}

async function readBootstrapVersion(venv: string): Promise<BootstrapVersion | null> {
	try {
		const raw = await readFile(path.join(venv, BOOTSTRAP_VERSION_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.schema !== "number") return null;
		const extraUvArgs =
			Array.isArray(parsed.extraUvArgs) &&
			parsed.extraUvArgs.every((v: unknown): v is string => typeof v === "string")
				? (parsed.extraUvArgs as string[])
				: undefined;
		const parsePythonSkills = (value: unknown): BootstrapPythonSkill[] | null | undefined => {
			if (value === undefined) return undefined;
			if (!Array.isArray(value)) return null;
			if (
				!value.every((v: unknown): v is BootstrapPythonSkill => {
					if (!isRecord(v)) return false;
					return (
						typeof v.importName === "string" &&
						typeof v.packagePath === "string" &&
						typeof v.pyprojectPath === "string" &&
						typeof v.pyprojectHash === "string"
					);
				})
			) {
				return null;
			}
			return value;
		};
		const pythonSkills = parsePythonSkills(parsed.pythonSkills);
		const requestedPythonSkills = parsePythonSkills(parsed.requestedPythonSkills);
		if (pythonSkills === null || requestedPythonSkills === null) return null;
		return {
			schema: parsed.schema,
			ipykernel: typeof parsed.ipykernel === "string" ? parsed.ipykernel : undefined,
			runtime: typeof parsed.runtime === "string" ? parsed.runtime : undefined,
			snapshot: typeof parsed.snapshot === "string" ? parsed.snapshot : undefined,
			extraUvArgs,
			pythonSkills,
			requestedPythonSkills,
		};
	} catch {
		return null;
	}
}

function extraUvArgsMatch(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function pythonSkillsMatch(a: BootstrapPythonSkill[] | undefined, b: readonly BootstrapPythonSkill[]): boolean {
	const left = a ?? [];
	if (left.length !== b.length) return false;
	return left.every((skill, index) => {
		const expected = b[index];
		return (
			skill.importName === expected.importName &&
			skill.packagePath === expected.packagePath &&
			skill.pyprojectPath === expected.pyprojectPath &&
			skill.pyprojectHash === expected.pyprojectHash
		);
	});
}

function bootstrapVersionCurrent(
	version: BootstrapVersion | null,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): boolean {
	return (
		version !== null &&
		bootstrapBaseVersionCurrent(version, runtimeIdentity) &&
		pythonSkillsMatch(version.requestedPythonSkills ?? version.pythonSkills, pythonSkills)
	);
}

function bootstrapBaseVersionCurrent(version: BootstrapVersion | null, runtimeIdentity: string): boolean {
	return (
		version?.schema === BOOTSTRAP_SCHEMA &&
		version.ipykernel === IPYKERNEL_REQUIREMENT &&
		version.runtime === runtimeIdentity &&
		version.snapshot === STATE_SNAPSHOT_REQUIREMENT &&
		extraUvArgsMatch(version.extraUvArgs, DEFAULT_RLM_EXTRA_UV_ARGS)
	);
}

async function writeBootstrapVersion(
	venv: string,
	runtimeIdentity: string,
	installedPythonSkills: readonly BootstrapPythonSkill[],
	requestedPythonSkills: readonly BootstrapPythonSkill[],
): Promise<void> {
	const version: BootstrapVersion = {
		schema: BOOTSTRAP_SCHEMA,
		ipykernel: IPYKERNEL_REQUIREMENT,
		runtime: runtimeIdentity,
		snapshot: STATE_SNAPSHOT_REQUIREMENT,
		extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
		pythonSkills: [...installedPythonSkills],
		requestedPythonSkills: [...requestedPythonSkills],
	};
	await writeFile(path.join(venv, BOOTSTRAP_VERSION_FILE), `${JSON.stringify(version)}\n`, "utf8");
}

function runtimeCandidateDirs(): string[] {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	// dist/prime-agent-runtime is listed first deliberately: it is the only path stable
	// across every shipped layout (dist/, dist/bundle/, bun), where import.meta.url-relative
	// resolution breaks. `npm run build` rebuilds it from live source (copy-assets does
	// rm -rf + cp), so the staleness hash still refreshes on every build. The relative
	// paths below cover running from source (tsx) where dist/ hasn't been built.
	return [
		path.join(getPackageDir(), "dist", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "..", "..", "..", "prime-agent-runtime"),
	];
}

async function resolveRuntimeSourceDir(): Promise<string | null> {
	for (const candidate of runtimeCandidateDirs()) {
		if (await exists(path.join(candidate, "pyproject.toml"))) {
			return candidate;
		}
	}
	return null;
}

// Identity of the runtime to be installed. For a local source checkout this is a
// content hash of every rlm/*.py file plus pyproject.toml, so any runtime code or
// dependency change invalidates an existing venv automatically. Falls back to the
// bare package name when the runtime resolves to a registry install (no local source).
export async function resolveRuntimeIdentity(): Promise<string> {
	const sourceDir = await resolveRuntimeSourceDir();
	if (!sourceDir) return RUNTIME_REQUIREMENT;
	return hashRuntimeSource(sourceDir);
}

// Throws if the local source can't be read. A failure here must surface rather than
// fall back to RUNTIME_REQUIREMENT: that constant is the registry-install identity, and
// recording it for a local checkout would permanently mask later source changes.
async function hashRuntimeSource(sourceDir: string): Promise<string> {
	const rlmDir = path.join(sourceDir, "src", "rlm");
	const files: string[] = [path.join(sourceDir, "pyproject.toml")];
	async function collect(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await collect(full);
			} else if (entry.isFile() && entry.name.endsWith(".py")) {
				files.push(full);
			}
		}
	}
	await collect(rlmDir);
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(sourceDir, file));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

function kernelEnvironmentIdentity(runtimeIdentity: string, pythonSkills: readonly BootstrapPythonSkill[]): string {
	const identity = JSON.stringify({
		schema: BOOTSTRAP_SCHEMA,
		python: PYTHON_VERSION,
		ipykernel: IPYKERNEL_REQUIREMENT,
		runtime: runtimeIdentity,
		snapshot: STATE_SNAPSHOT_REQUIREMENT,
		extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
		pythonSkills,
	});
	return createHash("sha256").update(identity).digest("hex").slice(0, KERNEL_VENV_IDENTITY_CHARS);
}

function kernelGenerationRoot(baseVenv: string): string {
	const override = process.env.PRIME_AGENT_KERNEL_VENV_ROOT;
	if (override) return path.resolve(expandHome(override));
	return `${baseVenv}.generations`;
}

export async function resolveKernelVenvDir(): Promise<string> {
	const baseVenv = await resolveWritableKernelVenvDir();
	return process.env.PRIME_AGENT_KERNEL_VENV ? baseVenv : kernelGenerationRoot(baseVenv);
}

async function findReadyKernelVenv(
	generationRoot: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<string | null> {
	let entries: Dirent[];
	try {
		entries = await readdir(generationRoot, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
	const generationNames = entries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(KERNEL_VENV_GENERATION_PREFIX))
		.map((entry) => entry.name)
		.sort((a, b) => b.localeCompare(a));
	for (const generationName of generationNames) {
		const venv = path.join(generationRoot, generationName);
		const leaseDirExists = await exists(path.join(venv, KERNEL_GENERATION_LEASE_DIR));
		if (leaseDirExists && !(await exists(path.join(venv, KERNEL_GENERATION_PUBLISHED_FILE)))) continue;
		const python = path.join(venv, "bin", "python");
		if (await kernelReady(python, venv, runtimeIdentity, pythonSkills)) return venv;
	}
	return null;
}

function parseKernelGenerationLease(value: unknown): KernelGenerationLease | null {
	if (!isRecord(value)) return null;
	if (
		value.version !== 1 ||
		!Number.isInteger(value.pid) ||
		(value.pid as number) <= 0 ||
		typeof value.processStartId !== "string" ||
		value.processStartId.length === 0 ||
		typeof value.updatedAt !== "string"
	) {
		return null;
	}
	return value as unknown as KernelGenerationLease;
}

async function writeKernelGenerationLease(venv: string, pid: number): Promise<void> {
	const leaseDir = path.join(venv, KERNEL_GENERATION_LEASE_DIR);
	await mkdir(leaseDir, { recursive: true });
	const lease: KernelGenerationLease = {
		version: 1,
		pid,
		// An unavailable start id is intentionally unverifiable. The GC still knows
		// the lease is dead when the PID no longer exists, but cannot mistake PID
		// reuse for death while that PID is running.
		processStartId: getProcessStartId(pid) ?? `unverifiable:${pid}`,
		updatedAt: new Date().toISOString(),
	};
	const destination = path.join(leaseDir, `${pid}.json`);
	const temporary = path.join(leaseDir, `.${pid}-${process.pid}-${Date.now()}.tmp`);
	await writeFile(
		temporary,
		`${JSON.stringify(lease)}
`,
		{ encoding: "utf8", mode: 0o600 },
	);
	await rename(temporary, destination);
}

export async function registerKernelPythonLease(python: string, pid: number): Promise<void> {
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid kernel pid for environment lease: ${pid}`);
	const venv = path.dirname(path.dirname(python));
	if (!path.basename(venv).startsWith(KERNEL_VENV_GENERATION_PREFIX)) return;
	if (!(await exists(path.join(venv, BOOTSTRAP_VERSION_FILE)))) return;
	await writeKernelGenerationLease(venv, pid);
}

async function generationHasOnlyDeadLeases(generation: string): Promise<boolean> {
	const leaseDir = path.join(generation, KERNEL_GENERATION_LEASE_DIR);
	let entries: Dirent[];
	try {
		entries = await readdir(leaseDir, { withFileTypes: true });
	} catch {
		// Generations published by older binaries, unreadable lease directories,
		// and other unverifiable states are conservatively protected.
		return false;
	}
	for (const entry of entries) {
		if (!entry.isFile()) return false;
		let lease: KernelGenerationLease | null = null;
		try {
			lease = parseKernelGenerationLease(JSON.parse(await readFile(path.join(leaseDir, entry.name), "utf8")));
		} catch {
			return false;
		}
		if (!lease) return false;
		if (!processIsRunning(lease.pid)) continue;
		if (isOrphanProcessIdentityCurrent({ pid: lease.pid, processStartId: lease.processStartId })) return false;
		const comparison = compareProcessStartIds(lease.processStartId, getProcessStartId(lease.pid));
		if (comparison !== "mismatch") return false;
	}
	return true;
}

async function prepareGenerationSlot(generationRoot: string): Promise<void> {
	await mkdir(generationRoot, { recursive: true });
	const entries = (await readdir(generationRoot, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(KERNEL_VENV_GENERATION_PREFIX))
		.sort((a, b) => a.name.localeCompare(b.name));
	const reclaimable: string[] = [];
	for (const entry of entries) {
		const generation = path.join(generationRoot, entry.name);
		if (!(await exists(path.join(generation, BOOTSTRAP_VERSION_FILE)))) {
			// The global generation-root lock proves that no same-host builder is
			// active. A directory without the bootstrap marker was never selectable.
			await rm(generation, { recursive: true, force: true });
		} else if (
			(await exists(path.join(generation, KERNEL_GENERATION_LEASE_DIR))) &&
			!(await exists(path.join(generation, KERNEL_GENERATION_PUBLISHED_FILE)))
		) {
			// New-format builders create the lease directory before bootstrap and
			// write the publication marker only after the resolver lease is durable.
			await rm(generation, { recursive: true, force: true });
		} else if (await generationHasOnlyDeadLeases(generation)) {
			reclaimable.push(generation);
		}
	}

	const deleteCount = Math.max(0, reclaimable.length - MAX_RETAINED_INACTIVE_KERNEL_GENERATIONS);
	for (const generation of reclaimable.slice(0, deleteCount)) {
		await rm(generation, { recursive: true, force: true });
	}
	// Live and unverifiable generations are exempt from inactive retention so
	// publication never blocks. Once their leases die, a later resolution pass
	// reclaims all but the newest inactive rollback generation.
}

async function createKernelVenvGeneration(
	generationRoot: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<string> {
	await prepareGenerationSlot(generationRoot);
	const identity = kernelEnvironmentIdentity(runtimeIdentity, pythonSkills);
	const generation = await mkdtemp(
		path.join(generationRoot, `${KERNEL_VENV_GENERATION_PREFIX}${identity}-${Date.now()}-${process.pid}-`),
	);
	await mkdir(path.join(generation, KERNEL_GENERATION_LEASE_DIR));
	return generation;
}

async function bootstrapVenv(
	venv: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	await mkdir(path.dirname(venv), { recursive: true });
	const uv = await ensureUv(options);
	const python = path.join(venv, "bin", "python");
	const sourceDir = await resolveRuntimeSourceDir();
	const runtimeRequirement = sourceDir ?? RUNTIME_REQUIREMENT;
	const runtimeIdentity = await resolveRuntimeIdentity();

	await run(uv, ["python", "install", PYTHON_VERSION]);
	await run(uv, ["venv", venv, "--python", PYTHON_VERSION, "--seed"]);
	await run(uv, [
		"pip",
		"install",
		"--python",
		python,
		IPYKERNEL_REQUIREMENT,
		runtimeRequirement,
		STATE_SNAPSHOT_REQUIREMENT,
		...DEFAULT_RLM_EXTRA_UV_ARGS,
	]);
	await syncPythonSkills(uv, venv, python, runtimeIdentity, pythonSkills, options);
}

async function syncPythonSkills(
	uv: string,
	venv: string,
	python: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	const version = await readBootstrapVersion(venv);
	const installedPythonSkills: BootstrapPythonSkill[] = [];
	const currentPythonSkills = new Map(
		(version?.pythonSkills ?? []).map((skill) => [`${skill.importName}\0${skill.packagePath}`, skill]),
	);
	const pythonSkillsByProjectName = new Map(
		pythonSkills.map((skill) => [readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill]),
	);
	const dependenciesBySkill = new Map(
		pythonSkills.map((skill) => [
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						pythonSkillsByProjectName.get(dependencyName) ??
						resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		]),
	);

	for (const skill of sortPythonSkillsForInstall(pythonSkills)) {
		const existingSkill = currentPythonSkills.get(`${skill.importName}\0${skill.packagePath}`);
		if (existingSkill?.pyprojectPath === skill.pyprojectPath && existingSkill.pyprojectHash === skill.pyprojectHash) {
			installedPythonSkills.push(skill);
			continue;
		}

		const localDependencies = dependenciesBySkill.get(skill) ?? [];
		const localDependencyArgs = localDependencies
			.filter((dependency) => {
				const installedDependency = currentPythonSkills.get(`${dependency.importName}\0${dependency.packagePath}`);
				const installedThisSync = installedPythonSkills.some(
					(installed) =>
						installed.importName === dependency.importName &&
						installed.packagePath === dependency.packagePath &&
						installed.pyprojectPath === dependency.pyprojectPath &&
						installed.pyprojectHash === dependency.pyprojectHash,
				);
				return !(
					installedThisSync ||
					(installedDependency?.pyprojectPath === dependency.pyprojectPath &&
						installedDependency.pyprojectHash === dependency.pyprojectHash)
				);
			})
			.flatMap(formatPythonSkillInstallArgs);

		try {
			await run(uv, [
				"pip",
				"install",
				"--python",
				python,
				...formatPythonSkillInstallArgs(skill),
				...localDependencyArgs,
			]);
			installedPythonSkills.push(
				skill,
				...localDependencies.filter((dependency) => !installedPythonSkills.includes(dependency)),
			);
		} catch (error) {
			reportProgress(
				options,
				`Warning: Python skill ${skill.importName} failed to install and will be unavailable: ${errorMessage(error)}`,
			);
		}
	}
	await writeBootstrapVersion(venv, runtimeIdentity, installedPythonSkills, pythonSkills);
}

async function kernelReady(
	python: string,
	venv: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<boolean> {
	return (
		(await hasIpykernel(python)) &&
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity, pythonSkills)
	);
}

function formatBootstrapFailure(error: unknown): Error {
	return new Error(
		`Failed to set up the Python kernel runtime. ${errorMessage(error)}\n` +
			"First-time setup needs internet to install uv, Python, ipykernel, prime-agent-runtime, and default Python packages; once set up, prime-agent runs offline. " +
			"Set PRIME_AGENT_KERNEL_PYTHON to a Python with ipykernel, a current prime-agent-runtime, and default Python packages installed to skip auto-bootstrap.",
	);
}

async function cleanupAbandonedExactVenvBuilds(baseVenv: string): Promise<void> {
	const parent = path.dirname(baseVenv);
	const prefix = `${path.basename(baseVenv)}.building-`;
	let entries: Dirent[];
	try {
		entries = await readdir(parent, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return;
		throw error;
	}
	for (const entry of entries) {
		if (entry.isDirectory() && entry.name.startsWith(prefix)) {
			await rm(path.join(parent, entry.name), { recursive: true, force: true });
		}
	}
}

async function ensureKernelPythonUncached(
	options: EnsureKernelPythonOptions,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<string> {
	const override = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (override) {
		const python = path.resolve(expandHome(override));
		const missing: string[] = [];
		if (!(await hasIpykernel(python))) missing.push("ipykernel");
		if (!(await hasPrimeAgentRuntime(python))) {
			missing.push(
				"a current prime-agent-runtime with callable rlm.run, rlm.host_request, and explicit harness CRUD methods",
			);
		}
		if (missing.length === 0) {
			const missingExtraImports = await missingRlmExtraImportLabels(python);
			if (missingExtraImports.length > 0) {
				missing.push(`default Python packages (${missingExtraImports.join(", ")})`);
			}
		}
		if (missing.length === 0 && pythonSkills.length > 0) {
			const missingPythonSkills = await missingPythonSkillImportLabels(python, options.pythonSkills ?? []);
			if (missingPythonSkills.length > 0) {
				reportProgress(
					options,
					`Warning: Python skills unavailable in PRIME_AGENT_KERNEL_PYTHON and will be disabled: ${missingPythonSkills.join(", ")}`,
				);
			}
		}
		if (missing.length === 0) return python;
		throw new Error(`PRIME_AGENT_KERNEL_PYTHON points to a Python missing ${missing.join(" and ")}: ${python}`);
	}

	const baseVenv = await resolveWritableKernelVenvDir();
	const runtimeIdentity = await resolveRuntimeIdentity();
	const exactPython = path.join(baseVenv, "bin", "python");

	// PRIME_AGENT_KERNEL_VENV remains an exact-path contract. Never silently
	// reinterpret it as a prefix, and never replace a non-current directory that
	// a live process may still be using.
	if (process.env.PRIME_AGENT_KERNEL_VENV) {
		if (await kernelReady(exactPython, baseVenv, runtimeIdentity, pythonSkills)) return exactPython;
		const releaseLock = await acquireBootstrapLock(baseVenv);
		let buildingVenv: string | null = null;
		try {
			await cleanupAbandonedExactVenvBuilds(baseVenv);
			if (await kernelReady(exactPython, baseVenv, runtimeIdentity, pythonSkills)) return exactPython;
			if (await exists(baseVenv)) {
				throw new Error(
					`PRIME_AGENT_KERNEL_VENV points to a non-current environment at ${baseVenv}. ` +
						"Prime Agent will not replace it while another kernel may use it. Stop dependent sessions and remove or move that directory manually, choose a new PRIME_AGENT_KERNEL_VENV, or set PRIME_AGENT_KERNEL_PYTHON.",
				);
			}
			reportProgress(options, "› setting up python kernel (one-time, ~30s)…");
			await mkdir(path.dirname(baseVenv), { recursive: true });
			buildingVenv = await mkdtemp(path.join(path.dirname(baseVenv), `${path.basename(baseVenv)}.building-`));
			await bootstrapVenv(buildingVenv, pythonSkills, options);
			await rename(buildingVenv, baseVenv);
			buildingVenv = null;
			reportProgress(options, "✓ ready");
			return exactPython;
		} catch (error) {
			if (buildingVenv) await rm(buildingVenv, { recursive: true, force: true }).catch(() => undefined);
			throw formatBootstrapFailure(error);
		} finally {
			await releaseLock().catch(() => undefined);
		}
	}

	// Compatibility discovery: a current legacy ~/.prime/agent/kernel-venv is
	// returned in place rather than stranded by the generational layout.
	if (await kernelReady(exactPython, baseVenv, runtimeIdentity, pythonSkills)) return exactPython;

	const generationRoot = kernelGenerationRoot(baseVenv);

	// One root-wide lock serializes resolution leases, same-identity publication,
	// and reclamation so a generation cannot disappear between lookup and lease.
	// Reclamation removes only generations whose recorded process identities are
	// all provably dead.
	const releaseLock = await acquireBootstrapLock(generationRoot);
	let buildingVenv: string | null = null;
	try {
		const concurrentlyBuiltVenv = await findReadyKernelVenv(generationRoot, runtimeIdentity, pythonSkills);
		if (concurrentlyBuiltVenv) {
			await writeFile(path.join(concurrentlyBuiltVenv, KERNEL_GENERATION_PUBLISHED_FILE), "1\n", "utf8");
			await writeKernelGenerationLease(concurrentlyBuiltVenv, process.pid);
			await prepareGenerationSlot(generationRoot);
			return path.join(concurrentlyBuiltVenv, "bin", "python");
		}

		reportProgress(options, "› setting up python kernel (one-time, ~30s)…");
		buildingVenv = await createKernelVenvGeneration(generationRoot, runtimeIdentity, pythonSkills);
		await bootstrapVenv(buildingVenv, pythonSkills, options);
		await writeKernelGenerationLease(buildingVenv, process.pid);
		await writeFile(path.join(buildingVenv, KERNEL_GENERATION_PUBLISHED_FILE), "1\n", "utf8");
		const python = path.join(buildingVenv, "bin", "python");
		buildingVenv = null;
		reportProgress(options, "✓ ready");
		return python;
	} catch (error) {
		if (buildingVenv) await rm(buildingVenv, { recursive: true, force: true }).catch(() => undefined);
		throw formatBootstrapFailure(error);
	} finally {
		await releaseLock().catch(() => undefined);
	}
}

export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
	const pythonSkills = normalizePythonSkills(options.pythonSkills);
	const key = ensureKernelPythonKey(pythonSkills);
	if (inFlightEnsureKernelPython?.key === key) return inFlightEnsureKernelPython.promise;

	const promise = ensureKernelPythonUncached(options, pythonSkills).finally(() => {
		if (inFlightEnsureKernelPython?.promise === promise) inFlightEnsureKernelPython = null;
	});
	inFlightEnsureKernelPython = { key, promise };
	return promise;
}
