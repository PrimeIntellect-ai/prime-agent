"""Pinned Python 3.13 bridge to NOOA's real memory index and retrieval engine."""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from nooa_memory.config import EmbeddingConfig, MemoryConfig
from nooa_memory.embeddings import get_embedder
from nooa_memory.retrieval import RetrievalEngine
from nooa_memory.reflection import ReflectionEngine
from nooa_memory.schema import AccessRecord, Edge, EdgeType, Memory, MemoryRef, MemoryType
from nooa_memory.store import MemoryStore


OWNER = "prime-avo"

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
    "coding",
    "general",
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
    normalized = value.strip().lower()
    try:
        return MemoryType(normalized)
    except ValueError:
        pass
    return {
        "USEFUL_SEARCH_QUERY": MemoryType.SKILL,
        "FAILED_DIRECTION": MemoryType.EPISODE,
        "EXPERIMENT_RESULT": MemoryType.EPISODE,
        "REVIEWER_OBJECTION": MemoryType.REFLECTION,
        "SUPERVISOR_INTERVENTION": MemoryType.REFLECTION,
        "OPEN_QUESTION": MemoryType.TODO,
    }.get(value.upper(), MemoryType.INFO)


def _record(value: dict[str, Any]) -> Memory:
    created_at = value.get("createdAt")
    parsed_created_at = None
    if isinstance(created_at, str):
        try:
            parsed_created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
        except ValueError:
            parsed_created_at = None
    references: list[MemoryRef] = []
    for reference in value.get("references", []):
        if not isinstance(reference, dict):
            continue
        kind = str(reference.get("kind", ""))
        key = str(reference.get("key", ""))
        if kind not in {"file", "memory"} or not key:
            continue
        references.append(
            MemoryRef(
                kind=kind,
                key=key,
                preview=str(reference["preview"]) if reference.get("preview") else None,
            )
        )
    verification = str(value.get("verificationState", "proposed"))
    scope = str(value.get("scope", "task"))
    memory_type = _memory_type(str(value["type"]))
    edges = []
    if memory_type in {MemoryType.REFLECTION, MemoryType.SKILL}:
        edges = [
            Edge(target_id=str(source), type=EdgeType.DERIVED_FROM, weight=1.0)
            for source in value.get("sourceIds", [])
            if str(source).startswith(("memory-", "episode:"))
        ]
    kwargs: dict[str, Any] = {
        "id": str(value["memoryId"]),
        "type": memory_type,
        "title": str(value["title"]),
        "content": str(value["content"]),
        "importance": float(value["importance"]),
        "tags": [
            *[str(tag) for tag in value.get("tags", [])],
            f"namespace:{value.get('namespace', 'general')}",
            f"scope:{scope}",
            f"verification:{verification}",
        ],
        "source_task_ref": ",".join(str(source) for source in value.get("sourceIds", [])) or None,
        "related_files": [str(reference) for reference in value.get("currentStateReferences", [])],
        "owner": str(value.get("owner", OWNER)),
        "references": references,
        "edges": edges,
        "archived": bool(value.get("invalidatedAt")) or verification == "invalidated",
    }
    if parsed_created_at is not None:
        kwargs["created_at"] = parsed_created_at
    return Memory(
        **kwargs,
    )


def _components(path: Path, payload: dict[str, Any]) -> tuple[MemoryStore, Any, MemoryConfig]:
    embedding_payload = payload.get("embedding")
    embedding_values = embedding_payload if isinstance(embedding_payload, dict) else {}
    if embedding_values.get("dimensions") is not None:
        try:
            embedding_values = {
                **embedding_values,
                "dimensions": int(embedding_values["dimensions"]),
            }
        except (TypeError, ValueError):
            embedding_values = {**embedding_values, "dimensions": None}
    embedding_values = {
        key: value
        for key, value in embedding_values.items()
        if value is not None and value != ""
    }
    owner = str(payload.get("owner", OWNER))
    config = MemoryConfig(
        enabled=True,
        path=str(path),
        owner=owner,
        embedding=EmbeddingConfig(**embedding_values),
    )
    embedder = get_embedder(config.embedding)
    store = MemoryStore(path, vector_config=config.vector, embedding_dim=embedder.dim)
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
        if str(value.get("verificationState", "proposed")) != "verified":
            record.archived = record.archived or existing.archived
    embedding_text = "\n".join([record.title or "", record.content, " ".join(record.tags)])
    store.add(record, embedder.embed(embedding_text))


