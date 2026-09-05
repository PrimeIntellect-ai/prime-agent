"""
PAAR (Prime Agent Artifact) v1 manifest/framing codec.

Pure codec — encodes and decodes the PAAR v1 wire framing:

  ASCII "PAAR1" (5) + uint32BE manifest byte length + canonical UTF-8 JSON manifest

Payload bytes after the manifest are outside this codec's scope.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from collections.abc import Sequence
from typing import Final, NamedTuple

# ---------------------------------------------------------------------------
# Protocol constants
# ---------------------------------------------------------------------------

REMOTE_HOST_PROTOCOL_NAME: Final[str] = "prime-agent.remote-host"
REMOTE_HOST_PROTOCOL_VERSION: Final[int] = 1

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAGIC0: Final[int] = 0x50  # P
MAGIC1: Final[int] = 0x41  # A
MAGIC2: Final[int] = 0x41  # A
MAGIC3: Final[int] = 0x52  # R
MAGIC4: Final[int] = 0x31  # 1
MAGIC_BYTES: Final[int] = 5
HEADER_PREFIX: Final[int] = MAGIC_BYTES + 4  # magic + uint32BE length

MAX_MANIFEST_BYTES: Final[int] = 4 * 1024 * 1024
MAX_FILES: Final[int] = 20_000
MAX_FILE_SIZE: Final[int] = 256 * 1024 * 1024
MAX_TOTAL_PAYLOAD: Final[int] = 1024 * 1024 * 1024
MAX_ARCHIVE_SIZE: Final[int] = 1024 * 1024 * 1024
MAX_PATH_BYTES: Final[int] = 512
SAFE_INT_MAX: Final[int] = 9_007_199_254_740_991

# ---------------------------------------------------------------------------
# Error codes
# ---------------------------------------------------------------------------

PAAR_ERRORS: Final[dict[str, str]] = {
    "SHORT_HEADER": "SHORT_HEADER",
    "BAD_MAGIC": "BAD_MAGIC",
    "MANIFEST_TOO_LARGE": "MANIFEST_TOO_LARGE",
    "MANIFEST_TRUNCATED": "MANIFEST_TRUNCATED",
    "ARCHIVE_TOO_LARGE": "ARCHIVE_TOO_LARGE",
    "INVALID_UTF8": "INVALID_UTF8",
    "INVALID_JSON": "INVALID_JSON",
    "NON_CANONICAL": "NON_CANONICAL",
    "BAD_FORMAT": "BAD_FORMAT",
    "BAD_VERSION": "BAD_VERSION",
    "BAD_TARGET": "BAD_TARGET",
    "BAD_SOURCE_COMMIT": "BAD_SOURCE_COMMIT",
    "BAD_PROTOCOL": "BAD_PROTOCOL",
    "BAD_PROTOCOL_NAME": "BAD_PROTOCOL_NAME",
    "BAD_PROTOCOL_VERSION": "BAD_PROTOCOL_VERSION",
    "BAD_DAEMON_PROTOCOL_VERSION": "BAD_DAEMON_PROTOCOL_VERSION",
    "BAD_DAEMON_SCHEMA_REVISION": "BAD_DAEMON_SCHEMA_REVISION",
    "BAD_FILES": "BAD_FILES",
    "BAD_FILE_ENTRY": "BAD_FILE_ENTRY",
    "MISSING_MANIFEST_FIELD": "MISSING_MANIFEST_FIELD",
    "MISSING_FILE_FIELD": "MISSING_FILE_FIELD",
    "EXTRA_MANIFEST_FIELD": "EXTRA_MANIFEST_FIELD",
    "INVALID_FILE_PATH": "INVALID_FILE_PATH",
    "INVALID_FILE_MODE": "INVALID_FILE_MODE",
    "INVALID_FILE_SIZE": "INVALID_FILE_SIZE",
    "INVALID_FILE_HASH": "INVALID_FILE_HASH",
    "INVALID_FILE_OFFSET": "INVALID_FILE_OFFSET",
    "FILES_UNSORTED": "FILES_UNSORTED",
    "DUPLICATE_FILE_PATH": "DUPLICATE_FILE_PATH",
    "PAYLOAD_OVERFLOW": "PAYLOAD_OVERFLOW",
    "FILES_DIGEST_MISMATCH": "FILES_DIGEST_MISMATCH",
    "BUILD_ID_MISMATCH": "BUILD_ID_MISMATCH",
    "TOTAL_ARCHIVE_MISMATCH": "TOTAL_ARCHIVE_MISMATCH",
    "BAD_FILES_DIGEST": "BAD_FILES_DIGEST",
    "BAD_BUILD_ID": "BAD_BUILD_ID",
    "FILES_EMPTY": "FILES_EMPTY",
    "CANONICAL_ENCODE_ERROR": "CANONICAL_ENCODE_ERROR",
    "INPUT_NOT_PLAIN": "INPUT_NOT_PLAIN",
    "PROTO_INVALID_ALIAS": "PROTO_INVALID_ALIAS",
    "INVALID_INPUT": "INVALID_INPUT",
}

PaarErrorCode: str  # type alias as a string

# ---------------------------------------------------------------------------
# Public DTO types
# ---------------------------------------------------------------------------

PaarTarget: str  # "linux-x64" | "linux-arm64"


class PaarFileEntry(NamedTuple):
    path: str
    size: int
    mode: int
    sha256: str
    offset: int


class PaarProtocolInfo(NamedTuple):
    name: str
    version: int
    daemonProtocolVersion: int
    daemonSchemaRevision: int


class PaarManifest(NamedTuple):
    format: str
    version: int
    target: PaarTarget
    sourceCommit: str
    protocol: PaarProtocolInfo
    filesDigest: str
    buildId: str
    files: tuple[PaarFileEntry, ...]


class PaarEncodeResult(NamedTuple):
    manifest: PaarManifest
    header: bytes
    payloadSize: int
    headerSize: int
    archiveSize: int


class PaarDecodeResult(NamedTuple):
    manifest: PaarManifest
    payloadSize: int
    headerSize: int
    archiveSize: int


class PaarError(NamedTuple):
    code: str


PaarOk = NamedTuple("PaarOk", [("ok", bool), ("value", object)])
PaarErr = NamedTuple("PaarErr", [("ok", bool), ("error", PaarError)])
PaarResult = PaarOk | PaarErr


def _ok(value: object) -> PaarResult:
    return PaarOk(ok=True, value=value)


def _err(code: str) -> PaarResult:
    return PaarErr(ok=False, error=PaarError(code=code))


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_HEX64_RE = frozenset("0123456789abcdef")


def _is_hex64(s: object) -> bool:
    return isinstance(s, str) and len(s) == 64 and all(ch in _HEX64_RE for ch in s)


def _is_hex40(s: object) -> bool:
    return isinstance(s, str) and len(s) == 40 and all(ch in _HEX64_RE for ch in s)


def _is_positive_safe_int(v: object) -> bool:
    return type(v) is int and v > 0 and v <= SAFE_INT_MAX


def _is_nonnegative_safe_int(v: object) -> bool:
    return type(v) is int and v >= 0 and v <= SAFE_INT_MAX


def _is_nfc(s: str) -> bool:
    try:
        return unicodedata.normalize("NFC", s) == s
    except Exception:
        return False


def _has_invalid_path_char(path: str) -> bool:
    i = 0
    while i < len(path):
        cp = ord(path[i])
        if cp <= 0x1F:
            return True
        if cp == 0x7F:
            return True
        if cp == 0xFEFF:
            return True
        if cp == 0x5C:
            return True
        if 0xD800 <= cp <= 0xDBFF:
            if i + 1 >= len(path):
                return True
            next_cp = ord(path[i + 1])
            if next_cp < 0xDC00 or next_cp > 0xDFFF:
                return True
            i += 2
            continue
        if 0xDC00 <= cp <= 0xDFFF:
            return True
        i += 1
    return False


def _byte_length_utf8(s: str) -> int:
    length = 0
    i = 0
    while i < len(s):
        cp = ord(s[i])
        if 0xD800 <= cp <= 0xDBFF and i + 1 < len(s):
            next_cp = ord(s[i + 1])
            if 0xDC00 <= next_cp <= 0xDFFF:
                length += 4
                i += 2
                continue
        if cp < 0x80:
            length += 1
        elif cp < 0x800:
            length += 2
        elif cp < 0xD800 or 0xDFFF < cp:
            length += 3
        else:
            length += 3
        i += 1
    return length


def _check_file_path(path: object) -> str | None:
    if not isinstance(path, str):
        return PAAR_ERRORS["INVALID_FILE_PATH"]
    if len(path) == 0:
        return PAAR_ERRORS["INVALID_FILE_PATH"]
    if not _is_nfc(path):
        return PAAR_ERRORS["INVALID_FILE_PATH"]
    if ord(path[0]) == 0x2F:
        return PAAR_ERRORS["INVALID_FILE_PATH"]
    if ord(path[-1]) == 0x2F:
        return PAAR_ERRORS["INVALID_FILE_PATH"]
    byte_len = _byte_length_utf8(path)
    if byte_len > MAX_PATH_BYTES or byte_len < 1:
        return PAAR_ERRORS["INVALID_FILE_PATH"]
    if _has_invalid_path_char(path):
        return PAAR_ERRORS["INVALID_FILE_PATH"]
    segments = path.split("/")
    for seg in segments:
        if len(seg) == 0 or seg == "." or seg == "..":
            return PAAR_ERRORS["INVALID_FILE_PATH"]
        if seg.startswith(".prime-agent-staging"):
            return PAAR_ERRORS["INVALID_FILE_PATH"]
    return None


# ---------------------------------------------------------------------------
# Canonical JSON serialization — fixed key order per schema
# ---------------------------------------------------------------------------


def _json_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False, separators=(",", ":"))


def _encode_file_json(f: PaarFileEntry) -> str:
    return (
        '{"path":' + _json_str(f.path)
        + ',"size":' + str(f.size)
        + ',"mode":' + str(f.mode)
        + ',"sha256":' + _json_str(f.sha256)
        + ',"offset":' + str(f.offset) + "}"
    )


def _encode_files_array(files: Sequence[PaarFileEntry]) -> str:
    parts = [_encode_file_json(f) for f in files]
    return "[" + ",".join(parts) + "]"


def _encode_protocol_json(p: PaarProtocolInfo) -> str:
    return (
        '{"name":' + _json_str(p.name)
        + ',"version":' + str(p.version)
        + ',"daemonProtocolVersion":' + str(p.daemonProtocolVersion)
        + ',"daemonSchemaRevision":' + str(p.daemonSchemaRevision) + "}"
    )


def _encode_manifest_json(m: PaarManifest) -> str:
    return (
        '{"format":' + _json_str(m.format)
        + ',"version":' + str(m.version)
        + ',"target":' + _json_str(m.target)
        + ',"sourceCommit":' + _json_str(m.sourceCommit)
        + ',"protocol":' + _encode_protocol_json(m.protocol)
        + ',"filesDigest":' + _json_str(m.filesDigest)
        + ',"buildId":' + _json_str(m.buildId)
        + ',"files":' + _encode_files_array(m.files) + "}"
    )


# ---------------------------------------------------------------------------
# UTF-8 encode / decode
# ---------------------------------------------------------------------------


def _utf8_encode(s: str) -> bytes:
    return s.encode("utf-8")


def _utf8_decode(data: bytes) -> str | None:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _read_uint32_be(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset: offset + 4], byteorder="big", signed=False)


# ---------------------------------------------------------------------------
# Validate and copy a file entry dict
# ---------------------------------------------------------------------------


def _strict_copy_file_entry(raw: object, seen: set[int]) -> PaarResult:
    if type(raw) is not dict:
        return _err(PAAR_ERRORS["BAD_FILE_ENTRY"])
    ident = id(raw)
    if ident in seen:
        return _err(PAAR_ERRORS["PROTO_INVALID_ALIAS"])
    seen.add(ident)

    expected_keys = frozenset({"path", "size", "mode", "sha256", "offset"})
    s: dict[str, object] = {}
    for k, v in raw.items():
        if type(k) is not str:
            return _err(PAAR_ERRORS["INPUT_NOT_PLAIN"])
        if k not in expected_keys:
            return _err(PAAR_ERRORS["EXTRA_MANIFEST_FIELD"])
        s[k] = v
    for ek in expected_keys:
        if ek not in s:
            return _err(PAAR_ERRORS["MISSING_MANIFEST_FIELD"])

    path_check = _check_file_path(s.get("path"))
    if path_check is not None:
        return _err(path_check)
    mode = s.get("mode")
    if type(mode) is not int:
        return _err(PAAR_ERRORS["INVALID_FILE_MODE"])
    if mode not in (0o644, 0o755):
        return _err(PAAR_ERRORS["INVALID_FILE_MODE"])
    size = s.get("size")
    if not _is_nonnegative_safe_int(size) or size > MAX_FILE_SIZE:
        return _err(PAAR_ERRORS["INVALID_FILE_SIZE"])
    sha256 = s.get("sha256")
    if not _is_hex64(sha256):
        return _err(PAAR_ERRORS["INVALID_FILE_HASH"])
    offset = s.get("offset")
    if not _is_nonnegative_safe_int(offset):
        return _err(PAAR_ERRORS["INVALID_FILE_OFFSET"])

    return _ok(PaarFileEntry(
        path=s["path"],
        size=s["size"],
        mode=s["mode"],
        sha256=s["sha256"],
        offset=s["offset"],
    ))


# ---------------------------------------------------------------------------
# Validate and copy files array
# ---------------------------------------------------------------------------


def _copy_files_array(raw: object, seen: set[int]) -> PaarResult:
    if type(raw) is not list:
        return _err(PAAR_ERRORS["BAD_FILES"])
    lst: list[object] = raw
    if len(lst) == 0:
        return _err(PAAR_ERRORS["FILES_EMPTY"])
    if len(lst) > MAX_FILES:
        return _err(PAAR_ERRORS["BAD_FILES"])
    entries: list[PaarFileEntry] = []
    path_set: set[str] = set()
    for raw_entry in lst:
        fe_result = _strict_copy_file_entry(raw_entry, seen)
        if not fe_result.ok:
            return fe_result
        fe: PaarFileEntry = fe_result.value
        nfc_path = unicodedata.normalize("NFC", fe.path)
        if nfc_path != fe.path:
            return _err(PAAR_ERRORS["INVALID_FILE_PATH"])
        if fe.path in path_set:
            return _err(PAAR_ERRORS["DUPLICATE_FILE_PATH"])
        path_set.add(fe.path)
        entries.append(fe)
    for i in range(1, len(entries)):
        buf_a = _utf8_encode(entries[i - 1].path)
        buf_b = _utf8_encode(entries[i].path)
        if buf_a >= buf_b:
            return _err(PAAR_ERRORS["FILES_UNSORTED"])
    running_off = 0
    for f in entries:
        if f.offset != running_off:
            return _err(PAAR_ERRORS["INVALID_FILE_OFFSET"])
        running_off += f.size
    if running_off > MAX_TOTAL_PAYLOAD:
        return _err(PAAR_ERRORS["PAYLOAD_OVERFLOW"])
    return _ok(entries)


# ---------------------------------------------------------------------------
# Public API: encode_paar_manifest
# ---------------------------------------------------------------------------


def encode_paar_manifest(
    sourceCommit: str,
    target: PaarTarget,
    daemonProtocolVersion: int,
    daemonSchemaRevision: int,
    files: list[dict[str, object]],
) -> PaarResult:
    try:
        return _encode_impl(sourceCommit, target, daemonProtocolVersion, daemonSchemaRevision, files)
    except Exception:
        return _err(PAAR_ERRORS["CANONICAL_ENCODE_ERROR"])


def _encode_impl(
    sourceCommit: str,
    target: PaarTarget,
    daemonProtocolVersion: int,
    daemonSchemaRevision: int,
    files: list[dict[str, object]],
) -> PaarResult:
    seen: set[int] = set()

    if not isinstance(sourceCommit, str) or not _is_hex40(sourceCommit):
        return _err(PAAR_ERRORS["BAD_SOURCE_COMMIT"])
    if target not in ("linux-x64", "linux-arm64"):
        return _err(PAAR_ERRORS["BAD_TARGET"])
    if not _is_positive_safe_int(daemonProtocolVersion):
        return _err(PAAR_ERRORS["BAD_DAEMON_PROTOCOL_VERSION"])
    if not _is_nonnegative_safe_int(daemonSchemaRevision):
        return _err(PAAR_ERRORS["BAD_DAEMON_SCHEMA_REVISION"])

    entries_result = _copy_files_array(files, seen)
    if not entries_result.ok:
        return entries_result
    entries: list[PaarFileEntry] = entries_result.value

    files_digest_str = _encode_files_array(entries)
    files_digest = hashlib.sha256(files_digest_str.encode("utf-8")).hexdigest()

    protocol = PaarProtocolInfo(
        name=REMOTE_HOST_PROTOCOL_NAME,
        version=REMOTE_HOST_PROTOCOL_VERSION,
        daemonProtocolVersion=daemonProtocolVersion,
        daemonSchemaRevision=daemonSchemaRevision,
    )

    build_id_str = (
        '{"sourceCommit":' + _json_str(sourceCommit)
        + ',"target":' + _json_str(target)
        + ',"protocol":' + _encode_protocol_json(protocol)
        + ',"filesDigest":' + _json_str(files_digest) + "}"
    )
    build_id = hashlib.sha256(build_id_str.encode("utf-8")).hexdigest()

    manifest = PaarManifest(
        format="prime-agent-artifact",
        version=1,
        target=target,
        sourceCommit=sourceCommit,
        protocol=protocol,
        filesDigest=files_digest,
        buildId=build_id,
        files=tuple(entries),
    )

    manifest_json = _encode_manifest_json(manifest)
    manifest_bytes = _utf8_encode(manifest_json)
    if len(manifest_bytes) > MAX_MANIFEST_BYTES:
        return _err(PAAR_ERRORS["MANIFEST_TOO_LARGE"])

    header_size = HEADER_PREFIX + len(manifest_bytes)
    header = bytearray(header_size)
    header[0] = MAGIC0
    header[1] = MAGIC1
    header[2] = MAGIC2
    header[3] = MAGIC3
    header[4] = MAGIC4
    header[5:9] = len(manifest_bytes).to_bytes(4, byteorder="big", signed=False)
    header[HEADER_PREFIX: HEADER_PREFIX + len(manifest_bytes)] = manifest_bytes

    payload_size = sum(f.size for f in entries)
    archive_size = header_size + payload_size
    if archive_size > MAX_ARCHIVE_SIZE:
        return _err(PAAR_ERRORS["ARCHIVE_TOO_LARGE"])

    return _ok(PaarEncodeResult(
        manifest=manifest,
        header=bytes(header),
        payloadSize=payload_size,
        headerSize=header_size,
        archiveSize=archive_size,
    ))


# ---------------------------------------------------------------------------
# Public API: decode_paar_manifest_header
# ---------------------------------------------------------------------------


def decode_paar_manifest_header(data: bytes, total_archive_size: int) -> PaarResult:
    if type(data) is not bytes:
        return _err(PAAR_ERRORS["INVALID_INPUT"])
    try:
        return _decode_impl(data, total_archive_size)
    except Exception:
        return _err(PAAR_ERRORS["INVALID_INPUT"])


def _decode_impl(data: bytes, total_archive_size: int) -> PaarResult:
    if not _is_positive_safe_int(total_archive_size) or total_archive_size > MAX_ARCHIVE_SIZE:
        return _err(PAAR_ERRORS["ARCHIVE_TOO_LARGE"])
    if len(data) > total_archive_size:
        return _err(PAAR_ERRORS["INVALID_INPUT"])
    if len(data) < HEADER_PREFIX:
        return _err(PAAR_ERRORS["SHORT_HEADER"])

    if (
        data[0] != MAGIC0 or data[1] != MAGIC1 or data[2] != MAGIC2
        or data[3] != MAGIC3 or data[4] != MAGIC4
    ):
        return _err(PAAR_ERRORS["BAD_MAGIC"])

    manifest_len = _read_uint32_be(data, 5)
    if manifest_len > MAX_MANIFEST_BYTES:
        return _err(PAAR_ERRORS["MANIFEST_TOO_LARGE"])

    header_size = HEADER_PREFIX + manifest_len
    if len(data) < header_size:
        return _err(PAAR_ERRORS["MANIFEST_TRUNCATED"])

    manifest_bytes = data[HEADER_PREFIX: header_size]
    manifest_str = _utf8_decode(manifest_bytes)
    if manifest_str is None:
        return _err(PAAR_ERRORS["INVALID_UTF8"])

    reencoded = _utf8_encode(manifest_str)
    if len(reencoded) != len(manifest_bytes) or reencoded != manifest_bytes:
        return _err(PAAR_ERRORS["INVALID_UTF8"])

    try:
        parsed: object = json.loads(manifest_str)
    except json.JSONDecodeError:
        return _err(PAAR_ERRORS["INVALID_JSON"])

    mobj_result = _snapshot_manifest_obj(parsed)
    if not mobj_result.ok:
        return mobj_result
    mobj: dict[str, object] = mobj_result.value

    if mobj.get("format") != "prime-agent-artifact":
        return _err(PAAR_ERRORS["BAD_FORMAT"])
    if mobj.get("version") != 1:
        return _err(PAAR_ERRORS["BAD_VERSION"])
    if mobj.get("target") not in ("linux-x64", "linux-arm64"):
        return _err(PAAR_ERRORS["BAD_TARGET"])
    if not isinstance(mobj.get("sourceCommit"), str) or not _is_hex40(mobj["sourceCommit"]):
        return _err(PAAR_ERRORS["BAD_SOURCE_COMMIT"])

    proto_result = _snapshot_protocol_obj(mobj.get("protocol"))
    if not proto_result.ok:
        return _err(PAAR_ERRORS["BAD_PROTOCOL"])
    proto: dict[str, object] = proto_result.value

    if proto.get("name") != REMOTE_HOST_PROTOCOL_NAME:
        return _err(PAAR_ERRORS["BAD_PROTOCOL_NAME"])
    if proto.get("version") != REMOTE_HOST_PROTOCOL_VERSION:
        return _err(PAAR_ERRORS["BAD_PROTOCOL_VERSION"])
    if not _is_positive_safe_int(proto.get("daemonProtocolVersion")):
        return _err(PAAR_ERRORS["BAD_DAEMON_PROTOCOL_VERSION"])
    if not _is_nonnegative_safe_int(proto.get("daemonSchemaRevision")):
        return _err(PAAR_ERRORS["BAD_DAEMON_SCHEMA_REVISION"])

    if not isinstance(mobj.get("filesDigest"), str) or not _is_hex64(mobj["filesDigest"]):
        return _err(PAAR_ERRORS["BAD_FILES_DIGEST"])
    if not isinstance(mobj.get("buildId"), str) or not _is_hex64(mobj["buildId"]):
        return _err(PAAR_ERRORS["BAD_BUILD_ID"])

    files_result = _decode_files_array(mobj.get("files"))
    if not files_result.ok:
        return files_result
    parsed_files: list[PaarFileEntry] = files_result.value

    payload_size = sum(f.size for f in parsed_files)
    if payload_size > MAX_TOTAL_PAYLOAD:
        return _err(PAAR_ERRORS["PAYLOAD_OVERFLOW"])
    if total_archive_size != header_size + payload_size:
        return _err(PAAR_ERRORS["TOTAL_ARCHIVE_MISMATCH"])

    computed_fd_str = _encode_files_array(parsed_files)
    computed_fd = hashlib.sha256(computed_fd_str.encode("utf-8")).hexdigest()
    if computed_fd != mobj["filesDigest"]:
        return _err(PAAR_ERRORS["FILES_DIGEST_MISMATCH"])

    protocol_info = PaarProtocolInfo(
        name=REMOTE_HOST_PROTOCOL_NAME,
        version=REMOTE_HOST_PROTOCOL_VERSION,
        daemonProtocolVersion=proto["daemonProtocolVersion"],
        daemonSchemaRevision=proto["daemonSchemaRevision"],
    )

    computed_bid_str = (
        '{"sourceCommit":' + _json_str(mobj["sourceCommit"])
        + ',"target":' + _json_str(mobj["target"])
        + ',"protocol":' + _encode_protocol_json(protocol_info)
        + ',"filesDigest":' + _json_str(computed_fd) + "}"
    )
    computed_bid = hashlib.sha256(computed_bid_str.encode("utf-8")).hexdigest()
    if computed_bid != mobj["buildId"]:
        return _err(PAAR_ERRORS["BUILD_ID_MISMATCH"])

    fresh_manifest = PaarManifest(
        format="prime-agent-artifact",
        version=1,
        target=mobj["target"],
        sourceCommit=mobj["sourceCommit"],
        protocol=protocol_info,
        filesDigest=computed_fd,
        buildId=computed_bid,
        files=tuple(parsed_files),
    )
    re_canon = _utf8_encode(_encode_manifest_json(fresh_manifest))
    if len(re_canon) != len(manifest_bytes) or hashlib.sha256(re_canon).digest() != hashlib.sha256(manifest_bytes).digest():
        return _err(PAAR_ERRORS["NON_CANONICAL"])

    return _ok(PaarDecodeResult(
        manifest=fresh_manifest,
        payloadSize=payload_size,
        headerSize=header_size,
        archiveSize=total_archive_size,
    ))


# ---------------------------------------------------------------------------
# Snapshot helpers for decode path (JSON-parsed objects are always plain)
# ---------------------------------------------------------------------------


def _snapshot_manifest_obj(parsed: object) -> PaarResult:
    if type(parsed) is not dict:
        return _err(PAAR_ERRORS["INPUT_NOT_PLAIN"])
    expected = frozenset({"format", "version", "target", "sourceCommit", "protocol", "filesDigest", "buildId", "files"})
    d: dict[str, object] = parsed
    result: dict[str, object] = {}
    for k, v in d.items():
        if type(k) is not str:
            return _err(PAAR_ERRORS["INPUT_NOT_PLAIN"])
        if k not in expected:
            return _err(PAAR_ERRORS["EXTRA_MANIFEST_FIELD"])
        result[k] = v
    for ek in expected:
        if ek not in result:
            return _err(PAAR_ERRORS["MISSING_MANIFEST_FIELD"])
    return _ok(result)


def _snapshot_protocol_obj(parsed: object) -> PaarResult:
    if type(parsed) is not dict:
        return _err(PAAR_ERRORS["BAD_PROTOCOL"])
    expected = frozenset({"name", "version", "daemonProtocolVersion", "daemonSchemaRevision"})
    d: dict[str, object] = parsed
    result: dict[str, object] = {}
    for k, v in d.items():
        if type(k) is not str:
            return _err(PAAR_ERRORS["INPUT_NOT_PLAIN"])
        if k not in expected:
            return _err(PAAR_ERRORS["EXTRA_MANIFEST_FIELD"])
        result[k] = v
    for ek in expected:
        if ek not in result:
            return _err(PAAR_ERRORS["MISSING_MANIFEST_FIELD"])
    return _ok(result)


def _decode_files_array(parsed: object) -> PaarResult:
    if type(parsed) is not list:
        return _err(PAAR_ERRORS["BAD_FILES"])
    lst: list[object] = parsed
    if len(lst) == 0:
        return _err(PAAR_ERRORS["FILES_EMPTY"])
    if len(lst) > MAX_FILES:
        return _err(PAAR_ERRORS["BAD_FILES"])
    expected = frozenset({"path", "size", "mode", "sha256", "offset"})
    entries: list[PaarFileEntry] = []
    path_set: set[str] = set()
    for raw_entry in lst:
        if type(raw_entry) is not dict:
            return _err(PAAR_ERRORS["BAD_FILE_ENTRY"])
        fe: dict[str, object] = {}
        for k, v in raw_entry.items():
            if type(k) is not str:
                return _err(PAAR_ERRORS["INPUT_NOT_PLAIN"])
            if k not in expected:
                return _err(PAAR_ERRORS["EXTRA_MANIFEST_FIELD"])
            fe[k] = v
        for ek in expected:
            if ek not in fe:
                return _err(PAAR_ERRORS["MISSING_MANIFEST_FIELD"])

        path_check = _check_file_path(fe.get("path"))
        if path_check is not None:
            return _err(path_check)
        if type(fe.get("mode")) is not int:
            return _err(PAAR_ERRORS["INVALID_FILE_MODE"])
        if fe["mode"] not in (0o644, 0o755):
            return _err(PAAR_ERRORS["INVALID_FILE_MODE"])
        if not _is_nonnegative_safe_int(fe.get("size")) or fe["size"] > MAX_FILE_SIZE:
            return _err(PAAR_ERRORS["INVALID_FILE_SIZE"])
        if not isinstance(fe.get("sha256"), str) or not _is_hex64(fe["sha256"]):
            return _err(PAAR_ERRORS["INVALID_FILE_HASH"])
        if not _is_nonnegative_safe_int(fe.get("offset")):
            return _err(PAAR_ERRORS["INVALID_FILE_OFFSET"])

        p: str = fe["path"]
        if p in path_set:
            return _err(PAAR_ERRORS["DUPLICATE_FILE_PATH"])
        path_set.add(p)
        entries.append(PaarFileEntry(
            path=p, size=fe["size"], mode=fe["mode"],
            sha256=fe["sha256"], offset=fe["offset"],
        ))

    for i in range(1, len(entries)):
        buf_a = _utf8_encode(entries[i - 1].path)
        buf_b = _utf8_encode(entries[i].path)
        if buf_a >= buf_b:
            return _err(PAAR_ERRORS["FILES_UNSORTED"])
    running_off = 0
    for f in entries:
        if f.offset != running_off:
            return _err(PAAR_ERRORS["INVALID_FILE_OFFSET"])
        running_off += f.size
    return _ok(entries)
