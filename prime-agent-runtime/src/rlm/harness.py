"""Persistent harness-state helpers for Prime Agent's RLM kernel.

The state model is intentionally small: it records prompt notes, memory,
skills, subagent specs, and refinement events in the global agent harness
directory by default. Execution still belongs to Prime Agent's TypeScript host
and the existing ``rlm.run`` recursion bridge.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import secrets
import subprocess
import time
import unicodedata
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

HarnessKind = Literal["prompt", "memory", "skill", "subagent"]
HarnessScope = Literal["local", "global"]

_DEFAULT_FILE_NAME = "harness_state.json"
_DEFAULT_HARNESS_DIR_NAME = "harness"
_KINDS: tuple[HarnessKind, ...] = ("prompt", "memory", "skill", "subagent")
_state_cache: dict[tuple[Path, HarnessScope], "HarnessState"] = {}


def _now() -> str:
    # Shared with the TypeScript writer: RFC3339 UTC, exactly milliseconds.
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _slug(raw: str, fallback: str) -> str:
    normalized = "".join(ch.lower() if ch.isalnum() else "_" for ch in raw.strip())
    normalized = "_".join(part for part in normalized.split("_") if part)
    return (normalized or fallback)[:80]


def _agent_dir() -> Path:
    raw = (
        os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        or os.environ.get("PI_CODING_AGENT_DIR")
        or str(Path.home() / ".prime" / "agent")
    )
    return Path(raw).expanduser().resolve()


def _resolve_global_flag(global_: bool = False, extra: dict[str, Any] | None = None) -> bool:
    extra = dict(extra or {})
    if "global" in extra:
        value = extra.pop("global")
        if not isinstance(value, bool):
            raise TypeError(f"global must be a bool, got {type(value).__name__}")
        global_ = value
    if extra:
        unexpected = next(iter(extra))
        raise TypeError(f"unexpected keyword argument {unexpected!r}")
    return bool(global_)


def _strip_scope_prefix(id: str | None, global_: bool) -> tuple[str | None, bool]:
    # overview() displays entries as [local:id]/[global:id]; accept those ids
    # verbatim. A global: prefix routes to the global store unless the caller
    # already forced a scope via global_.
    if isinstance(id, str):
        scope, sep, rest = id.partition(":")
        if sep and rest and scope in ("local", "global"):
            return rest, global_ or scope == "global"
    return id, global_


def _env_dir(name: str) -> str | None:
    # Set-but-empty env values must behave as unset; a bare "" would skip the
    # session-dir fallback and land local writes in the global agent-dir default.
    value = (os.environ.get(name) or "").strip()
    return value or None


def _state_file(state_dir: str | Path | None = None, *, global_: bool = False) -> Path:
    root: str | Path | None = state_dir
    if root is None:
        root = _env_dir("RLM_GLOBAL_HARNESS_STATE_DIR") if global_ else _env_dir("RLM_HARNESS_STATE_DIR")
    if root is None and not global_ and (session_dir := _env_dir("RLM_SESSION_DIR")):
        root = Path(session_dir) / _DEFAULT_HARNESS_DIR_NAME
    if root is None and not global_:
        raise RuntimeError(
            "Local harness state requires RLM_HARNESS_STATE_DIR or RLM_SESSION_DIR. "
            "Use get_harness_state(global_=True) for global state."
        )
    if root:
        return Path(root).expanduser().resolve() / _DEFAULT_FILE_NAME
    return _agent_dir() / _DEFAULT_HARNESS_DIR_NAME / _DEFAULT_FILE_NAME


@dataclass
class HarnessEntry:
    """A reusable prompt, memory, skill, or subagent record."""

    id: str
    kind: HarnessKind
    title: str
    content: str
    path: str = "general"
    scope: HarnessScope = "local"
    reference: dict[str, Any] = field(default_factory=dict)
    arguments: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    source: str = "agent"
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    version: int = 1


@dataclass
class RefinementEvent:
    """A recorded online harness-refinement pass."""

    id: str
    trigger: str
    changes: list[str]
    evidence: str = ""
    outcome: str = ""
    created_at: str = field(default_factory=_now)


_ENTRY_FIELDS = {field.name for field in fields(HarnessEntry)}
_REFINEMENT_FIELDS = {field.name for field in fields(RefinementEvent)}


def _validate_python_skill_reference(reference: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(reference, dict):
        raise ValueError("skill entries require a Python reference")
    normalized = dict(reference)
    if normalized.get("type") != "python":
        raise ValueError("skill reference.type must be 'python'")
    if not any(isinstance(normalized.get(key), str) and normalized[key] for key in ("import", "python_import")):
        raise ValueError("skill reference requires a Python import")
    if not any(isinstance(normalized.get(key), str) and normalized[key] for key in ("callable", "call_pattern")):
        raise ValueError("skill reference requires a callable or call_pattern")
    return normalized


@dataclass(frozen=True)
class HarnessSnapshot:
    """Identity of one on-disk harness snapshot.

    ``__getitem__`` is a narrow compatibility view for older callers that used
    ``state.snapshot()["entries"]`` as a JSON export. It is not persistence
    authority; generation and digest remain the comparable CAS identity.
    """

    generation: int
    sha256: str
    export: dict[str, Any] | None = field(default=None, compare=False, repr=False)

    def __getitem__(self, key: str) -> Any:
        if self.export is None:
            raise KeyError(key)
        return self.export[key]


class HarnessGenerationConflict(RuntimeError):
    def __init__(self, expected: HarnessSnapshot, actual: HarnessSnapshot):
        self.expected, self.actual = expected, actual
        super().__init__("harness state changed while this operation was in progress")


class HarnessLockBusy(RuntimeError):
    pass


class HarnessAtomicWriteUnsupported(RuntimeError):
    pass


class HarnessRecoveryRequired(RuntimeError):
    pass


_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_RFC3339_MILLIS_Z = __import__("re").compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
# Schema-1 records without timestamps migrate to this documented epoch, never the reader clock.
_LEGACY_DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z"


def _pairs_no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def _canonical_json(value: Any) -> bytes:
    """The intentionally small, language-neutral schema-2 JSON codec."""
    def normalize(item: Any) -> Any:
        if isinstance(item, str):
            return unicodedata.normalize("NFC", item)
        if isinstance(item, list):
            return [normalize(v) for v in item]
        if isinstance(item, dict):
            return {unicodedata.normalize("NFC", str(k)): normalize(v) for k, v in item.items()}
        if isinstance(item, bool) or item is None:
            return item
        if isinstance(item, int):
            if item < -_MAX_SAFE_INTEGER or item > _MAX_SAFE_INTEGER:
                raise ValueError("unsafe_number")
            return item
        if isinstance(item, float):
            raise ValueError("non_integer_number")
        raise ValueError("invalid_json_value")

    # Python's sort is Unicode code point order, the required scalar-value order.
    return (json.dumps(normalize(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _empty_data(generation: int = 0) -> dict[str, Any]:
    return {"schema": 2, "generation": generation, "entries": {kind: {} for kind in _KINDS}, "refinements": []}


def _empty_snapshot() -> HarnessSnapshot:
    data = _canonical_json(_empty_data())
    return HarnessSnapshot(0, _sha(data))


def _plain_object(value: Any) -> bool:
    return isinstance(value, dict) and all(isinstance(key, str) for key in value)


def _safe_integer(value: Any, *, positive: bool = False) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= _MAX_SAFE_INTEGER and (not positive or value > 0)


def _validate_json(value: Any) -> None:
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        if value != unicodedata.normalize("NFC", value):
            raise ValueError("non_nfc")
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if not _safe_integer(value):
            raise ValueError("unsafe_number")
        return
    if isinstance(value, list):
        for child in value:
            _validate_json(child)
        return
    if not _plain_object(value):
        raise ValueError("invalid_json_value")
    for key, child in value.items():
        if key != unicodedata.normalize("NFC", key):
            raise ValueError("non_nfc")
        _validate_json(child)


def _nfc_text(value: Any) -> bool:
    return (isinstance(value, str) and value == unicodedata.normalize("NFC", value)
            and not any(0xD800 <= ord(ch) <= 0xDFFF for ch in value))


def _validate_v2(data: Any, scope: HarnessScope) -> None:
    if not _plain_object(data) or set(data) != {"schema", "generation", "entries", "refinements"}:
        raise ValueError("invalid_shape")
    if data["schema"] != 2 or not _safe_integer(data["generation"]):
        raise ValueError("invalid_shape")
    entries = data["entries"]
    if not _plain_object(entries) or set(entries) != set(_KINDS) or not isinstance(data["refinements"], list):
        raise ValueError("invalid_shape")
    seen_ids: set[str] = set()
    seen_events: set[str] = set()
    for kind in _KINDS:
        records = entries[kind]
        if not _plain_object(records):
            raise ValueError("invalid_shape")
        for entry_id, entry in records.items():
            if not _nfc_text(entry_id) or not entry_id or entry_id in seen_ids or not _plain_object(entry):
                raise ValueError("invalid_entry")
            seen_ids.add(entry_id)
            required = {"id", "kind", "title", "content", "path", "scope", "reference", "arguments", "metadata", "source", "created_at", "updated_at", "version"}
            if set(entry) != required or entry.get("id") != entry_id or entry.get("kind") != kind:
                raise ValueError("invalid_shape")
            if any(not _nfc_text(entry[field]) for field in ("id", "kind", "title", "content", "path", "scope", "source", "created_at", "updated_at")):
                raise ValueError("invalid_shape")
            if not _RFC3339_MILLIS_Z.fullmatch(entry["created_at"]) or not _RFC3339_MILLIS_Z.fullmatch(entry["updated_at"]):
                raise ValueError("invalid_shape")
            if entry["scope"] not in ("local", "global") or not _safe_integer(entry["version"], positive=True):
                raise ValueError("invalid_shape")
            if not all(_plain_object(entry[field]) for field in ("reference", "arguments", "metadata")):
                raise ValueError("invalid_shape")
            for field in ("reference", "arguments", "metadata"):
                _validate_json(entry[field])
            if kind == "skill":
                _validate_python_skill_reference(entry["reference"])
    for event in data["refinements"]:
        if not _plain_object(event) or set(event) != {"id", "trigger", "changes", "evidence", "outcome", "created_at"}:
            raise ValueError("invalid_shape")
        if not event["id"] or any(not _nfc_text(event[field]) for field in ("id", "trigger", "evidence", "outcome", "created_at")) or not _RFC3339_MILLIS_Z.fullmatch(event["created_at"]) or not isinstance(event["changes"], list) or not all(_nfc_text(x) for x in event["changes"]) or event["id"] in seen_events:
            raise ValueError("invalid_shape")
        seen_events.add(event["id"])


def _decode_v2(raw: bytes, scope: HarnessScope) -> tuple[dict[str, Any], HarnessSnapshot]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("invalid_utf8") from exc
    try:
        data = json.loads(text, object_pairs_hook=_pairs_no_duplicates, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid_json")))
    except ValueError as exc:
        raise ValueError("invalid_json") from exc
    if not isinstance(data, dict):
        raise ValueError("invalid_shape")
    if data.get("schema") != 2:
        raise ValueError("unsupported_schema" if isinstance(data.get("schema"), int) and data.get("schema") > 2 else "invalid_shape")
    _validate_v2(data, scope)
    canonical = _canonical_json(data)
    if raw != canonical:
        raise ValueError("noncanonical_v2")
    return data, HarnessSnapshot(data["generation"], _sha(raw))


def _legacy_changes(value: Any) -> list[str] | None:
    """Accept the schema-1 changes wire type without language-specific coercion."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(change, str) for change in value):
        return value
    return None


