"""Decode canonical release-manifest JSON from assemble-release-archives.mjs.

Pure-Python-3.11-stdlib decoder with strict structural validation.
Rejects BOM, duplicate keys, floats, constants, oversized integers,
prototype-like keys, unknown/missing keys. Delegates path/entry/total
validation to ``_validate_manifest``. No files/network/env/logging.
Never raises.
"""

from __future__ import annotations
import codecs
import dataclasses
import enum
import json
import re
from typing import Final
from .sandbox_release_archive import (
    ArchiveIdentity,
    Manifest,
    ManifestEntry,
    _validate_manifest,
)

# ---------------------------------------------------------------------------
# Ceilings
# ---------------------------------------------------------------------------

_MAX_BYTES: Final[int] = 1048576
_MAX_VERSION: Final[int] = 64
_MAX_INT_DIGITS: Final[int] = 10
_MAX_INT: Final[int] = 9999999999
_MAX_ENTRIES: Final[int] = 1024
_PLATFORM: Final[str] = "linux-x64"
_MANIFEST_VERSION: Final[int] = 1
_VERSION_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9A-Za-z.-]+$")
_PROTO_KEYS: Final[frozenset[str]] = frozenset({"__proto__", "prototype", "constructor"})

# ---------------------------------------------------------------------------
# Error codes
# ---------------------------------------------------------------------------

class ManifestErrorCode(enum.StrEnum):
    BAD_ARGUMENT_TYPE = "bad_argument_type"
    MANIFEST_TOO_LARGE = "manifest_too_large"
    BAD_UTF8 = "bad_utf8"
    BOM_REJECTED = "bom_rejected"
    JSON_SYNTAX_ERROR = "json_syntax_error"
    FLOAT_REJECTED = "float_rejected"
    CONSTANT_REJECTED = "constant_rejected"
    OVERSIZED_INT = "oversized_int"
    DUPLICATE_KEY = "duplicate_key"
    PROTO_KEY = "proto_key"
    UNKNOWN_TOP_KEY = "unknown_top_key"
    MISSING_REQUIRED_KEY = "missing_required_key"
    BAD_FIELD_VALUE = "bad_field_value"
    BAD_ENTRY = "bad_entry"
    BAD_ENTRY_COUNT = "bad_entry_count"
    BAD_TOTAL = "bad_total"

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class DecodeManifestSuccess:
    manifest: Manifest

@dataclasses.dataclass(frozen=True)
class DecodeManifestFailure:
    code: ManifestErrorCode

    def __post_init__(self) -> None:
        if type(self.code) is not ManifestErrorCode:
            raise ValueError("invalid manifest error code")


DecodeManifestResult = DecodeManifestSuccess | DecodeManifestFailure

# ---------------------------------------------------------------------------
# Key schemas
# ---------------------------------------------------------------------------

