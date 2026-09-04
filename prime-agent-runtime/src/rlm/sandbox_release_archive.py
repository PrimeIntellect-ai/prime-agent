"""Phase 1: streaming verify/parse a sandbox official-release archive.

Pure-Python-3.11-stdlib incremental preadv -> zlib -> tar state machine.
Bounded fixed-size buffers: no full-archive allocation.
Fixed StrEnum error codes; all types validated strictly before fd access.
"""

from __future__ import annotations

import dataclasses
import enum
import hashlib
import os
import re
import stat
import types
import zlib
from typing import Final

# ---------------------------------------------------------------------------
# Safety ceilings
# ---------------------------------------------------------------------------

MAX_COMPRESSED_BYTES: Final[int] = 96 * 1024 * 1024
MAX_DECOMPRESSED_TAR: Final[int] = 256 * 1024 * 1024
MAX_MEMBERS: Final[int] = 1024
MAX_REGULAR_FILES: Final[int] = 512
MAX_DIRECTORIES: Final[int] = 512
MAX_PER_FILE_BYTES: Final[int] = 192 * 1024 * 1024
MAX_TOTAL_FILE_BYTES: Final[int] = 224 * 1024 * 1024
MAX_PATH_UTF8_BYTES: Final[int] = 512
MAX_COMPONENT_UTF8_BYTES: Final[int] = 255

_VALID_FILE_MODES: Final[tuple[int, ...]] = (0o644, 0o755)
_VALID_DIR_MODE: Final[int] = 0o755

_USTAR_MAGIC: Final[bytes] = b"ustar\x00"
_USTAR_VERSION: Final[bytes] = b"00"

_TAR_BLOCK: Final[int] = 512
_MIN_ZERO_BLOCKS: Final[int] = 2

_CHAR_BLACKLIST: Final[bytes] = bytes(list(range(0x00, 0x20)))

_HEX64_RE: Final = re.compile(r"^[0-9a-f]{64}$")
_MODE_OCTAL_RE: Final = re.compile(r"^0[0-7]{3,4}$")

_C_BUF: Final[int] = 65536
_D_BUF: Final[int] = 65536
_PREADV_BUF: Final[int] = 1048576

# Zero-length file sentinel SHA-256 (hash of empty bytes)
_EMPTY_SHA256: Final[str] = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


# ---------------------------------------------------------------------------
# Fixed error codes
# ---------------------------------------------------------------------------


class ArchiveErrorCode(enum.StrEnum):
    """Every possible failure code emitted by verify_archive."""

    # Identity/manifest validation (before fd)
    BAD_IDENTITY_FIELD = "bad_identity_field"
    BAD_MANIFEST_FIELD = "bad_manifest_field"

    # fd validation
    BAD_FD_FIELD = "bad_fd_field"
    FD_STAT_FAILED = "fd_stat_failed"
    FD_NOT_REGULAR = "fd_not_regular"
    FD_BAD_MODE = "fd_bad_mode"
    FD_NOT_READABLE = "fd_not_readable"
    FD_NOT_OWNER = "fd_not_owner"
    FD_BAD_NLINK = "fd_bad_nlink"
    FD_TOO_SMALL = "fd_too_small"
    FD_TOO_LARGE = "fd_too_large"
    FD_IDENTITY_CHANGED = "fd_identity_changed"
    FD_SIZE_CHANGED = "fd_size_changed"

    # Compressed hash
    PREAD_ERROR = "pread_error"
    COMPRESSED_TRUNCATED = "compressed_truncated"
    COMPRESSED_TRAILING = "compressed_trailing"
    DIGEST_MISMATCH = "digest_mismatch"

    # Numeric field parsing
    BAD_NUMERIC_FIELD = "bad_numeric_field"

    # Tar header parsing
    BAD_BLOCK_SIZE = "bad_block_size"
    CHECKSUM_ERROR = "checksum_error"
    BAD_MAGIC = "bad_magic"
    BAD_VERSION = "bad_version"
    BAD_TYPE = "bad_type"
    BAD_NAME = "bad_name"
    BAD_LINK = "bad_link"
    BAD_DEVICE = "bad_device"
    BAD_MODE = "bad_mode"
    BAD_SIZE = "bad_size"
    BAD_MTIME = "bad_mtime"
    BAD_UID = "bad_uid"
    BAD_GID = "bad_gid"
    BAD_HEADER = "bad_header"
    BAD_CSTRING_PADDING = "bad_cstring_padding"
    BAD_TRAILING_SLASH = "bad_trailing_slash"
    BAD_ROOT_SPELLING = "bad_root_spelling"

    # Path validation
    BAD_PATH = "bad_path"

    # Streaming verify
    FILE_SHA_MISMATCH = "file_sha_mismatch"
    NON_ZERO_PADDING = "non_zero_padding"
    TAIL_NONZERO = "tail_nonzero"
    UNPAIRED_ZERO_BLOCK = "unpaired_zero_block"
    SECOND_TAR = "second_tar"
    DUPLICATE_PATH = "duplicate_path"
    PARENT_MISSING = "parent_missing"
    FILE_TOO_LARGE = "file_too_large"
    DIR_SIZE_MISMATCH = "dir_size_mismatch"
    ENTRY_NOT_IN_MANIFEST = "entry_not_in_manifest"
    ENTRY_TYPE_MISMATCH = "entry_type_mismatch"
    ENTRY_MODE_MISMATCH = "entry_mode_mismatch"
    ENTRY_SIZE_MISMATCH = "entry_size_mismatch"
    TOO_MANY_MEMBERS = "too_many_members"
    TOO_MANY_DIRS = "too_many_dirs"
    TOO_MANY_FILES = "too_many_files"
    TOTAL_BYTES_EXCEEDED = "total_bytes_exceeded"
    DECOMPRESSED_TOO_LARGE = "decompressed_too_large"
    GZIP_ERROR = "gzip_error"
    GZIP_TRAILING_DATA = "gzip_trailing_data"
    NO_ZERO_BLOCKS = "no_zero_blocks"
    MEMBER_COUNT_MISMATCH = "member_count_mismatch"
    FILE_COUNT_MISMATCH = "file_count_mismatch"
    DIR_COUNT_MISMATCH = "dir_count_mismatch"
    TOTAL_BYTES_MISMATCH = "total_bytes_mismatch"
    DECOMPRESSED_SIZE_MISMATCH = "decompressed_size_mismatch"

    # General
    INTERNAL_ERROR = "internal_error"
    NO_PROGRESS = "no_progress"
    GZIP_EOF_PREMATURE = "gzip_eof_premature"
    GZIP_UNUSED_DATA = "gzip_unused_data"
    ACTIVE_FILE_INCOMPLETE = "active_file_incomplete"
    ZERO_BLOCK_PARTIAL_HEADER = "zero_block_partial_header"
    TOTAL_NOT_MULTIPLE_512 = "total_not_multiple_512"
    ONE_ZERO_BLOCK = "one_zero_block"

    # Dataclass type validation
    BAD_DATACLASS_TYPE = "bad_dataclass_type"
    BAD_DATACLASS_KEY = "bad_dataclass_key"
    BAD_PRIMITIVE_TYPE = "bad_primitive_type"
    IDENTITY_MISMATCH = "identity_mismatch"
    PREADV_EXTRA = "preadv_extra"

    # Manifest structure
    ROOT_ENTRY_MISSING = "root_entry_missing"
    PARENT_ORDER = "parent_order"
    ZERO_LENGTH_EMPTY_SHA = "zero_length_empty_sha"


