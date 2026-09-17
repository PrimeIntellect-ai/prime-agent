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
        # A dry run never deletes, and the copy follows the same-command
        # reassignment, so the git guard reads the live harmless value and lets
        # both run. The stacked rm guard still fail-closes on the mirror's
        # expansion-built command word (`H="$G"` runs text it cannot read
        # statically), so this end-to-end git-guard check passes its documented
        # bypass kwarg.
        result = await bash("git clean -n")
        self.assertEqual(result.exit_code, 0)
        result = await bash(
            "G='git reset --hard'; G='echo hi' H=\"$G\"; $H",
            allow_destructive_rm=True,
        )
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
    "rm --recurs --forc sub",
    "rm --recursive --f sub",
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
        self.assertEqual(tracked[rm_indices[0]], [os.path.realpath("/tmp")])
        self.assertEqual(tracked[rm_indices[1]], [os.path.realpath("/ws")])

    def test_unresolvable_cd_targets_fail_closed(self):
        command = "cd $UNSET; rm -rf sub"
        words = bash_module._scan_shell_words(command)
        tracked = bash_module._tracked_cwd_at_words(command, words, "/ws")
        rm_index = next(i for i, w in enumerate(words) if w.value == "rm")
        self.assertIn(None, tracked[rm_index])

    def test_conditional_cd_keeps_preceding_candidates(self):
        command = "cd /outside && true || cd /workspace && rm -rf victim"
        words = bash_module._scan_shell_words(command)
        tracked = bash_module._tracked_cwd_at_words(command, words, "/ws")
        rm_index = next(i for i, w in enumerate(words) if w.value == "rm")
        self.assertIn(os.path.realpath("/outside"), tracked[rm_index])

    def test_bare_cd_goes_home(self):
        command = "cd; rm -rf sub"
        words = bash_module._scan_shell_words(command)
        tracked = bash_module._tracked_cwd_at_words(command, words, "/ws")
        rm_index = next(i for i, w in enumerate(words) if w.value == "rm")
        home = os.environ.get("HOME")
        self.assertEqual(tracked[rm_index], [os.path.realpath(home) if home else None])


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

    def test_lone_expansion_operands_are_not_flagged(self):
        # A quoted single-word expansion with nothing but options around it
        # cannot turn the invocation into recursive-force rm: `rm "$file"` and
        # `rm -f "$file"` delete one resolved path non-recursively.
        for command in [
            'rm "$file"',
            'rm -f "$file"',
            'rm -- "$file"',
            'rm -f "$a" -v',
            "rm '$file'",
        ]:
            with self.subTest(command=command):
                words = bash_module._scan_shell_words(command)
                self.assertEqual(
                    bash_module._unresolvable_expansion_rm_reasons(words), []
                )

    def test_expansions_that_can_supply_flags_stay_flagged(self):
        for command in [
            "rm $flags",
            "flags='-rf /outside'; rm $flags",
            'rm "$flags" /outside',
            'rm "$file" other',
            "rm -f $flags",
        ]:
            with self.subTest(command=command):
                words = bash_module._scan_shell_words(command)
                self.assertTrue(
                    bash_module._unresolvable_expansion_rm_reasons(words), command
                )

    def test_word_splitting_is_tracked_from_the_source(self):
        for command, expected in [
            ("rm $flags", True),
            ('rm "$flags"', False),
            ("rm '$flags'", False),
            ("rm $((1 + 1))", True),
            ("rm $(pwd)", True),
            ("rm `pwd`", True),
        ]:
            with self.subTest(command=command):
                words = bash_module._scan_shell_words(command)
                # A substitution scans its interior first, so the enclosing
                # word is the last one appended.
                self.assertEqual(words[-1].splittable, expected)


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

    def test_frozen_rm_bypass_not_leaked_into_child_environments(self):
        # The rm bypass is frozen at kernel start like the git one, so a
        # mid-session write must stay out of child environments: a child
        # kernel would freeze the inherited value as its own launch-time
        # bypass.
        with (
            mock.patch.dict(os.environ, {BASH_DESTRUCTIVE_RM_BYPASS_ENV: "1"}),
            mock.patch.object(bash_module, "_BASH_RM_BYPASS_AT_KERNEL_START", None),
        ):
            child_env = bash_module._child_env()
        self.assertNotIn(BASH_DESTRUCTIVE_RM_BYPASS_ENV, child_env)
        # Authorized at launch: children inherit it.
        with (
            mock.patch.dict(os.environ, {BASH_DESTRUCTIVE_RM_BYPASS_ENV: "1"}),
            mock.patch.object(bash_module, "_BASH_RM_BYPASS_AT_KERNEL_START", "1"),
        ):
            child_env = bash_module._child_env()
        self.assertEqual(child_env.get(BASH_DESTRUCTIVE_RM_BYPASS_ENV), "1")
        # A falsy launch value is airtight too: the launched-with-"0" edge
        # cannot leak a later mid-session write.
        with (
            mock.patch.dict(os.environ, {BASH_DESTRUCTIVE_RM_BYPASS_ENV: "1"}),
            mock.patch.object(bash_module, "_BASH_RM_BYPASS_AT_KERNEL_START", "0"),
        ):
            child_env = bash_module._child_env()
        self.assertNotIn(BASH_DESTRUCTIVE_RM_BYPASS_ENV, child_env)

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

    async def test_refuses_expansion_hidden_rm_in_more_positions(self):
        # Assignment prefixes, env, and keyword/grouping positions still put
        # an expansion word in command position; any of them with rm-flag
        # followers must be refused as unresolvable.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"FOO=1 $R -rf {outside}",
            f"env $R -rf {outside}",
            "if true; then $R -rf x; fi",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn(
                    "Refusing to run this recursive-force rm command",
                    str(caught.exception),
                )
                self.assertTrue(Path(outside, "file.txt").exists())
        # Expansion command words without rm-shaped flags stay allowed.
        result = await bash('ECHO_BIN=echo; "$ECHO_BIN" -u hi')
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_gnu_long_option_abbreviations(self):
        # GNU rm accepts unambiguous long-option abbreviations: --recurs and
        # --forc behave exactly like --recursive and --force.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"rm --recurs --forc {outside}",
            f"rm --recursive --forc {outside}",
            f"rm --recurs --force {outside}",
            f"rm --r --f {outside}",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn(
                    "Refusing to run this recursive-force rm command",
                    str(caught.exception),
                )
                self.assertTrue(Path(outside, "file.txt").exists())
        # Non-matching abbreviations of other options stay allowed.
        self._make_tree()
        result = await bash("rm -v sub/nested/file.txt")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_trap_action_rm(self):
        # A trap action string is a live command executed at shell exit;
        # it must be scanned like an eval payload.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"trap 'rm -rf {outside}' EXIT",
            f'trap "rm -rf {outside}" EXIT',
            f"sh -c 'trap \"rm -rf {outside}\" EXIT'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn("wraps rm in", str(caught.exception))
                self.assertTrue(Path(outside, "file.txt").exists())
        # Benign trap actions still run.
        result = await bash("trap 'echo done' EXIT; echo hi")
        self.assertEqual(result.exit_code, 0)

    async def test_heredoc_data_bodies_are_not_live_commands(self):
        # A here-document body fed to a non-interpreter command is data:
        # it must not be scanned as live rm commands.
        result = await bash("cat <<'EOF'\nrm -rf /printed-not-run\nEOF")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("rm -rf /printed-not-run", result.output)
        result = await bash("cat <<EOF\nrm -rf outside-not-run\nEOF")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("rm -rf outside-not-run", result.output)
        # Bodies fed to interpreters (directly or through a pipeline) stay
        # live commands and are refused.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"sh <<EOF\nrm -rf {outside}\nEOF",
            f"cat <<EOF | sh\nrm -rf {outside}\nEOF",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_heredoc_bodies_reaching_interpreters(self):
        # The body may reach an interpreter through a pipeline consumer after
        # the terminator or through a script file written in the same
        # command: any interpreter word in the command keeps bodies live.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "{ cat <<EOF\nrm -rf %s\nEOF\n} | sh" % outside,
            "cat <<EOF > script.sh\nrm -rf %s\nEOF\nsh script.sh" % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_trap_end_of_options_and_escaped_wrappers(self):
        # `trap --` puts the action behind an end-of-options marker, and a
        # backslash inside a wrapper name folds to the plain word, so the
        # scan must match parsed word values, not raw substrings.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "trap -- 'rm -rf %s' EXIT" % outside,
            "t\\rap 'rm -rf %s' EXIT" % outside,
            "ev\\al 'rm -rf %s'" % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Benign escaped wrappers still run.
        result = await bash("t\\rap 'echo done' EXIT; echo hi")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_home_reassignments_before_home_operands(self):
        # The guard expands $HOME from the kernel environment; a command that
        # reassigns HOME first changes the expansion at run time. The bypass
        # needs the kernel HOME to be the workspace itself.
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        with mock.patch.dict(os.environ, {"HOME": self.test_dir}):
            self._make_tree()
            Path(self.test_dir, "victim").mkdir()
            Path(self.test_dir, "victim", "file.txt").write_text("keep\n")
            for command in [
                f"HOME={outside}; export HOME; rm -rf \"$HOME/victim\"",
                f"export HOME={outside}; rm -rf \"$HOME/victim\"",
                f"HOME={outside}; rm -rf \"$HOME/victim\"",
                f"HOME={outside}; rm -rf ~/victim",
            ]:
                with self.subTest(command=command):
                    with self.assertRaises(DestructiveRmRefusalError):
                        bash(command)
                    self.assertTrue(Path(self.test_dir, "victim", "file.txt").exists())
                    self.assertTrue(Path(outside, "victim", "file.txt").exists())
            # Without a reassignment the kernel HOME still governs the
            # expansion, so an in-workspace deletion keeps working.
            result = await bash("rm -rf victim")
            self.assertEqual(result.exit_code, 0)
            self.assertFalse(self._tracked("victim").exists())

    async def test_refuses_intra_token_line_continuations(self):
        # Bash removes a backslash-newline pair entirely, so `r\<newline>m`
        # is one `rm` token at run time.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "r\\\nm -rf " + outside,
            "rm -r\\\nf " + outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_bash_env_startup_file_is_not_sourced(self):
        # Non-interactive bash sources $BASH_ENV before the command; the
        # spawn must not let model-writable env smuggle an unscanned file.
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        startup = str(self._tracked("startup.sh"))
        Path(startup).write_text(f"rm -rf {outside}/victim\n")
        with mock.patch.dict(os.environ, {"BASH_ENV": startup}):
            result = await bash("echo hi")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        self.assertTrue(Path(outside, "victim", "file.txt").exists())

    async def test_refuses_heredoc_bodies_reaching_script_runners(self):
        # A heredoc body written to a script can run through `sh s.sh`,
        # `. s.sh`, `source s.sh`, or `./s.sh`: those words keep bodies live.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "cat <<EOF > s.sh\nrm -rf " + outside + "\nEOF\n. s.sh",
            "cat <<EOF > s.sh\nrm -rf " + outside + "\nEOF\nsource s.sh",
            "cat <<EOF > s.sh\nrm -rf " + outside + "\nEOF\n./s.sh",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_heredoc_scan_sees_later_interpreters_past_body_quotes(self):
        # An unclosed quote in an earlier data body must not swallow the
        # scan: a later interpreter-fed heredoc stays live.
        self._make_tree()
        outside = self._outside_target()
        command = (
            "cat <<'EOF'\n"
            "don't\n"
            "EOF\n"
            "sh <<EOF\n"
            f"rm -rf {outside}\n"
            "EOF"
        )
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "file.txt").exists())
        # The earlier data body is still allowed on its own.
        result = await bash("cat <<'EOF'\ndon't\nEOF")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_interpreter_options_before_dash_c(self):
        # `-c` may follow other interpreter options (`bash -e -c ...`) or be
        # bundled (`bash -uc ...`); the payload must still be scanned.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"bash -e -c 'rm -rf {outside}'",
            f"bash -uc 'rm -rf {outside}'",
            f"/bin/sh -e -c 'rm -rf {outside}'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_rm_split_after_escaped_quote_continuation(self):
        # An escaped quote must not open a fake quoted span in the
        # continuation joiner: the real continuation still joins.
        self._make_tree()
        outside = self._outside_target()
        command = "echo \\' ; r\\\nm -rf " + outside
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_heredoc_bodies_relocated_by_outer_command(self):
        # The body runs wherever the outer command has relocated to, so its
        # relative operands must resolve against the runner's directory.
        self._make_tree()
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        for command in [
            f"cd {outside}; sh <<EOF\nrm -rf victim\nEOF",
            f"cd {outside}; cat <<EOF > s.sh\nrm -rf victim\nEOF\n. s.sh",
            f"HOME={outside}; cat <<EOF > s.sh\nrm -rf \"$HOME/victim\"\nEOF\nsource s.sh",
        ]:
            with self.subTest(command=command):
                Path(self.test_dir, "victim").mkdir(exist_ok=True)
                Path(self.test_dir, "victim", "file.txt").write_text("keep\n")
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "victim", "file.txt").exists())
        # Without relocations the body scan keeps allowing in-workspace paths.
        self._make_tree()
        result = await bash("sh <<EOF\nrm -rf sub\nEOF")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub").exists())

    async def test_refuses_unset_and_append_home_reassignments(self):
        self._make_tree()
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        # `HOME+=` changes the value the shell expands at run time.
        with mock.patch.dict(os.environ, {"HOME": self.test_dir}):
            command = f"HOME+=/../../..; rm -rf \"$HOME/{Path(outside).name}\""
            with self.assertRaises(DestructiveRmRefusalError):
                bash(command)
        # A reassigned HOME also relocates `cd ~`: the tracker must not
        # expand it from the kernel environment.
        with mock.patch.dict(os.environ, {"HOME": self.test_dir}):
            command = f"HOME={outside}; cd ~; rm -rf victim"
            Path(self.test_dir, "victim").mkdir(exist_ok=True)
            Path(self.test_dir, "victim", "file.txt").write_text("keep\n")
            with self.assertRaises(DestructiveRmRefusalError):
                bash(command)
            self.assertTrue(Path(outside, "file.txt").exists())
        # `unset HOME` makes $HOME-dependent operands untrackable at the
        # detection level (executing it would aim at the filesystem root).
        words = bash_module._scan_shell_words("unset HOME; rm -rf \"$HOME/x\"")
        self.assertTrue(bash_module._command_reassigns_env(words, "HOME"))

    async def test_refuses_exec_prefixed_script_runners(self):
        # `exec ./s.sh` and friends keep heredoc bodies live too.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "cat <<EOF > s.sh\nrm -rf " + outside + "\nEOF\nexec ./s.sh",
            "cat <<EOF > s.sh\nrm -rf " + outside + "\nEOF\nsudo ./s.sh",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A plain cd target is not a script runner: data heredocs after a cd
        # stay masked and allowed.
        result = await bash("cd sub && cat <<EOF\nrm -rf /printed-not-run\nEOF")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_more_interpreter_dash_c_forms(self):
        # `-c` hides behind option clusters (`bash -ce`) and behind
        # options that take arguments (`bash -o pipefail -c`).
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"bash -ce 'rm -rf {outside}'",
            f"bash -o pipefail -c 'rm -rf {outside}'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_adjacent_quoted_fragments_in_payloads(self):
        # Bash concatenates adjacent quoted fragments: 'r''m -rf x' is one
        # `rm -rf x` argument, so payload scanning must use folded word
        # values, not raw quote-bearing slices.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "sh -c 'r''m -rf " + outside + "'",
            "eval 'r''m -rf " + outside + "'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_cdpath_redirected_relocations(self):
        # With CDPATH set, `cd sub` can land in an outside directory the
        # guard never validated; relative cd targets become untrackable.
        self._make_tree()
        outside = self._outside_target()
        Path(outside, "sub").mkdir()
        Path(outside, "sub", "nested").mkdir()
        Path(outside, "sub", "nested", "file.txt").write_text("keep\n")
        with mock.patch.dict(os.environ, {"CDPATH": outside}):
            with self.assertRaises(DestructiveRmRefusalError):
                bash("cd sub && rm -rf nested")
            self.assertTrue(Path(outside, "sub", "nested", "file.txt").exists())
        with self.assertRaises(DestructiveRmRefusalError):
            bash(f"CDPATH={outside}; cd sub && rm -rf nested")
        self.assertTrue(Path(outside, "sub", "nested", "file.txt").exists())
        # Without CDPATH the relocation still resolves normally.
        self._make_tree()
        result = await bash("cd sub && rm -rf nested")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_pwd_reassigned_relocations(self):
        # `PWD=/outside; cd "$PWD"` relocates using the reassigned value.
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        self._make_tree()
        Path(self.test_dir, "victim").mkdir()
        Path(self.test_dir, "victim", "file.txt").write_text("keep\n")
        command = f"PWD={outside}; cd \"$PWD\"; rm -rf victim"
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "victim", "file.txt").exists())
        self.assertTrue(Path(self.test_dir, "victim", "file.txt").exists())

    async def test_cd_options_are_not_directory_operands(self):
        # cd -P/-L are options, not extra operands.
        self._make_tree()
        result = await bash("cd -P sub && rm -rf nested")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub", "nested").exists())
        self._make_tree()
        result = await bash("cd -L sub && rm -rf nested")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_conditionally_relocated_rm(self):
        # `cd A && true || cd B && rm` can run the rm in A (the second cd is
        # skipped): candidate directories must over-approximate control flow.
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        self._make_tree()
        Path(self.test_dir, "victim").mkdir()
        Path(self.test_dir, "victim", "file.txt").write_text("keep\n")
        command = f"cd {outside} && true || cd {self.test_dir} && rm -rf victim"
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "victim", "file.txt").exists())
        # Plain && chains stay precise: the rm runs only when the cd ran.
        self._make_tree()
        result = await bash("true && cd sub && rm -rf nested")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub", "nested").exists())

    async def test_refuses_piped_command_text_into_stdin_shells(self):
        # A pipeline feeding a bare shell interpreter runs the producer's
        # output as commands; that text must be scanned.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"printf 'rm -rf {outside}\\n' | sh",
            f"echo 'rm -rf {outside}' | sh",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Benign pipelines still run.
        result = await bash("printf 'echo hi\\n' | sh")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_rm_after_a_skipped_and_then_cd(self):
        # A failed `&&` predecessor skips the cd back; execution continues
        # at the next statement with the shell still outside.
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        self._make_tree()
        Path(self.test_dir, "victim").mkdir()
        Path(self.test_dir, "victim", "file.txt").write_text("keep\n")
        command = f"cd {outside}; false && cd {self.test_dir}; rm -rf victim"
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "victim", "file.txt").exists())
        # A successful && cd back still allows the in-workspace deletion.
        self._make_tree()
        result = await bash("cd sub && rm -rf nested")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_heredocs_attached_to_command_words(self):
        # `cat<<EOF` is a valid heredoc; missing it lets body quotes hide
        # later commands.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "cat<<EOF\ndon't\nEOF\nrm -rf " + outside,
            "sh<<EOF\nrm -rf " + outside + "\nEOF",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Data heredocs attached to non-runner commands stay allowed.
        result = await bash("cat<<EOF\nrm -rf /printed-not-run\nEOF")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_stdin_shell_feeds_across_grouped_pipelines(self):
        # Grouped producers, |& pipelines, variable shells, and -s with
        # positional args all feed stdin shells.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "{ printf 'rm -rf " + outside + "\\n'; } | sh",
            "printf 'rm -rf " + outside + "\\n' |& sh",
            "printf 'rm -rf " + outside + "\\n' | $SHELL_BIN",
            "printf 'rm -rf " + outside + "\\n' | bash -s arg1",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Statements before an ungrouped pipe are not part of the feed.
        result = await bash("echo 'rm -rf /printed'; git status | sh")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_wrapper_payloads_named_by_expansion(self):
        # `sh -c "$SCRIPT"` runs whatever the variable holds; the payload
        # cannot be scanned literally.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"SCRIPT='rm -rf {outside}'; sh -c \"$SCRIPT\"",
            f'bash -c "$SCRIPT"',
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Expansion in argument position keeps running.
        result = await bash("sh -c 'echo $UNSET_ARG'")
        self.assertEqual(result.exit_code, 0)

    async def test_arithmetic_shifts_never_blank_live_commands(self):
        # A `$((x<<y))` "delimiter" must never swallow later lines: the live
        # rm after it stays in the outer scan.
        self._make_tree()
        outside = self._outside_target()
        command = "echo $((1<<2))\nrm -rf " + outside + "\n2))"
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "file.txt").exists())
        result = await bash("echo $((1<<2))")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_alias_expanded_wrapper_payloads(self):
        # An alias defined in the command expands inside eval payloads.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"shopt -s expand_aliases; alias wipe='rm -rf {outside}'; eval wipe",
            f"alias wipe='rm -rf {outside}'; trap wipe EXIT",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Unrelated aliases keep eval payloads running.
        result = await bash("shopt -s expand_aliases; alias greet='echo hi'; eval greet")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_live_heredoc_bodies_with_substitution(self):
        # An unquoted heredoc body undergoes command substitution before the
        # consuming interpreter sees it; the output is unknowable.
        self._make_tree()
        outside = self._outside_target()
        command = "bash <<EOF\n$(printf 'rm -rf " + outside + "')\nEOF"
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "file.txt").exists())
        # Data heredocs with substitution stay allowed.
        result = await bash("cat <<EOF\necho $(date)\nEOF")
        self.assertEqual(result.exit_code, 0)

    async def test_arithmetic_skip_is_quote_aware(self):
        # A quoted paren inside $((...)) must not keep the skip open past a
        # real heredoc whose body quotes could then hide a live rm.
        self._make_tree()
        outside = self._outside_target()
        command = (
            'echo $(("(" <<1))\n'
            "cat <<EOF\n"
            "don't\n"
            "EOF\n"
            "rm -rf " + outside
        )
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_any_expansion_command_word_in_payloads(self):
        # $HOME and $PWD resolve as paths, but as a payload command word
        # they expand to whatever the environment holds (a reassigned HOME
        # is a command path); $HOMEFOO is a different variable entirely.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            'sh -c "$HOMEFOO"',
            f"HOME=/bin/rm; sh -c \"$HOME -rf {outside}\"",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_brace_and_backtick_expansion_command_words_in_payloads(self):
        # Round-10 regression guard: brace expansion and backticks in a
        # payload command position must fail closed like $-expansion does.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "eval '{rm,-rf} " + outside + "'",
            "sh -c '{rm,-rf} " + outside + "'",
            "bash -c '`{printf,printf} \"rm -rf " + outside + "\"`'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_substitution_in_data_heredoc_bodies(self):
        # An unquoted data body still expands $(...) before cat sees the
        # text, so blanking the body must keep substitution spans live:
        # the substitution executes even when the consumer only prints.
        self._make_tree()
        outside = self._outside_target()
        command = "printf 'cat <<EOF\n$(rm -rf " + outside + ")\nEOF' | sh"
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "file.txt").exists())
        # Benign substitutions in data bodies keep running (and print).
        result = await bash("printf 'cat <<EOF\n$(echo hi)\nEOF' | sh")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        # The same rule closes the plain top-level cat shape: the
        # substitution executes there too.
        with self.assertRaises(DestructiveRmRefusalError):
            bash("cat <<EOF\n$(rm -rf ~)\nEOF")

    async def test_operands_after_end_of_options_are_checked(self):
        self._make_tree()
        with self.assertRaises(DestructiveRmRefusalError):
            bash("rm -rf -- ..")
        self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_refuses_nested_heredoc_bodies_reaching_runners(self):
        # Rebase regression: a runner-reachable body can itself wrap an
        # interpreter-fed heredoc; blanking that inner body in the body pass
        # would hide its rm. The guard must split each body again with the
        # runner-aware scanner instead of masking it wholesale.
        self._make_tree()
        outside = self._outside_target()
        command = "sh <<'OUTER'\nsh <<INNER\nrm -rf " + outside + "\nINNER\nOUTER"
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "file.txt").exists())
        # The same nesting with data consumers stays data end to end: cat
        # prints the rm line instead of running it.
        result = await bash(
            "cat <<'OUTER'\ncat <<INNER\nrm -rf /printed-not-run\nINNER\nOUTER"
        )
        self.assertEqual(result.exit_code, 0)
        self.assertIn("rm -rf /printed-not-run", result.output)

    async def test_refuses_reassignments_from_outer_body_context(self):
        # A reassignment in a runner-fed body must keep tracking the bodies
        # it wraps: the nested rm expands $HOME/$PWD against the reassigned
        # value at run time. The guard-resolved paths exist on purpose, so a
        # lost reassignment context would resolve inside the workspace and
        # fail open.
        self._make_tree()
        with mock.patch.dict(os.environ, {"HOME": self.test_dir}):
            outside = self._outside_target()
            Path(outside, "ctx_home").mkdir()
            Path(outside, "ctx_home", "file.txt").write_text("keep\n")
            Path(self.test_dir, "ctx_home").mkdir()
            Path(self.test_dir, "ctx_home", "file.txt").write_text("keep\n")
            command = (
                "sh <<'OUTER'\n"
                f"HOME={outside}\n"
                "sh <<INNER\n"
                "rm -rf $HOME/ctx_home\n"
                "INNER\n"
                "OUTER"
            )
            with self.assertRaises(DestructiveRmRefusalError) as caught:
                bash(command)
            self.assertIn("reassigns HOME", str(caught.exception))
            self.assertTrue(Path(outside, "ctx_home", "file.txt").exists())
        outside = self._outside_target()
        Path(outside, "ctx").mkdir()
        Path(outside, "ctx", "file.txt").write_text("keep\n")
        Path(self.test_dir, "ctx").mkdir(exist_ok=True)
        Path(self.test_dir, "ctx", "file.txt").write_text("keep\n")
        command = (
            "sh <<'OUTER'\n"
            f"PWD={outside}\n"
            "sh <<INNER\n"
            "rm -rf $PWD/ctx\n"
            "INNER\n"
            "OUTER"
        )
        with self.assertRaises(DestructiveRmRefusalError) as caught:
            bash(command)
        self.assertIn("reassigns PWD", str(caught.exception))
        self.assertTrue(Path(outside, "ctx", "file.txt").exists())

    async def test_refuses_heredoc_wrapped_text_fed_to_stdin_shells(self):
        # Rebase regression: a producer whose output wraps rm in an
        # interpreter-fed heredoc still reaches a stdin shell as commands,
        # whether the payload carries literal newlines or printf escapes.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "printf 'sh <<EOF\nrm -rf " + outside + "\nEOF' | sh",
            "printf 'sh <<EOF\\nrm -rf " + outside + "\\nEOF' | sh",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A data consumer in the fed text stays data: the fed script runs
        # `cat <<EOF`, which prints the rm line instead of executing it.
        result = await bash("printf 'cat <<EOF\nrm -rf /printed-not-run\nEOF' | sh")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("rm -rf /printed-not-run", result.output)


    async def test_refuses_here_strings_a_shell_runs(self):
        # `sh <<< 'rm -rf x'` hands the operand to the interpreter's stdin
        # exactly like `printf ... | sh`, so the operand is live command text.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"sh <<< 'rm -rf {outside}'",
            f'bash <<< "rm -rf {outside}"',
            f"sh -s <<< 'rm -rf {outside}'",
            f"sudo sh <<< 'rm -rf {outside}'",
            f"echo hi\nsh <<< 'rm -rf {outside}'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # An operand the shell builds from expansion runs text the guard
        # cannot check.
        with self.assertRaises(DestructiveRmRefusalError) as caught:
            bash('sh <<< "$payload"')
        self.assertIn("here-string", str(caught.exception))
        # A data consumer keeps the operand as data, and a script argument
        # makes the interpreter ignore stdin.
        result = await bash("cat <<< 'rm -rf /printed-not-run'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("rm -rf /printed-not-run", result.output)
        Path(self._tracked("s.sh")).write_text("echo hi\n")
        result = await bash("sh s.sh <<< 'rm -rf /printed-not-run'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_allows_variable_based_non_recursive_rm(self):
        # The unresolvable-operand refusal targets recursive-force rm: a lone
        # expansion operand with nothing but options around it cannot supply
        # the flags, so variable-based cleanup keeps running.
        self._make_tree()
        for command in ['file=file.txt; rm "$file"', 'file=file.txt; rm -f "$file"']:
            with self.subTest(command=command):
                Path(self._tracked("file.txt")).write_text("x\n")
                result = await bash(command)
                self.assertEqual(result.exit_code, 0)
                self.assertFalse(self._tracked("file.txt").exists())
        # A word-splitting expansion can supply the flags itself, and a
        # single-word expansion sharing the invocation with another operand can
        # be that operand's flags.
        outside = self._outside_target()
        for command in [
            f"flags='-rf {outside}'; rm $flags",
            f'flags=-rf; rm "$flags" {outside}',
            f'rm "$file" {outside}',
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_process_substitution_scripts(self):
        # `bash <(printf 'rm -rf x')` runs the producer's output as a script
        # file, so the text the shell executes is built at run time.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "bash <(printf 'rm -rf %s\\n')" % outside,
            "sh <(echo 'rm -rf %s')" % outside,
            "source <(printf 'rm -rf %s\\n')" % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn("process substitution", str(caught.exception))
                self.assertTrue(Path(outside, "file.txt").exists())
        # A data argument is not a script, and a runner with its own -c payload
        # takes the substitution as a positional argument.
        result = await bash("cat <(printf 'rm -rf /printed-not-run\\n')")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("rm -rf /printed-not-run", result.output)
        result = await bash("bash -c 'echo hi' <(printf 'rm -rf /printed-not-run\\n')")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_exported_shell_function_bodies(self):
        # An exported function travels in `BASH_FUNC_name%%` environment
        # entries: the child shell imports it and runs the body under a command
        # name the literal scan reads as harmless.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"env 'BASH_FUNC_rm%%=() {{ /bin/rm -rf {outside}; }}' bash -c 'rm harmless'",
            f"env 'BASH_FUNC_wipe%%=() {{ /bin/rm -rf {outside}; }}' bash -c 'wipe'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn("wraps rm in", str(caught.exception))
                self.assertTrue(Path(outside, "file.txt").exists())
        # A benign exported function keeps running.
        result = await bash("env 'BASH_FUNC_greet%%=() { echo hi; }' bash -c 'greet'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_exported_function_entries_are_not_inherited(self):
        # The same entry in the kernel environment would be imported by every
        # spawned shell, so the spawn strips it.
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        with mock.patch.dict(
            os.environ, {"BASH_FUNC_rm%%": f"() {{ /bin/rm -rf {outside}/victim; }}"}
        ):
            child_env = bash_module._child_env()
            self.assertNotIn("BASH_FUNC_rm%%", child_env)
            result = await bash("rm -f harmless")
        self.assertEqual(result.exit_code, 0)
        self.assertTrue(Path(outside, "victim", "file.txt").exists())

    async def test_refuses_command_level_bash_env_startup_files(self):
        # Non-interactive bash sources $BASH_ENV before it runs anything, so a
        # command-level assignment points the child shell at a file the guard
        # never sees (the spawn only strips the inherited value).
        self._make_tree()
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        startup = str(self._tracked("startup.sh"))
        Path(startup).write_text(f"rm -rf {outside}/victim\n")
        for command in [
            f"BASH_ENV={startup} bash -c 'echo hi'",
            f"env BASH_ENV={startup} bash -c 'echo hi'",
            f"export BASH_ENV={startup}; bash -c 'echo hi'",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn("startup file", str(caught.exception))
                self.assertTrue(Path(outside, "victim", "file.txt").exists())
        # Without a shell that reads it, the value is an ordinary variable.
        result = await bash("BASH_ENV=startup.sh echo hi")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_alias_substituted_invocations(self):
        # Aliases substitute command text at parse time, so a later line can
        # run a command the source never names. The shell reads one complete
        # command at a time, so a definition does not reach commands on its
        # own line.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "shopt -s expand_aliases\nalias rm='rm -rf %s'\nrm harmless" % outside,
            "shopt -s expand_aliases\nalias del='rm'\ndel -rf %s" % outside,
            "shopt -s expand_aliases\nalias del='rm -rf %s'\ndel a\ndel b" % outside,
            "shopt -s expand_aliases\nalias a='rm'\nalias b='a -rf %s'\nb x" % outside,
            'shopt -s expand_aliases\nalias wipe=\'sh -c "rm -rf %s"\'\nwipe' % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # An alias body that hides no recursive-force rm keeps running: the
        # kernel spawns the command inside one brace group, so bash itself
        # reads it as a single parse unit and never expands the alias there.
        result = await bash(
            "shopt -s expand_aliases\nalias ll='echo hi'\nll || echo no-expansion"
        )
        self.assertEqual(result.exit_code, 0)
        self.assertIn("no-expansion", result.output)
        result = await bash(
            f"shopt -s expand_aliases; alias rm='rm -rf {outside}'; rm -f harmless"
        )
        self.assertEqual(result.exit_code, 0)
        self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_alias_substituted_payload_and_fed_text(self):
        # A shell that parses its own input one command at a time does expand
        # an alias defined on an earlier line, so payload text and text fed to
        # a stdin shell substitute the aliased command too.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "sh -c 'alias rm=\"rm -rf %s\"\nrm harmless'" % outside,
            "sh -c 'shopt -s expand_aliases\nalias rm=\"rm -rf %s\"\nrm harmless'"
            % outside,
            "eval 'shopt -s expand_aliases\nalias rm=\"rm -rf %s\"\nrm harmless'" % outside,
            "trap 'alias rm=\"rm -rf %s\"\nrm harmless' EXIT" % outside,
            "printf 'alias rm=\"rm -rf %s\"\nrm harmless' | sh" % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A payload that only prints the alias text stays data.
        result = await bash("sh -c 'echo \"alias rm=rm -rf /printed-not-run\"'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("alias rm=rm -rf /printed-not-run", result.output)

    async def test_refuses_command_words_built_by_assignment(self):
        # A literal assignment hands a later `$NAME` command word a whole
        # invocation, so the resolved text is scanned; a value the guard cannot
        # read statically is refused outright.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"X='rm -rf {outside}'; $X",
            f"X='rm -rf {outside}'; $X harmless",
            f'X=rm; "$X" -rf {outside}',
            f'X="rm -rf {outside}"; $X',
            "X=$(cat cmd.txt); $X",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A revealed value that hides nothing keeps running, and a reference
        # the command never assigns stays an ordinary shell variable.
        result = await bash("X='echo hi'; $X")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        result = await bash('ECHO_BIN=echo; "$ECHO_BIN" -u hi')
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_expansion_inside_wrapper_payloads(self):
        # Unresolvable flags or operands inside a payload hide the same
        # recursion the outer scan refuses.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "sh -c 'flags=-rf; rm $flags %s'" % outside,
            "eval 'flags=-rf; rm $flags %s'" % outside,
            "trap 'flags=-rf; rm $flags %s' EXIT" % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Benign payloads with expansion keep running.
        result = await bash("sh -c 'echo $UNSET_ARG hi'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_popd_relocated_rm(self):
        # `popd` and stack rotations move the shell to a directory the tracker
        # does not model, so a later relative rm can run outside the workspace.
        self._make_tree()
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        Path(self.test_dir, "victim").mkdir(exist_ok=True)
        Path(self.test_dir, "victim", "inside.txt").write_text("inside\n")
        for command in [
            f"cd {outside} && pushd {self.test_dir} && popd && rm -rf victim",
            f"cd {outside}; pushd {self.test_dir}; popd && rm -rf victim",
            f"cd {outside} && pushd {self.test_dir} && pushd +1 && rm -rf victim",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "victim", "file.txt").exists())
        # A plain pushd relocation still resolves precisely.
        self._make_tree()
        result = await bash(f"pushd {self.test_dir}/sub >/dev/null && rm -rf nested")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub", "nested").exists())

    async def test_refuses_here_strings_with_option_arguments(self):
        # `-o`/`-O`/`--option` consume the following word, so an interpreter
        # carrying them still takes its command text from stdin.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "bash -O extglob <<< 'rm -rf %s'" % outside,
            "bash -o pipefail <<< 'rm -rf %s'" % outside,
            "bash --option extglob <<< 'rm -rf %s'" % outside,
            "printf 'rm -rf %s\\n' | bash -O extglob" % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # An option-taking shell with its own -c payload keeps stdin unused,
        # and a benign operand still runs.
        result = await bash(
            "bash -O extglob -c 'echo hi' <<< 'rm -rf /printed-not-run'"
        )
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        result = await bash("bash -O extglob <<< 'echo hi'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_braced_parameter_command_words(self):
        # `"${@}"`, `"${*}"`, and the sliced forms split like `"$@"` even when
        # quoted, so they can supply the flags and the operand separately.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            'set -- -rf %s; rm "${@}"' % outside,
            'set -- -rf %s extra; rm "${@:1:2}"' % outside,
            'set -- -rf; rm "${*}" %s' % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A benign braced parameter keeps running, and a literal `[@]` is data.
        result = await bash('set -- file.txt; echo "${@}"')
        self.assertEqual(result.exit_code, 0)
        self.assertIn("file.txt", result.output)
        result = await bash('echo "[@]"')
        self.assertEqual(result.exit_code, 0)
        self.assertIn("[@]", result.output)

    async def test_refuses_prefixed_printf_producers(self):
        # The reconstruction must find the producer's command word through the
        # assignment, grouping, and exec-style prefixes in front of it.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "X=1 printf '%s%s %s %s\\n' r m -rf " + outside + " | sh",
            "command printf '%s%s %s %s\\n' r m -rf " + outside + " | sh",
            "! printf '%s%s %s %s\\n' r m -rf " + outside + " | sh",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A prefixed producer that only spells benign text keeps running.
        result = await bash("X=1 printf 'echo hi\\n' | sh")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_printf_format_reuse_producers(self):
        # Arguments that outlast the format reuse it, so every assembled line
        # is command text the consumer shell runs.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "printf '%s%s %s %s\\n' r m -rf " + outside + " dummy | sh",
            "printf '%s%s %s %s' r m -rf " + outside + " x y | sh",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Reused benign lines keep running.
        result = await bash("printf '%s\\n' 'echo hi' 'echo there' | sh")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        self.assertIn("there", result.output)

    async def test_refuses_appends_without_a_same_command_value(self):
        # `NAME+=` with no value the command itself set means the shell appends
        # to something the guard cannot read, so a later `$NAME` is refused.
        self._make_tree()
        outside = self._outside_target()
        with self.assertRaises(DestructiveRmRefusalError):
            bash("X+='rm -rf %s'; $X" % outside)
        self.assertTrue(Path(outside, "file.txt").exists())
        with mock.patch.dict(os.environ, {"X": "rm -rf "}):
            with self.assertRaises(DestructiveRmRefusalError) as caught:
                bash("X+=" + outside + "; $X")
        self.assertIn("is assigned text the guard cannot read", str(caught.exception))
        self.assertTrue(Path(outside, "file.txt").exists())
        # A value the command sets itself still resolves, and an append that is
        # never expanded keeps running.
        result = await bash("X='echo h'; X+='i'; $X")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        result = await bash("X+='not-run'; echo done")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("done", result.output)

    async def test_refuses_env_chdir_relocated_rm(self):
        # GNU `env -C dir` relocates the command it runs, so a relative operand
        # resolves against that directory, not the kernel cwd.
        self._make_tree()
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        Path(self.test_dir, "victim").mkdir(exist_ok=True)
        Path(self.test_dir, "victim", "inside.txt").write_text("inside\n")
        for command in [
            f"env -C {outside} rm -rf victim",
            f"env --chdir={outside} rm -rf victim",
            f"env -iC {outside} rm -rf victim",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "victim", "file.txt").exists())
        # A relocation inside the workspace keeps working.
        result = await bash("env -C sub rm -rf nested")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub", "nested").exists())

    async def test_refuses_startup_env_in_fed_argv_text(self):
        # `env -S` builds the argv of a shell that reads $BASH_ENV before it
        # runs anything, so a startup assignment inside the fed text must be
        # refused exactly like one in the outer command.
        self._make_tree()
        outside = self._outside_target()
        Path(outside, "victim").mkdir()
        Path(outside, "victim", "file.txt").write_text("keep\n")
        startup = str(self._tracked("startup.sh"))
        Path(startup).write_text(f"rm -rf {outside}/victim\n")
        for command in [
            "env -S 'BASH_ENV=startup.sh bash -c true'",
            "env -S 'BASH_ENV=startup.sh bash -c true' extra",
            "BASH_ENV=startup.sh bash -c true",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn("startup file", str(caught.exception))
                self.assertTrue(Path(outside, "victim", "file.txt").exists())
        # A fed argv that names no startup file keeps running.
        result = await bash("env -S 'VAR=1 echo hi'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_allows_argument_position_env_assignments(self):
        # An argument that merely looks like an assignment does not change the
        # environment, so it must not make `$PWD`/`$HOME` untrackable.
        self._make_tree()
        result = await bash('echo PWD=/tmp; rm -rf "$PWD/sub"')
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub").exists())
        self._make_tree()
        with mock.patch.dict(os.environ, {"HOME": self.test_dir}):
            result = await bash('echo HOME=/tmp; rm -rf "$HOME/sub"')
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(self._tracked("sub").exists())
        # The real reassignment forms stay refused, prefix and builtin alike,
        # and a keyword or grouping token does not close the assignment slot:
        # the shell still applies the assignment that follows it.
        self._make_tree()
        for command, message in [
            ('PWD=/tmp; rm -rf "$PWD/sub"', "reassigns PWD"),
            ('export FOO=1 PWD=/tmp; rm -rf "$PWD/sub"', "reassigns PWD"),
            ('unset PWD; rm -rf "${PWD:-.}/sub"', "reassigns PWD"),
            ('if true; then PWD=/tmp; fi; rm -rf "$PWD/sub"', "reassigns PWD"),
            ('{ PWD=/tmp; }; rm -rf "$PWD/sub"', "reassigns PWD"),
            ('for i in 1; do PWD=/tmp; done; rm -rf "$PWD/sub"', "reassigns PWD"),
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError) as caught:
                    bash(command)
                self.assertIn(message, str(caught.exception))

    async def test_refuses_env_split_string_argv(self):
        # GNU `env -S` splits its string into the argv it runs, so the split
        # words must be scanned like any other command text.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "env -S 'rm -rf %s'" % outside,
            "env --split-string='rm -rf %s'" % outside,
            "env -S 'CMD=$CMD rm -rf %s'" % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A split string that runs benign argv keeps working, and a string the
        # guard cannot read is refused rather than guessed at.
        result = await bash("env -S 'VAR=1 echo hi'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        with self.assertRaises(DestructiveRmRefusalError) as caught:
            bash("env -S '$SPLIT'")
        self.assertIn("expansion", str(caught.exception))

    async def test_refuses_ansi_c_quoted_words(self):
        # ANSI-C quoting decodes to the command the shell runs, so the decoded
        # text is what the scan reads (`$'rm'` is `rm`, `$'\x2drf'` is `-rf`).
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "$'rm' $'-rf' %s" % outside,
            "$'\x72m' $'-rf' %s" % outside,
            "$'rm' -rf %s" % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Decoded benign words keep running, escapes included.
        result = await bash("$'echo' $'a\tb'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("a\tb", result.output)

    async def test_refuses_glob_expanded_command_and_flag_words(self):
        # A glob expands before the command runs, so `?m -rf /outside` runs
        # `rm -rf /outside` when a matching file exists, and `-?f` becomes
        # `-rf` the same way.
        self._make_tree()
        outside = self._outside_target()
        Path(self.test_dir, "rm").write_text("x\n")
        Path(self.test_dir, "-rf").write_text("x\n")
        for command in [f"?m -rf {outside}", f"rm -?f {outside}"]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Unrelated globs, a glob operand of a non-recursive rm, and the `[`
        # test builtin (no pattern) still run.
        Path(self.test_dir, "a.log").write_text("x\n")
        result = await bash("rm -f *.log")
        self.assertEqual(result.exit_code, 0)
        result = await bash("ls -d sub >/dev/null")
        self.assertEqual(result.exit_code, 0)
        result = await bash("[ -d sub ] && echo ok")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("ok", result.output)

    async def test_refuses_format_string_pipeline_producers(self):
        # `printf` assembles the consumer's command text from its format string.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "printf '%s%s %s %s\\n' r m -rf " + outside + " | sh",
            "printf '%s %s\\n' 'rm -rf' " + outside + " | sh",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A format string that only spells benign text keeps running.
        result = await bash("printf '%s\\n' 'echo hi' | sh")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_alias_chains_past_the_expansion_limit(self):
        # A chain longer than the pass limit must fail closed instead of
        # scanning a partial expansion.
        self._make_tree()
        outside = self._outside_target()
        chain = [
            "shopt -s expand_aliases",
            "alias a1='rm'",
            "alias a2='a1 -rf'",
            f"alias a3='a2 {outside}'",
        ]
        chain += [f"alias a{index}='a{index - 1}'" for index in range(4, 10)]
        chain.append("a9")
        with self.assertRaises(DestructiveRmRefusalError):
            bash("\n".join(chain))
        self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_quoted_at_and_array_command_words(self):
        # `"$@"` and `"${name[@]}"` split into separate words even when quoted,
        # so one of them can supply the flags while another names the operand.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f'set -- -rf {outside}; rm "$@"',
            f'arr=(-rf {outside}); rm "${{arr[@]}}"',
            f'arr=(-rf); rm "${{arr[*]}}" {outside}',
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A quoted positional parameter that is not `$@` stays a single word.
        result = await bash('set -- file.txt; : "$1"; echo ok')
        self.assertEqual(result.exit_code, 0)
        self.assertIn("ok", result.output)

    async def test_refuses_appended_assignment_command_words(self):
        # `X+='...'` appends to the value the shell expands for a later `$X`.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            f"X+='rm -rf {outside}'; $X",
            f"X=rm; X+=' -rf {outside}'; $X",
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # Appending to a value that hides nothing keeps running.
        result = await bash("X='echo h'; X+='i'; $X")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_alias_names_split_across_quotes(self):
        # Adjacent quoted fragments fold into one word, so `al''ias` defines an
        # alias the raw text never spells out.
        self._make_tree()
        outside = self._outside_target()
        command = (
            "sh <<'EOT'\n"
            "al''ias rm='rm -rf %s'\n"
            "rm harmless\n"
            "EOT"
        ) % outside
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "file.txt").exists())

    async def test_refuses_here_strings_read_by_payload_shells(self):
        # A `-c` payload that reads stdin (`sh -c 'sh'`) runs the here-string
        # operand as its commands.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "sh -c 'sh' <<< 'rm -rf %s'" % outside,
            "sh -c 'exec sh' <<< 'rm -rf %s'" % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A payload that only prints the operand keeps it as data.
        result = await bash("sh -c 'cat' <<< 'rm -rf /printed-not-run'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("rm -rf /printed-not-run", result.output)

    async def test_refuses_inline_shell_feeds_inside_bodies(self):
        # A runner-fed body can itself hand a shell text inline: the pipeline
        # producer's output and a here-string operand are commands that shell
        # runs, and a process substitution is its script argument.
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "sh <<'OUTER'\nsh <<< 'rm -rf %s'\nOUTER" % outside,
            "sh <<'OUTER'\nprintf 'rm -rf %s\\n' | sh\nOUTER" % outside,
            "sh <<'OUTER'\nbash <(printf 'rm -rf %s\\n')\nOUTER" % outside,
        ]:
            with self.subTest(command=command):
                with self.assertRaises(DestructiveRmRefusalError):
                    bash(command)
                self.assertTrue(Path(outside, "file.txt").exists())
        # A data body keeps its inline text as data.
        result = await bash("cat <<'OUTER'\nsh <<< 'rm -rf /printed-not-run'\nOUTER")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("rm -rf /printed-not-run", result.output)

    async def test_refuses_alias_substituted_invocations_inside_bodies(self):
        # A runner-fed body runs in its own shell, so aliases that body defines
        # and invokes on a later line substitute text it never names.
        self._make_tree()
        outside = self._outside_target()
        command = (
            "sh <<'EOF'\n"
            "shopt -s expand_aliases\n"
            "alias del='rm -rf %s'\n"
            "del victim\n"
            "EOF"
        ) % outside
        with self.assertRaises(DestructiveRmRefusalError):
            bash(command)
        self.assertTrue(Path(outside, "file.txt").exists())


if __name__ == "__main__":
    unittest.main()
