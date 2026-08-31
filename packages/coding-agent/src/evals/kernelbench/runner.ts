#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { summarizePrimeIntegrityTrace } from "../prime-integrity/runner.js";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_GIT_DIR = resolve(SOURCE_DIR, "..", "..", "..", "..", "..", ".git");
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

interface Options {
	all: boolean;
	problems: number[];
	limit?: number;
	provider?: string;
	model?: string;
	agentCommand: string;
	configSource: string;
	kernelbenchRoot: string;
	outputDir: string;
	maxTurns: number;
	timeoutMs: number;
	hardening: boolean;
	list: boolean;
	resume: boolean;
	help: boolean;
}

interface CommandResult {
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	stdout: string;
	stderr: string;
}

interface KernelResult {
	problemId: number;
	problemName: string;
	hardware: string;
	compiled: boolean;
	correct: boolean;
	staticValid: boolean;
	staticErrors: string[];
	staticWarnings: string[];
	referenceRuntimeMs?: number;
	kernelRuntimeMs?: number;
	speedup: number;
	fast0: boolean;
	fast1: boolean;
	agentExitCode: number | null;
	agentTimedOut: boolean;
	protectedChanges: string[];
	durationMs: number;
	trace: ReturnType<typeof summarizePrimeIntegrityTrace>;
	workspacePath: string;
	transcriptPath: string;
	infrastructureError?: string;
	graderError?: string;
}

function usage(): string {
	return `Prime AVO KernelBench Level 1

Usage:
  npm run eval:kernelbench -- --list --kernelbench-root /path/to/KernelBench
  npm run eval:kernelbench -- --problem 1 --provider google-vertex --model gemini-3.7-flash
  npm run eval:kernelbench -- --all --resume --provider google-vertex --model gemini-3.7-flash

Options:
  --all                         Run all 100 Level-1 problems
  --problem <id[,id...]>        Run selected problem IDs; repeatable
  --limit <n>                   Limit selected problems
  --kernelbench-root <dir>      Official ScalingIntelligence/KernelBench checkout
  --output <dir>                Durable result directory
  --resume                      Skip problems with an existing result.json
  --provider <name>             Prime provider override
  --model <id>                  Prime model override
  --agent-command <path>        Prime launcher (default: prime-agent-avo)
  --config-source <dir>         Prime auth/settings source
  --max-turns <n>               Autonomous root-turn limit (default: 20)
  --timeout-ms <n>              Per-problem timeout (default: ${DEFAULT_TIMEOUT_MS})
  --hardening <on|off>          Sandbox the agent and authoritative grader (default: on)
  --list                        List Level-1 problems
`;
}

function positiveInteger(value: string | undefined, flag: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
	return parsed;
}

function parseArgs(argv: string[]): Options {
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	const options: Options = {
		all: false,
		problems: [],
		agentCommand: "prime-agent-avo",
		configSource: process.env.PRIME_AGENT_AVO_CONFIG_DIR ?? join(homedir(), ".prime", "agent-avo"),
		kernelbenchRoot: process.env.KERNELBENCH_ROOT ?? resolve(process.cwd(), "..", "..", "..", "KernelBench"),
		outputDir: join(homedir(), ".cache", "prime-agent", "kernelbench", timestamp),
		maxTurns: 20,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		hardening: true,
		list: false,
		resume: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case "--all":
				options.all = true;
				break;
			case "--problem": {
				const value = argv[++index];
				if (!value) throw new Error("--problem requires an ID");
				options.problems.push(...value.split(",").map((item) => positiveInteger(item.trim(), "--problem")));
				break;
			}
			case "--limit":
				options.limit = positiveInteger(argv[++index], "--limit");
				break;
			case "--provider":
				options.provider = argv[++index] || undefined;
				break;
			case "--model":
				options.model = argv[++index] || undefined;
				break;
			case "--agent-command":
				options.agentCommand = argv[++index] || "";
				break;
			case "--config-source":
				options.configSource = resolve(argv[++index] || "");
				break;
			case "--kernelbench-root":
				options.kernelbenchRoot = resolve(argv[++index] || "");
				break;
			case "--output":
				options.outputDir = resolve(argv[++index] || "");
				break;
			case "--max-turns":
				options.maxTurns = positiveInteger(argv[++index], "--max-turns");
				break;
			case "--timeout-ms":
				options.timeoutMs = positiveInteger(argv[++index], "--timeout-ms");
				break;
			case "--hardening": {
				const value = argv[++index];
				if (value !== "on" && value !== "off") throw new Error("--hardening must be on or off");
				options.hardening = value === "on";
				break;
			}
			case "--list":
				options.list = true;
				break;
			case "--resume":
				options.resume = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`unknown argument: ${argument}`);
		}
	}
	return options;
}

