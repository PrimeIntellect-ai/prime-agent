"""Privilege-escalation guard for the kernel bash tool."""

from __future__ import annotations

import asyncio
import contextlib
import io
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

from rlm import bash

bash_module = sys.modules["rlm.bash"]
PrivilegeEscalationRefusalError = bash_module.PrivilegeEscalationRefusalError
BASH_SUDO_BYPASS_ENV = bash_module.BASH_SUDO_BYPASS_ENV

AWAIT_TIMEOUT = 15.0

SUDO_MATCHING_COMMANDS = [
    "sudo ls",
    "sudo apt install ripgrep",
    "sudo -i",
    "sudo -u root id",
    "/usr/bin/sudo id",
    "./sudo id",
    "doas id",
    "/usr/local/bin/doas id",
    "echo x | sudo tee /etc/hosts",
    "FOO=1 sudo ls",
    "nice sudo ls",
    "env sudo ls",
    "env -i sudo ls",
    "timeout 30 sudo ls",
    "nice -n 10 sudo id",
    "! sudo id",
    "time sudo id",
    "time -p sudo id",
    "time -- sudo id",
    "bash --rcfile /dev/null -c 'sudo id'",
    "cd /tmp && sudo make install",
    "echo hi\nsudo id",
    "( sudo id )",
    "{ sudo id; }",
    "sudo id || sudo -i",
    "sh -c 'sudo id'",
    'bash -lc "sudo id"',
    "eval 'sudo id'",
    "eval sudo id",
    "ls | xargs sudo rm",
    "find . | xargs -I{} sudo chown root {}",
    '"sudo" id',
    'su"do" id',
    "CMD=sudo; $CMD id",
    "CMD=sudo\n$CMD id",
    "$SUDO id",
    "sh <<EOF\nsudo id\nEOF",
    "exec sudo id",
    "nohup sudo id",
    "setsid sudo id",
    "2>/dev/null sudo id",
    "foo >x& sudo id",
    "if true; then sudo id; fi",
    "while :; do sudo id; break; done",
    "for i in 1; do sudo id; done",
    "until false; do doas id; done",
    "else sudo id; fi",
    "command sudo id",
    "command -p sudo id",
    'x="$(sudo id)"',
    'x="`sudo id`"',
    'echo "`sudo id`"',
    "busybox sudo id",
    "exec -a name sudo id",
    "xargs -n1 -I{} sh -c 'sudo id'",
    "sh -c$'sudo id'",
    "diff <(sudo id) x",
    "bash <(sudo id)",
    "cat >(sudo id)",
    "diff <(sudo -l) <(echo x)",
    "while read l; do echo $l; done < <(sudo id)",
    "$'su\\x64o' id",
    "$'su\\144o' -n id",
    "$'su\\u0064o' id",
    "$'su'$'\\x64''o' id",
    # A case-insensitive filesystem resolves these to the real tool.
    "SUDO id",
    "Sudo id",
    "echo \"$(printf ')'; sudo id)\"",
    "coproc sudo id",
    "coproc sh -c 'sudo id'",
    "env -S 'sudo id'",
    "env -S'sudo id'",
    "env -C /tmp sudo id",
    "env --split-string 'sudo id'",
    "env --chdir /tmp sudo id",
    "env -u FOO sudo id",
    "timeout -s KILL 5 sudo id",
    "stdbuf -o L sudo id",
    "ionice -c 2 sudo id",
    "timeout -k 1 5 sudo id",
    "timeout --signal=KILL 5 sudo id",
    "stdbuf -oL sudo id",
    "setsid -w sudo id",
    "printf x | xargs -I '{}' sudo id",
    "printf x | xargs -n 1 sudo id",
    "printf x | xargs -P 2 sudo id",
    "printf x | xargs -s 100 sudo id",
    "printf x | xargs -L 1 sudo id",
    "printf x | xargs -E eof sudo id",
    "printf x | xargs -J % sudo id",
    "printf x | xargs -a FILE sudo id",
    "printf x | xargs -d '' sudo id",
    "printf x | xargs -n1 sudo id",
    "bash -ce 'sudo id'",
    "bash -cx 'sudo id'",
    "find . -maxdepth 0 -exec sudo id \\;",
    "find . -maxdepth 0 -execdir sudo id \\;",
    "find . -maxdepth 0 -exec sudo id {} +",
    "find . -maxdepth 0 -exec sh -c 'sudo id' \\;",
    "bash <<< 'sudo id'",
    "sh -s <<< 'sudo id'",
    "source /dev/stdin <<< 'sudo id'",
    "sh < <(printf 'sudo id')",
    "bash < <(echo sudo id)",
    "source <(printf 'sudo id')",
    ". <(echo sudo id)",
    "sh <(printf 'sudo id')",
    "${SUDO_CMD:-sudo} id",
    "${X:-$(printf sudo)} id",
    "CMD=sudo; eval \"$CMD id\"",
    "CMD=sudo; sh -c \"$CMD id\"",
    "eval eval eval eval eval eval eval 'sudo id'",
    "eval eval eval eval eval eval 'sh -c \"sudo id\"'",
    "su{d,}o id",
    "s{u,x}do id",
    "{sudo,} id",
    "{sudo,echo} hi",
    "sud[o] id",
    "[s]udo id",
    "su?do id",
    "[[:lower:]]udo id",
    "[[:alpha:]]udo id",
    "[[:lower:]]oas id",
    "[[:graph:]]udo id",
    "hash -p /usr/bin/sudo elevated; elevated id",
    "hash -p/usr/bin/sudo elevated; elevated id",
    "hash -p /usr/bin/sudo a b; b id",
    "hash -p /bin/bash script; script -c 'sudo id'",
    "hash -p /bin/ls eval; eval 'sudo id'",
    "echo hash -p /bin/ls sudo; sudo id",
    "hash -p /bin/ls sudo; hash -r; sudo id",
    "timeout 0.1 sudo id",
    "hash -p /usr/bin/sudo env; env id",
    "hash -p /usr/bin/sudo elevat?; elevate id",
    "bash -c >/tmp/out 'sudo id'",
    "hash -p /bin/ls env; hash -r; env sudo id",
    "coproc worker if sudo id; then :; fi",
    "shopt -s expand_aliases\nalias a='alias b=\"sh\"'\na\ncat <<EOF | b\nsudo id\nEOF",
    "X=/usr/bin/sudo; hash -p $X elevated; elevated id",
    "alias p='sudo id'",
    "alias p=$'sudo id'",
    "shopt -s expand_aliases\nalias p='sudo id'\np",
    "shopt -s expand_aliases\nalias p='sudo id'\neval p",
    "cat <<EOF | sh\nsudo id\nEOF",
    "while read -r l; do eval \"$l\"; done <<EOF\nsudo id\nEOF",
    "env -vu FOO sudo id",
    "env -vC /tmp sudo id",
    "env -iu FOO sudo id",
    "env -iC /tmp sudo id",
    "env -iS'sudo id'",
    "printf x | xargs -rn 2 sudo id",
    "printf x | xargs -tn 1 sudo id",
    "printf x | xargs -0n 1 sudo id",
    "cat <<EOF | exec sh\nsudo id\nEOF",
    "cat <<EOF | sudo id\nEOF",
    "shopt -s expand_aliases; alias p='sudo id'; eval p",
    "shopt -s expand_aliases\nalias p=$'sudo id'\np",
    "cat <<EOF | command sh\nsudo id\nEOF",
    "cat <<EOF | command -- sh\nsudo id\nEOF",
    "cat <<EOF | command -p sh\nsudo id\nEOF",
    "cat <<EOF | xargs -I{} sh -c {}\nsudo id\nEOF",
    "cat <<EOF | find . -maxdepth 0 -exec sh -s {} \\;\nsudo id\nEOF",
    "cat <<EOF | timeout 5 sh\nsudo id\nEOF",
    "cat <<EOF | xargs -- sh\nsudo id\nEOF",
    "cat <<EOF | env -i sh\nsudo id\nEOF",
    "cat <<EOF | nohup sh\nsudo id\nEOF",
    "cat <<EOF | stdbuf -o L sh\nsudo id\nEOF",
    "cat <<EOF | builtin sh\nsudo id\nEOF",
    "cat <<EOF | busybox sh\nsudo id\nEOF",
    "cat <<EOF | find . -maxdepth 0 -execdir sh -s {} \\;\nsudo id\nEOF",
    "cat <<EOF | xargs -n1 sh\nsudo id\nEOF",
    "shopt -s expand_aliases; alias p='sudo id'; p",
    "shopt -s expand_aliases\nalias p='sh'\ncat <<EOF | p\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='sh'\np <<EOF\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p=$'sh'\ncat <<EOF | p\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='eval'\ncat <<EOF | p sh\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='sh'\np < <(printf 'sudo id')",
    "shopt -s expand_aliases\nalias p='env sh'\ncat <<EOF | p\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='env sh'\np <<EOF\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='env sh'\np < <(printf 'sudo id')",
    "shopt -s expand_aliases\nalias p='command sh'\ncat <<EOF | p\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='nohup sh'\ncat <<EOF | p\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='time sh'\ncat <<EOF | p\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='nice sh'\ncat <<EOF | p\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='exec sh'\ncat <<EOF | p\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='stdbuf -o L sh'\ncat <<EOF | p\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='xargs -I{} sh -c {}'\ncat <<EOF | p\nsudo id\nEOF",
    "s{u..u}do id",
    "s{u..x}do id",
    "for x in 1\ndo sudo id\ndone",
    "case \"$x\" in y) sudo id;; esac",
    "case \"$x\" in\n(a|b) sudo id;;\nesac",
    "bash<<<'sudo id'",
    "sh<<<\"sudo id\"",
    "CMD=sudo; export CMD; env -S '${CMD} id'",
    "CMD=sudo; alias p='$CMD id'; shopt -s expand_aliases; eval p",
    "watch sudo id",
    "watch -n 1 sudo id",
    "fd -x sudo id",
    "fd -X sudo id",
    "fdfind -x sudo id",
    "fd -e txt -x sudo id",
    "parallel sudo id",
    "parallel -j 2 sudo id",
    "strace sudo id",
    "strace -f sudo id",
    "strace -o /tmp/x sudo id",
    "ltrace sudo id",
    "ltrace -o /tmp/x sudo id",
    "chroot / sudo id",
    "faketime now sudo id",
    "systemd-run -u x sudo id",
    "watch -d sudo id",
    "watch -t sudo id",
    "watch -n 1 -d sudo id",
    "strace -D sudo id",
    "ltrace -L sudo id",
    "chroot / --userspec=u sudo id",
    "bash<<<'sh -c \"sudo id\"'",
    "bash<<<\"sh -c 'sudo id'\"",
    "bash<<<'bash -c \"sudo id\"'",
    "bash<<<'env sh -c \"sudo id\"'",
    "strace -b execve sudo id",
    "strace -I 1 sudo id",
    "strace -O 10 sudo id",
    "strace -S sortby sudo id",
    "strace -U columns sudo id",
    "strace -X format sudo id",
    "systemd-run -C c sudo id",
    "systemd-run --capsule=c sudo id",
    "ltrace -A 5 sudo id",
    "ltrace -w 2 sudo id",
    "ltrace -n 2 sudo id",
    "ltrace -D mask sudo id",
    "ltrace -x pat sudo id",
    "ltrace -d 2 sudo id",
    "faketime -m now sudo id",
    "faketime -f '2020-01-01' sudo id",
    "systemd-run --uid 0 sudo id",
    "systemd-run --gid 0 sudo id",
    "systemd-run --host h sudo id",
    "strace -E FOO sudo id",
    "strace --env FOO sudo id",
    "parallel --delay 1 sudo id",
    "parallel --timeout 5 sudo id",
    "env -a x sudo id",
    "env --argv0 x sudo id",
    "env -P /bin sudo id",
    "env --ignore-signal sudo id",
    "watch -q 5 sudo id",
    "watch -s /tmp/shots sudo id",
    "strace --user root sudo id",
    "strace --argv0 x sudo id",
    "ltrace --indent 4 sudo id",
    "ltrace --library libc sudo id",
    "systemd-run -H host sudo id",
    "systemd-run --drop-in sudo id",
    "systemd-run --wait-timeout sudo id",
    "systemd-run --on-calendar now sudo id",
    "systemd-run --timer-property X sudo id",
    "parallel -C , sudo id",
    "parallel -P 2 sudo id",
    "parallel -s 5000 sudo id",
    "parallel --max-chars 5000 sudo id",
    "parallel --env FOO sudo id",
    "/usr/bin/su* id",
    "sud? id",
    "sudo",
]

