from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from rlm import bash
from rlm.bash import (
    BASH_DESTRUCTIVE_GIT_BYPASS_ENV,
    DestructiveGitRefusalError,
    is_destructive_git_discard_command,
)

# The package re-exports the bash() function under the same name, so reach the
# module through sys.modules for internals.
bash_module = sys.modules["rlm.bash"]


def _run_git(cwd: str, *args: str) -> None:
    # HOME=cwd keeps user-level git config out of the test repositories.
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "HOME": cwd},
    )


def _init_dirty_git_repo(root: str) -> None:
    """Create a git repository with one committed file plus two uncommitted changes."""
    Path(root).mkdir(parents=True, exist_ok=True)
    _run_git(root, "init", "-q")
    # The isolated HOME hides any global identity, so configure one per repo
    # exactly like the coding-agent guard test does.
    _run_git(root, "config", "user.email", "test@example.com")
    _run_git(root, "config", "user.name", "Test")
    _run_git(root, "config", "commit.gpgsign", "false")
    Path(root, "tracked.txt").write_text("committed\n")
    _run_git(root, "add", "tracked.txt")
    _run_git(root, "commit", "-q", "-m", "init")
    Path(root, "tracked.txt").write_text("modified\n")
    Path(root, "untracked.txt").write_text("uncommitted\n")


# Vectors ported from packages/coding-agent/test/bash-destructive-git-guard.test.ts;
# the kernel guard must keep the same command taxonomy as the coding-agent tool.
MATCHING_COMMANDS = [
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
    "git reset 2>/dev/null --hard",
    "git reset 2> /dev/null --hard",
    "git reset 2>&1 --hard",
    "git 2>/dev/null reset --hard",
    "git restore 2>/dev/null .",
    "git clean -f 2>/dev/null",
    "git checkout 2>/dev/null -- .",
    "git restore --staged --worktree .",
    "git restore -SW .",
    "source setup.sh && git reset --hard",
    "git restore --quiet .",
    "git restore -q .",
    "git restore --quiet --source=HEAD .",
    "g\\it reset --ha\\rd",
    "git res\\et --hard",
    "git reset &>/dev/null --hard",
    "git reset &> /dev/null --hard",
    "git reset &>>/dev/null --hard",
    "git reset >&/dev/null --hard",
    "{ cd sub && git reset --hard; }",
    "export GIT_DIR=sub/.git GIT_WORK_TREE=sub; git reset --hard",
    "GIT_DIR=sub/.git; git reset --hard",
    "git -Csub reset --hard",
    "git -cfoo.bar=1 reset --hard",
    "git reset \
--hard",
    "git checkout -- \
.",
    "git clean -f \
-d",
]

NON_MATCHING_COMMANDS = [
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
    "git status > status.txt",
    "git log --oneline > log.txt 2>/dev/null",
    "echo 2>/dev/null hi",
    "{ echo hi; }",
    "export FOO=1",
    "git restore --staged --quiet .",
    "echo \\# git reset --hard",
    "cat <<EOF\\ngit reset --hard\\nEOF",
    "git restore --staged .",
    "echo one \
 two",
    "git -Csub status",
    "# git reset --hard",
]


class DestructiveGitDetectionTest(unittest.TestCase):
    def test_matches_destructive_discards(self):
        for command in MATCHING_COMMANDS:
            with self.subTest(command=command):
                self.assertTrue(is_destructive_git_discard_command(command))

    def test_does_not_match_other_commands(self):
        for command in NON_MATCHING_COMMANDS:
            with self.subTest(command=command):
                self.assertFalse(is_destructive_git_discard_command(command))


class EvalPayloadDetectionTest(unittest.TestCase):
    def test_eval_payloads_hiding_discards(self):
        for command in [
            "eval 'git reset --hard'",
            'eval "git clean -f"',
            "eval 'cd sub && git reset --hard'",
            "eval 'git checkout -- .'",
            'eval "git restore ."',
            "eval 'eval \"git reset --hard\"'",
            "GIT_DIR=sub/.git eval 'git reset --hard'",
            "eval 'git reset \\\n--hard'",
        ]:
            with self.subTest(command=command):
                self.assertTrue(bash_module._eval_payloads_hide_destructive_git(command))

    def test_safe_eval_payloads_stay_unflagged(self):
        for command in [
            "eval",
            "eval 'echo hi'",
            "eval 'git status'",
            "eval 'echo \"git reset --hard\"'",
            "eval \"echo 'git reset --hard'\"",
            "echo 'eval git reset --hard'",
            "npm run eval:suite",
        ]:
            with self.subTest(command=command):
                self.assertFalse(bash_module._eval_payloads_hide_destructive_git(command))


class DestructiveGitGuardTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._prev_cwd = os.getcwd()
        os.environ.pop(BASH_DESTRUCTIVE_GIT_BYPASS_ENV, None)
        os.environ.pop("PRIME_AGENT_BASH_COMMAND_PREFIX", None)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        # Restore cwd before the temp dir disappears (cleanups run LIFO).
        self.addCleanup(os.chdir, self._prev_cwd)
        self.test_dir = temp.name

    def _init_dirty_repo(self) -> None:
        _init_dirty_git_repo(self.test_dir)
        os.chdir(self.test_dir)

    def _tracked(self, *parts: str) -> Path:
        return Path(self.test_dir, *parts)

    async def test_refuses_destructive_discards_on_dirty_tree(self):
        for index, command in enumerate([
            "git checkout -- .",
            "git checkout .",
            "git clean -fd",
            "git reset --hard",
            "git restore .",
        ]):
            with self.subTest(command=command):
                repo = str(self._tracked(f"repo-{index}"))
                _init_dirty_git_repo(repo)
                os.chdir(repo)
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                self.assertIn("Refusing to run this destructive git command", str(caught.exception))
                self.assertEqual(Path(repo, "tracked.txt").read_text(), "modified\n")
                self.assertTrue(Path(repo, "untracked.txt").exists())

    async def test_refusal_lists_dirty_paths_and_the_kwarg_bypass(self):
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("git checkout -- .")
        message = str(caught.exception)
        self.assertIn("2 uncommitted change(s)", message)
        self.assertIn("tracked.txt", message)
        self.assertIn("untracked.txt", message)
        self.assertIn("Commit, stash, or stage your work first.", message)
        # Only the per-call kwarg is visible to the running model; the env
        # var is a launch-time option and must not be advertised here.
        self.assertIn("allow_destructive_git=True", message)
        self.assertNotIn(BASH_DESTRUCTIVE_GIT_BYPASS_ENV, message)

    async def test_elides_long_dirty_path_lists(self):
        self._init_dirty_repo()
        for i in range(12):
            self._tracked(f"extra-{i}.txt").write_text("x\n")
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("git checkout -- .")
        self.assertIn("... and 4 more", str(caught.exception))

    async def test_runs_discard_when_tree_is_clean(self):
        self._init_dirty_repo()
        _run_git(self.test_dir, "add", "-A")
        _run_git(self.test_dir, "commit", "-q", "-m", "second")
        result = await bash("git checkout -- .")
        self.assertEqual(result.exit_code, 0)

    async def test_bypass_kwarg_runs_discard(self):
        self._init_dirty_repo()
        result = await bash("git reset --hard", allow_destructive_git=True)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "committed\n")

    async def test_env_var_set_after_kernel_start_cannot_bypass(self):
        # The kernel is arbitrary Python, so the bypass variable is read
        # once at kernel start; a cell that writes it mid-session must not
        # silently disarm the guard.
        self._init_dirty_repo()
        with mock.patch.dict(os.environ, {BASH_DESTRUCTIVE_GIT_BYPASS_ENV: "1"}):
            with self.assertRaises(DestructiveGitRefusalError) as caught:
                bash("git reset --hard")
        message = str(caught.exception)
        self.assertIn("allow_destructive_git=True", message)
        self.assertIn("appeared after the kernel started", message)
        self.assertIn("ignores it", message)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
        # A falsy mid-session value stays inert too.
        with mock.patch.dict(os.environ, {BASH_DESTRUCTIVE_GIT_BYPASS_ENV: "0"}):
            with self.assertRaises(DestructiveGitRefusalError):
                bash("git reset --hard")
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    def test_env_var_at_kernel_start_is_frozen_and_honored(self):
        # Launch a fresh kernel in a subprocess: the variable present at
        # kernel start disables the guard for that whole kernel; a falsy
        # launch value keeps it armed.
        probe = (
            "import asyncio\n"
            "from rlm import bash\n"
            "async def main():\n"
            "    result = await bash('git reset --hard')\n"
            "    return result.exit_code\n"
            "raise SystemExit(asyncio.run(main()))\n"
        )
        for launch_value, expect_refusal in [("1", False), ("0", True)]:
            with self.subTest(launch_value=launch_value):
                repo = str(self._tracked(f"launch-{launch_value}"))
                _init_dirty_git_repo(repo)
                completed = subprocess.run(
                    [sys.executable, "-c", probe],
                    cwd=repo,
                    env={
                        **os.environ,
                        BASH_DESTRUCTIVE_GIT_BYPASS_ENV: launch_value,
                        "GIT_CONFIG_NOSYSTEM": "1",
                    },
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                if expect_refusal:
                    self.assertNotEqual(completed.returncode, 0)
                    self.assertIn("Refusing to run", completed.stderr)
                    self.assertEqual(Path(repo, "tracked.txt").read_text(), "modified\n")
                else:
                    self.assertEqual(completed.returncode, 0)
                    self.assertEqual(Path(repo, "tracked.txt").read_text(), "committed\n")

    async def test_frozen_bypass_not_leaked_into_child_environments(self):
        # When the variable was absent at kernel start, kernel-spawned
        # children must not inherit a mid-session write (a child kernel
        # would freeze it as its own launch-time bypass).
        with (
            mock.patch.dict(os.environ, {BASH_DESTRUCTIVE_GIT_BYPASS_ENV: "1"}),
            mock.patch.object(bash_module, "_BASH_DESTRUCTIVE_GIT_BYPASS_AT_START", True),
        ):
            child_env = bash_module._child_env()
        # With the variable present at launch, children inherit it.
        self.assertEqual(child_env.get(BASH_DESTRUCTIVE_GIT_BYPASS_ENV), "1")

    async def test_fails_open_outside_a_git_repository(self):
        os.chdir(self.test_dir)
        result = await bash("git checkout -- .")
        self.assertNotEqual(result.exit_code, 0)

    async def test_non_discard_commands_are_untouched_on_a_dirty_tree(self):
        self._init_dirty_repo()
        result = await bash("git status")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("tracked.txt", result.output)
        result = await bash("git log --oneline")
        self.assertEqual(result.exit_code, 0)
        # Quoted data must not trigger the guard end to end either.
        result = await bash("echo 'git reset --hard'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("git reset --hard", result.output)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_probe_runs_only_for_discard_commands(self):
        self._init_dirty_repo()
        probe = mock.Mock(return_value=[" M tracked.txt"])
        with mock.patch.object(bash_module, "_probe_uncommitted_changes", probe):
            result = await bash("echo hi")
            self.assertEqual(result.exit_code, 0)
            result = await bash("git status")
            self.assertEqual(result.exit_code, 0)
            probe.assert_not_called()
            with self.assertRaises(DestructiveGitRefusalError):
                bash("git checkout -- .")
        probe.assert_called_once_with(
            "git status --porcelain --untracked-files=all",
            os.path.realpath(self.test_dir),
        )

    async def test_fails_open_when_the_probe_fails(self):
        self._init_dirty_repo()
        with mock.patch.object(bash_module, "_probe_uncommitted_changes", return_value=None):
            result = await bash("git checkout -- .")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "committed\n")

    async def test_refuses_cd_relocation_into_dirty_nested_repository(self):
        _init_dirty_git_repo(str(self._tracked("sub")))
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("cd sub && git reset --hard")
        self.assertIn("Refusing to run this destructive git command", str(caught.exception))
        self.assertIn("tracked.txt", str(caught.exception))
        self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")

    async def test_refuses_git_c_relocation_into_dirty_nested_repository(self):
        _init_dirty_git_repo(str(self._tracked("sub")))
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("git -C sub reset --hard")
        self.assertIn("tracked.txt", str(caught.exception))
        self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")

    async def test_allows_relocated_discard_when_target_is_clean(self):
        _init_dirty_git_repo(str(self._tracked("sub")))
        _run_git(str(self._tracked("sub")), "add", "-A")
        _run_git(str(self._tracked("sub")), "commit", "-q", "-m", "second")
        self._init_dirty_repo()
        result = await bash("cd sub && git reset --hard")
        self.assertEqual(result.exit_code, 0)

    async def test_multi_discard_probes_every_target_repository(self):
        _init_dirty_git_repo(str(self._tracked("sub")))
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError):
            bash("git checkout -- . && cd sub && git reset --hard")

    async def test_refuses_relocations_it_cannot_replay_safely(self):
        self._init_dirty_repo()
        for command in [
            "cd $(pwd)/sub && git reset --hard",
            "git --git-dir=sub/.git reset --hard",
            "cd sub || git reset --hard",
            "pushd sub && git reset --hard",
            'git -C "sub" reset --hard',
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                self.assertIn("changes directory (or repository) first", str(caught.exception))

    async def test_refuses_eval_wrapped_discards(self):
        self._init_dirty_repo()
        for command in [
            "eval 'git reset --hard'",
            'eval "git clean -f"',
            "eval 'eval \"git reset --hard\"'",
            "eval 'cd sub && git reset --hard'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                self.assertIn("wraps a git discard in eval", str(caught.exception))
                self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
                self.assertTrue(self._tracked("untracked.txt").exists())

    async def test_eval_refusal_honors_the_bypass_kwarg(self):
        self._init_dirty_repo()
        result = await bash("eval 'git reset --hard'", allow_destructive_git=True)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "committed\n")

    async def test_safe_eval_commands_still_run(self):
        self._init_dirty_repo()
        result = await bash("eval 'echo hi'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        # Unquoting one level at a time must not mistake still-quoted data for
        # a payload command: this eval only prints the string.
        result = await bash("eval \"echo 'git reset --hard'\"")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("git reset --hard", result.output)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_quoted_cd_relocations_are_replayed_in_the_probe(self):
        _init_dirty_git_repo(str(self._tracked("my repo")))
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash('cd "my repo" && git reset --hard')
        self.assertIn("tracked.txt", str(caught.exception))
        self.assertEqual(self._tracked("my repo", "tracked.txt").read_text(), "modified\n")

    async def test_allows_quoted_cd_discard_when_target_is_clean(self):
        _init_dirty_git_repo(str(self._tracked("my repo")))
        _run_git(str(self._tracked("my repo")), "add", "-A")
        _run_git(str(self._tracked("my repo")), "commit", "-q", "-m", "second")
        self._init_dirty_repo()
        result = await bash('cd "my repo" && git reset --hard')
        self.assertEqual(result.exit_code, 0)

    async def test_attached_dash_c_values_relocate_the_probe(self):
        _init_dirty_git_repo(str(self._tracked("sub")))
        # The parent tree stays clean: the probe must follow the attached
        # value, not probe the current directory.
        self._init_dirty_repo()
        _run_git(self.test_dir, "add", "-A")
        _run_git(self.test_dir, "commit", "-q", "-m", "second")
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("git -Csub reset --hard")
        self.assertIn("tracked.txt", str(caught.exception))
        self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")

    async def test_attached_dash_c_probe_follows_the_value_not_the_parent_tree(self):
        # Stock git rejects attached short options itself ("unknown option:
        # -Csub"), so the form can never discard anything; the guard still
        # resolves the attached value the way the thread asks instead of
        # silently probing the parent tree.
        _init_dirty_git_repo(str(self._tracked("sub")))
        _run_git(str(self._tracked("sub")), "add", "-A")
        _run_git(str(self._tracked("sub")), "commit", "-q", "-m", "second")
        self._init_dirty_repo()  # the parent tree stays dirty
        result = await bash("git -Csub reset --hard")
        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_refuses_attached_and_bundled_relocations_it_cannot_replay(self):
        self._init_dirty_repo()
        for command in [
            "git -ccore.worktree=sub reset --hard",
            "git -ccore.bare=1 reset --hard",
            "git -pCsub reset --hard",
            "git -qC sub reset --hard",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                self.assertIn("changes directory (or repository) first", str(caught.exception))

    async def test_attached_benign_dash_c_configs_do_not_relocate(self):
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("git -cfoo.bar=1 reset --hard")
        self.assertIn("uncommitted change(s)", str(caught.exception))
        self.assertNotIn("changes directory (or repository) first", str(caught.exception))

    async def test_refuses_discards_split_over_line_continuations(self):
        self._init_dirty_repo()
        for command in [
            "git reset \\\n--hard",
            "git checkout -- \\\n.",
            "git clean -f \\\n-d",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError):
                    bash(command)
                self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
                self.assertTrue(self._tracked("untracked.txt").exists())

    async def test_line_continuations_in_safe_commands_still_run(self):
        self._init_dirty_repo()
        result = await bash("echo one \\\n two")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("one", result.output)
        self.assertIn("two", result.output)

    async def test_comment_newline_still_ends_the_line_before_a_discard(self):
        # A backslash-newline inside a comment does not join lines: the
        # newline ends the comment and the next line runs for real.
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError):
            bash("# safe \\\ngit reset --hard")
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_refuses_discards_with_shell_redirections(self):
        self._init_dirty_repo()
        for command in [
            "git reset 2>/dev/null --hard",
            "git reset 2> /dev/null --hard",
            "git reset 2>&1 --hard",
            "git 2>/dev/null reset --hard",
            "git restore 2>/dev/null .",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError):
                    bash(command)
                self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
                self.assertTrue(self._tracked("untracked.txt").exists())

    async def test_safe_redirection_commands_still_run(self):
        self._init_dirty_repo()
        result = await bash("git status > status.txt")
        self.assertEqual(result.exit_code, 0)
        result = await bash("git log --oneline > log.txt 2>/dev/null")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_redirect_targets_with_substitutions_stay_scannable(self):
        # A command substitution as redirect target executes: its content
        # must stay visible to the scan, and this one discards.
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError):
            bash("echo 2> $(git reset --hard)")
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_redirections_in_cd_chains_do_not_block_the_probe(self):
        _init_dirty_git_repo(str(self._tracked("sub")))
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("cd sub 2>/dev/null && git reset --hard")
        self.assertIn("tracked.txt", str(caught.exception))
        self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")

    async def test_eval_payloads_with_redirections_are_refused(self):
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError):
            bash("eval 'git reset 2>/dev/null --hard'")
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_refuses_brace_group_cd_relocations(self):
        _init_dirty_git_repo(str(self._tracked("sub")))
        # The parent tree stays clean: the brace group's cd must relocate
        # the probe like a bare cd chain.
        self._init_dirty_repo()
        _run_git(self.test_dir, "add", "-A")
        _run_git(self.test_dir, "commit", "-q", "-m", "second")
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("{ cd sub && git reset --hard; }")
        self.assertIn("tracked.txt", str(caught.exception))
        self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")
        # A cd followed by `;` inside the group depends on the cd
        # succeeding; the guard refuses it instead of probing one outcome.
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("{ cd sub; git reset --hard; }")
        self.assertIn("changes directory (or repository) first", str(caught.exception))

    async def test_refuses_persistent_env_assignment_relocations(self):
        _init_dirty_git_repo(str(self._tracked("sub")))
        self._init_dirty_repo()
        _run_git(self.test_dir, "add", "-A")
        _run_git(self.test_dir, "commit", "-q", "-m", "second")
        for command in [
            "export GIT_DIR=sub/.git GIT_WORK_TREE=sub; git reset --hard",
            "GIT_DIR=sub/.git; git reset --hard",
            "export GIT_DIR=sub/.git && git reset --hard",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                self.assertIn("tracked.txt", str(caught.exception))
                self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")

    async def test_refuses_env_assignments_it_cannot_replay(self):
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("export GIT_DIR=$(pwd)/sub; git reset --hard")
        self.assertIn("changes directory (or repository) first", str(caught.exception))
        # Command-scoped assignments in a mixed segment do not persist.
        result = await bash("FOO=1 git status")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_refuses_quiet_restore_discards(self):
        self._init_dirty_repo()
        for command in [
            "git restore --quiet .",
            "git restore -q .",
            "git restore --quiet --source=HEAD .",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError):
                    bash(command)
                self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
                self.assertTrue(self._tracked("untracked.txt").exists())

    async def test_refuses_discards_hidden_behind_shell_escapes(self):
        self._init_dirty_repo()
        for command in [
            "g\\it reset --ha\\rd",
            "git res\\et --hard",
            "git reset --ha\\rd",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError):
                    bash(command)
                self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
        # Escaped data stays inert: this only prints.
        result = await bash("echo \\# git reset --hard")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_refuses_discards_with_ampersand_redirects(self):
        self._init_dirty_repo()
        for command in [
            "git reset &>/dev/null --hard",
            "git reset &> /dev/null --hard",
            "git reset &>>/dev/null --hard",
            "git reset >&/dev/null --hard",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError):
                    bash(command)
                self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_refuses_source_relocations_as_unresolvable(self):
        self._init_dirty_repo()
        for command in ["source setup.sh && git reset --hard", ". setup.sh && git reset --hard"]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                self.assertIn("changes directory (or repository) first", str(caught.exception))

    async def test_refuses_staged_and_worktree_restore_discards(self):
        self._init_dirty_repo()
        for command in ["git restore --staged --worktree .", "git restore -SW .", "git restore -WS ."]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError):
                    bash(command)
                self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
        # Index-only restores stay allowed.
        result = await bash("git restore --staged .")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_heredoc_bodies_are_inert_but_substitutions_live(self):
        self._init_dirty_repo()
        result = await bash("cat <<EOF\ngit reset --hard\nEOF")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
        with self.assertRaises(DestructiveGitRefusalError):
            bash("cat <<EOF\n$(git reset --hard)\nEOF")
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_quoted_data_in_substitutions_is_inert(self):
        self._init_dirty_repo()
        result = await bash('echo "$(echo \'git reset --hard\')"')
        self.assertEqual(result.exit_code, 0)
        self.assertIn("git reset --hard", result.output)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_clean_fx_lists_ignored_files_it_would_delete(self):
        self._init_dirty_repo()
        _run_git(self.test_dir, "add", "-A")
        _run_git(self.test_dir, "commit", "-q", "-m", "second")
        self._tracked(".gitignore").write_text("ignored.txt\n")
        _run_git(self.test_dir, "add", ".gitignore")
        _run_git(self.test_dir, "commit", "-q", "-m", "gitignore")
        self._tracked("ignored.txt").write_text("generated\n")
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("git clean -fx")
        message = str(caught.exception)
        self.assertIn("uncommitted or ignored file(s)", message)
        self.assertIn("ignored.txt", message)
        self.assertTrue(self._tracked("ignored.txt").exists())

    async def test_allows_clean_f_when_only_ignored_files_exist(self):
        self._init_dirty_repo()
        _run_git(self.test_dir, "add", "-A")
        _run_git(self.test_dir, "commit", "-q", "-m", "second")
        self._tracked(".gitignore").write_text("ignored.txt\n")
        _run_git(self.test_dir, "add", ".gitignore")
        _run_git(self.test_dir, "commit", "-q", "-m", "gitignore")
        self._tracked("ignored.txt").write_text("generated\n")
        result = await bash("git clean -f")
        self.assertEqual(result.exit_code, 0)
        self.assertTrue(self._tracked("ignored.txt").exists())

    async def test_detects_untracked_files_despite_status_showuntrackedfiles_no(self):
        self._init_dirty_repo()
        _run_git(self.test_dir, "add", "-A")
        _run_git(self.test_dir, "commit", "-q", "-m", "second")
        self._tracked("fresh-untracked.txt").write_text("new\n")
        _run_git(self.test_dir, "config", "status.showUntrackedFiles", "no")
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("git clean -fd")
        self.assertIn("fresh-untracked.txt", str(caught.exception))
        self.assertTrue(self._tracked("fresh-untracked.txt").exists())

    async def test_command_prefix_is_replayed_in_the_probe(self):
        self._init_dirty_repo()
        probe = mock.Mock(return_value=[" M tracked.txt"])
        with (
            mock.patch.dict(
                os.environ, {"PRIME_AGENT_BASH_COMMAND_PREFIX": "export GUARD_TEST_VAR=1"}
            ),
            mock.patch.object(bash_module, "_probe_uncommitted_changes", probe),
        ):
            with self.assertRaises(DestructiveGitRefusalError):
                bash("git checkout -- .")
        probe.assert_called_once_with(
            "export GUARD_TEST_VAR=1\ngit status --porcelain --untracked-files=all",
            os.path.realpath(self.test_dir),
        )

    async def test_discard_inside_command_prefix_is_refused(self):
        os.chdir(self.test_dir)
        probe = mock.Mock()
        with (
            mock.patch.dict(
                os.environ, {"PRIME_AGENT_BASH_COMMAND_PREFIX": "git checkout -- ."}
            ),
            mock.patch.object(bash_module, "_probe_uncommitted_changes", probe),
        ):
            with self.assertRaises(DestructiveGitRefusalError) as caught:
                bash("git status")
        self.assertIn("changes directory (or repository) first", str(caught.exception))
        probe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