function levelOneProblems(root: string): Array<{ id: number; name: string; path: string }> {
	const directory = join(root, "KernelBench", "level1");
	if (!existsSync(directory)) throw new Error(`KernelBench Level 1 directory is missing: ${directory}`);
	return readdirSync(directory)
		.flatMap((name) => {
			const match = /^(\d+)_(.+)\.py$/.exec(name);
			return match
				? [{ id: Number(match[1]), name: match[2]!.replaceAll("_", " ").trim(), path: join(directory, name) }]
				: [];
		})
		.sort((left, right) => left.id - right.id);
}

function resolveExecutable(command: string): string {
	if (command.includes(sep)) return realpathSync(resolve(command));
	const found = spawnSync("which", [command], { encoding: "utf8" });
	if (found.status !== 0 || !found.stdout.trim()) throw new Error(`agent command not found: ${command}`);
	return realpathSync(found.stdout.trim());
}

async function runCommand(
	argv: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; outputLimit?: number },
): Promise<CommandResult> {
	const startedAt = Date.now();
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	const child = spawn(argv[0]!, argv.slice(1), {
		cwd: options.cwd,
		env: options.env ?? process.env,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const limit = options.outputLimit ?? 10_000_000;
	child.stdout.on("data", (chunk: Buffer) => {
		if (stdout.length + stderr.length < limit) stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		if (stdout.length + stderr.length < limit) stderr += chunk.toString("utf8");
	});
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	}, options.timeoutMs);
	const exitCode = await new Promise<number | null>((complete, reject) => {
		child.once("error", reject);
		child.once("close", complete);
	});
	clearTimeout(timer);
	return { exitCode, timedOut, durationMs: Date.now() - startedAt, stdout, stderr };
}

function copyConfig(source: string, destination: string): void {
	mkdirSync(destination, { recursive: true, mode: 0o700 });
	for (const filename of ["auth.json", "models.json", "settings.json", "telemetry.json"]) {
		const input = join(source, filename);
		if (!existsSync(input)) continue;
		const output = join(destination, filename);
		cpSync(input, output);
		chmodSync(output, 0o600);
	}
}

