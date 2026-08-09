#!/usr/bin/env python3
"""Composite scientific verification gate for Prime Agent autonomous mode.

Stdlib-only on purpose: this script runs under the *project* Python (spawned
by Prime Agent's autonomous gate with `shell: true`), not the kernel venv.

Contract with the autonomous gate (verified against Prime Agent v0.7.0):
- gate stdout/stderr are truncated at 6000 chars per stream before being
  shown to the agent, so this script keeps stdout compact (~4 KB budget),
  writes full logs to artifacts/harness/gate-logs/<ts>/, and always ends with
  one machine-readable line:  GATE_RESULT {...json...}
- exit 0 = all applicable checks passed; exit 1 = anything failed.

Usage:
  python harness/verify.py [--profile NAME] [--manifest PATH] [--base REF]
                           [--json] [--list] [--allow-vacuous]
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import typing  # noqa: F401 - NoReturn hint in gate_error
from datetime import datetime, timezone
from pathlib import Path

from manifest_policy import (
    ManifestPolicyError,
    coverage_fields,
    load_manifest_object,
    marker_status,
    validate_profiles,
)

STDOUT_BUDGET = 4000          # keep well under the 6000-char autonomous gate cap
FAIL_EXCERPT_CHARS = 700
DEFAULT_CHECK_TIMEOUT = 600


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def repo_root() -> Path:
    cur = Path.cwd().resolve()
    for candidate in (cur, *cur.parents):
        if (candidate / ".git").exists():
            return candidate
    return cur


def gate_error(reason: str, **extra: object) -> "typing.NoReturn":  # noqa: F821 - hint only
    """Emit the machine-readable verdict on STDOUT (the documented contract)
    and exit 1 — never via sys.exit(str), which writes to stderr."""
    print(f"GATE_RESULT {json.dumps({'status': 'error', 'reason': reason, **extra})}")
    sys.exit(1)


def load_manifest(path: Path) -> dict:
    try:
        data = load_manifest_object(path)
        validate_profiles(data.get("profiles"))
    except ManifestPolicyError as exc:
        gate_error(str(exc))
    return data


def load_artifacts_dir(root: Path) -> Path:
    """Honor harness/config.json artifacts_dir (tolerant fallback), matching
    the skills' load_config semantics."""
    default = os.path.join("artifacts", "harness")
    try:
        config = json.loads((root / "harness" / "config.json").read_text(encoding="utf-8-sig"))
        rel = config.get("artifacts_dir", default) if isinstance(config, dict) else default
    except (OSError, json.JSONDecodeError):
        rel = default
    return root / rel


