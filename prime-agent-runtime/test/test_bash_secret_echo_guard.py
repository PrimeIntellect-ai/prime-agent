from __future__ import annotations

import asyncio
import io
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from rlm import bash
from rlm.bash import BASH_SECRET_ECHO_BYPASS_ENV, SecretEchoRefusalError

# The package re-exports the bash() function under the same name, so reach the
# module through sys.modules for internals.
bash_module = sys.modules["rlm.bash"]
BYPASS_ENV = BASH_SECRET_ECHO_BYPASS_ENV

# Every spawned command and probe in this suite carries an explicit timeout.
AWAIT_TIMEOUT = 10.0
SUBPROCESS_TIMEOUT = 30

# Ceilings for the cost locks below (DEEP_SCAN_TIME_BOUND,
# UNTERMINATED_HEREDOC_TIME_BOUND): generous next to the bounded pass, so a
# regression to a rescanning shape fails there without timing flakiness.
DEEP_SCAN_TIME_BOUND = 10.0
UNTERMINATED_HEREDOC_TIME_BOUND = 2.0
MANY_OPENERS_TIME_BOUND = 2.0

# Vectors for the secret-echo detector: a bare environment dump, and a
# `cat`/`echo` read of a known secret file under the user's home.
SECRET_ECHO_MATCHING_COMMANDS = [
# Bare dumps: zero operands means the whole environment goes to stdout.
    "env", "  env  ", "printenv", "env -0", "env -i", "env --", "printenv -0",
    "export -p", "export", "export -n", "export --", "FOO=1 export",
    "echo hi && env", "cd /tmp; printenv",
    "env # dump the environment",
# Secret-file reads, both home spellings, quoted and unquoted.
    "cat ~/.ssh/id_rsa", "cat ~/.ssh/id_ed25519", "cat $HOME/.ssh/id_rsa",
    "cat \"$HOME/.ssh/id_rsa\"", "cat ${HOME}/.ssh/id_rsa",
# The shell removes a quote inside the path and still expands the `~` in front
# of it, so a quoted span must not hide the secret path from the rule.
    "cat ~/\".ssh\"/id_rsa", "cat ~/'.ssh'/id_rsa", "cat ~/\".ssh/id_rsa\"", "echo ~/'.aws'/credentials",
    "cat ~/'/'.ssh/id_rsa", "cat ~/'/'.ssh/'id_rsa'", "cat ~/'/'/.ssh/id_rsa",
    "cat ~/.aws/credentials", "cat $HOME/.aws/credentials",
# The rule names the directory: a slash run, a `.`/`..` component, a glob, and the file next to the key refuse.
    "cat ~/.aws//credentials", "cat ~/.aws///credentials", "cat $HOME/.aws//credentials",
    "cat ~/.aws/./credentials", "cat ~/.aws/../.aws/credentials", "cat ~/.aws/cred*", "cat ~/.aws/config",
    "cat ~/.gnupg/secring.gpg", "echo ~/.gnupg/secring.gpg",
# Assignment prefixes: the shell runs the dump with those bindings set.
    "FOO=1 env", "FOO=1 printenv", "FOO=1 export -p",
    "AWS_PROFILE=prod cat ~/.aws/credentials", "FOO='bar baz' env",
    "env 2>/dev/null", "env 2> /dev/null", "export -p 2>&1", "env 1>&2",
    "env > /tmp/env.txt", "2> /dev/null env",
    "\"env\"", "\"cat\" ~/.ssh/id_rsa", "ca\"t\" ~/.ssh/id_rsa",
    "cat \"$HOME\"/.ssh/id_rsa", "cat $HOME\"/.ssh/id_rsa\"",
    'cat $HOME/".ssh"/id_rsa', 'cat ${HOME}/".ssh"/id_rsa', 'cat $HOME""/.ssh/id_rsa',
    'cat "$HOME""/.ssh/id_rsa"', 'cat "$HOME/".ssh"/id_rsa"', "env -S ''", "env -S ' '",
    "env | grep .", "env | grep -v SAFE_VAR", "env | grep ''", "env | grep ^AWS_",
    "env | grep -A5 SAFE_VAR", "env | grep -B5 SAFE_VAR", "env | grep -C5 SAFE_VAR",
    "env | grep --after-context=5 SAFE_VAR",
    "env 2>&1",
# GNU grep reads a bare number as a context flag, like `-C2`.
    "env | grep -2 SAFE_VAR", "env | grep -10 SAFE_VAR", "env 2>&1 | grep -2 PATH",
    "env | grep --context=2 SAFE_VAR",
# A glued redirect is still a redirect (`env>&2`); `{name}` opens a new descriptor, so fd 1 keeps the dump.
    "env>&2", "env>&1", "env>/dev/null", "cat>&2 ~/.aws/credentials",
    "env {fd}>/tmp/log", "env {fd}>&2", "printenv {fd}>/tmp/log", "export -p {fd}>log",
    "env &>/dev/null", "env &>log", "env &>>log", "env -0 &>log",
    "printenv &>/dev/null", "&>log cat ~/.ssh/id_rsa",
# ANSI-C (`$'env'`) and locale (`$"env"`) quoting build the same word.
    "$'env'", "e$'nv'", "c$'at' ~/.ssh/id_rsa", "$'cat' ~/.aws/credentials",
    "$\"env\"",
# A command substitution inside double quotes still runs a command.
    "echo \"$(env)\"", "echo \"$(cat ~/.ssh/id_rsa)\"", "echo \"`env`\"",
    "echo \"$(printenv)\"",
# `$((` is arithmetic, so a substitution inside it still runs while the
# arithmetic text itself is a number.
    "echo $(( $(env) ))", 'echo "$(( $(env) ))"', "echo $(( $(cat ~/.ssh/id_rsa) ))", "echo $( (env) )",
    "echo $((env) )", "echo $(( env) )", "echo $((env ) )", "echo $((printenv) )", "echo 1$((env) )",
# No body line runs a command; an unquoted body still expands substitutions,
# and the line that closes a body is syntax rather than input either.
    "cat <<EOF\n$(env)\nEOF", "echo \"a <<'EOF' b\"\nenv",
    "cat <<'$(env)'\n$(env)\n$(env)",
    "echo \\\\$HOME/.ssh/id_rsa",
# A pipeline gives fd 1 the pipe first, so a stderr dump bypasses the filter.
    "env>&2 | grep SAFE_VAR", "env >&2 | grep SAFE_VAR", "env 1>&2 | grep SAFE_VAR",
    "env>&2|grep PATH",
# `--` ends the options, so two operands are not a single-key filter, and a
# wordless segment a newline ends continues the pipe only into a grep.
    "env | grep -- -v SAFE_VAR", "env |\nenv", "env |\n\nenv",
# An executor form runs the reader its own words name, and `env` expands
# `${VARNAME}` in the operand it splits itself.
    "env cat ~/.ssh/id_rsa", "env echo ~/.ssh/id_rsa", "env cat $HOME/.aws/credentials",
    "env cat ~/'/'.ssh/id_rsa", "env -S 'cat ${HOME}/.ssh/id_rsa'",
# A digit inside a short-flag cluster is the `-NUM` form too.
    "env | grep -10i SAFE_VAR", "env | grep -2i SAFE_VAR",
    "env | grep -i2 SAFE_VAR", "env | grep -F2 SAFE_VAR",
    "env | grep --cont=2 SAFE_VAR", "env | grep --after-c=2 SAFE_VAR",
    "env | grep -1m PATH",
    "echo $(env) # hi",
# A descriptor is read after quote removal, so a masked one moves fd 1.
    "env >&\"2\" | grep SAFE_VAR", "env >&'2' | grep SAFE_VAR",
    "env >&$'2' | grep SAFE_VAR", "env >&\\2 | grep SAFE_VAR",
    "env >&${X} | grep SAFE_VAR", "env >&`printf 2` | grep SAFE_VAR",
# Fail-closed refusals: bash leaks nothing, but a text scan cannot prove it.
    "env 2>&1 1>&2 | grep SAFE_VAR", "env >&2x | grep SAFE_VAR",
    "cat <<'A'\nenv\nA | grep x",
    # `<<` in arithmetic is a shift, a zero count prints a whole dump, a file
    # or `<>` redirect takes fd 1 off the pipe, and an `env` operand or nested
    # dump word still dumps.
    "(( x = 1 << 2 ))\nenv\n2", "(( x = 1 << 2 ))\ncat ~/.ssh/id_rsa\n2",
    "echo $((1<<y))\nenv\ny))", "$[ 1 << 2 ]\nenv\n2",
    "env | grep -m0 SAFE_VAR", "env | grep -m00 SAFE_VAR", "env | grep -m 0 SAFE_VAR",
    "env | grep --max-count=0 SAFE_VAR", "env | grep --max-count 0 SAFE_VAR",
    "env >log | grep SAFE_VAR", "env &>log | grep SAFE_VAR",
    "env >>log | grep SAFE_VAR", "env >/dev/null | grep SAFE_VAR",
    # grep reads a prefix of `--max-count`, so the glued abbreviation leaks.
    "env | grep --max-c=0 SAFE_VAR", "env | grep --max=0 SAFE_VAR",
    "env | grep --ma=0 SAFE_VAR", "env | grep --max-c=00 SAFE_VAR",
    "env 1<>/dev/stderr | grep SAFE_VAR", "env 1<>/dev/fd/2 | grep SAFE_VAR",
    "env <>log | grep SAFE_VAR",
    # `-z` reads one NUL-delimited record: the whole dump matches.
    "env | grep -z SAFE_VAR", "env | grep -z PATH",
    "env | grep --null-data SAFE_VAR", "env | grep -z -m1 PATH",
    "env -u PATH", "env -u PATH OTHER=1", "env FOO=1", "env printenv",
    "env -u PATH printenv", "env FOO=1 printenv", "env env",
    "env -S 'env'", "env -S env", "env -i printenv",
# A `)` inside a comment is data, so the substitution closes at the `)` the
# shell reads, and the command on the next line is still scanned. A `#` glued
# to the opener opens the substitution's first word, so it comments the same way.
    'echo "$( #)\nenv )"', 'echo "$( #)\nprintenv )"', 'echo "$(#)\nenv )"',
    'echo "$( : # )\ncat ~/.ssh/id_rsa )"', 'echo "$(# )\ncat ~/.ssh/id_rsa )"',
]

