from __future__ import annotations

import asyncio
import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

SRC = os.path.join(os.path.dirname(__file__), "..", "src")

_EOF = object()


class ReplProcess:
    """Drives one `python -m rlm.repl` subprocess over the JSON-lines protocol."""

    def __init__(self, env: dict[str, str] | None = None) -> None:
        env = {
            **os.environ,
            "PYTHONPATH": SRC + os.pathsep + os.environ.get("PYTHONPATH", ""),
            **(env or {}),
        }
        self.spawned_at = time.monotonic()
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "rlm.repl"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=env,
        )
        self.raw_lines: list[str] = []
        self._lines: queue.Queue[object] = queue.Queue()
        threading.Thread(target=self._read_lines, daemon=True).start()

    def _read_lines(self) -> None:
        assert self.proc.stdout is not None
        try:
            for line in self.proc.stdout:
                self._lines.put(line)
        except ValueError:
            pass  # stdout closed by close() while the thread was blocked on it
        self._lines.put(_EOF)

    def read_event(self, timeout: float = 30.0) -> dict:
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError("timed out waiting for a protocol event") from None
        if line is _EOF:
            raise EOFError("runtime closed its protocol stream")
        assert isinstance(line, str)
        self.raw_lines.append(line)
        return json.loads(line)

    def ready(self) -> tuple[dict, float]:
        event = self.read_event()
        return event, (time.monotonic() - self.spawned_at) * 1000

    def send(self, request: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()

    def send_raw(self, line: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def execute(self, rid: str, code: str) -> list[dict]:
        self.send({"type": "execute", "id": rid, "code": code})
        return self.until_done(rid)

    def until_done(self, rid: str) -> list[dict]:
        events = []
        while True:
            event = self.read_event()
            events.append(event)
            if event.get("event") == "done" and event.get("id") == rid:
                return events

    def shutdown(self) -> int:
        self.send({"type": "shutdown", "id": "__shutdown__"})
        self.until_done("__shutdown__")
        return self.proc.wait(timeout=10)

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=10)
        for stream in (self.proc.stdin, self.proc.stdout):
            if stream is not None:
                stream.close()


def stream_text(events: list[dict], stream: str) -> str:
    return "".join(e["text"] for e in events if e.get("event") == stream)


def one(events: list[dict], kind: str) -> dict | None:
    matches = [e for e in events if e.get("event") == kind]
    return matches[0] if matches else None


class ReplTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repl = ReplProcess()
        self.addCleanup(self.repl.close)
        self.ready_event, self.ready_ms = self.repl.ready()

    def test_ready_handshake_and_startup_time(self):
        self.assertEqual(self.ready_event["event"], "ready")
        self.assertEqual(self.ready_event["protocol"], 3)
        major, minor = sys.version_info[:2]
        self.assertTrue(self.ready_event["python"].startswith(f"{major}.{minor}."))
        # Loose bound for loaded CI machines; still catches an order-of-magnitude regression.
        print(f"\n[startup] spawn -> ready: {self.ready_ms:.0f} ms")
        self.assertLess(self.ready_ms, 500)

    def test_result_echo(self):
        events = self.repl.execute("a", "1+1")
        self.assertEqual(one(events, "result")["text"], "2")
        self.assertEqual(one(events, "done")["status"], "ok")

        events = self.repl.execute("b", "x = 5")
        self.assertIsNone(one(events, "result"))

        events = self.repl.execute("c", "None")
        self.assertIsNone(one(events, "result"))

        events = self.repl.execute("d", "_ + 40")
        self.assertEqual(one(events, "result")["text"], "42")

    def test_stdout_stderr_and_direct_fd_writes(self):
        code = "\n".join(
            [
                "import os, sys",
                "print('py-out')",
                "sys.stderr.write('py-err\\n')",
                "os.write(1, b'fd-out\\n')",
                "os.write(2, b'fd-err\\n')",
            ]
        )
        events = self.repl.execute("io", code)
        out = stream_text(events, "stdout")
        err = stream_text(events, "stderr")
        self.assertIn("py-out", out)
        self.assertIn("fd-out", out)
        self.assertIn("py-err", err)
        self.assertIn("fd-err", err)
        # Python-level writes carry the cell id; raw fd bytes are never attributed.
        for event in events:
            if event.get("event") not in ("stdout", "stderr"):
                continue
            if "py-" in event["text"]:
                self.assertEqual(event["id"], "io")
            if "fd-" in event["text"]:
                self.assertIsNone(event["id"])
        # done arrives last, after every byte the cell wrote.
        self.assertEqual(events[-1]["event"], "done")

    def test_top_level_await(self):
        events = self.repl.execute("tla", "import asyncio\nawait asyncio.sleep(0)\n'ok'")
        self.assertEqual(one(events, "result")["text"], "'ok'")
        self.assertEqual(one(events, "done")["status"], "ok")

    def test_background_task_persists_across_cells(self):
        setup = "\n".join(
            [
                "import asyncio",
                "acc = []",
                "async def tick():",
                "    while True:",
                "        acc.append(1)",
                "        await asyncio.sleep(0.01)",
                "task = asyncio.create_task(tick())",
            ]
        )
        self.assertEqual(one(self.repl.execute("bg1", setup), "done")["status"], "ok")
        events = self.repl.execute("bg2", "import asyncio\nawait asyncio.sleep(0.2)\nlen(acc)")
        count = int(one(events, "result")["text"])
        self.assertGreater(count, 1)
        events = self.repl.execute("bg3", "task.cancel()\nimport asyncio\nawait asyncio.sleep(0.05)\nlen(acc)")
        self.assertEqual(one(events, "done")["status"], "ok")

    def test_output_after_done_carries_null_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            trigger = os.path.join(tmp, "go")
            code = "\n".join(
                [
                    "import os, threading, time",
                    "def late():",
                    f"    while not os.path.exists({trigger!r}):",
                    "        time.sleep(0.01)",
                    "    print('late-output', flush=True)",
                    "threading.Thread(target=late, daemon=True).start()",
                ]
            )
            events = self.repl.execute("late", code)
            self.assertEqual(one(events, "done")["status"], "ok")
            # `done` is the last event carrying this cell's id.
            tagged = [e for e in events if e.get("id") == "late"]
            self.assertEqual(tagged[-1]["event"], "done")
            # Release the background writer only after `done` was observed; its
            # between-cell output must be emitted with a null id.
            with open(trigger, "w"):
                pass
            deadline = time.monotonic() + 5
            late_events: list[dict] = []
            while time.monotonic() < deadline:
                try:
                    event = self.repl.read_event(timeout=0.5)
                except TimeoutError:
                    continue
                late_events.append(event)
                if event.get("event") == "stdout" and "late-output" in event["text"]:
                    break
            self.assertIn("late-output", stream_text(late_events, "stdout"))
            for event in late_events:
                self.assertIsNone(event.get("id"))

    def test_background_thread_and_fd_output_during_later_cell_is_null(self):
        # Cross-cell misattribution repro: a thread and a direct fd write from
        # cell1 land while cell2 runs; neither may carry cell2's id.
        code = "\n".join(
            [
                "import os, threading, time",
                "def late_print():",
                "    time.sleep(0.6)",
                "    print('SECRET-py', flush=True)",
                "def late_fd():",
                "    time.sleep(0.7)",
                "    os.write(1, b'SECRET-fd\\n')",
                "threading.Thread(target=late_print, daemon=True).start()",
                "threading.Thread(target=late_fd, daemon=True).start()",
            ]
        )
        events = self.repl.execute("cell1", code)
        self.assertEqual(one(events, "done")["status"], "ok")
        events = self.repl.execute("cell2", "import time\ntime.sleep(1.2)")
        self.assertEqual(one(events, "done")["status"], "ok")
        # The SECRET lines may land during cell2 or right after; scan until both seen.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            text = stream_text(events, "stdout")
            if "SECRET-py" in text and "SECRET-fd" in text:
                break
            try:
                events.append(self.repl.read_event(timeout=0.5))
            except TimeoutError:
                continue
        for event in events:
            if event.get("event") == "stdout" and "SECRET" in event["text"]:
                self.assertIsNone(event["id"])
        text = stream_text(events, "stdout")
        self.assertIn("SECRET-py", text)
        self.assertIn("SECRET-fd", text)

    def test_cell_own_direct_fd_write_is_null_but_arrives_before_done(self):
        events = self.repl.execute("rawfd", "import os\nos.write(1, b'raw\\n')\nprint('tagged')")
        done_index = next(i for i, e in enumerate(events) if e.get("event") == "done")
        raw = next(e for e in events if e.get("event") == "stdout" and "raw" in e["text"])
        self.assertIsNone(raw["id"])
        self.assertLess(events.index(raw), done_index)
        tagged = next(e for e in events if e.get("event") == "stdout" and "tagged" in e["text"])
        self.assertEqual(tagged["id"], "rawfd")

    def test_drain_finalizes_incomplete_raw_utf8_before_done(self):
        first = self.repl.execute("partial-utf8", "import os\nos.write(1, b'\\xe2\\x82')")
        replacement = next(e for e in first if e.get("event") == "stdout")
        self.assertEqual(replacement["text"], "\ufffd")
        self.assertLess(first.index(replacement), first.index(one(first, "done")))

        second = self.repl.execute("continuation-utf8", "os.write(1, b'\\xac')")
        self.assertEqual(stream_text(second, "stdout"), "\ufffd")
        self.assertNotIn("€", stream_text(second, "stdout"))

    def test_hostile_deeply_nested_json_line_does_not_kill_reader(self):
        # json.loads raises RecursionError on pathological nesting; the reader
        # thread must survive and keep serving.
        self.repl.send_raw("[" * 100_000)
        error = self.repl.read_event()
        self.assertEqual(error["event"], "error")
        self.assertEqual(error["ename"], "ProtocolError")
        follow = self.repl.execute("after-hostile", "1+1")
        self.assertEqual(one(follow, "result")["text"], "2")
        self.assertEqual(one(follow, "done")["status"], "ok")

    def test_unhashable_request_type_does_not_kill_reader(self):
        self.repl.send({"type": []})
        error = self.repl.read_event()
        self.assertEqual(error["event"], "error")
        self.assertEqual(error["ename"], "ProtocolError")
        self.repl.send({"type": {"x": 1}, "id": 5})
        error = self.repl.read_event()
        self.assertEqual(error["ename"], "ProtocolError")
        follow = self.repl.execute("after-unhashable", "1+1")
        self.assertEqual(one(follow, "result")["text"], "2")
        self.assertEqual(one(follow, "done")["status"], "ok")

    def test_duplicate_inflight_id_rejected_and_original_still_interruptible(self):
        self.repl.send({"type": "execute", "id": "dup", "code": "import time\nwhile True:\n    time.sleep(0.05)"})
        time.sleep(0.3)
        self.repl.send({"type": "execute", "id": "dup", "code": "print('imposter')"})
        error = self.repl.read_event()
        self.assertEqual(error["event"], "error")
        self.assertEqual(error["ename"], "ProtocolError")
        self.assertIn("duplicate", error["evalue"])
        # The original request is unaffected and its targeted interrupt still lands.
        self.repl.send({"type": "interrupt", "id": "dup"})
        events = self.repl.until_done("dup")
        self.assertEqual(one(events, "error")["ename"], "KeyboardInterrupt")
        self.assertEqual(one(events, "done")["status"], "error")
        self.assertNotIn("imposter", stream_text(events, "stdout"))
        follow = self.repl.execute("after-dup", "1+1")
        self.assertEqual(one(follow, "result")["text"], "2")

    def test_large_buffer_write_survives_short_pipe_writes(self):
        # 256 KiB exceeds the 64 KiB pipe capacity; the binary proxy must loop
        # until every byte is written.
        code = "\n".join(
            [
                "import sys",
                "n = sys.stdout.buffer.write(b'x' * 262144)",
                "sys.stdout.buffer.flush()",
                "print('wrote', n)",
            ]
        )
        events = self.repl.execute("bigbuf", code)
        self.assertEqual(one(events, "done")["status"], "ok")
        raw = "".join(
            e["text"] for e in events if e.get("event") == "stdout" and e.get("id") is None
        )
        self.assertEqual(raw.count("x"), 262144)
        # Cross-channel ordering is not guaranteed: raw x-chunks may interleave
        # between print()'s tagged fragments, so join only the tagged channel.
        tagged = "".join(
            e["text"] for e in events if e.get("event") == "stdout" and e.get("id") == "bigbuf"
        )
        self.assertIn("wrote 262144", tagged)

    def test_interrupt_without_pthread_kill_cancels_awaited_cell(self):
        # Windows fallback seam: with pthread_kill absent the reader cancels
        # the active task on the loop; an await-suspended cell still interrupts.
        code = "\n".join(
            [
                "import signal",
                "if hasattr(signal, 'pthread_kill'):",
                "    del signal.pthread_kill",
                "import asyncio",
                "await asyncio.sleep(30)",
            ]
        )
        self.repl.send({"type": "execute", "id": "nokill", "code": code})
        time.sleep(0.4)
        self.repl.send({"type": "interrupt"})
        events = self.repl.until_done("nokill")
        error = one(events, "error")
        self.assertEqual(error["ename"], "KeyboardInterrupt")
        self.assertEqual(one(events, "done")["status"], "error")

    def test_stdout_buffer_write_works_and_surfaces_as_null(self):
        # Libraries write bytes via sys.stdout.buffer; the tagged writer must
        # expose a working buffer whose bytes surface (null-attributed) before done.
        events = self.repl.execute(
            "bufw", "import sys\nsys.stdout.buffer.write(b'buffer-bytes\\n')\nsys.stdout.buffer.flush()"
        )
        self.assertEqual(one(events, "done")["status"], "ok")
        buffered = next(e for e in events if e.get("event") == "stdout" and "buffer-bytes" in e["text"])
        self.assertIsNone(buffered["id"])
        self.assertLess(events.index(buffered), events.index(one(events, "done")))

    def test_stdout_buffer_write_rejects_int(self):
        # A real stdout.buffer raises TypeError for ints; bytes(5) would emit five NULs.
        events = self.repl.execute("bufint", "import sys\nsys.stdout.buffer.write(5)")
        self.assertEqual(one(events, "error")["ename"], "TypeError")
        self.assertEqual(one(events, "done")["status"], "error")

    def test_asyncio_task_output_keeps_spawning_cell_id(self):
        code = "\n".join(
            [
                "import asyncio",
                "async def late():",
                "    await asyncio.sleep(0.3)",
                "    print('task-output', flush=True)",
                "_t = asyncio.create_task(late())",
            ]
        )
        events = self.repl.execute("spawn", code)
        self.assertEqual(one(events, "done")["status"], "ok")
        events = self.repl.execute("next", "import asyncio\nawait asyncio.sleep(0.6)")
        late = next(e for e in events if e.get("event") == "stdout" and "task-output" in e["text"])
        self.assertEqual(late["id"], "spawn")

    def test_interrupted_await_bash_leaves_no_side_effects(self):
        # One-shot `await bash(...)` (the %%bash-rewrite pattern) must not leak
        # the command past an interrupt.
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "marker")
            code = f"from rlm import bash\nr = await bash('sleep 1.5 && touch {marker}')"
            self.repl.send({"type": "execute", "id": "ibash", "code": code})
            time.sleep(0.4)
            self.repl.send({"type": "interrupt"})
            events = self.repl.until_done("ibash")
            error = one(events, "error")
            self.assertEqual(error["ename"], "KeyboardInterrupt")
            self.assertEqual(one(events, "done")["status"], "error")
            time.sleep(1.6)
            self.assertFalse(os.path.exists(marker))

    def _interrupt_after_running(self, rid: str, code: str) -> list[dict]:
        self.repl.send({"type": "execute", "id": rid, "code": code})
        # Give the cell time to enter its blocking region before interrupting.
        time.sleep(0.4)
        self.repl.send({"type": "interrupt"})
        return self.repl.until_done(rid)

    def test_interrupt_sync_blocking(self):
        events = self._interrupt_after_running(
            "sync", "import time\nwhile True:\n    time.sleep(0.05)"
        )
        error = one(events, "error")
        self.assertEqual(error["ename"], "KeyboardInterrupt")
        self.assertNotIn("repl.py", "".join(error["traceback"]))
        self.assertEqual(one(events, "done")["status"], "error")
        follow = self.repl.execute("after-sync", "1+1")
        self.assertEqual(one(follow, "result")["text"], "2")

    def test_interrupt_survives_cell_rebinding_sigint(self):
        # A cell that ignores SIGINT must not break protocol interrupts for later cells.
        events = self.repl.execute(
            "rebind", "import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)"
        )
        self.assertEqual(one(events, "done")["status"], "ok")
        events = self._interrupt_after_running(
            "sync-after-rebind", "import time\nwhile True:\n    time.sleep(0.05)"
        )
        error = one(events, "error")
        self.assertEqual(error["ename"], "KeyboardInterrupt")
        self.assertEqual(one(events, "done")["status"], "error")
        follow = self.repl.execute("after-rebind", "5+5")
        self.assertEqual(one(follow, "result")["text"], "10")

    def test_interrupt_await_suspended(self):
        events = self._interrupt_after_running(
            "await", "import asyncio\nawait asyncio.sleep(1e9)"
        )
        error = one(events, "error")
        self.assertEqual(error["ename"], "KeyboardInterrupt")
        self.assertIn("await asyncio.sleep(1e9)", "".join(error["traceback"]))
        self.assertEqual(one(events, "done")["status"], "error")
        follow = self.repl.execute("after-await", "2+2")
        self.assertEqual(one(follow, "result")["text"], "4")

    def test_interrupt_sync_blocked_in_selectors(self):
        events = self._interrupt_after_running(
            "sel", "import selectors\ns = selectors.DefaultSelector()\ns.select()"
        )
        error = one(events, "error")
        self.assertEqual(error["ename"], "KeyboardInterrupt")
        self.assertNotIn("repl.py", "".join(error["traceback"]))
        self.assertEqual(one(events, "done")["status"], "error")
        follow = self.repl.execute("after-sel", "3+3")
        self.assertEqual(one(follow, "result")["text"], "6")

    def test_interrupt_await_with_loop_hogging_background_task(self):
        # A sync-blocked background task hogs the only thread; the interrupt kills it
        # so the foreground cancel can take effect.
        code = "\n".join(
            [
                "import asyncio, time",
                "async def hog():",
                "    while True:",
                "        time.sleep(0.05)",
                "hog_task = asyncio.create_task(hog())",
                "await asyncio.sleep(1e9)",
            ]
        )
        events = self._interrupt_after_running("fg", code)
        error = one(events, "error")
        self.assertEqual(error["ename"], "KeyboardInterrupt")
        self.assertEqual(one(events, "done")["status"], "error")
        follow = self.repl.execute("hog-fate", "type(hog_task.exception()).__name__")
        self.assertEqual(one(follow, "result")["text"], "'KeyboardInterrupt'")
        follow = self.repl.execute("after-hog", "7+7")
        self.assertEqual(one(follow, "result")["text"], "14")

    def test_interrupt_written_back_to_back_with_execute(self):
        execute = json.dumps({"type": "execute", "id": "race", "code": "import asyncio\nawait asyncio.sleep(1e9)"})
        interrupt = json.dumps({"type": "interrupt"})
        assert self.repl.proc.stdin is not None
        self.repl.proc.stdin.write(execute + "\n" + interrupt + "\n")
        self.repl.proc.stdin.flush()
        events = self.repl.until_done("race")
        error = one(events, "error")
        self.assertEqual(error["ename"], "KeyboardInterrupt")
        self.assertEqual(one(events, "done")["status"], "error")
        follow = self.repl.execute("after-race", "5+5")
        self.assertEqual(one(follow, "result")["text"], "10")

    def test_stale_target_from_finished_interrupt_ignores_later_sigint_on_reused_id(self):
        # A targeted interrupt completes "reuse"; a later request reusing the id
        # must not be cancelled by a delayed/external SIGINT that only matches
        # the stale target of the finished request.
        events = self._interrupt_after_running("reuse", "import time\nwhile True:\n    time.sleep(0.05)")
        self.assertEqual(one(events, "error")["ename"], "KeyboardInterrupt")
        self.repl.send({"type": "execute", "id": "reuse", "code": "import time\ntime.sleep(1.5)\nprint('survived')"})
        time.sleep(0.4)  # let the cell enter its sleep before the stray SIGINT
        os.kill(self.repl.proc.pid, signal.SIGINT)
        events = self.repl.until_done("reuse")
        self.assertIsNone(one(events, "error"))
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertIn("survived", stream_text(events, "stdout"))

    def test_interrupt_during_slow_repr_cancels_finishing_request(self):
        # The cell body finishes instantly; the interrupt lands while the
        # trailing-expression repr is sleeping (post-run finishing window).
        code = "\n".join(
            [
                "import time",
                "class SlowRepr:",
                "    def __repr__(self):",
                "        time.sleep(600)",
                "        return 'late'",
                "SlowRepr()",
            ]
        )
        events = self._interrupt_after_running("slowrepr", code)
        error = one(events, "error")
        self.assertEqual(error["ename"], "KeyboardInterrupt")
        self.assertEqual(one(events, "done")["status"], "error")
        follow = self.repl.execute("after-slowrepr", "1+1")
        self.assertEqual(one(follow, "result")["text"], "2")

    def test_traceback_clean_with_source_line(self):
        code = "def boom():\n    raise ValueError('nope')\nboom()"
        events = self.repl.execute("tb", code)
        error = one(events, "error")
        self.assertEqual(error["ename"], "ValueError")
        self.assertEqual(error["evalue"], "nope")
        text = "".join(error["traceback"])
        self.assertIn("<cell-", text)
        self.assertIn("raise ValueError('nope')", text)
        self.assertNotIn("repl.py", text)
        self.assertNotIn("\x1b[", text)

    def test_syntax_error(self):
        events = self.repl.execute("syn", "def broken(:\n    pass")
        error = one(events, "error")
        self.assertEqual(error["ename"], "SyntaxError")
        text = "".join(error["traceback"])
        self.assertIn("<cell-", text)
        self.assertNotIn("repl.py", text)
        self.assertNotIn("ast.py", text)
        self.assertEqual(one(events, "done")["status"], "error")

    def test_snapshot_restore_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "kernel-state.dill")
            manifest_path = os.path.join(tmp, "kernel-state.json")
            setup = "\n".join(
                [
                    "import socket",
                    "x = 41",
                    "def bump(n):",
                    "    return n + 1",
                    "sock = socket.socket()",
                ]
            )
            self.assertEqual(one(self.repl.execute("s1", setup), "done")["status"], "ok")
            self.repl.send({"type": "snapshot", "id": "s2", "path": path, "manifest_path": manifest_path})
            done = one(self.repl.until_done("s2"), "done")
            self.assertEqual(done["status"], "ok")
            self.assertEqual(sorted(done["saved"]), ["bump", "socket", "x"])
            self.assertEqual([s["name"] for s in done["skipped"]], ["sock"])
            self.assertNotIn("asyncio", done["saved"])
            self.assertEqual(
                sorted(os.listdir(tmp)), ["kernel-state.dill", "kernel-state.json"]
            )  # no temp files survive a successful commit
            with open(manifest_path) as fh:
                manifest = json.load(fh)
            self.assertEqual(manifest["version"], 1)
            self.assertEqual(manifest["savedNames"], done["saved"])
            self.assertEqual(manifest["bytes"], done["bytes"])
            self.assertIn("pythonVersion", manifest)
            self.assertIn("timestamp", manifest)

            fresh = ReplProcess()
            self.addCleanup(fresh.close)
            fresh.ready()
            fresh.send({"type": "restore", "id": "r1", "path": path})
            done = one(fresh.until_done("r1"), "done")
            self.assertEqual(done["status"], "ok")
            self.assertEqual(sorted(done["restored"]), ["bump", "socket", "x"])
            events = fresh.execute("r2", "bump(x)")
            self.assertEqual(one(events, "result")["text"], "42")
            self.assertEqual(fresh.shutdown(), 0)

    def test_restore_skips_ipython_injected_names(self):
        import dill

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "kernel-state.dill")
            payload = {
                "kept": dill.dumps(7),
                "In": dill.dumps(["cell"]),
                "Out": dill.dumps({1: "x"}),
                "get_ipython": dill.dumps(None),
            }
            with open(path, "wb") as fh:
                dill.dump(payload, fh)
            self.repl.send({"type": "restore", "id": "r", "path": path})
            done = one(self.repl.until_done("r"), "done")
            self.assertEqual(done["status"], "ok")
            self.assertEqual(done["restored"], ["kept"])
            events = self.repl.execute("chk", "'In' in dir()")
            self.assertEqual(one(events, "result")["text"], "False")

    def test_snapshot_prune_oversized(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "kernel-state.dill")
            manifest_path = os.path.join(tmp, "kernel-state.json")
            self.repl.execute("p1", "small = 1\nbig = b'x' * 100_000")
            self.repl.send(
                {
                    "type": "snapshot",
                    "id": "p2",
                    "path": path,
                    "manifest_path": manifest_path,
                    "max_variable_bytes": 1024,
                    "prune_oversized": True,
                }
            )
            done = one(self.repl.until_done("p2"), "done")
            self.assertEqual(done["status"], "ok")
            self.assertEqual(done["saved"], ["small"])
            self.assertEqual(done["pruned"], ["big"])
            events = self.repl.execute("p3", "'big' in dir()")
            self.assertEqual(one(events, "result")["text"], "False")

    def test_emit_display(self):
        payloads = {
            "application/vnd.prime-agent.diff+json": {
                "path": "/tmp/file.py",
                "old_str": "a",
                "new_str": "b",
                "start_line": 3,
            },
            "application/vnd.prime-agent.attachment+json": {
                "mime_type": "image/png",
                "data": "aGVsbG8=",
                "path": "/tmp/img.png",
            },
            "application/vnd.prime-agent.agent-message+json": {
                "id": "agentmsg_1",
                "message": "hi",
                "deliveryStatus": "delivered",
                "receiverRole": "parent",
                "target": {"sessionId": "s1"},
            },
        }
        for i, (mime, payload) in enumerate(payloads.items()):
            code = "\n".join(
                [
                    "from rlm.repl import emit",
                    f"emit({{ {mime!r}: {payload!r}, 'text/plain': 'label' }})",
                ]
            )
            events = self.repl.execute(f"emit{i}", code)
            display = one(events, "display")
            self.assertIsNotNone(display)
            self.assertEqual(display["data"][mime], payload)
            self.assertEqual(display["data"]["text/plain"], "label")
            self.assertEqual(display["id"], f"emit{i}")

    def test_emit_nan_payload_errors_in_cell_and_keeps_framing(self):
        # NaN would serialize as non-JSON text and tear protocol framing;
        # emit() must raise in the caller's cell instead.
        code = "from rlm.repl import emit\nemit({'application/json': float('nan')})"
        events = self.repl.execute("emit-nan", code)
        self.assertEqual(one(events, "error")["ename"], "ValueError")
        self.assertEqual(one(events, "done")["status"], "error")
        self.assertIsNone(one(events, "display"))
        follow = self.repl.execute("after-emit-nan", "1+1")
        self.assertEqual(one(follow, "result")["text"], "2")
        self.assertEqual(one(follow, "done")["status"], "ok")

    def test_bash_integration(self):
        events = self.repl.execute(
            "sh1", "from rlm import bash\nresult = await bash('echo repl-bash')\nresult.output.strip()"
        )
        self.assertEqual(one(events, "result")["text"], "'repl-bash'")

        events = self.repl.execute(
            "sh2", "handle = bash('sleep 600')\nhandle.pid"
        )
        pid = int(one(events, "result")["text"])
        self.assertEqual(self.repl.shutdown(), 0)
        # Shutdown kills live bash process groups; the sleep must be gone.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
        self.fail(f"bash child {pid} survived runtime shutdown")

    def test_protocol_framing_under_noise(self):
        setup = "\n".join(
            [
                "import os, threading",
                "stop = threading.Event()",
                "def spam():",
                "    while not stop.is_set():",
                "        os.write(1, b'noise-' * 64 + b'\\n')",
                "threading.Thread(target=spam, daemon=True).start()",
            ]
        )
        self.assertEqual(one(self.repl.execute("n0", setup), "done")["status"], "ok")
        for i in range(5):
            events = self.repl.execute(f"n{i + 1}", f"{i} * 10")
            self.assertEqual(one(events, "result")["text"], str(i * 10))
        self.repl.execute("n-stop", "stop.set()")
        # Every protocol line parsed as JSON (until_done would have raised
        # otherwise); noise text only ever arrived inside stdout events.
        for line in self.repl.raw_lines:
            event = json.loads(line)
            if "noise-" in line:
                self.assertEqual(event["event"], "stdout")

    def test_malformed_request_line(self):
        self.repl.send_raw("{not json")
        event = self.repl.read_event()
        self.assertEqual(event["event"], "error")
        self.assertEqual(event["ename"], "ProtocolError")
        self.assertIsNone(event["id"])
        events = self.repl.execute("ok", "'alive'")
        self.assertEqual(one(events, "result")["text"], "'alive'")

    def test_list_names(self):
        self.repl.execute("ln1", "alpha = 1\ndef helper(n):\n    return n\n_hidden = 2\nrlm = object()")
        self.repl.send({"type": "list_names", "id": "ln2"})
        done = one(self.repl.until_done("ln2"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertIn("alpha", done["names"])
        self.assertIn("helper", done["names"])
        self.assertNotIn("_hidden", done["names"])
        self.assertNotIn("rlm", done["names"])
        self.assertEqual(done["names"], sorted(done["names"]))

    def test_list_names_skips_non_string_keys(self):
        self.repl.execute("lnk1", "globals()[1] = 1\nbeta = 2")
        self.repl.send({"type": "list_names", "id": "lnk2"})
        done = one(self.repl.until_done("lnk2"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertIn("beta", done["names"])
        self.assertNotIn(1, done["names"])
        events = self.repl.execute("lnk3", "'alive'")
        self.assertEqual(one(events, "result")["text"], "'alive'")

    def test_host_request_round_trip(self):
        code = "\n".join(
            [
                "from rlm.repl import host_request",
                "reply = await host_request({'type': 'demo', 'value': 7})",
                "reply",
            ]
        )
        self.repl.send({"type": "execute", "id": "hr", "code": code})
        request = self.repl.read_event()
        while request.get("event") != "host_request":
            request = self.repl.read_event()
        self.assertEqual(request["data"], {"type": "demo", "value": 7})
        envelope = {"status": "ok", "result": {"status": "weird", "answer": 42}}
        self.repl.send({"type": "host_reply", "id": request["id"], "data": envelope})
        events = self.repl.until_done("hr")
        self.assertEqual(one(events, "result")["text"], repr(envelope))
        self.assertEqual(one(events, "done")["status"], "ok")

    def test_typed_host_request_unwraps_exact_handler_result(self):
        code = "\n".join(
            [
                "from rlm import host_request",
                "reply = await host_request('demo')",
                "reply",
            ]
        )
        self.repl.send({"type": "execute", "id": "typed-hr", "code": code})
        request = self.repl.read_event()
        while request.get("event") != "host_request":
            request = self.repl.read_event()
        handler_result = {"status": "weird", "answer": 42}
        self.repl.send(
            {
                "type": "host_reply",
                "id": request["id"],
                "data": {"status": "ok", "result": handler_result},
            }
        )
        events = self.repl.until_done("typed-hr")
        self.assertEqual(one(events, "result")["text"], repr(handler_result))
        self.assertEqual(one(events, "done")["status"], "ok")

    def test_typed_host_request_raises_host_error(self):
        code = "from rlm import host_request\nawait host_request('demo')"
        self.repl.send({"type": "execute", "id": "typed-error", "code": code})
        request = self.repl.read_event()
        while request.get("event") != "host_request":
            request = self.repl.read_event()
        self.repl.send(
            {
                "type": "host_reply",
                "id": request["id"],
                "data": {"status": "error", "error": "handler exploded"},
            }
        )
        events = self.repl.until_done("typed-error")
        self.assertEqual(one(events, "error")["ename"], "RuntimeError")
        self.assertEqual(one(events, "error")["evalue"], "handler exploded")
        self.assertEqual(one(events, "done")["status"], "error")

    def test_typed_host_request_rejects_unexpected_envelope_status(self):
        code = "from rlm import host_request\nawait host_request('demo')"
        self.repl.send({"type": "execute", "id": "typed-unexpected", "code": code})
        request = self.repl.read_event()
        while request.get("event") != "host_request":
            request = self.repl.read_event()
        self.repl.send(
            {
                "type": "host_reply",
                "id": request["id"],
                "data": {"status": "partial", "result": {}},
            }
        )
        events = self.repl.until_done("typed-unexpected")
        self.assertEqual(one(events, "error")["ename"], "RuntimeError")
        self.assertEqual(
            one(events, "error")["evalue"],
            "host request demo returned unexpected status: 'partial'",
        )
        self.assertEqual(one(events, "done")["status"], "error")

    def test_host_reply_for_unknown_id_dropped(self):
        self.repl.send({"type": "host_reply", "id": "no-such-request", "data": {"status": "ok"}})
        events = self.repl.execute("ok", "'alive'")
        self.assertEqual(one(events, "result")["text"], "'alive'")

    def test_host_request_cancelled_cell_drops_pending_future(self):
        code = "\n".join(
            [
                "from rlm.repl import host_request",
                "await host_request({'type': 'never-answered'})",
            ]
        )
        self.repl.send({"type": "execute", "id": "hr-cancel", "code": code})
        request = self.repl.read_event()
        while request.get("event") != "host_request":
            request = self.repl.read_event()
        self.repl.send({"type": "interrupt"})
        events = self.repl.until_done("hr-cancel")
        self.assertEqual(one(events, "error")["ename"], "KeyboardInterrupt")
        # A reply arriving after the cancel must be dropped, not crash the runtime.
        self.repl.send({"type": "host_reply", "id": request["id"], "data": {"status": "ok"}})
        follow = self.repl.execute("after-cancel", "8+8")
        self.assertEqual(one(follow, "result")["text"], "16")

    def test_display_from_detached_task_keeps_cell_id(self):
        code = "\n".join(
            [
                "import asyncio",
                "from rlm.repl import emit",
                "async def later():",
                "    await asyncio.sleep(0.2)",
                "    emit({'text/plain': 'late'})",
                "detached = asyncio.create_task(later())",
            ]
        )
        self.assertEqual(one(self.repl.execute("det", code), "done")["status"], "ok")
        self.assertEqual(one(self.repl.execute("idle", "1"), "done")["status"], "ok")
        display = self.repl.read_event()
        while display.get("event") != "display":
            display = self.repl.read_event()
        self.assertEqual(display["id"], "det")
        self.assertEqual(display["data"], {"text/plain": "late"})

    def test_shutdown_clean_exit(self):
        self.assertEqual(self.repl.shutdown(), 0)

    def test_shutdown_after_mcp_import_exits_cleanly(self):
        events = self.repl.execute("mcp-import", "import rlm.mcp")
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertEqual(self.repl.shutdown(), 0)

    def _start_pending_host_request(self) -> None:
        code = "\n".join(
            [
                "from rlm.repl import host_request",
                "await host_request({'type': 'never-answered'})",
            ]
        )
        self.repl.send({"type": "execute", "id": "hr-pending", "code": code})
        request = self.repl.read_event()
        while request.get("event") != "host_request":
            request = self.repl.read_event()

    def test_stdin_eof_with_pending_host_request_exits(self):
        self._start_pending_host_request()
        assert self.repl.proc.stdin is not None
        self.repl.proc.stdin.close()
        self.assertEqual(self.repl.proc.wait(timeout=10), 0)

    def test_shutdown_with_pending_host_request_exits(self):
        self._start_pending_host_request()
        self.repl.send({"type": "shutdown", "id": "__shutdown__"})
        events = self.repl.until_done("hr-pending")
        self.assertEqual(one(events, "error")["ename"], "RuntimeError")
        self.repl.until_done("__shutdown__")
        self.assertEqual(self.repl.proc.wait(timeout=10), 0)


    def test_interrupt_with_non_string_id_is_protocol_error(self):
        self.repl.send({"type": "execute", "id": "busy", "code": "import asyncio\nawait asyncio.sleep(0.6)\n'done'"})
        time.sleep(0.2)
        self.repl.send({"type": "interrupt", "id": 123})
        events = self.repl.until_done("busy")
        protocol_errors = [e for e in events if e.get("ename") == "ProtocolError"]
        self.assertEqual(len(protocol_errors), 1)
        self.assertIn("interrupt request id must be a string", protocol_errors[0]["evalue"])
        # The running cell was not interrupted by the malformed request.
        self.assertEqual(one(events, "result")["text"], "'done'")
        self.assertEqual(one(events, "done")["status"], "ok")

    def test_snapshot_rejects_non_boolean_and_non_integer_options(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "kernel-state.dill")
            manifest_path = os.path.join(tmp, "kernel-state.json")
            self.repl.execute("v1", "big = b'x' * 100_000")
            self.repl.send(
                {
                    "type": "snapshot",
                    "id": "v2",
                    "path": path,
                    "manifest_path": manifest_path,
                    "max_variable_bytes": 1024,
                    "prune_oversized": "false",
                }
            )
            done = one(self.repl.until_done("v2"), "done")
            self.assertEqual(done["status"], "error")
            self.assertIn("boolean", done["reason"])
            events = self.repl.execute("v3", "'big' in dir()")
            self.assertEqual(one(events, "result")["text"], "True")

            self.repl.send(
                {"type": "snapshot", "id": "v4", "path": path, "manifest_path": manifest_path, "max_bytes": "10"}
            )
            done = one(self.repl.until_done("v4"), "done")
            self.assertEqual(done["status"], "error")
            self.assertIn("max_bytes must be a non-negative integer", done["reason"])

            # An explicit JSON null is present-but-invalid, not "use the default".
            self.repl.send(
                {"type": "snapshot", "id": "v5", "path": path, "manifest_path": manifest_path, "max_bytes": None}
            )
            done = one(self.repl.until_done("v5"), "done")
            self.assertEqual(done["status"], "error")
            self.assertIn("max_bytes must be a non-negative integer", done["reason"])

            self.repl.send(
                {
                    "type": "snapshot",
                    "id": "v6",
                    "path": path,
                    "manifest_path": manifest_path,
                    "max_variable_bytes": None,
                }
            )
            done = one(self.repl.until_done("v6"), "done")
            self.assertEqual(done["status"], "error")
            self.assertIn("max_variable_bytes must be a non-negative integer", done["reason"])

            # A negative cap with prune_oversized would delete every user variable: reject it
            # before the snapshot runs, leaving the namespace untouched.
            self.repl.send(
                {
                    "type": "snapshot",
                    "id": "v7",
                    "path": path,
                    "manifest_path": manifest_path,
                    "max_variable_bytes": -1,
                    "prune_oversized": True,
                }
            )
            done = one(self.repl.until_done("v7"), "done")
            self.assertEqual(done["status"], "error")
            self.assertIn("max_variable_bytes must be a non-negative integer", done["reason"])
            events = self.repl.execute("v8", "'big' in dir()")
            self.assertEqual(one(events, "result")["text"], "True")

    def test_snapshot_rejects_identical_path_and_manifest_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "kernel-state.dill")
            self.repl.send({"type": "snapshot", "id": "sp1", "path": path, "manifest_path": path})
            done = one(self.repl.until_done("sp1"), "done")
            self.assertEqual(done["status"], "error")
            self.assertEqual(done["reason"], "path and manifest_path must differ")
            self.assertFalse(os.path.exists(path))

    def test_exception_with_broken_str_reported_safely(self):
        code = "\n".join(
            [
                "class Broken(Exception):",
                "    def __str__(self):",
                "        raise RuntimeError('nope')",
                "raise Broken()",
            ]
        )
        events = self.repl.execute("brk", code)
        error = one(events, "error")
        self.assertEqual(error["ename"], "Broken")
        self.assertEqual(error["evalue"], "<exception str() failed>")
        self.assertEqual(one(events, "done")["status"], "error")
        follow = self.repl.execute("after-brk", "1+1")
        self.assertEqual(one(follow, "result")["text"], "2")

    def test_snapshot_manifest_write_failure_fails_without_pruning(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "kernel-state.dill")
            manifest_path = os.path.join(tmp, "missing-dir", "kernel-state.json")
            self.repl.execute("m1", "big = b'x' * 100_000")
            self.repl.send(
                {
                    "type": "snapshot",
                    "id": "m2",
                    "path": path,
                    "manifest_path": manifest_path,
                    "max_variable_bytes": 1024,
                    "prune_oversized": True,
                }
            )
            done = one(self.repl.until_done("m2"), "done")
            self.assertEqual(done["status"], "error")
            self.assertTrue(done["reason"].startswith("manifest write failed"))
            events = self.repl.execute("m3", "'big' in dir()")
            self.assertEqual(one(events, "result")["text"], "True")

    def test_closed_stdio_cell_still_completes_and_serves_next(self):
        # Closing sys.stdout/sys.stderr must not kill the serve loop: done still
        # arrives and the runtime keeps serving cells.
        events = self.repl.execute("close-io", "import sys\nsys.stdout.close()\nsys.stderr.close()")
        self.assertEqual(one(events, "done")["status"], "ok")
        follow = self.repl.execute("after-close", "1+1")
        self.assertEqual(one(follow, "result")["text"], "2")
        self.assertEqual(one(follow, "done")["status"], "ok")

    def test_compile_crash_reports_error_and_serves_next(self):
        # A compile-phase crash outside SyntaxError/ValueError (RecursionError or
        # MemoryError depending on build) must fail the one cell, not the runtime.
        events = self.repl.execute("deep", "a" + ".b" * 100000)
        self.assertIsNotNone(one(events, "error"))
        self.assertEqual(one(events, "done")["status"], "error")
        follow = self.repl.execute("after-deep", "1+1")
        self.assertEqual(one(follow, "result")["text"], "2")
        self.assertEqual(one(follow, "done")["status"], "ok")

    def test_rebound_stdout_without_flush_still_completes(self):
        # Rebinding sys.stdout/sys.stderr to flush-less objects must not kill drain.
        events = self.repl.execute("rebind-io", "import sys\nsys.stdout = None\nsys.stderr = None")
        self.assertEqual(one(events, "done")["status"], "ok")
        follow = self.repl.execute("after-rebind", "1+1")
        self.assertEqual(one(follow, "result")["text"], "2")
        self.assertEqual(one(follow, "done")["status"], "ok")

    def test_closed_fds_reclaimed_by_files_still_completes(self):
        # A cell closing fds 1/2 with open() reclaiming the numbers must not wedge
        # drain: tokens go through a private dup, so done still arrives.
        code = "\n".join(
            [
                "import os",
                "os.close(1)",
                "os.close(2)",
                "a = open(os.devnull, 'w')",
                "b = open(os.devnull, 'w')",
            ]
        )
        events = self.repl.execute("reclaim-fds", code)
        self.assertEqual(one(events, "done")["status"], "ok")
        # print() writes via sys.stdout's own dup, so the event must arrive and drain stays exact.
        follow = self.repl.execute("after-reclaim", "print('hi')")
        self.assertEqual(stream_text(follow, "stdout"), "hi\n")
        self.assertEqual(one(follow, "done")["status"], "ok")

    def test_restore_missing_snapshot_is_ok_with_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.repl.send({"type": "restore", "id": "r0", "path": os.path.join(tmp, "absent.dill")})
            done = one(self.repl.until_done("r0"), "done")
            self.assertEqual(done["status"], "ok")
            self.assertEqual(done["restored"], [])
            self.assertEqual(done["failed"], [])
            self.assertEqual(done["reason"], "snapshot not found")


class FinishRequestTest(unittest.TestCase):
    """In-process checks of the parked-interrupt bookkeeping on request finish."""

    def setUp(self) -> None:
        import rlm.repl as repl_module

        self.repl_module = repl_module
        self.addCleanup(self._reset)

    def _reset(self) -> None:
        self.repl_module._inflight.clear()
        self.repl_module._pending_interrupts["ids"].clear()
        self.repl_module._pending_interrupts["any"] = False
        self.repl_module._finishing_rid = None
        self.repl_module._handoff_interrupted = False
        self.repl_module._sigint_target = None
        self.repl_module._active.update({"task": None, "rid": None, "interrupted": False})

    def test_parked_any_survives_while_another_request_is_inflight(self):
        repl = self.repl_module
        repl._inflight.update({"a", "b"})
        repl._pending_interrupts["any"] = True
        repl._finish_request("a")
        self.assertTrue(repl._pending_interrupts["any"])
        repl._finish_request("b")
        self.assertFalse(repl._pending_interrupts["any"])

    def test_compile_error_consumes_parked_untargeted_interrupt(self):
        # An untargeted interrupt parked while a compile-broken request was
        # inflight belongs to that request: its compile-error finish must
        # consume it even while another request is still inflight, so the
        # interrupt cannot leak onto the next cell.
        repl = self.repl_module
        repl._inflight.update({"bad", "other"})
        repl._pending_interrupts["any"] = True
        asyncio.run(repl._handle_request(repl._handle_execute, {"id": "bad", "code": "def broken(:\n    pass"}, {}))
        self.assertFalse(repl._pending_interrupts["any"])
        self.assertNotIn("bad", repl._inflight)
        self.assertIn("other", repl._inflight)

    def test_post_run_error_leaves_parked_interrupt_for_next_request(self):
        # Once _run_guarded finished a request (_finish_locked already ran), a
        # later exception in the same handler must not consume an untargeted
        # interrupt parked for the still-inflight next request.
        repl = self.repl_module

        async def finished_then_broken(req, ns):
            repl._finish_request(req["id"])  # simulate _run_guarded completion
            repl._pending_interrupts["any"] = True  # parked while "other" is inflight
            raise RuntimeError("post-execution failure")

        repl._inflight.update({"done", "other"})
        asyncio.run(repl._handle_request(finished_then_broken, {"id": "done"}, {}))
        self.assertTrue(repl._pending_interrupts["any"])
        self.assertIn("other", repl._inflight)

    def test_sigint_in_post_run_guarded_window_reports_snapshot_ok(self):
        # A finishing-targeted SIGINT between _run_guarded's return and
        # _finish_request raises KeyboardInterrupt into _handle_state; the
        # completed destructive snapshot must still report done status ok.
        import signal
        from unittest import mock

        repl = self.repl_module
        real_run_guarded = repl._run_guarded

        async def run_guarded_then_sigint(task, rid):
            outcome = await real_run_guarded(task, rid)
            with repl._interrupt_lock:
                repl._sigint_target = rid
            # Synchronous SIGINT in the post-run window: the handler sees
            # _sigint_target == _finishing_rid and raises right here.
            signal.raise_signal(signal.SIGINT)
            return outcome

        previous = signal.signal(signal.SIGINT, repl._sigint_handler)
        self.addCleanup(signal.signal, signal.SIGINT, previous)
        previous_loop = repl._loop
        self.addCleanup(setattr, repl, "_loop", previous_loop)
        sent = []
        ns = {"big": b"x" * 100_000}

        with tempfile.TemporaryDirectory() as tmp:
            req = {
                "type": "snapshot",
                "id": "snap",
                "path": os.path.join(tmp, "kernel-state.dill"),
                "manifest_path": os.path.join(tmp, "kernel-state.json"),
                "max_variable_bytes": 1024,
                "prune_oversized": True,
            }

            async def main():
                repl._loop = asyncio.get_running_loop()
                repl._inflight.add("snap")
                await repl._handle_request(repl._handle_state, req, ns)

            with mock.patch.object(repl, "_run_guarded", run_guarded_then_sigint):
                with mock.patch.object(repl, "_send", sent.append):
                    asyncio.run(main())

        done = next(e for e in sent if e.get("event") == "done")
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done["pruned"], ["big"])
        # The prune ran (destructive success) and the request is fully finished.
        self.assertEqual(ns, {})
        self.assertNotIn("snap", repl._inflight)

    def test_protocol_interrupt_during_restore_commit_is_consumed_and_next_request_runs(self):
        # A protocol interrupt (_request_interrupt -> SIGINT on the main thread)
        # landing while the restore applies its staged names is consumed: the
        # restore reports done ok with every name applied, and a following
        # request runs normally with no interrupt bleed.
        import signal
        from unittest import mock

        repl = self.repl_module
        previous = signal.signal(signal.SIGINT, repl._sigint_handler)
        self.addCleanup(signal.signal, signal.SIGINT, previous)
        previous_loop = repl._loop
        self.addCleanup(setattr, repl, "_loop", previous_loop)
        sent = []

        class InterruptOnFirstSet(dict):
            def __setitem__(self, key, value):
                super().__setitem__(key, value)
                if len(self) == 1:
                    repl._request_interrupt("restore")

        ns = InterruptOnFirstSet()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "kernel-state.dill")
            manifest = os.path.join(tmp, "kernel-state.json")
            snap = repl._snapshot_state({"a": 1, "b": 2}, path, manifest, 1 << 20, 1 << 20, False)
            self.assertNotIn("error", snap)

            async def main():
                repl._loop = asyncio.get_running_loop()
                repl._inflight.add("restore")
                await repl._handle_request(repl._handle_state, {"type": "restore", "id": "restore", "path": path}, ns)
                repl._inflight.add("next")
                await repl._handle_request(repl._handle_execute, {"id": "next", "code": "checked = 1 + 1"}, {})

            with mock.patch.object(repl, "_send", sent.append):
                with mock.patch.object(repl, "_drain_output", lambda: None):
                    asyncio.run(main())

        done_restore = next(e for e in sent if e.get("event") == "done" and e["id"] == "restore")
        self.assertEqual(done_restore["status"], "ok")
        self.assertEqual(done_restore["restored"], ["a", "b"])
        self.assertEqual(dict(ns), {"a": 1, "b": 2})
        done_next = next(e for e in sent if e.get("event") == "done" and e["id"] == "next")
        self.assertEqual(done_next["status"], "ok")
        self.assertIsNone(repl._sigint_target)
        self.assertFalse(repl._pending_interrupts["any"])
        self.assertFalse(repl._pending_interrupts["ids"])

    @staticmethod
    def _run_resuming(coro):
        # Mimic main(): a KI escaping a task stops run_until_complete; the
        # runtime resumes the loop and serving continues.
        loop = asyncio.new_event_loop()
        try:
            outer = loop.create_task(coro)
            while not outer.done():
                try:
                    loop.run_until_complete(outer)
                except KeyboardInterrupt:
                    continue
        finally:
            loop.close()

    def test_protocol_interrupt_after_restore_returned_before_task_done_reports_ok(self):
        # The interrupt raises into the state task AFTER _restore_state returned
        # but before the task completes; every binding is committed, so the
        # request must report ok from the committed box, not interrupted.
        import signal
        from unittest import mock

        repl = self.repl_module
        previous = signal.signal(signal.SIGINT, repl._sigint_handler)
        self.addCleanup(signal.signal, signal.SIGINT, previous)
        previous_loop = repl._loop
        self.addCleanup(setattr, repl, "_loop", previous_loop)
        sent = []
        real_restore = repl._restore_state

        def restore_then_interrupt(*args, **kwargs):
            result = real_restore(*args, **kwargs)
            repl._sigint_target = "restore"
            repl._sigint_handler(signal.SIGINT, None)  # raises into the still-running task
            return result

        ns: dict = {}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "kernel-state.dill")
            manifest = os.path.join(tmp, "kernel-state.json")
            snap = repl._snapshot_state({"a": 1, "b": 2}, path, manifest, 1 << 20, 1 << 20, False)
            self.assertNotIn("error", snap)

            async def main():
                repl._loop = asyncio.get_running_loop()
                repl._inflight.add("restore")
                await repl._handle_request(repl._handle_state, {"type": "restore", "id": "restore", "path": path}, ns)
                repl._inflight.add("next")
                await repl._handle_request(repl._handle_execute, {"id": "next", "code": "checked = 1 + 1"}, {})

            with mock.patch.object(repl, "_restore_state", restore_then_interrupt):
                with mock.patch.object(repl, "_send", sent.append):
                    with mock.patch.object(repl, "_drain_output", lambda: None):
                        self._run_resuming(main())

        done_restore = next(e for e in sent if e.get("event") == "done" and e["id"] == "restore")
        self.assertEqual(done_restore["status"], "ok")
        self.assertEqual(done_restore["restored"], ["a", "b"])
        self.assertEqual(ns, {"a": 1, "b": 2})
        done_next = next(e for e in sent if e.get("event") == "done" and e["id"] == "next")
        self.assertEqual(done_next["status"], "ok")
        self.assertIsNone(repl._sigint_target)
        self.assertFalse(repl._pending_interrupts["any"])
        self.assertFalse(repl._pending_interrupts["ids"])

    def test_nonprotocol_keyboardinterrupt_after_committed_restore_is_not_recovered(self):
        # A user-originated KeyboardInterrupt (no _sigint_handler provenance:
        # _active["interrupted"] stays False) after the restore committed must
        # keep the interrupted error, not be converted to snapshot success.
        from unittest import mock

        repl = self.repl_module
        previous_loop = repl._loop
        self.addCleanup(setattr, repl, "_loop", previous_loop)
        sent = []
        real_restore = repl._restore_state

        def restore_then_user_interrupt(*args, **kwargs):
            real_restore(*args, **kwargs)  # fills the committed box
            raise KeyboardInterrupt("nonprotocol")

        ns: dict = {}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "kernel-state.dill")
            manifest = os.path.join(tmp, "kernel-state.json")
            snap = repl._snapshot_state({"a": 1, "b": 2}, path, manifest, 1 << 20, 1 << 20, False)
            self.assertNotIn("error", snap)

            async def main():
                repl._loop = asyncio.get_running_loop()
                repl._inflight.add("restore")
                await repl._handle_request(repl._handle_state, {"type": "restore", "id": "restore", "path": path}, ns)

            with mock.patch.object(repl, "_restore_state", restore_then_user_interrupt):
                with mock.patch.object(repl, "_send", sent.append):
                    with mock.patch.object(repl, "_drain_output", lambda: None):
                        self._run_resuming(main())

        done = next(e for e in sent if e.get("event") == "done" and e["id"] == "restore")
        self.assertEqual(done["status"], "error")
        self.assertEqual(done["reason"], "interrupted")

    def test_protocol_interrupt_after_destructive_snapshot_returned_reports_ok(self):
        # Same post-return window for snapshot: the pruning commit already ran,
        # so the interrupt must not misreport the destructive snapshot as failed.
        import signal
        from unittest import mock

        repl = self.repl_module
        previous = signal.signal(signal.SIGINT, repl._sigint_handler)
        self.addCleanup(signal.signal, signal.SIGINT, previous)
        previous_loop = repl._loop
        self.addCleanup(setattr, repl, "_loop", previous_loop)
        sent = []
        real_snapshot = repl._snapshot_state

        def snapshot_then_interrupt(*args, **kwargs):
            result = real_snapshot(*args, **kwargs)
            repl._sigint_target = "snap"
            repl._sigint_handler(signal.SIGINT, None)  # raises into the still-running task
            return result

        ns = {"small": 1, "big": "x" * 100000}
        with tempfile.TemporaryDirectory() as tmp:
            req = {
                "type": "snapshot",
                "id": "snap",
                "path": os.path.join(tmp, "kernel-state.dill"),
                "manifest_path": os.path.join(tmp, "kernel-state.json"),
                "prune_oversized": True,
                "max_variable_bytes": 1024,
            }

            async def main():
                repl._loop = asyncio.get_running_loop()
                repl._inflight.add("snap")
                await repl._handle_request(repl._handle_state, req, ns)

            with mock.patch.object(repl, "_snapshot_state", snapshot_then_interrupt):
                with mock.patch.object(repl, "_send", sent.append):
                    self._run_resuming(main())

        done = next(e for e in sent if e.get("event") == "done" and e["id"] == "snap")
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done["saved"], ["small"])
        self.assertEqual(done["pruned"], ["big"])
        self.assertEqual(ns, {"small": 1})
        self.assertIsNone(repl._sigint_target)

    def test_untargeted_interrupt_in_done_task_handoff_is_not_parked(self):
        # The cell task is done but _run_guarded's finally has not run yet
        # (_active still names the rid, _finishing_rid is unset). An untargeted
        # interrupt in that handoff belongs to THIS request: it must be recorded
        # for its finishing phase, never parked where the next request eats it.
        import signal

        repl = self.repl_module

        class DoneTask:
            def done(self):
                return True

            def cancel(self):
                raise AssertionError("a done task must not be cancelled")

        repl._inflight.update({"handoff", "other"})
        repl._active.update({"task": DoneTask(), "rid": "handoff", "interrupted": False})
        previous = signal.signal(signal.SIGINT, repl._sigint_handler)
        self.addCleanup(signal.signal, signal.SIGINT, previous)
        repl._request_interrupt(None)
        deadline = time.monotonic() + 5
        while not repl._handoff_interrupted and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(repl._sigint_target, "handoff")
        self.assertFalse(repl._pending_interrupts["any"])
        self.assertTrue(repl._consume_handoff_interrupt())
        self.assertFalse(repl._handoff_interrupted)
        self.assertIn("other", repl._inflight)


