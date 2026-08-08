from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HARNESS_ROOT = Path(__file__).resolve().parents[1]


def test_fresh_template_check_suites_pass() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "template/checks/properties",
            "template/checks/invariants",
            "template/checks/hidden_holdout",
        ],
        cwd=HARNESS_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
