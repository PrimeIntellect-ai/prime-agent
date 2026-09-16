import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { PathLike, ReadStream } from "node:fs";
import * as fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	canonicalizeWorkspaceManifest,
	createWorkspaceSnapshot,
	digestWorkspaceManifest,
	type WorkspaceExclusion,
	type WorkspaceSnapshot,
	type WorkspaceSnapshotEntry,
	WorkspaceSnapshotError,
	type WorkspaceSnapshotOptions,
} from "../src/core/cloud/workspace-snapshot.js";

const isWindows = process.platform === "win32";

// The node:fs module namespace is a frozen ESM namespace, so vi.spyOn cannot
// patch it. A vi.mock factory is the supported way to instrument copyFileSync
// for the unstable-capture tests; every other export delegates to the real
// module, so the rest of the suite is unaffected.
const captureHook = vi.hoisted(() => ({
	mode: "off" as "off" | "corruptStaged" | "mutateSourceRehash",
	victimSuffix: null as string | null,
	sourceHashReads: new Map<string, number>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const realCopyFileSync = actual.copyFileSync;
	const realCreateReadStream = actual.createReadStream;
	return {
		...actual,
		copyFileSync: ((source: PathLike, destination: PathLike, mode?: number) => {
			realCopyFileSync(source, destination, mode);
			const sourcePath = typeof source === "string" ? source : source.toString();
			if (
				captureHook.mode === "corruptStaged" &&
				captureHook.victimSuffix !== null &&
				sourcePath.endsWith(captureHook.victimSuffix)
			) {
				// Same length, different bytes in the staged copy: only the
				// post-copy staged re-hash can catch it.
				const staged = actual.readFileSync(destination, "utf8");
				actual.writeFileSync(destination, staged.toUpperCase());
			}
		}) as typeof actual.copyFileSync,
		createReadStream: ((path: PathLike, options?: Parameters<typeof realCreateReadStream>[1]) => {
			const realStream = realCreateReadStream(path, options);
			const pathString = typeof path === "string" ? path : path.toString();
			if (
				captureHook.mode === "mutateSourceRehash" &&
				captureHook.victimSuffix !== null &&
				pathString.endsWith(captureHook.victimSuffix) &&
				!pathString.includes("pi-workspace-snapshot-")
			) {
				const reads = (captureHook.sourceHashReads.get(pathString) ?? 0) + 1;
				captureHook.sourceHashReads.set(pathString, reads);
				if (reads >= 2) {
					// The post-copy source re-hash reads mutated same-length
					// bytes; the on-disk file keeps its exact metadata, so only
					// the re-hash can detect the change.
					const mutated = new PassThrough();
					mutated.end("VICTIM\n");
					return mutated as unknown as ReadStream;
				}
			}
			return realStream;
		}) as typeof actual.createReadStream,
	};
});

let tempRoot = "";
let stagingRoot = "";
const savedEnv: Record<string, string | undefined> = {};
const trackedSnapshots: WorkspaceSnapshot[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(name = "r"): string {
	const repo = fs.mkdtempSync(join(tempRoot, `${name}-`));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "snapshot-test@example.com");
	git(repo, "config", "user.name", "Snapshot Test");
	return repo;
}

function writeRepoFile(repo: string, relPath: string, content: string, mode?: number): string {
	const absPath = join(repo, ...relPath.split("/"));
	fs.mkdirSync(dirname(absPath), { recursive: true });
	fs.writeFileSync(absPath, content);
	if (mode !== undefined) {
		fs.chmodSync(absPath, mode);
	}
	return absPath;
}

function commitAll(repo: string, message: string): void {
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", message);
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

async function snapshot(repo: string, options: WorkspaceSnapshotOptions = {}): Promise<WorkspaceSnapshot> {
	const snap = await createWorkspaceSnapshot(repo, { stagingRoot, ...options });
	trackedSnapshots.push(snap);
	return snap;
}

function asSnapshotError(error: unknown): WorkspaceSnapshotError {
	expect(error).toBeInstanceOf(WorkspaceSnapshotError);
	if (!(error instanceof WorkspaceSnapshotError)) {
		throw new Error("expected a WorkspaceSnapshotError");
	}
	return error;
}

async function snapshotError(repo: string, options?: WorkspaceSnapshotOptions): Promise<WorkspaceSnapshotError> {
	try {
		const snap = await snapshot(repo, options);
		snap.cleanup();
	} catch (error) {
		return asSnapshotError(error);
	}
	throw new Error("expected createWorkspaceSnapshot to reject");
}

function walk(root: string): string[] {
	const paths: string[] = [];
	const visit = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const absPath = join(dir, entry.name);
			paths.push(absPath);
			if (entry.isDirectory()) {
				visit(absPath);
			}
		}
	};
	visit(root);
	return paths;
}