function initialSolution(reference: string): string {
	let solution = reference.replace(/class\s+Model\s*\(/, "class ModelNew(");
	solution = solution.replaceAll("super(Model, self)", "super(ModelNew, self)");
	if (!solution.includes("class ModelNew(")) throw new Error("reference has no Model class");
	return solution;
}

function evaluatorSource(kernelbenchRoot: string, buildCache: string): string {
	return `import hashlib
import json
import os
import re
import sys

ROOT = ${JSON.stringify(kernelbenchRoot)}
BUILD_CACHE = ${JSON.stringify(buildCache)}
sys.path.insert(0, os.path.join(ROOT, "src"))

import torch
from kernelbench import eval as kernel_eval
from kernelbench.kernel_static_checker import validate_kernel_static
from kernelbench.timing import measure_ref_program_time
from kernelbench.utils import set_gpu_arch

reference = open("reference.py", encoding="utf-8").read()
solution = open("solution.py", encoding="utf-8").read()
enforce_static = os.environ.get("KERNELBENCH_ENFORCE_STATIC") == "1"
static_valid, static_errors, static_warnings = validate_kernel_static(solution, backend="cuda", precision="fp32")
static_errors = list(static_errors)
policy_source = re.sub(r"/\\*.*?\\*/|//[^\\n]*|#[^\\n]*", "", solution, flags=re.DOTALL)
for label, pattern in {
    "cuBLAS library fallback": r"\\bcublas(?:Lt)?[A-Za-z0-9_]*\\b",
    "cuDNN library fallback": r"\\bcudnn[A-Za-z0-9_]*\\b",
    "CUTLASS library fallback": r"\\bcutlass(?:::|/)",
    "ATen/PyTorch C++ compute fallback": r"\\b(?:at|torch)::(?:matmul|mm|bmm|einsum)\\s*\\(",
    "dynamic PyTorch operator fallback": r"\\btorch\\.(?:ops|_C)\\b",
}.items():
    if re.search(pattern, policy_source, flags=re.IGNORECASE):
        static_valid = False
        static_errors.append(label)
set_gpu_arch(["Ampere"])
correct_trials = int(os.environ.get("KERNELBENCH_CORRECT_TRIALS", "3"))
perf_trials = int(os.environ.get("KERNELBENCH_PERF_TRIALS", "10"))
build_dir = os.path.join(BUILD_CACHE, hashlib.sha256(solution.encode()).hexdigest())
payload = {
    "hardware": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "unavailable",
    "compiled": False,
    "correct": False,
    "static_valid": static_valid,
    "static_errors": static_errors,
    "static_warnings": static_warnings,
    "speedup": 0.0,
}
try:
    result = kernel_eval.eval_kernel_against_ref(
        original_model_src=reference,
        custom_model_src=solution,
        measure_performance=True,
        timing_method="cuda_event",
        verbose=False,
        num_correct_trials=correct_trials,
        num_perf_trials=perf_trials,
        build_dir=build_dir,
        device=torch.device("cuda:0"),
        backend="cuda",
        precision=torch.float32,
    )
    reference_stats = measure_ref_program_time(
        ref_arch_name="KernelBench reference",
        ref_arch_src=reference,
        num_warmup=3,
        num_trials=perf_trials,
        timing_method="cuda_event",
        use_torch_compile=False,
        device=torch.device("cuda:0"),
        precision="fp32",
    )
    payload.update({
        "compiled": bool(result.compiled),
        "correct": bool(result.correctness),
        "reference_runtime_ms": reference_stats.get("mean"),
        "kernel_runtime_ms": result.runtime if result.runtime and result.runtime > 0 else None,
    })
    if payload["correct"] and payload["kernel_runtime_ms"]:
        payload["speedup"] = payload["reference_runtime_ms"] / payload["kernel_runtime_ms"]
except BaseException as error:
    payload["error"] = f"{type(error).__name__}: {error}"

print("KERNELBENCH_RESULT_JSON:" + json.dumps(payload, sort_keys=True))
raise SystemExit(0 if payload["correct"] and (payload["static_valid"] or not enforce_static) else 1)
`;
}

function pytestSource(kernelbenchRoot: string, baselineSolutionDigest: string): string {
	return `import hashlib
import json
import os
import re
import subprocess

EVALUATOR = os.path.abspath("kernel_eval.py")
PYTHON = ${JSON.stringify(join(kernelbenchRoot, ".venv", "bin", "python"))}
BASELINE_SOLUTION_DIGEST = ${JSON.stringify(baselineSolutionDigest)}

def test_kernelbench_correctness():
    solution_digest = hashlib.sha256(open("solution.py", "rb").read()).hexdigest()
    is_immutable_baseline = solution_digest == BASELINE_SOLUTION_DIGEST
    environment = dict(os.environ)
    environment.update({
        "CC": "/usr/bin/gcc-13",
        "CXX": "/usr/bin/g++-13",
        "KERNELBENCH_ENFORCE_STATIC": "0" if is_immutable_baseline else "1",
    })
    completed = subprocess.run(
        [PYTHON, EVALUATOR],
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=600,
    )
    print(completed.stdout)
    assert completed.returncode == 0
    if not is_immutable_baseline:
        matches = re.findall(r"KERNELBENCH_RESULT_JSON:(\\{[^\\n]+\\})", completed.stdout)
        assert matches, "candidate evaluation emitted no KernelBench result"
        result = json.loads(matches[-1])
        assert result["compiled"] and result["correct"] and result["static_valid"]
        assert result["speedup"] > 1.0, f"candidate is correct but slower than eager: {result['speedup']:.3f}x"
`;
}

function sitecustomizeSource(workspace: string): string {
	return `import sys

WORKSPACE = ${JSON.stringify(workspace)}
sys.path[:] = [entry for entry in sys.path if entry not in ("", WORKSPACE)]
`;
}

function taskPrompt(problem: { id: number; name: string }): string {
	return `# KernelBench Level 1 — Problem ${problem.id}: ${problem.name}

Optimize solution.py for the local NVIDIA GeForce RTX 3050 Laptop GPU (Ampere, 4 GB) while preserving reference.py exactly.

- Define ModelNew and replace the reference computation with genuine custom CUDA.
- The computation must execute in your own CUDA kernel. cuBLAS, cuDNN, CUTLASS, ATen/PyTorch C++ compute calls, and dummy-kernel wrappers are forbidden and rejected by the host.
- Preserve FP32 correctness on randomized KernelBench inputs.
- Target speedup > 1.0 over PyTorch eager. Do not call a slower result optimized.
- Never modify reference.py, test_kernel.py, kernel_eval.py, sitecustomize.py, pytest.ini, or evaluator behavior.
- Before editing, call avo.run_coding_baseline with exactly: python3 -m pytest -vv -rP --capture=fd -p no:cacheprovider test_kernel.py
- Use that identical command for every AVO candidate evaluation. Inspect KERNELBENCH_RESULT_JSON and iterate when correct but slow.
- Complete the AVO candidate, host evaluation, cycle, and stop gate; return the exact accepted candidate summary only.

This task is local and self-contained. Online search is not required.`;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function immutableFileDigest(path: string): string | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
		return sha256(path);
	} catch {
		return undefined;
	}
}