def _legacy_data(raw: bytes, scope: HarnessScope) -> dict[str, Any]:
    """The only permissive read path, retained solely for schema-1 migration."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise ValueError("invalid_utf8") from exc
    except ValueError as exc:
        raise ValueError("invalid_json") from exc
    schema = data.get("schema", 1) if isinstance(data, dict) else None
    if not isinstance(data, dict) or isinstance(schema, bool) or not isinstance(schema, int) or schema != 1:
        raise ValueError("unsupported_schema" if isinstance(data, dict) and isinstance(schema, int) and not isinstance(schema, bool) and schema > 2 else "invalid_shape")
    entries = {kind: {} for kind in _KINDS}
    for kind in _KINDS:
        records = data.get("entries", {}).get(kind, {}) if isinstance(data.get("entries"), dict) else {}
        if not isinstance(records, dict):
            continue
        for entry_id, raw_entry in records.items():
            if not isinstance(raw_entry, dict) or not isinstance(raw_entry.get("title"), str) or not isinstance(raw_entry.get("content"), str):
                continue
            entries[kind][str(entry_id)] = {"id": str(entry_id), "kind": kind, "title": raw_entry["title"], "content": raw_entry["content"], "path": raw_entry.get("path") if isinstance(raw_entry.get("path"), str) else "general", "scope": raw_entry.get("scope") if raw_entry.get("scope") in ("local", "global") else scope, "reference": raw_entry.get("reference") if isinstance(raw_entry.get("reference"), dict) else {}, "arguments": raw_entry.get("arguments") if isinstance(raw_entry.get("arguments"), dict) else {}, "metadata": raw_entry.get("metadata") if isinstance(raw_entry.get("metadata"), dict) else {}, "source": raw_entry.get("source") if isinstance(raw_entry.get("source"), str) else "agent", "created_at": raw_entry.get("created_at") if isinstance(raw_entry.get("created_at"), str) else _LEGACY_DEFAULT_TIMESTAMP, "updated_at": raw_entry.get("updated_at") if isinstance(raw_entry.get("updated_at"), str) else _LEGACY_DEFAULT_TIMESTAMP, "version": int(raw_entry.get("version", 1)) if isinstance(raw_entry.get("version", 1), (int, str)) and str(raw_entry.get("version", 1)).isdigit() and _safe_integer(int(raw_entry.get("version", 1)), positive=True) else 1}
    refinements = []
    for event in data.get("refinements", []) if isinstance(data.get("refinements"), list) else []:
        if isinstance(event, dict) and isinstance(event.get("id"), str) and isinstance(event.get("trigger"), str):
            changes = _legacy_changes(event.get("changes"))
            if changes is not None:
                refinements.append({"id": event["id"], "trigger": event["trigger"], "changes": changes, "evidence": event.get("evidence") if isinstance(event.get("evidence"), str) else "", "outcome": event.get("outcome") if isinstance(event.get("outcome"), str) else "", "created_at": event.get("created_at") if isinstance(event.get("created_at"), str) else _LEGACY_DEFAULT_TIMESTAMP})
    return {"schema": 1, "entries": entries, "refinements": refinements}


def _process_start(pid: int) -> str | None:
    """Linux process start ticks are a PID-reuse fence shared with Node."""
    try:
        # field 22 follows the final ')' in /proc/<pid>/stat; it is stable for
        # a process lifetime and avoids treating a recycled PID as our owner.
        return Path(f"/proc/{pid}/stat").read_text("utf-8").rsplit(") ", 1)[1].split()[19]
    except (OSError, IndexError):
        pass
    try:
        # macOS has no /proc. `ps lstart` is stable for a process lifetime and
        # is deliberately the exact fallback used by the Node writer.
        value = subprocess.check_output(["ps", "-o", "lstart=", "-p", str(pid)], text=True, stderr=subprocess.DEVNULL).strip()
        return value or None
    except (OSError, subprocess.SubprocessError):
        return None


def _lock_owner(raw: bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs_no_duplicates)
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(value, dict) or set(value) != {"nonce", "pid", "process_start", "created_at"}:
        return None
    if not isinstance(value["nonce"], str) or len(value["nonce"]) != 32 or any(ch not in "0123456789abcdef" for ch in value["nonce"]):
        return None
    if (not _safe_integer(value["pid"], positive=True) or not _nfc_text(value["process_start"]) or not value["process_start"]
            or not _nfc_text(value["created_at"]) or not _RFC3339_MILLIS_Z.fullmatch(value["created_at"])):
        return None
    # Lock records are a wire protocol, not merely equivalent JSON. Reject
    # duplicate, reordered, or whitespace-padded owners before stale-lock logic.
    if raw != _canonical_lock_bytes(value):
        return None
    return value


class _Lease:
    """The shared P.lock protocol.  Unknown and unreadable owners fail closed."""
    def __init__(self, state_path: Path):
        self.path = Path(f"{state_path}.lock")
        self.nonce = secrets.token_hex(16)
        self.owner: dict[str, Any] | None = None

    def __enter__(self) -> "_Lease":
        start = _process_start(os.getpid())
        if start is None:
            raise HarnessAtomicWriteUnsupported("process-start identity unavailable")
        self.owner = {"nonce": self.nonce, "pid": os.getpid(), "process_start": start, "created_at": _now()}
        payload = _canonical_lock_bytes(self.owner)
        deadline = time.monotonic() + 2.0
        while True:
            try:
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    _write_all(fd, payload)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                if (self.path.stat().st_mode & 0o777) != 0o600:
                    raise HarnessAtomicWriteUnsupported("owner-only lease unavailable")
                return self
            except FileExistsError:
                try:
                    raw = self.path.read_bytes()
                except OSError:
                    if time.monotonic() >= deadline:
                        raise HarnessLockBusy("harness state lease is busy")
                    time.sleep(0.025)
                    continue
                owner = _lock_owner(raw)
                if owner is None:
                    raise HarnessLockBusy("harness state lease is busy")
                actual_start = _process_start(owner["pid"])
                if actual_start is not None:
                    if actual_start == owner["process_start"]:
                        if time.monotonic() >= deadline:
                            raise HarnessLockBusy("harness state lease is busy")
                        time.sleep(0.025)
                        continue
                    # PID exists with a different start identity: verified dead owner.
                    try:
                        if self.path.read_bytes() == raw:
                            self.path.unlink()
                    except OSError:
                        pass
                    continue
                # /proc absent is only proof of death if kill explicitly says ESRCH.
                try:
                    os.kill(owner["pid"], 0)
                except ProcessLookupError:
                    try:
                        if self.path.read_bytes() == raw:
                            self.path.unlink()
                    except OSError:
                        pass
                    continue
                except OSError:
                    pass
                raise HarnessLockBusy("harness state lease is busy")
            except OSError as exc:
                raise HarnessAtomicWriteUnsupported("exclusive lease unavailable") from exc

    def __exit__(self, *exc: Any) -> None:
        # Exact nonce ownership only. Failure to release must not delete a new owner.
        try:
            owner = _lock_owner(self.path.read_bytes())
            if owner is not None and owner["nonce"] == self.nonce:
                self.path.unlink()
        except OSError:
            pass


def _canonical_lock_bytes(owner: dict[str, Any]) -> bytes:
    # Fixed field order is part of the shared Node/Python lock wire protocol.
    return json.dumps({"nonce": owner["nonce"], "pid": owner["pid"], "process_start": owner["process_start"], "created_at": owner["created_at"]}, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"


def _write_all(fd: int, raw: bytes) -> None:
    view = memoryview(raw)
    while view:
        count = os.write(fd, view)
        if count <= 0:
            raise OSError("short write")
        view = view[count:]

class HarnessState:
    """CRUD store for reset-free harness refinement state."""

    def __init__(
        self,
        file_path: str | Path | None = None,
        *,
        in_memory: bool = False,
        scope: HarnessScope = "local",
        local_write_error: str | None = None,
    ):
        # in_memory mode never resolves or touches a path. It is the safe fallback when
        # path resolution itself fails, so constructing it cannot re-raise that error.
        if in_memory:
            self.file_path: Path | None = None
        else:
            self.file_path = (
                Path(file_path).expanduser().resolve()
                if file_path
                else _state_file(global_=(scope == "global"))
            )
        self.scope: HarnessScope = scope
        # When set, local mutations raise instead of vanishing into a volatile
        # store; reads and global_=True delegation keep working.
        self._local_write_error = local_write_error
        self.entries: dict[HarnessKind, dict[str, HarnessEntry]] = {kind: {} for kind in _KINDS}
        self.refinements: list[RefinementEvent] = []
        self._global_target_state_dir: Path | None = None
        # Snapshot (generation + canonical byte digest), not mtime, fences writers.
        self._snapshot: HarnessSnapshot = _empty_snapshot()
        self.recovered = False
        self.recovery: str | None = None
        self.load()

    def _ensure_local_writable(self) -> None:
        if self._local_write_error is not None:
            raise RuntimeError(self._local_write_error)

    def _install_data(self, data: dict[str, Any], snapshot: HarnessSnapshot) -> None:
        self.entries = {kind: {entry_id: HarnessEntry(**entry) for entry_id, entry in data["entries"][kind].items()} for kind in _KINDS}
        self.refinements = [RefinementEvent(**event) for event in data["refinements"]]
        self._snapshot = snapshot

    def _current_data(self, generation: int | None = None) -> dict[str, Any]:
        return {"schema": 2, "generation": self._snapshot.generation if generation is None else generation, "entries": {kind: {entry_id: asdict(entry) for entry_id, entry in records.items()} for kind, records in self.entries.items()}, "refinements": [asdict(event) for event in self.refinements]}

    def _read_disk(self) -> tuple[dict[str, Any], HarnessSnapshot, bool]:
        if self.file_path is None or not self.file_path.exists():
            return _empty_data(), _empty_snapshot(), False
        raw = self.file_path.read_bytes()
        try:
            data, snapshot = _decode_v2(raw, self.scope)
            return data, snapshot, False
        except ValueError as v2_error:
            # Schema-1 is the one legacy input. Its digest is still a precise CAS
            # fence even though its generation is defined to be zero.
            try:
                legacy = _legacy_data(raw, self.scope)
            except ValueError:
                raise v2_error
            return legacy, HarnessSnapshot(0, _sha(raw)), True

    def _fsync_directory(self) -> None:
        assert self.file_path is not None
        try:
            fd = os.open(self.file_path.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except (OSError, AttributeError) as exc:
            raise HarnessAtomicWriteUnsupported("directory fsync unavailable") from exc

    def _atomic_write_locked(self, data: dict[str, Any]) -> HarnessSnapshot:
        assert self.file_path is not None
        raw = _canonical_json(data)
        temp = self.file_path.parent / f".{self.file_path.name}.{os.getpid()}.{secrets.token_hex(12)}.tmp"
        fd: int | None = None
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            view = memoryview(raw)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
            os.close(fd); fd = None
            if (temp.stat().st_mode & 0o777) != 0o600:
                raise HarnessAtomicWriteUnsupported("owner-only temp unavailable")
            os.replace(temp, self.file_path)
            self._fsync_directory()
            verified, snapshot = _decode_v2(self.file_path.read_bytes(), self.scope)
            if verified != data or (self.file_path.stat().st_mode & 0o777) != 0o600:
                raise HarnessAtomicWriteUnsupported("atomic harness-state verification failed")
            return snapshot
        except (OSError, ValueError) as exc:
            raise HarnessAtomicWriteUnsupported("atomic harness-state write unavailable") from exc
        finally:
            if fd is not None:
                try: os.close(fd)
                except OSError: pass
            try: temp.unlink()
            except FileNotFoundError: pass
            except OSError: pass

    def _recover_locked(self, raw: bytes, reason: str) -> tuple[dict[str, Any], HarnessSnapshot]:
        assert self.file_path is not None
        suffix = "bin" if reason == "invalid_utf8" else "json"
        recovery = self.file_path.parent / f"harness_state.corrupt.{int(time.time() * 1000)}.{secrets.token_hex(8)}.{suffix}"
        try:
            fd = os.open(recovery, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                view = memoryview(raw)
                while view:
                    written = os.write(fd, view); view = view[written:]
                os.fsync(fd)
            finally: os.close(fd)
        except OSError as exc:
            raise HarnessRecoveryRequired("unable to preserve corrupt harness state") from exc
        data = _empty_data(1)
        snapshot = self._atomic_write_locked(data)
        self.recovered, self.recovery = True, reason
        return data, snapshot

    def _sync_from_disk(self) -> None:
        if self.file_path is None:
            return
        try:
            _, disk_snapshot, _ = self._read_disk()
        except ValueError:
            # load() owns recovery and must not silently replace corrupt content.
            self.load()
            return
        if disk_snapshot != self._snapshot:
            self.load()

    def load(self) -> "HarnessState":
        self.recovered, self.recovery = False, None
        if self.file_path is None:
            self._snapshot = _empty_snapshot()
            return self
        self.file_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.file_path.parent, 0o700)
            if (self.file_path.parent.stat().st_mode & 0o777) != 0o700:
                raise OSError("owner-only root unavailable")
        except OSError as exc:
            raise HarnessAtomicWriteUnsupported("owner-only harness root unavailable") from exc
        with _Lease(self.file_path):
            try:
                data, snapshot, legacy = self._read_disk()
            except ValueError as exc:
                raw = self.file_path.read_bytes()
                data, snapshot = self._recover_locked(raw, str(exc))
                legacy = False
            self._install_data(data, snapshot)
            # Legacy contents intentionally remain on disk until a mutation.
            self._legacy = legacy
        return self

    def save(self, *, expected: HarnessSnapshot | None = None) -> HarnessSnapshot:
        if self.file_path is None:
            return self._snapshot
        expected = self._snapshot if expected is None else expected
        self.file_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.file_path.parent, 0o700)
            if (self.file_path.parent.stat().st_mode & 0o777) != 0o700:
                raise OSError("owner-only root unavailable")
        except OSError as exc:
            raise HarnessAtomicWriteUnsupported("owner-only harness root unavailable") from exc
        with _Lease(self.file_path):
            try:
                _, actual, _ = self._read_disk()
            except ValueError as exc:
                raise HarnessRecoveryRequired("state must be reloaded before replacing corrupt content") from exc
            if actual != expected:
                raise HarnessGenerationConflict(expected, actual)
            candidate = self._current_data(actual.generation + 1)
            _validate_v2(candidate, self.scope)
            snapshot = self._atomic_write_locked(candidate)
        self._install_data(candidate, snapshot)
        self._legacy = False
        return snapshot

    def _global_target(self, global_: bool, extra: dict[str, Any] | None = None) -> "HarnessState | None":
        if not _resolve_global_flag(global_, extra):
            return None
        target = get_harness_state(state_dir=self._global_target_state_dir, global_=True)
        if self.file_path is not None and target.file_path == self.file_path and target.scope == self.scope:
            return None
        return target

    def upsert(
        self, kind: HarnessKind, title: str, content: str, *, id: str | None = None,
        path: str = "general", reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None, metadata: dict[str, Any] | None = None,
        source: str = "agent", global_: bool = False, **kwargs: Any,
    ) -> HarnessEntry:
        id, global_ = _strip_scope_prefix(id, global_)
        if target := self._global_target(global_, kwargs):
            # A proxy routed to a separately cached global handle did not form a
            # candidate yet; refresh that handle before beginning its operation.
            target._sync_from_disk()
            return target.upsert(kind, title, content, id=id, path=path, reference=reference, arguments=arguments, metadata=metadata, source=source)
        self._ensure_local_writable()
        return self._upsert(kind, title, content, id=id, path=path, reference=reference, arguments=arguments, metadata=metadata, source=source)

    def _candidate(self) -> "HarnessState":
        candidate = HarnessState(in_memory=True, scope=self.scope)
        candidate.file_path = self.file_path
        candidate._snapshot = self._snapshot
        candidate.entries = copy.deepcopy(self.entries)
        candidate.refinements = copy.deepcopy(self.refinements)
        return candidate

    def _commit_candidate(self, candidate: "HarnessState") -> None:
        snapshot = candidate.save(expected=self._snapshot)
        self._install_data(candidate._current_data(snapshot.generation), snapshot)
        self._legacy = False

    def _upsert(
        self, kind: HarnessKind, title: str, content: str, *, id: str | None = None,
        path: str | None = None, reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None, metadata: dict[str, Any] | None = None,
        source: str = "agent",
    ) -> HarnessEntry:
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        candidate = self._candidate()
        entry_id = id or _slug(title, kind)
        existing = candidate.entries[kind].get(entry_id)
        if existing:
            existing.title, existing.content = title, content
            if path is not None: existing.path = path
            if reference is not None: existing.reference = dict(reference)
            if arguments is not None: existing.arguments = dict(arguments)
            if metadata is not None: existing.metadata = dict(metadata)
            existing.source, existing.updated_at, existing.version = source, _now(), existing.version + 1
            entry = existing
        else:
            entry = HarnessEntry(id=entry_id, kind=kind, title=title, content=content,
                path=path if path is not None else "general", scope=self.scope,
                reference=dict(reference or {}), arguments=dict(arguments or {}),
                metadata=dict(metadata or {}), source=source)
            candidate.entries[kind][entry_id] = entry
        self._commit_candidate(candidate)
        return self.entries[kind][entry_id]

    def get(self, kind: HarnessKind, id: str, *, global_: bool = False, **kwargs: Any) -> HarnessEntry | None:
        id, global_ = _strip_scope_prefix(id, global_)
        if target := self._global_target(global_, kwargs):
            return target.get(kind, id)
        self._sync_from_disk()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        return self.entries[kind].get(id)

    def delete(self, kind: HarnessKind, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        id, global_ = _strip_scope_prefix(id, global_)
        if target := self._global_target(global_, kwargs):
            target._sync_from_disk()
            return target.delete(kind, id)
        self._ensure_local_writable()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        if id not in self.entries[kind]:
            return False
        candidate = self._candidate()
        del candidate.entries[kind][id]
        self._commit_candidate(candidate)
        return True

    def list(self, kind: HarnessKind | None = None, *, global_: bool = False, **kwargs: Any) -> list[HarnessEntry]:
        if target := self._global_target(global_, kwargs):
            return target.list(kind)
        self._sync_from_disk()
        kinds = [kind] if kind else list(_KINDS)
        records: list[HarnessEntry] = []
        for current_kind in kinds:
            if current_kind not in self.entries:
                raise ValueError(f"unknown harness kind {current_kind!r}; expected one of {_KINDS}")
            records.extend(self.entries[current_kind].values())
        return sorted(records, key=lambda entry: (entry.kind, entry.path, entry.title, entry.id))

    def create(
        self,
        kind: HarnessKind,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        source: str = "agent",
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        id, global_ = _strip_scope_prefix(id, global_)
        if target := self._global_target(global_, kwargs):
            target._sync_from_disk()
            return target.create(
                kind,
                title,
                content,
                id=id,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )
        self._ensure_local_writable()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        entry_id = id or _slug(title, kind)
        if entry_id in self.entries[kind]:
            raise ValueError(f"{kind} entry {entry_id!r} already exists")
        return self._upsert(
            kind,
            title,
            content,
            id=entry_id,
            path=path,
            reference=reference,
            arguments=arguments,
            metadata=metadata,
            source=source,
        )

    def update(
        self,
        kind: HarnessKind,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        source: str = "agent",
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        id, global_ = _strip_scope_prefix(id, global_)
        if target := self._global_target(global_, kwargs):
            return target.update(
                kind,
                id,
                title,
                content,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )
        self._ensure_local_writable()
        self._sync_from_disk()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        if id not in self.entries[kind]:
            raise ValueError(f"{kind} entry {id!r} does not exist")
        return self._upsert(
            kind,
            title,
            content,
            id=id,
            path=path,
            reference=reference,
            arguments=arguments,
            metadata=metadata,
            source=source,
        )

    def create_memory(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create("memory", title, content, id=id, path=path, metadata=metadata, global_=global_, **kwargs)

    def update_memory(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.update("memory", id, title, content, path=path, metadata=metadata, global_=global_, **kwargs)

    def delete_memory(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("memory", id, global_=global_, **kwargs)

    def create_prompt_note(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "policy",
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create("prompt", title, content, id=id, path=path, metadata=metadata, global_=global_, **kwargs)

    def update_prompt_note(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.update("prompt", id, title, content, path=path, metadata=metadata, global_=global_, **kwargs)

    def delete_prompt_note(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("prompt", id, global_=global_, **kwargs)

    def create_skill(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create(
            "skill",
            title,
            content,
            id=id,
            path=path,
            reference=_validate_python_skill_reference(reference),
            arguments=arguments,
            metadata=metadata,
            global_=global_,
            **kwargs,
        )

    def update_skill(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        # Only validate a reference when one is supplied; omitting it preserves the
        # existing reference (see _upsert) rather than forcing every title/content-only
        # update to re-send the full Python reference.
        validated_reference = _validate_python_skill_reference(reference) if reference is not None else None
        return self.update(
            "skill",
            id,
            title,
            content,
            path=path,
            reference=validated_reference,
            arguments=arguments,
            metadata=metadata,
            global_=global_,
            **kwargs,
        )

    def delete_skill(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("skill", id, global_=global_, **kwargs)

    def create_subagent(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create("subagent", title, content, id=id, path=path, metadata=metadata, global_=global_, **kwargs)

    def update_subagent(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        metadata: dict[str, Any] | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.update("subagent", id, title, content, path=path, metadata=metadata, global_=global_, **kwargs)

    def delete_subagent(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("subagent", id, global_=global_, **kwargs)

    def record_refinement(
        self,
        trigger: str,
        changes: list[str] | str,
        *,
        evidence: str = "",
        outcome: str = "",
        id: str | None = None,
        global_: bool = False,
        **kwargs: Any,
    ) -> RefinementEvent:
        if target := self._global_target(global_, kwargs):
            target._sync_from_disk()
            return target.record_refinement(trigger, changes, evidence=evidence, outcome=outcome, id=id)
        self._ensure_local_writable()
        event_id = id or f"refine_{len(self.refinements) + 1:04d}"
        normalized_changes = [changes] if isinstance(changes, str) else list(changes)
        event = RefinementEvent(
            id=event_id,
            trigger=trigger,
            changes=normalized_changes,
            evidence=evidence,
            outcome=outcome,
        )
        candidate = self._candidate()
        candidate.refinements.append(event)
        self._commit_candidate(candidate)
        return event

    def plan_refinement(
        self,
        observation: str,
        *,
        failing_component: str = "",
        next_step: str = "",
    ) -> list[str]:
        target = f" for {failing_component}" if failing_component else ""
        plan = [
            f"Diagnose the repeated failure or opportunity{target}: {observation}",
            "Update the smallest useful prompt note, memory item, skill, or subagent spec.",
            "Run the next action with the changed harness state, then record the outcome.",
        ]
        if next_step:
            plan.append(f"Immediate validation step: {next_step}")
        return plan

    def overview(self, *, max_entries_per_kind: int = 20, global_: bool = False, **kwargs: Any) -> str:
        if target := self._global_target(global_, kwargs):
            return target.overview(max_entries_per_kind=max_entries_per_kind)
        self._sync_from_disk()
        lines = [
            f"Harness state ({self.scope}): {self.file_path}",
            "Call contract: installed Python skills use await <skill_import>(...) or a matching shell CLI; "
            "harness skill entries are Python REPL skills and must include a Python reference plus arguments. "
            "Spawn a subagent spec by composing a concise task prompt and calling "
            "handle = await rlm('sub-task'); admission returns immediately with rlm_child_id, name, session_dir, "
            "and model, never the child's answer. Results arrive only through explicit agent_message replies or "
            "files; children reply with await agent_message.send(message, receiver_role='parent'). Use "
            "await rlm.list_subagents() to recover direct child handles and await agent_message.send(..., "
            "receiver_role='child', receiver_name=handle.name) for follow-ups.",
        ]
        for kind in _KINDS:
            records = self.list(kind)[:max_entries_per_kind]
            lines.append(f"{kind}: {len(self.entries[kind])}")
            for entry in records:
                summary = entry.content.strip().replace("\n", " ")
                if len(summary) > 120:
                    summary = f"{summary[:117]}..."
                argument_summary = ""
                if entry.kind == "skill" and entry.arguments:
                    argument_text = json.dumps(entry.arguments, ensure_ascii=False, sort_keys=True)
                    if len(argument_text) > 120:
                        argument_text = f"{argument_text[:117]}..."
                    argument_summary = f" args={argument_text}"
                reference_summary = ""
                if entry.kind == "skill" and entry.reference:
                    reference_text = json.dumps(entry.reference, ensure_ascii=False, sort_keys=True)
                    if len(reference_text) > 120:
                        reference_text = f"{reference_text[:117]}..."
                    reference_summary = f" ref={reference_text}"
                lines.append(
                    f"  - [{entry.scope}:{entry.id}] {entry.title} ({entry.path}, v{entry.version})"
                    f"{reference_summary}{argument_summary}: {summary}"
                )
            overflow = len(self.entries[kind]) - len(records)
            if overflow > 0:
                lines.append(f"  - +{overflow} more")
        if self.refinements:
            lines.append(f"refinements: {len(self.refinements)}")
            for event in self.refinements[-5:]:
                lines.append(f"  - [{event.id}] {event.trigger}: {', '.join(event.changes)}")
        else:
            lines.append("refinements: 0")
        return "\n".join(lines)

    def snapshot(self, *, global_: bool = False, **kwargs: Any) -> HarnessSnapshot:
        if target := self._global_target(global_, kwargs):
            return target.snapshot()
        self._sync_from_disk()
        return HarnessSnapshot(self._snapshot.generation, self._snapshot.sha256, {
            "file_path": str(self.file_path), "scope": self.scope,
            "entries": {kind: {entry_id: asdict(entry) for entry_id, entry in records.items()} for kind, records in self.entries.items()},
            "refinements": [asdict(event) for event in self.refinements],
        })


def get_harness_state(
    state_dir: str | Path | None = None, *, global_: bool = False, **kwargs: Any
) -> HarnessState:
    """Return the cached local harness state, or global when requested."""
    global_ = _resolve_global_flag(global_, kwargs)
    file_path = _state_file(state_dir, global_=global_)
    scope: HarnessScope = "global" if global_ else "local"
    cache_key = (file_path, scope)
    state = _state_cache.get(cache_key)
    if state is None:
        state = HarnessState(file_path, scope=scope)
        # Recorded at construction only: an instance created from env defaults must
        # keep targeting RLM_GLOBAL_HARNESS_STATE_DIR even when a later explicit
        # state_dir call aliases the same local file. An explicit dir that merely
        # aliases the env resolution must not sandbox later global_=True writes
        # either, so pin only when the explicit dir actually diverges.
        if state_dir is not None:
            try:
                env_file: Path | None = _state_file(global_=global_)
            except RuntimeError:
                env_file = None
            if file_path != env_file:
                state._global_target_state_dir = Path(state_dir).expanduser().resolve()
        _state_cache[cache_key] = state
    return state


__all__ = [
    "HarnessEntry",
    "HarnessSnapshot",
    "HarnessGenerationConflict",
    "HarnessLockBusy",
    "HarnessAtomicWriteUnsupported",
    "HarnessRecoveryRequired",
    "HarnessKind",
    "HarnessScope",
    "HarnessState",
    "RefinementEvent",
    "get_harness_state",
]