function stagingRelativePaths(snap: WorkspaceSnapshot): string[] {
	return walk(snap.stagingDir).map((absPath) => absPath.slice(snap.stagingDir.length + 1));
}

function exclusionFor(snap: WorkspaceSnapshot, path: string): WorkspaceExclusion | undefined {
	return snap.exclusions.find((exclusion) => exclusion.path === path);
}

function requireEntry(snap: WorkspaceSnapshot, path: string): WorkspaceSnapshotEntry {
	const entry = snap.manifest.entries.find((candidate) => candidate.path === path);
	expect(entry, `manifest entry for ${path}`).toBeDefined();
	return entry as WorkspaceSnapshotEntry;
}

function stagedWorkspacePath(snap: WorkspaceSnapshot, relPath: string): string {
	return join(snap.stagingDir, "workspace", ...relPath.split("/"));
}

function stagingRootEntries(): string[] {
	return fs.readdirSync(stagingRoot).sort();
}

beforeAll(() => {
	tempRoot = fs.mkdtempSync(join(tmpdir(), "pi-ws-test-"));
	stagingRoot = join(tempRoot, "staging");
	fs.mkdirSync(stagingRoot, { recursive: true });
	const xdgHome = join(tempRoot, "xdg");
	fs.mkdirSync(xdgHome, { recursive: true });
	const emptyGitConfig = join(tempRoot, "empty-gitconfig");
	fs.writeFileSync(emptyGitConfig, "");
	// Isolate every git invocation (test helpers and module spawns alike) from
	// host git config and global ignore files.
	for (const [key, value] of Object.entries({
		GIT_CONFIG_GLOBAL: emptyGitConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		XDG_CONFIG_HOME: xdgHome,
	})) {
		savedEnv[key] = process.env[key];
		process.env[key] = value;
	}
});

