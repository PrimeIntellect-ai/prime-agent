"""Pinned Python 3.13 bridge to NOOA's real memory index and retrieval engine."""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from nooa_memory.config import MemoryConfig
from nooa_memory.embeddings import get_embedder
from nooa_memory.retrieval import RetrievalEngine
from nooa_memory.reflection import ReflectionEngine
from nooa_memory.schema import AccessRecord, Memory, MemoryType
from nooa_memory.store import MemoryStore


OWNER = "prime-autoresearch"

_CUE_STOPWORDS = {
    "about",
    "after",
    "and",
    "agent",
    "are",
    "before",
    "being",
    "but",
    "can",
    "caused",
    "could",
    "during",
    "each",
    "for",
    "has",
    "failure",
    "from",
    "have",
    "how",
    "into",
    "its",
    "long",
    "may",
    "not",
    "observation",
    "our",
    "out",
    "over",
    "research",
    "should",
    "that",
    "the",
    "their",
    "then",
    "this",
    "through",
    "too",
    "under",
    "using",
    "was",
    "were",
    "when",
    "which",
    "with",
    "would",
}


def _cue_terms(value: str) -> set[str]:
    terms: set[str] = set()
    current: list[str] = []
    for character in value.lower():
        if character.isalnum():
            current.append(character)
            continue
        if current:
            term = "".join(current)
            current = []
            if len(term) > 2 and term not in _CUE_STOPWORDS:
                terms.add(_stem_cue(term))
    if current:
        term = "".join(current)
        if len(term) > 2 and term not in _CUE_STOPWORDS:
            terms.add(_stem_cue(term))
    return terms


def _stem_cue(term: str) -> str:
    if len(term) > 5 and term.endswith("ies"):
        return f"{term[:-3]}y"
    if len(term) > 4 and term.endswith("s") and not term.endswith("ss"):
        return term[:-1]
    return term


def _precision_score(memory: Memory, query_terms: set[str]) -> int:
    title_terms = _cue_terms(memory.title or "")
    tag_terms = _cue_terms(" ".join(memory.tags))
    content_terms = _cue_terms(memory.content)
    title_overlap = len(query_terms & title_terms)
    tag_overlap = len(query_terms & tag_terms)
    content_overlap = len(query_terms & content_terms)
    labelled_overlap = title_overlap + tag_overlap
    if content_overlap < 2 and (labelled_overlap == 0 or content_overlap == 0):
        return 0
    return 4 * title_overlap + 3 * tag_overlap + content_overlap


def _high_precision_memories(memories: list[Memory], query: str, limit: int) -> list[Memory]:
    query_terms = _cue_terms(query)
    if not query_terms:
        return []
    scored = [
        (memory, _precision_score(memory, query_terms), rank)
        for rank, memory in enumerate(memories)
    ]
    return [
        memory
        for memory, score, _rank in sorted(
            (item for item in scored if item[1] > 0),
            key=lambda item: (-item[1], item[2]),
        )[:limit]
    ]


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
    created_at = value.get("createdAt")
    parsed_created_at = None
    if isinstance(created_at, str):
        try:
            parsed_created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
        except ValueError:
            parsed_created_at = None
    kwargs: dict[str, Any] = {
        "id": str(value["memoryId"]),
        "type": _memory_type(str(value["type"])),
        "title": str(value["title"]),
        "content": str(value["content"]),
        "importance": float(value["importance"]),
        "tags": [str(tag) for tag in value.get("tags", [])],
        "source_task_ref": ",".join(str(source) for source in value.get("sourceIds", [])) or None,
        "related_files": [str(reference) for reference in value.get("currentStateReferences", [])],
        "owner": OWNER,
        "archived": bool(value.get("invalidatedAt")),
    }
    if parsed_created_at is not None:
        kwargs["created_at"] = parsed_created_at
    return Memory(
        **kwargs,
    )


def _components(path: Path) -> tuple[MemoryStore, Any, MemoryConfig]:
    config = MemoryConfig(enabled=True, path=str(path), owner=OWNER)
    embedder = get_embedder(config.embedding)
    store = MemoryStore(path, vector_config=config.vector, embedding_dim=config.embedding.dim)
    return store, embedder, config


