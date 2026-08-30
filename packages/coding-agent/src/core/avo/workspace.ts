import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { classifyAvoHostEvaluationCommand } from "./evaluator.js";
import {
	type AvoPythonProbeBundle,
	createAvoPythonProbeBundle,
	inspectAvoPythonPublicCallableSources,
} from "./probe.js";
import type { AvoVerificationBaseline, AvoVerificationHarnessEntry, AvoVerificationHarnessManifest } from "./types.js";
import {
	sanitizeAvoVerificationEnvironment,
	unboundAvoVerificationEnvironmentKeys,
} from "./verification-environment.js";

const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 20_000;
const MAX_BASELINE_TEST_BYTES = 128 * 1024 * 1024;
const TREE_EXCLUDES = new Set([
	".git",
	".cache",
	".next",
	".venv",
	"__pycache__",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"target",
	"venv",
]);

export interface AvoWorkspaceSnapshot {
	root: string;
	digest: string;
	mode: "git" | "tree";
	head: string;
	changedFileCount: number;
	totalBytes: number;
	changedPaths: string[];
	pathDigests: Record<string, string>;
}

function git(cwd: string, args: readonly string[]): Buffer | undefined {
	const result = spawnSync("git", [...args], {
		cwd,
		encoding: "buffer",
		maxBuffer: MAX_SNAPSHOT_BYTES,
		stdio: ["ignore", "pipe", "ignore"],
	});
	return result.status === 0 && !result.error ? result.stdout : undefined;
}

function hashPath(hash: ReturnType<typeof createHash>, root: string, relativePath: string): number {
	const absolutePath = resolve(root, relativePath);
	if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
		throw new Error(`workspace path escapes its root: ${relativePath}`);
	}
	const metadata = lstatSync(absolutePath);
	hash.update(`\0${relativePath}\0${metadata.mode}\0${metadata.size}\0`);
	if (metadata.isSymbolicLink()) {
		const target = readlinkSync(absolutePath);
		hash.update(target);
		return Buffer.byteLength(target);
	}
	if (!metadata.isFile()) return 0;
	hash.update(readFileSync(absolutePath));
	return statSync(absolutePath).size;
}

function pathStateDigest(root: string, relativePath: string): string {
	const absolutePath = resolve(root, relativePath);
	if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
		throw new Error(`workspace path escapes its root: ${relativePath}`);
	}
	try {
		const metadata = lstatSync(absolutePath);
		const hash = createHash("sha256");
		hash.update(`prime-avo-path-v1\0${relativePath}\0${metadata.mode}\0${metadata.size}\0`);
		if (metadata.isSymbolicLink()) hash.update(readlinkSync(absolutePath));
		else if (metadata.isFile()) hash.update(readFileSync(absolutePath));
		else hash.update("non-file");
		return hash.digest("hex");
	} catch {
		return createHash("sha256").update(`prime-avo-path-v1\0${relativePath}\0missing`).digest("hex");
	}
}

function excludedPathspecs(root: string, excludedRoots: readonly string[]): string[] {
	return excludedRoots.flatMap((excludedRoot) => {
		const absolute = resolve(excludedRoot);
		if (absolute === root || !absolute.startsWith(`${root}${sep}`)) return [];
		const path = relative(root, absolute).replaceAll(sep, "/");
		return [`:(exclude)${path}`, `:(exclude)${path}/**`];
	});
}

function gitSnapshot(cwd: string, excludedRoots: readonly string[]): AvoWorkspaceSnapshot | undefined {
	const rootOutput = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!rootOutput) return undefined;
	const root = rootOutput.toString("utf8").trim();
	if (!root) return undefined;
	const headOutput = git(root, ["rev-parse", "--verify", "HEAD"]);
	const head = headOutput?.toString("utf8").trim() || "UNBORN";
	const pathspecs = ["--", ".", ...excludedPathspecs(root, excludedRoots)];
	const diff =
		head === "UNBORN"
			? Buffer.concat([
					git(root, ["diff", "--binary", "--no-ext-diff", "--cached", ...pathspecs]) ?? Buffer.alloc(0),
					git(root, ["diff", "--binary", "--no-ext-diff", ...pathspecs]) ?? Buffer.alloc(0),
				])
			: git(root, ["diff", "--binary", "--no-ext-diff", "HEAD", ...pathspecs]);
	const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...pathspecs]);
	const untrackedOutput = git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspecs]);
	if (!diff || !status || !untrackedOutput) throw new Error("failed to capture the Git workspace state");
	const untracked = untrackedOutput
		.toString("utf8")
		.split("\0")
		.filter((path) => path.length > 0)
		.sort();
	const changedOutput =
		head === "UNBORN"
			? git(root, ["diff", "--cached", "--name-only", "-z", ...pathspecs])
			: git(root, ["diff", "--name-only", "-z", "HEAD", ...pathspecs]);
	if (!changedOutput) throw new Error("failed to enumerate changed workspace paths");
	const changedPaths = [
		...new Set([...changedOutput.toString("utf8").split("\0").filter(Boolean), ...untracked]),
	].sort();
	const pathDigests = Object.fromEntries(changedPaths.map((path) => [path, pathStateDigest(root, path)]));
	if (untracked.length > MAX_SNAPSHOT_FILES) throw new Error("workspace has too many untracked files to fingerprint");
	const hash = createHash("sha256");
	hash.update("prime-avo-workspace-v1\0git\0");
	hash.update(head);
	hash.update("\0");
	hash.update(status);
	hash.update(diff);
	let totalBytes = status.length + diff.length;
	for (const path of untracked) {
		totalBytes += hashPath(hash, root, path);
		if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error("workspace changes are too large to fingerprint");
	}
	const changedFileCount = status.toString("utf8").split("\0").filter(Boolean).length;
	return {
		root,
		digest: hash.digest("hex"),
		mode: "git",
		head,
		changedFileCount,
		totalBytes,
		changedPaths,
		pathDigests,
	};
}

function treeFiles(root: string, excludedRoots: readonly string[]): string[] {
	const files: string[] = [];
	const pending = [root];
	const excluded = excludedRoots.map((path) => resolve(path));
	while (pending.length > 0) {
		const directory = pending.pop()!;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory() && TREE_EXCLUDES.has(entry.name)) continue;
			const path = join(directory, entry.name);
			if (excluded.some((excludedRoot) => path === excludedRoot || path.startsWith(`${excludedRoot}${sep}`)))
				continue;
			if (entry.isDirectory()) pending.push(path);
			else files.push(relative(root, path));
			if (files.length > MAX_SNAPSHOT_FILES) throw new Error("workspace has too many files to fingerprint");
		}
	}
	return files.sort();
}

function treeSnapshot(cwd: string, excludedRoots: readonly string[]): AvoWorkspaceSnapshot {
	const root = resolve(cwd);
	const files = treeFiles(root, excludedRoots);
	const hash = createHash("sha256");
	hash.update("prime-avo-workspace-v1\0tree\0");
	let totalBytes = 0;
	for (const path of files) {
		totalBytes += hashPath(hash, root, path);
		if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error("workspace is too large to fingerprint");
	}
	return {
		root,
		digest: hash.digest("hex"),
		mode: "tree",
		head: "NO_GIT_HEAD",
		changedFileCount: files.length,
		totalBytes,
		changedPaths: files,
		pathDigests: Object.fromEntries(files.map((path) => [path, pathStateDigest(root, path)])),
	};
}