function findJsonl(root: string): string[] {
	if (!existsSync(root)) return [];
	const output: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && path.endsWith(".jsonl")) output.push(path);
		}
	};
	visit(root);
	return output;
}

function parseKernelResult(
	output: string,
): Omit<
	KernelResult,
	| "problemId"
	| "problemName"
	| "agentExitCode"
	| "agentTimedOut"
	| "protectedChanges"
	| "durationMs"
	| "trace"
	| "workspacePath"
	| "transcriptPath"
	| "fast0"
	| "fast1"
> {
	const matches = [...output.matchAll(/KERNELBENCH_RESULT_JSON:(\{[^\n]+\})/g)];
	if (matches.length === 0) throw new Error("host grader emitted no KernelBench result");
	const parsed = JSON.parse(matches.at(-1)![1]!) as Record<string, unknown>;
	return {
		hardware: typeof parsed.hardware === "string" ? parsed.hardware : "unknown",
		compiled: parsed.compiled === true,
		correct: parsed.correct === true,
		staticValid: parsed.static_valid === true,
		staticErrors: Array.isArray(parsed.static_errors) ? parsed.static_errors.map(String) : [],
		staticWarnings: Array.isArray(parsed.static_warnings) ? parsed.static_warnings.map(String) : [],
		referenceRuntimeMs: typeof parsed.reference_runtime_ms === "number" ? parsed.reference_runtime_ms : undefined,
		kernelRuntimeMs: typeof parsed.kernel_runtime_ms === "number" ? parsed.kernel_runtime_ms : undefined,
		speedup: typeof parsed.speedup === "number" ? parsed.speedup : 0,
		graderError: typeof parsed.error === "string" ? parsed.error : undefined,
	};
}

const KERNELBENCH_GRADE_ENVIRONMENT_ALLOWLIST = new Set([
	"CUDA_DEVICE_ORDER",
	"CUDA_VISIBLE_DEVICES",
	"LD_LIBRARY_PATH",
	"MAX_JOBS",
	"NVIDIA_DRIVER_CAPABILITIES",
	"NVIDIA_VISIBLE_DEVICES",
]);

