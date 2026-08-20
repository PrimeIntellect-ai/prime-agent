#!/usr/bin/env python3
"""Install the Prime Harness into a target repository.

Copies template/ into the target, merges .gitignore entries, and never
overwrites modified files unless --force. Versioned --upgrade uses the recorded
pristine hash as a third comparison arm and emits .new files for local edits.
Idempotent: re-running against an installed target reports "unchanged" and
touches nothing.

Usage:
  python install.py <target-repo> [--force|--upgrade] [--check] [--tailor] [--dry-run]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import subprocess
import sys
from pathlib import Path, PurePosixPath

INSTALLER_ROOT = Path(__file__).resolve().parent
TEMPLATE = INSTALLER_ROOT / "template"
VERSION_FILE = INSTALLER_ROOT / "VERSION"
INSTALL_STATE_RELATIVE = Path(".prime/agent/harness-install-state.json")
INSTALL_STATE_SCHEMA_VERSION = 1
MAX_TEMPLATE_FILE_BYTES = 64 * 1024 * 1024
MAX_INSTALL_STATE_FILES = 10_000

GITIGNORE_BLOCK = [
    "# prime-harness runtime state (evidence db, gate logs, child results)",
    "artifacts/harness/",
    "# Python transient bytecode",
    "__pycache__/",
    "*.py[cod]",
    "# pytest-managed installed harness link",
    ".prime/agent/harness-tests/template",
]

IGNORED_TEMPLATE_DIRS = {"__pycache__"}
IGNORED_TEMPLATE_SUFFIXES = {".pyc", ".pyo"}
INSTALLED_EXAMPLES_RELATIVE = Path("artifacts/harness/installed-examples.json")
EXAMPLE_SUBTREES = ("checks/properties", "checks/invariants", "checks/reference_cases")


def is_ignored_template_artifact(path: Path) -> bool:
    """Return whether an installer source path is transient Python bytecode."""
    return bool(IGNORED_TEMPLATE_DIRS.intersection(path.parts)) or path.suffix.lower() in IGNORED_TEMPLATE_SUFFIXES

class TailorError(RuntimeError):
    """The target layout cannot produce a non-vacuous gate manifest."""


def _check(name: str, command: str, path: str, timeout: int) -> dict[str, object]:
    return {
        "name": name,
        "command": command,
        "skip_if_missing": path,
        "timeout_seconds": timeout,
    }


def _is_linklike(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    if is_junction and is_junction():
        return True
    try:
        attributes = getattr(path.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return True
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def _bounded_entries(directory: Path, limit: int) -> list[Path] | None:
    """Collect at most limit entries, consuming only the one excess sentinel."""
    entries: list[Path] = []
    try:
        iterator = directory.iterdir()
        for path in iterator:
            if len(entries) >= limit:
                return None
            entries.append(path)
    except OSError:
        return None
    return sorted(entries, key=lambda path: path.name.casefold())


def _resolve_actual_layout_path(
    root: Path, canonical: str, *, root_entries: list[Path] | None = None,
) -> tuple[Path, str] | None:
    """Resolve fixed marker spelling from directory entries without following links."""
    current = root
    actual_parts: list[str] = []
    for index, expected in enumerate(canonical.split("/")):
        entries = root_entries if index == 0 and root_entries is not None else _bounded_entries(current, 512)
        if entries is None:
            raise TailorError(f"layout directory for {canonical!r} is unreadable or exceeds 512 entries")
        matches = [entry for entry in entries if entry.name.casefold() == expected.casefold()]
        if len(matches) > 1:
            raise TailorError(f"layout marker {canonical!r} is ambiguous under case folding")
        if not matches:
            return None
        current = matches[0]
        if _is_linklike(current):
            raise TailorError(f"link/reparse layout marker forbidden: {canonical!r}")
        actual_parts.append(current.name)
    return current, "/".join(actual_parts)


def _bounded_inventory(base: Path) -> dict[str, Path] | None:
    """Inventory a small regular tree without following link/reparse entries."""
    files: dict[str, Path] = {}
    pending: list[tuple[Path, int]] = [(base, 0)]
    seen = 0
    while pending:
        directory, depth = pending.pop()
        if depth > 8:
            return None
        entries = _bounded_entries(directory, 256 - seen)
        if entries is None:
            return None
        for path in entries:
            if path.name == "__pycache__" or path.suffix.lower() in IGNORED_TEMPLATE_SUFFIXES:
                continue
            seen += 1
            if seen > 256 or _is_linklike(path):
                return None
            try:
                if path.is_dir():
                    pending.append((path, depth + 1))
                elif path.is_file():
                    files[path.relative_to(base).as_posix()] = path
                else:
                    return None
            except OSError:
                return None
    return files


def _validated_regular_tree_files(base: Path, label: str, limit: int = 4096) -> list[Path]:
    """Return files only after validating a complete bounded non-link tree."""
    pending: list[tuple[Path, int]] = [(base, 0)]
    files: list[Path] = []
    seen = 0
    while pending:
        directory, depth = pending.pop()
        if depth > 12:
            raise TailorError(f"{label} scan exceeds depth limit")
        entries = _bounded_entries(directory, limit - seen)
        if entries is None:
            raise TailorError(f"{label} scan exceeds {limit}-entry limit")
        for path in entries:
            if path.name == "__pycache__":
                continue
            seen += 1
            if _is_linklike(path):
                raise TailorError(f"link/reparse entry forbidden while scanning {label}: {path.name}")
            try:
                if path.is_dir():
                    pending.append((path, depth + 1))
                elif path.is_file():
                    files.append(path)
                else:
                    raise TailorError(f"non-regular entry forbidden while scanning {label}: {path.name}")
            except OSError as exc:
                raise TailorError(f"unstable entry while scanning {label}: {exc}") from exc
    return files


def _contains_python_source(base: Path) -> bool:
    return any(
        path.suffix.casefold() in {".py", ".pyi"}
        for path in _validated_regular_tree_files(base, f"Python source root {base.name}")
    )


def _template_only_subtree(target: Path, relative: str, destination_relative: str | None = None) -> bool:
    source = TEMPLATE / relative
    destination = target / (destination_relative or relative)
    if not source.is_dir() or not destination.is_dir():
        return False
    source_files = _bounded_inventory(source)
    destination_files = _bounded_inventory(destination)
    if source_files is None or destination_files is None:
        raise TailorError(f"installer-owned subtree {relative!r} is unreadable or exceeds limits")
    known: dict[str, set[str]] = {
        name: {digest} for name, digest in _load_installed_example_hashes(target).items()
    }
    for name, path in source_files.items():
        digest = _stable_text_sha256(path)
        if digest is None:
            raise TailorError(f"installer template example is not stable UTF-8: {relative}/{name}")
        known.setdefault(f"{relative}/{name}", set()).add(digest)
    for name, path in destination_files.items():
        digest = _stable_text_sha256(path)
        if digest is None or digest not in known.get(f"{relative}/{name}", set()):
            return False
    return True


def _bounded_text(path: Path, limit: int = 1_048_576) -> str | None:
    """Read one stable regular file by descriptor with link and size denial."""
    descriptor = -1
    try:
        before = path.lstat()
        attributes = getattr(before, "st_file_attributes", 0)
        if (
            not stat.S_ISREG(before.st_mode)
            or attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
            or before.st_size > limit
        ):
            return None
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        identity_before = (before.st_dev, before.st_ino)
        identity_opened = (opened.st_dev, opened.st_ino)
        metadata_opened = (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
        if (
            not stat.S_ISREG(opened.st_mode)
            or identity_opened != identity_before
            or opened.st_size > limit
        ):
            return None
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(descriptor, min(65_536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            return None
        opened_after = os.fstat(descriptor)
        after = path.lstat()
        after_attributes = getattr(after, "st_file_attributes", 0)
        if (
            (opened_after.st_dev, opened_after.st_ino) != identity_opened
            or (opened_after.st_size, opened_after.st_mtime_ns, opened_after.st_ctime_ns) != metadata_opened
            or (after.st_dev, after.st_ino) != identity_before
            or stat.S_ISLNK(after.st_mode)
            or after_attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        ):
            return None
        return data.decode("utf-8")
    except (OSError, UnicodeError):
        return None
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _stable_text_sha256(path: Path) -> str | None:
    text = _bounded_text(path)
    return hashlib.sha256(text.encode("utf-8")).hexdigest() if text is not None else None


def _load_installed_example_hashes(target: Path) -> dict[str, str]:
    path = target / INSTALLED_EXAMPLES_RELATIVE
    if not os.path.lexists(path):
        return {}
    text = _bounded_text(path)
    if text is None:
        raise TailorError(f"installer-owned example manifest is unreadable: {INSTALLED_EXAMPLES_RELATIVE}")
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise TailorError(f"installer-owned example manifest is invalid JSON: {exc}") from exc
    if not isinstance(value, dict) or set(value) != {"schema_version", "files"} or value.get("schema_version") != 1:
        raise TailorError("installer-owned example manifest has an invalid schema")
    files = value.get("files")
    if not isinstance(files, dict) or len(files) > 256:
        raise TailorError("installer-owned example manifest files must be an object with at most 256 entries")
    result: dict[str, str] = {}
    for relative, digest in files.items():
        if (
            not isinstance(relative, str)
            or not isinstance(digest, str)
            or "\\" in relative
            or relative.startswith("/")
            or any(part in {"", ".", ".."} for part in relative.split("/"))
            or not any(relative == prefix or relative.startswith(prefix + "/") for prefix in EXAMPLE_SUBTREES)
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
        ):
            raise TailorError("installer-owned example manifest contains an invalid path or SHA-256")
        result[relative] = digest
    return result


def _record_installed_example_hashes(target: Path, template_sources: list[Path]) -> None:
    hashes = _load_installed_example_hashes(target)
    for source in template_sources:
        relative = source.relative_to(TEMPLATE).as_posix()
        if not any(relative == prefix or relative.startswith(prefix + "/") for prefix in EXAMPLE_SUBTREES):
            continue
        source_digest = _stable_text_sha256(source)
        destination_digest = _stable_text_sha256(target / relative)
        if source_digest is not None and destination_digest == source_digest:
            hashes[relative] = source_digest
    path = target / INSTALLED_EXAMPLES_RELATIVE
    value = {"schema_version": 1, "files": hashes}
    if not json_matches(path, value):
        atomic_json(path, value)


def _credible_node_test_script(script: str) -> bool:
    """Accept only an unmasked test runner appearing as a command."""
    normalized = " ".join(script.casefold().split())
    if "||" in normalized:
        return False
    prefix = r"(?:(?:cross-env(?:-shell)?\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*)"
    runner = re.compile(
        r"^" + prefix
        + r"(?:(?:npx|pnpm exec|yarn dlx)\s+)?"
        + r"(?:node\s+--test\b|jest\b|vitest\b|mocha\b|ava\b|tap\b|tape\b|"
        + r"cypress(?:\s+run)?\b|playwright\s+test\b|"
        + r"(?:npm|pnpm|yarn)\s+run\s+test(?::[a-z0-9_.-]+)?\b)"
    )
    for segment in re.split(r"&&|;", normalized):
        if runner.match(" ".join(segment.strip().split())):
            return True
    return False


def tailor_manifest(target: Path) -> dict[str, object]:
    """Build a deterministic gate draft from bounded top-level project markers."""
    target = target.resolve()
    checks: list[dict[str, object]] = []
    detected: list[str] = []
    top_level = _bounded_entries(target, 512)
    if top_level is None:
        raise TailorError("target root exceeds the 512-entry tailoring scan limit or is unreadable")

    python_roots: list[str] = []
    for source_dir in ("src", "sim", "simulation", "simulations"):
        resolved = _resolve_actual_layout_path(target, source_dir, root_entries=top_level)
        if resolved is None:
            continue
        candidate, actual_source = resolved
        if candidate.is_dir() and _contains_python_source(candidate):
            python_roots.append(actual_source)
    # Source-layout-free packages are detected only one level deep; never walk
    # an untrusted or very large repository during installation.
    excluded = {".git", ".prime", ".github", "artifacts", "checks", "harness", "tests", "test", "node_modules"}
    for path in top_level:
        if path.name.casefold() in excluded or path.name.startswith(".") or not path.is_dir() or _is_linklike(path):
            continue
        package_init = path / "__init__.py"
        if (
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", path.name)
            and package_init.is_file()
            and not _is_linklike(package_init)
        ):
            _contains_python_source(path)  # validates every descendant before recursive compileall
            python_roots.append(path.name)
    python_roots = sorted(set(python_roots), key=lambda value: (value.casefold(), value))
    if python_roots:
        joined = " ".join(python_roots)
        checks.append(_check("compile", f"python -m compileall -q {joined}", python_roots[0], 120))
        detected.extend(f"python-package:{item}" for item in python_roots)

    test_dirs: list[str] = []
    for item in ("tests", "test", "checks/properties", "checks/invariants", "checks/reference_cases"):
        resolved = _resolve_actual_layout_path(target, item, root_entries=top_level)
        if resolved is None:
            continue
        candidate, actual_item = resolved
        if not candidate.is_dir():
            continue
        _validated_regular_tree_files(candidate, f"test directory {actual_item}")
        if not _template_only_subtree(target, item, actual_item):
            test_dirs.append(actual_item)
    pyproject_resolved = _resolve_actual_layout_path(target, "pyproject.toml", root_entries=top_level)
    pyproject_path = pyproject_resolved[0] if pyproject_resolved else target / "__missing_pyproject__"
    pyproject_name = pyproject_resolved[1] if pyproject_resolved else "pyproject.toml"
    pyproject_text = _bounded_text(pyproject_path)
    if pyproject_text is not None:
        detected.append(pyproject_name)
    if test_dirs:
        for item in test_dirs:
            name = "unit" if len(test_dirs) == 1 else f"unit:{item}"
            checks.append(_check(name, f"python -m pytest -q {item}", item, 900))
        detected.extend(f"python-tests:{item}" for item in test_dirs)
    elif pyproject_text is not None and "[tool.pytest" in pyproject_text:
        checks.append(_check("unit", "python -m pytest -q", pyproject_name, 900))
        detected.append(f"{pyproject_name}:pytest")
    else:
        tox_resolved = _resolve_actual_layout_path(target, "tox.ini", root_entries=top_level)
        if tox_resolved and tox_resolved[0].is_file():
            checks.append(_check("tox", "python -m tox -q", tox_resolved[1], 900))
            detected.append(tox_resolved[1])

    lake_marker: str | None = None
    for item in ("lakefile.lean", "lakefile.toml"):
        resolved = _resolve_actual_layout_path(target, item, root_entries=top_level)
        if resolved and resolved[0].is_file():
            lake_marker = resolved[1]
            break
    if lake_marker:
        checks.append(_check("lean-build", "lake build", lake_marker, 900))
        detected.append(lake_marker)

    package_resolved = _resolve_actual_layout_path(target, "package.json", root_entries=top_level)
    package_path = package_resolved[0] if package_resolved else target / "__missing_package__"
    package_text = _bounded_text(package_path)
    if package_text is not None:
        try:
            package = json.loads(package_text)
        except json.JSONDecodeError:
            package = None
        script = package.get("scripts", {}).get("test") if isinstance(package, dict) and isinstance(package.get("scripts"), dict) else None
        if isinstance(script, str) and _credible_node_test_script(script):
            assert package_resolved is not None
            checks.append(_check("node-test", "npm test", package_resolved[1], 900))
            detected.append(f"{package_resolved[1]}:test")

    if not checks:
        raise TailorError(
            "no executable project checks detected (expected Python package/tests, tox.ini, "
            "lakefile, or a non-placeholder package.json test script)"
        )

    quick: list[dict[str, object]] = []
    # Repair bursts allow 600 seconds for the complete quick gate. Keep 120
    # seconds of launcher/result headroom and divide the rest deterministically
    # across every detected check; default retains each check's full timeout.
    quick_timeout = max(1, 480 // len(checks))
    for entry in checks:
        item = dict(entry)
        if str(item["name"]).startswith("unit"):
            item["command"] = str(item["command"]).replace("pytest -q", "pytest -q -x", 1)
        item["timeout_seconds"] = min(int(item.get("timeout_seconds", quick_timeout)), quick_timeout)
        quick.append(item)
    default = [dict(entry) for entry in checks]
    changed = [dict(entry) for entry in checks]
    profiles: dict[str, object] = {
        "quick": {"min_applicable_checks": 1, "required": quick, "conditional": []},
        "default": {"min_applicable_checks": 1, "required": default, "conditional": []},
        "changed-files": {"min_applicable_checks": 1, "required": changed, "conditional": []},
    }
    holdout_resolved = _resolve_actual_layout_path(target, "checks/hidden_holdout", root_entries=top_level)
    if holdout_resolved and holdout_resolved[0].is_dir() and not _template_only_subtree(
        target, "checks/hidden_holdout", holdout_resolved[1],
    ):
        holdout_name = holdout_resolved[1]
        profiles["holdout"] = {
            "min_applicable_checks": 1,
            "required": [_check("hidden-holdout", f"python -m pytest -q {holdout_name}", holdout_name, 1800)],
            "conditional": [],
        }
        detected.append(holdout_name)
    return {
        "_generated_by": "prime-harness install.py --tailor",
        "_detected": sorted(detected),
        "profiles": profiles,
    }


def read_harness_version() -> str:
    try:
        value = VERSION_FILE.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError) as exc:
        raise TailorError("VERSION is not readable UTF-8") from exc
    if re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", value) is None:
        raise TailorError("VERSION must contain one canonical semantic version")
    return value


def _stable_regular_bytes(path: Path, *, limit: int = MAX_TEMPLATE_FILE_BYTES) -> bytes | None:
    try:
        if _is_linklike(path) or not path.is_file():
            return None
        before = path.stat(follow_symlinks=False)
        if before.st_size > limit:
            return None
        with path.open("rb") as handle:
            value = handle.read(limit + 1)
        after = path.stat(follow_symlinks=False)
    except OSError:
        return None
    if len(value) > limit:
        return None
    identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    return value if identity_before == identity_after else None


def _materialize_template(source: Path, relative: Path, version: str) -> bytes:
    raw = _stable_regular_bytes(source)
    if raw is None:
        raise TailorError(f"template source is not a stable bounded regular file: {relative.as_posix()}")
    if relative.as_posix() != "harness/config.json":
        return raw
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise TailorError("template harness/config.json is not UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise TailorError("template harness/config.json must be an object")
    value["prime_harness_version"] = version
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def _template_inventory(version: str) -> dict[str, tuple[Path, bytes, int]]:
    inventory: dict[str, tuple[Path, bytes, int]] = {}
    for source in sorted(TEMPLATE.rglob("*")):
        if source.is_dir() and not _is_linklike(source):
            continue
        if is_ignored_template_artifact(source):
            continue
        relative = source.relative_to(TEMPLATE)
        key = relative.as_posix()
        if len(inventory) >= MAX_INSTALL_STATE_FILES:
            raise TailorError("template file count exceeds the installer limit")
        payload = _materialize_template(source, relative, version)
        try:
            mode = stat.S_IMODE(source.stat(follow_symlinks=False).st_mode)
        except OSError as exc:
            raise TailorError(f"template source became unreadable: {key}") from exc
        inventory[key] = (source, payload, mode)
    if not inventory or "harness/config.json" not in inventory:
        raise TailorError("template inventory is incomplete")
    return inventory


def _inventory_hashes(inventory: dict[str, tuple[Path, bytes, int]]) -> dict[str, str]:
    return {key: hashlib.sha256(value[1]).hexdigest() for key, value in sorted(inventory.items())}


def _valid_state_relative(value: str) -> bool:
    if not value or "\\" in value or "\0" in value or ":" in value:
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and all(part not in {"", ".", ".."} for part in path.parts)


def load_install_state(path: Path) -> dict[str, object] | None:
    if not os.path.lexists(path):
        return None
    text = _bounded_text(path)
    if text is None:
        raise TailorError("install state is not a stable bounded UTF-8 regular file")
    try:
        state = json.loads(text)
    except json.JSONDecodeError as exc:
        raise TailorError("install state is not valid JSON") from exc
    allowed_keys = {"schema_version", "installed_version", "template_sha256", "pending_sidecar_sha256"}
    if not isinstance(state, dict) or set(state) - allowed_keys or not {"schema_version", "installed_version", "template_sha256"}.issubset(state):
        raise TailorError("install state schema is invalid")
    version = state.get("installed_version")
    hashes = state.get("template_sha256")
    pending = state.get("pending_sidecar_sha256", {})
    if state.get("schema_version") != INSTALL_STATE_SCHEMA_VERSION or not isinstance(version, str) or re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version) is None:
        raise TailorError("install state version is invalid")
    if not isinstance(hashes, dict) or len(hashes) > MAX_INSTALL_STATE_FILES:
        raise TailorError("install state template hash map is invalid")
    if not isinstance(pending, dict) or len(pending) > MAX_INSTALL_STATE_FILES:
        raise TailorError("install state pending sidecar map is invalid")
    normalized: dict[str, str] = {}
    for relative, digest in hashes.items():
        if not isinstance(relative, str) or not _valid_state_relative(relative):
            raise TailorError("install state contains an unsafe template path")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise TailorError("install state contains an invalid template digest")
        normalized[relative] = digest
    normalized_pending: dict[str, str] = {}
    for relative, digest in pending.items():
        if not isinstance(relative, str) or not _valid_state_relative(relative):
            raise TailorError("install state contains an unsafe pending sidecar path")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise TailorError("install state contains an invalid pending sidecar digest")
        normalized_pending[relative] = digest
    return {
        "schema_version": INSTALL_STATE_SCHEMA_VERSION,
        "installed_version": version,
        "template_sha256": normalized,
        "pending_sidecar_sha256": normalized_pending,
    }


def assert_safe_destination(root: Path, destination: Path) -> None:
    """Reject any existing link/reparse or non-directory parent below root."""
    root = root.resolve()
    try:
        relative = destination.relative_to(root)
    except ValueError as exc:
        raise TailorError(f"destination escapes target repository: {destination}") from exc
    current = root
    for index, part in enumerate(relative.parts):
        current = current / part
        if not os.path.lexists(current):
            continue
        if _is_linklike(current):
            raise TailorError(f"link/reparse destination forbidden: {relative.as_posix()}")
        if index < len(relative.parts) - 1 and not current.is_dir():
            raise TailorError(f"non-directory destination parent forbidden: {relative.as_posix()}")


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def atomic_copy(source: Path, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    temporary = Path(temporary_name)
    try:
        with source.open("rb") as source_handle, os.fdopen(descriptor, "wb") as destination_handle:
            shutil.copyfileobj(source_handle, destination_handle, length=1024 * 1024)
            destination_handle.flush()
            os.fsync(destination_handle.fileno())
        os.chmod(temporary, stat.S_IMODE(source.stat(follow_symlinks=False).st_mode))
        os.replace(temporary, path)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, indent=2, sort_keys=True, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _directory_identity(path: Path) -> tuple[int, int, int] | None:
    try:
        info = path.stat(follow_symlinks=False)
    except OSError:
        return None
    if _is_linklike(path) or not path.is_dir():
        return None
    return (info.st_dev, info.st_ino, info.st_mode)


def _unused_temporary_path(parent: Path, prefix: str) -> Path:
    descriptor, name = tempfile.mkstemp(prefix=prefix, suffix=".hold", dir=str(parent))
    os.close(descriptor)
    path = Path(name)
    path.unlink()
    return path


def atomic_bytes(path: Path, value: bytes, mode: int = 0o644,
                 expected_parent_identity: tuple[int, int, int] | None = None,
                 expected_digest: str | None = None, require_absent: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if expected_parent_identity is not None and _directory_identity(path.parent) != expected_parent_identity:
        raise TailorError(f"destination parent changed before atomic write: {path}")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    temporary = Path(temporary_name)
    held: Path | None = None
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        if expected_parent_identity is not None and _directory_identity(path.parent) != expected_parent_identity:
            raise TailorError(f"destination parent changed during atomic write: {path}")
        if require_absent:
            # Hard-link creation is an atomic create-if-absent operation. It
            # cannot overwrite a file that appeared after preflight.
            os.link(temporary, path)
            temporary.unlink()
            return
        if expected_digest is None:
            os.replace(temporary, path)
            return
        # Capture the compared object under an unguessable hold name before
        # validating it. A later writer to the original pathname can no longer
        # change the captured bytes that authorize replacement.
        held = _unused_temporary_path(path.parent, f".{path.name}.")
        os.replace(path, held)
        captured = _stable_regular_bytes(held)
        if captured is None or hashlib.sha256(captured).hexdigest() != expected_digest:
            if not os.path.lexists(path):
                os.replace(held, path)
                held = None
            raise TailorError(f"destination content changed during atomic capture: {path}")
        if expected_parent_identity is not None and _directory_identity(path.parent) != expected_parent_identity:
            if not os.path.lexists(path):
                os.replace(held, path)
                held = None
            raise TailorError(f"destination parent changed during atomic capture: {path}")
        try:
            os.link(temporary, path)
        except BaseException:
            if not os.path.lexists(path):
                os.replace(held, path)
                held = None
            raise
        temporary.unlink()
        held.unlink()
        held = None
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        # If a concurrent creator occupied the destination, retain the captured
        # original beside it rather than destroying either party's bytes.
        if held is not None and held.exists() and not os.path.lexists(path):
            try:
                os.replace(held, path)
            except OSError:
                pass


def _atomic_remove_expected(path: Path, expected_digest: str,
                            expected_parent_identity: tuple[int, int, int] | None) -> None:
    if expected_parent_identity is not None and _directory_identity(path.parent) != expected_parent_identity:
        raise TailorError(f"destination parent changed before atomic removal: {path}")
    held = _unused_temporary_path(path.parent, f".{path.name}.")
    os.replace(path, held)
    try:
        captured = _stable_regular_bytes(held)
        if captured is None or hashlib.sha256(captured).hexdigest() != expected_digest:
            if not os.path.lexists(path):
                os.replace(held, path)
            raise TailorError(f"destination content changed during atomic removal: {path}")
        held.unlink()
    except BaseException:
        if held.exists() and not os.path.lexists(path):
            try:
                os.replace(held, path)
            except OSError:
                pass
        raise


def _run_upgrade(target: Path, *, version: str,
                 inventory: dict[str, tuple[Path, bytes, int]], dry_run: bool) -> tuple[int, dict[str, int]]:
    state_path = target / INSTALL_STATE_RELATIVE
    try:
        assert_safe_destination(target, state_path)
        state_original = _stable_regular_bytes(state_path)
        state = load_install_state(state_path)
    except TailorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2, {}
    if state is None or state_original is None:
        print("error: install state is missing; --upgrade requires a versioned prior installation", file=sys.stderr)
        return 2, {}
    old_hashes = state["template_sha256"]
    pending_hashes = state.get("pending_sidecar_sha256", {})
    assert isinstance(old_hashes, dict) and isinstance(pending_hashes, dict)
    decisions: list[dict[str, object]] = []
    conflict_payload_hashes: dict[str, str] = {}
    counts = {
        "updated": 0, "new": 0, "unchanged": 0, "conflicts": 0,
        "obsolete_removed": 0, "obsolete_kept": 0,
    }
    config_conflict = False

    def decision(action: str, path: Path, payload: bytes, mode: int,
                 original: bytes | None, key: str | None = None) -> None:
        decisions.append({
            "action": action, "path": path, "payload": payload, "mode": mode,
            "original": original, "key": key,
            "original_mode": (
                stat.S_IMODE(path.stat(follow_symlinks=False).st_mode)
                if original is not None else None
            ),
            "expected_digest": hashlib.sha256(original).hexdigest() if original is not None else None,
            "parent_identity": _directory_identity(path.parent),
        })

    def handle_conflict(key: str, sidecar: Path, payload: bytes, mode: int,
                        old_digest: object) -> None:
        current_digest = hashlib.sha256(payload).hexdigest()
        conflict_payload_hashes[key] = current_digest
        if os.path.lexists(sidecar):
            sidecar_payload = _stable_regular_bytes(sidecar)
            if sidecar_payload is None:
                raise TailorError(f"upgrade sidecar is not a stable bounded regular file: {key}.new")
            sidecar_digest = hashlib.sha256(sidecar_payload).hexdigest()
            if sidecar_digest == current_digest:
                return
            authorized = {digest for digest in (old_digest, pending_hashes.get(key)) if isinstance(digest, str)}
            if sidecar_digest not in authorized:
                raise TailorError(f"edited upgrade sidecar would be overwritten: {key}.new")
            decision("conflict", sidecar, payload, mode, sidecar_payload, key)
        else:
            decision("conflict", sidecar, payload, mode, None, key)

    try:
        for key, (_source, payload, mode) in sorted(inventory.items()):
            destination = target / Path(*PurePosixPath(key).parts)
            sidecar = Path(str(destination) + ".new")
            assert_safe_destination(target, destination)
            assert_safe_destination(target, sidecar)
            current_digest = hashlib.sha256(payload).hexdigest()
            old_digest = old_hashes.get(key)
            if os.path.lexists(destination):
                user_payload = _stable_regular_bytes(destination)
                if user_payload is None:
                    raise TailorError(f"upgrade destination is not a stable bounded regular file: {key}")
                user_digest = hashlib.sha256(user_payload).hexdigest()
                if user_digest == current_digest:
                    counts["unchanged"] += 1
                    continue
                if isinstance(old_digest, str) and user_digest == old_digest:
                    decision("updated", destination, payload, mode, user_payload, key)
                    counts["updated"] += 1
                    continue
                counts["conflicts"] += 1
                config_conflict = config_conflict or key == "harness/config.json"
                handle_conflict(key, sidecar, payload, mode, old_digest)
            elif isinstance(old_digest, str):
                # Deletion of a previously managed file is a local customization.
                counts["conflicts"] += 1
                config_conflict = config_conflict or key == "harness/config.json"
                handle_conflict(key, sidecar, payload, mode, old_digest)
            else:
                decision("new", destination, payload, mode, None, key)
                counts["new"] += 1

        for key in sorted(set(old_hashes) - set(inventory)):
            destination = target / Path(*PurePosixPath(key).parts)
            assert_safe_destination(target, destination)
            if not os.path.lexists(destination):
                continue
            original = _stable_regular_bytes(destination)
            if original is None:
                raise TailorError(f"obsolete managed destination is not a stable bounded regular file: {key}")
            if hashlib.sha256(original).hexdigest() == old_hashes[key]:
                decision("remove", destination, b"", 0, original, key)
                counts["obsolete_removed"] += 1
            else:
                counts["obsolete_kept"] += 1

        if not config_conflict:
            # Append-only .gitignore merge is part of the same transaction.
            gitignore = target / ".gitignore"
            assert_safe_destination(target, gitignore)
            if os.path.lexists(gitignore):
                gitignore_text = _bounded_text(gitignore)
                if gitignore_text is None:
                    raise TailorError(".gitignore is not a stable bounded UTF-8 regular file")
                gitignore_original = gitignore_text.encode("utf-8")
                gitignore_mode = stat.S_IMODE(gitignore.stat(follow_symlinks=False).st_mode)
            else:
                gitignore_text, gitignore_original, gitignore_mode = "", None, 0o644
            missing = [line for line in GITIGNORE_BLOCK if line not in gitignore_text.splitlines()]
            if any(not line.startswith("#") for line in missing):
                separator = "" if not gitignore_text or gitignore_text.endswith("\n") else "\n"
                desired = (gitignore_text + separator + "\n".join(missing) + "\n").encode("utf-8")
                decision("metadata", gitignore, desired, gitignore_mode, gitignore_original)

            # Compute installed-example provenance for the post-upgrade tree.
            example_hashes = _load_installed_example_hashes(target)
            for stale in list(example_hashes):
                if stale not in inventory:
                    example_hashes.pop(stale, None)
            for key, (_source, payload, _mode) in inventory.items():
                if not any(key == prefix or key.startswith(prefix + "/") for prefix in EXAMPLE_SUBTREES):
                    continue
                destination = target / Path(*PurePosixPath(key).parts)
                existing = _stable_regular_bytes(destination) if os.path.lexists(destination) else None
                existing_digest = hashlib.sha256(existing).hexdigest() if existing is not None else None
                if existing_digest == hashlib.sha256(payload).hexdigest() or existing_digest == old_hashes.get(key) or (existing is None and key not in old_hashes):
                    example_hashes[key] = hashlib.sha256(payload).hexdigest()
            examples_path = target / INSTALLED_EXAMPLES_RELATIVE
            assert_safe_destination(target, examples_path)
            examples_original = _stable_regular_bytes(examples_path) if os.path.lexists(examples_path) else None
            if os.path.lexists(examples_path) and examples_original is None:
                raise TailorError("installed example provenance is not a stable bounded regular file")
            examples_payload = (
                json.dumps({"schema_version": 1, "files": example_hashes}, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
            ).encode("utf-8")
            if examples_original != examples_payload:
                decision("metadata", examples_path, examples_payload, 0o644, examples_original)

        state_document: dict[str, object]
        if config_conflict:
            state_document = {
                "installed_version": state["installed_version"],
                "schema_version": INSTALL_STATE_SCHEMA_VERSION,
                "template_sha256": old_hashes,
                "pending_sidecar_sha256": conflict_payload_hashes,
            }
        else:
            state_document = {
                "installed_version": version,
                "schema_version": INSTALL_STATE_SCHEMA_VERSION,
                "template_sha256": _inventory_hashes(inventory),
            }
        state_payload = (json.dumps(state_document, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")
        if state_payload != state_original:
            decision(
                "state", state_path, state_payload,
                stat.S_IMODE(state_path.stat(follow_symlinks=False).st_mode),
                state_original,
            )
    except (OSError, TailorError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2, {}

    write_decisions = (
        [item for item in decisions if item["action"] in {"conflict", "state"}]
        if config_conflict else decisions
    )
    applied: list[dict[str, object]] = []

    def unchanged_since_decision(item: dict[str, object]) -> bool:
        path = item["path"]
        assert isinstance(path, Path)
        expected = item["expected_digest"]
        if expected is None:
            return not os.path.lexists(path)
        current = _stable_regular_bytes(path)
        return current is not None and hashlib.sha256(current).hexdigest() == expected

    def rollback() -> list[str]:
        failures: list[str] = []
        for item in reversed(applied):
            path = item["path"]
            payload = item["payload"]
            original = item["original"]
            action = item["action"]
            assert isinstance(path, Path) and isinstance(payload, bytes)
            try:
                original_mode = item["original_mode"]
                if action == "remove":
                    if os.path.lexists(path) or not isinstance(original, bytes) or not isinstance(original_mode, int):
                        raise TailorError(f"rollback removal target changed concurrently: {path}")
                    atomic_bytes(path, original, original_mode, _directory_identity(path.parent), None, True)
                else:
                    current = _stable_regular_bytes(path)
                    if current is None or current != payload:
                        raise TailorError(f"rollback target changed concurrently: {path}")
                    if original is None:
                        path.unlink()
                    else:
                        if not isinstance(original_mode, int):
                            raise TailorError(f"rollback mode unavailable: {path}")
                        atomic_bytes(
                            path, original, original_mode, _directory_identity(path.parent),
                            hashlib.sha256(payload).hexdigest(), False,
                        )
            except (OSError, TailorError) as exc:
                failures.append(f"{path}: {type(exc).__name__}: {exc}")
        return failures

    if not dry_run:
        try:
            for item in write_decisions:
                path = item["path"]
                payload = item["payload"]
                mode = item["mode"]
                assert isinstance(path, Path) and isinstance(payload, bytes) and isinstance(mode, int)
                assert_safe_destination(target, path)
                if not unchanged_since_decision(item):
                    raise TailorError(f"upgrade destination changed after comparison: {path.relative_to(target)}")
                expected_parent = item["parent_identity"]
                expected_digest = item["expected_digest"]
                if item["action"] == "remove":
                    if not isinstance(expected_digest, str):
                        raise TailorError(f"obsolete removal lacks expected digest: {path}")
                    _atomic_remove_expected(
                        path, expected_digest,
                        expected_parent if isinstance(expected_parent, tuple) else None,
                    )
                else:
                    atomic_bytes(
                        path, payload, mode,
                        expected_parent if isinstance(expected_parent, tuple) else None,
                        expected_digest if isinstance(expected_digest, str) else None,
                        expected_digest is None,
                    )
                applied.append(item)
        except (OSError, TailorError) as exc:
            rollback_failures = rollback()
            detail = f"; rollback failures: {rollback_failures}" if rollback_failures else ""
            print(f"error: upgrade write failed and was rolled back: {type(exc).__name__}: {exc}{detail}", file=sys.stderr)
            return 2, {}
    prefix = "[dry-run] " if dry_run else ""
    if config_conflict:
        print(f"{prefix}upgrade blocked: harness/config.json is customized or deleted; merge its .new sidecar and rerun", file=sys.stderr)
        return 1, counts
    print(f"{prefix}upgraded Prime Harness {state['installed_version']} -> {version}")
    print(f"  updated managed: {counts['updated']}")
    print(f"  new managed:     {counts['new']}")
    print(f"  unchanged:       {counts['unchanged']}")
    print(f"  upgrade conflicts: {counts['conflicts']} (.new sidecars; local files preserved)")
    print(f"  obsolete removed: {counts['obsolete_removed']}")
    print(f"  obsolete kept:    {counts['obsolete_kept']}")
    return 0, counts

def json_matches(path: Path, value: object) -> bool:
    text = _bounded_text(path)
    if text is None:
        return False
    try:
        return json.loads(text) == value
    except json.JSONDecodeError:
        return False


def _merge_gitignore(target: Path, *, dry_run: bool) -> None:
    gitignore = target / ".gitignore"
    assert_safe_destination(target, gitignore)
    if os.path.lexists(gitignore):
        existing = _bounded_text(gitignore)
        if existing is None:
            raise TailorError(".gitignore is not a stable bounded UTF-8 regular file")
    else:
        existing = ""
    missing_lines = [line for line in GITIGNORE_BLOCK if line not in existing.splitlines()]
    if any(not line.startswith("#") for line in missing_lines):
        if not dry_run:
            separator = "" if not existing or existing.endswith("\n") else "\n"
            atomic_text(gitignore, existing + separator + "\n".join(missing_lines) + "\n")
        prefix = "[dry-run] " if dry_run else ""
        print(f"{prefix}updated .gitignore (+{sum(1 for line in missing_lines if not line.startswith('#'))} entries)")


NEXT_STEPS = """
Next steps
----------
1. cd {target}
2. python harness/doctor.py            # preflight; fix any FAILs
3. Review and customize:
     harness/manifest.json             # your real gate commands
     harness/roster.yaml               # specialist roles for your domain
     .prime/agent/APPEND_SYSTEM.md     # operating policy
