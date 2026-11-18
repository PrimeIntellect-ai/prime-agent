from __future__ import annotations

import asyncio
import importlib
import unittest
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")


class RlmEndTurnTest(unittest.TestCase):
    def test_namespace_delegates_the_sanctioned_end_turn_call(self) -> None:
        """The cell-facing `rlm` is the _RLMNamespace instance, not the
        module, so the namespace must expose `end_turn` (the bootstrap
        binds `rlm = _prime_agent_rlm_module.rlm`); otherwise the
        sanctioned terminal call raises AttributeError in every cell.
        """
        host_request = AsyncMock(return_value={"endedTurn": True})

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.end_turn())

        host_request.assert_awaited_once_with("rlm.end_turn", {})
        assert result == {"endedTurn": True}


if __name__ == "__main__":
    unittest.main()
