import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import {
	createGitWorktree,
	type GitCommandResult,
	type GitCommandRunner,
	resolveWorktreeParentDir,
	runGitCommand,
	sanitizeWorktreeName,
} from "../src/utils/git-worktree.js";

const keybindings = new KeybindingsManager();

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

// Raw sequences for the defaults asserted in "binds the worktree prompt to alt+w".
const NEW_WORKTREE_KEY = "\x1bw";
const CANCEL_KEY = "\x1b";

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
		options: { config: { cwd: "/repo" }, uiServices: { getInitialCwd: () => "/repo" } },
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
beforeEach(() => vi.stubEnv("PRIME_AGENT_WORKTREE_DIR", ""));
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
			await runGitCommand(["init", "-b", "main"], repoRoot);
			await runGitCommand(["config", "user.email", "test@example.com"], repoRoot);
			await runGitCommand(["config", "user.name", "test"], repoRoot);
			await runGitCommand(["commit", "--allow-empty", "-m", "init"], repoRoot);

			const createNewSession = vi.fn(async () => true);
			const self = createViewStub({
				createNewSession,
				options: { config: { cwd: repoRoot }, uiServices: { getInitialCwd: () => repoRoot } },
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

	it("reports a status message when the directory is not a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-worktree-plain-"));
		try {
			const createNewSession = vi.fn(async () => true);
			const self = createViewStub({
				createNewSession,
				options: { config: { cwd: dir }, uiServices: { getInitialCwd: () => dir } },
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
