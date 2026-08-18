import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: git ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout.trim();
}

function initGitRepo(repoDir: string): void {
	git(["init", "--initial-branch=main"], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
}

function createCommit(repoDir: string, filename: string, content: string, message: string): string {
	writeFileSync(join(repoDir, filename), content);
	git(["add", filename], repoDir);
	git(["commit", "-m", message], repoDir);
	return git(["rev-parse", "HEAD"], repoDir);
}

function getCurrentCommit(repoDir: string): string {
	return git(["rev-parse", "HEAD"], repoDir);
}

function getFileContent(repoDir: string, filename: string): string {
	return readFileSync(join(repoDir, filename), "utf-8");
}

describe("DefaultPackageManager git update", () => {
	let tempDir: string;
	let remoteDir: string; // Simulates the "remote" repository
	let agentDir: string; // The agent directory where extensions are installed
	let installedDir: string; // The installed extension directory
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	const gitSource = "git:github.com/test/extension";

	beforeEach(() => {
		tempDir = join(tmpdir(), `git-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		remoteDir = join(tempDir, "remote");
		agentDir = join(tempDir, "agent");

		installedDir = join(agentDir, "git", "github.com", "test", "extension");

		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function setupRemoteAndInstall(sourceOverride?: string): void {
		mkdirSync(remoteDir, { recursive: true });
		initGitRepo(remoteDir);
		createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

		mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
		git(["clone", remoteDir, installedDir], tempDir);
		git(["config", "--local", "user.email", "test@test.com"], installedDir);
		git(["config", "--local", "user.name", "Test"], installedDir);

		settingsManager.setPackages([sourceOverride ?? gitSource]);
	}

	describe("normal updates (no force-push)", () => {
		it("should skip reset, clean, and install when already up to date", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			writeFileSync(join(remoteDir, "package.json"), JSON.stringify({ name: "test-extension", version: "1.0.0" }));
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			settingsManager.setPackages([gitSource]);

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "npm") {
					return;
				}
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			await packageManager.update();

			expect(executedCommands).toContain(
				"git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(executedCommands).not.toContain("git fetch --prune origin");
			expect(executedCommands).not.toContain("git reset --hard @{upstream}");
			expect(executedCommands).not.toContain("git reset --hard origin/HEAD");
			expect(executedCommands).not.toContain("git clean -fdx");
			expect(executedCommands).not.toContain("npm install");
		});

		it("should update to latest commit when remote has new commits", async () => {
			setupRemoteAndInstall();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");

			const newCommit = createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(newCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});

		it("should handle multiple commits ahead", async () => {
			setupRemoteAndInstall();

			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");
			createCommit(remoteDir, "extension.ts", "// v3", "Third commit");
			const latestCommit = createCommit(remoteDir, "extension.ts", "// v4", "Fourth commit");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(latestCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v4");
		});

		it("should update even when local checkout has no upstream", async () => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");
			const latestCommit = createCommit(remoteDir, "extension.ts", "// v3", "Third commit");

			const detachedCommit = getCurrentCommit(installedDir);
			git(["checkout", detachedCommit], installedDir);

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			await packageManager.update();

			expect(executedCommands).toContain(
				"git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(getCurrentCommit(installedDir)).toBe(latestCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v3");
		});
	});

	describe("force-push scenarios", () => {
		it("should recover when remote history is rewritten", async () => {
			setupRemoteAndInstall();
			const initialCommit = getCurrentCommit(remoteDir);

			createCommit(remoteDir, "extension.ts", "// v2", "Commit to keep");

			await packageManager.update();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");

			git(["reset", "--hard", initialCommit], remoteDir);
			const rewrittenCommit = createCommit(remoteDir, "extension.ts", "// v2-rewritten", "Rewritten commit");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(rewrittenCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2-rewritten");
		});

		it("should recover when local commit no longer exists in remote", async () => {
			setupRemoteAndInstall();

			createCommit(remoteDir, "extension.ts", "// v2", "Commit A");
			createCommit(remoteDir, "extension.ts", "// v3", "Commit B");

			await packageManager.update();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v3");

			git(["reset", "--hard", "HEAD~2"], remoteDir);
			const newCommit = createCommit(remoteDir, "extension.ts", "// v2-new", "New commit replacing A and B");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(newCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2-new");
		});

		it("should handle complete history rewrite", async () => {
			setupRemoteAndInstall();

			createCommit(remoteDir, "extension.ts", "// v2", "v2");
			createCommit(remoteDir, "extension.ts", "// v3", "v3");

			await packageManager.update();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v3");

			git(["reset", "--hard", "HEAD~2"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// rewrite-a", "Rewrite A");
			const finalCommit = createCommit(remoteDir, "extension.ts", "// rewrite-b", "Rewrite B");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(finalCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// rewrite-b");
		});
	});

	describe("pinned sources", () => {
		it("should not update pinned git sources (with @ref)", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			const initialCommit = createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["checkout", initialCommit], installedDir);
			git(["config", "--local", "user.email", "test@test.com"], installedDir);
			git(["config", "--local", "user.name", "Test"], installedDir);

			settingsManager.setPackages([`${gitSource}@${initialCommit}`]);

			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(initialCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
		});
	});

	describe("temporary git sources", () => {
		it("should refresh cached temporary git sources when resolving", async () => {
			const gitHost = "github.com";
			const gitPath = "test/extension";
			const hash = createHash("sha256").update(`git-${gitHost}-${gitPath}`).digest("hex").slice(0, 8);
			const cachedDir = join(tmpdir(), "pi-extensions", `git-${gitHost}`, hash, gitPath);
			const extensionFile = join(cachedDir, "pi-extensions", "session-breakdown.ts");

			rmSync(cachedDir, { recursive: true, force: true });
			mkdirSync(join(cachedDir, "pi-extensions"), { recursive: true });
			writeFileSync(
				join(cachedDir, "package.json"),
				JSON.stringify({ pi: { extensions: ["./pi-extensions"] } }, null, 2),
			);
			writeFileSync(extensionFile, "// stale");

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture: (command: string, args: string[], options?: { cwd?: string }) => Promise<string>;
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "git" && args[0] === "reset") {
					writeFileSync(extensionFile, "// fresh");
				}
			};
			managerWithInternals.runCommandCapture = async (_command, args) => {
				if (args[0] === "rev-parse" && args[1] === "HEAD") {
					return "local-head";
				}
				if (args[0] === "rev-parse" && args[1] === "@{upstream}") {
					return "remote-head";
				}
				if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
					return "origin/main";
				}
				return "";
			};

			await packageManager.resolveExtensionSources([gitSource], { temporary: true });

			expect(executedCommands).toContain(
				"git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(getFileContent(cachedDir, "pi-extensions/session-breakdown.ts")).toBe("// fresh");
		});

		it("should not refresh pinned temporary git sources", async () => {
			const gitHost = "github.com";
			const gitPath = "test/extension";
			const hash = createHash("sha256").update(`git-${gitHost}-${gitPath}`).digest("hex").slice(0, 8);
			const cachedDir = join(tmpdir(), "pi-extensions", `git-${gitHost}`, hash, gitPath);
			const extensionFile = join(cachedDir, "pi-extensions", "session-breakdown.ts");

			rmSync(cachedDir, { recursive: true, force: true });
			mkdirSync(join(cachedDir, "pi-extensions"), { recursive: true });
			writeFileSync(
				join(cachedDir, "package.json"),
				JSON.stringify({ pi: { extensions: ["./pi-extensions"] } }, null, 2),
			);
			writeFileSync(extensionFile, "// pinned");

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
			};

			await packageManager.resolveExtensionSources([`${gitSource}@main`], { temporary: true });

			expect(executedCommands).toEqual([]);
			expect(getFileContent(cachedDir, "pi-extensions/session-breakdown.ts")).toBe("// pinned");
		});
	});

	describe("scope-aware update", () => {
		it("should not install locally when source is only registered globally", async () => {
			setupRemoteAndInstall();

			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			const projectGitDir = join(tempDir, ".prime", "agent", "git", "github.com", "test", "extension");
			expect(existsSync(projectGitDir)).toBe(false);

			await packageManager.update(gitSource);

			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");

			expect(existsSync(projectGitDir)).toBe(false);
		});
	});
});