class SnapshotPruneShieldTest(unittest.TestCase):
    """The prune-deletion window must not be split by a SIGINT-raised KeyboardInterrupt."""

    def test_sigint_mid_prune_is_consumed_after_all_deletions_ran(self):
        import signal

        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)
        from rlm.repl import _snapshot_state

        class SigintOnFirstPop(dict):
            fired = False

            def pop(self, key, default=None):
                if not self.fired:
                    self.fired = True
                    # Synchronous SIGINT on the main thread: lands exactly mid-loop.
                    signal.raise_signal(signal.SIGINT)
                return super().pop(key, default)

        ns = SigintOnFirstPop(big1=b"x" * 100_000, big2=b"y" * 100_000)
        with tempfile.TemporaryDirectory() as tmp:
            result = _snapshot_state(
                ns,
                os.path.join(tmp, "kernel-state.dill"),
                os.path.join(tmp, "kernel-state.json"),
                max_bytes=1 << 20,
                max_variable_bytes=1024,
                prune_oversized=True,
            )
        # The parked SIGINT is consumed: the committed snapshot reports success.
        self.assertEqual(result["pruned"], ["big1", "big2"])
        self.assertNotIn("error", result)
        # Both deletions ran: ns matches the manifest.
        self.assertEqual(dict(ns), {})

    def test_sigint_after_manifest_commit_before_deletions_is_consumed(self):
        import signal
        from unittest import mock

        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)
        from rlm.repl import _snapshot_state

        real_replace = os.replace

        ns = {"big1": b"x" * 100_000, "big2": b"y" * 100_000}
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = os.path.join(tmp, "kernel-state.json")

            def replace_then_sigint(src, dst):
                real_replace(src, dst)
                # Synchronous SIGINT right after the manifest commit, before any deletion.
                if dst == manifest_path:
                    signal.raise_signal(signal.SIGINT)

            with mock.patch("os.replace", replace_then_sigint):
                result = _snapshot_state(
                    ns,
                    os.path.join(tmp, "kernel-state.dill"),
                    manifest_path,
                    max_bytes=1 << 20,
                    max_variable_bytes=1024,
                    prune_oversized=True,
                )
            # The parked SIGINT is consumed: the committed destructive snapshot
            # reports success instead of surfacing KeyboardInterrupt.
            self.assertEqual(result["pruned"], ["big1", "big2"])
            self.assertNotIn("error", result)
            # The deletions still ran: ns is consistent with the committed manifest.
            self.assertEqual(ns, {})
            with open(manifest_path) as fh:
                self.assertEqual(json.load(fh)["pruned"], ["big1", "big2"])


