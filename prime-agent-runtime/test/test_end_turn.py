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

        host_request.assert_awaited_once_with("rlm.end_turn", {"cell": None})
        assert result == {"endedTurn": True}

    def test_end_turn_names_the_calling_cell(self) -> None:
        """The host marks the cell the request names, so a backgrounded
        cell's call cannot end a newer cell's turn."""
        repl = importlib.import_module("rlm.repl")
        host_request = AsyncMock(return_value={"endedTurn": True})
        token = repl._current_cell.set("cell-1")
        try:
            with patch.object(rlm_module, "host_request", host_request):
                asyncio.run(rlm_module.rlm.end_turn())
        finally:
            repl._current_cell.reset(token)

        host_request.assert_awaited_once_with("rlm.end_turn", {"cell": "cell-1"})


if __name__ == "__main__":
    unittest.main()
