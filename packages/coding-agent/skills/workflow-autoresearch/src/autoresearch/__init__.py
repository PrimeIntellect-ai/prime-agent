"""Native AutoResearch experiment facade for the Prime Agent kernel.

The TypeScript host owns experiment state, worktrees, metrics, guards, and
approvals. This module validates bounded wire data, forwards one versioned
request through ``rlm.host_request``, and returns a host-owned evidence or
proposal result.
"""

from __future__ import annotations

from typing import Any

from rlm import host_request

_REQUEST_KIND = "workflow.v1.autoresearch.run"
_MAX_DIGEST_BYTES = 64
_MAX_TEXT_BYTES = 512
_MAX_EVIDENCE_REFS = 32
_MAX_ARTIFACT_BYTES = 8_388_608
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


def _validate_artifact_ref(value: object, index: int) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TypeError(f"evidence_refs[{index}] must be an object")
    if set(value) != _ARTIFACT_REF_KEYS:
        raise ValueError(f"evidence_refs[{index}] has an invalid artifact reference schema")
    artifact_id = _validate_text(value["artifact_id"], f"evidence_refs[{index}].artifact_id", 256)
    relative_path = _validate_text(value["relative_path"], f"evidence_refs[{index}].relative_path", 512)
    path_parts = relative_path.split("/")
    if (
        relative_path.startswith("/")
        or "\\" in relative_path
        or "\0" in relative_path
        or (len(relative_path) >= 2 and relative_path[1] == ":")
        or any(part in {"", ".", ".."} for part in path_parts)
    ):
        raise ValueError(f"evidence_refs[{index}].relative_path must be a safe relative path")
    _validate_digest(value["digest"], f"evidence_refs[{index}].digest")
    size_bytes = value["size_bytes"]
    if isinstance(size_bytes, bool) or not isinstance(size_bytes, int) or not 0 <= size_bytes <= _MAX_ARTIFACT_BYTES:
        raise ValueError(f"evidence_refs[{index}].size_bytes is out of bounds")
    source_event_sequence = value["source_event_sequence"]
    if isinstance(source_event_sequence, bool) or not isinstance(source_event_sequence, int) or source_event_sequence < 0:
        raise ValueError(f"evidence_refs[{index}].source_event_sequence is invalid")
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
    refs = [_validate_artifact_ref(item, index) for index, item in enumerate(value)]
    if len({ref["artifact_id"] for ref in refs}) != len(refs):
        raise ValueError(f"{field} contains duplicate artifact IDs")
    return refs


def _validate_result(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError("AutoResearch host result must be an object")
    if "status" in value:
        raise ValueError("AutoResearch result status field is not allowed")
    if set(value) != _SKILL_OUTPUT_KEYS:
        raise ValueError("AutoResearch result has an invalid evidence/proposal schema")
    if value["skill_id"] != "autoresearch":
        raise ValueError("AutoResearch result skill_id is invalid")
    if value["output_kind"] not in {"evidence", "knowledge_proposal"}:
        raise ValueError("AutoResearch result output_kind is invalid")
    _validate_artifact_refs(value["evidence_refs"], "result.evidence_refs")
    boundary_digest = value["durable_knowledge_boundary_digest"]
    if boundary_digest is not None:
        _validate_digest(boundary_digest, "result.durable_knowledge_boundary_digest")
    if value["transient_state_refs"] != []:
        raise ValueError("AutoResearch result cannot carry transient state references")
    if value["can_authorize"] is not False:
        raise ValueError("AutoResearch result cannot authorize")
    _validate_digest(value["output_digest"], "result.output_digest")
    return value


async def run(recipe_digest: str, evidence_refs: list[object]) -> dict[str, Any]:
    """Request one host-owned experiment and return evidence/proposal output.

    Args:
        recipe_digest: Digest of the immutable recipe bound to the experiment.
        evidence_refs: Bounded host-issued evidence artifact references.
    Return:
        The validated host-owned evidence/proposal result.
    """
    _validate_digest(recipe_digest, "recipe_digest")
    refs = _validate_artifact_refs(evidence_refs, "evidence_refs")
    result = await host_request(_REQUEST_KIND, {"recipe_digest": recipe_digest, "evidence_refs": refs})
    return _validate_result(result)
