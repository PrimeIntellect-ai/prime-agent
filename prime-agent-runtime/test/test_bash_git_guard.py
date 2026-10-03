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
    DestructiveGitRefusalError,
    is_destructive_git_discard_command,
)

# The package re-exports the bash() function under the same name, so reach the
# module through sys.modules for internals.
bash_module = sys.modules["rlm.bash"]

# Each guard's suite verifies one rule in isolation. The sibling guards fail
# closed on shapes this suite exercises (`bash <(...)`, `sh -c ...`, `env`,
# sudo runners), so the other five guards are bypassed for every call made by
# this module; the guard under test still runs unless a case asks for its own
# bypass. `_direct_bash` is the unshadowed entry point.
_SIBLING_GUARD_BYPASSES = {
    "allow_destructive_git": True,
    "allow_destructive_chmod": True,
    "allow_force_push": True,
    "allow_secret_echo": True,
    "allow_pipe_to_shell": True,
    "allow_sudo": True,
}
_OWN_GUARD_BYPASS = "allow_destructive_git"
_direct_bash = bash


def bash(command: str, **kwargs: object) -> object:  # type: ignore[no-redef]
    merged = {k: v for k, v in _SIBLING_GUARD_BYPASSES.items() if k != _OWN_GUARD_BYPASS}
    merged.update(kwargs)
    return _direct_bash(command, **merged)



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
        self._prev_env = dict(os.environ)
        os.environ.pop(BASH_DESTRUCTIVE_GIT_BYPASS_ENV, None)
        os.environ.pop("PRIME_AGENT_BASH_COMMAND_PREFIX", None)
        # The launch-time bypass snapshot is a module attribute frozen at
        # import; pin it to "unset" so a runner launched with the bypass
        # set cannot disarm these refusals.
        frozen_patch = mock.patch.object(
            bash_module, "_BASH_DESTRUCTIVE_GIT_BYPASS_AT_START", False
        )
        frozen_patch.start()
        self.addCleanup(frozen_patch.stop)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        # Restore cwd before the temp dir disappears (cleanups run LIFO).
        self.addCleanup(self._restore_env)
        self.addCleanup(os.chdir, self._prev_cwd)
        self.test_dir = temp.name
        # Hermetic git config, like the sibling force-push suite: every real
        # git this suite runs -- the commands bash() spawns and the guard's
        # own probe -- inherits this process environment, so an empty HOME
        # hides the runner's user config and GIT_CONFIG_NOSYSTEM the system
        # one. Global aliases, hooks, or url.*.insteadOf rewrites from the
        # runner must not reach the test repositories or the probes. (The
        # `_run_git` repo setup already pins HOME=cwd per call.)
        os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
        os.environ["HOME"] = str(self.test_dir)

    def _restore_env(self):
        os.environ.clear()
        os.environ.update(self._prev_env)

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

    def test_child_env_strips_late_bypass(self):
        # A mid-session os.environ write this kernel ignores must not reach
        # a child kernel's environment (a child would freeze it as its own
        # launch-time bypass); a kernel actually launched with the bypass
        # still passes it through.
        os.environ[BASH_DESTRUCTIVE_GIT_BYPASS_ENV] = "1"
        self.addCleanup(os.environ.pop, BASH_DESTRUCTIVE_GIT_BYPASS_ENV, None)
        # The launch-time snapshot is a module attribute frozen at import;
        # pin it to "unset" so the late-write rule decides, not the parent
        # process's launch environment (a runner launched with the bypass
        # set would otherwise legitimately keep the value).
        with mock.patch.object(
            bash_module, "_BASH_DESTRUCTIVE_GIT_BYPASS_AT_START", False
        ):
            self.assertNotIn(BASH_DESTRUCTIVE_GIT_BYPASS_ENV, bash_module._child_env())
        # A value the kernel actually started with is the intentional state.
        with mock.patch.object(bash_module, "_BASH_DESTRUCTIVE_GIT_BYPASS_AT_START", True):
            self.assertIn(BASH_DESTRUCTIVE_GIT_BYPASS_ENV, bash_module._child_env())

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
        # both run.
        result = await bash("git clean -n")
        self.assertEqual(result.exit_code, 0)
        result = await bash("G='git reset --hard'; G='echo hi' H=\"$G\"; $H")
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
            # Each case runs in its own repository, so one allowed command
            # cannot hide the next case's missed refusal.
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
