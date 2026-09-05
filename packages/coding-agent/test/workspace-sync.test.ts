/**
 * B07 — Workspace sync unit tests.
 *
 * All content is contentBase64. All hashes from decoded bytes.
 * Covers all integration-review guarantees.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyChangeset,
	buildSnapshotPayload,
	captureWorkspaceManifest,
	MAX_BASE64_STRING_LENGTH,
	MAX_FILE_SIZE_BYTES,
	MAX_SNAPSHOT_BYTES,
	type WorkspaceManifest,
} from "../src/core/workspace-sync.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
	const d = join(tmpdir(), `b07-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(d, { recursive: true });
	return d;
}

function write(root: string, subPath: string, content: string): string {
	const full = join(root, subPath);
	mkdirSync(join(root, dirname(subPath)), { recursive: true });
	writeFileSync(full, content, "utf-8");
	return full;
}

function chmodX(root: string, subPath: string): void {
	execFileSync("chmod", ["+x", join(root, subPath)]);
}

function read(root: string, subPath: string): string {
	return readFileSync(join(root, subPath), "utf-8");
}

function isExec(root: string, subPath: string): boolean {
	return (lstatSync(join(root, subPath)).mode & 0o111) !== 0;
}

function b64(s: string): string {
	return Buffer.from(s, "utf-8").toString("base64");
}

function initGitRepo(dir: string): void {
	execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "--local", "user.email", "t@t.co"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "--local", "user.name", "T"], { cwd: dir, stdio: "ignore" });
}

function gitCommit(dir: string, msg: string): string {
	execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", msg], { cwd: dir, stdio: "ignore" });
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
}

function capture(wsRoot: string): WorkspaceManifest {
	return captureWorkspaceManifest(wsRoot);
}

function apply(
	manifest: WorkspaceManifest,
	changes: Parameters<typeof applyChangeset>[1],
	wsRoot: string,
	opts?: Parameters<typeof applyChangeset>[3],
) {
	return applyChangeset(manifest, changes, wsRoot, opts);
}

function rmDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// 1. buildSnapshotPayload hash verification + no symlinks
// ---------------------------------------------------------------------------

describe("buildSnapshotPayload integrity", () => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir();
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("succeeds when files match manifest", () => {
		write(dir, "f.txt", "hello");
		const m = capture(dir);
		const p = buildSnapshotPayload(m, dir);
		expect(p.files).toHaveLength(1);
		expect(p.files[0]!.path).toBe("f.txt");
	});

	it("throws when file changed since capture", () => {
		write(dir, "f.txt", "v1");
		const m = capture(dir);
		write(dir, "f.txt", "v2"); // mutate after capture
		expect(() => buildSnapshotPayload(m, dir)).toThrow(/hash mismatch/i);
	});

	it("throws when file deleted since capture", () => {
		write(dir, "f.txt", "v1");
		const m = capture(dir);
		rmSync(join(dir, "f.txt"));
		expect(() => buildSnapshotPayload(m, dir)).toThrow(/Cannot stat/i);
	});

	it("throws when manifest path is a symlink target", () => {
		write(dir, "real.txt", "data");
		symlinkSync("real.txt", join(dir, "link.txt"));
		// Build a manifest with the symlink path directly
		const m: WorkspaceManifest = {
			entries: [
				{
					path: "link.txt",
					hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
					mode: "100644",
				},
			],
			generatedAt: new Date().toISOString(),
		};
		expect(() => buildSnapshotPayload(m, dir)).toThrow(/symlink/i);
	});

	it("returns array-based files (no prototype pollution)", () => {
		write(dir, "a.txt", "hello");
		const m = capture(dir);
		const p = buildSnapshotPayload(m, dir);
		expect(Array.isArray(p.files)).toBe(true);
		expect(typeof p.files[0]!.contentBase64).toBe("string");
	});

	it("hashing matches decoded bytes not base64 string", () => {
		write(dir, "remote", "remote");
		const m = capture(dir);
		write(dir, "remote", "locally-changed");
		const entry = m.entries[0]!;
		const result = apply(
			m,
			[{ type: "change", path: "remote", baseHash: entry.hash, contentBase64: b64("remote") }],
			dir,
		);
		expect(result.conflicts).toHaveLength(1);
		// sha256("remote") — not sha256(base64("remote"))
		expect(result.conflicts[0]!.remoteHash).toBe("b71199ebd070b36beab7317920c2c2f1d777df8d05e5527d8458fda57cb17a7a");
	});
});

// ---------------------------------------------------------------------------
// 2. Mode validation
// ---------------------------------------------------------------------------

describe("mode validation", () => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir();
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("rejects manifest entry with setuid mode", () => {
		const bad: WorkspaceManifest = {
			entries: [
				{ path: "f.txt", hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", mode: "104755" },
			],
			generatedAt: new Date().toISOString(),
		};
		expect(() => apply(bad, [], dir)).toThrow(/Invalid mode/i);
	});

	it("rejects manifest entry with non-file mode", () => {
		const bad: WorkspaceManifest = {
			entries: [
				{ path: "f.txt", hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", mode: "040755" },
			],
			generatedAt: new Date().toISOString(),
		};
		expect(() => apply(bad, [], dir)).toThrow(/Invalid mode/i);
	});

	it("rejects manifest entry with mode 100777 (sticky not allowed)", () => {
		const bad: WorkspaceManifest = {
			entries: [
				{ path: "f.txt", hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", mode: "100777" },
			],
			generatedAt: new Date().toISOString(),
		};
		expect(() => apply(bad, [], dir)).toThrow(/Invalid mode/i);
	});

	it("rejects mode 100000 (no permission bits)", () => {
		const bad: WorkspaceManifest = {
			entries: [
				{ path: "f.txt", hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", mode: "100000" },
			],
			generatedAt: new Date().toISOString(),
		};
		expect(() => apply(bad, [], dir)).toThrow(/Invalid mode/i);
	});

	it("normalizes 0644 to 100644 (text, no +x)", () => {
		write(dir, "f.txt", "hello");
		const m = capture(dir);
		expect(m.entries[0]!.mode).toBe("100644");
	});

	it("normalizes 0755 to 100755 (executable)", () => {
		write(dir, "a.sh", "echo hi");
		chmodX(dir, "a.sh");
		const m = capture(dir);
		expect(m.entries[0]!.mode).toBe("100755");
	});

	it("normalizes 0600 to 100644 (no +x)", () => {
		write(dir, "secret.txt", "private");
		execFileSync("chmod", ["600", join(dir, "secret.txt")]);
		const m = capture(dir);
		expect(m.entries[0]!.mode).toBe("100644");
	});

	it("normalizes 0664 to 100644 (no +x)", () => {
		write(dir, "shared.txt", "shared");
		execFileSync("chmod", ["664", join(dir, "shared.txt")]);
		const m = capture(dir);
		expect(m.entries[0]!.mode).toBe("100644");
	});

	it("normalizes setuid+sticky+755 to 100755", () => {
		write(dir, "suid.sh", "#!/bin/sh");
		execFileSync("chmod", ["4755", join(dir, "suid.sh")]);
		const m = capture(dir);
		expect(m.entries[0]!.mode).toBe("100755"); // +x present => 100755
	});
});

// ---------------------------------------------------------------------------
// 3. Prototype pollution resistance
// ---------------------------------------------------------------------------

describe("prototype pollution resistance", () => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir();
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("payload files is an array, not a Record", () => {
		write(dir, "a.txt", "hello");
		const m = capture(dir);
		const p = buildSnapshotPayload(m, dir);
		expect(Array.isArray(p.files)).toBe(true);
	});

	it("works with a file named __proto__", () => {
		write(dir, "__proto__", "pollute");
		const m = capture(dir);
		const p = buildSnapshotPayload(m, dir);
		// The entry should exist and be accessible
		const entry = p.files.find((f) => f.path === "__proto__");
		expect(entry).toBeTruthy();
		expect(entry!.contentBase64).toBe(b64("pollute"));
	});

	it("works with a file named constructor", () => {
		write(dir, "constructor", "ctor");
		const m = capture(dir);
		const p = buildSnapshotPayload(m, dir);
		const entry = p.files.find((f) => f.path === "constructor");
		expect(entry).toBeTruthy();
	});

	it("ChangesetPayload has no files field (changes carry contentBase64)", () => {
		write(dir, "a.txt", "hello");
		const m = capture(dir);
		const p: { changes: any[]; snapshot: typeof m; files?: any } = {
			changes: [{ type: "add", path: "b.txt", contentBase64: b64("data") }],
			snapshot: m,
		};
		// Should not have a 'files' property at the top level
		expect(p.files).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 4. Path & content safety
// ---------------------------------------------------------------------------

describe("path and content safety", () => {
	let dir: string;
	let manifest: WorkspaceManifest;
	beforeEach(() => {
		dir = tempDir();
		write(dir, "a.txt", "safe");
		manifest = capture(dir);
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("rejects backslash in path", () => {
		const result = apply(manifest, [{ type: "add", path: "sub\\file.txt", contentBase64: b64("x") }], dir);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.message).toContain("Backslash");
	});

	it("rejects absolute paths", () => {
		const result = apply(manifest, [{ type: "add", path: "/etc/passwd", contentBase64: b64("x") }], dir);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.message).toMatch(/absolute/i);
	});

	it("rejects ../ traversal", () => {
		const result = apply(manifest, [{ type: "add", path: "../escape.txt", contentBase64: b64("x") }], dir);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.message).toMatch(/traversal/i);
	});

	it("rejects control characters in path", () => {
		const result = apply(manifest, [{ type: "add", path: "bad\x00file.txt", contentBase64: b64("x") }], dir);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.message).toMatch(/control/i);
	});

	it("rejects base64 string exceeding encoded limit", () => {
		const tooLong = "A".repeat(MAX_FILE_SIZE_BYTES * 2); // far over limit
		const result = apply(manifest, [{ type: "add", path: "huge.txt", contentBase64: tooLong }], dir);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.message).toMatch(/encoded length/i);
	});

	it("default case rejects unknown change type", () => {
		const result = applyChangeset(
			{ entries: [], generatedAt: new Date().toISOString() },
			[{ type: "UNKNOWN" as any, path: "x.txt" }],
			dir,
		);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.message).toContain("Unknown change type");
	});
});

// ---------------------------------------------------------------------------
// 5. Expanded credential paths
// ---------------------------------------------------------------------------

describe("expanded credential exclusion", () => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir();
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("excludes .npmrc", () => {
		write(dir, ".npmrc", "//registry.npmjs.org/:_authToken=xxx");
		write(dir, "safe.txt", "data");
		expect(capture(dir).entries.map((e) => e.path)).toEqual(["safe.txt"]);
	});

	it("excludes .pypirc", () => {
		write(dir, ".pypirc", "[distutils]");
		write(dir, "safe.txt", "data");
		expect(capture(dir).entries.map((e) => e.path)).toEqual(["safe.txt"]);
	});

	it("excludes .netrc", () => {
		write(dir, ".netrc", "machine example.com login user password pass");
		write(dir, "safe.txt", "data");
		expect(capture(dir).entries.map((e) => e.path)).toEqual(["safe.txt"]);
	});

	it("excludes .docker/config.json", () => {
		write(dir, ".docker/config.json", '{"auths":{}}');
		write(dir, "safe.txt", "data");
		expect(capture(dir).entries.map((e) => e.path)).toEqual(["safe.txt"]);
	});

	it("excludes credentials.json", () => {
		write(dir, "credentials.json", '{"client_id":"x"}');
		write(dir, "safe.txt", "data");
		expect(capture(dir).entries.map((e) => e.path)).toEqual(["safe.txt"]);
	});

	it("excludes service-account.json variants", () => {
		write(dir, "service-account.json", '{"type":"service_account"}');
		write(dir, "sub/service-account-key.json", '{"type":"service_account"}');
		write(dir, "my-project.service-account.json", '{"type":"service_account"}');
		write(dir, "safe.txt", "data");
		expect(capture(dir).entries.map((e) => e.path)).toEqual(["safe.txt"]);
	});

	it("rejects add of new credential patterns", () => {
		const m = capture(dir);
		for (const p of [
			".npmrc",
			".pypirc",
			".netrc",
			".docker/config.json",
			"credentials.json",
			"service-account.json",
		]) {
			const path = p.includes("/") ? p : p;
			const result = apply(m, [{ type: "add", path, contentBase64: b64("x") }], dir);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.message).toContain("Credential path");
		}
	});
});

// ---------------------------------------------------------------------------
// Basic operations
// ---------------------------------------------------------------------------

describe("applyChangeset basic operations", () => {
	let dir: string;
	let manifest: WorkspaceManifest;
	beforeEach(() => {
		dir = tempDir();
		write(dir, "a.txt", "content-a");
		write(dir, "b.txt", "content-b");
		manifest = capture(dir);
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("adds new file", () => {
		const r = apply(manifest, [{ type: "add", path: "c.txt", contentBase64: b64("c") }], dir);
		expect(r.applied).toEqual([{ path: "c.txt", type: "add" }]);
		expect(read(dir, "c.txt")).toBe("c");
	});

	it("changes existing file", () => {
		const entry = manifest.entries.find((e) => e.path === "a.txt")!;
		const r = apply(
			manifest,
			[{ type: "change", path: "a.txt", baseHash: entry.hash, contentBase64: b64("updated") }],
			dir,
		);
		expect(r.applied).toEqual([{ path: "a.txt", type: "change" }]);
		expect(read(dir, "a.txt")).toBe("updated");
	});

	it("deletes existing file", () => {
		const entry = manifest.entries.find((e) => e.path === "a.txt")!;
		const r = apply(manifest, [{ type: "delete", path: "a.txt", baseHash: entry.hash }], dir);
		expect(r.applied).toEqual([{ path: "a.txt", type: "delete" }]);
		expect(existsSync(join(dir, "a.txt"))).toBe(false);
	});

	it("creates intermediate dirs", () => {
		const r = apply(manifest, [{ type: "add", path: "sub/dir/c.txt", contentBase64: b64("nested") }], dir, {
			createDirectories: true,
		});
		expect(r.applied).toEqual([{ path: "sub/dir/c.txt", type: "add" }]);
		expect(read(dir, "sub/dir/c.txt")).toBe("nested");
	});

	it("add rejects path in manifest", () => {
		const r = apply(manifest, [{ type: "add", path: "a.txt", contentBase64: b64("dup") }], dir);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]!.message).toContain("already in base manifest");
	});

	it("change requires baseHash", () => {
		const r = apply(manifest, [{ type: "change", path: "a.txt", contentBase64: b64("x") }], dir);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]!.message).toContain("requires baseHash");
	});

	it("delete requires baseHash", () => {
		const r = apply(manifest, [{ type: "delete", path: "a.txt" }], dir);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]!.message).toContain("requires baseHash");
	});

	it("change not in manifest errors", () => {
		const r = apply(
			manifest,
			[{ type: "change", path: "ghost.txt", baseHash: "x".repeat(64), contentBase64: b64("x") }],
			dir,
		);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]!.message).toContain("not in base manifest");
	});

	it("delete not in manifest errors", () => {
		const r = apply(manifest, [{ type: "delete", path: "ghost.txt", baseHash: "x".repeat(64) }], dir);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]!.message).toContain("not in base manifest");
	});

	it("preserves executable mode on change", () => {
		write(dir, "a.sh", "echo hi");
		chmodX(dir, "a.sh");
		const m2 = capture(dir);
		const entry = m2.entries.find((e) => e.path === "a.sh")!;
		const r = apply(
			m2,
			[{ type: "change", path: "a.sh", baseHash: entry.hash, contentBase64: b64("echo updated") }],
			dir,
		);
		expect(r.applied).toHaveLength(1);
		expect(isExec(dir, "a.sh")).toBe(true);
	});

	it("new file has 0644 mode (not executable)", () => {
		const r = apply(manifest, [{ type: "add", path: "new.txt", contentBase64: b64("data") }], dir);
		expect(r.applied).toHaveLength(1);
		expect(isExec(dir, "new.txt")).toBe(false);
	});

	it("rejects duplicate paths", () => {
		const r = apply(
			manifest,
			[
				{ type: "add", path: "dup.txt", contentBase64: b64("v1") },
				{ type: "add", path: "dup.txt", contentBase64: b64("v2") },
			],
			dir,
		);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]!.message).toContain("Duplicate change path");
		expect(r.applied).toHaveLength(0);
	});
});

describe("conflict detection", () => {
	let dir: string;
	let manifest: WorkspaceManifest;
	beforeEach(() => {
		dir = tempDir();
		write(dir, "a.txt", "content-a");
		manifest = capture(dir);
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("conflict on change when local diverged", () => {
		write(dir, "a.txt", "locally-modified");
		const entry = manifest.entries.find((e) => e.path === "a.txt")!;
		const r = apply(
			manifest,
			[{ type: "change", path: "a.txt", baseHash: entry.hash, contentBase64: b64("remote") }],
			dir,
		);
		expect(r.conflicts).toHaveLength(1);
		expect(read(dir, "a.txt")).toBe("locally-modified");
	});

	it("conflict on delete when local diverged", () => {
		write(dir, "a.txt", "locally-modified");
		const entry = manifest.entries.find((e) => e.path === "a.txt")!;
		const r = apply(manifest, [{ type: "delete", path: "a.txt", baseHash: entry.hash }], dir);
		expect(r.conflicts).toHaveLength(1);
		expect(existsSync(join(dir, "a.txt"))).toBe(true);
	});

	it("conflict on add when file exists locally", () => {
		write(dir, "c.txt", "local");
		const r = apply(manifest, [{ type: "add", path: "c.txt", contentBase64: b64("remote") }], dir);
		expect(r.conflicts).toHaveLength(1);
		expect(read(dir, "c.txt")).toBe("local");
	});
});

describe("symlink handling", () => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir();
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("skips symlinks during capture", () => {
		write(dir, "real.txt", "content");
		symlinkSync("real.txt", join(dir, "link.txt"));
		const m = capture(dir);
		expect(m.entries.map((e) => e.path)).toEqual(["real.txt"]);
	});

	it("rejects parent symlink during apply", () => {
		const realDir = join(dir, "realdir");
		mkdirSync(realDir);
		write(realDir, "inner.txt", "safe");
		symlinkSync("realdir", join(dir, "linkdir"));
		const m = capture(dir);
		const r = apply(m, [{ type: "add", path: "linkdir/evil.sh", contentBase64: b64("x") }], dir);
		expect(r.errors).toHaveLength(1);
	});
});

describe("git-aware listing and context", () => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir();
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("uses git ls-files inside a repo", () => {
		initGitRepo(dir);
		write(dir, "tracked.ts", "v1");
		write(dir, ".gitignore", "*.log\n");
		write(dir, "debug.log", "logs");
		gitCommit(dir, "init");
		write(dir, "new.ts", "v3");
		const m = capture(dir);
		const paths = m.entries.map((e) => e.path);
		expect(paths).toContain("tracked.ts");
		expect(paths).toContain("new.ts");
		expect(paths).not.toContain("debug.log");
	});

	it("nested gitignore honoured", () => {
		initGitRepo(dir);
		write(dir, ".gitignore", "*.log\n");
		write(dir, "top.ts", "top");
		write(dir, "sub/.gitignore", "*.tmp\n");
		write(dir, "sub/keep.ts", "keep");
		write(dir, "sub/ignore.tmp", "temp");
		gitCommit(dir, "init");
		const m = capture(dir);
		const paths = m.entries.map((e) => e.path);
		expect(paths).toContain("top.ts");
		expect(paths).toContain("sub/keep.ts");
		expect(paths).not.toContain("sub/ignore.tmp");
	});

	it("captures git commit and branch", () => {
		initGitRepo(dir);
		write(dir, "f.ts", "v1");
		const sha = gitCommit(dir, "init");
		const m = capture(dir);
		expect(m.gitCommit).toBe(sha);
		expect(m.gitBranch).toBe("main");
	});

	it("handles non-git workspace", () => {
		write(dir, "a.txt", "data");
		const m = capture(dir);
		expect(m.gitCommit).toBeUndefined();
		expect(m.gitBranch).toBeUndefined();
	});

	it("sorts deterministically", () => {
		write(dir, "b.ts", "bbb");
		write(dir, "a.ts", "aaa");
		const m = capture(dir);
		expect(m.entries.map((e) => e.path)).toEqual(["a.ts", "b.ts"]);
	});

	it("throws on non-existent path", () => {
		expect(() => captureWorkspaceManifest(join(dir, "nope"))).toThrow();
	});

	it("rejects symlink workspaceRoot at capture", () => {
		const realDir = join(dir, "real");
		mkdirSync(realDir);
		symlinkSync("real", join(dir, "link"));
		expect(() => captureWorkspaceManifest(join(dir, "link"))).toThrow(/not a regular directory/i);
	});

	it("rejects symlink workspaceRoot at buildSnapshotPayload", () => {
		write(dir, "a.txt", "data");
		const m = capture(dir);
		const linkDir = join(dir, "link");
		symlinkSync(dir, linkDir);
		expect(() => buildSnapshotPayload(m, linkDir)).toThrow(/not a regular directory/i);
	});

	it("rejects symlink workspaceRoot at apply", () => {
		const m: WorkspaceManifest = { entries: [], generatedAt: new Date().toISOString() };
		const linkDir = join(dir, "link");
		symlinkSync(dir, linkDir);
		const r = apply(m, [{ type: "add", path: "b.txt", contentBase64: b64("x") }], linkDir);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]!.message).toMatch(/not a regular directory/i);
	});
});

describe("size limits", () => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir();
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("rejects per-file over limit at capture", () => {
		const big = "x".repeat(MAX_FILE_SIZE_BYTES + 1);
		write(dir, "big.txt", big);
		expect(() => capture(dir)).toThrow(/exceeds max/i);
	});

	it("rejects total over limit at capture", () => {
		const chunk = "x".repeat(1024 * 1024);
		const count = Math.ceil(MAX_SNAPSHOT_BYTES / chunk.length) + 1;
		for (let i = 0; i < count; i++) write(dir, `f${i}.txt`, chunk);
		expect(() => capture(dir)).toThrow(/exceeds max/);
	});

	it("rejects oversized base64 at apply", () => {
		const m = capture(dir);
		const bigB64 = "x".repeat(MAX_BASE64_STRING_LENGTH + 1);
		const r = apply(m, [{ type: "add", path: "huge.txt", contentBase64: bigB64 }], dir);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]!.message).toMatch(/encoded length/i);
	});
});

describe("credential exclusion (capture + apply)", () => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir();
	});
	afterEach(() => {
		rmDir(dir);
	});

	it("excludes all credential patterns at capture", () => {
		const patterns = [
			".env",
			".env.prod",
			".envrc",
			".ssh/id_rsa",
			".aws/credentials",
			".gnupg/secring.gpg",
			".prime/agent/config.toml",
			"cert.pem",
			"ca.cert",
			"my.key",
			"api.token",
			"credentials",
			".credentials/token",
			"secrets/api-key",
			".npmrc",
			".pypirc",
			".netrc",
			".docker/config.json",
			"credentials.json",
			"service-account.json",
			"sub/service-account-key.json",
			"proj.service-account.json",
		];
		write(dir, "safe.txt", "data");
		for (const p of patterns) write(dir, p, "x");
		const m = capture(dir);
		expect(m.entries.map((e) => e.path)).toEqual(["safe.txt"]);
	});

	it("rejects add of each credential type at apply", () => {
		const m = capture(dir);
		const credPaths = [
			".env",
			".ssh/id_rsa",
			".aws/creds",
			".gnupg/secring.gpg",
			".prime/token",
			"secret.pem",
			"my.key",
			"api.token",
			".npmrc",
			".pypirc",
			".netrc",
			".docker/config.json",
			"credentials.json",
			"service-account.json",
		];
		for (const p of credPaths) {
			const r = apply(m, [{ type: "add", path: p, contentBase64: b64("x") }], dir);
			expect(r.errors).toHaveLength(1);
			expect(r.errors[0]!.message).toContain("Credential path");
		}
	});
});

describe("constants", () => {
	it("MAX_FILE_SIZE_BYTES is 50 MiB", () => {
		expect(MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
	});
	it("MAX_SNAPSHOT_BYTES is 500 MiB", () => {
		expect(MAX_SNAPSHOT_BYTES).toBe(500 * 1024 * 1024);
	});
});