SUDO_NON_MATCHING_COMMANDS = [
    "man sudo",
    "grep sudo file.md",
    "echo sudo",
    "echo 'sudo apt install'",
    'echo "sudo"',
    "ls # sudo id",
    "ls /etc/sudoers.d",
    "cat sudo.txt",
    "command -v sudo",
    "which sudo",
    "type sudo",
    "whereis sudo",
    "ls",
    "git status",
    "npm run check",
    "env | grep PATH",
    "printenv HOME",
    "env FOO=1 cmd",
    "cat <<EOF\nsudo id\nEOF",
    "python -c \"print('sudo')\"",
    "$(date)",
    "timeout 30 ls",
    "env -i ls",
    "cd /tmp && make install",
    "echo hi && echo bye",
    "time ls",
    "nice -n 5 ls",
    "exit 0 || ls",
    "command -V sudo",
    "if true; then echo hi; fi",
    "for i in 1; do ls; done",
    "case x in y) ls;; esac",
    'x="$(date)"',
    "diff <(echo a) <(echo b)",
    "cat >(wc -l) < /dev/null",
    "env -0 ls",
    "xargs -r echo hi",
    "xargs -0 -n 1 echo",
    "xargs -rn2 echo hi",
    "echo sh <<EOF\nsudo id\nEOF",
    "grep bash <<EOF\nsudo id\nEOF",
    "cat <<EOF | command -v sh\nsudo id\nEOF",
    "cat <<EOF | command -V sh\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='ls'\ncat <<EOF\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='env ls'\ncat <<EOF\nsudo id\nEOF",
    "shopt -s expand_aliases\nalias p='env ls'\ncat <<EOF | p\nsudo id\nEOF",
    "for sudo in one two; do echo $sudo; done",
    "case \"$x\" in sudo) echo hi;; esac",
    "select sudo in a b; do echo $sudo; done",
    "$'\\U00110000'",
    "echo {1..5}",
    "echo {l..q}s",
    "echo {0,1,2,3,4,5,6,7,8,9}",
    "watch -n 1 ls",
    "fd -x wc -l",
    "fd -X wc -l",
    "parallel -j 2 echo hi",
    "chroot / ls",
    "faketime now ls",
    "systemd-run --uid 0 ls",
    "strace -E FOO ls",
    "parallel --delay 1 echo hi",
    "env -a x ls",
    "env -P /bin ls",
    "watch -q 5 ls",
    "strace --color=always ls",
    "bash --rcfile /dev/null -c 'echo hi'",
    "s[[:upper:]]do id",
    "[[:punct:]]udo id",
    "hash",
    "hash -p /usr/bin/ls ll; ll",
    "timeout 0.1 ls",
    "bash -c >/tmp/out 'echo hi'",
    "coproc worker echo hi",
    "ltrace --indent 4 ls",
    "systemd-run -H host ls",
    # faketime parses options only up to the timestamp, so everything after the
    # timestamp is the program: these run a program literally named -f.
    "faketime now -f x sudo id",
    "faketime -m now -f x sudo id",
    # Names that merely contain the letters of sudo are their own programs.
    "sudoku --help",
    "sudo-report --help",
    "SUDOKU --help",
    "/usr/bin/sudoku --help",
    "./sudo-report x",
    # The first backslash escapes the second, so the newline after it does not
    # continue the line: bash runs the word `su\` and then `do id` separately,
    # never sudo (checked against bash 5.3).
    "su\\\\\ndo id",
    "systemd-run -u x ls",
    "watch -d ls",
    "watch -t ls",
    "bash<<<'sh -c \"echo hi\"'",
    "fd -X -d 1 sudo id",
    "fd -X --max-depth 1 sudo id",
    "fd -X -t f sudo id",
    "fd -X -E pat sudo id",
    "strace -o /tmp/x ls",
    "strace -I sudo id",
    "strace -b sudo id",
    "ltrace -o /tmp/x ls",
    "strace -b execve ls",
    "strace -O 10 ls",
    "systemd-run -C c ls",
    "ltrace -A 5 ls",
    "ltrace -x pat ls",
    "bash <(echo hi)",
    "CMD=ls; eval \"$CMD\"",
    "echo {a,b}",
    "{ls,} id",
    "./bin/*.sh",
    "alias ll='ls -l'",
    "alias",
    "timeout -s KILL 5 ls",
    "printf x | xargs -n 1 ls",
    "env -C /tmp ls",
    "stdbuf -o L ls",
]


