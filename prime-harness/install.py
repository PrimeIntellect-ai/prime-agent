#!/usr/bin/env python3
"""Install the Prime Harness into a target repository.

Copies template/ into the target, merges .gitignore entries, and never
overwrites modified files unless --force. Idempotent: re-running against an
installed target reports "unchanged" and touches nothing.

Usage:
  python install.py <target-repo> [--force] [--check] [--tailor] [--dry-run]
"""

from __future__ import annotations

import argparse
import filecmp
import json
import os
import re
import shutil
import stat
import tempfile
import subprocess
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent / "template"

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


def _template_only_subtree(target: Path, relative: str) -> bool:
    source = TEMPLATE / relative
    destination = target / relative
    if not source.is_dir() or not destination.is_dir():
        return False
    source_files = _bounded_inventory(source)
    destination_files = _bounded_inventory(destination)
    if source_files is None or destination_files is None or set(source_files) != set(destination_files):
        return False
    return all(
        filecmp.cmp(str(source_files[name]), str(destination_files[name]), shallow=False)
        for name in source_files
    )


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


def _credible_node_test_script(script: str) -> bool:
    """Accept only a test runner appearing as a command, never as an argument."""
    prefix = r"(?:(?:cross-env(?:-shell)?\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*)"
    runner = re.compile(
        r"^" + prefix
        + r"(?:(?:npx|pnpm exec|yarn dlx)\s+)?"
        + r"(?:node\s+--test\b|jest\b|vitest\b|mocha\b|ava\b|tap\b|tape\b|"
        + r"cypress(?:\s+run)?\b|playwright\s+test\b|"
        + r"(?:npm|pnpm|yarn)\s+run\s+test(?::[a-z0-9_.-]+)?\b)"
    )
    for segment in re.split(r"&&|\|\||;", script.casefold()):
        if runner.match(" ".join(segment.strip().split())):
            return True
    return False