SECRET_ECHO_NON_MATCHING_COMMANDS = [
    "ls ~/.ssh", "ls -la ~/.aws", "ls ~/.gnupg",
# Targeted reads: one named variable, and the executor forms of env/export.
    "printenv HOME", "printenv PATH SAFE_VAR", "env FOO=1 cmd", "env -u FOO cmd",
    "printenv -0 FOO", "printenv -l FOO", "export FOO=1", "export -n FOO",
    "export FOO", "export -f",
    "cat .env", "grep GITHUB_TOKEN .env",
# A dump filtered down to one key by grep is the documented targeted read.
    "env | grep SAFE_VAR", "printenv | grep SAFE_VAR", "export -p | grep SAFE_VAR",
    "grep GITHUB_TOKEN ~/.aws/credentials",
# Quoted data is data: a single-quoted span and a quoted tilde never expand.
    "echo 'env'", "echo 'cat ~/.ssh/id_rsa'", "echo \"cat ~/.ssh/id_rsa\"",
    "cat \"~/.ssh/id_rsa\"", "cat '~/.ssh/id_rsa'", "echo \"~/.ssh/id_rsa\"",
    "env cat .env", "env cat README.md", "env echo hi", "env head ~/.ssh/id_rsa",
    "env -S 'cat ~/.ssh/id_rsa'", "env cat",
    "cat '~'/.ssh/id_rsa", 'cat ~"/".ssh/id_rsa', 'cat ~"/".ssh/"/"id_rsa', 'cat ~""/.ssh/id_rsa',
    "cat ~'/'.ssh/id_rsa", "cat '$HOME/.ssh/id_rsa'",
    "cat /etc/passwd", "cat README.md", "echo $HOME", "git status", "npm run check",
    "env 'foo&bar'", "echo \"a & env\"", "\"env -0\"",
# A bounded single-key filter: `-e`/`--` patterns, `-F`, `-i`, `-a`, `-m1`
# (`-m`'s digit run is its own bound), and a redirect after the pipe stay bounded.
    "env | grep -e SAFE_VAR", "env | grep -- SAFE_VAR",
    "env 2>/dev/null | grep PATH", "env | grep -F SAFE_VAR", "env | grep -i PATH",
    "env | grep -a PATH", "env 2>&1 | grep PATH", "printenv 2>&1 | grep SAFE_VAR",
    "env | grep SAFE_VAR &>/dev/null", "env | grep SAFE_VAR &>log",
# `--` ends the options, a newline after the pipe continues it, and arithmetic
# runs nothing: `echo $((env))` prints the number the arithmetic reads.
    "env | grep -- -v", "env |\ngrep PATH", "env |\ngrep -m1 PATH", "env |\n grep PATH",
    "echo $((env))", 'echo "$((env))"', "echo $(( (1+2) * 3 ))", "env -S 'printenv HOME'",
    "echo $((env)) | cat", "echo $(( 1 )) ; env | grep SAFE_VAR",
    "env -S 'printenv PATH'",
    "env | grep -m1 PATH", "env | grep -F -m1 PATH", "env | grep -im1 PATH",
    "env | grep -m10 SAFE_VAR",
    "env2>&1",
# A here-document body is never shell input, so a body line runs nothing.
    "cat <<'EOF'\nenv\nEOF", "cat <<\"EOF\"\nenv\nEOF",
    "cat <<-'EOF'\n\tenv\n\tEOF", "cat <<'EOF'\ncat ~/.ssh/id_rsa\nEOF",
    "cat <<'$(env)'\nhello\n$(env)", "cat <<-'$(env)'\n\thello\n\t$(env)",
    "cat <<EOF\nenv\nEOF", "cat <<EOF\ncat ~/.ssh/id_rsa\nEOF",
    "cat <<EOF\nexport -p\nEOF",
    "echo $'env'", "echo \"$'env'\"", "echo $'\\cß'",
    "echo \"$(env | grep SAFE_VAR)\"", "echo \"$(printenv HOME)\"", "echo '$(env)'",
    "echo \"$(cat /etc/passwd)\"",
# A backslash escapes the next character: an escaped `~`, `$`, or `;` is text.
    "echo \\~/.ssh/id_rsa", "echo \\$HOME/.ssh/id_rsa",
    "echo \"\\$HOME/.ssh/id_rsa\"", "echo a\\;env", "cat \\$HOME/.aws/credentials",
    "env>&1 | grep SAFE_VAR", "env >&1 | grep PATH",
    "env | grep --fixed-strings SAFE_VAR",
    "echo hi # $(env)", "echo hi # `env`", "echo \"x\" # $(env)",
    'echo "$( #)\nprintf OK )"', 'echo "$( #)\ncat /etc/hosts )"',
    "env '>&2' | grep SAFE_VAR", "env \">&2\" | grep SAFE_VAR",
    "env | grep --contextual SAFE_VAR",
    # `let a=1<<2` is a real opener, and the spaced count bounds the output.
    "let a=1<<2\nenv\n2", "env | grep -m 1 SAFE_VAR", "env | grep --max-count 1 SAFE_VAR",
        "env | grep -m PATH", "env | grep --max-count= SAFE_VAR",
    "env | grep --max-c=1 SAFE_VAR",
    # A `<>` on another descriptor leaves stdout alone; `env printenv HOME` is
    # the targeted read it looks like.
    "env 0<>/dev/stderr | grep SAFE_VAR", "env -C /tmp ls", "env -S 'ls -l'",
    "env printenv HOME", "env -u FOO printenv PATH",
        "env | grep -c PATH", "env | grep -n PATH", "env | grep -o PATH",
    "cat <<EOF\n(( 1 << 2 ))\nEOF",
]

