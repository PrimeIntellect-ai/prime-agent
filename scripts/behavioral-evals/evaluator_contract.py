"""Deterministic fingerprint for the trusted behavioral evaluator contract."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Repository-relative files that define package construction, dependency resolution,
# fixed tasks and pins, candidate runtime, metric extraction, threshold comparison, and
# paired confirmation semantics.
CONTRACT_FILES = (
    "scripts/behavioral-evals/assemble.py",
    "scripts/behavioral-evals/build_controller.py",
    "scripts/behavioral-evals/builder.py",
    "scripts/behavioral-evals/confirm.py",
    "scripts/behavioral-evals/evaluate.py",
    "scripts/behavioral-evals/evaluation.py",
    "scripts/behavioral-evals/evaluator_contract.py",
    "scripts/behavioral-evals/prepare.py",
    "scripts/behavioral-evals/prime_agent_candidate.py",
    "scripts/behavioral-evals/short-swe.json",
    "scripts/behavioral-evals/trace_analyzer.py",
    "scripts/benchmarks/config.json",
    "scripts/benchmarks/pyproject.toml",
    "scripts/benchmarks/uv.lock",
)


def evaluator_contract_fingerprint(root: Path = ROOT) -> str:
    records = [
        {
            "path": relative,
            "sha256": hashlib.sha256((root / relative).read_bytes()).hexdigest(),
        }
        for relative in sorted(CONTRACT_FILES)
    ]
    encoded = json.dumps(records, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()