function isTestFile(path: string): boolean {
	const normalized = path.replaceAll("\\", "/").toLowerCase();
	const name = normalized.split("/").at(-1) ?? normalized;
	return (
		/(?:^|\/)(?:test|tests|__tests__)\//.test(normalized) ||
		/(?:\.test|\.spec)\.[a-z0-9]+$/.test(name) ||
		/^test_.+\.py$/.test(name) ||
		/.+_test\.(?:py|go|rs)$/.test(name) ||
		/(?:test|tests)\.(?:java|kt|cs|swift)$/.test(name)
	);
}

function workspaceFiles(cwd: string, excludedRoots: readonly string[]): { root: string; files: string[] } {
	const rootOutput = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!rootOutput) {
		const root = resolve(cwd);
		return { root, files: treeFiles(root, excludedRoots) };
	}
	const root = rootOutput.toString("utf8").trim();
	const pathspecs = ["--", ".", ...excludedPathspecs(root, excludedRoots)];
	const output = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", ...pathspecs]);
	if (!output) throw new Error("failed to enumerate the coding verification baseline");
	const files = output.toString("utf8").split("\0").filter(Boolean).sort();
	if (files.length > MAX_SNAPSHOT_FILES) throw new Error("workspace has too many files to baseline");
	return { root, files };
}

function fileSha256(root: string, path: string): string | undefined {
	try {
		const absolute = resolve(root, path);
		if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return undefined;
		const metadata = lstatSync(absolute);
		if (!metadata.isFile()) return undefined;
		return createHash("sha256").update(readFileSync(absolute)).digest("hex");
	} catch {
		return undefined;
	}
}