afterAll(() => {
	for (const snap of trackedSnapshots) {
		snap.cleanup();
	}
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("createWorkspaceSnapshot", () => {
	describe("manifest, staging, and provenance", () => {
		it("captures tracked and non-ignored untracked files with SHA-256, modes, and provenance", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, ".gitignore", "ignored.log\n");
			writeRepoFile(repo, "a.txt", "hello\n");
			writeRepoFile(repo, "nested/dir/b.txt", "deep\n");
			commitAll(repo, "init");
			writeRepoFile(repo, "untracked.txt", "world\n");
			writeRepoFile(repo, "ignored.log", "noise\n");

			const snap = await snapshot(repo);

			expect(snap.repoRoot).toBe(fs.realpathSync(repo));
			expect(snap.headCommit).toBe(git(repo, "rev-parse", "HEAD"));
			expect(snap.manifest.version).toBe(1);
			expect(snap.manifest.deletedPaths).toEqual([]);
			expect(snap.manifest.entries.map((entry) => entry.path)).toEqual([
				".gitignore",
				"a.txt",
				"nested/dir/b.txt",
				"untracked.txt",
			]);

			const aEntry = requireEntry(snap, "a.txt");
			expect(aEntry.kind).toBe("file");
			expect(aEntry.mode).toBe("100644");
			expect(aEntry.executable).toBe(false);
			expect(aEntry.size).toBe(6);
			expect(aEntry.sha256).toBe(sha256("hello\n"));
			expect(aEntry.tracked).toBe(true);

			const untrackedEntry = requireEntry(snap, "untracked.txt");
			expect(untrackedEntry.tracked).toBe(false);
			expect(untrackedEntry.sha256).toBe(sha256("world\n"));

			expect(snap.fileCount).toBe(4);
			expect(snap.totalSizeBytes).toBe(snap.manifest.entries.reduce((total, entry) => total + entry.size, 0));
			expect(snap.exclusions).toEqual([]);
			expect(snap.manifestDigest).toBe(digestWorkspaceManifest(snap.manifest));

			const stagedPaths = stagingRelativePaths(snap).sort();
			expect(stagedPaths).toEqual([
				"workspace",
				"workspace-manifest.json",
				"workspace/.gitignore",
				"workspace/a.txt",
				"workspace/nested",
				"workspace/nested/dir",
				"workspace/nested/dir/b.txt",
				"workspace/untracked.txt",
			]);
			expect(fs.readFileSync(stagedWorkspacePath(snap, "a.txt"), "utf8")).toBe("hello\n");

			const stagedManifestFile = JSON.parse(
				fs.readFileSync(join(snap.stagingDir, "workspace-manifest.json"), "utf8"),
			);
			expect(stagedManifestFile.manifest).toEqual(snap.manifest);
			expect(stagedManifestFile.provenance).toEqual({
				repoRoot: snap.repoRoot,
				headCommit: snap.headCommit,
				manifestDigest: snap.manifestDigest,
			});
		});

		it("does not let a repository file named workspace-manifest.json collide with the metadata", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "keep.txt", "keep\n");
			writeRepoFile(repo, "workspace-manifest.json", '{"fake":true}\n');
			commitAll(repo, "init");

			const snap = await snapshot(repo);
			const manifestPath = join(snap.stagingDir, "workspace-manifest.json");
			expect(fs.existsSync(manifestPath)).toBe(true);
			expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).manifest.version).toBe(1);
			expect(fs.readFileSync(stagedWorkspacePath(snap, "workspace-manifest.json"), "utf8")).toBe('{"fake":true}\n');
			expect(requireEntry(snap, "workspace-manifest.json").sha256).toBe(sha256('{"fake":true}\n'));
		});

		it("captures staged and unstaged bytes from the working tree, not from HEAD", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "base.txt", "one\n");
			commitAll(repo, "init");
			const headCommit = git(repo, "rev-parse", "HEAD");
			writeRepoFile(repo, "base.txt", "two\n");

			const unstaged = await snapshot(repo);
			expect(requireEntry(unstaged, "base.txt").sha256).toBe(sha256("two\n"));
			expect(unstaged.headCommit).toBe(headCommit);

			git(repo, "add", "base.txt");
			const staged = await snapshot(repo);
			expect(requireEntry(staged, "base.txt").sha256).toBe(sha256("two\n"));
			expect(staged.headCommit).toBe(headCommit);
			// Staging does not change the bytes, so the manifest digest is identical.
			expect(staged.manifestDigest).toBe(unstaged.manifestDigest);

			writeRepoFile(repo, "new.txt", "new\n");
			git(repo, "add", "new.txt");
			const stagedNew = await snapshot(repo);
			expect(requireEntry(stagedNew, "new.txt").tracked).toBe(true);
			expect(requireEntry(stagedNew, "new.txt").sha256).toBe(sha256("new\n"));

			git(repo, "commit", "-q", "-m", "second");
			const committed = await snapshot(repo);
			expect(committed.headCommit).not.toBe(headCommit);
			expect(requireEntry(committed, "base.txt").sha256).toBe(sha256("two\n"));

			git(repo, "rm", "-q", "new.txt");
			const removed = await snapshot(repo);
			expect(removed.manifest.entries.map((entry) => entry.path)).not.toContain("new.txt");
			expect(removed.manifest.deletedPaths).toContain("new.txt");
			expect(fs.existsSync(stagedWorkspacePath(removed, "new.txt"))).toBe(false);
		});

		it("records staged and unstaged deletions in the manifest", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "keep.txt", "keep\n");
			writeRepoFile(repo, "doomed.txt", "doomed\n");
			writeRepoFile(repo, "staged-delete.txt", "staged\n");
			writeRepoFile(repo, ".env", "TOKEN=x\n");
			commitAll(repo, "init");

			fs.rmSync(join(repo, "doomed.txt"));
			fs.rmSync(join(repo, ".env"));
			git(repo, "rm", "-q", "staged-delete.txt");

			const snap = await snapshot(repo);
			expect(snap.manifest.deletedPaths).toEqual(["doomed.txt", "staged-delete.txt"]);
			expect(snap.manifest.entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
			// A deleted credential file is not revealed by name either.
			expect(snap.manifest.deletedPaths).not.toContain(".env");
		});

		it("records the old path as deleted for staged and unstaged renames", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "old.txt", "renamed content\n");
			writeRepoFile(repo, "keep.txt", "keep\n");
			commitAll(repo, "init");

			// Unstaged rename: a plain move on disk.
			fs.renameSync(join(repo, "old.txt"), join(repo, "new.txt"));
			const unstaged = await snapshot(repo);
			expect(unstaged.manifest.deletedPaths).toEqual(["old.txt"]);
			expect(unstaged.manifest.entries.map((entry) => entry.path)).toEqual(["keep.txt", "new.txt"]);
			expect(requireEntry(unstaged, "new.txt").sha256).toBe(sha256("renamed content\n"));
			expect(requireEntry(unstaged, "new.txt").tracked).toBe(false);

			// Staged rename: git rename detection must not hide the old path.
			git(repo, "add", "-A");
			const staged = await snapshot(repo);
			expect(staged.manifest.deletedPaths).toEqual(["old.txt"]);
			expect(staged.manifest.entries.map((entry) => entry.path)).toEqual(["keep.txt", "new.txt"]);
			expect(requireEntry(staged, "new.txt").tracked).toBe(true);
		});

		it("respects .gitignore for untracked files", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, ".gitignore", "*.log\nbuild/\n");
			writeRepoFile(repo, "keep.txt", "keep\n");
			commitAll(repo, "init");
			writeRepoFile(repo, "debug.log", "log\n");
			fs.mkdirSync(join(repo, "build"));
			fs.writeFileSync(join(repo, "build", "out.js"), "out\n");

			const snap = await snapshot(repo);
			expect(snap.manifest.entries.map((entry) => entry.path)).toEqual([".gitignore", "keep.txt"]);
			expect(stagingRelativePaths(snap)).not.toContain("workspace/build/out.js");
			expect(stagingRelativePaths(snap)).not.toContain("workspace/debug.log");
		});

		it("produces a deterministic manifest and digest", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "z.txt", "z\n");
			writeRepoFile(repo, "a/b.txt", "b\n");
			writeRepoFile(repo, "a/c.txt", "c\n");
			commitAll(repo, "init");

			const first = await snapshot(repo);
			const second = await snapshot(repo);
			expect(second.manifest).toEqual(first.manifest);
			expect(second.manifestDigest).toBe(first.manifestDigest);

			const canonical = canonicalizeWorkspaceManifest(first.manifest);
			expect(canonical.startsWith('{"version":1,"entries":[')).toBe(true);
			expect(JSON.parse(canonical)).toEqual(JSON.parse(canonicalizeWorkspaceManifest(second.manifest)));
			// Digest depends on content, not on the caller's key insertion order.
			const scrambled = first.manifest.entries.map((entry) => {
				const rebuilt: Record<string, unknown> = {
					tracked: entry.tracked,
					sha256: entry.sha256,
					size: entry.size,
					executable: entry.executable,
					mode: entry.mode,
					kind: entry.kind,
					path: entry.path,
				};
				if (entry.target !== undefined) {
					rebuilt.target = entry.target;
				}
				return rebuilt as unknown as WorkspaceSnapshotEntry;
			});
			expect(
				digestWorkspaceManifest({
					version: 1,
					entries: scrambled,
					deletedPaths: [...first.manifest.deletedPaths].reverse(),
				}),
			).toBe(first.manifestDigest);

			writeRepoFile(repo, "a/c.txt", "changed\n");
			const third = await snapshot(repo);
			expect(third.manifestDigest).not.toBe(first.manifestDigest);
		});

		it("handles an empty repository and an unborn HEAD", async () => {
			const repo = makeRepo();
			const empty = await snapshot(repo);
			expect(empty.headCommit).toBeNull();
			expect(empty.manifest.entries).toEqual([]);
			expect(empty.manifest.deletedPaths).toEqual([]);
			expect(empty.manifestDigest).toBe(digestWorkspaceManifest({ version: 1, entries: [], deletedPaths: [] }));
			expect(stagingRelativePaths(empty)).toEqual(["workspace-manifest.json"]);

			writeRepoFile(repo, "untracked.txt", "u\n");
			const untracked = await snapshot(repo);
			expect(untracked.headCommit).toBeNull();
			expect(untracked.manifest.entries.map((entry) => entry.path)).toEqual(["untracked.txt"]);
		});

		it("supports linked worktrees without leaking the worktree pointer file", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "a.txt", "main\n");
			commitAll(repo, "init");
			const worktreePath = join(tempRoot, "wt");
			git(repo, "worktree", "add", "-b", "wt-branch", worktreePath);
			writeRepoFile(worktreePath, "a.txt", "worktree\n");
			writeRepoFile(worktreePath, "wt-only.txt", "wt\n");

			const snap = await snapshot(worktreePath);
			expect(snap.repoRoot).toBe(fs.realpathSync(worktreePath));
			expect(snap.headCommit).toBe(git(worktreePath, "rev-parse", "HEAD"));
			expect(snap.manifest.entries.map((entry) => entry.path)).toEqual(["a.txt", "wt-only.txt"]);
			expect(requireEntry(snap, "a.txt").sha256).toBe(sha256("worktree\n"));
			expect(requireEntry(snap, "wt-only.txt").tracked).toBe(false);

			const stagedNames = walk(snap.stagingDir).map((absPath) => absPath.slice(snap.stagingDir.length + 1));
			expect(stagedNames).not.toContain(".git");
			expect(fs.readFileSync(stagedWorkspacePath(snap, "a.txt"), "utf8")).toBe("worktree\n");
		});
	});

	describe("symlinks", () => {
		it.skipIf(isWindows)("captures symlinks whose targets stay inside the repository", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "internal.txt", "inner\n");
			commitAll(repo, "init");
			fs.symlinkSync("internal.txt", join(repo, "link-internal"));
			fs.symlinkSync("missing.txt", join(repo, "link-dangling"));

			const snap = await snapshot(repo);

			const linkEntry = requireEntry(snap, "link-internal");
			expect(linkEntry.kind).toBe("symlink");
			expect(linkEntry.mode).toBe("120000");
			expect(linkEntry.executable).toBe(false);
			expect(linkEntry.target).toBe("internal.txt");
			expect(linkEntry.size).toBe(Buffer.byteLength("internal.txt", "utf8"));
			expect(linkEntry.sha256).toBe(sha256("internal.txt"));
			expect(linkEntry.tracked).toBe(false);

			const danglingEntry = requireEntry(snap, "link-dangling");
			expect(danglingEntry.kind).toBe("symlink");
			expect(danglingEntry.target).toBe("missing.txt");

			const stagedLink = stagedWorkspacePath(snap, "link-internal");
			expect(fs.lstatSync(stagedLink).isSymbolicLink()).toBe(true);
			expect(fs.readlinkSync(stagedLink)).toBe("internal.txt");
			expect(fs.readFileSync(stagedLink, "utf8")).toBe("inner\n");
		});

		it.skipIf(isWindows)("excludes symlinks whose targets escape the repository", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "keep.txt", "keep\n");
			commitAll(repo, "init");
			fs.writeFileSync(join(tempRoot, "outside.txt"), "secret\n");
			fs.symlinkSync("../outside.txt", join(repo, "link-relative-outside"));
			fs.mkdirSync(join(repo, "sub"));
			fs.symlinkSync("../../outside.txt", join(repo, "sub", "link-escape"));

			const snap = await snapshot(repo);
			expect(snap.manifest.entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
			expect(exclusionFor(snap, "link-relative-outside")?.reason).toBe("symlink-target-outside-repo");
			expect(exclusionFor(snap, "sub/link-escape")?.reason).toBe("symlink-target-outside-repo");
			expect(stagingRelativePaths(snap)).not.toContain("workspace/link-relative-outside");
		});

		it.skipIf(isWindows)("rejects absolute symlink targets even when they point inside the repository", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "internal.txt", "inner\n");
			commitAll(repo, "init");
			fs.symlinkSync(join(repo, "internal.txt"), join(repo, "link-abs-inside"));
			fs.symlinkSync(join(tempRoot, "outside.txt"), join(repo, "link-abs-outside"));

			const snap = await snapshot(repo);
			expect(snap.manifest.entries.map((entry) => entry.path)).toEqual(["internal.txt"]);
			expect(exclusionFor(snap, "link-abs-inside")?.reason).toBe("symlink-absolute-target");
			expect(exclusionFor(snap, "link-abs-outside")?.reason).toBe("symlink-absolute-target");
		});
	});

	describe("regular files only", () => {
		it.skipIf(isWindows)("skips sockets, devices, and FIFOs", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "fifo.txt", "fifo\n");
			writeRepoFile(repo, "sock.txt", "sock\n");
			writeRepoFile(repo, "keep.txt", "keep\n");
			commitAll(repo, "init");

			fs.rmSync(join(repo, "fifo.txt"));
			execFileSync("mkfifo", [join(repo, "fifo.txt")]);

			fs.rmSync(join(repo, "sock.txt"));
			const server = net.createServer(() => {});
			await new Promise<void>((resolvePromise) => {
				server.listen(join(repo, "sock.txt"), () => resolvePromise());
			});
			try {
				const snap = await snapshot(repo);
				expect(snap.manifest.entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
				expect(exclusionFor(snap, "fifo.txt")?.reason).toBe("irregular-file");
				expect(exclusionFor(snap, "sock.txt")?.reason).toBe("irregular-file");
				expect(stagingRelativePaths(snap)).not.toContain("workspace/fifo.txt");
				expect(stagingRelativePaths(snap)).not.toContain("workspace/sock.txt");
			} finally {
				await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
				fs.rmSync(join(repo, "sock.txt"), { force: true });
			}
		});
	});

	describe("symlinked parent directories", () => {
		it.skipIf(isWindows)(
			"rejects tracked paths whose parent directory is a symlink outside the repository",
			async () => {
				const repo = makeRepo();
				writeRepoFile(repo, "keep.txt", "keep\n");
				writeRepoFile(repo, "linkdir/file.txt", "tracked\n");
				commitAll(repo, "init");

				const outsideDir = fs.mkdtempSync(join(tempRoot, "outside-"));
				const hostBytes = "host secret bytes\n";
				fs.writeFileSync(join(outsideDir, "file.txt"), hostBytes);
				// Replace the tracked parent directory with a symlink to the
				// outside directory, so "linkdir/file.txt" now names host bytes.
				fs.rmSync(join(repo, "linkdir"), { recursive: true });
				fs.symlinkSync(outsideDir, join(repo, "linkdir"));

				const snap = await snapshot(repo);
				expect(snap.manifest.entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
				expect(exclusionFor(snap, "linkdir/file.txt")?.reason).toBe("symlinked-parent");
				// Git itself does not descend into a directory that became a
				// symlink, so the tracked child counts as deleted for HEAD
				// reconstruction; the host bytes are never captured.
				expect(snap.manifest.deletedPaths).toEqual(["linkdir/file.txt"]);
				for (const absPath of walk(snap.stagingDir)) {
					if (fs.statSync(absPath).isFile()) {
						expect(fs.readFileSync(absPath, "utf8")).not.toContain("host secret bytes");
					}
				}
			},
		);

		it.skipIf(isWindows)(
			"rejects regular files beneath a parent-directory symlink that resolves inside the repository",
			async () => {
				const repo = makeRepo();
				writeRepoFile(repo, "insidelink/inner.txt", "placeholder\n");
				commitAll(repo, "init");
				// Replace the real directory with a symlink to another in-repo
				// directory holding different bytes.
				writeRepoFile(repo, "realdir/inner.txt", "inner\n");
				fs.rmSync(join(repo, "insidelink"), { recursive: true });
				fs.symlinkSync("realdir", join(repo, "insidelink"));

				const snap = await snapshot(repo);
				// Intermediate symlinks are never traversed, so the tracked child
				// is excluded even though the parent resolves inside the repo.
				expect(snap.manifest.entries.map((entry) => entry.path)).toEqual(["insidelink", "realdir/inner.txt"]);
				const linkEntry = requireEntry(snap, "insidelink");
				expect(linkEntry.kind).toBe("symlink");
				expect(linkEntry.target).toBe("realdir");
				expect(exclusionFor(snap, "insidelink/inner.txt")?.reason).toBe("symlinked-parent");
				expect(stagingRelativePaths(snap)).not.toContain("workspace/insidelink/inner.txt");
				// The in-repo target bytes are captured at their own path, while
				// the tracked child counts as deleted for HEAD reconstruction.
				expect(fs.readFileSync(stagedWorkspacePath(snap, "realdir/inner.txt"), "utf8")).toBe("inner\n");
				expect(snap.manifest.deletedPaths).toEqual(["insidelink/inner.txt"]);
			},
		);
	});

	describe("executable bit", () => {
		it("records and preserves the executable bit", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "run.sh", "echo run\n", 0o755);
			writeRepoFile(repo, "plain.txt", "plain\n", 0o644);
			commitAll(repo, "init");

			const snap = await snapshot(repo);
			const runEntry = requireEntry(snap, "run.sh");
			expect(runEntry.mode).toBe("100755");
			expect(runEntry.executable).toBe(true);
			const plainEntry = requireEntry(snap, "plain.txt");
			expect(plainEntry.mode).toBe("100644");
			expect(plainEntry.executable).toBe(false);

			const stagedMode = fs.lstatSync(stagedWorkspacePath(snap, "run.sh")).mode;
			expect(stagedMode & 0o111).not.toBe(0);
			expect(stagedMode & 0o777).toBe(0o755);
		});
	});

	describe("limits", () => {
		it("fails when the file count limit is exceeded", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "a.txt", "a\n");
			writeRepoFile(repo, "b.txt", "b\n");
			writeRepoFile(repo, "c.txt", "c\n");
			commitAll(repo, "init");

			const before = stagingRootEntries();
			const error = await snapshotError(repo, { limits: { maxFileCount: 2 } });
			expect(error.code).toBe("limit-exceeded");
			expect(error.message).toContain("file count limit exceeded");
			expect(error.message).toContain("c.txt");
			expect(stagingRootEntries()).toEqual(before);
		});

		it("fails when a single file exceeds the size limit", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "big.txt", "x".repeat(100));
			commitAll(repo, "init");

			const before = stagingRootEntries();
			const error = await snapshotError(repo, { limits: { maxFileSizeBytes: 50 } });
			expect(error.code).toBe("limit-exceeded");
			expect(error.message).toContain("file size limit exceeded");
			expect(error.message).toContain("big.txt");
			expect(stagingRootEntries()).toEqual(before);
		});

		it("fails when the total size limit is exceeded", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "a.txt", "x".repeat(60));
			writeRepoFile(repo, "b.txt", "y".repeat(60));
			commitAll(repo, "init");

			const before = stagingRootEntries();
			const error = await snapshotError(repo, { limits: { maxTotalSizeBytes: 100 } });
			expect(error.code).toBe("limit-exceeded");
			expect(error.message).toContain("total size limit exceeded");
			expect(stagingRootEntries()).toEqual(before);
		});

		it.skipIf(isWindows)("counts symlinks toward the file count limit", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "keep.txt", "keep\n");
			fs.symlinkSync("keep.txt", join(repo, "link.txt"));
			commitAll(repo, "init");

			const before = stagingRootEntries();
			const error = await snapshotError(repo, { limits: { maxFileCount: 1 } });
			expect(error.code).toBe("limit-exceeded");
			expect(error.message).toContain("link.txt");
			expect(stagingRootEntries()).toEqual(before);
		});

		it.skipIf(isWindows)("enforces the per-file size limit on symlink target bytes", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "keep.txt", "keep\n");
			commitAll(repo, "init");
			fs.symlinkSync(`missing-${"x".repeat(64)}.txt`, join(repo, "long-link"));

			const before = stagingRootEntries();
			const error = await snapshotError(repo, { limits: { maxFileSizeBytes: 16 } });
			expect(error.code).toBe("limit-exceeded");
			expect(error.message).toContain("symlink target");
			expect(error.message).toContain("long-link");
			expect(stagingRootEntries()).toEqual(before);
		});
	});

	describe("policy exclusions", () => {
		it("excludes .git, node_modules, venvs, and nested repositories", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "keep.txt", "keep\n");
			writeRepoFile(repo, "node_modules/pkg/index.js", "module.exports = 1;\n");
			writeRepoFile(repo, ".venv/lib.py", "venv = True\n");
			writeRepoFile(repo, "venv/x.py", "venv = True\n");
			writeRepoFile(repo, "src/node_modules/vendor.js", "vendored\n");
			commitAll(repo, "init");
			fs.mkdirSync(join(repo, "nested"));
			git(repo, "init", "-q", "nested");

			const snap = await snapshot(repo);
			expect(snap.manifest.entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
			expect(exclusionFor(snap, "node_modules")?.reason).toBe("excluded-directory");
			expect(exclusionFor(snap, "node_modules")?.detail).toBe("node_modules");
			expect(exclusionFor(snap, ".venv")?.reason).toBe("excluded-directory");
			expect(exclusionFor(snap, "venv")?.reason).toBe("excluded-directory");
			expect(exclusionFor(snap, "src/node_modules")?.reason).toBe("excluded-directory");
			expect(exclusionFor(snap, "nested")?.reason).toBe("directory");
			for (const path of stagingRelativePaths(snap)) {
				expect(path.split("/")).not.toContain(".git");
			}
		});

		it("excludes credential and key filenames case-insensitively", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "keep.txt", "keep\n");
			writeRepoFile(repo, ".env", "TOKEN=1\n");
			writeRepoFile(repo, "id_rsa", "PRIVATE\n");
			writeRepoFile(repo, "cert.pem", "cert\n");
			commitAll(repo, "init");
			writeRepoFile(repo, ".env.local", "TOKEN=2\n");
			writeRepoFile(repo, "deploy.key", "key\n");
			writeRepoFile(repo, "src/.env", "TOKEN=3\n");
			writeRepoFile(repo, "UPPER.PEM", "cert\n");

			const snap = await snapshot(repo);
			expect(snap.manifest.entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
			expect(exclusionFor(snap, ".env")?.reason).toBe("credential-or-key-file");
			expect(exclusionFor(snap, "id_rsa")?.reason).toBe("credential-or-key-file");
			expect(exclusionFor(snap, "cert.pem")?.reason).toBe("credential-or-key-file");
			expect(exclusionFor(snap, ".env.local")?.reason).toBe("credential-or-key-file");
			expect(exclusionFor(snap, "deploy.key")?.reason).toBe("credential-or-key-file");
			expect(exclusionFor(snap, "src/.env")?.reason).toBe("credential-or-key-file");
			expect(exclusionFor(snap, "UPPER.PEM")?.reason).toBe("credential-or-key-file");
		});

		it("supports additional directory and credential patterns", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "keep.txt", "keep\n");
			writeRepoFile(repo, "build/out.js", "out\n");
			writeRepoFile(repo, "local.secret", "secret\n");
			commitAll(repo, "init");

			const snap = await snapshot(repo, {
				additionalExcludedDirNames: ["build"],
				additionalCredentialFileNamePatterns: ["*.secret"],
			});
			expect(snap.manifest.entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
			expect(exclusionFor(snap, "build")?.detail).toBe("build");
			expect(exclusionFor(snap, "local.secret")?.detail).toBe("*.secret");
		});

		it("never copies host git config, credentials, or hooks into staging", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "keep.txt", "keep\n");
			commitAll(repo, "init");
			fs.writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n# HOST-HOOK-SECRET do not leak\n");
			git(repo, "config", "credential.helper", "store");

			const snap = await snapshot(repo);
			const stagedFiles = walk(snap.stagingDir);
			expect(stagedFiles).not.toContain(join(snap.stagingDir, "workspace", "keep.txt", ".git"));
			for (const absPath of stagedFiles) {
				expect(absPath).not.toContain("HOST-HOOK-SECRET");
				expect(absPath).not.toContain("hooks");
				if (fs.statSync(absPath).isFile()) {
					expect(fs.readFileSync(absPath, "utf8")).not.toContain("helper = store");
				}
			}
			expect(fs.readFileSync(stagedWorkspacePath(snap, "keep.txt"), "utf8")).toBe("keep\n");
		});
	});

	describe("failures and cleanup", () => {
		it("rejects for a path that is not a git repository", async () => {
			const plain = fs.mkdtempSync(join(tempRoot, "plain-"));
			const before = stagingRootEntries();
			const error = await snapshotError(plain);
			expect(error.code).toBe("not-a-git-repository");
			expect(stagingRootEntries()).toEqual(before);
		});

		it("rejects for a missing workspace path", async () => {
			const error = await snapshotError(join(tempRoot, "does-not-exist"));
			expect(error.code).toBe("invalid-cwd");
		});

		it("fails git commands whose output exceeds the configured cap", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "a.txt", "a\n");
			commitAll(repo, "init");

			const before = stagingRootEntries();
			const error = await snapshotError(repo, { gitOutputCapBytes: 8 });
			expect(error.code).toBe("git-command-failed");
			expect(stagingRootEntries()).toEqual(before);
		});

		it("rejects invalid limit and timeout options", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "a.txt", "a\n");
			commitAll(repo, "init");

			for (const limits of [
				{ maxFileCount: 0 },
				{ maxFileCount: -1 },
				{ maxFileCount: 1.5 },
				{ maxFileSizeBytes: 0 },
				{ maxFileSizeBytes: Number.POSITIVE_INFINITY },
				{ maxTotalSizeBytes: Number.NaN },
			]) {
				const error = await snapshotError(repo, { limits });
				expect(error.code).toBe("invalid-options");
				expect(error.message).toContain("must be a positive integer");
			}
			for (const gitTimeoutMs of [0, -5, 2.5]) {
				const error = await snapshotError(repo, { gitTimeoutMs });
				expect(error.code).toBe("invalid-options");
				expect(error.message).toContain("gitTimeoutMs");
			}
			const capError = await snapshotError(repo, { gitOutputCapBytes: 0 });
			expect(capError.code).toBe("invalid-options");
			expect(capError.message).toContain("gitOutputCapBytes");
			const valid = await snapshot(repo, { limits: { maxFileCount: 5 }, gitTimeoutMs: 10_000 });
			expect(valid.fileCount).toBe(1);
		});

		it("rejects when already aborted and leaves no staging directory", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "a.txt", "a\n");
			commitAll(repo, "init");
			const controller = new AbortController();
			controller.abort();

			const before = stagingRootEntries();
			const error = await snapshotError(repo, { signal: controller.signal });
			expect(error.code).toBe("aborted");
			expect(stagingRootEntries()).toEqual(before);
		});

		it("rejects a staging root inside the repository", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "a.txt", "a\n");
			commitAll(repo, "init");

			const error = await snapshotError(repo, { stagingRoot: join(repo, "staging") });
			expect(error.code).toBe("staging-error");
			expect(error.message).toContain("outside the repository");
			expect(fs.existsSync(join(repo, "staging"))).toBe(false);
		});

		it("cleans up the staging directory on demand and is idempotent", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "a.txt", "a\n");
			commitAll(repo, "init");

			const snap = await snapshot(repo, { stagingRoot: undefined });
			expect(snap.stagingDir.startsWith(fs.realpathSync(tmpdir()))).toBe(true);
			expect(snap.stagingDir).toContain("pi-workspace-snapshot-");
			expect(fs.existsSync(snap.stagingDir)).toBe(true);

			snap.cleanup();
			expect(fs.existsSync(snap.stagingDir)).toBe(false);
			expect(() => snap.cleanup()).not.toThrow();
		});
	});

	describe("unstable capture detection", () => {
		it("rejects when the staged copy hash does not match the manifest", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "victim.txt", "victim-content\n");
			writeRepoFile(repo, "other.txt", "other\n");
			commitAll(repo, "init");

			captureHook.mode = "corruptStaged";
			captureHook.victimSuffix = "victim.txt";
			try {
				const before = stagingRootEntries();
				const error = await snapshotError(repo);
				expect(error.code).toBe("unstable-capture");
				expect(error.message).toContain("staged copy hash mismatch");
				expect(error.message).toContain("victim.txt");
				expect(stagingRootEntries()).toEqual(before);
			} finally {
				captureHook.mode = "off";
				captureHook.victimSuffix = null;
			}
		});

		it("rejects when the source hash changes between hashing and verification", async () => {
			const repo = makeRepo();
			writeRepoFile(repo, "victim.txt", "victim\n");
			writeRepoFile(repo, "other.txt", "other\n");
			commitAll(repo, "init");

			captureHook.mode = "mutateSourceRehash";
			captureHook.victimSuffix = "victim.txt";
			try {
				const before = stagingRootEntries();
				const error = await snapshotError(repo);
				expect(error.code).toBe("unstable-capture");
				expect(error.message).toContain("source hash changed during capture");
				expect(error.message).toContain("victim.txt");
				expect(stagingRootEntries()).toEqual(before);
			} finally {
				captureHook.mode = "off";
				captureHook.victimSuffix = null;
				captureHook.sourceHashReads.clear();
			}
		});
	});
});