def tailor_manifest(target: Path) -> dict[str, object]:
    """Build a deterministic gate draft from bounded top-level project markers."""
    target = target.resolve()
    checks: list[dict[str, object]] = []
    detected: list[str] = []

    python_roots: list[str] = []
    for source_dir in ("src", "sim", "simulation", "simulations"):
        candidate = target / source_dir
        if candidate.is_dir() and not _is_linklike(candidate) and _contains_python_source(candidate):
            python_roots.append(source_dir)
    # Source-layout-free packages are detected only one level deep; never walk
    # an untrusted or very large repository during installation.
    top_level = _bounded_entries(target, 512)
    if top_level is None:
        raise TailorError("target root exceeds the 512-entry tailoring scan limit or is unreadable")
    excluded = {".git", ".prime", ".github", "artifacts", "checks", "harness", "tests", "test", "node_modules"}
    for path in top_level:
        if path.name in excluded or path.name.startswith(".") or not path.is_dir() or _is_linklike(path):
            continue
        package_init = path / "__init__.py"
        if (
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", path.name)
            and package_init.is_file()
            and not _is_linklike(package_init)
        ):
            _contains_python_source(path)  # validates every descendant before recursive compileall
            python_roots.append(path.name)
    python_roots = sorted(set(python_roots))
    if python_roots:
        joined = " ".join(python_roots)
        checks.append(_check("compile", f"python -m compileall -q {joined}", python_roots[0], 120))
        detected.extend(f"python-package:{item}" for item in python_roots)

    test_dirs: list[str] = []
    for item in ("tests", "test", "checks/properties", "checks/invariants", "checks/reference_cases"):
        candidate = target / item
        if not candidate.is_dir() or _is_linklike(candidate):
            continue
        _validated_regular_tree_files(candidate, f"test directory {item}")
        if not _template_only_subtree(target, item):
            test_dirs.append(item)
    pyproject_text = _bounded_text(target / "pyproject.toml")
    if pyproject_text is not None:
        detected.append("pyproject.toml")
    if test_dirs:
        joined = " ".join(test_dirs)
        checks.append(_check("unit", f"python -m pytest -q {joined}", test_dirs[0], 900))
        detected.extend(f"python-tests:{item}" for item in test_dirs)
    elif pyproject_text is not None and "[tool.pytest" in pyproject_text:
        checks.append(_check("unit", "python -m pytest -q", "pyproject.toml", 900))
        detected.append("pyproject.toml:pytest")
    elif (target / "tox.ini").is_file() and not _is_linklike(target / "tox.ini"):
        checks.append(_check("tox", "python -m tox -q", "tox.ini", 900))
        detected.append("tox.ini")

    lake_marker = next(
        (
            item for item in ("lakefile.lean", "lakefile.toml")
            if (target / item).is_file() and not _is_linklike(target / item)
        ),
        None,
    )
    if lake_marker:
        checks.append(_check("lean-build", "lake build", lake_marker, 900))
        detected.append(lake_marker)

    package_json = target / "package.json"
    package_text = _bounded_text(package_json)
    if package_text is not None:
        try:
            package = json.loads(package_text)
        except json.JSONDecodeError:
            package = None
        script = package.get("scripts", {}).get("test") if isinstance(package, dict) and isinstance(package.get("scripts"), dict) else None
        if isinstance(script, str) and _credible_node_test_script(script):
            checks.append(_check("node-test", "npm test", "package.json", 900))
            detected.append("package.json:test")

    if not checks:
        raise TailorError(
            "no executable project checks detected (expected Python package/tests, tox.ini, "
            "lakefile, or a non-placeholder package.json test script)"
        )

    quick: list[dict[str, object]] = []
    for entry in checks:
        item = dict(entry)
        if item["name"] == "unit":
            item["command"] = str(item["command"]).replace("pytest -q", "pytest -q -x", 1)
            item["timeout_seconds"] = 300
        quick.append(item)
    default = [dict(entry) for entry in checks]
    changed = [dict(entry) for entry in checks]
    profiles: dict[str, object] = {
        "quick": {"min_applicable_checks": 1, "required": quick, "conditional": []},
        "default": {"min_applicable_checks": 1, "required": default, "conditional": []},
        "changed-files": {"min_applicable_checks": 1, "required": changed, "conditional": []},
    }
    holdout = target / "checks/hidden_holdout"
    if holdout.is_dir() and not _is_linklike(holdout) and not _template_only_subtree(target, "checks/hidden_holdout"):
        profiles["holdout"] = {
            "min_applicable_checks": 1,
            "required": [_check("hidden-holdout", "python -m pytest -q checks/hidden_holdout", "checks/hidden_holdout", 1800)],
            "conditional": [],
        }
        detected.append("checks/hidden_holdout")
    return {
        "_generated_by": "prime-harness install.py --tailor",
        "_detected": sorted(detected),
        "profiles": profiles,
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


def json_matches(path: Path, value: object) -> bool:
    text = _bounded_text(path)
    if text is None:
        return False
    try:
        return json.loads(text) == value
    except json.JSONDecodeError:
        return False


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
    args = parser.parse_args()

    target = Path(args.target).resolve()
    if not target.is_dir():
        sys.exit(f"error: target {target} is not a directory")
    if not (target / ".git").exists():
        print(f"warning: {target} is not a git repository root — the harness expects one "
              f"(worktrees, commit provenance, changed-file gates)")
    if not TEMPLATE.is_dir():
        sys.exit(f"error: template directory missing at {TEMPLATE}")

    manifest_existed = (target / "harness/manifest.json").exists()
    tailored = None
    if args.tailor:
        try:
            tailored = tailor_manifest(target)
        except TailorError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    copied, skipped_same, skipped_diff, overwritten = [], [], [], []
    template_sources = [
        source for source in sorted(TEMPLATE.rglob("*"))
        if not source.is_dir() and not is_ignored_template_artifact(source)
    ]
    try:
        for source in template_sources:
            assert_safe_destination(target, target / source.relative_to(TEMPLATE))
        for extra in (
            target / ".gitignore",
            target / "harness/manifest.tailored.json",
            target / "artifacts/harness/upstream-watch/baseline.json",
        ):
            assert_safe_destination(target, extra)
    except TailorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    for source in template_sources:
        rel = source.relative_to(TEMPLATE)
        dest = target / rel
        try:
            assert_safe_destination(target, dest)
        except TailorError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        if dest.exists():
            if filecmp.cmp(str(source), str(dest), shallow=False):
                skipped_same.append(rel)
                continue
            if not args.force:
                skipped_diff.append(rel)
                continue
            if not args.dry_run:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(source), str(dest))
            overwritten.append(rel)
        else:
            if not args.dry_run:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(source), str(dest))
            copied.append(rel)

    prefix = "[dry-run] " if args.dry_run else ""

    # .gitignore merge (append-only, marker-guarded)
    gitignore = target / ".gitignore"
    try:
        assert_safe_destination(target, gitignore)
    except TailorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    existing = gitignore.read_text(encoding="utf-8") if gitignore.is_file() else ""
    missing_lines = [line for line in GITIGNORE_BLOCK if line not in existing.splitlines()]
    if any(not line.startswith("#") for line in missing_lines):
        if not args.dry_run:
            with gitignore.open("a", encoding="utf-8", newline="\n") as handle:
                if existing and not existing.endswith("\n"):
                    handle.write("\n")
                handle.write("\n".join(missing_lines) + "\n")
        print(f"{prefix}updated .gitignore (+{sum(1 for l in missing_lines if not l.startswith('#'))} entries)")
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
            if not args.dry_run and not unchanged:
                atomic_json(destination, tailored)
            action = "unchanged " if unchanged else ""
            print(f"{prefix}tailored manifest: {action}{destination.relative_to(target)}"
                  + (" (review sidecar; existing manifest preserved)" if destination.name.endswith(".tailored.json") else ""))

    if not args.dry_run:
        upstream_watch = target / "harness" / "upstream_check.py"
        if upstream_watch.is_file():
            baseline = subprocess.run(
                [sys.executable, "-S", str(upstream_watch), "--repo", str(target),
                 "--record-baseline", "--json"],
                cwd=str(target), capture_output=True, text=True, timeout=120,
            )
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
