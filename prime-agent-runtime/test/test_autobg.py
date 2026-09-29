from __future__ import annotations

import asyncio
import os
import time
import unittest
from unittest import mock

from rlm import bash
from rlm.bash import BashAutoBackgrounded, BashHandle, BashResult

from test_repl import ReplProcess, one, reply_ok, wait_for_host_request

AUTOBG_MS = "PRIME_AGENT_AUTOBG_MS"


class KnobTest(unittest.TestCase):
    def test_threshold_parsing(self):
        from rlm import autobg

        cases = [
            (None, 10.0),
            ("", 10.0),
            ("0", 0.0),
            ("1500", 1.5),
            ("junk", 10.0),
            ("-5", 10.0),
            (" 2500 ", 2.5),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                env = os.environ.copy()
                env.pop(AUTOBG_MS, None)
                if raw is not None:
                    env[AUTOBG_MS] = raw
                with mock.patch.dict(os.environ, env):
                    self.assertEqual(autobg.threshold_seconds(), expected)

    def test_non_finite_values_fall_back_to_the_default(self):
        # NaN compares false against every threshold check, which would
        # silently disable both guards; inf would never fire.
        from rlm import autobg

        for raw in ("nan", "NaN", "inf", "-inf", "infinity"):
            with self.subTest(raw=raw):
                with mock.patch.dict(os.environ, {AUTOBG_MS: raw}):
                    self.assertEqual(autobg.threshold_seconds(), 10.0)


class BashGuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_oneshot_await_degrades_to_the_handle(self):
        with mock.patch.dict(os.environ, {AUTOBG_MS: "400"}):
            started = time.monotonic()
            result = await bash("echo one; sleep 1.6; echo two")
            waited = time.monotonic() - started
        # Past the threshold, well before the 1.6s command finishes: the
        # await degraded to the handle, not the result.
        self.assertIsInstance(result, BashAutoBackgrounded)
        self.assertGreaterEqual(waited, 0.4)
        self.assertLess(waited, 1.3)
        self.assertIsInstance(result.handle, BashHandle)
        text = repr(result)
        self.assertIn("still running (pid", text)
        self.assertIn("poll or await later", text)
        self.assertIn("partial output", text)
        # The preview carries only the output written before the degrade.
        self.assertEqual(result.output(), "one\n")
        self.assertTrue(result.running)
        # The process keeps going: the wrapper's await still yields the result.
        finished = await result
        self.assertIsInstance(finished, BashResult)
        self.assertEqual(finished.exit_code, 0)
        self.assertIn("two", finished.output)
        self.assertGreaterEqual(finished.duration, 1.6)

    async def test_fast_await_completes_inline(self):
        with mock.patch.dict(os.environ, {AUTOBG_MS: "3000"}):
            started = time.monotonic()
            result = await bash("echo hi")
            waited = time.monotonic() - started
        # Under the threshold: the plain inline result, byte-identical to the
        # guard-off behavior.
        self.assertIsInstance(result, BashResult)
        self.assertNotIsInstance(result, BashAutoBackgrounded)
        self.assertEqual(result.output.strip(), "hi")
        self.assertLess(waited, 2.0)

    async def test_background_handle_await_degrades_without_killing(self):
        with mock.patch.dict(os.environ, {AUTOBG_MS: "400"}):
            handle = bash("sleep 1.2")
            handle.pid  # marks the handle as a deliberate background handle
            started = time.monotonic()
            result = await handle
            waited = time.monotonic() - started
        self.assertIsInstance(result, BashAutoBackgrounded)
        self.assertGreaterEqual(waited, 0.4)
        self.assertLess(waited, 1.0)
        self.assertTrue(handle.running)
        finished = await result
        self.assertEqual(finished.exit_code, 0)
        # The result is ready before the group reap; confirm the reap lands.
        deadline = time.monotonic() + 5
        while handle.running:
            self.assertLess(time.monotonic(), deadline, "the process group never reaped")
            await asyncio.sleep(0.05)

    async def test_owned_await_cancel_still_kills_the_command(self):
        # The one-shot kill-on-cancel contract is unchanged with the guard on.
        handles: list[BashHandle] = []

        async def one_shot() -> None:
            handle = bash("sleep 8; echo alive")
            handles.append(handle)
            await handle

        with mock.patch.dict(os.environ, {AUTOBG_MS: "30000"}):
            task = asyncio.ensure_future(one_shot())
            await asyncio.sleep(0.3)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            # The cancel killed the process group; confirm it is reaped.
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if handles[0].poll() is not None:
                    break
                await asyncio.sleep(0.05)
        self.assertIsNotNone(handles[0].poll())
        self.assertNotEqual(handles[0].poll().exit_code, 0)


class ReplAutoBgTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repl = ReplProcess(env={AUTOBG_MS: "1500"})
        self.addCleanup(self.repl.close)
        self.ready_event, self.ready_ms = self.repl.ready()

    def _poll_until(self, code: str, predicate, tries: int = 60, delay: float = 0.25) -> str:
        for _ in range(tries):
            events = self.repl.execute("poll", code)
            text = one(events, "result")["text"] if one(events, "result") else None
            if text is not None and predicate(text):
                return text
            time.sleep(delay)
        self.fail(f"never satisfied polling {code!r}")

    def test_sync_cell_degrades_frees_the_slot_and_polls(self):
        started = time.monotonic()
        events = self.repl.execute(
            "slow", 'import time\ntime.sleep(5)\nstate = "written"\n"cell-value"'
        )
        waited = time.monotonic() - started
        # The cell degraded at ~1.5s, long before its 5s sleep ends.
        self.assertLess(waited, 3.5)
        self.assertEqual(one(events, "done")["status"], "ok")
        note = one(events, "result")["text"]
        self.assertIn("auto-backgrounded", note)
        self.assertIn("shares the kernel namespace", note)
        self.assertIn("_bg_1", note)
        # The slot is free: the next cell completes while the first still runs.
        follow_started = time.monotonic()
        follow = self.repl.execute("quick", "quick = 1\nquick")
        self.assertLess(time.monotonic() - follow_started, 1.0)
        self.assertEqual(one(follow, "result")["text"], "1")
        # The future surfaces the cell's value; the namespace was shared.
        self.assertIn(
            "cell-value",
            self._poll_until("repr(_bg_1.poll())", lambda text: "cell-value" in text),
        )
        self.assertEqual(
            one(self.repl.execute("state", "state"), "result")["text"], "'written'"
        )

    def test_degrade_note_previews_partial_stdout(self):
        events = self.repl.execute(
            "tail", 'print("alpha")\nimport time\ntime.sleep(4)\nprint("omega")'
        )
        note = one(events, "result")["text"]
        self.assertIn("auto-backgrounded", note)
        self.assertIn("alpha", note)
        self.assertNotIn("omega", note)
        # The backgrounded cell's late writes still arrive, attributed to it.
        deadline = time.monotonic() + 6
        late = None
        while time.monotonic() < deadline:
            event = self.repl.read_event()
            if event.get("event") == "stdout" and event.get("id") == "tail":
                late = event["text"]
                if "omega" in late:
                    break
        self.assertIsNotNone(late, "the late write never arrived")
        self.assertIn("omega", late)

    def test_async_cell_degrades_and_its_exception_surfaces_at_poll(self):
        started = time.monotonic()
        events = self.repl.execute(
            "boom", "import asyncio\nawait asyncio.sleep(4)\nraise ValueError('cell-boom')"
        )
        waited = time.monotonic() - started
        self.assertLess(waited, 3.5)
        self.assertIn("auto-backgrounded", one(events, "result")["text"])
        follow = self.repl.execute("next", "y = 3\ny")
        self.assertEqual(one(follow, "result")["text"], "3")
        # poll() raises the backgrounded cell's failure: never silent.
        deadline = time.monotonic() + 8
        error = None
        while time.monotonic() < deadline:
            poll_events = self.repl.execute("poll", "_bg_1.poll()")
            error = one(poll_events, "error")
            if error is not None:
                break
            time.sleep(0.25)
        self.assertIsNotNone(error)
        self.assertEqual(error["ename"], "ValueError")
        self.assertIn("cell-boom", error["evalue"])

    def test_bash_await_degrades_with_the_handle_not_a_future(self):
        # The python guard defers to the bash guard: the cell resumes with the
        # bash handle, and the completion notice still reaches the host.
        started = time.monotonic()
        events = self.repl.execute(
            "bg",
            "from rlm import bash\n"
            "res = await bash('echo partial-out; sleep 5; echo done-out')\n"
            "res",
        )
        waited = time.monotonic() - started
        self.assertLess(waited, 3.5)
        note = one(events, "result")["text"]
        self.assertIn("bash await auto-backgrounded", note)
        self.assertIn("still running (pid", note)
        self.assertIn("partial output", note)
        self.assertIn("partial-out", note)
        self.assertEqual(one(events, "done")["status"], "ok")
        # The cell completed with the wrapper: the handle is model-reachable.
        kind = one(self.repl.execute("kind", "type(res).__name__"), "result")["text"]
        self.assertEqual(kind, "'BashAutoBackgrounded'")
        # The process completes untouched: its completion notice reaches the
        # host (the await never completed, so the handle was never awaited).
        request = wait_for_host_request(self.repl, [])
        self.assertEqual(request["data"]["type"], "bash.completed")
        self.assertEqual(request["data"]["exitCode"], 0)
        self.assertIn("done-out", request["data"]["command"])
        reply_ok(self.repl, request)
        # Only after the accepted notice may the model read the result, and the
        # read withdraws the notice (the existing withdrawal contract).
        deadline = time.monotonic() + 8
        finished = None
        poll_events: list[dict] = []
        while time.monotonic() < deadline:
            poll_events = self.repl.execute("poll", "repr(res.poll())")
            text = one(poll_events, "result")["text"] if one(poll_events, "result") else None
            if text and "BashResult" in text:
                finished = text
                break
            time.sleep(0.25)
        self.assertIsNotNone(finished)
        self.assertIn("done-out", finished)
        # The result read withdraws the accepted notice (the existing contract):
        # the bash.consumed request ships inside the reading cell.
        withdrawal = wait_for_host_request(self.repl, poll_events)
        self.assertEqual(withdrawal["data"]["type"], "bash.consumed")
        self.assertEqual(withdrawal["data"]["pid"], request["data"]["pid"])

    def test_gather_composed_bash_await_degrades_with_the_bash_handle(self):
        # gather wraps each awaitable in its own task: the bash guard races
        # in the child, and the cell guard must defer to it through the
        # wrapper chain (the cell resumes with the bash handle, not a future).
        started = time.monotonic()
        events = self.repl.execute(
            "gather",
            "from rlm import bash\n"
            "import asyncio\n"
            "res = await asyncio.gather(bash('sleep 5; echo gathered'))\n"
            "res[0]",
        )
        waited = time.monotonic() - started
        self.assertLess(waited, 3.5)
        note = one(events, "result")["text"]
        self.assertIn("bash await auto-backgrounded", note)
        self.assertIn("still running (pid", note)

    def test_bash_created_in_a_degraded_cell_still_notifies_an_idle_kernel(self):
        # The degrade leaves the worker running past the request; a bash()
        # spawned there schedules its notice from a foreign thread. The
        # loop-level bridge must wake the idle kernel, or the completion
        # notice never fires.
        started = time.monotonic()
        events = self.repl.execute(
            "late-bash",
            "from rlm import bash\n"
            "import time\n"
            "time.sleep(3)\n"
            "late = bash('sleep 0.3; printf late-notice')\n"
            "late.pid",
        )
        waited = time.monotonic() - started
        self.assertLess(waited, 2.5)
        self.assertIn("auto-backgrounded", one(events, "result")["text"])
        # The worker reaches the bash() spawn ~3s in; the bridge must wake the
        # idle kernel for the notice rather than queueing it unseen.
        request = wait_for_host_request(self.repl, [])
        self.assertEqual(request["data"]["type"], "bash.completed")
        self.assertIn("late-notice", request["data"]["command"])
        reply_ok(self.repl, request)

    def test_future_cancel_from_a_later_cell_stops_the_execution(self):
        events = self.repl.execute(
            "spawn-forever", "import time\ntime.sleep(30)\n'never'"
        )
        self.assertIn("auto-backgrounded", one(events, "result")["text"])
        follow = self.repl.execute("quick", "quick = 1\nquick")
        self.assertEqual(one(follow, "result")["text"], "1")
        # cancel() marshals onto the serving loop from this worker thread.
        stopped = self.repl.execute("stop", "_bg_1.cancel()")
        self.assertEqual(one(stopped, "done")["status"], "ok")

    def test_fast_paths_inline_with_the_guard_armed(self):
        events = self.repl.execute("fast", "print('fast-print')\n6*7")
        self.assertEqual(one(events, "result")["text"], "42")
        self.assertEqual(
            "".join(e["text"] for e in events if e.get("event") == "stdout"),
            "fast-print\n",
        )
        self.assertEqual(one(events, "done")["status"], "ok")
        bash_events = self.repl.execute(
            "fast-bash", "from rlm import bash\nfast = await bash('echo fast-ok')\nfast"
        )
        self.assertEqual(one(bash_events, "done")["status"], "ok")
        self.assertIn("exit_code=0", one(bash_events, "result")["text"])
        self.assertNotIn("auto-backgrounded", one(bash_events, "result")["text"])

    def test_interrupt_of_a_thread_cell_reports_and_recovers(self):
        self.repl.send({"type": "execute", "id": "wedge", "code": "import time\ntime.sleep(30)"})
        time.sleep(0.6)
        started = time.monotonic()
        self.repl.send({"type": "interrupt", "id": "wedge"})
        events = self.repl.until_done("wedge")
        waited = time.monotonic() - started
        self.assertLess(waited, 5.0)
        error = one(events, "error")
        self.assertEqual(error["ename"], "KeyboardInterrupt")
        self.assertEqual(one(events, "done")["status"], "error")
        follow = self.repl.execute("after", "after = 1\nafter")
        self.assertEqual(one(follow, "result")["text"], "1")


class ReplGuardOffTest(unittest.TestCase):
    def test_off_knob_preserves_blocking(self):
        repl = ReplProcess(env={AUTOBG_MS: "0"})
        self.addCleanup(repl.close)
        repl.ready()
        started = time.monotonic()
        events = repl.execute("blocked", "import time\ntime.sleep(2.0)\n'blocked'")
        waited = time.monotonic() - started
        self.assertGreaterEqual(waited, 1.9)
        self.assertEqual(one(events, "result")["text"], "'blocked'")
        self.assertEqual(one(events, "done")["status"], "ok")
        self.assertIsNone(one(events, "host_request"))
        started = time.monotonic()
        bash_events = repl.execute(
            "bash-blocked", "from rlm import bash\nslow = await bash('sleep 2.0; echo off-ok')\nslow"
        )
        waited = time.monotonic() - started
        self.assertGreaterEqual(waited, 1.9)
        self.assertEqual(one(bash_events, "done")["status"], "ok")
        self.assertIn("off-ok", one(bash_events, "result")["text"])
        self.assertNotIn("auto-backgrounded", one(bash_events, "result")["text"])


if __name__ == "__main__":
    unittest.main()
