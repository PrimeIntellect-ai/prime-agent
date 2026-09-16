from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from rlm import bash
from rlm.bash import (
    BASH_DESTRUCTIVE_GIT_BYPASS_ENV,
    BASH_DESTRUCTIVE_RM_BYPASS_ENV,
    DestructiveGitRefusalError,
    DestructiveRmRefusalError,
    is_destructive_git_discard_command,
    is_recursive_force_rm_command,
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
# the kernel guard keeps at least that command taxonomy and is deliberately
# stricter (the coding-agent guard still allows `"git" reset --hard`,
# `G=git; $G reset --hard`, `git restore --source HEAD .`, `-qs HEAD .`,
# `git restore --staged --worktree .` and `git restore --quiet .`).
MATCHING_COMMANDS = [
    'git checkout -- .', 'git checkout .', 'git checkout HEAD -- .', 'git restore .', 'git restore --source=HEAD~1 .', 'git clean -f',
    'git clean -fd', 'git clean -fdx', 'git clean -d', 'git clean', 'git -c clean.requireForce=false clean', 'git clean --force',
    'git checkout --pathspec-from-file=ps.txt', 'git checkout HEAD --pathspec-from-file=ps.txt', 'git reset --hard', 'git reset --hard HEAD~1',
    'git restore --pathspec-from-file=ps.txt', 'git restore -s HEAD --pathspec-from-file=ps.txt', 'git restore --staged --worktree --pathspec-from-file=-',
    "G='echo hi'; G='git reset --hard' H=\"$G\"; $H", 'git config clean.requireForce false && git clean',
    'git checkout -b tmp 2>/dev/null; git checkout -- .', 'git checkout main && git reset --hard', 'echo start\ngit clean -fd',
    'npm test & git clean -fd &', 'git checkout :/', 'git checkout -- :/', 'git checkout HEAD -- :/', 'git restore :/', 'git restore -s@ .',
    'git restore -s@ :/', 'git restore --source=HEAD :/', 'git restore -s HEAD~1 :/', 'git restore -s STASH .', 'git restore -sSTASH .',
    'git restore --source HEAD .', 'git restore -qs HEAD .', 'git restore -Ws HEAD .', 'git restore --no-overlay .', 'git restore --overlay .',
    'git restore --ignore-unmerged .', 'git restore --recurse-submodules .', 'git restore -- .', 'git checkout -- ./', 'git checkout ./',
    'git restore ./', 'git -C sub reset --hard', 'git --git-dir=sub/.git reset --hard', 'git reset -q --hard', 'git reset --no-refresh --hard',
    'git -C repo -C nested reset --hard', 'GIT_DIR=sub/.git git reset --hard', 'GIT_DIR=sub/.git GIT_WORK_TREE=sub git reset --hard',
    'git checkout -f -- .', 'git checkout --theirs -- .', 'git checkout -m .', 'git checkout --conflict=diff3 .', 'git checkout HEAD .',
    'git checkout HEAD~1 -- .', 'git checkout origin/main .', 'git checkout -f main', 'git checkout --force main', 'git clean -f -- -n',
    'git reset 2>/dev/null --hard', 'git reset 2> /dev/null --hard', 'git reset 2>&1 --hard', 'git 2>/dev/null reset --hard',
    'git restore 2>/dev/null .', 'git clean -f 2>/dev/null', 'git checkout 2>/dev/null -- .', 'git restore --staged --worktree .',
    'git restore -SW .', 'source setup.sh && git reset --hard', 'git restore --quiet .', 'git restore -q .', 'git restore --quiet --source=HEAD .',
    'g\\it reset --ha\\rd', 'git res\\et --hard', '"git" reset --hard', "g'it' reset --hard", 'G=git; $G reset --hard', 'G=git; ${G} reset --hard',
    'G=git; echo G=other; $G reset --hard', "G=git; printf '%s' G=other; $G reset --hard", 'G=git; # G=other\n$G reset --hard',
    'FOO=1 cd sub && git reset --hard', '/usr/bin/git reset --hard', './git reset --hard', "G='git reset --hard'; $G", 'G="git restore ."; $G',
    'G="it\'s # "; $G git reset --hard', "echo 'git' 'reset' '--hard'", 'git reset &>/dev/null --hard', 'git reset &> /dev/null --hard',
    'git reset &>>/dev/null --hard', 'git reset >&/dev/null --hard', '{ cd sub && git reset --hard; }', 'export GIT_DIR=sub/.git GIT_WORK_TREE=sub; git reset --hard',
    'for i in 1; do export GIT_DIR=sub/.git GIT_WORK_TREE=sub; git reset --hard; done', 'GIT_DIR=sub/.git; git reset --hard',
    'git -Csub reset --hard', 'git -cfoo.bar=1 reset --hard', 'git reset \\\n--hard', 'git checkout -- \\\n.', 'git clean -f \\\n-d',
    'cat <<EOF ; git reset --hard\nEOF', 'cat <<EOF && git reset --hard\nEOF', 'declare -x G=git; $G reset --hard',
    'readonly G=git; $G reset --hard', 'export -n G=git; $G reset --hard', 'G=other; command export G=git; $G reset --hard',
    "X=git Y='-C sub reset --hard'; $X $Y", "G=git; H='-C sub'; $G $H reset --hard", 'G=git; G=other git status; $G reset --hard',
    'G=git; G=other git; $G reset --hard', 'echo "$(echo ")")"; git reset --hard', 'V="$(echo ")")"; git reset --hard',
    'shopt -s expand_aliases\nalias g=git\ng reset --hard', 'alias g=git\ng reset --hard', 'alias echo=git\necho reset --hard',
    'alias git=echo\ngit reset --hard', "shopt -s expand_aliases\nalias g='git reset --hard'\nunalias -n g\ng",
]

NON_MATCHING_COMMANDS = [
    'git status', 'git log --oneline', 'git checkout -b new-branch', 'git checkout main', 'git checkout -m main', 'git checkout -b newbranch .',
    'git checkout -- single-file.txt', "echo 'git reset --hard'", 'git commit -m "git reset --hard"', 'echo "git clean -fd"',
    'echo preparing # git reset --hard', 'git checkout ./nested', 'git restore --staged .', 'git restore --staged :/', 'git restore single-file.txt',
    'git clean -n', 'git clean -n -f .', 'git clean --dry-run', 'git restore --staged --pathspec-from-file=ps.txt', 'git reset',
    'git reset --soft HEAD~1', 'git stash', 'git add .', "G='git reset --hard'; G='echo hi' H=\"$G\"; $H",
    'echo hello world', 'npm run check', 'git status > status.txt', 'git log --oneline > log.txt 2>/dev/null', 'echo 2>/dev/null hi', '{ echo hi; }',
    'export FOO=1', 'git restore --staged --quiet .', 'echo \\# git reset --hard', 'cat <<EOF\\ngit reset --hard\\nEOF', 'echo one  two',
    'git -Csub status', '# git reset --hard', '$G reset --hard', 'G=git; echo x; G=other; $G reset --hard', "cat <<'EOF'\n$(git reset --hard)\nEOF",
    'cat <<"EOF"\n$(git reset --hard)\nEOF', "echo eval 'git reset --hard'", "G='git clean -n'; $G", "G='echo hi'; $G",
    'G=git; command export G=other; $G reset --hard', 'shopt -s expand_aliases; alias g=git; g status', "alias g='echo hi'\ng reset --hard",
    'alias g=$X\ng reset --hard', 'if true; then export GIT_DIR=sub/.git GIT_WORK_TREE=sub; fi', 'for i in 1; do echo hi; done', "# 'git' reset --hard",
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
        # Repeated option tokens made the shared option and restore-option
        # regexes re-partition exponentially; each row ran for tens of minutes
        # before the fix.
        for pathological in [
            "git " + " ".join(["-x"] * 60) + " status",
            "git " + " ".join(["--x"] * 60) + " status",
            "git restore " + "-s " * 60 + "file.txt",
        ]:
            start = time.monotonic()
            self.assertFalse(is_destructive_git_discard_command(pathological))
            self.assertLess(time.monotonic() - start, 5.0)


class EvalPayloadDetectionTest(unittest.TestCase):
    def test_eval_payloads_hiding_discards(self):
        for command in [
            "eval 'git reset --hard'", 'eval "git clean -f"', "eval 'cd sub && git reset --hard'", "eval 'git checkout -- .'",
            'eval "git restore ."', 'eval \'eval "git reset --hard"\'', "GIT_DIR=sub/.git eval 'git reset --hard'", "eval 'git reset \\\n--hard'",
            "'eval' 'git reset --hard'", "E=eval; $E 'git reset --hard'", "{ eval 'git reset --hard'; }",
            "H='git reset --hard'; eval '$H'; H='echo hi'; $H", "H='git reset --hard' eval '$H'",
            "shopt -s expand_aliases\nalias g='git reset --hard'\neval 'g'", "shopt -s expand_aliases\nalias g='git reset --hard'\neval g",
            'shopt -s expand_aliases\nalias g=\'git reset --hard\'\neval "$(printf %s g)"',
            "shopt -s expand_aliases\nalias g='git reset --hard'\nunalias -n g\neval 'g'",
            "shopt -s expand_aliases\nalias g='git reset --hard'\nunalias -a -n\neval 'g'", 'eval "$(printf \'%s\' \'git reset --hard\')"',
            'X=\'git reset --hard\'; X2="$X"; eval "$X2"',
            "shopt -s expand_aliases\nalias g='git reset --hard'\neval 'g'\nalias g='echo hi'\ng",
        ]:
            with self.subTest(command=command):
                self.assertTrue(bash_module._eval_payloads_hide_destructive_git(command))

    def test_safe_eval_payloads_stay_unflagged(self):
        for command in [
            'eval', "eval 'echo hi'", "eval 'git status'", 'eval \'echo "git reset --hard"\'', 'eval "echo \'git reset --hard\'"',
            "echo 'eval git reset --hard'", "echo eval 'git reset --hard'", 'npm run eval:suite',
            "shopt -s expand_aliases\nalias g='echo hi'\neval 'g'", "shopt -s expand_aliases\nalias g='git status'\neval 'g'",
            "shopt -s expand_aliases\nalias g='git reset --hard'\neval 'echo g'",
            "shopt -s expand_aliases\nalias g='git reset --hard'\nunalias g\neval 'g'",
            "shopt -s expand_aliases\nalias g='git reset --hard'\nunalias -- g\neval 'g'",
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
            'git checkout -- .', 'git checkout .', 'git clean -fd', 'git reset --hard', 'git restore .', '"git" reset --hard',
            'G=git; $G reset --hard', "G='git reset --hard'; $G", 'G=git; echo G=other; $G reset --hard',
            "G=git; printf '%s' G=other; $G reset --hard", 'G=git; # G=other\n$G reset --hard', 'declare -x G=git; $G reset --hard',
            'readonly G=git; $G reset --hard', 'export -n G=git; $G reset --hard', 'G=other; command export G=git; $G reset --hard',
            'f() { local -r G=git; $G reset --hard; }; f', 'G=git; G=other git status; $G reset --hard', 'G=git; G=other git; $G reset --hard', 'echo "$(echo ")")"; git reset --hard', 'V="$(echo ")")"; git reset --hard',
            'git -c clean.requireForce=false clean', 'git config clean.requireForce false && git clean', 'git clean -d', 'git clean',
            'printf \'.\\n\' > ps.txt && git checkout --pathspec-from-file=ps.txt', "G='echo hi'; G='git reset --hard' H=\"$G\"; $H", "g''it reset --hard", 'g""it reset --hard', 'git clean -f\necho -n', 'cat <<-EOF\n\t\'quote\n\tEOF\ngit reset --hard',
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
        # A non-`git` function never runs for a bare `git` word, and a
        # command-scoped HOME is replayed: both probe this clean tree.
        for command in ['f() { echo hi; }; git reset --hard', f'HOME={self.test_dir} cd && git reset --hard']:
            with self.subTest(command=command):
                result = await bash(command)
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
            "import asyncio\nfrom rlm import bash\nasync def main():\n"
            "    result = await bash('git reset --hard')\n    return result.exit_code\n"
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
        # A dry run never deletes, and the copy follows the same-command reassignment: both run unguarded.
        for safe in ["git clean -n", "G='git reset --hard'; G='echo hi' H=\"$G\"; $H"]:
            result = await bash(safe)
            self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
        self.assertTrue(self._tracked("untracked.txt").exists())

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

    async def test_refuses_relocation_into_dirty_nested_repository(self):
        self._init_dirty_repo()
        for directory, command in [
            ("cd-sub", "cd cd-sub && git reset --hard"), ("c-sub", "git -C c-sub reset --hard"),
            ("q-cd", '"cd" q-cd && git reset --hard'), ("e-cd", "c\\d e-cd && git reset --hard"), ("g-cd", "( c\\d g-cd && git reset --hard )"),
        ]:
            with self.subTest(command=command):
                _init_dirty_git_repo(str(self._tracked(directory)))
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                self.assertIn("Refusing to run this destructive git command", str(caught.exception))
                self.assertIn("tracked.txt", str(caught.exception))
                self.assertEqual(self._tracked(directory, "tracked.txt").read_text(), "modified\n")

    async def test_allows_relocated_discard_when_target_is_clean(self):
        self._init_dirty_repo()  # the outer tree stays dirty
        for directory in ["sub", "my repo"]:
            with self.subTest(directory=directory):
                target = str(self._tracked(directory))
                _init_dirty_git_repo(target)
                _run_git(target, "add", "-A")
                _run_git(target, "commit", "-q", "-m", "second")
                result = await bash(f'cd "{directory}" && git reset --hard')
                self.assertEqual(result.exit_code, 0)

    async def test_multi_discard_probes_every_target_repository(self):
        _init_dirty_git_repo(str(self._tracked("sub")))
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError):
            bash("git checkout -- . && cd sub && git reset --hard")

    async def test_refuses_relocations_it_cannot_replay_safely(self):
        self._init_dirty_repo()
        for command in [
            'cd $(pwd)/sub && git reset --hard', 'git --git-dir=sub/.git reset --hard', 'cd sub || git reset --hard',
            'pushd sub && git reset --hard', '"pushd" sub && git reset --hard', 'git -C "sub" reset --hard', 'git -ccore.worktree=sub reset --hard', 'git -ccore.bare=1 reset --hard', '( "pu"shd sub && git reset --hard )',
            'git -pCsub reset --hard', 'git -qC sub reset --hard', 'source setup.sh && git reset --hard', '. setup.sh && git reset --hard',
            'export GIT_DIR=$(pwd)/sub; git reset --hard', 'FOO=1 cd sub; git reset --hard', 'FOO=$(pwd) cd sub && git reset --hard',
            'function f { cd sub; }; f; git reset --hard', 'function f { pushd sub; }; f && git reset --hard', 'git() { command git -C sub "$@"; }; git reset --hard', 'GIT_DIR=sub/.git; unset GIT_DIR; git reset --hard', '"unset" GIT_DIR; git reset --hard', 'command unset GIT_DIR; git reset --hard', '! cd sub; git reset --hard', '! cd no-such-dir && git reset --hard', 'WT=sub git --config-env=core.worktree=WT reset --hard', 'GIT_DIR=sub/.git GIT_WORK_TREE=sub; command -p unset GIT_DIR; git reset --hard', "eval 'cd sub'; git reset --hard", "trap 'cd sub' DEBUG; git reset --hard", "trap 'cd sub' ERR; false; git reset --hard", "shopt -s expand_aliases\nalias c=cd\neval 'c sub'\ngit reset --hard", "trap 'true; cd sub' DEBUG; git reset --hard", "trap 'echo hi' DEBUG; trap 'cd sub' DEBUG; git reset --hard", "trap '--' 'cd sub' DEBUG; git reset --hard", 'GIT_DIR=sub/.git GIT_WORK_TREE=sub; command "-p" unset GIT_DIR; git reset --hard', "X=cd; eval '$X sub'; X=echo; git reset --hard", 'A=trap; "$A" \'cd sub\' DEBUG; git reset --hard',
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                self.assertIn("changes directory (or repository) first", str(caught.exception))

    async def test_refuses_revealed_relocations_the_probe_cannot_name(self):
        # A revealed value holding more than the executable word runs as argv,
        # so the `-C sub` inside it relocates the discard, and the guard cannot
        # name that directory from the text: it refuses instead of approving the
        # clean parent the unexpanded reference appears to target.
        _init_dirty_git_repo(str(self._tracked("sub")))
        self._init_dirty_repo()
        self._tracked(".gitignore").write_text("sub/\n")
        _run_git(self.test_dir, "add", "-A")
        _run_git(self.test_dir, "commit", "-q", "-m", "second")
        for command in [
            "G='git -C sub reset --hard'; $G", "G='git -C sub restore .'; $G", "X=git Y='-C sub reset --hard'; $X $Y",
            "G=git; H='-C sub'; $G $H reset --hard",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                message = str(caught.exception)
                self.assertIn("expanded value whose argv cannot be replayed", message)
                self.assertNotIn("changes directory (or repository) first", message)
        self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")

    async def test_refuses_aliases_visible_in_the_command_text(self):
        # An `alias NAME=VALUE` in the text (or the replayed prefix) is resolved:
        # a discard it hides is refused, and `unalias` drops only what bash drops.
        self._init_dirty_repo()
        checked = 0

        async def check(command: str, refused: bool, prefix: str | None = None):
            # its own repository, so one allowed command cannot hide the next
            nonlocal checked
            repo = str(self._tracked(f"alias-{checked}"))
            checked += 1
            _init_dirty_git_repo(repo)
            os.chdir(repo)
            settings = {"PRIME_AGENT_BASH_COMMAND_PREFIX": prefix} if prefix else {}
            with mock.patch.dict(os.environ, settings):
                if refused:
                    with self.assertRaises(DestructiveGitRefusalError):
                        bash(command)
                else:
                    await bash(command)
            self.assertEqual(Path(repo, "tracked.txt").read_text(), "modified\n")

        for command, refused, prefix in [
            ('shopt -s expand_aliases\nalias g=git\ng reset --hard', True, None),
            ("g reset --hard", True, 'shopt -s expand_aliases\nalias g=git'),
            ("shopt -s expand_aliases\nalias g='git reset --hard'\neval 'g'", True, None),
            ("shopt -s expand_aliases\nA=alias\n$A g='git reset --hard'\neval 'g'", True, None),
            ('alias g=git\ng reset --hard', True, None), ('alias git=echo\ngit reset --hard', True, None),
            ('shopt -s expand_aliases; alias g=git; g status', False, None),
            ("alias g='echo hi'\ng reset --hard", False, None), ('alias g=$X\ng reset --hard', False, None),
            ('alias g=git\nunalias g\ng reset --hard', False, None), ('alias g=git\nunalias -a\ng reset --hard', False, None),
        ]:
            with self.subTest(command=command, prefix=prefix):
                await check(command, refused, prefix)
        # `unalias [-a] [--] NAME...` is read with getopt: an option bash rejects
        # removes nothing, and neither does one a pipeline, `&` or `( ... )` runs
        # in a subshell, so the alias survives and `eval` discards.
        for form, refused in [
            ("unalias g", False), ("unalias -- g", False), ("unalias -a g", False),
            ("unalias -n g", True), ("unalias -f g", True), ("unalias -A g", True),
            ("unalias -i g", True), ("unalias -an g", True), ("unalias --force g", True),
            ("unalias -a -n", True), ("unalias -n -a", True), ("unalias g | cat", True), ("( unalias g )", True),
            ("unalias g &", True), ("true | unalias g", True), ("unalias g;", False), ("unalias g || true", False),
            ("unalias g && true", False), ("{ unalias g; }", False),
        ]:
            with self.subTest(unalias=form):
                await check(f"shopt -s expand_aliases\nalias g='git reset --hard'\n{form}\neval 'g'", refused)

    def test_probe_reads_are_bounded_and_time_out(self):
        # The timeout kills the probe's process group: it covers a probe whose
        # child exited while a descendant holds stdout, a hang, and an endless
        # listing (the caller returns in time and the bytes read stay capped).
        self._init_dirty_repo()

        def timed(command: str):
            started = time.monotonic()
            result = bash_module._probe_uncommitted_changes(command, self.test_dir)
            self.assertLess(time.monotonic() - started, 5.0, command)
            return result

        with mock.patch.object(bash_module, "_PROBE_TIMEOUT_SECONDS", 1.0):
            self.assertIsNone(timed("sleep 60"))
            self.assertEqual(timed("(sleep 60) & exit 0"), [])
        listed = timed("yes dirty")
        self.assertTrue(listed)
        self.assertLessEqual(len("\n".join(listed).encode()), bash_module._PROBE_OUTPUT_CAP_BYTES)

    async def test_refuses_eval_wrapped_discards(self):
        self._init_dirty_repo()
        for command in [
            "eval 'git reset --hard'", 'eval "git clean -f"', 'eval \'eval "git reset --hard"\'', "eval 'cd sub && git reset --hard'",
            "function f { eval 'git reset --hard'; }; f", "shopt -s expand_aliases\nalias g='git reset --hard'\neval 'g'",
            "shopt -s expand_aliases\nalias g='git reset --hard'\neval 'g; true'", "e\\val 'git reset --hard'",
            "e'va'l 'git reset --hard'", "H='git reset --hard'; eval '$H'; H='echo hi'; $H", "H='git reset --hard' eval '$H'",
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
        # An eval word in argument position never runs its payload.
        result = await bash("echo eval 'git reset --hard'")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_quoted_cd_relocations_are_replayed_in_the_probe(self):
        _init_dirty_git_repo(str(self._tracked("my repo")))
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash('cd "my repo" && git reset --hard')
        self.assertIn("tracked.txt", str(caught.exception))
        self.assertEqual(self._tracked("my repo", "tracked.txt").read_text(), "modified\n")

    async def test_attached_dash_c_values_relocate_the_probe(self):
        # Stock git rejects attached short options itself ("unknown option:
        # -Csub"), so the form can never discard anything; the guard still
        # resolves the attached value instead of probing the parent tree.
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
        # With the nested tree clean and the parent dirty, git still rejects
        # the option itself rather than discarding the parent tree.
        _run_git(str(self._tracked("sub")), "add", "-A")
        _run_git(str(self._tracked("sub")), "commit", "-q", "-m", "second")
        self._tracked("tracked.txt").write_text("modified\n")
        result = await bash("git -Csub reset --hard")
        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_attached_benign_dash_c_configs_do_not_relocate(self):
        self._init_dirty_repo()
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("git -cfoo.bar=1 reset --hard")
        self.assertIn("uncommitted change(s)", str(caught.exception))
        self.assertNotIn("changes directory (or repository) first", str(caught.exception))

    async def test_refuses_discards_split_over_line_continuations(self):
        self._init_dirty_repo()
        for command in [
            'git reset \\\n--hard', 'git checkout -- \\\n.', 'git clean -f \\\n-d',
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError):
                    bash(command)
                self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
                self.assertTrue(self._tracked("untracked.txt").exists())

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
            'git reset 2>/dev/null --hard', 'git reset 2> /dev/null --hard', 'git reset 2>&1 --hard', 'git 2>/dev/null reset --hard', 'git restore 2>/dev/null .',
            'git reset &>/dev/null --hard', 'git reset &> /dev/null --hard', 'git reset &>>/dev/null --hard', 'git reset >&/dev/null --hard',
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
        result = await bash("echo one \\\n two")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("one", result.output)
        self.assertIn("two", result.output)
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
        # The parent tree stays clean: the group's cd must relocate the probe
        # like a bare cd chain, and a command-scoped assignment in front of
        # the cd (`FOO=1 cd sub`, `HOME=sub cd`) must not hide it. Quoting,
        # escapes, wrappers, and keywords do not stop the builtin either.
        self._init_dirty_repo()
        _run_git(self.test_dir, "add", "-A")
        _run_git(self.test_dir, "commit", "-q", "-m", "second")
        for command in [
            "{ cd sub && git reset --hard; }", "FOO=1 cd sub && git reset --hard", "HOME=sub cd && git reset --hard",
            '"c"d sub && git reset --hard', '"command" "cd" sub && git reset --hard',
            "if true; then cd sub && git reset --hard; fi", "HOME=sub; cd && git reset --hard",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                self.assertIn("tracked.txt", str(caught.exception))
                self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")
        # A cd followed by `;` in the group depends on the cd succeeding.
        with self.assertRaises(DestructiveGitRefusalError) as caught:
            bash("{ cd sub; git reset --hard; }")
        self.assertIn("changes directory (or repository) first", str(caught.exception))
        # A function whose body cds is refused the same way (it discards sub): quoting and escapes do not
        # stop the cd builtin, and a hyphenated name is still a function bash accepts.
        for function_command in [
            "function f { cd sub; }; f; git reset --hard", 'function f { "cd" sub; }; f; git reset --hard',
            "function f { c\\d sub; }; f; git reset --hard", "function f { 'cd' sub; }; f; git reset --hard", "function f-g { cd sub; }; f-g; git reset --hard",
        ]:
            with self.subTest(command=function_command):
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(function_command)
                self.assertIn("changes directory (or repository) first", str(caught.exception))
                self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")

    async def test_refuses_persistent_env_assignment_relocations(self):
        _init_dirty_git_repo(str(self._tracked("sub")))
        self._init_dirty_repo()
        # Ignore the nested repo: its submodule-shaped entry (" M sub") would
        # otherwise make the outer tree look dirty and mask a missed relocation.
        self._tracked(".gitignore").write_text("sub/\n")
        _run_git(self.test_dir, "add", "-A")
        _run_git(self.test_dir, "commit", "-q", "-m", "second")
        for command in [
            'export GIT_DIR=sub/.git GIT_WORK_TREE=sub; git reset --hard', 'GIT_DIR=sub/.git; git reset --hard',
            'export GIT_DIR=sub/.git && git reset --hard', '{ export GIT_DIR=sub/.git GIT_WORK_TREE=sub; git reset --hard; }', 'if true; then export GIT_DIR=sub/.git GIT_WORK_TREE=sub; git reset --hard; fi',
            'if true; then { export GIT_DIR=sub/.git GIT_WORK_TREE=sub; git reset --hard; }; fi', f'HOME={self._tracked("sub")} cd && git reset --hard', 'GIT_DIR=sub/.git GIT_WORK_TREE=sub; cd . && git reset --hard',
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError) as caught:
                    bash(command)
                self.assertIn("tracked.txt", str(caught.exception))
                self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")
        # A quoted "cd" in argument position is inert data: the reveal reads
        # command words only, so the discard probes the clean caller and sub
        # survives untouched.
        result = await bash('echo "cd" && git reset --hard')
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("sub", "tracked.txt").read_text(), "modified\n")

    async def test_command_scoped_assignments_do_not_persist(self):
        self._init_dirty_repo()
        result = await bash("FOO=1 git status")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
        # The shell keeps none of these names, so `$G` runs a command that is
        # not git and the tree survives; a command-scoped prefix must not
        # overwrite the value a later reference really expands.
        for command in [
            'G=git; echo x; G=other; $G reset --hard', 'G=git; export G=other; $G reset --hard', 'G=git; command export G=other; $G reset --hard',
        ]:
            with self.subTest(command=command):
                result = await bash(command)
                self.assertNotEqual(result.exit_code, 0)
                self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_refuses_discards_hidden_behind_shell_escapes(self):
        self._init_dirty_repo()
        for command in [
            'g\\it reset --ha\\rd', 'git res\\et --hard', 'git reset --ha\\rd',
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveGitRefusalError):
                    bash(command)
                self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")
        # Escaped data stays inert: this only prints.
        result = await bash("echo \\# git reset --hard")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self._tracked("tracked.txt").read_text(), "modified\n")

    async def test_refuses_staged_and_worktree_restore_discards(self):
        self._init_dirty_repo()
        # A ref name containing S or W must not flip this to an index-only restore.
        _run_git(self.test_dir, "branch", "SRC")
        for command in [
            'git restore --staged --worktree .', 'git restore -SW .', 'git restore -WS .', 'git restore -s SRC .', 'git restore -sSRC .',
            'git restore --source HEAD .', 'git restore -qs SRC .', 'git restore -Ws SRC .', 'git restore --no-overlay .', 'git restore --quiet .',
            'git restore -q .', 'git restore --quiet --source=HEAD .',
        ]:
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
        # A quoted delimiter turns expansion off: the body is inert data.
        result = await bash("cat <<'EOF'\n$(git reset --hard)\nEOF")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("$(git reset --hard)", result.output)
        with self.assertRaises(DestructiveGitRefusalError):
            bash("cat <<EOF\n$(git reset --hard)\nEOF")
        # The body starts on the next line: a command after the operator on
        # the same line still runs, so it must not be masked as body data.
        with self.assertRaises(DestructiveGitRefusalError):
            bash("cat <<'EOF' ; git reset --hard\nEOF")
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


# Vectors for the recursive-force rm guard: an rm invocation must combine a
# recursive flag (-r/-R/--recursive) with a force flag (-f) in any position;
# a lone -r or lone -f must stay untouched.
RM_MATCHING_COMMANDS = [
    "rm -rf sub",
    "rm -fr sub",
    "rm -Rf sub",
    "rm -fR sub",
    "rm -r -f sub",
    "rm -f -r sub",
    "rm -rfv sub",
    "rm -I -rf sub",
    "rm --recursive --force sub",
    "rm --force --recursive sub",
    "rm --recursive -f sub",
    "rm sub -rf",
    "rm -rf sub && rm -fr other",
    "rm -rf sub; git status",
    "/bin/rm -rf sub",
    '"rm" -rf sub',
    "\\rm -rf sub",
    "sudo rm -rf sub",
    "FOO=1 rm -rf sub",
    "xargs rm -rf",
    "rm -rf",
    "rm -rf sub 2>/dev/null",
    "rm -rf &>/dev/null sub",
    "rm 2>/dev/null -rf sub",
    "rm -rf sub # cleanup",
    "rm -rf \\\nsub",
    "rm -rf -- sub",
    "(rm -rf sub)",
    "{ rm -rf sub; }",
    "echo $(rm -rf sub)",
    "echo `rm -rf sub`",
    "rm -rf ~",
    "rm -rf $HOME",
    "rm -rf ..",
    "rm -rf /",
    'echo $(echo ")"; rm -rf /)',
    "echo \"$(echo ')'; rm -rf sub)\"",
]

RM_NON_MATCHING_COMMANDS = [
    "rm -r sub",
    "rm -f file.txt",
    "rm -R sub",
    "rm -d -f sub",
    "rm -F sub",
    "rm --recursive sub",
    "rm --force sub",
    "rm -r sub && rm -f other",
    "rm -i sub",
    "rm sub",
    "rm -- sub",
    "echo 'rm -rf sub'",
    'echo "rm -rf ~"',
    "# rm -rf sub",
    "eval 'rm -rf sub'",
    "git rm -r --cached .",
    "npm run rm-build",
    "permanent -rf sub",
    "perm -rf sub",
    "git status",
    "echo hello world",
    "sh -c 'rm -r sub'",
    "sh -c 'echo rm -rf sub'",
    "python3 -c 'print(\"rm -rf ~\")'",
]


class RecursiveForceRmDetectionTest(unittest.TestCase):
    def test_matches_recursive_force_rm(self):
        for command in RM_MATCHING_COMMANDS:
            with self.subTest(command=command):
                self.assertTrue(is_recursive_force_rm_command(command))

    def test_does_not_match_other_commands(self):
        for command in RM_NON_MATCHING_COMMANDS:
            with self.subTest(command=command):
                self.assertFalse(is_recursive_force_rm_command(command))


class RmEvalPayloadDetectionTest(unittest.TestCase):
    def test_eval_payloads_hiding_recursive_force_rm(self):
        for command in [
            "eval 'rm -rf ~'",
            'eval "rm -rf ~"',
            "eval 'rm -rf ~' && echo done",
            "eval 'eval \"rm -rf ~\"'",
            "eval 'rm -rf \\\n~'",
        ]:
            with self.subTest(command=command):
                self.assertTrue(
                    bash_module._wrapped_payloads_hide_recursive_force_rm(command)
                )

    def test_safe_eval_payloads_stay_unflagged(self):
        for command in [
            "eval",
            "eval 'echo hi'",
            'eval "echo \'rm -rf ~\'"',
            "npm run eval:suite",
            "echo 'eval rm -rf ~'",
        ]:
            with self.subTest(command=command):
                self.assertFalse(
                    bash_module._wrapped_payloads_hide_recursive_force_rm(command)
                )


class RmWrapperPayloadDetectionTest(unittest.TestCase):
    def test_shell_dash_c_payloads_hiding_recursive_force_rm(self):
        for command in [
            "sh -c 'rm -rf ~'",
            'bash -c "rm -rf ~"',
            "zsh -c 'rm -rf $HOME'",
            "/bin/sh -c 'rm -rf sub'",
            "dash -c 'rm -rf sub'",
            "sh -c 'cd / && rm -rf x'",
            'sh -c "sh -c \'rm -rf sub\'"',
            "bash -c 'eval \"rm -rf sub\"'",
            "eval 'sh -c \"rm -rf sub\"'",
            "sudo bash -c 'rm -rf sub'",
            "busybox sh -c 'rm -rf sub'",
            'sh -c \'rm -rf "$1"\' sh ~',
            '$BASH -c "rm -rf sub"',
        ]:
            with self.subTest(command=command):
                self.assertTrue(
                    bash_module._wrapped_payloads_hide_recursive_force_rm(command)
                )

    def test_safe_dash_c_payloads_stay_unflagged(self):
        for command in [
            "sh -c 'echo hi'",
            "bash -c 'ls -la'",
            "sh -c 'rm -r sub'",
            "sh -c 'rm -f sub'",
            "sh -c",
            "python3 -c 'print(\"rm -rf ~\")'",
            "echo 'sh -c \"rm -rf ~\"'",
        ]:
            with self.subTest(command=command):
                self.assertFalse(
                    bash_module._wrapped_payloads_hide_recursive_force_rm(command)
                )


class TrackedCwdDetectionTest(unittest.TestCase):
    def test_cd_tracking_scopes_subshells(self):
        command = "(cd /tmp; rm -rf a) && rm -rf b"
        words = bash_module._scan_shell_words(command)
        tracked = bash_module._tracked_cwd_at_words(command, words, "/ws")
        rm_indices = [i for i, w in enumerate(words) if w.value == "rm"]
        self.assertEqual(tracked[rm_indices[0]], os.path.realpath("/tmp"))
        self.assertEqual(tracked[rm_indices[1]], os.path.realpath("/ws"))

    def test_unresolvable_cd_targets_fail_closed(self):
        command = "cd $UNSET; rm -rf sub"
        words = bash_module._scan_shell_words(command)
        tracked = bash_module._tracked_cwd_at_words(command, words, "/ws")
        rm_index = next(i for i, w in enumerate(words) if w.value == "rm")
        self.assertIsNone(tracked[rm_index])

    def test_bare_cd_goes_home(self):
        command = "cd; rm -rf sub"
        words = bash_module._scan_shell_words(command)
        tracked = bash_module._tracked_cwd_at_words(command, words, "/ws")
        rm_index = next(i for i, w in enumerate(words) if w.value == "rm")
        home = os.environ.get("HOME")
        self.assertEqual(tracked[rm_index], os.path.realpath(home) if home else None)


class RmExpansionDetectionTest(unittest.TestCase):
    def test_unresolvable_expansion_reasons(self):
        for command, expected in [
            ("R=rm; $R -rf x", "$R"),
            ("flags=-rf; rm $flags /", "$flags"),
            ("rm {--recursive,--force} sub", "--recursive,--force"),
        ]:
            with self.subTest(command=command):
                words = bash_module._scan_shell_words(command)
                reasons = bash_module._unresolvable_expansion_rm_reasons(words)
                self.assertTrue(any(expected in reason for reason in reasons), reasons)

    def test_resolvable_expansion_tokens_stay_unflagged(self):
        for command in [
            "rm -rf $PWD/sub",
            "rm -rf $HOME/sub",
            "rm -rf sub",
        ]:
            with self.subTest(command=command):
                words = bash_module._scan_shell_words(command)
                self.assertEqual(
                    bash_module._unresolvable_expansion_rm_reasons(words), []
                )


class RecursiveForceRmGuardTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._prev_cwd = os.getcwd()
        os.environ.pop(BASH_DESTRUCTIVE_RM_BYPASS_ENV, None)
        os.environ.pop("PRIME_AGENT_BASH_COMMAND_PREFIX", None)
        # The launch-time bypass snapshot is a module attribute frozen at
        # import; pin it to "unset" so tests stay deterministic.
        frozen_patch = mock.patch.object(bash_module, "_BASH_RM_BYPASS_AT_KERNEL_START", None)
        frozen_patch.start()
        self.addCleanup(frozen_patch.stop)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        # Restore cwd before the temp dir disappears (cleanups run LIFO).
        self.addCleanup(os.chdir, self._prev_cwd)
        self.test_dir = temp.name
        os.chdir(self.test_dir)

    def _make_tree(self) -> None:
        Path(self.test_dir, "sub", "nested").mkdir(parents=True, exist_ok=True)
        Path(self.test_dir, "sub", "nested", "file.txt").write_text("x\n")
        Path(self.test_dir, "my dir").mkdir(exist_ok=True)
        Path(self.test_dir, "my dir", "file.txt").write_text("x\n")

    def _outside_target(self) -> str:
        """A sibling directory outside the workspace with a file in it."""
        name = "outside-sibling-" + os.path.basename(self.test_dir)
        outside = str(Path(self.test_dir).parent / name)
        Path(outside).mkdir(exist_ok=True)
        Path(outside, "file.txt").write_text("keep\n")
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        return outside

    def _tracked(self, *parts: str) -> Path:
        return Path(self.test_dir, *parts)

    async def test_refuses_escapes_to_home_and_root_and_outside(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        for command in [
            "rm -rf ~",
            "rm -rf ~/",
            "rm -rf $HOME",
            "rm -rf $HOME/",
            "rm -rf ~/anything",
            "rm -rf ${HOME}/anything",
            "rm -rf /",
            "rm -rf //",
            "rm -rf /tmp/pa-rm-guard-elsewhere",
        ]:
            with self.subTest(command=command):
                with mock.patch.dict(os.environ, {"HOME": home.name}):
                    with self.assertRaises(DestructiveRmRefusalError) as caught:
                        bash(command)
                self.assertIn("Refusing to run this recursive-force rm command", str(caught.exception))
                self.assertTrue(Path(home.name, "keep.txt").exists())

    async def test_refuses_parent_directory_escapes(self):
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "rm -rf ..",
            f"rm -rf ../{Path(outside).name}",
            "rm -rf ./..",
            "rm -rf sub/..",
            "rm -rf sub/../sub/..",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn("Refusing to run this recursive-force rm command", str(caught.exception))
                self.assertTrue(Path(outside, "file.txt").exists())
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_refuses_dot_dirs_and_dotfiles(self):
        self._make_tree()
        Path(self.test_dir, ".git", "objects").mkdir(parents=True, exist_ok=True)
        Path(self.test_dir, ".env").write_text("SECRET=1\n")
        Path(self.test_dir, "sub", ".env.local").write_text("SECRET=1\n")
        Path(self.test_dir, ".venv", "bin").mkdir(parents=True, exist_ok=True)
        for command in [
            "rm -rf .git",
            "rm -rf sub/.git",
            "rm -rf .env",
            "rm -rf .env.local",
            "rm -rf sub/.env.local",
            "rm -rf .venv",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                message = str(caught.exception)
                self.assertIn("Refusing to run this recursive-force rm command", message)
                self.assertIn("dot", message.lower())

    async def test_refuses_the_workspace_root_itself(self):
        self._make_tree()
        for command in ["rm -rf .", "rm -rf ./"]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn("workspace root itself", str(caught.exception))
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_refuses_operands_it_cannot_resolve(self):
        self._make_tree()
        for command in [
            "rm -rf *",
            "rm -rf build/*",
            "rm -rf $SECRET",
            "rm -rf $(pwd)",
            "rm -rf ~otheruser",
            "rm -rf {}",
            "rm -rf -",
            "rm -rf",
            "echo hi | xargs rm -rf",
            "find . -name x -exec rm -rf {} +",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn("Refusing to run this recursive-force rm command", str(caught.exception))
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_allows_inside_workspace_rm_rf(self):
        # Long options and flags-after-operand forms stay in the detection
        # vectors; BSD rm rejects them, so execution here sticks to forms that
        # work on every supported platform.
        for command in [
            "rm -rf sub",
            "rm -fr sub",
            "rm -Rf sub",
            "rm -rf ./sub",
            "rm -rf sub/nested",
            'rm -rf "my dir"',
            "rm -rf $PWD/sub",
            'rm -rf sub ./"my dir"',
        ]:
            with self.subTest(command=command):
                self._make_tree()
                result = await bash(command)
                self.assertEqual(result.exit_code, 0)

    async def test_dash_r_without_force_and_dash_f_without_recursion_untouched(self):
        self._make_tree()
        Path(self.test_dir, "file.txt").write_text("x\n")
        result = await bash("rm -r sub")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub").exists())
        self._make_tree()
        result = await bash("rm -f file.txt")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("file.txt").exists())
        self._make_tree()
        Path(self.test_dir, "file.txt").write_text("x\n")
        # Neither invocation combines both flags, so the compound stays untouched too.
        result = await bash("rm -r sub && rm -f file.txt")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub").exists())
        self.assertFalse(self._tracked("file.txt").exists())

    async def test_kwarg_bypass_runs_the_deletion(self):
        outside = self._outside_target()
        result = await bash(f"rm -rf ../{Path(outside).name}", allow_destructive_rm=True)
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(Path(outside).exists())

    async def test_frozen_bypass_env_honored_when_set_at_launch(self):
        with mock.patch.object(bash_module, "_BASH_RM_BYPASS_AT_KERNEL_START", "1"):
            # -f on a path that does not exist is a successful no-op, so the
            # bypass is observable without deleting anything real.
            result = await bash("rm -rf ~/pa-rmguard-bypass-noop")
        self.assertEqual(result.exit_code, 0)

    async def test_frozen_bypass_zero_still_refuses(self):
        with mock.patch.object(bash_module, "_BASH_RM_BYPASS_AT_KERNEL_START", "0"):
            with self.assertRaises(DestructiveRmRefusalError):
                bash("rm -rf ~")

    async def test_mid_session_env_write_does_not_unlock(self):
        with mock.patch.dict(os.environ, {BASH_DESTRUCTIVE_RM_BYPASS_ENV: "1"}):
            with self.assertRaises(DestructiveRmRefusalError) as caught:
                bash("rm -rf ~")
        message = str(caught.exception)
        self.assertIn("WARNING", message)
        self.assertIn(BASH_DESTRUCTIVE_RM_BYPASS_ENV, message)
        self.assertIn("ignored by design", message)

    async def test_refuses_eval_wrapped_rm(self):
        self._make_tree()
        for command in [
            "eval 'rm -rf ~'",
            'eval "rm -rf ~"',
            "eval 'eval \"rm -rf ~\"'",
            "eval 'cd ~ && rm -rf .'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn("wraps rm in eval", str(caught.exception))
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_safe_eval_commands_still_run(self):
        result = await bash("eval 'echo hi'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        result = await bash("eval \"echo 'rm -rf ~'\"")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("rm -rf ~", result.output)

    async def test_quoted_data_is_untouched(self):
        for command in [
            "echo 'rm -rf ~'",
            'echo "rm -rf ~"',
        ]:
            with self.subTest(command=command):
                result = await bash(command)
                self.assertEqual(result.exit_code, 0)

    async def test_hardened_forms_are_refused(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        for command in [
            "rm 2>/dev/null -rf ~",
            "rm -rf \\\n~",
            "rm -rf &>/dev/null ~",
            "\\rm -rf ~",
            "/bin/rm -rf ~",
            "sudo rm -rf ~",
            '"rm" -rf ~',
            "FOO=1 rm -rf ~",
            "rm -rf ~ # cleanup",
        ]:
            with self.subTest(command=command):
                with mock.patch.dict(os.environ, {"HOME": home.name}):
                    with self.assertRaises(DestructiveRmRefusalError):
                        bash(command)
                self.assertTrue(Path(home.name, "keep.txt").exists())

    async def test_refuses_compound_when_any_invocation_escapes(self):
        self._make_tree()
        with self.assertRaises(DestructiveRmRefusalError):
            bash("rm -rf sub && rm -rf ..")
        self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())
        # Every invocation inside the workspace stays allowed.
        self._make_tree()
        result = await bash("rm -rf sub && rm -fr \"my dir\"")
        self.assertEqual(result.exit_code, 0)

    async def test_refusal_elides_long_operand_lists(self):
        operands = " ".join(f"/outside-{index}" for index in range(12))
        with self.assertRaises(DestructiveRmRefusalError) as caught:
            bash(f"rm -rf {operands}")
        self.assertIn("... and 2 more", str(caught.exception))

    async def test_refusal_lists_both_bypasses(self):
        with self.assertRaises(DestructiveRmRefusalError) as caught:
            bash("rm -rf ~")
        message = str(caught.exception)
        self.assertIn("allow_destructive_rm=True", message)
        self.assertIn(BASH_DESTRUCTIVE_RM_BYPASS_ENV, message)
        self.assertIn("Delete inside the workspace", message)

    async def test_kernel_cwd_is_home_scenario(self):
        # The wave-1 audit confirmed a live kernel can boot with cwd == HOME.
        # HOME itself must stay refused while in-workspace deletions run.
        with mock.patch.dict(os.environ, {"HOME": self.test_dir}):
            self._make_tree()
            for command in ["rm -rf ~", "rm -rf .", "rm -rf $HOME"]:
                with self.subTest(command=command):
                    with self.assertRaises(DestructiveRmRefusalError):
                        bash(command)
            self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())
            result = await bash("rm -rf sub")
            self.assertEqual(result.exit_code, 0)
            self.assertFalse(self._tracked("sub").exists())

    async def test_symlink_escape_refused(self):
        victim = tempfile.TemporaryDirectory()
        self.addCleanup(victim.cleanup)
        Path(victim.name, "keep").mkdir()
        os.symlink(victim.name, str(self._tracked("link")))
        with self.assertRaises(DestructiveRmRefusalError):
            bash("rm -rf link")
        self.assertTrue(Path(victim.name, "keep").exists())

    async def test_refuses_shell_dash_c_wrapped_rm(self):
        # A quoted argument to sh/bash -c is a live command string: the
        # payload must be scanned, not treated as data.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"sh -c 'rm -rf {outside}'",
            f'bash -c "rm -rf {outside}"',
            f"zsh -c 'rm -rf {outside}'",
            f"sh -c 'sh -c \"rm -rf {outside}\"'",
            f"eval 'sh -c \"rm -rf {outside}\"'",
            f"busybox sh -c 'rm -rf {outside}'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn("wraps rm in", str(caught.exception))
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_safe_shell_dash_c_commands_still_run(self):
        result = await bash("sh -c 'echo hi'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        # Non-shell -c payloads are not shell syntax and stay unscanned.
        result = await bash("python3 -c 'print(\"safe\")'")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_rm_hidden_behind_quoted_paren(self):
        # A paren inside quotes must not close a $(...) scan early: the
        # live rm after it runs inside the substitution.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f'echo $(echo ")"; rm -rf {outside})',
            f"echo $(echo ')'; rm -rf {outside})",
            f"echo \"$(echo ')'; rm -rf {outside})\"",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn(
                    "Refusing to run this recursive-force rm command",
                    str(caught.exception),
                )
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_expansion_hidden_rm(self):
        # $VAR command words and $VAR/brace followers expand after the
        # guard runs; they cannot be resolved statically, so refuse them.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"R=rm; $R -rf {outside}",
            f"flags=-rf; rm $flags {outside}",
            f"$R -rf {outside}",
            "rm {--recursive,--force} " + outside,
            f"rm -rf {{sub,{outside}}}",
        ]:
            with self.subTest(command=command):
                self._make_tree()
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn(
                    "Refusing to run this recursive-force rm command",
                    str(caught.exception),
                )
                self.assertTrue(Path(outside, "file.txt").exists())
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_refuses_relocated_rm_after_cd(self):
        # Relative operands resolve against the directory the shell runs
        # from after cd/pushd, not the kernel cwd; an unresolvable
        # relocation fails closed too.
        self._make_tree()
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        for command in [
            f"cd {outside}; rm -rf victim",
            f"cd {outside} && rm -rf victim",
            f"cd {outside}; rm -rf $PWD/victim",
            f"pushd {outside}; rm -rf victim",
            "cd $UNRESOLVED_DIR; rm -rf sub",
        ]:
            with self.subTest(command=command):
                self._make_tree()
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "victim", "file.txt").exists())
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_cd_into_workspace_still_allows_in_workspace_rm(self):
        self._make_tree()
        result = await bash("cd sub && rm -rf nested")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub", "nested").exists())
        self.assertTrue(self._tracked("sub").exists())
        # A subshell's cd does not relocate the caller's shell.
        self._make_tree()
        outside = self._outside_target()
        result = await bash(f"(cd {outside}; echo hi) && rm -rf sub")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub").exists())
        self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_brace_expanded_rm(self):
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "rm {--recursive,--force} sub",
            f"rm -rf {{sub,{outside}}}",
        ]:
            with self.subTest(command=command):
                self._make_tree()
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_guard_scans_the_spawn_prefix(self):
        # The spawn prepends PRIME_AGENT_BASH_COMMAND_PREFIX, and that env
        # value is model-writable mid-session: the guard must scan exactly
        # what the shell will run.
        outside = self._outside_target()
        with mock.patch.dict(
            os.environ, {"PRIME_AGENT_BASH_COMMAND_PREFIX": f"rm -rf {outside}"}
        ):
            with self.assertRaises(DestructiveRmRefusalError) as caught:
                bash("echo hi")
        self.assertIn(
            "Refusing to run this recursive-force rm command",
            str(caught.exception),
        )
        self.assertTrue(Path(outside, "file.txt").exists())
        # A benign prefix stays harmless.
        with mock.patch.dict(
            os.environ, {"PRIME_AGENT_BASH_COMMAND_PREFIX": "export PREFIX_OK=1"}
        ):
            result = await bash("echo $PREFIX_OK")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_symlink_swaps_and_missing_operands(self):
        self._make_tree()
        outside = self._outside_target()
        # The command creates the symlink and deletes through it in one
        # go: at guard time the operand does not exist yet.
        with self.assertRaises(DestructiveRmRefusalError):
            bash(f"ln -s {outside} swap && rm -rf swap/")
        self.assertTrue(Path(outside, "file.txt").exists())
        # A symlink operand can be swapped between check and run, even
        # when it currently points inside the workspace.
        os.symlink(str(self._tracked("sub")), str(self._tracked("alias")))
        with self.assertRaises(DestructiveRmRefusalError):
            bash("rm -rf alias/")
        self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())
        # Missing paths cannot be verified: they may be created as
        # symlinks before the rm runs.
        with self.assertRaises(DestructiveRmRefusalError):
            bash("rm -rf never-created-yet")
        self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_operands_after_end_of_options_are_checked(self):
        self._make_tree()
        with self.assertRaises(DestructiveRmRefusalError):
            bash("rm -rf -- ..")
        self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())


if __name__ == "__main__":
    unittest.main()