class RestoreApplyShieldTest(unittest.TestCase):
    """The restore assignment loop must not be split by a SIGINT-raised KeyboardInterrupt."""

    def _write_snapshot(self, tmp: str, source: dict[str, object]) -> str:
        path = os.path.join(tmp, "kernel-state.dill")
        from rlm.repl import _snapshot_state

        result = _snapshot_state(
            source,
            path,
            os.path.join(tmp, "kernel-state.json"),
            max_bytes=1 << 20,
            max_variable_bytes=1 << 20,
            prune_oversized=False,
        )
        self.assertNotIn("error", result)
        return path

    def setUp(self):
        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)

    class SigintOnNthSet(dict):
        """Fires one synchronous SIGINT right after its Nth assignment."""

        def __init__(self, fire_on: int) -> None:
            super().__init__()
            self.fire_on = fire_on
            self.calls = 0

        def __setitem__(self, key, value):
            super().__setitem__(key, value)
            self.calls += 1
            if self.calls == self.fire_on:
                signal.raise_signal(signal.SIGINT)

    def test_sigint_during_staging_leaves_namespace_unchanged(self):
        import dill

        from rlm.repl import _restore_state

        real_loads = dill.loads
        calls = {"n": 0}

        def loads_then_sigint(blob):
            calls["n"] += 1
            if calls["n"] == 2:
                # Synchronous SIGINT mid-deserialize: nothing may have touched ns yet.
                signal.raise_signal(signal.SIGINT)
            return real_loads(blob)

        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_snapshot(tmp, {"a": 1, "b": 2})
            ns = {"a": "old", "unrelated": "keep"}
            with mock.patch.object(dill, "loads", loads_then_sigint):
                with self.assertRaises(KeyboardInterrupt):
                    _restore_state(ns, path)
        # The old namespace is byte-identical: no partial old/new mixture.
        self.assertEqual(ns, {"a": "old", "unrelated": "keep"})

    def test_sigint_mid_apply_is_consumed_and_all_names_applied(self):
        from rlm.repl import _restore_state

        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_snapshot(tmp, {"a": 1, "b": 2})
            ns = self.SigintOnNthSet(fire_on=1)
            result = _restore_state(ns, path)
        # The parked SIGINT is consumed: the committed restore reports success.
        self.assertNotIn("error", result)
        self.assertEqual(result["restored"], ["a", "b"])
        self.assertEqual(dict(ns), {"a": 1, "b": 2})

    def test_sigint_after_last_apply_is_consumed(self):
        from rlm.repl import _restore_state

        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_snapshot(tmp, {"a": 1, "b": 2})
            ns = self.SigintOnNthSet(fire_on=2)
            result = _restore_state(ns, path)
        self.assertNotIn("error", result)
        self.assertEqual(result["restored"], ["a", "b"])
        self.assertEqual(dict(ns), {"a": 1, "b": 2})

    def _restore_with_sigint_at_unpark(self):
        """Real unparking swap, then the newly restored handler fires immediately."""
        from rlm.repl import _restore_state

        real_signal = signal.signal
        state = {"calls": 0, "fired": False}

        def swap_then_fire(sig, handler):
            prev = real_signal(sig, handler)
            state["calls"] += 1
            if state["calls"] == 2:
                # A SIGINT delivered while parked but first seen after the swap
                # runs the restored raising handler inside _restore_state's tail.
                state["fired"] = True
                handler(sig, None)
            return prev

        committed: list = []
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_snapshot(tmp, {"a": 1, "b": 2})
            ns: dict = {}
            with mock.patch("signal.signal", swap_then_fire):
                with self.assertRaises(KeyboardInterrupt):
                    _restore_state(ns, path, committed)
        self.assertTrue(state["fired"])
        return committed, ns

    def test_sigint_at_handler_restoration_publishes_committed_result(self):
        # Every binding is applied by unpark time: the KeyboardInterrupt escapes
        # this frame, but the filled box lets _handle_state report success.
        previous = signal.signal(signal.SIGINT, signal.default_int_handler)
        self.addCleanup(signal.signal, signal.SIGINT, previous)
        committed, ns = self._restore_with_sigint_at_unpark()
        self.assertEqual(committed[0]["restored"], ["a", "b"])
        self.assertEqual(ns, {"a": 1, "b": 2})
        self.assertIs(signal.getsignal(signal.SIGINT), signal.default_int_handler)

    def test_sigint_at_handler_restoration_with_non_default_prior_handler(self):
        fired = []

        def prior(signum, frame):
            fired.append(signum)
            raise KeyboardInterrupt

        previous = signal.signal(signal.SIGINT, prior)
        self.addCleanup(signal.signal, signal.SIGINT, previous)
        committed, ns = self._restore_with_sigint_at_unpark()
        self.assertEqual(committed[0]["restored"], ["a", "b"])
        self.assertEqual(ns, {"a": 1, "b": 2})
        self.assertEqual(fired, [signal.SIGINT])
        self.assertIs(signal.getsignal(signal.SIGINT), prior)

    def test_handler_restored_and_no_interrupt_bleed(self):
        from rlm.repl import _restore_state

        original = signal.getsignal(signal.SIGINT)
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_snapshot(tmp, {"a": 1, "b": 2})
            ns = self.SigintOnNthSet(fire_on=1)
            result = _restore_state(ns, path)
        self.assertNotIn("error", result)
        self.assertIs(signal.getsignal(signal.SIGINT), original)
        # Nothing parked bleeds into later work: a fresh SIGINT raises normally.
        with self.assertRaises(KeyboardInterrupt):
            signal.raise_signal(signal.SIGINT)