class SudoDetectionTest(unittest.TestCase):
    def test_alias_chain_at_depth_limit_reaches_a_runner(self):
        # At the cap an unresolved body counts as reaching a runner, so a heredoc
        # piped to it is scanned as a script instead of treated as data.
        self.assertTrue(
            bash_module._body_reaches_runner("alias p=sh", bash_module._MAX_PAYLOAD_DEPTH)
        )

    def test_sudo_command_words_are_violations(self):
        for command in SUDO_MATCHING_COMMANDS:
            with self.subTest(command=command):
                self.assertIsNotNone(bash_module._sudo_violation(command))

    def test_non_command_mentions_are_allowed(self):
        for command in SUDO_NON_MATCHING_COMMANDS:
            with self.subTest(command=command):
                self.assertIsNone(bash_module._sudo_violation(command))

    def test_reason_phrases(self):
        self.assertIn("sudo", bash_module._sudo_violation("sudo ls"))
        self.assertIn("doas", bash_module._sudo_violation("doas id"))


class BraceFloodTest(unittest.TestCase):
    """The brace-expansion cap: a flood fails closed and never scans quadratically."""

    FLOOD = "{" * 32000

    def test_brace_flood_command_word_is_refused_promptly(self):
        started = time.monotonic()
        violation = bash_module._sudo_violation(self.FLOOD)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 5.0)
        self.assertIsNotNone(violation)

    def test_brace_sequences_and_oversized_groups(self):
        # Sequences expand like comma alternatives, and an oversized group fails
        # closed from its element count instead of being built.
        self.assertIsNotNone(bash_module._sudo_violation("s{u..u}do id"))
        self.assertIsNone(bash_module._sudo_violation("echo {1..5}"))
        started = time.monotonic()
        self.assertIsNotNone(bash_module._sudo_violation("{1..9999999}"))
        self.assertIsNotNone(bash_module._sudo_violation("{a,b}" * 22))
        self.assertIsNone(
            bash_module._sudo_violation("echo {0," + ",".join(map(str, range(20000))) + "}")
        )
        # A range CPython cannot even convert must not raise: it fails closed.
        huge = "{" + "1" * 5000 + "..2}"
        self.assertIsNotNone(bash_module._sudo_violation(huge))
        self.assertIsNone(bash_module._sudo_violation("echo " + huge))
        self.assertLess(time.monotonic() - started, 5.0)

    def test_brace_flood_operand_word_is_still_judged(self):
        # A long comma-free blob in operand position is data, not a command word:
        # the word is judged without rescanning the tail for every `{`.
        started = time.monotonic()
        violation = bash_module._sudo_violation("echo " + self.FLOOD)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 5.0)
        self.assertIsNone(violation)


class SudoGuardTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._cwd = os.getcwd()
        self._environ = dict(os.environ)
        os.environ.pop(BASH_SUDO_BYPASS_ENV, None)
        os.environ.pop("PRIME_AGENT_BASH_COMMAND_PREFIX", None)
        frozen = mock.patch.object(bash_module, "_SUDO_BYPASS_AT_KERNEL_START", False)
        frozen.start()
        self.addCleanup(frozen.stop)
        warned = mock.patch.object(bash_module, "_sudo_late_bypass_warned", False)
        warned.start()
        self.addCleanup(warned.stop)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        os.chdir(tmp.name)
        self.addCleanup(self._restore)

    def _restore(self):
        os.chdir(self._cwd)
        os.environ.clear()
        os.environ.update(self._environ)

    def _mock_handle(self):
        handle_patch = mock.patch.object(bash_module, "BashHandle")
        instance = handle_patch.start()
        self.addCleanup(handle_patch.stop)
        return instance

    def _refused(self, command, **kwargs):
        with self.assertRaises(PrivilegeEscalationRefusalError) as caught:
            bash(command, **kwargs)
        return str(caught.exception)

    async def _run(self, command, **kwargs):
        return await asyncio.wait_for(bash(command, **kwargs), AWAIT_TIMEOUT)

    def test_refusal_message_documents_bypasses(self):
        message = self._refused("sudo id")
        self.assertIn("Refusing to run this command", message)
        self.assertIn("allow_sudo=True", message)
        self.assertIn(BASH_SUDO_BYPASS_ENV, message)
        self.assertIn("root", message)

    def test_refusal_happens_before_any_process_starts(self):
        spawn = mock.patch.object(bash_module, "BashHandle", side_effect=AssertionError("spawned"))
        spawn.start()
        self.addCleanup(spawn.stop)
        self._refused("sudo id")

    def test_doas_refused(self):
        self._refused("doas id")

    def test_widest_matching_sample_refused(self):
        for command in SUDO_MATCHING_COMMANDS:
            with self.subTest(command=command):
                self._refused(command)

    def test_lookup_and_operand_forms_allowed(self):
        instance = self._mock_handle()
        for command in ("man sudo", "command -v sudo", "which sudo", "ls /etc/sudoers.d"):
            with self.subTest(command=command):
                bash(command)
        self.assertEqual(instance.call_count, 4)

    def test_kwarg_bypass_passes_guard(self):
        instance = self._mock_handle()
        bash("sudo id", allow_sudo=True)
        instance.assert_called_once_with("sudo id")

    def test_kwarg_bypass_does_not_leak(self):
        self._mock_handle()
        bash("sudo id", allow_sudo=True)
        self._refused("sudo id")

    def test_frozen_env_bypass_honored(self):
        instance = self._mock_handle()
        with mock.patch.object(bash_module, "_SUDO_BYPASS_AT_KERNEL_START", True):
            bash("sudo id")
        instance.assert_called_once_with("sudo id")

    def test_late_bypass_env_ignored_and_warned(self):
        os.environ[BASH_SUDO_BYPASS_ENV] = "1"
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self._refused("sudo id")
            self._refused("sudo id")
        self.assertIn("PI_BASH_ALLOW_SUDO appeared after kernel start", stderr.getvalue())
        self.assertEqual(stderr.getvalue().count("appeared after kernel start"), 1)

    def test_child_env_strips_late_bypass(self):
        os.environ[BASH_SUDO_BYPASS_ENV] = "1"
        self.assertNotIn(BASH_SUDO_BYPASS_ENV, bash_module._child_env())
        with mock.patch.object(bash_module, "_SUDO_BYPASS_AT_KERNEL_START", True):
            self.assertIn(BASH_SUDO_BYPASS_ENV, bash_module._child_env())
