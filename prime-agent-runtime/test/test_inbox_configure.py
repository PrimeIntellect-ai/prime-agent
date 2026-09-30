from __future__ import annotations

import asyncio
import importlib
import unittest
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")


class RlmInboxConfigureTest(unittest.TestCase):
    def test_configure_sends_the_mode(self) -> None:
        host_request = AsyncMock(return_value={"mode": "push", "pinned": True, "digest": False})
        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.inbox.configure("push"))
        self.assertEqual(result["pinned"], True)
        host_request.assert_awaited_once_with("rlm.inbox.configure", {"mode": "push"})


if __name__ == "__main__":
    unittest.main()
