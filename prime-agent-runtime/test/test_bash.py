from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from unittest import mock

from rlm import bash


class BashTest(unittest.IsolatedAsyncioTestCase):
    async def test_await_returns_result(self):
        result = await bash("echo hi")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        self.assertGreaterEqual(result.duration, 0)

        handle = bash("echo again")
        awaited = await handle
        self.assertEqual(handle.poll(), awaited)

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
            self.assertEqual(result.exit_code, 0)
            lines = result.output.splitlines()
            self.assertEqual(lines[0], "prefixed")
            self.assertIn("1 dumb", lines[1])

            with open(journal) as f:
                records = [json.loads(line) for line in f if line.strip()]
            self.assertEqual([r["active"] for r in records], [True, False])
            for record in records:
                self.assertEqual(record["pid"], handle.pid)
                self.assertEqual(record["ownerPid"], os.getpid())
                self.assertEqual(record["kernelPid"], os.getpid())
            self.assertTrue(records[0]["processStartId"].startswith(("proc:", "ps:")))


if __name__ == "__main__":
    unittest.main()