class SecretEchoDetectionTest(unittest.TestCase):
    def test_matches_dumps_and_secret_file_reads(self):
        for command in SECRET_ECHO_MATCHING_COMMANDS:
            with self.subTest(command=command):
                self.assertIsNotNone(bash_module._secret_echo_violation(command))

    def test_does_not_match_targeted_or_literal_commands(self):
        for command in SECRET_ECHO_NON_MATCHING_COMMANDS:
            with self.subTest(command=command):
                self.assertIsNone(bash_module._secret_echo_violation(command))

    def test_cost_locks_keep_deep_scans_bounded(self):
        # Cost lock: interiors come from an iterative worklist, so nesting depth
        # cannot exhaust the Python stack, and an unmatched opener's tail is
        # scanned once. Verdicts are unchanged: a dump at any depth is a dump.
        nested = '"$(' * 1200 + "echo hi" + ')' * 1200
        chain = '"$( ' * 2000
        start = time.perf_counter()
        self.assertIsNone(bash_module._secret_echo_violation(nested))
        self.assertIsNone(bash_module._secret_echo_violation(chain))
        self.assertLess(time.perf_counter() - start, DEEP_SCAN_TIME_BOUND)
        self.assertEqual(
            bash_module._secret_echo_violation('"$(' * 1200 + "env" + ')' * 1200),
            "the full environment",
        )
        self.assertEqual(
            bash_module._secret_echo_violation(chain + "env"), "the full environment"
        )

    def test_cost_lock_keeps_an_unterminated_heredoc_linear(self):
        # Cost lock: the here-document pass indexes the delimiter lines, so an
        # opener whose delimiter line never arrives costs a lookup per body line,
        # and the verdict is unchanged: the dump words in the body are read.
        command = "cat <<'EOF'\nenv\n" * 4000
        start = time.perf_counter()
        self.assertEqual(
            bash_module._secret_echo_violation(command), "the full environment"
        )
        self.assertLess(time.perf_counter() - start, UNTERMINATED_HEREDOC_TIME_BOUND)

    def test_cost_lock_keeps_many_heredoc_openers_linear(self):
        # Cost lock: the delimiter word of a here-document is lexed on its own,
        # so a line carrying thousands of openers costs one short word read per
        # opener instead of a lex of the rest of the line per opener.
        command = "cat " + "<<A " * 8000 + "body"
        start = time.perf_counter()
        self.assertIsNone(bash_module._secret_echo_violation(command))
        self.assertLess(time.perf_counter() - start, MANY_OPENERS_TIME_BOUND)

    def test_nested_substitution_inner_command_still_scanned(self):
        # Each interior is read in its own quoting context, so a nested command
        # is caught however deep the nest goes and a benign nest stays allowed.
        def nested(depth: int, inner: str) -> str:
            return '"$(echo ' * depth + inner + ')"' * depth

        for inner in ['"$(env)"', '"$(cat ~/.ssh/id_rsa)"']:
            with self.subTest(inner=inner):
                self.assertIsNotNone(bash_module._secret_echo_violation(nested(200, inner)))
        self.assertIsNone(bash_module._secret_echo_violation(nested(200, "env")))



class SecretEchoGuardTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._prev_cwd = os.getcwd()
        self._prev_env = dict(os.environ)
        os.environ.pop(BYPASS_ENV, None)
        os.environ.pop("PRIME_AGENT_BASH_COMMAND_PREFIX", None)
        # The launch-time bypass snapshot is frozen at import: pin it to unset.
        frozen = mock.patch.object(bash_module, "_SECRET_ECHO_BYPASS_AT_KERNEL_START", False)
        frozen.start()
        self.addCleanup(frozen.stop)
        warned = mock.patch.object(bash_module, "_secret_echo_late_bypass_warned", False)
        warned.start()
        self.addCleanup(warned.stop)
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

    def _secret_file(self, relative: str) -> None:
        path = Path(self.test_dir, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("PRIVATE-KEY-BODY\n")

    def _refused(self, command: str, **kwargs) -> str:
        # The refusal is synchronous: nothing may spawn before it is raised.
        with self.assertRaises(SecretEchoRefusalError) as caught:
            bash(command, **kwargs)
        return str(caught.exception)

    def _refuse_all(self, commands, reason: str = "the full environment") -> None:
        # A refused command must never reach BashHandle and half-spawn a process.
        for command in commands:
            with self.subTest(command=command):
                with mock.patch.object(
                    bash_module, "BashHandle", side_effect=AssertionError("spawned")
                ):
                    self.assertIn(reason, self._refused(command))

    async def _captured(self, command: str, **kwargs) -> tuple[int, list[str]]:
        result = await asyncio.wait_for(bash(command, **kwargs), AWAIT_TIMEOUT)
        return result.exit_code, [line for line in result.output.splitlines() if line]

    async def _expect_output(self, cases) -> None:
        # Each case runs in real bash: (command, expected output lines).
        for command, expected in cases:
            with self.subTest(command=command):
                exit_code, lines = await self._captured(command)
                self.assertEqual((exit_code, "\n".join(lines)), (0, expected))

    async def _expect_filtered(self, commands, key: str = "PATH") -> None:
        # The documented targeted read: only the matching environment lines run.
        for command in commands:
            with self.subTest(command=command):
                exit_code, lines = await self._captured(command)
                self.assertEqual(exit_code, 0)
                self.assertTrue(lines)
                self.assertTrue(any(line.startswith(f"{key}=") for line in lines), lines)
                self.assertTrue(all(key in line for line in lines), lines)

    async def _expect_one_line(self, commands) -> None:
        # `-m1` caps the filter at one line, so the dump stays bounded.
        for command in commands:
            with self.subTest(command=command):
                exit_code, lines = await self._captured(command)
                self.assertEqual((exit_code, len(lines)), (0, 1))

    async def _expect_no_dump(self, commands) -> None:
        # The command runs, and no environment line reaches the transcript.
        for command in commands:
            with self.subTest(command=command):
                _exit_code, lines = await self._captured(command)
                self.assertFalse(any(line.startswith("PATH=") for line in lines), lines)

    async def test_bare_env_dump_refused(self):
        message = self._refused("env")
        lowered = message.lower()
        # The transcript-leak risk and the suggested reads are stated.
        self.assertIn("transcript", lowered)
        self.assertIn("session logs", lowered)
        for text in ("printenv SAFE_VAR", "env | grep SAFE_VAR", "allow_secret_echo=True"):
            self.assertIn(text, message)
        self.assertIn(BYPASS_ENV, message)

    async def test_dump_and_secret_file_forms_refused(self):
        # Bare dumps in other spellings, with assignment and redirect prefixes.
        self._refuse_all([
            "printenv", "env -0", "env -i", "env --", "printenv -0",
            "export -p", "echo hi && env", "FOO=1 env", "env 2>/dev/null",
            "env | grep .",
        ])
        self._refuse_all(
            ["cat ~/.ssh/id_ed25519", 'cat "$HOME/.ssh/id_rsa"'], "a known secret file"
        )

    async def test_bare_export_dump_refused(self):
        # `export` with no names prints every exported name and value, exactly
        # like `export -p`, while a named export prints no values.
        self._refuse_all(["export", "export -n", "export --", "FOO=1 export"])
        await self._expect_output([("export FOO", "")])

    async def test_comment_before_the_closer_does_not_hide_the_dump(self):
        # A `)` inside a comment is data, so the substitution closes at the `)`
        # the shell reads, and the command on the next line is still scanned
        # while the same shape reading a non-secret file stays allowed.
        self._refuse_all(
            ['echo "$( #)\nenv )"', 'echo "$( #)\nprintenv )"', 'echo "$(#)\nenv )"']
        )
        self._refuse_all(['echo "$( : # )\ncat ~/.ssh/id_rsa )"'], "a known secret file")
        await self._expect_output([('echo "$( #)\nprintf OK )"', "OK")])

    async def test_allowed_reads_and_listings_run(self):
        # The targeted read runs with only matching lines captured.
        await self._expect_filtered(["env | grep PATH", "env 2>/dev/null | grep PATH"])
        Path(self.test_dir, ".env").write_text("SAFE_VAR=1\n")
        await self._expect_output([("cat .env", "SAFE_VAR=1")])
        self._secret_file(".ssh/id_rsa")
        with mock.patch.dict(os.environ, {"HOME": self.test_dir}):
            await self._expect_output([("ls ~/.ssh", "id_rsa"), ("export FOO=1", "")])
            exit_code, lines = await self._captured("printenv HOME")
            self.assertEqual(exit_code, 0)
            self.assertIn(self.test_dir, "\n".join(lines))

    async def test_bypasses_run_the_dump_without_leaking_onwards(self):
        # The kwarg is per call; the env var is honored only when set at launch.
        exit_code, lines = await self._captured("env", allow_secret_echo=True)
        self.assertEqual(exit_code, 0)
        self.assertTrue(any(line.startswith("PATH=") for line in lines), lines)
        self._refused("env")
        with mock.patch.object(bash_module, "_SECRET_ECHO_BYPASS_AT_KERNEL_START", True):
            exit_code, _lines = await self._captured("env")
        self.assertEqual(exit_code, 0)

    async def test_prefix_is_computed_once_per_command(self):
        # The guard validates the script the handle runs, so the prefix is read
        # once per call and the validated text is the executed text.
        seen: list[str] = []
        real_prefix = bash_module._with_prefix

        def record(command: str) -> str:
            seen.append(command)
            return real_prefix(command)

        with mock.patch.dict(
            os.environ, {"PRIME_AGENT_BASH_COMMAND_PREFIX": "echo prefixed"}
        ):
            with mock.patch.object(bash_module, "_with_prefix", side_effect=record):
                exit_code, lines = await self._captured("echo body")
        self.assertEqual(seen, ["echo body"])
        self.assertEqual((exit_code, lines), (0, ["prefixed", "body"]))

    async def test_guard_reads_the_prefixed_script(self):
        # The prepended command is what the shell runs, so the guard reads it
        # too: a prefix that dumps the environment is refused before any spawn.
        with mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_COMMAND_PREFIX": "env"}):
            self._refuse_all(["echo hi"])

    async def test_mid_session_env_write_does_not_unlock(self):
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {BYPASS_ENV: "1"}), redirect_stderr(stderr):
            self._refused("env")
            self._refused("printenv")
        warning = stderr.getvalue()
        self.assertIn(BYPASS_ENV, warning)
        self.assertIn("appeared after kernel start", warning)
        self.assertEqual(warning.count("appeared after kernel start"), 1)
        # A falsy mid-session value stays inert too.
        second = io.StringIO()
        with mock.patch.dict(os.environ, {BYPASS_ENV: "0"}), redirect_stderr(second):
            self._refused("cat ~/.ssh/id_rsa")
        self.assertEqual(second.getvalue(), "")

    async def test_numeric_grep_context_flag_refused(self):
        # The stand-in dump below shows the widening the refusal rests on.
        self._refuse_all(["env | grep -2 SAFE_VAR", "env 2>&1 | grep -2 PATH", "env | grep --context=2 SAFE_VAR"])
        stand_in = "printf 'A=1\\nSECRETLINE=PATH\\nB=3\\n'"
        wide = "A=1\nSECRETLINE=PATH\nB=3"
        await self._expect_output([(f"{stand_in} | grep -2 PATH", wide), (f"{stand_in} | grep -i2 PATH", wide)])

    async def test_glued_redirect_dump_refused(self):
        # `env>&2` runs env with stdout on fd 2, which the kernel merges into
        # the transcript; the `&>` spellings belong with the file-redirect class
        # and the command word keeps its place.
        self._refuse_all(["env>&2", "env>&1", "env>/dev/null", "env {fd}>/tmp/log"])
        self._refuse_all([
            "env &>/dev/null", "env &> /dev/null", "env &>log",
            "env -0 &>log", "env &>>log", "printenv &>/dev/null",
        ])
        self._refuse_all(
            ["cat>&2 ~/.aws/credentials", "&>log cat ~/.ssh/id_rsa"], "a known secret file"
        )
        # A filtered dump whose output goes to a file stays the allowed read,
        # and a digits-prefixed name is a command of its own (`env2` is not a
        # descriptor to split off).
        await self._expect_no_dump(["env | grep SAFE_VAR &>/dev/null", "env2>&1"])

    async def test_stderr_redirect_probe_output_reaches_the_transcript(self):
        # Proves the stderr merge the refusals rest on.
        probes = [
            ("printf 'GLUED\\n'>&2", True), ("printf 'PIPED\\n' >&2 | grep PIPED", False),
            ('printf \'PIPED\\n\' >&"2" | grep PIPED', False),
            ("printf 'PIPED\\n' >&`printf 2` | grep PIPED", False),
        ]
        for command, pipe_gets_it in probes:
            with self.subTest(command=command):
                exit_code, lines = await self._captured(command)
                self.assertEqual(exit_code == 0, pipe_gets_it)
                self.assertIn("GLUED" if pipe_gets_it else "PIPED", "\n".join(lines))

    async def test_quoted_heredoc_body_allowed(self):
        # A quoted delimiter makes a body line literal text.
        await self._expect_output([
            ("cat <<'EOF'\nenv\nEOF", "env"), ('cat <<"EOF"\nenv\nEOF', "env"),
            ("cat <<-'EOF'\n\tenv\n\tEOF", "env"),
        ])
        self._secret_file(".ssh/id_rsa")
        with mock.patch.dict(os.environ, {"HOME": self.test_dir}):
            exit_code, lines = await self._captured("cat <<'EOF'\ncat ~/.ssh/id_rsa\nEOF")
        self.assertEqual((exit_code, lines), (0, ["cat ~/.ssh/id_rsa"]))

    async def test_quoted_heredoc_closing_line_allowed(self):
        # The line that closes a body is syntax rather than input, so a quoted
        # body closed by a substitution prints its word; a body closed by a
        # dump word stays refused (a documented gap: the word checks read it).
        await self._expect_output([("cat <<'$(env)'\nhello\n$(env)", "hello"),
            ("cat <<-'$(env)'\n\thello\n\t$(env)", "hello")])
        self._refuse_all(["cat <<'env'\nhello\nenv"])

    async def test_unquoted_heredoc_body_still_checked(self):
        # An unquoted delimiter expands substitutions in the body, so a dump
        # built by one stays refused; no body line runs as a command.
        self._refuse_all(["cat <<EOF\n$(env)\nEOF", 'echo "a <<\'EOF\' b"\nenv'])
        await self._expect_output([
            ("cat <<EOF\n$(printf SUBST_OK)\nEOF", "SUBST_OK"),
            ("cat <<EOF\nenv\nEOF", "env"),
            ("cat <<EOF\nexport -p\nEOF", "export -p"),
            ("cat <<EOF\ncat ~/.ssh/id_rsa\nEOF", "cat ~/.ssh/id_rsa"),
        ])

    async def test_quote_inside_a_secret_path_still_reads_it(self):
        # The shell removes a quote inside a path before it expands, so that read
        # is refused for both spellings; a `~` whose next character is a quote
        # (or that is quoted whole) never expands and the word stays text.
        self._refuse_all([
            'cat ~/".ssh"/id_rsa', "cat ~/'.ssh'/id_rsa", 'cat ~/".ssh/id_rsa"',
            "cat ~/'/'.ssh/id_rsa", 'cat $HOME/".ssh"/id_rsa', 'cat "$HOME""/.ssh/id_rsa"',
        ], "a known secret file")
        await self._expect_output([
            ('echo "~/.ssh/id_rsa"', "~/.ssh/id_rsa"), ("echo '~/.ssh/id_rsa'", "~/.ssh/id_rsa"),
            ('echo ~"/".ssh/id_rsa', "~/.ssh/id_rsa"), ("echo ~'/'.ssh/id_rsa", "~/.ssh/id_rsa"),
            ("echo '$HOME/.ssh/id_rsa'", "$HOME/.ssh/id_rsa"),
        ])

    async def test_executor_form_running_a_reader_refused(self):
        # An executor form runs the command its remaining words name, so the
        # reader it wraps is read the same way; a reader the scan does not model
        # stays out of the modeled set.
        self._refuse_all(["env cat ~/.ssh/id_rsa", "env echo ~/.ssh/id_rsa",
            "env FOO=1 cat ~/.ssh/id_rsa", "env -S 'cat ${HOME}/.ssh/id_rsa'"],
            "a known secret file")
        Path(self.test_dir, "plain.txt").write_text("PLAIN")
        await self._expect_output([("env cat plain.txt", "PLAIN"), ("env echo hi", "hi")])
        await self._expect_no_dump(["env head ~/.ssh/id_rsa"])

    async def test_direct_handle_construction_is_guarded(self):
        # A handle built without the validated script `bash()` passes is guarded
        # in its constructor, so the class is not a way around the guard, while
        # the `bash()` path keeps its one scan of the validated script.
        for command in ("env", "cat ~/.ssh/id_rsa"):
            with self.subTest(command=command):
                with self.assertRaises(SecretEchoRefusalError):
                    bash_module.BashHandle(command)
        result = await asyncio.wait_for(bash_module.BashHandle("echo hi"), AWAIT_TIMEOUT)
        self.assertEqual((result.exit_code, result.output.strip()), (0, "hi"))

    async def test_ansi_c_quoted_command_refused(self):
        # `$'env'` and `c$'at'` are command words the shell builds and runs.
        self._refuse_all(["$'env'", "e$'nv'", '$"env"'])
        self._refuse_all(["c$'at' ~/.ssh/id_rsa"], "a known secret file")

    async def test_double_quoted_substitution_refused(self):
        # A `$(...)` or backtick inside double quotes still runs.
        self._refuse_all(['echo "$(env)"', 'echo "`env`"', 'echo "$(printenv)"'])
        self._refuse_all(['echo "$(cat ~/.ssh/id_rsa)"'], "a known secret file")

    async def test_arithmetic_expansion_runs_nothing(self):
        # `$((` is arithmetic only when its two closers are adjacent, so its
        # text is then a number rather than a command; a substitution inside it,
        # and the `$( ( env ) )` subshell a non-adjacent pair spells, still run
        # and stay refused.
        self._refuse_all([
            "echo $(( $(env) ))", "echo $((env) )", "echo $(( env) )", "echo 1$((env) )",
            "echo $((printenv) )", "echo $( (env) )",
        ])
        self._refuse_all(["echo $(( $(cat ~/.ssh/id_rsa) ))"], "a known secret file")
        with mock.patch.dict(os.environ, {"env": ""}):
            await self._expect_output([("echo $((env))", "0"),
                ("echo $(( $(printf 1) + 1 ))", "2")])

    async def test_quoted_text_and_substitutions_run(self):
        # ANSI-C text prints, a quoted substitution runs, targeted reads work.
        await self._expect_output([
            ("echo $'env'", "env"), ("echo \"$'env'\"", "$'env'"),
            ("printf '%s\\n' $'\\q'", "\\q"), ('echo "$(printf SUBST_OK)"', "SUBST_OK"),
            ('echo "`printf BACKTICK_OK`"', "BACKTICK_OK"), ("echo '$(env)'", "$(env)"),
        ])
        with mock.patch.dict(os.environ, {"SAFE_VAR": "1"}):
            await self._expect_output([
                ('echo "$(env | grep SAFE_VAR)"', "SAFE_VAR=1"),
                ('echo "$(printenv SAFE_VAR)"', "1"),
            ])

    async def test_escaped_literals_allowed(self):
        # An escaped `~`, `$` or `;` prints as text; an even pair stays refused.
        await self._expect_output([
            ("echo \\~/.ssh/id_rsa", "~/.ssh/id_rsa"),
            ("echo \\$HOME/.ssh/id_rsa", "$HOME/.ssh/id_rsa"),
            ('echo "\\$HOME/.ssh/id_rsa"', "$HOME/.ssh/id_rsa"), ("echo a\\;env", "a;env"),
        ])
        self._refuse_all(["echo \\\\$HOME/.ssh/id_rsa"], "a known secret file")

    async def test_arithmetic_shift_is_not_a_heredoc_opener(self):
        # `<<` inside arithmetic is a shift, so no body is claimed and the
        # following lines are ordinary commands; `let a=1<<2` is a real opener.
        self._refuse_all(["(( x = 1 << 2 ))\nenv\n2", "echo $((1<<y))\nenv\ny))", "$[ 1 << 2 ]\nenv\n2"])
        self._refuse_all(
            ["(( x = 1 << 2 ))\ncat ~/.ssh/id_rsa\n2"], "a known secret file"
        )
        await self._expect_output([("let a=1<<2\nenv\n2", "")])

    async def test_zero_max_count_is_not_a_bound(self):
        # This grep prints the whole dump for a zero count, so those spellings
        # widen like context; a non-zero count caps the output, as the
        # stand-in run below shows.
        self._refuse_all([
            "env | grep -m0 SAFE_VAR", "env | grep -m00 SAFE_VAR",
            "env | grep -m 0 SAFE_VAR", "env | grep --max-count=0 SAFE_VAR",
            "env | grep --max-count 0 SAFE_VAR", "env | grep --max-c=0 SAFE_VAR",
        ])
        # A zero count is not the one-line bound a count of one gives: grep
        # exits 1 on both platforms, this box's BSD grep prints the whole input
        # and GNU grep prints nothing, so neither prints just the match.
        exit_code, lines = await self._captured("printf 'A=1\nB=2\nC=3\n' | grep -m0 B")
        self.assertNotEqual(exit_code, 0)
        self.assertNotEqual(lines, ["B=2"])

    def test_multibyte_control_escape_answers_a_verdict(self):
        # `\c` masks its operand's low five bits, and `'ß'.upper()` is two
        # characters, so masking the code point answers instead of raising.
        self.assertIsNone(bash_module._secret_echo_violation("echo $'\\cß'"))

    def test_overlong_descriptor_returns_a_verdict(self):
        # A descriptor run past Python's digit limit must not escape as a
        # ValueError: it is no descriptor this scan can read, so the pipe rule
        # fails closed and still answers a verdict.
        command = "env " + "9" * 4500 + ">&1 | grep SAFE_VAR"
        self.assertEqual(
            bash_module._secret_echo_violation(command), "the full environment"
        )

    async def test_env_flag_operands_and_nested_dump_words_refused(self):
        # An operand of `-u`/`-C` is not a command word, and a nested dump word
        # dumps the environment, while the same word with an operand is the
        # targeted read it looks like.
        self._refuse_all([
            "env -u PATH", "env -u PATH OTHER=1", "env FOO=1", "env printenv",
            "env -u PATH printenv", "env FOO=1 printenv", "env -S 'env'",
            "env -S env",
        ])
        # `printenv PATH` prints the value alone, so one non-empty line proves
        # the nested targeted read ran rather than being refused as a dump.
        exit_code, lines = await self._captured("env -u FOO printenv PATH")
        self.assertEqual((exit_code, len(lines)), (0, 1))
        self.assertTrue(lines[0])

    async def test_env_split_string_operand_read_as_a_command_line(self):
        # The `-S` operand is a command line of its own, so its later words
        # count: a targeted read runs while a dump spelling stays refused. An
        # operand that splits to nothing leaves a bare env, and a chain nested
        # past the re-test's bound answers the same way instead of raising.
        self._refuse_all([
            "env -S 'printenv'", "env -S 'env -0'", "env -S 'env -u PATH'", "env -S ''",
            "env -S ' '", "env -S " * 1000 + "env",
        ])
        await self._expect_one_line(["env -S 'printenv PATH'"])

    async def test_grep_option_terminator_makes_the_flag_a_pattern(self):
        # `--` ends the options the way grep reads it, so a `-v` after it is one
        # fixed string (which matches nothing here) rather than inversion, and
        # two operands after it are not a single-key filter.
        self._refuse_all(["env | grep -- -v SAFE_VAR"])
        exit_code, lines = await self._captured("printf 'A=1\nB=2\n' | grep -- -v")
        self.assertEqual((exit_code, lines), (1, []))
        await self._expect_filtered(["env | grep -- PATH"])

    async def test_newline_after_the_pipe_still_filters(self):
        # The shell reads a newline after the pipe as the pipe continuing, so
        # the grep below still filters the dump while a dump below stays
        # refused.
        self._refuse_all(["env |\nenv", "env |\n\nenv"])
        await self._expect_filtered(["env |\ngrep PATH", "env |\n grep PATH"])
        await self._expect_one_line(["env |\ngrep -m1 PATH"])

    async def test_piped_dump_that_leaves_the_pipe_refused(self):
        # The exemption needs the dump on the pipe: a redirect that sends fd 1
        # to stderr or into a file leaves grep nothing to filter.
        self._refuse_all([
            "env>&2 | grep SAFE_VAR", "env >&2 | grep SAFE_VAR",
            "env 1>&2 | grep SAFE_VAR", "env>&2|grep PATH",
            "env >log | grep SAFE_VAR", "env &>log | grep SAFE_VAR",
            "env >>log | grep SAFE_VAR", "env >/dev/null | grep SAFE_VAR",
            "env 1<>/dev/stderr | grep SAFE_VAR", "env <>log | grep SAFE_VAR",
        ])
        # A `<>` on another descriptor leaves stdout on the pipe.
        await self._expect_no_dump(["env 0<>/dev/stderr | grep SAFE_VAR"])

    async def test_piped_dump_that_keeps_stdout_on_the_pipe_allowed(self):
        # `>&1` and `2>&1` keep fd 1 on the pipe, so the bounded grep still filters.
        await self._expect_filtered(["env>&1 | grep PATH", "env 2>&1 | grep PATH"])
        await self._expect_no_dump(["env '>&2' | grep PATH"])

    async def test_grep_context_flag_inside_a_cluster_refused(self):
        # A digit in a cluster is `-NUM` context, unless `-m` owns it.
        self._refuse_all([
            "env | grep -10i SAFE_VAR", "env | grep -2i SAFE_VAR",
            "env | grep -i2 SAFE_VAR", "env | grep -F2 SAFE_VAR",
            "env | grep --cont=2 SAFE_VAR", "env | grep --after-c=2 SAFE_VAR",
            "env | grep -1m PATH",
        ])
        await self._expect_one_line([
            "env | grep -m1 PATH", "env | grep -F -m1 PATH", "env | grep -im1 PATH",
            "env | grep -m 1 PATH", "env | grep --max-count 1 PATH",
        ])

    async def test_null_data_filter_refused(self):
        # `-z` reads the input as NUL-delimited records, so the whole
        # newline-separated dump is one record that any pattern in it matches.
        self._refuse_all([
            "env | grep -z SAFE_VAR", "env | grep -z PATH",
            "env | grep --null-data SAFE_VAR", "env | grep -z -m1 PATH",
        ])
        # The neighbouring single-letter flags stay bounded filters.
        await self._expect_no_dump(["env | grep -c PATH", "env | grep -n PATH", "env | grep -o PATH"])

    async def test_comment_substitution_is_data(self):
        # A comment is literal data, and a `#` covers only what follows it.
        await self._expect_no_dump(["echo hi # $(env)", "echo hi # `env`", 'echo "x" # $(env)'])
        self._refuse_all(["echo $(env) # hi"])

    async def test_masked_descriptor_redirect_refused(self):
        # Bash removes quotes before it reads a descriptor, so this moves fd 1.
        self._refuse_all([
            'env >&"2" | grep SAFE_VAR', "env >&'2' | grep SAFE_VAR",
            "env >&$'2' | grep SAFE_VAR", "env >&\\2 | grep SAFE_VAR",
            "env >&${X} | grep SAFE_VAR", "env >&`printf 2` | grep SAFE_VAR",
        ])



