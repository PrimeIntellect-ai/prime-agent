import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import {
	aggregateSpecBenchConditions,
	buildSpecBenchAgentArgs,
	buildSpecBenchBaselineTestSource,
	buildSpecBenchGradeArgs,
	buildSpecBenchGradeSandboxArgs,
	buildSpecBenchResolverSandboxArgs,
	buildSpecBenchSandboxArgs,
	createSpecBenchGradeDeadline,
	deriveSpecBenchExecutionBudgets,
	ensureSpecBenchGraderPython,
	listSpecBenchTasks,
	loadTaskMetadata,
	parseSpecBenchArgs,
	parseSpecBenchGrade,
	parseSpecBenchJUnitXml,
	prepareSpecBenchConfig,
	primeImplementationProvenance,
	type SpecBenchResult,
	specBenchAgentEnvironment,
	specBenchAgentInfrastructureErrorFromSessionJsonl,
	specBenchCatalogDigest,
	specBenchFalseCompletion,
	specBenchGradeEnvironment,
	specBenchGradePasses,
	specBenchHiddenSuitesPass,
	specBenchHostFixtures,
	specBenchInfrastructureError,
	specBenchLockedStarterPaths,
	specBenchNetworkPolicyViolations,
	specBenchNetworkToolPolicyViolations,
	specBenchRemainingGradeTimeoutMs,
	specBenchTaskPrompt,
	specBenchToolchainProvenance,
	specBenchVerificationHiddenPaths,
	stageSpecBenchGradeControl,
	stageSpecBenchHostFixtures,
	stageSpecBenchVisibleFixture,
	withSpecBenchBrokerLifecycle,
} from "../src/evals/specbench/runner.js";

