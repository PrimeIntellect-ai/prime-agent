from __future__ import annotations

import asyncio
import json
import os
import resource
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from rlm import bash

# The package re-exports the bash() function under the same name, so reach the
# module through sys.modules for internals.
bash_module = sys.modules["rlm.bash"]


def _win_spawn(procs=None, resume=True):
    # POSIX stand-in for _winjob.spawn_in_job: a real Popen plus a resume() mock (Ubuntu CI).
    def spawn_in_job(job, argv, cwd, env):
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
        proc.resume = mock.Mock(return_value=resume)
        proc.close = mock.Mock()
        proc.spawn_job = job
        proc.spawn_argv = argv
        if procs is not None:
            procs.append(proc)
        return proc

    return spawn_in_job


class BashTest(unittest.IsolatedAsyncioTestCase):
    async def test_await_returns_result(self):
        result = await bash("echo hi")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        self.assertGreaterEqual(result.duration, 0)

        handle = bash("echo again")
        awaited = await handle
        self.assertEqual(handle.poll(), awaited)

    async def test_status_pipe_survives_high_fds_and_strict_posix_shell(self):
        # Regression: dash rejects multi-digit fds in redirections at parse
        # time, so the script must never reference the raw status-pipe fd.
        dummies = [os.open(os.devnull, os.O_RDONLY) for _ in range(30)]
        self.addCleanup(lambda: [os.close(fd) for fd in dummies])
        if os.path.exists("/bin/dash"):
            with mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/dash"}):
                result = await bash("echo ok")
            self.assertEqual(result.exit_code, 0)
            self.assertIn("ok", result.output)
        result = await bash("echo ok-default")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("ok-default", result.output)

    async def test_backgrounded_tail_and_kill(self):
        handle = bash("echo start; sleep 30")
        self.assertIsNone(handle.poll())
        for _ in range(100):
            if "start" in handle.tail():
                break
            await asyncio.sleep(0.05)
        self.assertIn("start", handle.tail())
        self.assertTrue(handle.running)
        handle.kill(grace=0.2)
        result = await asyncio.wait_for(handle, timeout=5)
        self.assertNotEqual(result.exit_code, 0)

    async def test_kill_escalates_to_sigkill(self):
        handle = bash("trap '' TERM; echo up; sleep 30")
        for _ in range(100):
            if "up" in handle.output():
                break
            await asyncio.sleep(0.05)
        handle.kill(grace=0.2)
        result = await asyncio.wait_for(handle, timeout=10)
        self.assertEqual(result.exit_code, -9)

    async def test_buffer_cap_keeps_head_and_tail(self):
        result = await bash("seq 1 400000")
        self.assertLessEqual(len(result.output), 2 * 1024 * 1024 + 256)
        self.assertTrue(result.output.startswith("1\n"))
        self.assertIn("400000", result.output)
        self.assertIn("bytes dropped", result.output)

    async def test_env_prefix_and_journal(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(
                os.environ,
                {
                    "PRIME_AGENT_BASH_COMMAND_PREFIX": "echo prefixed",
                    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                    "PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid()),
                },
            ):
                handle = bash('echo "$NO_COLOR $TERM"')
                result = await handle
                # The inactive record lands slightly after finalize, once the group exits.
                records = await _poll_journal(journal, count=2)
            self.assertEqual(result.exit_code, 0)
            lines = result.output.splitlines()
            self.assertEqual(lines[0], "prefixed")
            self.assertIn("1 dumb", lines[1])

            self.assertEqual([r["active"] for r in records], [True, False])
            for record in records:
                self.assertEqual(record["pid"], handle.pid)
                self.assertEqual(record["ownerPid"], os.getpid())
                self.assertEqual(record["kernelPid"], os.getpid())
            self.assertTrue(records[0]["processStartId"].startswith(("proc:", "ps:")))

    async def test_await_returns_when_shell_backgrounds_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(
                os.environ,
                {
                    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                    "PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid()),
                },
            ):
                handle = bash("echo fg; sleep 30 &")
                result = await asyncio.wait_for(handle, timeout=5)
                self.assertEqual(result.exit_code, 0)
                self.assertIn("fg", result.output)
                # The shell stays alive as group leader, anchoring its background job.
                os.killpg(handle.pid, 0)
                records = await _poll_journal(journal, count=1)
                self.assertTrue(records[-1]["active"])
                handle.kill(signal.SIGKILL)
                records = await _poll_journal(journal, count=2)
            self.assertFalse(records[-1]["active"])

    async def test_early_shell_exit_returns_and_kills_group(self):
        handle = bash("sleep 30 & exit 7")
        result = await asyncio.wait_for(handle, timeout=5)
        self.assertEqual(result.exit_code, 7)
        # The leader died without draining, so the stale group must be killed.
        await _poll_group_dead(handle.pid)

    async def test_term_ignoring_child_is_escalated(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(
                os.environ,
                {
                    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                    "PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid()),
                },
            ):
                handle = bash("sh -c 'trap \"\" TERM; echo ready; sleep 30' &")
                await asyncio.wait_for(handle, timeout=5)
                for _ in range(100):
                    if "ready" in handle.output():
                        break
                    await asyncio.sleep(0.05)
                handle.kill(signal.SIGTERM)
                records = await _poll_journal(journal, count=2, timeout=10)
            self.assertFalse(records[-1]["active"])
            await _poll_group_dead(handle.pid)

    async def test_delivered_status_wins_when_shell_dies_during_completion(self):
        entered = threading.Event()
        release = threading.Event()
        original = bash_module.BashHandle._wait_for_completion

        def held_completion(handle_self):
            output = original(handle_self)
            entered.set()
            release.wait(10)
            return output

        with mock.patch.object(
            bash_module.BashHandle, "_wait_for_completion", held_completion
        ):
            # Background job keeps the shell alive in `wait` after status 0 is delivered.
            handle = bash("sleep 30 & true")
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                os.kill(handle.pid, signal.SIGTERM)
                # _watch must fully finish its finalize decision while _report is held.
                for _ in range(200):
                    with bash_module._live_lock:
                        if handle not in bash_module._live_handles:
                            break
                    await asyncio.sleep(0.05)
                else:
                    self.fail("watcher did not complete while reporter was held")
            finally:
                release.set()
            result = await asyncio.wait_for(handle, timeout=5)
        self.assertEqual(result.exit_code, 0)

    async def test_delivered_status_wins_when_reporter_is_slow(self):
        parsed = threading.Event()
        release = threading.Event()
        original = bash_module.BashHandle._read_status

        def slow_read(handle_self):
            # Pause after read+parse but before the status is reserved, longer
            # than the old 1.0s _watch timeout, while the shell dies.
            status = original(handle_self)
            parsed.set()
            release.wait(10)
            return status

        with mock.patch.object(bash_module.BashHandle, "_read_status", slow_read):
            # Background job keeps the shell alive in `wait` after status 0 is written.
            handle = bash("sleep 30 & true")
            try:
                self.assertTrue(await asyncio.to_thread(parsed.wait, 5))
                os.kill(handle.pid, signal.SIGTERM)
                # Outlast the old timeout so a timed wait would have finalized -15.
                await asyncio.sleep(1.5)
                self.assertIsNone(handle.poll())
            finally:
                release.set()
            result = await asyncio.wait_for(handle, timeout=5)
        self.assertEqual(result.exit_code, 0)

    async def test_status_survives_pipe_fds_above_fd_setsize(self):
        # select.select() rejects fds >= FD_SETSIZE (1024); the delivered status
        # must still win when the status/wake pipes land above that boundary.
        limits = resource.getrlimit(resource.RLIMIT_NOFILE)
        if limits[0] < 1100:
            try:
                resource.setrlimit(resource.RLIMIT_NOFILE, (1100, limits[1]))
            except (ValueError, OSError):
                self.skipTest("cannot raise RLIMIT_NOFILE above FD_SETSIZE")
            self.addCleanup(resource.setrlimit, resource.RLIMIT_NOFILE, limits)
        held: list[int] = []
        self.addCleanup(lambda: [os.close(fd) for fd in held])
        while True:
            fd = os.open(os.devnull, os.O_RDONLY)
            held.append(fd)
            if fd >= 1024:
                break
        handle = bash("echo hi; sleep 30 & true")
        self.addCleanup(handle.kill, signal.SIGKILL)
        result = await asyncio.wait_for(handle, timeout=5)
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)

    async def test_awaits_do_not_hold_executor_threads(self):
        loop = asyncio.get_running_loop()
        executor = ThreadPoolExecutor(max_workers=1)
        loop.set_default_executor(executor)
        tasks = [asyncio.ensure_future(bash("sleep 0.5")._wait()) for _ in range(3)]
        await asyncio.sleep(0.1)
        # Old executor-parked waits would deadlock this 1-thread pool.
        value = await asyncio.wait_for(loop.run_in_executor(None, lambda: 42), timeout=0.3)
        self.assertEqual(value, 42)
        results = await asyncio.gather(*tasks)
        self.assertTrue(all(r.exit_code == 0 for r in results))

    def test_buffer_tail_retention_is_exact(self):
        buffer = bash_module._BoundedBuffer()
        buffer.write(b"x" * bash_module._HEAD_CAP)
        buffer.write(b"a" * bash_module._TAIL_CAP)
        buffer.write(b"b" * 1000)
        self.assertEqual(buffer._tail_size, bash_module._TAIL_CAP)
        text = buffer.text()
        self.assertTrue(text.endswith("b" * 1000))
        self.assertIn("a" * 1000 + "b" * 1000, text)

    async def test_running_reflects_group_liveness(self):
        handle = bash("echo fg; sleep 30 &")
        result = await asyncio.wait_for(handle, timeout=5)
        self.assertEqual(result.exit_code, 0)
        # The foreground result is in, but the group still anchors `sleep 30 &`.
        self.assertIsNotNone(handle.poll())
        self.assertTrue(handle.running)
        handle.kill(signal.SIGKILL)
        for _ in range(100):
            if not handle.running:
                break
            await asyncio.sleep(0.05)
        self.assertFalse(handle.running)

    async def test_windows_kill_terminates_tree(self):
        # Pins the taskkill fallback when TerminateJobObject failed or raced.
        handle = bash("sleep 30")
        try:
            handle._job = None
            completed = mock.Mock(returncode=0)
            with mock.patch.object(bash_module, "_IS_POSIX", False):
                with mock.patch.object(handle._proc, "kill") as proc_kill:
                    patched_run = mock.patch.object(
                        bash_module.subprocess, "run", return_value=completed
                    )
                    with mock.patch.dict(os.environ, {"SystemRoot": r"C:\WinTest"}):
                        with patched_run as run:
                            handle.kill()
                    taskkill = os.path.join(r"C:\WinTest", "System32", "taskkill.exe")
                    self.assertEqual(
                        run.call_args.args[0], [taskkill, "/PID", str(handle.pid), "/T", "/F"]
                    )
                    self.assertEqual(
                        run.call_args.kwargs["env"]["NoDefaultCurrentDirectoryInExePath"], "1"
                    )
                    proc_kill.assert_not_called()
                    # No SystemRoot in the env falls back to C:\Windows.
                    with mock.patch.dict(os.environ):
                        os.environ.pop("SystemRoot", None)
                        with patched_run as run:
                            handle.kill()
                    self.assertTrue(run.call_args.args[0][0].startswith(r"C:\Windows"))
                    # taskkill unavailable or failing must fall back to Popen.kill().
                    with mock.patch.object(bash_module.subprocess, "run", side_effect=OSError):
                        handle.kill()
                    proc_kill.assert_called_once()
        finally:
            handle.kill(signal.SIGKILL)
            await asyncio.wait_for(handle, timeout=5)

    def test_gate_eof_without_journal_prevents_command_execution(self):
        # A kernel SIGKILL between Popen and journaling closes the parent socket;
        # the child's gate read must then EOF and exit before running the command.
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX-only gate")
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "ran")
            script = bash_module._status_script(f"touch {marker}", "a" * 32, "b" * 32)
            parent, child = socket.socketpair()
            proc = subprocess.Popen(
                [bash_module._shell(), "-c", script],
                stdin=child.fileno(),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            child.close()
            parent.close()  # simulate parent death before the gate byte
            proc.communicate(timeout=10)
            self.assertEqual(proc.returncode, 127)
            self.assertFalse(os.path.exists(marker))

    def test_status_socket_closed_when_wake_pipe_fails(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX-only fds")
        acquired: list[int] = []
        closed: list[int] = []
        real_socketpair = socket.socketpair
        real_close = os.close

        def capturing_socketpair(*args, **kwargs):
            pair = real_socketpair(*args, **kwargs)
            acquired.extend((pair[0].fileno(), pair[1].fileno()))
            return pair

        def recording_close(fd):
            closed.append(fd)
            real_close(fd)

        with mock.patch.object(bash_module.socket, "socketpair", capturing_socketpair):
            with mock.patch.object(bash_module.os, "close", recording_close):
                with mock.patch.object(bash_module.os, "pipe", side_effect=OSError("boom")):
                    with self.assertRaises(OSError):
                        bash("echo never")
        self.assertEqual(len(acquired), 2)
        for fd in acquired:
            self.assertIn(fd, closed)

    def test_windows_process_start_id(self):
        completed = mock.Mock(stdout="638000000000000000\n")
        with mock.patch.dict(os.environ, {"SystemRoot": r"C:\WinTest"}):
            with mock.patch.object(bash_module.os, "name", "nt"):
                with mock.patch.object(
                    bash_module.subprocess, "run", return_value=completed
                ) as run:
                    self.assertEqual(bash_module._process_start_id(1234), "win:638000000000000000")
        argv = run.call_args.args[0]
        self.assertEqual(
            argv[0],
            os.path.join(r"C:\WinTest", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        )
        self.assertEqual(run.call_args.kwargs["env"]["NoDefaultCurrentDirectoryInExePath"], "1")
        self.assertIn("GetProcessById(1234)", argv[-1])
        garbage = mock.Mock(stdout="not a number\n")
        with mock.patch.object(bash_module.os, "name", "nt"):
            with mock.patch.object(bash_module.subprocess, "run", return_value=garbage):
                self.assertIsNone(bash_module._process_start_id(1234))

    async def test_cancelled_direct_await_kills_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "marker")
            pids: list[int] = []
            original_init = bash_module.BashHandle.__init__

            def capturing_init(handle_self, command):
                original_init(handle_self, command)
                pids.append(handle_self._pid)

            async def run_oneshot():
                await bash(f"sleep 1.0 && touch {marker}")

            with mock.patch.object(bash_module.BashHandle, "__init__", capturing_init):
                task = asyncio.ensure_future(run_oneshot())
                await asyncio.sleep(0.3)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            # The cancel path awaits confirmed group death before propagating.
            if bash_module._IS_POSIX:
                with self.assertRaises(ProcessLookupError):
                    os.killpg(pids[0], 0)
            await asyncio.sleep(1.0)
            self.assertFalse(os.path.exists(marker))

    async def test_cancelled_direct_await_escalates_past_term_trap(self):
        # A TERM-trapping command must be group-KILLed before the cancel
        # resolves, so its later side effects never land.
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "marker")
            pids: list[int] = []
            original_init = bash_module.BashHandle.__init__

            def capturing_init(handle_self, command):
                original_init(handle_self, command)
                pids.append(handle_self._pid)

            async def run_oneshot():
                await bash(f"trap '' TERM; sleep 1.0; touch {marker}; sleep 30")

            with mock.patch.object(bash_module, "_CANCEL_TERM_GRACE", 0.2):
                with mock.patch.object(bash_module.BashHandle, "__init__", capturing_init):
                    task = asyncio.ensure_future(run_oneshot())
                    await asyncio.sleep(0.2)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
            if bash_module._IS_POSIX:
                with self.assertRaises(ProcessLookupError):
                    os.killpg(pids[0], 0)
            await asyncio.sleep(1.2)
            self.assertFalse(os.path.exists(marker))

    async def test_background_handle_survives_cancel_of_creating_context(self):
        handles: list[bash_module.BashHandle] = []

        async def run_background():
            h = bash("sleep 30")
            handles.append(h)
            h.pid  # released as a deliberate background handle
            await asyncio.sleep(10)

        task = asyncio.ensure_future(run_background())
        await asyncio.sleep(0.3)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        handle = handles[0]
        try:
            os.killpg(handle._pid, 0)  # still alive
        finally:
            handle.kill(signal.SIGKILL)
        await asyncio.wait_for(handle, timeout=5)

    async def test_cancelling_await_on_released_handle_does_not_kill(self):
        handle = bash("sleep 30")
        self.assertTrue(handle.running)  # release as background handle

        async def wait_for_it():
            await handle

        task = asyncio.ensure_future(wait_for_it())
        await asyncio.sleep(0.3)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        try:
            os.killpg(handle._pid, 0)  # still alive
        finally:
            handle.kill(signal.SIGKILL)
        await asyncio.wait_for(handle, timeout=5)

    async def test_second_await_after_cancelled_oneshot_only_waits(self):
        handle = bash("echo done")
        # First await consumes the one-shot ownership; later awaits only wait.
        result = await handle
        self.assertEqual(result.exit_code, 0)
        self.assertTrue(handle._released)
        again = await handle
        self.assertEqual(again, result)

    async def test_second_cancel_during_cleanup_still_confirms_group_death(self):
        # Python 3.11: an await inside an except-CancelledError block of a
        # cancelled task is re-cancelled immediately; the shielded confirm task
        # must survive repeated cancels and the group must be dead on return.
        pids: list[int] = []
        original_init = bash_module.BashHandle.__init__

        def capturing_init(handle_self, command):
            original_init(handle_self, command)
            pids.append(handle_self._pid)

        async def run_oneshot():
            await bash("trap '' TERM; sleep 30")

        with mock.patch.object(bash_module, "_CANCEL_TERM_GRACE", 0.2):
            with mock.patch.object(bash_module.BashHandle, "__init__", capturing_init):
                task = asyncio.ensure_future(run_oneshot())
                await asyncio.sleep(0.2)
                task.cancel()
                await asyncio.sleep(0.05)
                task.cancel()  # lands inside the cleanup awaits
                await asyncio.sleep(0.05)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
        with self.assertRaises(ProcessLookupError):
            os.killpg(pids[0], 0)

    async def test_windows_without_bash_raises_teaching_error(self):
        # Windows must raise without consulting PATH: a which() hit would be
        # the same repo-controlled-PATH hole the host-side resolution closed.
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(
                bash_module.shutil, "which", return_value=r"C:\evil\bash.exe"
            ) as which:
                with self.assertRaisesRegex(RuntimeError, "PRIME_AGENT_BASH_SHELL"):
                    bash_module._shell()
                which.assert_not_called()

    async def test_pump_delayed_past_old_quiescence_bound_captures_all_output(self):
        # The ordered sentinel must wait through a pump delay beyond the old 500 ms bound.
        original_write = bash_module._BoundedBuffer.write
        delayed_once = threading.Event()

        def delayed_write(buffer_self, chunk):
            if not delayed_once.is_set():
                delayed_once.set()
                time.sleep(0.7)
            original_write(buffer_self, chunk)

        with mock.patch.object(bash_module._BoundedBuffer, "write", delayed_write):
            result = await asyncio.wait_for(bash("printf delayed-output-complete"), timeout=5)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.output, "delayed-output-complete")

    async def test_completion_marker_split_across_reads_is_removed(self):
        with mock.patch.object(bash_module, "_READ_CHUNK", 7):
            result = await asyncio.wait_for(bash("printf exact-pre-fence-output"), timeout=5)
        self.assertEqual(result.output, "exact-pre-fence-output")

    async def test_slow_pump_does_not_lose_foreground_output(self):
        # Finalization waits for the pump to parse the ordered sentinel.
        original_pump = bash_module.BashHandle._pump

        def slow_pump(handle_self):
            time.sleep(0.3)
            original_pump(handle_self)

        with mock.patch.object(bash_module.BashHandle, "_pump", slow_pump):
            result = await asyncio.wait_for(bash("printf slow-pump-x"), timeout=5)
        self.assertEqual(result.exit_code, 0)
        self.assertIn("slow-pump-x", result.output)

    async def test_sentinel_like_output_and_echoed_wrapper_do_not_truncate(self):
        token = "0123456789abcdef" * 4
        raw_lookalike = "\x1eprime-agent-complete:not-this-invocation\x1f"
        command = (
            "set -x\n"
            "printf '\\036prime-agent-complete:not-this-invocation\\037'\n"
            "if [ -r /proc/$$/cmdline ]; then cat /proc/$$/cmdline; fi\n"
            "printf '\\nafter-sentinel-lookalike\\n'"
        )
        with mock.patch.object(bash_module.secrets, "token_hex", return_value=token):
            result = await asyncio.wait_for(bash(command), timeout=5)
        actual_marker = (
            bash_module._COMPLETION_PREFIX + token.encode() + bash_module._COMPLETION_SUFFIX
        )
        self.assertIn(raw_lookalike, result.output)
        self.assertIn("after-sentinel-lookalike", result.output)
        self.assertNotIn(actual_marker.decode(), result.output)

    async def test_user_alias_cannot_replace_completion_emitter(self):
        if os.path.basename(bash_module._shell()) != "bash":
            self.skipTest("bash alias expansion semantics")
        handle = bash(
            "shopt -s expand_aliases; alias command='printf alias-expanded'; sleep 30 &"
        )
        try:
            result = await asyncio.wait_for(handle, timeout=5)
            self.assertEqual(result.exit_code, 0)
            self.assertNotIn("alias-expanded", result.output)
        finally:
            handle.kill(signal.SIGKILL)
            await _poll_group_dead(handle.pid)

    async def test_user_function_cannot_replace_completion_emitter(self):
        # The backslash in `\command` defeats alias expansion only: a shell
        # function named `command` would otherwise swallow both fence frames
        # and wedge the await behind the background job until shell death.
        handle = bash("command() { printf function-expanded; }; sleep 30 &")
        try:
            result = await asyncio.wait_for(handle, timeout=5)
            self.assertEqual(result.exit_code, 0)
            self.assertNotIn("function-expanded", result.output)
        finally:
            handle.kill(signal.SIGKILL)
            await _poll_group_dead(handle.pid)

    async def test_shell_killed_before_sentinel_finalizes_from_exit(self):
        result = await asyncio.wait_for(
            bash("printf output-before-shell-kill; kill -KILL $$"), timeout=5
        )
        self.assertEqual(result.exit_code, -signal.SIGKILL)
        self.assertIn("output-before-shell-kill", result.output)

    async def test_relative_bash_shell_override_rejected(self):
        with mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "bash"}):
            with self.assertRaises(ValueError):
                bash("echo hi")

    async def test_windows_journal_writes_only_enriched_record(self):
        # No pid-only pre-record on Windows: the kill-on-close job replaces it
        # (a kernel death reaps the tree via handle closure, so a bare-pid
        # anchor would only ever justify killing a reused pid).
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(
                os.environ,
                {
                    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                    "PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid()),
                    "PRIME_AGENT_BASH_SHELL": "/bin/sh",
                },
            ):
                with mock.patch.object(bash_module, "_IS_POSIX", False):
                    with mock.patch.object(bash_module._winjob, "spawn_in_job", _win_spawn()):
                        with mock.patch.object(bash_module._winjob, "create_job", return_value=7):
                            with mock.patch.object(
                                bash_module._winjob, "terminate", return_value=True
                            ):
                                with mock.patch.object(bash_module._winjob, "close"):
                                    handle = bash("echo hi")
                                    await asyncio.wait_for(handle, timeout=5)
                                    for _ in range(100):
                                        if handle._reaped:
                                            break
                                        await asyncio.sleep(0.05)
            active = [r for r in await _poll_journal(journal, count=1) if r["active"]]
            self.assertEqual(len(active), 1)
            self.assertIn("processStartId", active[0])

    async def test_windows_spawn_creates_child_inside_job(self):
        sentinel = 4242
        spawned = []
        order = []
        real_journal = bash_module._record_journal
        base_spawn = _win_spawn(spawned)

        def journal(pid, active):
            order.append("journal")
            return real_journal(pid, active)

        def spawn(job, argv, cwd, env):
            order.append("spawn")
            proc = base_spawn(job, argv, cwd, env)
            proc.resume = mock.Mock(side_effect=lambda: order.append("resume") or True)
            return proc

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", spawn):
                with mock.patch.object(bash_module, "_record_journal", journal):
                    with mock.patch.object(
                        bash_module._winjob,
                        "create_job",
                        side_effect=lambda: order.append("create_job") or sentinel,
                    ):
                        handle = bash("sleep 30")
                try:
                    # The journal write runs while the job-contained child is still suspended.
                    self.assertEqual(spawned[-1].spawn_job, sentinel)
                    self.assertEqual(
                        spawned[-1].spawn_argv,
                        ["/bin/sh", "-c", bash_module._with_prefix("sleep 30")],
                    )
                    spawned[-1].resume.assert_called_once_with()
                    self.assertEqual(order, ["create_job", "spawn", "journal", "resume"])
                    self.assertEqual(handle._job, sentinel)
                finally:
                    handle._job = None
                    handle.kill(signal.SIGKILL)
                    await asyncio.wait_for(handle, timeout=5)

    async def test_windows_create_job_failure_fails_closed(self):
        journal_calls = []

        def journal(pid, active):
            journal_calls.append((pid, active))
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job") as spawn:
                with mock.patch.object(bash_module, "_record_journal", journal):
                    with mock.patch.object(bash_module._winjob, "create_job", return_value=None):
                        with self.assertRaisesRegex(RuntimeError, "job containment"):
                            bash("sleep 30")
        # A create_job failure aborts before spawn_in_job: nothing spawned, nothing journaled.
        spawn.assert_not_called()
        self.assertEqual(journal_calls, [])

    async def test_windows_resume_failure_fails_closed(self):
        sentinel = 4343
        spawned = []
        journal_calls = []

        def journal(pid, active):
            journal_calls.append((pid, active))
            return True

        def terminate(job):
            # The abort kills the suspended, job-contained child via the job.
            spawned[0].kill()
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(
                bash_module._winjob, "spawn_in_job", _win_spawn(spawned, resume=False)
            ):
                with mock.patch.object(bash_module, "_record_journal", journal):
                    with mock.patch.object(
                        bash_module._winjob, "create_job", return_value=sentinel
                    ):
                        with mock.patch.object(
                            bash_module._winjob, "terminate", side_effect=terminate
                        ) as term:
                            with mock.patch.object(bash_module._winjob, "close") as close:
                                with self.assertRaisesRegex(RuntimeError, "job containment"):
                                    bash("sleep 30")
        term.assert_called_once_with(sentinel)
        close.assert_called_once_with(sentinel)
        self.assertIsNotNone(spawned[0].poll())
        spawned[0].close.assert_called_once()
        self.assertEqual(journal_calls, [(spawned[0].pid, True), (spawned[0].pid, False)])

    async def test_windows_journal_enrollment_failure_kills_suspended_leader(self):
        # A journal failure must kill the suspended, job-contained leader and retire the record.
        sentinel = 4545
        spawned = []
        journal_calls = []

        def journal(pid, active):
            journal_calls.append((pid, active))
            return not active  # enrollment fails; the retirement write succeeds

        def terminate(job):
            spawned[0].kill()
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", _win_spawn(spawned)):
                with mock.patch.object(bash_module, "_record_journal", journal):
                    with mock.patch.object(
                        bash_module._winjob, "create_job", return_value=sentinel
                    ):
                        with mock.patch.object(
                            bash_module._winjob, "terminate", side_effect=terminate
                        ) as term:
                            with mock.patch.object(bash_module._winjob, "close") as close:
                                with self.assertRaisesRegex(RuntimeError, "journal enrollment"):
                                    bash("sleep 30")
        term.assert_called_once_with(sentinel)
        close.assert_called_once_with(sentinel)
        spawned[0].resume.assert_not_called()
        self.assertIsNotNone(spawned[0].poll())
        self.assertEqual(journal_calls, [(spawned[0].pid, True), (spawned[0].pid, False)])

    async def test_windows_spawn_failure_closes_precreated_job(self):
        # A spawn_in_job failure must close the pre-created job and never touch the journal.
        sentinel = 4646
        journal_calls = []

        def journal(pid, active):
            journal_calls.append((pid, active))
            return True

        def spawn(job, argv, cwd, env):
            raise OSError("spawn failed")

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", spawn):
                with mock.patch.object(bash_module, "_record_journal", journal):
                    with mock.patch.object(
                        bash_module._winjob, "create_job", return_value=sentinel
                    ):
                        with mock.patch.object(bash_module._winjob, "close") as close:
                            with self.assertRaises(OSError):
                                bash("sleep 30")
        close.assert_called_once_with(sentinel)
        self.assertEqual(journal_calls, [])

    async def test_windows_watch_taskkill_fallback_runs_before_process_handle_close(self):
        # PID-reuse guard: every taskkill-by-pid must run before the handle closes.
        order = []
        spawned = []
        handle_box = []
        ready, closed_done = threading.Event(), threading.Event()

        def spawn(job, argv, cwd, env):
            proc = _win_spawn(spawned)(job, argv, cwd, env)

            def record_close():
                order.append(("proc-close", handle_box[0]._reaped))
                closed_done.set()

            proc.close = mock.Mock(side_effect=record_close)
            return proc

        def terminate(job):
            assert ready.wait(timeout=5)  # gate: handle_box is filled first
            order.append("terminate")
            return False

        def taskkill(pid):
            order.append(("taskkill", spawned[0].close.called))
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", spawn):
                with mock.patch.object(bash_module._winjob, "create_job", return_value=777):
                    with mock.patch.object(bash_module._winjob, "terminate", terminate):
                        with mock.patch.object(
                            bash_module._winjob, "close",
                            side_effect=lambda job: order.append("job-close"),
                        ):
                            with mock.patch.object(bash_module, "_taskkill_tree", taskkill):
                                handle = bash("echo hi")
                                handle_box.append(handle)
                                ready.set()
                                await asyncio.wait_for(handle, timeout=5)
                                self.assertTrue(await asyncio.to_thread(closed_done.wait, 5))
        self.assertEqual(
            order, ["terminate", "job-close", ("taskkill", False), ("proc-close", True)]
        )

    async def test_windows_kill_blocked_during_watch_reap_never_taskkills_after_close(self):
        # kill() blocked on the reap lock must become a no-op, never a raw-pid taskkill.
        spawned = []
        entered, release = threading.Event(), threading.Event()

        def spawn(job, argv, cwd, env):
            return _win_spawn(spawned)(job, argv, cwd, env)

        def terminate(job):
            entered.set()
            assert release.wait(timeout=10)
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", spawn):
                with mock.patch.object(bash_module._winjob, "create_job", return_value=778):
                    with mock.patch.object(
                        bash_module._winjob, "terminate", side_effect=terminate
                    ) as term:
                        with mock.patch.object(bash_module._winjob, "close"):
                            with mock.patch.object(bash_module, "_taskkill_tree") as taskkill:
                                handle = bash("echo hi")
                                await asyncio.wait_for(handle, timeout=5)
                                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                                fut = asyncio.get_running_loop().run_in_executor(
                                    None, handle.kill
                                )
                                await asyncio.sleep(0.2)
                                self.assertFalse(fut.done())  # blocked on the reap lock
                                taskkill.assert_not_called()
                                release.set()
                                await asyncio.wait_for(fut, timeout=5)
                                for _ in range(100):
                                    if handle._reaped:
                                        break
                                    await asyncio.sleep(0.05)
        taskkill.assert_not_called()
        term.assert_called_once()
        spawned[0].close.assert_called_once()
        self.assertTrue(handle._reaped)

    async def test_kill_live_handles_skips_reaped_windows_handle(self):
        stale = mock.Mock(_kill_lock=threading.Lock(), _reaped=True, _job=5, _pid=999)
        with bash_module._live_lock:
            bash_module._live_handles.add(stale)
        try:
            with mock.patch.object(bash_module, "_IS_POSIX", False):
                with mock.patch.object(bash_module._winjob, "terminate") as term:
                    with mock.patch.object(bash_module, "_taskkill_tree") as taskkill:
                        with mock.patch.object(bash_module, "_record_journal") as journal:
                            bash_module._kill_live_handles()
        finally:
            with bash_module._live_lock:
                bash_module._live_handles.discard(stale)
        term.assert_not_called()
        taskkill.assert_not_called()
        stale._proc.kill.assert_not_called()
        journal.assert_not_called()

    async def test_kill_live_handles_blocked_on_abort_never_taskkills_after_close(self):
        # PID-reuse guard on the abort path: abort's reaped+close section must block
        # on _kill_lock while a raw-pid taskkill is in flight, so the handle can
        # never close mid-taskkill.
        order = []
        spawned = []
        journal_calls = []
        entered, release_term = threading.Event(), threading.Event()
        stdout_entered, stdout_release = threading.Event(), threading.Event()
        tk_entered, tk_release = threading.Event(), threading.Event()

        def spawn(job, argv, cwd, env):
            proc = _win_spawn(spawned)(job, argv, cwd, env)
            proc.kill = mock.Mock()
            proc.close = mock.Mock(side_effect=lambda: order.append("proc-close"))
            real_stdout = proc.stdout

            def gated_close():
                # Parks abort between its two locked sections (lock released).
                stdout_entered.set()
                assert stdout_release.wait(timeout=10)
                real_stdout.close()

            proc.stdout = mock.Mock(close=mock.Mock(side_effect=gated_close))
            return proc

        def journal(pid, active):
            journal_calls.append((pid, active))
            return not active  # enrollment fails -> _abort_spawn; retirement succeeds

        def terminate(job):
            order.append("abort-terminate")
            entered.set()
            assert release_term.wait(timeout=10)
            return True

        def taskkill(pid):
            # Blocks INSIDE the killer's locked section: abort must wait on the lock.
            order.append(("killer-taskkill", spawned[0].close.called))
            tk_entered.set()
            assert tk_release.wait(timeout=10)
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        loop = asyncio.get_running_loop()
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", spawn):
                with mock.patch.object(bash_module._winjob, "create_job", return_value=900):
                    with mock.patch.object(
                        bash_module._winjob, "terminate", side_effect=terminate
                    ) as term:
                        with mock.patch.object(
                            bash_module._winjob, "close",
                            side_effect=lambda job: order.append("abort-jobclose"),
                        ):
                            with mock.patch.object(bash_module, "_record_journal", journal):
                                with mock.patch.object(
                                    bash_module, "_taskkill_tree", side_effect=taskkill
                                ):
                                    ctor = loop.run_in_executor(
                                        None, lambda: bash("echo hi")
                                    )
                                    self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                                    # Phase 1: abort holds _kill_lock -> the killer blocks.
                                    killer = loop.run_in_executor(
                                        None, bash_module._kill_live_handles
                                    )
                                    await asyncio.sleep(0.2)
                                    self.assertFalse(killer.done())
                                    self.assertFalse(tk_entered.is_set())
                                    # Phase 2: abort parks at stdout; the killer takes the
                                    # lock and blocks inside taskkill while holding it.
                                    release_term.set()
                                    self.assertTrue(
                                        await asyncio.to_thread(tk_entered.wait, 5)
                                    )
                                    stdout_release.set()
                                    # Abort finishes stdout/wait but must block on the
                                    # lock: close cannot run while taskkill is in flight.
                                    await asyncio.sleep(0.3)
                                    self.assertFalse(ctor.done())
                                    self.assertFalse(spawned[0].close.called)
                                    # Phase 3: taskkill returns, killer releases the lock,
                                    # abort's reaped+close section finally runs.
                                    tk_release.set()
                                    with self.assertRaisesRegex(RuntimeError, "journal"):
                                        await asyncio.wait_for(ctor, timeout=10)
                                    await asyncio.wait_for(killer, timeout=10)
        self.assertEqual(
            order,
            ["abort-terminate", "abort-jobclose", ("killer-taskkill", False), "proc-close"],
        )
        self.assertEqual(spawned[0].close.call_count, 1)  # once, only after taskkill returned
        term.assert_called_once()  # the killer saw _job None; no second terminate
        spawned[0].kill.assert_not_called()
        pid = spawned[0].pid
        self.assertEqual(journal_calls, [(pid, True), (pid, False), (pid, False)])

    async def test_windows_job_reap_and_kill(self):
        handle = bash("sleep 30")
        job = 777
        handle._job = job
        try:
            with mock.patch.object(bash_module, "_IS_POSIX", False):
                with mock.patch.object(bash_module, "_taskkill_tree") as taskkill:
                    with mock.patch.object(bash_module._winjob, "terminate", return_value=True) as term:
                        with mock.patch.object(bash_module._winjob, "close") as close:
                            with mock.patch.object(bash_module._winjob, "is_empty", return_value=False):
                                self.assertTrue(handle._group_alive())
                            with mock.patch.object(bash_module._winjob, "is_empty", return_value=True):
                                self.assertFalse(handle._group_alive())
                            handle.kill()
                            term.assert_called_once_with(job)
                            term.reset_mock()
                            # Reap terminates, closes the last handle, and
                            # retires the journal record (tree provably dead).
                            self.assertTrue(handle._reap_group())
                            term.assert_called_once_with(job)
                            close.assert_called_once_with(job)
                            self.assertIsNone(handle._job)
                            handle._reaped = True
                            handle.kill()  # job-reaped: no taskkill second chance
                    taskkill.assert_not_called()
        finally:
            handle._reaped = False
            handle._job = None
            handle.kill(signal.SIGKILL)
            await asyncio.wait_for(handle, timeout=5)

    async def test_windows_failed_job_terminate_falls_back_to_taskkill(self):
        handle = bash("sleep 30")
        job = 888
        handle._job = job
        try:
            with mock.patch.object(bash_module, "_IS_POSIX", False):
                with mock.patch.object(bash_module._winjob, "terminate", return_value=False):
                    with mock.patch.object(bash_module._winjob, "close") as close:
                        with mock.patch.object(
                            bash_module, "_taskkill_tree", return_value=True
                        ) as taskkill:
                            handle.kill()  # failed terminate must not strand the tree
                            taskkill.assert_called_once_with(handle._pid)
                            taskkill.reset_mock()
                            # Reap closes the handle anyway (a kill attempt) but
                            # only journals inactive via the taskkill result.
                            self.assertTrue(handle._reap_group())
                            close.assert_called_once_with(job)
                            taskkill.assert_called_once_with(handle._pid)
                            self.assertIsNone(handle._job)
        finally:
            handle._reaped = False
            handle._job = None
            handle.kill(signal.SIGKILL)
            await asyncio.wait_for(handle, timeout=5)

    async def test_windows_failed_terminate_and_taskkill_leaves_record_active(self):
        # Failed terminate + failed taskkill on an exited leader: nothing
        # proved the tree died, so the record stays active for the host reaper.
        handle = bash("echo hi")
        await asyncio.wait_for(handle, timeout=5)
        for _ in range(100):
            if handle._proc.poll() is not None:
                break
            await asyncio.sleep(0.05)
        self.assertIsNotNone(handle._proc.poll())
        handle._job = 999
        try:
            with mock.patch.object(bash_module, "_IS_POSIX", False):
                with mock.patch.object(bash_module._winjob, "terminate", return_value=False):
                    with mock.patch.object(bash_module._winjob, "close"):
                        with mock.patch.object(
                            bash_module, "_taskkill_tree", return_value=False
                        ):
                            self.assertFalse(handle._reap_group())
                            self.assertIsNone(handle._job)
        finally:
            handle._job = None

    def test_darwin_start_id_uses_absolute_ps(self):
        completed = mock.Mock(stdout="Mon Jan  1 00:00:00 2026\n")
        with mock.patch.object(bash_module.sys, "platform", "darwin"):
            with mock.patch("builtins.open", side_effect=OSError):
                with mock.patch.object(bash_module.subprocess, "run", return_value=completed) as run:
                    self.assertEqual(
                        bash_module._process_start_id(1234), "ps:Mon Jan  1 00:00:00 2026"
                    )
        self.assertEqual(run.call_args.args[0][0], "/bin/ps")

    async def test_undelivered_kill_leaves_journal_record_active(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX signal-delivery semantics")
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(
                os.environ,
                {
                    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                    "PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid()),
                },
            ):
                handle = bash("sleep 30")
                try:
                    records = await _poll_journal(journal, count=1)
                    self.assertTrue(records[-1]["active"])
                    with mock.patch.object(bash_module, "_signal_group", return_value=False):
                        bash_module._kill_live_handles()
                    await asyncio.sleep(0.2)  # give any (wrong) inactive write time to land
                    records = await _poll_journal(journal, count=1)
                    self.assertEqual(len(records), 1)
                    self.assertTrue(records[-1]["active"])
                finally:
                    handle.kill(signal.SIGKILL)
                    await asyncio.wait_for(handle, timeout=5)

    async def test_signal_group_reports_delivery(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX signal-delivery semantics")
        with mock.patch.object(bash_module.os, "killpg", side_effect=ProcessLookupError):
            self.assertTrue(bash_module._signal_group(1234567, signal.SIGKILL))
        with mock.patch.object(bash_module.os, "killpg", side_effect=PermissionError):
            self.assertFalse(bash_module._signal_group(1234567, signal.SIGKILL))
        with mock.patch.object(bash_module.os, "killpg", side_effect=OSError):
            self.assertFalse(bash_module._signal_group(1234567, signal.SIGKILL))

    async def test_journal_configured_but_unwritable_kills_child_and_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "marker")
            pids: list[int] = []
            real_popen = subprocess.Popen

            def capturing_popen(*args, **kwargs):
                proc = real_popen(*args, **kwargs)
                pids.append(proc.pid)
                return proc

            with mock.patch.dict(
                os.environ,
                {
                    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL": tmp,  # a directory: open fails
                    "PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid()),
                },
            ):
                with mock.patch.object(bash_module.subprocess, "Popen", capturing_popen):
                    with self.assertRaises(RuntimeError):
                        bash(f"touch {marker}")
            await _poll_group_dead(pids[0])
            await asyncio.sleep(0.2)
            self.assertFalse(os.path.exists(marker))
            with bash_module._live_lock:
                self.assertFalse(bash_module._live_handles)

    async def test_journal_bad_owner_pid_rejects(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(
                os.environ,
                {
                    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                    "PRIME_AGENT_KERNEL_OWNER_PID": "notanint",
                },
            ):
                with self.assertRaises(RuntimeError):
                    bash("echo hi")

    async def test_missing_start_id_rejects_when_configured(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(
                os.environ,
                {
                    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                    "PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid()),
                },
            ):
                with mock.patch.object(bash_module, "_process_start_id", return_value=None):
                    with self.assertRaises(RuntimeError):
                        bash("sleep 30")

    async def test_journal_short_write_rejects_when_configured(self):
        # A partial os.write would leave a truncated JSON line the host
        # discards; enrollment must treat it as failure.
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")

            def short_write(fd, data):
                return 0  # no progress

            with mock.patch.dict(
                os.environ,
                {
                    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                    "PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid()),
                },
            ):
                with mock.patch.object(bash_module.os, "write", short_write):
                    self.assertFalse(bash_module._record_journal(os.getpid(), active=False))

    async def test_journal_partial_writes_complete_the_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            real_write = os.write

            def partial_write(fd, data):
                # One byte at a time: the loop must still write the full record.
                return real_write(fd, bytes(data)[:1])

            with mock.patch.dict(
                os.environ,
                {
                    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                    "PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid()),
                },
            ):
                with mock.patch.object(bash_module.os, "write", partial_write):
                    self.assertTrue(bash_module._record_journal(os.getpid(), active=False))
            with open(journal) as f:
                record = json.loads(f.read())
            self.assertEqual(record["pid"], os.getpid())
            self.assertFalse(record["active"])

    async def test_unconfigured_journal_stays_permissive(self):
        # Permissiveness is about configuration, not start-id availability.
        with mock.patch.object(bash_module, "_process_start_id", return_value=None):
            result = await bash("echo ok")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("ok", result.output)


async def _poll_group_dead(pgid: int, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            pass  # transient teardown state on macOS
        await asyncio.sleep(0.05)
    raise AssertionError(f"process group {pgid} still alive after {timeout}s")


async def _poll_journal(path: str, count: int, timeout: float = 2.0) -> list[dict]:
    deadline = asyncio.get_running_loop().time() + timeout
    records: list[dict] = []
    while asyncio.get_running_loop().time() < deadline:
        with open(path) as f:
            records = [json.loads(line) for line in f if line.strip()]
        if len(records) >= count:
            return records
        await asyncio.sleep(0.05)
    return records


if __name__ == "__main__":
    unittest.main()