class SnapshotTempCleanupTest(unittest.TestCase):
    def test_keyboard_interrupt_during_payload_write_removes_temp_file(self):
        from unittest import mock as unittest_mock

        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)
        import dill

        from rlm.repl import _snapshot_state

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "kernel-state.dill")

            real_dump = dill.dump

            def interrupted_dump(payload, fh):
                if isinstance(payload, dict):  # the complete payload, not a per-variable value
                    fh.write(b"partial")
                    raise KeyboardInterrupt
                return real_dump(payload, fh)

            with unittest_mock.patch.object(dill, "dump", interrupted_dump):
                with self.assertRaises(KeyboardInterrupt):
                    _snapshot_state(
                        {"x": 1},
                        path,
                        os.path.join(tmp, "manifest.json"),
                        max_bytes=1 << 20,
                        max_variable_bytes=1 << 20,
                        prune_oversized=False,
                    )
            self.assertEqual(os.listdir(tmp), [])  # no temp (or final) files survive

    def test_name_deleted_by_background_thread_mid_snapshot_is_skipped(self):
        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)
        from rlm.repl import _snapshot_state

        class RacyNs(dict):
            # Simulates a background thread deleting "gone" between the key
            # listing and the per-name lookup.
            def keys(self):
                yield from ("gone", "kept")

        ns = RacyNs(kept=1)
        with tempfile.TemporaryDirectory() as tmp:
            result = _snapshot_state(
                ns,
                os.path.join(tmp, "kernel-state.dill"),
                os.path.join(tmp, "manifest.json"),
                max_bytes=1 << 20,
                max_variable_bytes=1 << 20,
                prune_oversized=False,
            )
        self.assertNotIn("error", result)
        self.assertEqual(result["saved"], ["kept"])
        self.assertEqual(result["skipped"], [{"name": "gone", "reason": "deleted during snapshot"}])