describe("SpecBench evaluation runner", () => {
	test("binds the visible contract subprocess to the official task budget", () => {
		const source = buildSpecBenchBaselineTestSource(
			{ "parser.py": "raise NotImplementedError\n" },
			30,
			"/trusted/python",
			"c_compiler",
		);
		expect(source).toContain('"--timeout=30"');
		expect(source).toContain("timeout=30");
		expect(source).toContain('"pytest_timeout"');
		expect(source).toContain("assert junit_path.is_file()");
		expect(source).toContain(".specbench-visible/tests/public");
		expect(source).toContain('"-vv"');
		expect(source).toContain('TASK_ID = "c_compiler"');
		expect(source).toContain("executed zero non-skipped tests");
		expect(source).toContain("assert starter_changed");
		expect(source).not.toContain("if unchanged:");
	});

	test("preserves the public test package layout without staging hidden suites or reference source", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-visible-"));
		const taskRoot = join(root, "database_engine");
		const testsRoot = join(taskRoot, "tests");
		const publicRoot = join(testsRoot, "public");
		mkdirSync(publicRoot, { recursive: true });
		mkdirSync(join(testsRoot, "private"));
		mkdirSync(join(testsRoot, "id_private"));
		mkdirSync(join(taskRoot, "reference"));
		writeFileSync(join(publicRoot, "test_public.py"), "from ..slt_runner import run\n");
		writeFileSync(join(testsRoot, "__init__.py"), "");
		writeFileSync(join(testsRoot, "conftest.py"), "# shared fixture\n");
		writeFileSync(join(testsRoot, "slt_runner.py"), "def run(): return True\n");
		writeFileSync(join(testsRoot, "private", "test_private.py"), "SECRET = True\n");
		writeFileSync(join(testsRoot, "id_private", "test_id_private.py"), "SECRET = True\n");
		writeFileSync(join(taskRoot, "reference", "oracle.py"), "SECRET = True\n");
		const workspace = join(root, "workspace");
		mkdirSync(workspace);

		const staged = stageSpecBenchVisibleFixture({
			taskId: "database_engine",
			publicTestDir: publicRoot,
			starterCode: { "main.c": "int main(void) { return 0; }\n" },
			workspace,
		});

		expect(existsSync(join(staged.visibleRoot, "tests", "public", "test_public.py"))).toBe(true);
		expect(existsSync(join(staged.visibleRoot, "tests", "conftest.py"))).toBe(true);
		expect(existsSync(join(staged.visibleRoot, "tests", "slt_runner.py"))).toBe(true);
		expect(existsSync(join(staged.visibleRoot, "tests", "private"))).toBe(false);
		expect(existsSync(join(staged.visibleRoot, "tests", "id_private"))).toBe(false);
		expect(existsSync(join(staged.visibleRoot, "reference"))).toBe(false);
		expect(existsSync(join(workspace, "tests", "public", "test_public.py"))).toBe(true);
		expect(existsSync(join(workspace, "tests", "slt_runner.py"))).toBe(true);
		expect(existsSync(join(workspace, "tests", "private"))).toBe(false);
		expect(existsSync(join(workspace, "tests", "id_private"))).toBe(false);
		expect(staged.protectedAliasPaths).toEqual([join(workspace, "tests")]);
		expect(staged.visibleFixtureDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	test("binds the sealed os_kernel filesystem image as a host-only disposable fixture", () => {
		const taskRoot = mkdtempSync(join(tmpdir(), "prime-specbench-os-fixture-"));
		try {
			mkdirSync(join(taskRoot, "reference"));
			writeFileSync(join(taskRoot, "reference", "fs.img"), "sealed-program-image");
			const fixtures = specBenchHostFixtures("os_kernel", taskRoot);
			expect(fixtures).toEqual([
				{
					sourcePath: join(taskRoot, "reference", "fs.img"),
					destinationPath: "fs.img",
					digest: createHash("sha256").update("sealed-program-image").digest("hex"),
				},
			]);
			const disposableWorkspace = join(taskRoot, "disposable-workspace");
			mkdirSync(disposableWorkspace);
			expect(stageSpecBenchHostFixtures(disposableWorkspace, fixtures)).toEqual([
				join(disposableWorkspace, "fs.img"),
			]);
			expect(readFileSync(join(disposableWorkspace, "fs.img"), "utf8")).toBe("sealed-program-image");
			expect(specBenchHostFixtures("json_parser", taskRoot)).toEqual([]);
		} finally {
			rmSync(taskRoot, { recursive: true, force: true });
		}
	});

	test("expands official locked starter paths without locking generated object files", () => {
		expect(
			specBenchLockedStarterPaths("ray_tracer", {
				"main.c": "",
				"vec3.h": "",
				"ray.h": "",
				"cjson/cJSON.c": "",
				"cjson/cJSON.h": "",
				"renderer.c": "",
			}),
		).toEqual(["cjson/cJSON.c", "cjson/cJSON.h", "main.c", "ray.h", "vec3.h"]);
		expect(specBenchLockedStarterPaths("tcp_stack", { "sim_link.c": "", "sim_link.h": "", "tcp.c": "" })).toEqual([
			"sim_link.c",
			"sim_link.h",
		]);
	});

	test("bounds model-authored cells and all official grading independently of the outer task timeout", () => {
		expect(deriveSpecBenchExecutionBudgets(30)).toEqual({
			ipythonCellTimeoutMs: 60_000,
			gradeSuiteTimeoutMs: 30_000,
			gradeTotalTimeoutMs: 180_000,
		});
		expect(deriveSpecBenchExecutionBudgets(600)).toEqual({
			ipythonCellTimeoutMs: 120_000,
			gradeSuiteTimeoutMs: 120_000,
			gradeTotalTimeoutMs: 180_000,
		});
	});

	test("caps sequential grading suites by one monotonic total deadline", () => {
		const deadline = createSpecBenchGradeDeadline(180_000, 120_000, 1_000);
		expect(specBenchRemainingGradeTimeoutMs(deadline, 1_000)).toBe(120_000);
		expect(specBenchRemainingGradeTimeoutMs(deadline, 121_000)).toBe(60_000);
		expect(specBenchRemainingGradeTimeoutMs(deadline, 181_000)).toBe(0);
	});

	test("parses explicit task and hardening controls", () => {
		const parsed = parseSpecBenchArgs([
			"--task",
			"json_parser,http_server",
			"--max-turns",
			"18",
			"--hardening",
			"on",
		]);
		expect(parsed.tasks).toEqual(["json_parser", "http_server"]);
		expect(parsed.maxTurns).toBe(18);
		expect(parsed.hardening).toBe(true);
	});

	test("parses a repeated one-feature-at-a-time ablation matrix", () => {
		const parsed = parseSpecBenchArgs(["--task", "json_parser", "--ablation-matrix", "--repetitions", "3"]);
		expect(parsed.conditions).toEqual([
			"full",
			"no-obligations",
			"no-assumptions",
			"no-watchdog",
			"no-adversarial-supervision",
			"no-impact",
			"no-nooa",
		]);
		expect(parsed.repetitions).toBe(3);
	});

	test("builds a launch command accepted by the actual Prime CLI parser", () => {
		const args = buildSpecBenchAgentArgs({
			taskId: "json_parser",
			workspace: "/tmp/specbench/workspace",
			sessionDir: "/tmp/specbench/sessions",
			maxTurns: 30,
			timeoutMs: 60_000,
			provider: "google-vertex",
			model: "gemini-3.7-flash",
			prompt: "Implement TASK.md",
		});
		expect(args).toContain("--no-env");
		const parsed = parseArgs(args.filter((argument) => argument !== "--no-env"));

		expect(parsed.unknownFlags.size).toBe(0);
		expect(parsed.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
		expect(parsed).toMatchObject({
			cwd: "/tmp/specbench/workspace",
			offline: true,
			noContextFiles: true,
			noExtensions: true,
			provider: "google-vertex",
			model: "gemini-3.7-flash",
			autonomous: true,
			autonomousMaxTurns: 30,
		});
		expect(parsed.messages).toEqual(["Implement TASK.md"]);
	});

	test("discovers only official task-shaped directories", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-catalog-"));
		const tasks = join(root, "benchmarks", "spec_bench", "tasks");
		for (const name of ["json_parser", "http_server"]) {
			mkdirSync(join(tasks, name), { recursive: true });
			writeFileSync(join(tasks, name, "task.py"), "def get_task(): ...\n");
		}
		mkdirSync(join(tasks, "base"), { recursive: true });
		expect(listSpecBenchTasks(root)).toEqual(["http_server", "json_parser"]);
	});

	test("fingerprints tracked broken symlinks without dereferencing them", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-catalog-digest-"));
		try {
			const starter = join(root, "benchmarks", "spec_bench", "tasks", "tcp_stack", "starter");
			mkdirSync(starter, { recursive: true });
			writeFileSync(join(starter, "tcp.py"), "def connect(): ...\n");
			const link = join(starter, "step0_root");
			symlinkSync("../step0_root", link);
			expect(existsSync(link)).toBe(false);
			for (const args of [
				["init", "-q"],
				["add", "."],
			]) {
				const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
				expect(result.status, result.stderr).toBe(0);
			}

			const before = specBenchCatalogDigest(root);
			rmSync(link);
			symlinkSync("../other-missing-root", link);
			expect(specBenchCatalogDigest(root)).not.toBe(before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("loads the official additional instructions through the Python metadata bridge", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-metadata-"));
		const taskRoot = join(root, "benchmarks", "spec_bench", "tasks", "json_parser");
		for (const packageRoot of [
			join(root, "benchmarks"),
			join(root, "benchmarks", "spec_bench"),
			join(root, "benchmarks", "spec_bench", "tasks"),
			taskRoot,
		]) {
			mkdirSync(packageRoot, { recursive: true });
			writeFileSync(join(packageRoot, "__init__.py"), "");
		}
		writeFileSync(join(taskRoot, "__init__.py"), "from .task import get_task\n");
		mkdirSync(join(taskRoot, "tests", "public"), { recursive: true });
		mkdirSync(join(taskRoot, "tests", "private"), { recursive: true });
		writeFileSync(
			join(taskRoot, "task.py"),
			`from pathlib import Path
class Task:
    task_id = "json_parser"
    display_name = "JSON Parser"
    language = "python"
    entry_point = "parser"
    timeout_seconds = 30
    spec_document = "Parse JSON."
    starter_code = {"parser.py": "pass\\n"}
    public_test_dir = Path(__file__).parent / "tests" / "public"
    private_test_dir = Path(__file__).parent / "tests" / "private"
    def get_additional_instructions(self): return "Do not use json.loads."
def get_task(): return Task()
`,
		);

		expect(loadTaskMetadata(root, "json_parser")).toMatchObject({
			taskId: "json_parser",
			additionalInstructions: "Do not use json.loads.",
		});
	});

	test("keeps hidden suites out of the model-facing prompt", () => {
		const prompt = specBenchTaskPrompt({
			taskId: "json_parser",
			displayName: "JSON Parser",
			specDocument: "Support strings and numbers.",
		});
		expect(prompt).toContain("Support strings and numbers.");
		expect(prompt).toContain(".specbench-visible/tests/public");
		expect(prompt).toContain("Do not search online or browse the web");
		expect(prompt).not.toContain("id_private");
		expect(prompt).not.toContain("tests/private");
	});

	test("appends the official task-specific instructions after the specification", () => {
		const prompt = specBenchTaskPrompt({
			taskId: "crypto_primitives",
			displayName: "Cryptographic Primitives",
			specDocument: "Implement SHA-256.",
			additionalInstructions: "Do NOT use hashlib.",
		});

		expect(prompt).toContain("Implement SHA-256.\n\nDo NOT use hashlib.");
	});

	test("removes obligation-specific task guidance only for its ablation", () => {
		const task = {
			taskId: "json_parser",
			displayName: "JSON Parser",
			specDocument: "Support strings and numbers.",
		};
		expect(specBenchTaskPrompt(task)).toContain("as an obligation");
		const ablated = specBenchTaskPrompt(task, ["obligations"]);
		expect(ablated).not.toContain("as an obligation");
		expect(ablated).toContain("Implement every requirement and constraint");
	});

	test("prepares a benchmark-only config without unrelated credentials or online tools", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-config-"));
		const source = join(root, "source");
		const destination = join(root, "destination");
		mkdirSync(source);
		writeFileSync(
			join(source, "settings.json"),
			JSON.stringify({
				defaultProvider: "google-vertex",
				mcpServers: { github: { url: "https://example.invalid" } },
				bundledSkills: { websearch: true },
			}),
		);
		writeFileSync(
			join(source, "auth.json"),
			JSON.stringify({
				"google-vertex": { type: "api_key", key: "vertex-key" },
				"mcp:github": { type: "api_key", key: "github-key" },
				openrouter: { type: "api_key", key: "openrouter-key" },
			}),
		);
		writeFileSync(join(source, "models.json"), JSON.stringify({ providers: {} }));

		prepareSpecBenchConfig(source, destination, "google-vertex");

		expect(JSON.parse(readFileSync(join(destination, "settings.json"), "utf8"))).toMatchObject({
			mcpServers: {},
			bundledSkills: { websearch: false },
		});
		expect(JSON.parse(readFileSync(join(destination, "auth.json"), "utf8"))).toEqual({
			"google-vertex": { type: "api_key", key: "vertex-key" },
		});
	});

	test("forces native search off and removes inherited search credentials", () => {
		const environment = specBenchAgentEnvironment({
			PATH: "/bin",
			GOOGLE_VERTEX_GOOGLE_SEARCH: "1",
			SERPER_API_KEY: "serper-secret",
			TAVILY_API_KEY: "tavily-secret",
			GITHUB_PAT_TOKEN: "github-secret",
		});

		expect(environment).toMatchObject({
			PATH: "/bin",
			GOOGLE_VERTEX_GOOGLE_SEARCH: "0",
			GOLLUM_USE_DOCKER: "0",
			OS_KERNEL_USE_DOCKER: "0",
		});
		expect(environment.SERPER_API_KEY).toBeUndefined();
		expect(environment.TAVILY_API_KEY).toBeUndefined();
		expect(environment.GITHUB_PAT_TOKEN).toBeUndefined();
	});

	test("flags model-authored network and package-fetch commands without flagging local verification", () => {
		expect(
			specBenchNetworkPolicyViolations([
				"python3 -m pytest -vv test_specbench_contract.py",
				"curl https://example.invalid/reference",
				"git fetch origin",
				"requests.get('https://example.invalid')",
				"uv pip install some-package",
				"rg 'git clone' TASK.md",
			]),
		).toEqual([
			"curl https://example.invalid/reference",
			"git fetch origin",
			"requests.get('https://example.invalid')",
			"uv pip install some-package",
		]);
	});

	test("keeps protocol diagnostics separate from source-inspection text", () => {
		expect(
			specBenchNetworkPolicyViolations([
				"rg 'curl https://example.invalid' .",
				"python3 -c \"print('git fetch origin')\"",
				"  websearch latest compiler docs",
			]),
		).toEqual(["  websearch latest compiler docs"]);
	});

	test("records structured web-search tool calls without treating local tools as network use", () => {
		expect(
			specBenchNetworkToolPolicyViolations([
				{
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", toolName: "mcp__websearch__search_query", arguments: { query: "docs" } },
							{ type: "toolCall", toolName: "bash", arguments: { command: "rg search_query TASK.md" } },
						],
					},
				},
			]),
		).toEqual(["tool:mcp__websearch__search_query"]);
	});

	test("classifies provider-only assistant failures as retryable agent infrastructure", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-provider-errors-"));
		try {
			const sessionPath = join(root, "session.jsonl");
			writeFileSync(
				sessionPath,
				[
					{ type: "session", id: "session-1" },
					{ type: "message", message: { role: "user", content: [{ type: "text", text: "implement" }] } },
					...Array.from({ length: 4 }, (_, index) => ({
						type: "message",
						id: `error-${index}`,
						message: {
							role: "assistant",
							stopReason: "error",
							errorMessage: "fetch failed",
							usage: { input: 0, output: 0, totalTokens: 0 },
							content: [],
						},
					})),
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n"),
			);

			expect(specBenchAgentInfrastructureErrorFromSessionJsonl([sessionPath])).toBe(
				"agent provider/runtime failed before any successful assistant response (4 error responses): fetch failed",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not relabel a genuine model attempt, turn limit, or bare nonzero-exit session as infrastructure", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-provider-negative-"));
		try {
			const attemptedPath = join(root, "attempted.jsonl");
			writeFileSync(
				attemptedPath,
				[
					{
						type: "message",
						message: {
							role: "assistant",
							stopReason: "toolUse",
							usage: { output: 12 },
							content: [{ type: "toolCall", name: "ipython", arguments: { code: "print(1)" } }],
						},
					},
					{
						type: "message",
						message: { role: "assistant", stopReason: "error", errorMessage: "fetch failed", content: [] },
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n"),
			);
			const turnLimitPath = join(root, "turn-limit.jsonl");
			writeFileSync(
				turnLimitPath,
				`${JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						stopReason: "length",
						usage: { output: 1 },
						content: [{ type: "text", text: "partial implementation" }],
					},
				})}\n`,
			);
			const bareExitPath = join(root, "bare-exit.jsonl");
			writeFileSync(
				bareExitPath,
				`${JSON.stringify({ type: "message", message: { role: "user", content: [] } })}\n`,
			);

			expect(specBenchAgentInfrastructureErrorFromSessionJsonl([attemptedPath])).toBeUndefined();
			expect(specBenchAgentInfrastructureErrorFromSessionJsonl([turnLimitPath])).toBeUndefined();
			expect(specBenchAgentInfrastructureErrorFromSessionJsonl([bareExitPath])).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not pass private-home or current-run ancestors to the verification broker", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-hidden-"));
		try {
			const fakeHome = join(root, "home");
			const cacheRoot = join(fakeHome, ".cache", "prime-agent", "specbench");
			const runsRoot = join(cacheRoot, "campaign", "runs");
			const workspace = join(runsRoot, "case", "workspace");
			const outsideHome = join(root, "official-specbench");
			for (const path of [workspace, outsideHome]) mkdirSync(path, { recursive: true });
			expect(specBenchVerificationHiddenPaths(workspace, [cacheRoot, runsRoot, outsideHome], fakeHome)).toEqual([
				outsideHome,
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("binds behavior-changing AI package edits into Prime workspace provenance", () => {
		const repository = mkdtempSync(join(tmpdir(), "prime-specbench-provenance-"));
		try {
			const provider = join(repository, "packages", "ai", "provider.ts");
			mkdirSync(join(repository, "packages", "ai"), { recursive: true });
			writeFileSync(provider, "export const search = true;\n");
			for (const args of [
				["init", "-q"],
				["config", "user.email", "specbench@localhost"],
				["config", "user.name", "SpecBench"],
				["add", "."],
				["commit", "-qm", "fixture"],
			]) {
				const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
				expect(result.status, result.stderr).toBe(0);
			}
			const before = primeImplementationProvenance(repository);
			writeFileSync(provider, "export const search = false;\n");
			const after = primeImplementationProvenance(repository);
			expect(after.primeRevision).toBe(before.primeRevision);
			expect(after.primeWorkspaceDigest).not.toBe(before.primeWorkspaceDigest);
		} finally {
			rmSync(repository, { recursive: true, force: true });
		}
	});

	test("strips provider credentials from trusted grading while preserving the frozen workspace locator", () => {
		const environment = specBenchGradeEnvironment(
			{
				PATH: "/bin",
				GOOGLE_APPLICATION_CREDENTIALS: "/secret/vertex.json",
				VERTEX_API_KEY: "vertex-secret",
				AWS_ACCESS_KEY_ID: "aws-secret",
				CUSTOM_PASSWORD: "password",
			},
			"/isolated/workspace",
		);

		expect(environment).toMatchObject({
			PATH: "/bin",
			PYTHONPATH: "/isolated/workspace",
			PYTHONDONTWRITEBYTECODE: "1",
			GOLLUM_USE_DOCKER: "0",
			OS_KERNEL_USE_DOCKER: "0",
		});
		expect(environment.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
		expect(environment.VERTEX_API_KEY).toBeUndefined();
		expect(environment.AWS_ACCESS_KEY_ID).toBeUndefined();
		expect(environment.CUSTOM_PASSWORD).toBeUndefined();
	});

	test("masks prior output, cache, config, and hidden-suite roots before exposing only the active run", () => {
		const args = buildSpecBenchSandboxArgs(
			"/agent",
			["--print"],
			"/output/current",
			"/output",
			"/output/current/workspace",
			"/official-specbench",
			"/config",
			[],
		);
		const mountIndex = (kind: string, path: string): number =>
			args.findIndex((value, index) => value === kind && args[index + 1] === path);

		expect(mountIndex("--tmpfs", "/official-specbench")).toBeGreaterThan(-1);
		expect(mountIndex("--tmpfs", join(homedir(), ".cache", "prime-agent", "specbench"))).toBeGreaterThan(-1);
		expect(mountIndex("--tmpfs", "/output")).toBeGreaterThan(-1);
		expect(mountIndex("--tmpfs", "/config")).toBeGreaterThan(-1);
		expect(mountIndex("--dir", "/output/current")).toBeGreaterThan(mountIndex("--tmpfs", "/output"));
		expect(mountIndex("--bind", "/output/current/workspace")).toBeGreaterThan(mountIndex("--tmpfs", "/output"));
		expect(mountIndex("--bind", "/output/current/runtime")).toBeGreaterThan(mountIndex("--tmpfs", "/output"));
		expect(mountIndex("--bind", "/output/current")).toBe(-1);
	});

	test("masks runtime sockets but rebinds only the two authenticated broker sockets", () => {
		const args = buildSpecBenchSandboxArgs(
			"/agent",
			[],
			"/output/current",
			"/output",
			"/output/current/workspace",
			"/official-specbench",
			"/config",
			[],
			["/run/user/1000/prime-probe.sock", "/run/user/1000/prime-verification.sock"],
		);

		expect(args).toContain("/run");
		expect(args).toContain("/run/user/1000");
		expect(args).toContain("/run/user/1000/prime-probe.sock");
		expect(args).toContain("/run/user/1000/prime-verification.sock");
		expect(args).not.toContain("/run/docker.sock");
		const runMaskIndex = args.findIndex((value, index) => value === "--tmpfs" && args[index + 1] === "/run");
		const resolverArguments = buildSpecBenchResolverSandboxArgs();
		expect(args.slice(runMaskIndex + 2, runMaskIndex + 2 + resolverArguments.length)).toEqual(resolverArguments);
	});

	test("restores only a regular resolver target beneath the masked runtime root", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-resolver-"));
		try {
			const resolvConf = join(root, "etc", "resolv.conf");
			const runtimeRoot = join(root, "run");
			const resolverTarget = join(runtimeRoot, "systemd", "resolve", "stub-resolv.conf");
			mkdirSync(dirname(resolvConf), { recursive: true });
			mkdirSync(dirname(resolverTarget), { recursive: true });
			writeFileSync(resolverTarget, "nameserver 127.0.0.53\n");
			symlinkSync("../run/systemd/resolve/stub-resolv.conf", resolvConf);

			expect(buildSpecBenchResolverSandboxArgs(resolvConf, runtimeRoot)).toEqual([
				"--dir",
				join(runtimeRoot, "systemd"),
				"--dir",
				join(runtimeRoot, "systemd", "resolve"),
				"--ro-bind",
				resolverTarget,
				resolverTarget,
			]);

			rmSync(resolvConf);
			const outsideTarget = join(root, "outside-resolv.conf");
			writeFileSync(outsideTarget, "nameserver 203.0.113.1\n");
			symlinkSync("../outside-resolv.conf", resolvConf);
			expect(buildSpecBenchResolverSandboxArgs(resolvConf, runtimeRoot)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("closes an acquired verification broker when probe startup fails", async () => {
		let verificationClosed = 0;
		await expect(
			withSpecBenchBrokerLifecycle(
				async () => ({
					close: async () => {
						verificationClosed += 1;
					},
				}),
				async () => {
					throw new Error("probe startup failed");
				},
				async () => "unreachable",
			),
		).rejects.toThrow("probe startup failed");
		expect(verificationClosed).toBe(1);
	});

	test("verifies every file named by the frozen native-toolchain manifest", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-toolchain-"));
		const executable = join(root, "tool");
		const manifest = join(root, "files.manifest.sha256");
		writeFileSync(executable, "frozen-toolchain\n");
		const digest = createHash("sha256").update(readFileSync(executable)).digest("hex");
		writeFileSync(manifest, `${digest}  ${executable}\n`);

		const provenance = specBenchToolchainProvenance({
			PATH: "/usr/bin",
			SPECBENCH_TOOLCHAIN_MANIFEST: manifest,
		});
		expect(provenance).toMatchObject({
			toolchainManifestPath: manifest,
			toolchainManifestVerified: true,
		});

		writeFileSync(executable, "mutated-toolchain\n");
		expect(() => specBenchToolchainProvenance({ PATH: "/usr/bin", SPECBENCH_TOOLCHAIN_MANIFEST: manifest })).toThrow(
			"manifest verification failed",
		);
	});

	test("stages only the selected frozen suite and allowlisted support modules", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-grade-control-"));
		const testsRoot = join(root, "canonical", "tests");
		const publicRoot = join(testsRoot, "public");
		mkdirSync(join(publicRoot, "__pycache__"), { recursive: true });
		mkdirSync(join(testsRoot, "private"));
		mkdirSync(join(root, "canonical", "reference"));
		writeFileSync(join(publicRoot, "test_public.py"), "def test_public(): assert True\n");
		writeFileSync(join(publicRoot, "__pycache__", "test_public.pyc"), "untrusted-cache");
		writeFileSync(join(testsRoot, "private", "test_private.py"), "SECRET = True\n");
		writeFileSync(join(testsRoot, "slt_runner.py"), "def run(): return True\n");
		writeFileSync(join(root, "canonical", "reference", "solution.py"), "SECRET = True\n");
		const workspace = join(root, "workspace");
		const controlRoot = join(root, "control");
		mkdirSync(workspace);

		const control = stageSpecBenchGradeControl({
			taskId: "database_engine",
			canonicalTestDir: publicRoot,
			controlRoot,
			workspace,
		});

		expect(existsSync(join(control.testDir, "test_public.py"))).toBe(true);
		expect(existsSync(join(control.testDir, "__pycache__"))).toBe(false);
		expect(existsSync(join(control.importRoot, "slt_runner.py"))).toBe(true);
		expect(existsSync(join(control.importRoot, "private"))).toBe(false);
		expect(
			existsSync(
				join(controlRoot, "python-root", "benchmarks", "spec_bench", "tasks", "database_engine", "reference"),
			),
		).toBe(false);
	});

	test("runs trusted grading with isolated imports, credentials, home, repository, and network", () => {
		const grader = ensureSpecBenchGraderPython();
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-grade-isolation-"));
		const workspace = join(root, "workspace");
		const controlRoot = join(root, "control");
		const testDir = join(controlRoot, "tests", "public");
		const evidenceRoot = join(root, "evidence");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(testDir, { recursive: true });
		mkdirSync(evidenceRoot, { recursive: true });
		writeFileSync(join(workspace, "solution.py"), "VALUE = 42\n");
		writeFileSync(join(workspace, "pytest.py"), "raise RuntimeError('candidate pytest shadow loaded')\n");
		writeFileSync(join(workspace, "sitecustomize.py"), "raise RuntimeError('candidate startup hook loaded')\n");
		writeFileSync(
			join(testDir, "test_isolation.py"),
			`import os
import pathlib
import socket
import pytest
from solution import VALUE

def test_isolation():
    assert VALUE == 42
    assert "VERTEX_API_KEY" not in os.environ
    assert not pathlib.Path(${JSON.stringify(join(homedir(), ".codex"))}).exists()
    assert not pathlib.Path(${JSON.stringify(join(homedir(), "deep_learning", "avo-test", "prime-agent", ".git"))}).exists()
    with pytest.raises(OSError):
        socket.create_connection(("8.8.8.8", 53), timeout=0.1)
`,
		);
		const junitPath = join(evidenceRoot, "pytest-junit.xml");
		const command = buildSpecBenchGradeArgs({
			graderPython: grader.path,
			workspace,
			controlPythonRoot: controlRoot,
			controlImportRoot: join(controlRoot, "tests"),
			testDir,
			perTestTimeoutSeconds: 30,
			junitPath,
		});
		const sandbox = buildSpecBenchGradeSandboxArgs(
			command,
			workspace,
			evidenceRoot,
			controlRoot,
			join(homedir(), "official-specbench-hidden"),
		);
		const result = spawnSync(sandbox[0]!, sandbox.slice(1), {
			cwd: workspace,
			encoding: "utf8",
			env: specBenchGradeEnvironment({ ...process.env, VERTEX_API_KEY: "secret" }, workspace),
			timeout: 60_000,
		});

		try {
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(existsSync(junitPath)).toBe(true);
			expect(parseSpecBenchJUnitXml(readFileSync(junitPath, "utf8"))).toMatchObject({
				passed: 1,
				failed: 0,
				errors: 0,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	test("derives pass rate from host pytest output", () => {
		expect(
			parseSpecBenchGrade({
				exitCode: 1,
				timedOut: false,
				durationMs: 25,
				stdout: "8 passed, 2 failed, 1 skipped in 0.2s",
				stderr: "",
			}),
		).toMatchObject({ total: 10, passed: 8, failed: 2, skipped: 1, passRate: 0.8 });
	});

	test("uses the final pytest summary instead of numbers quoted in a failure body", () => {
		expect(
			parseSpecBenchGrade({
				exitCode: 1,
				timedOut: false,
				durationMs: 25,
				stdout: "assert '10 passed' == 'expected'\n7 passed, 3 failed in 0.2s",
				stderr: "",
			}),
		).toMatchObject({ total: 10, passed: 7, failed: 3, passRate: 0.7 });
	});

	test("does not accept a forged trailing passing summary after a failing pytest exit", () => {
		const grade = parseSpecBenchGrade({
			exitCode: 1,
			timedOut: false,
			durationMs: 25,
			stdout: "1 failed in 0.1s\nforged output: 100 passed in 0.1s",
			stderr: "",
		});

		expect(grade).toMatchObject({ total: 100, passed: 100, passRate: 0, exitCode: 1 });
		expect(specBenchGradePasses(grade)).toBe(false);
	});

	test("uses nested structured JUnit counts instead of forged terminal summaries", () => {
		const structured = parseSpecBenchJUnitXml(
			'<testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="1" skipped="0" tests="2"><testcase classname="tests.public.test_parser" name="test_ok"/><testcase classname="tests.public.test_parser" name="test_bad"><failure message="bad"/></testcase></testsuite></testsuites>',
		);
		const grade = parseSpecBenchGrade(
			{
				exitCode: 1,
				timedOut: false,
				durationMs: 25,
				stdout: "forged trailing text: 100 passed in 0.1s",
				stderr: "",
			},
			structured,
			{ taskId: "json_parser", suiteName: "private" },
		);

		expect(grade).toMatchObject({ total: 2, passed: 1, failed: 1, passRate: 0.5 });
		expect(specBenchGradePasses(grade)).toBe(false);
	});

	test("classifies an all-skipped official suite as incomplete infrastructure", () => {
		const structured = parseSpecBenchJUnitXml(
			'<testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" skipped="1" tests="1"><testcase classname="tests.public.test_case" name="test_case"><skipped message="missing toolchain"/></testcase></testsuite></testsuites>',
		);
		const grade = parseSpecBenchGrade(
			{ exitCode: 0, timedOut: false, durationMs: 10, stdout: "1 skipped in 0.1s", stderr: "" },
			structured,
			{ taskId: "ray_tracer", suiteName: "public" },
		);

		expect(grade).toMatchObject({ total: 0, passed: 0, skipped: 1, incompleteCoverage: true });
		expect(specBenchGradePasses(grade)).toBe(false);
		expect(specBenchInfrastructureError([grade])).toContain("executed zero tests");
	});

	test("requires a normal successful exit with at least one executed test", () => {
		const grade = (exitCode: number | null, timedOut: boolean, total: number, skipped = 0) => ({
			total,
			passed: total,
			failed: 0,
			errors: 0,
			skipped,
			skippedReasons: skipped > 0 ? ["missing dependency"] : [],
			skippedNodeIds: skipped > 0 ? ["unattributed"] : [],
			unapprovedSkipReasons: skipped > 0 ? ["missing dependency"] : [],
			incompleteCoverage: skipped > 0,
			passRate: total === 0 ? 0 : 1,
			exitCode,
			timedOut,
			durationMs: 1,
		});

		expect(specBenchGradePasses(grade(0, false, 1))).toBe(true);
		expect(specBenchGradePasses(grade(1, false, 1))).toBe(false);
		expect(specBenchGradePasses(grade(0, true, 1))).toBe(false);
		expect(specBenchGradePasses(grade(0, false, 0))).toBe(false);
		expect(specBenchGradePasses(grade(0, false, 1, 1))).toBe(false);
	});

	test("scores a candidate-induced official-suite timeout as zero instead of retryable infrastructure", () => {
		const timedOut = parseSpecBenchGrade({
			exitCode: null,
			timedOut: true,
			durationMs: 900_000,
			stdout: "",
			stderr: "",
		});

		expect(timedOut).toMatchObject({ total: 0, passRate: 0, timedOut: true });
		expect(specBenchGradePasses(timedOut)).toBe(false);
		expect(specBenchInfrastructureError([timedOut])).toBeUndefined();
	});

	test("does not accept a hidden suite that skipped an unavailable dependency", () => {
		const privateGrade = parseSpecBenchGrade({
			exitCode: 0,
			timedOut: false,
			durationMs: 25,
			stdout:
				"SKIPPED [1] tests/conftest.py:33: Oracle requires Docker (GoLLUM reference is built in the image)\n9 passed, 1 skipped in 0.2s",
			stderr: "",
		});

		expect(privateGrade).toMatchObject({
			passed: 9,
			skipped: 1,
			incompleteCoverage: true,
			passRate: 1,
		});
		expect(specBenchHiddenSuitesPass(privateGrade)).toBe(false);
		expect(specBenchInfrastructureError([privateGrade])).toContain("unapproved");
	});

	test("reports but permits the official benchmark's reviewed semantic and oracle skips", () => {
		for (const item of [
			{
				taskId: "elf_linker",
				nodeId: "private.test_private::test_error_weak_vs_global_symbol",
				reason: "Linker does not support weak symbols",
			},
		]) {
			const [classname, name] = item.nodeId.split("::");
			const xml = `<testsuites name="pytest tests"><testsuite errors="0" failures="0" skipped="1" tests="10"><testcase classname="${classname}" name="${name}"><skipped message="${item.reason}" /></testcase></testsuite></testsuites>`;
			const privateGrade = parseSpecBenchGrade(
				{
					exitCode: 0,
					timedOut: false,
					durationMs: 25,
					stdout: "9 passed, 1 skipped in 0.2s",
					stderr: "",
				},
				parseSpecBenchJUnitXml(xml),
				{ taskId: item.taskId, suiteName: "private" },
			);

			expect(privateGrade).toMatchObject({ incompleteCoverage: true, unapprovedSkipReasons: [] });
			expect(specBenchHiddenSuitesPass(privateGrade)).toBe(true);
			expect(specBenchInfrastructureError([privateGrade])).toBeUndefined();
		}
	});

	test("rejects c_compiler skips that do not match the exact pinned private node set", () => {
		const skippedCases = Array.from(
			{ length: 78 },
			(_, index) =>
				`<testcase classname="private.test_private_torture" name="test_torture_${index}"><skipped message="GCC oracle cannot compile this test" /></testcase>`,
		).join("");
		const xml = `<testsuites name="pytest tests"><testsuite errors="0" failures="0" skipped="78" tests="79"><testcase classname="private.test_private" name="test_executes"/>${skippedCases}</testsuite></testsuites>`;
		const privateGrade = parseSpecBenchGrade(
			{ exitCode: 0, timedOut: false, durationMs: 25, stdout: "1 passed, 78 skipped in 0.2s", stderr: "" },
			parseSpecBenchJUnitXml(xml),
			{ taskId: "c_compiler", suiteName: "private" },
		);

		expect(privateGrade.unapprovedSkipReasons).not.toEqual([]);
		expect(specBenchGradePasses(privateGrade)).toBe(false);

		const publicGrade = parseSpecBenchGrade(
			{ exitCode: 0, timedOut: false, durationMs: 25, stdout: "1 skipped in 0.2s", stderr: "" },
			parseSpecBenchJUnitXml(
				'<testsuites><testsuite errors="0" failures="0" skipped="1" tests="1"><testcase classname="public.test_public" name="test_case"><skipped message="GCC oracle cannot compile this test" /></testcase></testsuite></testsuites>',
			),
			{ taskId: "c_compiler", suiteName: "public" },
		);
		expect(publicGrade.unapprovedSkipReasons).not.toEqual([]);
	});

	test("allows only a frozen c_compiler skip subset when the candidate itself fails", () => {
		const skipped =
			'<testcase classname="private.test_private_torture" name="test_torture_20000314_2"><skipped message="GCC oracle cannot compile this test" /></testcase>';
		const failing = parseSpecBenchGrade(
			{ exitCode: 1, timedOut: false, durationMs: 25, stdout: "1 failed, 1 skipped in 0.2s", stderr: "" },
			parseSpecBenchJUnitXml(
				`<testsuites><testsuite errors="0" failures="1" skipped="1" tests="2">${skipped}</testsuite></testsuites>`,
			),
			{ taskId: "c_compiler", suiteName: "private" },
		);
		expect(failing.unapprovedSkipReasons).toEqual([]);
		expect(specBenchInfrastructureError([failing])).toBeUndefined();

		const otherwisePassing = parseSpecBenchGrade(
			{ exitCode: 0, timedOut: false, durationMs: 25, stdout: "1 passed, 1 skipped in 0.2s", stderr: "" },
			parseSpecBenchJUnitXml(
				`<testsuites><testsuite errors="0" failures="0" skipped="1" tests="2"><testcase classname="private.test_private" name="test_pass"/>${skipped}</testsuite></testsuites>`,
			),
			{ taskId: "c_compiler", suiteName: "private" },
		);
		expect(otherwisePassing.unapprovedSkipReasons).not.toEqual([]);
	});

	test("requires every available hidden suite for spec compliance", () => {
		const grade = (passRate: number): ReturnType<typeof parseSpecBenchGrade> => ({
			total: 10,
			passed: Math.round(passRate * 10),
			failed: Math.round((1 - passRate) * 10),
			errors: 0,
			skipped: 0,
			skippedReasons: [],
			skippedNodeIds: [],
			unapprovedSkipReasons: [],
			incompleteCoverage: false,
			passRate,
			exitCode: passRate === 1 ? 0 : 1,
			timedOut: false,
			durationMs: 1,
		});
		expect(specBenchHiddenSuitesPass(grade(1), grade(0.9))).toBe(false);
		expect(specBenchHiddenSuitesPass(grade(1), grade(1))).toBe(true);
		expect(specBenchHiddenSuitesPass(grade(1))).toBe(true);
	});

	test("counts a failed identity-private suite as false completion", () => {
		const grade = (pass: boolean): ReturnType<typeof parseSpecBenchGrade> => ({
			total: 10,
			passed: pass ? 10 : 9,
			failed: pass ? 0 : 1,
			errors: 0,
			skipped: 0,
			skippedReasons: [],
			skippedNodeIds: [],
			unapprovedSkipReasons: [],
			incompleteCoverage: false,
			passRate: pass ? 1 : 0.9,
			exitCode: pass ? 0 : 1,
			timedOut: false,
			durationMs: 1,
		});

		expect(specBenchFalseCompletion(1, grade(true), grade(false))).toBe(true);
		expect(specBenchFalseCompletion(1, grade(true), grade(true))).toBe(false);
		expect(specBenchFalseCompletion(0, grade(true), grade(false))).toBe(false);
	});

	test("reports marginal held-out value and cost for each condition", () => {
		const result = (
			conditionId: SpecBenchResult["conditionId"],
			heldOut: number,
			costUsd: number,
			repetition: number,
		): SpecBenchResult => {
			const obligationsEnabled = conditionId !== "no-obligations";
			return {
				specbenchRevision: "a".repeat(40),
				conditionId,
				disabledFeatures: conditionId === "full" ? [] : ["obligations"],
				repetition,
				orderIndex: 1,
				experimentSeed: "test",
				runConfigurationDigest: "b".repeat(64),
				primeRevision: "c".repeat(40),
				primeWorkspaceDigest: "d".repeat(64),
				agentExecutableDigest: "a".repeat(64),
				configBehaviorDigest: "e".repeat(64),
				specbenchCatalogDigest: "1".repeat(64),
				toolchainEnvironment: {
					PATH: "/usr/bin",
					GOROOT: null,
					COMPILER_PATH: null,
					LD_LIBRARY_PATH: null,
				},
				toolchainEnvironmentDigest: "2".repeat(64),
				graderPythonVersion: "3.14 pytest=9.1.1 pytest-timeout=installed",
				graderPythonDigest: "3".repeat(64),
				diskWatchdogMinimumBytes: 1,
				diskWatchdogMaximumCaseBytes: 1_000_000,
				visibleFixtureDigest: "f".repeat(64),
				taskId: "json_parser",
				displayName: "JSON Parser",
				language: "python",
				public: {
					total: 10,
					passed: 10,
					failed: 0,
					errors: 0,
					skipped: 0,
					skippedReasons: [],
					skippedNodeIds: [],
					unapprovedSkipReasons: [],
					incompleteCoverage: false,
					passRate: 1,
					exitCode: 0,
					timedOut: false,
					durationMs: 1,
				},
				private: {
					total: 10,
					passed: Math.round(heldOut * 10),
					failed: Math.round((1 - heldOut) * 10),
					errors: 0,
					skipped: 0,
					skippedReasons: [],
					skippedNodeIds: [],
					unapprovedSkipReasons: [],
					incompleteCoverage: false,
					passRate: heldOut,
					exitCode: heldOut === 1 ? 0 : 1,
					timedOut: false,
					durationMs: 1,
				},
				rewardHackingGap: 1 - heldOut,
				specCompliant: heldOut === 1,
				agentExitCode: 0,
				agentTimedOut: false,
				protectedChanges: [],
				durationMs: 1_000,
				falseCompletion: heldOut < 1,
				trace: {
					completedRuns: 1,
					assistantTurns: 2,
					modelCalls: 2,
					toolCalls: 3,
					candidates: 1,
					cycles: 1,
					acceptedCycles: 1,
					revisedCycles: 0,
					requiredCodingPivots: 0,
					materialCodingPivots: 0,
					pendingCodingPivots: 0,
					obligations: obligationsEnabled ? 1 : 0,
					coveredObligations: obligationsEnabled ? 1 : 0,
					obligationCoverageEvaluationCount: obligationsEnabled ? 1 : 0,
					maxObligationsPerCoverageEvaluation: obligationsEnabled ? 1 : 0,
					acceptedCandidateCoveredObligations: obligationsEnabled ? 1 : 0,
					acceptedCandidateObligationEvidenceReceiptCount: obligationsEnabled ? 1 : 0,
					acceptedCandidateMeanObligationsPerEvidenceReceipt: obligationsEnabled ? 1 : 0,
					acceptedCandidateMaxObligationsPerEvidenceReceipt: obligationsEnabled ? 1 : 0,
					acceptedCandidateEvidenceDiversity: obligationsEnabled ? 1 : 0,
					acceptedCandidateMaxEvidenceConcentration: obligationsEnabled ? 1 : 0,
					criticalAssumptions: 0,
					resolvedCriticalAssumptions: 0,
					watchdogInterventions: 0,
					watchdogWatches: 0,
					supervisorReviews: 1,
					supervisorProgressingReviews: 1,
					supervisorWatchReviews: 0,
					supervisorInterventions: 0,
					adversarialProbeEvaluations: 1,
					adversarialProbePasses: 1,
					adversarialProbeRevisions: 0,
					adversarialProbeInconclusive: 0,
					adversarialProbeCases: 6,
					adversarialProbePassedCases: 6,
					adversarialProbeFailedCases: 0,
					adversarialProbeEnvironmentUnsupported: 0,
					adversarialProbeRequiredContrastDimensions: 2,
					adversarialProbeContrastedInputDimensions: 2,
					adversarialProbeCallables: ["evaluate"],
					adversarialProbeRequiredCallables: ["evaluate"],
					toolProbationActivations: 0,
					toolProbationBlockedCalls: 0,
					completionAttemptCount: 1,
					failedCompletionAttemptCount: 0,
					successfulCompletionAttemptCount: 1,
					inconclusiveCompletionAttemptCount: 0,
					firstCompletionAttemptPassed: true,
					completionRepairTurns: 0,
					inputTokensAfterFirstCompletionAttempt: 0,
					cacheReadTokensAfterFirstCompletionAttempt: 0,
					cacheWriteTokensAfterFirstCompletionAttempt: 0,
					outputTokensAfterFirstCompletionAttempt: 0,
					tokensAfterFirstCompletionAttempt: 0,
					costUsdAfterFirstCompletionAttempt: 0,
					completionRepairAmplification: 0,
					uniqueCompletionBlockerCount: 0,
					repeatedCompletionBlockerCount: 0,
					sameBlockerConsecutiveRepeatCount: 0,
					completionAttempts: [],
					completionBlockers: [],
					inputTokens: 80,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					outputTokens: 20,
					totalTokens: 100,
					costUsd,
					tokenUsageByStage: {
						setup: {
							modelCalls: 1,
							inputTokens: 40,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 10,
							totalTokens: 50,
							costUsd: costUsd / 2,
						},
						implementation: {
							modelCalls: 1,
							inputTokens: 40,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 10,
							totalTokens: 50,
							costUsd: costUsd / 2,
						},
						candidate_evaluation: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						obligation_coverage: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						completion: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						completion_repair: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						post_ready_work: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						memory: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
						other: {
							modelCalls: 0,
							inputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							costUsd: 0,
						},
					},
					commands: [],
				},
				traceArtifactDigest: "4".repeat(64),
				networkPolicyViolations: [],
				protocolValid: true,
				workspacePath: "/tmp/workspace",
				transcriptPath: "/tmp/transcript",
				diskAvailableBytesBefore: 10_000_000,
				diskAvailableBytesAfter: 9_000_000,
			};
		};
		const infrastructureInvalid = result("no-obligations", 1, 99, 3);
		infrastructureInvalid.infrastructureError = "toolchain unavailable";
		const protocolInvalid = result("no-obligations", 1, 77, 4);
		protocolInvalid.protocolValid = false;
		protocolInvalid.protocolInvalidReason = "benchmark network policy was violated";
		protocolInvalid.networkPolicyViolations = ["curl https://example.invalid"];
		protocolInvalid.specCompliant = false;
		const summaries = aggregateSpecBenchConditions([
			result("full", 0.9, 1, 1),
			result("full", 0.9, 1, 2),
			result("no-obligations", 0.7, 0.5, 1),
			result("no-obligations", 0.7, 0.5, 2),
			infrastructureInvalid,
			protocolInvalid,
		]);
		expect(summaries[1]).toMatchObject({
			conditionId: "no-obligations",
			runCount: 2,
			attemptedRunCount: 4,
			infrastructureErrorCount: 1,
			protocolInvalidCount: 1,
			pairedRunCount: 2,
			deltaCostVsFull: -0.5,
			meanCostUsd: 0.5,
		});
		expect(summaries[1]?.deltaHeldOutVsFull).toBeCloseTo(-0.2);
		expect(summaries[1]?.hiddenBenefitPerExtraDollar).toBeCloseTo(0.4);
		expect(summaries[0]).toMatchObject({
			meanIdPrivatePassRate: null,
			meanCandidates: 1,
			meanCycles: 1,
			meanAcceptedCycles: 1,
			meanRevisedCycles: 0,
			meanRequiredCodingPivots: 0,
			meanMaterialCodingPivots: 0,
			meanPendingCodingPivots: 0,
			meanToolProbationActivations: 0,
			meanToolProbationBlockedCalls: 0,
			meanCriticalAssumptions: 0,
			meanResolvedCriticalAssumptions: 0,
			meanSupervisorReviews: 1,
			meanSupervisorProgressingReviews: 1,
			meanAdversarialProbeEvaluations: 1,
			meanAdversarialProbePasses: 1,
			meanAdversarialProbeCases: 6,
			meanAdversarialProbePassedCases: 6,
			meanAdversarialProbeRequiredContrastDimensions: 2,
			meanAdversarialProbeContrastedInputDimensions: 2,
			meanObligations: 1,
			meanAcceptedCandidateObligationEvidenceReceipts: 1,
			meanAcceptedCandidateObligationsPerEvidenceReceipt: 1,
			meanAcceptedCandidateMaxObligationsPerEvidenceReceipt: 1,
			meanAcceptedCandidateEvidenceDiversity: 1,
			meanAcceptedCandidateMaxEvidenceConcentration: 1,
			meanInputTokensPerModelCall: 40,
			firstCompletionAttemptReadinessRate: 1,
			meanCompletionAttempts: 1,
		});
		expect(summaries[0]?.meanTokenUsageByStage).toMatchObject({ setup: 50, implementation: 50 });
		expect(summaries[0]?.meanModelUsageByStage.implementation).toMatchObject({
			modelCalls: 1,
			inputTokens: 40,
			outputTokens: 10,
			totalTokens: 50,
		});
	});
});
