"""Regression tests for #849: an interrupted %%bash/%%script cell's subprocess
tree must actually stop, without ever touching the kernel process itself.

Drives the real installed IPython.core.magics.script module and asyncio
subprocess machinery directly (no full Jupyter kernel is needed), matching the
style of the rest of this suite.
"""

from __future__ import annotations

import asyncio
import os
import signal
import time
import unittest

from IPython.core.magics import script as ipython_script_magics

from rlm import _script_process_group


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _spawn_bash_with_grandchild():
    """Spawn bash exactly the way ScriptMagics.shebang does -- through
    whatever asyncio.create_subprocess_exec is currently bound to on the
    ipython_script_magics module -- running a command that itself forks a
    real, independently-observable grandchild (mirroring a %%bash cell like
    `some_long_command & echo $!`).
    """

    async def _spawn():
        p = await ipython_script_magics.asyncio.create_subprocess_exec(
            "bash",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        p.stdin.write(b"sleep 30 & echo $!\n")
        await p.stdin.drain()
        p.stdin.close()
        grandchild_pid = int((await p.stdout.readline()).strip())
        return p, grandchild_pid

    return asyncio.run(_spawn())


def _cleanup(*pids: int) -> None:
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


class ScriptProcessGroupInstallTest(unittest.TestCase):
    """rlm's patch (import rlm -> _script_process_group.install()) must have
    already run by the time these tests import rlm, matching real kernel
    bootstrap. These exercise the integration end to end.
    """

    def setUp(self):
        # Speed up the escalation timeline for the test instead of sleeping
        # through production-sized delays.
        self._orig_sigterm_delay = _script_process_group.SIGTERM_DELAY_SECONDS
        self._orig_sigkill_delay = _script_process_group.SIGKILL_DELAY_SECONDS
        _script_process_group.SIGTERM_DELAY_SECONDS = 0.05
        _script_process_group.SIGKILL_DELAY_SECONDS = 0.05

    def tearDown(self):
        _script_process_group.SIGTERM_DELAY_SECONDS = self._orig_sigterm_delay
        _script_process_group.SIGKILL_DELAY_SECONDS = self._orig_sigkill_delay
        with _script_process_group._tracked_lock:
            _script_process_group._tracked_pids.clear()

    def test_patched_create_subprocess_exec_isolates_a_new_process_group(self):
        p, grandchild_pid = _spawn_bash_with_grandchild()
        try:
            self.assertTrue(_process_alive(grandchild_pid))
            # Query the group via the grandchild, not bash's own pid: a
            # non-interactive bash exits as soon as it hits EOF on its
            # script input, often before this assertion runs, while the
            # backgrounded grandchild (and the process group itself, which
            # persists as long as any member remains) lives on.
            self.assertEqual(
                os.getpgid(grandchild_pid),
                p.pid,
                "the patched asyncio.create_subprocess_exec used by "
                "ScriptMagics.shebang must isolate the shell into its own "
                "process group",
            )
            self.assertNotEqual(
                os.getpgid(grandchild_pid),
                os.getpgid(0),
                "the isolated process group must differ from this process's own",
            )
        finally:
            _cleanup(grandchild_pid, p.pid)

    def test_sigint_escalates_to_kill_the_whole_group_without_touching_this_process(self):
        p, grandchild_pid = _spawn_bash_with_grandchild()
        try:
            self.assertTrue(_process_alive(grandchild_pid))
            my_pid_before = os.getpid()

            try:
                os.kill(os.getpid(), signal.SIGINT)
                # Give the default/previous handler a chance to raise, then
                # absorb it here -- production installs this over ipykernel's
                # own handler, which does not raise KeyboardInterrupt out to
                # arbitrary code either.
                time.sleep(0.05)
            except KeyboardInterrupt:
                pass

            # Escalation runs on a background thread; wait past both delays.
            deadline = time.time() + 2.0
            while time.time() < deadline and _process_alive(grandchild_pid):
                time.sleep(0.02)

            self.assertFalse(
                _process_alive(grandchild_pid),
                "the grandchild must be killed by the SIGINT-triggered group "
                "escalation, not leaked (this is the exact symptom in #849)",
            )
            self.assertFalse(_process_alive(p.pid), "the shell itself must also be gone")
            self.assertEqual(os.getpid(), my_pid_before, "the kernel process itself must survive untouched")
        finally:
            _cleanup(grandchild_pid, p.pid)

    def test_explicitly_backgrounded_subprocess_survives_an_unrelated_interrupt(self):
        p, grandchild_pid = _spawn_bash_with_grandchild()

        class _FakeBgProcess:
            pid = p.pid

        class _FakeScriptMagics:
            bg_processes = [_FakeBgProcess()]

        import IPython.core.interactiveshell as interactiveshell_module

        class _FakeShell:
            class magics_manager:
                registry = {"ScriptMagics": _FakeScriptMagics()}

        original_instance = interactiveshell_module.InteractiveShell.instance
        interactiveshell_module.InteractiveShell.instance = classmethod(lambda cls: _FakeShell())
        try:
            try:
                os.kill(os.getpid(), signal.SIGINT)
                time.sleep(0.05)
            except KeyboardInterrupt:
                pass
            time.sleep(0.3)  # past both escalation delays
            # Check the grandchild, not bash itself: a non-interactive bash
            # exits on EOF regardless of any signal handling, so bash's own
            # liveness would not distinguish correct from buggy behavior. The
            # grandchild is the actual backgrounded work that must survive.
            self.assertTrue(
                _process_alive(grandchild_pid),
                "%%bash --bg is an explicit opt-in to outlive its cell; an "
                "unrelated later interrupt must not sweep it",
            )
        finally:
            interactiveshell_module.InteractiveShell.instance = original_instance
            _cleanup(grandchild_pid, p.pid)

    def test_completed_subprocess_is_pruned_and_ignored(self):
        async def _spawn_and_wait():
            p = await ipython_script_magics.asyncio.create_subprocess_exec(
                "bash",
                "-c",
                "true",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await p.wait()
            return p

        p = asyncio.run(_spawn_and_wait())
        time.sleep(0.05)
        with _script_process_group._tracked_lock:
            _script_process_group._prune_tracked_locked()
            self.assertNotIn(p.pid, _script_process_group._tracked_pids)


if __name__ == "__main__":
    unittest.main()
