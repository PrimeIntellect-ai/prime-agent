"""Public CI transport smoke only — this is not scientific holdout evidence.

Its sole purpose is to keep the checked-in ``holdout`` profile executable on a
fresh/offline install. Real adversarial holdouts must be injected by protected
CI infrastructure and must never be committed here or shown to the agent.
"""

from __future__ import annotations

import json
from pathlib import Path


def test_public_holdout_transport_reaches_existing_profile() -> None:
    root = Path(__file__).resolve().parents[2]
    manifest = json.loads((root / "harness" / "manifest.json").read_text(encoding="utf-8"))
    command = manifest["profiles"]["holdout"]["required"][0]["command"]
    assert command == "python -m pytest -q checks/hidden_holdout"