function userAcceptanceTestCommands(objective: string): string[] {
	const fragments = [
		...(objective.match(/`([^`\r\n]+)`/g) ?? []).map((value) => value.slice(1, -1)),
		...objective.split(/\r?\n/),
	];
	const commands = new Set<string>();
	for (const fragment of fragments) {
		const command = fragment.trim().replace(/^[>$]\s*/, "");
		try {
			if (classifyAvoHostEvaluationCommand(command) === "test") commands.add(command.replace(/[ \t]+/g, " "));
		} catch {
			// Natural-language lines are expected; only recognized direct test commands become acceptance checks.
		}
	}
	return [...commands].sort();
}

function objectiveTaskSourcePaths(objective: string, files: readonly string[]): string[] {
	const normalizedObjective = objective.toLowerCase();
	const sourceExtension = /\.(?:c|cc|cjs|cpp|cts|cxx|go|java|js|jsx|kt|mjs|mts|py|rb|rs|swift|ts|tsx)$/i;
	return files
		.filter((path) => !isTestFile(path) && sourceExtension.test(path))
		.filter((path) => {
			const normalized = path.replaceAll("\\", "/").toLowerCase();
			const name = normalized.split("/").at(-1) ?? normalized;
			const stem = name.replace(/\.[^.]+$/, "");
			if (normalizedObjective.includes(normalized) || normalizedObjective.includes(name)) return true;
			const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return (
				stem.length >= 3 && new RegExp(`(?:^|[^a-z0-9_])${escapedStem}(?:$|[^a-z0-9_])`).test(normalizedObjective)
			);
		})
		.map((path) => path.replaceAll(sep, "/"))
		.sort();
}

function declaredSpecSourcePaths(root: string, files: readonly string[]): string[] {
	const available = new Set(files.map((path) => path.replaceAll("\\", "/")));
	const sourcePaths = new Set<string>();
	for (const contractPath of [
		".prime/spec/requirements.json",
		"spec/requirements.json",
		"packages/coding-agent/spec/requirements.json",
	]) {
		if (!available.has(contractPath)) continue;
		try {
			const contract = JSON.parse(readFileSync(resolve(root, contractPath), "utf8")) as {
				requirements?: Array<{ sourcePaths?: unknown }>;
			};
			for (const requirement of contract.requirements ?? []) {
				if (!Array.isArray(requirement.sourcePaths)) continue;
				for (const path of requirement.sourcePaths) {
					if (typeof path !== "string") continue;
					const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
					if (available.has(normalized) && !isTestFile(normalized)) sourcePaths.add(normalized);
				}
			}
		} catch {
			// The spec-contract validator reports malformed contracts; this baseline only uses valid-looking source hints.
		}
	}
	return [...sourcePaths].sort();
}

export function captureAvoCodingVerificationBaseline(
	cwd: string,
	objective: string,
	options: { excludedRoots?: readonly string[] } = {},
): AvoVerificationBaseline {
	const excludedRoots = options.excludedRoots ?? [];
	const workspace = captureAvoWorkspaceSnapshot(cwd, { excludedRoots });
	const { root, files } = workspaceFiles(cwd, excludedRoots);
	const objectiveSourcePaths = objectiveTaskSourcePaths(objective, files);
	const specSourcePaths = declaredSpecSourcePaths(root, files);
	const taskSourcePaths = [...new Set([...objectiveSourcePaths, ...specSourcePaths])].sort();
	const strictTaskSourcePaths = taskSourcePaths.length > 0;
	let baselineTestBytes = 0;
	const testFiles = files.filter(isTestFile).flatMap((path) => {
		try {
			const metadata = lstatSync(resolve(root, path));
			if (!metadata.isFile()) return [];
			baselineTestBytes += metadata.size;
			if (baselineTestBytes > MAX_BASELINE_TEST_BYTES) {
				throw new Error("workspace tests are too large to capture a trusted verification baseline");
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("too large")) throw error;
			return [];
		}
		const sha256 = fileSha256(root, path);
		return sha256 ? [{ path: path.replaceAll(sep, "/"), sha256 }] : [];
	});
	let baselinePythonBytes = 0;
	const pythonCallableDimensions: Record<string, Record<string, string[]>> = {};
	const pythonCallableSignatureDigests: Record<string, Record<string, string>> = {};
	const pythonUninspectableCallables: Record<string, string[]> = {};
	const pythonUnsafePaths: string[] = [];
	const pythonSources: Record<string, string> = {};
	for (const path of files.filter((item) => item.endsWith(".py"))) {
		const absolute = resolve(root, path);
		const normalizedPath = path.replaceAll(sep, "/");
		try {
			const metadata = lstatSync(absolute);
			if (!metadata.isFile() || metadata.isSymbolicLink()) {
				pythonUnsafePaths.push(normalizedPath);
				continue;
			}
			baselinePythonBytes += metadata.size;
			if (baselinePythonBytes > MAX_BASELINE_TEST_BYTES) {
				throw new Error("workspace Python sources are too large to capture a trusted callable baseline");
			}
			const contents = readFileSync(absolute);
			const source = contents.toString("utf8");
			if (contents.includes(0) || !Buffer.from(source, "utf8").equals(contents)) {
				pythonUnsafePaths.push(normalizedPath);
				continue;
			}
			pythonSources[normalizedPath] = source;
		} catch (error) {
			if (error instanceof Error && error.message.includes("too large")) throw error;
			pythonUnsafePaths.push(normalizedPath);
		}
	}
	let pythonInspections: ReturnType<typeof inspectAvoPythonPublicCallableSources> = {};
	try {
		pythonInspections = inspectAvoPythonPublicCallableSources(pythonSources);
	} catch {
		for (const path of Object.keys(pythonSources)) {
			pythonInspections[path] = {
				callables: [],
				errors: [{ name: "*", reason: "host Python AST inspection failed" }],
			};
		}
	}
	for (const [path, inspection] of Object.entries(pythonInspections)) {
		pythonCallableDimensions[path] = Object.fromEntries(
			inspection.callables.map((callable) => [callable.name, callable.inputDimensions]),
		);
		pythonCallableSignatureDigests[path] = Object.fromEntries(
			inspection.callables.map((callable) => [callable.name, callable.signatureDigest]),
		);
		if (inspection.errors.length > 0) {
			pythonUninspectableCallables[path] = inspection.errors.map((error) => error.name);
		}
	}
	const userAcceptanceCommands = userAcceptanceTestCommands(objective);
	const contractDigest = createHash("sha256")
		.update(
			JSON.stringify({
				workspaceDigest: workspace.digest,
				taskSourcePaths,
				strictTaskSourcePaths,
				testFiles,
				userAcceptanceCommands,
			}),
		)
		.digest("hex");
	return {
		kind: "coding",
		contractDigest,
		workspaceRoot: root,
		workspaceDigest: workspace.digest,
		workspaceMode: workspace.mode,
		workspaceHead: workspace.head,
		workspacePathDigests: workspace.pathDigests,
		pythonCallableDimensions,
		pythonCallableSignatureDigests,
		pythonUninspectableCallables,
		pythonUnsafePaths,
		taskSourcePaths,
		strictTaskSourcePaths,
		testFiles,
		userAcceptanceCommands,
		executions: [],
		capturedAt: new Date().toISOString(),
	};
}

export function deriveAvoWorkspaceImpactPaths(
	baseline: AvoVerificationBaseline | undefined,
	current: AvoWorkspaceSnapshot,
): string[] {
	if (
		!baseline ||
		(baseline.workspaceRoot !== undefined && resolve(baseline.workspaceRoot) !== current.root) ||
		baseline.workspaceMode !== current.mode
	) {
		return [...current.changedPaths];
	}
	const dirtyPaths = baseline.workspacePathDigests
		? [...new Set([...Object.keys(baseline.workspacePathDigests), ...Object.keys(current.pathDigests)])].filter(
				(path) => baseline.workspacePathDigests?.[path] !== current.pathDigests[path],
			)
		: [...current.changedPaths];
	if (current.mode !== "git" || baseline.workspaceHead === current.head) return dirtyPaths.sort();
	if (
		!baseline.workspaceHead ||
		baseline.workspaceHead === "UNBORN" ||
		current.head === "UNBORN" ||
		!/^[a-f0-9]{40,64}$/i.test(baseline.workspaceHead) ||
		!/^[a-f0-9]{40,64}$/i.test(current.head)
	) {
		throw new Error("cannot derive committed workspace impact across an invalid or unborn Git baseline");
	}
	const committedOutput = git(current.root, [
		"diff",
		"--name-only",
		"-z",
		"--no-renames",
		baseline.workspaceHead,
		current.head,
		"--",
	]);
	if (!committedOutput) {
		throw new Error("failed to derive committed workspace impact from the task-start Git baseline");
	}
	const committedPaths = committedOutput.toString("utf8").split("\0").filter(Boolean);
	return [...new Set([...dirtyPaths, ...committedPaths])].sort();
}

export function captureAvoArtifactPathBaseline(
	cwd: string,
	options: { excludedRoots?: readonly string[] } = {},
): string[] {
	const root = resolve(cwd);
	return treeFiles(root, options.excludedRoots ?? []).map((path) => resolve(root, path));
}

export function captureAvoPythonProbeBundle(
	cwd: string,
	options: { excludedRoots?: readonly string[] } = {},
): AvoPythonProbeBundle {
	const { root, files } = workspaceFiles(cwd, options.excludedRoots ?? []);
	const bundleFiles = files
		.filter((path) => path.endsWith(".py"))
		.flatMap((path) => {
			try {
				const absolute = resolve(root, path);
				const metadata = lstatSync(absolute);
				if (!metadata.isFile() || metadata.isSymbolicLink()) return [];
				return [
					{
						path: path.replaceAll(sep, "/"),
						contentBase64: readFileSync(absolute).toString("base64"),
					},
				];
			} catch {
				return [];
			}
		});
	return createAvoPythonProbeBundle(bundleFiles);
}

export interface AvoTestTrustAssessment {
	trusted: boolean;
	taskSpecific: boolean;
	basis:
		| "user_acceptance"
		| "baseline_target"
		| "baseline_suite"
		| "candidate_only"
		| "missing_baseline"
		| "mutable_package_script"
		| "narrowed_selection"
		| "unsupported_verification_harness";
	baselineTestCount: number;
	unchangedBaselineTestCount: number;
	explicitBaselineTargets: number;
	observedBaselineTestFiles: string[];
	executionProven: boolean;
	narrowedSelection: boolean;
	verificationHarness?: AvoVerificationHarnessManifest;
	verificationHarnessSupported: boolean;
}

function explicitTestTargets(command: string): string[] {
	const tokens = (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^['"]|['"]$/g, ""));
	const optionOperands = new Set([
		"-c",
		"--config",
		"--dir",
		"--globalSetup",
		"--globalTeardown",
		"--import",
		"--loader",
		"--project",
		"--require",
		"--reporter",
		"--root",
		"--setupFiles",
		"--setupFilesAfterEnv",
		"--test-reporter",
		"--workspace",
	]);
	const target =
		/(?:(?:^|\/)(?:test|tests|__tests__)\/[^\s"']+\.[a-z0-9]+|(?:\.test|\.spec)\.[a-z0-9]+|(?:^|\/)test_[^\s"']+\.py|_test\.(?:py|go|rs)|(?:test|tests)\.(?:java|kt|cs|swift))$/i;
	const positionalBooleanOptions = new Set(["-q", "-v", "--run", "--runInBand", "--silent", "--test", "--verbose"]);
	const paths: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (optionOperands.has(token)) {
			index += 1;
			continue;
		}
		if (!token.startsWith("-") && target.test(token)) {
			const previous = tokens[index - 1];
			if (previous?.startsWith("-") && previous !== "--" && !positionalBooleanOptions.has(previous)) continue;
			paths.push(token);
		}
	}
	return paths;
}

const VERIFICATION_CONFIG_NAMES = new Set([
	".pytest.ini",
	"bun.lock",
	"bun.lockb",
	"deno.json",
	"deno.jsonc",
	"jest.config.cjs",
	"jest.config.cts",
	"jest.config.js",
	"jest.config.mjs",
	"jest.config.mts",
	"jest.config.ts",
	"package-lock.json",
	"package.json",
	"pnpm-lock.yaml",
	"poetry.lock",
	"pyproject.toml",
	".pytest.toml",
	"pytest.ini",
	"pytest.toml",
	"requirements-dev.txt",
	"requirements.txt",
	"setup.cfg",
	"tox.ini",
	"uv.lock",
	"vitest.config.js",
	"vitest.config.cjs",
	"vitest.config.cts",
	"vitest.config.mjs",
	"vitest.config.mts",
	"vitest.config.ts",
	"vite.config.js",
	"vite.config.cjs",
	"vite.config.cts",
	"vite.config.mjs",
	"vite.config.mts",
	"vite.config.ts",
	"yarn.lock",
]);

const PYTHON_SHADOW_NAMES = [
	"conftest.py",
	"pytest.py",
	"pytest/__init__.py",
	"sitecustomize.py",
	"usercustomize.py",
] as const;

function verificationRunnerFamily(command: string): AvoVerificationHarnessManifest["runnerFamily"] {
	if (/(?:^|\s)(?:pytest|py\.test)(?:\s|$)|(?:python3?|python)\s+-m\s+pytest(?:\s|$)/i.test(command)) {
		return "pytest";
	}
	if (/(?:^|\s)(?:vitest|jest|node\s+--test)(?:\s|$)/i.test(command)) return "node_test";
	return "other";
}

function shellCommandTokens(command: string): string[] {
	return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function pytestCaptureIsUnsafe(value: string): boolean {
	return (
		/(?:^|\s)-(?!-)[A-Za-z]*s[A-Za-z]*(?=\s|$)/.test(value) ||
		/--capture(?:=|\s+)(?:no|sys|tee-sys)(?=\s|$)/i.test(value)
	);
}

function pytestVerboseIdentityIsEnabled(value: string): boolean {
	return /(?:^|\s)-(?!-)[A-Za-z]*v[A-Za-z]*(?=\s|$)/.test(value) || /(?:^|\s)--verbose(?=\s|$)/.test(value);
}

function pytestPluginNames(value: string): { names: string[]; invalid: boolean } {
	const tokens = shellCommandTokens(value);
	const names: string[] = [];
	let invalid = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		let name: string | undefined;
		if (token === "-p") {
			name = tokens[index + 1];
			index += 1;
			if (!name) invalid = true;
		} else if (token.startsWith("-p") && token.length > 2 && !token.startsWith("--")) {
			name = token.slice(2).replace(/^=/, "");
		}
		if (!name || name.startsWith("no:")) continue;
		if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) invalid = true;
		else names.push(name);
	}
	return { names: [...new Set(names)], invalid };
}

function pytestEnvironmentPluginNames(value: string): { names: string[]; invalid: boolean } {
	if (!value.trim()) return { names: [], invalid: false };
	const names = value
		.split(/[\s,]+/)
		.map((name) => name.trim())
		.filter(Boolean);
	return {
		names: names.filter((name) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)),
		invalid: names.some((name) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)),
	};
}

function pytestConfigPluginNames(source: string): { names: string[]; invalid: boolean } {
	const shellStyle = pytestPluginNames(source);
	const tomlNames = [
		...source.matchAll(/["']-p["']\s*,\s*["']([A-Za-z_][A-Za-z0-9_.]*)["']/g),
		...source.matchAll(/["']-p=?([A-Za-z_][A-Za-z0-9_.]*)["']/g),
	].map((match) => match[1]!);
	const pluginSwitchPresent = /(?:^|[\s["'])-p(?:[=\s"']|[A-Za-z_])/m.test(source);
	return {
		names: [...new Set([...shellStyle.names, ...tomlNames])],
		invalid: shellStyle.invalid || (pluginSwitchPresent && shellStyle.names.length === 0 && tomlNames.length === 0),
	};
}

function hasClosedVerificationRunner(
	command: string,
	runnerFamily: AvoVerificationHarnessManifest["runnerFamily"],
): boolean {
	const tokens = shellCommandTokens(command);
	const executable = tokens[0]?.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
	if (runnerFamily === "pytest") {
		if (!/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(executable)) return false;
		const moduleIndex = tokens.indexOf("-m");
		return moduleIndex > 0 && tokens[moduleIndex + 1] === "pytest";
	}
	if (runnerFamily === "node_test") return executable === "node" && tokens.includes("--test");
	return false;
}

const HARNESS_ROLE_PRIORITY: Record<AvoVerificationHarnessEntry["role"], number> = {
	fixture: 0,
	test: 1,
	config: 2,
	plugin: 3,
	runner: 4,
};

function staticPytestPluginNames(source: string): { names: string[]; dynamic: boolean } {
	const assignment = /(?:^|\n)\s*pytest_plugins\s*=\s*([^\n]+)/.exec(source)?.[1]?.trim();
	if (!assignment) return { names: [], dynamic: false };
	if (!/^(?:[[(]\s*)?(?:["'][A-Za-z0-9_.]+["']\s*,?\s*)+(?:[\])])?$/.test(assignment)) {
		return { names: [], dynamic: true };
	}
	return {
		names: [...assignment.matchAll(/["']([A-Za-z0-9_.]+)["']/g)].map((match) => match[1]!),
		dynamic: false,
	};
}

function staticPythonImports(source: string): Array<{ moduleName: string; importedNames: string[] }> {
	const imports: Array<{ moduleName: string; importedNames: string[] }> = [];
	for (const match of source.matchAll(/(?:^|\n)\s*import\s+([^#\n]+)/g)) {
		for (const item of match[1]!.split(",")) {
			const moduleName = item
				.trim()
				.split(/\s+as\s+/i)[0]
				?.trim();
			if (moduleName && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(moduleName)) {
				imports.push({ moduleName, importedNames: [] });
			}
		}
	}
	for (const match of source.matchAll(/(?:^|\n)\s*from\s+([A-Za-z0-9_.]+)\s+import\s+(?:\(([\s\S]*?)\)|([^#\n]+))/g)) {
		const importedNames = (match[2] ?? match[3] ?? "")
			.replace(/#[^\n]*/g, "")
			.replace(/[()]/g, "")
			.split(",")
			.map(
				(item) =>
					item
						.trim()
						.split(/\s+as\s+/i)[0]
						?.trim() ?? "",
			)
			.filter(Boolean);
		imports.push({ moduleName: match[1]!, importedNames });
	}
	return imports;
}

function staticNodeImports(source: string): string[] {
	return [
		...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
		...source.matchAll(/(?:^|\n)\s*import(?:[^;\n]*?\sfrom\s*)?\s*["']([^"']+)["']/g),
		...source.matchAll(/(?:^|\n)\s*export(?:[^;\n]*?\sfrom\s*)\s*["']([^"']+)["']/g),
	].map((match) => match[1]!);
}

function commandExecutable(command: string): string | undefined {
	const token = command
		.trim()
		.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/)
		?.slice(1)
		.find(Boolean);
	if (!token || /[;&|`$<>\r\n]/.test(token)) return undefined;
	return token;
}

