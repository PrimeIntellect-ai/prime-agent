"""Live behavioral acceptance test for Prime's pinned NOOA integration.

Run with:
PYTHONPATH=packages/coding-agent/skills/autoresearch/src/autoresearch \
  uv run --no-project --python 3.13 --with nooa-memory==0.0.8 \
  python packages/coding-agent/skills/autoresearch/evals/nooa_behavior_eval.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

SKILL_SOURCE = Path(__file__).resolve().parents[1] / "src" / "autoresearch"
sys.path.insert(0, str(SKILL_SOURCE))

from nooa_sidecar import OWNER, run
from nooa_memory.store import MemoryStore


CODING_QUERY = (
    "coding task blocked by stale repository dependencies, expired environment cache, "
    "and invalid tool output"
)
AGRICULTURE_QUERY = (
    "smallholder crop stress sensor calibration under seasonal distribution shift"
)


def _memory(
    memory_id: str,
    memory_type: str,
    title: str,
    content: str,
    importance: int,
    tags: list[str],
) -> dict[str, Any]:
    return {
        "memoryId": memory_id,
        "type": memory_type,
        "title": title,
        "content": content,
        "importance": importance,
        "tags": tags,
        "sourceIds": [f"source-{memory_id}"],
        "currentStateReferences": [f"state-{memory_id}"],
        "createdAt": "2026-08-25T00:00:00.000Z",
    }


def _access_snapshot(path: Path) -> dict[str, dict[str, int]]:
    store = MemoryStore(path)
    try:
        return {
            memory.id: {
                "injected": memory.injected_count,
                "reinforced": memory.reinforced_count,
                "access": memory.access_count,
            }
            for memory in store.all_memories(include_archived=True, owner=OWNER)
        }
    finally:
        store.close()


def main() -> None:
    memories = [
        _memory(
            "relevant-stale-deps",
            "FAILED_DIRECTION",
            "Stale dependency lockfiles mislead coding agents",
            "Repository dependency versions and tool outputs become stale during long coding tasks.",
            7,
            ["coding", "dependency", "stale-state"],
        ),
        _memory(
            "related-env-cache",
            "REVIEWER_OBJECTION",
            "Environment cache validity must be checked",
            "A cached environment result can expire after package installation or branch changes.",
            6,
            ["environment", "cache", "tool-output"],
        ),
        _memory(
            "distractor-agriculture",
            "PAPER_FINDING",
            "Rice irrigation scheduling in monsoon climates",
            "Optimize crop water use using rainfall and soil moisture forecasts.",
            10,
            ["agriculture", "irrigation", "rice"],
        ),
        _memory(
            "distractor-vision",
            "PAPER_FINDING",
            "Underwater coral image segmentation",
            "Segment coral reef imagery with convolutional networks.",
            9,
            ["vision", "ocean"],
        ),
        _memory(
            "hard-distractor-coding-labels",
            "PAPER_FINDING",
            "Dependency cache optimization for coding agents",
            "Faster startup latency through compressed binary artifacts.",
            10,
            ["coding", "dependency", "cache"],
        ),
        _memory(
            "relevant-seasonal-sensor",
            "FAILED_DIRECTION",
            "Seasonal sensor calibration drift masks crop stress",
            "Smallholder field sensors shift across seasons and require calibration before transfer.",
            7,
            ["smallholder", "crop-stress", "sensor-drift", "seasonal-shift"],
        ),
        _memory(
            "related-smallholder-transfer",
            "REVIEWER_OBJECTION",
            "Smallholder seasonal transfer needs site calibration",
            "A distribution shift across farms can mimic crop stress in sensor time series.",
            6,
            ["smallholder", "distribution-shift", "crop-sensor"],
        ),
        _memory(
            "hard-distractor-agriculture-labels",
            "PAPER_FINDING",
            "Crop sensor procurement for smallholder programs",
            "Compare purchase prices, warranties, and shipping schedules.",
            10,
            ["smallholder", "crop", "sensor"],
        ),
    ]
    with tempfile.TemporaryDirectory(prefix="prime-nooa-behavior-") as directory:
        path = Path(directory) / "nooa-memory.sqlite"
        sync = run("sync", path, {"memories": memories})
        first = run(
            "spontaneous",
            path,
            {"query": CODING_QUERY, "limit": 3, "max_chars": 1200},
        )
        first_access = _access_snapshot(path)

        run("sync", path, {"memories": memories})
        after_sync = _access_snapshot(path)
        reopened = run(
            "spontaneous",
            path,
            {"query": CODING_QUERY, "limit": 3, "max_chars": 1200},
        )
        agriculture = run(
            "spontaneous",
            path,
            {"query": AGRICULTURE_QUERY, "limit": 3, "max_chars": 1200},
        )
        final_access = _access_snapshot(path)

        expected = {"relevant-stale-deps", "related-env-cache"}
        expected_agriculture = {"relevant-seasonal-sensor", "related-smallholder-transfer"}
        first_ids = set(first["memory_ids"])
        reopened_ids = set(reopened["memory_ids"])
        agriculture_ids = set(agriculture["memory_ids"])
        checks = {
            "coding_relevant_memories_recalled": expected <= first_ids,
            "coding_has_no_distractors": first_ids <= expected,
            "agriculture_relevant_memories_recalled": expected_agriculture <= agriculture_ids,
            "agriculture_has_no_distractors": agriculture_ids <= expected_agriculture,
            "contexts_are_bounded": first["chars"] <= 1200 and agriculture["chars"] <= 1200,
            "spontaneous_access_is_non_reinforcing": all(
                counters["reinforced"] == 0 and counters["access"] == 0
                for counters in final_access.values()
            ),
            "sync_preserves_access_state": after_sync == first_access,
            "reopen_preserves_recall_result": reopened_ids == first_ids,
        }
        report = {
            "passed": all(checks.values()),
            "checks": checks,
            "sync": sync,
            "first_recall": first,
            "access_after_first_recall": first_access,
            "access_after_sync": after_sync,
            "reopened_recall": reopened,
            "agriculture_recall": agriculture,
            "final_access": final_access,
        }
        print(json.dumps(report, indent=2, sort_keys=True))
        if not report["passed"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
