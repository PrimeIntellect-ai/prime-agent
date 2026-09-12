import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("Package Manager git source parsing", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pm-ssh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each(["--upload-pack=unexpected-command", "relative-project", "project with spaces"])(
		"keeps the project directory %s a clone operand",
		async (cwd) => {
			const originalCwd = process.cwd();
			process.chdir(tempDir);
			try {
				const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
				const commands = manager as unknown as {
					runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
				};
				const runCommand = vi.spyOn(commands, "runCommand").mockResolvedValue(undefined);
				await manager.install("git:git@github.com:user/repo@v1.0.0", { local: true });
				const target = join(cwd, CONFIG_DIR_NAME, "git", "github.com", "user/repo");
				expect(runCommand).toHaveBeenNthCalledWith(1, "git", ["clone", "--", "git@github.com:user/repo", target]);
				expect(runCommand).toHaveBeenNthCalledWith(2, "git", ["checkout", "v1.0.0"], { cwd: target });
				expect(runCommand).toHaveBeenCalledTimes(2);
			} finally {
				process.chdir(originalCwd);
			}
		},
	);

	it("clones into an option-shaped directory with real Git and a local transport", async () => {
		const remote = join(tempDir, "remote.git");
		execFileSync("git", ["init", "--bare", "--quiet", remote]);
		const source = "https://prime-clone-boundary.invalid/owner/repo";
		const cwd = "--upload-pack=unexpected-command";
		const originalCwd = process.cwd();
		process.chdir(tempDir);
		try {
			const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
			const commands = manager as unknown as {
				runCommand(command: string, args: string[]): Promise<void>;
			};
			vi.spyOn(commands, "runCommand").mockImplementation(async (command, args) => {
				execFileSync(command, ["-c", `url.${pathToFileURL(remote).href}.insteadOf=${source}`, ...args], {
					cwd: tempDir,
					stdio: "pipe",
				});
			});
			await manager.install(source, { local: true });
			expect(existsSync(join(cwd, CONFIG_DIR_NAME, "git", "prime-clone-boundary.invalid", "owner/repo/.git"))).toBe(
				true,
			);
		} finally {
			process.chdir(originalCwd);
		}
	});

	describe("protocol URLs without git: prefix", () => {
		it("should parse https:// URL", () => {
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse ssh:// URL", () => {
			const parsed = (packageManager as any).parseSource("ssh://git@github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
			expect(parsed.repo).toBe("ssh://git@github.com/user/repo");
		});
	});

	describe("shorthand URLs with git: prefix", () => {
		it("should parse git@host:path format", () => {
			const parsed = (packageManager as any).parseSource("git:git@github.com:user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
			expect(parsed.repo).toBe("git@github.com:user/repo");
			expect(parsed.pinned).toBe(false);
		});

		it("should parse host/path shorthand", () => {
			const parsed = (packageManager as any).parseSource("git:github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse shorthand with ref", () => {
			const parsed = (packageManager as any).parseSource("git:git@github.com:user/repo@v1.0.0");
			expect(parsed.type).toBe("git");
			expect(parsed.ref).toBe("v1.0.0");
			expect(parsed.pinned).toBe(true);
		});
	});

	describe("unsupported without git: prefix", () => {
		it("should treat git@host:path as local without git: prefix", () => {
			const parsed = (packageManager as any).parseSource("git@github.com:user/repo");
			expect(parsed.type).toBe("local");
		});
	});

	describe("identity normalization", () => {
		it("should normalize protocol and shorthand-prefixed URLs to same identity", () => {
			const prefixed = (packageManager as any).getPackageIdentity("git:git@github.com:user/repo");
			const https = (packageManager as any).getPackageIdentity("https://github.com/user/repo");
			const ssh = (packageManager as any).getPackageIdentity("ssh://git@github.com/user/repo");

			expect(prefixed).toBe("git:github.com/user/repo");
			expect(prefixed).toBe(https);
			expect(prefixed).toBe(ssh);
		});
	});
});
