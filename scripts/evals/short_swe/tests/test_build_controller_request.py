from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from scripts.evals.short_swe import build_controller  # noqa: E402


class _Captured(Exception):
    pass


def test_build_request_omits_vm(monkeypatch, tmp_path) -> None:
    """Sandboxes are VM-only: the create request must never pin a `vm` value."""
    monkeypatch.setenv("PRIME_SANDBOX_API_KEY", "test-key")
    captured = SimpleNamespace()

    class CaptureClient:
        def __init__(self, _api):
            pass

        def create(self, request):
            captured.request = request
            raise _Captured

    monkeypatch.setattr(build_controller, "SandboxClient", CaptureClient)
    with pytest.raises(_Captured):
        build_controller.build(
            repository="PrimeIntellect-ai/prime-agent",
            source_repository="PrimeIntellect-ai/prime-agent",
            sha="a" * 40,
            run_id=1,
            attempt=1,
            output=tmp_path,
            side="base",
        )
    payload = captured.request.model_dump(exclude_none=True)
    assert "vm" not in payload
    assert payload["docker_image"]
