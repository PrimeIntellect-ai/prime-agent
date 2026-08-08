#!/usr/bin/env python3
"""Create, verify, and safely restore Prime Harness state backups.

The archive is self-describing and content-addressed.  It contains the current
RLM session directory, project ``artifacts/harness`` (excluding backups), and
the global harness directory.  SQLite databases are copied with SQLite's
online backup API rather than as potentially torn files.

Usage:
  python -S harness/backup.py create [--session-dir PATH] [--output PATH]
  python -S harness/backup.py verify ARCHIVE
  python -S harness/backup.py restore ARCHIVE --destination ABSENT_PATH
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterator

FORMAT = "prime-harness-backup"
FORMAT_VERSION = 1
MANIFEST_NAME = "MANIFEST.json"
BUFFER_SIZE = 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_MEMBER_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_MEMBER_BYTES = 16 * 1024 * 1024 * 1024
MAX_MTIME_NS = 4_102_444_800 * 1_000_000_000  # 2100-01-01 UTC
ROOT_PREFIXES = {
    "session": "session",
    "project": "project/artifacts/harness",
    "global": "global/harness",
}


class BackupError(RuntimeError):
    """Raised for invalid input, unsafe archives, or integrity failures."""


def _canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def _sha256_stream(handle: BinaryIO, destination: BinaryIO | None = None) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = handle.read(BUFFER_SIZE)
        if not chunk:
            break
        size += len(chunk)
        digest.update(chunk)
        if destination is not None:
            destination.write(chunk)
    return digest.hexdigest(), size


def _strict_json(raw: bytes) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise BackupError(f"duplicate JSON key in manifest: {key}")
            result[key] = value
        return result

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=lambda value: (_ for _ in ()).throw(BackupError(f"non-finite JSON value: {value}")))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BackupError("manifest is not strict UTF-8 JSON") from exc


WINDOWS_FORBIDDEN_CHARS = frozenset('<>:"|?*')
WINDOWS_DEVICE_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"}
    | {f"COM{suffix}" for suffix in (*range(1, 10), "¹", "²", "³")}
    | {f"LPT{suffix}" for suffix in (*range(1, 10), "¹", "²", "³")}
)


def _safe_windows_component(component: str) -> None:
    if component.endswith((" ", ".")):
        raise BackupError(f"Windows-ambiguous archive component: {component!r}")
    if any(ord(character) < 32 or character in WINDOWS_FORBIDDEN_CHARS for character in component):
        raise BackupError(f"Windows-unsafe archive component: {component!r}")
    device_stem = component.split(".", 1)[0].rstrip(" .").upper()
    if device_stem in WINDOWS_DEVICE_NAMES:
        raise BackupError(f"Windows reserved-device archive component: {component!r}")


def _safe_archive_path(value: Any, *, directory: bool = False) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
        raise BackupError(f"unsafe archive path: {value!r}")
    if unicodedata.normalize("NFC", value) != value:
        raise BackupError(f"archive path is not NFC-normalized: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise BackupError(f"unsafe archive path: {value!r}")
    for component in path.parts:
        _safe_windows_component(component)
    canonical = path.as_posix()
    if canonical != value:
        raise BackupError(f"non-canonical archive path: {value!r}")
    if canonical == MANIFEST_NAME:
        raise BackupError("manifest cannot list itself")
    if not any(canonical == prefix or canonical.startswith(prefix + "/") for prefix in ROOT_PREFIXES.values()):
        raise BackupError(f"archive path has unknown root: {canonical}")
    if not directory and canonical in ROOT_PREFIXES.values():
        raise BackupError(f"root path cannot be a file: {canonical}")
    return canonical


def _safe_mode(value: Any, path: str) -> int:
    if type(value) is not int or not 0 <= value <= 0o777:
        raise BackupError(f"privileged or invalid mode bits for {path}: {value!r}")
    return value


def _portable_path_key(path: str) -> str:
    return "/".join(component.casefold() for component in PurePosixPath(path).parts)


def _lstat_kind(path: Path) -> str:
    try:
        stat_result = path.lstat()
    except OSError as exc:
        raise BackupError(f"cannot inspect source path: {path}") from exc
    mode = stat_result.st_mode
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if stat.S_ISLNK(mode):
        return "symlink"
    if getattr(stat_result, "st_file_attributes", 0) & reparse_flag:
        return "reparse"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISREG(mode):
        return "file"
    return "special"


def _file_identity(stat_result: os.stat_result) -> tuple[int, ...]:
    if stat_result.st_ino:
        return (stat_result.st_dev, stat_result.st_ino)
    return (stat_result.st_dev, stat_result.st_ctime_ns, stat_result.st_size)


def _regular_source_stat(path: Path) -> os.stat_result:
    if _lstat_kind(path) != "file":
        raise BackupError(f"source changed into a link or non-file: {path}")
    return path.lstat()


def _assert_source_identity(path: Path, expected: os.stat_result) -> None:
    current = _regular_source_stat(path)
    if _file_identity(current) != _file_identity(expected):
        raise BackupError(f"source identity changed during backup: {path}")


def _open_verified_source(path: Path, expected: os.stat_result) -> BinaryIO:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise BackupError(f"cannot safely open source file: {path}") from exc
    try:
        opened = os.fstat(descriptor)
        _assert_source_identity(path, expected)
        if not stat.S_ISREG(opened.st_mode) or _file_identity(opened) != _file_identity(expected):
            raise BackupError(f"source identity changed during backup: {path}")
        return os.fdopen(descriptor, "rb", closefd=True)
    except Exception:
        os.close(descriptor)
        raise


def _walk_source(root: Path, prefix: str, *, exclude_backups: bool) -> tuple[list[tuple[str, Path]], list[tuple[str, Path]]]:
    kind = _lstat_kind(root)
    if kind in {"symlink", "reparse"}:
        raise BackupError(f"source root must not be a symlink or reparse point: {root}")
    if kind != "directory":
        raise BackupError(f"source root is not a directory: {root}")
    directories: list[tuple[str, Path]] = [(prefix, root)]
    files: list[tuple[str, Path]] = []
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        rel_current = current_path.relative_to(root)
        kept: list[str] = []
        for name in sorted(dirnames):
            child = current_path / name
            rel = (rel_current / name) if rel_current.parts else Path(name)
            if exclude_backups and rel.parts and rel.parts[0] == "backups":
                continue
            child_kind = _lstat_kind(child)
            if child_kind in {"symlink", "reparse"}:
                raise BackupError(f"symlink sources are forbidden (including reparse points): {child}")
            if child_kind != "directory":
                raise BackupError(f"special source entry is forbidden: {child}")
            kept.append(name)
            directories.append((f"{prefix}/{rel.as_posix()}", child))
        dirnames[:] = kept
        for name in sorted(filenames):
            child = current_path / name
            if name.casefold() in {"evidence.db-wal", "evidence.db-shm", "evidence.db-journal"} and any(candidate.casefold() == "evidence.db" for candidate in filenames):
                continue
            rel = (rel_current / name) if rel_current.parts else Path(name)
            if exclude_backups and rel.parts and rel.parts[0] == "backups":
                continue
            child_kind = _lstat_kind(child)
            if child_kind in {"symlink", "reparse"}:
                raise BackupError(f"symlink sources are forbidden (including reparse points): {child}")
            if child_kind != "file":
                raise BackupError(f"special source entry is forbidden: {child}")
            files.append((f"{prefix}/{rel.as_posix()}", child))
    return sorted(directories), sorted(files)


def _zip_info(name: str, mode: int, mtime_ns: int) -> zipfile.ZipInfo:
    dt = datetime.fromtimestamp(max(mtime_ns, 315532800_000_000_000) / 1_000_000_000, timezone.utc)
    year = min(max(dt.year, 1980), 2107)
    info = zipfile.ZipInfo(name, (year, dt.month, dt.day, dt.hour, dt.minute, dt.second))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | mode) << 16
    info.flag_bits |= 0x800
    return info


def _sqlite_snapshot(source: Path, destination: Path, expected_source_stat: os.stat_result) -> None:
    uri = source.resolve().as_uri() + "?mode=ro"
    src = None
    dst = None
    try:
        src = sqlite3.connect(uri, uri=True, timeout=30)
        _assert_source_identity(source, expected_source_stat)
        dst = sqlite3.connect(destination)
        src.backup(dst)
        _assert_source_identity(source, expected_source_stat)
        row = dst.execute("PRAGMA integrity_check").fetchone()
        if row != ("ok",):
            raise BackupError(f"SQLite integrity_check failed while snapshotting {source}: {row}")
    except sqlite3.Error as exc:
        raise BackupError(f"cannot create consistent SQLite snapshot: {source}") from exc
    finally:
        if dst is not None:
            dst.close()
        if src is not None:
            src.close()


def _write_member(
    archive: zipfile.ZipFile,
    archive_path: str,
    source: Path,
    source_stat: os.stat_result,
    *,
    sqlite_snapshot: bool,
    temp_dir: Path,
) -> dict[str, Any]:
    source_mode = _safe_mode(stat.S_IMODE(source_stat.st_mode), archive_path)
    if sqlite_snapshot:
        payload = temp_dir / (hashlib.sha256(str(source).encode("utf-8")).hexdigest() + ".db")
        with _open_verified_source(source, source_stat):
            _sqlite_snapshot(source, payload, source_stat)
            _assert_source_identity(source, source_stat)
        input_handle = payload.open("rb")
    else:
        input_handle = _open_verified_source(source, source_stat)
    info = _zip_info(archive_path, source_mode, source_stat.st_mtime_ns)
    with input_handle, archive.open(info, "w") as output_handle:
        digest, size = _sha256_stream(input_handle, output_handle)
    return {
        "path": archive_path,
        "sha256": digest,
        "size": size,
        "mode": source_mode,
        "mtime_ns": source_stat.st_mtime_ns,
        "sqlite_snapshot": sqlite_snapshot,
    }


def create_backup(*, project_root: Path, session_dir: Path, global_harness: Path, output: Path | None = None, now: datetime | None = None) -> dict[str, Any]:
    project_root = project_root.expanduser().absolute()
    artifacts = project_root / "artifacts" / "harness"
    if _lstat_kind(project_root) != "directory":
        raise BackupError(f"project root is not a directory: {project_root}")
    roots: dict[str, tuple[Path, bool]] = {
        "session": (session_dir.expanduser().absolute(), False),
        "project": (artifacts.absolute(), True),
        "global": (global_harness.expanduser().absolute(), False),
    }
    if not os.path.lexists(roots["session"][0]):
        raise BackupError(f"session directory does not exist: {roots['session'][0]}")
    if not os.path.lexists(roots["project"][0]):
        raise BackupError(f"project harness artifacts do not exist: {roots['project'][0]}")
    timestamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if output is None:
        stamp = timestamp.strftime("%Y%m%dT%H%M%S.%fZ")
        output = artifacts / "backups" / f"prime-harness-{stamp}.zip"
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(output):
        raise BackupError(f"backup output already exists: {output}")

    root_manifest: dict[str, Any] = {}
    directories: list[dict[str, Any]] = []
    files: list[tuple[str, Path, str, os.stat_result]] = []
    seen_paths: dict[str, str] = {}
    total_source_bytes = 0
    for name, (root, exclude_backups) in roots.items():
        present = os.path.lexists(root)
        root_manifest[name] = {"archive_prefix": ROOT_PREFIXES[name], "present": present}
        if not present:
            if name != "global":
                raise BackupError(f"required source root does not exist: {root}")
            continue
        source_dirs, source_files = _walk_source(root, ROOT_PREFIXES[name], exclude_backups=exclude_backups)
        for archive_path, source in source_dirs:
            archive_path = _safe_archive_path(archive_path, directory=True)
            path_key = _portable_path_key(archive_path)
            if path_key in seen_paths:
                raise BackupError(f"portable path collision: {seen_paths[path_key]} and {archive_path}")
            seen_paths[path_key] = archive_path
            if _lstat_kind(source) != "directory":
                raise BackupError(f"source directory changed during backup: {source}")
            source_stat = source.lstat()
            source_mode = _safe_mode(stat.S_IMODE(source_stat.st_mode), archive_path)
            directories.append({"path": archive_path, "mode": source_mode, "mtime_ns": source_stat.st_mtime_ns})
        for archive_path, source in source_files:
            archive_path = _safe_archive_path(archive_path)
            path_key = _portable_path_key(archive_path)
            if path_key in seen_paths:
                raise BackupError(f"portable path collision: {seen_paths[path_key]} and {archive_path}")
            seen_paths[path_key] = archive_path
            source_stat = _regular_source_stat(source)
            if source_stat.st_size > MAX_MEMBER_BYTES:
                raise BackupError(f"member exceeds uncompressed size limit: {archive_path}")
            total_source_bytes += source_stat.st_size
            if total_source_bytes > MAX_TOTAL_MEMBER_BYTES:
                raise BackupError("backup exceeds total uncompressed size limit")
            files.append((archive_path, source, name, source_stat))

    temp_output = output.parent / f".{output.name}.{os.getpid()}.tmp"
    if temp_output.exists():
        temp_output.unlink()
    file_manifest: list[dict[str, Any]] = []
    try:
        with tempfile.TemporaryDirectory(prefix="prime-harness-backup-") as temp_name:
            temp_dir = Path(temp_name)
            with zipfile.ZipFile(temp_output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
                for archive_path, source, _root_name, source_stat in sorted(files):
                    sqlite_snapshot = source.name.casefold() == "evidence.db"
                    file_manifest.append(
                        _write_member(
                            archive,
                            archive_path,
                            source,
                            source_stat,
                            sqlite_snapshot=sqlite_snapshot,
                            temp_dir=temp_dir,
                        )
                    )
                manifest = {
                    "format": FORMAT,
                    "format_version": FORMAT_VERSION,
                    "created_at": timestamp.isoformat().replace("+00:00", "Z"),
                    "roots": root_manifest,
                    "directories": sorted(directories, key=lambda item: item["path"]),
                    "files": sorted(file_manifest, key=lambda item: item["path"]),
                }
                _validate_manifest(manifest)
                manifest_bytes = _canonical_json(manifest)
                manifest_info = _zip_info(MANIFEST_NAME, 0o600, int(timestamp.timestamp() * 1_000_000_000))
                archive.writestr(manifest_info, manifest_bytes)
        os.replace(temp_output, output)
    except Exception:
        temp_output.unlink(missing_ok=True)
        raise
    result = verify_backup(output)
    result.update({"archive": str(output), "created": True})
    return result


def _validate_manifest(manifest: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not isinstance(manifest, dict) or set(manifest) != {"format", "format_version", "created_at", "roots", "directories", "files"}:
        raise BackupError("manifest has an invalid top-level schema")
    if manifest["format"] != FORMAT or manifest["format_version"] != FORMAT_VERSION:
        raise BackupError("unsupported backup format or version")
    if not isinstance(manifest["created_at"], str) or not manifest["created_at"]:
        raise BackupError("manifest created_at is invalid")
    roots = manifest["roots"]
    if not isinstance(roots, dict) or set(roots) != set(ROOT_PREFIXES):
        raise BackupError("manifest roots are invalid")
    for name, prefix in ROOT_PREFIXES.items():
        value = roots[name]
        if not isinstance(value, dict) or set(value) != {"archive_prefix", "present"} or value["archive_prefix"] != prefix or type(value["present"]) is not bool:
            raise BackupError(f"manifest root metadata is invalid: {name}")
    directories = manifest["directories"]
    files = manifest["files"]
    if not isinstance(directories, list) or not isinstance(files, list):
        raise BackupError("manifest directories/files must be lists")
    paths: set[str] = set()
    portable_paths: dict[str, str] = {}
    for item in directories:
        if not isinstance(item, dict) or set(item) != {"path", "mode", "mtime_ns"}:
            raise BackupError("invalid directory manifest entry")
        path = _safe_archive_path(item["path"], directory=True)
        path_key = _portable_path_key(path)
        if path in paths or path_key in portable_paths:
            raise BackupError(f"duplicate or non-portable manifest path collision: {path}")
        portable_paths[path_key] = path
        if type(item["mtime_ns"]) is not int or not 0 <= item["mtime_ns"] <= MAX_MTIME_NS:
            raise BackupError(f"invalid directory metadata: {path}")
        _safe_mode(item["mode"], path)
        paths.add(path)
    total_file_bytes = 0
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "sha256", "size", "mode", "mtime_ns", "sqlite_snapshot"}:
            raise BackupError("invalid file manifest entry")
        path = _safe_archive_path(item["path"])
        path_key = _portable_path_key(path)
        if path in paths or path_key in portable_paths:
            raise BackupError(f"duplicate or non-portable manifest path collision: {path}")
        portable_paths[path_key] = path
        if not isinstance(item["sha256"], str) or len(item["sha256"]) != 64 or any(ch not in "0123456789abcdef" for ch in item["sha256"]):
            raise BackupError(f"invalid SHA-256 in manifest: {path}")
        if (
            type(item["size"]) is not int
            or item["size"] < 0
            or type(item["mtime_ns"]) is not int
            or not 0 <= item["mtime_ns"] <= MAX_MTIME_NS
            or type(item["sqlite_snapshot"]) is not bool
        ):
            raise BackupError(f"invalid file metadata: {path}")
        if item["size"] > MAX_MEMBER_BYTES:
            raise BackupError(f"member exceeds uncompressed size limit: {path}")
        total_file_bytes += item["size"]
        if total_file_bytes > MAX_TOTAL_MEMBER_BYTES:
            raise BackupError("backup exceeds total uncompressed size limit")
        _safe_mode(item["mode"], path)
        expected_sqlite_snapshot = PurePosixPath(path).name.casefold() == "evidence.db"
        if item["sqlite_snapshot"] is not expected_sqlite_snapshot:
            raise BackupError(f"SQLite snapshot marker does not match path: {path}")
        paths.add(path)
    file_paths = {item["path"] for item in files}
    for path in paths:
        parent = PurePosixPath(path).parent
        while parent.as_posix() != ".":
            if parent.as_posix() in file_paths:
                raise BackupError(f"file is an ancestor of another entry: {parent}")
            parent = parent.parent
    for name, prefix in ROOT_PREFIXES.items():
        present = roots[name]["present"]
        has_entries = any(path == prefix or path.startswith(prefix + "/") for path in paths)
        if present != has_entries:
            raise BackupError(f"manifest root presence disagrees with entries: {name}")
    return directories, files


def _inspect_archive(archive_path: Path, *, extract_to: Path | None = None) -> dict[str, Any]:
    archive_path = archive_path.expanduser().resolve()
    if _lstat_kind(archive_path) != "file":
        raise BackupError(f"backup archive is not a regular file: {archive_path}")
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise BackupError("archive contains duplicate member names")
            portable_names = [_portable_path_key(name) for name in names]
            if len(portable_names) != len(set(portable_names)):
                raise BackupError("archive contains case-insensitive member collisions")
            if names.count(MANIFEST_NAME) != 1:
                raise BackupError("archive must contain exactly one manifest")
            archive_total_bytes = 0
            for info in infos:
                if info.flag_bits & 0x1:
                    raise BackupError(f"encrypted archive member is forbidden: {info.filename}")
                if info.is_dir() or stat.S_ISLNK((info.external_attr >> 16) & 0xFFFF):
                    raise BackupError(f"directory/symlink ZIP members are forbidden: {info.filename}")
                if info.filename != MANIFEST_NAME:
                    _safe_archive_path(info.filename)
                    if info.file_size > MAX_MEMBER_BYTES:
                        raise BackupError(
                            f"member exceeds uncompressed size limit: {info.filename}"
                        )
                    archive_total_bytes += info.file_size
                    if archive_total_bytes > MAX_TOTAL_MEMBER_BYTES:
                        raise BackupError("backup exceeds total uncompressed size limit")
            manifest_info = archive.getinfo(MANIFEST_NAME)
            if manifest_info.file_size > MAX_MANIFEST_BYTES:
                raise BackupError("manifest is too large")
            manifest = _strict_json(archive.read(manifest_info))
            directories, files = _validate_manifest(manifest)
            expected = {item["path"]: item for item in files}
            actual = {info.filename: info for info in infos if info.filename != MANIFEST_NAME}
            if set(actual) != set(expected):
                raise BackupError("archive members do not exactly match the manifest")
            sqlite_temp: list[tuple[Path, str]] = []
            if extract_to is not None:
                extract_to.mkdir(parents=True, exist_ok=False)
                for item in directories:
                    (extract_to / Path(*PurePosixPath(item["path"]).parts)).mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="prime-harness-verify-") as temp_name:
                temp_root = Path(temp_name)
                for index, (path, item) in enumerate(sorted(expected.items())):
                    info = actual[path]
                    if info.file_size != item["size"]:
                        raise BackupError(f"size mismatch for {path}")
                    destination_path = None if extract_to is None else extract_to / Path(*PurePosixPath(path).parts)
                    db_temp = temp_root / f"db-{index}.sqlite" if item["sqlite_snapshot"] and destination_path is None else None
                    if destination_path is not None:
                        destination_path.parent.mkdir(parents=True, exist_ok=True)
                        if destination_path.exists():
                            raise BackupError(f"restore path collision: {path}")
                        output_handle = destination_path.open("xb")
                    elif db_temp is not None:
                        output_handle = db_temp.open("xb")
                    else:
                        output_handle = None
                    try:
                        with archive.open(info, "r") as input_handle:
                            digest, size = _sha256_stream(input_handle, output_handle)
                    finally:
                        if output_handle is not None:
                            output_handle.close()
                    if digest != item["sha256"] or size != item["size"]:
                        raise BackupError(f"content hash mismatch for {path}")
                    if destination_path is not None:
                        os.chmod(destination_path, item["mode"])
                        os.utime(destination_path, ns=(item["mtime_ns"], item["mtime_ns"]))
                    if item["sqlite_snapshot"]:
                        sqlite_path = destination_path if destination_path is not None else db_temp
                        assert sqlite_path is not None
                        sqlite_temp.append((sqlite_path, path))
                for sqlite_path, path in sqlite_temp:
                    connection = None
                    try:
                        connection = sqlite3.connect(sqlite_path.resolve().as_uri() + "?mode=ro", uri=True)
                        row = connection.execute("PRAGMA integrity_check").fetchone()
                    except sqlite3.Error as exc:
                        raise BackupError(f"restored SQLite database cannot be opened: {path}") from exc
                    finally:
                        if connection is not None:
                            connection.close()
                    if row != ("ok",):
                        raise BackupError(f"restored SQLite integrity_check failed: {path}: {row}")
            if extract_to is not None:
                for item in sorted(directories, key=lambda value: len(PurePosixPath(value["path"]).parts), reverse=True):
                    destination_path = extract_to / Path(*PurePosixPath(item["path"]).parts)
                    os.chmod(destination_path, item["mode"])
                    os.utime(destination_path, ns=(item["mtime_ns"], item["mtime_ns"]))
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, OverflowError) as exc:
        if isinstance(exc, BackupError):
            raise
        raise BackupError(f"cannot read backup archive: {archive_path}") from exc
    return {
        "status": "pass",
        "archive": str(archive_path),
        "files": len(files),
        "directories": len(directories),
        "manifest_sha256": hashlib.sha256(_canonical_json(manifest)).hexdigest(),
        "created_at": manifest["created_at"],
    }


def verify_backup(archive_path: Path) -> dict[str, Any]:
    """Validate schema, paths, members, hashes, and SQLite integrity."""
    return _inspect_archive(archive_path)


def restore_backup(archive_path: Path, destination: Path) -> dict[str, Any]:
    """Restore through staging into a destination path that does not exist."""
    destination = destination.expanduser().absolute()
    if os.path.lexists(destination):
        if _lstat_kind(destination) != "directory":
            raise BackupError(f"restore destination is not a directory: {destination}")
        try:
            next(destination.iterdir())
        except StopIteration:
            raise BackupError(f"restore destination must not already exist for atomic replacement: {destination}")
        raise BackupError(f"restore destination must be empty: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}.restore-", dir=destination.parent))
    staging.rmdir()
    try:
        result = _inspect_archive(archive_path, extract_to=staging)
        os.replace(staging, destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    result.update({"destination": str(destination), "restored": True})
    return result


def _default_session_dir() -> Path | None:
    value = os.environ.get("RLM_SESSION_DIR")
    return Path(value) if value else None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create", help="create and immediately verify an atomic backup")
    create.add_argument("--project-root", type=Path, default=Path.cwd())
    create.add_argument("--session-dir", type=Path, default=_default_session_dir())
    create.add_argument("--global-harness", type=Path, default=Path(os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR", Path.home() / ".prime" / "agent" / "harness")))
    create.add_argument("--output", type=Path)
    verify = subparsers.add_parser("verify", help="verify an archive without restoring it")
    verify.add_argument("archive", type=Path)
    restore = subparsers.add_parser("restore", help="restore an archive into a destination path that does not exist")
    restore.add_argument("archive", type=Path)
    restore.add_argument("--destination", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "create":
            if args.session_dir is None:
                raise BackupError("--session-dir is required when RLM_SESSION_DIR is unavailable")
            result = create_backup(project_root=args.project_root, session_dir=args.session_dir, global_harness=args.global_harness, output=args.output)
        elif args.command == "verify":
            result = verify_backup(args.archive)
        else:
            result = restore_backup(args.archive, args.destination)
    except BackupError as exc:
        print(json.dumps({"status": "fail", "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