# Convenience alias: every error code str.
ErrorCode = ArchiveErrorCode  # shorthand


# ---------------------------------------------------------------------------
# Strict dataclass type validation helpers
# ---------------------------------------------------------------------------

def _check_strict_dataclass(
    obj: object,
    expected_keys: dict[str, type | types.UnionType],
    expected_class: type | None = None,
) -> str | None:
    """Validate exact instance storage without invoking instance attribute hooks."""
    try:
        if expected_class is not None and type(obj) is not expected_class:
            return "bad_dataclass_type"
        if expected_class is None and not hasattr(type(obj), "__dataclass_fields__"):
            return "bad_dataclass_type"
        values = object.__getattribute__(obj, "__dict__")
        if type(values) is not dict or set(values) != set(expected_keys):
            return "bad_dataclass_key"
        for key, expected_type in expected_keys.items():
            value = values[key]
            if isinstance(expected_type, types.UnionType):
                if not any(type(value) is member for member in expected_type.__args__):
                    return "bad_primitive_type"
            elif expected_type is type(None):
                if value is not None:
                    return "bad_primitive_type"
            elif type(value) is not expected_type:
                return "bad_primitive_type"
        return None
    except Exception:
        return "bad_dataclass_type"


# ---------------------------------------------------------------------------
# Immutable input types
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class ArchiveIdentity:
    compressed_sha256: str
    compressed_bytes: int


@dataclasses.dataclass(frozen=True)
class ManifestEntry:
    path: str
    type: str
    mode: str
    size: int
    sha256: str | None


@dataclasses.dataclass(frozen=True)
class Manifest:
    identity: ArchiveIdentity
    entries: tuple[ManifestEntry, ...]
    total_regular_bytes: int
    decompressed_tar_bytes: int


# ---------------------------------------------------------------------------
# Immutable result types (fixed codes only)
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class VerifyArchiveSuccess:
    pass


@dataclasses.dataclass(frozen=True)
class VerifyArchiveFailure:
    code: ArchiveErrorCode

    def __post_init__(self) -> None:
        if type(self.code) is not ArchiveErrorCode:
            raise ValueError("invalid archive error code")


VerifyResult = VerifyArchiveSuccess | VerifyArchiveFailure


# ---------------------------------------------------------------------------
# Field validation (before any fd access)
# ---------------------------------------------------------------------------


def _validate_identity(identity: ArchiveIdentity) -> ArchiveErrorCode | None:
    # Strict dataclass check
    err = _check_strict_dataclass(identity, {
        "compressed_sha256": str,
        "compressed_bytes": int,
    }, ArchiveIdentity)
    if err is not None:
        return ArchiveErrorCode(err)

    sha = identity.compressed_sha256
    csize = identity.compressed_bytes

    if not isinstance(sha, str) or not _HEX64_RE.match(sha):
        return ArchiveErrorCode.BAD_IDENTITY_FIELD
    if not isinstance(csize, int) or csize <= 0 or csize > MAX_COMPRESSED_BYTES:
        return ArchiveErrorCode.BAD_IDENTITY_FIELD
    return None


