import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { WorktreeSettings } from "../src/core/settings-manager.js";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import {
	createGitWorktree,
	type GitCommandResult,
	type GitCommandRunner,
	resolveWorktreeParentDir,
	runGitCommand,
	sanitizeWorktreeName,
} from "../src/utils/git-worktree.js";
import {
	buildWorktreeSetupCommand,
	DEFAULT_WORKTREE_SETUP_TIMEOUT_MS,
	resolveWorktreeSetupScript,
	resolveWorktreeSetupTimeoutMs,
	runWorktreeSetup,
	type WorktreeSetupCommand,
	WorktreeSetupError,
} from "../src/utils/worktree-setup.js";

const keybindings = new KeybindingsManager();

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

// Raw sequences for the defaults asserted in "binds the worktree prompt to alt+w".
const NEW_WORKTREE_KEY = "\x1bw";
const CANCEL_KEY = "\x1b";

async function initRepo(repoRoot: string): Promise<void> {
	await runGitCommand(["init", "-b", "main"], repoRoot);
	await runGitCommand(["config", "user.email", "test@example.com"], repoRoot);
	await runGitCommand(["config", "user.name", "test"], repoRoot);
	await runGitCommand(["commit", "--allow-empty", "-m", "init"], repoRoot);
}

function ok(stdout = ""): GitCommandResult {
	return { stdout, stderr: "", exitCode: 0 };
}

function createEditorStub(): {
	text: string;
	placeholder: string;
	getText: () => string;
	setText: (value: string) => void;
	setPlaceholder: (value: string) => void;
	handleInput: (data: string) => void;
} {
	const editor = {
		text: "",
		placeholder: "",
		getText: () => editor.text,
		setText: (value: string) => {
			editor.text = value;
		},
		setPlaceholder: (value: string) => {
			editor.placeholder = value;
		},
		handleInput: (data: string) => {
			editor.text += data;
		},
	};
	return editor;
}

function createSettingsStub(worktree: WorktreeSettings = {}): {
	getWorktreeSettings: () => WorktreeSettings;
	getShellPath: () => string | undefined;
} {
	return { getWorktreeSettings: () => worktree, getShellPath: () => undefined };
}

function createViewStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const editor = createEditorStub();
	const self: Record<string, unknown> = {
		editor,
		keybindings,
		persistentState: {},
		rows: [],
		selectedIndex: 0,
		stopped: false,
		creatingNewSession: false,
		worktreePromptActive: false,
		renameTarget: undefined,
		replyTarget: undefined,
		actionModeSearchQuery: undefined,
		pendingDeleteAgent: undefined,
		pendingKillSubagent: undefined,
		options: {
			config: { cwd: "/repo" },
			uiServices: { getInitialCwd: () => "/repo", settingsManager: createSettingsStub() },
		},
		ui: { requestRender: vi.fn() },
		setStatusMessage: vi.fn(),
		clearStickyStatusMessage: vi.fn(),
		clearCtrlCExitHint: vi.fn(),
		clearDeleteConfirmation: vi.fn(),
		rebuildRows: vi.fn(),
		setReplyTarget: vi.fn(),
		createNewSession: vi.fn(async () => true),
		handleListNavigation: vi.fn(() => false),
		queryChanged: vi.fn(),
		isSearchCursorAtEnd: vi.fn(() => true),
		getSavedSessionCwd() {
			return invoke("getSavedSessionCwd", self);
		},
		confirmWorktree(value: string) {
			return invoke("confirmWorktree", self, value);
		},
		enterWorktreeMode() {
			return invoke("enterWorktreeMode", self);
		},
		exitWorktreeMode() {
			return invoke("exitWorktreeMode", self);
		},
		createWorktreeSession(name: string) {
			return invoke("createWorktreeSession", self, name);
		},
		...overrides,
	};
	return self;
}