export function kernelBenchGradeEnvironment(
	hostEnvironment: NodeJS.ProcessEnv,
	kernelbenchRoot: string,
	buildCache: string,
): NodeJS.ProcessEnv {
	const allowed = Object.fromEntries(
		Object.entries(hostEnvironment).filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined && KERNELBENCH_GRADE_ENVIRONMENT_ALLOWLIST.has(entry[0]),
		),
	);
	return {
		...allowed,
		HOME: homedir(),
		XDG_CACHE_HOME: join(buildCache, "xdg-cache"),
		XDG_CONFIG_HOME: join(homedir(), ".config"),
		XDG_DATA_HOME: join(homedir(), ".local", "share"),
		XDG_STATE_HOME: join(homedir(), ".local", "state"),
		TMPDIR: "/tmp",
		TMP: "/tmp",
		TEMP: "/tmp",
		PATH: [join(kernelbenchRoot, ".venv", "bin"), "/usr/local/cuda/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(
			":",
		),
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		PYTHONNOUSERSITE: "1",
		PYTHONDONTWRITEBYTECODE: "1",
		KERNELBENCH_ENFORCE_STATIC: "1",
		KERNELBENCH_CORRECT_TRIALS: "5",
		KERNELBENCH_PERF_TRIALS: "50",
		TORCH_EXTENSIONS_DIR: buildCache,
		CUDA_CACHE_PATH: join(buildCache, "cuda-cache"),
		CC: "/usr/bin/gcc-13",
		CXX: "/usr/bin/g++-13",
	};
}

export function kernelBenchGradeCommand(hardening: boolean): string[] {
	return [
		hardening ? "/usr/bin/python3" : "python3",
		"-I",
		"-c",
		'import runpy; runpy.run_path("test_kernel.py", run_name="kernelbench_trusted_grade")["test_kernelbench_correctness"]()',
	];
}

function maskedMountTargetArgs(paths: readonly string[]): string[] {
	const maskedRoots = [...new Set(["/tmp", "/run", homedir()].map((path) => resolve(path)))].sort(
		(left, right) => right.length - left.length,
	);
	const created = new Set<string>();
	const args: string[] = [];
	for (const path of paths.map((item) => resolve(item))) {
		const root = maskedRoots.find((candidate) => path === candidate || path.startsWith(`${candidate}${sep}`));
		if (!root) continue;
		const parent = dirname(path);
		const suffix = relative(root, parent);
		if (!suffix || suffix === "." || suffix === ".." || suffix.startsWith(`..${sep}`)) continue;
		let current = root;
		for (const segment of suffix.split(sep)) {
			current = join(current, segment);
			if (created.has(current)) continue;
			args.push("--dir", current);
			created.add(current);
		}
	}
	return args;
}

export function buildKernelBenchGradeSandboxArgs(
	command: string[],
	workspace: string,
	buildCache: string,
	kernelbenchRoot: string,
	environment: NodeJS.ProcessEnv = kernelBenchGradeEnvironment(process.env, kernelbenchRoot, buildCache),
): string[] {
	for (const [label, path] of [
		["workspace", workspace],
		["build cache", buildCache],
	] as const) {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`KernelBench grade ${label} must be a host-owned directory: ${path}`);
		}
	}
	const caseRoot = dirname(resolve(workspace));
	if (dirname(resolve(buildCache)) !== caseRoot) {
		throw new Error("KernelBench grade build cache must be a dedicated sibling of the workspace");
	}
	const pythonPath = realpathSync(join(kernelbenchRoot, ".venv", "bin", "python"));
	const pythonInstallRoot = dirname(dirname(pythonPath));
	const interpreterCatalogRoot = pythonPath.startsWith(`${homedir()}${sep}`) ? dirname(pythonInstallRoot) : undefined;
	const readOnlyBindings = [
		...new Set([kernelbenchRoot, workspace, interpreterCatalogRoot].filter(Boolean)),
	] as string[];
	const mountPaths = [...readOnlyBindings, buildCache];
	const environmentArgs = Object.entries(environment)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([name, value]) => ["--setenv", name, value]);
	return [
		"/usr/bin/bwrap",
		"--ro-bind",
		"/",
		"/",
		"--dev-bind",
		"/dev",
		"/dev",
		"--tmpfs",
		"/dev/shm",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/run",
		"--tmpfs",
		homedir(),
		...maskedMountTargetArgs(mountPaths),
		"--tmpfs",
		caseRoot,
		...readOnlyBindings.flatMap((path) => ["--ro-bind", path, path]),
		"--bind",
		buildCache,
		buildCache,
		"--unshare-net",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--disable-userns",
		"--assert-userns-disabled",
		"--new-session",
		"--die-with-parent",
		"--cap-drop",
		"ALL",
		"--chdir",
		workspace,
		"--clearenv",
		...environmentArgs,
		"--",
		...command,
	];
}

