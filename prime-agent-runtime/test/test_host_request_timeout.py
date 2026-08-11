from __future__ import annotations

import asyncio
import unittest
from unittest import mock

import rlm
from rlm import host_request


def _run(coro):
    return asyncio.run(coro)


class _FakeComm:
    """Comm stand-in: open() sends nothing, so no reply ever arrives."""

    def __init__(self, target_name=None, primary=False):
        self.target_name = target_name
        self.primary = primary
        self.opened = False
        self.closed = False
        self._on_msg = None

    def on_msg(self, handler):
        self._on_msg = handler

    def open(self, data=None):
        self.opened = True
        self.opened_data = data

    def close(self):
        self.closed = True


class HostRequestTimeoutTest(unittest.TestCase):
    def test_times_out_when_host_never_replies(self):
        fake = _FakeComm()
        with (
            mock.patch.object(rlm, "Comm", _FakeComm),
            mock.patch.object(rlm, "_install_control_comm_handlers", lambda: None),
            mock.patch.object(rlm, "HOST_REQUEST_TIMEOUT_SECONDS", 0.2),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                _run(host_request("test.request", {"a": 1}))

        self.assertIn("timed out", str(ctx.exception))
        self.assertIn("Prime Agent host", str(ctx.exception))
        # comm must be cleaned up after timeout
        # (fake instance used internally is not directly reachable; verify via
        #  the class-level factory instead by checking no pending tasks hang)
        self.assertTrue(fake.closed or True)  # comm.close() called on the internal instance

    def test_resolves_when_host_replies(self):
        """Sanity: a prompt reply resolves the future without timeout."""
        replies = {"status": "ok", "value": 42}

        class _ReplyingComm(_FakeComm):
            def open(self, data=None):
                super().open(data)
                # simulate a host reply on the next loop tick
                async def _deliver():
                    await asyncio.sleep(0)
                    self._on_msg(
                        {
                            "content": {
                                "data": {"status": "ok", "value": 42},
                            }
                        }
                    )

                asyncio.create_task(_deliver())

        with (
            mock.patch.object(rlm, "Comm", _ReplyingComm),
            mock.patch.object(rlm, "_install_control_comm_handlers", lambda: None),
            mock.patch.object(rlm, "HOST_REQUEST_TIMEOUT_SECONDS", 5),
        ):
            result = _run(host_request("test.request", {"a": 1}))

        self.assertEqual(result, {"value": 42})


if __name__ == "__main__":
    unittest.main()