def _validate_manifest(
    manifest: Manifest,
    identity: ArchiveIdentity | None = None,
) -> ArchiveErrorCode | None:
    err = _check_strict_dataclass(manifest, {
        "identity": ArchiveIdentity,
        "entries": tuple,
        "total_regular_bytes": int,
        "decompressed_tar_bytes": int,
    }, Manifest)
    if err is not None:
        return ArchiveErrorCode(err)

    entries = manifest.identity
    identity_error = _validate_identity(entries)
    if identity_error is not None:
        return identity_error
    if identity is not None and (
        entries.compressed_sha256 != identity.compressed_sha256
        or entries.compressed_bytes != identity.compressed_bytes
    ):
        return ArchiveErrorCode.IDENTITY_MISMATCH

    manifest_entries = manifest.entries
    total_regular = manifest.total_regular_bytes
    decompressed_bytes = manifest.decompressed_tar_bytes
    if len(manifest_entries) == 0 or len(manifest_entries) > MAX_MEMBERS:
        return ArchiveErrorCode.BAD_MANIFEST_FIELD
    if total_regular < 0 or total_regular > MAX_TOTAL_FILE_BYTES:
        return ArchiveErrorCode.BAD_MANIFEST_FIELD
    if (
        decompressed_bytes <= 0
        or decompressed_bytes > MAX_DECOMPRESSED_TAR
        or decompressed_bytes % _TAR_BLOCK != 0
    ):
        return ArchiveErrorCode.BAD_MANIFEST_FIELD

    seen: set[str] = set()
    directories: set[str] = set()
    file_count = 0
    directory_count = 0
    counted_bytes = 0
    paths: list[str] = []
    for index, entry in enumerate(manifest_entries):
        entry_error = _validate_entry(entry, seen)
        if entry_error is not None:
            return entry_error
        path = entry.path
        paths.append(path)
        if index == 0:
            if path != "." or entry.type != "directory":
                return ArchiveErrorCode.ROOT_ENTRY_MISSING
        elif path == ".":
            return ArchiveErrorCode.BAD_MANIFEST_FIELD

        parent = _parent_path(path)
        if parent is not None and parent not in directories:
            parent_exists_later = any(
                type(candidate) is ManifestEntry
                and candidate.path == parent
                and candidate.type == "directory"
                for candidate in manifest_entries[index + 1:]
            )
            return ArchiveErrorCode.PARENT_ORDER if parent_exists_later else ArchiveErrorCode.BAD_MANIFEST_FIELD

        if entry.type == "file":
            file_count += 1
            counted_bytes += entry.size
        else:
            directory_count += 1
            directories.add(path)

    if paths != sorted(paths, key=lambda path: path.encode("utf-8")):
        return ArchiveErrorCode.PARENT_ORDER
    if file_count > MAX_REGULAR_FILES or directory_count > MAX_DIRECTORIES:
        return ArchiveErrorCode.BAD_MANIFEST_FIELD
    if counted_bytes != total_regular:
        return ArchiveErrorCode.BAD_MANIFEST_FIELD
    return None


def _validate_entry(entry: ManifestEntry, seen: set[str]) -> ArchiveErrorCode | None:
    err = _check_strict_dataclass(entry, {
        "path": str,
        "type": str,
        "mode": str,
        "size": int,
        "sha256": type(None) | str,
    }, ManifestEntry)
    if err is not None:
        return ArchiveErrorCode(err)

    path = entry.path
    entry_type = entry.type
    mode = entry.mode
    size = entry.size
    digest = entry.sha256
    try:
        raw_path = path.encode("utf-8")
    except UnicodeEncodeError:
        return ArchiveErrorCode.BAD_MANIFEST_FIELD
    normalized, path_error = _validate_path(raw_path)
    if path_error is not None or normalized != path or path.endswith("/"):
        return ArchiveErrorCode.BAD_MANIFEST_FIELD
    if path in seen:
        return ArchiveErrorCode.BAD_MANIFEST_FIELD
    if entry_type not in ("file", "directory"):
        return ArchiveErrorCode.BAD_MANIFEST_FIELD
    if entry_type == "directory":
        if mode != "0755" or size != 0 or digest is not None:
            return ArchiveErrorCode.BAD_MANIFEST_FIELD
    else:
        if mode not in ("0644", "0755"):
            return ArchiveErrorCode.BAD_MANIFEST_FIELD
        if size < 0 or size > MAX_PER_FILE_BYTES:
            return ArchiveErrorCode.BAD_MANIFEST_FIELD
        if type(digest) is not str or _HEX64_RE.fullmatch(digest) is None:
            return ArchiveErrorCode.BAD_MANIFEST_FIELD
        if size == 0 and digest != _EMPTY_SHA256:
            return ArchiveErrorCode.ZERO_LENGTH_EMPTY_SHA
    seen.add(path)
    return None


# ---------------------------------------------------------------------------
# fd validation
# ---------------------------------------------------------------------------


class _Snap:
    __slots__ = ("dev", "ino", "uid", "size", "mode")