class SnapshotPairConsistencyTest(unittest.TestCase):
    # Direct fault injection into _snapshot_state: portable and deterministic
    # (chmod-based injection breaks as root and has different Windows semantics).
    def setUp(self):
        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)
        from rlm.repl import _snapshot_state

        self.snapshot = _snapshot_state
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.path = os.path.join(self.dir, "kernel-state.dill")
        self.manifest_path = os.path.join(self.dir, "kernel-state.json")

    def _snap(self, ns, path=None, manifest_path=None, **kw):
        args = dict(max_bytes=1 << 20, max_variable_bytes=1 << 20, prune_oversized=False)
        args.update(kw)
        return self.snapshot(ns, path or self.path, manifest_path or self.manifest_path, **args)

    def _old_pair(self, path=None, manifest_path=None):
        self.assertNotIn("error", self._snap({"keep": 1}, path, manifest_path))
        with open(path or self.path, "rb") as fh:
            payload = fh.read()
        with open(manifest_path or self.manifest_path, "rb") as fh:
            manifest = fh.read()
        return payload, manifest

    def _assert_pair(self, old_payload, old_manifest, path=None, manifest_path=None):
        with open(path or self.path, "rb") as fh:
            self.assertEqual(fh.read(), old_payload)
        with open(manifest_path or self.manifest_path, "rb") as fh:
            self.assertEqual(fh.read(), old_manifest)

    def _assert_only_pair_files(self, directory=None):
        self.assertEqual(
            sorted(os.listdir(directory or self.dir)),
            ["kernel-state.dill", "kernel-state.json"],
        )

    def test_complete_payload_respects_aggregate_size_cap(self):
        name = "x" * 10_000
        result = self._snap({name: 1}, max_bytes=128, max_variable_bytes=128)
        self.assertEqual(result["saved"], [])
        self.assertEqual(result["skipped"], [{"name": name, "reason": "exceeds aggregate snapshot size cap"}])
        self.assertLessEqual(result["bytes"], 128)
        self._assert_only_pair_files()

    def test_near_cap_payload_skips_tail_instead_of_failing_snapshot(self):
        import dill

        dill.settings["recurse"] = True
        source = {"a": "first", "b": "second"}
        blobs = {name: dill.dumps(value) for name, value in source.items()}
        cap = len(dill.dumps(blobs)) - 1
        self.assertLessEqual(sum(map(len, blobs.values())), cap)
        self.assertLessEqual(len(dill.dumps({"a": blobs["a"]})), cap)

        result = self._snap(source, max_bytes=cap, max_variable_bytes=cap)
        self.assertEqual(result["saved"], ["a"])
        self.assertEqual(result["skipped"], [{"name": "b", "reason": "exceeds aggregate snapshot size cap"}])
        self.assertLessEqual(result["bytes"], cap)
        with open(self.path, "rb") as fh:
            self.assertEqual(list(dill.load(fh)), ["a"])

    def test_zero_size_cap_writes_no_empty_payload_overhead(self):
        result = self._snap({}, max_bytes=0, max_variable_bytes=0)
        self.assertEqual(result, {"error": "write failed: snapshot exceeds aggregate snapshot size cap"})
        self.assertEqual(os.listdir(self.dir), [])

    def test_manifest_write_failure_preserves_prior_pair(self):
        old_payload, old_manifest = self._old_pair()
        ns = {"keep": 1, "big": b"x" * 100_000}
        with mock.patch("json.dump", side_effect=OSError("disk full")):
            result = self._snap(ns, max_variable_bytes=1024, prune_oversized=True)
        self.assertTrue(result["error"].startswith("manifest write failed"))
        self._assert_pair(old_payload, old_manifest)
        self._assert_only_pair_files()
        self.assertIn("big", ns)  # not pruned

    def test_payload_replace_failure_preserves_prior_pair(self):
        old_payload, old_manifest = self._old_pair()
        real_replace = os.replace

        def failing_replace(src, dst):
            if dst == self.path:
                raise OSError("rename failed")
            return real_replace(src, dst)

        with mock.patch("os.replace", failing_replace):
            result = self._snap({"keep": 2})
        self.assertTrue(result["error"].startswith("write failed"))
        self._assert_pair(old_payload, old_manifest)
        self._assert_only_pair_files()

    def test_payload_write_failure_returns_error_dict_and_cleans_temp(self):
        old_payload, old_manifest = self._old_pair()
        real_fdopen = os.fdopen

        class FailingWrite:
            def __init__(self, fh):
                self.fh = fh

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.fh.close()

            def write(self, data):
                raise OSError("disk full")

        def fdopen(fd, mode):
            fh = real_fdopen(fd, mode)
            return FailingWrite(fh) if mode == "wb" else fh

        with mock.patch("os.fdopen", side_effect=fdopen):
            result = self._snap({"keep": 2})
        self.assertTrue(result["error"].startswith("write failed"))
        self._assert_pair(old_payload, old_manifest)
        self._assert_only_pair_files()

    def test_keyboard_interrupt_between_stages_cleans_temps(self):
        old_payload, old_manifest = self._old_pair()
        with mock.patch("json.dump", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self._snap({"keep": 2})
        self._assert_pair(old_payload, old_manifest)
        self._assert_only_pair_files()

    def test_sigint_after_payload_replace_is_parked_and_consumed(self):
        # SIGINT is parked from before the payload replace through the deletions.
        real_replace = os.replace
        ns = {"keep": 1, "big": b"x" * 100_000}

        def replace_then_sigint(src, dst):
            real_replace(src, dst)
            if dst == self.path:
                signal.raise_signal(signal.SIGINT)

        with mock.patch("os.replace", replace_then_sigint):
            result = self._snap(ns, max_variable_bytes=1024, prune_oversized=True)
        self.assertNotIn("error", result)
        self.assertEqual(result["pruned"], ["big"])
        self.assertNotIn("big", ns)  # the prune still ran; the SIGINT was consumed
        self._assert_only_pair_files()
        with open(self.manifest_path) as fh:
            self.assertEqual(json.load(fh)["pruned"], ["big"])

    def test_signal_install_failure_propagates_and_cleans_temps(self):
        # A SIGINT-handler install failure (e.g. off-main-thread) must not leak temps.
        old_payload, old_manifest = self._old_pair()
        with mock.patch("signal.signal", side_effect=ValueError("main thread only")):
            with self.assertRaises(ValueError):
                self._snap({"keep": 2})
        self._assert_pair(old_payload, old_manifest)
        self._assert_only_pair_files()

    def test_fdopen_failure_closes_raw_fd_and_removes_temp(self):
        old_payload, old_manifest = self._old_pair()
        real_mkstemp = tempfile.mkstemp
        seen = {}

        def spy_mkstemp(**kwargs):
            seen["fd"], seen["name"] = real_mkstemp(**kwargs)
            return seen["fd"], seen["name"]

        with mock.patch("tempfile.mkstemp", spy_mkstemp):
            with mock.patch("os.fdopen", side_effect=OSError("bad fd")):
                result = self._snap({"keep": 2})
        self.assertTrue(result["error"].startswith("write failed"))
        with self.assertRaises(OSError):
            os.fstat(seen["fd"])  # the raw mkstemp fd was closed
        self.assertFalse(os.path.exists(seen["name"]))
        self._assert_pair(old_payload, old_manifest)
        self._assert_only_pair_files()

    def test_manifest_replace_failure_leaves_new_payload_old_manifest(self):
        # The documented unavoidable failure state between the two renames.
        old_payload, old_manifest = self._old_pair()
        ns = {"keep": 2, "big": b"x" * 100_000}
        real_replace = os.replace

        def failing_manifest_replace(src, dst):
            if dst == self.manifest_path:
                raise OSError("rename failed")
            return real_replace(src, dst)

        with mock.patch("os.replace", failing_manifest_replace):
            result = self._snap(ns, max_variable_bytes=1024, prune_oversized=True)
        self.assertTrue(result["error"].startswith("manifest write failed"))
        with open(self.path, "rb") as fh:
            self.assertNotEqual(fh.read(), old_payload)  # new payload committed
        with open(self.manifest_path, "rb") as fh:
            self.assertEqual(fh.read(), old_manifest)  # old manifest intact
        self._assert_only_pair_files()
        self.assertIn("big", ns)  # not pruned

    def test_sigint_during_final_temp_cleanup_is_parked_and_consumed(self):
        # The handler must stay parked through discard_temps and restore last.
        original = signal.getsignal(signal.SIGINT)
        real_remove = os.remove
        fired = []
        ns = {"keep": 1, "big": b"x" * 100_000}

        def remove_then_sigint(name):
            if not fired:
                fired.append(name)
                signal.raise_signal(signal.SIGINT)
            return real_remove(name)

        with mock.patch("os.remove", remove_then_sigint):
            result = self._snap(ns, max_variable_bytes=1024, prune_oversized=True)
        self.assertNotIn("error", result)  # no KeyboardInterrupt escaped
        self.assertEqual(result["pruned"], ["big"])
        self.assertNotIn("big", ns)  # pruning completed
        self.assertTrue(fired)  # the SIGINT really fired during cleanup
        self.assertIs(signal.getsignal(signal.SIGINT), original)  # handler restored
        self._assert_only_pair_files()

    def test_cleanup_failure_still_restores_sigint_handler(self):
        # A non-OSError from cleanup (e.g. an audit hook) must not skip the restore.
        original = signal.getsignal(signal.SIGINT)
        with mock.patch("os.remove", side_effect=RuntimeError("audit hook")):
            with self.assertRaisesRegex(RuntimeError, "audit hook"):
                self._snap({"keep": 1})
        self.assertIs(signal.getsignal(signal.SIGINT), original)

    def test_aliased_temp_style_names_never_clobber_the_pair(self):
        # Regression: fixed path+'.tmp' temp names aliased the OTHER final path.
        layouts = (
            ("kernel-state.dill", "kernel-state.dill.tmp"),  # manifest == payload + '.tmp'
            ("kernel-state.json.tmp", "kernel-state.json"),  # payload == manifest + '.tmp'
        )
        for payload_name, manifest_name in layouts:
            with self.subTest(payload=payload_name, manifest=manifest_name):
                d = tempfile.mkdtemp(dir=self.dir)
                path = os.path.join(d, payload_name)
                manifest_path = os.path.join(d, manifest_name)
                old_payload, old_manifest = self._old_pair(path, manifest_path)
                with mock.patch("json.dump", side_effect=OSError("disk full")):
                    result = self._snap({"keep": 2}, path, manifest_path)
                self.assertTrue(result["error"].startswith("manifest write failed"))
                self._assert_pair(old_payload, old_manifest, path, manifest_path)
                self.assertEqual(sorted(os.listdir(d)), sorted([payload_name, manifest_name]))
                # A plain success with aliased names must clobber neither file.
                self.assertNotIn("error", self._snap({"keep": 2}, path, manifest_path))
                with open(path, "rb") as fh:
                    self.assertNotEqual(fh.read(), old_payload)  # new payload committed
                with open(manifest_path) as fh:
                    self.assertEqual(json.load(fh)["savedNames"], ["keep"])
                self.assertEqual(sorted(os.listdir(d)), sorted([payload_name, manifest_name]))


class OwnerWatchdogTest(unittest.TestCase):
    def test_owner_watchdog_exits_busy_runtime(self):
        # The reproduced F4 scenario: stdin stays open (no EOF shutdown), a
        # synchronous cell monopolizes the loop, and only the watchdog thread
        # can notice the owner's death and exit the runtime.
        owner = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
        try:
            repl = ReplProcess(env={"PRIME_AGENT_KERNEL_OWNER_PID": str(owner.pid)})
            self.addCleanup(repl.close)
            repl.ready()
            repl.send({"type": "execute", "id": "busy", "code": "while True: pass"})
            time.sleep(1.0)  # let the busy cell start monopolizing the loop
            self.assertIsNone(repl.proc.poll())
            owner.kill()
            owner.wait(timeout=10)
            self.assertEqual(repl.proc.wait(timeout=15), 1)
        finally:
            if owner.poll() is None:
                owner.kill()
                owner.wait(timeout=10)

    def test_resolve_owner_pid_falls_back_to_ppid(self):
        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)
        import rlm.repl as repl_module

        with mock.patch.dict(os.environ, {"PRIME_AGENT_KERNEL_OWNER_PID": "4242"}):
            self.assertEqual(repl_module._resolve_owner_pid(), 4242)
        for raw in (None, "", "garbage", "0", "-7"):
            env = {} if raw is None else {"PRIME_AGENT_KERNEL_OWNER_PID": raw}
            with mock.patch.dict(os.environ, env, clear=False):
                if raw is None:
                    os.environ.pop("PRIME_AGENT_KERNEL_OWNER_PID", None)
                self.assertEqual(repl_module._resolve_owner_pid(), os.getppid())

    def test_owner_watchdog_windows_waits_on_process_handle(self):
        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)
        import rlm.repl as repl_module

        from ctypes import wintypes

        calls: list[tuple] = []

        class FakeFunction:
            def __init__(self, name, result):
                self.name = name
                self.result = result
                self.argtypes = None
                self.restype = None

            def __call__(self, *args):
                calls.append((self.name, *args))
                return self.result

        class FakeKernel32:
            def __init__(self, open_result=1234):
                self.OpenProcess = FakeFunction("OpenProcess", open_result)
                self.WaitForSingleObject = FakeFunction("WaitForSingleObject", 0)
                self.CloseHandle = FakeFunction("CloseHandle", 1)

        k32 = FakeKernel32()
        with mock.patch.object(repl_module.ctypes, "WinDLL", create=True, return_value=k32):
            repl_module._wait_owner_windows(777)
        self.assertEqual(
            calls,
            [
                ("OpenProcess", 0x00100000, False, 777),
                ("WaitForSingleObject", 1234, 0xFFFFFFFF),
                ("CloseHandle", 1234),
            ],
        )
        self.assertEqual(k32.OpenProcess.argtypes, [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD])
        self.assertIs(k32.OpenProcess.restype, wintypes.HANDLE)
        self.assertEqual(k32.WaitForSingleObject.argtypes, [wintypes.HANDLE, wintypes.DWORD])
        self.assertIs(k32.WaitForSingleObject.restype, wintypes.DWORD)
        self.assertEqual(k32.CloseHandle.argtypes, [wintypes.HANDLE])
        self.assertIs(k32.CloseHandle.restype, wintypes.BOOL)

        calls.clear()
        with mock.patch.object(
            repl_module.ctypes, "WinDLL", create=True, return_value=FakeKernel32(open_result=0)
        ):
            repl_module._wait_owner_windows(778)
        self.assertEqual(calls, [("OpenProcess", 0x00100000, False, 778)])


if __name__ == "__main__":
    unittest.main()