def _probe(prelude: str = "") -> str:
    return (
        "import asyncio\n"
        "import sys\n"
        "from rlm import bash\n"
        + prelude
        + "async def main():\n"
        "    result = await bash(sys.argv[1])\n"
        "    return result.exit_code\n"
        "raise SystemExit(asyncio.run(main()))\n"
    )


PROBE = _probe()
# The same probe with the bypass variable written after the snapshot.
LATE_BYPASS_PROBE = _probe(f"import os\nos.environ[{BYPASS_ENV!r}] = '1'\n")


class FrozenBypassEnvLaunchTest(unittest.TestCase):
    """Launch-level behavior of the frozen bypass env var, in fresh kernels."""

    def _launch(self, extra_env, probe: str = PROBE) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env.pop(BYPASS_ENV, None)
        env.update(extra_env)
        return subprocess.run(
            [sys.executable, "-c", probe, "env"],
            cwd=tempfile.gettempdir(),
            env=env,
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT,
        )

    def test_launch_value_disables_the_guard_for_that_kernel(self):
        # The variable disables the guard, and an honored bypass is not a late one.
        refused = self._launch({})
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("Refusing to run this command", refused.stderr)
        allowed = self._launch({BYPASS_ENV: "1"})
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(allowed.stderr, "")

    def test_mid_session_os_environ_write_does_not_unlock_a_fresh_kernel(self):
        completed = self._launch({}, LATE_BYPASS_PROBE)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("Refusing to run this command", completed.stderr)
        self.assertIn("appeared after kernel start", completed.stderr)


if __name__ == "__main__":
    unittest.main()
