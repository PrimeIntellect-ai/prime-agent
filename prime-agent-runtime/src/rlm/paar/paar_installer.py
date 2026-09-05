"""Verify and install one PAAR1 archive without following filesystem links."""

from __future__ import annotations

import ctypes
import enum
import errno
import hashlib
import hmac
import os
import stat
import sys
from collections.abc import Callable
from typing import Final, NamedTuple

from .paar_manifest_codec import (
    HEADER_PREFIX,
    MAX_ARCHIVE_SIZE,
    MAX_MANIFEST_BYTES,
    PaarDecodeResult,
    PaarErr,
    PaarFileEntry,
    decode_paar_manifest_header,
)

_CHUNK_BYTES: Final[int] = 64 * 1024
_RENAME_NOREPLACE: Final[int] = 1
_HEX: Final[frozenset[str]] = frozenset("0123456789abcdef")
_TARGETS: Final[frozenset[str]] = frozenset(("linux-x64", "linux-arm64"))
_SUCCESS: Final[str] = "INSTALL_OK"


class InstallErrorCode(str, enum.Enum):
    INPUT_INVALID = "INPUT_INVALID"
    ARCHIVE_OPEN = "ARCHIVE_OPEN"
    ARCHIVE_STAT = "ARCHIVE_STAT"
    ARCHIVE_IDENTITY = "ARCHIVE_IDENTITY"
    HEADER_READ = "HEADER_READ"
    MANIFEST_DECODE = "MANIFEST_DECODE"
    MANIFEST_MISMATCH = "MANIFEST_MISMATCH"
    ARCHIVE_HASH = "ARCHIVE_HASH"
    FILE_HASH = "FILE_HASH"
    DEST_OPEN = "DEST_OPEN"
    STAGING_CREATE = "STAGING_CREATE"
    STAGING_OPEN = "STAGING_OPEN"
    DIRECTORY_CREATE = "DIRECTORY_CREATE"
    FILE_CREATE = "FILE_CREATE"
    FILE_WRITE = "FILE_WRITE"
    FILE_STAT = "FILE_STAT"
    PUBLISH = "PUBLISH"
    DEST_FSYNC = "DEST_FSYNC"
    CLEANUP_UNCERTAIN = "CLEANUP_UNCERTAIN"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class PaarInstallOk(NamedTuple):
    ok: bool
    value: str


class PaarInstallErr(NamedTuple):
    ok: bool
    error: InstallErrorCode


PaarInstallResult = PaarInstallOk | PaarInstallErr


class _InstallFailure(Exception):
    __slots__ = ("code",)

    def __init__(self, code: InstallErrorCode) -> None:
        self.code = code
        super().__init__(code.value)


class _Expected(NamedTuple):
    archive_size: int
    archive_sha256: str
    build_id: str
    source_commit: str
    target: str
    protocol_name: str
    protocol_version: int
    daemon_protocol_version: int
    daemon_schema_revision: int


class _Identity(NamedTuple):
    dev: int
    ino: int
    uid: int
    gid: int
    mode: int
    nlink: int
    size: int
    mtime_ns: int
    ctime_ns: int


def _is_hex(value: object, length: int) -> bool:
    return type(value) is str and len(value) == length and all(char in _HEX for char in value)


def _is_int(value: object, minimum: int = 0) -> bool:
    return type(value) is int and minimum <= value <= 9_007_199_254_740_991


def _expected(
    archive_size: object,
    archive_sha256: object,
    build_id: object,
    source_commit: object,
    target: object,
    protocol_name: object,
    protocol_version: object,
    daemon_protocol_version: object,
    daemon_schema_revision: object,
) -> _Expected | None:
    if not _is_int(archive_size, 1) or archive_size > MAX_ARCHIVE_SIZE:
        return None
    if not _is_hex(archive_sha256, 64) or not _is_hex(build_id, 64):
        return None
    if not _is_hex(source_commit, 40):
        return None
    if type(target) is not str or target not in _TARGETS:
        return None
    if type(protocol_name) is not str or protocol_name != "prime-agent.remote-host":
        return None
    if not _is_int(protocol_version, 1):
        return None
    if not _is_int(daemon_protocol_version, 1):
        return None
    if not _is_int(daemon_schema_revision):
        return None
    return _Expected(
        archive_size=archive_size,
        archive_sha256=archive_sha256,
        build_id=build_id,
        source_commit=source_commit,
        target=target,
        protocol_name=protocol_name,
        protocol_version=protocol_version,
        daemon_protocol_version=daemon_protocol_version,
        daemon_schema_revision=daemon_schema_revision,
    )


