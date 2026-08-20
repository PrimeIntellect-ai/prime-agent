#!/usr/bin/env python3
"""Shared fail-closed policy for gate-profile applicability minima."""

from __future__ import annotations

import json
import ntpath
import os
import stat
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping

DEFAULT_MIN_APPLICABLE_CHECKS = 1
MAX_MANIFEST_BYTES = 1_048_576
RESULT_STATUSES = frozenset({"pass", "fail", "timeout", "error", "skipped"})


class ManifestPolicyError(ValueError):
    """A manifest applicability policy value is malformed or unsafe."""


def load_manifest_object(path: Path, max_bytes: int = MAX_MANIFEST_BYTES) -> dict[str, Any]:
    """Load a stable, bounded, regular UTF-8 JSON manifest object."""
    descriptor = -1
    try:
        before = path.lstat()
        attributes = getattr(before, "st_file_attributes", 0)
        if not stat.S_ISREG(before.st_mode) or attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
            raise ManifestPolicyError("manifest must be a regular non-link file")
        if before.st_size > max_bytes:
            raise ManifestPolicyError(f"manifest exceeds {max_bytes}-byte size limit")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        identity = (opened.st_dev, opened.st_ino)
        metadata = (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
        if (
            not stat.S_ISREG(opened.st_mode)
            or identity != (before.st_dev, before.st_ino)
            or opened.st_size > max_bytes
        ):
            raise ManifestPolicyError("manifest changed or exceeded its size limit before reading")
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(descriptor, min(65_536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        after = os.fstat(descriptor)
        if len(payload) > max_bytes:
            raise ManifestPolicyError(f"manifest exceeds {max_bytes}-byte size limit")
        if (after.st_dev, after.st_ino) != identity or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != metadata:
            raise ManifestPolicyError("manifest changed while being read")
        pathname_after = path.lstat()
        pathname_attributes = getattr(pathname_after, "st_file_attributes", 0)
        if (
            (pathname_after.st_dev, pathname_after.st_ino) != identity
            or not stat.S_ISREG(pathname_after.st_mode)
            or pathname_attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        ):
            raise ManifestPolicyError("manifest pathname changed while being read")
        try:
            value = json.loads(payload.decode("utf-8-sig"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise ManifestPolicyError(f"manifest is not valid UTF-8 JSON: {exc}") from exc
        if not isinstance(value, dict):
            raise ManifestPolicyError(f"manifest root must be a JSON object, got {type(value).__name__}")
        return value
    except FileNotFoundError as exc:
        raise ManifestPolicyError(f"manifest not found: {path}") from exc
    except OSError as exc:
        raise ManifestPolicyError(f"manifest could not be read safely: {exc}") from exc
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass


def profile_minimum(profile: Mapping[str, Any], profile_name: str = "profile") -> int:
    """Return a strictly positive minimum; booleans never count as integers."""
    value = profile.get("min_applicable_checks", DEFAULT_MIN_APPLICABLE_CHECKS)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ManifestPolicyError(
            f"profile {profile_name!r} min_applicable_checks must be an integer >= 1, got {value!r}"
        )
    return value


def validate_profiles(profiles: object) -> dict[str, int]:
    """Validate profile containers and return each effective minimum."""
    if not isinstance(profiles, dict) or not profiles:
        raise ManifestPolicyError("manifest profiles must be a non-empty object")
    minima: dict[str, int] = {}
    for name, profile in profiles.items():
        if not isinstance(name, str) or not name:
            raise ManifestPolicyError("profile names must be non-empty strings")
        if not isinstance(profile, dict):
            raise ManifestPolicyError(f"profile {name!r} must be an object")
        minima[name] = profile_minimum(profile, name)
        for section in ("required", "conditional"):
            entries = profile.get(section, [])
            if not isinstance(entries, list):
                raise ManifestPolicyError(f"profile {name!r} {section} must be a list")
    return minima


def marker_status(root: Path, marker: object) -> tuple[bool, str]:
    """Check a repo-relative marker without accepting traversal or link/reparse paths."""
    if not isinstance(marker, str) or not marker or "\x00" in marker or "\\" in marker:
        raise ManifestPolicyError("skip_if_missing must be a non-empty forward-slash path")
    pure = PurePosixPath(marker)
    drive, _ = ntpath.splitdrive(marker)
    if drive or pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise ManifestPolicyError(f"skip_if_missing escapes or ambiguously names the repository: {marker!r}")
    current = root.resolve()
    for part in pure.parts:
        current = current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            return False, f"missing {marker}"
        except OSError as exc:
            return False, f"unreadable {marker}: {exc}"
        attributes = getattr(metadata, "st_file_attributes", 0)
        if stat.S_ISLNK(metadata.st_mode) or attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
            return False, f"link/reparse component forbidden in {marker}"
    return True, "present"


def applicable_count(results: Iterable[Mapping[str, Any]]) -> int:
    """Count checks that executed or errored before execution; skips do not count."""
    count = 0
    for index, result in enumerate(results):
        status = result.get("status")
        if status not in RESULT_STATUSES:
            raise ManifestPolicyError(f"result {index} has unsupported status {status!r}")
        if status != "skipped":
            count += 1
    return count


def coverage_fields(
    results: Iterable[Mapping[str, Any]], minimum: int, *, allow_vacuous: bool,
) -> dict[str, Any]:
    """Return deterministic fields consumed by the gate's final verdict."""
    if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 1:
        raise ManifestPolicyError(f"minimum must be an integer >= 1, got {minimum!r}")
    materialized = list(results)
    applicable = applicable_count(materialized)
    deficient = applicable < minimum
    return {
        "applicable_checks": applicable,
        "min_applicable_checks": minimum,
        "vacuous": deficient,
        "vacuous_allowed": bool(deficient and allow_vacuous),
        "coverage_satisfied": bool(not deficient or allow_vacuous),
    }