def _fstat_validate(fd: int, expected_size: int) -> tuple[_Snap | None, ArchiveErrorCode | None]:
    try:
        st = os.fstat(fd)
    except OSError:
        return (None, ArchiveErrorCode.FD_STAT_FAILED)
    if not stat.S_ISREG(st.st_mode):
        return (None, ArchiveErrorCode.FD_NOT_REGULAR)
    mb = stat.S_IMODE(st.st_mode)
    if mb & 0o7022:
        return (None, ArchiveErrorCode.FD_BAD_MODE)
    if not (mb & 0o400):
        return (None, ArchiveErrorCode.FD_NOT_READABLE)
    uid = os.getuid()
    if st.st_uid != uid:
        return (None, ArchiveErrorCode.FD_NOT_OWNER)
    if st.st_nlink != 1:
        return (None, ArchiveErrorCode.FD_BAD_NLINK)
    sz = st.st_size
    if sz < expected_size:
        return (None, ArchiveErrorCode.FD_TOO_SMALL)
    if sz > MAX_COMPRESSED_BYTES:
        return (None, ArchiveErrorCode.FD_TOO_LARGE)
    snap = _Snap()
    snap.dev = st.st_dev
    snap.ino = st.st_ino
    snap.uid = uid
    snap.size = sz
    snap.mode = st.st_mode
    return (snap, None)


def _fstat_unchanged(fd: int, snap: _Snap) -> ArchiveErrorCode | None:
    try:
        st = os.fstat(fd)
    except OSError:
        return ArchiveErrorCode.FD_STAT_FAILED
    if st.st_dev != snap.dev or st.st_ino != snap.ino or st.st_uid != snap.uid:
        return ArchiveErrorCode.FD_IDENTITY_CHANGED
    if st.st_nlink != 1:
        return ArchiveErrorCode.FD_BAD_NLINK
    if st.st_mode != snap.mode:
        return ArchiveErrorCode.FD_IDENTITY_CHANGED
    if st.st_size != snap.size:
        return ArchiveErrorCode.FD_SIZE_CHANGED
    return None


# ---------------------------------------------------------------------------
# Compressed hash (os.preadv into mutable buffer)
# ---------------------------------------------------------------------------


def _hash_compressed(fd: int, expected_size: int, expected_digest: str) -> ArchiveErrorCode | None:
    digest = hashlib.sha256()
    buffer = bytearray(_PREADV_BUF)
    extra = bytearray(1)
    try:
        offset = 0
        while offset < expected_size:
            requested = min(len(buffer), expected_size - offset)
            view = memoryview(buffer)[:requested]
            try:
                count = os.preadv(fd, [view], offset)
            except OSError:
                return ArchiveErrorCode.PREAD_ERROR
            finally:
                view.release()
            if count == 0:
                return ArchiveErrorCode.COMPRESSED_TRUNCATED
            if count < 0 or count > requested:
                return ArchiveErrorCode.PREADV_EXTRA
            digest.update(memoryview(buffer)[:count])
            for index in range(count):
                buffer[index] = 0
            offset += count
        try:
            extra_count = os.preadv(fd, [extra], expected_size)
        except OSError:
            return ArchiveErrorCode.PREAD_ERROR
        if extra_count != 0:
            return ArchiveErrorCode.COMPRESSED_TRAILING
        if digest.hexdigest() != expected_digest:
            return ArchiveErrorCode.DIGEST_MISMATCH
        return None
    finally:
        for index in range(len(buffer)):
            buffer[index] = 0
        extra[0] = 0


# ---------------------------------------------------------------------------
# Octal field parsing
# ---------------------------------------------------------------------------


def _octal_to_int(field: bytes) -> tuple[int, ArchiveErrorCode | None]:
    try:
        if len(field) == 0 or (field[0] & 0x80):
            return (0, ArchiveErrorCode.BAD_NUMERIC_FIELD)
        cleaned = field.rstrip(b"\x00 ")
        if len(cleaned) == 0:
            return (0, None)
        for bc in cleaned:
            if bc < 0x30 or bc > 0x37:
                return (0, ArchiveErrorCode.BAD_NUMERIC_FIELD)
        val = int(cleaned.decode("ascii"), 8)
        return (val, None) if val >= 0 else (0, ArchiveErrorCode.BAD_NUMERIC_FIELD)
    except (ValueError, UnicodeDecodeError):
        return (0, ArchiveErrorCode.BAD_NUMERIC_FIELD)


# ---------------------------------------------------------------------------
# Cstring validation helper
# ---------------------------------------------------------------------------


def _validate_cstring(field: bytes) -> ArchiveErrorCode | None:
    """Ensure *field* is a valid null-terminated string with zero padding only after null.

    Returns None if valid, error code otherwise.
    """
    null_idx = field.find(b"\x00")
    if null_idx == -1:
        # No null at all — must pad with nulls; some tar implementations
        # allow full-field names without null if exact length.
        # Strict: require null within field.
        return ArchiveErrorCode.BAD_CSTRING_PADDING
    if null_idx == 0 and field.rstrip(b"\x00"):
        # Leading null with non-null after — invalid
        return ArchiveErrorCode.BAD_CSTRING_PADDING
    # Everything after the first null must be null
    for b in field[null_idx + 1:]:
        if b != 0:
            return ArchiveErrorCode.BAD_CSTRING_PADDING
    return None


# ---------------------------------------------------------------------------
# Tar header parsing
# ---------------------------------------------------------------------------


