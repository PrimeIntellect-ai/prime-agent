"""Native MemPalace canonical-knowledge facade for the Prime Agent kernel.

The TypeScript host owns canonical commits, evidence, scope, privacy, and
storage. This module validates bounded wire data, forwards versioned
recall/proposal requests through ``rlm.host_request``, and never becomes a
knowledge-store writer.
"""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request

KnowledgeKind = Literal["how", "why", "procedure"]
_RECALL_REQUEST_KIND = "workflow.v1.mempalace.recall"
_PROPOSE_REQUEST_KIND = "workflow.v1.mempalace.propose"
_ALLOWED_KINDS = {"how", "why", "procedure"}
_MAX_DIGEST_BYTES = 64
_MAX_QUERY_BYTES = 250
_MAX_TEXT_BYTES = 512
_MAX_EVIDENCE_REFS = 32
_MAX_ARTIFACT_BYTES = 8_388_608
_MAX_RECALL_LIMIT = 5
_ARTIFACT_REF_KEYS = frozenset(
    {"artifact_id", "relative_path", "digest", "size_bytes", "source_event_sequence"}
)
_SKILL_OUTPUT_KEYS = frozenset(
    {
        "skill_id",
        "output_kind",
        "evidence_refs",
        "durable_knowledge_boundary_digest",
        "transient_state_refs",
        "can_authorize",
        "output_digest",
    }
)