// A developer-set override must not change the expected default locations.
beforeEach(() => {
	vi.stubEnv("PRIME_AGENT_WORKTREE_DIR", "");
	vi.stubEnv("PRIME_AGENT_WORKTREE_SETUP", "");
	vi.stubEnv("PRIME_AGENT_WORKTREE_SETUP_TIMEOUT_MS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("git worktree helper", () => {
	it("sanitizes names into a single path segment", () => {
		expect(sanitizeWorktreeName("  Feature/One two  ")).toBe("Feature-One-two");
		expect(sanitizeWorktreeName("--weird--name--")).toBe("weird-name");
		expect(() => sanitizeWorktreeName("  ///  ")).toThrow(/Invalid worktree name/);
	});

	it("resolves the worktree parent directory in order", () => {
		expect(resolveWorktreeParentDir("/repo")).toBe(join("/repo", ".worktrees"));
		expect(resolveWorktreeParentDir("/repo", "/trees")).toBe("/trees");
		expect(resolveWorktreeParentDir("/repo", "trees")).toBe(join("/repo", "trees"));
	});

	it("creates a branch and worktree under the repo root", async () => {
		const calls: string[][] = [];
		const runGit: GitCommandRunner = async (args) => {
			calls.push([...args]);
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/repo\n");
			if (args[0] === "worktree" && args[1] === "list") return ok("worktree /repo\nbranch refs/heads/main\n");
			if (args[0] === "rev-parse") return { stdout: "", stderr: "", exitCode: 1 };
			return ok();
		};

		const result = await createGitWorktree({ cwd: "/repo/src", name: "my feature", runGit, pathExists: () => false });

		expect(result).toEqual({
			path: join("/repo", ".worktrees", "my-feature"),
			branch: "my-feature",
			repoRoot: "/repo",
			created: true,
		});
		expect(calls).toContainEqual(["worktree", "add", join("/repo", ".worktrees", "my-feature"), "-b", "my-feature"]);
	});

	it("attaches an existing branch instead of creating one", async () => {
		const calls: string[][] = [];
		const runGit: GitCommandRunner = async (args) => {
			calls.push([...args]);
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/repo\n");
			if (args[0] === "worktree" && args[1] === "list") return ok("worktree /repo\n");
			return ok();
		};

		const result = await createGitWorktree({ cwd: "/repo", name: "existing", runGit, pathExists: () => false });

		expect(result.created).toBe(true);
		expect(calls).toContainEqual(["worktree", "add", join("/repo", ".worktrees", "existing"), "existing"]);
	});

	it("reuses a worktree already registered at the target path", async () => {
		const target = join("/repo", ".worktrees", "reuse");
		const runGit: GitCommandRunner = async (args) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/repo\n");
			if (args[0] === "worktree" && args[1] === "list") {
				return ok(`worktree /repo\n\nworktree ${target}\nbranch refs/heads/reuse\n`);
			}
			throw new Error(`unexpected git call: ${args.join(" ")}`);
		};

		const result = await createGitWorktree({ cwd: "/repo", name: "reuse", runGit, pathExists: () => true });

		expect(result).toEqual({ path: target, branch: "reuse", repoRoot: "/repo", created: false });
	});

	it("rejects an occupied path that is not a worktree", async () => {
		const runGit: GitCommandRunner = async (args) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/repo\n");
			return ok("worktree /repo\n");
		};

		await expect(createGitWorktree({ cwd: "/repo", name: "taken", runGit, pathExists: () => true })).rejects.toThrow(
			/already exists and is not a worktree/,
		);
	});

	it("reports git failures from worktree add", async () => {
		const runGit: GitCommandRunner = async (args) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/repo\n");
			if (args[0] === "worktree" && args[1] === "list") return ok("worktree /repo\n");
			if (args[0] === "rev-parse") return { stdout: "", stderr: "", exitCode: 1 };
			return { stdout: "", stderr: "fatal: invalid reference", exitCode: 128 };
		};

		await expect(createGitWorktree({ cwd: "/repo", name: "bad", runGit, pathExists: () => false })).rejects.toThrow(
			/fatal: invalid reference/,
		);
	});

	it("fails when the directory is not a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-worktree-"));
		try {
			await expect(createGitWorktree({ cwd: dir, name: "any", runGit: runGitCommand })).rejects.toThrow(
				/Not a git repository/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("worktree setup script", () => {
	it("prefers the env override over the configured script", () => {
		expect(resolveWorktreeSetupScript("scripts/setup.sh")).toBe("scripts/setup.sh");
		expect(resolveWorktreeSetupScript(undefined)).toBeUndefined();
		vi.stubEnv("PRIME_AGENT_WORKTREE_SETUP", "make bootstrap");
		expect(resolveWorktreeSetupScript("scripts/setup.sh")).toBe("make bootstrap");
	});

	it("resolves the timeout from env, settings, then the default", () => {
		expect(resolveWorktreeSetupTimeoutMs(undefined)).toBe(DEFAULT_WORKTREE_SETUP_TIMEOUT_MS);
		expect(resolveWorktreeSetupTimeoutMs(1000)).toBe(1000);
		vi.stubEnv("PRIME_AGENT_WORKTREE_SETUP_TIMEOUT_MS", "2500");
		expect(resolveWorktreeSetupTimeoutMs(1000)).toBe(2500);
	});

	it("runs an existing file as a script and anything else as a shell command", () => {
		const exists = (path: string) => path === join("/repo", "scripts", "setup.sh");
		expect(buildWorktreeSetupCommand("scripts/setup.sh", "/repo", exists)).toBe(
			`"${join("/repo", "scripts", "setup.sh")}"`,
		);
		expect(buildWorktreeSetupCommand("cp ../.env .env", "/repo", exists)).toBe("cp ../.env .env");
	});

	it("runs the script in the worktree with the worktree env exported", async () => {
		const seen: WorktreeSetupCommand[] = [];
		const written: { path: string; contents: string }[] = [];
		const result = await runWorktreeSetup({
			script: "setup",
			worktreePath: "/repo/.worktrees/feature",
			branch: "feature",
			repoRoot: "/repo",
			logPath: "/logs/worktree-setup-feature.log",
			fileExists: () => false,
			writeLog: (path, contents) => written.push({ path, contents }),
			runSetup: async (command) => {
				seen.push(command);
				return { stdout: "ready\n", stderr: "", exitCode: 0, timedOut: false };
			},
		});

		expect(seen[0]?.cwd).toBe("/repo/.worktrees/feature");
		expect(seen[0]?.command).toBe("setup");
		expect(seen[0]?.env.PRIME_AGENT_WORKTREE_PATH).toBe("/repo/.worktrees/feature");
		expect(seen[0]?.env.PRIME_AGENT_WORKTREE_BRANCH).toBe("feature");
		expect(seen[0]?.env.PRIME_AGENT_WORKTREE_REPO_ROOT).toBe("/repo");
		expect(seen[0]?.timeoutMs).toBe(DEFAULT_WORKTREE_SETUP_TIMEOUT_MS);
		expect(written[0]?.path).toBe("/logs/worktree-setup-feature.log");
		expect(written[0]?.contents).toContain("ready");
		expect(result.logPath).toBe("/logs/worktree-setup-feature.log");
	});

	it("reports the exit code, the last stderr lines, and the log path", async () => {
		const error = await runWorktreeSetup({
			script: "setup",
			worktreePath: "/worktree",
			branch: "feature",
			repoRoot: "/repo",
			logPath: "/logs/setup.log",
			fileExists: () => false,
			writeLog: () => undefined,
			runSetup: async () => ({ stdout: "", stderr: "line1\nboom: no free port\n", exitCode: 3, timedOut: false }),
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(WorktreeSetupError);
		const failure = error as WorktreeSetupError;
		expect(failure.timedOut).toBe(false);
		expect(failure.logPath).toBe("/logs/setup.log");
		expect(failure.message).toContain("exited with code 3");
		expect(failure.message).toContain("boom: no free port");
		expect(failure.message).toContain("/logs/setup.log");
	});

	it("reports a timeout", async () => {
		const error = await runWorktreeSetup({
			script: "sleep 100",
			worktreePath: "/worktree",
			branch: "feature",
			repoRoot: "/repo",
			timeoutMs: 50,
			fileExists: () => false,
			runSetup: async () => ({ stdout: "", stderr: "", exitCode: 1, timedOut: true }),
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(WorktreeSetupError);
		expect((error as WorktreeSetupError).timedOut).toBe(true);
		expect((error as WorktreeSetupError).message).toContain("timed out after 50ms");
	});
});

describe("AgentsViewMode worktree prompt", () => {
	beforeAll(() => setKeybindings(keybindings));
	afterEach(() => vi.restoreAllMocks());

	it("binds the worktree prompt to alt+w without colliding with other agents-view actions", () => {
		expect(keybindings.getKeys("app.agents.newWorktree")).toEqual(["alt+w"]);
		for (const id of ["app.agents.new", "app.agents.delete", "app.agents.rename", "app.agents.reply"] as const) {
			expect(keybindings.getKeys(id)).not.toContain("alt+w");
		}
	});

	it("opens the inline prompt on the configured keybinding", () => {
		const self = createViewStub();

		invoke("handleInput", self, NEW_WORKTREE_KEY);

		expect(self.worktreePromptActive).toBe(true);
		const editor = self.editor as ReturnType<typeof createEditorStub>;
		expect(editor.placeholder).toBe("Name the new git worktree branch");
		expect(editor.text).toBe("");
	});

	it("cancels the prompt and restores the search query", () => {
		const self = createViewStub();
		const editor = self.editor as ReturnType<typeof createEditorStub>;
		editor.setText("query");

		invoke("handleInput", self, NEW_WORKTREE_KEY);
		expect(self.actionModeSearchQuery).toBe("query");

		invoke("handleInput", self, CANCEL_KEY);

		expect(self.worktreePromptActive).toBe(false);
		expect(editor.text).toBe("query");
		expect(editor.placeholder).toBe("Search sessions");
	});

	it("creates the worktree and a session rooted in it on confirm", async () => {
		const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "prime-worktree-repo-")));
		try {
			await initRepo(repoRoot);

			const createNewSession = vi.fn(async () => true);
			const self = createViewStub({
				createNewSession,
				options: {
					config: { cwd: repoRoot },
					uiServices: { getInitialCwd: () => repoRoot, settingsManager: createSettingsStub() },
				},
			});

			invoke("handleInput", self, NEW_WORKTREE_KEY);
			await invoke("submit", self, "My Feature");

			expect(self.worktreePromptActive).toBe(false);
			expect(createNewSession).toHaveBeenCalledWith({
				cwd: join(repoRoot, ".worktrees", "My-Feature"),
			});
			const listed = await runGitCommand(["worktree", "list", "--porcelain"], repoRoot);
			expect(listed.stdout).toContain(join(repoRoot, ".worktrees", "My-Feature"));
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("runs the configured setup script in the new worktree before starting the session", async () => {
		const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "prime-worktree-setup-")));
		try {
			await initRepo(repoRoot);
			vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", join(repoRoot, "agent-dir"));
			const createNewSession = vi.fn(async () => true);
			const self = createViewStub({
				createNewSession,
				options: {
					config: { cwd: repoRoot },
					uiServices: {
						getInitialCwd: () => repoRoot,
						settingsManager: createSettingsStub({
							setupScript: 'printf "%s" "$PRIME_AGENT_WORKTREE_BRANCH" > branch.txt',
						}),
					},
				},
			});

			invoke("handleInput", self, NEW_WORKTREE_KEY);
			await invoke("submit", self, "setup-me");

			const worktreePath = join(repoRoot, ".worktrees", "setup-me");
			expect(readFileSync(join(worktreePath, "branch.txt"), "utf-8")).toBe("setup-me");
			expect(createNewSession).toHaveBeenCalledWith({ cwd: worktreePath });
			const statuses = (self.setStatusMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
			expect(statuses).toContain("Running worktree setup...");
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("keeps the worktree but skips the session when the setup script fails", async () => {
		const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "prime-worktree-setup-fail-")));
		try {
			await initRepo(repoRoot);
			vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", join(repoRoot, "agent-dir"));
			const createNewSession = vi.fn(async () => true);
			const self = createViewStub({
				createNewSession,
				options: {
					config: { cwd: repoRoot },
					uiServices: {
						getInitialCwd: () => repoRoot,
						settingsManager: createSettingsStub({ setupScript: "echo no-free-port >&2; exit 3" }),
					},
				},
			});

			invoke("handleInput", self, NEW_WORKTREE_KEY);
			await invoke("submit", self, "broken-setup");

			expect(createNewSession).not.toHaveBeenCalled();
			expect(existsSync(join(repoRoot, ".worktrees", "broken-setup"))).toBe(true);
			const statuses = (self.setStatusMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
			const failure = statuses.find((status) => status.startsWith("Failed to run worktree setup"));
			expect(failure).toBeDefined();
			expect(failure).toContain("no-free-port");
			expect(failure).toContain("worktree-setup-broken-setup.log");
			expect(
				readFileSync(join(repoRoot, "agent-dir", "logs", "worktree-setup-broken-setup.log"), "utf-8"),
			).toContain("no-free-port");
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("reports a status message when the directory is not a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-worktree-plain-"));
		try {
			const createNewSession = vi.fn(async () => true);
			const self = createViewStub({
				createNewSession,
				options: {
					config: { cwd: dir },
					uiServices: { getInitialCwd: () => dir, settingsManager: createSettingsStub() },
				},
			});

			invoke("handleInput", self, NEW_WORKTREE_KEY);
			await invoke("submit", self, "feature");

			expect(createNewSession).not.toHaveBeenCalled();
			const setStatusMessage = self.setStatusMessage as ReturnType<typeof vi.fn>;
			const messages = setStatusMessage.mock.calls.map((call) => String(call[0]));
			expect(messages.some((message) => message.includes("Failed to create worktree"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
