from __future__ import annotations

import asyncio
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SRC = os.path.join(os.path.dirname(__file__), "..", "src")

_EOF = object()


class ReplProcess:
    """Drives one `python -m rlm.repl` subprocess over the JSON-lines protocol."""

    def __init__(self) -> None:
        env = {**os.environ, "PYTHONPATH": SRC + os.pathsep + os.environ.get("PYTHONPATH", "")}
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
        self.assertEqual(self.ready_event["protocol"], 2)
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
        self.repl.send({"type": "host_reply", "id": request["id"], "data": {"status": "ok", "answer": 42}})
        events = self.repl.until_done("hr")
        self.assertEqual(one(events, "result")["text"], "{'status': 'ok', 'answer': 42}")
        self.assertEqual(one(events, "done")["status"], "ok")

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


class SnapshotPruneShieldTest(unittest.TestCase):
    """The prune-deletion window must not be split by a SIGINT-raised KeyboardInterrupt."""

    def test_sigint_mid_prune_defers_until_all_deletions_ran(self):
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
            with self.assertRaises(KeyboardInterrupt):
                _snapshot_state(
                    ns,
                    os.path.join(tmp, "kernel-state.dill"),
                    os.path.join(tmp, "kernel-state.json"),
                    max_bytes=1 << 20,
                    max_variable_bytes=1024,
                    prune_oversized=True,
                )
        # Both deletions ran before the interrupt was re-delivered: ns matches the manifest.
        self.assertEqual(dict(ns), {})

    def test_sigint_after_manifest_commit_before_deletions_defers(self):
        import signal
        from unittest import mock

        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)
        from rlm.repl import _snapshot_state

        real_dump = json.dump

        def dump_then_sigint(obj, fh, **kwargs):
            real_dump(obj, fh, **kwargs)
            # Synchronous SIGINT right after the manifest commit, before any deletion.
            signal.raise_signal(signal.SIGINT)

        ns = {"big1": b"x" * 100_000, "big2": b"y" * 100_000}
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = os.path.join(tmp, "kernel-state.json")
            with mock.patch("json.dump", dump_then_sigint):
                with self.assertRaises(KeyboardInterrupt):
                    _snapshot_state(
                        ns,
                        os.path.join(tmp, "kernel-state.dill"),
                        manifest_path,
                        max_bytes=1 << 20,
                        max_variable_bytes=1024,
                        prune_oversized=True,
                    )
            # The deletions still ran: ns is consistent with the committed manifest.
            self.assertEqual(ns, {})
            with open(manifest_path) as fh:
                self.assertEqual(json.load(fh)["pruned"], ["big1", "big2"])


if __name__ == "__main__":
    unittest.main()