def run(command: str, path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    if command in {
        "sync_spontaneous",
        "sync_reflect",
        "sync_reconciliation_candidates",
    }:
        stores = payload.get("stores")
        if not isinstance(stores, list) or not stores:
            raise ValueError(f"{command} requires a non-empty stores array")
        results: list[dict[str, Any]] = []
        memory_ids: list[str] = []
        archived_ids: list[str] = []
        aggregate_report: dict[str, int | float | bool | str] = {}
        for item in stores:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                continue
            item_path = Path(item["path"])
            sync = run("sync", item_path, item)
            if command == "sync_spontaneous":
                result = run(
                    "spontaneous",
                    item_path,
                    {
                        **item,
                        "query": payload.get("query"),
                        "limit": payload.get("limit", 5),
                        "max_chars": payload.get("max_chars", 2000),
                    },
                )
                for memory_id in result.get("memory_ids", []):
                    if isinstance(memory_id, str) and memory_id not in memory_ids:
                        memory_ids.append(memory_id)
                results.append({"scope": item.get("scope"), "sync": sync, "recall": result})
            elif command == "sync_reflect":
                result = run(
                    "reflect",
                    item_path,
                    {**item, "trigger": payload.get("trigger", "manual")},
                )
                for memory_id in result.get("archived_memory_ids", []):
                    if isinstance(memory_id, str) and memory_id not in archived_ids:
                        archived_ids.append(memory_id)
                report = result.get("report")
                if isinstance(report, dict):
                    for key, value in report.items():
                        if isinstance(value, bool):
                            aggregate_report[key] = bool(aggregate_report.get(key, False)) or value
                        elif isinstance(value, (int, float)):
                            aggregate_report[key] = float(aggregate_report.get(key, 0)) + value
                        elif isinstance(value, str) and value:
                            aggregate_report[key] = value
                results.append({"scope": item.get("scope"), "sync": sync, "reflection": result})
            else:
                result = run("reconciliation_candidates", item_path, item)
                for cluster in result.get("clusters", []):
                    if isinstance(cluster, dict):
                        results.append({"scope": item.get("scope"), "sync": sync, "cluster": cluster})
        if command == "sync_spontaneous":
            limit = payload.get("limit", 5)
            bounded = memory_ids[: limit if isinstance(limit, int) and limit > 0 else 5]
            return {
                "ok": True,
                "memory_ids": bounded,
                "stores": results,
                "retrieval": (
                    "NOOA 0.0.9 hybrid dense+sparse, ACT-R scoring, owner-scoped "
                    "one-hop spread, and non-reinforcing spontaneous injection"
                ),
            }
        if command == "sync_reflect":
            return {
                "ok": True,
                "report": aggregate_report,
                "archived_memory_ids": archived_ids,
                "stores": results,
            }
        return {
            "ok": True,
            "clusters": [
                {"scope": result.get("scope"), **result["cluster"]}
                for result in results
                if isinstance(result.get("cluster"), dict)
            ],
        }
    store, embedder, config = _components(path, payload)
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
            for existing in store.all_memories(include_archived=True, owner=None):
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
            owner_scope = str(payload.get("owner_role", payload.get("owner", OWNER)))
            recalled = engine.recall(query, k=limit, owner=owner_scope)
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
            owner_scope = str(payload.get("owner_role", payload.get("owner", OWNER)))
            candidates = engine.recall(query, k=candidate_limit, touch=False, owner=owner_scope)
            recalled = _high_precision_memories(candidates, query, limit)
            lines = ["## Recalled AVO memories (associative)"]
            for memory in recalled:
                head = (memory.title or memory.content).replace("\n", " ").strip()
                lines.append(f"- [{memory.type.value}#{memory.id[:8]}] {head}")
                memory.log_access(
                    AccessRecord(
                        ts=time.time(),
                        channel="injected",
                        reader_owner=str(payload.get("owner", OWNER)),
                        query=query[:500],
                    ),
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
        if command == "reconciliation_candidates":
            owner_scope = str(payload.get("owner_role", payload.get("owner", OWNER)))
            eligible = {
                memory.id: memory
                for memory in store.all_memories(owner=owner_scope)
                if not memory.archived
                and memory.type in {MemoryType.INFO, MemoryType.SKILL, MemoryType.REFLECTION}
                and "verification:contested" not in memory.tags
                and "verification:invalidated" not in memory.tags
            }
            visited: set[str] = set()
            clusters: list[dict[str, Any]] = []
            for memory in sorted(eligible.values(), key=lambda item: (item.created_at, item.id)):
                if memory.id in visited or len(clusters) >= config.reflection.max_clusters_per_reflection:
                    continue
                embedding = store.get_embedding(memory.id)
                if embedding is None:
                    continue
                cluster = [memory.id]
                for memory_id, similarity in store.knn(
                    embedding,
                    config.reflection.recon_max_cluster,
                    owner=owner_scope,
                ):
                    if (
                        memory_id == memory.id
                        or memory_id in visited
                        or memory_id not in eligible
                        or similarity < config.reflection.recon_threshold
                    ):
                        continue
                    cluster.append(memory_id)
                if len(cluster) < 2:
                    visited.add(memory.id)
                    continue
                visited.update(cluster)
                clusters.append({"memory_ids": cluster})
            return {"ok": True, "clusters": clusters}
        if command == "reflect":
            previously_archived = {
                memory.id
                for memory in store.all_memories(include_archived=True, owner=None)
                if memory.archived
            }
            engine = ReflectionEngine(
                store,
                embedder,
                config.reflection,
                config.forget,
                owner=str(payload.get("owner_role", payload.get("owner", OWNER))),
            )
            report = engine.consolidate()
            report_data = report.model_dump(exclude_none=True)
            store.log_maintenance("reflect", {"trigger": payload.get("trigger", "manual"), **report_data})
            archived = [
                memory.id
                for memory in store.all_memories(include_archived=True, owner=None)
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
        raise SystemExit(
            "usage: nooa_sidecar.py "
            "<upsert|sync|recall|spontaneous|reflect|reconciliation_candidates|"
            "sync_spontaneous|sync_reflect|sync_reconciliation_candidates|serve> <sqlite-path>"
        )
    if sys.argv[1] == "serve":
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("serve request must be a JSON object")
                command = request.get("command")
                path = request.get("path")
                payload = request.get("payload")
                if not isinstance(command, str) or not isinstance(path, str):
                    raise ValueError("serve request requires string command and path")
                if not isinstance(payload, dict):
                    raise ValueError("serve request payload must be an object")
                response = run(command, Path(path), payload)
            except Exception as error:
                response = {"ok": False, "reason": str(error)}
            print(json.dumps(response), flush=True)
        return
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("sidecar input must be a JSON object")
    print(json.dumps(run(sys.argv[1], Path(sys.argv[2]), payload)))


if __name__ == "__main__":
    main()