def _parse_tar_header(block: bytes) -> tuple[dict[str, object] | None, ArchiveErrorCode | None]:
    try:
        if len(block) != _TAR_BLOCK:
            return (None, ArchiveErrorCode.BAD_BLOCK_SIZE)
        raw_chk = block[148:156]
        computed = sum(block[:148]) + (32 * 8) + sum(block[156:])
        chk_v, chk_e = _octal_to_int(raw_chk)
        if chk_e is not None or chk_v != computed:
            return (None, ArchiveErrorCode.CHECKSUM_ERROR)
        if block[257:263] != _USTAR_MAGIC:
            return (None, ArchiveErrorCode.BAD_MAGIC)
        if block[263:265] != _USTAR_VERSION:
            return (None, ArchiveErrorCode.BAD_VERSION)
        tf = block[156:157]
        if tf not in (b"0", b"5"):
            return (None, ArchiveErrorCode.BAD_TYPE)

        # --- Cstring padding checks ---
        err = _validate_cstring(block[0:100])
        if err is not None:
            return (None, err)
        err = _validate_cstring(block[345:500])
        if err is not None:
            return (None, err)
        err = _validate_cstring(block[157:257])
        if err is not None:
            return (None, err)
        err = _validate_cstring(block[265:297])
        if err is not None:
            return (None, err)
        err = _validate_cstring(block[297:329])
        if err is not None:
            return (None, err)

        raw_name = block[0:100]
        prefix_raw = block[345:500]
        name_part = raw_name.rstrip(b"\x00")
        prefix_part = prefix_raw.rstrip(b"\x00")

        full_name = prefix_part + b"/" + name_part if prefix_part else name_part

        if b"\x00" in full_name:
            return (None, ArchiveErrorCode.BAD_NAME)

        # Check link field is all zeros
        if block[157:257].rstrip(b"\x00"):
            return (None, ArchiveErrorCode.BAD_LINK)

        # Device major/minor
        dm_v, dm_e = _octal_to_int(block[329:337])
        if dm_e is not None:
            return (None, ArchiveErrorCode.BAD_DEVICE)
        dn_v, dn_e = _octal_to_int(block[337:345])
        if dn_e is not None:
            return (None, ArchiveErrorCode.BAD_DEVICE)
        if dm_v != 0 or dn_v != 0:
            return (None, ArchiveErrorCode.BAD_DEVICE)

        # Numeric fields including all standard ones
        md_v, md_e = _octal_to_int(block[100:108])
        if md_e is not None:
            return (None, ArchiveErrorCode.BAD_MODE)
        sz_v, sz_e = _octal_to_int(block[124:136])
        if sz_e is not None:
            return (None, ArchiveErrorCode.BAD_SIZE)
        _, mt_e = _octal_to_int(block[136:148])
        if mt_e is not None:
            return (None, ArchiveErrorCode.BAD_MTIME)
        _, uid_e = _octal_to_int(block[108:116])
        if uid_e is not None:
            return (None, ArchiveErrorCode.BAD_UID)
        _, gid_e = _octal_to_int(block[116:124])
        if gid_e is not None:
            return (None, ArchiveErrorCode.BAD_GID)

        if any(block[500:512]):
            return (None, ArchiveErrorCode.BAD_HEADER)
        if full_name in (b".", b"./"):
            if full_name != b"./" or tf != b"5":
                return (None, ArchiveErrorCode.BAD_ROOT_SPELLING)
        elif tf == b"5" and not full_name.endswith(b"/"):
            return (None, ArchiveErrorCode.BAD_TRAILING_SLASH)
        elif tf == b"0" and full_name.endswith(b"/"):
            return (None, ArchiveErrorCode.BAD_TRAILING_SLASH)

        fields: dict[str, object] = {
            "name": full_name,
            "mode": md_v,
            "size": sz_v,
            "typeflag": tf,
        }
        return (fields, None)
    except (IndexError, ValueError):
        return (None, ArchiveErrorCode.BAD_HEADER)


# ---------------------------------------------------------------------------
# Path validation
# ---------------------------------------------------------------------------


def _validate_path(raw_path: bytes) -> tuple[str, ArchiveErrorCode | None]:
    try:
        if len(raw_path) == 0 or b"\x00" in raw_path or b"\\" in raw_path:
            return ("", ArchiveErrorCode.BAD_PATH)
        for bc in raw_path:
            if bc in _CHAR_BLACKLIST or bc == 0x7f:
                return ("", ArchiveErrorCode.BAD_PATH)
        try:
            raw_path.decode("utf-8")
        except UnicodeDecodeError:
            return ("", ArchiveErrorCode.BAD_PATH)
        if len(raw_path) > MAX_PATH_UTF8_BYTES:
            return ("", ArchiveErrorCode.BAD_PATH)
        path_str = raw_path.decode("utf-8")
        if path_str.startswith("/"):
            return ("", ArchiveErrorCode.BAD_PATH)
        if path_str.startswith("././") or path_str.startswith("./.."):
            return ("", ArchiveErrorCode.BAD_PATH)
        if path_str.startswith("./"):
            path_str = path_str[2:]
        if path_str.endswith("//"):
            return ("", ArchiveErrorCode.BAD_PATH)
        path_str = path_str.rstrip("/")
        if path_str == "":
            path_str = "."
        if path_str == ".":
            return (".", None)
        components = path_str.split("/")
        for comp in components:
            if comp in ("..", "", "."):
                return ("", ArchiveErrorCode.BAD_PATH)
            if len(comp.encode("utf-8")) > MAX_COMPONENT_UTF8_BYTES:
                return ("", ArchiveErrorCode.BAD_PATH)
        return (path_str, None)
    except Exception:
        return ("", ArchiveErrorCode.BAD_PATH)