function sandboxArgs(
	executable: string,
	args: string[],
	runRoot: string,
	workspace: string,
	protectedPaths: string[],
): string[] {
	const argv = [
		"bwrap",
		"--ro-bind",
		"/",
		"/",
		"--dev-bind",
		"/dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
		"--bind",
		runRoot,
		runRoot,
		"--tmpfs",
		REPOSITORY_GIT_DIR,
		"--unshare-pid",
		"--die-with-parent",
		"--chdir",
		workspace,
	];
	for (const path of protectedPaths) argv.push("--ro-bind", path, path);
	argv.push("--", executable, ...args);
	return argv;
}

async function runProblem(
	problem: { id: number; name: string; path: string },
	options: Options,
	agentExecutable: string,
): Promise<KernelResult> {
	const caseRoot = join(options.outputDir, `problem-${String(problem.id).padStart(3, "0")}`);
	const workspace = join(caseRoot, "workspace");
	const runtimeRoot = join(caseRoot, "runtime");
	const sessionDir = join(runtimeRoot, "sessions");
	const artifactRoot = join(runtimeRoot, "session-artifacts");
	const agentDir = join(runtimeRoot, "agent");
	const supervisorDir = join(runtimeRoot, "supervisor");
	const buildCache = join(caseRoot, "build-cache");
	const transcriptPath = join(caseRoot, "transcript.log");
	for (const path of [workspace, sessionDir, supervisorDir, buildCache]) mkdirSync(path, { recursive: true });
	const startingSolution = initialSolution(readFileSync(problem.path, "utf8"));
	const baselineSolutionDigest = createHash("sha256").update(startingSolution).digest("hex");
	writeFileSync(join(workspace, "reference.py"), readFileSync(problem.path));
	writeFileSync(join(workspace, "solution.py"), startingSolution);
	writeFileSync(join(workspace, "kernel_eval.py"), evaluatorSource(options.kernelbenchRoot, buildCache));
	writeFileSync(join(workspace, "test_kernel.py"), pytestSource(options.kernelbenchRoot, baselineSolutionDigest));
	writeFileSync(join(workspace, "TASK.md"), `${taskPrompt(problem)}\n`);
	writeFileSync(join(workspace, ".gitignore"), "__pycache__/\n*.pyc\n.pytest_cache/\n");
	writeFileSync(join(workspace, "sitecustomize.py"), sitecustomizeSource(workspace));
	writeFileSync(join(workspace, "pytest.ini"), "[pytest]\naddopts = --noconftest --import-mode=importlib\n");
	for (const python of ["python3", join(options.kernelbenchRoot, ".venv", "bin", "python")]) {
		const compiled = spawnSync(python, ["-m", "py_compile", "test_kernel.py", "kernel_eval.py"], {
			cwd: workspace,
			encoding: "utf8",
		});
		if (compiled.status !== 0) throw new Error(`could not prepare Python fixture: ${compiled.stderr}`);
	}
	for (const args of [
		["git", "init", "-q"],
		["git", "config", "user.email", "kernelbench@localhost"],
		["git", "config", "user.name", "Prime KernelBench"],
		["git", "add", "."],
		["git", "commit", "-qm", "KernelBench fixture"],
	]) {
		const completed = spawnSync(args[0]!, args.slice(1), { cwd: workspace, encoding: "utf8" });
		if (completed.status !== 0) throw new Error(`fixture git setup failed: ${completed.stderr}`);
	}
	const protectedPaths = [
		"reference.py",
		"test_kernel.py",
		"kernel_eval.py",
		"sitecustomize.py",
		"pytest.ini",
		"TASK.md",
	].map((name) => join(workspace, name));
	const protectedBefore = new Map(protectedPaths.map((path) => [path, immutableFileDigest(path)]));
	for (const path of protectedPaths) chmodSync(path, 0o444);
	copyConfig(options.configSource, agentDir);
	const agentArgs = [
		"--daemon-socket",
		`/tmp/prime-kernelbench-${problem.id}.sock`,
		"--cwd",
		workspace,
		"--print",
		"--mode",
		"text",
		"--autonomous",
		"--autonomous-max-turns",
		String(options.maxTurns),
		"--autonomous-timeout-ms",
		String(options.timeoutMs),
		"--session-dir",
		sessionDir,
		"--offline",
		"--no-context-files",
		"--no-extensions",
		...(options.provider ? ["--provider", options.provider] : []),
		...(options.model ? ["--model", options.model] : []),
		"--thinking",
		"high",
		"--",
		taskPrompt(problem),
	];
	const environment = {
		...process.env,
		PRIME_AGENT_AVO_CONFIG_DIR: agentDir,
		PRIME_AGENT_CODING_AGENT_DIR: agentDir,
		PRIME_AGENT_SESSION_DIR: sessionDir,
		PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR: supervisorDir,
		PRIME_AGENT_KERNEL_PYTHON: join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
		TORCH_EXTENSIONS_DIR: buildCache,
		CC: "/usr/bin/gcc-13",
		CXX: "/usr/bin/g++-13",
	};
	const startedAt = Date.now();
	const agent = await runCommand(
		options.hardening
			? sandboxArgs(agentExecutable, agentArgs, caseRoot, workspace, protectedPaths)
			: [agentExecutable, ...agentArgs],
		{ cwd: workspace, env: environment, timeoutMs: options.timeoutMs + 30_000 },
	);
	writeFileSync(transcriptPath, `# stdout\n${agent.stdout}\n# stderr\n${agent.stderr}\n`);
	const protectedChanges = protectedPaths.filter((path) => protectedBefore.get(path) !== immutableFileDigest(path));
	const gradeCommand = kernelBenchGradeCommand(options.hardening);
	const gradeEnvironment = options.hardening
		? kernelBenchGradeEnvironment(process.env, options.kernelbenchRoot, buildCache)
		: {
				...process.env,
				KERNELBENCH_ENFORCE_STATIC: "1",
				KERNELBENCH_CORRECT_TRIALS: "5",
				KERNELBENCH_PERF_TRIALS: "50",
				CC: "/usr/bin/gcc-13",
				CXX: "/usr/bin/g++-13",
			};
	const grade =
		protectedChanges.length === 0
			? await runCommand(
					options.hardening
						? buildKernelBenchGradeSandboxArgs(
								gradeCommand,
								workspace,
								buildCache,
								options.kernelbenchRoot,
								gradeEnvironment,
							)
						: gradeCommand,
					{
						cwd: workspace,
						timeoutMs: 15 * 60 * 1000,
						env: gradeEnvironment,
					},
				)
			: {
					exitCode: 1,
					timedOut: false,
					durationMs: 0,
					stdout: "",
					stderr: `authoritative grading refused modified control files: ${protectedChanges.join(", ")}\n`,
				};
	writeFileSync(join(caseRoot, "host-grade.log"), `${grade.stdout}\n${grade.stderr}`);
	let infrastructureError: string | undefined;
	let parsed: ReturnType<typeof parseKernelResult>;
	if (protectedChanges.length > 0) {
		parsed = {
			hardware: "unknown",
			compiled: false,
			correct: false,
			staticValid: false,
			staticErrors: [],
			staticWarnings: [],
			speedup: 0,
			graderError: "authoritative grading refused modified control files",
		};
	} else {
		try {
			parsed = parseKernelResult(`${grade.stdout}\n${grade.stderr}`);
			if (grade.timedOut) infrastructureError = "host grader timed out after 15 minutes";
			if (
				!infrastructureError &&
				parsed.graderError &&
				sha256(join(workspace, "solution.py")) === baselineSolutionDigest &&
				/(?:outofmemory|out of memory|cuda is unavailable|no cuda|driver)/i.test(parsed.graderError)
			) {
				infrastructureError = `immutable reference could not run on this host: ${parsed.graderError}`;
			}
		} catch (error) {
			infrastructureError = `host grader produced no parseable result: ${error instanceof Error ? error.message : String(error)}`;
			parsed = {
				hardware: "unknown",
				compiled: false,
				correct: false,
				staticValid: false,
				staticErrors: [],
				staticWarnings: [],
				speedup: 0,
			};
		}
	}
	const result: KernelResult = {
		problemId: problem.id,
		problemName: problem.name,
		...parsed,
		fast0: !infrastructureError && parsed.correct && parsed.staticValid && protectedChanges.length === 0,
		fast1:
			!infrastructureError &&
			parsed.correct &&
			parsed.staticValid &&
			parsed.speedup > 1 &&
			protectedChanges.length === 0,
		agentExitCode: agent.exitCode,
		agentTimedOut: agent.timedOut,
		protectedChanges,
		durationMs: Date.now() - startedAt,
		trace: summarizePrimeIntegrityTrace(findJsonl(sessionDir), artifactRoot),
		workspacePath: workspace,
		transcriptPath,
		...(infrastructureError ? { infrastructureError } : {}),
	};
	writeFileSync(join(caseRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	return result;
}

function writeReport(options: Options, results: KernelResult[]): void {
	const rate = (predicate: (result: KernelResult) => boolean): number =>
		results.length === 0 ? 0 : results.filter(predicate).length / results.length;
	const report = {
		schemaVersion: 1,
		benchmark: "KernelBench Level 1 via Prime AVO",
		provider: options.provider,
		model: options.model,
		problemCount: results.length,
		hardware: [...new Set(results.map((result) => result.hardware))],
		metrics: {
			fast0: rate((result) => result.fast0),
			fast1: rate((result) => result.fast1),
			compileRate: rate((result) => result.compiled),
			staticValidityRate: rate((result) => result.staticValid),
			meanSpeedup:
				results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.speedup, 0) / results.length,
			costUsd: results.reduce((sum, result) => sum + result.trace.costUsd, 0),
			totalTokens: results.reduce((sum, result) => sum + result.trace.totalTokens, 0),
		},
		results,
	};
	writeFileSync(join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	const rows = results
		.map(
			(result) =>
				`| ${result.problemId} | ${result.compiled ? "yes" : "no"} | ${result.correct ? "yes" : "no"} | ${result.staticValid ? "yes" : "no"} | ${result.speedup.toFixed(3)}x | ${result.fast1 ? "PASS" : "FAIL"} | $${result.trace.costUsd.toFixed(3)} |`,
		)
		.join("\n");
	writeFileSync(
		join(options.outputDir, "report.md"),
		`# KernelBench Level 1 via Prime AVO\n\nProblems: ${results.length}\n\n| Problem | Compiled | Correct | Static | Speedup | fast_1 | Cost |\n| ---: | --- | --- | --- | ---: | --- | ---: |\n${rows}\n`,
	);
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) return void process.stdout.write(usage());
	const catalog = levelOneProblems(options.kernelbenchRoot);
	if (options.list) {
		for (const problem of catalog) process.stdout.write(`${problem.id}\t${problem.name}\n`);
		return;
	}
	if (!options.all && options.problems.length === 0) throw new Error("select --problem <id> or --all");
	if (options.hardening && (!existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3"))) {
		throw new Error("hardening requires bubblewrap (/usr/bin/bwrap) and Python (/usr/bin/python3)");
	}
	if (!existsSync(join(options.kernelbenchRoot, ".venv", "bin", "python"))) {
		throw new Error("KernelBench environment is missing; run `uv sync` in the official checkout");
	}
	let selected = options.all ? catalog : catalog.filter((problem) => options.problems.includes(problem.id));
	if (options.limit) selected = selected.slice(0, options.limit);
	if (selected.length === 0) throw new Error("no matching Level-1 problems");
	mkdirSync(options.outputDir, { recursive: true });
	const agentExecutable = resolveExecutable(options.agentCommand);
	const results: KernelResult[] = [];
	for (const [index, problem] of selected.entries()) {
		const resultPath = join(options.outputDir, `problem-${String(problem.id).padStart(3, "0")}`, "result.json");
		if (options.resume && existsSync(resultPath)) {
			results.push(JSON.parse(readFileSync(resultPath, "utf8")) as KernelResult);
			process.stdout.write(`[${index + 1}/${selected.length}] resumed problem ${problem.id}\n`);
			continue;
		}
		process.stdout.write(`[${index + 1}/${selected.length}] running problem ${problem.id}: ${problem.name}\n`);
		const result = await runProblem(problem, options, agentExecutable);
		results.push(result);
		writeReport(options, results);
		process.stdout.write(
			`  correct=${result.correct} static=${result.staticValid} speedup=${result.speedup.toFixed(3)}x fast_1=${result.fast1}\n`,
		);
	}
	writeReport(options, results);
	process.stdout.write(`KernelBench report: ${options.outputDir}\n`);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
	main().catch((error: unknown) => {
		process.stderr.write(`KernelBench runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
