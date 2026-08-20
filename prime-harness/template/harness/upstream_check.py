#!/usr/bin/env python3
"""Detect Prime Agent runtime drift and local Windows-patch retirement."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

SCHEMA_VERSION = 1
PR_825_URL = "https://api.github.com/repos/PrimeIntellect-ai/prime-agent/pulls/825"
MAX_PR_RESPONSE_BYTES = 65_536
SOURCE_FILES = (
    "packages/coding-agent/src/core/kernel/bootstrap.ts",
    "packages/coding-agent/src/core/kernel/fork-server.ts",
    "packages/coding-agent/src/core/kernel/index.ts",
)
PATCH_FILES = (
    "harness/patches/prime-agent/windows-kernel-venv-python.patch",
    "harness/patches/prime-agent/windows-kernel-windows-hide.patch",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, indent=2, sort_keys=True, ensure_ascii=False)
            handle.write("\n")
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def baseline_path(root: Path) -> Path:
    return root / "artifacts/harness/upstream-watch/baseline.json"


def retirement_marker_path(root: Path) -> Path:
    return root / "artifacts/harness/upstream-watch/pr-825-merged-seen.json"


def _retirement_seen(root: Path) -> bool:
    marker = _read_json(retirement_marker_path(root))
    return bool(marker and marker.get("pr_825_merged_seen") is True)


def _remember_retirement(root: Path, source: str) -> None:
    if _retirement_seen(root):
        return
    atomic_write_json(retirement_marker_path(root), {
        "schema_version": SCHEMA_VERSION,
        "pr_825_merged_seen": True,
        "first_seen_at": utc_now(),
        "source": source,
    })


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _prime_binary() -> Path | None:
    explicit = os.environ.get("PRIME_AGENT_BINARY")
    value = explicit or shutil.which("prime-agent") or shutil.which("pi")
    if not value:
        return None
    path = Path(value).expanduser().resolve()
    return path if path.is_file() else None


def _source_root_from_launcher(binary: Path | None) -> Path | None:
    explicit = os.environ.get("PRIME_AGENT_SOURCE_ROOT")
    if explicit:
        candidate = Path(explicit).expanduser().resolve()
        return candidate if all((candidate / item).is_file() for item in SOURCE_FILES) else None
    if binary is None:
        return None
    try:
        launcher = binary.read_text(encoding="utf-8", errors="replace")[:65_536]
    except OSError:
        return None
    candidates = re.findall(r"[\"']([^\"'\r\n]*?cli\.js)[\"']", launcher)
    for raw in candidates:
        cli = Path(raw).expanduser()
        if not cli.is_absolute():
            cli = binary.parent / cli
        for parent in (cli.parent, *cli.parents):
            if all((parent / item).is_file() for item in SOURCE_FILES):
                return parent.resolve()
    return None


def _version(binary: Path | None) -> str | None:
    if binary is None:
        return None
    try:
        process = subprocess.run(
            [str(binary), "--version"], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if process.returncode != 0:
        return None
    output = "\n".join((process.stdout or "", process.stderr or ""))
    match = re.search(r"(?<!\d)(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)", output)
    return match.group(1) if match else None


def _patch_state(source_root: Path | None) -> tuple[dict[str, bool], dict[str, str | None]]:
    hashes: dict[str, str | None] = {item: None for item in SOURCE_FILES}
    if source_root is None:
        return {"venv_python_path": False, "windows_hide": False}, hashes
    texts: dict[str, str] = {}
    for relative in SOURCE_FILES:
        path = source_root / relative
        try:
            texts[relative] = path.read_text(encoding="utf-8")
            hashes[relative] = sha256_file(path)
        except (OSError, UnicodeError):
            texts[relative] = ""
    bootstrap = texts[SOURCE_FILES[0]]
    venv_signature = (
        "function venvPythonPath" in bootstrap
        and bootstrap.count("venvPythonPath(") >= 3
        and (
            '"Scripts", "python.exe"' in bootstrap
            or "'Scripts', 'python.exe'" in bootstrap
        )
    )
    windows_hide = all("windowsHide: true" in texts[item] for item in SOURCE_FILES)
    return {"venv_python_path": venv_signature, "windows_hide": windows_hide}, hashes


def capture_current(
    root: Path, *, prime_binary: Path | None = None,
    source_root: Path | None = None, version_override: str | None = None,
) -> dict[str, Any]:
    root = root.resolve()
    binary = prime_binary.resolve() if prime_binary is not None else _prime_binary()
    source = source_root.resolve() if source_root is not None else _source_root_from_launcher(binary)
    patch_state, source_hashes = _patch_state(source)
    patch_hashes = {
        item: sha256_file(root / item) if (root / item).is_file() else None
        for item in PATCH_FILES
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "captured_at": utc_now(),
        "prime_agent": {
            "binary_path": str(binary) if binary else None,
            "binary_sha256": sha256_file(binary) if binary and binary.is_file() else None,
            "version": version_override if version_override is not None else _version(binary),
            "source_root": str(source) if source else None,
        },
        "patch_state": patch_state,
        "source_file_sha256": source_hashes,
        "archived_patch_sha256": patch_hashes,
    }


def compare_snapshots(
    baseline: dict[str, Any], current: dict[str, Any], *, pr_825_merged: bool,
) -> dict[str, Any]:
    reasons: list[str] = []
    if baseline.get("schema_version") != SCHEMA_VERSION:
        reasons.append("baseline schema is unsupported")
    base_prime = baseline.get("prime_agent") if isinstance(baseline.get("prime_agent"), dict) else {}
    now_prime = current.get("prime_agent") if isinstance(current.get("prime_agent"), dict) else {}
    if not base_prime.get("version") or not base_prime.get("binary_sha256"):
        reasons.append("install-time Prime Agent version/binary hash is unavailable")
    if base_prime.get("version") != now_prime.get("version"):
        reasons.append(
            f"Prime Agent version drift: {base_prime.get('version')!r} -> {now_prime.get('version')!r}"
        )
    if base_prime.get("binary_sha256") != now_prime.get("binary_sha256"):
        reasons.append("Prime Agent binary hash drift")
    if baseline.get("source_file_sha256") != current.get("source_file_sha256"):
        reasons.append("Prime Agent selfcheck-critical source hashes changed")
    if baseline.get("archived_patch_sha256") != current.get("archived_patch_sha256"):
        reasons.append("archived re-application patch hashes changed")
    base_patch_state = baseline.get("patch_state") if isinstance(baseline.get("patch_state"), dict) else {}
    patch_state = current.get("patch_state") if isinstance(current.get("patch_state"), dict) else {}
    source_is_available = bool(now_prime.get("source_root"))
    if source_is_available and base_patch_state.get("venv_python_path") is True and patch_state.get("venv_python_path") is not True:
        reasons.append("Windows venvPythonPath patch signature regressed from the install-time baseline")
    if source_is_available and base_patch_state.get("windows_hide") is True and patch_state.get("windows_hide") is not True:
        reasons.append("Windows windowsHide patch signatures regressed from the install-time baseline")
    if pr_825_merged:
        return {
            "status": "retirement_required",
            "reasons": ["upstream PR #825 is merged; retire both local Windows patches and refresh the baseline"],
        }
    unavailable = not now_prime.get("version") or not now_prime.get("binary_sha256")
    return {
        "status": "unavailable" if unavailable else ("drift" if reasons else "stable"),
        "reasons": reasons,
    }


def _snapshot_identity_available(snapshot: dict[str, Any]) -> bool:
    prime = snapshot.get("prime_agent")
    if not isinstance(prime, dict):
        return False
    version = prime.get("version")
    digest = prime.get("binary_sha256")
    return (
        isinstance(version, str) and bool(version.strip())
        and isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest) is not None
    )


def record_baseline(path: Path, snapshot: dict[str, Any], *, force: bool) -> str:
    if not _snapshot_identity_available(snapshot):
        return "deferred-unavailable"
    if path.exists() and not force:
        existing = _read_json(path)
        if existing is None or _snapshot_identity_available(existing):
            return "unchanged"
        atomic_write_json(path, snapshot)
        return "replaced-incomplete"
    action = "replaced" if path.exists() else "created"
    atomic_write_json(path, snapshot)
    return action


def parse_pr_825_payload(raw: bytes) -> bool:
    if len(raw) > MAX_PR_RESPONSE_BYTES:
        raise ValueError("PR #825 response exceeds size limit")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("PR #825 response is not UTF-8 JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("PR #825 response must be an object")
    state = payload.get("state")
    merged_at = payload.get("merged_at")
    if state not in {"open", "closed"} or (merged_at is not None and not isinstance(merged_at, str)):
        raise ValueError("PR #825 response has an invalid contract")
    return bool(merged_at)


def query_pr_825(opener: Callable[..., Any] = urllib.request.urlopen) -> bool:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "prime-harness-upstream-watch/1",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        if len(token) > 4096 or "\r" in token or "\n" in token:
            raise RuntimeError("GITHUB_TOKEN is malformed or exceeds 4096 characters")
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(PR_825_URL, headers=headers)
    try:
        with opener(request, timeout=20) as response:
            raw = response.read(MAX_PR_RESPONSE_BYTES + 1)
    except (OSError, urllib.error.URLError) as exc:
        raise RuntimeError(f"could not query upstream PR #825: {exc}") from exc
    return parse_pr_825_payload(raw)


def _local_pr_825_merge(source_root: Path | None) -> bool:
    if source_root is None or not (source_root / ".git").exists():
        return False
    try:
        process = subprocess.run(
            ["git", "log", "--format=%s"], cwd=str(source_root),
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    if process.returncode != 0:
        return False
    return any(
        re.search(r"(?:Merge pull request #825\b|\(#825\)\s*$)", subject)
        for subject in process.stdout.splitlines()
    )


def probe(root: Path, *, check_pr: bool = False) -> dict[str, Any]:
    root = root.resolve()
    baseline = _read_json(baseline_path(root))
    current = capture_current(root)
    warnings: list[str] = []
    network_merged = False
    pr_query_ok: bool | None = None
    if check_pr:
        try:
            network_merged = query_pr_825()
            pr_query_ok = True
        except (RuntimeError, ValueError) as exc:
            pr_query_ok = False
            warnings.append(str(exc))
    source_value = current.get("prime_agent", {}).get("source_root")
    source_root = Path(source_value) if isinstance(source_value, str) else None
    local_merged = _local_pr_825_merge(source_root)
    newly_merged = network_merged or local_merged
    if newly_merged:
        _remember_retirement(root, "network" if network_merged else "checked-out HEAD history")
    merged = newly_merged or _retirement_seen(root)
    comparison = (
        {"status": "uninitialized", "reasons": ["install-time upstream baseline is missing"]}
        if baseline is None
        else compare_snapshots(baseline, current, pr_825_merged=merged)
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "checked_at": utc_now(),
        "baseline_path": str(baseline_path(root)),
        "baseline_present": baseline is not None,
        "comparison": comparison,
        "pr_825_merged": merged,
        "pr_query_requested": check_pr,
        "pr_query_ok": pr_query_ok,
        "current": current,
        "warnings": warnings,
    }


def _kernel_python() -> Path | None:
    explicit = os.environ.get("PRIME_AGENT_KERNEL_PYTHON")
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    venv = os.environ.get("PRIME_AGENT_KERNEL_VENV")
    base = Path(venv).expanduser() if venv else Path.home() / ".prime/agent/kernel-venv"
    candidates.append(base / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
    return next((item.resolve() for item in candidates if item.is_file()), None)


def kernel_critical_probe() -> dict[str, Any]:
    python = _kernel_python()
    if python is None:
        return {"status": "fail", "reason": "managed kernel Python is unavailable"}
    try:
        process = subprocess.run(
            [str(python), "-c", "import ipykernel, pytest, sympy, yaml; print('kernel-critical-ok')"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"status": "fail", "reason": f"kernel probe launch failed: {exc}"}
    return {
        "status": "pass" if process.returncode == 0 and "kernel-critical-ok" in process.stdout else "fail",
        "returncode": process.returncode,
        "stderr_tail": process.stderr[-1000:],
        "python": str(python),
    }


def _run_doctor(root: Path) -> dict[str, Any]:
    doctor = root / "harness/doctor.py"
    try:
        process = subprocess.run(
            [sys.executable, "-S", str(doctor), "--json"], cwd=str(root),
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"status": "fail", "reason": f"doctor launch failed: {exc}"}
    try:
        report = json.loads(process.stdout)
    except json.JSONDecodeError:
        report = None
    return {
        "status": "pass" if process.returncode == 0 else "fail",
        "returncode": process.returncode,
        "report": report,
        "stderr_tail": process.stderr[-1000:],
    }


def _record_evidence(root: Path, artifact: Path, passed: bool, *, degraded: bool = False) -> dict[str, Any]:
    python = _kernel_python()
    if python is None:
        return {"status": "fail", "reason": "kernel Python unavailable for evidence ledger"}
    script = (
        "import sys; import evidence_ledger; "
        "status='verified' if sys.argv[2]=='pass' else 'refuted'; "
        "degraded=sys.argv[3]=='degraded'; "
        "claim=('Prime Agent local upstream compatibility baseline remains satisfied; PR #825 network query was unavailable' "
        "if degraded else 'Prime Agent upstream compatibility baseline remains satisfied'); "
        "notes=('requested PR #825 network query failed; local history and compatibility checks passed' if degraded else None); "
        "print(evidence_ledger.record("
        "claim,status=status, verifier='harness/upstream_check.py',"
        "artifacts=[sys.argv[1]], confidence=(0.7 if degraded else 1.0),notes=notes,"
        "source='scheduled/install-time upstream drift watch'))"
    )
    try:
        process = subprocess.run(
            [
                str(python), "-c", script, str(artifact),
                "pass" if passed else "fail", "degraded" if degraded else "complete",
            ],
            cwd=str(root), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"status": "fail", "reason": f"evidence ledger launch failed: {exc}"}
    evidence_id = process.stdout.strip().splitlines()[-1] if process.stdout.strip() else None
    return {
        "status": "pass" if process.returncode == 0 and evidence_id else "fail",
        "evidence_id": evidence_id,
        "stderr_tail": process.stderr[-1000:],
    }


def _artifact_path(root: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    return root / "artifacts/harness/upstream-watch" / f"check-{stamp}.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--record-baseline", action="store_true")
    parser.add_argument("--force-baseline", action="store_true")
    parser.add_argument("--check-pr", action="store_true")
    parser.add_argument("--check-pr-only", action="store_true")
    parser.add_argument("--no-ledger", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    root = args.repo.resolve()

    if args.check_pr_only:
        try:
            merged = query_pr_825()
            if merged:
                _remember_retirement(root, "network")
            result = {"status": "retirement_required" if merged else "open", "pr_825_merged": merged}
        except (RuntimeError, ValueError) as exc:
            result = {"status": "error", "reason": str(exc)}
        print(json.dumps(result, sort_keys=True))
        return 3 if result["status"] == "retirement_required" else (0 if result["status"] == "open" else 2)

    if args.record_baseline:
        snapshot = capture_current(root)
        action = record_baseline(baseline_path(root), snapshot, force=args.force_baseline)
        result = {"status": "recorded", "action": action, "baseline": snapshot}
        print(json.dumps(result, indent=2 if args.json else None, sort_keys=True))
        return 0

    result = probe(root, check_pr=args.check_pr)
    result["doctor"] = _run_doctor(root)
    result["kernel_critical"] = kernel_critical_probe()
    passed = (
        result["comparison"]["status"] == "stable"
        and result["doctor"]["status"] == "pass"
        and result["kernel_critical"]["status"] == "pass"
    )
    degraded = bool(args.check_pr and result.get("pr_query_ok") is False)
    result["status"] = "pass-degraded" if passed and degraded else ("pass" if passed else "fail")
    artifact = _artifact_path(root)
    atomic_write_json(artifact, result)
    if not args.no_ledger:
        result["ledger"] = _record_evidence(root, artifact, passed, degraded=degraded)
        if result["ledger"]["status"] != "pass":
            result["status"] = "fail"
    result["artifact"] = str(artifact)
    print(json.dumps(result, indent=2 if args.json else None, sort_keys=True))
    return 0 if result["status"] in {"pass", "pass-degraded"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