def changed_files(root: Path, base: str | None) -> tuple[list[str], str | None]:
    """Uncommitted changes (staged, unstaged, untracked) plus base..HEAD when a
    base ref resolves. Returns (paths, resolved_base); paths are repo-relative
    with forward slashes. An explicitly passed base that does not resolve is a
    hard gate error (fail closed — a silently skipped base could green-light a
    bad change)."""
    files: set[str] = set()

    def _git(args: list[str]) -> str:
        # core.quotePath=false → raw UTF-8 paths; explicit encoding avoids the
        # Windows cp1252 default mangling or crashing on non-ASCII paths
        proc = subprocess.run(["git", "-c", "core.quotePath=false", *args], cwd=str(root),
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=60)
        return (proc.stdout or "") if proc.returncode == 0 else ""

    def _resolves(ref: str) -> bool:
        proc = subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref],
                              cwd=str(root), capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        return proc.returncode == 0

    # -uall: list untracked files individually (default collapses to "dir/",
    # which would defeat when_changed globs for brand-new subtrees). NUL
    # records are unquoted and unambiguous for spaces, newlines, and " -> ".
    status_records = _git(["status", "--porcelain", "-z", "-uall"]).split("\0")
    index = 0
    while index < len(status_records):
        record = status_records[index]
        if not record:
            index += 1
            continue
        if len(record) < 4 or record[2] != " ":
            gate_error("malformed NUL-delimited git status record")
        status_code = record[:2]
        path = record[3:]
        if not path:
            gate_error("empty path in NUL-delimited git status record")
        files.add(path)
        if "R" in status_code or "C" in status_code:
            index += 1
            if index >= len(status_records) or not status_records[index]:
                gate_error("rename/copy record missing source path in git status")
            files.add(status_records[index])
        index += 1

    resolved_base: str | None = None
    if base:
        if not _resolves(base):
            gate_error(f"--base ref {base!r} did not resolve", base=base)
        resolved_base = base
    else:
        for candidate in ("origin/main", "origin/master", "main", "master"):
            if _resolves(candidate):
                resolved_base = candidate
                break
    if resolved_base:
        for path in _git(["diff", "--name-only", "-z", f"{resolved_base}...HEAD"]).split("\0"):
            if path:
                files.add(path)
    return sorted(files), resolved_base


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """fnmatch with '**' support ('**/' matches zero or more directories)."""
    pattern = pattern.replace("\\", "/")
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append(r"(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(r".*")
            i += 2
        elif pattern[i] == "*":
            out.append(r"[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append(r"[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def matches_any(files: list[str], patterns: list[str]) -> bool:
    regexes = [glob_to_regex(p) for p in patterns]
    for path in files:
        normalized = path.replace("\\", "/")
        if any(r.match(normalized) for r in regexes):
            return True
    return False


def kill_tree(proc: subprocess.Popen) -> None:
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, timeout=30)
        else:
            import signal

            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (OSError, subprocess.TimeoutExpired, ProcessLookupError):
        pass
    finally:
        try:
            proc.kill()
        except OSError:
            pass


def run_check(command: str, cwd: Path, timeout: int, log_path: Path) -> tuple[str, int | None, float, str]:
    """Run one check; returns (status, returncode, seconds, excerpt)."""
    start = time.monotonic()
    popen_kwargs: dict = {
        "shell": True,
        "cwd": str(cwd),
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
    }
    if os.name != "nt":
        popen_kwargs["start_new_session"] = True
    proc = subprocess.Popen(command, **popen_kwargs)
    try:
        output, _ = proc.communicate(timeout=timeout)
        status = "pass" if proc.returncode == 0 else "fail"
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        try:
            output, _ = proc.communicate(timeout=15)
        except (subprocess.TimeoutExpired, ValueError):
            output = ""
        output = (output or "") + f"\n[gate] TIMEOUT after {timeout}s — process tree killed"
        status = "timeout"
    seconds = time.monotonic() - start
    output = output or ""
    log_path.write_text(f"$ {command}\n(exit={proc.returncode}, {seconds:.1f}s)\n\n{output}", encoding="utf-8")
    excerpt = output.strip()[-FAIL_EXCERPT_CHARS:]
    return status, proc.returncode, seconds, excerpt


def atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name, suffix=".tmp", dir=str(path.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    for attempt in range(6):  # Windows: replace fails while a reader holds the file
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.05 * (attempt + 1))


def main() -> int:
    # UTF-8 stdout/stderr regardless of the Windows cp1252 console default:
    # gate excerpts routinely contain math symbols, and a UnicodeEncodeError
    # here would kill the gate before GATE_RESULT is emitted.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", default="default")
    parser.add_argument("--manifest", default=os.path.join("harness", "manifest.json"))
    parser.add_argument("--base", default=None, help="base ref for changed-file detection")
    parser.add_argument("--json", action="store_true", help="suppress per-check lines; GATE_RESULT only")
    parser.add_argument("--list", action="store_true", help="list profiles and checks, then exit 0")
    parser.add_argument(
        "--allow-vacuous", action="store_true",
        help="bootstrap escape: allow fewer applicable checks than the profile minimum",
    )
    args = parser.parse_args()

    root = repo_root()
    manifest = load_manifest(root / args.manifest)
    profiles = manifest["profiles"]

    if args.list:
        for name, profile in profiles.items():
            minimum = validate_profiles({name: profile})[name]
            print(f"profile {name} (min_applicable_checks={minimum}):")
            for check in profile.get("required", []):
                print(f"  required    {check.get('name')}: {check.get('command')}")
            for check in profile.get("conditional", []):
                print(f"  conditional {check.get('name')} (when {check.get('when_changed')}): {check.get('command')}")
        return 0

    if args.profile not in profiles:
        print(f"GATE_RESULT {json.dumps({'status': 'error', 'reason': f'unknown profile {args.profile}', 'known': sorted(profiles)})}")
        return 1

    profile = profiles[args.profile]
    minimum = validate_profiles({args.profile: profile})[args.profile]
    changed, diff_base = changed_files(root, args.base)
    artifacts_dir = load_artifacts_dir(root)
    log_dir = artifacts_dir / "gate-logs" / f"{utc_stamp()}-{args.profile}"
    log_dir.mkdir(parents=True, exist_ok=True)

    checks: list[tuple[dict, str]] = [(c, "required") for c in profile.get("required", [])]
    for check in profile.get("conditional", []):
        patterns = check.get("when_changed", [])
        kind = "conditional" if matches_any(changed, patterns) else "inapplicable"
        checks.append((check, kind))

    results = []
    emitted = 0

    def emit(line: str) -> None:
        nonlocal emitted
        if args.json:
            return
        if emitted + len(line) + 1 > STDOUT_BUDGET:
            return
        print(line)
        emitted += len(line) + 1

    for check, kind in checks:
        name = check.get("name") or check.get("command", "?")[:40]
        command = check.get("command")
        if kind == "inapplicable":
            results.append({"name": name, "status": "skipped", "reason": "no matching changed files"})
            emit(f"SKIP {name} (no matching changes)")
            continue
        if not command:
            results.append({"name": name, "status": "error", "reason": "no command"})
            emit(f"FAIL {name} (manifest entry has no command)")
            continue
        skip_marker = check.get("skip_if_missing")
        if skip_marker:
            try:
                present, reason = marker_status(root, skip_marker)
            except ManifestPolicyError as exc:
                results.append({"name": name, "status": "error", "reason": str(exc)})
                emit(f"FAIL {name} ({exc})")
                continue
            if not present:
                results.append({"name": name, "status": "skipped", "reason": reason})
                emit(f"SKIP {name} ({reason})")
                continue
        timeout = int(check.get("timeout_seconds", DEFAULT_CHECK_TIMEOUT))
        # A leading bare `python` inherits the interpreter that runs this gate
        # (python3-only systems, Windows Store-stub PATHs); the manifest stays
        # portable and the doctor's interpreter checks stay meaningful.
        if command.startswith("python "):
            command = f'"{sys.executable}" ' + command[len("python "):]
        safe = re.sub(r"[^A-Za-z0-9_-]+", "-", name)[:60]
        status, code, seconds, excerpt = run_check(command, root, timeout, log_dir / f"{safe}.log")
        results.append({"name": name, "status": status, "returncode": code,
                        "seconds": round(seconds, 1), "kind": kind})
        if status == "pass":
            emit(f"PASS {name} ({seconds:.1f}s)")
        else:
            emit(f"FAIL {name} ({status}, exit={code}, {seconds:.1f}s)")
            for line in excerpt.splitlines()[-8:]:
                emit(f"  | {line}")

    failed = [r["name"] for r in results if r["status"] in ("fail", "timeout", "error")]
    passed = [r["name"] for r in results if r["status"] == "pass"]
    skipped = [r["name"] for r in results if r["status"] == "skipped"]
    try:
        coverage = coverage_fields(results, minimum, allow_vacuous=args.allow_vacuous)
    except ManifestPolicyError as exc:
        gate_error(str(exc), profile=args.profile)
    status = "fail" if failed else (
        "pass" if coverage["coverage_satisfied"] else "vacuous"
    )
    verdict = {
        "status": status,
        "profile": args.profile,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "changed_files": len(changed),
        "diff_base": diff_base,
        "log_dir": str(log_dir),
        "results": results,
        **coverage,
    }
    atomic_write_json(artifacts_dir / "gate-last.json", verdict)
    atomic_write_json(log_dir / "gate-result.json", verdict)
    compact = {
        key: verdict[key]
        for key in (
            "status", "profile", "passed", "failed", "skipped", "log_dir",
            "applicable_checks", "min_applicable_checks", "vacuous", "vacuous_allowed",
        )
    }
    print("GATE_RESULT " + json.dumps(compact))
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
