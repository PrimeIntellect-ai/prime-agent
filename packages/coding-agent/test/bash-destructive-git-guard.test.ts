import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BASH_DESTRUCTIVE_GIT_BYPASS_ENV,
	type BashOperations,
	createBashTool,
	isDestructiveGitDiscardCommand,
} from "../src/core/tools/bash.js";

function runGit(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

/** Create a git repository with one committed file plus two uncommitted changes. */
function initDirtyGitRepo(root: string): void {
	runGit(root, "init");
	runGit(root, "config", "user.email", "test@example.com");
	runGit(root, "config", "user.name", "Test");
	runGit(root, "config", "commit.gpgsign", "false");
	writeFileSync(join(root, "tracked.txt"), "committed\n");
	runGit(root, "add", "tracked.txt");
	runGit(root, "commit", "-m", "init");
	writeFileSync(join(root, "tracked.txt"), "modified\n");
	writeFileSync(join(root, "untracked.txt"), "uncommitted\n");
}

describe("isDestructiveGitDiscardCommand", () => {
	it.each([
		"git checkout -- .",
		"git checkout .",
		"git checkout HEAD -- .",
		"git restore .",
		"git restore --source=HEAD~1 .",
		"git clean -f",
		"git clean -fd",
		"git clean -fdx",
		"git clean --force",
		"git reset --hard",
		"git reset --hard HEAD~1",
		"git checkout -b tmp 2>/dev/null; git checkout -- .",
		"git checkout main && git reset --hard",
		"echo start\ngit clean -fd",
		"npm test & git clean -fd &",
		"git checkout :/",
		"git checkout -- :/",
		"git checkout HEAD -- :/",
		"git restore :/",
		"git restore -s@ .",
		"git restore -s@ :/",
		"git restore --source=HEAD :/",
		"git restore -s HEAD~1 :/",
		"git restore -- .",
		"git checkout -- ./",
		"git checkout ./",
		"git restore ./",
		"git -C sub reset --hard",
		"git --git-dir=sub/.git reset --hard",
		"git reset -q --hard",
		"git reset --no-refresh --hard",
		"git -C repo -C nested reset --hard",
		"GIT_DIR=sub/.git git reset --hard",
		"GIT_DIR=sub/.git GIT_WORK_TREE=sub git reset --hard",
		"git checkout -f -- .",
		"git checkout --theirs -- .",
		"git checkout -m .",
		"git checkout --conflict=diff3 .",
		"git checkout HEAD .",
		"git checkout HEAD~1 -- .",
		"git checkout origin/main .",
		"git checkout -f main",
		"git checkout --force main",
		"git clean -f -- -n",
	])("matches %s", (command) => {
		expect(isDestructiveGitDiscardCommand(command)).toBe(true);
	});

	it.each([
		"git status",
		"git log --oneline",
		"git checkout -b new-branch",
		"git checkout main",
		"git checkout -m main",
		"git checkout -b newbranch .",
		"git checkout -- single-file.txt",
		"echo 'git reset --hard'",
		'git commit -m "git reset --hard"',
		'echo "git clean -fd"',
		"echo preparing # git reset --hard",
		"git checkout ./nested",
		"git restore --staged .",
		"git restore --staged :/",
		"git restore single-file.txt",
		"git clean -n",
		"git clean -n -f .",
		"git clean --dry-run",
		"git clean -d",
		"git reset",
		"git reset --soft HEAD~1",
		"git stash",
		"git add .",
		"echo hello world",
		"npm run check",
	])("does not match %s", (command) => {
		expect(isDestructiveGitDiscardCommand(command)).toBe(false);
	});
});

describe("bash tool destructive-git dirty-tree guard", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `bash-git-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		delete process.env[BASH_DESTRUCTIVE_GIT_BYPASS_ENV];
		rmSync(testDir, { recursive: true, force: true });
	});

	it.each(["git checkout -- .", "git checkout .", "git clean -fd", "git reset --hard", "git restore ."])(
		"refuses %s on a dirty tree and preserves the work",
		async (command) => {
			initDirtyGitRepo(testDir);
			const bash = createBashTool(testDir);

			await expect(bash.execute(`guard-${command}`, { command })).rejects.toThrow(
				/Refusing to run this destructive git command/,
			);

			expect(readModifiedTracked()).toBe("modified\n");
			expect(existsSync(join(testDir, "untracked.txt"))).toBe(true);
		},
	);

	it("lists the dirty paths and both bypasses in the refusal", async () => {
		initDirtyGitRepo(testDir);
		const bash = createBashTool(testDir);

		const error = await bash
			.execute("guard-refusal-text", { command: "git checkout -- ." })
			.catch((err: Error) => err);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("2 uncommitted change(s)");
		expect(message).toContain("tracked.txt");
		expect(message).toContain("untracked.txt");
		expect(message).toContain("allowDestructiveGit: true");
		expect(message).toContain(BASH_DESTRUCTIVE_GIT_BYPASS_ENV);
	});

	it("elides long dirty path lists", async () => {
		initDirtyGitRepo(testDir);
		for (let i = 0; i < 12; i++) writeFileSync(join(testDir, `extra-${i}.txt`), "x\n");
		const bash = createBashTool(testDir);

		const error = await bash.execute("guard-elide", { command: "git checkout -- ." }).catch((err: Error) => err);
		const message = (error as Error).message;

		expect(message).toContain("... and 4 more");
	});

	it("runs the discard without a probe when the tree is clean", async () => {
		initDirtyGitRepo(testDir);
		runGit(testDir, "add", "-A");
		runGit(testDir, "commit", "-m", "second");
		const bash = createBashTool(testDir);

		await expect(bash.execute("guard-clean", { command: "git checkout -- ." })).resolves.toBeDefined();
	});

	it("bypasses the guard with allowDestructiveGit: true and discards", async () => {
		initDirtyGitRepo(testDir);
		const bash = createBashTool(testDir);

		await expect(
			bash.execute("guard-bypass-arg", { command: "git reset --hard", allowDestructiveGit: true }),
		).resolves.toBeDefined();

		expect(readModifiedTracked()).toBe("committed\n");
	});

	it(`bypasses the guard with ${BASH_DESTRUCTIVE_GIT_BYPASS_ENV}=1`, async () => {
		initDirtyGitRepo(testDir);
		process.env[BASH_DESTRUCTIVE_GIT_BYPASS_ENV] = "1";
		const bash = createBashTool(testDir);

		await expect(bash.execute("guard-bypass-env", { command: "git reset --hard" })).resolves.toBeDefined();

		expect(readModifiedTracked()).toBe("committed\n");
	});

	it("fails open outside a git repository", async () => {
		const bash = createBashTool(testDir);

		const error = await bash.execute("guard-no-repo", { command: "git checkout -- ." }).then(
			() => undefined,
			(err: Error) => err,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toMatch(/Refusing to run/);
	});

	it("runs no probe for non-discard commands", async () => {
		initDirtyGitRepo(testDir);
		const calls: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, _options) => {
				calls.push(command);
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, { operations });

		await bash.execute("guard-no-probe", { command: "echo hi" });

		expect(calls).toEqual(["echo hi"]);
	});

	it("fails open when the probe itself fails", async () => {
		const calls: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, { onData }) => {
				calls.push(command);
				if (command === "git status --porcelain --untracked-files=all") {
					onData(Buffer.from("fatal: not a git repository\n", "utf8"));
					return { exitCode: 128 };
				}
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, { operations });

		await expect(bash.execute("guard-probe-fail", { command: "git checkout -- ." })).resolves.toBeDefined();
		expect(calls).toEqual(["git status --porcelain --untracked-files=all", "git checkout -- ."]);
	});

	it("prepends the command prefix to the probe for shell-setup parity", async () => {
		const calls: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, _options) => {
				calls.push(command);
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, { commandPrefix: "export GUARD_TEST_VAR=1", operations });

		await expect(bash.execute("guard-prefix", { command: "git checkout -- ." })).resolves.toBeDefined();

		expect(calls).toEqual([
			"export GUARD_TEST_VAR=1\ngit status --porcelain --untracked-files=all",
			"export GUARD_TEST_VAR=1\ngit checkout -- .",
		]);
	});

	it("follows cd relocations: refuses a discard in a dirty nested repository", async () => {
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		const bash = createBashTool(testDir);

		const error = await bash.execute("guard-cd-dirty", { command: "cd sub && git reset --hard" }).then(
			() => undefined,
			(err: Error) => err,
		);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toMatch(/Refusing to run this destructive git command/);
		expect(message).toContain("tracked.txt");
		expect(readFileSync(join(sub, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("follows git -C relocations: refuses a discard in a dirty nested repository", async () => {
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		const bash = createBashTool(testDir);

		await expect(bash.execute("guard-git-c-dirty", { command: "git -C sub reset --hard" })).rejects.toThrow(
			/tracked\.txt/,
		);
		expect(readFileSync(join(sub, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("allows a relocated discard when the target repository is clean", async () => {
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		runGit(sub, "add", "-A");
		runGit(sub, "commit", "-m", "second");
		const bash = createBashTool(testDir);

		await expect(bash.execute("guard-cd-clean", { command: "cd sub && git reset --hard" })).resolves.toBeDefined();
	});

	it("probes every discarded repository in multi-discard commands", async () => {
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		const bash = createBashTool(testDir);

		await expect(
			bash.execute("guard-multi-discard", { command: "git checkout -- . && cd sub && git reset --hard" }),
		).rejects.toThrow(/Refusing to run this destructive git command/);
	});

	it("conservatively refuses relocations it cannot replay safely", async () => {
		const bash = createBashTool(testDir);

		for (const command of [
			"cd $(pwd)/sub && git reset --hard",
			"git --git-dir=sub/.git reset --hard",
			"cd sub || git reset --hard",
			"pushd sub && git reset --hard",
		]) {
			const error = await bash.execute(`guard-unresolvable`, { command }).then(
				() => undefined,
				(err: Error) => err,
			);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("changes directory (or repository) first");
		}
	});

	it("replays cd chains in the probe", async () => {
		const calls: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, _options) => {
				calls.push(command);
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, { operations });

		await bash.execute("guard-cd-chain", { command: "cd a && cd b && git checkout -- ." });

		expect(calls).toEqual([
			"cd a && cd b && git status --porcelain --untracked-files=all",
			"cd a && cd b && git checkout -- .",
		]);
	});

	it("replays git -C in the probe", async () => {
		const calls: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, _options) => {
				calls.push(command);
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, { operations });

		await bash.execute("guard-git-c-probe", { command: "git -C sub reset --hard" });

		expect(calls).toEqual(["git -C sub status --porcelain --untracked-files=all", "git -C sub reset --hard"]);
	});

	it("runs the probe through the spawn hook like the discard itself", async () => {
		const calls: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, _options) => {
				calls.push(command);
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, {
			operations,
			spawnHook: (ctx) => ({ ...ctx, command: `source ~/.profile\n${ctx.command}` }),
		});

		await bash.execute("guard-hook", { command: "git checkout -- ." });

		expect(calls).toEqual([
			"source ~/.profile\ngit status --porcelain --untracked-files=all",
			"source ~/.profile\ngit checkout -- .",
		]);
	});

	it("refuses git reset -q --hard on a dirty tree", async () => {
		initDirtyGitRepo(testDir);
		const bash = createBashTool(testDir);

		await expect(bash.execute("guard-reset-q", { command: "git reset -q --hard" })).rejects.toThrow(
			/Refusing to run this destructive git command/,
		);
	});

	it("refuses git clean -fx when ignored files would be deleted, and lists them", async () => {
		initDirtyGitRepo(testDir);
		runGit(testDir, "add", "-A");
		runGit(testDir, "commit", "-m", "second");
		writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
		runGit(testDir, "add", ".gitignore");
		runGit(testDir, "commit", "-m", "gitignore");
		writeFileSync(join(testDir, "ignored.txt"), "generated\n");
		const bash = createBashTool(testDir);

		const error = await bash.execute("guard-clean-x", { command: "git clean -fx" }).then(
			() => undefined,
			(err: Error) => err,
		);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("uncommitted or ignored file(s)");
		expect(message).toContain("ignored.txt");
		expect(existsSync(join(testDir, "ignored.txt"))).toBe(true);
	});

	it("allows git clean -f when only ignored files exist", async () => {
		initDirtyGitRepo(testDir);
		runGit(testDir, "add", "-A");
		runGit(testDir, "commit", "-m", "second");
		writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
		runGit(testDir, "add", ".gitignore");
		runGit(testDir, "commit", "-m", "gitignore");
		writeFileSync(join(testDir, "ignored.txt"), "generated\n");
		const bash = createBashTool(testDir);

		await expect(bash.execute("guard-clean-f", { command: "git clean -f" })).resolves.toBeDefined();
	});

	it("detects untracked files even when status.showUntrackedFiles=no is configured", async () => {
		initDirtyGitRepo(testDir);
		runGit(testDir, "add", "-A");
		runGit(testDir, "commit", "-m", "second");
		writeFileSync(join(testDir, "fresh-untracked.txt"), "new\n");
		runGit(testDir, "config", "status.showUntrackedFiles", "no");
		const bash = createBashTool(testDir);

		const error = await bash.execute("guard-untracked-config", { command: "git clean -fd" }).then(
			() => undefined,
			(err: Error) => err,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("fresh-untracked.txt");
		expect(existsSync(join(testDir, "fresh-untracked.txt"))).toBe(true);
	});

	it("replays repeated git -C options against the chained target repository", async () => {
		const nested = join(testDir, "repo", "nested");
		mkdirSync(nested, { recursive: true });
		initDirtyGitRepo(nested);
		const bash = createBashTool(testDir);

		const error = await bash.execute("guard-git-c-chain", { command: "git -C repo -C nested reset --hard" }).then(
			() => undefined,
			(err: Error) => err,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("tracked.txt");
		expect(readFileSync(join(nested, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("replays inline GIT_DIR/GIT_WORK_TREE assignments against the targeted repository", async () => {
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		const bash = createBashTool(testDir);

		const error = await bash
			.execute("guard-git-dir", { command: "GIT_DIR=sub/.git GIT_WORK_TREE=sub git reset --hard" })
			.then(
				() => undefined,
				(err: Error) => err,
			);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("tracked.txt");
		expect(readFileSync(join(sub, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("conservatively refuses assignments it cannot replay safely", async () => {
		const bash = createBashTool(testDir);

		const error = await bash
			.execute("guard-git-dir-subst", { command: "GIT_DIR=$(pwd)/sub/.git git reset --hard" })
			.then(
				() => undefined,
				(err: Error) => err,
			);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("changes directory (or repository) first");
	});

	it("refuses git checkout -f -- . on a dirty tree", async () => {
		initDirtyGitRepo(testDir);
		const bash = createBashTool(testDir);

		await expect(bash.execute("guard-checkout-f", { command: "git checkout -f -- ." })).rejects.toThrow(
			/Refusing to run this destructive git command/,
		);
		expect(readModifiedTracked()).toBe("modified\n");
	});

	it("refuses git clean -f -- -n, where -n is a pathspec, not a dry run", async () => {
		initDirtyGitRepo(testDir);
		writeFileSync(join(testDir, "-n"), "pathspec\n");
		const bash = createBashTool(testDir);

		await expect(bash.execute("guard-clean-pathspec", { command: "git clean -f -- -n" })).rejects.toThrow(
			/Refusing to run this destructive git command/,
		);
		expect(existsSync(join(testDir, "-n"))).toBe(true);
	});

	it("conservatively refuses quoted git -C directories", async () => {
		const sub = join(testDir, "dirty repo");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		const bash = createBashTool(testDir);

		const error = await bash.execute("guard-git-c-quoted", { command: 'git -C "dirty repo" reset --hard' }).then(
			() => undefined,
			(err: Error) => err,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("changes directory (or repository) first");
		expect(readFileSync(join(sub, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("conservatively refuses substituted git -C directories", async () => {
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		const bash = createBashTool(testDir);

		const error = await bash.execute("guard-git-c-var", { command: "repo=sub && git -C $repo reset --hard" }).then(
			() => undefined,
			(err: Error) => err,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("changes directory (or repository) first");
		expect(readFileSync(join(sub, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("guards path-qualified and sudo git discards without treating them as relocations", async () => {
		initDirtyGitRepo(testDir);
		const bash = createBashTool(testDir);

		for (const command of ["/usr/bin/git reset --hard", "sudo git reset --hard"]) {
			const error = await bash
				.execute(`guard-wrapper-${command.startsWith("/") ? "path" : "sudo"}`, { command })
				.then(
					() => undefined,
					(err: Error) => err,
				);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/uncommitted change\(s\)/);
		}
		expect(readModifiedTracked()).toBe("modified\n");
	});

	it("probes cd relocations followed by unrelated grouped segments", async () => {
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		const bash = createBashTool(testDir);

		const error = await bash
			.execute("guard-cd-then-group", { command: "cd sub && (echo hi) && git reset --hard" })
			.then(
				() => undefined,
				(err: Error) => err,
			);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("tracked.txt");
		expect(readFileSync(join(sub, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("ignores cds in groups that close before the discard and probes the real directory", async () => {
		initDirtyGitRepo(testDir);
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		runGit(sub, "add", "-A");
		runGit(sub, "commit", "-m", "second");
		const bash = createBashTool(testDir);

		const error = await bash
			.execute("guard-closed-group", { command: "(echo hi && cd sub && echo done) && git reset --hard" })
			.then(
				() => undefined,
				(err: Error) => err,
			);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("tracked.txt");
		expect((error as Error).message).toContain("uncommitted change(s)");
		expect(readModifiedTracked()).toBe("modified\n");
		expect(readFileSync(join(sub, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("replays in-group cds when the discard runs inside the group", async () => {
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		const bash = createBashTool(testDir);

		const error = await bash.execute("guard-open-group", { command: "(cd sub && git reset --hard)" }).then(
			() => undefined,
			(err: Error) => err,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("tracked.txt");
		expect(readFileSync(join(sub, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("inherits persistent cds into open groups for the probe", async () => {
		const nested = join(testDir, "sub", "nested");
		mkdirSync(nested, { recursive: true });
		initDirtyGitRepo(nested);
		const bash = createBashTool(testDir);

		const error = await bash
			.execute("guard-inherited-group", { command: "cd sub && (cd nested && git reset --hard)" })
			.then(
				() => undefined,
				(err: Error) => err,
			);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("tracked.txt");
		expect(readFileSync(join(nested, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("applies cwd remapping hooks once to the probe", async () => {
		const calls: Array<{ command: string; cwd: string }> = [];
		const operations: BashOperations = {
			exec: async (command, cwd, _options) => {
				calls.push({ command, cwd });
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, {
			operations,
			spawnHook: (ctx) => ({ ...ctx, cwd: `${ctx.cwd}/remapped` }),
		});

		await bash.execute("guard-hook-cwd", { command: "git checkout -- ." });

		expect(calls.map((call) => call.cwd)).toEqual([`${testDir}/remapped`, `${testDir}/remapped`]);
	});

	it("executes harmless commands that merely quote a discard command", async () => {
		initDirtyGitRepo(testDir);
		const bash = createBashTool(testDir);

		const result = await bash.execute("guard-quoted-echo", { command: "echo 'git reset --hard'" });
		expect((result.content?.[0] as { text?: string } | undefined)?.text).toContain("git reset --hard");
		expect(readModifiedTracked()).toBe("modified\n");
	});

	it("passes the tool timeout to the probe and fails open on probe timeouts", async () => {
		const calls: Array<{ command: string; timeout?: number }> = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, options) => {
				calls.push({ command, timeout: options.timeout });
				if (command.startsWith("git status")) throw new Error("timeout:5");
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, { operations });

		const result = await bash.execute("guard-probe-timeout", { command: "git checkout -- .", timeout: 5 });

		expect(result).toBeDefined();
		expect(calls[0]).toEqual({ command: "git status --porcelain --untracked-files=all", timeout: 5 });
	});

	it("refuses forced branch checkouts on a dirty tree", async () => {
		initDirtyGitRepo(testDir);
		const bash = createBashTool(testDir);

		await expect(bash.execute("guard-checkout-f-branch", { command: "git checkout -f main" })).rejects.toThrow(
			/Refusing to run this destructive git command/,
		);
		expect(readModifiedTracked()).toBe("modified\n");
	});

	it("guards discards executed through command substitution inside double quotes", async () => {
		initDirtyGitRepo(testDir);
		const bash = createBashTool(testDir);

		await expect(bash.execute("guard-substitution-echo", { command: 'echo "$(git reset --hard)"' })).rejects.toThrow(
			/Refusing to run this destructive git command/,
		);
		expect(readModifiedTracked()).toBe("modified\n");
	});

	it("conservatively refuses cds joined to the discard by ; or a newline", async () => {
		const bash = createBashTool(testDir);

		for (const command of ["cd /does/not/exist; git reset --hard", "cd sub\ngit reset --hard"]) {
			const error = await bash.execute("guard-conditional-cd", { command }).then(
				() => undefined,
				(err: Error) => err,
			);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("changes directory (or repository) first");
		}
	});

	it("applies prefix cds once in the probe and probes the prefix directory", async () => {
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		initDirtyGitRepo(sub);
		const bash = createBashTool(testDir, { commandPrefix: "cd sub" });

		const error = await bash.execute("guard-prefix-cd", { command: "git reset --hard" }).then(
			() => undefined,
			(err: Error) => err,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("tracked.txt");
		expect(readFileSync(join(sub, "tracked.txt"), "utf-8")).toBe("modified\n");
	});

	it("records the prefix cd probe without duplication", async () => {
		const calls: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, _options) => {
				calls.push(command);
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, { commandPrefix: "cd sub", operations });

		await bash.execute("guard-prefix-cd-record", { command: "git checkout -- ." });

		expect(calls).toEqual(["cd sub\ngit status --porcelain --untracked-files=all", "cd sub\ngit checkout -- ."]);
	});

	it("conservatively refuses relocating git -c config keys", async () => {
		initDirtyGitRepo(testDir);
		const bash = createBashTool(testDir);

		const error = await bash
			.execute("guard-c-core-worktree", { command: "git -c core.worktree=/other/tree reset --hard" })
			.then(
				() => undefined,
				(err: Error) => err,
			);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("changes directory (or repository) first");
	});

	it("executes commands whose discard text sits in a comment", async () => {
		initDirtyGitRepo(testDir);
		const bash = createBashTool(testDir);

		const result = await bash.execute("guard-comment", { command: "echo preparing # git reset --hard" });
		expect((result.content?.[0] as { text?: string } | undefined)?.text).toContain("preparing");
		expect(readModifiedTracked()).toBe("modified\n");
	});

	it("refuses destructive command prefixes instead of probing them", async () => {
		const bash = createBashTool(testDir, { commandPrefix: "git clean -fd" });

		await expect(bash.execute("guard-prefix-discard", { command: "echo hi" })).rejects.toThrow(
			/changes directory \(or repository\) first/,
		);
	});

	it("drops closed-group cds from later open groups' probe chains", async () => {
		const calls: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, _options) => {
				calls.push(command);
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, { operations });

		await bash.execute("guard-group-leak", { command: "(cd a) && (cd b && git reset --hard)" });

		expect(calls).toEqual([
			"cd b && git status --porcelain --untracked-files=all",
			"(cd a) && (cd b && git reset --hard)",
		]);
	});

	it("propagates aborts raised while probing", async () => {
		const operations: BashOperations = {
			exec: async (command, _cwd, _options) => {
				if (command === "git status --porcelain --untracked-files=all") throw new Error("aborted");
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testDir, { operations });

		await expect(bash.execute("guard-abort", { command: "git checkout -- ." })).rejects.toThrow("aborted");
	});

	function readModifiedTracked(): string {
		return readFileSync(join(testDir, "tracked.txt"), "utf-8");
	}
});