def _identity(raw: os.stat_result) -> _Identity:
    return _Identity(
        dev=raw.st_dev,
        ino=raw.st_ino,
        uid=raw.st_uid,
        gid=raw.st_gid,
        mode=raw.st_mode,
        nlink=raw.st_nlink,
        size=raw.st_size,
        mtime_ns=raw.st_mtime_ns,
        ctime_ns=raw.st_ctime_ns,
    )


def _close(fd: int) -> bool:
    try:
        os.close(fd)
    except OSError:
        return False
    return True


def _read_exact(fd: int, size: int, offset: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = os.pread(fd, min(remaining, _CHUNK_BYTES), offset)
        if not chunk:
            raise OSError(errno.EIO, "short archive read")
        chunks.append(chunk)
        offset += len(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _hash_range(fd: int, size: int, offset: int = 0) -> str:
    digest = hashlib.sha256()
    remaining = size
    while remaining:
        chunk = os.pread(fd, min(remaining, _CHUNK_BYTES), offset)
        if not chunk:
            raise OSError(errno.EIO, "short archive read")
        digest.update(chunk)
        offset += len(chunk)
        remaining -= len(chunk)
    return digest.hexdigest()


def _exact_eof(fd: int, offset: int) -> bool:
    return os.pread(fd, 1, offset) == b""


def _safe_parts(path: str) -> tuple[str, ...] | None:
    parts = tuple(path.split("/"))
    if not parts or any(part in ("", ".", "..") or "/" in part or "\x00" in part for part in parts):
        return None
    return parts


def _same_name(fd: int, parent_fd: int, name: str) -> bool:
    try:
        opened = os.fstat(fd)
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return False
    return stat.S_ISDIR(named.st_mode) and opened.st_dev == named.st_dev and opened.st_ino == named.st_ino


def _same_file(fd: int, parent_fd: int, name: str) -> bool:
    try:
        opened = os.fstat(fd)
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return False
    return stat.S_ISREG(named.st_mode) and opened.st_dev == named.st_dev and opened.st_ino == named.st_ino


def _close_or_raise(fd: int) -> None:
    if not _close(fd):
        raise _InstallFailure(InstallErrorCode.CLEANUP_UNCERTAIN)


def _open_parent(staging_fd: int, parts: tuple[str, ...]) -> tuple[int, bool]:
    current = staging_fd
    owned = False
    try:
        for part in parts:
            child = -1
            try:
                try:
                    child = os.open(
                        part,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                        dir_fd=current,
                    )
                except OSError as error:
                    if error.errno != errno.ENOENT:
                        raise
                    os.mkdir(part, 0o700, dir_fd=current)
                    os.fsync(current)
                    child = os.open(
                        part,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                        dir_fd=current,
                    )
                    os.fchmod(child, 0o700)
            except OSError as error:
                if child >= 0 and not _close(child):
                    raise _InstallFailure(InstallErrorCode.CLEANUP_UNCERTAIN) from error
                raise _InstallFailure(InstallErrorCode.DIRECTORY_CREATE) from error
            if not _same_name(child, current, part):
                if not _close(child):
                    raise _InstallFailure(InstallErrorCode.CLEANUP_UNCERTAIN)
                raise _InstallFailure(InstallErrorCode.DIRECTORY_CREATE)
            if owned:
                previous = current
                owned = False
                if not _close(previous):
                    if not _close(child):
                        raise _InstallFailure(InstallErrorCode.CLEANUP_UNCERTAIN)
                    raise _InstallFailure(InstallErrorCode.CLEANUP_UNCERTAIN)
            current = child
            owned = True
        return current, owned
    except BaseException:
        if owned:
            _close_or_raise(current)
        raise


def _write_file(
    archive_fd: int,
    staging_fd: int,
    payload_start: int,
    entry: PaarFileEntry,
) -> None:
    parts = _safe_parts(entry.path)
    if parts is None:
        raise _InstallFailure(InstallErrorCode.MANIFEST_DECODE)
    parent_fd, parent_owned = _open_parent(staging_fd, parts[:-1])
    output_fd = -1
    try:
        try:
            output_fd = os.open(
                parts[-1],
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                entry.mode,
                dir_fd=parent_fd,
            )
            os.fchmod(output_fd, entry.mode)
        except OSError as error:
            raise _InstallFailure(InstallErrorCode.FILE_CREATE) from error
        digest = hashlib.sha256()
        remaining = entry.size
        archive_offset = payload_start + entry.offset
        try:
            while remaining:
                chunk = os.pread(archive_fd, min(remaining, _CHUNK_BYTES), archive_offset)
                if not chunk:
                    raise _InstallFailure(InstallErrorCode.FILE_WRITE)
                digest.update(chunk)
                written = 0
                while written < len(chunk):
                    count = os.write(output_fd, chunk[written:])
                    if count <= 0:
                        raise _InstallFailure(InstallErrorCode.FILE_WRITE)
                    written += count
                remaining -= len(chunk)
                archive_offset += len(chunk)
            raw_stat = os.fstat(output_fd)
            if (
                not stat.S_ISREG(raw_stat.st_mode)
                or raw_stat.st_nlink != 1
                or raw_stat.st_size != entry.size
                or stat.S_IMODE(raw_stat.st_mode) != entry.mode
            ):
                raise _InstallFailure(InstallErrorCode.FILE_STAT)
            if not hmac.compare_digest(digest.hexdigest(), entry.sha256):
                raise _InstallFailure(InstallErrorCode.FILE_HASH)
            try:
                os.fsync(output_fd)
                os.fsync(parent_fd)
                if _identity(os.fstat(output_fd)) != _identity(raw_stat):
                    raise _InstallFailure(InstallErrorCode.FILE_STAT)
                if not _same_file(output_fd, parent_fd, parts[-1]):
                    raise _InstallFailure(InstallErrorCode.FILE_STAT)
            except _InstallFailure:
                raise
            except OSError as error:
                raise _InstallFailure(InstallErrorCode.CLEANUP_UNCERTAIN) from error
        except _InstallFailure:
            raise
        except OSError as error:
            raise _InstallFailure(InstallErrorCode.FILE_WRITE) from error
    finally:
        close_certain = True
        if output_fd >= 0 and not _close(output_fd):
            close_certain = False
        if parent_owned and not _close(parent_fd):
            close_certain = False
        if not close_certain:
            raise _InstallFailure(InstallErrorCode.CLEANUP_UNCERTAIN)


def _clear_directory(fd: int) -> bool:
    certain = True
    try:
        names = os.listdir(fd)
    except OSError:
        return False
    for name in names:
        child_fd = -1
        try:
            child_fd = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=fd,
            )
        except OSError:
            try:
                os.unlink(name, dir_fd=fd)
            except OSError:
                certain = False
            continue
        child_certain = _clear_directory(child_fd)
        if not _close(child_fd):
            child_certain = False
        if child_certain:
            try:
                os.rmdir(name, dir_fd=fd)
            except OSError:
                child_certain = False
        certain = certain and child_certain
    return certain


def _cleanup_staging(dest_fd: int, staging_fd: int, staging_name: str, staging_created: bool) -> bool:
    if not staging_created:
        return True
    certain = True
    if staging_fd >= 0:
        if not _same_name(staging_fd, dest_fd, staging_name):
            certain = False
        if not _clear_directory(staging_fd):
            certain = False
        if not _close(staging_fd):
            certain = False
    if certain:
        try:
            os.rmdir(staging_name, dir_fd=dest_fd)
            os.fsync(dest_fd)
        except OSError:
            certain = False
    return certain


try:
    _LIBC = ctypes.CDLL(None, use_errno=True)
    _RENAMEAT2 = _LIBC.renameat2
    _RENAMEAT2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    _RENAMEAT2.restype = ctypes.c_int
except (AttributeError, OSError):
    _RENAMEAT2 = None


def _linux_rename_no_replace(old_dir_fd: int, old_name: str, new_dir_fd: int, new_name: str) -> None:
    if _RENAMEAT2 is None:
        raise OSError(errno.ENOSYS, "renameat2 unavailable")
    result = _RENAMEAT2(
        old_dir_fd,
        os.fsencode(old_name),
        new_dir_fd,
        os.fsencode(new_name),
        _RENAME_NOREPLACE,
    )
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, "renameat2 failed")


