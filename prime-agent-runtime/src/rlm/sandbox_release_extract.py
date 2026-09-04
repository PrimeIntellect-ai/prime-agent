"""Phase 2: fd-relative extraction of a verified official release.

The archive parser remains single-source in ``sandbox_release_archive``.  This
module supplies a synchronous sink that writes only beneath a freshly claimed,
caller-owned directory.  Python 3.11 has fd-relative ``os.open``/``os.mkdir``
operations but no ``os.openat``/``os.mkdirat`` names.

Residual: a hostile process with the same uid can race names inside a directory
that it can write.  Production must keep the supplied parent directory private
and exact mode 0700 for the complete invocation.
"""

from __future__ import annotations

import dataclasses
import enum
import hashlib
import os
import re
import stat
from collections.abc import Callable
from typing import Final

from .sandbox_release_archive import (
    ArchiveErrorCode,
    ArchiveIdentity,
    Manifest,
    ManifestEntry,
    VerifyArchiveFailure,
    _fstat_unchanged,
    _fstat_validate,
    _parent_path,
    _TarSink,
    _validate_identity,
    _validate_manifest,
    _verify_streaming,
    verify_archive,
)

_CANDIDATE_RE: Final = re.compile(r"^[a-z][a-z0-9-]{15,63}$")
_REQUIRED_FILES: Final[dict[str, int]] = {
    "prime-agent": 0o755,
    "package.json": 0o644,
    "install.sh": 0o755,
    "photon_rs_bg.wasm": 0o644,
    "prime-agent-runtime/pyproject.toml": 0o644,
}
_REQUIRED_SKILLS: Final[tuple[str, ...]] = (
    "agent-message",
    "agent-observe",
    "compact",
    "goal",
    "refine",
    "rlm-heartbeat",
)
_ELF_PREFIX_BYTES: Final[int] = 64
_ROOT_CAPABILITY_TOKEN: Final[object] = object()


class ExtractErrorCode(enum.StrEnum):
    BAD_PARENT_FD = "bad_parent_fd"
    PARENT_STAT_FAILED = "parent_stat_failed"
    PARENT_NOT_DIRECTORY = "parent_not_directory"
    PARENT_NOT_OWNER = "parent_not_owner"
    PARENT_BAD_MODE = "parent_bad_mode"
    PARENT_CHANGED = "parent_changed"
    BAD_CANDIDATE = "bad_candidate"
    REQUIRED_ENTRY_MISSING = "required_entry_missing"
    REQUIRED_ENTRY_INVALID = "required_entry_invalid"
    CANDIDATE_EXISTS = "candidate_exists"
    ENTRY_EXISTS = "entry_exists"
    DIRECTORY_CREATE_FAILED = "directory_create_failed"
    DIRECTORY_OPEN_FAILED = "directory_open_failed"
    DIRECTORY_IDENTITY_CHANGED = "directory_identity_changed"
    FILE_CREATE_FAILED = "file_create_failed"
    FILE_WRITE_FAILED = "file_write_failed"
    FILE_IDENTITY_CHANGED = "file_identity_changed"
    FILE_CLOSE_FAILED = "file_close_failed"
    MODE_APPLY_FAILED = "mode_apply_failed"
    SYNC_FAILED = "sync_failed"
    ELF_INVALID = "elf_invalid"
    CLEANUP_UNCERTAIN = "cleanup_uncertain"
    INTERNAL_ERROR = "internal_error"


@dataclasses.dataclass(frozen=True)
class ExtractArchiveFailure:
    code: ArchiveErrorCode | ExtractErrorCode

    def __post_init__(self) -> None:
        if type(self.code) not in (ArchiveErrorCode, ExtractErrorCode):
            raise ValueError("invalid extraction error code")


class RuntimeRootCapability:
    """Nominal root authority.  It never reveals the fd or path."""

    __slots__ = ("__close", "__verify")

    def __init__(
        self,
        token: object,
        verify: Callable[[], bool],
        close: Callable[[], bool],
    ) -> None:
        if token is not _ROOT_CAPABILITY_TOKEN or not callable(verify) or not callable(close):
            raise ValueError("invalid runtime root capability")
        self.__verify = verify
        self.__close = close

    def verify(self) -> bool:
        return self.__verify()

    def close(self) -> bool:
        return self.__close()


