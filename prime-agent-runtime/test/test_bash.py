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

    async def test_delivered_status_wins_when_shell_dies_during_drain(self):
        entered = threading.Event()
        release = threading.Event()
        original = bash_module.BashHandle._drain_grace

        def held_drain(handle_self):
            # Hold only the first caller (the reporter, which drains right after
            # reading status 0); any later caller must proceed normally.
            if not entered.is_set():
                entered.set()
                release.wait(10)
            original(handle_self)

        with mock.patch.object(bash_module.BashHandle, "_drain_grace", held_drain):
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
        handle = bash("sleep 30")
        try:
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
            script = bash_module._status_script(f"touch {marker}")
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
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module.shutil, "which", return_value=None):
                with self.assertRaisesRegex(RuntimeError, "PRIME_AGENT_BASH_SHELL"):
                    bash_module._shell()

    async def test_pump_paused_between_read_and_commit_does_not_lose_output(self):
        # Reviewer repro: the chunk is out of the pipe (FIONREAD 0) but not yet
        # in the buffer; the drain fence must wait for the commit.
        original_write = bash_module._BoundedBuffer.write
        delayed_once = threading.Event()

        def delayed_write(buffer_self, chunk):
            if not delayed_once.is_set():
                delayed_once.set()
                time.sleep(0.3)
            original_write(buffer_self, chunk)

        with mock.patch.object(bash_module._BoundedBuffer, "write", delayed_write):
            result = await asyncio.wait_for(bash("printf between-read-and-write"), timeout=5)
        self.assertEqual(result.exit_code, 0)
        self.assertIn("between-read-and-write", result.output)

    async def test_slow_pump_does_not_lose_foreground_output(self):
        # A descheduled pump must not let _drain_grace conclude quiescence
        # while the shell's output still sits unread in the pipe.
        original_pump = bash_module.BashHandle._pump

        def slow_pump(handle_self):
            time.sleep(0.3)
            original_pump(handle_self)

        with mock.patch.object(bash_module.BashHandle, "_pump", slow_pump):
            result = await asyncio.wait_for(bash("printf slow-pump-x"), timeout=5)
        self.assertEqual(result.exit_code, 0)
        self.assertIn("slow-pump-x", result.output)

    async def test_relative_bash_shell_override_rejected(self):
        with mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "bash"}):
            with self.assertRaises(ValueError):
                bash("echo hi")

    async def test_windows_reap_and_reaped_kill_use_taskkill(self):
        handle = bash("echo hi")
        await asyncio.wait_for(handle, timeout=5)
        for _ in range(100):
            if handle._reaped:
                break
            await asyncio.sleep(0.05)
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module, "_taskkill_tree") as taskkill:
                handle.kill()  # already reaped: best-effort retry, no no-op
                taskkill.assert_called_once_with(handle._pid)
                taskkill.reset_mock()
                handle._reap_group()  # watcher path: taskkill before marking reaped
                taskkill.assert_called_once_with(handle._pid)

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
