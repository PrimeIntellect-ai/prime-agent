#!/usr/bin/env python3
"""The sandbox-runner provisioning contract battery (register_runner.sh).

The security case is first (the fold-gates pattern): the registration
values (url, token, name, labels) reach config.sh as argv, and the
supervision call passes only the user and the script path to su as argv -
no value is ever interpolated shell source - so quotes, spaces, backticks,
command substitutions, and leading dashes in any value are data, never
syntax. A leading-dash value must not be consumed as su's own option
(GNU su permutes options among trailing args), which is what the --
terminator on both su invocations guarantees.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROVISIONER = HERE / "register_runner.sh"

REGISTER_OPENER = "cat > \"${RUNNER_DIR}/runner-register.sh\" <<'REGISTER'"
REGISTER_EXPECTED_SU = ('su -s /bin/bash -- "${RUNNER_USER}" '
                        '"${RUNNER_DIR}/runner-register.sh" '
                        '"${RUNNER_URL}" "${RUNNER_TOKEN}" '
                        '"${RUNNER_NAME}" "${RUNNER_LABELS}"')
SUPERVISE_EXPECTED_SU = ('setsid nohup su -s /bin/bash -- "${RUNNER_USER}" '
                         '"${RUNNER_DIR}/runner-supervise.sh" '
                         '> /dev/null 2>&1 < /dev/null &')

# Hostile-but-legal provision values: quotes, spaces, backticks, command
# substitutions, and leading dashes. If any value ever crosses as
# interpolated shell source, the touch commands execute and the test fails.
HOSTILE_URL = "https://github.com/PrimeIntellect-ai/prime-agent"
HOSTILE_TOKEN = "to'k$(touch pwned-token)e`n`x"
HOSTILE_NAME = "na'me$(touch pwned-name) two  spaces"
HOSTILE_LABELS = "-c --command=evil --help"


def heredoc_body(source: str, opener: str, delimiter: str) -> str:
    """The heredoc body the provisioner writes between opener and its
    quoted delimiter."""
    lines = source.splitlines()
    start = next(i for i, line in enumerate(lines) if line == opener)
    end = next(i for i in range(start + 1, len(lines))
               if lines[i] == delimiter)
    return "\n".join(lines[start + 1:end]) + "\n"


def invocation_lines(source: str) -> list[str]:
    """Every su invocation in the provisioner, each joined to one line
    (its backslash continuation collapsed)."""
    lines = source.splitlines()
    joined: list[str] = []
    i = 0
    while i < len(lines):
        if re.search(r"(^|\s)su -s /bin/bash", lines[i]):
            merged = lines[i]
            while merged.rstrip().endswith("\\"):
                merged = merged.rstrip()[:-1] + " " + lines[i + 1]
                i += 1
            joined.append(" ".join(merged.split()))
        i += 1
    return joined


class RunnerRegisterContract(unittest.TestCase):
    def test_values_cross_as_argv_never_shell_source(self) -> None:
        """config.sh receives hostile values byte-exact, and nothing the
        values spell gets executed."""
        body = heredoc_body(PROVISIONER.read_text(), REGISTER_OPENER,
                            "REGISTER")
        with tempfile.TemporaryDirectory(prefix="runner-gates-") as tmp:
            # A space in the directory proves the script's own path is
            # never interpolated either.
            script_dir = Path(tmp) / "opt dir"
            script_dir.mkdir()
            register = script_dir / "runner-register.sh"
            register.write_text(body)
            register.chmod(0o700)
            stub = script_dir / "config.sh"
            stub.write_text(
                "#!/bin/bash\n"
                "printf '%s\\0' \"$@\" > config.argv\n"
                "pwd > config.cwd\n"
            )
            stub.chmod(0o700)
            result = subprocess.run(
                [str(register), HOSTILE_URL, HOSTILE_TOKEN, HOSTILE_NAME,
                 HOSTILE_LABELS],
                capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0,
                             f"register script failed: {result.stderr}")
            recorded = (script_dir / "config.argv").read_bytes()
            self.assertEqual(
                [chunk.decode() for chunk in recorded.split(b"\0") if chunk],
                ["--unattended", "--url", HOSTILE_URL, "--token",
                 HOSTILE_TOKEN, "--name", HOSTILE_NAME, "--labels",
                 HOSTILE_LABELS, "--no-default-labels", "--replace"],
                "config.sh argv is not byte-exact: a value was mangled "
                "or executed as shell source")
            self.assertEqual(
                (script_dir / "config.cwd").read_text().strip(),
                str(script_dir))
            for pwned in ("pwned-token", "pwned-name"):
                self.assertFalse((script_dir / pwned).exists(),
                                 f"{pwned} executed: a value crossed as "
                                 "shell source")

    def test_su_invocations_keep_values_as_argv(self) -> None:
        """Both su calls terminate su option parsing with -- before any
        operand and carry no -c shell string: no provision value can be
        consumed as su's own option or executed as shell source."""
        source = PROVISIONER.read_text()
        su_lines = invocation_lines(source)
        self.assertEqual(len(su_lines), 2,
                         f"expected exactly two su invocations, found "
                         f"{su_lines}")
        for su_line in su_lines:
            self.assertNotIn(" -c", " " + su_line,
                             "a su -c shell string is back: "
                             f"{su_line}")
        self.assertEqual(su_lines[0], REGISTER_EXPECTED_SU,
                         "the registration su invocation changed shape; "
                         "-- must precede every operand")
        self.assertEqual(su_lines[1].rstrip(),
                         SUPERVISE_EXPECTED_SU,
                         "the supervision su invocation changed shape; "
                         "-- must precede every operand")


class SuOptionPermutation(unittest.TestCase):
    def test_leading_dash_value_cannot_become_su_option(self) -> None:
        """Root-free, prompt-free proof of both directions: without --, a
        trailing --help is consumed by su itself (the trap the provisioner
        must never fall into); with --, it is passed through to the target
        command instead of being parsed as su's option.

        Both invocations run detached from the controlling terminal
        (start_new_session, the subprocess form of setsid): su reads the
        password from /dev/tty, not stdin, so without the detach a
        non-root PAM conversation would block the terminal waiting for
        input. Detached, it fails fast instead - and as root no password
        is asked at all, so the hardened direction runs printf directly.
        """
        su = shutil.which("su")
        printf = shutil.which("printf") or "/usr/bin/printf"
        if su is None:
            self.skipTest("su is not installed")
        user = subprocess.run(["id", "-un"], capture_output=True,
                              text=True).stdout.strip()

        vulnerable = subprocess.run(
            [su, "-s", "/bin/bash", user, printf, "--help"],
            capture_output=True, text=True, timeout=30,
            stdin=subprocess.DEVNULL, start_new_session=True)
        # The help banner differs by su implementation (GNU prints
        # "Usage: su ...", util-linux "Usage:\n su ..."); "Usage" is the
        # marker both share. The --help is consumed before any
        # authentication, so this direction never prompts.
        self.assertIn("Usage", vulnerable.stdout,
                      "su no longer permutes trailing options; re-check "
                      "the trap this test documents")

        hardened = subprocess.run(
            [su, "-s", "/bin/bash", "--", user, printf, "--help"],
            capture_output=True, text=True, timeout=30,
            stdin=subprocess.DEVNULL, start_new_session=True)
        self.assertNotIn("Usage", hardened.stdout + hardened.stderr,
                         "a leading-dash value was consumed as su's own "
                         "option despite the -- terminator")


if __name__ == "__main__":
    unittest.main(verbosity=2)