_rename_no_replace: Callable[[int, str, int, str], None] = _linux_rename_no_replace


def _matches_manifest(decoded: PaarDecodeResult, expected: _Expected) -> bool:
    manifest = decoded.manifest
    return (
        decoded.archiveSize == expected.archive_size
        and hmac.compare_digest(manifest.buildId, expected.build_id)
        and hmac.compare_digest(manifest.sourceCommit, expected.source_commit)
        and manifest.target == expected.target
        and manifest.protocol.name == expected.protocol_name
        and manifest.protocol.version == expected.protocol_version
        and manifest.protocol.daemonProtocolVersion == expected.daemon_protocol_version
        and manifest.protocol.daemonSchemaRevision == expected.daemon_schema_revision
    )


def _install_core(archive_fd: int, dest_fd: int, expected: _Expected, initial_identity: _Identity) -> PaarInstallResult:
    staging_name = f".prime-agent-staging-{expected.build_id}"
    staging_fd = -1
    staging_created = False
    published = False
    result: PaarInstallResult
    try:
        try:
            prefix = _read_exact(archive_fd, HEADER_PREFIX, 0)
            manifest_size = int.from_bytes(prefix[5:9], "big", signed=False)
            if manifest_size > MAX_MANIFEST_BYTES:
                raise _InstallFailure(InstallErrorCode.HEADER_READ)
            header = prefix + _read_exact(archive_fd, manifest_size, HEADER_PREFIX)
        except _InstallFailure:
            raise
        except OSError as error:
            raise _InstallFailure(InstallErrorCode.HEADER_READ) from error
        decoded_raw = decode_paar_manifest_header(header, expected.archive_size)
        if isinstance(decoded_raw, PaarErr):
            raise _InstallFailure(InstallErrorCode.MANIFEST_DECODE)
        decoded = decoded_raw.value
        if not isinstance(decoded, PaarDecodeResult) or not _matches_manifest(decoded, expected):
            raise _InstallFailure(InstallErrorCode.MANIFEST_MISMATCH)
        try:
            if not hmac.compare_digest(_hash_range(archive_fd, expected.archive_size), expected.archive_sha256):
                raise _InstallFailure(InstallErrorCode.ARCHIVE_HASH)
            if not _exact_eof(archive_fd, expected.archive_size):
                raise _InstallFailure(InstallErrorCode.ARCHIVE_HASH)
            if _identity(os.fstat(archive_fd)) != initial_identity:
                raise _InstallFailure(InstallErrorCode.ARCHIVE_IDENTITY)
        except _InstallFailure:
            raise
        except OSError as error:
            raise _InstallFailure(InstallErrorCode.ARCHIVE_HASH) from error
        try:
            os.mkdir(staging_name, 0o700, dir_fd=dest_fd)
            staging_created = True
        except OSError as error:
            raise _InstallFailure(InstallErrorCode.STAGING_CREATE) from error
        try:
            staging_fd = os.open(
                staging_name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=dest_fd,
            )
            os.fchmod(staging_fd, 0o700)
        except OSError as error:
            raise _InstallFailure(InstallErrorCode.STAGING_OPEN) from error
        if not _same_name(staging_fd, dest_fd, staging_name):
            raise _InstallFailure(InstallErrorCode.STAGING_OPEN)
        for entry in decoded.manifest.files:
            _write_file(archive_fd, staging_fd, decoded.headerSize, entry)
        try:
            os.fsync(staging_fd)
            if _identity(os.fstat(archive_fd)) != initial_identity:
                raise _InstallFailure(InstallErrorCode.ARCHIVE_IDENTITY)
            if not hmac.compare_digest(_hash_range(archive_fd, expected.archive_size), expected.archive_sha256):
                raise _InstallFailure(InstallErrorCode.ARCHIVE_HASH)
            if not _exact_eof(archive_fd, expected.archive_size):
                raise _InstallFailure(InstallErrorCode.ARCHIVE_HASH)
            if _identity(os.fstat(archive_fd)) != initial_identity:
                raise _InstallFailure(InstallErrorCode.ARCHIVE_IDENTITY)
        except _InstallFailure:
            raise
        except OSError as error:
            raise _InstallFailure(InstallErrorCode.ARCHIVE_HASH) from error
        if not _same_name(staging_fd, dest_fd, staging_name):
            raise _InstallFailure(InstallErrorCode.PUBLISH)
        try:
            _rename_no_replace(dest_fd, staging_name, dest_fd, expected.build_id)
            published = True
        except OSError as error:
            raise _InstallFailure(InstallErrorCode.PUBLISH) from error
        try:
            os.fsync(dest_fd)
        except OSError as error:
            raise _InstallFailure(InstallErrorCode.DEST_FSYNC) from error
        result = PaarInstallOk(ok=True, value=_SUCCESS)
    except _InstallFailure as failure:
        result = PaarInstallErr(ok=False, error=failure.code)
    except BaseException:
        result = PaarInstallErr(ok=False, error=InstallErrorCode.INTERNAL_ERROR)
    if published:
        if staging_fd >= 0 and not _close(staging_fd):
            return PaarInstallErr(ok=False, error=InstallErrorCode.CLEANUP_UNCERTAIN)
        return result
    if isinstance(result, PaarInstallErr) and result.error is InstallErrorCode.CLEANUP_UNCERTAIN:
        if staging_fd >= 0:
            _close(staging_fd)
        return result
    if not _cleanup_staging(dest_fd, staging_fd, staging_name, staging_created):
        return PaarInstallErr(ok=False, error=InstallErrorCode.CLEANUP_UNCERTAIN)
    return result


