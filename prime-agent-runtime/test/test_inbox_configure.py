from __future__ import annotations

import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

SRC = os.path.join(os.path.dirname(__file__), "..", "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

import rlm  # noqa: E402


class RlmInboxConfigureTest(unittest.TestCase):
    def test_configure_sends_the_mode(self) -> None:
        host_request = AsyncMock(return_value={"mode": "push", "pinned": True, "digest": False})
        with patch.object(rlm, "host_request", host_request):
            result = asyncio.run(rlm.rlm.inbox.configure("push"))
        self.assertEqual(result["pinned"], True)
        host_request.assert_awaited_once_with("rlm.inbox.configure", {"mode": "push"})

    def test_configure_rejects_invalid_modes_before_the_host_request(self) -> None:
        host_request = AsyncMock(return_value={})
        with patch.object(rlm, "host_request", host_request):
            with self.assertRaises(ValueError):
                asyncio.run(rlm.rlm.inbox.configure("sideways"))
        host_request.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
