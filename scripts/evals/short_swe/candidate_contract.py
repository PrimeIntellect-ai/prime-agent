"""Pure security checks shared by the Short SWE candidate harness and tests."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

VERSION = "0.0.0-benchmark"
TARBALLS = tuple(
    f"{name}-{VERSION}.tgz"
    for name in ("prime-agent", "prime-agent-ai", "prime-agent-core", "prime-agent-tui")
)
CREDENTIAL_ENV = ("PRIME_API_KEY", "PRIME_SANDBOX_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "HF_TOKEN")
SHA256_RE = re.compile(r"[0-9a-f]{64}")


def process_env(env: dict[str, str]) -> dict[str, str]:
    """Override inherited host credential names before a candidate-controlled process starts."""
    return {**env, **dict.fromkeys(CREDENTIAL_ENV, "")}


def require_non_autonomous(value: bool) -> bool:
    if value:
        raise ValueError("candidate harness requires autonomous=false")
    return value


def validate_checksums(value: dict[str, str] | None) -> dict[str, str] | None:
    if value is None:
        return None
    if set(value) != set(TARBALLS) or any(SHA256_RE.fullmatch(digest) is None for digest in value.values()):
        raise ValueError("checksums must name the four tarballs with lowercase SHA256 values")
    return value


def load_artifacts(root: Path, expected: dict[str, str] | None) -> tuple[dict[str, bytes], dict[str, str]]:
    if not root.is_dir():
        raise ValueError(f"artifact_dir is not a directory: {root}")
    names = {path.name for path in root.glob("*.tgz")}
    if names != set(TARBALLS) or any(not (root / name).is_file() for name in TARBALLS):
        raise ValueError("artifact_dir must contain exactly the four candidate tarballs")
    blobs = {name: (root / name).read_bytes() for name in TARBALLS}
    computed = {name: hashlib.sha256(data).hexdigest() for name, data in blobs.items()}
    if expected is not None and computed != expected:
        raise ValueError("candidate tarball checksum mismatch")
    return blobs, expected or computed