@dataclasses.dataclass(frozen=True)
class ExtractArchiveSuccess:
    root: RuntimeRootCapability

    def __post_init__(self) -> None:
        if type(self.root) is not RuntimeRootCapability:
            raise ValueError("invalid runtime root capability")


ExtractResult = ExtractArchiveSuccess | ExtractArchiveFailure


@dataclasses.dataclass(frozen=True)
class _DirIdentity:
    dev: int
    ino: int
    uid: int


@dataclasses.dataclass
class _DirRecord:
    path: str
    parent_path: str | None
    name: str
    fd: int
    identity: _DirIdentity
    mode: int
    nlink: int | None


@dataclasses.dataclass
class _FileRecord:
    path: str
    parent_path: str
    name: str
    fd: int
    identity: _DirIdentity
    expected_mode: int
    expected_size: int
    expected_sha256: str
    offset: int
    hasher: object
    elf_prefix: bytearray


class _ExtractAbort(Exception):
    __slots__ = ("code",)

    def __init__(self, code: ExtractErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


def _mode_exact(mode: int, expected: int) -> bool:
    return stat.S_IMODE(mode) == expected and (mode & 0o7000) == 0


def _stat_identity(value: os.stat_result) -> _DirIdentity | None:
    try:
        if type(value.st_dev) is not int or type(value.st_ino) is not int or type(value.st_uid) is not int:
            return None
        if value.st_dev < 0 or value.st_ino <= 0 or value.st_uid < 0:
            return None
        return _DirIdentity(value.st_dev, value.st_ino, value.st_uid)
    except Exception:
        return None


def _same_identity(left: _DirIdentity, right: _DirIdentity) -> bool:
    return left.dev == right.dev and left.ino == right.ino and left.uid == right.uid


def _current_uid() -> int | None:
    try:
        uid = os.getuid()
    except Exception:
        return None
    if type(uid) is not int or uid < 0:
        return None
    return uid


def _safe_close(fd: int) -> bool:
    try:
        os.close(fd)
        return True
    except Exception:
        return False


def _validate_parent(fd: int) -> tuple[_DirIdentity | None, ExtractErrorCode | None]:
    if type(fd) is not int or fd < 0:
        return None, ExtractErrorCode.BAD_PARENT_FD
    try:
        value = os.fstat(fd)
    except Exception:
        return None, ExtractErrorCode.PARENT_STAT_FAILED
    identity = _stat_identity(value)
    if identity is None:
        return None, ExtractErrorCode.PARENT_STAT_FAILED
    if not stat.S_ISDIR(value.st_mode):
        return None, ExtractErrorCode.PARENT_NOT_DIRECTORY
    uid = _current_uid()
    if uid is None:
        return None, ExtractErrorCode.PARENT_STAT_FAILED
    if identity.uid != uid:
        return None, ExtractErrorCode.PARENT_NOT_OWNER
    if not _mode_exact(value.st_mode, 0o700):
        return None, ExtractErrorCode.PARENT_BAD_MODE
    return identity, None


def _parent_unchanged(fd: int, expected: _DirIdentity) -> ExtractErrorCode | None:
    current, error = _validate_parent(fd)
    if error is not None:
        return ExtractErrorCode.PARENT_CHANGED
    if current is None or not _same_identity(current, expected):
        return ExtractErrorCode.PARENT_CHANGED
    return None


def _validate_required_manifest(manifest: Manifest) -> ExtractErrorCode | None:
    by_path = {entry.path: entry for entry in manifest.entries}
    for path, mode in _REQUIRED_FILES.items():
        entry = by_path.get(path)
        if entry is None:
            return ExtractErrorCode.REQUIRED_ENTRY_MISSING
        if (
            entry.type != "file"
            or entry.mode != f"0{mode:o}"
            or entry.sha256 is None
            or entry.size == 0
        ):
            return ExtractErrorCode.REQUIRED_ENTRY_INVALID
        if path == "prime-agent" and entry.size < _ELF_PREFIX_BYTES:
            return ExtractErrorCode.REQUIRED_ENTRY_INVALID
    skills = by_path.get("skills")
    if skills is None or skills.type != "directory" or skills.mode != "0755":
        return ExtractErrorCode.REQUIRED_ENTRY_MISSING
    for name in _REQUIRED_SKILLS:
        directory = by_path.get(f"skills/{name}")
        skill = by_path.get(f"skills/{name}/SKILL.md")
        if directory is None or directory.type != "directory" or directory.mode != "0755":
            return ExtractErrorCode.REQUIRED_ENTRY_MISSING
        if skill is None or skill.type != "file" or skill.mode != "0644" or skill.sha256 is None or skill.size == 0:
            return ExtractErrorCode.REQUIRED_ENTRY_INVALID
    return None


def _verify_elf(prefix: bytearray) -> bool:
    if len(prefix) < _ELF_PREFIX_BYTES:
        return False
    if bytes(prefix[0:4]) != b"\x7fELF":
        return False
    if prefix[4] != 2 or prefix[5] != 1 or prefix[6] != 1:
        return False
    if prefix[7] not in (0, 3):
        return False
    if int.from_bytes(prefix[16:18], "little") not in (2, 3):
        return False
    if int.from_bytes(prefix[18:20], "little") != 62:
        return False
    if int.from_bytes(prefix[20:24], "little") != 1:
        return False
    return True


class _ExtractionSink(_TarSink):
    def __init__(
        self,
        parent_fd: int,
        parent_identity: _DirIdentity,
        candidate: str,
        root_fd: int,
        root_identity: _DirIdentity,
    ) -> None:
        self.parent_fd = parent_fd
        self.parent_identity = parent_identity
        self.candidate = candidate
        self.directories: dict[str, _DirRecord] = {
            ".": _DirRecord(".", None, candidate, root_fd, root_identity, 0o700, None)
        }
        self.files: list[_FileRecord] = []
        self.current: _FileRecord | None = None
        self.tree_synced = False
        self.finalized = False
        self.compressed_hasher = hashlib.sha256()

    def compressed_data(self, chunk: memoryview) -> ArchiveErrorCode | None:
        self.compressed_hasher.update(chunk)
        return None

    def compressed_matches(self, expected: str) -> bool:
        return self.compressed_hasher.hexdigest() == expected

    def _abort(self, code: ExtractErrorCode) -> None:
        raise _ExtractAbort(code)

    def _directory_stable(
        self,
        record: _DirRecord,
        expected_mode: int,
        *,
        freeze_nlink: bool = False,
        refresh_nlink: bool = False,
    ) -> bool:
        try:
            by_fd = os.fstat(record.fd)
            fd_identity = _stat_identity(by_fd)
            if fd_identity is None or not _same_identity(fd_identity, record.identity):
                return False
            if not stat.S_ISDIR(by_fd.st_mode) or by_fd.st_uid != _current_uid():
                return False
            if not _mode_exact(by_fd.st_mode, expected_mode):
                return False
            if record.parent_path is None:
                parent_fd = self.parent_fd
            else:
                parent = self.directories.get(record.parent_path)
                if parent is None:
                    return False
                parent_fd = parent.fd
            by_name = os.stat(record.name, dir_fd=parent_fd, follow_symlinks=False)
            named_identity = _stat_identity(by_name)
            stable = (
                named_identity is not None
                and _same_identity(named_identity, record.identity)
                and stat.S_ISDIR(by_name.st_mode)
                and _mode_exact(by_name.st_mode, expected_mode)
                and type(by_fd.st_nlink) is int
                and type(by_name.st_nlink) is int
                and by_fd.st_nlink >= 2
                and by_fd.st_nlink == by_name.st_nlink
                and (
                    refresh_nlink
                    or record.nlink is None
                    or by_fd.st_nlink == record.nlink
                )
            )
            if stable and (freeze_nlink or refresh_nlink):
                record.nlink = by_fd.st_nlink
            return stable
        except Exception:
            return False

    def _file_stable(self, record: _FileRecord, expected_mode: int) -> bool:
        parent = self.directories.get(record.parent_path)
        if parent is None:
            return False
        try:
            by_fd = os.fstat(record.fd)
            fd_identity = _stat_identity(by_fd)
            by_name = os.stat(record.name, dir_fd=parent.fd, follow_symlinks=False)
            named_identity = _stat_identity(by_name)
            return (
                fd_identity is not None
                and named_identity is not None
                and _same_identity(fd_identity, record.identity)
                and _same_identity(named_identity, record.identity)
                and stat.S_ISREG(by_fd.st_mode)
                and stat.S_ISREG(by_name.st_mode)
                and by_fd.st_uid == _current_uid()
                and by_name.st_uid == _current_uid()
                and by_fd.st_nlink == 1
                and by_name.st_nlink == 1
                and by_fd.st_size == record.expected_size
                and by_name.st_size == record.expected_size
                and _mode_exact(by_fd.st_mode, expected_mode)
                and _mode_exact(by_name.st_mode, expected_mode)
            )
        except Exception:
            return False

    def directory(self, path: str, mode: int, entry: ManifestEntry) -> ArchiveErrorCode | None:
        if path == ".":
            root = self.directories["."]
            if not self._directory_stable(root, 0o700):
                self._abort(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED)
            return None
        parent_path = _parent_path(path)
        if parent_path is None:
            self._abort(ExtractErrorCode.INTERNAL_ERROR)
        parent = self.directories.get(parent_path)
        if parent is None:
            self._abort(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED)
        name = path.rsplit("/", 1)[-1]
        try:
            os.mkdir(name, 0o700, dir_fd=parent.fd)
        except FileExistsError:
            self._abort(ExtractErrorCode.ENTRY_EXISTS)
        except Exception:
            self._abort(ExtractErrorCode.DIRECTORY_CREATE_FAILED)
        try:
            child_fd = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=parent.fd,
            )
        except Exception:
            self._abort(ExtractErrorCode.DIRECTORY_OPEN_FAILED)
        try:
            value = os.fstat(child_fd)
            named = os.stat(name, dir_fd=parent.fd, follow_symlinks=False)
            identity = _stat_identity(value)
            named_identity = _stat_identity(named)
            if (
                identity is None
                or named_identity is None
                or not _same_identity(identity, named_identity)
                or not stat.S_ISDIR(value.st_mode)
                or not _mode_exact(value.st_mode, 0o700)
                or value.st_uid != _current_uid()
            ):
                self._abort(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED)
            self.directories[path] = _DirRecord(path, parent_path, name, child_fd, identity, 0o700, None)
        except _ExtractAbort:
            _safe_close(child_fd)
            raise
        except Exception:
            _safe_close(child_fd)
            self._abort(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED)
        return None

    def begin_file(
        self, path: str, mode: int, size: int, entry: ManifestEntry
    ) -> ArchiveErrorCode | None:
        if self.current is not None:
            self._abort(ExtractErrorCode.INTERNAL_ERROR)
        parent_path = _parent_path(path)
        if parent_path is None:
            self._abort(ExtractErrorCode.INTERNAL_ERROR)
        parent = self.directories.get(parent_path)
        if parent is None:
            self._abort(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED)
        name = path.rsplit("/", 1)[-1]
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
        try:
            file_fd = os.open(name, flags, 0o600, dir_fd=parent.fd)
        except FileExistsError:
            self._abort(ExtractErrorCode.ENTRY_EXISTS)
        except Exception:
            self._abort(ExtractErrorCode.FILE_CREATE_FAILED)
        try:
            value = os.fstat(file_fd)
            named = os.stat(name, dir_fd=parent.fd, follow_symlinks=False)
            identity = _stat_identity(value)
            named_identity = _stat_identity(named)
            expected_sha = entry.sha256
            if (
                identity is None
                or named_identity is None
                or not _same_identity(identity, named_identity)
                or expected_sha is None
                or not stat.S_ISREG(value.st_mode)
                or value.st_uid != _current_uid()
                or value.st_nlink != 1
                or value.st_size != 0
                or not _mode_exact(value.st_mode, 0o600)
            ):
                self._abort(ExtractErrorCode.FILE_IDENTITY_CHANGED)
            record = _FileRecord(
                path,
                parent_path,
                name,
                file_fd,
                identity,
                mode,
                size,
                expected_sha,
                0,
                hashlib.sha256(),
                bytearray(),
            )
            self.files.append(record)
            self.current = record
        except _ExtractAbort:
            _safe_close(file_fd)
            raise
        except Exception:
            _safe_close(file_fd)
            self._abort(ExtractErrorCode.FILE_IDENTITY_CHANGED)
        return None

    def write_file(self, chunk: memoryview) -> ArchiveErrorCode | None:
        record = self.current
        if record is None:
            self._abort(ExtractErrorCode.INTERNAL_ERROR)
        position = 0
        while position < len(chunk):
            try:
                written = os.pwrite(record.fd, chunk[position:], record.offset)
            except Exception:
                self._abort(ExtractErrorCode.FILE_WRITE_FAILED)
            if type(written) is not int or written <= 0 or written > len(chunk) - position:
                self._abort(ExtractErrorCode.FILE_WRITE_FAILED)
            piece = chunk[position:position + written]
            try:
                record.hasher.update(piece)
                if record.path == "prime-agent" and len(record.elf_prefix) < _ELF_PREFIX_BYTES:
                    wanted = min(_ELF_PREFIX_BYTES - len(record.elf_prefix), len(piece))
                    record.elf_prefix.extend(piece[:wanted])
            finally:
                piece.release()
            record.offset += written
            position += written
        if record.offset > record.expected_size:
            self._abort(ExtractErrorCode.FILE_WRITE_FAILED)
        return None

    def finish_file(self) -> ArchiveErrorCode | None:
        record = self.current
        if record is None:
            self._abort(ExtractErrorCode.INTERNAL_ERROR)
        if record.offset != record.expected_size or record.hasher.hexdigest() != record.expected_sha256:
            self._abort(ExtractErrorCode.FILE_IDENTITY_CHANGED)
        if record.path == "prime-agent" and not _verify_elf(record.elf_prefix):
            self._abort(ExtractErrorCode.ELF_INVALID)
        try:
            os.fchmod(record.fd, record.expected_mode)
        except Exception:
            self._abort(ExtractErrorCode.MODE_APPLY_FAILED)
        try:
            os.fsync(record.fd)
        except Exception:
            self._abort(ExtractErrorCode.SYNC_FAILED)
        if not self._file_stable(record, record.expected_mode):
            self._abort(ExtractErrorCode.FILE_IDENTITY_CHANGED)
        for index in range(len(record.elf_prefix)):
            record.elf_prefix[index] = 0
        if not _safe_close(record.fd):
            self._abort(ExtractErrorCode.FILE_CLOSE_FAILED)
        record.fd = -1
        self.current = None
        return None

    def finish_archive(self) -> ArchiveErrorCode | None:
        if self.current is not None:
            self._abort(ExtractErrorCode.INTERNAL_ERROR)
        ordered = sorted(
            (record for path, record in self.directories.items() if path != "."),
            key=lambda record: record.path.count("/"),
            reverse=True,
        )
        for record in ordered:
            try:
                os.fchmod(record.fd, 0o755)
                record.mode = 0o755
            except Exception:
                self._abort(ExtractErrorCode.MODE_APPLY_FAILED)
            try:
                os.fsync(record.fd)
            except Exception:
                self._abort(ExtractErrorCode.SYNC_FAILED)
            if not self._directory_stable(record, 0o755, freeze_nlink=True):
                self._abort(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED)
        root = self.directories["."]
        try:
            os.fchmod(root.fd, 0o700)
            os.fsync(root.fd)
            os.fsync(self.parent_fd)
        except Exception:
            self._abort(ExtractErrorCode.SYNC_FAILED)
        if not self._directory_stable(root, 0o700, freeze_nlink=True):
            self._abort(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED)
        if _parent_unchanged(self.parent_fd, self.parent_identity) is not None:
            self._abort(ExtractErrorCode.PARENT_CHANGED)
        self.tree_synced = True
        return None

    def seal_success(self) -> None:
        if not self.tree_synced or self.current is not None:
            self._abort(ExtractErrorCode.INTERNAL_ERROR)
        ordered = sorted(
            (record for path, record in self.directories.items() if path != "."),
            key=lambda record: record.path.count("/"),
            reverse=True,
        )
        for record in ordered:
            if not self._directory_stable(record, 0o755):
                self._abort(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED)
        root = self.directories["."]
        if not self._directory_stable(root, 0o700):
            self._abort(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED)
        if _parent_unchanged(self.parent_fd, self.parent_identity) is not None:
            self._abort(ExtractErrorCode.PARENT_CHANGED)
        self.finalized = True

    def cleanup(self) -> bool:
        ok = True
        current = self.current
        if current is not None and current.fd >= 0:
            if not _safe_close(current.fd):
                ok = False
            current.fd = -1
        self.current = None
        for record in self.files:
            for index in range(len(record.elf_prefix)):
                record.elf_prefix[index] = 0
            if record.fd >= 0:
                if not _safe_close(record.fd):
                    ok = False
                record.fd = -1
        if not ok:
            return False
        for record in self.directories.values():
            if record.fd >= 0:
                if not self._directory_stable(record, record.mode):
                    return False
                try:
                    os.fchmod(record.fd, 0o700)
                    record.mode = 0o700
                except Exception:
                    return False
                if not self._directory_stable(record, 0o700):
                    return False
        for record in reversed(self.files):
            parent = self.directories.get(record.parent_path)
            if parent is None:
                return False
            try:
                value = os.stat(record.name, dir_fd=parent.fd, follow_symlinks=False)
                identity = _stat_identity(value)
                if (
                    identity is None
                    or not _same_identity(identity, record.identity)
                    or not stat.S_ISREG(value.st_mode)
                    or value.st_nlink != 1
                    or value.st_uid != _current_uid()
                    or not self._directory_stable(parent, 0o700)
                ):
                    return False
                os.unlink(record.name, dir_fd=parent.fd)
                if not self._directory_stable(
                    parent, 0o700, refresh_nlink=True
                ):
                    return False
            except Exception:
                return False
        ordered = sorted(
            (record for path, record in self.directories.items() if path != "."),
            key=lambda record: record.path.count("/"),
            reverse=True,
        )
        for record in ordered:
            parent = self.directories.get(record.parent_path or "")
            if parent is None or not self._directory_stable(record, 0o700):
                return False
            if not _safe_close(record.fd):
                return False
            record.fd = -1
            try:
                named = os.stat(record.name, dir_fd=parent.fd, follow_symlinks=False)
                named_identity = _stat_identity(named)
                if (
                    named_identity is None
                    or not _same_identity(named_identity, record.identity)
                    or not stat.S_ISDIR(named.st_mode)
                    or not _mode_exact(named.st_mode, 0o700)
                ):
                    return False
                os.rmdir(record.name, dir_fd=parent.fd)
                if not self._directory_stable(
                    parent, 0o700, refresh_nlink=True
                ):
                    return False
            except Exception:
                return False
        root = self.directories["."]
        if not self._directory_stable(root, 0o700):
            return False
        if _parent_unchanged(self.parent_fd, self.parent_identity) is not None:
            return False
        if not _safe_close(root.fd):
            return False
        root.fd = -1
        try:
            named = os.stat(self.candidate, dir_fd=self.parent_fd, follow_symlinks=False)
            named_identity = _stat_identity(named)
            if (
                named_identity is None
                or not _same_identity(named_identity, root.identity)
                or not stat.S_ISDIR(named.st_mode)
                or not _mode_exact(named.st_mode, 0o700)
            ):
                return False
            os.rmdir(self.candidate, dir_fd=self.parent_fd)
            os.fsync(self.parent_fd)
        except Exception:
            return False
        return _parent_unchanged(self.parent_fd, self.parent_identity) is None

    def make_capability(self) -> RuntimeRootCapability:
        if not self.finalized:
            self._abort(ExtractErrorCode.INTERNAL_ERROR)
        records = tuple(self.directories.values())
        state = {"closed": False}

        def verify() -> bool:
            if state["closed"]:
                return False
            for record in records:
                try:
                    value = os.fstat(record.fd)
                    current = _stat_identity(value)
                    if (
                        current is None
                        or not _same_identity(current, record.identity)
                        or not stat.S_ISDIR(value.st_mode)
                        or value.st_uid != _current_uid()
                        or type(value.st_nlink) is not int
                        or record.nlink is None
                        or value.st_nlink != record.nlink
                        or not _mode_exact(value.st_mode, record.mode)
                    ):
                        return False
                except Exception:
                    return False
            return True

        def close() -> bool:
            if state["closed"]:
                return True
            ok = True
            for record in records:
                if record.fd >= 0:
                    if _safe_close(record.fd):
                        record.fd = -1
                    else:
                        ok = False
            state["closed"] = ok
            return ok

        return RuntimeRootCapability(_ROOT_CAPABILITY_TOKEN, verify, close)


