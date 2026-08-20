"""Opt-in pytest coverage for the live Prime Agent kernel contract.

Run this *inside* a Prime Agent IPython cell after installing the harness::

    import os, pytest
    os.environ["PRIME_HARNESS_LIVE_KERNEL_E2E"] = "1"
    assert pytest.main(["C:/path/to/prime-harness/tests/test_live_kernel_e2e.py", "-q"]) == 0

Ordinary subprocess pytest has no host comm channel, so it skips cleanly.
"""

from __future__ import annotations

import asyncio
import os
import sys

import pytest

import harness_orchestrator as orch

LIVE_KERNEL = (
    os.environ.get("PRIME_HARNESS_LIVE_KERNEL_E2E") == "1"
    and "ipykernel" in sys.modules
    and bool(os.environ.get("RLM_SESSION_DIR"))
)

pytestmark = pytest.mark.skipif(
    not LIVE_KERNEL,
    reason="requires opt-in execution inside a live Prime Agent IPython kernel",
)


def test_live_kernel_selfcheck_passes() -> None:
    loop = asyncio.get_event_loop()
    report = loop.run_until_complete(orch.selfcheck())
    assert report["status"] == "pass", report
    assert not report["failures"], report
