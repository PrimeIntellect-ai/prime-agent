from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROUTING = ROOT / "template/harness/model_routing.py"
REPLAY = ROOT / "template/harness/replay.py"
SHARED = ROOT / "template/harness/numeric_reference.py"


def test_routing_and_replay_share_reviewable_decimal_expm1_oracle():
    routing_text = ROUTING.read_text(encoding="utf-8")
    replay_text = REPLAY.read_text(encoding="utf-8")
    test_text = Path(__file__).read_text(encoding="utf-8")

    assert SHARED.is_file()
    assert "from numeric_reference import decimal_expm1" in routing_text
    assert "from numeric_reference import decimal_expm1" in replay_text
    assert not re.search(r";\s*[A-Za-z_]", routing_text)
    assert not any(
        line.startswith(" ") and not line.startswith("    ")
        for line in routing_text.splitlines()
    )
    assert not re.search(r";\s*[A-Za-z_]", test_text)