def _cleanup_safely(sink: _ExtractionSink) -> bool:
    try:
        return sink.cleanup()
    except Exception:
        return False


def _remove_named_empty_claim(
    parent_fd: int, candidate: str, identity: _DirIdentity
) -> bool:
    try:
        named = os.stat(candidate, dir_fd=parent_fd, follow_symlinks=False)
        named_identity = _stat_identity(named)
        if (
            named_identity is None
            or not _same_identity(named_identity, identity)
            or not stat.S_ISDIR(named.st_mode)
            or named.st_uid != _current_uid()
            or not _mode_exact(named.st_mode, 0o700)
        ):
            return False
        os.rmdir(candidate, dir_fd=parent_fd)
        os.fsync(parent_fd)
        return True
    except Exception:
        return False


def _remove_empty_claim(
    parent_fd: int,
    candidate: str,
    root_fd: int,
    identity: _DirIdentity,
    claimed_identity: _DirIdentity,
) -> bool:
    try:
        by_fd = os.fstat(root_fd)
        by_name = os.stat(candidate, dir_fd=parent_fd, follow_symlinks=False)
        fd_identity = _stat_identity(by_fd)
        named_identity = _stat_identity(by_name)
        if (
            fd_identity is None
            or named_identity is None
            or not _same_identity(fd_identity, identity)
            or not _same_identity(named_identity, identity)
            or not _same_identity(identity, claimed_identity)
            or not stat.S_ISDIR(by_fd.st_mode)
        ):
            return False
        if not _safe_close(root_fd):
            return False
        named_after_close = os.stat(candidate, dir_fd=parent_fd, follow_symlinks=False)
        after_identity = _stat_identity(named_after_close)
        if (
            after_identity is None
            or not _same_identity(after_identity, identity)
            or not stat.S_ISDIR(named_after_close.st_mode)
        ):
            return False
        os.rmdir(candidate, dir_fd=parent_fd)
        os.fsync(parent_fd)
    except Exception:
        return False
    return True


