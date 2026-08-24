"""Kernel facade for host-owned workflow evidence admission."""

from __future__ import annotations

from typing import Any

from rlm import host_request

_PIPELINE_RECORD_REQUEST = "workflow.v1.pipeline.record"
_EXECUTION_EVIDENCE_READ_REQUEST = "workflow.v1.execution_evidence.read"
_ARTIFACT_REF_KEYS = frozenset(
    {"artifact_id", "relative_path", "digest", "size_bytes", "source_event_sequence"}
)
_MAX_STAGE_ID_BYTES = 256
_MAX_EVIDENCE_REFS = 32
_MAX_ARTIFACT_BYTES = 8_388_608


def _validate_text(value: object, field: str, maximum: int) -> str:
    """Validate one bounded nonempty UTF-8 string.
    Args:
        value: Candidate field value.
        field: Field name used in validation errors.
        maximum: Maximum encoded byte count.
    Return:
        Validated string.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field} must be str, got {type(value).__name__}")
    if not value:
        raise ValueError(f"{field} must not be empty")
    if len(value.encode("utf-8")) > maximum:
        raise ValueError(f"{field} exceeds {maximum} UTF-8 bytes")
    return value


def _validate_digest(value: object, field: str) -> str:
    """Validate one lowercase SHA-256 digest.
    Args:
        value: Candidate digest.
        field: Field name used in validation errors.
    Return:
        Validated digest.
    """
    digest = _validate_text(value, field, 64)
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise ValueError(f"{field} must be a lowercase sha256 digest")
    return digest


def _validate_artifact_ref(value: object, index: int) -> dict[str, object]:
    """Validate one closed host artifact reference.
    Args:
        value: Candidate artifact reference.
        index: Reference position used in validation errors.
    Return:
        Validated artifact reference.
    """
    if not isinstance(value, dict) or set(value) != _ARTIFACT_REF_KEYS:
        raise ValueError(f"evidence_refs[{index}] has an invalid artifact reference schema")
    artifact_id = _validate_text(value["artifact_id"], f"evidence_refs[{index}].artifact_id", 256)
    relative_path = _validate_text(value["relative_path"], f"evidence_refs[{index}].relative_path", 512)
    path_parts = relative_path.split("/")
    if (
        relative_path.startswith("/")
        or "\\" in relative_path
        or "\0" in relative_path
        or any(part in {"", ".", ".."} for part in path_parts)
    ):
        raise ValueError(f"evidence_refs[{index}].relative_path must be a safe relative path")
    digest = _validate_digest(value["digest"], f"evidence_refs[{index}].digest")
    size_bytes = value["size_bytes"]
    if isinstance(size_bytes, bool) or not isinstance(size_bytes, int) or not 0 <= size_bytes <= _MAX_ARTIFACT_BYTES:
        raise ValueError(f"evidence_refs[{index}].size_bytes is out of bounds")
    source_event_sequence = value["source_event_sequence"]
    if isinstance(source_event_sequence, bool) or not isinstance(source_event_sequence, int) or source_event_sequence < 0:
        raise ValueError(f"evidence_refs[{index}].source_event_sequence is invalid")
    return {
        "artifact_id": artifact_id,
        "relative_path": relative_path,
        "digest": digest,
        "size_bytes": size_bytes,
        "source_event_sequence": source_event_sequence,
    }


def _validate_evidence_refs(value: object) -> list[dict[str, object]]:
    """Validate a bounded list of unique host artifact references.
    Args:
        value: Candidate evidence reference list.
    Return:
        Validated references.
    """
    if not isinstance(value, list):
        raise TypeError(f"evidence_refs must be list, got {type(value).__name__}")
    if not value or len(value) > _MAX_EVIDENCE_REFS:
        raise ValueError(f"evidence_refs must contain between 1 and {_MAX_EVIDENCE_REFS} entries")
    refs = [_validate_artifact_ref(item, index) for index, item in enumerate(value)]
    if len({ref["artifact_id"] for ref in refs}) != len(refs):
        raise ValueError("evidence_refs contains duplicate artifact IDs")
    return refs


def _validate_host_result(value: object, operation: str) -> dict[str, Any]:
    """Require a structured host result.
    Args:
        value: Host response payload.
        operation: Operation name used in validation errors.
    Return:
        Structured host result.
    """
    if not isinstance(value, dict):
        raise TypeError(f"{operation} host result must be an object")
    return value


class _Pipeline:
    async def record(self, stage_id: str, evidence_refs: list[object]) -> dict[str, Any]:
        """Submit exact host evidence for the current ready stage.
        Args:
            stage_id: Dependency-ready stage identifier.
            evidence_refs: Host-issued evidence references for the stage evaluator.
        Return:
            Host-owned pipeline projection after admission.
        """
        stage = _validate_text(stage_id, "stage_id", _MAX_STAGE_ID_BYTES)
        refs = _validate_evidence_refs(evidence_refs)
        result = await host_request(_PIPELINE_RECORD_REQUEST, {"stage_id": stage, "evidence_refs": refs})
        return _validate_host_result(result, "pipeline.record")


class _ExecutionEvidence:
    async def read(self) -> dict[str, Any]:
        """Read the current host-issued execution evidence projection.
        Args:
            None.
        Return:
            Host-owned execution evidence projection.
        """
        result = await host_request(_EXECUTION_EVIDENCE_READ_REQUEST, {})
        return _validate_host_result(result, "execution_evidence.read")


class _WorkflowV1:
    def __init__(self) -> None:
        """Create the fixed version-one facade.
        Args:
            None.
        Return:
            None.
        """
        self.pipeline = _Pipeline()
        self.execution_evidence = _ExecutionEvidence()


v1 = _WorkflowV1()
