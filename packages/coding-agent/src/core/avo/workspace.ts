import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 20_000;
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

export function captureAvoWorkspaceSnapshot(
	cwd: string,
	options: { excludedRoots?: readonly string[] } = {},
): AvoWorkspaceSnapshot {
	const excludedRoots = options.excludedRoots ?? [];
	return gitSnapshot(cwd, excludedRoots) ?? treeSnapshot(cwd, excludedRoots);
}