def install_paar(
    archive_path: object,
    destination_path: object,
    *,
    expected_archive_size: object,
    expected_archive_sha256: object,
    expected_build_id: object,
    expected_source_commit: object,
    expected_target: object,
    expected_protocol_name: object,
    expected_protocol_version: object,
    expected_daemon_protocol_version: object,
    expected_daemon_schema_revision: object,
) -> PaarInstallResult:
    expected = _expected(
        expected_archive_size,
        expected_archive_sha256,
        expected_build_id,
        expected_source_commit,
        expected_target,
        expected_protocol_name,
        expected_protocol_version,
        expected_daemon_protocol_version,
        expected_daemon_schema_revision,
    )
    if type(archive_path) is not str or type(destination_path) is not str or expected is None:
        return PaarInstallErr(ok=False, error=InstallErrorCode.INPUT_INVALID)
    archive_fd = -1
    dest_fd = -1
    result: PaarInstallResult = PaarInstallErr(ok=False, error=InstallErrorCode.INTERNAL_ERROR)
    try:
        try:
            archive_fd = os.open(archive_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            result = PaarInstallErr(ok=False, error=InstallErrorCode.ARCHIVE_OPEN)
        if archive_fd >= 0:
            try:
                initial = _identity(os.fstat(archive_fd))
            except OSError:
                result = PaarInstallErr(ok=False, error=InstallErrorCode.ARCHIVE_STAT)
            else:
                if not stat.S_ISREG(initial.mode) or initial.nlink != 1 or initial.size != expected.archive_size:
                    result = PaarInstallErr(ok=False, error=InstallErrorCode.ARCHIVE_IDENTITY)
                else:
                    try:
                        dest_fd = os.open(
                            destination_path,
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                        )
                    except OSError:
                        result = PaarInstallErr(ok=False, error=InstallErrorCode.DEST_OPEN)
                    else:
                        result = _install_core(archive_fd, dest_fd, expected, initial)
    except BaseException:
        result = PaarInstallErr(ok=False, error=InstallErrorCode.INTERNAL_ERROR)
    close_certain = True
    if dest_fd >= 0 and not _close(dest_fd):
        close_certain = False
    if archive_fd >= 0 and not _close(archive_fd):
        close_certain = False
    return result if close_certain else PaarInstallErr(ok=False, error=InstallErrorCode.CLEANUP_UNCERTAIN)


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if len(arguments) != 11:
        print(InstallErrorCode.INPUT_INVALID.value, flush=True)
        return 1
    archive_path, destination_path, size, archive_hash, build_id, source, target, name, version, daemon, schema = arguments
    try:
        integer_size = int(size)
        integer_version = int(version)
        integer_daemon = int(daemon)
        integer_schema = int(schema)
    except ValueError:
        print(InstallErrorCode.INPUT_INVALID.value, flush=True)
        return 1
    result = install_paar(
        archive_path,
        destination_path,
        expected_archive_size=integer_size,
        expected_archive_sha256=archive_hash,
        expected_build_id=build_id,
        expected_source_commit=source,
        expected_target=target,
        expected_protocol_name=name,
        expected_protocol_version=integer_version,
        expected_daemon_protocol_version=integer_daemon,
        expected_daemon_schema_revision=integer_schema,
    )
    if result.ok:
        print(result.value, flush=True)
        return 0
    print(result.error.value, flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