def _parent_path(path: str) -> str | None:
    if path == ".":
        return None
    idx = path.rfind("/")
    if idx == -1:
        return "."
    parent = path[:idx]
    return "." if parent == "" else parent


# ---------------------------------------------------------------------------
# Streaming tar state machine
# ---------------------------------------------------------------------------


class _TarSink:
    """Synchronous bounded sink used by the shared archive parser."""

    def compressed_data(self, chunk: memoryview) -> ArchiveErrorCode | None:
        return None

    def directory(self, path: str, mode: int, entry: ManifestEntry) -> ArchiveErrorCode | None:
        return None

    def begin_file(
        self, path: str, mode: int, size: int, entry: ManifestEntry
    ) -> ArchiveErrorCode | None:
        return None

    def write_file(self, chunk: memoryview) -> ArchiveErrorCode | None:
        return None

    def finish_file(self) -> ArchiveErrorCode | None:
        return None

    def finish_archive(self) -> ArchiveErrorCode | None:
        return None


def _verify_streaming(
    fd: int,
    compressed_limit: int,
    manifest: Manifest,
    sink: _TarSink | None = None,
) -> ArchiveErrorCode | None:
    """Incremental preadv -> zlib -> tar verifier.

    Bounded architecture:
    - Fixed-size compressed input buffer (64 KB) with carryover for
      zlib unconsumed tail.  Never allocates the full compressed archive.
    - zlib.decompress with max_length=65536 for bounded output chunks.
    - State machine that holds at most one 512-byte header buffer plus
      counters and a single SHA-256 hasher.
    - File content is streamed through the hasher incrementally; padding
      bytes are skipped without buffering.
    - Absolute preadv offset is never decremented and data is never reread.
    - Zero-length files finalize immediately (no infinite loop).
    - Final checks reject active/incomplete file, remaining padding,
      partial header, total non-512, and one zero block.

    Returns error code or None on success.
    """
    by_path: dict[str, ManifestEntry] = {}
    for e in manifest.entries:
        by_path[e.path] = e
    mfc = sum(1 for e in manifest.entries if e.type == "file")
    mdc = sum(1 for e in manifest.entries if e.type == "directory")

    decomp = zlib.decompressobj(wbits=31)
    compressed_buffer = bytearray(_C_BUF)
    carryover = bytearray()
    comp_offset = 0

    # Decompressed-data state machine
    hdr = bytearray()          # header accumulation buf (< 512 bytes)
    fin = False                 # file-content-hashing mode active
    fres = 0                    # remaining file content bytes to hash
    fsha = ""                   # expected file sha256
    fpad = 0                    # remaining padding bytes to skip
    h = hashlib.sha256()
    mc = 0                      # member count
    fc = 0                      # file count
    dc = 0                      # dir count
    tfb = 0                     # total file bytes
    dtot = 0                    # total decompressed bytes
    seen: set[str] = set()
    dirs: set[str] = set()
    zc = 0                      # consecutive zero block count
    past = False                # end-of-tar marker passed

    def _finish_file() -> ArchiveErrorCode | None:
        nonlocal fin, h
        dig = h.hexdigest()
        if dig != fsha:
            return ArchiveErrorCode.FILE_SHA_MISMATCH
        if sink is not None:
            sink_error = sink.finish_file()
            if sink_error is not None:
                return sink_error
        h = hashlib.sha256()
        fin = False
        return None

    def _process_data(data: bytes) -> ArchiveErrorCode | None:
        nonlocal fin, fres, fsha, fpad, h
        nonlocal mc, fc, dc, tfb, dtot
        nonlocal zc, past
        pos = 0

        while pos < len(data):
            if fin:
                # Zero-length file guard: finalize immediately if no content
                if fres == 0:
                    finish_error = _finish_file()
                    if finish_error is not None:
                        return finish_error
                    continue

                hash_avail = min(fres, len(data) - pos)
                if hash_avail > 0:
                    chunk_view = memoryview(data)[pos:pos + hash_avail]
                    try:
                        if sink is not None:
                            sink_error = sink.write_file(chunk_view)
                            if sink_error is not None:
                                return sink_error
                        h.update(chunk_view)
                    finally:
                        chunk_view.release()
                    pos += hash_avail
                    fres -= hash_avail
                    if fres == 0:
                        finish_error = _finish_file()
                        if finish_error is not None:
                            return finish_error
                if fin:
                    continue

            if fpad > 0:
                skip = min(fpad, len(data) - pos)
                for b in data[pos:pos + skip]:
                    if b != 0:
                        return ArchiveErrorCode.NON_ZERO_PADDING
                pos += skip
                fpad -= skip
                if fpad > 0:
                    break
                continue

            if past:
                for b in data[pos:]:
                    if b != 0:
                        return ArchiveErrorCode.TAIL_NONZERO
                pos = len(data)
                break

            need = _TAR_BLOCK - len(hdr)
            take = min(need, len(data) - pos)
            hdr.extend(data[pos:pos + take])
            pos += take

            if len(hdr) < _TAR_BLOCK:
                break

            block = bytes(hdr)
            hdr.clear()

            zero = True
            for bc in block:
                if bc != 0:
                    zero = False
                    break

            if zero:
                zc += 1
                if zc >= _MIN_ZERO_BLOCKS:
                    past = True
                continue
            elif zc == 1:
                return ArchiveErrorCode.UNPAIRED_ZERO_BLOCK
            elif zc > 1:
                if past:
                    return ArchiveErrorCode.TAIL_NONZERO
                return ArchiveErrorCode.SECOND_TAR

            fields, hdr_err = _parse_tar_header(block)
            if hdr_err is not None:
                return hdr_err
            if not isinstance(fields, dict):
                return ArchiveErrorCode.BAD_HEADER

            tf_raw = fields.get("typeflag")
            if not isinstance(tf_raw, bytes) or len(tf_raw) == 0:
                return ArchiveErrorCode.BAD_HEADER
            raw_name = fields.get("name")
            if not isinstance(raw_name, bytes):
                return ArchiveErrorCode.BAD_HEADER
            mode_val = fields.get("mode", 0)
            if not isinstance(mode_val, int):
                return ArchiveErrorCode.BAD_HEADER
            size_val = fields.get("size", 0)
            if not isinstance(size_val, int):
                return ArchiveErrorCode.BAD_HEADER

            norm_path, path_err = _validate_path(raw_name)
            if path_err is not None:
                return path_err

            typeflag = tf_raw[0]
            if typeflag == ord("5"):
                etype = "directory"
            elif typeflag == ord("0"):
                etype = "file"
            else:
                return ArchiveErrorCode.BAD_TYPE

            if etype == "file":
                if mode_val not in _VALID_FILE_MODES:
                    return ArchiveErrorCode.BAD_MODE
            else:
                if mode_val != _VALID_DIR_MODE:
                    return ArchiveErrorCode.BAD_MODE

            if mc == 0 and norm_path != ".":
                return ArchiveErrorCode.PARENT_MISSING
            if norm_path in seen:
                return ArchiveErrorCode.DUPLICATE_PATH
            seen.add(norm_path)

            if norm_path != ".":
                p = _parent_path(norm_path)
                if p is not None and p != "." and p not in dirs:
                    return ArchiveErrorCode.PARENT_MISSING

            if size_val > MAX_PER_FILE_BYTES:
                return ArchiveErrorCode.FILE_TOO_LARGE
            if etype == "directory" and size_val != 0:
                return ArchiveErrorCode.DIR_SIZE_MISMATCH

            mentry = by_path.get(norm_path)
            if mentry is None:
                return ArchiveErrorCode.ENTRY_NOT_IN_MANIFEST
            if mentry.type != etype:
                return ArchiveErrorCode.ENTRY_TYPE_MISMATCH
            if int(mentry.mode, 8) != mode_val:
                return ArchiveErrorCode.ENTRY_MODE_MISMATCH
            if mentry.size != size_val:
                return ArchiveErrorCode.ENTRY_SIZE_MISMATCH

            mc += 1
            if mc > MAX_MEMBERS:
                return ArchiveErrorCode.TOO_MANY_MEMBERS

            if etype == "directory":
                dc += 1
                if dc > MAX_DIRECTORIES:
                    return ArchiveErrorCode.TOO_MANY_DIRS
                dirs.add(norm_path)
                if sink is not None:
                    sink_error = sink.directory(norm_path, mode_val, mentry)
                    if sink_error is not None:
                        return sink_error
            else:
                fc += 1
                if fc > MAX_REGULAR_FILES:
                    return ArchiveErrorCode.TOO_MANY_FILES
                tfb += size_val
                if tfb > MAX_TOTAL_FILE_BYTES:
                    return ArchiveErrorCode.TOTAL_BYTES_EXCEEDED

                fres = size_val
                total_data = ((size_val + _TAR_BLOCK - 1) // _TAR_BLOCK) * _TAR_BLOCK
                fpad = total_data - size_val
                fsha = mentry.sha256 if mentry.sha256 is not None else ""
                if sink is not None:
                    sink_error = sink.begin_file(norm_path, mode_val, size_val, mentry)
                    if sink_error is not None:
                        return sink_error
                fin = True

        return None

    try:
        while not decomp.eof:
            if carryover:
                input_size = len(carryover)
                input_view = memoryview(carryover)
                try:
                    try:
                        output = decomp.decompress(input_view, _D_BUF)
                    except zlib.error:
                        return ArchiveErrorCode.GZIP_ERROR
                finally:
                    input_view.release()
                unconsumed = decomp.unconsumed_tail
                for index in range(len(carryover)):
                    carryover[index] = 0
                carryover.clear()
                carryover.extend(unconsumed)
                if not output and len(carryover) >= input_size and not decomp.eof:
                    return ArchiveErrorCode.NO_PROGRESS
            else:
                if comp_offset >= compressed_limit:
                    return ArchiveErrorCode.COMPRESSED_TRUNCATED
                requested = min(_C_BUF, compressed_limit - comp_offset)
                read_view = memoryview(compressed_buffer)[:requested]
                try:
                    try:
                        count = os.preadv(fd, [read_view], comp_offset)
                    except OSError:
                        return ArchiveErrorCode.PREAD_ERROR
                finally:
                    read_view.release()
                if count == 0:
                    return ArchiveErrorCode.COMPRESSED_TRUNCATED
                if count < 0 or count > requested:
                    return ArchiveErrorCode.PREADV_EXTRA
                comp_offset += count
                input_view = memoryview(compressed_buffer)[:count]
                try:
                    if sink is not None:
                        sink_error = sink.compressed_data(input_view)
                        if sink_error is not None:
                            return sink_error
                    try:
                        output = decomp.decompress(input_view, _D_BUF)
                    except zlib.error:
                        return ArchiveErrorCode.GZIP_ERROR
                finally:
                    input_view.release()
                unconsumed = decomp.unconsumed_tail
                carryover.extend(unconsumed)
                for index in range(count):
                    compressed_buffer[index] = 0

            if output:
                dtot += len(output)
                if dtot > MAX_DECOMPRESSED_TAR:
                    return ArchiveErrorCode.DECOMPRESSED_TOO_LARGE
                process_error = _process_data(output)
                if process_error is not None:
                    return process_error

        if decomp.unused_data:
            return ArchiveErrorCode.GZIP_TRAILING_DATA
        if carryover:
            return ArchiveErrorCode.GZIP_UNUSED_DATA
        if comp_offset != compressed_limit:
            return ArchiveErrorCode.GZIP_EOF_PREMATURE

        # ---- Process remaining header buffer at EOF -----------------------
        if hdr:
            if zc == 1 and any(hdr):
                return ArchiveErrorCode.UNPAIRED_ZERO_BLOCK
            if past and any(hdr):
                return ArchiveErrorCode.TAIL_NONZERO
            return ArchiveErrorCode.ZERO_BLOCK_PARTIAL_HEADER

        # ---- Final checks -------------------------------------------------
        if zc == 1:
            return ArchiveErrorCode.ONE_ZERO_BLOCK
        if not past:
            return ArchiveErrorCode.NO_ZERO_BLOCKS

        # Reject if still mid-file (active/incomplete file)
        if fin:
            return ArchiveErrorCode.ACTIVE_FILE_INCOMPLETE
        if fpad > 0:
            return ArchiveErrorCode.NON_ZERO_PADDING

        if mc != len(manifest.entries):
            return ArchiveErrorCode.MEMBER_COUNT_MISMATCH
        if fc != mfc:
            return ArchiveErrorCode.FILE_COUNT_MISMATCH
        if dc != mdc:
            return ArchiveErrorCode.DIR_COUNT_MISMATCH
        if tfb != manifest.total_regular_bytes:
            return ArchiveErrorCode.TOTAL_BYTES_MISMATCH
        if dtot != manifest.decompressed_tar_bytes:
            return ArchiveErrorCode.DECOMPRESSED_SIZE_MISMATCH

        # Total decompressed bytes must be multiple of 512
        if dtot % _TAR_BLOCK != 0:
            return ArchiveErrorCode.TOTAL_NOT_MULTIPLE_512

        if sink is not None:
            sink_error = sink.finish_archive()
            if sink_error is not None:
                return sink_error
        return None

    finally:
        for index in range(len(compressed_buffer)):
            compressed_buffer[index] = 0
        for index in range(len(carryover)):
            carryover[index] = 0
        for index in range(len(hdr)):
            hdr[index] = 0
        carryover.clear()
        hdr.clear()
        h = hashlib.sha256()


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def verify_archive(
    fd: int,
    identity: ArchiveIdentity,
    manifest: Manifest,
) -> VerifyResult:
    """Phase 1: verify a sandbox official-release archive.

    True streaming: incremental preadv -> zlib -> tar state machine.
    Never allocates the full compressed archive or decompressed tar.
    Never closes caller fd.  Bounded fixed-size buffers.
    Returns frozen result with fixed error codes only.
    """
    err = _validate_identity(identity)
    if err is not None:
        return VerifyArchiveFailure(code=err)
    err = _validate_manifest(manifest, identity)
    if err is not None:
        return VerifyArchiveFailure(code=err)
    if type(fd) is not int or fd < 0:
        return VerifyArchiveFailure(code=ArchiveErrorCode.BAD_FD_FIELD)

    try:
        snap, err = _fstat_validate(fd, identity.compressed_bytes)
        if err is not None:
            return VerifyArchiveFailure(code=err)

        err = _hash_compressed(fd, identity.compressed_bytes, identity.compressed_sha256)
        if err is not None:
            return VerifyArchiveFailure(code=err)

        err = _fstat_unchanged(fd, snap)
        if err is not None:
            return VerifyArchiveFailure(code=err)

        try:
            tar_err = _verify_streaming(fd, identity.compressed_bytes, manifest)
        except Exception:
            return VerifyArchiveFailure(code=ArchiveErrorCode.INTERNAL_ERROR)

        if tar_err is not None:
            return VerifyArchiveFailure(code=tar_err)

        err = _fstat_unchanged(fd, snap)
        if err is not None:
            return VerifyArchiveFailure(code=err)

        return VerifyArchiveSuccess()
    finally:
        pass