_TOP_KEYS: Final[frozenset[str]] = frozenset({
    "manifestVersion",
    "version",
    "platform",
    "archive",
    "totalFiles",
    "totalDirectories",
    "totalSize",
    "entries",
    "decompressedTarBytes",
})
_REQUIRED_TOP: Final[frozenset[str]] = frozenset(_TOP_KEYS)
_FILE_KEYS: Final[frozenset[str]] = frozenset({"path", "type", "mode", "size", "sha256"})
_DIR_KEYS: Final[frozenset[str]] = frozenset({"path", "type", "mode", "size"})

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def decode_release_manifest(data: bytes, identity: ArchiveIdentity) -> DecodeManifestResult:
    """Decode the canonical release manifest JSON blob."""
    if type(data) is not bytes:
        return DecodeManifestFailure(ManifestErrorCode.BAD_ARGUMENT_TYPE)
    if type(identity) is not ArchiveIdentity:
        return DecodeManifestFailure(ManifestErrorCode.BAD_ARGUMENT_TYPE)
    if len(data) > _MAX_BYTES:
        return DecodeManifestFailure(ManifestErrorCode.MANIFEST_TOO_LARGE)
    if data[:3] == codecs.BOM_UTF8:
        return DecodeManifestFailure(ManifestErrorCode.BOM_REJECTED)
    if data[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return DecodeManifestFailure(ManifestErrorCode.BOM_REJECTED)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return DecodeManifestFailure(ManifestErrorCode.BAD_UTF8)
    errors: list[str] = []

    def _pair(pairs: list[tuple[str, object]]) -> dict[str, object]:
        seen: set[str] = set()
        out: dict[str, object] = {}
        for k, v in pairs:
            if not isinstance(k, str):
                if not errors:
                    errors.append("err")
                return {}
            if k in _PROTO_KEYS:
                if not errors:
                    errors.append("proto")
                return {}
            if k in seen:
                if not errors:
                    errors.append("dup")
                return {}
            seen.add(k)
            out[k] = v
        return out
    def _pf(_: str) -> float:
        if not errors:
            errors.append("float")
        return 0.0
    def _pi(s: str) -> int:
        if len(s.lstrip("-")) > _MAX_INT_DIGITS:
            if not errors:
                errors.append("big")
            return 0
        v = int(s, 10)
        if v < -_MAX_INT or v > _MAX_INT:
            if not errors:
                errors.append("big")
        return v
    def _pc(_: str) -> object:
        if not errors:
            errors.append("const")
        return None
    try:
        decoder = json.JSONDecoder(
            object_pairs_hook=_pair,
            parse_float=_pf,
            parse_int=_pi,
            parse_constant=_pc,
        )
        obj: object = decoder.decode(text)
    except (json.JSONDecodeError, RecursionError, ValueError):
        return DecodeManifestFailure(ManifestErrorCode.JSON_SYNTAX_ERROR)
    if errors:
        e = errors[0]
        if e == "float":
            return DecodeManifestFailure(ManifestErrorCode.FLOAT_REJECTED)
        if e == "const":
            return DecodeManifestFailure(ManifestErrorCode.CONSTANT_REJECTED)
        if e == "big":
            return DecodeManifestFailure(ManifestErrorCode.OVERSIZED_INT)
        if e == "dup":
            return DecodeManifestFailure(ManifestErrorCode.DUPLICATE_KEY)
        if e == "proto":
            return DecodeManifestFailure(ManifestErrorCode.PROTO_KEY)
        return DecodeManifestFailure(ManifestErrorCode.JSON_SYNTAX_ERROR)
    if type(obj) is not dict:
        return DecodeManifestFailure(ManifestErrorCode.JSON_SYNTAX_ERROR)
    keys = frozenset(obj.keys())
    missing = _REQUIRED_TOP - keys
    if missing:
        return DecodeManifestFailure(ManifestErrorCode.MISSING_REQUIRED_KEY)
    extra = keys - _TOP_KEYS
    if extra:
        return DecodeManifestFailure(ManifestErrorCode.UNKNOWN_TOP_KEY)
    if obj["manifestVersion"] != _MANIFEST_VERSION:
        return DecodeManifestFailure(ManifestErrorCode.BAD_FIELD_VALUE)
    if obj["platform"] != _PLATFORM:
        return DecodeManifestFailure(ManifestErrorCode.BAD_FIELD_VALUE)
    ver = obj["version"]
    if type(ver) is not str or not ver or len(ver) > _MAX_VERSION or not _VERSION_RE.fullmatch(ver):
        return DecodeManifestFailure(ManifestErrorCode.BAD_FIELD_VALUE)

    expected_archive = f"prime-agent-{ver}-linux-x64.tar.gz"
    if obj["archive"] != expected_archive:
        return DecodeManifestFailure(ManifestErrorCode.BAD_FIELD_VALUE)
    for key in ("totalFiles", "totalDirectories"):
        val = obj[key]
        if type(val) is not int or val < 0 or val > 512:
            return DecodeManifestFailure(ManifestErrorCode.BAD_FIELD_VALUE)
    total_size = obj["totalSize"]
    if type(total_size) is not int or total_size < 0:
        return DecodeManifestFailure(ManifestErrorCode.BAD_FIELD_VALUE)
    dec = obj["decompressedTarBytes"]
    if type(dec) is not int or dec <= 0:
        return DecodeManifestFailure(ManifestErrorCode.BAD_FIELD_VALUE)
    entries_raw = obj["entries"]
    if type(entries_raw) is not list:
        return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY)
    if len(entries_raw) == 0 or len(entries_raw) > _MAX_ENTRIES:
        return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY_COUNT)
    manifest_entries: list[ManifestEntry] = []
    cf = cd = cs = 0

    for raw in entries_raw:
        if type(raw) is not dict:
            return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY)
        etype = raw.get("type")
        if etype == "file":
            expect = _FILE_KEYS
        elif etype == "directory":
            expect = _DIR_KEYS
        else:
            return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY)
        if frozenset(raw.keys()) != expect:
            return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY)
        for k in ("path", "type", "mode"):
            v = raw.get(k)
            if type(v) is not str or not v:
                return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY)
        sz = raw["size"]
        if type(sz) is not int or sz < 0:
            return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY)
        if etype == "file":
            sha = raw["sha256"]
            if type(sha) is not str or raw["mode"] not in ("0644", "0755"):
                return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY)
            manifest_entries.append(ManifestEntry(raw["path"], "file", raw["mode"], sz, sha))
            cf += 1
            cs += sz
        else:
            if raw["mode"] != "0755" or sz != 0 or "sha256" in raw:
                return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY)
            manifest_entries.append(ManifestEntry(raw["path"], "directory", "0755", 0, None))
            cd += 1

    if cf != obj["totalFiles"] or cd != obj["totalDirectories"] or cs != total_size:
        return DecodeManifestFailure(ManifestErrorCode.BAD_TOTAL)
    try:
        manifest = Manifest(identity, tuple(manifest_entries), cs, dec)
    except Exception:
        return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY)
    archive_err = _validate_manifest(manifest, identity)
    if archive_err is not None:
        return DecodeManifestFailure(ManifestErrorCode.BAD_ENTRY)
    return DecodeManifestSuccess(manifest)