def extract_verified_archive(
    archive_fd: int,
    parent_fd: int,
    candidate_name: str,
    identity: ArchiveIdentity,
    manifest: Manifest,
) -> ExtractResult:
    """Verify, claim, and extract without ever returning a path or raw fd."""
    identity_error = _validate_identity(identity)
    if identity_error is not None:
        return ExtractArchiveFailure(identity_error)
    manifest_error = _validate_manifest(manifest, identity)
    if manifest_error is not None:
        return ExtractArchiveFailure(manifest_error)
    if type(candidate_name) is not str or _CANDIDATE_RE.fullmatch(candidate_name) is None:
        return ExtractArchiveFailure(ExtractErrorCode.BAD_CANDIDATE)
    required_error = _validate_required_manifest(manifest)
    if required_error is not None:
        return ExtractArchiveFailure(required_error)
    if type(archive_fd) is not int or archive_fd < 0:
        return ExtractArchiveFailure(ArchiveErrorCode.BAD_FD_FIELD)
    parent_identity, parent_error = _validate_parent(parent_fd)
    if parent_error is not None:
        return ExtractArchiveFailure(parent_error)
    if parent_identity is None:
        return ExtractArchiveFailure(ExtractErrorCode.PARENT_STAT_FAILED)

    verified = verify_archive(archive_fd, identity, manifest)
    if type(verified) is VerifyArchiveFailure:
        return ExtractArchiveFailure(verified.code)
    if _parent_unchanged(parent_fd, parent_identity) is not None:
        return ExtractArchiveFailure(ExtractErrorCode.PARENT_CHANGED)
    archive_snap, archive_error = _fstat_validate(archive_fd, identity.compressed_bytes)
    if archive_error is not None or archive_snap is None:
        return ExtractArchiveFailure(archive_error or ArchiveErrorCode.FD_STAT_FAILED)

    try:
        os.mkdir(candidate_name, 0o700, dir_fd=parent_fd)
    except FileExistsError:
        return ExtractArchiveFailure(ExtractErrorCode.CANDIDATE_EXISTS)
    except Exception:
        return ExtractArchiveFailure(ExtractErrorCode.DIRECTORY_CREATE_FAILED)
    try:
        claimed_value = os.stat(candidate_name, dir_fd=parent_fd, follow_symlinks=False)
        claimed_identity = _stat_identity(claimed_value)
        if (
            claimed_identity is None
            or not stat.S_ISDIR(claimed_value.st_mode)
            or claimed_value.st_uid != _current_uid()
            or not _mode_exact(claimed_value.st_mode, 0o700)
        ):
            return ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN)
    except Exception:
        return ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN)
    try:
        root_fd = os.open(
            candidate_name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=parent_fd,
        )
    except Exception:
        if not _remove_named_empty_claim(parent_fd, candidate_name, claimed_identity):
            return ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN)
        return ExtractArchiveFailure(ExtractErrorCode.DIRECTORY_OPEN_FAILED)
    try:
        root_value = os.fstat(root_fd)
        root_named = os.stat(candidate_name, dir_fd=parent_fd, follow_symlinks=False)
        root_identity = _stat_identity(root_value)
        root_named_identity = _stat_identity(root_named)
        if (
            root_identity is None
            or root_named_identity is None
            or not _same_identity(root_identity, root_named_identity)
            or not _same_identity(root_identity, claimed_identity)
            or not stat.S_ISDIR(root_value.st_mode)
            or root_value.st_uid != _current_uid()
            or not _mode_exact(root_value.st_mode, 0o700)
        ):
            if root_identity is None or not _remove_empty_claim(
                parent_fd, candidate_name, root_fd, root_identity, claimed_identity
            ):
                return ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN)
            return ExtractArchiveFailure(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED)
    except Exception:
        _safe_close(root_fd)
        return ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN)

    sink = _ExtractionSink(parent_fd, parent_identity, candidate_name, root_fd, root_identity)
    failure: ArchiveErrorCode | ExtractErrorCode | None = None
    try:
        stream_error = _verify_streaming(archive_fd, identity.compressed_bytes, manifest, sink)
        if stream_error is not None:
            failure = stream_error
        elif not sink.compressed_matches(identity.compressed_sha256):
            failure = ArchiveErrorCode.DIGEST_MISMATCH
        else:
            stable_error = _fstat_unchanged(archive_fd, archive_snap)
            if stable_error is not None:
                failure = stable_error
            elif _parent_unchanged(parent_fd, parent_identity) is not None:
                failure = ExtractErrorCode.PARENT_CHANGED
            else:
                sink.seal_success()
    except _ExtractAbort as error:
        failure = error.code
    except Exception:
        failure = ExtractErrorCode.INTERNAL_ERROR

    if failure is not None:
        if not _cleanup_safely(sink):
            return ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN)
        return ExtractArchiveFailure(failure)
    if not sink.finalized:
        if not _cleanup_safely(sink):
            return ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN)
        return ExtractArchiveFailure(ExtractErrorCode.INTERNAL_ERROR)
    try:
        capability = sink.make_capability()
    except Exception:
        if not _cleanup_safely(sink):
            return ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN)
        return ExtractArchiveFailure(ExtractErrorCode.INTERNAL_ERROR)
    return ExtractArchiveSuccess(capability)
