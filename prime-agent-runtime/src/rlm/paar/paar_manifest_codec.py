"""
PAAR (Prime Agent Artifact) v1 manifest/framing codec.

Pure codec — no filesystem, builder, verifier, installer, spawn, or network.
Encodes and decodes the PAAR v1 wire framing:

  ASCII "PAAR1" (5) + uint32BE manifest byte length + canonical UTF-8 JSON manifest

Payload bytes after the manifest are outside this codec's scope.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from typing import Final, NamedTuple

# ===========================================================================
# Protocol constants
# ===========================================================================

REMOTE_HOST_PROTOCOL_NAME: Final[str] = "prime-agent.remote-host"
REMOTE_HOST_PROTOCOL_VERSION: Final[int] = 1

# ===========================================================================
# Constants
# ===========================================================================

MAGIC0: Final[int] = 0x50  # P
MAGIC1: Final[int] = 0x41  # A
MAGIC2: Final[int] = 0x41  # A
MAGIC3: Final[int] = 0x52  # R
MAGIC4: Final[int] = 0x31  # 1
MAGIC_BYTES: Final[int] = 5
HEADER_PREFIX: Final[int] = MAGIC_BYTES + 4

MAX_MANIFEST_BYTES: Final[int] = 4 * 1024 * 1024
MAX_FILES: Final[int] = 20_000
MAX_FILE_SIZE: Final[int] = 256 * 1024 * 1024
MAX_TOTAL_PAYLOAD: Final[int] = 1024 * 1024 * 1024
MAX_ARCHIVE_SIZE: Final[int] = 1024 * 1024 * 1024
MAX_PATH_BYTES: Final[int] = 512

MAX_SAFE_INTEGER: Final[int] = 9_007_199_254_740_991

# ===========================================================================
# Error codes
# ===========================================================================


class _PaarErrors:
    SHORT_HEADER: str = "SHORT_HEADER"
    BAD_MAGIC: str = "BAD_MAGIC"
    MANIFEST_TOO_LARGE: str = "MANIFEST_TOO_LARGE"
    MANIFEST_TRUNCATED: str = "MANIFEST_TRUNCATED"
    ARCHIVE_TOO_LARGE: str = "ARCHIVE_TOO_LARGE"
    INVALID_UTF8: str = "INVALID_UTF8"
    INVALID_JSON: str = "INVALID_JSON"
    NON_CANONICAL: str = "NON_CANONICAL"
    BAD_FORMAT: str = "BAD_FORMAT"
    BAD_VERSION: str = "BAD_VERSION"
    BAD_TARGET: str = "BAD_TARGET"
    BAD_SOURCE_COMMIT: str = "BAD_SOURCE_COMMIT"
    BAD_PROTOCOL: str = "BAD_PROTOCOL"
    BAD_PROTOCOL_NAME: str = "BAD_PROTOCOL_NAME"
    BAD_PROTOCOL_VERSION: str = "BAD_PROTOCOL_VERSION"
    BAD_DAEMON_PROTOCOL_VERSION: str = "BAD_DAEMON_PROTOCOL_VERSION"
    BAD_DAEMON_SCHEMA_REVISION: str = "BAD_DAEMON_SCHEMA_REVISION"
    BAD_FILES: str = "BAD_FILES"
    BAD_FILE_ENTRY: str = "BAD_FILE_ENTRY"
    MISSING_MANIFEST_FIELD: str = "MISSING_MANIFEST_FIELD"
    MISSING_FILE_FIELD: str = "MISSING_FILE_FIELD"
    EXTRA_MANIFEST_FIELD: str = "EXTRA_MANIFEST_FIELD"
    INVALID_FILE_PATH: str = "INVALID_FILE_PATH"
    INVALID_FILE_MODE: str = "INVALID_FILE_MODE"
    INVALID_FILE_SIZE: str = "INVALID_FILE_SIZE"
    INVALID_FILE_HASH: str = "INVALID_FILE_HASH"
    INVALID_FILE_OFFSET: str = "INVALID_FILE_OFFSET"
    FILES_UNSORTED: str = "FILES_UNSORTED"
    DUPLICATE_FILE_PATH: str = "DUPLICATE_FILE_PATH"
    PAYLOAD_OVERFLOW: str = "PAYLOAD_OVERFLOW"
    FILES_DIGEST_MISMATCH: str = "FILES_DIGEST_MISMATCH"
    BUILD_ID_MISMATCH: str = "BUILD_ID_MISMATCH"
    TOTAL_ARCHIVE_MISMATCH: str = "TOTAL_ARCHIVE_MISMATCH"
    BAD_FILES_DIGEST: str = "BAD_FILES_DIGEST"
    BAD_BUILD_ID: str = "BAD_BUILD_ID"
    FILES_EMPTY: str = "FILES_EMPTY"
    CANONICAL_ENCODE_ERROR: str = "CANONICAL_ENCODE_ERROR"
    INPUT_NOT_PLAIN: str = "INPUT_NOT_PLAIN"
    PROTO_INVALID_ALIAS: str = "PROTO_INVALID_ALIAS"
    INVALID_INPUT: str = "INVALID_INPUT"


PAAR_ERRORS = _PaarErrors()

# ===========================================================================
# Public DTO types
# ===========================================================================

PaarTarget = str  # "linux-x64" | "linux-arm64"


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
    header: bytes


class PaarExpectation(NamedTuple):
    """Complete snapshot expectation for decode validation.

    All fields are exact required values that the decoded manifest
    must match.  ``archiveSha256`` may be finalized by the caller
    after decode, but the expectation must snapshot the value at call
    time.
    """
    archiveSize: int
    archiveSha256: str
    buildId: str
    sourceCommit: str
    target: PaarTarget
    protocolName: str
    protocolVersion: int
    daemonProtocolVersion: int
    daemonSchemaRevision: int


class PaarError(NamedTuple):
    code: str


PaarOk = NamedTuple("PaarOk", [("ok", bool), ("value", object)])
PaarErr = NamedTuple("PaarErr", [("ok", bool), ("error", PaarError)])
PaarResult = PaarOk | PaarErr


def _ok(value: object) -> PaarResult:
    return PaarOk(ok=True, value=value)


def _err(code: str) -> PaarResult:
    return PaarErr(ok=False, error=PaarError(code=code))


def _frozen_err(code: str) -> PaarResult:
    return PaarErr(ok=False, error=PaarError(code=code))


# ===========================================================================
# Internal helpers
# ===========================================================================


def _is_hex64(s: object) -> bool:
    if not isinstance(s, str):
        return False
    if len(s) != 64:
        return False
    for ch in s:
        if ch not in "0123456789abcdef":
            return False
    return True


def _is_hex40(s: object) -> bool:
    if not isinstance(s, str):
        return False
    if len(s) != 40:
        return False
    for ch in s:
        if ch not in "0123456789abcdef":
            return False
    return True


def _is_positive_safe_int(v: object) -> bool:
    return type(v) is int and v > 0 and v <= MAX_SAFE_INTEGER


def _is_nonnegative_safe_int(v: object) -> bool:
    return type(v) is int and v >= 0 and v <= MAX_SAFE_INTEGER


# ===========================================================================
# File path validation
# ===========================================================================


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
            ncp = ord(path[i + 1])
            if ncp < 0xDC00 or ncp > 0xDFFF:
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
            ncp = ord(s[i + 1])
            if 0xDC00 <= ncp <= 0xDFFF:
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
        return PAAR_ERRORS.INVALID_FILE_PATH
    if len(path) == 0:
        return PAAR_ERRORS.INVALID_FILE_PATH
    if not _is_nfc(path):
        return PAAR_ERRORS.INVALID_FILE_PATH
    if ord(path[0]) == 0x2F:
        return PAAR_ERRORS.INVALID_FILE_PATH
    if ord(path[-1]) == 0x2F:
        return PAAR_ERRORS.INVALID_FILE_PATH
    blen = _byte_length_utf8(path)
    if blen > MAX_PATH_BYTES or blen < 1:
        return PAAR_ERRORS.INVALID_FILE_PATH
    if _has_invalid_path_char(path):
        return PAAR_ERRORS.INVALID_FILE_PATH
    segments = path.split("/")
    for seg in segments:
        if len(seg) == 0 or seg == "." or seg == "..":
            return PAAR_ERRORS.INVALID_FILE_PATH
        if seg.startswith(".prime-agent-staging"):
            return PAAR_ERRORS.INVALID_FILE_PATH
    return None


# ===========================================================================
# Canonical JSON serialization
# ===========================================================================


def _json_str(s: str) -> str:
    """JSON.stringify(s) with ensure_ascii=False for printable non-ASCII."""
    return json.dumps(s, ensure_ascii=False, separators=(",", ":"))


def _encode_file_json(f: PaarFileEntry) -> str:
    return (
        '{"path":' + _json_str(f.path)
        + ',"size":' + str(f.size)
        + ',"mode":' + str(f.mode)
        + ',"sha256":' + _json_str(f.sha256)
        + ',"offset":' + str(f.offset) + "}"
    )


def _encode_files_array(files: tuple[PaarFileEntry, ...]) -> str:
    return "[" + ",".join(_encode_file_json(f) for f in files) + "]"


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


# ===========================================================================
# UTF-8 encode/decode
# ===========================================================================


def _utf8_encode(s: str) -> bytes:
    return s.encode("utf-8")


def _utf8_decode(data: bytes) -> str | None:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _read_uint32_be(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset: offset + 4], byteorder="big", signed=False)


# ===========================================================================
# Strict plain-object snapshot
# ===========================================================================


def _snapshot_own_data(value: object, expected_keys: frozenset[str]) -> PaarResult:
    if type(value) is not dict:
        return _err(PAAR_ERRORS.INPUT_NOT_PLAIN)
    d: dict[str, object] = value
    for k in d:
        if type(k) is not str:
            return _err(PAAR_ERRORS.INPUT_NOT_PLAIN)
    result: dict[str, object] = {}
    for k, v in d.items():
        if k not in expected_keys:
            return _err(PAAR_ERRORS.EXTRA_MANIFEST_FIELD)
        result[k] = v
    for ek in expected_keys:
        if ek not in result:
            return _err(PAAR_ERRORS.MISSING_MANIFEST_FIELD)
    return _ok(result)


def _snapshot_array_indices(raw: object) -> PaarResult:
    if type(raw) is not list:
        return _err(PAAR_ERRORS.BAD_FILES)
    lst: list[object] = raw
    if len(lst) == 0:
        return _err(PAAR_ERRORS.FILES_EMPTY)
    if len(lst) > MAX_FILES:
        return _err(PAAR_ERRORS.BAD_FILES)
    return _ok(lst)


# ===========================================================================
# Strict-copy a file entry
# ===========================================================================


def _strict_copy_file_entry(raw: object, seen: set[int]) -> PaarResult:
    if type(raw) is not dict:
        return _err(PAAR_ERRORS.BAD_FILE_ENTRY)
    ident = id(raw)
    if ident in seen:
        return _err(PAAR_ERRORS.PROTO_INVALID_ALIAS)
    seen.add(ident)
    snap = _snapshot_own_data(raw, frozenset({"path", "size", "mode", "sha256", "offset"}))
    if not snap.ok:
        return snap
    s: dict[str, object] = snap.value
    pchk = _check_file_path(s.get("path"))
    if pchk is not None:
        return _err(pchk)
    md = s.get("mode")
    if type(md) is not int:
        return _err(PAAR_ERRORS.INVALID_FILE_MODE)
    if md not in (0o644, 0o755):
        return _err(PAAR_ERRORS.INVALID_FILE_MODE)
    sz = s.get("size")
    if not _is_nonnegative_safe_int(sz) or sz > MAX_FILE_SIZE:
        return _err(PAAR_ERRORS.INVALID_FILE_SIZE)
    hx = s.get("sha256")
    if not _is_hex64(hx):
        return _err(PAAR_ERRORS.INVALID_FILE_HASH)
    off = s.get("offset")
    if not _is_nonnegative_safe_int(off):
        return _err(PAAR_ERRORS.INVALID_FILE_OFFSET)
    return _ok(
        PaarFileEntry(
            path=s["path"],
            size=s["size"],
            mode=s["mode"],
            sha256=s["sha256"],
            offset=s["offset"],
        )
    )


# ===========================================================================
# Public API: encode_paar_manifest
# ===========================================================================


def encode_paar_manifest(
    sourceCommit: str,
    target: PaarTarget,
    daemonProtocolVersion: int,
    daemonSchemaRevision: int,
    files: list[dict[str, object]],
) -> PaarResult:
    try:
        return _encode_paar_manifest_impl(
            sourceCommit, target, daemonProtocolVersion, daemonSchemaRevision, files
        )
    except Exception:
        return _frozen_err(PAAR_ERRORS.CANONICAL_ENCODE_ERROR)


def _encode_paar_manifest_impl(
    sourceCommit: str,
    target: PaarTarget,
    daemonProtocolVersion: int,
    daemonSchemaRevision: int,
    files: list[dict[str, object]],
) -> PaarResult:
    seen: set[int] = set()

    if not isinstance(sourceCommit, str) or not _is_hex40(sourceCommit):
        return _err(PAAR_ERRORS.BAD_SOURCE_COMMIT)
    if target not in ("linux-x64", "linux-arm64"):
        return _err(PAAR_ERRORS.BAD_TARGET)
    if not _is_positive_safe_int(daemonProtocolVersion):
        return _err(PAAR_ERRORS.BAD_DAEMON_PROTOCOL_VERSION)
    if not _is_nonnegative_safe_int(daemonSchemaRevision):
        return _err(PAAR_ERRORS.BAD_DAEMON_SCHEMA_REVISION)

    arr_result = _snapshot_array_indices(files)
    if not arr_result.ok:
        return arr_result
    raw_files: list[object] = arr_result.value

    entries: list[PaarFileEntry] = []
    path_set: set[str] = set()

    for raw_entry in raw_files:
        fe_result = _strict_copy_file_entry(raw_entry, seen)
        if not fe_result.ok:
            return fe_result
        fe: PaarFileEntry = fe_result.value
        nfc_path = unicodedata.normalize("NFC", fe.path)
        if nfc_path != fe.path:
            return _err(PAAR_ERRORS.INVALID_FILE_PATH)
        if fe.path in path_set:
            return _err(PAAR_ERRORS.DUPLICATE_FILE_PATH)
        path_set.add(fe.path)
        entries.append(fe)

    for i in range(1, len(entries)):
        if _utf8_encode(entries[i - 1].path) >= _utf8_encode(entries[i].path):
            return _err(PAAR_ERRORS.FILES_UNSORTED)

    running_off = 0
    for f in entries:
        if f.offset != running_off:
            return _err(PAAR_ERRORS.INVALID_FILE_OFFSET)
        running_off += f.size
    payload_size = running_off
    if payload_size > MAX_TOTAL_PAYLOAD:
        return _err(PAAR_ERRORS.PAYLOAD_OVERFLOW)

    files_digest_str = _encode_files_array(tuple(entries))
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
        return _err(PAAR_ERRORS.MANIFEST_TOO_LARGE)

    header_size = HEADER_PREFIX + len(manifest_bytes)
    header = bytearray(header_size)
    header[0] = MAGIC0; header[1] = MAGIC1; header[2] = MAGIC2
    header[3] = MAGIC3; header[4] = MAGIC4
    _write_uint32_be(header, 5, len(manifest_bytes))
    header[HEADER_PREFIX: HEADER_PREFIX + len(manifest_bytes)] = manifest_bytes

    archive_size = header_size + payload_size
    if archive_size > MAX_ARCHIVE_SIZE:
        return _err(PAAR_ERRORS.ARCHIVE_TOO_LARGE)

    return _ok(
        PaarEncodeResult(
            manifest=manifest,
            header=bytes(header),
            payloadSize=payload_size,
            headerSize=header_size,
            archiveSize=archive_size,
        )
    )


def _write_uint32_be(data: bytearray, offset: int, value: int) -> None:
    data[offset: offset + 4] = value.to_bytes(4, byteorder="big", signed=False)


# ===========================================================================
# Public API: decode_paar_manifest_header
# ===========================================================================


def decode_paar_manifest_header(
    data: object, expectation: PaarExpectation
) -> PaarResult:
    """Decode a PAAR v1 manifest header from an exact read buffer.

    *data* must be plain ``bytes`` (exact type, no subclass, no
    memoryview offset).  The caller must already have read at least
    ``HEADER_PREFIX + manifestLen`` bytes from the archive.
    After a successful decode the caller knows the stream position
    is exactly ``headerSize`` bytes from the start, at payload.

    *expectation* is a mandatory DTO with all fields that the decoded
    manifest must match exactly.
    """
    if type(data) is not bytes:
        return _frozen_err(PAAR_ERRORS.INVALID_INPUT)
    try:
        return _decode_paar_manifest_header_impl(data, expectation)
    except Exception:
        return _frozen_err(PAAR_ERRORS.INVALID_INPUT)


def _decode_paar_manifest_header_impl(
    data: bytes, expectation: PaarExpectation
) -> PaarResult:
    total_archive_size = expectation.archiveSize

    if not _is_positive_safe_int(total_archive_size) or total_archive_size > MAX_ARCHIVE_SIZE:
        return _err(PAAR_ERRORS.ARCHIVE_TOO_LARGE)

    if len(data) > total_archive_size:
        return _err(PAAR_ERRORS.INVALID_INPUT)

    if len(data) < HEADER_PREFIX:
        return _err(PAAR_ERRORS.SHORT_HEADER)

    if (
        data[0] != MAGIC0 or data[1] != MAGIC1 or data[2] != MAGIC2
        or data[3] != MAGIC3 or data[4] != MAGIC4
    ):
        return _err(PAAR_ERRORS.BAD_MAGIC)

    manifest_len = _read_uint32_be(data, 5)
    if manifest_len > MAX_MANIFEST_BYTES:
        return _err(PAAR_ERRORS.MANIFEST_TOO_LARGE)

    header_size = HEADER_PREFIX + manifest_len
    if len(data) < header_size:
        return _err(PAAR_ERRORS.MANIFEST_TRUNCATED)

    manifest_bytes = data[HEADER_PREFIX: HEADER_PREFIX + manifest_len]
    header_bytes = data[:header_size]

    manifest_str = _utf8_decode(manifest_bytes)
    if manifest_str is None:
        return _err(PAAR_ERRORS.INVALID_UTF8)

    reencoded = _utf8_encode(manifest_str)
    if len(reencoded) != len(manifest_bytes):
        return _err(PAAR_ERRORS.INVALID_UTF8)
    for i in range(len(manifest_bytes)):
        if manifest_bytes[i] != reencoded[i]:
            return _err(PAAR_ERRORS.INVALID_UTF8)

    try:
        parsed: object = json.loads(manifest_str)
    except json.JSONDecodeError:
        return _err(PAAR_ERRORS.INVALID_JSON)

    mobj_result = _snapshot_own_data(
        parsed,
        frozenset({"format", "version", "target", "sourceCommit",
                    "protocol", "filesDigest", "buildId", "files"}),
    )
    if not mobj_result.ok:
        return mobj_result
    mobj: dict[str, object] = mobj_result.value

    if mobj.get("format") != "prime-agent-artifact":
        return _err(PAAR_ERRORS.BAD_FORMAT)
    if mobj.get("version") != 1:
        return _err(PAAR_ERRORS.BAD_VERSION)
    if mobj.get("target") not in ("linux-x64", "linux-arm64"):
        return _err(PAAR_ERRORS.BAD_TARGET)
    if not isinstance(mobj.get("sourceCommit"), str) or not _is_hex40(mobj["sourceCommit"]):
        return _err(PAAR_ERRORS.BAD_SOURCE_COMMIT)

    proto_result = _snapshot_own_data(
        mobj.get("protocol"),
        frozenset({"name", "version", "daemonProtocolVersion", "daemonSchemaRevision"}),
    )
    if not proto_result.ok:
        return _err(PAAR_ERRORS.BAD_PROTOCOL)
    proto: dict[str, object] = proto_result.value

    if proto.get("name") != REMOTE_HOST_PROTOCOL_NAME:
        return _err(PAAR_ERRORS.BAD_PROTOCOL_NAME)
    if proto.get("version") != REMOTE_HOST_PROTOCOL_VERSION:
        return _err(PAAR_ERRORS.BAD_PROTOCOL_VERSION)
    if not _is_positive_safe_int(proto.get("daemonProtocolVersion")):
        return _err(PAAR_ERRORS.BAD_DAEMON_PROTOCOL_VERSION)
    if not _is_nonnegative_safe_int(proto.get("daemonSchemaRevision")):
        return _err(PAAR_ERRORS.BAD_DAEMON_SCHEMA_REVISION)

    if not isinstance(mobj.get("filesDigest"), str) or not _is_hex64(mobj["filesDigest"]):
        return _err(PAAR_ERRORS.BAD_FILES_DIGEST)
    if not isinstance(mobj.get("buildId"), str) or not _is_hex64(mobj["buildId"]):
        return _err(PAAR_ERRORS.BAD_BUILD_ID)

    raw_files_result = _snapshot_array_indices(mobj.get("files"))
    if not raw_files_result.ok:
        return raw_files_result
    raw_files: list[object] = raw_files_result.value

    parsed_files: list[PaarFileEntry] = []
    path_set: set[str] = set()

    for raw_entry in raw_files:
        fe_result = _snapshot_own_data(
            raw_entry, frozenset({"path", "size", "mode", "sha256", "offset"})
        )
        if not fe_result.ok:
            return fe_result
        fe: dict[str, object] = fe_result.value

        pchk = _check_file_path(fe.get("path"))
        if pchk is not None:
            return _err(pchk)

        if type(fe.get("mode")) is not int:
            return _err(PAAR_ERRORS.INVALID_FILE_MODE)
        if fe["mode"] not in (0o644, 0o755):
            return _err(PAAR_ERRORS.INVALID_FILE_MODE)
        if not _is_nonnegative_safe_int(fe.get("size")) or fe["size"] > MAX_FILE_SIZE:
            return _err(PAAR_ERRORS.INVALID_FILE_SIZE)
        if not isinstance(fe.get("sha256"), str) or not _is_hex64(fe["sha256"]):
            return _err(PAAR_ERRORS.INVALID_FILE_HASH)
        if not _is_nonnegative_safe_int(fe.get("offset")):
            return _err(PAAR_ERRORS.INVALID_FILE_OFFSET)

        p: str = fe["path"]
        if p in path_set:
            return _err(PAAR_ERRORS.DUPLICATE_FILE_PATH)
        path_set.add(p)

        parsed_files.append(
            PaarFileEntry(
                path=p, size=fe["size"], mode=fe["mode"],
                sha256=fe["sha256"], offset=fe["offset"],
            )
        )

    for i in range(1, len(parsed_files)):
        if _utf8_encode(parsed_files[i - 1].path) >= _utf8_encode(parsed_files[i].path):
            return _err(PAAR_ERRORS.FILES_UNSORTED)

    expected_off = 0
    for f in parsed_files:
        if f.offset != expected_off:
            return _err(PAAR_ERRORS.INVALID_FILE_OFFSET)
        expected_off += f.size
    payload_size = expected_off
    if payload_size > MAX_TOTAL_PAYLOAD:
        return _err(PAAR_ERRORS.PAYLOAD_OVERFLOW)

    if total_archive_size != header_size + payload_size:
        return _err(PAAR_ERRORS.TOTAL_ARCHIVE_MISMATCH)

    computed_fd_str = _encode_files_array(tuple(parsed_files))
    computed_fd = hashlib.sha256(computed_fd_str.encode("utf-8")).hexdigest()
    if computed_fd != mobj["filesDigest"]:
        return _err(PAAR_ERRORS.FILES_DIGEST_MISMATCH)

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
        return _err(PAAR_ERRORS.BUILD_ID_MISMATCH)

    # Validate against expectation
    if mobj["target"] != expectation.target:
        return _err(PAAR_ERRORS.BAD_TARGET)
    if mobj["sourceCommit"] != expectation.sourceCommit:
        return _err(PAAR_ERRORS.BAD_SOURCE_COMMIT)
    if mobj["buildId"] != expectation.buildId:
        return _err(PAAR_ERRORS.BUILD_ID_MISMATCH)
    if proto["name"] != expectation.protocolName:
        return _err(PAAR_ERRORS.BAD_PROTOCOL_NAME)
    if proto["version"] != expectation.protocolVersion:
        return _err(PAAR_ERRORS.BAD_PROTOCOL_VERSION)
    if proto["daemonProtocolVersion"] != expectation.daemonProtocolVersion:
        return _err(PAAR_ERRORS.BAD_DAEMON_PROTOCOL_VERSION)
    if proto["daemonSchemaRevision"] != expectation.daemonSchemaRevision:
        return _err(PAAR_ERRORS.BAD_DAEMON_SCHEMA_REVISION)

    fresh_manifest = PaarManifest(
        format="prime-agent-artifact", version=1,
        target=mobj["target"],
        sourceCommit=mobj["sourceCommit"],
        protocol=protocol_info,
        filesDigest=computed_fd,
        buildId=computed_bid,
        files=tuple(parsed_files),
    )
    re_canon = _utf8_encode(_encode_manifest_json(fresh_manifest))
    if len(re_canon) != len(manifest_bytes):
        return _err(PAAR_ERRORS.NON_CANONICAL)
    if hashlib.sha256(re_canon).digest() != hashlib.sha256(manifest_bytes).digest():
        return _err(PAAR_ERRORS.NON_CANONICAL)

    return _ok(
        PaarDecodeResult(
            manifest=fresh_manifest,
            payloadSize=payload_size,
            headerSize=header_size,
            archiveSize=total_archive_size,
            header=header_bytes,
        )
    )