def _validate_text(value: object, field: str, maximum: int, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be str, got {type(value).__name__}")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise ValueError(f"{field} must contain valid UTF-8") from error
    if not allow_empty and not value:
        raise ValueError(f"{field} must not be empty")
    if size > maximum:
        raise ValueError(f"{field} exceeds {maximum} UTF-8 bytes")
    return value


def _validate_digest(value: object, field: str) -> str:
    digest = _validate_text(value, field, _MAX_DIGEST_BYTES)
    if len(digest) != _MAX_DIGEST_BYTES:
        raise ValueError(f"{field} must be a sha256 digest")
    if any(character not in "0123456789abcdef" for character in digest):
        raise ValueError(f"{field} must be a lowercase sha256 digest")
    return digest


def _validate_artifact_ref(value: object, index: int, field: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TypeError(f"{field}[{index}] must be an object")
    if set(value) != _ARTIFACT_REF_KEYS:
        raise ValueError(f"{field}[{index}] has an invalid artifact reference schema")
    artifact_id = _validate_text(value["artifact_id"], f"{field}[{index}].artifact_id", _MAX_TEXT_BYTES)
    relative_path = _validate_text(value["relative_path"], f"{field}[{index}].relative_path", _MAX_TEXT_BYTES)
    path_parts = relative_path.split("/")
    if (
        relative_path.startswith("/")
        or "\\" in relative_path
        or "\0" in relative_path
        or (len(relative_path) >= 2 and relative_path[1] == ":")
        or any(part in {"", ".", ".."} for part in path_parts)
    ):
        raise ValueError(f"{field}[{index}].relative_path must be a safe relative path")
    _validate_digest(value["digest"], f"{field}[{index}].digest")
    size_bytes = value["size_bytes"]
    if isinstance(size_bytes, bool) or not isinstance(size_bytes, int) or not 0 <= size_bytes <= _MAX_ARTIFACT_BYTES:
        raise ValueError(f"{field}[{index}].size_bytes is out of bounds")
    source_event_sequence = value["source_event_sequence"]
    if isinstance(source_event_sequence, bool) or not isinstance(source_event_sequence, int) or source_event_sequence < 0:
        raise ValueError(f"{field}[{index}].source_event_sequence is invalid")
    return {
        "artifact_id": artifact_id,
        "relative_path": relative_path,
        "digest": value["digest"],
        "size_bytes": size_bytes,
        "source_event_sequence": source_event_sequence,
    }


def _validate_artifact_refs(value: object, field: str) -> list[dict[str, object]]:
    if not isinstance(value, list):
        raise TypeError(f"{field} must be list, got {type(value).__name__}")
    if len(value) > _MAX_EVIDENCE_REFS:
        raise ValueError(f"{field} exceeds {_MAX_EVIDENCE_REFS} entries")
    refs = [_validate_artifact_ref(item, index, field) for index, item in enumerate(value)]
    if len({ref["artifact_id"] for ref in refs}) != len(refs):
        raise ValueError(f"{field} contains duplicate artifact IDs")
    return refs


def _validate_knowledge_kind(knowledge_kind: object) -> str:
    if not isinstance(knowledge_kind, str):
        raise TypeError(f"knowledge_kind must be str, got {type(knowledge_kind).__name__}")
    if knowledge_kind not in _ALLOWED_KINDS:
        raise ValueError(
            "knowledge_kind must be one of \"how\", \"why\", or \"procedure\"; "
            "transient decisions, outcomes, run history, and transient state are not durable knowledge"
        )
    return knowledge_kind


def _validate_result(value: object, output_kind: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError("MemPalace host result must be an object")
    status = value.get("status")
    if status is not None and status != "ok":
        raise ValueError("MemPalace host result status is not successful")
    result = {key: item for key, item in value.items() if key != "status"}
    if set(result) != _SKILL_OUTPUT_KEYS:
        raise ValueError("MemPalace result has an invalid evidence/proposal schema")
    if result["skill_id"] != "mempalace":
        raise ValueError("MemPalace result skill_id is invalid")
    if result["output_kind"] != output_kind:
        raise ValueError("MemPalace result output_kind is invalid")
    _validate_artifact_refs(result["evidence_refs"], "result.evidence_refs")
    boundary_digest = result["durable_knowledge_boundary_digest"]
    if boundary_digest is not None:
        _validate_digest(boundary_digest, "result.durable_knowledge_boundary_digest")
    if result["transient_state_refs"] != []:
        raise ValueError("MemPalace result cannot carry transient state references")
    if result["can_authorize"] is not False:
        raise ValueError("MemPalace result cannot authorize")
    _validate_digest(result["output_digest"], "result.output_digest")
    return result


async def recall(
    query: str,
    knowledge_kind: KnowledgeKind | str | None = None,
    limit: int = 5,
) -> dict[str, Any]:
    """Request bounded recall of canonical reusable knowledge.

    Args:
        query: Bounded canonical-knowledge search query.
        knowledge_kind: Optional ``how``, ``why``, or ``procedure`` filter.
        limit: Maximum number of host-selected results, from one through five.
    Return:
        The validated host-owned evidence result.
    """
    _validate_text(query, "query", _MAX_QUERY_BYTES)
    normalized_kind = None if knowledge_kind is None else _validate_knowledge_kind(knowledge_kind)
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise TypeError(f"limit must be int, got {type(limit).__name__}")
    if not 1 <= limit <= _MAX_RECALL_LIMIT:
        raise ValueError(f"limit must be between 1 and {_MAX_RECALL_LIMIT}")
    payload: dict[str, Any] = {"query": query, "limit": limit}
    if normalized_kind is not None:
        payload["knowledge_kind"] = normalized_kind
    result = await host_request(_RECALL_REQUEST_KIND, payload)
    return _validate_result(result, "evidence")


async def propose(knowledge_kind: KnowledgeKind | str, source_evidence_refs: list[object]) -> dict[str, Any]:
    """Submit a source-backed canonical reusable knowledge proposal.

    Args:
        knowledge_kind: Reusable ``how``, ``why``, or ``procedure`` kind.
        source_evidence_refs: Non-empty host-issued source evidence references.
    Return:
        The validated host-owned knowledge proposal result.
    """
    normalized_kind = _validate_knowledge_kind(knowledge_kind)
    refs = _validate_artifact_refs(source_evidence_refs, "source_evidence_refs")
    if not refs:
        raise ValueError("source_evidence_refs must contain canonical source evidence")
    result = await host_request(
        _PROPOSE_REQUEST_KIND,
        {"knowledge_kind": normalized_kind, "source_evidence_refs": refs},
    )
    return _validate_result(result, "knowledge_proposal")