4. Start Prime Agent from the repo root (a NEW session is required for the
   Python-backed skills to install into the kernel).
5. In the session:  /harness-task my-first-task <objective>
   Bounded autonomous bursts:  harness/burst.sh feature "<prompt>"  (or burst.ps1)
6. Outside the kernel, generate telemetry, replay the eval baseline, and back up state:
   python -S harness/scorecard.py --output artifacts/harness/scorecard-latest.json
   python -S harness/replay.py --executor checks/evalset/executors/reference_adapter.py --snapshot checks/evalset/snapshots/baseline-v1.json --require-perfect
   python -S harness/backup.py create
7. Review the pinned-action `.github/workflows/prime-harness.yml`; its public
   holdout job is transport smoke only. Inject real holdouts from protected CI.

The five skills (harness_orchestrator, sci_verify, evidence_ledger,
external_critic, repo_map) appear in <available_skills> once the session starts.
""".rstrip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", help="path to the target repository root")
    parser.add_argument("--force", action="store_true", help="overwrite files that differ from the template")
    parser.add_argument("--check", action="store_true", help="run harness/doctor.py after installing")
    parser.add_argument("--tailor", action="store_true", help="generate a non-vacuous manifest draft from the target layout")
    parser.add_argument("--dry-run", action="store_true", help="report actions without writing")
    parser.add_argument("--upgrade", action="store_true", help="three-way safe upgrade using the versioned install state")
    args = parser.parse_args()

    target = Path(args.target).resolve()
    if not target.is_dir():
        sys.exit(f"error: target {target} is not a directory")
    if not (target / ".git").exists():
        print(f"warning: {target} is not a git repository root — the harness expects one "
              f"(worktrees, commit provenance, changed-file gates)")
    if not TEMPLATE.is_dir():
        sys.exit(f"error: template directory missing at {TEMPLATE}")
    if args.upgrade and (args.force or args.tailor):
        print("error: --upgrade cannot be combined with --force or --tailor", file=sys.stderr)
        return 2
    try:
        version = read_harness_version()
        inventory = _template_inventory(version)
    except TailorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.upgrade:
        code, _counts = _run_upgrade(target, version=version, inventory=inventory, dry_run=args.dry_run)
        if code != 0:
            return code
        if args.check and not args.dry_run:
            result = subprocess.run([sys.executable, str(target / "harness" / "doctor.py")], cwd=str(target))
            print(NEXT_STEPS.format(target=target))
            return result.returncode
        print(NEXT_STEPS.format(target=target))
        return 0
    state_path = target / INSTALL_STATE_RELATIVE
    try:
        assert_safe_destination(target, state_path)
        existing_install_state = load_install_state(state_path)
    except TailorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if existing_install_state is not None and existing_install_state["installed_version"] != version:
        print(
            f"error: installed Prime Harness {existing_install_state['installed_version']} differs from installer {version}; use --upgrade",
            file=sys.stderr,
        )
        return 2

    manifest_existed = (target / "harness/manifest.json").exists()
    tailored = None
    if args.tailor:
        try:
            tailored = tailor_manifest(target)
        except TailorError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    copied, skipped_same, skipped_diff, overwritten = [], [], [], []
    template_sources = [entry[0] for entry in inventory.values()]
    try:
        for key in inventory:
            assert_safe_destination(target, target / Path(*PurePosixPath(key).parts))
        for extra in (
            target / ".gitignore",
            target / "harness/manifest.tailored.json",
            target / "artifacts/harness/upstream-watch/baseline.json",
            target / INSTALLED_EXAMPLES_RELATIVE,
            state_path,
        ):
            assert_safe_destination(target, extra)
    except TailorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    for key, (_source, payload, mode) in sorted(inventory.items()):
        rel = Path(*PurePosixPath(key).parts)
        dest = target / rel
        try:
            assert_safe_destination(target, dest)
        except TailorError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        if dest.exists():
            installed_payload = _stable_regular_bytes(dest)
            if installed_payload is None:
                print(f"error: destination is not a stable bounded regular file: {key}", file=sys.stderr)
                return 2
            if installed_payload == payload:
                skipped_same.append(rel)
                continue
            if not args.force:
                skipped_diff.append(rel)
                continue
            if not args.dry_run:
                atomic_bytes(dest, payload, mode)
            overwritten.append(rel)
        else:
            if not args.dry_run:
                atomic_bytes(dest, payload, mode)
            copied.append(rel)

    prefix = "[dry-run] " if args.dry_run else ""

    # .gitignore merge (append-only, marker-guarded)
    try:
        _merge_gitignore(target, dry_run=args.dry_run)
    except TailorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if not args.dry_run:
        try:
            if existing_install_state is None or args.force:
                baseline_hashes = _inventory_hashes(inventory)
                if existing_install_state is None and not args.force:
                    for relative in skipped_diff:
                        baseline_hashes.pop(relative.as_posix(), None)
                atomic_json(state_path, {
                    "schema_version": INSTALL_STATE_SCHEMA_VERSION,
                    "installed_version": version,
                    "template_sha256": baseline_hashes,
                })
                if skipped_diff and not args.force:
                    print(f"install baseline excludes {len(skipped_diff)} preserved local files")
            _record_installed_example_hashes(target, template_sources)
        except TailorError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    print(f"{prefix}installed to {target}")
    print(f"  new files:        {len(copied)}")
    print(f"  unchanged:        {len(skipped_same)}")
    if overwritten:
        print(f"  overwritten:      {len(overwritten)} (--force)")
    if skipped_diff:
        print(f"  kept local edits: {len(skipped_diff)} (template differs; use --force to overwrite)")
        for rel in skipped_diff:
            print(f"    - {rel}")

    if tailored is not None:
        installed_manifest = target / "harness/manifest.json"
        if manifest_existed and not args.force and json_matches(installed_manifest, tailored):
            print(f"{prefix}tailored manifest: unchanged")
        else:
            destination = (
                installed_manifest
                if not manifest_existed or args.force
                else target / "harness/manifest.tailored.json"
            )
            try:
                assert_safe_destination(target, destination)
            except TailorError as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 2
            unchanged = json_matches(destination, tailored)
            preserve_sidecar = False
            if destination.name.endswith(".tailored.json") and os.path.lexists(destination) and not unchanged:
                installed_text = _bounded_text(installed_manifest)
                try:
                    installed_value = json.loads(installed_text) if installed_text is not None else None
                except json.JSONDecodeError:
                    installed_value = None
                preserve_sidecar = installed_value is None or not json_matches(destination, installed_value)
            if preserve_sidecar:
                print(f"{prefix}tailored manifest: sidecar differs from new draft; use --force to regenerate tailored output")
            else:
                if not args.dry_run and not unchanged:
                    atomic_json(destination, tailored)
                sidecar = target / "harness/manifest.tailored.json"
                if args.force and sidecar != destination and os.path.lexists(sidecar) and not args.dry_run:
                    atomic_json(sidecar, tailored)
                action = "unchanged " if unchanged else ""
                print(f"{prefix}tailored manifest: {action}{destination.relative_to(target)}"
                      + (" (review sidecar; existing manifest preserved)" if destination.name.endswith(".tailored.json") else ""))

    if not args.dry_run:
        upstream_watch = target / "harness" / "upstream_check.py"
        if upstream_watch.is_file():
            try:
                baseline = subprocess.run(
                    [sys.executable, "-S", str(upstream_watch), "--repo", str(target),
                     "--record-baseline", "--json"],
                    cwd=str(target), capture_output=True, text=True, timeout=120,
                )
            except (subprocess.TimeoutExpired, OSError) as exc:
                print(f"warning: could not record upstream baseline: {type(exc).__name__}: {exc}")
            else:
                if baseline.returncode == 0:
                    try:
                        action = json.loads(baseline.stdout).get("action", "recorded")
                    except json.JSONDecodeError:
                        action = "recorded"
                    print(f"upstream baseline: {action}")
                else:
                    print(f"warning: could not record upstream baseline: {baseline.stderr.strip()[:300]}")

    if args.check and not args.dry_run:
        print("\nrunning doctor...\n")
        result = subprocess.run([sys.executable, str(target / "harness" / "doctor.py")], cwd=str(target))
        print(NEXT_STEPS.format(target=target))
        return result.returncode
    print(NEXT_STEPS.format(target=target))
    return 0


if __name__ == "__main__":
    sys.exit(main())
