import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { classifyAvoHostEvaluationCommand } from "./evaluator.js";
import type { AvoVerificationBaseline } from "./types.js";

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
	digest: string;
	mode: "git" | "tree";
	head: string;
	changedFileCount: number;
	totalBytes: number;
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
	return { digest: hash.digest("hex"), mode: "git", head, changedFileCount, totalBytes };
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
		digest: hash.digest("hex"),
		mode: "tree",
		head: "NO_GIT_HEAD",
		changedFileCount: files.length,
		totalBytes,
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

export function captureAvoCodingVerificationBaseline(
	cwd: string,
	objective: string,
	options: { excludedRoots?: readonly string[] } = {},
): AvoVerificationBaseline {
	const excludedRoots = options.excludedRoots ?? [];
	const workspace = captureAvoWorkspaceSnapshot(cwd, { excludedRoots });
	const { root, files } = workspaceFiles(cwd, excludedRoots);
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
	const userAcceptanceCommands = userAcceptanceTestCommands(objective);
	const contractDigest = createHash("sha256")
		.update(JSON.stringify({ workspaceDigest: workspace.digest, testFiles, userAcceptanceCommands }))
		.digest("hex");
	return {
		kind: "coding",
		contractDigest,
		workspaceDigest: workspace.digest,
		testFiles,
		userAcceptanceCommands,
		capturedAt: new Date().toISOString(),
	};
}

export interface AvoTestTrustAssessment {
	trusted: boolean;
	taskSpecific: boolean;
	basis: "user_acceptance" | "baseline_target" | "baseline_suite" | "candidate_only" | "missing_baseline";
	baselineTestCount: number;
	unchangedBaselineTestCount: number;
	explicitBaselineTargets: number;
	narrowedSelection: boolean;
}

function explicitTestTargets(command: string): string[] {
	return [
		...command.matchAll(
			/(?:^|\s)(["']?[^\s"']*(?:(?:\.test|\.spec)\.[a-z0-9]+|(?:^|\/)test_[^\s"']+\.py|_test\.(?:py|go|rs)|(?:test|tests)\.(?:java|kt|cs|swift))["']?)(?=\s|$)/gi,
		),
	].map((match) => match[1]!.replace(/^['"]|['"]$/g, ""));
}

export function assessAvoTestTrust(
	cwd: string,
	command: string,
	baseline: AvoVerificationBaseline | undefined,
): AvoTestTrustAssessment {
	if (!baseline) {
		return {
			trusted: false,
			taskSpecific: false,
			basis: "missing_baseline",
			baselineTestCount: 0,
			unchangedBaselineTestCount: 0,
			explicitBaselineTargets: 0,
			narrowedSelection: false,
		};
	}
	const normalizedCommand = command.trim().replace(/[ \t]+/g, " ");
	if (baseline.userAcceptanceCommands.includes(normalizedCommand)) {
		return {
			trusted: true,
			taskSpecific: true,
			basis: "user_acceptance",
			baselineTestCount: baseline.testFiles.length,
			unchangedBaselineTestCount: baseline.testFiles.length,
			explicitBaselineTargets: 0,
			narrowedSelection: false,
		};
	}
	const rootOutput = git(cwd, ["rev-parse", "--show-toplevel"]);
	const root = rootOutput?.toString("utf8").trim() || resolve(cwd);
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
	const narrowedSelection =
		/(?:^|\s)(?:-k|-m|-t|--grep|--test-name-pattern|--test-skip-pattern|--testNamePattern|--testPathPattern|--changed|--related|--deselect|--ignore|-run)(?:[=\s]|$)/i.test(
			command,
		) || /^cargo test\s+[^-\s][^\s]*/i.test(command.trim());
	const basis =
		explicit.length > 0 ? (explicitBaselineTargets > 0 ? "baseline_target" : "candidate_only") : "baseline_suite";
	const trusted = explicit.length > 0 ? explicitBaselineTargets > 0 : unchanged.size > 0 && !narrowedSelection;
	return {
		trusted,
		taskSpecific: trusted,
		basis: trusted ? basis : "candidate_only",
		baselineTestCount: baseline.testFiles.length,
		unchangedBaselineTestCount: unchanged.size,
		explicitBaselineTargets,
		narrowedSelection,
	};
}

export function captureAvoWorkspaceSnapshot(
	cwd: string,
	options: { excludedRoots?: readonly string[] } = {},
): AvoWorkspaceSnapshot {
	const excludedRoots = options.excludedRoots ?? [];
	return gitSnapshot(cwd, excludedRoots) ?? treeSnapshot(cwd, excludedRoots);
}
