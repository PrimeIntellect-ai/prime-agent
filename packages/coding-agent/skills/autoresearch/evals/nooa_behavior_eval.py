"""Live behavioral acceptance test for Prime's pinned NOOA integration.

Run with:
PYTHONPATH=packages/coding-agent/skills/autoresearch/src/autoresearch \
  uv run --no-project --python 3.13 --with nooa-memory==0.0.9 \
  python packages/coding-agent/skills/autoresearch/evals/nooa_behavior_eval.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

SKILL_SOURCE = Path(__file__).resolve().parents[1] / "src" / "autoresearch"
sys.path.insert(0, str(SKILL_SOURCE))

from nooa_sidecar import OWNER, run
from nooa_memory.store import MemoryStore


AVO_SIDECAR = Path(__file__).resolve().parents[2] / "avo" / "src" / "avo" / "nooa_sidecar.py"
AVO_SIDECAR_SPEC = importlib.util.spec_from_file_location("prime_avo_nooa_sidecar", AVO_SIDECAR)
if AVO_SIDECAR_SPEC is None or AVO_SIDECAR_SPEC.loader is None:
    raise RuntimeError(f"cannot load AVO NOOA sidecar from {AVO_SIDECAR}")
AVO_SIDECAR_MODULE = importlib.util.module_from_spec(AVO_SIDECAR_SPEC)
AVO_SIDECAR_SPEC.loader.exec_module(AVO_SIDECAR_MODULE)


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
        reconciliation_path = Path(directory) / "avo-nooa-memory.sqlite"
        reconciliation_memories = [
            {
                "memoryId": "memory:parser-api-v2",
                "type": "info",
                "namespace": "coding",
                "scope": "project",
                "verificationState": "verified",
                "title": "Parser API version",
                "content": "The current parser API version is version 2 for this repository.",
                "importance": 7,
                "tags": ["parser", "api"],
                "sourceIds": ["evaluation:v2"],
                "owner": "prime-root@behavior-eval",
                "createdAt": "2026-08-24T00:00:00.000Z",
            },
            {
                "memoryId": "memory:parser-api-v3",
                "type": "info",
                "namespace": "coding",
                "scope": "project",
                "verificationState": "verified",
                "title": "Parser API version",
                "content": "The current parser API version is version 3 for this repository.",
                "importance": 8,
                "tags": ["parser", "api"],
                "sourceIds": ["evaluation:v3"],
                "owner": "prime-root@behavior-eval",
                "createdAt": "2026-08-25T00:00:00.000Z",
            },
        ]
        reconciliation = AVO_SIDECAR_MODULE.run(
            "sync_reconciliation_candidates",
            reconciliation_path,
            {
                "stores": [
                    {
                        "path": str(reconciliation_path),
                        "scope": "project",
                        "owner": "prime-root@behavior-eval",
                        "owner_role": "prime-root",
                        "embedding": {"backend": "hashing"},
                        "memories": reconciliation_memories,
                    }
                ]
            },
        )
        task_scope_path = Path(directory) / "avo-task-scope.sqlite"
        project_scope_path = Path(directory) / "avo-project-scope.sqlite"
        task_scope_memories = [
            {
                "memoryId": f"task-note-{index}",
                "type": "info",
                "namespace": "general",
                "scope": "task",
                "verificationState": "proposed",
                "title": f"Quasar parser note {index}",
                "content": f"Quasar parser recovery scratch note {index}.",
                "importance": 1,
                "tags": ["quasar", "parser"],
                "sourceIds": [],
                "owner": "prime-root@behavior-eval",
                "createdAt": "2026-08-25T00:00:00.000Z",
            }
            for index in range(5)
        ]
        project_scope_memories = [
            {
                "memoryId": "project-critical",
                "type": "info",
                "namespace": "general",
                "scope": "project",
                "verificationState": "verified",
                "title": "Critical quasar parser recovery champion",
                "content": "Critical verified quasar parser recovery procedure for this repository.",
                "importance": 10,
                "tags": ["critical", "quasar", "parser", "champion"],
                "sourceIds": ["host:verified"],
                "owner": "prime-root@behavior-eval",
                "createdAt": "2026-08-25T00:00:00.000Z",
            }
        ]
        cross_scope = AVO_SIDECAR_MODULE.run(
            "sync_spontaneous",
            task_scope_path,
            {
                "stores": [
                    {
                        "path": str(task_scope_path),
                        "scope": "task",
                        "owner": "prime-root@behavior-eval",
                        "owner_role": "prime-root",
                        "embedding": {"backend": "hashing"},
                        "memories": task_scope_memories,
                    },
                    {
                        "path": str(project_scope_path),
                        "scope": "project",
                        "owner": "prime-root@behavior-eval",
                        "owner_role": "prime-root",
                        "embedding": {"backend": "hashing"},
                        "memories": project_scope_memories,
                    },
                ],
                "query": "critical quasar parser recovery champion",
                "limit": 5,
                "max_chars": 1200,
            },
        )
        importance_path = Path(directory) / "avo-importance-refresh.sqlite"
        importance_memories = [
            {
                "memoryId": "importance-rising",
                "type": "info",
                "namespace": "general",
                "scope": "project",
                "verificationState": "verified",
                "title": "Orion parser recovery evidence",
                "content": "Verified Orion parser recovery evidence from the host.",
                "importance": 1,
                "tags": ["orion", "parser", "recovery"],
                "sourceIds": ["host:first"],
                "owner": "prime-root@behavior-eval",
                "createdAt": "2026-08-25T00:00:00.000Z",
            },
            {
                "memoryId": "importance-steady",
                "type": "info",
                "namespace": "general",
                "scope": "project",
                "verificationState": "verified",
                "title": "Orion parser recovery evidence",
                "content": "Verified Orion parser recovery evidence from the host.",
                "importance": 5,
                "tags": ["orion", "parser", "recovery"],
                "sourceIds": ["host:second"],
                "owner": "prime-root@behavior-eval",
                "createdAt": "2026-08-25T00:00:00.000Z",
            },
        ]
        importance_payload = {
            "stores": [
                {
                    "path": str(importance_path),
                    "scope": "project",
                    "owner": "prime-root@behavior-eval",
                    "owner_role": "prime-root",
                    "embedding": {"backend": "hashing"},
                    "memories": importance_memories,
                }
            ],
            "query": "Orion parser recovery evidence",
            "limit": 5,
            "max_chars": 1200,
        }
        AVO_SIDECAR_MODULE.run("sync_spontaneous", importance_path, importance_payload)
        importance_memories[0]["importance"] = 10
        refreshed_importance = AVO_SIDECAR_MODULE.run(
            "sync_spontaneous",
            importance_path,
            importance_payload,
        )
        importance_memories[0]["verificationState"] = "contested"
        contested_recall = AVO_SIDECAR_MODULE.run(
            "sync_spontaneous",
            importance_path,
            importance_payload,
        )

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
            "nooa_finds_semantic_reconciliation_candidates": any(
                set(cluster.get("memory_ids", []))
                == {"memory:parser-api-v2", "memory:parser-api-v3"}
                for cluster in reconciliation.get("clusters", [])
            ),
            "cross_scope_ranking_does_not_starve_verified_project_memory": (
                "project-critical" in cross_scope.get("memory_ids", [])
            ),
            "canonical_importance_increase_refreshes_nooa_ranking": (
                refreshed_importance.get("memory_ids", [None])[0] == "importance-rising"
            ),
            "contested_memory_is_not_recalled_by_nooa": (
                "importance-rising" not in contested_recall.get("memory_ids", [])
            ),
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
            "reconciliation_candidates": reconciliation,
            "cross_scope_recall": cross_scope,
            "refreshed_importance_recall": refreshed_importance,
            "contested_recall": contested_recall,
        }
        print(json.dumps(report, indent=2, sort_keys=True))
        if not report["passed"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