function resolveCommandExecutable(cwd: string, command: string): string | undefined {
	const token = commandExecutable(command);
	if (!token) return undefined;
	if (token.includes("/")) {
		const path = resolve(cwd, token);
		return existsSync(path) ? realpathSync(path) : undefined;
	}
	const found = spawnSync("which", [token], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const path = found.status === 0 ? found.stdout.trim().split("\n")[0] : undefined;
	return path && existsSync(path) ? realpathSync(path) : undefined;
}

function verificationTestRoot(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	const parts = normalized.split("/");
	const testIndex = parts.findIndex((part) => ["test", "tests", "__tests__"].includes(part.toLowerCase()));
	return testIndex >= 0 ? parts.slice(0, testIndex + 1).join("/") : dirname(normalized).replaceAll("\\", "/");
}

function isInsideNamedTestDirectory(path: string): boolean {
	return path
		.replaceAll("\\", "/")
		.split("/")
		.slice(0, -1)
		.some((part) => ["test", "tests", "__tests__"].includes(part.toLowerCase()));
}

const NODE_BUILTIN_MODULES = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]));

function isNodeBuiltinModule(specifier: string): boolean {
	return specifier.startsWith("node:") || NODE_BUILTIN_MODULES.has(specifier);
}

function safeHarnessEntry(
	root: string,
	path: string,
	role: AvoVerificationHarnessEntry["role"],
): AvoVerificationHarnessEntry | undefined {
	const normalized = path.replaceAll("\\", "/");
	const absolute = resolve(root, normalized);
	if (absolute === root || !absolute.startsWith(`${root}${sep}`)) return undefined;
	try {
		const metadata = lstatSync(absolute);
		if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
		return { path: normalized, sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"), role };
	} catch {
		return undefined;
	}
}

function localPythonModulePaths(
	originPath: string,
	moduleName: string,
	importedNames: readonly string[],
	availableFiles: ReadonlySet<string>,
	searchRoots: readonly string[] = [""],
): string[] {
	const leadingDots = moduleName.match(/^\.+/)?.[0].length ?? 0;
	const bareModule = moduleName.slice(leadingDots);
	let baseRoots: string[][];
	if (leadingDots > 0) {
		let baseParts = dirname(originPath).replaceAll("\\", "/").split("/").filter(Boolean);
		baseParts = baseParts.slice(0, Math.max(0, baseParts.length - (leadingDots - 1)));
		baseRoots = [baseParts];
	} else {
		baseRoots = searchRoots.map((root) => root.replaceAll("\\", "/").split("/").filter(Boolean));
	}
	const moduleParts = bareModule.split(".").filter(Boolean);
	const candidates = new Set<string>();
	for (const baseParts of baseRoots) {
		const combined = [...baseParts, ...moduleParts];
		for (let index = baseParts.length + 1; index <= combined.length; index += 1) {
			candidates.add(`${combined.slice(0, index).join("/")}/__init__.py`);
		}
		if (combined.length > 0) {
			candidates.add(`${combined.join("/")}.py`);
			candidates.add(`${combined.join("/")}/__init__.py`);
		}
		for (const importedName of importedNames.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
			const imported = [...combined, importedName].join("/");
			candidates.add(`${imported}.py`);
			candidates.add(`${imported}/__init__.py`);
		}
	}
	return [...candidates].filter((path) => availableFiles.has(path)).sort();
}

function localNodeModulePaths(originPath: string, specifier: string, availableFiles: ReadonlySet<string>): string[] {
	if (!specifier.startsWith(".")) return [];
	const normalizedBase = resolve("/", dirname(originPath), specifier).slice(1).replaceAll("\\", "/");
	const candidates = [
		normalizedBase,
		...(["js", "jsx", "cjs", "mjs", "ts", "tsx", "json"] as const).map(
			(extension) => `${normalizedBase}.${extension}`,
		),
		...(["js", "jsx", "cjs", "mjs", "ts", "tsx", "json"] as const).map(
			(extension) => `${normalizedBase}/index.${extension}`,
		),
	];
	return candidates.filter((path) => availableFiles.has(path));
}

export function captureAvoVerificationHarnessManifest(
	cwd: string,
	command: string,
	baseline: AvoVerificationBaseline,
): AvoVerificationHarnessManifest {
	const rootOutput = git(cwd, ["rev-parse", "--show-toplevel"]);
	const baselineRoot = baseline.workspaceRoot ? resolve(baseline.workspaceRoot) : undefined;
	const resolvedCwd = resolve(cwd);
	const compatibleBaselineRoot =
		baselineRoot && (resolvedCwd === baselineRoot || resolvedCwd.startsWith(`${baselineRoot}${sep}`))
			? baselineRoot
			: undefined;
	const root = rootOutput?.toString("utf8").trim() || compatibleBaselineRoot || resolvedCwd;
	const commandDigest = createHash("sha256").update(command).digest("hex");
	const runnerFamily = verificationRunnerFamily(command);
	const verificationEnvironment = sanitizeAvoVerificationEnvironment(process.env);
	const unsupportedReasons: string[] = [];
	if (runnerFamily === "other") {
		unsupportedReasons.push("test runner family does not have a closed verifier adapter");
	}
	if (/[;&|`$<>()\r\n]/.test(command)) {
		unsupportedReasons.push("compound or shell-expanded test commands do not have a closed verifier surface");
	}
	if (!hasClosedVerificationRunner(command, runnerFamily)) {
		unsupportedReasons.push("test runner command is not a directly resolved closed runner invocation");
	}
	for (const key of unboundAvoVerificationEnvironmentKeys(process.env, runnerFamily)) {
		unsupportedReasons.push(`${key} must be empty because its referenced verifier controls are not content-bound`);
	}
	if (
		runnerFamily === "pytest" &&
		(pytestCaptureIsUnsafe(command) || pytestCaptureIsUnsafe(process.env.PYTEST_ADDOPTS ?? ""))
	) {
		unsupportedReasons.push("pytest output capture must remain fd-bound for authoritative result parsing");
	}
	if (runnerFamily === "pytest" && !pytestVerboseIdentityIsEnabled(command)) {
		unsupportedReasons.push("pytest verification requires -v or --verbose to bind executed test identities");
	}
	if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) {
		unsupportedReasons.push("the read-only Linux verification sandbox is unavailable");
	}
	const explicit = explicitTestTargets(command).map((target) => {
		const absolute = resolve(cwd, target);
		return relative(root, absolute).replaceAll(sep, "/");
	});
	const targetPaths = [
		...new Set(explicit.length > 0 ? explicit : baseline.testFiles.map((file) => file.path)),
	].sort();
	if (targetPaths.length === 0) unsupportedReasons.push("the test command has no task-start test target");

	let allFiles: string[] = [];
	try {
		allFiles = treeFiles(root, []);
	} catch (error) {
		unsupportedReasons.push(`could not enumerate verifier controls: ${String(error)}`);
	}
	const availableFiles = new Set(allFiles.map((path) => path.replaceAll("\\", "/")));
	const taskSourcePaths = new Set((baseline.taskSourcePaths ?? []).map((path) => path.replaceAll("\\", "/")));
	const strictTaskSourcePaths = baseline.strictTaskSourcePaths === true;
	const pythonSearchRoots = new Set<string>([""]);
	const cwdSearchRoot = relative(root, resolvedCwd).replaceAll(sep, "/");
	if (cwdSearchRoot && cwdSearchRoot !== "." && !cwdSearchRoot.startsWith("../")) {
		pythonSearchRoots.add(cwdSearchRoot);
	}
	for (const target of targetPaths) {
		const targetDirectory = dirname(target).replaceAll("\\", "/");
		if (targetDirectory && targetDirectory !== "." && !targetDirectory.startsWith("../")) {
			pythonSearchRoots.add(targetDirectory);
		}
	}
	const externalPythonModules = new Set<string>();
	const inferredApplicationPaths = new Set<string>();
	const applicationPythonPaths = new Set<string>(
		[...taskSourcePaths].filter((path) => path.endsWith(".py") && availableFiles.has(path)),
	);
	const applicationNodePaths = new Set<string>(
		[...taskSourcePaths].filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path) && availableFiles.has(path)),
	);
	const controls = new Map<string, AvoVerificationHarnessEntry["role"]>();
	const pendingControls: string[] = [];
	const addControl = (path: string, role: AvoVerificationHarnessEntry["role"]): void => {
		const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
		if (!normalized || normalized.startsWith("../") || normalized === "..") {
			unsupportedReasons.push(`unsafe verifier control path: ${path}`);
			return;
		}
		const current = controls.get(normalized);
		if (!current) pendingControls.push(normalized);
		if (!current || HARNESS_ROLE_PRIORITY[role] > HARNESS_ROLE_PRIORITY[current]) controls.set(normalized, role);
	};
	for (const target of targetPaths) {
		const targetRoot = verificationTestRoot(target);
		for (const path of allFiles) {
			const normalized = path.replaceAll("\\", "/");
			if (normalized === target || normalized.startsWith(`${targetRoot}/`)) {
				addControl(normalized, normalized === target ? "test" : "fixture");
			}
		}
		let directory = dirname(resolve(root, target));
		while (directory === root || directory.startsWith(`${root}${sep}`)) {
			for (const name of VERIFICATION_CONFIG_NAMES) {
				const path = relative(root, join(directory, name)).replaceAll(sep, "/");
				if (existsSync(join(directory, name))) addControl(path, "config");
			}
			if (runnerFamily === "pytest") {
				const conftest = join(directory, "conftest.py");
				if (existsSync(conftest)) addControl(relative(root, conftest).replaceAll(sep, "/"), "plugin");
			}
			if (directory === root) break;
			directory = dirname(directory);
		}
	}
	for (const path of allFiles) {
		const normalized = path.replaceAll("\\", "/");
		if (VERIFICATION_CONFIG_NAMES.has(normalized.split("/").at(-1) ?? "")) addControl(normalized, "config");
	}

	const absentControlPaths = new Set<string>();
	if (runnerFamily === "pytest") {
		const shadowDirectories = new Set<string>();
		let directory = resolve(cwd);
		while (directory === root || directory.startsWith(`${root}${sep}`)) {
			shadowDirectories.add(relative(root, directory).replaceAll(sep, "/"));
			if (directory === root) break;
			directory = dirname(directory);
		}
		for (const target of targetPaths) {
			let targetDirectory = dirname(resolve(root, target));
			while (targetDirectory === root || targetDirectory.startsWith(`${root}${sep}`)) {
				shadowDirectories.add(relative(root, targetDirectory).replaceAll(sep, "/"));
				if (targetDirectory === root) break;
				targetDirectory = dirname(targetDirectory);
			}
		}
		for (const shadowDirectory of shadowDirectories) {
			for (const name of PYTHON_SHADOW_NAMES) {
				const path = [shadowDirectory, name].filter(Boolean).join("/");
				if (existsSync(resolve(root, path))) addControl(path, "plugin");
				else absentControlPaths.add(path);
			}
		}
	}
	if (runnerFamily === "pytest") {
		const commandPlugins = pytestPluginNames(command);
		const addoptsPlugins = pytestPluginNames(process.env.PYTEST_ADDOPTS ?? "");
		const environmentPlugins = pytestEnvironmentPluginNames(process.env.PYTEST_PLUGINS ?? "");
		if (commandPlugins.invalid || addoptsPlugins.invalid || environmentPlugins.invalid) {
			unsupportedReasons.push("pytest plugin configuration contains an invalid module name");
		}
		for (const pluginName of [...commandPlugins.names, ...addoptsPlugins.names, ...environmentPlugins.names]) {
			const localPaths = localPythonModulePaths("", pluginName, [], availableFiles, [...pythonSearchRoots]);
			if (localPaths.length === 0) externalPythonModules.add(pluginName.split(".")[0]!);
			else for (const path of localPaths) addControl(path, "plugin");
		}
	}

	const scannedControls = new Set<string>();
	while (pendingControls.length > 0) {
		const path = pendingControls.shift()!;
		if (scannedControls.has(path)) continue;
		scannedControls.add(path);
		let source: string;
		try {
			source = readFileSync(resolve(root, path), "utf8");
		} catch {
			unsupportedReasons.push(`verifier control could not be read: ${path}`);
			continue;
		}
		if (runnerFamily === "pytest" && controls.get(path) === "config") {
			if (pytestCaptureIsUnsafe(source)) {
				unsupportedReasons.push(`pytest configuration disables fd-bound output capture: ${path}`);
			}
			const configuredPlugins = pytestConfigPluginNames(source);
			if (configuredPlugins.invalid) {
				unsupportedReasons.push(`pytest configuration contains an invalid plugin module: ${path}`);
			}
			for (const pluginName of configuredPlugins.names) {
				const localPaths = localPythonModulePaths(path, pluginName, [], availableFiles, [
					...pythonSearchRoots,
					dirname(path).replaceAll("\\", "/"),
				]);
				if (localPaths.length === 0) externalPythonModules.add(pluginName.split(".")[0]!);
				else for (const importedPath of localPaths) addControl(importedPath, "plugin");
			}
		}
		if (path.endsWith(".py")) {
			if (/\b(?:__import__|importlib\.import_module)\s*\(/.test(source)) {
				unsupportedReasons.push(`dynamic Python imports do not have a closed verifier surface: ${path}`);
			}
			const pluginDeclaration = staticPytestPluginNames(source);
			if (pluginDeclaration.dynamic) {
				unsupportedReasons.push(`dynamic pytest plugin declaration is not safely closed: ${path}`);
			}
			for (const pluginName of pluginDeclaration.names) {
				const localPaths = localPythonModulePaths(path, pluginName, [], availableFiles, [
					...pythonSearchRoots,
					dirname(path).replaceAll("\\", "/"),
				]);
				if (localPaths.length === 0) externalPythonModules.add(pluginName.split(".")[0]!);
				else for (const importedPath of localPaths) addControl(importedPath, "plugin");
			}
			for (const imported of staticPythonImports(source)) {
				const localPaths = localPythonModulePaths(
					path,
					imported.moduleName,
					imported.importedNames,
					availableFiles,
					[...pythonSearchRoots, dirname(path).replaceAll("\\", "/")],
				);
				if (localPaths.length === 0 && !imported.moduleName.startsWith(".")) {
					externalPythonModules.add(imported.moduleName.split(".")[0]!);
				}
				for (const importedPath of localPaths) {
					const applicationPath =
						taskSourcePaths.has(importedPath) ||
						(!strictTaskSourcePaths && !isTestFile(importedPath) && !isInsideNamedTestDirectory(importedPath));
					if (applicationPath) {
						applicationPythonPaths.add(importedPath);
						if (!taskSourcePaths.has(importedPath)) inferredApplicationPaths.add(importedPath);
					} else addControl(importedPath, "fixture");
				}
			}
		}
		if (/\.(?:[cm]?[jt]sx?|json)$/.test(path)) {
			if (/\bimport\s*\(|\brequire\s*\([^"']/.test(source)) {
				unsupportedReasons.push(`dynamic JavaScript imports do not have a closed verifier surface: ${path}`);
			}
			for (const specifier of staticNodeImports(source)) {
				const localPaths = localNodeModulePaths(path, specifier, availableFiles);
				if (localPaths.length === 0 && !specifier.startsWith(".") && !isNodeBuiltinModule(specifier)) {
					unsupportedReasons.push(`external Node verifier dependency is not content-bound: ${specifier}`);
				}
				for (const importedPath of localPaths) {
					const applicationPath =
						taskSourcePaths.has(importedPath) ||
						(!strictTaskSourcePaths && !isTestFile(importedPath) && !isInsideNamedTestDirectory(importedPath));
					if (applicationPath) {
						applicationNodePaths.add(importedPath);
						if (!taskSourcePaths.has(importedPath)) inferredApplicationPaths.add(importedPath);
					} else addControl(importedPath, "fixture");
				}
			}
		}
	}

	const scannedApplicationPython = new Set<string>();
	const pendingApplicationPython = [...applicationPythonPaths];
	while (pendingApplicationPython.length > 0) {
		const path = pendingApplicationPython.shift()!;
		if (scannedApplicationPython.has(path)) continue;
		scannedApplicationPython.add(path);
		let source: string;
		try {
			source = readFileSync(resolve(root, path), "utf8");
		} catch {
			unsupportedReasons.push(`application Python dependency could not be read: ${path}`);
			continue;
		}
		if (/\b(?:__import__|importlib\.import_module)\s*\(/.test(source)) {
			unsupportedReasons.push(`dynamic Python application imports do not have a closed verifier surface: ${path}`);
		}
		for (const imported of staticPythonImports(source)) {
			const localPaths = localPythonModulePaths(path, imported.moduleName, imported.importedNames, availableFiles, [
				...pythonSearchRoots,
				dirname(path).replaceAll("\\", "/"),
			]);
			if (localPaths.length === 0 && !imported.moduleName.startsWith(".")) {
				externalPythonModules.add(imported.moduleName.split(".")[0]!);
			}
			for (const importedPath of localPaths) {
				if (!scannedApplicationPython.has(importedPath)) pendingApplicationPython.push(importedPath);
			}
		}
	}

	const scannedApplicationNode = new Set<string>();
	const pendingApplicationNode = [...applicationNodePaths];
	while (pendingApplicationNode.length > 0) {
		const path = pendingApplicationNode.shift()!;
		if (scannedApplicationNode.has(path)) continue;
		scannedApplicationNode.add(path);
		let source: string;
		try {
			source = readFileSync(resolve(root, path), "utf8");
		} catch {
			unsupportedReasons.push(`application Node dependency could not be read: ${path}`);
			continue;
		}
		if (/\bimport\s*\(|\brequire\s*\([^"']/.test(source)) {
			unsupportedReasons.push(`dynamic Node application imports do not have a closed verifier surface: ${path}`);
		}
		for (const specifier of staticNodeImports(source)) {
			const localPaths = localNodeModulePaths(path, specifier, availableFiles);
			if (localPaths.length === 0 && !specifier.startsWith(".") && !isNodeBuiltinModule(specifier)) {
				unsupportedReasons.push(`external Node application dependency is not content-bound: ${specifier}`);
			}
			for (const importedPath of localPaths) {
				if (!scannedApplicationNode.has(importedPath)) pendingApplicationNode.push(importedPath);
			}
		}
	}
	if (!strictTaskSourcePaths && taskSourcePaths.size === 0 && inferredApplicationPaths.size > 1) {
		unsupportedReasons.push(
			`ambiguous application and verifier dependencies (${[...inferredApplicationPaths].sort().join(", ")}); declare specification sourcePaths`,
		);
	}

	let controlBytes = 0;
	const entries = [...controls.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([path, role]) => {
			const entry = safeHarnessEntry(root, path, role);
			if (!entry) {
				unsupportedReasons.push(`verifier control is missing, unsafe, or not a regular file: ${path}`);
				return [];
			}
			controlBytes += statSync(resolve(root, path)).size;
			if (controlBytes > MAX_BASELINE_TEST_BYTES) {
				unsupportedReasons.push("verification harness exceeds the 128 MiB capture limit");
				return [];
			}
			return [entry];
		});

	const executablePath = resolveCommandExecutable(cwd, command);
	if (!executablePath) unsupportedReasons.push("test runner executable could not be resolved exactly");
	let runnerSha256 = "unresolved";
	if (executablePath) {
		try {
			runnerSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
		} catch (error) {
			unsupportedReasons.push(`test runner identity could not be hashed: ${String(error)}`);
		}
	}
	let sandboxSha256 = "unavailable";
	if (existsSync("/usr/bin/bwrap")) {
		try {
			sandboxSha256 = createHash("sha256").update(readFileSync("/usr/bin/bwrap")).digest("hex");
		} catch (error) {
			unsupportedReasons.push(`verification sandbox identity could not be hashed: ${String(error)}`);
		}
	}
	let pythonEnvironment = "not-python";
	if (runnerFamily === "pytest" && unsupportedReasons.length === 0) {
		const pythonToken = /^(?:python3?|python)\b/i.test(command.trim()) ? executablePath : undefined;
		const pythonPath = pythonToken ?? resolveCommandExecutable(cwd, "python3");
		if (!pythonPath) {
			unsupportedReasons.push("Python interpreter identity could not be resolved");
		} else {
			const externalPythonModuleList = [...externalPythonModules].filter(Boolean).sort();
			const identityScript = [
				"import hashlib, importlib.metadata as metadata, importlib.util, json, pathlib, sys",
				`external_modules = ${JSON.stringify(externalPythonModuleList)}`,
				"def fingerprint(distribution, module_names):",
				"    digest = hashlib.sha256()",
				"    total = 0",
				"    count = 0",
				"    seen = set()",
				"    def add_file(path, label):",
				"        nonlocal total, count",
				"        resolved = path.resolve()",
				"        if resolved in seen or not path.is_file(): return",
				"        seen.add(resolved)",
				"        digest.update(label.encode('utf-8'))",
				"        digest.update(b'\\0')",
				"        with path.open('rb') as handle:",
				"            while chunk := handle.read(1024 * 1024):",
				"                total += len(chunk)",
				"                if total > 512 * 1024 * 1024: raise RuntimeError('pytest dependency identity exceeds 512 MiB')",
				"                digest.update(chunk)",
				"        count += 1",
				"    for item in sorted(distribution.files or [], key=str):",
				"        path = distribution.locate_file(item)",
				"        add_file(path, 'dist:' + str(item))",
				"    for module_name in sorted(module_names):",
				"        spec = importlib.util.find_spec(module_name)",
				"        if spec is None: raise RuntimeError('Python module cannot be resolved: ' + module_name)",
				"        roots = list(spec.submodule_search_locations or ())",
				"        if not roots and spec.origin and spec.origin not in {'built-in', 'frozen'}: roots = [spec.origin]",
				"        for raw_root in roots:",
				"            root = pathlib.Path(raw_root)",
				"            files = [root] if root.is_file() else sorted(item for item in root.rglob('*') if item.is_file() and '__pycache__' not in item.parts and item.suffix not in {'.pyc', '.pyo'})",
				"            for path in files: add_file(path, 'module:' + module_name + ':' + str(path.relative_to(root) if root.is_dir() else path.name))",
				"    if count == 0: raise RuntimeError('Python distribution has no content-bound files')",
				"    return {'name': distribution.metadata.get('Name') or '', 'version': distribution.version, 'files': count, 'sha256': digest.hexdigest()}",
				"entry_points = metadata.entry_points()",
				"pytest_entry_points = list(entry_points.select(group='pytest11')) if hasattr(entry_points, 'select') else list(entry_points.get('pytest11', []))",
				"package_map = metadata.packages_distributions()",
				"stdlib_modules = set(getattr(sys, 'stdlib_module_names', ()))",
				"unresolved_modules = sorted(module for module in external_modules if module not in stdlib_modules and not package_map.get(module))",
				"if unresolved_modules: raise RuntimeError('unresolved Python verifier dependencies: ' + ', '.join(unresolved_modules))",
				"distribution_names = {'pytest'}",
				"distribution_modules = {'pytest': {'pytest'}}",
				"for entry_point in pytest_entry_points:",
				"    if entry_point.dist is None: continue",
				"    name = entry_point.dist.metadata.get('Name') or ''",
				"    if not name: continue",
				"    distribution_names.add(name)",
				"    distribution_modules.setdefault(name, set()).add(entry_point.value.split(':', 1)[0].split('.', 1)[0])",
				"for module in external_modules:",
				"    for name in package_map.get(module) or ():",
				"        distribution_names.add(name)",
				"        distribution_modules.setdefault(name, set()).add(module)",
				"distributions = [fingerprint(metadata.distribution(name), distribution_modules.get(name, set())) for name in sorted(distribution_names) if name]",
				"packages = sorted((distribution.metadata.get('Name') or '', distribution.version) for distribution in metadata.distributions())",
				"print(json.dumps({'executable': sys.executable, 'version': sys.version, 'bound_modules': external_modules, 'pytest_distributions': distributions, 'packages': packages}, separators=(',', ':')))",
			].join("\n");
			const metadata = spawnSync(pythonPath, ["-P", "-c", identityScript], {
				cwd: dirname(pythonPath),
				encoding: "utf8",
				env: verificationEnvironment,
				maxBuffer: 8 * 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
			});
			if (metadata.status !== 0 || !metadata.stdout.trim()) {
				unsupportedReasons.push("Python test dependency identity could not be captured");
			} else {
				pythonEnvironment = metadata.stdout.trim();
			}
		}
	}
	const runnerIdentityDigest = createHash("sha256")
		.update(JSON.stringify({ executablePath, runnerSha256, sandboxSha256, pythonEnvironment }))
		.digest("hex");
	const environmentDigest = createHash("sha256")
		.update(
			JSON.stringify({
				cwd: relative(root, resolvedCwd).replaceAll(sep, "/"),
				PATH: verificationEnvironment.PATH ?? "",
				PYTHONPATH: verificationEnvironment.PYTHONPATH ?? "",
				PYTHONHOME: verificationEnvironment.PYTHONHOME ?? "",
				PYTHONHASHSEED: verificationEnvironment.PYTHONHASHSEED ?? "",
				PYTHONNOUSERSITE: verificationEnvironment.PYTHONNOUSERSITE ?? "",
				PYTHONSAFEPATH: verificationEnvironment.PYTHONSAFEPATH ?? "",
				PYTHONDONTWRITEBYTECODE: verificationEnvironment.PYTHONDONTWRITEBYTECODE ?? "",
				VIRTUAL_ENV: verificationEnvironment.VIRTUAL_ENV ?? "",
				COVERAGE_PROCESS_START: verificationEnvironment.COVERAGE_PROCESS_START ?? "",
				PYTEST_ADDOPTS: verificationEnvironment.PYTEST_ADDOPTS ?? "",
				PYTEST_DISABLE_PLUGIN_AUTOLOAD: verificationEnvironment.PYTEST_DISABLE_PLUGIN_AUTOLOAD ?? "",
				PYTEST_PLUGINS: verificationEnvironment.PYTEST_PLUGINS ?? "",
				NODE_PATH: verificationEnvironment.NODE_PATH ?? "",
				NODE_OPTIONS: verificationEnvironment.NODE_OPTIONS ?? "",
			}),
		)
		.digest("hex");
	const supported = unsupportedReasons.length === 0;
	const manifestPayload = {
		policyVersion: 1 as const,
		runnerFamily,
		commandDigest,
		runnerIdentityDigest,
		environmentDigest,
		entries,
		absentControlPaths: [...absentControlPaths].sort(),
		supported,
		unsupportedReasons: [...new Set(unsupportedReasons)].sort(),
	};
	return {
		...manifestPayload,
		digest: createHash("sha256").update(JSON.stringify(manifestPayload)).digest("hex"),
	};
}

export function assessAvoTestTrust(
	cwd: string,
	command: string,
	baseline: AvoVerificationBaseline | undefined,
	_output = "",
): AvoTestTrustAssessment {
	if (!baseline) {
		return {
			trusted: false,
			taskSpecific: false,
			basis: "missing_baseline",
			baselineTestCount: 0,
			unchangedBaselineTestCount: 0,
			explicitBaselineTargets: 0,
			observedBaselineTestFiles: [],
			executionProven: false,
			narrowedSelection: false,
			verificationHarnessSupported: false,
		};
	}
	const normalizedCommand = command.trim().replace(/[ \t]+/g, " ");
	const mutablePackageScript = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i.test(normalizedCommand);
	const verificationHarness = captureAvoVerificationHarnessManifest(cwd, command, baseline);
	if (baseline.userAcceptanceCommands.includes(normalizedCommand)) {
		const trusted = !mutablePackageScript && verificationHarness.supported;
		return {
			trusted,
			taskSpecific: trusted,
			basis: mutablePackageScript
				? "mutable_package_script"
				: verificationHarness.supported
					? "user_acceptance"
					: "unsupported_verification_harness",
			baselineTestCount: baseline.testFiles.length,
			unchangedBaselineTestCount: baseline.testFiles.length,
			explicitBaselineTargets: 0,
			observedBaselineTestFiles: [],
			executionProven: trusted,
			narrowedSelection: false,
			verificationHarness,
			verificationHarnessSupported: verificationHarness.supported,
		};
	}
	const rootOutput = git(cwd, ["rev-parse", "--show-toplevel"]);
	const baselineRoot = baseline.workspaceRoot ? resolve(baseline.workspaceRoot) : undefined;
	const resolvedCwd = resolve(cwd);
	const compatibleBaselineRoot =
		baselineRoot && (resolvedCwd === baselineRoot || resolvedCwd.startsWith(`${baselineRoot}${sep}`))
			? baselineRoot
			: undefined;
	const root = rootOutput?.toString("utf8").trim() || compatibleBaselineRoot || resolvedCwd;
	const unchanged = new Set(
		baseline.testFiles
			.filter((file) => fileSha256(root, file.path) === file.sha256)
			.map((file) => file.path.replaceAll("\\", "/")),
	);
	const explicit = explicitTestTargets(command).flatMap((target) => {
		const absolute = resolve(cwd, target);
		if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return [];
		return [relative(root, absolute).replaceAll(sep, "/")];
	});
	const explicitBaselineTargets = explicit.filter((target) => unchanged.has(target)).length;
	const observedBaselineTestFiles = [...new Set(explicit.filter((target) => unchanged.has(target)))];
	const selectionCommand = command.trim().replace(/^(?:python3?|uv run)\s+-m\s+pytest\b/i, "pytest");
	const narrowedSelection =
		/(?:^|\s)(?:-k|-m|-t|-c|-list|-skip|--config|--dir|--root|--workspace|--grep|--test-name-pattern|--test-skip-pattern|--testNamePattern|--testPathPattern|--testPathIgnorePatterns|--test-path-ignore-patterns|--changed|--related|--deselect|--ignore|--ignore-glob|--exclude|--shard|--splits?|--partition|--project|--last-failed|--lf|--failed-first|--ff|--stepwise|--sw|--globalSetup|--globalTeardown|--import|--loader|--require|--reporter|--setupFiles|--setupFilesAfterEnv|--test-reporter|-run)(?:[=\s]|$)/i.test(
			selectionCommand,
		) || /^cargo test\s+[^-\s][^\s]*/i.test(command.trim());
	const basis =
		explicit.length > 0 ? (explicitBaselineTargets > 0 ? "baseline_target" : "candidate_only") : "baseline_suite";
	const trusted =
		explicitBaselineTargets > 0 && !narrowedSelection && !mutablePackageScript && verificationHarness.supported;
	const executionProven = trusted;
	return {
		trusted,
		taskSpecific: trusted,
		basis: trusted
			? basis
			: mutablePackageScript
				? "mutable_package_script"
				: narrowedSelection
					? "narrowed_selection"
					: !verificationHarness.supported
						? "unsupported_verification_harness"
						: "candidate_only",
		baselineTestCount: baseline.testFiles.length,
		unchangedBaselineTestCount: unchanged.size,
		explicitBaselineTargets,
		observedBaselineTestFiles,
		executionProven,
		narrowedSelection,
		verificationHarness,
		verificationHarnessSupported: verificationHarness.supported,
	};
}

export function captureAvoWorkspaceSnapshot(
	cwd: string,
	options: { excludedRoots?: readonly string[] } = {},
): AvoWorkspaceSnapshot {
	const excludedRoots = options.excludedRoots ?? [];
	return gitSnapshot(cwd, excludedRoots) ?? treeSnapshot(cwd, excludedRoots);
}
