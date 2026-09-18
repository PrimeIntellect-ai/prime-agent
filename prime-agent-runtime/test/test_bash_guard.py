from __future__ import annotations

import asyncio
import io
import os
import time
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from rlm import bash
from rlm.bash import BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV, DestructiveChmodRefusalError

# The package re-exports the bash() function under the same name, so reach the
# module through sys.modules for internals.
bash_module = sys.modules["rlm.bash"]

# Every spawned command and probe in this suite carries an explicit timeout.
AWAIT_TIMEOUT = 10.0
SUBPROCESS_TIMEOUT = 60


def _prepare(command: str) -> str:
    """The guard's own normalization pipeline, for detection-vector tests."""
    resolved = bash_module._mask_shell_redirections(
        bash_module._normalize_line_continuations(command)
    )
    normalized, _index_map = bash_module._strip_shell_escapes(resolved)
    return normalized


def _invocations(command: str) -> list[tuple[int, int, int]]:
    return bash_module._find_recursive_chmod_chown_invocations(_prepare(command))


# Vectors for the recursive chmod/chown detector: an invocation must carry a
# recursive flag (-R bundled anywhere, or --recursive); a chmod without -R and
# a chown without -R never match. Quoted command words and quoted flags fold
# into their values, so they must match like the unquoted forms.
CHMOD_MATCHING_COMMANDS = [
    "chmod -R 755 sub", "chmod --recursive 755 sub",
    "chmod -vR 755 sub", "chmod -R 755 sub --reference=/tmp/mode",
    "chmod sub -R 755", "chmod 755 -R sub",
    "chown -R user sub", "chown --recursive user:group sub",
    "chown sub -R user", "chmod -R 755",
    "chmod -R 755 sub && chown -R user sub", "chmod -R 755 sub; echo done",
    "/bin/chmod -R 755 sub", '"chmod" -R 755 sub',
    "chmod '-R' 755 sub", '"chown" "-R" user sub',
    "\\chmod -R 755 sub", "sudo chmod -R 755 sub",
    "FOO=1 chmod -R 755 sub", "chmod -R \\\n755 sub",
    "chmod 2>/dev/null -R 755 sub", "chmod -R 755 sub 2>/dev/null",
    "chmod -R 755 &>/dev/null sub", "chmod -R 755 -- sub",
    "(chmod -R 755 sub)", "{ chmod -R 755 sub; }",
    "echo $(chmod -R 755 sub)", "chmod -R 755 sub # cleanup",
    "xargs chmod -R 755",
    # ANSI-C quoting folds into the word exactly like bash: $'chmod' scans
    # as chmod and $'-R' as -R, so both forms match like their unquoted
    # spellings, and $"..." (locale quoting) matches like double quotes.
    "$'chmod' -R 755 sub", "chmod $'-R' 755 sub",
    '$"chmod" -R 755 sub', "chmod -R 755 $'sub'",
    # GNU accepts every unambiguous prefix of --recursive: --rec through
    # --recursiv all run recursively.
    "chmod --rec 755 sub", "chmod --recur 755 sub",
    "chmod --recursiv 755 sub", "chown --recurs user sub",
]

CHMOD_NON_MATCHING_COMMANDS = [
    "chmod 755 sub", "chmod -v 755 sub",
    "chmod --changes 755 sub", "chmod -r 755 sub",
    "chmod +x sub", "chmod 755 .git",
    "chown user sub", "chown -h user sub",
    "chown user:group sub", "chmod -- 755 sub",
    "echo 'chmod -R 755 ~'", 'echo "chmod -R 755 ~"',
    "# chmod -R 755 sub", "echo one \\\n two",
    "git status", "echo hello world",
    "npm run check",
    # ANSI-C quoting of plain data stays data: an echoed payload never
    # scans as a command.
    "echo $'chmod -R 755 sub'",
    # --reference and --recursive share the --re prefix: the ambiguous
    # --ref is not a recursive flag (GNU rejects it as ambiguous), and
    # neither is any other long option.
    "chmod --ref 755 sub", "chmod --reference=/tmp/mode 755 sub",
    "chmod --changes 755 sub",
]


class RecursiveChmodDetectionTest(unittest.TestCase):
    def test_matches_recursive_chmod_chown(self):
        for command in CHMOD_MATCHING_COMMANDS:
            with self.subTest(command=command):
                self.assertTrue(_invocations(command))

    def test_does_not_match_other_commands(self):
        for command in CHMOD_NON_MATCHING_COMMANDS:
            with self.subTest(command=command):
                self.assertFalse(_invocations(command))

    def test_counts_each_invocation_in_compound_commands(self):
        self.assertEqual(len(_invocations("chmod -R 755 sub && chown -R u sub")), 2)


class ChmodEvalPayloadDetectionTest(unittest.TestCase):
    def test_eval_payloads_hiding_recursive_chmod_chown(self):
        for command in [
            "eval 'chmod -R 755 ~'",
            'eval "chown -R user ~"',
            "eval 'cd sub && chmod -R 755 .'",
            'eval "chmod -R 755 ~"',
            "eval 'eval \"chmod -R 755 ~\"'",
            '"eval" "chmod -R 755 ~"',
            "eval $(echo 'chmod -R 755 ~')",
            "eval 'chmod -R \\\n755 ~'",
            # Mixed and nested wrapper forms: the quoted sh -c payload
            # inside the eval payload must be rescanned too.
            'eval \'bash -c "chmod -R 755 ~"\'',
            'eval \'bash -c "chown -R user ~"\'',
            "eval $'chmod -R 755 ~'",
            # Quote- and ANSI-C-encoded wrapper names still fold to the
            # wrapper word, so their payloads must be inspected too.
            'e"val" \'chmod -R 755 ~\'',
            'ev"al" \'chmod -R 755 ~\'',
            "$'eval' 'chmod -R 755 ~'",
        ]:
            with self.subTest(command=command):
                self.assertTrue(
                    bash_module._eval_payloads_hide_recursive_chmod(command)
                )

    def test_safe_eval_payloads_stay_unflagged(self):
        for command in [
            "eval",
            "eval 'echo hi'",
            "eval 'chmod 755 sub'",
            'eval "echo \'chmod -R 755 ~\'"',
            "eval 'echo \"chmod -R 755 ~\"'",
            "echo 'eval chmod -R 755 ~'",
            "npm run eval:suite",
        ]:
            with self.subTest(command=command):
                self.assertFalse(
                    bash_module._eval_payloads_hide_recursive_chmod(command)
                )


class ShellCPayloadDetectionTest(unittest.TestCase):
    def test_shell_c_payloads_hiding_recursive_chmod_chown(self):
        for command in [
            "sh -c 'chmod -R 755 ~'",
            'bash -c "chown -R user ~"',
            "bash -lc 'chmod -R 755 ~'",
            "bash -xc 'chmod -R 755 ~'",
            "zsh -c 'chmod -R 755 ~'",
            "sh -e -c 'chmod -R 755 ~'",
            "sh -c $(echo 'chmod -R 755 ~')",
            "FOO=1 sh -c 'chmod -R 755 ~'",
            # Nested wrapper payloads: an inner quoted wrapper (eval or
            # another sh -c) is rescanned one quoting layer at a time.
            'sh -c \'bash -c "chmod -R 755 ~"\'',
            "bash -c 'eval \"chmod -R 755 ~\"'",
            "bash -c $'chmod -R 755 ~'",
            'bash -c $"chmod -R 755 ~"',
            # Payloads hiding shell code the scanner cannot resolve.
            "bash -c '$cmd -R 755 ~'",
            "bash -c 'BASH_ENV=/tmp/x echo hi'",
            'bash -c \'bash <(printf "chmod -R 755 ~")\'',
            'b"ash" -c \'chmod -R 755 ~\'',
            "$'bash' -c 'chmod -R 755 ~'",
        ]:
            with self.subTest(command=command):
                self.assertTrue(
                    bash_module._shell_c_payloads_hide_recursive_chmod(command)
                )

    def test_safe_shell_c_payloads_stay_unflagged(self):
        for command in [
            "sh -c 'echo hi'",
            "sh -c 'echo \"chmod -R 755 ~\"'",
            'bash -c "echo \'chmod -R 755 ~\'"',
            "bash -lc 'chmod 755 sub'",
            "sh --rcfile x -c 'echo hi'",
            "echo 'bash -c chmod -R 755 ~'",
            # Still-quoted data and non-executor runs inside payloads stay
            # inert: an echoed string never scans as a command.
            "sh -c 'echo $x -R hi'",
            "sh -c 'echo BASH_ENV=x'",
        ]:
            with self.subTest(command=command):
                self.assertFalse(
                    bash_module._shell_c_payloads_hide_recursive_chmod(command)
                )


class RecursiveChmodGuardTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._prev_cwd = os.getcwd()
        self._prev_env = dict(os.environ)
        os.environ.pop(BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV, None)
        os.environ.pop("PRIME_AGENT_BASH_COMMAND_PREFIX", None)
        # The launch-time bypass snapshot is a module attribute frozen at
        # import; pin it to "unset" so tests stay deterministic.
        frozen_patch = mock.patch.object(
            bash_module, "_DESTRUCTIVE_CHMOD_BYPASS_AT_KERNEL_START", False
        )
        frozen_patch.start()
        self.addCleanup(frozen_patch.stop)
        late_warn_patch = mock.patch.object(
            bash_module, "_destructive_chmod_late_bypass_warned", False
        )
        late_warn_patch.start()
        self.addCleanup(late_warn_patch.stop)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        # Restore cwd before the temp dir disappears (cleanups run LIFO).
        self.addCleanup(self._restore_env)
        self.addCleanup(os.chdir, self._prev_cwd)
        self.test_dir = temp.name
        os.chdir(self.test_dir)

    def _restore_env(self):
        os.environ.clear()
        os.environ.update(self._prev_env)

    def _make_tree(self) -> None:
        Path(self.test_dir, "sub", "nested").mkdir(parents=True, exist_ok=True)
        Path(self.test_dir, "sub", "nested", "file.txt").write_text("x\n")
        Path(self.test_dir, "my dir").mkdir(exist_ok=True)
        Path(self.test_dir, "my dir", "file.txt").write_text("x\n")
        Path(self.test_dir, "file.txt").write_text("x\n")

    def _outside_target(self) -> Path:
        """A sibling directory outside the workspace with a file in it."""
        outside = Path(self.test_dir).parent / (
            "outside-sibling-" + os.path.basename(self.test_dir)
        )
        outside.mkdir(exist_ok=True)
        (outside / "file.txt").write_text("keep\n")
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        return outside

    def _tracked(self, *parts: str) -> Path:
        return Path(self.test_dir, *parts)

    async def _run(self, command: str, **kwargs):
        return await asyncio.wait_for(bash(command, **kwargs), AWAIT_TIMEOUT)

    async def _refused(self, command: str, home: str | None = None):
        with mock.patch.dict(os.environ, {"HOME": home} if home else {}):
            with self.assertRaises(DestructiveChmodRefusalError) as caught:
                bash(command)
        return str(caught.exception)

    async def test_refuses_escapes_to_home_root_and_outside_trees(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        for command in [
            "chmod -R 755 ~",
            "chmod -R 755 ~/",
            "chmod -R 755 ~/anything",
            "chmod -R 755 $HOME",
            "chmod -R 755 $HOME/anything",
            "chmod -R 755 ${HOME}/anything",
            # Quote provenance is not tracked, so a single-quoted $HOME
            # scans as its expansion: a named fail-closed over-refusal.
            "chmod -R 755 '$HOME'",
            "chown -R user ~",
            "chown -R user $HOME",
            "chmod -R 755 /",
            "chmod -R 755 //",
            "chown -R user /",
            "chmod -R 755 /tmp/pa-chmod-guard-elsewhere",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())

    async def test_refuses_parent_directory_escapes(self):
        self._make_tree()
        outside = self._outside_target()
        for command in [
            "chmod -R 755 ..",
            "chmod -R 755 ./..",
            f"chmod -R 755 ../{outside.name}",
            "chown -R user ..",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue((outside / "file.txt").exists())
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_refuses_dot_dirs_and_dotfiles(self):
        self._make_tree()
        Path(self.test_dir, ".git", "objects").mkdir(parents=True, exist_ok=True)
        Path(self.test_dir, ".env").write_text("SECRET=1\n")
        Path(self.test_dir, "sub", ".env.local").write_text("SECRET=1\n")
        Path(self.test_dir, ".venv", "bin").mkdir(parents=True, exist_ok=True)
        for command in [
            "chmod -R 755 .git",
            "chmod -R 755 sub/.git",
            "chmod -R 755 .env",
            "chmod -R 755 .env.local",
            "chmod -R 755 sub/.env.local",
            "chmod -R 755 .venv",
            "chown -R user .git",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertIn("dot", message.lower())
                self.assertEqual(self._tracked(".env").read_text(), "SECRET=1\n")

    async def test_refuses_operands_it_cannot_resolve(self):
        self._make_tree()
        for command in [
            "chmod -R 755 *",
            "chmod -R 755 build/*",
            "chmod -R 755 $SECRET",
            "chmod -R 755 $(pwd)",
            "chmod -R 755 `pwd`",
            "chmod -R 755 ~otheruser",
            "chmod -R 755 {}",
            "chown -R $(id -u) sub",
            "echo hi | xargs chmod -R 755",
            "find . -name x -exec chmod -R 755 {} +",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_refuses_quoted_command_and_flag_forms(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        for command in [
            '"chmod" -R 755 ~',
            "chmod '-R' 755 ~",
            '"chmod" "-R" "755" ~',
            '"chown" -R user ~',
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())

    async def test_symlink_escape_refused(self):
        victim = tempfile.TemporaryDirectory()
        self.addCleanup(victim.cleanup)
        Path(victim.name, "keep").mkdir()
        os.symlink(victim.name, str(self._tracked("link")))
        message = await self._refused("chmod -R 755 link")
        self.assertIn("Refusing to run this recursive chmod/chown command", message)
        self.assertTrue(Path(victim.name, "keep").exists())

    async def test_allows_inside_workspace_recursion(self):
        for command in [
            "chmod -R 755 sub",
            "chmod -R 755 ./sub",
            # An absolute PATH cannot shadow the command word.
            "PATH=/usr/bin:/bin chmod -R 755 sub",
            "chmod -R 755 sub/nested",
            'chmod -R 755 "my dir"',
            "chmod -R 755 $PWD/sub",
            "chmod -R 755 .",
            "chmod -R 755 ./",
            "chmod -R 755 sub/..",
            "chmod -R u+x sub",
            f"chown -R {os.getuid()} sub",
            f"chown -R {os.getuid()}:{os.getgid()} sub",
            'chmod -R 755 sub ./"my dir"',
        ]:
            with self.subTest(command=command):
                self._make_tree()
                result = await self._run(command)
                self.assertEqual(result.exit_code, 0)

    async def test_reference_values_are_not_checked_as_operands(self):
        self._make_tree()
        # --reference only reads a mode, so its value may name any path; the
        # mode conflict makes chmod itself fail, but the guard must not.
        result = await self._run("chmod -R --reference=/etc/hosts 755 sub")
        self.assertNotEqual(result.exit_code, 0)

    async def test_non_recursive_chmod_chown_untouched(self):
        self._make_tree()
        Path(self.test_dir, ".git").mkdir()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # No -R anywhere: the guard must not match, even for escapes.
        with mock.patch.dict(os.environ, {"HOME": home.name}):
            for command in ["chmod 755 ~", "chown %d ~" % os.getuid()]:
                with self.subTest(command=command):
                    result = await self._run(command)
                    self.assertEqual(result.exit_code, 0)
        result = await self._run("chmod 755 .git")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("chmod +x sub")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("chown %d sub" % os.getuid())
        self.assertEqual(result.exit_code, 0)

    async def test_kwarg_bypass_runs_the_change(self):
        outside = self._outside_target()
        result = await self._run(
            f"chmod -R 755 ../{outside.name}", allow_destructive_chmod=True
        )
        self.assertEqual(result.exit_code, 0)
        self.assertTrue((outside / "file.txt").exists())

    async def test_frozen_bypass_env_honored_when_set_at_launch(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "pa-chmodguard-noop").mkdir()
        with (
            mock.patch.dict(os.environ, {"HOME": home.name}),
            mock.patch.object(
                bash_module, "_DESTRUCTIVE_CHMOD_BYPASS_AT_KERNEL_START", True
            ),
        ):
            result = await self._run("chmod -R 755 ~/pa-chmodguard-noop")
            self.assertEqual(result.exit_code, 0)

    async def test_frozen_bypass_zero_still_refuses(self):
        with mock.patch.object(
            bash_module, "_DESTRUCTIVE_CHMOD_BYPASS_AT_KERNEL_START", False
        ):
            message = await self._refused("chmod -R 755 ~")
        self.assertIn("Refusing to run this recursive chmod/chown command", message)

    async def test_mid_session_env_write_does_not_unlock(self):
        stderr = io.StringIO()
        with (
            mock.patch.dict(os.environ, {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV: "1"}),
            redirect_stderr(stderr),
        ):
            message = await self._refused("chmod -R 755 ~")
        self.assertIn("Refusing to run this recursive chmod/chown command", message)
        warning = stderr.getvalue()
        self.assertIn(BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV, warning)
        self.assertIn("appeared after kernel start", warning)
        # The warning fires once, and a falsy mid-session value stays inert.
        second = io.StringIO()
        with (
            mock.patch.dict(os.environ, {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV: "0"}),
            redirect_stderr(second),
        ):
            await self._refused("chmod -R 755 /")
        self.assertEqual(second.getvalue(), "")

    async def test_refuses_eval_wrapped_recursion(self):
        self._make_tree()
        for command in [
            "eval 'chmod -R 755 ~'",
            'eval "chown -R user ~"',
            "eval 'eval \"chmod -R 755 ~\"'",
            '"eval" "chmod -R 755 ~"',
            "eval 'cd sub && chmod -R 755 .'",
            "eval $(echo 'chmod -R 755 ~')",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("wraps a recursive chmod/chown in eval", message)
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_eval_refusal_honors_the_bypass_kwarg(self):
        self._make_tree()
        result = await self._run(
            "eval 'chmod -R 755 sub'", allow_destructive_chmod=True
        )
        self.assertEqual(result.exit_code, 0)

    async def test_safe_eval_commands_still_run(self):
        result = await self._run("eval 'echo hi'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        # Unquoting one level at a time must not mistake still-quoted data
        # for a payload command: this eval only prints the string.
        result = await self._run("eval \"echo 'chmod -R 755 ~'\"")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("chmod -R 755 ~", result.output)

    async def test_refuses_shell_c_wrapped_recursion(self):
        self._make_tree()
        for command in [
            "sh -c 'chmod -R 755 ~'",
            "bash -c 'chown -R user ~'",
            "bash -lc 'chmod -R 755 ~'",
            "sh -c $(echo 'chmod -R 755 ~')",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("inside a quoted `sh -c` payload", message)
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_safe_shell_c_commands_still_run(self):
        result = await self._run("sh -c 'echo hi'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        result = await self._run("sh -c 'echo \"chmod -R 755 ~\"'")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("chmod -R 755 ~", result.output)

    async def test_quoted_data_is_untouched(self):
        for command in [
            "echo 'chmod -R 755 ~'",
            'echo "chown -R user ~"',
        ]:
            with self.subTest(command=command):
                result = await self._run(command)
                self.assertEqual(result.exit_code, 0)

    async def test_refuses_xargs_fed_recursion(self):
        self._make_tree()
        for command in [
            "echo hi | xargs chmod -R 755",
            "find . | xargs chmod -R 755",
            "xargs chmod -R 755 < list.txt",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("changes directory (or wraps the command in xargs)", message)
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())

    async def test_refuses_unresolvable_command_names(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # A variable or substitution could expand into chmod/chown itself:
        # with a recursive flag present the run is refused, not guessed at.
        for command in [
            "cmd=chmod; $cmd -R 755 ~",
            "cmd=chown; $cmd -R user ~",
            "$(printf chmod) -R 755 ~",
            "`printf chmod` -R 755 ~",
            "${cmd} -R 755 ~",
            "sudo $cmd -R 755 ~",
            "xargs $(printf chmod) -R 755 ~",
            "FOO=1 $cmd -R 755 ~",
            "cmd=chmod; $cmd --recursive 755 ~", "cmd=chmod; $\\\ncmd -R 755 ~",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("command name cannot be determined", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Without a recursive flag, in a non-executor run, or behind a
        # resolvable command word, nothing is refused.
        result = await self._run("cmd=chmod; $cmd 755 sub")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("echo $var -R hi")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("FOO=$x chmod -R 755 sub")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_ansi_c_quoted_forms(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # $'...' folds into the word exactly like bash, so ANSI-C quoted
        # command names, flags, and operands scan like their unquoted
        # spellings.
        for command in [
            "$'chmod' -R 755 ~",
            "chmod $'-R' 755 ~",
            "$'chown' -R user ~",
            "chmod -R 755 $'~'",
            "chmod -R 755 $'~/sub'",
            '$"chmod" -R 755 ~',
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn(
                    "Refusing to run this recursive chmod/chown command", message
                )
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # In-workspace ANSI-C forms run like their unquoted spellings.
        self._make_tree()
        result = await self._run("chmod -R 755 $'sub'")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("chmod $'-R' 755 $'sub'")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_cdpath_relocations(self):
        self._make_tree()
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        Path(outside.name, "sub").mkdir()
        Path(outside.name, "sub", "file.txt").write_text("keep\n")
        # With CDPATH armed, `cd sub` can land in any CDPATH directory
        # before the workspace fallback, so the relocation is refused.
        with mock.patch.dict(os.environ, {"CDPATH": outside.name}):
            message = await self._refused("cd sub && chmod -R 755 .")
        self.assertIn("changes directory", message)
        self.assertTrue(Path(outside.name, "sub", "file.txt").exists())
        # Dot-prefixed targets never consult CDPATH and stay resolvable.
        with mock.patch.dict(os.environ, {"CDPATH": outside.name}):
            result = await self._run("cd ./sub && chmod -R 755 .")
            self.assertEqual(result.exit_code, 0)
        # An empty CDPATH behaves like unset for bash, and so for the guard.
        with mock.patch.dict(os.environ, {"CDPATH": ""}):
            result = await self._run("cd sub && chmod -R 755 .")
            self.assertEqual(result.exit_code, 0)
        # A CDPATH assignment in the command arms the same fail-closed path,
        # and the append form arms it exactly like the plain one.
        for command in [
            f"CDPATH={outside.name}; cd sub && chmod -R 755 .",
            f"CDPATH+={outside.name}; cd sub && chmod -R 755 .",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("changes directory", message)
        self.assertTrue(Path(outside.name, "sub", "file.txt").exists())

    async def test_refuses_bash_env_arming(self):
        self._make_tree()
        # bash runs $BASH_ENV before the command text, so arming it from
        # the command is refused: that file's shell code is unscannable.
        for command in [
            "BASH_ENV=/tmp/x echo hi", "BASH_ENV+=/tmp/x echo hi",
            "FOO=1 BASH_ENV=/tmp/x echo hi",
            "env BASH_ENV=/tmp/x echo hi",
            "sudo BASH_ENV=/tmp/x echo hi",
            "export BASH_ENV=/tmp/x",
            "declare -x BASH_ENV=/tmp/x",
            "bash -c 'BASH_ENV=/tmp/x echo hi'",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("BASH_ENV", message)
        # Reading or removing BASH_ENV stays fine.
        for command in [
            "echo BASH_ENV=x",
            'echo "$BASH_ENV"',
            "unset BASH_ENV",
            "env -u BASH_ENV echo hi",
        ]:
            with self.subTest(command=command):
                result = await self._run(command)
                self.assertEqual(result.exit_code, 0)

    async def test_inherited_bash_env_is_stripped(self):
        # The kernel child environment never carries BASH_ENV/ENV: bash
        # would execute that file's shell code before every command, and
        # the guard cannot scan a file.
        victim = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, victim, ignore_errors=True)
        Path(victim, "keep.txt").write_text("keep\n")
        marker = Path(self.test_dir, "bash-env-ran")
        env_file = Path(self.test_dir, "destructive-env.sh")
        env_file.write_text(f"chmod -R 755 {victim}\ntouch {marker}\n")
        with mock.patch.dict(os.environ, {"BASH_ENV": str(env_file)}):
            result = await self._run("echo hi")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(marker.exists())  # the file never executed
        self.assertTrue(Path(victim, "keep.txt").exists())
        # A direct unit check on the child env construction.
        with mock.patch.dict(os.environ, {"BASH_ENV": "/tmp/x", "ENV": "/tmp/y"}):
            child_env = bash_module._child_env()
        self.assertNotIn("BASH_ENV", child_env)
        self.assertNotIn("ENV", child_env)
        # An exported shell function imports the same way, so it is dropped too.
        marker = Path(self.test_dir, "imported-ran")
        with mock.patch.dict(
            os.environ, {"BASH_FUNC_pa_probe%%": f"() {{ touch {marker}; }}"}
        ):
            child_env = bash_module._child_env()
            result = await self._run("pa_probe")
        self.assertNotIn("BASH_FUNC_pa_probe%%", child_env)
        self.assertNotEqual(result.exit_code, 0)
        self.assertFalse(marker.exists())

    async def test_refuses_process_substitution_wrappers(self):
        self._make_tree()
        for command in [
            "bash <(printf 'chmod -R 755 ~\\n')",
            "sh <(printf 'chmod -R 755 ~\\n')",
            ". <(printf 'chmod -R 755 ~\\n')",
            "env bash <(printf 'chmod -R 755 ~\\n')",
            "bash >(printf 'chmod -R 755 ~\\n')",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("process substitution", message)
        # Process substitutions that never feed a shell wrapper stay fine.
        result = await self._run("cat <(echo hi)")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        result = await self._run("diff <(echo a) <(echo a)")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_nested_quoted_wrappers(self):
        self._make_tree()
        for command, needle in [
            ('eval \'bash -c "chmod -R 755 ~"\'', "in eval"),
            ('sh -c \'bash -c "chmod -R 755 ~"\'', "`sh -c`"),
            ('bash -c \'eval "chmod -R 755 ~"\'', "`sh -c`"),
            ("eval $'chmod -R 755 ~'", "in eval"),
            ("bash -c $'chmod -R 755 ~'", "`sh -c`"),
            ('bash -c $"chmod -R 755 ~"', "`sh -c`"),
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn(needle, message)
                self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())
        # Still-quoted data inside payloads stays inert.
        result = await self._run('sh -c \'echo "chmod -R 755 ~"\'')
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_abbreviated_recursive_flags(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # GNU accepts every unambiguous prefix of --recursive.
        for command in [
            "chmod --rec 755 ~",
            "chmod --recur 755 ~",
            "chmod --recurse 755 ~",
            "chmod --recurs 755 ~",
            "chmod --recursi 755 ~",
            "chmod --recursiv 755 ~",
            "chown --rec user ~",
            "chown --recursiv user:group ~",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn(
                    "Refusing to run this recursive chmod/chown command", message
                )
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # In-workspace abbreviated recursion is guarded, not blanket
        # refused (BSD chmod errors on long options; || true covers both
        # platforms), and the ambiguous --ref prefix is not a recursive flag.
        self._make_tree()
        result = await self._run("chmod --rec 755 sub || true")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("chmod --ref 755 sub || true")
        self.assertEqual(result.exit_code, 0)
        self.assertNotEqual(result.output.strip(), "")

    async def test_refuses_encoded_wrapper_names(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # Quote- and ANSI-C-encoded wrapper names fold to the wrapper word
        # in the scan, so their quoted payloads must be inspected even
        # though no contiguous `eval`/`bash` text appears.
        for command in [
            'e"val" \'chmod -R 755 ~\'',
            'ev"al" \'chmod -R 755 ~\'',
            "$'eval' 'chmod -R 755 ~'",
            'b"ash" -c \'chmod -R 755 ~\'',
            "$'bash' -c 'chmod -R 755 ~'",
            'b"ash" -c \'chown -R user ~\'',
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Encoded wrappers with harmless payloads stay fine.
        result = await self._run('e"val" \'echo hi\'')
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_refuses_glob_and_brace_command_names(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # Pathname and brace expansion can turn an unrecognized command word
        # into chmod/chown, so expandable command words are unresolvable and
        # refused with a recursive flag in the run.
        for command in [
            "/usr/bin/chmo? -R 755 ~",
            "{ch,}mod -R 755 ~",
            "chmo[d] -R 755 ~",
            "{chown,other} -R user ~",
            "ch*mod -R 755 ~",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("command name cannot be determined", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Glob characters stay data outside command position.
        result = await self._run("ls *.txt || true")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("echo * -R || true")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_heredoc_quote_hiding(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # A here-document body is data: an unmatched quote in it must not
        # corrupt the scanner and hide a later real command, so the body is
        # masked through its terminator before scanning shell syntax.
        for command in [
            "cat <<EOF\n'\nEOF\nchmod -R 755 ~",
            'cat <<"EOF"\nx"\nEOF\nchmod -R 755 ~',
            "cat <<'EOF'\n'\nEOF\nchmod -R 755 ~",
            "cat <<-EOF\n\t'\n\tEOF\nchmod -R 755 ~",
            "cat 2<<EOF\n'\nEOF\nchmod -R 755 ~",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Heredoc bodies that are plain data for their reader stay allowed.
        result = await self._run("cat <<EOF\nchmod -R 755 ~\nEOF")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("chmod -R 755 ~", result.output)

    async def test_refuses_function_and_alias_indirection(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # A function forwards its call arguments into the definition, and
        # an alias body is shell code: both can carry a recursive chmod the
        # plain scan splits across definition and call, so the combination
        # is refused.
        for command in [
            'f() { chmod "$@"; }; f -R 755 ~',
            'function f { chmod "$@"; }; f -R 755 ~',
            'alias x=\'chmod -R 755 ~\'; x',
            'alias x=\'chmod -R 755 ~\'',
            'alias x="chown -R user ~"; x',
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Definitions without a recursive chmod pattern stay fine.
        result = await self._run('f() { echo hi; }; f')
        self.assertEqual(result.exit_code, 0)
        result = await self._run("alias ll='ls -la'")
        self.assertEqual(result.exit_code, 0)
        result = await self._run('f() { chmod 755 sub; }; f')
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_flagged_procsub_and_pipe_fed_wrappers(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # Wrapper options between the wrapper and the process substitution
        # still end in the substitution's output as the wrapper's script,
        # and a bare shell wrapper fed by a pipe runs the piped text as
        # shell code: both are refused.
        for command in [
            "bash -- <(printf 'chmod -R 755 ~\\n')",
            "bash -x <(printf 'chmod -R 755 ~\\n')",
            "sh -- <(printf 'chmod -R 755 ~\\n')",
            "bash < <(printf 'chmod -R 755 ~\\n')",
            "bash <<< \"$(printf 'chmod -R 755 ~')\"",
            "printf 'chmod -R 755 ~' | bash",
            "printf 'chmod -R 755 ~' | sh",
            "printf 'chmod -R 755 ~' | bash -s",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("cannot be scanned statically", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Wrappers governed by a -c payload or a script argument, and pipes
        # into non-wrappers, stay fine.
        result = await self._run("printf x | bash -c 'echo hi'")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("printf hi | tee log.txt")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("cat <(echo hi)")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_cdpath_dot_named_targets(self):
        self._make_tree()
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        Path(outside.name, ".config").mkdir()
        Path(outside.name, ".config", "file.txt").write_text("keep\n")
        with mock.patch.dict(os.environ, {"CDPATH": outside.name}):
            # bash searches CDPATH before the current directory for any
            # relative target whose first component is not `.` or `..`,
            # so dot-named targets like `.config` are refused, not exempt.
            message = await self._refused("cd .config && chmod -R 755 .")
        self.assertIn("changes directory", message)
        self.assertTrue(Path(outside.name, ".config", "file.txt").exists())
        with mock.patch.dict(os.environ, {"CDPATH": outside.name}):
            message = await self._refused("cd .config/../. && chmod -R 755 .")
        self.assertIn("changes directory", message)
        # Only `.`/`..` and `./`/`../`-prefixed targets are exempt: they
        # never consult CDPATH (verified against bash).
        with mock.patch.dict(os.environ, {"CDPATH": outside.name}):
            result = await self._run("cd ./sub && chmod -R 755 .")
            self.assertEqual(result.exit_code, 0)
            result = await self._run("cd .. && echo ok")
            self.assertEqual(result.exit_code, 0)

    async def test_argument_position_chmod_words_stay_guarded(self):
        # Deliberate fail-closed design: any word that scans as chmod/chown
        # starts operand checking, because executors present the command in
        # argument position (`sudo chmod`, `xargs chmod`, `find -exec chmod`,
        # `FOO=1 chmod`, and unknown executors like `busybox chmod`). The
        # accepted tradeoff: commands that merely print such text are
        # refused with the documented bypass instead of being allowed.
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        for command in [
            "sudo chmod -R 755 ~",
            "busybox chmod -R 755 ~",
            "printf '%s\\n' chmod -R ~",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())

    async def test_refuses_heredoc_fed_wrapper_bodies(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # A shell wrapper fed by a here-document runs the body as its
        # script, so the body is scanned with the full guard instead of
        # staying masked; a heredoc inside a command substitution flows out
        # as text that can become code, so its body is scanned too.
        for command in [
            "bash <<EOF\nchmod -R 755 ~\nEOF",
            "sh <<EOF\nchmod -R 755 ~\nEOF",
            "sh <<'EOF'\nchmod -R 755 ~\nEOF",
            'bash <<"EOF"\nchown -R user ~\nEOF',
            "bash -s <<EOF\nchmod -R 755 ~\nEOF",
            'eval "$(cat <<EOF\nchmod -R 755 ~\nEOF)"',
            "bash <<EOF\ncd ~ && chmod -R 755 .\nEOF",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Benign wrapper bodies and data bodies for non-wrappers stay fine,
        # and in-workspace recursion inside a wrapper body stays allowed.
        result = await self._run("bash <<EOF\necho hi\nEOF")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        result = await self._run("cat <<EOF\nchmod -R 755 ~\nEOF")
        self.assertEqual(result.exit_code, 0)
        self._make_tree()
        result = await self._run("bash <<EOF\nchmod -R 755 sub\nEOF")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_procsub_after_option_arguments(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # Option words and their arguments no longer hide a process
        # substitution feeding the wrapper.
        for command in [
            "bash -o vi <(printf 'chmod -R 755 ~\\n')",
            "bash --rcfile <(printf 'chmod -R 755 ~\\n')",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("process substitution", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # A -c payload still governs.
        result = await self._run("bash -c 'echo hi' <(echo x)")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_subshell_function_bodies(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # A function body may be any compound command: a subshell body
        # forwards "$@" exactly like a brace body.
        for command in [
            'f() (chmod "$@"); f -R 755 ~',
            'function f (chmod "$@"); f -R 755 ~',
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        result = await self._run('f() (echo hi); f')
        self.assertEqual(result.exit_code, 0)

    async def test_trailing_heredoc_operator_does_not_crash(self):
        # A heredoc operator at end of string is a shell syntax error, not
        # a guard crash: the command runs to bash's own error.
        result = await self._run("cat <<")
        self.assertNotEqual(result.exit_code, 0)
        result = await self._run("cat <<-")
        self.assertNotEqual(result.exit_code, 0)

    async def test_ansi_c_overflow_escape_does_not_crash(self):
        # An ANSI-C escape above Unicode's maximum code point is preserved
        # instead of crashing the guard; bash itself errors on it.
        result = await self._run("echo $'\\U00110000' || true")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_wrapper_scripts_outside_the_workspace(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # A bare shell wrapper executes a script file the guard cannot scan;
        # inputs from outside the workspace (or unresolvable paths) are
        # refused, in-workspace scripts stay allowed.
        for command in [
            "bash /tmp/pa-guard-script.sh",
            "sh /tmp/pa-guard-script.sh",
            "bash < /tmp/pa-guard-script.sh",
            "sh </tmp/pa-guard-script.sh",
            "bash ~/pa-guard-script.sh",
            "bash $script",
            "source /tmp/pa-guard-script.sh",
            ". /tmp/pa-guard-script.sh",
            "bash ../pa-guard-script.sh",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("outside the kernel workspace", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # In-workspace script inputs stay allowed, and a -c payload governs.
        Path(self.test_dir, "ok.sh").write_text("echo ran\n")
        result = await self._run("bash ./ok.sh")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("ran", result.output)
        result = await self._run("bash < ./ok.sh")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("ran", result.output)
        result = await self._run("source ./ok.sh")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_recursive_traps(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # A trap body executes at trigger time, so it is scanned like any
        # wrapper payload.
        for command in [
            "trap 'chmod -R 755 ~' EXIT",
            'trap "chown -R user ~" DEBUG',
            "trap 'chmod -R 755 /' ERR",
            'bash -c \'trap "chmod -R 755 ~" EXIT\'',
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Benign traps stay fine.
        result = await self._run("trap 'echo done' EXIT")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_dynamic_commands_behind_more_executors(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # Command-executing wrappers beyond the first set: a dynamic command
        # word behind them is refused with a recursive flag in the run.
        for command in [
            "nice $cmd -R 755 ~",
            "timeout 5 $cmd -R 755 ~",
            "setsid $cmd -R 755 ~",
            "stdbuf -o0 $cmd -R 755 ~",
            "ionice -c2 $cmd -R 755 ~",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("command name cannot be determined", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Known-benign runs with variables and -R stay untouched.
        result = await self._run("grep -R $pattern file.txt || true")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_unresolvable_wrapper_payloads(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # A quoted wrapper payload whose command position is a variable or
        # substitution is refused outright: the payload could be any
        # command, including a recursive chmod the guard never sees.
        for command in [
            "p='chmod -R 755 ~'; bash -c \"$p\"",
            "p='chmod -R 755 ~'; sh -c \"$p\"",
            "p='chown -R user ~'; eval \"$p\"",
            'bash -c "$(printf %s \'chmod -R 755 ~\')"',
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Resolvable payload content with variables in data position stays
        # fine.
        result = await self._run("bash -c 'echo $x'")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("sh -c 'echo $x -R hi'")
        self.assertEqual(result.exit_code, 0)

    async def test_script_inputs_follow_cd_relocations(self):
        self._make_tree()
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        Path(outside.name, "evil.sh").write_text("chmod -R 755 /\n")
        # A relocating cd changes where the wrapper reads its script: the
        # script operand resolves against the relocated directory, and an
        # unresolvable relocation refuses.
        message = await self._refused(
            f"cd {outside.name} && bash script.sh"
        )
        self.assertIn("outside the kernel workspace", message)
        message = await self._refused("cd $(pwd) && bash /tmp/x.sh")
        self.assertIn("Refusing to run this recursive chmod/chown command", message)
        result = await self._run("cd sub && bash script.sh || true")
        self.assertEqual(result.exit_code, 0)

    async def test_script_gate_covers_executors_and_payloads(self):
        self._make_tree()
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        Path(outside.name, "evil.sh").write_text("chmod -R 755 /\n")
        evil = str(Path(outside.name, "evil.sh"))
        # The script-input gate applies behind command-executing wrappers
        # and inside quoted wrapper payloads too.
        for command in [
            f"nice bash {evil}",
            f"timeout 5 bash {evil}",
            f"command bash {evil}",
            f"eval 'bash {evil}'",
            f"bash -c 'bash {evil}'",
            f"bash -c 'source {evil}'",
            f"time sh {evil}",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("outside the kernel workspace", message)
        result = await self._run("bash -c 'echo hi'")
        self.assertEqual(result.exit_code, 0)

    async def test_wrapper_option_values_do_not_hide_scripts(self):
        self._make_tree()
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        Path(outside.name, "evil.sh").write_text("chmod -R 755 /\n")
        evil = str(Path(outside.name, "evil.sh"))
        # Options with arguments (-o, --rcfile) no longer hide the real
        # script operand, and the read-write redirect form is covered.
        for command in [
            f"bash -o vi {evil}",
            f"bash --rcfile /tmp/rc {evil}",
            f"bash <> {evil}",
            f"bash 2<> {evil}",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("outside the kernel workspace", message)
        result = await self._run("bash -o vi ./script.sh || true")
        self.assertEqual(result.exit_code, 0)

    async def test_source_resolves_via_path_and_allows_dot_paths(self):
        self._make_tree()
        Path(self.test_dir, ".env").write_text("X=1\n")
        Path(self.test_dir, ".venv", "bin").mkdir(parents=True, exist_ok=True)
        Path(self.test_dir, ".venv", "activate.sh").write_text("echo sourced\n")
        # Slash-free source operands resolve through PATH like bash does;
        # in-workspace dot paths are allowed (the chmod dotfile policy does
        # not apply to script inputs), and an in-PATH outside file is
        # refused.
        result = await self._run("source .venv/activate.sh")
        self.assertEqual(result.exit_code, 0)
        outside_bin = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, outside_bin, ignore_errors=True)
        Path(outside_bin, "pa-guard-in-path.sh").write_text("chmod -R 755 /\n")
        with mock.patch.dict(
            os.environ, {"PATH": os.environ["PATH"] + os.pathsep + outside_bin}
        ):
            message = await self._refused("source pa-guard-in-path.sh")
        self.assertIn("outside the kernel workspace", message)
        # Not in PATH: bash itself errors, so the guard stays out of the way.
        result = await self._run("source definitely-not-in-path.sh")
        self.assertNotEqual(result.exit_code, 0)

    async def test_guard_scan_is_not_quadratic(self):
        # _contained_in_later_word is answered from a flag computed at scan
        # time, so commands with many separators stay linear (a generated
        # command with thousands of separators must not stall the kernel).
        command = "; ".join(["echo hi"] * 4000)
        start = time.monotonic()
        for _ in range(3):
            bash_module._guard_destructive_chmod(command, False)
        elapsed = time.monotonic() - start
        self.assertLess(elapsed, 1.5)

    async def test_refuses_env_chdir_and_execdir_relocations(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # env -C/--chdir and find -execdir relocate the invocation into
        # directories the resolver cannot replay, so they are refused.
        for command in [
            "env -C / chmod -R 755 .",
            "env --chdir / chmod -R 755 .",
            "env -C/ chmod -R 755 .", "env -iC / chmod -R 755 .",
            "env --chdir=/ chown -R user .", "env -C ~ chmod -R 755 .",
            "env -iC/ chmod -R 755 .", "FOO=1 env -C / chmod -R 755 .",
            "{ env -C / chmod -R 755 .; }",
            "find / -execdir chmod -R 755 . \\;", "find . -execdir chown -R user . +",
            # The wrapper chain is walked, not just its head.
            "nice env -C / chmod -R 755 .", "timeout 5 env -C / chmod -R 755 .",
            "nice xargs chmod -R 755",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("changes directory", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # env without a chdir stays fine.
        result = await self._run("env FOO=1 chmod -R 755 sub")
        self.assertEqual(result.exit_code, 0)

    async def test_refuses_env_split_string_payloads(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # GNU env -S splits the string and executes it: the payload is
        # scanned like any wrapper payload.
        for command in [
            "env -S 'chmod -R 755 ~'",
            'env -S "chown -R user ~"',
            "env --split-string='chmod -R 755 ~'",
            # Every `env -S` string counts, in every spelling, and one the guard
            # cannot read is refused rather than guessed at.
            "env -S'chmod -R 755 ~'", "env -iS 'chown -R user ~'", "env -iS'chmod -R 755 ~'",
            "env -S 'echo hi' -S 'chmod -R 755 ~'", "eval 'env -S \"chmod -R 755 ~\"'",
            "env -S 'echo hi'; env -S 'chmod -R 755 ~'",
            "bash -c 'env -S \"chown -R user ~\"'",
            'env -S "$CMD -R 755 ~"',
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        for command in ["env -S 'echo hi'", "env -iS 'echo hi'"]:
            result = await self._run(command)
            self.assertEqual(result.exit_code, 0)

    async def test_refuses_hash_registered_command_names(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # `hash -p pathname name` installs a command-hash entry by hand, so the
        # registered name runs that file whatever the word looks like; a
        # registration the guard cannot read is refused, one that names another
        # command keeps that command, and one nobody uses changes nothing.
        for command in [
            "hash -p /bin/chmod safe; safe -R 755 ~", "hash -p /bin/chmod safe; echo hi; safe -R 755 ~",
            "hash -p/bin/chmod safe; safe -R 755 ~",
            "hash -p /usr/bin/chown safe; safe -R user ~",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        for command in ['hash -p "$DIR/chmod" safe; safe -R 755 sub', "hash -p /bin/chmo? safe; safe -R 755 sub"]:
            self.assertIn("command-hash entry", await self._refused(command))
        for command in ["hash -p /bin/echo safe; safe -R 755 sub", "hash -p /bin/chmod safe"]:
            self.assertEqual((await self._run(command)).exit_code, 0)

    async def test_refuses_shell_startup_files(self):
        # A login or interactive shell sources profile and rc files before it
        # runs the payload it was given, so its `-c` text does not govern it; a
        # non-login wrapper stays governed, and an rcfile without -i is not read
        # by bash at all.
        Path(self.test_dir, "guard-ok.sh").write_text("echo ok\n")
        for command in [
            "bash -l -c ':'", "bash --login -c ':'", "bash -lc ':'", "bash -i -c ':'",
            "bash --interactive -c ':'", "bash -ilc ':'", "sh -l -c ':'",
            "bash --rcfile /tmp/evilrc -i -c ':'", "bash --init-file /tmp/evilrc -i -c ':'",
            "bash -c 'bash -l -c \":\"'", "{ bash -l -c ':'; }",
            "if true; then bash -l -c ':'; fi",
        ]:
            with self.subTest(command=command):
                self.assertIn("starts a login or interactive shell", await self._refused(command))
        for command in ["bash -xc 'echo hi'", "bash --rcfile /tmp/guard-rc ./guard-ok.sh"]:
            self.assertEqual((await self._run(command)).exit_code, 0)

    async def test_command_prefix_relocation_refuses_wrapper_scripts(self):
        self._make_tree()
        # A relocating command prefix moves the shell before every
        # command, so a relative wrapper script cannot be resolved
        # against the workspace.
        with mock.patch.dict(
            os.environ,
            {"PRIME_AGENT_BASH_COMMAND_PREFIX": "cd /tmp"},
        ):
            message = await self._refused("bash safe-name.sh")
        self.assertIn("changes directory", message)
        # A word that only shares a wrapper's name does not run a script, so
        # the relocating prefix does not refuse the command.
        with mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_COMMAND_PREFIX": "cd /tmp"}):
            for command in ["echo bash", "ls .", "echo source"]:
                self.assertEqual((await self._run(command)).exit_code, 0)

    async def test_bundled_option_values_do_not_skip_scripts(self):
        self._make_tree()
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        Path(outside.name, "evil.sh").write_text("chmod -R 755 /\n")
        evil = str(Path(outside.name, "evil.sh"))
        # An option value bundled inside the same word (-ovi) must not
        # make the walk drop the real script operand.
        message = await self._refused(f"bash -ovi {evil}")
        self.assertIn("outside the kernel workspace", message)
        result = await self._run("bash -ovi ./script.sh || true")
        self.assertEqual(result.exit_code, 0)

    async def test_source_path_hits_resolve_fully(self):
        self._make_tree()
        # A PATH hit is realpath'd before the location check, and a PATH
        # assignment inside the command makes the resolution unresolvable.
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        Path(outside.name, "sub").mkdir(parents=True, exist_ok=True)
        Path(outside.name, "sub", "pa-guard-path.sh").write_text("chmod -R 755 /\n")
        victim = Path(outside.name, "sub", "pa-guard-path.sh")
        inside_link_dir = Path(self.test_dir, "bindir")
        inside_link_dir.mkdir()
        os.symlink(str(Path(outside.name, "sub")), str(inside_link_dir / "linkdir"))
        with mock.patch.dict(
            os.environ,
            {"PATH": os.environ["PATH"] + os.pathsep + str(inside_link_dir / "linkdir")},
        ):
            message = await self._refused("source pa-guard-path.sh")
        self.assertIn("outside the kernel workspace", message)
        message = await self._refused("PATH=/nonexistent source x.sh")
        self.assertIn("outside the kernel workspace", message)
        # An append assignment changes the search path like a plain one.
        self.assertIn("outside the kernel workspace", await self._refused("PATH+=/nonexistent source x.sh"))

    async def test_xargs_false_positives_stay_allowed(self):
        # The xargs walk must stop at the command word: an operand named
        # xargs and a later xargs in a separate pipeline are not wraps.
        self._make_tree()
        Path(self.test_dir, "xargs").mkdir()
        result = await self._run("chmod -R 755 xargs")
        self.assertEqual(result.exit_code, 0)
        result = await self._run("chmod -R 755 sub; ls sub/nested | xargs cat")
        self.assertEqual(result.exit_code, 0)

    async def test_cd_relocations_are_replayed(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # Resolvable in-workspace relocations run.
        for command in [
            "cd sub && chmod -R 755 .",
            "cd sub && chmod -R 755 nested",
            "cd sub && chmod -R 755 ..",
            '(cd sub) && chmod -R 755 .',
            "{ cd sub && chmod -R 755 .; }",
            'cd "my dir" && chmod -R 755 .',
            "cd 'sub' && chmod -R 755 ..",
        ]:
            with self.subTest(command=command):
                result = await self._run(command)
                self.assertEqual(result.exit_code, 0)
        # Relocations out of the workspace are refused.
        for command in [
            "cd ~ && chmod -R 755 .",
            "cd $HOME && chmod -R 755 .",
            "cd / && chmod -R 755 x",
            "cd .. && chmod -R 755 .",
            'cd ".." && chmod -R 755 .',
            'cd "sub" && chmod -R 755 ../..',
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Relocations the resolver cannot replay safely are refused.
        for command in [
            "cd sub; chmod -R 755 .",
            "cd sub || chmod -R 755 .",
            "pushd sub && chmod -R 755 .",
            "cd $(pwd) && chmod -R 755 .",
            "cd ~otheruser && chmod -R 755 .",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command)
                self.assertIn("changes directory", message)

    async def test_relocated_recursion_must_stay_inside_the_workspace(self):
        self._make_tree()
        outside = self._outside_target()
        message = await self._refused(f"cd sub && chmod -R 755 ../../{outside.name}")
        self.assertIn("Refusing to run this recursive chmod/chown command", message)
        self.assertTrue((outside / "file.txt").exists())

    async def test_kernel_cwd_is_home_scenario(self):
        # A kernel can boot with cwd == HOME; HOME itself must stay refused
        # while in-workspace recursion runs.
        with mock.patch.dict(os.environ, {"HOME": self.test_dir}):
            self._make_tree()
            for command in ["chmod -R 755 ~", "chmod -R 755 $HOME", "chmod -R 755 ."]:
                with self.subTest(command=command):
                    message = await self._refused(command)
                    self.assertIn(
                        "Refusing to run this recursive chmod/chown command", message
                    )
            self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())
            result = await self._run("chmod -R 755 sub")
            self.assertEqual(result.exit_code, 0)

    async def test_hardened_forms_are_refused(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        for command in [
            "chmod 2>/dev/null -R 755 ~",
            "chmod -R \\\n755 ~", "ch\\\nmod -R 755 ~", 'ch"mo\\\nd" -R 755 ~',
            "PATH=.:$PATH chmod -R 755 sub", "PATH=$PATH:. chmod -R 755 sub",
            "chmod -R 755 &>/dev/null ~",
            "\\chmod -R 755 ~",
            "/bin/chmod -R 755 ~",
            "sudo chmod -R 755 ~",
            '"chmod" -R 755 ~',
            "FOO=1 chmod -R 755 ~",
            "chmod -R 755 ~ # cleanup",
            "chmod -R 755 -- ~",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())

    async def test_continuation_split_wrappers_stay_refused(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # An in-word continuation is removed by the escape stripper, and the
        # payload scanners read that stripped text, so a wrapper name the
        # pair splits still folds to the wrapper word and its quoted payload
        # is scanned. Fail-pre-fix rows: the scanners read the pre-strip
        # text, scanned `ba<cont>sh` as `ba\nsh`, and the payload stayed
        # hidden (verified as a live outside-workspace chmod through kernel
        # spawns before the fix).
        for command in [
            "ba\\\nsh -c 'chmod -R 755 ~'",
            "ev\\\nal 'chmod -R 755 ~'",
            "en\\\nv -S 'chmod -R 755 ~'",
            "tr\\\nap 'chmod -R 755 ~' EXIT",
            "ali\\\nas x='chmod -R 755 ~'",
            "bash <<'EOF'\nba\\\nsh -c 'chmod -R 755 ~'\nEOF",
            # Between-words continuations keep the refusals they already had.
            "chmod -R \\\n755 ~",
            "sh -c 'chmod -R \\\n755 ~'",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())

    async def test_deep_substitution_nesting_refuses_cleanly(self):
        # Hostile nesting must refuse with the guard's own error instead of
        # crashing bash() with RecursionError (fail-pre-fix: ~500 quoted or
        # ~900 unquoted levels exhausted the scan stack).
        for command in [
            'echo "' + "$(" * 500 + "echo x" + ")" * 500 + '"',
            "echo " + "$(" * 900 + "echo x" + ")" * 900,
        ]:
            with self.subTest(nesting=len(command)):
                message = await self._refused(command)
                self.assertIn("nests more than", message)
        # Shallow nesting still scans like before.
        result = await self._run("echo $(dirname $(basename $(pwd)))")
        self.assertEqual(result.exit_code, 0)

    async def test_quoted_parens_inside_substitutions_stay_scanned(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        Path(home.name, "keep.txt").write_text("keep\n")
        # A quoted or escaped `)` inside a substitution is data, so the
        # substitution closes at the real one. Fail-pre-fix: the blind
        # paren match stopped early, the rest folded into the enclosing
        # word as data, and the chmod ran (kernel spawns; real bash runs
        # each shape).
        for command in [
            "echo \"$(echo ')'; chmod -R 755 ~)\"",
            "echo $(echo ')'; chmod -R 755 ~)",
            "echo $(echo \"a)\"; chmod -R 755 ~)",
            "echo $(echo \\); chmod -R 755 ~)",
            "echo \"$(echo $'\\)'; chmod -R 755 ~)\"",
            "echo $(echo `echo )`; chmod -R 755 ~)",
        ]:
            with self.subTest(command=command):
                message = await self._refused(command, home=home.name)
                self.assertIn("Refusing to run this recursive chmod/chown command", message)
                self.assertTrue(Path(home.name, "keep.txt").exists())
        # Quoted-paren data without a hidden invocation still runs.
        for command in ["echo \"$(echo ')')\"", "echo $(echo \"a)\")"]:
            result = await self._run(command)
            self.assertEqual(result.exit_code, 0)

    async def test_refuses_compound_when_any_invocation_escapes(self):
        self._make_tree()
        message = await self._refused("chmod -R 755 sub && chmod -R 755 ..")
        self.assertIn("Refusing to run this recursive chmod/chown command", message)
        self.assertTrue(self._tracked("sub", "nested", "file.txt").exists())
        # Every invocation inside the workspace stays allowed.
        self._make_tree()
        result = await self._run('chmod -R 755 sub && chmod -R 755 "my dir"')
        self.assertEqual(result.exit_code, 0)

    async def test_refusal_lists_both_bypasses(self):
        message = await self._refused("chmod -R 755 ~")
        self.assertIn("allow_destructive_chmod=True", message)
        self.assertIn(BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV, message)

    async def test_guard_only_resolves_on_pattern_match(self):
        self._make_tree()
        resolver = mock.Mock(return_value=None)
        with mock.patch.object(bash_module, "_resolve_chmod_effective_cwd", resolver):
            result = await self._run("echo hi")
            self.assertEqual(result.exit_code, 0)
            result = await self._run("chmod 755 sub")
            self.assertEqual(result.exit_code, 0)
            resolver.assert_not_called()
            await self._refused("chmod -R 755 ~")
        resolver.assert_called_once()

    async def test_command_prefix_chmod_is_guarded(self):
        self._make_tree()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        with mock.patch.dict(
            os.environ,
            {"PRIME_AGENT_BASH_COMMAND_PREFIX": "chmod -R 755 /"},
        ):
            message = await self._refused("echo hi")
        self.assertIn("Refusing to run this recursive chmod/chown command", message)

    async def test_command_prefix_relocation_is_refused(self):
        self._make_tree()
        with mock.patch.dict(
            os.environ,
            {"PRIME_AGENT_BASH_COMMAND_PREFIX": "cd /tmp"},
        ):
            message = await self._refused("chmod -R 755 sub")
        self.assertIn("changes directory", message)

    async def test_command_prefix_with_escapes_does_not_skip_user_cds(self):
        # A prefix containing shell escapes must not shift the prefix
        # boundary: the user cd out of the workspace must still be resolved
        # (and refused), not silently treated as prefix text.
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        with mock.patch.dict(
            os.environ,
            {"PRIME_AGENT_BASH_COMMAND_PREFIX": "export X=a\\ b"},
        ):
            message = await self._refused("cd ~ && chmod -R 755 .", home=home.name)
        self.assertIn("Refusing to run this recursive chmod/chown command", message)

    async def test_benign_command_prefix_still_allows_recursion(self):
        self._make_tree()
        with mock.patch.dict(
            os.environ,
            {"PRIME_AGENT_BASH_COMMAND_PREFIX": "export GUARD_TEST_VAR=1"},
        ):
            result = await self._run("chmod -R 755 sub")
            self.assertEqual(result.exit_code, 0)


class FrozenBypassEnvLaunchTest(unittest.TestCase):
    """Launch-level behavior of the frozen bypass env var, in fresh kernels."""

    def _workspace_with_outside_sibling(self) -> tuple[str, str]:
        workspace = tempfile.mkdtemp(prefix="chmod-guard-launch-")
        self.addCleanup(shutil.rmtree, workspace, ignore_errors=True)
        outside = str(Path(workspace).parent / (Path(workspace).name + "-outside"))
        Path(outside).mkdir(exist_ok=True)
        (Path(outside) / "file.txt").write_text("keep\n")
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        return workspace, outside

    def _launch(
        self, cwd: str, extra_env: dict[str, str], script: str | None = None
    ) -> subprocess.CompletedProcess:
        # The escape command names the owned sibling dir, so a bypassed run
        # succeeds and an armed guard refuses before touching it.
        command = f"chmod -R 755 ../{Path(cwd).name}-outside"
        probe = script or (
            "import asyncio\n"
            "import sys\n"
            "from rlm import bash\n"
            "async def main():\n"
            "    result = await bash(sys.argv[1])\n"
            "    return result.exit_code\n"
            "raise SystemExit(asyncio.run(main()))\n"
        )
        return subprocess.run(
            [sys.executable, "-c", probe, command],
            cwd=cwd,
            env={**os.environ, **extra_env},
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT,
        )

    def test_launch_value_disables_the_guard_for_that_kernel(self):
        workspace, outside = self._workspace_with_outside_sibling()
        completed = self._launch(workspace, {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV: "1"})
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_falsy_launch_value_keeps_the_guard_armed(self):
        workspace, outside = self._workspace_with_outside_sibling()
        completed = self._launch(workspace, {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV: "0"})
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("Refusing to run", completed.stderr)
        self.assertTrue((Path(outside) / "file.txt").exists())

    def test_absent_launch_value_keeps_the_guard_armed(self):
        workspace, outside = self._workspace_with_outside_sibling()
        env = dict(os.environ)
        env.pop(BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV, None)
        command = f"chmod -R 755 ../{Path(workspace).name}-outside"
        probe = (
            "import asyncio\n"
            "import sys\n"
            "from rlm import bash\n"
            "async def main():\n"
            "    result = await bash(sys.argv[1])\n"
            "    return result.exit_code\n"
            "raise SystemExit(asyncio.run(main()))\n"
        )
        completed = subprocess.run(
            [sys.executable, "-c", probe, command],
            cwd=workspace,
            env=env,
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("Refusing to run", completed.stderr)

    def test_mid_session_os_environ_write_does_not_unlock_a_fresh_kernel(self):
        workspace, outside = self._workspace_with_outside_sibling()
        probe = (
            "import asyncio\n"
            "import sys\n"
            "from rlm import bash\n"  # kernel start: the variable is absent
            "import os\n"
            f"os.environ[{BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV!r}] = '1'\n"
            "async def main():\n"
            "    result = await bash(sys.argv[1])\n"
            "    return result.exit_code\n"
            "raise SystemExit(asyncio.run(main()))\n"
        )
        env = dict(os.environ)
        env.pop(BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV, None)
        command = f"chmod -R 755 ../{Path(workspace).name}-outside"
        completed = subprocess.run(
            [sys.executable, "-c", probe, command],
            cwd=workspace,
            env=env,
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("Refusing to run", completed.stderr)
        self.assertIn("appeared after kernel start", completed.stderr)
        self.assertTrue((Path(outside) / "file.txt").exists())


if __name__ == "__main__":
    unittest.main()
