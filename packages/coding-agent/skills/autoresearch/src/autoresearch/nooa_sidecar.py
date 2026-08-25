"""Pinned Python 3.13 bridge to NOOA's real memory index and retrieval engine."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from nooa_memory.config import MemoryConfig
from nooa_memory.embeddings import get_embedder
from nooa_memory.retrieval import RetrievalEngine
from nooa_memory.schema import Memory, MemoryType
from nooa_memory.store import MemoryStore


OWNER = "prime-autoresearch"


def _memory_type(value: str) -> MemoryType:
    return {
        "USEFUL_SEARCH_QUERY": MemoryType.SKILL,
        "FAILED_DIRECTION": MemoryType.EPISODE,
        "EXPERIMENT_RESULT": MemoryType.EPISODE,
        "REVIEWER_OBJECTION": MemoryType.REFLECTION,
        "SUPERVISOR_INTERVENTION": MemoryType.REFLECTION,
        "OPEN_QUESTION": MemoryType.TODO,
    }.get(value, MemoryType.INFO)


def _record(value: dict[str, Any]) -> Memory:
    return Memory(
        id=str(value["memoryId"]),
        type=_memory_type(str(value["type"])),
        title=str(value["title"]),
        content=str(value["content"]),
        importance=float(value["importance"]),
        tags=[str(tag) for tag in value.get("tags", [])],
        source_task_ref=",".join(str(source) for source in value.get("sourceIds", [])) or None,
        related_files=[str(reference) for reference in value.get("currentStateReferences", [])],
        owner=OWNER,
        archived=bool(value.get("invalidatedAt")),
    )


def _components(path: Path) -> tuple[MemoryStore, Any, MemoryConfig]:
    config = MemoryConfig(enabled=True, path=str(path), owner=OWNER)
    embedder = get_embedder(config.embedding)
    store = MemoryStore(path, vector_config=config.vector, embedding_dim=config.embedding.dim)
    return store, embedder, config


def _upsert(store: MemoryStore, embedder: Any, value: dict[str, Any]) -> None:
    record = _record(value)
    embedding_text = "\n".join([record.title or "", record.content, " ".join(record.tags)])
    store.add(record, embedder.embed(embedding_text))


def run(command: str, path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    store, embedder, config = _components(path)
    try:
        if command == "upsert":
            memory = payload.get("memory")
            if not isinstance(memory, dict):
                raise ValueError("upsert requires a memory object")
            _upsert(store, embedder, memory)
            return {"ok": True, "mirrored": 1}
        if command == "sync":
            memories = payload.get("memories")
            if not isinstance(memories, list):
                raise ValueError("sync requires a memories array")
            valid = [memory for memory in memories if isinstance(memory, dict)]
            canonical_ids = {str(memory["memoryId"]) for memory in valid}
            for existing in store.all_memories(include_archived=True, owner=OWNER):
                if existing.id not in canonical_ids:
                    store.delete(existing.id)
            for memory in valid:
                _upsert(store, embedder, memory)
            return {"ok": True, "mirrored": len(valid)}
        if command == "recall":
            query = payload.get("query")
            limit = payload.get("limit", 8)
            if not isinstance(query, str) or not query.strip():
                raise ValueError("recall requires a non-empty query")
            if not isinstance(limit, int) or not 1 <= limit <= 50:
                raise ValueError("recall limit must be an integer from 1 to 50")
            engine = RetrievalEngine(
                store,
                embedder,
                config.retrieval,
                access_log_cap=config.observability.access_log_cap,
            )
            recalled = engine.recall(query, k=limit, owner=OWNER)
            return {
                "ok": True,
                "memory_ids": [memory.id for memory in recalled],
                "retrieval": "NOOA hybrid dense+sparse, ACT-R scoring, one-hop spread",
            }
        raise ValueError(f"unknown command {command!r}")
    finally:
        store.close()


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: nooa_sidecar.py <upsert|sync|recall> <sqlite-path>")
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("sidecar input must be a JSON object")
    print(json.dumps(run(sys.argv[1], Path(sys.argv[2]), payload)))


if __name__ == "__main__":
    main()