def _upsert(store: MemoryStore, embedder: Any, value: dict[str, Any]) -> None:
    record = _record(value)
    existing = store.get(record.id)
    if existing is not None:
        record.created_at = existing.created_at
        record.last_accessed_at = existing.last_accessed_at
        record.access_log = existing.access_log
        record.access_count = existing.access_count
        record.recalled_count = existing.recalled_count
        record.searched_count = existing.searched_count
        record.injected_count = existing.injected_count
        record.reinforced_count = existing.reinforced_count
        record.deref_count = existing.deref_count
        record.salience = existing.salience
        record.confidence = existing.confidence
        record.strength = existing.strength
        record.reinforcement_count = existing.reinforcement_count
        record.importance = existing.importance
        record.edges = existing.edges
        record.archived = record.archived or existing.archived
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
        if command == "spontaneous":
            query = payload.get("query")
            limit = payload.get("limit", 5)
            max_chars = payload.get("max_chars", 2000)
            if not isinstance(query, str) or not query.strip():
                raise ValueError("spontaneous recall requires a non-empty query")
            if not isinstance(limit, int) or not 1 <= limit <= 20:
                raise ValueError("spontaneous recall limit must be an integer from 1 to 20")
            if not isinstance(max_chars, int) or not 256 <= max_chars <= 8000:
                raise ValueError("spontaneous recall max_chars must be an integer from 256 to 8000")
            engine = RetrievalEngine(
                store,
                embedder,
                config.retrieval,
                access_log_cap=config.observability.access_log_cap,
            )
            candidate_limit = min(50, max(limit * 4, limit))
            candidates = engine.recall(query, k=candidate_limit, touch=False, owner=OWNER)
            recalled = _high_precision_memories(candidates, query, limit)
            lines = ["## Recalled research memories (associative)"]
            for memory in recalled:
                head = (memory.title or memory.content).replace("\n", " ").strip()
                lines.append(f"- [{memory.type.value}#{memory.id[:8]}] {head}")
                memory.log_access(
                    AccessRecord(ts=time.time(), channel="injected", reader_owner=OWNER, query=query[:500]),
                    reinforce=False,
                    cap=config.observability.access_log_cap,
                )
                store.save(memory)
            context = "\n".join(lines) if recalled else ""
            if len(context) > max_chars:
                context = context[:max_chars].rstrip() + " …"
            return {
                "ok": True,
                "memory_ids": [memory.id for memory in recalled],
                "context": context,
                "chars": len(context),
                "touch": False,
                "candidate_count": len(candidates),
                "precision_filtered_count": len(candidates) - len(recalled),
                "retrieval": (
                    "NOOA spontaneous hybrid dense+sparse, ACT-R scoring, one-hop spread, "
                    "then lexical precision filtering"
                ),
            }
        if command == "reflect":
            previously_archived = {
                memory.id
                for memory in store.all_memories(include_archived=True, owner=OWNER)
                if memory.archived
            }
            engine = ReflectionEngine(
                store,
                embedder,
                config.reflection,
                config.forget,
                owner=OWNER,
            )
            report = engine.consolidate()
            report_data = report.model_dump(exclude_none=True)
            store.log_maintenance("reflect", {"trigger": payload.get("trigger", "manual"), **report_data})
            archived = [
                memory.id
                for memory in store.all_memories(include_archived=True, owner=OWNER)
                if memory.archived and memory.id not in previously_archived
            ]
            return {
                "ok": True,
                "report": report_data,
                "archived_memory_ids": archived,
                "reflection": "official NOOA deterministic merge, graph edges, importance rescore, and pruning",
            }
        raise ValueError(f"unknown command {command!r}")
    finally:
        store.close()


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: nooa_sidecar.py <upsert|sync|recall|spontaneous|reflect> <sqlite-path>")
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("sidecar input must be a JSON object")
    print(json.dumps(run(sys.argv[1], Path(sys.argv[2]), payload)))


if __name__ == "__main__":
    main()
